import { randomBytes } from 'node:crypto';
import type { ReviewPreset } from '../review-runs/config.js';
import { acceptsReviewEffort } from '../review-runs/kinds.js';
import { askRunLabel, type ReviewRunInfo, type ReviewRunner } from '../review-runs/runner.js';
import { ReviewTourError, type ReviewErrorCode, type StoredReviewTour } from '../review-tour/contracts.js';
import { pendingRunProgress, startedReviewJob, type StartedReviewJob } from '../review-tour/jobs.js';
import type { ReviewTourStore } from '../review-tour/store.js';
import { ASK_JOB_TTL_MS, ASK_TIMEOUT_MS, findingAnchor, MAX_ASK_ANSWER_BYTES, reviewerAskPrompt, type AskRequest, type AskThread, type AskTurn } from './contracts.js';

// `run` is an interactive turn's visible Agent, once it is delivered
type PendingAsk = { kind: 'pending'; controller: AbortController; run?: ReviewRunInfo };
type ReadyAsk = { kind: 'ready' };
type FailedAsk = { kind: 'error'; code: ReviewErrorCode; retryable: boolean };
type GoneAsk = { kind: 'gone'; code: 'job_superseded' };
export type AskJobState = PendingAsk | ReadyAsk | FailedAsk | GoneAsk;
// A pending job does not expire: its run has its own timeout, and a turn may wait its turn behind
// others on the same conversation. A settled one is forgotten a minute later.
export type AskJob = { id: string; owner: string; worktreeId: string; threadId: string; question: string; startedAt: number; expiresAt: number; state: AskJobState; removal?: NodeJS.Timeout };
// a question still being answered, as a reopened tour shows it under its thread
export type PendingAskTurn = { threadId: string; question: string; job: StartedReviewJob };
// the Worktree a question is asked in, on the branch its stored tour was made on
export type AskTarget = { worktreeId: string; workspace: string; branch: string };
type AskStore = Pick<ReviewTourStore, 'current' | 'codeReview' | 'saveAskTurn'>;
// what a question resolves to before it runs: its thread (without turns), its prompt, and how to run it
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
    return await this.start(owner, target, stored, await this.resolveReviewer(target, stored, request), request.question);
  }

  // A question to the reviewer about one Finding of the tour's Code review, on the Finding's own
  // thread, with the review's preset model and effort while its preset and agent still accept them.
  private async resolveReviewer(target: AskTarget, stored: StoredReviewTour, request: AskRequest): Promise<ResolvedAsk> {
    const review = await this.store.codeReview(target.worktreeId, stored.branch, stored.tour.fingerprint);
    const finding = review?.findings.find(candidate => candidate.id === request.findingId);
    const change = finding === undefined ? undefined : stored.tour.changes.find(candidate => candidate.id === finding.changeId);
    if (review === undefined || finding === undefined || change === undefined) throw new ReviewTourError('target_unavailable', false);
    const { conversation } = review;
    if (conversation === undefined) throw new ReviewTourError('conversation_unavailable', false);
    const kind = review.preset.agent;
    const anchor = findingAnchor(finding, change);
    const model = this.presets().find(preset => preset.id === review.preset.id && preset.agent === kind)?.model;
    const effort = review.effort !== undefined && acceptsReviewEffort(kind, review.effort) ? review.effort : undefined;
    return { thread: { id: finding.id, target: 'reviewer', kind, conversation, anchor }, prompt: reviewerAskPrompt(finding, anchor, request.question), label: askRunLabel(review.preset.label), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
  }

  // start one resolved question as a job resuming its thread's conversation
  private async start(owner: string, target: AskTarget, stored: StoredReviewTour, resolved: ResolvedAsk, question: string): Promise<{ job: StartedReviewJob; threadId: string }> {
    const { thread, prompt, label, model, effort } = resolved;
    const capability = await this.runner.capability(thread.kind);
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    if ([...this.jobs.values()].some(job => job.worktreeId === target.worktreeId && job.threadId === thread.id && job.state.kind === 'pending')) throw new ReviewTourError('busy', true);
    const id = randomBytes(18).toString('base64url');
    const startedAt = Date.now();
    const job: AskJob = { id, owner, worktreeId: target.worktreeId, threadId: thread.id, question, startedAt, expiresAt: startedAt + ASK_JOB_TTL_MS, state: { kind: 'pending', controller: new AbortController() } };
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
    return [...this.jobs.values()].filter(job => job.owner === owner && job.worktreeId === worktreeId && job.state.kind === 'pending').map(job => ({ threadId: job.threadId, question: job.question, job: startedReviewJob(job) }));
  }

  // A new tour, a dismissal, a replacing Code review or a Remove ends one Worktree's questions: their
  // turns stop, and the Agents kept for their follow-ups close
  async supersedeWorktree(worktreeId: string): Promise<void> {
    for (const job of this.jobs.values()) if (job.worktreeId === worktreeId && job.state.kind === 'pending') this.markGone(job, 'job_superseded');
    await this.runner.closeWorktree(worktreeId).catch(() => undefined);
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
