import { createHash } from 'node:crypto';
import { utf8Bytes, type DavoInstanceQualifiedTargetV1, type DavoRequestV1 } from './contracts.js';
import { DavoStore } from './store.js';

const maximumPromptBytes = 40_960;

export type DavoActivityFrontierV1 = {
  instanceId: string;
  agentId: string;
  promptActivityRevision: number;
  chainHeadPromptId: string;
  processGeneration: number;
  conversationId?: string;
  modelId?: string;
  handoverRevision: number;
  pendingExternalMutation?: string;
};

export type DavoPromptPublication = {
  operationId: string;
  promptId: string;
  requestId: string;
  destinationInstanceId: string;
  target: DavoInstanceQualifiedTargetV1;
  targetActivityEpoch: string;
  expectedPromptChainHead: string;
  payload: string;
  payloadDigest: string;
  canonicalPayload?: string;
  expiresAt: string;
};

export type DavoPromptResult =
  | { status: 'published'; promptId: string; activity?: DavoActivityFrontierV1 }
  | { status: 'unknown' }
  | { status: 'conflict' };

export type DavoContinuationResult = DavoPromptResult | { status: 'diverged' } | { status: 'expired' };

export type DavoContinuationAuditEvent = {
  operationId: string;
  kind: 'original-delegation' | 'followup';
  originInstanceId: string;
  destinationInstanceId: string;
  targetFingerprint: string;
  generation: number;
  requestRevision: number;
  phase: 'intent' | 'accepted' | 'rejected' | 'unknown';
  time: string;
};

export type DavoContinuationOptions = {
  store: DavoStore;
  activity: { read(target: DavoInstanceQualifiedTargetV1): Promise<DavoActivityFrontierV1 | undefined> };
  prompts: {
    publish(input: DavoPromptPublication): Promise<DavoPromptResult>;
    lookup(operationId: string): Promise<DavoPromptResult>;
  };
  audit: { record(event: DavoContinuationAuditEvent): Promise<boolean> };
  now?: () => Date;
};

export type DavoContinuationPublishInput = {
  requestId: string;
  expectedRevision: number;
  operationId: string;
  kind: 'original-delegation' | 'followup';
  payload: string;
  payloadDigest: string;
  canonicalPayload?: string;
};

// hash one exact continuation payload
export function continuationPayloadDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// derive one caller-stable prompt identity
export function continuationPromptId(operationId: string): string {
  return `davo-${createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 40)}`;
}

// hash the complete content-free activity tuple
export function activityEpoch(frontier: DavoActivityFrontierV1): string {
  const canonical = JSON.stringify({
    instanceId: frontier.instanceId,
    agentId: frontier.agentId,
    promptActivityRevision: frontier.promptActivityRevision,
    chainHeadPromptId: frontier.chainHeadPromptId,
    processGeneration: frontier.processGeneration,
    conversationId: frontier.conversationId ?? null,
    modelId: frontier.modelId ?? null,
    handoverRevision: frontier.handoverRevision,
    pendingExternalMutation: frontier.pendingExternalMutation ?? null
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// fingerprint one frozen target without content
function targetFingerprint(target: DavoInstanceQualifiedTargetV1): string {
  return createHash('sha256').update(JSON.stringify(target), 'utf8').digest('hex');
}

// compare the complete frozen target frontier
function frontierMatches(request: DavoRequestV1, frontier: DavoActivityFrontierV1 | undefined): boolean {
  // require a stable observed frontier
  if (frontier === undefined || frontier.pendingExternalMutation !== undefined) return false;
  const target = request.instanceQualifiedTarget;
  return frontier.instanceId === target.instanceId
    && frontier.agentId === target.agentId
    && frontier.processGeneration === target.processGeneration
    && frontier.conversationId === target.conversationId
    && frontier.chainHeadPromptId === request.expectedPromptChainHead
    && activityEpoch(frontier) === request.targetActivityEpoch;
}

// locate one exact request snapshot
function requestFrom(state: Awaited<ReturnType<DavoStore['read']>>, requestId: string): DavoRequestV1 | undefined {
  return state.requests.find(request => request.id === requestId);
}

export class DavoContinuationAuthority {
  private readonly store: DavoStore;
  private readonly activity: DavoContinuationOptions['activity'];
  private readonly prompts: DavoContinuationOptions['prompts'];
  private readonly audit: DavoContinuationOptions['audit'];
  private readonly now: () => Date;

  // retain only narrow continuation ports
  constructor(options: DavoContinuationOptions) {
    this.store = options.store;
    this.activity = options.activity;
    this.prompts = options.prompts;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
  }

  // reconcile a durable uncertain publication without replay
  async lookup(requestId: string, operationId: string): Promise<DavoContinuationResult> {
    const snapshot = await this.store.read();
    const request = requestFrom(snapshot, requestId);
    const operation = snapshot.operations.find(candidate => candidate.operationId === operationId && candidate.requestId === requestId);
    // reject missing or expired authority
    if (request === undefined || operation === undefined || this.now().getTime() >= Date.parse(request.principal.expiresAt)) return { status: 'expired' };
    // replay a known terminal receipt
    if (operation.state === 'published' && operation.promptId !== undefined) return { status: 'published', promptId: operation.promptId };
    const result = await this.prompts.lookup(operationId);
    // persist only exact lookup truth
    await this.store.transact(state => {
      const stored = state.operations.find(candidate => candidate.operationId === operationId && candidate.requestId === requestId);
      // ignore a stale lookup after expiry or replacement
      if (stored === undefined || stored.payloadDigest !== operation.payloadDigest) return;
      stored.state = result.status === 'published' ? 'published' : result.status === 'unknown' ? 'unknown' : stored.state;
      // retain the stable prompt identity
      if (result.status === 'published') stored.promptId = result.promptId;
    });
    return result;
  }

  // publish one exact same-chain prompt at most once
  async publish(input: DavoContinuationPublishInput): Promise<DavoContinuationResult> {
    // reject detached or oversized executable bytes
    if (utf8Bytes(input.payload) > maximumPromptBytes || continuationPayloadDigest(input.payload) !== input.payloadDigest) return { status: 'conflict' };
    const current = await this.store.read();
    const request = requestFrom(current, input.requestId);
    // require the exact current request revision
    if (request === undefined || request.revision !== input.expectedRevision || request.admittedGeneration !== current.retention.generation) return { status: 'conflict' };
    // stop authority at immutable expiry
    if (this.now().getTime() >= Date.parse(request.principal.expiresAt)) return { status: 'expired' };
    const existing = current.operations.find(operation => operation.operationId === input.operationId);
    // reconcile exact existing operations
    if (existing !== undefined) {
      // reject semantic key reuse
      if (existing.requestId !== input.requestId || existing.payloadDigest !== input.payloadDigest || existing.kind !== input.kind) return { status: 'conflict' };
      // return a completed receipt directly
      if (existing.state === 'published' && existing.promptId !== undefined) return { status: 'published', promptId: existing.promptId };
      // never replay a possibly-started publication
      if (existing.state === 'publishing' || existing.state === 'unknown') return this.lookup(input.requestId, input.operationId);
    } else {
      await this.store.transact(state => {
        const exact = requestFrom(state, input.requestId);
        // reject stale admission under the mutation frontier
        if (exact === undefined || exact.revision !== input.expectedRevision || exact.admittedGeneration !== state.retention.generation) throw new Error('stale davo request');
        state.operations.push({
          operationId: input.operationId,
          requestId: input.requestId,
          destinationInstanceId: exact.principal.destinationInstanceId,
          kind: input.kind,
          generation: state.retention.generation,
          targetActivityEpoch: exact.targetActivityEpoch,
          payloadDigest: input.payloadDigest,
          state: 'prepared',
          createdAt: this.now().toISOString(),
          expiresAt: exact.principal.expiresAt
        });
      });
    }
    const beforeEffect = await this.store.read();
    const exact = requestFrom(beforeEffect, input.requestId);
    // stop after a concurrent sweep or request change
    if (exact === undefined || exact.revision !== input.expectedRevision || exact.admittedGeneration !== beforeEffect.retention.generation) return { status: 'expired' };
    const observed = await this.activity.read(exact.instanceQualifiedTarget);
    // refuse unrelated or pending activity
    if (!frontierMatches(exact, observed)) return { status: 'diverged' };
    const auditBase = {
      operationId: input.operationId,
      kind: input.kind,
      originInstanceId: exact.principal.originInstanceId,
      destinationInstanceId: exact.principal.destinationInstanceId,
      targetFingerprint: targetFingerprint(exact.instanceQualifiedTarget),
      generation: exact.admittedGeneration,
      requestRevision: exact.revision,
      time: this.now().toISOString()
    };
    let intentAudited = false;
    try {
      intentAudited = await this.audit.record({ ...auditBase, phase: 'intent' });
    } catch {
      intentAudited = false;
    }
    // block effects without durable intent audit
    if (!intentAudited) return { status: 'unknown' };
    const claimed = await this.store.transact(state => {
      const storedRequest = requestFrom(state, input.requestId);
      const operation = state.operations.find(candidate => candidate.operationId === input.operationId && candidate.state === 'prepared');
      // linearize against cutoff and competing operations
      if (storedRequest === undefined || operation === undefined || storedRequest.revision !== input.expectedRevision || storedRequest.admittedGeneration !== state.retention.generation) return false;
      operation.state = 'publishing';
      storedRequest.coordination.activeOperationId = input.operationId;
      return true;
    });
    // stop if the durable claim lost
    if (!claimed) return { status: 'conflict' };
    const immediate = await this.activity.read(exact.instanceQualifiedTarget);
    // close the final pre-publication activity race
    if (!frontierMatches(exact, immediate) || this.now().getTime() >= Date.parse(exact.principal.expiresAt)) {
      await this.store.transact(state => {
        const operation = state.operations.find(candidate => candidate.operationId === input.operationId && candidate.state === 'publishing');
        const storedRequest = requestFrom(state, input.requestId);
        // release the no-effect claim without replay ambiguity
        if (operation !== undefined) operation.state = 'prepared';
        // clear only the exact active operation marker
        if (storedRequest?.coordination.activeOperationId === input.operationId) storedRequest.coordination.activeOperationId = undefined;
      });
      return { status: 'diverged' };
    }
    let result: DavoPromptResult;
    try {
      result = await this.prompts.publish({
        operationId: input.operationId,
        promptId: continuationPromptId(input.operationId),
        requestId: input.requestId,
        destinationInstanceId: exact.principal.destinationInstanceId,
        target: exact.instanceQualifiedTarget,
        targetActivityEpoch: exact.targetActivityEpoch,
        expectedPromptChainHead: exact.expectedPromptChainHead,
        payload: input.payload,
        payloadDigest: input.payloadDigest,
        ...(input.canonicalPayload === undefined ? {} : { canonicalPayload: input.canonicalPayload }),
        expiresAt: exact.principal.expiresAt
      });
      // reject a substituted prompt identity
      if (result.status === 'published' && result.promptId !== continuationPromptId(input.operationId)) result = { status: 'conflict' };
    } catch {
      result = { status: 'unknown' };
    }
    const phase = result.status === 'published' ? 'accepted' : result.status === 'unknown' ? 'unknown' : 'rejected';
    let audited = false;
    try {
      audited = await this.audit.record({ ...auditBase, phase, time: this.now().toISOString() });
    } catch {
      audited = false;
    }
    // treat missing outcome audit as uncertain
    if (!audited) result = { status: 'unknown' };
    await this.store.transact(state => {
      const operation = state.operations.find(candidate => candidate.operationId === input.operationId && candidate.requestId === input.requestId);
      const storedRequest = requestFrom(state, input.requestId);
      // ignore late results after expiry cleanup
      if (operation === undefined || storedRequest === undefined || operation.payloadDigest !== input.payloadDigest) return;
      operation.state = result.status === 'published' ? 'published' : 'unknown';
      // retain exact prompt receipt only
      if (result.status === 'published') operation.promptId = result.promptId;
      storedRequest.coordination.activeOperationId = undefined;
      storedRequest.dispatch = result.status === 'published'
        ? { state: 'published', operationId: input.operationId, payloadDigest: input.payloadDigest, promptId: result.promptId }
        : { state: 'unknown', operationId: input.operationId, payloadDigest: input.payloadDigest };
    });
    return result;
  }
}
