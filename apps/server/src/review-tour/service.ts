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
import { earlierThreadsSnapshot, publicReviewComparison, reviewScope, ReviewTourError, sinceReviewBase, type EarlierThreads, type PublicReviewComparison, type ReviewComparison, type ReviewTour, type ReviewTourCapability, type ReviewTourInput } from './contracts.js';

// `effort` is the run's requested effort, absent for the configured one; `earlierThreads` is the
// snapshot a Since my review start took, which recaptures never read again
export type PreparedReviewTour = { resolved: ResolvedWorkspace; comparison: ReviewComparison; effort?: string; earlierThreads?: EarlierThreads };
// what the Since my review scope reads of GitHub: the Worktree branch's Pull request and its detail
export type SinceReviewGithub = Pick<GithubService, 'repositoryAt' | 'branch' | 'pullRequestDetail'>;

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
    const current = await captureReviewComparison(prepared.resolved, { ...reviewScope(prepared.comparison), includeTests: prepared.comparison.includeTests, includeDocs: prepared.comparison.includeDocs });
    // reject stale narration before publication
    if (current.fingerprint !== prepared.comparison.fingerprint || current.branch !== prepared.comparison.branch) throw new ReviewTourError('stale_during_generation', true);
    // reject a moved or removed Worktree before publication
    if (!sameConfiguredWorkspace(this.discovery, prepared.resolved)) throw new ReviewTourError('target_unavailable', true);
    return { ...generated, ...reviewScope(prepared.comparison), base: prepared.comparison.base, includeTests: prepared.comparison.includeTests, includeDocs: prepared.comparison.includeDocs, fingerprint: prepared.comparison.fingerprint, changes: prepared.comparison.changes, ...sinceReviewBase(prepared.comparison), ...(prepared.earlierThreads === undefined ? {} : { earlierThreads: prepared.earlierThreads }) };
  }

  // The commit of the operator's latest submitted review on the Worktree branch's open Pull request,
  // read fresh from GitHub, and HEAD, which must be that Pull request's head. Only the start sheet
  // and a start read GitHub: every recapture works from the reviewed commit the scope pins.
  async sinceReview(worktreeId: string): Promise<{ reviewedCommit: string; head: string }> {
    return (await this.pullRequestReview(worktreeId)).review;
  }

  // Ready a start of a Since my review tour pinned to `reviewedCommit`, which must still be my latest
  // submitted review. The PR's base branch is fetched so a rebase onto an upstream newer than this
  // checkout has seen does not bring that upstream into the tour, and the reviewed commit is
  // fetched when an amend or force-push left it only on GitHub.
  // It returns the snapshot of my earlier Review threads the tour keeps, from the same read.
  async startSinceReview(worktreeId: string, reviewedCommit: string): Promise<EarlierThreads> {
    const { workspace, review, baseBranch, earlierThreads } = await this.pullRequestReview(worktreeId);
    // a review submitted since the sheet read it
    if (review.reviewedCommit !== reviewedCommit) throw new ReviewTourError('scope_unavailable', true);
    if (baseBranch !== undefined) await fetchOriginBranch(workspace, baseBranch);
    if (!await fetchCommit(workspace, reviewedCommit)) throw new ReviewTourError('reviewed_commit_unreachable', true);
    return earlierThreads;
  }

  private async pullRequestReview(worktreeId: string): Promise<{ workspace: string; review: { reviewedCommit: string; head: string }; baseBranch?: string; earlierThreads: EarlierThreads }> {
    const { workspace, branch } = await this.resolve(worktreeId);
    const pullRequest = branch === undefined ? undefined : await branchPullRequest(this.github, workspace, branch);
    if (pullRequest === undefined) throw new ReviewTourError('no_pull_request', true);
    if (pullRequest === 'unreadable') throw new ReviewTourError('scope_unavailable', true);
    if (pullRequest.viewerReviewCommit === undefined) throw new ReviewTourError('no_submitted_review', true);
    const head = (await resolveHead(workspace)).gitBase;
    if (head !== pullRequest.headSha) {
      // behind is what Update to PR head can fix; anything else is the operator's to sort out
      const remoteRef = updatableRef(pullRequest, branch!);
      const update = remoteRef === undefined ? 'local-commits' : await headUpdate(workspace, head, pullRequest.headSha, remoteRef);
      throw new ReviewTourError(update === 'local-commits' ? 'head_diverged_from_pull_request' : 'head_behind_pull_request', true);
    }
    const earlierThreads = { pullRequest: pullRequest.number, threads: earlierThreadsSnapshot(pullRequest.threads.filter(isEarlierThread)), ...(pullRequest.pageFull?.threads ? { partial: true as const } : {}) };
    return { workspace, review: { reviewedCommit: pullRequest.viewerReviewCommit, head }, ...(pullRequest.baseBranch === undefined ? {} : { baseBranch: pullRequest.baseBranch }), earlierThreads };
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
