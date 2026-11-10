import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DavoContinuationAuthority, activityEpoch, continuationPayloadDigest, continuationPromptId, type DavoActivityFrontierV1 } from '../src/davo/continuation.js';
import { DavoStore } from '../src/davo/store.js';
import type { DavoRequestV1 } from '../src/davo/contracts.js';

const fixtures: string[] = [];

// freeze storage and authority inside the retained fixture window
const storeNow = () => new Date('2026-11-05T12:00:00.000Z');
const now = () => new Date('2026-11-05T12:01:00.000Z');

// create one isolated durable store
async function store(): Promise<DavoStore> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-davo-continuation-'));
  fixtures.push(directory);
  return new DavoStore({ file: join(directory, 'state.json'), now: storeNow });
}

// build one exact activity frontier
function frontier(): DavoActivityFrontierV1 {
  return { instanceId: 'instance-1', agentId: 'agent-1', promptActivityRevision: 4, chainHeadPromptId: 'prompt-0', processGeneration: 2, conversationId: 'conversation-agent', modelId: 'model-1', handoverRevision: 0 };
}

// build one admitted request record
function request(originalMessageId: string, epoch: string): DavoRequestV1 {
  const target = { projectId: 'project-1', placeId: 'place-1', worktreeId: 'worktree-1', agentId: 'agent-1', conversationId: 'conversation-agent', processGeneration: 2, targetActivityEpoch: epoch, expectedPromptChainHead: 'prompt-0' };
  return {
    id: 'request-1', originalMessageId, originalRequestedAt: '2026-11-05T12:00:00.000Z', originalLocalDate: '2026-11-05', state: 'evaluating', revision: 1, admittedGeneration: 0,
    instanceQualifiedTarget: { ...target, instanceId: 'instance-1' }, targetActivityEpoch: epoch, expectedPromptChainHead: 'prompt-0',
    principal: { principalKind: 'davo-continuation', principalOwnerHash: 'a'.repeat(64), originInstanceId: 'instance-1', destinationInstanceId: 'instance-1', admittedAt: '2026-11-05T12:00:00.000Z', expiresAt: '2026-11-08T11:00:00.000Z', sourceScopeSnapshot: ['status:read', 'prompts:write'], target, rights: ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] },
    dispatch: { state: 'published', operationId: 'initial-op', payloadDigest: 'b'.repeat(64), promptId: 'prompt-0' },
    criteria: [{ id: 'criterion-1', statement: 'finish safely' }], requiredChecks: ['tests'],
    coordination: { followupCycles: 0, evaluationTimestamps: [], cumulativeFollowupBytes: 0, extraAuthorizedBatches: 0 }
  };
}

// verify narrow continuation authority
describe('davo continuation', () => {
  // remove isolated stores
  afterEach(async () => {
    // clear every fixture
    for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  // persist intent before publication and reconcile exact replay
  it('publishes once under the exact target frontier', async () => {
    const durable = await store();
    const user = await durable.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const current = frontier();
    await durable.transact(state => {
      const retained = request(user.id, activityEpoch(current));
      state.requests.push(retained);
      state.operations.push({ operationId: 'initial-op', requestId: retained.id, destinationInstanceId: retained.instanceQualifiedTarget.instanceId, kind: 'original-delegation', generation: retained.admittedGeneration, targetActivityEpoch: retained.targetActivityEpoch, payloadDigest: retained.dispatch.payloadDigest, state: 'published', promptId: 'prompt-0', createdAt: retained.originalRequestedAt, expiresAt: retained.principal.expiresAt });
    });
    const publish = vi.fn(async input => {
      expect((await durable.read()).operations).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: 'followup-1', state: 'publishing' })]));
      return { status: 'published' as const, promptId: input.promptId };
    });
    const authority = new DavoContinuationAuthority({
      store: durable,
      activity: { read: async () => current },
      prompts: { publish, lookup: async () => ({ status: 'published', promptId: continuationPromptId('followup-1') }) },
      audit: { record: async () => true },
      now
    });
    const payload = 'continue original work';
    const input = { requestId: 'request-1', expectedRevision: 1, operationId: 'followup-1', kind: 'followup' as const, payload, payloadDigest: continuationPayloadDigest(payload) };
    await expect(authority.publish(input)).resolves.toEqual({ status: 'published', promptId: continuationPromptId('followup-1') });
    await expect(authority.publish(input)).resolves.toEqual({ status: 'published', promptId: continuationPromptId('followup-1') });
    expect(publish).toHaveBeenCalledOnce();
  });

  // refuse activity drift without adopting its output
  it('returns divergence before prompt publication', async () => {
    const durable = await store();
    const user = await durable.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish safely' });
    const admitted = frontier();
    await durable.transact(state => {
      const retained = request(user.id, activityEpoch(admitted));
      state.requests.push(retained);
      state.operations.push({ operationId: 'initial-op', requestId: retained.id, destinationInstanceId: retained.instanceQualifiedTarget.instanceId, kind: 'original-delegation', generation: retained.admittedGeneration, targetActivityEpoch: retained.targetActivityEpoch, payloadDigest: retained.dispatch.payloadDigest, state: 'published', promptId: 'prompt-0', createdAt: retained.originalRequestedAt, expiresAt: retained.principal.expiresAt });
    });
    const publish = vi.fn();
    const authority = new DavoContinuationAuthority({
      store: durable,
      activity: { read: async () => ({ ...admitted, promptActivityRevision: 5, pendingExternalMutation: 'pane-1' }) },
      prompts: { publish, lookup: vi.fn() }, audit: { record: async () => true }, now
    });
    await expect(authority.publish({ requestId: 'request-1', expectedRevision: 1, operationId: 'followup-1', kind: 'followup', payload: 'continue', payloadDigest: continuationPayloadDigest('continue') })).resolves.toEqual({ status: 'diverged' });
    expect(publish).not.toHaveBeenCalled();
  });
});
