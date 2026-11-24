import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NativeAccountObservation, NativeGenerationResult, NativeWorkerRequest, NativeWorkerResponse } from './native-process.js';
import { claudeArguments, codexCachedCatalog, codexConfig, nativeConversation, nativeFinalOutputBytes, nativePolicyGeneration, nativeProtocolOutputBytes, nativeRequestBytes, nativeStderrBytes, nativeTimeoutMs, supportsClaudeReplyVersion, supportsCodexReplyVersion, validCodexReplyFeatures } from './native-policy.js';
import { nativeReplyScope } from './native-scope.js';
import type { NativeReplySuggestionSource, NativeReplyScope } from './types.js';
import { replySuggestionPrompt } from './prompt.js';
import { parseReplySuggestions, replySuggestionSchema } from './validation.js';

type JsonObject = Record<string, unknown>;
type CommandResult = { code: number; stdout: Buffer; stderr: Buffer; cleanupComplete: boolean };
type CodexMetadata = { observation: NativeAccountObservation; model: Record<string, unknown>; catalog: object; features: string[] };
type CodexGenerationPolicy = { catalog: object; features: string[] };

class NativeWorkerError extends Error {
  // carry only a stable diagnostic code
  constructor(readonly code: string) { super(code); }
}

// hash one deterministic nonsecret identity projection
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// require one plain json object
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

// combine one caller abort with the fixed worker deadline
function deadlineSignal(signal?: AbortSignal): AbortSignal {
  return signal === undefined ? AbortSignal.timeout(nativeTimeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(nativeTimeoutMs)]);
}

// terminate one private child process group
async function terminate(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  // request orderly private-child shutdown first
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise(resolve => setTimeout(resolve, 50));
  // force only the helper-owned process group
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  return true;
}

// run one bounded cli command with an explicit environment
async function boundedCommand(program: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; stdoutBytes?: number; stderrBytes?: number }): Promise<CommandResult> {
  const signal = deadlineSignal(options.signal);
  const child = spawn(program, [...args], { cwd: options.cwd, env: options.env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exceeded = false;
  // capture bounded stdout chunks
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    // stop retaining after the first cap breach
    if (stdoutBytes > (options.stdoutBytes ?? nativeProtocolOutputBytes)) { exceeded = true; void terminate(child); return; }
    stdout.push(chunk);
  });
  // capture bounded stderr chunks
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    // stop retaining after the first cap breach
    if (stderrBytes > (options.stderrBytes ?? nativeStderrBytes)) { exceeded = true; void terminate(child); return; }
    stderr.push(chunk);
  });
  // cancellation kills only this helper group
  const abort = () => { void terminate(child); };
  signal.addEventListener('abort', abort, { once: true });
  // send private conversation bytes over stdin only
  if (options.input === undefined) child.stdin.end(); else child.stdin.end(options.input);
  const code = await new Promise<number>(resolve => {
    // spawn failures become a stable command failure
    child.once('error', () => resolve(-1));
    child.once('close', value => resolve(value ?? -1));
  });
  signal.removeEventListener('abort', abort);
  const cleanupComplete = await terminate(child);
  // reject deadlines and output overflows without surfacing process text
  if (signal.aborted) throw new NativeWorkerError('native_timeout_or_cancelled');
  if (exceeded) throw new NativeWorkerError('native_output_limit');
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), cleanupComplete };
}

// construct one clean native cli environment
function cleanEnvironment(scope: NativeReplyScope, configHome?: string): NodeJS.ProcessEnv {
  return {
    HOME: configHome ?? scope.home,
    PATH: `${dirname(scope.program)}:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(scope.kind === 'codex' && configHome !== undefined ? { CODEX_HOME: configHome } : {}),
    ...(scope.kind === 'claude' && scope.configDir !== join(scope.home, '.claude') ? { CLAUDE_CONFIG_DIR: scope.configDir } : {})
  };
}

// execute the exact inode held open by the observed native process
function nativeProgram(scope: NativeReplyScope): string {
  return join(process.env.RAC_HOST_PROC ?? '/proc', String(scope.process.pid), 'exe');
}

// verify the observed binary meets its native protocol floor
async function programVersion(scope: NativeReplyScope, signal: AbortSignal, configHome?: string): Promise<string> {
  const result = await boundedCommand(nativeProgram(scope), ['--version'], { cwd: scope.home, env: cleanEnvironment(scope, configHome), signal, stdoutBytes: 4_096, stderrBytes: 4_096 });
  const stderrAccepted = configHome === undefined ? result.stderr.length === 0 : codexMetadataStderr(result.stderr, configHome);
  const version = result.code === 0 && stderrAccepted ? result.stdout.toString('utf8').trim() : '';
  const supported = scope.kind === 'codex' ? supportsCodexReplyVersion(version) : supportsClaudeReplyVersion(version);
  // a supported version still needs the account and protocol checks
  if (!supported) throw new NativeWorkerError('native_version_mismatch');
  return version;
}

// fingerprint one executable and policy generation without reading credentials
async function capabilityGeneration(scope: NativeReplyScope, version: string): Promise<string> {
  const info = await stat(nativeProgram(scope));
  return hash([scope.kind, scope.program, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, version, nativePolicyGeneration]);
}

// fingerprint credential metadata without reading secret bytes
async function credentialGeneration(path: string): Promise<string> {
  const info = await stat(path);
  return hash([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.nlink]);
}

// require one private regular credential file
async function privateCredential(path: string): Promise<void> {
  const info = await lstat(path);
  const uid = process.getuid?.();
  // symlinks and shared or exposed credentials are never borrowed
  if (!info.isFile() || info.isSymbolicLink() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new NativeWorkerError('native_credential_scope_invalid');
}

// create one clean Codex helper home that references the exact existing auth file
async function codexHelper(scope: NativeReplyScope): Promise<{ root: string; cwd: string; auth: string }> {
  const auth = join(scope.configDir, 'auth.json');
  await privateCredential(auth);
  const root = await mkdtemp(join(tmpdir(), 'rac-native-codex-'));
  await chmod(root, 0o700);
  const cwd = join(root, 'cwd');
  await mkdir(cwd, { mode: 0o700 });
  await symlink(auth, join(root, 'auth.json'));
  const [target, linked] = await Promise.all([realpath(auth), realpath(join(root, 'auth.json'))]);
  // prove the helper references the same credential inode
  if (target !== linked) { await rm(root, { recursive: true, force: true }); throw new NativeWorkerError('native_auth_link_mismatch'); }
  return { root, cwd, auth };
}

// remove only a worker-owned Codex helper directory
async function removeCodexHelper(helper: { root: string }): Promise<boolean> {
  // constrain cleanup to the private temporary prefix
  if (!helper.root.startsWith(join(tmpdir(), 'rac-native-codex-'))) return false;
  await rm(helper.root, { recursive: true, force: true });
  return true;
}

class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: JsonObject[] = [];
  private waiter?: (message: JsonObject) => void;
  private partial = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private stderr = Buffer.alloc(0);
  private stderrBytes = 0;
  private outputBytes = 0;
  private failed = false;
  private failureCode = 'codex_protocol_failed';

  // start one isolated app-server process
  constructor(program: string, cwd: string, env: NodeJS.ProcessEnv, private readonly signal: AbortSignal) {
    this.child = spawn(program, ['app-server', '--strict-config', '--listen', 'stdio://'], { cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    // parse only bounded json lines
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    // accept only the pinned temporary-home alias warning and reject other diagnostics
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      this.stderr = Buffer.concat([this.stderr, chunk]);
      // complete permitted lines still count toward the whole-session diagnostic cap
      if (this.stderrBytes > nativeStderrBytes) { this.fail('codex_protocol_stderr_limit'); void terminate(this.child); return; }
      let newline = this.stderr.indexOf(0x0a);
      // validate complete stderr lines without surfacing their paths
      while (newline >= 0) {
        if (!codexStartupStderr(this.stderr.subarray(0, newline), env.CODEX_HOME ?? '')) { this.fail('codex_protocol_stderr'); void terminate(this.child); return; }
        this.stderr = this.stderr.subarray(newline + 1);
        newline = this.stderr.indexOf(0x0a);
      }
    });
    // exited helpers wake any pending protocol request
    this.child.once('error', () => this.fail('codex_protocol_spawn_failed'));
    this.child.once('close', () => this.fail('codex_protocol_exited'));
    // cancellation kills only this helper group
    this.signal.addEventListener('abort', () => { void terminate(this.child); }, { once: true });
  }

  // fail the protocol and wake its one current waiter
  private fail(code = 'codex_protocol_failed'): void {
    // retain the first closed failure category rather than later shutdown noise
    if (!this.failed) this.failureCode = code;
    this.failed = true;
    const waiter = this.waiter;
    // a synthetic error record releases a blocked next call
    if (waiter !== undefined) { this.waiter = undefined; waiter({ method: 'error' }); }
  }

  // split bounded protocol output into json objects
  private consume(chunk: Buffer): void {
    this.outputBytes += chunk.length;
    // reject total protocol overflow
    if (this.outputBytes > nativeProtocolOutputBytes) { this.fail(); void terminate(this.child); return; }
    // preserve split unicode code points while rejecting malformed protocol bytes
    try { this.partial += this.decoder.decode(chunk, { stream: true }); } catch { this.fail(); void terminate(this.child); return; }
    // drain every complete json line
    while (this.partial.includes('\n')) {
      const index = this.partial.indexOf('\n');
      const line = this.partial.slice(0, index);
      this.partial = this.partial.slice(index + 1);
      // reject oversized or malformed records
      if (Buffer.byteLength(line) > 256 * 1024) { this.fail(); void terminate(this.child); return; }
      try {
        const message = object(JSON.parse(line));
        // every protocol record must be an object
        if (message === undefined) throw new Error('not object');
        const waiter = this.waiter;
        // deliver directly to the current bounded waiter
        if (waiter !== undefined) { this.waiter = undefined; waiter(message); } else this.queue.push(message);
      } catch { this.fail(); void terminate(this.child); return; }
    }
  }

  // read one protocol object inside the shared deadline
  async next(): Promise<JsonObject> {
    // surface earlier protocol failures
    if (this.failed || this.signal.aborted) throw new NativeWorkerError(this.signal.aborted ? 'codex_protocol_cancelled' : this.failureCode);
    const queued = this.queue.shift();
    // reuse already-buffered records
    if (queued !== undefined) return queued;
    return await new Promise<JsonObject>((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(new NativeWorkerError('codex_protocol_cancelled')); };
      this.signal.addEventListener('abort', abort, { once: true });
      this.waiter = message => { this.signal.removeEventListener('abort', abort); resolve(message); };
    });
  }

  // send one bounded json-rpc request and audit interleaved notifications
  async request(id: number, method: string, params: unknown, audit?: (message: JsonObject) => void): Promise<unknown> {
    const line = `${JSON.stringify({ id, method, params })}\n`;
    // reject oversized client messages
    if (Buffer.byteLength(line) > nativeRequestBytes) throw new NativeWorkerError('codex_request_too_large');
    this.child.stdin.write(line);
    // wait for the exact response
    while (true) {
      const message = await this.next();
      // return only the matching response
      if (message.id === id && message.method === undefined) {
        // incomplete diagnostics cannot be ignored at a response boundary
        if (this.stderr.length !== 0 || this.failed) throw new NativeWorkerError(this.stderr.length !== 0 ? 'codex_protocol_stderr_incomplete' : this.failureCode);
        if (message.error !== undefined) throw new NativeWorkerError('codex_request_failed');
        return message.result;
      }
      audit?.(message);
    }
  }

  // initialize the app-server protocol
  async initialize(): Promise<void> {
    await this.request(1, 'initialize', { clientInfo: { name: 'rac-native-reply', title: 'RAC native reply helper', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  }

  // stop only this app-server process group
  async close(): Promise<boolean> {
    this.child.stdin.end();
    return await terminate(this.child);
  }
}

// sanitize the exact native Codex account without retaining identity fields
function codexAccount(value: unknown): string | undefined {
  const response = object(value);
  const account = object(response?.account);
  // require the ordinary ChatGPT account route
  if (response?.requiresOpenaiAuth !== true || account?.type !== 'chatgpt') return undefined;
  const identity = { email: account.email, userId: response.userId, workspaceName: account.workspaceName };
  // require one stable logical identity source
  if (!Object.values(identity).some(item => typeof item === 'string' && item.length > 0)) return undefined;
  return hash(identity);
}

// parse the installed feature table without assuming a release-specific count
function codexFeatures(value: string): string[] | undefined {
  const features: string[] = [];
  // reject malformed rows instead of silently leaving features enabled
  for (const line of value.trim().split(/\r?\n/u)) {
    const name = /^(\S+)[ \t]+[a-z]+(?: [a-z]+)*[ \t]+(?:true|false)$/u.exec(line.trim())?.[1];
    // require the native name, stage and boolean columns
    if (name === undefined) return undefined;
    features.push(name);
  }
  return validCodexReplyFeatures(features) ? features : undefined;
}

// native 0.169 refuses optional path aliases in our intentionally temporary home
export function codexMetadataStderr(bytes: Buffer, helperRoot: string): boolean {
  const expected = `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir ${JSON.stringify(tmpdir())} (codex_home: AbsolutePathBuf(${JSON.stringify(helperRoot)}))`;
  const value = bytes.toString('utf8').trim();
  return value === '' || value === expected;
}

// keep every feature disabled despite the pinned native deprecation diagnostic
export function codexStartupStderr(bytes: Buffer, helperRoot: string): boolean {
  if (codexMetadataStderr(bytes, helperRoot)) return true;
  const plain = bytes.toString('utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').trim();
  const message = plain.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+ERROR\s+codex_app_server:\s*/u, '');
  return message !== plain && message === '`[features].multi_agent` is deprecated. It still controls the V1 fallback. `[agents].enabled = false` disables subagent tools even when the model selects a subagent version, unless `[features].multi_agent_v2` is enabled.';
}

// read the exact source model from native nonsecret cache metadata
async function codexCachedModel(scope: NativeReplyScope, source: NativeReplySuggestionSource): Promise<Record<string, unknown> | undefined> {
  const path = join(scope.configDir, 'models_cache.json');
  const info = await stat(path).catch(() => undefined);
  // reject absent or oversized metadata caches
  if (info === undefined || !info.isFile() || info.size <= 0 || info.size > 4 * 1024 * 1024) return undefined;
  const parsed = object(JSON.parse(await readFile(path, 'utf8')));
  const models = parsed?.models;
  // select one unique exact native model
  if (!Array.isArray(models)) return undefined;
  const matches = models.filter(entry => object(entry)?.slug === source.nativeModel.id).map(entry => object(entry)!);
  return matches.length === 1 ? matches[0] : undefined;
}

// derive one local-only exact generation policy without account or provider calls
export function codexGenerationPolicy(source: NativeReplySuggestionSource, cached: Record<string, unknown> | undefined, featureStdout: string, featureStderr: Buffer, helperRoot: string): CodexGenerationPolicy | undefined {
  const features = codexMetadataStderr(featureStderr, helperRoot) ? codexFeatures(featureStdout) : undefined;
  const catalog = cached === undefined ? undefined : codexCachedCatalog(source, cached);
  // both the discovered feature inventory and exact sanitized cache entry are mandatory
  return features === undefined || catalog === undefined ? undefined : { features, catalog };
}

// prepare the billed turn from local verified metadata only
async function prepareCodexGeneration(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal, helper: { root: string; cwd: string }): Promise<CodexGenerationPolicy> {
  await programVersion(scope, signal, helper.root);
  const env = cleanEnvironment(scope, helper.root);
  const featureResult = await boundedCommand(nativeProgram(scope), ['features', 'list'], { cwd: helper.cwd, env, signal, stdoutBytes: 256 * 1024, stderrBytes: 16 * 1024 });
  const cached = await codexCachedModel(scope, source);
  const policy = featureResult.code === 0
    ? codexGenerationPolicy(source, cached, featureResult.stdout.toString('utf8'), featureResult.stderr, helper.root)
    : undefined;
  // no remote metadata fallback can cross a failed local policy gate
  if (policy === undefined) throw new NativeWorkerError(cached === undefined ? 'codex_catalog_unavailable' : 'codex_feature_inventory_mismatch');
  return policy;
}

// inspect native Codex account, provider, model and policy metadata without inference
async function inspectCodex(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal): Promise<CodexMetadata> {
  const version = await programVersion(scope, signal);
  const capability = await capabilityGeneration(scope, version);
  const helper = await codexHelper(scope);
  let cleanupComplete = false;
  try {
    const env = cleanEnvironment(scope, helper.root);
    const featureResult = await boundedCommand(nativeProgram(scope), ['features', 'list'], { cwd: helper.cwd, env, signal, stdoutBytes: 256 * 1024, stderrBytes: 16 * 1024 });
    const features = featureResult.code === 0 && codexMetadataStderr(featureResult.stderr, helper.root) ? codexFeatures(featureResult.stdout.toString('utf8')) : undefined;
    // require a valid inventory from this exact binary
    if (features === undefined) throw new NativeWorkerError('codex_feature_inventory_mismatch');
    const server = new CodexAppServer(nativeProgram(scope), helper.cwd, env, signal);
    try {
      await server.initialize();
      const accountResult = await server.request(2, 'account/read', { refreshToken: false });
      const providerResult = await server.request(3, 'modelProvider/list', {});
      const modelResult = await server.request(4, 'model/list', { limit: 100 });
      const logicalIdentity = codexAccount(accountResult);
      const provider = object(providerResult);
      const providers = provider?.data;
      const openai = Array.isArray(providers) ? providers.filter(entry => object(entry)?.id === 'openai') : [];
      const providerSettings = openai.length === 1 ? object(object(openai[0])?.settings) : undefined;
      // reject custom providers and endpoint overrides
      if (logicalIdentity === undefined || provider?.defaultProviderId !== 'openai' || openai.length !== 1 || providerSettings?.type !== 'openai' || ![undefined, null, 'https://chatgpt.com/backend-api/codex'].includes(object(openai[0])?.baseUrl as never)) throw new NativeWorkerError('codex_account_or_provider_mismatch');
      const models = object(modelResult)?.data ?? object(modelResult)?.models;
      const matches = Array.isArray(models) ? models.filter(entry => {
        const model = object(entry);
        return model?.id === source.nativeModel.id || model?.model === source.nativeModel.id;
      }).map(entry => object(entry)!) : [];
      // require one exact remotely available model and effort
      if (matches.length !== 1 || !Array.isArray(matches[0]!.supportedReasoningEfforts) || !matches[0]!.supportedReasoningEfforts.some(entry => object(entry)?.reasoningEffort === source.model.effort)) throw new NativeWorkerError('codex_model_selection_unavailable');
      const cached = await codexCachedModel(scope, source);
      const catalog = cached === undefined ? undefined : codexCachedCatalog(source, cached);
      // require a capability-neutral exact native cache entry
      if (catalog === undefined) throw new NativeWorkerError('codex_catalog_unavailable');
      const observation: NativeAccountObservation = {
        kind: 'codex', provider: 'openai', logicalIdentity, profile: 'chatgpt',
        model: source.nativeModel.id, effort: source.model.effort!, programVersion: version,
        capabilityGeneration: capability, credentialGeneration: await credentialGeneration(helper.auth)
      };
      return { observation, model: matches[0]!, catalog, features };
    } finally {
      await server.close();
    }
  } finally {
    cleanupComplete = await removeCodexHelper(helper);
    // helper cleanup is part of successful metadata inspection
    if (!cleanupComplete) throw new NativeWorkerError('codex_helper_cleanup_failed');
  }
}

type CodexAuditResult = {
  terminalStatus: 'completed' | 'failed'; finalText?: string; finalAnswerCount: number;
  toolEvents: number; rerouteEvents: number; serverRequests: number; errorEvents: number;
};

// pinned inert notifications from the supported native protocol
const codexInertNotifications = new Set([
  'account/rateLimits/updated', 'account/updated', 'configWarning', 'deprecationNotice',
  'remoteControl/status/changed', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated',
  'turn/started', 'turn/completed', 'turn/moderationMetadata', 'warning',
  'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded'
]);

export class CodexAudit {
  private terminal?: 'completed' | 'failed';
  private finalTexts: string[] = [];
  private tools = 0;
  private reroutes = 0;
  private requests = 0;
  private errors = 0;

  // reject every native effect or reroute while retaining final answer text only
  consume(message: JsonObject): void {
    const method = typeof message.method === 'string' ? message.method : undefined;
    // server callbacks would require an effect handler
    if (method !== undefined && message.id !== undefined) { this.requests += 1; throw new NativeWorkerError('codex_server_request'); }
    // responses carry no auditable event
    if (method === undefined) return;
    const params = object(message.params) ?? {};
    // any reroute invalidates the result
    if (method === 'model/rerouted') { this.reroutes += 1; throw new NativeWorkerError('codex_model_rerouted'); }
    // errors and retry announcements fail immediately
    if (method === 'error') { this.errors += 1; throw new NativeWorkerError('codex_turn_error'); }
    // explicit failure is terminal
    if (method === 'turn/failed') { this.terminal = 'failed'; throw new NativeWorkerError('codex_turn_failed'); }
    // unknown protocol additions cannot silently acquire authority
    if (!codexInertNotifications.has(method)) throw new NativeWorkerError('codex_unknown_event');
    // validate nested terminal status and error
    if (method === 'turn/completed') {
      // one native turn has exactly one terminal event
      if (this.terminal !== undefined) throw new NativeWorkerError('codex_duplicate_terminal');
      const turn = object(params.turn);
      this.terminal = turn?.status === 'completed' && turn.error == null ? 'completed' : 'failed';
      // reject failed nested terminal state
      if (this.terminal !== 'completed') throw new NativeWorkerError('codex_turn_failed');
    }
    const item = object(params.item);
    // only inert message and reasoning items are permitted
    if (item !== undefined) {
      const itemType = item.type;
      // reject every tool or effect item
      if (!['userMessage', 'agentMessage', 'reasoning'].includes(String(itemType))) { this.tools += 1; throw new NativeWorkerError('codex_tool_event'); }
      // retain only one completed final-answer message
      if (method === 'item/completed' && itemType === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string') this.finalTexts.push(item.text);
    }
    // catch effect methods without item payloads
    if (['commandExecution', 'fileChange', 'mcpToolCall', 'mcpServer/', 'tool/call'].some(marker => method.includes(marker))) { this.tools += 1; throw new NativeWorkerError('codex_tool_event'); }
  }

  // expose one sanitized terminal audit
  result(): CodexAuditResult {
    return {
      terminalStatus: this.terminal ?? 'failed',
      ...(this.finalTexts.length === 1 ? { finalText: this.finalTexts[0] } : {}),
      finalAnswerCount: this.finalTexts.length,
      toolEvents: this.tools, rerouteEvents: this.reroutes, serverRequests: this.requests, errorEvents: this.errors
    };
  }
}

// run one exact zero-tool ephemeral Codex turn
async function generateCodex(scope: NativeReplyScope, source: NativeReplySuggestionSource, expectedAccount: string, signal: AbortSignal): Promise<NativeGenerationResult> {
  const conversation = nativeConversation(source.messages);
  // oversized source data never reaches the model
  if (conversation === undefined) throw new NativeWorkerError('native_conversation_too_large');
  const helper = await codexHelper(scope);
  let cleanupComplete = false;
  try {
    const metadata = await prepareCodexGeneration(scope, source, signal, helper);
    const catalogPath = join(helper.root, 'model-catalog.json');
    const config = codexConfig(source, catalogPath, metadata.features);
    // require an exact capability-neutral config
    if (config === undefined) throw new NativeWorkerError('codex_config_invalid');
    await writeFile(catalogPath, `${JSON.stringify(metadata.catalog)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(join(helper.root, 'config.toml'), config, { mode: 0o600, flag: 'wx' });
    const server = new CodexAppServer(nativeProgram(scope), helper.cwd, cleanEnvironment(scope, helper.root), signal);
    const audit = new CodexAudit();
    try {
      await server.initialize();
      const accountBefore = codexAccount(await server.request(2, 'account/read', { refreshToken: false }, message => audit.consume(message)));
      // recheck the logical account immediately before the billed turn
      if (accountBefore !== expectedAccount) throw new NativeWorkerError('codex_account_changed_before_inference');
      const started = object(await server.request(3, 'thread/start', {
        model: source.nativeModel.id, modelProvider: 'openai', cwd: helper.cwd,
        baseInstructions: replySuggestionPrompt, developerInstructions: replySuggestionPrompt,
        threadSource: 'rac-reply-suggestion', sandbox: 'read-only', approvalPolicy: 'never',
        ephemeral: true, environments: [], runtimeWorkspaceRoots: [], dynamicTools: [], selectedCapabilityRoots: [], allowProviderModelFallback: false
      }, message => audit.consume(message)));
      const thread = object(started?.thread);
      // require exact effective thread settings and no history path
      if (thread === undefined || thread.model !== source.nativeModel.id || thread.modelProvider !== 'openai' || thread.reasoningEffort !== source.model.effort || thread.ephemeral !== true || thread.path != null || !Array.isArray(thread.environments) || thread.environments.length !== 0 || thread.cwd !== helper.cwd) throw new NativeWorkerError('codex_thread_scope_mismatch');
      await server.request(4, 'turn/start', {
        threadId: thread.id, input: [{ type: 'text', text: conversation, text_elements: [] }], effort: source.model.effort,
        outputSchema: replySuggestionSchema, environments: [], runtimeWorkspaceRoots: [], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }
      }, message => audit.consume(message));
      // wait for exactly one successful terminal notification
      while (audit.result().terminalStatus !== 'completed') audit.consume(await server.next());
      const accountAfter = codexAccount(await server.request(5, 'account/read', { refreshToken: false }, message => audit.consume(message)));
      const result = audit.result();
      // validate only the exact final json answer
      if (accountAfter === undefined || accountAfter !== accountBefore || result.finalAnswerCount !== 1 || result.finalText === undefined || Buffer.byteLength(result.finalText) > nativeFinalOutputBytes || parseReplySuggestions(result.finalText) === undefined) throw new NativeWorkerError('codex_result_invalid');
      return {
        status: 'completed', kind: 'codex', provider: 'openai', model: source.nativeModel.id, effort: source.model.effort!,
        accountBefore, accountAfter, finalText: result.finalText, finalAnswerCount: 1, terminalStatus: 'completed',
        toolEvents: result.toolEvents, rerouteEvents: result.rerouteEvents, serverRequests: result.serverRequests, errorEvents: result.errorEvents,
        cleanupComplete: true, historyPersisted: false
      };
    } finally {
      await server.close();
    }
  } finally {
    cleanupComplete = await removeCodexHelper(helper);
    // helper cleanup is required even after a completed model turn
    if (!cleanupComplete) throw new NativeWorkerError('codex_helper_cleanup_failed');
  }
}

// create one empty helper directory and empty MCP configuration
async function claudeHelper(): Promise<{ root: string; cwd: string; mcp: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-native-claude-'));
  await chmod(root, 0o700);
  const cwd = join(root, 'cwd');
  await mkdir(cwd, { mode: 0o700 });
  const mcp = join(root, 'empty-mcp.json');
  await writeFile(mcp, '{"mcpServers":{}}\n', { mode: 0o600, flag: 'wx' });
  return { root, cwd, mcp };
}

// remove only a worker-owned Claude helper directory
async function removeClaudeHelper(helper: { root: string }): Promise<boolean> {
  // constrain cleanup to the private temporary prefix
  if (!helper.root.startsWith(join(tmpdir(), 'rac-native-claude-'))) return false;
  await rm(helper.root, { recursive: true, force: true });
  return true;
}

// parse and sanitize the ordinary first-party Claude Pro account
function claudeAccount(raw: Buffer, scope: NativeReplyScope): string | undefined {
  let parsed: JsonObject | undefined;
  try { parsed = object(JSON.parse(raw.toString('utf8'))); } catch { return undefined; }
  // require the original first-party Pro profile
  if (parsed?.loggedIn !== true || parsed.authMethod !== 'claude.ai' || parsed.apiProvider !== 'firstParty' || parsed.subscriptionType !== 'pro') return undefined;
  const configDirectory = typeof parsed.configDirectory === 'string' ? parsed.configDirectory : '';
  const projectsDirectory = typeof parsed.projectsDirectory === 'string' ? parsed.projectsDirectory : '';
  // reject another config or project profile
  if (configDirectory !== scope.configDir || projectsDirectory !== join(scope.configDir, 'projects')) return undefined;
  const identity = { email: parsed.email, orgId: parsed.orgId, authMethod: parsed.authMethod, apiProvider: parsed.apiProvider };
  // logical account identity needs both user and organization
  if (typeof identity.email !== 'string' || identity.email.length === 0 || typeof identity.orgId !== 'string' || identity.orgId.length === 0) return undefined;
  return hash(identity);
}

// derive a nonsecret Claude profile metadata generation
async function claudeCredentialGeneration(scope: NativeReplyScope): Promise<string> {
  const directory = await stat(scope.configDir);
  const candidates = ['.credentials.json', '.claude.json', 'auth.json'];
  const metadata: unknown[] = [directory.dev, directory.ino, directory.mtimeMs, directory.ctimeMs];
  // inspect filenames and metadata only
  for (const name of candidates) {
    const info = await stat(join(scope.configDir, name)).catch(() => undefined);
    // retain only existing metadata
    if (info !== undefined) metadata.push([name, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode]);
  }
  return hash(metadata);
}

// inspect Claude account and exact source selection without inference
async function inspectClaude(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal): Promise<NativeAccountObservation> {
  const helper = await claudeHelper();
  try {
    const version = await programVersion(scope, signal);
    const account = await boundedCommand(nativeProgram(scope), ['auth', 'status', '--json'], { cwd: helper.cwd, env: cleanEnvironment(scope), signal, stdoutBytes: 64 * 1024, stderrBytes: 16 * 1024 });
    const logicalIdentity = account.code === 0 && account.stderr.length === 0 ? claudeAccount(account.stdout, scope) : undefined;
    account.stdout.fill(0);
    account.stderr.fill(0);
    // reject absent or alternate subscription profiles
    if (logicalIdentity === undefined) throw new NativeWorkerError('claude_account_mismatch');
    return {
      kind: 'claude', provider: 'anthropic', logicalIdentity, profile: 'claude-pro',
      model: source.nativeModel.id, effort: source.model.effort!, programVersion: version,
      capabilityGeneration: await capabilityGeneration(scope, version),
      credentialGeneration: await claudeCredentialGeneration(scope)
    };
  } finally {
    // metadata helpers never survive the inspection
    if (!await removeClaudeHelper(helper)) throw new NativeWorkerError('claude_helper_cleanup_failed');
  }
}

// accept only recursively empty denial and tool accounting values
function zeroish(value: unknown): boolean {
  // empty scalar accounting is safe
  if (value === undefined || value === null || value === false || value === 0) return true;
  // every array member must remain empty
  if (Array.isArray(value)) return value.every(zeroish);
  const record = object(value);
  // every object field must remain empty
  return record !== undefined && Object.values(record).every(zeroish);
}

export type ClaudeStreamResult = { finalText: string; finalAnswerCount: number; toolEvents: number; rerouteEvents: number; serverRequests: number; errorEvents: number };

// inspect every native Claude stream record and discard private thinking
export function parseClaudeStream(raw: Buffer, source: NativeReplySuggestionSource, cwd: string): ClaudeStreamResult {
  let decoded: string;
  // malformed output bytes never become replacement-character reply drafts
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new NativeWorkerError('claude_stream_invalid_json'); }
  const lines = decoded.split(/\r?\n/u).filter(Boolean);
  // bound the protocol record count
  if (lines.length === 0 || lines.length > 200) throw new NativeWorkerError('claude_stream_count_invalid');
  let initSeen = false;
  let resultSeen = false;
  let resultText: string | undefined;
  let assistantRecords = 0;
  const assistantText: string[] = [];
  // inspect every event before accepting final text
  for (const line of lines) {
    // reject individually oversized records
    if (Buffer.byteLength(line) > 256 * 1024) throw new NativeWorkerError('claude_stream_record_too_large');
    let event: JsonObject | undefined;
    try { event = object(JSON.parse(line)); } catch { throw new NativeWorkerError('claude_stream_invalid_json'); }
    // every event must be an object
    if (event === undefined) throw new NativeWorkerError('claude_stream_invalid_record');
    const type = event.type;
    // allow one explicit allowed rate-limit state
    if (type === 'rate_limit_event') {
      const info = object(event.rate_limit_info);
      if (info?.status !== 'allowed') throw new NativeWorkerError('claude_rate_limit_denied');
      continue;
    }
    // allow only an inert partial message-start marker
    if (type === 'stream_event') {
      const nested = object(event.event);
      const message = object(nested?.message);
      if (nested?.type !== 'message_start' || message?.type !== 'message' || message.role !== 'assistant' || message.model !== source.nativeModel.id || !Array.isArray(message.content) || message.content.length !== 0 || message.stop_reason != null) throw new NativeWorkerError('claude_partial_event_rejected');
      continue;
    }
    // validate inert native system metadata
    if (type === 'system') {
      const subtype = event.subtype;
      // ui redraw carries no model action
      if (subtype === 'ui_invalidate') continue;
      // bounded request status is inert
      if (subtype === 'status' && [undefined, null, 'requesting'].includes(event.status as never)) continue;
      // thinking-token counts carry no private text
      if (subtype === 'thinking_tokens' && Number.isInteger(event.estimated_tokens) && Number(event.estimated_tokens) >= 0 && Number.isInteger(event.estimated_tokens_delta) && Number(event.estimated_tokens_delta) >= 0) continue;
      // require exactly one capability-neutral initialization
      if (subtype !== 'init' || initSeen || event.model !== source.nativeModel.id || !Array.isArray(event.tools) || event.tools.length !== 0 || !Array.isArray(event.mcp_servers) || event.mcp_servers.length !== 0 || !Array.isArray(event.skills) || event.skills.length !== 0 || !Array.isArray(event.slash_commands) || event.slash_commands.length !== 0 || event.permissionMode !== 'dontAsk' || event.cwd !== cwd) throw new NativeWorkerError('claude_init_policy_mismatch');
      initSeen = true;
      continue;
    }
    // accept only assistant text and discard private reasoning blocks
    if (type === 'assistant') {
      if (resultSeen) throw new NativeWorkerError('claude_assistant_after_result');
      const message = object(event.message);
      // reject model reroutes and server tool usage
      if (message?.model !== source.nativeModel.id || (event.requestedModel !== undefined && event.requestedModel !== source.nativeModel.id) || (event.advisorModel !== undefined && event.advisorModel !== source.nativeModel.id) || !zeroish(object(message?.usage)?.server_tool_use)) throw new NativeWorkerError('claude_model_or_tool_mismatch');
      const content = message.content;
      // require a bounded content block list
      if (!Array.isArray(content)) throw new NativeWorkerError('claude_content_invalid');
      assistantRecords += 1;
      // inspect every block and retain text only
      for (const blockValue of content) {
        const block = object(blockValue);
        // malformed blocks fail closed
        if (block === undefined) throw new NativeWorkerError('claude_content_invalid');
        // retain bounded final text
        if (block.type === 'text' && typeof block.text === 'string') { assistantText.push(block.text); continue; }
        // discard private reasoning
        if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
        throw new NativeWorkerError('claude_tool_event');
      }
      continue;
    }
    // require one exact successful result envelope
    if (type === 'result') {
      if (resultSeen || event.subtype !== 'success' || event.is_error !== false || event.terminal_reason !== 'completed' || typeof event.result !== 'string' || !zeroish(event.permission_denials) || !zeroish(event.safety_stops) || !zeroish(event.errors)) throw new NativeWorkerError('claude_result_failed');
      const usage = object(event.modelUsage);
      const incremental = object(event.model_usage_since_last_result);
      const usageIds = usage === undefined ? [] : Object.keys(usage);
      const incrementalIds = incremental === undefined ? [] : Object.keys(incremental);
      // actual usage must name only the selected model
      if (usageIds.length !== 1 || usageIds[0] !== source.nativeModel.id || incrementalIds.some(id => id !== source.nativeModel.id)) throw new NativeWorkerError('claude_model_usage_mismatch');
      resultSeen = true;
      resultText = event.result;
      continue;
    }
    throw new NativeWorkerError('claude_unknown_event');
  }
  const joined = assistantText.join('');
  // require one final assistant answer consistent with the result envelope
  if (!initSeen || !resultSeen || assistantRecords !== 1 || resultText === undefined || joined.trim() !== resultText.trim() || Buffer.byteLength(resultText) > nativeFinalOutputBytes || parseReplySuggestions(resultText) === undefined) throw new NativeWorkerError('claude_final_answer_invalid');
  return { finalText: resultText, finalAnswerCount: 1, toolEvents: 0, rerouteEvents: 0, serverRequests: 0, errorEvents: 0 };
}

type ClaudeSessionPersistence = 'clean' | 'persisted' | 'indeterminate';

// detect a forbidden persisted helper session by filename only
export async function claudeSessionPersistence(configDir: string, sessionId: string): Promise<ClaudeSessionPersistence> {
  const pending = [configDir];
  let visited = 0;
  // bound profile filename traversal
  while (pending.length > 0) {
    // incomplete traversal cannot prove clean history
    if (visited >= 4_096) return 'indeterminate';
    const directory = pending.pop()!;
    visited += 1;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
    // unreadable history cannot prove clean history
    if (entries === undefined) return 'indeterminate';
    // keep bounded traversal deterministic
    entries.sort((left, right) => left.name.localeCompare(right.name));
    // inspect each bounded profile entry
    for (const entry of entries) {
      // any matching filename proves persistence
      if (entry.name.includes(sessionId)) return 'persisted';
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(directory, entry.name));
    }
  }
  return 'clean';
}

// require complete proof that helper history stayed clean
export async function claudeSessionPostflight(configDir: string, sessionId: string): Promise<void> {
  const persistence = await claudeSessionPersistence(configDir, sessionId);
  // persisted or incomplete history cannot publish suggestions
  if (persistence !== 'clean') throw new NativeWorkerError('claude_postflight_failed');
}

// run one exact no-tool, no-history Claude turn
async function generateClaude(scope: NativeReplyScope, source: NativeReplySuggestionSource, expectedAccount: string, signal: AbortSignal): Promise<NativeGenerationResult> {
  const before = await inspectClaude(scope, source, signal);
  // account changes abort before inference
  if (before.logicalIdentity !== expectedAccount) throw new NativeWorkerError('claude_account_changed_before_inference');
  const conversation = nativeConversation(source.messages);
  // oversized source data never reaches the model
  if (conversation === undefined) throw new NativeWorkerError('native_conversation_too_large');
  const helper = await claudeHelper();
  const sessionId = randomUUID();
  try {
    const args = claudeArguments(source, helper.mcp, sessionId);
    // reject malformed source selection
    if (args === undefined) throw new NativeWorkerError('claude_arguments_invalid');
    const command = await boundedCommand(nativeProgram(scope), args, { cwd: helper.cwd, env: cleanEnvironment(scope), input: conversation, signal, stdoutBytes: nativeProtocolOutputBytes, stderrBytes: nativeStderrBytes });
    // stderr and nonzero exit are never accepted
    if (command.code !== 0 || command.stderr.length !== 0 || !command.cleanupComplete) throw new NativeWorkerError('claude_command_failed');
    const parsed = parseClaudeStream(command.stdout, source, helper.cwd);
    const after = await inspectClaude(scope, source, signal);
    await claudeSessionPostflight(scope.configDir, sessionId);
    // the billed account must remain identical
    if (after.logicalIdentity !== before.logicalIdentity) throw new NativeWorkerError('claude_postflight_failed');
    return {
      status: 'completed', kind: 'claude', provider: 'anthropic', model: source.nativeModel.id, effort: source.model.effort!,
      accountBefore: before.logicalIdentity, accountAfter: after.logicalIdentity,
      finalText: parsed.finalText, finalAnswerCount: parsed.finalAnswerCount, terminalStatus: 'completed',
      toolEvents: parsed.toolEvents, rerouteEvents: parsed.rerouteEvents, serverRequests: parsed.serverRequests, errorEvents: parsed.errorEvents,
      cleanupComplete: true, historyPersisted: false
    };
  } finally {
    // private helper files never persist
    if (!await removeClaudeHelper(helper)) throw new NativeWorkerError('claude_helper_cleanup_failed');
  }
}

// require one server-private source and its exact current process scope
async function validateRequest(request: NativeWorkerRequest): Promise<{ scope: NativeReplyScope; source: NativeReplySuggestionSource }> {
  const { scope, source } = request;
  const kind = source.kind === 'claude' ? 'claude' : 'codex';
  // reject cross-kind, pi and caller-selected process routes
  if (scope.kind !== kind || source.nativeScope.kind !== kind || JSON.stringify(scope) !== JSON.stringify(source.nativeScope)) throw new NativeWorkerError('native_cross_kind_route');
  // require exact provider family and current model effort
  if (source.nativeModel.provider !== (kind === 'codex' ? 'openai' : 'anthropic') || (kind === 'codex' && source.nativeModel.id !== source.model.model) || typeof source.model.model !== 'string' || source.model.model.length === 0 || typeof source.model.effort !== 'string' || source.model.effort.length === 0) throw new NativeWorkerError('native_selection_invalid');
  const current = await nativeReplyScope(kind, scope.process, process.env, source.conversationId, source.transport);
  // reject changed processes, homes, profiles and binaries
  if (current?.fingerprint !== scope.fingerprint || current.program !== scope.program || current.home !== scope.home || current.configDir !== scope.configDir) throw new NativeWorkerError('native_scope_changed');
  return { scope: current, source };
}

// execute one private worker operation
export async function handleNativeWorkerRequest(request: NativeWorkerRequest, signal?: AbortSignal): Promise<NativeWorkerResponse> {
  try {
    // require one exact protocol request
    if (request.version !== 1 || !['inspect', 'generate'].includes(request.action)) throw new NativeWorkerError('native_request_invalid');
    const selected = await validateRequest(request);
    const bounded = deadlineSignal(signal);
    // metadata inspection never performs inference
    if (request.action === 'inspect') {
      const observation = selected.scope.kind === 'codex'
        ? (await inspectCodex(selected.scope, selected.source, bounded)).observation
        : await inspectClaude(selected.scope, selected.source, bounded);
      return { version: 1, ok: true, observation };
    }
    // generation requires the route's pre-observed account hash
    if (typeof request.expectedAccount !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedAccount)) throw new NativeWorkerError('native_expected_account_invalid');
    const result = selected.scope.kind === 'codex'
      ? await generateCodex(selected.scope, selected.source, request.expectedAccount, bounded)
      : await generateClaude(selected.scope, selected.source, request.expectedAccount, bounded);
    return { version: 1, ok: true, result };
  } catch (error) {
    return { version: 1, ok: false, errorCode: error instanceof NativeWorkerError ? error.code : 'native_internal_error' };
  }
}

// read one bounded newline-delimited request stream
async function readRequest(stream: NodeJS.ReadableStream): Promise<NativeWorkerRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<NativeWorkerRequest>((resolve, reject) => {
    let settled = false;
    // parse one complete request line
    const finish = () => {
      // ignore duplicate stream completion
      if (settled) return;
      const raw = Buffer.concat(chunks);
      const newline = raw.indexOf(10);
      // wait for either newline or eof
      if (newline < 0) return;
      settled = true;
      try {
        const parsed = object(JSON.parse(raw.subarray(0, newline).toString('utf8')));
        // require one object request
        if (parsed === undefined) throw new Error('not object');
        resolve(parsed as NativeWorkerRequest);
      } catch { reject(new NativeWorkerError('native_request_invalid_json')); }
    };
    // consume bounded request chunks
    stream.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.length;
      // reject request overflow before parsing
      if (total > nativeRequestBytes) { settled = true; reject(new NativeWorkerError('native_request_too_large')); return; }
      chunks.push(value);
      finish();
    });
    stream.once('error', () => { if (!settled) reject(new NativeWorkerError('native_request_read_failed')); });
    stream.once('end', () => {
      // accept an eof-terminated local stdio request
      if (!settled && chunks.length > 0 && !Buffer.concat(chunks).includes(10)) chunks.push(Buffer.from('\n'));
      finish();
    });
  });
}

// write one bounded sanitized response
function writeResponse(stream: NodeJS.WritableStream, response: NativeWorkerResponse): void {
  const encoded = `${JSON.stringify(response)}\n`;
  // an oversized internal response becomes a stable failure
  if (Buffer.byteLength(encoded) > 64 * 1024) stream.end(`${JSON.stringify({ version: 1, ok: false, errorCode: 'native_response_too_large' })}\n`);
  else stream.end(encoded);
}

// serve one stdio or private unix-socket request
async function workerMain(): Promise<void> {
  const [flag, socketPath, ...extra] = process.argv.slice(2);
  // stdio mode accepts no argv
  if (flag === undefined) {
    const request = await readRequest(process.stdin);
    const controller = new AbortController();
    // process termination cancels the private cli group
    process.once('SIGTERM', () => controller.abort());
    process.once('SIGINT', () => controller.abort());
    writeResponse(process.stdout, await handleNativeWorkerRequest(request, controller.signal));
    return;
  }
  const socketRoot = process.env.RAC_NATIVE_SOCKET_ROOT;
  // socket mode accepts one private path beneath its fixed root
  if (flag !== '--socket' || socketPath === undefined || extra.length > 0 || socketRoot === undefined || dirname(socketPath) !== socketRoot || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sock$/u.test(basename(socketPath))) throw new NativeWorkerError('native_socket_path_invalid');
  const socket = createConnection(socketPath);
  socket.setTimeout(nativeTimeoutMs, () => socket.destroy(new NativeWorkerError('native_socket_timeout')));
  const request = await readRequest(socket);
  const controller = new AbortController();
  // a lost caller cancels only this helper operation
  socket.once('close', () => controller.abort());
  writeResponse(socket, await handleNativeWorkerRequest(request, controller.signal));
}

// execute only when launched as the private worker entrypoint
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  workerMain().catch(error => {
    writeResponse(process.stdout, { version: 1, ok: false, errorCode: error instanceof NativeWorkerError ? error.code : 'native_internal_error' });
    process.exitCode = 1;
  });
}
