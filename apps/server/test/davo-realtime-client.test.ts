import { afterEach, describe, expect, it, vi } from 'vitest';
import { DavoRealtimeTextClient, type DavoRealtimeSocket, type DavoRealtimeSocketFactory } from '../src/davo/realtime-client.js';

// model one event-target socket
class FakeSocket implements DavoRealtimeSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readyState = 0;
  closed = false;

  // register one socket listener
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  // unregister one socket listener
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  // capture one client event
  send(data: string): void {
    this.sent.push(data);
  }

  // mark provider transport closed
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // deliver one provider event
  emit(type: string, event: unknown = {}): void {
    // notify current listeners
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

// build one client and captured socket
function fixture(options: { current?: (generation: number) => boolean; deadlineMs?: number; settings?: () => { name: string; context: string } } = {}) {
  const socket = new FakeSocket();
  const socketFactory = vi.fn(() => socket) as unknown as DavoRealtimeSocketFactory;
  const provider = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_ephemeral-secret-value' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const client = new DavoRealtimeTextClient({
    apiKey: 'standard-provider-key',
    fetch: provider as typeof fetch,
    socketFactory,
    settings: options.settings ?? (() => ({ name: 'Riley', context: 'Keep the configured persona.' })),
    isGenerationCurrent: options.current,
    deadlineMs: options.deadlineMs
  });
  return { client, provider, socketFactory, socket };
}

// open one pending provider request
async function open(socket: FakeSocket): Promise<void> {
  await vi.waitFor(() => expect(socket.listeners.has('open')).toBe(true));
  socket.readyState = 1;
  socket.emit('open');
}

// emit one completed text response
function complete(socket: FakeSocket, text: string): void {
  socket.emit('message', { data: JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } }) });
}

afterEach(() => { vi.useRealTimers(); });

describe('DavoRealtimeTextClient', () => {
  it('uses standard auth only for mint and exact ephemeral WebSocket protocols', async () => {
    const { client, provider, socketFactory, socket } = fixture();
    const pending = client.evaluate({ input: 'request and bounded evidence', generation: 4 });
    await open(socket);
    complete(socket, JSON.stringify({ recommendation: 'continue', unmetCriterionIds: ['criterion-2'], contradictions: [], safeSummary: 'More verified work remains.' }));

    await expect(pending).resolves.toEqual({ ok: true, generation: 4, value: { recommendation: 'continue', unmetCriterionIds: ['criterion-2'], contradictions: [], safeSummary: 'More verified work remains.' } });
    const [mintUrl, mintInit] = provider.mock.calls[0]!;
    expect(mintUrl).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(mintInit.headers).toMatchObject({ authorization: 'Bearer standard-provider-key', 'content-type': 'application/json' });
    expect(String(mintInit.body)).toContain('Riley');
    expect(String(mintInit.body)).toContain('Keep the configured persona.');
    expect(String(mintInit.body)).toContain('"tools":[]');
    expect(socketFactory).toHaveBeenCalledWith('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1', ['realtime', 'openai-insecure-api-key.ek_ephemeral-secret-value']);
    expect(JSON.stringify(socketFactory.mock.calls)).not.toContain('standard-provider-key');
    const request = JSON.parse(socket.sent[0]!);
    expect(request).toMatchObject({ type: 'response.create', response: { conversation: 'none', output_modalities: ['text'], tools: [], tool_choice: 'none' } });
  });

  it('rejects false-done and non-exact evaluator output', async () => {
    const first = fixture();
    const falseDone = first.client.evaluate({ input: 'incomplete evidence', generation: 1 });
    await open(first.socket);
    complete(first.socket, JSON.stringify({ recommendation: 'candidate_done', unmetCriterionIds: ['still-open'], contradictions: [], safeSummary: 'Done.' }));
    await expect(falseDone).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_output' });

    const second = fixture();
    const extraAuthority = second.client.evaluate({ input: 'evidence', generation: 1 });
    await open(second.socket);
    complete(second.socket, JSON.stringify({ recommendation: 'continue', unmetCriterionIds: [], contradictions: [], safeSummary: 'Continue.', approval: true }));
    await expect(extraAuthority).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_output' });
  });

  it('bounds input and output by UTF-8 bytes', async () => {
    const { client, provider, socket } = fixture();
    await expect(client.evaluate({ input: '💥'.repeat(8_193), generation: 1 })).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_input' });
    expect(provider).not.toHaveBeenCalled();

    const pending = client.complete({ input: 'compact retained-only context', generation: 1 });
    await open(socket);
    complete(socket, 'x'.repeat(8_193));
    await expect(pending).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_output' });
    expect(socket.closed).toBe(true);
  });

  it('accounts for wrappers and configured instructions before provider fetch', async () => {
    const valid = fixture({ settings: () => ({ name: 'Riley', context: 'x'.repeat(8 * 1024) }) });
    const pending = valid.client.complete({ input: 'retained context', generation: 1 });
    await open(valid.socket);
    complete(valid.socket, 'bounded output');
    await expect(pending).resolves.toEqual({ ok: true, generation: 1, value: 'bounded output' });
    expect(valid.provider).toHaveBeenCalledTimes(1);

    const oversized = fixture({ settings: () => ({ name: 'Riley', context: 'x'.repeat(8 * 1024) }) });
    await expect(oversized.client.complete({ input: 'y'.repeat(24 * 1024), generation: 1 })).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_input' });
    expect(oversized.provider).not.toHaveBeenCalled();
    expect(oversized.socketFactory).not.toHaveBeenCalled();
  });

  it('closes on abort and ignores late provider output', async () => {
    const { client, socket } = fixture();
    const controller = new AbortController();
    const pending = client.evaluate({ input: 'evidence', generation: 2, signal: controller.signal });
    await open(socket);
    controller.abort();
    complete(socket, JSON.stringify({ recommendation: 'candidate_done', unmetCriterionIds: [], contradictions: [], safeSummary: 'late' }));

    await expect(pending).resolves.toEqual({ ok: false, code: 'davo_provider_aborted' });
    expect(socket.closed).toBe(true);
  });

  it('drops stale generation results', async () => {
    let current = true;
    const { client, socket } = fixture({ current: () => current });
    const pending = client.evaluate({ input: 'evidence', generation: 2 });
    await open(socket);
    current = false;
    complete(socket, JSON.stringify({ recommendation: 'candidate_done', unmetCriterionIds: [], contradictions: [], safeSummary: 'looks complete' }));

    await expect(pending).resolves.toEqual({ ok: false, code: 'davo_generation_changed' });
  });

  it('fails closed on audio, tool, and multiple output items', async () => {
    const audio = fixture();
    const audioPending = audio.client.complete({ input: 'context', generation: 1 });
    await open(audio.socket);
    audio.socket.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }) });
    await expect(audioPending).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_output' });

    const tool = fixture();
    const toolPending = tool.client.complete({ input: 'context', generation: 1 });
    await open(tool.socket);
    tool.socket.emit('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', name: 'danger' }) });
    await expect(toolPending).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_output' });

    const multiple = fixture();
    const multiplePending = multiple.client.complete({ input: 'context', generation: 1 });
    await open(multiple.socket);
    multiple.socket.emit('message', { data: JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'one' }] }, { type: 'message', content: [{ type: 'output_text', text: 'two' }] }] } }) });
    await expect(multiplePending).resolves.toEqual({ ok: false, code: 'davo_provider_invalid_output' });
  });

  it('times out within the configured bounded deadline', async () => {
    vi.useFakeTimers();
    const { client, socket } = fixture({ deadlineMs: 25 });
    const pending = client.complete({ input: 'context', generation: 1 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({ ok: false, code: 'davo_provider_timeout' });
    expect(socket.closed).toBe(true);
  });
});
