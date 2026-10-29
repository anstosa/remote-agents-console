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
async function fixture(audit?: { record: (event: AuditEvent) => Promise<void> }) {
  const root = await mkdtemp(join(tmpdir(), 'rac-gateway-'));
  let queued = 0;
  const stackActions: unknown[] = [];
  const scopes: unknown[] = [];
  const orchestration = {
    scoped: (admits: unknown) => { scopes.push(admits); return orchestration; },
    listWorktrees: async () => ({ ok: true as const, version: 'v1' as const, value: [] }),
    listInstances: async () => ({ ok: true as const, version: 'v1' as const, value: [{ id: 'https://agents.example.com', name: 'Local', url: 'https://agents.example.com', local: true }] }),
    queuePrompt: async () => { queued += 1; return { ok: true as const, version: 'v1' as const, value: { accepted: true as const } }; },
    runStackAction: async (input: unknown) => { stackActions.push(input); return { ok: true as const, version: 'v1' as const, value: { started: true as const } }; }
  };
  const forwarded: Array<{ instanceId: string; name: string; voiceAuthorized: boolean }> = [];
  const policy = new IntegrationPolicyService(join(root, 'policy.json'));
  const control = new IntegrationControlService(() => 'browser-session');
  control.startVoice('browser-session', 'voice-session-123456789');
  const gateway = new IntegrationGateway({
    config,
    instanceId: 'https://agents.example.com',
    orchestration: orchestration as never,
    policy,
    audit: audit ?? new IntegrationAuditService(join(root, 'audit.jsonl')),
    control,
    forward: async (instanceId, _principal, name, _args, voiceAuthorized) => { forwarded.push({ instanceId, name, voiceAuthorized }); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, remote: true } }; }
  });
  return { root, gateway, control, queued: () => queued, forwarded, stackActions, scopes };
}

describe('IntegrationGateway', () => {
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
});
