import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AttentionState } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';
import { launchFresh, managedRunProgress, managedRunStartWindowMs, type ReadinessOutcome } from '../launch/managed-run.js';
import type { ReviewRunLaunch } from '../launch/service.js';
import type { LaunchOutcome } from '../transports/transport.js';
import { MAX_REVIEW_GENERATED_BYTES } from '../review-tour/contracts.js';
import { conversationKey, isReviewAgentKind, reviewRunsFor, validConversationId, type ReviewAgentKind } from './kinds.js';
import { reviewReplacedFlags } from './launch-args.js';
import { ReviewRunError, unavailable, type ReviewRunCapability, type ReviewRunner, type ReviewRunReply, type ReviewRunRequest, type ReviewRunResult } from './runner.js';

// What the console does for an interactive Review run, injected so the run's state machine is
// testable without tmux. `beginTurn` snapshots the Agent's transcript before a prompt and returns
// a reader for that turn's final message (undefined while there is none yet). `attention` is
// undefined once the Agent has gone. `release` hands a pane left open back to the operator.
export type InteractiveReviewHost = {
  capability(kind: ReviewAgentKind): Promise<ReviewRunCapability>;
  // launch the run's Agent through its Transport, which answers with the Agent once it runs
  launch(worktreeId: string, kind: ReviewAgentKind, launch: ReviewRunLaunch): Promise<LaunchOutcome>;
  waitForReadiness(agent: Agent): Promise<ReadinessOutcome>;
  // resolves `false` when the rename may be left unsent in the composer, so no prompt is pasted after it
  name(agentId: string, name: string): Promise<unknown>;
  beginTurn(agent: Pick<Agent, 'id' | 'kind'>, maxBytes: number): Promise<() => Promise<string | undefined>>;
  // the final message of the Agent's latest turn, for an orphaned run that has no pre-prompt snapshot
  latestReply(agent: Agent, maxBytes: number): Promise<string | undefined>;
  // how to finish an orphaned run from the `recovery` its request carried; undefined when it cannot be
  recover(recovery: unknown, agentId: string): Promise<OrphanRecovery | undefined>;
  submit(agentId: string, text: string): Promise<boolean>;
  // the conversation the Agent reports (Claude's conversation id, Codex's thread id), once it has one
  conversationId(agentId: string): Promise<string | undefined>;
  attention(agentId: string): Promise<AttentionState | undefined>;
  close(agentId: string): Promise<unknown>;
  release(agentId: string): Promise<unknown>;
  delay(): Promise<void>;
};
// how an orphaned run's reply is checked and kept, with the conversation the pane reports; `save`
// resolves whether the result was kept
export type OrphanRecovery = { validate?: (value: unknown) => string | undefined; save: (value: unknown, conversation?: string) => Promise<boolean> };
// an Agent kept for a conversation's follow-up turns, which the orphan sweep takes back after a restart
type KeptRecord = { kind: ReviewAgentKind; worktreeId: string; conversation?: string };
// What a delivered run leaves beside its pane for the orphan sweep: when its prompt went in, when
// it times out, the bound on its reply and the request's `recovery`, or, for a run that keeps its
// Agent for follow-ups, what it is kept for.
type RecoveryRecord = { deliveredAt: number; deadline: number; maxBytes: number; recovery?: object; kept?: KeptRecord };
// an Agent kept for follow-up turns: closed after `keptIdleMs` without one, or once `closing` when a turn is in flight
type KeptAgent = { agentId: string; runId: string; record: KeptRecord & { conversation: string }; busy: boolean; closing?: true; idle?: NodeJS.Timeout };

// `promptDirectory` holds the instructions of a run too long to paste (it must be readable by
// the Agent, outside the Worktree); `startWindowMs`, `keptIdleMs` and `now` are test seams
export type InteractiveReviewOptions = { promptDirectory: string; startWindowMs?: number; keptIdleMs?: number; now?: () => number };

// the longest prompt pasted into the composer; the console refuses prompts over 32,000 characters
const maxPastedPrompt = 30_000;
// C0 and C1 control characters other than tab and newline, which a prompt is never pasted with
const pasteUnsafe = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u;
// a line longer than this is cut short by Claude's Read tool, so long JSON is re-laid for the file
const maxReadableLine = 2_000;
// reads of a finished turn's final message before it counts as missing: a transcript can trail the idle report
const harvestAttempts = 20;
// a run id as `@rac_review_run` holds it, checked before it names a file
const runIdPattern = /^[A-Za-z0-9_-]{8,64}$/u;
// how long an Agent kept for follow-up turns waits for the next one before it is closed
const keptIdleMs = 15 * 60 * 1_000;

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

// Read one final message as the reply the run asked for: Markdown text within the byte bound, or
// JSON (see `parseReply`).
export function readReply(text: string | undefined, maxBytes: number, reply: ReviewRunReply): { ok: true; value: unknown } | { ok: false; error: string } {
  if (reply.kind === 'json') return parseReply(text, maxBytes, reply.validate);
  if (text === undefined || text.trim() === '') return { ok: false, error: 'no final message was found' };
  return Buffer.byteLength(text) > maxBytes ? { ok: false, error: `the reply is longer than ${maxBytes} bytes` } : { ok: true, value: text };
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

// Runs a Review run as a visible Agent in the Worktree's Workspace (ADR 0010): launch it, fresh or
// resuming the request's conversation, with the run's read-only arguments, deliver the prompt, watch it
// to idle, read its final message from its transcript and validate it. One failed JSON validation
// earns one correction prompt in the same conversation. Success closes the pane, unless the run
// expects follow-ups: then the Agent is kept for its conversation's next turn, which is delivered to it,
// and closed once idle. A question keeps the run waiting with its pane open; a timeout or a second
// failed validation leaves the pane open for the operator. Cancellation closes the pane. A run a
// server restart orphans is finished by the orphan sweep when its request carried a `recovery`, a
// kept Agent is kept again, and any other pane is handed back to the operator.
export class InteractiveReviewRunner implements ReviewRunner {
  private readonly now: () => number;
  private readonly startWindowMs: number;
  private readonly keptIdleMs: number;
  // the ids of the runs in flight or kept here, and the Agents an orphan sweep is finishing or handing back
  private readonly live = new Set<string>();
  private readonly releasing = new Set<string>();
  // the Agents kept for follow-up turns, by kind and conversation
  private readonly kept = new Map<string, KeptAgent>();

  constructor(private readonly host: InteractiveReviewHost, private readonly options: InteractiveReviewOptions) {
    this.now = options.now ?? Date.now;
    this.startWindowMs = options.startWindowMs ?? managedRunStartWindowMs;
    this.keptIdleMs = options.keptIdleMs ?? keptIdleMs;
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
    if (left?.kept !== undefined) { await this.adoptOrphan(orphan, runId, left.kept); return; }
    const recovery = left?.recovery === undefined ? undefined : await this.host.recover(left.recovery, orphan.id).catch(() => undefined);
    if (left !== undefined && recovery !== undefined) {
      const asked = new AbortController();
      const end = await this.watch(orphan.id, asked.signal, left.deadline, left.deliveredAt, needsInput => { if (needsInput) asked.abort(); });
      if (end === 'vanished') { await this.forget(runId); return; }
      const reply = end === 'finished' ? parseReply(await this.harvest(() => this.host.latestReply(orphan, left.maxBytes), asked.signal), left.maxBytes, recovery.validate) : undefined;
      if (reply?.ok === true && await recovery.save(reply.value, await this.host.conversationId(orphan.id).catch(() => undefined))) {
        await this.host.close(orphan.id).catch(() => undefined);
        await this.forget(runId, true);
        return;
      }
    }
    await this.host.release(orphan.id);
    await this.forget(runId);
  }

  // Keep an orphaned kept Agent again once it is idle (its turn's answer is lost with its job), so
  // its conversation's next turn still goes to it; one asking a question is handed back, one at work is
  // left for the next sweep, and one with no conversation or whose conversation another Agent now holds is closed.
  private async adoptOrphan(orphan: Agent, runId: string, record: KeptRecord): Promise<void> {
    const attention = await this.host.attention(orphan.id);
    if (attention === undefined) { await this.forget(runId); return; }
    if (attention === 'working') return;
    if (attention === 'question') { await this.host.release(orphan.id); await this.forget(runId); return; }
    if (record.conversation === undefined || this.kept.has(conversationKey(record.kind, record.conversation))) { await this.closePane(orphan.id); await this.forget(runId); return; }
    this.keep({ agentId: orphan.id, runId, record: { ...record, conversation: record.conversation }, busy: false });
  }

  // the kind's adapter is configured and runnable; no login probe
  async capability(kind: ReviewAgentKind): Promise<ReviewRunCapability> { return await this.host.capability(kind); }

  // Run one interactive Review run to a validated reply: on the Agent kept for its conversation when there
  // is one, else on a newly launched one
  async run(request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult> {
    const refused = unavailable(await this.host.capability(request.kind));
    if (refused !== undefined) throw refused;
    if (signal.aborted) throw new ReviewRunError('cancelled', true);
    const kept = request.resume === undefined ? undefined : this.kept.get(conversationKey(request.kind, request.resume));
    if (kept !== undefined && !kept.busy) {
      // claimed before the check, so the idle close cannot take it meanwhile
      kept.busy = true;
      if (kept.idle !== undefined) clearTimeout(kept.idle);
      const attention = await this.host.attention(kept.agentId);
      if (attention === 'finished') return await this.runKept(kept, request, signal);
      if (attention !== undefined) {
        // the operator is using the pane; a prompt pasted now would land in their turn
        kept.busy = false;
        this.keep(kept);
        throw new ReviewRunError('agent_busy', true);
      }
      // the kept Agent has gone; relaunch the conversation
      await this.dropKept(kept, false);
    }
    return await this.runLaunched(request, signal);
  }

  // close what follow-up runs kept in one Worktree, each now or once its turn in flight ends
  async closeWorktree(worktreeId: string): Promise<void> {
    await Promise.all([...this.kept.values()].filter(kept => kept.record.worktreeId === worktreeId).map(async kept => {
      if (kept.busy) kept.closing = true;
      else await this.dropKept(kept, true);
    }));
  }

  // the kept Agents waiting for their next turn, which a Remove may close
  idleKeptAgents(): Set<string> {
    return new Set([...this.kept.values()].filter(kept => !kept.busy).map(kept => kept.agentId));
  }

  // launch the run's Agent, fresh or resuming its conversation, deliver the prompt and see the turn out
  private async runLaunched(request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult> {
    const runId = randomBytes(12).toString('base64url');
    const maxBytes = request.maxOutputBytes ?? MAX_REVIEW_GENERATED_BYTES;
    const { text, file } = await this.composePrompt(runId, request);
    const settings = { ...(request.model === undefined ? {} : { model: request.model }), ...(request.effort === undefined ? {} : { effort: request.effort }) };
    const { interactive } = reviewRunsFor(request.kind);
    let agent: Agent | undefined;
    let read: (() => Promise<string | undefined>) | undefined;
    let outcome: TurnOutcome = 'closed';
    // in flight from before its pane can exist, so an orphan sweep never takes it
    this.live.add(runId);
    try {
      const launched = await launchFresh({
        launch: () => this.host.launch(request.worktreeId, request.kind, { runId, label: request.label, extraArgs: interactive.args({ ...settings, readDirectory: this.options.promptDirectory }), replacedFlags: reviewReplacedFlags(interactive, settings), ...(request.resume === undefined ? {} : { conversationId: request.resume }) }),
        waitForReadiness: candidate => this.host.waitForReadiness(candidate),
        close: id => this.host.close(id),
        // report the Agent, then name a new conversation with the run (best-effort); a resumed one keeps its name
        prepare: async candidate => { agent = candidate; request.onStarted?.({ agentId: candidate.id }); return request.resume === undefined ? await this.host.name(candidate.id, request.label) : true; },
        deliver: async candidate => { agent = candidate; read = await this.host.beginTurn(candidate, maxBytes); await this.keepRecovery(runId, request, maxBytes); return await this.host.submit(candidate.id, text); }
      });
      if (launched.status === 'failed') {
        // a ready pane the prompt never reached is of no use to the operator
        if (launched.agentId !== undefined) await this.closePane(launched.agentId);
        throw new ReviewRunError(signal.aborted ? 'cancelled' : 'generation_failed', true);
      }
      const ran = agent!;
      if (signal.aborted) { await this.closePane(ran.id); throw new ReviewRunError('cancelled', true); }
      const turn = await this.seeTurn(ran, read!, request, signal, maxBytes);
      outcome = turn.outcome;
      if (!turn.ok) throw new ReviewRunError(turn.code, true);
      const conversation = request.resume ?? await this.host.conversationId(ran.id).catch(() => undefined);
      if (request.followUps === true && conversation !== undefined) {
        const record = { kind: request.kind, worktreeId: request.worktreeId, conversation };
        this.keep({ agentId: ran.id, runId, record, busy: false });
        outcome = 'kept';
        await this.writeRecord(runId, { deliveredAt: this.now(), deadline: this.now(), maxBytes, kept: record });
      } else await this.closePane(ran.id);
      return { value: turn.value, ...(conversation === undefined ? {} : { conversation }) };
    } catch (error) {
      if (error instanceof ReviewRunError) throw error;
      // an unexpected failure closes the pane it opened
      if (agent !== undefined) await this.closePane(agent.id);
      throw new ReviewRunError(signal.aborted ? 'cancelled' : 'generation_failed', true);
    } finally {
      if (outcome !== 'kept') { this.live.delete(runId); await this.forget(runId); }
      // a pane handed to the operator keeps the instructions it may still be reading
      if (file !== undefined && outcome !== 'released') await unlink(file).catch(() => undefined);
    }
  }

  // Deliver a follow-up turn to the Agent kept for its conversation and see it out. The Agent stays kept
  // unless the turn gives up, is cancelled or fails, or the conversation was closed meanwhile.
  private async runKept(kept: KeptAgent, request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult> {
    kept.busy = true;
    if (kept.idle !== undefined) clearTimeout(kept.idle);
    const maxBytes = request.maxOutputBytes ?? MAX_REVIEW_GENERATED_BYTES;
    const agent = { id: kept.agentId, kind: request.kind };
    let file: string | undefined;
    let outcome: TurnOutcome = 'closed';
    try {
      const prompt = await this.composePrompt(randomBytes(12).toString('base64url'), request);
      file = prompt.file;
      request.onStarted?.({ agentId: kept.agentId });
      const read = await this.host.beginTurn(agent, maxBytes);
      if (!await this.host.submit(kept.agentId, prompt.text)) throw new ReviewRunError('generation_failed', true);
      const turn = await this.seeTurn(agent, read, request, signal, maxBytes);
      outcome = turn.outcome;
      if (!turn.ok) throw new ReviewRunError(turn.code, true);
      outcome = kept.closing === true ? 'closed' : 'kept';
      return { value: turn.value, conversation: kept.record.conversation };
    } catch (error) {
      throw error instanceof ReviewRunError ? error : new ReviewRunError(signal.aborted ? 'cancelled' : 'generation_failed', true);
    } finally {
      kept.busy = false;
      if (outcome === 'kept') this.keep(kept);
      else await this.dropKept(kept, outcome === 'closed');
      if (file !== undefined && outcome !== 'released') await unlink(file).catch(() => undefined);
    }
  }

  // Watch one delivered turn to its reply. A failed JSON validation gets one correction prompt in the
  // same conversation; a timeout or a second failure hands the pane to the operator (`released`).
  // Cancellation closes the pane; a reply leaves it open for the caller to close or keep.
  private async seeTurn(agent: Pick<Agent, 'id' | 'kind'>, firstRead: () => Promise<string | undefined>, request: ReviewRunRequest, signal: AbortSignal, maxBytes: number): Promise<{ ok: true; value: unknown; outcome: 'open' } | { ok: false; code: 'generation_failed' | 'timed_out' | 'malformed_result' | 'cancelled'; outcome: TurnOutcome }> {
    let read = firstRead;
    const giveUp = async (code: 'timed_out' | 'malformed_result') => { await this.host.release(agent.id).catch(() => undefined); return { ok: false as const, code, outcome: 'released' as const }; };
    const cancel = async () => { await this.closePane(agent.id); return { ok: false as const, code: 'cancelled' as const, outcome: 'closed' as const }; };
    // the timeout runs from delivery; the launch has its own bounded waits
    const deadline = this.now() + request.timeoutMs;
    for (let corrected = false; ; corrected = true) {
      const end = await this.watch(agent.id, signal, deadline, this.now(), request.onAttention);
      if (end === 'vanished') return { ok: false, code: 'generation_failed', outcome: 'closed' };
      if (end === 'timed-out') return await giveUp('timed_out');
      if (end === 'cancelled') return await cancel();
      const reply = readReply(await this.harvest(read, signal), maxBytes, request.reply);
      if (signal.aborted) return await cancel();
      if (reply.ok) return { ok: true, value: reply.value, outcome: 'open' };
      // one correction prompt in the same conversation for JSON, then the pane is the operator's
      if (corrected || request.reply.kind === 'text') return await giveUp('malformed_result');
      read = await this.host.beginTurn(agent, maxBytes);
      if (!await this.host.submit(agent.id, correctionPrompt(reply.error))) return await giveUp('malformed_result');
    }
  }

  // keep an Agent for its conversation's next turn, closing it once idle that long
  private keep(kept: KeptAgent): void {
    this.kept.set(conversationKey(kept.record.kind, kept.record.conversation), kept);
    this.live.add(kept.runId);
    if (kept.idle !== undefined) clearTimeout(kept.idle);
    kept.idle = setTimeout(() => { if (!kept.busy) void this.dropKept(kept, true); }, this.keptIdleMs);
    kept.idle.unref?.();
  }

  // stop keeping an Agent, closing its pane when asked (one handed back or gone is left alone)
  private async dropKept(kept: KeptAgent, close: boolean): Promise<void> {
    if (kept.idle !== undefined) clearTimeout(kept.idle);
    const key = conversationKey(kept.record.kind, kept.record.conversation);
    if (this.kept.get(key) === kept) this.kept.delete(key);
    if (close) await this.closePane(kept.agentId);
    this.live.delete(kept.runId);
    await this.forget(kept.runId);
  }

  private async closePane(agentId: string): Promise<void> { await this.host.close(agentId).catch(() => undefined); }

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

  // Leave the request's recovery beside the pane as its prompt goes in, or what a follow-up run is
  // kept for (best-effort: without it an orphaned run is only handed back). The deadline matches
  // the one the run sets after delivery.
  private async keepRecovery(runId: string, request: ReviewRunRequest, maxBytes: number): Promise<void> {
    const kept = request.followUps === true ? { kind: request.kind, worktreeId: request.worktreeId, ...(request.resume === undefined ? {} : { conversation: request.resume }) } : undefined;
    if (request.recovery === undefined && kept === undefined) return;
    await this.writeRecord(runId, { deliveredAt: this.now(), deadline: this.now() + request.timeoutMs, maxBytes, ...(request.recovery === undefined ? {} : { recovery: request.recovery }), ...(kept === undefined ? {} : { kept }) });
  }

  private async writeRecord(runId: string, record: RecoveryRecord): Promise<void> {
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
      const timed = Number.isFinite(record?.deliveredAt) && Number.isFinite(record?.deadline) && Number.isSafeInteger(record?.maxBytes) && record!.maxBytes! > 0;
      const recovery = typeof record?.recovery === 'object' && record.recovery !== null ? record.recovery : undefined;
      const kept = validKept(record?.kept);
      return timed && (recovery !== undefined || kept !== undefined) ? { deliveredAt: record!.deliveredAt!, deadline: record!.deadline!, maxBytes: record!.maxBytes!, ...(recovery === undefined ? {} : { recovery }), ...(kept === undefined ? {} : { kept }) } : undefined;
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
    const instruction = request.reply.kind === 'json' ? `\n\n${replyInstruction(request.reply.schema)}` : '';
    const full = `${request.prompt}${instruction}`;
    // a control character (from a patch or a model's text) could end the paste early and type the rest as keys
    if (full.length <= maxPastedPrompt && !pasteUnsafe.test(full)) return { text: full };
    await mkdir(this.options.promptDirectory, { recursive: true, mode: 0o700 });
    const file = join(this.options.promptDirectory, `${runId}.md`);
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(`${readablePrompt(request.prompt)}${instruction}\n`); } finally { await handle.close(); }
    return { text: request.reply.kind === 'json' ? `Read the review instructions in ${file} and follow them exactly. They are long: read all of them before you start. They end with the format your final message must use.` : `Read the instructions in ${file} and follow them exactly. They are long: read all of them before you start.`, file };
  }
}

// how a turn left its Agent: kept for follow-ups, still open for the caller to settle, handed to the operator, or closed
type TurnOutcome = 'kept' | 'open' | 'released' | 'closed';


// a kept record as read back from disk: a Review run kind, a Worktree, and the kind's own conversation id when known
function validKept(value: unknown): KeptRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { kind, worktreeId, conversation } = value as { kind?: unknown; worktreeId?: unknown; conversation?: unknown };
  if (typeof kind !== 'string' || !isReviewAgentKind(kind) || typeof worktreeId !== 'string' || worktreeId === '') return undefined;
  if (conversation !== undefined && (typeof conversation !== 'string' || !validConversationId(kind, conversation))) return undefined;
  return { kind, worktreeId, ...(conversation === undefined ? {} : { conversation }) };
}
