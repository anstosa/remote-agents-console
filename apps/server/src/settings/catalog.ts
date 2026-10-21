import type { SettingsApply, SettingsFallback, SettingsSchema } from './contracts.js';

export const labels: Record<string, string> = { app: 'Application configuration', env: 'Environment & keys', installation: 'Installation', compose: 'Base Compose', 'compose-override': 'Docker', cloudflared: 'Cloudflare tunnel', 'cloudflared-credentials': 'Cloudflare credentials', wrapper: 'Installation wrapper', 'icon-heart': 'Heart icon', 'icon-potato': 'Potato icon' };
export const composeOptionSettings = {
  parallel: { default: -1, placeholder: '-1 (from Docker Compose default; unlimited)', description: 'Maximum simultaneous Docker operations, such as image pulls and builds. This does not limit RAC agents or requests.' },
  compatibility: { default: false, placeholder: 'false', description: 'Use legacy Compose behavior, including underscore-separated container names.' }
} as const satisfies Record<'parallel' | 'compatibility', Pick<SettingsSchema, 'default' | 'description' | 'placeholder'>>;
export const knownEnvironmentKeys = [
  'RAC_PASSWORD_HASH', 'RAC_SESSION_SECRET', 'RAC_INSTANCE_STATUS_SECRET', 'RAC_INTEGRATION_FEDERATION_SECRET', 'RAC_REALTIME_MCP_TOKEN',
  'RAC_OPENAI_API_KEY', 'RAC_OPENAI_ADMIN_KEY', 'RAC_OPENAI_API_KEY_IDS', 'RAC_GITHUB_TOKEN',
  'RAC_CONFIG', 'RAC_CONFIG_WRITE_PATH', 'RAC_LISTEN_HOST', 'RAC_LISTEN_PORT', 'RAC_LOG_LEVEL', 'TZ', 'RAC_INTERACTIVE_SHELL', 'RAC_TMUX_BIN', 'RAC_CODEX_BIN', 'RAC_CLAUDE_BIN', 'RAC_CLAUDE_CONFIG_DIR', 'RAC_GH_HOSTS', 'RAC_ADAPTER_FILES_DIR', 'RAC_SERVER_CHECKOUT', 'RAC_SERVER_ADMIN_STATUS_DIR', 'RAC_TEMP_PREVIEW_ORIGIN',
  'RAC_PROJECT_PROXY_HOST', 'RAC_HOST_PROC', 'RAC_HOST_TMUX_DIR', 'RAC_HOST_TMUX_SOURCE', 'RAC_HOST_UNIX_SOCKETS', 'RAC_HOST_UID', 'RAC_HOST_NODE_BIN', 'RAC_HOST_CODEX_BIN', 'RAC_HOST_INTERACTIVE_SHELL', 'RAC_HOST_PATH', 'RAC_HOST_REPOSITORY', 'RAC_HOST_WORKSPACE', 'HOST_UID', 'HOST_TMUX_DIR', 'HOST_TMUX_BIN',
  'RAC_DEVICE_NAMES_FILE', 'RAC_CONSOLE_NAMED_FILE', 'RAC_WORKTREES_FILE', 'RAC_SAVED_PROMPTS_FILE', 'RAC_PROMPT_HISTORY_FILE', 'RAC_QUEUED_PROMPTS_FILE', 'RAC_NOTES_FILE', 'RAC_REVIEW_TOURS_FILE', 'RAC_PUSH_SUBSCRIPTIONS_FILE', 'RAC_FILE_FAVORITES_FILE', 'RAC_FILE_OPERATION_JOURNAL', 'RAC_INTEGRATION_AUTH_FILE', 'RAC_INTEGRATION_STATE_FILE', 'RAC_INTEGRATION_AUDIT_FILE', 'RAC_TEMP_PREVIEWS_DIR', 'RAC_BOOKMARKS_FILE',
  'CODEX_VERSION', 'CLOUDFLARED_CREDENTIALS_FILE', 'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY', 'NODE_BIN', 'RAC_ENV_FILE'
] as const;
export const managedEnvironmentKeys = ['RAC_VAPID_PUBLIC_KEY', 'RAC_VAPID_PRIVATE_KEY'] as const;
type KnownEnvironmentKey = typeof knownEnvironmentKeys[number];
type StaticEnvironmentFallback = SettingsFallback & { kind: 'literal' | 'derived' };
// describe only omission behavior proved by a current runtime consumer or installer
const environmentFallbacks = {
  RAC_PASSWORD_HASH: { value: 'Required; no default', kind: 'derived' },
  RAC_SESSION_SECRET: { value: 'Required; no default', kind: 'derived' },
  RAC_INSTANCE_STATUS_SECRET: { value: 'Uses RAC_SESSION_SECRET', kind: 'derived' },
  RAC_INTEGRATION_FEDERATION_SECRET: { value: 'Uses RAC_INSTANCE_STATUS_SECRET, then RAC_SESSION_SECRET', kind: 'derived' },
  RAC_REALTIME_MCP_TOKEN: { value: 'Derived from RAC_SESSION_SECRET', kind: 'derived' },
  RAC_GITHUB_TOKEN: { value: 'GitHub CLI credentials from RAC_GH_HOSTS', kind: 'derived' },
  RAC_OPENAI_API_KEY: { value: 'Voice unavailable when unset', kind: 'derived' },
  RAC_OPENAI_ADMIN_KEY: { value: 'Usage and cost queries unavailable when unset', kind: 'derived' },
  RAC_OPENAI_API_KEY_IDS: { value: 'Per-account cost attribution unavailable when unset', kind: 'derived' },
  RAC_CONFIG: { value: 'Required; no default application file', kind: 'derived' },
  RAC_CONFIG_WRITE_PATH: { value: 'Same as RAC_CONFIG', kind: 'derived' },
  RAC_LISTEN_HOST: { value: 'Application configuration listen.host (127.0.0.1 if unspecified)', kind: 'derived' },
  RAC_LISTEN_PORT: { value: 'Application configuration listen.port (8787 if unspecified)', kind: 'derived' },
  RAC_LOG_LEVEL: { value: 'Not used by RAC', kind: 'derived' },
  TZ: { value: 'Host time zone', kind: 'derived' },
  RAC_INTERACTIVE_SHELL: { value: '/usr/bin/zsh', kind: 'literal' },
  RAC_TMUX_BIN: { value: '/usr/bin/tmux', kind: 'literal' },
  RAC_CODEX_BIN: { value: 'adapters.codex.program', kind: 'derived' },
  RAC_CLAUDE_BIN: { value: 'adapters.claude.program', kind: 'derived' },
  RAC_CLAUDE_CONFIG_DIR: { value: 'CLAUDE_CONFIG_DIR, then ~/.claude', kind: 'derived' },
  RAC_GH_HOSTS: { value: '~/.config/gh/hosts.yml', kind: 'derived' },
  RAC_ADAPTER_FILES_DIR: { value: '.data/adapters', kind: 'derived' },
  RAC_SERVER_CHECKOUT: { value: 'running RAC checkout', kind: 'derived' },
  RAC_SERVER_ADMIN_STATUS_DIR: { value: '.data', kind: 'derived' },
  RAC_TEMP_PREVIEW_ORIGIN: { value: 'Application publicOrigin', kind: 'derived' },
  RAC_PROJECT_PROXY_HOST: { value: '127.0.0.1', kind: 'literal' },
  RAC_HOST_PROC: { value: '/proc for discovery; host Files needs a host procfs mount', kind: 'derived' },
  RAC_HOST_TMUX_DIR: { value: 'Native socket discovery; no mounted host socket directory', kind: 'derived' },
  RAC_HOST_TMUX_SOURCE: { value: '/tmp/tmux-${RAC_HOST_UID or process UID}', kind: 'derived' },
  RAC_HOST_UNIX_SOCKETS: { value: '${RAC_HOST_PROC or /proc}/net/unix', kind: 'derived' },
  RAC_HOST_UID: { value: 'Process UID for discovery; host Files needs an explicit UID', kind: 'derived' },
  RAC_HOST_NODE_BIN: { value: 'node from host PATH', kind: 'derived' },
  RAC_HOST_CODEX_BIN: { value: 'adapters.codex.program', kind: 'derived' },
  RAC_HOST_INTERACTIVE_SHELL: { value: 'RAC_INTERACTIVE_SHELL, then /usr/bin/zsh', kind: 'derived' },
  RAC_HOST_PATH: { value: 'Inherit host tmux PATH', kind: 'derived' },
  RAC_HOST_REPOSITORY: { value: 'Native: RAC checkout; Docker host adapters require an explicit path', kind: 'derived' },
  RAC_HOST_WORKSPACE: { value: 'Project hostPath/path for this checkout; unavailable if not mapped', kind: 'derived' },
  HOST_UID: { value: 'Standard Docker bridge: 1000', kind: 'derived' },
  HOST_TMUX_DIR: { value: 'Standard Docker bridge: ~/.local/state/tmux/tmux-${HOST_UID:-1000}', kind: 'derived' },
  HOST_TMUX_BIN: { value: 'Standard Docker bridge: /usr/bin/tmux', kind: 'derived' },
  RAC_DEVICE_NAMES_FILE: { value: '.data/device-names.json', kind: 'literal' },
  RAC_CONSOLE_NAMED_FILE: { value: '.data/console-named-conversations.json', kind: 'literal' },
  RAC_WORKTREES_FILE: { value: '.data/worktrees.json', kind: 'literal' },
  RAC_SAVED_PROMPTS_FILE: { value: '.data/saved-prompts.json', kind: 'literal' },
  RAC_PROMPT_HISTORY_FILE: { value: '.data/prompt-history.json', kind: 'literal' },
  RAC_QUEUED_PROMPTS_FILE: { value: '.data/queued-prompts.json', kind: 'literal' },
  RAC_NOTES_FILE: { value: '.data/notes.json', kind: 'literal' },
  RAC_REVIEW_TOURS_FILE: { value: '.data/review-tours.json', kind: 'literal' },
  RAC_PUSH_SUBSCRIPTIONS_FILE: { value: '.data/push-subscriptions.json', kind: 'literal' },
  RAC_FILE_FAVORITES_FILE: { value: '.data/file-favorites.json', kind: 'literal' },
  RAC_FILE_OPERATION_JOURNAL: { value: '.data/file-operation-journal.json', kind: 'literal' },
  RAC_INTEGRATION_AUTH_FILE: { value: '.data/integration-auth.json', kind: 'literal' },
  RAC_INTEGRATION_STATE_FILE: { value: '.data/integration-state.json', kind: 'literal' },
  RAC_INTEGRATION_AUDIT_FILE: { value: '.data/integration-audit.jsonl', kind: 'literal' },
  RAC_TEMP_PREVIEWS_DIR: { value: '.data/temp-previews', kind: 'literal' },
  RAC_BOOKMARKS_FILE: { value: '.data/bookmarks.json', kind: 'literal' },
  CODEX_VERSION: { value: '0.144.5', kind: 'literal' },
  CLOUDFLARED_CREDENTIALS_FILE: { value: './config/cloudflared.credentials.json', kind: 'literal' },
  COMPOSE_FILE: { value: 'compose.yaml plus compose.override.yaml when present', kind: 'derived' },
  COMPOSE_ENV_FILES: { value: '.env', kind: 'literal' },
  COMPOSE_PROJECT_NAME: { value: 'Sanitized RAC checkout directory name', kind: 'derived' },
  COMPOSE_PROFILES: { value: 'None (tunnel is added when Cloudflare is active)', kind: 'derived' },
  COMPOSE_PARALLEL_LIMIT: { value: '-1 (unlimited)', kind: 'literal' },
  COMPOSE_COMPATIBILITY: { value: 'false', kind: 'literal' },
  NODE_BIN: { value: 'node from PATH', kind: 'derived' },
  RAC_ENV_FILE: { value: '<RAC checkout>/.env', kind: 'derived' }
} as const satisfies Partial<Record<KnownEnvironmentKey, StaticEnvironmentFallback>>;
// explain every environment setting the editor catalogs
const environmentDescriptions = {
  RAC_PASSWORD_HASH: 'Argon2id hash used to verify console login passwords.',
  RAC_SESSION_SECRET: 'Secret used to sign browser sessions and host Files capabilities; changing it signs users out.',
  RAC_INSTANCE_STATUS_SECRET: 'Shared secret used to authenticate status requests between configured RAC servers.',
  RAC_INTEGRATION_FEDERATION_SECRET: 'Shared secret used to authenticate multi-server integration forwarding.',
  RAC_REALTIME_MCP_TOKEN: 'Bearer token used by the local voice Realtime bridge to call RAC MCP tools.',
  RAC_OPENAI_API_KEY: 'OpenAI API key used to create server-side voice Realtime sessions.',
  RAC_OPENAI_ADMIN_KEY: 'OpenAI organization Admin API key used only for read-only usage and cost queries.',
  RAC_OPENAI_API_KEY_IDS: 'JSON map from local account IDs to OpenAI API key IDs for per-account cost attribution.',
  RAC_GITHUB_TOKEN: 'GitHub token used for pull request lookup and posting guided review drafts.',
  RAC_CONFIG: 'Application configuration file read by RAC at startup and by configuration-aware helper scripts.',
  RAC_CONFIG_WRITE_PATH: 'Application configuration destination written by the settings host.',
  RAC_LISTEN_HOST: 'Network interface address that overrides the application configuration when RAC starts.',
  RAC_LISTEN_PORT: 'TCP port that overrides the application configuration when RAC starts.',
  RAC_LOG_LEVEL: 'Reserved log verbosity setting preserved for deployment tooling; RAC does not currently read it.',
  TZ: 'IANA time zone used by the server process and scheduled note runs.',
  RAC_INTERACTIVE_SHELL: 'Absolute zsh, bash, or fish executable used for container-managed or direct agent sessions.',
  RAC_TMUX_BIN: 'tmux executable or wrapper used for RAC session discovery and control.',
  RAC_CODEX_BIN: 'Codex executable used for container-local launches, reviews, and account management.',
  RAC_CLAUDE_BIN: 'Claude executable used for configured launches and headless review runs.',
  RAC_CLAUDE_CONFIG_DIR: 'Claude configuration directory used to discover accounts and conversation transcripts.',
  RAC_GH_HOSTS: 'GitHub CLI hosts file used to obtain a github.com access token.',
  RAC_ADAPTER_FILES_DIR: 'Directory where RAC renders generated adapter files such as Claude hook configuration.',
  RAC_SERVER_CHECKOUT: 'Path to the RAC checkout as seen by the running server and settings helpers.',
  RAC_SERVER_ADMIN_STATUS_DIR: 'Directory where server update operations write their status and log files.',
  RAC_TEMP_PREVIEW_ORIGIN: 'Public RAC origin used by the share-preview helper when it builds temporary preview URLs.',
  RAC_PROJECT_PROXY_HOST: 'Host name or address RAC uses to reach project preview ports.',
  RAC_HOST_PROC: 'Mounted host procfs root used for process discovery and the host Files bridge.',
  RAC_HOST_TMUX_DIR: 'Container-visible directory containing the mounted host tmux socket.',
  RAC_HOST_TMUX_SOURCE: 'Host tmux socket directory prefix used to identify sockets listed by host procfs.',
  RAC_HOST_UNIX_SOCKETS: 'Host procfs unix-socket table used to discover tmux sockets.',
  RAC_HOST_UID: 'Numeric host user ID used to validate host processes, sockets, and Files access.',
  RAC_HOST_NODE_BIN: 'Host-visible Node.js executable used to run the host Files broker.',
  RAC_HOST_CODEX_BIN: 'Host-visible Codex executable used by the server update advisor.',
  RAC_HOST_INTERACTIVE_SHELL: 'Absolute host zsh, bash, or fish executable used for host-tmux agent sessions.',
  RAC_HOST_PATH: 'Complete host PATH exported before RAC runs host agent, update, and stack commands.',
  RAC_HOST_REPOSITORY: 'Host-visible RAC checkout used for server updates and host bridge path mapping.',
  RAC_HOST_WORKSPACE: 'Host-visible RAC workspace used for stack commands and host bridge path mapping.',
  HOST_UID: 'Host user ID used by Compose to align container ownership and host tmux mounts.',
  HOST_TMUX_DIR: 'Host tmux socket directory mounted into the RAC container by Compose.',
  HOST_TMUX_BIN: 'Host tmux executable or compatibility wrapper mounted into the RAC container.',
  RAC_DEVICE_NAMES_FILE: 'Persistent JSON file containing browser device names.',
  RAC_CONSOLE_NAMED_FILE: 'Persistent JSON file containing names assigned to console conversations.',
  RAC_WORKTREES_FILE: 'Persistent JSON file containing worktree labels, pins, and launch metadata.',
  RAC_SAVED_PROMPTS_FILE: 'Legacy saved-prompts JSON file read by the migration into notes.',
  RAC_PROMPT_HISTORY_FILE: 'Persistent JSON file containing submitted prompt history.',
  RAC_QUEUED_PROMPTS_FILE: 'Persistent JSON file containing queued prompts and their reset boundaries.',
  RAC_NOTES_FILE: 'Persistent JSON file containing worktree notes and note attachments.',
  RAC_REVIEW_TOURS_FILE: 'Persistent JSON file containing generated review tours and code review state.',
  RAC_PUSH_SUBSCRIPTIONS_FILE: 'Persistent JSON file containing browser push subscriptions.',
  RAC_FILE_FAVORITES_FILE: 'Persistent JSON file containing Files favorites for each place.',
  RAC_FILE_OPERATION_JOURNAL: 'Persistent JSON journal used to recover and report Files operations.',
  RAC_INTEGRATION_AUTH_FILE: 'Private JSON file containing integration authorization grants.',
  RAC_INTEGRATION_STATE_FILE: 'Private JSON file containing integration approval and policy state.',
  RAC_INTEGRATION_AUDIT_FILE: 'Private JSON Lines file containing the integration audit trail.',
  RAC_TEMP_PREVIEWS_DIR: 'Directory containing registered temporary preview metadata.',
  RAC_BOOKMARKS_FILE: 'Legacy bookmarks file retained only for bookmark retirement and migration compatibility.',
  CODEX_VERSION: 'Codex package version installed when Compose builds the RAC image.',
  CLOUDFLARED_CREDENTIALS_FILE: 'Host path to the Cloudflare tunnel credential JSON mounted by Compose.',
  COMPOSE_FILE: 'Colon-separated Compose file list captured by the settings installer.',
  COMPOSE_ENV_FILES: 'Comma-separated environment file list captured by the settings installer.',
  COMPOSE_PROJECT_NAME: 'Compose project name used for RAC service operations.',
  COMPOSE_PROFILES: 'Comma-separated Compose profiles enabled for RAC service operations.',
  COMPOSE_PARALLEL_LIMIT: 'Maximum parallel Compose operations captured by the settings installer.',
  COMPOSE_COMPATIBILITY: 'Enables the Compose compatibility option captured by the settings installer.',
  NODE_BIN: 'Absolute Node.js executable used by the systemd and settings-applier installers.',
  RAC_ENV_FILE: 'Authoritative environment file selected by the RAC systemd settings installer.'
} satisfies Record<KnownEnvironmentKey, string>;
const customEnvironmentDescription = 'Custom environment variable preserved in this environment file. Its effect depends on the process or deployment that reads it.';
const credential = /(?:^|_)(?:(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|AUTH|AUTHORIZATION|CREDENTIAL)(?:_(?:VALUE|HASH|HEADER|DATA|BASE64))?|(?:(?:API|ADMIN|PRIVATE|SIGNING|ACCESS)_)?KEY(?:_(?:VALUE|PEM|DATA|BASE64))?)$/u;
const publicKey = /(?:^|_)PUBLIC_KEY(?:_|$)/u;
const locator = /_(?:PATH|FILE|DIR|DIRECTORY|BIN|PROGRAM|COMMAND)$/u;
const migratedPaths = new Set(['RAC_CONFIG', 'RAC_CONFIG_WRITE_PATH', 'RAC_CLAUDE_CONFIG_DIR', 'RAC_ADAPTER_FILES_DIR', 'RAC_SERVER_ADMIN_STATUS_DIR', 'RAC_TEMP_PREVIEWS_DIR', 'RAC_DEVICE_NAMES_FILE', 'RAC_CONSOLE_NAMED_FILE', 'RAC_WORKTREES_FILE', 'RAC_SAVED_PROMPTS_FILE', 'RAC_PROMPT_HISTORY_FILE', 'RAC_QUEUED_PROMPTS_FILE', 'RAC_NOTES_FILE', 'RAC_REVIEW_TOURS_FILE', 'RAC_PUSH_SUBSCRIPTIONS_FILE', 'RAC_FILE_FAVORITES_FILE', 'RAC_FILE_OPERATION_JOURNAL', 'RAC_INTEGRATION_AUTH_FILE', 'RAC_INTEGRATION_STATE_FILE', 'RAC_INTEGRATION_AUDIT_FILE', 'RAC_GH_HOSTS', 'CLOUDFLARED_CREDENTIALS_FILE', 'RAC_ENV_FILE']);
// normalize environment and structured field identities before credential classification
export function protectedSettingIdentity(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase();
  // keep public material and credential locators visible while hiding credential values
  return !publicKey.test(normalized) && !locator.test(normalized) && credential.test(normalized);
}
// protect credential-bearing environment values without hiding unknown ordinary settings
export function protectedEnvironment(key: string): boolean { return protectedSettingIdentity(key); }
// reserve server-managed values outside typed settings controls
export function managedEnvironment(key: string): boolean { return (managedEnvironmentKeys as readonly string[]).includes(key); }
// return useful guidance without inventing a consumer for custom variables
export function environmentDescription(key: string): string { return Object.hasOwn(environmentDescriptions, key) ? environmentDescriptions[key as KnownEnvironmentKey] : customEnvironmentDescription; }
// return safe display metadata without resolving environment or secret bytes
export function environmentFallback(key: string, installationKind?: 'compose' | 'systemd'): StaticEnvironmentFallback | undefined {
  // describe bridge conventions without inventing a native mount default
  if (key === 'RAC_HOST_TMUX_DIR' && installationKind === 'compose') return { value: 'Docker bridge: /host-tmux; otherwise native socket discovery', kind: 'derived' };
  // compose supplies this path rather than the server defaulting it
  if (key === 'RAC_CONFIG' && installationKind === 'compose') return { value: 'Docker supplies /workspace/config/remote-agent-console.docker.json; otherwise required', kind: 'derived' };
  return Object.hasOwn(environmentFallbacks, key) ? environmentFallbacks[key as keyof typeof environmentFallbacks] : undefined;
}
// explain fields without runtime consumers
export function envApply(key: string): SettingsApply { return key === 'RAC_LOG_LEVEL' || key === 'RAC_BOOKMARKS_FILE' || key.startsWith('COMPOSE_') ? 'saved-only' : migratedPaths.has(key) ? 'source-migration' : 'rac-restart'; }
// guard only credential-bearing structured leaves
export function protectedPath(path: string[]): boolean {
  const key = path.at(-1) ?? '';
  return protectedSettingIdentity(key);
}
// distinguish saved-only and existing live settings
export function appApply(path: string[]): SettingsApply {
  // do not invent readers for dormant accepted fields
  if (path[0] === 'proxy') return 'saved-only';
  // preserve the established live paths
  if (path.length === 1 && (path[0] === 'name' || path[0] === 'defaultAgent') || path[0] === 'integrations' && path[1] === 'realtime' && ['enabled', 'name', 'context'].includes(path[2] ?? '')) return 'live';
  return 'rac-restart';
}
