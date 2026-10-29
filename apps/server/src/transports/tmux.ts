import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { DiscoveryService } from '../discovery/service.js';
import type { TmuxAdapter } from '../tmux/adapter.js';
import { codexCollapsedPasteLabel, failedTurnFromCapture, lastPromptFromHistory, latestCompletedAssistantTurn, queueReadyPrompt } from '../adapters/codex-turns.js';
import { adapterFor } from '../adapters/registry.js';
import { codexFamily, type Adapter, type AgentKind, type CompletionBaseline, type CompletionEvent, type PaneSnapshot, type Submission, type SubmissionDraftState, type SubmissionMode, type TmuxKey } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';
import { run } from '../tmux/command.js';
import type { PromptHistoryEntry } from '../prompt-history/service.js';
import { agentAttentionState } from '../notifications.js';
import { promptScope } from '../prompts/queue.js';
import type { ResetBoundary, ResetBoundaryStore } from '../prompts/reset-boundaries.js';
import { maxPromptAttachmentBytes, promptAttachmentData, promptAttachmentName, validPrompt, type PromptAttachment } from '../prompts/validation.js';
import { expandCommand } from '../launch/service.js';
import type { AgentWaiter } from '../launch/wait.js';
import { configuredWorktreeForWorkspace } from '../workspaces/resolver.js';
import { updateAdvisorLabel, updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';
import type { AgentTransport, ConversationTarget, Gate, InterruptOutcome, QuestionAnswer, RenameOutcome, SwitchOutcome, TurnEvent } from './transport.js';

export const answerCaptureGraceMs = 10_000;
// preserve prompts through reset startup but do not strand them behind a dead pane
const conversationResetGraceMs = 10_000;
// a queued submit key can be swallowed when it races an unrendered composer
// wait briefly for a stable draft and retain the queue item if rendering fails
const composerRenderAttempts = 40;
const composerRenderPollMs = 50;
const composerRenderStableMs = 100;
// recover slow native submission without keeping failed queues in flight indefinitely
const submissionAcceptGraceMs = 4_000;
// space retries within the acceptance deadline
const submissionRetryAttempts: ReadonlySet<number> = new Set([6, 14, 30, 50, 70]);
const attachmentIgnoreRule = '/node_modules/.remote-agent-console/';
const updateAdvisorComposerAttempts = 100;
const updateAdvisorReadyStableMs = 500;
const updateAdvisorStartAttempts = 50;
const updateAdvisorPollMs = 100;
// normalize terminal-wrapped prompts
const normalizedPrompt = (value: string) => value.replace(/\s+/gu, ' ').trim();
// normalize one styled terminal snapshot
const normalizedTerminalText = (value: string) => normalizedPrompt(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ''));
// the console never composes submission through an unknown kind
export type AdapterView = Pick<Adapter, 'stateSource' | 'submission' | 'turns' | 'questions' | 'completion' | 'managedPromptLifecycleV1' | 'newConversation' | 'conversations'>;
// an Adapter that announces its own Attention state (rather than the console
// inferring it from the title): it must report `working` before a prompt counts
// as complete, and fires no Stop hook on an interrupt, so the console writes
// `finished` itself.
export const reportsOwnState = (adapter: AdapterView) => adapter.stateSource !== 'title';
export type TmuxTarget = NonNullable<Awaited<ReturnType<DiscoveryService['target']>>> & { processId?: number };
// retain a failed native draft until clearing succeeds or ownership is lost
export type FailedDraft = { agentId: string; target: TmuxTarget; prompt: string; submission: Adapter['submission'] };
// the pane marks a Turn's completion is read past: the last completed turn on screen and the rollout position
export type TurnMark = { baselineCompletion?: string; rolloutBaseline?: CompletionBaseline };
// what the Turn feed is watching: the prompt it waits on, whether it was seen starting, and its marks
export type TurnWatch = TurnMark & { state?: 'awaiting-start' | 'working' | 'awaiting-answer' | 'halted'; historyPrompt?: string };
export type TmuxTurnEvent = Exclude<TurnEvent, { type: 'started' }> | { type: 'started'; mark: TurnMark };
// how one delivery ended: refused before anything reached the pane, held with the queue (keeping
// a draft to clear; `intended` once the send intent was recorded), or submitted. An `instant`
// prompt completes without a Turn; `reset` is a new-conversation command whose boundary now
// holds the queue until the pane settles.
export type Delivery = { status: 'refused' } | { status: 'held'; failedDraft?: FailedDraft; intended?: true } | { status: 'submitted'; instant: boolean; prompt: string; rolloutBaseline?: CompletionBaseline; reset?: true };
// the pane facts a send intent is recorded with, just before the submit keys
export type SendIntent = { kind: AgentKind; prompt: string; baseline?: CompletionBaseline; socketFingerprint: string; socketPath: string; paneId: string; processId?: number; sentAt: string };
// `intent` records the send once the draft is proven and before any key; an `arm` it returns is
// sent in the same tmux batch as the keys
export type DeliveryOptions = { discovered?: TmuxTarget; submission?: 'queue' | 'enter' | 'confirmed-enter'; durable?: boolean; resetAt?: number; queuedPromptId?: string; intent?: (send: SendIntent) => Promise<{ arm?: string }> };
// what restart recovery reads back from the pane: nothing yet, nothing to recover, or one entry's answer
export type RecoveredAnswer = 'pending' | 'settled' | { entryId: string; text: string };
// pair the shared staging directory with its agent-visible host namespace
export type AttachmentStagingWorkspace = { workspace: string; hostWorkspace: string | undefined };
// what the queue policy lends the Transport: its per-Agent input reservation, taken by every
// delivery, and word that a reset boundary was restored after a console restart, with the reset
// command it had already delivered (which leaves the queue)
export type PolicyHooks = { begin(agentId: string): (() => void) | undefined; version(agentId: string): number; busy(agentId: string): boolean; restored(scope: string, deliveredPromptId?: string): Promise<void> };
// keep reset readiness and its first-turn boundary separate from model completion
type ConversationReset = ResetBoundary & { observed: PaneSnapshot[]; state: 'pending' | 'ready' | 'expired' };
// share the adapter's reset and readiness snapshot shape
export const paneSnapshot = (agent: Agent): PaneSnapshot => ({ title: agent.title, attention: agentAttentionState(agent), ...(agent.conversationId === undefined ? {} : { conversationId: agent.conversationId }) });

export type LaunchOutcome = { agent: Agent } | { failure: 'refused' | 'timed-out' };
/**
 * Launch a tmux Agent and return it: `start` opens its pane, and the new Agent is the first one
 * outside `before` that `matches`, waited for as its CLI starts.
 */
export async function launchTmuxAgent(waitForAgent: AgentWaiter, before: Set<string>, matches: (agent: Agent) => boolean, start: () => Promise<boolean>): Promise<LaunchOutcome> {
  if (!await start()) return { failure: 'refused' };
  const agent = await waitForAgent(before, matches);
  return agent === undefined ? { failure: 'timed-out' } : { agent };
}

/**
 * The tmux Transport (ADR 0015): drives an Agent's TUI by pasting and pressing keys in its pane,
 * and reads its Turns back from captures and the CLI's rollout. It owns everything pane-shaped
 * about delivery: draft checks, rollout baselines, the reset boundaries of `/clear` and `/new`,
 * and recovering an answer from the pane after a console restart.
 */
export class TmuxTransport implements AgentTransport {
  // retain the reset instant until the first real prompt anchors its fresh rollout
  private readonly conversationResets = new Map<string, ConversationReset>();
  // hydrate each scope once before input or observation can race its durable boundary
  private readonly restoredResets = new Map<string, Promise<void>>();
  private readonly openedQueuedQuestions = new Set<string>();

  // reset boundaries survive a console restart in `resets`; without it there is no durable
  // queue, so nothing is held behind a reset and delivery is best-effort
  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly locks: PolicyHooks, private readonly resets?: ResetBoundaryStore, private readonly resolveAdapter: (kind: AgentKind) => AdapterView | undefined = adapterFor, private readonly teardownFor: (kind: AgentKind) => string | undefined = () => undefined, private readonly attachmentStaging?: AttachmentStagingWorkspace, private readonly restart?: (agentId: string, to: ConversationTarget) => Promise<SwitchOutcome>) {}

  // A pane's CLI cannot switch Conversation in place: the switch closes it and launches the kind
  // resuming the Conversation, under the queue's restart reservation and hand-over (in `app.ts`)
  async switchConversation(agentId: string, to: ConversationTarget): Promise<SwitchOutcome> {
    return await this.restart?.(agentId, to) ?? { status: 'unavailable', error: 'The agent cannot switch conversations.' };
  }

  async target(agentId: string, force = false): Promise<TmuxTarget | undefined> {
    return await this.discovery.target(agentId, force);
  }

  // Paste and submit a new-conversation reset command (`/clear`, `/new`) through the
  // Adapter's own submission path, without the history and completion tracking a real
  // prompt gets. The Run primitive drives the settle polling itself over the Adapter's
  // `newConversation.settled` rule (Scheduled prompts); this call only lands the command.
  async newConversation(agentId: string, command?: string): Promise<boolean> {
    const first = await this.discovery.target(agentId);
    if (first === undefined) return false;
    const adapter = this.resolveAdapter(first.agent.kind);
    const reset = command ?? adapter?.newConversation?.command;
    if (adapter === undefined || reset === undefined) return false;
    const composed = adapter.submission.prepare(reset, 'prompt');
    const buffer = `rac-${randomBytes(18).toString('base64url')}`;
    if (!await this.tmux.pastePrompt(first.socket, first.agent.pane.paneId, buffer, composed.text)) return false;
    // re-read so the submit keys reflect send-time state and the pane is still the same one
    const submitTarget = await this.discovery.target(agentId, true);
    if (submitTarget === undefined || submitTarget.socket.fingerprint !== first.socket.fingerprint || submitTarget.agent.pane.paneId !== first.agent.pane.paneId) return false;
    // an idle pane takes the Adapter's idle keys (Codex submits `/new` with Enter, not Tab)
    const keys = agentAttentionState(submitTarget.agent) === 'finished' ? composed.idleKeys ?? composed.keys : composed.keys;
    const submitted = await this.tmux.sendKeys(submitTarget.socket, submitTarget.agent.pane.paneId, keys);
    // clear stale prose questions after delivery
    if (submitted) this.discovery.invalidateMessageQuestion?.(agentId);
    return submitted;
  }

  // Name the current Conversation with the CLI's own rename command: paste it and press its keys
  // under the Agent's input reservation. `again` presses the keys once more for a paste that
  // landed while its Enter did not.
  async rename(agentId: string, name: string, again = false): Promise<RenameOutcome> {
    const target = await this.discovery.target(agentId);
    const rename = target === undefined ? undefined : this.resolveAdapter(target.agent.kind)?.conversations?.rename?.(name);
    if (target === undefined || rename === undefined) return 'unavailable';
    // hold the agent's lifecycle mutation lock across the paste so a concurrent restart/switch
    // cannot close the pane mid-delivery (and so it, in turn, defers to this rename), exactly as
    // prompt submission does; a live restart reservation refuses the rename
    const release = this.locks.begin(agentId);
    if (release === undefined) return 'busy';
    try {
      if (!again && !await this.tmux.pastePrompt(target.socket, target.agent.pane.paneId, `rac-${randomBytes(18).toString('base64url')}`, rename.text)) return 'unsent';
      return await this.tmux.sendKeys(target.socket, target.agent.pane.paneId, rename.keys) ? 'sent' : 'stuck';
    } finally { release(); }
  }

  // press the Adapter's submit keys again for a prompt pasted into an idle composer
  async resubmit(target: TmuxTarget, prompt: string): Promise<void> {
    const submission = this.resolveAdapter(target.agent.kind)?.submission;
    const release = submission === undefined ? undefined : this.locks.begin(target.agent.id);
    if (submission === undefined || release === undefined) return;
    const composed = submission.prepare(prompt, 'prompt');
    try { await this.tmux.sendKeys(target.socket, target.agent.pane.paneId, composed.idleKeys ?? composed.keys).catch(() => false); }
    finally { release(); }
  }

  async capture(target: TmuxTarget): Promise<string | undefined> {
    return await this.tmux.capture(target.socket, target.agent.pane.paneId).catch(() => undefined);
  }

  // leave a pane mode (a picker or copy mode) the Agent's pane is in
  async exitPaneMode(agentId: string): Promise<boolean | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined ? undefined : await this.tmux.exitPaneMode(target.socket, target.agent.pane.paneId);
  }

  // hand an interactive Review run's Agent back to its Worktree by dropping its run mark
  async unmarkReviewRun(agentId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    return target !== undefined && await this.tmux.unmarkReviewRun(target.socket, target.agent.pane.paneId);
  }

  // mark one advisor reusable only after its initial prompt is scheduled
  async markUpdateAdvisorReady(agentId: string, targetSha: string): Promise<boolean> {
    // require one server-owned target and live advisor pane
    if (!isFullGitSha(targetSha)) return false;
    const target = await this.discovery.target(agentId);
    if (target === undefined || target.agent.displayLabel !== updateAdvisorPendingLabel(targetSha)) return false;
    return await this.tmux.label(target.socket, target.agent.pane.paneId, updateAdvisorLabel(targetSha));
  }

  // Whether the Agent's reset boundary holds its queue, restoring a durable one first. `retry`
  // makes an expired boundary pending again for new input (answering as it stood before), and
  // `settle` checks whether a pending one settled into a ready pane (`anchored`) or expired.
  async gate(agentId: string, step?: 'retry' | 'settle'): Promise<Gate> {
    const scope = promptScope(agentId);
    await this.restoreReset(scope, agentId);
    const reset = this.conversationResets.get(scope);
    if (reset === undefined) return 'none';
    if (reset.agentId !== agentId) return 'foreign';
    if (step === 'settle') {
      const settled = await this.settleReset(agentId, scope);
      return settled === 'ready' ? 'anchored' : settled;
    }
    const gate = reset.state === 'pending' ? 'pending' : 'anchored';
    if (step === 'retry' && reset.state === 'expired') reset.state = 'pending';
    return gate;
  }

  // whether a pending reset holds the Agent's queue, as last restored or read by `gate`
  held(agentId: string): boolean {
    return this.conversationResets.get(promptScope(agentId))?.state === 'pending';
  }

  async forget(scope: string): Promise<void> {
    await this.resets?.clear(scope);
    for (const state of [this.conversationResets, this.restoredResets]) state.delete(scope);
  }

  // The Turn feed, polled: while the Agent works the Turn has `started` (with the marks its
  // completion is read past, captured unless `turn` already has them); once it is idle the Turn
  // has `settled` with its answer, `failed` or been `aborted`, or nothing is known yet.
  async observe(agent: Pick<Agent, 'id' | 'kind' | 'attention'>, turn: TurnWatch): Promise<TmuxTurnEvent | undefined> {
    if (agentAttentionState(agent) !== 'finished') return { type: 'started', mark: await this.mark(agent, turn) };
    return await this.settled(agent.id, turn);
  }

  // the marks a Turn's completion is read past, keeping any already taken
  async mark(agent: Pick<Agent, 'id' | 'kind'>, have: TurnMark = {}): Promise<TurnMark> {
    const baselineCompletion = have.baselineCompletion ?? await this.completionSignature(agent.id);
    // keep the pre-submit baseline a sent prompt already carries; capturing it now
    // would sit past this turn's own `task_started` and miss a fast completion
    const rolloutBaseline = have.rolloutBaseline ?? await this.captureRolloutBaseline(agent.id, this.resolveAdapter(agent.kind));
    return { ...(baselineCompletion === undefined ? {} : { baselineCompletion }), ...(rolloutBaseline === undefined ? {} : { rolloutBaseline }) };
  }

  // An externally reset pane (a `/clear` typed by hand) spins without a Turn: once the actual pane
  // is ready with an empty composer, not merely its cached title, its snapshot becomes the boundary
  // the next prompt anchors on, while the work it ended is still `current`. True once remembered.
  async externalReset(agentId: string, current: () => boolean): Promise<boolean> {
    const target = await this.discovery.target(agentId, true);
    const capability = target === undefined ? undefined : this.resolveAdapter(target.agent.kind)?.newConversation;
    const capture = target === undefined ? undefined : await this.tmux.capture(target.socket, target.agent.pane.paneId).catch(() => undefined);
    if (target === undefined || capability === undefined || capture === undefined
      || agentAttentionState(target.agent) !== 'finished' || capability.ready(paneSnapshot(target.agent), capture).state !== 'ready'
      || !capability.composerEmpty(capture) || !current()) return false;
    // the reset time is unknown; follow the pane's first rollout replacement instead
    await this.rememberReset(promptScope(agentId), { agentId, at: Date.now(), before: paneSnapshot(target.agent), external: true }, 'ready');
    return true;
  }

  // send one prompt to a stable pane. `resetAt`, when set, anchors the completion
  // baseline on the conversation the pane was just reset into. `rendering` hears that the
  // prompt sits pasted while its composer is checked.
  async deliver(agentId: string, prompt: string, attachments: PromptAttachment[], options: DeliveryOptions, rendering: (prompt: string) => void): Promise<Delivery> {
    const { discovered, submission = 'queue', durable = false, resetAt, queuedPromptId } = options;
    const original = discovered ?? await this.discovery.target(agentId);
    // require one live agent before staging or pasting
    if (!original) return { status: 'refused' };
    const processId = this.discovery.agentProcessId?.(agentId);
    const first: TmuxTarget = { ...original, ...(processId === undefined ? {} : { processId }) };
    // the Adapter describes the paste text and the submit keys; the console pastes and sends them
    const adapter = this.resolveAdapter(first.agent.kind);
    if (adapter === undefined) return { status: 'refused' };
    const capability = adapter.newConversation;
    const reset = attachments.length === 0 && capability !== undefined
      && (prompt.trim() === capability.command || capability.aliases?.includes(prompt.trim()) === true);
    // reset commands have no model answer, even when startup briefly looks busy
    const instant = reset || (adapter.submission.completesWithoutWork?.(prompt) ?? false);
    const scope = promptScope(agentId);
    // codex can read shared files outside an unmounted scratch home
    const sharedStaging = attachments.length > 0 && codexFamily(first.agent.kind) && configuredWorktreeForWorkspace(this.discovery.worktreesNow(), first.agent.home) === undefined ? this.attachmentStaging : undefined;
    const hostWorkspace = sharedStaging?.hostWorkspace;
    // never paste a container-only path when the host mapping is unavailable
    if (sharedStaging !== undefined && (hostWorkspace === undefined || !isAbsolute(hostWorkspace))) return { status: 'refused' };
    const workspace = sharedStaging?.workspace ?? this.workspaceFor(first.agent.home);
    const staged = await this.stageAttachments(workspace, attachments);
    if (staged === undefined) return { status: 'refused' };
    // name shared files in the agent's namespace while retaining local cleanup paths
    const references = staged.map(path => `@${hostWorkspace === undefined ? path : join(hostWorkspace, path)}`);
    const attachmentPrompt = staged.length === 0 ? prompt : `${prompt}${prompt ? '\n\n' : ''}Attached files:\n${references.join('\n')}`;
    const shellMode = attachments.length === 0 && prompt.startsWith('!');
    const mode: SubmissionMode = shellMode ? 'shell' : 'prompt';
    const composed = adapter.submission.prepare(attachmentPrompt, mode);
    const observeDraft = adapter.submission.observeDraft;
    // adapters without draft observation retain best-effort tmux delivery
    const settle = durable && submission === 'queue' && observeDraft !== undefined && typeof this.tmux.capture === 'function' && this.resets !== undefined;
    // retain cleanup coordinates through every post-paste failure
    const failedDraft = settle ? { agentId, target: first, prompt: composed.text, submission: adapter.submission } : undefined;
    const buffer = `rac-${randomBytes(18).toString('base64url')}`;
    // keep the server-owned prompt out of the startup shell
    if (submission === 'confirmed-enter' && !await this.waitForUpdateAdvisorReady(agentId, first)) {
      await this.removeStaged(workspace, staged);
      return { status: 'refused' };
    }
    const pasteTarget = await this.submissionTarget(agentId, first).catch(() => undefined);
    // attachment staging and startup waits must not paste into a replacement process
    if (pasteTarget === undefined || agentAttentionState(pasteTarget.agent) === 'question') {
      await this.removeStaged(workspace, staged);
      return { status: 'refused' };
    }
    // a rejected paste does not establish ownership of pre-existing native text
    if (!await this.tmux.pastePrompt(pasteTarget.socket, pasteTarget.agent.pane.paneId, buffer, composed.text)) {
      await this.removeStaged(workspace, staged);
      return { status: 'refused' };
    }
    const second = await this.submissionTarget(agentId, first).catch(() => undefined);
    // never adopt a new process after the paste
    if (!second) {
      await this.removeStaged(workspace, staged);
      // hold durable ownership through a failed post-paste discovery scan
      return settle ? { status: 'held', failedDraft } : { status: 'refused' };
    }
    // wait until the fresh advisor composer rendered the complete paste
    if (submission === 'confirmed-enter' && !await this.waitForUpdateAdvisorComposer(agentId, second, attachmentPrompt)) {
      await this.removeStaged(workspace, staged);
      return { status: 'refused' };
    }
    // hold the scope so a quick second submit queues behind this one, then let the
    // Adapter-owned composer observation settle before the submit key
    if (settle) {
      rendering(attachmentPrompt);
      // retain durable work instead of submitting an unrendered draft
      if (!await this.waitForComposerRender(agentId, second, composed.text, observeDraft)) {
        await this.clearFailedDraft(agentId, second, composed.text, adapter.submission);
        return { status: 'held', failedDraft };
      }
    }
    // snapshot the rollout baseline before the turn starts: completion is then a
    // `task_complete` recorded past it (the native-Codex TUI renders no boundary,
    // so scraping the pane never observes the finish)
    const previousReset = this.conversationResets.get(scope);
    const matchingReset = previousReset?.agentId === agentId ? previousReset : undefined;
    const baselineResetAt = resetAt ?? (matchingReset?.external ? undefined : matchingReset?.at);
    const rolloutBaseline = this.resets === undefined && queuedPromptId === undefined || instant ? undefined : await this.captureRolloutBaseline(agentId, adapter, baselineResetAt, matchingReset?.external);
    // the send intent's instant, separate from transport and reset deadlines
    const sentAt = new Date().toISOString();
    // the exact pre-key intent, recorded before the tracked submit path proceeds
    const calendarIntent: { arm?: string } | undefined = options.intent === undefined ? undefined : await options.intent({
      kind: first.agent.kind,
      prompt: attachmentPrompt,
      ...(rolloutBaseline === undefined ? {} : { baseline: rolloutBaseline }),
      socketFingerprint: second.socket.fingerprint,
      socketPath: second.socket.path,
      paneId: second.agent.pane.paneId,
      ...(first.processId === undefined ? {} : { processId: first.processId }),
      sentAt
    }).catch(() => ({}));
    // retain durable ownership when the final proof fails; a recorded intent no longer holds
    const abortBeforeKeys = (): Delivery => ({ status: 'held', failedDraft, ...(calendarIntent === undefined ? {} : { intended: true as const }) });
    // refresh after every settle/baseline delay so key selection reflects send-time state
    let submitTarget = await this.submissionTarget(agentId, second).catch(() => undefined);
    // never submit through a replacement pane or native question
    if (!submitTarget || agentAttentionState(submitTarget.agent) === 'question') {
      return abortBeforeKeys();
    }
    // preserve operator edits made while the initial baseline was being read
    if (settle) {
      const captured = await this.tmux.capture(submitTarget.socket, submitTarget.agent.pane.paneId).catch(() => undefined);
      // first-paste delivery permits an exact collapsed label but never known edits
      if (captured === undefined || observeDraft(captured, composed.text) !== 'visible' || adapter.submission.ownsDraft?.(captured, composed.text) === false) {
        return abortBeforeKeys();
      }
      submitTarget = await this.submissionTarget(agentId, second).catch(() => undefined);
      // captures may outlive the original native process or reveal a new question
      if (!submitTarget || agentAttentionState(submitTarget.agent) === 'question') {
        return abortBeforeKeys();
      }
      const latestCapture = await this.tmux.capture(submitTarget.socket, submitTarget.agent.pane.paneId).catch(() => undefined);
      // lifecycle scans can outlast the draft and must not authorize stale input
      if (latestCapture === undefined || observeDraft(latestCapture, composed.text) !== 'visible' || adapter.submission.ownsDraft?.(latestCapture, composed.text) === false || !this.submissionProcessCurrent(agentId, second) || agentAttentionState(submitTarget.agent) === 'question') {
        return abortBeforeKeys();
      }
    }
    // use direct submit only while the final target is idle
    const adapterKeys = agentAttentionState(submitTarget.agent) === 'finished' ? composed.idleKeys ?? composed.keys : composed.keys;
    // the update advisor is submitted with Enter regardless of the Adapter's keys
    const keys: TmuxKey[] = submission === 'enter' || submission === 'confirmed-enter' ? ['Enter'] : adapterKeys;
    const submittedAt = Date.now();
    const resetBefore = paneSnapshot(submitTarget.agent);
    // arm and submit Claude in one ordered tmux batch after exact draft ownership
    const submittedWithArm = calendarIntent?.arm === undefined ? undefined : await this.tmux.armAndSendKeys(submitTarget.socket, submitTarget.agent.pane.paneId, calendarIntent.arm, keys).catch(() => false);
    let submitted = submittedWithArm ?? await this.tmux.sendKeys(submitTarget.socket, submitTarget.agent.pane.paneId, keys).catch(() => false);
    // allow reset redraws their startup budget without weakening prompt acknowledgement
    const acceptUntil = reset ? submittedAt + conversationResetGraceMs : Date.now() + submissionAcceptGraceMs;
    // inspect ambiguous transport failures too before abandoning a pasted draft
    if (settle) submitted = await this.waitForSubmissionAccepted(agentId, submitTarget, composed, adapter.submission, adapter.completion, rolloutBaseline, attachmentPrompt, acceptUntil);
    // confirm the server-owned prompt left the composer
    if (submitted && submission === 'confirmed-enter') submitted = await this.waitForUpdateAdvisorStart(agentId, submitTarget, attachmentPrompt);
    // clear stale prose questions after delivery
    if (submitted) this.discovery.invalidateMessageQuestion?.(agentId);
    // halt only when a durable prompt is still waiting
    if (!submitted) return abortBeforeKeys();
    // hold follow-ups through startup and anchor their completion on the new thread
    const remembered = reset && this.resets !== undefined;
    if (remembered) await this.rememberReset(scope, { agentId, at: submittedAt, before: resetBefore, ...(queuedPromptId === undefined ? {} : { resetPromptId: queuedPromptId }) }, 'pending');
    // a real prompt consumes the boundary it anchored on
    if (!instant) await this.consumeReset(scope, matchingReset?.id);
    return { status: 'submitted', instant, prompt: attachmentPrompt, ...(rolloutBaseline === undefined ? {} : { rolloutBaseline }), ...(remembered ? { reset: true as const } : {}) };
  }

  // recover a reset even when its command was consumed before the server restarted
  private async restoreReset(scope: string, agentId: string): Promise<void> {
    // deployments without durable queues have no boundary to restore
    if (this.resets === undefined) return;
    let restoration = this.restoredResets.get(scope);
    // share one in-flight read so an observer cannot reinstall a consumed boundary
    if (restoration === undefined) {
      restoration = this.resets.get(scope).then(async boundary => {
        // missing boundaries leave normal completion recovery unchanged
        if (boundary === undefined) return;
        // close the crash window between durable reset acknowledgement and queue removal
        await this.locks.restored(scope, boundary.resetPromptId);
        this.conversationResets.set(scope, { ...boundary, observed: [], state: 'pending' });
      }).catch(error => {
        this.restoredResets.delete(scope);
        throw error;
      });
      this.restoredResets.set(scope, restoration);
    }
    await restoration;
    const reset = this.conversationResets.get(scope);
    // distinguish a live sibling from a genuinely removed reset owner
    if (reset !== undefined && reset.agentId !== agentId && await this.discovery.target(reset.agentId, true) === undefined) {
      await this.resets.clear(scope, reset.id);
      // preserve any replacement recorded during the fresh discovery read
      if (this.conversationResets.get(scope) === reset) this.conversationResets.delete(scope);
    }
  }

  // consume the durable boundary once a real post-reset prompt is accepted
  private async consumeReset(scope: string, resetId: string | undefined): Promise<void> {
    if (resetId !== undefined) await this.resets?.clear(scope, resetId);
    this.conversationResets.delete(scope);
  }

  // persist before the reset command leaves the queue, including an empty follow-up queue
  private async rememberReset(scope: string, boundary: Omit<ResetBoundary, 'id'>, state: 'pending' | 'ready'): Promise<void> {
    const durable = { ...boundary, id: randomBytes(18).toString('base64url') };
    await this.resets?.set(scope, durable);
    this.conversationResets.set(scope, { ...durable, observed: [], state });
  }

  // retain queued work until the reset settles into a genuinely ready empty composer;
  // `expired` is a reset lost or blocked past its grace, whose queue the caller holds
  private async settleReset(agentId: string, scope: string): Promise<'ready' | 'pending' | 'expired'> {
    const reset = this.conversationResets.get(scope);
    // normal turns and already settled resets need no additional terminal reads
    if (reset === undefined || reset.state !== 'pending') return 'ready';
    const target = reset.agentId === agentId ? await this.discovery.target(agentId, true) : undefined;
    const capability = target === undefined ? undefined : this.resolveAdapter(target.agent.kind)?.newConversation;
    let lost = false;
    // never release a reset into a different pane or unsupported adapter
    if (target !== undefined && capability !== undefined) {
      const snapshot = paneSnapshot(target.agent);
      reset.observed.push(snapshot);
      // bound reset diagnostics even if a dialog remains open indefinitely
      if (reset.observed.length > 20) reset.observed.shift();
      // an external boundary was already settled when recorded; only readiness needs rechecking
      const settling = reset.external ? 'settled' : capability.settled(reset.before, reset.observed, Date.now() - reset.at);
      lost = settling === 'lost';
      // a visible composer during startup is not permission to submit
      if (settling === 'settled' && snapshot.attention === 'finished') {
        const capture = await this.tmux.capture(target.socket, target.agent.pane.paneId).catch(() => undefined);
        // wait through loading, drafts, and dialogs without pasting into them
        if (capture !== undefined && capability.ready(snapshot, capture).state === 'ready' && capability.composerEmpty(capture)) {
          // another observer may already have advanced to a newer reset
          if (this.conversationResets.get(scope) !== reset) return 'pending';
          reset.state = 'ready';
          return 'ready';
        }
      }
    }
    // leave genuinely lost or blocked resets recoverable through the existing notes path
    if ((lost || Date.now() - reset.at >= conversationResetGraceMs) && this.conversationResets.get(scope) === reset) {
      // retain the first-turn anchor while releasing the failed readiness reservation
      reset.state = 'expired';
      return 'expired';
    }
    return 'pending';
  }

  // wait (briefly) for a pasted interactive prompt to render on the validated pane,
  // so the submit key is not swallowed by a composer that has not yet caught up
  private async waitForComposerRender(agentId: string, target: TmuxTarget, prompt: string, observeDraft: (capture: string, prompt: string) => SubmissionDraftState): Promise<boolean> {
    let renderedSince: number | undefined;
    const renderUntil = Date.now() + composerRenderAttempts * composerRenderPollMs;
    // poll within the bounded render window
    for (let attempt = 0; attempt < composerRenderAttempts && Date.now() < renderUntil; attempt += 1) {
      const current = await this.submissionTarget(agentId, target, false).catch(() => undefined);
      // never render-gate a replacement pane or native question
      if (current === undefined || agentAttentionState(current.agent) === 'question') return false;
      const captured = await this.tmux.capture(current.socket, current.agent.pane.paneId).catch(() => undefined);
      const rendered = captured !== undefined && observeDraft(captured, prompt) === 'visible';
      // retain only uninterrupted live-composer rendering
      if (!rendered) renderedSince = undefined;
      else if (renderedSince === undefined) renderedSince = Date.now();
      else if (Date.now() - renderedSince >= composerRenderStableMs) return true;
      await new Promise(resolve => setTimeout(resolve, composerRenderPollMs));
    }
    return false;
  }

  // acknowledge a cleared composer or fresh exact structured receipt
  private async waitForSubmissionAccepted(agentId: string, target: TmuxTarget, composed: Submission, submission: Adapter['submission'], completion: Adapter['completion'] | undefined, baseline: CompletionBaseline | undefined, receiptPrompt: string, acceptUntil: number): Promise<boolean> {
    const acceptAttempts = Math.ceil((acceptUntil - Date.now()) / composerRenderPollMs);
    let draft: SubmissionDraftState | undefined;
    // poll within the acceptance deadline and retry only visible server-owned drafts
    for (let attempt = 0; attempt < acceptAttempts && Date.now() < acceptUntil; attempt += 1) {
      const current = await this.submissionTarget(agentId, target, false).catch(() => undefined);
      // read the original pane without writing when discovery temporarily loses it
      const observed = current ?? target;
      const captured = await this.tmux.capture(observed.socket, observed.agent.pane.paneId).catch(() => undefined);
      draft = captured === undefined ? undefined : submission.observeDraft!(captured, composed.text);
      // bound rollout reads while checking before retries and final recovery
      const checkReceipt = draft === 'cleared' || attempt === 0 || submissionRetryAttempts.has(attempt) || attempt === acceptAttempts - 1;
      // preserve original whitespace when checking hidden or stale composer frames
      if (checkReceipt && baseline !== undefined && completion?.accepted !== undefined && await completion.accepted(baseline, receiptPrompt).catch(() => false)) return true;
      // revalidate the native process before trusting an empty composer
      if (draft === 'cleared') return await this.submissionTarget(agentId, target).catch(() => undefined) !== undefined || target.processId === undefined && current === undefined;
      // lost targets and native questions never authorize additional keys
      if (current === undefined || agentAttentionState(current.agent) === 'question') return false;
      // let an in-flight snapshot finish without extending recovery
      if (Date.now() >= acceptUntil) break;
      // recover submit keys swallowed while the previous turn finishes
      if (submissionRetryAttempts.has(attempt) && draft === 'visible' && captured !== undefined && submission.ownsDraft?.(captured, composed.text) === true) {
        const retryTarget = await this.submissionTarget(agentId, target).catch(() => undefined);
        // revalidate before every side effect
        if (retryTarget === undefined || agentAttentionState(retryTarget.agent) === 'question') return false;
        // a slow identity scan cannot extend the retry deadline
        if (Date.now() >= acceptUntil) break;
        const latestCapture = await this.tmux.capture(retryTarget.socket, retryTarget.agent.pane.paneId).catch(() => undefined);
        // terminal captures also consume the bounded acceptance window
        if (Date.now() >= acceptUntil) break;
        // preserve any replacement or question observed during capture
        if (!this.submissionProcessCurrent(agentId, target) || agentAttentionState(retryTarget.agent) === 'question') return false;
        const latestDraft = latestCapture === undefined ? 'unknown' : submission.observeDraft!(latestCapture, composed.text);
        // native acceptance during discovery needs no second submit key
        if (latestDraft === 'cleared') return true;
        // require fresh content proof after the potentially slow identity read
        if (latestCapture === undefined || latestDraft !== 'visible' || submission.ownsDraft?.(latestCapture, composed.text) !== true || !this.submissionProcessCurrent(agentId, target)) continue;
        const keys = agentAttentionState(retryTarget.agent) === 'finished' ? composed.idleKeys ?? composed.keys : composed.keys;
        // inspect again after transport failure rather than immediately giving up
        await this.tmux.sendKeys(retryTarget.socket, retryTarget.agent.pane.paneId, keys).catch(() => false);
      }
      await new Promise(resolve => setTimeout(resolve, composerRenderPollMs));
    }
    // inspect the final redraw unless a slow capture already exceeded the deadline
    if (Date.now() <= acceptUntil + composerRenderPollMs) {
      const current = await this.submissionTarget(agentId, target).catch(() => undefined);
      // never recover through a replacement pane
      if (current === undefined) return false;
      const captured = await this.tmux.capture(current.socket, current.agent.pane.paneId).catch(() => undefined);
      draft = captured === undefined ? undefined : submission.observeDraft!(captured, composed.text);
      // a last-moment native acceptance must not become an undelivered note
      if (draft === 'cleared') return this.submissionProcessCurrent(agentId, target);
    }
    // trust a late structured receipt before clearing a stale composer frame
    if (baseline !== undefined && completion?.accepted !== undefined && await completion.accepted(baseline, receiptPrompt).catch(() => false)) return true;
    // hidden frames cannot authorize clearing and need no extra terminal reads
    if (draft === 'visible') await this.clearFailedDraft(agentId, target, composed.text, submission);
    return false;
  }

  // retain the original pane identity through recovery
  private async submissionTarget(agentId: string, expected: TmuxTarget, force = true): Promise<TmuxTarget | undefined> {
    const current = await this.discovery.target(agentId, force);
    // reject replaced sockets, panes, and agent kinds
    return current !== undefined && current.socket.fingerprint === expected.socket.fingerprint
      && current.agent.pane.paneId === expected.agent.pane.paneId && current.agent.kind === expected.agent.kind
      && this.submissionProcessCurrent(agentId, expected)
      ? { ...current, ...(expected.processId === undefined ? {} : { processId: expected.processId }) } : undefined;
  }

  // reject observed process changes without another slow scan after inspecting input
  private submissionProcessCurrent(agentId: string, expected: TmuxTarget): boolean {
    return expected.processId === undefined || this.discovery.agentProcessId?.(agentId) === expected.processId;
  }

  // clear a held delivery's draft before its queue is saved; true once nothing of it remains
  async clearDraft(draft: FailedDraft): Promise<boolean> {
    return await this.clearFailedDraft(draft.agentId, draft.target, draft.prompt, draft.submission);
  }

  // remove only an observed server-owned draft without interrupting native work
  private async clearFailedDraft(agentId: string, expected: TmuxTarget, prompt: string, submission: Adapter['submission']): Promise<boolean> {
    // adapters must explicitly describe safe clearing
    if (submission.clearDraft === undefined || submission.observeDraft === undefined) return true;
    // retry one swallowed clear only after observing the same live draft again
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.submissionTarget(agentId, expected).catch(() => null);
      // transient discovery errors cannot prove that the draft disappeared
      if (current === null) return false;
      // preserve native questions and replacement panes
      if (current === undefined) {
        const snapshots = this.tmux.paneSnapshotsNow?.();
        const processId = this.discovery.agentProcessId?.(agentId);
        // a recognized replacement cannot retain the old native draft's ownership
        if (expected.processId !== undefined && processId !== undefined && processId !== expected.processId) return true;
        // legacy transports without inventory observations keep their existing absence contract
        if (snapshots === undefined) return true;
        const listing = snapshots.get(expected.socket.path);
        // only a complete listing that omits the exact pane proves removal
        return listing?.status === 'available' && !listing.panes.some(pane => pane.paneId === expected.agent.pane.paneId && pane.dead !== true);
      }
      // an unanswered native question cannot authorize cleanup
      if (agentAttentionState(current.agent) === 'question') return false;
      const captured = await this.tmux.capture(current.socket, current.agent.pane.paneId).catch(() => undefined);
      // matching scrollback or an unknown composer cannot authorize deletion
      if (captured === undefined) return false;
      const draft = submission.observeDraft(captured, prompt);
      // transient redraws keep cleanup pending rather than pretending it completed
      if (draft === 'unknown') return false;
      // a cleared composer needs no ownership proof or additional keys
      if (draft === 'cleared') return true;
      const owned = submission.ownsDraft?.(captured, prompt);
      // hidden paste contents and missing ownership observers keep cleanup pending
      if (owned === undefined) return false;
      // preserve operator-modified drafts without deleting their text
      if (!owned) return true;
      const clearTarget = await this.submissionTarget(agentId, expected).catch(() => undefined);
      // revalidate after capture before injecting a destructive key
      if (clearTarget === undefined || agentAttentionState(clearTarget.agent) === 'question') return false;
      const latestCapture = await this.tmux.capture(clearTarget.socket, clearTarget.agent.pane.paneId).catch(() => undefined);
      // do not clear stale input after a slow lifecycle scan
      if (latestCapture === undefined) return false;
      const latestDraft = submission.observeDraft(latestCapture, prompt);
      // native acceptance or manual clearing needs no destructive key
      if (latestDraft === 'cleared') return true;
      const latestOwned = submission.ownsDraft?.(latestCapture, prompt);
      // keep hidden input pending until its ownership becomes provable
      if (latestDraft !== 'visible' || latestOwned === undefined) return false;
      // leave an operator edit untouched even if it arrived during discovery
      if (!latestOwned) return true;
      // account for identity or question changes observed during the final capture
      if (!this.submissionProcessCurrent(agentId, expected) || agentAttentionState(clearTarget.agent) === 'question') return false;
      await this.tmux.sendKeys(clearTarget.socket, clearTarget.agent.pane.paneId, submission.clearDraft).catch(() => false);
      await new Promise(resolve => setTimeout(resolve, composerRenderPollMs));
    }
    // verify the native redraw even after the final clearing attempt
    const captured = await this.tmux.capture(expected.socket, expected.agent.pane.paneId).catch(() => undefined);
    return captured !== undefined && submission.observeDraft(captured, prompt) === 'cleared';
  }

  // wait for one stable empty Codex composer before pasting
  private async waitForUpdateAdvisorReady(agentId: string, expected: TmuxTarget): Promise<boolean> {
    let readySince: number | undefined;
    // bound fresh-process startup
    for (let attempt = 0; attempt < updateAdvisorComposerAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during launch
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.pane.paneId !== expected.agent.pane.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      const captured = await this.tmux.capture(target.socket, target.agent.pane.paneId);
      const plain = captured?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '');
      const ready = agentAttentionState(target.agent) === 'finished' && plain !== undefined && /(?:^|\n)›(?:\s|$)/u.test(plain);
      // retain only uninterrupted readiness
      if (!ready) readySince = undefined;
      else if (readySince === undefined) readySince = Date.now();
      else if (Date.now() - readySince >= updateAdvisorReadyStableMs) return true;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // wait for one pasted advisor prompt to reach Codex
  private async waitForUpdateAdvisorComposer(agentId: string, expected: TmuxTarget, prompt: string): Promise<boolean> {
    const normalized = normalizedPrompt(prompt);
    // match the visible tail because Codex scrolls long composers to the cursor
    const visibleSuffix = normalized.slice(-Math.min(96, normalized.length));
    // match Codex's exact long-paste placeholder
    const collapsedPaste = codexCollapsedPasteLabel(queueReadyPrompt(prompt));
    // bound fresh-process startup
    for (let attempt = 0; attempt < updateAdvisorComposerAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during launch
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.pane.paneId !== expected.agent.pane.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      const captured = await this.tmux.capture(target.socket, target.agent.pane.paneId);
      // submit only after the pasted prompt begins rendering
      const composer = captured === undefined ? '' : normalizedTerminalText(captured);
      if (composer.includes(visibleSuffix) || composer.includes(collapsedPaste)) return true;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // confirm one advisor prompt actually started
  private async waitForUpdateAdvisorStart(agentId: string, expected: TmuxTarget, prompt: string): Promise<boolean> {
    const normalized = normalizedPrompt(prompt);
    // bound submission confirmation and retry dropped Enter keys
    for (let attempt = 0; attempt < updateAdvisorStartAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during submission
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.pane.paneId !== expected.agent.pane.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      // accept working, questioning, or already completed prompts
      if (agentAttentionState(target.agent) !== 'finished') return true;
      const captured = await this.tmux.capture(target.socket, target.agent.pane.paneId);
      if (normalizedPrompt(lastPromptFromHistory(captured ?? '') ?? '') === normalized) return true;
      // retry only after Codex had time to process the first key
      if ((attempt === 9 || attempt === 24) && !await this.tmux.sendKeys(target.socket, target.agent.pane.paneId, ['Enter'])) return false;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // What restart recovery reads back from the pane: the latest completed Turn on screen, matched
  // to an unanswered entry by its prompt; with the prompt scrolled away, only to the newest entry,
  // and only for work the console `sawWorking` since it started.
  async recoverAnswer(agentId: string, entries: readonly PromptHistoryEntry[], sawWorking: boolean): Promise<RecoveredAnswer> {
    const target = await this.discovery.target(agentId);
    // require a stable pane
    if (target === undefined) return 'pending';
    const capture = await this.tmux.capture(target.socket, target.agent.pane.paneId).catch(() => undefined);
    // require terminal history
    if (capture === undefined) return 'pending';
    const turn = latestCompletedAssistantTurn(capture);
    // require a completed turn
    if (turn === undefined) return 'pending';
    const newest = entries[0];
    let entry: PromptHistoryEntry | undefined;
    // recover only observed work when its prompt text scrolled away
    if (turn.prompt === undefined) {
      entry = sawWorking && newest?.answer === undefined && !entries.some(candidate => candidate.answer === turn.text) ? newest : undefined;
    } else {
      const capturedPrompt = turn.prompt;
      entry = entries.find(candidate => candidate.answer === undefined && normalizedPrompt(candidate.text) === normalizedPrompt(capturedPrompt));
    }
    // require an unanswered match
    return entry === undefined ? 'settled' : { entryId: entry.id, text: turn.text };
  }

  // the settled Turn's answer, read past its marks
  private async settled(agentId: string, turn: TurnWatch): Promise<TmuxTurnEvent | undefined> {
    // rollout-based completion (native Codex; OMX when its rollout resolves): the
    // structured `task_complete`/`turn_aborted` events are authoritative and, unlike
    // the TUI parse, need no `─ Worked for` footer — which the native build never
    // renders. When the rollout resolves it stays authoritative; only an unresolvable
    // rollout falls through to the TUI parse below.
    if (turn.rolloutBaseline !== undefined) {
      const event = await this.rolloutCompletion(agentId, turn.rolloutBaseline);
      if (event?.kind === 'aborted') return { type: 'aborted' };
      if (event?.kind === 'completed') return { type: 'settled', message: event.answer };
      if (event?.kind === 'pending') return undefined;
    }
    const target = await this.discovery.target(agentId);
    // require the original pane
    if (target === undefined) return undefined;
    const capture = await this.tmux.capture(target.socket, target.agent.pane.paneId).catch(() => undefined);
    // require a completed response
    if (capture === undefined) return undefined;
    // fail explicit terminal errors without waiting through the grace window
    if (failedTurnFromCapture(capture)) return { type: 'failed' };
    // wait for the latest completed response
    const completed = latestCompletedAssistantTurn(capture);
    if (completed === undefined) return undefined;
    const prompt = turn.historyPrompt;
    const completion = this.completionSignatureFromCapture(capture);
    const promptMatches = prompt === undefined
      || completed.prompt !== undefined && normalizedPrompt(completed.prompt) === normalizedPrompt(prompt)
      || turn.state !== 'awaiting-start' && completed.prompt === undefined && completion !== turn.baselineCompletion;
    // reject stale pane completions
    if (!promptMatches) return undefined;
    // reject completions that predate externally tracked work
    if (prompt === undefined && completion === turn.baselineCompletion) return undefined;
    return { type: 'settled', message: completed.text };
  }

  // the OS pid backing one discovered pane, when the discovery service exposes it
  private paneProcessId(agentId: string): number | undefined {
    return typeof this.discovery.paneProcessId === 'function' ? this.discovery.paneProcessId(agentId) : undefined;
  }

  // the raw reported Inline question payload one pane carries, when discovery exposes it
  private reportedQuestionPayload(agentId: string): string | undefined {
    return typeof this.discovery.reportedQuestionPayload === 'function' ? this.discovery.reportedQuestionPayload(agentId) : undefined;
  }

  // the pane's unique working directory, when the discovery service exposes it: the
  // Adapter's privilege-free fallback for a sandboxed pane whose descriptors a
  // confined service cannot readlink
  private paneWorkingDirectory(agentId: string): string | undefined {
    return typeof this.discovery.paneWorkingDirectory === 'function' ? this.discovery.paneWorkingDirectory(agentId) : undefined;
  }

  // snapshot the rollout completion baseline before a turn starts, when the Adapter
  // reads completion from its event log and the pane's pid is known. The pid drives
  // the exact fd-walk; the working directory is the fallback when it is blocked.
  // `resetAt` defers the baseline to the conversation the pane was just reset into.
  // untracked resets follow the pane's first replacement without guessing its timestamp
  async captureRolloutBaseline(agentId: string, adapter: AdapterView | undefined, resetAt?: number, followReset?: boolean): Promise<CompletionBaseline | undefined> {
    if (adapter?.completion === undefined) return undefined;
    const pid = this.paneProcessId(agentId);
    if (pid === undefined) return undefined;
    const cwd = this.paneWorkingDirectory(agentId);
    return await adapter.completion.baseline({ pid, ...(cwd === undefined ? {} : { cwd }) }, resetAt, followReset).catch(() => undefined);
  }

  // the newest terminal turn past the snapshotted baseline from the Adapter's event
  // log, or undefined when the Adapter has no such capability
  private async rolloutCompletion(agentId: string, baseline: CompletionBaseline): Promise<CompletionEvent | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const adapter = this.resolveAdapter(target.agent.kind);
    if (adapter?.completion === undefined) return undefined;
    return await adapter.completion.since(baseline).catch(() => undefined);
  }

  // capture the latest completed turn identity
  async completionSignature(agentId: string): Promise<string | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const capture = await this.tmux.capture(target.socket, target.agent.pane.paneId).catch(() => undefined);
    if (capture === undefined) return undefined;
    const completion = this.completionSignatureFromCapture(capture);
    if (completion !== undefined) return completion;
    // retain the completion hidden by current in-progress output
    const currentPrompt = capture.lastIndexOf('\n› ');
    return currentPrompt < 0 ? undefined : this.completionSignatureFromCapture(capture.slice(0, currentPrompt));
  }

  // identify a completion without retaining pane output
  private completionSignatureFromCapture(capture: string): string | undefined {
    const turn = latestCompletedAssistantTurn(capture);
    return turn === undefined ? undefined : `${turn.prompt ?? ''}\0${turn.text}`;
  }

  private workspaceFor(workspace: string): string {
    return configuredWorktreeForWorkspace(this.discovery.worktreesNow(), workspace)?.identity ?? workspace;
  }

  // keep staged attachments outside Git status
  private async ensureAttachmentRootIgnored(workspace: string, relativeRoot: string): Promise<boolean> {
    const ignored = await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot]);
    // retain repository ignore rules
    if (ignored.code === 0) return true;
    // allow workspaces without Git metadata
    if (/not a git repository/u.test(ignored.stderr)) return true;
    const resolved = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude']);
    // require a repository-local exclude file
    if (resolved.code !== 0 || resolved.stdout.trim() === '') return false;
    const excludePath = resolved.stdout.trim();
    const absoluteExcludePath = isAbsolute(excludePath) ? excludePath : join(workspace, excludePath);
    const existing = await readFile(absoluteExcludePath, 'utf8').catch(() => '');
    // add the narrow staging rule once
    if (!existing.split(/\r?\n/u).includes(attachmentIgnoreRule)) {
      await mkdir(dirname(absoluteExcludePath), { recursive: true });
      await appendFile(absoluteExcludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${attachmentIgnoreRule}\n`, { mode: 0o600 });
    }
    return (await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot])).code === 0;
  }

  // validate and stage batches without unbounded filesystem concurrency
  private async stageAttachments(workspace: string, attachments: PromptAttachment[]): Promise<string[] | undefined> {
    // skip empty attachment sets
    if (attachments.length === 0) return [];
    const files: Array<{ name: string; data: Buffer }> = [];
    const names = new Set<string>();
    let total = 0;
    // validate attachment payloads
    for (const attachment of attachments) {
      const name = promptAttachmentName(attachment.name);
      const data = promptAttachmentData(attachment.data);
      // reject unsafe or duplicate files
      if (!name || !data || names.has(name)) return undefined;
      names.add(name);
      total += data.length;
      // enforce the request limit
      if (total > maxPromptAttachmentBytes) return undefined;
      files.push({ name, data });
    }
    // stage beneath a dependency path
    const relativeRoot = `node_modules/.remote-agent-console/attachments/${randomBytes(12).toString('base64url')}`;
    // configure a local fallback for repositories without dependency ignores
    if (!await this.ensureAttachmentRootIgnored(workspace, relativeRoot)) return undefined;
    const root = join(workspace, relativeRoot);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      // bound file-descriptor use independently of batch size
      for (const file of files) await writeFile(join(root, file.name), file.data, { mode: 0o600 });
      // retain the original attachment order
      return files.map(file => `${relativeRoot}/${file.name}`);
    } catch {
      // remove every partial file before retaining the queued batch
      await rm(root, { recursive: true, force: true });
      return undefined;
    }
  }

  private async removeStaged(workspace: string, paths: string[]): Promise<void> {
    const relativeRoot = paths[0]?.split('/').slice(0, -1).join('/');
    if (relativeRoot) await rm(join(workspace, relativeRoot), { recursive: true, force: true });
  }

  // reveal a collapsed native question without choosing or submitting an answer
  async openQueuedQuestion(agentId: string, observedCapture: string, mayOpen: () => boolean): Promise<boolean> {
    const first = await this.discovery.target(agentId);
    const queued = first === undefined ? undefined : this.resolveAdapter(first.agent.kind)?.questions?.queued;
    // unsupported adapters never receive automatic keystrokes
    if (first === undefined || queued === undefined) return false;
    const question = queued(observedCapture);
    // rearm after completion, not when the operator merely collapses the editor
    if (question === undefined) {
      this.openedQueuedQuestions.delete(agentId);
      return false;
    }
    const key = question.key;
    // leave an expanded editor untouched
    if (key === undefined) return false;
    // coalesce viewers and avoid racing a newly started manual operation
    if (this.openedQueuedQuestions.has(agentId) || !mayOpen() || this.locks.busy(agentId)) return false;
    const release = this.locks.begin(agentId);
    // respect a restart reservation acquired during discovery
    if (release === undefined) return false;
    const version = this.locks.version(agentId);
    try {
      const capture = await this.tmux.capture(first.socket, first.agent.pane.paneId).catch(() => undefined);
      // never act on a footer that changed since the pane derive
      if (capture === undefined || queued(capture)?.key !== key) return false;
      const second = await this.discovery.target(agentId);
      // require the same live target, viewer lease, and untouched input generation
      if (second === undefined || second.socket.fingerprint !== first.socket.fingerprint || second.agent.pane.paneId !== first.agent.pane.paneId
        || second.agent.kind !== first.agent.kind || !mayOpen() || this.locks.version(agentId) !== version) return false;
      const opened = await this.tmux.sendKeys(second.socket, second.agent.pane.paneId, [key]);
      // suppress duplicate opening shortcuts until the native dialog changes the footer
      if (opened) this.openedQueuedQuestions.add(agentId);
      return opened;
    } finally {
      release();
    }
  }

  // answer the current question directly without queueing a new agent turn; a pane question
  // has no dismissal, so dismissing one is refused
  async answer(agentId: string, questionId: string, answer: QuestionAnswer): Promise<boolean> {
    if (typeof answer === 'object') return false;
    const textAnswer = typeof answer === 'string';
    // reject empty text, oversized input, and terminal control sequences
    if (questionId.length === 0 || (textAnswer
      ? !validPrompt(answer) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(answer)
      : !Number.isInteger(answer) || answer < 0 || answer > 15)) return false;
    // serialize question delivery with active input and restart handoffs
    if (this.locks.busy(agentId)) return false;
    const release = this.locks.begin(agentId);
    // respect an existing lifecycle reservation
    if (release === undefined) return false;
    const version = this.locks.version(agentId);
    try {
      const first = await this.discovery.target(agentId);
      // require a live question-capable agent
      if (!first) return false;
      const adapter = this.resolveAdapter(first.agent.kind);
      if (adapter?.questions === undefined) return false;
      const workspace = this.workspaceFor(first.agent.home);
      let question = await adapter.questions.pending?.(workspace, first.agent.pane.paneId);
      let capture: string | undefined;
      // re-derive reported questions from their current hook payload and pane
      if (question === undefined && adapter.questions.reported !== undefined) {
        const payload = this.reportedQuestionPayload(agentId);
        capture = payload === undefined ? undefined : await this.tmux.capture(first.socket, first.agent.pane.paneId).catch(() => undefined);
        question = capture === undefined ? undefined : adapter.questions.reported(payload!, capture);
      }
      // re-derive native questions from the current terminal capture
      if (question === undefined && adapter.questions.parse !== undefined) {
        capture = await this.tmux.capture(first.socket, first.agent.pane.paneId).catch(() => undefined);
        question = capture === undefined ? undefined : adapter.questions.parse(capture);
      }
      // refuse stale answers and out-of-range choices
      if (question === undefined || question.id !== questionId || (!textAnswer && answer >= question.choices.length)) return false;
      // only native queued-editor answers may release that editor's suppression
      const queuedQuestion = capture === undefined ? undefined : adapter.questions.queued?.(capture);
      const targetPane = question.pane?.targetPaneId ?? first.agent.pane.paneId;
      // verify the target and manual-input generation before each delivery stage
      const stillCurrent = async () => {
        const current = await this.discovery.target(agentId);
        return current !== undefined && current.socket.fingerprint === first.socket.fingerprint
          && current.agent.pane.paneId === first.agent.pane.paneId && current.agent.kind === first.agent.kind
          && this.locks.version(agentId) === version;
      };
      // refuse replacement panes or intervening operator input
      if (!await stillCurrent()) return false;
      // preserve cursor-aware numbered selection
      if (!textAnswer) {
        const sent = await this.tmux.sendKeys(first.socket, targetPane, adapter.submission.selectOption(question.pane?.rows?.[answer] ?? answer, question.pane?.selectedIndex));
        // rearm the next follow-up without requiring an observed empty queue
        if (sent && queuedQuestion !== undefined && queuedQuestion.key === undefined) this.openedQueuedQuestions.delete(agentId);
        return sent;
      }
      const keys = capture === undefined ? undefined : adapter.questions.textEntry?.(question, capture);
      // unsupported menus must not receive a normal prompt or an implicit default
      if (keys === undefined) return false;
      // navigate without submitting a recommended option
      if (keys.length > 0 && !await this.tmux.sendKeys(first.socket, targetPane, keys)) return false;
      // recheck after navigation before inserting the answer
      if (!await stillCurrent()) return false;
      const buffer = `rac-${randomBytes(18).toString('base64url')}`;
      // bracketed paste keeps multiline answers and leading digits out of menu shortcuts
      if (!await this.tmux.pastePrompt(first.socket, targetPane, buffer, adapter.questions.textAnswer?.(answer) ?? answer)) return false;
      // never submit into a replacement pane after a slow paste
      if (!await stillCurrent()) return false;
      const sent = await this.tmux.sendKeys(first.socket, targetPane, ['Enter']);
      // text answers release the same follow-up suppression as numbered choices
      if (sent && queuedQuestion !== undefined && queuedQuestion.key === undefined) this.openedQueuedQuestions.delete(agentId);
      return sent;
    } finally { release(); }
  }

  // interrupt a working Agent; a stray interrupt on a finished pane is refused so
  // it can never send a chord that exits the agent or opens a Rewind dialog
  async interrupt(agentId: string): Promise<InterruptOutcome> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return 'unavailable';
    const adapter = this.resolveAdapter(target.agent.kind);
    if (adapter === undefined) return 'unavailable';
    // the interrupt is sent only while the Agent is working or a question is pending
    if (agentAttentionState(target.agent) === 'finished') return 'not-working';
    if (!await this.tmux.sendKeys(target.socket, target.agent.pane.paneId, adapter.submission.interrupt)) return 'unavailable';
    // a reported-state Agent fires no Stop hook on an interrupt; write `finished`
    // ourselves so the pane does not keep looking busy (Codex's title already stops)
    if (reportsOwnState(adapter)) await this.tmux.setReportedAttention(target.socket, target.agent.pane.paneId, 'finished').catch(() => false);
    return 'ok';
  }

  // stop one Agent by killing its pane; a kind with a configured teardown command
  // then gets a best-effort post-stop cleanup in the stopped agent's home
  // (never on cleanup or new-task pane kills, which bypass this path)
  async close(agentId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    if (target === undefined || !await this.tmux.close(target.socket, target.agent.pane.paneId)) return false;
    const teardown = this.teardownFor(target.agent.kind);
    if (teardown !== undefined) {
      const done = await this.tmux.runShell(target.socket, expandCommand(teardown, { identity: target.agent.home })).catch(() => false);
      // a failed teardown never blocks the stop; the setup command is the safety net.
      // the workspace is an agent-controlled path (its cwd), so JSON-encode it — a
      // directory name may hold newlines or control bytes that would forge log lines
      if (!done) console.error(`[prompts] adapters.${target.agent.kind} teardown failed in ${JSON.stringify(target.agent.home)}`);
    }
    return true;
  }
}
