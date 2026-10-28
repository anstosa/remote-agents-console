import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SettingsOperation, SettingsRequest, SettingsStatus } from './contracts.js';
import { isSettingsOperation, isSettingsStatus, settingsResponseError } from './contracts.js';
import { FullscreenLoader, type FullscreenAction } from '../fullscreen-loader.js';

type SettingsRuntime = {
  request: SettingsRequest;
  status?: SettingsStatus;
  statusError?: string;
  restartPending: boolean;
  restart: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  securityEpoch: number;
  canMutate: boolean;
  restartResult?: SettingsOperation;
  dismissRestartResult: () => void;
};

const SettingsRuntimeContext = createContext<SettingsRuntime | undefined>(undefined);

const dismissedRestartKey = 'rac.settings.dismissed-restart-result';

// retain dismissal across reloads without persisting credentials or source content
const readDismissedRestart = (): string | undefined => {
  try { return localStorage.getItem(dismissedRestartKey) ?? undefined; } catch { return undefined; }
};

// distinguish a server restart from connector-only setup work
const activeServerRestart = (operation: SettingsOperation | undefined): boolean => (operation?.state === 'queued' || operation?.state === 'running') && (operation.kind !== 'cloudflare' || operation.restart !== undefined);

// keep restart state alive outside the settings panel
export function SettingsRuntimeProvider({ request, children, enabled = true, canMutate = true, beforeRestart, onRestartSettled }: { request: SettingsRequest; children: ReactNode; enabled?: boolean; canMutate?: boolean; beforeRestart?: () => Promise<boolean>; onRestartSettled?: () => void }) {
  const [status, setStatus] = useState<SettingsStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [restartPending, setRestartPending] = useState(false);
  const [securityEpoch, setSecurityEpoch] = useState(0);
  const [dismissedRestart, setDismissedRestart] = useState(readDismissedRestart);
  const statusRequest = useRef(0);
  const restartAttempt = useRef(0);
  const submittingRestart = useRef(false);
  const awaitingRestartStatus = useRef(false);
  const mounted = useRef(true);
  const authenticationEnabled = useRef(enabled);
  const authenticationEpoch = useRef(0);
  const mutationAllowed = useRef(enabled && canMutate);
  // invalidate callbacks from an earlier authenticated session without losing control-only tracking
  if (authenticationEnabled.current !== enabled) {
    authenticationEnabled.current = enabled;
    authenticationEpoch.current += 1;
  }
  mutationAllowed.current = enabled && canMutate;
  // prevent delayed fade or poll callbacks from mutating a detached provider
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; awaitingRestartStatus.current = false; restartAttempt.current += 1; statusRequest.current += 1; };
  }, []);

  // load server-owned pending and operation state
  const refreshStatus = useCallback(async () => {
    // do not probe protected status before authentication
    if (!enabled || !authenticationEnabled.current || !mounted.current) return;
    const sequence = ++statusRequest.current;
    const epoch = authenticationEpoch.current;
    // reject stale reads even if authentication was lost and then restored
    const currentRead = () => sequence === statusRequest.current && epoch === authenticationEpoch.current && authenticationEnabled.current && mounted.current;
    try {
      const response = await request('/api/settings/status', { cache: 'no-store' });
      const payload: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
      // ignore slower reads superseded by a newer poll or accepted restart
      if (!currentRead()) return;
      // retain the prior deadline and operation across transient status failures
      if (!response.ok || !isSettingsStatus(payload)) {
        const message = response.ok ? 'Settings status is unavailable.' : await settingsResponseError(response, 'Settings status is unavailable.');
        // a delayed error body must not overwrite a newer successful poll
        if (currentRead()) setStatusError(message);
        return;
      }
      setStatus(payload);
      setStatusError(undefined);
      // retain the fullscreen handoff until a fresh status proves the host has settled
      if (awaitingRestartStatus.current && !submittingRestart.current && !activeServerRestart(payload.operation)) {
        awaitingRestartStatus.current = false;
        onRestartSettled?.();
      }
    } catch {
      // keep the countdown alive while the server is temporarily unreachable
      if (currentRead()) setStatusError('Reconnecting to the server…');
    }
  }, [enabled, onRestartSettled, request]);

  const pollingMs = restartPending || status?.operation?.state === 'queued' || status?.operation?.state === 'running' ? 1_000 : 4_000;
  // recover status at mount and poll it independently of the settings page
  useEffect(() => {
    // wait for an authenticated session
    if (!enabled) {
      setStatus(undefined); setStatusError(undefined);
      restartAttempt.current += 1;
      submittingRestart.current = false;
      setRestartPending(false);
      // authentication loss must not leave a local transition covering the login screen
      if (awaitingRestartStatus.current) { awaitingRestartStatus.current = false; onRestartSettled?.(); }
      return;
    }
    let disposed = false;
    const poll = async () => {
      // stop updates after provider teardown
      if (disposed) return;
      await refreshStatus();
    };
    void poll();
    const interval = window.setInterval(() => { /* refresh durable status */ void poll(); }, pollingMs);
    const visible = () => { /* refresh after backgrounding */ if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; statusRequest.current += 1; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [enabled, onRestartSettled, pollingMs, refreshStatus]);

  // clear disclosure memory when control authority changes
  useEffect(() => { setSecurityEpoch(current => current + 1); }, [canMutate]);

  // invalidate disclosure memory on network and page lifecycle changes
  useEffect(() => {
    const invalidate = () => setSecurityEpoch(current => current + 1);
    window.addEventListener('online', invalidate);
    window.addEventListener('pagehide', invalidate);
    return () => { window.removeEventListener('online', invalidate); window.removeEventListener('pagehide', invalidate); };
  }, []);

  // start the fixed server-owned restart operation
  const restart = useCallback(async () => {
    // serialize repeated restart clicks in this browser
    if (submittingRestart.current || awaitingRestartStatus.current || !mutationAllowed.current) return;
    submittingRestart.current = true;
    awaitingRestartStatus.current = true;
    setRestartPending(true);
    setStatusError(undefined);
    let submitted = false;
    const epoch = authenticationEpoch.current;
    const attempt = ++restartAttempt.current;
    // retain observation after control loss but never cross an authentication boundary
    const currentSession = () => mounted.current && authenticationEnabled.current && epoch === authenticationEpoch.current && attempt === restartAttempt.current;
    try {
      const entered = await (beforeRestart?.() ?? Promise.resolve(true));
      // recheck control authority after painting and never submit a cancelled transition
      if (!entered || !mutationAllowed.current || !currentSession()) {
        // an old attempt must not release a newer session's cover
        if (attempt === restartAttempt.current) {
          awaitingRestartStatus.current = false;
          if (mounted.current) onRestartSettled?.();
        }
        return;
      }
      submitted = true;
      const response = await request('/api/settings/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      // ignore acknowledgements after the authenticated provider has detached
      if (!currentSession()) return;
      // distinguish explicit rejection from an unavailable acknowledgement
      if (!response.ok) {
        const message = await settingsResponseError(response, 'Restart could not be started.');
        // an error body may finish after provider teardown
        if (!currentSession()) return;
        const rejected = response.status >= 400 && response.status < 500;
        setStatusError(rejected ? message : `${message} Checking restart progress…`);
        // transport failures become synthetic 503 responses in the shared request helper
        if (rejected) {
          awaitingRestartStatus.current = false;
          onRestartSettled?.();
        }
        return;
      }
      const payload: unknown = await response.json().catch(() => undefined);
      // parsing may outlive the application that requested the restart
      if (!currentSession()) return;
      statusRequest.current += 1;
      // accept either the status envelope or one operation response
      if (isSettingsStatus(payload)) { setStatus(payload); setStatusError(undefined); }
      else if (isSettingsOperation(payload)) { setStatus(current => current === undefined ? current : { ...current, operation: payload }); setStatusError(undefined); }
      else setStatusError('Checking restart progress…');
      setSecurityEpoch(current => current + 1);
    } catch {
      // never update or release another app instance after teardown
      if (!currentSession()) return;
      // an interrupted acknowledgement is not proof that the host rejected the restart
      if (submitted) setStatusError('Reconnecting to check restart progress…');
      else {
        awaitingRestartStatus.current = false;
        setStatusError('Restart could not be started.');
        onRestartSettled?.();
      }
    } finally {
      // retired requests must not unlock or invalidate a newer attempt
      if (attempt === restartAttempt.current) {
        submittingRestart.current = false;
        statusRequest.current += 1;
        // only post-submission status reads may release an ambiguous handoff
        if (mounted.current) {
          setRestartPending(false);
          // old-session work must not probe or repaint a newly authenticated session
          if (currentSession()) window.setTimeout(() => { if (currentSession()) void refreshStatus(); }, 750);
        }
      }
    }
  }, [beforeRestart, onRestartSettled, refreshStatus, request]);

  const operation = status?.operation;
  const completedRestart = operation?.state === 'complete' && operation.restart?.state === 'restarted' || operation?.state === 'failed' && operation.restart?.state === 'recovered';
  const restartResult = operation !== undefined && operation.id !== dismissedRestart && completedRestart ? operation : undefined;
  const restartResultId = restartResult?.id;
  // dismiss only this durable operation so later restarts can report their own outcome
  const dismissRestartResult = useCallback(() => {
    // ignore an absent result
    if (restartResultId === undefined) return;
    setDismissedRestart(restartResultId);
    try { localStorage.setItem(dismissedRestartKey, restartResultId); } catch { /* retain in-memory dismissal when browser storage is unavailable */ }
  }, [restartResultId]);
  const successfulRestartId = restartResult?.restart?.state === 'restarted' ? restartResultId : undefined;
  // expire successes without extending their lifetime on status polls
  useEffect(() => {
    // keep recovery warnings available until explicitly dismissed
    if (successfulRestartId === undefined) return;
    const timer = window.setTimeout(dismissRestartResult, 5_000);
    return () => window.clearTimeout(timer);
  }, [dismissRestartResult, successfulRestartId]);
  const value = useMemo<SettingsRuntime>(() => ({ request, status, statusError, restartPending, restart, refreshStatus, securityEpoch, canMutate, restartResult, dismissRestartResult }), [canMutate, dismissRestartResult, request, restart, restartPending, refreshStatus, securityEpoch, status, statusError, restartResult]);
  return <SettingsRuntimeContext.Provider value={value}>{children}</SettingsRuntimeContext.Provider>;
}

// require the runtime inside the settings feature
export const useSettingsRuntime = (): SettingsRuntime => {
  const runtime = useContext(SettingsRuntimeContext);
  // catch integration mistakes during development
  if (runtime === undefined) throw new Error('SettingsRuntimeProvider is missing');
  return runtime;
};

// inspect the optional runtime from the shared toast host
export const useOptionalSettingsRuntime = (): SettingsRuntime | undefined => useContext(SettingsRuntimeContext);

// retain actionable pending changes after a recovered restart without repeating its failure
const hasPendingRestartNotice = (status: SettingsStatus | undefined): boolean => status !== undefined && (status.pending
  || status.operation?.state === 'queued' || status.operation?.state === 'running'
  || status.operation?.state === 'failed' && status.operation.restart?.state !== 'recovered');

// report whether the toast host must stay mounted
export const useSettingsRestartNoticeVisible = (): boolean => {
  const runtime = useOptionalSettingsRuntime();
  return runtime?.restartResult !== undefined || runtime?.restartPending === true || hasPendingRestartNotice(runtime?.status);
};

// derive remaining time from the actual host deadline even after sleep or disconnection
function RestartRecoveryCountdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now);
  // repaint each second without restarting or extending the host timer
  useEffect(() => {
    const timer = window.setInterval(() => { /* refresh the wall-clock remainder */ setNow(Date.now()); }, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  return <span className="settings-recovery-countdown" role="timer" aria-label="Automatic recovery countdown" aria-live="off">Automatic recovery in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}{seconds === 0 && ' · waiting for host recovery…'}</span>;
}

// keep one fullscreen cover for explicit actions and durable restart progress
export function ConsoleFullscreenLoader({ action, reconnecting, onEntered }: { action?: FullscreenAction; reconnecting: boolean; onEntered: () => void }) {
  const runtime = useOptionalSettingsRuntime();
  const status = runtime?.status;
  const operation = status?.operation;
  const serverRestart = activeServerRestart(operation);
  const restarting = action !== 'reload' && (action === 'restart' || serverRestart);
  // leave normal console content mounted and uncovered when no action is active
  if (action === undefined && !serverRestart && !reconnecting) return null;
  const progress = serverRestart ? operation?.restart : undefined;
  const label = action === 'reload' ? 'Reloading UI' : restarting ? progress?.state === 'recovering' ? 'Recovering server' : progress?.state === 'restarting' ? 'Restarting server' : 'Preparing restart' : 'Reconnecting to console';
  const detail = serverRestart ? operation?.phase ?? 'Applying saved settings and checking health…' : 'Preparing to apply saved settings…';
  return <FullscreenLoader label={label} onEntered={action === undefined ? undefined : onEntered} focusReturnKey={action} progressKind={restarting ? 'working' : 'loading'}>
    {restarting && <div className="fullscreen-restart-details">
      {/* omit the redundant host restart phase */}
      {detail !== 'restarting' && <p>{detail}</p>}
      {progress?.state === 'restarting' && <RestartRecoveryCountdown deadline={progress.recoveryDeadline} />}
      {progress?.state === 'recovering' && <p>Automatic host recovery is in progress…</p>}
      {progress !== undefined && status?.recoveryCommand && <small>Manual recovery: <code>{status.recoveryCommand}</code>. Recovery keeps saved settings.</small>}
      {status?.reconnectOrigin && <a href={status.reconnectOrigin}>Open {status.reconnectOrigin}</a>}
      {status?.reloginRequired && <small>You may need to sign in again after the restart.</small>}
      {runtime?.statusError && !reconnecting && <small>{runtime.statusError}</small>}
      {reconnecting && <small>Console unavailable. Reconnecting…</small>}
    </div>}
  </FullscreenLoader>;
}

// report a proved terminal outcome independently of any still-pending saved changes
function RestartResultToast({ operation, onDismiss }: { operation: SettingsOperation; onDismiss: () => void }) {
  const recovered = operation.restart?.state === 'recovered';
  const title = recovered ? 'Server recovered after a restart failure' : 'Server restarted successfully';
  return <section className={`toast settings-restart-notice settings-restart-result ${recovered ? 'warning' : 'success'}`} role={recovered ? 'alert' : 'status'} aria-label={title} aria-live={recovered ? 'assertive' : 'polite'}>
    <span className="settings-restart-icon" aria-hidden="true">{recovered ? '!' : '✓'}</span>
    <span className="settings-restart-copy"><strong>{title}</strong>{recovered && <span>RAC had to restore its last working configuration. Saved settings were kept for review.</span>}</span>
    <button type="button" aria-label="Dismiss restart result" title="Dismiss" onClick={onDismiss}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
  </section>;
}

// render one persistent restart notice in the global toast stack
export function SettingsRestartNotice() {
  const runtime = useOptionalSettingsRuntime();
  const status = runtime?.status;
  // terminal connector history must not own a later ordinary settings restart
  const historicalCloudflare = status?.pending && status.operation?.kind === 'cloudflare' && (status.operation.state === 'complete' || status.operation.state === 'failed');
  const operation = historicalCloudflare ? undefined : status?.operation;
  const visible = useSettingsRestartNoticeVisible();
  // omit settled settings state
  if (!visible || runtime === undefined || status === undefined) return null;
  const running = runtime.restartPending || operation?.state === 'queued' || operation?.state === 'running';
  const failed = operation?.state === 'failed' && operation.restart?.state !== 'recovered';
  const progress = operation?.restart;
  const cloudflareSetup = operation?.kind === 'cloudflare';
  const targets = status.targets.map(target => target === 'rac' ? 'RAC' : 'Cloudflare').join(' and ');
  let detail = failed ? operation?.error ?? status.reason ?? 'The last restart failed. Saved settings are still pending.' : running ? operation?.phase ?? 'Applying saved settings and checking health…' : status.effective === 'unknown' ? 'Saved settings are not proven effective yet.' : `${targets || 'RAC'} must be restarted before saved settings take effect.`;
  // add post-restart authentication guidance without hiding failures
  if (status.reloginRequired) detail = `${detail} You may need to sign in again.`;
  const recoveryActive = progress !== undefined && !['restarted', 'recovered'].includes(progress.state);
  // active server progress belongs inside the single fullscreen loader
  const pendingVisible = !runtime.restartPending && !activeServerRestart(operation) && hasPendingRestartNotice(status);
  const heading = cloudflareSetup ? 'Cloudflare setup' : !running ? 'Restart pending' : progress?.state === 'recovering' ? 'Recovering server' : progress?.state === 'restarting' ? 'Restarting server' : 'Preparing restart';
  return <>{pendingVisible && <section className={`toast settings-restart-notice${failed ? ' failed' : ''}${running ? ' progress-border progress-yellow' : ''}`} data-restart-active={recoveryActive || undefined} role={failed ? 'alert' : 'status'} aria-label={cloudflareSetup ? 'Cloudflare setup' : 'Restart pending'} aria-live={failed ? 'assertive' : 'polite'} aria-busy={running || undefined}>
    {running && <span className="update-progress-ring" aria-hidden="true" />}
    <span className="settings-restart-icon" aria-hidden="true">{failed ? '!' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66L20 8M20 4v4h-4" /></svg>}</span>
    <span className="settings-restart-copy"><strong>{heading}</strong><span>{detail}</span>{status.reconnectOrigin && <a href={status.reconnectOrigin}>Open {status.reconnectOrigin}</a>}{recoveryActive && status.recoveryCommand && <small>Manual recovery: <code>{status.recoveryCommand}</code>. Recovery keeps saved settings.</small>}{runtime.statusError && <small>{runtime.statusError}</small>}</span>
    {cloudflareSetup ? <a href="#settings">Review setup</a> : <button type="button" className={running ? `progress-border ${failed ? 'progress-red' : 'progress-yellow'}` : undefined} aria-busy={running || undefined} data-fullscreen-focus-return="restart" disabled={running || !status.restartAvailable || !runtime.canMutate} title={!runtime.canMutate ? 'Take control to restart' : undefined} onClick={() => { /* start only the fixed restart */ void runtime.restart(); }}>{running && <span className="update-progress-ring" aria-hidden="true" />}{running ? 'Restarting…' : failed ? 'Retry restart' : 'Restart'}</button>}
  </section>}{runtime.restartResult !== undefined && <RestartResultToast operation={runtime.restartResult} onDismiss={runtime.dismissRestartResult} />}</>;
}

// keep redacted pending state visible when another browser owns control
export function StandaloneSettingsRestartNotice() {
  const visible = useSettingsRestartNoticeVisible();
  // avoid a second toast stack in the active dashboard
  if (!visible) return null;
  return createPortal(<div className="toast-region settings-standalone-toast-region"><SettingsRestartNotice /></div>, document.body);
}
