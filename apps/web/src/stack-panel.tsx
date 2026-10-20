import { useEffect, useRef, useState } from 'react';
import { closeOnMiddleClick } from './middle-click.js';
import { PanelHeader, PanelIcon, panelIcons, usePanelExpand, type PanelAction } from './panel-header.js';
import { actionGlyphs, ProcessNotices, RelationChips, StackIcon, stackGlyphs, stackProgressColor, StateDot, StateText, UsedFailure, useStackControls, WarningIcon, wholeStackActions, type ProcessAction, type ProjectStack, type StackControls, type StackHandlers } from './stack-controls.js';
import { dependantsOf, processActionLabel, processActions, processesSummary, processWarns, stackOperationLabel, usedProcessDown, usedProcesses, type StackAction, type StackProcessOutput, type StackProcessState, type StackSelection, type UsedProcess } from './stack-operations.js';

// how often the shown output is read again, as the log dialog read it
const outputRefreshMs = 750;

// A process's recent output, read from `worktreeId` and refreshed while it shows; undefined until
// the first read lands, and `error` when a read fails (the last output stays). `clear` empties the
// process's pane so its output starts fresh.
function useProcessOutput(target: { worktreeId: string; name: string } | undefined, read: (worktreeId: string, name: string) => Promise<StackProcessOutput | undefined>, clearOutput: (worktreeId: string, name: string) => Promise<void>) {
  const [output, setOutput] = useState<StackProcessOutput>();
  const [error, setError] = useState('');
  const readRef = useRef(read);
  readRef.current = read;
  // bumped by each clear, so a read begun before it cannot paint the cleared output back
  const clears = useRef(0);
  const worktreeId = target?.worktreeId;
  const name = target?.name;
  const clear = async () => {
    if (worktreeId === undefined || name === undefined) return;
    try {
      await clearOutput(worktreeId, name);
      clears.current += 1;
      setOutput(current => current?.name === name ? { ...current, output: '' } : current);
      setError('');
    } catch { setError('Unable to clear the output.'); }
  };
  useEffect(() => {
    setOutput(undefined);
    setError('');
    if (worktreeId === undefined || name === undefined) return;
    let active = true;
    let loading = false;
    const refresh = async () => {
      // avoid overlapping slow requests
      if (loading) return;
      loading = true;
      const generation = clears.current;
      try {
        const next = await readRef.current(worktreeId, name);
        if (!active || generation !== clears.current) return;
        setOutput(next);
        setError('');
      } catch {
        // retain prior output through transient failures
        if (active) setError('Unable to refresh the output.');
      } finally { loading = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, outputRefreshMs);
    return () => { active = false; window.clearInterval(interval); };
  }, [worktreeId, name]);
  return { output, error, clear };
}

// The output of the process shown, following new output from the bottom unless the operator
// scrolled up to read
function ProcessOutput({ text, error }: { text: string; error: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (ref.current !== null && follow.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return <>
    {error !== '' && <p className="stack-log-error" role="alert">{error}</p>}
    <pre ref={ref} className="stack-pane-output" tabIndex={0} aria-label="Process output" onScroll={event => { const output = event.currentTarget; follow.current = output.scrollHeight - output.scrollTop - output.clientHeight < 24; }}>{text}</pre>
  </>;
}

// Clear the shown output, emptying the process's pane so what follows starts fresh
function ClearOutput({ output, label }: { output: ReturnType<typeof useProcessOutput>; label: string }) {
  return <button type="button" className="stack-text-button" disabled={!output.output?.output} aria-label={`Clear ${label} output`} title="Clear the output; the process keeps running" onClick={() => void output.clear()}><StackIcon path={stackGlyphs.clear} />Clear</button>;
}

// what the output area says when there is no output to show
const outputText = (output: StackProcessOutput | undefined) => output === undefined ? 'Waiting for process output…' : output.output || (output.state === 'stopped' ? 'The process is not running.' : 'The process has not produced output yet.');

// The chips of the processes used elsewhere, each selecting that used process
function UseChips({ uses, onSelect }: { uses: UsedProcess[]; onSelect: (key: string) => void }) {
  if (uses.length === 0) return null;
  return <div className="stack-relation" role="group" aria-label="Uses"><span className="stack-relation-label">Uses</span><span className="stack-chips">{uses.map(entry => <button key={entry.key} type="button" className="stack-chip" title={`Show ${entry.use.process} in ${entry.use.label}`} onClick={() => onSelect(entry.key)}><StateDot state={entry.use.state} />{entry.use.process}</button>)}</span></div>;
}

// One of this Worktree's processes on the right: its state and actions, what it needs, what needs
// it and what it uses, and its live output, which "Open as Terminal" opens as a Terminal while it runs
function ProcessDetail({ process, processes, controls, output, onSelect, onOpenTerminal }: { process: StackProcessState; processes: StackProcessState[]; controls: StackControls; output: ReturnType<typeof useProcessOutput>; onSelect: (selection: StackSelection) => void; onOpenTerminal?: (paneId: string, name: string) => void }) {
  const inFlight = controls.inFlight(process.name);
  const paneId = output.output?.name === process.name ? output.output.paneId : undefined;
  return <div className="stack-pane-detail" role="group" aria-label={`${process.name} process`}>
    <div className="stack-pane-detail-head">
      <span className="stack-pane-detail-title"><StateDot state={process.state} busy={inFlight !== undefined} /><strong>{process.name}</strong><StateText process={process} inFlight={inFlight} /></span>
      <span className="stack-pane-buttons">{processActions.map(action => { /* mark only the action currently running */ const busy = inFlight === action; return <button key={action} type="button" className={`stack-text-button${busy ? ` progress-border progress-${stackProgressColor(action)}` : ''}`} aria-busy={busy || undefined} disabled={!controls.processAllowed(process, action)} aria-label={`${processActionLabel(action)} ${process.name}`} onClick={() => void controls.runProcess(process, action)}>{busy && <span className="update-progress-ring" aria-hidden="true" />}<StackIcon path={actionGlyphs[action]} />{processActionLabel(action)}</button>; })}</span>
    </div>
    <ProcessNotices name={process.name} notices={process.notices} />
    <div className="stack-pane-relations">
      <RelationChips label="Needs" names={process.dependsOn ?? []} processes={processes} onSelect={name => onSelect({ kind: 'process', name })} showEmpty />
      <RelationChips label="Needed by" names={dependantsOf(processes, process.name)} processes={processes} onSelect={name => onSelect({ kind: 'process', name })} showEmpty />
      <UseChips uses={usedProcesses([process])} onSelect={key => onSelect({ kind: 'use', key })} />
    </div>
    <div className="stack-pane-output-head"><span>Output</span><span className="stack-pane-buttons">{paneId !== undefined && onOpenTerminal !== undefined && <button type="button" className="stack-text-button" title={`Open ${process.name} as a Terminal panel`} onClick={() => onOpenTerminal(paneId, process.name)}><StackIcon path={stackGlyphs.terminal} />Open as Terminal</button>}<ClearOutput output={output} label={process.name} /></span></div>
    <ProcessOutput key={process.name} text={outputText(output.output)} error={output.error} />
  </div>;
}

// A process used in another Worktree on the right: where it runs, its Start, Stop and Open there,
// the processes here that use it, and its output, read from its own Worktree
function UseDetail({ used, processes, controls, output, onSelect, onOpenWorktree }: { used: UsedProcess; processes: StackProcessState[]; controls: StackControls; output: ReturnType<typeof useProcessOutput>; onSelect: (selection: StackSelection) => void; onOpenWorktree?: (worktreeId: string) => void }) {
  const { use } = used;
  const pending = controls.usedInFlight(used.key);
  const worktreeId = use.worktreeId;
  // keep the remote action glyph and label stable during progress
  const button = (action: ProcessAction, text: string) => {
    const busy = pending === action;
    return <button type="button" className={`stack-text-button${busy ? ` progress-border progress-${stackProgressColor(action)}` : ''}`} aria-busy={busy || undefined} disabled={!controls.usedAllowed(used, action)} aria-label={`${processActionLabel(action)} ${use.process} in ${use.label}`} onClick={() => void controls.runUsed(used, action)}>{busy && <span className="update-progress-ring" aria-hidden="true" />}<StackIcon path={actionGlyphs[action]} />{busy ? `${stackOperationLabel(action)}…` : text}</button>;
  };
  return <div className="stack-pane-detail" role="group" aria-label={`${use.process} in ${use.label}`}>
    <div className="stack-pane-detail-head">
      <span className="stack-pane-detail-title"><StateDot state={use.state} busy={pending !== undefined} /><strong>{use.process}</strong><StateText process={use} inFlight={pending} /></span>
      <span className="stack-pane-where">runs in {use.label}</span>
      {worktreeId !== undefined && <span className="stack-pane-buttons">
        {button('start', 'Start there')}
        {button('stop', 'Stop')}
        {onOpenWorktree !== undefined && <button type="button" className="stack-text-button" aria-label={`Open ${use.label}`} title={`Open ${use.label} and its stack controls`} onClick={() => onOpenWorktree(worktreeId)}><StackIcon path={stackGlyphs.open} />Open</button>}
      </span>}
      <UsedFailure controls={controls} used={used} />
    </div>
    <div className="stack-pane-relations"><RelationChips label="Used by" names={used.usedBy} processes={processes} onSelect={name => onSelect({ kind: 'process', name })} showEmpty /></div>
    <div className="stack-pane-output-head"><span>Output</span>{worktreeId !== undefined && <ClearOutput output={output} label={`${use.process} in ${use.label}`} />}</div>
    {worktreeId === undefined
      ? <p className="stack-pane-note">The console found no Worktree declaring this process, so its output is not available here.</p>
      : <ProcessOutput key={used.key} text={outputText(output.output)} error={output.error} />}
  </div>;
}

// The Stack panel: one Worktree's Stack processes and the processes they use in other Worktrees,
// listed on the left, and the selected one's actions, relations and live output on the right.
// `worktreeId` is that Worktree and `title` its "<Project> / <Worktree>". `selection` is what the panel shows, the first process when
// it names nothing there is. `readOutput` reads a process's output from any Worktree, and
// `clearOutput` empties it.
export function StackPanel({ worktreeId, title, stack, selection, onSelect, onClose, handlers, onOpenWorktree, onOpenTerminal, readOutput, clearOutput }: { worktreeId: string; title: string; stack: ProjectStack | undefined; selection: StackSelection | undefined; onSelect: (selection: StackSelection) => void; onClose: () => void; handlers: StackHandlers; onOpenWorktree?: (worktreeId: string) => void; onOpenTerminal?: (paneId: string, name: string) => void; readOutput: (worktreeId: string, name: string) => Promise<StackProcessOutput | undefined>; clearOutput: (worktreeId: string, name: string) => Promise<void> }) {
  const expanded = usePanelExpand('stack')?.expanded === true;
  const controls = useStackControls(stack, handlers);
  const processes = stack?.processes ?? [];
  const used = usedProcesses(processes);
  const selectedUse = selection?.kind === 'use' ? used.find(entry => entry.key === selection.key) : undefined;
  const selectedProcess = selectedUse !== undefined ? undefined : processes.find(process => selection?.kind === 'process' && process.name === selection.name) ?? processes[0];
  const target = selectedUse !== undefined
    ? selectedUse.use.worktreeId === undefined ? undefined : { worktreeId: selectedUse.use.worktreeId, name: selectedUse.use.process }
    : selectedProcess === undefined ? undefined : { worktreeId, name: selectedProcess.name };
  const output = useProcessOutput(target, readOutput, clearOutput);
  const summary = processesSummary(processes);
  const actions = stack?.actions ?? [];
  // the whole stack's actions, which fold into the header's ⋮ when the panel is narrow
  const stackActions: PanelAction[] = wholeStackActions.filter(action => actions.includes(action)).map(action => ({
    key: action,
    label: `${processActionLabel(action)} all`,
    title: controls.operation === action ? `${stackOperationLabel(action)}…` : `${processActionLabel(action)} all`,
    className: 'stack-pane-stack-action',
    disabled: !controls.allowed(action),
    ...(controls.operation === action ? { progress: stackProgressColor(action) } : {}),
    icon: <StackIcon path={actionGlyphs[action]} className="panel-header-icon" />,
    onSelect: () => void controls.run(action)
  }));
  // put process progress around the complete selectable row
  const item = (key: string, selected: boolean, onClick: () => void, dot: { state?: 'running'|'exited'|'stopped'; busy?: boolean; operation?: StackAction }, name: string, state: { state?: 'running'|'exited'|'stopped'; exitCode?: number }, warn: boolean, where?: string) =>
    <button key={key} type="button" className={`stack-pane-item${dot.operation === undefined ? '' : ` progress-border progress-${stackProgressColor(dot.operation)}`}`} aria-current={selected || undefined} aria-busy={dot.operation !== undefined || undefined} onClick={onClick}>
      {dot.operation !== undefined && <span className="update-progress-ring" aria-hidden="true" />}
      <StateDot state={dot.state} busy={dot.busy} /><span className="stack-pane-item-name">{name}</span>{warn && <WarningIcon className="stack-row-warning" />}<StateText process={state} warn={warn && where !== undefined} />
      {where !== undefined && <span className="stack-pane-item-where" title={where}>{where}</span>}
    </button>;
  return <section onAuxClickCapture={event => closeOnMiddleClick(event, onClose)} className={`stack-pane${expanded ? ' expanded' : ''}`} role="region" aria-label="Stack">
    <PanelHeader panelKey="stack" label="stack" title={<><span className="stack-pane-title" title={`Stack · ${title}`}>Stack · {title}</span><span className="stack-process-state">{summary}</span></>} secondary={stackActions} close={{ key: 'close', label: 'Close Stack panel', icon: <PanelIcon path={panelIcons.close} />, onSelect: onClose }} />
    <div className="stack-pane-body">
      <nav className="stack-pane-list" aria-label="Stack processes">
        {used.length > 0 && <div className="stack-pane-section">This worktree</div>}
        {processes.map(process => { /* carry the exact process operation to its row */ const operation = controls.inFlight(process.name) ?? process.operation; return item(`process:${process.name}`, process === selectedProcess, () => onSelect({ kind: 'process', name: process.name }), { state: process.state, busy: operation !== undefined, operation }, process.name, process, processWarns(process)); })}
        {used.length > 0 && <div className="stack-pane-section">Other worktrees</div>}
        {used.map(entry => { /* carry the remote process operation to its row */ const operation = controls.usedInFlight(entry.key); return item(`use:${entry.key}`, entry === selectedUse, () => onSelect({ kind: 'use', key: entry.key }), { state: entry.use.state, busy: operation !== undefined, operation }, entry.use.process, entry.use, usedProcessDown(entry, processes), entry.use.label); })}
      </nav>
      {selectedUse !== undefined
        ? <UseDetail used={selectedUse} processes={processes} controls={controls} output={output} onSelect={onSelect} onOpenWorktree={onOpenWorktree} />
        : selectedProcess !== undefined
          ? <ProcessDetail process={selectedProcess} processes={processes} controls={controls} output={output} onSelect={onSelect} onOpenTerminal={onOpenTerminal} />
          : <p className="stack-pane-note">This Worktree declares no Stack processes.</p>}
    </div>
  </section>;
}
