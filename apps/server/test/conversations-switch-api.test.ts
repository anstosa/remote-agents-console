import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../src/auth/service.js';
import { buildApp } from '../src/app.js';
import { stated } from './helpers/agent.js';
import { testConfig, testWorktree } from './helpers/config.js';
import type { AgentKind } from '../src/adapters/types.js';

const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const conversationId = '0198c333-3333-7333-8333-333333333333';

type Row = { kind: AgentKind; id: string; name: string; lastActiveAt: number; directory: string; automatic?: boolean };

// authenticate one test browser
async function authenticatedHeaders(app: Awaited<ReturnType<typeof buildApp>>) {
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
}

// list each row only under its home directory, exactly as an Adapter's exact-directory match does
const conversationsIn = (rows: Row[]) => async (directories: readonly string[]) => rows.filter(row => directories.includes(row.directory));

describe('conversations switch API', () => {
  it('launches an inactive Worktree into a listed Conversation in its home Worktree', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const replacement = stated({ id: 'agent-2', pane: { paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket' }, home: '/host/cora', projectId: 'potato', worktreeId: cora.id, title: 'Ready' });
    let launched = false;
    const discovery = {
      target: async () => undefined,
      worktreesNow: () => [cora],
      conversations: conversationsIn([{ kind: 'claude', id: conversationId, name: 'alpha', lastActiveAt: 100, directory: '/host/cora' }]),
      dashboard: async () => ({ generation: launched ? 2 : 1, places: [], adapters: {}, agents: launched ? [replacement] : [], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, id: string, kind?: AgentKind) => { launched = worktreeId === cora.id && id === conversationId && kind === 'claude'; return launched; } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 51).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(201);
      expect(switched.json()).toEqual({ agentId: replacement.id });
      expect(launched).toBe(true);
    } finally {
      await app.close();
    }
  }, 15_000);

  // direct requests must not bypass ambiguous listing ownership
  it.each(['duplicate', 'symlink'])('refuses %s host roots before scanning or launching either configured Worktree', async mode => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const root = await mkdtemp(join(tmpdir(), 'rac-switch-root-'));
    const shared = mode === 'symlink' ? root : '/host/shared';
    const alias = mode === 'symlink' ? join(root, 'alias') : shared;
    // exercise real filesystem aliases before any lifecycle side effects
    if (mode === 'symlink') await symlink(shared, alias, 'dir');
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', path: '/wt/cora', identity: '/wt/cora', hostPath: shared });
    const owen = testWorktree({ id: 'tomato:/wt/owen', projectId: 'tomato', path: '/wt/owen', identity: '/wt/owen', hostPath: alias });
    const events: string[] = [];
    const discovery = {
      // expose overlapping configured host roots
      worktreesNow: () => [cora, owen],
      // detect any attempt to trust the shared store as ownership proof
      conversations: async () => { events.push('scan'); return [{ kind: 'claude', id: conversationId, name: 'shared chat', lastActiveAt: 100, directory: shared }]; },
      // detect progress toward a destructive handoff
      dashboard: async () => { events.push('dashboard'); return { generation: 1, places: [], adapters: {}, agents: [], projects: [] }; },
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async () => { events.push('resume'); return false; } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 60).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const headers = await authenticatedHeaders(app);
      // neither owner may claim the ambiguous conversation
      for (const worktree of [cora, owen]) {
        const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
        expect(switched.statusCode).toBe(409);
      }
      expect(events).toEqual([]);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('closes one idle agent before resuming the Conversation in its home Worktree', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const firstAgent = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/host/cora', projectId: 'potato', worktreeId: cora.id, title: 'Ready' });
    const replacement = { ...firstAgent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2' };
    const events: string[] = [];
    let resumed = false;
    const discovery = {
      target: async (id: string) => id === firstAgent.id ? { agent: firstAgent, socket } : undefined,
      worktreesNow: () => [cora],
      conversations: conversationsIn([{ kind: 'claude', id: conversationId, name: 'alpha', lastActiveAt: 100, directory: '/host/cora' }]),
      dashboard: async () => ({ generation: resumed ? 2 : 1, places: [], adapters: {}, agents: [resumed ? replacement : firstAgent], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, id: string, kind?: AgentKind) => { events.push(`resume:${worktreeId}:${id}:${kind}`); resumed = true; return true; } };
    // expose an empty queue and no pending reset
    const queuedPrompts = { list: async () => [], resets: { get: async () => undefined } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 52).toString('base64url')), discovery: discovery as never, launch: launch as never, queuedPrompts: queuedPrompts as never, tmux: { close: async () => { events.push(`close:${firstAgent.id}`); return true; } } as never, launchPollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(201);
      expect(switched.json()).toEqual({ agentId: replacement.id });
      expect(events).toEqual([`close:${firstAgent.id}`, `resume:${cora.id}:${conversationId}:claude`]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('does not count a Review run\'s Agent as a duplicate worktree agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const firstAgent = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/host/cora', projectId: 'potato', worktreeId: cora.id, title: 'Ready' });
    const reviewer = { ...firstAgent, id: 'agent-r', paneId: '%9', reviewRun: 'run_abcdefgh1234' };
    const replacement = { ...firstAgent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2' };
    const events: string[] = [];
    let resumed = false;
    const discovery = {
      target: async (id: string) => id === firstAgent.id ? { agent: firstAgent, socket } : undefined,
      worktreesNow: () => [cora],
      conversations: conversationsIn([{ kind: 'claude', id: conversationId, name: 'alpha', lastActiveAt: 100, directory: '/host/cora' }]),
      dashboard: async () => ({ generation: resumed ? 2 : 1, places: [], adapters: {}, agents: [reviewer, resumed ? replacement : firstAgent], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, id: string, kind?: AgentKind) => { events.push(`resume:${worktreeId}:${id}:${kind}`); resumed = true; return true; } };
    const queuedPrompts = { list: async () => [], resets: { get: async () => undefined } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 54).toString('base64url')), discovery: discovery as never, launch: launch as never, queuedPrompts: queuedPrompts as never, tmux: { close: async () => { events.push(`close:${firstAgent.id}`); return true; } } as never, launchPollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(201);
      expect(switched.json()).toEqual({ agentId: replacement.id });
      expect(events).toEqual([`close:${firstAgent.id}`, `resume:${cora.id}:${conversationId}:claude`]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('refuses when more than one agent is open on the Worktree', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const first = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/host/cora', projectId: 'potato', worktreeId: cora.id, title: 'Ready' });
    const second = { ...first, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2' };
    let resumed = false;
    const discovery = {
      target: async () => undefined,
      worktreesNow: () => [cora],
      conversations: conversationsIn([{ kind: 'claude', id: conversationId, name: 'alpha', lastActiveAt: 100, directory: '/host/cora' }]),
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [first, second], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async () => { resumed = true; return true; } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 53).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'Close duplicate worktree agents before switching chats.' });
      expect(resumed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('refuses when the Worktree agent is working', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    // a spinner title resolves to a working attention state
    const working = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/host/cora', projectId: 'potato', worktreeId: cora.id, title: '⠋ Working' });
    let resumed = false;
    const discovery = {
      target: async (id: string) => id === working.id ? { agent: working, socket } : undefined,
      worktreesNow: () => [cora],
      conversations: conversationsIn([{ kind: 'claude', id: conversationId, name: 'alpha', lastActiveAt: 100, directory: '/host/cora' }]),
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [working], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async () => { resumed = true; return true; } };
    // expose an empty queue and no pending reset
    const queuedPrompts = { list: async () => [], resets: { get: async () => undefined } };
    // the immediate poll delay makes a regressed working-gate fail fast (close+resume+poll)
    // rather than hang, and lets this assert the specific not-idle reason
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 54).toString('base64url')), discovery: discovery as never, launch: launch as never, queuedPrompts: queuedPrompts as never, tmux: { close: async () => true } as never, launchPollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'Only idle configured agents can restart.' });
      expect(resumed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('refuses a Conversation whose home is not this Worktree', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const owen = testWorktree({ id: 'potato:/wt/owen', projectId: 'potato', label: 'Owen', path: '/wt/owen', identity: '/wt/owen', hostPath: '/host/owen', main: false });
    let resumed = false;
    const discovery = {
      target: async () => undefined,
      worktreesNow: () => [cora, owen],
      // the Conversation lives under owen; a scan of cora's directory returns nothing
      conversations: conversationsIn([{ kind: 'claude', id: conversationId, name: 'alpha', lastActiveAt: 100, directory: '/host/owen' }]),
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async () => { resumed = true; return true; } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 55).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const headers = await authenticatedHeaders(app);
      // asking cora to resume owen's Conversation is refused before any handoff
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'This conversation does not belong to this worktree.' });
      expect(resumed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('refuses when the home Worktree lists a different Conversation than the requested id', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    let resumed = false;
    const otherId = '0198c333-4444-7444-8444-444444444444';
    const discovery = {
      target: async () => undefined,
      worktreesNow: () => [cora],
      // the directory holds a Conversation, but not the requested id — the row must match by id
      conversations: conversationsIn([{ kind: 'claude', id: otherId, name: 'someone else', lastActiveAt: 100, directory: '/host/cora' }]),
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async () => { resumed = true; return true; } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 59).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'This conversation does not belong to this worktree.' });
      expect(resumed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('rejects an id its Adapter will not resume, before any handoff', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    let scanned = false;
    let resumed = false;
    const discovery = {
      target: async () => undefined,
      worktreesNow: () => [cora],
      conversations: async () => { scanned = true; return []; },
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async () => { resumed = true; return true; } };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 56).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: 'not-a-session' } });
      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'This conversation cannot be resumed.' });
      // the validId gate fails closed before the home-Worktree scan or any resume
      expect(scanned).toBe(false);
      expect(resumed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('refuses when the resolved kind is not launchable, before closing the live agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const idle = stated({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/host/cora', projectId: 'potato', worktreeId: cora.id, title: 'Ready' });
    let closed = false;
    let resumed = false;
    const discovery = {
      target: async (id: string) => id === idle.id ? { agent: idle, socket } : undefined,
      worktreesNow: () => [cora],
      conversations: conversationsIn([{ kind: 'claude', id: conversationId, name: 'alpha', lastActiveAt: 100, directory: '/host/cora' }]),
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [idle], projects: [] }),
    };
    // some kind is launchable (canResumeConversation true), but the row's own kind is not
    const launch = { canResumeConversation: () => true, isLaunchableKind: (kind: AgentKind) => kind !== 'claude', resumeConversation: async () => { resumed = true; return true; } };
    // expose no pending queue or reset during the handoff
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 60).toString('base64url')), discovery: discovery as never, launch: launch as never, queuedPrompts: { list: async () => [], resets: { get: async () => undefined } } as never, tmux: { close: async () => { closed = true; return true; } } as never });
    try {
      const headers = await authenticatedHeaders(app);
      const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude', id: conversationId } });
      expect(switched.statusCode).toBe(409);
      expect(switched.json()).toEqual({ error: 'This conversation cannot be resumed.' });
      // the idle agent is never closed for an unlaunchable kind
      expect(closed).toBe(false);
      expect(resumed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('resolves a codex-family row to the Worktree\'s remembered kind, overriding a stale client kind', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const owen = testWorktree({ id: 'potato:/wt/owen', projectId: 'potato', label: 'Owen', path: '/wt/owen', identity: '/wt/owen', hostPath: '/host/owen' });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora', main: false });
    const resumes: Array<{ worktreeId: string; kind?: AgentKind }> = [];
    let launchedOn: string | undefined;
    const replacement = (worktreeId: string) => stated({ id: `agent-${worktreeId}`, pane: { paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket' }, home: worktreeId === owen.id ? '/host/owen' : '/host/cora', projectId: 'potato', worktreeId, title: 'Ready' });
    const discovery = {
      target: async () => undefined,
      worktreesNow: () => [owen, cora],
      // the shared Codex reader emits one codex-tagged row per rollout, each under its home directory
      conversations: conversationsIn([
        { kind: 'codex', id: conversationId, name: 'owen chat', lastActiveAt: 300, directory: '/host/owen' },
        { kind: 'codex', id: conversationId, name: 'cora chat', lastActiveAt: 200, directory: '/host/cora' },
      ]),
      dashboard: async () => ({ generation: launchedOn === undefined ? 1 : 2, places: [], adapters: {}, agents: launchedOn === undefined ? [] : [replacement(launchedOn)], projects: [] }),
    };
    const launch = { canResumeConversation: () => true, resumeConversation: async (worktreeId: string, _id: string, kind?: AgentKind) => { resumes.push({ worktreeId, kind }); launchedOn = worktreeId; return true; } };
    // Owen last launched OMX; Cora last launched Claude (not codex-family → stays Codex)
    const worktreeStore = { launchProfiles: async () => ({ [owen.id]: 'omx', [cora.id]: 'claude' }) };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 57).toString('base64url')), discovery: discovery as never, launch: launch as never, worktreeStore: worktreeStore as never, launchPollDelay: async () => undefined });
    try {
      const headers = await authenticatedHeaders(app);
      // the client sends a stale `codex` kind, but Owen last launched OMX, so the server
      // re-resolves the shared rollout to OMX rather than trusting the payload
      const toOwen = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(owen.id)}/conversations/switch`, headers, payload: { kind: 'codex', id: conversationId } });
      expect(toOwen.statusCode).toBe(201);
      launchedOn = undefined;
      // the client sends `omx`, but Cora last launched a non-codex kind, so it resumes under Codex
      const toCora = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'omx', id: conversationId } });
      expect(toCora.statusCode).toBe(201);
      expect(resumes).toEqual([{ worktreeId: owen.id, kind: 'omx' }, { worktreeId: cora.id, kind: 'codex' }]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('404s an unknown Worktree and 400s a malformed switch target', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const discovery = { target: async () => undefined, worktreesNow: () => [cora], place: async () => undefined, conversations: async () => [], dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] }) };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 58).toString('base64url')), discovery: discovery as never });
    try {
      const headers = await authenticatedHeaders(app);
      const unknown = await app.inject({ method: 'POST', url: '/api/worktrees/nope/conversations/switch', headers, payload: { kind: 'claude', id: conversationId } });
      const noKind = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { id: conversationId } });
      const badKind = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'nope', id: conversationId } });
      const noId = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations/switch`, headers, payload: { kind: 'claude' } });
      expect(unknown.statusCode).toBe(404);
      expect(noKind.statusCode).toBe(400);
      expect(badKind.statusCode).toBe(400);
      expect(noId.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 15_000);
});
