import { useEffect, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

// share outside-press blocking with nested flyout pages
export function FlyoutBackdrop({ onDismiss }: { onDismiss: () => void }) {
  // keep early press events away from document handlers
  const blockPress = (event: SyntheticEvent) => { event.stopPropagation(); };
  // consume the completed outside interaction
  const dismiss = (event: SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); onDismiss(); };
  return <div className="flyout-backdrop" aria-hidden="true" onPointerDown={blockPress} onMouseDown={blockPress} onClick={dismiss} onContextMenu={dismiss} />;
}

// render one click-through-blocking flyout portal
export function FlyoutPortal({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  useEffect(() => {
    // dismiss the active flyout from the keyboard
    const dismissOnEscape = (event: KeyboardEvent) => {
      // preserve nested escape handlers and ignore unrelated keys
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener('keydown', dismissOnEscape);
    return () => document.removeEventListener('keydown', dismissOnEscape);
  }, [onDismiss]);
  return createPortal(<><FlyoutBackdrop onDismiss={onDismiss} />{children}</>, document.body);
}
