import { createHash } from 'node:crypto';
import { githubRepository, type GithubRepository } from '../../github/github.js';
import type { IntegrationPrincipal } from '../auth/index.js';
import type { ReviewComparison, ReviewTourInput } from '../../review-tour/contracts.js';
import { diffRows } from '../../review-tour/diff-rows.js';
import { PullRequestReviewError, type PullRequestReviewInput, type PullRequestReviewResult } from '../../review-tour/pr-review.js';
import { developerFailure, developerSuccess, type DeveloperResult } from './developer-tool.js';

type DraftWorktree = { id: string; path: string; available: boolean };
export type ReviewDraftDependencies = {
  worktrees: () => readonly DraftWorktree[];
  repositoryAt: (path: string) => Promise<GithubRepository | undefined>;
  current: (worktreeId: string, input: ReviewTourInput) => Promise<ReviewComparison>;
  post: (worktreeId: string, input: PullRequestReviewInput) => Promise<PullRequestReviewResult>;
};

type DraftComment = { path: string; line: number; body: string };

// create the bounded Davo-only pending-review callback
export function createReviewDraftPort(deps: ReviewDraftDependencies) {
  // resolve, map, and post one already schema-validated tool input
  return async (input: Record<string, unknown>, principal: IntegrationPrincipal): Promise<DeveloperResult> => {
    // require the exact current Davo lease identity defensively
    if (principal.authentication !== 'realtime' || principal.stableOwnerKey === undefined || principal.leaseKey === undefined) return developerFailure('lease_required', 'A current Davo lease is required.');
    const repository = parseRepository(input.repository);
    // accept only one bounded repository locator
    if (repository === undefined || typeof input.fingerprint !== 'string' || typeof input.request_id !== 'string' || !Number.isInteger(input.number)) return developerFailure('invalid_arguments', 'The review draft input is invalid.');
    const resolved = await resolveComparison(deps, repository, input.fingerprint);
    // never guess between missing or ambiguous prepared comparisons
    if (resolved === undefined) return developerFailure('stale_preparation', 'The configured pull-request comparison is unavailable or changed.', true);
    const comments = mapComments(resolved.comparison, Array.isArray(input.comments) ? input.comments as DraftComment[] : [], input.request_id);
    // never invent an anchor when the prepared diff does not carry the exact line
    if (comments === undefined) return developerFailure('stale_preparation', 'A requested review line is unavailable in the prepared comparison.', true);
    const body = typeof input.body === 'string' ? input.body : undefined;
    const sections = [{ key: `mcp:${shortDigest(input.request_id)}`, markdown: body === undefined || body.trim() === '' ? '<!-- rac-mcp-draft -->' : body }];
    const reviewInput: PullRequestReviewInput = { scope: 'pr', includeTests: resolved.comparison.includeTests, includeDocs: resolved.comparison.includeDocs, fingerprint: resolved.comparison.fingerprint, pullRequestNumber: input.number as number, sections, comments };
    try {
      const result = await deps.post(resolved.worktree.id, reviewInput);
      // missing effect identity is post-dispatch uncertainty for gateway settlement
      if (typeof result.draftId !== 'string' || result.draftId.length === 0 || result.draftId.length > 240) throw new Error('pending review outcome is uncertain');
      return developerSuccess({ draft_id: result.draftId, state: 'pending' });
    } catch (error) { return draftFailure(error); }
  };
}

// resolve one configured checkout by repository and exact fresh fingerprint
async function resolveComparison(deps: ReviewDraftDependencies, repository: GithubRepository, fingerprint: string): Promise<{ worktree: DraftWorktree; comparison: ReviewComparison } | undefined> {
  const matches: Array<{ worktree: DraftWorktree; comparison: ReviewComparison }> = [];
  // inspect only configured available worktrees
  for (const worktree of deps.worktrees()) {
    // skip unavailable checkouts before origin reads
    if (!worktree.available) continue;
    const configured = await deps.repositoryAt(worktree.path).catch(() => undefined);
    // bind the caller's repository to the checkout origin
    if (configured === undefined || configured.owner.toLowerCase() !== repository.owner.toLowerCase() || configured.name.toLowerCase() !== repository.name.toLowerCase()) continue;
    const comparison = await matchingComparison(deps, worktree.id, fingerprint);
    // retain only the exact current prepared source
    if (comparison !== undefined) matches.push({ worktree, comparison });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

// recover the original PR comparison flags from its fingerprint
async function matchingComparison(deps: ReviewDraftDependencies, worktreeId: string, fingerprint: string): Promise<ReviewComparison | undefined> {
  const flags = [[true, true], [true, false], [false, true], [false, false]] as const;
  // try the four bounded filter combinations without weakening fingerprint equality
  for (const [includeTests, includeDocs] of flags) {
    const comparison = await deps.current(worktreeId, { scope: 'pr', includeTests, includeDocs }).catch(() => undefined);
    // return only the exact prepared comparison
    if (comparison?.fingerprint === fingerprint) return comparison;
  }
  return undefined;
}

// map simple MCP comments to exact current Review-tour anchors
function mapComments(comparison: ReviewComparison, requested: DraftComment[], requestId: string): PullRequestReviewInput['comments'] | undefined {
  const mapped: PullRequestReviewInput['comments'] = [];
  // resolve every requested path and new-side line exactly once
  for (let index = 0; index < requested.length; index += 1) {
    const comment = requested[index]!;
    const changes = comparison.changes.filter(change => change.file === comment.path && diffRows(change.patch).some(row => row.new === comment.line));
    // reject missing and ambiguous anchors rather than selecting one
    if (changes.length !== 1) return undefined;
    mapped.push({ id: `mcp_${shortDigest(`${requestId}\0${index}\0${comment.path}\0${comment.line}\0${comment.body}`)}`, changeId: changes[0]!.id, startSide: 'additions', startLine: comment.line, endSide: 'additions', endLine: comment.line, body: comment.body });
  }
  return mapped;
}

// parse owner/name or an exact github.com remote URL
function parseRepository(value: unknown): GithubRepository | undefined {
  // reject non-string and whitespace-bearing locators
  if (typeof value !== 'string') return undefined;
  const direct = /^([^/\s]{1,100})\/([^/\s]{1,100})$/u.exec(value.trim());
  return direct === null ? githubRepository(value) : { owner: direct[1]!, name: direct[2]! };
}

// derive marker-safe deterministic request keys without exposing request content
function shortDigest(value: string): string { return createHash('sha256').update(value).digest('base64url').slice(0, 32); }

// preserve source-port refusals without exposing GitHub payloads
function draftFailure(error: unknown): DeveloperResult {
  // map only source errors proven to precede every GitHub write
  if (error instanceof PullRequestReviewError) {
    if (error.code === 'stale') return developerFailure('stale_preparation', error.message, error.retryable);
    if (error.code === 'no_pull_request') return developerFailure('not_found', error.message, error.retryable);
    if (error.code === 'no_github_token') return developerFailure('forbidden', error.message, error.retryable);
    if (error.code === 'uncommitted' || error.code === 'head_mismatch') return developerFailure('invalid_state', error.message, error.retryable);
  }
  throw error;
}
