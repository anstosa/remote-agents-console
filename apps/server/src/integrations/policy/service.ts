import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const contractVersion = 4;
const idempotencyLifetimeMs = 24 * 60 * 60_000;
const defaultMaxRecords = 2_000;
const maximumLifecycleCommands = 64;
const maximumLifecycleRecordBytes = 2_048;
const maximumLifecycleBytes = 128 * 1_024;

type IdempotencyState = 'in_progress' | 'completed' | 'failed' | 'unknown_outcome';
type IdempotencyRecord = { id: string; principalKey: string; tool: string; requestId: string; argumentsDigest: string; state: IdempotencyState; createdAt: number; updatedAt: number; result?: unknown };
export type LifecycleOperation = 'restart' | 'resume_replacing' | 'compact_replacing';
export type LifecycleCommandState = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
export type LifecycleCommandRecord = { id: string; idempotencyRecordId: string; targetAgentId: string; operation: LifecycleOperation; expectedGeneration: number; state: LifecycleCommandState; createdAt: number; updatedAt: number; currentGeneration?: number; error?: { code: string; message: string } };
type StoredPolicy = { version: 4; idempotency: IdempotencyRecord[]; lifecycleCommands: LifecycleCommandRecord[] };

export type IdempotencyClaim =
  | { kind: 'claimed'; recordId: string }
  | { kind: 'replay'; recordId: string; state: Exclude<IdempotencyState, 'in_progress'>; result?: unknown }
  | { kind: 'in_progress'; recordId: string }
  | { kind: 'conflict' }
  | { kind: 'capacity' };
export type LifecycleCommandInput = { targetAgentId: string; operation: LifecycleOperation; expectedGeneration: number };
export type LifecycleCommandClaim = IdempotencyClaim & { command?: LifecycleCommandRecord };
export type LifecycleCommandMarker = { commandId: string; expectedGeneration: number; effectGeneration?: number };

// distinguish a refused stage from a possibly published replay-protection claim
export class IntegrationPolicyWriteError extends Error {
  // expose only publication certainty, never private filesystem details
  constructor(readonly publication: 'not_published' | 'published' | 'unknown') { super('integration policy publication failed'); }
}

// persist replay safety and bounded recoverable lifecycle commands
export class IntegrationPolicyService {
  private mutation = Promise.resolve();

  // retain one private policy store
  constructor(private readonly file = process.env.RAC_INTEGRATION_STATE_FILE ?? '.data/integration-state.json', private readonly maxRecords = defaultMaxRecords, private readonly now: () => number = Date.now) {}

  // claim one mutation request before its side effect
  async claim(principalKey: string, tool: string, requestId: string, argumentsDigest: string): Promise<IdempotencyClaim> {
    return await this.mutate(stored => claimRecord(stored, principalKey, tool, requestId, argumentsDigest, this.maxRecords, this.now()));
  }

  // atomically claim idempotency and create one pending lifecycle command
  async claimLifecycleCommand(principalKey: string, tool: string, requestId: string, argumentsDigest: string, input: LifecycleCommandInput): Promise<LifecycleCommandClaim> {
    return await this.mutate(stored => {
      const claim = claimRecord(stored, principalKey, tool, requestId, argumentsDigest, this.maxRecords, this.now());
      // return existing claim state without allocating another command
      if (claim.kind !== 'claimed') return { ...claim, command: lifecycleFor(stored, claim.kind === 'capacity' || claim.kind === 'conflict' ? undefined : claim.recordId) };
      // reject malformed or over-capacity command state atomically
      if (!validLifecycleInput(input) || stored.lifecycleCommands.length >= maximumLifecycleCommands) {
        stored.idempotency = stored.idempotency.filter(record => record.id !== claim.recordId);
        return { kind: 'capacity' } as const;
      }
      const now = this.now();
      const command: LifecycleCommandRecord = { id: randomBytes(18).toString('base64url'), idempotencyRecordId: claim.recordId, targetAgentId: input.targetAgentId, operation: input.operation, expectedGeneration: input.expectedGeneration, state: 'pending', createdAt: now, updatedAt: now };
      // enforce the exact bounded serialized command contract
      if (!fitsLifecycleRecord(command) || lifecycleBytes([...stored.lifecycleCommands, command]) > maximumLifecycleBytes) {
        stored.idempotency = stored.idempotency.filter(record => record.id !== claim.recordId);
        return { kind: 'capacity' } as const;
      }
      stored.lifecycleCommands.push(command);
      return { ...claim, command: { ...command } };
    });
  }

  // begin one generation-fenced lifecycle command exactly once
  async beginLifecycleCommand(commandId: string, currentGeneration: number): Promise<LifecycleCommandRecord | undefined> {
    return await this.mutate(stored => {
      const command = stored.lifecycleCommands.find(candidate => candidate.id === commandId);
      // require one pending command
      if (command === undefined || command.state === 'running') return undefined;
      // terminal snapshots are observable but never dispatchable
      if (command.state !== 'pending') return { ...command };
      command.currentGeneration = currentGeneration;
      command.updatedAt = this.now();
      // only marker-aware recovery can prove an effect; any changed generation is unrelated here
      if (currentGeneration !== command.expectedGeneration) {
        command.state = 'failed';
        command.error = { code: 'target_changed', message: 'The target generation changed before execution.' };
      } else command.state = 'running';
      // settle replay evidence with any terminal generation determination
      settleLifecycleIdempotency(stored, command);
      return { ...command };
    });
  }

  // settle one command with truthful effect uncertainty
  async finishLifecycleCommand(commandId: string, state: Extract<LifecycleCommandState, 'succeeded' | 'failed' | 'unknown'>, currentGeneration?: number, error?: { code: string; message: string }): Promise<boolean> {
    return await this.mutate(stored => {
      const command = stored.lifecycleCommands.find(candidate => candidate.id === commandId);
      // settle only a started or pending command
      if (command === undefined || !['pending', 'running'].includes(command.state)) return false;
      command.state = state;
      command.updatedAt = this.now();
      // retain observed generation evidence
      if (currentGeneration !== undefined) command.currentGeneration = currentGeneration;
      // retain only bounded error details
      if (error !== undefined) command.error = { code: error.code.slice(0, 120), message: error.message.slice(0, 400) };
      settleLifecycleIdempotency(stored, command);
      return true;
    });
  }

  // read one bounded lifecycle status
  async lifecycleCommand(principalKey: string, commandId: string): Promise<LifecycleCommandRecord | undefined> {
    return await this.mutate(stored => {
      const command = stored.lifecycleCommands.find(candidate => candidate.id === commandId);
      // hide both missing and cross-owner command identities
      if (command === undefined || !stored.idempotency.some(record => record.id === command.idempotencyRecordId && record.principalKey === principalKey)) return undefined;
      return { ...command };
    });
  }

  // return bounded pending commands for one startup recovery pass
  async pendingLifecycleCommands(): Promise<LifecycleCommandRecord[]> {
    return await this.mutate(stored => stored.lifecycleCommands.filter(command => command.state === 'pending').map(command => ({ ...command })));
  }

  // reconcile interrupted commands from observed process generations
  async reconcileLifecycleCommands(generation: (targetAgentId: string) => number | undefined | Promise<number | undefined>, marker?: (targetAgentId: string) => LifecycleCommandMarker | undefined | Promise<LifecycleCommandMarker | undefined>): Promise<void> {
    await this.mutate(async stored => {
      // reconcile every unfinished command against durable generation evidence
      for (const command of stored.lifecycleCommands) {
        // retain terminal commands
        if (!['pending', 'running'].includes(command.state)) continue;
        const current = await generation(command.targetAgentId);
        const observed = marker === undefined ? undefined : await marker(command.targetAgentId);
        command.updatedAt = this.now();
        // retain uncertainty when the target cannot be inspected
        if (current === undefined) command.state = 'unknown';
        // prove this exact replacing effect by its durable command marker
        else if (observed?.commandId === command.id && observed.expectedGeneration === command.expectedGeneration && observed.effectGeneration === command.expectedGeneration + 1 && current === observed.effectGeneration) {
          command.currentGeneration = current;
          command.state = 'succeeded';
        // retain an unstarted pending command only when no marker claimed its effect
        } else if (current === command.expectedGeneration && command.state === 'pending' && observed === undefined) command.state = 'pending';
        // report uncertainty after a running command crashes before generation evidence persists
        else if (current === command.expectedGeneration) command.state = 'unknown';
        // a next generation without this command's marker cannot prove which effect ran
        else if (marker !== undefined && command.state === 'running' && current === command.expectedGeneration + 1 && observed === undefined) command.state = 'unknown';
        // preserve legacy reconciliation when no marker source exists
        else if (marker === undefined && current === command.expectedGeneration + 1) {
          command.currentGeneration = current;
          command.state = 'succeeded';
        }
        else {
          command.currentGeneration = current;
          command.state = 'failed';
          command.error = { code: 'target_changed', message: 'The target generation changed independently.' };
        }
        // persist terminal command and replay outcome in the same state replacement
        settleLifecycleIdempotency(stored, command);
      }
    });
  }

  // finish one claimed mutation
  async finish(recordId: string, state: Exclude<IdempotencyState, 'in_progress'>, result?: unknown): Promise<boolean> {
    return await this.mutate(stored => {
      const record = stored.idempotency.find(candidate => candidate.id === recordId);
      // require the active claim
      if (record === undefined || record.state !== 'in_progress') return false;
      record.state = state;
      record.updatedAt = this.now();
      // persist replayable bounded results
      if (result !== undefined && Buffer.byteLength(JSON.stringify(result)) <= 64 * 1_024) record.result = result;
      return true;
    });
  }

  // turn abandoned claims into fail-closed outcomes after restart
  async recoverUnknownOutcomes(): Promise<void> {
    await this.mutate(stored => {
      const lifecycleClaims = new Set(stored.lifecycleCommands.map(command => command.idempotencyRecordId));
      // mark every interrupted side effect as unknown
      for (const record of stored.idempotency) {
        // retain already settled outcomes
        if (record.state !== 'in_progress') continue;
        // leave generation-backed commands for lifecycle reconciliation
        if (lifecycleClaims.has(record.id)) continue;
        record.state = 'unknown_outcome';
        record.updatedAt = this.now();
      }
    });
  }

  // serialize all state changes
  private async mutate<T>(change: (stored: StoredPolicy) => T | Promise<T>): Promise<T> {
    const task = this.mutation.then(async () => {
      const stored = await this.read();
      prune(stored, this.now());
      const value = await change(stored);
      prune(stored, this.now());
      await this.write(stored);
      return value;
    });
    this.mutation = task.then(() => undefined, () => undefined);
    return await task;
  }

  // read only validated policy state
  private async read(): Promise<StoredPolicy> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      // initialize only a genuinely missing store
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: contractVersion, idempotency: [], lifecycleCommands: [] };
      throw error;
    }
    const parsed = JSON.parse(serialized) as unknown;
    // migrate replay-safe legacy stores without retaining approvals
    if (validLegacyPolicy(parsed, this.maxRecords)) return { version: contractVersion, idempotency: parsed.idempotency, lifecycleCommands: [] };
    // fail closed rather than dropping replay protection
    if (!validStoredPolicy(parsed, this.maxRecords)) throw new Error('invalid integration policy state');
    return parsed;
  }

  // atomically replace private policy state
  private async write(stored: StoredPolicy): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    const serialized = `${JSON.stringify(stored)}\n`;
    await writeFile(next, serialized, { mode: 0o600 });
    await chmod(next, 0o600);
    try { await rename(next, this.file); }
    catch {
      let publication: IntegrationPolicyWriteError['publication'] = 'unknown';
      try { publication = await readFile(this.file, 'utf8') === serialized ? 'published' : 'not_published'; }
      catch (error) {
        // only a missing destination proves that the private stage was not published
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') publication = 'not_published';
      }
      throw new IntegrationPolicyWriteError(publication);
    }
  }
}

// hash secrets and argument envelopes
export function digest(value: string): string { return createHash('sha256').update(value).digest('base64url'); }

// claim one replay key without evicting any live record
function claimRecord(stored: StoredPolicy, principalKey: string, tool: string, requestId: string, argumentsDigest: string, maxRecords: number, now: number): IdempotencyClaim {
  const existing = stored.idempotency.find(record => record.principalKey === principalKey && record.tool === tool && record.requestId === requestId);
  // prevent a key from changing meaning
  if (existing !== undefined && existing.argumentsDigest !== argumentsDigest) return { kind: 'conflict' };
  // return the current claim state
  if (existing?.state === 'in_progress') return { kind: 'in_progress', recordId: existing.id };
  // replay every settled outcome
  if (existing !== undefined) return { kind: 'replay', recordId: existing.id, state: existing.state, ...(existing.result === undefined ? {} : { result: existing.result }) };
  // refuse capacity without deleting an unexpired record
  if (stored.idempotency.length >= maxRecords) return { kind: 'capacity' };
  const record: IdempotencyRecord = { id: randomBytes(18).toString('base64url'), principalKey, tool, requestId, argumentsDigest, state: 'in_progress', createdAt: now, updatedAt: now };
  stored.idempotency.push(record);
  return { kind: 'claimed', recordId: record.id };
}

// locate one lifecycle command by idempotency claim
function lifecycleFor(stored: StoredPolicy, recordId: string | undefined): LifecycleCommandRecord | undefined {
  // hide commands when no claim identity exists
  if (recordId === undefined) return undefined;
  const command = stored.lifecycleCommands.find(candidate => candidate.idempotencyRecordId === recordId);
  return command === undefined ? undefined : { ...command };
}

// validate one command before persistence
function validLifecycleInput(value: LifecycleCommandInput): boolean {
  return value.targetAgentId.length > 0 && value.targetAgentId.length <= 240 && !value.targetAgentId.includes('\0') && ['restart', 'resume_replacing', 'compact_replacing'].includes(value.operation) && Number.isSafeInteger(value.expectedGeneration) && value.expectedGeneration >= 0;
}

// retain only records within exact serialized bounds
function fitsLifecycleRecord(value: LifecycleCommandRecord): boolean { return Buffer.byteLength(JSON.stringify(value)) <= maximumLifecycleRecordBytes; }

// calculate bounded lifecycle storage footprint
function lifecycleBytes(values: LifecycleCommandRecord[]): number { return Buffer.byteLength(JSON.stringify(values)); }

// settle the linked idempotency record with the same durable write
function settleLifecycleIdempotency(stored: StoredPolicy, command: LifecycleCommandRecord): void {
  // leave unfinished commands claimed
  if (command.state === 'pending' || command.state === 'running') return;
  const record = stored.idempotency.find(candidate => candidate.id === command.idempotencyRecordId);
  // retain already-settled or missing replay evidence
  if (record === undefined || record.state !== 'in_progress') return;
  record.state = command.state === 'succeeded' ? 'completed' : command.state === 'unknown' ? 'unknown_outcome' : 'failed';
  record.updatedAt = command.updatedAt;
  record.result = { commandId: command.id, state: command.state };
}

// remove expired records without live eviction
function prune(stored: StoredPolicy, now: number): void {
  stored.idempotency = stored.idempotency.filter(record => record.updatedAt + idempotencyLifetimeMs > now);
  const liveIds = new Set(stored.idempotency.map(record => record.id));
  stored.lifecycleCommands = stored.lifecycleCommands.filter(command => command.updatedAt + idempotencyLifetimeMs > now && liveIds.has(command.idempotencyRecordId));
}

// validate persisted state before trusting it
function validStoredPolicy(value: unknown, maxRecords: number): value is StoredPolicy {
  // require the versioned envelope
  if (value === null || typeof value !== 'object' || (value as { version?: unknown }).version !== contractVersion) return false;
  const stored = value as { idempotency?: unknown; lifecycleCommands?: unknown };
  // require both bounded record arrays
  if (!Array.isArray(stored.idempotency) || stored.idempotency.length > maxRecords || !stored.idempotency.every(validIdempotencyRecord) || !Array.isArray(stored.lifecycleCommands) || stored.lifecycleCommands.length > maximumLifecycleCommands || lifecycleBytes(stored.lifecycleCommands as LifecycleCommandRecord[]) > maximumLifecycleBytes || !stored.lifecycleCommands.every(validLifecycleCommand)) return false;
  const recordIds = new Set(stored.idempotency.map(record => record.id));
  const commandIds = new Set((stored.lifecycleCommands as LifecycleCommandRecord[]).map(command => command.id));
  // require unique commands linked to retained idempotency evidence
  return commandIds.size === stored.lifecycleCommands.length && (stored.lifecycleCommands as LifecycleCommandRecord[]).every(command => recordIds.has(command.idempotencyRecordId));
}

// accept only replay-safe legacy state
function validLegacyPolicy(value: unknown, maxRecords: number): value is { version: 1 | 2 | 3; idempotency: IdempotencyRecord[] } {
  // require one recognized legacy envelope
  if (value === null || typeof value !== 'object' || ![1, 2, 3].includes(Number((value as { version?: unknown }).version))) return false;
  const stored = value as { idempotency?: unknown };
  return Array.isArray(stored.idempotency) && stored.idempotency.length <= maxRecords && stored.idempotency.every(validIdempotencyRecord);
}

// validate one persisted idempotency record
function validIdempotencyRecord(value: unknown): value is IdempotencyRecord {
  // require the fixed idempotency shape
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<IdempotencyRecord>;
  return typeof record.id === 'string' && typeof record.principalKey === 'string' && typeof record.tool === 'string' && typeof record.requestId === 'string' && typeof record.argumentsDigest === 'string' && ['in_progress', 'completed', 'failed', 'unknown_outcome'].includes(String(record.state)) && typeof record.createdAt === 'number' && typeof record.updatedAt === 'number';
}

// validate one persisted lifecycle command
function validLifecycleCommand(value: unknown): value is LifecycleCommandRecord {
  // require one bounded exact command shape
  if (value === null || typeof value !== 'object' || !fitsLifecycleRecord(value as LifecycleCommandRecord)) return false;
  const command = value as Partial<LifecycleCommandRecord>;
  return typeof command.id === 'string' && typeof command.idempotencyRecordId === 'string' && typeof command.targetAgentId === 'string' && typeof command.operation === 'string' && ['restart', 'resume_replacing', 'compact_replacing'].includes(command.operation) && typeof command.expectedGeneration === 'number' && Number.isSafeInteger(command.expectedGeneration) && typeof command.state === 'string' && ['pending', 'running', 'succeeded', 'failed', 'unknown'].includes(command.state) && typeof command.createdAt === 'number' && typeof command.updatedAt === 'number';
}
