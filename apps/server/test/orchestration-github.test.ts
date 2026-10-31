import { describe, expect, it } from 'vitest';
import type { PullRequestComment, PullRequestReviewThread } from '../src/domain/models.js';
import type { Request } from '../src/github/github.js';
import type { PullRequestDetail, PullRequestSnapshot } from '../src/github/service.js';
import type { GithubOverviewV1, GithubPullRequestV1 } from '../src/orchestration/contracts.js';
import { githubPullRequest, readCursor, type GithubScope } from '../src/orchestration/github.js';
import { OrchestrationService, type OrchestrationDependencies, type PlaceScope } from '../src/orchestration/service.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { graphqlGithub, polled, reply, sha, type World } from './helpers/github-graphql.js';

// three configured Projects (octo/repo, acme/web, and beta/app outside the Conductor's Places), an
// Implicit Project cloned from octo/repo, an Implicit Project of its own repository (side/tool),
// and a repository with no Project (secret/private)
const octo = testProject({ id: 'octo', label: 'Octo', path: '/src/octo/repo' });
const acme = testProject({ id: 'acme', label: 'Acme', path: '/src/acme/web' });
const beta = testProject({ id: 'beta', label: 'Beta', path: '/src/beta/app' });
const clone = testProject({ id: 'clone', label: 'Clone', path: '/scratch/octo-clone', implicit: true });
const side = testProject({ id: 'side', label: 'Side', path: '/src/side/tool', implicit: true });
const worktrees = [
  testWorktree({ id: 'octo-main', projectId: 'octo', label: 'octo', path: '/src/octo/repo', branch: 'main', main: true }),
  testWorktree({ id: 'octo-feature', projectId: 'octo', label: 'feature-wt', path: '/w/feature', branch: 'feature', main: false }),
  testWorktree({ id: 'clone-wt', projectId: 'clone', label: 'cloned', path: '/scratch/octo-clone', branch: 'clone-only', main: true }),
  testWorktree({ id: 'clone-feature', projectId: 'clone', label: 'cloned-feature', path: '/scratch/octo-clone-feature', branch: 'feature', main: false }),
  testWorktree({ id: 'acme-main', projectId: 'acme', label: 'acme', path: '/src/acme/web', branch: 'main', main: true }),
  testWorktree({ id: 'beta-main', projectId: 'beta', label: 'beta', path: '/src/beta/app', branch: 'main', main: true }),
  testWorktree({ id: 'side-main', projectId: 'side', label: 'side', path: '/src/side/tool', branch: 'main', main: true })
];
const origins: Record<string, string> = { '/src/octo/repo': 'octo/repo', '/scratch/octo-clone': 'octo/repo', '/src/acme/web': 'acme/web', '/src/beta/app': 'beta/app', '/src/side/tool': 'side/tool' };
const world: World = {
  'octo/repo': {
    pulls: [
      { number: 1, branch: 'feature', mine: true, threads: [
        { id: 't-live', path: 'src/a.ts', isResolved: false, isOutdated: false, last: 'mira' },
        // a reply on an outdated thread is not a reason
        { id: 't-old', path: 'src/b.ts', isResolved: false, isOutdated: true, last: 'mira' }
      ] },
      { number: 2, branch: 'clone-only', mine: true, checks: 'FAILURE', closes: [10, { number: 3, repository: 'secret/private' }] },
      { number: 4, branch: 'theirs', requested: true, author: 'sam', viewerRequest: 'request-4' },
      // reviewed by the operator, no longer asking, and the author has replied on their thread
      { number: 7, branch: 'reviewed', author: 'sam', viewerReview: { state: 'COMMENTED', commit: sha('a') }, threads: [{ id: 't7', isResolved: false, isOutdated: false, last: 'sam' }] }
    ],
    issues: [{ number: 10, title: 'Octo issue', assigned: true, linked: [{ number: 2, branch: 'clone-only' }] }]
  },
  'acme/web': { pulls: [{ number: 5, branch: 'nobody', mine: true, mergeable: 'CONFLICTING' }] },
  'beta/app': { pulls: [{ number: 11, branch: 'beta', mine: true, title: 'Beta work' }] },
  'side/tool': { pulls: [{ number: 6, branch: 'side', mine: true, checks: 'FAILURE', title: 'Side secret' }] },
  'secret/private': { pulls: [{ number: 3, branch: 'hidden', mine: true, title: 'Private plans' }, { number: 8, branch: 'x', requested: true, title: 'Private review' }], issues: [{ number: 9, title: 'Private issue', assigned: true }] }
};

// the console as the Conductor reaches it: its Places admit octo and acme (not beta), and any
// Worktree with a Workspace; `admits` replaces that rule
function conductor({ workspaces = [], admits, ...options }: { workspaces?: string[]; admits?: PlaceScope; world?: World; request?: Request; token?: () => Promise<string | undefined> } = {}) {
  const github = polled(options.world ?? world, {
    projects: () => [octo, acme, beta, clone, side],
    worktrees: () => worktrees,
    command: async (_binary, args) => ({ code: 0, stdout: `git@github.com:${origins[args[args.indexOf('-C') + 1]!]}.git\n` }),
    ...(options.request === undefined ? {} : { request: options.request }),
    ...(options.token === undefined ? {} : { token: options.token })
  });
  const dependencies = {
    config: testConfig({ projects: [octo, acme, beta] }),
    discovery: { target: async () => undefined, worktreesNow: () => worktrees },
    loadDashboard: async () => ({ agents: [] }),
    github: github.service,
    now: () => github.clock.now
  } as unknown as OrchestrationDependencies;
  const places: PlaceScope = admits ?? (place => ['octo', 'acme'].includes(place.projectId) || workspaces.includes(place.id));
  return { orchestration: new OrchestrationService(dependencies).scoped(places, 'conductor-1'), github };
}

const value = <T>(result: { ok: boolean; value?: T }): T => { expect(result.ok).toBe(true); return result.value!; };
const keys = (value: unknown): string[] => JSON.stringify(value).match(/"[A-Za-z]+":/gu) ?? [];

describe('the Conductor\'s GitHub reads', () => {
  it('lists only the configured Projects\' repositories it admits, and never counts or names the rest', async () => {
    const { orchestration, github } = conductor();
    const overview = value<GithubOverviewV1>(await orchestration.githubOverview({}));

    expect(overview.coverage.repositories).toEqual(['acme/web', 'octo/repo']);
    expect(overview.mine!.map(row => `${row.repository}#${row.number}`)).toEqual(['octo/repo#1', 'octo/repo#2', 'acme/web#5']);
    expect(overview.reviews!.map(row => row.number)).toEqual([4]);
    expect(overview.issues!.map(row => row.number)).toEqual([10]);
    expect(overview.coverage.lists.mine).toEqual({ returned: 3, inScope: 3, complete: true, pageLimit: 20, truncatedByRequest: false });
    const text = JSON.stringify(overview);
    for (const hidden of ['secret', 'Private', 'side/tool', 'Side secret', 'beta', 'Beta', 'cloned', 'clone-wt', 'scratch']) expect(text).not.toContain(hidden);
    expect(keys(overview).filter(key => /hidden|total/iu.test(key))).toEqual([]);
    // a linked Issue in another repository is left out too
    expect(overview.mine!.find(row => row.number === 2)?.closes).toEqual([10]);
    // the operator's searches alone: no follow-up search was added
    expect(github.searches.flatMap(call => Object.values(call.variables)).filter(search => typeof search === 'string').sort()).toEqual([
      'is:issue is:open assignee:@me archived:false sort:updated-desc',
      'is:pr is:open author:@me archived:false sort:updated-desc',
      'is:pr is:open review-requested:@me archived:false sort:updated-desc'
    ]);
  });

  it('gives every admitted Worktree holding an item, falls back to the Project\'s main worktree, and announces none it hides', async () => {
    const { orchestration } = conductor();
    const { mine, issues } = value<GithubOverviewV1>(await orchestration.githubOverview({}));
    expect(mine!.find(row => row.number === 1)?.destinations).toEqual([{ kind: 'worktree', worktreeId: 'octo-feature', projectId: 'octo', label: 'feature-wt', branch: 'feature' }]);
    // held only in the Implicit clone, which its Places do not admit: the Project, as for one held nowhere
    expect(mine!.find(row => row.number === 2)?.destinations).toEqual([{ kind: 'project', worktreeId: 'octo-main', projectId: 'octo', label: 'Octo' }]);
    expect(mine!.find(row => row.number === 5)?.destinations).toEqual([{ kind: 'project', worktreeId: 'acme-main', projectId: 'acme', label: 'Acme' }]);
    expect(issues!.find(row => row.number === 10)?.destinations).toEqual([{ kind: 'project', worktreeId: 'octo-main', projectId: 'octo', label: 'Octo' }]);

    // once the clone's Worktrees have Workspaces its Places admit them as destinations, every one of them,
    // but the repositories still come from configured Projects only
    const admitted = conductor({ workspaces: ['clone-wt', 'clone-feature', 'side-main', 'beta-main'] });
    const widened = value<GithubOverviewV1>(await admitted.orchestration.githubOverview({}));
    expect(widened.mine!.find(row => row.number === 1)?.destinations.map(found => found.worktreeId)).toEqual(['octo-feature', 'clone-feature']);
    expect(widened.mine!.find(row => row.number === 2)?.destinations).toEqual([{ kind: 'worktree', worktreeId: 'clone-wt', projectId: 'clone', label: 'cloned', branch: 'clone-only' }]);
    // beta is configured, and a Workspace of it admits its repository
    expect(widened.coverage.repositories).toEqual(['acme/web', 'beta/app', 'octo/repo']);
    expect(JSON.stringify(widened)).not.toContain('side/tool');
  });

  it('falls back to no destination when the Project\'s main worktree is not admitted', async () => {
    const { orchestration } = conductor({ admits: place => (place.projectId === 'octo' && place.id !== 'octo-main') || place.projectId === 'acme' });
    const { mine } = value<GithubOverviewV1>(await orchestration.githubOverview({}));
    expect(mine!.find(row => row.number === 2)?.destinations).toEqual([]);
    expect(mine!.find(row => row.number === 1)?.destinations.map(found => found.worktreeId)).toEqual(['octo-feature']);
  });

  it('passes the panel\'s reasons through with the operator\'s new flags, without marking any seen, and pins what they do not cover', async () => {
    const { orchestration, github } = conductor();
    const overview = value<GithubOverviewV1>(await orchestration.githubOverview({ waitingOnly: true }));
    expect(overview.mine!.find(row => row.number === 1)?.waitingOnMe).toEqual([{ kind: 'thread', threadId: 't-live', path: 'src/a.ts', lastAuthor: 'mira', new: true }]);
    expect(overview.mine!.find(row => row.number === 2)?.waitingOnMe).toEqual([{ kind: 'checks', new: true }]);
    expect(overview.mine!.map(row => row.number)).toEqual([1, 2, 5]);
    expect(overview.reviews).toMatchObject([{ number: 4, request: { direct: true, reRequested: false }, waitingOnMe: [{ kind: 'review', reRequested: false, new: true }] }]);
    // an Issue is never waiting on the operator
    expect(overview.issues).toEqual([]);
    // the badge counts the operator's whole Overview, every repository
    const badge = github.service.badge;
    expect(badge).toBe(6);
    // a reply on a pull request the operator already reviewed, with no new request, is not listed: by design
    expect(JSON.stringify(overview)).not.toContain('octo/repo/pull/7');
    expect(overview.coverage.notCovered[0]).toMatch(/already reviewed.*new or repeated review request.*intentional/u);
    // reading it again, cached or anew, marks nothing seen
    value(await orchestration.githubOverview({ refresh: 'cached' }));
    github.clock.now = 10_000;
    value(await orchestration.githubOverview({ refresh: 'now' }));
    expect(github.service.badge).toBe(badge);
  });

  it('says a never-read Overview is unknown, not empty, and reads nothing for `cached`', async () => {
    const { orchestration, github } = conductor();
    const cold = value<GithubOverviewV1>(await orchestration.githubOverview({ refresh: 'cached', lists: ['mine'] }));
    expect(cold.freshness).toEqual({ state: 'cold', fetchedAt: null, ageSeconds: null, network: 'none', problem: null, backgroundPoll: 'none' });
    expect(cold.mine).toBeNull();
    expect(cold.reviews).toBeUndefined();
    expect(cold.coverage).toMatchObject({ viewer: null, lists: { mine: { returned: 0, inScope: 0, complete: null, pageLimit: 20, truncatedByRequest: false } } });
    expect(github.searches.length + github.calls.length).toBe(0);
    github.clock.now = 75_000;
    const read = value<GithubOverviewV1>(await orchestration.githubOverview({}));
    expect(read.freshness).toMatchObject({ state: 'fresh', network: 'fetched', ageSeconds: 0 });
    expect(read.coverage.viewer).toBe('viewer');
    github.clock.now = 140_000;
    expect(value<GithubOverviewV1>(await orchestration.githubOverview({ refresh: 'cached' })).freshness).toMatchObject({ state: 'stale', fetchedAt: '1970-01-01T00:01:15.000Z', ageSeconds: 65 });
    // a browser showing the console keeps the poll going
    github.service.watch();
    expect(value<GithubOverviewV1>(await orchestration.githubOverview({ refresh: 'cached' })).freshness.backgroundPoll).toBe('browser');
  });

  it('says why GitHub could not be read in its own words, never GitHub\'s, and never the token', async () => {
    let limited = false;
    const scripted = graphqlGithub(world);
    const request: Request = async (url, init) => limited ? reply({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for octo/secret-tool' }] }) : await scripted.request(url, init);
    let token: string | undefined;
    const { orchestration, github } = conductor({ request, token: async () => token });

    const none = value<GithubOverviewV1>(await orchestration.githubOverview({}));
    expect(none.freshness).toEqual({ state: 'cold', fetchedAt: null, ageSeconds: null, network: 'no_token', problem: { kind: 'no_token', message: 'GitHub authentication is not configured on the console host.', retryAt: null }, backgroundPoll: 'none' });
    expect(none.mine).toBeNull();

    token = 'ghp_privatetoken123456';
    github.clock.now = 10_000;
    value(await orchestration.githubOverview({}));
    limited = true;
    github.clock.now = 80_000;
    const held = value<GithubOverviewV1>(await orchestration.githubOverview({}));
    expect(held.freshness).toMatchObject({ state: 'failed', fetchedAt: '1970-01-01T00:00:10.000Z', network: 'rate_limited', problem: { kind: 'rate_limited', message: "GitHub's rate limit is holding requests back.", retryAt: expect.stringMatching(/^1970-01-01T00:0\d:\d\d\.000Z$/u) } });
    expect(held.mine!.map(row => row.number)).toEqual([1, 2, 5]);
    for (const answer of [none, held]) {
      expect(JSON.stringify(answer)).not.toContain('ghp_');
      expect(JSON.stringify(answer)).not.toContain('secret-tool');
    }
  });

  it('says when GitHub\'s search was cut at its page, so rows in scope may be missing', async () => {
    const many: World = { ...world, 'secret/private': { pulls: Array.from({ length: 25 }, (_, index) => ({ number: 100 + index, branch: `b${index}`, mine: true })) } };
    const { orchestration } = conductor({ world: many });
    const overview = value<GithubOverviewV1>(await orchestration.githubOverview({ lists: ['mine'] }));
    expect(overview.coverage.lists.mine).toMatchObject({ complete: false, pageLimit: 20 });
  });

  it('bounds the lists as asked and says when it cut them', async () => {
    const { orchestration } = conductor();
    const overview = value<GithubOverviewV1>(await orchestration.githubOverview({ lists: ['mine'], limit: 1, repository: 'OCTO/repo' }));
    expect(overview.mine!.map(row => row.number)).toEqual([1]);
    expect(overview.coverage.lists).toEqual({ mine: { returned: 1, inScope: 3, complete: true, pageLimit: 20, truncatedByRequest: true } });
    expect(overview.reviews).toBeUndefined();
    // a repository outside the scope reads as one with nothing in it
    expect(value<GithubOverviewV1>(await orchestration.githubOverview({ repository: 'secret/private' })).mine).toEqual([]);
  });

  it('reads nothing from GitHub when no repository is in scope', async () => {
    const { orchestration, github } = conductor({ admits: () => false });
    const overview = value<GithubOverviewV1>(await orchestration.githubOverview({}));
    expect(overview).toMatchObject({ freshness: { state: 'cold', network: 'none' }, coverage: { repositories: [] }, mine: null });
    expect(github.searches).toHaveLength(0);
  });

  it('answers not_found alike for a pull request outside the scope (before asking GitHub) and one GitHub has not got', async () => {
    const { orchestration, github } = conductor({ workspaces: ['side-main'] });
    for (const repository of ['secret/private', 'Secret/Private', 'side/tool', 'beta/app']) {
      expect(await orchestration.githubPullRequest({ repository, number: 3 })).toEqual({ ok: false, version: 'v1', error: { code: 'not_found', message: 'Pull request not found.', retryable: false } });
    }
    expect(github.calls).toHaveLength(0);
    expect(await orchestration.githubPullRequest({ repository: 'octo/repo', number: 404 })).toEqual({ ok: false, version: 'v1', error: { code: 'not_found', message: 'Pull request not found.', retryable: false } });
    const found = value<GithubPullRequestV1>(await orchestration.githubPullRequest({ repository: 'octo/repo', number: 2 }));
    expect(found.repository).toBe('octo/repo');
    expect(found.pullRequest?.summary).toMatchObject({ branch: 'clone-only', checks: 'failed', destinations: [{ kind: 'project', worktreeId: 'octo-main' }] });
    expect(found.pullRequest?.discussion).toBeUndefined();
    expect(found.freshness).toMatchObject({ state: 'fresh', network: 'fetched' });
  });

  it('pages the discussion through one snapshot from the cache, and refuses another pull request\'s or an expired cursor', async () => {
    const threads = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, isResolved: false, isOutdated: false, last: 'mira' }));
    const { orchestration, github } = conductor({ world: { ...world, 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true, threads }, { number: 2, branch: 'x', mine: true, threads }] } } });
    const input = { repository: 'octo/repo', number: 1, sections: ['discussion' as const], maxEntries: 20 };
    const first = value<GithubPullRequestV1>(await orchestration.githubPullRequest(input));
    expect(first.pullRequest?.discussion).toMatchObject({ totalEntries: 30, nextCursor: expect.any(String) });
    const cursor = first.pullRequest!.discussion!.nextCursor!;
    // later pages answer from the cache, even once the data is stale
    github.clock.now = 120_000;
    const reads = github.calls.length;
    const second = value<GithubPullRequestV1>(await orchestration.githubPullRequest({ ...input, cursor }));
    expect(second.pullRequest?.discussion?.entries).toHaveLength(10);
    expect(second.pullRequest?.discussion?.nextCursor).toBeNull();
    expect(second.freshness).toMatchObject({ network: 'none', state: 'stale' });
    expect(github.calls).toHaveLength(reads);
    expect(await orchestration.githubPullRequest({ ...input, number: 2, cursor })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await orchestration.githubPullRequest({ ...input, cursor: 'garbage' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    // read again, the snapshot the cursor came from is gone
    value(await orchestration.githubPullRequest({ ...input, refresh: 'now' }));
    expect(await orchestration.githubPullRequest({ ...input, cursor })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
});

// a synthetic pull request with `threads` threads of `replies` comments each, and long bodies
function bigSnapshot(threads: number, replies: number, fetchedAt = 1_000, body = 'x'.repeat(5_000)): PullRequestSnapshot {
  const comment = (id: string, author: string): PullRequestComment => ({ id, author, bot: false, ...(author === 'viewer' ? { mine: true as const } : {}), body, createdAt: '2026-10-30T00:00:00Z', url: `https://github.com/octo/repo/pull/1#${id}` });
  const thread = (index: number): PullRequestReviewThread => ({ id: `T${index}`, path: 'src/a.ts', line: 3, resolved: index % 4 === 3, outdated: index % 5 === 4, diffHunk: '@@ '.repeat(3_000), comments: Array.from({ length: replies }, (_, reply) => comment(`T${index}-${reply}`, reply === replies - 1 ? 'mira' : 'viewer')) });
  const pull: PullRequestDetail = {
    id: 'PR_1', number: 1, url: 'https://github.com/octo/repo/pull/1', repository: 'octo/repo', title: 'Big', state: 'open', draft: false, mine: true, branch: 'feature', headSha: sha('a'), headOnOrigin: true,
    mergeable: 'mergeable', checks: 'passed', checkRuns: [], reviewers: [{ login: 'lee', state: 'approved' }], linkedIssues: [], description: comment('D', 'viewer'),
    threads: Array.from({ length: threads }, (_, index) => thread(index)), reviews: [{ ...comment('R1', 'lee'), state: 'APPROVED' }], comments: [comment('C1', 'sam')], pageFull: { threads: true, checks: true }
  };
  return { pullRequest: pull, local: { holders: [], mains: [] }, network: 'none', stale: false, polling: false, fetchedAt };
}
const scope: GithubScope = { repositories: new Map(), projects: new Set(), admitted: new Set() };
type View = NonNullable<GithubPullRequestV1['pullRequest']>;
const base = { repository: 'octo/repo', number: 1 };

describe('a pull request\'s bounded discussion', () => {
  it('leaves the discussion out unless asked, and keeps a page small however big the pull request', () => {
    const snapshot = bigSnapshot(100, 50);
    const plain = githubPullRequest(snapshot, scope, base, undefined) as View;
    expect(Object.keys(plain)).toEqual(['summary', 'checks', 'reviewers']);
    expect([plain.checks!.mayBeTruncated, plain.reviewers!.mayBeTruncated]).toEqual([true, false]);
    const view = githubPullRequest(snapshot, scope, { ...base, sections: ['discussion'] }, undefined) as View;
    expect(JSON.stringify(view).length).toBeLessThan(125_000);
    const { discussion } = view;
    // the description, then the threads still to act on (unresolved and current), as many as fit
    expect(discussion!.totalEntries).toBe(1 + 60 + 1 + 1);
    const [description, thread] = discussion!.entries;
    expect(description).toMatchObject({ type: 'description', mine: true, body: { truncated: true } });
    expect((description as { body: { text: string } }).body.text).toHaveLength(1_500);
    expect(thread).toMatchObject({ type: 'thread', id: 'T0', lastSpeakerIsMe: false, omittedComments: 45, olderCommentsMayBeMissing: true });
    expect((thread as { comments: { id: string }[] }).comments.map(found => found.id)).toEqual(['T0-0', 'T0-46', 'T0-47', 'T0-48', 'T0-49']);
    expect(thread).not.toHaveProperty('diffHunk');
    expect(discussion!.mayBeTruncated).toEqual({ threads: true, reviews: false, comments: false });
    // with every bound at its largest, a page still stops near its budget, one oversized entry at most
    const largest = githubPullRequest(bigSnapshot(100, 50, 1_000, 'y'.repeat(10_000)), scope, { ...base, sections: ['discussion'], threads: 'all', includeOutdated: true, includeDiffHunks: true, maxEntries: 100, maxThreadComments: 50, maxBodyChars: 8_000 }, undefined) as View;
    expect(JSON.stringify(largest).length).toBeLessThan(450_000);
  });

  it('redacts credential-shaped text in what other people wrote', () => {
    const view = githubPullRequest(bigSnapshot(1, 1, 1_000, 'try GITHUB_TOKEN=ghp_abcdefghijklmnop1234 please'), scope, { ...base, sections: ['discussion'] }, undefined) as View;
    const text = JSON.stringify(view.discussion);
    expect(text).not.toContain('ghp_abcdefghijklmnop1234');
    expect(text).toContain('[REDACTED TOKEN]');
  });

  it('pages through one snapshot with a cursor, and refuses a cursor from another snapshot, filter or pull request', () => {
    const input = { ...base, sections: ['discussion' as const], threads: 'all' as const, includeOutdated: true, maxEntries: 40, maxBodyChars: 100, includeDiffHunks: true };
    const snapshot = bigSnapshot(100, 3);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = githubPullRequest(snapshot, scope, input, cursor === undefined || cursor === null ? undefined : readCursor(cursor)) as View;
      seen.push(...page.discussion!.entries.map(entry => entry.id));
      cursor = page.discussion!.nextCursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(103);
    expect(new Set(seen).size).toBe(103);
    const first = githubPullRequest(snapshot, scope, input, undefined) as View;
    expect((first.discussion!.entries[1] as { diffHunk: { text: string; truncated: boolean } }).diffHunk).toMatchObject({ truncated: true });
    const next = readCursor(first.discussion!.nextCursor!)!;
    expect(githubPullRequest(bigSnapshot(100, 3, 2_000), scope, input, next)).toBe('expired');
    expect(githubPullRequest(snapshot, scope, { ...input, threads: 'unresolved' }, next)).toBe('invalid');
    expect(githubPullRequest(snapshot, scope, { ...input, number: 2 }, next)).toBe('invalid');
    expect(readCursor('not a cursor')).toBeUndefined();
  });
});
