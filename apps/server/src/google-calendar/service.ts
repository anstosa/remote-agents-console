import { cancelGoogleResponse } from './bounded-response.js';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { CalendarAdmission, CalendarCaptureSink, CalendarSignal, CalendarSummary, GoogleCalendarConfig } from './contracts.js';
import { createGoogleCalendar, deliverGoogleEvent } from './google-api.js';
import { exchangeAuthorizationCode, OAuthTransactions, refreshAuthorization, validateIdToken, type OAuthConfiguration } from './oauth.js';
import type { CalendarActivity, GoogleAuthState, TokenKey } from './provider-types.js';
import { GoogleCalendarError } from './provider-types.js';
import { ActivityStore, AuthStore, publishPrivateStage } from './store.js';
import { renderCalendarTitle, validateTitleTemplate } from './title.js';
import { calendarEventIdentity } from './event-identity.js';
import { normalizeCalendarLabels as safeLabels } from './agent-labels.js';

const dispatchIntervalMs = 1_000;
const maximumAttempts = 8;
const maximumAttemptAgeMs = 24 * 60 * 60 * 1_000;
const evidenceFailureReasons: ReadonlySet<string> = new Set(['unsupported_lifecycle_contract', 'missing_lifecycle_evidence', 'capture_capacity_exceeded', 'capture_store_unavailable']);

export type CallbackAuthority = {
  sessionId: string;
  reservationGeneration: string;
  reservationGenerationOf: (sessionId: string) => string | undefined;
  renewReservation: (sessionId: string, generation: string) => boolean;
  isSessionValid: (sessionId: string) => boolean;
  code: string;
  state: string;
};

export type OperationAuthority = Omit<CallbackAuthority, 'code' | 'state'>;

type ConnectionSnapshot = { generation: number; auth?: GoogleAuthState; tombstone?: GoogleAuthState };
type AuthorizedSnapshot = { generation: number; auth: GoogleAuthState };

export type GoogleCalendarService = CalendarCaptureSink & {
  summary: () => CalendarSummary;
  start: () => void;
  stop: () => Promise<void>;
  beginConnect: (sessionId: string, reservationGeneration: string) => string;
  completeConnect: (authority: CallbackAuthority) => Promise<void>;
  createCalendar: (name: unknown, authority: OperationAuthority) => Promise<CalendarSummary>;
  selectCalendar: (calendarId: string, authority: OperationAuthority) => Promise<CalendarSummary>;
  disconnect: (authority: OperationAuthority) => Promise<CalendarSummary>;
  retry: (authority: OperationAuthority) => Promise<CalendarSummary>;
  preview: (template: string) => string;
  dispatch: () => Promise<void>;
};

type ServiceConstruction = {
  config: GoogleCalendarConfig;
  publicOrigin: string;
  clientId: string;
  clientSecret: string;
  activeKey: TokenKey;
  previousKey?: TokenKey;
  authPath: string;
  activitiesPath: string;
  fetcher: typeof fetch;
  now: () => number;
};

// implement durable capture, authorization, and delivery without affecting prompt outcomes
export class ActiveGoogleCalendarService implements GoogleCalendarService {
  private readonly activities: ActivityStore;
  private readonly authStore: AuthStore;
  private readonly transactions = new OAuthTransactions();
  private readonly oauth: OAuthConfiguration;
  private auth?: GoogleAuthState;
  private tombstone?: GoogleAuthState;
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  private stopping = false;
  private dispatchAbort?: AbortController;
  private lastError?: string;
  private lastSuccessAt?: string;
  private connectionGeneration = 0;
  private authStageSequence = 0;

  // bind one immutable runtime configuration generation
  constructor(private readonly options: ServiceConstruction) {
    this.activities = new ActivityStore(options.activitiesPath, options.now);
    this.authStore = new AuthStore(options.authPath, options.activeKey, options.previousKey);
    const redirectUri = `${options.publicOrigin.replace(/\/$/u, '')}/api/settings/google-calendar/oauth/callback`;
    const clientGeneration = createHash('sha256').update(options.clientId).update('\0').update(redirectUri).update('\0').update(options.clientSecret).update('\0').update(options.activeKey.kid).update('\0').update(options.activeKey.bytes).digest('hex');
    this.oauth = { clientId: options.clientId, clientSecret: options.clientSecret, redirectUri, clientGeneration };
  }

  // load private stores after core server configuration succeeds
  async initialize(): Promise<void> {
    await this.authStore.cleanupStages();
    await this.activities.load();
    const stored = await this.authStore.load();
    // discard credentials issued to a replaced oauth client
    if (stored !== undefined && stored.clientId !== this.oauth.clientId) {
      await this.authStore.remove();
      this.lastError = 'oauth_client_changed';
      return;
    }
    // separate token-free reconnect lineage from active authorization
    if (stored?.disconnected === true) this.tombstone = stored;
    else this.auth = stored;
  }

  // expose a bounded secret-free provider snapshot
  summary(): CalendarSummary {
    const records = this.activities.list();
    const recordError = latestEvidenceFailure(records);
    const visibleError = this.lastError ?? recordError;
    const counts = {
      pending: records.filter(record => ['admitted', 'ready', 'delivering'].includes(record.status)).length,
      delivered: records.filter(record => record.status === 'delivered').length,
      failed: records.filter(record => ['retry_scheduled', 'authorization_required', 'dead_letter', 'ownership_conflict', 'deleted_by_user', 'target_missing', 'awaiting_evidence'].includes(record.status)).length,
      suppressed: records.filter(record => record.status === 'suppressed').length
    };
    const connected = this.auth !== undefined;
    const lineage = this.auth ?? this.tombstone;
    const selectedCalendarId = lineage?.selectedCalendarId;
    return {
      enabled: this.options.config.enabled,
      available: true,
      connected,
      status: connected ? selectedCalendarId === undefined ? 'connected' : 'ready' : 'setup_required',
      ...(this.auth?.principal.email === undefined ? {} : { accountEmail: this.auth.principal.email }),
      calendars: lineage?.calendars.map(calendar => ({ ...calendar })) ?? [],
      ...(selectedCalendarId === undefined ? {} : { selectedCalendarId }),
      setup: { clientId: true, clientSecret: true, tokenKey: true, redirectUri: this.oauth.redirectUri },
      counts,
      ...(visibleError === undefined ? {} : { lastError: visibleError }),
      ...(this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt })
    };
  }

  // admit one immutable policy and target snapshot
  async admit(input: CalendarAdmission): Promise<boolean> {
    try {
      const target = this.auth?.calendars.find(calendar => calendar.id === this.auth?.selectedCalendarId);
      const status = target === undefined ? 'suppressed' : 'admitted';
      const reason = target === undefined ? 'not_connected' : undefined;
      const activity: CalendarActivity = {
        version: 1,
        id: input.id,
        agentId: input.agentId,
        kind: input.kind,
        submittedAt: input.submittedAt,
        labels: safeLabels(input.labels, input.kind),
        policy: structuredClone(this.options.config),
        ...(target === undefined ? {} : { target: { ...target }, principalSub: this.auth!.principal.sub }),
        status,
        ...(reason === undefined ? {} : { reason }),
        attempts: 0,
        ...(status === 'suppressed' ? { completedAt: this.options.now() } : {})
      };
      const added = await this.activities.add(activity);
      const stored = this.activities.get(input.id);
      // new rows may have been suppressed by the serialized capacity decision
      if (added) return stored?.status === 'admitted';
      // resume only the unchanged durable intent instead of reopening settled evidence
      return stored?.status === 'admitted' && stored.target !== undefined && stored.principalSub !== undefined && stored.agentId === input.agentId && stored.kind === input.kind && stored.submittedAt === input.submittedAt;
    } catch (error) {
      // distinguish a deliberate hard-cap refusal from unavailable private storage
      this.lastError = error instanceof Error && error.message === 'capture_capacity_exceeded' ? 'capture_capacity_exceeded' : 'capture_store_unavailable';
      return false;
    }
  }

  // persist one exact lifecycle signal without blocking its caller
  async signal(input: CalendarSignal): Promise<void> {
    try {
      await this.activities.update(input.id, activity => this.applySignal(activity, input));
      this.scheduleDispatch();
    } catch (error) {
      this.lastError = 'capture_store_unavailable';
      throw error;
    }
  }

  // begin bounded background delivery
  start(): void {
    // avoid duplicate workers across repeated app hooks
    if (this.timer !== undefined) return;
    this.stopping = false;
    this.timer = setInterval(() => { this.scheduleDispatch(); }, dispatchIntervalMs);
    this.timer.unref();
    this.scheduleDispatch();
  }

  // stop future work and await the current synchronous turn
  async stop(): Promise<void> {
    this.stopping = true;
    // clear a live worker only once
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.dispatchAbort?.abort();
    // let an active dispatch finish its current awaited request
    while (this.dispatching) await new Promise(resolve => setTimeout(resolve, 5));
  }

  // create one controller-bound authorization url
  beginConnect(sessionId: string, reservationGeneration: string): string {
    return this.transactions.begin(this.oauth, sessionId, reservationGeneration, this.options.now()).url;
  }

  // exchange and publish one callback behind repeated authority fences
  async completeConnect(authority: CallbackAuthority): Promise<void> {
    const transaction = this.transactions.consume(authority.state, this.options.now());
    let stage: string | undefined;
    const fence = (): void => {
      // retain only the initiating live session and exact reservation generation
      if (transaction.sessionId !== authority.sessionId || transaction.reservationGeneration !== authority.reservationGeneration || transaction.clientGeneration !== this.oauth.clientGeneration || transaction.expiresAt <= this.options.now()) throw new GoogleCalendarError('oauth_authority_lost', 403);
      this.fenceOperation(authority);
    };
    try {
      fence();
      // terminate denied and malformed callbacks without provider work
      if (authority.code.length < 1 || authority.code.length > 8192) throw new GoogleCalendarError('oauth_transaction_invalid', 400);
      const exchanged = await exchangeAuthorizationCode(this.oauth, transaction, authority.code, this.options.fetcher, this.options.now());
      fence();
      const principal = await validateIdToken(exchanged.idToken, this.oauth.clientId, transaction.nonce, this.options.fetcher, this.options.now());
      fence();
      const connection = this.connectionSnapshot();
      const prior = connection.auth ?? connection.tombstone;
      const samePrincipal = prior?.clientId === this.oauth.clientId && prior.principal.sub === principal.sub;
      const refreshToken = exchanged.tokens.refreshToken ?? (samePrincipal ? connection.auth?.tokens.refreshToken : undefined);
      // publish connected state only with a renewable grant from this active lineage
      if (refreshToken === undefined || refreshToken.length === 0) throw new GoogleCalendarError('authorization_required', 401);
      const next: GoogleAuthState = {
        version: 1,
        clientId: this.oauth.clientId,
        principal,
        tokens: { ...exchanged.tokens, refreshToken },
        calendars: samePrincipal ? prior?.calendars.map(calendar => ({ ...calendar })) ?? [] : [],
        ...(samePrincipal && prior?.selectedCalendarId !== undefined ? { selectedCalendarId: prior.selectedCalendarId } : {})
      };
      stage = await this.authStore.stage(next, transaction.state);
      fence();
      this.assertConnection(connection);
      publishPrivateStage(stage, this.authStore.path);
      this.publishAuth(next);
      stage = undefined;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof GoogleCalendarError ? error.code : 'oauth_transaction_invalid';
      throw error;
    } finally {
      // remove transaction-private ciphertext after every failed branch
      if (stage !== undefined) await rm(stage, { force: true }).catch(() => undefined);
    }
  }

  // create exactly one app-owned calendar and record its returned identity
  async createCalendar(name: unknown, authority: OperationAuthority): Promise<CalendarSummary> {
    this.fenceOperation(authority);
    const connection = await this.authorized(authority);
    let calendar;
    try {
      this.fenceOperation(authority);
      this.assertAuthorized(connection);
      calendar = await createGoogleCalendar(this.options.fetcher, connection.auth.tokens.accessToken, name);
    }
    catch (error) {
      this.lastError = error instanceof GoogleCalendarError ? error.code : 'calendar_create_outcome_unknown';
      throw error;
    }
    const next = { ...connection.auth, calendars: [...connection.auth.calendars.filter(candidate => candidate.id !== calendar.id), calendar] };
    try { await this.commitAuth(next, this.connectionSnapshotFromAuthorized(connection), authority); }
    catch {
      this.lastError = 'calendar_create_outcome_unknown';
      throw new GoogleCalendarError('calendar_create_outcome_unknown', 503);
    }
    this.lastError = undefined;
    return this.summary();
  }

  // select only a calendar created by this exact connection lineage
  async selectCalendar(calendarId: string, authority: OperationAuthority): Promise<CalendarSummary> {
    this.fenceOperation(authority);
    const connection = this.authorizedSnapshot();
    // reject arbitrary owned calendar ids
    if (!connection.auth.calendars.some(calendar => calendar.id === calendarId)) throw new GoogleCalendarError('calendar_not_available', 400);
    const next = { ...connection.auth, selectedCalendarId: calendarId };
    await this.commitAuth(next, this.connectionSnapshotFromAuthorized(connection), authority);
    return this.summary();
  }

  // revoke best-effort and always remove local token material
  async disconnect(authority: OperationAuthority): Promise<CalendarSummary> {
    this.fenceOperation(authority);
    const connection = this.connectionSnapshot();
    const token = connection.auth?.tokens.refreshToken ?? connection.auth?.tokens.accessToken;
    // attempt provider revocation without blocking local disconnect
    if (token !== undefined) await this.options.fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }).then(cancelGoogleResponse).catch(() => undefined);
    this.fenceOperation(authority);
    this.assertConnection(connection);
    const lineage = connection.auth;
    // retain only encrypted non-token lineage needed to prevent retargeting
    if (lineage !== undefined) {
      const tombstone: GoogleAuthState = { version: 1, clientId: lineage.clientId, principal: { sub: lineage.principal.sub }, tokens: { accessToken: '', expiresAt: 0 }, calendars: lineage.calendars.map(calendar => ({ ...calendar })), ...(lineage.selectedCalendarId === undefined ? {} : { selectedCalendarId: lineage.selectedCalendarId }), disconnected: true };
      await this.commitAuth(tombstone, connection, authority);
    }
    return this.summary();
  }

  // release only eligible jobs for their immutable targets
  async retry(authority: OperationAuthority): Promise<CalendarSummary> {
    this.fenceOperation(authority);
    const connection = this.connectionSnapshot();
    const auth = connection.auth;
    // keep retry inert until one connection is restored
    if (auth === undefined) return this.summary();
    const selectedIds = new Set(auth.calendars.map(calendar => calendar.id));
    await this.activities.updateAllFenced(records => {
      for (const record of records) {
        // release retryable or same-principal authorization rows only
        if ((record.status === 'retry_scheduled' || record.status === 'authorization_required' || record.status === 'dead_letter' && record.lastError === 'retry_scheduled') && record.target !== undefined && selectedIds.has(record.target.id) && record.principalSub === auth.principal.sub) {
          record.status = 'ready';
          record.nextAttemptAt = this.options.now();
          record.lastError = undefined;
          record.attempts = 0;
          record.firstAttemptAt = undefined;
          record.completedAt = undefined;
          record.reason = undefined;
        }
      }
    }, () => { this.fenceOperation(authority); this.assertConnection(connection); });
    this.scheduleDispatch();
    return this.summary();
  }

  // render one fixed-data preview through the shared strict parser
  preview(template: string): string {
    const issue = validateTitleTemplate(template);
    // block invalid authoring before runtime rendering
    if (issue !== undefined) throw new GoogleCalendarError('invalid_title_template', 400);
    return renderCalendarTitle(template, { worktree: 'Cora', project: 'Remote Agents', agent: 'Codex' });
  }

  // dispatch due rows without overlapping workers
  async dispatch(): Promise<void> {
    // serialize the background worker
    if (this.dispatching || this.auth === undefined || this.stopping) return;
    this.dispatching = true;
    const controller = new AbortController();
    this.dispatchAbort = controller;
    const fetcher = abortableFetch(this.options.fetcher, controller.signal);
    try {
      const now = this.options.now();
      const due = this.activities.list().filter(activity => (activity.status === 'ready' || activity.status === 'retry_scheduled' || activity.status === 'delivering') && (activity.nextAttemptAt ?? 0) <= now).sort((left, right) => (left.firstAttemptAt ?? 0) - (right.firstAttemptAt ?? 0));
      const targets = new Set<string>();
      for (const activity of due) {
        // exit between jobs once shutdown begins
        if (this.stopping) break;
        // permit only one request for each immutable target per pass
        if (activity.target === undefined || targets.has(activity.target.id)) continue;
        targets.add(activity.target.id);
        await this.deliver(activity, fetcher);
      }
    } catch {
      this.lastError = 'capture_store_unavailable';
    } finally {
      // release only this dispatch generation controller
      if (this.dispatchAbort === controller) this.dispatchAbort = undefined;
      this.dispatching = false;
    }
  }

  // contain background delivery failures outside prompt and app lifecycles
  private scheduleDispatch(): void { void this.dispatch().catch(() => { this.lastError = 'capture_store_unavailable'; }); }

  // apply one monotonic lifecycle transition
  private applySignal(activity: CalendarActivity, input: CalendarSignal): void {
    // ignore finalized and suppressed rows
    if (activity.status !== 'admitted') return;
    // fail closed on explicit correlation invalidation
    if (input.type === 'invalid') {
      activity.status = 'awaiting_evidence';
      activity.reason = safeReason(input.reason, 'missing_lifecycle_evidence');
      activity.completedAt = this.options.now();
      return;
    }
    const at = validInstant(input.at);
    // require exact positive timestamps for every evidence signal
    if (at === undefined) {
      activity.status = 'awaiting_evidence';
      activity.reason = 'missing_lifecycle_evidence';
      activity.completedAt = this.options.now();
      return;
    }
    // capture the pre-dispatch intent instant once
    if (input.type === 'sent' && activity.sentAt === undefined) activity.sentAt = at;
    // capture proven work start and safe labels once
    if (input.type === 'started' && activity.startedAt === undefined) {
      activity.startedAt = at;
      // snapshot only lifecycle-supplied safe labels
      if (input.labels !== undefined) activity.labels = safeLabels(input.labels);
    }
    // capture the first exact question once
    if (input.type === 'question' && activity.questionAt === undefined) activity.questionAt = at;
    // capture the matching finish once
    if (input.type === 'finished' && activity.finishedAt === undefined) activity.finishedAt = at;
    const shouldFinalize = input.type === 'finished' || input.type === 'question' && activity.policy.endMoment === 'first_question_or_finished';
    // finalize only at the selected terminal boundary
    if (!shouldFinalize) return;
    this.finalize(activity, input.type === 'question' ? activity.questionAt : activity.finishedAt);
  }

  // atomically derive one immutable interval and outbox identity
  private finalize(activity: CalendarActivity, end: string | undefined): void {
    // a malformed storage collaborator cannot authorize a destination or cause a raw dereference
    if (activity.target === undefined || activity.principalSub === undefined) throw new GoogleCalendarError('capture_store_unavailable', 503);
    const start = activity.policy.startMoment === 'prompt_submitted' ? validInstant(activity.submittedAt) : activity.policy.startMoment === 'prompt_sent' ? activity.sentAt : activity.startedAt;
    const startMs = start === undefined ? Number.NaN : Date.parse(start);
    const endMs = end === undefined ? Number.NaN : Date.parse(end);
    // require proven start eligibility and a positive selected interval
    if (activity.startedAt === undefined || start === undefined || end === undefined || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      activity.status = 'awaiting_evidence';
      activity.reason = 'missing_lifecycle_evidence';
      activity.completedAt = this.options.now();
      return;
    }
    const target = activity.target;
    const { eventId, marker } = calendarEventIdentity(target.id, activity.id);
    activity.startAt = start;
    activity.endAt = end;
    activity.summary = renderCalendarTitle(activity.policy.titleTemplate, activity.labels);
    activity.eventId = eventId;
    activity.marker = marker;
    activity.status = 'ready';
    activity.nextAttemptAt = this.options.now();
  }

  // obtain a fresh access token without changing account or target identity
  private async authorized(authority?: OperationAuthority, fetcher: typeof fetch = this.options.fetcher): Promise<AuthorizedSnapshot> {
    // reject a displaced manual operation before reading credentials
    if (authority !== undefined) this.fenceOperation(authority);
    const connection = this.authorizedSnapshot();
    // keep a token with a small expiry margin
    if (connection.auth.tokens.expiresAt > this.options.now() + 60_000) return connection;
    // require a refresh grant when the access token expires
    if (connection.auth.tokens.refreshToken === undefined) throw new GoogleCalendarError('authorization_required', 401);
    const tokens = await refreshAuthorization(this.oauth, connection.auth.tokens.refreshToken, fetcher, this.options.now());
    const next = { ...connection.auth, tokens };
    await this.commitAuth(next, this.connectionSnapshotFromAuthorized(connection), authority);
    return { generation: this.connectionGeneration, auth: next };
  }

  // capture one exact connected identity generation
  private authorizedSnapshot(): AuthorizedSnapshot {
    // keep setup mutations inert while disconnected
    if (this.auth === undefined) throw new GoogleCalendarError('authorization_required', 401);
    return { generation: this.connectionGeneration, auth: this.auth };
  }

  // capture both active and reconnect-lineage state for compare-and-swap
  private connectionSnapshot(): ConnectionSnapshot {
    return { generation: this.connectionGeneration, ...(this.auth === undefined ? {} : { auth: this.auth }), ...(this.tombstone === undefined ? {} : { tombstone: this.tombstone }) };
  }

  // expand one connected snapshot into the full compare-and-swap shape
  private connectionSnapshotFromAuthorized(connection: AuthorizedSnapshot): ConnectionSnapshot {
    return { generation: connection.generation, auth: connection.auth, ...(this.tombstone === undefined ? {} : { tombstone: this.tombstone }) };
  }

  // reject credentials that were disconnected or replaced during an await
  private assertAuthorized(connection: AuthorizedSnapshot): void {
    // bind use to the exact in-memory authorization object and generation
    if (this.connectionGeneration !== connection.generation || this.auth !== connection.auth) throw new GoogleCalendarError('authorization_changed', 409);
  }

  // reject any active or tombstone state changed during an await
  private assertConnection(connection: ConnectionSnapshot): void {
    // compare every connection lineage pointer under one generation
    if (this.connectionGeneration !== connection.generation || this.auth !== connection.auth || this.tombstone !== connection.tombstone) throw new GoogleCalendarError('authorization_changed', 409);
  }

  // require the initiating live session and exact controller reservation
  private fenceOperation(authority: OperationAuthority): void {
    // fail closed before renewing any mismatched controller
    if (authority.sessionId.length < 1 || authority.reservationGeneration.length < 1 || !authority.isSessionValid(authority.sessionId) || authority.reservationGenerationOf(authority.sessionId) !== authority.reservationGeneration || !authority.renewReservation(authority.sessionId, authority.reservationGeneration)) throw new GoogleCalendarError('oauth_authority_lost', 403);
  }

  // stage encrypted state then publish only after final authority and cas checks
  private async commitAuth(next: GoogleAuthState, expected: ConnectionSnapshot, authority?: OperationAuthority): Promise<void> {
    const suffix = `operation-${++this.authStageSequence}`;
    let stage: string | undefined;
    try {
      stage = await this.authStore.stage(next, suffix);
      // recheck manual authority after the private filesystem await
      if (authority !== undefined) this.fenceOperation(authority);
      this.assertConnection(expected);
      publishPrivateStage(stage, this.authStore.path);
      this.publishAuth(next);
      stage = undefined;
    } finally {
      // remove only an unpublished encrypted operation stage
      if (stage !== undefined) await rm(stage, { force: true }).catch(() => undefined);
    }
  }

  // publish one committed connected or token-free lineage generation
  private publishAuth(next: GoogleAuthState): void {
    // separate disconnected lineage from usable credentials
    if (next.disconnected === true) {
      this.auth = undefined;
      this.tombstone = next;
    } else {
      this.auth = next;
      this.tombstone = undefined;
    }
    this.connectionGeneration += 1;
  }

  // deliver one persisted record with bounded retries
  private async deliver(snapshot: CalendarActivity, fetcher: typeof fetch): Promise<void> {
    const firstAttemptAt = snapshot.firstAttemptAt ?? this.options.now();
    const attempts = snapshot.attempts + 1;
    // dead-letter exhausted retry budgets before any provider request
    if (snapshot.attempts >= maximumAttempts || snapshot.firstAttemptAt !== undefined && this.options.now() - snapshot.firstAttemptAt >= maximumAttemptAgeMs) {
      await this.activities.update(snapshot.id, activity => { activity.status = 'dead_letter'; activity.lastError = 'retry_scheduled'; activity.completedAt = this.options.now(); });
      this.lastError = 'retry_scheduled';
      return;
    }
    await this.activities.update(snapshot.id, activity => { activity.status = 'delivering'; activity.firstAttemptAt = firstAttemptAt; activity.attempts = attempts; });
    let result;
    try {
      const connection = await this.authorized(undefined, fetcher);
      const auth = connection.auth;
      // never use replacement-account credentials for old work
      if (snapshot.principalSub !== auth.principal.sub || snapshot.target === undefined || !auth.calendars.some(calendar => calendar.id === snapshot.target!.id)) result = { kind: 'authorization_required' } as const;
      else {
        this.assertAuthorized(connection);
        result = await deliverGoogleEvent(fetcher, auth.tokens.accessToken, { ...snapshot, attempts });
      }
    } catch (error) {
      result = { kind: error instanceof GoogleCalendarError && error.code === 'authorization_required' ? 'authorization_required' : 'retry', delayMs: 1_000, reason: 'retry_scheduled' } as const;
    }
    await this.activities.update(snapshot.id, activity => {
      // settle a confirmed exact-id delivery
      if (result.kind === 'delivered') {
        activity.status = 'delivered';
        activity.completedAt = this.options.now();
        activity.lastError = undefined;
        this.lastSuccessAt = new Date(this.options.now()).toISOString();
        this.lastError = undefined;
        return;
      }
      // stop retries after either configured bound
      if (result.kind === 'retry' && attempts < maximumAttempts && this.options.now() - firstAttemptAt < maximumAttemptAgeMs) {
        activity.status = 'retry_scheduled';
        activity.nextAttemptAt = this.options.now() + result.delayMs;
        activity.lastError = 'retry_scheduled';
        this.lastError = 'retry_scheduled';
        return;
      }
      // retain exact terminal classification without provider details
      activity.status = result.kind === 'retry' || result.kind === 'permanent' ? 'dead_letter' : result.kind;
      activity.lastError = result.kind === 'permanent' ? result.reason : result.kind === 'retry' ? 'retry_scheduled' : result.kind;
      activity.completedAt = this.options.now();
      this.lastError = activity.lastError;
    });
  }
}

// normalize only parseable positive instants
function validInstant(value: string | undefined): string | undefined {
  // reject absent and nonpositive instants
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : undefined;
}

// retain only known safe lifecycle reasons
function safeReason(value: string | undefined, fallback: string): string {
  return value !== undefined && evidenceFailureReasons.has(value) ? value : fallback;
}

// select the newest durable bounded evidence failure for restart-safe status
function latestEvidenceFailure(records: CalendarActivity[]): string | undefined {
  let latest: CalendarActivity | undefined;
  for (const record of records) {
    // retain the newest valid reason and prefer later rows on timestamp ties
    if (record.status === 'awaiting_evidence' && record.reason !== undefined && evidenceFailureReasons.has(record.reason) && (record.completedAt ?? 0) >= (latest?.completedAt ?? 0)) latest = record;
  }
  return latest?.reason;
}

// reject an in-flight background fetch immediately when shutdown aborts
function abortableFetch(fetcher: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const combined = init?.signal == null ? signal : AbortSignal.any([signal, init.signal]);
    // avoid starting work after shutdown already began
    if (combined.aborted) throw new Error('dispatch_aborted');
    return await new Promise<Response>((resolve, reject) => {
      // settle the wrapper without waiting for an abort-insensitive test double
      const aborted = (): void => { reject(new Error('dispatch_aborted')); };
      combined.addEventListener('abort', aborted, { once: true });
      void fetcher(input, { ...init, signal: combined }).then(resolve, reject).finally(() => { combined.removeEventListener('abort', aborted); });
    });
  };
}
