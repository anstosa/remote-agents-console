import { useEffect } from 'react';

// resolve only controls explicitly marked as popup triggers
const flyoutTrigger = (target: EventTarget | null): HTMLButtonElement | null => {
  // ignore non-element event targets
  if (!(target instanceof Element)) return null;
  // custom buttons own an edit menu and must never execute through a synthetic click
  if (target.closest('.configured-button') !== null) return null;
  const direct = target.closest<HTMLButtonElement>('button[data-context-flyout]');
  // prefer a dropdown button over its surrounding split group
  if (direct !== null) return direct;
  return target.closest('[data-context-dropdown]')?.querySelector<HTMLButtonElement>('button[data-context-flyout]') ?? null;
};

// share right-click opening without invoking split-button primary actions
export function ContextFlyoutEvents() {
  useEffect(() => {
    // preserve the current field and selection before the contextmenu event
    const preserveFocus = (event: MouseEvent) => {
      // leave primary clicks and unrelated controls unchanged
      if (event.button !== 2 || flyoutTrigger(event.target) === null) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // open rather than toggle an already visible popup
    const open = (event: MouseEvent) => {
      const trigger = flyoutTrigger(event.target);
      // leave ordinary browser context menus alone
      if (trigger === null) return;
      event.preventDefault();
      event.stopPropagation();
      // never execute a disabled action or close an open popup
      if (trigger.disabled || trigger.getAttribute('aria-expanded') === 'true') return;
      trigger.click();
    };
    document.addEventListener('pointerdown', preserveFocus, true);
    document.addEventListener('mousedown', preserveFocus, true);
    document.addEventListener('contextmenu', open, true);
    // release the global handlers with their host
    return () => {
      document.removeEventListener('pointerdown', preserveFocus, true);
      document.removeEventListener('mousedown', preserveFocus, true);
      document.removeEventListener('contextmenu', open, true);
    };
  }, []);
  return null;
}
