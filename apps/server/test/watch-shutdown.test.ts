import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleEvents } from '../src/events.js';
import { Watches, type CommandWindows } from '../src/watches/service.js';

const publication = vi.hoisted(() => ({ hold: false, reached: undefined as (() => void) | undefined, wait: undefined as Promise<void> | undefined }));

// hold one real Watch-file write at its external publication boundary
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    // preserve the real filesystem while one selected publication is held
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [path] = args;
      // block only the next Watch snapshot selected by the test
      if (publication.hold && String(path).endsWith('watches.json.next')) {
        publication.hold = false;
        publication.reached?.();
        await publication.wait;
      }
      return await actual.writeFile(...args);
    }
  };
});

const directories: string[] = [];

// reset every held publication and isolated Watch store
afterEach(async () => {
  publication.hold = false;
  publication.reached = undefined;
  publication.wait = undefined;
  await Promise.all(directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })));
});

describe('Watch shutdown publication barrier', () => {
  // cancel each delayed re-arm seam without changing its durable holder or cursor
  it.each(['status', 'open', 'connect'] as const)('cancels a delayed %s continuation after close', async seam => {
    const directory = await mkdtemp(join(tmpdir(), `rac-watch-shutdown-${seam}-`));
    directories.push(directory);
    const file = join(directory, 'watches.json');
    const durableHolder = { agentId: 'watch-arm', socket: '/tmp/watch-old.sock', pane: '%old' };
    const openedHolder = { agentId: 'watch-arm', socket: '/tmp/watch-new.sock', pane: '%new' };
    const record = { id: 'watch-arm', owner: { kind: 'agent', agentId: 'agent-a' }, description: 'arm', createdAt: new Date(1_000).toISOString(), sequence: 0, outbox: [], kind: 'command', command: 'tail -F build.log', placeId: 'place-a', agentKind: 'pi', holder: durableHolder, read: 7 };
    await writeFile(file, JSON.stringify([record]));
    const before = await readFile(file, 'utf8');
    let reached!: () => void;
    const atSeam = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const holderCloses: string[] = [];
    let lateChannelCloses = 0;
    const commands: CommandWindows = {
      open: async () => {
        // hold only the selected open seam
        if (seam === 'open') { reached(); await released; }
        return openedHolder;
      },
      connect: async (_holder, from) => {
        // hold only the selected connect seam
        if (seam === 'connect') { reached(); await released; }
        return { from, channel: { send: () => {}, onLine: () => {}, onClose: () => {}, close: () => { lateChannelCloses += 1; } } };
      },
      status: async () => {
        // hold only the selected status seam
        if (seam === 'status') { reached(); await released; }
        return seam === 'connect' ? { dead: false } : undefined;
      },
      close: async holder => { holderCloses.push(holder.pane); }
    };
    const service = new Watches({
      file,
      events: new ConsoleEvents(),
      github: { pullRequest: async () => { throw new Error('unused'); }, reviewRequests: async () => [] },
      commands,
      submit: async () => undefined,
      sent: async () => [],
      sandboxOf: async () => ({ place: { id: 'place-a', kind: 'worktree', path: directory, home: directory }, kind: 'pi' }),
      logPath: async () => undefined
    });
    const starting = service.start();
    await atSeam;
    await service.close();
    release();
    await starting;
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(holderCloses).toEqual(seam === 'open' ? ['%new'] : []);
    expect(lateChannelCloses).toBe(seam === 'connect' ? 1 : 0);

    const restartConnects: number[] = [];
    const restarted = new Watches({
      file,
      events: new ConsoleEvents(),
      github: { pullRequest: async () => { throw new Error('unused'); }, reviewRequests: async () => [] },
      commands: {
        open: async () => { throw new Error('durable holder must be reused'); },
        connect: async (_holder, from) => { restartConnects.push(from); return { from, channel: { send: () => {}, onLine: () => {}, onClose: () => {}, close: () => {} } }; },
        status: async () => ({ dead: false }),
        close: async () => {}
      },
      submit: async () => undefined,
      sent: async () => [],
      sandboxOf: async () => undefined,
      logPath: async () => undefined
    });
    await restarted.start();
    expect(restartConnects).toEqual([7]);
    await restarted.close();
  });

  // close only after an already-started command event and cursor are durable
  it('drains a held command publication before reconnecting from its cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-watch-shutdown-'));
    directories.push(directory);
    const file = join(directory, 'watches.json');
    const connects: number[] = [];
    const submitted: string[] = [];
    let line: (text: string) => void = () => {};
    const commands: CommandWindows = {
      open: async (_place, watchId) => ({ agentId: watchId, socket: '/tmp/watch.sock', pane: '%1' }),
      connect: async (_holder, from) => {
        connects.push(from);
        return { from, channel: { send: () => {}, onLine: listener => { line = listener; }, onClose: () => {}, close: () => {} } };
      },
      status: async () => ({ dead: false }),
      close: async () => {}
    };
    // build one service against the same durable file and external command holder
    const create = () => new Watches({
      file,
      events: new ConsoleEvents(),
      github: { pullRequest: async () => { throw new Error('unused'); }, reviewRequests: async () => [] },
      commands,
      submit: async (_agentId, text) => { submitted.push(text); return `prompt-${submitted.length}`; },
      sent: async () => [],
      sandboxOf: async () => ({ place: { id: 'place-a', kind: 'worktree', path: directory, home: directory }, kind: 'pi' }),
      logPath: async () => undefined,
      batchMs: 0
    });
    const first = create();
    const watched = await first.watchCommand('agent-a', 'tail -F build.log', 'build log');
    expect('refused' in watched).toBe(false);
    let reached!: () => void;
    const atPublication = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    publication.wait = new Promise<void>(resolve => { release = resolve; });
    publication.reached = reached;
    publication.hold = true;
    line('built');
    await atPublication;

    let closed = false;
    const closing = Promise.resolve(first.close()).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(submitted).toHaveLength(1);
    const stored = JSON.parse(await readFile(file, 'utf8')) as Array<{ read: number; outbox: string[] }>;
    expect(stored).toMatchObject([{ read: 1, outbox: [] }]);

    const restarted = create();
    await restarted.start();
    expect(connects).toEqual([0, 1]);
    expect(submitted).toHaveLength(1);
    await restarted.close();
  });

  // defer a drop's undelivered outbox when command closure crosses shutdown
  it('does not start a new flush after shutdown drains', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-watch-shutdown-drop-'));
    directories.push(directory);
    const file = join(directory, 'watches.json');
    let line: (text: string) => void = () => {};
    let closeReached!: () => void;
    const atCommandClose = new Promise<void>(resolve => { closeReached = resolve; });
    let releaseClose!: () => void;
    const commandClosed = new Promise<void>(resolve => { releaseClose = resolve; });
    let attempts = 0;
    let firstAttempt!: () => void;
    const attempted = new Promise<void>(resolve => { firstAttempt = resolve; });
    const commands: CommandWindows = {
      open: async (_place, watchId) => ({ agentId: watchId, socket: '/tmp/watch.sock', pane: '%1' }),
      connect: async (_holder, from) => ({ from, channel: { send: () => {}, onLine: listener => { line = listener; }, onClose: () => {}, close: () => {} } }),
      status: async () => ({ dead: false }),
      close: async () => { closeReached(); await commandClosed; }
    };
    const service = new Watches({
      file,
      events: new ConsoleEvents(),
      github: { pullRequest: async () => { throw new Error('unused'); }, reviewRequests: async () => [] },
      commands,
      submit: async () => { attempts += 1; firstAttempt(); return undefined; },
      sent: async () => [],
      sandboxOf: async () => ({ place: { id: 'place-a', kind: 'worktree', path: directory, home: directory }, kind: 'pi' }),
      logPath: async () => undefined,
      batchMs: 0
    });
    const watched = await service.watchCommand('agent-a', 'tail -F build.log', 'build log');
    expect('refused' in watched).toBe(false);
    const watchId = (watched as { watch_id: string }).watch_id;
    line('undelivered');
    await attempted;
    const removing = service.remove('agent-a', watchId);
    await atCommandClose;
    await service.close();
    releaseClose();
    await removing;
    expect(attempts).toBe(1);
    const retained = JSON.parse(await readFile(file, 'utf8')) as Array<{ ended?: true; outbox: string[] }>;
    expect(retained).toMatchObject([{ ended: true, outbox: [expect.stringContaining('undelivered')] }]);

    const delivered: string[] = [];
    const restarted = new Watches({
      file,
      events: new ConsoleEvents(),
      github: { pullRequest: async () => { throw new Error('unused'); }, reviewRequests: async () => [] },
      commands: { ...commands, close: async () => {} },
      submit: async (_agentId, text) => { delivered.push(text); return 'prompt-recovered'; },
      sent: async () => [],
      sandboxOf: async () => undefined,
      logPath: async () => undefined
    });
    await restarted.start();
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
    await restarted.close();
  });
});
