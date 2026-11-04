import type { DiscoveryService } from '../discovery/service.js';
import { fetchCommit, fetchOriginBranch, resolveHead } from '../git/comparison.js';
import type { GithubService } from '../github/service.js';
import { headUpdate } from '../git/worktree-state.js';
import { branchPullRequest, updatableRef } from '../pull-requests/switch-service.js';
import type { PullRequestReviewThread } from '../domain/models.js';
import { resolveConfiguredWorkspace, sameConfiguredWorkspace, type ResolvedWorkspace } from '../workspaces/resolver.js';
import { captureReviewComparison } from './diff.js';
import type { ReviewRunProgress } from '../review-runs/runner.js';
import type { ReviewTourGenerator } from './generator.js';
import { earlierThreadsSnapshot, publicReviewComparison, reviewScope, ReviewTourError, sinceReviewBase, type EarlierThreads, type PublicReviewComparison, type ReviewComparison, type ReviewTour, type ReviewTourCapability, type ReviewTourInput, type SinceReviewScope } from './contracts.js';

// `effort` is the run's requested effort, absent for the configured one; `earlierThreads` is the
// snapshot a Since my review start took, which recaptures never read again
export type PreparedReviewTour = { resolved: ResolvedWorkspace; comparison: ReviewComparison; effort?: string; earlierThreads?: EarlierThreads };
// what the Since my review scope reads of GitHub: the Worktree branch's Pull request and its detail
export type SinceReviewGithub = Pick<GithubService, 'repositoryAt' | 'branch' | 'pullRequestDetail'>;
// what a Since my review start pins, read from GitHub by the start sheet
export type SinceReviewPin = Omit<SinceReviewScope, 'scope'>;

// a Review thread I opened and submitted, resolved or not, unless I resolved it myself: an author's
// resolve may have come without a fix
const isEarlierThread = (thread: PullRequestReviewThread): boolean => thread.comments[0]?.mine === true && thread.pending !== true && thread.resolvedBy?.mine !== true;

export class ReviewTourService {
  constructor(private readonly discovery: DiscoveryService, private readonly generator: ReviewTourGenerator, private readonly github: SinceReviewGithub) {}

  // expose the bounded generator capability
  capability(): Promise<ReviewTourCapability> { return this.generator.capability(); }

  // capture a validated generation input; a Since my review start hands in its thread snapshot
  async prepare(worktreeId: string, input: ReviewTourInput, earlierThreads?: EarlierThreads): Promise<PreparedReviewTour> {
    const capability = await this.capability();
    // fail closed without generation support
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    // refuse an effort the tour agent does not accept
    if (input.effort !== undefined && !capability.efforts.includes(input.effort)) throw new ReviewTourError('invalid_request', false);
    const resolved = await this.resolve(worktreeId);
    const comparison = await captureReviewComparison(resolved, input);
    // reject identity changes during capture
    if (!sameConfiguredWorkspace(this.discovery, resolved)) throw new ReviewTourError('target_unavailable', true);
    return { resolved, comparison, ...(input.effort === undefined ? {} : { effort: input.effort }), ...(earlierThreads === undefined ? {} : { earlierThreads }) };
  }

  // generate and revalidate one complete tour
  async generate(prepared: PreparedReviewTour, signal: AbortSignal, progress?: ReviewRunProgress): Promise<ReviewTour> {
    const generated = await this.generator.generate(prepared.comparison, signal, prepared.effort, progress);
    // preserve caller cancellation
    if (signal.aborted) throw new ReviewTourError('cancelled', true);
    const { comparison } = prepared;
    const current = await captureReviewComparison(prepared.resolved, { ...reviewScope(comparison), includeTests: comparison.includeTests, includeDocs: comparison.includeDocs });
    // reject stale narration before publication
    if (current.fingerprint !== comparison.fingerprint || current.branch !== comparison.branch) throw new ReviewTourError('stale_during_generation', true);
    // reject a moved or removed Worktree before publication
    if (!sameConfiguredWorkspace(this.discovery, prepared.resolved)) throw new ReviewTourError('target_unavailable', true);
    const fields = { ...generated, base: comparison.base, includeTests: comparison.includeTests, includeDocs: comparison.includeDocs, fingerprint: comparison.fingerprint, changes: comparison.changes };
    if (comparison.scope !== 'since-review') return { ...fields, ...reviewScope(comparison) } as ReviewTour;
    // a Since my review tour keeps the snapshot its start took
    if (prepared.earlierThreads === undefined) throw new ReviewTourError('stale_during_generation', true);
    return { ...fields, ...reviewScope(comparison), ...sinceReviewBase(comparison), earlierThreads: prepared.earlierThreads };
  }

  // The commit of the operator's latest submitted review on the Worktree branch's open Pull request
  // and that Pull request's base branch, read fresh from GitHub, and HEAD, which must be that Pull
  // request's head. Only the start sheet and a start read GitHub: every recapture works from the
  // reviewed commit and base branch the scope pins.
  async sinceReview(worktreeId: string): Promise<SinceReviewPin & { head: string }> {
    return (await this.pullRequestReview(worktreeId)).review;
  }

  // Ready a start of a Since my review tour pinned to `pin`, which must still be my latest submitted
  // review and the Pull request's base branch. That base is fetched into `origin/<base>`, the only
  // base the tour replays onto, so a rebase onto an upstream newer than this checkout has seen does
  // not bring that upstream into the tour; a start that cannot fetch it is refused. The reviewed
  // commit is fetched when an amend or force-push left it only on GitHub.
  // It returns the snapshot of my earlier Review threads the tour keeps, from the same read, and
  // the HEAD it checked was the Pull request's head.
  async startSinceReview(worktreeId: string, pin: SinceReviewPin): Promise<{ earlierThreads: EarlierThreads; head: string }> {
    const { workspace, review, earlierThreads } = await this.pullRequestReview(worktreeId);
    // a review submitted, or the Pull request retargeted, since the tour was set up
    if (review.reviewedCommit !== pin.reviewedCommit || review.baseBranch !== pin.baseBranch) throw new ReviewTourError('since_review_outdated', true);
    if (!await fetchOriginBranch(workspace, pin.baseBranch)) throw new ReviewTourError('base_branch_unavailable', true);
    if (!await fetchCommit(workspace, pin.reviewedCommit)) throw new ReviewTourError('reviewed_commit_unreachable', true);
    return { earlierThreads, head: review.head };
  }

  private async pullRequestReview(worktreeId: string): Promise<{ workspace: string; review: SinceReviewPin & { head: string }; earlierThreads: EarlierThreads }> {
    const { workspace, branch } = await this.resolve(worktreeId);
    const pullRequest = branch === undefined ? undefined : await branchPullRequest(this.github, workspace, branch);
    if (pullRequest === undefined) throw new ReviewTourError('no_pull_request', true);
    if (pullRequest === 'unreadable') throw new ReviewTourError('scope_unavailable', true);
    if (pullRequest.viewerReviewCommit === undefined) throw new ReviewTourError('no_submitted_review', true);
    // the base is what tells upstream's changes from the author's
    if (pullRequest.baseBranch === undefined) throw new ReviewTourError('scope_unavailable', true);
    const head = (await resolveHead(workspace)).gitBase;
    if (head !== pullRequest.headSha) {
      // behind is what Update to PR head can fix; anything else is the operator's to sort out
      const remoteRef = updatableRef(pullRequest, branch!);
      const update = remoteRef === undefined ? 'local-commits' : await headUpdate(workspace, head, pullRequest.headSha, remoteRef);
      throw new ReviewTourError(update === 'local-commits' ? 'head_diverged_from_pull_request' : 'head_behind_pull_request', true);
    }
    const mine = pullRequest.threads.filter(isEarlierThread);
    const threads = earlierThreadsSnapshot(mine);
    // older threads may be missing when GitHub's page was full or the snapshot's budget dropped some
    const earlierThreads = { pullRequest: pullRequest.number, threads, ...(pullRequest.pageFull?.threads || threads.length < mine.length ? { partial: true as const } : {}) };
    return { workspace, review: { reviewedCommit: pullRequest.viewerReviewCommit, baseBranch: pullRequest.baseBranch, head }, earlierThreads };
  }

  // capture the Worktree's current Comparison without generation
  async current(worktreeId: string, input: ReviewTourInput): Promise<ReviewComparison> {
    return await captureReviewComparison(await this.resolve(worktreeId), input);
  }

  // recompute current source identity without generation
  async fingerprint(worktreeId: string, input: ReviewTourInput): Promise<{ comparison: PublicReviewComparison; empty: boolean }> {
    const comparison = await this.current(worktreeId, input);
    return { comparison: publicReviewComparison(comparison), empty: comparison.changes.length === 0 };
  }

  private async resolve(worktreeId: string): Promise<ResolvedWorkspace> {
    const resolved = await resolveConfiguredWorkspace(this.discovery, worktreeId);
    if (resolved === undefined) throw new ReviewTourError('target_unavailable', true);
    return resolved;
  }
}
