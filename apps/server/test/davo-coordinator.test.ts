import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DavoCoordinator } from '../src/davo/coordinator.js';
import { activityEpoch, type DavoActivityFrontierV1 } from '../src/davo/continuation.js';
import { DavoStore } from '../src/davo/store.js';

const fixtures: string[] = [];

// freeze storage and authority inside the retained fixture window
const storeNow = () => new Date('2026-11-05T12:00:00.000Z');
const now = () => new Date('2026-11-05T12:02:00.000Z');

// create one isolated coordinator store
async function fixture(): Promise<DavoStore> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-davo-coordinator-'));
  fixtures.push(directory);
  return new DavoStore({ file: join(directory, 'state.json'), now: storeNow });
}

// build the frozen target frontier
function frontier(): DavoActivityFrontierV1 {
  return { instanceId: 'instance-1', agentId: 'agent-1', promptActivityRevision: 1, chainHeadPromptId: 'prompt-0', processGeneration: 1, conversationId: 'agent-conversation', modelId: 'model-1', handoverRevision: 0 };
}

// build one admission input
function admission(messageId: string, activity: DavoActivityFrontierV1) {
  const epoch = activityEpoch(activity);
  const target = { projectId: 'project-1', placeId: 'place-1', worktreeId: 'worktree-1', agentId: 'agent-1', conversationId: 'agent-conversation', processGeneration: 1, targetActivityEpoch: epoch, expectedPromptChainHead: 'prompt-0' };
  return {
    requestId: 'request-1', originalMessageId: messageId, criteria: [{ id: 'criterion-1', statement: 'finish safely' }], requiredChecks: ['tests'],
    target: { ...target, instanceId: 'instance-1' },
    principal: { principalKind: 'davo-continuation' as const, principalOwnerHash: 'a'.repeat(64), originInstanceId: 'instance-1', destinationInstanceId: 'instance-1', admittedAt: '2026-11-05T12:00:00.000Z', expiresAt: '2026-11-08T11:00:00.000Z', sourceScopeSnapshot: ['status:read', 'prompts:write'] as const, target, rights: ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] as const },
    operationId: 'initial-op', payloadDigest: 'b'.repeat(64)
  };
}

// verify evidence-backed coordination
describe('davo coordinator', () => {
  // remove isolated stores
  afterEach(async () => {
    // clear every fixture
    for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  // terminalize only complete matching evidence
  it('writes one final row and ready outbox for deterministic completion', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    const continuation = { publish: vi.fn().mockResolvedValue({ status: 'published', promptId: 'prompt-0' }), lookup: vi.fn() };
    const coordinator = new DavoCoordinator({ store, now, continuation, activity: { read: async () => current }, evaluator: { evaluate: async () => ({ recommendation: 'candidate_done', unmetCriterionIds: [], contradictions: [], safeSummary: 'verified' }) } });
    await coordinator.admit(admission(user.id, current));
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    const result = await coordinator.acceptLifecycle({ requestId: 'request-1', operationId: 'initial-op', promptId: 'prompt-0', generation: 0, requestRevision: 1, targetActivityEpoch: activityEpoch(current), state: 'completed', completionEnvelope: { requestId: 'request-1', promptId: 'prompt-0', outcome: 'complete', criteria: [{ id: 'criterion-1', status: 'satisfied', evidence: 'implemented' }], checks: [{ name: 'tests', status: 'passed', evidence: 'pass' }], remaining: [] }, safeExcerpt: 'all done' });
    expect(result).toEqual({ status: 'done' });
    const snapshot = await store.read();
    expect(snapshot.requests[0]).toMatchObject({ state: 'done', terminalEvidence: { kind: 'completion' } });
    expect(snapshot.messages.at(-1)).toMatchObject({ kind: 'assistant', source: { kind: 'request-response', requestId: 'request-1' } });
    expect(snapshot.notificationOutbox).toEqual([expect.objectContaining({ requestId: 'request-1', kind: 'done', state: 'ready' })]);
  });

  // require advisory agreement before terminalizing deterministic evidence
  it.each([
    { recommendation: 'continue' as const, unmetCriterionIds: [], contradictions: [] },
    { recommendation: 'inconsistent' as const, unmetCriterionIds: [], contradictions: [] },
    { recommendation: 'candidate_done' as const, unmetCriterionIds: ['criterion-1'], contradictions: [] },
    { recommendation: 'candidate_done' as const, unmetCriterionIds: [], contradictions: ['conflicting evidence'] }
  ])('keeps complete evidence nonterminal when the evaluator disagrees: $recommendation', async advisory => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    const published = { ...current, promptActivityRevision: 2, chainHeadPromptId: 'prompt-1' };
    const continuation = { publish: vi.fn().mockResolvedValue({ status: 'published', promptId: 'prompt-1', activity: published }), lookup: vi.fn() };
    const coordinator = new DavoCoordinator({ store, now, continuation, activity: { read: async () => current }, evaluator: { evaluate: async () => ({ ...advisory, safeSummary: 'must not terminalize' }) } });
    await coordinator.admit(admission(user.id, current));
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    const result = await coordinator.acceptLifecycle({ requestId: 'request-1', operationId: 'initial-op', promptId: 'prompt-0', generation: 0, requestRevision: 1, targetActivityEpoch: activityEpoch(current), state: 'completed', completionEnvelope: { requestId: 'request-1', promptId: 'prompt-0', outcome: 'complete', criteria: [{ id: 'criterion-1', status: 'satisfied', evidence: 'implemented' }], checks: [{ name: 'tests', status: 'passed', evidence: 'pass' }], remaining: [] }, safeExcerpt: 'all done' });
    expect(result).toEqual({ status: 'continued', promptId: 'prompt-1' });
    const request = (await store.read()).requests[0];
    expect(request.state).toBe('awaiting-agent');
    expect(request.terminalEvidence).toBeUndefined();
    expect((await store.read()).notificationOutbox).toEqual([]);
  });

  // continue incomplete work without treating it as done
  it('publishes a bounded original-request followup for partial evidence', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    const published = { ...current, promptActivityRevision: 2, chainHeadPromptId: 'prompt-1' };
    const continuation = { publish: vi.fn().mockResolvedValue({ status: 'published', promptId: 'prompt-1', activity: published }), lookup: vi.fn() };
    const coordinator = new DavoCoordinator({ store, now, continuation, activity: { read: async () => current }, evaluator: { evaluate: async () => ({ recommendation: 'continue', unmetCriterionIds: ['criterion-1'], contradictions: [], safeSummary: 'tests failed' }) } });
    await coordinator.admit(admission(user.id, current));
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    await coordinator.acceptLifecycle({ requestId: 'request-1', operationId: 'initial-op', promptId: 'prompt-0', generation: 0, requestRevision: 1, targetActivityEpoch: activityEpoch(current), state: 'completed', completionEnvelope: { requestId: 'request-1', promptId: 'prompt-0', outcome: 'partial', criteria: [{ id: 'criterion-1', status: 'unsatisfied', evidence: 'missing' }], checks: [{ name: 'tests', status: 'failed', evidence: 'failure' }], remaining: ['fix tests'] }, safeExcerpt: 'not done' });
    expect(continuation.publish).toHaveBeenCalledOnce();
    expect(continuation.publish.mock.calls[0]?.[0].payload).toContain('finish safely');
    expect((await store.read()).requests[0]).toMatchObject({ state: 'awaiting-agent', coordination: { followupCycles: 1 } });
  });

  // block quietly when advisory evaluation is unavailable
  it('does not publish after evaluator failure', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    const continuation = { publish: vi.fn(), lookup: vi.fn() };
    const coordinator = new DavoCoordinator({ store, now, continuation, activity: { read: async () => current }, evaluator: { evaluate: async () => { throw new Error('offline'); } } });
    await coordinator.admit(admission(user.id, current));
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    await expect(coordinator.acceptLifecycle({ requestId: 'request-1', operationId: 'initial-op', promptId: 'prompt-0', generation: 0, requestRevision: 1, targetActivityEpoch: activityEpoch(current), state: 'completed', safeExcerpt: 'not done' })).resolves.toEqual({ status: 'blocked' });
    expect(continuation.publish).not.toHaveBeenCalled();
    expect((await store.read()).requests[0]).toMatchObject({ state: 'operational-blocked', attention: { kind: 'operational_blocked' } });
  });

  // carry exact dispatch and frontier across repeated partial rounds
  it('accepts two chained partial rounds and then one strict completion', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    let current = frontier();
    let publication = 0;
    const continuation = {
      // advance the exact prompt chain for each bounded followup
      publish: vi.fn(async () => {
        publication += 1;
        current = { ...current, promptActivityRevision: current.promptActivityRevision + 1, chainHeadPromptId: `prompt-${publication}` };
        return { status: 'published' as const, promptId: current.chainHeadPromptId, activity: current };
      }),
      lookup: vi.fn()
    };
    let evaluation = 0;
    const coordinator = new DavoCoordinator({
      store,
      now,
      continuation,
      activity: { read: async () => current },
      evaluator: { evaluate: async () => ({ recommendation: evaluation++ < 2 ? 'continue' : 'candidate_done', unmetCriterionIds: evaluation <= 2 ? ['criterion-1'] : [], contradictions: [], safeSummary: 'verified' }) }
    });
    await coordinator.admit(admission(user.id, current));
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    // feed two exact partial receipts
    for (let round = 0; round < 2; round += 1) {
      const request = (await store.read()).requests[0];
      if (request.dispatch.state !== 'published') throw new Error('expected published request');
      await expect(coordinator.acceptLifecycle({
        requestId: request.id,
        operationId: request.dispatch.operationId,
        promptId: request.dispatch.promptId,
        generation: request.admittedGeneration,
        requestRevision: request.revision,
        targetActivityEpoch: request.targetActivityEpoch,
        state: 'completed',
        completionEnvelope: { requestId: request.id, promptId: request.dispatch.promptId, outcome: 'partial', criteria: [{ id: 'criterion-1', status: 'unsatisfied', evidence: 'remaining' }], checks: [{ name: 'tests', status: 'failed', evidence: 'failure' }], remaining: ['finish'] },
        safeExcerpt: 'partial'
      })).resolves.toMatchObject({ status: 'continued' });
    }
    const request = (await store.read()).requests[0];
    if (request.dispatch.state !== 'published') throw new Error('expected published request');
    await expect(coordinator.acceptLifecycle({
      requestId: request.id,
      operationId: request.dispatch.operationId,
      promptId: request.dispatch.promptId,
      generation: request.admittedGeneration,
      requestRevision: request.revision,
      targetActivityEpoch: request.targetActivityEpoch,
      state: 'completed',
      completionEnvelope: { requestId: request.id, promptId: request.dispatch.promptId, outcome: 'complete', criteria: [{ id: 'criterion-1', status: 'satisfied', evidence: 'done' }], checks: [{ name: 'tests', status: 'passed', evidence: 'pass' }], remaining: [] },
      safeExcerpt: 'done'
    })).resolves.toEqual({ status: 'done' });
    expect((await store.read()).requests[0]).toMatchObject({ state: 'done', coordination: { followupCycles: 2 } });
  });

  // consume new authority only under the durable store frontier
  it('rejects stale live guards before admission or choice effects', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    const continuation = { publish: vi.fn(), lookup: vi.fn() };
    const coordinator = new DavoCoordinator({ store, now, continuation, activity: { read: async () => current }, evaluator: { evaluate: vi.fn() } });
    await expect(coordinator.admit(admission(user.id, current), () => false)).rejects.toThrow('davo_turn_changed');
    expect((await store.read()).requests).toEqual([]);
    await coordinator.admit(admission(user.id, current), () => true);
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    await store.transact(state => {
      const request = state.requests[0];
      request.state = 'awaiting-choice';
      request.attention = { kind: 'davo_continuation_choice', choiceId: 'choice-1', reason: 'followup-budget', options: ['authorize-one-more-batch', 'stop-followup'] };
    });
    const choice = { requestId: 'request-1', choiceId: 'choice-1', generation: 0, frontier: current } as const;
    await expect(coordinator.answerChoice({ ...choice, option: 'authorize-one-more-batch' }, () => false)).resolves.toEqual({ status: 'stale' });
    await expect(coordinator.answerChoice({ ...choice, option: 'stop-followup' }, () => false)).resolves.toEqual({ status: 'stale' });
    expect(continuation.publish).not.toHaveBeenCalled();
    expect((await store.read()).requests[0]).toMatchObject({ state: 'awaiting-choice', coordination: { extraAuthorizedBatches: 0 }, attention: { choiceId: 'choice-1' } });
  });

  // never let budget consent adopt unrelated intervening work
  it('replaces a drifted budget choice without publishing or rebinding', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    const drifted = { ...current, promptActivityRevision: 2, chainHeadPromptId: 'unrelated-prompt' };
    const continuation = { publish: vi.fn(), lookup: vi.fn() };
    const coordinator = new DavoCoordinator({ store, now, continuation, activity: { read: async () => drifted }, evaluator: { evaluate: vi.fn() } });
    await coordinator.admit(admission(user.id, current));
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    await store.transact(state => {
      const request = state.requests[0];
      request.state = 'awaiting-choice';
      request.attention = { kind: 'davo_continuation_choice', choiceId: 'budget-choice', reason: 'followup-budget', options: ['authorize-one-more-batch', 'stop-followup'] };
      request.notification = { eventId: 'davo-choice-budget-choice', outcome: 'choice', revision: request.revision };
      state.notificationOutbox.push({ id: 'outbox-budget-choice', requestId: request.id, kind: 'choice', tag: `davo-${request.id}-choice`, state: 'ready', eventId: 'davo-choice-budget-choice', attempts: 0, createdAt: '2026-11-05T12:00:00.000Z' });
    });
    await expect(coordinator.answerChoice({ requestId: 'request-1', choiceId: 'budget-choice', option: 'authorize-one-more-batch', generation: 0, frontier: drifted })).resolves.toEqual({ status: 'choice' });
    const state = await store.read();
    const request = state.requests[0];
    expect(continuation.publish).not.toHaveBeenCalled();
    expect(request).toMatchObject({ state: 'awaiting-choice', coordination: { extraAuthorizedBatches: 0 }, expectedPromptChainHead: 'prompt-0', attention: { kind: 'davo_continuation_choice', reason: 'target-chain-diverged', options: ['resume-after-current-chain', 'stop-followup'] } });
    expect(request.attention).not.toMatchObject({ choiceId: 'budget-choice' });
    expect(state.notificationOutbox.find(row => row.id === 'outbox-budget-choice')?.state).toBe('expired');
    expect(state.notificationOutbox.filter(row => row.state === 'ready')).toHaveLength(1);
  });

  // recover a published followup after coordinator commit interruption
  it('reconciles an exact published followup without duplicate publication', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    let current = frontier();
    const publish = vi.fn(async (input: { requestId: string; operationId: string; payloadDigest: string }) => {
      current = { ...current, promptActivityRevision: 2, chainHeadPromptId: 'prompt-1' };
      await store.transact(state => {
        const operation = state.operations.find(candidate => candidate.operationId === input.operationId);
        const request = state.requests.find(candidate => candidate.id === input.requestId);
        // simulate durable continuation success before coordinator completion
        if (operation === undefined || request === undefined) throw new Error('missing prepared fixture');
        operation.state = 'published';
        operation.promptId = 'prompt-1';
        request.dispatch = { state: 'published', operationId: input.operationId, payloadDigest: input.payloadDigest, promptId: 'prompt-1' };
        request.coordination.activeOperationId = undefined;
      });
      throw new Error('coordinator crash');
    });
    const first = new DavoCoordinator({ store, now, continuation: { publish, lookup: vi.fn() }, activity: { read: async () => current }, evaluator: { evaluate: async () => ({ recommendation: 'continue', unmetCriterionIds: ['criterion-1'], contradictions: [], safeSummary: '' }) } });
    await first.admit(admission(user.id, current));
    await first.markPublished('request-1', 'initial-op', 'prompt-0');
    await expect(first.acceptLifecycle({ requestId: 'request-1', operationId: 'initial-op', promptId: 'prompt-0', generation: 0, requestRevision: 1, targetActivityEpoch: activityEpoch(frontier()), state: 'completed', completionEnvelope: { requestId: 'request-1', promptId: 'prompt-0', outcome: 'partial', criteria: [{ id: 'criterion-1', status: 'unsatisfied', evidence: 'remaining' }], checks: [{ name: 'tests', status: 'failed', evidence: 'failure' }], remaining: ['finish'] }, safeExcerpt: 'partial' })).rejects.toThrow('coordinator crash');
    expect((await store.read()).requests[0]).toMatchObject({ state: 'evaluating', dispatch: { operationId: 'request-1-followup-1', promptId: 'prompt-1' }, coordination: { activeFollowupBytes: expect.any(Number) } });
    const lookup = vi.fn().mockResolvedValue({ status: 'published', promptId: 'prompt-1' });
    const recovered = new DavoCoordinator({ store, now, continuation: { publish, lookup }, activity: { read: async () => current }, evaluator: { evaluate: vi.fn() } });
    await expect(recovered.reconcile('request-1')).resolves.toEqual({ status: 'continued', promptId: 'prompt-1' });
    expect(publish).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect((await store.read()).requests[0]).toMatchObject({ state: 'awaiting-agent', dispatch: { operationId: 'request-1-followup-1', promptId: 'prompt-1' }, coordination: { followupCycles: 1, activeOperationId: undefined, activeFollowupBytes: undefined } });
  });

  // bound exact lookup before asking about uncertain publication
  it('creates one durable publication choice after bounded original lookup without replay', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    const publish = vi.fn();
    const lookup = vi.fn().mockResolvedValue({ status: 'unknown' });
    const first = new DavoCoordinator({ store, now, continuation: { publish, lookup }, activity: { read: async () => current }, evaluator: { evaluate: vi.fn() } });
    await first.admit(admission(user.id, current));
    await store.transact(state => {
      const request = state.requests[0];
      state.operations.push({ operationId: 'initial-op', requestId: request.id, destinationInstanceId: 'instance-1', kind: 'original-delegation', generation: 0, targetActivityEpoch: request.targetActivityEpoch, payloadDigest: 'b'.repeat(64), state: 'unknown', createdAt: '2026-11-05T12:00:00.000Z', expiresAt: request.principal.expiresAt });
      request.dispatch = { state: 'unknown', operationId: 'initial-op', payloadDigest: 'b'.repeat(64) };
    });
    await first.markPublicationUnknown('request-1', 'initial-op');
    const recovered = new DavoCoordinator({ store, now, continuation: { publish, lookup }, activity: { read: async () => current }, evaluator: { evaluate: vi.fn() } });
    await expect(recovered.reconcile('request-1')).resolves.toEqual({ status: 'blocked' });
    await expect(recovered.reconcile('request-1')).resolves.toEqual({ status: 'blocked' });
    await expect(recovered.reconcile('request-1')).resolves.toEqual({ status: 'choice' });
    await expect(recovered.reconcile('request-1')).resolves.toEqual({ status: 'choice' });
    const state = await store.read();
    expect(publish).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(state.requests[0]).toMatchObject({ state: 'awaiting-choice', coordination: { publicationRecovery: { operationId: 'initial-op', lookupChecks: 3, mode: 'choice' } }, attention: { kind: 'davo_continuation_choice', reason: 'publication-unknown', options: ['wait-for-evidence', 'stop-followup'] } });
    expect(state.notificationOutbox.filter(row => row.state === 'ready')).toHaveLength(1);
  });

  // explicit wait may observe evidence but never synthesizes another choice
  it('keeps explicit wait pending and makes explicit stop terminal for lookup', async () => {
    const setup = async () => {
      const store = await fixture();
      const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
      const current = frontier();
      const lookup = vi.fn().mockResolvedValue({ status: 'unknown' });
      const coordinator = new DavoCoordinator({ store, now, continuation: { publish: vi.fn(), lookup }, activity: { read: async () => current }, evaluator: { evaluate: vi.fn() } });
      await coordinator.admit(admission(user.id, current));
      await store.transact(state => {
        const request = state.requests[0];
        state.operations.push({ operationId: 'initial-op', requestId: request.id, destinationInstanceId: 'instance-1', kind: 'original-delegation', generation: 0, targetActivityEpoch: request.targetActivityEpoch, payloadDigest: 'b'.repeat(64), state: 'unknown', createdAt: '2026-11-05T12:00:00.000Z', expiresAt: request.principal.expiresAt });
        request.dispatch = { state: 'unknown', operationId: 'initial-op', payloadDigest: 'b'.repeat(64) };
      });
      await coordinator.markPublicationUnknown('request-1', 'initial-op');
      await coordinator.reconcile('request-1');
      await coordinator.reconcile('request-1');
      await coordinator.reconcile('request-1');
      return { store, coordinator, lookup };
    };
    const waiting = await setup();
    const waitChoice = (await waiting.store.read()).requests[0].attention;
    if (waitChoice?.kind !== 'davo_continuation_choice') throw new Error('missing publication choice');
    await expect(waiting.coordinator.answerChoice({ requestId: 'request-1', choiceId: waitChoice.choiceId, option: 'wait-for-evidence', generation: 0 })).resolves.toEqual({ status: 'blocked' });
    await expect(waiting.coordinator.reconcile('request-1')).resolves.toEqual({ status: 'blocked' });
    const waitingState = await waiting.store.read();
    expect(waitingState.requests[0]).toMatchObject({ state: 'operational-blocked', coordination: { publicationRecovery: { mode: 'waiting', lookupChecks: 3 } }, attention: { kind: 'operational_blocked', code: 'davo_publication_unknown' } });
    expect(waitingState.notificationOutbox.filter(row => row.state === 'ready')).toEqual([]);
    const stopped = await setup();
    const stopChoice = (await stopped.store.read()).requests[0].attention;
    if (stopChoice?.kind !== 'davo_continuation_choice') throw new Error('missing publication choice');
    await expect(stopped.coordinator.answerChoice({ requestId: 'request-1', choiceId: stopChoice.choiceId, option: 'stop-followup', generation: 0 })).resolves.toEqual({ status: 'blocked' });
    const before = stopped.lookup.mock.calls.length;
    await expect(stopped.coordinator.reconcile('request-1')).resolves.toEqual({ status: 'blocked' });
    expect(stopped.lookup).toHaveBeenCalledTimes(before);
    expect((await stopped.store.read()).requests[0]).toMatchObject({ coordination: { publicationRecovery: { mode: 'stopped' } } });
  });

  // accept exact proof after an ambiguous followup without publishing twice
  it('recovers a published ambiguous followup through lookup only', async () => {
    const store = await fixture();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    let current = frontier();
    const publish = vi.fn().mockResolvedValue({ status: 'unknown' });
    const lookup = vi.fn()
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockImplementationOnce(async () => {
        current = { ...current, promptActivityRevision: 2, chainHeadPromptId: 'prompt-1' };
        return { status: 'published', promptId: 'prompt-1', activity: current };
      });
    const coordinator = new DavoCoordinator({ store, now, continuation: { publish, lookup }, activity: { read: async () => current }, evaluator: { evaluate: async () => ({ recommendation: 'continue', unmetCriterionIds: ['criterion-1'], contradictions: [], safeSummary: '' }) } });
    await coordinator.admit(admission(user.id, current));
    await coordinator.markPublished('request-1', 'initial-op', 'prompt-0');
    await expect(coordinator.acceptLifecycle({ requestId: 'request-1', operationId: 'initial-op', promptId: 'prompt-0', generation: 0, requestRevision: 1, targetActivityEpoch: activityEpoch(current), state: 'completed', completionEnvelope: { requestId: 'request-1', promptId: 'prompt-0', outcome: 'partial', criteria: [{ id: 'criterion-1', status: 'unsatisfied', evidence: 'remaining' }], checks: [{ name: 'tests', status: 'failed', evidence: 'failure' }], remaining: ['finish'] } })).resolves.toEqual({ status: 'blocked' });
    await expect(coordinator.reconcile('request-1')).resolves.toEqual({ status: 'blocked' });
    await expect(coordinator.reconcile('request-1')).resolves.toEqual({ status: 'continued', promptId: 'prompt-1' });
    expect(publish).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect((await store.read()).requests[0]).toMatchObject({ state: 'awaiting-agent', dispatch: { state: 'published', operationId: 'request-1-followup-1', promptId: 'prompt-1' }, coordination: { followupCycles: 1, publicationRecovery: undefined } });
  });
});
