import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AttentionState } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';
import { launchFresh, managedRunProgress, managedRunStartWindowMs, type ReadinessOutcome } from '../launch/managed-run.js';
import type { ReviewRunLaunch } from '../launch/service.js';
import { MAX_REVIEW_GENERATED_BYTES } from '../review-tour/contracts.js';
import { reviewRunsFor, type ReviewAgentKind } from './kinds.js';
import { reviewReplacedFlags } from './launch-args.js';
import { ReviewRunError, unavailable, type ReviewRunCapability, type ReviewRunner, type ReviewRunRequest } from './runner.js';

// What the console does for an interactive Review run, injected so the run's state machine is
// testable without tmux. `beginTurn` snapshots the Agent's transcript before a prompt and returns
// a reader for that turn's final message (undefined while there is none yet). `attention` is
// undefined once the Agent has gone. `release` hands a pane left open back to the operator.
export type InteractiveReviewHost = {
  capability(kind: ReviewAgentKind): Promise<ReviewRunCapability>;
  agentIds(): Promise<Set<string>>;
  launch(worktreeId: string, kind: ReviewAgentKind, launch: ReviewRunLaunch): Promise<boolean>;
  waitForAgent(before: Set<string>, runId: string): Promise<Agent | undefined>;
  waitForReadiness(agent: Agent): Promise<ReadinessOutcome>;
  // resolves `false` when the rename may be left unsent in the composer, so no prompt is pasted after it
  name(agentId: string, name: string): Promise<unknown>;
  beginTurn(agent: Agent, maxBytes: number): Promise<() => Promise<string | undefined>>;
  // the final message of the Agent's latest turn, for an orphaned run that has no pre-prompt snapshot
  latestReply(agent: Agent, maxBytes: number): Promise<string | undefined>;
  // how to finish an orphaned run from the `recovery` its request carried; undefined when it cannot be
  recover(recovery: unknown, agentId: string): Promise<OrphanRecovery | undefined>;
  submit(agentId: string, text: string): Promise<boolean>;
  attention(agentId: string): Promise<AttentionState | undefined>;
  close(agentId: string): Promise<unknown>;
  release(agentId: string): Promise<unknown>;
  delay(): Promise<void>;
};
// how an orphaned run's reply is checked and kept; `save` resolves whether the result was kept
export type OrphanRecovery = { validate?: (value: unknown) => string | undefined; save: (value: unknown) => Promise<boolean> };
// what a delivered run leaves beside its pane for the orphan sweep: when its prompt went in, when
// it times out, the bound on its reply and the request's `recovery`
type RecoveryRecord = { deliveredAt: number; deadline: number; maxBytes: number; recovery: object };

// `promptDirectory` holds the instructions of a run too long to paste (it must be readable by
// the Agent, outside the Worktree); `startWindowMs` and `now` are test seams
export type InteractiveReviewOptions = { promptDirectory: string; startWindowMs?: number; now?: () => number };

// the longest prompt pasted into the composer; the console refuses prompts over 32,000 characters
const maxPastedPrompt = 30_000;
// a line longer than this is cut short by Claude's Read tool, so long JSON is re-laid for the file
const maxReadableLine = 2_000;
// reads of a finished turn's final message before it counts as missing: a transcript can trail the idle report
const harvestAttempts = 20;
// a run id as `@rac_review_run` holds it, checked before it names a file
const runIdPattern = /^[A-Za-z0-9_-]{8,64}$/u;

// the instruction appended to every interactive run's prompt (ADR 0010)
export function replyInstruction(schema: object): string {
  return `When you are done, reply with ONLY one JSON object matching this JSON Schema as your final message — no prose, no code fences:\n${JSON.stringify(schema)}`;
}

// the one correction prompt a reply that failed validation gets
export function correctionPrompt(error: string): string {
  return `Your final message failed validation: ${error}. Reply again with only the corrected JSON object.`;
}

// Re-lay each over-long JSON line of a prompt so Claude's Read tool sees all of it: indented,
// with every multi-line string (a patch) split into an array of its lines.
export function readablePrompt(prompt: string): string {
  let relaid = false;
  const lines = prompt.split('\n').map(line => {
    if (line.length <= maxReadableLine || !/^[[{]/u.test(line)) return line;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return line; }
    relaid = true;
    return JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' && item.includes('\n') ? item.split('\n') : item, 1);
  });
  return relaid ? `${lines.join('\n')}\n\n(Long JSON above is indented, and each multi-line string in it is given as an array of its lines.)` : prompt;
}

// the outermost `{…}` of a reply, so code fences or prose around the object are tolerated
export function replyObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start < 0 || end <= start ? undefined : text.slice(start, end + 1);
}

// Parse and validate one final message: the outermost object, within the byte bound, as JSON
// the caller's validation accepts. A failure carries the error the correction prompt quotes.
export function parseReply(text: string | undefined, maxBytes: number, validate?: (value: unknown) => string | undefined): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text === undefined) return { ok: false, error: 'no final message was found' };
  const object = replyObject(text);
  if (object === undefined) return { ok: false, error: 'the reply holds no JSON object' };
  if (Buffer.byteLength(object) > maxBytes) return { ok: false, error: `the JSON object is longer than ${maxBytes} bytes` };
  let value: unknown;
  try { value = JSON.parse(object); } catch (error) { return { ok: false, error: `the reply is not valid JSON (${error instanceof Error ? error.message : 'parse error'})` }; }
  const problem = validate?.(value);
  return problem === undefined ? { ok: true, value } : { ok: false, error: problem };
}

type WatchEnd = 'finished' | 'vanished' | 'timed-out' | 'cancelled';

// Runs a Review run as a fresh, visible Agent in the Worktree's Workspace (ADR 0010): launch it
// with the run's read-only arguments, deliver the prompt, watch it to idle, read its final
// message from its transcript and validate it. One failed validation earns one correction prompt
// in the same conversation. Success closes the pane; a question keeps the run waiting with its
// pane open; a timeout or a second failed validation leaves the pane open for the operator.
// Cancellation closes the pane. A run a server restart orphans is finished by the orphan sweep
// when its request carried a `recovery`; otherwise its pane is handed back to the operator.
export class InteractiveReviewRunner implements ReviewRunner {
  private readonly now: () => number;
  private readonly startWindowMs: number;
  // the ids of the runs in flight here, and the Agents an orphan sweep is finishing or handing back
  private readonly live = new Set<string>();
  private readonly releasing = new Set<string>();

  constructor(private readonly host: InteractiveReviewHost, private readonly options: InteractiveReviewOptions) {
    this.now = options.now ?? Date.now;
    this.startWindowMs = options.startWindowMs ?? managedRunStartWindowMs;
  }

  // Settle every listed Agent marked for a Review run not in flight here (one a server restart
  // orphaned, or one whose close failed). One whose run left a recovery is finished from it; the
  // rest are handed back through the release a run that gives up uses: each becomes an ordinary
  // Agent the operator can see, answer, close and be notified by. Never closed unless finished,
  // since the operator may be mid-answer in it.
  async releaseOrphans(agents: readonly Agent[]): Promise<void> {
    const orphans = agents.filter(candidate => candidate.reviewRun !== undefined && !this.live.has(candidate.reviewRun) && !this.releasing.has(candidate.id));
    await Promise.all(orphans.map(async orphan => {
      this.releasing.add(orphan.id);
      try { await this.settleOrphan(orphan, orphan.reviewRun!); } catch { /* the next sweep retries */ } finally { this.releasing.delete(orphan.id); }
    }));
  }

  // Finish one orphan as its run would have: watch it to the end of its turn, then keep a reply
  // that validates and close the pane. No recovery, a question (nothing surfaces it now), the
  // deadline or a reply that fails hands the pane back instead. No correction prompt is sent.
  private async settleOrphan(orphan: Agent, runId: string): Promise<void> {
    const left = await this.readRecovery(runId);
    const recovery = left === undefined ? undefined : await this.host.recover(left.recovery, orphan.id).catch(() => undefined);
    if (left !== undefined && recovery !== undefined) {
      const asked = new AbortController();
      const end = await this.watch(orphan.id, asked.signal, left.deadline, left.deliveredAt, needsInput => { if (needsInput) asked.abort(); });
      if (end === 'vanished') { await this.forget(runId); return; }
      const reply = end === 'finished' ? parseReply(await this.harvest(() => this.host.latestReply(orphan, left.maxBytes), asked.signal), left.maxBytes, recovery.validate) : undefined;
      if (reply?.ok === true && await recovery.save(reply.value)) {
        await this.host.close(orphan.id).catch(() => undefined);
        await this.forget(runId, true);
        return;
      }
    }
    await this.host.release(orphan.id);
    await this.forget(runId);
  }

  // the kind's adapter is configured and runnable; no login probe
  async capability(kind: ReviewAgentKind): Promise<ReviewRunCapability> { return await this.host.capability(kind); }

  // run one interactive Review run to a validated result
  async run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown> {
    const refused = unavailable(await this.host.capability(request.kind));
    if (refused !== undefined) throw refused;
    if (signal.aborted) throw new ReviewRunError('cancelled', true);
    const runId = randomBytes(12).toString('base64url');
    const maxBytes = request.maxOutputBytes ?? MAX_REVIEW_GENERATED_BYTES;
    const { text, file } = await this.composePrompt(runId, request);
    const settings = { ...(request.model === undefined ? {} : { model: request.model }), ...(request.effort === undefined ? {} : { effort: request.effort }) };
    const { interactive } = reviewRunsFor(request.kind);
    let agent: Agent | undefined;
    let read: (() => Promise<string | undefined>) | undefined;
    let keepFile = false;
    // close the pane on success or cancellation; hand it to the operator when the run gives up
    const close = async (id: string) => { await this.host.close(id).catch(() => undefined); };
    const giveUp = async (id: string, code: 'timed_out' | 'malformed_result'): Promise<never> => { keepFile = true; await this.host.release(id).catch(() => undefined); throw new ReviewRunError(code, true); };
    // in flight from before its pane can exist, so an orphan sweep never takes it
    this.live.add(runId);
    try {
      const launched = await launchFresh({
        agentIds: () => this.host.agentIds(),
        launch: () => this.host.launch(request.worktreeId, request.kind, { runId, label: request.label, extraArgs: interactive.args({ ...settings, readDirectory: this.options.promptDirectory }), replacedFlags: reviewReplacedFlags(interactive, settings) }),
        waitForNewAgent: before => this.host.waitForAgent(before, runId),
        waitForReadiness: candidate => this.host.waitForReadiness(candidate),
        close: id => this.host.close(id),
        // report the Agent, then name its conversation with the run (best-effort)
        prepare: async candidate => { agent = candidate; request.onStarted?.({ agentId: candidate.id }); return await this.host.name(candidate.id, request.label); },
        deliver: async candidate => { agent = candidate; read = await this.host.beginTurn(candidate, maxBytes); await this.keepRecovery(runId, request, maxBytes); return await this.host.submit(candidate.id, text); }
      });
      if (launched.status === 'failed') {
        // a ready pane the prompt never reached is of no use to the operator
        if (launched.agentId !== undefined) await close(launched.agentId);
        throw new ReviewRunError(signal.aborted ? 'cancelled' : 'generation_failed', true);
      }
      const ran = agent!;
      if (signal.aborted) { await close(ran.id); throw new ReviewRunError('cancelled', true); }
      // the timeout runs from delivery; the launch has its own bounded waits
      const deadline = this.now() + request.timeoutMs;
      for (let corrected = false; ; corrected = true) {
        const end = await this.watch(ran.id, signal, deadline, this.now(), request.onAttention);
        if (end === 'vanished') throw new ReviewRunError('generation_failed', true);
        if (end === 'timed-out') return await giveUp(ran.id, 'timed_out');
        const reply = end === 'cancelled' ? undefined : parseReply(await this.harvest(read!, signal), maxBytes, request.validate);
        if (reply === undefined || signal.aborted) { await close(ran.id); throw new ReviewRunError('cancelled', true); }
        if (reply.ok) { await close(ran.id); return reply.value; }
        // one correction prompt in the same conversation, then the pane is the operator's
        if (corrected) return await giveUp(ran.id, 'malformed_result');
        read = await this.host.beginTurn(ran, maxBytes);
        if (!await this.host.submit(ran.id, correctionPrompt(reply.error))) return await giveUp(ran.id, 'malformed_result');
      }
    } catch (error) {
      if (error instanceof ReviewRunError) throw error;
      // an unexpected failure closes the pane it opened
      if (agent !== undefined) await close(agent.id);
      throw new ReviewRunError(signal.aborted ? 'cancelled' : 'generation_failed', true);
    } finally {
      this.live.delete(runId);
      await this.forget(runId);
      if (file !== undefined && !keepFile) await unlink(file).catch(() => undefined);
    }
  }

  // Watch the Agent's attention until its turn finishes, it goes, the deadline passes or the run is
  // cancelled. A question keeps the run waiting (the operator answers in the pane) and is reported.
  // `started` is when the turn's prompt went in, which the start window runs from.
  private async watch(agentId: string, signal: AbortSignal, deadline: number, started: number, onAttention?: (needsInput: boolean) => void): Promise<WatchEnd> {
    let sawWorking = false;
    let needsInput = false;
    for (;;) {
      if (signal.aborted) return 'cancelled';
      if (this.now() >= deadline) return 'timed-out';
      const attention = await this.host.attention(agentId);
      if (attention === undefined) return 'vanished';
      const progress = managedRunProgress(attention, sawWorking, this.now() - started, this.startWindowMs);
      // report each change of waiting on the operator
      if ((progress === 'question') !== needsInput) { needsInput = !needsInput; onAttention?.(needsInput); }
      if (progress === 'working') sawWorking = true;
      if (progress === 'finished') return 'finished';
      await this.host.delay();
    }
  }

  // read a finished turn's final message, allowing the transcript a moment to catch up
  private async harvest(read: () => Promise<string | undefined>, signal: AbortSignal): Promise<string | undefined> {
    for (let attempt = 0; attempt < harvestAttempts && !signal.aborted; attempt += 1) {
      const text = await read().catch(() => undefined);
      if (text !== undefined) return text;
      await this.host.delay();
    }
    return undefined;
  }

  // the recovery record of one run, beside its prompt file
  private recoveryFile(runId: string): string { return join(this.options.promptDirectory, `${runId}.json`); }

  // Leave the request's recovery beside the pane as its prompt goes in (best-effort: without it an
  // orphaned run is only handed back). The deadline matches the one the run sets after delivery.
  private async keepRecovery(runId: string, request: ReviewRunRequest, maxBytes: number): Promise<void> {
    if (request.recovery === undefined) return;
    const record: RecoveryRecord = { deliveredAt: this.now(), deadline: this.now() + request.timeoutMs, maxBytes, recovery: request.recovery };
    try {
      await mkdir(this.options.promptDirectory, { recursive: true, mode: 0o700 });
      await writeFile(this.recoveryFile(runId), JSON.stringify(record), { mode: 0o600 });
    } catch { /* the run goes on, unrecoverable */ }
  }

  // the recovery an orphaned run left, undefined when there is none or it is unreadable
  private async readRecovery(runId: string): Promise<RecoveryRecord | undefined> {
    if (!runIdPattern.test(runId)) return undefined;
    try {
      const record = JSON.parse(await readFile(this.recoveryFile(runId), 'utf8')) as Partial<RecoveryRecord> | null;
      const valid = Number.isFinite(record?.deliveredAt) && Number.isFinite(record?.deadline) && Number.isSafeInteger(record?.maxBytes) && record!.maxBytes! > 0 && typeof record?.recovery === 'object' && record.recovery !== null;
      return valid ? record as RecoveryRecord : undefined;
    } catch { return undefined; }
  }

  // drop a settled run's recovery record and, once its result is kept, its prompt file
  private async forget(runId: string, withPrompt = false): Promise<void> {
    if (!runIdPattern.test(runId)) return;
    await unlink(this.recoveryFile(runId)).catch(() => undefined);
    if (withPrompt) await unlink(join(this.options.promptDirectory, `${runId}.md`)).catch(() => undefined);
  }

  // The prompt pasted into the composer: the run's prompt with the reply instruction, or, when that
  // is too long to paste, a pointer to a private file holding it (laid out for a reading tool).
  private async composePrompt(runId: string, request: ReviewRunRequest): Promise<{ text: string; file?: string }> {
    const full = `${request.prompt}\n\n${replyInstruction(request.schema)}`;
    if (full.length <= maxPastedPrompt) return { text: full };
    await mkdir(this.options.promptDirectory, { recursive: true, mode: 0o700 });
    const file = join(this.options.promptDirectory, `${runId}.md`);
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(`${readablePrompt(request.prompt)}\n\n${replyInstruction(request.schema)}\n`); } finally { await handle.close(); }
    return { text: `Read the review instructions in ${file} and follow them exactly. They are long: read all of them before you start. They end with the format your final message must use.`, file };
  }
}
