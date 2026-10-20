import { useState, type ReactNode } from 'react';
import { processActionLabel, processStateText, stackOperationLabel, type ProcessNotice, type StackAction, type StackProcessState, type UsedProcess } from './stack-operations.js';

// What the stack menu and the Stack panel both show of a Worktree's stack, as the dashboard serves it
export type ProjectStack = { actions?: StackAction[]; running?: boolean; operation?: StackAction; transition?: 'starting'|'migrating'; tunnel?: boolean; processes?: StackProcessState[] };
// A process's own actions, which the menu's icon buttons and the panel's buttons both offer
export type ProcessAction = 'start'|'stop'|'restart';
// The whole-stack actions the Stack panel's header offers, as the stack derives them from its processes
export const wholeStackActions: readonly ProcessAction[] = ['start', 'stop', 'restart'];

// run a stack action, holding its progress state at least 750 ms so a quick one never flickers
export const withMinimumProgress = async (work: () => Promise<unknown> | unknown) => {
  const startedAt = Date.now();
  try { await work(); }
  finally {
    const remaining = Math.max(0, 750 - (Date.now() - startedAt));
    if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining));
  }
};

// the stack controls' glyphs, drawn as strokes like the panel header's
export const stackGlyphs = {
  start: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  restart: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  output: 'M5 6h14v12H5zM8 10l2 2-2 2M12 14h4',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  chevron: 'M9 6l6 6-6 6',
  panel: 'M3 4h18v16H3zM14 4v16',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  clear: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M5.6 5.6l12.8 12.8'
} as const;
export const actionGlyphs: Record<ProcessAction, string> = { start: stackGlyphs.start, stop: stackGlyphs.stop, restart: stackGlyphs.restart };

// match each process transition to its shared progress color
export const stackProgressColor = (action: StackAction): 'green' | 'red' | 'yellow' | 'peach' => action === 'start' ? 'green' : action === 'stop' ? 'red' : action === 'restart' ? 'yellow' : 'peach';

export const StackIcon = ({ path, className = 'stack-icon' }: { path: string; className?: string }) => <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;

// the mark of a warning, on a Process notice, a process's row and the stack badge
export const WarningIcon = ({ className }: { className: string }) => <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20zM12 10v4M12 17h.01" /></svg>;

// a process's status dot: green running, red exited, grey stopped or unknown and peach while an
// action on it is under way
export const StateDot = ({ state, busy = false, title }: { state?: 'running'|'exited'|'stopped'; busy?: boolean; title?: string }) =>
  <i className={`stack-process-dot state-${state ?? 'unknown'}${busy ? ' busy' : ''}`} title={title} aria-hidden="true" />;

// a process's state in a word, or the action under way on its stable status
export const StateText = ({ process, inFlight, warn = false }: { process: { state?: 'running'|'exited'|'stopped'; exitCode?: number }; inFlight?: StackAction; warn?: boolean }) =>
  <span className={`stack-process-state${warn ? ' warn' : ''}${inFlight === undefined ? '' : ` progress-border progress-${stackProgressColor(inFlight)}`}`} aria-busy={inFlight !== undefined || undefined}>{inFlight !== undefined && <span className="update-progress-ring" aria-hidden="true" />}{inFlight === undefined ? processStateText(process) : `${stackOperationLabel(inFlight)}…`}</span>;

// a process's Process notices, each marked with its level and followed by its `controls`, or
// nothing when it has none
export function ProcessNotices({ name, notices, controls }: { name: string; notices: ProcessNotice[] | undefined; controls?: (notice: ProcessNotice) => ReactNode }) {
  if (notices === undefined || notices.length === 0) return null;
  return <ul className="stack-process-notices" aria-label={`${name} notices`}>{notices.map((notice, index) => <li key={index} className={`stack-process-notice level-${notice.level}`}>{notice.level === 'warning' ? <WarningIcon className="stack-process-notice-icon" /> : <svg className="stack-process-notice-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01" /></svg>}<span className="stack-process-notice-body">{notice.message}{controls?.(notice)}</span></li>)}</ul>;
}

// One relation's chips — what a process needs, or what needs it — each with its process's dot,
// selecting that process when clicked; "none" when `showEmpty` and there are none
export function RelationChips({ label, names, processes, onSelect, showEmpty = false }: { label: string; names: readonly string[]; processes: readonly StackProcessState[]; onSelect: (name: string) => void; showEmpty?: boolean }) {
  if (names.length === 0 && !showEmpty) return null;
  return <div className="stack-relation" role="group" aria-label={label}>
    <span className="stack-relation-label">{label}</span>
    {names.length === 0 ? <span className="stack-relation-none">none</span> : <span className="stack-chips">{names.map(name => {
      const process = processes.find(candidate => candidate.name === name);
      return <button key={name} type="button" className="stack-chip" title={`Show ${name}`} onClick={() => onSelect(name)}><StateDot state={process?.state} />{name}</button>;
    })}</span>}
  </div>;
}

// The actions a Worktree's stack controls send, and their progress here. The stack menu and the
// Stack panel each hold one, and both read the dashboard's `operation`s for what runs elsewhere.
export type StackHandlers = {
  onStackAction?: (action: StackAction) => Promise<unknown> | unknown;
  onProcessAction?: (name: string, action: StackAction) => Promise<unknown> | unknown;
  // a used process's Start or Stop, sent to its own Worktree, rejecting with why it failed
  onUseAction?: (worktreeId: string, process: string, action: ProcessAction) => Promise<unknown> | unknown;
};

export function useStackControls(stack: ProjectStack | undefined, { onStackAction, onProcessAction, onUseAction }: StackHandlers) {
  const [running, setRunning] = useState<StackAction>();
  // the one-process action sent from here, until its request returns
  const [runningProcess, setRunningProcess] = useState<{ name: string; action: StackAction }>();
  // the Start or Stop sent to a used process, by its key, until its request returns, and the last
  // one that failed, with why, until the next is sent
  const [usedActions, setUsedActions] = useState<ReadonlyMap<string, ProcessAction>>(() => new Map());
  const [usedFailures, setUsedFailures] = useState<ReadonlyMap<string, { action: ProcessAction; message: string }>>(() => new Map());
  const processes = stack?.processes ?? [];
  // a one-process action in flight, sent from here or (as the dashboard reports it) elsewhere
  const processOperation = runningProcess ?? processes.flatMap(process => process.operation === undefined ? [] : [{ name: process.name, action: process.operation }])[0];
  // a stack still Starting is already up, just not yet healthy, so it can be stopped or
  // restarted; only another Start, or anything during a migration, would overlap
  const allowed = (action: StackAction) => running === undefined && stack?.operation === undefined && processOperation === undefined && (stack?.transition === undefined || (stack.transition === 'starting' && (action === 'stop' || action === 'restart')));
  // One process's action waits only for any other action in flight, or a migration. Starting a
  // stopped process while the stack is still Starting overlaps nothing; a running one has nothing
  // to start, and a stopped one nothing to stop (an exited one's Stop clears its window).
  const processAllowed = (process: StackProcessState, action: StackAction) => onProcessAction !== undefined && running === undefined && stack?.operation === undefined && processOperation === undefined && stack?.transition !== 'migrating'
    && !(action === 'start' && process.state === 'running') && !(action === 'stop' && process.state === 'stopped');
  // the action in flight on one process here, if any
  const inFlight = (name: string) => processOperation?.name === name ? processOperation.action : undefined;
  // launch one stack action
  const run = async (action: StackAction) => {
    if (!allowed(action) || onStackAction === undefined) return;
    setRunning(action);
    try { await withMinimumProgress(() => onStackAction(action)); }
    finally { setRunning(undefined); }
  };
  // launch one process's action
  const runProcess = async (process: StackProcessState, action: StackAction) => {
    if (!processAllowed(process, action) || onProcessAction === undefined) return;
    setRunningProcess({ name: process.name, action });
    try { await withMinimumProgress(() => onProcessAction(process.name, action)); }
    finally { setRunningProcess(undefined); }
  };
  // a used process can be started when it is known not to run, and stopped when it runs, one
  // action at a time; one the console could not place has nothing to act on
  const usedAllowed = (used: UsedProcess, action: ProcessAction) => onUseAction !== undefined && used.use.worktreeId !== undefined && used.use.state !== undefined && !usedActions.has(used.key)
    && (action === 'start' ? used.use.state !== 'running' : action === 'stop' ? used.use.state === 'running' : false);
  // send a used process's action to its own Worktree, keeping why it failed (a busy stack there, say)
  const runUsed = async (used: UsedProcess, action: ProcessAction) => {
    const worktreeId = used.use.worktreeId;
    if (!usedAllowed(used, action) || worktreeId === undefined || onUseAction === undefined) return;
    const forget = <T,>(current: ReadonlyMap<string, T>) => { const next = new Map(current); next.delete(used.key); return next; };
    setUsedFailures(forget);
    setUsedActions(current => new Map(current).set(used.key, action));
    try { await withMinimumProgress(() => onUseAction(worktreeId, used.use.process, action)); }
    catch (error) { setUsedFailures(current => new Map(current).set(used.key, { action, message: error instanceof Error && error.message !== '' ? error.message : `Unable to ${action} ${used.use.process}.` })); }
    finally { setUsedActions(forget); }
  };
  return { running, operation: running ?? stack?.operation, processOperation, allowed, processAllowed, inFlight, run, runProcess, usedAllowed, runUsed, usedInFlight: (key: string) => usedActions.get(key), usedFailure: (key: string) => usedFailures.get(key) };
}
export type StackControls = ReturnType<typeof useStackControls>;

// why a used process's last Start or Stop failed, until the next is sent
export function UsedFailure({ controls, used }: { controls: StackControls; used: UsedProcess }) {
  const failure = controls.usedFailure(used.key);
  return failure === undefined ? null : <span className="stack-use-error" role="alert">{processActionLabel(failure.action)} failed: {failure.message}</span>;
}
