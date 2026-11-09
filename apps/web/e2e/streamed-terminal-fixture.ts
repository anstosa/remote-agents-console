import '@xterm/xterm/css/xterm.css';
import '../src/styles.css';
import type { StreamedTerminalHandle, StreamedTerminalOptions } from '../src/streamed-terminal.js';
import { mountKeptTerminal, releaseKeptTerminal, showKeptWorkspace, type TerminalKeep } from '../src/kept-terminals.js';
import { setTerminalFontSize } from '../src/terminal-font-size.js';
import { setColorTheme } from '../src/color-theme.js';
import { registerKeyAction } from '../src/keyboard.js';
import type { PaneClientFrame, PaneConnectionHandlers, PaneServerFrame } from '../src/pane-stream.js';

// Mounts the streamed terminal alone in a blank page against real xterm 6.0, driven by
// a scripted socket the spec pushes frames into (following the output-links fixture
// pattern). Nothing here talks to a server; the spec is the server.

let handlers: PaneConnectionHandlers | undefined;
let handle: StreamedTerminalHandle | undefined;
let host: HTMLElement | undefined;
let root: HTMLElement | undefined;
let connectCount = 0;
let closeCount = 0;
const sent: PaneClientFrame[] = [];
const questions: unknown[] = [];
const openedUrls: string[] = [];

const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error('timed out waiting for the streamed terminal');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
};

type FixtureOptions = { width?: string; height?: string; scrollback?: number; reconnectDelayMs?: number; upperCaseInput?: boolean; codexScrollControls?: boolean; missingCellMetadata?: boolean; captureOpenUrls?: boolean; captureExit?: boolean; loadingKind?: 'agent' | 'terminal'; preferNativeMouseSelection?: boolean; keep?: TerminalKeep };
let lastOptions: FixtureOptions = {};
// each mount's disposals, by its keep's workspace and panel, so a spec can see exactly-once
const disposals = new Map<string, number>();
const counted = new WeakSet<StreamedTerminalHandle>();

// mount the scripted pane with optional codex transcript controls
export const renderStreamedTerminal = async (container: HTMLElement, options: FixtureOptions = {}): Promise<void> => {
  sent.length = 0;
  questions.length = 0;
  openedUrls.length = 0;
  connectCount = 0;
  closeCount = 0;
  lastOptions = options;
  mountInto(container, options);
  const mounted = handle!;
  // a reclaimed kept terminal is already counted
  if (!counted.has(mounted)) {
    counted.add(mounted);
    const dispose = mounted.dispose;
    const name = `${options.keep?.workspace}/${options.keep?.panel}`;
    mounted.dispose = () => { disposals.set(name, (disposals.get(name) ?? 0) + 1); dispose(); };
  }
  // emulate an incompatible public-cell metadata interface without changing xterm internals
  if (options.missingCellMetadata) {
    const buffer = mounted.terminal.buffer.active;
    const originalGetLine = buffer.getLine.bind(buffer);
    Object.defineProperty(buffer, 'getLine', { configurable: true, value: (line: number) => {
      const row = originalGetLine(line);
      // preserve absent rows
      if (row === undefined) return undefined;
      return new Proxy(row, {
        get: (target, property) => {
          // hide only the pinned metadata method
          if (property === 'getCell') return (column: number) => {
            const cell = target.getCell(column);
            return cell === undefined ? undefined : new Proxy(cell, { get: (next, name) => name === 'hasExtendedAttrs' ? undefined : Reflect.get(next, name, next) });
          };
          return Reflect.get(target, property, target);
        }
      });
    } });
  }
  await waitFor(() => sent.some(frame => frame.type === 'viewport'));
  container.dataset.ready = 'true';
};

const terminalOptions = (container: HTMLElement, options: FixtureOptions): StreamedTerminalOptions => ({
  scrollback: options.scrollback,
  codexScrollControls: options.codexScrollControls,
  preferNativeMouseSelection: options.preferNativeMouseSelection,
  // Long by default so a status can be asserted before a reconnect fires: only a stream
  // that stayed up this long after its seed reconnects at once, and an `exit` never does.
  reconnectDelayMs: options.reconnectDelayMs ?? 60_000,
  // Stands in for the panel's sticky mobile modifiers so the transform seam is testable.
  transformInput: options.upperCaseInput ? data => data.toUpperCase() : undefined,
  // capture plain-link routing while leaving modified activations on their native path
  onOpenUrl: options.captureOpenUrls ? url => { openedUrls.push(url); return true; } : undefined,
  // stands in for a Terminal panel, which closes on exit
  onExit: options.captureExit ? reason => { container.dataset.exited = reason; } : undefined,
  onQuestion: question => questions.push(question),
  // expose both placeholder variants before output arrives
  ...(options.loadingKind === undefined ? {} : { loadingKind: options.loadingKind }),
  connect: next => {
    handlers = next;
    connectCount += 1;
    // Open on the next task, as a real socket would.
    setTimeout(() => next.onOpen(), 0);
    return { send: frame => { sent.push(frame); }, close: () => { closeCount += 1; } };
  }
});

const mountInto = (container: HTMLElement, options: FixtureOptions) => {
  container.style.width = options.width ?? '640px';
  container.style.height = options.height ?? '320px';
  root = container;
  handle = mountKeptTerminal(options.keep, container, terminalOptions(container, options));
  host = container.querySelector<HTMLElement>('.streamed-terminal-host') ?? undefined;
};

// --- Keep-alive: a panel unmounting as its Workspace is left, and mounting again -------

// the panel unmounts: its container leaves the page and the terminal is released
let left: HTMLElement | undefined;
export const leavePanel = () => { left = root; root!.remove(); releaseKeptTerminal(lastOptions.keep, handle!); };
// what the panel the terminal left still holds: children, classes and pane data attributes
export const leftContainer = () => ({ children: left?.childElementCount, className: left?.className, data: Object.keys(left?.dataset ?? {}).filter(name => name !== 'ready') });
// a panel with the last mount's options mounts in a new container `id`; whether it reclaimed
// the same xterm instance
export const showPanel = (id: string): boolean => {
  const previous = handle!.terminal;
  const container = document.createElement('div');
  container.id = id;
  document.body.append(container);
  mountInto(container, lastOptions);
  return handle!.terminal === previous;
};
const workspaceHides = new Map<string, () => void>();
export const showWorkspace = (workspace: string) => workspaceHides.set(workspace, showKeptWorkspace(workspace));
export const hideWorkspace = (workspace: string) => workspaceHides.get(workspace)?.();
export const disposalsOf = (workspace: string, panel: string) => disposals.get(`${workspace}/${panel}`) ?? 0;
export const closeCalls = () => closeCount;

// --- Drive (server → browser) -------------------------------------------------------

export const pushSize = (cols: number, rows: number) => handlers?.onFrame({ type: 'size', cols, rows });
export const pushBytes = (text: string) => handlers?.onBytes(new TextEncoder().encode(text));
export const pushFrame = (frame: PaneServerFrame) => handlers?.onFrame(frame);
export const pushReseed = () => handlers?.onFrame({ type: 'reseed' });
export const pushExit = (reason: string) => handlers?.onFrame({ type: 'exit', reason });
export const pushClose = (code: number, reason: string) => handlers?.onClose({ code, reason });

// --- Accessors (browser → spec) -----------------------------------------------------

const terminal = () => handle!.terminal;
export const sentFrames = () => sent.map(frame => frame.type);
export const inputFrameCount = () => sent.filter(frame => frame.type === 'input').length;
export const ackedBytes = () => sent.filter((frame): frame is Extract<PaneClientFrame, { type: 'ack' }> => frame.type === 'ack').map(frame => frame.bytes);
export const focusTerminal = () => handle!.focus();
export const blurTerminal = () => (document.activeElement as HTMLElement | null)?.blur();
// record each run of the named key actions, as the app's panel handlers would receive them
const ranKeyActions: string[] = [];
export const recordKeyActions = (...names: string[]) => { for (const name of names) registerKeyAction(name, () => { ranKeyActions.push(name); }); };
export const keyActionsRan = () => [...ranKeyActions];
const decodeInput = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/gu, '+').replace(/_/gu, '/')), character => character.charCodeAt(0)));
export const inputData = () => sent.filter((frame): frame is Extract<PaneClientFrame, { type: 'input' }> => frame.type === 'input').map(frame => decodeInput(frame.data)).join('');
export const connectCalls = () => connectCount;
export const questionsSeen = () => questions;
// report app-owned plain link openings
export const openedUrlList = () => [...openedUrls];
export const sendInputRaw = (text: string) => handle!.sendInput(text);
export const requestMetadata = () => handle!.requestMetadata();
// mirror the app's selection-mode signal without replacing the terminal renderer
export const setOutputPaused = (paused: boolean) => handle!.setOutputPaused(paused);
export const scrollUp = (lines: number) => terminal().scrollLines(-lines);
export const jumpHidden = () => root?.querySelector<HTMLButtonElement>('.streamed-terminal-jump')?.hidden ?? true;
export const clickJump = () => root?.querySelector<HTMLButtonElement>('.streamed-terminal-jump')?.click();
export const cols = () => terminal().cols;
export const rows = () => terminal().rows;
export const viewportY = () => terminal().buffer.active.viewportY;
export const baseY = () => terminal().buffer.active.baseY;
export const alternateScreen = () => terminal().buffer.active.type === 'alternate';
// report the active terminal mouse mode
export const mouseTrackingMode = () => terminal().modes.mouseTrackingMode;
export const terminalMounted = () => host?.querySelector('.xterm') !== null;
// the DOM renderer draws `.xterm-rows`; the WebGL renderer draws canvases in its place
export const rendererKind = (): 'dom' | 'webgl' | 'none' =>
  host?.querySelector('.xterm-rows') ? 'dom' : host?.querySelector('.xterm-screen canvas') ? 'webgl' : 'none';
// drop the WebGL context as a GPU reset would; null when no canvas holds one
export const loseWebglContext = (): boolean => {
  for (const canvas of host?.querySelectorAll('canvas') ?? []) {
    const gl = canvas.getContext('webgl2');
    const lose = gl?.getExtension('WEBGL_lose_context');
    if (lose) { lose.loseContext(); return true; }
  }
  return false;
};

export const screenText = (): string => {
  const buffer = terminal().buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  return lines.join('\n');
};

export const screenWidth = () => host?.querySelector<HTMLElement>('.xterm-screen')?.clientWidth ?? 0;
export const hostWidth = () => host?.clientWidth ?? 0;
// The colour an operator actually sees in the letterbox strip below the last row: the
// topmost opaque element at the host's bottom-centre. When the pane is shorter than the
// panel this is the letterbox; it must show the terminal background, not xterm's
// hardcoded-black `.xterm-viewport`.
export const letterboxStripColor = (): string => {
  const rect = host!.getBoundingClientRect();
  const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.bottom - 4);
  for (const element of stack) {
    const color = getComputedStyle(element).backgroundColor;
    if (color !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)/u.test(color)) return color;
  }
  return '(none opaque)';
};
// The palette's `--base`, resolved — the terminal-theme background every pane paints.
export const themeBaseColor = (): string => {
  const probe = document.createElement('div');
  probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--base').trim();
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
};
// xterm 6.0 paints the theme background onto `.xterm-scrollable-element`'s inline style
// (`.xterm-viewport` is now a static-black overview-ruler sibling), so read that.
export const scrollableBackground = () => host?.querySelector<HTMLElement>('.xterm-scrollable-element')?.style.backgroundColor ?? '';
export const fontSizePx = () => terminal().options.fontSize;
export const themeBackground = () => terminal().options.theme?.background ?? '';
export const activeIsTerminalTextarea = () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false;

// --- Store mutators, exercised live -------------------------------------------------

export const setFont = (px: number) => setTerminalFontSize(px);
export const setTheme = (theme: 'mocha' | 'latte') => setColorTheme(theme);

// --- Touch simulation ---------------------------------------------------------------

const makeTouch = (clientX: number, clientY: number) =>
  new Touch({ identifier: 1, target: host!, clientX, clientY, pageX: clientX, pageY: clientY });

// `touches` is the set still down; `changed` the ones this event is about. A touchend
// carries the lifted finger in `changed` at its final position, with `touches` empty.
const dispatchTouch = (type: string, touches: Touch[], changed: Touch[]): boolean => {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: changed });
  return host!.dispatchEvent(event);
};

// drag one finger by the requested offsets
export const touchGesture = (deltaX: number, deltaY: number): boolean => {
  const box = host!.getBoundingClientRect();
  const startX = box.left + box.width / 2;
  const startY = box.top + box.height / 2;
  const start = makeTouch(startX, startY);
  const moved = makeTouch(startX + deltaX, startY + deltaY);
  dispatchTouch('touchstart', [start], [start]);
  const notPrevented = dispatchTouch('touchmove', [moved], [moved]);
  dispatchTouch('touchend', [], [moved]);
  return !notPrevented;
};

// drag vertically; positive reveals older history
export const touchDrag = (deltaY: number): boolean => touchGesture(0, deltaY);

// A touch that starts and ends without a click, as a scroll gesture or a browser-suppressed
// tap does. iOS only raises the soft keyboard for a focus made from the synthesized click, so
// this must not focus the terminal.
export const touchOnly = () => {
  const box = host!.getBoundingClientRect();
  const point = makeTouch(box.left + box.width / 2, box.top + box.height / 2);
  dispatchTouch('touchstart', [point], [point]);
  dispatchTouch('touchend', [], [point]);
};

// Tap once at the terminal's centre — the full sequence a genuine tap produces, ending in
// the synthesized click the browser fires when the gesture was neither a scroll nor a long
// press. The console focuses on that click, which is what raises the mobile keyboard; the
// focus handler ignores the pointer coordinates, so a bare click stands in for it.
export const tap = () => {
  touchOnly();
  host!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
