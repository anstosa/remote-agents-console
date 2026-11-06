import type { Terminal as XTerm } from '@xterm/xterm';

// xterm.js 6.0 has no touch history scrolling of its own, so the console owns it: a
// one-finger drag over a pane with scrollback moves the browser's scrollback. The
// listeners are non-passive so they can swallow the gesture, and the move and end
// listeners sit on the node the finger landed on: scrolling re-renders the selection
// surface's row spans, and the browser keeps sending the rest of a touch to its start
// node even after that node is detached, where a listener on this element never hears it.
// In the alternate screen or while the program tracks the mouse, translate vertical
// drags into wheel events for xterm to encode for the program.
// xterm does not forward touch events itself. A drag that sets off sideways is left to
// the browser too, so it swipes the phone's panel carousel. The wheel stays native
// (xterm handles it with `scrollOnUserInput` off).

const FALLBACK_CELL_HEIGHT = 17;
// how far a finger travels before the drag's direction is decided
const DIRECTION_SLOP = 8;

// route vertical touch gestures to local history or the running program
export const attachTerminalTouchScroll = (element: HTMLElement, terminal: XTerm): (() => void) => {
  const terminalElement = terminal.element;
  // require xterm's wheel target before installing gesture listeners
  if (terminalElement === undefined) throw new Error('open the terminal before attaching touch scrolling');
  let gesture: { id: number; startX: number; startY: number; lastY: number; remainder: number; vertical: boolean } | undefined;

  // preserve both owned native text and xterm-rendered selections
  const hasSelection = () => {
    const selection = window.getSelection();
    return terminal.hasSelection() || (selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode));
  };

  // let xterm encode scrolling for applications that own their viewport
  const scrollsProgram = () =>
    terminal.buffer.active.type === 'alternate' || terminal.modes.mouseTrackingMode !== 'none';

  const cellHeight = () => {
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    const measured = screen && terminal.rows > 0 ? screen.clientHeight / terminal.rows : 0;
    return measured > 0 ? measured : FALLBACK_CELL_HEIGHT;
  };

  // track one finger in both normal and full-screen programs
  const start = (event: TouchEvent) => {
    // leave selection handles and multi-finger gestures to the browser
    if (event.touches.length !== 1 || hasSelection()) { gesture = undefined; follow(undefined); return; }
    const touch = event.touches[0]!;
    gesture = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, lastY: touch.clientY, remainder: 0, vertical: false };
    follow(event.target ?? undefined);
  };

  // consume only direction-locked vertical drags
  const move = (event: TouchEvent) => {
    // ignore untracked or sideways gestures
    if (gesture === undefined) return;
    // hand a long press back to the browser when it creates a selection
    if (hasSelection()) { gesture = undefined; return; }
    const touch = Array.from(event.touches).find(candidate => candidate.identifier === gesture!.id);
    if (touch === undefined) return;
    if (!gesture.vertical) {
      const dx = Math.abs(touch.clientX - gesture.startX);
      const dy = Math.abs(touch.clientY - gesture.startY);
      // too short to tell yet; leave the event alone so a sideways swipe can still start
      if (Math.max(dx, dy) < DIRECTION_SLOP) return;
      if (dx > dy) { gesture = undefined; return; }
      gesture.vertical = true;
    }
    // Dragging the finger down (clientY increasing) reveals older output, i.e. scrolls
    // the buffer up; `scrollLines` counts down as positive.
    gesture.remainder += touch.clientY - gesture.lastY;
    gesture.lastY = touch.clientY;
    const lines = Math.trunc(gesture.remainder / cellHeight());
    // accumulate partial rows without over-scrolling
    if (lines !== 0) {
      gesture.remainder -= lines * cellHeight();
      // preserve xterm's mouse encoding and alternate-screen arrow fallback
      if (scrollsProgram()) {
        // xterm emits one application scroll report per wheel event
        for (let line = 0; line < Math.abs(lines); line += 1) {
          terminalElement.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: touch.clientX,
            clientY: touch.clientY,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            deltaY: -Math.sign(lines)
          }));
        }
      } else {
        terminal.scrollLines(-lines);
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const end = (event: TouchEvent) => {
    if (gesture !== undefined && !Array.from(event.touches).some(candidate => candidate.identifier === gesture!.id)) {
      gesture = undefined;
      follow(undefined);
    }
  };

  const options = { capture: true, passive: false } as const;
  let followed: EventTarget | undefined;
  const follow = (target: EventTarget | undefined) => {
    followed?.removeEventListener('touchmove', move as EventListener, options);
    followed?.removeEventListener('touchend', end as EventListener, options);
    followed?.removeEventListener('touchcancel', end as EventListener, options);
    followed = target;
    followed?.addEventListener('touchmove', move as EventListener, options);
    followed?.addEventListener('touchend', end as EventListener, options);
    followed?.addEventListener('touchcancel', end as EventListener, options);
  };
  element.addEventListener('touchstart', start, options);

  return () => {
    element.removeEventListener('touchstart', start, options);
    follow(undefined);
  };
};
