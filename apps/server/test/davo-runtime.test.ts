import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DavoRuntime } from '../src/davo/runtime.js';
import { DavoAdmissionPendingError, DavoStore } from '../src/davo/store.js';
import { IntegrationControlService } from '../src/integrations/control/service.js';
import { RealtimeService } from '../src/integrations/realtime/service.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// assemble real persistence and control around a fake provider boundary
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'davo-runtime-'));
  directories.push(directory);
  let now = Date.parse('2026-11-05T22:00:00.000Z');
  let runtime!: DavoRuntime;
  const store = new DavoStore({
    file: join(directory, 'state.json'),
    now: () => new Date(now),
    onFence: async fence => {
      runtime.fence();
      return runtime.calls.closeFenced(fence.providerCalls);
    }
  });
  const control = new IntegrationControlService(() => 'owner', () => now, 25_000);
  const provider = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/hangup') ? new Response(null, { status: 200 }) : new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_private_test' } }));
  const realtime = new RealtimeService({ apiKey: 'private-key', fetch: async () => new Response(JSON.stringify({ value: 'ek_private_ephemeral_secret' })) });
  runtime = new DavoRuntime({ store, control, realtime, apiKey: 'private-key', fetch: provider, now: () => now, mcpUrl: 'https://rac.example/mcp', instanceId: 'https://rac.example', scopes: ['status:read', 'prompts:write'], allowedTools: () => ['list_agents', 'delegate_request'] });
  return { store, runtime, realtime, provider, advance: (value: string) => { now = Date.parse(value); } };
}

// assert every private negotiation field was erased
function expectNegotiationFenced(runtime: DavoRuntime): void {
  const state = runtime as unknown as Record<string, unknown>;
  expect(state.pending).toBeUndefined();
  expect(state.readiness).toBeUndefined();
  expect(state.descriptor).toBeUndefined();
  expect(state.responseInput).toBeUndefined();
  expect(state.voiceContext).toBeUndefined();
  expect(state.activeVoice).toBeUndefined();
  expect(state.activeOwner).toBeUndefined();
  expect(state.ready).toBe(false);
}

describe('DavoRuntime', () => {
  it('erases private negotiation state after an ambiguous provider create failure', async () => {
    const { runtime, store, provider } = await fixture();
    const snapshot = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_ambiguous_123456789012345', generation: snapshot.generation };
    const opened = await runtime.open('owner', voice);
    provider.mockRejectedValueOnce(new Error('ambiguous provider create'));

    await expect(runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' })).rejects.toThrow('davo_provider_unavailable');
    expectNegotiationFenced(runtime);
    expect(Date.parse((await store.read()).providerQuarantineUntil!)).toBeGreaterThan(Date.parse(snapshot.serverNow));
    expect(() => runtime.acknowledgeReady('owner', { ...voice, readinessId: 'stale', responseId: 'stale', importedTools: ['list_agents', 'delegate_request'] })).toThrow('davo_voice_inactive');
    await expect(runtime.admit('owner', { ...voice, providerSessionId: 'stale', providerItemId: 'stale', text: 'never admit' })).rejects.toThrow();
  });

  it('erases private negotiation state and closes a registered provider after readiness failure', async () => {
    const { runtime, store, provider } = await fixture();
    const snapshot = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_read_fail_123456789012345', generation: snapshot.generation };
    const opened = await runtime.open('owner', voice);
    const read = store.read.bind(store);
    let failRead = false;
    vi.spyOn(store, 'read').mockImplementation(async () => {
      // fail only the readiness read after provider registration
      if (failRead) { failRead = false; throw new Error('readiness store unavailable'); }
      return read();
    });
    provider.mockImplementation(async (url: string | URL | Request) => {
      // preserve exact successful cleanup behavior
      if (String(url).endsWith('/hangup')) return new Response(null, { status: 200 });
      failRead = true;
      return new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_private_test' } });
    });

    await expect(runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' })).rejects.toThrow('readiness store unavailable');
    expectNegotiationFenced(runtime);
    expect(provider.mock.calls.some(([url]) => String(url).endsWith('/hangup'))).toBe(true);
    expect((await store.read()).providerCalls).toEqual([]);
    expect(() => runtime.acknowledgeReady('owner', { ...voice, readinessId: 'stale', responseId: 'stale', importedTools: ['list_agents', 'delegate_request'] })).toThrow('davo_voice_inactive');
  });

  it('requires actual readiness and preserves a newer session after a stale close receipt', async () => {
    const { runtime } = await fixture();
    const snapshot = await runtime.conversation();
    const oldVoice = { voiceSessionId: 'voice_old_12345678901234567890', generation: snapshot.generation };
    const first = await runtime.open('owner', oldVoice);
    const negotiation = await runtime.negotiate('owner', { ...oldVoice, negotiationId: first.negotiationId, sdp: 'v=0\r\noffer' });
    await expect(runtime.admit('owner', { ...oldVoice, providerSessionId: 'session', providerItemId: 'premature', text: 'Do not admit before readiness' })).rejects.toThrow('davo_voice_inactive');
    expect(() => runtime.acknowledgeReady('owner', { ...oldVoice, readinessId: negotiation.readinessId, responseId: 'ready', importedTools: ['list_agents'] })).toThrow('davo_provider_not_ready');
    const current = { ...oldVoice, voiceSessionId: 'voice_new_12345678901234567890' };
    const next = await runtime.open('owner', current);
    const ready = await runtime.negotiate('owner', { ...current, negotiationId: next.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...current, readinessId: ready.readinessId, responseId: 'ready-new', importedTools: ['list_agents', 'delegate_request'] });
    await runtime.stop('owner', oldVoice);
    const accepted = await runtime.admit('owner', { ...current, providerSessionId: 'session-new', providerItemId: 'item-new', text: 'The new session still works.' });
    expect(accepted.ok).toBe(true);
    expect((await runtime.conversation()).messages.map(message => message.text)).toEqual(['The new session still works.']);
    await runtime.stop('owner', current);
  });

  it('requires exact duplicate-free provider readiness tools', async () => {
    const { runtime } = await fixture();
    const snapshot = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_ready_12345678901234567890', generation: snapshot.generation };
    const opened = await runtime.open('owner', voice);
    const negotiated = await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });

    expect(() => runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'ready-extra', importedTools: ['list_agents', 'delegate_request', 'queue_prompt'] })).toThrow('davo_provider_not_ready');
    expect(() => runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'ready-duplicate', importedTools: ['list_agents', 'delegate_request', 'delegate_request'] })).toThrow('davo_provider_not_ready');
    expect(() => runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'ready-missing', importedTools: ['list_agents'] })).toThrow('davo_provider_not_ready');
    expect(runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'ready-exact', importedTools: ['delegate_request', 'list_agents'] })).toEqual({ ok: true });
  });

  it('does not persist a transcript when response preflight rejects it', async () => {
    const { runtime, realtime, store } = await fixture();
    const snapshot = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_preflight_12345678901234567', generation: snapshot.generation };
    const opened = await runtime.open('owner', voice);
    const negotiated = await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'ready', importedTools: ['list_agents', 'delegate_request'] });
    const instructions = vi.spyOn(realtime, 'instructions').mockReturnValue('x'.repeat(50_000));
    const input = { ...voice, providerSessionId: 'provider-session', providerItemId: 'item-preflight', text: 'Do not retain this failed admission.' };

    await expect(runtime.admit('owner', input)).rejects.toThrow('davo_context_capacity');
    expect((await store.read()).messages).toEqual([]);
    instructions.mockRestore();
    await expect(runtime.admit('owner', input)).resolves.toMatchObject({ ok: true });
    expect((await store.read()).messages.map(message => message.text)).toEqual(['Do not retain this failed admission.']);
  });

  it('rechecks lease authority at transcript commit and permits a clean new-session retry', async () => {
    const { runtime, store, advance } = await fixture();
    const snapshot = await runtime.conversation();
    const firstVoice = { voiceSessionId: 'voice_commit_123456789012345678901', generation: snapshot.generation };
    const opened = await runtime.open('owner', firstVoice);
    const negotiated = await runtime.negotiate('owner', { ...firstVoice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...firstVoice, readinessId: negotiated.readinessId, responseId: 'ready', importedTools: ['list_agents', 'delegate_request'] });
    const append = store.appendUserTranscript.bind(store);
    vi.spyOn(store, 'appendUserTranscript').mockImplementationOnce(async input => {
      advance('2026-11-05T22:01:00.000Z');
      return append(input);
    });
    const transcript = { providerSessionId: 'provider-retry', providerItemId: 'item-retry', text: 'Commit only with live authority.' };

    await expect(runtime.admit('owner', { ...firstVoice, ...transcript })).rejects.toThrow('davo_voice_inactive');
    expect((await store.read()).messages).toEqual([]);
    const nextVoice = { ...firstVoice, voiceSessionId: 'voice_retry_1234567890123456789012' };
    const next = await runtime.open('owner', nextVoice);
    const ready = await runtime.negotiate('owner', { ...nextVoice, negotiationId: next.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...nextVoice, readinessId: ready.readinessId, responseId: 'ready-next', importedTools: ['list_agents', 'delegate_request'] });
    await expect(runtime.admit('owner', { ...nextVoice, ...transcript })).resolves.toMatchObject({ ok: true });
    expect((await store.read()).messages.map(message => message.text)).toEqual(['Commit only with live authority.']);
  });

  it('returns no inference authority while exact transcript recovery is pending', async () => {
    const { runtime, store } = await fixture();
    const snapshot = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_pending_123456789012345678', generation: snapshot.generation };
    const opened = await runtime.open('owner', voice);
    const negotiated = await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'ready', importedTools: ['list_agents', 'delegate_request'] });
    vi.spyOn(store, 'appendUserTranscript').mockImplementationOnce(async input => { throw new DavoAdmissionPendingError(input.id!); });

    const receipt = await runtime.admit('owner', { ...voice, providerSessionId: 'provider-pending', providerItemId: 'item-pending', text: 'Wait for durable recovery.' });
    expect(receipt).toEqual({ ok: true, pending: true, messageId: expect.stringMatching(/^davo-user-[a-f0-9]{64}$/u), generation: voice.generation });
    expect(receipt).not.toHaveProperty('turnId');
    expect(receipt).not.toHaveProperty('response');
    expectNegotiationFenced(runtime);
    expect((await store.read()).messages).toEqual([]);
  });

  it('keeps provider authority private and persists chat across transport replacement', async () => {
    const { runtime, store } = await fixture();
    const conversation = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_123456789012345678901234', generation: conversation.generation };
    const opened = await runtime.open('owner', voice);
    expect(JSON.stringify(opened)).not.toMatch(/ek_private|clientSecret|callId|rtc_private/u);
    const answer = await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    expect(answer).toMatchObject({ ok: true, sdp: 'v=0\r\nanswer', generation: voice.generation });
    expect(answer.readinessResponse.tool_choice).toBe('none');
    expect(Buffer.byteLength(JSON.stringify(answer.readinessResponse))).toBeLessThanOrEqual(40960);
    runtime.acknowledgeReady('owner', { ...voice, readinessId: answer.readinessId, responseId: 'readiness-response', importedTools: ['list_agents', 'delegate_request'] });
    expect((await store.read()).providerCalls).toHaveLength(1);
    const receipt = await runtime.admit('owner', { ...voice, providerSessionId: 'provider-session', providerItemId: 'item-1', text: 'Inspect this worktree.' });
    expect(receipt.response.conversation).toBe('none');
    expect(receipt.response.instructions).toContain('turn_capability');
    await expect(runtime.admit('owner', { ...voice, providerSessionId: 'provider-session', providerItemId: 'item-2', text: 'Overlapping text' })).rejects.toThrow('davo_response_active');
    expect((await store.read()).messages).toHaveLength(1);
    runtime.bind('owner', { ...voice, turnId: receipt.turnId, responseId: 'response-1' });
    await expect(runtime.assistant('owner', { ...voice, turnId: receipt.turnId, responseId: 'response-1', messageId: 'wrong', text: 'Wrong anchor' })).rejects.toThrow('davo_turn_changed');
    await runtime.assistant('owner', { ...voice, turnId: receipt.turnId, responseId: 'response-1', messageId: receipt.messageId, text: 'I will inspect it.' });
    runtime.finish('owner', { ...voice, turnId: receipt.turnId, responseId: 'response-1' });
    await runtime.stop('owner', voice);
    const after = await runtime.conversation();
    expect(after.conversationId).toBe(conversation.conversationId);
    expect(after.messages.map(row => row.text)).toEqual(['Inspect this worktree.', 'I will inspect it.']);
    expect(JSON.stringify(after)).not.toMatch(/provider-session|item-1|response-1|rtc_private|ek_private/u);
  });

  it('fences expired chat and hangs up without a browser heartbeat', async () => {
    const { runtime, advance, provider, store } = await fixture();
    const first = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_123456789012345678901234', generation: first.generation };
    const opened = await runtime.open('owner', voice);
    const negotiated = await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'readiness-response', importedTools: ['list_agents', 'delegate_request'] });
    const receipt = await runtime.admit('owner', { ...voice, providerSessionId: 'session', providerItemId: 'item', text: 'Forget this later' });
    advance('2026-11-09T11:00:00.000Z');
    await runtime.tick();
    const after = await runtime.conversation();
    expect(after.messages).toEqual([]);
    expect(after.conversationId).toBe(first.conversationId);
    expect(after.generation).toBeGreaterThan(first.generation);
    expect((await store.read()).providerCalls).toEqual([]);
    expect(provider.mock.calls.some(([url]) => String(url).endsWith('/hangup'))).toBe(true);
    expect(() => runtime.bind('owner', { ...voice, turnId: receipt.turnId, responseId: 'late' })).toThrow();
  });
});
