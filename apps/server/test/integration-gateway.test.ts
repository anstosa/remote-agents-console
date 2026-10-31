import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntegrationAuditService } from '../src/integrations/audit/service.js';
import type { AuditEvent } from '../src/integrations/audit/service.js';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { IntegrationGateway } from '../src/integrations/mcp/gateway.js';
import { conductorCallable } from '../src/integrations/mcp/catalog.js';
import { IntegrationPolicyService } from '../src/integrations/policy/service.js';
import { IntegrationControlService } from '../src/integrations/control/index.js';

const principal: IntegrationPrincipal = { authentication: 'oauth', subjectId: 'user', clientId: 'chatgpt', audience: 'https://agents.example.com/mcp', scopes: ['status:read', 'prompts:write'] };
const config = { enabled: true, mcp: { readEnabled: true, writeEnabled: true, dangerousEnabled: false }, realtime: { enabled: true, name: 'Davo', context: '', writeToolsEnabled: true }, multiInstance: { enabled: true } };

// create one private policy-backed gateway fixture
async function fixture(audit?: { record: (event: AuditEvent) => Promise<void> }, gates: Partial<typeof config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rac-gateway-'));
  let queued = 0;
  const stackActions: unknown[] = [];
  const scopes: unknown[] = [];
  const githubCalls: unknown[] = [];
  const orchestration = {
    githubOverview: async (input: unknown) => { githubCalls.push(['overview', input]); return { ok: true as const, version: 'v1' as const, value: {} }; },
    githubPullRequest: async (input: unknown) => { githubCalls.push(['pull', input]); return { ok: true as const, version: 'v1' as const, value: {} }; },
    scoped: (admits: unknown) => { scopes.push(admits); return orchestration; },
    hasAgent: async () => true,
    listWorktrees: async () => ({ ok: true as const, version: 'v1' as const, value: [] }),
    listInstances: async () => ({ ok: true as const, version: 'v1' as const, value: [{ id: 'https://agents.example.com', name: 'Local', url: 'https://agents.example.com', local: true }] }),
    queuePrompt: async () => { queued += 1; return { ok: true as const, version: 'v1' as const, value: { accepted: true as const } }; },
    deactivate: async () => ({ ok: true as const, version: 'v1' as const, value: { deactivated: true as const } }),
    runStackAction: async (input: unknown) => { stackActions.push(input); return { ok: true as const, version: 'v1' as const, value: { started: true as const } }; }
  };
  const forwarded: Array<{ instanceId: string; name: string; voiceAuthorized: boolean }> = [];
  const policy = new IntegrationPolicyService(join(root, 'policy.json'));
  const control = new IntegrationControlService(() => 'browser-session');
  control.startVoice('browser-session', 'voice-session-123456789');
  const gateway = new IntegrationGateway({
    config: { ...config, ...gates },
    instanceId: 'https://agents.example.com',
    orchestration: orchestration as never,
    policy,
    audit: audit ?? new IntegrationAuditService(join(root, 'audit.jsonl')),
    control,
    forward: async (instanceId, _principal, name, _args, voiceAuthorized) => { forwarded.push({ instanceId, name, voiceAuthorized }); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, remote: true } }; }
  });
  return { root, gateway, control, queued: () => queued, forwarded, stackActions, scopes, githubCalls };
}

describe('IntegrationGateway', () => {
  // GitHub reads are the Conductor's alone, and only with the scope the operator names
  it('offers the GitHub reads only to a Conductor holding github:read, scoped to its Places', async () => {
    const { root, gateway, githubCalls, scopes } = await fixture();
    try {
      const github = ['get_github_overview', 'get_github_pull_request'];
      const listed = (who: IntegrationPrincipal) => gateway.listTools(who).map(tool => tool.name).filter(name => github.includes(name));
      const conductor: IntegrationPrincipal = { authentication: 'conductor', subjectId: 'conductor-1', clientId: 'conductor', audience: principal.audience, scopes: ['status:read', 'logs:read'], places: () => true };
      expect(listed(conductor)).toEqual([]);
      await expect(gateway.call(conductor, 'get_github_overview', {})).resolves.toMatchObject({ structuredContent: { error: { code: 'insufficient_scope' } } });
      // never to the operator's own integrations, whatever their scopes
      const oauth = { ...principal, scopes: [...principal.scopes, 'github:read' as const] };
      expect(listed(oauth)).toEqual([]);
      await expect(gateway.call(oauth, 'get_github_overview', {})).resolves.toMatchObject({ structuredContent: { error: { code: 'tool_disabled' } } });

      const reader = { ...conductor, scopes: [...conductor.scopes, 'github:read' as const] };
      expect(gateway.listTools(reader).filter(tool => github.includes(tool.name)).map(tool => [tool.name, tool.annotations.readOnlyHint])).toEqual([['get_github_overview', true], ['get_github_pull_request', true]]);
      await expect(gateway.call(reader, 'get_github_overview', { lists: ['reviews'], waiting_only: true, limit: 5, refresh: 'cached' })).resolves.toMatchObject({ structuredContent: { ok: true } });
      await expect(gateway.call(reader, 'get_github_pull_request', { repository: 'octo/repo', number: 7, sections: ['discussion'], threads: 'all', include_outdated: true, max_body_chars: 300, max_entries: 4, max_thread_comments: 2, cursor: 'abc', refresh: 'now' })).resolves.toMatchObject({ structuredContent: { ok: true } });
      expect(githubCalls).toEqual([
        ['overview', { lists: ['reviews'], waitingOnly: true, limit: 5, refresh: 'cached' }],
        ['pull', { repository: 'octo/repo', number: 7, sections: ['discussion'], threads: 'all', includeOutdated: true, maxBodyChars: 300, maxEntries: 4, maxThreadComments: 2, cursor: 'abc', refresh: 'now' }]
      ]);
      // each ran through the Conductor's Places
      expect(scopes).toHaveLength(2);
      // a malformed repository or an unknown refresh never reaches GitHub
      for (const bad of [{ repository: 'octo', number: 1 }, { repository: 'octo/repo', number: 0 }, { repository: 'octo/repo', number: 1, refresh: 'always' }, { repository: 'octo/repo', number: 1, max_body_chars: 9_000 }]) {
        await expect(gateway.call(reader, 'get_github_pull_request', bad)).resolves.toMatchObject({ structuredContent: { error: { code: 'invalid_request' } } });
      }
      expect(githubCalls).toHaveLength(2);
      await expect(gateway.call(reader, 'get_github_overview', { instance_id: 'https://peer.example.com' })).resolves.toMatchObject({ structuredContent: { error: { code: 'instance_unavailable' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // `process` narrows the action to one Stack process; without it the call is as it always was
  it('passes an optional Stack process name through to a stack action', async () => {
    const { root, gateway, stackActions } = await fixture();
    try {
      const operator = { ...principal, scopes: [...principal.scopes, 'stack:operate' as const] };
      await expect(gateway.call(operator, 'run_stack_action', { worktree_id: 'fern', action: 'restart', process: 'api', request_id: 'request-stack-1' })).resolves.toMatchObject({ structuredContent: { ok: true } });
      await expect(gateway.call(operator, 'run_stack_action', { worktree_id: 'fern', action: 'start', request_id: 'request-stack-2' })).resolves.toMatchObject({ structuredContent: { ok: true } });
      await expect(gateway.call(operator, 'run_stack_action', { worktree_id: 'fern', action: 'start', process: '', request_id: 'request-stack-3' })).resolves.toMatchObject({ structuredContent: { ok: false } });
      expect(stackActions).toEqual([{ worktreeId: 'fern', action: 'restart', process: 'api' }, { worktreeId: 'fern', action: 'start' }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('runs mutations only during voice mode and replays idempotent results', async () => {
    const { root, gateway, control, queued } = await fixture();
    try {
      const args = { agent_id: 'agent-1', prompt: 'Review the branch', request_id: 'request-123' };
      const completed = await gateway.call(principal, 'queue_prompt', args);
      expect(completed.structuredContent).toMatchObject({ ok: true, data: { accepted: true } });
      const replayed = await gateway.call(principal, 'queue_prompt', args);
      expect(replayed.structuredContent).toMatchObject({ ok: true, replayed: true });
      expect(queued()).toBe(1);
      control.stopVoice('browser-session', 'voice-session-123456789');
      await expect(gateway.call(principal, 'queue_prompt', { ...args, request_id: 'request-voice-off' })).resolves.toMatchObject({ structuredContent: { error: { code: 'voice_mode_required' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('forwards an explicitly selected configured instance', async () => {
    const { root, gateway, forwarded } = await fixture();
    try {
      const result = await gateway.call(principal, 'list_instances', { instance_id: 'https://peer.example.com' });
      expect(result.structuredContent).toEqual({ ok: true, remote: true });
      const mutation = await gateway.call(principal, 'queue_prompt', { instance_id: 'https://peer.example.com', agent_id: 'agent-1', prompt: 'Review', request_id: 'request-remote' });
      expect(mutation.structuredContent).toEqual({ ok: true, remote: true });
      expect(forwarded).toEqual([{ instanceId: 'https://peer.example.com', name: 'list_instances', voiceAuthorized: false }, { instanceId: 'https://peer.example.com', name: 'queue_prompt', voiceAuthorized: true }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed before mutations when audit intent cannot be stored', async () => {
    const { root, gateway, queued } = await fixture({ record: async event => {
      // fail only the pre-effect audit
      if (event.phase === 'intent') throw new Error('disk unavailable');
    } });
    try {
      const args = { agent_id: 'agent-1', prompt: 'Review the branch', request_id: 'request-456' };
      await expect(gateway.call(principal, 'queue_prompt', args)).resolves.toMatchObject({ structuredContent: { error: { code: 'audit_unavailable' } } });
      expect(queued()).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the Conductor on its own instance and its reads within its Places', async () => {
    const { root, gateway, forwarded, scopes } = await fixture();
    try {
      const places = () => true;
      const conductor: IntegrationPrincipal = { authentication: 'conductor', subjectId: 'conductor-1', clientId: 'conductor', audience: principal.audience, scopes: ['status:read'], places };
      await expect(gateway.call(conductor, 'list_instances', { instance_id: 'https://peer.example.com' })).resolves.toMatchObject({ structuredContent: { error: { code: 'instance_unavailable' } } });
      expect(forwarded).toEqual([]);
      await expect(gateway.call(conductor, 'list_worktrees', {})).resolves.toMatchObject({ structuredContent: { ok: true } });
      expect(scopes).toEqual([places]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('closes every mutation to the Conductor that is not on its list, so a tool added later stays closed', async () => {
    const { root, gateway } = await fixture();
    try {
      const conductor: IntegrationPrincipal = { authentication: 'conductor', subjectId: 'conductor-1', clientId: 'conductor', audience: principal.audience, scopes: ['status:read', 'logs:read', 'prompts:write', 'agents:control', 'admin:dangerous'], places: () => true };
      // a mutation the catalog has but the list does not name: neither listed nor callable
      const listed = gateway.listTools(conductor).map(tool => tool.name);
      expect(listed).toContain('queue_prompt');
      expect(listed).not.toContain('move_queued_prompt');
      await expect(gateway.call(conductor, 'move_queued_prompt', { agent_id: 'a', prompt_id: 'prompt-123456789', direction: 'earlier', request_id: 'request-move-1' })).resolves.toMatchObject({ structuredContent: { error: { code: 'tool_disabled' } } });
      for (const risk of ['write', 'operational', 'dangerous'] as const) expect(conductorCallable({ name: 'some_future_tool', risk })).toBe(false);
      expect(conductorCallable({ name: 'some_future_read', risk: 'read' })).toBe(true);
      // the dangerous ones it may call are still held to admin:dangerous by their scopes
      expect(conductorCallable({ name: 'deactivate_agent', risk: 'dangerous' })).toBe(true);
      for (const never of ['answer_agent_question', 'launch_worktree_agent', 'launch_scratch_agent']) expect(conductorCallable({ name: never, risk: 'write' })).toBe(false);
      // the Conductor's own tools are never offered to the operator's integrations
      const oauth: IntegrationPrincipal = { ...principal, scopes: ['status:read', 'logs:read', 'stack:operate', 'agents:control'] };
      expect(gateway.listTools(oauth).map(tool => tool.name)).toEqual(expect.not.arrayContaining(['list_notes', 'get_process_log', 'spawn_agent', 'close_agent']));
      expect(gateway.listTools(conductor).map(tool => tool.name)).toEqual(expect.arrayContaining(['list_notes', 'get_process_log']));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('gates the Conductor\'s writes and dangerous tools by its scopes alone, while the deployment gates keep holding OAuth', async () => {
    const { root, gateway, queued } = await fixture(undefined, { enabled: false, mcp: { readEnabled: true, writeEnabled: false, dangerousEnabled: false } });
    try {
      const conductor: IntegrationPrincipal = { authentication: 'conductor', subjectId: 'conductor-1', clientId: 'conductor', audience: principal.audience, scopes: ['status:read', 'prompts:write', 'agents:control', 'admin:dangerous'], places: () => true };
      expect(gateway.listTools(conductor).map(tool => tool.name)).toEqual(expect.arrayContaining(['queue_prompt', 'deactivate_agent']));
      await expect(gateway.call(conductor, 'queue_prompt', { agent_id: 'a', prompt: 'Lint', request_id: 'request-gate-1' })).resolves.toMatchObject({ structuredContent: { ok: true } });
      await expect(gateway.call(conductor, 'deactivate_agent', { agent_id: 'a', request_id: 'request-gate-2' })).resolves.toMatchObject({ structuredContent: { ok: true } });
      expect(queued()).toBe(1);
      // without the scope, the dangerous tool is neither listed nor callable
      const careful = { ...conductor, scopes: conductor.scopes.filter(scope => scope !== 'admin:dangerous') };
      expect(gateway.listTools(careful).map(tool => tool.name)).not.toContain('deactivate_agent');
      await expect(gateway.call(careful, 'deactivate_agent', { agent_id: 'a', request_id: 'request-gate-3' })).resolves.toMatchObject({ structuredContent: { error: { code: 'insufficient_scope' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
    // an operator's OAuth client is still held to writeEnabled
    const oauth = await fixture(undefined, { mcp: { readEnabled: true, writeEnabled: false, dangerousEnabled: false } });
    try {
      expect(oauth.gateway.listTools(principal).map(tool => tool.name)).not.toContain('queue_prompt');
      await expect(oauth.gateway.call(principal, 'queue_prompt', { agent_id: 'a', prompt: 'Lint', request_id: 'request-gate-4' })).resolves.toMatchObject({ structuredContent: { error: { code: 'tool_disabled' } } });
    } finally { await rm(oauth.root, { recursive: true, force: true }); }
  });
});
