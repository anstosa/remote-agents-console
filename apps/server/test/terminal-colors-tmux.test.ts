import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/tmux/command.js';
import { terminalColorFallbackArgv } from '../src/tmux/terminal-colors.js';

const fallbackStyle = 'fg=#cdd6f4,bg=#1e1e2e';
const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const python = execFileSync('/bin/sh', ['-c', 'command -v python3 || true'], { encoding: 'utf8' }).trim();
const script = execFileSync('/bin/sh', ['-c', 'command -v script || true'], { encoding: 'utf8' }).trim();
const tmuxSocketsWork = (() => {
  // skip real-server cases where unix sockets are unavailable
  if (tmux === '' || process.platform !== 'linux') return false;
  let root = '';
  try {
    root = mkdtempSync(join(tmpdir(), 'rac-colors-probe-'));
    const socket = join(root, 'sock');
    const started = spawnSync(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'probe', 'sleep', '1'], { encoding: 'utf8' });
    spawnSync(tmux, ['-S', socket, 'kill-server']);
    return started.status === 0;
  } catch {
    return false;
  } finally {
    // remove every private probe artifact
    if (root !== '') rmSync(root, { recursive: true, force: true });
  }
})();

type Fixture = { root: string; socket: string; pane: string };
const fixtures: Fixture[] = [];
const clients: ChildProcess[] = [];

afterEach(async () => {
  // stop attached test clients before their private server
  for (const client of clients.splice(0)) client.kill('SIGTERM');
  // remove every private server and output file
  for (const fixture of fixtures.splice(0)) {
    await run(tmux, ['-S', fixture.socket, 'kill-server']).catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// run a wrapped command with an explicit environment
async function execute(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// create one detached session without user configuration
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'rac-terminal-colors-'));
  const socket = join(root, 'tmux.sock');
  const started = await run(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', 'cat']);
  expect(started.code).toBe(0);
  const pane = (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', 'fixture', '#{pane_id}'])).stdout.trim();
  expect(pane).toMatch(/^%\d+$/u);
  const value = { root, socket, pane };
  fixtures.push(value);
  return value;
}

// read both effective pane styles independently
async function styles(socket: string, pane: string): Promise<[string, string]> {
  const normal = await run(tmux, ['-S', socket, 'show-options', '-p', '-A', '-v', '-t', pane, 'window-style']);
  const active = await run(tmux, ['-S', socket, 'show-options', '-p', '-A', '-v', '-t', pane, 'window-active-style']);
  expect(normal.code).toBe(0);
  expect(active.code).toBe(0);
  return [normal.stdout.trim(), active.stdout.trim()];
}

// split one pane whose pre-exec wrapper stays alive for inspection
async function splitWrapped(f: Fixture): Promise<string> {
  const created = await run(tmux, ['-S', f.socket, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', f.pane, '--', ...terminalColorFallbackArgv(tmux, ['/bin/sleep', '30'])]);
  expect(created.code).toBe(0);
  const pane = created.stdout.trim();
  expect(pane).toMatch(/^%\d+$/u);
  return pane;
}

// wait until the wrapper has either applied or skipped its styles
async function waitForStyles(socket: string, pane: string, expected: [string, string]): Promise<void> {
  await vi.waitFor(async () => { expect(await styles(socket, pane)).toEqual(expected); }, { timeout: 2_000, interval: 20 });
}

describe('terminal color fallback argv', () => {
  it.each([
    ['outside tmux', {}],
    ['invalid tmux', { TMUX: 'not-a-tmux-value', TMUX_PANE: '%1' }],
    ['invalid pane', { TMUX: '/tmp/missing,12,0', TMUX_PANE: '%1;display-message' }],
    ['missing tmux binary', { TMUX: '/tmp/missing,12,0', TMUX_PANE: '%1' }]
  ])('executes the original argv exactly %s', async (_label, additions) => {
    const sentinel = join(tmpdir(), `rac-terminal-colors-injection-${process.pid}`);
    const hostile = `value with spaces ' " $(touch ${sentinel}); #`;
    const original = [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', hostile, '--second'];
    const binary = additions.TMUX === '/tmp/missing,12,0' ? '/missing/tmux binary' : tmux;
    const wrapped = terminalColorFallbackArgv(binary, original);
    const result = await execute(wrapped, { PATH: process.env.PATH, ...additions });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([hostile, '--second']);
    expect(existsSync(sentinel)).toBe(false);
    expect(wrapped[2]).not.toContain(hostile);
  });
});

describe.skipIf(!tmuxSocketsWork)('terminal color fallback (real tmux)', () => {
  // resolve bridge probes from the live server before host path restoration
  it.each(['', '/rac-missing-path'])('initializes headless colors with host PATH=%j', async path => {
    const f = await fixture();
    const created = await run(tmux, ['-S', f.socket, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', f.pane, '--', '/usr/bin/env', `PATH=${path}`, ...terminalColorFallbackArgv('tmux', ['/bin/sleep', '30'])]);
    expect(created.code).toBe(0);
    await waitForStyles(f.socket, created.stdout.trim(), [fallbackStyle, fallbackStyle]);
    expect(await styles(f.socket, f.pane)).toEqual(['default', 'default']);
  });

  it.skipIf(python === '')('sets both pane styles before an immediate raw-pty color query and leaves its parent untouched', async () => {
    const f = await fixture();
    const output = join(f.root, 'osc.json');
    const query = [
      'import json, os, select, sys, termios, time, tty',
      'fd = 0',
      'old = termios.tcgetattr(fd)',
      'tty.setraw(fd)',
      'started = time.monotonic()',
      "os.write(1, b'\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x1b\\\\')",
      'data = b""',
      'while time.monotonic() - started < 0.25:',
      '    ready, _, _ = select.select([fd], [], [], max(0, 0.25 - (time.monotonic() - started)))',
      '    if not ready: break',
      '    data += os.read(fd, 4096)',
      "    if b']10;rgb:' in data and b']11;rgb:' in data: break",
      'termios.tcsetattr(fd, termios.TCSANOW, old)',
      "with open(sys.argv[1], 'w') as target: json.dump({'hex': data.hex()}, target)",
      'time.sleep(30)'
    ].join('\n');
    const created = await run(tmux, ['-S', f.socket, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', f.pane, '--', ...terminalColorFallbackArgv(tmux, [python, '-c', query, output])]);
    expect(created.code).toBe(0);
    const pane = created.stdout.trim();
    await vi.waitFor(async () => { expect(existsSync(output)).toBe(true); }, { timeout: 2_000, interval: 20 });
    const result = JSON.parse(await readFile(output, 'utf8')) as { hex: string };
    const response = Buffer.from(result.hex, 'hex').toString('latin1');
    expect(response).toContain('\u001b]10;rgb:cdcd/d6d6/f4f4\u001b\\');
    expect(response).toContain('\u001b]11;rgb:1e1e/1e1e/2e2e\u001b\\');
    expect(await styles(f.socket, pane)).toEqual([fallbackStyle, fallbackStyle]);
    expect(await styles(f.socket, f.pane)).toEqual(['default', 'default']);
  });

  it.each([
    ['normal style', 'window-style', 'fg=#f5c2e7,bg=#11111b'],
    ['active style', 'window-active-style', 'fg=#89b4fa,bg=#181825']
  ] as const)('preserves a partially custom pair inherited through %s', async (_label, option, custom) => {
    const f = await fixture();
    const pane = (await run(tmux, ['-S', f.socket, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', f.pane, 'sleep', '30'])).stdout.trim();
    expect((await run(tmux, ['-S', f.socket, 'set-option', '-p', '-t', pane, option, custom])).code).toBe(0);
    expect((await run(tmux, ['-S', f.socket, 'respawn-pane', '-k', '-t', pane, '--', ...terminalColorFallbackArgv(tmux, ['/bin/sleep', '30'])])).code).toBe(0);
    const expected: [string, string] = option === 'window-style' ? [custom, 'default'] : ['default', custom];
    await waitForStyles(f.socket, pane, expected);
  });

  it('treats a control-mode observer as headless', async () => {
    const f = await fixture();
    const client = spawn(tmux, ['-S', f.socket, '-C', 'attach-session', '-t', 'fixture', '-f', 'ignore-size'], { stdio: ['pipe', 'pipe', 'pipe'] });
    clients.push(client);
    await vi.waitFor(async () => {
      const listed = await run(tmux, ['-S', f.socket, 'list-clients', '-F', '#{client_control_mode}|#{client_suspended}']);
      expect(listed.stdout.trim()).toBe('1|');
    }, { timeout: 2_000, interval: 20 });
    const pane = await splitWrapped(f);
    await waitForStyles(f.socket, pane, [fallbackStyle, fallbackStyle]);
  });

  it.skipIf(script === '')('leaves defaults unchanged while a real terminal client is attached', async () => {
    const f = await fixture();
    const client = spawn(script, ['-qefc', 'exec "$TMUX_TEST_BIN" -S "$TMUX_TEST_SOCKET" attach-session -t fixture', '/dev/null'], {
      env: { ...process.env, TMUX: '', TMUX_PANE: '', TMUX_TEST_BIN: tmux, TMUX_TEST_SOCKET: f.socket },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    clients.push(client);
    await vi.waitFor(async () => {
      const listed = await run(tmux, ['-S', f.socket, 'list-clients', '-F', '#{client_control_mode}|#{client_suspended}']);
      expect(listed.stdout.trim()).toBe('0|');
    }, { timeout: 2_000, interval: 20 });
    const pane = await splitWrapped(f);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await styles(f.socket, pane)).toEqual(['default', 'default']);
  });
});
