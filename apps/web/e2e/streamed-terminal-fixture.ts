import '@xterm/xterm/css/xterm.css';
import '../src/styles.css';
import type { StreamedTerminalHandle, StreamedTerminalOptions } from '../src/streamed-terminal.js';
import { mountKeptTerminal, releaseKeptTerminal, showKeptWorkspace, type TerminalKeep } from '../src/kept-terminals.js';
import { setTerminalFontSize } from '../src/terminal-font-size.js';
import { setColorTheme } from '../src/color-theme.js';
import { registerKeyAction } from '../src/keyboard.js';
import { measureOutputShape } from '../src/output-skeleton-shape.js';
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
const timedSent: Array<{ at: number; frame: PaneClientFrame }> = [];
const questions: unknown[] = [];
const openedUrls: string[] = [];
let renderTracking: { dispose: () => void } | undefined;
let privateRenderTracking: { dispose: () => void } | undefined;
let domMutationTracking: MutationObserver | undefined;
const trackedRenders: Array<{ at: number; start: number; end: number; domText: string }> = [];
const trackedPrivateRenders: Array<{ at: number; start: number; end: number; domText: string }> = [];
const trackedDomMutations: Array<{ at: number; domText: string }> = [];

const waitFor = async (predicate: () => boolean, timeoutMs = 4000, intervalMs = 10) => {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error('timed out waiting for the streamed terminal');
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }
};

type FixtureOptions = { width?: string; height?: string; scrollback?: number; reconnectDelayMs?: number; upperCaseInput?: boolean; codexScrollControls?: boolean; missingCellMetadata?: boolean; captureOpenUrls?: boolean; captureExit?: boolean; loadingKind?: 'agent' | 'terminal'; loadingAgentKind?: StreamedTerminalOptions['loadingAgentKind']; preferNativeMouseSelection?: boolean; trackAtlasRemovals?: boolean; keep?: TerminalKeep };
let lastOptions: FixtureOptions = {};
// each mount's disposals, by its keep's workspace and panel, so a spec can see exactly-once
const disposals = new Map<string, number>();
const counted = new WeakSet<StreamedTerminalHandle>();
let atlasRemovals = 0;

// mount the scripted pane with optional codex transcript controls
export const renderStreamedTerminal = async (container: HTMLElement, options: FixtureOptions = {}): Promise<void> => {
  sent.length = 0;
  timedSent.length = 0;
  questions.length = 0;
  openedUrls.length = 0;
  connectCount = 0;
  closeCount = 0;
  renderTracking?.dispose();
  renderTracking = undefined;
  privateRenderTracking?.dispose();
  privateRenderTracking = undefined;
  domMutationTracking?.disconnect();
  domMutationTracking = undefined;
  trackedRenders.length = 0;
  trackedPrivateRenders.length = 0;
  trackedDomMutations.length = 0;
  lastOptions = options;
  // observe real public atlas events before the renderer activates
  if (options.trackAtlasRemovals) {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const activate = WebglAddon.prototype.activate;
    // preserve the real renderer while counting shared page removals
    WebglAddon.prototype.activate = function (terminal) {
      activate.call(this, terminal);
      this.onRemoveTextureAtlasCanvas(() => { atlasRemovals += 1; });
    };
  }
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
  // expose the starter variant before output arrives
  ...(options.loadingKind === undefined ? {} : { loadingKind: options.loadingKind }),
  loadingAgentKind: options.loadingAgentKind,
  connect: next => {
    handlers = next;
    connectCount += 1;
    // Open on the next task, as a real socket would.
    setTimeout(() => next.onOpen(), 0);
    return { send: frame => { sent.push(frame); timedSent.push({ at: performance.now(), frame }); }, close: () => { closeCount += 1; } };
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
// claim the same xterm in a new panel, optionally with a newly discovered agent kind
export const showPanel = (id: string, loadingAgentKind = lastOptions.loadingAgentKind): boolean => {
  const previous = handle!.terminal;
  const container = document.createElement('div');
  container.id = id;
  document.body.append(container);
  lastOptions = { ...lastOptions, loadingAgentKind };
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
// inspect the same anonymous geometry captured when leaving a workspace
export const outputShape = () => measureOutputShape(terminal());
export const sentFrames = () => sent.map(frame => frame.type);
// expose the real grid proposed to the fixture transport
export const lastProposedViewport = () => sent.findLast((frame): frame is Extract<PaneClientFrame, { type: 'viewport' }> => frame.type === 'viewport');
export const inputFrameCount = () => sent.filter(frame => frame.type === 'input').length;
export const ackedBytes = () => sent.filter((frame): frame is Extract<PaneClientFrame, { type: 'ack' }> => frame.type === 'ack').map(frame => frame.bytes);
// read the actual DOM renderer rather than xterm's already-parsed buffer
export const renderedDomText = () => host?.querySelector<HTMLElement>('.xterm-rows')?.textContent ?? '';
// count public render events and retain the DOM committed at each event
export const startRenderTracking = () => {
  renderTracking?.dispose();
  privateRenderTracking?.dispose();
  domMutationTracking?.disconnect();
  trackedRenders.length = 0;
  trackedPrivateRenders.length = 0;
  trackedDomMutations.length = 0;
  renderTracking = terminal().onRender(({ start, end }) => {
    trackedRenders.push({ at: performance.now(), start, end, domText: renderedDomText() });
  });
  const renderService = (terminal() as unknown as { _core?: { _renderService?: { onRender?: (listener: (range: { start: number; end: number }) => void) => { dispose: () => void } } } })._core?._renderService;
  // compare xterm's every-paint event with its filtered public viewport event
  if (typeof renderService?.onRender === 'function') privateRenderTracking = renderService.onRender(({ start, end }) => {
    trackedPrivateRenders.push({ at: performance.now(), start, end, domText: renderedDomText() });
  });
  const rows = host?.querySelector('.xterm-rows');
  // timestamp the concrete DOM commit independently of xterm's render events
  if (rows !== null && rows !== undefined) {
    domMutationTracking = new MutationObserver(() => { trackedDomMutations.push({ at: performance.now(), domText: renderedDomText() }); });
    domMutationTracking.observe(rows, { subtree: true, childList: true, characterData: true });
  }
};
// copy public render evidence without exposing the mutable fixture array
export const renderTrace = () => trackedRenders.map(render => ({ ...render }));

// sum transport acknowledgements emitted after one timed-frame index
const acknowledgedSince = (sentIndex: number) => timedSent.slice(sentIndex)
  .filter((event): event is { at: number; frame: Extract<PaneClientFrame, { type: 'ack' }> } => event.frame.type === 'ack')
  .reduce((total, event) => total + event.frame.bytes, 0);

// drive real socket-sized frames at sixty hertz and report parser and paint timing
export const streamPacedFrames = async (frames = 60, durationMs = 1000, scrolling = false) => {
  const encoder = new TextEncoder();
  const sentIndex = timedSent.length;
  const payloads: Uint8Array[] = [];
  const frameSends: Array<{ frame: number; sentAt: number; cumulativeBytes: number }> = [];
  const marker = 'FINAL-PACING-MARKER';
  const startedAt = performance.now();
  let finalPushedAt = startedAt;
  let cumulativeBytes = 0;
  startRenderTracking();
  // deliver every frame at its target wall-clock offset
  for (let frame = 0; frame < frames; frame += 1) {
    const target = startedAt + frame * durationMs / frames;
    const delay = target - performance.now();
    // wait only when the prior callback has not consumed the interval
    if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
    const text = frame === frames - 1 ? marker : `paced-${String(frame).padStart(2, '0')}`;
    // preserve ordinary row-local updates and exercise sustained scrollback separately
    const payload = encoder.encode(scrolling ? `${text}\r\n` : `\r\x1b[2K${text}`);
    payloads.push(payload);
    const sentAt = performance.now();
    handlers?.onBytes(payload);
    cumulativeBytes += payload.length;
    frameSends.push({ frame, sentAt, cumulativeBytes });
    // retain the exact final delivery time for paint latency
    if (frame === frames - 1) finalPushedAt = sentAt;
  }
  const expectedBytes = payloads.reduce((total, payload) => total + payload.length, 0);
  await waitFor(() => acknowledgedSince(sentIndex) >= expectedBytes, 2000);
  await waitFor(() => renderedDomText().includes(marker), 2000);
  // let any duplicate parser callback surface before checking exact totals
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  const acknowledgements = timedSent.slice(sentIndex)
    .filter((event): event is { at: number; frame: Extract<PaneClientFrame, { type: 'ack' }> } => event.frame.type === 'ack');
  let acknowledgedBytes = 0;
  let acknowledgementIndex = 0;
  let acknowledgedAt = startedAt;
  // map each sent frame boundary to the acknowledgement that covered its final byte
  const frameTimings = frameSends.map(frame => {
    while (acknowledgedBytes < frame.cumulativeBytes && acknowledgementIndex < acknowledgements.length) {
      const acknowledgement = acknowledgements[acknowledgementIndex]!;
      acknowledgedBytes += acknowledgement.frame.bytes;
      acknowledgedAt = acknowledgement.at;
      acknowledgementIndex += 1;
    }
    return {
      frame: frame.frame,
      sentAtMs: frame.sentAt - startedAt,
      cumulativeBytes: frame.cumulativeBytes,
      acknowledgedAtMs: acknowledgedAt - startedAt,
      acknowledgementLatencyMs: acknowledgedAt - frame.sentAt
    };
  });
  const acknowledgementLatencies = frameTimings.map(frame => frame.acknowledgementLatencyMs).sort((left, right) => left - right);
  const acknowledgementP95LatencyMs = acknowledgementLatencies[Math.max(0, Math.ceil(acknowledgementLatencies.length * .95) - 1)] ?? 0;
  const acknowledgementMaxLatencyMs = Math.max(0, ...acknowledgementLatencies);
  const markerRender = trackedRenders.find(event => event.at >= finalPushedAt && event.domText.includes(marker));
  const privateMarkerRender = trackedPrivateRenders.find(event => event.at >= finalPushedAt && event.domText.includes(marker));
  const markerMutation = trackedDomMutations.find(event => event.at >= finalPushedAt && event.domText.includes(marker));
  return {
    frames,
    streamDurationMs: finalPushedAt - startedAt,
    expectedBytes,
    acknowledgedBytes: acknowledgements.reduce((total, event) => total + event.frame.bytes, 0),
    acknowledgementEvents: acknowledgements.length,
    finalAckLatencyMs: (acknowledgements.at(-1)?.at ?? finalPushedAt) - finalPushedAt,
    acknowledgementP95LatencyMs,
    acknowledgementMaxLatencyMs,
    frameTimings,
    publicRenderCount: trackedRenders.length,
    // measure committed frame gaps, not only the average render count
    maximumRenderGapMs: Math.max(0, ...trackedRenders.slice(1).map((event, index) => event.at - trackedRenders[index]!.at)),
    privateRenderCount: trackedPrivateRenders.length,
    rowMutationCount: trackedDomMutations.length,
    finalPaintLatencyMs: (markerRender?.at ?? performance.now()) - finalPushedAt,
    markerPainted: markerRender !== undefined,
    privateFinalPaintLatencyMs: (privateMarkerRender?.at ?? performance.now()) - finalPushedAt,
    privateMarkerPainted: privateMarkerRender !== undefined,
    mutationFinalPaintLatencyMs: (markerMutation?.at ?? performance.now()) - finalPushedAt,
    mutationMarkerPainted: markerMutation !== undefined,
    publicRenderTail: trackedRenders.slice(-3).map(event => ({ at: event.at - finalPushedAt, start: event.start, end: event.end, marker: event.domText.includes(marker) })),
    privateRenderTail: trackedPrivateRenders.slice(-3).map(event => ({ at: event.at - finalPushedAt, start: event.start, end: event.end, marker: event.domText.includes(marker) })),
    mutationTail: trackedDomMutations.slice(-3).map(event => ({ at: event.at - finalPushedAt, marker: event.domText.includes(marker) }))
  };
};

// prove terminal input is sent synchronously while a trailing visual frame is pending
export const inputDuringTrailingFrame = async (input: string) => {
  const encoder = new TextEncoder();
  const sentIndex = timedSent.length;
  startRenderTracking();
  const leading = encoder.encode('\r\x1b[2Kpacing-leading');
  handlers?.onBytes(leading);
  await waitFor(() => acknowledgedSince(sentIndex) >= leading.length, 4000, 1);
  await waitFor(() => trackedRenders.length > 0);
  let expectedBytes = leading.length;
  let pendingBeforeInput = false;
  let trailingLabel = '';
  // retry only when a global frame bucket landed during the acknowledgement task
  for (let attempt = 0; attempt < 3 && !pendingBeforeInput; attempt += 1) {
    const label = `pacing-trailing-${attempt}`;
    trailingLabel = label;
    const rendersBeforeTrailing = trackedRenders.length;
    const trailing = encoder.encode(`\r\x1b[2K${label}`);
    expectedBytes += trailing.length;
    handlers?.onBytes(trailing);
    await waitFor(() => acknowledgedSince(sentIndex) >= expectedBytes, 4000, 1);
    pendingBeforeInput = trackedRenders.length === rendersBeforeTrailing && !renderedDomText().includes(label);
    // observe an unusually immediate bucket before attempting the next trailing frame
    if (!pendingBeforeInput) await waitFor(() => renderedDomText().includes(label));
  }
  const beforeInput = performance.now();
  const accepted = handle!.sendInput(input);
  const inputEvent = timedSent.find(event => event.at >= beforeInput && event.frame.type === 'input');
  await waitFor(() => renderedDomText().includes(trailingLabel));
  return {
    accepted,
    pendingBeforeInput,
    sentSynchronously: inputEvent !== undefined,
    sendLatencyMs: (inputEvent?.at ?? performance.now()) - beforeInput,
    inputData: inputData()
  };
};
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
// create a real xterm selection without a synthetic mouse gesture
export const selectCells = (column: number, row: number, length: number) => handle!.terminal.select(column, row, length);
export const scrollUp = (lines: number) => terminal().scrollLines(-lines);
export const jumpHidden = () => root?.querySelector<HTMLButtonElement>('.streamed-terminal-jump')?.hidden ?? true;
export const clickJump = () => root?.querySelector<HTMLButtonElement>('.streamed-terminal-jump')?.click();
export const cols = () => terminal().cols;
export const rows = () => terminal().rows;
// redraw existing cells without changing their contents
export const refreshViewport = () => terminal().refresh(0, terminal().rows - 1);
let atlasResets = 0;
// count public atlas resets that can invalidate a sibling renderer's cached glyphs
export const trackWebglAtlasResets = async () => {
  const { WebglAddon } = await import('@xterm/addon-webgl');
  const clear = WebglAddon.prototype.clearTextureAtlas;
  // preserve real GPU behavior while observing the shared-cache boundary
  WebglAddon.prototype.clearTextureAtlas = function () { atlasResets += 1; clear.call(this); };
};
// expose only the public operation count to the regression
export const webglAtlasResets = () => atlasResets;
// prove the pressure regression actually crossed the public atlas-merge boundary
export const webglAtlasRemovals = () => atlasRemovals;
// re-acquire the glyph atlas through a public theme write, re-uploading every page to the gpu
export const reuploadGlyphAtlas = () => { terminal().options.theme = { ...terminal().options.theme }; };
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
