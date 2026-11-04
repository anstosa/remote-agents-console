import { z } from 'zod';
import type { ReviewCategory } from '../git/change-classification.js';
import { objectId } from '../git/comparison.js';
import type { PullRequestComment, PullRequestReviewThread } from '../domain/models.js';
import { githubNodeId } from '../github/github.js';
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

// A Comparison's scope with the data it pins: `commit` narrates one commit of HEAD's history, and
// `since-review` what HEAD changed since `reviewedCommit`, the commit of the operator's latest
// submitted review on the Worktree's Pull request, whose base branch on GitHub is `baseBranch`
export type SinceReviewScope = { scope: 'since-review'; reviewedCommit: string; baseBranch: string };
export type ReviewScope = { scope: 'working' } | { scope: 'pr' } | { scope: 'commit'; commit: string } | SinceReviewScope;
type OtherScope = Exclude<ReviewScope, SinceReviewScope>;
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
type ComparisonFields = {
  worktreeId: string;
  workspace: string;
  branch?: string;
  base: string;
  includeTests: boolean;
  includeDocs: boolean;
  fingerprint: string;
  changes: ReviewChange[];
};
// A Since my review Comparison's base: the reviewed commit's changes replayed onto the PR's current
// merge base, or with `fallback` (the replay conflicted, or had no common base) the reviewed commit's
// own tree
export type SinceReviewBase = { baseTree: string; fallback?: true };
// a Since my review Comparison also names its base and `head`, the commit it ends at
export type ReviewComparison = ComparisonFields & (OtherScope | SinceReviewScope & SinceReviewBase & { head: string });
export type GeneratedReviewStep = { id: string; title: string; explanation: string; changeIds: string[] };
export type GeneratedReviewTour = { title: string; overview: string; steps: GeneratedReviewStep[] };
// The agent that narrated a tour, in its own conversation, with the model and effort it ran on; an Ask
// about the tour's lines resumes that conversation (ADR 0013)
export type TourGuide = { agent: ReviewAgentKind; conversation: string; model?: string; effort?: string };
// The Review threads I opened on a Since my review tour's Pull request `pullRequest`, as GitHub had
// them when the tour started, so the tour shows the threads as they were then; `partial` when GitHub's
// page of threads was full, so older ones may be missing
export type EarlierThreads = { pullRequest: number; threads: PullRequestReviewThread[]; partial?: true };
// `guide` is absent for a tour whose run kept no conversation; a Since my review tour also keeps its
// base and `earlierThreads`
type TourFields = GeneratedReviewTour & Pick<ComparisonFields, 'base' | 'includeTests' | 'includeDocs' | 'fingerprint' | 'changes'> & { guide?: TourGuide };
export type SinceReviewTour = TourFields & SinceReviewScope & SinceReviewBase & { earlierThreads: EarlierThreads };
export type ReviewTour = TourFields & OtherScope | SinceReviewTour;
// `effort` picks one of the tour agent's levels for this run; absent, the configured one applies
export type ReviewTourInput = ReviewScope & { includeTests: boolean; includeDocs: boolean; effort?: string };
// whether the tour's configured agent can run, with its configured effort and every level it accepts
export type ReviewTourCapability = ReviewRunCapability & { agent: ReviewAgentKind; effort?: string; efforts: string[] };
export type StoredReviewTour = { worktreeId: string; branch: string; savedAt: string; tour: ReviewTour };
// `codeReview` reports the tour's Code review (running, ready with `findings` counted, or failed)
export type StoredReviewTourSummary = Pick<StoredReviewTour, 'worktreeId' | 'branch' | 'savedAt'> & ReviewScope & Pick<ReviewTour, 'title' | 'includeTests' | 'includeDocs' | 'fingerprint'> & { codeReview?: 'running' | 'ready' | 'failed'; findings?: number };
export type ReviewErrorCode = 'invalid_request' | 'capability_unavailable' | 'authentication_required' | 'target_unavailable' | 'configured_worktree_required' | 'scope_unavailable' | 'conflicted_unavailable' | 'too_large' | 'generation_failed' | 'malformed_result' | 'generation_rejected' | 'timed_out' | 'cancelled' | 'stale_during_generation' | 'busy' | 'agent_busy' | 'conversation_unavailable' | 'no_pull_request' | 'no_submitted_review' | 'reviewed_commit_unreachable' | 'head_behind_pull_request' | 'head_diverged_from_pull_request' | 'since_review_outdated' | 'base_branch_unavailable';
export type PublicReviewComparison = ReviewScope & Pick<ReviewComparison, 'base' | 'fingerprint' | 'includeTests' | 'includeDocs'>;

export class ReviewTourError extends Error {
  // retain typed review failures
  constructor(public readonly code: ReviewErrorCode, public readonly retryable: boolean) { super(code); }
}

// `fields` once per scope, each case strict with exactly its scope's pinned data; `since` adds what
// only the Since my review case has
export function scopedSchema<T extends z.ZodRawShape, S extends z.ZodRawShape = {}>(fields: z.ZodObject<T, 'strict'>, since: S = {} as S) {
  return z.discriminatedUnion('scope', [
    fields.extend({ scope: z.literal('working') }),
    fields.extend({ scope: z.literal('pr') }),
    fields.extend({ scope: z.literal('commit'), commit: z.string().regex(objectId) }),
    // the base branch is only ever an `origin/<branch>` candidate (`refs/remotes/…`) or a start's checked fetch
    fields.extend({ scope: z.literal('since-review'), reviewedCommit: z.string().regex(objectId), baseBranch: z.string().min(1).max(255), ...since })
  ]);
}

// only a value's scope and the data that scope pins
export function reviewScope(value: SinceReviewScope): SinceReviewScope;
export function reviewScope(value: ReviewScope): ReviewScope;
export function reviewScope(value: ReviewScope): ReviewScope {
  if (value.scope === 'commit') return { scope: 'commit', commit: value.commit };
  return value.scope === 'since-review' ? { scope: 'since-review', reviewedCommit: value.reviewedCommit, baseBranch: value.baseBranch } : { scope: value.scope };
}

// whether two values name the same scope with the same pinned data
export function sameReviewScope(left: ReviewScope, right: ReviewScope): boolean {
  if (left.scope === 'commit') return right.scope === 'commit' && left.commit === right.commit;
  if (left.scope === 'since-review') return right.scope === 'since-review' && left.reviewedCommit === right.reviewedCommit && left.baseBranch === right.baseBranch;
  return left.scope === right.scope;
}

// a stored tour's snapshot of my earlier threads, which only a Since my review tour has
export const earlierThreadsOf = (tour: ReviewTour): EarlierThreads | undefined => tour.scope === 'since-review' ? tour.earlierThreads : undefined;

const inputSchema = scopedSchema(z.object({ includeTests: z.boolean(), includeDocs: z.boolean(), effort: z.string().min(1).max(20).optional() }).strict());
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
// A snapshot is bounded whatever other participants write on my threads: the threads of one detail
// page, each its first comment and latest replies with their text cut short ("View on GitHub" has the
// rest), and the end of its hunk, the code the first comment sits on; and all of that text together
// within MAX_EARLIER_CHARACTERS. Every snapshot taken loads again.
export const MAX_EARLIER_THREADS = 100;
export const MAX_EARLIER_REPLIES = 5;
export const MAX_EARLIER_COMMENT = 4_000;
export const MAX_EARLIER_HUNK_LINES = 20;
export const MAX_EARLIER_CHARACTERS = 200_000;
const MAX_EARLIER_HUNK = 8_000;
const threadCommentSchema = z.object({ id: githubNodeId, author: z.string().min(1).max(100), bot: z.boolean(), mine: z.literal(true).optional(), editedBy: z.string().min(1).max(100).optional(), body: z.string().max(MAX_EARLIER_COMMENT), createdAt: z.string().max(64), url: z.string().max(2_048) }).strict();
const lineSchema = z.number().int().positive();
const threadSchema = z.object({ id: githubNodeId, path: z.string().min(1).max(4_096), line: lineSchema.optional(), startLine: lineSchema.optional(), leftSide: z.literal(true).optional(), pending: z.literal(true).optional(), resolved: z.boolean(), resolvedBy: z.object({ login: z.string().min(1).max(100), mine: z.literal(true).optional() }).strict().optional(), outdated: z.boolean(), diffHunk: z.string().max(MAX_EARLIER_HUNK), comments: z.array(threadCommentSchema).min(1).max(1 + MAX_EARLIER_REPLIES) }).strict();
// the characters a snapshot's threads hold: their hunks and comments
const snapshotCharacters = (threads: PullRequestReviewThread[]): number => threads.reduce((total, thread) => total + thread.diffHunk.length + thread.comments.reduce((sum, comment) => sum + comment.body.length, 0), 0);
const earlierThreadsSchema = z.object({ pullRequest: z.number().int().positive(), threads: z.array(threadSchema).max(MAX_EARLIER_THREADS).refine(threads => snapshotCharacters(threads as PullRequestReviewThread[]) <= MAX_EARLIER_CHARACTERS), partial: z.literal(true).optional() }).strict();

// Threads as a tour keeps them, within what a stored tour loads. My replies still in my unsent Draft
// review are not part of the thread yet. Over the total budget, the oldest replies go first, then
// the oldest threads.
export function earlierThreadsSnapshot(threads: PullRequestReviewThread[]): PullRequestReviewThread[] {
  let kept = threads.slice(-MAX_EARLIER_THREADS).map(thread => {
    const [opener, ...replies] = thread.comments;
    const comments = opener === undefined ? [] : [opener, ...replies.filter(reply => reply.pending !== true).slice(-MAX_EARLIER_REPLIES)];
    return { ...thread, diffHunk: thread.diffHunk.split('\n').slice(-MAX_EARLIER_HUNK_LINES).join('\n').slice(-MAX_EARLIER_HUNK), comments: comments.map(comment => ({ ...comment, body: comment.body.slice(0, MAX_EARLIER_COMMENT) })) };
  });
  let over = snapshotCharacters(kept) - MAX_EARLIER_CHARACTERS;
  if (over <= 0) return kept;
  const oldestReplies = kept.flatMap(thread => thread.comments.slice(1)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const dropped = new Set<PullRequestComment>();
  for (const reply of oldestReplies) {
    if (over <= 0) break;
    dropped.add(reply);
    over -= reply.body.length;
  }
  kept = kept.map(thread => ({ ...thread, comments: thread.comments.filter(comment => !dropped.has(comment)) }));
  while (over > 0 && kept.length > 0) {
    over -= snapshotCharacters(kept.slice(0, 1));
    kept = kept.slice(1);
  }
  return kept;
}

// a Since my review tour, and only that, records its base tree and my earlier threads
const reviewTourSchema = scopedSchema(generatedTourSchema.extend({ base: z.string().min(1).max(4_096), includeTests: z.boolean(), includeDocs: z.boolean(), fingerprint: z.string().min(16).max(128), changes: z.array(reviewChangeSchema).min(1).max(MAX_REVIEW_CHANGES), guide: guideSchema.optional() }).strict(), { baseTree: z.string().regex(objectId), fallback: z.literal(true).optional(), earlierThreads: earlierThreadsSchema });
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
  if (generated === undefined) return undefined;
  const fields = { ...generated, base: tour.base, includeTests: tour.includeTests, includeDocs: tour.includeDocs, fingerprint: tour.fingerprint, changes: tour.changes, ...(tour.guide === undefined ? {} : { guide: tour.guide as TourGuide }) };
  return tour.scope === 'since-review' ? { ...fields, ...reviewScope(tour), ...sinceReviewBase(tour), earlierThreads: tour.earlierThreads as EarlierThreads } : { ...fields, ...reviewScope(tour) as OtherScope };
}

// only a Since my review base's fields
export function sinceReviewBase(value: SinceReviewBase): SinceReviewBase {
  return { baseTree: value.baseTree, ...(value.fallback === undefined ? {} : { fallback: value.fallback }) };
}

// expose only Comparison identity fields
export function publicReviewComparison(comparison: ReviewComparison): PublicReviewComparison {
  return { ...reviewScope(comparison), base: comparison.base, fingerprint: comparison.fingerprint, includeTests: comparison.includeTests, includeDocs: comparison.includeDocs };
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
