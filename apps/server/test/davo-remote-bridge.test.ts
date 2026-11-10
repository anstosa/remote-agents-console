import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityEpoch, continuationPayloadDigest, continuationPromptId, type DavoActivityFrontierV1, type DavoPromptPublication } from '../src/davo/continuation.js';
import { type DavoRequestV1, type DavoTargetV1 } from '../src/davo/contracts.js';
import { createDavoRemoteBridge } from '../src/davo/remote-bridge.js';
import { canonicalFollowupPayload, canonicalRequestSeed, davoPromptId, digestDavo, renderDavoFollowupV1, renderDavoOriginalV1, signFreshEnvelope } from '../src/davo/remote.js';
import { expiryForAnchor } from '../src/davo/retention.js';
import { DavoStore } from '../src/davo/store.js';
import { PromptOperationLedger, type PromptOperationRecord } from '../src/prompts/operations.js';
import type { PromptService, PromptPublicationInput, PromptPublicationResult } from '../src/prompts/service.js';

const fixtures: string[] = [];

type Chain = { value: string };
type DavoWriteTool = 'delegate_request' | 'relay_agent_question_answer';

// build one real-ledger prompt sink
function promptSink(ledger: PromptOperationLedger, chain: Chain, writes: string[]): PromptService {
  const service = {
    // publish through real durable operation and activity state
    publishOperation: async (input: PromptPublicationInput, guard: () => boolean | Promise<boolean>): Promise<PromptPublicationResult> => {
      const prepared = await ledger.prepare(input);
      // reconcile exact repeats without another sink write
      if (prepared.kind === 'existing') return prepared.operation.state === 'published' ? { kind: 'published', operation: prepared.operation, replayed: true } : { kind: 'unknown', operation: prepared.operation };
      // forward immutable preparation failures
      if (prepared.kind !== 'prepared') return { kind: prepared.kind };
      await ledger.transition(input.operationKey, ['prepared'], 'publishing');
      const claimed = await ledger.beginPublicationActivity(input.agentId, input.operationKey, input.expectedActivityEpoch);
      // reject a changed target frontier
      if (claimed === undefined) return { kind: 'rejected', reason: 'activity_changed' };
      // release a rejected exact lease
      if (!await guard()) {
        await ledger.transition(input.operationKey, ['publishing'], 'prepared');
        await ledger.abandonPublicationActivity(input.agentId, input.operationKey, input.expectedActivityEpoch);
        return { kind: 'rejected', reason: 'lease_rejected' };
      }
      writes.push(input.text);
      chain.value = input.promptId;
      const confirmed = await ledger.confirmPublicationActivity(input.agentId, input.operationKey);
      const published = await ledger.transition(input.operationKey, ['publishing'], 'published', confirmed?.epoch);
      // require durable publication completion
      if (published === undefined) return { kind: 'unknown', operation: prepared.operation };
      return { kind: 'published', operation: published, replayed: false };
    },
    // recover only exact durable operation truth
    lookupOperation: async (operationKey: string): Promise<PromptOperationRecord | undefined> => ledger.lookup(operationKey)
  };
  return service as unknown as PromptService;
}

// build a full content-free frontier from the real ledger
async function frontier(ledger: PromptOperationLedger, instanceId: string, target: DavoTargetV1, chain: Chain, expiresAt: string): Promise<DavoActivityFrontierV1> {
  const snapshot = await ledger.watchActivity(target.agentId, expiresAt);
  // require the watched target fixture
  if (snapshot === undefined) throw new Error('missing fixture activity');
  return {
    instanceId,
    agentId: target.agentId,
    promptActivityRevision: snapshot.epoch,
    chainHeadPromptId: chain.value,
    processGeneration: target.processGeneration,
    conversationId: target.conversationId,
    modelId: 'model-1',
    handoverRevision: 0,
    ...(snapshot.pending ? { pendingExternalMutation: 'pending' } : {})
  };
}

// verify the mounted bridge contract across two rac instances
describe('davo remote bridge', () => {
  // remove every isolated durable fixture
  afterEach(async () => {
    // clear all bridge stores and ledgers
    for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  // recover restarts and partitions without duplicate remote prompts
  it('publishes original and two followups with exact signed recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-davo-bridge-'));
    fixtures.push(directory);
    const originId = 'https://origin.example.test';
    const destinationId = 'https://destination.example.test';
    const secret = 'shared-secret';
    const now = new Date();
    const expiresAt = expiryForAnchor(now);
    const originStore = new DavoStore({ file: join(directory, 'origin-state.json') });
    const destinationStore = new DavoStore({ file: join(directory, 'destination-state.json') });
    const originLedger = new PromptOperationLedger(join(directory, 'origin-operations.json'));
    const destinationLedger = new PromptOperationLedger(join(directory, 'destination-operations.json'));
    const originChain: Chain = { value: 'origin-base' };
    const destinationChain: Chain = { value: 'destination-base' };
    const originWrites: string[] = [];
    const destinationWrites: string[] = [];
    const auditEvents: { phase: string; correlationId: string; argumentsDigest: string; result: string }[] = [];
    let failIntentFor: string | undefined;
    let failOutcomeFor: string | undefined;
    const audit = {
      // capture payload-free audit boundaries with injectable failures
      record: vi.fn(async (event: { phase: string; correlationId: string; argumentsDigest: string; result: string }) => {
        auditEvents.push(event);
        // fail only the selected exact audit boundary
        if ((event.phase === 'intent' && event.correlationId === failIntentFor) || (event.phase === 'outcome' && event.correlationId === failOutcomeFor)) throw new Error('audit unavailable');
      })
    };
    const relayedAnswers: unknown[] = [];
    const originPermissions = new Set<DavoWriteTool>(['delegate_request', 'relay_agent_question_answer']);
    const destinationPermissions = new Set<DavoWriteTool>(['delegate_request', 'relay_agent_question_answer']);
    const originCanWrite = (name?: DavoWriteTool) => name === undefined || originPermissions.has(name);
    const destinationCanWrite = (name?: DavoWriteTool) => name === undefined || destinationPermissions.has(name);
    let pendingQuestion: { id: string; text: string; choices: string[] } | undefined;
    const originPrompts = promptSink(originLedger, originChain, originWrites);
    const destinationPrompts = promptSink(destinationLedger, destinationChain, destinationWrites);
    const baseTarget = { projectId: 'project-1', placeId: 'place-1', worktreeId: 'worktree-1', agentId: 'agent-1', conversationId: 'agent-conversation', processGeneration: 1, targetActivityEpoch: 'pending', expectedPromptChainHead: destinationChain.value };
    const handlers = new Map<string, (envelope: unknown) => Promise<unknown>>();
    let dropKind: string | undefined;
    // route signed requests through in-memory http response objects
    const routedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const envelope = JSON.parse(String(init?.body)) as { body?: { kind?: string } };
      const handler = handlers.get(url.origin);
      // reject unmounted destinations
      if (handler === undefined) return new Response('', { status: 404 });
      try {
        const response = await handler(envelope);
        // simulate a partition after the destination committed its effect
        if (dropKind === envelope.body?.kind) {
          dropKind = undefined;
          throw new Error('partition');
        }
        return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch {
        return new Response('', { status: 503 });
      }
    });
    const destinationTarget = async (): Promise<{ target: DavoTargetV1; frontier: DavoActivityFrontierV1 }> => {
      const draft = { ...baseTarget };
      const observed = await frontier(destinationLedger, destinationId, draft, destinationChain, expiresAt);
      const target = { ...draft, targetActivityEpoch: activityEpoch(observed), expectedPromptChainHead: observed.chainHeadPromptId };
      return { target, frontier: observed };
    };
    const readDestination = async (target: DavoTargetV1) => frontier(destinationLedger, destinationId, target, destinationChain, expiresAt);
    const createDestination = (epoch: string) => createDavoRemoteBridge({
      store: destinationStore,
      prompts: destinationPrompts,
      operations: destinationLedger,
      instanceId: destinationId,
      peers: [originId],
      secret,
      audit,
      canWrite: destinationCanWrite,
      epoch,
      resolveLocal: async () => destinationTarget(),
      readLocal: readDestination,
      question: async () => pendingQuestion,
      answerQuestion: async (_target, questionId, answer) => {
        // accept only the exact still-pending fixture question
        if (pendingQuestion?.id !== questionId) return false;
        relayedAnswers.push(answer);
        pendingQuestion = undefined;
        return true;
      },
      fetch: routedFetch as typeof fetch
    });
    const emptyLocal = async () => undefined;
    let origin = createDavoRemoteBridge({ store: originStore, prompts: originPrompts, operations: originLedger, instanceId: originId, peers: [destinationId], secret, audit, epoch: 'origin-epoch-1', resolveLocal: emptyLocal, readLocal: emptyLocal, canWrite: originCanWrite, fetch: routedFetch as typeof fetch });
    let destination = createDestination('destination-epoch-1');
    handlers.set(originId, envelope => origin.handle(envelope as never));
    handlers.set(destinationId, envelope => destination.handle(envelope as never));
    const discovered = await destinationTarget();
    const user = await originStore.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const target = { ...discovered.target, instanceId: destinationId };
    const principalTarget = discovered.target;
    const request: DavoRequestV1 = {
      id: 'request-1', originalMessageId: user.id, originalRequestedAt: user.createdAt, originalLocalDate: user.localDate,
      state: 'dispatching', revision: 0, admittedGeneration: user.generation, instanceQualifiedTarget: target,
      targetActivityEpoch: target.targetActivityEpoch, expectedPromptChainHead: target.expectedPromptChainHead,
      principal: { principalKind: 'davo-continuation', principalOwnerHash: 'a'.repeat(64), originInstanceId: originId, destinationInstanceId: destinationId, admittedAt: user.createdAt, expiresAt, sourceScopeSnapshot: ['status:read', 'prompts:write'], target: principalTarget, rights: ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] },
      dispatch: { state: 'prepared', operationId: 'request-1-original', payloadDigest: 'b'.repeat(64) }, criteria: [{ id: 'criterion-1', statement: 'finish safely' }], requiredChecks: ['tests'],
      coordination: { followupCycles: 0, evaluationTimestamps: [], cumulativeFollowupBytes: 0, extraAuthorizedBatches: 0 }
    };
    await originStore.transact(state => { state.requests.push(request); });
    const seed = { version: 1 as const, requestId: request.id, originalRequest: user.text, criterionSetVersion: 1 as const, criteria: request.criteria, requiredChecks: request.requiredChecks };
    const originalPayload = renderDavoOriginalV1(seed);
    const originalInput: DavoPromptPublication = { operationId: 'request-1-original', promptId: continuationPromptId('request-1-original'), requestId: request.id, destinationInstanceId: destinationId, target, targetActivityEpoch: target.targetActivityEpoch, expectedPromptChainHead: target.expectedPromptChainHead, payload: originalPayload, payloadDigest: continuationPayloadDigest(originalPayload), expiresAt };
    await expect(origin.publish(originalInput)).resolves.toEqual({ status: 'published', promptId: davoPromptId('request-1-original') });
    let observed = await origin.read(target);
    if (observed === undefined) throw new Error('missing remote activity');
    await originStore.transact(state => {
      const stored = state.requests[0];
      state.operations.push({ operationId: originalInput.operationId, requestId: stored.id, destinationInstanceId: stored.instanceQualifiedTarget.instanceId, kind: 'original-delegation', generation: stored.admittedGeneration, targetActivityEpoch: stored.targetActivityEpoch, payloadDigest: originalInput.payloadDigest, state: 'published', promptId: originalInput.promptId, createdAt: stored.originalRequestedAt, expiresAt: stored.principal.expiresAt });
      stored.dispatch = { state: 'published', operationId: originalInput.operationId, payloadDigest: originalInput.payloadDigest, promptId: originalInput.promptId };
      stored.state = 'awaiting-agent';
      stored.revision = 1;
      stored.targetActivityEpoch = activityEpoch(observed!);
      stored.expectedPromptChainHead = observed!.chainHeadPromptId;
      stored.instanceQualifiedTarget.targetActivityEpoch = stored.targetActivityEpoch;
      stored.instanceQualifiedTarget.expectedPromptChainHead = stored.expectedPromptChainHead;
    });
    // lose a successful rebind response, restart again, then recover through rebind_required
    destination = createDestination('destination-epoch-2');
    handlers.set(destinationId, envelope => destination.handle(envelope as never));
    dropKind = 'resume-grant';
    await expect(origin.read((await originStore.read()).requests[0].instanceQualifiedTarget)).rejects.toThrow();
    destination = createDestination('destination-epoch-3');
    handlers.set(destinationId, envelope => destination.handle(envelope as never));
    observed = await origin.read((await originStore.read()).requests[0].instanceQualifiedTarget);
    expect(observed?.chainHeadPromptId).toBe(originalInput.promptId);
    // publish two current-chain canonical followups
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const snapshot = await originStore.read();
      const stored = snapshot.requests[0];
      if (stored.dispatch.state !== 'published') throw new Error('expected published fixture request');
      const payload = { version: 1 as const, rendererVersion: 1 as const, requestSeed: seed, requestSeedDigest: digestDavo(canonicalRequestSeed(seed)), cycle, priorPromptId: stored.dispatch.promptId, unmetCriterionIds: ['criterion-1'], completionEnvelope: { requestId: stored.id, promptId: stored.dispatch.promptId, outcome: 'partial' as const, criteria: [{ id: 'criterion-1', status: 'unsatisfied' as const, evidence: 'remaining' }], checks: [{ name: 'tests', status: 'failed' as const, evidence: 'failed' }], remaining: ['finish'] }, safeExcerpt: 'partial' };
      const canonicalPayload = canonicalFollowupPayload(payload);
      const rendered = renderDavoFollowupV1(canonicalPayload);
      const operationId = `${stored.id}-followup-${cycle}`;
      const input: DavoPromptPublication = { operationId, promptId: continuationPromptId(operationId), requestId: stored.id, destinationInstanceId: destinationId, target: stored.instanceQualifiedTarget, targetActivityEpoch: stored.targetActivityEpoch, expectedPromptChainHead: stored.expectedPromptChainHead, payload: rendered, payloadDigest: continuationPayloadDigest(rendered), canonicalPayload, expiresAt };
      // lose the second publication response after the destination commits
      if (cycle === 2) dropKind = 'publish-followup';
      const first = await origin.publish(input).catch(() => ({ status: 'unknown' as const }));
      const result = first.status === 'published' ? first : await origin.publish(input);
      expect(result).toEqual({ status: 'published', promptId: davoPromptId(operationId) });
      const next = await origin.read(stored.instanceQualifiedTarget);
      if (next === undefined) throw new Error('missing next remote activity');
      await originStore.transact(state => {
        const current = state.requests[0];
        state.operations.push({ operationId, requestId: current.id, destinationInstanceId: current.instanceQualifiedTarget.instanceId, kind: 'followup', generation: current.admittedGeneration, targetActivityEpoch: current.targetActivityEpoch, payloadDigest: input.payloadDigest, state: 'published', promptId: input.promptId, createdAt: new Date().toISOString(), expiresAt: current.principal.expiresAt });
        current.dispatch = { state: 'published', operationId, payloadDigest: input.payloadDigest, promptId: input.promptId };
        current.revision += 1;
        current.targetActivityEpoch = activityEpoch(next);
        current.expectedPromptChainHead = next.chainHeadPromptId;
        current.instanceQualifiedTarget.targetActivityEpoch = current.targetActivityEpoch;
        current.instanceQualifiedTarget.expectedPromptChainHead = current.expectedPromptChainHead;
      });
    }
    expect(destinationWrites).toHaveLength(3);
    // reject unauthenticated and executable/canonical substitution
    const badEnvelope = signFreshEnvelope({ kind: 'probe-target', originInstanceId: originId, destinationInstanceId: destinationId, agentId: 'agent-1', worktreeId: 'worktree-1', expiresAt, sourceScopeSnapshot: ['status:read', 'prompts:write'] }, { secret: 'wrong', audience: destinationId, grantExpiresAt: expiresAt });
    await expect(destination.handle(badEnvelope)).rejects.toThrow();
    const current = (await originStore.read()).requests[0];
    const changed: DavoPromptPublication = { ...originalInput, requestId: current.id, operationId: `${current.id}-followup-3`, promptId: continuationPromptId(`${current.id}-followup-3`), target: current.instanceQualifiedTarget, targetActivityEpoch: current.targetActivityEpoch, expectedPromptChainHead: current.expectedPromptChainHead, canonicalPayload: canonicalFollowupPayload({ version: 1, rendererVersion: 1, requestSeed: seed, requestSeedDigest: digestDavo(canonicalRequestSeed(seed)), cycle: 3, priorPromptId: current.dispatch.state === 'published' ? current.dispatch.promptId : '', unmetCriterionIds: ['criterion-1'], safeExcerpt: 'changed' }) };
    await expect(origin.publish(changed)).resolves.toEqual({ status: 'conflict' });
    expect(destinationWrites).toHaveLength(3);
    // continuation authority alone cannot answer without a fresh owned live assertion
    const grant = (await destinationStore.read()).remoteGrants[0];
    const unauthorized = signFreshEnvelope({ kind: 'relay-question-answer', grantId: grant.grantId, destinationEpoch: grant.destinationEpoch, grantRevision: grant.grantRevision, canonicalTarget: grant.target, principalKind: 'davo-live-question-answer', principalOwnerHash: 'f'.repeat(64), admittedMessageId: 'message-x', admittedAt: new Date().toISOString(), turnId: 'turn-x', operationId: 'answer-x', questionId: 'question-1', answer: { index: 0 }, payloadDigest: '0'.repeat(64) }, { secret, audience: destinationId, grantExpiresAt: grant.expiresAt });
    await expect(destination.handle(unauthorized)).rejects.toThrow();
    expect(relayedAnswers).toEqual([]);
    // persist and expose one exact remote pending question
    if (current.dispatch.state !== 'published') throw new Error('expected final published prompt');
    pendingQuestion = { id: 'question-1', text: 'Choose exactly one.', choices: ['yes', 'no'] };
    await destination.recordLifecycle({ requestId: current.id, operationId: current.dispatch.operationId, promptId: current.dispatch.promptId, state: 'question', question: { questionId: pendingQuestion.id, question: pendingQuestion.text, agentProcessGeneration: current.instanceQualifiedTarget.processGeneration, answerShape: 'single-choice', choices: pendingQuestion.choices } });
    const remoteQuestion = await origin.lifecycle(current);
    expect(remoteQuestion).toMatchObject({ state: 'question', question: { questionId: 'question-1', choices: ['yes', 'no'] } });
    await originStore.transact(state => {
      const stored = state.requests[0];
      stored.state = 'awaiting-choice';
      stored.attention = { kind: 'agent_question', questionId: 'question-1', question: 'Choose exactly one.', agentProcessGeneration: stored.instanceQualifiedTarget.processGeneration, targetActivityEpoch: stored.targetActivityEpoch, answerShape: 'single-choice', choices: ['yes', 'no'] };
    });
    const answerMessage = await originStore.appendUserTranscript({ voiceSessionId: 'voice-2', providerSessionId: 'provider-2', providerItemId: 'item-2', text: 'yes' });
    const relayInput = { target: (await originStore.read()).requests[0].instanceQualifiedTarget, principalOwnerHash: 'a'.repeat(64), admittedMessageId: answerMessage.id, admittedAt: answerMessage.createdAt, turnId: 'turn-2', operationId: 'answer-operation-1', questionId: 'question-1', answer: { index: 0 } as const };
    // an unrelated delegation grant cannot authorize an origin answer
    originPermissions.delete('relay_agent_question_answer');
    const localDeniedFetches = routedFetch.mock.calls.length;
    await expect(origin.relay({ ...relayInput, operationId: 'answer-operation-origin-denied' })).rejects.toThrow();
    expect(routedFetch.mock.calls).toHaveLength(localDeniedFetches);
    expect(relayedAnswers).toEqual([]);
    expect(auditEvents.some(event => event.correlationId === 'answer-operation-origin-denied')).toBe(false);
    originPermissions.add('relay_agent_question_answer');
    // the destination must independently reject a signed answer
    destinationPermissions.delete('relay_agent_question_answer');
    await expect(origin.relay({ ...relayInput, operationId: 'answer-operation-destination-denied' })).rejects.toThrow();
    expect(relayedAnswers).toEqual([]);
    expect(pendingQuestion?.id).toBe('question-1');
    expect(auditEvents.some(event => event.correlationId === 'answer-operation-destination-denied')).toBe(false);
    destinationPermissions.add('relay_agent_question_answer');
    // live answer intent audit failure leaves the question untouched
    failIntentFor = 'answer-operation-audit-fail';
    await expect(origin.relay({ ...relayInput, operationId: failIntentFor })).rejects.toThrow();
    expect(relayedAnswers).toEqual([]);
    expect(pendingQuestion?.id).toBe('question-1');
    failIntentFor = undefined;
    // recover a lost success receipt without answering twice
    dropKind = 'relay-question-answer';
    await expect(origin.relay(relayInput)).rejects.toThrow();
    await expect(origin.relay(relayInput)).resolves.toMatchObject({ answered: true, frontier: { chainHeadPromptId: current.dispatch.promptId } });
    expect(relayedAnswers).toEqual([{ index: 0 }]);
    // changed semantic reuse and a stale new operation have no effect
    await expect(origin.relay({ ...relayInput, answer: { index: 1 } })).rejects.toThrow();
    await expect(origin.relay({ ...relayInput, operationId: 'answer-operation-2' })).rejects.toThrow();
    expect(relayedAnswers).toEqual([{ index: 0 }]);
    const answerOperations = (await destinationStore.read()).operations.filter(operation => operation.kind === 'lifecycle');
    expect(answerOperations).toHaveLength(3);
    expect(answerOperations.find(operation => operation.state === 'published')).toBeDefined();
    expect(answerOperations.find(operation => operation.state === 'unknown')).toBeDefined();
    // persist and recover one exact lifecycle after the origin bridge restarts
    const completion = { requestId: current.id, promptId: current.dispatch.promptId, outcome: 'complete' as const, criteria: [{ id: 'criterion-1', status: 'satisfied' as const, evidence: 'done' }], checks: [{ name: 'tests', status: 'passed' as const, evidence: 'pass' }], remaining: [] };
    await destination.recordLifecycle({ requestId: current.id, operationId: current.dispatch.operationId, promptId: current.dispatch.promptId, state: 'completed', safeExcerpt: 'done', completionEnvelope: completion });
    origin = createDavoRemoteBridge({ store: originStore, prompts: originPrompts, operations: originLedger, instanceId: originId, peers: [destinationId], secret, audit, epoch: 'origin-epoch-2', resolveLocal: emptyLocal, readLocal: emptyLocal, canWrite: originCanWrite, fetch: routedFetch as typeof fetch });
    handlers.set(originId, envelope => origin.handle(envelope as never));
    // a retained grant cannot outlive the origin's local named permission
    originPermissions.delete('delegate_request');
    const retainedDeniedFetches = routedFetch.mock.calls.length;
    await expect(origin.lifecycle((await originStore.read()).requests[0])).rejects.toThrow();
    expect(routedFetch.mock.calls).toHaveLength(retainedDeniedFetches);
    originPermissions.add('delegate_request');
    const recovered = await origin.lifecycle((await originStore.read()).requests[0]);
    expect(recovered).toMatchObject({ kind: 'lifecycle-receipt', promptId: current.dispatch.promptId, completionEnvelope: completion });
    const retained = (await originStore.read()).requests[0];
    if (retained.dispatch.state !== 'published') throw new Error('expected retained published request');
    // intent audit failure prevents any prompt effect
    const failedIntentPayload = { version: 1 as const, rendererVersion: 1 as const, requestSeed: seed, requestSeedDigest: digestDavo(canonicalRequestSeed(seed)), cycle: 3, priorPromptId: retained.dispatch.promptId, unmetCriterionIds: ['criterion-1'], safeExcerpt: 'continue' };
    const failedIntentCanonical = canonicalFollowupPayload(failedIntentPayload);
    const failedIntentRendered = renderDavoFollowupV1(failedIntentCanonical);
    // the destination cannot publish or claim policy after local revocation
    destinationPermissions.delete('delegate_request');
    const deniedOperation = 'request-1-followup-permission-denied';
    await expect(origin.publish({ operationId: deniedOperation, promptId: continuationPromptId(deniedOperation), requestId: retained.id, destinationInstanceId: destinationId, target: retained.instanceQualifiedTarget, targetActivityEpoch: retained.targetActivityEpoch, expectedPromptChainHead: retained.expectedPromptChainHead, payload: failedIntentRendered, payloadDigest: continuationPayloadDigest(failedIntentRendered), canonicalPayload: failedIntentCanonical, expiresAt })).rejects.toThrow();
    expect(destinationWrites).toHaveLength(3);
    expect(auditEvents.some(event => event.correlationId === deniedOperation)).toBe(false);
    destinationPermissions.add('delegate_request');
    failIntentFor = 'request-1-followup-3';
    await expect(origin.publish({ operationId: failIntentFor, promptId: continuationPromptId(failIntentFor), requestId: retained.id, destinationInstanceId: destinationId, target: retained.instanceQualifiedTarget, targetActivityEpoch: retained.targetActivityEpoch, expectedPromptChainHead: retained.expectedPromptChainHead, payload: failedIntentRendered, payloadDigest: continuationPayloadDigest(failedIntentRendered), canonicalPayload: failedIntentCanonical, expiresAt })).resolves.toEqual({ status: 'unknown' });
    expect(destinationWrites).toHaveLength(3);
    failIntentFor = undefined;
    // outcome audit failure recovers exact ledger truth without republishing
    const failedOutcomePayload = { ...failedIntentPayload, cycle: 4 };
    const failedOutcomeCanonical = canonicalFollowupPayload(failedOutcomePayload);
    const failedOutcomeRendered = renderDavoFollowupV1(failedOutcomeCanonical);
    failOutcomeFor = 'request-1-followup-4';
    await expect(origin.publish({ operationId: failOutcomeFor, promptId: continuationPromptId(failOutcomeFor), requestId: retained.id, destinationInstanceId: destinationId, target: retained.instanceQualifiedTarget, targetActivityEpoch: retained.targetActivityEpoch, expectedPromptChainHead: retained.expectedPromptChainHead, payload: failedOutcomeRendered, payloadDigest: continuationPayloadDigest(failedOutcomeRendered), canonicalPayload: failedOutcomeCanonical, expiresAt })).resolves.toEqual({ status: 'unknown' });
    expect(destinationWrites).toHaveLength(4);
    failOutcomeFor = undefined;
    await expect(origin.lookup(retained, 'request-1-followup-4')).resolves.toEqual({ status: 'published', promptId: davoPromptId('request-1-followup-4') });
    await expect(origin.lookup(retained, 'request-1-followup-4')).resolves.toEqual({ status: 'published', promptId: davoPromptId('request-1-followup-4') });
    expect(destinationWrites).toHaveLength(4);
    expect(auditEvents.some(event => event.phase === 'intent' && event.correlationId === 'request-1-followup-3')).toBe(true);
    expect(JSON.stringify(auditEvents)).not.toContain('finish safely');
  });
});
