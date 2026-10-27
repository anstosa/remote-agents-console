import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp as mkdtempAsync, lstat, readFile, writeFile, rm as rmAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SocketRef } from '../src/domain/models.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';
import { TmuxCommandRegistry } from '../src/tmux/command-registry.js';
import { PaneStreamRegistry, TmuxControlClient } from '../src/tmux/control.js';

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();

// The control client needs a real tmux server on a private unix socket. That runs on
// the host and in CI, but the build sandbox blocks unix sockets, so probe once and
// skip cleanly there rather than fail (the effort records the host run separately).
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

const fixtures: Array<{ root: string; socket: string }> = [];

afterEach(async () => {
  for (const { root, socket } of fixtures.splice(0)) {
    await run(tmux, ['-S', socket, 'kill-server']).catch(() => undefined);
    await rmAsync(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// a fixture session with one pane running `cat`, whose tty echoes every typed byte as
// %output, so typing is observable both as pane activity and in a capture
async function fixtureSession(): Promise<{ ref: SocketRef; socket: string; pane: string }> {
  const root = await mkdtempAsync(join(tmpdir(), 'rac-control-'));
  const socket = join(root, 'tmux.sock');
  fixtures.push({ root, socket });
  expect((await run(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', 'cat'])).code).toBe(0);
  const paneOut = await run(tmux, ['-S', socket, 'display-message', '-p', '-t', 'fixture', '#{pane_id}']);
  const pane = paneOut.stdout.trim();
  expect(pane).toMatch(/^%\d+$/);
  const info = await lstat(socket);
  return { ref: { path: socket, fingerprint: 'fixture', device: info.dev, inode: info.ino }, socket, pane };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('control client did not reach the expected state');
}

describe.skipIf(!tmuxSocketsWork)('tmux control client (real tmux)', () => {
  // TmuxAdapter and PaneStreamRegistry resolve the binary from the env; on the host tmux
  // lives under mise, not /usr/bin/tmux, so point them at the probed binary
  beforeAll(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); });
  afterAll(() => { vi.unstubAllEnvs(); });

  // the hot dashboard path creates one client, not one process per tick
  it('lists repeatedly without viewers, streaming output, or changing session environment', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const root = fixtures.at(-1)!.root;
    const wrapper = join(root, 'tmux');
    const calls = join(root, 'calls');
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${tmux}' "$@"\n`, { mode: 0o700 });
    vi.stubEnv('RAC_TMUX_BIN', wrapper);
    const adapter = new TmuxAdapter(new TmuxCommandRegistry());
    const viewers = new PaneStreamRegistry();
    try {
      await run(tmux, ['-S', socket, 'set-environment', '-t', 'fixture', 'DISPLAY', 'keep-me']);
      await run(tmux, ['-S', socket, 'select-pane', '-t', pane, '-T', 'café ☕']);
      // repeated fresh reads still produce exactly one client process
      for (let tick = 0; tick < 20; tick += 1) expect(await adapter.listPanes(ref)).toMatchObject([{ paneId: pane, title: 'café ☕', dead: false }]);
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect((await readFile(calls, 'utf8'))).toContain('-N -C attach-session -E');
      const flags = (await run(tmux, ['-S', socket, 'list-clients', '-F', '#{client_flags}'])).stdout;
      expect(flags).toContain('no-output');
      expect(flags).toContain('ignore-size');
      expect(await adapter.size(ref, pane)).toEqual({ cols: 80, rows: 24 });
      expect((await run(tmux, ['-S', socket, 'show-environment', '-t', 'fixture', 'DISPLAY'])).stdout.trim()).toBe('DISPLAY=keep-me');
      // browser subscribers keep a separate lifecycle and terminal membership
      expect(viewers.openPaneKeys().size).toBe(0);
      const viewer = viewers.get(ref, 'fixture');
      const unsubscribe = viewer.subscribe(pane, { onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      await viewer.ready;
      unsubscribe();
      expect(viewers.size).toBe(0);
      expect(await adapter.listPanes(ref)).toHaveLength(1);
      // closing the bootstrap session moves the command client to a surviving session
      await run(tmux, ['-S', socket, 'new-session', '-d', '-s', 'survivor', 'cat']);
      await run(tmux, ['-S', socket, 'kill-session', '-t', 'fixture']);
      expect(await adapter.listPanes(ref)).toMatchObject([{ sessionName: 'survivor' }]);
    } finally {
      adapter.closeCommands();
      viewers.closeAll();
      vi.stubEnv('RAC_TMUX_BIN', tmux);
    }
  });

  // a dashboard-only observer must not block spawned launch or prompt submission
  it('submits pasted input when the dashboard connection is the only attached client', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const adapter = new TmuxAdapter(new TmuxCommandRegistry());
    try {
      await adapter.listPanes(ref);
      const clients = (await run(tmux, ['-S', socket, 'list-clients', '-F', '#{client_flags}'])).stdout.trim().split('\n');
      expect(clients).toHaveLength(1);
      expect(clients[0]).toContain('no-output');
      expect(await adapter.pastePrompt(ref, pane, 'rac-launch-client-test', 'launch submission')).toBe(true);
      expect(await adapter.enter(ref, pane)).toBe(true);
      // cat echoes the line only after receiving Enter
      await expect.poll(async () => (await run(tmux, ['-S', socket, 'capture-pane', '-p', '-t', pane])).stdout.match(/launch submission/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      adapter.closeCommands();
    }
  });

  // socket loss falls back on the same call, then a later tick reconnects
  it('falls back after client loss and reconnects without a browser', async () => {
    const { ref, socket } = await fixtureSession();
    const registry = new TmuxCommandRegistry();
    const adapter = new TmuxAdapter(registry);
    try {
      expect(await adapter.listPanes(ref)).toHaveLength(1);
      const name = (await run(tmux, ['-S', socket, 'list-clients', '-F', '#{client_name}'])).stdout.trim();
      await run(tmux, ['-S', socket, 'detach-client', '-t', name]);
      // the same request falls back after the client exits
      expect(await adapter.listPanes(ref)).toHaveLength(1);
      // backoff uses a one-shot command, not a new control connection
      expect(await adapter.listPanes(ref)).toHaveLength(1);
      expect((await run(tmux, ['-S', socket, 'list-clients'])).stdout.trim()).toBe('');
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 5_001);
      expect(await adapter.listPanes(ref)).toHaveLength(1);
      expect((await run(tmux, ['-S', socket, 'list-clients', '-F', '#{client_flags}'])).stdout).toContain('no-output');
    } finally { vi.restoreAllMocks(); adapter.closeCommands(); }
  });

  // a socket replacement must not inherit the previous server's pane identities
  it('rejects stale socket identities and discovers a replacement server', async () => {
    const { ref, socket } = await fixtureSession();
    const adapter = new TmuxAdapter(new TmuxCommandRegistry());
    try {
      expect(await adapter.listPanes(ref)).toHaveLength(1);
      await run(tmux, ['-S', socket, 'kill-server']);
      await run(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'replacement', 'cat']);
      const info = await lstat(socket);
      const replacement = { ...ref, fingerprint: 'replacement', device: info.dev, inode: info.ino };
      // model an old identity even if the filesystem happened to recycle its inode
      expect(await adapter.listPanes({ ...ref, inode: info.ino + 1 })).toEqual([]);
      adapter.retainSockets([replacement]);
      expect(await adapter.listPanes(replacement)).toMatchObject([{ sessionName: 'replacement' }]);
    } finally { adapter.closeCommands(); }
  });

  // attach errors reject readiness instead of publishing a usable connection
  it('rejects a failed attach', async () => {
    const { ref } = await fixtureSession();
    const gone = vi.fn();
    const client = new TmuxControlClient(tmux, ref.path, 'missing', gone, { commandOnly: true });
    try { await expect(client.ready).rejects.toThrow(); expect(gone).toHaveBeenCalledOnce(); }
    finally { client.dispose(); }
  });

  // an unresponsive socket cannot hold dashboard refreshes indefinitely
  it('times out and disposes an attach that never answers', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'rac-control-stalled-'));
    const socket = join(root, 'sock');
    const peers: import('node:net').Socket[] = [];
    const server = createServer(peer => { peers.push(peer); });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const gone = vi.fn();
    const client = new TmuxControlClient(tmux, socket, undefined, gone, { commandOnly: true, timeoutMs: 100 });
    try {
      await expect(client.ready).rejects.toThrow('disposed');
      expect(gone).toHaveBeenCalledOnce();
      await expect(client.command('list-panes')).rejects.toThrow('disposed');
    } finally {
      client.dispose();
      // release accepted peers before closing the fixture server
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rmAsync(root, { recursive: true, force: true });
    }
  });

  it('arms activity on %output and captures the pane on the same connection', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let activity = 0;
      client.subscribe(pane, { onActivity: () => { activity += 1; }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });

      // typing into the pane echoes through the tty, producing %output
      expect((await run(tmux, ['-S', socket, 'send-keys', '-t', pane, '-l', 'hello'])).code).toBe(0);
      await eventually(() => activity > 0);

      // the same connection can capture the pane; it shows the echoed text
      const captured = await client.capture(pane, 100);
      expect(captured).toContain('hello');

      // an idle pane produces no further activity
      const settled = activity;
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(activity).toBe(settled);
    } finally {
      client.dispose();
    }
  });

  it('reconstructs the same bytes a spawned capture-pane produces', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let ready = false;
      // subscribe before typing so the echo's %output is not missed
      client.subscribe(pane, { onActivity: () => { ready = true; }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      expect((await run(tmux, ['-S', socket, 'send-keys', '-t', pane, '-l', 'café ☕'])).code).toBe(0);
      await eventually(() => ready);

      const overControl = await client.capture(pane, 100);
      const spawned = await run(tmux, ['-S', socket, 'capture-pane', '-e', '-p', '-t', pane, '-S', '-100']);
      // the control path must reproduce the spawned stdout byte-for-byte, trailing
      // newline included, so the shared line-slicing/bottom-alignment behaves identically
      expect(overControl).toBe(spawned.stdout);
      expect(overControl).toContain('café ☕');
    } finally {
      client.dispose();
    }
  });

  it('shares one client per session and reaps it when the last viewer leaves', async () => {
    const { ref, pane } = await fixtureSession();
    const registry = new PaneStreamRegistry();
    try {
      const first = registry.get(ref, 'fixture');
      const second = registry.get(ref, 'fixture');
      expect(second).toBe(first);
      expect(registry.size).toBe(1);

      const unsubscribeA = first.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      const unsubscribeB = second.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => {}, onExit: () => {} });

      unsubscribeA();
      expect(registry.size).toBe(1);

      unsubscribeB();
      expect(registry.size).toBe(0);
      // a later viewer of the same session gets a fresh client
      const reopened = registry.get(ref, 'fixture');
      expect(reopened).not.toBe(first);
      expect(registry.size).toBe(1);
    } finally {
      registry.closeAll();
    }
  });

  it('attaches as a control-mode client that does not clamp the pane size', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      // tmux flags our attach as control-mode; the adapter's client-limit read keys off
      // exactly that flag string
      const clients = await run(tmux, ['-S', socket, 'list-clients', '-t', pane, '-F', '#{client_flags}']);
      expect(clients.stdout).toContain('control-mode');

      // with only the control client attached, the pane keeps its own size (80x24 here)
      // rather than being clamped to a phantom viewport
      const geometry = await new TmuxAdapter().size(ref, pane);
      expect(geometry).toEqual({ cols: 80, rows: 24 });
    } finally {
      client.dispose();
    }
  });

  it('reads the id of the window holding a pane, so the Size claim is keyed by window', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      const expected = (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{window_id}'])).stdout.trim();
      expect(expected).toMatch(/^@\d+$/);
      expect(await client.windowId(pane)).toBe(expected);
    } finally {
      client.dispose();
    }
  });

  it('re-clamps on an external window resize (%layout-change)', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let resizes = 0;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => { resizes += 1; }, onExit: () => {} });
      // an external resize-window (as a zoom or an operator's resize does) emits %layout-change
      // to our control client, which re-asserts the Size claim
      expect((await run(tmux, ['-S', socket, 'resize-window', '-t', pane, '-x', '100', '-y', '30'])).code).toBe(0);
      await eventually(() => resizes > 0);
    } finally {
      client.dispose();
    }
  });

  it('re-asserts the Size claim when a pane is zoomed from an attached terminal', async () => {
    const { ref, socket, pane } = await fixtureSession();
    // a second pane so the window can be zoomed; zoom and unzoom both emit %layout-change
    expect((await run(tmux, ['-S', socket, 'split-window', '-t', pane, '-d', 'cat'])).code).toBe(0);
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let resizes = 0;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => { resizes += 1; }, onExit: () => {} });
      expect((await run(tmux, ['-S', socket, 'resize-pane', '-Z', '-t', pane])).code).toBe(0);
      await eventually(() => resizes > 0);
    } finally {
      client.dispose();
    }
  });

  it('re-clamps when an attached client resizes (the -B client-size subscription)', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    // A second control client, `-f ignore-size` so it never affects window-size and so emits
    // no %layout-change: every onResize below therefore comes from the client-size
    // subscription (%subscription-changed), isolating the -B path from the layout path.
    const second = spawn(tmux, ['-S', socket, '-C', 'attach-session', '-t', 'fixture', '-f', 'ignore-size']);
    try {
      await client.ready;
      let resizes = 0;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => { resizes += 1; }, onExit: () => {} });
      // let the subscription arm and the attach's own change settle, then drive one pure
      // client-size change; tmux pushes it through %subscription-changed at most once a second
      await new Promise(resolve => setTimeout(resolve, 1_100));
      resizes = 0;
      second.stdin?.write('refresh-client -C 200x60\n');
      await eventually(() => resizes > 0);
    } finally {
      second.stdin?.write('detach\n');
      second.kill('SIGTERM');
      client.dispose();
    }
  });

  it('streams a pane\'s bytes to onOutput and types bytes back byte-exact', async () => {
    const { ref, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      const chunks: Buffer[] = [];
      // subscribe for raw bytes; `cat` echoes each typed byte back through its tty as %output
      client.subscribe(pane, { onOutput: bytes => { chunks.push(bytes); }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      expect(await client.sendInput(pane, Buffer.from('café ☕'))).toBe(true);
      await eventually(() => Buffer.concat(chunks).toString('utf8').includes('café ☕'));
      // and the same bytes land in the pane
      expect(await client.capture(pane, 100)).toContain('café ☕');
    } finally {
      client.dispose();
    }
  });

  // a copy in the pane (OSC 52 under `set-clipboard on`) reaches the viewer byte-exact; the
  // console's own `rac-*` prompt buffers never do
  it('forwards a pane copy to onClipboard but not the console\'s prompt buffers', async () => {
    const { ref, socket, pane } = await fixtureSession();
    expect((await run(tmux, ['-S', socket, 'set-option', '-s', 'set-clipboard', 'on'])).code).toBe(0);
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      const copies: string[] = [];
      client.subscribe(pane, { onClipboard: text => { copies.push(text); }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      expect((await run(tmux, ['-S', socket, 'load-buffer', '-b', 'rac-prompt', '-'], 'prompt text')).code).toBe(0);
      // `cat` writes the typed line back raw, so the pane itself emits the OSC 52
      const osc = `\x1b]52;c;${Buffer.from('yanked line\n').toString('base64')}\x07\r`;
      expect(await client.sendInput(pane, Buffer.from(osc))).toBe(true);
      await eventually(() => copies.length > 0);
      expect(copies).toEqual(['yanked line\n']);
    } finally {
      client.dispose();
    }
  });

  // leave shared history modes before forwarding terminal input
  it('exits copy mode before forwarding one raw Enter', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      expect((await run(tmux, ['-S', socket, 'send-keys', '-t', pane, '-l', 'raw draft'])).code).toBe(0);
      expect((await run(tmux, ['-S', socket, 'copy-mode', '-t', pane])).code).toBe(0);
      expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_mode}'])).stdout.trim()).toBe('copy-mode');

      expect(await client.sendInput(pane, Buffer.from('\r'))).toBe(true);

      await expect.poll(async () => (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_in_mode}'])).stdout.trim()).toBe('0');
      await expect.poll(async () => (await client.capture(pane, 100))?.match(/raw draft/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      client.dispose();
    }
  });

  // serialize mode recovery with consecutive raw input frames
  it('orders consecutive input while leaving copy mode', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      expect((await run(tmux, ['-S', socket, 'copy-mode', '-t', pane])).code).toBe(0);

      const first = client.sendInput(pane, Buffer.from('ordered '));
      const second = client.sendInput(pane, Buffer.from('input\r'));

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      await expect.poll(async () => (await client.capture(pane, 100))?.match(/ordered input/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      client.dispose();
    }
  });

  // keep command replies aligned around concurrent capture traffic
  it('keeps capture and input replies associated during mode recovery', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      expect((await run(tmux, ['-S', socket, 'copy-mode', '-t', pane])).code).toBe(0);

      const [sent, captured] = await Promise.all([
        client.sendInput(pane, Buffer.from('parallel')),
        client.capture(pane, 100)
      ]);

      expect(sent).toBe(true);
      expect(captured).toBeTypeOf('string');
      await expect.poll(async () => await client.capture(pane, 100)).toContain('parallel');
    } finally {
      client.dispose();
    }
  });

  // do not inject input into an unrelated tmux selector
  it('fails closed for a non-history pane mode', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      expect((await run(tmux, ['-S', socket, 'clock-mode', '-t', pane])).code).toBe(0);
      expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_mode}'])).stdout.trim()).toBe('clock-mode');

      expect(await client.sendInput(pane, Buffer.from('x'))).toBe(false);
      expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_mode}'])).stdout.trim()).toBe('clock-mode');
    } finally {
      client.dispose();
    }
  });

  // recover managed prompt delivery without changing a sibling pane's mode
  it('exits view mode on only the prompt target before paste and submit', async () => {
    const { ref, socket, pane } = await fixtureSession();
    expect((await run(tmux, ['-S', socket, 'split-window', '-d', '-t', pane, 'cat'])).code).toBe(0);
    const sibling = (await run(tmux, ['-S', socket, 'list-panes', '-t', 'fixture', '-F', '#{pane_id}'])).stdout.split('\n').find(id => id !== '' && id !== pane)!;
    expect((await run(tmux, ['-S', socket, 'run-shell', '-t', pane, "printf 'mode output\\n'"])).code).toBe(0);
    await expect.poll(async () => (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_mode}'])).stdout.trim()).toBe('view-mode');
    expect((await run(tmux, ['-S', socket, 'copy-mode', '-t', sibling])).code).toBe(0);
    const adapter = new TmuxAdapter();

    expect(await adapter.pastePrompt(ref, pane, 'rac-copy-mode-test', 'managed draft')).toBe(true);
    expect(await adapter.sendKeys(ref, pane, ['Enter'])).toBe(true);

    expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_in_mode}'])).stdout.trim()).toBe('0');
    expect((await run(tmux, ['-S', socket, 'display-message', '-p', '-t', sibling, '#{pane_mode}'])).stdout.trim()).toBe('copy-mode');
    await expect.poll(async () => (await run(tmux, ['-S', socket, 'capture-pane', '-p', '-t', pane])).stdout.match(/managed draft/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // restore the first input position after painting trailing blank rows
  it('reconstructs a normal-screen seed and restores its prompt cursor', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let seen = false;
      client.subscribe(pane, { onOutput: () => { /* observe prompt output */ seen = true; }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      expect((await run(tmux, ['-S', socket, 'send-keys', '-t', pane, '-l', 'hello seed'])).code).toBe(0);
      await eventually(() => seen);
      const seed = (await client.seed(pane, 100)).toString('latin1');
      // paint the capture then return to the first-row prompt
      const capture = await run(tmux, ['-S', socket, 'capture-pane', '-e', '-p', '-J', '-t', pane, '-S', '-100']);
      const cursor = await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{cursor_x} #{cursor_y}']);
      expect(cursor.stdout.trim()).toBe('10 0');
      const expected = `\x1b[H\x1b[2J${capture.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u).join('\r\n')}\x1b[0m\x1b[1;11H`;
      expect(seed).toBe(expected);
      expect(seed).toContain('hello seed');
    } finally {
      client.dispose();
    }
  });

  // capture-pane -e never resets the pen, so a seed must, or the program's next text inherits the last cell's style
  it('resets the pen after a seed whose last captured cell is underlined', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      expect(await client.sendInput(pane, Buffer.from('\x1b[4mUNDERLINED\n'))).toBe(true);
      await expect.poll(async () => (await run(tmux, ['-S', socket, 'capture-pane', '-e', '-p', '-t', pane])).stdout).toMatch(/\x1b\[4mUNDERLINED/u);
      const seed = (await client.seed(pane, 100)).toString('latin1');
      expect(seed).toContain('\x1b[4mUNDERLINED');
      // the final SGR the browser parses is a full reset, not the capture's underline
      expect([...seed.matchAll(/\x1b\[[\d;:]*m/gu)].at(-1)?.[0]).toBe('\x1b[0m');
    } finally {
      client.dispose();
    }
  });

  // preserve the live input protocol when a seed rebuilds xterm's parser state
  it('restores active mouse modes without inventing disabled modes', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      const mouseModes = '#{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_utf8_flag} #{mouse_sgr_flag}';
      const initial = (await client.seed(pane, 100)).toString('latin1');
      expect(initial).not.toMatch(/\x1b\[\?100[02356]h/u);

      // exercise the normal-buffer protocol and legacy coordinate encoding
      expect(await client.sendInput(pane, Buffer.from('\x1b[?1000h\x1b[?1005h\n'))).toBe(true);
      await expect.poll(async () => (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, mouseModes])).stdout.trim()).toBe('1 0 0 1 0');
      const standard = (await client.seed(pane, 100)).toString('latin1');
      expect(standard).toContain('\x1b[?1000h');
      expect(standard).toContain('\x1b[?1005h');
      expect(standard).not.toMatch(/\x1b\[\?100[236]h/u);

      // switch protocols rather than carrying stale reporting flags forward
      expect(await client.sendInput(pane, Buffer.from('\x1b[?1000l\x1b[?1005l\x1b[?1002h\n'))).toBe(true);
      await expect.poll(async () => (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, mouseModes])).stdout.trim()).toBe('0 1 0 0 0');
      const button = (await client.seed(pane, 100)).toString('latin1');
      expect(button).toContain('\x1b[?1002h');
      expect(button).not.toMatch(/\x1b\[\?100[0356]h/u);

      // disabling the final protocol must not create phantom reporting
      expect(await client.sendInput(pane, Buffer.from('\x1b[?1002l\n'))).toBe(true);
      await expect.poll(async () => (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, mouseModes])).stdout.trim()).toBe('0 0 0 0 0');
      expect((await client.seed(pane, 100)).toString('latin1')).not.toMatch(/\x1b\[\?100[02356]h/u);
    } finally {
      client.dispose();
    }
  });

  // verify cursor restoration without confusing tty echo with program output
  it('paints an alternate-screen seed with absolute positioning and the cursor restored', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let bytes = 0;
      client.subscribe(pane, { onOutput: chunk => { bytes += chunk.length; }, onReseed: () => {}, onResize: () => {}, onExit: () => {} });
      // submit the line so cat emits real escapes rather than only the tty's visible echo
      expect(await client.sendInput(pane, Buffer.from('\x1b[?1049h\x1b[?1003h\x1b[?1006hALT SCREEN\n'))).toBe(true);
      await eventually(() => bytes > 0);
      // wait for tmux to parse the screen, reporting protocol and coordinate encoding
      await expect.poll(async () => (await run(tmux, ['-S', socket, 'display-message', '-p', '-t', pane, '#{alternate_on} #{mouse_all_flag} #{mouse_sgr_flag}'])).stdout.trim()).toBe('1 1 1');
      const seed = (await client.seed(pane, 100)).toString('latin1');
      // enters the alt screen, clears, paints row one absolutely and restores the cursor
      expect(seed.startsWith('\x1b[?1049h\x1b[H\x1b[2J')).toBe(true);
      expect(seed).toContain('\x1b[1;1H');
      expect(seed).toContain('ALT SCREEN');
      expect(seed).toContain('\x1b[?1003h');
      expect(seed).toContain('\x1b[?1006h');
      expect(seed).toMatch(/\x1b\[\d+;\d+H$/u);
    } finally {
      client.dispose();
    }
  });

  it('ends subscribers when the tmux server goes away', async () => {
    const { ref, socket, pane } = await fixtureSession();
    const client = new TmuxControlClient(tmux, ref.path, 'fixture', () => {});
    try {
      await client.ready;
      let exitReason: string | undefined;
      client.subscribe(pane, { onActivity: () => {}, onReseed: () => {}, onResize: () => {}, onExit: reason => { exitReason = reason; } });
      await run(tmux, ['-S', socket, 'kill-server']);
      await eventually(() => exitReason !== undefined);
      // the server going away ends the client's child; the reason is one of the contract's strings
      expect(['session ended', 'control client lost']).toContain(exitReason);
    } finally {
      client.dispose();
    }
  });
});
