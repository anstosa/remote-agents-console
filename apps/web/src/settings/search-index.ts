import { composeOptionSettings } from '../../../server/src/settings/catalog.js';
import { isProtectedValue, type SettingsSchema, type SettingsSnapshot, type SettingsSource } from './contracts.js';
import { agentEnvironmentKeys, agentEnvironmentOwnerForKey, googleCalendarEnvironmentKeys, storageEnvironmentKeys, voiceEnvironmentKeys } from './environment-fields.js';
import { tmuxEnvironmentKeysForInstallation } from './tmux-settings.js';

export type SettingsSearchPage = {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  disabled?: boolean;
};

export type SettingsSearchResult = {
  id: string;
  pageId: string;
  label: string;
  kind: 'page' | 'field';
  breadcrumbs: string[];
  path?: string[];
  keywords?: string;
  disabled?: boolean;
};

type SearchIndexOptions = {
  installationKind?: SettingsSnapshot['installationKind'];
  excludedEnvironmentKeys: ReadonlySet<string>;
  rawSourceIds: ReadonlySet<string>;
  voiceEnabled?: boolean;
  cloudflareSetupVisible?: boolean;
};

type FieldIndex = {
  add: (pageId: string, label: string, path: string[], breadcrumbs: string[], keywords?: Array<string | undefined>) => void;
};

type SchemaVisitOptions = {
  forceAbsentChildren?: boolean;
  includeSelf?: boolean;
  keywordFor?: (path: string[]) => string | undefined;
  label?: string;
  skip?: (path: string[]) => boolean;
  arrayStartIndex?: (path: string[]) => number;
};

const applicationDedicatedPaths = new Set([
  'name',
  'defaultAgent',
  'icon',
  'keys',
  'scratchDirectory',
  'adapters',
  'tmux',
  'projects',
  'buttons',
  'review',
  'googleCalendar',
  'proxy',
  'integrations.multiInstance',
  'integrations.realtime'
]);

const applicationEnvironmentAliases: Readonly<Record<string, string>> = {
  'listen.host': 'RAC_LISTEN_HOST',
  'listen.port': 'RAC_LISTEN_PORT'
};

const installationEnvironmentAliases: Readonly<Record<string, string>> = {
  'compose.projectName': 'COMPOSE_PROJECT_NAME',
  'compose.files': 'COMPOSE_FILE',
  'compose.envFiles': 'COMPOSE_ENV_FILES',
  'compose.options.parallel': 'COMPOSE_PARALLEL_LIMIT',
  'compose.options.compatibility': 'COMPOSE_COMPATIBILITY'
};

// make machine keys readable without changing their identity
const labelForKey = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
  .replace(/[-_]+/gu, ' ')
  .replace(/^./u, character => character.toUpperCase())
  .replace(/\burl\b/giu, 'URL');

// keep adjacent navigation names from repeating in breadcrumbs
const appendBreadcrumb = (breadcrumbs: string[], label: string): string[] => breadcrumbs.at(-1) === label ? breadcrumbs : [...breadcrumbs, label];

// preserve only useful searchable metadata
const joinedKeywords = (parts: Array<string | undefined>): string | undefined => {
  const keywords = parts.map(part => part?.trim()).filter((part): part is string => part !== undefined && part !== '');
  return keywords.length === 0 ? undefined : keywords.join(' ');
};

// identify ordinary object records without interpreting their leaf bytes
const objectRecord = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) && !isProtectedValue(value)
  ? value as Record<string, unknown>
  : undefined;

// resolve one child strictly by property identity
const childValue = (value: unknown, key: string): unknown => {
  const record = objectRecord(value);
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
};

// choose a union shape without using scalar content as search text
const matchesShape = (schema: SettingsSchema, value: unknown): boolean => {
  if (value === null) return schema.nullable === true;
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type === 'object') {
    const record = objectRecord(value);
    return record !== undefined && Object.keys(schema.properties ?? {}).some(key => Object.hasOwn(record, key));
  }
  if (schema.type === 'record') return objectRecord(value) !== undefined;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number') return typeof value === 'number';
  if (schema.type === 'string' || schema.type === 'enum') return typeof value === 'string';
  return schema.type === 'json';
};

// derive a singular collection label for existing entries
const itemLabel = (label: string, schema: SettingsSchema): string => schema.items?.label ?? label.replace(/s$/u, '');

// recurse through only the controls the structured editor currently renders
function visitSchema(index: FieldIndex, pageId: string, schema: SettingsSchema, value: unknown, path: string[], breadcrumbs: string[], options: SchemaVisitOptions = {}): void {
  // omit subtrees owned by another settings page
  if (options.skip?.(path)) return;
  const label = options.label ?? schema.label ?? labelForKey(path.at(-1) ?? pageId);
  // index the current control before deciding whether its descendants render
  if (options.includeSelf !== false && path.length > 0) index.add(pageId, label, path, breadcrumbs, [schema.description, options.keywordFor?.(path), path.map(labelForKey).join(' ')]);
  // never inspect descendants of a protected control
  if (schema.protected || isProtectedValue(value)) return;
  const defaulted = Object.hasOwn(schema, 'default');
  // nullable rows replace their ordinary controls
  if (schema.nullable && (value === null || value === undefined && schema.default === null)) return;
  // absent optional containers render only their add control
  if (value === undefined && schema.optional && !defaulted && options.forceAbsentChildren !== true) return;
  const effectiveValue = value === undefined && defaulted ? schema.default : value;
  const childBreadcrumbs = appendBreadcrumb(breadcrumbs, label);

  // recurse through declared object properties
  if (schema.type === 'object') {
    const record = objectRecord(effectiveValue);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const childPath = [...path, key];
      // recurse through metadata without inheriting live placeholder values
      visitSchema(index, pageId, child, record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined, childPath, childBreadcrumbs, {
        forceAbsentChildren: options.forceAbsentChildren,
        keywordFor: options.keywordFor,
        skip: options.skip,
        arrayStartIndex: options.arrayStartIndex
      });
    }
    return;
  }

  // index existing array entries without copying their values into labels
  if (schema.type === 'array') {
    const values = Array.isArray(effectiveValue) ? effectiveValue : [];
    const entrySchema = schema.items ?? { type: 'json' };
    const entryName = itemLabel(label, schema);
    const startIndex = Math.min(values.length, Math.max(0, options.arrayStartIndex?.(path) ?? 0));
    for (let position = startIndex; position < values.length; position += 1) {
      const entryPath = [...path, String(position)];
      const numberedLabel = `${entryName} ${position + 1}`;
      index.add(pageId, numberedLabel, entryPath, childBreadcrumbs, [entrySchema.description, entryPath.map(labelForKey).join(' ')]);
      visitSchema(index, pageId, { ...entrySchema, label: numberedLabel }, values[position], entryPath, appendBreadcrumb(childBreadcrumbs, numberedLabel), {
        forceAbsentChildren: options.forceAbsentChildren === true || (pageId === 'projects' && path.length === 1 && path[0] === 'projects'),
        includeSelf: false,
        keywordFor: options.keywordFor,
        skip: options.skip,
        arrayStartIndex: options.arrayStartIndex
      });
    }
    return;
  }

  // expose record key names while leaving their values out of searchable text
  if (schema.type === 'record') {
    const record = objectRecord(effectiveValue) ?? {};
    const entrySchema = schema.items ?? { type: 'json' };
    for (const key of Object.keys(record)) {
      const entryPath = [...path, key];
      index.add(pageId, key, entryPath, childBreadcrumbs, [entrySchema.label, entrySchema.description, entryPath.map(labelForKey).join(' ')]);
      visitSchema(index, pageId, entrySchema, record[key], entryPath, appendBreadcrumb(childBreadcrumbs, key), {
        forceAbsentChildren: options.forceAbsentChildren,
        includeSelf: false,
        keywordFor: options.keywordFor,
        skip: options.skip,
        arrayStartIndex: options.arrayStartIndex
      });
    }
    return;
  }

  // recurse only into the currently rendered union shape
  if (schema.type === 'union') {
    const variant = schema.variants?.find(candidate => matchesShape(candidate, effectiveValue)) ?? schema.variants?.[0];
    if (variant !== undefined) visitSchema(index, pageId, { ...variant, label }, effectiveValue, path, breadcrumbs, {
      forceAbsentChildren: options.forceAbsentChildren,
      includeSelf: false,
      keywordFor: options.keywordFor,
      skip: options.skip,
      arrayStartIndex: options.arrayStartIndex
    });
  }
}

// index browser-owned controls that have no file schema
function addBrowserFields(index: FieldIndex): void {
  const fields = [
    { pageId: 'browser', label: 'Name', path: ['deviceName'], keywords: 'browser device rename identity' },
    { pageId: 'interface', label: 'Terminal font', path: ['terminalFontSize'], keywords: 'font size preview' },
    { pageId: 'interface', label: 'Theme', path: ['colorTheme'], keywords: 'appearance dark light mocha latte' },
    { pageId: 'interface', label: 'Reduced motion', path: ['reducedMotion'], keywords: 'animation shimmer pulse accessibility' },
    { pageId: 'interface', label: 'Notification sounds', path: ['notificationSounds'], keywords: 'alert chime audio mute silent' },
    { pageId: 'interface', label: 'Flyout markers', path: ['flyoutMarkers'], keywords: 'carets menu buttons' },
    { pageId: 'projects', label: 'Dynamic worktrees', path: ['dynamicWorktrees'], keywords: 'launcher multiple worktrees' }
  ];
  // add stable browser field identities
  for (const field of fields) index.add(field.pageId, field.label, field.path, [], [field.keywords]);
}

// index application-owned fields routed to dedicated pages
function addApplicationFields(index: FieldIndex, source: SettingsSource | undefined, options: SearchIndexOptions): void {
  // wait for a renderable application source
  if (source?.schema === undefined || source.value === undefined) return;
  const baseSchema = source.schema;

  // whole-source mode hides the icon selector while retaining its artwork section
  if (!options.rawSourceIds.has(source.id)) index.add('app', 'Server icon', ['icon'], [], ['server instance artwork']);

  const realtime = baseSchema.properties?.integrations?.properties?.realtime;
  // mirror the basic voice editor and its adjacent schema controls
  if (realtime !== undefined) {
    const voicePath = ['integrations', 'realtime'];
    index.add('voice', 'Enable Davo', [...voicePath, 'enabled'], ['Voice assistant'], [realtime.properties?.enabled?.description, 'voice assistant on off']);
    const enabled = options.voiceEnabled ?? childValue(childValue(childValue(source.value, 'integrations'), 'realtime'), 'enabled') === true;
    // index text controls only while the voice form exposes them
    if (enabled) {
      index.add('voice', 'Davo name', [...voicePath, 'name'], ['Voice assistant'], [realtime.properties?.name?.description, 'voice assistant name']);
      index.add('voice', 'Davo context', [...voicePath, 'context'], ['Voice assistant'], [realtime.properties?.context?.description, 'voice assistant context']);
    }
    for (const [key, schema] of Object.entries(realtime.properties ?? {})) {
      // keep basic voice fields in their purpose-built controls
      if (key === 'enabled' || key === 'name' || key === 'context') continue;
      visitSchema(index, 'voice', schema, childValue(childValue(childValue(source.value, 'integrations'), 'realtime'), key), [...voicePath, key], []);
    }
  }

  const googleCalendar = baseSchema.properties?.googleCalendar;
  // route calendar capture configuration to its dedicated page
  if (googleCalendar !== undefined) {
    const properties = googleCalendar.properties ?? {};
    const presented = { ...googleCalendar, properties: {
      ...properties,
      enabled: { ...properties.enabled, type: properties.enabled?.type ?? 'boolean', label: 'Enable Google Calendar' } as SettingsSchema,
      titleTemplate: { ...properties.titleTemplate, type: properties.titleTemplate?.type ?? 'string', label: 'Event title template' } as SettingsSchema,
      startMoment: { ...properties.startMoment, type: properties.startMoment?.type ?? 'enum', label: 'Start moment' } as SettingsSchema,
      endMoment: { ...properties.endMoment, type: properties.endMoment?.type ?? 'enum', label: 'End moment' } as SettingsSchema
    } };
    visitSchema(index, 'google-calendar', presented, childValue(source.value, 'googleCalendar'), ['googleCalendar'], [], {
      forceAbsentChildren: true,
      includeSelf: false
    });
  }

  const polling = baseSchema.properties?.tmux;
  // index the application half of the TMUX page
  if (polling !== undefined) {
    for (const [key, schema] of Object.entries(polling.properties ?? {})) {
      visitSchema(index, 'tmux', { ...schema, optional: false }, childValue(childValue(source.value, 'tmux'), key), ['tmux', key], ['Polling'], {
        label: key === 'pollIntervalMs' ? 'Polling interval (ms)' : undefined
      });
    }
  }

  // keep keyboard search at its stable top-level editor
  if (baseSchema.properties?.keys !== undefined) index.add('keyboard', 'Key tables', ['keys'], [], [baseSchema.properties.keys.description, 'bindings shortcuts commands']);

  const scratchDirectory = baseSchema.properties?.scratchDirectory;
  // retain the optional Storage control through application source locks
  if (scratchDirectory !== undefined) visitSchema(index, 'storage', scratchDirectory, childValue(source.value, 'scratchDirectory'), ['scratchDirectory'], []);

  const adapters = baseSchema.properties?.adapters;
  // route the unchanged application adapter subtree to its dedicated page
  if (adapters !== undefined) visitSchema(index, 'agents', adapters, childValue(source.value, 'adapters'), ['adapters'], [], {
    keywordFor: path => applicationEnvironmentAliases[path.join('.')]
  });

  const projects = baseSchema.properties?.projects;
  // mirror Docker-only host overrides without indexing live path values
  if (projects !== undefined) visitSchema(index, 'projects', projects, childValue(source.value, 'projects'), ['projects'], [], {
    label: projects.label ?? 'Projects',
    skip: path => options.installationKind !== 'compose' && path.length === 3 && path[2] === 'hostPath'
  });

  const buttons = baseSchema.properties?.buttons;
  // button definitions retain their application paths on Interface
  if (buttons !== undefined && !options.rawSourceIds.has(source.id)) visitSchema(index, 'interface', buttons, childValue(source.value, 'buttons'), ['buttons'], []);

  const review = baseSchema.properties?.review;
  // keep permanent Review controls searchable without creating omitted configuration
  if (review !== undefined && !options.rawSourceIds.has(source.id)) visitSchema(index, 'reviews', review, childValue(source.value, 'review'), ['review'], [], {
    forceAbsentChildren: true
  });

  // whole-source mode replaces only the generic application form
  if (!options.rawSourceIds.has(source.id)) visitSchema(index, 'app', baseSchema, source.value, [], [], {
    includeSelf: false,
    label: 'Application',
    keywordFor: path => applicationEnvironmentAliases[path.join('.')],
    skip: path => applicationDedicatedPaths.has(path.join('.'))
  });
}

// index environment rows on their actual dedicated or general page
function addEnvironmentFields(index: FieldIndex, source: SettingsSource | undefined, options: SearchIndexOptions, application: SettingsSource | undefined): void {
  // wait for environment metadata from the catalog
  if (source === undefined) return;
  const tmuxKeys = tmuxEnvironmentKeysForInstallation(options.installationKind);
  for (const field of source.fields ?? []) {
    // route only TMUX variables visible for the current installation
    if (tmuxKeys.has(field.key)) {
      index.add('tmux', field.key, [field.key], ['Connection & discovery'], [field.description]);
      continue;
    }
    // keep Storage locations searchable through environment source locks
    if (storageEnvironmentKeys.has(field.key)) {
      index.add('storage', field.key, [field.key], ['Environment'], [field.description]);
      continue;
    }
    const agentOwner = agentEnvironmentOwnerForKey(field.key, options.installationKind);
    // route service settings only when their owning adapter is configured
    if (agentOwner !== undefined) {
      // absent adapters have no environment controls to navigate to
      if (childValue(childValue(application?.value, 'adapters'), agentOwner) !== undefined) index.add('agents', field.key, [field.key], [labelForKey(agentOwner), 'Environment & keys'], [field.description]);
      continue;
    }
    // hide installation-specific Agent fields rather than returning them to general settings
    if (agentEnvironmentKeys.has(field.key)) continue;
    // keep dedicated voice credentials searchable through disabled and raw states
    if (voiceEnvironmentKeys.has(field.key)) {
      index.add('voice', field.key, [field.key], ['Environment & keys'], [field.description]);
      continue;
    }
    // keep Google OAuth credentials searchable only on their masked setup page
    if (googleCalendarEnvironmentKeys.has(field.key)) {
      index.add('google-calendar', field.key, [field.key], ['Environment & keys'], [field.description]);
      continue;
    }
    // whole-source mode and dedicated controls replace the general environment row
    if (options.rawSourceIds.has(source.id) || options.excludedEnvironmentKeys.has(field.key)) continue;
    index.add('env', field.key, [field.key], [], [field.description]);
  }
}

// index only the configured installation mode and its visible special cases
function addInstallationFields(index: FieldIndex, source: SettingsSource | undefined, options: SearchIndexOptions): void {
  // whole-source repair has no structured anchors
  if (source?.schema === undefined || source.value === undefined || options.rawSourceIds.has(source.id)) return;
  const schema = source.schema;
  const inferredKind = childValue(source.value, 'native') !== undefined && childValue(source.value, 'compose') === undefined ? 'systemd' : 'compose';
  const kind = options.installationKind ?? inferredKind;
  const branch = kind === 'compose' ? 'compose' : 'native';
  const branchLabel = kind === 'compose' ? 'Docker' : 'Native';

  const host = schema.properties?.host ?? { type: 'object', properties: { checkout: { type: 'string', label: 'Checkout' } } };
  const hostValue = childValue(source.value, 'host');
  const hostProperties = host.properties ?? {};
  // checkout is permanent even in sparse legacy installation files
  visitSchema(index, 'installation', { ...hostProperties.checkout, type: 'string', label: 'Checkout', optional: false }, childValue(hostValue, 'checkout'), ['host', 'checkout'], ['Host']);
  for (const [key, property] of Object.entries(hostProperties)) {
    // checkout already uses the editor's permanent presentation schema
    if (key === 'checkout') continue;
    visitSchema(index, 'installation', property, childValue(hostValue, key), ['host', key], ['Host']);
  }

  // target the installed-mode selector without advertising the inactive branch
  index.add('installation', 'Installation mode', ['mode'], [], [branchLabel, 'configured mode']);
  const branchSchema = schema.properties?.[branch];
  const branchValue = childValue(source.value, branch);
  // retain the mode selector even if an old catalog omits branch metadata
  if (branchSchema === undefined) return;

  const providedOptions = branchSchema.properties?.options;
  const optionsSchema: SettingsSchema = {
    ...providedOptions,
    type: 'object',
    optional: false,
    label: providedOptions?.label ?? 'Options',
    properties: {
      ...providedOptions?.properties,
      parallel: { ...providedOptions?.properties?.parallel, type: 'number', optional: false, ...composeOptionSettings.parallel },
      compatibility: { ...providedOptions?.properties?.compatibility, type: 'boolean', optional: false, ...composeOptionSettings.compatibility }
    }
  };
  const properties = kind === 'compose' ? { ...branchSchema.properties, options: optionsSchema } : branchSchema.properties ?? {};
  for (const [key, property] of Object.entries(properties)) {
    // profiles and native Cloudflare selectors are intentionally not settings controls
    if (key === 'profiles' || kind === 'systemd' && ['cloudflaredUnit', 'cloudflaredConfig', 'cloudflaredCredentials'].includes(key)) continue;
    const path = [branch, key];
    const value = childValue(branchValue, key);
    const breadcrumbs = [branchLabel];
    // compose options are always visible with their UI defaults
    if (kind === 'compose' && key === 'options') {
      visitSchema(index, 'installation', property, value, path, breadcrumbs, {
        forceAbsentChildren: true,
        keywordFor: candidate => installationEnvironmentAliases[candidate.join('.')]
      });
      continue;
    }
    // skip catalog-owned file rows but retain editable files after their fixed prefix
    const pinnedCount = kind === 'compose' && key === 'files' ? 2 : kind === 'compose' && key === 'envFiles' ? 1 : 0;
    const presentedProperty = kind === 'compose' && key === 'files'
      ? { ...property, label: property.label ?? 'Compose files', items: { ...property.items ?? { type: 'string' as const }, label: property.items?.label ?? 'Compose file' } }
      : kind === 'compose' && key === 'envFiles'
        ? { ...property, label: property.label ?? 'Environment files', items: { ...property.items ?? { type: 'string' as const }, label: property.items?.label ?? 'Environment file' } }
        : property;
    visitSchema(index, 'installation', presentedProperty, value, path, breadcrumbs, {
      keywordFor: candidate => installationEnvironmentAliases[candidate.join('.')],
      arrayStartIndex: candidate => candidate.length === 2 && candidate[0] === branch && candidate[1] === key ? pinnedCount : 0
    });
  }
}

// add the dedicated wrapper and Cloudflare controls
function addStaticServerFields(index: FieldIndex, sources: SettingsSource[], options: SearchIndexOptions): void {
  const wrapper = sources.find(source => source.id === 'wrapper');
  // index the wrapper only when its editor exists
  if (wrapper !== undefined) index.add('tmux', wrapper.label || 'Installation wrapper', ['wrapper'], ['Installation wrapper']);

  index.add('cloudflare', 'Endpoint and status', ['cloudflare', 'status'], [], ['tunnel endpoint connection up down']);
  // advertise setup fields only after the safe status confirms the guide is visible
  if (options.cloudflareSetupVisible !== true) return;
  index.add('cloudflare', 'Tunnel token', ['cloudflare', 'token'], ['Tunnel setup'], ['connector credential start']);
  index.add('cloudflare', 'Hostname', ['cloudflare', 'hostname'], ['Tunnel setup'], ['public route domain verify address']);
}

// build a value-free search catalog from the current rendering metadata
export function buildSettingsSearchIndex(pages: SettingsSearchPage[], sources: SettingsSource[], options: SearchIndexOptions): SettingsSearchResult[] {
  const pagesById = new Map(pages.map(page => [page.id, page]));
  const buckets = new Map(pages.map(page => [page.id, [] as SettingsSearchResult[]]));
  const fieldPaths = new Set<string>();
  const index: FieldIndex = {
    add: (pageId, label, path, breadcrumbs, keywords) => {
      const page = pagesById.get(pageId);
      const bucket = buckets.get(pageId);
      // skip fields whose destination page is unavailable
      if (page === undefined || bucket === undefined) return;
      const identity = `${pageId}\u0000${JSON.stringify(path)}`;
      // keep one stable target for controls that share a wrapper path
      if (fieldPaths.has(identity)) return;
      fieldPaths.add(identity);
      const searchKeywords = joinedKeywords([label, ...keywords ?? [], ...path, ...path.map(labelForKey)]);
      bucket.push({
        id: `field:${pageId}:${JSON.stringify(path)}`,
        pageId,
        label,
        kind: 'field',
        breadcrumbs: [...new Set([page.group, page.label, ...breadcrumbs].filter(Boolean))],
        path,
        ...(searchKeywords === undefined ? {} : { keywords: searchKeywords }),
        ...(page.disabled ? { disabled: true } : {})
      });
    }
  };

  addBrowserFields(index);
  const application = sources.find(source => source.id === 'app');
  addApplicationFields(index, application, options);
  addEnvironmentFields(index, sources.find(source => source.id === 'env'), options, application);
  addInstallationFields(index, sources.find(source => source.id === 'installation'), options);
  addStaticServerFields(index, sources, options);

  // index any future typed JSON source without inventing dedicated routing
  for (const source of sources) {
    if (source.id === 'app' || source.id === 'env' || source.id === 'installation' || source.schema === undefined || source.value === undefined || options.rawSourceIds.has(source.id)) continue;
    visitSchema(index, source.id, source.schema, source.value, [], [], { includeSelf: false });
  }

  // retain navigation order with each page followed by its fields
  return pages.flatMap(page => {
    const searchKeywords = joinedKeywords([page.group, page.label, page.keywords]);
    return [{
      id: `page:${page.id}`,
      pageId: page.id,
      label: page.label,
      kind: 'page' as const,
      breadcrumbs: [],
      ...(searchKeywords === undefined ? {} : { keywords: searchKeywords }),
      ...(page.disabled ? { disabled: true } : {})
    }, ...buckets.get(page.id) ?? []];
  });
}
