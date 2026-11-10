import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PromptOutcome } from './service.js';

export type PromptOperationState = 'prepared' | 'publishing' | 'published' | 'unknown';
export type PromptOperationLifecycleState = 'queued' | 'delivered' | 'ended';

export type AgentActivitySnapshot = {
  epoch: number;
  pending: boolean;
  updatedAt: string;
};

export type PromptOperationIdentity = {
  operationKey: string;
  promptId: string;
  agentId: string;
  canonicalDestination: string;
  payloadDigest: string;
  targetDigest: string;
  generation: string | number;
  davoRequestId: string;
  expiresAt: string;
  expectedActivityEpoch: number;
};

export type PromptOperationLifecycle = {
  state: PromptOperationLifecycleState;
  updatedAt: string;
  historyEntryId?: string;
  outcome?: PromptOutcome;
};

export type PromptOperationRecord = PromptOperationIdentity & {
  state: PromptOperationState;
  createdAt: string;
  updatedAt: string;
  publicationActivityEpoch?: number;
  lifecycle?: PromptOperationLifecycle;
};

export type PromptOperationPrepareResult =
  | { kind: 'prepared'; operation: PromptOperationRecord }
  | { kind: 'existing'; operation: PromptOperationRecord }
  | { kind: 'conflict' }
  | { kind: 'capacity' }
  | { kind: 'expired' }
  | { kind: 'invalid' };

type StoredFrontier = AgentActivitySnapshot & {
  agentId: string;
  watchedUntil: string;
  pendingOperationKey?: string;
  lastObservationDigest?: string;
  baselinePending?: boolean;
};

type StoredPromptOperations = {
  schemaVersion: 1;
  operations: PromptOperationRecord[];
  frontiers: StoredFrontier[];
};

export type PromptOperationLedgerOptions = {
  clock?: () => Date;
  maxBytes?: number;
  maxOperations?: number;
};

const schemaVersion = 1;
const defaultMaxBytes = 4 * 1024 * 1024;
const defaultMaxOperations = 4_096;
const validPromptId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
const validBounded = (value: string, maximum: number) => value.length > 0 && value.length <= maximum && !value.includes('\0');
const validInstant = (value: string) => Number.isFinite(Date.parse(value));
const validGeneration = (value: string | number) => typeof value === 'number'
  ? Number.isSafeInteger(value) && value >= 0
  : validBounded(value, 128);

// compare every immutable publication field
const sameIdentity = (left: PromptOperationIdentity, right: PromptOperationIdentity): boolean => left.operationKey === right.operationKey
  && left.promptId === right.promptId
  && left.agentId === right.agentId
  && left.canonicalDestination === right.canonicalDestination
  && left.payloadDigest === right.payloadDigest
  && left.targetDigest === right.targetDigest
  && left.generation === right.generation
  && left.davoRequestId === right.davoRequestId
  && left.expiresAt === right.expiresAt
  && left.expectedActivityEpoch === right.expectedActivityEpoch;

// validate content-free operation identity
const validIdentity = (value: PromptOperationIdentity): boolean => validBounded(value.operationKey, 256)
  && validPromptId(value.promptId)
  && validBounded(value.agentId, 4_096)
  && validBounded(value.canonicalDestination, 4_096)
  && validBounded(value.payloadDigest, 256)
  && validBounded(value.targetDigest, 256)
  && validGeneration(value.generation)
  && validBounded(value.davoRequestId, 256)
  && validInstant(value.expiresAt)
  && Number.isSafeInteger(value.expectedActivityEpoch)
  && value.expectedActivityEpoch >= 0;

// validate one persisted lifecycle receipt
const validLifecycle = (value: unknown): value is PromptOperationLifecycle => {
  // require a plain receipt object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const lifecycle = value as { state?: unknown; updatedAt?: unknown; historyEntryId?: unknown; outcome?: unknown };
  const states: readonly unknown[] = ['queued', 'delivered', 'ended'];
  const outcomes: readonly unknown[] = ['completed', 'failed', 'interrupted', 'exited', 'not-delivered', 'withdrawn', 'gone'];
  const allowed = new Set(['state', 'updatedAt', 'historyEntryId', 'outcome']);
  return Object.keys(value).every(key => allowed.has(key))
    && states.includes(lifecycle.state)
    && typeof lifecycle.updatedAt === 'string'
    && validInstant(lifecycle.updatedAt)
    && (lifecycle.historyEntryId === undefined || typeof lifecycle.historyEntryId === 'string' && validPromptId(lifecycle.historyEntryId))
    && (lifecycle.outcome === undefined || outcomes.includes(lifecycle.outcome));
};

// validate one persisted operation
const validOperation = (value: unknown): value is PromptOperationRecord => {
  // require a plain operation object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = value as PromptOperationRecord;
  const states: readonly unknown[] = ['prepared', 'publishing', 'published', 'unknown'];
  const allowed = new Set(['operationKey', 'promptId', 'agentId', 'canonicalDestination', 'payloadDigest', 'targetDigest', 'generation', 'davoRequestId', 'expiresAt', 'expectedActivityEpoch', 'state', 'createdAt', 'updatedAt', 'publicationActivityEpoch', 'lifecycle']);
  return Object.keys(value).every(key => allowed.has(key))
    && validIdentity(operation)
    && states.includes(operation.state)
    && typeof operation.createdAt === 'string'
    && validInstant(operation.createdAt)
    && typeof operation.updatedAt === 'string'
    && validInstant(operation.updatedAt)
    && (operation.publicationActivityEpoch === undefined || Number.isSafeInteger(operation.publicationActivityEpoch) && operation.publicationActivityEpoch >= 0)
    && (operation.lifecycle === undefined || validLifecycle(operation.lifecycle));
};

// validate one watched activity frontier
const validFrontier = (value: unknown): value is StoredFrontier => {
  // require a plain frontier object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const frontier = value as StoredFrontier;
  const allowed = new Set(['agentId', 'epoch', 'pending', 'updatedAt', 'watchedUntil', 'pendingOperationKey', 'lastObservationDigest', 'baselinePending']);
  return Object.keys(value).every(key => allowed.has(key))
    && validBounded(frontier.agentId, 4_096)
    && Number.isSafeInteger(frontier.epoch)
    && frontier.epoch >= 0
    && typeof frontier.pending === 'boolean'
    && typeof frontier.updatedAt === 'string'
    && validInstant(frontier.updatedAt)
    && typeof frontier.watchedUntil === 'string'
    && validInstant(frontier.watchedUntil)
    && (frontier.pendingOperationKey === undefined || validBounded(frontier.pendingOperationKey, 256))
    && (frontier.lastObservationDigest === undefined || validBounded(frontier.lastObservationDigest, 256))
    && (frontier.baselinePending === undefined || typeof frontier.baselinePending === 'boolean');
};

// clone a public activity snapshot
const activityOf = (frontier: StoredFrontier): AgentActivitySnapshot => ({ epoch: frontier.epoch, pending: frontier.pending, updatedAt: frontier.updatedAt });

export class PromptOperationLedger {
  private mutation = Promise.resolve();
  private stored?: StoredPromptOperations;
  private readonly clock: () => Date;
  private readonly maxBytes: number;
  private readonly maxOperations: number;

  // bind one explicit durable operation file
  constructor(private readonly file: string, options: PromptOperationLedgerOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.maxOperations = options.maxOperations ?? defaultMaxOperations;
  }

  // reserve an immutable operation without prompt content
  async prepare(identity: PromptOperationIdentity): Promise<PromptOperationPrepareResult> {
    // reject malformed or already expired authority
    if (!validIdentity(identity)) return { kind: 'invalid' };
    const now = this.clock();
    if (Date.parse(identity.expiresAt) <= now.getTime()) return { kind: 'expired' };
    return await this.mutate(stored => {
      const existing = stored.operations.find(operation => operation.operationKey === identity.operationKey);
      // replay only the byte-equivalent identity
      if (existing !== undefined) return sameIdentity(existing, identity) ? { kind: 'existing' as const, operation: structuredClone(existing) } : { kind: 'conflict' as const };
      // never evict an unexpired operation for capacity
      if (stored.operations.length >= this.maxOperations) return { kind: 'capacity' as const };
      const createdAt = now.toISOString();
      const operation: PromptOperationRecord = {
        operationKey: identity.operationKey,
        promptId: identity.promptId,
        agentId: identity.agentId,
        canonicalDestination: identity.canonicalDestination,
        payloadDigest: identity.payloadDigest,
        targetDigest: identity.targetDigest,
        generation: identity.generation,
        davoRequestId: identity.davoRequestId,
        expiresAt: identity.expiresAt,
        expectedActivityEpoch: identity.expectedActivityEpoch,
        state: 'prepared',
        createdAt,
        updatedAt: createdAt
      };
      stored.operations.push(operation);
      return { kind: 'prepared' as const, operation: structuredClone(operation) };
    });
  }

  // look up one exact active operation
  async lookup(operationKey: string): Promise<PromptOperationRecord | undefined> {
    // reject invalid lookup keys
    if (!validBounded(operationKey, 256)) return undefined;
    return await this.mutate(stored => structuredClone(stored.operations.find(operation => operation.operationKey === operationKey)));
  }

  // look up one operation by its stable prompt id
  async lookupByPrompt(promptId: string): Promise<PromptOperationRecord | undefined> {
    // reject invalid prompt identity
    if (!validPromptId(promptId)) return undefined;
    return await this.mutate(stored => structuredClone(stored.operations.find(operation => operation.promptId === promptId)));
  }

  // read the exact latest correlated publication independently of presentation history
  async latestPublished(agentId: string): Promise<PromptOperationRecord | undefined> {
    return await this.mutate(stored => structuredClone(stored.operations.filter(operation => operation.agentId === agentId && operation.state === 'published').sort((left, right) => (right.publicationActivityEpoch ?? -1) - (left.publicationActivityEpoch ?? -1))[0]));
  }

  // erase elapsed receipts even when no new prompt arrives
  async pruneExpired(): Promise<void> { await this.mutate(() => undefined); }

  // move one operation through an allowed state transition
  async transition(operationKey: string, from: readonly PromptOperationState[], to: PromptOperationState, publicationActivityEpoch?: number): Promise<PromptOperationRecord | undefined> {
    // reject malformed transition inputs
    if (!validBounded(operationKey, 256) || !(['prepared', 'publishing', 'published', 'unknown'] as readonly unknown[]).includes(to)) return undefined;
    return await this.mutate(stored => {
      const operation = stored.operations.find(candidate => candidate.operationKey === operationKey);
      // require the expected active state
      if (operation === undefined || !from.includes(operation.state)) return undefined;
      operation.state = to;
      operation.updatedAt = this.clock().toISOString();
      // preserve the exact correlated frontier epoch
      if (publicationActivityEpoch !== undefined) operation.publicationActivityEpoch = publicationActivityEpoch;
      return structuredClone(operation);
    });
  }

  // persist one content-free lifecycle receipt monotonically
  async recordLifecycle(promptId: string, lifecycle: Omit<PromptOperationLifecycle, 'updatedAt'>): Promise<PromptOperationRecord | undefined> {
    // reject malformed receipt identity
    if (!validPromptId(promptId)) return undefined;
    return await this.mutate(stored => {
      const operation = stored.operations.find(candidate => candidate.promptId === promptId);
      // ignore unrelated prompt lifecycles
      if (operation === undefined) return undefined;
      const ranks: Record<PromptOperationLifecycleState, number> = { queued: 0, delivered: 1, ended: 2 };
      // reject lifecycle regression after restart or duplicate observation
      if (operation.lifecycle !== undefined && ranks[lifecycle.state] < ranks[operation.lifecycle.state]) return structuredClone(operation);
      // preserve the first durable terminal outcome
      if (operation.lifecycle?.state === 'ended') return structuredClone(operation);
      operation.lifecycle = { ...lifecycle, updatedAt: this.clock().toISOString() };
      operation.updatedAt = operation.lifecycle.updatedAt;
      return structuredClone(operation);
    });
  }

  // begin durable activity tracking only for an eligible target
  async watchActivity(agentId: string, expiresAt: string, observation?: { key: string; pending: boolean }): Promise<AgentActivitySnapshot | undefined> {
    // reject invalid or expired watch bounds
    if (!validBounded(agentId, 4_096) || !validInstant(expiresAt) || Date.parse(expiresAt) <= this.clock().getTime() || observation !== undefined && !validBounded(observation.key, 4_096)) return undefined;
    return await this.mutate(stored => {
      let frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // create only an explicitly watched target
      if (frontier === undefined) {
        frontier = { agentId, epoch: 0, pending: false, updatedAt: this.clock().toISOString(), watchedUntil: expiresAt, ...(observation === undefined ? {} : { lastObservationDigest: createHash('sha256').update(observation.key).digest('base64url'), baselinePending: observation.pending }) };
        stored.frontiers.push(frontier);
      } else if (Date.parse(expiresAt) > Date.parse(frontier.watchedUntil)) {
        // extend only to an explicit later caller expiry
        frontier.watchedUntil = expiresAt;
      }
      return activityOf(frontier);
    });
  }

  // read one watched target frontier without creating it
  async activitySnapshot(agentId: string): Promise<AgentActivitySnapshot | undefined> {
    // reject invalid target identity
    if (!validBounded(agentId, 4_096)) return undefined;
    const operation = this.mutation.then(async () => {
      const stored = structuredClone(await this.read());
      this.prune(stored);
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      return frontier === undefined ? undefined : activityOf(frontier);
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // stamp an external attempt before its effect begins
  async beginExternalActivity(agentId: string): Promise<AgentActivitySnapshot | undefined> {
    return await this.advance(agentId, undefined);
  }

  // stamp a correlated publication before enqueue can begin
  async beginPublicationActivity(agentId: string, operationKey: string, expectedEpoch: number): Promise<AgentActivitySnapshot | undefined> {
    // reject malformed publication correlation
    if (!validBounded(operationKey, 256) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) return undefined;
    return await this.mutate(stored => {
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // require the exact stable frontier with no unresolved attempt
      if (frontier === undefined || frontier.pending || frontier.epoch !== expectedEpoch) return undefined;
      frontier.epoch += 1;
      frontier.pending = true;
      frontier.pendingOperationKey = operationKey;
      frontier.updatedAt = this.clock().toISOString();
      return activityOf(frontier);
    });
  }

  // confirm the exact correlated publication attempt
  async confirmPublicationActivity(agentId: string, operationKey: string): Promise<AgentActivitySnapshot | undefined> {
    // reject malformed publication correlation
    if (!validBounded(operationKey, 256)) return undefined;
    return await this.mutate(stored => {
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // clear only the matching pending operation
      if (frontier === undefined || frontier.pendingOperationKey !== operationKey) return frontier === undefined ? undefined : activityOf(frontier);
      frontier.pending = false;
      delete frontier.pendingOperationKey;
      frontier.updatedAt = this.clock().toISOString();
      return activityOf(frontier);
    });
  }

  // roll back a proven no-effect publication claim
  async abandonPublicationActivity(agentId: string, operationKey: string, previousEpoch: number): Promise<AgentActivitySnapshot | undefined> {
    // reject malformed rollback identity
    if (!validBounded(operationKey, 256) || !Number.isSafeInteger(previousEpoch) || previousEpoch < 0) return undefined;
    return await this.mutate(stored => {
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // restore only the untouched exact claim
      if (frontier === undefined || frontier.pendingOperationKey !== operationKey || frontier.epoch !== previousEpoch + 1) return frontier === undefined ? undefined : activityOf(frontier);
      frontier.epoch = previousEpoch;
      frontier.pending = false;
      delete frontier.pendingOperationKey;
      frontier.updatedAt = this.clock().toISOString();
      return activityOf(frontier);
    });
  }

  // settle one known successful ordinary prompt source
  async confirmExternalActivity(agentId: string): Promise<AgentActivitySnapshot | undefined> {
    return await this.mutate(stored => {
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // retain the new epoch while clearing only an uncorrelated pending stamp
      if (frontier === undefined || !frontier.pending || frontier.pendingOperationKey !== undefined) return frontier === undefined ? undefined : activityOf(frontier);
      frontier.pending = false;
      frontier.updatedAt = this.clock().toISOString();
      return activityOf(frontier);
    });
  }

  // replace the native observation baseline without advancing activity
  async setObservationBaseline(agentId: string, observationKey: string, pending: boolean): Promise<AgentActivitySnapshot | undefined> {
    // reject unbounded observation keys
    if (!validBounded(observationKey, 4_096)) return undefined;
    const digest = createHash('sha256').update(observationKey).digest('base64url');
    return await this.mutate(stored => {
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // ignore ordinary unwatched agents
      if (frontier === undefined) return undefined;
      frontier.lastObservationDigest = digest;
      frontier.baselinePending = pending;
      frontier.updatedAt = this.clock().toISOString();
      return activityOf(frontier);
    });
  }

  // observe one external turn without keeping an event log
  async observeExternalTurn(agentId: string, observationKey: string, turnStarted = false, uncertain = false): Promise<AgentActivitySnapshot | undefined> {
    // reject unbounded observation keys
    if (!validBounded(observationKey, 4_096)) return undefined;
    const digest = createHash('sha256').update(observationKey).digest('base64url');
    return await this.mutate(stored => {
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // ignore ordinary unwatched agents
      if (frontier === undefined) return undefined;
      // deduplicate the latest transport observation
      if (frontier.lastObservationDigest === digest) return activityOf(frontier);
      // retain an unrecoverable native event gap as pending ambiguity
      if (uncertain) {
        if (!frontier.pending) frontier.epoch += 1;
        frontier.pending = true;
        delete frontier.pendingOperationKey;
        frontier.lastObservationDigest = digest;
        frontier.baselinePending = turnStarted;
        frontier.updatedAt = this.clock().toISOString();
        return activityOf(frontier);
      }
      // consume only the idle completion of a turn already present at the baseline
      if (frontier.baselinePending === true && !turnStarted) {
        frontier.baselinePending = false;
        frontier.lastObservationDigest = digest;
        frontier.updatedAt = this.clock().toISOString();
        return activityOf(frontier);
      }
      // a pending manual stamp already advanced this activity once
      if (frontier.pending && frontier.pendingOperationKey === undefined) frontier.pending = false;
      else frontier.epoch += 1;
      frontier.lastObservationDigest = digest;
      frontier.baselinePending = turnStarted;
      frontier.updatedAt = this.clock().toISOString();
      return activityOf(frontier);
    });
  }

  // advance one watched frontier and leave it unresolved
  private async advance(agentId: string, operationKey: string | undefined): Promise<AgentActivitySnapshot | undefined> {
    // reject invalid target identity
    if (!validBounded(agentId, 4_096)) return undefined;
    return await this.mutate(stored => {
      const frontier = stored.frontiers.find(candidate => candidate.agentId === agentId);
      // ignore ordinary unwatched agents
      if (frontier === undefined) return undefined;
      frontier.epoch += 1;
      frontier.pending = true;
      // retain only an explicit operation correlation
      if (operationKey === undefined) delete frontier.pendingOperationKey;
      else frontier.pendingOperationKey = operationKey;
      frontier.updatedAt = this.clock().toISOString();
      return activityOf(frontier);
    });
  }

  // serialize, prune, validate, and atomically persist one mutation
  private async mutate<T>(change: (stored: StoredPromptOperations) => T | Promise<T>): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = structuredClone(await this.read());
      this.prune(stored);
      const result = await change(stored);
      this.assertBounds(stored);
      await this.write(stored);
      this.stored = stored;
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // remove only expired authority and orphaned frontiers
  private prune(stored: StoredPromptOperations): void {
    const now = this.clock().getTime();
    stored.operations = stored.operations.filter(operation => Date.parse(operation.expiresAt) > now);
    const activeAgents = new Set(stored.operations.map(operation => operation.agentId));
    stored.frontiers = stored.frontiers.filter(frontier => Date.parse(frontier.watchedUntil) > now || activeAgents.has(frontier.agentId));
  }

  // read and validate the complete bounded store
  private async read(): Promise<StoredPromptOperations> {
    // reuse the process-owned durable snapshot
    if (this.stored !== undefined) return this.stored;
    const serialized = await readFile(this.file, 'utf8').catch(error => {
      // treat missing storage as an empty ledger
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    // avoid creating a default file before explicit use
    if (serialized === undefined) return { schemaVersion, operations: [], frontiers: [] };
    if (Buffer.byteLength(serialized) > this.maxBytes) throw new Error('prompt operation ledger exceeds storage limits');
    const raw = JSON.parse(serialized) as unknown;
    // require the exact current schema
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid prompt operation ledger');
    const value = raw as { schemaVersion?: unknown; operations?: unknown; frontiers?: unknown };
    const allowed = new Set(['schemaVersion', 'operations', 'frontiers']);
    if (!Object.keys(raw).every(key => allowed.has(key)) || value.schemaVersion !== schemaVersion || !Array.isArray(value.operations) || !Array.isArray(value.frontiers)) throw new Error('invalid prompt operation ledger');
    if (value.operations.length > this.maxOperations || value.operations.some(operation => !validOperation(operation)) || value.frontiers.some(frontier => !validFrontier(frontier))) throw new Error('invalid prompt operation ledger');
    const operationKeys = new Set(value.operations.map(operation => (operation as PromptOperationRecord).operationKey));
    const promptIds = new Set(value.operations.map(operation => (operation as PromptOperationRecord).promptId));
    const agentIds = new Set(value.frontiers.map(frontier => (frontier as StoredFrontier).agentId));
    // reject duplicate exact identities
    if (operationKeys.size !== value.operations.length || promptIds.size !== value.operations.length || agentIds.size !== value.frontiers.length) throw new Error('invalid prompt operation ledger');
    const stored: StoredPromptOperations = { schemaVersion, operations: value.operations as PromptOperationRecord[], frontiers: value.frontiers as StoredFrontier[] };
    this.assertBounds(stored);
    this.stored = stored;
    return stored;
  }

  // enforce count and serialized byte caps before persistence
  private assertBounds(value: StoredPromptOperations): void {
    // reject active-operation or serialized growth
    if (value.operations.length > this.maxOperations || Buffer.byteLength(JSON.stringify(value)) > this.maxBytes) throw new Error('prompt operation ledger exceeds storage limits');
  }

  // atomically fsync one private ledger replacement
  private async write(value: StoredPromptOperations): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    const handle = await open(next, 'w', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(next, this.file);
    const directory = await open(dirname(this.file), 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  }
}
