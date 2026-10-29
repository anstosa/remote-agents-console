import { useState } from 'react';
import { FlyoutPortal } from './flyout-portal.js';
import { useViewportFlyout } from './viewport-flyout.js';

/** One Watch an Agent set (ADR 0019), as the dashboard reports it. */
export type WatchSummary = { id: string; kind: 'pull_request' | 'process' | 'review_requests' | 'command'; description: string; createdAt: string };
type Request = (url: string, init?: RequestInit) => Promise<Response>;

const kindLabel: Record<WatchSummary['kind'], string> = { pull_request: 'Pull request', process: 'Stack process', review_requests: 'Review requests', command: 'Command' };

/**
 * The Conductor's Watches button: how many it keeps, opening the list of them, each with Remove,
 * which stops a command Watch's command.
 */
export function WatchesButton({ agentId, watches, request, onError }: { agentId: string; watches: readonly WatchSummary[]; request: Request; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLDivElement>(open);
  const remove = async (watch: WatchSummary) => {
    setRemoving(watch.id);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agentId)}/watches/${encodeURIComponent(watch.id)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) onError('The Watch could not be removed.');
    } catch {
      onError('The console could not be reached. The Watch was not removed.');
    } finally {
      setRemoving(undefined);
    }
  };
  const label = `${watches.length} ${watches.length === 1 ? 'Watch' : 'Watches'}`;
  return <div className="model-chip-control" ref={anchorRef}>
    <button type="button" className={`model-chip watches-chip${open ? ' active' : ''}`} aria-haspopup="dialog" aria-expanded={open} title="What the Conductor watches" onClick={() => setOpen(value => !value)}>{label}<span className="flyout-caret" aria-hidden="true" /></button>
    {open && <FlyoutPortal onDismiss={() => setOpen(false)}><div ref={flyoutRef} className="model-picker" style={style} role="dialog" aria-label="Watches">
      <p className="model-picker-heading">Watches</p>
      {watches.length === 0 ? <p className="model-picker-note">Nothing is watched. The Conductor sets Watches on pull requests, Stack processes, review requests and commands.</p> : watches.map(watch => <div key={watch.id} className="watch-row">
        <span><strong>{watch.description}</strong><small>{kindLabel[watch.kind]} · since {new Date(watch.createdAt).toLocaleString()}</small></span>
        <button type="button" disabled={removing === watch.id} aria-label={`Remove ${watch.description}`} onClick={() => void remove(watch)}>Remove</button>
      </div>)}
      <p className="model-picker-note">Each event is a Turn of its own, held to its hourly budget.</p>
    </div></FlyoutPortal>}
  </div>;
}
