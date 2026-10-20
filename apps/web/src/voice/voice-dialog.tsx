import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useRealtimeVoice, type ToolTranscriptEntry, type TranscriptEntry } from './use-realtime-voice.js';

type Request = (url: string, init?: RequestInit) => Promise<Response>;
export type VoiceWorktree = { id: string; label: string };
type VoiceContext = { server?: string; serverUrl?: string; worktree?: string; agent?: string; worktreeId?: string; agentId?: string; openWorktrees?: VoiceWorktree[] };
type VoiceContextDetails = { server: string; serverLocation?: string; activeWorktree: string; agent?: string; openWorktrees?: VoiceWorktree[] };
type WorktreeSelection = { worktreeId: string; worktreeLabel: string };

// provide staggered waveform positions
const soundwaveBars = Array.from({ length: 28 }, (_, index) => index);
const mobileWakeLockMedia = '(max-width: 600px), (pointer: coarse)';
const historyClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// format one compact history timestamp
function historyTime(timestamp: number): string {
  return historyClock.format(timestamp);
}

// summarize one retained tool detail
function detailSummary(detail: string): string {
  const compact = detail.replace(/\s+/gu, ' ').trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}…`;
}

// format retained JSON details for reading
function formattedDetail(detail: string): string {
  try { return JSON.stringify(JSON.parse(detail), null, 2); }
  catch { return detail; }
}

// format one server location
function serverLocation(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  // omit missing locations
  if (!normalized) return undefined;
  try { return new URL(normalized).host || normalized; }
  catch { return normalized; }
}

// normalize the visible voice context
function formatVoiceContext(context: VoiceContext): VoiceContextDetails {
  const activeWorktree = context.worktree?.trim() || 'No worktree selected';
  const server = context.server?.trim() || 'Unavailable';
  const agent = context.agent?.trim();
  const location = serverLocation(context.serverUrl);
  let openWorktrees: VoiceWorktree[] | undefined;
  // preserve canonical worktree identities when context is available
  if (context.openWorktrees !== undefined) {
    const worktrees = new Map<string, VoiceWorktree>();
    // normalize and deduplicate live worktrees by identifier
    for (const worktree of context.openWorktrees) {
      const id = worktree.id.trim();
      // skip malformed and active entries
      if (id === '' || id === context.worktreeId) continue;
      worktrees.set(id, { id, label: worktree.label.trim() || id });
    }
    const labelCounts = new Map<string, number>();
    // include the active label when detecting ambiguous names
    if (context.worktreeId !== undefined) labelCounts.set(activeWorktree, 1);
    // count distinct worktrees sharing one visible label
    for (const worktree of worktrees.values()) labelCounts.set(worktree.label, (labelCounts.get(worktree.label) ?? 0) + 1);
    openWorktrees = [...worktrees.values()]
      .map(worktree => labelCounts.get(worktree.label) === 1 ? worktree : { ...worktree, label: `${worktree.label} · ${worktree.id}` })
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }
  return { server, activeWorktree, ...(agent ? { agent } : {}), ...(location === undefined ? {} : { serverLocation: location }), ...(openWorktrees === undefined ? {} : { openWorktrees }) };
}

// match one searchable history entry
function matchesHistory(entry: TranscriptEntry, query: string): boolean {
  const timestamp = new Date(entry.timestamp);
  // include every retained tool field in search
  const details = entry.role === 'tool'
    ? [entry.role, entry.name, entry.status, entry.text, entry.request, entry.result, entry.error, timestamp.toISOString(), historyTime(entry.timestamp)]
    : [entry.role, entry.text, timestamp.toISOString(), historyTime(entry.timestamp)];
  return details.filter(detail => detail !== undefined).join(' ').toLocaleLowerCase().includes(query);
}

// render one grouped tool lifecycle
const ToolHistoryEntry = memo(function ToolHistoryEntry({ entry }: { entry: ToolTranscriptEntry }) {
  const [open, setOpen] = useState(false);
  const headline = detailSummary(entry.error ?? entry.result ?? entry.request ?? entry.text);
  const time = new Date(entry.timestamp);
  const statusLabel = entry.status === 'running' ? 'Run' : entry.status === 'completed' ? 'Done' : entry.status === 'incomplete' ? 'Partial' : 'Error';
  const rows = [
    { label: 'Req', value: entry.request },
    { label: 'Result', value: entry.result },
    { label: 'Error', value: entry.error }
  ];
  return <details className={`voice-tool voice-tool-${entry.status}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><time dateTime={time.toISOString()} title={time.toLocaleString()}>{historyTime(entry.timestamp)}</time><strong>{entry.name}</strong><b>{statusLabel}</b><span>{headline}</span></summary>
    {open && <dl>{rows.map(row => {
      // omit unavailable lifecycle sections
      if (row.value === undefined) return null;
      const summary = detailSummary(row.value);
      const formatted = formattedDetail(row.value);
      return <div key={row.label}><dt>{row.label}</dt><dd><span>{summary}</span>{formatted === summary ? null : <pre>{formatted}</pre>}</dd></div>;
    })}</dl>}
  </details>;
});

// hold the screen while mobile voice is visible
function useMobileScreenWakeLock(active: boolean) {
  useEffect(() => {
    // degrade when inactive or unsupported
    if (!active || !('wakeLock' in navigator)) return;
    const mobile = window.matchMedia(mobileWakeLockMedia);
    let disposed = false;
    let pageActive = true;
    let acquiring = false;
    let releaseRecoveries = 0;
    let wakeLock: WakeLockSentinel | undefined;
    // release the currently held lock
    const release = async () => {
      const current = wakeLock;
      wakeLock = undefined;
      // skip absent or already released locks
      if (current === undefined || current.released) return;
      await current.release().catch(() => undefined);
    };
    // acquire one visible mobile lock
    const acquire = async () => {
      // serialize requests and require a visible mobile page
      if (disposed || acquiring || wakeLock !== undefined || !pageActive || document.visibilityState !== 'visible' || !mobile.matches) return;
      acquiring = true;
      try {
        const current = await navigator.wakeLock.request('screen');
        // release requests resolved after visibility changed
        if (disposed || !pageActive || document.visibilityState !== 'visible' || !mobile.matches) {
          await current.release().catch(() => undefined);
          return;
        }
        wakeLock = current;
        // forget locks released by the browser
        current.addEventListener('release', () => {
          // preserve a newer lock
          if (wakeLock !== current) return;
          wakeLock = undefined;
          // retry one unexpected visible-page release
          if (!disposed && pageActive && document.visibilityState === 'visible' && mobile.matches && releaseRecoveries === 0) {
            releaseRecoveries += 1;
            void acquire();
          }
        }, { once: true });
      } catch { /* Wake lock denial must not interrupt voice. */ }
      finally { acquiring = false; }
    };
    // match the lock to current page state
    const sync = () => {
      // hold only while fully visible on mobile
      if (pageActive && document.visibilityState === 'visible' && mobile.matches) {
        releaseRecoveries = 0;
        void acquire();
      } else void release();
    };
    // release before navigation or suspension
    const hidePage = () => {
      pageActive = false;
      void release();
    };
    // restore after back-forward cache return
    const showPage = () => {
      pageActive = true;
      sync();
    };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', hidePage);
    window.addEventListener('pageshow', showPage);
    mobile.addEventListener('change', sync);
    sync();
    // remove listeners and release on close
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pagehide', hidePage);
      window.removeEventListener('pageshow', showPage);
      mobile.removeEventListener('change', sync);
      void release();
    };
  }, [active]);
}

export type VoiceDialogProps = { name: string; open: boolean; callRequest: number; context: VoiceContext; request: Request; onClose: () => void; onSelectWorktree?: (worktreeId: string) => WorktreeSelection | undefined; onActiveChange?: (active: boolean) => void };

// render the responsive voice orchestration surface
export function VoiceDialog({ name, open, callRequest, context, request, onClose, onSelectWorktree, onActiveChange }: VoiceDialogProps) {
  const assistantName = name.trim() || 'Davo';
  const voice = useRealtimeVoice(request, { ...(context.worktreeId === undefined ? {} : { worktreeId: context.worktreeId }), ...(context.worktree === undefined ? {} : { worktreeLabel: context.worktree }), ...(context.agentId === undefined ? {} : { agentId: context.agentId }) }, onSelectWorktree, open, assistantName);
  useMobileScreenWakeLock(open);
  const connection = formatVoiceContext(context);
  const [historyQuery, setHistoryQuery] = useState('');
  const closeButton = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLElement>(null);
  const hangupSound = useRef<HTMLAudioElement>(null);
  const previousVoiceState = useRef(voice.state);
  const handledCallRequest = useRef(callRequest);
  // clear stale filters for each requested or retried call
  useEffect(() => {
    // reset only when a fresh connection begins
    if (voice.state === 'connecting') setHistoryQuery('');
  }, [voice.state]);
  // focus the dialog close control after opening
  useEffect(() => {
    // focus only the fullscreen mobile toggle
    if (open && window.matchMedia('(max-width: 600px)').matches) closeButton.current?.focus();
  }, [open]);
  // start each explicitly requested call once
  useEffect(() => {
    // ignore visibility toggles and handled requests
    if (!open || callRequest === handledCallRequest.current) return;
    handledCallRequest.current = callRequest;
    void voice.start();
  }, [callRequest, open, voice.start]);
  // publish the visible voice mutation gate
  useEffect(() => { onActiveChange?.(voice.state === 'connecting' || voice.state === 'connected'); }, [onActiveChange, voice.state]);
  // publish live levels to the mobile call control
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--davo-output-level', voice.outputLevel.toFixed(3));
    root.style.setProperty('--davo-input-level', voice.inputLevel.toFixed(3));
    root.style.setProperty('--davo-call-level', Math.max(voice.outputLevel, voice.inputLevel).toFixed(3));
  }, [voice.inputLevel, voice.outputLevel]);
  // remove global audio levels after unmounting
  useEffect(() => () => {
    document.documentElement.style.removeProperty('--davo-output-level');
    document.documentElement.style.removeProperty('--davo-input-level');
    document.documentElement.style.removeProperty('--davo-call-level');
  }, []);
  // follow each new transcript update
  useEffect(() => {
    const history = transcript.current;
    // keep the newest message visible
    if (history !== null) history.scrollTop = history.scrollHeight;
  }, [voice.transcript]);
  // finish and dismiss each established call
  useEffect(() => {
    const previous = previousVoiceState.current;
    previousVoiceState.current = voice.state;
    // ignore setup, errors, and non-call transitions
    if (previous !== 'connected' || voice.state !== 'idle' || !voice.endedIntentionally) return;
    const sound = hangupSound.current;
    // skip playback after the dialog audio element unmounts
    if (sound === null) return;
    sound.currentTime = 0;
    void sound.play().catch(() => undefined);
    const dismissal = window.setTimeout(onClose, 2_000);
    // cancel dismissal when another call starts
    return () => window.clearTimeout(dismissal);
  }, [onClose, voice.endedIntentionally, voice.state]);
  // hide without ending the ongoing call
  const close = () => onClose();
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  // filter without deleting retained history
  const visibleTranscript = useMemo(() => {
    // retain every entry for an empty search
    if (normalizedHistoryQuery === '') return voice.transcript;
    return voice.transcript.filter(entry => matchesHistory(entry, normalizedHistoryQuery));
  }, [normalizedHistoryQuery, voice.transcript]);
  let history: ReactNode;
  // explain a new empty conversation
  if (voice.transcript.length === 0) history = <p className="voice-history-empty">Ask about agents, worktrees, branches, prompts, reviews, files, or stack status.</p>;
  // explain an empty search without discarding history
  else if (visibleTranscript.length === 0) history = <p className="voice-history-empty">No history matches “{historyQuery.trim()}”.</p>;
  // render compact speech and grouped tools
  else history = visibleTranscript.map(entry => {
    // render tool lifecycle detail separately
    if (entry.role === 'tool') return <ToolHistoryEntry key={entry.id} entry={entry} />;
    const time = new Date(entry.timestamp);
    return <p key={entry.id} className={`voice-${entry.role}`}><strong>{entry.role === 'user' ? 'You' : assistantName}</strong><time dateTime={time.toISOString()} title={time.toLocaleString()}>{historyTime(entry.timestamp)}</time><span>{entry.text}</span></p>;
  });
  let openWorktrees: ReactNode;
  // show missing server context explicitly
  if (connection.openWorktrees === undefined) openWorktrees = <span className="voice-context-fallback">Unavailable</span>;
  // distinguish an empty open-worktree list
  else if (connection.openWorktrees.length === 0) openWorktrees = <span className="voice-context-fallback">None</span>;
  // render the other live worktrees for scanning
  else openWorktrees = <ul>{connection.openWorktrees.map(worktree => <li key={worktree.id} title={worktree.label}>{worktree.label}</li>)}</ul>;
  // keep the dialog absent from the accessibility tree while closed
  if (!open) return null;
  const soundwaveStyle = { '--mic-level': voice.inputLevel.toFixed(3), '--davo-level': voice.outputLevel.toFixed(3) } as CSSProperties;
  return <div className="dialog voice-dialog" role="dialog" aria-modal={window.matchMedia('(max-width: 600px)').matches} aria-labelledby="voice-title">
    <div style={soundwaveStyle}>
      <div className="voice-soundwaves" aria-hidden="true"><div className="voice-soundwave davo">{soundwaveBars.map(index => <i key={index} style={{ animationDelay: `${index * -47}ms` }} />)}</div><div className="voice-soundwave mic">{soundwaveBars.map(index => <i key={index} style={{ animationDelay: `${index * -47}ms` }} />)}</div></div>
      <header><div><small>OPENAI REALTIME</small><h2 id="voice-title">{assistantName}</h2></div><button ref={closeButton} className="voice-view-toggle" type="button" aria-label={`Ongoing ${assistantName} call — show main UI`} onClick={close}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.08 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.84.56 2.8.69A2 2 0 0 1 22 16.92Z" /></svg></button></header>
      <section className="voice-context" aria-label={`${assistantName} connection context`}>
        <div className="voice-context-card voice-context-active"><small>Active worktree</small><strong>{connection.activeWorktree}</strong>{connection.agent && <span>Agent · {connection.agent}</span>}</div>
        <div className="voice-context-card voice-context-server"><small>Server / instance</small><strong>{connection.server}</strong>{connection.serverLocation && <span>{connection.serverLocation}</span>}</div>
        <div className="voice-context-card voice-context-open"><small>Other open worktrees</small>{openWorktrees}</div>
      </section>
      <section ref={transcript} className="voice-transcript" aria-live="polite">
        <div className="voice-history-toolbar"><strong>History</strong><label className="voice-history-search"><span className="sr-only">Search {assistantName} history</span><input type="search" value={historyQuery} placeholder="Search history" onChange={event => setHistoryQuery(event.target.value)} /></label></div>
        {history}
      </section>
      {voice.toolStatus && <p className="voice-tool-status progress-border progress-peach" aria-busy="true"><span className="update-progress-ring" aria-hidden="true" />{voice.toolStatus}</p>}
      {voice.error && <p className="auth-error" role="alert">{voice.error}</p>}
      {voice.state === 'connecting' && <audio className="voice-ringing" src="/davo-ring.wav" autoPlay loop aria-hidden="true" />}
      <audio ref={hangupSound} className="voice-hangup-sound" src="/davo-hangup.wav" preload="auto" aria-hidden="true" />
      <footer>
        {voice.state === 'idle' || voice.state === 'error'
          ? <button type="button" className="voice-start" onClick={() => void voice.start()}>Call {assistantName}</button>
          : <div className="voice-call-actions"><button type="button" className="voice-mute" aria-pressed={voice.muted} disabled={voice.state === 'connecting'} onClick={voice.toggleMute}>{voice.muted ? 'Unmute' : 'Mute'}</button><button type="button" className={`voice-stop${voice.state === 'connecting' ? ' progress-border progress-green' : ''}`} aria-busy={voice.state === 'connecting' || undefined} disabled={voice.state === 'connecting'} onClick={voice.stop}>{voice.state === 'connecting' && <span className="update-progress-ring" aria-hidden="true" />}{voice.state === 'connecting' ? 'Calling...' : 'Hang up'}</button></div>}
        <small>Hanging up does not cancel agent work.</small>
      </footer>
    </div>
  </div>;
}
