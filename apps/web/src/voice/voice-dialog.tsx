import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useRealtimeVoice, type DavoMessage } from './use-realtime-voice.js';
import './loading.css';

type Request = (url: string, init?: RequestInit) => Promise<Response>;
export type VoiceWorktree = { id: string; label: string };
type VoiceContext = { server?: string; serverUrl?: string; worktree?: string; agent?: string; worktreeId?: string; agentId?: string; openWorktrees?: VoiceWorktree[] };
type VoiceContextDetails = { server: string; serverLocation?: string; activeWorktree: string; agent?: string; openWorktrees?: VoiceWorktree[] };
type WorktreeSelection = { worktreeId: string; worktreeLabel: string };

const soundwaveBars = Array.from({ length: 28 }, (_, index) => index);
const mobileWakeLockMedia = '(max-width: 600px), (pointer: coarse)';
const historyClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

// format one retained timestamp
function historyTime(timestamp: string): string {
  return historyClock.format(Date.parse(timestamp));
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
  // preserve canonical worktree identities
  if (context.openWorktrees !== undefined) {
    const worktrees = new Map<string, VoiceWorktree>();
    // normalize distinct visible worktrees
    for (const worktree of context.openWorktrees) {
      const id = worktree.id.trim();
      if (id === '' || id === context.worktreeId) continue;
      worktrees.set(id, { id, label: worktree.label.trim() || id });
    }
    const counts = new Map<string, number>();
    if (context.worktreeId !== undefined) counts.set(activeWorktree, 1);
    // count ambiguous labels
    for (const worktree of worktrees.values()) counts.set(worktree.label, (counts.get(worktree.label) ?? 0) + 1);
    openWorktrees = [...worktrees.values()]
      .map(worktree => counts.get(worktree.label) === 1 ? worktree : { ...worktree, label: `${worktree.label} · ${worktree.id}` })
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }
  return { server, activeWorktree, ...(agent ? { agent } : {}), ...(location === undefined ? {} : { serverLocation: location }), ...(openWorktrees === undefined ? {} : { openWorktrees }) };
}

// match one searchable durable message
function matchesHistory(message: DavoMessage, query: string): boolean {
  return [message.kind, message.text, message.createdAt, historyTime(message.createdAt)].join(' ').toLocaleLowerCase().includes(query);
}

// hold the screen while mobile listening is visible
function useMobileScreenWakeLock(active: boolean): void {
  useEffect(() => {
    // degrade when inactive or unsupported
    if (!active || !('wakeLock' in navigator)) return;
    const mobile = window.matchMedia(mobileWakeLockMedia);
    let disposed = false;
    let wakeLock: WakeLockSentinel | undefined;
    // release the current lock
    const release = async () => {
      const current = wakeLock;
      wakeLock = undefined;
      if (current !== undefined && !current.released) await current.release().catch(() => undefined);
    };
    // acquire only for a visible mobile surface
    const acquire = async () => {
      if (disposed || wakeLock !== undefined || document.visibilityState !== 'visible' || !mobile.matches) return;
      try {
        const current = await navigator.wakeLock.request('screen');
        // discard stale acquisition
        if (disposed || document.visibilityState !== 'visible' || !mobile.matches) { await current.release().catch(() => undefined); return; }
        wakeLock = current;
      } catch {
        // wake lock denial never interrupts audio
      }
    };
    // match the current page state
    const sync = () => {
      if (document.visibilityState === 'visible' && mobile.matches) void acquire();
      else void release();
    };
    document.addEventListener('visibilitychange', sync);
    mobile.addEventListener('change', sync);
    sync();
    // release on surface removal
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', sync);
      mobile.removeEventListener('change', sync);
      void release();
    };
  }, [active]);
}

export type VoiceDialogProps = { name: string; open: boolean; openRequest: number; context: VoiceContext; request: Request; onHide: () => void; onSelectWorktree?: (worktreeId: string) => WorktreeSelection | undefined; onActiveChange?: (active: boolean) => void };

// render persistent audio-only Davo history
export function VoiceDialog({ name, open, openRequest, context, request, onHide, onSelectWorktree, onActiveChange }: VoiceDialogProps) {
  const assistantName = name.trim() || 'Davo';
  const voice = useRealtimeVoice(request, { ...(context.worktreeId === undefined ? {} : { worktreeId: context.worktreeId }), ...(context.worktree === undefined ? {} : { worktreeLabel: context.worktree }), ...(context.agentId === undefined ? {} : { agentId: context.agentId }) }, onSelectWorktree, assistantName);
  const active = voice.state === 'connecting' || voice.state === 'connected';
  useMobileScreenWakeLock(open && active);
  const connection = formatVoiceContext(context);
  const [historyQuery, setHistoryQuery] = useState('');
  const hideButton = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLElement>(null);
  const handledOpenRequest = useRef(openRequest);

  // start each explicit open request once
  useEffect(() => {
    if (!open || openRequest === handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest;
    void voice.start();
  }, [open, openRequest, voice.start]);

  // focus the mobile hide control
  useEffect(() => {
    if (open && window.matchMedia('(max-width: 600px)').matches) hideButton.current?.focus();
  }, [open]);

  // publish global audio activity
  useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);

  // publish directional levels to the compact trigger
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--davo-output-level', voice.outputLevel.toFixed(3));
    root.style.setProperty('--davo-input-level', voice.inputLevel.toFixed(3));
    root.style.setProperty('--davo-activity-level', Math.max(voice.outputLevel, voice.inputLevel).toFixed(3));
  }, [voice.inputLevel, voice.outputLevel]);

  // remove global levels after unmount
  useEffect(() => () => {
    document.documentElement.style.removeProperty('--davo-output-level');
    document.documentElement.style.removeProperty('--davo-input-level');
    document.documentElement.style.removeProperty('--davo-activity-level');
  }, []);

  // follow newly retained messages
  useEffect(() => {
    const history = transcript.current;
    if (history !== null) history.scrollTop = history.scrollHeight;
  }, [voice.conversation.messages]);

  const normalizedQuery = historyQuery.trim().toLocaleLowerCase();
  const visibleMessages = useMemo(() => normalizedQuery === '' ? voice.conversation.messages : voice.conversation.messages.filter(message => matchesHistory(message, normalizedQuery)), [normalizedQuery, voice.conversation.messages]);
  let history: ReactNode;
  // explain a new empty conversation
  if (voice.conversation.loading && voice.conversation.messages.length === 0) history = <p className="voice-history-empty">Loading retained history…</p>;
  else if (voice.conversation.messages.length === 0) history = <p className="voice-history-empty">Speak while listening is open. There is no typed message box.</p>;
  else if (visibleMessages.length === 0) history = <p className="voice-history-empty">No history matches “{historyQuery.trim()}”.</p>;
  else history = visibleMessages.map(message => {
    const role = message.kind === 'user' ? 'user' : 'assistant';
    const time = new Date(message.createdAt);
    return <p key={message.id} className={`voice-${role} voice-${message.kind}`}><strong>{message.kind === 'user' ? 'You' : message.kind === 'assistant' ? assistantName : message.kind}</strong><time dateTime={time.toISOString()} title={time.toLocaleString()}>{historyTime(message.createdAt)}</time><span>{message.text}</span></p>;
  });

  let openWorktrees: ReactNode;
  // show missing context explicitly
  if (connection.openWorktrees === undefined) openWorktrees = <span className="voice-context-fallback">Unavailable</span>;
  else if (connection.openWorktrees.length === 0) openWorktrees = <span className="voice-context-fallback">None</span>;
  else openWorktrees = <ul>{connection.openWorktrees.map(worktree => <li key={worktree.id} title={worktree.label}>{worktree.label}</li>)}</ul>;

  // keep hidden history mounted but absent from accessibility
  if (!open) return null;
  const soundwaveStyle = { '--mic-level': voice.inputLevel.toFixed(3), '--davo-level': voice.outputLevel.toFixed(3) } as CSSProperties;
  const busy = voice.state === 'connecting';
  const status = voice.state === 'connected' ? voice.muted ? `Muted — say ${assistantName}` : 'Listening' : voice.state === 'connecting' ? 'Opening listening…' : 'Listening is off';

  return <div className="dialog voice-dialog" role="dialog" aria-modal={window.matchMedia('(max-width: 600px)').matches} aria-labelledby="voice-title">
    <div style={soundwaveStyle}>
      <div className="voice-soundwaves" aria-hidden="true"><div className="voice-soundwave davo">{soundwaveBars.map(index => <i key={index} style={{ animationDelay: `${index * -47}ms` }} />)}</div><div className="voice-soundwave mic">{soundwaveBars.map(index => <i key={index} style={{ animationDelay: `${index * -47}ms` }} />)}</div></div>
      <header><div><small>OPENAI REALTIME</small><h2 id="voice-title">{assistantName}</h2></div><button ref={hideButton} className="voice-view-toggle" type="button" aria-label={`Show main UI while ${assistantName} remains available`} onClick={onHide}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg></button></header>
      <section className="voice-context" aria-label={`${assistantName} connection context`}>
        <div className="voice-context-card voice-context-active"><small>Active worktree</small><strong>{connection.activeWorktree}</strong>{connection.agent && <span>Agent · {connection.agent}</span>}</div>
        <div className="voice-context-card voice-context-server"><small>Server / instance</small><strong>{connection.server}</strong>{connection.serverLocation && <span>{connection.serverLocation}</span>}</div>
        <div className="voice-context-card voice-context-open"><small>Other open worktrees</small>{openWorktrees}</div>
      </section>
      <div className={`voice-transcript-shell${busy ? ' progress-border progress-green progress-loading' : ''}`} aria-busy={busy || undefined}>
        {busy && <span className="update-progress-ring" aria-hidden="true" />}
        <section ref={transcript} className="voice-transcript" aria-live="polite">
          <div className="voice-history-toolbar"><strong>Recent history</strong><label className="voice-history-search"><span className="sr-only">Search {assistantName} history</span><input type="search" value={historyQuery} placeholder="Search history" onChange={event => setHistoryQuery(event.target.value)} /></label></div>
          {voice.conversation.snapshot?.hasMore && <button type="button" className="voice-load-older" disabled={voice.conversation.loadingOlder} onClick={() => void voice.conversation.loadOlder()}>{voice.conversation.loadingOlder ? 'Loading…' : 'Load older'}</button>}
          {voice.conversation.snapshot?.pendingChoices.map(choice => <section key={`${choice.requestId}:${choice.choiceId}`} className="voice-pending-choice" aria-label="Pending voice question"><strong>{choice.question}</strong>{choice.options.length > 0 && <ul>{choice.options.map(option => <li key={option}>{option}</li>)}</ul>}<small>Answer by voice while listening is open.</small></section>)}
          {history}
        </section>
      </div>
      {voice.error && <p className="auth-error" role="alert">{voice.error}</p>}
      <footer>
        {voice.state === 'idle' || voice.state === 'error'
          ? <button type="button" className="voice-start" onClick={() => void voice.start()}>Open listening</button>
          : <div className="voice-actions"><button type="button" className="voice-mute" aria-pressed={voice.muted} disabled={busy} onClick={voice.toggleMute}>{voice.muted ? `Muted — say ${assistantName}` : 'Mute'}</button><button type="button" className="voice-stop" disabled={busy} onClick={voice.stop}>Close</button></div>}
        <small>{status}. {voice.muted ? 'Microphone audio is still sent to OpenAI for exact-name wake detection.' : 'Closing stops microphone and audio output without canceling eligible agent work.'}</small>
      </footer>
    </div>
  </div>;
}
