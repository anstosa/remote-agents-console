import type { ReviewPreset, ResolvedReviewConfig } from '../review-runs/config.js';
import { acceptsReviewEffort, reviewEfforts } from '../review-runs/kinds.js';
import { reviewRunLabel, type ReviewRunner, type ReviewRunProgress } from '../review-runs/runner.js';
import { ReviewTourError, type ReviewComparison } from '../review-tour/contracts.js';
import { CODE_REVIEW_TIMEOUT_MS, codeReviewFrom, codeReviewReplyError, generatedCodeReviewJsonSchema, MAX_CODE_REVIEW_OUTPUT_BYTES, presetCapability, type CodeReview, type CodeReviewCapability, type CodeReviewOptions, type CodeReviewRecovery, type CodeReviewRun } from './contracts.js';

// a requested Code review checked against its preset: the effort defaults to the preset's
export type ResolvedCodeReview = { preset: ReviewPreset; effort?: string; focus?: string };

// the preset's guidance, the run's extra focus, then the server-owned contract the parser
// enforces, so neither a configured prompt nor a focus note can break the result's shape
export function codeReviewPrompt(guidance: string, focus: string | undefined, comparison: ReviewComparison): string {
  const changes = comparison.changes.map(change => ({ id: change.id, file: change.file, originalFile: change.originalFile, kind: change.kind, oldStart: change.oldStart, oldLines: change.oldLines, newStart: change.newStart, newLines: change.newLines, patch: change.patch }));
  return [
    guidance,
    ...(focus === undefined ? [] : [`Additional focus for this review: ${focus}`]),
    'Review only the provided changes. Read the rest of the repository for context, but report problems only in these changes.',
    'Every finding cites one change ID and a line range inside that change\'s hunk on the stated side: for side "additions" use new-file line numbers within newStart to newStart+newLines-1; for side "deletions" use old-file line numbers within oldStart to oldStart+oldLines-1. startLine must not exceed endLine. An untracked change is a new file: cite its additions as lines 1 to its line count.',
    'Put a concern that cannot be anchored to one hunk\'s lines (a missing change, a cross-cutting problem, a binary, renamed or metadata-only change) in `general`, with `file` naming the file when there is one and null otherwise.',
    'Severity: high is a defect that will break behaviour, lose data or open a security hole; medium is a real problem in an edge case or a likely regression; low is a minor issue worth fixing.',
    'Do not praise the code, summarize the changes or restate what they do. Return empty arrays when you find nothing.',
    'Return JSON matching the supplied schema.',
    `Scope: ${comparison.scope}; base: ${comparison.base}; tests included: ${comparison.includeTests}; docs included: ${comparison.includeDocs}.`,
    JSON.stringify({ changes })
  ].join('\n\n');
}

// runs Code reviews as a Review run on the requested preset's agent (ADR 0010)
export class CodeReviewer {
  constructor(private readonly runner: ReviewRunner, private readonly review: Pick<ResolvedReviewConfig, 'presets' | 'defaultPreset'>) {}

  // describe every preset with its agent's runnable state and effort levels
  async capability(): Promise<CodeReviewCapability> {
    const presets = await Promise.all(this.review.presets.map(async preset => presetCapability({ id: preset.id, label: preset.label, agent: preset.agent, ...(preset.effort === undefined ? {} : { effort: preset.effort }), efforts: reviewEfforts[preset.agent], capability: await this.runner.capability(preset.agent) })));
    return { defaultPreset: this.review.defaultPreset, presets };
  }

  // check a request against its preset before anything starts
  async resolve(options: CodeReviewOptions): Promise<ResolvedCodeReview> {
    const preset = this.review.presets.find(candidate => candidate.id === options.preset);
    // refuse an unknown preset
    if (preset === undefined) throw new ReviewTourError('invalid_request', false);
    // refuse an effort the preset's agent does not accept
    if (options.effort !== undefined && !acceptsReviewEffort(preset.agent, options.effort)) throw new ReviewTourError('invalid_request', false);
    const capability = await this.runner.capability(preset.agent);
    // refuse a preset whose agent cannot run
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    const effort = options.effort ?? preset.effort;
    return { preset, ...(effort === undefined ? {} : { effort }), ...(options.focus === undefined ? {} : { focus: options.focus }) };
  }

  // run one structured review of a Comparison and anchor its findings; an interactive run is
  // checked against the output shape and gets one correction
  async run(comparison: ReviewComparison, resolved: ResolvedCodeReview, signal: AbortSignal, progress: ReviewRunProgress = {}): Promise<CodeReview> {
    const { preset, effort, focus } = resolved;
    const run: CodeReviewRun = { fingerprint: comparison.fingerprint, preset: { id: preset.id, label: preset.label, agent: preset.agent }, ...(effort === undefined ? {} : { effort }), ...(focus === undefined ? {} : { focus }) };
    // only a branch-bound review is stored, so only one can be recovered
    const recovery: CodeReviewRecovery | undefined = comparison.branch === undefined ? undefined : { kind: 'code-review', worktreeId: comparison.worktreeId, branch: comparison.branch, ...run };
    const output = await this.runner.run({ kind: preset.agent, workspace: comparison.workspace, worktreeId: comparison.worktreeId, prompt: codeReviewPrompt(preset.prompt, focus, comparison), schema: generatedCodeReviewJsonSchema, timeoutMs: CODE_REVIEW_TIMEOUT_MS, maxOutputBytes: MAX_CODE_REVIEW_OUTPUT_BYTES, label: reviewRunLabel(preset.label), validate: codeReviewReplyError, ...(recovery === undefined ? {} : { recovery }), ...progress, ...(preset.model === undefined ? {} : { model: preset.model }), ...(effort === undefined ? {} : { effort }) }, signal);
    // preserve caller cancellation
    if (signal.aborted) throw new ReviewTourError('cancelled', true);
    const review = codeReviewFrom(output, comparison.changes, run);
    // reject output outside the contract
    if (review === undefined) throw new ReviewTourError('malformed_result', true);
    return review;
  }
}
