import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AdapterLaunchConfig } from '../adapters/types.js';
import { hostPiRuntime } from '../adapters/pi-runtime.js';
import type { ReplySuggestion } from '../domain/models.js';
import type { PiReplySuggestionSource, ReplySuggestionSource } from './types.js';
import { parseReplySuggestions } from './validation.js';
import { replySuggestionPrompt as systemPrompt } from './prompt.js';

type RuntimeModel = { provider: string; id: string; api: string; baseUrl: string; type?: string };
type RuntimeContextInput = { systemPrompt: string; tools: []; messages: unknown[] };
type RuntimeResponse = { stopReason: string; provider: string; model: string; responseModel?: string; content: Array<{ type: string; text?: string }> };
type RuntimeLike = {
  refresh(options: { allowNetwork: boolean; providers: readonly string[]; signal: AbortSignal }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
  getError(): string | undefined;
  getProviderAuthStatus(provider: string): { configured: boolean; source?: string };
  listCredentials(options?: { signal?: AbortSignal }): Promise<readonly { providerId: string; type: string }[]>;
  getPhysicalModel(provider: string, model: string): RuntimeModel | undefined;
  completeSimple(model: RuntimeModel, context: RuntimeContextInput, options: { signal: AbortSignal; timeoutMs: number; maxTokens: number; toolChoice: 'none'; reasoning?: string; disableContinuation: true }): Promise<RuntimeResponse>;
};

type Authority = { authPath: string; fingerprint: string };
type ManagedAuthority = Authority & { runtimeGeneration: string };
type RuntimeContext = { authority: Authority; runtime: RuntimeLike };

type PiReplySuggestionRuntimeOptions = {
  environment?: NodeJS.ProcessEnv;
  runtimeFactory?: (authPath: string) => Promise<RuntimeLike>;
  inspectAuthority?: () => Promise<Authority | undefined>;
};

type AuthorityMetadata = readonly [string, string, string, string, string, string, string];
type DirectoryAuthorityIdentity = readonly [string, string, string, string];

// serialize stable bigint metadata without credential bytes
function authorityMetadata(info: BigIntStats): AuthorityMetadata {
  return [info.dev.toString(), info.ino.toString(), info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString(), info.mode.toString(), info.nlink.toString()];
}

// bind directory ownership without binding mutable state contents
function directoryAuthorityIdentity(info: BigIntStats): DirectoryAuthorityIdentity {
  return [info.dev.toString(), info.ino.toString(), info.uid.toString(), info.mode.toString()];
}

// compare complete metadata snapshots across asynchronous path checks
function sameAuthorityMetadata(left: AuthorityMetadata, right: AuthorityMetadata): boolean {
  return left.every((value, index) => value === right[index]);
}

// resolve the same state root a managed Pi launch receives
function effectiveStateDir(adapter: Pick<AdapterLaunchConfig, 'env'>, launchHome: string | undefined, environment: NodeJS.ProcessEnv): string | undefined {
  const explicit = environment.RAC_HOST_TMUX_DIR === undefined ? adapter.env.PI_CODING_AGENT_DIR : environment.PI_CODING_AGENT_DIR;
  if (explicit !== undefined && explicit !== '') return isAbsolute(explicit) ? explicit : undefined;
  const home = adapter.env.HOME ?? launchHome ?? environment.HOME ?? homedir();
  return isAbsolute(home) ? join(home, '.pi', 'agent') : undefined;
}

// pin inference to the exact built-in Pi launch runtime and its state selection
function managedLaunchGeneration(adapter: Pick<AdapterLaunchConfig, 'program' | 'args' | 'env' | 'launchable' | 'setup' | 'teardown'>, launchHome: string | undefined, environment: NodeJS.ProcessEnv): string | undefined {
  // authored lifecycle, arguments or opaque environment can select another login or runtime
  if (!adapter.launchable || adapter.args.length > 0 || adapter.setup !== undefined || adapter.teardown !== undefined || Object.keys(adapter.env).some(name => name !== 'HOME' && name !== 'PI_CODING_AGENT_DIR')) return undefined;
  const stateDir = effectiveStateDir(adapter, launchHome, environment);
  if (stateDir === undefined) return undefined;
  let runtime: string;
  // bridge launches must use the currently proven pinned host runtime
  if (environment.RAC_HOST_TMUX_DIR !== undefined) {
    try {
      const host = hostPiRuntime(environment);
      if (host === undefined || adapter.program !== host.node || environment.PI_CODING_AGENT_DIR !== stateDir) return undefined;
      runtime = host.fingerprint;
    } catch { return undefined; }
  } else {
    // native inference requires an explicit post-login-shell state path
    if (adapter.program !== process.execPath || adapter.env.PI_CODING_AGENT_DIR === undefined || !isAbsolute(adapter.env.PI_CODING_AGENT_DIR) || adapter.env.PI_CODING_AGENT_DIR !== stateDir) return undefined;
    runtime = process.execPath;
  }
  return createHash('sha256').update(JSON.stringify([runtime, adapter.program, stateDir])).digest('base64url');
}

// prove one private shared Pi credential file without reading its secret bytes
async function inspectManagedAuthority(adapter: Pick<AdapterLaunchConfig, 'program' | 'args' | 'env' | 'launchable' | 'setup' | 'teardown'>, launchHome: string | undefined, environment: NodeJS.ProcessEnv): Promise<ManagedAuthority | undefined> {
  const launchGeneration = managedLaunchGeneration(adapter, launchHome, environment);
  if (launchGeneration === undefined) return undefined;
  const stateDir = effectiveStateDir(adapter, launchHome, environment);
  if (stateDir === undefined) return undefined;
  const authPath = join(stateDir, 'auth.json');
  try {
    const [stateBefore, authBefore] = await Promise.all([lstat(stateDir, { bigint: true }), lstat(authPath, { bigint: true })]);
    const [canonicalState, canonicalAuth, stateAfter, authAfter] = await Promise.all([realpath(stateDir), realpath(authPath), lstat(stateDir, { bigint: true }), lstat(authPath, { bigint: true })]);
    const stateMetadata = authorityMetadata(stateBefore);
    const authMetadata = authorityMetadata(authBefore);
    // path resolution cannot span an authority mutation
    if (!sameAuthorityMetadata(stateMetadata, authorityMetadata(stateAfter)) || !sameAuthorityMetadata(authMetadata, authorityMetadata(authAfter))) return undefined;
    const uid = process.getuid?.();
    // require exact real paths, owner-only state and one regular credential inode
    if (canonicalState !== stateDir || canonicalAuth !== authPath || !stateAfter.isDirectory() || !authAfter.isFile() || stateAfter.isSymbolicLink() || authAfter.isSymbolicLink() || uid === undefined || stateAfter.uid !== BigInt(uid) || authAfter.uid !== BigInt(uid) || (stateAfter.mode & 0o077n) !== 0n || (authAfter.mode & 0o077n) !== 0n || authAfter.nlink !== 1n) return undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify([directoryAuthorityIdentity(stateBefore), authMetadata])).digest('base64url');
    const runtimeGeneration = createHash('sha256').update(JSON.stringify([launchGeneration, fingerprint])).digest('base64url');
    return { authPath, fingerprint, runtimeGeneration };
  } catch { return undefined; }
}

// capture the nonsecret login/runtime generation immediately before a Pi process starts
export async function piReplyRuntimeGeneration(adapter: Pick<AdapterLaunchConfig, 'program' | 'args' | 'env' | 'launchable' | 'setup' | 'teardown'>, launchHome?: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return (await inspectManagedAuthority(adapter, launchHome, environment))?.runtimeGeneration;
}

// isolate one exact Pi credential scope from all other console model accounts
export class PiReplySuggestionRuntime {
  private context?: Promise<RuntimeContext | undefined>;

  constructor(private readonly adapter: Pick<AdapterLaunchConfig, 'program' | 'args' | 'env' | 'launchable' | 'setup' | 'teardown'>, private readonly launchHome?: string, private readonly options: PiReplySuggestionRuntimeOptions = {}) {}

  // identify the nonsecret route generation used by coordinator stale fences
  async routeFingerprint(source: ReplySuggestionSource): Promise<string | undefined> {
    // other native kinds cannot borrow the pi account
    if (source.kind !== 'pi') return undefined;
    const context = await this.resolve(source);
    if (context === undefined) return undefined;
    return createHash('sha256').update(JSON.stringify([context.authority.fingerprint, source.nativeModel.provider, source.nativeModel.id, source.nativeModel.api, source.nativeModel.baseUrl])).digest('base64url');
  }

  // generate with the exact route observed before coordinator dispatch
  async generate(source: ReplySuggestionSource, signal: AbortSignal, expectedRouteFingerprint: string): Promise<ReplySuggestion[]> {
    // reject cross-kind dispatch before reading pi credentials
    if (source.kind !== 'pi') return [];
    try {
      const context = await this.resolve(source, signal);
      if (context === undefined || await this.routeFingerprint(source) !== expectedRouteFingerprint) return [];
      const model = context.runtime.getPhysicalModel(source.nativeModel.provider, source.nativeModel.id);
      if (model === undefined || !this.matches(model, source)) return [];
      const response = await context.runtime.completeSimple(model, this.contextFor(source), {
        signal,
        timeoutMs: 20_000,
        maxTokens: 4_096,
        toolChoice: 'none',
        ...(source.model.effort === undefined ? {} : { reasoning: source.model.effort }),
        disableContinuation: true
      });
      // reject tools, truncation and provider-side model substitution
      if (response.stopReason !== 'stop' || response.provider !== source.nativeModel.provider || (response.responseModel ?? response.model) !== source.nativeModel.id || response.content.some(content => content.type !== 'text' && content.type !== 'thinking')) return [];
      // discard private reasoning and parse only the final editable reply text
      const suggestions = parseReplySuggestions(response.content.map(content => content.type === 'text' ? content.text : '').join(''));
      // recheck the credential file after the billed request before publication
      if (suggestions === undefined || await this.routeFingerprint(source) !== expectedRouteFingerprint) return [];
      return suggestions;
    } catch { return []; }
  }

  // resolve only a stored api-key credential and exact physical model
  private async resolve(source: PiReplySuggestionSource, signal: AbortSignal = AbortSignal.timeout(5_000)): Promise<RuntimeContext | undefined> {
    const environment = this.options.environment ?? process.env;
    const launchGeneration = managedLaunchGeneration(this.adapter, this.launchHome, environment);
    if (launchGeneration === undefined) return undefined;
    const inspected = await (this.options.inspectAuthority?.() ?? inspectManagedAuthority(this.adapter, this.launchHome, environment));
    // unavailable authority invalidates any cached credential runtime
    if (inspected === undefined) { this.context = undefined; return undefined; }
    const runtimeGeneration = createHash('sha256').update(JSON.stringify([launchGeneration, inspected.fingerprint])).digest('base64url');
    // never use a current account for a process launched under another account generation
    if (runtimeGeneration !== source.runtimeGeneration) { this.context = undefined; return undefined; }
    const authority: Authority = inspected;
    let context = await this.contextForAuthority(authority);
    // retire a cached runtime when its credential inode generation changes
    if (context?.authority.fingerprint !== authority.fingerprint || context.authority.authPath !== authority.authPath) {
      this.context = undefined;
      context = await this.contextForAuthority(authority);
    }
    if (context === undefined) return undefined;
    const refreshed = await context.runtime.refresh({ allowNetwork: false, providers: [source.nativeModel.provider], signal });
    if (refreshed.aborted || refreshed.errors.size > 0 || context.runtime.getError() !== undefined) return undefined;
    const status = context.runtime.getProviderAuthStatus(source.nativeModel.provider);
    const credentials = await context.runtime.listCredentials({ signal });
    // never fall through to environment, runtime or another account
    if (!status.configured || status.source !== 'stored' || !credentials.some(credential => credential.providerId === source.nativeModel.provider && credential.type === 'api_key')) return undefined;
    const model = context.runtime.getPhysicalModel(source.nativeModel.provider, source.nativeModel.id);
    return model !== undefined && this.matches(model, source) ? context : undefined;
  }

  // create one runtime for one exact credential-file generation
  private async contextForAuthority(authority: Authority): Promise<RuntimeContext | undefined> {
    this.context ??= (this.options.runtimeFactory?.(authority.authPath) ?? ModelRuntime.create({ authPath: authority.authPath, modelsPath: null, refreshOnCreate: false }) as unknown as Promise<RuntimeLike>)
      .then(runtime => ({ authority, runtime })).catch(() => undefined);
    return await this.context;
  }

  // require an exact nonvirtual provider route
  private matches(model: RuntimeModel, source: PiReplySuggestionSource): boolean {
    return model.provider === source.nativeModel.provider && model.id === source.nativeModel.id && model.api === source.nativeModel.api && model.api !== 'pi-virtual' && model.baseUrl === source.nativeModel.baseUrl && (model.type === undefined || model.type === 'chat');
  }

  // copy only bounded authored messages into a sessionless request
  private contextFor(source: PiReplySuggestionSource): RuntimeContextInput {
    return {
      systemPrompt,
      tools: [],
      messages: source.messages.map((message, index) => message.role === 'user'
        ? { role: 'user' as const, content: message.text, timestamp: index }
        : { role: 'assistant' as const, content: [{ type: 'text' as const, text: message.text }], api: source.nativeModel.api, provider: source.nativeModel.provider, model: source.nativeModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: index })
    };
  }
}
