import { randomBytes } from 'node:crypto';
import { sameCodeReviewOptions, type CodeReviewOptions } from '../code-review/contracts.js';
import type { AskJobs } from '../asks/jobs.js';
import type { CodeReviewJobs } from '../code-review/jobs.js';
import type { ReviewRunInfo, ReviewRunProgress } from '../review-runs/runner.js';
import { publicReviewComparison, REVIEW_JOB_POLL_MS, REVIEW_JOB_TTL_MS, ReviewTourError, type PublicReviewComparison, type ReviewErrorCode, type ReviewTour, type ReviewTourInput } from './contracts.js';
import type { PreparedReviewTour, ReviewTourService } from './service.js';
import type { ReviewTourStore } from './store.js';

// `run` is an interactive run's visible Agent, once it has launched
type PendingJob = { kind: 'pending'; controller: AbortController; run?: ReviewRunInfo };
type ReadyJob = { kind: 'ready'; tour: ReviewTour };
type EmptyJob = { kind: 'empty'; comparison: PublicReviewComparison };
type FailedJob = { kind: 'error'; code: ReviewErrorCode; retryable: boolean };
type GoneJob = { kind: 'gone'; code: 'job_cancelled' | 'job_superseded' | 'job_expired' };
export type ReviewJobState = PendingJob | ReadyJob | EmptyJob | FailedJob | GoneJob;
export type StoredReviewJob = { id: string; owner: string; agentId: string; worktreeId: string; persistenceVersion: number; startedAt: number; expiresAt: number; state: ReviewJobState; expiry: NodeJS.Timeout; removal?: NodeJS.Timeout };
// a pending job's descriptor; `startedAt` lets a reloaded client keep counting the run's time
export type StartedReviewJob = { id: string; expiresAt: string; retryAfterMs: number; startedAt: string };
// a pending start carries the Code review job started beside the tour, when one was requested
type ReviewJobStart = { kind: 'empty'; comparison: PublicReviewComparison } | { kind: 'pending'; job: StartedReviewJob; codeReview?: { job: StartedReviewJob } };
type IdempotentStart = { agentId: string; input: ReviewTourInput; codeReview?: CodeReviewOptions; promise: Promise<ReviewJobStart>; expiry?: NodeJS.Timeout };
export type CompletedReviewJob = { agentId: string; worktreeId: string; prepared: PreparedReviewTour; tour: ReviewTour };

// the descriptor of a stored tour or Code review job
export function startedReviewJob(job: { id: string; startedAt: number; expiresAt: number }): StartedReviewJob {
  return { id: job.id, expiresAt: new Date(job.expiresAt).toISOString(), retryAfterMs: REVIEW_JOB_POLL_MS, startedAt: new Date(job.startedAt).toISOString() };
}

// record an interactive run's Agent and question state on its job while the job is still pending
export function pendingRunProgress(state: () => { kind: string; run?: ReviewRunInfo }): ReviewRunProgress {
  return {
    onStarted: ({ agentId }) => { const current = state(); if (current.kind === 'pending') current.run = { agentId, needsInput: false }; },
    onAttention: needsInput => { const current = state(); if (current.kind === 'pending' && current.run !== undefined) current.run = { ...current.run, needsInput }; }
  };
}

export class ReviewTourJobs {
  private readonly jobs = new Map<string, StoredReviewJob>();
  private readonly latestByWorktree = new Map<string, string>();
  private readonly persistenceVersions = new Map<string, number>();
  private readonly idempotentStarts = new Map<string, IdempotentStart>();

  // `codeReviews` runs a Code review beside a tour that asks for one; every new tour supersedes it,
  // and the questions asked about the tour it replaces
  constructor(private readonly service: ReviewTourService, private readonly store?: ReviewTourStore, private readonly onStored?: (review: CompletedReviewJob) => void | Promise<void>, private readonly codeReviews?: CodeReviewJobs, private readonly asks?: Pick<AskJobs, 'supersedeWorktree'>) {}

  // start one latest-wins generation, with a Code review of the same Comparison when requested
  async start(owner: string, agentId: string, input: ReviewTourInput, requestId?: string, codeReview?: CodeReviewOptions): Promise<ReviewJobStart> {
    // preserve legacy callers without retry identity
    if (requestId === undefined) return await this.create(owner, agentId, input, codeReview);
    const key = `${owner}\0${requestId}`;
    const existing = this.idempotentStarts.get(key);
    // replay only the same logical request
    if (existing !== undefined) {
      // reject request-key reuse across inputs
      if (existing.agentId !== agentId || !this.sameInput(existing.input, input) || !sameCodeReviewOptions(existing.codeReview, codeReview)) throw new ReviewTourError('invalid_request', false);
      return await existing.promise;
    }
    const promise = this.create(owner, agentId, input, codeReview);
    const retained: IdempotentStart = { agentId, input, ...(codeReview === undefined ? {} : { codeReview }), promise };
    this.idempotentStarts.set(key, retained);
    try {
      const started = await promise;
      // retain completed starts through the retry window
      if (this.idempotentStarts.get(key) === retained) {
        retained.expiry = setTimeout(() => this.idempotentStarts.delete(key), REVIEW_JOB_TTL_MS);
        retained.expiry.unref?.();
      }
      return started;
    } catch (error) {
      // allow retries after a terminal start failure
      if (this.idempotentStarts.get(key) === retained) this.idempotentStarts.delete(key);
      throw error;
    }
  }

  // create one latest-wins generation
  private async create(owner: string, agentId: string, input: ReviewTourInput, codeReview?: CodeReviewOptions): Promise<ReviewJobStart> {
    // refuse an unusable Code review before anything starts
    if (codeReview !== undefined) {
      if (this.codeReviews === undefined) throw new ReviewTourError('capability_unavailable', false);
      await this.codeReviews.validate(codeReview);
    }
    const prepared = await this.service.prepare(agentId, input);
    const storeWithCurrency = this.store as (ReviewTourStore & { invalidate?: ReviewTourStore['invalidate']; saveIfCurrent?: ReviewTourStore['saveIfCurrent'] }) | undefined;
    const persistenceVersion = await storeWithCurrency?.invalidate?.(prepared.comparison.worktreeId, prepared.comparison.branch) ?? (this.persistenceVersions.get(prepared.comparison.worktreeId) ?? 0) + 1;
    this.persistenceVersions.set(prepared.comparison.worktreeId, persistenceVersion);
    this.supersede(owner, prepared);
    // a new tour replaces the Worktree's Code review
    this.codeReviews?.supersedeWorktree(prepared.comparison.worktreeId);
    void this.asks?.supersedeWorktree(prepared.comparison.worktreeId, 'tour');
    // skip model generation for empty selections
    if (prepared.comparison.changes.length === 0) return { kind: 'empty', comparison: publicReviewComparison(prepared.comparison) };
    const id = randomBytes(18).toString('base64url');
    const startedAt = Date.now();
    const expiresAt = startedAt + REVIEW_JOB_TTL_MS;
    const controller = new AbortController();
    const job: StoredReviewJob = { id, owner, agentId, worktreeId: prepared.comparison.worktreeId, persistenceVersion, startedAt, expiresAt, state: { kind: 'pending', controller }, expiry: setTimeout(() => this.expire(id), REVIEW_JOB_TTL_MS) };
    job.expiry.unref?.();
    this.jobs.set(id, job);
    this.latestByWorktree.set(this.latestKey(owner, job.worktreeId), id);
    void this.run(job, prepared);
    // review the very Comparison the tour narrates
    const review = codeReview === undefined || this.codeReviews === undefined ? undefined : await this.codeReviews.start(owner, agentId, prepared, codeReview);
    return { kind: 'pending', job: startedReviewJob(job), ...(review === undefined ? {} : { codeReview: { job: review } }) };
  }

  // publish a terminal generation result
  private async run(job: StoredReviewJob, prepared: PreparedReviewTour): Promise<void> {
    try {
      const tour = await this.service.generate(prepared, (job.state as PendingJob).controller.signal, pendingRunProgress(() => job.state));
      const current = this.jobs.get(job.id);
      // ignore superseded completions
      if (current !== job || current.state.kind !== 'pending') return;
      // durably retain branch-bound completed tours
      if (this.store !== undefined && prepared.comparison.branch !== undefined) {
        const storeWithCurrency = this.store as ReviewTourStore & { saveIfCurrent?: ReviewTourStore['saveIfCurrent'] };
        const conditionalSave = storeWithCurrency?.saveIfCurrent;
        // preserve simple injected stores while production uses atomic currency
        const stored = conditionalSave === undefined
          ? await this.store.save(prepared.comparison.worktreeId, prepared.comparison.branch, tour)
          : await conditionalSave.call(this.store, prepared.comparison.worktreeId, prepared.comparison.branch, tour, job.persistenceVersion);
        // require persistence when a store is configured
        if (stored === undefined) throw new ReviewTourError('generation_failed', true);
        // discard superseded persistence attempts
        if (stored === false) { this.markGone(job, 'job_superseded'); return; }
      }
      const retained = this.jobs.get(job.id);
      // ignore jobs superseded during persistence
      if (retained !== job || retained.state.kind !== 'pending') return;
      retained.state = { kind: 'ready', tour };
      // publish the new footer state
      await this.onStored?.({ agentId: job.agentId, worktreeId: job.worktreeId, prepared, tour });
    } catch (error) {
      const current = this.jobs.get(job.id);
      // ignore cancelled or removed jobs
      if (current !== job || current.state.kind !== 'pending') return;
      const typed = error instanceof ReviewTourError ? error : new ReviewTourError('generation_failed', true);
      current.state = { kind: 'error', code: typed.code, retryable: typed.retryable };
    }
  }

  // cancel earlier worktree generation
  private supersede(owner: string, prepared: PreparedReviewTour): void {
    const previousId = this.latestByWorktree.get(this.latestKey(owner, prepared.comparison.worktreeId));
    const previous = previousId === undefined ? undefined : this.jobs.get(previousId);
    // retain an owner-scoped superseded tombstone
    if (previous !== undefined) this.markGone(previous, 'job_superseded');
  }

  // read an owner-scoped job
  get(owner: string, id: string): StoredReviewJob | undefined {
    const job = this.jobs.get(id);
    // hide cross-owner identifiers
    return job?.owner === owner ? job : undefined;
  }

  // cancel an owner-scoped job
  cancel(owner: string, id: string): boolean {
    const job = this.get(owner, id);
    // reject unknown jobs
    if (job === undefined) return false;
    this.markGone(job, 'job_cancelled');
    return true;
  }

  // expire private job results
  private expire(id: string): void {
    const job = this.jobs.get(id);
    // ignore removed jobs
    if (job === undefined) return;
    this.markGone(job, 'job_expired');
    job.removal = setTimeout(() => this.remove(id), 60_000);
    job.removal.unref?.();
  }

  // retain only a bounded gone marker
  private markGone(job: StoredReviewJob, code: GoneJob['code']): void {
    // abort active generation
    if (job.state.kind === 'pending') {
      job.state.controller.abort();
      // serialize cancellation behind any active persistence
      const conditionalStore = this.store as (ReviewTourStore & { invalidateIfCurrent?: ReviewTourStore['invalidateIfCurrent'] }) | undefined;
      void conditionalStore?.invalidateIfCurrent?.(job.worktreeId, job.persistenceVersion).catch(() => undefined);
    }
    job.state = { kind: 'gone', code };
    // clear latest ownership
    const latestKey = this.latestKey(job.owner, job.worktreeId);
    if (this.latestByWorktree.get(latestKey) === job.id) this.latestByWorktree.delete(latestKey);
  }

  // remove one stored job
  private remove(id: string): void {
    const job = this.jobs.get(id);
    // clear active resources
    if (job?.state.kind === 'pending') job.state.controller.abort();
    if (job !== undefined) {
      clearTimeout(job.expiry);
      if (job.removal !== undefined) clearTimeout(job.removal);
      const latestKey = this.latestKey(job.owner, job.worktreeId);
      if (this.latestByWorktree.get(latestKey) === id) this.latestByWorktree.delete(latestKey);
    }
    this.jobs.delete(id);
  }

  // stop every pending generation
  close(): void {
    // remove all jobs
    for (const id of [...this.jobs.keys()]) this.remove(id);
    // clear retained start identities
    for (const start of this.idempotentStarts.values()) {
      // clear completed retention timers
      if (start.expiry !== undefined) clearTimeout(start.expiry);
    }
    this.idempotentStarts.clear();
  }

  // scope latest jobs by owner and worktree
  private latestKey(owner: string, worktreeId: string): string { return `${owner}\0${worktreeId}`; }

  // compare one fixed generation request
  private sameInput(left: ReviewTourInput, right: ReviewTourInput): boolean {
    return left.scope === right.scope && left.commit === right.commit && left.includeTests === right.includeTests && left.includeDocs === right.includeDocs && left.effort === right.effort;
  }
}
