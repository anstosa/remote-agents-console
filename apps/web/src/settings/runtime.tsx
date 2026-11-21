import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SettingsOperation, SettingsRequest, SettingsStatus, TunnelHealth } from './contracts.js';
import { isSettingsOperation, isSettingsStatus, isTunnelHealth } from './contracts.js';
import { FullscreenLoader, type FullscreenAction } from '../fullscreen-loader.js';

type SettingsRuntime = {
  request: SettingsRequest;
  status?: SettingsStatus;
  statusError?: string;
  restartPending: boolean;
  restartError?: string;
  restart: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  securityEpoch: number;
  canMutate: boolean;
  restartResult?: SettingsOperation;
  dismissRestartResult: () => void;
  tunnelHealth?: TunnelHealth;
  tunnelReconnectPending: boolean;
  tunnelReconnectError?: string;
  tunnelReconnectCoverActive: boolean;
  reconnectTunnel: () => Promise<void>;
  refreshTunnelHealth: () => Promise<void>;
};

const SettingsRuntimeContext = createContext<SettingsRuntime | undefined>(undefined);

const dismissedRestartKey = 'rac.settings.dismissed-restart-result';
const restartConfirmationMs = 15_000;

// retain dismissal across reloads without persisting credentials or source content
const readDismissedRestart = (): string | undefined => {
  try { return localStorage.getItem(dismissedRestartKey) ?? undefined; } catch { return undefined; }
};

// distinguish a server restart from connector-only setup work
const activeServerRestart = (operation: SettingsOperation | undefined): boolean => (operation?.state === 'queued' || operation?.state === 'running') && (operation.kind !== 'cloudflare' || operation.restart !== undefined);

// retain a valid server check timestamp as an opaque proof identity
const tunnelHealthCheckIdentity = (health: TunnelHealth | undefined): string | undefined => {
  const identity = health?.checkedAt;
  // reject missing or malformed check identities
  if (identity === undefined || !Number.isFinite(Date.parse(identity))) return undefined;
  return identity;
};

// keep restart state alive outside the settings panel
export function SettingsRuntimeProvider({ request, monitorRequest = request, children, enabled = true, canMutate = true, beforeRestart, onRestartSettled, beforeTunnelReconnect, onTunnelReconnectSettled }: { request: SettingsRequest; monitorRequest?: SettingsRequest; children: ReactNode; enabled?: boolean; canMutate?: boolean; beforeRestart?: () => Promise<boolean>; onRestartSettled?: (restarted?: SettingsStatus) => void; beforeTunnelReconnect?: () => Promise<boolean>; onTunnelReconnectSettled?: () => void }) {
  const [status, setStatus] = useState<SettingsStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [restartPending, setRestartPending] = useState(false);
  const [restartError, setRestartError] = useState<string>();
  const [securityEpoch, setSecurityEpoch] = useState(0);
  const [dismissedRestart, setDismissedRestart] = useState(readDismissedRestart);
  const [tunnelHealth, setTunnelHealth] = useState<TunnelHealth>();
  const [tunnelReconnectPending, setTunnelReconnectPending] = useState(false);
  const [tunnelReconnectError, setTunnelReconnectError] = useState<string>();
  const [tunnelReconnectCoverActive, setTunnelReconnectCoverActive] = useState(false);
  const statusRequest = useRef(0);
  const tunnelHealthRequest = useRef(0);
  const restartAttempt = useRef(0);
  const tunnelReconnectAttempt = useRef(0);
  const submittingRestart = useRef(false);
  const submittingTunnelReconnect = useRef(false);
  const awaitingTunnelRecovery = useRef(false);
  const tunnelRecoveryRequestFloor = useRef(0);
  const tunnelRecoveryCheckBaseline = useRef<string | undefined>(undefined);
  const tunnelRecoveryWatchdog = useRef<number | undefined>(undefined);
  const tunnelHealthSnapshot = useRef<TunnelHealth | undefined>(undefined);
  const readingTunnelHealth = useRef(false);
  const awaitingRestartStatus = useRef(false);
  const lastOperationId = useRef<string | undefined>(undefined);
  const restartIdentity = useRef<{ previous?: string; tracked?: string; confirmBy?: number } | undefined>(undefined);
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
  // cancel the one bounded post-acknowledgement recovery deadline
  const clearTunnelRecoveryWatchdog = useCallback(() => {
    // avoid clearing an unrelated browser timer
    if (tunnelRecoveryWatchdog.current === undefined) return;
    window.clearTimeout(tunnelRecoveryWatchdog.current);
    tunnelRecoveryWatchdog.current = undefined;
  }, []);
  // prevent delayed fade or poll callbacks from mutating a detached provider
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; awaitingRestartStatus.current = false; awaitingTunnelRecovery.current = false; clearTunnelRecoveryWatchdog(); restartAttempt.current += 1; tunnelReconnectAttempt.current += 1; statusRequest.current += 1; tunnelHealthRequest.current += 1; };
  }, [clearTunnelRecoveryWatchdog]);

  // read the server-owned monitor snapshot without changing console reachability
  const refreshTunnelHealth = useCallback(async () => {
    // serialize cached health reads and skip protected traffic before login
    if (!enabled || !authenticationEnabled.current || !mounted.current || readingTunnelHealth.current) return;
    readingTunnelHealth.current = true;
    const sequence = ++tunnelHealthRequest.current;
    const epoch = authenticationEpoch.current;
    // reject reads from an earlier session or poll generation
    const currentRead = () => sequence === tunnelHealthRequest.current && epoch === authenticationEpoch.current && authenticationEnabled.current && mounted.current;
    try {
      const response = await monitorRequest('/api/settings/cloudflare/health', { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
      const payload: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
      // retain the last proved snapshot across monitor transport failures
      if (!currentRead() || !response.ok || !isTunnelHealth(payload)) return;
      tunnelHealthSnapshot.current = payload;
      setTunnelHealth(payload);
      const checkIdentity = tunnelHealthCheckIdentity(payload);
      // finish only from proof newer than every pre-restart or reconnecting snapshot
      if (awaitingTunnelRecovery.current) {
        const mustRebaseline = submittingTunnelReconnect.current || sequence < tunnelRecoveryRequestFloor.current || payload.reconnecting;
        // old reads and backend-busy snapshots cannot verify the restarted route
        if (mustRebaseline) {
          if (checkIdentity !== undefined) tunnelRecoveryCheckBaseline.current = checkIdentity;
        } else {
          const freshProof = checkIdentity !== undefined && checkIdentity !== tunnelRecoveryCheckBaseline.current;
          // verified public health is the only successful completion
          if (freshProof && payload.state === 'healthy') {
            awaitingTunnelRecovery.current = false;
            tunnelRecoveryCheckBaseline.current = undefined;
            clearTunnelRecoveryWatchdog();
            setTunnelReconnectCoverActive(false);
            setTunnelReconnectError(undefined);
            onTunnelReconnectSettled?.();
          // a fresh settled non-checking result returns to an actionable failure
          } else if (freshProof && payload.state !== 'checking') {
            awaitingTunnelRecovery.current = false;
            tunnelRecoveryCheckBaseline.current = undefined;
            clearTunnelRecoveryWatchdog();
            setTunnelReconnectCoverActive(false);
            setTunnelReconnectError('Cloudflare route recovery could not be verified. Try again.');
            onTunnelReconnectSettled?.();
          }
        }
      // clear an earlier local failure only after independent verified recovery
      } else if (payload.state === 'healthy') setTunnelReconnectError(undefined);
    } catch { /* retry cached health without declaring the console unreachable */ }
    finally {
      // release only this poll generation
      if (sequence === tunnelHealthRequest.current) readingTunnelHealth.current = false;
    }
  }, [clearTunnelRecoveryWatchdog, enabled, monitorRequest, onTunnelReconnectSettled]);

  // poll cached tunnel health independently from the settings page
  useEffect(() => {
    // clear private status at the authentication boundary
    if (!enabled) {
      const ownedTunnelCover = submittingTunnelReconnect.current || awaitingTunnelRecovery.current;
      setTunnelHealth(undefined);
      setTunnelReconnectError(undefined);
      setTunnelReconnectPending(false);
      setTunnelReconnectCoverActive(false);
      submittingTunnelReconnect.current = false;
      awaitingTunnelRecovery.current = false;
      tunnelRecoveryCheckBaseline.current = undefined;
      clearTunnelRecoveryWatchdog();
      tunnelHealthSnapshot.current = undefined;
      readingTunnelHealth.current = false;
      tunnelHealthRequest.current += 1;
      tunnelReconnectAttempt.current += 1;
      // release only the authenticated session's matching fullscreen action
      if (ownedTunnelCover) onTunnelReconnectSettled?.();
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    // replace rather than stack the next scheduled read
    const schedule = () => {
      // clear a prior wake-up before choosing the next interval
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { /* refresh cached tunnel health */ void poll(); }, 4_000);
    };
    // schedule after completion so slow responses never overlap
    const poll = async () => {
      // stop detached monitor generations
      if (disposed) return;
      await refreshTunnelHealth();
      // defer the next cached read until this one settles
      if (!disposed) schedule();
    };
    // refresh immediately and after returning from the background
    const visible = () => {
      // ignore hidden-tab transitions
      if (document.hidden || disposed || readingTunnelHealth.current) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void poll();
    };
    void poll();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      tunnelHealthRequest.current += 1;
      readingTunnelHealth.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [clearTunnelRecoveryWatchdog, enabled, onTunnelReconnectSettled, refreshTunnelHealth]);

  // restart only the configured connector through the controller-only endpoint
  const reconnectTunnel = useCallback(async () => {
    // serialize clicks and retain the server's reconnect capability boundary
    if (submittingTunnelReconnect.current || awaitingTunnelRecovery.current || !mutationAllowed.current || tunnelHealth?.canReconnect !== true) return;
    submittingTunnelReconnect.current = true;
    setTunnelReconnectPending(true);
    setTunnelReconnectError(undefined);
    setTunnelReconnectCoverActive(true);
    const epoch = authenticationEpoch.current;
    const attempt = ++tunnelReconnectAttempt.current;
    let accepted = false;
    // reject acknowledgements from an earlier authenticated session
    const currentSession = () => mounted.current && authenticationEnabled.current && epoch === authenticationEpoch.current && attempt === tunnelReconnectAttempt.current;
    try {
      const entered = await (beforeTunnelReconnect?.() ?? Promise.resolve(true));
      // authority may change while the fullscreen cover paints
      if (!entered || !mutationAllowed.current || !currentSession()) {
        // release only the cover owned by this still-current attempt
        if (attempt === tunnelReconnectAttempt.current) {
          setTunnelReconnectCoverActive(false);
          onTunnelReconnectSettled?.();
        }
        return;
      }
      const response = await request('/api/settings/cloudflare/reconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
      const payload: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
      // ignore work retired by logout or provider teardown
      if (!currentSession()) return;
      const operation = payload !== null && typeof payload === 'object' && Object.keys(payload).length === 1 && isSettingsOperation((payload as { operation?: unknown }).operation)
        ? (payload as { operation: SettingsOperation }).operation
        : undefined;
      // require the accepted connector-only operation envelope
      if (response.status !== 202 || operation === undefined || operation.kind !== 'cloudflare') {
        awaitingTunnelRecovery.current = false;
        tunnelRecoveryCheckBaseline.current = undefined;
        clearTunnelRecoveryWatchdog();
        setTunnelReconnectCoverActive(false);
        setTunnelReconnectError(response.status === 503 ? 'The reconnect request could not reach RAC. Try again from the local RAC address.' : 'Cloudflare could not be reconnected. Try again.');
        onTunnelReconnectSettled?.();
        return;
      }
      accepted = true;
      awaitingTunnelRecovery.current = true;
      // rebaseline after acknowledgement so held and cached pre-restart health cannot settle
      tunnelRecoveryCheckBaseline.current = tunnelHealthCheckIdentity(tunnelHealthSnapshot.current);
      tunnelRecoveryRequestFloor.current = tunnelHealthRequest.current + 1;
      setTunnelHealth(current => current === undefined ? current : { ...current, reconnecting: true });
      clearTunnelRecoveryWatchdog();
      // return control if route verification remains unavailable after bounded retries
      tunnelRecoveryWatchdog.current = window.setTimeout(() => {
        tunnelRecoveryWatchdog.current = undefined;
        // an old session or attempt must not close a newer action
        if (!mounted.current || !authenticationEnabled.current || epoch !== authenticationEpoch.current || attempt !== tunnelReconnectAttempt.current || !awaitingTunnelRecovery.current) return;
        awaitingTunnelRecovery.current = false;
        tunnelRecoveryCheckBaseline.current = undefined;
        setTunnelHealth(current => current === undefined ? current : { ...current, reconnecting: false });
        setTunnelReconnectCoverActive(false);
        setTunnelReconnectError('Tunnel recovery status is unavailable. Try again.');
        onTunnelReconnectSettled?.();
      }, 90_000);
    } catch {
      // distinguish a missing acknowledgement from proved recovery
      if (currentSession()) {
        awaitingTunnelRecovery.current = false;
        tunnelRecoveryCheckBaseline.current = undefined;
        clearTunnelRecoveryWatchdog();
        setTunnelReconnectCoverActive(false);
        setTunnelReconnectError('The reconnect request could not reach RAC. Try again from the local RAC address.');
        onTunnelReconnectSettled?.();
      }
    } finally {
      // release only the attempt that owns this browser lock
      if (attempt === tunnelReconnectAttempt.current) {
        submittingTunnelReconnect.current = false;
        if (mounted.current) {
          setTunnelReconnectPending(false);
          // fetch the server-owned operation state only after submission
          if (accepted && currentSession()) window.setTimeout(() => { if (currentSession()) void refreshTunnelHealth(); }, 750);
        }
      }
    }
  }, [beforeTunnelReconnect, clearTunnelRecoveryWatchdog, onTunnelReconnectSettled, refreshTunnelHealth, request, tunnelHealth?.canReconnect]);

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
        setStatusError('Settings status is unavailable.');
        return;
      }
      const operation = payload.operation;
      lastOperationId.current = operation?.id;
      setStatus(payload);
      setStatusError(undefined);
      const identity = restartIdentity.current;
      // wait for the submission boundary before interpreting durable observations
      if (!awaitingRestartStatus.current || submittingRestart.current || identity === undefined) return;
      // recover an interrupted acknowledgement from new work in flight, not terminal history
      if (identity.tracked === undefined && operation !== undefined && operation.id !== identity.previous && operation.kind !== 'cloudflare' && activeServerRestart(operation)) identity.tracked = operation.id;
      const matches = operation !== undefined && operation.id === identity.tracked;
      // a tracked restart may settle only on its own terminal result
      if (identity.tracked !== undefined && (!matches || activeServerRestart(operation))) return;
      // only an unidentified submission can run out of time to confirm
      if (identity.tracked === undefined && (identity.confirmBy === undefined || Date.now() < identity.confirmBy)) return;
      awaitingRestartStatus.current = false;
      restartIdentity.current = undefined;
      // an unconfirmed operation is not a failed restart and must not trigger a reload
      if (!matches) setRestartError("Couldn't confirm the restart. Check the saved settings before retrying.");
      const restarted = matches && operation.kind !== 'cloudflare' && operation.id !== identity.previous && operation.state === 'complete' && operation.restart?.state === 'restarted';
      onRestartSettled?.(restarted ? payload : undefined);
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
      setStatus(undefined); setStatusError(undefined); setRestartError(undefined);
      lastOperationId.current = undefined;
      restartIdentity.current = undefined;
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
    restartIdentity.current = { previous: lastOperationId.current };
    setRestartPending(true);
    setStatusError(undefined);
    setRestartError(undefined);
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
          restartIdentity.current = undefined;
          if (mounted.current) onRestartSettled?.();
        }
        return;
      }
      submitted = true;
      const response = await request('/api/settings/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
      // ignore acknowledgements after the authenticated provider has detached
      if (!currentSession()) return;
      // distinguish explicit rejection from an unavailable acknowledgement
      if (!response.ok) {
        const rejected = response.status >= 400 && response.status < 500;
        // transport failures become synthetic 503 responses in the shared request helper
        if (rejected) {
          awaitingRestartStatus.current = false;
          restartIdentity.current = undefined;
          setRestartError('The restart did not start. Your saved settings are still pending.');
          onRestartSettled?.();
        } else setStatusError('Checking whether the restart started…');
        return;
      }
      const payload: unknown = await response.json().catch(() => undefined);
      // parsing may outlive the application that requested the restart
      if (!currentSession()) return;
      statusRequest.current += 1;
      const operation = isSettingsStatus(payload) ? payload.operation : isSettingsOperation(payload) ? payload : undefined;
      // capture the acknowledged identity separately from durable history
      if (operation !== undefined && restartIdentity.current !== undefined) restartIdentity.current.tracked = operation.id;
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
        restartIdentity.current = undefined;
        setRestartError('The restart did not start. Your saved settings are still pending.');
        onRestartSettled?.();
      }
    } finally {
      // retired requests must not unlock or invalidate a newer attempt
      if (attempt === restartAttempt.current) {
        submittingRestart.current = false;
        statusRequest.current += 1;
        const identity = restartIdentity.current;
        // bound uncertainty only while a submitted operation has no known identity
        if (identity !== undefined && identity.tracked === undefined) identity.confirmBy = Date.now() + restartConfirmationMs;
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
  // share only the current restart notice and actions with the toast and cover
  const value = useMemo<SettingsRuntime>(() => ({ request, status, statusError, restartPending, restartError, restart, refreshStatus, securityEpoch, canMutate, restartResult, dismissRestartResult, tunnelHealth, tunnelReconnectPending, tunnelReconnectError, tunnelReconnectCoverActive, reconnectTunnel, refreshTunnelHealth }), [canMutate, dismissRestartResult, request, restart, restartError, restartPending, refreshStatus, securityEpoch, status, statusError, restartResult, tunnelHealth, tunnelReconnectPending, tunnelReconnectError, tunnelReconnectCoverActive, reconnectTunnel, refreshTunnelHealth]);
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
  return runtime?.restartError !== undefined || runtime?.restartResult !== undefined || runtime?.restartPending === true || hasPendingRestartNotice(runtime?.status);
};

// report whether continuous checks require a global tunnel notice
export const useTunnelHealthNoticeVisible = (): boolean => {
  const runtime = useOptionalSettingsRuntime();
  const health = runtime?.tunnelHealth;
  // the dedicated fullscreen page owns reconnect progress
  if (runtime?.tunnelReconnectCoverActive === true) return false;
  return health?.state === 'degraded' || health?.reconnecting === true || runtime?.tunnelReconnectPending === true || runtime?.tunnelReconnectError !== undefined;
};

// keep tunnel recovery available without conflating it with a RAC restart
export function TunnelHealthNotice() {
  const runtime = useOptionalSettingsRuntime();
  const health = runtime?.tunnelHealth;
  const visible = useTunnelHealthNoticeVisible();
  // omit healthy, unknown and fullscreen-owned tunnel states
  if (!visible || runtime === undefined || health === undefined) return null;
  const reconnecting = runtime.tunnelReconnectPending || health.reconnecting;
  const failed = runtime.tunnelReconnectError !== undefined || health.error === 'reconnect_failed';
  const identityMismatch = health.error === 'tunnel_identity_mismatch';
  const title = 'Tunnel degraded';
  const detail = reconnecting
    ? 'Restarting only the Cloudflare connector and checking the public route…'
    : runtime.tunnelReconnectError ?? (failed
      ? 'Cloudflare did not reconnect. Try again.'
      : identityMismatch
        ? 'The public address is not reaching this RAC instance.'
        : 'Public tunnel checks failed while RAC responded locally.');
  const disabled = reconnecting || !runtime.canMutate || !health.canReconnect;
  const disabledReason = !runtime.canMutate ? 'Take control to reconnect' : !health.canReconnect ? 'Tunnel reconnect is unavailable for this installation' : undefined;
  return <section className={`toast tunnel-health-notice${failed ? ' failed' : ''}`} role="alert" aria-label={title} aria-live="assertive" aria-busy={reconnecting || undefined}>
    <span className="tunnel-health-icon" aria-hidden="true">!</span>
    <span className="tunnel-health-copy"><strong>{title}</strong><span>{detail}</span></span>
    <button type="button" data-fullscreen-focus-return="tunnel-reconnect" className={reconnecting ? 'progress-border progress-yellow' : undefined} aria-busy={reconnecting || undefined} disabled={disabled} title={disabledReason} onClick={() => { /* open the painted connector recovery page */ void runtime.reconnectTunnel(); }}>{reconnecting && <span className="update-progress-ring" aria-hidden="true" />}{reconnecting ? 'Reconnecting…' : 'Reconnect'}</button>
  </section>;
}

// offer connector recovery inside a passive console outage without nesting a toast
function TunnelOutageRecoveryControl() {
  const runtime = useOptionalSettingsRuntime();
  const health = runtime?.tunnelHealth;
  // require a previously confirmed managed tunnel
  if (runtime === undefined || health?.canReconnect !== true) return null;
  const disabled = !runtime.canMutate;
  return <div className="tunnel-outage-recovery" role="group" aria-label="Public connection lost">
    <p>{runtime.tunnelReconnectError ?? 'Tunnel status is unavailable. Reconnect restarts only the Cloudflare connector.'}</p>
    <button type="button" data-fullscreen-focus-return="tunnel-reconnect" disabled={disabled} title={disabled ? 'Take control to reconnect' : undefined} onClick={() => { /* open the painted connector recovery page */ void runtime.reconnectTunnel(); }}>Reconnect</button>
  </div>;
}

// keep the host command behind an explicit recovery disclosure
function ManualRestartRecovery({ command }: { command: string }) {
  return <details className="settings-manual-recovery"><summary>Manual recovery</summary><p>If RAC still does not return, run this on the server. It keeps your saved settings.</p><code>{command}</code></details>;
}

// derive remaining time from the actual host deadline even after sleep or disconnection
function RestartRecoveryCountdown({ deadline, command }: { deadline: number; command?: string }) {
  const [now, setNow] = useState(Date.now);
  // repaint each second without restarting or extending the host timer
  useEffect(() => {
    const timer = window.setInterval(() => { /* refresh the wall-clock remainder */ setNow(Date.now()); }, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  return <><span className="settings-recovery-countdown" role="timer" aria-label="Automatic recovery countdown" aria-live="off">{seconds === 0 ? 'Waiting for automatic recovery…' : `Automatic recovery in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>{seconds === 0 && command && <ManualRestartRecovery command={command} />}</>;
}

// translate durable restart states into one step and one expectation
function restartPresentation(operation: SettingsOperation | undefined, reconnecting: boolean): { label: string; detail: string } {
  // automatic recovery supersedes the forward restart
  if (operation?.restart?.state === 'recovering') return { label: 'Restoring the last working settings', detail: 'The restart did not finish. RAC is recovering automatically and will keep your saved changes.' };
  // distinguish an expected interruption from work still running on the server
  if (reconnecting) return { label: 'Reconnecting after restart', detail: 'The connection can drop during a restart. RAC will reconnect automatically.' };
  // an armed recovery deadline means RAC has begun replacing the running server
  if (operation?.restart?.state === 'restarting') return { label: 'Restarting server', detail: 'RAC is starting with your saved settings. You can leave this page open.' };
  // the host may be validating settings or building while the old server is still up
  if (operation?.state === 'running') return { label: 'Checking saved settings', detail: 'RAC is preparing the server for restart. This can take a few minutes.' };
  return { label: 'Preparing restart', detail: 'RAC will check your saved settings before restarting. No action needed.' };
}

// keep one fullscreen cover for explicit actions and durable restart progress
export function ConsoleFullscreenLoader({ action, reconnecting, checkingRestartUi = false, onEntered }: { action?: FullscreenAction; reconnecting: boolean; checkingRestartUi?: boolean; onEntered: () => void }) {
  const runtime = useOptionalSettingsRuntime();
  const status = runtime?.status;
  const operation = status?.operation;
  const serverRestart = activeServerRestart(operation);
  const restarting = action !== 'reload' && (action === 'restart' || serverRestart);
  const reconnectingTunnel = action === 'tunnel-reconnect';
  // leave normal console content mounted and uncovered when no action is active
  if (action === undefined && !serverRestart && !reconnecting) return null;
  const activeOperation = serverRestart ? operation : undefined;
  const progress = activeOperation?.restart;
  const restartStep = checkingRestartUi ? { label: 'Checking for a UI update', detail: 'RAC is back online. This page will reload only if a newer version is available.' } : restartPresentation(activeOperation, reconnecting);
  const label = action === 'reload' ? 'Reloading UI' : reconnectingTunnel ? 'Reconnecting tunnel' : restarting ? restartStep.label : 'Reconnecting to console';
  return <FullscreenLoader label={label} onEntered={action === undefined ? undefined : onEntered} focusReturnKey={action} progressKind={restarting || reconnectingTunnel ? 'working' : 'loading'}>
    {restarting && <div className="fullscreen-restart-details">
      <p>{restartStep.detail}</p>
      {progress?.state === 'restarting' && <RestartRecoveryCountdown deadline={progress.recoveryDeadline} command={status?.recoveryCommand} />}
      {status?.reconnectOrigin && <a href={status.reconnectOrigin}>Open the new RAC address</a>}
      {!checkingRestartUi && status?.reloginRequired && <small>You may need to sign in again.</small>}
      {!reconnecting && runtime?.statusError && <small>{runtime.statusError}</small>}
    </div>}
    {reconnectingTunnel && <small>Restarting only the Cloudflare connector and checking the public route…</small>}
    {!restarting && !reconnectingTunnel && reconnecting && <TunnelOutageRecoveryControl />}
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
  const recoveryFailed = failed && operation.restart?.state === 'recovery-failed';
  const cloudflareSetup = operation?.kind === 'cloudflare';
  const showUnconfirmed = !hasPendingRestartNotice(status) && runtime.restartError !== undefined;
  const targets = status.targets.map(target => target === 'rac' ? 'RAC' : 'the Cloudflare connector').join(' and ');
  const heading = showUnconfirmed ? 'Restart not confirmed' : cloudflareSetup ? 'Cloudflare setup' : recoveryFailed ? 'Automatic recovery failed' : failed ? 'Restart failed' : 'Restart to apply settings';
  const detail = cloudflareSetup ? failed ? 'Cloudflare setup did not finish. Review your setup before trying again.' : 'RAC is setting up your public connection.'
    : recoveryFailed ? 'RAC could not restore the last working configuration. Use manual recovery before trying another restart.'
    : failed ? 'Your saved settings are still pending. Review them before retrying.'
    : `Restart ${targets || 'RAC'} to put your saved settings into effect.`;
  // active server progress belongs inside the single fullscreen loader
  const pendingVisible = !runtime.restartPending && !activeServerRestart(operation) && (showUnconfirmed || hasPendingRestartNotice(status));
  return <>{pendingVisible && <section className={`toast settings-restart-notice${failed ? ' failed' : ''}${running ? ' progress-border progress-yellow' : ''}`} role={failed || showUnconfirmed ? 'alert' : 'status'} aria-label={cloudflareSetup || failed || showUnconfirmed ? heading : 'Restart pending'} aria-live={failed ? 'assertive' : 'polite'} aria-busy={running || undefined}>
    {running && <span className="update-progress-ring" aria-hidden="true" />}
    <span className="settings-restart-icon" aria-hidden="true">{failed ? '!' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66L20 8M20 4v4h-4" /></svg>}</span>
    <div className="settings-restart-copy"><strong>{heading}</strong>{!showUnconfirmed && <span>{detail}</span>}{status.reconnectOrigin && <a href={status.reconnectOrigin}>Open the new RAC address</a>}{status.reloginRequired && <span>You may need to sign in again.</span>}{recoveryFailed && status.recoveryCommand && <ManualRestartRecovery command={status.recoveryCommand} />}{!showUnconfirmed && !runtime.canMutate && !cloudflareSetup && !recoveryFailed && <span>Take control from this browser to restart.</span>}{!showUnconfirmed && !status.restartAvailable && !cloudflareSetup && <span>Ask the server administrator to restart RAC.</span>}{(runtime.restartError ?? runtime.statusError) && <small>{runtime.restartError ?? runtime.statusError}</small>}</div>
    {showUnconfirmed ? <a href="#settings">Review settings</a> : cloudflareSetup ? <a href="#settings">Review setup</a> : !recoveryFailed && <button type="button" data-fullscreen-focus-return="restart" disabled={running || !status.restartAvailable || !runtime.canMutate} title={!runtime.canMutate ? 'Take control to restart' : undefined} onClick={() => { /* start only the fixed restart */ void runtime.restart(); }}>{failed ? 'Retry restart' : 'Restart'}</button>}
  </section>}{runtime.restartResult !== undefined && <RestartResultToast operation={runtime.restartResult} onDismiss={runtime.dismissRestartResult} />}</>;
}

// keep redacted pending state visible when another browser owns control
export function StandaloneSettingsRestartNotice() {
  const visible = useSettingsRestartNoticeVisible();
  // avoid a second toast stack in the active dashboard
  if (!visible) return null;
  return createPortal(<div className="toast-region settings-standalone-toast-region"><SettingsRestartNotice /></div>, document.body);
}

// retain tunnel recovery outside the active dashboard toast host
export function StandaloneTunnelHealthNotice() {
  const visible = useTunnelHealthNoticeVisible();
  // avoid empty portal roots while the tunnel is healthy
  if (!visible) return null;
  return createPortal(<div className="toast-region tunnel-health-standalone-region"><TunnelHealthNotice /></div>, document.body);
}
