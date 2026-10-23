import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sourceSchema } from '../src/config/schema.js';
import { builtInTourPrompt } from '../src/review-runs/config.js';
import { appApply, composeOptionSettings, environmentDescription, environmentFallback, envApply, knownEnvironmentKeys, labels, managedEnvironment, managedEnvironmentKeys, protectedEnvironment, protectedPath } from '../src/settings/catalog.js';
import { environment, envKey, partitionEnvironment, patchEnvironment, restoreManagedEnvironment } from '../src/settings/env.js';
import { applicationSettingsSchema, installationSettingsPresentationSchema, settingsSchema } from '../src/settings/schema.js';
import { applicationHash } from '../src/settings/proof.js';
import { installationSettingsSchema } from '../src/settings/validation.js';

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

  // project managed records without normalizing multiline values or duplicates
  it('partitions and restores complete managed environment records byte-for-byte', () => {
    const content = "# before\nVISIBLE='one'\nexport RAC_VAPID_PUBLIC_KEY=public\nRAC_VAPID_PRIVATE_KEY='private\nvalue'\nRAC_VAPID_PRIVATE_KEY=duplicate\nTRAILING=two";
    const partitioned = partitionEnvironment(content, ['RAC_VAPID_PUBLIC_KEY', 'RAC_VAPID_PRIVATE_KEY']);

    expect(partitioned.visible).toBe("# before\nVISIBLE='one'\nTRAILING=two");
    expect(partitioned.hidden).toBe("export RAC_VAPID_PUBLIC_KEY=public\nRAC_VAPID_PRIVATE_KEY='private\nvalue'\nRAC_VAPID_PRIVATE_KEY=duplicate\n");
    expect(restoreManagedEnvironment(partitioned.visible, partitioned.hidden)).toBe("# before\nVISIBLE='one'\nTRAILING=two\nexport RAC_VAPID_PUBLIC_KEY=public\nRAC_VAPID_PRIVATE_KEY='private\nvalue'\nRAC_VAPID_PRIVATE_KEY=duplicate\n");
  });

  // keep repairable malformed records visible without exposing later managed assignments
  it('partitions managed records after an unterminated ordinary assignment', () => {
    const partitioned = partitionEnvironment('BROKEN="unfinished\nRAC_VAPID_PRIVATE_KEY=private\nVISIBLE=ok\n', ['RAC_VAPID_PRIVATE_KEY']);

    expect(partitioned).toEqual({ visible: 'BROKEN="unfinished\nVISIBLE=ok\n', hidden: 'RAC_VAPID_PRIVATE_KEY=private\n' });
    expect(() => patchEnvironment('BROKEN="unfinished\nRAC_VAPID_PRIVATE_KEY=private\nVISIBLE=ok\n', 'VISIBLE', 'changed')).toThrowError('invalid_environment');
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
    expect(knownEnvironmentKeys).not.toEqual(expect.arrayContaining(managedEnvironmentKeys));
    expect(managedEnvironmentKeys.every(managedEnvironment)).toBe(true);
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

  // keep omission behavior in input placeholders rather than descriptive copy
  it('separates environment and Compose defaults from field descriptions', () => {
    expect(environmentDescription('RAC_CONFIG_WRITE_PATH')).toBe('Application configuration destination written by the settings host.');
    expect(environmentFallback('RAC_CONFIG_WRITE_PATH')).toEqual({ value: 'Same as RAC_CONFIG', kind: 'derived' });
    expect(environmentDescription('RAC_GH_HOSTS')).toBe('GitHub CLI hosts file used to obtain a github.com access token.');
    expect(environmentFallback('RAC_GH_HOSTS')).toEqual({ value: '~/.config/gh/hosts.yml', kind: 'derived' });
    expect(environmentFallback('RAC_CLAUDE_CONFIG_DIR')).toEqual({ value: 'CLAUDE_CONFIG_DIR, then ~/.claude', kind: 'derived' });
    expect(environmentFallback('RAC_SERVER_ADMIN_STATUS_DIR')).toEqual({ value: '.data', kind: 'derived' });
    expect(environmentFallback('RAC_ADAPTER_FILES_DIR')).toEqual({ value: '.data/adapters', kind: 'derived' });
    expect(composeOptionSettings.parallel).toMatchObject({ default: -1, placeholder: '-1 (from Docker Compose default; unlimited)', description: 'Maximum simultaneous Docker operations, such as image pulls and builds. This does not limit RAC agents or requests.' });
    expect(composeOptionSettings.compatibility).toMatchObject({ default: false, placeholder: 'false', description: 'Use legacy Compose behavior, including underscore-separated container names.' });
  });

  // publish exact or honest symbolic omission behavior without inventing custom defaults
  it('catalogs safe environment fallbacks', () => {
    expect(environmentFallback('RAC_TMUX_BIN')).toEqual({ value: '/usr/bin/tmux', kind: 'literal' });
    expect(environmentFallback('RAC_HOST_NODE_BIN')).toEqual({ value: 'node from host PATH', kind: 'derived' });
    expect(environmentFallback('RAC_HOST_TMUX_SOURCE')).toEqual({ value: '/tmp/tmux-${RAC_HOST_UID or process UID}', kind: 'derived' });
    expect(environmentFallback('RAC_INSTANCE_STATUS_SECRET')).toEqual({ value: 'Uses RAC_SESSION_SECRET', kind: 'derived' });
    expect(environmentFallback('RAC_INTEGRATION_FEDERATION_SECRET')).toEqual({ value: 'Uses RAC_INSTANCE_STATUS_SECRET, then RAC_SESSION_SECRET', kind: 'derived' });
    expect(environmentFallback('COMPOSE_PARALLEL_LIMIT')).toEqual({ value: '-1 (unlimited)', kind: 'literal' });
    expect(environmentFallback('COMPOSE_COMPATIBILITY')).toEqual({ value: 'false', kind: 'literal' });
    expect(environmentFallback('RAC_PASSWORD_HASH')).toEqual({ value: 'Required; no default', kind: 'derived' });
    expect(environmentFallback('RAC_SESSION_SECRET')).toEqual({ value: 'Required; no default', kind: 'derived' });
    expect(environmentFallback('RAC_LOG_LEVEL')).toEqual({ value: 'Not used by RAC', kind: 'derived' });
    expect(environmentFallback('CUSTOM_OPERATOR_SETTING')).toBeUndefined();
  });

  // keep timezone omission guidance consistent for native and Docker installations
  it.each([undefined, 'compose', 'systemd'] as const)('inherits the host time zone for %s installations', installationKind => {
    expect(environmentFallback('TZ', installationKind)).toEqual({ value: 'Host time zone', kind: 'derived' });
  });

  // cover required and contextual omission behavior without inventing values
  it('classifies every known environment omission', () => {
    expect(knownEnvironmentKeys.every(key => environmentFallback(key)?.value.trim())).toBe(true);
  });

  // distinguish a Docker bridge convention from native socket discovery
  it('describes the missing TMUX defaults for each installation mode', () => {
    expect(environmentFallback('RAC_HOST_TMUX_DIR', 'compose')).toEqual({ value: 'Docker bridge: /host-tmux; otherwise native socket discovery', kind: 'derived' });
    expect(environmentFallback('RAC_HOST_TMUX_DIR', 'systemd')).toEqual({ value: 'Native socket discovery; no mounted host socket directory', kind: 'derived' });
    expect(environmentFallback('HOST_TMUX_DIR')).toEqual({ value: 'Standard Docker bridge: ~/.local/state/tmux/tmux-${HOST_UID:-1000}', kind: 'derived' });
    expect(environmentFallback('HOST_TMUX_BIN')).toEqual({ value: 'Standard Docker bridge: /usr/bin/tmux', kind: 'derived' });
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
    expect(applicationSettingsSchema().properties?.integrations?.properties?.multiInstance).toBeUndefined();
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

  // present omission behavior on the field rather than inside explanatory copy
  it('publishes grounded application and review placeholders', () => {
    const schema = applicationSettingsSchema({ scratchDirectory: '/home/operator' });
    const review = schema.properties?.review;
    const tour = review?.properties?.tour;
    const preset = review?.properties?.presets?.items;
    const project = schema.properties?.projects?.items;

    expect(schema.properties?.listen?.properties).toMatchObject({
      host: { placeholder: '127.0.0.1 (from built-in default)' },
      port: { placeholder: '8787 (from built-in default)' }
    });
    expect(schema.properties?.scratchDirectory?.placeholder).toBe('/home/operator (from host home)');
    expect(applicationSettingsSchema().properties?.scratchDirectory?.placeholder).toBe('Unavailable (from host home)');
    expect(schema.properties?.editor?.placeholder).toBe('Disabled when unset');
    expect(schema.properties?.publicOrigin?.placeholder).toBe('Required; no default');
    expect(project?.properties).toMatchObject({
      id: { placeholder: 'Derived from the folder name when unset' },
      path: { placeholder: 'Required; no default' },
      externalUrl: { placeholder: 'No preview when unset' },
      newTask: { placeholder: 'No New Task action when unset' }
    });
    expect(tour?.properties).toMatchObject({
      model: { placeholder: 'Not specified (from agent default)' },
      effort: { placeholder: 'Not specified (from agent default)' },
      prompt: { placeholder: `${builtInTourPrompt} (from built-in Review Tour prompt)` }
    });
    expect(review?.properties?.presets?.placeholder).toBe('Correctness (from built-in Review preset)');
    expect(preset?.properties).toMatchObject({
      model: { placeholder: 'Not specified (from agent default)' },
      effort: { placeholder: 'Not specified (from agent default)' }
    });
    expect(preset?.properties?.prompt?.placeholder).toBeUndefined();
    expect(review?.properties?.defaultPreset?.placeholder).toBe('correctness (from first Review preset)');
  });

  // keep acronym display copy separate from authored identities
  it('capitalizes MCP and OMX presentation labels without changing their canonical keys or enum values', () => {
    const schema = applicationSettingsSchema();
    expect(schema.properties!.integrations!.properties!.mcp!.label).toBe('MCP');
    expect(schema.properties!.adapters!.properties!.omx!.label).toBe('OMX');
    expect(schema.properties!.defaultAgent!.options).toContain('omx');
    expect(schema.properties!.defaultAgent!.options).not.toContain('OMX');
    expect(schema.properties!.adapters!.properties).not.toHaveProperty('OMX');
    expect(schema.properties!.integrations!.properties).not.toHaveProperty('MCP');
  });

  // retain review labels and required custom preset validation metadata
  it('describes every Review section without weakening required preset fields', () => {
    const review = applicationSettingsSchema().properties!.review!;
    expect(review.label).toBe('Reviews');
    expect(review.properties!.agents!.label).toBe('Review agents');
    expect(review.properties!.tour!.label).toBe('Review tour');
    expect(review.properties!.presets!.label).toBe('Review presets');
    expect(review.properties!.presets!.items!.label).toBe('Review preset');
    expect(review.properties!.defaultPreset!.label).toBe('Default preset');
    expect(review.properties!.tour!.properties!.agent!.optional).toBe(true);
    expect(review.properties!.presets!.items!.properties!.prompt!.optional).not.toBe(true);
    expect(review.properties!.presets!.items!.properties!.model!.optional).toBe(true);
  });

  // keep optional adapter commands and collection containers permanently visible
  it('publishes permanent adapter lifecycle and collection controls with Environment & keys', () => {
    const adapters = applicationSettingsSchema().properties!.adapters!.properties!;

    // apply the same presentation contract to every supported adapter
    for (const adapter of Object.values(adapters)) {
      expect(adapter.properties!.args).toMatchObject({ type: 'array', optional: true, default: [], items: { type: 'string' } });
      expect(adapter.properties!.env).toMatchObject({ type: 'record', optional: true, label: 'Environment & keys', items: { type: 'string' } });
      expect(adapter.properties!.setup).toMatchObject({ type: 'string', optional: true, editor: 'shell', default: '', placeholder: 'Disabled (when blank)' });
      expect(adapter.properties!.teardown).toMatchObject({ type: 'string', optional: true, editor: 'shell', default: '', placeholder: 'Disabled (when blank)' });
      expect(adapter.properties!.updates).toMatchObject({
        type: 'object',
        optional: true,
        default: {},
        description: 'Set all three commands to enable agent updates. Leave all three blank to disable updates.'
      });
      expect(adapter.properties!.updates!.properties).toMatchObject({
        current: { label: 'Get current version command', editor: 'shell' },
        latest: { label: 'Get latest version command', editor: 'shell' },
        run: { label: 'Update command', editor: 'shell' }
      });
    }
  });

  // describe scalar parser defaults as values rather than symbolic labels
  it('formats scalar defaults with their built-in source', () => {
    const schema = settingsSchema(z.object({ text: z.string().default('safe'), empty: z.string().default(''), count: z.number().default(0), enabled: z.boolean().default(false) }));

    expect(schema.properties).toMatchObject({
      text: { placeholder: 'safe (from built-in default)' },
      empty: { placeholder: 'Empty (from built-in default)' },
      count: { placeholder: '0 (from built-in default)' },
      enabled: { placeholder: 'false (from built-in default)' }
    });
  });

  // keep installation omission guidance separate from the parsed descriptor
  it('publishes the installed checkout placeholder as presentation metadata', () => {
    const parsed = installationSettingsSchema.parse({ version: 1 });
    const presentation = installationSettingsPresentationSchema(installationSettingsSchema, '/srv/remoteagents');

    expect(parsed).toEqual({ version: 1 });
    expect(presentation.properties?.host?.properties?.checkout?.placeholder).toBe('/srv/remoteagents (from installed checkout)');
    expect(installationSettingsPresentationSchema(installationSettingsSchema).properties?.host?.properties?.checkout?.placeholder).toBe('Unavailable (from installed checkout)');
  });

  // describe every visible project field without changing validator optionality or defaults
  it('publishes grounded metadata for Project, override, command, process, and button fields', () => {
    const projects = applicationSettingsSchema().properties?.projects;
    const project = projects?.items;
    const commands = project?.properties?.commands;
    const override = project?.properties?.worktreeOverrides?.items;
    const overrideCommands = override?.properties?.commands;
    const process = commands?.properties?.processes?.items;
    const processObject = process?.variants?.find(variant => variant.type === 'object');
    const buttons = project?.properties?.buttons;
    const button = buttons?.properties?.pullRequest?.items;
    const described = [
      projects, project,
      ...Object.values(project?.properties ?? {}),
      ...Object.values(commands?.properties ?? {}),
      override, ...Object.values(override?.properties ?? {}),
      ...Object.values(overrideCommands?.properties ?? {}),
      process, processObject, ...Object.values(processObject?.properties ?? {})
    ];

    expect(described.every(node => typeof node?.description === 'string' && node.description.length >= 24)).toBe(true);
    expect(project?.properties?.id?.description).toBe('Stable Project key used for saved state and Worktree IDs. Use 1–80 letters, numbers, underscores, or dashes. Leave unset to keep the id the console gave this folder when it was opened without configuration.');
    expect(project?.properties?.defaultBranch).toMatchObject({ type: 'string', optional: true });
    expect(project?.properties?.label).toMatchObject({ placeholder: 'Unavailable (from Project ID)', description: 'Display name for this Project.' });
    expect(project?.properties?.defaultBranch).toMatchObject({ placeholder: 'Unavailable (from resolved branch)', description: 'Comparison branch for Worktree changes.' });
    expect(project?.properties?.hostPath).toMatchObject({ placeholder: 'Unavailable (from Project Path)', description: 'Host path for the Main checkout when RAC runs in Docker.' });
    expect(project?.properties?.worktreeOrder).toMatchObject({ placeholder: 'Unavailable (from discovered Worktree order)', description: 'Checkout paths to show first, in this order. Relative paths resolve from the Project path.' });
    expect(project?.properties?.worktreesDirectory).toMatchObject({ placeholder: 'Unavailable (from resolved Worktrees directory)', description: 'Directory where RAC creates Worktrees. Relative paths resolve from the Main checkout.' });
    expect(project?.properties?.path?.description).toContain('plain directory');
    expect(project?.properties).not.toHaveProperty('hostname');
    expect(project?.properties).not.toHaveProperty('port');
    expect(commands?.properties?.processes?.description).toContain('derive Start');
    expect(overrideCommands).toMatchObject({ description: expect.stringContaining('empty object disables') });
    expect(overrideCommands).not.toHaveProperty('placeholder');
    expect(override?.properties).not.toHaveProperty('hostname');
    expect(override?.properties).not.toHaveProperty('port');
    expect(override?.properties?.externalUrl).toMatchObject({ placeholder: 'No preview when unset' });
    expect(processObject?.properties?.dependsOn?.description).toContain('cannot cycle');
    expect(processObject?.properties?.dependsOn?.items?.description).toContain('declared process');
    expect(project?.properties?.worktreeOrder?.items?.description).toContain('checkout path');
    expect(project?.properties).not.toHaveProperty('push');
    expect(buttons).toMatchObject({ label: 'Button overrides', default: {}, description: expect.stringContaining('same text') });
    expect(buttons?.properties?.pullRequest).toMatchObject({ label: 'Pull request', default: [] });
    expect(buttons?.properties?.pullRequest?.description).toBeUndefined();
    expect(JSON.stringify(applicationSettingsSchema())).not.toContain('Buttons appear in this order.');
    expect(button?.properties?.text?.label).toBe('Button text');
    expect(button?.properties?.icon?.description).toContain('SVG path data');
    expect(button?.properties?.icon).toMatchObject({ optional: true, placeholder: 'No icon' });
    // keep the split group context out of individual slot labels
    const splitLabels = ['Agent', 'Terminal', 'Note', 'Browser', 'Files', 'Code', 'Review', 'Stack', 'Settings'];
    expect(Object.values(buttons?.properties?.splits?.properties ?? {}).map(slot => slot.label)).toEqual(splitLabels);
    expect(Object.values(applicationSettingsSchema().properties?.buttons?.properties?.splits?.properties ?? {}).map(slot => slot.label)).toEqual(splitLabels);
    expect(button?.properties?.action?.variants?.map(variant => variant.label)).toEqual(['Shell command', 'Agent prompt']);
    expect(button?.properties?.action?.variants?.find(variant => variant.label === 'Agent prompt')?.properties?.agentPrompt).toMatchObject({ multiline: true });
  });

  // retain raw preview compatibility outside the structured Project editor
  it('keeps project hostname and port in the validator-derived raw schema', () => {
    const project = settingsSchema(sourceSchema).properties?.projects?.items;
    const override = project?.properties?.worktreeOverrides?.items;

    expect(project?.properties).toEqual(expect.objectContaining({ hostname: expect.any(Object), port: expect.any(Object) }));
    expect(override?.properties).toEqual(expect.objectContaining({ hostname: expect.any(Object), port: expect.any(Object) }));
  });
});
