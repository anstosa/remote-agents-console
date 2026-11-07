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

  it('mints a tool-free session with automatic responses disabled', async () => {
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
        tools: []
      }
    });
    expect(body.session.instructions).toContain('Your name is Davo');
    expect(body.session.instructions).toContain('caller is Ansel');
    expect(body.session.instructions).toContain('broad Australian accent');
    expect(body.session.instructions).toContain('casual Australian profanity');
    expect(body.session.audio.input.turn_detection).toMatchObject({ create_response: false, interrupt_response: false });
    expect(body.session.instructions).toContain('persistent engineering partner');
    expect(body.session.instructions).toContain('ambient audio');
    expect(body.session.instructions).toContain('bind_davo_target');
    expect(body.session.instructions).toContain('Never infer approval');
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

  it('exports the same bounded foreground instructions used for session minting', async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_ephemeral-client-secret' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch, settings: () => ({ name: 'Riley', context: 'Keep the configured foreground style.' }) });

    const instructions = service.instructions(request.context);
    expect(instructions).toContain('Your name is Riley');
    expect(instructions).toContain('Keep the configured foreground style.');
    expect(instructions).toContain('persistent engineering partner');
    expect(instructions).toContain('worktree_id=cora');
    await expect(service.create(request)).resolves.toMatchObject({ ok: true });
    const body = JSON.parse(String(provider.mock.calls[0]![1].body));
    expect(body.session.instructions).toBe(instructions);
  });

  it('rejects oversized configured instructions without minting', async () => {
    const provider = vi.fn();
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch, settings: () => ({ name: 'Riley', context: 'x'.repeat(8 * 1024) }) });

    expect(() => service.instructions(request.context)).toThrowError('davo_context_capacity');
    await expect(service.create(request)).resolves.toEqual({ ok: false, code: 'invalid_request' });
    expect(provider).not.toHaveBeenCalled();
  });
});
