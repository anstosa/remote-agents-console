import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityEpoch, type DavoActivityFrontierV1 } from '../src/davo/continuation.js';
import { DavoRemoteContinuation, canonicalFollowupPayload, canonicalRequestSeed, davoPromptId, digestDavo, renderDavoFollowupV1, signFreshEnvelope, verifyFreshEnvelope } from '../src/davo/remote.js';
import { DavoStore } from '../src/davo/store.js';

const fixtures: string[] = [];

// verify canonical remote transport primitives
describe('davo remote continuation', () => {
  // remove isolated remote stores
  afterEach(async () => {
    // clear every fixture
    for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  // preserve exact unicode and deterministic field order
  it('canonicalizes and hashes the closed request seed', () => {
    const seed = { version: 1 as const, requestId: 'request-1', originalRequest: 'use e\u0301 exactly', criterionSetVersion: 1 as const, criteria: [{ id: 'criterion-1', statement: 'do work' }] };
    const canonical = canonicalRequestSeed(seed);
    expect(canonical).toBe('{"version":1,"requestId":"request-1","originalRequest":"use é exactly","criterionSetVersion":1,"criteria":[{"id":"criterion-1","statement":"do work"}]}');
    expect(digestDavo(canonical)).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalRequestSeed({ ...seed, originalRequest: 'use é exactly' })).not.toBe(canonical);
  });

  // reject stale or audience-substituted transport envelopes
  it('authenticates fresh transport separately from its logical body', () => {
    const body = { kind: 'lookup-operation' as const, grantId: 'grant-1', operationId: 'operation-1', destinationEpoch: 'epoch-1', grantRevision: 0 };
    const envelope = signFreshEnvelope(body, { secret: 'secret', audience: 'destination-1', now: new Date('2026-11-05T12:00:00.000Z') });
    expect(verifyFreshEnvelope(envelope, { secret: 'secret', audience: 'destination-1', now: new Date('2026-11-05T12:00:15.000Z') })).toEqual(body);
    expect(() => verifyFreshEnvelope(envelope, { secret: 'secret', audience: 'other', now: new Date('2026-11-05T12:00:15.000Z') })).toThrowError();
    expect(() => verifyFreshEnvelope(envelope, { secret: 'secret', audience: 'destination-1', now: new Date('2026-11-05T12:00:31.000Z') })).toThrowError();
  });

  // render only the canonical bounded payload
  it('renders deterministic fenced followup bytes', () => {
    const seed = { version: 1 as const, requestId: 'request-1', originalRequest: 'finish safely', criterionSetVersion: 1 as const, criteria: [{ id: 'criterion-1', statement: 'finish safely' }], requiredChecks: ['tests'] };
    const canonical = canonicalFollowupPayload({ version: 1, rendererVersion: 1, requestSeed: seed, requestSeedDigest: digestDavo(canonicalRequestSeed(seed)), cycle: 2, priorPromptId: 'prompt-1', unmetCriterionIds: ['criterion-1'], safeExcerpt: 'partial' });
    const rendered = renderDavoFollowupV1(canonical);
    expect(rendered).toContain(canonical);
    expect(rendered).toContain(davoPromptId('request-1-followup-2'));
    expect(rendered).toContain('Required checks are exactly ["tests"]');
    expect(rendered).toContain('<davo-completion-v1>');
    expect(rendered).toBe(renderDavoFollowupV1(canonical));
  });

  // admit and publish an original request only through signed destination policy
  it('dispatches signed admission and one deterministic original publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-davo-remote-'));
    fixtures.push(directory);
    let now = new Date('2026-11-05T12:00:00.000Z');
    const store = new DavoStore({ file: join(directory, 'state.json'), now: () => now });
    let frontier: DavoActivityFrontierV1 = { instanceId: 'destination-1', agentId: 'agent-1', promptActivityRevision: 1, chainHeadPromptId: 'prompt-head', processGeneration: 1, conversationId: 'agent-conversation', modelId: 'model-1', handoverRevision: 0 };
    const target = { projectId: 'project-1', placeId: 'place-1', worktreeId: 'worktree-1', agentId: 'agent-1', conversationId: 'agent-conversation', processGeneration: 1, targetActivityEpoch: activityEpoch(frontier), expectedPromptChainHead: 'prompt-head' };
    const publish = vi.fn(async input => {
      frontier = { ...frontier, promptActivityRevision: frontier.promptActivityRevision + 1, chainHeadPromptId: input.promptId };
      return { status: 'published' as const, promptId: input.promptId };
    });
    let destinationEpoch = 'epoch-1';
    const remote = new DavoRemoteContinuation({
      store,
      secret: 'shared-secret',
      originInstanceId: 'origin-1',
      destinationInstanceId: 'destination-1',
      currentEpoch: () => destinationEpoch,
      prompts: { publish, lookup: vi.fn() },
      admission: { probe: async () => ({ ok: true, target, frontier }), authorize: async () => ({ ok: true, target, frontier }) },
      activity: { read: async () => frontier },
      now: () => now
    });
    const probe = signFreshEnvelope({ kind: 'probe-target' as const, originInstanceId: 'origin-1', destinationInstanceId: 'destination-1', agentId: 'agent-1', worktreeId: 'worktree-1', expiresAt: '2026-11-08T11:00:00.000Z', sourceScopeSnapshot: ['status:read', 'prompts:write'] as const }, { secret: 'shared-secret', audience: 'destination-1', now });
    const probed = verifyFreshEnvelope(await remote.dispatch(probe), { secret: 'shared-secret', audience: 'origin-1', now });
    expect(probed).toMatchObject({ kind: 'target-probe-receipt', target, targetActivityEpoch: activityEpoch(frontier), currentDestinationEpoch: 'epoch-1' });
    const grant = {
      grantId: 'grant-1', originInstanceId: 'origin-1', destinationInstanceId: 'destination-1', requestId: 'request-1', principalOwnerHash: 'a'.repeat(64),
      sourceScopeSnapshot: ['status:read', 'prompts:write'] as const, originalRequestedAt: now.toISOString(), expiresAt: '2026-11-08T11:00:00.000Z', target,
      targetActivityEpoch: activityEpoch(frontier), expectedPromptChainHead: 'prompt-head', rights: ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] as const,
      requestSeed: { version: 1 as const, requestId: 'request-1', originalRequest: 'finish safely', criterionSetVersion: 1 as const, criteria: [{ id: 'criterion-1', statement: 'finish safely' }], requiredChecks: ['tests'] }, destinationEpoch: 'epoch-1'
    };
    const admission = signFreshEnvelope({ kind: 'admit-grant' as const, grant }, { secret: 'shared-secret', audience: 'destination-1', now });
    const admittedEnvelope = await remote.dispatch(admission);
    const admitted = verifyFreshEnvelope(admittedEnvelope, { secret: 'shared-secret', audience: 'origin-1', now });
    expect(admitted).toMatchObject({ kind: 'grant-admission-receipt', grantId: 'grant-1', grantRevision: 0 });
    const original = signFreshEnvelope({ kind: 'publish-original' as const, grantId: 'grant-1', operationId: 'request-1-original', destinationEpoch: 'epoch-1', grantRevision: 0 }, { secret: 'shared-secret', audience: 'destination-1', now });
    const first = verifyFreshEnvelope(await remote.dispatch(original), { secret: 'shared-secret', audience: 'origin-1', now });
    const second = verifyFreshEnvelope(await remote.dispatch(original), { secret: 'shared-secret', audience: 'origin-1', now });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'prompt-operation-receipt', result: 'published', promptId: davoPromptId('request-1-original') });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].payload).toContain('DAVO_ORIGINAL_V1');
    expect(publish.mock.calls[0]?.[0].payload).toContain(davoPromptId('request-1-original'));
    // publish two owned same-chain followups
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const priorPromptId = frontier.chainHeadPromptId;
      const payload = { version: 1 as const, rendererVersion: 1 as const, requestSeed: grant.requestSeed, requestSeedDigest: digestDavo(canonicalRequestSeed(grant.requestSeed)), cycle, priorPromptId, unmetCriterionIds: ['criterion-1'], completionEnvelope: { requestId: 'request-1', promptId: priorPromptId, outcome: 'partial' as const, criteria: [{ id: 'criterion-1', status: 'unsatisfied' as const, evidence: 'remaining' }], checks: [{ name: 'tests', status: 'failed' as const, evidence: 'failed' }], remaining: ['finish'] }, safeExcerpt: 'partial' };
      const payloadDigest = digestDavo(canonicalFollowupPayload(payload));
      const followup = signFreshEnvelope({ kind: 'publish-followup' as const, grantId: 'grant-1', operationId: `request-1-followup-${cycle}`, destinationEpoch: 'epoch-1', grantRevision: 0, canonicalTarget: target, targetActivityEpoch: activityEpoch(frontier), expectedPromptChainHead: priorPromptId, payload, payloadDigest }, { secret: 'shared-secret', audience: 'destination-1', now });
      const receipt = verifyFreshEnvelope(await remote.handle(followup), { secret: 'shared-secret', audience: 'origin-1', now });
      expect(receipt).toMatchObject({ kind: 'prompt-operation-receipt', result: 'published', promptId: davoPromptId(`request-1-followup-${cycle}`) });
    }
    expect(publish).toHaveBeenCalledTimes(3);
    destinationEpoch = 'epoch-2';
    await expect(remote.dispatch(original)).rejects.toThrow('stale davo remote dispatch binding');
    expect(publish).toHaveBeenCalledTimes(3);
    destinationEpoch = 'epoch-1';
    now = new Date('2026-11-06T12:00:00.000Z');
    await store.ensureCurrent();
    expect((await store.read()).remoteGrants).toHaveLength(1);
    expect((await store.read()).operations).toHaveLength(3);
    now = new Date('2026-11-08T11:00:00.000Z');
    await store.ensureCurrent();
    expect((await store.read()).remoteGrants).toHaveLength(0);
    expect((await store.read()).operations).toHaveLength(0);
  });
});
