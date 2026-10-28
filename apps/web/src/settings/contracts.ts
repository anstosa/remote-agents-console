export type SettingsApply = 'live' | 'saved-only' | 'rac-restart' | 'cloudflared-recreate' | 'source-migration';

export type SettingsSchema = {
  type: 'object' | 'array' | 'record' | 'string' | 'number' | 'boolean' | 'enum' | 'json' | 'union';
  label?: string;
  description?: string;
  placeholder?: string;
  editor?: 'shell';
  singleLine?: boolean;
  multiline?: boolean;
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
  emptyValueHint?: string;
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

export type SettingsRestartProgress = {
  recoveryDeadline: number;
  state: 'restarting' | 'recovering' | 'restarted' | 'recovered' | 'recovery-failed';
};

export type SettingsOperation = {
  id: string;
  state: 'queued' | 'running' | 'complete' | 'failed';
  kind?: 'cloudflare';
  phase?: string;
  error?: string;
  restart?: SettingsRestartProgress;
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

export type CloudflareStatus = {
  supported: boolean;
  reason?: string;
  mode: 'unconfigured' | 'token' | 'local';
  enabled: boolean;
  hostname?: string;
  endpoint?: string;
  tokenPresent: boolean;
  serviceUrl: string;
  connected?: boolean;
  verifiedAt?: string;
  operation?: SettingsOperation;
  reconnectOrigin?: string;
};

export type TunnelHealth = {
  state: 'disabled' | 'checking' | 'healthy' | 'degraded' | 'unknown';
  checkedAt?: string;
  lastHealthyAt?: string;
  failures: number;
  reconnecting: boolean;
  canReconnect: boolean;
  error?: 'origin_unavailable' | 'tunnel_unreachable' | 'tunnel_identity_mismatch' | 'reconnect_failed';
};

export type GoogleCalendarSummary = {
  enabled: boolean;
  available: boolean;
  connected: boolean;
  status: 'disabled' | 'setup_required' | 'connected' | 'ready' | 'degraded';
  accountEmail?: string;
  calendars: Array<{ id: string; name: string }>;
  selectedCalendarId?: string;
  setup: {
    clientId: boolean;
    clientSecret: boolean;
    tokenKey: boolean;
    redirectUri: string;
  };
  counts: {
    pending: number;
    delivered: number;
    failed: number;
    suppressed: number;
  };
  lastError?: string;
  lastSuccessAt?: string;
};

// require one exact set of public response keys
const hasOnlyKeys = (value: object, allowed: ReadonlySet<string>): boolean => Object.keys(value).every(key => allowed.has(key));

// accept bounded display text without control bytes
const isSafeCalendarText = (value: unknown, maximum: number): value is string => typeof value === 'string' && Array.from(value).length <= maximum && !/[\p{Cc}\p{Cs}]/u.test(value);

// validate a public callback URI without admitting query credentials
const isSafeRedirectUri = (value: unknown): value is string => {
  // require a bounded textual URI
  if (!isSafeCalendarText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
};

// accept only the safe Google Calendar status projection
export const isGoogleCalendarSummary = (value: unknown): value is GoogleCalendarSummary => {
  // require the expected response envelope
  if (value === null || typeof value !== 'object') return false;
  const summary = value as GoogleCalendarSummary;
  const setup = summary.setup;
  const counts = summary.counts;
  // validate nested setup and delivery metadata without admitting provider credentials
  if (setup === null || typeof setup !== 'object' || counts === null || typeof counts !== 'object') return false;
  // reject unversioned response expansion that could include provider secrets
  if (!hasOnlyKeys(value, new Set(['enabled', 'available', 'connected', 'status', 'accountEmail', 'calendars', 'selectedCalendarId', 'setup', 'counts', 'lastError', 'lastSuccessAt']))) return false;
  if (!hasOnlyKeys(setup, new Set(['clientId', 'clientSecret', 'tokenKey', 'redirectUri'])) || !hasOnlyKeys(counts, new Set(['pending', 'delivered', 'failed', 'suppressed']))) return false;
  // validate every RAC-created calendar label and opaque identifier
  if (!Array.isArray(summary.calendars) || !summary.calendars.every(calendar => calendar !== null && typeof calendar === 'object' && hasOnlyKeys(calendar, new Set(['id', 'name'])) && isSafeCalendarText(calendar.id, 1_024) && calendar.id !== '' && isSafeCalendarText(calendar.name, 120) && calendar.name.trim() !== '')) return false;
  // require the selected target to come from the returned RAC-owned registry
  if (summary.selectedCalendarId !== undefined && !summary.calendars.some(calendar => calendar.id === summary.selectedCalendarId)) return false;
  return typeof summary.enabled === 'boolean'
    && typeof summary.available === 'boolean'
    && typeof summary.connected === 'boolean'
    && ['disabled', 'setup_required', 'connected', 'ready', 'degraded'].includes(summary.status)
    && (summary.accountEmail === undefined || isSafeCalendarText(summary.accountEmail, 320))
    && (summary.selectedCalendarId === undefined || isSafeCalendarText(summary.selectedCalendarId, 1_024))
    && typeof setup.clientId === 'boolean'
    && typeof setup.clientSecret === 'boolean'
    && typeof setup.tokenKey === 'boolean'
    && isSafeRedirectUri(setup.redirectUri)
    && Number.isSafeInteger(counts.pending) && counts.pending >= 0
    && Number.isSafeInteger(counts.delivered) && counts.delivered >= 0
    && Number.isSafeInteger(counts.failed) && counts.failed >= 0
    && Number.isSafeInteger(counts.suppressed) && counts.suppressed >= 0
    && (summary.lastError === undefined || isSafeCalendarText(summary.lastError, 320))
    && (summary.lastSuccessAt === undefined || isSafeCalendarText(summary.lastSuccessAt, 80));
};

// accept only redacted setup metadata and ordinary operation progress
export const isCloudflareStatus = (value: unknown): value is CloudflareStatus => {
  if (value === null || typeof value !== 'object') return false;
  const status = value as CloudflareStatus;
  return typeof status.supported === 'boolean' && typeof status.enabled === 'boolean'
    && typeof status.tokenPresent === 'boolean' && typeof status.serviceUrl === 'string'
    && ['unconfigured', 'token', 'local'].includes(status.mode)
    && (status.reason === undefined || typeof status.reason === 'string')
    && (status.hostname === undefined || typeof status.hostname === 'string')
    && (status.endpoint === undefined || typeof status.endpoint === 'string')
    && (status.connected === undefined || typeof status.connected === 'boolean')
    && (status.verifiedAt === undefined || typeof status.verifiedAt === 'string')
    && (status.reconnectOrigin === undefined || typeof status.reconnectOrigin === 'string')
    && (status.operation === undefined || isSettingsOperation(status.operation));
};

// accept only the bounded tunnel-health projection
export const isTunnelHealth = (value: unknown): value is TunnelHealth => {
  // reject additions that could expose helper diagnostics
  if (value === null || typeof value !== 'object' || !hasOnlyKeys(value, new Set(['state', 'checkedAt', 'lastHealthyAt', 'failures', 'reconnecting', 'canReconnect', 'error']))) return false;
  const health = value as TunnelHealth;
  return ['disabled', 'checking', 'healthy', 'degraded', 'unknown'].includes(health.state)
    && (health.checkedAt === undefined || typeof health.checkedAt === 'string')
    && (health.lastHealthyAt === undefined || typeof health.lastHealthyAt === 'string')
    && Number.isSafeInteger(health.failures) && health.failures >= 0
    && typeof health.reconnecting === 'boolean'
    && typeof health.canReconnect === 'boolean'
    && (health.error === undefined || ['origin_unavailable', 'tunnel_unreachable', 'tunnel_identity_mismatch', 'reconnect_failed'].includes(health.error));
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
  // accept only textual presentation guidance
  if (schema.placeholder !== undefined && typeof schema.placeholder !== 'string') return false;
  // accept only supported code editor hints
  if (schema.editor !== undefined && schema.editor !== 'shell') return false;
  if (schema.singleLine !== undefined && typeof schema.singleLine !== 'boolean') return false;
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
const isSettingsRestartProgress = (value: unknown): value is SettingsRestartProgress => value !== null
  && typeof value === 'object'
  && Number.isSafeInteger((value as SettingsRestartProgress).recoveryDeadline)
  && (value as SettingsRestartProgress).recoveryDeadline >= 0
  && Object.keys(value).length === 2
  && ['restarting', 'recovering', 'restarted', 'recovered', 'recovery-failed'].includes((value as SettingsRestartProgress).state);

// accept only bounded host-owned restart progress
export const isSettingsOperation = (value: unknown): value is SettingsOperation => value !== null
  && typeof value === 'object'
  && typeof (value as SettingsOperation).id === 'string'
  && ['queued', 'running', 'complete', 'failed'].includes((value as SettingsOperation).state)
  && ((value as SettingsOperation).kind === undefined || (value as SettingsOperation).kind === 'cloudflare')
  && ((value as SettingsOperation).phase === undefined || typeof (value as SettingsOperation).phase === 'string')
  && ((value as SettingsOperation).error === undefined || typeof (value as SettingsOperation).error === 'string')
  && ((value as SettingsOperation).restart === undefined || isSettingsRestartProgress((value as SettingsOperation).restart));

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
  && ((value as SettingsStatus).recoveryCommand === undefined || typeof (value as SettingsStatus).recoveryCommand === 'string')
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
  if (source.fields !== undefined && (!Array.isArray(source.fields) || !source.fields.every(field => field !== null && typeof field === 'object' && typeof field.key === 'string' && (field.value === undefined || typeof field.value === 'string') && typeof field.protected === 'boolean' && typeof field.present === 'boolean' && (field.hasValue === undefined || typeof field.hasValue === 'boolean') && applyClasses.has(field.apply) && (field.description === undefined || typeof field.description === 'string') && (field.origin === undefined || typeof field.origin === 'string') && (field.overriddenBy === undefined || typeof field.overriddenBy === 'string') && (field.fallback === undefined || isEnvironmentFallback(field.fallback, field.protected)) && (field.emptyValueHint === undefined || typeof field.emptyValueHint === 'string') && (field.winningSource === undefined || typeof field.winningSource === 'string' && field.winningSource.trim().length > 0 && field.present)))) return false;
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
