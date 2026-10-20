import type { MouseEvent, PointerEvent } from 'react';

// recognize semantic terminal destinations at panel capture boundaries
const actionableOutputLink = (target: EventTarget | null) => target instanceof Element
  && target.closest('a.output-link-overlay[href]') !== null;

// suppress native middle-paste and autoscroll
export function preserveMiddleClickPress(event: MouseEvent | PointerEvent) {
  // leave other buttons unchanged
  if (event.button !== 1) return;
  // preserve native terminal-link navigation
  if (actionableOutputLink(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

// close only the explicitly targeted split or tab
export function closeOnMiddleClick(event: MouseEvent, close: () => void) {
  // ignore primary and context-menu clicks
  if (event.button !== 1) return;
  // leave actionable terminal links to native middle-click navigation
  if (actionableOutputLink(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  close();
}
