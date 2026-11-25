import { afterEach, describe, expect, it, vi } from 'vitest';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', async original => ({ ...await original<typeof import('../src/tmux/command.js')>(), run, socketIsCurrent: vi.fn().mockResolvedValue(true) }));
import { socketIsCurrent } from '../src/tmux/command.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { testConfig, testWorktree } from './helpers/config.js';
import { processInspector, socketFinder } from './helpers/discovery-stubs.js';

const socket = { path: '/tmp/tmux-test', fingerprint: 'one', device: 1, inode: 2 };
// include the empty session proof column and stack metadata in every row
const row = (dead = '0', status = '', cwd = '/worktree', keyBinding = '') => ['%1', '$1', 'main', '123', cwd, 'node', 'café ☕', '', '', '', '', '', '', '', '', 'process', '', '@1', '', 'project:/worktree', 'dev', '', dead, status, keyBinding, '', 'p42', '/worktree'].join('\t') + '\n';
// isolate clock and command mocks
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllEnvs(); run.mockReset(); vi.mocked(socketIsCurrent).mockReset().mockResolvedValue(true); });

describe('shared pane snapshots', () => {
  // successful listings are reused only by explicit dashboard snapshot readers
  it('uses persistent reads and keeps each list call fresh', async () => {
    const commands = { listPanes: vi.fn().mockResolvedValue(row()), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    const panes = await adapter.listPanes(socket);
    expect(panes).toMatchObject([{ title: 'café ☕', dead: false, cleanupActivity: 'p42', processWorktree: '/worktree' }]);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'available', panes });
    await adapter.listPanes(socket);
    expect(commands.listPanes).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    adapter.closeCommands();
    expect(commands.closeAll).toHaveBeenCalledOnce();
    expect(adapter.paneSnapshotsNow().size).toBe(0);
  });

  // fallback remains available on the same request after transport loss
  it('falls back to spawned reads and never caches a failed read as empty', async () => {
    vi.useFakeTimers();
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 0, stdout: row(), stderr: '' });
    expect(await adapter.listPanes(socket)).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'permission denied' });
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
    await vi.advanceTimersByTimeAsync(5_000);
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await adapter.listPanes(socket);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'available', panes: [] });
  });

  // tmux 3.8 cannot list panes on a running server without sessions
  it('recognizes a confirmed empty server as healthy', async () => {
    vi.useFakeTimers();
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target\n' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await expect(adapter.listPaneInventory(socket)).resolves.toEqual({ status: 'available', panes: [] });
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', socket.path, 'list-sessions', '-F', '#{session_id}'], undefined, 2_000);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'available', panes: [] });
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'healthy' });
  });

  // never infer an empty inventory from an unsuccessful or nonempty confirmation
  it.each([
    { code: 1, stdout: '', stderr: 'no server running' },
    { code: 0, stdout: '$1\n', stderr: '' },
    { code: 0, stdout: '', stderr: '', timedOut: true },
    { code: 0, stdout: '', stderr: '', stdoutTruncated: true },
    { code: 0, stdout: '', stderr: 'unexpected diagnostic' }
  ])('keeps an unconfirmed empty server unavailable (%j)', async confirmation => {
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target\n' });
    run.mockResolvedValueOnce(confirmation);

    await expect(adapter.listPaneInventory(socket)).resolves.toEqual({ status: 'unavailable' });
    await expect(adapter.listPaneInventory(socket)).resolves.toEqual({ status: 'unavailable' });
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'unavailable' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  // only the precise complete diagnostic permits an empty-server confirmation
  it.each([
    { code: 2, stdout: '', stderr: 'no current target' },
    { code: 1, stdout: row(), stderr: 'no current target' },
    { code: 1, stdout: '', stderr: 'no current target', timedOut: true },
    { code: 1, stdout: '', stderr: 'no current target', stdoutTruncated: true },
    { code: 1, stdout: '', stderr: 'no current target\nother error' }
  ])('does not confirm unrelated listing failures (%j)', async listing => {
    const adapter = new TmuxAdapter();
    run.mockResolvedValueOnce(listing);
    await expect(adapter.listPaneInventory(socket)).resolves.toEqual({ status: 'unavailable' });
    expect(run).toHaveBeenCalledOnce();
  });

  // subprocess rejection is also an unknown inventory
  it('keeps a rejected confirmation unavailable', async () => {
    const adapter = new TmuxAdapter();
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    run.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(adapter.listPaneInventory(socket)).resolves.toEqual({ status: 'unavailable' });
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'unavailable' });
  });

  // an empty confirmation must share the original listing deadline
  it.each([1_500, 2_000])('honors the fallback budget after %i ms', async elapsed => {
    vi.useFakeTimers();
    const adapter = new TmuxAdapter();
    // simulate completed listing after part or all of the budget
    run.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(elapsed);
      return { code: 1, stdout: '', stderr: 'no current target' };
    });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const listing = await adapter.listPaneInventory(socket);
    // an exhausted budget cannot spawn another process
    if (elapsed === 2_000) {
      expect(listing).toEqual({ status: 'unavailable' });
      expect(run).toHaveBeenCalledOnce();
    } else {
      expect(listing).toEqual({ status: 'available', panes: [] });
      expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', ['-S', socket.path, 'list-sessions', '-F', '#{session_id}'], undefined, 500);
    }
  });

  // standalone and persistent fallback paths must verify the confirmation's identity
  it.each([false, true])('rejects replacement before confirmation (persistent: %s)', async persistent => {
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(persistent ? commands : undefined);
    // production also validates before listing panes
    if (persistent) vi.mocked(socketIsCurrent).mockResolvedValueOnce(true);
    vi.mocked(socketIsCurrent).mockResolvedValueOnce(false);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await expect(adapter.listPaneInventory(socket)).resolves.toEqual({ status: 'unavailable' });
    expect(run).toHaveBeenCalledOnce();
  });

  // retiring a pending pane listing also prevents a late confirmation
  it('does not confirm after the shared fallback is retired', async () => {
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
    // hold the pane listing itself
    run.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = adapter.listPaneInventory(socket);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    adapter.retainSockets([]);
    finish({ code: 1, stdout: '', stderr: 'no current target' });
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
    expect(run).toHaveBeenCalledOnce();
    expect(adapter.socketHealthNow().size).toBe(0);
  });

  // a retired inventory must not establish a fresh fallback after a late transport failure
  it('does not confirm after retirement during the persistent read', async () => {
    let finish!: (value: undefined) => void;
    const commands = { listPanes: vi.fn(() => new Promise<undefined>(resolve => { finish = resolve; })), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const pending = adapter.listPaneInventory(socket);
    adapter.retainSockets([]);
    finish(undefined);
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
    expect(run).not.toHaveBeenCalled();
    expect(adapter.paneSnapshotsNow().size).toBe(0);
  });

  // invalidated confirmation results must not establish healthy emptiness
  it.each(['replacement', 'retirement', 'shutdown'] as const)('rejects a pending confirmation after %s', async invalidation => {
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    // hold the confirmation while its read is invalidated
    run.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = adapter.listPaneInventory(socket);
    // wait until the second subprocess has started
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    // invalidate identity, ownership or the adapter itself
    switch (invalidation) {
      case 'replacement': vi.mocked(socketIsCurrent).mockResolvedValue(false); break;
      case 'retirement': adapter.retainSockets([]); break;
      case 'shutdown': adapter.closeCommands(); break;
    }
    finish({ code: 0, stdout: '', stderr: '' });
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
    expect(adapter.socketHealthNow().get(socket.path)?.status).not.toBe('healthy');
    expect(adapter.paneSnapshotsNow().get(socket.path)?.status).not.toBe('available');
  });

  // standalone confirmations cannot lend a replacement's empty inventory to an old socket
  it('rechecks standalone identity after confirmation', async () => {
    const adapter = new TmuxAdapter();
    vi.mocked(socketIsCurrent).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await expect(adapter.listPaneInventory(socket)).resolves.toEqual({ status: 'unavailable' });
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'unavailable' });
  });

  // a fresher standalone read supersedes publication, not the socket lifetime
  it('accepts overlapping standalone confirmations for the same socket', async () => {
    const adapter = new TmuxAdapter();
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await expect(Promise.all([adapter.listPaneInventory(socket), adapter.listPaneInventory(socket)])).resolves.toEqual([
      { status: 'available', panes: [] }, { status: 'available', panes: [] }
    ]);
    expect(run).toHaveBeenCalledTimes(4);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'available', panes: [] });
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'healthy' });
  });

  // overlapping production readers share one listing and one confirmation
  it('coalesces empty-server confirmation across concurrent readers', async () => {
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    // keep the shared confirmation in flight
    run.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = adapter.listPaneInventory(socket);
    const second = adapter.listPaneInventory(socket);
    // check that neither caller spawns a duplicate confirmation
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    finish({ code: 0, stdout: '', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'available', panes: [] }, { status: 'available', panes: [] }
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'healthy' });
  });

  // discovery distinguishes authoritative absence from a temporarily unreachable server
  it('removes departed agents without reporting an outage on confirmed emptiness', async () => {
    run.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    const commands = { listPanes: vi.fn().mockResolvedValue(row('0', '', '/tmp')), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    const discovery = new DiscoveryService(socketFinder([socket]), adapter, processInspector());
    const id = `${socket.fingerprint}:%1`;
    expect((await discovery.dashboard(false, true)).agents).toMatchObject([{ id }]);

    commands.listPanes.mockResolvedValueOnce(undefined);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no current target' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const empty = await discovery.dashboard(false, true);
    expect(empty.agents).toEqual([]);
    expect(empty).not.toHaveProperty('tmuxOutage');
    expect(await discovery.snapshotTarget(id)).toBeUndefined();
  });

  // a partial reply stays unknown rather than hiding panes omitted by parsing
  it('publishes malformed listings as unavailable observations', async () => {
    const adapter = new TmuxAdapter();
    run.mockResolvedValue({ code: 0, stdout: `${row()}malformed\n`, stderr: '' });
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
  });

  // stale socket files should not keep spawning clients at the dashboard cadence
  it('backs off confirmed absent servers but retries after expiry or replacement', async () => {
    vi.useFakeTimers();
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-test' });
    expect(await adapter.listPanes(socket)).toEqual([]);
    // multiple dashboard ticks reuse only the failure backoff, not an empty stack snapshot
    await vi.advanceTimersByTimeAsync(500);
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    expect(commands.listPanes).toHaveBeenCalledOnce();
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
    await vi.advanceTimersByTimeAsync(4_500);
    await adapter.listPanes(socket);
    expect(run).toHaveBeenCalledTimes(2);
    const replacement = { ...socket, fingerprint: 'new', inode: 3 };
    run.mockResolvedValue({ code: 0, stdout: row(), stderr: '' });
    expect(await adapter.listPanes(replacement)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  // transport failures use the same bounded per-socket retry as absent servers
  it('backs off every failed fallback and resets health after a complete listing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T20:00:00.000Z'));
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValue({ code: 1, stdout: '', stderr: 'server overloaded', timedOut: true });

    await adapter.listPanes(socket);
    expect(adapter.socketHealthNow().get(socket.path)).toEqual({ fingerprint: 'one', status: 'unavailable', since: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    await adapter.listPanes(socket);
    await vi.advanceTimersByTimeAsync(5_000);
    await adapter.listPanes(socket);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    run.mockResolvedValueOnce({ code: 0, stdout: row(), stderr: '' });
    await adapter.listPanes(socket);
    expect(run).toHaveBeenLastCalledWith('/usr/bin/tmux', expect.any(Array), undefined, 2_000);
    expect(adapter.socketHealthNow().get(socket.path)).toEqual({ fingerprint: 'one', status: 'healthy', lastHealthyAt: Date.now() });
  });

  // concurrent dashboard fallbacks share one bounded process and one failure observation
  it('coalesces spawned fallback reads for one socket lifetime', async () => {
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
    run.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));

    const first = adapter.listPanes(socket);
    const second = adapter.listPanes(socket);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    finish({ code: 1, stdout: '', stderr: 'server overloaded' });

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'unavailable' });
  });

  // a full trailing row cannot prove that no earlier panes were lost
  it('rejects a truncated listing even when the remaining rows parse', async () => {
    const adapter = new TmuxAdapter();
    run.mockResolvedValueOnce({ code: 0, stdout: row(), stderr: '', stdoutTruncated: true });
    await expect(adapter.listPanes(socket)).resolves.toEqual([]);
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ status: 'unavailable' });
  });

  // a failed discovery read is the stack display's unknown observation until retry
  it('shares missing-server backoff with stack display without a duplicate listing', async () => {
    vi.useFakeTimers();
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    const stackSocket = { ...socket, path: '/host-tmux/default' };
    const worktree = testWorktree({ id: 'project:/worktree', path: '/worktree', commands: { processes: { dev: 'node dev.js' } } });
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    const stackCommand = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'unexpected duplicate listing' }));
    const service = new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never, stackCommand);
    run.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running on /host-tmux/default' });

    await adapter.listPanes(stackSocket);
    await expect(service.state(worktree, adapter.paneSnapshotsNow())).resolves.toEqual({});
    await vi.advanceTimersByTimeAsync(500);
    await adapter.listPanes(stackSocket);
    await expect(service.state(worktree, adapter.paneSnapshotsNow())).resolves.toEqual({});
    expect(run).toHaveBeenCalledOnce();
    expect(stackCommand.mock.calls.filter(([, args]) => args.includes('list-panes'))).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4_500);
    await adapter.listPanes(stackSocket);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // freshness still checks healthy sockets without racing a degraded retry
  it('enforces outage backoff for lifecycle reads without blocking healthy sockets', async () => {
    vi.useFakeTimers();
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-test' });
    await adapter.listPanes(socket);
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(commands.listPanes).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    const healthy = { ...socket, path: '/tmp/tmux-other', fingerprint: 'other' };
    commands.listPanes.mockResolvedValueOnce(row());
    expect(await adapter.listPanes(healthy)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    run.mockResolvedValueOnce({ code: 0, stdout: row(), stderr: '' });
    const [first, second] = await Promise.all([adapter.listPanes(socket), adapter.listPanes(socket)]);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(commands.listPanes).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // a key binding's Terminal reads back its tag, which reuse matches
  it('reads the key binding a pane was opened for', async () => {
    run.mockResolvedValue({ code: 0, stdout: row('0', '', '/worktree', 'prefix g'), stderr: '' });
    const adapter = new TmuxAdapter();
    await adapter.listPanes(socket);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toMatchObject({ status: 'available', panes: [{ keyBinding: 'prefix g', processWorktree: '/worktree' }] });
  });

  // remain-on-exit panes lose cwd but still carry their exit status
  it('retains dead process panes without a cwd including exit status zero', async () => {
    run.mockResolvedValue({ code: 0, stdout: row('1', '0', ''), stderr: '' });
    const adapter = new TmuxAdapter();
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toMatchObject({ status: 'available', panes: [{ path: '', dead: true, exitCode: 0, processWorktree: '/worktree' }] });
  });

  // an older overlapping read must not replace newer stack state
  it('publishes only the latest listing and expires unused snapshots', async () => {
    vi.useFakeTimers();
    const adapter = new TmuxAdapter();
    let resolve!: (value: { code: number; stdout: string }) => void;
    run.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const older = adapter.listPanes(socket);
    run.mockResolvedValueOnce({ code: 0, stdout: row('1', '3'), stderr: '' });
    await adapter.listPanes(socket);
    resolve({ code: 0, stdout: row() });
    await older;
    expect(adapter.paneSnapshotsNow().get(socket.path)).toMatchObject({ status: 'available', panes: [{ exitCode: 3 }] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.paneSnapshotsNow().size).toBe(0);
  });

  // shutdown wins over a pending control read without spawning fallback
  it('does not fall back after closing an in-flight read', async () => {
    let finish!: (value: undefined) => void;
    const commands = { listPanes: vi.fn(() => new Promise<undefined>(resolve => { finish = resolve; })), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    const pending = adapter.listPanes(socket);
    adapter.closeCommands();
    finish(undefined);
    expect(await pending).toEqual([]);
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(adapter.paneSnapshotsNow().size).toBe(0);
  });

  // shutdown also wins while fallback validates the socket identity
  it('does not spawn when shutdown races socket validation', async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(socketIsCurrent).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    const pending = adapter.listPanes(socket);
    await vi.waitFor(() => expect(socketIsCurrent).toHaveBeenCalled());
    adapter.closeCommands();
    finish(true);
    expect(await pending).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  // a fallback must not relabel panes from a replacement server
  it('rejects a stale socket before spawning fallback', async () => {
    vi.mocked(socketIsCurrent).mockResolvedValueOnce(false);
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  // a replacement that appears while the bounded client runs cannot inherit old identity
  it('rejects a socket replaced during fallback', async () => {
    vi.mocked(socketIsCurrent).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 0, stdout: row(), stderr: '' });

    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(adapter.socketHealthNow().get(socket.path)).toMatchObject({ fingerprint: socket.fingerprint, status: 'unavailable' });
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
  });

  // an identity-rejected read cannot tell discovery that previously live agents left
  it('enters and clears discovery outage after a previously healthy socket rejects fallback identity', async () => {
    vi.useFakeTimers();
    run.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    const commands = { listPanes: vi.fn().mockResolvedValue(row('0', '', '/tmp')), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    const discovery = new DiscoveryService(socketFinder([socket]), adapter, processInspector());
    const id = `${socket.fingerprint}:%1`;
    expect((await discovery.dashboard(false, true)).agents).toMatchObject([{ id }]);

    commands.listPanes.mockResolvedValueOnce(undefined);
    vi.mocked(socketIsCurrent).mockResolvedValueOnce(false);
    const degraded = await discovery.dashboard(false, true);
    expect(degraded).toMatchObject({ tmuxOutage: { unavailableSockets: 1 }, agents: [], tmuxLastKnownAgents: [{ id, stale: true }] });
    expect(await discovery.snapshotTarget(id)).toBeUndefined();
    const commandCount = commands.listPanes.mock.calls.length;
    expect(await discovery.target(id, true)).toBeUndefined();
    expect(commands.listPanes).toHaveBeenCalledTimes(commandCount);

    await vi.advanceTimersByTimeAsync(5_000);
    const recovered = await discovery.dashboard(false, true);
    expect(recovered).not.toHaveProperty('tmuxOutage');
    expect(recovered.agents).toMatchObject([{ id }]);
    expect(await discovery.snapshotTarget(id)).toBeDefined();
  });

  // socket replacement invalidates the shared snapshot as well as the transport
  it('retains only snapshots for current socket identities', async () => {
    const commands = { listPanes: vi.fn().mockResolvedValue(row()), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    await adapter.listPanes(socket);
    const replacement = { ...socket, fingerprint: 'two', inode: 3 };
    adapter.retainSockets([replacement]);
    expect(adapter.paneSnapshotsNow().size).toBe(0);
    expect(commands.retainSockets).toHaveBeenCalledWith([replacement]);
  });
});
