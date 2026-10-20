import { useEffect, useRef, useState } from 'react';
import { PanelIcon, panelIcons } from './panel-header.js';

export type GitUpstreamSummary = { upstream: string; ahead: number; behind: number };

// retain upstream notices until explicitly dismissed or the branch catches up
export function UpstreamRebaseNotification({ notificationKey, summary, onRebase }: { notificationKey: string; summary?: GitUpstreamSummary; onRebase?: () => Promise<boolean> }) {
  const storageKey = `rac:upstream-update-dismissed:${notificationKey}`;
  // restore this branch's dismissal across navigation and reloads in the same tab
  const [dismissedBehind, setDismissedBehind] = useState(() => {
    try { return sessionStorage.getItem(storageKey); }
    catch { return null; }
  });
  const [queueing, setQueueing] = useState(false);
  const [queued, setQueued] = useState(false);
  const queuedTimer = useRef<number | undefined>(undefined);
  // retire an old dismissal when a different upstream state is observed
  useEffect(() => {
    // preserve unchanged dismissals and unavailable git state
    if (dismissedBehind === null || summary?.behind === undefined || dismissedBehind === String(summary.behind)) return;
    setDismissedBehind(null);
    try { sessionStorage.removeItem(storageKey); }
    catch { /* retain the in-memory reset when storage is unavailable */ }
  }, [dismissedBehind, storageKey, summary?.behind]);
  // release transient action feedback when the notification leaves
  useEffect(() => () => {
    // avoid a queued-state update after unmount
    if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
  }, []);
  // suppress resolved updates and the exact update the user dismissed
  if (summary === undefined || summary.behind === 0 || dismissedBehind === String(summary.behind)) return null;
  const commits = `${summary.behind} new ${summary.behind === 1 ? 'commit' : 'commits'}`;
  const local = summary.ahead === 0 ? '' : ` Your branch also has ${summary.ahead} local ${summary.ahead === 1 ? 'commit' : 'commits'}.`;
  // hide this update without changing the branch or queueing work
  const dismiss = () => {
    const behind = String(summary.behind);
    setDismissedBehind(behind);
    try { sessionStorage.setItem(storageKey, behind); }
    catch { /* preserve dismissal for the mounted notification without storage */ }
  };
  // queue the existing rebase workflow without dismissing its notification
  const queueRebase = async () => {
    // ignore unavailable or already pending actions
    if (onRebase === undefined || queueing) return;
    setQueueing(true);
    try {
      // acknowledge only an accepted prompt
      if (!await onRebase()) return;
      setQueued(true);
      // replace any prior action feedback timer
      if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
      // restore the action label without hiding the persistent notice
      queuedTimer.current = window.setTimeout(() => {
        queuedTimer.current = undefined;
        setQueued(false);
      }, 1_600);
    } finally { setQueueing(false); }
  };
  return <section className="toast upstream-rebase-notification" role="status" aria-label={`${summary.upstream} has ${commits}`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12m0 0-3-3m3 3 3-3M18 21V9m0 0-3 3m3-3 3 3M9 5h5a4 4 0 0 1 4 4M15 19h-5a4 4 0 0 1-4-4" /></svg><span className="upstream-rebase-copy"><strong>Upstream updates available</strong><small>{summary.upstream} has {commits}.{local}</small><button className={`${queued ? 'queued' : ''}${queueing ? ' progress-border progress-yellow' : ''}`.trim() || undefined} type="button" aria-busy={queueing || undefined} disabled={onRebase === undefined || queueing} aria-label={`Rebase onto ${summary.upstream}`} title={onRebase === undefined ? 'Launch the agent to rebase upstream' : `Queue $rebase ${summary.upstream}`} onClick={() => void queueRebase()}>{queueing && <span className="update-progress-ring" aria-hidden="true" />}{queued ? '✓ Queued' : 'Rebase upstream'}</button></span><button className="upstream-rebase-dismiss" type="button" aria-label="Dismiss upstream update notification" title="Dismiss" onClick={dismiss}><PanelIcon path={panelIcons.close} /></button></section>;
}
