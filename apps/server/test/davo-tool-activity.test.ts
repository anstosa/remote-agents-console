import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAVO_REQUEST_MAX_COUNT, DAVO_STATE_MAX_BYTES, davoMessageSchema, utf8Bytes } from '../src/davo/contracts.js';
import { activityEpoch } from '../src/davo/continuation.js';
import { DavoCoordinator } from '../src/davo/coordinator.js';
import { expiryForAnchor } from '../src/davo/retention.js';
import { DavoRuntime } from '../src/davo/runtime.js';
import { DavoStore } from '../src/davo/store.js';
import { davoMcpActivityText } from '../src/davo/tool-activity.js';
import { IntegrationControlService } from '../src/integrations/control/service.js';
import type { RealtimeService } from '../src/integrations/realtime/service.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// assemble one admitted turn without contacting the provider
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'davo-activity-'));
  directories.push(directory);
  let now = Date.parse('2026-11-06T20:00:00.000Z');
  const store = new DavoStore({ file: join(directory, 'state.json'), now: () => new Date(now) });
  const control = new IntegrationControlService(() => 'owner', () => now, 60_000);
  const runtime = new DavoRuntime({ store, control, realtime: {} as RealtimeService, mcpUrl: 'https://rac.example/mcp', instanceId: 'https://rac.example', scopes: ['status:read'], allowedTools: () => [], now: () => now });
  const state = await store.read();
  const voiceSessionId = 'voice_activity_123456789012345';
  const credential = control.startVoiceLease('owner', voiceSessionId, ['status:read'])!;
  const user = await store.appendUserTranscript({ generation: state.retention.generation, voiceSessionId, providerSessionId: 'provider-session', providerItemId: 'provider-item', text: 'Read my notes.' });
  runtime.live.open({ voiceSessionId, leaseKey: credential.leaseKey, ownerHash: 'a'.repeat(64), generation: state.retention.generation, hardCutoffAt: now + 60_000 });
  const turn = runtime.live.admit({ voiceSessionId, generation: state.retention.generation, messageId: user.id, providerItemId: 'provider-item' });
  return { store, runtime, credential, user, turn, voiceSessionId, generation: state.retention.generation, advance: (milliseconds: number) => { now += milliseconds; } };
}

// consume every unreserved byte without changing activity provenance
async function fillReservedCapacity(store: DavoStore): Promise<void> {
  await store.transact(state => {
    const activity = state.messages.find(message => message.kind === 'status' && message.source.kind === 'mcp-activity');
    const original = state.messages.find(message => message.kind === 'user');
    if (activity === undefined || activity.kind !== 'status' || activity.source.kind !== 'mcp-activity' || original === undefined) throw new Error('activity fixture missing');
    const currentBytes = utf8Bytes(JSON.stringify(activity));
    const maximumBytes = Math.max(...(['interrupted', 'succeeded', 'failed', 'unknown'] as const).map(phase => utf8Bytes(JSON.stringify({ ...activity, text: davoMcpActivityText(activity.source.tool, phase), source: { ...activity.source, phase } }))));
    const reservedDelta = maximumBytes - currentBytes;
    // leave bounded bookkeeping slack before the exact final adjustment
    let available = DAVO_STATE_MAX_BYTES - reservedDelta - utf8Bytes(JSON.stringify(state)) - 64;
    let index = 0;
    // fill with valid bounded assistant rows using exact json deltas
    while (available > 0) {
      const base = {
        sequence: state.nextSequence,
        id: `capacity-${index}`,
        conversationId: state.logicalConversationId,
        generation: state.retention.generation,
        createdAt: original.createdAt,
        localDate: original.localDate,
        retentionAnchorAt: original.retentionAnchorAt,
        retentionAnchorLocalDate: original.retentionAnchorLocalDate,
        kind: 'assistant' as const,
        text: 'x',
        source: { kind: 'assistant-final' as const, voiceSessionId: original.source.kind === 'user-transcript' ? original.source.voiceSessionId : 'voice', responseId: `capacity-response-${index}`, inReplyToMessageId: original.id }
      };
      const fixed = utf8Bytes(JSON.stringify(base)) + 1;
      // leave a sub-message remainder when no valid row fits
      if (available < fixed) break;
      const textLength = Math.min(47_000, available - fixed + 1);
      state.messages.push({ ...base, text: 'x'.repeat(textLength) });
      state.nextSequence += 1;
      available -= fixed + textLength - 1;
      index += 1;
    }
    const last = state.messages.at(-1);
    if (last === undefined || last.kind !== 'assistant') throw new Error('capacity filler missing');
    const gap = DAVO_STATE_MAX_BYTES - reservedDelta - utf8Bytes(JSON.stringify(state));
    // end at the exact virtual cap so one physical byte remains reservation-sensitive
    if (gap < 0 || gap > 64) throw new Error('capacity filler drift');
    last.text += 'x'.repeat(gap);
  });
}

describe('Davo MCP activity', () => {
  it('uses fixed safe copy for known tools and bounded copy for future tools', () => {
    expect(davoMcpActivityText('list_notes', 'running')).toBe('Reading notes...');
    expect(davoMcpActivityText('get_note', 'succeeded')).toBe('Read notes.');
    expect(davoMcpActivityText('queue_prompt', 'running')).toBe('Queuing prompt...');
    expect(davoMcpActivityText('queue_prompt', 'succeeded')).toBe('Queued prompt.');
    expect(davoMcpActivityText('get_worktree_status', 'running')).toBe('Reading worktree status...');
    expect(davoMcpActivityText('../../private', 'running')).toBe('Working on request...');
  });

  it('parses legacy request statuses and the new typed activity source', () => {
    const base = { sequence: 2, id: 'status-1', conversationId: 'conversation-1', generation: 1, createdAt: '2026-11-06T20:00:01.000Z', localDate: '2026-11-06', retentionAnchorAt: '2026-11-06T20:00:00.000Z', retentionAnchorLocalDate: '2026-11-06', kind: 'status' as const, text: 'Working.' };
    expect(davoMessageSchema.safeParse({ ...base, requestId: 'request-1', source: { kind: 'request-status', statusKey: 'dispatch' } }).success).toBe(true);
    expect(davoMessageSchema.safeParse({ ...base, source: { kind: 'mcp-activity', correlationId: 'correlation-1', tool: 'list_notes', phase: 'running', voiceSessionId: 'voice-1', inReplyToMessageId: 'message-1' } }).success).toBe(true);
  });

  it('updates one stable row in place and reports actual working state', async () => {
    const { runtime, store, credential, user, turn, voiceSessionId, generation } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-1', tool: 'list_notes', leaseKey: credential.leaseKey });
    const running = (await store.read()).messages[1]!;
    expect(handle).toBe(running.id);
    expect(running).toMatchObject({ sequence: 2, createdAt: '2026-11-06T20:00:00.000Z', retentionAnchorAt: user.createdAt, text: 'Reading notes...', source: { phase: 'running' } });
    expect((await runtime.conversation()).working).toBe(true);

    await runtime.finishMcpActivity(handle!, { correlationId: 'correlation-1', tool: 'list_notes', outcome: 'success' });
    const finished = (await store.read()).messages[1]!;
    expect(finished).toMatchObject({ id: running.id, sequence: running.sequence, createdAt: running.createdAt, retentionAnchorAt: user.createdAt, text: 'Read notes.', source: { phase: 'succeeded' } });
    await runtime.finishMcpActivity(handle!, { correlationId: 'correlation-1', tool: 'list_notes', outcome: 'error' });
    expect((await store.read()).messages[1]).toEqual(finished);
    runtime.live.finish(voiceSessionId, generation, turn.id);
    expect((await runtime.conversation()).working).toBe(false);
  });

  it('requires the exact live lease and admitted retained user anchor', async () => {
    const { runtime, store, credential } = await fixture();
    expect(await runtime.startMcpActivity({ correlationId: 'wrong-lease', tool: 'list_notes', leaseKey: 'wrong' })).toBeUndefined();
    expect((await store.read()).messages).toHaveLength(1);
    runtime.live.close();
    expect(await runtime.startMcpActivity({ correlationId: 'closed', tool: 'list_notes', leaseKey: credential.leaseKey })).toBeUndefined();
    expect((await store.read()).messages).toHaveLength(1);
  });

  it('keeps no-turn reads compatible but fails closed after an observed anchor disappears', async () => {
    const noTurn = await fixture();
    noTurn.runtime.live.finish(noTurn.voiceSessionId, noTurn.generation, noTurn.turn.id);
    await expect(noTurn.runtime.startMcpActivity({ correlationId: 'no-turn', tool: 'list_notes', leaseKey: noTurn.credential.leaseKey })).resolves.toBeUndefined();

    const missing = await fixture();
    await missing.store.transact(state => { state.messages = []; });
    await expect(missing.runtime.startMcpActivity({ correlationId: 'missing-anchor', tool: 'list_notes', leaseKey: missing.credential.leaseKey })).rejects.toThrow('davo_activity_unavailable');
    expect((await missing.store.read()).messages).toEqual([]);
    expect((missing.runtime as unknown as { mcpActivitySlots: Map<string, unknown> }).mcpActivitySlots.has('missing-anchor')).toBe(false);

    const mismatched = await fixture();
    await mismatched.store.transact(state => {
      const user = state.messages[0];
      if (user?.kind !== 'user') throw new Error('user fixture missing');
      user.source.voiceSessionId = 'different-voice';
    });
    await expect(mismatched.runtime.startMcpActivity({ correlationId: 'mismatched-anchor', tool: 'list_notes', leaseKey: mismatched.credential.leaseKey })).rejects.toThrow('davo_activity_unavailable');
    expect((await mismatched.store.read()).messages).toHaveLength(1);
    expect((mismatched.runtime as unknown as { mcpActivitySlots: Map<string, unknown> }).mcpActivitySlots.has('mismatched-anchor')).toBe(false);
  });

  it('retries only a transient terminal receipt write', async () => {
    const { runtime, store, credential } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-retry', tool: 'list_notes', leaseKey: credential.leaseKey });
    const transact = store.transact.bind(store);
    let failed = false;
    vi.spyOn(store, 'transact').mockImplementation(async mutation => {
      // fail only the first terminal receipt attempt
      if (!failed) { failed = true; throw new Error('transient disk fault'); }
      return await transact(mutation);
    });
    await expect(runtime.finishMcpActivity(handle!, { correlationId: 'correlation-retry', tool: 'list_notes', outcome: 'success' })).resolves.toBeUndefined();
    expect((await store.read()).messages[1]).toMatchObject({ text: 'Read notes.', source: { phase: 'succeeded' } });
  });

  it('reconciles persistent terminal receipt failures through bounded runtime ticks while idle', async () => {
    const { runtime, store, credential, turn, voiceSessionId, generation } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-persistent', tool: 'list_notes', leaseKey: credential.leaseKey });
    const transact = store.transact.bind(store);
    let failures = 3;
    vi.spyOn(store, 'transact').mockImplementation(async mutation => {
      // fail two immediate writes and one scheduled reconciliation
      if (failures > 0) { failures -= 1; throw new Error('persistent receipt fault'); }
      return await transact(mutation);
    });
    await expect(runtime.finishMcpActivity(handle!, { correlationId: 'correlation-persistent', tool: 'list_notes', outcome: 'success' })).rejects.toThrow('persistent receipt fault');
    runtime.live.finish(voiceSessionId, generation, turn.id);
    expect((await runtime.conversation()).working).toBe(false);
    expect((await store.read()).messages[1]).toMatchObject({ id: handle, source: { phase: 'running' } });
    await runtime.tick();
    expect((await store.read()).messages[1]).toMatchObject({ id: handle, source: { phase: 'running' } });
    await runtime.tick();
    expect((await store.read()).messages[1]).toMatchObject({ id: handle, text: 'Read notes.', source: { phase: 'succeeded' } });
    expect((runtime as unknown as { pendingMcpReceipts: Map<string, unknown> }).pendingMcpReceipts.size).toBe(0);
  });

  it('drops missing reconciliation rows without resurrection', async () => {
    const { runtime, store, credential } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-missing', tool: 'list_notes', leaseKey: credential.leaseKey });
    const transact = store.transact.bind(store);
    const write = vi.spyOn(store, 'transact').mockRejectedValue(new Error('receipt store unavailable'));
    await expect(runtime.finishMcpActivity(handle!, { correlationId: 'correlation-missing', tool: 'list_notes', outcome: 'error' })).rejects.toThrow('receipt store unavailable');
    write.mockRestore();
    await transact(state => { state.messages = state.messages.filter(message => message.id !== handle); });
    await runtime.tick();
    expect((await store.read()).messages.some(message => message.id === handle)).toBe(false);
    expect((runtime as unknown as { pendingMcpReceipts: Map<string, unknown> }).pendingMcpReceipts.size).toBe(0);
  });

  it('rejects activity before persistence when every reconciliation slot is reserved', async () => {
    const { runtime, store, credential } = await fixture();
    const internals = runtime as unknown as { mcpActivitySlots: Map<string, unknown> };
    // occupy every slot with a durable running receipt
    for (let index = 0; index < DAVO_REQUEST_MAX_COUNT; index += 1) {
      await runtime.startMcpActivity({ correlationId: `reserved-${index}`, tool: 'list_notes', leaseKey: credential.leaseKey });
    }
    const retainedCount = (await store.read()).messages.length;
    await expect(runtime.startMcpActivity({ correlationId: 'correlation-overflow', tool: 'list_notes', leaseKey: credential.leaseKey })).rejects.toThrow('davo_capacity');
    expect((await store.read()).messages).toHaveLength(retainedCount);
    expect(internals.mcpActivitySlots.size).toBe(DAVO_REQUEST_MAX_COUNT);
  });

  it('admits only one parallel activity at the last reconciliation slot', async () => {
    const { runtime, store, credential } = await fixture();
    const internals = runtime as unknown as { mcpActivitySlots: Map<string, unknown> };
    // leave one slot before either start reaches persistence
    for (let index = 0; index < DAVO_REQUEST_MAX_COUNT - 1; index += 1) internals.mcpActivitySlots.set(`reserved-${index}`, {});
    const transact = store.transact.bind(store);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(store, 'transact').mockImplementationOnce(async mutation => {
      await gate;
      return await transact(mutation);
    });
    const admitted = runtime.startMcpActivity({ correlationId: 'correlation-admitted', tool: 'list_notes', leaseKey: credential.leaseKey });
    await Promise.resolve();
    await expect(runtime.startMcpActivity({ correlationId: 'correlation-rejected', tool: 'list_notes', leaseKey: credential.leaseKey })).rejects.toThrow('davo_capacity');
    release();
    await expect(admitted).resolves.toEqual(expect.any(String));
    expect((await store.read()).messages.filter(message => message.kind === 'status')).toHaveLength(1);
    expect(internals.mcpActivitySlots.size).toBe(DAVO_REQUEST_MAX_COUNT);
  });

  it('rolls back a reserved slot when activity persistence fails', async () => {
    const { runtime, store, credential } = await fixture();
    const internals = runtime as unknown as { mcpActivitySlots: Map<string, unknown> };
    // leave one slot so rollback is observable at the cap frontier
    for (let index = 0; index < DAVO_REQUEST_MAX_COUNT - 1; index += 1) internals.mcpActivitySlots.set(`reserved-${index}`, {});
    vi.spyOn(store, 'transact').mockRejectedValueOnce(new Error('activity store unavailable'));
    await expect(runtime.startMcpActivity({ correlationId: 'correlation-rollback', tool: 'list_notes', leaseKey: credential.leaseKey })).rejects.toThrow('activity store unavailable');
    expect(internals.mcpActivitySlots.has('correlation-rollback')).toBe(false);
    expect(internals.mcpActivitySlots.size).toBe(DAVO_REQUEST_MAX_COUNT - 1);
    expect((await store.read()).messages).toHaveLength(1);
  });

  it('does not revive a deferred activity reservation after a session fence', async () => {
    const { runtime, store, credential } = await fixture();
    const internals = runtime as unknown as { mcpActivitySlots: Map<string, unknown>; pendingMcpReceipts: Map<string, unknown>; mcpActivityRegistrations: Map<string, unknown> };
    const transact = store.transact.bind(store);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(store, 'transact').mockImplementationOnce(async mutation => {
      await gate;
      return await transact(mutation);
    });
    const start = runtime.startMcpActivity({ correlationId: 'correlation-deferred', tool: 'list_notes', leaseKey: credential.leaseKey });
    await Promise.resolve();
    expect(internals.mcpActivitySlots.has('correlation-deferred')).toBe(true);
    runtime.fence();
    release();
    await expect(start).rejects.toThrow('davo_activity_unavailable');
    expect(internals.mcpActivitySlots.size).toBe(0);
    expect(internals.pendingMcpReceipts.size).toBe(0);
    expect(internals.mcpActivityRegistrations.size).toBe(0);
    expect((await store.read()).messages.find(message => message.kind === 'status')).toMatchObject({ source: { phase: 'interrupted' } });
  });

  it('does not let an old finish release a same-correlation successor start', async () => {
    const { runtime, store, credential, user, voiceSessionId, generation } = await fixture();
    const correlationId = 'correlation-finish-race';
    const oldHandle = await runtime.startMcpActivity({ correlationId, tool: 'list_notes', leaseKey: credential.leaseKey });
    const transact = store.transact.bind(store);
    let enterOld!: () => void;
    let releaseOld!: () => void;
    const oldEntered = new Promise<void>(resolve => { enterOld = resolve; });
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const write = vi.spyOn(store, 'transact').mockImplementationOnce(async mutation => {
      enterOld();
      await oldGate;
      return await transact(mutation);
    });
    const oldFinish = runtime.finishMcpActivity(oldHandle!, { correlationId, tool: 'list_notes', outcome: 'success' });
    await oldEntered;
    runtime.fence();
    await runtime.recover();
    await transact(state => { state.messages = state.messages.filter(message => message.id !== oldHandle); });
    runtime.live.open({ voiceSessionId, leaseKey: credential.leaseKey, ownerHash: 'a'.repeat(64), generation, hardCutoffAt: Date.parse('2026-11-06T20:01:00.000Z') });
    runtime.live.admit({ voiceSessionId, generation, messageId: user.id, providerItemId: 'provider-successor-finish' });
    let enterSuccessor!: () => void;
    let releaseSuccessor!: () => void;
    const successorEntered = new Promise<void>(resolve => { enterSuccessor = resolve; });
    const successorGate = new Promise<void>(resolve => { releaseSuccessor = resolve; });
    write.mockImplementationOnce(async mutation => {
      enterSuccessor();
      await successorGate;
      return await transact(mutation);
    });
    const successorStart = runtime.startMcpActivity({ correlationId, tool: 'list_notes', leaseKey: credential.leaseKey });
    await successorEntered;
    releaseOld();
    await expect(oldFinish).resolves.toBeUndefined();
    const internals = runtime as unknown as { mcpActivitySlots: Map<string, unknown>; mcpActivityRegistrations: Map<string, { handle: string }> };
    expect(internals.mcpActivitySlots.has(correlationId)).toBe(true);
    releaseSuccessor();
    const successorHandle = await successorStart;
    expect(internals.mcpActivityRegistrations.get(correlationId)?.handle).toBe(successorHandle);
    await runtime.finishMcpActivity(successorHandle!, { correlationId, tool: 'list_notes', outcome: 'success' });
    expect((await store.read()).messages.find(message => message.id === successorHandle)).toMatchObject({ source: { phase: 'succeeded' } });
  });

  it('does not let old reconciliation release a same-correlation successor', async () => {
    const { runtime, store, credential, user, voiceSessionId, generation } = await fixture();
    const correlationId = 'correlation-reconcile-race';
    const oldHandle = await runtime.startMcpActivity({ correlationId, tool: 'list_notes', leaseKey: credential.leaseKey });
    const write = vi.spyOn(store, 'transact').mockRejectedValue(new Error('receipt store unavailable'));
    await expect(runtime.finishMcpActivity(oldHandle!, { correlationId, tool: 'list_notes', outcome: 'success' })).rejects.toThrow('receipt store unavailable');
    write.mockRestore();
    const transact = store.transact.bind(store);
    let enterReconcile!: () => void;
    let releaseReconcile!: () => void;
    const reconcileEntered = new Promise<void>(resolve => { enterReconcile = resolve; });
    const reconcileGate = new Promise<void>(resolve => { releaseReconcile = resolve; });
    vi.spyOn(store, 'transact').mockImplementationOnce(async mutation => {
      enterReconcile();
      await reconcileGate;
      return await transact(mutation);
    });
    const reconciling = (runtime as unknown as { reconcileMcpActivities(): Promise<void> }).reconcileMcpActivities();
    await reconcileEntered;
    runtime.fence();
    await runtime.recover();
    await transact(state => { state.messages = state.messages.filter(message => message.id !== oldHandle); });
    runtime.live.open({ voiceSessionId, leaseKey: credential.leaseKey, ownerHash: 'a'.repeat(64), generation, hardCutoffAt: Date.parse('2026-11-06T20:01:00.000Z') });
    runtime.live.admit({ voiceSessionId, generation, messageId: user.id, providerItemId: 'provider-successor-reconcile' });
    const successorHandle = await runtime.startMcpActivity({ correlationId, tool: 'list_notes', leaseKey: credential.leaseKey });
    releaseReconcile();
    await reconciling;
    const internals = runtime as unknown as { mcpActivitySlots: Map<string, unknown>; mcpActivityRegistrations: Map<string, { handle: string }> };
    expect(internals.mcpActivitySlots.has(correlationId)).toBe(true);
    expect(internals.mcpActivityRegistrations.get(correlationId)?.handle).toBe(successorHandle);
    await runtime.finishMcpActivity(successorHandle!, { correlationId, tool: 'list_notes', outcome: 'success' });
    expect((await store.read()).messages.find(message => message.id === successorHandle)).toMatchObject({ source: { phase: 'succeeded' } });
  });

  it('clears terminal reconciliation reservations at the session fence', async () => {
    const fenced = await fixture();
    const fencedHandle = await fenced.runtime.startMcpActivity({ correlationId: 'correlation-fenced', tool: 'queue_prompt', leaseKey: fenced.credential.leaseKey });
    const fencedWrite = vi.spyOn(fenced.store, 'transact').mockRejectedValue(new Error('receipt store unavailable'));
    await expect(fenced.runtime.finishMcpActivity(fencedHandle!, { correlationId: 'correlation-fenced', tool: 'queue_prompt', outcome: 'success' })).rejects.toThrow('receipt store unavailable');
    const fencedInternals = fenced.runtime as unknown as { mcpActivitySlots: Map<string, unknown>; pendingMcpReceipts: Map<string, unknown>; mcpActivityRegistrations: Map<string, unknown> };
    expect(fencedInternals.pendingMcpReceipts.size).toBe(1);
    expect(fencedInternals.mcpActivitySlots.size).toBe(1);
    fencedWrite.mockRestore();
    fenced.runtime.fence();
    expect(fencedInternals.mcpActivitySlots.size).toBe(0);
    expect(fencedInternals.pendingMcpReceipts.size).toBe(0);
    expect(fencedInternals.mcpActivityRegistrations.size).toBe(0);
    await fenced.runtime.recover();
    expect((await fenced.store.read()).messages.find(message => message.id === fencedHandle)).toMatchObject({ source: { phase: 'interrupted' } });
  });

  it('interrupts unresolved running receipts after a process restart', async () => {
    const { runtime, store, credential } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-restart', tool: 'list_notes', leaseKey: credential.leaseKey });
    const write = vi.spyOn(store, 'transact').mockRejectedValue(new Error('receipt store unavailable'));
    await expect(runtime.finishMcpActivity(handle!, { correlationId: 'correlation-restart', tool: 'list_notes', outcome: 'unknown' })).rejects.toThrow('receipt store unavailable');
    write.mockRestore();
    const restarted = new DavoRuntime({ store, control: runtime.options.control, realtime: {} as RealtimeService, mcpUrl: 'https://rac.example/mcp', instanceId: 'https://rac.example', scopes: ['status:read'], allowedTools: () => [], now: () => Date.parse('2026-11-06T20:00:00.000Z') });
    await restarted.recover();
    expect((await store.read()).messages.find(message => message.id === handle)).toMatchObject({ source: { phase: 'interrupted' } });
    expect((restarted as unknown as { pendingMcpReceipts: Map<string, unknown> }).pendingMcpReceipts.size).toBe(0);
  });

  it('marks abandoned work interrupted and permits a late authoritative finish', async () => {
    const { runtime, store, credential } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-late', tool: 'queue_prompt', leaseKey: credential.leaseKey });
    runtime.fence();
    await runtime.recover();
    expect((await store.read()).messages[1]).toMatchObject({ text: 'Queuing prompt was interrupted.', source: { phase: 'interrupted' } });
    await runtime.finishMcpActivity(handle!, { correlationId: 'correlation-late', tool: 'queue_prompt', outcome: 'success' });
    expect((await store.read()).messages[1]).toMatchObject({ id: handle, text: 'Queued prompt.', source: { phase: 'succeeded' } });
    const internals = runtime as unknown as { mcpActivitySlots: Map<string, unknown>; pendingMcpReceipts: Map<string, unknown>; mcpActivityRegistrations: Map<string, unknown> };
    expect(internals.mcpActivitySlots.size).toBe(0);
    expect(internals.pendingMcpReceipts.size).toBe(0);
    expect(internals.mcpActivityRegistrations.size).toBe(0);
  });

  it('reports actual working state from durable delegated work', async () => {
    const { runtime, store, user, turn, voiceSessionId, generation } = await fixture();
    const frontier = { instanceId: 'https://rac.example', agentId: 'agent-1', promptActivityRevision: 1, chainHeadPromptId: 'prompt-0', processGeneration: 1, handoverRevision: 0 };
    const epoch = activityEpoch(frontier);
    const target = { projectId: 'project-1', placeId: 'place-1', worktreeId: 'worktree-1', agentId: 'agent-1', processGeneration: 1, targetActivityEpoch: epoch, expectedPromptChainHead: 'prompt-0' };
    const coordinator = new DavoCoordinator({ store, continuation: { publish: async () => ({ status: 'unavailable' as const }), lookup: async () => ({ status: 'absent' as const }) }, activity: { read: async () => frontier }, evaluator: { evaluate: async () => ({ recommendation: 'continue' as const, unmetCriterionIds: [], contradictions: [], safeSummary: '' }) } });
    await coordinator.admit({
      requestId: 'request-working', originalMessageId: user.id, criteria: [{ id: 'criterion-1', statement: 'finish the task' }], requiredChecks: [], target: { ...target, instanceId: 'https://rac.example' },
      principal: { principalKind: 'davo-continuation', principalOwnerHash: 'a'.repeat(64), originInstanceId: 'https://rac.example', destinationInstanceId: 'https://rac.example', admittedAt: user.createdAt, expiresAt: expiryForAnchor(user.createdAt), sourceScopeSnapshot: ['status:read', 'prompts:write'], target, rights: ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] },
      operationId: 'operation-working', payloadDigest: 'b'.repeat(64)
    });
    runtime.live.finish(voiceSessionId, generation, turn.id);
    expect((await runtime.conversation()).working).toBe(true);
    await store.transact(state => { state.requests = []; });
    expect((await runtime.conversation()).working).toBe(false);
  });

  it('does not resurrect an expired registration on late finish', async () => {
    const { runtime, store, credential, advance } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-expired', tool: 'list_notes', leaseKey: credential.leaseKey });
    const write = vi.spyOn(store, 'transact').mockRejectedValue(new Error('receipt store unavailable'));
    await expect(runtime.finishMcpActivity(handle!, { correlationId: 'correlation-expired', tool: 'list_notes', outcome: 'success' })).rejects.toThrow('receipt store unavailable');
    expect((runtime as unknown as { pendingMcpReceipts: Map<string, unknown> }).pendingMcpReceipts.size).toBe(1);
    write.mockRestore();
    advance(4 * 24 * 60 * 60 * 1000);
    await runtime.tick();
    expect((await store.read()).messages).toEqual([]);
    expect((runtime as unknown as { pendingMcpReceipts: Map<string, unknown> }).pendingMcpReceipts.size).toBe(0);
    await runtime.finishMcpActivity(handle!, { correlationId: 'correlation-expired', tool: 'list_notes', outcome: 'success' });
    expect((await store.read()).messages).toEqual([]);
  });

  it('reserves terminal headroom across intervening writes near the state limit', async () => {
    const { runtime, store, credential } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-capacity', tool: 'list_notes', leaseKey: credential.leaseKey });
    await fillReservedCapacity(store);
    await expect(store.transact(state => {
      const filler = state.messages.at(-1);
      if (filler === undefined || filler.kind !== 'assistant') throw new Error('capacity filler missing');
      filler.text += 'y';
    })).rejects.toMatchObject({ code: 'davo_capacity' });
    await expect(runtime.finishMcpActivity(handle!, { correlationId: 'correlation-capacity', tool: 'list_notes', outcome: 'success' })).resolves.toBeUndefined();
    expect((await store.read()).messages.find(message => message.id === handle)).toMatchObject({ text: 'Read notes.', source: { phase: 'succeeded' } });
  });

  it('reserves interrupted headroom near the state limit', async () => {
    const { runtime, store, credential } = await fixture();
    const handle = await runtime.startMcpActivity({ correlationId: 'correlation-interrupt-capacity', tool: 'queue_prompt', leaseKey: credential.leaseKey });
    await fillReservedCapacity(store);
    runtime.fence();
    await runtime.recover();
    expect((await store.read()).messages.find(message => message.id === handle)).toMatchObject({ text: 'Queuing prompt was interrupted.', source: { phase: 'interrupted' } });
  });
});
