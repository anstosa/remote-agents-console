import { randomBytes } from 'node:crypto';
import type { ReviewPreset } from '../review-runs/config.js';
import { acceptsReviewEffort, type ReviewAgentKind } from '../review-runs/kinds.js';
import { askRunLabel, type ReviewRunInfo, type ReviewRunner } from '../review-runs/runner.js';
import { ReviewTourError, type ReviewErrorCode, type StoredReviewTour } from '../review-tour/contracts.js';
import { pendingRunProgress, startedReviewJob, type StartedReviewJob } from '../review-tour/jobs.js';
import type { ReviewTourStore } from '../review-tour/store.js';
import { ASK_JOB_TTL_MS, ASK_TIMEOUT_MS, findingAnchor, guideAskPrompt, linesAnchor, MAX_ASK_ANSWER_BYTES, MAX_ASK_PENDING, MAX_ASK_THREADS, reviewerAskPrompt, type AskAnchor, type AskRequest, type AskThread, type AskTurn } from './contracts.js';

// `run` is an interactive turn's visible Agent, once it is delivered
type PendingAsk = { kind: 'pending'; controller: AbortController; run?: ReviewRunInfo };
type ReadyAsk = { kind: 'ready' };
type FailedAsk = { kind: 'error'; code: ReviewErrorCode; retryable: boolean };
type GoneAsk = { kind: 'gone'; code: 'job_superseded' };
export type AskJobState = PendingAsk | ReadyAsk | FailedAsk | GoneAsk;
// A pending job does not expire: its run has its own timeout, and a turn may wait its turn behind
// others on the same conversation. A settled one is forgotten a minute later.
export type AskJob = { id: string; owner: string; worktreeId: string; thread: Omit<AskThread, 'turns'>; question: string; startedAt: number; expiresAt: number; state: AskJobState; removal?: NodeJS.Timeout };
// a question still being answered, as a reopened tour shows it under its thread, which it may be starting
export type PendingAskTurn = { threadId: string; target: AskThread['target']; anchor: AskAnchor; question: string; job: StartedReviewJob };
// the Worktree a question is asked in, on the branch its stored tour was made on
export type AskTarget = { worktreeId: string; workspace: string; branch: string };
type AskStore = Pick<ReviewTourStore, 'current' | 'codeReview' | 'askThreads' | 'saveAskTurn'>;
// what a question resolves to before it runs: its thread (without turns), its prompt, and how to run it
// a stored run's effort, while its agent still accepts it
const acceptedEffort = (kind: ReviewAgentKind, effort: string | undefined) => effort !== undefined && acceptsReviewEffort(kind, effort) ? effort : undefined;
type ResolvedAsk = { thread: Omit<AskThread, 'turns'>; prompt: string; label: string; model?: string; effort?: string };

// Asks questions about a stored tour as Review runs resuming the conversation of the run asked about
// (ADR 0013), each turn a job polled to its end. A thread takes one question at a time; its turns are
// stored with the tour once settled, so a cancelled or superseded one leaves nothing behind.
export class AskJobs {
  private readonly jobs = new Map<string, AskJob>();

  constructor(private readonly runner: ReviewRunner, private readonly store: AskStore, private readonly presets: () => readonly ReviewPreset[]) {}

  // Ask about the stored tour: refused when the tour is gone or no longer the asked-about Comparison,
  // what the question points at is unknown, it kept no conversation, its agent cannot run, or the
  // question's thread is still answering
  async ask(owner: string, target: AskTarget, request: AskRequest): Promise<{ job: StartedReviewJob; threadId: string }> {
    const stored = await this.store.current(target.worktreeId, target.branch);
    if (stored === undefined) throw new ReviewTourError('target_unavailable', false);
    if (stored.tour.fingerprint !== request.fingerprint) throw new ReviewTourError('stale_during_generation', true);
    const resolved = request.target === 'reviewer' ? await this.resolveReviewer(target, stored, request) : await this.resolveGuide(target, stored, request);
    return await this.start(owner, target, stored, resolved, request.question);
  }

  // A question to the reviewer about one Finding of the tour's Code review, on the Finding's own
  // thread, with the review's preset model and effort while its preset and agent still accept them.
  private async resolveReviewer(target: AskTarget, stored: StoredReviewTour, request: Extract<AskRequest, { target: 'reviewer' }>): Promise<ResolvedAsk> {
    const review = await this.store.codeReview(target.worktreeId, stored.branch, stored.tour.fingerprint);
    const finding = review?.findings.find(candidate => candidate.id === request.findingId);
    const change = finding === undefined ? undefined : stored.tour.changes.find(candidate => candidate.id === finding.changeId);
    if (review === undefined || finding === undefined || change === undefined) throw new ReviewTourError('target_unavailable', false);
    const { conversation } = review;
    if (conversation === undefined) throw new ReviewTourError('conversation_unavailable', false);
    const kind = review.preset.agent;
    const anchor = findingAnchor(finding, change);
    const model = this.presets().find(preset => preset.id === review.preset.id && preset.agent === kind)?.model;
    const effort = acceptedEffort(kind, review.effort);
    return { thread: { id: finding.id, target: 'reviewer', kind, conversation, anchor }, prompt: reviewerAskPrompt(finding, anchor, request.question), label: askRunLabel(review.preset.label), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
  }

  // A question to the tour's guide, in the tour's own conversation with the model and effort it ran
  // on: about new lines of one of its Changes, on a new thread, or on one of its existing threads.
  private async resolveGuide(target: AskTarget, stored: StoredReviewTour, request: Exclude<AskRequest, { target: 'reviewer' }>): Promise<ResolvedAsk> {
    const { guide } = stored.tour;
    if (guide === undefined) throw new ReviewTourError('conversation_unavailable', false);
    let thread: Omit<AskThread, 'turns'> | undefined;
    if ('threadId' in request) {
      const existing = (await this.store.askThreads(target.worktreeId, stored.branch, stored.tour.fingerprint)).find(candidate => candidate.id === request.threadId && candidate.target === 'guide');
      if (existing !== undefined) { const { turns: _turns, ...rest } = existing; thread = rest; }
    } else {
      const change = stored.tour.changes.find(candidate => candidate.id === request.lines.changeId);
      const anchor = change === undefined ? undefined : linesAnchor(request.lines, change);
      if (anchor !== undefined && anchor.excerpt !== '') thread = { id: `ask_${randomBytes(12).toString('base64url')}`, target: 'guide', kind: guide.agent, conversation: guide.conversation, anchor };
      // a new thread must fit beside the stored ones and those still starting, or its answer could not be kept
      const starting = [...this.jobs.values()].filter(job => job.worktreeId === target.worktreeId && job.state.kind === 'pending' && job.thread.target === 'guide').length;
      if (thread !== undefined && (await this.store.askThreads(target.worktreeId, stored.branch, stored.tour.fingerprint)).length + starting >= MAX_ASK_THREADS) throw new ReviewTourError('too_large', false);
    }
    if (thread === undefined) throw new ReviewTourError('target_unavailable', false);
    const effort = acceptedEffort(guide.agent, guide.effort);
    return { thread, prompt: guideAskPrompt(thread.anchor, request.question), label: askRunLabel('Tour guide'), ...(guide.model === undefined ? {} : { model: guide.model }), ...(effort === undefined ? {} : { effort }) };
  }

  // start one resolved question as a job resuming its thread's conversation
  private async start(owner: string, target: AskTarget, stored: StoredReviewTour, resolved: ResolvedAsk, question: string): Promise<{ job: StartedReviewJob; threadId: string }> {
    const { thread, prompt, label, model, effort } = resolved;
    const capability = await this.runner.capability(thread.kind);
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    const waiting = [...this.jobs.values()].filter(job => job.worktreeId === target.worktreeId && job.state.kind === 'pending');
    if (waiting.length >= MAX_ASK_PENDING || waiting.some(job => job.thread.id === thread.id)) throw new ReviewTourError('busy', true);
    const id = randomBytes(18).toString('base64url');
    const startedAt = Date.now();
    const job: AskJob = { id, owner, worktreeId: target.worktreeId, thread, question, startedAt, expiresAt: startedAt + ASK_JOB_TTL_MS, state: { kind: 'pending', controller: new AbortController() } };
    this.jobs.set(id, job);
    const askedAt = new Date(startedAt).toISOString();
    void this.run(job, async signal => {
      const output = await this.runner.run({ kind: thread.kind, workspace: target.workspace, worktreeId: target.worktreeId, prompt, reply: { kind: 'text' }, resume: thread.conversation, followUps: true, timeoutMs: ASK_TIMEOUT_MS, maxOutputBytes: MAX_ASK_ANSWER_BYTES, label, ...pendingRunProgress(() => job.state), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }, signal);
      return String(output.value);
    }, async turn => await this.store.saveAskTurn(target.worktreeId, stored.branch, stored.tour.fingerprint, thread, { id, question, askedAt, ...turn }));
    return { job: startedReviewJob(job), threadId: thread.id };
  }

  // Answer one turn and store it, answered or failed; a cancelled or superseded turn is not stored. A
  // turn the store refuses (the tour or its review changed meanwhile) is superseded; one it fails to
  // write is a failed job, which the asker sees though the thread does not hold it.
  private async run(job: AskJob, answer: (signal: AbortSignal) => Promise<string>, save: (turn: Pick<AskTurn, 'answer' | 'error'>) => Promise<boolean>): Promise<void> {
    const signal = (job.state as PendingAsk).controller.signal;
    let turn: Pick<AskTurn, 'answer' | 'error'>;
    try { turn = { answer: await answer(signal) }; } catch (error) {
      const typed = error instanceof ReviewTourError ? error : new ReviewTourError('generation_failed', true);
      turn = { error: { code: typed.code, retryable: typed.retryable } };
    }
    if (this.jobs.get(job.id) !== job || job.state.kind !== 'pending' || signal.aborted) return;
    const saved = await save(turn).catch(() => undefined);
    if (this.jobs.get(job.id) !== job || job.state.kind !== 'pending') return;
    if (saved === false) { this.markGone(job, 'job_superseded'); return; }
    job.state = saved === undefined ? { kind: 'error', code: 'generation_failed', retryable: true } : turn.error === undefined ? { kind: 'ready' } : { kind: 'error', code: turn.error.code as ReviewErrorCode, retryable: turn.error.retryable };
    this.removeLater(job);
  }

  // read an owner-scoped job
  get(owner: string, id: string): AskJob | undefined {
    const job = this.jobs.get(id);
    return job?.owner === owner ? job : undefined;
  }

  // the owner's questions still being answered in one Worktree
  pending(owner: string, worktreeId: string): PendingAskTurn[] {
    return [...this.jobs.values()].filter(job => job.owner === owner && job.worktreeId === worktreeId && job.state.kind === 'pending').map(job => ({ threadId: job.thread.id, target: job.thread.target, anchor: job.thread.anchor, question: job.question, job: startedReviewJob(job) }));
  }

  // A new tour, a dismissal or a Remove ends one Worktree's questions: their turns stop, and the Agents
  // kept for follow-ups close (one still answering closes once it has). A replacing Code review ends
  // only the questions to the reviewer (`target`), leaving the guide's kept Agent; the old reviewer's
  // closes once idle.
  async supersedeWorktree(worktreeId: string, target?: AskThread['target']): Promise<void> {
    for (const job of this.jobs.values()) if (job.worktreeId === worktreeId && (target === undefined || job.thread.target === target) && job.state.kind === 'pending') this.markGone(job, 'job_superseded');
    if (target === undefined) await this.runner.closeWorktree(worktreeId).catch(() => undefined);
  }

  // stop every pending question
  close(): void {
    for (const job of this.jobs.values()) {
      if (job.state.kind === 'pending') job.state.controller.abort();
      if (job.removal !== undefined) clearTimeout(job.removal);
    }
    this.jobs.clear();
  }

  private markGone(job: AskJob, code: GoneAsk['code']): void {
    if (job.state.kind === 'pending') job.state.controller.abort();
    job.state = { kind: 'gone', code };
    this.removeLater(job);
  }

  // forget a settled job once its last poll has had a minute to read it; the turn is on its thread
  private removeLater(job: AskJob): void {
    if (job.removal !== undefined) return;
    job.removal = setTimeout(() => { if (this.jobs.get(job.id) === job) this.jobs.delete(job.id); }, 60_000);
    job.removal.unref?.();
  }
}
