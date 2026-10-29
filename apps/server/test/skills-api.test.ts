// `/api/agents/:id/commands` endpoint tests. (Named `skills-api.test.ts` for
// continuity — the deletion hook blocks a rename; the endpoint replaced the old
// `/skills` route.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig, testWorktree } from './helpers/config.js';

const config = testConfig({ publicOrigin: new URL('https://agents.example.com') });
// a discovered Worktree whose console path differs from the host path an Agent reports
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

  it('reports 404 for an unknown agent', async () => {
    app = await buildApp(config, {
      auth: { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }) } as never,
      control: { connect: () => true } as never,
      discovery: { target: async () => undefined, worktreesNow: () => [ferry] } as never
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/missing/commands', headers: { host: 'agents.example.com' } });

    expect(response.statusCode).toBe(404);
  });
});
