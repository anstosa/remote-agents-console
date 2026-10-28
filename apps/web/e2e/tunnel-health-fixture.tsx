import { type Dispatch, type SetStateAction, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useFullscreenAction, type FullscreenAction } from '../src/fullscreen-loader.js';
import type { SettingsRequest, SettingsStatus, TunnelHealth } from '../src/settings/contracts.js';
import { ConsoleFullscreenLoader, SettingsRuntimeProvider, TunnelHealthNotice, useSettingsRuntime } from '../src/settings/runtime.js';

type HeldReconnect = { resolved: boolean; resolve: (response: Response) => void };
type PostObservation = { label?: string; opacity?: string; nestedNoticeCount: number };
type TunnelSnapshot = { action?: FullscreenAction; canMutate: boolean; enabled: boolean; postCount: number; posts: PostObservation[]; health?: TunnelHealth };

const idleStatus: SettingsStatus = { pending: false, targets: [], effective: 'known', restartAvailable: true };
const degradedHealth: TunnelHealth = { state: 'degraded', failures: 2, reconnecting: false, canReconnect: true, error: 'tunnel_unreachable' };
let serverHealth: TunnelHealth = degradedHealth;
let monitorFailure = false;
let heldReconnects: HeldReconnect[] = [];
let postObservations: PostObservation[] = [];
let setEnabled: Dispatch<SetStateAction<boolean>> | undefined;
let setCanMutate: Dispatch<SetStateAction<boolean>> | undefined;
let setOverlay: Dispatch<SetStateAction<boolean>> | undefined;
let runtime: ReturnType<typeof useSettingsRuntime> | undefined;
let snapshot: TunnelSnapshot = { canMutate: true, enabled: true, postCount: 0, posts: [] };

// return one json response from the in-page fake server
const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// serve operation mutations separately from cached health reads
const request: SettingsRequest = async (url, init) => {
  // retain ordinary runtime status polling
  if (url === '/api/settings/status') return jsonResponse(idleStatus);
  // hold only exact reconnect mutations
  if (url !== '/api/settings/cloudflare/reconnect' || init?.method !== 'POST' || init.body !== '{}') return jsonResponse({ error: 'not mocked' }, 404);
  const overlay = document.querySelector<HTMLElement>('.fullscreen-loader');
  postObservations.push({ label: overlay?.getAttribute('aria-label') ?? undefined, opacity: overlay === null ? undefined : getComputedStyle(overlay).opacity, nestedNoticeCount: overlay?.querySelectorAll('.tunnel-health-notice').length ?? 0 });
  return new Promise<Response>(resolve => { heldReconnects.push({ resolved: false, resolve }); });
};

// publish one server-owned cached health snapshot
const monitorRequest: SettingsRequest = async url => url === '/api/settings/cloudflare/health' ? monitorFailure ? jsonResponse({ error: 'health_unavailable' }, 503) : jsonResponse(serverHealth) : jsonResponse({ error: 'not mocked' }, 404);

// expose production runtime state to playwright without fixture controls
function TunnelProbe({ action, enabled, canMutate }: { action?: FullscreenAction; enabled: boolean; canMutate: boolean }) {
  const current = useSettingsRuntime();
  runtime = current;
  snapshot = { action, enabled, canMutate, postCount: heldReconnects.length, posts: [...postObservations], health: current.tunnelHealth };
  return <section aria-label="Tunnel health lifecycle"><output aria-label="Tunnel health state">{current.tunnelHealth?.state ?? 'loading'}</output></section>;
}

// mount the global notice and optional outage cover
function TunnelHealthFixture() {
  const [enabled, updateEnabled] = useState(true);
  const [canMutate, updateCanMutate] = useState(true);
  const [overlay, updateOverlay] = useState(false);
  const fullscreen = useFullscreenAction();
  setEnabled = updateEnabled;
  setCanMutate = updateCanMutate;
  setOverlay = updateOverlay;
  // begin reconnect only after the dedicated page is painted
  const beforeTunnelReconnect = useCallback(() => fullscreen.begin('tunnel-reconnect'), [fullscreen.begin]);
  // release only the connector recovery page
  const onTunnelReconnectSettled = useCallback(() => fullscreen.finish('tunnel-reconnect'), [fullscreen.finish]);
  return <SettingsRuntimeProvider request={request} monitorRequest={monitorRequest} enabled={enabled} canMutate={canMutate} beforeTunnelReconnect={beforeTunnelReconnect} onTunnelReconnectSettled={onTunnelReconnectSettled}>
    <TunnelProbe action={fullscreen.action} enabled={enabled} canMutate={canMutate} />
    <div className="toast-region"><TunnelHealthNotice /></div>
    <ConsoleFullscreenLoader action={fullscreen.action} reconnecting={overlay} onEntered={fullscreen.entered} />
  </SettingsRuntimeProvider>;
}

// wait through provider and portal paints
const settleFrames = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

// mount a fresh isolated tunnel monitor
export function renderTunnelHealthFixture(root: HTMLElement): void {
  serverHealth = degradedHealth;
  monitorFailure = false;
  heldReconnects = [];
  postObservations = [];
  setEnabled = undefined;
  setCanMutate = undefined;
  setOverlay = undefined;
  runtime = undefined;
  snapshot = { canMutate: true, enabled: true, postCount: 0, posts: [] };
  createRoot(root).render(<TunnelHealthFixture />);
}

// publish and reconcile one cached server snapshot
export async function setTunnelServerHealth(health: TunnelHealth): Promise<void> {
  // require a mounted runtime owner
  if (runtime === undefined) throw new Error('Tunnel health fixture is not mounted');
  serverHealth = health;
  await runtime.refreshTunnelHealth();
  await settleFrames();
}

// make one explicit monitor read fail without changing its last safe snapshot
export async function failTunnelHealthRead(): Promise<void> {
  // require a mounted runtime owner
  if (runtime === undefined) throw new Error('Tunnel health fixture is not mounted');
  monitorFailure = true;
  await runtime.refreshTunnelHealth();
}

// change controller authority without changing health visibility
export async function setTunnelCanMutate(canMutate: boolean): Promise<void> {
  // require a mounted authority owner
  if (setCanMutate === undefined) throw new Error('Tunnel health fixture is not mounted');
  setCanMutate(canMutate);
  await settleFrames();
}

// change authentication without resolving an in-flight action
export async function setTunnelEnabled(enabled: boolean): Promise<void> {
  // require a mounted authentication owner
  if (setEnabled === undefined) throw new Error('Tunnel health fixture is not mounted');
  setEnabled(enabled);
  await settleFrames();
}

// show or hide the production console outage cover
export async function setTunnelOverlay(visible: boolean): Promise<void> {
  // require a mounted overlay owner
  if (setOverlay === undefined) throw new Error('Tunnel health fixture is not mounted');
  setOverlay(visible);
  await settleFrames();
}

// release one reconnect response with the requested outcome
export function resolveTunnelReconnect(index: number, accepted: boolean): void {
  const held = heldReconnects[index];
  // reject duplicate and unknown releases
  if (held === undefined || held.resolved) throw new Error(`Reconnect ${index} is not pending`);
  held.resolved = true;
  // keep accepted operations busy until a later explicit monitor snapshot
  if (accepted) serverHealth = { ...serverHealth, state: 'checking', reconnecting: true, error: undefined };
  held.resolve(accepted
    ? jsonResponse({ operation: { id: `reconnect-${index}`, kind: 'cloudflare', state: 'queued', phase: 'reconnecting-cloudflare' } }, 202)
    : jsonResponse({ error: 'reconnect_failed' }, 503));
}

// return serializable fixture facts for polling
export function readTunnelSnapshot(): TunnelSnapshot {
  return { ...snapshot, postCount: heldReconnects.length, posts: [...postObservations] };
}
