import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalizeDavo, digestDavo, parseDavoState, type DavoRemoteGrantV1, type DavoStateV1 } from '../src/davo/contracts.js';
import { DavoStore } from '../src/davo/store.js';

const directories: string[] = [];
const now = '2026-11-05T12:00:00.000Z';
const expiresAt = '2026-11-08T11:00:00.000Z';

// remove only isolated validation fixtures
afterEach(async () => {
  // clear every test-owned directory
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// build one consistent published request from a genuine retained user anchor
async function fixture(): Promise<{ file: string; state: DavoStateV1 }> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-davo-validation-'));
  directories.push(directory);
  const file = join(directory, 'state.json');
  const store = new DavoStore({ file, now: () => new Date(now) });
  const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish the request' });
  const state = await store.read();
  const target = { projectId: 'project-1', placeId: 'place-1', worktreeId: 'worktree-1', agentId: 'agent-1', processGeneration: 1, targetActivityEpoch: 'epoch-1', expectedPromptChainHead: 'prompt-1' };
  state.requests.push({
    id: 'request-1', originalMessageId: user.id, originalRequestedAt: now, originalLocalDate: user.localDate,
    state: 'awaiting-agent', revision: 1, admittedGeneration: 0,
    instanceQualifiedTarget: { ...target, instanceId: 'destination-1' }, targetActivityEpoch: 'epoch-1', expectedPromptChainHead: 'prompt-1',
    principal: { principalKind: 'davo-continuation', principalOwnerHash: 'a'.repeat(64), originInstanceId: 'origin-1', destinationInstanceId: 'destination-1', admittedAt: now, expiresAt, sourceScopeSnapshot: ['status:read', 'prompts:write'], target, rights: ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] },
    dispatch: { state: 'published', operationId: 'operation-1', payloadDigest: 'b'.repeat(64), promptId: 'prompt-1' },
    criteria: [{ id: 'criterion-1', statement: 'finish the request' }], requiredChecks: ['checks'],
    coordination: { followupCycles: 0, evaluationTimestamps: [], cumulativeFollowupBytes: 0, extraAuthorizedBatches: 0 }
  });
  state.operations.push({ operationId: 'operation-1', requestId: 'request-1', destinationInstanceId: 'destination-1', kind: 'original-delegation', generation: 0, targetActivityEpoch: 'epoch-1', payloadDigest: 'b'.repeat(64), state: 'published', promptId: 'prompt-1', createdAt: now, expiresAt });
  return { file, state };
}

// terminal evidence and its notification must describe the same completion
function complete(state: DavoStateV1): void {
  const request = state.requests[0]!;
  request.state = 'done';
  request.terminalEvidence = { kind: 'completion', evaluatedAt: now, envelope: { requestId: request.id, promptId: 'prompt-1', outcome: 'complete', criteria: [{ id: 'criterion-1', status: 'satisfied', evidence: 'finished' }], checks: [{ name: 'checks', status: 'passed', evidence: 'passed' }], remaining: [] } };
  request.notification = { eventId: 'done-1', outcome: 'done', revision: request.revision };
  state.notificationOutbox.push({ id: 'outbox-1', requestId: request.id, kind: 'done', eventId: 'done-1', tag: 'done', state: 'ready', attempts: 0, createdAt: now });
}

// create the exact immutable digest used by the remote grant protocol
function grant(state: DavoStateV1): DavoRemoteGrantV1 {
  const request = state.requests[0]!;
  const seed = { version: 1 as const, requestId: request.id, originalRequest: 'finish the request', criterionSetVersion: 1 as const, criteria: request.criteria, requiredChecks: request.requiredChecks };
  const immutable = { grantVersion: 1 as const, grantId: 'grant-1', originInstanceId: 'origin-1', destinationInstanceId: 'destination-1', requestId: request.id, principalOwnerHash: request.principal.principalOwnerHash, sourceScopeSnapshot: request.principal.sourceScopeSnapshot, originalRequestedAt: now, expiresAt, target: request.principal.target, targetActivityEpoch: request.targetActivityEpoch, expectedPromptChainHead: request.expectedPromptChainHead, rights: request.principal.rights, requestSeed: seed, requestSeedDigest: digestDavo(JSON.stringify(seed)) };
  return { ...immutable, immutableGrantDigest: digestDavo(canonicalizeDavo(immutable)), destinationEpoch: 'boot-1', grantRevision: 0, state: 'active', rebindReceiptBodies: [], operationReceiptBodies: [], lifecycleReceiptBodies: [] };
}

// retain coherent live, completed, and remote states
it('accepts coherent published and terminal evidence with matching remote grants', async () => {
  const { state } = await fixture();
  expect(parseDavoState(state)).toEqual(state);
  complete(state);
  state.remoteGrants.push(grant(state));
  expect(parseDavoState(state)).toEqual(state);
});

const corruptions: Array<[string, (state: DavoStateV1) => void]> = [
  // reject done without evidence
  ['done without evidence', state => { state.requests[0]!.state = 'done'; }],
  // reject nonterminal with completion evidence
  ['nonterminal with completion evidence', state => { complete(state); state.requests[0]!.state = 'awaiting-agent'; }],
  // reject mismatched completion prompt
  ['mismatched completion prompt', state => { complete(state); state.requests[0]!.terminalEvidence!.envelope.promptId = 'other-prompt'; }],
  // reject choice without attention
  ['choice without attention', state => { state.requests[0]!.state = 'awaiting-choice'; }],
  // reject operational block without attention
  ['operational block without attention', state => { state.requests[0]!.state = 'operational-blocked'; }],
  // reject active request with blocked attention
  ['active request with blocked attention', state => { state.requests[0]!.attention = { kind: 'operational_blocked', code: 'davo_provider_unavailable' }; }],
  // reject published dispatch without operation
  ['published dispatch without operation', state => { state.operations = []; }],
  // reject published dispatch with mismatched digest
  ['published dispatch with mismatched digest', state => { state.operations[0]!.payloadDigest = 'c'.repeat(64); }],
  // reject published dispatch with mismatched prompt
  ['published dispatch with mismatched prompt', state => { state.operations[0]!.promptId = 'other-prompt'; }],
  // reject published dispatch with mismatched destination
  ['published dispatch with mismatched destination', state => { state.operations[0]!.destinationInstanceId = 'other-destination'; }],
  // reject published dispatch with future generation
  ['published dispatch with future generation', state => { state.operations[0]!.generation += 1; }],
  // reject orphan operation
  ['orphan operation', state => { state.operations[0]!.requestId = 'other-request'; }],
  // reject ready outbox without current notification
  ['ready outbox without current notification', state => { complete(state); state.requests[0]!.notification = undefined; }],
  // reject outbox for unrelated request
  ['outbox for unrelated request', state => { complete(state); state.notificationOutbox[0]!.requestId = 'other-request'; }],
  // reject duplicate notification identity
  ['duplicate notification identity', state => { complete(state); state.notificationOutbox.push({ ...state.notificationOutbox[0]! }); }],
  // reject mismatched notification outcome
  ['mismatched notification outcome', state => { complete(state); state.notificationOutbox[0]!.kind = 'choice'; }],
  // reject forged request seed digest
  ['forged request seed digest', state => { state.remoteGrants.push({ ...grant(state), requestSeedDigest: 'c'.repeat(64) }); }],
  // reject forged immutable grant digest
  ['forged immutable grant digest', state => { state.remoteGrants.push({ ...grant(state), immutableGrantDigest: 'c'.repeat(64) }); }],
  // reject forged stored receipt digest
  ['forged stored receipt digest', state => { const remote = grant(state); remote.operationReceiptBodies.push({ bodyDigest: 'd'.repeat(64), body: { kind: 'prompt-operation-receipt', version: 1, grantId: remote.grantId, immutableGrantDigest: remote.immutableGrantDigest, originInstanceId: remote.originInstanceId, destinationInstanceId: remote.destinationInstanceId, operationId: 'operation-1', payloadDigest: 'b'.repeat(64), result: 'published', promptId: 'prompt-1', grantExpiresAt: expiresAt } }); state.remoteGrants.push(remote); }]
];

// reject syntactically valid corruption before any runtime or push consumer starts
it.each(corruptions)('fails closed on %s', async (_label, corrupt) => {
  const { file, state } = await fixture();
  corrupt(state);
  expect(() => parseDavoState(state)).toThrow();
  const raw = JSON.stringify(state);
  await writeFile(file, raw, { mode: 0o600 });
  const reopened = new DavoStore({ file, now: () => new Date(now) });
  await expect(reopened.ensureCurrent()).rejects.toMatchObject({ code: 'davo_store_unavailable' });
  expect(reopened.available).toBe(false);
  expect(await readFile(file, 'utf8')).toBe(raw);
});
