import { z } from 'zod';
import { normalizeCalendarLabels } from './agent-labels.js';
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ManagedPromptLifecycleV1, CompletionBaseline } from '../adapters/types.js';
import { queueReadyPrompt } from '../adapters/codex-turns.js';
import { readBounded, writePrivate } from '../settings/files.js';
import { run, tmuxBinary } from '../tmux/command.js';
import type { CalendarCaptureSink, CalendarLabels } from './contracts.js';

export type PromptLifecycleAdmission = { id: string; agentId: string; kind: string; submittedAt: string };
export type PromptLifecycleIntent = PromptLifecycleAdmission & {
  prompt: string;
  baseline?: CompletionBaseline;
  socketFingerprint: string;
  socketPath: string;
  paneId: string;
  processId?: number;
  sentAt: string;
};

export type PromptCalendarLifecycle = {
  admit(input: PromptLifecycleAdmission): Promise<void>;
  beforeSend(input: PromptLifecycleIntent): Promise<{ arm?: string }>;
  observe(id: string, capability: ManagedPromptLifecycleV1 | undefined): Promise<void>;
  pending(): Promise<Array<{ id: string; agentId: string; kind: string }>>;
  handOver(fromAgentId: string, toAgentId: string): Promise<void>;
  missing(id: string): Promise<void>;
  invalid(id: string, reason: string): Promise<void>;
};

export type ClaudeLifecycleContract = { cliVersion: string; payloadContract: string };
export type GoogleCalendarLifecycleOptions = {
  sink: CalendarCaptureSink;
  labels(agentId: string): Promise<CalendarLabels>;
  claudeCompatibility?: () => ClaudeLifecycleContract | undefined;
  claudeSpoolFile?: string;
  file?: string;
  now?: () => Date;
};

// bound private scalars without accepting control bytes or coercing untrusted values
const storedText = (maximum: number) => z.string().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f]+$/u);
// permit supplementary unicode while enforcing the display-scalar bound
const storedLabel = storedText(160).refine(value => [...value].length <= 80);
// require finite positive instants without inventing ordering from wall-clock values
const storedTime = storedText(64).refine(value => Number.isFinite(Date.parse(value)) && Date.parse(value) > 0);
const storedOrdinal = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const storedHash = z.string().regex(/^[a-f0-9]{64}$/u);
// accept only the two supported completion checkpoints and closed reset identities
const storedBaseline = z.union([
  z.object({ rollout: storedText(4096), ordinal: storedOrdinal, resetPane: z.object({ pid: storedOrdinal.positive(), cwd: storedText(4096).optional() }).strict().optional() }).strict(),
  z.object({ cwd: storedText(4096), resetAt: storedOrdinal, ordinal: storedOrdinal }).strict()
]);
// reject content-bearing fields and impossible native/managed evidence combinations on restore
const storedCorrelation = z.object({
  id: storedText(256), agentId: storedText(256), kind: storedText(64), submittedAt: storedTime,
  labels: z.object({ worktree: storedLabel, project: storedLabel.optional(), agent: storedLabel }).strict(),
  admitted: z.boolean(), terminal: z.boolean().optional(),
  promptFingerprint: storedHash.optional(), transportFingerprint: storedHash.optional(), processGeneration: storedHash.optional(),
  baseline: storedBaseline.optional(), source: z.enum(['codex-rollout', 'claude-hook']).optional(), parserVersion: z.literal(1).optional(),
  processId: storedOrdinal.positive().optional(), processStart: z.string().min(1).max(32).regex(/^\d+$/u).optional(),
  socketPath: storedText(4096).optional(), paneId: z.string().max(32).regex(/^%\d+$/u).optional(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{24}$/u).optional(), sentAt: storedTime.optional(),
  receiptSignalled: z.boolean().optional(), startSignalled: z.boolean().optional(), questionSignalled: z.boolean().optional(), receiptObserved: z.boolean().optional(),
  startedAt: storedTime.optional(), questionAt: storedTime.optional(), finishedAt: storedTime.optional(), missingSince: storedTime.optional(),
  invalidReason: storedText(256).optional(), receiptOrdinal: storedOrdinal.optional(), startOrdinal: storedOrdinal.optional(), terminalOrdinal: storedOrdinal.optional(), turnId: storedText(256).optional()
}).strict().superRefine((row, context) => {
  // keep rejection diagnostics independent of private persisted values
  const reject = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_lifecycle_record' });
  const intent = [row.promptFingerprint, row.transportFingerprint, row.processGeneration, row.source, row.parserVersion, row.socketPath, row.paneId];
  // admission-only rows cannot contain partial transport or native checkpoints
  if (row.sentAt === undefined) {
    // reject partial evidence without an admitted transport identity
    if ([...intent, row.baseline, row.processId, row.processStart, row.nonce, row.startedAt, row.questionAt, row.finishedAt, row.receiptOrdinal, row.startOrdinal, row.terminalOrdinal, row.turnId].some(value => value !== undefined) || row.receiptObserved || row.receiptSignalled || row.startSignalled || row.questionSignalled) reject();
    return;
  }
  // every dispatched intent needs a complete fingerprint and transport identity
  if (intent.some(value => value === undefined) || row.processStart !== undefined && row.processId === undefined) reject();
  // managed Claude evidence cannot contain a native rollout checkpoint
  if (row.source === 'claude-hook') {
    // bind each managed arm to its exact process and nonce
    if (row.kind !== 'claude' || row.nonce === undefined || row.processId === undefined || row.processStart === undefined || [row.baseline, row.receiptOrdinal, row.startOrdinal, row.terminalOrdinal, row.turnId].some(value => value !== undefined)) reject();
  } else {
    // native evidence requires its exact matching checkpoint before acknowledgement
    if (row.kind === 'claude' || row.nonce !== undefined || row.receiptObserved && (row.baseline === undefined || row.receiptOrdinal === undefined) || row.startedAt !== undefined && (row.startOrdinal === undefined || row.turnId === undefined) || row.finishedAt !== undefined && row.terminalOrdinal === undefined) reject();
    // preserve strictly ordered native checkpoint ordinals
    if (row.receiptOrdinal !== undefined && (row.baseline === undefined || row.receiptOrdinal <= row.baseline.ordinal) || row.startOrdinal !== undefined && (row.receiptOrdinal === undefined || row.startOrdinal <= row.receiptOrdinal) || row.terminalOrdinal !== undefined && (row.startOrdinal === undefined || row.terminalOrdinal <= row.startOrdinal)) reject();
  }
  // persisted acknowledgements must have the evidence that made them safe to send
  if (row.receiptSignalled && !row.receiptObserved || row.startSignalled && (row.startedAt === undefined || !row.receiptSignalled) || row.questionSignalled && (row.questionAt === undefined || !row.startSignalled) || row.finishedAt !== undefined && row.startedAt === undefined) reject();
});
type CorrelationRecord = z.infer<typeof storedCorrelation>;
// reject duplicate ownership before constructing a map or dropping terminal rows
const storedLifecycle = z.object({ version: z.literal(1), records: z.array(storedCorrelation).max(10_000) }).strict().refine(document => new Set(document.records.map(record => record.id)).size === document.records.length);
type LifecycleDocument = z.infer<typeof storedLifecycle>;
type ClaudeJournal = {
  activityId?: unknown;
  nonce?: unknown;
  processGeneration?: unknown;
  state?: unknown;
  startedAt?: unknown;
  firstQuestionAt?: unknown;
  finishedAt?: unknown;
  contaminatedAt?: unknown;
  recordedAt?: unknown;
  expiresAt?: unknown;
  process?: { pid?: unknown; start?: unknown };
};

const maximumLifecycleBytes = 32 * 1024 * 1024;
const maximumClaudeSpoolBytes = 8 * 1024 * 1024;
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');

class CaptureStoreError extends Error {}

// persist exact native correlation without prompt content or filesystem paths
export class GoogleCalendarLifecycle implements PromptCalendarLifecycle {
  private readonly file: string;
  private readonly claudeSpoolFile: string;
  private readonly now: () => Date;
  private mutation = Promise.resolve();
  private records?: Map<string, CorrelationRecord>;

  // bind the optional capture sink and private lifecycle store
  constructor(private readonly options: GoogleCalendarLifecycleOptions) {
    this.file = options.file ?? process.env.RAC_GOOGLE_CALENDAR_LIFECYCLE_FILE ?? '.data/google-calendar-lifecycle.json';
    this.claudeSpoolFile = options.claudeSpoolFile ?? process.env.RAC_GOOGLE_CALENDAR_CLAUDE_SPOOL_FILE ?? join(dirname(this.file), 'google-calendar-claude-lifecycle.jsonl');
    this.now = options.now ?? (() => new Date());
  }

  // snapshot safe labels and provider policy at durable queue admission
  async admit(input: PromptLifecycleAdmission): Promise<void> {
    let providerAdmitted = false;
    try {
      await this.serialize(async records => {
      // preserve one activity identity while allowing exact pre-start ownership handover
      const existing = records.get(input.id);
      if (existing !== undefined) {
        providerAdmitted = existing.admitted;
        if (existing.promptFingerprint === undefined && !existing.terminal && (existing.agentId !== input.agentId || existing.kind !== input.kind)) {
          records.set(input.id, { ...existing, agentId: input.agentId, kind: input.kind });
          await this.persist(records);
        }
        return;
      }
      const labels = normalizeCalendarLabels(await this.options.labels(input.agentId).catch(() => ({ worktree: 'Scratch', project: 'Scratch', agent: 'Agent' })), input.kind);
      const admitted = await this.options.sink.admit({ ...input, labels }).catch(() => false);
      // suppressions never occupy correlation storage
      if (!admitted) return;
      providerAdmitted = true;
      records.set(input.id, { ...input, labels, admitted: true });
      await this.persist(records);
      });
    } catch (error) {
      // compensate only a provider capture orphaned by local storage
      if (providerAdmitted && error instanceof CaptureStoreError) await this.compensate(input.id);
    }
  }

  // durably pin intent before submit keys; failure degrades capture only
  async beforeSend(input: PromptLifecycleIntent): Promise<{ arm?: string }> {
    try {
      return await this.serialize(async records => {
      const current = records.get(input.id);
      // unsupported adapters and unadmitted activities remain inert
      if (current === undefined || !current.admitted) return {};
      if (input.kind !== 'claude' && input.baseline === undefined) {
        await this.fail(records, current, 'unsupported_lifecycle_contract');
        return {};
      }
      const promptFingerprint = fingerprint(input.prompt);
      const transportFingerprint = fingerprint(queueReadyPrompt(input.prompt));
      const processStart = input.processId === undefined ? undefined : await this.processStart(input.processId);
      const processGeneration = fingerprint(`${input.socketFingerprint}\0${input.paneId}\0${input.processId ?? ''}\0${processStart ?? ''}`);
      const claudeContract = input.kind === 'claude' ? this.options.claudeCompatibility?.() : undefined;
      const nonce = input.kind === 'claude' && claudeContract !== undefined && input.processId !== undefined && processStart !== undefined ? randomBytes(18).toString('base64url') : undefined;
      // no installed Claude version/payload fixture means production stays visibly unsupported
      if (input.kind === 'claude' && (claudeContract === undefined || nonce === undefined || input.processId === undefined || processStart === undefined)) {
        await this.fail(records, current, 'unsupported_lifecycle_contract');
        return {};
      }
      records.set(input.id, { ...current, agentId: input.agentId, kind: input.kind, promptFingerprint, transportFingerprint, ...(input.baseline === undefined ? {} : { baseline: structuredClone(input.baseline) }), processGeneration, source: input.kind === 'claude' ? 'claude-hook' : 'codex-rollout', parserVersion: 1, ...(input.processId === undefined ? {} : { processId: input.processId }), ...(processStart === undefined ? {} : { processStart }), socketPath: input.socketPath, paneId: input.paneId, ...(nonce === undefined ? {} : { nonce }), sentAt: input.sentAt });
      await this.persist(records);
      if (input.kind !== 'claude') return {};
      const arm = { v: 1, state: 'armed', activityId: input.id, nonce, promptFingerprint, paneId: input.paneId, processGeneration, contract: claudeContract, process: { pid: input.processId, start: processStart }, armedAt: input.sentAt, expiresAt: new Date(Date.parse(input.sentAt) + 30_000).toISOString() };
      return { arm: Buffer.from(JSON.stringify(arm)).toString('base64url') };
      });
    } catch (error) {
      // pre-key storage failures invalidate the exact admitted provider capture
      if (error instanceof CaptureStoreError) await this.compensate(input.id);
      return {};
    }
  }

  // reconcile only versioned exact native evidence
  async observe(id: string, capability: ManagedPromptLifecycleV1 | undefined): Promise<void> {
    await this.serialize(async records => {
      const current = records.get(id);
      // missing capabilities are explicit and never approximated from polling
      if (current === undefined || !current.admitted || current.terminal) return;
      if (current.invalidReason !== undefined) {
        await this.fail(records, current, current.invalidReason);
        return;
      }
      // retry persisted native evidence before touching a possibly truncated source tail
      await this.deliver(records, current);
      if (current.terminal || current.finishedAt !== undefined) return;
      if (current.kind === 'claude') {
        await this.observeClaude(records, current);
        return;
      }
      if (capability?.version !== 1 || !capability.compatible() || current.baseline === undefined || current.promptFingerprint === undefined || current.transportFingerprint === undefined) {
        await this.fail(records, current, 'unsupported_lifecycle_contract');
        return;
      }
      const evidence = await capability.inspect(current.baseline, { fingerprint: current.promptFingerprint, transportFingerprint: current.transportFingerprint }, {
        ...(current.receiptOrdinal === undefined ? {} : { receiptOrdinal: current.receiptOrdinal }),
        ...(current.startOrdinal === undefined ? {} : { startOrdinal: current.startOrdinal }),
        ...(current.turnId === undefined ? {} : { turnId: current.turnId }),
        ...(current.startedAt === undefined ? {} : { startedAt: current.startedAt })
      }).catch(() => ({ state: 'invalid' as const, reason: 'missing_lifecycle_evidence' as const }));
      // preserve native evidence before any optional-provider signal attempt
      if (evidence.state === 'invalid') {
        current.invalidReason = evidence.reason;
        await this.persist(records);
        await this.fail(records, current, evidence.reason);
        return;
      }
      const next = structuredClone(current);
      if (evidence.receiptOrdinal !== undefined) { next.receiptObserved = true; next.receiptOrdinal = evidence.receiptOrdinal; }
      if (evidence.startOrdinal !== undefined) next.startOrdinal = evidence.startOrdinal;
      if (evidence.turnId !== undefined) next.turnId = evidence.turnId;
      if (evidence.startedAt !== undefined) next.startedAt = evidence.startedAt;
      if (evidence.state === 'finished') { next.terminalOrdinal = evidence.terminalOrdinal; next.finishedAt = evidence.finishedAt; }
      // reject only this activity before malformed evidence can enter the durable document
      if (!storedCorrelation.safeParse(next).success) {
        await this.fail(records, current, 'missing_lifecycle_evidence');
        return;
      }
      Object.assign(current, next);
      const liveProcessStart = current.processId === undefined ? undefined : await this.processStart(current.processId);
      // a successful inspection on the exact live generation cancels absence aging
      if (current.processId !== undefined && liveProcessStart === current.processStart) current.missingSince = undefined;
      await this.persist(records);
      if (evidence.state === 'pending' && current.processId !== undefined && liveProcessStart !== current.processStart) {
        await this.markMissing(records, current);
        return;
      }
      await this.deliver(records, current);
    }).catch(() => undefined);
  }

  // list dispatched durable correlations independently of process-local prompt phases
  async pending(): Promise<Array<{ id: string; agentId: string; kind: string }>> {
    return await this.serialize(async records => [...records.values()]
      .filter(record => record.admitted && (record.baseline !== undefined || record.nonce !== undefined || record.invalidReason !== undefined))
      .map(record => ({ id: record.id, agentId: record.agentId, kind: record.kind }))).catch(() => []);
  }

  // transfer only work that has not acquired a native dispatch generation
  async handOver(fromAgentId: string, toAgentId: string): Promise<void> {
    await this.serialize(async records => {
      let changed = false;
      // retain active correlations on their old exact process
      for (const [id, record] of records) {
        if (record.agentId !== fromAgentId || record.promptFingerprint !== undefined || record.terminal) continue;
        records.set(id, { ...record, agentId: toAgentId });
        changed = true;
      }
      if (changed) await this.persist(records);
    }).catch(() => undefined);
  }

  // record one absent owner without guessing a stop instant
  async missing(id: string): Promise<void> {
    await this.serialize(async records => {
      const current = records.get(id);
      if (current !== undefined && !current.terminal) await this.markMissing(records, current);
    }).catch(() => undefined);
  }

  // report bounded invalid evidence without affecting prompt execution
  async invalid(id: string, reason: string): Promise<void> {
    await this.serialize(async records => {
      const current = records.get(id);
      if (current !== undefined && !current.terminal) await this.fail(records, current, reason);
    }).catch(() => undefined);
  }

  // serialize one private state mutation
  private async serialize<T>(operation: (records: Map<string, CorrelationRecord>) => Promise<T>): Promise<T> {
    const result = this.mutation.then(async () => {
      const stored = await this.load();
      const working = new Map([...stored].map(([id, record]) => [id, structuredClone(record)]));
      return operation(working);
    });
    this.mutation = result.then(() => undefined, () => undefined);
    return await result;
  }

  // load one bounded versioned document
  private async load(): Promise<Map<string, CorrelationRecord>> {
    if (this.records !== undefined) return this.records;
    try {
      const raw = await readBounded(this.file, true, true, maximumLifecycleBytes);
      if (raw === undefined) return this.records = new Map();
      // validate the entire document before allowing any correlation or evidence lookup
      const parsed = storedLifecycle.parse(JSON.parse(raw));
      const retained = parsed.records.filter(record => record.admitted && !record.terminal);
      const loaded = new Map(retained.map(record => [record.id, record]));
      // migrate acknowledged and suppressed legacy rows out of bounded storage
      if (retained.length !== parsed.records.length) await this.writeRecords(loaded);
      return this.records = loaded;
    } catch (error) {
      throw error instanceof CaptureStoreError ? error : new CaptureStoreError('capture_store_unavailable', { cause: error });
    }
  }

  // atomically publish sanitized correlation state
  private async persist(records: Map<string, CorrelationRecord>): Promise<void> {
    try {
      await this.writeRecords(records);
      this.records = new Map([...records].map(([id, record]) => [id, structuredClone(record)]));
    } catch (error) {
      throw error instanceof CaptureStoreError ? error : new CaptureStoreError('capture_store_unavailable', { cause: error });
    }
  }

  // write one bounded private document without publishing an in-memory snapshot
  private async writeRecords(records: Map<string, CorrelationRecord>): Promise<void> {
    const document = storedLifecycle.parse({ version: 1, records: [...records.values()] } satisfies LifecycleDocument);
    const value = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(value) > maximumLifecycleBytes) throw new CaptureStoreError('capture_store_unavailable');
    await writePrivate(this.file, value);
  }

  // terminalize one invalid correlation exactly once
  private async fail(records: Map<string, CorrelationRecord>, current: CorrelationRecord, reason: string): Promise<void> {
    current.invalidReason = reason;
    records.set(current.id, current);
    await this.persist(records);
    await this.clearClaudeArm(current);
    await this.options.sink.signal({ id: current.id, type: 'invalid', reason });
    await this.compactClaudeSpool(current);
    // prune only after the provider durably acknowledges terminal evidence
    records.delete(current.id);
    await this.persist(records);
  }

  // advance provider state only after each durable sink acknowledgement
  private async deliver(records: Map<string, CorrelationRecord>, current: CorrelationRecord): Promise<void> {
    if (current.receiptObserved && !current.receiptSignalled) {
      await this.options.sink.signal({ id: current.id, type: 'sent', at: current.sentAt });
      current.receiptSignalled = true;
      await this.persist(records);
    }
    if (current.startedAt !== undefined && !current.startSignalled) {
      const labels = normalizeCalendarLabels(await this.options.labels(current.agentId).catch(() => current.labels), current.kind);
      current.labels = labels;
      await this.persist(records);
      await this.options.sink.signal({ id: current.id, type: 'started', at: current.startedAt, labels });
      current.startSignalled = true;
      await this.persist(records);
    }
    // a recorded question cannot outrun the durable start acknowledgement
    if (current.startSignalled && current.questionAt !== undefined && !current.questionSignalled) {
      await this.options.sink.signal({ id: current.id, type: 'question', at: current.questionAt });
      current.questionSignalled = true;
      await this.persist(records);
    }
    if (current.finishedAt !== undefined && !current.terminal) {
      await this.options.sink.signal({ id: current.id, type: 'finished', at: current.finishedAt });
      await this.compactClaudeSpool(current);
      // acknowledged terminal captures no longer occupy correlation storage
      records.delete(current.id);
      await this.persist(records);
    }
  }

  // invalidate one provider capture after local correlation storage fails
  private async compensate(id: string): Promise<void> {
    await this.options.sink.signal({ id, type: 'invalid', reason: 'capture_store_unavailable' }).catch(() => undefined);
  }

  // remove acknowledged exact Claude records without discarding other pending evidence
  private async compactClaudeSpool(current: CorrelationRecord): Promise<void> {
    if (current.kind !== 'claude' || current.nonce === undefined || current.processGeneration === undefined) return;
    const lock = `${this.claudeSpoolFile}.lock`;
    let lockFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try { lockFile = await open(lock, 'wx', 0o600); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        const age = this.now().getTime() - await stat(lock).then(value => value.mtimeMs);
        // never remove a live producer lock
        if (age <= 5_000) throw new CaptureStoreError('capture_store_unavailable');
        await unlink(lock);
        lockFile = await open(lock, 'wx', 0o600);
      }
      const raw = await readBounded(this.claudeSpoolFile, true, true, maximumClaudeSpoolBytes);
      if (raw === undefined) return;
      const retained = raw.split('\n').filter(line => {
        if (line === '') return false;
        let candidate: ClaudeJournal;
        try { candidate = JSON.parse(line) as ClaudeJournal; } catch { return true; }
        return !this.exactClaudeJournal(candidate, current);
      });
      await writePrivate(this.claudeSpoolFile, retained.length === 0 ? '' : `${retained.join('\n')}\n`);
    } catch (error) {
      throw error instanceof CaptureStoreError ? error : new CaptureStoreError('capture_store_unavailable', { cause: error });
    } finally {
      // release only a lock acquired by this collector
      if (lockFile !== undefined) {
        await lockFile.close().catch(() => undefined);
        await unlink(lock).catch(() => undefined);
      }
    }
  }

  // read one Linux process start token for generation-safe Claude arms
  private async processStart(pid: number): Promise<string | undefined> {
    const root = process.env.RAC_HOST_PROC ?? '/proc';
    const raw = await readFile(`${root}/${pid}/stat`, 'utf8').catch(() => undefined);
    const close = raw?.lastIndexOf(')') ?? -1;
    if (close < 0) return undefined;
    const fields = raw!.slice(close + 2).split(' ');
    const start = fields[19];
    return start !== undefined && /^\d+$/u.test(start) && fields[0] !== 'Z' && fields[0] !== 'X' ? start : undefined;
  }

  // consume the durable spool and pane journal for the exact Claude generation
  private async observeClaude(records: Map<string, CorrelationRecord>, current: CorrelationRecord): Promise<void> {
    if (current.socketPath === undefined || current.paneId === undefined || current.nonce === undefined) return;
    const [spooled, pane] = await Promise.all([this.claudeSpoolJournal(current), this.claudePaneJournal(current)]);
    const candidates = [spooled, pane].filter((journal): journal is ClaudeJournal => journal !== undefined);
    const journal = candidates.sort((left, right) => this.claudeJournalTime(left) - this.claudeJournalTime(right)).at(-1);
    // stale or malformed journals cannot keep an old activity pending forever
    if (journal === undefined) {
      const arm = await this.claudePaneArm(current);
      const liveStart = current.processId === undefined ? undefined : await this.processStart(current.processId);
      const exactLiveProcess = liveStart !== undefined && liveStart === current.processStart;
      const unexpiredArm = arm?.state === 'armed' && typeof arm.expiresAt === 'string' && Date.parse(arm.expiresAt) >= this.now().getTime();
      // a still-live exact pre-submit arm remains within its bounded acceptance window
      if (exactLiveProcess && unexpiredArm) {
        await this.clearMissing(records, current);
        return;
      }
      await this.markMissing(records, current);
      return;
    }
    if (journal.state === 'invalid') { await this.fail(records, current, 'missing_lifecycle_evidence'); return; }
    const processStart = current.processId === undefined ? undefined : await this.processStart(current.processId);
    // only an exact terminal journal survives process exit or replacement
    if (journal.state !== 'terminal' && (processStart === undefined || processStart !== current.processStart)) {
      await this.markMissing(records, current);
      return;
    }
    if (typeof journal.startedAt === 'string') { current.receiptObserved = true; current.startedAt = journal.startedAt; }
    if (typeof journal.firstQuestionAt === 'string') current.questionAt = journal.firstQuestionAt;
    if (journal.state === 'terminal' && typeof journal.finishedAt === 'string') current.finishedAt = journal.finishedAt;
    await this.persist(records);
    // active evidence still requires the exact nonce authority in the live pane
    if (journal.state === 'active') {
      const activeArm = await this.claudePaneArm(current);
      if (activeArm?.state !== 'active') {
        await this.markMissing(records, current);
        return;
      }
    }
    // only terminal evidence or a validated live arm cancels absence aging
    await this.clearMissing(records, current);
    await this.deliver(records, current);
  }

  // read the last exact sanitized journal from the private host-visible spool
  private async claudeSpoolJournal(current: CorrelationRecord): Promise<ClaudeJournal | undefined> {
    const raw = await readBounded(this.claudeSpoolFile, true, true, maximumClaudeSpoolBytes).catch(() => undefined);
    // reject an unrotated or externally replaced spool rather than reading without bounds
    if (raw === undefined) return undefined;
    const lines = raw.trimEnd().split('\n');
    // scan newest-first for this opaque activity identity
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let candidate: ClaudeJournal;
      try { candidate = JSON.parse(lines[index]!) as ClaudeJournal; } catch { continue; }
      if (this.exactClaudeEvidence(candidate, current)) return candidate;
    }
    return undefined;
  }

  // read one exact pane journal without treating stale bytes as current evidence
  private async claudePaneJournal(current: CorrelationRecord): Promise<ClaudeJournal | undefined> {
    if (current.socketPath === undefined || current.paneId === undefined) return undefined;
    const binary = tmuxBinary();
    const shown = await run(binary, ['-S', current.socketPath, 'show-options', '-p', '-v', '-t', current.paneId, '@rac_calendar_journal']).catch(() => undefined);
    if (shown === undefined || shown.code !== 0 || shown.stdout.trim() === '') return undefined;
    try {
      const candidate = JSON.parse(Buffer.from(shown.stdout.trim(), 'base64url').toString('utf8')) as ClaudeJournal;
      return this.exactClaudeEvidence(candidate, current) ? candidate : undefined;
    } catch { return undefined; }
  }

  // read the current exact arm used to distinguish a live pre-submit wait from stale evidence
  private async claudePaneArm(current: CorrelationRecord): Promise<ClaudeJournal | undefined> {
    if (current.socketPath === undefined || current.paneId === undefined) return undefined;
    const binary = tmuxBinary();
    const shown = await run(binary, ['-S', current.socketPath, 'show-options', '-p', '-v', '-t', current.paneId, '@rac_calendar_arm']).catch(() => undefined);
    if (shown === undefined || shown.code !== 0 || shown.stdout.trim() === '') return undefined;
    try {
      const candidate = JSON.parse(Buffer.from(shown.stdout.trim(), 'base64url').toString('utf8')) as ClaudeJournal;
      return this.exactClaudeJournal(candidate, current) && (candidate.state === 'armed' || candidate.state === 'active') ? candidate : undefined;
    } catch { return undefined; }
  }

  // require all opaque correlation keys before accepting hook bytes
  private exactClaudeJournal(journal: ClaudeJournal, current: CorrelationRecord): boolean {
    return journal.activityId === current.id && journal.nonce === current.nonce && journal.processGeneration === current.processGeneration;
  }

  // accept only finite timestamped states emitted by the pinned helper protocol
  private exactClaudeEvidence(journal: ClaudeJournal, current: CorrelationRecord): boolean {
    if (!this.exactClaudeJournal(journal, current)) return false;
    if (journal.state === 'invalid') return this.validClaudeTime(journal.contaminatedAt) || this.validClaudeTime(journal.recordedAt);
    if (!this.validClaudeTime(journal.startedAt)) return false;
    // an optional question uses the same persisted instant predicate in either state
    if (journal.firstQuestionAt !== undefined && (!this.validClaudeTime(journal.firstQuestionAt) || Date.parse(journal.firstQuestionAt) < Date.parse(journal.startedAt))) return false;
    if (journal.state === 'active') return true;
    return journal.state === 'terminal' && this.validClaudeTime(journal.finishedAt) && Date.parse(journal.finishedAt) >= Date.parse(journal.startedAt);
  }

  // recognize one finite hook timestamp
  private validClaudeTime(value: unknown): value is string {
    return storedTime.safeParse(value).success;
  }

  // compare sanitized hook records by their latest lifecycle instant
  private claudeJournalTime(journal: ClaudeJournal): number {
    const value = journal.finishedAt ?? journal.firstQuestionAt ?? journal.startedAt ?? journal.contaminatedAt ?? journal.recordedAt;
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  }

  // cancel bounded absence aging after exact live evidence returns
  private async clearMissing(records: Map<string, CorrelationRecord>, current: CorrelationRecord): Promise<void> {
    if (current.missingSince === undefined) return;
    current.missingSince = undefined;
    await this.persist(records);
  }

  // bound native and managed process disappearance before declaring missing evidence
  private async markMissing(records: Map<string, CorrelationRecord>, current: CorrelationRecord): Promise<void> {
    const now = this.now();
    current.missingSince ??= now.toISOString();
    await this.persist(records);
    if (now.getTime() - Date.parse(current.missingSince) < 10 * 60_000) return;
    current.invalidReason = 'missing_lifecycle_evidence';
    await this.persist(records);
    await this.fail(records, current, current.invalidReason);
  }

  // clear only the exact Claude generation this activity armed
  private async clearClaudeArm(current: CorrelationRecord): Promise<void> {
    if (current.kind !== 'claude' || current.socketPath === undefined || current.paneId === undefined || current.nonce === undefined) return;
    const binary = tmuxBinary();
    const shown = await run(binary, ['-S', current.socketPath, 'show-options', '-p', '-v', '-t', current.paneId, '@rac_calendar_arm']).catch(() => undefined);
    if (shown === undefined || shown.code !== 0) return;
    let arm: { nonce?: unknown };
    try { arm = JSON.parse(Buffer.from(shown.stdout.trim(), 'base64url').toString('utf8')) as typeof arm; } catch { return; }
    if (arm.nonce === current.nonce) await run(binary, ['-S', current.socketPath, 'set-option', '-p', '-t', current.paneId, '-u', '@rac_calendar_arm']).catch(() => undefined);
  }
}
