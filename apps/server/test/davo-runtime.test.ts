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
async function fixture(allowedTools = ['list_agents', 'delegate_request']) {
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
  // accept canonical fixture worktree selections
  const selectWorktree = async () => true;
  runtime = new DavoRuntime({ store, control, realtime, apiKey: 'private-key', fetch: provider, now: () => now, mcpUrl: 'https://rac.example/mcp', instanceId: 'https://rac.example', scopes: ['status:read', 'prompts:write'], allowedTools: () => allowedTools, selectWorktree });
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
  it('surfaces structured provider recovery failures and keeps provider creation blocked', async () => {
    const { runtime, store, provider } = await fixture();
    const generation = (await store.read()).retention.generation;
    await store.transact(state => {
      state.providerCalls.push({
        voiceSessionId: 'voice_recovery_123456789012345', generation, ownerHash: 'a'.repeat(64), callId: 'rtc_recovery123',
        createdAt: '2026-11-05T22:00:00.000Z', hardCutoffAt: '2026-11-06T11:00:00.000Z', providerMaximumEndsAt: '2026-11-05T23:00:00.000Z',
        hangup: { state: 'dispatching', attemptId: 'attempt-recovery', attemptedAt: '2026-11-05T22:00:01.000Z', definitelyNotSentRetries: 0 }
      });
    });

    const recoveryFailure = await runtime.recover().then(() => undefined, error => error as Error);
    expect(recoveryFailure).toEqual(expect.objectContaining({ message: 'davo_provider_hangup_ambiguous' }));
    expect(runtime.status().counters.provider_quarantines).toBe(0);
    runtime.recordFailure(recoveryFailure);
    expect(runtime.status().counters.provider_quarantines).toBe(1);
    expect((await store.read())).toMatchObject({ providerCalls: [], providerQuarantineUntil: '2026-11-05T23:00:00.000Z' });
    const voice = { voiceSessionId: 'voice_after_recovery_1234567890', generation };
    const opened = await runtime.open('owner', voice);
    await expect(runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' })).rejects.toThrow('davo_provider_hangup_ambiguous');
    expect(provider).not.toHaveBeenCalled();
  });

  it('surfaces persisted and process-local provider quarantine without clearing it', async () => {
    const persisted = await fixture();
    const generation = (await persisted.store.read()).retention.generation;
    await persisted.store.transact(state => { state.providerQuarantineUntil = '2026-11-05T23:00:00.000Z'; });
    await expect(persisted.runtime.recover()).rejects.toThrow('davo_provider_hangup_ambiguous');
    expect((await persisted.store.read()).providerQuarantineUntil).toBe('2026-11-05T23:00:00.000Z');
    const persistedVoice = { voiceSessionId: 'voice_persisted_quarantine_12345', generation };
    const opened = await persisted.runtime.open('owner', persistedVoice);
    await expect(persisted.runtime.negotiate('owner', { ...persistedVoice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' })).rejects.toThrow('davo_provider_hangup_ambiguous');
    expect(persisted.provider).not.toHaveBeenCalled();

    const memory = await fixture();
    (memory.runtime.calls as unknown as { memoryQuarantineUntil: number }).memoryQuarantineUntil = Date.parse('2026-11-05T23:00:00.000Z');
    await expect(memory.runtime.recover()).rejects.toThrow('davo_store_unavailable');
    expect((memory.runtime.calls as unknown as { memoryQuarantineUntil: number }).memoryQuarantineUntil).toBe(Date.parse('2026-11-05T23:00:00.000Z'));
    const memoryGeneration = (await memory.store.read()).retention.generation;
    const memoryVoice = { voiceSessionId: 'voice_memory_quarantine_1234567', generation: memoryGeneration };
    const memoryOpened = await memory.runtime.open('owner', memoryVoice);
    await expect(memory.runtime.negotiate('owner', { ...memoryVoice, negotiationId: memoryOpened.negotiationId, sdp: 'v=0\r\noffer' })).rejects.toThrow('davo_store_unavailable');
    expect(memory.provider).not.toHaveBeenCalled();
  });

  it('keeps successful provider recovery unchanged', async () => {
    const { runtime } = await fixture();
    await expect(runtime.recover()).resolves.toBeUndefined();
  });

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
    expect(negotiation.readinessResponse.max_output_tokens).toBe(256);
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

  // surface exact provider uncertainty after local revocation
  it('reports ambiguous provider cleanup after revoking the exact voice session', async () => {
    const { runtime, store, provider } = await fixture();
    const snapshot = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_stop_fail_123456789012345', generation: snapshot.generation };
    const opened = await runtime.open('owner', voice);
    await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    provider.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(runtime.stop('owner', voice)).rejects.toThrow('davo_provider_hangup_ambiguous');
    expectNegotiationFenced(runtime);
    expect((await store.read())).toMatchObject({ providerCalls: [], providerQuarantineUntil: expect.any(String) });
    const callsAfterFailure = provider.mock.calls.length;
    await expect(runtime.stop('owner', voice)).resolves.toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(callsAfterFailure);
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

  // accept an exact empty import without weakening nonempty catalog matching
  it('accepts empty readiness only when the expected MCP catalog is empty', async () => {
    const empty = await fixture([]);
    const emptySnapshot = await empty.runtime.conversation();
    const emptyVoice = { voiceSessionId: 'voice_empty_1234567890123456789', generation: emptySnapshot.generation };
    const emptyOpened = await empty.runtime.open('owner', emptyVoice);
    const emptyNegotiated = await empty.runtime.negotiate('owner', { ...emptyVoice, negotiationId: emptyOpened.negotiationId, sdp: 'v=0\r\noffer' });
    expect(emptyNegotiated.readinessResponse.tools[0]).toMatchObject({ type: 'mcp', allowed_tools: [] });
    expect(empty.runtime.acknowledgeReady('owner', { ...emptyVoice, readinessId: emptyNegotiated.readinessId, responseId: 'ready-empty', importedTools: [] })).toEqual({ ok: true });

    const nonempty = await fixture();
    const nonemptySnapshot = await nonempty.runtime.conversation();
    const nonemptyVoice = { voiceSessionId: 'voice_nonempty_1234567890123456', generation: nonemptySnapshot.generation };
    const nonemptyOpened = await nonempty.runtime.open('owner', nonemptyVoice);
    const nonemptyNegotiated = await nonempty.runtime.negotiate('owner', { ...nonemptyVoice, negotiationId: nonemptyOpened.negotiationId, sdp: 'v=0\r\noffer' });
    expect(() => nonempty.runtime.acknowledgeReady('owner', { ...nonemptyVoice, readinessId: nonemptyNegotiated.readinessId, responseId: 'forged-empty', importedTools: [] })).toThrow('davo_provider_not_ready');
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
    expect(receipt.response.instructions).toContain('Lead with one short sentence per relevant project or worktree');
    expect(receipt.response.instructions).toContain('After gathering enough evidence for the original request');
    expect(receipt.response.instructions).not.toContain('After a tool call, report its result');
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

  it('continues completed mcp calls from bounded provider item references', async () => {
    const { runtime } = await fixture();
    const conversation = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_mcp_continue_1234567890123', generation: conversation.generation };
    const opened = await runtime.open('owner', voice);
    const answer = await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...voice, readinessId: answer.readinessId, responseId: 'readiness-response', importedTools: ['list_agents', 'delegate_request'] });
    const admitted = await runtime.admit('owner', { ...voice, providerSessionId: 'provider-session', providerItemId: 'item-mcp', text: 'Inspect every worktree.' });
    runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-1' });

    // fill one maximum-size provider continuation
    const firstIds = Array.from({ length: 16 }, (_, index) => `mcp-item-${index}`);
    const first = await runtime.continueMcp('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-1', itemIds: firstIds });
    expect(first.response).toMatchObject({ conversation: 'none', input: expect.arrayContaining(firstIds.map(id => ({ type: 'item_reference', id }))), output_modalities: ['audio'] });
    expect(JSON.stringify(first.response)).not.toContain('tool output text');
    expect(first.response.instructions).not.toBe(admitted.response.instructions);
    expect(first.response.instructions).toContain('After gathering enough evidence for the original request');
    expect(first.response.instructions).toContain('Do not stop at discovery metadata when the request needs task or change evidence');
    expect(first.response.instructions).toContain('Lead with one short sentence per relevant project or worktree');
    expect(first.response.instructions).not.toContain('After a tool call, report its result');
    runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-2' });

    await expect(runtime.continueMcp('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-2', itemIds: [firstIds[0]!] })).rejects.toThrow('davo_turn_changed');
    await expect(runtime.continueMcp('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-2', itemIds: ['duplicate', 'duplicate'] })).rejects.toThrow('davo_turn_changed');
    // reach the complete per-turn reference ceiling
    const secondIds = Array.from({ length: 16 }, (_, index) => `mcp-item-${index + 16}`);
    const second = await runtime.continueMcp('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-2', itemIds: secondIds });
    expect((second.response.input as Array<Record<string, unknown>>).filter(item => item.type === 'item_reference')).toHaveLength(32);
    runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-3' });
    await expect(runtime.continueMcp('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-3', itemIds: ['mcp-item-over-cap'] })).rejects.toThrow('davo_context_capacity');
    runtime.finish('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-3' });
  });

  it('keeps mcp references outside the bounded local selection budget', async () => {
    const { runtime } = await fixture();
    const conversation = await runtime.conversation();
    const voice = { voiceSessionId: 'voice_mcp_select_123456789012345', generation: conversation.generation };
    const opened = await runtime.open('owner', voice);
    const answer = await runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    runtime.acknowledgeReady('owner', { ...voice, readinessId: answer.readinessId, responseId: 'readiness-response', importedTools: ['list_agents', 'delegate_request'] });
    const admitted = await runtime.admit('owner', { ...voice, providerSessionId: 'provider-session', providerItemId: 'item-mcp-select', text: 'Inspect and select this worktree.' });
    runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-mcp' });
    // fill one complete mcp continuation batch before local selection
    const itemIds = Array.from({ length: 16 }, (_, index) => `mcp-select-item-${index}`);
    await runtime.continueMcp('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-mcp', itemIds });
    runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-select-0' });
    let selected = await runtime.continue('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-select-0', callId: 'select-call-0', worktreeId: 'worktree-0' });

    // permit the remaining four historical local selections
    for (let index = 1; index < 5; index += 1) {
      const responseId = `response-select-${index}`;
      runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId });
      selected = await runtime.continue('owner', { ...voice, turnId: admitted.turnId, responseId, callId: `select-call-${index}`, worktreeId: `worktree-${index}` });
    }
    const responseInput = selected.response.input as Array<Record<string, unknown>>;
    expect(responseInput.filter(item => item.type === 'item_reference')).toHaveLength(16);
    expect(responseInput.filter(item => item.type === 'function_call' && item.name === 'select_worktree')).toHaveLength(5);
    runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-select-5' });
    await expect(runtime.continue('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-select-5', callId: 'select-call-5', worktreeId: 'worktree-5' })).rejects.toThrow('davo_target_changed');
    runtime.finish('owner', { ...voice, turnId: admitted.turnId, responseId: 'response-select-5' });
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
