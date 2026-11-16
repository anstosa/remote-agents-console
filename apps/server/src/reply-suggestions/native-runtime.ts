import { createHash } from 'node:crypto';
import { nativeReplyScope } from './native-scope.js';
import { NativeWorkerProcessRunner, type NativeAccountObservation, type NativeGenerationResult, type NativeProcessRunner } from './native-process.js';
import type { ReplySuggestion } from '../domain/models.js';
import type { NativeReplySuggestionSource, NativeReplyScope, ReplySuggestionSource } from './types.js';
import { parseReplySuggestions } from './validation.js';

type RouteState = { logicalIdentity: string; epoch: number };
type CachedObservation = { expiresAt: number; observation?: NativeAccountObservation };
type ActiveOperation = { signal: AbortSignal; done: () => void };

type NativeReplySuggestionRuntimeOptions = {
  environment?: NodeJS.ProcessEnv;
  runner?: NativeProcessRunner;
  inspectScope?: (kind: 'codex' | 'omx' | 'claude', process: { pid: number; startTime: string }, environment: NodeJS.ProcessEnv, conversationId?: string, transport?: 'tmux' | 'structured') => Promise<NativeReplyScope | undefined>;
  now?: () => number;
  metadataTtlMs?: number;
};

const maximumRouteStates = 128;
const maximumMetadataEntries = 128;
const maximumInspections = 16;
const failedMetadataTtlMs = 5_000;

// compare one source with the native family it is allowed to bill
function expectedKind(source: NativeReplySuggestionSource): 'codex' | 'claude' {
  return source.kind === 'claude' ? 'claude' : 'codex';
}

// identify one process profile independently from mutable credentials
function stableScopeKey(scope: NativeReplyScope): string {
  return createHash('sha256').update(JSON.stringify([
    scope.kind, scope.program, scope.home, scope.configDir, scope.process.pid, scope.process.startTime
  ])).digest('base64url');
}

// hash one private logical route without exposing its account identity
function routeHash(scope: NativeReplyScope, source: NativeReplySuggestionSource, observation: NativeAccountObservation, epoch: number, routeGeneration: string): string {
  return createHash('sha256').update(JSON.stringify([
    scope.fingerprint, source.model.model, source.nativeModel.provider, source.nativeModel.id, source.model.effort,
    observation.logicalIdentity, observation.profile, observation.programVersion,
    observation.capabilityGeneration, observation.credentialGeneration, routeGeneration, epoch
  ])).digest('base64url');
}

// retain one most-recent bounded map entry
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  // refresh insertion order for existing entries
  if (map.has(key)) map.delete(key);
  // evict oldest entries before adding another
  while (map.size >= maximum) {
    const oldest = map.keys().next().value as K | undefined;
    // an empty map needs no eviction
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, value);
}

// isolate native own-subscription inference from every managed pi route
export class NativeReplySuggestionRuntime {
  private readonly routeStates = new Map<string, RouteState>();
  private readonly metadata = new Map<string, CachedObservation>();
  private readonly inspections = new Map<string, Promise<NativeAccountObservation | undefined>>();
  private readonly active = new Set<AbortController>();
  private readonly environment: NodeJS.ProcessEnv;
  private readonly inspectScope: NonNullable<NativeReplySuggestionRuntimeOptions['inspectScope']>;
  private readonly now: () => number;
  private readonly metadataTtlMs: number;
  private readonly runner: NativeProcessRunner;
  private stopped = false;

  // keep process and metadata seams explicit for fake-native coverage
  constructor(options: NativeReplySuggestionRuntimeOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.runner = options.runner ?? new NativeWorkerProcessRunner({ environment: this.environment });
    this.inspectScope = options.inspectScope ?? nativeReplyScope;
    this.now = options.now ?? Date.now;
    this.metadataTtlMs = options.metadataTtlMs ?? 5 * 60_000;
  }

  // identify the exact process, account, model and policy generation
  async routeFingerprint(source: ReplySuggestionSource): Promise<string | undefined> {
    // reject pi and stopped runtimes before process or account inspection
    if (source.kind === 'pi' || this.stopped) return undefined;
    const operation = this.operation(AbortSignal.timeout(5_000));
    // a stopped runtime cannot begin another helper
    if (operation === undefined) return undefined;
    try {
      return await this.observeRoute(source, operation.signal);
    } finally {
      operation.done();
    }
  }

  // generate once on the route observed by the coordinator
  async generate(source: ReplySuggestionSource, signal: AbortSignal, expectedFingerprint: string): Promise<ReplySuggestion[]> {
    // reject pi and stopped runtimes before process or account inspection
    if (source.kind === 'pi' || this.stopped) return [];
    const operation = this.operation(signal);
    // cancelled work cannot launch another helper
    if (operation === undefined) return [];
    try {
      const scope = await this.currentScope(source);
      const generation = this.runner.routeGeneration();
      // reject stale process or helper generations
      if (scope === undefined || generation === undefined) return [];
      const observation = await this.inspect(scope, source, operation.signal, generation);
      // require one exact current own-account route
      if (observation === undefined) return [];
      const fingerprint = this.fingerprint(scope, source, observation, generation);
      // stale observations never spend another native request
      if (fingerprint !== expectedFingerprint || operation.signal.aborted) return [];
      const result = await this.runner.generate(scope, source, operation.signal, observation.logicalIdentity, generation);
      // failed preflight retires cached metadata before another attempt
      if (!this.accepts(result, source, observation) || result.finalText === undefined) {
        this.metadata.delete(this.metadataKey(scope, source, generation));
        return [];
      }
      const suggestions = parseReplySuggestions(result.finalText);
      // malformed output is an all-or-nothing failure
      if (suggestions === undefined) return [];
      const afterScope = await this.currentScope(source);
      const afterGeneration = this.runner.routeGeneration();
      // process, credential and helper generations cannot change during publication
      if (afterScope?.fingerprint !== scope.fingerprint || afterGeneration !== generation || operation.signal.aborted) return [];
      return suggestions;
    } catch {
      return [];
    } finally {
      operation.done();
    }
  }

  // observe one current route for an external source-validity fence
  async validate(source: ReplySuggestionSource, signal: AbortSignal): Promise<boolean> {
    // reject pi and stopped runtimes before account inspection
    if (source.kind === 'pi' || this.stopped) return false;
    const operation = this.operation(signal);
    // cancelled work cannot launch another helper
    if (operation === undefined) return false;
    try {
      return await this.observeRoute(source, operation.signal).then(value => value !== undefined).catch(() => false);
    } finally {
      operation.done();
    }
  }

  // abort only helpers owned by this runtime
  stop(): void {
    // repeated shutdown is inert
    if (this.stopped) return;
    this.stopped = true;
    // cancel every private metadata or generation helper
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.inspections.clear();
    this.metadata.clear();
    this.routeStates.clear();
  }

  // combine caller cancellation with runtime-owned shutdown
  private operation(signal: AbortSignal): ActiveOperation | undefined {
    // stopped or already-cancelled work cannot begin
    if (this.stopped || signal.aborted) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let finished = false;
    return {
      signal: controller.signal,
      done: () => {
        // release this operation once
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        this.active.delete(controller);
      }
    };
  }

  // resolve the exact currently live native cli process
  private async currentScope(source: NativeReplySuggestionSource): Promise<NativeReplyScope | undefined> {
    const kind = source.kind === 'omx' ? 'codex' : source.kind;
    // the stored scope kind must match the native executable family
    if (source.nativeScope.kind !== kind) return undefined;
    const current = await this.inspectScope(kind, source.nativeScope.process, this.environment, source.conversationId, source.transport);
    // a route never borrows a replacement executable, credential generation or profile
    if (current?.fingerprint !== source.nativeScope.fingerprint || current.program !== source.nativeScope.program || current.home !== source.nativeScope.home || current.configDir !== source.nativeScope.configDir) return undefined;
    return current;
  }

  // resolve and hash one account route
  private async observeRoute(source: NativeReplySuggestionSource, signal: AbortSignal): Promise<string | undefined> {
    const scope = await this.currentScope(source);
    const generation = this.runner.routeGeneration();
    // unreadable process or helper identity cannot expose generation
    if (scope === undefined || generation === undefined) return undefined;
    const observation = await this.inspect(scope, source, signal, generation);
    return observation === undefined ? undefined : this.fingerprint(scope, source, observation, generation);
  }

  // compose one cache key from cheap mutable generation fences
  private metadataKey(scope: NativeReplyScope, source: NativeReplySuggestionSource, generation: string): string {
    return `${scope.fingerprint}\0${source.model.model}\0${source.nativeModel.id}\0${source.model.effort ?? ''}\0${generation}`;
  }

  // coalesce dashboard metadata without spawning a helper fleet
  private async inspect(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal, generation: string): Promise<NativeAccountObservation | undefined> {
    const key = this.metadataKey(scope, source, generation);
    const cached = this.metadata.get(key);
    // reuse metadata only while every cheap generation remains current
    if (cached !== undefined && cached.expiresAt > this.now()) {
      setBounded(this.metadata, key, cached, maximumMetadataEntries);
      return cached.observation;
    }
    const pending = this.inspections.get(key);
    // share an already-running helper rather than spawning a fleet
    if (pending !== undefined) return await pending;
    // bound concurrent metadata helpers across dashboard churn
    if (this.inspections.size >= maximumInspections) return undefined;
    const inspection = this.runner.inspect(scope, source, signal, generation).then(observation => {
      const accepted = observation !== undefined && this.matchesObservation(observation, source) ? observation : undefined;
      const ttl = accepted === undefined ? Math.min(this.metadataTtlMs, failedMetadataTtlMs) : this.metadataTtlMs;
      setBounded(this.metadata, key, { expiresAt: this.now() + ttl, observation: accepted }, maximumMetadataEntries);
      return accepted;
    }).catch(() => undefined).finally(() => {
      // an older completion cannot remove a newer inspection
      if (this.inspections.get(key) === inspection) this.inspections.delete(key);
    });
    this.inspections.set(key, inspection);
    return await inspection;
  }

  // update an aba-resistant logical-account epoch
  private fingerprint(scope: NativeReplyScope, source: NativeReplySuggestionSource, observation: NativeAccountObservation, generation: string): string {
    const key = stableScopeKey(scope);
    const previous = this.routeStates.get(key);
    let epoch = previous?.epoch ?? 0;
    // account switches advance even when a later switch returns to the first account
    if (previous !== undefined && previous.logicalIdentity !== observation.logicalIdentity) epoch += 1;
    setBounded(this.routeStates, key, { logicalIdentity: observation.logicalIdentity, epoch }, maximumRouteStates);
    return routeHash(scope, source, observation, epoch, generation);
  }

  // require the exact native family and current selection
  private matchesObservation(observation: NativeAccountObservation, source: NativeReplySuggestionSource): boolean {
    const kind = expectedKind(source);
    const provider = kind === 'codex' ? 'openai' : 'anthropic';
    return observation.kind === kind
      && observation.provider === provider
      && source.nativeModel.provider === provider
      && (kind === 'claude' || source.nativeModel.id === source.model.model)
      && typeof source.model.model === 'string'
      && source.model.model.length > 0
      && typeof source.model.effort === 'string'
      && source.model.effort.length > 0
      && observation.model === source.nativeModel.id
      && observation.effort === source.model.effort
      && observation.logicalIdentity.length === 64
      && /^[a-f0-9]{64}$/u.test(observation.logicalIdentity)
      && observation.profile === (kind === 'codex' ? 'chatgpt' : 'claude-pro');
  }

  // reject every fallback, effect and nonterminal helper result
  private accepts(result: NativeGenerationResult, source: NativeReplySuggestionSource, observation: NativeAccountObservation): boolean {
    return result.status === 'completed'
      && result.terminalStatus === 'completed'
      && result.kind === observation.kind
      && result.provider === observation.provider
      && result.model === source.nativeModel.id
      && result.effort === source.model.effort
      && result.accountBefore === observation.logicalIdentity
      && result.accountAfter === observation.logicalIdentity
      && result.finalAnswerCount === 1
      && result.toolEvents === 0
      && result.rerouteEvents === 0
      && result.serverRequests === 0
      && result.errorEvents === 0
      && result.cleanupComplete
      && !result.historyPersisted;
  }
}
