import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from '../src/discovery/service.js';
import { LaunchService } from '../src/launch/service.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';
import { connectHolder, type LineChannel } from '../src/transports/structured.js';
import type { SocketRef } from '../src/domain/models.js';
import { adhocScratchPlace } from '../src/places/places.js';
import { processInspector, socketFinder } from './helpers/discovery-stubs.js';
import { testConfig } from './helpers/config.js';

// The holder (ADR 0016) under a throwaway tmux server on a private socket: a launch opens its
// tagged window in the Place's Workspace session, lines pass through it both ways, unread lines
// are replayed to the next connection, and discovery never lists the held process as a Terminal
// or an Agent. Unix sockets are blocked in the build sandbox, so this is skipped there and runs
// on the host and in CI.

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
const tmuxSocketsWork = (() => {
  if (tmux === '' || process.platform !== 'linux') return false;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'rac-holder-probe-'));
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

// a child that echoes each line back after `delayMs`, and exits on `exit`
const echo = (delayMs: number) => ({ program: process.execPath, env: {}, args: ['-e', `let rest = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { rest += chunk; let end; while ((end = rest.indexOf('\\n')) !== -1) { const line = rest.slice(0, end); rest = rest.slice(end + 1); if (line === 'exit') { console.error('echo: bye'); process.exit(3); } setTimeout(() => process.stdout.write(line + '\\n'), ${delayMs}); } });`] });

// a tmux server with one session marked as an ad-hoc Scratch Place's Workspace, and a launch
// service that joins it
async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-holder-')));
  const socketPath = join(root, 'tmux');
  roots.push({ root, socket: socketPath });
  const place = adhocScratchPlace(root);
  expect((await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'work', '-x', '80', '-y', '24', '-c', root, 'cat'])).code).toBe(0);
  expect((await run(tmux, ['-S', socketPath, 'set-option', '-t', 'work', '@rac_place', place.id])).code).toBe(0);
  const socket: SocketRef = { fingerprint: 'work', path: socketPath, device: 0, inode: 0 };
  const panes = new TmuxAdapter();
  const launch = new LaunchService(testConfig(), socketFinder([socket]), panes, undefined, undefined, () => [], () => new Set(), async () => ({ socket, session: 'work' }), join(root, 'private'));
  return { root, place, socket, socketPath, launch, panes };
}

const nextLine = (lines: string[], channel: LineChannel) => new Promise<string>((resolve, reject) => {
  if (lines.length > 0) { resolve(lines.shift()!); return; }
  const timer = setTimeout(() => reject(new Error('no line within 5 s')), 5_000);
  const poll = setInterval(() => { if (lines.length > 0) { clearTimeout(timer); clearInterval(poll); resolve(lines.shift()!); } }, 20);
  channel.onClose(() => { clearTimeout(timer); clearInterval(poll); reject(new Error('closed')); });
});
async function connect(socket: string, from = 0): Promise<{ channel: LineChannel; lines: string[]; dropped: number; closed: Promise<void> }> {
  const connected = await connectHolder(socket, { from });
  expect(connected).toBeDefined();
  const lines: string[] = [];
  connected!.channel.onLine(line => lines.push(line));
  const closed = new Promise<void>(resolve => connected!.channel.onClose(resolve));
  channels.push(connected!.channel);
  return { channel: connected!.channel, lines, dropped: connected!.hello.dropped, closed };
}

describe.skipIf(!tmuxSocketsWork)('the holder in a Workspace session', () => {
  beforeAll(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); });
  afterAll(() => { vi.unstubAllEnvs(); });
  it('passes lines through both ways and replays every line past the cursor a connection brings', async () => {
    const { place, launch } = await workspace();
    const holder = await launch.openHolderWindow(place, 'agent-1', echo(300));
    expect(holder).toBeDefined();

    const first = await connect(holder!.socket);
    first.channel.send('{"type":"ping","text":"a\u2028b"}');
    expect(await nextLine(first.lines, first.channel)).toBe('{"type":"ping","text":"a\u2028b"}');

    // the echo arrives after this connection is gone: a connection that read one line gets the rest
    first.channel.send('while away');
    first.channel.close();
    await new Promise(resolve => setTimeout(resolve, 600));
    const second = await connect(holder!.socket, 1);
    expect(second.dropped).toBe(0);
    expect(await nextLine(second.lines, second.channel)).toBe('while away');
    second.channel.close();
    // a connection that read nothing gets every line the holder kept, in order
    const third = await connect(holder!.socket, 0);
    expect(await nextLine(third.lines, third.channel)).toBe('{"type":"ping","text":"a\u2028b"}');
    expect(await nextLine(third.lines, third.channel)).toBe('while away');
  });

  it('keeps the window after its child exits, with the child\'s stderr, and ends the connection', async () => {
    const { place, launch, socketPath } = await workspace();
    const holder = await launch.openHolderWindow(place, 'agent-2', echo(0));
    const connected = await connect(holder!.socket);
    connected.channel.send('exit');
    await connected.closed;
    await new Promise(resolve => setTimeout(resolve, 200));

    const dead = await run(tmux, ['-S', socketPath, 'display-message', '-p', '-t', holder!.pane, '#{pane_dead} #{pane_dead_status} #{@rac_role}']);
    expect(dead.stdout.trim()).toBe('1 3 holder');
    expect(await launch.captureHolder(holder!)).toContain('echo: bye');

    await launch.closeHolder(holder!);
    expect((await run(tmux, ['-S', socketPath, 'list-panes', '-a', '-F', '#{pane_id}'])).stdout).not.toContain(holder!.pane);
  });

  it('never lists the held process as a Terminal or as an Agent', async () => {
    const { place, launch, socket, panes } = await workspace();
    const holder = await launch.openHolderWindow(place, 'agent-3', echo(0));
    await connect(holder!.socket);

    expect((await launch.placePanes(place)).map(pane => pane.paneId)).not.toContain(holder!.pane);
    expect((await launch.placePanes(place)).length).toBe(1);
    // every pane's process reads as an Agent here, so only the holder's role keeps it out
    const discovery = new DiscoveryService(socketFinder([socket]), panes, processInspector());
    const agents = await discovery.refresh(true);
    expect(agents.map(agent => agent.pane?.paneId)).not.toContain(holder!.pane);
    expect(agents).toHaveLength(1);
  });
});
