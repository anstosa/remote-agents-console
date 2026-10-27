import { createContext, type CSSProperties, type MouseEvent, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { openContextMenu } from './context-menu.js';
import { preserveContextMenuPress } from './selection-context-menu.js';
import { resetTerminalCommands, terminalCommandFits } from './terminal-command-draft.js';

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
export type ButtonActionDraft = { kind: 'shell'; text: string; placeId: string } | { kind: 'prompt'; text: string; placeId: string; agentId: string };
type ButtonEntry = { key: string; button: ButtonPresentation; slot: ButtonSlot; placeId: string; requestId: string; operation?: ButtonOperation; starting: boolean; boot?: number; worktreeId?: string; filesDirectoryToken?: string };
type ButtonActionView = ButtonPresentation & { busy: boolean; disabled: boolean; disabledReason?: string; run: () => void; edit: (panelKey?: string) => void };
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

// accept only bounded trusted drafts matching the clicked action and place
const draftFrom = (value: unknown, button: ButtonPresentation, context: ActionContext): ButtonActionDraft | undefined => {
  // require the server's draft envelope
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = (value as { draft?: unknown }).draft;
  // reject incomplete or retargeted payloads before changing an editor
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const draft = candidate as Partial<ButtonActionDraft>;
  // files directory quoting may expand the original command but remains bounded
  if (draft.kind !== button.actionKind || draft.placeId !== context.placeId || typeof draft.text !== 'string' || !draft.text.trim() || !terminalCommandFits(draft.text) || draft.text.includes('\0')) return undefined;
  // prompt drafts must name the exact selected agent when one was supplied
  if (draft.kind === 'prompt' && (typeof draft.agentId !== 'string' || !draft.agentId || draft.agentId.length > 4096 || context.agentId !== undefined && draft.agentId !== context.agentId)) return undefined;
  return draft as ButtonActionDraft;
};

// describe terminal success from the server's exact completion phase
const completionFeedback = (entry: ButtonEntry): Parameters<ButtonFeedback>[0] => entry.operation?.phase === 'submitted'
  ? { tone: 'success', message: `${entry.button.text} submitted`, detail: 'Prompt submitted to the agent.', worktreeId: entry.worktreeId }
  : { tone: 'success', message: `${entry.button.text} finished`, detail: entry.button.actionKind === 'prompt' ? 'The agent action finished.' : 'The command exited successfully.', worktreeId: entry.worktreeId };

// keep action state above flyouts and panels so ordinary unmounts do not lose progress
export function ConfiguredButtonsProvider({ catalog, serverStartedAt, context, request, onFeedback, onEdit, children }: { catalog?: ButtonCatalog; serverStartedAt?: number; context: ActionContext; request: ButtonRequest; onFeedback: ButtonFeedback; onEdit: (draft: ButtonActionDraft, panelKey?: string) => Promise<void>; children: ReactNode }) {
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
    // old pane ids must not inherit editable bytes in a new server boot
    resetTerminalCommands();
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

  // prepare editable bytes without invoking the action execution endpoint
  const edit = useCallback(async (button: ButtonPresentation, slot: ButtonSlot, filesDirectoryToken?: string, panelKey?: string) => {
    const activeCatalog = currentCatalog.current;
    const activeContext = currentContext.current;
    // require the same workspace and catalog authority as ordinary execution
    if (activeCatalog === undefined || activeContext.placeId === undefined) return;
    const key = `${activeCatalog.revision}\u0000${slot}\u0000${activeContext.placeId}\u0000${button.id}`;
    const existing = entries.current.get(key);
    // never duplicate a pending preparation or active execution
    if (existing?.starting || existing?.operation !== undefined && busyStates.has(existing.operation.state)) return;
    const entry: ButtonEntry = { key, button, slot, placeId: activeContext.placeId, requestId: requestId(), starting: true, boot: boot.current, worktreeId: activeContext.worktreeId };
    entries.current.set(key, entry);
    publish();
    try {
      const response = await request('/api/button-actions/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        actionId: button.id, configRevision: activeCatalog.revision, placeId: activeContext.placeId, slot,
        ...(activeContext.agentId === undefined ? {} : { agentId: activeContext.agentId }),
        ...(slot === 'split:files' && button.actionKind === 'shell' && filesDirectoryToken !== undefined ? { filesDirectoryToken } : {})
      }) });
      const payload: unknown = await response.json().catch(() => undefined);
      const draft = response.ok ? draftFrom(payload, button, activeContext) : undefined;
      // discovery may publish this exact newly launched agent before its draft response
      const launchedAgent = draft?.kind === 'prompt' && activeContext.agentId === undefined && currentContext.current.agentId === draft.agentId;
      // do not write old bytes into a newly selected workspace, agent or server boot
      if (entry.boot !== boot.current || currentCatalog.current?.revision !== activeCatalog.revision || currentContext.current.placeId !== activeContext.placeId || currentContext.current.agentId !== activeContext.agentId && !launchedAgent) throw new Error('The workspace changed. Open the action again to edit it.');
      // unavailable definitions never fall through to action execution
      if (draft === undefined) throw new Error('Unable to prepare this action. Refresh the workspace and try again.');
      await onEdit(draft, panelKey);
    } catch (error) {
      onFeedback({ tone: 'error', message: `${button.text} could not be edited`, detail: error instanceof Error ? error.message : 'The action could not be prepared.', worktreeId: activeContext.worktreeId });
    } finally {
      entry.starting = false;
      publish();
    }
  }, [onEdit, onFeedback, publish, request]);

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
        return { ...button, busy, disabled: disabledReason !== undefined || busy, ...(disabledReason === undefined ? {} : { disabledReason }), run: () => void start(button, slot, filesDirectoryToken), edit: panelKey => void edit(button, slot, filesDirectoryToken, panelKey) };
      }),
      busy: slot => buttonsFor(slot).some(button => {
        // require an executable workspace context
        if (catalog === undefined || context.placeId === undefined) return false;
        const entry = entries.current.get(`${catalog.revision}\u0000${slot}\u0000${context.placeId}\u0000${button.id}`);
        return entry?.starting === true || entry?.operation !== undefined && busyStates.has(entry.operation.state);
      })
    };
  }, [catalog, context.agentId, context.placeId, context.projectId, revision, start, edit]);

  return <ConfiguredButtonsContext.Provider value={value}>{children}</ConfiguredButtonsContext.Provider>;
}

// expose one slot's effective actions to compact and flyout renderers
export const useConfiguredButtons = (slot: ButtonSlot | undefined, filesDirectoryToken?: string): ButtonActionView[] => useContext(ConfiguredButtonsContext).actions(slot, filesDirectoryToken);

// expose aggregate progress for a closed flyout trigger
export const useConfiguredButtonsBusy = (slot: ButtonSlot | undefined): boolean => useContext(ConfiguredButtonsContext).busy(slot);

// use the shared contextual menu for inline, folded and flyout custom buttons
export function openConfiguredButtonMenu(event: MouseEvent<HTMLElement>, action: ButtonActionView, onSelect?: () => void, panelKey?: string): void {
  openContextMenu(event, { label: `${action.text} actions`, items: [{ type: 'action', id: 'edit-before-submit', label: 'Edit before submit', disabled: action.disabled, onSelect: () => {
    // dismiss the owning flyout without running its ordinary click action
    action.edit(panelKey);
    onSelect?.();
  } }] });
}

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
  // panel capture handlers must defer to the custom button's own menu
  return <span className={`configured-button-list ${className}`.trim()}>{actions.map(action => <button key={action.id} type="button" className={`configured-button configured-button-${action.style} configured-button-${action.color}${action.busy ? ` progress-border progress-${action.color}` : ''}${buttonClassName === '' ? '' : ` ${buttonClassName}`}`} style={{ '--configured-button-color': `var(--${action.color})` } as CSSProperties} disabled={action.disabled} aria-busy={action.busy || undefined} aria-label={action.text} title={action.disabledReason ?? action.text} onPointerDownCapture={preserveContextMenuPress} onMouseDownCapture={preserveContextMenuPress} onContextMenu={event => openConfiguredButtonMenu(event, action, onSelect)} onClick={() => { action.run(); onSelect?.(); }}>{action.busy && <span className="update-progress-ring" aria-hidden="true" />}{action.icon !== undefined && <ConfiguredButtonIcon path={action.icon} />}<span className="configured-button-label">{action.text}</span></button>)}</span>;
}
