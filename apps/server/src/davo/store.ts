import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DAVO_MESSAGE_MAX_COUNT,
  DAVO_REQUEST_MAX_COUNT,
  DAVO_STATE_MAX_BYTES,
  DAVO_USER_TEXT_MAX_BYTES,
  davoMessageSchema,
  davoStateSchema,
  parseDavoState,
  utf8Bytes,
  type DavoMessageV1,
  type DavoProviderCallV1,
  type DavoStateV1
} from './contracts.js';
import { localDateForInstant, retentionWindow } from './retention.js';
import { davoMcpActivityText, type DavoMcpActivityPhase } from './tool-activity.js';

export type DavoStoreErrorCode = 'davo_store_unavailable' | 'davo_capacity' | 'davo_store_invalid' | 'davo_idempotency_conflict';

export class DavoStoreError extends Error {
  readonly code: DavoStoreErrorCode;

  // retain only one safe error code
  constructor(code: DavoStoreErrorCode) {
    super(code);
    this.name = 'DavoStoreError';
    this.code = code;
  }
}

export class DavoAdmissionPendingError extends Error {
  readonly code = 'davo_admission_pending' as const;

  // retain only the deterministic message identifier
  constructor(readonly messageId: string) {
    super('davo_admission_pending');
    this.name = 'DavoAdmissionPendingError';
  }
}

export type DavoGenerationFence = {
  previousGeneration: number;
  generation: number;
  sweepDate: string;
  retainedFrom: string;
  expiredRequestIds: string[];
  providerCalls: DavoProviderCallV1[];
};

export type DavoGenerationFenceOutcome = {
  closedCallIds: string[];
};

export type DavoEnsureCurrentResult = {
  swept: boolean;
  generation: number;
  sweepDate: string;
  retainedFrom: string;
  expiredRequestIds: string[];
  providerCalls: DavoProviderCallV1[];
};

export type DavoStoreFileSystem = {
  read(path: string): Promise<string>;
  size(path: string): Promise<number>;
  ensureDirectory(path: string): Promise<void>;
  writeAndSync(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
};

export type DavoStoreOptions = {
  file?: string;
  now?: () => Date;
  onFence?: (fence: DavoGenerationFence) => DavoGenerationFenceOutcome | void | Promise<DavoGenerationFenceOutcome | void>;
  fileSystem?: DavoStoreFileSystem;
};

type AppendSource = DavoMessageV1['source'];
type DavoPersistenceOutcome = 'committed' | 'ambiguous' | 'pending';
type DavoAdmissionCommitMarker = { version: 1; digest: string };
export type DavoAppendMessageInput = {
  id?: string;
  kind: DavoMessageV1['kind'];
  text: string;
  source: AppendSource;
  requestId?: string;
  createdAt?: string;
  retentionAnchorAt?: string;
  retentionAnchorLocalDate?: string;
};

export type DavoAppendUserTranscriptInput = {
  id?: string;
  generation?: number;
  authorize?: () => void;
  voiceSessionId: string;
  providerSessionId: string;
  providerItemId: string;
  text: string;
  createdAt?: string;
  requestId?: string;
};

// classify a missing file without broad recovery
function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

// persist one file and its containing directory
const defaultFileSystem: DavoStoreFileSystem = {
  // read complete bounded state after size validation
  read: async path => readFile(path, 'utf8'),
  // read canonical byte size
  size: async path => (await stat(path)).size,
  // create only the selected state directory
  ensureDirectory: async path => { await mkdir(path, { recursive: true, mode: 0o700 }); },
  // write and flush one private temporary file
  writeAndSync: async (path, contents) => {
    const handle = await open(path, 'w', 0o600);
    try {
      // privatize any reused inode before writing retained content
      await handle.chmod(0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  // replace the canonical state atomically
  rename: async (from, to) => { await rename(from, to); },
  // flush the directory entry update
  syncDirectory: async path => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  // remove only a known temporary state path
  remove: async path => { await unlink(path).catch(error => { if (!missing(error)) throw error; }); },
  // keep canonical state private
  setMode: async (path, mode) => { await chmod(path, mode); }
};

// copy state across API boundaries
function clone<T>(value: T): T {
  return structuredClone(value);
}

// detect accidental asynchronous mutation callbacks
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

// hash one exact admission candidate without retaining its content
function stateDigest(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex');
}

// accept only the fixed content-free admission marker
function admissionMarker(value: unknown): value is DavoAdmissionCommitMarker {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.version === 1 && typeof record.digest === 'string' && /^[a-f0-9]{64}$/.test(record.digest);
}

// create an empty state at the required cutoff
function initialState(now: Date): DavoStateV1 {
  const window = retentionWindow(now);
  return {
    schemaVersion: 1,
    logicalConversationId: randomUUID(),
    retention: {
      generation: 0,
      lastCompletedSweepDate: window.sweepDate,
      retainedFrom: window.retainedFrom,
      contextRevision: randomUUID()
    },
    nextSequence: 1,
    messages: [],
    requests: [],
    providerCalls: [],
    operations: [],
    remoteGrants: [],
    notificationOutbox: []
  };
}

// identify a quota violation before schema parsing
function exceedsCapacity(value: DavoStateV1): boolean {
  let reservedBytes = utf8Bytes(JSON.stringify(value));
  // preserve enough room to replace every provisional activity row in place
  for (const message of value.messages) {
    if (message.kind !== 'status' || message.source.kind !== 'mcp-activity' || message.source.phase !== 'running' && message.source.phase !== 'interrupted') continue;
    const currentBytes = utf8Bytes(JSON.stringify(message));
    let maximumBytes = currentBytes;
    // reserve the exact largest legal reconciliation for this tool
    for (const phase of ['interrupted', 'succeeded', 'failed', 'unknown'] as DavoMcpActivityPhase[]) {
      maximumBytes = Math.max(maximumBytes, utf8Bytes(JSON.stringify({ ...message, text: davoMcpActivityText(message.source.tool, phase), source: { ...message.source, phase } })));
    }
    reservedBytes += maximumBytes - currentBytes;
  }
  return value.messages.length > DAVO_MESSAGE_MAX_COUNT || value.requests.length > DAVO_REQUEST_MAX_COUNT || reservedBytes > DAVO_STATE_MAX_BYTES;
}

export class DavoStore {
  readonly file: string;
  private readonly temporaryFile: string;
  private readonly admissionCommitFile: string;
  private readonly now: () => Date;
  private readonly onFence?: DavoStoreOptions['onFence'];
  private readonly fileSystem: DavoStoreFileSystem;
  private frontier: Promise<void> = Promise.resolve();
  private state: DavoStateV1 | undefined;
  private unavailable = false;
  private generationFence: number | undefined;

  // configure one serialized atomic store
  constructor(options: DavoStoreOptions = {}) {
    this.file = options.file ?? join(process.cwd(), '.data', 'davo-state.json');
    this.temporaryFile = `${this.file}.next`;
    this.admissionCommitFile = `${this.file}.admission-commit`;
    this.now = options.now ?? (() => new Date());
    this.onFence = options.onFence;
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  // expose the active in-memory fence after initialization
  get currentGeneration(): number | undefined {
    return this.generationFence ?? this.state?.retention.generation;
  }

  // report fail-closed runtime availability
  get available(): boolean {
    return !this.unavailable;
  }

  // serialize every load and mutation
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.frontier.then(operation);
    this.frontier = result.then(() => undefined, () => undefined);
    return result;
  }

  // load or initialize canonical state once
  private async load(): Promise<DavoStateV1> {
    // reject a previously uncertain store
    if (this.unavailable) throw new DavoStoreError('davo_store_unavailable');
    // reuse the validated in-memory state
    if (this.state !== undefined) return this.state;
    await this.fileSystem.ensureDirectory(dirname(this.file));
    try {
      await this.recoverAdmissionCommit();
      const size = await this.fileSystem.size(this.file);
      // avoid reading an oversized canonical file
      if (size > DAVO_STATE_MAX_BYTES) throw new DavoStoreError('davo_store_unavailable');
      const raw = await this.fileSystem.read(this.file);
      const parsed = parseDavoState(JSON.parse(raw));
      await this.fileSystem.setMode(this.file, 0o600);
      await this.fileSystem.remove(this.temporaryFile);
      this.state = parsed;
      this.generationFence = parsed.retention.generation;
      return parsed;
    } catch (error) {
      // create only when canonical state is absent
      if (missing(error)) {
        const created = initialState(this.now());
        await this.persist(created);
        this.state = created;
        this.generationFence = created.retention.generation;
        return created;
      }
      await this.fileSystem.remove(this.temporaryFile).catch(() => undefined);
      this.unavailable = true;
      throw new DavoStoreError('davo_store_unavailable');
    }
  }

  // resolve one interrupted admission before any canonical read
  private async recoverAdmissionCommit(): Promise<void> {
    let markerRaw: string;
    try {
      const markerSize = await this.fileSystem.size(this.admissionCommitFile);
      // reject any marker large enough to contain retained content
      if (markerSize > 256) throw new DavoStoreError('davo_store_unavailable');
      markerRaw = await this.fileSystem.read(this.admissionCommitFile);
    } catch (error) {
      // proceed only when no recovery marker exists
      if (missing(error)) return;
      throw error;
    }
    let markerValue: unknown;
    try { markerValue = JSON.parse(markerRaw); }
    catch { throw new DavoStoreError('davo_store_unavailable'); }
    // never infer recovery from malformed metadata
    if (!admissionMarker(markerValue)) throw new DavoStoreError('davo_store_unavailable');
    const canonical = await this.recoveryCandidate(this.file);
    // retain an already promoted exact candidate
    if (canonical?.digest === markerValue.digest) {
      await this.fileSystem.syncDirectory(dirname(this.file));
      await this.clearAdmissionCommit();
      return;
    }
    const temporary = await this.recoveryCandidate(this.temporaryFile);
    // promote only the exact fsynced candidate named by the marker
    if (temporary?.digest === markerValue.digest) {
      await this.fileSystem.setMode(this.temporaryFile, 0o600);
      await this.fileSystem.rename(this.temporaryFile, this.file);
      await this.fileSystem.syncDirectory(dirname(this.file));
      await this.clearAdmissionCommit();
      return;
    }
    // roll back an unusable candidate only when the old canonical remains valid
    if (canonical !== undefined) {
      await this.fileSystem.remove(this.temporaryFile);
      await this.clearAdmissionCommit();
      return;
    }
    throw new DavoStoreError('davo_store_unavailable');
  }

  // read one bounded and schema-valid recovery candidate
  private async recoveryCandidate(path: string): Promise<{ digest: string } | undefined> {
    try {
      const size = await this.fileSystem.size(path);
      // never parse an oversized recovery candidate
      if (size > DAVO_STATE_MAX_BYTES) return undefined;
      const serialized = await this.fileSystem.read(path);
      parseDavoState(JSON.parse(serialized));
      return { digest: stateDigest(serialized) };
    } catch {
      return undefined;
    }
  }

  // remove only content-free admission recovery metadata
  private async clearAdmissionCommit(): Promise<void> {
    await this.fileSystem.remove(this.admissionCommitFile);
    await this.fileSystem.remove(this.temporaryFile);
    await this.fileSystem.syncDirectory(dirname(this.file));
  }

  // atomically publish one validated state
  private async persist(value: DavoStateV1): Promise<void> {
    const serialized = JSON.stringify(value);
    // enforce the byte cap before touching disk
    if (utf8Bytes(serialized) > DAVO_STATE_MAX_BYTES) throw new DavoStoreError('davo_capacity');
    try {
      await this.fileSystem.writeAndSync(this.temporaryFile, serialized);
      await this.fileSystem.setMode(this.temporaryFile, 0o600);
      await this.fileSystem.rename(this.temporaryFile, this.file);
      await this.fileSystem.syncDirectory(dirname(this.file));
    } catch {
      this.unavailable = true;
      throw new DavoStoreError('davo_store_unavailable');
    }
  }

  // publish one admission with content-free crash recovery proof
  private async persistAdmission(value: DavoStateV1): Promise<DavoPersistenceOutcome> {
    const serialized = JSON.stringify(value);
    // enforce the byte cap before touching disk
    if (utf8Bytes(serialized) > DAVO_STATE_MAX_BYTES) throw new DavoStoreError('davo_capacity');
    const marker = JSON.stringify({ version: 1, digest: stateDigest(serialized) } satisfies DavoAdmissionCommitMarker);
    let recoveryAttempted = false;
    let durableIntent = false;
    try {
      await this.fileSystem.writeAndSync(this.temporaryFile, serialized);
      await this.fileSystem.setMode(this.temporaryFile, 0o600);
      recoveryAttempted = true;
      await this.fileSystem.writeAndSync(this.admissionCommitFile, marker);
      await this.fileSystem.setMode(this.admissionCommitFile, 0o600);
      await this.fileSystem.syncDirectory(dirname(this.file));
      durableIntent = true;
      await this.fileSystem.rename(this.temporaryFile, this.file);
      await this.fileSystem.syncDirectory(dirname(this.file));
    } catch {
      // reject pre-marker failures only after durable rollback proof
      if (!recoveryAttempted) {
        try {
          await this.fileSystem.remove(this.temporaryFile);
          await this.fileSystem.remove(this.admissionCommitFile);
          await this.fileSystem.syncDirectory(dirname(this.file));
        } catch {
          this.unavailable = true;
          return 'pending';
        }
        this.unavailable = true;
        throw new DavoStoreError('davo_store_unavailable');
      }
      // withhold inference until marker and candidate names are durably proven
      if (!durableIntent) {
        this.unavailable = true;
        return 'pending';
      }
      // the durable marker makes exact startup reconciliation possible
      this.unavailable = true;
      return 'ambiguous';
    }
    // cleanup uncertainty cannot turn a proven commit into rejection
    await this.clearAdmissionCommit().catch(() => undefined);
    return 'committed';
  }

  // publish the newest required sanitized retention state
  private async ensureCurrentLoaded(at: Date): Promise<DavoEnsureCurrentResult> {
    const current = await this.load();
    const window = retentionWindow(at);
    // collapse completed or backward clock windows
    if (current.retention.lastCompletedSweepDate >= window.sweepDate) {
      return {
        swept: false,
        generation: current.retention.generation,
        sweepDate: current.retention.lastCompletedSweepDate,
        retainedFrom: current.retention.retainedFrom,
        expiredRequestIds: [],
        providerCalls: clone(current.providerCalls)
      };
    }
    const retainedFrom = Date.parse(window.retainedFrom);
    const retainedMessages = current.messages.filter(message => Date.parse(message.retentionAnchorAt) >= retainedFrom);
    const retainedMessageIds = new Set(retainedMessages.map(message => message.id));
    const retainedRequests = current.requests.filter(request => Date.parse(request.originalRequestedAt) >= retainedFrom && retainedMessageIds.has(request.originalMessageId));
    const retainedRequestIds = new Set(retainedRequests.map(request => request.id));
    const retainedGrants = current.remoteGrants.filter(grant => Date.parse(grant.originalRequestedAt) >= retainedFrom && Date.parse(grant.expiresAt) > at.getTime());
    const expiredRequestIds = current.requests.filter(request => !retainedRequestIds.has(request.id)).map(request => request.id);
    const generation = current.retention.generation + 1;
    const sendableCalls = current.providerCalls.filter(call => call.hangup.state !== 'dispatching');
    const claimedCalls = current.providerCalls.map(call => ({
      ...call,
      hangup: call.hangup.state === 'dispatching' ? call.hangup : {
        state: 'dispatching' as const,
        attemptId: call.hangup.state === 'prepared' ? call.hangup.attemptId : randomUUID(),
        attemptedAt: at.toISOString(),
        definitelyNotSentRetries: call.hangup.definitelyNotSentRetries
      }
    }));
    const fenced: DavoStateV1 = {
      ...clone(current),
      retention: {
        generation,
        lastCompletedSweepDate: window.sweepDate,
        retainedFrom: window.retainedFrom,
        contextRevision: randomUUID()
      },
      messages: retainedMessages,
      requests: retainedRequests.map(request => ({ ...request, admittedGeneration: generation, evaluation: undefined })),
      operations: current.operations
        .filter(operation => Date.parse(operation.expiresAt) > at.getTime() && (retainedRequestIds.has(operation.requestId) || retainedGrants.some(grant => grant.requestId === operation.requestId && grant.destinationInstanceId === operation.destinationInstanceId)))
        .map(operation => {
          const request = retainedRequests.find(candidate => candidate.id === operation.requestId);
          // advance local authority and the exact current remote dispatch only
          return request !== undefined && (operation.destinationInstanceId === request.principal.originInstanceId || operation.operationId === request.dispatch.operationId)
            ? { ...operation, generation }
            : operation;
        }),
      remoteGrants: retainedGrants,
      notificationOutbox: current.notificationOutbox.filter(notification => retainedRequestIds.has(notification.requestId)),
      providerCalls: claimedCalls
    };
    this.generationFence = generation;
    const fence: DavoGenerationFence = {
      previousGeneration: current.retention.generation,
      generation,
      sweepDate: window.sweepDate,
      retainedFrom: window.retainedFrom,
      expiredRequestIds,
      providerCalls: clone(claimedCalls.filter(call => sendableCalls.some(sendable => sendable.callId === call.callId)))
    };
    try {
      // erase expired content and persist exact in-flight hangup claims first
      const parsedFence = parseDavoState(fenced);
      await this.persist(parsedFence);
      this.state = parsedFence;
      let outcome: DavoGenerationFenceOutcome | void = undefined;
      try {
        // cross the provider boundary only after its claims are durable
        outcome = await this.onFence?.(clone(fence));
      } catch { /* every unproven effect remains ambiguous */ }
      const closed = new Set(outcome?.closedCallIds ?? []);
      const providerQuarantineUntil = claimedCalls
        .filter(call => current.providerCalls.some(previous => previous.callId === call.callId && previous.hangup.state === 'dispatching') || !closed.has(call.callId))
        .reduce<string | undefined>((latest, call) => latest === undefined || Date.parse(call.providerMaximumEndsAt) > Date.parse(latest) ? call.providerMaximumEndsAt : latest, current.providerQuarantineUntil);
      const sanitized = { ...parsedFence, providerCalls: [] };
      // retain only a content-free fence for unproven effects
      if (providerQuarantineUntil === undefined) delete sanitized.providerQuarantineUntil;
      else sanitized.providerQuarantineUntil = providerQuarantineUntil;
      const parsedFinal = parseDavoState(sanitized);
      await this.persist(parsedFinal);
      this.state = parsedFinal;
    } catch (error) {
      this.unavailable = true;
      // preserve safe store failures
      if (error instanceof DavoStoreError) throw error;
      throw new DavoStoreError('davo_store_unavailable');
    }
    return { swept: true, ...fence };
  }

  // enforce the current retention window
  async ensureCurrent(at: Date = this.now()): Promise<DavoEnsureCurrentResult> {
    return this.serialize(async () => this.ensureCurrentLoaded(new Date(at.getTime())));
  }

  // return one detached current snapshot
  async read(): Promise<DavoStateV1> {
    return this.serialize(async () => {
      await this.ensureCurrentLoaded(this.now());
      const value = await this.load();
      return clone(value);
    });
  }

  // apply one synchronous pure atomic mutation
  async transact<T>(mutation: (state: DavoStateV1) => T): Promise<T> {
    return this.serialize(async () => {
      await this.ensureCurrentLoaded(this.now());
      const current = await this.load();
      const candidate = clone(current);
      const result = mutation(candidate);
      // prevent effects from escaping the mutation frontier
      if (isPromiseLike(result)) throw new TypeError('davo transactions must be synchronous');
      // classify quota errors without partial writes
      if (exceedsCapacity(candidate)) throw new DavoStoreError('davo_capacity');
      const parsed = davoStateSchema.safeParse(candidate);
      // reject malformed explicit state
      if (!parsed.success) throw new DavoStoreError('davo_store_invalid');
      await this.persist(parsed.data);
      this.state = parsed.data;
      this.generationFence = parsed.data.retention.generation;
      return clone(result);
    });
  }

  // commit one final transcript while returning its exact ambiguous receipt
  private commitUserTranscript(mutation: (state: DavoStateV1) => DavoMessageV1): Promise<DavoMessageV1> {
    return this.serialize(async () => {
      await this.ensureCurrentLoaded(this.now());
      const current = await this.load();
      const candidate = clone(current);
      const result = mutation(candidate);
      // prevent effects from escaping the admission frontier
      if (isPromiseLike(result)) throw new TypeError('davo transactions must be synchronous');
      // classify quota errors without partial writes
      if (exceedsCapacity(candidate)) throw new DavoStoreError('davo_capacity');
      const parsed = davoStateSchema.safeParse(candidate);
      // reject malformed explicit state
      if (!parsed.success) throw new DavoStoreError('davo_store_invalid');
      const outcome = await this.persistAdmission(parsed.data);
      // pending admissions never release inference or tool authority
      if (outcome === 'pending') throw new DavoAdmissionPendingError(result.id);
      this.state = parsed.data;
      this.generationFence = parsed.data.retention.generation;
      return clone(result);
    });
  }

  // append one final transcript idempotently
  async appendUserTranscript(input: DavoAppendUserTranscriptInput): Promise<DavoMessageV1> {
    // reject oversized transcript input before mutation
    if (utf8Bytes(input.text) > DAVO_USER_TEXT_MAX_BYTES) throw new DavoStoreError('davo_capacity');
    return this.commitUserTranscript(state => {
      // run the final synchronous authority check at the commit frontier
      input.authorize?.();
      // bind runtime admissions to their exact retention generation
      if (input.generation !== undefined && input.generation !== state.retention.generation) throw new DavoStoreError('davo_store_invalid');
      const existing = state.messages.find(message => message.kind === 'user'
        && message.generation === state.retention.generation
        && message.source.providerSessionId === input.providerSessionId
        && message.source.providerItemId === input.providerItemId);
      // reconcile exact retries only
      if (existing !== undefined) {
        // preserve the transcript source contract
        if (existing.kind !== 'user') throw new DavoStoreError('davo_store_invalid');
        // reject key reuse with changed content
        if (existing.text !== input.text || existing.source.voiceSessionId !== input.voiceSessionId || existing.requestId !== input.requestId) {
          throw new DavoStoreError('davo_idempotency_conflict');
        }
        return existing;
      }
      const createdAt = input.createdAt ?? this.now().toISOString();
      const message: DavoMessageV1 = {
        sequence: state.nextSequence,
        id: input.id ?? randomUUID(),
        conversationId: state.logicalConversationId,
        generation: state.retention.generation,
        createdAt,
        localDate: localDateForInstant(createdAt),
        retentionAnchorAt: createdAt,
        retentionAnchorLocalDate: localDateForInstant(createdAt),
        kind: 'user',
        text: input.text,
        source: {
          kind: 'user-transcript',
          voiceSessionId: input.voiceSessionId,
          providerSessionId: input.providerSessionId,
          providerItemId: input.providerItemId
        },
        ...(input.requestId === undefined ? {} : { requestId: input.requestId })
      };
      state.messages.push(message);
      state.nextSequence += 1;
      return message;
    });
  }

  // append one validated retained message
  async appendMessage(input: DavoAppendMessageInput): Promise<DavoMessageV1> {
    return this.transact(state => {
      const createdAt = input.createdAt ?? this.now().toISOString();
      const anchorAt = input.kind === 'user' ? createdAt : input.retentionAnchorAt;
      const anchorDate = input.kind === 'user' ? localDateForInstant(createdAt) : input.retentionAnchorLocalDate;
      // require immutable anchors for every derivative
      if (anchorAt === undefined || anchorDate === undefined) throw new DavoStoreError('davo_store_invalid');
      const message = {
        sequence: state.nextSequence,
        id: input.id ?? randomUUID(),
        conversationId: state.logicalConversationId,
        generation: state.retention.generation,
        createdAt,
        localDate: localDateForInstant(createdAt),
        retentionAnchorAt: anchorAt,
        retentionAnchorLocalDate: anchorDate,
        kind: input.kind,
        text: input.text,
        source: input.source,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId })
      } as DavoMessageV1;
      const parsed = davoMessageSchema.safeParse(message);
      // reject cross-kind sources or oversized content
      if (!parsed.success) throw new DavoStoreError(utf8Bytes(input.text) > DAVO_USER_TEXT_MAX_BYTES ? 'davo_capacity' : 'davo_store_invalid');
      const existing = state.messages.find(candidate => {
        // match one provider assistant final
        if (parsed.data.kind === 'assistant' && parsed.data.source.kind === 'assistant-final') {
          return candidate.kind === 'assistant'
            && candidate.generation === state.retention.generation
            && candidate.source.kind === 'assistant-final'
            && candidate.source.voiceSessionId === parsed.data.source.voiceSessionId
            && candidate.source.responseId === parsed.data.source.responseId
            && candidate.source.inReplyToMessageId === parsed.data.source.inReplyToMessageId;
        }
        // match one background response event
        if (parsed.data.kind === 'assistant' && parsed.data.source.kind === 'request-response') {
          return candidate.kind === 'assistant'
            && candidate.source.kind === 'request-response'
            && candidate.source.requestId === parsed.data.source.requestId
            && candidate.source.eventId === parsed.data.source.eventId;
        }
        // match one request status event
        if (parsed.data.kind === 'status' && parsed.data.source.kind === 'request-status') {
          return candidate.kind === 'status' && candidate.source.kind === 'request-status' && candidate.requestId === parsed.data.requestId && candidate.source.statusKey === parsed.data.source.statusKey;
        }
        // match one mcp activity correlation
        if (parsed.data.kind === 'status' && parsed.data.source.kind === 'mcp-activity') {
          return candidate.kind === 'status' && candidate.source.kind === 'mcp-activity' && candidate.source.correlationId === parsed.data.source.correlationId;
        }
        return false;
      });
      // reconcile only byte-equivalent message retries
      if (existing !== undefined) {
        const comparable = { ...parsed.data, id: existing.id, sequence: existing.sequence, createdAt: existing.createdAt, localDate: existing.localDate };
        // reject a semantic idempotency conflict
        if (JSON.stringify(existing) !== JSON.stringify(comparable)) throw new DavoStoreError('davo_idempotency_conflict');
        return existing;
      }
      state.messages.push(parsed.data);
      state.nextSequence += 1;
      return parsed.data;
    });
  }
}
