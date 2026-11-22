import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pollWhileVisible } from './client-scheduling.js';
import { restoreCoverFocus } from './fullscreen-loader.js';
import { interceptShortcutKeys } from './keyboard.js';
import type { ProgressColor } from './panel-header.js';
import { stackProgressColor, type ProjectStack } from './stack-controls.js';
import { processesSummary, processStateText, resolveStackStatus, stackOperationLabel, type ProjectStackStatus } from './stack-operations.js';
import { ColoredTerminalOutput, isTerminalColorRanges, terminalOutputTail, type TerminalColorRange } from './terminal-output-colors.js';
import './screensaver.css';

export type ScreensaverConfig = { enabled: boolean; idleMinutes: number };
export type ScreensaverAgent = { id: string; identity?: string; label: string; state: string; tone: string; liveOutput: boolean; revision: string };
export type ScreensaverWorkspace = { id: string; label: string; detail?: string; status: { label: string; color?: ProgressColor }; agents: ScreensaverAgent[]; stack?: ProjectStack };
type Preview = { kind: 'output' | 'response'; text: string; available: boolean; truncated?: boolean; colors?: TerminalColorRange[] };
type Request = (url: string, init?: RequestInit) => Promise<Response>;

// coordinate user-only inactivity without observing agent output
export function useScreensaver(config: ScreensaverConfig | undefined, blocked: boolean) {
  const [active, setActive] = useState(false);
  const visible = useRef(false);
  const observing = useRef(false);
  const settings = useRef(config);
  settings.current = config;
  const fullscreenBlocked = useRef(blocked);
  fullscreenBlocked.current = blocked;
  const lastActivity = useRef(Date.now());
  const activationKey = useRef<string | undefined>(undefined);
  const keyboardFence = useRef(false);
  const heldKeys = useRef(new Set<string>());
  const suppressPointerUntil = useRef(0);

  // leave native shortcuts untouched while disabled or another modal owns input
  const enter = useCallback((event?: KeyboardEvent, fromCommand = false) => {
    // preserve disabled, recorder and background-tab boundaries
    if (fullscreenBlocked.current || settings.current?.enabled !== true || document.visibilityState !== 'visible' || document.querySelector('[data-shortcut-recorder]:focus-within') !== null) return false;
    // the palette closes synchronously before invoking its selected command
    const modalSelector = fromCommand ? '[aria-modal="true"]:not([aria-label="Command palette"])' : '[aria-modal="true"]';
    // exclude only the palette, not any other modal opening beside it
    if (document.querySelector(modalSelector) !== null) return false;
    activationKey.current = event?.code;
    visible.current = true;
    observing.current = true;
    setActive(true);
    return true;
  }, []);

  // release the display before another idle countdown can begin
  const dismiss = useCallback(() => {
    visible.current = false;
    lastActivity.current = Date.now();
    setActive(false);
  }, []);

  // yield input immediately and do not revive the dismissed saver after recovery
  useLayoutEffect(() => {
    // only a newly blocked view needs its gesture fences reset
    if (!blocked) return;
    keyboardFence.current = false;
    suppressPointerUntil.current = 0;
    dismiss();
  }, [blocked, dismiss]);

  // focus restoration must not acknowledge output that arrived behind the overview
  useEffect(() => {
    // portal layout cleanup restores focus before this passive fence is released
    if (!active) observing.current = false;
  }, [active]);

  // keep one activity listener and timer per enabled browser
  useEffect(() => {
    // master disable releases manual and automatic entry together
    if (config?.enabled !== true) { dismiss(); return; }
    // pause inactivity tracking until the higher-priority cover has closed
    if (blocked) return;
    let timer: number | undefined;
    const delay = config.idleMinutes * 60_000;
    lastActivity.current = Date.now();
    // schedule only the remaining operator-idle interval
    const schedule = () => {
      window.clearTimeout(timer);
      // zero disables automatic entry but keeps the manual shortcut
      if (delay <= 0 || visible.current) return;
      timer = window.setTimeout(() => {
        // long minute values need several browser-safe timeout windows
        if (Date.now() - lastActivity.current < delay) { schedule(); return; }
        // retry protected modal or hidden-tab entry without resetting user inactivity
        if (!enter()) timer = window.setTimeout(schedule, 1_000);
      }, Math.min(2_147_483_647, Math.max(0, delay - (Date.now() - lastActivity.current))));
    };
    // consume the complete dismissal gesture before any underlying control sees it
    const activity = (event: Event) => {
      // leave fullscreen input alone even before passive cleanup removes the listeners
      if (fullscreenBlocked.current) return;
      const key = event instanceof KeyboardEvent ? event : undefined;
      // track every key in the dismissal chord rather than only its first modifier
      if (key !== undefined) {
        // keyup outside the window must not leave a stale modifier fence
        for (const [held, down] of [['Control', key.ctrlKey], ['Shift', key.shiftKey], ['Alt', key.altKey], ['Meta', key.metaKey]] as const) {
          // release both physical modifier keys when the modifier is no longer down
          if (!down) { heldKeys.current.delete(`${held}Left`); heldKeys.current.delete(`${held}Right`); }
        }
        // record the current physical key until its matching release
        if (event.type === 'keydown') heldKeys.current.add(key.code);
        else heldKeys.current.delete(key.code);
      }
      // activation key release is not a new keypress
      if (event.type === 'keyup' && key?.code === activationKey.current) activationKey.current = undefined;
      // retain the keyboard fence through repeat and key release
      if (!visible.current && key !== undefined && keyboardFence.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // release the fence only when the entire chord is up
        if (heldKeys.current.size === 0) keyboardFence.current = false;
        return;
      }
      // a click automation or real gesture can move the mouse before pressing it
      if (!visible.current && key === undefined && Date.now() < suppressPointerUntil.current && event.type !== 'mousemove' && event.type !== 'pointermove') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // preserve normal input while observing inactivity outside screensaver
      if (!visible.current) {
        lastActivity.current = Date.now();
        schedule();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // consume pointer presses until their click, and activation-key repeats until release
      if (event.type === 'keyup' || event.type === 'pointerdown' || event.type === 'pointerup' || event.type === 'mousedown' || event.type === 'mouseup' || key?.repeat && key.code === activationKey.current) return;
      // keep dismissal input out of prompt, terminal and shortcuts after the overlay unmounts
      if (key !== undefined) keyboardFence.current = true;
      else suppressPointerUntil.current = Date.now() + 300;
      dismiss();
      schedule();
    };
    // intercept before the existing global dispatcher even after the overlay disappears
    const releaseKeys = interceptShortcutKeys(event => {
      // defer to the fullscreen cover during the handoff
      if (fullscreenBlocked.current) return false;
      const consumed = visible.current || keyboardFence.current;
      activity(event);
      return consumed;
    });
    // abandoned browser chords must not leave the normal console keyboard fenced
    const blur = () => { heldKeys.current.clear(); keyboardFence.current = false; activationKey.current = undefined; };
    window.addEventListener('blur', blur);
    const events = ['keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'mousemove', 'pointermove', 'touchstart', 'wheel'] as const;
    // capture before input reaches terminal or workspace controls
    for (const name of events) window.addEventListener(name, activity, { capture: true, passive: false });
    schedule();
    // release every owned listener and pending timeout on configuration change
    return () => {
      window.clearTimeout(timer);
      releaseKeys();
      window.removeEventListener('blur', blur);
      heldKeys.current.clear();
      keyboardFence.current = false;
      activationKey.current = undefined;
      // remove exactly this browser observer
      for (const name of events) window.removeEventListener(name, activity, true);
    };
  }, [blocked, config?.enabled, config?.idleMinutes, dismiss, enter]);

  // only explicit palette commands may replace the palette during its close event
  const manualEntry = useCallback((event?: KeyboardEvent) => enter(event, event === undefined), [enter]);
  return { active: active && !blocked && config?.enabled === true, observing, enter: manualEntry };
}

// validate bounded read-only preview replies and discard only invalid optional colors
const parsePreview = (value: unknown, identity: string): Preview | undefined => {
  // require an object with the exact public content fields
  if (value === null || typeof value !== 'object') return undefined;
  const preview = value as Partial<Preview> & { identity?: unknown };
  // a newer conversation's bytes cannot fill an older card
  if (preview.identity !== identity) return undefined;
  // reject malformed base content independently of optional presentation metadata
  if ((preview.kind !== 'output' && preview.kind !== 'response') || typeof preview.text !== 'string' || typeof preview.available !== 'boolean' || preview.truncated !== undefined && typeof preview.truncated !== 'boolean') return undefined;
  const colors = preview.kind === 'output' && isTerminalColorRanges(preview.colors, preview.text) ? preview.colors : undefined;
  return { kind: preview.kind, text: preview.text, available: preview.available, ...(preview.truncated === undefined ? {} : { truncated: preview.truncated }), ...(colors === undefined ? {} : { colors }) };
};

const stackStatusLabels: Record<ProjectStackStatus, string> = { working: 'Working', exited: 'Exited', partial: 'Partially running', healthy: 'Healthy', down: 'Down', running: 'Running', stopped: 'Stopped', unknown: 'Status unavailable' };

// describe the same stack state and transition colors the toolbar shows
const stackSummary = (stack: ProjectStack | undefined): { label: string; state: ProjectStackStatus; color?: ProgressColor } => {
  // distinguish unconfigured stacks from stopped configured ones
  if (stack === undefined || !stack.actions?.length && !stack.processes?.length && stack.running === undefined && stack.tunnel === undefined && stack.operation === undefined && stack.transition === undefined) return { label: 'No stack configured', state: 'unknown' };
  const operation = stack.operation ?? (stack.processes?.length === 1 ? stack.processes[0]?.operation : undefined);
  // operations take precedence over the settled running state
  if (operation !== undefined) return { label: stackOperationLabel(operation), state: 'working', color: stackProgressColor(operation) };
  // match the toolbar's colors during reported startup and migration
  if (stack.transition !== undefined) return stack.transition === 'starting'
    ? { label: 'Starting', state: 'working', color: 'green' }
    : { label: 'Migrating', state: 'working', color: 'peach' };
  const state = resolveStackStatus(stack, false);
  return { state, label: state === 'partial' && stack.processes !== undefined ? processesSummary(stack.processes) : stackStatusLabels[state] };
};

// observe all open workspaces without mounting terminals or claiming their sizes
export function Screensaver({ workspaces, request, onUnauthorized, onInactive }: { workspaces: ScreensaverWorkspace[]; request: Request; onUnauthorized: () => void; onInactive: () => void }) {
  const overlay = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [previews, setPreviews] = useState<Record<string, { revision: string; content: Preview }>>({});
  // preserve all sibling identities without keeping closed workspaces in the feed
  const agents = workspaces.flatMap(workspace => workspace.agents);
  const latestAgents = useRef(agents);
  latestAgents.current = agents;
  const refreshPreviews = useRef<(() => void) | undefined>(undefined);
  const signature = JSON.stringify(agents.map(agent => [agent.id, agent.revision]));

  // isolate the passive view while keeping every underlying split and draft mounted
  useLayoutEffect(() => {
    const node = overlay.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previous = new Map<HTMLElement, boolean>();
    // cover existing and newly portaled body siblings without losing their prior state
    const cover = () => {
      // the screensaver portal itself must remain accessible
      for (const child of Array.from(document.body.children)) {
        // record each sibling once
        if (!(child instanceof HTMLElement) || child === node || previous.has(child)) continue;
        previous.set(child, child.inert);
        child.inert = true;
      }
    };
    cover();
    const observer = new MutationObserver(cover);
    observer.observe(document.body, { childList: true });
    node?.focus({ preventScroll: true });
    // restore prior focus only after its exact interaction boundary is restored
    return () => {
      observer.disconnect();
      // restore even detached siblings that may later be reused
      for (const [child, inert] of previous) child.inert = inert;
      // do not focus a removed or still-covered control
      if (previousFocus?.isConnected && previousFocus.closest('[inert]') === null) restoreCoverFocus(() => { /* keep preview restoration passive */ previousFocus.focus({ preventScroll: true }); });
    };
  }, []);

  // poll only while the overview is mounted and the browser is visible
  useEffect(() => {
    let ended = false;
    const schedule = new Map<string, { revision: string; due: number; pending?: AbortController }>();
    const running = new Set<AbortController>();
    // reject retired identities at every asynchronous publication boundary
    const read = async (agent: ScreensaverAgent & { identity: string }, controller: AbortController) => {
      const current = () => !ended && !controller.signal.aborted && latestAgents.current.some(candidate => candidate.id === agent.id && candidate.revision === agent.revision);
      let preview: Preview = { kind: agent.liveOutput ? 'output' : 'response', text: '', available: false };
      try {
        // a hung capture must not indefinitely occupy a polling slot
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
        const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/screensaver?identity=${encodeURIComponent(agent.identity)}`, { signal });
        // share the dashboard's ownership transition only for current reads
        if (current() && (response.status === 401 || response.status === 423)) {
          ended = true;
          response.status === 401 ? onUnauthorized() : onInactive();
          return;
        }
        const payload: unknown = response.ok ? await response.json() : undefined;
        preview = parsePreview(payload, agent.identity) ?? preview;
      } catch { /* render unavailable instead of retaining stale content */ }
      // canceled or obsolete membership must never publish a late preview
      if (current()) setPreviews(previous => ({ ...previous, [agent.id]: { revision: agent.revision, content: preview } }));
    };
    // keep one budget and preserve unchanged cards' schedules across revisions
    const refresh = () => {
      // hidden or retired views have no polling work
      if (ended || document.visibilityState !== 'visible') return;
      const byId = new Map(latestAgents.current.map(agent => [agent.id, agent]));
      let removed = false;
      // abort only reads whose target changed or departed
      for (const [id, entry] of schedule) {
        // keep all state for unchanged targets
        if (byId.get(id)?.revision === entry.revision) continue;
        entry.pending?.abort();
        schedule.delete(id);
        removed = true;
      }
      // release cached rows for closed workspaces
      if (removed) setPreviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => byId.has(id))));
      // prioritize new and longest-waiting cards without delaying siblings on slow reads
      const now = Date.now();
      const due = [...byId.values()].filter(agent => agent.identity !== undefined && (schedule.get(agent.id)?.due ?? 0) <= now && schedule.get(agent.id)?.pending === undefined)
        .sort((left, right) => (schedule.get(left.id)?.due ?? 0) - (schedule.get(right.id)?.due ?? 0));
      // canceled requests keep their slots until their promises settle
      for (const agent of due.slice(0, 4 - running.size)) {
        const controller = new AbortController();
        const entry = { revision: agent.revision, due: now, pending: controller as AbortController | undefined };
        schedule.set(agent.id, entry);
        running.add(controller);
        void read({ ...agent, identity: agent.identity! }, controller).finally(() => {
          // update only this request's cadence, even if its card was retired
          entry.pending = undefined;
          entry.due = Date.now() + (agent.liveOutput ? 1_000 : 5_000);
          running.delete(controller);
        });
      }
    };
    refreshPreviews.current = refresh;
    const stop = pollWhileVisible(refresh, 1_000);
    // no overview-only captures survive closing the saver
    return () => {
      ended = true;
      stop();
      refreshPreviews.current = undefined;
      // cancel all reads from the retired overview
      for (const controller of running) controller.abort();
    };
  }, [request, onUnauthorized, onInactive]);

  // update changed cards promptly without restarting the poll owner
  useEffect(() => { refreshPreviews.current?.(); }, [signature]);

  // cycle overflow without asking the operator to scroll and dismiss the overview
  useEffect(() => {
    const timer = window.setInterval(() => {
      const node = grid.current;
      // static overviews need no automatic movement
      if (node === null || node.scrollHeight <= node.clientHeight) return;
      node.scrollTop = node.scrollTop + node.clientHeight >= node.scrollHeight - 1 ? 0 : Math.min(node.scrollTop + node.clientHeight * .85, node.scrollHeight - node.clientHeight);
    }, 10_000);
    // stop paging as soon as the passive surface closes
    return () => window.clearInterval(timer);
  }, []);

  return createPortal(<div ref={overlay} className="screensaver" role="dialog" aria-modal="true" aria-label="Screensaver" aria-describedby="screensaver-hint" tabIndex={-1}>
    {/* keep dismissal instructions available without taking up card space */}
    <p id="screensaver-hint" className="sr-only">Move the mouse, click or press any key to return</p>
    <div ref={grid} className="screensaver-grid">
      {/* retain navigation order and every open workspace */}
      {workspaces.map(workspace => {
        const { status } = workspace;
        const stack = stackSummary(workspace.stack);
        return <section key={workspace.id} className="screensaver-workspace" role="region" aria-label={`${workspace.label} workspace`}>
          <header>
            <div><h2>{workspace.label}</h2>{workspace.detail && <p title={workspace.detail}>{workspace.detail}</p>}</div>
            <div className="screensaver-workspace-statuses">
              <span className={`screensaver-workspace-state${status.color === undefined ? '' : ` progress-${status.color}`}`}>{status.label}</span>
              <span className={`screensaver-stack-status status-${stack.state}${stack.color === undefined ? '' : ` progress-${stack.color}`}`}><span>Stack: </span>{stack.label}</span>
            </div>
          </header>
          {/* keep individual process details without reserving a row for stacks with no processes */}
          {!!workspace.stack?.processes?.length && <div className="screensaver-processes">{workspace.stack.processes.map(process => <span key={process.name} className={`screensaver-process ${process.state}${process.operation === undefined ? '' : ` progress-${stackProgressColor(process.operation)}`}`} title={process.notices?.map(notice => notice.message).join('\n')}>{process.name}: {process.operation === undefined ? processStateText(process) : stackOperationLabel(process.operation)}</span>)}</div>}
          {/* empty places remain visible without inventing a terminal transcript */}
          {workspace.agents.length === 0 && <p className="screensaver-empty">No agent running</p>}
          {/* each sibling owns its status and content */}
          {workspace.agents.map(agent => {
            const entry = previews[agent.id];
            const preview = entry?.revision === agent.revision ? entry.content : undefined;
            const expectedKind = agent.liveOutput ? 'output' : 'response';
            const current = preview?.kind === expectedKind ? preview : undefined;
            const output = current?.kind === 'output' ? terminalOutputTail(current.text, current.colors) : undefined;
            return <article key={agent.id} className="screensaver-agent" aria-label={agent.label}>
              <header><h3>{agent.label}</h3><span className={`screensaver-state ${agent.tone}`}>{agent.state}</span></header>
              {/* settled responses retain their text but crop long previews from the beginning */}
              {current?.available ? output === undefined
                ? <div className="screensaver-response-window"><pre aria-label="Latest response">{current.text}</pre></div>
                : <div className="screensaver-output-window"><pre aria-label="Live output" className="screensaver-output"><ColoredTerminalOutput text={output.text} colors={output.colors} /></pre></div>
                : <p className="screensaver-empty">{current === undefined && agent.identity !== undefined ? 'Loading…' : agent.liveOutput ? 'Live output unavailable' : 'No response available'}</p>}
              {current?.truncated && <small className="screensaver-truncated">Response truncated</small>}
            </article>;
          })}
        </section>;
      })}
      {workspaces.length === 0 && <p className="screensaver-empty">No open workspaces</p>}
    </div>
  </div>, document.body);
}
