import { createHash } from 'node:crypto';
import { claudeReplyConversation, type ClaudeReplyConversation } from '../adapters/claude-conversations.js';
import { codexReplyConversation, type CodexReplyConversation } from '../adapters/codex-conversations.js';
import type { TmuxReplySuggestionTarget } from '../discovery/service.js';
import { nativeReplyScope } from './native-scope.js';
import { readClaudeReplyObserverState, type ClaudeReplyObserverState, type ClaudeReplyPolicySnapshot, type ClaudeReplySourcePolicyTracker } from './claude-observer.js';
import type { NativeReplyScope, NativeReplySuggestionSource } from './types.js';

type DiscoverySource = {
  replySuggestionTarget(id: string): TmuxReplySuggestionTarget | undefined;
  validateReplySuggestionTarget(target: TmuxReplySuggestionTarget): Promise<boolean>;
};

type TmuxReplySuggestionSourcesOptions = {
  environment?: NodeJS.ProcessEnv;
  claudePolicy?: ClaudeReplySourcePolicyTracker;
  validationTimeoutMs?: number;
  validationPollMs?: number;
  inspectNativeScope?: typeof nativeReplyScope;
};

type NativeSnapshot = {
  conversationId: string;
  model: string;
  provider: 'openai' | 'anthropic';
  effort: string;
  messages: NativeReplySuggestionSource['messages'];
  transcriptGeneration: string;
  observer?: ClaudeReplyObserverState;
  policy?: ClaudeReplyPolicySnapshot;
};

type Observation = {
  target: TmuxReplySuggestionTarget;
  nativeScope: NativeReplyScope;
  observer?: Omit<ClaudeReplyObserverState, 'heartbeatSeq'>;
  validatedHeartbeat?: number;
};

type Generation = { fingerprint: string; source: number; processKey: string; process: number };

const maximumObservations = 512;

// hash one private source identity without exposing its component paths
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

// compare one native scope by every nonsecret route field
function sameScope(left: NativeReplyScope, right: NativeReplyScope): boolean {
  return left.kind === right.kind && left.program === right.program && left.home === right.home && left.configDir === right.configDir
    && left.process.pid === right.process.pid && left.process.startTime === right.process.startTime && left.fingerprint === right.fingerprint;
}

// exclude heartbeat-only churn from Claude source identity
function observerIdentity(state: ClaudeReplyObserverState): Omit<ClaudeReplyObserverState, 'heartbeatSeq'> {
  const { heartbeatSeq: _heartbeatSeq, ...identity } = state;
  return identity;
}

// test exact observer epochs while allowing a later heartbeat
function sameObserver(left: Omit<ClaudeReplyObserverState, 'heartbeatSeq'>, right: ClaudeReplyObserverState): boolean {
  return JSON.stringify(left) === JSON.stringify(observerIdentity(right));
}

// wait for a bounded poll or abort without retaining listeners
async function pollDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve(true);
    }, milliseconds);
    // abort one pending validation wait
    const aborted = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(false);
    };
    signal.addEventListener('abort', aborted, { once: true });
  });
}

// provide exact current tmux sources without starting native inference
export class TmuxReplySuggestionSources {
  private readonly generations = new Map<string, Generation>();
  private readonly observations = new Map<string, Observation>();
  private readonly validations = new Map<string, Promise<boolean>>();
  private sourceCounter = 0;
  private processCounter = 0;

  constructor(private readonly discovery: DiscoverySource, private readonly options: TmuxReplySuggestionSourcesOptions = {}) {}

  // observe one exact current conversation, model, process and profile generation
  async source(id: string): Promise<NativeReplySuggestionSource | undefined> {
    const target = this.discovery.replySuggestionTarget(id);
    // only a finished native answer can offer reply drafts
    if (target === undefined || target.id !== id || target.attention !== 'finished') return undefined;
    const snapshot = await this.snapshot(target);
    // incomplete transcript or current-model evidence fails closed
    if (snapshot === undefined) return undefined;
    const inspect = this.options.inspectNativeScope ?? nativeReplyScope;
    const scope = await inspect(target.kind, target.process, this.options.environment, snapshot.conversationId).catch(() => undefined);
    // bind the source to its actual native program and profile
    if (scope === undefined || (target.kind === 'claude' ? scope.kind !== 'claude' : scope.kind !== 'codex')) return undefined;
    if (snapshot.policy !== undefined && scope.configDir !== snapshot.policy.sourceConfigDir) return undefined;
    const snapshotFingerprint = this.snapshotFingerprint(target, scope, snapshot);
    const processKey = fingerprint([target.process, scope.process, scope.program]);
    const generation = this.nextGeneration(id, snapshotFingerprint, processKey);
    const runtimeGeneration = fingerprint([scope.fingerprint, snapshot.policy?.policyNonce, snapshot.policy?.generation]);
    const identity = fingerprint([id, generation.source, generation.process, snapshotFingerprint, runtimeGeneration]);
    const source: NativeReplySuggestionSource = {
      agentId: id,
      identity,
      sourceGeneration: generation.source,
      processGeneration: generation.process,
      runtimeGeneration,
      conversationId: snapshot.conversationId,
      model: { model: snapshot.model, effort: snapshot.effort },
      messages: snapshot.messages,
      kind: target.kind,
      transport: 'tmux',
      nativeModel: { provider: snapshot.provider, id: snapshot.model },
      nativeScope: scope
    };
    this.remember(identity, {
      target,
      nativeScope: scope,
      ...(snapshot.observer === undefined ? {} : { observer: observerIdentity(snapshot.observer), validatedHeartbeat: snapshot.observer.heartbeatSeq })
    });
    return source;
  }

  // serialize validation so one heartbeat cannot satisfy two causal barriers
  async validate(source: NativeReplySuggestionSource, signal: AbortSignal): Promise<boolean> {
    // reject structured and unknown source objects at the tmux boundary
    if (source.transport !== 'tmux' || (source.kind !== 'codex' && source.kind !== 'omx' && source.kind !== 'claude') || signal.aborted) return false;
    const prior = this.validations.get(source.identity) ?? Promise.resolve(true);
    const validation = prior.catch(() => false).then(async () => await this.validateCurrent(source, signal));
    this.validations.set(source.identity, validation);
    return await validation.finally(() => {
      // an older completion must not release a newer queued barrier
      if (this.validations.get(source.identity) === validation) this.validations.delete(source.identity);
    });
  }

  // validate process, profile, transcript and a fresh Claude status heartbeat
  private async validateCurrent(source: NativeReplySuggestionSource, signal: AbortSignal): Promise<boolean> {
    const observed = this.observations.get(source.identity);
    // only an in-process observation can authorize native work
    if (observed === undefined || signal.aborted || !await this.discovery.validateReplySuggestionTarget(observed.target)) return false;
    const inspect = this.options.inspectNativeScope ?? nativeReplyScope;
    const scope = await inspect(observed.target.kind, observed.target.process, this.options.environment, source.conversationId).catch(() => undefined);
    // process or profile ABA invalidates the barrier
    if (scope === undefined || !sameScope(scope, observed.nativeScope)) return false;
    if (observed.observer !== undefined) {
      const fresh = await this.awaitClaudeHeartbeat(source.conversationId, observed, signal);
      // missing, changed or timed-out status evidence fails closed
      if (fresh === undefined) return false;
      observed.validatedHeartbeat = fresh.heartbeatSeq;
    }
    const current = await this.source(source.agentId);
    // re-read every transcript and source epoch after the causal barrier
    return !signal.aborted && current?.identity === source.identity && await this.discovery.validateReplySuggestionTarget(observed.target);
  }

  // wait on the monotonic native status counter rather than a fixed refresh delay
  private async awaitClaudeHeartbeat(conversationId: string, observed: Observation, signal: AbortSignal): Promise<ClaudeReplyObserverState | undefined> {
    const policy = this.options.claudePolicy?.snapshot();
    // a profile event or unavailable watcher invalidates all old launch acknowledgements
    if (policy === undefined || observed.observer === undefined || observed.observer.policyNonce !== policy.policyNonce) return undefined;
    const baseline = observed.validatedHeartbeat ?? 0;
    const deadline = Date.now() + (this.options.validationTimeoutMs ?? 5_000);
    // poll only until the native heartbeat crosses this validation's baseline
    while (!signal.aborted && Date.now() < deadline) {
      const state = await readClaudeReplyObserverState(policy.observerDir, conversationId);
      // changed epochs cannot be hidden by a later equal model tuple
      if (state !== undefined && !sameObserver(observed.observer, state)) return undefined;
      if (state !== undefined && state.heartbeatSeq > baseline) return state;
      // abort promptly while waiting for the next native status invocation
      if (!await pollDelay(this.options.validationPollMs ?? 25, signal)) return undefined;
    }
    return undefined;
  }

  // read one native kind's exact bounded current snapshot
  private async snapshot(target: TmuxReplySuggestionTarget): Promise<NativeSnapshot | undefined> {
    if (target.kind === 'claude') return await this.claudeSnapshot(target);
    const conversation = await codexReplyConversation({
      pid: target.panePid,
      cwd: target.cwd,
      ...(target.conversationId === undefined ? {} : { conversationId: target.conversationId })
    });
    // native model routing supports only the exact first-party provider
    if (conversation === undefined || conversation.provider !== 'openai') return undefined;
    return this.codexSnapshot(conversation);
  }

  // shape one exact Codex rollout snapshot
  private codexSnapshot(conversation: CodexReplyConversation): NativeSnapshot {
    return {
      conversationId: conversation.conversationId,
      model: conversation.model,
      provider: 'openai',
      effort: conversation.effort,
      messages: conversation.messages,
      transcriptGeneration: conversation.transcriptGeneration
    };
  }

  // combine Claude transcript evidence with the controlled status observer
  private async claudeSnapshot(target: TmuxReplySuggestionTarget): Promise<NativeSnapshot | undefined> {
    const policy = this.options.claudePolicy?.snapshot();
    // no watched approved profile means Claude alone is unavailable
    if (policy === undefined || target.conversationId === undefined) return undefined;
    const [conversation, observer] = await Promise.all([
      claudeReplyConversation(target.conversationId, target.cwd, this.options.environment),
      readClaudeReplyObserverState(policy.observerDir, target.conversationId)
    ]);
    // require the first post-SessionStart status line and no unacknowledged model hook
    if (conversation === undefined || observer === undefined || observer.policyNonce !== policy.policyNonce || observer.heartbeatSeq < 1
      || observer.processPid !== target.process.pid || observer.processStartTime !== target.process.startTime
      || observer.pendingModelSwitch || observer.statusHookSeq !== observer.hookSeq) return undefined;
    return this.claudeSnapshotValue(conversation, observer, policy);
  }

  // shape one exact Claude transcript and observer generation
  private claudeSnapshotValue(conversation: ClaudeReplyConversation, observer: ClaudeReplyObserverState, policy: ClaudeReplyPolicySnapshot): NativeSnapshot {
    return {
      conversationId: conversation.conversationId,
      model: observer.model,
      provider: 'anthropic',
      effort: observer.effort,
      messages: conversation.messages,
      transcriptGeneration: conversation.transcriptGeneration,
      observer,
      policy
    };
  }

  // include every monotonic source dimension except heartbeat-only liveness
  private snapshotFingerprint(target: TmuxReplySuggestionTarget, scope: NativeReplyScope, snapshot: NativeSnapshot): string {
    return fingerprint([
      target.generation,
      target.kind,
      target.process,
      scope.fingerprint,
      snapshot.conversationId,
      snapshot.model,
      snapshot.provider,
      snapshot.effort,
      snapshot.transcriptGeneration,
      snapshot.observer === undefined ? undefined : observerIdentity(snapshot.observer),
      snapshot.policy?.generation,
      snapshot.policy?.policyNonce
    ]);
  }

  // advance source and process generations only on concrete identity changes
  private nextGeneration(id: string, sourceFingerprint: string, processKey: string): Generation {
    const previous = this.generations.get(id);
    const next: Generation = {
      fingerprint: sourceFingerprint,
      source: previous?.fingerprint === sourceFingerprint ? previous.source : ++this.sourceCounter,
      processKey,
      process: previous?.processKey === processKey ? previous.process : ++this.processCounter
    };
    // refresh recency without changing a stable generation
    this.generations.delete(id);
    this.generations.set(id, next);
    // bounded eviction cannot revive an old identity because global counters never reset
    while (this.generations.size > maximumObservations) this.generations.delete(this.generations.keys().next().value!);
    return next;
  }

  // bound validation metadata without retaining transcript content
  private remember(identity: string, observation: Observation): void {
    const prior = this.observations.get(identity);
    // preserve an already-consumed heartbeat baseline across identical observations
    if (prior?.validatedHeartbeat !== undefined && observation.validatedHeartbeat !== undefined) observation.validatedHeartbeat = Math.max(prior.validatedHeartbeat, observation.validatedHeartbeat);
    this.observations.delete(identity);
    this.observations.set(identity, observation);
    // evict oldest inactive source identities
    while (this.observations.size > maximumObservations) this.observations.delete(this.observations.keys().next().value!);
  }
}
