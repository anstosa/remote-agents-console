import { useLayoutEffect, useRef, useState, type KeyboardEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { PanelIcon, panelIcons } from './panel-header.js';

export type PiUpdateTarget = { currentVersion: string; targetVersion: string };

// confirm a local dependency-change prompt rather than installing or deploying Pi
export function PiUpdateDialog({ target, request, onClose, onSubmitted }: {
  target: PiUpdateTarget;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onSubmitted: (agentId: string) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  // focus the non-mutating action when the confirmation opens
  useLayoutEffect(() => { cancel.current?.focus(); }, []);

  // keep keyboard navigation inside the confirmation until submission settles
  const dialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // cancel only before an explicit submission starts
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!submitting.current) onClose(); return; }
    // leave ordinary keys unchanged
    if (event.key !== 'Tab' || dialog.current === null) return;
    const controls = Array.from(dialog.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const current = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.shiftKey ? (current <= 0 ? controls.length - 1 : current - 1) : (current + 1) % controls.length;
    event.preventDefault();
    (controls[next] ?? dialog.current).focus();
  };

  // retain one retry identity so a lost response cannot duplicate the prompt
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // guard rapid clicks before React renders the pending state
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const response = await request('/api/agents/pi/update-prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, ...target })
      });
      const payload = await response.json().catch(() => undefined) as { agentId?: unknown; error?: unknown } | undefined;
      // keep rejected or ambiguous submissions visible for a deliberate retry
      if (!response.ok || typeof payload?.agentId !== 'string' || payload.agentId.length === 0) {
        setError(typeof payload?.error === 'string' && payload.error !== 'Console unavailable' ? payload.error : 'Unable to confirm prompt submission. Retry to check the same request.');
        return;
      }
      onSubmitted(payload.agentId);
    } catch {
      setError('Unable to confirm prompt submission. Retry to check the same request.');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return createPortal(<div className="dialog client-rename-dialog pi-update-dialog" role="dialog" aria-modal="true" aria-labelledby="pi-update-title" aria-describedby="pi-update-description" tabIndex={-1} ref={dialog} onKeyDown={dialogKey}>
    <div>
      <header><div><small>PI UPDATE</small><h2 id="pi-update-title">Update bundled Pi</h2></div><button type="button" aria-label="Close Pi update" disabled={pending} onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header>
      <form onSubmit={event => void submit(event)}>
        <p id="pi-update-description">Pi is bundled in RAC. A newer Pi release is available: <strong>{target.currentVersion} → {target.targetVersion}</strong>.</p>
        <p>Create a local change to update the pinned version?</p>
        <p>This submits a prompt to an agent in the RAC checkout to update the dependencies and validate compatibility. It does not update RAC from upstream or deploy the change.</p>
        {error && <span className="auth-error" role="alert">{error}</span>}
        <footer><button type="button" ref={cancel} disabled={pending} onClick={onClose}>Cancel</button><button type="submit" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending}>{pending && <span className="update-progress-ring" aria-hidden="true" />}{pending ? 'Submitting…' : 'Submit prompt'}</button></footer>
      </form>
    </div>
  </div>, document.body);
}
