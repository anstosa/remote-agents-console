import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SettingsOperation, SettingsRequest, SettingsStatus } from './contracts.js';
import { isSettingsStatus, settingsResponseError } from './contracts.js';

type SettingsRuntime = {
  request: SettingsRequest;
  status?: SettingsStatus;
  statusError?: string;
  restartPending: boolean;
  restart: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  securityEpoch: number;
  canMutate: boolean;
};

const SettingsRuntimeContext = createContext<SettingsRuntime | undefined>(undefined);

// validate the public operation status used by polling
const isSettingsOperation = (value: unknown): value is SettingsOperation => value !== null
  && typeof value === 'object'
  && typeof (value as SettingsOperation).id === 'string'
  && ['queued', 'running', 'complete', 'failed'].includes((value as SettingsOperation).state);

// keep restart state alive outside the settings panel
export function SettingsRuntimeProvider({ request, children, enabled = true, canMutate = true }: { request: SettingsRequest; children: ReactNode; enabled?: boolean; canMutate?: boolean }) {
  const [status, setStatus] = useState<SettingsStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [restartPending, setRestartPending] = useState(false);
  const [securityEpoch, setSecurityEpoch] = useState(0);

  // load server-owned pending and operation state
  const refreshStatus = useCallback(async () => {
    // do not probe protected status before authentication
    if (!enabled) return;
    const response = await request('/api/settings/status', { cache: 'no-store' });
    // retain the prior status across a transient failure
    if (!response.ok) {
      setStatusError(await settingsResponseError(response, 'Settings status is unavailable.'));
      return;
    }
    const payload: unknown = await response.json().catch(() => undefined);
    // reject malformed status without clearing a visible pending warning
    if (!isSettingsStatus(payload)) {
      setStatusError('Settings status is unavailable.');
      return;
    }
    setStatus(payload);
    setStatusError(undefined);
  }, [enabled, request]);

  // recover status at mount and poll it independently of the settings page
  useEffect(() => {
    // wait for an authenticated session
    if (!enabled) return;
    let disposed = false;
    const poll = async () => {
      // stop updates after provider teardown
      if (disposed) return;
      await refreshStatus();
    };
    void poll();
    const interval = window.setInterval(() => { /* refresh durable status */ void poll(); }, 4_000);
    const visible = () => { /* refresh after backgrounding */ if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [refreshStatus]);

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
    if (restartPending || !canMutate) return;
    setRestartPending(true);
    try {
      const response = await request('/api/settings/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      // keep the non-dismissable pending notice with a useful error
      if (!response.ok) {
        setStatusError(await settingsResponseError(response, 'Restart could not be started.'));
        return;
      }
      const payload: unknown = await response.json().catch(() => undefined);
      // accept either the status envelope or one operation response
      if (isSettingsStatus(payload)) setStatus(payload);
      else if (isSettingsOperation(payload)) setStatus(current => current === undefined ? current : { ...current, operation: payload });
      setStatusError(undefined);
      setSecurityEpoch(current => current + 1);
    } finally {
      setRestartPending(false);
      // reconcile the durable operation even after an ambiguous response
      window.setTimeout(() => { void refreshStatus(); }, 750);
    }
  }, [canMutate, refreshStatus, request, restartPending]);

  const value = useMemo<SettingsRuntime>(() => ({ request, status, statusError, restartPending, restart, refreshStatus, securityEpoch, canMutate }), [canMutate, request, restart, restartPending, refreshStatus, securityEpoch, status, statusError]);
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

// report whether the toast host must stay mounted
export const useSettingsRestartNoticeVisible = (): boolean => {
  const runtime = useOptionalSettingsRuntime();
  return runtime?.status?.pending === true || runtime?.status?.operation?.state === 'queued' || runtime?.status?.operation?.state === 'running' || runtime?.status?.operation?.state === 'failed';
};

// render one persistent restart notice in the global toast stack
export function SettingsRestartNotice() {
  const runtime = useOptionalSettingsRuntime();
  const status = runtime?.status;
  const operation = status?.operation;
  const visible = useSettingsRestartNoticeVisible();
  // omit settled settings state
  if (!visible || runtime === undefined || status === undefined) return null;
  const running = runtime.restartPending || operation?.state === 'queued' || operation?.state === 'running';
  const failed = operation?.state === 'failed';
  const targets = status.targets.map(target => target === 'rac' ? 'RAC' : 'Cloudflare').join(' and ');
  let detail = failed ? operation?.error ?? status.reason ?? 'The last restart failed. Saved settings are still pending.' : running ? operation?.phase ?? 'Applying saved settings and checking health…' : status.effective === 'unknown' ? 'Saved settings are not proven effective yet.' : `${targets || 'RAC'} must be restarted before saved settings take effect.`;
  // add post-restart authentication guidance without hiding failures
  if (status.reloginRequired) detail = `${detail} You may need to sign in again.`;
  // describe the RAC watchdog only for operations that replace RAC
  const recoveryGuidance = status.targets.includes('rac') ? 'Host recovery starts automatically if RAC does not return within 3 minutes. Manual recovery: ' : 'Manual recovery on the RAC host: ';
  return <section className={`toast settings-restart-notice${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'} aria-label="Restart pending" aria-live={failed ? 'assertive' : 'polite'}>
    <span className="settings-restart-icon" aria-hidden="true">{failed ? '!' : '↻'}</span>
    <span className="settings-restart-copy"><strong>Restart pending</strong><span>{detail}</span>{status.reconnectOrigin && <a href={status.reconnectOrigin}>Open {status.reconnectOrigin}</a>}{status.recoveryCommand && <small>{recoveryGuidance}<code>{status.recoveryCommand}</code>. Recovery keeps saved settings.</small>}{runtime.statusError && <small>{runtime.statusError}</small>}</span>
    <button type="button" className={`progress-border ${failed ? 'progress-red' : 'progress-yellow'}`} aria-busy={running} disabled={running || !status.restartAvailable || !runtime.canMutate} title={!runtime.canMutate ? 'Take control to restart' : undefined} onClick={() => { /* start only the fixed restart */ void runtime.restart(); }}>{running && <span className="update-progress-ring" aria-hidden="true" />}{running ? 'Restarting…' : failed ? 'Retry restart' : 'Restart'}</button>
  </section>;
}

// keep redacted pending state visible when another browser owns control
export function StandaloneSettingsRestartNotice() {
  const visible = useSettingsRestartNoticeVisible();
  // avoid a second toast stack in the active dashboard
  if (!visible) return null;
  return createPortal(<div className="toast-region settings-standalone-toast-region"><SettingsRestartNotice /></div>, document.body);
}
