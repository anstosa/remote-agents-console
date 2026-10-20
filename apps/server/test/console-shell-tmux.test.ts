import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp as mkdtempAsync, realpath, rm as rmAsync } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketStore } from '../src/auth/tickets.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { PaneStreamRegistry } from '../src/tmux/control.js';
import { LaunchService } from '../src/launch/service.js';
import { run } from '../src/tmux/command.js';
import { interactiveShellName, interactiveShellPath } from '../src/tmux/interactive-shell.js';
import type { SocketRef, Worktree } from '../src/domain/models.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { worktreePlace } from '../src/places/places.js';

// The Console-shell lifecycle against a throwaway tmux server on a private socket: the adapter
// creating a marked shell window, the markers showing in a real `list-panes`, a rename writing
// them back, the busy check reading a real foreground command, and the Worktree pane socket
// streaming a Console shell end to end (seed, byte echo, End -> exit). Unix sockets are blocked
// in the build sandbox, so this is skipped there and runs on the host and in CI.

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

// choose a supported login shell: configured, current, then common system paths
// a missing shell dies immediately and leaves every Console shell dead
const loginShell = [process.env.RAC_INTERACTIVE_SHELL?.trim(), process.env.SHELL?.trim(), '/usr/bin/zsh', '/bin/bash'].find((path): path is string => path !== undefined && ['zsh', 'bash', 'fish'].includes(interactiveShellName(path)) && existsSync(path));

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

// a real tmux server on a private socket with one 80x24 window; the temp root doubles as the
// Worktree's on-disk identity (it exists, so tmux can `cd` into it and the shell's cwd matches).
// The socket is named `default` so the root can stand in for RAC_HOST_TMUX_DIR (bridgeToFixture).
async function fixtureSession(): Promise<{ socket: SocketRef; socketPath: string; session: string; worktreeDir: string }> {
  const root = await mkdtempAsync(join(tmpdir(), 'rac-console-shell-'));
  const socketPath = join(root, 'default');
  fixtures.push({ root, socket: socketPath });
  expect((await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', '-c', root, 'cat'])).code).toBe(0);
  return { socket: { fingerprint: 'fixture', path: socketPath, device: 0, inode: 0 }, socketPath, session: 'fixture', worktreeDir: root };
}

// mirror production's Place membership marker
async function markFixturePlace(fixture: { socketPath: string; session: string }, placeId: string): Promise<void> {
  expect((await run(tmux, ['-S', fixture.socketPath, 'set-option', '-t', fixture.session, '@rac_place', placeId])).code).toBe(0);
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
  throw new Error('the pane socket did not reach the expected state');
}

const encode = (data: string) => Buffer.from(data, 'utf8').toString('base64url');

// open a Worktree pane socket against the given member pane, acking every binary frame
async function openWorktreePane(socket: SocketRef, worktree: Worktree, member: { paneId: string; sessionId: string }) {
  const discovery = { target: async () => undefined, snapshotTarget: async () => undefined, worktreesNow: () => [worktree] } as never;
  const launch = { placePanes: async () => [{ paneId: member.paneId, sessionId: member.sessionId, pid: 1, path: worktree.identity, command: 'cat', title: '', socket }] } as never;
  const port = await freePort();
  const tickets = new TicketStore();
  const app = await buildApp(
    testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
    { auth, control, dashboardUpdates, discovery, launch, tickets, tmux: new TmuxAdapter(), paneStream: new PaneStreamRegistry() } as never
  );
  openApps.push(app);
  await app.listen({ host: '127.0.0.1', port });
  const ticket = tickets.mint('session', 'pane', worktree.id).id;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${encodeURIComponent(worktree.id)}?pane=${encodeURIComponent(member.paneId)}`, ['rac', ticket]);
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
  return { frames, binary, closeCode: () => closeCode, send: (frame: unknown) => ws.send(JSON.stringify(frame)), text: () => Buffer.concat(binary).toString('utf8') };
}

// Make the fixture server the console's own tmux socket for a LaunchService built afterwards. A
// launch's own-socket commands (a new session, the free-name check) otherwise carry no `-S` and,
// with the console's stripped environment, reach the operator's real default tmux server.
const bridgeToFixture = (fixture: { worktreeDir: string }) => vi.stubEnv('RAC_HOST_TMUX_DIR', fixture.worktreeDir);

describe.skipIf(!tmuxSocketsWork || loginShell === undefined)('Console shells (real tmux)', () => {
  beforeAll(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); vi.stubEnv('RAC_INTERACTIVE_SHELL', loginShell!); });
  afterEach(() => { vi.stubEnv('RAC_HOST_TMUX_DIR', undefined); });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('opens a Console shell beside a session with both markers, renames it, and reads the busy state', async () => {
    const fixture = await fixtureSession();
    const worktree = testWorktree({ id: 'proj:wt', projectId: 'proj', path: fixture.worktreeDir, identity: fixture.worktreeDir, main: false });
    await markFixturePlace(fixture, worktree.id);
    const launch = new LaunchService(testConfig() as never, { find: async () => [fixture.socket] }, new TmuxAdapter(), undefined, undefined, () => [worktree], () => new Set(), async () => ({ socket: fixture.socket, session: fixture.session }));

    // created beside the fixture session, it is a login shell in the Worktree, marked and named
    const pane = await launch.createConsoleShell(worktreePlace(worktree), 'build');
    expect(pane).toMatch(/^%\d+$/);
    const shells = await launch.placeConsoleShells(worktree);
    expect(shells).toHaveLength(1);
    expect(shells[0]!.paneId).toBe(pane);
    expect(shells[0]!.role).toBe('shell');
    expect(shells[0]!.paneName).toBe('build');
    // an idle login shell is not busy
    expect(launch.consoleShellBusy(shells[0]!)).toBe(false);

    // a rename writes the option and a fresh listing reflects it; an empty name clears it
    expect(await new TmuxAdapter().renamePaneName(fixture.socket, pane!, 'tests')).toBe(true);
    expect((await launch.placeConsoleShells(worktree))[0]!.paneName).toBe('tests');
    expect(await new TmuxAdapter().renamePaneName(fixture.socket, pane!, '')).toBe(true);
    expect((await launch.placeConsoleShells(worktree))[0]!.paneName).toBeUndefined();

    // a shell whose foreground command is not the login shell reads as busy
    const busyPane = await new TmuxAdapter().createConsoleShellWindow(fixture.socket, fixture.session, fixture.worktreeDir, ['cat'], '');
    const busyShell = (await launch.placeConsoleShells(worktree)).find(shell => shell.paneId === busyPane);
    expect(busyShell).toBeDefined();
    expect(launch.consoleShellBusy(busyShell!)).toBe(true);
  });

  it('streams a Console shell over the Worktree pane socket, echoes input, and ends on kill', async () => {
    const fixture = await fixtureSession();
    const worktree = testWorktree({ id: 'proj:wt', projectId: 'proj', path: fixture.worktreeDir, identity: fixture.worktreeDir, main: false });
    // a marked shell running `cat` so typed bytes echo back
    const pane = await new TmuxAdapter().createConsoleShellWindow(fixture.socket, fixture.session, fixture.worktreeDir, ['cat'], 'logs');
    expect(pane).toMatch(/^%\d+$/);
    const sessionId = (await run(tmux, ['-S', fixture.socketPath, 'display-message', '-p', '-t', pane!, '#{session_id}'])).stdout.trim();

    const conn = await openWorktreePane(fixture.socket, worktree, { paneId: pane!, sessionId });
    conn.send({ type: 'viewport', cols: 80, rows: 24, scrollback: 200 });
    await eventually(() => conn.frames.some(frame => frame.type === 'size') && conn.binary.length > 0);
    expect(conn.frames.find(frame => frame.type === 'size')).toEqual({ type: 'size', cols: 80, rows: 24 });

    const before = conn.binary.length;
    conn.send({ type: 'input', data: encode('console!') });
    await eventually(() => conn.binary.slice(before).some(chunk => chunk.toString('utf8').includes('console!')));

    // ending the shell closes the stream with "pane closed"
    expect((await run(tmux, ['-S', fixture.socketPath, 'kill-pane', '-t', pane!])).code).toBe(0);
    await eventually(() => conn.frames.some(frame => frame.type === 'exit' && frame.reason === 'pane closed'));
  });

  it('ends the stream with "pane closed" when the shell exits on its own, not only when killed', async () => {
    const fixture = await fixtureSession();
    const worktree = testWorktree({ id: 'proj:wt', projectId: 'proj', path: fixture.worktreeDir, identity: fixture.worktreeDir, main: false });
    // A shell that exits on its own (not kill-pane), the exact path a real Console shell hits
    // when the operator types `exit` or Ctrl+D. It blocks on `read` until we send a line, so it
    // stays alive until the socket has subscribed and the close can never race the seed. This is
    // the end-to-end companion to the parser unit test that pins the notification mapping
    // (control-protocol.test.ts): the whole chain must still end the stream, where before the fix
    // the panel lingered.
    const pane = await new TmuxAdapter().createConsoleShellWindow(fixture.socket, fixture.session, fixture.worktreeDir, ['/bin/sh', '-c', 'read line; exit 0'], 'ephemeral');
    expect(pane).toMatch(/^%\d+$/);
    const sessionId = (await run(tmux, ['-S', fixture.socketPath, 'display-message', '-p', '-t', pane!, '#{session_id}'])).stdout.trim();

    const conn = await openWorktreePane(fixture.socket, worktree, { paneId: pane!, sessionId });
    conn.send({ type: 'viewport', cols: 80, rows: 24, scrollback: 200 });
    await eventually(() => conn.frames.some(frame => frame.type === 'size'));

    // send a line so the shell's `read` returns and it exits, closing its background window; tmux
    // reports that as %unlinked-window-close and the viewer must end the stream, not linger
    conn.send({ type: 'input', data: encode('\n') });
    await eventually(() => conn.frames.some(frame => frame.type === 'exit' && frame.reason === 'pane closed'));
  });

  it('joins the session holding the Console shells when a later Launch finds no idle shell', async () => {
    const fixture = await fixtureSession();
    const worktree = testWorktree({ id: 'proj:wt', projectId: 'proj', path: fixture.worktreeDir, identity: fixture.worktreeDir, main: false });
    await markFixturePlace(fixture, worktree.id);
    // a marked Console shell in the fixture session, and no adoptable idle shell (the fixture's
    // own pane runs `cat`, not the login shell), so the launch must join this session
    const shell = await new TmuxAdapter().createConsoleShellWindow(fixture.socket, fixture.session, fixture.worktreeDir, [interactiveShellPath(), '-l'], '');
    expect(shell).toMatch(/^%\d+$/);
    const windowIds = async () => (await run(tmux, ['-S', fixture.socketPath, 'list-windows', '-t', fixture.session, '-F', '#{window_id}'])).stdout.trim().split('\n').filter(Boolean);
    const before = (await windowIds()).length;

    const store = { rememberLaunchProfile: async () => {}, launchProfiles: async () => ({}) } as never;
    const config = testConfig({ adapters: { codex: { program: '/bin/echo', args: [], env: {}, launchable: true } } } as never);
    bridgeToFixture(fixture);
    const launch = new LaunchService(config as never, { find: async () => [fixture.socket] }, new TmuxAdapter(), undefined, store, () => [worktree], () => new Set());

    expect(await launch.launch(worktree.id)).toBe(true);

    // the launch added a window to the shells' session rather than opening a new session
    expect((await windowIds()).length).toBe(before + 1);
  });

  // A directory-Project or Scratch launch joins its Place the way a Worktree launch does. The
  // fixture pane runs `cat`, so there is no adoptable shell; the launched window's bootstrap leaves
  // an interactive shell behind, so the window stays to read its label from.
  for (const kind of ['directory', 'scratch'] as const) {
    it(`joins the session holding a ${kind} Place's Console shells and labels the launched pane`, async () => {
      const fixture = await fixtureSession();
      const home = await realpath(fixture.worktreeDir);
      await markFixturePlace(fixture, `${kind === 'directory' ? 'notes' : 'scratch'}:${home}`);
      expect(await new TmuxAdapter().createConsoleShellWindow(fixture.socket, fixture.session, home, [interactiveShellPath(), '-l'], '')).toMatch(/^%\d+$/);
      const windowIds = async () => (await run(tmux, ['-S', fixture.socketPath, 'list-windows', '-t', fixture.session, '-F', '#{window_id}'])).stdout.trim().split('\n').filter(Boolean);
      const before = await windowIds();

      const store = { rememberLaunchProfile: async () => {}, launchProfiles: async () => ({}) } as never;
      const notes = testProject({ id: 'notes', label: 'Notes', mode: 'directory', path: home, identity: home });
      const config = testConfig({ adapters: { codex: { program: '/bin/echo', args: [], env: {}, launchable: true } }, ...(kind === 'directory' ? { projects: [notes] } : { projects: [], scratchDirectory: home }) } as never);
      bridgeToFixture(fixture);
      const launch = new LaunchService(config as never, { find: async () => [fixture.socket] }, new TmuxAdapter(), undefined, store, () => [], () => new Set());

      expect(kind === 'directory' ? await launch.launchProjectDirectory('notes') : await launch.launchHome()).toBe(true);

      // a window in the shells' session rather than a new session, labelled with the Place
      const after = await windowIds();
      expect(after).toHaveLength(before.length + 1);
      const added = after.find(id => !before.includes(id))!;
      const label = (await run(tmux, ['-S', fixture.socketPath, 'display-message', '-p', '-t', added, '#{@rac_display_label}'])).stdout.trim();
      expect(label).toBe(kind === 'directory' ? 'Notes' : '~ Scratch');
      expect((await run(tmux, ['-S', fixture.socketPath, 'list-sessions', '-F', '#{session_name}'])).stdout.trim().split('\n')).toEqual([fixture.session]);
    });
  }
});
