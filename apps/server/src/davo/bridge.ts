import { createHash } from 'node:crypto';
import type { IntegrationAuditService } from '../integrations/audit/service.js';
import { createDavoTools, type DavoHumanAnswer } from '../integrations/mcp/davo-tools.js';
import { developerFailure, developerSuccess } from '../integrations/mcp/developer-tool.js';
import { redactIntegrationText } from '../integrations/text.js';
import { promptScope, type PromptService } from '../prompts/service.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import type { PromptOperationLedger } from '../prompts/operations.js';
import { utf8Bytes, type DavoInstanceQualifiedTargetV1, type DavoRequestV1 } from './contracts.js';
import { DavoCoordinator, sanitizeDavoCompletion } from './coordinator.js';
import { activityEpoch, continuationPayloadDigest, DavoContinuationAuthority, type DavoActivityFrontierV1, type DavoPromptPublication, type DavoPromptResult } from './continuation.js';
import { acceptCompactedContext, buildCompactorSource, buildEvaluationInput, buildFallbackContext } from './context.js';
import { expiryForAnchor } from './retention.js';
import { DavoRealtimeTextClient } from './realtime-client.js';
import type { DavoRuntime } from './runtime.js';
import { davoPromptId as promptId, renderDavoOriginalV1 } from './remote.js';
import { createDavoRemoteBridge } from './remote-bridge.js';
import type { DavoLifecycleReceipt } from './coordinator.js';

export type DavoHostTarget = { agentId: string; worktreeId: string; projectId: string; placeId: string; conversationId?: string; processGeneration: number; modelId?: string };
export type DavoBridgeOptions = {
  runtime: DavoRuntime;
  prompts: PromptService;
  operations: PromptOperationLedger;
  history: PromptHistoryService;
  instanceId: string;
  target: (agentId: string) => Promise<DavoHostTarget | undefined>;
  answerQuestion: (agentId: string, questionId: string, answer: DavoHumanAnswer, mayAnswer?: () => boolean, preserveDavo?: boolean) => Promise<boolean>;
  question: (agentId: string) => Promise<{ id: string; text: string; choices: string[] } | undefined>;
  audit: Pick<IntegrationAuditService, 'record'>;
  evaluator: DavoRealtimeTextClient;
  remote?: { peers: string[]; secret: string; epoch: string };
  canWrite?: () => boolean;
};

// hash canonical target identity for the generic publication ledger
function targetDigest(target: DavoInstanceQualifiedTargetV1): string { return createHash('sha256').update(JSON.stringify(target)).digest('hex'); }

// parse only an explicit single correlated completion envelope
export function readDavoCompletion(text: string | undefined) {
  // missing or oversized output cannot establish completion
  if (text === undefined || utf8Bytes(text) > 48 * 1024) return undefined;
  const redacted = redactIntegrationText(text);
  const matches = [...redacted.matchAll(/<davo-completion-v1>\s*([\s\S]*?)\s*<\/davo-completion-v1>/gu)];
  // multiple competing envelopes are ambiguous
  if (matches.length !== 1 || utf8Bytes(matches[0][1]) > 8192) return undefined;
  try {
    return sanitizeDavoCompletion(JSON.parse(matches[0][1]));
  } catch { return undefined; }
}

// wire durable davo ownership into ordinary rac prompt execution
export function createDavoBridge(options: DavoBridgeOptions) {
  const { runtime, prompts, operations, instanceId } = options;
  const store = runtime.options.store;
  const running = new Set<string>();
  const abort = new AbortController();
  let closed = false;
  let compactedGeneration: number | undefined;
  let prunedGeneration: number | undefined;
  prompts.useOperations(operations);

  // observe authoritative content-free process and prompt frontiers
  async function readLocal(target: DavoInstanceQualifiedTargetV1): Promise<DavoActivityFrontierV1 | undefined> {
    const host = await options.target(target.agentId);
    const frontier = await prompts.activitySnapshot(target.agentId);
    // never synthesize an agent or accept an untracked target
    if (host === undefined || host.worktreeId !== target.worktreeId || frontier === undefined) return undefined;
    const head = await operations.latestPublished(target.agentId);
    return { instanceId, agentId: target.agentId, promptActivityRevision: frontier.epoch, chainHeadPromptId: head?.promptId ?? `unbound:${target.agentId}`, processGeneration: host.processGeneration, ...(host.conversationId === undefined ? {} : { conversationId: host.conversationId }), ...(host.modelId === undefined ? {} : { modelId: host.modelId }), handoverRevision: 0, ...(frontier.pending ? { pendingExternalMutation: 'pending' } : {}) };
  }

  // resolve one configured local place for signed remote admission
  async function resolveLocal(agentId: string, worktreeId: string, expiresAt: string) {
    const host = await options.target(agentId);
    // foreign or noncanonical places never acquire a target frontier
    if (host === undefined || host.worktreeId !== worktreeId) return undefined;
    await prompts.watchActivity(agentId, expiresAt);
    const target = { ...host, targetActivityEpoch: 'pending', expectedPromptChainHead: 'pending' };
    const frontier = await readLocal({ ...target, instanceId });
    // admission requires stable pre-effect evidence
    if (frontier === undefined || frontier.pendingExternalMutation !== undefined) return undefined;
    const { modelId: _modelId, ...fixed } = host;
    return { target: { ...fixed, targetActivityEpoch: activityEpoch(frontier), expectedPromptChainHead: frontier.chainHeadPromptId }, frontier };
  }

  const remote = options.remote === undefined ? undefined : createDavoRemoteBridge({ ...options.remote, store, prompts, operations, instanceId, audit: options.audit, canWrite: options.canWrite, question: target => options.question(target.agentId), answerQuestion: (target, id, answer) => options.answerQuestion(target.agentId, id, answer, () => options.canWrite?.() !== false, true), resolveLocal, readLocal: target => readLocal({ ...target, instanceId }) });

  // keep local observation and authenticated remote attestations separate
  async function readActivity(target: DavoInstanceQualifiedTargetV1): Promise<DavoActivityFrontierV1 | undefined> {
    return target.instanceId === instanceId ? await readLocal(target) : await remote?.read(target);
  }

  // reconcile exact durable operation truth rather than presentation history
  async function lookup(operationId: string): Promise<DavoPromptResult> {
    const state = await store.read();
    const operation = state.operations.find(row => row.operationId === operationId);
    const request = operation === undefined ? undefined : state.requests.find(row => row.id === operation.requestId);
    // remote lookup never falls through to the local publication ledger
    if (request !== undefined && request.instanceQualifiedTarget.instanceId !== instanceId) return await remote?.lookup(request, operationId) ?? { status: 'unknown' };
    const found = await prompts.lookupOperation(operationId);
    return found?.state === 'published' ? { status: 'published', promptId: found.promptId } : { status: 'unknown' };
  }

  // publish through the existing queue and exact per-agent serializer
  async function publish(input: DavoPromptPublication): Promise<DavoPromptResult> {
    // derived continuation authority does not bypass current deployment gates
    if (closed || options.canWrite?.() === false) return { status: 'conflict' };
    // do not turn an unsupported remote target into local execution
    if (input.destinationInstanceId !== instanceId) return await remote?.publish(input) ?? { status: 'conflict' };
    const observed = await readLocal(input.target);
    // bind process, conversation and model before the serialized queue claim
    if (observed === undefined || activityEpoch(observed) !== input.targetActivityEpoch || observed.chainHeadPromptId !== input.expectedPromptChainHead) return { status: 'conflict' };
    const frontier = await prompts.activitySnapshot(input.target.agentId);
    // require the exact prepublication activity observation
    if (frontier === undefined || frontier.pending) return { status: 'conflict' };
    const result = await prompts.publishOperation({ operationKey: input.operationId, promptId: promptId(input.operationId), agentId: input.target.agentId, canonicalDestination: instanceId, payloadDigest: input.payloadDigest, targetDigest: targetDigest(input.target), generation: (await store.read()).retention.generation, davoRequestId: input.requestId, expiresAt: input.expiresAt, expectedActivityEpoch: frontier.epoch, text: input.payload }, async () => {
      const state = await store.read();
      const request = state.requests.find(candidate => candidate.id === input.requestId);
      const host = await options.target(input.target.agentId);
      return !closed && options.canWrite?.() !== false && request !== undefined && request.admittedGeneration === state.retention.generation && Date.now() < Date.parse(request.principal.expiresAt) && request.targetActivityEpoch === input.targetActivityEpoch && host !== undefined && host.processGeneration === input.target.processGeneration && host.conversationId === input.target.conversationId && host.modelId === observed.modelId;
    });
    // count only aggregate uncertain publication outcomes
    if (result.kind === 'unknown') runtime.metrics.count('publication_unknown');
    return result.kind === 'published' ? { status: 'published', promptId: result.operation.promptId } : result.kind === 'unknown' ? { status: 'unknown' } : { status: 'conflict' };
  }

  const continuation = new DavoContinuationAuthority({ store, activity: { read: readActivity }, prompts: { publish, lookup }, audit: {
    // persist payload-free continuation intent before delegated effects
    record: async event => {
      try {
        await options.audit.record({ phase: event.phase === 'intent' ? 'intent' : 'outcome', timestamp: event.time, durationMs: 0, correlationId: event.operationId, principalHash: createHash('sha256').update(event.originInstanceId).digest('hex'), clientId: 'davo-continuation', tool: event.kind, scopes: ['status:read', 'prompts:write'], risk: 'write', argumentsDigest: event.targetFingerprint, result: event.phase === 'intent' ? 'pending' : event.phase === 'accepted' ? 'success' : 'error' });
        return true;
      } catch { return false; }
    }
  } });

  const coordinator = new DavoCoordinator({ store, continuation, activity: { read: readActivity }, lifecycle: { lookup: lifecycle }, evaluator: {
    // keep the provider advisory, text-only and isolated to one immutable request
    evaluate: async input => {
      const envelope = input.envelope ?? { requestId: input.requestId, promptId: input.promptId, outcome: 'partial' as const, criteria: input.criteria.map(criterion => ({ id: criterion.id, status: 'unknown' as const, evidence: '' })), checks: [], remaining: ['No validated completion envelope was returned.'] };
      const text = buildEvaluationInput({ originalRequest: input.originalRequest, criteria: input.criteria, completionEnvelope: envelope, safeExcerpt: input.safeExcerpt });
      const result = await options.evaluator.evaluate({ input: text, generation: input.generation, signal: abort.signal });
      // provider failure cannot synthesize execution authority
      if (!result.ok) throw new Error(result.code);
      return result.value;
    }
  } });

  const tools = createDavoTools({ live: runtime.live,
    // freeze canonical target and its exact prepublication chain
    resolveTarget: async (input, principal, turn) => {
      // signed configured peer discovery freezes remote canonical identity
      if (input.instanceId !== undefined && input.instanceId !== instanceId) {
        const state = await store.read();
        const original = state.messages.find(message => message.id === turn.messageId);
        // remote discovery is bounded by the original admitted utterance
        if (original === undefined || remote === undefined) return undefined;
        const discovered = await remote.probe(input.instanceId, input.agentId, input.worktreeId, expiryForAnchor(original.retentionAnchorAt));
        return { ...discovered.target, instanceId: input.instanceId, targetActivityEpoch: discovered.targetActivityEpoch, expectedPromptChainHead: discovered.expectedPromptChainHead };
      }
      const host = await options.target(input.agentId);
      // require a current authorized worktree, not a guessed display label
      if (host === undefined || host.worktreeId !== input.worktreeId || principal.places !== undefined && !principal.places({ id: input.worktreeId, projectId: host.projectId })) return undefined;
      const state = await store.read();
      const original = state.messages.find(message => message.id === turn.messageId);
      // expired user text cannot admit a target
      if (original === undefined) return undefined;
      await prompts.watchActivity(input.agentId, expiryForAnchor(original.retentionAnchorAt));
      const { modelId: _modelId, ...fixed } = host;
      const provisional = { ...fixed, instanceId, targetActivityEpoch: 'pending', expectedPromptChainHead: 'pending' };
      const frontier = await readActivity(provisional);
      return frontier === undefined || frontier.pendingExternalMutation !== undefined ? undefined : { ...fixed, instanceId, targetActivityEpoch: activityEpoch(frontier), expectedPromptChainHead: frontier.chainHeadPromptId };
    },
    // persist the original request and continuation before queuing normal agent work
    delegate: async input => {
      const state = await store.read();
      const original = state.messages.find(message => message.id === input.turn.messageId && message.kind === 'user');
      // capture exact retained original and issuance-time scopes
      if (original === undefined || !input.principal.scopes.includes('status:read') || !input.principal.scopes.includes('prompts:write')) return developerFailure('davo_generation_changed', 'This audio request is no longer eligible.');
      const requestId = `davo-${original.id}`;
      const criteria = input.criteria.map((statement, index) => ({ id: `criterion-${index + 1}`, statement }));
      const operationId = `${requestId}-original`;
      const payload = renderDavoOriginalV1({ version: 1, requestId, originalRequest: original.text, criterionSetVersion: 1, criteria, requiredChecks: input.requiredChecks });
      const { instanceId: destination, ...target } = input.target;
      const principal = { principalKind: 'davo-continuation' as const, principalOwnerHash: runtime.live.current().ownerHash, originInstanceId: instanceId, destinationInstanceId: destination, admittedAt: new Date().toISOString(), expiresAt: expiryForAnchor(original.retentionAnchorAt), sourceScopeSnapshot: ['status:read', 'prompts:write'] as ['status:read', 'prompts:write'], target, rights: ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] as ['correlated-prompt:observe', 'same-chain-followup:enqueue', 'davo-chat:append', 'davo-notification:enqueue'] };
      const request = await coordinator.admit({ requestId, originalMessageId: original.id, criteria, requiredChecks: input.requiredChecks, target: input.target, principal, operationId, payloadDigest: continuationPayloadDigest(payload) }, () => { runtime.live.capability(input.principal.leaseKey!, input.turn.capability); return true; });
      const result = await continuation.publish({ requestId, expectedRevision: request.revision, operationId, kind: 'original-delegation', payload, payloadDigest: continuationPayloadDigest(payload) });
      // begin bounded exact lookup without replay after an uncertain send
      if (result.status === 'unknown') await coordinator.markPublicationUnknown(requestId, operationId);
      // never claim delegation on uncertain or rejected publication
      if (result.status !== 'published') return developerFailure(`davo_${result.status === 'unknown' ? 'publication_unknown' : 'target_chain_changed'}`, 'The request was not confirmed as published.');
      await coordinator.markPublished(requestId, operationId, result.promptId, await readActivity(input.target));
      return developerSuccess({ accepted: true, request_id: requestId, prompt_id: result.promptId });
    },
    // relay only a newly spoken answer to the exact current question
    relay: async input => {
      runtime.live.capability(input.principal.leaseKey!, input.turn.capability);
      const ownerHash = runtime.live.current().ownerHash;
      let after: DavoActivityFrontierV1 | undefined;
      // remote answers require a distinct freshly signed live principal, never grant rights alone
      if (input.target.instanceId !== instanceId) {
        const state = await store.read();
        const message = state.messages.find(row => row.id === input.turn.messageId && row.kind === 'user');
        // never reconstruct live consent from background request text
        if (message === undefined || remote === undefined || options.canWrite?.() === false) return developerFailure('davo_voice_inactive', 'The explicit answer is no longer eligible.');
        runtime.live.capability(input.principal.leaseKey!, input.turn.capability);
        const result = await remote.relay({ target: input.target, principalOwnerHash: ownerHash, admittedMessageId: message.id, admittedAt: message.createdAt, turnId: input.turn.id, operationId: input.operationId, questionId: input.questionId, answer: input.answer });
        after = result.frontier;
      } else {
        const question = await options.question(input.target.agentId);
        // stale questions and out-of-range answers never reach the agent
        if (question?.id !== input.questionId || 'index' in input.answer && input.answer.index >= question.choices.length) return developerFailure('davo_question_changed', 'That exact Agent question is no longer pending.');
        const before = await readActivity(input.target);
        // the question answer cannot move to a replaced process or chain
        if (before === undefined || activityEpoch(before) !== input.target.targetActivityEpoch) return developerFailure('davo_target_chain_changed', 'The Agent changed before the answer.');
        const state = await store.read();
        const ownedQuestion = state.requests.some(request => request.instanceQualifiedTarget.instanceId === instanceId && request.instanceQualifiedTarget.agentId === input.target.agentId && request.principal.principalOwnerHash === ownerHash && request.attention?.kind === 'agent_question' && request.attention.questionId === input.questionId);
        const accepted = await options.answerQuestion(input.target.agentId, input.questionId, input.answer, () => { try { runtime.live.capability(input.principal.leaseKey!, input.turn.capability); return options.canWrite?.() !== false; } catch { return false; } }, ownedQuestion);
        // preserve the pending choice after rejected or uncertain answers
        if (!accepted) return developerFailure('davo_question_changed', 'The answer was not accepted.');
        after = await readActivity(input.target);
      }
      await store.transact(state => {
        // only the exact answered request gains new user-authorized chain evidence
        for (const request of state.requests) {
          // keep unrelated requests and original expiry untouched
          if (request.attention?.kind !== 'agent_question' || request.attention.questionId !== input.questionId || request.principal.principalOwnerHash !== ownerHash || request.instanceQualifiedTarget.agentId !== input.target.agentId || after === undefined || after.chainHeadPromptId !== request.expectedPromptChainHead) continue;
          const eventId = request.notification?.outcome === 'choice' ? request.notification.eventId : undefined;
          // expire only the consumed question notification
          for (const notification of state.notificationOutbox) {
            if (eventId !== undefined && notification.requestId === request.id && notification.eventId === eventId && (notification.state === 'ready' || notification.state === 'dispatching')) notification.state = 'expired';
          }
          request.notification = undefined;
          request.attention = undefined;
          request.state = 'awaiting-agent';
          request.revision += 1;
          request.targetActivityEpoch = activityEpoch(after);
          request.instanceQualifiedTarget.targetActivityEpoch = request.targetActivityEpoch;
        }
      });
      return developerSuccess({ answered: true });
    },
    // continuation choices need their own exact explicit-answer transition
    answerChoice: async input => {
      const state = await store.read();
      const request = state.requests.find(candidate => candidate.id === input.requestId);
      // the current human owner must explicitly answer this retained choice
      if (request === undefined || request.principal.principalOwnerHash !== runtime.live.current().ownerHash || !['authorize-one-more-batch', 'stop-followup', 'resume-after-current-chain', 'wait-for-evidence'].includes(input.answer)) return developerFailure('davo_choice_changed', 'That exact continuation choice is not available.');
      const result = await coordinator.answerChoice({ requestId: request.id, choiceId: input.choiceId, option: input.answer as 'authorize-one-more-batch' | 'stop-followup' | 'resume-after-current-chain' | 'wait-for-evidence', generation: state.retention.generation, frontier: await readActivity(request.instanceQualifiedTarget) }, () => { runtime.live.capability(input.principal.leaseKey!, input.turn.capability); return true; });
      return result.status === 'stale' || result.status === 'expired' ? developerFailure('davo_choice_changed', 'That exact continuation choice is no longer pending.') : developerSuccess({ accepted: true, status: result.status });
    }
  });

  // bound one exact answer excerpt without splitting unicode scalars
  function excerpt(text: string | undefined): string | undefined {
    // absent answers have no recoverable model context
    if (text === undefined) return undefined;
    const redacted = redactIntegrationText(text);
    let value = '';
    let bytes = 0;
    // select a whole scalar prefix within the evidence budget
    for (const character of redacted) {
      const size = utf8Bytes(character);
      // stop without retaining any out-of-budget suffix
      if (bytes + size > 8192) break;
      value += character;
      bytes += size;
    }
    return value;
  }

  // reconstruct lifecycle only from the exact durable prompt operation
  async function lifecycle(request: DavoRequestV1): Promise<DavoLifecycleReceipt | undefined> {
    // never substitute another prompt for an unpublished operation
    if (request.dispatch.state !== 'published') return undefined;
    const common = { requestId: request.id, operationId: request.dispatch.operationId, promptId: request.dispatch.promptId, generation: request.admittedGeneration, requestRevision: request.revision, targetActivityEpoch: request.targetActivityEpoch };
    // a remote lifecycle is a newly authenticated exact logical receipt
    if (request.instanceQualifiedTarget.instanceId !== instanceId) {
      const receipt = await remote?.lifecycle(request);
      // active remote work is not completion evidence
      if (receipt === undefined || !['completed', 'failed', 'question'].includes(receipt.state) || receipt.operationId !== request.dispatch.operationId || receipt.targetActivityEpoch !== request.targetActivityEpoch) return undefined;
      return { ...common, state: receipt.state === 'question' ? 'question' : receipt.state === 'completed' ? 'completed' : 'failed', completionEnvelope: receipt.completionEnvelope, safeExcerpt: receipt.safeExcerpt, question: receipt.question };
    }
    const operation = await prompts.lookupOperation(request.dispatch.operationId);
    // require every durable identity component, not the latest agent output
    if (operation?.state !== 'published' || operation.promptId !== request.dispatch.promptId || operation.agentId !== request.instanceQualifiedTarget.agentId || operation.davoRequestId !== request.id) return undefined;
    // terminal receipts survive process-local phase and presentation eviction
    if (operation.lifecycle?.state === 'ended') {
      const history = await options.history.findExact(promptScope(operation.agentId), operation.operationKey, operation.promptId);
      return { ...common, state: operation.lifecycle.outcome === 'completed' ? 'completed' : 'failed', completionEnvelope: readDavoCompletion(history?.answer), safeExcerpt: excerpt(history?.answer) };
    }
    const question = await options.question(operation.agentId);
    const host = await options.target(operation.agentId);
    // only a delivered correlated prompt may own an observed pending question
    if (question === undefined || host === undefined || operation.lifecycle?.state !== 'delivered') return undefined;
    return { ...common, state: 'question', question: { questionId: question.id, question: question.text, agentProcessGeneration: host.processGeneration, answerShape: question.choices.length === 0 ? 'text' : 'single-choice', ...(question.choices.length === 0 ? {} : { choices: question.choices }) } };
  }

  // recover only an exact correlated terminal prompt receipt
  async function terminal(request: DavoRequestV1, answer: string | undefined, outcome: string): Promise<void> {
    // incomplete publication metadata cannot authorize evaluation
    if (request.dispatch.state !== 'published' || request.dispatch.promptId === undefined) return;
    // coalesce lifecycle duplicates without blocking provider cutoff timers
    if (running.has(request.id)) return;
    running.add(request.id);
    try { await coordinator.acceptLifecycle({ requestId: request.id, operationId: request.dispatch.operationId, promptId: request.dispatch.promptId, generation: request.admittedGeneration, requestRevision: request.revision, targetActivityEpoch: request.targetActivityEpoch, state: outcome === 'completed' ? 'completed' : 'failed', completionEnvelope: readDavoCompletion(answer), safeExcerpt: excerpt(answer) }); }
    finally { running.delete(request.id); }
  }

  const unobserve = prompts.observePromptLifecycle({
    // correlate by stable prompt and operation ids, never the latest agent answer
    ended: async event => {
      const state = await store.read();
      const operation = event.operationKey === undefined ? undefined : await prompts.lookupOperation(event.operationKey);
      // remote destinations persist only exact correlated logical lifecycle bodies
      if (operation?.promptId === event.promptId) await remote?.recordLifecycle({ requestId: operation.davoRequestId, operationId: operation.operationKey, promptId: event.promptId, state: event.outcome === 'completed' ? 'completed' : 'failed', safeExcerpt: excerpt(event.answer), completionEnvelope: readDavoCompletion(event.answer) });
      const request = state.requests.find(candidate => candidate.dispatch.state === 'published' && candidate.dispatch.promptId === event.promptId && (event.operationKey === undefined || candidate.dispatch.operationId === event.operationKey));
      // ignore unrelated, expired and already consumed lifecycle rows
      if (request === undefined || request.state !== 'awaiting-agent') return;
      await terminal(request, event.answer, event.outcome);
    }
  });

  // rebuild context from retained raw sources without summarizing an expired day forward
  async function compact(): Promise<void> {
    const state = await store.read();
    // attempt at most once per generation and preserve a deterministic fallback
    if (compactedGeneration === state.retention.generation || state.retention.context !== undefined) return;
    compactedGeneration = state.retention.generation;
    const fallback = buildFallbackContext(state);
    runtime.metrics.count('seed_fallbacks');
    await store.transact(draft => {
      // a racing sweep owns its own fresh context
      if (draft.retention.generation !== state.retention.generation) return;
      draft.retention.context = fallback;
    });
    // an empty retained window needs no provider processing
    if (state.messages.length === 0) return;
    const source = buildCompactorSource(state);
    const result = await options.evaluator.complete({ input: source.text, generation: source.generation, signal: abort.signal });
    // failed or over-budget compaction keeps the already persisted fallback
    if (!result.ok || utf8Bytes(result.value) > 8192) return;
    const accepted = await store.transact(draft => {
      // validate generation and raw-source provenance under the durable frontier
      if (draft.retention.generation !== source.generation) return false;
      draft.retention.context = acceptCompactedContext(draft, { generation: source.generation, builtAt: new Date().toISOString(), sourceMessageIds: source.sourceMessageIds, sourceRetentionAnchorDates: source.sourceRetentionAnchorDates, text: result.value }, source.sourceMessageIds);
      return true;
    });
    // record only a durably accepted replacement
    if (accepted) runtime.metrics.count('compactions');
  }

  return { tools, coordinator, continuation, readActivity, remote,
    // reconcile publication uncertainty without blind prompt retries
    tick: async () => {
      // shutdown cannot start a new evaluator or publication
      if (closed) return;
      const state = await store.read();
      // prune bounded operational metadata only once per completed retention generation
      if (prunedGeneration !== state.retention.generation) { await operations.pruneExpired(); prunedGeneration = state.retention.generation; }
      // inspect only retained davo requests
      for (const request of state.requests) {
        // an in-process evaluator already owns this exact request
        if (running.has(request.id)) continue;
        // exact published operation receipts survive queue/history presentation eviction
        if (request.state === 'dispatching' || request.state === 'awaiting-agent' || request.state === 'evaluating' || request.state === 'operational-blocked' && request.dispatch.state !== 'published') {
          running.add(request.id);
          let result: Awaited<ReturnType<DavoCoordinator['reconcile']>>;
          try { result = await coordinator.reconcile(request.id); }
          finally { running.delete(request.id); }
          // bind only a durable exact published receipt
          if (result.status === 'choice') runtime.metrics.count('choices');
          if (result.status === 'published') await coordinator.markPublished(request.id, request.dispatch.operationId, result.promptId, await readActivity(request.instanceQualifiedTarget));
        }
      }
      // recover exact destination questions and ends after a restart or observer race
      for (const grant of state.remoteGrants) {
        // origin mirrors do not own destination lifecycle evidence
        if (remote === undefined || grant.destinationInstanceId !== instanceId) continue;
        const publications = grant.operationReceiptBodies.filter(row => row.body.kind === 'prompt-operation-receipt' && row.body.result === 'published' && row.body.promptId !== undefined);
        // inspect each exact owned prompt rather than a latest-response fallback
        for (const publication of publications) {
          // narrow the strict logical receipt before operation lookup
          if (publication.body.kind !== 'prompt-operation-receipt' || publication.body.promptId === undefined) continue;
          const operation = await operations.lookupByPrompt(publication.body.promptId);
          // no lifecycle exists before exact destination publication
          if (operation?.state !== 'published' || operation.davoRequestId !== grant.requestId) continue;
          // recover the precise terminal answer from ordinary prompt history
          if (operation.lifecycle?.state === 'ended') {
            const history = await options.history.findExact(promptScope(operation.agentId), operation.operationKey, operation.promptId);
            await remote.recordLifecycle({ requestId: grant.requestId, operationId: operation.operationKey, promptId: operation.promptId, state: operation.lifecycle.outcome === 'completed' ? 'completed' : 'failed', safeExcerpt: excerpt(history?.answer), completionEnvelope: readDavoCompletion(history?.answer) });
            continue;
          }
          const question = await options.question(operation.agentId);
          const host = await options.target(operation.agentId);
          // only a delivered owned prompt can surface a live remote question
          if (question !== undefined && host !== undefined && operation.lifecycle?.state === 'delivered') await remote.recordLifecycle({ requestId: grant.requestId, operationId: operation.operationKey, promptId: operation.promptId, state: 'question', question: { questionId: question.id, question: question.text, agentProcessGeneration: host.processGeneration, answerShape: question.choices.length === 0 ? 'text' : 'single-choice', ...(question.choices.length === 0 ? {} : { choices: question.choices }) } });
        }
      }
      await compact();
    },
    // abort isolated provider work without canceling ordinary agents
    close: () => { closed = true; abort.abort(); unobserve(); }
  };
}
