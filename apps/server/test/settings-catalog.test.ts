import { describe, expect, it } from 'vitest';
import { sourceSchema } from '../src/config/schema.js';
import { appApply, environmentDescription, environmentFallback, envApply, knownEnvironmentKeys, labels, protectedEnvironment, protectedPath } from '../src/settings/catalog.js';
import { environment, envKey, patchEnvironment } from '../src/settings/env.js';
import { applicationSettingsSchema, settingsSchema } from '../src/settings/schema.js';
import { applicationHash } from '../src/settings/proof.js';

describe('settings environment source model', () => {
  // preserve dotenv literal semantics without mutating process.env
  it('parses quoted hashes, dollar signs, empty values, and multiline values literally', () => {
    const before = process.env.RAC_SETTINGS_SENTINEL;
    const parsed = environment([
      'PLAIN=value',
      'HASH="value # retained"',
      "DOLLAR='$HOME ${NOT_EXPANDED}'",
      "MULTILINE='line one",
      "line two'",
      'EMPTY=',
      ''
    ].join('\n'));

    expect(parsed).toEqual({
      PLAIN: 'value',
      HASH: 'value # retained',
      DOLLAR: '$HOME ${NOT_EXPANDED}',
      MULTILINE: 'line one\nline two',
      EMPTY: ''
    });
    expect(process.env.RAC_SETTINGS_SENTINEL).toBe(before);
  });

  // rewrite only the selected assignment and preserve all other bytes
  it('round-trips one keyed edit without normalizing comments or neighboring entries', () => {
    const original = '# installation comment\nFIRST = unquoted\nSECRET="old value" # old comment\nLAST=$literal\n';
    const changed = patchEnvironment(original, 'SECRET', 'new # $literal value');

    expect(changed).toBe("# installation comment\nFIRST = unquoted\nSECRET='new # $literal value'\nLAST=$literal\n");
    expect(environment(changed)).toMatchObject({ FIRST: 'unquoted', SECRET: 'new # $literal value', LAST: '$literal' });
  });

  // append new entries and remove existing entries without fabricating masked values
  it('supports append and remove while rejecting placeholders and ambiguous duplicates', () => {
    expect(patchEnvironment('A=one', 'B', 'two')).toBe("A=one\nB='two'\n");
    expect(patchEnvironment('A=one\nB=two\n', 'A')).toBe('B=two\n');
    expect(() => patchEnvironment('A=one\nA=two\n', 'A', 'three')).toThrowError('duplicate_environment_key');
    expect(() => patchEnvironment('A=one\n', 'A', '••••••')).toThrowError('invalid_environment_value');
  });

  // reject invalid identities, binary text, and values that cannot be represented safely
  it('fails closed for invalid environment edits', () => {
    expect(envKey.test('VALID_NAME_2')).toBe(true);
    expect(envKey.test('2_INVALID')).toBe(false);
    expect(() => environment('A=one\0B=two')).toThrowError('invalid_environment');
    expect(() => patchEnvironment('A=one\n', '2_INVALID', 'value')).toThrowError('invalid_environment_key');
    expect(() => patchEnvironment('A=one\n', 'A', `both'and" plus # comment`)).toThrowError('environment_value_requires_source_edit');
  });
});

describe('settings catalog classification', () => {
  // keep source labels consistent across pending navigation and the loaded catalog
  it('names Installation, Environment & keys, and Docker without changing source identities', () => {
    expect(labels.installation).toBe('Installation');
    expect(labels.env).toBe('Environment & keys');
    expect(labels['compose-override']).toBe('Docker');
    expect(labels.compose).toBe('Base Compose');
  });

  // keep the registry deterministic and safe for keyed editing
  it('publishes unique valid known environment keys', () => {
    expect(new Set(knownEnvironmentKeys).size).toBe(knownEnvironmentKeys.length);
    expect(knownEnvironmentKeys.every(key => envKey.test(key))).toBe(true);
    expect(knownEnvironmentKeys).toContain('RAC_ENV_FILE');
    expect(knownEnvironmentKeys).toContain('CLOUDFLARED_CREDENTIALS_FILE');
    expect(knownEnvironmentKeys).toEqual(expect.arrayContaining(['COMPOSE_ENV_FILES', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_COMPATIBILITY']));
  });

  // require operator guidance for every cataloged and custom environment field
  it('describes every known environment setting and gives custom variables an honest fallback', () => {
    expect(knownEnvironmentKeys.every(key => environmentDescription(key).length >= 24)).toBe(true);
    expect(environmentDescription('RAC_PASSWORD_HASH')).toContain('Argon2id');
    expect(environmentDescription('RAC_HOST_TMUX_SOURCE')).toContain('tmux socket');
    expect(environmentDescription('RAC_PROMPT_HISTORY_FILE')).toContain('prompt history');
    expect(environmentDescription('CUSTOM_OPERATOR_SETTING')).toBe('Custom environment variable preserved in this environment file. Its effect depends on the process or deployment that reads it.');
    expect(['__proto__', 'constructor', 'toString'].map(environmentDescription)).toEqual(Array(3).fill('Custom environment variable preserved in this environment file. Its effect depends on the process or deployment that reads it.'));
  });

  // publish exact or honest symbolic omission behavior without inventing custom defaults
  it('catalogs safe environment fallbacks', () => {
    expect(environmentFallback('RAC_TMUX_BIN')).toEqual({ value: '/usr/bin/tmux', kind: 'literal' });
    expect(environmentFallback('RAC_HOST_TMUX_SOURCE')).toEqual({ value: '/tmp/tmux-${RAC_HOST_UID or process UID}', kind: 'derived' });
    expect(environmentFallback('RAC_INSTANCE_STATUS_SECRET')).toEqual({ value: 'Uses RAC_SESSION_SECRET', kind: 'derived' });
    expect(environmentFallback('RAC_INTEGRATION_FEDERATION_SECRET')).toEqual({ value: 'Uses RAC_INSTANCE_STATUS_SECRET, then RAC_SESSION_SECRET', kind: 'derived' });
    expect(environmentFallback('COMPOSE_PARALLEL_LIMIT')).toEqual({ value: '-1 (unlimited)', kind: 'literal' });
    expect(environmentFallback('COMPOSE_COMPATIBILITY')).toEqual({ value: 'false', kind: 'literal' });
    expect(environmentFallback('RAC_PASSWORD_HASH')).toBeUndefined();
    expect(environmentFallback('RAC_SESSION_SECRET')).toBeUndefined();
    expect(environmentFallback('RAC_LOG_LEVEL')).toBeUndefined();
    expect(environmentFallback('CUSTOM_OPERATOR_SETTING')).toBeUndefined();
  });

  // cover every catalogued variable while leaving required, disabled, or contextual settings honest
  it('classifies every known environment omission', () => {
    const withoutUniversalFallback = [
      'RAC_PASSWORD_HASH', 'RAC_SESSION_SECRET', 'RAC_OPENAI_API_KEY', 'RAC_OPENAI_ADMIN_KEY', 'RAC_OPENAI_API_KEY_IDS',
      'RAC_VAPID_PUBLIC_KEY', 'RAC_VAPID_PRIVATE_KEY', 'RAC_CONFIG', 'RAC_LOG_LEVEL', 'RAC_HOST_PROC', 'RAC_HOST_TMUX_DIR',
      'RAC_HOST_UID', 'RAC_HOST_NODE_BIN', 'RAC_HOST_PATH', 'RAC_HOST_REPOSITORY', 'RAC_HOST_WORKSPACE', 'HOST_UID', 'HOST_TMUX_DIR', 'HOST_TMUX_BIN'
    ];

    expect(knownEnvironmentKeys.filter(key => environmentFallback(key) === undefined)).toEqual(withoutUniversalFallback);
    expect(knownEnvironmentKeys.filter(key => environmentFallback(key) !== undefined).every(key => environmentFallback(key)!.value.trim().length > 0)).toBe(true);
  });

  // mask credential values while allowing ordinary known and unknown settings
  it('protects credential-bearing environment values only', () => {
    expect(protectedEnvironment('RAC_SESSION_SECRET')).toBe(true);
    expect(protectedEnvironment('RAC_OPENAI_API_KEY')).toBe(true);
    expect(protectedEnvironment('RAC_OPENAI_API_KEY_IDS')).toBe(false);
    expect(protectedEnvironment('CUSTOM_SIGNING_KEY')).toBe(true);
    expect(protectedEnvironment('CUSTOM_AUTH_HEADER')).toBe(true);
    expect(protectedEnvironment('CUSTOM_KEY_PASSPHRASE')).toBe(true);
    expect(protectedEnvironment('CUSTOM_PRIVATE_KEY_PATH')).toBe(false);
    expect(protectedEnvironment('RAC_VAPID_PUBLIC_KEY')).toBe(false);
    expect(protectedEnvironment('UNRECOGNIZED_OPERATOR_VALUE')).toBe(false);
    expect(protectedEnvironment('RAC_LISTEN_PORT')).toBe(false);
    expect(protectedEnvironment('TZ')).toBe(false);
  });

  // classify dormant, source-selecting, and consumed environment settings separately
  it('classifies environment apply impact conservatively', () => {
    expect(envApply('RAC_LOG_LEVEL')).toBe('saved-only');
    expect(envApply('RAC_BOOKMARKS_FILE')).toBe('saved-only');
    expect(envApply('RAC_ENV_FILE')).toBe('source-migration');
    expect(envApply('COMPOSE_PROJECT_NAME')).toBe('saved-only');
    expect(envApply('RAC_ADAPTER_FILES_DIR')).toBe('source-migration');
    expect(envApply('RAC_INTERACTIVE_SHELL')).toBe('rac-restart');
    expect(envApply('RAC_HOST_REPOSITORY')).toBe('rac-restart');
    expect(envApply('RAC_LISTEN_PORT')).toBe('rac-restart');
  });

  // protect credential leaves while keeping advanced operator settings visible
  it('protects only credential-bearing application leaves', () => {
    expect(protectedPath(['editor'])).toBe(false);
    expect(protectedPath(['adapters', 'codex', 'args'])).toBe(false);
    expect(protectedPath(['adapters', 'codex', 'env', 'SAFE_LOOKING_NAME'])).toBe(false);
    expect(protectedPath(['adapters', 'codex', 'env', 'ACCESS_TOKEN'])).toBe(true);
    expect(protectedPath(['projects', '0', 'commands', 'start'])).toBe(false);
    expect(protectedPath(['projects', '0', 'newTask'])).toBe(false);
    expect(protectedPath(['projects', '0', 'push', 'prompt'])).toBe(false);
    expect(protectedPath(['integrations', 'realtime', 'context'])).toBe(false);
    expect(protectedPath(['integration', 'privateKeyFile'])).toBe(false);
    expect(protectedPath(['integration', 'privateKey'])).toBe(true);
    expect(protectedPath(['integrations', 'realtime', 'enabled'])).toBe(false);
  });

  // separate established live settings from dormant and restart-bound fields
  it('classifies application changes by observed runtime behavior', () => {
    expect(appApply(['name'])).toBe('live');
    expect(appApply(['defaultAgent'])).toBe('live');
    expect(appApply(['integrations', 'realtime', 'enabled'])).toBe('live');
    expect(appApply(['proxy', 'trustedSourceIps'])).toBe('saved-only');
    expect(appApply(['remoteServers', '0', 'name'])).toBe('rac-restart');
    expect(appApply(['remoteServers', '0', 'icon'])).toBe('rac-restart');
    expect(appApply(['integrations', 'enabled'])).toBe('rac-restart');
    expect(appApply(['listen', 'port'])).toBe('rac-restart');
  });

  // include remote identity overrides in effective restart evidence
  it('hashes remote identity overrides independently of saved-only settings', () => {
    const base = { publicOrigin: 'https://agents.example.com', remoteServers: [{ url: 'https://framework.example.com' }], proxy: { trustedSourceIps: ['127.0.0.1'] } };

    expect(applicationHash({ ...base, remoteServers: [{ ...base.remoteServers[0], name: 'Workshop' }] })).not.toBe(applicationHash(base));
    expect(applicationHash({ ...base, remoteServers: [{ ...base.remoteServers[0], icon: 'heart' }] })).not.toBe(applicationHash(base));
    expect(applicationHash({ ...base, proxy: { trustedSourceIps: ['192.0.2.1'] } })).toBe(applicationHash(base));
  });
});

describe('settings schema metadata', () => {
  // describe every nested application configuration category from the runtime schema
  it('preserves nested object, array, record, enum, union, optional, and default metadata', () => {
    const schema = settingsSchema(sourceSchema);

    expect(schema.type).toBe('object');
    expect(schema.properties?.listen).toMatchObject({ type: 'object', optional: true, default: { host: '127.0.0.1', port: 8787 } });
    expect(schema.properties?.listen?.properties?.port).toMatchObject({ type: 'number' });
    expect(schema.properties?.defaultAgent).toMatchObject({ type: 'enum', optional: true });
    expect(schema.properties?.defaultAgent?.options).toEqual(['codex', 'omx', 'claude', 'pi', 'opencode']);
    expect(schema.properties?.adapters?.properties?.codex?.properties?.args).toMatchObject({ type: 'array', optional: true, items: { type: 'string' } });
    expect(schema.properties?.adapters?.properties?.codex?.properties?.env).toMatchObject({ type: 'record', optional: true, items: { type: 'string' } });
    expect(schema.properties?.adapters?.properties?.codex?.properties?.updates?.properties).toMatchObject({ current: { type: 'string' }, latest: { type: 'string' }, run: { type: 'string' } });
    expect(schema.properties?.projects).toMatchObject({ type: 'array', optional: true });
    expect(schema.properties?.projects?.items?.properties?.commands?.properties?.processes?.items?.type).toBe('union');
    expect(schema.properties?.integrations?.properties?.realtime?.properties).toMatchObject({ enabled: expect.any(Object), name: expect.any(Object), context: expect.any(Object), writeToolsEnabled: expect.any(Object) });
    expect(schema.properties?.keys).toMatchObject({ type: 'json', optional: true });
  });

  // keep keyboard terminal commands and other noncredential controls directly editable
  it('marks only credential identities as protected in application controls', () => {
    const schema = applicationSettingsSchema();
    const terminal = schema.properties?.keys?.items?.items?.variants?.find(variant => variant.label === 'Terminal command');

    expect(schema.properties?.editor?.protected).toBe(false);
    expect(schema.properties?.integrations?.properties?.realtime?.properties?.context?.protected).toBe(false);
    expect(terminal?.properties?.terminal?.protected).toBe(false);
    expect(terminal?.properties?.reuse).toMatchObject({ type: 'boolean', optional: true, default: false });
  });

  // describe every project field without changing validator optionality or defaults
  it('publishes grounded metadata for all Project, override, command, process, and push fields', () => {
    const projects = applicationSettingsSchema().properties?.projects;
    const project = projects?.items;
    const commands = project?.properties?.commands;
    const override = project?.properties?.worktreeOverrides?.items;
    const overrideCommands = override?.properties?.commands;
    const process = commands?.properties?.processes?.items;
    const processObject = process?.variants?.find(variant => variant.type === 'object');
    const push = project?.properties?.push;
    const described = [
      projects, project,
      ...Object.values(project?.properties ?? {}),
      ...Object.values(commands?.properties ?? {}),
      override, ...Object.values(override?.properties ?? {}),
      ...Object.values(overrideCommands?.properties ?? {}),
      process, processObject, ...Object.values(processObject?.properties ?? {}),
      ...Object.values(push?.properties ?? {})
    ];

    expect(described.every(node => typeof node?.description === 'string' && node.description.length >= 24)).toBe(true);
    expect(project?.properties?.id?.description).toBe('Stable Project key used for saved state and Worktree IDs. Use 1–80 letters, numbers, underscores, or dashes.');
    expect(project?.properties?.defaultBranch).toMatchObject({ type: 'string', optional: true });
    expect(project?.properties?.defaultBranch?.description).toContain('Leave blank to fall back to main');
    expect(project?.properties?.path?.description).toContain('plain directory');
    expect(commands?.properties?.processes?.description).toContain('derive Start');
    expect(overrideCommands?.description).toContain('empty object disables');
    expect(processObject?.properties?.dependsOn?.description).toContain('cannot cycle');
    expect(processObject?.properties?.dependsOn?.items?.description).toContain('declared process');
    expect(project?.properties?.worktreeOrder?.items?.description).toContain('checkout path');
    expect(push?.properties?.prompt?.description).toContain('active agent');
    expect(push).toMatchObject({ optional: true, default: { label: 'Commit/Push', prompt: 'review, commit, and push' } });
  });
});
