import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isResourceSnapshot, type ResourceSnapshot } from '../../server/src/server-admin/resource-contracts.js';
import { restoreCoverFocus } from './fullscreen-loader.js';
import { agentKindLabel, agentKinds, LaunchTabBadge, type AgentKind } from './launch-profile.js';
import { ServerResources } from './server-resources.js';
import { SplitConfirmation } from './split-confirmation.js';
import './tmux-recovery.css';

type RecoveryAgent = { id: string; kind: string; label: string; pid: number; recoveryProcessKey?: string };
type LastKnownAgent = { id: string; kind?: AgentKind; title: string; workspaceName?: string; recoveryProcessKey?: string };
type RecoveryRow = RecoveryAgent & { known?: LastKnownAgent };
type Snapshot = { available: boolean; canStop: boolean; agents: RecoveryAgent[]; resources: ResourceSnapshot; reason?: string };
type StopStatus = 'signal_sent' | 'stale' | 'not_found' | 'rejected' | 'failed';
type StopResult = { id: string; status: StopStatus };
type Request = (url: string, init?: RequestInit) => Promise<Response>;

const refreshMs = 5_000;
const selectionLimit = 20;
const stopLabels: Record<StopStatus, string> = {
  signal_sent: 'Stop signal sent', stale: 'Process changed; not stopped', not_found: 'Process no longer available', rejected: 'Not eligible to stop', failed: 'Stop not confirmed'
};

// accept just the process fields used by recovery controls
const isAgent = (value: unknown): value is RecoveryAgent => {
  const agent = value as Partial<RecoveryAgent> | null;
  return agent !== null && typeof agent === 'object' && typeof agent.id === 'string' && typeof agent.kind === 'string'
    && typeof agent.label === 'string' && Number.isSafeInteger(agent.pid) && agent.pid! > 0
    && (agent.recoveryProcessKey === undefined || typeof agent.recoveryProcessKey === 'string');
};

// validate server output before exposing destructive selection controls
const isSnapshot = (value: unknown): value is Snapshot => {
  const data = value as Partial<Snapshot> | null;
  return data !== null && typeof data === 'object' && typeof data.available === 'boolean' && typeof data.canStop === 'boolean'
    && Array.isArray(data.agents) && data.agents.every(isAgent) && isResourceSnapshot(data.resources)
    && (data.reason === undefined || typeof data.reason === 'string');
};

// recognize only explicit outcomes for the exact set the operator confirmed
const stopResults = (value: unknown, selected: RecoveryAgent[]): StopResult[] => {
  const results = (value as { results?: unknown } | null)?.results;
  const remaining = new Set(selected.map(agent => agent.id));
  // reject missing, duplicate or foreign identities
  if (!Array.isArray(results) || results.length !== remaining.size) throw new Error('Unconfirmed stop result');
  // validate each status before making it visible
  for (const result of results) {
    if (result === null || typeof result !== 'object' || typeof result.id !== 'string' || !remaining.delete(result.id)
      || typeof result.status !== 'string' || !Object.hasOwn(stopLabels, result.status)) throw new Error('Unconfirmed stop result');
  }
  return results;
};

// never attach a dashboard title to a different or ambiguous process
const recoveryRows = (agents: readonly RecoveryAgent[], lastKnown: readonly LastKnownAgent[]) => {
  const byProcess = new Map<string, LastKnownAgent | undefined>();
  // leave every ambiguous dashboard entry read-only
  for (const agent of lastKnown) {
    const key = agent.recoveryProcessKey;
    // only exact process correlation keys can match
    if (key) byProcess.set(key, byProcess.has(key) ? undefined : agent);
  }
  const matched = new Set<string>();
  const live: RecoveryRow[] = agents.map(agent => {
    const known = agent.recoveryProcessKey === undefined ? undefined : byProcess.get(agent.recoveryProcessKey);
    // display a matched dashboard identity on its live row only
    if (known === undefined) return agent;
    matched.add(known.id);
    return { ...agent, known };
  });
  return { live, unverified: lastKnown.filter(agent => { /* keep unmatched metadata visible without a selector */ return !matched.has(agent.id); }) };
};

// identify the provider without changing the wire format or stop identity
const recoveryKind = (kind: string): AgentKind | undefined => {
  const normalized = kind.toLowerCase();
  return agentKinds.find(candidate => { /* admit only kinds with a shared badge */ return candidate === normalized; });
};

// remove only the collector's provider prefix when the badge already represents it
const recoveryLocation = (label: string, kind: AgentKind | undefined): string => {
  const prefix = kind === undefined ? undefined : `${agentKindLabel[kind]} · `;
  return prefix !== undefined && label.startsWith(prefix) ? label.slice(prefix.length) || label : label;
};

// keep the workspace name in the identification shown before a stop
const knownCaption = ({ title, workspaceName }: LastKnownAgent) => workspaceName && workspaceName !== title ? `${workspaceName} · ${title}` : title;

// reuse the dashboard glyph and keep the provider available to assistive technology
function RecoveryAgentBadge({ kind }: { kind?: AgentKind }) {
  return kind === undefined ? null : <span className="tmux-recovery-agent-badge" role="img" aria-label={agentKindLabel[kind]}><LaunchTabBadge kind={kind} /></span>;
}

// keep recovery independent of dashboard state, its tmux-backed monitors and their opt-in
export function TmuxRecovery({ preview, request, retry, lastKnown, serverControl }: {
  preview: boolean; request: Request; retry: () => void; lastKnown: readonly LastKnownAgent[]; serverControl?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmation, setConfirmation] = useState<RecoveryRow[]>();
  const [resultLines, setResultLines] = useState<string[]>([]);
  const [stopError, setStopError] = useState('');
  const target = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLElement>(null);

  // enter the top layer so even portaled dashboard controls are inert
  useLayoutEffect(() => {
    const dialog = target.current!;
    dialog.showModal();
    card.current?.focus({ preventScroll: true });
    // release the top layer and restore prior focus on exit
    return () => restoreCoverFocus(() => { /* keep native focus restoration passive */ dialog.close(); });
  }, []);

  // poll only while this view is open, without piling up requests during an outage
  useEffect(() => {
    const owner = new AbortController();
    let timer: number | undefined;
    // keep the last successful sample on transient errors
    const load = async () => {
      try {
        // hidden pages wait for their next scheduled sample
        if (document.visibilityState !== 'visible') return;
        const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(8_000)]);
        const response = await request('/api/server/recovery', { signal, cache: 'no-store' });
        // only complete responses can update process identities
        if (!response.ok) throw new Error('Recovery unavailable');
        const payload: unknown = await response.json();
        if (owner.signal.aborted || signal.aborted) return;
        if (!isSnapshot(payload)) throw new Error('Invalid recovery snapshot');
        setSnapshot(payload);
        setFailed(false);
        const ids = new Set(payload.agents.map(agent => agent.id));
        setChecked(current => new Set([...current].filter(id => ids.has(id))));
      } catch {
        // an unmounted view does not own the response
        if (!owner.signal.aborted) setFailed(true);
      } finally {
        // wait until the current request settles before polling again
        if (!owner.signal.aborted) timer = window.setTimeout(load, refreshMs);
      }
    };
    void load();
    // cancel only this view's pending read
    return () => { owner.abort(); window.clearTimeout(timer); };
  }, [request, reload]);

  const { live, unverified } = recoveryRows(snapshot?.agents ?? [], lastKnown);
  const selected = live.filter(agent => { /* only live tokens can be selected */ return checked.has(agent.id); });
  const stoppable = snapshot?.canStop === true && snapshot.available && !failed;
  // cap the explicit selection before opening the confirmation
  const toggle = (id: string, select: boolean) => setChecked(current => {
    const next = new Set(current);
    // never silently operate beyond the visible selection limit
    if (select && next.size < selectionLimit) next.add(id);
    else if (!select) next.delete(id);
    return next;
  });

  // send only the identities shown in the open confirmation, without automatic retries
  const stop = async () => {
    const batch = confirmation;
    if (batch === undefined || !stoppable) return;
    setStopError('');
    setResultLines([]);
    try {
      const response = await request('/api/server/recovery/agents/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: batch.map(agent => agent.id) }), signal: AbortSignal.timeout(15_000) });
      // do not claim success if the host helper did not return an exact result
      if (!response.ok) throw new Error('Stop outcome unavailable');
      const results = stopResults(await response.json(), batch);
      const labels = new Map(batch.map(agent => [agent.id, `${agent.label} (PID ${agent.pid})`]));
      setResultLines(results.map(result => `${labels.get(result.id)}: ${stopLabels[result.status]}.`));
    } catch {
      setStopError('Could not confirm the stop outcome. Check the running list before retrying.');
    } finally {
      setChecked(new Set());
      setConfirmation(undefined);
      setReload(current => current + 1);
    }
  };

  const resources = snapshot?.resources;
  const metrics = resources === undefined && !failed ? undefined : {
    snapshot: resources,
    refreshFailed: failed || resources === undefined || resources.host === null && resources.wsl === undefined
  };
  const disks = resources === undefined && !failed ? undefined : {
    host: resources?.host ?? null,
    wsl: resources?.wsl,
    refreshFailed: failed || resources === undefined || resources.wsl?.diskError !== undefined || resources.host?.diskError !== undefined
  };

  return <dialog className="tmux-recovery" aria-label="Console recovery" aria-modal="true" ref={target} onCancel={event => {
    // escape can dismiss preview but never hide a real outage or an open confirmation
    event.preventDefault();
    if (preview && confirmation === undefined) retry();
  }}>
    <section className="tmux-recovery-card" tabIndex={-1} ref={card}>
      <header className="tmux-recovery-header">
        <div>
          <h1>tmux is not responding</h1>
          {/* show automatic resumption only for a real outage */}
          {!preview && <p>The console will resume when the dashboard is available.</p>}
        </div>
        {serverControl}
      </header>
      <div className="tmux-recovery-actions">
        <button type="button" onClick={retry}>{preview ? 'Return to dashboard' : 'Retry dashboard'}</button>
        <button type="button" onClick={() => { /* request one fresh host sample */ setReload(current => current + 1); }}>Refresh recovery data</button>
      </div>
      <ServerResources metrics={metrics} disks={disks} />
      <h2>Agents</h2>
      {failed && <p role="status">Unable to refresh recovery data. Any displayed process list is out of date.</p>}
      {snapshot === undefined && !failed && <p role="status">Checking host processes…</p>}
      {snapshot !== undefined && !snapshot.available && <p role="status">Host process information is unavailable.</p>}
      {snapshot?.available && snapshot.agents.length === 0 && <p>No running agents detected.</p>}
      {snapshot?.available && !snapshot.canStop && <p role="status">{snapshot.reason ?? 'Stopping agents is unavailable on this installation.'}</p>}
      {(live.length > 0 || unverified.length > 0) && <fieldset disabled={!stoppable}>
        <legend className="sr-only">Agents</legend>
        {live.map(agent => {
          // prefer a verified workspace name over the process's fallback directory
          const kind = recoveryKind(agent.kind);
          const name = agent.known?.workspaceName ?? recoveryLocation(agent.label, kind);
          const title = agent.known?.title;
          const caption = title !== name ? title : undefined;
          // disambiguate same-named selections without adding a visible process line
          const selectionLabel = [kind === undefined ? undefined : agentKindLabel[kind], name, caption, `PID ${agent.pid}`].filter(Boolean).join(' · ');
          return <label className="tmux-recovery-agent" key={`live:${agent.id}`}>
            <input type="checkbox" aria-label={selectionLabel} checked={checked.has(agent.id)} disabled={!checked.has(agent.id) && checked.size >= selectionLimit} onChange={event => { /* track only explicitly selected processes */ toggle(agent.id, event.currentTarget.checked); }} />
            <RecoveryAgentBadge kind={kind} />
            <span className="tmux-recovery-agent-copy"><strong>{name}</strong>{caption && <small>{caption}</small>}</span>
          </label>;
        })}
        {unverified.map(agent => {
          // keep stale dashboard rows out of the selection controls
          const name = agent.workspaceName ?? agent.title;
          const detail = agent.title === name ? 'Last known · no verified process' : `${agent.title} · Last known · no verified process`;
          return <div className="tmux-recovery-agent tmux-recovery-agent-unverified" key={`known:${agent.id}`}>
            <RecoveryAgentBadge kind={agent.kind} />
            <span className="tmux-recovery-agent-copy"><strong>{name}</strong><small>{detail}</small></span>
          </div>;
        })}
      </fieldset>}
      {live.length > 0 && <div className="tmux-recovery-actions">
        <span>{selected.length} selected</span>
        <button className="tmux-recovery-stop" type="button" disabled={!stoppable || selected.length === 0} onClick={() => { /* freeze the identities shown for confirmation */ setConfirmation(selected); }}>Stop selected agents</button>
      </div>}
      {stopError && <p role="alert">{stopError}</p>}
      {resultLines.length > 0 && <ul role="status">{resultLines.map(line => <li key={line}>{line}</li>)}</ul>}
    </section>
    {confirmation !== undefined && target.current !== null && <SplitConfirmation target={target.current} title="Stop selected agents?" description="This may interrupt active work. RAC sends a stop signal only to the selected processes." confirmLabel={`Stop ${confirmation.length} ${confirmation.length === 1 ? 'agent' : 'agents'}`} confirmDisabled={!stoppable} onConfirm={stop} onCancel={() => { /* leave the current selection unchanged */ setConfirmation(undefined); }}>
      <ul>{confirmation.map(agent => {
        // repeat the verified process and its dashboard caption before stopping
        return <li key={agent.id}>{agent.label} · PID {agent.pid}{agent.known && <small className="tmux-recovery-confirm-caption">{knownCaption(agent.known)}</small>}</li>;
      })}</ul>
    </SplitConfirmation>}
  </dialog>;
}
