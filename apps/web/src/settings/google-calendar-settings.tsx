import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { SplitConfirmation } from '../split-confirmation.js';
import { isGoogleCalendarSummary, type GoogleCalendarSummary } from './contracts.js';
import { useSettingsRuntime } from './runtime.js';
import { SettingsSelect } from './select.js';
import './google-calendar-settings.css';

type GoogleCalendarSetup = ReturnType<typeof useGoogleCalendarSetup>;

type GoogleCalendarSettingsProps = {
  setup: GoogleCalendarSetup;
  configuration: ReactNode;
  environment: ReactNode;
  titleTemplate: string;
  disabled: boolean;
  blockedByDrafts: boolean;
  confirmationTarget?: HTMLElement | null;
  onNotice: (tone: 'success' | 'error', detail: string) => void;
};

const defaultCalendarName = 'RAC Agent Work';
const placeholders = ['{worktree}', '{project}', '{agent}'] as const;

// retain safe provider status across page navigation without retaining credentials
export function useGoogleCalendarSetup(enabled: boolean) {
  const runtime = useSettingsRuntime();
  const [status, setStatus] = useState<GoogleCalendarSummary>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  // fetch only the redacted status projection
  const refresh = useCallback(async () => {
    // wait for the Settings catalog to establish an authenticated page
    if (!enabled) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const response = await runtime.request('/api/settings/google-calendar', { cache: 'no-store' });
      const payload: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
      // ignore stale reads and reject unsupported response shapes
      if (sequence !== requestSequence.current) return;
      if (!response.ok || !isGoogleCalendarSummary(payload)) {
        setError('Google Calendar status is unavailable.');
        return;
      }
      setStatus(payload);
      setError('');
    } catch {
      // retain the last safe summary through transport failures
      if (sequence === requestSequence.current) setError('Google Calendar status is unavailable.');
    } finally {
      // release only the newest status request
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [enabled, runtime.request]);

  // refresh after OAuth returns or authenticated controller state changes
  useEffect(() => {
    // keep provider reads disabled before Settings has loaded
    if (!enabled) return;
    void refresh();
    return () => { requestSequence.current += 1; };
  }, [enabled, refresh, runtime.securityEpoch]);

  return { status, setStatus, loading, error, setError, refresh };
}

// validate preview syntax without expanding or retaining any runtime content
const validateTitleTemplate = (template: string): string | undefined => {
  // require a bounded visible title
  if (template.trim() === '') return 'Enter an event title template.';
  if (Array.from(template).length > 160) return 'Use no more than 160 characters.';
  if (/[\p{Cc}\p{Cs}]/u.test(template)) return 'Control characters and line breaks are not allowed.';
  let expansions = 0;
  // parse braces without evaluating values in the browser
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index];
    // accept escaped opening braces
    if (character === '{' && template[index + 1] === '{') { index += 1; continue; }
    // validate one exact placeholder
    if (character === '{') {
      const close = template.indexOf('}', index + 1);
      // reject unclosed and nested placeholders
      if (close < 0 || template.slice(index + 1, close).includes('{')) return 'Use only the supported placeholders and escape literal braces as {{ or }}.';
      const placeholder = template.slice(index, close + 1);
      // keep prompts, responses, paths, and arbitrary fields outside the title contract
      if (!placeholders.includes(placeholder as typeof placeholders[number])) return `Unsupported placeholder ${placeholder}.`;
      expansions += 1;
      // keep expansion work bounded
      if (expansions > 80) return 'Use no more than 80 placeholders.';
      index = close;
      continue;
    }
    // accept escaped closing braces and reject lone closers
    if (character === '}') {
      if (template[index + 1] === '}') { index += 1; continue; }
      return 'Use only the supported placeholders and escape literal braces as {{ or }}.';
    }
  }
  return undefined;
};

// accept only Google's top-level HTTPS authorization origin
const authorizationUrl = (value: unknown): string | undefined => {
  // reject missing or nontextual provider responses
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

// translate bounded provider states without claiming unsupported evidence
const statusLabel = (status: GoogleCalendarSummary | undefined, loading: boolean): string => {
  // prefer progress over a stale prior state
  if (loading && status === undefined) return 'Loading Google Calendar…';
  if (status === undefined) return 'Status unavailable';
  if (status.status === 'disabled') return 'Calendar capture disabled';
  if (status.status === 'setup_required') return 'Setup required';
  if (status.status === 'ready') return 'Ready';
  if (status.status === 'degraded') return 'Needs attention';
  return status.connected ? 'Google account connected' : 'Not connected';
};

// turn safe provider codes into actionable nonsecret guidance
const calendarFailure = (code: string | undefined): string => {
  // keep absent diagnostics useful without inventing a cause
  if (code === undefined) return 'Refresh status or retry failed deliveries.';
  return ({
    unsupported_lifecycle_contract: 'This installed agent lifecycle contract is unsupported. Affected work is suppressed instead of using guessed times.',
    missing_lifecycle_evidence: 'RAC could not prove an exact work interval. The affected event was not created.',
    capture_store_unavailable: 'Calendar capture storage is unavailable. Agent prompts continue normally; check the private storage files before retrying.',
    capture_capacity_exceeded: 'Calendar capture storage is full. New capture is suppressed while agent prompts continue normally.',
    oauth_client_changed: 'The Google OAuth client changed. Reconnect the Google account before capturing new work.',
    oauth_authority_lost: 'This browser lost control during the operation. Take control and start the operation again.',
    oauth_transaction_invalid: 'The Google connection attempt expired or was already used. Start a new connection attempt.',
    authorization_changed: 'The Google connection changed during the operation. Refresh status before retrying.',
    calendar_create_outcome_unknown: 'Google may have created the calendar, but RAC could not prove its ID. Review Google Calendar before creating another.',
    authorization_required: 'Google authorization is missing or expired. Reconnect the Google account.',
    invalid_grant: 'Google authorization was revoked or expired. Reconnect the Google account.',
    target_missing: 'The selected calendar is unavailable. Select another RAC-created calendar.',
    retry_scheduled: 'Google temporarily rejected delivery. The failed item is scheduled for retry.',
    rate_limited: 'Google temporarily rate-limited delivery. Retryable items remain visible in the delivery counts.',
    user_rate_limited: 'Google temporarily rate-limited this account. Retryable items remain visible in the delivery counts.',
    google_calendar_disabled: 'Enable Google Calendar, save the setting, and restart RAC before connecting.',
    google_calendar_unavailable: 'Google Calendar is unavailable. Check the environment setup and provider status.',
    calendar_not_available: 'That calendar is no longer available to this RAC connection. Refresh and select another.',
    another_client_is_active: 'Another browser controls Settings. Take control before changing Google Calendar.',
    forbidden: 'This browser does not currently control Settings.',
    unauthorized: 'Sign in again before changing Google Calendar.',
    invalid_request: 'Google Calendar rejected the requested action. Refresh status before retrying.'
  } as Record<string, string>)[code] ?? 'Google Calendar reported a provider error. Refresh status before retrying.';
};

// extract only one bounded server-owned error code
const providerErrorCode = (payload: unknown): string | undefined => {
  // reject nested or unbounded error bodies
  if (payload === null || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'string' && /^[a-z0-9_]{1,80}$/u.test(error) ? error : undefined;
};

// keep live actions separate from the shared Settings save transaction
export function GoogleCalendarSettings({ setup, configuration, environment, titleTemplate, disabled, blockedByDrafts, confirmationTarget, onNotice }: GoogleCalendarSettingsProps) {
  const runtime = useSettingsRuntime();
  const { status, setStatus, loading, error, setError, refresh } = setup;
  const [busyAction, setBusyAction] = useState<'connect' | 'create' | 'select' | 'disconnect' | 'retry'>();
  const [calendarName, setCalendarName] = useState(defaultCalendarName);
  const [selectedCalendarId, setSelectedCalendarId] = useState('');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [copied, setCopied] = useState(false);
  const operationPending = useRef(false);
  const previewSequence = useRef(0);

  // follow the server-selected calendar until the operator chooses another option
  useEffect(() => { setSelectedCalendarId(status?.selectedCalendarId ?? status?.calendars[0]?.id ?? ''); }, [status?.selectedCalendarId, status?.calendars]);
  // revoke modal intent when authority changes
  useEffect(() => { setConfirmingDisconnect(false); }, [runtime.canMutate, runtime.securityEpoch]);
  // refresh when this dedicated page mounts
  useEffect(() => { void refresh(); }, [refresh]);

  // preview only locally valid templates through the canonical server renderer
  useEffect(() => {
    const syntaxError = validateTitleTemplate(titleTemplate);
    const sequence = ++previewSequence.current;
    setPreview('');
    setPreviewError(syntaxError ?? '');
    // do not send malformed or content-bearing guesses to the server
    if (syntaxError !== undefined) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await runtime.request('/api/settings/google-calendar/title-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: titleTemplate }) });
        const payload: unknown = await response.json().catch(() => undefined);
        // accept only the newest bounded preview title
        if (sequence !== previewSequence.current) return;
        const title = payload !== null && typeof payload === 'object' ? (payload as { title?: unknown }).title : undefined;
        if (!response.ok || typeof title !== 'string' || Array.from(title).length > 240 || /[\p{Cc}\p{Cs}]/u.test(title)) {
          setPreviewError('The title template could not be previewed. Check its placeholders.');
          return;
        }
        setPreview(title);
        setPreviewError('');
      } catch {
        // retain the authored template while reporting only a safe failure
        if (sequence === previewSequence.current) setPreviewError('The title preview is unavailable.');
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [runtime.request, titleTemplate]);

  const liveBlocked = disabled || blockedByDrafts || loading || busyAction !== undefined || !runtime.canMutate;
  const providerUnavailable = status?.available !== true;
  const setupIncomplete = status === undefined || !status.setup.clientId || !status.setup.clientSecret || !status.setup.tokenKey;
  const calendarNameError = calendarName.trim() === '' || Array.from(calendarName.trim()).length > 120 || /[\p{Cc}\p{Cs}]/u.test(calendarName)
    ? 'Use a calendar name between 1 and 120 visible characters.'
    : undefined;

  // apply one live mutation only after the server returns a safe summary
  const mutate = async (action: Exclude<typeof busyAction, 'connect' | undefined>, path: string, body: object, success: string) => {
    // serialize actions independently of render timing and draft state
    if (operationPending.current || liveBlocked) return;
    operationPending.current = true;
    setBusyAction(action);
    setError('');
    try {
      const response = await runtime.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload: unknown = await response.json().catch(() => undefined);
      // retain current status when mutation acknowledgement is missing or unsafe
      if (!response.ok || !isGoogleCalendarSummary(payload)) {
        onNotice('error', response.ok ? 'Google Calendar could not confirm that action. Refresh status before retrying.' : calendarFailure(providerErrorCode(payload)));
        void refresh();
        return;
      }
      setStatus(payload);
      // do not describe a safely reported degraded outcome as success
      if (payload.status === 'degraded') onNotice('error', calendarFailure(payload.lastError));
      else onNotice('success', success);
    } catch {
      onNotice('error', 'Google Calendar was interrupted. Refresh status before retrying.');
    } finally {
      operationPending.current = false;
      setBusyAction(undefined);
    }
  };

  // begin OAuth with top-level navigation rather than a popup dependency
  const connect = async () => {
    // keep drafts and unavailable setup from starting a provider transaction
    if (operationPending.current || liveBlocked || providerUnavailable || setupIncomplete) return;
    operationPending.current = true;
    setBusyAction('connect');
    setError('');
    try {
      const response = await runtime.request('/api/settings/google-calendar/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const payload: unknown = await response.json().catch(() => undefined);
      const url = authorizationUrl(payload !== null && typeof payload === 'object' ? (payload as { url?: unknown }).url : undefined);
      // navigate only to the expected Google authorization origin
      if (!response.ok || url === undefined) {
        onNotice('error', response.ok ? 'Google authorization returned an unsafe destination. Refresh status before retrying.' : calendarFailure(providerErrorCode(payload)));
        void refresh();
        return;
      }
      window.location.assign(url);
    } catch {
      onNotice('error', 'Google authorization could not be started. Check the connection and retry.');
    } finally {
      operationPending.current = false;
      setBusyAction(undefined);
    }
  };

  // copy only the public callback URI
  const copyRedirectUri = async () => {
    // omit empty setup values rather than copying a guessed callback
    if (!status?.setup.redirectUri) return;
    try {
      await navigator.clipboard.writeText(status.setup.redirectUri);
      setCopied(true);
    } catch {
      setCopied(false);
      onNotice('error', 'Copy is unavailable. Select the callback URI and copy it manually.');
    }
  };

  const selectedCalendar = status?.calendars.find(calendar => calendar.id === selectedCalendarId);
  const statusCopy = statusLabel(status, loading);

  return <div className="settings-google-calendar" data-settings-path="googleCalendar">
    <section className="settings-google-calendar-status" aria-label="Google Calendar status" aria-live="polite">
      <span><strong>{statusCopy}</strong>{status?.accountEmail && <small>{status.accountEmail}</small>}</span>
      <button type="button" disabled={busyAction !== undefined} onClick={() => { /* refresh only redacted provider status */ void refresh(); }}>{loading ? 'Refreshing…' : 'Refresh status'}</button>
    </section>
    {error && <p className="settings-google-calendar-error" role="alert">{error}</p>}
    {(status?.status === 'degraded' || status?.lastError !== undefined) && <p className="settings-google-calendar-warning" role="alert"><strong>{status.status === 'degraded' ? 'Google Calendar needs attention.' : 'Last Google Calendar issue.'}</strong> {calendarFailure(status.lastError)}</p>}
    {blockedByDrafts && <p className="settings-google-calendar-warning" role="note">Save or discard every Settings draft before connecting, creating or selecting a calendar, disconnecting, or retrying delivery.</p>}

    <section className="settings-schema-section settings-google-calendar-configuration" aria-label="Google Calendar event settings">
      <header><div><h3>Event settings</h3><p>These fields are stored in the Application source. Save changes, then restart RAC before the new capture rules take effect.</p></div></header>
      <div className="settings-google-calendar-fields">{configuration}</div>
      <div className="settings-google-calendar-template-help" data-settings-path="googleCalendar.titleTemplate.preview">
        <span>Supported placeholders</span>
        <span className="settings-google-calendar-placeholders">{/* render the fixed allowlist only */}{placeholders.map(placeholder => <code key={placeholder}>{placeholder}</code>)}</span>
        <small>Use <code>{'{{'}</code> and <code>{'}}'}</code> for literal braces. The agent placeholder expands only to a fixed agent product label. Prompt text, response content, terminal text, and paths are never available to titles.</small>
        <output aria-live="polite" aria-label="Event title preview">{previewError ? <span className="settings-field-error">{previewError}</span> : preview ? <><small>Safe server preview</small><strong>{preview}</strong></> : <small>Previewing…</small>}</output>
      </div>
      <p className="settings-google-calendar-evidence" role="note">RAC creates an event only when the selected boundaries are supported by exact lifecycle evidence. Unsupported adapters, missing evidence, contamination, or nonpositive intervals are suppressed and reported instead of using guessed times. “First question, otherwise finished” uses a supported first-question boundary when present and the exact finish boundary otherwise.</p>
    </section>

    <section className="settings-schema-section settings-google-calendar-environment" aria-label="Google Calendar Environment and keys">
      <header><div><h3>Environment &amp; keys</h3><p>Credentials remain masked and use the Environment source even while calendar capture is disabled.</p></div></header>
      {environment}
      <div className="settings-google-calendar-oauth-help">
        <p>Create a Google OAuth Web client and register this exact callback URI:</p>
        <div className="settings-google-calendar-copy-row"><code>{status?.setup.redirectUri || 'Callback URI unavailable'}</code><button type="button" disabled={!status?.setup.redirectUri} onClick={() => { /* copy public setup metadata only */ void copyRedirectUri(); }}>Copy callback URI</button></div>
        {copied && <small role="status">Callback URI copied.</small>}
        <p><code>RAC_GOOGLE_CALENDAR_TOKEN_KEY</code> uses <code>&lt;kid&gt;:&lt;key&gt;</code>, where <code>&lt;key&gt;</code> is a 32-byte base64url key. Set <code>RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY</code> only while rotating encrypted credentials.</p>
        <p>Publish the OAuth consent app to Production for durable use. Google apps left in Testing can issue refresh tokens that expire after seven days.</p>
      </div>
    </section>

    <section className="settings-schema-section settings-google-calendar-account" aria-label="Google Calendar account">
      <header><div><h3>Google account</h3><p>Connection changes are live and separate from Save changes.</p></div></header>
      <p className="settings-google-calendar-evidence" role="note" aria-label="Google Calendar data disclosure">By connecting, RAC receives your Google account ID and email and stores encrypted access and refresh tokens. RAC uses this data only to create and manage RAC-created calendars and events. Events contain configured titles and work start and end times, not prompts or responses. Google data is not used for AI training. Read the <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>.</p>
      <div className="settings-google-calendar-actions">
        <button type="button" className="settings-primary-button" disabled={liveBlocked || providerUnavailable || setupIncomplete} aria-busy={busyAction === 'connect' || undefined} onClick={() => { /* navigate through the server-created OAuth transaction */ void connect(); }}>{busyAction === 'connect' ? 'Opening Google…' : status?.connected ? 'Reconnect Google account' : 'Connect Google account'}</button>
        {status?.connected && <button type="button" className="danger" disabled={liveBlocked || confirmationTarget == null} onClick={() => { /* require explicit account disconnect confirmation */ setConfirmingDisconnect(true); }}>Disconnect</button>}
      </div>
      {status !== undefined && !status.setup.clientId && <p role="note">Add <code>RAC_GOOGLE_CALENDAR_CLIENT_ID</code> before connecting.</p>}
      {status !== undefined && !status.setup.clientSecret && <p role="note">Add <code>RAC_GOOGLE_CALENDAR_CLIENT_SECRET</code> before connecting.</p>}
      {status !== undefined && !status.setup.tokenKey && <p role="note">Add a valid <code>RAC_GOOGLE_CALENDAR_TOKEN_KEY</code> before connecting.</p>}
    </section>

    <section className="settings-schema-section settings-google-calendar-target" aria-label="Google Calendar destination">
      <header><div><h3>Calendar</h3><p>Create a dedicated calendar or select one previously created by RAC. RAC never lists or writes unrelated calendars here.</p></div></header>
      <label className="settings-google-calendar-name">New calendar name<input aria-label="New calendar name" type="text" value={calendarName} disabled={liveBlocked || providerUnavailable || !status?.connected} onChange={event => { /* retain an unsaved live-action label only in memory */ setCalendarName(event.target.value); }} /></label>
      {calendarNameError && <span className="settings-field-error" role="alert">{calendarNameError}</span>}
      <button type="button" disabled={liveBlocked || providerUnavailable || !status?.connected || calendarNameError !== undefined} onClick={() => { /* create exactly one explicitly named calendar */ void mutate('create', '/api/settings/google-calendar/calendars', { name: calendarName.trim() }, 'Google Calendar created.'); }}>{busyAction === 'create' ? 'Creating…' : 'Create calendar'}</button>
      <div className="settings-google-calendar-select">
        <span>RAC-created calendar</span>
        <SettingsSelect label="RAC-created calendar" value={selectedCalendarId} disabled={liveBlocked || providerUnavailable || !status?.connected || status.calendars.length === 0} options={(status?.calendars ?? []).map(calendar => ({ /* expose only server-returned RAC calendars */ value: calendar.id, label: calendar.name }))} onChange={value => { /* stage only the live target choice */ setSelectedCalendarId(value); }} />
        <button type="button" className="settings-primary-button" disabled={liveBlocked || providerUnavailable || !status?.connected || selectedCalendar === undefined || selectedCalendarId === status.selectedCalendarId} onClick={() => { /* select only an identifier returned by the safe status route */ void mutate('select', '/api/settings/google-calendar/select', { calendarId: selectedCalendarId }, 'Google Calendar destination updated.'); }}>{busyAction === 'select' ? 'Selecting…' : 'Use selected calendar'}</button>
      </div>
    </section>

    <section className="settings-schema-section settings-google-calendar-delivery" aria-label="Google Calendar delivery">
      <header><div><h3>Delivery</h3><p>Counts describe server-owned delivery state and never include event titles, prompts, or paths.</p></div></header>
      <dl className="settings-google-calendar-counts">
        <div><dt>Pending</dt><dd>{status?.counts.pending ?? 0}</dd></div>
        <div><dt>Delivered</dt><dd>{status?.counts.delivered ?? 0}</dd></div>
        <div><dt>Failed</dt><dd>{status?.counts.failed ?? 0}</dd></div>
        <div><dt>Suppressed</dt><dd>{status?.counts.suppressed ?? 0}</dd></div>
      </dl>
      {status?.lastSuccessAt && <small>Last successful delivery: {status.lastSuccessAt}</small>}
      <button type="button" disabled={liveBlocked || providerUnavailable || (status?.counts.failed ?? 0) === 0} onClick={() => { /* retry only server-classified failed deliveries */ void mutate('retry', '/api/settings/google-calendar/retry', {}, 'Failed Google Calendar deliveries released for retry.'); }}>{busyAction === 'retry' ? 'Retrying…' : 'Retry failed deliveries'}</button>
    </section>

    {confirmingDisconnect && confirmationTarget != null && <SplitConfirmation target={confirmationTarget} title="Disconnect Google Calendar?" description="RAC will remove its saved Google authorization and stop delivery. Existing Google calendars and events are not deleted." confirmLabel="Disconnect" pending={busyAction === 'disconnect'} onCancel={() => { /* preserve the current connection */ setConfirmingDisconnect(false); }} onConfirm={async () => { /* remove only RAC authorization */ await mutate('disconnect', '/api/settings/google-calendar/disconnect', {}, 'Google Calendar disconnected.'); setConfirmingDisconnect(false); }} />}
  </div>;
}
