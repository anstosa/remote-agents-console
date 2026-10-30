import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pane } from '../src/domain/models.js';
import { DiscoveryService, workspaceRoot } from '../src/discovery/service.js';
import { GithubService } from '../src/github/service.js';
import { answer, reply, type GraphqlCall } from './helpers/github-graphql.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';

const git = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/tmux/command.js')>()),
  run: git.run
}));

// use a mutable clock without delaying discovery's filesystem reads
let now = 100_000;
// isolate each case's cache and command responses
beforeEach(() => {
  now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  git.run.mockReset().mockResolvedValue({ code: 0, stdout: '/repo\n' });
});
// restore the clock even after a failed assertion
afterEach(() => { vi.restoreAllMocks(); });

// make recognized agent panes without real tmux processes
function panes(): Partial<Pane>[] {
  return [{ paneId: '%1', sessionId: '$1', pid: 101, path: '/repo/src', title: '⠋ Working' }];
}

// exercise the public scan path with independent service-local caches
function discovery(entries = panes()): DiscoveryService {
  return new DiscoveryService(socketFinder(), paneLister(entries) as never, processInspector());
}

describe('discovery repository root cache', () => {
  // duplicate panes and fresh attention scans must share one root command
  it('coalesces panes sharing a cwd and reuses roots without caching attention', async () => {
    const entries = panes();
    entries.push({ ...entries[0], paneId: '%2', pid: 102 });
    const service = discovery(entries);
    const first = await service.refresh(false, true);
    entries[0]!.title = 'Ready';
    const second = await service.refresh(false, true);

    expect(first.map(agent => agent.home)).toEqual(['/repo', '/repo']);
    expect(first[0]?.attention).toBe('working');
    expect(second[0]?.attention).toBe('finished');
    expect(git.run).toHaveBeenCalledExactlyOnceWith('/usr/bin/git', ['-C', '/repo/src', 'rev-parse', '--show-toplevel']);
  });

  // an expired positive result must observe a replaced repository
  it('expires roots after thirty seconds without extending expiry on hits', async () => {
    const service = discovery();
    await service.refresh(false, true);
    git.run.mockResolvedValue({ code: 0, stdout: '/replacement\n' });
    now += 29_999;
    expect((await service.refresh(false, true))[0]?.home).toBe('/repo');
    now += 1;
    expect((await service.refresh(false, true))[0]?.home).toBe('/replacement');
    expect(git.run).toHaveBeenCalledTimes(2);
  });

  // cache non-repositories briefly while still discovering a later git init
  it('expires fallback roots and keys lookups by the current pane directory', async () => {
    git.run.mockResolvedValue({ code: 128, stdout: '' });
    const entries = panes();
    const service = discovery(entries);
    expect((await service.refresh(false, true))[0]?.home).toBe('/repo/src');
    await service.refresh(false, true);
    expect(git.run).toHaveBeenCalledTimes(1);
    entries[0]!.path = '/other/src';
    expect((await service.refresh(false, true))[0]?.home).toBe('/other/src');
    git.run.mockResolvedValue({ code: 0, stdout: '/other\n' });
    now += 30_000;
    expect((await service.refresh(false, true))[0]?.home).toBe('/other');
    expect(git.run).toHaveBeenCalledTimes(3);
  });

  // launch-sensitive forced scans retain their uncached identity check
  it('refreshes roots on a forced scan and keeps other services isolated', async () => {
    const service = discovery();
    await service.refresh(false, true);
    git.run.mockResolvedValue({ code: 0, stdout: '/new\n' });
    expect((await service.refresh(true))[0]?.home).toBe('/new');
    expect((await discovery().refresh(false, true))[0]?.home).toBe('/new');
    expect(git.run).toHaveBeenCalledTimes(3);
  });

  // checkout invalidation also drops the short-lived pane snapshot
  it('resolves a changed root on the first ordinary scan after checkout invalidation', async () => {
    const service = discovery();
    await service.refresh(false, true);
    git.run.mockResolvedValue({ code: 0, stdout: '/new\n' });
    service.invalidateWorktrees();
    expect((await service.refresh())[0]?.home).toBe('/new');
    expect(git.run).toHaveBeenCalledTimes(2);
  });

  // invalidation must not join or retain a root read from the old checkout
  it('does not reuse a pre-invalidation scan or let it refill the root cache', async () => {
    let started!: () => void;
    let release!: (result: { code: number; stdout: string }) => void;
    let freshStarted!: () => void;
    let releaseFresh!: (result: { code: number; stdout: string }) => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<{ code: number; stdout: string }>(resolve => { release = resolve; });
    const freshReading = new Promise<void>(resolve => { freshStarted = resolve; });
    const freshPending = new Promise<{ code: number; stdout: string }>(resolve => { releaseFresh = resolve; });
    git.run.mockImplementationOnce(() => { started(); return pending; });
    const service = discovery();
    const stale = service.refresh(false, true);
    await reading;
    service.invalidateWorktrees();
    git.run.mockImplementationOnce(() => { freshStarted(); return freshPending; });
    const fresh = service.refresh();
    release({ code: 0, stdout: '/old\n' });
    await freshReading;
    // a new scan's generation must not make the old snapshot look current
    const concurrent = service.refresh();
    releaseFresh({ code: 0, stdout: '/new\n' });

    expect((await stale)[0]?.home).toBe('/old');
    expect((await fresh)[0]?.home).toBe('/new');
    expect((await concurrent)[0]?.home).toBe('/new');
    expect((await service.refresh(false, true))[0]?.home).toBe('/new');
    expect(git.run).toHaveBeenCalledTimes(2);
  });

  // a rejected subprocess must not poison later fresh scans
  it('retries rejected root lookups', async () => {
    git.run.mockRejectedValueOnce(new Error('spawn failed'));
    const service = discovery();
    await expect(service.refresh(false, true)).rejects.toThrow('spawn failed');
    expect((await service.refresh(false, true))[0]?.home).toBe('/repo');
    expect(git.run).toHaveBeenCalledTimes(2);
  });

  // cached canonicalization must eventually observe a retargeted symlink
  it('refreshes canonical paths at expiry while standalone launch resolution stays fresh', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'rac-root-cache-')));
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    const link = join(directory, 'pane');
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link);
    git.run.mockResolvedValue({ code: 128, stdout: '' });
    const entries = panes();
    entries[0]!.path = link;
    const service = discovery(entries);
    try {
      expect((await service.refresh(false, true))[0]?.home).toBe(first);
      await unlink(link);
      await symlink(second, link);
      expect((await service.refresh(false, true))[0]?.home).toBe(first);
      expect(await workspaceRoot(link)).toBe(second);
      now += 30_000;
      expect((await service.refresh(false, true))[0]?.home).toBe(second);
      expect(git.run).toHaveBeenCalledTimes(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // checkout invalidation must expose the replacement repository through public PR reads
  it('reloads a changed GitHub origin after checkout invalidation', async () => {
    let owner = 'old';
    const command = vi.fn(async () => ({ code: 0, stdout: `git@github.com:${owner}/repo.git\n` }));
    const github = new GithubService({ command, token: async () => 'token', request: async (_url, init) => {
      const call = JSON.parse(String(init?.body)) as GraphqlCall;
      const repository = `${String(call.variables.o0)}/repo`;
      return reply(answer({ [repository]: { pulls: [{ number: 1, title: 'Cache', branch: 'feature/cache' }] } }, call));
    } });
    const service = new DiscoveryService(undefined, undefined, undefined, github);
    const url = async () => (await github.branch((await github.repositoryAt('/repo'))!, 'feature/cache', true, { wait: true })).pullRequest?.url;
    await expect(url()).resolves.toBe('https://github.com/old/repo/pull/1');
    owner = 'new';
    await expect(url()).resolves.toBe('https://github.com/old/repo/pull/1');
    service.invalidateWorktrees();
    await expect(url()).resolves.toBe('https://github.com/new/repo/pull/1');
    expect(command).toHaveBeenCalledTimes(2);
  });
});
