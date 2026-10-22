import { randomBytes } from 'node:crypto';
import { ReviewTourError, type ReviewErrorCode } from '../review-tour/contracts.js';
import { pendingRunProgress, startedReviewJob, type StartedReviewJob } from '../review-tour/jobs.js';
import type { OrphanRecovery } from '../review-runs/interactive.js';
import type { ReviewRunInfo } from '../review-runs/runner.js';
import type { PreparedReviewTour } from '../review-tour/service.js';
import type { ReviewTourStore } from '../review-tour/store.js';
import { CODE_REVIEW_JOB_TTL_MS, codeReviewFrom, codeReviewReplyError, parseCodeReviewRecovery, type CodeReview, type CodeReviewOptions } from './contracts.js';
import type { CodeReviewer } from './reviewer.js';

// `run` is an interactive run's visible Agent, once it has launched
type PendingJob = { kind: 'pending'; controller: AbortController; run?: ReviewRunInfo };
type ReadyJob = { kind: 'ready'; review: CodeReview };
type FailedJob = { kind: 'error'; code: ReviewErrorCode; retryable: boolean };
type GoneJob = { kind: 'gone'; code: 'job_cancelled' | 'job_superseded' | 'job_expired' };
export type CodeReviewJobState = PendingJob | ReadyJob | FailedJob | GoneJob;
export type StoredCodeReviewJob = { id: string; owner: string; agentId: string; worktreeId: string; fingerprint: string; generation?: number; startedAt: number; expiresAt: number; state: CodeReviewJobState; expiry: NodeJS.Timeout; removal?: NodeJS.Timeout };
export type SettledCodeReviewJob = Pick<StoredCodeReviewJob, 'agentId' | 'worktreeId' | 'fingerprint' | 'state'>;
type CodeReviewStore = Pick<ReviewTourStore, 'beginCodeReview' | 'saveCodeReviewIfCurrent' | 'storedTour'>;

// one Code review job per owner and Worktree, latest wins; a new tour supersedes every one for
// its Worktree. Findings publish even when the Worktree changed during the run (ADR 0010).
export class CodeReviewJobs {
  private readonly jobs = new Map<string, StoredCodeReviewJob>();
  private readonly latestByWorktree = new Map<string, string>();

  constructor(private readonly reviewer: CodeReviewer, private readonly store?: CodeReviewStore, private readonly onSettled?: (job: SettledCodeReviewJob) => void | Promise<void>) {}

  // check a request against its preset before anything starts
  async validate(options: CodeReviewOptions): Promise<void> { await this.reviewer.resolve(options); }

  // start one review of a prepared Comparison
  async start(owner: string, agentId: string, prepared: PreparedReviewTour, options: CodeReviewOptions): Promise<StartedReviewJob> {
    const resolved = await this.reviewer.resolve(options);
    // an empty selection has nothing to review
    if (prepared.comparison.changes.length === 0) throw new ReviewTourError('invalid_request', false);
    const worktreeId = prepared.comparison.worktreeId;
    const previous = this.jobs.get(this.latestByWorktree.get(this.latestKey(owner, worktreeId)) ?? '');
    // retain an owner-scoped superseded tombstone
    if (previous !== undefined) this.markGone(previous, 'job_superseded');
    const id = randomBytes(18).toString('base64url');
    const startedAt = Date.now();
    const expiresAt = startedAt + CODE_REVIEW_JOB_TTL_MS;
    const controller = new AbortController();
    const generation = this.store?.beginCodeReview(worktreeId);
    const job: StoredCodeReviewJob = { id, owner, agentId, worktreeId, fingerprint: prepared.comparison.fingerprint, ...(generation === undefined ? {} : { generation }), startedAt, expiresAt, state: { kind: 'pending', controller }, expiry: setTimeout(() => this.expire(id), CODE_REVIEW_JOB_TTL_MS) };
    job.expiry.unref?.();
    this.jobs.set(id, job);
    this.latestByWorktree.set(this.latestKey(owner, worktreeId), id);
    void this.run(job, prepared, resolved);
    return startedReviewJob(job);
  }

  // publish a terminal review result
  private async run(job: StoredCodeReviewJob, prepared: PreparedReviewTour, resolved: Awaited<ReturnType<CodeReviewer['resolve']>>): Promise<void> {
    try {
      const review = await this.reviewer.run(prepared.comparison, resolved, (job.state as PendingJob).controller.signal, pendingRunProgress(() => job.state));
      // ignore superseded completions
      if (this.jobs.get(job.id) !== job || job.state.kind !== 'pending') return;
      const branch = prepared.comparison.branch;
      // durably retain branch-bound reviews beside the tour
      if (this.store !== undefined && branch !== undefined && job.generation !== undefined) {
        const stored = await this.store.saveCodeReviewIfCurrent(job.worktreeId, branch, review, job.generation);
        // require persistence when a store is configured
        if (stored === undefined) throw new ReviewTourError('generation_failed', true);
        // discard a review a newer tour or review replaced
        if (stored === false) { this.markGone(job, 'job_superseded'); return; }
      }
      // ignore jobs superseded during persistence
      if (this.jobs.get(job.id) !== job || job.state.kind !== 'pending') return;
      job.state = { kind: 'ready', review };
    } catch (error) {
      // ignore cancelled or removed jobs
      if (this.jobs.get(job.id) !== job || job.state.kind !== 'pending') return;
      const typed = error instanceof ReviewTourError ? error : new ReviewTourError('generation_failed', true);
      job.state = { kind: 'error', code: typed.code, retryable: typed.retryable };
    }
    // publish the settled state
    await Promise.resolve(this.onSettled?.({ agentId: job.agentId, worktreeId: job.worktreeId, fingerprint: job.fingerprint, state: job.state })).catch(() => undefined);
  }

  // Finish a review a server restart orphaned, from the recovery its run left. Its reply joins the
  // stored tour while that is still the reviewed Comparison and nothing has begun or cleared a
  // review of the Worktree since the restart. The job itself is gone: no pending state, no polling.
  async recover(value: unknown, agentId: string): Promise<OrphanRecovery | undefined> {
    const run = parseCodeReviewRecovery(value);
    const store = this.store;
    if (run === undefined || store === undefined) return undefined;
    const stored = await store.storedTour(run.worktreeId);
    if (stored?.branch !== run.branch || stored.tour.fingerprint !== run.fingerprint) return undefined;
    const { kind: _kind, worktreeId, branch, ...reviewed } = run;
    return {
      validate: codeReviewReplyError,
      save: async (output, conversation) => {
        const review = codeReviewFrom(output, stored.tour.changes, reviewed, conversation);
        if (review === undefined || !await store.saveCodeReviewIfCurrent(worktreeId, branch, review, 0)) return false;
        await Promise.resolve(this.onSettled?.({ agentId, worktreeId, fingerprint: review.fingerprint, state: { kind: 'ready', review } })).catch(() => undefined);
        return true;
      }
    };
  }

  // read an owner-scoped job
  get(owner: string, id: string): StoredCodeReviewJob | undefined {
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

  // supersede every owner's review of one Worktree: a new tour or a dismissal replaces it
  supersedeWorktree(worktreeId: string): void {
    for (const job of this.jobs.values()) {
      if (job.worktreeId === worktreeId && job.state.kind !== 'gone') this.markGone(job, 'job_superseded');
    }
  }

  // the owner's pending review of one Comparison, so a reopened tour resumes polling
  pending(owner: string, worktreeId: string, fingerprint: string): StartedReviewJob | undefined {
    const job = this.jobs.get(this.latestByWorktree.get(this.latestKey(owner, worktreeId)) ?? '');
    return job?.state.kind === 'pending' && job.fingerprint === fingerprint ? startedReviewJob(job) : undefined;
  }

  // the latest review of one Comparison across owners: running, or failed
  status(worktreeId: string, fingerprint: string): 'running' | 'failed' | undefined {
    let latest: StoredCodeReviewJob | undefined;
    // pick the newest live job for this Comparison
    for (const job of this.jobs.values()) {
      if (job.worktreeId === worktreeId && job.fingerprint === fingerprint && job.state.kind !== 'gone' && (latest === undefined || job.expiresAt >= latest.expiresAt)) latest = job;
    }
    return latest?.state.kind === 'pending' ? 'running' : latest?.state.kind === 'error' ? 'failed' : undefined;
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
  private markGone(job: StoredCodeReviewJob, code: GoneJob['code']): void {
    // abort an active run
    if (job.state.kind === 'pending') job.state.controller.abort();
    job.state = { kind: 'gone', code };
    // clear latest ownership
    const latestKey = this.latestKey(job.owner, job.worktreeId);
    if (this.latestByWorktree.get(latestKey) === job.id) this.latestByWorktree.delete(latestKey);
  }

  // remove one stored job
  private remove(id: string): void {
    const job = this.jobs.get(id);
    // clear active resources
    if (job !== undefined) {
      if (job.state.kind === 'pending') job.state.controller.abort();
      clearTimeout(job.expiry);
      if (job.removal !== undefined) clearTimeout(job.removal);
      const latestKey = this.latestKey(job.owner, job.worktreeId);
      if (this.latestByWorktree.get(latestKey) === id) this.latestByWorktree.delete(latestKey);
    }
    this.jobs.delete(id);
  }

  // stop every pending review
  close(): void {
    for (const id of [...this.jobs.keys()]) this.remove(id);
  }

  // scope latest jobs by owner and worktree
  private latestKey(owner: string, worktreeId: string): string { return `${owner}\0${worktreeId}`; }
}
