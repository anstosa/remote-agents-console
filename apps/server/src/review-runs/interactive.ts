import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AttentionState } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';
import { launchFresh, managedRunProgress, managedRunStartWindowMs, type ReadinessOutcome } from '../launch/managed-run.js';
import type { ReviewRunLaunch } from '../launch/service.js';
import { MAX_REVIEW_GENERATED_BYTES } from '../review-tour/contracts.js';
import type { ReviewAgentKind } from './efforts.js';
import { reviewReplacedFlags, reviewRunArgs } from './launch-args.js';
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
  submit(agentId: string, text: string): Promise<boolean>;
  attention(agentId: string): Promise<AttentionState | undefined>;
  close(agentId: string): Promise<unknown>;
  release(agentId: string): Promise<unknown>;
  delay(): Promise<void>;
};
// `promptDirectory` holds the instructions of a run too long to paste (it must be readable by
// the Agent, outside the Worktree); `startWindowMs` and `now` are test seams
export type InteractiveReviewOptions = { promptDirectory: string; startWindowMs?: number; now?: () => number };

// the longest prompt pasted into the composer; the console refuses prompts over 32,000 characters
const maxPastedPrompt = 30_000;
// a line longer than this is cut short by Claude's Read tool, so long JSON is re-laid for the file
const maxReadableLine = 2_000;
// reads of a finished turn's final message before it counts as missing: a transcript can trail the idle report
const harvestAttempts = 20;

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
// Cancellation closes the pane.
export class InteractiveReviewRunner implements ReviewRunner {
  private readonly now: () => number;
  private readonly startWindowMs: number;
  // the ids of the runs in flight here, and the Agents an orphan release is handing back
  private readonly live = new Set<string>();
  private readonly releasing = new Set<string>();

  constructor(private readonly host: InteractiveReviewHost, private readonly options: InteractiveReviewOptions) {
    this.now = options.now ?? Date.now;
    this.startWindowMs = options.startWindowMs ?? managedRunStartWindowMs;
  }

  // Hand back every listed Agent marked for a Review run not in flight here (one a server restart
  // orphaned, or one whose close failed) through the release a run that gives up uses: it becomes an
  // ordinary Agent the operator can see, answer, close and be notified by. Never closed, since the
  // operator may be mid-answer in it.
  async releaseOrphans(agents: readonly Agent[]): Promise<void> {
    const orphans = agents.filter(candidate => candidate.reviewRun !== undefined && !this.live.has(candidate.reviewRun) && !this.releasing.has(candidate.id));
    await Promise.all(orphans.map(async orphan => {
      this.releasing.add(orphan.id);
      try { await this.host.release(orphan.id); } catch { /* the next sweep retries */ } finally { this.releasing.delete(orphan.id); }
    }));
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
        launch: () => this.host.launch(request.worktreeId, request.kind, { runId, label: request.label, extraArgs: reviewRunArgs(request.kind, { ...settings, readDirectory: this.options.promptDirectory }), replacedFlags: reviewReplacedFlags(request.kind, settings) }),
        waitForNewAgent: before => this.host.waitForAgent(before, runId),
        waitForReadiness: candidate => this.host.waitForReadiness(candidate),
        close: id => this.host.close(id),
        // report the Agent, then name its conversation with the run (best-effort)
        prepare: async candidate => { agent = candidate; request.onStarted?.({ agentId: candidate.id }); return await this.host.name(candidate.id, request.label); },
        deliver: async candidate => { agent = candidate; read = await this.host.beginTurn(candidate, maxBytes); return await this.host.submit(candidate.id, text); }
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
        const end = await this.watch(ran.id, request, signal, deadline);
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
      if (file !== undefined && !keepFile) await unlink(file).catch(() => undefined);
    }
  }

  // Watch the Agent's attention until its turn finishes, it goes, the deadline passes or the run is
  // cancelled. A question keeps the run waiting (the operator answers in the pane) and is reported.
  private async watch(agentId: string, request: ReviewRunRequest, signal: AbortSignal, deadline: number): Promise<WatchEnd> {
    const started = this.now();
    let sawWorking = false;
    let needsInput = false;
    for (;;) {
      if (signal.aborted) return 'cancelled';
      if (this.now() >= deadline) return 'timed-out';
      const attention = await this.host.attention(agentId);
      if (attention === undefined) return 'vanished';
      const progress = managedRunProgress(attention, sawWorking, this.now() - started, this.startWindowMs);
      // report each change of waiting on the operator
      if ((progress === 'question') !== needsInput) { needsInput = !needsInput; request.onAttention?.(needsInput); }
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
