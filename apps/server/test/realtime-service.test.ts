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

    await expect(service.create({ ...request, allowedTools: [] })).resolves.toEqual({ ok: true, clientSecret: { value: 'ek_ephemeral-client-secret', expires_at: 1_800_000_000 }, model: 'gpt-realtime-2.1' });
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
    expect(body.session.instructions).toContain('For Davo action tools omit request_id');
    expect(body.session.instructions).toContain('never ask the user to provide them');
    expect(body.session.instructions).toContain('already finalized by the client');
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

  // keep status replies about evidenced work rather than repository inventory
  it('guides status replies toward meaningful local work without file or change counts', async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_ephemeral-client-secret' })));
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch });
    const instructions = service.instructions(request.context);

    expect(instructions).toContain('summarize what the user is actually working on');
    expect(instructions).toContain('Do not list changed files or report file, line, or change counts');
    expect(instructions).toContain('get_comparison with mode working');
    expect(instructions).toContain('get_comparison_file');
    expect(instructions).toContain('recent agent responses or prompt history');
    expect(instructions).toContain('If evidence is unavailable, say what you could not verify rather than guessing or substituting counts');
    expect(instructions).toContain('Status requests are read-only');
    await expect(service.create(request)).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(String(provider.mock.calls[0]![1].body)).session.instructions).toBe(instructions);
  });

  // lead with task themes instead of repeating discovery metadata or old replies
  it('requires topic-first status grounded beyond discovery results', async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_ephemeral-client-secret' })));
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch });
    const instructions = service.instructions(request.context);

    expect(instructions).toContain('Lead with one short sentence per relevant project or worktree');
    expect(instructions).toContain('Remote Agents is working on changes to Davo, Conductor, and the MCP.');
    expect(instructions).toContain('illustrative, not a fixed answer');
    expect(instructions).toContain('list_agents, list_worktrees, get_worktree_status, and summarize_workspace are discovery results, not an answer about the actual work');
    expect(instructions).toContain('Do not stop after discovery when further permitted evidence reads are available');
    expect(instructions).toContain('Previous assistant status replies are not current evidence');
    expect(instructions).toContain('Uncommitted changes and upstream divergence do not by themselves prove poor quality, unfinished work, or a blocker');
    expect(instructions).toContain('Do not replace counts with vague phrases such as "a pile of changes"');
    await expect(service.create(request)).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(String(provider.mock.calls[0]![1].body)).session.instructions).toBe(instructions);
  });

  // tool progress belongs to the interface rather than narrated assistant replies
  it('keeps automatic idle and MCP activity lines silent', () => {
    const instructions = new RealtimeService().instructions(request.context);
    expect(instructions).toContain('The interface automatically displays idle status and per-call MCP activity');
    expect(instructions).toContain('Do not narrate routine tool starts or completions');
    expect(instructions).toContain('read these status lines aloud');
    expect(instructions).toContain('Reserve speech and assistant replies for meaningful answers');
  });

  it('rejects oversized configured instructions without minting', async () => {
    const provider = vi.fn();
    const service = new RealtimeService({ apiKey: 'provider-key', fetch: provider as typeof fetch, settings: () => ({ name: 'Riley', context: 'x'.repeat(8 * 1024) }) });

    expect(() => service.instructions(request.context)).toThrowError('davo_context_capacity');
    await expect(service.create(request)).resolves.toEqual({ ok: false, code: 'invalid_request' });
    expect(provider).not.toHaveBeenCalled();
  });
});
