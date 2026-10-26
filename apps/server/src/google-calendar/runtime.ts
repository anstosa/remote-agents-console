import { resolve } from 'node:path';
import type { CalendarAdmission, CalendarSignal, CalendarSummary, GoogleCalendarConfig } from './contracts.js';
import { ActiveGoogleCalendarService, type GoogleCalendarService } from './service.js';
import { GoogleCalendarError } from './provider-types.js';
import { parseTokenKey } from './crypto.js';
import { renderCalendarTitle, validateTitleTemplate } from './title.js';

type GoogleCalendarServiceOptions = {
  config: GoogleCalendarConfig;
  publicOrigin: string;
  env?: NodeJS.ProcessEnv;
  authPath?: string;
  activitiesPath?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

// isolate optional-provider boot failures from the core server
export async function createGoogleCalendarService(options: GoogleCalendarServiceOptions): Promise<GoogleCalendarService> {
  const redirectUri = `${options.publicOrigin.replace(/\/$/u, '')}/api/settings/google-calendar/oauth/callback`;
  const env = options.env ?? process.env;
  const setup = { clientId: present(env.RAC_GOOGLE_CALENDAR_CLIENT_ID), clientSecret: present(env.RAC_GOOGLE_CALENDAR_CLIENT_SECRET), tokenKey: validTokenKey(env.RAC_GOOGLE_CALENDAR_TOKEN_KEY) };
  // keep disabled installations fully inert and file-free
  if (!options.config.enabled) return new InertGoogleCalendarService(options.config, redirectUri, 'disabled', setup);
  try {
    const clientId = required(env.RAC_GOOGLE_CALENDAR_CLIENT_ID, 'client_id_missing');
    const clientSecret = required(env.RAC_GOOGLE_CALENDAR_CLIENT_SECRET, 'client_secret_missing');
    const activeKey = parseTokenKey(env.RAC_GOOGLE_CALENDAR_TOKEN_KEY);
    const previousValue = env.RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY;
    const previousKey = previousValue === undefined || previousValue === '' ? undefined : parseTokenKey(previousValue);
    // prevent ambiguous rotation key lookup
    if (previousKey !== undefined && (previousKey.kid === activeKey.kid || previousKey.bytes.equals(activeKey.bytes))) throw new Error('token_key_invalid');
    const service = new ActiveGoogleCalendarService({
      config: options.config,
      publicOrigin: options.publicOrigin,
      clientId,
      clientSecret,
      activeKey,
      ...(previousKey === undefined ? {} : { previousKey }),
      authPath: resolve(options.authPath ?? '.data/google-calendar-auth.json'),
      activitiesPath: resolve(options.activitiesPath ?? '.data/google-calendar-activities.json'),
      fetcher: boundedFetch(options.fetch ?? globalThis.fetch),
      now: options.now ?? Date.now
    });
    await service.initialize();
    return service;
  } catch (error) {
    return new InertGoogleCalendarService(options.config, redirectUri, safeBootReason(error), setup);
  }
}

// require one nonempty bounded runtime secret
function required(value: string | undefined, code: string): string {
  // reject absent and excessively large environment values
  if (value === undefined || value.length < 1 || value.length > 8192 || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value;
}

// report only presence of bounded runtime configuration
function present(value: string | undefined): boolean { return value !== undefined && value.length > 0 && value.length <= 8192 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }

// report key validity without exposing or retaining its bytes
function validTokenKey(value: string | undefined): boolean {
  try { parseTokenKey(value); return true; } catch { return false; }
}

// bound every provider request so app shutdown cannot wait forever
function boundedFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(15_000);
    const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
    return await fetcher(input, { ...init, signal });
  };
}

// map private startup failures to bounded diagnostics
function safeBootReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const allowed = new Set(['client_id_missing', 'client_secret_missing', 'token_key_invalid', 'token_key_unavailable', 'encrypted_record_invalid', 'auth_store_invalid', 'activity_store_invalid', 'private_store_invalid']);
  return allowed.has(message) ? message : 'google_calendar_unavailable';
}

class InertGoogleCalendarService implements GoogleCalendarService {
  // retain only public setup state in degraded mode
  constructor(private readonly config: GoogleCalendarConfig, private readonly redirectUri: string, private readonly reason: string, private readonly setupState: { clientId: boolean; clientSecret: boolean; tokenKey: boolean }) {}

  // expose a stable degraded or disabled status
  summary(): CalendarSummary {
    return {
      enabled: this.config.enabled,
      available: false,
      connected: false,
      status: this.reason === 'disabled' ? 'disabled' : 'degraded',
      calendars: [],
      setup: { ...this.setupState, redirectUri: this.redirectUri },
      counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 },
      ...(this.reason === 'disabled' ? {} : { lastError: this.reason })
    };
  }

  // decline capture without touching storage
  async admit(_input: CalendarAdmission): Promise<boolean> { return false; }

  // ignore lifecycle signals without touching storage
  async signal(_input: CalendarSignal): Promise<void> {}

  // keep degraded worker inert
  start(): void {}

  // keep degraded worker shutdown inert
  async stop(): Promise<void> {}

  // reject setup actions with one bounded code
  beginConnect(_sessionId: string, _reservationGeneration: string): string { throw new GoogleCalendarError(this.reason === 'disabled' ? 'google_calendar_disabled' : 'google_calendar_unavailable', 503); }

  // reject callbacks without consuming provider bytes
  async completeConnect(): Promise<void> { throw new GoogleCalendarError('oauth_transaction_invalid', 400); }

  // reject unavailable calendar creation
  async createCalendar(): Promise<CalendarSummary> { throw new GoogleCalendarError('google_calendar_unavailable', 503); }

  // reject unavailable target selection
  async selectCalendar(): Promise<CalendarSummary> { throw new GoogleCalendarError('google_calendar_unavailable', 503); }

  // make local disconnect idempotent in inert mode
  async disconnect(): Promise<CalendarSummary> { return this.summary(); }

  // make retry idempotent in inert mode
  async retry(): Promise<CalendarSummary> { return this.summary(); }

  // keep title preview independent of provider credentials
  preview(template: string): string {
    const issue = validateTitleTemplate(template);
    // block invalid authored templates consistently
    if (issue !== undefined) throw new GoogleCalendarError('invalid_title_template', 400);
    return renderCalendarTitle(template, { worktree: 'Cora', project: 'Remote Agents', agent: 'Codex' });
  }

  // keep degraded dispatch inert
  async dispatch(): Promise<void> {}
}
