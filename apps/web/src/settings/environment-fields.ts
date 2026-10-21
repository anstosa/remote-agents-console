import { isProtectedValue, type SettingsSchema, type SettingsSnapshot, type SettingsSource } from './contracts.js';
import { tmuxEnvironmentKeys } from './tmux-settings.js';

// keep exclusively voice credentials with their setup controls
export const voiceEnvironmentKeys: ReadonlySet<string> = new Set(['RAC_OPENAI_API_KEY', 'RAC_REALTIME_MCP_TOKEN']);

const codexEnvironmentKeys: ReadonlySet<string> = new Set(['RAC_CODEX_BIN', 'RAC_HOST_CODEX_BIN', 'RAC_OPENAI_ADMIN_KEY', 'RAC_OPENAI_API_KEY_IDS', 'CODEX_VERSION']);
const portableCodexEnvironmentKeys: ReadonlySet<string> = new Set([...codexEnvironmentKeys].filter(key => key !== 'CODEX_VERSION'));
const claudeEnvironmentKeys: ReadonlySet<string> = new Set(['RAC_CLAUDE_BIN', 'RAC_CLAUDE_CONFIG_DIR']);
const noAgentEnvironmentKeys: ReadonlySet<string> = new Set();

// keep adapter services and account setup with their structured agent configuration
export const agentEnvironmentKeys: ReadonlySet<string> = new Set(['RAC_CODEX_BIN', 'RAC_CLAUDE_BIN', 'RAC_CLAUDE_CONFIG_DIR', 'RAC_HOST_CODEX_BIN', 'RAC_OPENAI_ADMIN_KEY', 'RAC_OPENAI_API_KEY_IDS', 'CODEX_VERSION']);
// group RAC-owned data stores without moving configuration selectors or external tool state
export const storageEnvironmentKeys: ReadonlySet<string> = new Set([
  'RAC_ADAPTER_FILES_DIR', 'RAC_SERVER_ADMIN_STATUS_DIR', 'RAC_TEMP_PREVIEWS_DIR',
  'RAC_DEVICE_NAMES_FILE', 'RAC_CONSOLE_NAMED_FILE', 'RAC_WORKTREES_FILE', 'RAC_SAVED_PROMPTS_FILE',
  'RAC_PROMPT_HISTORY_FILE', 'RAC_QUEUED_PROMPTS_FILE', 'RAC_NOTES_FILE', 'RAC_REVIEW_TOURS_FILE',
  'RAC_PUSH_SUBSCRIPTIONS_FILE', 'RAC_FILE_FAVORITES_FILE', 'RAC_FILE_OPERATION_JOURNAL',
  'RAC_INTEGRATION_AUTH_FILE', 'RAC_INTEGRATION_STATE_FILE', 'RAC_INTEGRATION_AUDIT_FILE', 'RAC_BOOKMARKS_FILE'
]);
// omit the Docker image build argument from native installations
const portableAgentEnvironmentKeys: ReadonlySet<string> = new Set([...agentEnvironmentKeys].filter(key => key !== 'CODEX_VERSION'));

// expose build-time settings only where the installation consumes them
export function agentEnvironmentKeysForInstallation(kind?: SettingsSnapshot['installationKind']): ReadonlySet<string> {
  return kind === 'compose' ? agentEnvironmentKeys : portableAgentEnvironmentKeys;
}

// return the environment-owned controls displayed inside one adapter
export function agentEnvironmentKeysForAdapter(adapter: string, kind?: SettingsSnapshot['installationKind']): ReadonlySet<string> {
  // select installation-aware codex controls
  if (adapter === 'codex') return kind === 'compose' ? codexEnvironmentKeys : portableCodexEnvironmentKeys;
  // keep claude controls portable
  if (adapter === 'claude') return claudeEnvironmentKeys;
  return noAgentEnvironmentKeys;
}

// find the adapter that owns one environment field in this installation
export function agentEnvironmentOwnerForKey(key: string, kind?: SettingsSnapshot['installationKind']): 'codex' | 'claude' | undefined {
  // test codex ownership first
  if (agentEnvironmentKeysForAdapter('codex', kind).has(key)) return 'codex';
  // test claude ownership second
  if (agentEnvironmentKeysForAdapter('claude', kind).has(key)) return 'claude';
  return undefined;
}

const applicationFields = {
  RAC_LISTEN_HOST: ['listen', 'host'],
  RAC_LISTEN_PORT: ['listen', 'port']
} as const;
const unsupportedEnvironmentKeys: ReadonlySet<string> = new Set(['RAC_LOG_LEVEL']);
// installer inputs never reconfigure the installed service through dotenv edits
const installerOnlyEnvironmentKeys: ReadonlySet<string> = new Set([
  'NODE_BIN', 'RAC_ENV_FILE', 'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY'
]);

// mirror structured field visibility without inspecting or changing leaf values
function hasControl(source: SettingsSource | undefined, path: readonly string[]): boolean {
  // preserve access when the peer source cannot render a structured form
  if (source?.writable !== true || source.schema === undefined || source.value === null || typeof source.value !== 'object' || Array.isArray(source.value)) return false;
  let schema: SettingsSchema | undefined = source.schema;
  let value: unknown = source.value;
  // require every parent to expose its child controls
  for (let index = 0; index < path.length; index += 1) {
    // stop before opaque or inactive descendants
    if (schema?.type !== 'object' || schema.protected || isProtectedValue(value) || value === null && schema.nullable) return false;
    const defaulted = Object.hasOwn(schema, 'default');
    // absent optional parents cannot expose their descendants
    if (value === undefined && schema.optional && !defaulted) return false;
    const effective = value === undefined && defaulted ? schema.default : value;
    const key = path[index]!;
    value = effective !== null && typeof effective === 'object' && Object.hasOwn(effective, key) ? (effective as Record<string, unknown>)[key] : undefined;
    schema = schema.properties?.[key];
  }
  // optional add buttons do not count as an existing field control
  return schema !== undefined && (value !== undefined || !schema.optional || Object.hasOwn(schema, 'default'));
}

// hide duplicate form rows while leaving their original environment source intact
export function environmentKeysWithDedicatedControls(sources: readonly SettingsSource[]): ReadonlySet<string> {
  // retain file values without advertising unsupported or installer-only controls
  const keys = new Set([...tmuxEnvironmentKeys, ...voiceEnvironmentKeys, ...agentEnvironmentKeys, ...storageEnvironmentKeys, ...unsupportedEnvironmentKeys, ...installerOnlyEnvironmentKeys]);
  const application = sources.find(source => source.id === 'app');
  // application controls retain their existing source and override semantics
  for (const [key, path] of Object.entries(applicationFields)) {
    if (hasControl(application, path)) keys.add(key);
  }
  return keys;
}
