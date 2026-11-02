import { afterEach, describe, expect, it, vi } from 'vitest';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/tmux/command.js', async original => ({ ...await original<typeof import('../src/tmux/command.js')>(), run, socketIsCurrent: vi.fn().mockResolvedValue(true) }));
import { socketIsCurrent } from '../src/tmux/command.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { testConfig, testWorktree } from './helpers/config.js';

const socket = { path: '/tmp/tmux-test', fingerprint: 'one', device: 1, inode: 2 };
// include stack metadata in the shared dashboard row
const row = (dead = '0', status = '', cwd = '/worktree', keyBinding = '') => ['%1', '$1', 'main', '123', cwd, 'node', 'café ☕', '', '', '', '', '', '', '', 'process', '', '@1', '', 'project:/worktree', 'dev', '', dead, status, keyBinding, '', '/worktree'].join('\t') + '\n';
// isolate clock and command mocks
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllEnvs(); run.mockReset(); });

describe('shared pane snapshots', () => {
  // successful listings are reused only by explicit dashboard snapshot readers
  it('uses persistent reads and keeps each list call fresh', async () => {
    const commands = { listPanes: vi.fn().mockResolvedValue(row()), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    const panes = await adapter.listPanes(socket);
    expect(panes).toMatchObject([{ title: 'café ☕', dead: false, processWorktree: '/worktree' }]);
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
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 0, stdout: row(), stderr: '' });
    expect(await adapter.listPanes(socket)).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'permission denied' });
    expect(await adapter.listPanes(socket)).toEqual([]);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await adapter.listPanes(socket);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'available', panes: [] });
  });

  // a partial reply stays unknown rather than hiding panes omitted by parsing
  it('publishes malformed listings as unavailable observations', async () => {
    const adapter = new TmuxAdapter();
    run.mockResolvedValue({ code: 0, stdout: `${row()}malformed\n`, stderr: '' });
    expect(await adapter.listPanes(socket)).toHaveLength(1);
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
  });

  // stale socket files should not keep spawning clients at the dashboard cadence
  it('backs off confirmed absent servers but retries after expiry or replacement', async () => {
    vi.useFakeTimers();
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-test' });
    expect(await adapter.listPanes(socket, { backoffMissingServer: true })).toEqual([]);
    // multiple dashboard ticks reuse only the failure backoff, not an empty stack snapshot
    await vi.advanceTimersByTimeAsync(500);
    expect(await adapter.listPanes(socket, { backoffMissingServer: true })).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    expect(commands.listPanes).toHaveBeenCalledOnce();
    expect(adapter.paneSnapshotsNow().get(socket.path)).toEqual({ status: 'unavailable' });
    await vi.advanceTimersByTimeAsync(4_500);
    await adapter.listPanes(socket, { backoffMissingServer: true });
    expect(run).toHaveBeenCalledTimes(2);
    const replacement = { ...socket, fingerprint: 'new', inode: 3 };
    run.mockResolvedValue({ code: 0, stdout: row(), stderr: '' });
    expect(await adapter.listPanes(replacement, { backoffMissingServer: true })).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(3);
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

    await adapter.listPanes(stackSocket, { backoffMissingServer: true });
    await expect(service.state(worktree, adapter.paneSnapshotsNow())).resolves.toEqual({});
    await vi.advanceTimersByTimeAsync(500);
    await adapter.listPanes(stackSocket, { backoffMissingServer: true });
    await expect(service.state(worktree, adapter.paneSnapshotsNow())).resolves.toEqual({});
    expect(run).toHaveBeenCalledOnce();
    expect(stackCommand.mock.calls.filter(([, args]) => args.includes('list-panes'))).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4_500);
    await adapter.listPanes(stackSocket, { backoffMissingServer: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  // lifecycle reads must bypass the dashboard's missing-server backoff
  it('keeps explicit lifecycle listings fresh after an absent-server result', async () => {
    const commands = { listPanes: vi.fn().mockResolvedValue(undefined), retainSockets: vi.fn(), closeAll: vi.fn() };
    const adapter = new TmuxAdapter(commands);
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-test' });
    await adapter.listPanes(socket, { backoffMissingServer: true });
    run.mockResolvedValueOnce({ code: 0, stdout: row(), stderr: '' });
    expect(await adapter.listPanes(socket)).toHaveLength(1);
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
