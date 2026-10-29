import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp as mkdtempAsync, rm as rmAsync } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketStore } from '../src/auth/tickets.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { PaneStreamRegistry } from '../src/tmux/control.js';
import { run } from '../src/tmux/command.js';
import { testConfig, testProject } from './helpers/config.js';

// The ticket's PRIMARY seam: the app built with its real tmux dependencies (TmuxAdapter and
// the control-mode PaneStreamRegistry) against a throwaway tmux server on a private socket,
// driven through a real /ws/pane WebSocket. It proves end to end what the fake-stream seam
// cannot: a byte-exact seed from a live pane, typed input echoing back as real bytes, a real
// resize, and a killed pane ending the stream. Unix sockets are blocked in the build sandbox,
// so this is skipped there and run on the host and in CI (the effort records the host run).

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const tmuxSocketsWork = (() => {
  if (tmux === '' || process.platform !== 'linux') return false;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'rac-cc-probe-'));
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

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true, active: () => true } as never;
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const fixtures: Array<{ root: string; socket: string }> = [];
const openApps: FastifyInstance[] = [];
const openSockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of openSockets.splice(0)) { try { ws.close(); } catch { /* closed */ } }
  for (const app of openApps.splice(0)) await app.close().catch(() => undefined);
  for (const { root, socket } of fixtures.splice(0)) {
    await run(tmux, ['-S', socket, 'kill-server']).catch(() => undefined);
    await rmAsync(root, { recursive: true, force: true }).catch(() => undefined);
  }
  vi.restoreAllMocks();
});

// a fixture session with one 80x24 pane running `cat`, which echoes every typed byte, so
// input is observable both as streamed bytes and in a capture
async function fixtureSession(): Promise<{ socket: { fingerprint: string; path: string; device: number; inode: number }; socketPath: string; pane: string }> {
  const root = await mkdtempAsync(join(tmpdir(), 'rac-pane-tmux-'));
  const socketPath = join(root, 'tmux.sock');
  fixtures.push({ root, socket: socketPath });
  expect((await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', 'cat'])).code).toBe(0);
  const paneOut = await run(tmux, ['-S', socketPath, 'display-message', '-p', '-t', 'fixture', '#{pane_id}']);
  const pane = paneOut.stdout.trim();
  expect(pane).toMatch(/^%\d+$/);
  return { socket: { fingerprint: 'fixture', path: socketPath, device: 0, inode: 0 }, socketPath, pane };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('pane socket did not reach the expected state');
}

async function openPane(fixture: Awaited<ReturnType<typeof fixtureSession>>, pane?: string) {
  const socket = fixture.socket;
  const agent = { id: 'agent-1', pane: { paneId: pane ?? fixture.pane, sessionId: 'fixture:fixture', socketFingerprint: 'fixture' }, home: '/repo', title: 'Ready', kind: 'claude', attention: 'finished' };
  const target = async (id: string) => (id === 'agent-1' ? { agent, socket } : undefined);
  const discovery = { target, snapshotTarget: target, worktreesNow: () => [] } as never;
  const port = await freePort();
  const tickets = new TicketStore();
  const app = await buildApp(
    testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
    { auth, control, dashboardUpdates, discovery, tickets, tmux: new TmuxAdapter(), paneStream: new PaneStreamRegistry() } as never
  );
  openApps.push(app);
  await app.listen({ host: '127.0.0.1', port });
  const ticket = tickets.mint('session', 'pane', 'agent-1').id;
  const query = pane === undefined ? '' : `?pane=${encodeURIComponent(pane)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/agent-1${query}`, ['rac', ticket]);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);
  const frames: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];
  let closeCode: number | undefined;
  ws.addEventListener('message', event => {
    const data = (event as MessageEvent).data;
    if (typeof data === 'string') frames.push(JSON.parse(data) as Record<string, unknown>);
    else { const chunk = Buffer.from(data as ArrayBuffer); binary.push(chunk); ws.send(JSON.stringify({ type: 'ack', bytes: chunk.length })); }
  });
  ws.addEventListener('close', event => { closeCode = (event as CloseEvent).code; });
  await new Promise<void>((resolve) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('close', () => resolve()); });
  return {
    frames,
    binary,
    closeCode: () => closeCode,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    seedText: () => Buffer.concat(binary).toString('utf8')
  };
}

const encode = (data: string) => Buffer.from(data, 'utf8').toString('base64url');

describe.skipIf(!tmuxSocketsWork)('/ws/pane (real tmux)', () => {
  beforeAll(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('sends the size then a seed reproducing the live pane', async () => {
    const fixture = await fixtureSession();
    expect((await run(tmux, ['-S', fixture.socketPath, 'send-keys', '-t', fixture.pane, '-l', 'seeded line'])).code).toBe(0);
    const conn = await openPane(fixture);
    conn.send({ type: 'viewport', cols: 80, rows: 24, scrollback: 200 });
    await eventually(() => conn.frames.some(frame => frame.type === 'size') && conn.binary.length > 0);
    expect(conn.frames.find(frame => frame.type === 'size')).toEqual({ type: 'size', cols: 80, rows: 24 });
    expect(conn.seedText()).toContain('seeded line');
  });

  it('echoes typed input back as raw bytes and resizes the pane to the viewport', async () => {
    const fixture = await fixtureSession();
    const conn = await openPane(fixture);
    conn.send({ type: 'viewport', cols: 70, rows: 20, scrollback: 200 });
    await eventually(() => conn.frames.some(frame => frame.type === 'size'));
    // the pane was resized to the browser's grid
    const geometry = await run(tmux, ['-S', fixture.socketPath, 'display-message', '-p', '-t', fixture.pane, '#{pane_width}x#{pane_height}']);
    expect(geometry.stdout.trim()).toBe('70x20');

    const before = conn.binary.length;
    conn.send({ type: 'input', data: encode('typed!') });
    await eventually(() => conn.binary.slice(before).some(chunk => chunk.toString('utf8').includes('typed!')));
    expect((await run(tmux, ['-S', fixture.socketPath, 'capture-pane', '-p', '-t', fixture.pane])).stdout).toContain('typed!');
  });

  it('ends the stream with "pane closed" when the pane is killed', async () => {
    const fixture = await fixtureSession();
    // a second pane so killing the streamed pane leaves the session (and window) alive,
    // emitting %layout-change rather than ending the whole session
    expect((await run(tmux, ['-S', fixture.socketPath, 'split-window', '-t', fixture.pane, '-d', 'cat'])).code).toBe(0);
    const conn = await openPane(fixture);
    conn.send({ type: 'viewport', cols: 80, rows: 24, scrollback: 200 });
    await eventually(() => conn.frames.some(frame => frame.type === 'size'));

    expect((await run(tmux, ['-S', fixture.socketPath, 'kill-pane', '-t', fixture.pane])).code).toBe(0);
    await eventually(() => conn.frames.some(frame => frame.type === 'exit' && frame.reason === 'pane closed'));
    await eventually(() => conn.closeCode() !== undefined);
  });
});
