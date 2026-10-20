import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FlyoutPortal } from './flyout-portal.js';
import { PanelIcon, panelIcons } from './panel-header.js';
import { actionGlyphs, ProcessNotices, RelationChips, StackIcon, stackGlyphs, stackProgressColor, StateDot, StateText, UsedFailure, useStackControls, WarningIcon, withMinimumProgress, type ProcessAction, type ProjectStack, type StackControls } from './stack-controls.js';
import { dependantsOf, processActionLabel, processActions, processesSummary, processWarns, stackActionLabel, stackOperationLabel, usedProcessDown, usedProcesses, type ProcessNotice, type ProcessNoticeTarget, type StackAction, type StackProcessState, type StackSelection, type StartableNoticeTarget, type StackOperationLog, type UsedProcess } from './stack-operations.js';
import { useViewportFlyout } from './viewport-flyout.js';

type ProjectStackStatus = 'working'|'exited'|'partial'|'healthy'|'down'|'running'|'stopped'|'unknown';

// A notice's Start of the process it names in another Worktree, by `noticeStartKey`: `pending`
// while its request is out, then sent and waiting for the next state to hide the notice, or failed
// with `error`. `id` tells one Start's completion and settle timer from a later Start's.
type NoticeStart = { id: number; pending: boolean; error?: string };
const noticeStartKey = (target: ProcessNoticeTarget) => `${target.worktreeId}\u0000${target.process ?? ''}`;
// how long a sent Start shows "Starting…" when no state hides its notice, before offering Start again
const noticeStartSettleMs = 15_000;

// how many of a stack's Stack processes are running
const runningCount = (processes: StackProcessState[]) => processes.filter(process => process.state === 'running').length;

// derive the stack status badge
function resolveStackStatus(stack: ProjectStack | undefined, inProgress: boolean): ProjectStackStatus {
  // prioritize active operations
  if (inProgress) return 'working';
  // a Stack process that died on its own, a stack only partly running, or one stopped outranks
  // whatever its tunnel says: a check from before a Stop can still read healthy, and a failing
  // one would read as broken
  if (stack?.processes !== undefined) {
    if (stack.processes.some(process => process.state === 'exited')) return 'exited';
    const live = runningCount(stack.processes);
    if (live === 0) return 'stopped';
    if (live < stack.processes.length) return 'partial';
  }
  // reflect a healthy tunnel
  if (stack?.tunnel === true) return 'healthy';
  // reflect a failed tunnel
  if (stack?.tunnel === false) return 'down';
  // reflect a running stack
  if (stack?.running === true) return 'running';
  // reflect a stopped stack
  if (stack?.running === false) return 'stopped';
  return 'unknown';
}

// A process's Start, Stop and Restart as icon buttons, each disabled while it would do nothing or
// another action runs
function ProcessIconActions({ process, controls }: { process: StackProcessState; controls: StackControls }) {
  const titles: Record<ProcessAction, string> = { start: 'Start (and what it needs)', stop: 'Stop', restart: 'Restart' };
  const inFlight = controls.inFlight(process.name);
  return <span className="stack-icon-actions">{processActions.map(action => { /* retain the action glyph during its transition */ const busy = inFlight === action; return <button key={action} type="button" className={`stack-icon-button${busy ? ` progress-border progress-${stackProgressColor(action)}` : ''}`} aria-busy={busy || undefined} disabled={!controls.processAllowed(process, action)} aria-label={`${processActionLabel(action)} ${process.name}`} title={titles[action]} onClick={() => void controls.runProcess(process, action)}>{busy && <span className="update-progress-ring" aria-hidden="true" />}<StackIcon path={actionGlyphs[action]} /></button>; })}</span>;
}

// One process used in another Worktree, as the stack menu lists it: its dot and name, where it runs,
// its state, which processes here use it (`showUsedBy`), and Start or Stop (only Start unless
// `stoppable`) and Open
export function UsedProcessLine({ used, controls, onOpenWorktree, showState = false, showUsedBy = false, stoppable = false }: { used: UsedProcess; controls: StackControls; onOpenWorktree?: (worktreeId: string) => void; showState?: boolean; showUsedBy?: boolean; stoppable?: boolean }) {
  const { use } = used;
  const pending = controls.usedInFlight(used.key);
  const action: ProcessAction | undefined = use.state === undefined || use.worktreeId === undefined ? undefined : use.state === 'running' ? (stoppable ? 'stop' : undefined) : 'start';
  const worktreeId = use.worktreeId;
  return <div className="stack-use" role="group" aria-label={`${use.process} in ${use.label}`}>
    <span className="stack-use-head"><StateDot state={use.state} busy={pending !== undefined} /><span className="stack-use-name">{use.process}</span><span className="stack-use-where" title={use.label}>{use.label}</span>{showState && <StateText process={use} inFlight={pending} />}</span>
    {(showUsedBy || action !== undefined || worktreeId !== undefined) && <span className="stack-use-foot">
      {showUsedBy && <span className="stack-use-users">used by {used.usedBy.join(', ')}</span>}
      <span className="stack-use-actions">
        {action !== undefined && <button type="button" className={`stack-mini-button${pending === action ? ` progress-border progress-${stackProgressColor(action)}` : ''}`} aria-busy={pending === action || undefined} disabled={!controls.usedAllowed(used, action)} aria-label={`${processActionLabel(action)} ${use.process} in ${use.label}`} title={`${processActionLabel(action)} ${use.process} in ${use.label}`} onClick={() => void controls.runUsed(used, action)}>{pending === action && <span className="update-progress-ring" aria-hidden="true" />}{pending === action ? `${stackOperationLabel(action)}…` : processActionLabel(action)}</button>}
        {worktreeId !== undefined && onOpenWorktree !== undefined && <button type="button" className="stack-mini-button" aria-label={`Open ${use.label}`} title={`Open ${use.label} and its stack controls`} onClick={() => onOpenWorktree(worktreeId)}>Open</button>}
      </span>
    </span>}
    <UsedFailure controls={controls} used={used} />
  </div>;
}

// The project's toolbar controls: the stack button and its menu (which also opens the project in
// a new tab or the browser panel) or, with no stack commands, a link to the project.
// The menu lists the Stack processes as rows that expand one at a time, with each one's actions,
// what it needs and what needs it here, and what it uses in other Worktrees; those other
// Worktrees' processes also gather in a row of their own. `title` names this Worktree.
// `onProcessAction` starts, stops or restarts one process, and `onUseAction` a used process in its
// own Worktree. `onOpenStackPanel` opens the Stack panel on what it should show.
// `onOpenWorktree` switches to another Worktree with its stack menu open, for a notice's Open and a
// used process's; `onStartNoticeTarget` starts a notice's process there (rejecting with the reason
// it failed) while this menu stays open. `worktreeId` is this stack's own Worktree, which a notice
// has no need to Open. `menuRequested` opens the menu once, as an Open asks of the Worktree it
// switches to.
export function ProjectOpen({ url, title, stack, worktreeId, browserOpen = false, onBrowserToggle, onStackAction, onStackLog, onProcessAction, onUseAction, onOpenStackPanel, onOpenWorktree, onStartNoticeTarget, menuRequested = false }: { worktreeId?: string; url?: string; title?: string; stack?: ProjectStack; browserOpen?: boolean; onBrowserToggle?: () => void; onStackAction?: (action: StackAction) => Promise<unknown> | unknown; onStackLog?: () => Promise<StackOperationLog | undefined>; onProcessAction?: (name: string, action: StackAction) => Promise<unknown> | unknown; onUseAction?: (worktreeId: string, process: string, action: ProcessAction) => Promise<unknown> | unknown; onOpenStackPanel?: (selection: StackSelection) => void; onOpenWorktree?: (worktreeId: string) => void; onStartNoticeTarget?: (target: StartableNoticeTarget) => Promise<unknown>; menuRequested?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // whether `menuRequested` has had its one opening
  const menuRequestHandled = useRef(false);
  // the process row expanded, one at a time, and whether the other Worktrees' row is
  const [expanded, setExpanded] = useState<string>();
  const [othersOpen, setOthersOpen] = useState(false);
  // the Starts sent from notices, by target, and the source of their ids
  const [noticeStarts, setNoticeStarts] = useState<ReadonlyMap<string, NoticeStart>>(() => new Map());
  const noticeStartIds = useRef(0);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<StackOperationLog>();
  const [logError, setLogError] = useState('');
  const logOutputRef = useRef<HTMLPreElement | null>(null);
  // whether the viewer sits at the bottom of its output, where new output keeps it
  const followOutputRef = useRef(true);
  const stackLogRef = useRef(onStackLog);
  stackLogRef.current = onStackLog;
  const controls = useStackControls(stack, { onStackAction, onProcessAction, onUseAction });
  const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const actions = stack?.actions ?? [];
  const hasStackActions = actions.length > 0 && onStackAction !== undefined;
  // a Stack process's own actions leave no command output; only one-shot actions do
  const hasStackLogs = actions.some(action => stack?.processes === undefined || !(processActions as readonly StackAction[]).includes(action)) && onStackLog !== undefined;
  const processes = stack?.processes ?? [];
  // a lone process is the whole stack: its row stays expanded, with no relations of its own here
  const lone = processes.length === 1;
  const used = usedProcesses(processes);
  const down = used.filter(entry => usedProcessDown(entry, processes));
  // require only a usable target and handler
  const hasBrowserControl = url !== undefined && onBrowserToggle !== undefined;
  useEffect(() => {
    // open the menu once when asked to, if there is a menu to open
    if (!menuRequested || !hasStackActions || menuRequestHandled.current) return;
    menuRequestHandled.current = true;
    setMenuOpen(true);
  }, [menuRequested, hasStackActions]);
  // the start keys of the targets the showing notices name, joined into one comparable string
  const shownTargetKeys = processes.flatMap(process => process.notices ?? []).flatMap(notice => notice.target === undefined ? [] : [noticeStartKey(notice.target)]).join('\u0001');
  const shownTargetKeysRef = useRef(shownTargetKeys);
  shownTargetKeysRef.current = shownTargetKeys;
  useEffect(() => {
    // forget a finished Start once no notice names its target: the process runs, so the notice
    // hid; one still waiting on its request stays, so its target cannot be started twice
    const shown = new Set(shownTargetKeys.split('\u0001'));
    const kept = ([key, start]: [string, NoticeStart]) => start.pending || shown.has(key);
    setNoticeStarts(current => [...current].every(kept) ? current : new Map([...current].filter(kept)));
  }, [shownTargetKeys]);
  useEffect(() => {
    // poll only while the log viewer is open
    if (!logOpen) return;
    let active = true;
    let loading = false;
    // refresh the retained command output
    const refresh = async () => {
      // avoid overlapping slow requests
      if (loading) return;
      loading = true;
      try {
        const next = await stackLogRef.current?.();
        // ignore responses after closing
        if (!active) return;
        setLog(next);
        setLogError('');
      } catch {
        // retain prior output through transient failures
        if (active) setLogError('Unable to refresh stack output.');
      } finally { loading = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 750);
    return () => { active = false; window.clearInterval(interval); };
  }, [logOpen]);
  useEffect(() => {
    // follow new output while the viewer is open, unless the operator scrolled up to read
    if (!logOpen || logOutputRef.current === null || !followOutputRef.current) return;
    logOutputRef.current.scrollTop = logOutputRef.current.scrollHeight;
  }, [log?.output, logOpen]);
  useEffect(() => {
    // close the viewer with Escape
    if (!logOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setLogOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [logOpen]);
  // open the latest retained output
  const openLogs = () => { setLogError(''); followOutputRef.current = true; setMenuOpen(false); setLogOpen(true); };
  // open the Stack panel on `selection`, closing the menu
  const openPanel = (selection: StackSelection) => { setMenuOpen(false); onOpenStackPanel?.(selection); };
  // start a notice's process in its own Worktree, leaving this menu open: the notice shows
  // "Starting…" until the next state hides it, or the error when the Start fails
  const startNoticeTarget = async (target: StartableNoticeTarget) => {
    const key = noticeStartKey(target);
    if (onStartNoticeTarget === undefined || (noticeStarts.has(key) && noticeStarts.get(key)?.error === undefined)) return;
    const id = ++noticeStartIds.current;
    // a completion only updates the Start it belongs to, never a later one
    const settle = (next?: NoticeStart) => setNoticeStarts(current => {
      if (current.get(key)?.id !== id) return current;
      const updated = new Map(current);
      if (next === undefined) updated.delete(key); else updated.set(key, next);
      return updated;
    });
    setNoticeStarts(current => new Map(current).set(key, { id, pending: true }));
    try {
      await withMinimumProgress(() => onStartNoticeTarget(target));
      // a notice already hidden is done with; one still showing waits for the next state
      if (!shownTargetKeysRef.current.split('\u0001').includes(key)) return settle();
      settle({ id, pending: false });
      window.setTimeout(() => settle(), noticeStartSettleMs);
    } catch (error) {
      settle({ id, pending: false, error: error instanceof Error && error.message !== '' ? error.message : `Unable to start ${target.process}.` });
    }
  };
  // a notice's Open and Start, or "Starting…" in their place while its Start is under way
  const noticeControls = (notice: ProcessNotice) => {
    const target = notice.target;
    if (target === undefined) return null;
    // only a declared process has a state, and a notice about a running one does not show
    const process = onStartNoticeTarget === undefined || target.state === undefined ? undefined : target.process;
    // this stack's own Worktree is already open
    const openable = onOpenWorktree !== undefined && target.worktreeId !== worktreeId;
    if (!openable && process === undefined) return null;
    const start = process === undefined ? undefined : noticeStarts.get(noticeStartKey(target));
    return <span className="stack-process-notice-actions">
      {process !== undefined && start !== undefined && start.error === undefined
        ? <span className="stack-process-notice-progress progress-border progress-green" role="status" aria-busy="true"><span className="update-progress-ring" aria-hidden="true" /><span>Starting <code>{process}</code>…</span></span>
        : <>
          {openable && <button type="button" title={`Open ${target.label} and its stack controls`} onClick={() => onOpenWorktree?.(target.worktreeId)}>Open {target.label}</button>}
          {process !== undefined && <button type="button" aria-label={`Start ${process} in ${target.label}`} title={`Start ${process} in ${target.label}`} onClick={() => void startNoticeTarget({ ...target, process })}>Start {process}</button>}
        </>}
      {start?.error !== undefined && <span className="stack-process-notice-error" role="alert">Start failed: {start.error}</span>}
    </span>;
  };
  // launch one stack action, closing the menu once it is sent
  const run = async (action: StackAction) => {
    if (!controls.allowed(action)) return;
    try { await controls.run(action); }
    finally { setMenuOpen(false); }
  };
  // omit the control only when there is neither a project target nor stack actions
  if (url === undefined && !hasStackActions) return null;
  // a single process's action (from MCP) shows as the stack's, since its row is the whole stack
  const operation = controls.operation ?? (lone ? controls.processOperation?.action : undefined);
  const status = stack?.transition ?? (stack?.tunnel === true ? 'healthy' : stack?.tunnel === false ? 'down' : 'starting');
  const busy = operation !== undefined;
  const transitionLabel = stack?.transition === 'starting' ? 'Starting' : stack?.transition === 'migrating' ? 'Migrating' : undefined;
  const inProgress = busy || transitionLabel !== undefined;
  // describe the server badge state
  const stackStatus = resolveStackStatus(stack, inProgress);
  // a partial stack counts its running processes on the badge
  const stackStatusText = stackStatus === 'partial' ? `${runningCount(processes)} of ${processes.length} running` : stackStatus;
  // name each exited process and its code for the tooltip and screen readers
  const exited = processes.filter(process => process.state === 'exited');
  const stackDescription = stackStatus === 'exited' && exited.length > 0 ? exited.map(process => `${process.name} exited${process.exitCode === undefined ? '' : ` (${process.exitCode})`}`).join(', ') : stackStatusText;
  // a warning notice, or a used process that is down, marks the badge on top of whatever state it
  // shows, and its tooltip lists them
  const warnings = [
    ...processes.flatMap(process => (process.notices ?? []).filter(notice => notice.level === 'warning').map(notice => notice.message)),
    ...down.map(entry => `${entry.use.process} in ${entry.use.label} is not running`)
  ];
  const stackLabel = warnings.length === 0 ? stackDescription : `${stackDescription}, warning: ${warnings.join('; ')}`;
  const stackTitle = `Stack controls · ${stackDescription}${warnings.map(message => `\n⚠ ${message}`).join('')}`;
  const label = operation !== undefined ? `${stackOperationLabel(operation)}…` : transitionLabel !== undefined ? `${transitionLabel}…` : 'Open';
  const linkTitle = operation !== undefined ? `${stackOperationLabel(operation)} stack` : transitionLabel !== undefined ? `${transitionLabel} stack` : `Project is ${status}`;
  const logView = { name: 'Stack output', title: log === undefined ? 'Stack output' : log.active ? `${stackOperationLabel(log.action)} stack` : `${stackActionLabel(log.action)} output`, busy: log?.active === true, text: log?.output || (log === undefined ? 'Waiting for command output…' : 'The command has not produced output yet.'), status: log === undefined ? 'Waiting for command output…' : log.active ? `${stackOperationLabel(log.action)}…` : `Finished ${new Date(log.completedAt ?? log.startedAt).toLocaleTimeString()}` };
  // one row per process, expanding to its notices, actions, relations and uses
  const processRows = processes.map(process => {
    const open = lone || expanded === process.name;
    const inFlight = controls.inFlight(process.name);
    const needs = process.dependsOn ?? [];
    const neededBy = dependantsOf(processes, process.name);
    const uses = usedProcesses([process]);
    const warns = processWarns(process);
    const head = <><StateDot state={process.state} busy={inFlight !== undefined} /><span className="stack-row-name">{process.name}</span>{warns && <WarningIcon className="stack-row-warning" />}<StateText process={process} inFlight={inFlight} />{!lone && <StackIcon path={stackGlyphs.chevron} className="stack-icon stack-row-chevron" />}</>;
    return <div key={process.name} className={`stack-process${open ? ' expanded' : ''}`} role="group" aria-label={`${process.name} process`} aria-busy={inFlight !== undefined || undefined}>
      {lone ? <div className="stack-row">{head}</div> : <button type="button" className="stack-row" aria-expanded={open} onClick={() => setExpanded(current => current === process.name ? undefined : process.name)}>{head}</button>}
      {open && <div className="stack-row-body">
        <ProcessNotices name={process.name} notices={process.notices} controls={noticeControls} />
        <div className="stack-row-output">
          {onOpenStackPanel !== undefined && <button type="button" className="stack-output-link" aria-label={`Show ${process.name} output`} onClick={() => openPanel({ kind: 'process', name: process.name })}><StackIcon path={stackGlyphs.output} />Show output</button>}
          {onProcessAction !== undefined && <ProcessIconActions process={process} controls={controls} />}
        </div>
        {!lone && <RelationChips label="Needs" names={needs} processes={processes} onSelect={setExpanded} />}
        {!lone && <RelationChips label="Needed by" names={neededBy} processes={processes} onSelect={setExpanded} />}
        {uses.length > 0 && <div className="stack-relation stack-relation-uses" role="group" aria-label="Uses"><span className="stack-relation-label">Uses</span><span className="stack-uses">{uses.map(entry => <UsedProcessLine key={entry.key} used={entry} controls={controls} onOpenWorktree={onOpenWorktree} />)}</span></div>}
      </div>}
    </div>;
  });
  // the processes this Worktree uses elsewhere, gathered in one row
  const othersRow = used.length === 0 ? null : <div className={`stack-process stack-others${othersOpen ? ' expanded' : ''}`} role="group" aria-label="Other worktrees">
    <button type="button" className="stack-row" aria-expanded={othersOpen} onClick={() => setOthersOpen(open => !open)}>
      <span className="stack-row-name">Other worktrees</span>
      <span className="stack-others-dots">{used.map(entry => <StateDot key={entry.key} state={entry.use.state} title={`${entry.use.process}: ${entry.use.state ?? 'unknown'}`} />)}</span>
      <span className={`stack-process-state${down.length > 0 ? ' warn' : ''}`}>{down.length > 0 ? `${down.length} down` : used.length}</span>
      <StackIcon path={stackGlyphs.chevron} className="stack-icon stack-row-chevron" />
    </button>
    {othersOpen && <div className="stack-row-body">{used.map(entry => <UsedProcessLine key={entry.key} used={entry} controls={controls} onOpenWorktree={onOpenWorktree} showState showUsedBy stoppable />)}</div>}
  </div>;
  const splitTitle = browserOpen ? 'Close split view' : 'Open split view';
  const logDialog = logOpen && createPortal(<section className="dialog stack-log-dialog" role="dialog" aria-modal="true" aria-label={logView.name}><div><header className={logView.busy ? 'progress-border progress-peach' : undefined} aria-busy={logView.busy || undefined}>{logView.busy && <span className="update-progress-ring" aria-hidden="true" />}<strong>{logView.title}</strong><button type="button" aria-label="Close stack output" title="Close" onClick={() => setLogOpen(false)}><PanelIcon path={panelIcons.close} /></button></header>{logError && <p className="stack-log-error" role="alert">{logError}</p>}<pre ref={logOutputRef} tabIndex={0} autoFocus onScroll={event => { const output = event.currentTarget; followOutputRef.current = output.scrollHeight - output.scrollTop - output.clientHeight < 24; }}>{logView.text}</pre><footer aria-live="polite">{logView.status}</footer></div></section>, document.body);
  const externalControl = url === undefined ? null : <a className="project-menu-external" href={url} target="_blank" rel="noreferrer" title={linkTitle} onClick={() => {
    // close after external navigation
    setMenuOpen(false);
  }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></svg><span>Open</span></a>;
  const splitControl = !hasBrowserControl ? null : <button className="project-menu-split" type="button" aria-pressed={browserOpen} title={splitTitle} onClick={() => {
    // toggle the embedded project view
    onBrowserToggle?.();
    setMenuOpen(false);
  }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16" /></svg><span>{browserOpen ? 'Close' : 'Split'}</span></button>;
  const heading: ReactNode = title === undefined && processes.length === 0 ? null : <div className="stack-menu-heading">{title !== undefined && <span className="stack-menu-title" title={title}>{title}</span>}<span className="stack-process-state">{processes.length > 0 ? processesSummary(processes) : stackStatusText}</span></div>;
  const hasFooter = (processes.length > 0 && onOpenStackPanel !== undefined) || hasStackLogs;
  return <>
    <span className={`project-open-group${url === undefined ? ' stack-only' : ''}${hasStackActions ? ' has-stack-actions' : ''}`} ref={anchorRef} role="group" aria-label={url === undefined ? 'Stack controls' : 'Project controls'}>
      {hasStackActions ? <button className={`project-stack-toggle project-stack-trigger toolbar-button${inProgress ? ` progress-border progress-${operation === undefined ? transitionLabel === 'Migrating' ? 'peach' : 'green' : stackProgressColor(operation)}` : ''}`} type="button" aria-label={`Stack controls: ${stackLabel}`} aria-busy={inProgress || undefined} data-context-flyout aria-expanded={menuOpen} title={stackTitle} onClick={() => setMenuOpen(open => !open)}>{inProgress && <span className="update-progress-ring" aria-hidden="true" />}<span className="flyout-caret" aria-hidden="true" /><svg className="project-stack-server-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></svg><span className="toolbar-label">Stack</span><span className="project-stack-status-text">{stackStatusText}</span><i className={`project-stack-status-dot status-${stackStatus}`} aria-hidden="true" />{warnings.length > 0 && <WarningIcon className="project-stack-warning" />}</button> : url !== undefined && <a className={`project-open status-${status}${inProgress ? ` busy progress-border progress-${transitionLabel === 'Migrating' ? 'peach' : 'green'}` : ''}`} href={url} target="_blank" rel="noreferrer" aria-busy={inProgress || undefined} title={linkTitle}>{inProgress && <span className="update-progress-ring" aria-hidden="true" />}<i aria-hidden="true" />{label}</a>}
    </span>
    {menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div className={`stack-menu more-menu flyout-menu${processes.length > 0 ? ' has-processes' : ''}`} ref={flyoutRef} style={style}>
      {heading}
      {actions.map(action => { /* mark only the submitted stack action */ const actionBusy = operation === action; return <button key={action} className={actionBusy ? `progress-border progress-${stackProgressColor(action)}` : undefined} aria-busy={actionBusy || undefined} disabled={!controls.allowed(action)} onClick={() => void run(action)}>{actionBusy && <span className="update-progress-ring" aria-hidden="true" />}{actionBusy ? `${stackOperationLabel(action)}…` : stackActionLabel(action)}</button>; })}
      {processes.length > 0 && <><hr className="more-menu-divider" />{processRows}</>}
      {othersRow !== null && <><hr className="more-menu-divider" />{othersRow}</>}
      {hasFooter && <hr className="more-menu-divider" />}
      {processes.length > 0 && onOpenStackPanel !== undefined && <button className="stack-log-menu-button" type="button" onClick={() => openPanel({ kind: 'process', name: processes[0]!.name })}><StackIcon path={stackGlyphs.panel} className="more-menu-icon" />Open Stack panel</button>}
      {hasStackLogs && <button className="stack-log-menu-button" type="button" onClick={openLogs}><StackIcon path={stackGlyphs.output} className="more-menu-icon" />Show last command output</button>}
      {url !== undefined && <span className="project-stack-view-actions" role="group" aria-label="Project view controls">{externalControl}{splitControl}</span>}
    </div></FlyoutPortal>}
    {logDialog}
  </>;
}
