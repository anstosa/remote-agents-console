import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const pushDiagnosticStages = [
  'observation_started',
  'observation_settled',
  'generated',
  'send_started',
  'provider_pending',
  'provider_accepted',
  'provider_failed',
  'worker_received',
  'show_started',
  'show_succeeded',
  'show_failed',
  'receipt_reported',
  'page_resumed',
  'reconciled'
] as const;
export type PushDiagnosticStage = typeof pushDiagnosticStages[number];
export type PushDiagnosticRecord = {
  id: string;
  stage: PushDiagnosticStage;
  at: number;
  eventId?: string;
  eventEpoch?: string;
  eventSequence?: number;
  kind?: 'question' | 'finished' | 'review' | 'schedule' | 'conductor' | 'cleanup';
  endpointFingerprint?: string;
  status?: string;
  attempt?: number;
};

type PushDiagnosticsOptions = { file?: string; now?: () => number; maximumRecords?: number; retentionMs?: number };
type StoreOperation = 'parse' | 'read' | 'write';

const recordKeys = new Set(['id', 'stage', 'at', 'eventId', 'eventEpoch', 'eventSequence', 'kind', 'endpointFingerprint', 'status', 'attempt']);
const safeIdentifier = /^[A-Za-z0-9._:-]{1,128}$/u;
const statusClasses = new Set(['accepted', 'failed', 'native-fallback', 'network', 'newer_waiting', 'no-op', 'pending', 'request_active', 'settled', 'show-rejected', 'shown', 'shown-minimal']);
const endpointIdentity = /^[A-Za-z0-9_-]{12}$/u;
const eventKinds = new Set(['question', 'finished', 'review', 'schedule', 'conductor', 'cleanup']);
const receiptStages = new Set<PushDiagnosticStage>(['worker_received', 'show_started', 'show_succeeded', 'show_failed', 'page_resumed', 'reconciled']);
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;

// place diagnostics beside the private subscription snapshot
export function defaultPushDiagnosticsFile(subscriptionFile = process.env.RAC_PUSH_SUBSCRIPTIONS_FILE ?? '.data/push-subscriptions.json'): string {
  return join(dirname(subscriptionFile), 'push-diagnostics.json');
}

// retain a private bounded stage journal without affecting notification delivery
export class PushDiagnostics {
  private readonly file: string;
  private readonly now: () => number;
  private readonly maximumRecords: number;
  private readonly retentionMs: number;
  private storeOperations: Promise<void> = Promise.resolve();

  // configure deterministic bounds for production and focused tests
  constructor(options: PushDiagnosticsOptions = {}) {
    this.file = options.file ?? defaultPushDiagnosticsFile();
    this.now = options.now ?? (() => Date.now());
    this.maximumRecords = options.maximumRecords ?? 2_000;
    this.retentionMs = options.retentionMs ?? sevenDaysMs;
  }

  // validate one untrusted receipt record with an exact key allowlist
  validate(value: unknown): value is PushDiagnosticRecord {
    // require one plain record
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    // reject content-bearing or unknown fields rather than stripping them
    if (Object.keys(candidate).some(key => !recordKeys.has(key))) return false;
    // require the bounded base fields
    if (typeof candidate.id !== 'string' || !safeIdentifier.test(candidate.id)) return false;
    if (typeof candidate.stage !== 'string' || !(pushDiagnosticStages as readonly string[]).includes(candidate.stage)) return false;
    if (typeof candidate.at !== 'number' || !Number.isSafeInteger(candidate.at) || candidate.at <= 0) return false;
    // validate optional event correlation independently
    if (candidate.eventId !== undefined && (typeof candidate.eventId !== 'string' || !safeIdentifier.test(candidate.eventId))) return false;
    if (candidate.eventEpoch !== undefined && (typeof candidate.eventEpoch !== 'string' || candidate.eventEpoch.length < 16 || candidate.eventEpoch.length > 64 || /[\u0000-\u001f\u007f]/u.test(candidate.eventEpoch))) return false;
    if (candidate.eventSequence !== undefined && (typeof candidate.eventSequence !== 'number' || !Number.isSafeInteger(candidate.eventSequence) || candidate.eventSequence <= 0)) return false;
    if (candidate.kind !== undefined && (typeof candidate.kind !== 'string' || !eventKinds.has(candidate.kind))) return false;
    if (candidate.endpointFingerprint !== undefined && (typeof candidate.endpointFingerprint !== 'string' || !endpointIdentity.test(candidate.endpointFingerprint))) return false;
    if (candidate.status !== undefined && (typeof candidate.status !== 'string' || !statusClasses.has(candidate.status) && !/^http_[1-5]\d\d$/u.test(candidate.status))) return false;
    if (candidate.attempt !== undefined && (typeof candidate.attempt !== 'number' || !Number.isSafeInteger(candidate.attempt) || candidate.attempt <= 0 || candidate.attempt > 100)) return false;
    return true;
  }

  // append one trusted server stage using the same strict record contract
  async record(stage: PushDiagnosticStage, fields: Omit<PushDiagnosticRecord, 'id' | 'stage' | 'at'> = {}, at = this.now()): Promise<void> {
    const record = { id: randomUUID(), stage, at, ...fields };
    // reject programming mistakes before touching private storage
    if (!this.validate(record)) throw new Error('invalid push diagnostic record');
    await this.append([record]);
  }

  // append one bounded browser receipt batch atomically
  async receive(records: unknown): Promise<boolean> {
    // enforce the upload cap before validating individual records
    if (!Array.isArray(records) || records.length > 100 || records.some(record => !this.validate(record) || !receiptStages.has((record as PushDiagnosticRecord).stage))) return false;
    const reportedAt = this.now();
    const accepted = records as PushDiagnosticRecord[];
    const receipts = accepted.map(record => ({
      id: randomUUID(),
      stage: 'receipt_reported' as const,
      at: reportedAt,
      ...(record.eventId === undefined ? {} : { eventId: record.eventId }),
      ...(record.eventEpoch === undefined ? {} : { eventEpoch: record.eventEpoch }),
      ...(record.eventSequence === undefined ? {} : { eventSequence: record.eventSequence }),
      ...(record.kind === undefined ? {} : { kind: record.kind }),
      status: 'accepted'
    }));
    await this.append([...accepted, ...receipts]);
    return true;
  }

  // expose a private snapshot for tests and authenticated internal summaries
  async snapshot(): Promise<PushDiagnosticRecord[]> {
    const snapshot = this.storeOperations.then(async () => this.prune(await this.read()));
    // keep later writes usable after a failed read
    this.storeOperations = snapshot.then(() => {}, () => {});
    return await snapshot;
  }

  // serialize appends so concurrent receipts cannot lose records
  private async append(records: PushDiagnosticRecord[]): Promise<void> {
    const mutation = this.storeOperations.then(async () => {
      const current = await this.read();
      await this.write(this.prune([...current, ...records]));
    });
    // recover the journal queue after isolated storage failures
    this.storeOperations = mutation.then(() => {}, () => {});
    await mutation;
  }

  // apply age and insertion caps without interpreting client/server clock deltas
  private prune(records: PushDiagnosticRecord[]): PushDiagnosticRecord[] {
    const cutoff = this.now() - this.retentionMs;
    const retained = records.filter(record => record.at >= cutoff);
    return retained.slice(Math.max(0, retained.length - this.maximumRecords));
  }

  // read an absent journal as empty and fail closed on corruption
  private async read(): Promise<PushDiagnosticRecord[]> {
    let serialized: string;
    try {
      serialized = await readFile(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // only a missing journal represents an empty history
      if (code === 'ENOENT') return [];
      this.logStoreFailure('read', error);
      throw error;
    }
    try {
      const parsed = JSON.parse(serialized) as unknown;
      // reject malformed stored records without exposing their content
      if (!Array.isArray(parsed) || parsed.some(record => !this.validate(record))) throw new SyntaxError('invalid push diagnostic store');
      return parsed as PushDiagnosticRecord[];
    } catch (error) {
      this.logStoreFailure('parse', error);
      throw error;
    }
  }

  // replace the private journal atomically with restrictive permissions
  private async write(records: PushDiagnosticRecord[]): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const next = `${this.file}.next`;
      await writeFile(next, JSON.stringify(records), { mode: 0o600 });
      await rename(next, this.file);
    } catch (error) {
      this.logStoreFailure('write', error);
      throw error;
    }
  }

  // emit only the operation and bounded filesystem error class
  private logStoreFailure(operation: StoreOperation, error: unknown): void {
    const failure = error as NodeJS.ErrnoException;
    console.error('[push] diagnostic store failed', {
      code: typeof failure.code === 'string' ? failure.code : operation === 'parse' ? 'SyntaxError' : 'unknown',
      operation
    });
  }
}
