import { expect, test } from '@playwright/test';
import type { SettingsSchema, SettingsSource } from '../src/settings/contracts.js';
import { agentEnvironmentKeysForAdapter, agentEnvironmentOwnerForKey } from '../src/settings/environment-fields.js';
import { buildSettingsSearchIndex, type SettingsSearchPage, type SettingsSearchResult } from '../src/settings/search-index.js';
import { applicationSettingsSchema } from '../../server/src/settings/schema.js';

// create one complete source descriptor around focused metadata
const source = (id: string, format: SettingsSource['format'], schema?: SettingsSchema, value?: unknown, fields?: SettingsSource['fields']): SettingsSource => ({
  id,
  label: id === 'app' ? 'Application configuration' : id === 'env' ? 'Environment & keys' : id === 'installation' ? 'Installation' : id === 'wrapper' ? 'Installation wrapper' : id,
  format,
  exists: true,
  writable: true,
  protected: false,
  tracked: false,
  revisionId: `${id}-revision`,
  apply: 'rac-restart',
  ...(schema === undefined ? {} : { schema }),
  ...(value === undefined ? {} : { value }),
  ...(fields === undefined ? {} : { fields })
});

const pages: SettingsSearchPage[] = [
  { id: 'browser', label: 'This browser', group: 'Console' },
  { id: 'voice', label: 'Voice', group: 'Console' },
  { id: 'google-calendar', label: 'Google Calendar', group: 'Integrations' },
  { id: 'keyboard', label: 'Keyboard shortcuts', group: 'Console' },
  { id: 'app', label: 'Application', group: 'Application' },
  { id: 'interface', label: 'Interface', group: 'Application' },
  { id: 'agents', label: 'Agents', group: 'Integrations' },
  { id: 'projects', label: 'Projects', group: 'Application' },
  { id: 'reviews', label: 'Reviews', group: 'Application' },
  { id: 'tmux', label: 'TMUX', group: 'Application' },
  { id: 'storage', label: 'Storage', group: 'Application' },
  { id: 'env', label: 'Environment & keys', group: 'Application' },
  { id: 'installation', label: 'Installation', group: 'Application' },
  { id: 'cloudflare', label: 'Cloudflare', group: 'Deployment' }
];

// build with safe empty option defaults
const build = (sources: SettingsSource[], options: Partial<Parameters<typeof buildSettingsSearchIndex>[2]> = {}): SettingsSearchResult[] => buildSettingsSearchIndex(pages, sources, {
  excludedEnvironmentKeys: new Set(),
  rawSourceIds: new Set(),
  ...options
});

// locate one exact field target without relying on result order
const fieldAt = (results: SettingsSearchResult[], pageId: string, path: string[]): SettingsSearchResult | undefined => results.find(result => result.kind === 'field'
  && result.pageId === pageId
  && result.path?.length === path.length
  && path.every((part, index) => result.path?.[index] === part));

// prove that indexing never serializes scalar values or source bytes
test('indexes metadata without scalar values, content, or protected markers', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      publicOrigin: { type: 'string', label: 'Public origin', description: 'Public address used by RAC.', placeholder: 'https://private-placeholder.example.test (from host configuration)' },
      apiKey: { type: 'string', label: 'API key', protected: true }
    }
  }, {
    publicOrigin: 'https://private-value.example.test',
    apiKey: { __racProtected: true, present: true, hasValue: true }
  });
  application.content = 'PRIVATE_SOURCE_CONTENT';
  const environment = source('env', 'env', undefined, undefined, [{
    key: 'CUSTOM_SECRET',
    value: 'PRIVATE_ENV_VALUE',
    protected: true,
    present: true,
    hasValue: true,
    apply: 'rac-restart',
    description: 'Credential consumed by a custom process.'
  }]);

  const serialized = JSON.stringify(build([application, environment]));
  expect(serialized).toContain('Public origin');
  expect(serialized).toContain('Public address used by RAC.');
  expect(serialized).not.toContain('private-placeholder.example.test');
  expect(serialized).toContain('CUSTOM_SECRET');
  expect(serialized).not.toContain('private-value.example.test');
  expect(serialized).not.toContain('PRIVATE_SOURCE_CONTENT');
  expect(serialized).not.toContain('PRIVATE_ENV_VALUE');
  expect(serialized).not.toContain('__racProtected');
});

// route permanent Review metadata without indexing authored prompt or model bytes
test('indexes Review descendants only while the application structured editor is active', () => {
  const schema = applicationSettingsSchema();
  const application = source('app', 'json', schema, {
    review: {
      tour: {
        agent: 'codex',
        model: 'PRIVATE_TOUR_MODEL',
        prompt: 'PRIVATE_TOUR_PROMPT'
      },
      presets: [{
        id: 'private-preset-id',
        label: 'PRIVATE_PRESET_LABEL',
        agent: 'claude',
        model: 'PRIVATE_PRESET_MODEL',
        prompt: 'PRIVATE_PRESET_PROMPT'
      }],
      defaultPreset: 'private-preset-id'
    }
  });
  application.content = 'PRIVATE_REVIEW_SOURCE';
  const results = build([application]);

  expect(fieldAt(results, 'reviews', ['review', 'tour', 'prompt'])).toBeDefined();
  expect(fieldAt(results, 'reviews', ['review', 'presets', '0', 'prompt'])).toBeDefined();
  expect(fieldAt(results, 'reviews', ['review', 'defaultPreset'])).toBeDefined();
  const serialized = JSON.stringify(results);
  expect(serialized).not.toContain('PRIVATE_TOUR_MODEL');
  expect(serialized).not.toContain('PRIVATE_TOUR_PROMPT');
  expect(serialized).not.toContain('PRIVATE_PRESET_LABEL');
  expect(serialized).not.toContain('PRIVATE_PRESET_MODEL');
  expect(serialized).not.toContain('PRIVATE_PRESET_PROMPT');
  expect(serialized).not.toContain('PRIVATE_REVIEW_SOURCE');

  const raw = build([application], { rawSourceIds: new Set(['app']) });
  expect(raw.find(result => result.kind === 'page' && result.pageId === 'reviews')).toBeDefined();
  expect(raw.filter(result => result.kind === 'field' && result.pageId === 'reviews')).toEqual([]);
});

// route client preferences and application buttons to their dedicated pages
test('indexes Interface and Projects controls under their owning pages', () => {
  const application = source('app', 'json', applicationSettingsSchema(), {
    buttons: {
      pullRequest: [{
        text: 'PRIVATE_BUTTON_TEXT',
        color: 'mauve',
        style: 'solid',
        action: { agentPrompt: 'PRIVATE_BUTTON_PROMPT' }
      }]
    }
  });
  const results = build([application]);

  expect(fieldAt(results, 'browser', ['deviceName'])).toBeDefined();
  expect(fieldAt(results, 'interface', ['terminalFontSize'])).toBeDefined();
  expect(fieldAt(results, 'interface', ['colorTheme'])).toBeDefined();
  expect(fieldAt(results, 'interface', ['reducedMotion'])).toBeDefined();
  expect(fieldAt(results, 'interface', ['flyoutMarkers'])).toBeDefined();
  expect(fieldAt(results, 'projects', ['dynamicWorktrees'])).toBeDefined();
  expect(fieldAt(results, 'interface', ['buttons', 'pullRequest', '0', 'text'])).toBeDefined();
  expect(fieldAt(results, 'app', ['buttons', 'pullRequest', '0', 'text'])).toBeUndefined();
  expect(JSON.stringify(results)).not.toContain('PRIVATE_BUTTON_TEXT');
  expect(JSON.stringify(results)).not.toContain('PRIVATE_BUTTON_PROMPT');
});

// route calendar configuration and credentials without indexing title values
test('indexes Google Calendar fields only on the dedicated page', () => {
  const schema = applicationSettingsSchema();
  const application = source('app', 'json', schema, {
    googleCalendar: {
      enabled: false,
      titleTemplate: 'PRIVATE {worktree} TITLE',
      startMoment: 'work_started',
      endMoment: 'work_finished'
    }
  });
  const environment = source('env', 'env', undefined, undefined, [
    'RAC_GOOGLE_CALENDAR_CLIENT_ID',
    'RAC_GOOGLE_CALENDAR_CLIENT_SECRET',
    'RAC_GOOGLE_CALENDAR_TOKEN_KEY',
    'RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY'
  ].map(key => ({ key, protected: true, present: true, hasValue: true, apply: 'rac-restart' as const, description: `${key} setup value.` })));
  const results = build([application, environment]);

  expect(fieldAt(results, 'google-calendar', ['googleCalendar', 'enabled'])?.label).toBe('Enable Google Calendar');
  expect(fieldAt(results, 'google-calendar', ['googleCalendar', 'enabled'])?.breadcrumbs).toEqual(['Integrations', 'Google Calendar']);
  expect(fieldAt(results, 'google-calendar', ['googleCalendar', 'titleTemplate'])?.label).toBe('Event title template');
  expect(fieldAt(results, 'google-calendar', ['googleCalendar', 'startMoment'])?.label).toBe('Start moment');
  expect(fieldAt(results, 'google-calendar', ['googleCalendar', 'endMoment'])?.label).toBe('End moment');
  expect(fieldAt(results, 'app', ['googleCalendar', 'titleTemplate'])).toBeUndefined();
  expect(fieldAt(results, 'google-calendar', ['RAC_GOOGLE_CALENDAR_TOKEN_KEY'])).toBeDefined();
  expect(fieldAt(results, 'env', ['RAC_GOOGLE_CALENDAR_TOKEN_KEY'])).toBeUndefined();
  const serialized = JSON.stringify(results);
  expect(serialized).not.toContain('PRIVATE {worktree} TITLE');
  expect(serialized).not.toContain('Timely');
  expect(serialized).not.toMatch(/offset/iu);
});

// normalize product acronyms only in search metadata, never canonical values
test('capitalizes MCP and OMX search labels and breadcrumbs without indexing their values', () => {
  const schema = applicationSettingsSchema();
  const application = source('app', 'json', schema, {
    adapters: {
      omx: {
        program: '/private/tools/omx',
        setup: 'mcp omx'
      }
    },
    integrations: {
      mcp: {
        readEnabled: true,
        writeEnabled: false,
        dangerousEnabled: false
      }
    }
  });
  const results = build([application]);
  const readEnabled = fieldAt(results, 'app', ['integrations', 'mcp', 'readEnabled']);
  const program = fieldAt(results, 'agents', ['adapters', 'omx', 'program']);

  expect(readEnabled?.breadcrumbs).toContain('MCP');
  expect(program?.label).toBe('Program');
  expect(program?.breadcrumbs).toContain('OMX');
  const serialized = JSON.stringify(results);
  expect(serialized).not.toContain('/private/tools/omx');
  expect(serialized).not.toContain('mcp omx');
});

// mirror the permanent adapter collections and all-or-nothing update controls
test('indexes permanent lifecycle, Args, Environment & keys, and Updates controls for configured adapters', () => {
  const application = source('app', 'json', applicationSettingsSchema(), {
    adapters: {
      codex: { program: '/private/tools/codex' }
    }
  });
  const results = build([application]);

  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'setup'])?.label).toBe('Setup');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'teardown'])?.label).toBe('Teardown');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'args'])?.label).toBe('Args');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'env'])?.label).toBe('Environment & keys');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'updates'])?.label).toBe('Updates');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'updates', 'current'])?.label).toBe('Get current version command');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'updates', 'latest'])?.label).toBe('Get latest version command');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'updates', 'run'])?.label).toBe('Update command');
  expect(fieldAt(results, 'agents', ['adapters', 'claude', 'setup'])).toBeUndefined();
  expect(fieldAt(results, 'agents', ['adapters', 'claude', 'teardown'])).toBeUndefined();
  expect(fieldAt(results, 'agents', ['adapters', 'claude', 'args'])).toBeUndefined();
  expect(JSON.stringify(results)).not.toContain('/private/tools/codex');
});

// ignore removed federation metadata regardless of its legacy saved value
for (const enabled of [false, true]) {
  test(`omits legacy Multi instance metadata with enabled=${enabled}`, () => {
    const application = source('app', 'json', {
      type: 'object',
      properties: {
        integrations: {
          type: 'object',
          label: 'Integrations',
          properties: {
            multiInstance: {
              type: 'object',
              label: 'Multi instance',
              description: 'Legacy federation setting from generated metadata.',
              properties: {
                enabled: { type: 'boolean', label: 'Enable multi instance' }
              }
            },
            mcp: {
              type: 'object',
              label: 'Mcp',
              properties: {
                endpoint: { type: 'string', label: 'Mcp endpoint' }
              }
            },
            realtime: {
              type: 'object',
              label: 'Voice configuration',
              properties: {
                enabled: { type: 'boolean', label: 'Enable voice' },
                writeToolsEnabled: { type: 'boolean', label: 'Write tools' }
              }
            }
          }
        },
        remoteServers: {
          type: 'array',
          label: 'Remote servers',
          items: {
            type: 'object',
            label: 'Remote server',
            properties: {
              url: { type: 'string', label: 'URL' }
            }
          }
        }
      }
    }, {
      integrations: {
        multiInstance: { enabled },
        mcp: { endpoint: 'https://mcp.example.test' },
        realtime: { enabled: false, writeToolsEnabled: false }
      },
      remoteServers: enabled ? [{ url: 'https://remote.example.test' }] : []
    });
    const results = build([application]);
    const legacyResults = results.filter(result => result.path?.[0] === 'integrations' && result.path?.[1] === 'multiInstance');

    expect(legacyResults).toEqual([]);
    expect(JSON.stringify(results)).not.toContain('Legacy federation setting from generated metadata.');
    expect(fieldAt(results, 'app', ['integrations', 'mcp', 'endpoint'])?.label).toBe('Mcp endpoint');
    expect(fieldAt(results, 'app', ['remoteServers'])).toBeDefined();
    expect(fieldAt(results, 'voice', ['integrations', 'realtime', 'writeToolsEnabled'])?.label).toBe('Write tools');
  });
}

// index host overrides only when Docker mode is authoritative
for (const installationKind of ['compose', 'systemd', undefined] as const) {
  test(`limits Project Host path search to Docker for ${installationKind ?? 'unknown'} installations`, () => {
    const application = source('app', 'json', applicationSettingsSchema(), {
      projects: [{ id: 'one', path: '/private/project/path', hostPath: '/private/host/path' }]
    });
    // source locks must not expose controls hidden by the installation mode
    for (const rawSourceIds of [new Set<string>(), new Set(['app'])]) {
      const results = build([application], { installationKind, rawSourceIds });
      expect(fieldAt(results, 'projects', ['projects', '0', 'path'])).toBeDefined();
      expect(fieldAt(results, 'projects', ['projects', '0', 'hostPath']) !== undefined).toBe(installationKind === 'compose');
      expect(JSON.stringify(results)).not.toContain('/private/project/path');
      expect(JSON.stringify(results)).not.toContain('/private/host/path');
    }
  });
}

// omit file-only preview selectors even when their saved values remain present
test('omits Project and Worktree hostname and port search results', () => {
  const results = build([source('app', 'json', applicationSettingsSchema(), {
    projects: [{ id: 'one', path: '/tmp/one', hostname: 'one.example.test', port: 3000, worktreeOverrides: [{ path: 'feature', hostname: 'feature.example.test', port: 3001 }] }]
  })]);
  expect(fieldAt(results, 'projects', ['projects', '0', 'path'])).toBeDefined();
  // check both the project and per-checkout selectors
  for (const prefix of [['projects', '0'], ['projects', '0', 'worktreeOverrides', '0']]) {
    expect(fieldAt(results, 'projects', [...prefix, 'hostname'])).toBeUndefined();
    expect(fieldAt(results, 'projects', [...prefix, 'port'])).toBeUndefined();
  }
});

// cover dedicated routing and aliases for fields hidden from the environment page
test('routes dedicated application and environment fields with environment aliases', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      icon: { type: 'enum', options: ['terminal', 'heart'] },
      listen: { type: 'object', properties: { host: { type: 'string' }, port: { type: 'number' } } },
      scratchDirectory: { type: 'string', optional: true, label: 'Scratch directory' },
      adapters: { type: 'object', properties: {
        codex: { type: 'object', properties: { program: { type: 'string' } } },
        claude: { type: 'object', properties: { program: { type: 'string' } } }
      } },
      tmux: { type: 'object', properties: { pollIntervalMs: { type: 'number' } } },
      keys: { type: 'record', items: { type: 'record', items: { type: 'string' } } },
      projects: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
      integrations: { type: 'object', properties: { realtime: { type: 'object', properties: {
        enabled: { type: 'boolean' },
        name: { type: 'string' },
        context: { type: 'string' },
        writeToolsEnabled: { type: 'boolean', label: 'Write tools' }
      } } } }
    }
  }, {
    icon: 'heart',
    listen: { host: '127.0.0.1', port: 8787 },
    scratchDirectory: '/private/scratch',
    adapters: { codex: { program: '/bin/codex' }, claude: { program: '/bin/claude' } },
    tmux: { pollIntervalMs: 500 },
    projects: [],
    integrations: { realtime: { enabled: true, name: 'Davo', context: 'private context', writeToolsEnabled: false } }
  });
  const environment = source('env', 'env', undefined, undefined, [
    { key: 'RAC_TMUX_BIN', protected: false, present: false, apply: 'rac-restart', description: 'tmux executable.' },
    { key: 'RAC_LISTEN_HOST', protected: false, present: false, apply: 'rac-restart', description: 'listener override.' },
    { key: 'CUSTOM_SETTING', protected: false, present: true, value: 'private scalar', apply: 'rac-restart', description: 'custom value.' }
  ]);
  const wrapper = source('wrapper', 'wrapper');
  const results = build([application, environment, wrapper], {
    installationKind: 'compose',
    excludedEnvironmentKeys: new Set(['RAC_LISTEN_HOST'])
  });

  expect(fieldAt(results, 'app', ['icon'])?.label).toBe('Server icon');
  expect(fieldAt(results, 'voice', ['integrations', 'realtime', 'enabled'])?.label).toBe('Enable Davo');
  expect(fieldAt(results, 'voice', ['integrations', 'realtime', 'writeToolsEnabled'])?.label).toBe('Write tools');
  expect(fieldAt(results, 'voice', ['integrations', 'realtime', 'writeToolsEnabled'])?.breadcrumbs).toEqual(['Console', 'Voice']);
  expect(fieldAt(results, 'keyboard', ['keys'])?.label).toBe('Key tables');
  expect(fieldAt(results, 'tmux', ['tmux', 'pollIntervalMs'])?.label).toBe('Polling interval (ms)');
  expect(fieldAt(results, 'tmux', ['RAC_TMUX_BIN'])).toBeDefined();
  expect(fieldAt(results, 'tmux', ['wrapper'])).toBeDefined();
  expect(fieldAt(results, 'env', ['CUSTOM_SETTING'])).toBeDefined();
  expect(fieldAt(results, 'env', ['RAC_LISTEN_HOST'])).toBeUndefined();
  expect(fieldAt(results, 'app', ['listen', 'host'])?.keywords).toContain('RAC_LISTEN_HOST');
  expect(fieldAt(results, 'app', ['listen', 'port'])?.keywords).toContain('RAC_LISTEN_PORT');
  expect(fieldAt(results, 'storage', ['scratchDirectory'])?.label).toBe('Scratch directory');
  expect(fieldAt(results, 'app', ['scratchDirectory'])).toBeUndefined();
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'program'])).toBeDefined();
  expect(fieldAt(results, 'agents', ['adapters', 'claude', 'program'])).toBeDefined();
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'program'])?.keywords).not.toContain('RAC_CODEX_BIN');
  expect(fieldAt(results, 'agents', ['adapters', 'claude', 'program'])?.keywords).not.toContain('RAC_CLAUDE_BIN');
  expect(fieldAt(results, 'app', ['adapters'])).toBeUndefined();
  expect(JSON.stringify(results)).not.toContain('/bin/codex');
  expect(JSON.stringify(results)).not.toContain('/bin/claude');
  expect(JSON.stringify(results)).not.toContain('/private/scratch');
});

// retain optional adapter add controls while an application whole-source draft locks them
test('routes empty optional adapter controls to Agents during application whole-source mode', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      adapters: {
        type: 'object',
        default: {},
        properties: {
          codex: { type: 'object', optional: true, properties: {
            program: { type: 'string' },
            env: { type: 'record', optional: true, label: 'Environment & keys', items: { type: 'string' } }
          } },
          pi: { type: 'object', optional: true, properties: { program: { type: 'string' } } },
          opencode: { type: 'object', optional: true, properties: { program: { type: 'string' } } }
        }
      }
    }
  }, { adapters: {} });
  const results = build([application], { rawSourceIds: new Set(['app']) });

  expect(fieldAt(results, 'agents', ['adapters'])).toBeDefined();
  expect(fieldAt(results, 'agents', ['adapters', 'codex'])).toBeDefined();
  expect(fieldAt(results, 'agents', ['adapters', 'pi'])).toBeDefined();
  expect(fieldAt(results, 'agents', ['adapters', 'opencode'])).toBeDefined();
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'program'])).toBeUndefined();
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'env'])).toBeUndefined();
  expect(fieldAt(results, 'app', ['adapters'])).toBeUndefined();
});

// retain the optional scratch add control while an application whole-source draft locks it
test('routes an absent scratch directory to Storage during application whole-source mode', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      scratchDirectory: {
        type: 'string',
        optional: true,
        label: 'Scratch directory',
        description: 'Directory used for temporary agent files.',
        placeholder: '~/'
      }
    }
  }, {});
  const results = build([application], { rawSourceIds: new Set(['app']) });

  expect(fieldAt(results, 'storage', ['scratchDirectory'])?.keywords).toContain('Directory used for temporary agent files.');
  expect(fieldAt(results, 'storage', ['scratchDirectory'])?.keywords).not.toContain('~/');
  expect(fieldAt(results, 'app', ['scratchDirectory'])).toBeUndefined();
});

// route the runtime-owned Agent environment allowlist without conflating executable overrides
test('routes Agent environment fields by installation mode without leaking source values', () => {
  const agentKeys = [
    'RAC_CODEX_BIN',
    'RAC_CLAUDE_BIN',
    'RAC_CLAUDE_CONFIG_DIR',
    'RAC_HOST_CODEX_BIN',
    'RAC_OPENAI_ADMIN_KEY',
    'RAC_OPENAI_API_KEY_IDS',
    'CODEX_VERSION'
  ];
  const fields: NonNullable<SettingsSource['fields']> = agentKeys.map((key, index) => ({
    key,
    value: `PRIVATE_AGENT_VALUE_${index}`,
    protected: key.includes('KEY') && !key.endsWith('_IDS'),
    present: true,
    apply: 'rac-restart',
    description: `${key} Agent setting.`
  }));
  fields.push(
    { key: 'RAC_OPENAI_API_KEY', value: 'PRIVATE_VOICE_VALUE', protected: true, present: true, apply: 'rac-restart', description: 'Voice API credential.' },
    { key: 'CUSTOM_SETTING', value: 'PRIVATE_CUSTOM_VALUE', protected: false, present: true, apply: 'rac-restart', description: 'Custom deployment setting.' }
  );
  const application = source('app', 'json', applicationSettingsSchema(), {
    adapters: {
      codex: { program: '/private/tools/codex' },
      claude: { program: '/private/tools/claude' }
    }
  });
  const environment = source('env', 'env', undefined, undefined, fields);
  environment.content = 'PRIVATE_AGENT_SOURCE';
  const compose = build([application, environment], { installationKind: 'compose', excludedEnvironmentKeys: new Set(agentKeys) });
  const agentFields = compose.filter(result => result.kind === 'field' && result.pageId === 'agents' && agentKeys.includes(result.path?.[0] ?? ''));

  expect(agentFields.map(result => result.path?.[0])).toEqual(agentKeys);
  // keep every environment-owned field at its original one-segment path
  for (const key of agentKeys) {
    expect(fieldAt(compose, 'agents', [key])?.keywords).toContain(`${key} Agent setting.`);
    expect(fieldAt(compose, 'env', [key])).toBeUndefined();
  }
  // route codex-owned fields into codex env
  for (const key of agentEnvironmentKeysForAdapter('codex', 'compose')) expect(fieldAt(compose, 'agents', [key])?.breadcrumbs).toEqual(['Integrations', 'Agents', 'Codex', 'Environment & keys']);
  // route claude-owned fields into claude env
  for (const key of agentEnvironmentKeysForAdapter('claude', 'compose')) expect(fieldAt(compose, 'agents', [key])?.breadcrumbs).toEqual(['Integrations', 'Agents', 'Claude', 'Environment & keys']);
  expect(agentEnvironmentOwnerForKey('CODEX_VERSION', 'compose')).toBe('codex');
  expect(agentEnvironmentOwnerForKey('CODEX_VERSION', 'systemd')).toBeUndefined();
  expect(agentEnvironmentKeysForAdapter('omx', 'compose').size).toBe(0);
  expect(fieldAt(compose, 'voice', ['RAC_OPENAI_API_KEY'])).toBeDefined();
  expect(fieldAt(compose, 'agents', ['RAC_OPENAI_API_KEY'])).toBeUndefined();
  expect(fieldAt(compose, 'env', ['CUSTOM_SETTING'])).toBeDefined();
  const serialized = JSON.stringify(compose);
  expect(serialized).not.toContain('PRIVATE_AGENT_VALUE');
  expect(serialized).not.toContain('PRIVATE_VOICE_VALUE');
  expect(serialized).not.toContain('PRIVATE_CUSTOM_VALUE');
  expect(serialized).not.toContain('PRIVATE_AGENT_SOURCE');

  const nativeRaw = build([application, environment], { installationKind: 'systemd', rawSourceIds: new Set(['env']) });
  // keep portable Agent and Voice editors reachable while general raw editing locks them
  for (const key of agentKeys.slice(0, -1)) expect(fieldAt(nativeRaw, 'agents', [key])).toBeDefined();
  expect(fieldAt(nativeRaw, 'agents', ['CODEX_VERSION'])).toBeUndefined();
  expect(fieldAt(nativeRaw, 'env', ['CODEX_VERSION'])).toBeUndefined();
  expect(fieldAt(nativeRaw, 'voice', ['RAC_OPENAI_API_KEY'])).toBeDefined();
  expect(fieldAt(nativeRaw, 'env', ['CUSTOM_SETTING'])).toBeUndefined();

  const absent = source('app', 'json', applicationSettingsSchema(), {
    adapters: { codex: { program: '/private/tools/codex' } }
  });
  const codexOnly = build([absent, environment], { installationKind: 'compose' });
  for (const key of agentEnvironmentKeysForAdapter('codex', 'compose')) expect(fieldAt(codexOnly, 'agents', [key])).toBeDefined();
  for (const key of agentEnvironmentKeysForAdapter('claude', 'compose')) expect(fieldAt(codexOnly, 'agents', [key])).toBeUndefined();

  for (const unavailable of [
    build([environment], { installationKind: 'compose' }),
    build([source('app', 'json', applicationSettingsSchema()), environment], { installationKind: 'compose' }),
    build([source('app', 'json', applicationSettingsSchema(), { adapters: {} }), environment], { installationKind: 'compose' })
  ]) {
    for (const key of agentKeys) expect(fieldAt(unavailable, 'agents', [key])).toBeUndefined();
  }
});

// retain one flat adapter environment control without indexing private record values
test('indexes adapter Environment & keys records only for configured adapters', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      adapters: {
        type: 'object',
        default: {},
        properties: {
          codex: { type: 'object', optional: true, label: 'Codex', properties: {
            program: { type: 'string', label: 'Program' },
            env: { type: 'record', optional: true, label: 'Environment & keys', items: { type: 'string', protected: true } }
          } },
          claude: { type: 'object', optional: true, label: 'Claude', properties: {
            program: { type: 'string', label: 'Program' },
            env: { type: 'record', optional: true, label: 'Environment & keys', items: { type: 'string' } }
          } },
          omx: { type: 'object', optional: true, label: 'OMX', properties: {
            env: { type: 'record', optional: true, label: 'Environment & keys', items: { type: 'string' } }
          } }
        }
      }
    }
  }, {
    adapters: {
      codex: { program: 'PRIVATE_CODEX_PROGRAM', env: { PRIVATE_CODEX_ENV: 'PRIVATE_CODEX_VALUE' } },
      claude: { program: 'PRIVATE_CLAUDE_PROGRAM' }
    }
  });
  const results = build([application]);

  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'env'])?.label).toBe('Environment & keys');
  expect(fieldAt(results, 'agents', ['adapters', 'codex', 'env', 'PRIVATE_CODEX_ENV'])).toBeDefined();
  expect(fieldAt(results, 'agents', ['adapters', 'claude', 'env'])?.label).toBe('Environment & keys');
  expect(fieldAt(results, 'agents', ['adapters', 'claude', 'env', 'PRIVATE_CLAUDE_ENV'])).toBeUndefined();
  expect(fieldAt(results, 'agents', ['adapters', 'omx', 'env'])).toBeUndefined();
  expect(JSON.stringify(results)).not.toContain('PRIVATE_CODEX_VALUE');
  expect(JSON.stringify(results)).not.toContain('PRIVATE_CODEX_PROGRAM');
  expect(JSON.stringify(results)).not.toContain('PRIVATE_CLAUDE_PROGRAM');
});

// route the runtime-owned Storage environment allowlist without indexing file paths
test('routes Storage environment fields through environment whole-source mode without leaking values', () => {
  const storageKeys = [
    'RAC_ADAPTER_FILES_DIR',
    'RAC_SERVER_ADMIN_STATUS_DIR',
    'RAC_TEMP_PREVIEWS_DIR',
    'RAC_DEVICE_NAMES_FILE',
    'RAC_CONSOLE_NAMED_FILE',
    'RAC_WORKTREES_FILE',
    'RAC_SAVED_PROMPTS_FILE',
    'RAC_PROMPT_HISTORY_FILE',
    'RAC_QUEUED_PROMPTS_FILE',
    'RAC_NOTES_FILE',
    'RAC_REVIEW_TOURS_FILE',
    'RAC_PUSH_SUBSCRIPTIONS_FILE',
    'RAC_FILE_FAVORITES_FILE',
    'RAC_FILE_OPERATION_JOURNAL',
    'RAC_INTEGRATION_AUTH_FILE',
    'RAC_INTEGRATION_STATE_FILE',
    'RAC_INTEGRATION_AUDIT_FILE',
    'RAC_BOOKMARKS_FILE'
  ];
  const fields: NonNullable<SettingsSource['fields']> = storageKeys.map((key, index) => ({
    key,
    value: `/private/storage/${index}`,
    protected: false,
    present: true,
    apply: 'rac-restart',
    description: `${key} storage location.`
  }));
  fields.push(
    { key: 'RAC_CODEX_BIN', value: '/private/codex', protected: false, present: true, apply: 'rac-restart', description: 'Codex executable override.' },
    { key: 'RAC_OPENAI_API_KEY', value: 'PRIVATE_VOICE_VALUE', protected: true, present: true, apply: 'rac-restart', description: 'Voice API credential.' },
    { key: 'CUSTOM_SETTING', value: 'PRIVATE_CUSTOM_VALUE', protected: false, present: true, apply: 'rac-restart', description: 'Custom deployment setting.' }
  );
  const environment = source('env', 'env', undefined, undefined, fields);
  environment.content = 'PRIVATE_STORAGE_SOURCE';
  const application = source('app', 'json', applicationSettingsSchema(), {
    adapters: { codex: { program: '/private/tools/codex' } }
  });
  const results = build([application, environment], { installationKind: 'compose', rawSourceIds: new Set(['env']) });
  const storageFields = results.filter(result => result.kind === 'field' && result.pageId === 'storage' && result.breadcrumbs.at(-1) === 'Environment');

  expect(storageFields.map(result => result.path?.[0])).toEqual(storageKeys);
  // retain exact environment identities on the dedicated page
  for (const key of storageKeys) {
    expect(fieldAt(results, 'storage', [key])?.keywords).toContain(`${key} storage location.`);
    expect(fieldAt(results, 'env', [key])).toBeUndefined();
  }
  expect(fieldAt(results, 'agents', ['RAC_ADAPTER_FILES_DIR'])).toBeUndefined();
  expect(fieldAt(results, 'agents', ['RAC_CODEX_BIN'])).toBeDefined();
  expect(fieldAt(results, 'voice', ['RAC_OPENAI_API_KEY'])).toBeDefined();
  expect(fieldAt(results, 'env', ['CUSTOM_SETTING'])).toBeUndefined();
  const serialized = JSON.stringify(results);
  expect(serialized).not.toContain('/private/storage/');
  expect(serialized).not.toContain('/private/codex');
  expect(serialized).not.toContain('PRIVATE_VOICE_VALUE');
  expect(serialized).not.toContain('PRIVATE_CUSTOM_VALUE');
  expect(serialized).not.toContain('PRIVATE_STORAGE_SOURCE');
});

// route only runtime-consumed voice variables without indexing their scalar bytes
test('routes the exact voice environment allowlist independently of application visibility', () => {
  const environment = source('env', 'env', undefined, undefined, [
    { key: 'RAC_OPENAI_API_KEY', value: 'PRIVATE_VOICE_API_KEY', protected: true, present: true, hasValue: true, apply: 'rac-restart', description: 'OpenAI credential for voice sessions.' },
    { key: 'RAC_REALTIME_MCP_TOKEN', value: 'PRIVATE_VOICE_MCP_TOKEN', protected: true, present: true, hasValue: true, apply: 'rac-restart', description: 'Realtime bridge credential for RAC tools.' },
    { key: 'RAC_OPENAI_ADMIN_KEY', value: 'PRIVATE_ADMIN_KEY', protected: true, present: true, hasValue: true, apply: 'rac-restart', description: 'OpenAI administration credential.' },
    { key: 'RAC_OPENAI_API_KEY_IDS', value: 'PRIVATE_KEY_ID_MAP', protected: false, present: true, apply: 'rac-restart', description: 'OpenAI key identifier mapping.' }
  ]);
  const withoutApplication = build([environment], { excludedEnvironmentKeys: new Set(['RAC_OPENAI_API_KEY', 'RAC_REALTIME_MCP_TOKEN']) });
  const disabledApplication = source('app', 'json', { type: 'object', properties: {
    integrations: { type: 'object', properties: { realtime: { type: 'object', properties: { enabled: { type: 'boolean' } } } } }
  } }, { integrations: { realtime: { enabled: false } } });
  const withRawDisabledApplication = build([disabledApplication, environment], {
    excludedEnvironmentKeys: new Set(['RAC_OPENAI_API_KEY', 'RAC_REALTIME_MCP_TOKEN']),
    rawSourceIds: new Set(['app'])
  });

  // prove routing remains independent from application schema availability
  for (const results of [withoutApplication, withRawDisabledApplication]) {
    const voiceFields = results.filter(result => result.kind === 'field' && result.pageId === 'voice' && result.breadcrumbs.at(-1) === 'Environment & keys');
    expect(voiceFields.map(result => result.path?.[0])).toEqual(['RAC_OPENAI_API_KEY', 'RAC_REALTIME_MCP_TOKEN']);
    expect(fieldAt(results, 'voice', ['RAC_OPENAI_API_KEY'])?.keywords).toContain('OpenAI credential for voice sessions.');
    expect(fieldAt(results, 'voice', ['RAC_REALTIME_MCP_TOKEN'])?.keywords).toContain('Realtime bridge credential for RAC tools.');
    expect(fieldAt(results, 'env', ['RAC_OPENAI_API_KEY'])).toBeUndefined();
    expect(fieldAt(results, 'env', ['RAC_REALTIME_MCP_TOKEN'])).toBeUndefined();
    expect(fieldAt(results, 'agents', ['RAC_OPENAI_ADMIN_KEY'])).toBeUndefined();
    expect(fieldAt(results, 'agents', ['RAC_OPENAI_API_KEY_IDS'])).toBeUndefined();
    expect(fieldAt(results, 'env', ['RAC_OPENAI_ADMIN_KEY'])).toBeUndefined();
    expect(fieldAt(results, 'env', ['RAC_OPENAI_API_KEY_IDS'])).toBeUndefined();
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('PRIVATE_VOICE_API_KEY');
    expect(serialized).not.toContain('PRIVATE_VOICE_MCP_TOKEN');
    expect(serialized).not.toContain('PRIVATE_ADMIN_KEY');
    expect(serialized).not.toContain('PRIVATE_KEY_ID_MAP');
  }
});

// keep dedicated disabled editors reachable while whole-source environment repair is active
test('retains voice and TMUX environment search routes in environment whole-source mode', () => {
  const environment = source('env', 'env', undefined, undefined, [
    { key: 'RAC_OPENAI_API_KEY', protected: true, present: false, apply: 'rac-restart', description: 'OpenAI credential for voice sessions.' },
    { key: 'RAC_REALTIME_MCP_TOKEN', protected: true, present: false, apply: 'rac-restart', description: 'Realtime bridge credential for RAC tools.' },
    { key: 'RAC_TMUX_BIN', protected: false, present: false, apply: 'rac-restart', description: 'tmux executable.' },
    { key: 'RAC_OPENAI_ADMIN_KEY', protected: true, present: false, apply: 'rac-restart', description: 'OpenAI administration credential.' }
  ]);
  const results = build([environment], {
    installationKind: 'compose',
    excludedEnvironmentKeys: new Set(['RAC_OPENAI_API_KEY', 'RAC_REALTIME_MCP_TOKEN', 'RAC_TMUX_BIN']),
    rawSourceIds: new Set(['env'])
  });

  expect(fieldAt(results, 'voice', ['RAC_OPENAI_API_KEY'])).toBeDefined();
  expect(fieldAt(results, 'voice', ['RAC_REALTIME_MCP_TOKEN'])).toBeDefined();
  expect(fieldAt(results, 'tmux', ['RAC_TMUX_BIN'])).toBeDefined();
  expect(fieldAt(results, 'env', ['RAC_OPENAI_ADMIN_KEY'])).toBeUndefined();
});

// preserve the optional add row without indexing controls that are not rendered
test('stops at an absent optional container', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      optionalGroup: {
        type: 'object',
        optional: true,
        label: 'Optional group',
        properties: { nestedValue: { type: 'string', label: 'Nested value' } }
      }
    }
  }, {});
  const results = build([application]);

  expect(fieldAt(results, 'app', ['optionalGroup'])).toBeDefined();
  expect(fieldAt(results, 'app', ['optionalGroup', 'nestedValue'])).toBeUndefined();
});

// project rows deliberately render all declared fields as blank-capable controls
test('indexes blank project fields and nested defaults for existing project rows', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      projects: {
        type: 'array',
        label: 'Projects',
        items: {
          type: 'object',
          label: 'Project',
          properties: {
            id: { type: 'string', label: 'ID' },
            label: { type: 'string', optional: true, label: 'Label' },
            commands: {
              type: 'object',
              optional: true,
              label: 'Commands',
              properties: { start: { type: 'string', optional: true, label: 'Start' } }
            }
          }
        }
      }
    }
  }, { projects: [{ id: 'private-project-id' }] });
  const results = build([application]);

  expect(fieldAt(results, 'projects', ['projects', '0'])?.label).toBe('Project 1');
  expect(fieldAt(results, 'projects', ['projects', '0', 'id'])).toBeDefined();
  expect(fieldAt(results, 'projects', ['projects', '0', 'label'])).toBeDefined();
  expect(fieldAt(results, 'projects', ['projects', '0', 'commands'])).toBeDefined();
  expect(fieldAt(results, 'projects', ['projects', '0', 'commands', 'start'])).toBeDefined();
  expect(JSON.stringify(results)).not.toContain('private-project-id');
});

// sparse installation metadata still renders permanent Compose controls
test('indexes sparse compose options and only editable files after pinned rows', () => {
  const installation = source('installation', 'installation', {
    type: 'object',
    properties: {
      version: { type: 'number' },
      host: { type: 'object', optional: true, properties: { checkout: { type: 'string' } } },
      compose: { type: 'object', optional: true, properties: {
        projectDirectory: { type: 'string' },
        projectName: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        envFiles: { type: 'array', items: { type: 'string' } },
        profiles: { type: 'array', items: { type: 'string' } }
      } },
      native: { type: 'object', optional: true, properties: { environmentFile: { type: 'string' } } },
      sources: { type: 'object' }
    }
  }, {
    host: { checkout: '/private/checkout' },
    compose: {
      projectDirectory: '/private/checkout',
      projectName: 'private-project-name',
      files: ['/private/base.yaml', '/private/override.yaml', '/private/extra.yaml'],
      envFiles: ['/private/.env', '/private/extra.env'],
      profiles: ['private-profile']
    }
  });
  const results = build([installation], { installationKind: 'compose' });

  expect(fieldAt(results, 'installation', ['mode'])?.keywords).toContain('Docker');
  expect(fieldAt(results, 'installation', ['host', 'checkout'])).toBeDefined();
  expect(fieldAt(results, 'installation', ['compose', 'options', 'parallel'])?.keywords).toContain('COMPOSE_PARALLEL_LIMIT');
  expect(fieldAt(results, 'installation', ['compose', 'options', 'compatibility'])?.keywords).toContain('COMPOSE_COMPATIBILITY');
  expect(fieldAt(results, 'installation', ['compose', 'files'])?.keywords).toContain('COMPOSE_FILE');
  expect(fieldAt(results, 'installation', ['compose', 'projectName'])?.keywords).toContain('COMPOSE_PROJECT_NAME');
  expect(fieldAt(results, 'installation', ['compose', 'envFiles'])?.keywords).toContain('COMPOSE_ENV_FILES');
  expect(fieldAt(results, 'installation', ['compose', 'files', '0'])).toBeUndefined();
  expect(fieldAt(results, 'installation', ['compose', 'files', '1'])).toBeUndefined();
  expect(fieldAt(results, 'installation', ['compose', 'files', '2'])?.label).toBe('Compose file 3');
  expect(fieldAt(results, 'installation', ['compose', 'envFiles', '0'])).toBeUndefined();
  expect(fieldAt(results, 'installation', ['compose', 'envFiles', '1'])?.label).toBe('Environment file 2');
  expect(fieldAt(results, 'installation', ['compose', 'profiles'])).toBeUndefined();
  expect(JSON.stringify(results)).not.toContain('/private/');
  expect(JSON.stringify(results)).not.toContain('private-project-name');
  expect(JSON.stringify(results)).not.toContain('private-profile');
});

// raw editors replace their source page's typed targets
test('omits typed source fields while their raw editors are active', () => {
  const application = source('app', 'json', { type: 'object', properties: { listen: { type: 'object', properties: { host: { type: 'string' } } } } }, { listen: { host: 'private' } });
  const environment = source('env', 'env', undefined, undefined, [{ key: 'CUSTOM_SETTING', value: 'private', protected: false, present: true, apply: 'rac-restart' }]);
  const installation = source('installation', 'installation', { type: 'object', properties: { host: { type: 'object', properties: { checkout: { type: 'string' } } }, compose: { type: 'object', properties: {} } } }, { host: { checkout: '/private' }, compose: {} });
  const results = build([application, environment, installation], { rawSourceIds: new Set(['app', 'env', 'installation']) });

  expect(fieldAt(results, 'app', ['listen', 'host'])).toBeUndefined();
  expect(fieldAt(results, 'env', ['CUSTOM_SETTING'])).toBeUndefined();
  expect(fieldAt(results, 'installation', ['host', 'checkout'])).toBeUndefined();
  expect(results.find(result => result.kind === 'page' && result.pageId === 'app')).toBeDefined();
  expect(results.find(result => result.kind === 'page' && result.pageId === 'env')).toBeDefined();
  expect(results.find(result => result.kind === 'page' && result.pageId === 'installation')).toBeDefined();
  expect(fieldAt(results, 'app', ['icon'])).toBeUndefined();
});

// union indexing follows the same current-property ownership as rendering
test('indexes only the current object union branch', () => {
  const application = source('app', 'json', {
    type: 'object',
    properties: {
      choice: {
        type: 'union',
        label: 'Choice',
        variants: [
          { type: 'object', properties: { alpha: { type: 'string', label: 'Alpha' } } },
          { type: 'object', properties: { beta: { type: 'string', label: 'Beta' } } }
        ]
      }
    }
  }, { choice: { beta: 'private beta value' } });
  const results = build([application]);

  expect(fieldAt(results, 'app', ['choice', 'beta'])).toBeDefined();
  expect(fieldAt(results, 'app', ['choice', 'alpha'])).toBeUndefined();
  expect(JSON.stringify(results)).not.toContain('private beta value');
});

// native installations omit Docker-only host aliases from both settings pages
test('hides docker-only tmux environment keys for native installations', () => {
  const environment = source('env', 'env', undefined, undefined, [
    { key: 'RAC_TMUX_BIN', protected: false, present: false, apply: 'rac-restart' },
    { key: 'RAC_HOST_TMUX_DIR', protected: false, present: false, apply: 'rac-restart' },
    { key: 'RAC_HOST_TMUX_SOURCE', protected: false, present: false, apply: 'rac-restart' },
    { key: 'RAC_HOST_UNIX_SOCKETS', protected: false, present: false, apply: 'rac-restart' },
    { key: 'HOST_TMUX_DIR', protected: false, present: false, apply: 'rac-restart' },
    { key: 'HOST_TMUX_BIN', protected: false, present: false, apply: 'rac-restart' }
  ]);
  const results = build([environment], {
    installationKind: 'systemd',
    excludedEnvironmentKeys: new Set(['RAC_TMUX_BIN', 'RAC_HOST_TMUX_DIR', 'RAC_HOST_TMUX_SOURCE', 'RAC_HOST_UNIX_SOCKETS', 'HOST_TMUX_DIR', 'HOST_TMUX_BIN'])
  });

  expect(fieldAt(results, 'tmux', ['RAC_TMUX_BIN'])).toBeDefined();
  expect(fieldAt(results, 'tmux', ['RAC_HOST_TMUX_DIR'])).toBeDefined();
  expect(fieldAt(results, 'tmux', ['RAC_HOST_TMUX_SOURCE'])).toBeDefined();
  expect(fieldAt(results, 'tmux', ['RAC_HOST_UNIX_SOCKETS'])).toBeDefined();
  expect(fieldAt(results, 'tmux', ['HOST_TMUX_DIR'])).toBeUndefined();
  expect(fieldAt(results, 'tmux', ['HOST_TMUX_BIN'])).toBeUndefined();
  expect(fieldAt(results, 'env', ['HOST_TMUX_DIR'])).toBeUndefined();
  expect(fieldAt(results, 'env', ['HOST_TMUX_BIN'])).toBeUndefined();
});

// exclude forms that would require enabling a feature or replacing a tunnel
test('omits hidden voice and tunnel setup fields until their forms are visible', () => {
  const application = source('app', 'json', { type: 'object', properties: {
    integrations: { type: 'object', properties: { realtime: { type: 'object', properties: {
      enabled: { type: 'boolean' }, name: { type: 'string' }, context: { type: 'string' }
    } } } }
  } }, { integrations: { realtime: { enabled: false } } });
  const hidden = build([application]);
  expect(fieldAt(hidden, 'voice', ['integrations', 'realtime', 'enabled'])).toBeDefined();
  expect(fieldAt(hidden, 'voice', ['integrations', 'realtime', 'name'])).toBeUndefined();
  expect(fieldAt(hidden, 'voice', ['integrations', 'realtime', 'context'])).toBeUndefined();
  expect(fieldAt(hidden, 'cloudflare', ['cloudflare', 'status'])).toBeDefined();
  expect(fieldAt(hidden, 'cloudflare', ['cloudflare', 'token'])).toBeUndefined();
  expect(fieldAt(hidden, 'cloudflare', ['cloudflare', 'hostname'])).toBeUndefined();
  const visible = build([application], { voiceEnabled: true, cloudflareSetupVisible: true });
  expect(fieldAt(visible, 'voice', ['integrations', 'realtime', 'name'])).toBeDefined();
  expect(fieldAt(visible, 'cloudflare', ['cloudflare', 'token'])).toBeDefined();
  expect(fieldAt(visible, 'cloudflare', ['cloudflare', 'hostname'])).toBeDefined();
});
