import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchService } from '../src/launch/service.js';
import { run } from '../src/tmux/command.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';
import { scratchPlaceLabel } from '../src/places/places.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

// real tmux coverage uses only a private socket and a fake local agent executable
const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const zsh = execFileSync('/bin/sh', ['-c', 'command -v zsh || true'], { encoding: 'utf8' }).trim();
const tmuxSocketsWork = (() => {
  // require the real terminal dependencies
  if (tmux === '' || zsh === '' || process.platform !== 'linux') return false;
  let root = '';
  try {
    root = mkdtempSync(join(tmpdir(), 'rac-launch-dirty-probe-'));
    const socket = join(root, 'default');
    const started = spawnSync(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'probe', 'sleep 1'], { encoding: 'utf8' });
    spawnSync(tmux, ['-S', socket, 'kill-server']);
    return started.status === 0;
  } catch {
    return false;
  } finally {
    // remove the probe root
    if (root !== '') rmSync(root, { recursive: true, force: true });
  }
})();

type Fixture = {
  socket: SocketRef;
  session: string;
  oldPane: string;
  oldPid: number;
  dirtyFile: string;
  readyFile: string;
  accountHome: string;
  scratchRoot: string;
  worktree: Worktree;
  service: LaunchService;
};

const fixtures: Array<{ root: string; socket: string }> = [];

afterEach(async () => {
  // remove only this test's private servers and roots
  for (const fixture of fixtures.splice(0)) {
    await run(tmux, ['-S', fixture.socket, 'kill-server']).catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
  vi.unstubAllEnvs();
});

// read one tmux value without inheriting operator configuration
async function tmuxAt(socket: string, ...args: string[]): Promise<string> {
  return (await run(tmux, ['-S', socket, ...args])).stdout.trimEnd();
}

// make a marked workspace whose actual zsh already has unsubmitted input
async function fixture(scope: 'scratch' | 'worktree', viewed: boolean): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `rac-launch-dirty-${scope}-`)));
  const socketPath = join(root, 'default');
  fixtures.push({ root, socket: socketPath });
  const accountHome = join(root, 'account');
  const scratchRoot = join(accountHome, 'scratch');
  const worktreeRoot = join(accountHome, 'weather');
  await mkdir(scratchRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  const fakeAgent = join(root, 'fake-agent');
  const readyFile = join(root, `${scope}-ready`);
  const dirtyFile = join(root, `${scope}-dirty-ran`);
  await writeFile(fakeAgent, '#!/bin/sh\nprintf \'%s\\n%s\\n%s\\n\' "$PWD" "$HOME" "$$" > "$RAC_READY_FILE"\nexec sleep 60\n');
  await chmod(fakeAgent, 0o755);

  const worktree = testWorktree({ id: `weather:${worktreeRoot}`, projectId: 'weather', label: 'Weather', path: worktreeRoot, identity: worktreeRoot, hostPath: worktreeRoot });
  const placeId = scope === 'scratch' ? `scratch:${scratchRoot}` : worktree.id;
  const cwd = scope === 'scratch' ? scratchRoot : worktreeRoot;
  const session = `${scope}-workspace`;
  const created = await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', session, '-x', '100', '-y', '30', '-c', cwd, '-P', '-F', '#{pane_id}', '--', '/usr/bin/env', `HOME=${accountHome}`, `ZDOTDIR=${accountHome}`, 'PS1=fixture> ', zsh, '-f', '-i']);
  expect(created.code).toBe(0);
  const oldPane = created.stdout.trim();
  expect(oldPane).toMatch(/^%\d+$/u);
  expect((await run(tmux, ['-S', socketPath, 'set-option', '-t', session, '@rac_place', placeId])).code).toBe(0);
  expect((await run(tmux, ['-S', socketPath, 'set-option', '-p', '-t', oldPane, '@rac_console_managed', '1'])).code).toBe(0);
  // match scratch's production-owned label
  if (scope === 'scratch') expect((await run(tmux, ['-S', socketPath, 'set-option', '-p', '-t', oldPane, '@rac_display_label', scratchPlaceLabel])).code).toBe(0);

  await vi.waitFor(async () => {
    expect(await tmuxAt(socketPath, 'display-message', '-p', '-t', oldPane, '#{pane_current_command}')).toBe('zsh');
  }, { timeout: 5_000, interval: 50 });
  const dirtyInput = `printf dirty > '${dirtyFile}';`;
  expect((await run(tmux, ['-S', socketPath, 'send-keys', '-t', oldPane, '-l', '--', `${dirtyInput} `])).code).toBe(0);
  await vi.waitFor(async () => {
    expect(await tmuxAt(socketPath, 'capture-pane', '-p', '-J', '-t', oldPane)).toContain(dirtyInput);
  }, { timeout: 5_000, interval: 50 });
  const oldPid = Number(await tmuxAt(socketPath, 'display-message', '-p', '-t', oldPane, '#{pane_pid}'));

  vi.stubEnv('RAC_TMUX_BIN', tmux);
  vi.stubEnv('RAC_HOST_TMUX_DIR', root);
  vi.stubEnv('RAC_HOST_INTERACTIVE_SHELL', zsh);
  vi.stubEnv('RAC_HOST_PATH', '/usr/local/bin:/usr/bin:/bin');
  const socket: SocketRef = { fingerprint: `${scope}-fixture`, path: socketPath, device: 0, inode: 0 };
  const project = testProject({ id: 'weather', label: 'Weather', path: worktreeRoot, hostPath: worktreeRoot });
  const config = testConfig({
    adapters: { codex: { program: fakeAgent, args: [], env: { RAC_READY_FILE: readyFile }, launchable: true } },
    projects: [project],
    scratchDirectory: scratchRoot
  } as never);
  const store = { launchProfiles: async () => ({}), rememberLaunchProfile: async () => {} };
  const openTerminals = viewed ? () => new Set([`${socket.fingerprint}\0${oldPane}`]) : () => new Set<string>();
  const service = new LaunchService(config, { find: async () => [socket] }, new TmuxAdapter(), async path => path, store as never, () => [worktree], openTerminals);
  return { socket, session, oldPane, oldPid, dirtyFile, readyFile, accountHome, scratchRoot, worktree, service };
}

describe.skipIf(!tmuxSocketsWork)('LaunchService dirty shells (real tmux)', () => {
  it.each([
    { scope: 'scratch' as const, viewed: false },
    { scope: 'worktree' as const, viewed: false },
    { scope: 'worktree' as const, viewed: true }
  ])('starts a clean $scope agent window without touching a dirty zsh (viewed: $viewed)', async ({ scope, viewed }) => {
    const item = await fixture(scope, viewed);
    const before = await tmuxAt(item.socket.path, 'capture-pane', '-p', '-J', '-t', item.oldPane);

    await expect(scope === 'scratch' ? item.service.launchHome('codex') : item.service.launch(item.worktree.id, 'codex')).resolves.toBe(true);
    await vi.waitFor(async () => {
      expect(await readFile(item.readyFile, 'utf8').catch(() => '')).not.toBe('');
    }, { timeout: 10_000, interval: 50 });

    // the original composer and its process remain byte-for-byte untouched
    await expect(access(item.dirtyFile)).rejects.toThrow();
    expect(await tmuxAt(item.socket.path, 'capture-pane', '-p', '-J', '-t', item.oldPane)).toBe(before);
    expect(await tmuxAt(item.socket.path, 'display-message', '-p', '-t', item.oldPane, '#{pane_pid}')).toBe(String(item.oldPid));
    expect(() => process.kill(item.oldPid, 0)).not.toThrow();

    // the fake agent runs beside it in the same workspace with the host launch context
    const panes = await new TmuxAdapter().listPanes(item.socket);
    expect(panes).toHaveLength(2);
    const original = panes.find(pane => pane.paneId === item.oldPane);
    const launched = panes.find(pane => pane.paneId !== item.oldPane);
    expect(original).toMatchObject({ pid: item.oldPid, sessionName: item.session, placeMark: scope === 'scratch' ? `scratch:${item.scratchRoot}` : item.worktree.id });
    expect(launched).toMatchObject({ sessionId: original?.sessionId, sessionName: item.session, consoleManaged: true, placeMark: original?.placeMark });
    const ready = (await readFile(item.readyFile, 'utf8')).trim().split('\n');
    expect(ready).toEqual([
      scope === 'scratch' ? item.scratchRoot : item.worktree.hostPath,
      item.accountHome,
      expect.stringMatching(/^\d+$/u)
    ]);
    expect(() => process.kill(Number(ready[2]), 0)).not.toThrow();
    expect(await tmuxAt(item.socket.path, 'list-sessions', '-F', '#{session_name}')).toBe(item.session);
  }, 20_000);
});
