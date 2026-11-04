import { join } from 'node:path';
import { homedir } from 'node:os';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { piStateDir } from '../adapters/pi-sandbox.js';
import { piEfforts } from '../transports/pi.js';
import type { ModelSetting } from '../transports/structured.js';
import { SettingsError } from './contracts.js';

/** One Pi chat model that the Conductor settings page can select. */
type ConductorModel = { id: string; name: string; provider: string };
/** one Pi chat model with its supported Efforts for launch controls. */
export type PiCatalogModel = ConductorModel & { efforts: string[] };

type RuntimeModel = { id: string; name: string; provider: string; type?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> };
type RefreshResult = { aborted: boolean; errors: ReadonlyMap<string, Error> };
type CatalogRuntime = {
  getProviders(): readonly { id: string }[];
  getError(): string | undefined;
  hasConfiguredAuth(providerId: string): boolean;
  refresh(options: { allowNetwork: boolean; providers?: readonly string[]; force?: boolean; signal?: AbortSignal }): Promise<RefreshResult>;
  getAvailable(providerId?: string, options?: { signal?: AbortSignal }): Promise<readonly RuntimeModel[]>;
};
type CatalogOptions = {
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  signal?: (timeoutMs: number) => AbortSignal;
  runtime?: (env: NodeJS.ProcessEnv) => Promise<CatalogRuntime>;
  settings?: (cwd: string, stateDir: string) => Pick<SettingsManager, 'getDefaultProvider' | 'getDefaultModel' | 'getDefaultThinkingLevel' | 'getModelThinkingLevel'>;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CATALOG_CONTEXTS = 32;
// mirror pinned Pi 1.5.0 DEFAULT_THINKING_LEVEL
const PINNED_PI_DEFAULT_EFFORT = 'medium';

// resolve the effective Pi state without mutating process env
function effectivePiStateDir(env: NodeJS.ProcessEnv): string {
  // preserve Pi's explicit state override
  if (env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR !== '') return piStateDir(env);
  return join(env.HOME ?? homedir(), '.pi', 'agent');
}

// use Pi's normal stored and environment credentials while keeping catalogs in memory
async function createRuntime(env: NodeJS.ProcessEnv): Promise<CatalogRuntime> {
  return await ModelRuntime.create({
    authPath: join(effectivePiStateDir(env), 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false
  });
}

// match Pi's supported-thinking projection
function modelEfforts(model: RuntimeModel): string[] {
  // non-reasoning models expose only off
  if (model.reasoning !== true) return ['off'];
  const map = model.thinkingLevelMap ?? {};
  return piEfforts.filter(level => map[level] !== null && ((level !== 'xhigh' && level !== 'max') || map[level] !== undefined));
}

// mirror pinned pi-ai 1.5.0 clampThinkingLevel over projected levels
function clampPiEffort(efforts: readonly string[], requested: string): string {
  // preserve supported requests exactly
  if (efforts.includes(requested)) return requested;
  const requestedIndex = piEfforts.indexOf(requested as (typeof piEfforts)[number]);
  // unknown requests use the first canonical supported level
  if (requestedIndex === -1) return piEfforts.find(level => efforts.includes(level)) ?? 'off';
  // prefer the next supported level at or above the request
  for (let index = requestedIndex; index < piEfforts.length; index += 1) {
    const candidate = piEfforts[index]!;
    if (efforts.includes(candidate)) return candidate;
  }
  // otherwise fall back to the nearest lower supported level
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = piEfforts[index]!;
    if (efforts.includes(candidate)) return candidate;
  }
  return 'off';
}

/** A short-lived, deduplicated view of Pi's authenticated network model catalog. */
export class ConductorModelCatalog {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly signal: (timeoutMs: number) => AbortSignal;
  private readonly runtimeFactory: (env: NodeJS.ProcessEnv) => Promise<CatalogRuntime>;
  private readonly settingsFactory: NonNullable<CatalogOptions['settings']>;
  private readonly contexts = new Map<string, { runtime?: Promise<CatalogRuntime>; cached?: { at: number; models: PiCatalogModel[] }; inFlight?: Promise<PiCatalogModel[]> }>();

  // retain only bounded process-memory state between settings requests
  constructor(options: CatalogOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.signal = options.signal ?? AbortSignal.timeout;
    this.runtimeFactory = options.runtime ?? createRuntime;
    this.settingsFactory = options.settings ?? ((cwd: string, stateDir: string) => SettingsManager.create(cwd, stateDir));
  }

  // serve one fresh catalog load to every concurrent browser request
  async list(): Promise<ConductorModel[]> {
    return (await this.listDetailed()).map(model => ({ id: model.id, name: model.name, provider: model.provider }));
  }

  /** serve Pi model metadata to launch controls without changing the Conductor route. */
  async listDetailed(env: Record<string, string> = {}): Promise<PiCatalogModel[]> {
    const effectiveEnv = { ...process.env, ...env };
    const key = effectivePiStateDir(effectiveEnv);
    let context = this.contexts.get(key);
    // create one bounded state bucket per effective Pi account
    if (context === undefined) {
      context = {};
      this.contexts.set(key, context);
      // evict the oldest native account context
      if (this.contexts.size > MAX_CATALOG_CONTEXTS) this.contexts.delete(this.contexts.keys().next().value!);
    }
    const cached = context.cached;
    // reuse only catalogs inside the bounded freshness window
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return cached.models;
    // share the active network refresh instead of issuing duplicate API calls
    if (context.inFlight !== undefined) return await context.inFlight;
    const pending = this.load(context, effectiveEnv);
    context.inFlight = pending;
    try {
      const models = await pending;
      context.cached = { at: this.now(), models };
      return models;
    } finally {
      // clear only the load this invocation installed
      if (context.inFlight === pending) context.inFlight = undefined;
    }
  }

  /** resolve Pi's cwd-specific configured default without choosing the first catalog entry. */
  defaultSetting(cwd: string, env: Record<string, string> = {}): ModelSetting | undefined {
    try {
      const settings = this.settings(cwd, env);
      const provider = settings.getDefaultProvider();
      const model = settings.getDefaultModel();
      // require both halves of Pi's exact identity
      if (provider === undefined || model === undefined) return undefined;
      const effort = settings.getModelThinkingLevel(provider, model) ?? settings.getDefaultThinkingLevel();
      return { model: `${provider}/${model}`, ...(effort === undefined ? {} : { effort }) };
    } catch {
      // unreadable settings make the native identity opaque
      return undefined;
    }
  }

  /** resolve Pi's effective per-model Efforts without catalog or launch side effects. */
  configuredEfforts(cwd: string, models: readonly PiCatalogModel[], env: Record<string, string> = {}): Record<string, string> {
    try {
      const settings = this.settings(cwd, env);
      const global = settings.getDefaultThinkingLevel();
      const configured: Record<string, string> = {};
      // resolve each exact provider/model independently
      for (const model of models) {
        const separator = model.id.indexOf('/');
        // ignore malformed identities rather than inventing settings keys
        if (separator <= 0 || separator === model.id.length - 1) continue;
        const perModel = settings.getModelThinkingLevel(model.id.slice(0, separator), model.id.slice(separator + 1));
        const requested = perModel ?? global ?? PINNED_PI_DEFAULT_EFFORT;
        const effort = clampPiEffort(model.efforts, requested);
        // omit models whose runtime-supported default remains unknown
        if (model.efforts.includes(effort)) configured[model.id] = effort;
      }
      return configured;
    } catch {
      // unreadable settings expose no configured metadata
      return {};
    }
  }

  // bind settings reads to the exact cwd and effective Pi account
  private settings(cwd: string, env: Record<string, string>): ReturnType<NonNullable<CatalogOptions['settings']>> {
    return this.settingsFactory(cwd, effectivePiStateDir({ ...process.env, ...env }));
  }

  // retry SDK initialization after a transient credential or filesystem failure
  private async currentRuntime(context: { runtime?: Promise<CatalogRuntime> }, env: NodeJS.ProcessEnv): Promise<CatalogRuntime> {
    // create the shared lazy runtime only when the catalog is first requested
    if (context.runtime === undefined) {
      const pending = this.runtimeFactory(env);
      context.runtime = pending;
      void pending.catch(() => {
        // clear only the failed runtime generation
        if (context.runtime === pending) context.runtime = undefined;
      });
    }
    return await context.runtime;
  }

  // refresh authentication first, then force Pi's published provider catalogs over the network
  private async load(context: { runtime?: Promise<CatalogRuntime> }, env: NodeJS.ProcessEnv): Promise<PiCatalogModel[]> {
    try {
      const runtime = await this.currentRuntime(context, env);
      const signal = this.signal(this.timeoutMs);
      const authentication = await runtime.refresh({ allowNetwork: false, signal });
      // Pi can record credential availability failures outside the refresh result
      if (authentication.aborted || authentication.errors.size > 0 || runtime.getError() !== undefined) throw new SettingsError('conductor_models_unavailable', 503);
      const providers = runtime.getProviders().map(provider => provider.id).filter(providerId => runtime.hasConfiguredAuth(providerId));
      // an installation without Pi credentials has no selectable remote models
      if (providers.length === 0) return [];
      const refreshed = await runtime.refresh({ providers, allowNetwork: true, force: true, signal });
      // never disguise a failed API refresh as Pi's smaller built-in catalog
      if (refreshed.aborted || refreshed.errors.size > 0) throw new SettingsError('conductor_models_unavailable', 503);
      const selected = new Set(providers);
      const available = await runtime.getAvailable(undefined, { signal });
      const models = new Map<string, PiCatalogModel>();
      // return only authenticated chat models and preserve Pi's catalog order
      for (const model of available) {
        // mixed catalogs can also contain image or classifier models
        if (model.type !== undefined && model.type !== 'chat') continue;
        // discard providers that were not credentialed for this refresh
        if (!selected.has(model.provider)) continue;
        const id = `${model.provider}/${model.id}`;
        // keep one entry for each provider/model identity
        if (!models.has(id)) models.set(id, { id, name: model.name || model.id, provider: model.provider, efforts: modelEfforts(model) });
      }
      return [...models.values()];
    } catch (error) {
      // expose only the fixed retryable code, never SDK or upstream text
      if (error instanceof SettingsError) throw error;
      throw new SettingsError('conductor_models_unavailable', 503);
    }
  }
}

/** The narrow dependency accepted by the settings routes. */
export type ConductorModelSource = Pick<ConductorModelCatalog, 'list'>;
/** the Pi discovery surface shared with launch options. */
export type PiModelSource = Pick<ConductorModelCatalog, 'listDetailed' | 'defaultSetting'> & Partial<Pick<ConductorModelCatalog, 'configuredEfforts'>>;
