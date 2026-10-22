import { basename } from 'node:path';
import type { ResolvedReviewTour } from '../review-runs/config.js';
import { reviewEfforts } from '../review-runs/kinds.js';
import { tourRunLabel, type ReviewRunner, type ReviewRunProgress } from '../review-runs/runner.js';
import { generatedReviewTourJsonSchema, parseGeneratedReviewTourResult, REVIEW_GENERATION_TIMEOUT_MS, ReviewTourError, type GeneratedReviewTour, type ReviewComparison, type ReviewTourCapability } from './contracts.js';

export interface ReviewTourGenerator {
  capability(): Promise<ReviewTourCapability>;
  generate(comparison: ReviewComparison, signal: AbortSignal, effort?: string, progress?: ReviewRunProgress): Promise<GeneratedReviewTour>;
}

// the operator's narration guidance followed by the server-owned contract the parser enforces,
// so a configured prompt can change what the tour says but never break its shape
export function reviewTourPrompt(guidance: string, comparison: ReviewComparison): string {
  const changes = comparison.changes.map(change => ({ id: change.id, file: change.file, originalFile: change.originalFile, category: change.category, kind: change.kind, patch: change.patch }));
  return [
    guidance,
    'Assign every change ID exactly once.',
    'Do not perform code review. Do not produce findings, warnings, issues, recommendations, severity, verdicts, approval, rejection, patches, fixes, or commands.',
    'Use only the provided change IDs in changeIds. Return JSON matching the supplied schema.',
    `Scope: ${comparison.scope}; base: ${comparison.base}; tests included: ${comparison.includeTests}; docs included: ${comparison.includeDocs}.`,
    JSON.stringify({ changes })
  ].join('\n\n');
}

// narrates tours as a Review run on the configured tour agent (ADR 0010)
export class ConfiguredReviewTourGenerator implements ReviewTourGenerator {
  constructor(private readonly runner: ReviewRunner, private readonly tour: ResolvedReviewTour, private readonly timeoutMs = REVIEW_GENERATION_TIMEOUT_MS) {}

  // describe the tour agent's runnable state and effort levels
  async capability(): Promise<ReviewTourCapability> {
    const capability = await this.runner.capability(this.tour.agent);
    return { ...capability, agent: this.tour.agent, ...(this.tour.effort === undefined ? {} : { effort: this.tour.effort }), efforts: [...reviewEfforts[this.tour.agent]] };
  }

  // run one structured generation at the requested effort, else the configured one; an
  // interactive run is checked against the same parse and gets one correction
  async generate(comparison: ReviewComparison, signal: AbortSignal, effort = this.tour.effort, progress: ReviewRunProgress = {}): Promise<GeneratedReviewTour> {
    const validate = (value: unknown) => { const result = parseGeneratedReviewTourResult(value, comparison.changes); return result.ok ? undefined : result.error; };
    const parsed = await this.runner.run({ kind: this.tour.agent, workspace: comparison.workspace, worktreeId: comparison.worktreeId, prompt: reviewTourPrompt(this.tour.prompt, comparison), reply: { kind: 'json', schema: generatedReviewTourJsonSchema, validate }, timeoutMs: this.timeoutMs, label: tourRunLabel(comparison.branch ?? basename(comparison.workspace)), ...progress, ...(this.tour.model === undefined ? {} : { model: this.tour.model }), ...(effort === undefined ? {} : { effort }) }, signal);
    const result = parseGeneratedReviewTourResult(parsed.value, comparison.changes);
    // reject invalid assignments or narration
    if (!result.ok) throw new ReviewTourError(result.code, true);
    return result.tour;
  }
}
