import { isProtectedValue, type SettingsSchema, type SettingsSnapshot, type SettingsSource } from './contracts.js';
import { tmuxEnvironmentKeys } from './tmux-settings.js';

const applicationFields = {
  RAC_LISTEN_HOST: ['listen', 'host'],
  RAC_LISTEN_PORT: ['listen', 'port'],
  RAC_CODEX_BIN: ['adapters', 'codex', 'program'],
  RAC_CLAUDE_BIN: ['adapters', 'claude', 'program']
} as const;
const composeFields = {
  COMPOSE_FILE: ['compose', 'files'],
  COMPOSE_ENV_FILES: ['compose', 'envFiles'],
  COMPOSE_PROJECT_NAME: ['compose', 'projectName'],
  COMPOSE_PARALLEL_LIMIT: ['compose', 'options', 'parallel'],
  COMPOSE_COMPATIBILITY: ['compose', 'options', 'compatibility']
} as const;
const nativeFields = { RAC_ENV_FILE: ['native', 'environmentFile'] } as const;
const unsupportedEnvironmentKeys: ReadonlySet<string> = new Set(['RAC_LOG_LEVEL']);

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
    const installationBranch = source.format === 'installation' && index === 1;
    // installation renders the selected mode directly even when its object is absent
    if (value === undefined && schema.optional && !defaulted && !installationBranch) return false;
    const effective = value === undefined && defaulted ? schema.default : value;
    const key = path[index]!;
    value = effective !== null && typeof effective === 'object' && Object.hasOwn(effective, key) ? (effective as Record<string, unknown>)[key] : undefined;
    schema = schema.properties?.[key];
  }
  // optional add buttons do not count as an existing field control
  return schema !== undefined && (value !== undefined || !schema.optional || Object.hasOwn(schema, 'default'));
}

// hide duplicate form rows while leaving their original environment source intact
export function environmentKeysWithDedicatedControls(sources: readonly SettingsSource[], kind?: SettingsSnapshot['installationKind']): ReadonlySet<string> {
  // keep unsupported values in the file without advertising ineffective controls
  const keys = new Set([...tmuxEnvironmentKeys, ...unsupportedEnvironmentKeys]);
  const application = sources.find(source => source.id === 'app');
  const installation = sources.find(source => source.id === 'installation');
  // application controls retain their existing source and override semantics
  for (const [key, path] of Object.entries(applicationFields)) {
    if (hasControl(application, path)) keys.add(key);
  }
  const installationFields: Readonly<Record<string, readonly string[]>> = kind === 'compose' ? composeFields : kind === 'systemd' ? nativeFields : {};
  // inactive installation branches never own general environment rows
  for (const [key, path] of Object.entries(installationFields)) {
    if (hasControl(installation, path)) keys.add(key);
  }
  return keys;
}
