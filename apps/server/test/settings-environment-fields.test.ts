import { describe, expect, it } from 'vitest';
import type { SettingsSchema, SettingsSource } from '../../web/src/settings/contracts.js';
import { agentEnvironmentKeys, agentEnvironmentKeysForInstallation, environmentKeysWithDedicatedControls, googleCalendarEnvironmentKeys, storageEnvironmentKeys, voiceEnvironmentKeys } from '../../web/src/settings/environment-fields.js';
import { tmuxEnvironmentKeys } from '../../web/src/settings/tmux-settings.js';

// isolate the actual field visibility inputs without writing source files
const source = (id: string, value: unknown, properties: Record<string, SettingsSchema>): SettingsSource => ({ id, label: id, format: id === 'installation' ? 'installation' : 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: 'revision', apply: 'rac-restart', value, schema: { type: 'object', properties } });
const listen: SettingsSchema = { type: 'object', optional: true, default: { host: '127.0.0.1', port: 8787 }, properties: { host: { type: 'string' }, port: { type: 'number' } } };
const adapters: SettingsSchema = { type: 'object', default: {}, properties: { codex: { type: 'object', optional: true, properties: { program: { type: 'string' } } }, claude: { type: 'object', optional: true, properties: { program: { type: 'string' } } } } };
const installation = source('installation', {}, {
  compose: { type: 'object', optional: true, properties: { files: { type: 'array' }, envFiles: { type: 'array' }, projectName: { type: 'string' }, options: { type: 'object', optional: true, default: {}, properties: { parallel: { type: 'number', optional: true, default: -1 }, compatibility: { type: 'boolean', optional: true, default: false } } } } },
  native: { type: 'object', optional: true, properties: { environmentFile: { type: 'string' } } }
});
const installerKeys = ['NODE_BIN', 'RAC_ENV_FILE', 'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY'];
const baselineExcludedKeys = [...tmuxEnvironmentKeys, ...voiceEnvironmentKeys, ...googleCalendarEnvironmentKeys, ...agentEnvironmentKeys, ...storageEnvironmentKeys, 'RAC_LOG_LEVEL', ...installerKeys];

describe('environment controls owned by other settings tabs', () => {
  // reserve persisted RAC data locations for Storage rather than the general environment page
  it('keeps RAC data files and directories on Storage', () => {
    const keys = environmentKeysWithDedicatedControls([]);
    expect(keys.has('RAC_NOTES_FILE')).toBe(true);
    expect(keys.has('RAC_TEMP_PREVIEWS_DIR')).toBe(true);
    expect(keys.has('RAC_SERVER_ADMIN_STATUS_DIR')).toBe(true);
    expect(storageEnvironmentKeys.size).toBe(18);
    // every storage key has one owner and leaves source selectors with their existing pages
    for (const key of storageEnvironmentKeys) {
      expect(keys.has(key)).toBe(true);
      expect(agentEnvironmentKeys.has(key)).toBe(false);
      expect(voiceEnvironmentKeys.has(key)).toBe(false);
    }
    // leave deployment selectors and external state with their existing owners
    for (const key of ['RAC_CONFIG', 'RAC_CONFIG_WRITE_PATH', 'RAC_ENV_FILE', 'RAC_CLAUDE_CONFIG_DIR', 'RAC_GH_HOSTS', 'RAC_HOST_REPOSITORY', 'RAC_HOST_WORKSPACE', 'RAC_TEMP_PREVIEW_ORIGIN']) expect(storageEnvironmentKeys.has(key)).toBe(false);
  });

  // reserve every adapter-owned environment row for the dedicated Agents page
  it('keeps agent service overrides and account configuration on Agents', () => {
    const keys = environmentKeysWithDedicatedControls([]);
    for (const key of ['RAC_CODEX_BIN', 'RAC_CLAUDE_BIN', 'RAC_CLAUDE_CONFIG_DIR', 'RAC_HOST_CODEX_BIN', 'RAC_OPENAI_ADMIN_KEY', 'RAC_OPENAI_API_KEY_IDS', 'CODEX_VERSION']) expect(keys.has(key)).toBe(true);
    // retain shared bridge and GitHub infrastructure on the environment page
    for (const key of ['RAC_HOST_NODE_BIN', 'RAC_HOST_PATH', 'RAC_HOST_REPOSITORY', 'RAC_HOST_WORKSPACE', 'RAC_GH_HOSTS', 'RAC_GITHUB_TOKEN', 'RAC_INTERACTIVE_SHELL', 'RAC_HOST_INTERACTIVE_SHELL']) expect(keys.has(key)).toBe(false);
  });

  // keep voice and agent setup out of the general environment editor
  it('keeps voice and account-cost credentials with their dedicated pages', () => {
    const keys = environmentKeysWithDedicatedControls([]);
    expect(keys.has('RAC_OPENAI_API_KEY')).toBe(true);
    expect(keys.has('RAC_REALTIME_MCP_TOKEN')).toBe(true);
    expect(keys.has('RAC_OPENAI_ADMIN_KEY')).toBe(true);
    expect(keys.has('RAC_OPENAI_API_KEY_IDS')).toBe(true);
    expect(keys.has('RAC_SESSION_SECRET')).toBe(false);
  });

  // retain exact-key ownership and unsupported exclusions without peer metadata
  it('keeps the baseline environment exclusions without inventing other owners', () => {
    expect([...environmentKeysWithDedicatedControls([])]).toEqual(baselineExcludedKeys);
  });

  // hide settings that have no runtime consumer even when their source value exists
  it('always excludes unused settings from the structured environment editor', () => {
    const env = source('env', { RAC_LOG_LEVEL: 'debug' }, { RAC_LOG_LEVEL: { type: 'string' } });
    expect(environmentKeysWithDedicatedControls([env]).has('RAC_LOG_LEVEL')).toBe(true);
  });

  // hide installer inputs even without their optional installation metadata
  it.each([{ label: 'missing', sources: [] }, { label: 'editable', sources: [installation] }, { label: 'read-only', sources: [{ ...installation, writable: false }] }])('excludes installer-only environment controls with $label peers', ({ sources }) => {
    const keys = environmentKeysWithDedicatedControls(sources);
    // exclude saved and omitted installer aliases without hiding runtime overrides
    for (const key of installerKeys) expect(keys.has(key)).toBe(true);
    // retain commands consumed during runtime or subsequent image builds
    for (const key of ['RAC_HOST_NODE_BIN', 'RAC_HOST_PATH', 'HOST_UID', 'CUSTOM_NODE_BIN']) expect(keys.has(key)).toBe(false);
    expect(agentEnvironmentKeysForInstallation('compose').has('CODEX_VERSION')).toBe(true);
  });

  // service overrides remain on Agents independently of optional adapter sections
  it('finds listener fields without requiring configured adapter sections', () => {
    const keys = environmentKeysWithDedicatedControls([source('app', {}, { listen, adapters })]);
    expect(keys.has('RAC_LISTEN_HOST')).toBe(true);
    expect(keys.has('RAC_LISTEN_PORT')).toBe(true);
    expect(keys.has('RAC_CODEX_BIN')).toBe(true);
    expect(keys.has('RAC_CLAUDE_BIN')).toBe(true);
    const configured = environmentKeysWithDedicatedControls([source('app', { adapters: { codex: { program: '/bin/codex' } } }, { listen, adapters })]);
    expect(configured.has('RAC_CODEX_BIN')).toBe(true);
    expect(configured.has('RAC_HOST_CODEX_BIN')).toBe(true);
  });

  // unavailable schemas and unreadable source roots must not hide the only editable row
  it.each([undefined, null, []])('retains environment rows when the application source is unavailable: %j', value => {
    expect([...environmentKeysWithDedicatedControls([source('app', value, { listen, adapters })])]).toEqual(baselineExcludedKeys);
  });

  // a disabled owner must not hide the editable environment alternative
  it('retains rows when their app or installation counterpart is read-only', () => {
    const app = { ...source('app', {}, { listen, adapters }), writable: false };
    const readOnlyInstallation = { ...installation, writable: false };
    expect([...environmentKeysWithDedicatedControls([app, readOnlyInstallation])]).toEqual(baselineExcludedKeys);
    expect(environmentKeysWithDedicatedControls([readOnlyInstallation]).has('RAC_ENV_FILE')).toBe(true);
  });

  // absent or masked containers do not expose their descendant controls
  it('requires the exact field schema and an expanded public parent', () => {
    expect(environmentKeysWithDedicatedControls([source('app', {}, {})]).has('RAC_LISTEN_HOST')).toBe(false);
    expect(environmentKeysWithDedicatedControls([source('app', { listen: { __racProtected: true, present: true } }, { listen })]).has('RAC_LISTEN_HOST')).toBe(false);
  });

  // Docker-only build arguments must not appear as native runtime configuration
  it('shows the Codex image version only for Docker installations', () => {
    expect([...agentEnvironmentKeysForInstallation('compose')]).toEqual([...agentEnvironmentKeys]);
    for (const kind of ['systemd', undefined] as const) {
      expect(agentEnvironmentKeysForInstallation(kind).has('CODEX_VERSION')).toBe(false);
      expect(agentEnvironmentKeysForInstallation(kind).size).toBe(agentEnvironmentKeys.size - 1);
      expect(environmentKeysWithDedicatedControls([]).has('CODEX_VERSION')).toBe(true);
    }
  });

  // installer aliases stay hidden independently of their file-only counterparts
  it('excludes installation inputs and leaves runtime and custom controls alone', () => {
    const keys = environmentKeysWithDedicatedControls([installation]);
    expect(['COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY'].every(key => keys.has(key))).toBe(true);
    expect(['RAC_CONFIG', 'RAC_CONFIG_WRITE_PATH', 'CLOUDFLARED_CREDENTIALS_FILE', 'RAC_SESSION_SECRET', 'RAC_HOST_REPOSITORY', 'CUSTOM_KEY', 'RAC_LISTEN_HOST_EXTRA'].some(key => keys.has(key))).toBe(false);
  });
});
