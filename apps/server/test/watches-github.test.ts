import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleEvents } from '../src/events.js';
import { GithubWatchReader, type WatchGithub } from '../src/watches/github.js';
import { Watches } from '../src/watches/service.js';
import { graphqlGithub, polled, reply, sha, type GraphqlCall, type PullFixture, type World } from './helpers/github-graphql.js';

const repo = { owner: 'octo', name: 'repo' };
const url = 'https://github.com/octo/repo/pull/7';
const isDetail = (call: GraphqlCall) => call.query.startsWith('query PullRequestDetail');
// a search for one repository's review requests, as a Watch reads them with no fresh poll data
const isTargeted = (call: GraphqlCall) => Object.values(call.variables).some(value => String(value).startsWith('repo:octo/repo '));
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

// the Watch service on a real GitHub module over the scripted world, octo/repo a Project; every
// event the owner is told lands in `told`, and GitHub fails every read during an `outage`
async function watching(world: World) {
  const dir = await mkdtemp(join(tmpdir(), 'rac-watches-github-'));
  dirs.push(dir);
  const outage = { on: false };
  const scripted = graphqlGithub(() => world);
  const github = { ...polled(() => world, { request: async (address, init) => outage.on ? reply({ message: 'Server Error' }, 502) : await scripted.request(address, init) }), calls: scripted.calls, searches: scripted.searches };
  const told: string[] = [];
  const watches = new Watches({
    file: join(dir, 'watches.json'), events: new ConsoleEvents(), github: new GithubWatchReader(github.service),
    commands: { open: async () => undefined, connect: async () => undefined, status: async () => undefined, close: async () => {} },
    submit: async (_owner, text) => { told.push(text); return `prompt-${told.length}`; }, sent: async () => told,
    sandboxOf: async () => undefined, logPath: async () => undefined, now: () => github.clock.now
  });
  // a minute on, the Watch's next check
  const later = async () => { github.clock.now += 60_000; await watches.check(); };
  return { ...github, watches, told, later, outage };
}

describe('the Watches\' minute', () => {
  it('checks again a minute after the last check ended, when what it read is a minute old', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = await mkdtemp(join(tmpdir(), 'rac-watches-github-'));
    dirs.push(dir);
    // GitHub answers the Watch being set at once, and each check after five seconds
    let reads = 0;
    const github: WatchGithub = {
      pullRequest: async () => { reads += 1; if (reads > 1) await new Promise(resolve => setTimeout(resolve, 5_000)); return { state: 'OPEN', url, head: sha('a'), threads: [] }; },
      reviewRequests: async () => []
    };
    const watches = new Watches({
      file: join(dir, 'watches.json'), events: new ConsoleEvents(), github,
      commands: { open: async () => undefined, connect: async () => undefined, status: async () => undefined, close: async () => {} },
      submit: async () => 'queued', sent: async () => [], sandboxOf: async () => undefined, logPath: async () => undefined
    });
    // the Watches file is read and written for real, so wait out the I/O rather than the clock
    const reading = async (count: number) => { while (reads < count) await new Promise(resolve => setImmediate(resolve)); };
    await watches.watchPullRequest('owner', repo, 7);
    const started = watches.start();
    await reading(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await started;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await reading(3);
    watches.close();
  });
});

describe('a pull request Watch reading GitHub through the module', () => {
  it('with every browser hidden reads just its pull request once a minute, and tells every change', async () => {
    const pull: PullFixture = { number: 7, branch: 'feature', mine: true, checks: 'PENDING', threads: [] };
    const { watches, told, later, calls, searches, timers, clock } = await watching({ 'octo/repo': { pulls: [pull] } });
    const set = await watches.watchPullRequest('owner', repo, 7);
    expect(set).toMatchObject({ state: { url, head: sha('a'), checks: 'pending', merge_conflict: false, unresolved_threads: 0 } });
    const id = (set as { watch_id: string }).watch_id;
    // under a minute later, the read it was set with answers
    clock.now += 30_000;
    await watches.check();
    expect(calls).toHaveLength(1);

    pull.checks = 'FAILURE';
    // a thread is told by who opened it, whoever spoke last
    pull.threads!.push({ id: 'T1', isResolved: false, isOutdated: false, author: 'alice', last: 'carol' }, { id: 'T0', isResolved: true, isOutdated: false, author: 'bob' });
    await later();
    await later();
    expect(told).toEqual([`[RAC event] Watch ${id} #1 "Pull request octo/repo#7": its checks failed on aaaaaaaaaaaa; a new unresolved review thread from alice. ${url}`]);
    // the checks run again on the same head and fail again
    pull.checks = 'PENDING';
    await later();
    pull.checks = 'FAILURE';
    await later();
    expect(told[1]).toBe(`[RAC event] Watch ${id} #2 "Pull request octo/repo#7": its checks failed on aaaaaaaaaaaa. ${url}`);
    // a conflict, and checks passing on a new head
    Object.assign(pull, { mergeable: 'CONFLICTING', sha: sha('b'), checks: 'SUCCESS' });
    await later();
    expect(told[2]).toBe(`[RAC event] Watch ${id} #3 "Pull request octo/repo#7": its checks all passed on bbbbbbbbbbbb; a merge conflict appeared. ${url}`);
    pull.state = 'MERGED';
    await later();
    expect(told[3]).toBe(`[RAC event] Watch ${id} #4 "Pull request octo/repo#7": it was merged, so this Watch ends. ${url}`);
    expect(await watches.list('owner')).toEqual([]);

    // each read was of the one pull request, and nothing started the poll
    expect(calls.every(isDetail)).toBe(true);
    expect(searches).toEqual([]);
    expect(timers.delays()).toEqual([]);
  });

  it('while a browser watches is served from the poll while it shows the pull request unchanged, and reads it again when it changes', async () => {
    const pull: PullFixture = { number: 7, branch: 'feature', mine: true, threads: [] };
    const { service, watches, told, later, calls, timers, clock } = await watching({ 'octo/repo': { pulls: [pull] } });
    const release = service.watch();
    await timers.fire();
    const id = ((await watches.watchPullRequest('owner', repo, 7)) as { watch_id: string }).watch_id;
    const details = () => calls.filter(isDetail).length;
    expect(details()).toBe(1);
    // a minute on, the poll still shows it as it was read: nothing more is read for the Watch
    const polledLater = async () => { clock.now += 60_000; await timers.fire(); await watches.check(); };
    await polledLater();
    await polledLater();
    expect(details()).toBe(1);
    expect(told).toEqual([]);

    pull.threads!.push({ id: 'T1', isResolved: false, isOutdated: false, author: 'alice' });
    await polledLater();
    expect(details()).toBe(2);
    expect(told).toEqual([`[RAC event] Watch ${id} #1 "Pull request octo/repo#7": a new unresolved review thread from alice. ${url}`]);
    pull.mergeable = 'CONFLICTING';
    await polledLater();
    expect(told[1]).toBe(`[RAC event] Watch ${id} #2 "Pull request octo/repo#7": a merge conflict appeared. ${url}`);
    pull.checks = 'FAILURE';
    await polledLater();
    expect(told[2]).toBe(`[RAC event] Watch ${id} #3 "Pull request octo/repo#7": its checks failed on aaaaaaaaaaaa. ${url}`);
    // merged, it leaves the open list; its own read a minute on tells it
    pull.state = 'MERGED';
    await polledLater();
    expect(told[3]).toBe(`[RAC event] Watch ${id} #4 "Pull request octo/repo#7": it was merged, so this Watch ends. ${url}`);

    // the Watch let the poll stop with the browser
    release();
    expect(timers.delays()).toEqual([]);
    await later();
    expect(timers.delays()).toEqual([]);
  });

  it('tells nothing about the checks of a head with none, or a mergeability GitHub has not worked out', async () => {
    const pull: PullFixture = { number: 7, branch: 'feature', checks: null, mergeable: 'UNKNOWN' };
    const { watches, told, later } = await watching({ 'acme/elsewhere': { pulls: [pull] } });
    // another's pull request, in a repository with no Project
    const set = await watches.watchPullRequest('owner', { owner: 'acme', name: 'elsewhere' }, 7);
    expect(set).toMatchObject({ state: { checks: 'none', merge_conflict: 'unknown' } });
    await later();
    pull.mergeable = 'MERGEABLE';
    await later();
    expect(told).toEqual([]);
    pull.mergeable = 'CONFLICTING';
    await later();
    expect(told).toEqual([expect.stringContaining('": a merge conflict appeared. https://github.com/acme/elsewhere/pull/7')]);
  });

  it('compares nothing while GitHub fails, and tells a change once it answers again', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pull: PullFixture = { number: 7, branch: 'feature', threads: [] };
    const { watches, told, later, outage } = await watching({ 'octo/repo': { pulls: [pull] } });
    const id = ((await watches.watchPullRequest('owner', repo, 7)) as { watch_id: string }).watch_id;
    pull.threads!.push({ id: 'T1', isResolved: false, isOutdated: false, author: 'alice' });
    outage.on = true;
    await later();
    expect(told).toEqual([]);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining(`${id} could not be checked`), expect.any(String));
    outage.on = false;
    await later();
    expect(told).toEqual([`[RAC event] Watch ${id} #1 "Pull request octo/repo#7": a new unresolved review thread from alice. ${url}`]);
  });
});

describe('a review requests Watch reading GitHub through the module', () => {
  // an open pull request in octo/repo asking for the viewer's review
  const requested = (number: number, events: PullFixture['requestEvents'], extra: Partial<PullFixture> = {}): PullFixture => ({ number, branch: `topic-${number}`, requested: true, requestEvents: events, ...extra });
  const link = (number: number) => `https://github.com/octo/repo/pull/${number}`;

  it('with every browser hidden reads just its repository once a minute: a request and a re-request are told, a team\'s or another user\'s are not', async () => {
    const pulls = [requested(3, [{ id: 'RR1' }])];
    const { watches, told, later, calls, searches, timers } = await watching({ 'octo/repo': { pulls }, 'acme/other': { pulls: [requested(4, [{ id: 'RR0' }])] } });
    const set = await watches.watchReviewRequests('owner', repo);
    expect(set).toMatchObject({ requested: [{ number: 3, url: link(3) }] });
    const id = (set as { watch_id: string }).watch_id;
    await later();
    expect(told).toEqual([]);

    pulls.push(requested(5, [{ id: 'RR2', viewer: false }, { id: 'RR3' }]));
    await later();
    expect(told).toEqual([`[RAC event] Watch ${id} #1 "Review requests in octo/repo": #5 requests your review: ${link(5)}`]);
    // reviewed (no longer requested), then requested again
    pulls[0]!.requested = false;
    await later();
    Object.assign(pulls[0]!, { requested: true, requestEvents: [{ id: 'RR1' }, { id: 'RR4' }] });
    await later();
    await later();
    expect(told.slice(1)).toEqual([`[RAC event] Watch ${id} #2 "Review requests in octo/repo": #3 re-requests your review: ${link(3)}`]);
    // a request GitHub's latest timeline items do not name is told once, and naming it later is no re-request
    pulls.push(requested(9, []));
    await later();
    pulls[2]!.requestEvents!.push({ id: 'RR9' });
    await later();
    // a teammate's review requested after the operator's is not a request of the operator's
    pulls[2]!.requestEvents!.push({ id: 'RR10', viewer: false });
    // asked only through a team
    pulls.push(requested(11, [], { team: true }));
    await later();
    expect(told.slice(2)).toEqual([`[RAC event] Watch ${id} #3 "Review requests in octo/repo": #9 requests your review: ${link(9)}`]);

    // each read was of the one repository's requests, and nothing started the poll
    expect(calls).toEqual([]);
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every(isTargeted)).toBe(true);
    expect(timers.delays()).toEqual([]);
  });

  it('while a browser watches is served from the poll\'s Review requests, and reads its repository itself when the poll\'s list was cut short or stopped', async () => {
    // the Overview's search also finds requests only through a team, which are not the operator's own
    const pulls = [requested(3, [{ id: 'RR1' }]), requested(6, [], { team: true })];
    const { service, watches, told, searches, timers, clock, later } = await watching({ 'octo/repo': { pulls } });
    const release = service.watch();
    await timers.fire();
    const set = await watches.watchReviewRequests('owner', repo);
    expect(set).toMatchObject({ requested: [{ number: 3 }] });
    const id = (set as { watch_id: string }).watch_id;
    const polledLater = async () => { clock.now += 60_000; await timers.fire(); await watches.check(); };

    pulls.push(requested(5, [{ id: 'RR2' }]));
    await polledLater();
    Object.assign(pulls[0]!, { requestEvents: [{ id: 'RR1' }, { id: 'RR4' }] });
    await polledLater();
    expect(told).toEqual([
      `[RAC event] Watch ${id} #1 "Review requests in octo/repo": #5 requests your review: ${link(5)}`,
      `[RAC event] Watch ${id} #2 "Review requests in octo/repo": #3 re-requests your review: ${link(3)}`
    ]);
    expect(searches.filter(isTargeted)).toEqual([]);

    // every browser hidden, the poll's last list grows old: the Watch reads its repository itself
    release();
    pulls.push(requested(7, [{ id: 'RR7' }]));
    await later();
    expect(searches.filter(isTargeted)).toHaveLength(1);
    expect(told[2]).toBe(`[RAC event] Watch ${id} #3 "Review requests in octo/repo": #7 requests your review: ${link(7)}`);

    // watched again, with more Review requests than the Overview's page: this repository's may be past it
    service.watch();
    pulls.push(...Array.from({ length: 30 }, (_, index) => requested(100 + index, [{ id: `RQ${index}` }])));
    await polledLater();
    expect(searches.filter(isTargeted)).toHaveLength(2);
    expect(told[3]).toMatch(/: #100 requests your review: .*; #129 requests your review: /u);
  });
});
