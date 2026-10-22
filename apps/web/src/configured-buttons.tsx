import { createContext, type CSSProperties, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

type ButtonColor = 'rosewater' | 'flamingo' | 'pink' | 'mauve' | 'red' | 'maroon' | 'peach' | 'yellow' | 'green' | 'teal' | 'sky' | 'sapphire' | 'blue' | 'lavender';
type ButtonStyle = 'outline' | 'solid';
type ButtonSplitKind = 'agent' | 'terminal' | 'note' | 'browser' | 'files' | 'code' | 'review' | 'stack' | 'settings';
export type ButtonSlot = 'tabLead' | 'leftNav' | 'rightNav' | 'navMenu' | 'pullRequest' | `split:${ButtonSplitKind}`;
type ButtonPresentation = { id: string; text: string; icon?: string; color: ButtonColor; style: ButtonStyle; actionKind: 'shell' | 'prompt' };
export type ButtonCatalog = { revision: string; application: Record<ButtonSlot, ButtonPresentation[]>; projects: Record<string, Record<ButtonSlot, ButtonPresentation[]>> };
type ButtonOperation = { id: string; state: 'queued' | 'launching' | 'running' | 'complete' | 'failed' | 'interrupted'; phase?: string; error?: string; exitCode?: number };

type ButtonRequest = (url: string, init?: RequestInit, observeReachability?: boolean) => Promise<Response>;
type ButtonFeedback = (feedback: { tone: 'pending' | 'success' | 'error'; message: string; detail: string; worktreeId?: string }) => void;
type ActionContext = { placeId?: string; projectId?: string; agentId?: string; worktreeId?: string };
type ButtonEntry = { key: string; button: ButtonPresentation; slot: ButtonSlot; placeId: string; requestId: string; operation?: ButtonOperation; starting: boolean; boot?: number; worktreeId?: string; filesDirectoryToken?: string };
type ButtonActionView = ButtonPresentation & { busy: boolean; disabled: boolean; disabledReason?: string; run: () => void };
type ProviderValue = {
  actions: (slot: ButtonSlot | undefined, filesDirectoryToken?: string) => ButtonActionView[];
  busy: (slot: ButtonSlot | undefined) => boolean;
};

const busyStates = new Set<ButtonOperation['state']>(['queued', 'launching', 'running']);
const ConfiguredButtonsContext = createContext<ProviderValue>({ actions: () => [], busy: () => false });

// create one opaque start identity before any network request
const requestId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

// read a bounded operation response without trusting malformed payloads
const operationFrom = (value: unknown): ButtonOperation | undefined => {
  // require an envelope
  if (value === null || typeof value !== 'object') return undefined;
  const operation = (value as { operation?: unknown }).operation;
  // require an operation object
  if (operation === null || typeof operation !== 'object') return undefined;
  const candidate = operation as Partial<ButtonOperation>;
  // require the public lifecycle vocabulary
  if (typeof candidate.id !== 'string' || !['queued', 'launching', 'running', 'complete', 'failed', 'interrupted'].includes(candidate.state ?? '')) return undefined;
  return candidate as ButtonOperation;
};

// describe terminal success from the server's exact completion phase
const completionFeedback = (entry: ButtonEntry): Parameters<ButtonFeedback>[0] => entry.operation?.phase === 'submitted'
  ? { tone: 'success', message: `${entry.button.text} submitted`, detail: 'Prompt submitted to the agent.', worktreeId: entry.worktreeId }
  : { tone: 'success', message: `${entry.button.text} finished`, detail: entry.button.actionKind === 'prompt' ? 'The agent action finished.' : 'The command exited successfully.', worktreeId: entry.worktreeId };

// keep action state above flyouts and panels so ordinary unmounts do not lose progress
export function ConfiguredButtonsProvider({ catalog, serverStartedAt, context, request, onFeedback, children }: { catalog?: ButtonCatalog; serverStartedAt?: number; context: ActionContext; request: ButtonRequest; onFeedback: ButtonFeedback; children: ReactNode }) {
  const entries = useRef(new Map<string, ButtonEntry>());
  const timers = useRef(new Map<string, number>());
  const boot = useRef(serverStartedAt);
  const currentCatalog = useRef(catalog);
  const currentContext = useRef(context);
  const [revision, setRevision] = useState(0);
  currentCatalog.current = catalog;
  currentContext.current = context;
  const publish = useCallback(() => setRevision(value => value + 1), []);

  // stop polling and fail closed when the server boot changes
  useEffect(() => {
    // retain work within one boot
    if (boot.current === serverStartedAt) return;
    boot.current = serverStartedAt;
    // interrupt every active old-boot entry
    for (const [key, entry] of entries.current) {
      // leave terminal entries intact
      if (!entry.starting && (entry.operation === undefined || !busyStates.has(entry.operation.state))) continue;
      entry.starting = false;
      entry.operation = { id: entry.operation?.id ?? entry.requestId, state: 'interrupted', error: 'server_restarted' };
      const timer = timers.current.get(key);
      // release its old poll
      if (timer !== undefined) window.clearTimeout(timer);
      timers.current.delete(key);
    }
    publish();
  }, [publish, serverStartedAt]);

  // release polling timers when the dashboard itself leaves
  useEffect(() => () => {
    // release every retained poll
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  const poll = useCallback((entry: ButtonEntry) => {
    // poll only the same server boot that accepted this request
    if (entry.operation === undefined || !busyStates.has(entry.operation.state) || entry.boot !== boot.current) return;
    const tick = window.setTimeout(async () => {
      timers.current.delete(entry.key);
      let response: Response;
      try {
        response = await request(`/api/button-actions/${encodeURIComponent(entry.operation!.id)}`);
      } catch {
        // retain authoritative pending state across a raw transport rejection
        if (entry.boot === boot.current) poll(entry);
        return;
      }
      const payload: unknown = await response.json().catch(() => undefined);
      // ignore an old-boot response after the dashboard has interrupted it
      if (entry.boot !== boot.current) return;
      const next = response.ok ? operationFrom(payload) : undefined;
      // keep transient network loss pending for the next exact-status poll
      if (next === undefined && response.status === 503 && entry.boot === boot.current) {
        poll(entry);
        return;
      }
      // an accepted operation that vanishes is explicitly uncertain, never successful
      entry.operation = next ?? { id: entry.operation!.id, state: 'interrupted', error: response.status === 404 ? 'operation_unavailable' : 'status_unavailable' };
      publish();
      // continue only active work
      if (busyStates.has(entry.operation.state)) {
        poll(entry);
        return;
      }
      // report the authoritative terminal projection once
      if (entry.operation.state === 'complete') onFeedback(completionFeedback(entry));
      else onFeedback({ tone: 'error', message: `${entry.button.text} failed`, detail: entry.operation.error ?? (entry.operation.exitCode === undefined ? 'The action did not complete.' : `The command exited with status ${entry.operation.exitCode}.`), worktreeId: entry.worktreeId });
    }, 1_000);
    timers.current.set(entry.key, tick);
  }, [onFeedback, publish, request]);

  const start = useCallback(async (button: ButtonPresentation, slot: ButtonSlot, filesDirectoryToken?: string) => {
    const activeCatalog = currentCatalog.current;
    const activeContext = currentContext.current;
    // require a workspace-backed place and current catalog
    if (activeCatalog === undefined || activeContext.placeId === undefined) return;
    const key = `${activeCatalog.revision}\u0000${slot}\u0000${activeContext.placeId}\u0000${button.id}`;
    const present = entries.current.get(key);
    // serialize only the same effective action instance
    if (present !== undefined && (present.starting || present.operation !== undefined && busyStates.has(present.operation.state))) return;
    const entry: ButtonEntry = { key, button, slot, placeId: activeContext.placeId, requestId: requestId(), starting: true, boot: boot.current, ...(activeContext.worktreeId === undefined ? {} : { worktreeId: activeContext.worktreeId }), ...(filesDirectoryToken === undefined ? {} : { filesDirectoryToken }) };
    entries.current.set(key, entry);
    publish();
    const body = {
      requestId: entry.requestId,
      actionId: button.id,
      configRevision: activeCatalog.revision,
      placeId: activeContext.placeId,
      slot,
      ...(activeContext.agentId === undefined ? {} : { agentId: activeContext.agentId }),
      ...(slot === 'split:files' && button.actionKind === 'shell' && filesDirectoryToken !== undefined ? { filesDirectoryToken } : {})
    };
    // reuse this request id for the one same-boot recovery attempt
    const submit = async (): Promise<Response | undefined> => {
      try { return await request('/api/button-actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
      catch { return undefined; }
    };
    let response = await submit();
    // recover one ambiguous same-boot start
    if ((response === undefined || response.status === 503) && entry.boot === boot.current) {
      await new Promise(resolve => window.setTimeout(resolve, 500));
      // reject a boot changed during the delay
      if (entry.boot === boot.current) response = await submit();
    }
    const payload: unknown = response === undefined ? undefined : await response.json().catch(() => undefined);
    const operation = response?.ok === true ? operationFrom(payload) : undefined;
    entry.starting = false;
    // never replay across a changed server boot
    if (entry.boot !== boot.current) {
      entry.operation = { id: entry.requestId, state: 'interrupted', error: 'server_restarted' };
      publish();
      return;
    }
    // retain the server projection
    if (operation !== undefined) entry.operation = operation;
    else {
      const error = payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : response === undefined ? 'Console unavailable' : `Action request failed (${response.status}).`;
      entry.operation = { id: entry.requestId, state: response === undefined || response.status === 503 ? 'interrupted' : 'failed', error };
      onFeedback({ tone: 'error', message: `${button.text} failed`, detail: error, worktreeId: entry.worktreeId });
    }
    publish();
    // observe accepted active work
    if (entry.operation !== undefined && busyStates.has(entry.operation.state)) poll(entry);
    // report immediate completion
    else if (operation?.state === 'complete') onFeedback(completionFeedback(entry));
    // report immediate terminal failure
    else if (operation !== undefined) onFeedback({ tone: 'error', message: `${button.text} failed`, detail: operation.error ?? (operation.exitCode === undefined ? 'The action did not complete.' : `The command exited with status ${operation.exitCode}.`), worktreeId: entry.worktreeId });
  }, [onFeedback, poll, publish, request]);

  const value = useMemo<ProviderValue>(() => {
    // resolve the already-merged Project catalog from the active workspace
    const buttonsFor = (slot: ButtonSlot | undefined): ButtonPresentation[] => {
      // ignore panels without a configured slot
      if (slot === undefined) return [];
      const active = catalog === undefined ? undefined : context.projectId === undefined ? undefined : catalog.projects[context.projectId];
      return active?.[slot] ?? catalog?.application[slot] ?? [];
    };
    return {
      actions: (slot, filesDirectoryToken) => buttonsFor(slot).map(button => {
        // narrow the mapped slot for execution
        if (slot === undefined) throw new Error('configured button slot unavailable');
        const key = catalog === undefined || context.placeId === undefined ? undefined : `${catalog.revision}\u0000${slot}\u0000${context.placeId}\u0000${button.id}`;
        const entry = key === undefined ? undefined : entries.current.get(key);
        const busy = entry?.starting === true || entry?.operation !== undefined && busyStates.has(entry.operation.state);
        const filesUnavailable = slot === 'split:files' && button.actionKind === 'shell' && filesDirectoryToken === undefined;
        const disabledReason = context.placeId === undefined ? 'Open a Workspace to run this action.' : filesUnavailable ? 'Open a Files directory to run this command.' : undefined;
        return { ...button, busy, disabled: disabledReason !== undefined || busy, ...(disabledReason === undefined ? {} : { disabledReason }), run: () => void start(button, slot, filesDirectoryToken) };
      }),
      busy: slot => buttonsFor(slot).some(button => {
        // require an executable workspace context
        if (catalog === undefined || context.placeId === undefined) return false;
        const entry = entries.current.get(`${catalog.revision}\u0000${slot}\u0000${context.placeId}\u0000${button.id}`);
        return entry?.starting === true || entry?.operation !== undefined && busyStates.has(entry.operation.state);
      })
    };
  }, [catalog, context.agentId, context.placeId, context.projectId, revision, start]);

  return <ConfiguredButtonsContext.Provider value={value}>{children}</ConfiguredButtonsContext.Provider>;
}

// expose one slot's effective actions to compact and flyout renderers
export const useConfiguredButtons = (slot: ButtonSlot | undefined, filesDirectoryToken?: string): ButtonActionView[] => useContext(ConfiguredButtonsContext).actions(slot, filesDirectoryToken);

// expose aggregate progress for a closed flyout trigger
export const useConfiguredButtonsBusy = (slot: ButtonSlot | undefined): boolean => useContext(ConfiguredButtonsContext).busy(slot);

// draw existing-style SVG path data without accepting markup or urls in the browser
export function ConfiguredButtonIcon({ path, className = 'configured-button-icon' }: { path: string; className?: string }) {
  // blank artwork occupies no icon space
  if (path.trim() === '') return null;
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
}

// render the same action contract in tabs, toolbars, flyouts and PR controls
export function ConfiguredButtonList({ slot, filesDirectoryToken, className = '', buttonClassName = '', onSelect }: { slot: ButtonSlot; filesDirectoryToken?: string; className?: string; buttonClassName?: string; onSelect?: () => void }) {
  const actions = useConfiguredButtons(slot, filesDirectoryToken);
  // omit empty slot wrappers
  if (actions.length === 0) return null;
  return <span className={`configured-button-list ${className}`.trim()}>{actions.map(action => <button key={action.id} type="button" className={`configured-button configured-button-${action.style} configured-button-${action.color}${action.busy ? ` progress-border progress-${action.color}` : ''}${buttonClassName === '' ? '' : ` ${buttonClassName}`}`} style={{ '--configured-button-color': `var(--${action.color})` } as CSSProperties} disabled={action.disabled} aria-busy={action.busy || undefined} aria-label={action.text} title={action.disabledReason ?? action.text} onClick={() => { action.run(); onSelect?.(); }}>{action.busy && <span className="update-progress-ring" aria-hidden="true" />}{action.icon !== undefined && <ConfiguredButtonIcon path={action.icon} />}<span className="configured-button-label">{action.text}</span></button>)}</span>;
}
