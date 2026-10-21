import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { SplitConfirmation } from '../split-confirmation.js';
import { type CloudflareStatus, isCloudflareStatus, isSettingsOperation, settingsResponseError } from './contracts.js';
import { SettingsRevealButton } from './reveal-button.js';
import { useSettingsRuntime } from './runtime.js';
import './cloudflare-settings.css';

type CloudflareDraft = { hostname: string; baselineHostname: string; token: string; initialized: boolean };

// retain setup entries through tab and workspace changes without browser storage
export function useCloudflareSetupDraft(enabled: boolean) {
  const [draft, setDraft] = useState<CloudflareDraft>({ hostname: '', baselineHostname: '', token: '', initialized: false });
  const [replacement, setReplacement] = useState<{ open: boolean; operationId?: string }>({ open: false });
  const runtime = useSettingsRuntime();
  const [status, setStatus] = useState<CloudflareStatus>();
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const sharedOperation = runtime.status?.operation?.kind === 'cloudflare' ? runtime.status.operation : undefined;
  // discover safe field availability before the Cloudflare page is first opened
  useEffect(() => {
    // defer metadata discovery until settings files have been requested successfully
    if (!enabled) return;
    let cancelled = false;
    const baseline = latestStatus.current;
    // fetch metadata only and let the page retain its richer retry diagnostics
    const loadStatus = async () => {
      try {
        const response = await runtime.request('/api/settings/cloudflare', { cache: 'no-store' });
        // unavailable metadata must not advertise conditional setup controls
        if (!response.ok) return;
        const payload: unknown = await response.json();
        // reject stale or unsupported responses without touching any credentials
        if (!cancelled && isCloudflareStatus(payload)) {
          // retain a newer page poll and preserve previous progress across failures
          setStatus(current => current === baseline ? payload : current);
          // finish accepted replacement state even while its page is not mounted
          setReplacement(current => current.operationId === payload.operation?.id && payload.operation?.state === 'complete' ? { open: false } : current);
        }
      } catch { /* the page supplies an explicit retry on connection failure */ }
    };
    void loadStatus();
    return () => { cancelled = true; };
  }, [enabled, runtime.request, runtime.securityEpoch, sharedOperation?.id, sharedOperation?.state]);
  const existing = status?.mode === 'local' || status?.mode === 'token' && status.hostname !== undefined;
  const guideVisible = status !== undefined && (!existing || replacement.open);
  const dirty = draft.token !== '' || draft.hostname !== draft.baselineHostname;
  // discard only unsaved setup entries
  const discard = useCallback(() => { setDraft(current => ({ ...current, hostname: current.baselineHostname, token: '' })); setReplacement({ open: false }); }, []);
  // clear token plaintext independently of the planned hostname
  const clearToken = useCallback(() => { setDraft(current => current.token === '' ? current : { ...current, token: '' }); }, []);
  // never retain an entered credential after the browser leaves the page
  useEffect(() => { window.addEventListener('pagehide', clearToken); return () => window.removeEventListener('pagehide', clearToken); }, [clearToken]);
  return { draft, setDraft, dirty, discard, clearToken, replacement, setReplacement, guideVisible, status, setStatus };
}

// keep hostname validation helpful while the host performs authoritative checks
const hostnameValue = (value: string): string | undefined => {
  const hostname = value.trim().toLowerCase();
  return hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname) ? hostname : undefined;
};

// translate bounded host diagnostics into actionable setup guidance
const cloudflareFailure = (code: string): string => ({
  invalid_cloudflare_token: 'Paste only the tunnel token, not the installation command.',
  cloudflare_dns_unavailable: 'The hostname does not resolve yet. Save the Cloudflare route and try again.',
  cloudflare_health_proof_failed: 'The hostname did not reach this RAC. Check the route service URL and Cloudflare Access, then retry. The previous RAC address was kept.',
  cloudflare_verification_failed: 'The hostname did not reach this RAC. Check the route service URL and Cloudflare Access, then retry. The previous RAC address was kept.',
  cloudflare_private_address: 'The hostname must resolve to a public address, not a private or loopback address.',
  cloudflare_connector_start_failed: 'Docker could not start the connector. Check the tunnel token and host Docker status, then retry.',
  cloudflare_service_unsupported: 'The installed Docker files do not define the managed token connector. Update the stack files before setup.',
  settings_restart_required: 'Apply the saved Settings changes before starting Cloudflare setup.',
  settings_operation_in_progress: 'Another Settings operation is still running. Wait for it to finish before retrying.'
} as Record<string, string>)[code.replaceAll('-', '_')] ?? code;

// explain the connector-first dashboard workflow without copying any credentials
export const cloudflareSetupInstructions = (serviceUrl: string, hostname: string): string => [
  '1. Open https://one.dash.cloudflare.com/ and go to Networking → Tunnels → Create Tunnel. Choose Cloudflared if asked, name the tunnel, and create it.',
  '2. Under Setup Environment / Install and Run, copy ONLY the tunnel token from the installation command. Do not run that command: RAC will run the connector. This is a tunnel token, not a Cloudflare API token.',
  '3. Paste the token into RAC Settings → Cloudflare and select Start connector. Keep your current RAC page open.',
  '4. Once Cloudflare shows the connector connected, select Continue. Open Routes → Add route → Published application (also called Public Hostname in some dashboards).',
  `5. Set the hostname to ${hostname || '<your RAC hostname>'}. Set Service URL to ${serviceUrl}. If shown as separate fields, choose Type HTTP and use the address without http:// as URL. Save the route.`,
  '6. Back in RAC, enter the same hostname and select Verify and use hostname. RAC checks the public route before changing its address or restarting.',
  '7. Open the verified HTTPS address and sign in again. Do not close your current page until setup succeeds.',
  'Cloudflare Access must allow the unauthenticated /healthz route during verification. RAC still requires its own login; never paste your tunnel token into a public message or shell command.'
].join('\n\n');

// configure one remote connector without taking account-level Cloudflare privileges
export function CloudflareSettings({ setup, disabled, blockedByDrafts, confirmationTarget, advanced }: { setup: ReturnType<typeof useCloudflareSetupDraft>; disabled: boolean; blockedByDrafts: boolean; confirmationTarget?: HTMLElement | null; advanced?: ReactNode }) {
  const runtime = useSettingsRuntime();
  const { draft, setDraft, clearToken, replacement, setReplacement, status, setStatus } = setup;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pendingRequest = useRef(false);
  const mounted = useRef(true);
  const authority = useRef(runtime.canMutate);
  authority.current = runtime.canMutate;

  // load safe status without overwriting an authored hostname
  const refresh = useCallback(async () => {
    try {
      const response = await runtime.request('/api/settings/cloudflare', { cache: 'no-store' });
      // retain prior progress across helper or connection failures
      if (!response.ok) { if (mounted.current) setError(await settingsResponseError(response, 'Cloudflare status is unavailable.')); return; }
      const payload: unknown = await response.json();
      // never render an unvalidated helper response
      if (!isCloudflareStatus(payload)) { if (mounted.current) setError('Cloudflare returned an unsupported status.'); return; }
      if (!mounted.current) return;
      setStatus(payload);
      // collapse setup only when this view's accepted activation actually completes
      setReplacement(current => current.operationId === payload.operation?.id && payload.operation?.state === 'complete' ? { open: false } : current);
      setDraft(current => {
        // initialize only once so polling cannot replace an authored hostname
        if (!current.initialized) return { ...current, initialized: true, hostname: payload.hostname ?? '', baselineHostname: payload.hostname ?? '' };
        // settle a hostname draft only after authoritative verification completes
        if (payload.verifiedAt !== undefined && payload.hostname === hostnameValue(current.hostname) && payload.operation?.state !== 'failed' && payload.operation?.state !== 'running' && payload.operation?.state !== 'queued') return { ...current, baselineHostname: current.hostname };
        return current;
      });
    } catch { if (mounted.current) setError('Cloudflare status is unavailable. Your current RAC address has not been changed by this page.'); }
    finally { if (mounted.current) setLoading(false); }
  }, [runtime.request, setDraft, setReplacement, setStatus]);

  // keep setup progress live only while this page is mounted
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 4_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);
  // revoke entered plaintext and any unsubmitted confirmation on control changes
  useEffect(() => { setRevealed(false); setConfirming(false); }, [runtime.canMutate, runtime.securityEpoch]);

  const operation = status?.operation;
  const running = submitting || operation?.state === 'queued' || operation?.state === 'running';
  const connectorRunning = status?.connected === true;
  const existing = status?.mode === 'local' || status?.mode === 'token' && status.hostname !== undefined;
  const showGuide = status !== undefined && (!existing || replacement.open);
  const endpoint = status?.endpoint ?? (status?.hostname === undefined ? undefined : `https://${status.hostname}`);
  const unavailable = disabled || loading || status?.supported !== true || running || blockedByDrafts;
  const hostname = hostnameValue(draft.hostname);
  const serviceUrl = status?.serviceUrl ?? 'http://127.0.0.1:8787';
  const instructions = cloudflareSetupInstructions(serviceUrl, hostname ?? '');
  const activeOrigin = connectorRunning && status?.verifiedAt !== undefined && status.hostname !== undefined ? `https://${status.hostname}` : undefined;

  // use the clipboard only after an explicit copy action
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(`${label} copied.`); }
    catch { setCopied('Copy unavailable. Select and copy the text below.'); }
  };

  // publish one explicitly requested step through the controller-only host queue
  const submit = async (action: 'connect' | 'activate') => {
    // retain a synchronous duplicate-submit and authority boundary
    if (pendingRequest.current || unavailable || !authority.current || action === 'activate' && hostname === undefined) return;
    pendingRequest.current = true;
    setSubmitting(true); setError(''); setConfirming(false);
    const capturedHostname = hostname;
    try {
      const body = action === 'connect' ? { action, ...(draft.token.trim() === '' ? {} : { token: draft.token.trim() }) } : { action, hostname: capturedHostname };
      const response = await runtime.request('/api/settings/cloudflare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      // report only bounded API diagnostics and keep unrelated drafts intact
      if (!response.ok) { if (mounted.current) setError(await settingsResponseError(response, 'Cloudflare setup could not be started.')); return; }
      const payload: unknown = await response.json();
      // require a durable accepted operation before discarding entered plaintext
      if (payload === null || typeof payload !== 'object' || !('operation' in payload) || !isSettingsOperation(payload.operation) || !['queued', 'running', 'complete'].includes(payload.operation.state)) { if (mounted.current) setError('Cloudflare setup could not be confirmed. Refresh status before retrying.'); return; }
      const accepted = payload.operation;
      // retain replacement progress across tabs until the selected activation settles
      if (action === 'activate') setReplacement({ open: true, operationId: accepted.id });
      clearToken(); setRevealed(false);
      // keep the accepted hostname dirty until the host independently verifies it
      if (action === 'activate' && capturedHostname !== undefined) setDraft(current => ({ ...current, hostname: capturedHostname }));
      if (mounted.current) setStatus(current => current === undefined ? current : { ...current, operation: accepted });
      await runtime.refreshStatus();
      await refresh();
    } catch { if (mounted.current) setError('Setup was interrupted. Refresh status before retrying; keep your current RAC page open.'); }
    finally { pendingRequest.current = false; if (mounted.current) setSubmitting(false); }
  };

  return <div className="settings-cloudflare" data-settings-path="cloudflare">
    <section className="settings-cloudflare-status" data-settings-path="cloudflare.status" aria-label="Cloudflare connection status" aria-live="polite">
      {existing && !showGuide ? <>
        <div className="settings-cloudflare-tunnel-summary">{endpoint === undefined ? <span>Endpoint not configured</span> : <a href={endpoint}>{endpoint}</a>}<span className={`settings-cloudflare-tunnel-state ${status?.connected === undefined ? 'unknown' : connectorRunning ? 'up' : 'down'}`} role="status" aria-label="Tunnel status" title={status?.connected === undefined ? 'Connector process status is unavailable' : connectorRunning ? 'Connector process is running' : 'Connector process is stopped'}>{status?.connected === undefined ? 'Unknown' : connectorRunning ? 'Up' : 'Down'}</span></div>
        <button type="button" disabled={disabled || running || blockedByDrafts} onClick={() => { /* reopen instructions without changing the existing tunnel */ setReplacement({ open: true }); }}>Replace tunnel</button>
      </> : <>
      <strong>{loading ? 'Loading Cloudflare…' : running ? 'Applying Cloudflare setup…' : status?.mode === 'local' ? 'Existing file-managed tunnel' : status?.mode === 'token' && !connectorRunning ? 'Connector stopped' : connectorRunning && status?.verifiedAt ? 'Public hostname verified' : connectorRunning ? 'Connector started · hostname not verified' : 'Not connected'}</strong>
      {operation?.state === 'running' && <span>{operation.phase ?? 'The host is applying this step…'}</span>}
      {operation?.state === 'failed' && <span role="alert">{operation.error === undefined ? 'The setup step failed. Your previous public address is retained or recovered.' : cloudflareFailure(operation.error)}</span>}
      {activeOrigin && <a href={activeOrigin}>Open {activeOrigin}</a>}
      {status?.verifiedAt && <small>Last verified: {status.hostname} · {status.verifiedAt}</small>}
      {running && status?.reconnectOrigin && operation?.phase === 'restarting-rac' && <a href={status.reconnectOrigin}>Open the new RAC address after verification</a>}
      <button type="button" disabled={submitting} onClick={() => { /* retry safe metadata only */ setError(''); void refresh(); }}>Refresh status</button>
      {existing && <button type="button" disabled={setup.dirty || running} title={setup.dirty ? 'Discard setup changes before returning to the tunnel summary' : undefined} onClick={() => { /* leave the guide without discarding any authored draft */ setReplacement({ open: false }); }}>Back to tunnel</button>}
      </>}
    </section>
    {error && <p className="error" role="alert">{cloudflareFailure(error)}</p>}
    {showGuide && <>
    {status?.supported === false && <p role="note">{status.reason === 'settings_applier_unavailable' ? 'Install the Settings host applier before setting up a tunnel.' : status.reason === 'cloudflare-token-compose-only' || status.reason === undefined ? 'New tunnel setup is available for Docker installations only. Native installations can manage an already installed cloudflared service below.' : status.reason}</p>}
    {blockedByDrafts && <p role="note">Save or discard other Settings changes before starting Cloudflare setup. Saved changes awaiting a restart must also be applied first.</p>}
    <section className="settings-schema-section">
      <header><h3>1. Create a tunnel in Cloudflare</h3></header>
      <p>Use a remotely managed Cloudflared tunnel. Cloudflare owns your DNS and route; RAC runs the connector. No account API token is needed.</p>
      <a href="https://developers.cloudflare.com/tunnel/get-started/" target="_blank" rel="noreferrer">Open Cloudflare’s setup guide</a>
      <button type="button" onClick={() => { /* copy only public setup guidance */ void copy('Setup instructions', instructions); }}>Copy setup instructions</button>
      <details><summary>Step-by-step instructions</summary><pre className="settings-cloudflare-instructions">{instructions}</pre></details>
    </section>
    <section className="settings-schema-section">
      <header><h3>2. Start the connector</h3></header>
      <p>Copy only the tunnel token from Cloudflare’s installation command. Do not run that command yourself.</p>
      <label className="settings-cloudflare-field" data-settings-path="cloudflare.token"><span>Tunnel token</span><span className="settings-cloudflare-token"><input aria-label="Tunnel token" type={revealed ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.token} placeholder={status?.tokenPresent ? 'Token saved · leave blank to reuse' : 'Paste the tunnel token'} disabled={unavailable} onChange={event => { /* retain only the newly entered credential in memory */ setDraft(current => ({ ...current, token: event.target.value })); }} /><SettingsRevealButton label="tunnel token" revealed={revealed} disabled={unavailable || draft.token === ''} onToggle={() => { /* reveal entered bytes only, never retrieve a saved token */ setRevealed(current => !current); }} /></span></label>
      <button type="button" className="settings-cloudflare-primary" disabled={unavailable || !status?.tokenPresent && draft.token.trim() === ''} onClick={() => { /* start only the connector, without switching RAC's origin */ void submit('connect'); }}>Start connector</button>
      <p>This step leaves RAC at its current address. Existing file-managed tunnels are not removed.</p>
    </section>
    <section className="settings-schema-section">
      <header><h3>3. Publish the application route</h3></header>
      <p>Once Cloudflare shows the connector connected, continue to Routes → Add route → Published application. Choose your hostname and save the route.</p>
      <label className="settings-cloudflare-field" data-settings-path="cloudflare.hostname"><span>Hostname</span><input aria-label="Hostname" type="text" autoComplete="off" spellCheck={false} placeholder="rac.example.com" value={draft.hostname} disabled={disabled || running || !runtime.canMutate || status?.supported !== true} onChange={event => { /* stage the intended address without changing the application */ setDraft(current => ({ ...current, hostname: event.target.value })); }} /></label>
      <div className="settings-cloudflare-copy-row"><code>{hostname ?? 'your RAC hostname'}</code><button type="button" disabled={hostname === undefined} onClick={() => { /* copy a hostname, not a URL or token */ void copy('Hostname', hostname!); }}>Copy hostname</button></div>
      <div className="settings-cloudflare-copy-row"><span><small>Service URL · HTTP</small><code>{serviceUrl}</code></span><button type="button" onClick={() => { /* copy the running loopback origin */ void copy('Service URL', serviceUrl); }}>Copy service URL</button></div>
      <p>If Cloudflare separates the fields, select HTTP and paste the address without <code>http://</code> into URL. Cloudflare Access must allow <code>/healthz</code> through for verification.</p>
    </section>
    <section className="settings-schema-section">
      <header><h3>4. Verify and switch RAC’s address</h3></header>
      <p>RAC checks that the public route reaches this exact instance before changing its public address. A hostname change restarts RAC and requires signing in again. Keep this page open until it succeeds.</p>
      <button type="button" className="settings-cloudflare-primary" disabled={unavailable || status?.enabled !== true || !connectorRunning || hostname === undefined || confirmationTarget == null} onClick={() => { /* require explicit consent for the origin transition */ setConfirming(true); }}>Verify and use hostname</button>
    </section>
    </>}
    {copied && <p role="status">{copied}</p>}
    {(advanced || existing) && <details className="settings-cloudflare-advanced"><summary>Configuration files</summary>{advanced ?? <p>This tunnel’s routes are managed in Cloudflare, so there is no local tunnel configuration file to edit. <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Open Cloudflare</a></p>}</details>}
    {confirming && confirmationTarget != null && <SplitConfirmation target={confirmationTarget} title="Use this public hostname?" description={<>Verify <strong>https://{hostname}</strong> reaches this RAC, then switch the public address and restart RAC if needed. If verification fails, the address is not changed. Keep this page open for the reconnect link.</>} confirmLabel="Verify and use hostname" tone="normal" pending={submitting} onCancel={() => { /* leave setup drafts untouched */ setConfirming(false); }} onConfirm={() => submit('activate')} />}
  </div>;
}
