import { mkdtemp, readFile, rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { developerTool, developerSuccess, type DeveloperTool } from '../src/integrations/mcp/developer-tool.js';
import { createAgentTools } from '../src/integrations/mcp/agent-tools.js';
import { createReviewDraftPort } from '../src/integrations/mcp/review-draft.js';
import { registerMcpServer } from '../src/integrations/mcp/server.js';
import type { FederationForwardContext } from '../src/integrations/federation/service.js';
import { PullRequestReviewError } from '../src/review-tour/pr-review.js';
import { IntegrationAuditService } from '../src/integrations/audit/service.js';
import type { AuditEvent } from '../src/integrations/audit/service.js';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { IntegrationGateway } from '../src/integrations/mcp/gateway.js';
import { conductorCallable } from '../src/integrations/mcp/catalog.js';
import { validateToolSchema } from '../src/integrations/mcp/legacy-output.js';
import { IntegrationPolicyService, IntegrationPolicyWriteError } from '../src/integrations/policy/service.js';
import { IntegrationControlService } from '../src/integrations/control/index.js';

const principal: IntegrationPrincipal = { authentication: 'oauth', subjectId: 'user', clientId: 'chatgpt', audience: 'https://agents.example.com/mcp', scopes: ['status:read', 'prompts:write'] };
const config = { enabled: true, mcp: { readEnabled: true, writeEnabled: true, dangerousEnabled: false }, realtime: { enabled: true, name: 'Davo', context: '', writeToolsEnabled: true }, multiInstance: { enabled: true } };

// create one private policy-backed gateway fixture
async function fixture(audit?: { record: (event: AuditEvent) => Promise<void> }, gates: Partial<typeof config> = {}, tools: DeveloperTool[] = [], forwardProbe?: (context: FederationForwardContext) => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'rac-gateway-'));
  let queued = 0;
  const stackActions: unknown[] = [];
  const scopes: unknown[] = [];
  const githubCalls: unknown[] = [];
  const freshness = { state: 'cold', fetchedAt: null, ageSeconds: null, network: 'none', problem: null, backgroundPoll: 'none' };
  const orchestration = {
    githubOverview: async (input: unknown) => { githubCalls.push(['overview', input]); return { ok: true as const, version: 'v1' as const, value: { freshness, coverage: { viewer: null, repositories: [], lists: {}, notCovered: [] } } }; },
    githubPullRequest: async (input: unknown) => { githubCalls.push(['pull', input]); return { ok: true as const, version: 'v1' as const, value: { freshness, repository: 'octo/repo', number: 7, pullRequest: null } }; },
    scoped: (admits: unknown) => { scopes.push(admits); return orchestration; },
    hasAgent: async () => true,
    listWorktrees: async () => ({ ok: true as const, version: 'v1' as const, value: [] }),
    listInstances: async () => ({ ok: true as const, version: 'v1' as const, value: [{ id: 'https://agents.example.com', name: 'Local', url: 'https://agents.example.com', local: true }] }),
    queuePrompt: async () => { queued += 1; return { ok: true as const, version: 'v1' as const, value: { accepted: true as const, prompt_id: 'prompt-id-12345678' } }; },
    deactivate: async () => ({ ok: true as const, version: 'v1' as const, value: { deactivated: true as const } }),
    runStackAction: async (input: unknown) => { stackActions.push(input); return { ok: true as const, version: 'v1' as const, value: { started: true as const } }; }
  };
  const forwarded: Array<{ instanceId: string; name: string; leaseBound: boolean }> = [];
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
    developerTools: () => tools,
    forward: async (instanceId, _principal, name, _args, context) => {
      // model asynchronous discovery followed by the real issuance authorization callback
      if (forwardProbe !== undefined && !forwardProbe(context)) return undefined;
      forwarded.push({ instanceId, name, leaseBound: context.controlLeaseKey !== undefined });
      return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, remote: true } };
    }
  });
  return { root, gateway, control, policy, queued: () => queued, forwarded, stackActions, scopes, githubCalls };
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
      expect(forwarded).toEqual([{ instanceId: 'https://peer.example.com', name: 'list_instances', leaseBound: false }, { instanceId: 'https://peer.example.com', name: 'queue_prompt', leaseBound: true }]);
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
      expect(gateway.listTools(oauth).map(tool => tool.name)).toEqual(expect.not.arrayContaining(['list_notes', 'get_process_log', 'spawn_agent', 'close_agent', 'create_worktree']));
      expect(gateway.listTools(conductor).map(tool => tool.name)).toEqual(expect.arrayContaining(['list_notes', 'get_process_log', 'create_worktree']));
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

// build one strict internal fixture without adding it to the public catalog
function internalTool(name: string, risk: 'read' | 'write' | 'dangerous', execute = async () => developerSuccess({ accepted: true }), domainCursor = false): DeveloperTool {
  const mutation = risk !== 'read' && !domainCursor;
  return developerTool({ name, title: name, description: name, risk, audiences: ['conductor', 'realtime'], requiredScopes: risk === 'read' ? ['files:read'] : risk === 'write' ? ['files:write'] : ['agents:control', 'admin:dangerous'], schema: mutation ? z.object({ request_id: z.string().min(8) }).strict() : z.object({}).strict(), inputSchema: { type: 'object', properties: mutation ? { request_id: { type: 'string', minLength: 8 } } : {}, required: mutation ? ['request_id'] : [], additionalProperties: false }, output: z.object({ accepted: z.literal(true) }).strict(), dataSchema: { type: 'object', properties: { accepted: { const: true } }, required: ['accepted'], additionalProperties: false }, ...(domainCursor ? { idempotency: 'domain_cursor' } : {}), execute });
}

describe('gateway authority, uncertainty and audience regression guards', () => {
  // a failed claim is a correlated tool refusal rather than a route-level internal error
  it.each(['before', 'published', 'unknown'] as const)('preserves RPC identity when claim persistence fails %s publication', async failure => {
    const events: AuditEvent[] = [];
    const instance = await fixture({ record: async event => { events.push(event); } });
    const app = Fastify();
    const claim = instance.policy.claim.bind(instance.policy);
    let first = true;
    instance.policy.claim = async (...args) => {
      // inject one private storage failure at the replay-protection boundary
      if (first) {
        first = false;
        // post-publication failures leave an actual durable claim for later retries
        if (failure !== 'before') await claim(...args);
        throw failure === 'before' ? new Error('/private/policy: unavailable') : new IntegrationPolicyWriteError(failure);
      }
      return await claim(...args);
    };
    registerMcpServer({ app, publicOrigin: 'https://agents.example.com', gateway: instance.gateway, realtimeScopes: [], auth: { authenticateAccessToken: async () => ({ ok: true, value: principal }) } as never });
    const request = { jsonrpc: '2.0', id: `claim-${failure}`, method: 'tools/call', params: { name: 'queue_prompt', arguments: { agent_id: 'agent', prompt: 'hello', request_id: `request-claim-${failure}` } } };
    // exercise the actual HTTP transport with the policy-backed gateway
    const call = async () => await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'agents.example.com', authorization: 'Bearer fixture', 'mcp-protocol-version': '2025-06-18' }, payload: request });
    try {
      const denied = await call();
      expect(denied.statusCode).toBe(200);
      expect(denied.json()).toMatchObject({ id: request.id, result: { isError: true, structuredContent: { ok: false, error: { code: failure === 'before' ? 'audit_unavailable' : 'unknown_outcome' } } } });
      expect(denied.body).not.toContain('/private/policy');
      expect(instance.queued()).toBe(0);
      expect(events.some(event => event.phase === 'intent')).toBe(false);
      const retry = await call();
      // only a definitely unpersisted first claim can acquire a new dispatch on retry
      if (failure === 'before') {
        expect(retry.json().result.structuredContent.ok).toBe(true);
        expect(instance.queued()).toBe(1);
      } else {
        expect(retry.json().result.structuredContent.error.code).toBe('in_progress');
        await instance.policy.recoverUnknownOutcomes();
        const recovered = await call();
        expect(recovered.json().result.structuredContent).toMatchObject({ replayed: true, error: { code: 'unknown_outcome' } });
        expect(instance.queued()).toBe(0);
      }
    } finally { await app.close(); await rm(instance.root, { recursive: true, force: true }); }
  });
  // Realtime reads need the same exact origin lease recheck after metadata discovery
  it('does not forward a Davo read after lease replacement while preserving OAuth reads', async () => {
    let instance: Awaited<ReturnType<typeof fixture>>;
    instance = await fixture(undefined, {}, [], context => {
      instance.control.startVoice('browser-session', 'replacement-session-1234');
      return context.authorize?.() === true;
    });
    try {
      const credential = instance.control.startVoiceLease('browser-session', 'remote-read-session-1234', ['status:read'])!;
      const davo = instance.control.authenticateRealtimeBearer(credential.bearer)!;
      expect((await instance.gateway.call(davo, 'list_instances', { instance_id: 'https://peer.example.com' })).structuredContent).toMatchObject({ error: { code: 'instance_unavailable' } });
      expect(instance.forwarded).toEqual([]);
      expect((await instance.gateway.call(principal, 'list_instances', { instance_id: 'https://peer.example.com' })).structuredContent).toMatchObject({ ok: true });
      expect(instance.forwarded).toHaveLength(1);
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // real review-draft projection must preserve ambiguous GitHub effects through durable replay
  it.each(['draft', 'body', 'thread', 'missing-id'])('never reposts an uncertain review %s effect', async stage => {
    let posts = 0;
    const fingerprint = 'fingerprint-1234567890';
    const port = createReviewDraftPort({ worktrees: () => [{ id: 'worktree', path: '/repo', available: true }], repositoryAt: async () => ({ owner: 'acme', name: 'repo' }), current: async () => ({ worktreeId: 'worktree', workspace: '/repo', branch: 'feature', scope: 'pr', base: 'main', includeTests: true, includeDocs: true, fingerprint, changes: [] }), post: async () => {
      posts += 1;
      // missing identifiers and post-write provider failures are equally uncertain
      if (stage === 'missing-id') return { status: 'ok', sections: [], comments: [], review: { url: 'https://github.com/acme/repo/pull/7/files', pullRequest: { number: 7, url: 'https://github.com/acme/repo/pull/7' } } };
      throw new PullRequestReviewError('github_failed', true, `/private/${stage}: provider detail`);
    } });
    // exercise replay through a synthetic admitted-tool alias without exposing raw review mutation
    const tools = createAgentTools({ create_pull_request_review_draft: port }).map(tool => tool.name === 'create_pull_request_review_draft' ? { ...tool, name: 'delegate_request' } : tool);
    const instance = await fixture(undefined, {}, tools);
    try {
      const credential = instance.control.startVoiceLease('browser-session', 'draft-session-123456789', ['github:write'])!;
      const davo = instance.control.authenticateRealtimeBearer(credential.bearer)!;
      const args = { repository: 'acme/repo', number: 7, fingerprint, body: 'review', request_id: `request-review-${stage}` };
      const result = await instance.gateway.call(davo, 'delegate_request', args);
      expect(result.structuredContent).toMatchObject({ contract_version: 'v2', error: { code: 'unknown_outcome' } });
      expect(JSON.stringify(result)).not.toContain('/private/');
      const replay = await instance.gateway.call(davo, 'delegate_request', args);
      expect(replay.structuredContent).toMatchObject({ replayed: true, error: { code: 'unknown_outcome' } });
      expect(posts).toBe(1);
      const stored = JSON.parse(await readFile(join(instance.root, 'policy.json'), 'utf8'));
      expect(stored.idempotency[0].state).toBe('unknown_outcome');
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // a lease change during the durable intent cannot borrow the replacement lease
  it('rechecks the exact captured OAuth lease after intent and before dispatch', async () => {
    let instance: Awaited<ReturnType<typeof fixture>>;
    instance = await fixture({ record: async event => {
      // simulate a controller replacing voice while audit persistence is awaiting
      if (event.phase === 'intent') { instance.control.stopVoice('browser-session', 'voice-session-123456789'); instance.control.startVoice('browser-session', 'replacement-session-1234'); }
    } });
    try {
      const response = await instance.gateway.call(principal, 'queue_prompt', { agent_id: 'agent', prompt: 'hello', request_id: 'request-lease-race' });
      expect(response.structuredContent).toMatchObject({ ok: false, error: { code: 'voice_lease_changed' } });
      expect(instance.queued()).toBe(0);
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // failure after dispatch is never described as an operation that did not run
  it('retains an unresolved claim and reports unknown_outcome after completion-write failure', async () => {
    const instance = await fixture();
    instance.policy.finish = async () => { throw new Error('disk full'); };
    try {
      const args = { agent_id: 'agent', prompt: 'hello', request_id: 'request-outcome-failure' };
      expect((await instance.gateway.call(principal, 'queue_prompt', args)).structuredContent).toMatchObject({ ok: false, error: { code: 'unknown_outcome' } });
      expect((await instance.gateway.call(principal, 'queue_prompt', args)).structuredContent).toMatchObject({ ok: false, error: { code: 'in_progress' } });
      expect(instance.queued()).toBe(1);
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // internal scopes never add new OAuth names or replace its existing schemas
  it('keeps developer extensions hidden from OAuth and validates actual internal output', async () => {
    const tool = internalTool('internal_read', 'read', async () => developerSuccess({ unexpected: 'secret' }));
    const instance = await fixture(undefined, {}, [tool]);
    try {
      const oauth = { ...principal, scopes: ['files:read' as const, 'files:write' as const] };
      expect(instance.gateway.listTools(oauth).map(item => item.name)).not.toContain(tool.name);
      expect((await instance.gateway.call(oauth, tool.name, {})).structuredContent.ok).toBe(false);
      const credential = instance.control.startVoiceLease('browser-session', 'internal-session-123456789', ['files:read'])!;
      const davo = instance.control.authenticateRealtimeBearer(credential.bearer)!;
      expect((await instance.gateway.call(davo, tool.name, {})).structuredContent).toMatchObject({ ok: false, contract_version: 'v2', error: { code: 'invalid_output' } });
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // explicit audience projections supersede the old Conductor-only marker, never OAuth policy
  it('blocks re-audienced raw mutations for Davo without changing OAuth isolation', async () => {
    const tool = { ...internalTool('spawn_agent', 'write'), conductorOnly: true as const, contractVersion: 'v1' as const };
    const instance = await fixture(undefined, {}, [tool]);
    try {
      const credential = instance.control.startVoiceLease('browser-session', 'worker-session-123456789', ['files:write'])!;
      const davo = instance.control.authenticateRealtimeBearer(credential.bearer)!;
      expect(instance.gateway.listTools(davo).map(item => item.name)).not.toContain('spawn_agent');
      expect((await instance.gateway.call(davo, 'spawn_agent', { request_id: 'request-worker-audience' })).structuredContent).toMatchObject({ ok: false, error: { code: 'tool_disabled' } });
      expect(instance.gateway.listTools({ ...principal, scopes: ['files:write'] }).map(item => item.name)).not.toContain('spawn_agent');
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // unexpected domain failures cannot disclose implementation details or deny a possible effect
  it('sanitizes unexpected domain exceptions and preserves mutation uncertainty', async () => {
    let effects = 0;
    const write = internalTool('delegate_request', 'write', async () => { effects += 1; throw new Error('/sensitive/path secret'); });
    const read = internalTool('internal_read_crash', 'read', async () => { throw new Error('/sensitive/path secret'); });
    const instance = await fixture(undefined, {}, [write, read]);
    try {
      const credential = instance.control.startVoiceLease('browser-session', 'error-session-123456789', ['files:write', 'files:read'])!;
      const davo = instance.control.authenticateRealtimeBearer(credential.bearer)!;
      const result = await instance.gateway.call(davo, write.name, { request_id: 'request-unknown-effect' });
      expect(result.structuredContent).toMatchObject({ error: { code: 'unknown_outcome' } });
      expect(JSON.stringify(result)).not.toContain('/sensitive/path');
      const failure = await instance.gateway.call(davo, read.name, {});
      expect(failure.structuredContent).toMatchObject({ error: { code: 'operation_failed' } });
      expect(JSON.stringify(failure)).not.toContain('/sensitive/path');
      const replay = await instance.gateway.call(davo, write.name, { request_id: 'request-unknown-effect' });
      expect(replay.structuredContent).toMatchObject({ ok: false, contract_version: 'v2', replayed: true, error: { code: 'unknown_outcome', message: expect.any(String), retryable: true } });
      expect(validateToolSchema(write.outputSchema!, replay.structuredContent)).toBe(true);
      expect(effects).toBe(1);
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // invalid post-effect output must retain uncertainty and a valid replay envelope
  it('reports unknown_outcome for an invalid mutation result without repeating its effect', async () => {
    let effects = 0;
    const tool = internalTool('delegate_request', 'write', async () => { effects += 1; return developerSuccess({ private: 'invalid result' }); });
    const instance = await fixture(undefined, {}, [tool]);
    try {
      const credential = instance.control.startVoiceLease('browser-session', 'invalid-output-session-1234', ['files:write'])!;
      const davo = instance.control.authenticateRealtimeBearer(credential.bearer)!;
      const args = { request_id: 'request-invalid-output' };
      const first = await instance.gateway.call(davo, tool.name, args);
      expect(first.structuredContent).toMatchObject({ ok: false, error: { code: 'unknown_outcome' } });
      expect(JSON.stringify(first)).not.toContain('invalid result');
      const replay = await instance.gateway.call(davo, tool.name, args);
      expect(replay.structuredContent).toMatchObject({ ok: false, replayed: true, error: { code: 'unknown_outcome' } });
      expect(validateToolSchema(tool.outputSchema!, replay.structuredContent)).toBe(true);
      expect(effects).toBe(1);
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // offset and prefix retries must not fill the generic durable claim store
  it('dispatches domain cursors without generic idempotency records', async () => {
    let calls = 0;
    const tool = internalTool('bind_davo_target', 'write', async () => { calls += 1; return developerSuccess({ accepted: true }); }, true);
    const instance = await fixture(undefined, {}, [tool]);
    instance.policy.claim = async () => { throw new Error('generic claim must not run'); };
    try {
      const credential = instance.control.startVoiceLease('browser-session', 'domain-session-123456789', ['files:write'])!;
      const davo = instance.control.authenticateRealtimeBearer(credential.bearer)!;
      expect((await instance.gateway.call(davo, tool.name, {})).structuredContent).toMatchObject({ ok: true, contract_version: 'v2' });
      expect((await instance.gateway.call(davo, tool.name, {})).structuredContent.ok).toBe(true);
      expect(calls).toBe(2);
      instance.control.stopVoice('browser-session', 'domain-session-123456789');
      expect((await instance.gateway.call(davo, tool.name, {})).structuredContent.ok).toBe(false);
      expect(calls).toBe(2);
    } finally { await rm(instance.root, { recursive: true, force: true }); }
  });
  // enumerate independent read, write, dangerous and voice-write flags
  it('preserves all sixteen Davo feature-gate combinations and Conductor asymmetry', async () => {
    const tools = [internalTool('internal_read', 'read'), internalTool('internal_write', 'write'), internalTool('internal_danger', 'dangerous')];
    // each fixture uses its own private replay store and active lease
    for (let flags = 0; flags < 16; flags += 1) {
      const read = Boolean(flags & 1); const write = Boolean(flags & 2); const dangerous = Boolean(flags & 4); const voiceWrite = Boolean(flags & 8);
      const instance = await fixture(undefined, { mcp: { readEnabled: read, writeEnabled: write, dangerousEnabled: dangerous }, realtime: { ...config.realtime, writeToolsEnabled: voiceWrite } }, tools);
      try {
        const davo: IntegrationPrincipal = { authentication: 'realtime', subjectId: 'owner', leaseKey: 'lease', audience: principal.audience, scopes: ['files:read', 'files:write', 'agents:control', 'admin:dangerous'] };
        const names = instance.gateway.listTools(davo).map(tool => tool.name);
        expect(names.includes('internal_read')).toBe(read);
        expect(names.includes('internal_write')).toBe(false);
        expect(names.includes('internal_danger')).toBe(false);
        const conductor: IntegrationPrincipal = { ...davo, authentication: 'conductor' };
        const conductorNames = instance.gateway.listTools(conductor).map(tool => tool.name);
        expect(conductorNames.includes('internal_read')).toBe(read);
        expect(conductorNames.includes('internal_write')).toBe(true);
        expect(conductorNames.includes('internal_danger')).toBe(true);
      } finally { await rm(instance.root, { recursive: true, force: true }); }
    }
  });
});
