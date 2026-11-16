import { createHash } from 'node:crypto';
import { lstat, open, readdir, readlink, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isCodexCommand } from '../adapters/codex-processes.js';
import { isOmxLeaderCommand } from '../adapters/omx-processes.js';
import type { NativeReplyScope } from './types.js';

type NativeKind = 'codex' | 'omx' | 'claude';
type NativeTransport = 'tmux' | 'structured';
type ProcessIdentity = { pid: number; startTime: string };
type ProcessRecord = ProcessIdentity & { comm: string; argv: string[]; program: string; cwd: string };
type SelectedEnvironment = { values: Record<string, string>; forbidden: Set<string> };
type StableConfig = { bytes: Buffer; generation: readonly string[] };

const maximumEnvironmentBytes = 256 * 1024;
const maximumConfigBytes = 256 * 1024;
const maximumProcesses = 256;
const maximumDescriptors = 4_096;
const selectedEnvironmentNames = new Set(['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_KIND']);
const forbiddenEnvironmentNames = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_FEDERATION_RULE_ID',
  'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_APP_SERVER_CHATGPT_BASE_URL', 'CODEX_OSS_BASE_URL',
  'CODEX_AUTH', 'CODEX_AUTHAPI_BASE_URL', 'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL',
  'CODEX_AGENT_IDENTITY_JWKS_BASE_URL', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS', 'CODEX_NETWORK_PROXY_ACTIVE',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_GATEWAY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_REMOTE_SDK_URL',
  'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_CLOUD_SESSION_ID', 'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_UUID', 'CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_SESSIONS_OAUTH_TOKEN', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
]);
const detachedClaudeArguments = ['--bg', '--background', '--cloud', '--teleport', '--from-pr', '--remote-control', '--desktop', '--environment'] as const;
const unsafeCodexArguments = ['--profile', '-p', '--remote', '--remote-auth-token-env', '--oss', '--local-provider'] as const;
const safeCodexConfigOverrides = new Set(['model', 'model_reasoning_effort', 'check_for_update_on_startup', 'model_instructions_file']);
const unsafeTomlRoutingKeys = new Set([
  'model_provider', 'model_providers', 'openai_base_url', 'chatgpt_base_url', 'oss_provider', 'local_provider',
  'experimental_realtime_ws_base_url', 'experimental_realtime_webrtc_call_base_url', 'base_url', 'env_key',
  'requires_openai_auth', 'wire_api', 'bearer_token', 'credential_file', 'profile'
]);
const unsafeJsonRoutingKeys = new Set([
  'apikeyhelper', 'awsauthrefresh', 'awscredentialexport', 'gcpauthrefresh', 'proxyauthhelper', 'policyhelper',
  'forcelogingatewayurl', 'forceloginmethod', 'forceloginorguuid', 'modeloverrides',
  'anthropic_api_key', 'anthropic_auth_token', 'anthropic_base_url', 'anthropic_custom_headers',
  'anthropic_foundry_api_key', 'anthropic_foundry_auth_token', 'anthropic_foundry_base_url', 'anthropic_foundry_resource',
  'anthropic_vertex_base_url', 'anthropic_vertex_project_id', 'anthropic_bedrock_base_url', 'claude_code_oauth_token',
  'anthropic_federation_rule_id', 'anthropic_organization_id', 'claude_code_api_key_file_descriptor',
  'claude_code_oauth_token_file_descriptor', 'claude_code_websocket_auth_file_descriptor', 'claude_code_gateway_token',
  'claude_code_gateway_token_file_descriptor', 'claude_code_remote_sdk_url',
  'claude_code_use_bedrock', 'claude_code_use_vertex', 'claude_code_use_foundry', 'claude_code_use_gateway',
  'anthropic_model', 'anthropic_default_opus_model', 'anthropic_default_sonnet_model', 'anthropic_default_haiku_model',
  'aws_access_key_id', 'aws_secret_access_key', 'aws_session_token', 'aws_profile', 'aws_bearer_token_bedrock',
  'google_application_credentials', 'google_cloud_project', 'cloud_ml_region', 'node_extra_ca_certs', 'ssl_cert_file',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'include', 'includes', 'extends', '$include', '$ref'
]);
const conversationPattern = /(?:^|\/)rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

// parse one live proc stat without trusting the command name's spaces
function processStat(value: string, expectedPid: number): { startTime: string; live: boolean } | undefined {
  const openIndex = value.indexOf('(');
  const closeIndex = value.lastIndexOf(')');
  // reject malformed or replaced proc records
  if (openIndex < 0 || closeIndex <= openIndex || Number(value.slice(0, openIndex).trim()) !== expectedPid) return undefined;
  const fields = value.slice(closeIndex + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  // reject exited and incomplete identities
  if (startTime === undefined || !/^\d+$/u.test(startTime) || fields[0] === 'Z' || fields[0] === 'X') return undefined;
  return { startTime, live: true };
}

// read one bounded proc file as bytes
async function boundedBytes(path: string, maximum: number): Promise<Buffer | undefined> {
  const handle = await open(path, 'r').catch(() => undefined);
  // unreadable proc metadata cannot authorize a route
  if (handle === undefined) return undefined;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    // stop before an environment can grow unbounded
    while (total <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      // eof completes the bounded record
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    // oversized metadata fails closed
    if (total > maximum) return undefined;
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

// address one absolute path through the exact source mount namespace
function processPath(procRoot: string, pid: number, path: string): string | undefined {
  return isAbsolute(path) && !/[\u0000-\u001f\u007f]/u.test(path) ? join(procRoot, String(pid), 'root', path.slice(1)) : undefined;
}

// recognize one absent optional routing file
function missingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

// read one stable bounded config without parsing secret values
async function stableConfig(procRoot: string, pid: number, logicalPath: string): Promise<StableConfig | null | undefined> {
  const path = processPath(procRoot, pid, logicalPath);
  // invalid source paths are ambiguous
  if (path === undefined) return undefined;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    return missingFile(error) ? null : undefined;
  }
  let bytes: Buffer | undefined;
  let returned = false;
  try {
    const before = await handle.stat({ bigint: true });
    // reject aliases and oversized or nonregular routing files
    const linked = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!before.isFile() || linked === undefined || linked.isSymbolicLink() || linked.dev !== before.dev || linked.ino !== before.ino || before.size < 0n || before.size > BigInt(maximumConfigBytes)) return undefined;
    bytes = Buffer.allocUnsafe(Number(before.size));
    let read = 0;
    // fill the exact stable file snapshot
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      // a short stable read is ambiguous
      if (result.bytesRead === 0) return undefined;
      read += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    // any concurrent replacement or write fails closed
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return undefined;
    returned = true;
    return {
      bytes,
      generation: [logicalPath, before.dev.toString(), before.ino.toString(), before.size.toString(), before.mtimeNs.toString(), before.ctimeNs.toString(), before.mode.toString()]
    };
  } finally {
    // failed snapshots never retain config bytes
    if (!returned) bytes?.fill(0);
    await handle.close();
  }
}

// find one toml comment or assignment outside quoted values
function tomlBoundary(line: Buffer): { end: number; equals: number } {
  let quote = 0;
  let escaped = false;
  let equals = -1;
  // inspect syntax bytes without decoding values
  for (let index = 0; index < line.length; index += 1) {
    const byte = line[index]!;
    // basic strings honor escapes
    if (quote === 0x22 && escaped) { escaped = false; continue; }
    if (quote === 0x22 && byte === 0x5c) { escaped = true; continue; }
    // matching quotes close strings
    if (quote !== 0 && byte === quote) { quote = 0; continue; }
    // either quote opens a string
    if (quote === 0 && (byte === 0x22 || byte === 0x27)) { quote = byte; continue; }
    // comments end the statement
    if (quote === 0 && byte === 0x23) return { end: index, equals };
    // retain only the first assignment boundary
    if (quote === 0 && byte === 0x3d && equals < 0) equals = index;
  }
  return { end: line.length, equals };
}

// decode one bounded toml key while rejecting escape ambiguity
function tomlKey(bytes: Buffer): string | undefined {
  if (bytes.length > 256 || bytes.includes(0x5c)) return undefined;
  const key = bytes.toString('utf8').replace(/[\s"']/gu, '').toLowerCase();
  return key !== '' && !/[\u0000-\u001f\u007f]/u.test(key) ? key : undefined;
}

// accept only default first-party Codex routing configuration
function safeCodexConfig(bytes: Buffer): boolean {
  let offset = 0;
  // inspect every statement without decoding unrelated values
  while (offset <= bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const limit = newline < 0 ? bytes.length : newline;
    const line = bytes.subarray(offset, limit);
    const boundary = tomlBoundary(line);
    const statement = line.subarray(0, boundary.end);
    const start = statement.findIndex(byte => ![0x20, 0x09, 0x0d].includes(byte));
    const trimmed = statement.subarray(start < 0 ? statement.length : start);
    // table headers can activate a custom provider without an assignment here
    if (trimmed[0] === 0x5b) {
      const close = trimmed.lastIndexOf(0x5d);
      const table = close > 0 ? tomlKey(trimmed.subarray(1, close)) : undefined;
      if (table === undefined || table.split('.').some(key => unsafeTomlRoutingKeys.has(key))) return false;
    } else if (boundary.equals >= 0 && boundary.equals < boundary.end) {
      const key = tomlKey(line.subarray(0, boundary.equals));
      // ambiguous keys cannot prove route ownership
      if (key === undefined || key.split('.').some(part => unsafeTomlRoutingKeys.has(part))) return false;
      if (key === 'cli_auth_credentials_store') {
        const rawValue = line.subarray(boundary.equals + 1, boundary.end);
        // only a short literal file store shares the helper's auth source
        if (rawValue.length > 32 || !/^(?:["']file["']|file)$/iu.test(rawValue.toString('utf8').trim())) return false;
      }
    }
    // eof completes the scan
    if (newline < 0) break;
    offset = newline + 1;
  }
  return true;
}

// collect json object keys without decoding any value strings
function jsonKeys(bytes: Buffer): Set<string> | undefined {
  const keys = new Set<string>();
  let index = 0;
  // scan every string boundary and retain only object keys
  while (index < bytes.length) {
    // skip nonstring bytes
    if (bytes[index] !== 0x22) { index += 1; continue; }
    const start = ++index;
    let escaped = false;
    // find the matching string terminator
    while (index < bytes.length) {
      const byte = bytes[index]!;
      // escaped key syntax is intentionally unsupported
      if (byte === 0x5c) { escaped = true; index += 2; continue; }
      if (byte === 0x22) break;
      // raw controls are invalid json
      if (byte < 0x20) return undefined;
      index += 1;
    }
    // unterminated strings fail closed
    if (index >= bytes.length) return undefined;
    const end = index++;
    let next = index;
    // ignore insignificant json whitespace
    while (next < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[next]!)) next += 1;
    // value strings never become retained keys
    if (bytes[next] !== 0x3a) continue;
    if (escaped || end - start > 128) return undefined;
    const key = bytes.subarray(start, end).toString('utf8');
    // ambiguous or malformed keys fail closed
    if (!/^[\x20-\x7e]+$/u.test(key)) return undefined;
    keys.add(key.toLowerCase());
  }
  return keys;
}

// accept only Claude settings without alternate account or endpoint keys
function safeClaudeSettings(bytes: Buffer): boolean {
  const keys = jsonKeys(bytes);
  // unknown key syntax cannot prove first-party routing
  if (keys === undefined) return false;
  // reject every routing-bearing settings key
  for (const key of keys) {
    if (unsafeJsonRoutingKeys.has(key) || /(?:provider|base.?url|api.?key|auth(?:token|helper)|credential(?:export|helper)|gateway(?:url|token)|proxy(?:url|auth)|^(?:oauth|access|refresh)token$)/iu.test(key)) return false;
  }
  return true;
}

// enumerate one bounded absolute ancestry
function ancestors(path: string): string[] | undefined {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) return undefined;
  const values: string[] = [];
  let current = path;
  // stop at root or a maliciously deep path
  while (values.length < 64) {
    values.push(current);
    const parent = dirname(current);
    // filesystem root completes the ancestry
    if (parent === current) return values;
    current = parent;
  }
  return undefined;
}

// retain only route-selecting environment values and forbidden variable names
async function selectedEnvironment(procRoot: string, pid: number): Promise<SelectedEnvironment | undefined> {
  const raw = await boundedBytes(join(procRoot, String(pid), 'environ'), maximumEnvironmentBytes);
  // exact process environment is required
  if (raw === undefined) return undefined;
  try {
    const values: Record<string, string> = {};
    const forbidden = new Set<string>();
    let offset = 0;
    // scan nul-delimited entries without decoding secret values
    while (offset < raw.length) {
      const end = raw.indexOf(0, offset);
      const limit = end < 0 ? raw.length : end;
      const equals = raw.indexOf(61, offset);
      // ignore malformed entries
      if (equals > offset && equals < limit) {
        const name = raw.subarray(offset, equals).toString('utf8');
        // retain only nonsecret path selectors
        if (selectedEnvironmentNames.has(name)) {
          const value = raw.subarray(equals + 1, limit).toString('utf8');
          // reject oversized or control-bearing paths
          if (Buffer.byteLength(value) > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
          values[name] = value;
        }
        // remember only the name of a forbidden redirect or credential
        if (forbiddenEnvironmentNames.has(name)) forbidden.add(name);
      }
      offset = limit + 1;
    }
    return { values, forbidden };
  } finally {
    raw.fill(0);
  }
}

// read one exact live process identity and first-party executable
async function processRecord(procRoot: string, identity: ProcessIdentity): Promise<ProcessRecord | undefined> {
  const root = join(procRoot, String(identity.pid));
  const [rawStat, rawCommand, rawName, linkedProgram, linkedCwd] = await Promise.all([
    boundedBytes(join(root, 'stat'), 16 * 1024),
    boundedBytes(join(root, 'cmdline'), 128 * 1024),
    boundedBytes(join(root, 'comm'), 4 * 1024),
    readlink(join(root, 'exe')).catch(() => undefined),
    readlink(join(root, 'cwd')).catch(() => undefined)
  ]);
  // require every process identity input
  if (rawStat === undefined || rawCommand === undefined || rawName === undefined || linkedProgram === undefined || linkedCwd === undefined) {
    rawStat?.fill(0); rawCommand?.fill(0); rawName?.fill(0);
    return undefined;
  }
  try {
    const parsed = processStat(rawStat.toString('utf8'), identity.pid);
    // pin the same process lifetime supplied by discovery
    if (parsed?.startTime !== identity.startTime) return undefined;
    const argv = rawCommand.toString('utf8').split('\0').filter(Boolean);
    const comm = rawName.toString('utf8').trim();
    // require one absolute live host executable path
    if (argv.length === 0 || !isAbsolute(linkedProgram) || linkedProgram.endsWith(' (deleted)') || /[\u0000-\u001f\u007f]/u.test(linkedProgram)
      || !isAbsolute(linkedCwd) || linkedCwd.endsWith(' (deleted)') || /[\u0000-\u001f\u007f]/u.test(linkedCwd)) return undefined;
    return { ...identity, comm, argv, program: linkedProgram, cwd: linkedCwd };
  } finally {
    rawStat.fill(0); rawCommand.fill(0); rawName.fill(0);
  }
}

// recognize the direct native Claude executable only
function isClaudeProcess(process: ProcessRecord): boolean {
  return process.comm === 'claude' || basename(process.argv[0] ?? '') === 'claude' || basename(process.program) === 'claude';
}

// find one exact or equals-form cli flag
function hasArgument(argv: readonly string[], name: string): boolean {
  return argv.some(argument => argument === name || argument.startsWith(`${name}=`));
}

// read one managed cli flag value
function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.findIndex(argument => argument === name || argument.startsWith(`${name}=`));
  // absent flags carry no value
  if (index < 0) return undefined;
  const argument = argv[index]!;
  return argument === name ? argv[index + 1] : argument.slice(name.length + 1);
}

// read every exact or equals-form cli flag value
function argumentValues(argv: readonly string[], name: string): string[] | undefined {
  const values: string[] = [];
  // inspect every argument occurrence
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    // exact flags consume the following argument
    if (argument === name) {
      const value = argv[++index];
      if (value === undefined) return undefined;
      values.push(value);
      continue;
    }
    // equals-form flags retain only their value
    if (argument.startsWith(`${name}=`)) values.push(argument.slice(name.length + 1));
  }
  return values;
}

// allow only routing-neutral Codex command-line overrides
function allowedCodexMode(process: ProcessRecord): boolean {
  // profiles, remote servers and local providers change account ownership
  if (unsafeCodexArguments.some(argument => hasArgument(process.argv, argument)) || process.argv.some(argument => /^-p.+/u.test(argument) && !argument.startsWith('--'))) return false;
  const short = argumentValues(process.argv, '-c');
  const long = argumentValues(process.argv, '--config');
  // malformed override syntax is ambiguous
  if (short === undefined || long === undefined) return false;
  const compact = process.argv.filter(argument => /^-c.+/u.test(argument) && !argument.startsWith('--')).map(argument => argument.slice(2));
  // inspect only override key names, never their values
  for (const assignment of [...short, ...long, ...compact]) {
    const separator = assignment.indexOf('=');
    const key = separator < 0 ? '' : assignment.slice(0, separator).trim();
    // only exact nonrouting keys preserve source ownership
    if (!safeCodexConfigOverrides.has(key)) return false;
  }
  return true;
}

// constrain tmux to foreground tui and structured to the managed stream protocol
function allowedClaudeMode(process: ProcessRecord, transport: NativeTransport): boolean {
  // detached, cloud and remote sessions are never own-local routes
  if (detachedClaudeArguments.some(argument => hasArgument(process.argv, argument))) return false;
  // alternate auth or customization-suppression modes are not source evidence
  if (hasArgument(process.argv, '--bare') || hasArgument(process.argv, '--safe-mode')) return false;
  const printed = hasArgument(process.argv, '-p') || hasArgument(process.argv, '--print') || process.argv.some(argument => /^-p.+/u.test(argument) && !argument.startsWith('--'));
  // tmux requires one ordinary foreground interactive process
  if (transport === 'tmux') return !printed;
  // structured requires the exact console-owned duplex stream mode
  return printed
    && argumentValue(process.argv, '--input-format') === 'stream-json'
    && argumentValue(process.argv, '--output-format') === 'stream-json'
    && argumentValue(process.argv, '--permission-prompts') === 'host'
    && argumentValue(process.argv, '--permission-prompt-tool') === 'stdio';
}

// inspect one optional routing file and retain only its metadata generation
async function inspectRoutingFile(procRoot: string, pid: number, path: string, format: 'toml' | 'json', generations: string[][]): Promise<boolean> {
  const snapshot = await stableConfig(procRoot, pid, path);
  // unreadable or unstable config is ambiguous
  if (snapshot === undefined) return false;
  // absence is itself a generation that can later become stale
  if (snapshot === null) { generations.push([path, 'absent']); return true; }
  try {
    const safe = format === 'toml' ? safeCodexConfig(snapshot.bytes) : safeClaudeSettings(snapshot.bytes);
    // unsafe provider or account routing is never reproduced
    if (!safe) return false;
    generations.push([...snapshot.generation]);
    return true;
  } finally {
    snapshot.bytes.fill(0);
  }
}

// qualify every source-visible Codex routing layer
async function codexRoutingGeneration(procRoot: string, process: ProcessRecord, configDir: string): Promise<string[][] | undefined> {
  // command-line routing must stay on the default first-party provider
  if (!allowedCodexMode(process)) return undefined;
  const parents = ancestors(process.cwd);
  // cwd ancestry determines workspace config precedence
  if (parents === undefined) return undefined;
  const paths = new Set<string>([
    join(configDir, 'config.toml'),
    '/etc/codex/config.toml', '/etc/codex/managed-config.toml', '/etc/codex/managed_config.toml'
  ]);
  // include every possible workspace-local Codex config
  for (const parent of parents) paths.add(join(parent, '.codex', 'config.toml'));
  const generations: string[][] = [];
  // every present routing layer must be unambiguously safe
  for (const path of paths) {
    if (!await inspectRoutingFile(procRoot, process.pid, path, 'toml', generations)) return undefined;
  }
  return generations;
}

// qualify every source-visible Claude routing layer
async function claudeRoutingGeneration(procRoot: string, process: ProcessRecord, home: string, configDir: string): Promise<string[][] | undefined> {
  const declaredSources = argumentValues(process.argv, '--setting-sources');
  // multiple or malformed source selectors are ambiguous
  if (declaredSources === undefined || declaredSources.length > 1) return undefined;
  const selected = new Set((declaredSources[0] ?? 'user,project,local').split(',').map(value => value.trim()).filter(Boolean));
  // only documented local settings sources are supported
  for (const source of selected) {
    if (!['user', 'project', 'local'].includes(source)) return undefined;
  }
  const paths = new Set<string>([
    '/etc/claude-code/managed-settings.json', join(configDir, 'managed-settings.json'), join(home, '.claude.json')
  ]);
  // user settings remain active unless the source selector excludes them
  if (selected.has('user')) paths.add(join(configDir, 'settings.json'));
  const parents = ancestors(process.cwd);
  // project and local settings follow the source cwd ancestry
  if (parents === undefined) return undefined;
  for (const parent of parents) {
    if (selected.has('project')) paths.add(join(parent, '.claude', 'settings.json'));
    if (selected.has('local')) paths.add(join(parent, '.claude', 'settings.local.json'));
  }
  const generations: string[][] = [];
  const explicit = argumentValues(process.argv, '--settings');
  // malformed explicit settings cannot prove route ownership
  if (explicit === undefined) return undefined;
  // inspect every console-authored settings layer
  for (const value of explicit) {
    if (Buffer.byteLength(value) > maximumConfigBytes) return undefined;
    if (value.trimStart().startsWith('{')) {
      const bytes = Buffer.from(value);
      try {
        // inline settings can carry the same credential helpers as files
        if (!safeClaudeSettings(bytes)) return undefined;
        generations.push(['inline-settings', createHash('sha256').update(bytes).digest('base64url')]);
      } finally {
        bytes.fill(0);
      }
      continue;
    }
    paths.add(isAbsolute(value) ? value : resolve(process.cwd, value));
  }
  // every present routing layer must be unambiguously safe
  for (const path of paths) {
    if (!await inspectRoutingFile(procRoot, process.pid, path, 'json', generations)) return undefined;
  }
  generations.push(['setting-sources', [...selected].sort().join(',')]);
  return generations;
}

// list one bounded descendant tree from proc children files
async function descendants(procRoot: string, root: number): Promise<number[] | undefined> {
  const pending = [root];
  const seen = new Set<number>();
  const found: number[] = [];
  // bound traversal and reject cycles
  while (pending.length > 0) {
    const pid = pending.pop()!;
    // skip repeated descendants
    if (seen.has(pid)) continue;
    // a partial tree cannot prove unique process selection
    if (seen.size >= maximumProcesses) return undefined;
    seen.add(pid);
    const raw = await boundedBytes(join(procRoot, String(pid), 'task', String(pid), 'children'), 32 * 1024);
    // an unreadable or exited node makes the tree incomplete
    if (raw === undefined) return undefined;
    const children = raw.toString('utf8').trim().split(/\s+/u).filter(Boolean).map(Number);
    // retain only valid child identifiers
    for (const child of children) {
      // reject malformed child entries
      if (!Number.isInteger(child) || child <= 0) continue;
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

// prove one process holds the expected Codex rollout open
async function holdsConversation(procRoot: string, pid: number, conversationId: string): Promise<boolean> {
  const directory = join(procRoot, String(pid), 'fd');
  const descriptors = await readdir(directory).catch(() => []);
  let inspected = 0;
  // inspect only a bounded descriptor set
  for (const descriptor of descriptors) {
    // stop before an adversarial descriptor table grows unbounded
    if (inspected++ >= maximumDescriptors) return false;
    const target = await readlink(join(directory, descriptor)).catch(() => undefined);
    const match = target === undefined ? undefined : conversationPattern.exec(target);
    // require the exact current conversation
    if (match?.[1]?.toLowerCase() === conversationId.toLowerCase()) return true;
  }
  return false;
}

// select the unique Codex child owned by an OMX leader
async function omxCodexProcess(procRoot: string, wrapper: ProcessRecord, conversationId?: string): Promise<ProcessRecord | undefined> {
  // refuse nonleader OMX helpers
  if (!isOmxLeaderCommand(wrapper.comm, wrapper.argv)) return undefined;
  const candidates: ProcessRecord[] = [];
  const processes = await descendants(procRoot, wrapper.pid);
  // incomplete trees cannot establish a unique child
  if (processes === undefined) return undefined;
  // inspect every bounded descendant lifetime freshly
  for (const pid of processes) {
    const rawStat = await boundedBytes(join(procRoot, String(pid), 'stat'), 16 * 1024);
    const parsed = rawStat === undefined ? undefined : processStat(rawStat.toString('utf8'), pid);
    // ignore exited or malformed descendants
    if (parsed === undefined) continue;
    const candidate = await processRecord(procRoot, { pid, startTime: parsed.startTime });
    // retain only native Codex descendants
    if (candidate === undefined || !isCodexCommand(candidate.comm, candidate.argv)) continue;
    // a reported conversation must match this descendant's open rollout
    if (conversationId !== undefined && !await holdsConversation(procRoot, pid, conversationId)) continue;
    candidates.push(candidate);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

// build one stable nonsecret native process scope
async function resolvedScope(kind: 'codex' | 'claude', process: ProcessRecord, environment: NodeJS.ProcessEnv): Promise<NativeReplyScope | undefined> {
  const procRoot = environment.RAC_HOST_PROC ?? '/proc';
  const observed = await selectedEnvironment(procRoot, process.pid);
  // reject endpoint, proxy and environment credentials before account inspection
  if (observed === undefined || observed.forbidden.size > 0 || kind === 'claude' && /^(?:background|cloud|remote)$/iu.test(observed.values.CLAUDE_CODE_SESSION_KIND ?? '')) return undefined;
  const home = observed.values.HOME;
  // require the exact native process home
  if (home === undefined || !isAbsolute(home)) return undefined;
  const configured = kind === 'codex' ? observed.values.CODEX_HOME : observed.values.CLAUDE_CONFIG_DIR;
  const configDir = configured ?? join(home, kind === 'codex' ? '.codex' : '.claude');
  // reject relative or control-bearing profile paths
  if (!isAbsolute(configDir) || /[\u0000-\u001f\u007f]/u.test(configDir)) return undefined;
  const credentialPath = kind === 'codex' ? join(configDir, 'auth.json') : join(configDir, '.credentials.json');
  const visibleConfig = processPath(procRoot, process.pid, configDir);
  const visibleCredential = processPath(procRoot, process.pid, credentialPath);
  // source mount namespace paths must remain directly inspectable
  if (visibleConfig === undefined || visibleCredential === undefined) return undefined;
  const routingGeneration = kind === 'codex'
    ? await codexRoutingGeneration(procRoot, process, configDir)
    : await claudeRoutingGeneration(procRoot, process, home, configDir);
  // ambiguous routing cannot borrow the helper's default account
  if (routingGeneration === undefined) return undefined;
  const [programInfo, configInfo, credentialInfo] = await Promise.all([
    stat(join(procRoot, String(process.pid), 'exe')).catch(() => undefined),
    lstat(visibleConfig).catch(() => undefined),
    lstat(visibleCredential).catch(() => undefined)
  ]);
  // bind one executable and mounted account profile
  const uid = processUid();
  if (programInfo?.isFile() !== true || configInfo?.isDirectory() !== true || configInfo.isSymbolicLink() || credentialInfo?.isFile() !== true || credentialInfo.isSymbolicLink() || uid === undefined || credentialInfo.uid !== uid || (credentialInfo.mode & 0o077) !== 0 || credentialInfo.nlink !== 1) return undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    kind, process.program, programInfo.dev, programInfo.ino, programInfo.size, programInfo.mtimeMs, programInfo.ctimeMs,
    home, configDir, configInfo.dev, configInfo.ino, process.cwd, routingGeneration,
    credentialInfo.dev, credentialInfo.ino, credentialInfo.size, credentialInfo.mtimeMs, credentialInfo.ctimeMs, credentialInfo.mode,
    process.pid, process.startTime
  ])).digest('base64url');
  return { kind, program: process.program, home, configDir, process: { pid: process.pid, startTime: process.startTime }, fingerprint };
}

// resolve one exact native cli process without reading credential contents
export async function nativeReplyScope(kind: NativeKind, process: ProcessIdentity, environment: NodeJS.ProcessEnv = processEnv(), conversationId?: string, transport: NativeTransport = 'tmux'): Promise<NativeReplyScope | undefined> {
  const procRoot = environment.RAC_HOST_PROC ?? '/proc';
  const initial = await processRecord(procRoot, process);
  // fail closed on a replaced or unreadable process
  if (initial === undefined) return undefined;
  if (kind === 'omx') {
    const codex = await omxCodexProcess(procRoot, initial, conversationId);
    return codex === undefined ? undefined : await resolvedScope('codex', codex, environment);
  }
  if (kind === 'codex') {
    // reject wrappers and another CLI kind
    if (!isCodexCommand(initial.comm, initial.argv)) return undefined;
    // bind a reported conversation to the process's open rollout
    if (conversationId !== undefined && !await holdsConversation(procRoot, initial.pid, conversationId)) return undefined;
    return await resolvedScope('codex', initial, environment);
  }
  // reject non-Claude processes before account reads
  if (!isClaudeProcess(initial) || !allowedClaudeMode(initial, transport)) return undefined;
  return await resolvedScope('claude', initial, environment);
}

// preserve an injectable default without capturing a mutable object
function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

// read the current service uid without capturing process state in tests
function processUid(): number | undefined {
  return process.getuid?.();
}
