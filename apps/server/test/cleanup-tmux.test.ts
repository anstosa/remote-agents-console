import { existsSync } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';
import { TmuxControlClient } from '../src/tmux/control.js';

const binary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';

// verify the guarded close against a private tmux server, never the operator's socket
it.skipIf(!existsSync(binary))('rechecks output and active viewers without blocking on the RAC inventory client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rac-cleanup-tmux-'));
  const path = join(root, 'tmux');
  const clients: TmuxControlClient[] = [];
  // run commands against the isolated fixture
  const tmux = (...args: string[]) => run(binary, ['-S', path, ...args]);
  vi.stubEnv('RAC_TMUX_BIN', binary);
  try {
    expect((await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'orphan', '/bin/sh', '-c', 'printf "ready\\n"; exec /bin/cat')).code).toBe(0);
    expect((await tmux('new-session', '-d', '-s', 'other', '/bin/cat')).code).toBe(0);
    const { dev: device, ino: inode } = await lstat(path);
    const socket = { fingerprint: `${device}:${inode}`, path, device, inode };
    const adapter = new TmuxAdapter();
    // look up a live pane after tmux has processed its initial output
    const observe = async () => {
      const panes = await adapter.listPanes(socket);
      const candidate = panes.find(pane => pane.sessionName === 'orphan');
      expect(candidate?.cleanupActivity ?? '', JSON.stringify(panes)).toMatch(/^[pw][1-9]\d*$/u);
      return { ...candidate!, cleanupActivity: candidate!.cleanupActivity! };
    };
    // start isolated control clients with the same flags as the RAC transports
    const attach = async (session: string, commandOnly: boolean) => {
      const client = new TmuxControlClient(binary, path, session, () => { /* fixture owns disposal */ }, { commandOnly });
      clients.push(client);
      await client.ready;
      return client;
    };

    const initial = await vi.waitFor(observe);
    // legacy tmux reports window activity with one-second precision
    if (initial.cleanupActivity.startsWith('w')) {
      await vi.waitFor(() => expect(Math.floor(Date.now() / 1_000)).toBeGreaterThan(Number(initial.cleanupActivity.slice(1))), { timeout: 2_000 });
    }
    expect((await tmux('send-keys', '-t', initial.paneId, 'more output', 'Enter')).code).toBe(0);
    // the new output must invalidate the old observation
    await vi.waitFor(async () => {
      const candidate = await observe();
      expect(candidate.cleanupActivity).not.toBe(initial.cleanupActivity);
    });
    await expect(adapter.closeIdlePane(initial)).resolves.toBe(false);
    const current = await observe();
    // a socket replacement or shutdown must never inherit the observed pane
    await expect(adapter.closeIdlePane({ ...current, socket: { ...socket, inode: inode + 1 } })).resolves.toBe(false);
    const stopped = new TmuxAdapter();
    stopped.closeCommands();
    await expect(stopped.closeIdlePane(current)).resolves.toBe(false);

    // refuse a shared window even before anyone is attached to either session
    expect((await tmux('link-window', '-s', 'orphan:', '-t', 'other:1')).code).toBe(0);
    await expect(adapter.closeIdlePane(await observe())).resolves.toBe(false);
    expect((await tmux('unlink-window', '-t', 'other:1')).code).toBe(0);

    // keep panes in terminal modes and ones with current RAC ownership or input
    expect((await tmux('copy-mode', '-t', initial.paneId)).code).toBe(0);
    await expect(adapter.closeIdlePane(await observe())).resolves.toBe(false);
    expect((await tmux('copy-mode', '-q', '-t', initial.paneId)).code).toBe(0);
    for (const option of ['@rac_question', '@rac_review_run', '@rac_spawned_by']) {
      expect((await tmux('set-option', '-p', '-t', initial.paneId, option, 'present')).code).toBe(0);
      await expect(adapter.closeIdlePane(await observe())).resolves.toBe(false);
      expect((await tmux('set-option', '-pu', '-t', initial.paneId, option)).code).toBe(0);
    }

    await attach(initial.sessionId, true);
    await attach('other', false);
    const viewer = await attach(initial.sessionId, false);
    const withViewer = await observe();
    await expect(adapter.closeIdlePane(withViewer)).resolves.toBe(false);
    viewer.dispose();
    // let the server observe the viewer disconnect before retrying
    await vi.waitFor(async () => {
      const listed = await tmux('list-clients', '-F', '#{client_session}:#{client_flags}');
      const attachedToTarget = listed.stdout.split('\n').filter(line => line.startsWith('orphan:'));
      expect(attachedToTarget).toEqual([expect.stringContaining('no-output')]);
    });
    const confirmed = await observe();
    await expect(adapter.closeIdlePane(confirmed)).resolves.toBe(true);
    expect((await adapter.listPanes(socket)).map(pane => pane.sessionName)).toEqual(['other']);
  } finally {
    // dispose only clients and processes started by this test
    for (const client of clients) client.dispose();
    await tmux('kill-server').catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
