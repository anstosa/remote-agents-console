import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ReviewTourError, type EarlierThreads, type ReviewComparison, type ReviewTourInput } from '../src/review-tour/contracts.js';
import { replyMarker, commentMarker, coveredRows, fileThreadBody, orderedComment, parsePullRequestReviewInput, placedComments, placementProblem, PullRequestReviewError, PullRequestReviewService, appendSections, sectionMarker, sectionText, threadInput, type PullRequestReviewComment, type PullRequestReviewInput, type PullRequestReviewReply } from '../src/review-tour/pr-review.js';
import { ambiguousBatch, threadMutation, threadOutcomes } from '../src/github/writes.js';
import { diffRows } from '../src/review-tour/diff-rows.js';
import { GithubService } from '../src/github/service.js';
import { testConfig } from './helpers/config.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';

// the tour's one-hunk Change: old 10-14 become new 10-15
const tourPatch = 'diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -10,5 +10,6 @@ function feature\n keep10\n-old11\n+new11\n+new12\n keep12\n keep13\n keep14\n';
// GitHub's header-less patch of the same file, with a second hunk further down
const githubPatch = '@@ -10,5 +10,6 @@ function feature\n keep10\n-old11\n+new11\n+new12\n keep12\n keep13\n keep14\n@@ -40,3 +41,4 @@\n a\n+b\n c\n d';
// a hunk whose added line sits above the removed one
const swapPatch = '@@ -5,3 +5,3 @@\n ctx5\n+add6\n-del6\n ctx7';
const head = 'a'.repeat(40);
const fingerprint = 'fingerprint-0123456789';

// one comment on the tour's Change
function comment(overrides: Partial<PullRequestReviewComment> = {}): PullRequestReviewComment {
  return { id: 'c1', changeId: 'chg_feature01', startSide: 'additions', startLine: 11, endSide: 'additions', endLine: 12, body: 'Rename these.', ...overrides };
}

describe('pull request review diff placement', () => {
  it('numbers rows across hunks and skips the file header', () => {
    const rows = diffRows(githubPatch);
    expect(rows.slice(0, 5)).toEqual([{ hunk: 0, old: 10, new: 10, text: 'keep10' }, { hunk: 0, old: 11, text: 'old11' }, { hunk: 0, new: 11, text: 'new11' }, { hunk: 0, new: 12, text: 'new12' }, { hunk: 0, old: 12, new: 13, text: 'keep12' }]);
    expect(rows.find(row => row.text === 'b')).toEqual({ hunk: 1, new: 42, text: 'b' });
    expect(diffRows(tourPatch)).toHaveLength(7);
    expect(coveredRows(diffRows(tourPatch), comment({ startSide: 'deletions', startLine: 11, endLine: 11 }))?.map(row => row.text)).toEqual(['old11', 'new11']);
  });

  it('accepts additions, context on either side, and a range from a removed to an added line', () => {
    expect(placementProblem(tourPatch, githubPatch, comment())).toBeUndefined();
    expect(placementProblem(tourPatch, githubPatch, comment({ startSide: 'deletions', startLine: 12, endSide: 'deletions', endLine: 13 }))).toBeUndefined();
    expect(placementProblem(tourPatch, githubPatch, comment({ startSide: 'deletions', startLine: 11, endSide: 'additions', endLine: 12 }))).toBeUndefined();
  });

  it('orders a range whose ends run backwards through the hunk', () => {
    const reversed = comment({ startSide: 'deletions', startLine: 6, endSide: 'additions', endLine: 6 });
    expect(coveredRows(diffRows(swapPatch), reversed)?.map(row => row.text)).toEqual(['add6', 'del6']);
    const ordered = orderedComment(swapPatch, reversed);
    expect(ordered).toMatchObject({ startSide: 'additions', startLine: 6, endSide: 'deletions', endLine: 6 });
    expect(placementProblem(swapPatch, swapPatch, ordered)).toBeUndefined();
    expect(threadInput('R', 'f', ordered, 'line', 'b')).toMatchObject({ startLine: 6, startSide: 'RIGHT', line: 6, side: 'LEFT' });
    expect(orderedComment(tourPatch, comment())).toEqual(comment());
  });

  it('refuses rows GitHub shows differently, lacks, or splits across hunks', () => {
    expect(placementProblem(tourPatch, githubPatch.replace('+new12', '+NEW12'), comment())).toMatch(/differs/u);
    // the old side moved: GitHub's base differs from the tour's
    expect(placementProblem(tourPatch, githubPatch.replace('@@ -10,5', '@@ -9,5'), comment({ startSide: 'deletions', startLine: 11, endSide: 'deletions', endLine: 11 }))).toMatch(/differs/u);
    expect(placementProblem(tourPatch, undefined, comment())).toMatch(/no line diff/u);
    expect(placementProblem(tourPatch, '@@ -40,3 +41,4 @@\n a\n+b\n c\n d', comment())).toMatch(/outside/u);
    expect(placementProblem(tourPatch, '@@ -10,2 +10,2 @@\n keep10\n-old11\n+new11\n@@ -12,1 +12,2 @@\n+new12\n keep12', comment())).toMatch(/more than one hunk/u);
    expect(placementProblem(tourPatch, githubPatch, comment({ startLine: 30, endLine: 30 }))).toMatch(/not in the tour/u);
  });

  it('quotes the commented rows in a file-level body, outrunning backticks in the code', () => {
    expect(fileThreadBody(tourPatch, comment())).toBe('**Lines 11–12 (new)**\n\n```diff\n+new11\n+new12\n```\n\nRename these.');
    expect(fileThreadBody(tourPatch, comment({ startSide: 'deletions', startLine: 11, endLine: 11, body: ' Why? ' }))).toBe('**Lines old 11 – new 11**\n\n```diff\n-old11\n+new11\n```\n\nWhy?');
    const ticks = tourPatch.replace('+new11', '+const s = ```x```;');
    expect(fileThreadBody(ticks, comment({ startLine: 11, endLine: 11 }))).toBe('**Line 11 (new)**\n\n````diff\n+const s = ```x```;\n````\n\nRename these.');
    expect(fileThreadBody(tourPatch, comment({ startLine: 30, endLine: 30 }))).toBe('**Line 30 (new)**\n\nRename these.');
  });

  it('reads tour comment markers and their placement from review comments', () => {
    expect(commentMarker('c-1_x')).toBe('<!-- rac:c-1_x -->');
    expect(sectionMarker({ key: 'step:1', markdown: ' Notes ' })).toMatch(/^<!-- rac-section:step:1:[0-9a-f]{16} -->$/u);
    expect(sectionMarker({ key: 'step:1', markdown: 'Notes' })).toBe(sectionMarker({ key: 'step:1', markdown: 'Notes\n' }));
    expect(sectionMarker({ key: 'step:1', markdown: 'Notes' })).not.toBe(sectionMarker({ key: 'step:1', markdown: 'Other' }));
    const general = { key: 'general', markdown: 'General notes' };
    const step = { key: 'step:2', markdown: 'Step notes' };
    expect(appendSections('', [general, step])).toBe(`${sectionText(general)}\n\n${sectionText(step)}`);
    expect(appendSections(`Mine\n\n${sectionText(general)}`, [general, step])).toBe(`Mine\n\n${sectionText(general)}\n\n${sectionText(step)}`);
    expect(appendSections(`${sectionText(general)}\n\n${sectionText(step)}`, [general, step])).toBeUndefined();
    expect(placedComments([{ body: `x\n\n${commentMarker('a')}`, subjectType: 'LINE' }, { body: `y\n\n${commentMarker('b')}`, subjectType: 'FILE' }, { body: 'someone else' }])).toEqual(new Map([['a', 'line'], ['b', 'file']]));
  });
});

describe('pull request review GraphQL', () => {
  it('builds line, multi-line, cross-side and file thread inputs', () => {
    expect(threadInput('R', 'src/feature.ts', comment({ startLine: 12 }), 'line', 'b')).toEqual({ pullRequestReviewId: 'R', path: 'src/feature.ts', body: 'b', line: 12, side: 'RIGHT', subjectType: 'LINE' });
    expect(threadInput('R', 'src/feature.ts', comment(), 'line', 'b')).toEqual({ pullRequestReviewId: 'R', path: 'src/feature.ts', body: 'b', line: 12, side: 'RIGHT', startLine: 11, startSide: 'RIGHT', subjectType: 'LINE' });
    expect(threadInput('R', 'src/feature.ts', comment({ startSide: 'deletions', startLine: 11, endLine: 11 }), 'line', 'b')).toMatchObject({ line: 11, side: 'RIGHT', startLine: 11, startSide: 'LEFT' });
    expect(threadInput('R', 'src/feature.ts', comment(), 'file', 'b')).toEqual({ pullRequestReviewId: 'R', path: 'src/feature.ts', body: 'b', subjectType: 'FILE' });
  });

  it('aliases one mutation per thread and maps partial failures back to them', () => {
    const mutation = threadMutation([{ path: 'a' }, { path: 'b' }]);
    expect(mutation.query).toBe('mutation($i0:AddPullRequestReviewThreadInput!,$i1:AddPullRequestReviewThreadInput!){t0:addPullRequestReviewThread(input:$i0){thread{id}} t1:addPullRequestReviewThread(input:$i1){thread{id}}}');
    expect(mutation.variables).toEqual({ i0: { path: 'a' }, i1: { path: 'b' } });
    expect(threadOutcomes(4, { data: { t0: { thread: { id: 'T0' } }, t1: null, t2: null, t3: null }, errors: [{ path: ['t1'], message: 'Line could not be resolved' }, { path: ['t3'], type: 'FORBIDDEN', message: 'No access' }] })).toEqual([{ created: true }, { created: false, reason: 'Line could not be resolved', refused: true }, { created: false, reason: 'GitHub did not create the comment thread.', refused: false }, { created: false, reason: 'No access', refused: false }]);
    expect(threadOutcomes(2, { errors: [{ message: 'Something went wrong' }] })).toEqual([{ created: false, reason: 'Something went wrong', refused: false }, { created: false, reason: 'Something went wrong', refused: false }]);
    expect(threadOutcomes(1, null)).toEqual([{ created: false, reason: 'GitHub did not create the comment thread.', refused: false }]);
  });

  it('calls only a data-less, alias-less error ambiguous', () => {
    expect(ambiguousBatch({ data: null, errors: [{ message: 'Something went wrong' }] })).toBe(true);
    expect(ambiguousBatch({ errors: [{ message: 'timeout' }] })).toBe(true);
    expect(ambiguousBatch({ data: null, errors: [{ path: ['t0'], message: 'bad line' }] })).toBe(false);
    expect(ambiguousBatch({ data: { t0: null }, errors: [{ message: 'x' }] })).toBe(false);
    expect(ambiguousBatch({ data: { t0: { thread: { id: 'T' } } } })).toBe(false);
  });

  it('parses only the exact All PR request, at its boundaries', () => {
    const valid = { scope: 'pr', includeTests: false, includeDocs: true, fingerprint, pullRequestNumber: 7, sections: [], comments: [comment()], replies: [] };
    expect(parsePullRequestReviewInput(valid)).toEqual(valid);
    // a bundle from before replies posts no replies
    const { replies: _replies, ...older } = valid;
    expect(parsePullRequestReviewInput(older)).toEqual(valid);
    const sectionsOnly = { ...valid, sections: [{ key: 'general', markdown: 'Notes' }], comments: [] };
    expect(parsePullRequestReviewInput(sectionsOnly)).toEqual(sectionsOnly);
    expect(parsePullRequestReviewInput({ ...valid, scope: 'working' })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...valid, comments: [] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...valid, pullRequestNumber: 0 })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...valid, body: 'old shape' })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...valid, comments: [comment(), comment()] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...valid, comments: [comment({ body: '  ' })] })).toBeUndefined();
    // an id or key that could close the hidden marker
    expect(parsePullRequestReviewInput({ ...valid, comments: [comment({ id: 'x -->' })] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...sectionsOnly, sections: [{ key: 'a -->', markdown: 'x' }] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...sectionsOnly, sections: [{ key: 'general', markdown: ' ' }] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...sectionsOnly, sections: [{ key: 'a', markdown: 'x' }, { key: 'a', markdown: 'y' }] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...valid, extra: true })).toBeUndefined();
    const comments = (count: number) => Array.from({ length: count }, (_, index) => comment({ id: `c${index}` }));
    expect(parsePullRequestReviewInput({ ...valid, comments: comments(200) })).toBeDefined();
    expect(parsePullRequestReviewInput({ ...valid, comments: comments(201) })).toBeUndefined();
    const sections = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `step:${index}`, markdown: 'x' }));
    expect(parsePullRequestReviewInput({ ...sectionsOnly, sections: sections(100) })).toBeDefined();
    expect(parsePullRequestReviewInput({ ...sectionsOnly, sections: sections(101) })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...sectionsOnly, sections: [{ key: 'a', markdown: 'x'.repeat(20_000) }, { key: 'b', markdown: 'x'.repeat(20_000) }] })).toBeDefined();
    expect(parsePullRequestReviewInput({ ...sectionsOnly, sections: [{ key: 'a', markdown: 'x'.repeat(20_000) }, { key: 'b', markdown: 'x'.repeat(20_001) }] })).toBeUndefined();
  });

  it('parses a Since my review post whose replies alone are something to post', () => {
    const since = { scope: 'since-review', reviewedCommit: 'b'.repeat(40), baseBranch: 'main', includeTests: false, includeDocs: false, fingerprint, pullRequestNumber: 7, sections: [], comments: [], replies: [{ threadId: 'PRRT_kwDO-a_1', body: 'Still open.' }] };
    expect(parsePullRequestReviewInput(since)).toEqual(since);
    expect(parsePullRequestReviewInput({ ...since, baseBranch: undefined })).toBeUndefined();
    // a reply cannot hide text, or a marker, from the reader in an HTML comment
    expect(parsePullRequestReviewInput({ ...since, replies: [{ threadId: 'T', body: 'Fixed <!-- rac-reply:T2:0123456789abcdef -->' }] })).toBeUndefined();
    // an old-style base64 node id
    expect(parsePullRequestReviewInput({ ...since, replies: [{ threadId: 'MDIzOlB1bGw+/=', body: 'x' }] })).toBeDefined();
    expect(parsePullRequestReviewInput({ ...since, reviewedCommit: undefined })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...since, replies: [] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...since, replies: [{ threadId: 'T -->', body: 'x' }] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...since, replies: [{ threadId: 'T', body: ' ' }] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...since, replies: [{ threadId: 'T', body: 'x'.repeat(4_001) }] })).toBeUndefined();
    expect(parsePullRequestReviewInput({ ...since, replies: [{ threadId: 'T', body: 'x' }, { threadId: 'T', body: 'y' }] })).toBeUndefined();
    const replies = (count: number) => Array.from({ length: count }, (_, index) => ({ threadId: `T${index}`, body: 'x' }));
    expect(parsePullRequestReviewInput({ ...since, replies: replies(100) })).toBeDefined();
    expect(parsePullRequestReviewInput({ ...since, replies: replies(101) })).toBeUndefined();
  });
});


type FakeComment = { body: string; subjectType: string; path: string; replyTo?: string };
type FakeReview = { id: string; body: string; commit: string; comments: FakeComment[] };
type Recorded = { url: string; query?: string; variables?: Record<string, unknown> };
type Scenario = {
  dirty?: string;
  localHead?: string;
  pending?: { commit: string; body: string; comments?: FakeComment[] };
  // overrides of the pull request GitHub returns; null when it has none by that number
  pull?: Record<string, unknown> | null;
  token?: string | null;
  // comment ids GitHub refuses on any thread, only as a line thread, or for lack of permission
  refuse?: string[];
  refuseLine?: string[];
  forbid?: string[];
  // how the first thread batch fails: `lost` applies its even threads then answers 502; `broken`
  // applies nothing and answers data:null with an untyped error; `forbidden` answers 403
  threadFailure?: 'lost' | 'broken' | 'forbidden';
  // how opening the review fails once: `lost` opens it then answers 502, `unapplied` only answers 502
  reviewFailure?: 'lost' | 'unapplied';
  // updating the body applies it, then answers 502
  updateFailure?: 'lost';
  // how the pull request query fails once
  queryFailure?: 502 | 401 | 'graphql-forbidden';
  // Review threads deleted since the tour read them
  deletedThreads?: string[];
  // the first reply batch applies its even replies, then answers 502
  replyFailure?: 'lost';
};

const markerId = (body: string) => /<!-- rac:([A-Za-z0-9_-]+) -->/u.exec(body)?.[1];
const general = { key: 'general', markdown: 'Overall looks good.' };

// a service over a fake Comparison, git and a stateful GitHub holding at most one draft review
function harness(scenario: Scenario = {}) {
  const comparison: ReviewComparison = { worktreeId: 'cora', workspace: '/worktrees/cora', branch: 'feature/x', scope: 'pr', base: 'origin/main', includeTests: true, includeDocs: false, fingerprint, changes: [
    { id: 'chg_feature01', file: 'src/feature.ts', category: 'implementation', kind: 'hunk', oldStart: 10, oldLines: 5, newStart: 10, newLines: 6, patch: tourPatch },
    { id: 'chg_missing1', file: 'src/missing.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-a\n+b' },
    { id: 'chg_swapped01', file: 'src/swap.ts', category: 'implementation', kind: 'hunk', patch: `diff --git a/src/swap.ts b/src/swap.ts\n--- a/src/swap.ts\n+++ b/src/swap.ts\n${swapPatch}` }
  ] };
  const state: { review?: FakeReview } = scenario.pending === undefined ? {} : { review: { id: 'PRR_old', body: scenario.pending.body, commit: scenario.pending.commit, comments: scenario.pending.comments ?? [] } };
  const requests: Recorded[] = [];
  const commands: string[][] = [];
  let { threadFailure, reviewFailure, updateFailure, queryFailure, replyFailure } = scenario;
  const captured: ReviewTourInput[] = [];
  const json = (value: unknown, status = 200) => ({ ok: status < 300, status, json: async () => value });
  const pullNode = () => scenario.pull === null ? null : { id: 'PR_1', number: 7, url: 'https://github.com/octo/repo/pull/7', state: 'OPEN', headRefName: 'feature/x', headRefOid: head, headRepositoryOwner: { login: 'Octo' }, reviews: { nodes: state.review === undefined ? [] : [{ id: state.review.id, body: state.review.body, commit: { oid: state.review.commit } }] }, ...scenario.pull };
  const command = async (_binary: string, args: string[]) => {
    commands.push(args);
    if (args.includes('status')) return { code: 0, stdout: scenario.dirty === undefined ? '' : ` M ${scenario.dirty}\0` };
    if (args.includes('remote')) return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    return { code: 0, stdout: `${scenario.localHead ?? head}\n` };
  };
  const github = new GithubService({ command, token: async () => scenario.token === null ? undefined : scenario.token ?? 'token-1', request: async (url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { query: string; variables: Record<string, unknown> } : undefined;
    requests.push({ url, ...(body === undefined ? {} : { query: body.query, variables: body.variables }) });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    // let a concurrent post interleave
    await new Promise(resolve => setImmediate(resolve));
    if (url.includes('/pulls/7/files')) return json([{ filename: 'src/other.ts', patch: '@@ -1 +1 @@\n-x\n+y' }, { filename: 'src/feature.ts', patch: githubPatch }, { filename: 'src/swap.ts', patch: swapPatch }]);
    const query = body?.query ?? '';
    const variables = body?.variables ?? {};
    if (query.includes('pullRequest(number:')) {
      const failure = queryFailure;
      queryFailure = undefined;
      if (failure === 502) return json({ message: 'Bad Gateway' }, 502);
      if (failure === 401) return json({ message: 'Bad credentials' }, 401);
      if (failure === 'graphql-forbidden') return json({ data: { repository: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
      return json({ data: { repository: { pullRequest: pullNode() } } });
    }
    if (query.includes('node(id:')) {
      // three comments a page, so reading a review pages through it
      const offset = typeof variables.after === 'string' ? Number(variables.after) : 0;
      const comments = state.review?.comments ?? [];
      const page = comments.slice(offset, offset + 3).map(entry => ({ body: entry.body, subjectType: entry.subjectType, replyTo: entry.replyTo === undefined ? null : { id: entry.replyTo } }));
      return json({ data: { node: state.review === undefined ? null : { id: state.review.id, body: state.review.body, comments: { pageInfo: { hasNextPage: offset + 3 < comments.length, endCursor: String(offset + 3) }, nodes: page } } } });
    }
    if (query.includes('addPullRequestReview(')) {
      const failure = reviewFailure;
      reviewFailure = undefined;
      const input = variables.input as { commitOID: string; body?: string };
      if (failure !== 'unapplied') state.review = { id: 'PRR_new', body: input.body ?? '', commit: input.commitOID, comments: [] };
      return failure === undefined ? json({ data: { addPullRequestReview: { pullRequestReview: { id: 'PRR_new' } } } }) : json({ message: 'Bad Gateway' }, 502);
    }
    if (query.includes('updatePullRequestReview(')) {
      const failure = updateFailure;
      updateFailure = undefined;
      state.review!.body = (variables.input as { body: string }).body;
      return failure === undefined ? json({ data: { updatePullRequestReview: { pullRequestReview: { id: state.review!.id } } } }) : json({ message: 'Bad Gateway' }, 502);
    }
    if (query.includes('addPullRequestReviewThreadReply(')) {
      const failure = replyFailure;
      replyFailure = undefined;
      const inputs = Object.values(variables) as Array<{ pullRequestReviewId: string; pullRequestReviewThreadId: string; body: string }>;
      const data: Record<string, unknown> = {};
      const errors: unknown[] = [];
      inputs.forEach((input, index) => {
        if (failure === 'lost' && index % 2 === 1) return;
        expect(input.pullRequestReviewId).toBe(state.review!.id);
        if (scenario.deletedThreads?.includes(input.pullRequestReviewThreadId)) { data[`t${index}`] = null; errors.push({ path: [`t${index}`], type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${input.pullRequestReviewThreadId}'` }); return; }
        state.review!.comments.push({ body: input.body, subjectType: 'LINE', path: 'src/feature.ts', replyTo: opener(input.pullRequestReviewThreadId) });
        data[`t${index}`] = { comment: { id: `C${state.review!.comments.length}` } };
      });
      return failure === 'lost' ? json({ message: 'Bad Gateway' }, 502) : json({ data, ...(errors.length === 0 ? {} : { errors }) });
    }
    if (query.includes('addPullRequestReviewThread(')) {
      const failure = threadFailure;
      threadFailure = undefined;
      if (failure === 'forbidden') return json({ message: 'Resource not accessible by integration' }, 403);
      if (failure === 'broken') return json({ data: null, errors: [{ message: 'Something went wrong while executing your query.' }] });
      const inputs = Object.values(variables) as Array<{ body: string; subjectType: string; path: string }>;
      const data: Record<string, unknown> = {};
      const errors: unknown[] = [];
      inputs.forEach((input, index) => {
        if (failure === 'lost' && index % 2 === 1) return;
        const id = markerId(input.body) ?? '';
        const refusal = scenario.forbid?.includes(id) ? { type: 'FORBIDDEN', message: 'No access' } : scenario.refuse?.includes(id) ? { type: 'UNPROCESSABLE', message: 'Validation failed' } : scenario.refuseLine?.includes(id) && input.subjectType === 'LINE' ? { type: 'UNPROCESSABLE', message: 'Line could not be resolved' } : undefined;
        if (refusal !== undefined) { data[`t${index}`] = null; errors.push({ path: [`t${index}`], ...refusal }); return; }
        state.review!.comments.push({ body: input.body, subjectType: input.subjectType, path: input.path });
        data[`t${index}`] = { thread: { id: `T${state.review!.comments.length}` } };
      });
      return failure === 'lost' ? json({ message: 'Bad Gateway' }, 502) : json({ data, ...(errors.length === 0 ? {} : { errors }) });
    }
    return json({ message: 'Not Found' }, 404);
  } });
  const raw = new PullRequestReviewService(async (worktreeId, input) => {
    // the tour's own Comparison choices reach the capture
    expect(worktreeId).toBe('cora');
    captured.push(input);
    return comparison;
  }, command, github);
  // a post from the stored tour, whose snapshot holds every thread these tests reply on
  // (`null`: none stored)
  const service = { post: async (worktreeId: string, input: PullRequestReviewInput, earlier: EarlierThreads | null = snapshot(['PRRT_1', 'PRRT_2', 'PRRT_3', 'PRRT_gone', 'PRRT_a', 'PRRT_b', 'PRRT_c'])) => await raw.post(worktreeId, input, earlier ?? undefined) };
  const mutations = (name?: string) => requests.filter(entry => entry.query?.startsWith('mutation') === true && (name === undefined || entry.query.includes(`${name}(`)));
  return { service, github, requests, commands, state, mutations, captured };
}

// the first comment of each earlier thread, which GitHub sets every reply on it to reply to
const opener = (threadId: string) => `${threadId}_C0`;
// a Since my review tour's snapshot of my earlier threads `ids` on pull request `pullRequest`
const snapshot = (ids: string[], pullRequest = 7): EarlierThreads => ({ pullRequest, threads: ids.map(id => ({ id, path: 'src/feature.ts', line: 11, resolved: false, outdated: false, diffHunk: '@@ -10 +10 @@', comments: [{ id: opener(id), author: 'octocat', bot: false, mine: true, body: 'Rename this.', createdAt: '2026-10-01T00:00:00Z', url: `https://github.com/octo/repo/pull/7#discussion_${id}` }] })) });

const request = (comments: PullRequestReviewComment[], sections = [general]): PullRequestReviewInput => ({ scope: 'pr', includeTests: true, includeDocs: false, fingerprint, pullRequestNumber: 7, sections, comments, replies: [] });
const reviewedCommit = 'b'.repeat(40);
// a Since my review post of replies alone
const replying = (replies: PullRequestReviewReply[]): PullRequestReviewInput => ({ scope: 'since-review', reviewedCommit, baseBranch: 'main', includeTests: true, includeDocs: false, fingerprint, pullRequestNumber: 7, sections: [], comments: [], replies });
const marked = (text: string, id: string) => `${text}\n\n${commentMarker(id)}`;

// the error a rejected post throws
async function refusal(promise: Promise<unknown>): Promise<PullRequestReviewError> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  if (!(error instanceof PullRequestReviewError)) throw new Error(`expected a PullRequestReviewError, got ${String(error)}`);
  return error;
}

describe('pull request review service', () => {
  it('tells the GitHub module the pull request changed once something was posted', async () => {
    const { service, github } = harness();
    const changed = vi.spyOn(github, 'changed');
    await service.post('cora', request([], []));
    expect(changed).not.toHaveBeenCalled();
    await service.post('cora', request([comment()]));
    expect(changed).toHaveBeenCalledWith({ owner: 'octo', name: 'repo' }, 7);
  });

  it('tells the GitHub module of a post that failed once it had tried to write', async () => {
    const { service, github, mutations } = harness({ reviewFailure: 'unapplied' });
    const changed = vi.spyOn(github, 'changed');
    await expect(service.post('cora', request([comment()]))).rejects.toBeInstanceOf(PullRequestReviewError);
    expect(mutations('addPullRequestReview')).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith({ owner: 'octo', name: 'repo' }, 7);
  });

  it('opens a draft review and places line, file and failed comments', async () => {
    const { service, requests, commands, mutations } = harness({ refuse: ['refused'] });
    const comments = [
      comment({ id: 'line' }),
      comment({ id: 'refused', startSide: 'deletions', startLine: 11, endLine: 11 }),
      comment({ id: 'file', startLine: 30, endLine: 30, body: 'Off the diff.' }),
      comment({ id: 'unknown', changeId: 'chg_unknown1' }),
      comment({ id: 'absent', changeId: 'chg_missing1', startLine: 1, endLine: 1 })
    ];
    const result = await service.post('cora', request(comments));
    expect(result).toEqual({ status: 'ok', draftId: 'PRR_new', review: { url: 'https://github.com/octo/repo/pull/7/files', pullRequest: { number: 7, url: 'https://github.com/octo/repo/pull/7' } }, sections: [{ key: 'general', posted: true }], comments: [
      { id: 'line', result: 'line' },
      // refused on its lines and again on its file
      { id: 'refused', result: 'failed', reason: 'Validation failed' },
      { id: 'file', result: 'file', reason: 'The commented lines are not in the tour\'s diff.' },
      { id: 'unknown', result: 'failed', reason: 'The comment\'s change is not in the tour.' },
      { id: 'absent', result: 'failed', reason: 'The file is not part of the pull request on GitHub.' }
    ], replies: [] });
    expect(commands.find(args => args.includes('status'))).toEqual(['--no-optional-locks', '--literal-pathspecs', '-C', '/worktrees/cora', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'src/feature.ts', 'src/missing.ts']);
    expect(requests.find(entry => entry.query?.includes('pullRequest(number:'))?.variables).toEqual({ owner: 'octo', name: 'repo', number: 7 });
    expect(mutations('addPullRequestReview')[0]?.variables).toEqual({ input: { pullRequestId: 'PR_1', commitOID: head, body: sectionText(general) } });
    expect(mutations('updatePullRequestReview')).toHaveLength(0);
    const [threads, fallback] = mutations('addPullRequestReviewThread');
    expect(threads?.variables).toEqual({
      i0: { pullRequestReviewId: 'PRR_new', path: 'src/feature.ts', body: marked('Rename these.', 'line'), line: 12, side: 'RIGHT', startLine: 11, startSide: 'RIGHT', subjectType: 'LINE' },
      i1: { pullRequestReviewId: 'PRR_new', path: 'src/feature.ts', body: marked('Rename these.', 'refused'), line: 11, side: 'RIGHT', startLine: 11, startSide: 'LEFT', subjectType: 'LINE' },
      i2: { pullRequestReviewId: 'PRR_new', path: 'src/feature.ts', body: marked('**Line 30 (new)**\n\nOff the diff.', 'file'), subjectType: 'FILE' }
    });
    expect(fallback?.variables).toEqual({ i0: { pullRequestReviewId: 'PRR_new', path: 'src/feature.ts', body: marked('**Lines old 11 – new 11**\n\n```diff\n-old11\n+new11\n```\n\nRename these.', 'refused'), subjectType: 'FILE' } });
    expect(mutations()).toHaveLength(3);
    // nothing existed, so nothing was read back
    expect(requests.some(entry => entry.query?.includes('node(id:'))).toBe(false);
  });

  it('puts a line range GitHub refuses on its file, but not a forbidden one', async () => {
    const { service, mutations, state } = harness({ refuseLine: ['c1'], forbid: ['c2'] });
    const result = await service.post('cora', request([comment(), comment({ id: 'c2' })], []));
    expect(result.comments).toEqual([{ id: 'c1', result: 'file', reason: 'GitHub refused the line range: Line could not be resolved' }, { id: 'c2', result: 'failed', reason: 'No access' }]);
    expect(mutations('addPullRequestReviewThread').map(entry => Object.keys(entry.variables!).length)).toEqual([2, 1]);
    expect(state.review!.comments).toEqual([{ path: 'src/feature.ts', subjectType: 'FILE', body: marked('**Lines 11–12 (new)**\n\n```diff\n+new11\n+new12\n```\n\nRename these.', 'c1') }]);
  });

  it('places a range whose ends run backwards through the hunk', async () => {
    const { service, mutations } = harness();
    const result = await service.post('cora', request([comment({ id: 'rev', changeId: 'chg_swapped01', startSide: 'deletions', startLine: 6, endSide: 'additions', endLine: 6 })], []));
    expect(result.comments).toEqual([{ id: 'rev', result: 'line' }]);
    expect(mutations('addPullRequestReviewThread')[0]?.variables).toEqual({ i0: { pullRequestReviewId: 'PRR_new', path: 'src/swap.ts', body: marked('Rename these.', 'rev'), line: 6, side: 'LEFT', startLine: 6, startSide: 'RIGHT', subjectType: 'LINE' } });
  });

  it('posts notes alone, without comments', async () => {
    const { service, requests, commands, mutations } = harness();
    const step = { key: 'step:1', markdown: '## Step one\n\nLooks right.' };
    const result = await service.post('cora', request([], [general, step]));
    expect(result.sections).toEqual([{ key: 'general', posted: true }, { key: 'step:1', posted: true }]);
    expect(result.comments).toEqual([]);
    expect(mutations('addPullRequestReview')[0]?.variables).toMatchObject({ input: { body: `${sectionText(general)}\n\n${sectionText(step)}` } });
    expect(mutations()).toHaveLength(1);
    expect(commands.some(args => args.includes('status'))).toBe(false);
    expect(requests.some(entry => entry.url.includes('/files'))).toBe(false);
  });

  it('appends only the sections the draft lacks, a changed one under a new marker', async () => {
    const oldStep = { key: 'step:1', markdown: 'Old step notes' };
    const newStep = { key: 'step:1', markdown: 'New step notes' };
    const added = { key: 'step:2', markdown: 'Another step' };
    const existing = `Mine.\n\n${sectionText(general)}\n\n${sectionText(oldStep)}`;
    const { service, mutations, state } = harness({ pending: { commit: head, body: existing } });
    const result = await service.post('cora', request([comment()], [general, newStep, added]));
    expect(result.sections).toEqual([{ key: 'general', posted: true }, { key: 'step:1', posted: true }, { key: 'step:2', posted: true }]);
    expect(mutations('addPullRequestReview')).toHaveLength(0);
    expect(mutations('updatePullRequestReview')[0]?.variables).toEqual({ input: { pullRequestReviewId: 'PRR_old', body: `${existing}\n\n${sectionText(newStep)}\n\n${sectionText(added)}` } });
    // posting the same sections again leaves the body alone
    const again = await service.post('cora', request([comment()], [general, newStep, added]));
    expect(again.sections.every(section => section.posted)).toBe(true);
    expect(mutations('updatePullRequestReview')).toHaveLength(1);
    expect(state.review!.body.match(/rac-section:/gu)).toHaveLength(4);
  });

  it('reads back a body update whose response was lost', async () => {
    const { service, mutations } = harness({ pending: { commit: head, body: '' }, updateFailure: 'lost' });
    const result = await service.post('cora', request([comment()]));
    expect(result.sections).toEqual([{ key: 'general', posted: true }]);
    expect(result.comments).toEqual([{ id: 'c1', result: 'line' }]);
    expect(mutations('updatePullRequestReview')).toHaveLength(1);
  });

  it('skips comments a retry finds already posted, keeping their placement', async () => {
    const others = Array.from({ length: 4 }, (_, index) => ({ body: `A colleague's note ${index}`, subjectType: 'LINE', path: 'src/feature.ts' }));
    // the markers sit past the first page of the review's comments
    const { service, mutations, state } = harness({ pending: { commit: head, body: '', comments: [...others, { body: marked('Rename these.', 'c1'), subjectType: 'LINE', path: 'src/feature.ts' }, { body: marked('**Line 30 (new)**\n\nOff.', 'c2'), subjectType: 'FILE', path: 'src/feature.ts' }] } });
    const result = await service.post('cora', request([comment(), comment({ id: 'c2', startLine: 30, endLine: 30, body: 'Off.' }), comment({ id: 'c3' })], []));
    expect(result.comments).toEqual([{ id: 'c1', result: 'line' }, { id: 'c2', result: 'file', reason: 'The commented lines are not in the tour\'s diff.' }, { id: 'c3', result: 'line' }]);
    expect(mutations()).toHaveLength(1);
    expect(Object.keys(mutations('addPullRequestReviewThread')[0]!.variables!)).toEqual(['i0']);
    expect(state.review!.comments.map(entry => markerId(entry.body)).filter(Boolean)).toEqual(['c1', 'c2', 'c3']);
  });

  it('posts a concurrent double submit only once', async () => {
    const { service, mutations, state } = harness();
    const comments = [comment(), comment({ id: 'c2' }), comment({ id: 'c3' })];
    const [first, second] = await Promise.all([service.post('cora', request(comments)), service.post('cora', request(comments))]);
    expect(first.comments.map(entry => entry.result)).toEqual(['line', 'line', 'line']);
    expect(second).toEqual(first);
    expect(state.review!.comments).toHaveLength(3);
    expect(mutations('addPullRequestReview')).toHaveLength(1);
    expect(mutations('updatePullRequestReview')).toHaveLength(0);
    expect(mutations('addPullRequestReviewThread')).toHaveLength(1);
  });

  it('indexes results across batches of ten', async () => {
    const { service, mutations, state } = harness({ refuse: ['k12'] });
    const comments = Array.from({ length: 23 }, (_, index) => comment({ id: `k${index}` }));
    const result = await service.post('cora', request(comments));
    expect(result.comments.map(entry => entry.id)).toEqual(comments.map(entry => entry.id));
    expect(result.comments.filter(entry => entry.result === 'failed')).toEqual([{ id: 'k12', result: 'failed', reason: 'Validation failed' }]);
    // three batches, then k12's file-level fallback
    expect(mutations('addPullRequestReviewThread').map(entry => Object.keys(entry.variables!).length)).toEqual([10, 10, 3, 1]);
    expect(state.review!.comments).toHaveLength(22);
  });

  it('reconciles a lost batch response from the review without retrying the mutation', async () => {
    const { service, mutations, state } = harness({ threadFailure: 'lost' });
    const result = await service.post('cora', request([comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })]));
    expect(result.comments).toEqual([{ id: 'a', result: 'line' }, { id: 'b', result: 'failed', reason: 'GitHub could not add the comments (502): Bad Gateway' }, { id: 'c', result: 'line' }]);
    expect(mutations('addPullRequestReviewThread')).toHaveLength(1);
    // the client's retry of the failed one posts just that one
    const retried = await service.post('cora', request([comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })], []));
    expect(retried.comments.map(entry => entry.result)).toEqual(['line', 'line', 'line']);
    expect(state.review!.comments.map(entry => markerId(entry.body))).toEqual(['a', 'c', 'b']);
  });

  it('reconciles a broken batch and fails a refused one outright', async () => {
    const broken = harness({ threadFailure: 'broken' });
    expect((await broken.service.post('cora', request([comment()]))).comments).toEqual([{ id: 'c1', result: 'failed', reason: 'GitHub could not add the comments: Something went wrong while executing your query.' }]);
    expect(broken.requests.filter(entry => entry.query?.includes('node(id:'))).toHaveLength(1);
    const forbidden = harness({ threadFailure: 'forbidden' });
    expect((await forbidden.service.post('cora', request([comment()]))).comments).toEqual([{ id: 'c1', result: 'failed', reason: 'GitHub could not add the comments (403): Resource not accessible by integration' }]);
    expect(forbidden.requests.some(entry => entry.query?.includes('node(id:'))).toBe(false);
    expect(forbidden.mutations('addPullRequestReviewThread')).toHaveLength(1);
  });

  it('recovers a draft whose opening response was lost, and fails one that never opened', async () => {
    const lost = harness({ reviewFailure: 'lost' });
    const recovered = await lost.service.post('cora', request([comment()]));
    expect(recovered.sections).toEqual([{ key: 'general', posted: true }]);
    expect(recovered.comments).toEqual([{ id: 'c1', result: 'line' }]);
    expect(lost.mutations('addPullRequestReview')).toHaveLength(1);
    expect(lost.mutations('updatePullRequestReview')).toHaveLength(0);
    const unapplied = harness({ reviewFailure: 'unapplied' });
    const error = await refusal(unapplied.service.post('cora', request([comment()])));
    expect([error.code, error.retryable, error.httpStatus, error.message]).toEqual(['github_failed', true, 502, 'GitHub could not start a draft review (502): Bad Gateway']);
    expect(unapplied.mutations()).toHaveLength(1);
  });

  it('retries a query but maps refused credentials to a non-retryable error', async () => {
    const flaky = harness({ queryFailure: 502 });
    expect((await flaky.service.post('cora', request([comment()]))).comments).toEqual([{ id: 'c1', result: 'line' }]);
    expect(flaky.requests.filter(entry => entry.query?.includes('pullRequest(number:'))).toHaveLength(2);
    const refused = await refusal(harness({ queryFailure: 401 }).service.post('cora', request([comment()])));
    expect([refused.code, refused.retryable, refused.message, refused.details]).toEqual(['github_forbidden', false, 'GitHub could not load the pull request (401): Bad credentials', { githubStatus: 401 }]);
    const scoped = await refusal(harness({ queryFailure: 'graphql-forbidden' }).service.post('cora', request([comment()])));
    expect([scoped.code, scoped.retryable, scoped.message]).toEqual(['github_forbidden', false, 'GitHub could not load the pull request: Resource not accessible by integration']);
  });

  it('refuses a pull request that is missing, closed, or from another branch or owner', async () => {
    const cases: Array<[Record<string, unknown> | null, string]> = [
      [null, 'Pull request #7 was not found on GitHub.'],
      [{ state: 'CLOSED' }, 'Pull request #7 is not open.'],
      [{ headRefName: 'feature/other' }, 'Pull request #7 is not from this worktree\'s branch feature/x.'],
      [{ headRepositoryOwner: { login: 'fork' } }, 'Pull request #7 is not from this worktree\'s branch feature/x.']
    ];
    for (const [pull, message] of cases) {
      const { service, mutations } = harness({ pull });
      const error = await refusal(service.post('cora', request([comment()])));
      expect([error.code, error.retryable, error.httpStatus, error.message, error.details]).toEqual(['pull_request_mismatch', false, 409, message, { pullRequestNumber: 7 }]);
      expect(mutations()).toHaveLength(0);
    }
  });

  it('refuses a draft review on an older commit', async () => {
    const { service, mutations } = harness({ pending: { commit: 'b'.repeat(40), body: '' } });
    const error = await refusal(service.post('cora', request([comment()])));
    expect(error.code).toBe('pending_review_outdated');
    expect(error.message).toMatch(/^You have a draft review \(GitHub shows it as Pending\) on an older commit/u);
    expect(error.details).toEqual({ pendingReviewCommit: 'b'.repeat(40), head });
    expect(mutations()).toHaveLength(0);
  });

  it('refuses a local head that is not the pull request head', async () => {
    const { service, mutations } = harness({ localHead: 'c'.repeat(40) });
    const error = await refusal(service.post('cora', request([comment()])));
    expect(error.code).toBe('head_mismatch');
    expect(error.httpStatus).toBe(409);
    expect(error.details).toEqual({ localHead: 'c'.repeat(40), pullRequestHead: head });
    expect(mutations()).toHaveLength(0);
  });

  it('refuses commented files that differ from HEAD before asking GitHub', async () => {
    const { service, requests } = harness({ dirty: 'src/feature.ts' });
    const error = await refusal(service.post('cora', request([comment()])));
    expect(error.code).toBe('uncommitted');
    expect(error.details).toEqual({ files: ['src/feature.ts'] });
    expect(requests).toHaveLength(0);
  });

  it('adds Since my review replies to the draft review on their threads', async () => {
    const { service, mutations, state, captured, github } = harness();
    const changed = vi.spyOn(github, 'changed');
    const result = await service.post('cora', replying([{ threadId: 'PRRT_1', body: ' Still open. ' }, { threadId: 'PRRT_2', body: 'Thanks, fixed.' }]));
    expect(captured).toEqual([{ scope: 'since-review', reviewedCommit, baseBranch: 'main', includeTests: true, includeDocs: false }]);
    expect(result.replies).toEqual([{ threadId: 'PRRT_1', result: 'posted' }, { threadId: 'PRRT_2', result: 'posted' }]);
    expect(result.comments).toEqual([]);
    // a draft opens on the head for them, with no body
    expect(mutations('addPullRequestReview')[0]?.variables).toEqual({ input: { pullRequestId: 'PR_1', commitOID: head } });
    const [replies] = mutations('addPullRequestReviewThreadReply');
    expect(replies?.query).toBe('mutation($i0:AddPullRequestReviewThreadReplyInput!,$i1:AddPullRequestReviewThreadReplyInput!){t0:addPullRequestReviewThreadReply(input:$i0){comment{id}} t1:addPullRequestReviewThreadReply(input:$i1){comment{id}}}');
    expect(replies?.variables).toEqual({
      i0: { pullRequestReviewId: 'PRR_new', pullRequestReviewThreadId: 'PRRT_1', body: `Still open.\n\n${replyMarker({ threadId: 'PRRT_1', body: 'Still open.' })}` },
      i1: { pullRequestReviewId: 'PRR_new', pullRequestReviewThreadId: 'PRRT_2', body: `Thanks, fixed.\n\n${replyMarker({ threadId: 'PRRT_2', body: 'Thanks, fixed.' })}` }
    });
    expect(state.review!.comments.map(entry => entry.body)).toEqual([expect.stringMatching(/^Still open\.\n\n<!-- rac-reply:PRRT_1:[0-9a-f]{16} -->$/u), expect.stringMatching(/^Thanks, fixed\.\n\n<!-- rac-reply:PRRT_2:[0-9a-f]{16} -->$/u)]);
    expect(mutations()).toHaveLength(2);
    expect(changed).toHaveBeenCalledWith({ owner: 'octo', name: 'repo' }, 7);
  });

  it('marks a reply by its thread and text', () => {
    expect(replyMarker({ threadId: 'PRRT_1', body: 'Fixed?' })).toMatch(/^<!-- rac-reply:PRRT_1:[0-9a-f]{16} -->$/u);
    expect(replyMarker({ threadId: 'PRRT_1', body: ' Fixed?\n' })).toBe(replyMarker({ threadId: 'PRRT_1', body: 'Fixed?' }));
    expect(replyMarker({ threadId: 'PRRT_1', body: 'Other' })).not.toBe(replyMarker({ threadId: 'PRRT_1', body: 'Fixed?' }));
    expect(replyMarker({ threadId: 'PRRT_2', body: 'Fixed?' })).not.toBe(replyMarker({ threadId: 'PRRT_1', body: 'Fixed?' }));
  });

  it('skips replies a retry finds in the draft and fails only a deleted thread\'s reply', async () => {
    const { service, mutations, state } = harness({ deletedThreads: ['PRRT_gone'] });
    const replies = [{ threadId: 'PRRT_1', body: 'One' }, { threadId: 'PRRT_gone', body: 'Two' }, { threadId: 'PRRT_3', body: 'Three' }];
    const first = await service.post('cora', replying(replies));
    expect(first.replies).toEqual([{ threadId: 'PRRT_1', result: 'posted' }, { threadId: 'PRRT_gone', result: 'failed', reason: 'Could not resolve to a node with the global id of \'PRRT_gone\'' }, { threadId: 'PRRT_3', result: 'posted' }]);
    const retried = await service.post('cora', replying(replies));
    expect(retried.replies).toEqual(first.replies);
    // the retry read the draft and sent only the failed reply
    expect(mutations('addPullRequestReviewThreadReply').map(entry => Object.values(entry.variables!).map(input => (input as { pullRequestReviewThreadId: string }).pullRequestReviewThreadId))).toEqual([['PRRT_1', 'PRRT_gone', 'PRRT_3'], ['PRRT_gone']]);
    expect(state.review!.comments).toHaveLength(2);
    // a changed text is a new reply
    const edited = await service.post('cora', replying([{ threadId: 'PRRT_1', body: 'One, edited' }]));
    expect(edited.replies).toEqual([{ threadId: 'PRRT_1', result: 'posted' }]);
    expect(state.review!.comments).toHaveLength(3);
  });

  it('reads back a reply batch whose response was lost', async () => {
    const { service, mutations, state } = harness({ replyFailure: 'lost' });
    const replies = [{ threadId: 'PRRT_a', body: 'A' }, { threadId: 'PRRT_b', body: 'B' }, { threadId: 'PRRT_c', body: 'C' }];
    const result = await service.post('cora', replying(replies));
    expect(result.replies).toEqual([{ threadId: 'PRRT_a', result: 'posted' }, { threadId: 'PRRT_b', result: 'failed', reason: 'GitHub could not add the replies (502): Bad Gateway' }, { threadId: 'PRRT_c', result: 'posted' }]);
    expect(mutations('addPullRequestReviewThreadReply')).toHaveLength(1);
    expect((await service.post('cora', replying(replies))).replies.map(entry => entry.result)).toEqual(['posted', 'posted', 'posted']);
    expect(state.review!.comments).toHaveLength(3);
  });

  it('posts replies beside comments and notes into one draft on the head', async () => {
    const { service, mutations, state } = harness({ pending: { commit: head, body: '' } });
    const result = await service.post('cora', { ...replying([{ threadId: 'PRRT_1', body: 'Reply' }]), comments: [comment()], sections: [general] });
    expect(result.comments).toEqual([{ id: 'c1', result: 'line' }]);
    expect(result.replies).toEqual([{ threadId: 'PRRT_1', result: 'posted' }]);
    expect(result.sections).toEqual([{ key: 'general', posted: true }]);
    expect(mutations('addPullRequestReview')).toHaveLength(0);
    expect(state.review!.comments).toHaveLength(2);
  });

  it('sends replies only for the threads of the stored tour\'s snapshot, to its own pull request', async () => {
    const { service, mutations } = harness();
    const reply = replying([{ threadId: 'PRRT_1', body: 'Reply' }]);
    // the tour is no longer stored, or is another tour
    expect((await refusal(service.post('cora', reply, null))).code).toBe('stale');
    expect((await refusal(service.post('cora', reply, snapshot(['PRRT_2'])))).code).toBe('stale');
    expect((await refusal(service.post('cora', reply, snapshot(['PRRT_1'], 8)))).code).toBe('pull_request_mismatch');
    expect(mutations()).toHaveLength(0);
    // a post with no replies needs no snapshot
    expect((await service.post('cora', request([comment()]), null)).comments).toEqual([{ id: 'c1', result: 'line' }]);
  });

  it('takes a reply as already in the draft only by a marker ending a reply on its own thread', async () => {
    const marker = replyMarker({ threadId: 'PRRT_1', body: 'Reply' });
    const { service, mutations } = harness({ pending: { commit: head, body: '', comments: [
      // a new thread, a reply on another thread, and a marker that does not end its reply
      { body: `Looks off.\n\n${marker}`, subjectType: 'LINE', path: 'src/feature.ts' },
      { body: `Elsewhere.\n\n${marker}`, subjectType: 'LINE', path: 'src/feature.ts', replyTo: opener('PRRT_2') },
      { body: `${marker} and more`, subjectType: 'LINE', path: 'src/feature.ts', replyTo: opener('PRRT_1') }
    ] } });
    expect((await service.post('cora', replying([{ threadId: 'PRRT_1', body: 'Reply' }]))).replies).toEqual([{ threadId: 'PRRT_1', result: 'posted' }]);
    expect(mutations('addPullRequestReviewThreadReply')).toHaveLength(1);
    // the reply it added is the one a retry finds
    expect((await service.post('cora', replying([{ threadId: 'PRRT_1', body: 'Reply' }]))).replies).toEqual([{ threadId: 'PRRT_1', result: 'posted' }]);
    expect(mutations('addPullRequestReviewThreadReply')).toHaveLength(1);
  });

  it('refuses replies into a draft review on an older commit', async () => {
    const { service, mutations } = harness({ pending: { commit: 'c'.repeat(40), body: '' } });
    expect((await refusal(service.post('cora', replying([{ threadId: 'PRRT_1', body: 'Reply' }])))).code).toBe('pending_review_outdated');
    expect(mutations()).toHaveLength(0);
  });

  it('refuses a stale tour and missing credentials', async () => {
    expect((await refusal(harness().service.post('cora', { ...request([comment()]), fingerprint: 'another-fingerprint-1' }))).code).toBe('stale');
    expect((await refusal(harness({ token: null }).service.post('cora', request([comment()])))).code).toBe('no_github_token');
  });
});

describe('pull request review API', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => { await app?.close(); });

  it('validates the request and maps results and refusals', async () => {
    const posted: string[] = [];
    let failure: unknown;
    const pullRequestReviews = {
      post: async (worktreeId: string) => {
        posted.push(worktreeId);
        if (failure !== undefined) throw failure;
        return { status: 'ok', review: { url: 'https://github.com/octo/repo/pull/7/files', pullRequest: { number: 7, url: 'https://github.com/octo/repo/pull/7' } }, sections: [{ key: 'general', posted: true }], comments: [{ id: 'c1', result: 'line' }] };
      }
    };
    app = await buildApp(testConfig(), { auth: await testAuthService(), pullRequestReviews: pullRequestReviews as never, discovery: { worktreesNow: () => [] } as never });
    const headers = { ...await authenticatedHeaders(app), 'content-type': 'application/json' };
    const url = '/api/worktrees/cora/review-tour/pr-review';
    const payload = JSON.stringify({ scope: 'pr', includeTests: false, includeDocs: false, fingerprint, pullRequestNumber: 7, sections: [general], comments: [comment()], replies: [] });
    const send = async () => await app!.inject({ method: 'POST', url, headers, payload });
    const working = await app.inject({ method: 'POST', url, headers, payload: JSON.stringify({ ...JSON.parse(payload), scope: 'working' }) });
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = headers;
    const noCsrf = await app.inject({ method: 'POST', url, headers: withoutCsrf, payload });
    const foreign = await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://evil.example.com' }, payload });
    const ok = await send();
    failure = new PullRequestReviewError('uncommitted', true, 'Commit first.', { files: ['src/feature.ts'] });
    const dirty = await send();
    failure = new ReviewTourError('target_unavailable', true);
    const missing = await send();
    failure = new Error('boom');
    const unexpected = await send();
    expect(working.statusCode).toBe(400);
    expect(working.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    expect(noCsrf.statusCode).toBe(403);
    expect(foreign.statusCode).toBe(403);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', sections: [{ key: 'general', posted: true }], comments: [{ id: 'c1', result: 'line' }] });
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toEqual({ status: 'error', error: { code: 'uncommitted', retryable: true, message: 'Commit first.', files: ['src/feature.ts'] } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ status: 'error', error: { code: 'target_unavailable', retryable: true } });
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toEqual({ status: 'error', error: { code: 'post_failed', retryable: true } });
    // the refused requests never reached the service
    expect(posted).toEqual(['cora', 'cora', 'cora', 'cora']);
  });

  it('hands a Since my review post the stored tour\'s snapshot, while it is that tour', async () => {
    const handed: unknown[] = [];
    const pullRequestReviews = { post: async (_worktreeId: string, _input: unknown, earlier: unknown) => { handed.push(earlier); return { status: 'ok', review: { url: 'https://github.com/octo/repo/pull/7/files', pullRequest: { number: 7, url: 'https://github.com/octo/repo/pull/7' } }, sections: [], comments: [], replies: [] }; } };
    const earlier = snapshot(['PRRT_1']);
    const reviewStore = { storedTour: async () => ({ worktreeId: 'cora', branch: 'feature/x', savedAt: '2026-11-04T00:00:00.000Z', tour: { scope: 'since-review', fingerprint, earlierThreads: earlier } }) };
    app = await buildApp(testConfig(), { auth: await testAuthService(), pullRequestReviews: pullRequestReviews as never, reviewStore: reviewStore as never, discovery: { worktreesNow: () => [] } as never });
    const headers = { ...await authenticatedHeaders(app), 'content-type': 'application/json' };
    const send = async (input: PullRequestReviewInput) => await app!.inject({ method: 'POST', url: '/api/worktrees/cora/review-tour/pr-review', headers, payload: JSON.stringify(input) });
    expect((await send(replying([{ threadId: 'PRRT_1', body: 'Reply' }]))).statusCode).toBe(200);
    expect((await send({ ...replying([{ threadId: 'PRRT_1', body: 'Reply' }]), fingerprint: 'another-fingerprint-1' })).statusCode).toBe(200);
    expect(handed).toEqual([earlier, undefined]);
  });
});
