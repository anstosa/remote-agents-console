import { type Dispatch, type SetStateAction, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useFullscreenAction, type FullscreenAction } from '../src/fullscreen-loader.js';
import type { SettingsRequest, SettingsStatus } from '../src/settings/contracts.js';
import { ConsoleFullscreenLoader, SettingsRuntimeProvider, useSettingsRuntime } from '../src/settings/runtime.js';

type HeldPost = {
  resolved: boolean;
  resolve: (response: Response) => void;
};

type RuntimeSnapshot = {
  action?: FullscreenAction;
  canMutate: boolean;
  enabled: boolean;
  postCount: number;
  restartPending: boolean;
  status?: SettingsStatus;
};

const idleStatus: SettingsStatus = { pending: false, targets: [], effective: 'known', restartAvailable: true };
let serverStatus: SettingsStatus = idleStatus;
let heldPosts: HeldPost[] = [];
let restartPromises: Array<Promise<void>> = [];
let setEnabled: Dispatch<SetStateAction<boolean>> | undefined;
let setCanMutate: Dispatch<SetStateAction<boolean>> | undefined;
let runtime: ReturnType<typeof useSettingsRuntime> | undefined;
let snapshot: RuntimeSnapshot = { enabled: true, canMutate: true, postCount: 0, restartPending: false };

// return one json response from the in-page fake server
const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// hold restart posts while status reads return the selected server snapshot
const request: SettingsRequest = async (url, init) => {
  // respond to the provider's status reconciliation reads
  if (url === '/api/settings/status') return jsonResponse(serverStatus);
  // reject unexpected fixture traffic
  if (url !== '/api/settings/restart' || init?.method !== 'POST') return jsonResponse({ error: 'not mocked' }, 404);
  return new Promise<Response>(resolve => {
    heldPosts.push({ resolve, resolved: false });
  });
};

// expose the actual runtime state without relying on inert fixture controls
function RuntimeProbe({ action, enabled, canMutate }: { action?: FullscreenAction; enabled: boolean; canMutate: boolean }) {
  const current = useSettingsRuntime();
  runtime = current;
  snapshot = { action, enabled, canMutate, postCount: heldPosts.length, restartPending: current.restartPending, status: current.status };
  return <section aria-label="Settings runtime lifecycle"><output aria-label="Runtime action">{action ?? 'none'}</output></section>;
}

// mount production restart coordination behind controllable auth and authority state
function SettingsRuntimeFixture() {
  const [enabled, updateEnabled] = useState(true);
  const [canMutate, updateCanMutate] = useState(true);
  const fullscreen = useFullscreenAction();
  setEnabled = updateEnabled;
  setCanMutate = updateCanMutate;
  // begin restart only after the fullscreen cover is painted
  const beforeRestart = useCallback(() => fullscreen.begin('restart'), [fullscreen.begin]);
  // release only the matching restart cover
  const onRestartSettled = useCallback(() => fullscreen.finish('restart'), [fullscreen.finish]);
  return <SettingsRuntimeProvider request={request} enabled={enabled} canMutate={canMutate} beforeRestart={beforeRestart} onRestartSettled={onRestartSettled}>
    <RuntimeProbe action={fullscreen.action} enabled={enabled} canMutate={canMutate} />
    <ConsoleFullscreenLoader action={fullscreen.action} reconnecting={false} onEntered={fullscreen.entered} />
  </SettingsRuntimeProvider>;
}

// wait for react and fullscreen frame work after one external control update
const settleFrames = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

// mount a fresh isolated production runtime
export function renderSettingsRuntimeFixture(root: HTMLElement) {
  serverStatus = idleStatus;
  heldPosts = [];
  restartPromises = [];
  setEnabled = undefined;
  setCanMutate = undefined;
  runtime = undefined;
  snapshot = { enabled: true, canMutate: true, postCount: 0, restartPending: false };
  createRoot(root).render(<SettingsRuntimeFixture />);
}

// start one restart without waiting for its held post
export function startRuntimeRestart(): number {
  // require the mounted probe before dispatch
  if (runtime === undefined) throw new Error('Settings runtime fixture is not mounted');
  const index = restartPromises.length;
  restartPromises.push(runtime.restart());
  return index;
}

// wait for one restart callback to settle after its response is released
export async function waitRuntimeRestart(index: number): Promise<void> {
  const pending = restartPromises[index];
  // reject invalid fixture bookkeeping
  if (pending === undefined) throw new Error(`Restart ${index} was not started`);
  await pending;
}

// change the authentication boundary and wait for its effects
export async function setRuntimeEnabled(enabled: boolean): Promise<void> {
  // require a mounted state owner
  if (setEnabled === undefined) throw new Error('Settings runtime fixture is not mounted');
  setEnabled(enabled);
  await settleFrames();
}

// change mutation authority and wait for its render
export async function setRuntimeCanMutate(canMutate: boolean): Promise<void> {
  // require a mounted state owner
  if (setCanMutate === undefined) throw new Error('Settings runtime fixture is not mounted');
  setCanMutate(canMutate);
  await settleFrames();
}

// choose the payload returned by subsequent fresh status reads
export function setRuntimeServerStatus(status: SettingsStatus): void {
  serverStatus = status;
}

// force one production status reconciliation
export async function refreshRuntimeStatus(): Promise<void> {
  // require the mounted probe before refresh
  if (runtime === undefined) throw new Error('Settings runtime fixture is not mounted');
  await runtime.refreshStatus();
  await settleFrames();
}

// release one held restart acknowledgement
export function resolveRuntimePost(index: number, payload: SettingsStatus, status = 200): void {
  const held = heldPosts[index];
  // reject duplicate and unknown response releases
  if (held === undefined || held.resolved) throw new Error(`Restart POST ${index} is not pending`);
  held.resolved = true;
  held.resolve(jsonResponse(payload, status));
}

// return serializable facts for playwright polling
export function readRuntimeSnapshot(): RuntimeSnapshot {
  return { ...snapshot, postCount: heldPosts.length };
}
