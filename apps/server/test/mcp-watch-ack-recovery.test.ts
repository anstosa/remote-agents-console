import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleEvents } from '../src/events.js';
import { Watches, type Watch } from '../src/watches/service.js';

const directories: string[] = [];
const tokenSecret = 'watch-final-ack-recovery-secret';

// reproduce the prior signed prefix format for migration safety
function legacyPageToken(watchId: string, events: string[], expiresAt: number): string {
  const digest = createHmac('sha256', tokenSecret).update(JSON.stringify(events)).digest('base64url');
  const payload = { version: 1, owner: 'davo:owner-a', watchId, first: 1, last: events.length, count: events.length, digest, expiresAt };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', tokenSecret).update(body).digest('base64url')}`;
}

// build one isolated Watch service around the shared durable file
function watchesAt(file: string, now: () => number, pullRequest?: () => Promise<{ state: 'OPEN' | 'MERGED'; url: string; head: string; checks?: 'pending' | 'failed'; conflict: boolean; threads: [] }>, davoOwnerForgotten?: () => void): Watches {
  return new Watches({
    file,
    events: new ConsoleEvents(),
    github: {
      // use the supplied mutable pull snapshot when a test observes lifecycle changes
      pullRequest: pullRequest ?? (async () => ({ state: 'OPEN', url: 'https://github.com/octo/repo/pull/1', head: 'a'.repeat(40), checks: 'pending', conflict: false, threads: [] })),
      // no test needs review-request polling
      reviewRequests: async () => []
    },
    commands: { open: async () => undefined, connect: async () => undefined, status: async () => undefined, close: async () => {} },
    submit: async () => undefined,
    sent: async () => [],
    sandboxOf: async () => undefined,
    logPath: async () => undefined,
    now,
    tokenSecret,
    davoOwnerAdmit: async () => ({ ok: true }),
    davoOwnerPresent: async () => true,
    davoOwnerForgotten
  });
}

// remove each isolated durable file
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })));
});

describe('Davo Watch final acknowledgement recovery', () => {
  // refresh a saturated active page before deletion and recover it after pressure and restart
  it('requires signed final evidence before deleting a saturated Watch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-watch-ack-recovery-'));
    directories.push(directory);
    const file = join(directory, 'watches.json');
    let now = 1_000;
    let forgotten = 0;
    const waiting = Array.from({ length: 20 }, (_, index) => `event ${index + 1}`);
    const saturated: Watch = {
      id: 'watch-saturated',
      owner: { kind: 'davo-remote', principalOwnerKey: 'owner-a', originInstanceId: 'instance-a', originStableOwnerId: 'stable-a' },
      description: 'saturated pull request',
      createdAt: new Date(now).toISOString(),
      sequence: 20,
      outbox: waiting,
      kind: 'pull_request',
      repository: { owner: 'octo', name: 'repo' },
      number: 7,
      url: 'https://github.com/octo/repo/pull/7',
      seen: { conflict: false, threads: [] }
    };
    const pressure = Array.from({ length: 1_024 }, (_, index): Watch => ({
      id: `watch-pressure-${index}`,
      owner: { kind: 'davo-local', principalOwnerKey: 'owner-pressure' },
      description: `pressure ${index}`,
      createdAt: new Date(now).toISOString(),
      sequence: 1,
      outbox: [`pressure event ${index}`],
      ended: true,
      endReason: 'completed',
      kind: 'process',
      worktreeId: 'worktree-a',
      process: 'dev',
      seen: 'exited'
    }));
    await writeFile(file, JSON.stringify([saturated, ...pressure]));
    const pullRequest = async () => ({ state: 'OPEN' as const, url: saturated.url, head: 'a'.repeat(40), checks: 'failed' as const, conflict: false, threads: [] as [] });
    const service = watchesAt(file, () => now, pullRequest, () => { forgotten += 1; });
    const activePage = await service.davoEvents('owner-a', saturated.id);
    expect(activePage).toMatchObject({ ended: false, more: false });
    expect(activePage.events.map(event => event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    await service.check();
    const terminal = await service.davoEvents('owner-a', saturated.id);
    expect(terminal).toMatchObject({ ended: true, end_reason: 'event_backlog_limit' });
    expect(terminal.page_token).not.toBe(activePage.page_token);
    await expect(service.acknowledgeDavo('owner-a', saturated.id, activePage.page_token!)).rejects.toThrow('watch_page_unavailable');
    expect((await service.davoEvents('owner-a', saturated.id)).events).toHaveLength(20);
    const finalResult = await service.acknowledgeDavo('owner-a', saturated.id, terminal.page_token!);
    expect(finalResult).toEqual({ watch_id: saturated.id, acknowledged_through: 20, ended: true, removed: true });
    expect(forgotten).toBe(1);
    // exceed the bounded receipt cache with real terminal acknowledgements
    for (let index = 0; index < pressure.length; index += 1) {
      const page = await service.davoEvents('owner-pressure', `watch-pressure-${index}`);
      expect(page.page_token).toBeTypeOf('string');
      await service.acknowledgeDavo('owner-pressure', `watch-pressure-${index}`, page.page_token!);
    }
    expect(await service.acknowledgeDavo('owner-a', saturated.id, terminal.page_token!)).toEqual(finalResult);
    expect(forgotten).toBe(1);
    await service.close();

    const restarted = watchesAt(file, () => now, pullRequest, () => { forgotten += 1; });
    expect(await restarted.acknowledgeDavo('owner-a', saturated.id, terminal.page_token!)).toEqual(finalResult);
    expect(forgotten).toBe(1);
    await expect(restarted.acknowledgeDavo('owner-b', saturated.id, terminal.page_token!)).rejects.toThrow('watch_unavailable');
    now += 5 * 60_000 + 1;
    await expect(restarted.acknowledgeDavo('owner-a', saturated.id, terminal.page_token!)).rejects.toThrow('watch_unavailable');
    await restarted.close();
  }, 30_000);

  // never extend a cached acknowledgement beyond its signed token expiry
  it('rejects a cached acknowledgement after the signed expiry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-watch-ack-expiry-'));
    directories.push(directory);
    const file = join(directory, 'watches.json');
    let now = 1_000;
    const record: Watch = { id: 'watch-expiry', owner: { kind: 'davo-local', principalOwnerKey: 'owner-a' }, description: 'expiry', createdAt: new Date(now).toISOString(), sequence: 1, outbox: ['event'], ended: true, endReason: 'completed', kind: 'process', worktreeId: 'worktree-a', process: 'dev', seen: 'exited' };
    await writeFile(file, JSON.stringify([record]));
    const service = watchesAt(file, () => now);
    const page = await service.davoEvents('owner-a', record.id);
    now += 5 * 60_000 - 1;
    const acknowledged = await service.acknowledgeDavo('owner-a', record.id, page.page_token!);
    expect(acknowledged.removed).toBe(true);
    expect(await service.acknowledgeDavo('owner-a', record.id, page.page_token!)).toEqual(acknowledged);
    now += 2;
    await expect(service.acknowledgeDavo('owner-a', record.id, page.page_token!)).rejects.toThrow('watch_unavailable');
    await service.close();
  });

  // keep legacy tokens usable for prefixes but never for unrecoverable final deletion
  it('requires a terminal v2 token before deleting with a legacy token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-watch-ack-legacy-'));
    directories.push(directory);
    const file = join(directory, 'watches.json');
    const now = 1_000;
    const events = ['legacy event'];
    const record: Watch = { id: 'watch-legacy', owner: { kind: 'davo-local', principalOwnerKey: 'owner-a' }, description: 'legacy', createdAt: new Date(now).toISOString(), sequence: 1, outbox: events, ended: true, endReason: 'completed', kind: 'process', worktreeId: 'worktree-a', process: 'dev', seen: 'exited' };
    await writeFile(file, JSON.stringify([record]));
    const service = watchesAt(file, () => now);
    const legacy = legacyPageToken(record.id, events, now + 5 * 60_000);
    await expect(service.acknowledgeDavo('owner-a', record.id, legacy)).rejects.toThrow('watch_page_unavailable');
    expect((await service.davoEvents('owner-a', record.id)).events).toHaveLength(1);
    const terminal = await service.davoEvents('owner-a', record.id);
    expect((await service.acknowledgeDavo('owner-a', record.id, terminal.page_token!)).removed).toBe(true);
    await service.close();
  });

  // keep an active-issued prefix from deleting the terminal event added after issuance
  it('replays only terminal final tokens after later Watch events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-watch-ack-prefix-'));
    directories.push(directory);
    const file = join(directory, 'watches.json');
    let now = 1_000;
    let state: 'OPEN' | 'MERGED' = 'OPEN';
    let checks: 'pending' | 'failed' = 'pending';
    const pullRequest = async () => ({ state, url: 'https://github.com/octo/repo/pull/7', head: 'a'.repeat(40), checks, conflict: false, threads: [] as [] });
    const owner = { kind: 'davo-local' as const, principalOwnerKey: 'owner-a' };
    const first = watchesAt(file, () => now, pullRequest);
    const created = await first.watchPullRequestDavo(owner, { owner: 'octo', name: 'repo' }, 7);
    expect('refused' in created).toBe(false);
    const watchId = (created as { watch_id: string }).watch_id;
    checks = 'failed';
    now += 1_000;
    await first.check();
    const activePage = await first.davoEvents('owner-a', watchId);
    state = 'MERGED';
    now += 1_000;
    await first.check();
    expect(await first.acknowledgeDavo('owner-a', watchId, activePage.page_token!)).toEqual({ watch_id: watchId, acknowledged_through: 1, ended: true, removed: false });
    await first.close();

    const second = watchesAt(file, () => now, pullRequest);
    expect(await second.acknowledgeDavo('owner-a', watchId, activePage.page_token!)).toEqual({ watch_id: watchId, acknowledged_through: 1, ended: true, removed: false });
    const terminalPage = await second.davoEvents('owner-a', watchId);
    expect(terminalPage.events.map(event => event.sequence)).toEqual([2]);
    expect((await second.acknowledgeDavo('owner-a', watchId, terminalPage.page_token!)).removed).toBe(true);
    await second.close();

    const third = watchesAt(file, () => now, pullRequest);
    await expect(third.acknowledgeDavo('owner-a', watchId, activePage.page_token!)).rejects.toThrow('watch_unavailable');
    expect(await third.acknowledgeDavo('owner-a', watchId, terminalPage.page_token!)).toEqual({ watch_id: watchId, acknowledged_through: 2, ended: true, removed: true });
    await third.close();
  });
});
