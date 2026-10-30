import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LaunchService } from '../src/launch/service.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';
import { interactiveShellName } from '../src/tmux/interactive-shell.js';
import type { LineChannel } from '../src/transports/structured.js';
import type { SocketRef } from '../src/domain/models.js';
import { adhocScratchPlace } from '../src/places/places.js';
import { commandWindows } from '../src/watches/commands.js';
import { socketFinder } from './helpers/discovery-stubs.js';
import { testConfig } from './helpers/config.js';

// A command Watch's window (ADR 0019) under a throwaway tmux server on a private socket: the
// command runs under the holder in a tagged window of the Place's Workspace session, sandboxed as
// a Sandboxed Pi's commands are (its folder writable, nothing above it, only the allowlisted
// environment), its stdout lines reach the console and are replayed to a later connection, and its
// exit status stays readable on the dead pane. Unix sockets and the sandbox runtime's bubblewrap
// are unavailable in the build sandbox, so this is skipped there and runs on the host and in CI.

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const bwrap = execFileSync('/bin/sh', ['-c', 'command -v bwrap || true'], { encoding: 'utf8' }).trim();
// the window's login shell, as the console-shell suite resolves it (the default /usr/bin/zsh may not exist)
const loginShell = [process.env.RAC_INTERACTIVE_SHELL?.trim(), process.env.SHELL?.trim(), '/usr/bin/zsh', '/bin/bash'].find((path): path is string => path !== undefined && ['zsh', 'bash', 'fish'].includes(interactiveShellName(path)) && existsSync(path));
const tmuxSocketsWork = (() => {
  if (tmux === '' || process.platform !== 'linux') return false;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'rac-watch-probe-'));
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

const roots: Array<{ root: string; socket: string }> = [];
const channels: LineChannel[] = [];
afterEach(async () => {
  for (const channel of channels.splice(0)) channel.close();
  for (const { root, socket } of roots.splice(0)) {
    await run(tmux, ['-S', socket, 'kill-server']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// a tmux server with one session marked as the Workspace of an ad-hoc Scratch Place in `home`,
// whose parent the command may not write; the Pi kind's policy allows no network and nothing else
async function workspace(env: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-watch-')));
  const home = join(root, 'home');
  await mkdir(home);
  const socketPath = join(root, 'tmux');
  roots.push({ root, socket: socketPath });
  const place = adhocScratchPlace(home);
  expect((await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'work', '-x', '80', '-y', '24', '-c', home, 'cat'])).code).toBe(0);
  expect((await run(tmux, ['-S', socketPath, 'set-option', '-t', 'work', '@rac_place', place.id])).code).toBe(0);
  const socket: SocketRef = { fingerprint: 'work', path: socketPath, device: 0, inode: 0 };
  const launch = new LaunchService(testConfig(), socketFinder([socket]), new TmuxAdapter(), undefined, undefined, () => [], () => new Set(), async () => ({ socket, session: 'work' }), join(root, 'private'));
  const policy = join(root, 'sandbox.json');
  // as the console renders it: its private directory (holder sockets) unreadable and unwritable
  await writeFile(policy, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [join(root, 'private')], allowWrite: [], denyWrite: [join(root, 'private')] }, env: [], repositories: [] }));
  const windows = commandWindows(launch, { pi: { program: process.execPath, args: [], env: { PI_CODING_AGENT_DIR: join(root, 'pi'), ...env }, launchable: true } } as never, async () => ({ 'sandbox.json': policy }));
  return { root, home, place, socketPath, windows };
}

// the lines a connection reads, until it closes or `count` have come
async function read(connected: { channel: LineChannel }, count: number): Promise<string[]> {
  const lines: string[] = [];
  channels.push(connected.channel);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`only ${JSON.stringify(lines)} within 30 s`)), 30_000);
    const done = () => { clearTimeout(timer); resolve(); };
    connected.channel.onLine(line => { lines.push(line); if (lines.length >= count) done(); });
    connected.channel.onClose(done);
  });
  return lines;
}

describe.skipIf(!tmuxSocketsWork || loginShell === undefined || bwrap === '')('a command Watch\'s window', () => {
  beforeAll(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); vi.stubEnv('RAC_INTERACTIVE_SHELL', loginShell!); });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('runs the command sandboxed in a tagged window of the Workspace, reads its stdout, and keeps its exit status', async () => {
    const { root, home, place, socketPath, windows } = await workspace();
    const holder = await windows.open(place, 'watch-1', 'echo one; touch inside.txt && echo wrote inside; touch ../outside.txt 2>/dev/null || echo refused outside; exit 3', 'pi');
    expect(holder).toBeDefined();
    const panes = await run(tmux, ['-S', socketPath, 'list-panes', '-a', '-F', '#{session_name} #{pane_id} #{@rac_role} #{@rac_agent}']);
    expect(panes.stdout).toContain(`work ${holder!.pane} holder watch-1`);

    const connected = await windows.connect(holder!, 0);
    expect(await read(connected!, 3)).toEqual(['one', 'wrote inside', 'refused outside']);
    expect(existsSync(join(home, 'inside.txt'))).toBe(true);
    expect(existsSync(join(root, 'outside.txt'))).toBe(false);
    await vi.waitFor(async () => expect(await windows.status(holder!)).toEqual({ dead: true, status: 3 }), { timeout: 10_000 });

    await windows.close(holder!);
    expect(await windows.status(holder!)).toBeUndefined();
  });

  it('replays the lines a later connection has not read, as after a deploy', async () => {
    const { place, windows } = await workspace();
    const holder = await windows.open(place, 'watch-2', 'echo first; echo second; exec sleep 300', 'pi');
    const first = await windows.connect(holder!, 0);
    expect(await read(first!, 2)).toEqual(['first', 'second']);
    first!.channel.close();

    const next = await windows.connect(holder!, 1);
    expect(next!.from).toBe(1);
    expect(await read(next!, 1)).toEqual(['second']);
    expect(await windows.status(holder!)).toEqual({ dead: false });
  });

  it('keeps Pi\'s credentials and the console\'s private directory out of the command\'s reach', async () => {
    const { root, place, windows } = await workspace();
    await mkdir(join(root, 'pi'), { recursive: true });
    await writeFile(join(root, 'pi', 'auth.json'), '{"openai":"key"}');
    await mkdir(join(root, 'private', 'holders'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'private', 'note'), 'console state');
    const holder = await windows.open(place, 'watch-4', `cat '${join(root, 'pi', 'auth.json')}' 2>/dev/null || echo no auth; cat '${join(root, 'private', 'note')}' 2>/dev/null || echo no private`, 'pi');
    expect(await read((await windows.connect(holder!, 0))!, 2)).toEqual(['no auth', 'no private']);
  });

  it('gives the command only the allowlisted environment, never the kind\'s other variables', async () => {
    const { place, windows } = await workspace({ RAC_WATCH_SECRET: 'hunter2' });
    const holder = await windows.open(place, 'watch-3', 'echo "secret=${RAC_WATCH_SECRET:-none} home=${HOME:+set}"', 'pi');
    expect(await read((await windows.connect(holder!, 0))!, 1)).toEqual(['secret=none home=set']);
  });
});
