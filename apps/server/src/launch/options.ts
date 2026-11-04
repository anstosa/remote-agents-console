import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCodexProtocolClient, initializeCodexProtocol, type CodexProtocolClient, type CodexProtocolClientFactory } from '../accounts/protocol.js';
import { agentKinds, type AdapterConfigs, type AdapterLaunchConfig, type AgentKind, type AllowedModel } from '../adapters/types.js';
import { agentModel, agentChoiceProblem } from './agent-choice.js';
import { ConductorModelCatalog, type PiModelSource } from '../settings/conductor-models.js';
import type { ModelSetting } from '../transports/structured.js';
import { nativeSecurityManifest, nativeSecurityProblem, type NativeLaunchCapabilities } from './native-options.js';
import type { LaunchCatalogModel, LaunchKindManifest, LaunchModelPolicy, LaunchOptionsResponse, LaunchSecurityManifest, ManualLaunchChoice, ModelSelection, NativeLaunchSecurity, PreparedLaunchChoice } from './options-types.js';
import { probeCodexCatalog, probeOmxCatalog, type OmxCatalogProbe } from './omx-catalog.js';
import { inheritedHomeEnvironment } from '../places/launch-home.js';

/** the server-resolved launch context used for catalog and restart defaults. */
export type LaunchOptionsContext = { targetId?: string; cwd: string; hostCwd?: string; home?: string; currentKind?: AgentKind; currentModel?: ModelSetting; restart?: boolean };
/** a bounded catalog result for one exact configured native context. */
export type LaunchCatalogSnapshot = { models: LaunchCatalogModel[]; defaultModel?: ModelSetting; effortDefaults?: Record<string, string>; status: 'ready' | 'unavailable' | 'unsupported'; message?: string };

type LaunchOptionsDependencies = {
  createCodexClient?: CodexProtocolClientFactory;
  piModels?: PiModelSource;
  now?: () => number;
  ttlMs?: number;
  deadlineMs?: number;
  capabilities?: (kind: AgentKind, config: AdapterLaunchConfig, cwd: string, home?: string) => Promise<NativeLaunchCapabilities>;
  omxProbe?: typeof probeOmxCatalog;
  codexHostProbe?: typeof probeCodexCatalog;
};

type HostSnapshot = { catalog: LaunchCatalogSnapshot; capabilities: NativeLaunchCapabilities };

type RevisionState = { id: number; version: number; fingerprint: string };
type Cached<T> = { at: number; value: T };
type Json = Record<string, unknown>;

const effortToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;
const securityToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_DEADLINE_MS = 5_000;
const MAX_CATALOG_PAGES = 10;
const MAX_CATALOG_MODELS = 500;
const MAX_CONTEXT_CACHE = 256;

const manualLaunchChoiceSchema = z.object({
  kind: z.enum(agentKinds),
  model: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('model'), id: agentModel }).strict(),
    z.object({ mode: z.literal('keep-current') }).strict(),
    z.object({ mode: z.literal('native-default') }).strict()
  ]).optional(),
  effort: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('effort'), id: z.string().regex(effortToken) }).strict(),
    z.object({ mode: z.literal('model-default') }).strict()
  ]).optional(),
  security: z.record(z.string().regex(securityToken), z.string().regex(securityToken)).refine(value => Object.keys(value).length <= 12).optional(),
  optionsRevision: z.string().max(32).regex(/^o\d+\.\d+$/u).optional(),
  sandboxed: z.boolean().optional()
}).strict();

// parse one native key-value override
function configOverride(value: string | undefined): { key: string; value: string } | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/u.exec(value);
  return match?.[1] === undefined || match[2] === undefined ? undefined : { key: match[1], value: match[2].replace(/^['"]|['"]$/gu, '') };
}

/** a stable launch-choice failure suitable for route status mapping. */
export class LaunchOptionsError extends Error {
  // retain only a stable code and status
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
    this.name = 'LaunchOptionsError';
  }
}

// narrow one protocol record
function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

// enforce one bounded protocol operation
async function withDeadline<T>(task: Promise<T>, deadlineMs: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // reject after the configured deadline
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error('native catalog timed out'));
    }, deadlineMs);
    timer.unref();
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    // clear completed deadlines
    if (timer !== undefined) clearTimeout(timer);
  }
}

// parse the last explicit Codex model and Effort overrides
function configuredCodexModel(args: readonly string[]): ModelSetting | undefined {
  let model: string | undefined;
  let effort: string | undefined;
  // scan the bounded configured argv
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    // stop before a literal prompt tail
    if (argument === '--') break;
    // accept separate model flags
    if ((argument === '-m' || argument === '--model') && args[index + 1] !== undefined && !args[index + 1]!.startsWith('-')) { model = args[index + 1]; index += 1; continue; }
    const attachedModel = /^--model=(.+)$/u.exec(argument) ?? /^-m(.+)$/u.exec(argument);
    // accept attached model flags
    if (attachedModel?.[1] !== undefined) { model = attachedModel[1]; continue; }
    let config: string | undefined;
    // accept separate generic overrides
    if ((argument === '-c' || argument === '--config') && args[index + 1] !== undefined) { config = args[index + 1]; index += 1; }
    else config = /^(?:--config=|-c=?)(.+)$/u.exec(argument)?.[1];
    const override = configOverride(config);
    // collect recognized generic values
    if (override?.key === 'model') model = override.value;
    if (override?.key === 'model_reasoning_effort') effort = override.value;
  }
  // require a safe exact model override
  if (model === undefined || !agentModel.safeParse(model).success) return undefined;
  return { model, ...(effort !== undefined && effortToken.test(effort) ? { effort } : {}) };
}

// retain only global configuration flags understood before app-server
function codexContextArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  // scan without forwarding prompts or execution flags
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    // retain separate context pairs
    if (['-c', '--config', '-p', '--profile', '--enable', '--disable'].includes(argument) && args[index + 1] !== undefined) {
      kept.push(argument, args[index + 1]!);
      index += 1;
      continue;
    }
    // translate the launch model into app-server configuration
    if ((argument === '-m' || argument === '--model') && args[index + 1] !== undefined && !args[index + 1]!.startsWith('-')) {
      kept.push('-c', `model=${args[index + 1]}`);
      index += 1;
      continue;
    }
    const attachedModel = /^--model=(.+)$/u.exec(argument) ?? /^-m(.+)$/u.exec(argument);
    // translate attached model flags
    if (attachedModel?.[1] !== undefined) { kept.push('-c', `model=${attachedModel[1]}`); continue; }
    // retain attached configuration/profile/features
    if (/^(?:-c.+|--config=.+|-p.+|--profile=.+|--enable=.+|--disable=.+|--strict-config)$/u.test(argument)) kept.push(argument);
  }
  return kept;
}

// parse one bounded Codex model page
function parseCodexPage(value: unknown): { models: LaunchCatalogModel[]; defaultModel?: ModelSetting; nextCursor?: string } {
  const result = object(value);
  // require a bounded data array
  if (!Array.isArray(result?.data) || result.data.length > 100) throw new Error('invalid native catalog');
  const models: LaunchCatalogModel[] = [];
  let defaultModel: ModelSetting | undefined;
  // validate every advertised model
  for (const raw of result.data) {
    const candidate = object(raw);
    // require one model record
    if (candidate === undefined) throw new Error('invalid native catalog');
    const id = typeof candidate?.model === 'string' ? candidate.model : candidate?.id;
    // reject malformed identifiers rather than inventing entries
    if (typeof id !== 'string' || !agentModel.safeParse(id).success) throw new Error('invalid native catalog');
    const efforts: string[] = [];
    const rawEfforts = Array.isArray(candidate.supportedReasoningEfforts) ? candidate.supportedReasoningEfforts : [];
    // collect supported safe Effort ids
    for (const rawEffort of rawEfforts) {
      const entry = object(rawEffort);
      const effort = entry?.reasoningEffort;
      // ignore only unknown forward-compatible effort records
      if (typeof effort === 'string' && effortToken.test(effort) && !efforts.includes(effort)) efforts.push(effort);
    }
    const configuredDefault = candidate.defaultReasoningEffort;
    const defaultEffort = typeof configuredDefault === 'string' && effortToken.test(configuredDefault) && efforts.includes(configuredDefault) ? configuredDefault : undefined;
    const model = { id, name: typeof candidate.displayName === 'string' && candidate.displayName.trim() !== '' ? candidate.displayName : id, efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
    models.push(model);
    // accept at most one catalog default
    if (candidate.isDefault === true) {
      if (defaultModel !== undefined) throw new Error('invalid native catalog');
      defaultModel = { model: id, ...(defaultEffort === undefined ? {} : { effort: defaultEffort }) };
    }
  }
  const cursor = result.nextCursor;
  // reject malformed cursors
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') throw new Error('invalid native catalog');
  return { models, ...(defaultModel === undefined ? {} : { defaultModel }), ...(typeof cursor === 'string' && cursor !== '' ? { nextCursor: cursor } : {}) };
}

/** discover Codex models and the effective default from the exact configured context. */
export async function discoverCodexModels(config: AdapterLaunchConfig, cwd: string, createClient: CodexProtocolClientFactory = createCodexProtocolClient, deadlineMs = DEFAULT_DEADLINE_MS, launchHome?: string): Promise<LaunchCatalogSnapshot> {
  const env = inheritedHomeEnvironment(config.env, launchHome);
  const home = env.HOME ?? process.env.HOME ?? homedir();
  const codexHome = config.env.CODEX_HOME ?? join(home, '.codex');
  let client: CodexProtocolClient | undefined;
  try {
    client = await withDeadline(createClient(codexHome, { command: config.program, args: [...codexContextArgs(config.args), 'app-server', '--listen', 'stdio://'], env, cwd }), deadlineMs);
    await withDeadline(initializeCodexProtocol(client), deadlineMs, () => void client?.close());
    const configResult = object(await withDeadline(client.request('config/read', { cwd, includeLayers: false }), deadlineMs, () => void client?.close()));
    const nativeConfig = object(configResult?.config);
    // refuse malformed effective configuration responses
    if (nativeConfig === undefined) throw new Error('invalid native catalog');
    const models: LaunchCatalogModel[] = [];
    const seen = new Set<string>();
    let catalogDefault: ModelSetting | undefined;
    let cursor: string | undefined;
    // paginate within fixed page and item limits
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const response = await withDeadline(client.request('model/list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) }), deadlineMs, () => void client?.close());
      const parsed = parseCodexPage(response);
      // retain catalog order and reject duplicate identities
      for (const model of parsed.models) {
        if (seen.has(model.id) || models.length >= MAX_CATALOG_MODELS) throw new Error('invalid native catalog');
        seen.add(model.id);
        models.push(model);
      }
      // retain the sole catalog recommendation
      if (parsed.defaultModel !== undefined) {
        if (catalogDefault !== undefined) throw new Error('invalid native catalog');
        catalogDefault = parsed.defaultModel;
      }
      cursor = parsed.nextCursor;
      // finish after the last page
      if (cursor === undefined) break;
      // refuse a cursor after the final bounded page
      if (page === MAX_CATALOG_PAGES - 1) throw new Error('invalid native catalog');
    }
    const defaultModel = resolvedCodexDefault(config.args, nativeConfig, catalogDefault);
    return { status: 'ready', models, ...(defaultModel === undefined ? {} : { defaultModel }) };
  } finally {
    // ignore bounded cleanup failures
    await client?.close().catch(() => undefined);
  }
}

// apply the same explicit, effective-config, and catalog default precedence
function resolvedCodexDefault(args: readonly string[], nativeConfig: Json, catalogDefault: ModelSetting | undefined): ModelSetting | undefined {
  const configured = configuredCodexModel(args);
  const configModel = typeof nativeConfig.model === 'string' && agentModel.safeParse(nativeConfig.model).success ? nativeConfig.model : undefined;
  const configEffort = typeof nativeConfig.model_reasoning_effort === 'string' && effortToken.test(nativeConfig.model_reasoning_effort) ? nativeConfig.model_reasoning_effort : undefined;
  return configured === undefined
    ? (configModel === undefined ? catalogDefault : { model: configModel, ...(configEffort === undefined ? {} : { effort: configEffort }) })
    : { model: configured.model, ...((configured.effort ?? configEffort) === undefined ? {} : { effort: configured.effort ?? configEffort }) };
}

// discard raw host configuration after projecting validated model metadata
function projectHostCatalog(probe: OmxCatalogProbe): LaunchCatalogSnapshot {
  const nativeConfig = object(object(probe.config)?.config);
  // the helper must return one complete bounded native snapshot
  if (nativeConfig === undefined || probe.pages.length < 1 || probe.pages.length > MAX_CATALOG_PAGES) throw new Error('invalid native catalog');
  const models: LaunchCatalogModel[] = [];
  const seen = new Set<string>();
  let catalogDefault: ModelSetting | undefined;
  // preserve pagination order and reject malformed completion boundaries
  for (const [index, raw] of probe.pages.entries()) {
    const page = parseCodexPage(raw);
    // every nonfinal page must have a cursor, and the final page must terminate
    if ((page.nextCursor === undefined) !== (index === probe.pages.length - 1)) throw new Error('invalid native catalog');
    // reject duplicate model identities before publishing any partial result
    for (const model of page.models) {
      if (seen.has(model.id) || models.length >= MAX_CATALOG_MODELS) throw new Error('invalid native catalog');
      seen.add(model.id);
      models.push(model);
    }
    // retain exactly one native recommendation across all pages
    if (page.defaultModel !== undefined) {
      if (catalogDefault !== undefined) throw new Error('invalid native catalog');
      catalogDefault = page.defaultModel;
    }
  }
  const defaultModel = resolvedCodexDefault(probe.args, nativeConfig, catalogDefault);
  return { status: 'ready', models, ...(defaultModel === undefined ? {} : { defaultModel }) };
}

// execute one configured native help probe without a shell
function nativeHelp(config: AdapterLaunchConfig, cwd: string, args: readonly string[], deadlineMs: number, launchHome?: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(launchHome === undefined ? {} : { HOME: launchHome }), ...config.env };
    delete env.RAC_OPENAI_ADMIN_KEY;
    delete env.RAC_OPENAI_API_KEY_IDS;
    execFile(config.program, [...args], { cwd, env, timeout: deadlineMs, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      // accept help output even when a CLI exits nonzero
      const output = `${stdout}${stderr}`;
      resolve(output === '' && error !== null ? undefined : output);
    });
  });
}

/** probe only documented native flags present in every required launch mode. */
async function probeNativeCapabilities(kind: AgentKind, config: AdapterLaunchConfig, cwd: string, deadlineMs = DEFAULT_DEADLINE_MS, launchHome?: string): Promise<NativeLaunchCapabilities> {
  // Pi's semantic sandbox is console-owned rather than a native flag
  if (kind === 'pi') return {};
  // OMX does not expose a help surface proving forwarded Codex flags
  if (kind === 'omx' || kind === 'opencode') return {};
  const fresh = await nativeHelp(config, cwd, ['--help'], deadlineMs, launchHome);
  // fail closed when installed help is unavailable
  if (fresh === undefined) return {};
  if (kind === 'claude') {
    const permissionValues = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
    return {
      ...(fresh.includes('--model') ? { model: true as const } : {}),
      ...(fresh.includes('--effort') ? { effort: true as const } : {}),
      ...(fresh.includes('--permission-mode') && fresh.includes('--dangerously-skip-permissions') && permissionValues.every(value => fresh.includes(value)) ? { permissions: true as const } : {})
    };
  }
  const resumed = await nativeHelp(config, cwd, ['resume', '--help'], deadlineMs, launchHome);
  // require fresh and resume grammar support
  if (resumed === undefined) return {};
  const both = (flag: string): boolean => fresh.includes(flag) && resumed.includes(flag);
  return {
    ...(both('--model') ? { model: true as const } : {}),
    ...(both('--config') ? { effort: true as const } : {}),
    ...(both('--sandbox') && ['read-only', 'workspace-write', 'danger-full-access'].every(value => fresh.includes(value) && resumed.includes(value)) ? { filesystem: true as const } : {}),
    ...(both('--ask-for-approval') && ['on-request', 'never'].every(value => fresh.includes(value) && resumed.includes(value)) ? { approvals: true as const } : {}),
    ...(both('--dangerously-bypass-approvals-and-sandbox') ? { bypass: true as const } : {})
  };
}

// produce a fixed unavailable result without native diagnostics
function unavailable(message: string): LaunchCatalogSnapshot {
  return { status: 'unavailable', models: [], message };
}

// retain insertion-bounded context state
function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  // refresh insertion order for current contexts
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  // evict the oldest context
  if (map.size > MAX_CONTEXT_CACHE) map.delete(map.keys().next().value!);
}

/** resolve configured-list, native-singleton, and opaque-default policy states. */
export function resolveLaunchModelPolicy(allowedModels: readonly AllowedModel[] | undefined, catalog: LaunchCatalogSnapshot, context: Pick<LaunchOptionsContext, 'currentKind' | 'currentModel' | 'restart'>, kind: AgentKind): LaunchModelPolicy {
  const sameRestart = context.restart === true && context.currentKind === kind && context.currentModel !== undefined;
  const exactNative = sameRestart ? context.currentModel : catalog.defaultModel;
  let policy: LaunchModelPolicy;
  // preserve explicit empty as a deny-all state
  if (allowedModels !== undefined && allowedModels.length === 0) {
    policy = { state: 'empty', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: catalog.models, catalogStatus: catalog.status, message: 'No models are allowed for this Agent.' };
  } else if (allowedModels !== undefined) {
    const allowed = allowedModels.map(entry => ({ ...entry, ...(catalog.status !== 'ready' ? {} : { available: catalog.models.some(model => model.id === entry.model) }) }));
    const keep = sameRestart && allowedModels.some(entry => entry.model === context.currentModel?.model);
    policy = { state: 'explicit', allowed, defaultSelection: keep ? { mode: 'keep-current' } : { mode: 'model', id: allowedModels[0]!.model }, catalog: catalog.models, catalogStatus: catalog.status, ...(catalog.message === undefined ? {} : { message: catalog.message }) };
  } else if (exactNative !== undefined) {
    const available = catalog.status === 'ready' ? catalog.models.some(model => model.id === exactNative.model) : undefined;
    policy = { state: 'native-default', allowed: [{ model: exactNative.model, ...(exactNative.effort === undefined ? {} : { effort: exactNative.effort }), ...(available === undefined ? {} : { available }) }], defaultSelection: sameRestart ? { mode: 'keep-current' } : { mode: 'model', id: exactNative.model }, catalog: catalog.models, catalogStatus: catalog.status, ...(catalog.message === undefined ? {} : { message: catalog.message }) };
  } else {
    policy = { state: 'native-default', allowed: [], defaultSelection: { mode: 'native-default' }, catalog: catalog.models, catalogStatus: catalog.status, ...(catalog.message === undefined ? {} : { message: catalog.message }) };
  }
  const effortDefaults: Record<string, string> = {};
  // project only supported defaults for already-selectable models
  for (const entry of policy.allowed) {
    const model = catalog.models.find(candidate => candidate.id === entry.model);
    // require catalog evidence for the model and selected Effort
    if (model === undefined) continue;
    const savedEffort = allowedModels?.find(candidate => candidate.model === entry.model)?.effort;
    const nativeEffort = catalog.effortDefaults?.[entry.model] ?? (kind === 'pi' ? undefined : catalog.defaultModel?.effort);
    const selected = [savedEffort, nativeEffort, model.defaultEffort]
      .find(candidate => candidate !== undefined && model.efforts.includes(candidate));
    // omit models whose effective default is unknown
    if (selected !== undefined) effortDefaults[entry.model] = selected;
  }
  // omit empty metadata rather than inventing a default
  if (Object.keys(effortDefaults).length > 0) policy.effortDefaults = effortDefaults;
  // label restart preservation without hiding catalog status
  if (policy.defaultSelection.mode === 'keep-current' && context.currentModel !== undefined) {
    policy.currentModel = context.currentModel.model;
    const currentCatalogModel = catalog.models.find(model => model.id === context.currentModel?.model);
    // expose only a catalog-supported current session Effort
    if (context.currentModel.effort !== undefined && currentCatalogModel?.efforts.includes(context.currentModel.effort) === true) policy.currentEffort = context.currentModel.effort;
    const keep = `Keep current — ${context.currentModel.model}`;
    policy.message = policy.message === undefined ? keep : `${keep}. ${policy.message}`;
  }
  return policy;
}

/** enforce authoritative configured Allowed-model policy for every launch path. */
export function resolveAllowedLaunchModel(kind: AgentKind, configured: AdapterLaunchConfig | undefined, requested?: ModelSetting, options: { nativeDefaultValidated?: boolean } = {}): ModelSetting | undefined {
  const allowed = configured?.allowedModels;
  // absent policy permits only a separately proven native default
  if (allowed === undefined) {
    if (requested === undefined) return undefined;
    if (options.nativeDefaultValidated === true) return requested;
    throw new LaunchOptionsError(409, 'model_not_allowed');
  }
  // explicit empty denies every launch
  if (allowed.length === 0) throw new LaunchOptionsError(409, 'model_policy_empty');
  const selected = requested === undefined ? allowed[0]! : allowed.find(entry => entry.model === requested.model);
  // reject outside models even when the caller omitted a default
  if (selected === undefined) throw new LaunchOptionsError(409, 'model_not_allowed');
  // non-Pi saved defaults require preparation's current capability proof
  const effort = requested?.effort ?? (kind === 'pi' ? selected.effort : undefined);
  return { model: selected.model, ...(effort === undefined ? {} : { effort }) };
}

/** resolve review model policy without discarding an explicit effort-only request. */
export function resolveReviewLaunchModel(kind: AgentKind, configured: AdapterLaunchConfig | undefined, request: { model?: string; effort?: string }): ModelSetting | undefined {
  const model = request.model ?? (request.effort === undefined ? undefined : configured?.allowedModels?.[0]?.model);
  const problem = agentChoiceProblem('The review', { agent: kind, ...(request.effort === undefined ? {} : { effort: request.effort }) });
  // saved syntax does not prove installed review effort support
  if (problem !== undefined) throw new LaunchOptionsError(409, 'launch_option_unsupported');
  return resolveAllowedLaunchModel(kind, configured, model === undefined ? undefined : { model, ...(request.effort === undefined ? {} : { effort: request.effort }) });
}

// select one configured or current Allowed entry
function allowedEntry(policy: LaunchModelPolicy, model: string): { model: string; effort?: string } | undefined {
  return policy.allowed.find(entry => entry.model === model);
}

// validate one semantic security selection against its manifest
function prepareSecurity(kind: AgentKind, choice: ManualLaunchChoice, manifest: LaunchSecurityManifest): NativeLaunchSecurity {
  let requested = choice.security;
  // translate only the former Pi boolean
  if (choice.sandboxed !== undefined) {
    // semantic Pi security takes precedence during rollout
    if (kind === 'pi' && requested === undefined) requested = { sandbox: choice.sandboxed ? 'on' : 'off' };
    // non-Pi false was a historical no-op
    else if (kind !== 'pi' && choice.sandboxed) throw new LaunchOptionsError(400, 'invalid_launch_choice');
  }
  const prepared: NativeLaunchSecurity = { ...manifest.defaults };
  // retain defaults for one-click launches
  if (requested === undefined) return prepared;
  // validate every requested control and option
  for (const [controlId, optionId] of Object.entries(requested)) {
    const control = manifest.controls.find(candidate => candidate.id === controlId);
    if (control === undefined || !control.options.some(option => option.id === optionId)) throw new LaunchOptionsError(409, 'launch_option_unsupported');
    prepared[controlId] = optionId;
  }
  // refuse conflicting values hidden by a coupled control
  for (const constraint of manifest.constraints) {
    const active = Object.entries(constraint.when).every(([key, value]) => prepared[key] === value);
    if (active && constraint.disables.some(key => requested?.[key] !== undefined && requested[key] !== manifest.defaults[key])) throw new LaunchOptionsError(409, 'launch_option_unsupported');
  }
  return prepared;
}

/** lazy target-bound launch catalog, policy, and semantic validation service. */
export class LaunchOptionsService {
  private readonly createCodexClient: CodexProtocolClientFactory;
  private readonly piModels: PiModelSource;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly capabilitiesLoader: NonNullable<LaunchOptionsDependencies['capabilities']>;
  private readonly omxProbe: typeof probeOmxCatalog;
  private readonly codexHostProbe: typeof probeCodexCatalog;
  private readonly hostSnapshots = new Map<string, Cached<HostSnapshot>>();
  private readonly hostFlights = new Map<string, Promise<HostSnapshot>>();
  private readonly catalogs = new Map<string, Cached<LaunchCatalogSnapshot>>();
  private readonly catalogFlights = new Map<string, Promise<LaunchCatalogSnapshot>>();
  private readonly capabilities = new Map<string, Cached<NativeLaunchCapabilities>>();
  private readonly capabilityFlights = new Map<string, Promise<NativeLaunchCapabilities>>();
  private readonly revisions = new Map<string, RevisionState>();
  private readonly revisionDiscovery = new Map<string, boolean>();
  private readonly invalidations = new Map<AgentKind, number>();
  private nextRevisionId = 1;

  // retain only bounded process-memory discovery state
  constructor(private readonly configs: AdapterConfigs, dependencies: LaunchOptionsDependencies = {}) {
    this.createCodexClient = dependencies.createCodexClient ?? createCodexProtocolClient;
    this.piModels = dependencies.piModels ?? new ConductorModelCatalog();
    this.now = dependencies.now ?? Date.now;
    this.ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
    this.deadlineMs = dependencies.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.capabilitiesLoader = dependencies.capabilities ?? (async (kind, config, cwd, home) => await probeNativeCapabilities(kind, config, cwd, this.deadlineMs, home));
    this.omxProbe = dependencies.omxProbe ?? probeOmxCatalog;
    this.codexHostProbe = dependencies.codexHostProbe ?? probeCodexCatalog;
  }

  // share discovery within the same account and native directory
  private key(kind: AgentKind, context: LaunchOptionsContext): string {
    const config = this.configs[kind];
    const native = kind === 'omx' || kind === 'codex' && process.env.RAC_HOST_TMUX_DIR !== undefined ? createHash('sha256').update(JSON.stringify([config?.program, config?.args, config?.env, process.env.RAC_HOST_PATH, process.env.RAC_HOST_NODE_BIN, process.env.RAC_HOST_REPOSITORY, process.env.RAC_HOST_TMUX_DIR])).digest('hex') : '';
    return `${kind}\u0000${context.cwd}\u0000${context.home ?? ''}\u0000${context.hostCwd ?? ''}\u0000${native}`;
  }

  // share exact host discovery between the catalog and model grammar checks
  private async hostSnapshot(kind: 'codex' | 'omx', config: AdapterLaunchConfig, context: LaunchOptionsContext): Promise<HostSnapshot> {
    const key = this.key(kind, context);
    const cached = this.hostSnapshots.get(key);
    // cache successful metadata only; retry temporary bridge failures
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return cached.value;
    const active = this.hostFlights.get(key);
    // deduplicate the catalog and capability consumers
    if (active !== undefined) return await active;
    const generation = this.invalidations.get(kind) ?? 0;
    const probe = kind === 'codex' ? this.codexHostProbe : this.omxProbe;
    const pending = probe(config, context, this.deadlineMs).then(value => ({ catalog: projectHostCatalog(value), capabilities: value.capabilities })).catch(() => ({ catalog: unavailable(`Live model discovery could not be read from the configured ${kind === 'codex' ? 'Codex' : 'OMX'} context. Retry discovery.`), capabilities: {} }));
    this.hostFlights.set(key, pending);
    try {
      const snapshot = await pending;
      // do not retain a result from a superseded account or native installation
      if (snapshot.catalog.status === 'ready' && (this.invalidations.get(kind) ?? 0) === generation) setBounded(this.hostSnapshots, key, { at: this.now(), value: snapshot });
      return snapshot;
    } finally {
      // clear only this exact discovery generation
      if (this.hostFlights.get(key) === pending) this.hostFlights.delete(key);
    }
  }

  // discover one exact kind/context
  private async loadCatalog(kind: AgentKind, config: AdapterLaunchConfig, context: LaunchOptionsContext): Promise<LaunchCatalogSnapshot> {
    // Codex has a documented dependency-free app-server catalog
    if (kind === 'codex') return process.env.RAC_HOST_TMUX_DIR === undefined
      ? await discoverCodexModels(config, context.cwd, this.createCodexClient, this.deadlineMs, context.home)
      : (await this.hostSnapshot(kind, config, context)).catalog;
    // Pi reuses its authenticated ModelRuntime catalog and cwd settings
    if (kind === 'pi') {
      const env = inheritedHomeEnvironment(config.env, context.home);
      const models = await this.piModels.listDetailed(env);
      const defaultModel = this.piModels.defaultSetting(context.cwd, env);
      const effortDefaults = this.piModels.configuredEfforts?.(context.cwd, models, env);
      return { status: 'ready', models, ...(defaultModel === undefined ? {} : { defaultModel }), ...(effortDefaults === undefined || Object.keys(effortDefaults).length === 0 ? {} : { effortDefaults }) };
    }
    // OMX resolves its own Codex account and namespace through the proven wrapper
    if (kind === 'omx') return (await this.hostSnapshot(kind, config, context)).catalog;
    if (kind === 'claude') return unavailable('Live model discovery is unavailable without a documented installed discovery integration.');
    return { status: 'unsupported', models: [], message: 'Model discovery is not implemented for this Agent.' };
  }

  // cache successful catalogs and deduplicate active loads
  private async catalog(kind: AgentKind, config: AdapterLaunchConfig, context: LaunchOptionsContext): Promise<LaunchCatalogSnapshot> {
    const key = this.key(kind, context);
    const generation = this.invalidations.get(kind) ?? 0;
    const cached = this.catalogs.get(key);
    // reuse fresh successful discovery
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return cached.value;
    const active = this.catalogFlights.get(key);
    // share one active native request
    if (active !== undefined) return await active;
    const pending = this.loadCatalog(kind, config, context);
    this.catalogFlights.set(key, pending);
    try {
      const value = await pending;
      // cache only the still-current native account generation
      if (value.status === 'ready' && (this.invalidations.get(kind) ?? 0) === generation) setBounded(this.catalogs, key, { at: this.now(), value });
      return value;
    } catch {
      // never cache native errors or expose their text
      if (kind === 'codex') return unavailable('Live model discovery is unavailable for this configured Codex context.');
      if (kind === 'pi') return unavailable('Live model discovery is unavailable for the configured Pi providers.');
      return unavailable('Live model discovery is unavailable for this Agent.');
    } finally {
      // clear only this active generation
      if (this.catalogFlights.get(key) === pending) this.catalogFlights.delete(key);
    }
  }

  // cache successful help probes and deduplicate active loads
  private async nativeCapabilities(kind: AgentKind, config: AdapterLaunchConfig, context: LaunchOptionsContext): Promise<NativeLaunchCapabilities> {
    // the host probe proves model grammar without implying security capabilities
    if (kind === 'omx' || kind === 'codex' && process.env.RAC_HOST_TMUX_DIR !== undefined) return (await this.hostSnapshot(kind, config, context)).capabilities;
    const key = this.key(kind, context);
    const generation = this.invalidations.get(kind) ?? 0;
    const cached = this.capabilities.get(key);
    // reuse fresh probe output
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return cached.value;
    const active = this.capabilityFlights.get(key);
    // share one active help probe
    if (active !== undefined) return await active;
    const pending = this.capabilitiesLoader(kind, config, context.cwd, context.home).catch(() => ({}));
    this.capabilityFlights.set(key, pending);
    try {
      const value = await pending;
      // cache only the still-current installed context generation
      if ((this.invalidations.get(kind) ?? 0) === generation) setBounded(this.capabilities, key, { at: this.now(), value });
      return value;
    } finally {
      // clear only this probe generation
      if (this.capabilityFlights.get(key) === pending) this.capabilityFlights.delete(key);
    }
  }

  // use a stable no-network snapshot for ordinary one-click preparation
  private fallbackCatalog(kind: AgentKind): LaunchCatalogSnapshot {
    // preserve truthful settled baselines by kind
    if (kind === 'opencode') return { status: 'unsupported', models: [], message: 'Model discovery is not implemented for this Agent.' };
    if (kind === 'omx') return unavailable('Live model discovery has not been requested for this configured OMX context.');
    if (kind === 'claude') return unavailable('Live model discovery is unavailable without a documented installed discovery integration.');
    if (kind === 'pi') return unavailable('Live model discovery has not been requested for the configured Pi providers.');
    return unavailable('Live model discovery has not been requested for this configured Codex context.');
  }

  // return fresh cached discovery without starting native work
  private cachedCatalog(kind: AgentKind, context: LaunchOptionsContext): LaunchCatalogSnapshot | undefined {
    const cached = this.catalogs.get(this.key(kind, context));
    // accept only the normal bounded freshness window
    return cached !== undefined && this.now() - cached.at < this.ttlMs ? cached.value : undefined;
  }

  // issue a short opaque counter when safe state changes
  private revision(key: string, fingerprint: string): string {
    const current = this.revisions.get(key);
    // allocate one target-local revision identity
    if (current === undefined) {
      const created = { id: this.nextRevisionId++, version: 1, fingerprint };
      setBounded(this.revisions, key, created);
      return `o${created.id}.${created.version}`;
    }
    // increment only after current nonsecret option state changes
    if (current.fingerprint !== fingerprint) {
      current.fingerprint = fingerprint;
      current.version += 1;
    }
    return `o${current.id}.${current.version}`;
  }

  // retain a bounded preparation-mode hint for current revisions
  private rememberRevision(revision: string, discover: boolean): void {
    this.revisionDiscovery.set(revision, discover);
    // evict the oldest obsolete hint
    if (this.revisionDiscovery.size > 512) this.revisionDiscovery.delete(this.revisionDiscovery.keys().next().value!);
  }

  // construct one current manifest
  private async manifest(kind: AgentKind, context: LaunchOptionsContext, discover = true): Promise<LaunchKindManifest> {
    const config = this.configs[kind];
    // reject unconfigured kinds before native work
    if (config === undefined) throw new LaunchOptionsError(409, 'launch_option_unsupported');
    const invalidation = this.invalidations.get(kind) ?? 0;
    const [catalog, capabilities] = await Promise.all([
      discover ? this.catalog(kind, config, context) : Promise.resolve(this.cachedCatalog(kind, context) ?? this.fallbackCatalog(kind)),
      this.nativeCapabilities(kind, config, context)
    ]);
    const modelPolicy = resolveLaunchModelPolicy(config.allowedModels, catalog, context, kind);
    const security = nativeSecurityManifest(kind, capabilities);
    // opaque coupled presets require deliberate replacement of inherited axes
    if ((kind === 'codex' || kind === 'omx') && config.args.some(argument => ['--approve-for-me', '--full-auto', '--yolo'].includes(argument))) security.message = [security.message, 'Some partial overrides are unavailable for coupled native presets. Choose both filesystem and approval settings to replace them.'].filter(Boolean).join(' ');
    const fingerprint = JSON.stringify({ invalidation, program: config.program, args: config.args, allowedModels: config.allowedModels, catalog, capabilities, currentKind: context.currentKind, currentModel: context.currentModel, restart: context.restart, modelPolicy, security });
    return { kind, optionsRevision: this.revision(`${this.key(kind, context)}\u0000${context.targetId ?? ''}`, fingerprint), modelPolicy, security };
  }

  /** list current launch options for every configured Agent kind. */
  async list(context: LaunchOptionsContext): Promise<LaunchOptionsResponse> {
    const configured = agentKinds.filter(kind => this.configs[kind] !== undefined);
    const kinds = await Promise.all(configured.map(async kind => await this.manifest(kind, context)));
    // remember menu-backed revisions for immediate preparation
    for (const manifest of kinds) this.rememberRevision(manifest.optionsRevision, true);
    return { kinds };
  }

  /** invalidate one native account/capability context after an external switch. */
  invalidate(kind?: AgentKind): void {
    const selected = kind === undefined ? agentKinds : kind === 'codex' ? ['codex', 'omx'] as const : [kind];
    // advance nonsecret context generations
    for (const candidate of selected) this.invalidations.set(candidate, (this.invalidations.get(candidate) ?? 0) + 1);
    // discard matching discovery caches
    for (const key of this.catalogs.keys()) if (selected.some(candidate => key.startsWith(`${candidate}\u0000`))) this.catalogs.delete(key);
    for (const key of this.capabilities.keys()) if (selected.some(candidate => key.startsWith(`${candidate}\u0000`))) this.capabilities.delete(key);
    for (const key of this.catalogFlights.keys()) if (selected.some(candidate => key.startsWith(`${candidate}\u0000`))) this.catalogFlights.delete(key);
    for (const key of this.capabilityFlights.keys()) if (selected.some(candidate => key.startsWith(`${candidate}\u0000`))) this.capabilityFlights.delete(key);
    // Codex account changes also invalidate OMX's underlying native account
    for (const key of this.hostSnapshots.keys()) if (selected.some(candidate => key.startsWith(`${candidate}\u0000`))) this.hostSnapshots.delete(key);
    for (const key of this.hostFlights.keys()) if (selected.some(candidate => key.startsWith(`${candidate}\u0000`))) this.hostFlights.delete(key);
  }

  /** parse and validate one manual launch choice before any side effect. */
  async prepare(kind: AgentKind, raw: unknown, context: LaunchOptionsContext): Promise<PreparedLaunchChoice> {
    const parsed = manualLaunchChoiceSchema.safeParse(raw === undefined ? { kind } : raw);
    // reject malformed or cross-kind semantic payloads
    if (!parsed.success || parsed.data.kind !== kind) throw new LaunchOptionsError(400, 'invalid_launch_choice');
    const choice = parsed.data;
    const config = this.configs[kind];
    // reject unconfigured kinds before policy selection
    if (config === undefined) throw new LaunchOptionsError(409, 'launch_option_unsupported');
    // require an explicit model semantic for an explicit Effort
    if (choice.effort?.mode === 'effort' && choice.model === undefined) throw new LaunchOptionsError(409, 'launch_option_unsupported');
    const rememberedDiscovery = choice.optionsRevision === undefined ? undefined : this.revisionDiscovery.get(choice.optionsRevision);
    const explicitPolicy = config.allowedModels !== undefined;
    const needsExplicitIdentity = choice.model?.mode === 'model' && !explicitPolicy;
    const needsEffortMetadata = choice.effort?.mode === 'effort';
    const discover = rememberedDiscovery ?? (needsExplicitIdentity || needsEffortMetadata);
    const manifest = await this.manifest(kind, context, discover);
    this.rememberRevision(manifest.optionsRevision, discover);
    // detect stale browser state without trusting a matching revision
    if (choice.optionsRevision !== undefined && choice.optionsRevision !== manifest.optionsRevision) throw new LaunchOptionsError(409, 'launch_options_stale');
    const policy = manifest.modelPolicy;
    // explicit empty blocks even one-click launches
    if (policy.state === 'empty') throw new LaunchOptionsError(409, 'model_policy_empty');
    const selected: ModelSelection = choice.model ?? policy.defaultSelection;
    let resolvedModel: string | undefined;
    let keepCurrent = false;
    let nativeDefault = false;
    // resolve exact requested models against current policy
    if (selected.mode === 'model') {
      if (allowedEntry(policy, selected.id) === undefined) throw new LaunchOptionsError(409, 'model_not_allowed');
      resolvedModel = selected.id;
    } else if (selected.mode === 'keep-current') {
      if (context.restart !== true || context.currentKind !== kind || context.currentModel === undefined || allowedEntry(policy, context.currentModel.model) === undefined) throw new LaunchOptionsError(409, 'model_not_allowed');
      resolvedModel = context.currentModel.model;
      keepCurrent = true;
    } else {
      // opaque native default permits no explicit Effort
      if (policy.state !== 'native-default' || policy.allowed.length !== 0 || choice.effort?.mode === 'effort') throw new LaunchOptionsError(409, 'launch_option_unsupported');
      nativeDefault = true;
    }
    const capabilities = await this.nativeCapabilities(kind, config, context);
    const catalogModel = resolvedModel === undefined ? undefined : policy.catalog.find(model => model.id === resolvedModel);
    let effort: string | undefined;
    // validate one explicit Effort against current model metadata
    if (choice.effort?.mode === 'effort') {
      if (policy.catalogStatus !== 'ready') throw new LaunchOptionsError(503, 'launch_options_unavailable');
      if (catalogModel === undefined || !catalogModel.efforts.includes(choice.effort.id)) throw new LaunchOptionsError(409, 'launch_option_unsupported');
      // require installed grammar proof for native Effort overrides
      if (kind !== 'pi' && capabilities.effort !== true) throw new LaunchOptionsError(409, 'launch_option_unsupported');
      effort = choice.effort.id;
    } else if (choice.effort?.mode === 'model-default' && keepCurrent) {
      // an explicit restart reset uses the proven model default
      effort = catalogModel?.defaultEffort;
    } else if ((choice.effort === undefined || choice.effort.mode === 'model-default') && !keepCurrent && resolvedModel !== undefined) {
      const configured = policy.state === 'explicit' ? allowedEntry(policy, resolvedModel)?.effort : undefined;
      // emit saved defaults only when current metadata still supports them
      if (configured !== undefined && catalogModel?.efforts.includes(configured) === true) effort = configured;
    }
    const nominalNativeDefault = policy.state === 'native-default' && config.allowedModels === undefined && resolvedModel !== undefined && allowedEntry(policy, resolvedModel) !== undefined;
    const needsModelOverride = resolvedModel !== undefined && ((!keepCurrent && !nominalNativeDefault) || effort !== undefined);
    // require installed grammar proof only for an emitted native model override
    if (needsModelOverride && kind !== 'pi' && capabilities.model !== true) throw new LaunchOptionsError(409, 'launch_option_unsupported');
    const security = prepareSecurity(kind, choice, manifest.security);
    // reject coupled presets before closing or mutating a target
    if (nativeSecurityProblem(kind, config.args, security) !== undefined) throw new LaunchOptionsError(409, 'launch_option_unsupported');
    const prepared: PreparedLaunchChoice = { kind, security, optionsRevision: manifest.optionsRevision };
    // preserve same-kind restart without an unnecessary model override
    if (keepCurrent && effort === undefined) prepared.keepCurrent = true;
    else if (resolvedModel !== undefined && (!nominalNativeDefault || effort !== undefined)) prepared.model = { model: resolvedModel, ...(effort === undefined ? {} : { effort }) };
    // absent singleton identity stays native authorization, never an implicit list
    if (nominalNativeDefault || nativeDefault) prepared.nativeDefault = true;
    // preserve the exact validated choice across lifecycle handoffs
    Object.freeze(prepared.security);
    if (prepared.model !== undefined) Object.freeze(prepared.model);
    return Object.freeze(prepared);
  }

  /** revalidate immutable prepared semantics immediately before a side effect. */
  async revalidate(prepared: PreparedLaunchChoice, context: LaunchOptionsContext): Promise<void> {
    const discover = this.revisionDiscovery.get(prepared.optionsRevision) ?? true;
    const manifest = await this.manifest(prepared.kind, context, discover);
    // compare target-bound current state before semantic reconstruction
    if (manifest.optionsRevision !== prepared.optionsRevision) throw new LaunchOptionsError(409, 'launch_options_stale');
    // an opaque or nominal Pi default carries no explicit identity to reconstruct
    if (prepared.nativeDefault && prepared.model === undefined) {
      const security = prepareSecurity(prepared.kind, { kind: prepared.kind, security: prepared.security }, manifest.security);
      if (JSON.stringify(security) !== JSON.stringify(prepared.security)) throw new LaunchOptionsError(409, 'launch_options_stale');
      return;
    }
    const raw: ManualLaunchChoice = {
      kind: prepared.kind,
      ...(prepared.keepCurrent ? { model: { mode: 'keep-current' as const } } : prepared.model === undefined ? { model: { mode: 'native-default' as const } } : { model: { mode: 'model' as const, id: prepared.model.model } }),
      ...(prepared.model?.effort === undefined ? {} : { effort: { mode: 'effort' as const, id: prepared.model.effort } }),
      security: prepared.security,
      optionsRevision: prepared.optionsRevision
    };
    const current = await this.prepare(prepared.kind, raw, context);
    // require the exact prepared semantic result
    if (JSON.stringify(current) !== JSON.stringify(prepared)) throw new LaunchOptionsError(409, 'launch_options_stale');
  }
}
