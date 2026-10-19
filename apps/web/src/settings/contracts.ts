export type SettingsApply = 'live' | 'saved-only' | 'rac-restart' | 'cloudflared-recreate' | 'source-migration';

export type SettingsSchema = {
  type: 'object' | 'array' | 'record' | 'string' | 'number' | 'boolean' | 'enum' | 'json' | 'union';
  label?: string;
  description?: string;
  optional?: boolean;
  nullable?: boolean;
  protected?: boolean;
  apply?: SettingsApply;
  default?: unknown;
  properties?: Record<string, SettingsSchema>;
  items?: SettingsSchema;
  options?: string[];
  variants?: SettingsSchema[];
};

// distinguish omission guidance from saved environment assignments
export type SettingsEnvironmentFallback = { value: string; kind: 'literal' | 'derived' | 'compose' };

export type SettingsEnvField = {
  key: string;
  value?: string;
  protected: boolean;
  present: boolean;
  hasValue?: boolean;
  apply: SettingsApply;
  description?: string;
  origin?: string;
  overriddenBy?: string;
  winningSource?: string;
  fallback?: SettingsEnvironmentFallback;
};

export type SettingsSource = {
  id: string;
  label: string;
  path?: string;
  format: 'json' | 'env' | 'compose' | 'cloudflared' | 'credentials' | 'wrapper' | 'svg' | 'installation';
  exists: boolean;
  writable: boolean;
  protected: boolean;
  tracked: boolean;
  revisionId: string;
  apply: SettingsApply;
  value?: unknown;
  content?: string;
  hasProtectedContent?: boolean;
  schema?: SettingsSchema;
  fields?: SettingsEnvField[];
  origin?: string;
  overriddenBy?: string;
  pathRevisions?: Record<string, string>;
};

export type SettingsPatch = {
  op: 'set' | 'remove' | 'insert' | 'move';
  path: string[];
  value?: unknown;
  index?: number;
  from?: number;
  to?: number;
  revisionId?: string;
};

export type SettingsChange = {
  sourceId: string;
  revisionId: string;
  patches?: SettingsPatch[];
  content?: string;
  remove?: boolean;
  migration?: { mode: 'copy' | 'adopt' | 'empty' };
};

export type SettingsOperation = {
  id: string;
  state: 'queued' | 'running' | 'complete' | 'failed';
  phase?: string;
  error?: string;
};

export type SettingsStatus = {
  pending: boolean;
  targets: Array<'rac' | 'cloudflared'>;
  effective: 'known' | 'unknown';
  restartAvailable: boolean;
  reason?: string;
  operation?: SettingsOperation;
  reconnectOrigin?: string;
  reloginRequired?: boolean;
  recoveryCommand?: string;
};

export type SettingsSnapshot = {
  version: 1;
  installationKind?: 'compose' | 'systemd';
  revisionId: string;
  sources: SettingsSource[];
  status: SettingsStatus;
};

export type SettingsIssue = {
  sourceId: string;
  path: string[];
  code: string;
  message: string;
};

export type SettingsValidation = {
  valid: boolean;
  issues: SettingsIssue[];
  warnings?: string[];
};

export type SettingsRequest = (url: string, init?: RequestInit) => Promise<Response>;

export type ProtectedValue = { __racProtected: true; present: boolean; hasValue?: boolean };

const schemaTypes = new Set<SettingsSchema['type']>(['object', 'array', 'record', 'string', 'number', 'boolean', 'enum', 'json', 'union']);
const sourceFormats = new Set<SettingsSource['format']>(['json', 'env', 'compose', 'cloudflared', 'credentials', 'wrapper', 'svg', 'installation']);
const applyClasses = new Set<SettingsApply>(['live', 'saved-only', 'rac-restart', 'cloudflared-recreate', 'source-migration']);

// validate one server-provided rendering schema recursively
const isSettingsSchema = (value: unknown): value is SettingsSchema => {
  if (value === null || typeof value !== 'object' || !schemaTypes.has((value as SettingsSchema).type)) return false;
  const schema = value as SettingsSchema;
  if (schema.optional !== undefined && typeof schema.optional !== 'boolean') return false;
  if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') return false;
  if (schema.protected !== undefined && typeof schema.protected !== 'boolean') return false;
  if (schema.apply !== undefined && !applyClasses.has(schema.apply)) return false;
  if (schema.properties !== undefined && (schema.properties === null || typeof schema.properties !== 'object' || !Object.values(schema.properties).every(isSettingsSchema))) return false;
  if (schema.items !== undefined && !isSettingsSchema(schema.items)) return false;
  if (schema.options !== undefined && (!Array.isArray(schema.options) || !schema.options.every(option => typeof option === 'string'))) return false;
  if (schema.variants !== undefined && (!Array.isArray(schema.variants) || !schema.variants.every(isSettingsSchema))) return false;
  return true;
};

// validate one public restart operation
const isSettingsOperation = (value: unknown): value is SettingsOperation => value !== null
  && typeof value === 'object'
  && typeof (value as SettingsOperation).id === 'string'
  && ['queued', 'running', 'complete', 'failed'].includes((value as SettingsOperation).state)
  && ((value as SettingsOperation).phase === undefined || typeof (value as SettingsOperation).phase === 'string')
  && ((value as SettingsOperation).error === undefined || typeof (value as SettingsOperation).error === 'string');

// validate the redacted global status contract
export const isSettingsStatus = (value: unknown): value is SettingsStatus => value !== null
  && typeof value === 'object'
  && typeof (value as SettingsStatus).pending === 'boolean'
  && Array.isArray((value as SettingsStatus).targets)
  && (value as SettingsStatus).targets.every(target => target === 'rac' || target === 'cloudflared')
  && ((value as SettingsStatus).effective === 'known' || (value as SettingsStatus).effective === 'unknown')
  && typeof (value as SettingsStatus).restartAvailable === 'boolean'
  && ((value as SettingsStatus).reason === undefined || typeof (value as SettingsStatus).reason === 'string')
  && ((value as SettingsStatus).operation === undefined || isSettingsOperation((value as SettingsStatus).operation))
  && ((value as SettingsStatus).reconnectOrigin === undefined || typeof (value as SettingsStatus).reconnectOrigin === 'string')
  && ((value as SettingsStatus).reloginRequired === undefined || typeof (value as SettingsStatus).reloginRequired === 'boolean');

// validate public omission hints without admitting concrete secret defaults
const isEnvironmentFallback = (value: unknown, protectedValue: boolean): value is SettingsEnvironmentFallback => {
  if (value === null || typeof value !== 'object') return false;
  const fallback = value as SettingsEnvironmentFallback;
  return typeof fallback.value === 'string' && fallback.value.trim().length > 0
    && ['literal', 'derived', 'compose'].includes(fallback.kind)
    && (!protectedValue || fallback.kind === 'derived');
};

// validate one source descriptor without interpreting protected bytes
const isSettingsSource = (value: unknown): value is SettingsSource => {
  if (value === null || typeof value !== 'object') return false;
  const source = value as SettingsSource;
  if (typeof source.id !== 'string' || typeof source.label !== 'string' || !sourceFormats.has(source.format) || typeof source.exists !== 'boolean' || typeof source.writable !== 'boolean' || typeof source.protected !== 'boolean' || typeof source.tracked !== 'boolean' || typeof source.revisionId !== 'string' || !applyClasses.has(source.apply)) return false;
  if (source.path !== undefined && typeof source.path !== 'string' || source.origin !== undefined && typeof source.origin !== 'string' || source.overriddenBy !== undefined && typeof source.overriddenBy !== 'string') return false;
  // accept only redacted code bytes and explicit credential metadata
  if (source.content !== undefined && typeof source.content !== 'string' || source.hasProtectedContent !== undefined && typeof source.hasProtectedContent !== 'boolean') return false;
  if (source.schema !== undefined && !isSettingsSchema(source.schema)) return false;
  // accept winner labels only as explicit nonempty conflict metadata
  if (source.fields !== undefined && (!Array.isArray(source.fields) || !source.fields.every(field => field !== null && typeof field === 'object' && typeof field.key === 'string' && (field.value === undefined || typeof field.value === 'string') && typeof field.protected === 'boolean' && typeof field.present === 'boolean' && (field.hasValue === undefined || typeof field.hasValue === 'boolean') && applyClasses.has(field.apply) && (field.description === undefined || typeof field.description === 'string') && (field.origin === undefined || typeof field.origin === 'string') && (field.overriddenBy === undefined || typeof field.overriddenBy === 'string') && (field.fallback === undefined || isEnvironmentFallback(field.fallback, field.protected)) && (field.winningSource === undefined || typeof field.winningSource === 'string' && field.winningSource.trim().length > 0 && field.present)))) return false;
  if (source.pathRevisions !== undefined && (source.pathRevisions === null || typeof source.pathRevisions !== 'object' || !Object.values(source.pathRevisions).every(revision => typeof revision === 'string'))) return false;
  return true;
};

// validate the complete versioned redacted snapshot
export const isSettingsSnapshot = (value: unknown): value is SettingsSnapshot => value !== null
  && typeof value === 'object'
  && (value as SettingsSnapshot).version === 1
  && ((value as SettingsSnapshot).installationKind === undefined || (value as SettingsSnapshot).installationKind === 'compose' || (value as SettingsSnapshot).installationKind === 'systemd')
  && typeof (value as SettingsSnapshot).revisionId === 'string'
  && Array.isArray((value as SettingsSnapshot).sources)
  && (value as SettingsSnapshot).sources.every(isSettingsSource)
  && isSettingsStatus((value as SettingsSnapshot).status);

// identify the only masked value shape accepted from settings reads
export const isProtectedValue = (value: unknown): value is ProtectedValue => value !== null
  && typeof value === 'object'
  && (value as { __racProtected?: unknown }).__racProtected === true
  && typeof (value as { present?: unknown }).present === 'boolean'
  && ((value as { hasValue?: unknown }).hasValue === undefined || typeof (value as { hasValue?: unknown }).hasValue === 'boolean');

// turn one response into a safe display error
export const settingsResponseError = async (response: Response, fallback: string): Promise<string> => {
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof payload?.error === 'string' ? payload.error : fallback;
};
