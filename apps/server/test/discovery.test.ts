import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryService, gitUpstreamSummary, ProcSocketFinder } from '../src/discovery/service.js';
import { inlineQuestionId } from '../src/adapters/inline-questions.js';
import { pendingOmxQuestion } from '../src/adapters/omx-questions.js';
import { adapterFor } from '../src/adapters/registry.js';
import type { SocketRef } from '../src/domain/models.js';
import type { WorktreeEntry } from '../src/git/worktrees.js';
import { AgentNotificationCoordinator } from '../src/notifications.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';
import { testProject } from './helpers/config.js';

// one `git worktree list --porcelain` entry; omit `branch` for a detached checkout
const entry = (path: string, branch?: string, extra: Partial<WorktreeEntry> = {}): WorktreeEntry => ({ path, head: 'abcdef1234567', detached: branch === undefined, bare: false, locked: false, prunable: false, ...(branch === undefined ? {} : { branch }), ...extra });
// an injectable `listWorktrees` keyed by Project path; an unknown path means git failed
const listImpl = (byPath: Record<string, WorktreeEntry[]>) => async (path: string): Promise<WorktreeEntry[] | undefined> => byPath[path];

// write one representative Codex rollout under a home, returning its absolute path
async function writeRollout(home: string, id: string, prompt: string): Promise<string> {
  const directory = join(home, 'sessions', '2026', '08', '20');
  await mkdir(directory, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id, cwd: '/host/cora', originator: 'codex-tui' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }
  ];
  const file = join(directory, `rollout-2026-08-20T12-00-00-${id}.jsonl`);
  await writeFile(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

// record a Codex Conversation name in the account-global session_index.jsonl sidecar
async function writeSessionIndex(home: string, id: string, threadName: string): Promise<void> {
  await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: threadName, updated_at: '2026-09-02T20:53:25.975357809Z' })}\n`);
}

// build a fake /proc where each pid holds the given rollout files open
async function buildProc(proc: string, holdings: Record<number, string[]>): Promise<void> {
  for (const [pid, files] of Object.entries(holdings)) {
    await mkdir(join(proc, pid, 'task', pid), { recursive: true });
    await writeFile(join(proc, pid, 'task', pid, 'children'), '');
    await mkdir(join(proc, pid, 'fd'), { recursive: true });
    await Promise.all(files.map((file, index) => symlink(file, join(proc, pid, 'fd', String(index + 3)))));
  }
}

describe('DiscoveryService dashboard', () => {
  // native replacement must not inherit a persistent pane shell's identity
  it('tracks the recognized agent pid separately from the pane pid', async () => {
    let pid = 456;
    // retain the shell while replacing its recognized native descendant
    const processes = { recognizeAgent: async () => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(socketFinder(), paneLister([{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready' }]) as never, processes);
    const [first] = await service.refresh(true);
    expect(first).toBeDefined();
    expect(service.paneProcessId(first!.id)).toBe(123);
    expect(service.agentProcessId(first!.id)).toBe(456);
    pid = 789;
    await service.refresh(true);
    expect(service.paneProcessId(first!.id)).toBe(123);
    expect(service.agentProcessId(first!.id)).toBe(789);
  });

  // only non-forced scans may reuse established process recognition
  it('keeps lifecycle process recognition fresh while polling opts into reuse', async () => {
    const processes = { recognizeAgent: vi.fn().mockResolvedValue(undefined) };
    const service = new DiscoveryService(socketFinder(), paneLister([{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: '' }]) as never, processes);
    await service.refresh(false, true);
    expect(processes.recognizeAgent).toHaveBeenLastCalledWith(123, { reusePositive: true });
    await service.refresh(true);
    expect(processes.recognizeAgent).toHaveBeenLastCalledWith(123, { reusePositive: false });
  });

  it('reports commits available from the configured branch upstream', async () => {
    const command = vi.fn(async (_binary: string, args: string[]) => args.includes('rev-parse')
      ? { code: 0, stdout: 'origin/feature\n' }
      : { code: 0, stdout: '2\t3\n' });

    await expect(gitUpstreamSummary('/worktrees/cora', command)).resolves.toEqual({ upstream: 'origin/feature', ahead: 2, behind: 3 });
    expect(command).toHaveBeenLastCalledWith('/usr/bin/git', ['-C', '/worktrees/cora', 'rev-list', '--left-right', '--count', 'HEAD...origin/feature']);
  });

  it('omits branches without a usable configured upstream', async () => {
    const command = vi.fn(async () => ({ code: 128, stdout: '' }));

    await expect(gitUpstreamSummary('/worktrees/cora', command)).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('discovers tmux sockets directly from the mounted socket directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-tmux-'));
    const socketPath = join(directory, 'default');
    const server = createServer();
    const previous = process.env.RAC_HOST_TMUX_DIR;
    process.env.RAC_HOST_TMUX_DIR = directory;
    try {
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
      await expect(new ProcSocketFinder().find()).resolves.toEqual([expect.objectContaining({ path: socketPath })]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previous === undefined) delete process.env.RAC_HOST_TMUX_DIR; else process.env.RAC_HOST_TMUX_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('ignores listening sockets outside the tmux socket directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-unix-'));
    const tmuxDirectory = join(directory, 'tmux-1000');
    await mkdir(tmuxDirectory);
    const tmuxSocket = join(tmuxDirectory, 'default');
    const otherSocket = join(directory, 'other.sock');
    const table = join(directory, 'unix');
    const servers = [createServer(), createServer()];
    const previous = { dir: process.env.RAC_HOST_TMUX_DIR, source: process.env.RAC_HOST_TMUX_SOURCE, table: process.env.RAC_HOST_UNIX_SOCKETS };
    delete process.env.RAC_HOST_TMUX_DIR;
    process.env.RAC_HOST_TMUX_SOURCE = tmuxDirectory;
    process.env.RAC_HOST_UNIX_SOCKETS = table;
    try {
      await Promise.all([tmuxSocket, otherSocket].map((path, index) => new Promise<void>((resolve, reject) => servers[index]!.once('error', reject).listen(path, resolve))));
      await writeFile(table, `Num RefCount Protocol Flags Type St Inode Path\n0001: 00000002 00000000 00010000 0001 01 1 ${otherSocket}\n0002: 00000002 00000000 00010000 0001 01 2 ${tmuxSocket}\n`);
      await expect(new ProcSocketFinder().find()).resolves.toEqual([expect.objectContaining({ path: tmuxSocket })]);
    } finally {
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      for (const [key, value] of [['RAC_HOST_TMUX_DIR', previous.dir], ['RAC_HOST_TMUX_SOURCE', previous.source], ['RAC_HOST_UNIX_SOCKETS', previous.table]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  // publish the selected checkout preview on active bridged agents
  it('associates a host tmux path with the discovered Main worktree by its host path', async () => {
    const finder = socketFinder();
    const tmux = paneLister([{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }]);
    const processes = processInspector({ codex: true });
    const project = testProject({ id: 'ferry', label: 'Ferry FYI', path: '/worktrees/ferry', hostPath: '/host/ferry', newTask: 'new {taskId}', push: { label: 'Commit/Push', prompt: '$push' }, projectUrl: 'https://default.example.com', projectPort: 3000, worktreeOverrides: [{ path: '/worktrees/ferry', projectUrl: 'https://ferry.external.example.com' }] });
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], undefined, listImpl({ '/worktrees/ferry': [entry('/worktrees/ferry', 'main')] }));

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toHaveLength(1);
    // the pane's host path matches the Main worktree's hostPath, not its console path
    expect(dashboard.agents[0]).toMatchObject({ home: '/worktrees/ferry', projectId: 'ferry', worktreeId: 'ferry:/worktrees/ferry', newTaskConfigured: true, projectUrl: 'https://ferry.external.example.com', projectProxied: false });
    // executable button definitions stay on the server
    expect(dashboard.agents[0]).not.toHaveProperty('push');
    expect(dashboard.projects[0]?.worktrees[0]).not.toHaveProperty('push');
    // the Agent's folder travels as `home` only; the retired `workspace` key must not reappear on the wire
    expect(dashboard.agents[0]).not.toHaveProperty('workspace');
    // the Worktree is carried under its Project; an active Worktree omits idle git metadata
    expect(dashboard.projects[0]?.worktrees).toMatchObject([{ id: 'ferry:/worktrees/ferry', main: true, pinned: true, projectUrl: 'https://ferry.external.example.com', projectProxied: false }]);
  });

  it("counts a Worktree's open Console shells on its dashboard row", async () => {
    const finder = socketFinder();
    // a marked Console shell and a bare pane in the checkout, plus a shell in another checkout:
    // only a `@rac_role=shell` pane whose toplevel is this Worktree counts
    const tmux = paneLister([
      { paneId: '%1', sessionId: '$0', pid: 11, path: '/host/ferry', command: 'zsh', role: 'shell', title: '' },
      { paneId: '%2', sessionId: '$0', pid: 12, path: '/host/ferry', command: 'zsh', title: '' },
      { paneId: '%3', sessionId: '$1', pid: 13, path: '/host/other', command: 'zsh', role: 'shell', title: '' }
    ]);
    // bare login shells: no live agent is recognized under any of them
    const processes = processInspector({ codex: false });
    const project = testProject({ id: 'ferry', label: 'Ferry', path: '/worktrees/ferry', hostPath: '/host/ferry', push: { label: 'p', prompt: '$p' } });
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], undefined, listImpl({ '/worktrees/ferry': [entry('/worktrees/ferry', 'main')] }));

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toHaveLength(0);
    expect(dashboard.projects[0]?.worktrees).toMatchObject([{ id: 'ferry:/worktrees/ferry', consoleShells: 1 }]);
  });

  it('prefers a valid reported @rac_session over the conversation the fd-walk finds, and reads its name', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [
      // pane %1 reports a valid session; pane %2 reports garbage and must fall back to the fd-walk
      { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora', reportedSession: '0198c111-1111-7111-8111-111111111111' },
      { paneId: '%2', sessionId: '$1', pid: 456, path: '/host/cora', title: 'Cora copy', reportedSession: 'not-a-session' }
    ] };
    const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
    const proc = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };
    try {
      await writeRollout(home, '0198c111-1111-7111-8111-111111111111', 'The rollout prompt');
      // a reported id reads its name from the session_index sidecar, not the rollout prompt:
      // a distinct sidecar name proves readName (not the retired title scan) is the source
      await writeSessionIndex(home, '0198c111-1111-7111-8111-111111111111', 'Renamed thread');
      const walkedFirst = await writeRollout(home, '0198c333-3333-7333-8333-333333333333', 'Walked by pane one');
      const walkedSecond = await writeRollout(home, '0198c777-7777-7777-8777-777777777777', 'Walked by pane two');
      await buildProc(proc, { 123: [walkedFirst], 456: [walkedSecond] });
      process.env.RAC_HOST_PROC = proc;
      process.env.CODEX_HOME = home;
      const service = new DiscoveryService(finder, tmux as never, processInspector());
      const agents = await service.refresh();

      // the valid reported id wins over the different conversation the fd-walk would return
      await expect(service.conversationId(agents[0]!.id)).resolves.toBe('0198c111-1111-7111-8111-111111111111');
      await expect(service.conversation(agents[0]!.id)).resolves.toEqual({ id: '0198c111-1111-7111-8111-111111111111', title: 'Renamed thread' });
      // a malformed report is rejected and falls back to the fd-walk
      await expect(service.conversationId(agents[1]!.id)).resolves.toBe('0198c777-7777-7777-8777-777777777777');
    } finally {
      if (previous.proc === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous.proc;
      if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(proc, { recursive: true, force: true })]);
    }
  });

  it("reads each reported Claude conversation's name though two Agents share its folder", async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    // two Claude Agents launched in the same folder, each reporting its own session
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [
      { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora', reportedSession: '11111111-1111-4111-8111-111111111111' },
      { paneId: '%2', sessionId: '$0', pid: 456, path: '/host/cora', title: 'Cora', reportedSession: '22222222-2222-4222-8222-222222222222' }
    ] };
    const config = await mkdtemp(join(tmpdir(), 'rac-claude-config-'));
    const previous = process.env.RAC_CLAUDE_CONFIG_DIR;
    try {
      const project = join(config, 'projects', '-host-cora');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, '11111111-1111-4111-8111-111111111111.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Testing', sessionId: '11111111-1111-4111-8111-111111111111' })}\n`);
      await writeFile(join(project, '22222222-2222-4222-8222-222222222222.jsonl'), `${JSON.stringify({ type: 'ai-title', aiTitle: 'Commit the changes', sessionId: '22222222-2222-4222-8222-222222222222' })}\n`);
      process.env.RAC_CLAUDE_CONFIG_DIR = config;
      const service = new DiscoveryService(finder, tmux as never, processInspector({ kind: 'claude' }));
      const agents = await service.refresh();

      await expect(service.conversation(agents[0]!.id)).resolves.toEqual({ id: '11111111-1111-4111-8111-111111111111', title: 'Testing' });
      await expect(service.conversation(agents[1]!.id)).resolves.toEqual({ id: '22222222-2222-4222-8222-222222222222', title: 'Commit the changes' });
    } finally {
      if (previous === undefined) delete process.env.RAC_CLAUDE_CONFIG_DIR; else process.env.RAC_CLAUDE_CONFIG_DIR = previous;
      await rm(config, { recursive: true, force: true });
    }
  });

  it('falls back to the fd-walk and isolates each pane to its own conversation', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [
      { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' },
      { paneId: '%2', sessionId: '$1', pid: 456, path: '/host/cora', title: 'Cora copy' }
    ] };
    const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
    const proc = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };
    try {
      const first = await writeRollout(home, '0198c111-1111-7111-8111-111111111111', 'First conversation');
      const second = await writeRollout(home, '0198c333-3333-7333-8333-333333333333', 'Second conversation');
      await buildProc(proc, { 123: [first], 456: [second] });
      process.env.RAC_HOST_PROC = proc;
      process.env.CODEX_HOME = home;
      const service = new DiscoveryService(finder, tmux as never, processInspector());
      const agents = await service.refresh();

      await expect(service.conversationId(agents[0]!.id)).resolves.toBe('0198c111-1111-7111-8111-111111111111');
      await expect(service.conversationId(agents[1]!.id)).resolves.toBe('0198c333-3333-7333-8333-333333333333');
      await expect(service.conversation(agents[0]!.id)).resolves.toEqual({ id: '0198c111-1111-7111-8111-111111111111', title: 'First conversation' });
    } finally {
      if (previous.proc === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous.proc;
      if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(proc, { recursive: true, force: true })]);
    }
  });

  it('resolves the conversation by working directory when the fd-walk is blocked', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    // one pane whose descriptors a confined service cannot readlink
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' }] };
    const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
    const proc = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };
    try {
      // writeRollout records cwd '/host/cora' in session_meta, matching the pane path
      await writeRollout(home, '0198c111-1111-7111-8111-111111111111', 'Confined conversation');
      await buildProc(proc, { 123: [], 456: [] });
      process.env.RAC_HOST_PROC = proc;
      process.env.CODEX_HOME = home;
      const service = new DiscoveryService(finder, tmux as never, processInspector());
      const agents = await service.refresh();

      await expect(service.conversationId(agents[0]!.id)).resolves.toBe('0198c111-1111-7111-8111-111111111111');
      await expect(service.conversation(agents[0]!.id)).resolves.toEqual({ id: '0198c111-1111-7111-8111-111111111111', title: 'Confined conversation' });

      // two blocked panes sharing the directory fail closed rather than share a conversation
      const shared = { markSessionPlace: async () => true, listPanes: async () => [
        { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' },
        { paneId: '%2', sessionId: '$1', pid: 456, path: '/host/cora', title: 'Cora copy' }
      ] };
      const crowded = new DiscoveryService(finder, shared as never, processInspector());
      const both = await crowded.refresh();
      await expect(crowded.conversation(both[0]!.id)).resolves.toBeUndefined();
      await expect(crowded.conversation(both[1]!.id)).resolves.toBeUndefined();
    } finally {
      if (previous.proc === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous.proc;
      if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
      await Promise.all([rm(home, { recursive: true, force: true }), rm(proc, { recursive: true, force: true })]);
    }
  });

  it('emits one row per shared Codex rollout — codex and omx share one reader, never two rows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
    const previous = process.env.CODEX_HOME;
    try {
      // writeRollout records cwd '/host/cora'; the sidecar name makes it a listable Named row
      await writeRollout(home, '0198c111-1111-7111-8111-111111111111', 'Shared reader');
      await writeSessionIndex(home, '0198c111-1111-7111-8111-111111111111', 'Named codex chat');
      process.env.CODEX_HOME = home;
      const service = new DiscoveryService();

      // both the codex and omx Adapters carry the same reader (ADR 0005), yet the union
      // dedupes it to a single codex-tagged row rather than one per sharing kind
      await expect(service.conversations(['/host/cora'])).resolves.toEqual([
        { kind: 'codex', id: '0198c111-1111-7111-8111-111111111111', name: 'Named codex chat', lastActiveAt: 0, directory: '/host/cora' },
      ]);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves a custom tmux display label for launched scratch agents', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Codex', displayLabel: '~ Scratch' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    await expect(service.dashboard()).resolves.toMatchObject({ agents: [{ displayLabel: '~ Scratch' }] });
  });

  it('keeps an update advisor separate from its configured repository worktree', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%2', sessionId: '$1', pid: 456, path: '/host/remoteagents', title: 'Ready', displayLabel: 'Update Advisor Starting v4 2222222' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const project = testProject({ id: 'remoteagents', label: 'Remote Agents', path: '/workspace', hostPath: '/host/remoteagents' });
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], undefined, listImpl({ '/workspace': [entry('/workspace', 'main')] }));

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toEqual([expect.objectContaining({ pane: expect.objectContaining({ paneId: '%2' }), home: '/host/remoteagents', displayLabel: 'Update Advisor Starting v4 2222222' })]);
    // a modal advisor never claims the Project's Main worktree, which stays idle in projects[]
    expect(dashboard.agents[0]).not.toHaveProperty('worktreeId');
    expect(dashboard.projects[0]?.worktrees).toEqual([expect.objectContaining({ id: 'remoteagents:/workspace' })]);
  });

  it('resolves reported @rac_* pane options over the inferred title and publishes adapter capabilities', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready', reportedAttention: 'question', reportedSession: 'abc-123', reportedSandboxed: '1' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    // reported 'question' wins over the title's inferred 'finished'
    expect(dashboard.agents[0]).toMatchObject({ kind: 'codex', attention: 'question', sandboxed: true, conversationId: 'abc-123' });
    expect(dashboard.adapters).toMatchObject({ codex: { launchable: false, stateSource: 'title', turnCapture: true, conversations: true, inlineQuestions: true, commands: true, sandbox: false } });
  });

  // prose questions affect presentation without blocking normal prompt submission
  it.each(['codex', 'omx', 'claude'] as const)('publishes only the latest idle %s message question', async kind => {
    let attention: 'working' | 'finished' = 'working';
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const latestMessage = vi.spyOn(adapterFor(kind)!.conversations!, 'latestMessage').mockResolvedValue('Which target should I use?');
    const tmux = {
      markSessionPlace: async () => true,
      listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready', reportedAttention: attention, reportedSession: 'conversation-1' }]
    };
    const service = new DiscoveryService(socketFinder(), tmux as never, processInspector({ kind }));
    const delivered = vi.fn();
    const notifications = new AgentNotificationCoordinator(delivered);
    try {
      const working = (await service.dashboard(false, true)).agents[0]!;
      expect(working).not.toHaveProperty('hasMessageQuestion');
      expect(latestMessage).not.toHaveBeenCalled();
      notifications.observe(working);

      attention = 'finished';
      const asking = (await service.dashboard(false, true)).agents[0]!;
      expect(asking).toMatchObject({ attention: 'finished', hasMessageQuestion: true });
      expect(asking).not.toHaveProperty('question');
      expect(latestMessage).toHaveBeenCalledWith({ pid: 123, cwd: '/tmp', conversationId: 'conversation-1' });
      notifications.observe(asking);
      notifications.observe((await service.dashboard(false, true)).agents[0]!);
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question' }));
      expect(notifications.isUnread(asking)).toBe(false);

      // a new prompt or newer response clears the previous question
      latestMessage.mockResolvedValue(undefined);
      now += 2_000;
      expect((await service.dashboard(false, true)).agents[0]).not.toHaveProperty('hasMessageQuestion');
      latestMessage.mockResolvedValue('The change is complete.');
      now += 2_000;
      expect((await service.dashboard(false, true)).agents[0]).not.toHaveProperty('hasMessageQuestion');

      // unavailable transcripts must not break the dashboard
      latestMessage.mockRejectedValueOnce(new Error('transcript unavailable'));
      now += 2_000;
      expect((await service.dashboard(false, true)).agents[0]).toMatchObject({ attention: 'finished' });
    } finally {
      latestMessage.mockRestore();
      clock.mockRestore();
      notifications.stop();
    }
  });

  // a slow transcript cannot stall working status or revive an answered question
  it('does not block discovery on message reads or publish a stale idle result', async () => {
    let attention: 'finished' | 'working' = 'finished';
    let finishRead!: (message: string) => void;
    const pending = new Promise<string>(resolve => { finishRead = resolve; });
    const latestMessage = vi.spyOn(adapterFor('codex')!.conversations!, 'latestMessage').mockReturnValue(pending);
    const tmux = {
      markSessionPlace: async () => true,
      listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready', reportedAttention: attention }]
    };
    const service = new DiscoveryService(socketFinder(), tmux as never, processInspector());
    try {
      expect((await service.dashboard(false, true)).agents[0]).toMatchObject({ attention: 'finished' });
      expect((await service.dashboard(false, true)).agents[0]).not.toHaveProperty('hasMessageQuestion');
      expect(latestMessage).toHaveBeenCalledTimes(1);
      attention = 'working';
      expect((await service.dashboard(false, true)).agents[0]).toMatchObject({ attention: 'working' });
      finishRead('Should I proceed?');
      await pending;
      expect((await service.dashboard(false, true)).agents[0]).not.toHaveProperty('hasMessageQuestion');
    } finally {
      finishRead('');
      latestMessage.mockRestore();
    }
  });

  // frequent pane polls reuse a bounded background transcript result
  it('throttles completed message reads without delaying fresh pane status', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const latestMessage = vi.spyOn(adapterFor('codex')!.conversations!, 'latestMessage').mockResolvedValue('Deploy where?');
    const service = new DiscoveryService(socketFinder(), paneLister([{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready' }]) as never, processInspector());
    try {
      expect((await service.dashboard(false, true)).agents[0]).toHaveProperty('hasMessageQuestion', true);
      await service.dashboard(false, true);
      now += 1_999;
      expect((await service.dashboard(false, true)).agents[0]).toHaveProperty('hasMessageQuestion', true);
      expect(latestMessage).toHaveBeenCalledTimes(1);
      latestMessage.mockResolvedValue('Done.');
      now += 1;
      expect((await service.dashboard(false, true)).agents[0]).not.toHaveProperty('hasMessageQuestion');
      expect(latestMessage).toHaveBeenCalledTimes(2);
    } finally {
      latestMessage.mockRestore();
      clock.mockRestore();
    }
  });

  // prompt delivery supersedes both published and in-flight question observations
  it('invalidates a question after delivery while the pane still reports finished', async () => {
    let finishRead!: (message: string) => void;
    const pending = new Promise<string>(resolve => { finishRead = resolve; });
    const latestMessage = vi.spyOn(adapterFor('codex')!.conversations!, 'latestMessage').mockResolvedValue('Deploy where?');
    const service = new DiscoveryService(socketFinder(), paneLister([{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready' }]) as never, processInspector());
    try {
      const asking = (await service.dashboard()).agents[0]!;
      expect(asking).toHaveProperty('hasMessageQuestion', true);
      latestMessage.mockReturnValueOnce(pending);
      service.invalidateMessageQuestion(asking.id);
      expect((await service.dashboard()).agents[0]).not.toHaveProperty('hasMessageQuestion');
      service.invalidateMessageQuestion(asking.id);
      latestMessage.mockResolvedValue(undefined);
      finishRead('Deploy where?');
      await pending;
      expect((await service.dashboard()).agents[0]).toMatchObject({ attention: 'finished' });
      expect((await service.dashboard()).agents[0]).not.toHaveProperty('hasMessageQuestion');
    } finally {
      finishRead('');
      latestMessage.mockRestore();
    }
  });

  // another pane's slow enrichment must not freeze an already-answered question
  it('does not publish or cache an invalidated question while another agent is still building', async () => {
    let releaseSecond!: () => void;
    let startedSecond!: () => void;
    const blocked = new Promise<void>(resolve => { releaseSecond = resolve; });
    const started = new Promise<void>(resolve => { startedSecond = resolve; });
    let calls = 0;
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {},
      // hold the second agent after the first agent has finished enrichment
      branch: async () => ({}), repositoryAt: async () => {
        calls += 1;
        // wait only on the second pane's first dashboard
        if (calls === 2) { startedSecond(); await blocked; }
        return undefined;
      }
    };
    const latestMessage = vi.spyOn(adapterFor('codex')!.conversations!, 'latestMessage').mockResolvedValue('Deploy where?');
    // a checkout on a branch, so each agent's enrichment reads its pull request
    const checkout = await mkdtemp(join(tmpdir(), 'rac-dashboard-'));
    execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
    const service = new DiscoveryService(socketFinder(), paneLister([
      { paneId: '%1', sessionId: '$0', pid: 123, path: checkout, title: 'Ready' },
      { paneId: '%2', sessionId: '$1', pid: 124, path: checkout, title: 'Ready' }
    ]) as never, processInspector(), pullRequests);
    try {
      const building = service.dashboard();
      await started;
      // drain the first agent's enrichment continuations while its sibling remains blocked
      await new Promise<void>(resolve => setImmediate(resolve));
      service.invalidateMessageQuestion('socket:%1');
      releaseSecond();
      const dashboard = await building;
      expect(dashboard.agents.find(agent => agent.id === 'socket:%1')).not.toHaveProperty('hasMessageQuestion');
      expect(dashboard.agents.find(agent => agent.id === 'socket:%2')).toHaveProperty('hasMessageQuestion', true);
      expect((await service.dashboard()).agents.find(agent => agent.id === 'socket:%1')).not.toHaveProperty('hasMessageQuestion');
    } finally {
      releaseSecond();
      latestMessage.mockRestore();
      await rm(checkout, { recursive: true, force: true });
    }
  });

  // native dialogs discard old prose reads even when the title remains idle
  it('does not revive an older message question after a native question disappears', async () => {
    let finishRead!: (message: string) => void;
    const pending = new Promise<string>(resolve => { finishRead = resolve; });
    const latestMessage = vi.spyOn(adapterFor('omx')!.conversations!, 'latestMessage').mockReturnValue(pending);
    const nativeQuestion = vi.spyOn(adapterFor('omx')!.questions!, 'pending').mockResolvedValue(undefined);
    const service = new DiscoveryService(socketFinder(), paneLister([{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready' }]) as never, processInspector({ kind: 'omx' }));
    try {
      await service.dashboard(false, true);
      nativeQuestion.mockResolvedValue({ id: 'native-question', text: 'Which target?', choices: ['Staging', 'Production'] });
      expect((await service.dashboard(false, true)).agents[0]).toMatchObject({ attention: 'question', question: { id: 'native-question' } });
      finishRead('Deploy where?');
      await pending;
      nativeQuestion.mockResolvedValue(undefined);
      // keep the next read pending so only stale cached results could revive the flag
      latestMessage.mockReturnValue(new Promise(() => {}));
      expect((await service.dashboard(false, true)).agents[0]).not.toHaveProperty('hasMessageQuestion');
    } finally {
      finishRead('');
      latestMessage.mockRestore();
      nativeQuestion.mockRestore();
    }
  });

  // refresh attention on the configured poll before completion grace expires
  it('does not hold a transient finished title after the pane resumes working', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
    let title = '⠋ Working';
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = {
      markSessionPlace: async () => true,
      listPanes: async () => {
        // model nonzero tmux scan and dashboard enrichment time
        vi.setSystemTime(Date.now() + 100);
        return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title }];
      }
    };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);
    const notifications = new AgentNotificationCoordinator(() => {}, 2_000);
    try {
      const initial = await service.dashboard(false, true);
      notifications.observe(initial.agents[0]!);

      // sample one genuine idle boundary
      await vi.advanceTimersByTimeAsync(2_000);
      title = 'Ready';
      const finished = await service.dashboard(false, true);
      notifications.observe(finished.agents[0]!);
      expect(finished.agents[0]?.attention).toBe('finished');

      // resume before the next configured status poll
      title = '⠙ Working';
      await vi.advanceTimersByTimeAsync(500);
      const resumed = await service.dashboard(false, true);
      notifications.observe(resumed.agents[0]!);
      expect(resumed.agents[0]?.attention).toBe('working');

      // keep the stale completion timer past its original deadline
      await vi.advanceTimersByTimeAsync(1_500);
      expect(notifications.isUnread(resumed.agents[0]!)).toBe(false);
    } finally {
      notifications.stop();
      vi.useRealTimers();
    }
  });

  it('clears stale @rac_* only on a non-agent pane that still carries a report', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const unset: string[] = [];
    const tmux = {
      markSessionPlace: async () => true,
      listPanes: async () => [
        { paneId: '%9', sessionId: '$0', pid: 999, path: '/tmp', title: 'shell', reportedAttention: 'working' },
        // a plain shell with no report must not be touched
        { paneId: '%8', sessionId: '$0', pid: 998, path: '/tmp', title: 'shell' }
      ],
      unsetReportedState: async (_socket: SocketRef, pane: string) => { unset.push(pane); return true; }
    };
    const processes = { recognizeAgent: async () => undefined };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toEqual([]);
    expect(unset).toEqual(['%9']);
  });

  it('publishes the tmux mode holding an agent pane so the panel can offer to leave it', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready', paneMode: 'tree-mode' }, { paneId: '%2', sessionId: '$0', pid: 124, path: '/tmp', title: 'Ready' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'claude' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    expect(dashboard.agents.find(agent => agent.pane?.paneId === '%1')).toMatchObject({ pane: { paneMode: 'tree-mode' } });
    expect(dashboard.agents.find(agent => agent.pane?.paneId === '%2')?.pane).not.toHaveProperty('paneMode');
  });

  it('records a sandboxed agent only for the exact @rac_sandboxed sentinel and ignores an empty session', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready', reportedSandboxed: '0', reportedSession: '' }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    expect(dashboard.agents[0]).not.toHaveProperty('sandboxed');
    expect(dashboard.agents[0]).not.toHaveProperty('conversationId');
  });

  it.each(['codex', 'omx'] as const)('does not expose OMX team workers as dashboard agents when their panes are recognised as %s', async (kind) => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [
      { paneId: '%1', sessionId: '$0', pid: 123, path: '/host/cora', title: 'Cora' },
      { paneId: '%2', sessionId: '$0', pid: 124, path: '/host/cora/.omx/team/signup/worktrees/worker-1', title: 'worker-1' },
      { paneId: '%3', sessionId: '$0', pid: 125, path: '/host/cora', title: 'worker-2', startCommand: "exec /bin/sh '/tmp/run/.omx/state/team/signup/runtime/worker-2-startup.sh'" }
    ] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const dashboard = await service.dashboard();

    expect(dashboard.agents).toEqual([expect.objectContaining({ pane: expect.objectContaining({ paneId: '%1' }), title: 'Cora', kind })]);
  });

  it('coalesces concurrent discovery requests and reuses a fresh snapshot', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let finds = 0;
    let inspections = 0;
    const finder = { find: async () => { finds += 1; return [socket]; } };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }] };
    const processes = { recognizeAgent: async (pid: number) => { inspections += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { kind: 'codex' as const, pid, wrapped: false }; } };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);
    const third = await service.refresh();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(finds).toBe(1);
    expect(inspections).toBe(1);
  });

  // force refreshes must bypass a still-valid dashboard snapshot
  it('forces a fresh dashboard for lifecycle revalidation', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let title = 'Ready';
    let listings = 0;
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => { listings += 1; return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title }]; } };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    // slow subprocesses must not accidentally expire the cache under test
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const first = await service.dashboard();
      title = '⠋ Working';
      const cached = await service.dashboard();
      const fresh = await service.dashboard(true);

      expect(first.agents[0]?.title).toBe('Ready');
      expect(cached.agents[0]?.title).toBe('Ready');
      expect(fresh.agents[0]?.title).toBe('⠋ Working');
      expect(listings).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('forces discovery after an older scan already in flight', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let title = 'Ready';
    let listings = 0;
    let markListingStarted!: () => void;
    let releaseListing!: () => void;
    const listingStarted = new Promise<void>(resolve => { markListingStarted = resolve; });
    const listingBlocked = new Promise<void>(resolve => { releaseListing = resolve; });
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => {
      listings += 1;
      const capturedTitle = title;
      // hold only the stale scan
      if (listings === 1) {
        markListingStarted();
        await listingBlocked;
      }
      return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: capturedTitle }];
    } };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const stale = service.dashboard();
    await listingStarted;
    title = '⠋ Working';
    const fresh = service.dashboard(true);
    releaseListing();

    await expect(stale).resolves.toMatchObject({ agents: [{ title: 'Ready' }] });
    await expect(fresh).resolves.toMatchObject({ agents: [{ title: '⠋ Working' }] });
    expect(listings).toBe(2);
  });

  // join one live pane scan across concurrent fresh dashboard readers
  it('coalesces concurrent fresh agent reads without forcing socket discovery', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let finds = 0;
    let listings = 0;
    let markListingStarted!: () => void;
    let releaseListing!: () => void;
    const listingStarted = new Promise<void>(resolve => { markListingStarted = resolve; });
    const listingBlocked = new Promise<void>(resolve => { releaseListing = resolve; });
    const finder = { find: async () => { finds += 1; return [socket]; } };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => {
      listings += 1;
      markListingStarted();
      await listingBlocked;
      return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: '⠋ Working' }];
    } };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const first = service.dashboard(false, true);
    await listingStarted;
    const second = service.dashboard(false, true);
    releaseListing();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { agents: [{ attention: 'working' }] },
      { agents: [{ attention: 'working' }] }
    ]);
    expect(listings).toBe(1);
    expect(finds).toBe(1);
  });

  // retain only the newest dashboard when an older enrichment finishes last
  it('does not let an older fresh dashboard overwrite a newer forced snapshot', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let title = 'Ready';
    let pullRequestLookups = 0;
    let markFirstLookupStarted!: () => void;
    let releaseFirstLookup!: () => void;
    const firstLookupStarted = new Promise<void>(resolve => { markFirstLookupStarted = resolve; });
    const firstLookupBlocked = new Promise<void>(resolve => { releaseFirstLookup = resolve; });
    const finder = { find: async () => [socket] };
    // a checkout on a branch, so the agent's enrichment reads its pull request
    const checkout = await mkdtemp(join(tmpdir(), 'rac-dashboard-'));
    execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
    const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: checkout, title }] };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, branch: async () => ({}), repositoryAt: async () => {
      pullRequestLookups += 1;
      // hold only the older dashboard after it captured Ready
      if (pullRequestLookups === 1) {
        markFirstLookupStarted();
        await firstLookupBlocked;
      }
      return undefined;
    } };
    const service = new DiscoveryService(finder, tmux as never, processes, pullRequests);

    const older = service.dashboard(false, true);
    await firstLookupStarted;
    title = '⠋ Working';
    const newer = await service.dashboard(true);
    releaseFirstLookup();
    await older;

    expect(newer.agents[0]?.attention).toBe('working');
    await expect(service.dashboard()).resolves.toMatchObject({ agents: [{ attention: 'working' }] });
    await rm(checkout, { recursive: true, force: true });
  });

  it('resolves a known target without repeating global discovery after the dashboard cache expires', async () => {
    vi.useFakeTimers();
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let finds = 0;
    let listings = 0;
    let inspections = 0;
    const finder = { find: async () => { finds += 1; return [socket]; } };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => { listings += 1; return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title: 'Ferry' }]; } };
    const processes = { recognizeAgent: async (pid: number) => { inspections += 1; return { kind: 'codex' as const, pid, wrapped: false }; } };
    const service = new DiscoveryService(finder, tmux as never, processes);

    try {
      const [agent] = await service.refresh();
      vi.advanceTimersByTime(2_100);

      await expect(service.target(agent!.id)).resolves.toMatchObject({ agent: { pane: { paneId: '%1' } }, socket });

      expect(finds).toBe(2);
      expect(listings).toBe(1);
      expect(inspections).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes a known target when launch confirmation requires current pane state', async () => {
    const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    let title = 'Framework';
    let listings = 0;
    const finder = { find: async () => [socket] };
    const tmux = { markSessionPlace: async () => true, listPanes: async () => { listings += 1; return [{ paneId: '%1', sessionId: '$0', pid: 123, path: '/host/ferry', title }]; } };
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(finder, tmux as never, processes);

    const [agent] = await service.refresh();
    title = 'Ready';

    await expect(service.target(agent!.id, true)).resolves.toMatchObject({ agent: { title: 'Ready' }, socket });
    expect(listings).toBe(2);
  });

  // concurrent enrichment and the next cached read share one dashboard
  it('coalesces concurrent dashboard enrichment so slow polls cannot accumulate', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-dashboard-'));
    execFileSync('git', ['init', '-q', '-b', 'main', workspace]);
    let lookups = 0;
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {},
      branch: async () => ({}), repositoryAt: async () => {
        lookups += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return undefined;
      }
    };
    const project = testProject({ id: 'slow', label: 'Slow', path: workspace });
    const service = new DiscoveryService({ find: async () => [] }, { markSessionPlace: async () => true, listPanes: async () => [] } as never, { recognizeAgent: async () => undefined }, pullRequests, undefined, [project], undefined, listImpl({ [workspace]: [entry(workspace, 'main')] }));

    // isolate coalescing from elapsed subprocess time
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const [first, second] = await Promise.all([service.dashboard(), service.dashboard()]);
      const third = await service.dashboard();

      expect(first).toBe(second);
      expect(third).toBe(first);
      // one enrichment: its Worktree's branch and its Project's GitHub repository
      expect(lookups).toBe(2);
    } finally { clock.mockRestore(); await rm(workspace, { recursive: true, force: true }); }
  });

  // keep git worktree discovery cached during live pane refreshes
  it('refreshes agents without rescanning cached worktrees', async () => {
    const project = testProject({ id: 'app', label: 'App', path: '/repo' });
    let worktreeScans = 0;
    const list = async () => { worktreeScans += 1; return [entry('/repo', 'main')]; };
    const service = new DiscoveryService(socketFinder(), paneLister([]) as never, processInspector({ codex: false }), undefined, undefined, [project], undefined, list);

    await service.dashboard(false, true);
    await service.dashboard(false, true);

    expect(worktreeScans).toBe(1);
  });

  it('discovers worktrees from git porcelain, excludes bare and stale entries, and shapes them by Project', async () => {
    const finder = socketFinder();
    const tmux = paneLister([]);
    const processes = processInspector({ codex: false });
    const project = testProject({ id: 'app', label: 'App', path: '/repo' });
    // an explicit pin override on the detached checkout; the Main worktree pins by default
    const pins = {
      pins: async () => ({ 'app:/repo/wt-detached': true }),
      labels: async () => ({ 'app:/repo': 'App', 'app:/repo/wt-feature': '🥔 Dave' }),
      // the Issue the console created the feature checkout for
      issues: async () => ({ 'app:/repo/wt-feature': 12 })
    };
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], pins, listImpl({ '/repo': [
      entry('/repo', 'main'),
      entry('/repo/wt-feature', 'feature'),
      entry('/repo/wt-detached'),
      { path: '/repo.git', detached: false, bare: true, locked: false, prunable: false },
      entry('/repo/gone', 'ghost', { prunable: true }),
      entry('/repo/held', 'held', { locked: true, lockedReason: 'in use' })
    ] }));

    const worktrees = (await service.dashboard()).projects[0]!.worktrees;

    // bare and stale (prunable) entries drop out; Main first, then Linked by branch, detached last
    expect(worktrees.map(view => ({ id: view.id, label: view.label, customLabel: view.customLabel === true, main: view.main, detached: view.detached, locked: view.locked, pinned: view.pinned, order: view.order }))).toEqual([
      { id: 'app:/repo', label: 'App', customLabel: true, main: true, detached: false, locked: false, pinned: true, order: 0 },
      { id: 'app:/repo/wt-feature', label: '🥔 Dave', customLabel: true, main: false, detached: false, locked: false, pinned: false, order: 1 },
      { id: 'app:/repo/held', label: 'App · held', customLabel: false, main: false, detached: false, locked: true, pinned: false, order: 2 },
      { id: 'app:/repo/wt-detached', label: 'App · abcdef1', customLabel: false, main: false, detached: true, locked: false, pinned: true, order: 3 }
    ]);
    expect(service.worktreesNow().map(worktree => worktree.issue)).toEqual([undefined, 12, undefined, undefined]);
  });

  it('labels a linked pr-<number> checkout by its folder, whatever branch it holds, under the current Project label', async () => {
    const pins = { pins: async () => ({}), labels: async () => ({}) };
    const scan = (label: string) => new DiscoveryService(socketFinder(), paneLister([]) as never, processInspector({ codex: false }), undefined, undefined, [testProject({ id: 'app', label, path: '/repo' })], pins, listImpl({ '/repo': [
      entry('/repo', 'main'),
      entry('/repo/wts/pr-7', 'feature/draft'),
      entry('/repo/wts/pr-8', `rac/pr/8/${'b'.repeat(12)}`),
      entry('/repo/wts/pr-x', 'feature/other')
    ] }));

    expect((await scan('App').dashboard()).projects[0]!.worktrees.map(view => [view.label, view.customLabel === true])).toEqual([['App', false], ['App · pr-7', false], ['App · feature/other', false], ['App · pr-8', false]]);
    // a renamed Project renames the generated label with it
    expect((await scan('Shop').dashboard()).projects[0]!.worktrees.map(view => view.label)).toContain('Shop · pr-7');
  });

  // checkout runtime settings stay separate from project grouping and discovery
  it('publishes distinct worktree previews and replacement commands without inventing checkouts', async () => {
    const commands = { start: 'full up', stop: 'full stop', migrate: 'full migrate' };
    const project = testProject({
      id: 'app', path: '/repo', commands, projectUrl: 'https://main.external.example.com',
      worktreeOverrides: [
        { path: '/repo/feature', commands: { start: 'ui up' }, projectUrl: 'https://feature.example.com', projectPort: 4000 },
        { path: '/repo/readonly', commands: {} },
        { path: '/repo/missing', commands: { start: 'missing up' } }
      ]
    });
    const service = new DiscoveryService(socketFinder(), paneLister([]) as never, processInspector({ codex: false }), undefined, undefined, [project], undefined, listImpl({ '/repo': [
      entry('/repo', 'main'), entry('/repo/feature', 'feature'), entry('/repo/readonly'), entry('/repo/feature-extra', 'unconfigured')
    ] }));
    const dashboard = await service.dashboard();
    const worktrees = service.worktreesNow();
    expect(worktrees).toHaveLength(4);
    expect(worktrees.find(worktree => worktree.path === '/repo')).toMatchObject({ commands, projectUrl: 'https://main.external.example.com' });
    expect(worktrees.find(worktree => worktree.path === '/repo')).not.toHaveProperty('projectPort');
    expect(worktrees.find(worktree => worktree.path === '/repo/feature')).toMatchObject({ commands: { start: 'ui up' }, projectUrl: 'https://feature.example.com', projectPort: 4000 });
    expect(worktrees.find(worktree => worktree.path === '/repo/feature')?.commands).not.toHaveProperty('migrate');
    expect(worktrees.find(worktree => worktree.path === '/repo/readonly')?.commands).toEqual({});
    expect(worktrees.find(worktree => worktree.path === '/repo/readonly')).not.toHaveProperty('projectUrl');
    expect(worktrees.find(worktree => worktree.path === '/repo/readonly')).not.toHaveProperty('projectPort');
    expect(worktrees.find(worktree => worktree.path === '/repo/feature-extra')).toMatchObject({ commands, projectUrl: 'https://main.external.example.com' });
    expect(dashboard.projects[0]?.worktrees.find(worktree => worktree.path === '/repo/feature')?.projectUrl).toBe('https://feature.example.com');
    expect(dashboard.projects[0]?.worktrees.find(worktree => worktree.path === '/repo/feature')?.projectProxied).toBe(true);
    expect(dashboard.projects[0]?.worktrees.find(worktree => worktree.path === '/repo')?.projectProxied).toBe(false);
    expect(dashboard.projects[0]?.worktrees.find(worktree => worktree.path === '/repo/readonly')?.projectUrl).toBeUndefined();
    expect(dashboard.projects[0]?.worktrees.find(worktree => worktree.path === '/repo/readonly')?.projectProxied).toBeUndefined();
  });

  // configured paths outrank branch names and detached status without inventing checkouts
  it('applies project worktree order and retains default sorting for unlisted checkouts', async () => {
    const project = testProject({ id: 'app', path: '/repo', worktreeOrder: ['/repo', '/repo/owen', '/repo/dave', '/repo/eric', '/repo/alex', '/repo/missing'] });
    const service = new DiscoveryService(socketFinder(), paneLister([]) as never, processInspector({ codex: false }), undefined, undefined, [project], undefined, listImpl({ '/repo': [
      entry('/repo', 'main'), entry('/repo/alex'), entry('/repo/dave', 'aaa'), entry('/repo/eric', 'bbb'), entry('/repo/owen', 'zzz'),
      entry('/repo/zulu', 'zulu'), entry('/repo/alpha', 'alpha'), entry('/repo/detached')
    ] }));
    const worktrees = (await service.dashboard()).projects[0]!.worktrees;
    // both launch rows and tab indices follow the same configured sequence
    expect(worktrees.map(worktree => worktree.path)).toEqual(['/repo', '/repo/owen', '/repo/dave', '/repo/eric', '/repo/alex', '/repo/alpha', '/repo/zulu', '/repo/detached']);
    expect(worktrees.map(worktree => worktree.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('reports Prune-eligible stale paths: git prunable entries plus records git lists nowhere', async () => {
    const finder = socketFinder();
    const tmux = paneLister([]);
    const processes = processInspector({ codex: false });
    const project = testProject({ id: 'app', label: 'App', path: '/repo' });
    // records: two git still lists (kept), one whose path git lists only as prunable (must be
    // counted once, not again as an orphan), one git lists nowhere (orphan), one for another Project
    const pinStore = { pins: async () => ({}), keys: async () => ['app:/repo', 'app:/repo/wt-feature', 'app:/repo/gone', 'app:/repo/orphan', 'other:/elsewhere'] };
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], pinStore, listImpl({ '/repo': [
      entry('/repo', 'main'),
      entry('/repo/wt-feature', 'feature'),
      entry('/repo/gone', 'ghost', { prunable: true })
    ] }));

    const stalePaths = (await service.dashboard()).projects[0]!.stalePaths;

    // the prunable checkout (once, though a record also points at it) and the orphaned record
    expect([...stalePaths].sort()).toEqual(['/repo/gone', '/repo/orphan']);
  });

  it('re-reads pins after invalidation and never lets a stale in-flight scan clobber the fresh set', async () => {
    const finder = socketFinder();
    const tmux = paneLister([]);
    const processes = processInspector({ codex: false });
    const project = testProject({ id: 'app', path: '/repo' });
    // a pins() that returns the pin state as of when the scan reads it, gated so a scan can be
    // held in flight across an invalidation
    let pinsValue: Record<string, boolean> = { 'app:/repo': false };
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let reads = 0;
    const pinStore = { pins: async () => { reads += 1; if (reads === 1) await firstBlocked; return pinsValue; } };
    const service = new DiscoveryService(finder, tmux as never, processes, undefined, undefined, [project], pinStore, listImpl({ '/repo': [entry('/repo', 'main')] }));

    // scan P1 begins and blocks inside pins() with the old (unpinned) state
    const first = service.worktrees();
    // an operator toggles the pin: invalidate, then flip the store to pinned
    service.invalidateWorktrees();
    pinsValue = { 'app:/repo': true };
    // a fresh read must not coalesce onto the stale P1; it starts P2 reading the new pins
    const second = await service.worktrees();
    expect(second[0]?.pinned).toBe(true);
    // when the stale P1 finally resolves it must not re-stamp the snapshot back to unpinned
    releaseFirst();
    await first;
    expect(service.worktreesNow()[0]?.pinned).toBe(true);
  });

  it('finds a pending OMX question pane associated with its return pane', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-question-'));
    try {
      const questions = join(workspace, '.omx', 'state', 'sessions', 'session', 'questions');
      await mkdir(questions, { recursive: true });
      await writeFile(join(questions, 'question-test.json'), JSON.stringify({ kind: 'omx.question/v1', question_id: 'question-test', status: 'prompting', question: 'Choose one?', options: [{ label: 'Yes' }, { label: 'No' }], renderer: { target: '%22', return_target: '%1' } }));
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toEqual({ id: inlineQuestionId('Choose one?', ['Yes', 'No']), text: 'Choose one?', choices: ['Yes', 'No'], source: 'structured', pane: { targetPaneId: '%22' } });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('resolves a pending OMX question file to the question state through the dashboard for an OMX pane', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-question-dash-'));
    try {
      // git-init so workspaceRoot() resolves to a stable toplevel; build the question dir under it
      execFileSync('/usr/bin/git', ['init', '--quiet', workspace]);
      const root = execFileSync('/usr/bin/git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      const questions = join(root, '.omx', 'state', 'sessions', 'session', 'questions');
      await mkdir(questions, { recursive: true });
      await writeFile(join(questions, 'q.json'), JSON.stringify({ kind: 'omx.question/v1', question_id: 'question-q1', status: 'prompting', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }], renderer: { target: '%9', return_target: '%1' } }));
      const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
      const finder = { find: async () => [socket] };
      const tmux = { markSessionPlace: async () => true, listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 123, path: workspace, title: 'Ready' }] };
      // the structured question files are OMX's: a plain Codex pane never reads them
      const processes = { recognizeAgent: async (pid: number) => ({ kind: 'omx' as const, pid, wrapped: false }) };
      const service = new DiscoveryService(finder, tmux as never, processes);

      const dashboard = await service.dashboard();

      // the title infers 'finished', but the pending question outranks it
      expect(dashboard.agents[0]).toMatchObject({ kind: 'omx', attention: 'question', question: { id: inlineQuestionId('Deploy?', ['Yes', 'No']), text: 'Deploy?', choices: ['Yes', 'No'], field: { kind: 'choice', choices: ['Yes', 'No'] }, source: 'structured', pane: { targetPaneId: '%9' } } });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('attaches a Claude Agent reported question by confirming its payload against a fresh capture', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-claude-question-'));
    try {
      const payload = Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Deploy where?', header: 'Target', options: [{ label: 'Staging' }, { label: 'Production' }], multiSelect: false }] } })).toString('base64');
      const dialog = [' ☐ Target', '│ Deploy where?', '❯ 1. Staging', '  2. Production', '  3. Type something.'].join('\n');
      const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
      const finder = { find: async () => [socket] };
      const tmux = {
        markSessionPlace: async () => true,
        listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 321, path: workspace, title: '', reportedAttention: 'question', reportedQuestion: payload }],
        capture: async () => dialog,
      };
      const processes = { recognizeAgent: async (pid: number) => ({ kind: 'claude' as const, pid, wrapped: false }) };
      const service = new DiscoveryService(finder, tmux as never, processes);

      const dashboard = await service.dashboard();

      expect(dashboard.agents[0]).toMatchObject({ kind: 'claude', attention: 'question', question: { id: inlineQuestionId('Deploy where?', ['Staging', 'Production']), text: 'Deploy where?', choices: ['Staging', 'Production'], source: 'structured' } });
      // the raw payload stays server-side, never anywhere in the published dashboard
      expect(JSON.stringify(dashboard)).not.toContain(payload);
      expect(service.reportedQuestionPayload('socket:%1')).toBe(payload);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('attaches no reported question when the pane capture shows an already-answered dialog', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-claude-stale-'));
    try {
      const payload = Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Deploy where?', header: 'Target', options: [{ label: 'Staging' }, { label: 'Production' }], multiSelect: false }] } })).toString('base64');
      // the payload lingers (an answer fires no clearing hook synchronously), but the
      // capture shows the answered summary — the text repeats, yet no numbered row remains
      const answered = ['● User answered Claude\'s questions:', '  ⎿  · Deploy where? → Production', '', '❯ '].join('\n');
      const socket: SocketRef = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
      const finder = { find: async () => [socket] };
      const tmux = {
        markSessionPlace: async () => true,
        listPanes: async () => [{ paneId: '%1', sessionId: '$0', pid: 321, path: workspace, title: '', reportedQuestion: payload }],
        capture: async () => answered,
      };
      const processes = { recognizeAgent: async (pid: number) => ({ kind: 'claude' as const, pid, wrapped: false }) };
      const service = new DiscoveryService(finder, tmux as never, processes);

      const dashboard = await service.dashboard();

      // the capture-confirmation drops the phantom question even though the payload is present
      expect(dashboard.agents[0]).not.toHaveProperty('question');
      expect(service.reportedQuestionPayload('socket:%1')).toBe(payload);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});

describe('DiscoveryService Places', () => {
  const push = { label: 'p', prompt: '$p' };
  const notes = () => testProject({ id: 'notes', label: 'Notes', path: '/data/notes', identity: '/data/notes', mode: 'directory', hostPath: '/host/notes', push });
  const ferry = () => testProject({ id: 'ferry', label: 'Ferry', path: '/worktrees/ferry', push });
  const worktreeLists = listImpl({ '/worktrees/ferry': [entry('/worktrees/ferry', 'main')] });
  // one agent pane per path (pane ids %1, %2, … in order); non-git fake paths resolve to themselves
  const agentPanes = (...paths: string[]) => paneLister(paths.map((path, index) => ({ paneId: `%${index + 1}`, sessionId: `$${index}`, pid: 100 + index, path, title: 'Ready' })));
  const service = (tmux: ReturnType<typeof paneLister>, options: { codex?: boolean; pins?: Record<string, boolean> } = {}) =>
    new DiscoveryService(socketFinder(), tmux as never, processInspector({ codex: options.codex ?? true }), undefined, undefined, [ferry(), notes()], { pins: async () => options.pins ?? {} }, worktreeLists, '/home/me/scratch');

  it('tags every Agent with the Place it belongs to and sets home to the Place home', async () => {
    const dashboard = await service(agentPanes('/worktrees/ferry', '/data/notes/2026', '/home/me/scratch/probe', '/srv/tools')).dashboard();

    expect(dashboard.agents.map(agent => ({ paneId: agent.pane?.paneId, placeId: agent.placeId, home: agent.home, worktreeId: agent.worktreeId }))).toEqual([
      { paneId: '%1', placeId: 'ferry:/worktrees/ferry', home: '/worktrees/ferry', worktreeId: 'ferry:/worktrees/ferry' },
      // a directory-Project Agent in a subfolder
      { paneId: '%2', placeId: 'notes:/data/notes', home: '/data/notes', worktreeId: undefined },
      // a Scratch Agent in a subfolder of the configured Scratch folder
      { paneId: '%3', placeId: 'scratch:/home/me/scratch', home: '/home/me/scratch', worktreeId: undefined },
      // an Agent in an unconfigured folder is its own Scratch Place
      { paneId: '%4', placeId: 'scratch:/srv/tools', home: '/srv/tools', worktreeId: undefined }
    ]);
  });

  it('places an Agent in a nested, unconfigured checkout inside a Worktree in that Worktree', async () => {
    const dashboard = await service(agentPanes('/worktrees/ferry/vendor/lib')).dashboard();

    expect(dashboard.agents[0]).toMatchObject({ placeId: 'ferry:/worktrees/ferry', worktreeId: 'ferry:/worktrees/ferry', projectId: 'ferry', home: '/worktrees/ferry' });
  });

  it('tags the Agent a target lookup returns with its Place but keeps home as the folder its pane runs in', async () => {
    const discovery = service(agentPanes('/host/notes/drafts', '/worktrees/ferry/vendor/lib'));

    // the dashboard claims both unmarked sessions; the next scan reads the marks back
    await discovery.dashboard();

    // attachments, a teardown, file links and conversations act in the pane's own folder, so the
    // server-side Agent keeps it; only the dashboard publishes the Place home
    expect((await discovery.target('socket:%1', true))?.agent).toMatchObject({ placeId: 'notes:/data/notes', home: '/host/notes/drafts' });
    expect((await discovery.target('socket:%2'))?.agent).toMatchObject({ placeId: 'ferry:/worktrees/ferry', home: '/worktrees/ferry/vendor/lib' });
    expect((await discovery.target('socket:%2'))?.agent).not.toHaveProperty('worktreeId');
  });

  it("reads a Scratch Agent's branch from the checkout it runs in, not from its Place home", async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'rac-scratch-')));
    try {
      const checkout = join(scratch, 'tool');
      execFileSync('/usr/bin/git', ['init', '--quiet', '--initial-branch', 'probe', checkout]);
      execFileSync('/usr/bin/git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'init']);
      const discovery = new DiscoveryService(socketFinder(), agentPanes(checkout) as never, processInspector(), undefined, undefined, [], { pins: async () => ({}) }, listImpl({}), scratch);

      const dashboard = await discovery.dashboard();

      expect(dashboard.agents[0]).toMatchObject({ placeId: `scratch:${scratch}`, home: scratch, branch: 'probe' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("publishes an Agent's new branch on the first dashboard after invalidateWorktrees()", async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'rac-scratch-')));
    try {
      const checkout = join(scratch, 'tool');
      execFileSync('/usr/bin/git', ['init', '--quiet', '--initial-branch', 'probe', checkout]);
      execFileSync('/usr/bin/git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'init']);
      const discovery = new DiscoveryService(socketFinder(), agentPanes(checkout) as never, processInspector(), undefined, undefined, [], { pins: async () => ({}) }, listImpl({}), scratch);
      expect((await discovery.dashboard()).agents[0]).toMatchObject({ branch: 'probe' });

      // a branch switch inside the git metadata cache window, as the PR fly-out does
      execFileSync('/usr/bin/git', ['-C', checkout, 'switch', '--quiet', '-c', 'switched']);
      discovery.invalidateWorktrees();

      expect((await discovery.dashboard()).agents[0]).toMatchObject({ branch: 'switched' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('lists directory-Project and Scratch Places with their Console-shell counts and pins', async () => {
    const tmux = paneLister([
      { paneId: '%1', sessionId: '$0', pid: 11, path: '/data/notes/2026', command: 'zsh', role: 'shell', title: '' },
      { paneId: '%2', sessionId: '$0', pid: 12, path: '/host/notes', command: 'zsh', role: 'shell', title: '' },
      { paneId: '%3', sessionId: '$1', pid: 13, path: '/opt/shell-only', command: 'zsh', role: 'shell', title: '' },
      // an unmarked shell does not make an ad-hoc Scratch Place
      { paneId: '%4', sessionId: '$2', pid: 14, path: '/opt/bare', command: 'zsh', title: '' },
      // a Console shell in a nested checkout counts for the Worktree around it
      { paneId: '%5', sessionId: '$3', pid: 15, path: '/worktrees/ferry/vendor/lib', command: 'zsh', role: 'shell', title: '' }
    ]);

    const dashboard = await service(tmux, { codex: false, pins: { 'notes:/data/notes': true } }).dashboard();

    expect(dashboard.projects.find(project => project.id === 'ferry')?.worktrees).toMatchObject([{ id: 'ferry:/worktrees/ferry', consoleShells: 1 }]);
    expect(dashboard.places).toEqual([
      { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: true, consoleShells: 2 },
      { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch', pinned: false },
      { id: 'scratch:/opt/shell-only', kind: 'scratch', projectId: 'scratch', label: 'shell-only', home: '/opt/shell-only', adhoc: true, pinned: false, consoleShells: 1 }
    ]);
  });

  it('lists an ad-hoc Scratch Place that holds an Agent', async () => {
    const dashboard = await service(agentPanes('/srv/tools')).dashboard();

    expect(dashboard.places.map(place => place.id)).toEqual(['notes:/data/notes', 'scratch:/home/me/scratch', 'scratch:/srv/tools']);
  });

  it("places every pane of a marked session by its session's mark, wherever the pane has cd'd", async () => {
    const tmux = paneLister([
      // the notes Workspace session: its Agent and its Console shell have both cd'd elsewhere
      { paneId: '%1', sessionId: '$0', pid: 101, path: '/worktrees/ferry', title: 'Ready', placeMark: 'notes:/data/notes' },
      { paneId: '%2', sessionId: '$0', pid: 102, path: '/srv/elsewhere', command: 'zsh', role: 'shell', title: '', placeMark: 'notes:/data/notes' },
      // the operator's own session sat in the Worktree: no Agent, no Console shell, never claimed
      { paneId: '%3', sessionId: '$1', pid: 103, path: '/worktrees/ferry', command: 'zsh', title: '' }
    ]);
    const processes = { recognizeAgent: async (pid: number) => pid === 101 ? { kind: 'codex' as const, pid, wrapped: false } : undefined };
    const discovery = new DiscoveryService(socketFinder(), tmux as never, processes, undefined, undefined, [ferry(), notes()], { pins: async () => ({}) }, worktreeLists, '/home/me/scratch');

    const dashboard = await discovery.dashboard();

    expect(dashboard.agents).toMatchObject([{ pane: { paneId: '%1' }, placeId: 'notes:/data/notes', home: '/data/notes' }]);
    expect(dashboard.agents[0]).not.toHaveProperty('worktreeId');
    expect(dashboard.projects.find(project => project.id === 'ferry')?.worktrees[0]).not.toHaveProperty('consoleShells');
    expect(dashboard.places.map(place => [place.id, place.consoleShells])).toEqual([['notes:/data/notes', 1], ['scratch:/home/me/scratch', undefined]]);
    expect(tmux.marks.has('$1')).toBe(false);
  });

  it('claims an unmarked session once by its Agent before its Console shell, and never re-derives the claim', async () => {
    const agent = { paneId: '%1', sessionId: '$0', pid: 101, path: '/data/notes/2026', title: 'Ready' };
    const tmux = paneLister([agent, { paneId: '%2', sessionId: '$0', pid: 102, path: '/worktrees/ferry', command: 'zsh', role: 'shell', title: '' }]);
    const processes = { recognizeAgent: async (pid: number) => pid === 101 ? { kind: 'codex' as const, pid, wrapped: false } : undefined };
    const discovery = new DiscoveryService(socketFinder(), tmux as never, processes, undefined, undefined, [ferry(), notes()], { pins: async () => ({}) }, worktreeLists, '/home/me/scratch');

    expect((await discovery.dashboard()).agents[0]).toMatchObject({ placeId: 'notes:/data/notes' });
    expect(tmux.marks.get('$0')).toBe('notes:/data/notes');

    // the Agent's shell moves into the Worktree: the session stays the notes Workspace
    agent.path = '/worktrees/ferry';
    const later = await discovery.dashboard(true);

    expect(later.agents[0]).toMatchObject({ placeId: 'notes:/data/notes' });
    expect(tmux.marks.get('$0')).toBe('notes:/data/notes');
    expect(later.places.find(place => place.id === 'notes:/data/notes')?.consoleShells).toBe(1);
  });

  it('leaves a session whose mark names no listed Place unplaced, and never overwrites the mark', async () => {
    // a Worktree the snapshot has not caught up to, or one since removed
    const tmux = paneLister([{ paneId: '%1', sessionId: '$0', pid: 101, path: '/worktrees/ferry', title: 'Ready', placeMark: 'ferry:/worktrees/ferry-next' }]);

    const dashboard = await service(tmux).dashboard();

    expect(dashboard.agents[0]).not.toHaveProperty('placeId');
    expect(tmux.marks.has('$0')).toBe(false);
  });

  it('keeps listing a pinned ad-hoc Scratch Place with nothing in it while its folder exists outside every configured Place', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-pinned-')));
    try {
      await mkdir(join(root, 'tools'));
      await mkdir(join(root, 'notes', 'drafts'), { recursive: true });
      const notesHere = testProject({ id: 'notes', label: 'Notes', path: join(root, 'notes'), identity: join(root, 'notes'), mode: 'directory', push });
      const pins = {
        [`scratch:${root}/tools`]: true,
        [`scratch:${root}/unpinned`]: false,
        // removed since it was pinned
        [`scratch:${root}/gone`]: true,
        // pinned as its own Scratch Place before notes became a directory Project
        [`scratch:${root}/notes/drafts`]: true
      };
      const discovery = new DiscoveryService(socketFinder(), paneLister([]) as never, processInspector({ codex: false }), undefined, undefined, [notesHere], { pins: async () => pins }, listImpl({}), '/home/me/scratch');

      const dashboard = await discovery.dashboard();

      expect(dashboard.places.map(place => place.id)).toEqual([`notes:${root}/notes`, 'scratch:/home/me/scratch', `scratch:${root}/tools`]);
      expect(dashboard.places.at(-1)).toEqual({ id: `scratch:${root}/tools`, kind: 'scratch', projectId: 'scratch', label: 'tools', home: `${root}/tools`, adhoc: true, pinned: true });
      // the listed Place resolves by id with its server-side shape; an unlisted one does not
      await expect(discovery.place(`scratch:${root}/tools`)).resolves.toMatchObject({ kind: 'scratch', home: `${root}/tools`, adhoc: true });
      await expect(discovery.place(`scratch:${root}/gone`)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a listed directory-Project Place with its bridge host path', async () => {
    const discovery = service(paneLister([]), { codex: false });

    await expect(discovery.place('notes:/data/notes')).resolves.toEqual({ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', hostPath: '/host/notes' });
    // a Worktree resolves from the Worktree snapshot, not here
    await expect(discovery.place('ferry:/worktrees/ferry')).resolves.toBeUndefined();
  });

  it('never places an update advisor', async () => {
    const tmux = paneLister([{ paneId: '%1', sessionId: '$0', pid: 1, path: '/srv/advisor', title: 'Ready', displayLabel: 'Update Advisor Starting v4 2222222' }]);

    const dashboard = await service(tmux).dashboard();

    expect(dashboard.agents[0]).not.toHaveProperty('placeId');
    expect(dashboard.agents[0]).toMatchObject({ home: '/srv/advisor' });
    expect(dashboard.places.map(place => place.id)).toEqual(['notes:/data/notes', 'scratch:/home/me/scratch']);
  });
});
