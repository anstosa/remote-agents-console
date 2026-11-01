import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { piStateDir } from '../adapters/pi-sandbox.js';
import { SettingsError } from './contracts.js';

/** One Pi chat model that the Conductor settings page can select. */
type ConductorModel = { id: string; name: string; provider: string };

type RuntimeModel = { id: string; name: string; provider: string; type?: string };
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
  runtime?: () => Promise<CatalogRuntime>;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
// use Pi's normal stored and environment credentials while keeping catalogs in memory
async function createRuntime(): Promise<CatalogRuntime> {
  return await ModelRuntime.create({
    authPath: join(piStateDir(process.env), 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false
  });
}

/** A short-lived, deduplicated view of Pi's authenticated network model catalog. */
export class ConductorModelCatalog {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly signal: (timeoutMs: number) => AbortSignal;
  private readonly runtimeFactory: () => Promise<CatalogRuntime>;
  private runtime?: Promise<CatalogRuntime>;
  private cached?: { at: number; models: ConductorModel[] };
  private inFlight?: Promise<ConductorModel[]>;

  // retain only bounded process-memory state between settings requests
  constructor(options: CatalogOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.signal = options.signal ?? AbortSignal.timeout;
    this.runtimeFactory = options.runtime ?? createRuntime;
  }

  // serve one fresh catalog load to every concurrent browser request
  async list(): Promise<ConductorModel[]> {
    const cached = this.cached;
    // reuse only catalogs inside the bounded freshness window
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return cached.models;
    // share the active network refresh instead of issuing duplicate API calls
    if (this.inFlight !== undefined) return await this.inFlight;
    const pending = this.load();
    this.inFlight = pending;
    try {
      const models = await pending;
      this.cached = { at: this.now(), models };
      return models;
    } finally {
      // clear only the load this invocation installed
      if (this.inFlight === pending) this.inFlight = undefined;
    }
  }

  // retry SDK initialization after a transient credential or filesystem failure
  private async currentRuntime(): Promise<CatalogRuntime> {
    // create the shared lazy runtime only when the catalog is first requested
    if (this.runtime === undefined) {
      const pending = this.runtimeFactory();
      this.runtime = pending;
      void pending.catch(() => {
        // clear only the failed runtime generation
        if (this.runtime === pending) this.runtime = undefined;
      });
    }
    return await this.runtime;
  }

  // refresh authentication first, then force Pi's published provider catalogs over the network
  private async load(): Promise<ConductorModel[]> {
    try {
      const runtime = await this.currentRuntime();
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
      const models = new Map<string, ConductorModel>();
      // return only authenticated chat models and preserve Pi's catalog order
      for (const model of available) {
        // mixed catalogs can also contain image or classifier models
        if (model.type !== undefined && model.type !== 'chat') continue;
        // discard providers that were not credentialed for this refresh
        if (!selected.has(model.provider)) continue;
        const id = `${model.provider}/${model.id}`;
        // keep one entry for each provider/model identity
        if (!models.has(id)) models.set(id, { id, name: model.name || model.id, provider: model.provider });
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
