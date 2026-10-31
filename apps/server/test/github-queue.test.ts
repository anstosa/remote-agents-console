import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Request } from '../src/github/github.js';
import type { GithubQueue, QueueRow } from '../src/github/service.js';
import { testProject, testWorktree } from './helpers/config.js';
import { graphqlGithub, polled, reply, settled, sha, type PullFixture, type World } from './helpers/github-graphql.js';

const octo = { owner: 'octo', name: 'repo' };
// the module's detail cache, newest read last, as a test reads it
const details = (service: object): string[] => [...(service as { details: Map<string, unknown> }).details.keys()];
// every row's new reasons, by `repository#number`
const fresh = (queue: GithubQueue): Record<string, string[]> => Object.fromEntries([...queue.mine ?? [], ...queue.reviews ?? []].filter(row => row.reasons.some(reason => reason.new)).map(row => [`${row.repository}#${row.number}`, row.reasons.filter(reason => reason.new).map(reason => reason.kind)]));
const row = (queue: GithubQueue, number: number): QueueRow => [...queue.mine ?? [], ...queue.reviews ?? [], ...queue.issues ?? []].find(found => found.number === number)!;

describe('the Conductor\'s GitHub queue', () => {
  it('answers `cached` from memory alone: nothing read, nothing kept, nothing seen, no poll held', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rac-queue-'));
    const seenFile = join(dir, 'seen.json');
    const { service, calls, searches, timers, clock } = polled({ 'octo/repo': { pulls: [
      { number: 1, branch: 'red', mine: true, checks: 'FAILURE' },
      { number: 2, branch: 'conflicted', mine: true, mergeable: 'CONFLICTING' }
    ] } }, { seenFile });

    expect(await service.queue('cached')).toEqual({ network: 'none', stale: true, polling: false });
    expect(await service.pullRequestSnapshot(octo, 1, 'cached')).toEqual({ network: 'none', stale: true, polling: false });
    expect([calls.length, searches.length, service.revision, details(service).length]).toEqual([0, 0, 0, 0]);

    // the operator has seen pull request 2's conflicts; details of 1 then 2 were read
    const shown = await service.overview();
    await service.markSeen(shown.mine.find(item => item.number === 2)!.unseen!);
    await service.pullRequestSnapshot(octo, 1, 'if_stale');
    await service.pullRequestSnapshot(octo, 2, 'if_stale');
    clock.now = 500_000;
    const before = { revision: service.revision, badge: service.badge, seen: await readFile(seenFile, 'utf8'), modified: (await stat(seenFile)).mtimeMs, details: details(service) };
    expect(before.details).toEqual(['pull:octo/repo#1', 'pull:octo/repo#2']);
    const read = calls.length + searches.length;

    const warm = await service.queue('cached');
    const old = await service.pullRequestSnapshot(octo, 1, 'cached');
    const missing = await service.pullRequestSnapshot(octo, 3, 'cached');
    expect(warm).toMatchObject({ network: 'none', stale: true, polling: false, fetchedAt: 0 });
    expect(old).toMatchObject({ network: 'none', stale: true, pullRequest: { number: 1 } });
    expect(missing).toEqual({ network: 'none', stale: true, polling: false });
    expect(row(warm, 1).reasons).toEqual([{ kind: 'checks', new: true }]);
    expect(row(warm, 2).reasons).toEqual([{ kind: 'conflicts', new: false }]);
    // nothing read, the detail cache in the same order with nothing added, the seen record and badge untouched, no poll started
    expect({ revision: service.revision, badge: service.badge, seen: await readFile(seenFile, 'utf8'), modified: (await stat(seenFile)).mtimeMs, details: details(service) }).toEqual(before);
    expect(calls.length + searches.length).toBe(read);
    expect(timers.delays()).toEqual([]);
  });

  it('refreshes without a browser: once when stale, not again while fresh, and `now` held to ten seconds', async () => {
    const { service, searches, clock } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'mine', mine: true }] } });

    expect(await service.queue('if_stale')).toMatchObject({ network: 'fetched', stale: false, polling: false, fetchedAt: 0, viewer: 'viewer', totals: { mine: 1, reviews: 0, issues: 0 } });
    expect(searches).toHaveLength(1);
    clock.now = 30_000;
    expect(await service.queue('if_stale')).toMatchObject({ network: 'not_needed', stale: false });
    expect((await service.queue('now')).network).toBe('fetched');
    clock.now = 35_000;
    expect((await service.queue('now')).network).toBe('throttled');
    expect(searches).toHaveLength(2);
    clock.now = 100_000;
    expect((await service.queue('if_stale')).network).toBe('fetched');
    expect(searches).toHaveLength(3);
  });

  it('shares a read already running with the browser\'s Refresh rather than sending its own', async () => {
    const world: World = { 'octo/repo': { pulls: [{ number: 1, branch: 'mine', mine: true }] } };
    const scripted = graphqlGithub(world);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const request: Request = async (url, init) => { await gate; return await scripted.request(url, init); };
    const { service } = polled(world, { request });

    const browser = service.overview({ fresh: true });
    await settled();
    const conductor = service.queue('if_stale');
    release();
    await browser;
    expect((await conductor).network).toBe('joined');
    expect(scripted.searches).toHaveLength(1);
  });

  it('says why a read failed, keeps what it had, and does not ask again for ten seconds', async () => {
    let token: string | undefined;
    let limited = false;
    let sent = 0;
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 1, branch: 'mine', mine: true }] } });
    const request: Request = async (url, init) => { sent += 1; return limited ? reply({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }) : await scripted.request(url, init); };
    const { service, clock } = polled({}, { request, token: async () => token });

    expect(await service.queue('if_stale')).toMatchObject({ network: 'failed', problem: { kind: 'no-token' } });
    expect((await service.queue('if_stale')).network).toBe('throttled');
    expect(sent).toBe(0);
    token = 'private-token';
    clock.now = 10_000;
    const read = await service.queue('if_stale');
    expect(read).toMatchObject({ network: 'fetched', fetchedAt: 10_000 });
    expect(read.problem).toBeUndefined();

    limited = true;
    clock.now = 80_000;
    const held = await service.queue('if_stale');
    expect(held).toMatchObject({ network: 'failed', fetchedAt: 10_000, problem: { kind: 'rate-limited', until: expect.any(Number) } });
    expect(held.mine).toHaveLength(1);
    // inside the failure floor nothing is tried; past it, the client's hold answers without sending anything
    const before = sent;
    clock.now = 85_000;
    expect((await service.queue('if_stale')).network).toBe('throttled');
    clock.now = 95_000;
    expect(await service.queue('if_stale')).toMatchObject({ network: 'failed', problem: { kind: 'rate-limited' } });
    expect(sent).toBe(before);
  });

  it('holds the reads it starts to an allowance, and `now` to the data going stale while GitHub\'s budget runs low', async () => {
    let low = false;
    const pulls = Array.from({ length: 12 }, (_, index) => ({ number: index + 1, branch: `b${index}`, mine: true }));
    const scripted = graphqlGithub({ 'octo/repo': { pulls } });
    // GitHub's budget headers, low when asked
    const request: Request = async (url, init) => {
      const answer = await scripted.request(url, init);
      return low ? { ...answer, headers: new Headers({ 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(10_000_000), 'x-ratelimit-resource': 'graphql' }) } : answer;
    };
    const { service, clock } = polled({}, { request });

    // ten reads at once, then one each 30 s; nothing read is held back from what is cached
    for (let number = 1; number <= 10; number += 1) expect((await service.pullRequestSnapshot(octo, number, 'if_stale')).network).toBe('fetched');
    expect(await service.pullRequestSnapshot(octo, 11, 'if_stale')).toMatchObject({ network: 'throttled', stale: true });
    expect((await service.queue('if_stale')).network).toBe('throttled');
    expect(scripted.calls).toHaveLength(10);
    // the browser's own reads are never held to it
    expect((await service.pullRequestDetail(octo, 11)).pullRequest?.number).toBe(11);
    clock.now = 30_000;
    expect((await service.queue('if_stale')).network).toBe('fetched');
    expect((await service.pullRequestSnapshot(octo, 12, 'if_stale')).network).toBe('throttled');

    low = true;
    clock.now = 60_000;
    expect((await service.pullRequestSnapshot(octo, 12, 'if_stale')).network).toBe('fetched');
    // while the budget runs low, `now` is `if_stale`, and data stays fresh twice as long
    clock.now = 100_000;
    expect(await service.pullRequestSnapshot(octo, 12, 'now')).toMatchObject({ network: 'not_needed', stale: false });
  });

  it('never records a reason as seen, keeps the operator\'s acknowledgements, and shows what is new', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rac-queue-'));
    const seenFile = join(dir, 'seen.json');
    const pulls = {
      thread: { number: 1, branch: 'thread', mine: true, threads: [{ id: 't1', isResolved: false, isOutdated: false, last: 'mira', lastId: 'c1' }] },
      checks: { number: 2, branch: 'checks', mine: true, sha: sha('a'), checks: 'FAILURE' },
      review: { number: 3, branch: 'review', requested: true, viewerRequest: 'request-1' }
    } satisfies Record<string, PullFixture>;
    const { service, clock } = polled(() => ({ 'octo/repo': { pulls: Object.values(pulls) } }), { seenFile });
    const refresh = async () => { clock.now += 10_000; return await service.queue('now'); };

    // the operator is shown everything once
    const shown = await service.overview();
    await service.markSeen([...shown.mine, ...shown.reviews].flatMap(item => item.unseen ?? []));
    const acknowledged = await readFile(seenFile, 'utf8');
    expect(service.badge).toBe(0);

    // the Conductor refreshes over and over while every reason still holds: nothing changes
    for (let turn = 0; turn < 3; turn += 1) expect(fresh(await refresh())).toEqual({});
    expect(await readFile(seenFile, 'utf8')).toBe(acknowledged);
    expect(service.badge).toBe(0);

    // a new comment from someone else: new for the operator, and stays new however often the Conductor reads
    const revision = service.revision;
    Object.assign(pulls.thread, { threads: [{ ...pulls.thread.threads[0]!, lastId: 'c2' }] });
    expect(fresh(await refresh())).toEqual({ 'octo/repo#1': ['thread'] });
    // the browser is told to read again (its own display may then acknowledge what it shows)
    expect(service.revision).toBeGreaterThan(revision);
    for (let turn = 0; turn < 3; turn += 1) expect(fresh(await refresh())).toEqual({ 'octo/repo#1': ['thread'] });
    expect(service.badge).toBe(1);
    const browser = await service.overview();
    expect(browser.mine.find(item => item.number === 1)?.unseen).toHaveLength(1);
    // the still-holding acknowledgements were never touched
    expect(browser.mine.find(item => item.number === 2)?.unseen).toBeUndefined();
    expect(browser.reviews.find(item => item.number === 3)?.unseen).toBeUndefined();

    // checks that pass drop their old acknowledgement (lifecycle cleanup), so failing again is new
    Object.assign(pulls.checks, { checks: 'SUCCESS' });
    await refresh();
    Object.assign(pulls.checks, { checks: 'FAILURE' });
    expect(fresh(await refresh())).toEqual({ 'octo/repo#1': ['thread'], 'octo/repo#2': ['checks'] });
    expect(service.badge).toBe(2);
  });

  it('keeps what the searches read beyond each row: head, mergeability, checks, direct requests, my review, and same-repository closes', async () => {
    const head = sha('b');
    const { service } = polled({ 'octo/repo': { pulls: [
      { number: 1, branch: 'mine', mine: true, sha: head, mergeable: 'UNKNOWN', checks: 'PENDING', closes: [12, { number: 4, repository: 'other/place' }] },
      { number: 2, branch: 'direct', requested: true, sha: head, checks: 'FAILURE', viewerRequest: 'request-2', viewerReview: { state: 'CHANGES_REQUESTED', commit: sha('a') } },
      { number: 3, branch: 'team', requested: true, team: true, sha: head, mergeable: 'CONFLICTING', viewerReview: { state: 'APPROVED', commit: head } }
    ] } });

    const queue = await service.queue('if_stale');
    expect(row(queue, 1).pull).toEqual({ headSha: head, mergeable: 'unknown', checks: 'pending', closesHere: [12] });
    // the browser's row keeps every closing number, as before
    expect(row(queue, 1).closes).toEqual([12, 4]);
    expect(row(queue, 2).pull).toEqual({ headSha: head, mergeable: 'mergeable', checks: 'failed', direct: true, myReview: { state: 'changes', atHead: false } });
    expect(row(queue, 3).pull).toEqual({ headSha: head, mergeable: 'conflicting', checks: 'passed', direct: false, myReview: { state: 'approved', atHead: true } });
    // and the browser's Overview carries none of it
    expect(JSON.stringify(await service.overview())).not.toContain('closesHere');
  });

  it('finds every Worktree holding an item, in every Project of its repository, and each Project\'s main worktree', async () => {
    const worktrees = [
      testWorktree({ id: 'octo-main', projectId: 'octo-repo', label: 'repo', path: '/src/octo/repo', branch: 'main', main: true }),
      testWorktree({ id: 'octo-feature', projectId: 'octo-repo', label: 'feature', path: '/w/feature', branch: 'feature', main: false }),
      testWorktree({ id: 'clone-feature', projectId: 'clone', label: 'clone', path: '/src/clone/repo', branch: 'feature', main: true }),
      testWorktree({ id: 'issue-wt', projectId: 'octo-repo', label: 'issue', path: '/w/issue', branch: 'issue-10', main: false, issue: 10 })
    ];
    const projects = [testProject({ id: 'octo-repo', label: 'repo', path: '/src/octo/repo' }), testProject({ id: 'clone', label: 'clone', path: '/src/clone/repo', implicit: true })];
    const { service } = polled({ 'octo/repo': {
      pulls: [{ number: 1, branch: 'feature', mine: true }, { number: 2, branch: 'nowhere', mine: true }],
      issues: [{ number: 10, title: 'Issue', assigned: true }]
    } }, {
      worktrees: () => worktrees, projects: () => projects,
      // both checkouts name octo/repo as their origin
      command: async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' })
    });

    const queue = await service.queue('if_stale');
    expect(row(queue, 1).local.holders.map(worktree => worktree.id)).toEqual(['octo-feature', 'clone-feature']);
    expect(row(queue, 1).local.mains.map(({ project, worktree }) => [project.id, worktree?.id])).toEqual([['octo-repo', 'octo-main'], ['clone', 'clone-feature']]);
    expect(row(queue, 2).local.holders).toEqual([]);
    expect(row(queue, 10).local.holders.map(worktree => worktree.id)).toEqual(['issue-wt']);
    // the browser's single destination is still the first of them
    expect((await service.overview()).mine.find(item => item.number === 1)?.destination).toEqual({ kind: 'worktree', worktreeId: 'octo-feature', label: 'feature' });
  });

  it('reads a pull request\'s detail for the Conductor as the panel does, saying what that took', async () => {
    const worktrees = [testWorktree({ id: 'octo-feature', projectId: 'octo-repo', label: 'feature', path: '/w/feature', branch: 'feature', main: false })];
    const { service, calls, clock } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true }] } }, { worktrees: () => worktrees });

    const first = await service.pullRequestSnapshot(octo, 1, 'if_stale');
    expect(first).toMatchObject({ network: 'fetched', stale: false, fetchedAt: 0, pullRequest: { number: 1, branch: 'feature' }, polling: false });
    expect(first.local?.holders.map(worktree => worktree.id)).toEqual(['octo-feature']);
    expect((await service.pullRequestSnapshot(octo, 1, 'if_stale')).network).toBe('not_needed');
    expect((await service.pullRequestSnapshot(octo, 1, 'now')).network).toBe('throttled');
    clock.now = 10_000;
    expect((await service.pullRequestSnapshot(octo, 1, 'now')).network).toBe('fetched');
    expect((await service.pullRequestSnapshot(octo, 1, 'cached'))).toMatchObject({ network: 'none', fetchedAt: 10_000 });
    expect(calls).toHaveLength(2);
    // a pull request GitHub does not have is a failed read, marked missing, kept from being asked again at once
    expect(await service.pullRequestSnapshot(octo, 99, 'if_stale')).toMatchObject({ network: 'failed', missing: true, problem: { kind: 'failing' } });
    expect(await service.pullRequestSnapshot(octo, 99, 'if_stale')).toMatchObject({ network: 'throttled', missing: true });
    expect(calls).toHaveLength(3);
    // the browser is told what it always was: a problem, nothing more
    expect(await service.pullRequestDetail(octo, 99)).toEqual({ problem: { kind: 'failing', message: expect.any(String) } });
  });

  it('joins a detail read already running, and finds a merged pull request in the Worktree that finished with it', async () => {
    const world: World = { 'octo/repo': { pulls: [{ number: 1, branch: 'feature', mine: true }, { number: 2, branch: 'done', mine: true, state: 'MERGED', sha: sha('d') }] } };
    const scripted = graphqlGithub(world);
    let release!: () => void;
    let gate: Promise<void> = new Promise<void>(resolve => { release = resolve; });
    const request: Request = async (url, init) => { await gate; return await scripted.request(url, init); };
    const worktrees = [testWorktree({ id: 'done-wt', projectId: 'octo-repo', label: 'done', path: '/w/done', branch: 'done', sha: sha('d'), main: false })];
    const { service } = polled(world, { request, worktrees: () => worktrees });

    const browser = service.pullRequestDetail(octo, 1);
    await settled();
    const conductor = service.pullRequestSnapshot(octo, 1, 'if_stale');
    release();
    await browser;
    expect((await conductor).network).toBe('joined');
    expect(scripted.calls).toHaveLength(1);

    gate = Promise.resolve();
    // the merged pull request's branch is known from its lookup, as the dashboard reads it
    await service.branch(octo, 'done', true, { wait: true });
    const merged = await service.pullRequestSnapshot(octo, 2, 'if_stale');
    expect(merged.local).toEqual({ holders: [worktrees[0]], mains: [] });
  });

  it('marks the lists a detail read got a full page of, which may be missing older entries', async () => {
    const threads = Array.from({ length: 100 }, (_, index) => ({ id: `t${index}`, isResolved: false, isOutdated: false, last: 'mira' }));
    const { service } = polled({ 'octo/repo': { pulls: [{ number: 1, branch: 'busy', mine: true, threads }, { number: 2, branch: 'quiet', mine: true }] } });
    expect((await service.pullRequestSnapshot(octo, 1, 'if_stale')).pullRequest?.pageFull).toEqual({ threads: true });
    expect((await service.pullRequestSnapshot(octo, 2, 'if_stale')).pullRequest?.pageFull).toBeUndefined();
  });
});
