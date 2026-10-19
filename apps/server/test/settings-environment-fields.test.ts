import { describe, expect, it } from 'vitest';
import type { SettingsSchema, SettingsSource } from '../../web/src/settings/contracts.js';
import { environmentKeysWithDedicatedControls } from '../../web/src/settings/environment-fields.js';
import { tmuxEnvironmentKeys } from '../../web/src/settings/tmux-settings.js';

// isolate the actual field visibility inputs without writing source files
const source = (id: string, value: unknown, properties: Record<string, SettingsSchema>): SettingsSource => ({ id, label: id, format: id === 'installation' ? 'installation' : 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: 'revision', apply: 'rac-restart', value, schema: { type: 'object', properties } });
const listen: SettingsSchema = { type: 'object', optional: true, default: { host: '127.0.0.1', port: 8787 }, properties: { host: { type: 'string' }, port: { type: 'number' } } };
const adapters: SettingsSchema = { type: 'object', default: {}, properties: { codex: { type: 'object', optional: true, properties: { program: { type: 'string' } } }, claude: { type: 'object', optional: true, properties: { program: { type: 'string' } } } } };
const installation = source('installation', {}, {
  compose: { type: 'object', optional: true, properties: { files: { type: 'array' }, envFiles: { type: 'array' }, projectName: { type: 'string' }, options: { type: 'object', optional: true, default: {}, properties: { parallel: { type: 'number', optional: true, default: -1 }, compatibility: { type: 'boolean', optional: true, default: false } } } } },
  native: { type: 'object', optional: true, properties: { environmentFile: { type: 'string' } } }
});

describe('environment controls owned by other settings tabs', () => {
  // retain exact-key ownership and unsupported exclusions without peer metadata
  it('keeps the baseline environment exclusions without inventing other owners', () => {
    expect([...environmentKeysWithDedicatedControls([])]).toEqual([...tmuxEnvironmentKeys, 'RAC_LOG_LEVEL']);
  });

  // hide settings that have no runtime consumer even when their source value exists
  it('always excludes unused settings from the structured environment editor', () => {
    const env = source('env', { RAC_LOG_LEVEL: 'debug' }, { RAC_LOG_LEVEL: { type: 'string' } });
    expect(environmentKeysWithDedicatedControls([env]).has('RAC_LOG_LEVEL')).toBe(true);
  });

  // defaulted listener controls and configured adapter sections are real counterparts
  it('finds application fields without materializing missing adapter sections', () => {
    const keys = environmentKeysWithDedicatedControls([source('app', {}, { listen, adapters })]);
    expect(keys.has('RAC_LISTEN_HOST')).toBe(true);
    expect(keys.has('RAC_LISTEN_PORT')).toBe(true);
    expect(keys.has('RAC_CODEX_BIN')).toBe(false);
    expect(keys.has('RAC_CLAUDE_BIN')).toBe(false);
    const configured = environmentKeysWithDedicatedControls([source('app', { adapters: { codex: { program: '/bin/codex' } } }, { listen, adapters })]);
    expect(configured.has('RAC_CODEX_BIN')).toBe(true);
    expect(configured.has('RAC_HOST_CODEX_BIN')).toBe(false);
  });

  // unavailable schemas and unreadable source roots must not hide the only editable row
  it.each([undefined, null, []])('retains environment rows when the application source is unavailable: %j', value => {
    expect([...environmentKeysWithDedicatedControls([source('app', value, { listen, adapters })])]).toEqual([...tmuxEnvironmentKeys, 'RAC_LOG_LEVEL']);
  });

  // a disabled owner must not hide the editable environment alternative
  it('retains rows when their app or installation counterpart is read-only', () => {
    const app = { ...source('app', {}, { listen, adapters }), writable: false };
    const readOnlyInstallation = { ...installation, writable: false };
    expect([...environmentKeysWithDedicatedControls([app, readOnlyInstallation], 'compose')]).toEqual([...tmuxEnvironmentKeys, 'RAC_LOG_LEVEL']);
    expect(environmentKeysWithDedicatedControls([readOnlyInstallation], 'systemd').has('RAC_ENV_FILE')).toBe(false);
  });

  // absent or masked containers do not expose their descendant controls
  it('requires the exact field schema and an expanded public parent', () => {
    expect(environmentKeysWithDedicatedControls([source('app', {}, {})]).has('RAC_LISTEN_HOST')).toBe(false);
    expect(environmentKeysWithDedicatedControls([source('app', { adapters: { codex: { __racProtected: true, present: true } } }, { adapters })]).has('RAC_CODEX_BIN')).toBe(false);
  });

  // only the configured installation mode owns its corresponding form controls
  it('finds Docker installation controls and leaves native and unrelated inputs alone', () => {
    const keys = environmentKeysWithDedicatedControls([installation], 'compose');
    expect(['COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY'].every(key => keys.has(key))).toBe(true);
    expect(['RAC_ENV_FILE', 'COMPOSE_PROFILES', 'RAC_CONFIG', 'RAC_CONFIG_WRITE_PATH', 'CLOUDFLARED_CREDENTIALS_FILE', 'RAC_SESSION_SECRET', 'RAC_HOST_REPOSITORY', 'CUSTOM_KEY', 'RAC_LISTEN_HOST_EXTRA'].some(key => keys.has(key))).toBe(false);
  });

  // mode switching is view-only and does not create ownership for inactive branches
  it('finds only the native environment-file counterpart in a native installation', () => {
    const keys = environmentKeysWithDedicatedControls([installation], 'systemd');
    expect(keys.has('RAC_ENV_FILE')).toBe(true);
    expect(keys.has('COMPOSE_FILE')).toBe(false);
    expect(environmentKeysWithDedicatedControls([installation]).has('RAC_ENV_FILE')).toBe(false);
  });
});
