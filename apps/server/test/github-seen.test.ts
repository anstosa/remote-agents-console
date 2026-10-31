import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Overview, OverviewItem } from '../src/github/service.js';
import { graphqlGithub, polled, reply, sha, type PullFixture, type World } from './helpers/github-graphql.js';

// every row's unseen reason instances, by `repository#number`
const unseen = (overview: Overview): Record<string, string[]> => Object.fromEntries([...overview.mine, ...overview.reviews, ...overview.issues].filter(item => item.unseen !== undefined).map(item => [`${item.repository}#${item.number}`, item.unseen!]));
const row = (overview: Overview, number: number): OverviewItem => [...overview.mine, ...overview.reviews].find(item => item.number === number)!;

describe('the seen record and the badge', () => {
  it('counts Pull requests, not reasons, with something unseen, and showing a row clears it', async () => {
    const { service } = polled({ 'octo/repo': {
      pulls: [
        { number: 1, branch: 'busy', mine: true, checks: 'FAILURE', threads: [{ id: 't1', isResolved: false, isOutdated: false, last: 'mira' }, { id: 't2', isResolved: false, isOutdated: false, last: 'lee' }] },
        { number: 2, branch: 'conflicted', mine: true, mergeable: 'CONFLICTING' },
        { number: 3, branch: 'theirs', requested: true, viewerRequest: 'request-3' },
        { number: 4, branch: 'quiet', mine: true }
      ],
      issues: [{ number: 10, title: 'Assigned', assigned: true }]
    } });

    expect(service.badge).toBe(0);
    let overview = await service.overview();
    expect(service.badge).toBe(3);
    expect(Object.keys(unseen(overview))).toEqual(['octo/repo#1', 'octo/repo#2', 'octo/repo#3']);
    expect(row(overview, 1).unseen).toHaveLength(3);

    const revision = service.revision;
    await service.markSeen(row(overview, 1).unseen!);
    expect(service.badge).toBe(2);
    expect(service.revision).toBeGreaterThan(revision);
    overview = await service.overview();
    expect(Object.keys(unseen(overview))).toEqual(['octo/repo#2', 'octo/repo#3']);
  });

  it('counts a reason as new again when it recurs, and not when it only holds on', async () => {
    const pulls = {
      thread: { number: 1, branch: 'thread', mine: true, threads: [{ id: 't1', isResolved: false, isOutdated: false, last: 'mira', lastId: 'c1' }] },
      checks: { number: 2, branch: 'checks', mine: true, sha: sha('a'), checks: 'FAILURE' },
      conflicts: { number: 3, branch: 'conflicts', mine: true, mergeable: 'CONFLICTING' },
      changes: { number: 4, branch: 'changes', mine: true, sha: sha('a'), reviews: [{ id: 'r1', author: 'lee', state: 'CHANGES_REQUESTED', commit: sha('a') }] },
      review: { number: 5, branch: 'review', requested: true, viewerRequest: 'request-1' }
    } satisfies Record<string, PullFixture>;
    const { service, clock } = polled(() => ({ 'octo/repo': { pulls: Object.values(pulls) } }));
    // read GitHub again and show what is unseen
    const read = async () => { clock.now += 10_000; return Object.keys(unseen(await service.overview({ fresh: true }))); };
    const showAll = async () => { await service.markSeen(Object.values(unseen(await service.overview())).flat()); };

    expect(await read()).toHaveLength(5);
    await showAll();
    expect(await read()).toEqual([]);
    expect(service.badge).toBe(0);

    // a new comment from someone else on the thread; I answer, they answer again
    Object.assign(pulls.thread, { threads: [{ ...pulls.thread.threads[0]!, lastId: 'c2' }] });
    expect(await read()).toEqual(['octo/repo#1']);
    await showAll();
    Object.assign(pulls.thread, { threads: [{ ...pulls.thread.threads[0]!, last: 'viewer', lastId: 'c3' }] });
    expect(await read()).toEqual([]);
    Object.assign(pulls.thread, { threads: [{ ...pulls.thread.threads[0]!, last: 'mira', lastId: 'c4' }] });
    expect(await read()).toEqual(['octo/repo#1']);
    await showAll();

    // checks run again on the same head and fail again: the same failure; on a new head: new
    Object.assign(pulls.checks, { checks: 'PENDING' });
    expect(await read()).toEqual([]);
    Object.assign(pulls.checks, { checks: 'FAILURE' });
    expect(await read()).toEqual([]);
    Object.assign(pulls.checks, { sha: sha('b') });
    expect(await read()).toEqual(['octo/repo#2']);
    await showAll();

    // GitHub working out mergeability is not conflicts clearing; clearing and returning is
    Object.assign(pulls.conflicts, { mergeable: 'UNKNOWN' });
    expect(await read()).toEqual([]);
    Object.assign(pulls.conflicts, { mergeable: 'CONFLICTING' });
    expect(await read()).toEqual([]);
    Object.assign(pulls.conflicts, { mergeable: 'MERGEABLE' });
    expect(await read()).toEqual([]);
    Object.assign(pulls.conflicts, { mergeable: 'CONFLICTING' });
    expect(await read()).toEqual(['octo/repo#3']);
    await showAll();

    // a new changes-requested review, and a new request for my review
    Object.assign(pulls.changes, { reviews: [{ id: 'r2', author: 'lee', state: 'CHANGES_REQUESTED', commit: sha('a') }] });
    Object.assign(pulls.review, { viewerRequest: 'request-2' });
    expect(await read()).toEqual(['octo/repo#4', 'octo/repo#5']);
    expect(service.badge).toBe(2);
  });

  it('records only reasons that hold now', async () => {
    const pull: PullFixture = { number: 3, branch: 'conflicts', mine: true };
    const { service, clock } = polled(() => ({ 'octo/repo': { pulls: [pull] } }));
    await service.overview();
    await service.markSeen(['octo/repo#3:conflicts', 'anything at all']);
    pull.mergeable = 'CONFLICTING';
    clock.now = 10_000;
    expect(unseen(await service.overview({ fresh: true }))).toEqual({ 'octo/repo#3': ['octo/repo#3:conflicts'] });
  });

  it('keeps the record across restarts in its file, and starts empty from a file it cannot read', async () => {
    const world: World = { 'octo/repo': { pulls: [{ number: 1, branch: 'conflicts', mine: true, mergeable: 'CONFLICTING' }, { number: 2, branch: 'theirs', requested: true, viewerRequest: 'request-2' }] } };
    const seenFile = join(await mkdtemp(join(tmpdir(), 'rac-seen-')), 'data', 'github-seen.json');
    const before = polled(world, { seenFile }).service;
    await before.markSeen(row(await before.overview(), 1).unseen!);

    const after = polled(world, { seenFile }).service;
    expect(after.badge).toBe(0);
    expect(Object.keys(unseen(await after.overview()))).toEqual(['octo/repo#2']);
    expect(after.badge).toBe(1);

    await writeFile(seenFile, '{ not json');
    const damaged = polled(world, { seenFile }).service;
    expect(Object.keys(unseen(await damaged.overview()))).toEqual(['octo/repo#1', 'octo/repo#2']);
    // and writes it whole again
    await damaged.markSeen(row(await damaged.overview(), 2).unseen!);
    expect(Object.keys(unseen(await polled(world, { seenFile }).service.overview()))).toEqual(['octo/repo#1']);
  });

  it('keeps what was seen while GitHub fails', async () => {
    let failing = false;
    const world: World = { 'octo/repo': { pulls: [{ number: 1, branch: 'conflicts', mine: true, mergeable: 'CONFLICTING' }] } };
    const scripted = graphqlGithub(world);
    const { service, clock } = polled(world, { request: async (url, init) => failing ? reply({ message: 'Server Error' }, 500) : await scripted.request(url, init) });
    await service.markSeen(row(await service.overview(), 1).unseen!);
    failing = true;
    clock.now = 10_000;
    expect(await service.overview({ fresh: true })).toMatchObject({ problem: { kind: 'failing' } });
    failing = false;
    clock.now = 20_000;
    expect(unseen(await service.overview({ fresh: true }))).toEqual({});
    expect(service.badge).toBe(0);
  });

  it('forgets a Pull request gone from a complete list, but not one only pushed off a list GitHub cut short', async () => {
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 1, branch: 'one', mine: true, mergeable: 'CONFLICTING' }, { number: 2, branch: 'two', mine: true, mergeable: 'CONFLICTING' }] } });
    // GitHub's answer without #2, and with how many it found in all
    let without: { found: number } | undefined;
    const { service, clock } = polled({}, { request: async (url, init) => {
      const response = await scripted.request(url, init);
      if (without === undefined) return response;
      const { data } = await response.json() as { data: Record<string, { issueCount: number; nodes: { number: number }[] }> };
      const mine = data.mine;
      return reply({ data: { ...data, ...(mine === undefined ? {} : { mine: { issueCount: without.found, nodes: mine.nodes.filter(node => node.number !== 2) } }) } });
    } });
    const read = async (found?: number) => { without = found === undefined ? undefined : { found }; clock.now += 10_000; return Object.keys(unseen(await service.overview({ fresh: true }))); };
    await service.markSeen(Object.values(unseen(await service.overview())).flat());

    expect(await read(25)).toEqual([]);
    expect(await read()).toEqual([]);
    expect(await read(1)).toEqual([]);
    expect(await read()).toEqual(['octo/repo#2']);
  });
});
