import argon2 from 'argon2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { buildApp } from '../src/app.js';
import { ConsoleNamedConversationService } from '../src/conversations/console-named-service.js';
import { stated } from './helpers/agent.js';
import { testConfig, testWorktree } from './helpers/config.js';

const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };

// authenticate one test browser
async function authenticatedHeaders(app: Awaited<ReturnType<typeof buildApp>>) {
  const boot = await app.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
  return { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('conversations listing API', () => {
  it('marks a row console-named as the intersection with the record store (codex-family by id)', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const claudeId = '11111111-2222-4333-8444-555555555555';
    const codexId = '0198c555-5555-7555-8555-555555555555';
    const unnamed = '22222222-3333-4333-8444-555555555555';
    const discovery = {
      target: async () => undefined,
      conversationId: async () => undefined,
      worktreesNow: () => [cora],
      conversations: async () => [
        { kind: 'claude', id: claudeId, name: 'named here', automatic: false, lastActiveAt: 300, directory: '/host/cora' },
        { kind: 'codex', id: codexId, name: 'codex named here', lastActiveAt: 200, directory: '/host/cora' },
        { kind: 'claude', id: unnamed, name: 'not named here', automatic: false, lastActiveAt: 100, directory: '/host/cora' },
      ],
    };
    const launch = { canResumeConversation: () => true };
    const directory = await mkdtemp(join(tmpdir(), 'rac-conv-intersection-')); dirs.push(directory);
    const consoleNamed = new ConsoleNamedConversationService({ file: join(directory, 'records.json') });
    await consoleNamed.record('potato', { kind: 'claude', id: claudeId });
    // recorded under OMX; the codex-tagged row still intersects by id across the pair
    await consoleNamed.record('potato', { kind: 'omx', id: codexId });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 45).toString('base64url')), discovery: discovery as never, launch: launch as never, consoleNamed });
    try {
      const headers = await authenticatedHeaders(app);
      const listed = await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations`, headers: { host: headers.host, cookie: headers.cookie } });
      const rows = listed.json().conversations as Array<{ id: string; consoleNamed: boolean }>;
      expect(rows.find(row => row.id === claudeId)?.consoleNamed).toBe(true);
      expect(rows.find(row => row.id === codexId)?.consoleNamed).toBe(true);
      expect(rows.find(row => row.id === unnamed)?.consoleNamed).toBe(false);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('marks the conversations Tour and Review runs named as review runs', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const discovery = {
      target: async () => undefined,
      conversationId: async () => undefined,
      worktreesNow: () => [cora],
      conversations: async () => [
        { kind: 'claude', id: '11111111-2222-4333-8444-555555555555', name: '🗺 Tour · cora', automatic: false, lastActiveAt: 300, directory: '/host/cora' },
        { kind: 'codex', id: '0198c555-5555-7555-8555-555555555555', name: '🔍 Review · Security', lastActiveAt: 200, directory: '/host/cora' },
        { kind: 'claude', id: '22222222-3333-4333-8444-555555555555', name: 'Tour of the parser', automatic: false, lastActiveAt: 100, directory: '/host/cora' },
      ],
    };
    const directory = await mkdtemp(join(tmpdir(), 'rac-conv-review-run-')); dirs.push(directory);
    const consoleNamed = new ConsoleNamedConversationService({ file: join(directory, 'records.json') });
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 46).toString('base64url')), discovery: discovery as never, launch: { canResumeConversation: () => true } as never, consoleNamed });
    try {
      const headers = await authenticatedHeaders(app);
      const listed = await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations`, headers: { host: headers.host, cookie: headers.cookie } });
      expect((listed.json().conversations as Array<{ reviewRun: boolean }>).map(row => row.reviewRun)).toEqual([true, true, false]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('lists a Project-wide union across its worktrees, resolving worktreeId, current and ordering', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // two Linked worktrees of one Project; the host-visible checkout root is what the Adapters scan
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const owen = testWorktree({ id: 'potato:/wt/owen', projectId: 'potato', label: 'Owen', path: '/wt/owen', identity: '/wt/owen', hostPath: '/host/owen', main: false });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/host/cora', projectId: 'potato', worktreeId: cora.id, title: 'Ready' });
    const scanned: string[][] = [];
    const discovery = {
      target: async (id: string) => id === agent.id ? { agent, socket } : undefined,
      // the pane's current Conversation is the Cora row `alpha`
      conversationId: async () => 'aaaaaaaa-2222-4333-8444-555555555555',
      worktreesNow: () => [cora, owen],
      // canned union across kinds; one row sits in a directory that is no longer a Worktree
      conversations: async (directories: readonly string[]) => {
        scanned.push([...directories]);
        return [
          { kind: 'claude', id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'alpha', automatic: false, lastActiveAt: 200, directory: '/host/cora' },
          { kind: 'claude', id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'beta', automatic: true, lastActiveAt: 300, directory: '/host/owen' },
          { kind: 'claude', id: 'cccccccc-2222-4333-8444-555555555555', name: 'gamma', automatic: false, lastActiveAt: 100, directory: '/gone/away' },
        ];
      },
    };
    const launch = { canResumeConversation: () => true };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 41).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const headers = await authenticatedHeaders(app);
      const listed = await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations?agentId=agent-1`, headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({
        canResume: true,
        conversations: [
          // newest-active first across kinds and worktrees
          { kind: 'claude', id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'beta', automatic: true, lastActiveAt: 300, directory: '/host/owen', worktreeId: owen.id, consoleNamed: false, reviewRun: false, current: false },
          { kind: 'claude', id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'alpha', automatic: false, lastActiveAt: 200, directory: '/host/cora', worktreeId: cora.id, consoleNamed: false, reviewRun: false, current: true },
          // a directory that is no longer a Worktree carries no worktreeId
          { kind: 'claude', id: 'cccccccc-2222-4333-8444-555555555555', name: 'gamma', automatic: false, lastActiveAt: 100, directory: '/gone/away', consoleNamed: false, reviewRun: false, current: false },
        ],
      });
      // the union of the Project's current Worktree host roots was the scan input
      expect(scanned).toEqual([['/host/cora', '/host/owen']]);

      // listing a sibling Worktree with an agent that lives on cora marks nothing current
      const otherView = await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(owen.id)}/conversations?agentId=agent-1`, headers: { host: headers.host, cookie: headers.cookie } });
      expect(otherView.json().conversations.every((row: { current: boolean }) => row.current === false)).toBe(true);

      // a malformed agent context is rejected
      const badAgent = await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations?agentId=`, headers: { host: headers.host, cookie: headers.cookie } });
      expect(badAgent.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('attributes each shared Codex row to the Worktree\'s remembered kind: OMX when it last launched OMX, else Codex', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const cora = testWorktree({ id: 'potato:/wt/cora', projectId: 'potato', label: 'Cora', path: '/wt/cora', identity: '/wt/cora', hostPath: '/host/cora' });
    const owen = testWorktree({ id: 'potato:/wt/owen', projectId: 'potato', label: 'Owen', path: '/wt/owen', identity: '/wt/owen', hostPath: '/host/owen', main: false });
    const discovery = {
      target: async () => undefined,
      conversationId: async () => undefined,
      worktreesNow: () => [cora, owen],
      // the shared Codex reader emits one codex-tagged row per rollout (never one per sharing kind)
      conversations: async () => [
        { kind: 'claude', id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'alpha', automatic: false, lastActiveAt: 100, directory: '/host/cora' },
        { kind: 'codex', id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'codex on owen', lastActiveAt: 300, directory: '/host/owen' },
        { kind: 'codex', id: 'cccccccc-2222-4333-8444-555555555555', name: 'codex on cora', lastActiveAt: 200, directory: '/host/cora' },
      ],
    };
    const launch = { canResumeConversation: () => true };
    // Owen last launched OMX; Cora last launched Claude (not a codex-family kind → stays Codex)
    const worktreeStore = { launchProfiles: async () => ({ 'potato:/wt/owen': 'omx', 'potato:/wt/cora': 'claude' }) };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 44).toString('base64url')), discovery: discovery as never, launch: launch as never, worktreeStore: worktreeStore as never });
    try {
      const headers = await authenticatedHeaders(app);
      const listed = await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(cora.id)}/conversations`, headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({
        canResume: true,
        conversations: [
          // Owen's rollout is badged OMX because Owen last launched OMX; ordered first (newest active)
          { kind: 'omx', id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'codex on owen', lastActiveAt: 300, directory: '/host/owen', worktreeId: owen.id, consoleNamed: false, reviewRun: false, current: false },
          // Cora last launched Claude, so its Codex rollout stays Codex rather than following the launch kind
          { kind: 'codex', id: 'cccccccc-2222-4333-8444-555555555555', name: 'codex on cora', lastActiveAt: 200, directory: '/host/cora', worktreeId: cora.id, consoleNamed: false, reviewRun: false, current: false },
          { kind: 'claude', id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'alpha', automatic: false, lastActiveAt: 100, directory: '/host/cora', worktreeId: cora.id, consoleNamed: false, reviewRun: false, current: false },
        ],
      });
    } finally {
      await app.close();
    }
  }, 15_000);

  it('keys a Scratch agent to its one directory, with no worktreeId and no resume', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'scratch-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', home: '/home/me', title: 'Scratch' });
    const scanned: string[][] = [];
    const discovery = {
      target: async (id: string) => id === agent.id ? { agent, socket } : undefined,
      conversationId: async () => 'dddddddd-2222-4333-8444-555555555555',
      // no worktree matches the scratch home
      worktreesNow: () => [],
      conversations: async (directories: readonly string[]) => {
        scanned.push([...directories]);
        return [{ kind: 'claude', id: 'dddddddd-2222-4333-8444-555555555555', name: 'scratch chat', automatic: false, lastActiveAt: 50, directory: '/home/me' }];
      },
    };
    const launch = { canResumeConversation: () => true };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 42).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const headers = await authenticatedHeaders(app);
      const listed = await app.inject({ method: 'GET', url: '/api/agents/scratch-1/conversations', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({
        // Scratch has no Worktree to resume into
        canResume: false,
        conversations: [{ kind: 'claude', id: 'dddddddd-2222-4333-8444-555555555555', name: 'scratch chat', automatic: false, lastActiveAt: 50, directory: '/home/me', consoleNamed: false, reviewRun: false, current: true }],
      });
      expect(scanned).toEqual([['/home/me']]);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('404s an unknown worktree or agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const discovery = { target: async () => undefined, worktreesNow: () => [], place: async () => undefined, conversations: async () => [] };
    const app = await buildApp(testConfig(), { auth: new AuthService(hash, Buffer.alloc(32, 43).toString('base64url')), discovery: discovery as never });
    try {
      const headers = await authenticatedHeaders(app);
      const worktree = await app.inject({ method: 'GET', url: '/api/worktrees/nope/conversations', headers: { host: headers.host, cookie: headers.cookie } });
      const agent = await app.inject({ method: 'GET', url: '/api/agents/nope/conversations', headers: { host: headers.host, cookie: headers.cookie } });
      expect(worktree.statusCode).toBe(404);
      expect(agent.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 15_000);
});
