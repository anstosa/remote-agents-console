import type { Terminal as XTerm } from '@xterm/xterm';
import { observeHighVolumePresentation, scheduleVisualFrame, sparseVisualFrame, visualFrameIntervalMs } from './visual-frame-clock.js';

const minimumDispatchIntervalMs = visualFrameIntervalMs - 20;
const rapidScrollCount = 6;
const rapidScrollWindowMs = 150;
const scrollQuietMs = 75;

type PinnedRenderDebouncer = {
  _animationFrame?: number;
  refresh: (rowStart: number | undefined, rowEnd: number | undefined, rowCount: number) => void;
  addRefreshCallback: (callback: FrameRequestCallback) => number;
};
type PinnedViewport = { _sync: (ydisp?: number) => void; queueSync: () => void };
type SelectionPosition = [number, number] | undefined;
type PinnedSelectionState = { start: SelectionPosition; end: SelectionPosition; columnSelectMode: boolean };
type PinnedSelectionService = { selectionStart: SelectionPosition; selectionEnd: SelectionPosition; refresh: (isLinuxMouseSelection?: boolean) => void };

export type TerminalRenderPacing = Readonly<{
  active: boolean;
  flush: () => void;
  restore: () => void;
  dispose: () => void;
}>;

const inactivePacing: TerminalRenderPacing = Object.freeze({
  active: false,
  flush: () => {},
  restore: () => {},
  dispose: () => {}
});
const installedPacing = new WeakMap<object, TerminalRenderPacing>();

// avoid drawing the temporary dom renderer which can never be revealed before webgl settles
export const suppressCoveredDomRows = (terminal: XTerm): (() => void) => {
  const runtime = terminal as unknown as { _core?: { _renderService?: { _renderer?: { value?: { renderRows?: (start: number, end: number) => void } } } } };
  const renderer = runtime._core?._renderService?._renderer?.value;
  const renderRows = renderer?.renderRows;
  // fail open if this pinned runtime no longer has the temporary dom renderer seam
  if (renderer === undefined || typeof renderRows !== 'function' || terminal.element?.querySelector('.xterm-rows') == null) return () => {};
  // keep renderer dimensions and native render callbacks available for the initial viewport handshake
  const coveredRenderRows = () => {};
  renderer.renderRows = coveredRenderRows;
  // the settled renderer must draw the first real seed on its normal full refresh
  return () => {
    if (renderer.renderRows === coveredRenderRows) renderer.renderRows = renderRows;
  };
};

// pace xterm's pinned render debouncer without delaying parsing or acknowledgements
export const createTerminalRenderPacing = (terminal: XTerm): TerminalRenderPacing => {
  const runtime = terminal as unknown as { _core?: {
    _renderService?: {
      _renderDebouncer?: Partial<PinnedRenderDebouncer>;
      _selectionState?: PinnedSelectionState;
      handleSelectionChanged?: (start: SelectionPosition, end: SelectionPosition, columnSelectMode: boolean) => void;
    };
    _viewport?: Partial<PinnedViewport>;
    _selectionService?: Partial<PinnedSelectionService>;
    _bufferService?: { isUserScrolling?: boolean };
  } };
  const renderService = runtime._core?._renderService;
  const candidate = renderService?._renderDebouncer;
  // fail open when the pinned xterm runtime no longer exposes the expected seam
  if (candidate === undefined || typeof candidate.refresh !== 'function' || typeof candidate.addRefreshCallback !== 'function') return inactivePacing;
  const debouncer = candidate as PinnedRenderDebouncer;
  const existing = installedPacing.get(debouncer);
  // reuse the one adapter already owning this terminal's native debouncer
  if (existing !== undefined) return existing;
  const originalRefresh = debouncer.refresh;
  const originalAddRefreshCallback = debouncer.addRefreshCallback;
  const originalSelectionChanged = renderService?.handleSelectionChanged;
  const selectionService = runtime._core?._selectionService;
  const originalSelectionRefresh = selectionService?.refresh;
  const viewport = runtime._core?._viewport;
  const bufferService = runtime._core?._bufferService;
  const originalViewportSync = viewport?._sync;
  const view = terminal.element?.ownerDocument.defaultView ?? window;
  let lastDispatch = Number.NEGATIVE_INFINITY;
  let cancelFrame: (() => void) | undefined;
  let queuedToken = 0;
  let pendingRefresh = false;
  let pendingStart = 0;
  let pendingEnd = 0;
  let pendingRowCount = 0;
  let pendingCallbacks: FrameRequestCallback[] = [];
  let ended = false;
  let viewportSyncPending = false;
  const recentFollowScrolls: number[] = [];
  let quietTailTimer: number | undefined;
  let previousCursorRow = terminal.buffer.active.cursorY;
  let previousBufferType = terminal.buffer.active.type;

  // identify sustained bottom-follow scrolling, not individual edits or user scrolling
  const rapidFollowScroll = () => {
    const last = recentFollowScrolls.at(-1);
    return !ended && recentFollowScrolls.length === rapidScrollCount && terminal.modes.synchronizedOutputMode === false && last !== undefined
      && last - recentFollowScrolls[0]! <= rapidScrollWindowMs
      && view.performance.now() - last < scrollQuietMs;
  };
  const releaseHighVolumePresentation = observeHighVolumePresentation(rapidFollowScroll);

  // count newly appended rows even before the first real viewport scroll
  const noteFollowLines = (count: number) => {
    const now = view.performance.now();
    // retain a small fixed history regardless of the output batch size
    for (let index = 0; index < Math.min(count, rapidScrollCount); index += 1) {
      if (recentFollowScrolls.length === rapidScrollCount) recentFollowScrolls.shift();
      recentFollowScrolls.push(now);
    }
  };

  // recognize ordinary forward line output separately from cursor-only updates
  const noteCursorAdvance = () => {
    const buffer = terminal.buffer.active;
    const delta = buffer.cursorY - previousCursorRow;
    // buffer switches and synchronized output must not inherit a prior burst
    if (buffer.type !== previousBufferType || terminal.modes.synchronizedOutputMode !== false) recentFollowScrolls.length = 0;
    else if (buffer.type === 'normal' && buffer.viewportY === buffer.baseY && delta > 0 && delta <= 8) noteFollowLines(delta);
    previousCursorRow = buffer.cursorY;
    previousBufferType = buffer.type;
  };

  // xterm asks the renderer to redraw selection on every scroll even with no selection
  const deduplicateEmptySelection = (start: SelectionPosition, end: SelectionPosition, columnSelectMode: boolean) => {
    const state = renderService?._selectionState;
    // keep real starts, selections and clears synchronous; only repeated empty output is redundant
    if (state !== undefined && start === undefined && end === undefined && state.start === undefined && state.end === undefined) {
      state.columnSelectMode = columnSelectMode;
      return;
    }
    originalSelectionChanged?.call(renderService, start, end, columnSelectMode);
  };
  // the DOM renderer otherwise draws the whole viewport directly, outside its render debouncer
  if (renderService && typeof originalSelectionChanged === 'function' && typeof renderService._selectionState?.columnSelectMode === 'boolean') {
    renderService.handleSelectionChanged = deduplicateEmptySelection;
  }

  // avoid scheduling a native animation frame for an already empty selection
  const skipEmptySelectionRefresh = (isLinuxMouseSelection?: boolean) => {
    const state = renderService?._selectionState;
    // preserve mouse selection notifications, partial starts and pending clears
    if (!isLinuxMouseSelection && state !== undefined && state.start === undefined && state.end === undefined
      && selectionService?.selectionStart === undefined && selectionService?.selectionEnd === undefined) return;
    originalSelectionRefresh?.call(selectionService, isLinuxMouseSelection);
  };
  // guard the pinned public selection getters before suppressing redundant scroll refreshes
  if (selectionService && typeof originalSelectionRefresh === 'function'
    && 'selectionStart' in selectionService && 'selectionEnd' in selectionService
    && typeof renderService?._selectionState?.columnSelectMode === 'boolean') {
    selectionService.refresh = skipEmptySelectionRefresh;
  }

  // coalesce xterm 6's duplicate bottom-follow scrollbar sync into its existing refresh callback
  const pacedViewportSync = function (this: Partial<PinnedViewport>, ...args: [number?]): void {
    // explicit refresh callbacks and user-controlled scrollback retain native synchronous behavior
    if (args.length !== 0 || bufferService?.isUserScrolling !== false) {
      viewportSyncPending = false;
      // user-controlled scrollback bypasses the high-output presentation cadence
      if (bufferService?.isUserScrolling) {
        recentFollowScrolls.length = 0;
        dispatch();
        lastDispatch = Number.NEGATIVE_INFINITY;
      }
      originalViewportSync?.apply(this, args);
      return;
    }
    // retain only enough timestamps to distinguish rapid output from ordinary typing
    if (terminal.modes.synchronizedOutputMode !== false) recentFollowScrolls.length = 0;
    else noteFollowLines(1);
    viewportSyncPending = true;
    this.queueSync?.();
  };
  // fail open for any xterm viewport layout other than the pinned contract
  if (viewport && typeof originalViewportSync === 'function' && typeof viewport.queueSync === 'function' && typeof bufferService?.isUserScrolling === 'boolean') {
    viewport._sync = pacedViewportSync;
  }

  // refresh the scrollbar before an actual pointer, input or geometry action uses its range
  const flushViewport = () => {
    if (!viewportSyncPending) return;
    viewportSyncPending = false;
    originalViewportSync?.call(viewport);
  };

  // send the accumulated range and callbacks through one native xterm animation frame
  const dispatch = (markDispatch = true) => {
    // cancel the trailing timer before handing work to the native debouncer
    cancelFrame?.();
    cancelFrame = undefined;
    // a delivered frame no longer needs a trailing quiet-tail check
    if (quietTailTimer !== undefined) view.clearTimeout(quietTailTimer);
    quietTailTimer = undefined;
    // leave empty flushes inert
    if (!pendingRefresh && pendingCallbacks.length === 0) return;
    const refresh = pendingRefresh;
    const start = pendingStart;
    const end = pendingEnd;
    const rowCount = pendingRowCount;
    const callbacks = pendingCallbacks;
    pendingRefresh = false;
    pendingCallbacks = [];
    // retain the leading/trailing cadence only when starting a new native frame
    if (markDispatch) lastDispatch = view.performance.now();
    // queue rows before callbacks so xterm preserves its render-then-callback contract
    if (refresh) originalRefresh.call(debouncer, start, end, rowCount);
    // attach every callback to that same native frame
    for (const callback of callbacks) originalAddRefreshCallback.call(debouncer, callback);
  };

  // finish the last output promptly rather than waiting an extra high-volume display cycle
  const scheduleQuietTail = () => {
    // one timer follows the current burst without a timer allocation per output line
    if (quietTailTimer !== undefined) return;
    const latest = recentFollowScrolls.at(-1) ?? view.performance.now();
    const delay = Math.max(1, latest + scrollQuietMs - view.performance.now());
    quietTailTimer = view.setTimeout(() => {
      quietTailTimer = undefined;
      // keep an ongoing burst on the shared visual cadence
      if (rapidFollowScroll()) scheduleQuietTail();
      else {
        recentFollowScrolls.length = 0;
        flushViewport();
        dispatch();
        lastDispatch = Number.NEGATIVE_INFINITY;
      }
    }, delay);
  };

  // arm one bounded trailing dispatch for pending work
  const schedule = () => {
    // retain the existing deadline when more work joins the pending frame
    if (cancelFrame === undefined) {
      queuedToken += 1;
      cancelFrame = scheduleVisualFrame(frame => {
        cancelFrame = undefined;
        // fast scrolling uses sparse shared pulses while parsing every incoming byte
        if (rapidFollowScroll() && !sparseVisualFrame(frame)) {
          schedule();
          scheduleQuietTail();
        } else dispatch();
      });
    }
    // pinned xterm uses this value only as a nonundefined callback sentinel
    return queuedToken;
  };

  // merge one dirty range without losing a resize's latest row count
  const accumulateRefresh = (rowStart: number | undefined, rowEnd: number | undefined, rowCount: number) => {
    const start = rowStart ?? 0;
    const end = rowEnd ?? rowCount - 1;
    // initialize the first pending range
    if (!pendingRefresh) {
      pendingRefresh = true;
      pendingStart = start;
      pendingEnd = end;
    } else {
      pendingStart = Math.min(pendingStart, start);
      pendingEnd = Math.max(pendingEnd, end);
    }
    pendingRowCount = rowCount;
  };

  // preserve xterm's native coalescing when a frame is already scheduled
  const pacedRefresh: PinnedRenderDebouncer['refresh'] = (rowStart, rowEnd, rowCount) => {
    noteCursorAdvance();
    // merge directly into an existing native frame
    if (debouncer._animationFrame !== undefined) {
      accumulateRefresh(rowStart, rowEnd, rowCount);
      dispatch(false);
      return;
    }
    const now = view.performance.now();
    // render the leading edge immediately after an idle interval
    if (cancelFrame === undefined && now - lastDispatch >= minimumDispatchIntervalMs && !rapidFollowScroll()) {
      lastDispatch = now;
      originalRefresh.call(debouncer, rowStart, rowEnd, rowCount);
      return;
    }
    accumulateRefresh(rowStart, rowEnd, rowCount);
    schedule();
  };

  // keep viewport and decoration callbacks on the same paced frame as their rows
  const pacedAddRefreshCallback: PinnedRenderDebouncer['addRefreshCallback'] = callback => {
    // join pending rows and the callback to an already scheduled native frame
    if (debouncer._animationFrame !== undefined) {
      const animationFrame = debouncer._animationFrame;
      pendingCallbacks.push(callback);
      dispatch(false);
      return animationFrame;
    }
    const now = view.performance.now();
    // preserve callback-only leading frames after an idle interval
    if (cancelFrame === undefined && !pendingRefresh && pendingCallbacks.length === 0 && now - lastDispatch >= minimumDispatchIntervalMs && !rapidFollowScroll()) {
      lastDispatch = now;
      return originalAddRefreshCallback.call(debouncer, callback);
    }
    pendingCallbacks.push(callback);
    return schedule();
  };

  debouncer.refresh = pacedRefresh;
  debouncer.addRefreshCallback = pacedAddRefreshCallback;

  // flush pending visual work without disabling subsequent pacing
  const flush = () => {
    // ignore calls after the adapter has released the runtime seam
    if (ended) return;
    // start interactive presentation outside any prior high-volume scroll burst
    recentFollowScrolls.length = 0;
    previousCursorRow = terminal.buffer.active.cursorY;
    previousBufferType = terminal.buffer.active.type;
    flushViewport();
    dispatch();
    // the next interactive response is also eligible for a leading frame
    lastDispatch = Number.NEGATIVE_INFINITY;
  };

  // restore native scheduling after delivering any pending visual work
  const restore = () => {
    // keep restoration idempotent
    if (ended) return;
    flushViewport();
    dispatch();
    ended = true;
    releaseHighVolumePresentation();
    // avoid overwriting a later owner of the pinned seam
    if (debouncer.refresh === pacedRefresh) debouncer.refresh = originalRefresh;
    if (debouncer.addRefreshCallback === pacedAddRefreshCallback) debouncer.addRefreshCallback = originalAddRefreshCallback;
    // restore only the selection refresh seam still held by this adapter
    if (originalSelectionRefresh && selectionService?.refresh === skipEmptySelectionRefresh) selectionService.refresh = originalSelectionRefresh;
    // restore only the selection seam still held by this adapter
    if (originalSelectionChanged && renderService?.handleSelectionChanged === deduplicateEmptySelection) renderService.handleSelectionChanged = originalSelectionChanged;
    // restore only the viewport seam still owned by this adapter
    if (originalViewportSync && viewport?._sync === pacedViewportSync) viewport._sync = originalViewportSync;
    installedPacing.delete(debouncer);
  };

  // release pacing without scheduling work on a terminal being destroyed
  const dispose = () => {
    // keep disposal idempotent
    if (ended) return;
    ended = true;
    releaseHighVolumePresentation();
    // cancel owned timers and references before xterm disposes its renderer
    cancelFrame?.();
    cancelFrame = undefined;
    if (quietTailTimer !== undefined) view.clearTimeout(quietTailTimer);
    quietTailTimer = undefined;
    pendingRefresh = false;
    pendingCallbacks = [];
    // avoid overwriting a later owner of the pinned seam
    if (debouncer.refresh === pacedRefresh) debouncer.refresh = originalRefresh;
    if (debouncer.addRefreshCallback === pacedAddRefreshCallback) debouncer.addRefreshCallback = originalAddRefreshCallback;
    // restore the native selection refresh before releasing the adapter
    if (originalSelectionRefresh && selectionService?.refresh === skipEmptySelectionRefresh) selectionService.refresh = originalSelectionRefresh;
    // restore native selection behavior before the terminal is disposed
    if (originalSelectionChanged && renderService?.handleSelectionChanged === deduplicateEmptySelection) renderService.handleSelectionChanged = originalSelectionChanged;
    // release the viewport seam without performing work on a destroyed terminal
    if (originalViewportSync && viewport?._sync === pacedViewportSync) viewport._sync = originalViewportSync;
    installedPacing.delete(debouncer);
  };

  const pacing: TerminalRenderPacing = {
    get active() { return !ended; },
    flush,
    restore,
    dispose
  };
  installedPacing.set(debouncer, pacing);
  return pacing;
};
