import type { DiscoveryService } from '../discovery/service.js';
import { fetchCommit, fetchOriginBranch, resolveHead } from '../git/comparison.js';
import type { GithubService } from '../github/service.js';
import { resolveConfiguredWorkspace, sameConfiguredWorkspace, type ResolvedWorkspace } from '../workspaces/resolver.js';
import { captureReviewComparison } from './diff.js';
import type { ReviewRunProgress } from '../review-runs/runner.js';
import type { ReviewTourGenerator } from './generator.js';
import { publicReviewComparison, reviewScope, ReviewTourError, sinceReviewBase, type PublicReviewComparison, type ReviewComparison, type ReviewTour, type ReviewTourCapability, type ReviewTourInput } from './contracts.js';

// `effort` is the run's requested effort, absent for the configured one
export type PreparedReviewTour = { resolved: ResolvedWorkspace; comparison: ReviewComparison; effort?: string };
// what the Since my review scope reads of GitHub: the Worktree branch's Pull request and its detail
export type SinceReviewGithub = Pick<GithubService, 'repositoryAt' | 'branch' | 'pullRequestDetail'>;

export class ReviewTourService {
  constructor(private readonly discovery: DiscoveryService, private readonly generator: ReviewTourGenerator, private readonly github: SinceReviewGithub) {}

  // expose the bounded generator capability
  capability(): Promise<ReviewTourCapability> { return this.generator.capability(); }

  // capture a validated generation input
  async prepare(worktreeId: string, input: ReviewTourInput): Promise<PreparedReviewTour> {
    const capability = await this.capability();
    // fail closed without generation support
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    // refuse an effort the tour agent does not accept
    if (input.effort !== undefined && !capability.efforts.includes(input.effort)) throw new ReviewTourError('invalid_request', false);
    const resolved = await this.resolve(worktreeId);
    const comparison = await captureReviewComparison(resolved, input);
    // reject identity changes during capture
    if (!sameConfiguredWorkspace(this.discovery, resolved)) throw new ReviewTourError('target_unavailable', true);
    return { resolved, comparison, ...(input.effort === undefined ? {} : { effort: input.effort }) };
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
    return { ...generated, ...reviewScope(prepared.comparison), base: prepared.comparison.base, includeTests: prepared.comparison.includeTests, includeDocs: prepared.comparison.includeDocs, fingerprint: prepared.comparison.fingerprint, changes: prepared.comparison.changes, ...sinceReviewBase(prepared.comparison) };
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
  async startSinceReview(worktreeId: string, reviewedCommit: string): Promise<void> {
    const { workspace, review, baseBranch } = await this.pullRequestReview(worktreeId);
    // a review submitted since the sheet read it
    if (review.reviewedCommit !== reviewedCommit) throw new ReviewTourError('scope_unavailable', true);
    if (baseBranch !== undefined) await fetchOriginBranch(workspace, baseBranch);
    if (!await fetchCommit(workspace, reviewedCommit)) throw new ReviewTourError('reviewed_commit_unreachable', true);
  }

  private async pullRequestReview(worktreeId: string): Promise<{ workspace: string; review: { reviewedCommit: string; head: string }; baseBranch?: string }> {
    const { workspace, branch } = await this.resolve(worktreeId);
    if (branch === undefined) throw new ReviewTourError('no_pull_request', true);
    const repository = await this.github.repositoryAt(workspace);
    const pull = repository === undefined ? undefined : (await this.github.branch(repository, branch, undefined, { wait: true })).pullRequest;
    if (repository === undefined || pull === undefined || pull.status === 'merged') throw new ReviewTourError('no_pull_request', true);
    const { pullRequest, problem } = await this.github.pullRequestDetail(repository, pull.number, { fresh: true });
    // a failed read may still answer with an older one, whose head could be stale
    if (pullRequest === undefined || problem !== undefined) throw new ReviewTourError('scope_unavailable', true);
    if (pullRequest.viewerReviewCommit === undefined) throw new ReviewTourError('no_submitted_review', true);
    const head = (await resolveHead(workspace)).gitBase;
    if (head !== pullRequest.headSha) throw new ReviewTourError('head_behind_pull_request', true);
    return { workspace, review: { reviewedCommit: pullRequest.viewerReviewCommit, head }, ...(pullRequest.baseBranch === undefined ? {} : { baseBranch: pullRequest.baseBranch }) };
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
