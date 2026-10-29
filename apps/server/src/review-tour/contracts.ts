import { z } from 'zod';
import type { ReviewCategory } from '../git/change-classification.js';
import { objectId } from '../git/comparison.js';
import { agentChoiceShape } from '../launch/agent-choice.js';
import { reviewAgentKinds, validConversationId, type ReviewAgentKind } from '../review-runs/kinds.js';
import type { ReviewRunCapability } from '../review-runs/runner.js';

// room for a Code review's 2000-character focus note in any script
export const REVIEW_REQUEST_BODY_BYTES = 8_192;
export const MAX_REVIEW_FILES = 100;
export const MAX_REVIEW_CHANGES = 500;
export const MAX_REVIEW_DIFF_BYTES = 900_000;
export const MAX_REVIEW_FILE_BYTES = 160_000;
export const MAX_REVIEW_GENERATED_BYTES = 96_000;
export const REVIEW_GENERATION_TIMEOUT_MS = 120_000;
// an interactive tour waits on a TUI launch and a human-paced pane, so it gets longer
export const INTERACTIVE_REVIEW_GENERATION_TIMEOUT_MS = 600_000;
// outlives the longest tour run so a slow interactive narration is not expired mid-run
export const REVIEW_JOB_TTL_MS = 900_000;
export const REVIEW_JOB_POLL_MS = 1_000;

// `commit` narrates one commit of HEAD's history, named by the Comparison's `commit`
export type ReviewScope = 'working' | 'pr' | 'commit';
export type ReviewChangeKind = 'hunk' | 'binary' | 'rename' | 'metadata' | 'untracked';
export type ReviewChange = {
  id: string;
  file: string;
  originalFile?: string;
  category: ReviewCategory;
  kind: ReviewChangeKind;
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  patch: string;
};
export type ReviewComparison = {
  agentId: string;
  worktreeId: string;
  workspace: string;
  branch?: string;
  scope: ReviewScope;
  commit?: string;
  base: string;
  includeTests: boolean;
  includeDocs: boolean;
  fingerprint: string;
  changes: ReviewChange[];
};
export type GeneratedReviewStep = { id: string; title: string; explanation: string; changeIds: string[] };
export type GeneratedReviewTour = { title: string; overview: string; steps: GeneratedReviewStep[] };
// The agent that narrated a tour, in its own conversation, with the model and effort it ran on; an Ask
// about the tour's lines resumes that conversation (ADR 0013)
export type TourGuide = { agent: ReviewAgentKind; conversation: string; model?: string; effort?: string };
// `guide` is absent for a tour whose run kept no conversation
export type ReviewTour = GeneratedReviewTour & Pick<ReviewComparison, 'scope' | 'commit' | 'base' | 'includeTests' | 'includeDocs' | 'fingerprint' | 'changes'> & { guide?: TourGuide };
// `effort` picks one of the tour agent's levels for this run; absent, the configured one applies
export type ReviewTourInput = { scope: ReviewScope; commit?: string; includeTests: boolean; includeDocs: boolean; effort?: string };
// whether the tour's configured agent can run, with its configured effort and every level it accepts
export type ReviewTourCapability = ReviewRunCapability & { agent: ReviewAgentKind; effort?: string; efforts: string[] };
export type StoredReviewTour = { worktreeId: string; branch: string; savedAt: string; tour: ReviewTour };
// `codeReview` reports the tour's Code review (running, ready with `findings` counted, or failed)
export type StoredReviewTourSummary = Pick<StoredReviewTour, 'worktreeId' | 'branch' | 'savedAt'> & Pick<ReviewTour, 'title' | 'scope' | 'commit' | 'includeTests' | 'includeDocs' | 'fingerprint'> & { codeReview?: 'running' | 'ready' | 'failed'; findings?: number };
export type ReviewErrorCode = 'invalid_request' | 'capability_unavailable' | 'authentication_required' | 'target_unavailable' | 'configured_worktree_required' | 'scope_unavailable' | 'conflicted_unavailable' | 'too_large' | 'generation_failed' | 'malformed_result' | 'generation_rejected' | 'timed_out' | 'cancelled' | 'stale_during_generation' | 'busy' | 'agent_busy' | 'conversation_unavailable';
export type PublicReviewComparison = Pick<ReviewComparison, 'scope' | 'commit' | 'base' | 'fingerprint' | 'includeTests' | 'includeDocs'>;

export class ReviewTourError extends Error {
  // retain typed review failures
  constructor(public readonly code: ReviewErrorCode, public readonly retryable: boolean) { super(code); }
}

// a Comparison's scope and, for exactly the commit scope, the full object id it narrates
export const reviewScopeShape = { scope: z.enum(['working', 'pr', 'commit']), commit: z.string().regex(objectId).optional() };
export const commitMatchesScope = (value: { scope: ReviewScope; commit?: string }) => (value.scope === 'commit') === (value.commit !== undefined);
const inputSchema = z.object({ ...reviewScopeShape, includeTests: z.boolean(), includeDocs: z.boolean(), effort: z.string().min(1).max(20).optional() }).strict().refine(commitMatchesScope);
const requestIdSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const generatedStepSchema = z.object({ id: z.string().min(1).max(80), title: z.string().trim().min(1).max(240), explanation: z.string().trim().min(1).max(4_000), changeIds: z.array(z.string().min(8).max(100)).min(1).max(MAX_REVIEW_CHANGES) }).strict();
const generatedTourSchema = z.object({ title: z.string().trim().min(1).max(240), overview: z.string().trim().min(1).max(2_000), steps: z.array(generatedStepSchema).min(1).max(MAX_REVIEW_CHANGES) }).strict();
const reviewChangeSchema = z.object({ id: z.string().min(8).max(100), file: z.string().min(1).max(4_096), originalFile: z.string().min(1).max(4_096).optional(), category: z.enum(['implementation', 'test', 'doc']), kind: z.enum(['hunk', 'binary', 'rename', 'metadata', 'untracked']), oldStart: z.number().int().nonnegative().optional(), oldLines: z.number().int().nonnegative().optional(), newStart: z.number().int().nonnegative().optional(), newLines: z.number().int().nonnegative().optional(), patch: z.string().max(MAX_REVIEW_FILE_BYTES) }).strict();
const guideSchema = z.object({ ...agentChoiceShape(z.enum(reviewAgentKinds)), conversation: z.string().min(1).max(200) }).strict().refine(guide => validConversationId(guide.agent, guide.conversation));
// validate a stored conversation and how it runs, such as a tour's guide
export function parseTourGuide(value: unknown): TourGuide | undefined {
  const parsed = guideSchema.safeParse(value);
  return parsed.success ? parsed.data as TourGuide : undefined;
}
const reviewTourSchema = generatedTourSchema.extend({ ...reviewScopeShape, base: z.string().min(1).max(4_096), includeTests: z.boolean(), includeDocs: z.boolean(), fingerprint: z.string().min(16).max(128), changes: z.array(reviewChangeSchema).min(1).max(MAX_REVIEW_CHANGES), guide: guideSchema.optional() }).strict().refine(commitMatchesScope);
const prohibitedPrefix = /^(?:finding|findings|warning|warnings|issue|issues|recommendation|recommendations|severity|verdict|approval|approved|rejection|rejected)\s*[:\-–—]/iu;

// parse the fixed review request
export function parseReviewTourInput(value: unknown): ReviewTourInput | undefined {
  const parsed = inputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// parse one bounded idempotency key
export function parseReviewRequestId(value: unknown): string | undefined {
  const parsed = requestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// reject finding-shaped narration labels
export function prohibitedNarration(value: string): boolean {
  return prohibitedPrefix.test(value.trim().normalize('NFKC'));
}

// `error` says what failed in words an agent can correct (an interactive run's correction prompt)
export type GeneratedReviewTourParseResult = { ok: true; tour: GeneratedReviewTour } | { ok: false; code: 'malformed_result' | 'generation_rejected'; error: string };

// the first few schema violations of a model reply, as one human-readable line
export function describeSchemaIssues(error: z.ZodError): string {
  return error.issues.slice(0, 5).map(issue => `${issue.path.length === 0 ? 'the object' : issue.path.join('.')}: ${issue.message}`).join('; ');
}

// validate model output and exact assignments
export function parseGeneratedReviewTourResult(value: unknown, changes: ReviewChange[]): GeneratedReviewTourParseResult {
  const parsed = generatedTourSchema.safeParse(value);
  // require structural validity
  if (!parsed.success) return { ok: false, code: 'malformed_result', error: describeSchemaIssues(parsed.error) };
  const tour = parsed.data;
  const narration = [tour.title, tour.overview, ...tour.steps.flatMap(step => [step.title, step.explanation])];
  // reject explicit review labels
  if (narration.some(prohibitedNarration)) return { ok: false, code: 'generation_rejected', error: 'a title or explanation starts with a review label such as "Finding:" or "Issue:"; narrate the changes instead' };
  const expected = new Set(changes.map(change => change.id));
  const assigned = new Set<string>();
  // validate every model reference
  for (const step of tour.steps) {
    // require unique step ids
    if (tour.steps.filter(candidate => candidate.id === step.id).length !== 1) return { ok: false, code: 'malformed_result', error: `step id "${step.id}" is used more than once` };
    // validate change assignments
    for (const id of step.changeIds) {
      // reject unknown or duplicate ids
      if (!expected.has(id)) return { ok: false, code: 'malformed_result', error: `change ID "${id}" is not one of the provided change IDs` };
      if (assigned.has(id)) return { ok: false, code: 'malformed_result', error: `change ID "${id}" is assigned to more than one step` };
      assigned.add(id);
    }
  }
  // require complete coverage
  const missing = [...expected].filter(id => !assigned.has(id));
  if (missing.length > 0) return { ok: false, code: 'malformed_result', error: `every change ID must be assigned exactly once; missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}` };
  return { ok: true, tour };
}

// retain the simple parser for trusted callers
export function parseGeneratedReviewTour(value: unknown, changes: ReviewChange[]): GeneratedReviewTour | undefined {
  const result = parseGeneratedReviewTourResult(value, changes);
  return result.ok ? result.tour : undefined;
}

// validate a complete persisted tour
export function parseReviewTour(value: unknown): ReviewTour | undefined {
  const parsed = reviewTourSchema.safeParse(value);
  // require the complete bounded shape
  if (!parsed.success) return undefined;
  const tour = parsed.data;
  const patchBytes = tour.changes.reduce((total, change) => total + Buffer.byteLength(change.patch), 0);
  // enforce the canonical aggregate boundary
  if (patchBytes > MAX_REVIEW_DIFF_BYTES) return undefined;
  const generated = parseGeneratedReviewTour({ title: tour.title, overview: tour.overview, steps: tour.steps }, tour.changes);
  // retain only exact change assignments
  return generated === undefined ? undefined : { ...generated, scope: tour.scope, ...(tour.commit === undefined ? {} : { commit: tour.commit }), base: tour.base, includeTests: tour.includeTests, includeDocs: tour.includeDocs, fingerprint: tour.fingerprint, changes: tour.changes, ...(tour.guide === undefined ? {} : { guide: tour.guide as TourGuide }) };
}

// expose only Comparison identity fields
export function publicReviewComparison(comparison: ReviewComparison): PublicReviewComparison {
  return { scope: comparison.scope, ...(comparison.commit === undefined ? {} : { commit: comparison.commit }), base: comparison.base, fingerprint: comparison.fingerprint, includeTests: comparison.includeTests, includeDocs: comparison.includeDocs };
}

export const generatedReviewTourJsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'overview', 'steps'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 240 },
    overview: { type: 'string', minLength: 1, maxLength: 2_000 },
    steps: { type: 'array', minItems: 1, maxItems: MAX_REVIEW_CHANGES, items: {
      type: 'object', additionalProperties: false, required: ['id', 'title', 'explanation', 'changeIds'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 80 },
        title: { type: 'string', minLength: 1, maxLength: 240 },
        explanation: { type: 'string', minLength: 1, maxLength: 4_000 },
        changeIds: { type: 'array', minItems: 1, maxItems: MAX_REVIEW_CHANGES, items: { type: 'string', minLength: 8, maxLength: 100 } }
      }
    } }
  }
} as const;
