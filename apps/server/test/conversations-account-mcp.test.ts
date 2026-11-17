import argon2 from 'argon2';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { stated } from './helpers/agent.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

const roots: string[] = [];

// restore caller-owned account selectors after each isolated integration
afterEach(async () => {
  vi.unstubAllEnvs();
  // remove every account-store fixture
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// write one named Codex conversation into an isolated account store
async function namedConversation(home: string, id: string, cwd: string): Promise<void> {
  const directory = join(home, 'sessions', '2026', '11', '17');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-2026-11-17T00-00-00-${id}.jsonl`), [
    { timestamp: '2026-11-17T08:00:00Z', type: 'session_meta', payload: { id, cwd, originator: 'codex-tui' } },
    { timestamp: '2026-11-17T09:00:00Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } },
  ].map(record => JSON.stringify(record)).join('\n'));
  await writeFile(join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Foreign account history' })}\n`);
}

describe('conversation account MCP boundary', () => {
  // credential ownership is irrelevant, but the current runtime must be able to read the history
  it.each(['foreign', 'shared'])('checks %s-store history before a current-credential MCP handoff', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'rac-conversation-account-mcp-'));
    roots.push(root);
    const foreignStore = join(root, 'foreign-store');
    const targetStore = mode === 'shared' ? foreignStore : join(root, 'target-store');
    const targetHome = join(root, 'target-home');
    const conversationId = '0198c333-3333-7333-8333-333333333333';
    const project = testProject({ id: 'potato', path: '/container/repository', hostPath: '/host/repository' });
    const worktree = testWorktree({ id: 'potato:/container/cora', projectId: project.id, path: '/container/cora', identity: '/container/cora', hostPath: '/host/cora' });
    const agent = stated({ id: 'agent-1', home: worktree.path, projectId: project.id, worktreeId: worktree.id, title: 'Ready' });
    const replacement = stated({ id: 'agent-2', home: worktree.path, projectId: project.id, worktreeId: worktree.id, title: 'Ready' });
    const currentAuth = `${JSON.stringify({ OPENAI_API_KEY: 'current-account-key' })}\n`;
    await namedConversation(foreignStore, conversationId, worktree.hostPath!);
    await mkdir(targetStore, { recursive: true });
    await writeFile(join(targetStore, 'auth.json'), currentAuth);
    vi.stubEnv('HOME', join(root, 'server-home'));
    vi.stubEnv('CODEX_HOME', foreignStore);
    vi.stubEnv('RAC_CLAUDE_CONFIG_DIR', join(root, 'unused-claude'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'unused-pi'));
    vi.stubEnv('RAC_INTEGRATION_AUTH_FILE', join(root, 'integration-auth.json'));
    vi.stubEnv('RAC_INTEGRATION_STATE_FILE', join(root, 'integration-state.json'));
    vi.stubEnv('RAC_INTEGRATION_AUDIT_FILE', join(root, 'integration-audit.jsonl'));
    const adapters = {
      codex: { program: '/bin/false', args: [], env: { CODEX_HOME: targetStore }, launchable: true },
      pi: { program: '/bin/false', args: [], env: { HOME: targetHome }, launchable: true, allowedModels: [{ model: 'test-model', efforts: ['medium'] }] },
    };
    const catalog = new DiscoveryService(undefined, undefined, undefined, undefined, adapters, [project], undefined, undefined, undefined, targetHome);
    const reads = vi.spyOn(catalog, 'conversations');
    const lifecycle: string[] = [];
    let resumed = false;
    // resolve one live target without scanning real panes or histories
    const discovery = {
      target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      // publish the replacement only after the current-account launch begins
      dashboard: async () => ({ generation: resumed ? 2 : 1, agents: [resumed ? replacement : agent], projects: [], places: [], adapters: {} }),
      worktreesNow: () => [worktree],
      projectsNow: () => [project],
      workspacePlaces: () => new Map(),
      conversations: catalog.conversations.bind(catalog),
      conversationId: async () => undefined,
      place: async () => undefined,
    };
    const structured = new Proxy({}, {
      // expose only the setup and authority seams required by the real MCP gateway
      get: (_target, property) => {
        // retain only the Conductor token as live authority
        if (property === 'tokenHolder') return async (token: string) => token === 'rac-conductor.test' ? { id: agent.id, role: 'conductor' } : undefined;
        // setup hooks are synchronous
        if (property === 'usePlaces' || property === 'useConductor' || property === 'onChange') return () => undefined;
        // no structured Agent owns this tmux target
        if (property === 'agent') return async () => undefined;
        // no process holder belongs to the target
        if (property === 'has') return async () => false;
        // the fixture owns no structured lifecycle
        if (property === 'agents') return async () => [];
        // the fixture owns no saved process
        if (property === 'saved') return async () => undefined;
        // any unexpected lifecycle action is observable
        return async () => { lifecycle.push(String(property)); return undefined; };
      }
    });
    // execute the real switch callback while recording its guarded lifecycle
    const externalActivity = vi.fn(async (_id: string, effect: () => unknown | Promise<unknown>) => await effect());
    const close = vi.fn(async (id: string) => { lifecycle.push(`close:${id}`); return true; });
    const handOver = vi.fn(async (from: string, to: string) => { lifecycle.push(`handover:${from}:${to}`); });
    const prompts = {
      withExternalActivity: externalActivity,
      mutationVersion: () => 0,
      mutationGeneration: () => 0,
      acquireRestartLock: async () => () => undefined,
      close,
      handOver,
      useDispatches: () => undefined,
    };
    // resume only the selected id through the already configured current account
    const resume = vi.fn(async (worktreeId: string, id: string, kind: string) => {
      lifecycle.push(`resume:${worktreeId}:${id}:${kind}`);
      resumed = worktreeId === worktree.id && id === conversationId && kind === 'codex';
      return resumed;
    });
    const launchOptions = {
      prepare: async () => ({ kind: 'codex', nativeDefault: true, security: {}, optionsRevision: 'test' }),
      revalidate: async () => undefined,
      invalidate: () => undefined,
    };
    const queuedPrompts = { list: async () => [], resets: { get: async () => undefined } };
    const currentDashboard = () => ({ generation: resumed ? 2 : 1, agents: [resumed ? replacement : agent], projects: [], places: [], adapters: {} });
    const config = testConfig({
      adapters,
      launchHome: targetHome,
      projects: [project],
      conductor: { kind: 'pi', projectId: project.id, model: 'test-model', scopes: ['status:read', 'logs:read', 'agents:control'], spawnKinds: ['codex'], maxWorkers: 1, maxSelfStartedTurnsPerHour: 10, scriptDeadlineMinutes: 10 },
    });
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const app = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 66).toString('base64url')),
      discovery: discovery as never,
      structuredAgents: structured as never,
      launch: { agentHome: () => targetHome, canResumeConversation: () => true, resumeConversation: resume } as never,
      launchOptions: launchOptions as never,
      launchPollDelay: async () => undefined,
      prompts: prompts as never,
      queuedPrompts: queuedPrompts as never,
      dashboardUpdates: { setLoader: () => undefined, refresh: async () => currentDashboard(), close: () => undefined } as never,
      reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never,
    });
    try {
      // exercise the real protocol and authorization boundary
      const call = async (name: string, args: object, id: number) => {
        const response = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { host: 'agents.example.com', authorization: 'Bearer rac-conductor.test', 'mcp-protocol-version': '2025-06-18' },
          payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
        });
        const body = response.json();
        // surface protocol admission failures as focused test evidence
        expect(body.result?.structuredContent).toBeDefined();
        return body.result.structuredContent;
      };

      const listed = await call('list_conversations', { agent_id: agent.id }, 1);
      expect(listed).toMatchObject({ ok: true, data: { items: [{ id: conversationId }] } });
      const switched = await call('switch_conversation', { agent_id: agent.id, conversation_id: conversationId, request_id: 'request-account-switch-1' }, 2);
      // a different credential slot is allowed when its history shares the current store
      if (mode === 'shared') {
        expect(switched).toMatchObject({ ok: true, data: { conversation_id: conversationId, active: true, queue_preserved: true } });
        expect(externalActivity).toHaveBeenCalled();
        expect(resume).toHaveBeenCalledWith(worktree.id, conversationId, 'codex', expect.objectContaining({ kind: 'codex' }), undefined);
        expect(lifecycle).toEqual([`close:${agent.id}`, `resume:${worktree.id}:${conversationId}:codex`, `handover:${agent.id}:${replacement.id}`]);
      } else {
        expect(switched).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
        expect(externalActivity).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
        expect(lifecycle).toEqual([]);
      }
      expect(reads).toHaveBeenCalledWith([worktree.hostPath]);
      expect(await readFile(join(targetStore, 'auth.json'), 'utf8')).toBe(currentAuth);
    } finally {
      await app.close();
    }
  }, 15_000);
});
