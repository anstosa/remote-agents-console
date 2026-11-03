import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { run } from '../src/tmux/command.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { testConfig, testWorktree } from './helpers/config.js';

// Stack processes against a throwaway tmux server on a private socket: a real long-running
// command stays live in its tagged window, a fresh service instance (a restarted console)
// finds it again by those tags, a command that dies at once leaves a findable dead pane, and
// Stop ends a command with Ctrl+C (or a kill, when it ignores that), several processes of
// one Worktree share its Workspace session, each run's output lands in the process's log
// file, and a notice the process writes shows in its state. Unix sockets are blocked
// in the build sandbox, so this is skipped there and runs on the host and in CI.

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const tmuxSocketsWork = (() => {
  if (tmux === '' || process.platform !== 'linux') return false;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'rac-sp-probe-'));
    const socket = join(dir, 'sock');
    const started = spawnSync(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'probe', 'sleep 1'], { encoding: 'utf8' });
    spawnSync(tmux, ['-S', socket, 'kill-server']);
    return started.status === 0;
  } catch {
    return false;
  } finally {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
})();

const previous = { dir: process.env.RAC_HOST_TMUX_DIR, bin: process.env.RAC_TMUX_BIN, path: process.env.RAC_HOST_PATH };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await run(tmux, ['-S', join(root, 'default'), 'kill-server']).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const [key, value] of [['RAC_HOST_TMUX_DIR', previous.dir], ['RAC_TMUX_BIN', previous.bin], ['RAC_HOST_PATH', previous.path]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// A private tmux server, started without the operator's config, whose socket is named
// `default` so its directory stands in for RAC_HOST_TMUX_DIR. It holds one unmarked session,
// `fixture`, as the operator's own would be. The temp root doubles as the Worktree checkout the
// process runs in (its basename is what a session made for the Worktree is named).
async function fixture(command: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-sp-worktree-')));
  roots.push(root);
  const socket = join(root, 'default');
  expect((await run(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'fixture', 'cat', '-'])).code).toBe(0);
  process.env.RAC_HOST_TMUX_DIR = root;
  process.env.RAC_TMUX_BIN = tmux;
  delete process.env.RAC_HOST_PATH;
  const worktree = testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, commands: { processes: { dev: command } } });
  const service = () => new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never);
  const tmuxAt = async (...args: string[]) => (await run(tmux, ['-S', socket, ...args])).stdout.trim();
  // the Place pane listing the console streams Terminals from, over this server's socket
  const listPanes = () => new TmuxAdapter().listPanes({ fingerprint: 'fixture', path: socket, device: 0, inode: 0 });
  return { root, worktree, service, tmuxAt, listPanes };
}

describe.skipIf(!tmuxSocketsWork)('Stack process on a real tmux server', () => {
  it("keeps a long-running command live in a tagged window of the Workspace session, and a new instance finds it", async () => {
    const { root, worktree, service, tmuxAt, listPanes } = await fixture('echo "dev server up in $PWD"; exec sleep 300');
    // the fixture session is this Worktree's Workspace, as a launch or a claim marks one
    await tmuxAt('set-option', '-t', '=fixture:', '@rac_place', worktree.id);
    const first = service();

    await expect(first.start(worktree.id, 'start')).resolves.toBe('started');
    // a login bash sources the operator's profile first, which can take a while
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain(`dev server up in ${root}`); }, { timeout: 10_000, interval: 100 });

    // it joined the Workspace session rather than making another, and its window is tagged,
    // kept on exit, and its pane marked as a process
    expect(await tmuxAt('list-sessions', '-F', '#{session_name}')).toBe('fixture');
    await vi.waitFor(async () => { expect(await tmuxAt('display-message', '-p', '-t', '=fixture:dev', '#{@rac_worktree}|#{@rac_process}|#{remain-on-exit}|#{pane_dead}|#{@rac_role}')).toBe(`${root}|dev|on|0|process`); }, { timeout: 10_000, interval: 100 });
    expect(await first.state(worktree)).toMatchObject({ running: true, processes: [{ name: 'dev', state: 'running' }] });
    const pane = await tmuxAt('display-message', '-p', '-t', '=fixture:dev', '#{pane_id}');
    expect(await first.processOutput(worktree.id, 'dev')).toMatchObject({ state: 'running', paneId: pane, output: expect.stringContaining(`dev server up in ${root}`) });
    // Clear empties the live pane while the process keeps running
    await expect(first.clearProcessOutput(worktree.id, 'dev')).resolves.toBe(true);
    expect(await first.processOutput(worktree.id, 'dev')).toMatchObject({ state: 'running', paneId: pane, output: '' });
    // the Place pane listing, which admits a pane to a Terminal, holds it named for its process
    const listed = await listPanes();
    expect(listed.find(candidate => candidate.paneId === pane)).toMatchObject({ role: 'process', processName: 'dev', placeMark: worktree.id });

    // a restarted console keeps no memory of the process yet finds it, and Start is a no-op
    const second = service();
    await expect(second.state(worktree)).resolves.toEqual({ running: true, processes: [{ name: 'dev', state: 'running' }] });
    await expect(second.start(worktree.id, 'start')).resolves.toBe('started');
    // still one process window beside the fixture's own (whose empty tag the trim drops)
    expect(await tmuxAt('list-windows', '-t', '=fixture:', '-F', '#{@rac_process}')).toBe('dev');
  });

  it('makes a Workspace session for a Worktree that has none, keeps a command that dies at once as a dead pane with its output, and Start reruns it there', async () => {
    // an `exit` runs a login shell's logout script, which on Debian clears the screen; each run
    // leaves a line in `runs` (the command runs in the checkout) so a rerun can be counted
    const { root, worktree, service, tmuxAt, listPanes } = await fixture('echo run >> runs; echo "missing binary"; exit 3');
    const runs = async () => (await readFile(join(root, 'runs'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const instance = service();

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    // the operator's unmarked session is left alone; a new one named for the checkout is marked
    const session = basename(root);
    expect((await tmuxAt('list-sessions', '-F', '#{session_name}')).split('\n').sort()).toEqual(['fixture', session].sort());
    expect(await tmuxAt('show-options', '-v', '-t', `=${session}:`, '@rac_place')).toBe(worktree.id);
    await vi.waitFor(async () => { expect(await instance.state(worktree)).toEqual({ running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 3 }] }); }, { timeout: 10_000, interval: 100 });
    expect(await tmuxAt('capture-pane', '-p', '-J', '-S', '-', '-t', `=${session}:dev`)).toContain('missing binary');
    // "Show dev output" reads the same dead pane, with its code
    const exited = await instance.processOutput(worktree.id, 'dev');
    expect(exited).toMatchObject({ name: 'dev', state: 'exited', exitCode: 3, output: expect.stringContaining('missing binary') });
    // Clear empties even a dead pane, screen and history both
    await expect(instance.clearProcessOutput(worktree.id, 'dev')).resolves.toBe(true);
    expect(await instance.processOutput(worktree.id, 'dev')).toMatchObject({ state: 'exited', exitCode: 3, output: '' });
    // a dead pane reports no cwd, so the Place pane listing drops it and it offers no Terminal
    expect(exited).not.toHaveProperty('paneId');
    const pane = await tmuxAt('display-message', '-p', '-t', `=${session}:dev`, '#{pane_id}');
    expect((await listPanes()).map(candidate => candidate.paneId)).not.toContain(pane);
    expect(await runs()).toBe(1);

    // Start after the crash respawns the command in the same pane, not a second window
    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await runs()).toBe(2); }, { timeout: 10_000, interval: 100 });
    await vi.waitFor(async () => { expect(await instance.state(worktree)).toEqual({ running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 3 }] }); }, { timeout: 10_000, interval: 100 });
    expect(await tmuxAt('list-panes', '-s', '-t', `=${session}:`, '-F', '#{pane_id}')).toBe(pane);
  });

  // tmux format-expands a session name and a start directory; a checkout folder named with a
  // format must come back literally (a harmless `#{pid}` stands in for a `#(command)`)
  it('names a new Workspace session for a checkout whose folder carries a tmux format, literally', async () => {
    const { root, tmuxAt } = await fixture('exec sleep 300');
    const checkout = join(root, 'app#{pid}');
    await mkdir(checkout);
    const worktree = testWorktree({ id: `proj:${checkout}`, projectId: 'proj', path: checkout, commands: { processes: { dev: 'echo "in $PWD"; exec sleep 300' } } });
    const service = new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never);

    await expect(service.start(worktree.id, 'start')).resolves.toBe('started');
    expect((await tmuxAt('list-sessions', '-F', '#{session_name}')).split('\n')).toContain('app#{pid}');
    await vi.waitFor(async () => { expect(await service.state(worktree)).toMatchObject({ running: true }); }, { timeout: 10_000, interval: 100 });
  });

  // The process runs under a login bash and a subshell without job control, so they share one
  // process group and Ctrl+C reaches the command itself; its INT trap counts each interrupt,
  // proving it was the signal, not a kill, that ended it. The pane starts in copy mode, as an
  // operator scrolling its Terminal leaves it, where a bare Ctrl+C would only leave the mode.
  it('restarts a real command in its own pane and stops it with Ctrl+C, even from copy mode', async () => {
    const { root, worktree, service, tmuxAt } = await fixture(`trap 'echo interrupted >> interrupted; exit 0' INT; echo "dev up"; while :; do sleep 0.1; done`);
    await tmuxAt('set-option', '-t', '=fixture:', '@rac_place', worktree.id);
    const instance = service();
    const interrupts = async () => (await readFile(join(root, 'interrupted'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain('dev up'); }, { timeout: 10_000, interval: 100 });
    const [pane, pid] = (await tmuxAt('display-message', '-p', '-t', '=fixture:dev', '#{pane_id} #{pane_pid}')).split(' ');
    await tmuxAt('copy-mode', '-t', '=fixture:dev');

    await expect(instance.start(worktree.id, 'restart')).resolves.toBe('started');
    expect(await interrupts()).toBe(1);
    // the same pane, running a new process
    const [restartedPane, restartedPid] = (await tmuxAt('display-message', '-p', '-t', '=fixture:dev', '#{pane_id} #{pane_pid}')).split(' ');
    expect(restartedPane).toBe(pane);
    expect(restartedPid).not.toBe(pid);
    await vi.waitFor(async () => { expect(await instance.state(worktree)).toMatchObject({ running: true, processes: [{ name: 'dev', state: 'running' }] }); }, { timeout: 10_000, interval: 100 });
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain('dev up'); }, { timeout: 10_000, interval: 100 });

    await tmuxAt('copy-mode', '-t', '=fixture:dev');
    const began = Date.now();
    await expect(instance.start(worktree.id, 'stop')).resolves.toBe('started');
    // well inside the 10 s budget, so Ctrl+C ended it rather than the kill
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(await interrupts()).toBe(2);
    await expect(instance.state(worktree)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
    // the Workspace session and its own window outlive the process window
    expect(await tmuxAt('list-windows', '-t', '=fixture:', '-F', '#{window_name}')).not.toContain('dev');
  }, 40_000);

  it('kills a real command that ignores Ctrl+C once the stop budget runs out', async () => {
    const { root, worktree, tmuxAt } = await fixture('trap "" INT; echo "$BASHPID" > pid; echo "stubborn up"; while :; do sleep 0.1; done');
    await tmuxAt('set-option', '-t', '=fixture:', '@rac_place', worktree.id);
    const instance = new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never, undefined, undefined, undefined, undefined, { timeoutMs: 500, pollMs: 50 });

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', '=fixture:dev')).toContain('stubborn up'); }, { timeout: 10_000, interval: 100 });
    const pid = Number((await readFile(join(root, 'pid'), 'utf8')).trim());
    await expect(instance.start(worktree.id, 'stop')).resolves.toBe('started');
    await expect(instance.state(worktree)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
    expect(await tmuxAt('list-windows', '-t', '=fixture:', '-F', '#{window_name}')).not.toContain('dev');
    // the command itself is gone, not just its window
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 5_000, interval: 100 });
  }, 30_000);

  // several processes of one Worktree share the Workspace session the first one makes
  it('runs two processes as one stack in one Workspace session, and stops them both', async () => {
    const { root, tmuxAt } = await fixture('exec sleep 300');
    const worktree = testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, commands: { processes: { api: 'echo "api up"; exec sleep 300', web: 'echo "web up"; exec sleep 300' } } });
    const instance = new WorktreeCommandService(testConfig(), { worktreesNow: () => [worktree] } as never);

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    const session = basename(root);
    expect((await tmuxAt('list-sessions', '-F', '#{session_name}')).split('\n').sort()).toEqual(['fixture', session].sort());
    expect((await tmuxAt('list-windows', '-t', `=${session}:`, '-F', '#{@rac_process}')).split('\n')).toEqual(['api', 'web']);
    for (const name of ['api', 'web']) await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', `=${session}:${name}`)).toContain(`${name} up`); }, { timeout: 10_000, interval: 100 });
    await expect(instance.state(worktree)).resolves.toMatchObject({ running: true, processes: [{ name: 'api', state: 'running' }, { name: 'web', state: 'running' }] });

    // one process alone: stopping it leaves the other running, and starting it opens it again
    await expect(instance.start(worktree.id, 'stop', 'api')).resolves.toBe('started');
    await expect(instance.state(worktree)).resolves.toMatchObject({ processes: [{ name: 'api', state: 'stopped' }, { name: 'web', state: 'running' }] });
    expect((await instance.state(worktree)).running).toBeUndefined();
    await expect(instance.start(worktree.id, 'start', 'api')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await tmuxAt('capture-pane', '-p', '-J', '-t', `=${session}:api`)).toContain('api up'); }, { timeout: 10_000, interval: 100 });
    await expect(instance.state(worktree)).resolves.toMatchObject({ running: true, processes: [{ name: 'api', state: 'running' }, { name: 'web', state: 'running' }] });

    await expect(instance.start(worktree.id, 'stop')).resolves.toBe('started');
    await expect(instance.state(worktree)).resolves.toEqual({ running: false, processes: [{ name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped' }] });
  }, 40_000);

  // an agent that reaches neither tmux nor the console reads the output from its checkout's git
  // directory; each run counts itself in `count`, so the log shows which run it holds
  it("writes a process's output to its log in the git directory, afresh on each run", async () => {
    const { root, worktree, service } = await fixture('n=$(( $(cat count 2>/dev/null || echo 0) + 1 )); echo "$n" > count; echo "run $n up"; exec sleep 300');
    execFileSync('/usr/bin/git', ['init', '-q', root]);
    const log = join(root, '.git', 'rac', 'processes', 'dev.log');
    const read = () => readFile(log, 'utf8').catch(() => '');
    const instance = service();

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await read()).toContain('run 1 up'); }, { timeout: 10_000, interval: 100 });

    // a Restart's rerun (in the pane Ctrl+C left dead) starts the file again
    await expect(instance.start(worktree.id, 'restart')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await read()).toContain('run 2 up'); }, { timeout: 10_000, interval: 100 });
    expect(await read()).not.toContain('run 1 up');
  }, 40_000);

  // a process reports a notice by writing the file the console names in RAC_PROCESS_NOTICES
  it('shows a notice a process writes to $RAC_PROCESS_NOTICES in the next state, and clears it on Stop', async () => {
    const { root, worktree, service } = await fixture(`printf '%s' '[{"message": "static is not running"}]' > "$RAC_PROCESS_NOTICES"; exec sleep 300`);
    execFileSync('/usr/bin/git', ['init', '-q', root]);
    const instance = service();

    await expect(instance.start(worktree.id, 'start')).resolves.toBe('started');
    await vi.waitFor(async () => { expect(await instance.state(worktree)).toMatchObject({ processes: [{ name: 'dev', state: 'running', notices: [{ level: 'warning', message: 'static is not running' }] }] }); }, { timeout: 10_000, interval: 100 });

    await expect(instance.start(worktree.id, 'stop')).resolves.toBe('started');
    await expect(instance.state(worktree)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
    expect(existsSync(join(root, '.git', 'rac', 'processes', 'dev.notices.json'))).toBe(false);
  }, 40_000);

  it('reports a process stopped before it ever ran, and makes no session by reading', async () => {
    const { worktree, service, tmuxAt } = await fixture('exec sleep 300');
    await expect(service().state(worktree)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
    expect(await tmuxAt('list-sessions', '-F', '#{session_name}')).toBe('fixture');
  });
});
