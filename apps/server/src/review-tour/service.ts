import type { DiscoveryService } from '../discovery/service.js';
import { resolveConfiguredWorkspace, sameConfiguredWorkspace, type ResolvedWorkspace } from '../workspaces/resolver.js';
import { captureReviewComparison } from './diff.js';
import type { ReviewRunProgress } from '../review-runs/runner.js';
import type { ReviewTourGenerator } from './generator.js';
import { publicReviewComparison, ReviewTourError, type PublicReviewComparison, type ReviewComparison, type ReviewTour, type ReviewTourCapability, type ReviewTourInput } from './contracts.js';

// `effort` is the run's requested effort, absent for the configured one
export type PreparedReviewTour = { resolved: ResolvedWorkspace; comparison: ReviewComparison; effort?: string };

export class ReviewTourService {
  constructor(private readonly discovery: DiscoveryService, private readonly generator: ReviewTourGenerator) {}

  // expose the bounded generator capability
  capability(): Promise<ReviewTourCapability> { return this.generator.capability(); }

  // capture a validated generation input
  async prepare(agentId: string, input: ReviewTourInput): Promise<PreparedReviewTour> {
    const capability = await this.capability();
    // fail closed without generation support
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    // refuse an effort the tour agent does not accept
    if (input.effort !== undefined && !capability.efforts.includes(input.effort)) throw new ReviewTourError('invalid_request', false);
    const target = await this.discovery.target(agentId);
    // distinguish missing and unconfigured targets
    if (target === undefined) throw new ReviewTourError('target_unavailable', true);
    const resolved = await resolveConfiguredWorkspace(this.discovery, agentId);
    // require a configured active agent
    if (resolved === undefined) throw new ReviewTourError('configured_worktree_required', false);
    const comparison = await captureReviewComparison(resolved, input);
    // reject identity changes during capture
    if (!await sameConfiguredWorkspace(this.discovery, agentId, resolved)) throw new ReviewTourError('target_unavailable', true);
    return { resolved, comparison, ...(input.effort === undefined ? {} : { effort: input.effort }) };
  }

  // generate and revalidate one complete tour
  async generate(prepared: PreparedReviewTour, signal: AbortSignal, progress?: ReviewRunProgress): Promise<ReviewTour> {
    const generated = await this.generator.generate(prepared.comparison, signal, prepared.effort, progress);
    // preserve caller cancellation
    if (signal.aborted) throw new ReviewTourError('cancelled', true);
    const current = await captureReviewComparison(prepared.resolved, { scope: prepared.comparison.scope, ...(prepared.comparison.commit === undefined ? {} : { commit: prepared.comparison.commit }), includeTests: prepared.comparison.includeTests, includeDocs: prepared.comparison.includeDocs });
    // reject stale narration before publication
    if (current.fingerprint !== prepared.comparison.fingerprint || current.branch !== prepared.comparison.branch) throw new ReviewTourError('stale_during_generation', true);
    // reject agent replacement before publication
    if (!await sameConfiguredWorkspace(this.discovery, prepared.comparison.agentId, prepared.resolved)) throw new ReviewTourError('target_unavailable', true);
    return { ...generated, scope: prepared.comparison.scope, ...(prepared.comparison.commit === undefined ? {} : { commit: prepared.comparison.commit }), base: prepared.comparison.base, includeTests: prepared.comparison.includeTests, includeDocs: prepared.comparison.includeDocs, fingerprint: prepared.comparison.fingerprint, changes: prepared.comparison.changes };
  }

  // capture the agent's current Comparison without generation
  async current(agentId: string, input: ReviewTourInput): Promise<ReviewComparison> {
    const target = await this.discovery.target(agentId);
    // distinguish missing and unconfigured targets
    if (target === undefined) throw new ReviewTourError('target_unavailable', true);
    const resolved = await resolveConfiguredWorkspace(this.discovery, agentId);
    // require a configured active agent
    if (resolved === undefined) throw new ReviewTourError('configured_worktree_required', false);
    return await captureReviewComparison(resolved, input);
  }

  // recompute current source identity without generation
  async fingerprint(agentId: string, input: ReviewTourInput): Promise<{ comparison: PublicReviewComparison; empty: boolean }> {
    const comparison = await this.current(agentId, input);
    return { comparison: publicReviewComparison(comparison), empty: comparison.changes.length === 0 };
  }
}
