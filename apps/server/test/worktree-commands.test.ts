import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink as unlinkFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Worktree } from '../src/domain/models.js';
import { WorktreeCommandService } from '../src/worktree-commands/service.js';
import { run } from '../src/tmux/command.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

// mirror the service's tmux-safe worktree token: `<projectId>-<sha256(path)[0:12]>`
const worktreeToken = (projectId: string, path: string) => `${projectId}-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`;
const stackSession = (projectId: string, path: string) => `rac-stack-${worktreeToken(projectId, path)}-build-exclusive`;

const previousTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const previousTmuxBinary = process.env.RAC_TMUX_BIN;
const previousHostPath = process.env.RAC_HOST_PATH;
const previousHostWorkspace = process.env.RAC_HOST_WORKSPACE;
const worktree = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', hostPath: '/home/ubuntu/cora', pinned: false, commands: { build: 'docker compose build' } });
const config = testConfig();
const discovery = { worktreesNow: () => [worktree] };

let checkoutRoot: string | undefined;
// A Stack process Start in a made-up checkout warns that it starts without its log: the suites
// that start one keep those warnings quiet, and read them through what this returns.
function quietWarnings() {
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  beforeEach(() => { spy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { spy?.mockRestore(); });
  return () => spy!;
}

afterEach(async () => {
  // restore the host socket setting
  if (previousTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR;
  else process.env.RAC_HOST_TMUX_DIR = previousTmuxDirectory;
  // restore the host tmux client setting
  if (previousTmuxBinary === undefined) delete process.env.RAC_TMUX_BIN;
  else process.env.RAC_TMUX_BIN = previousTmuxBinary;
  // restore the host executable path setting
  if (previousHostPath === undefined) delete process.env.RAC_HOST_PATH;
  else process.env.RAC_HOST_PATH = previousHostPath;
  // restore the host workspace override
  if (previousHostWorkspace === undefined) delete process.env.RAC_HOST_WORKSPACE;
  else process.env.RAC_HOST_WORKSPACE = previousHostWorkspace;
  // clean only a created checkout fixture
  if (checkoutRoot !== undefined) { await rm(checkoutRoot, { recursive: true, force: true }); checkoutRoot = undefined; }
});

// A Project's preview for the tunnel check to fetch: healthy (200) or not (503), decided when a
// request arrives and answered after that state's delay, so a test can hold a check in flight.
async function projectPreview() {
  const state = { healthy: true, healthyDelayMs: 0, unhealthyDelayMs: 0, requests: 0 };
  const server = createServer((_request, response) => {
    state.requests += 1;
    const healthy = state.healthy;
    setTimeout(() => { response.statusCode = healthy ? 200 : 503; response.end(); }, healthy ? state.healthyDelayMs : state.unhealthyDelayMs);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return { url, state, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe('worktree stack commands', () => {
  it('reports the active operation until its tmux session exits', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    process.env.RAC_TMUX_BIN = '/host-tools/tmux';
    process.env.RAC_HOST_PATH = '/opt/operator/bin:/usr/bin:/bin';
    delete process.env.RAC_HOST_WORKSPACE;
    let active = true;
    let session = '';
    const binaries: string[] = [];
    const command = async (binary: string, args: string[]) => {
      binaries.push(binary);
      // capture the launched operation
      if (args.includes('new-session')) {
        session = args[args.indexOf('-s') + 1] ?? '';
        expect(args.at(-1)).toContain("export PATH='/opt/operator/bin:/usr/bin:/bin'");
        return { code: 0, stdout: '' };
      }
      // report the synthetic session state
      if (args.includes('has-session')) return { code: active ? 0 : 1, stdout: '' };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, discovery as never, command);

    await expect(service.run(worktree.id, 'build')).resolves.toBe(true);
    // session/file names use a tmux-safe `<projectId>-<hash>` token, not the path-bearing wire id
    expect(session).toMatch(/^rac-stack-proj-[0-9a-f]{12}-build-exclusive$/);
    await expect(service.state(worktree)).resolves.toEqual({ operation: 'build' });
    active = false;
    await expect(service.state(worktree)).resolves.toEqual({});
    expect(new Set(binaries)).toEqual(new Set(['/host-tools/tmux']));
  });

  // the menu offers Stop while a Start still waits on its tunnel, and a Stop ends that wait; a
  // Restart starts the stack again, so it is left Starting
  it('drops a pending Starting transition when a Stop is launched, not a Restart', async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    const daemon = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { start: 'up', stop: 'down', restart: 'bounce' } });
    const live = new Set<string>();
    const command = async (_binary: string, args: string[]) => {
      if (args.includes('new-session')) { live.add(args[args.indexOf('-s') + 1] ?? ''); return { code: 0, stdout: '' }; }
      if (args.includes('has-session')) return { code: live.has((args[args.indexOf('-t') + 1] ?? '').replace(/^=/u, '')) ? 0 : 1, stdout: '' };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, { worktreesNow: () => [daemon] } as never, command);

    for (const [action, after] of [['restart', { transition: 'starting' }], ['stop', {}]] as const) {
      await expect(service.start(daemon.id, 'start')).resolves.toBe('started');
      live.clear();
      await expect(service.state(daemon)).resolves.toEqual({ transition: 'starting' });
      await expect(service.start(daemon.id, action)).resolves.toBe('started');
      live.clear();
      await expect(service.state(daemon)).resolves.toEqual(after);
    }
  });

  // Starting ends once the Project answers, on a check made after the Start: a check cached from
  // before it (the stack was up, or a Restart) never ends it early
  it("ends a Start's Starting transition on the first fresh healthy tunnel check", async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    const preview = await projectPreview();
    try {
      const daemon = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', projectUrl: preview.url, commands: { start: 'up', stop: 'down' } });
      const live = new Set<string>();
      const command = async (_binary: string, args: string[]) => {
        if (args.includes('new-session')) { live.add(args[args.indexOf('-s') + 1] ?? ''); return { code: 0, stdout: '' }; }
        if (args.includes('has-session')) return { code: live.has((args[args.indexOf('-t') + 1] ?? '').replace(/^=/u, '')) ? 0 : 1, stdout: '' };
        return { code: 1, stdout: '' };
      };
      const service = new WorktreeCommandService(config, { worktreesNow: () => [daemon] } as never, command);
      await vi.waitFor(async () => { expect(await service.state(daemon)).toEqual({ tunnel: true }); });

      preview.state.healthy = false;
      await expect(service.start(daemon.id, 'start')).resolves.toBe('started');
      live.clear();
      await expect(service.state(daemon)).resolves.toEqual({ transition: 'starting' });
      await vi.waitFor(async () => { expect(await service.state(daemon)).toEqual({ transition: 'starting', tunnel: false }); });
      preview.state.healthy = true;
      await vi.waitFor(async () => { expect(await service.state(daemon)).toEqual({ tunnel: true }); }, { timeout: 5_000, interval: 100 });
    } finally { await preview.close(); }
  });

  it('detects a running stack operation but ignores transient status probes (Remove blocker)', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const other = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', hostPath: '/home/ubuntu/dana', pinned: false });
    const { createHash } = await import('node:crypto');
    const probeSession = `rac-stack-proj-${createHash('sha256').update(worktree.path).digest('hex').slice(0, 12)}-a1b2c3d4e5f6`;
    const command = async (_binary: string, args: string[]) => {
      // an exclusive operation session for `worktree`, plus unrelated + probe sessions
      if (args.includes('list-sessions')) return { code: 0, stdout: `${stackSession('proj', worktree.path)}\nrac-launch-x\nsome-shell\n` };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, discovery as never, command);
    // only the Worktree whose exclusive operation session is present is blocked
    await expect(service.sessionRunning(worktree)).resolves.toBe(true);
    await expect(service.sessionRunning(other)).resolves.toBe(false);

    // a transient `rac-stack-<token>-<hex>` status probe is not an operation and never blocks
    const probing = async (_binary: string, args: string[]) => (args.includes('list-sessions') ? { code: 0, stdout: `${probeSession}\n` } : { code: 1, stdout: '' });
    await expect(new WorktreeCommandService(config, discovery as never, probing).sessionRunning(worktree)).resolves.toBe(false);
  });

  // two branches of one Project run their stacks side by side: each Worktree gets its
  // own exclusive session and log file named by its token, state is per Worktree, and
  // the host-side paths come from the Project declared at the server's own checkout —
  // port conflicts between the two stacks are the operator's business, never the console's
  it('runs stacks in two Worktrees of one Project concurrently', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { build: 'make build', migrate: 'make migrate' } });
    const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, branch: 'dana', commands: { build: 'make ui' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const live = new Set<string>();
    const scripts = new Map<string, string>();
    const fake = async (_binary: string, args: string[]) => {
      // capture each launched session and its script
      if (args.includes('new-session')) {
        const session = args[args.indexOf('-s') + 1] ?? '';
        live.add(session);
        scripts.set(session, args.at(-1) ?? '');
        return { code: 0, stdout: '' };
      }
      // report the synthetic session state
      if (args.includes('has-session')) return { code: live.has((args[args.indexOf('-t') + 1] ?? '').replace(/^=/u, '')) ? 0 : 1, stdout: '' };
      return { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora, dana] } as never, fake, checkoutRoot);

    await expect(service.start(cora.id, 'build')).resolves.toBe('started');
    await expect(service.start(dana.id, 'build')).resolves.toBe('started');
    // only the same Worktree is serialized; the sibling never is
    await expect(service.start(cora.id, 'build')).resolves.toBe('busy');
    const coraSession = stackSession('proj', cora.path);
    const danaSession = stackSession('proj', dana.path);
    expect([...live]).toEqual([coraSession, danaSession]);

    // each command runs in its own Worktree and writes its own log, host-side, under
    // the checkout of the Project whose path is the server's own
    const logName = (script: string, projectId: string, path: string) => new RegExp(`> '/host/checkout/\\.data/stack-logs/(${worktreeToken(projectId, path)}-[0-9a-f]{18}\\.log)'`, 'u').exec(script)?.[1];
    const coraLog = logName(scripts.get(coraSession) ?? '', 'proj', cora.path);
    const danaLog = logName(scripts.get(danaSession) ?? '', 'proj', dana.path);
    expect(scripts.get(coraSession)).toContain("cd -- '/host/cora'");
    expect(scripts.get(danaSession)).toContain("cd -- '/worktrees/dana'");
    // select each checkout's command set rather than the project default
    expect(scripts.get(coraSession)).toContain('make build');
    expect(scripts.get(danaSession)).toContain('make ui');
    expect(service.actions(cora)).toEqual(['build', 'migrate']);
    expect(service.actions(dana)).toEqual(['build']);
    await expect(service.start(dana.id, 'migrate')).resolves.toBe(false);
    expect(coraLog).toBeDefined();
    expect(danaLog).toBeDefined();
    expect(coraLog).not.toBe(danaLog);

    // stack state on the dashboard is per Worktree
    await expect(service.state(cora)).resolves.toEqual({ operation: 'build' });
    await expect(service.state(dana)).resolves.toEqual({ operation: 'build' });
    live.delete(coraSession);
    await expect(service.state(cora)).resolves.toEqual({});
    await expect(service.state(dana)).resolves.toEqual({ operation: 'build' });

    // each Worktree's output is read back from its own console-side file
    await writeFile(join(checkoutRoot, '.data', 'stack-logs', coraLog!), 'cora output');
    await writeFile(join(checkoutRoot, '.data', 'stack-logs', danaLog!), 'dana output');
    await expect(service.log(cora.id)).resolves.toMatchObject({ action: 'build', active: false, output: 'cora output' });
    await expect(service.log(dana.id)).resolves.toMatchObject({ action: 'build', active: true, output: 'dana output' });
  });

  // status probes are per Worktree too: each writes its own `stack-<token>-<hex>` file
  // under the server checkout's `.data`, host-side through the declared Project
  it('probes stack status per Worktree under the server checkout', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { status: 'stack status' } });
    const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, branch: 'dana', commands: { status: 'stack status' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const statusFiles: string[] = [];
    const fake = async (_binary: string, args: string[]) => {
      // the host-side probe writes its exit code; mirror it through the mount
      if (!args.includes('new-window')) return { code: 1, stdout: '' };
      const hostFile = /> '(\/host\/checkout\/[^']+)'/u.exec(args.at(-1) ?? '')?.[1];
      if (hostFile === undefined) return { code: 1, stdout: '' };
      statusFiles.push(hostFile);
      await writeFile(join(checkoutRoot!, hostFile.slice('/host/checkout/'.length)), hostFile.includes(worktreeToken('proj', cora.path)) ? '0' : '1');
      return { code: 0, stdout: `@${statusFiles.length}\n` };
    };
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora, dana] } as never, fake, checkoutRoot);

    // the first read triggers each probe; the cache then settles per Worktree
    await expect(service.running(cora)).resolves.toBeUndefined();
    await expect(service.running(dana)).resolves.toBeUndefined();
    await vi.waitFor(async () => {
      expect(await service.running(cora)).toBe(true);
      expect(await service.running(dana)).toBe(false);
    });
    const coraFile = statusFiles.find(file => file.includes(worktreeToken('proj', cora.path)));
    const danaFile = statusFiles.find(file => file.includes(worktreeToken('proj', dana.path)));
    expect(coraFile).toContain(`/host/checkout/.data/stack-status/stack-${worktreeToken('proj', cora.path)}-`);
    expect(danaFile).toContain(`/host/checkout/.data/stack-status/stack-${worktreeToken('proj', dana.path)}-`);
  });

  // Regression (2026-09-17): a session per probe closed a session on every refresh, firing the
  // operator's tmux `session-closed` hook — a `choose-tree` hook then opened the session picker
  // over the pane in use every ~30s, where it also swallowed a submitted prompt's Enter. Probes
  // must run as windows of one holder session, so refreshing never creates or closes a session.
  it('runs status probes as windows of one holder session, never a session per probe', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { status: 'stack status' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const sessions: string[] = [];
    const closedSessions: string[][] = [];
    let windows = 0;
    const fake = async (_binary: string, args: string[]) => {
      if (args.includes('kill-session')) { closedSessions.push(args); return { code: 0, stdout: '' }; }
      if (args.includes('new-session')) { sessions.push(args[args.indexOf('-s') + 1] ?? ''); return { code: 0, stdout: '' }; }
      if (!args.includes('new-window')) return { code: 1, stdout: '' };
      // the holder does not exist until the service creates it
      if (sessions.length === 0) return { code: 1, stdout: '', stderr: "can't find session: rac-stack-probes" };
      expect(args[args.indexOf('-t') + 1]).toBe('=rac-stack-probes:');
      const hostFile = /> '(\/host\/checkout\/[^']+)'/u.exec(args.at(-1) ?? '')?.[1];
      await writeFile(join(checkoutRoot!, hostFile!.slice('/host/checkout/'.length)), '0');
      windows += 1;
      return { code: 0, stdout: `@${windows}\n` };
    };
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora] } as never, fake, checkoutRoot);
    const cache = (service as unknown as { statusCache: Map<string, unknown> }).statusCache;

    // three full refreshes (the cache expired between each)
    for (let round = 1; round <= 3; round += 1) {
      cache.clear();
      await service.running(cora);
      await vi.waitFor(async () => { expect(windows).toBe(round); expect(await service.running(cora)).toBe(true); });
    }
    // one holder session for all of them, and no session was ever closed
    expect(sessions).toEqual(['rac-stack-probes']);
    expect(closedSessions).toEqual([]);
  });

  // A quick command's window closes itself when it exits, but one that hangs (never writing
  // its marker) would linger while the next dashboard build spawns another beside it — the
  // pile-up this guards against.
  it('kills a status probe window that never answers, so probes never pile up', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { status: 'sleep 999' } });
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot, hostPath: '/host/checkout' })] });
    const created: string[] = [];
    const killed: string[] = [];
    const live = new Set<string>();
    // model a probe whose command hangs: the window is created but never writes its marker,
    // so only an explicit kill removes it from the tmux server
    const fake = async (_binary: string, args: string[]) => {
      if (args.includes('new-window')) { const id = `@${created.length + 1}`; created.push(id); live.add(id); return { code: 0, stdout: `${id}\n` }; }
      if (args.includes('kill-window')) { const id = args[args.indexOf('-t') + 1] ?? ''; killed.push(id); live.delete(id); return { code: 0, stdout: '' }; }
      return { code: 1, stdout: '' };
    };
    // a tight probe budget so the hang is abandoned in milliseconds, not the 2s default
    const service = new WorktreeCommandService(projectConfig, { worktreesNow: () => [cora] } as never, fake, checkoutRoot, undefined, { timeoutMs: 60, pollMs: 10 });

    // kick a probe; the command hangs, so the bounded poll gives up — and the window must be
    // killed rather than abandoned, leaving nothing running for a later probe to accumulate on
    await expect(service.running(cora)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(created).toHaveLength(1);
      expect(killed).toEqual(created);
      expect(live.size).toBe(0);
    });
  });

  // the preview health probe reads each Worktree record's Project URL
  it('probes the Project preview from each Worktree record', async () => {
    const upstream = createServer((_request, response) => { response.end('ok'); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    try {
      const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', projectUrl: url });
      const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, projectUrl: url });
      const service = new WorktreeCommandService(config, { worktreesNow: () => [cora, dana] } as never, async () => ({ code: 1, stdout: '' }));
      // the first read triggers the probe; both Worktrees settle on the shared URL
      await expect(service.state(cora)).resolves.toEqual({});
      await vi.waitFor(async () => {
        expect(await service.state(cora)).toEqual({ tunnel: true });
        expect(await service.state(dana)).toEqual({ tunnel: true });
      });
    } finally {
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it("probes tmux's default socket for a stack session in native mode", async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    const calls: string[][] = [];
    const command = async (_binary: string, args: string[]) => {
      calls.push(args);
      return args.includes('list-sessions') ? { code: 0, stdout: `${stackSession('proj', worktree.path)}\n` } : { code: 1, stdout: '' };
    };
    const service = new WorktreeCommandService(config, discovery as never, command);
    // a native deployment reaches tmux directly, so its exclusive operation session is found
    await expect(service.sessionRunning(worktree)).resolves.toBe(true);
    // and every tmux call targets the default socket: no '-S' selector
    expect(calls.every(args => !args.includes('-S'))).toBe(true);
  });
});

// A small in-memory tmux: sessions with options, one pane per window with its own pane options,
// a pane that dies on `send-keys C-c` (status 130) unless it `ignoresInterrupt` or is `inMode`
// (where C-c only leaves the mode, as in copy mode, and `copy-mode -q` leaves it too),
// `display-message -p` on a pane, the `;` command sequences the service chains (with `\;` as an
// escaped literal), a `-c` start directory format-expanded as tmux does it (a `#(…)` there would run, and is recorded in
// `formatCommands`), `set-option` scoped by `-p`/`-w` or else to the target's session, and a
// `list-panes` that lists every session with `-a`, a session's windows with `-s`, else its
// active window only. A session target must be `=name:`, as real tmux reads a bare `=name` as
// a window. `pipe-pane` refuses a dead pane, a respawn keeps the pipe and the pane's death
// closes it, as in tmux. `fail` makes every call fail as tmux does when it cannot run. Git runs
// for real in a checkout that exists, so a real repository answers `rev-parse`; its calls are
// kept apart in `gitCalls`.
type FakeWindow = { id: string; paneId: string; session: string; options: Map<string, string>; paneOptions: Map<string, string>; dead: boolean; status?: number; signal?: string; pendingStatus?: number; command: string[]; cwd?: string; ignoresInterrupt?: boolean; inMode?: boolean; output?: string; pipe?: string; runs?: string[][] };
function fakeTmux() {
  const sessions = new Map<string, Map<string, string>>();
  // tmux's stable `$N` session ids, by name
  const sessionIds = new Map<string, string>();
  const idOf = (session: string) => { if (!sessionIds.has(session)) sessionIds.set(session, `$${sessionIds.size + 1}`); return sessionIds.get(session)!; };
  // a `=name:` or `$N:` session target's session name, if it names one
  const sessionOf = (target: string) => { const bare = target.replace(/^=|:$/gu, ''); return bare.startsWith('$') ? [...sessionIds].find(([, id]) => id === bare)?.[0] : bare; };
  const windows: FakeWindow[] = [];
  const calls: string[][] = [];
  const events: string[] = [];
  let nextWindow = 1;
  const state = { fail: false, failReaperWake: false };
  const formatCommands: string[] = [];
  // `##` collapses to `#`; an undoubled `#(` is a shell command the tmux server would run
  const expand = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const command = /(?:^|[^#])(?:##)*#\(([^)]*)\)/u.exec(value)?.[1];
    if (command !== undefined) formatCommands.push(command);
    return value.replaceAll('##', '#');
  };
  const value = (args: string[], flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const find = (target: string | undefined) => windows.find(entry => entry.id === target || entry.paneId === target);
  const openWindow = (session: string, command: string[], cwd?: string) => { const id = nextWindow++; const entry: FakeWindow = { id: `@${id}`, paneId: `%${id}`, session, options: new Map(), paneOptions: new Map(), dead: false, command, ...(cwd === undefined ? {} : { cwd: expand(cwd)! }) }; windows.push(entry); return entry; };
  const missing = (session: string) => ({ code: 1, stdout: '', stderr: `can't find session: ${session}` });
  const format = (template: string, entry: FakeWindow) => template.replace(/#\{([^}]+)\}/gu, (_match, key: string) => {
    if (key.startsWith('@')) return entry.paneOptions.get(key) ?? entry.options.get(key) ?? sessions.get(entry.session)?.get(key) ?? '';
    const fields: Record<string, string> = { session_id: idOf(entry.session), window_id: entry.id, pane_id: entry.paneId, session_name: entry.session, pane_dead: entry.dead ? '1' : '0', pane_dead_status: entry.dead && entry.status !== undefined ? String(entry.status) : '', pane_dead_signal: entry.dead && entry.signal !== undefined ? String(entry.signal) : '' };
    return fields[key] ?? '';
  });
  // the trailing shell command of a tmux command, after its flags
  const commandOf = (args: string[], valueFlags: string[]) => { let index = 1; while (index < args.length && args[index]!.startsWith('-')) index += valueFlags.includes(args[index]!) ? 2 : 1; return args.slice(index); };
  const dispatch = (args: string[]): { code: number; stdout: string; stderr?: string } => {
    const [verb] = args;
    if (verb === 'new-session') {
      const name = expand(value(args, '-s'))!;
      if (sessions.has(name)) return { code: 1, stdout: '', stderr: `duplicate session: ${name}` };
      sessions.set(name, new Map());
      const entry = openWindow(name, commandOf(args, ['-s', '-n', '-c', '-F']), value(args, '-c'));
      events.push(`session ${name}`);
      return { code: 0, stdout: args.includes('-P') ? `${format(value(args, '-F') ?? '', entry)}\n` : '' };
    }
    if (verb === 'list-sessions') return { code: 0, stdout: [...sessions.keys()].map(name => `${name}\n`).join('') };
    if (verb === 'run-shell') {
      events.push('reaper-wake');
      // preserve the missed metadata when the wake itself fails
      if (state.failReaperWake) return { code: 1, stdout: '', stderr: 'run-shell failed' };
      // publish only native results the fake marked as pending
      for (const entry of windows) if (entry.pendingStatus !== undefined) { entry.status = entry.pendingStatus; delete entry.pendingStatus; }
      return { code: 0, stdout: '' };
    }
    if (verb === 'set-option') {
      const target = value(args, '-t')!;
      const [name, setting] = args.slice(-2) as [string, string];
      if (target.startsWith('=')) {
        // a session target is `=name:`; tmux reads a bare `=name` as a window, which fails here
        const options = target.endsWith(':') ? sessions.get(target.slice(1, -1)) : undefined;
        if (options === undefined) return { code: 1, stdout: '', stderr: `no such session: ${target}` };
        options.set(name, setting);
      } else {
        const entry = find(target);
        if (entry === undefined) return { code: 1, stdout: '', stderr: `can't find pane: ${target}` };
        (args.includes('-p') ? entry.paneOptions : args.includes('-w') ? entry.options : sessions.get(entry.session)!).set(name, setting);
      }
      events.push(`set ${target} ${name}=${setting}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'new-window') {
      const target = value(args, '-t')!;
      const session = sessionOf(target);
      if (!target.endsWith(':') || session === undefined || !sessions.has(session)) return missing(target);
      const entry = openWindow(session, commandOf(args, ['-t', '-c', '-F', '-n']), value(args, '-c'));
      events.push(`window ${entry.id} ${session}`);
      return { code: 0, stdout: args.includes('-P') ? `${format(value(args, '-F') ?? '', entry)}\n` : '' };
    }
    if (verb === 'respawn-pane') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      if (!entry.dead && !args.includes('-k')) return { code: 1, stdout: '', stderr: 'pane still active' };
      Object.assign(entry, { dead: false, status: undefined, command: commandOf(args, ['-t', '-c']), cwd: expand(value(args, '-c')) });
      entry.runs = [...entry.runs ?? [], entry.command];
      events.push(`respawn ${entry.id}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'pipe-pane') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      if (entry.dead) return { code: 1, stdout: '', stderr: 'target pane has exited' };
      // with -o, only when the pane has no pipe
      if (args.includes('-o') && entry.pipe !== undefined) return { code: 0, stdout: '' };
      // strftime, then format expansion: an escaped `%%` or `##` comes back single, and anything
      // tmux would expand is marked so an assertion sees it
      entry.pipe = expand(args.at(-1)!.replace(/%(.)/gu, (_match, next: string) => next === '%' ? '%' : `<strftime %${next}>`).replace(/(?<!#)((?:##)*)#\{([^}]*)\}/gu, '$1<format $2>'))!;
      events.push(`pipe ${entry.id} ${entry.pipe}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'kill-window') {
      const target = find(value(args, '-t')); const index = target === undefined ? -1 : windows.indexOf(target);
      if (index < 0) return { code: 1, stdout: '', stderr: "can't find window" };
      const [killed] = windows.splice(index, 1);
      if (!windows.some(entry => entry.session === killed!.session)) sessions.delete(killed!.session);
      events.push(`kill ${killed!.id}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'copy-mode') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      entry.inMode = !args.includes('-q');
      events.push(`${entry.inMode ? 'enter' : 'leave'}-mode ${entry.paneId}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'send-keys') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      const keys = commandOf(args, ['-t']);
      events.push(`keys ${entry.paneId} ${keys.join(' ')}`);
      if (keys.includes('C-c') && entry.inMode === true) entry.inMode = false;
      else if (keys.includes('C-c') && !entry.dead && entry.ignoresInterrupt !== true) { Object.assign(entry, { dead: true, status: 130 }); delete entry.pipe; }
      return { code: 0, stdout: '' };
    }
    if (verb === 'clear-history') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      entry.output = '';
      events.push(`clear ${entry.paneId}`);
      return { code: 0, stdout: '' };
    }
    if (verb === 'capture-pane') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      return { code: 0, stdout: entry.output ?? '' };
    }
    if (verb === 'display-message') {
      const entry = find(value(args, '-t'));
      if (entry === undefined) return { code: 1, stdout: '', stderr: "can't find pane" };
      return { code: 0, stdout: `${format(args.at(-1)!, entry)}\n` };
    }
    if (verb === 'list-panes') {
      if (sessions.size === 0) return { code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-1000/default' };
      let listed = windows;
      if (!args.includes('-a')) {
        const target = value(args, '-t')!;
        const session = target.replace(/^=|:$/gu, '');
        if (!target.endsWith(':') || !sessions.has(session)) return target.endsWith(':') ? missing(session) : { code: 1, stdout: '', stderr: `can't find window: ${session}` };
        const own = windows.filter(entry => entry.session === session);
        listed = args.includes('-s') ? own : own.slice(0, 1);
      }
      return { code: 0, stdout: listed.map(entry => `${format(value(args, '-F')!, entry)}\n`).join('') };
    }
    return { code: 1, stdout: '' };
  };
  const gitCalls: string[][] = [];
  const command = async (binary: string, argv: string[]) => {
    if (binary.endsWith('/git')) {
      gitCalls.push(argv);
      // answer at once for a made-up checkout, as git would, so it adds no subprocess delay
      const checkout = argv[argv.indexOf('-C') + 1] ?? '';
      return existsSync(checkout) ? await run(binary, argv) : { code: 128, stdout: '', stderr: `fatal: cannot change to '${checkout}': No such file or directory` };
    }
    calls.push(argv);
    if (state.fail) throw new Error('spawn /usr/bin/tmux ENOENT');
    const args = argv[0] === '-S' ? argv.slice(2) : argv;
    let stdout = '';
    // a `;` sequence stops at its first failing command, as tmux's does
    for (const part of args.join('\u0000').split('\u0000;\u0000')) {
      const result = dispatch(part.split('\u0000').map(arg => arg.endsWith('\\;') ? `${arg.slice(0, -2)};` : arg));
      if (result.code !== 0) return result;
      stdout += result.stdout;
    }
    return { code: 0, stdout };
  };
  // a Workspace session the console (or a claim) marked for a Place, holding one idle shell
  const seedWorkspace = (session: string, placeId: string) => {
    sessions.set(session, new Map([['@rac_place', placeId]]));
    return openWindow(session, ['/bin/bash', '-l']);
  };
  // a Stack process window already in a session, as a previous console instance left it
  const seedProcess = (session: string, worktreePath: string, name: string, dead = false, status?: number) => {
    if (!sessions.has(session)) sessions.set(session, new Map());
    const entry = openWindow(session, ['/bin/bash', '-lc', 'pnpm dev']);
    entry.options.set('remain-on-exit', 'on').set('@rac_worktree', worktreePath).set('@rac_process', name);
    entry.paneOptions.set('@rac_role', 'process');
    Object.assign(entry, { dead, ...(status === undefined ? {} : { status }) });
    return entry;
  };
  return { command, calls, gitCalls, events, sessions, windows, state, formatCommands, seedWorkspace, seedProcess };
}

describe('worktree Stack process', () => {
  quietWarnings();
  const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { processes: { dev: 'pnpm dev' }, build: 'pnpm build' } });
  const dana = testWorktree({ id: 'proj:/worktrees/dana', projectId: 'proj', path: '/worktrees/dana', main: false, commands: { processes: { dev: 'pnpm dev' } } });
  const erin = testWorktree({ id: 'proj:/worktrees/erin', projectId: 'proj', path: '/worktrees/erin', main: false, commands: { processes: { web: 'cd web && pnpm dev' } } });
  const processService = (tmux: ReturnType<typeof fakeTmux>, worktrees = [cora, dana, erin]) => new WorktreeCommandService(config, { worktreesNow: () => worktrees } as never, tmux.command);
  const processWindows = (tmux: ReturnType<typeof fakeTmux>) => tmux.windows.filter(entry => entry.options.has('@rac_process'));
  // native mode unless a test bridges: tmux's default socket and no host PATH
  beforeEach(() => { delete process.env.RAC_HOST_TMUX_DIR; delete process.env.RAC_HOST_PATH; });

  it('offers Start, Stop and Restart beside the configured one-shot commands', () => {
    const service = processService(fakeTmux());
    expect(service.actions(cora)).toEqual(['start', 'stop', 'build', 'restart']);
    expect(service.actions(dana)).toEqual(['start', 'stop', 'restart']);
  });

  it("starts the process in a tagged, remain-on-exit window of the Worktree's Workspace session", async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    process.env.RAC_TMUX_BIN = '/host-tools/tmux';
    process.env.RAC_HOST_PATH = '/opt/operator/bin:/usr/bin:/bin';
    const tmux = fakeTmux();
    tmux.seedWorkspace('dana', dana.id);
    tmux.seedWorkspace('cora', cora.id);
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');

    // it joins the session marked as cora's Workspace, creating none
    expect([...tmux.sessions.keys()]).toEqual(['dana', 'cora']);
    const [window] = processWindows(tmux);
    expect(window?.session).toBe('cora');
    // tagged, kept on exit, and marked as a process pane before its command ever runs
    expect(Object.fromEntries(window!.options)).toEqual({ 'remain-on-exit': 'on', '@rac_worktree': '/worktrees/cora', '@rac_process': 'dev' });
    expect(Object.fromEntries(window!.paneOptions)).toEqual({ '@rac_role': 'process' });
    expect(tmux.events.indexOf(`respawn ${window!.id}`)).toBeGreaterThan(tmux.events.indexOf(`set ${window!.id} @rac_process=dev`));
    // wrapped as a stack command (login bash, host PATH, the Worktree host root), in a subshell
    expect(window!.cwd).toBe('/host/cora');
    expect(window!.command).toEqual(['/bin/bash', '-lc', "export PATH='/opt/operator/bin:/usr/bin:/bin'; ( cd -- '/host/cora' && { pnpm dev; } )"]);
    // on the host socket, through the host tmux client, like every stack command
    expect(tmux.calls.every(args => args[0] === '-S' && args[1] === '/host-tmux/default')).toBe(true);

    await expect(service.state(cora)).resolves.toEqual({ running: true, transition: 'starting', processes: [{ name: 'dev', state: 'running' }] });
  });

  // a snapshot taken before start cannot clear or hide the new transition
  it('reads fresh process state when Starting postdates the dashboard snapshot', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const service = processService(tmux);
    const snapshots = new Map([[`/tmp/tmux-${process.getuid?.() ?? 0}/default`, { status: 'available' as const, panes: [] }]]);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    await expect(service.state(cora, snapshots)).resolves.toEqual({ running: true, transition: 'starting', processes: [{ name: 'dev', state: 'running' }] });
  });

  // a start racing an older state read keeps the transition that read never observed
  it('does not reconcile a new Starting transition against a prior observation', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    let releaseGit!: () => void;
    let heldGit = false;
    const command = async (binary: string, args: string[]) => {
      // hold the first metadata read so start can land during state
      if (binary.endsWith('/git') && !heldGit) {
        heldGit = true;
        return await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => { releaseGit = () => resolve({ code: 128, stdout: '', stderr: 'missing fixture checkout' }); });
      }
      return await tmux.command(binary, args);
    };
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, command);
    const snapshots = new Map([[`/tmp/tmux-${process.getuid?.() ?? 0}/default`, { status: 'available' as const, panes: [] }]]);

    const pending = service.state(cora, snapshots);
    await vi.waitFor(() => expect(heldGit).toBe(true));
    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    releaseGit();
    await expect(pending).resolves.toEqual({ running: false, transition: 'starting', processes: [{ name: 'dev', state: 'stopped' }] });
  });

  // a Worktree with no Agent or Terminal open yet gets its Workspace session the way a launch
  // makes one: named for the checkout (suffixed past a taken name) and marked for the Worktree
  it('creates the Workspace session, named and marked like a launch, when the Worktree has none', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('dana', dana.id);
    // the operator's own session of the same name, unmarked, is never joined or displaced
    tmux.sessions.set('cora', new Map());
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    expect([...tmux.sessions.keys()]).toEqual(['dana', 'cora', 'cora-2']);
    expect(tmux.sessions.get('cora-2')?.get('@rac_place')).toBe(cora.id);
    // the process window is the new session's only window
    expect(tmux.windows.filter(entry => entry.session === 'cora-2')).toEqual(processWindows(tmux));
    expect(processWindows(tmux)[0]?.paneOptions.get('@rac_role')).toBe('process');
    await expect(service.state(cora)).resolves.toMatchObject({ running: true, processes: [{ name: 'dev', state: 'running' }] });
  });

  it('does nothing when the process is already running', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const before = tmux.calls.length;
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    expect(tmux.windows).toHaveLength(2);
    expect(tmux.calls.slice(before).map(args => args[0])).toEqual(['list-panes']);
    await expect(service.state(cora)).resolves.toEqual({ running: true, processes: [{ name: 'dev', state: 'running' }] });
  });

  // nothing about a process is remembered in memory: a restarted console reads it from tmux,
  // in whichever session it lives
  it('finds each Worktree process by the tags on its window, never by a status probe', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    tmux.seedProcess('dana-2', '/worktrees/dana', 'dev', true, 127);
    // an orphan whose Worktree is no longer configured, and a process renamed in config
    tmux.seedProcess('gone', '/worktrees/gone', 'dev');
    tmux.seedProcess('erin', '/worktrees/erin', 'dev');
    const service = processService(tmux);

    await expect(service.state(cora)).resolves.toEqual({ running: true, processes: [{ name: 'dev', state: 'running' }] });
    await expect(service.state(dana)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 127 }] });
    await expect(service.state(erin)).resolves.toEqual({ running: false, processes: [{ name: 'web', state: 'stopped' }] });
    // reading state never opens a window: no status probe runs for a process Worktree
    expect(tmux.calls.every(args => args[0] === 'list-panes')).toBe(true);
  });

  // recover the exact native result without changing sockets
  it('recovers one missed native exit status through the selected tmux socket', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const tmux = fakeTmux();
    const crashed = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true);
    crashed.pendingStatus = 3;
    crashed.output = 'missing binary\n';
    const service = processService(tmux);

    await expect(service.processOutput(cora.id, 'dev')).resolves.toEqual({ name: 'dev', state: 'exited', exitCode: 3, output: 'missing binary' });
    // isolate recovery calls from ordinary pane reads
    expect(tmux.calls.filter(args => args.includes('run-shell'))).toEqual([['-S', '/host-tmux/default', 'run-shell', ':']]);
    expect(tmux.calls.filter(args => args.includes('list-panes'))).toHaveLength(2);
  });

  // refresh incomplete shared evidence through the bounded native path
  it('refreshes an incomplete dashboard snapshot before recovering its exit status', async () => {
    const tmux = fakeTmux();
    const crashed = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true);
    crashed.pendingStatus = 3;
    const path = `/tmp/tmux-${process.getuid?.() ?? 0}/default`;
    const snapshots = new Map([[path, { status: 'available' as const, panes: [{ paneId: crashed.paneId, sessionId: '$1', windowId: crashed.id, pid: 1, path: '', title: '', command: 'bash', role: 'process', processName: 'dev', processWorktree: cora.path, dead: true, socket: { fingerprint: 'fixture', path, device: 0, inode: 0 } }] }]]);

    await expect(processService(tmux).state(cora, snapshots)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 3 }] });
    // require one recovery and its one fresh listing
    expect(tmux.events.filter(event => event === 'reaper-wake')).toHaveLength(1);
    expect(tmux.calls.filter(args => args.includes('list-panes'))).toHaveLength(2);
  });

  // leave complete signal and non-process observations untouched
  it('does not wake for a signalled process, a live process, or an unmanaged dead pane', async () => {
    const tmux = fakeTmux();
    const signalled = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true);
    signalled.signal = 'INT';
    tmux.seedProcess('dana', '/worktrees/dana', 'dev');
    const unmanaged = tmux.seedProcess('erin', '/worktrees/erin', 'web', true);
    unmanaged.paneOptions.delete('@rac_role');
    unmanaged.pendingStatus = 4;
    const service = processService(tmux);

    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited' }] });
    await expect(service.state(dana)).resolves.toEqual({ running: true, processes: [{ name: 'dev', state: 'running' }] });
    await expect(service.state(erin)).resolves.toEqual({ running: false, processes: [{ name: 'web', state: 'stopped' }] });
    expect(tmux.events).not.toContain('reaper-wake');
  });

  // refresh a signal-only snapshot without attempting recovery
  it('refreshes a signal-only dashboard snapshot without waking the reaper', async () => {
    const tmux = fakeTmux();
    const signalled = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true);
    signalled.signal = '15';
    const path = `/tmp/tmux-${process.getuid?.() ?? 0}/default`;
    const snapshots = new Map([[path, { status: 'available' as const, panes: [{ paneId: signalled.paneId, sessionId: '$1', windowId: signalled.id, pid: 1, path: '', title: '', command: 'bash', role: 'process', processName: 'dev', processWorktree: cora.path, dead: true, socket: { fingerprint: 'fixture', path, device: 0, inode: 0 } }] }]]);

    await expect(processService(tmux).state(cora, snapshots)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited' }] });
    // require only the fallback listing
    expect(tmux.calls.filter(args => args.includes('list-panes'))).toHaveLength(1);
    expect(tmux.events).not.toContain('reaper-wake');
  });

  // fail closed and cap the successful recovery path at one refresh
  it('preserves missing status when the wake fails and bounds a still-pending refresh', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('cora', '/worktrees/cora', 'dev', true);
    const service = processService(tmux);

    tmux.state.failReaperWake = true;
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited' }] });
    // require one read and one failed wake
    expect(tmux.calls.filter(args => args.includes('list-panes'))).toHaveLength(1);
    expect(tmux.events.filter(event => event === 'reaper-wake')).toHaveLength(1);

    tmux.calls.length = 0;
    tmux.events.length = 0;
    tmux.state.failReaperWake = false;
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited' }] });
    // require one retry without a second wake
    expect(tmux.calls.filter(args => args.includes('list-panes'))).toHaveLength(2);
    expect(tmux.events.filter(event => event === 'reaper-wake')).toHaveLength(1);
  });

  it('reports a process stopped when no tmux server is running, and starts none by reading', async () => {
    const tmux = fakeTmux();
    await expect(processService(tmux).state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
    expect(tmux.sessions.size).toBe(0);
  });

  it('leaves the state unknown and fails Start, without throwing, when tmux cannot run', async () => {
    const tmux = fakeTmux();
    tmux.state.fail = true;
    const service = processService(tmux);
    await expect(service.state(cora)).resolves.toEqual({});
    await expect(service.start(cora.id, 'start')).resolves.toBe(false);
  });

  // a socket that exists but refuses the console is not "no processes"
  it('leaves the state unknown when the tmux socket refuses the connection', async () => {
    const refused = async () => ({ code: 1, stdout: '', stderr: 'error connecting to /host-tmux/default (Permission denied)' });
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, refused);
    await expect(service.state(cora)).resolves.toEqual({});
    await expect(service.start(cora.id, 'start')).resolves.toBe(false);
  });

  it('reruns an exited process in its own window rather than opening another', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const crashed = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true, 1);
    const service = processService(tmux);

    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    expect(processWindows(tmux)).toEqual([crashed]);
    expect(tmux.events).toContain(`respawn ${crashed.id}`);
    expect(crashed.command.at(-1)).toContain('pnpm dev');
    await expect(service.state(cora)).resolves.toMatchObject({ running: true, processes: [{ name: 'dev', state: 'running' }] });
  });

  // a command that dies at once has nothing left to start: the badge shows it down straight
  // away rather than "Starting…" (which also locks the stack menu) for the next minute
  it('drops the Starting transition once the process is not running', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const service = processService(tmux);
    await service.start(cora.id, 'start');
    await expect(service.state(cora)).resolves.toMatchObject({ transition: 'starting' });
    Object.assign(processWindows(tmux)[0]!, { dead: true, status: 127 });
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 127 }] });
  });

  it('ends Starting once the Project answers after the Start, never on a check from before it', async () => {
    const preview = await projectPreview();
    try {
      const tmux = fakeTmux();
      tmux.seedWorkspace('cora', cora.id);
      const reachable = testWorktree({ ...cora, projectUrl: preview.url });
      const service = new WorktreeCommandService(config, { worktreesNow: () => [reachable] } as never, tmux.command);
      const running = { name: 'dev', state: 'running' };
      await vi.waitFor(async () => { expect(await service.state(reachable)).toMatchObject({ tunnel: true }); });

      preview.state.healthy = false;
      await expect(service.start(reachable.id, 'start')).resolves.toBe('started');
      await expect(service.state(reachable)).resolves.toEqual({ running: true, transition: 'starting', processes: [running] });
      await vi.waitFor(async () => { expect(await service.state(reachable)).toEqual({ running: true, transition: 'starting', tunnel: false, processes: [running] }); });
      preview.state.healthy = true;
      await vi.waitFor(async () => { expect(await service.state(reachable)).toEqual({ running: true, tunnel: true, processes: [running] }); }, { timeout: 5_000, interval: 100 });
    } finally { await preview.close(); }
  });

  // a check already in flight at the Start began while the old stack answered; its late
  // "healthy" must not be what ends the new Start's wait
  it('ignores a tunnel check that was in flight when the Start began', async () => {
    const preview = await projectPreview();
    try {
      const tmux = fakeTmux();
      tmux.seedWorkspace('cora', cora.id);
      const reachable = testWorktree({ ...cora, projectUrl: preview.url });
      const service = new WorktreeCommandService(config, { worktreesNow: () => [reachable] } as never, tmux.command);
      Object.assign(preview.state, { healthyDelayMs: 100, unhealthyDelayMs: 600 });
      await expect(service.state(reachable)).resolves.not.toHaveProperty('tunnel');
      await vi.waitFor(() => { expect(preview.state.requests).toBe(1); });

      await expect(service.start(reachable.id, 'start')).resolves.toBe('started');
      preview.state.healthy = false;
      await service.state(reachable);
      // the stale check has landed by now, the fresh one has not
      await new Promise(resolve => setTimeout(resolve, 250));
      await expect(service.state(reachable)).resolves.toMatchObject({ transition: 'starting' });
      await expect(service.state(reachable)).resolves.not.toHaveProperty('tunnel');
      await vi.waitFor(async () => { expect(await service.state(reachable)).toMatchObject({ transition: 'starting', tunnel: false }); });
    } finally { await preview.close(); }
  });

  // "Show dev output": a Capture of the process pane itself, full history with wrapped lines
  // joined, as plain text like a stack log, beside its state
  it("reads a process's output from a Capture of its own pane, as plain text", async () => {
    const tmux = fakeTmux();
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    dev.output = '\x1b[32mready\x1b[0m in 120ms\r\n\x1b]8;;http://localhost:5173\x07local\x1b]8;;\x07\n\n\n';
    // an operator split of the process window carries its tags, never its output
    const split = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    split.paneOptions.delete('@rac_role');
    split.output = 'operator shell';
    const service = processService(tmux);

    // the running pane's id, so "Open as Terminal" can stream the process itself
    await expect(service.processOutput(cora.id, 'dev')).resolves.toEqual({ name: 'dev', state: 'running', paneId: dev.paneId, output: 'ready in 120ms\nlocal' });
    expect(tmux.calls.find(args => args[0] === 'capture-pane')).toEqual(['capture-pane', '-p', '-J', '-S', '-', '-t', dev.paneId]);
  });

  // the Stack panel's Clear empties the pane itself, live or exited, and leaves the process alone
  it("clears a process's output by resetting its pane and dropping the history", async () => {
    const tmux = fakeTmux();
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    dev.output = 'ready in 120ms\n';
    const web = tmux.seedProcess('dana', '/worktrees/dana', 'dev', true, 1);
    web.output = 'crashed\n';
    const service = processService(tmux);

    await expect(service.clearProcessOutput(cora.id, 'dev')).resolves.toBe(true);
    expect(tmux.calls.find(args => args.includes('clear-history'))).toEqual(['send-keys', '-R', '-t', dev.paneId, ';', 'clear-history', '-t', dev.paneId]);
    await expect(service.processOutput(cora.id, 'dev')).resolves.toEqual({ name: 'dev', state: 'running', paneId: dev.paneId, output: '' });
    expect(dev.dead).toBe(false);
    await expect(service.clearProcessOutput(dana.id, 'dev')).resolves.toBe(true);
    await expect(service.processOutput(dana.id, 'dev')).resolves.toMatchObject({ state: 'exited', exitCode: 1, output: '' });
  });

  it('clears nothing for a process with no window, and refuses a name the Worktree does not configure', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const service = processService(tmux);
    await expect(service.clearProcessOutput(cora.id, 'dev')).resolves.toBe(true);
    await expect(service.clearProcessOutput(cora.id, 'nope')).resolves.toBeUndefined();
    expect(tmux.calls.some(args => args.includes('clear-history'))).toBe(false);
    tmux.state.fail = true;
    await expect(service.clearProcessOutput(cora.id, 'dev')).resolves.toBe('unavailable');
  });

  // a dead pane is not one of its Place's streamable panes, so it offers no Terminal
  it("keeps an exited process's last output with its exit code, and reads a stopped one as empty", async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('dana', '/worktrees/dana', 'dev', true, 127).output = 'bash: line 1: pnpm: command not found\n';
    const service = processService(tmux);

    await expect(service.processOutput(dana.id, 'dev')).resolves.toEqual({ name: 'dev', state: 'exited', exitCode: 127, output: 'bash: line 1: pnpm: command not found' });
    await expect(service.processOutput(cora.id, 'dev')).resolves.toEqual({ name: 'dev', state: 'stopped', output: '' });
    expect(tmux.calls.filter(args => args[0] === 'capture-pane')).toHaveLength(1);
  });

  it('cuts a long history to the same 128 KB tail as a stack log', async () => {
    const tmux = fakeTmux();
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`);
    tmux.seedProcess('cora', '/worktrees/cora', 'dev').output = `${lines.join('\n')}\n`;
    const read = await processService(tmux).processOutput(cora.id, 'dev');

    expect(read).not.toBe('unavailable');
    const output = read === undefined || read === 'unavailable' ? '' : read.output;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(128 * 1024);
    expect(Buffer.byteLength(output)).toBeGreaterThan(127 * 1024);
    expect(output.endsWith('line 19999')).toBe(true);
  });

  it('has no output for an unknown Worktree, a Worktree without a process, or a name not configured', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('erin', '/worktrees/erin', 'dev');
    const daemon = testWorktree({ id: 'proj:/worktrees/fern', projectId: 'proj', path: '/worktrees/fern', main: false, commands: { start: 'docker compose up -d' } });
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora, erin, daemon] } as never, tmux.command);

    await expect(service.processOutput('proj:/worktrees/gone', 'dev')).resolves.toBeUndefined();
    await expect(service.processOutput(daemon.id, 'dev')).resolves.toBeUndefined();
    // erin's window is an orphan of a renamed process: the stack controls ignore it
    await expect(service.processOutput(erin.id, 'dev')).resolves.toBeUndefined();
    expect(tmux.calls.filter(args => args[0] === 'capture-pane')).toEqual([]);
  });

  it('reports the output unavailable, without throwing, when tmux cannot run or fails the Capture', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    tmux.state.fail = true;
    await expect(processService(tmux).processOutput(cora.id, 'dev')).resolves.toBe('unavailable');
    tmux.state.fail = false;
    const refused = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => args[0] === 'capture-pane' ? { code: 1, stdout: '', stderr: 'lost server' } : await tmux.command(binary, args));
    await expect(refused.processOutput(cora.id, 'dev')).resolves.toBe('unavailable');
  });

  // a Stop that lands between the listing and the Capture
  it('reads a process whose window closed before its Capture as stopped', async () => {
    const tmux = fakeTmux();
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => args[0] === 'capture-pane' ? { code: 1, stdout: '', stderr: `can't find pane: ${dev.paneId}` } : await tmux.command(binary, args));
    await expect(service.processOutput(cora.id, 'dev')).resolves.toEqual({ name: 'dev', state: 'stopped', output: '' });
  });

  // a checkout path is agent-controlled: an Agent can create a Worktree whose path carries a
  // tmux format or ends in the `;` tmux reads as a command separator
  it('passes a hostile checkout path to tmux as a literal', async () => {
    const tmux = fakeTmux();
    const path = '/worktrees/x#(touch pwned);';
    const hostile = testWorktree({ id: `proj:${path}`, projectId: 'proj', path, commands: { processes: { dev: 'pnpm dev' } } });
    const service = processService(tmux, [hostile]);

    await expect(service.start(hostile.id, 'start')).resolves.toBe('started');
    expect(tmux.formatCommands).toEqual([]);
    const [window] = processWindows(tmux);
    expect(window?.cwd).toBe(path);
    expect(window?.options.get('@rac_worktree')).toBe(path);
    expect(tmux.sessions.get(window!.session)?.get('@rac_place')).toBe(hostile.id);
    await expect(service.state(hostile)).resolves.toMatchObject({ running: true });
  });

  it('removes a half-made window rather than leave an untagged or idle one behind', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const command = tmux.command;
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => args[0] === 'respawn-pane' ? { code: 1, stdout: '', stderr: 'respawn failed' } : await command(binary, args));
    await expect(service.start(cora.id, 'start')).resolves.toBe(false);
    // only the Workspace's own shell remains
    expect(tmux.windows.map(entry => entry.session)).toEqual(['cora']);
    expect(processWindows(tmux)).toEqual([]);
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
  });

  it('refuses a second Start on the same Worktree while one is in flight', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedWorkspace('dana', dana.id);
    const service = processService(tmux);
    const results = await Promise.all([service.start(cora.id, 'start'), service.start(cora.id, 'start'), service.start(dana.id, 'start')]);
    expect(results).toEqual(['started', 'busy', 'started']);
    expect(processWindows(tmux).map(entry => entry.options.get('@rac_worktree'))).toEqual(['/worktrees/cora', '/worktrees/dana']);
  });

  // a short graceful-stop budget, so a process that ignores Ctrl+C is killed in milliseconds
  const stopTiming = { timeoutMs: 60, pollMs: 5 };
  const stoppingService = (tmux: ReturnType<typeof fakeTmux>, timing = stopTiming) => new WorktreeCommandService(config, { worktreesNow: () => [cora, dana, erin] } as never, tmux.command, undefined, undefined, undefined, timing);

  // an operator scrolling the process's Terminal leaves its pane in copy mode, where a bare
  // Ctrl+C would only leave the mode; and a process that exits on it is not waited on further
  it('stops a live process with Ctrl+C, even from copy mode, then removes its window', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    dev.inMode = true;
    const service = stoppingService(tmux, { timeoutMs: 5_000, pollMs: 5 });

    const began = Date.now();
    await expect(service.start(cora.id, 'stop')).resolves.toBe('started');
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(dev.status).toBe(130);
    // any mode holding the pane is left first, so Ctrl+C reaches the process and not copy mode
    expect(tmux.events.filter(event => event.startsWith('leave-mode') || event.startsWith('keys') || event.startsWith('kill'))).toEqual([`leave-mode ${dev.paneId}`, `keys ${dev.paneId} C-c`, `kill ${dev.id}`]);
    // the Workspace's own shell is untouched
    expect(tmux.windows.map(entry => entry.session)).toEqual(['cora']);
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
  });

  it('kills a process that ignores Ctrl+C once the graceful budget runs out', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    dev.ignoresInterrupt = true;
    const service = stoppingService(tmux);

    const began = Date.now();
    await expect(service.start(cora.id, 'stop')).resolves.toBe('started');
    expect(Date.now() - began).toBeGreaterThanOrEqual(stopTiming.timeoutMs);
    expect(tmux.events.indexOf(`kill ${dev.id}`)).toBeGreaterThan(tmux.events.indexOf(`keys ${dev.paneId} C-c`));
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
  });

  it('clears an exited process by removing its window, without sending Ctrl+C', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const crashed = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true, 1);
    const service = stoppingService(tmux);

    await expect(service.start(cora.id, 'stop')).resolves.toBe('started');
    expect(tmux.events.filter(event => event.startsWith('keys'))).toEqual([]);
    expect(tmux.events).toContain(`kill ${crashed.id}`);
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
  });

  it('does nothing to stop when there is no process window', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const windows = [...tmux.windows];
    await expect(stoppingService(tmux).start(cora.id, 'stop')).resolves.toBe('started');
    expect(tmux.events.filter(event => event.startsWith('keys') || event.startsWith('kill'))).toEqual([]);
    expect(tmux.windows).toEqual(windows);
  });

  // a race or an operator may have left two windows for one process; Stop leaves neither
  it('stops every window of the process, and none of another Worktree or name', async () => {
    const tmux = fakeTmux();
    const first = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const second = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true, 0);
    const other = tmux.seedProcess('dana', '/worktrees/dana', 'dev');
    const orphan = tmux.seedProcess('cora', '/worktrees/cora', 'old');
    await expect(stoppingService(tmux).start(cora.id, 'stop')).resolves.toBe('started');
    expect(tmux.windows).toEqual([other, orphan]);
    expect(tmux.events).toEqual(expect.arrayContaining([`kill ${first.id}`, `kill ${second.id}`]));
  });

  // Restart reruns the command in the same pane, so a Terminal open on it stays attached and a
  // process window alone in its session never closes that session
  it('restarts a live process in its own pane: Ctrl+C, then the command again', async () => {
    const tmux = fakeTmux();
    const dev = tmux.seedProcess('cora-2', '/worktrees/cora', 'dev');
    tmux.sessions.get('cora-2')!.set('@rac_place', cora.id);
    const service = stoppingService(tmux);

    await expect(service.start(cora.id, 'restart')).resolves.toBe('started');
    expect(tmux.events.indexOf(`respawn ${dev.id}`)).toBeGreaterThan(tmux.events.indexOf(`keys ${dev.paneId} C-c`));
    expect(tmux.events.filter(event => event.startsWith('kill') || event.startsWith('session'))).toEqual([]);
    expect(processWindows(tmux)).toEqual([dev]);
    expect(dev.command.at(-1)).toContain('pnpm dev');
    await expect(service.state(cora)).resolves.toEqual({ running: true, transition: 'starting', processes: [{ name: 'dev', state: 'running' }] });
  });

  it('restarts a process that ignores Ctrl+C by respawning its pane once the budget runs out', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    dev.ignoresInterrupt = true;
    await expect(stoppingService(tmux).start(cora.id, 'restart')).resolves.toBe('started');
    expect(tmux.events.indexOf(`respawn ${dev.id}`)).toBeGreaterThan(tmux.events.indexOf(`keys ${dev.paneId} C-c`));
    expect(processWindows(tmux)).toEqual([dev]);
  });

  it('restarts an exited process, and starts one that has no window', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedWorkspace('dana', dana.id);
    const crashed = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true, 1);
    const service = stoppingService(tmux);

    await expect(service.start(cora.id, 'restart')).resolves.toBe('started');
    await expect(service.start(dana.id, 'restart')).resolves.toBe('started');
    expect(tmux.events).toContain(`respawn ${crashed.id}`);
    expect(processWindows(tmux).map(entry => entry.options.get('@rac_worktree'))).toEqual(['/worktrees/cora', '/worktrees/dana']);
    await expect(service.state(cora)).resolves.toMatchObject({ running: true, processes: [{ name: 'dev', state: 'running' }] });
    await expect(service.state(dana)).resolves.toMatchObject({ running: true, processes: [{ name: 'dev', state: 'running' }] });
  });

  // a Stop issued while the process still reads as Starting ends that transition with it
  it('drops the Starting transition when the process is stopped', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const service = stoppingService(tmux);
    await service.start(cora.id, 'start');
    await expect(service.state(cora)).resolves.toMatchObject({ transition: 'starting' });
    await expect(service.start(cora.id, 'stop')).resolves.toBe('started');
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
  });

  // a one-shot migrate runs beside the process, so stopping the process leaves it Migrating
  it('keeps a one-shot Migrating transition across a process Stop', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const migrating = testWorktree({ ...cora, commands: { processes: { dev: 'pnpm dev' }, migrate: 'pnpm migrate' } });
    const service = new WorktreeCommandService(config, { worktreesNow: () => [migrating] } as never, async (binary, args) => args.includes('new-session') ? { code: 0, stdout: '' } : await tmux.command(binary, args), undefined, undefined, undefined, stopTiming);
    await expect(service.start(migrating.id, 'migrate')).resolves.toBe('started');
    await expect(service.start(migrating.id, 'stop')).resolves.toBe('started');
    await expect(service.state(migrating)).resolves.toMatchObject({ transition: 'migrating' });
  });

  // migrating does not need a lifecycle pane read to reconcile its transition
  it('reuses the dashboard pane snapshot while a process stack is migrating', async () => {
    const tmux = fakeTmux();
    const migrating = testWorktree({ ...cora, commands: { processes: { dev: 'pnpm dev' }, migrate: 'pnpm migrate' } });
    const service = new WorktreeCommandService(config, { worktreesNow: () => [migrating] } as never, tmux.command);
    const path = `/tmp/tmux-${process.getuid?.() ?? 0}/default`;
    const snapshots = new Map([[path, { status: 'available' as const, panes: [] }]]);

    await expect(service.start(migrating.id, 'migrate')).resolves.toBe('started');
    const listings = tmux.calls.filter(args => args.includes('list-panes')).length;
    await expect(service.state(migrating, snapshots)).resolves.toMatchObject({ running: false, transition: 'migrating' });
    expect(tmux.calls.filter(args => args.includes('list-panes'))).toHaveLength(listings);
  });

  // A shell the operator split into the process window carries the window's tags but not the
  // pane's process role: it never reads as the process, is never sent Ctrl+C or waited on, and
  // goes with the window
  it('ignores an operator split of the process window, and removes the window once', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev', true, 1);
    const kills: string[][] = [];
    // the split: the same window and tags, a live shell, and no `@rac_role`
    const withSplit = async (binary: string, args: string[]) => {
      if (args[0] === 'kill-window') kills.push(args);
      const result = await tmux.command(binary, args);
      if (args[0] !== 'list-panes' || result.code !== 0) return result;
      const own = result.stdout.split('\n').find(line => line.includes(`\t${dev.paneId}\t`));
      if (own === undefined) return result;
      const [sessionId, windowId, , , , , place, , name, ...path] = own.split('\t');
      return { ...result, stdout: `${result.stdout}${[sessionId, windowId, '%99', '0', '', '', place, '', name, ...path].join('\t')}\n` };
    };
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, withSplit, undefined, undefined, undefined, { timeoutMs: 5_000, pollMs: 5 });
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'exited', exitCode: 1 }] });

    const began = Date.now();
    await expect(service.start(cora.id, 'stop')).resolves.toBe('started');
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(tmux.events.filter(event => event.startsWith('keys'))).toEqual([]);
    expect(kills).toEqual([['kill-window', '-t', dev.id]]);
  });

  // a double-click cannot stop and start the process twice; the badge says what is under way
  it('reports a Stop in flight as the operation, and refuses another process action meanwhile', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const service = stoppingService(tmux, { timeoutMs: 5_000, pollMs: 5 });
    await service.start(cora.id, 'start');
    await expect(service.state(cora)).resolves.toMatchObject({ transition: 'starting' });
    // it outlives Ctrl+C until the test lets it exit, well inside the budget
    const [dev] = processWindows(tmux);
    dev!.ignoresInterrupt = true;

    const stopping = service.start(cora.id, 'stop');
    await vi.waitFor(() => { expect(tmux.events).toContain(`keys ${dev!.paneId} C-c`); });
    // Stopping, not Starting, while the Stop is under way
    await expect(service.state(cora)).resolves.toEqual({ operation: 'stop', running: true, processes: [{ name: 'dev', state: 'running' }] });
    await expect(service.start(cora.id, 'start')).resolves.toBe('busy');
    await expect(service.start(cora.id, 'restart')).resolves.toBe('busy');
    Object.assign(dev!, { dead: true, status: 0 });
    await expect(stopping).resolves.toBe('started');
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
  });

  it('fails Stop and Restart, without throwing, when tmux cannot run', async () => {
    const tmux = fakeTmux();
    tmux.state.fail = true;
    const service = stoppingService(tmux);
    await expect(service.start(cora.id, 'stop')).resolves.toBe(false);
    await expect(service.start(cora.id, 'restart')).resolves.toBe(false);
  });

  // the operator may close the window themselves while Stop waits on it
  it('counts a process window that vanished during Stop as stopped', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => {
      if (args[0] === 'copy-mode') tmux.windows.splice(tmux.windows.indexOf(dev), 1);
      return await tmux.command(binary, args);
    }, undefined, undefined, undefined, stopTiming);
    await expect(service.start(cora.id, 'stop')).resolves.toBe('started');
    await expect(service.state(cora)).resolves.toEqual({ running: false, processes: [{ name: 'dev', state: 'stopped' }] });
  });

  it('fails Stop when the process window cannot be removed', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => args[0] === 'kill-window' ? { code: 1, stdout: '', stderr: 'kill failed' } : await tmux.command(binary, args), undefined, undefined, undefined, stopTiming);
    await expect(service.start(cora.id, 'stop')).resolves.toBe(false);
    // a Restart needs no kill: it reruns the command in the window it keeps
    await expect(service.start(cora.id, 'restart')).resolves.toBe('started');
    expect(processWindows(tmux)).toHaveLength(1);
  });

  // Remove names only a process it would actually stop: a live one
  it('names a running process as the one Remove stops, and nothing else', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    tmux.seedProcess('dana', '/worktrees/dana', 'dev', true, 1);
    const service = stoppingService(tmux);
    await expect(service.runningProcesses(cora)).resolves.toEqual(['dev']);
    // an exited process, a stopped one, and a Worktree with no process have nothing to stop
    await expect(service.runningProcesses(dana)).resolves.toEqual([]);
    await expect(service.runningProcesses(erin)).resolves.toEqual([]);
    await expect(service.runningProcesses(worktree)).resolves.toEqual([]);
  });

  it("stops the process for Remove with the Stack process's Stop: Ctrl+C, then a kill", async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    dev.ignoresInterrupt = true;
    const service = stoppingService(tmux);

    // the checkout goes only once the process is stopped, and no Start gets in meanwhile
    const removal = service.stopForRemoval(cora, async () => {
      tmux.events.push('remove');
      await expect(service.state(cora)).resolves.toEqual({ operation: 'stop', running: false, processes: [{ name: 'dev', state: 'stopped' }] });
      await expect(service.start(cora.id, 'start')).resolves.toBe('busy');
      return 'removed';
    });
    await expect(removal).resolves.toBe('removed');
    expect(tmux.events.filter(event => event.startsWith('keys') || event.startsWith('kill') || event === 'remove')).toEqual([`keys ${dev.paneId} C-c`, `kill ${dev.id}`, 'remove']);
    expect(processWindows(tmux)).toEqual([]);
  });

  // only the one-shot operation session blocks Remove; a live process window is never one
  it('never reads a live Stack process as a running stack command', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const service = stoppingService(tmux);
    await expect(service.start(cora.id, 'start')).resolves.toBe('started');
    await expect(service.state(cora)).resolves.toMatchObject({ running: true });
    await expect(service.sessionRunning(cora)).resolves.toBe(false);
  });

  // Remove never runs a daemon-style stack's own `stop` command; it stops only a Stack process
  it('has nothing to stop for Remove without a Stack process, and asks tmux nothing', async () => {
    const calls: string[][] = [];
    const daemon = testWorktree({ ...cora, commands: { start: 'docker compose up -d', stop: 'docker compose down' } });
    const service = new WorktreeCommandService(config, { worktreesNow: () => [daemon] } as never, async (_binary, args) => { calls.push(args); return { code: 0, stdout: '' }; });
    await expect(service.stopForRemoval(daemon, async () => 'removed')).resolves.toBe('removed');
    await expect(service.runningProcesses(daemon)).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses Remove's stop while a process action is in flight, and fails it when tmux cannot run", async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const dev = tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    dev.ignoresInterrupt = true;
    const service = stoppingService(tmux, { timeoutMs: 5_000, pollMs: 5 });
    const stopping = service.start(cora.id, 'stop');
    await vi.waitFor(() => { expect(tmux.events).toContain(`keys ${dev.paneId} C-c`); });
    const removals: string[] = [];
    await expect(service.stopForRemoval(cora, async () => { removals.push('cora'); })).resolves.toBe('busy');
    Object.assign(dev, { dead: true, status: 0 });
    await expect(stopping).resolves.toBe('started');

    const failing = fakeTmux();
    failing.state.fail = true;
    await expect(stoppingService(failing).stopForRemoval(cora, async () => { removals.push('cora'); })).resolves.toBe(false);
    expect(removals).toEqual([]);
  });

  it('runs a one-shot build beside the process on its existing path', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('cora', '/worktrees/cora', 'dev');
    const oneShot: string[][] = [];
    const service = new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, async (binary, args) => { if (args.includes('new-session')) { oneShot.push(args); return { code: 0, stdout: '' }; } return await tmux.command(binary, args); });
    await expect(service.start(cora.id, 'build')).resolves.toBe('started');
    expect(oneShot[0]?.[oneShot[0].indexOf('-s') + 1]).toMatch(/^rac-stack-proj-[0-9a-f]{12}-.+-exclusive$/u);
    expect(oneShot[0]?.at(-1)).toContain('pnpm build');
  });
});

// several Stack processes run as one stack: Start in config order, Stop in reverse
describe('worktree with several Stack processes', () => {
  quietWarnings();
  const fern = testWorktree({ id: 'proj:/worktrees/fern', projectId: 'proj', path: '/worktrees/fern', main: false, commands: { processes: { sync: 'ods exec sync', api: 'ods exec api', web: 'ods exec web' }, build: 'pnpm build' } });
  const stopTiming = { timeoutMs: 60, pollMs: 5 };
  const stackService = (tmux: ReturnType<typeof fakeTmux>, command: ReturnType<typeof fakeTmux>['command'] = tmux.command) => new WorktreeCommandService(config, { worktreesNow: () => [fern] } as never, command, undefined, undefined, undefined, stopTiming);
  const processWindows = (tmux: ReturnType<typeof fakeTmux>) => tmux.windows.filter(entry => entry.options.has('@rac_process'));
  const names = (tmux: ReturnType<typeof fakeTmux>) => processWindows(tmux).map(entry => entry.options.get('@rac_process'));
  // the Ctrl+C, kill and respawn events, each named for the process whose pane or window it hit
  const steps = (tmux: ReturnType<typeof fakeTmux>, windows: FakeWindow[]) => tmux.events.flatMap(event => {
    const [verb, target] = event.split(' ');
    const entry = windows.find(candidate => candidate.id === target || candidate.paneId === target);
    return entry === undefined || !['keys', 'kill', 'respawn'].includes(verb!) ? [] : [`${verb} ${entry.options.get('@rac_process')}`];
  });
  const seedStack = (tmux: ReturnType<typeof fakeTmux>) => {
    tmux.seedWorkspace('fern', fern.id);
    return ['sync', 'api', 'web'].map(name => tmux.seedProcess('fern', '/worktrees/fern', name));
  };
  beforeEach(() => { delete process.env.RAC_HOST_TMUX_DIR; delete process.env.RAC_HOST_PATH; });

  it('derives one Start, Stop and Restart for the whole stack, beside its one-shot build', () => {
    expect(stackService(fakeTmux()).actions(fern)).toEqual(['start', 'stop', 'build', 'restart']);
  });

  it('starts every process in config order, in the one Workspace session the first creates', async () => {
    const tmux = fakeTmux();
    const service = stackService(tmux);

    await expect(service.start(fern.id, 'start')).resolves.toBe('started');
    expect([...tmux.sessions.keys()]).toEqual(['fern']);
    expect(tmux.sessions.get('fern')?.get('@rac_place')).toBe(fern.id);
    expect(names(tmux)).toEqual(['sync', 'api', 'web']);
    expect(processWindows(tmux).map(entry => entry.command.at(-1))).toEqual([expect.stringContaining('ods exec sync'), expect.stringContaining('ods exec api'), expect.stringContaining('ods exec web')]);
    await expect(service.state(fern)).resolves.toEqual({ running: true, transition: 'starting', processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'running' }, { name: 'web', state: 'running' }] });
  });

  it('leaves a live process alone and starts the rest', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('fern', fern.id);
    const api = tmux.seedProcess('fern', '/worktrees/fern', 'api');
    await expect(stackService(tmux).start(fern.id, 'start')).resolves.toBe('started');
    expect(names(tmux)).toEqual(['api', 'sync', 'web']);
    expect(tmux.events).not.toContain(`respawn ${api.id}`);
  });

  it('stops every process in reverse config order: Ctrl+C, then its window', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    const service = stackService(tmux);

    await expect(service.start(fern.id, 'stop')).resolves.toBe('started');
    expect(steps(tmux, windows)).toEqual(['keys web', 'kill web', 'keys api', 'kill api', 'keys sync', 'kill sync']);
    expect(processWindows(tmux)).toEqual([]);
    await expect(service.state(fern)).resolves.toEqual({ running: false, processes: [{ name: 'sync', state: 'stopped' }, { name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped' }] });
  });

  // every process is stopped before any is rerun, each in the window it keeps
  it('restarts every process in its own pane: stops in reverse, then reruns in order', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    await expect(stackService(tmux).start(fern.id, 'restart')).resolves.toBe('started');
    expect(steps(tmux, windows)).toEqual(['keys web', 'keys api', 'keys sync', 'respawn sync', 'respawn api', 'respawn web']);
    expect(processWindows(tmux)).toEqual(windows);
  });

  it('ends a Start at the first process that fails, leaving those already started running', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('fern', fern.id);
    const service = stackService(tmux, async (binary, args) => args[0] === 'respawn-pane' && args.at(-1)?.includes('ods exec api') === true ? { code: 1, stdout: '', stderr: 'respawn failed' } : await tmux.command(binary, args));

    await expect(service.start(fern.id, 'start')).resolves.toBe(false);
    expect(names(tmux)).toEqual(['sync']);
    await expect(service.state(fern)).resolves.toMatchObject({ processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped' }] });
  });

  it('ends a Stop at the first process it cannot stop, leaving the rest running', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    const web = windows[2]!;
    const service = stackService(tmux, async (binary, args) => args[0] === 'kill-window' && args.at(-1) === web.id ? { code: 1, stdout: '', stderr: 'kill failed' } : await tmux.command(binary, args));

    await expect(service.start(fern.id, 'stop')).resolves.toBe(false);
    expect(steps(tmux, windows)).toEqual(['keys web']);
    expect(names(tmux)).toEqual(['sync', 'api', 'web']);
  });

  // `running` summarises the stack only when every process agrees; the list says the rest
  it('reports running only when every process runs, stopped only when none does', async () => {
    const tmux = fakeTmux();
    tmux.seedProcess('fern', '/worktrees/fern', 'sync');
    tmux.seedProcess('fern', '/worktrees/fern', 'api', true, 1);
    const service = stackService(tmux);
    await expect(service.state(fern)).resolves.toEqual({ processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'exited', exitCode: 1 }, { name: 'web', state: 'stopped' }] });

    tmux.seedProcess('fern', '/worktrees/fern', 'web', true, 2);
    Object.assign(tmux.windows.find(entry => entry.options.get('@rac_process') === 'sync')!, { dead: true, status: 0 });
    await expect(service.state(fern)).resolves.toEqual({ running: false, processes: [{ name: 'sync', state: 'exited', exitCode: 0 }, { name: 'api', state: 'exited', exitCode: 1 }, { name: 'web', state: 'exited', exitCode: 2 }] });
  });

  it('names every running process as one Remove stops, and stops them in reverse order first', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    Object.assign(windows[1]!, { dead: true, status: 1 });
    const service = stackService(tmux);
    await expect(service.runningProcesses(fern)).resolves.toEqual(['sync', 'web']);

    await expect(service.stopForRemoval(fern, async () => { tmux.events.push('remove'); return 'removed'; })).resolves.toBe('removed');
    expect([...steps(tmux, windows), tmux.events.at(-1)]).toEqual(['keys web', 'kill web', 'kill api', 'keys sync', 'kill sync', 'remove']);
  });

  it('starts one process and leaves the others alone', async () => {
    const tmux = fakeTmux();
    tmux.seedWorkspace('fern', fern.id);
    const sync = tmux.seedProcess('fern', '/worktrees/fern', 'sync');
    const service = stackService(tmux);

    await expect(service.start(fern.id, 'start', 'api')).resolves.toBe('started');
    expect(names(tmux)).toEqual(['sync', 'api']);
    expect(tmux.events).not.toContain(`respawn ${sync.id}`);
    expect(processWindows(tmux).at(-1)?.command.at(-1)).toContain('ods exec api');
    // a live process is left alone, as on the whole stack
    await expect(service.start(fern.id, 'start', 'api')).resolves.toBe('started');
    expect(names(tmux)).toEqual(['sync', 'api']);
  });

  it('stops one process and leaves the others running', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    const service = stackService(tmux);

    await expect(service.start(fern.id, 'stop', 'api')).resolves.toBe('started');
    expect(steps(tmux, windows)).toEqual(['keys api', 'kill api']);
    expect(names(tmux)).toEqual(['sync', 'web']);
    await expect(service.state(fern)).resolves.toEqual({ processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'stopped' }, { name: 'web', state: 'running' }] });
  });

  it('restarts one process in its own pane, and none of the others', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    await expect(stackService(tmux).start(fern.id, 'restart', 'api')).resolves.toBe('started');
    expect(steps(tmux, windows)).toEqual(['keys api', 'respawn api']);
    expect(processWindows(tmux)).toEqual(windows);
    expect(windows[1]!.command.at(-1)).toContain('ods exec api');
  });

  it('refuses a name not configured, a one-shot action, and a Worktree without processes, asking tmux nothing', async () => {
    const gale = testWorktree({ id: 'proj:/worktrees/gale', projectId: 'proj', path: '/worktrees/gale', main: false, commands: { start: 'docker compose up -d', stop: 'docker compose down', restart: 'docker compose restart', build: 'pnpm build' } });
    const tmux = fakeTmux();
    const service = new WorktreeCommandService(config, { worktreesNow: () => [fern, gale] } as never, tmux.command, undefined, undefined, undefined, stopTiming);

    await expect(service.start(fern.id, 'start', 'nope')).resolves.toBe(false);
    await expect(service.start(fern.id, 'build', 'api')).resolves.toBe(false);
    await expect(service.start(gale.id, 'start', 'api')).resolves.toBe(false);
    await expect(service.start('proj:/worktrees/gone', 'start', 'api')).resolves.toBe(false);
    expect(tmux.calls).toEqual([]);
  });

  // one guard covers the whole stack and each of its processes, whichever came first
  it('refuses a process action during a whole-stack one, and a whole-stack one during a process action', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    const holly = testWorktree({ id: 'proj:/worktrees/holly', projectId: 'proj', path: '/worktrees/holly', main: false, commands: { processes: { sync: 'ods exec sync', api: 'ods exec api' } } });
    tmux.seedWorkspace('holly', holly.id);
    const slow = new WorktreeCommandService(config, { worktreesNow: () => [fern, holly] } as never, tmux.command, undefined, undefined, undefined, { timeoutMs: 5_000, pollMs: 5 });
    const web = windows[2]!;
    web.ignoresInterrupt = true;

    const stopping = slow.start(fern.id, 'stop');
    await vi.waitFor(() => { expect(tmux.events).toContain(`keys ${web.paneId} C-c`); });
    await expect(slow.start(fern.id, 'restart', 'api')).resolves.toBe('busy');
    await expect(slow.start(fern.id, 'start', 'web')).resolves.toBe('busy');
    Object.assign(web, { dead: true, status: 0 });
    await expect(stopping).resolves.toBe('started');

    const api = tmux.seedProcess('fern', '/worktrees/fern', 'api');
    api.ignoresInterrupt = true;
    const stoppingApi = slow.start(fern.id, 'stop', 'api');
    await vi.waitFor(() => { expect(tmux.events).toContain(`keys ${api.paneId} C-c`); });
    await expect(slow.start(fern.id, 'start')).resolves.toBe('busy');
    await expect(slow.start(fern.id, 'start', 'sync')).resolves.toBe('busy');
    // the guard is per Worktree
    await expect(slow.start(holly.id, 'start', 'api')).resolves.toBe('started');
    Object.assign(api, { dead: true, status: 0 });
    await expect(stoppingApi).resolves.toBe('started');
    // and gone once the action ends
    await expect(slow.start(fern.id, 'start', 'sync')).resolves.toBe('started');
  });

  // the menu shows "Restarting…" on the process, not on the whole stack
  it('reports a process action in flight on its own process, not as the stack operation', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    const api = windows[1]!;
    api.ignoresInterrupt = true;
    const service = new WorktreeCommandService(config, { worktreesNow: () => [fern] } as never, tmux.command, undefined, undefined, undefined, { timeoutMs: 5_000, pollMs: 5 });

    const restarting = service.start(fern.id, 'restart', 'api');
    await vi.waitFor(() => { expect(tmux.events).toContain(`keys ${api.paneId} C-c`); });
    await expect(service.state(fern)).resolves.toEqual({ running: true, processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'running', operation: 'restart' }, { name: 'web', state: 'running' }] });
    Object.assign(api, { dead: true, status: 0 });
    await expect(restarting).resolves.toBe('started');
    await expect(service.state(fern)).resolves.toEqual({ running: true, transition: 'starting', processes: [{ name: 'sync', state: 'running' }, { name: 'api', state: 'running' }, { name: 'web', state: 'running' }] });
  });

  // a one-shot build is no process action, so one process's action in flight never hides it
  it('reports a one-shot build as the stack operation while one process restarts', async () => {
    const tmux = fakeTmux();
    const windows = seedStack(tmux);
    const api = windows[1]!;
    api.ignoresInterrupt = true;
    const buildSession = `=${stackSession('proj', '/worktrees/fern').replace('-build-', '-start-')}`;
    const command: ReturnType<typeof fakeTmux>['command'] = async (binary, args) => {
      if (args[0] === 'new-session' && args.at(-1)?.includes('pnpm build') === true) return { code: 0, stdout: '' };
      if (args[0] === 'has-session' && args.at(-1) === buildSession) return { code: 0, stdout: '' };
      return await tmux.command(binary, args);
    };
    const service = new WorktreeCommandService(config, { worktreesNow: () => [fern] } as never, command, undefined, undefined, undefined, { timeoutMs: 5_000, pollMs: 5 });

    const restarting = service.start(fern.id, 'restart', 'api');
    await vi.waitFor(() => { expect(tmux.events).toContain(`keys ${api.paneId} C-c`); });
    await expect(service.start(fern.id, 'build')).resolves.toBe('started');
    await expect(service.state(fern)).resolves.toMatchObject({ operation: 'build', processes: [{ name: 'sync' }, { name: 'api', operation: 'restart' }, { name: 'web' }] });
    Object.assign(api, { dead: true, status: 0 });
    await expect(restarting).resolves.toBe('started');
  });

  // Starting waits on the whole stack's Project; one process stopping does not end that wait
  it("keeps the stack's Starting wait across one process's Stop, and ends it on the whole stack's", async () => {
    const tmux = fakeTmux();
    const service = stackService(tmux);
    await expect(service.start(fern.id, 'start')).resolves.toBe('started');
    await expect(service.start(fern.id, 'stop', 'api')).resolves.toBe('started');
    await expect(service.state(fern)).resolves.toMatchObject({ transition: 'starting' });
    await expect(service.start(fern.id, 'restart', 'api')).resolves.toBe('started');
    await expect(service.state(fern)).resolves.toMatchObject({ running: true, transition: 'starting' });
    await expect(service.start(fern.id, 'stop')).resolves.toBe('started');
    await expect(service.state(fern)).resolves.toEqual({ running: false, processes: [{ name: 'sync', state: 'stopped' }, { name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped' }] });
  });

  it('runs a one-shot build beside the live processes', async () => {
    const tmux = fakeTmux();
    seedStack(tmux);
    const oneShot: string[][] = [];
    const service = stackService(tmux, async (binary, args) => { if (args.includes('new-session')) { oneShot.push(args); return { code: 0, stdout: '' }; } return await tmux.command(binary, args); });
    await expect(service.start(fern.id, 'build')).resolves.toBe('started');
    expect(oneShot[0]?.at(-1)).toContain('pnpm build');
    expect(names(tmux)).toEqual(['sync', 'api', 'web']);
  });
});

// `web` needs `api`, which needs `sync`; `docs` needs nothing. Config order is the display
// order, so the start order is sync, api, web, docs: dependencies first, ties by config order.
describe('Stack processes ordered by dependsOn', () => {
  quietWarnings();
  const ivy = testWorktree({ id: 'proj:/worktrees/ivy', projectId: 'proj', path: '/worktrees/ivy', main: false, commands: { processes: { web: { command: 'ods exec web', dependsOn: ['api'] }, api: { command: 'ods exec api', dependsOn: ['sync'] }, sync: 'ods exec sync', docs: { command: 'ods exec docs' } } } });
  const stopTiming = { timeoutMs: 60, pollMs: 5 };
  // every window seen before each tmux call, by window and pane id, so `steps` can still name
  // one a Stop has since removed
  const seen = new Map<string, FakeWindow>();
  const remember = (tmux: ReturnType<typeof fakeTmux>) => { for (const entry of tmux.windows) seen.set(entry.id, entry).set(entry.paneId, entry); };
  const stackService = (tmux: ReturnType<typeof fakeTmux>, command: ReturnType<typeof fakeTmux>['command'] = tmux.command) => new WorktreeCommandService(config, { worktreesNow: () => [ivy] } as never, async (binary, args) => { remember(tmux); return await command(binary, args); }, undefined, undefined, undefined, stopTiming);
  const names = (tmux: ReturnType<typeof fakeTmux>) => tmux.windows.filter(entry => entry.options.has('@rac_process')).map(entry => entry.options.get('@rac_process'));
  // the Ctrl+C, kill and respawn events, each named for the process whose pane or window it hit
  const steps = (tmux: ReturnType<typeof fakeTmux>) => {
    remember(tmux);
    return tmux.events.flatMap(event => {
      const [verb, target] = event.split(' ');
      if (!['keys', 'kill', 'respawn'].includes(verb!)) return [];
      const entry = seen.get(target!);
      if (entry === undefined) throw new Error(`no window for ${event}`);
      return [`${verb} ${entry.options.get('@rac_process')}`];
    });
  };
  const seed = (tmux: ReturnType<typeof fakeTmux>, processes: string[]) => {
    tmux.seedWorkspace('ivy', ivy.id);
    for (const name of processes) tmux.seedProcess('ivy', '/worktrees/ivy', name);
  };
  const allStopped = [{ name: 'web', state: 'stopped', dependsOn: ['api'] }, { name: 'api', state: 'stopped', dependsOn: ['sync'] }, { name: 'sync', state: 'stopped' }, { name: 'docs', state: 'stopped' }];
  beforeEach(() => { delete process.env.RAC_HOST_TMUX_DIR; delete process.env.RAC_HOST_PATH; seen.clear(); });

  it('starts the whole stack dependencies first, and lists it in config order', async () => {
    const tmux = fakeTmux();
    const service = stackService(tmux);
    await expect(service.start(ivy.id, 'start')).resolves.toBe('started');
    expect(names(tmux)).toEqual(['sync', 'api', 'web', 'docs']);
    await expect(service.state(ivy)).resolves.toMatchObject({ running: true, processes: [{ name: 'web' }, { name: 'api' }, { name: 'sync' }, { name: 'docs' }] });
  });

  it('stops the whole stack in reverse start order, dependants first', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['web', 'api', 'sync', 'docs']);
    const service = stackService(tmux);
    await expect(service.start(ivy.id, 'stop')).resolves.toBe('started');
    expect(steps(tmux)).toEqual(['keys docs', 'kill docs', 'keys web', 'kill web', 'keys api', 'kill api', 'keys sync', 'kill sync']);
    await expect(service.state(ivy)).resolves.toEqual({ running: false, processes: allStopped });
  });

  it('restarts the whole stack: stops in reverse start order, then reruns in start order', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['web', 'api', 'sync', 'docs']);
    await expect(stackService(tmux).start(ivy.id, 'restart')).resolves.toBe('started');
    expect(steps(tmux)).toEqual(['keys docs', 'keys web', 'keys api', 'keys sync', 'respawn sync', 'respawn api', 'respawn web', 'respawn docs']);
  });

  it('starts one process after everything it transitively depends on, and nothing else', async () => {
    const tmux = fakeTmux();
    const service = stackService(tmux);
    await expect(service.start(ivy.id, 'start', 'web')).resolves.toBe('started');
    expect(names(tmux)).toEqual(['sync', 'api', 'web']);
    await expect(service.state(ivy)).resolves.toEqual({ transition: 'starting', processes: [{ name: 'web', state: 'running', dependsOn: ['api'] }, { name: 'api', state: 'running', dependsOn: ['sync'] }, { name: 'sync', state: 'running' }, { name: 'docs', state: 'stopped' }] });
  });

  // `api` runs, but `sync` beneath it does not: only `sync` and `web` start
  it('leaves a running dependency alone and starts the ones that are not running', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['api']);
    await expect(stackService(tmux).start(ivy.id, 'start', 'web')).resolves.toBe('started');
    expect(names(tmux)).toEqual(['api', 'sync', 'web']);
    expect(steps(tmux)).toEqual(['respawn sync', 'respawn web']);
  });

  it('restarts only the one process, starting a dependency that is not running', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['web', 'api']);
    await expect(stackService(tmux).start(ivy.id, 'restart', 'api')).resolves.toBe('started');
    expect(steps(tmux)).toEqual(['respawn sync', 'keys api', 'respawn api']);
    expect(names(tmux)).toEqual(['web', 'api', 'sync']);
  });

  // `api` runs and `sync` does not: `sync` starts, `api` is neither interrupted nor rerun
  it('restarts one process without rerunning a dependency that is running', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['web', 'api']);
    await expect(stackService(tmux).start(ivy.id, 'restart', 'web')).resolves.toBe('started');
    expect(steps(tmux)).toEqual(['respawn sync', 'keys web', 'respawn web']);
  });

  it('leaves the process running when a dependency its Restart starts fails', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['web', 'api']);
    const service = stackService(tmux, async (binary, args) => args[0] === 'respawn-pane' && args.at(-1)?.includes('ods exec sync') === true ? { code: 1, stdout: '', stderr: 'respawn failed' } : await tmux.command(binary, args));
    await expect(service.start(ivy.id, 'restart', 'api')).resolves.toBe(false);
    // only the fresh `sync` window, left on its placeholder, is removed; `api` is never touched
    expect(steps(tmux)).toEqual(['kill sync']);
    await expect(service.state(ivy)).resolves.toMatchObject({ processes: [{ name: 'web', state: 'running' }, { name: 'api', state: 'running' }, { name: 'sync', state: 'stopped' }, { name: 'docs', state: 'stopped' }] });
  });

  it('stops one process and leaves its dependants running', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['web', 'api', 'sync']);
    await expect(stackService(tmux).start(ivy.id, 'stop', 'sync')).resolves.toBe('started');
    expect(steps(tmux)).toEqual(['keys sync', 'kill sync']);
    expect(names(tmux)).toEqual(['web', 'api']);
  });

  it('ends a one-process Start at the dependency that fails, starting nothing after it', async () => {
    const tmux = fakeTmux();
    const service = stackService(tmux, async (binary, args) => args[0] === 'respawn-pane' && args.at(-1)?.includes('ods exec api') === true ? { code: 1, stdout: '', stderr: 'respawn failed' } : await tmux.command(binary, args));
    await expect(service.start(ivy.id, 'start', 'web')).resolves.toBe(false);
    expect(names(tmux)).toEqual(['sync']);
  });

  it('stops everything for Remove in reverse start order', async () => {
    const tmux = fakeTmux();
    seed(tmux, ['web', 'api', 'sync', 'docs']);
    await expect(stackService(tmux).stopForRemoval(ivy, async () => 'removed')).resolves.toBe('removed');
    expect(steps(tmux).filter(step => step.startsWith('kill'))).toEqual(['kill docs', 'kill web', 'kill api', 'kill sync']);
  });
});

describe('Stack process log file', () => {
  const warn = quietWarnings();
  const stopTiming = { timeoutMs: 60, pollMs: 5 };
  const repositories: string[] = [];
  beforeEach(() => { delete process.env.RAC_HOST_TMUX_DIR; delete process.env.RAC_HOST_PATH; });
  afterEach(async () => { for (const root of repositories.splice(0)) await rm(root, { recursive: true, force: true }); });
  // a real repository with one commit and a Linked worktree beside it, so git names the git
  // directory as it does for a Worktree the console discovered
  const repository = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-process-log-')));
    repositories.push(root);
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'ignore' });
    git('init', '-q', main);
    git('-C', main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git('-C', main, 'worktree', 'add', '-q', linked);
    return { root, main, linked };
  };
  // the file an agent in the checkout finds with `git rev-parse --git-path`
  const agentPath = (checkout: string, name: string) => execFileSync('/usr/bin/git', ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-path', `rac/processes/${name}.log`], { encoding: 'utf8' }).trim();
  const service = (tmux: ReturnType<typeof fakeTmux>, worktrees: Worktree[]) => new WorktreeCommandService(config, { worktreesNow: () => worktrees } as never, tmux.command, undefined, undefined, undefined, stopTiming);
  const pipeTo = (file: string) => `umask 077; rm -f -- '${file}'; set -C; exec cat > '${file}'`;
  const processWindow = (tmux: ReturnType<typeof fakeTmux>, name: string) => tmux.windows.find(entry => entry.options.get('@rac_process') === name);
  // the pipes and respawns on one window, in order, each respawn named for what it ran: the
  // placeholder, or the process's command
  const pipesAndRespawns = (tmux: ReturnType<typeof fakeTmux>, window: FakeWindow) => {
    const runs = [...window.runs ?? []];
    return tmux.events.flatMap(event => {
      const [verb, target, ...rest] = event.split(' ');
      if (target !== window.id) return [];
      if (verb === 'pipe') return [`pipe ${rest.join(' ')}`];
      return verb === 'respawn' ? [runs.shift()?.at(-1) === 'sleep 30' ? 'placeholder' : 'command'] : [];
    });
  };

  it("reads a Stack process's log file's tail, only for a process the Worktree declares, never through a link", async () => {
    const { main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { dev: 'pnpm dev', web: 'pnpm web' } } });
    const commands = service(fakeTmux(), [cora]);
    await mkdir(dirname(agentPath(main, 'dev')), { recursive: true });
    await writeFile(agentPath(main, 'dev'), 'ready on :3000\n\u001b[31merror\u001b[0m: crashed\n');

    await expect(commands.processLog(cora.id, 'dev')).resolves.toEqual({ name: 'dev', path: agentPath(main, 'dev'), output: 'ready on :3000\nerror: crashed\n' });
    // a declared process that never ran has an empty log
    await expect(commands.processLog(cora.id, 'web')).resolves.toEqual({ name: 'web', path: agentPath(main, 'web'), output: '' });
    await expect(commands.processLog(cora.id, 'other')).resolves.toBeUndefined();
    // a log an agent in the checkout swapped for a link is not followed
    await writeFile(join(main, 'secret.txt'), 'secret');
    const webLog = agentPath(main, 'web');
    await symlink(join(main, 'secret.txt'), webLog);
    await expect(commands.processLog(cora.id, 'web')).resolves.toEqual({ name: 'web', path: webLog, output: '' });
    // nor one swapped for a FIFO, which would block the read forever
    const devLog = agentPath(main, 'dev');
    await unlinkFile(devLog);
    execFileSync('mkfifo', [devLog]);
    await expect(commands.processLog(cora.id, 'dev')).resolves.toEqual({ name: 'dev', path: devLog, output: '' });
  });

  it("pipes a new process window into a fresh log in the Main worktree's git directory before its command runs", async () => {
    const { main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);

    await expect(service(tmux, [cora]).start(cora.id, 'start')).resolves.toBe('started');

    const window = processWindow(tmux, 'dev')!;
    const file = agentPath(main, 'dev');
    expect(file).toBe(join(main, '.git', 'rac', 'processes', 'dev.log'));
    // made private to the operator
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
    // piped while the placeholder runs, then respawned with the command
    expect(pipesAndRespawns(tmux, window)).toEqual([`pipe ${pipeTo(file)}`, 'command']);
    expect(window.command.at(-1)).toContain('pnpm dev');
    expect(window.pipe).toBe(pipeTo(file));
    // git never lists it
    expect(execFileSync('/usr/bin/git', ['-C', main, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' })).toBe('');
  });

  it("writes a Linked worktree's log in its own git directory", async () => {
    const { main, linked } = await repository();
    const dana = testWorktree({ id: `proj:${linked}`, projectId: 'proj', path: linked, main: false, commands: { processes: { web: 'pnpm web' } } });
    const tmux = fakeTmux();

    await expect(service(tmux, [dana]).start(dana.id, 'start')).resolves.toBe('started');

    const file = agentPath(linked, 'web');
    expect(file).toBe(join(main, '.git', 'worktrees', 'linked', 'rac', 'processes', 'web.log'));
    expect((await stat(dirname(file))).isDirectory()).toBe(true);
    expect(processWindow(tmux, 'web')?.pipe).toBe(pipeTo(file));
  });

  // a bridged console sees the checkout at its own path; the host tmux writes the file where it
  // sees it, under the Worktree's host path
  it('pipes to the host path of a bridged checkout, and makes the directory at its own', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const { main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, hostPath: '/host/cora', commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();

    await expect(service(tmux, [cora]).start(cora.id, 'start')).resolves.toBe('started');

    expect((await stat(join(main, '.git', 'rac', 'processes'))).isDirectory()).toBe(true);
    expect(processWindow(tmux, 'dev')?.pipe).toBe(pipeTo('/host/cora/.git/rac/processes/dev.log'));
  });

  // tmux refuses to pipe a dead pane, so an exited process reruns the placeholder to take the pipe
  it('pipes an exited process pane, through the placeholder, before its command reruns', async () => {
    const { main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    const crashed = tmux.seedProcess('cora', main, 'dev', true, 1);

    await expect(service(tmux, [cora]).start(cora.id, 'start')).resolves.toBe('started');

    const file = agentPath(main, 'dev');
    expect(pipesAndRespawns(tmux, crashed)).toEqual(['placeholder', `pipe ${pipeTo(file)}`, 'command']);
    expect(crashed.command.at(-1)).toContain('pnpm dev');
  });

  it("pipes a restarted process's pane afresh before its command reruns, the whole stack's or its own", async () => {
    const { main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { api: 'pnpm api', web: 'pnpm web' } } });
    const file = agentPath(main, 'web');
    for (const target of [undefined, 'web'] as const) {
      // one pane that dies on Ctrl+C, and one that outlives it with its old pipe still open
      for (const ignoresInterrupt of [false, true]) {
        const tmux = fakeTmux();
        tmux.seedWorkspace('cora', cora.id);
        const web = tmux.seedProcess('cora', main, 'web');
        Object.assign(web, { pipe: 'the previous run', ignoresInterrupt });

        await expect(service(tmux, [cora]).start(cora.id, 'restart', target)).resolves.toBe('started');

        expect(pipesAndRespawns(tmux, web)).toEqual(['placeholder', `pipe ${pipeTo(file)}`, 'command']);
        expect(web.command.at(-1)).toContain('pnpm web');
        expect(web.pipe).toBe(pipeTo(file));
      }
    }
  });

  // a checkout path carrying a format or a strftime sequence reaches the pipe literally
  it('quotes the log path for the shell and for tmux format expansion', async () => {
    const { root } = await repository();
    const checkout = join(root, "it's #{pid} %d");
    execFileSync('/usr/bin/git', ['init', '-q', checkout]);
    const odd = testWorktree({ id: `proj:${checkout}`, projectId: 'proj', path: checkout, commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();

    await expect(service(tmux, [odd]).start(odd.id, 'start')).resolves.toBe('started');

    const quoted = `'${root}/it'\\''s #{pid} %d/.git/rac/processes/dev.log'`;
    expect(processWindow(tmux, 'dev')?.pipe).toBe(`umask 077; rm -f -- ${quoted}; set -C; exec cat > ${quoted}`);
    expect(tmux.formatCommands).toEqual([]);
  });

  // An agent in the checkout can put a symlink where the log goes. The host shell runs the
  // pipe's own command here: it replaces a symlinked log rather than writing through it, and
  // refuses a symlink put back before it creates the file.
  it('never writes through a symlink put where the log goes', async () => {
    const { root, main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();
    await service(tmux, [cora]).start(cora.id, 'start');
    const pipe = processWindow(tmux, 'dev')!.pipe!;
    const file = agentPath(main, 'dev');
    const victim = join(root, 'victim');
    await writeFile(victim, 'keep\n');

    await symlink(victim, file);
    execFileSync('/bin/sh', ['-c', pipe], { input: 'pane output\n' });
    expect(await readFile(victim, 'utf8')).toBe('keep\n');
    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('pane output\n');

    // the exclusive create after the removal: a symlink there is refused, not followed
    const create = pipe.slice(pipe.indexOf('set -C'));
    await unlinkFile(file);
    await symlink(victim, file);
    expect(() => execFileSync('/bin/sh', ['-c', `umask 077; ${create}`], { input: 'pane output\n', stdio: ['pipe', 'ignore', 'ignore'] })).toThrow();
    expect(await readFile(victim, 'utf8')).toBe('keep\n');
  });

  it('starts the process without a log when the log directory is a symlink', async () => {
    const { root, main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { dev: 'pnpm dev' } } });
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(main, '.git', 'rac'));
    const tmux = fakeTmux();

    await expect(service(tmux, [cora]).start(cora.id, 'start')).resolves.toBe('started');

    expect(tmux.calls.some(args => args.includes('pipe-pane'))).toBe(false);
    expect(processWindow(tmux, 'dev')?.command.at(-1)).toContain('pnpm dev');
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('not a directory of its own'));
  });

  it('starts the process without a log, and says so, when git cannot name its directory', async () => {
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();

    await expect(service(tmux, [cora]).start(cora.id, 'start')).resolves.toBe('started');

    expect(tmux.calls.some(args => args.includes('pipe-pane'))).toBe(false);
    expect(processWindow(tmux, 'dev')?.command.at(-1)).toContain('pnpm dev');
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('/worktrees/cora'));
  });

  // a bridged Main worktree whose git directory lies outside its checkout has no host path the
  // console can derive for it
  it('starts the process without a log when a bridged git directory lies outside the checkout', async () => {
    const { root } = await repository();
    const checkout = join(root, 'separate');
    execFileSync('/usr/bin/git', ['init', '-q', '--separate-git-dir', join(root, 'separate.git'), checkout]);
    const cora = testWorktree({ id: `proj:${checkout}`, projectId: 'proj', path: checkout, hostPath: '/host/separate', commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();

    await expect(service(tmux, [cora]).start(cora.id, 'start')).resolves.toBe('started');

    expect(tmux.calls.some(args => args.includes('pipe-pane'))).toBe(false);
    expect(processWindow(tmux, 'dev')?.command.at(-1)).toContain('pnpm dev');
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('lies outside the bridged checkout'));
  });

  // a pane put back on the placeholder would read as running, so a failed rerun removes it
  it('removes a pane left on the placeholder when its command cannot be respawned', async () => {
    const { main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', main, 'dev', true, 1);
    const failing = async (binary: string, args: string[]) => args[0] === 'respawn-pane' && args.includes('/bin/bash') ? { code: 1, stdout: '', stderr: 'respawn failed' } : await tmux.command(binary, args);

    await expect(new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, failing).start(cora.id, 'start')).resolves.toBe(false);

    expect(processWindow(tmux, 'dev')).toBeUndefined();
  });

  it('asks git nothing and pipes nothing for a live process Start leaves alone, or a one-shot build', async () => {
    const { main } = await repository();
    const cora = testWorktree({ id: `proj:${main}`, projectId: 'proj', path: main, commands: { processes: { dev: 'pnpm dev' }, build: 'pnpm build' } });
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', main, 'dev');
    const instance = service(tmux, [cora]);

    await expect(instance.start(cora.id, 'start')).resolves.toBe('started');
    await expect(instance.start(cora.id, 'build')).resolves.toBe('started');

    expect(tmux.gitCalls).toEqual([]);
    expect(tmux.calls.some(args => args.includes('pipe-pane'))).toBe(false);
  });
});

describe('Stack process notices', () => {
  const warn = quietWarnings();
  const stopTiming = { timeoutMs: 60, pollMs: 5 };
  const repositories: string[] = [];
  beforeEach(() => { delete process.env.RAC_HOST_TMUX_DIR; delete process.env.RAC_HOST_PATH; });
  afterEach(async () => { for (const root of repositories.splice(0)) await rm(root, { recursive: true, force: true }); });
  // a real checkout, so git names its git directory, where each process's notices file goes
  const checkout = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-process-notices-')));
    repositories.push(root);
    execFileSync('/usr/bin/git', ['init', '-q', root]);
    return root;
  };
  const noticesFile = (root: string, name: string) => join(root, '.git', 'rac', 'processes', `${name}.notices.json`);
  const report = async (root: string, name: string, notices: unknown) => {
    await mkdir(dirname(noticesFile(root, name)), { recursive: true });
    await writeFile(noticesFile(root, name), JSON.stringify(notices));
  };
  const service = (tmux: ReturnType<typeof fakeTmux>, worktrees: Worktree[]) => new WorktreeCommandService(config, { worktreesNow: () => worktrees } as never, tmux.command, undefined, undefined, undefined, stopTiming);
  const processWindow = (tmux: ReturnType<typeof fakeTmux>, name: string) => tmux.windows.find(entry => entry.options.get('@rac_process') === name);
  // the Worktree whose process reports, and another Project's Worktree whose `static` it names
  const reporter = (root: string) => testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, commands: { processes: { api: 'ods exec api', web: 'ods exec web' } } });
  const peer = testWorktree({ id: 'site:/worktrees/static', projectId: 'site', label: 'Static · master', path: '/worktrees/static', commands: { processes: { static: 'ods exec static' } } });
  const statesOf = async (instance: WorktreeCommandService, worktree: Worktree) => (await instance.state(worktree)).processes;

  it("clears a process's notices file and names it in RAC_PROCESS_NOTICES on every Start", async () => {
    const root = await checkout();
    const cora = reporter(root);
    await report(root, 'api', [{ message: 'from the last run' }]);
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    // whether the file was still there when the command started, which could then write its own
    const leftForCommand: boolean[] = [];
    const command = async (binary: string, args: string[]) => {
      if (args[0] === 'respawn-pane' && args.includes('/bin/bash')) leftForCommand.push(existsSync(noticesFile(root, 'api')));
      return await tmux.command(binary, args);
    };

    await expect(new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, command).start(cora.id, 'start', 'api')).resolves.toBe('started');

    expect(leftForCommand).toEqual([false]);
    expect(existsSync(noticesFile(root, 'api'))).toBe(false);
    expect(processWindow(tmux, 'api')?.command.at(-1)).toContain(`export RAC_PROCESS_NOTICES='${noticesFile(root, 'api')}'; `);
  });

  it('names the host path of a bridged checkout in RAC_PROCESS_NOTICES', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const root = await checkout();
    const cora = testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, hostPath: '/host/cora', commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();

    await expect(service(tmux, [cora]).start(cora.id, 'start')).resolves.toBe('started');

    expect(processWindow(tmux, 'dev')?.command.at(-1)).toContain("export RAC_PROCESS_NOTICES='/host/cora/.git/rac/processes/dev.notices.json'; ");
  });

  it('clears the notices of a process Stop or Restart touches, and keeps those of one Start leaves alone', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', root, 'api');
    tmux.seedProcess('cora', root, 'web');
    const instance = service(tmux, [cora]);

    await report(root, 'api', [{ message: 'api' }]);
    await report(root, 'web', [{ message: 'web' }]);
    await expect(instance.start(cora.id, 'start')).resolves.toBe('started');
    expect([existsSync(noticesFile(root, 'api')), existsSync(noticesFile(root, 'web'))]).toEqual([true, true]);

    await expect(instance.start(cora.id, 'stop', 'web')).resolves.toBe('started');
    expect([existsSync(noticesFile(root, 'api')), existsSync(noticesFile(root, 'web'))]).toEqual([true, false]);

    await expect(instance.start(cora.id, 'restart', 'api')).resolves.toBe('started');
    expect(existsSync(noticesFile(root, 'api'))).toBe(false);

    await report(root, 'api', [{ message: 'api' }]);
    await report(root, 'web', [{ message: 'web' }]);
    await expect(instance.start(cora.id, 'stop')).resolves.toBe('started');
    expect([existsSync(noticesFile(root, 'api')), existsSync(noticesFile(root, 'web'))]).toEqual([false, false]);
  });

  it('makes no directory to stop a process that never had one', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const tmux = fakeTmux();
    tmux.seedProcess('cora', root, 'api');

    await expect(service(tmux, [cora]).start(cora.id, 'stop')).resolves.toBe('started');

    expect(existsSync(join(root, '.git', 'rac'))).toBe(false);
  });

  // Start refuses to write there, so a notices file behind a symlink is not one it could clear
  it('reads no notices through a symlinked directory', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const elsewhere = join(root, 'elsewhere');
    await mkdir(join(elsewhere, 'processes'), { recursive: true });
    await writeFile(join(elsewhere, 'processes', 'api.notices.json'), JSON.stringify([{ message: 'planted' }]));
    await symlink(elsewhere, join(root, '.git', 'rac'));

    await expect(statesOf(service(fakeTmux(), [cora]), cora)).resolves.toEqual([{ name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped' }]);
  });

  it('asks git for the directory only once a while, even when it cannot name one', async () => {
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { processes: { dev: 'pnpm dev' } } });
    const tmux = fakeTmux();
    const instance = service(tmux, [cora]);

    await instance.state(cora);
    await instance.state(cora);

    expect(tmux.gitCalls).toHaveLength(1);
  });

  it('gives a one-shot command no notices file', async () => {
    const root = await checkout();
    const cora = testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, commands: { processes: { dev: 'pnpm dev' }, build: 'pnpm build' } });
    const tmux = fakeTmux();

    await expect(service(tmux, [cora]).start(cora.id, 'build')).resolves.toBe('started');

    const build = tmux.windows.find(entry => entry.session.endsWith('-exclusive'));
    expect(build?.command.at(-1)).toContain('pnpm build');
    expect(build?.command.at(-1)).not.toContain('RAC_PROCESS_NOTICES');
  });

  it('serves the notices a process wrote on that process, and none on the rest', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const tmux = fakeTmux();
    tmux.seedProcess('cora', root, 'api');
    tmux.seedProcess('cora', root, 'web', true, 1);
    const instance = service(tmux, [cora]);
    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'running' }, { name: 'web', state: 'exited', exitCode: 1 }]);

    // an exited process keeps its notices
    await report(root, 'web', [{ level: 'info', message: 'warming up' }, { message: 'cache is cold' }]);
    await expect(statesOf(instance, cora)).resolves.toEqual([
      { name: 'api', state: 'running' },
      { name: 'web', state: 'exited', exitCode: 1, notices: [{ level: 'info', message: 'warming up' }, { level: 'warning', message: 'cache is cold' }] }
    ]);
  });

  it("names another Project's Worktree and its process as the notice's target, hidden while that process runs", async () => {
    const root = await checkout();
    const cora = reporter(root);
    const tmux = fakeTmux();
    tmux.seedProcess('cora', root, 'api');
    const instance = service(tmux, [cora, peer]);
    await report(root, 'api', [{ message: 'static is not running', worktree: peer.path, process: 'static' }]);

    await expect(statesOf(instance, cora)).resolves.toEqual([
      { name: 'api', state: 'running', notices: [{ level: 'warning', message: 'static is not running', target: { worktreeId: peer.id, label: 'Static · master', process: 'static', state: 'stopped' } }] },
      { name: 'web', state: 'stopped' }
    ]);

    const running = tmux.seedProcess('static', peer.path, 'static');
    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'running' }, { name: 'web', state: 'stopped' }]);

    Object.assign(running, { dead: true, status: 2 });
    await expect(statesOf(instance, cora)).resolves.toMatchObject([{ name: 'api', notices: [{ target: { worktreeId: peer.id, process: 'static', state: 'exited' } }] }, { name: 'web' }]);

    // its window gone, as a Stop leaves it
    tmux.windows.splice(tmux.windows.indexOf(running), 1);
    await expect(statesOf(instance, cora)).resolves.toMatchObject([{ name: 'api', notices: [{ target: { worktreeId: peer.id, process: 'static', state: 'stopped' } }] }, { name: 'web' }]);
  });

  it('keeps a notice naming a process its Worktree does not declare, targeting the Worktree alone and never hiding', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const tmux = fakeTmux();
    tmux.seedProcess('static', peer.path, 'preview');
    const instance = service(tmux, [cora, peer]);
    await report(root, 'api', [{ message: 'preview is down', worktree: peer.path, process: 'preview' }]);

    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'stopped', notices: [{ level: 'warning', message: 'preview is down', target: { worktreeId: peer.id, label: 'Static · master' } }] }, { name: 'web', state: 'stopped' }]);
  });

  it('keeps the message of a notice whose worktree is no discovered Worktree, without a target', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const instance = service(fakeTmux(), [cora, peer]);
    await report(root, 'api', [{ message: 'somewhere else', worktree: '/nowhere/known', process: 'static' }]);

    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'stopped', notices: [{ level: 'warning', message: 'somewhere else' }] }, { name: 'web', state: 'stopped' }]);
  });

  it('matches a notice to a bridged Worktree by its host path', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const bridged = { ...peer, hostPath: '/host/static' };
    const instance = service(fakeTmux(), [cora, bridged]);
    await report(root, 'api', [{ message: 'static is down', worktree: '/host/static', process: 'static' }]);

    await expect(statesOf(instance, cora)).resolves.toMatchObject([{ notices: [{ target: { worktreeId: peer.id, process: 'static', state: 'stopped' } }] }, {}]);
  });

  it('ignores a malformed notices file, and says so once', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const instance = service(fakeTmux(), [cora]);
    await report(root, 'api', [{ message: 'x'.repeat(501) }]);

    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped' }]);
    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped' }]);
    expect(warn()).toHaveBeenCalledTimes(1);
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('api'));
  });
});

describe('Stack process uses', () => {
  quietWarnings();
  const stopTiming = { timeoutMs: 60, pollMs: 5 };
  const repositories: string[] = [];
  beforeEach(() => { delete process.env.RAC_HOST_TMUX_DIR; delete process.env.RAC_HOST_PATH; });
  afterEach(async () => { for (const root of repositories.splice(0)) await rm(root, { recursive: true, force: true }); });
  // a real checkout, so git names its git directory, where each process's uses file goes
  const checkout = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-process-uses-')));
    repositories.push(root);
    execFileSync('/usr/bin/git', ['init', '-q', root]);
    return root;
  };
  const usesFile = (root: string, name: string) => join(root, '.git', 'rac', 'processes', `${name}.uses.json`);
  const report = async (root: string, name: string, uses: unknown) => {
    await mkdir(dirname(usesFile(root, name)), { recursive: true });
    await writeFile(usesFile(root, name), JSON.stringify(uses));
  };
  const projects = [testProject({ id: 'proj', label: 'Obsidian' }), testProject({ id: 'site', label: 'Static Site', path: '/worktrees/static' })];
  const service = (tmux: ReturnType<typeof fakeTmux>, worktrees: Worktree[]) => new WorktreeCommandService(testConfig({ projects }), { worktreesNow: () => worktrees } as never, tmux.command, undefined, undefined, undefined, stopTiming);
  const processWindow = (tmux: ReturnType<typeof fakeTmux>, name: string) => tmux.windows.find(entry => entry.options.get('@rac_process') === name);
  // the Worktree whose `web` needs its `api`, and uses another Project's `static`
  const reporter = (root: string) => testWorktree({ id: `proj:${root}`, projectId: 'proj', label: 'Obsidian · testing', main: false, branch: 'testing', path: root, commands: { processes: { api: 'ods exec api', web: { command: 'ods exec web', dependsOn: ['api'] } } } });
  const peer = testWorktree({ id: 'site:/worktrees/static', projectId: 'site', label: 'Static Site', path: '/worktrees/static', commands: { processes: { static: 'ods exec static' } } });
  const statesOf = async (instance: WorktreeCommandService, worktree: Worktree) => (await instance.state(worktree)).processes;

  it("clears a process's uses file and names it in RAC_PROCESS_USES on every Start", async () => {
    const root = await checkout();
    const cora = reporter(root);
    await report(root, 'api', [{ worktree: peer.path, process: 'static' }]);
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    // whether the file was still there when the command started, which could then write its own
    const leftForCommand: boolean[] = [];
    const command = async (binary: string, args: string[]) => {
      if (args[0] === 'respawn-pane' && args.includes('/bin/bash')) leftForCommand.push(existsSync(usesFile(root, 'api')));
      return await tmux.command(binary, args);
    };

    await expect(new WorktreeCommandService(config, { worktreesNow: () => [cora] } as never, command).start(cora.id, 'start', 'api')).resolves.toBe('started');

    expect(leftForCommand).toEqual([false]);
    expect(processWindow(tmux, 'api')?.command.at(-1)).toContain(`export RAC_PROCESS_USES='${usesFile(root, 'api')}'; `);
    expect(processWindow(tmux, 'api')?.command.at(-1)).toContain('export RAC_PROCESS_NOTICES=');
  });

  it('keeps the uses file of a process that stops, so it still shows what it used', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const tmux = fakeTmux();
    tmux.seedWorkspace('cora', cora.id);
    tmux.seedProcess('cora', root, 'api');
    await report(root, 'api', [{ worktree: peer.path, process: 'static' }]);

    await expect(service(tmux, [cora, peer]).start(cora.id, 'stop', 'api')).resolves.toBe('started');

    expect(existsSync(usesFile(root, 'api'))).toBe(true);
    await expect(statesOf(service(tmux, [cora, peer]), cora)).resolves.toMatchObject([{ name: 'api', state: 'stopped', uses: [{ worktreeId: peer.id, process: 'static' }] }, { name: 'web' }]);
  });

  it('gives a one-shot command no uses file', async () => {
    const root = await checkout();
    const cora = testWorktree({ id: `proj:${root}`, projectId: 'proj', path: root, commands: { processes: { dev: 'pnpm dev' }, build: 'pnpm build' } });
    const tmux = fakeTmux();

    await expect(service(tmux, [cora]).start(cora.id, 'build')).resolves.toBe('started');

    expect(tmux.windows.find(entry => entry.session.endsWith('-exclusive'))?.command.at(-1)).not.toContain('RAC_PROCESS_USES');
  });

  it('serves what each process needs, omitted when it needs nothing', async () => {
    const root = await checkout();
    const cora = reporter(root);

    await expect(statesOf(service(fakeTmux(), [cora]), cora)).resolves.toEqual([{ name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped', dependsOn: ['api'] }]);
  });

  it('serves each process used with its Worktree, labelled by Project and Worktree, and its state, running or not', async () => {
    const root = await checkout();
    const cora = reporter(root);
    const tmux = fakeTmux();
    tmux.seedProcess('cora', root, 'api');
    const instance = service(tmux, [cora, peer]);
    await report(root, 'api', [{ worktree: peer.path, process: 'static' }]);
    const static_ = { worktreeId: peer.id, label: 'Static Site / Main', process: 'static' };

    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'running', uses: [{ ...static_, state: 'stopped' }] }, { name: 'web', state: 'stopped', dependsOn: ['api'] }]);

    const running = tmux.seedProcess('static', peer.path, 'static');
    await expect(statesOf(instance, cora)).resolves.toMatchObject([{ uses: [{ ...static_, state: 'running' }] }, {}]);

    Object.assign(running, { dead: true, status: 0 });
    await expect(statesOf(instance, cora)).resolves.toMatchObject([{ uses: [{ ...static_, state: 'exited', exitCode: 0 }] }, {}]);
  });

  it("labels a linked Worktree used by its Project and branch, and one of this Worktree's Project too", async () => {
    const root = await checkout();
    const cora = reporter(root);
    const linked = testWorktree({ id: 'site:/worktrees/static-feature', projectId: 'site', label: 'Static Site · feature', main: false, branch: 'feature', path: '/worktrees/static-feature', commands: { processes: { static: 'ods exec static' } } });
    const main = testWorktree({ id: 'proj:/worktrees/obsidian', projectId: 'proj', label: 'Obsidian', path: '/worktrees/obsidian', commands: { processes: { api: 'ods exec api' } } });
    await report(root, 'api', [{ worktree: linked.path, process: 'static' }, { worktree: main.path, process: 'api' }]);

    await expect(statesOf(service(fakeTmux(), [cora, linked, main]), cora)).resolves.toMatchObject([{ uses: [{ worktreeId: linked.id, label: 'Static Site / feature' }, { worktreeId: main.id, label: 'Obsidian / Main' }] }, {}]);
  });

  it('shows a process used where no Worktree declares it by its path alone', async () => {
    const root = await checkout();
    const cora = reporter(root);
    await report(root, 'api', [{ worktree: '/nowhere/known', process: 'static' }, { worktree: peer.path, process: 'preview' }]);

    await expect(statesOf(service(fakeTmux(), [cora, peer]), cora)).resolves.toMatchObject([{ uses: [{ label: '/nowhere/known', process: 'static' }, { label: peer.path, process: 'preview' }] }, {}]);
    const [api] = (await statesOf(service(fakeTmux(), [cora, peer]), cora))!;
    expect(api!.uses!.every(use => use.worktreeId === undefined && use.state === undefined)).toBe(true);
  });

  it('matches a process used to a bridged Worktree by its host path', async () => {
    const root = await checkout();
    const cora = reporter(root);
    await report(root, 'api', [{ worktree: '/host/static', process: 'static' }]);

    await expect(statesOf(service(fakeTmux(), [cora, { ...peer, hostPath: '/host/static' }]), cora)).resolves.toMatchObject([{ uses: [{ worktreeId: peer.id, process: 'static', state: 'stopped' }] }, {}]);
  });

  it('ignores a malformed uses file, and says so once', async () => {
    const warn = vi.mocked(console.warn);
    const root = await checkout();
    const cora = reporter(root);
    const instance = service(fakeTmux(), [cora]);
    await report(root, 'api', [{ worktree: 'relative', process: 'static' }]);

    await expect(statesOf(instance, cora)).resolves.toEqual([{ name: 'api', state: 'stopped' }, { name: 'web', state: 'stopped', dependsOn: ['api'] }]);
    await instance.state(cora);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('uses'))).toHaveLength(1);
  });
});

describe('worktree setup command', () => {
  type FakeCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  const fastTiming = { timeoutMs: 2_000, pollMs: 10 };
  // a fake host tmux that runs the setup script by writing its exit marker through the mount,
  // like the concurrency/status tests: the host path maps to the console-side checkout
  const runningSetup = (exit: string) => {
    const launched: string[] = [];
    const scripts: string[] = [];
    const command: FakeCommand = async (_binary, args) => {
      if (!args.includes('new-session')) return { code: 1, stdout: '' };
      const script = args.at(-1) ?? '';
      launched.push(args[args.indexOf('-s') + 1] ?? '');
      scripts.push(script);
      const hostMarker = /> '([^']+\.exit)'/u.exec(script)?.[1];
      if (hostMarker !== undefined) await writeFile(join(checkoutRoot!, hostMarker.slice('/host/checkout/'.length)), exit);
      return { code: 0, stdout: '' };
    };
    return { command, launched, scripts };
  };
  const setupService = (worktree: ReturnType<typeof testWorktree>, command: FakeCommand, timing = fastTiming) => {
    const projectConfig = testConfig({ projects: [testProject({ id: 'proj', path: checkoutRoot!, hostPath: '/host/checkout' })] });
    return new WorktreeCommandService(projectConfig, { worktreesNow: () => [worktree] } as never, command, checkoutRoot!, timing);
  };

  it('runs the setup command in the worktree and reports success on a zero exit', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'pnpm install' } });
    const { command, launched, scripts } = runningSetup('0');
    const service = setupService(cora, command);
    const result = await service.runSetup(cora);
    // a successful run reports ok and keeps no log
    expect(result).toEqual({ ok: true });
    // it runs in the worktree host root and captures output to a host-side log
    expect(launched[0]).toMatch(/^rac-setup-proj-[0-9a-f]{12}-[0-9a-f]{18}$/);
    expect(scripts[0]).toContain("cd -- '/host/cora'");
    expect(scripts[0]).toContain("> '/host/checkout/.data/stack-logs/setup-");
    expect(scripts[0]).toContain('pnpm install');
  });

  it('reports failure on a non-zero setup exit', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'exit 1' } });
    const { command } = runningSetup('1');
    // a failed run keeps its log and points at it for host-side inspection
    const result = await setupService(cora, command).runSetup(cora);
    expect(result.ok).toBe(false);
    expect(result.log).toContain('/.data/stack-logs/setup-');
  });

  it('is a no-op success when no setup command is configured', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { build: 'make' } });
    let sessions = 0;
    const service = setupService(cora, async (_binary, args) => { if (args.includes('new-session')) sessions += 1; return { code: 1, stdout: '' }; });
    await expect(service.runSetup(cora)).resolves.toEqual({ ok: true });
    expect(sessions).toBe(0);
  });

  it("runs the setup command on tmux's default socket in native mode", async () => {
    delete process.env.RAC_HOST_TMUX_DIR;
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    // a native worktree has no separate host path: the console and tmux share a filesystem
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', commands: { setup: 'pnpm install' } });
    const launches: string[][] = [];
    const command: FakeCommand = async (_binary, args) => {
      if (!args.includes('new-session')) return { code: 1, stdout: '' };
      launches.push(args);
      // native mode writes the marker to a real console-side path, not a mounted host path
      const marker = /> '([^']+\.exit)'/u.exec(args.at(-1) ?? '')?.[1];
      if (marker !== undefined) await writeFile(marker, '0');
      return { code: 0, stdout: '' };
    };
    await expect(setupService(cora, command).runSetup(cora)).resolves.toEqual({ ok: true });
    // it launched once, on the default socket (no '-S'), and ran in the worktree
    expect(launches).toHaveLength(1);
    expect(launches[0]!.includes('-S')).toBe(false);
    expect(launches[0]!.at(-1)).toContain("cd -- '/worktrees/cora'");
  });

  it('reports failure when the setup command never finishes within the budget', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'sleep 999' } });
    // it launches but never writes a marker, so the bounded poll gives up
    const service = setupService(cora, async () => ({ code: 0, stdout: '' }), { timeoutMs: 120, pollMs: 10 });
    await expect(service.runSetup(cora)).resolves.toMatchObject({ ok: false });
  });

  it('kills a setup session that never finishes, so it cannot linger on the tmux server', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    delete process.env.RAC_HOST_WORKSPACE;
    checkoutRoot = await mkdtemp(join(tmpdir(), 'rac-checkout-'));
    const cora = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', path: '/worktrees/cora', hostPath: '/host/cora', commands: { setup: 'sleep 999' } });
    const created: string[] = [];
    const killed: string[] = [];
    const command: FakeCommand = async (_binary, args) => {
      if (args.includes('new-session')) { created.push(args[args.indexOf('-s') + 1] ?? ''); return { code: 0, stdout: '' }; }
      if (args.includes('kill-session')) { killed.push((args[args.indexOf('-t') + 1] ?? '').replace(/^=/u, '')); return { code: 0, stdout: '' }; }
      return { code: 1, stdout: '' };
    };
    // it launches but never writes a marker; when the bounded poll gives up the session is killed
    const service = setupService(cora, command, { timeoutMs: 120, pollMs: 10 });
    await expect(service.runSetup(cora)).resolves.toMatchObject({ ok: false });
    expect(created).toHaveLength(1);
    expect(killed).toEqual(created);
  });
});
