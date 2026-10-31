import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gitStatusSummary } from '../git/comparison.js';
import { at, GithubRequestError, repositoryPath, type Command, type GithubRepository } from '../github/github.js';
import { GithubService } from '../github/service.js';
import { addReviewThreads, draftReviewContent, draftReviewTarget, startDraftReview, updateDraftReview, type DraftReview, type DraftReviewTarget } from '../github/writes.js';
import { run } from '../tmux/command.js';
import { ReviewTourError, type ReviewComparison, type ReviewTourInput } from './contracts.js';
import { diffRows, type DiffRow } from './diff-rows.js';

// Posts a Review tour's feedback to one GitHub pull request of the branch as the operator's draft
// review (GitHub's PENDING review), which they finish on GitHub; the console never submits it
// (ADR 0011). Inline comments land as line threads where GitHub's own diff carries the same rows
// at the same line numbers, and as file-level threads quoting the commented rows where it does not
// or where GitHub refuses the line range. Line numbers must name committed, pushed content: a
// commented file must be clean, local HEAD must be the PR's head, and an existing draft must sit on
// that same commit. Every thread and every note section carries a hidden marker that is checked
// against the draft before posting and read back after a lost response, so a retry or a second
// submit skips what the draft already holds instead of adding it again.

type Capture = (agentId: string, input: ReviewTourInput) => Promise<ReviewComparison>;

// 200 comments of 4,000 characters and 40,000 characters of sections, at up to three UTF-8 bytes a
// character; the web caps a tour's notes at 20,000 characters of raw text, far below this
export const PR_REVIEW_REQUEST_BODY_BYTES = 3_145_728;
const maxSections = 100;
// the notes' 20,000-character cap plus the headings and quotes the web adds around them
const maxSectionCharacters = 40_000;
const maxComments = 200;
const maxComment = 4_000;
// GitHub lists at most 3000 files of a pull request
const maxFilePages = 30;
// threads added per GraphQL request; each is a separate mutation run in order
const threadBatch = 10;
const maxQuotedRows = 8;
const markerPattern = /<!-- rac:([A-Za-z0-9_-]+) -->/gu;

export type ReviewDiffSide = 'deletions' | 'additions';
export type PullRequestReviewComment = { id: string; changeId: string; startSide: ReviewDiffSide; startLine: number; endSide: ReviewDiffSide; endLine: number; body: string };
type CommentRange = Pick<PullRequestReviewComment, 'startSide' | 'startLine' | 'endSide' | 'endLine'>;
// one part of the review body (a step's note, the general notes), deduped by its key and text
export type PullRequestReviewSection = { key: string; markdown: string };
// `pullRequestNumber` pins the pull request the operator chose
export type PullRequestReviewInput = { scope: 'pr'; includeTests: boolean; includeDocs: boolean; fingerprint: string; pullRequestNumber: number; sections: PullRequestReviewSection[]; comments: PullRequestReviewComment[] };
// `file` is a comment posted as a file-level thread, `reason` saying why it could not sit on its lines
export type PullRequestReviewCommentResult = { id: string; result: 'line' | 'file' | 'failed'; reason?: string };
// a section is `posted` when the draft holds it, appended now or already there
export type PullRequestReviewResult = { status: 'ok'; review: { url: string; pullRequest: { number: number; url: string } }; sections: Array<{ key: string; posted: boolean }>; comments: PullRequestReviewCommentResult[] };
export type PullRequestReviewErrorCode = 'stale' | 'uncommitted' | 'no_pull_request' | 'pull_request_mismatch' | 'no_github_token' | 'head_mismatch' | 'pending_review_outdated' | 'github_forbidden' | 'github_failed';

export class PullRequestReviewError extends Error {
  // carry an operator-facing message and the details the client shows with it
  constructor(readonly code: PullRequestReviewErrorCode, readonly retryable: boolean, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PullRequestReviewError';
  }

  get httpStatus(): number { return this.code === 'github_failed' || this.code === 'github_forbidden' ? 502 : 409; }
}

// a GitHub failure as the post's error: refused credentials or permission, else a retryable-or-not failure
function reviewError(error: unknown): unknown {
  if (!(error instanceof GithubRequestError)) return error;
  const details = error.githubStatus === undefined ? {} : { githubStatus: error.githubStatus };
  return error.kind === 'forbidden' ? new PullRequestReviewError('github_forbidden', false, error.message, details) : new PullRequestReviewError('github_failed', error.kind === 'transient', error.message, details);
}

const sideSchema = z.enum(['deletions', 'additions']);
// ids and keys travel inside HTML comment markers, so they are held to charsets that cannot close one
const commentSchema = z.object({ id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u), changeId: z.string().min(8).max(100), startSide: sideSchema, startLine: z.number().int().positive(), endSide: sideSchema, endLine: z.number().int().positive(), body: z.string().max(maxComment).refine(body => body.trim() !== '') }).strict();
const sectionSchema = z.object({ key: z.string().min(1).max(120).regex(/^[A-Za-z0-9_:-]+$/u), markdown: z.string().max(maxSectionCharacters).refine(markdown => markdown.trim() !== '') }).strict();
const inputSchema = z.object({ scope: z.literal('pr'), includeTests: z.boolean(), includeDocs: z.boolean(), fingerprint: z.string().min(16).max(128), pullRequestNumber: z.number().int().positive(), sections: z.array(sectionSchema).max(maxSections), comments: z.array(commentSchema).max(maxComments) }).strict()
  // require something to post, ids and keys the results can be keyed by, and bounded notes
  .refine(input => input.sections.length > 0 || input.comments.length > 0)
  .refine(input => new Set(input.comments.map(comment => comment.id)).size === input.comments.length)
  .refine(input => new Set(input.sections.map(section => section.key)).size === input.sections.length)
  .refine(input => input.sections.reduce((total, section) => total + section.markdown.length, 0) <= maxSectionCharacters);

// parse the exact post request
export function parsePullRequestReviewInput(value: unknown): PullRequestReviewInput | undefined {
  const parsed = inputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// ---- Pure diff helpers ----------------------------------------------------------------------

// one row of a unified diff: its hunk, its old and/or new line number, and its text without the prefix
const lineOn = (side: ReviewDiffSide, row: DiffRow) => side === 'deletions' ? row.old : row.new;
const rowIndexes = (rows: DiffRow[], comment: CommentRange) => [rows.findIndex(row => lineOn(comment.startSide, row) === comment.startLine), rows.findIndex(row => lineOn(comment.endSide, row) === comment.endLine)] as const;

// the rows a comment's range covers, inclusive and in row order whichever end was named first;
// undefined when an end is missing
export function coveredRows(rows: DiffRow[], comment: CommentRange): DiffRow[] | undefined {
  const [start, end] = rowIndexes(rows, comment);
  return start < 0 || end < 0 ? undefined : rows.slice(Math.min(start, end), Math.max(start, end) + 1);
}

// the comment with its ends swapped when they run backwards through the tour patch (an added block
// above a removed one can yield a removed start below an added end), so GitHub gets start before end
export function orderedComment<T extends CommentRange>(tourPatch: string, comment: T): T {
  const [start, end] = rowIndexes(diffRows(tourPatch), comment);
  return start >= 0 && end >= 0 && end < start ? { ...comment, startSide: comment.endSide, startLine: comment.endLine, endSide: comment.startSide, endLine: comment.startLine } : comment;
}

// a GitHub row stands for a tour row when its text matches at the same new line, or for a removed
// row, at the same old line
const sameRow = (remote: DiffRow, local: DiffRow) => remote.text === local.text && (local.new === undefined ? remote.new === undefined && remote.old === local.old : remote.new === local.new);

// why a comment cannot sit on its lines in GitHub's diff of the file; undefined when it can
export function placementProblem(tourPatch: string, githubPatch: string | undefined, comment: CommentRange): string | undefined {
  const local = coveredRows(diffRows(tourPatch), comment);
  if (local === undefined) return 'The commented lines are not in the tour\'s diff.';
  // GitHub omits the patch of a binary or very large file
  if (githubPatch === undefined) return 'GitHub shows no line diff for this file.';
  const remote = coveredRows(diffRows(githubPatch), comment);
  if (remote === undefined) return 'The commented lines are outside the pull request\'s diff on GitHub.';
  if (remote.some(row => row.hunk !== remote[0]!.hunk)) return 'The commented lines span more than one hunk on GitHub.';
  if (remote.length !== local.length || remote.some((row, index) => !sameRow(row, local[index]!))) return 'The pull request\'s diff on GitHub differs from the tour at these lines.';
  return undefined;
}

// a GitHub diff side for a tour side
export function githubSide(side: ReviewDiffSide): 'LEFT' | 'RIGHT' { return side === 'deletions' ? 'LEFT' : 'RIGHT'; }

// a comment's lines in the web's words: "Line 5 (new)", "Lines 5–7 (old)", "Lines new 5 – old 7"
export function commentLocation(comment: CommentRange): string {
  const side = (value: ReviewDiffSide) => value === 'deletions' ? 'old' : 'new';
  if (comment.startSide !== comment.endSide) return `Lines ${side(comment.startSide)} ${comment.startLine} – ${side(comment.endSide)} ${comment.endLine}`;
  return comment.startLine === comment.endLine ? `Line ${comment.endLine} (${side(comment.endSide)})` : `Lines ${comment.startLine}–${comment.endLine} (${side(comment.endSide)})`;
}

// the tour patch rows a comment covers with their +/-/space prefixes, capped to the last few
export function quotedRows(tourPatch: string, comment: PullRequestReviewComment): string[] {
  const covered = (coveredRows(diffRows(tourPatch), comment) ?? []).map(row => `${row.old !== undefined && row.new !== undefined ? ' ' : row.new === undefined ? '-' : '+'}${row.text}`);
  return covered.length > maxQuotedRows ? ['…', ...covered.slice(-maxQuotedRows)] : covered;
}

// a file-level thread's text: the location, the quoted rows, then the comment
export function fileThreadBody(tourPatch: string, comment: PullRequestReviewComment): string {
  const quoted = quotedRows(tourPatch, comment);
  // outrun any backtick run in the quoted code
  const fence = '`'.repeat(Math.max(3, ...quoted.map(line => (line.match(/`+/gu) ?? []).reduce((longest, ticks) => Math.max(longest, ticks.length + 1), 0))));
  return [`**${commentLocation(comment)}**`, ...(quoted.length === 0 ? [] : [`${fence}diff\n${quoted.join('\n')}\n${fence}`]), comment.body.trim()].join('\n\n');
}

// the hidden marker a thread carries, naming the tour comment it posts
export function commentMarker(id: string): string { return `<!-- rac:${id} -->`; }

// the hidden marker a section carries, naming its key and text: a changed text is a new section
export function sectionMarker(section: PullRequestReviewSection): string { return `<!-- rac-section:${section.key}:${createHash('sha256').update(section.markdown.trim()).digest('hex').slice(0, 16)} -->`; }

// a section as appended to the review body
export function sectionText(section: PullRequestReviewSection): string { return `${section.markdown.trim()}\n\n${sectionMarker(section)}`; }

// a review body with the sections it does not yet hold appended; undefined when it holds them all
export function appendSections(body: string, sections: PullRequestReviewSection[]): string | undefined {
  const missing = sections.filter(section => !body.includes(sectionMarker(section)));
  if (missing.length === 0) return undefined;
  return [...(body.trim() === '' ? [] : [body]), ...missing.map(sectionText)].join('\n\n');
}

// the tour comments a review already holds, by the markers in its comments' bodies
export function placedComments(comments: Array<{ body: string; subjectType?: string }>): Map<string, 'line' | 'file'> {
  const placed = new Map<string, 'line' | 'file'>();
  for (const comment of comments) for (const match of comment.body.matchAll(markerPattern)) placed.set(match[1]!, comment.subjectType === 'FILE' ? 'file' : 'line');
  return placed;
}

// one AddPullRequestReviewThreadInput; a line thread names its last line, and its first only when it spans several
export function threadInput(reviewId: string, path: string, comment: PullRequestReviewComment, placement: 'line' | 'file', body: string): Record<string, unknown> {
  if (placement === 'file') return { pullRequestReviewId: reviewId, path, body, subjectType: 'FILE' };
  const multiLine = comment.startSide !== comment.endSide || comment.startLine !== comment.endLine;
  return { pullRequestReviewId: reviewId, path, body, line: comment.endLine, side: githubSide(comment.endSide), ...(multiLine ? { startLine: comment.startLine, startSide: githubSide(comment.startSide) } : {}), subjectType: 'LINE' };
}

// ---- Service ------------------------------------------------------------------------------------

// a draft review as it stands: its body and the tour comments its threads already post
type ReviewState = { id: string; body: string; placed: Map<string, 'line' | 'file'> };
type PlannedThread = { comment: PullRequestReviewComment; path: string; patch: string; placement: 'line' | 'file'; reason?: string; body: string };

const git = '/usr/bin/git';
// listing the pull request's files reads more than a summary does, so GitHub gets longer to answer
const timeoutMs = 15_000;

// a comment's result from where a thread posts it
function placedResult(thread: PlannedThread, placement: 'line' | 'file'): PullRequestReviewCommentResult {
  return { id: thread.comment.id, result: placement, ...(placement === 'file' && thread.reason !== undefined ? { reason: thread.reason } : {}) };
}

// the comment re-planned as a file-level thread quoting its rows
function fileThread(thread: PlannedThread, reason: string): PlannedThread {
  return { ...thread, placement: 'file', reason, body: `${fileThreadBody(thread.patch, thread.comment)}\n\n${commentMarker(thread.comment.id)}` };
}

export class PullRequestReviewService {
  // one post per checkout at a time: a second post waits, then finds the first one's markers
  private readonly posting = new Map<string, Promise<unknown>>();

  constructor(private readonly capture: Capture, private readonly command: Command = run, private readonly github: Pick<GithubService, 'client' | 'token' | 'repositoryAt' | 'changed'> = new GithubService()) {}

  // post a tour's feedback as the operator's draft review on the chosen pull request
  async post(agentId: string, input: PullRequestReviewInput): Promise<PullRequestReviewResult> {
    const comparison = await this.capture(agentId, { scope: input.scope, includeTests: input.includeTests, includeDocs: input.includeDocs });
    // the comments' change ids and line numbers belong to the tour's Comparison
    if (comparison.fingerprint !== input.fingerprint) throw new PullRequestReviewError('stale', false, 'The worktree has changed since this tour was built. Rebuild the tour, then post again.');
    const previous = this.posting.get(comparison.workspace) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => await this.postTo(comparison, input));
    this.posting.set(comparison.workspace, current);
    try { return await current; } catch (error) { throw reviewError(error); } finally {
      // forget a settled post unless another queued behind it
      if (this.posting.get(comparison.workspace) === current) this.posting.delete(comparison.workspace);
    }
  }

  private async postTo(comparison: ReviewComparison, input: PullRequestReviewInput): Promise<PullRequestReviewResult> {
    const changes = new Map(comparison.changes.map(change => [change.id, change]));
    const results = new Map<string, PullRequestReviewCommentResult>();
    const known = input.comments.filter(comment => {
      // fail a comment on a Change the Comparison no longer has
      if (changes.has(comment.changeId)) return true;
      results.set(comment.id, { id: comment.id, result: 'failed', reason: 'The comment\'s change is not in the tour.' });
      return false;
    });
    const files = [...new Set(known.map(comment => changes.get(comment.changeId)!.file))];
    await this.requireCommitted(comparison.workspace, files);
    const repository = await this.github.repositoryAt(comparison.workspace, true);
    // require a GitHub origin and a branch the pull request must be from
    if (repository === undefined) throw new PullRequestReviewError('no_pull_request', false, 'The worktree\'s origin is not a GitHub repository.');
    const branch = comparison.branch;
    if (branch === undefined) throw new PullRequestReviewError('no_pull_request', false, 'The worktree is not on a branch, so it has no pull request.');
    const token = await this.github.token();
    if (token === undefined) throw new PullRequestReviewError('no_github_token', false, 'GitHub authentication is not configured. Set RAC_GITHUB_TOKEN or sign in with the gh CLI.');
    const [head, pullRequest] = await Promise.all([this.head(comparison.workspace), this.pullRequest(token, repository, input.pullRequestNumber, branch)]);
    // the comments' lines are local commits' lines, so they must be the PR's head
    if (head !== pullRequest.headSha) throw new PullRequestReviewError('head_mismatch', true, 'Your local commit does not match the pull request\'s head on GitHub. Push your commits (or pull), then post again.', { localHead: head, pullRequestHead: pullRequest.headSha });
    // threads attach to the draft's commit, so an older draft would misplace them
    this.requireCurrentDraft(pullRequest.draft, head);
    const remoteFiles = files.length === 0 ? new Map<string, { patch?: string }>() : await this.files(token, repository, pullRequest.number, new Set(files));
    const planned: PlannedThread[] = [];
    // place each comment on its lines, else on its file
    for (const requested of known) {
      const change = changes.get(requested.changeId)!;
      const comment = orderedComment(change.patch, requested);
      const remote = remoteFiles.get(change.file);
      if (remote === undefined) { results.set(comment.id, { id: comment.id, result: 'failed', reason: 'The file is not part of the pull request on GitHub.' }); continue; }
      const reason = placementProblem(change.patch, remote.patch, comment);
      const line: PlannedThread = { comment, path: change.file, patch: change.patch, placement: 'line', body: `${comment.body.trim()}\n\n${commentMarker(comment.id)}` };
      planned.push(reason === undefined ? line : fileThread(line, reason));
    }
    let review = pullRequest.draft === undefined ? undefined : await this.reviewState(token, pullRequest.draft.id);
    try {
      // open a draft only when there is something to put in it, its body holding the sections
      if (review === undefined && (planned.length > 0 || input.sections.length > 0)) review = await this.openReview(token, repository, pullRequest.number, branch, pullRequest.id, head, appendSections('', input.sections) ?? '');
      // append the sections the draft does not hold yet
      const body = review === undefined ? undefined : appendSections(review.body, input.sections);
      if (review !== undefined && body !== undefined) review = await this.updateReviewBody(token, review, body);
      // a comment some earlier post already placed keeps that placement
      const fresh = planned.filter(thread => {
        const placed = review?.placed.get(thread.comment.id);
        if (placed !== undefined) results.set(thread.comment.id, placedResult(thread, placed));
        return placed === undefined;
      });
      if (review !== undefined) {
        const refused = await this.addThreads(token, review.id, fresh, results);
        // a line range GitHub refuses goes on the file instead, a different mutation the markers guard
        await this.addThreads(token, review.id, refused.map(({ thread, reason }) => fileThread(thread, `GitHub refused the line range: ${reason}`)), results);
      }
    } finally {
      // anything written, even by a post that then failed, changes what the console shows of the pull request
      if (planned.length > 0 || input.sections.length > 0) this.github.changed(repository, pullRequest.number);
    }
    const finalBody = review?.body ?? '';
    return { status: 'ok', review: { url: `${pullRequest.url}/files`, pullRequest: { number: pullRequest.number, url: pullRequest.url } }, sections: input.sections.map(section => ({ key: section.key, posted: finalBody.includes(sectionMarker(section)) })), comments: input.comments.map(comment => results.get(comment.id)!) };
  }

  // refuse a draft review on another commit
  private requireCurrentDraft(draft: DraftReview | undefined, head: string): void {
    if (draft !== undefined && draft.commit !== head) throw new PullRequestReviewError('pending_review_outdated', true, 'You have a draft review (GitHub shows it as Pending) on an older commit of this pull request. Submit or discard it on GitHub first.', { pendingReviewCommit: draft.commit ?? null, head });
  }

  // refuse commented files whose working tree differs from HEAD, staged, unstaged or untracked
  private async requireCommitted(workspace: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const status = await this.command(git, ['--no-optional-locks', '--literal-pathspecs', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...files]);
    if (status.code !== 0) throw new ReviewTourError('scope_unavailable', true);
    const dirty = [...new Set((gitStatusSummary(status.stdout).changes ?? []).map(change => change.path))];
    if (dirty.length > 0) throw new PullRequestReviewError('uncommitted', true, `Commit and push ${dirty.length === 1 ? 'this file' : 'these files'} first; the comments' line numbers must match the pull request: ${dirty.join(', ')}`, { files: dirty });
  }

  private async head(workspace: string): Promise<string> {
    const head = await this.command(git, ['-C', workspace, 'rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) throw new ReviewTourError('scope_unavailable', true);
    return head.stdout.trim().toLowerCase();
  }

  // the chosen pull request, which must be open and from this branch on origin's own owner, with
  // the viewer's draft review
  private async pullRequest(token: string, repository: GithubRepository, number: number, branch: string): Promise<DraftReviewTarget> {
    const found = await draftReviewTarget(this.github.client, token, repository, number);
    const mismatch = (message: string) => new PullRequestReviewError('pull_request_mismatch', false, message, { pullRequestNumber: number });
    if (found === undefined) throw mismatch(`Pull request #${number} was not found on GitHub.`);
    if (found.state !== 'OPEN') throw mismatch(`Pull request #${number} is not open.`);
    if (found.branch !== branch || found.headOwner.toLowerCase() !== repository.owner.toLowerCase()) throw mismatch(`Pull request #${number} is not from this worktree's branch ${branch}.`);
    return found;
  }

  // a draft review's body and the tour comments it already holds
  private async reviewState(token: string, id: string): Promise<ReviewState> {
    const { body, comments } = await draftReviewContent(this.github.client, token, id);
    return { id, body, placed: placedComments(comments) };
  }

  // the PR's files that carry comments, each with GitHub's patch when it shows one
  private async files(token: string, repository: GithubRepository, number: number, wanted: Set<string>): Promise<Map<string, { patch?: string }>> {
    const found = new Map<string, { patch?: string }>();
    for (let page = 1; page <= maxFilePages && found.size < wanted.size; page += 1) {
      const response = await this.github.client.get(`https://api.github.com/repos/${repositoryPath(repository)}/pulls/${number}/files?per_page=100&page=${page}`, token, 'GitHub could not list the pull request\'s files', timeoutMs);
      const listed = await response.json().catch(() => undefined);
      if (!Array.isArray(listed)) throw new GithubRequestError('GitHub returned invalid pull request files.', 502, undefined, 'transient');
      for (const file of listed) {
        const [filename, patch] = [at(file, 'filename'), at(file, 'patch')];
        if (typeof filename === 'string' && wanted.has(filename)) found.set(filename, typeof patch === 'string' ? { patch } : {});
      }
      // a short page is the last one
      if (listed.length < 100) break;
    }
    return found;
  }

  // open a draft review on the head commit; when the outcome is unknown, a draft that now exists
  // on the head is the one this opened
  private async openReview(token: string, repository: GithubRepository, number: number, branch: string, pullRequestId: string, head: string, body: string): Promise<ReviewState> {
    try {
      return { id: await startDraftReview(this.github.client, token, pullRequestId, head, body), body, placed: new Map() };
    } catch (error) {
      if (!(error instanceof GithubRequestError) || error.kind !== 'transient') throw error;
      const draft = (await this.pullRequest(token, repository, number, branch)).draft;
      if (draft === undefined) throw error;
      this.requireCurrentDraft(draft, head);
      return await this.reviewState(token, draft.id);
    }
  }

  // replace the draft's body; when the outcome is unknown, the draft's body is read back
  private async updateReviewBody(token: string, review: ReviewState, body: string): Promise<ReviewState> {
    try {
      await updateDraftReview(this.github.client, token, review.id, body);
      return { ...review, body };
    } catch (error) {
      if (!(error instanceof GithubRequestError) || error.kind !== 'transient') throw error;
      return await this.reviewState(token, review.id);
    }
  }

  // add threads in batches, settling each comment's result; returns the line threads GitHub
  // refused, for the caller to place on their files
  private async addThreads(token: string, reviewId: string, threads: PlannedThread[], results: Map<string, PullRequestReviewCommentResult>): Promise<Array<{ thread: PlannedThread; reason: string }>> {
    const refused: Array<{ thread: PlannedThread; reason: string }> = [];
    for (let start = 0; start < threads.length; start += threadBatch) {
      const batch = threads.slice(start, start + threadBatch);
      const outcome = await addReviewThreads(this.github.client, token, batch.map(thread => threadInput(reviewId, thread.path, thread.comment, thread.placement, thread.body)));
      if (!outcome.ambiguous) {
        batch.forEach((thread, index) => {
          const result = outcome.outcomes[index]!;
          if (result.created) { results.set(thread.comment.id, placedResult(thread, thread.placement)); return; }
          results.set(thread.comment.id, { id: thread.comment.id, result: 'failed', reason: result.reason });
          if (result.refused && thread.placement === 'line') refused.push({ thread, reason: result.reason });
        });
        continue;
      }
      // read back what the batch did; without that, all of it counts as failed and a retry dedupes
      const reread = await this.reviewState(token, reviewId).catch(() => undefined);
      batch.forEach(thread => {
        const placed = reread?.placed.get(thread.comment.id);
        results.set(thread.comment.id, placed === undefined ? { id: thread.comment.id, result: 'failed', reason: outcome.reason } : placedResult(thread, placed));
      });
    }
    return refused;
  }
}
