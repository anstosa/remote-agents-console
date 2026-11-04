import type { DiscoveryService } from '../discovery/service.js';
import { resolveConfiguredWorkspace, sameConfiguredWorkspace, type ResolvedWorkspace } from '../workspaces/resolver.js';
import { captureReviewComparison } from './diff.js';
import type { ReviewRunProgress } from '../review-runs/runner.js';
import type { ReviewTourGenerator } from './generator.js';
import { publicReviewComparison, reviewScope, ReviewTourError, type PublicReviewComparison, type ReviewComparison, type ReviewTour, type ReviewTourCapability, type ReviewTourInput } from './contracts.js';

// `effort` is the run's requested effort, absent for the configured one
export type PreparedReviewTour = { resolved: ResolvedWorkspace; comparison: ReviewComparison; effort?: string };

export class ReviewTourService {
  constructor(private readonly discovery: DiscoveryService, private readonly generator: ReviewTourGenerator) {}

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
    return { ...generated, ...reviewScope(prepared.comparison), base: prepared.comparison.base, includeTests: prepared.comparison.includeTests, includeDocs: prepared.comparison.includeDocs, fingerprint: prepared.comparison.fingerprint, changes: prepared.comparison.changes };
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
