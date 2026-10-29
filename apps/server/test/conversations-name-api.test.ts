import argon2 from 'argon2';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { buildApp } from '../src/app.js';
import { ConsoleNamedConversationService } from '../src/conversations/console-named-service.js';
import { testConfig, testWorktree } from './helpers/config.js';
import type { AgentKind } from '../src/adapters/types.js';

const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const claudeId = '11111111-2222-4333-8444-555555555555';
const codexId = '0198c555-5555-7555-8555-555555555555';
const cwd = '/host/cora';

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});
// set one env var for the duration of a test, restoring it afterEach
function setEnv(key: string, value: string) { if (!(key in savedEnv)) savedEnv[key] = process.env[key]; process.env[key] = value; }

// authenticate one test browser
async function authenticatedHeaders(app: Awaited<ReturnType<typeof buildApp>>) {
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
}

// a live agent target the naming route resolves through discovery
const agentTarget = (kind: AgentKind, attention = 'finished') => ({ id: 'agent-1', kind, pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: cwd, title: 'Ready', attention });

// a discovery fake shaped for the naming route, listing one row for the named Conversation
function namingDiscovery(kind: AgentKind, conversationId: string, worktrees: ReturnType<typeof testWorktree>[], attention = 'finished') {
  const agent = agentTarget(kind, attention);
  return {
    target: async (id: string) => id === agent.id ? { agent, socket } : undefined,
    worktreesNow: () => worktrees,
    dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [] }),
    conversationId: async () => conversationId,
    paneDirectory: () => cwd,
    // the row the naming route re-lists to return; the store intersection sets consoleNamed
    conversations: async (directories: readonly string[]) => directories.includes(cwd)
      ? [{ kind, id: conversationId, name: 'Wire the adapter', lastActiveAt: 500, directory: cwd }]
      : [],
  };
}

// a fake tmux that records the pasted rename and keys, and (optionally) writes the agent's
// own store so the route's real read-back through the Adapter confirms the name
function recordingTmux(apply?: (pasted: string) => Promise<void>) {
  const calls: { pasted?: string; keys?: readonly string[] } = {};
  return {
    calls,
    tmux: {
      pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, text: string) => { calls.pasted = text; await apply?.(text); return true; },
      sendKeys: async (_socket: unknown, _pane: string, keys: readonly string[]) => { calls.keys = keys; return true; },
    },
  };
}

describe('conversation naming API', () => {
  it('names a Claude Conversation: pastes /rename, sends Enter, confirms from the store, records it', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    // the real Claude Adapter reads names from this temp config dir
    const configDir = await mkdtemp(join(tmpdir(), 'rac-name-claude-')); dirs.push(configDir);
    setEnv('RAC_CLAUDE_CONFIG_DIR', configDir);
    // the fake tmux paste writes the human `custom-title` the Adapter reads back
    const projectDir = join(configDir, 'projects', '-host-cora');
    const { calls, tmux } = recordingTmux(async () => {
      await mkdir(projectDir, { recursive: true });
      // a re-emitted ai-title follows the human custom-title, as a renamed transcript ends; the
      // read-back must still confirm the custom-title, not the trailing generated title
      await writeFile(join(projectDir, `${claudeId}.jsonl`), [
        { type: 'custom-title', customTitle: 'Wire the adapter', sessionId: claudeId },
        { type: 'ai-title', aiTitle: 'A generated title the console must ignore', sessionId: claudeId },
      ].map(record => JSON.stringify(record)).join('\n'));
    });
    const consoleNamed = new ConsoleNamedConversationService({ file: join(configDir, 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 61).toString('base64url')), discovery: namingDiscovery('claude', claudeId, [cora]) as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(named.statusCode).toBe(201);
      // Claude's rename is `/rename <name>` submitted with Enter in every state
      expect(calls.pasted).toBe('/rename Wire the adapter');
      expect(calls.keys).toEqual(['Enter']);
      // the returned row is the named Conversation, now console-named and current
      expect(named.json().conversation).toEqual({ kind: 'claude', id: claudeId, name: 'Wire the adapter', lastActiveAt: 500, directory: cwd, worktreeId: cora.id, consoleNamed: true, reviewRun: false, current: true });
      // the console recorded which Conversation it named, keyed by Project id
      const records = await consoleNamed.list('potato');
      expect(records?.map(record => ({ kind: record.kind, id: record.id }))).toEqual([{ kind: 'claude', id: claudeId }]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('names a Codex Conversation with a trailing-space /rename and Enter', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const home = await mkdtemp(join(tmpdir(), 'rac-name-codex-')); dirs.push(home);
    setEnv('CODEX_HOME', home);
    // the fake tmux paste appends the Codex sidecar line the Adapter reads back
    const { calls, tmux } = recordingTmux(async () => {
      await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: codexId, thread_name: 'Wire the adapter' })}\n`);
    });
    const consoleNamed = new ConsoleNamedConversationService({ file: join(home, 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 62).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora]) as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(named.statusCode).toBe(201);
      // Codex's rename carries a trailing space; still Enter in every state
      expect(calls.pasted).toBe('/rename Wire the adapter ');
      expect(calls.keys).toEqual(['Enter']);
      expect((await consoleNamed.list('potato'))?.map(record => record.id)).toEqual([codexId]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('returns 409 and records nothing when the agent never confirms the name', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const home = await mkdtemp(join(tmpdir(), 'rac-name-unconfirmed-')); dirs.push(home);
    setEnv('CODEX_HOME', home);
    // the paste writes a different name, so the read-back never matches
    const { tmux } = recordingTmux(async () => {
      await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: codexId, thread_name: 'A stale generated title' })}\n`);
    });
    const consoleNamed = new ConsoleNamedConversationService({ file: join(home, 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 63).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora]) as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(named.statusCode).toBe(409);
      expect(named.json()).toEqual({ error: 'The agent did not confirm the name.' });
      // an unconfirmed rename records nothing
      await expect(consoleNamed.list('potato')).resolves.toEqual([]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('refuses to name while the agent is asking a question, delivering nothing', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const { calls, tmux } = recordingTmux();
    const consoleNamed = new ConsoleNamedConversationService({ file: join(await mkdtemp(join(tmpdir(), 'rac-name-question-')).then(d => (dirs.push(d), d)), 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 64).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora], 'question') as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(named.statusCode).toBe(409);
      expect(named.json().error).toContain('question');
      // the dialog would swallow the paste, so nothing is delivered
      expect(calls.pasted).toBeUndefined();
      expect(calls.keys).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 15_000);

  it('rejects a blank or malformed name before any delivery', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const { calls, tmux } = recordingTmux();
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 65).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora]) as never, tmux: tmux as never, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const blank = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: '   ' } });
      const multiline = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'one\ntwo' } });
      expect(blank.statusCode).toBe(400);
      expect(multiline.statusCode).toBe(400);
      expect(calls.pasted).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 15_000);

  it('refuses a second rename while one is already in flight for the agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const home = await mkdtemp(join(tmpdir(), 'rac-name-inflight-')); dirs.push(home);
    setEnv('CODEX_HOME', home);
    // hold the paste open until released, so the first request is still in flight
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { calls, tmux } = recordingTmux(async () => {
      await gate;
      await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: codexId, thread_name: 'Wire the adapter' })}\n`);
    });
    const consoleNamed = new ConsoleNamedConversationService({ file: join(home, 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 66).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora]) as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const first = app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      // give the first request time to enter its in-flight window before the second arrives
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Second name' } });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toContain('already in progress');
      // the refused second rename delivered nothing: the pane still holds only the first paste
      expect(calls.pasted).toBe('/rename Wire the adapter ');
      release();
      expect((await first).statusCode).toBe(201);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('retries the read-back until the agent confirms the name on a later poll', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const home = await mkdtemp(join(tmpdir(), 'rac-name-retry-')); dirs.push(home);
    setEnv('CODEX_HOME', home);
    // the paste itself writes nothing; the store confirms the name only before the second poll read
    const { tmux } = recordingTmux();
    let delayCalls = 0;
    const conversationNamePollDelay = async () => {
      delayCalls += 1;
      if (delayCalls === 2) await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: codexId, thread_name: 'Wire the adapter' })}\n`);
    };
    const consoleNamed = new ConsoleNamedConversationService({ file: join(home, 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 69).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora]) as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(named.statusCode).toBe(201);
      // the loop delayed and re-read past the first (empty) attempt before confirming
      expect(delayCalls).toBeGreaterThanOrEqual(2);
      expect((await consoleNamed.list('potato'))?.map(record => record.id)).toEqual([codexId]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('confirms a name whose interior whitespace the agent store collapses', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const home = await mkdtemp(join(tmpdir(), 'rac-name-whitespace-')); dirs.push(home);
    setEnv('CODEX_HOME', home);
    // the store keeps the double-spaced name; the real Codex reader collapses it on read-back, and
    // the route collapses the submitted name to match — otherwise this would falsely 409
    const { calls, tmux } = recordingTmux(async () => {
      await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: codexId, thread_name: 'Fix  login  bug' })}\n`);
    });
    const consoleNamed = new ConsoleNamedConversationService({ file: join(home, 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 70).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora]) as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Fix  login  bug' } });
      expect(named.statusCode).toBe(201);
      // the console pastes and records the collapsed form the store will echo back
      expect(calls.pasted).toBe('/rename Fix login bug ');
      expect((await consoleNamed.list('potato'))?.map(record => record.id)).toEqual([codexId]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('does not deliver or record when delivery, the current id, or the adapter fail', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const directory = await mkdtemp(join(tmpdir(), 'rac-name-failures-')); dirs.push(directory);
    // a pane paste that fails yields 502 and records nothing
    const failing = new ConsoleNamedConversationService({ file: join(directory, 'delivery.json') });
    const deliveryApp = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 71).toString('base64url')), discovery: namingDiscovery('codex', codexId, [cora]) as never, tmux: { pastePrompt: async () => false, sendKeys: async () => true } as never, consoleNamed: failing, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(deliveryApp);
      const failed = await deliveryApp.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(failed.statusCode).toBe(502);
      await expect(failing.list('potato')).resolves.toEqual([]);
    } finally {
      await deliveryApp.close();
    }
    // an unknown current Conversation id is refused before any paste
    const { calls, tmux } = recordingTmux();
    const unknownApp = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 72).toString('base64url')), discovery: { ...namingDiscovery('codex', codexId, [cora]), conversationId: async () => undefined } as never, tmux: tmux as never, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(unknownApp);
      const unknown = await unknownApp.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error).toContain('current conversation is unknown');
      expect(calls.pasted).toBeUndefined();
    } finally {
      await unknownApp.close();
    }
    // an agent whose kind has no configured Adapter cannot be named
    const piApp = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 73).toString('base64url')), discovery: namingDiscovery('pi', codexId, [cora]) as never, tmux: recordingTmux().tmux as never, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(piApp);
      const pi = await piApp.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Wire the adapter' } });
      expect(pi.statusCode).toBe(409);
      expect(pi.json().error).toContain('cannot be named');
    } finally {
      await piApp.close();
    }
  }, 20_000);

  it('names and removes a Scratch agent Conversation, keyed to its workspace', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const home = await mkdtemp(join(tmpdir(), 'rac-name-scratch-')); dirs.push(home);
    setEnv('CODEX_HOME', home);
    const { tmux } = recordingTmux(async () => {
      await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: codexId, thread_name: 'Scratch experiment' })}\n`);
    });
    const consoleNamed = new ConsoleNamedConversationService({ file: join(home, 'records.json') });
    // no worktree matches the scratch workspace, so the record keys to the Scratch key
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 67).toString('base64url')), discovery: namingDiscovery('codex', codexId, []) as never, tmux: tmux as never, consoleNamed, conversationNamePollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'POST', url: '/api/agents/agent-1/conversations/name', headers, payload: { name: 'Scratch experiment' } });
      expect(named.statusCode).toBe(201);
      // the Scratch key is opaque; find the one group the record landed in
      const removed = await app.inject({ method: 'DELETE', url: `/api/agents/agent-1/conversations/codex/${codexId}`, headers });
      expect(removed.statusCode).toBe(204);
      // removing the record again is a 404 (it is gone)
      const again = await app.inject({ method: 'DELETE', url: `/api/agents/agent-1/conversations/codex/${codexId}`, headers });
      expect(again.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('removes a Worktree-scoped record, leaving the Conversation named', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    const directory = await mkdtemp(join(tmpdir(), 'rac-name-remove-')); dirs.push(directory);
    const consoleNamed = new ConsoleNamedConversationService({ file: join(directory, 'records.json') });
    await consoleNamed.record('potato', { kind: 'claude', id: claudeId });
    const discovery = { target: async () => undefined, worktreesNow: () => [cora], place: async () => undefined };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 68).toString('base64url')), discovery: discovery as never, consoleNamed });
    try {
      const headers = await authenticatedHeaders(app);
      const removed = await app.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/claude/${claudeId}`, headers });
      expect(removed.statusCode).toBe(204);
      await expect(consoleNamed.list('potato')).resolves.toEqual([]);
      // an unknown Worktree 404s, and an unknown kind 400s
      const unknownWorktree = await app.inject({ method: 'DELETE', url: `/api/worktrees/nope/conversations/claude/${claudeId}`, headers });
      const badKind = await app.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/gemini/${claudeId}`, headers });
      expect(unknownWorktree.statusCode).toBe(404);
      expect(badKind.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('reads the current Conversation name for the agent panel title', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: cwd });
    let current: { id: string; title?: string } | undefined = { id: claudeId, title: 'Wire the adapter' };
    const discovery = { ...namingDiscovery('claude', claudeId, [cora]), conversation: async (id: string) => id === 'agent-1' ? current : undefined };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 74).toString('base64url')), discovery: discovery as never, tmux: recordingTmux().tmux as never });
    try {
      const headers = await authenticatedHeaders(app);
      const named = await app.inject({ method: 'GET', url: '/api/agents/agent-1/conversation', headers });
      expect(named.statusCode).toBe(200);
      expect(named.json()).toEqual({ name: 'Wire the adapter' });
      // an unnamed or undiscoverable Conversation answers with no name
      current = { id: claudeId };
      expect((await app.inject({ method: 'GET', url: '/api/agents/agent-1/conversation', headers })).json()).toEqual({});
      current = undefined;
      expect((await app.inject({ method: 'GET', url: '/api/agents/agent-1/conversation', headers })).json()).toEqual({});
      // an unknown agent is refused
      expect((await app.inject({ method: 'GET', url: '/api/agents/agent-9/conversation', headers })).statusCode).toBe(404);
      // an unauthenticated browser reads nothing
      expect((await app.inject({ method: 'GET', url: '/api/agents/agent-1/conversation', headers: { host: 'agents.example.com' } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  }, 15_000);
});
