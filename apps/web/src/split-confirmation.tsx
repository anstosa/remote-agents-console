import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './split-confirmation.css';

export type SplitConfirmationProps = {
  target: HTMLElement;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  tone?: 'danger' | 'normal';
  cancelLabel?: string;
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
};

const focusableSelector = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// collect only controls that can receive focus now
const focusableControls = (dialog: HTMLElement): HTMLElement[] =>
  Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(control => { /* exclude hidden controls */ return control.offsetParent !== null; });

// present one confirmation inside its owning split
export function SplitConfirmation({ target, title, description, children, confirmLabel, confirmDisabled = false, tone = 'danger', cancelLabel = 'Cancel', pending = false, onConfirm, onCancel }: SplitConfirmationProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const actionPending = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const busy = pending || confirming;

  // isolate the covered split without affecting neighboring splits
  useEffect(() => {
    const previous = new Map<HTMLElement, boolean>();
    // lock current and newly portaled split children
    const lockChildren = () => {
      // inspect direct children only
      for (const child of Array.from(target.children)) {
        // leave non-html and the confirmation itself untouched
        if (!(child instanceof HTMLElement) || child === overlayRef.current) continue;
        // capture each original state once
        if (!previous.has(child)) previous.set(child, child.inert);
        child.inert = true;
      }
    };
    lockChildren();
    // lock direct children added while the confirmation remains open
    const observer = new MutationObserver(lockChildren);
    observer.observe(target, { childList: true });
    // restore every child's prior interaction state
    return () => {
      observer.disconnect();
      // restore removed children too in case they are reused
      for (const [child, inert] of previous) child.inert = inert;
    };
  }, [target]);

  // focus the safe action or the stable card while pending
  useEffect(() => {
    const destination = busy ? dialogRef.current : cancelRef.current;
    destination?.focus({ preventScroll: true });
  }, [busy]);

  // restore the prior split focus on close
  useEffect(() => {
    // return to a surviving control or the owning split
    return () => {
      const previous = returnFocus.current;
      const previousAvailable = previous?.isConnected === true && !previous.matches(':disabled') && previous.closest('[inert]') === null;
      const destination = previousAvailable ? previous : target.isConnected ? target : null;
      destination?.focus({ preventScroll: true });
    };
  }, [target]);

  // cancel only while no action is being committed
  const cancel = () => {
    // keep the pending confirmation stable
    if (pending || actionPending.current) return;
    onCancel();
  };

  // run the explicitly confirmed action at most once at a time
  const confirm = async () => {
    // require a complete decision and ignore duplicate submissions
    if (pending || confirmDisabled || actionPending.current) return;
    actionPending.current = true;
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      actionPending.current = false;
      setConfirming(false);
    }
  };

  // contain modal navigation and protect split shortcuts
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    // dismiss without triggering the split escape handler
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    // preserve ordinary modal keys
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const dialog = dialogRef.current;
    // retain focus on the dialog during a fully disabled pending state
    if (dialog === null) return;
    const controls = focusableControls(dialog);
    // use the dialog itself when no action is available
    if (controls.length === 0) {
      dialog.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? controls.indexOf(active) : -1;
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    controls[next]?.focus({ preventScroll: true });
  };

  // stop key releases from reaching global shortcut listeners
  const keyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  // dismiss only direct backdrop clicks
  const backdropClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    // keep card clicks and pending work inside the confirmation
    if (event.target !== event.currentTarget || busy) return;
    cancel();
  };

  return createPortal(
    <div ref={overlayRef} className="split-confirmation-overlay" data-split-confirmation-overlay onClick={backdropClick} onKeyDown={keyDown} onKeyUp={keyUp}>
      <div ref={dialogRef} className={`split-confirmation-card${tone === 'normal' ? ' split-confirmation-normal' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1}>
        <div className="split-confirmation-copy">
          <h2 id={titleId}>{title}</h2>
          <div id={descriptionId} className="split-confirmation-description">{description}</div>
        </div>
        {children}
        <div className="split-confirmation-actions">
          <button ref={cancelRef} type="button" disabled={busy} onClick={cancel}>{cancelLabel}</button>
          <button className={`${tone === 'danger' ? 'danger ' : ''}split-confirmation-confirm${busy ? ` progress-border progress-${tone === 'danger' ? 'red' : 'blue'}` : ''}`} type="button" aria-busy={busy || undefined} disabled={busy || confirmDisabled} onClick={() => { /* act only on explicit confirmation */ void confirm(); }}>{busy && <span className="update-progress-ring" aria-hidden="true" />}{confirmLabel}</button>
        </div>
      </div>
    </div>,
    target
  );
}
