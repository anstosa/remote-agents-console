import { describe, expect, it, vi } from 'vitest';
import { RealtimeService } from '../src/integrations/realtime/service.js';

const request = {
  subject: 'session-identifier',
  mcpUrl: 'https://agents.example.com/mcp',
  mcpAuthorization: 'a'.repeat(32),
  allowedTools: ['list_worktrees', 'queue_prompt'],
  context: { instanceId: 'https://agents.example.com', worktreeId: 'cora', agentId: 'agent-cora' }
};

describe('RealtimeService', () => {
  it('reports missing provider credentials without making a request', async () => {
    const provider = vi.fn();
    const service = new RealtimeService({ fetch: provider as typeof fetch });

    expect(service.available()).toBe(false);
    await expect(service.create(request)).resolves.toEqual({ ok: false, code: 'unavailable' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('mints a scoped MCP-enabled browser client secret', async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_ephemeral-client-secret', expires_at: 1_800_000_000 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch });

    await expect(service.create(request)).resolves.toEqual({ ok: true, clientSecret: { value: 'ek_ephemeral-client-secret', expires_at: 1_800_000_000 }, model: 'gpt-realtime-2.1' });
    const [url, init] = provider.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(init.headers).toMatchObject({ authorization: 'Bearer provider-key', 'content-type': 'application/json' });
    expect((init.headers as Record<string, string>)['openai-safety-identifier']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } }, output: { voice: 'cedar' } },
        tools: [{ type: 'mcp', server_label: 'remote_agents', server_url: request.mcpUrl, authorization: request.mcpAuthorization, allowed_tools: request.allowedTools, require_approval: 'never' }, { type: 'function', name: 'select_worktree', parameters: { required: ['worktree_id'] } }]
      }
    });
    expect(body.session.instructions).toContain('Your name is Davo');
    expect(body.session.instructions).toContain('caller is Ansel');
    expect(body.session.instructions).toContain('broad Australian accent');
    expect(body.session.instructions).toContain('casual Australian profanity');
    expect(body.session.instructions).toContain('at most five words');
    expect(body.session.instructions).toContain('only the final answer may be longer');
    expect(body.session.instructions).toContain('reply with no more than four words');
    expect(body.session.instructions).toContain('another bare interruption');
    expect(body.session.instructions).toContain('produce no reply');
    expect(body.session.instructions).toContain('status update, sitrep, roll call');
    expect(body.session.instructions).toContain('Maintain one selected worktree');
    expect(body.session.instructions).toContain('call select_worktree');
    expect(body.session.instructions).toContain('report every active worktree');
    expect(body.session.instructions).toContain('Do not limit an unscoped report to the selected worktree');
    expect(body.session.instructions).toContain('adjacent related prompt group and its result');
    expect(body.session.instructions).toContain('Never include branch, Git, stack, pull-request');
    expect(body.session.instructions).toContain('execution requests, not questions');
    expect(body.session.instructions).toContain('inspect the named or current worktree');
    expect(body.session.instructions).toContain('submit the caller’s requested outcome as a queue_prompt');
    expect(body.session.instructions).toContain('Never replace an execution request with instructions');
    expect(body.session.instructions).toContain('explicitly asks how, asks for a plan');
    expect(body.session.instructions).toContain('worktree_id=cora');
  });

  it('rejects malformed requests and provider responses', async () => {
    const provider = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch });

    await expect(service.create({ ...request, mcpUrl: 'http://agents.example.com/mcp' })).resolves.toEqual({ ok: false, code: 'invalid_request' });
    await expect(service.create(request)).resolves.toEqual({ ok: false, code: 'provider_error' });
  });

  it('accepts the expanded bounded catalog allowlist', async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_ephemeral-client-secret' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch });
    const expanded = Array.from({ length: 120 }, (_, index) => `tool_${index}`);

    await expect(service.create({ ...request, allowedTools: expanded })).resolves.toMatchObject({ ok: true });
    await expect(service.create({ ...request, allowedTools: Array.from({ length: 257 }, (_, index) => `tool_${index}`) })).resolves.toEqual({ ok: false, code: 'invalid_request' });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('uses the current configurable name and context without retaining the default persona', async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_ephemeral-client-secret' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    let settings = { name: 'Riley', context: 'Speak plainly and keep the tone dry.' };
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch, settings: () => settings });

    await service.create(request);
    settings = { name: 'Morgan', context: '' };
    await service.create(request);

    const first = JSON.parse(String(provider.mock.calls[0]![1].body));
    const second = JSON.parse(String(provider.mock.calls[1]![1].body));
    expect(first.session.instructions).toContain('Your name is Riley');
    expect(first.session.instructions).toContain('Speak plainly and keep the tone dry.');
    expect(first.session.instructions).not.toContain('broad Australian accent');
    expect(second.session.instructions).toContain('Your name is Morgan');
    expect(second.session.instructions).not.toContain('Speak plainly and keep the tone dry.');
  });
});
