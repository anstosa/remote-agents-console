// `/api/agents/:id/commands` endpoint tests. (Named `skills-api.test.ts` for
// continuity — the deletion hook blocks a rename; the endpoint replaced the old
// `/skills` route.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { StructuredAgents } from '../src/transports/structured-agents.js';
import { testConfig, testWorktree } from './helpers/config.js';

const config = testConfig({ publicOrigin: new URL('https://agents.example.com') });
// a discovered Worktree whose console path differs from the host path an Agent reports
// structured Agents kept in a file that does not exist, so none are listed
const noStructuredAgents = () => new StructuredAgents({} as never, { file: '/nonexistent/structured-agents.json' });
const ferry = testWorktree({ id: 'ferry-fyi', projectId: 'ferry', label: 'Ferry FYI', path: '/worktrees/ferry.fyi', hostPath: '/home/ubuntu/ferry.fyi', pinned: true });

describe('agent command catalog API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => { vi.unstubAllEnvs(); await app?.close(); });

  it('serves the catalog for the agent kind using service-visible runtime paths', async () => {
    vi.stubEnv('HOME', '/service-home');
    vi.stubEnv('CODEX_HOME', '/service-codex');
    const seen: Array<{ kind: string; workspace: string; stateDirectory: string }> = [];
    const agent = { id: 'agent-1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/home/ubuntu/ferry.fyi', title: 'Ready', kind: 'codex' };
    app = await buildApp(config, {
      auth: { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }) } as never,
      control: { connect: () => true } as never,
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined, worktreesNow: () => [ferry] } as never,
      launch: { agentHome: () => '/home/ubuntu' } as never,
      commandCatalog: { catalog: async (adapter: { kind: string }, workspace: string, stateDirectory: string) => { seen.push({ kind: adapter.kind, workspace, stateDirectory }); return [{ value: '$push', description: 'Review and push.' }, { value: '/help', description: 'Show available commands' }]; } } as never
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/agent-1/commands', headers: { host: 'agents.example.com' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commands: [{ value: '$push', description: 'Review and push.' }, { value: '/help', description: 'Show available commands' }] });
    expect(seen).toEqual([{ kind: 'codex', workspace: '/worktrees/ferry.fyi', stateDirectory: '/service-codex' }]);
  });

  it('serves the catalog for a structured agent, which discovery does not list', async () => {
    const seen: Array<{ kind: string; workspace: string }> = [];
    const agent = { id: 'structured-1', home: '/home/ubuntu/ferry.fyi', title: 'Ready', kind: 'claude', transport: 'structured' } as const;
    const structuredAgents = noStructuredAgents();
    vi.spyOn(structuredAgents, 'agent').mockImplementation(async id => id === agent.id ? agent : undefined);
    app = await buildApp(config, {
      auth: { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }) } as never,
      control: { connect: () => true } as never,
      discovery: { target: async () => undefined, worktreesNow: () => [ferry] } as never,
      structuredAgents,
      commandCatalog: { catalog: async (adapter: { kind: string }, workspace: string) => { seen.push({ kind: adapter.kind, workspace }); return [{ value: '/brainstorming', description: 'Explore a design.' }]; } } as never
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/structured-1/commands', headers: { host: 'agents.example.com' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commands: [{ value: '/brainstorming', description: 'Explore a design.' }] });
    expect(seen).toEqual([{ kind: 'claude', workspace: '/worktrees/ferry.fyi' }]);
  });

  it('reports 404 for an unknown agent', async () => {
    app = await buildApp(config, {
      auth: { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }) } as never,
      control: { connect: () => true } as never,
      discovery: { target: async () => undefined, worktreesNow: () => [ferry] } as never,
      structuredAgents: noStructuredAgents()
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/missing/commands', headers: { host: 'agents.example.com' } });

    expect(response.statusCode).toBe(404);
  });
});
