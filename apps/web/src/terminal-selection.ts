import type { StreamedTerminalHandle } from './streamed-terminal.js';
import { computeTerminalTheme } from './terminal-theme.js';
import { subscribeTerminalFontSize } from './terminal-font-size.js';
import { registerKeyAction, type KeyActionContext } from './keyboard.js';

export type TerminalSelection = { text: string; top: number; left: number };

export type TerminalSelectionController = {
  copy: (value: string) => Promise<void>;
  // the toolbar's Copy: copy, flash, then drop the selection
  copyThenClear: (value: string) => Promise<void>;
  // drop the selection once a selection action is done
  clear: () => void;
  getSelectedText: () => string;
  selectAll: () => void;
  setMode: (mode: 'prompt' | 'output' | 'selection') => void;
  dispose: () => void;
};

type TerminalSelectionOptions = {
  onSelection: (selection: TerminalSelection | undefined) => void;
  onSelectionModeChange?: (active: boolean) => void;
  copyText: (value: string) => Promise<void>;
  // omit a terminal gutter only from clipboard copies
  copyLeadingColumns?: number;
  flashElement: HTMLElement;
  copyFlashMs: number;
};

const selectionContainers = new Set<HTMLElement>();
// the share of a pane that must show for it to count as on screen
const minimumInViewRatio = 0.01;
let shortcutOwner: HTMLElement | undefined;

// resolve text-node event targets to their parent element
const eventTargetElement = (target: EventTarget | null): Element | null => {
  // preserve element targets directly
  if (target instanceof Element) return target;
  // map browser text targets back to their containing element
  if (target instanceof Node) return target.parentElement;
  return null;
};

// preserve logical lines when a native range crosses terminal soft wraps
const projectedSelectionText = (selection: Selection | null, terminal: StreamedTerminalHandle['terminal'], leadingColumns = 0): string | undefined => {
  // let other browser selections retain their ordinary clipboard behavior
  if (selection === null || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const rowSelector = leadingColumns > 0 ? '.terminal-selection-row, .xterm-accessibility-tree > [role="listitem"]' : '.terminal-selection-row';
  const firstRow = eventTargetElement(range.startContainer)?.closest<HTMLElement>(rowSelector);
  const lastRow = eventTargetElement(range.endContainer)?.closest<HTMLElement>(rowSelector);
  // retain the existing behavior for ranges spanning other panes or surrounding ui
  if (firstRow == null || lastRow == null || firstRow.parentElement === null || firstRow.parentElement !== lastRow.parentElement) return undefined;
  let text = '';
  let row: Element | null = firstRow;
  let bufferRow = terminal.buffer.active.viewportY + Array.from(firstRow.parentElement.children).indexOf(firstRow);
  // accessibility rows publish their absolute buffer position for scrollback selections
  if (firstRow.hasAttribute('aria-posinset')) bufferRow = Number(firstRow.getAttribute('aria-posinset')) - 1;
  // serialize only selected characters and explicit hard line breaks
  while (row !== null) {
    const line = terminal.buffer.active.getLine(bufferRow);
    const part = document.createRange();
    part.selectNodeContents(row);
    // trim the first physical row to the selection's starting character
    if (row === firstRow) part.setStart(range.startContainer, range.startOffset);
    // trim the last physical row to the selection's ending character
    if (row === lastRow) part.setEnd(range.endContainer, range.endOffset);
    const wrapped = row.hasAttribute('data-wrapped') ? row.getAttribute('data-wrapped') === 'true' : line?.isWrapped === true;
    // wrapped continuations belong to the previous logical line
    if (row !== firstRow && !wrapped) text += '\n';
    let selected = part.toString();
    // intersect the selected characters with the physical row's retained columns
    if (leadingColumns > 0) {
      const prefix = document.createRange();
      prefix.selectNodeContents(row);
      prefix.setEnd(part.startContainer, part.startOffset);
      const omittedLength = line?.translateToString(false, 0, leadingColumns).length ?? 0;
      selected = selected.slice(Math.max(0, omittedLength - prefix.toString().length));
    }
    text += selected;
    // stop after the ordered range endpoint, including reverse mouse selections
    if (row === lastRow) return text;
    row = row.nextElementSibling;
    bufferRow += 1;
  }
  return undefined;
};

// copy terminal cells without changing the selected range or splitting unicode glyphs
const terminalSelectionText = (terminal: StreamedTerminalHandle['terminal'], leadingColumns: number, rectangularSelection: boolean | undefined): string => {
  const selected = terminal.getSelection();
  const position = terminal.getSelectionPosition();
  // retain ordinary terminal copying and empty selections
  if (leadingColumns === 0 || position === undefined) return selected;
  const newline = selected.includes('\r\n') ? '\r\n' : '\n';
  // serialize both forms because the public selection range does not expose rectangular mode
  const readRange = (rectangular: boolean) => {
    let original = '';
    let copied = '';
    // preserve physical-row boundaries before joining soft wraps
    for (let row = position.start.y; row <= position.end.y; row += 1) {
      const line = terminal.buffer.active.getLine(row);
      // a lost buffer row cannot safely be reconstructed
      if (line === undefined) return undefined;
      let start = row === position.start.y ? position.start.x : 0;
      let end = row === position.end.y ? position.end.x : line.length;
      // rectangular rows share the same selected column interval
      if (rectangular) {
        start = Math.min(position.start.x, position.end.x);
        end = Math.max(position.start.x, position.end.x);
      }
      // rectangular selections keep each row separate even through soft wraps
      if (row !== position.start.y && (rectangular || !line.isWrapped)) {
        original += newline;
        copied += newline;
      }
      const text = line.translateToString(true, start, end);
      const omittedLength = line.translateToString(false, start, Math.min(end, Math.max(start, leadingColumns))).length;
      original += text;
      copied += text.slice(omittedLength);
    }
    return { original: original.replace(/\u00a0/gu, ' '), copied: copied.replace(/\u00a0/gu, ' ') };
  };
  const linear = readRange(false);
  const rectangular = readRange(true);
  const expected = rectangularSelection ? rectangular : linear;
  // prefer the observed gesture when both selection shapes contain identical text
  if (rectangularSelection !== undefined && expected?.original === selected) return expected.copied;
  // preserve ambiguous programmatic selections rather than removing unselected columns
  if (linear?.original === selected) return rectangular?.original === selected && rectangular.copied !== linear.copied ? selected : linear.copied;
  return rectangular?.original === selected ? rectangular.copied : selected;
};

// identify fields that own ordinary typing
const isEditableTarget = (target: Element | null): boolean => {
  // treat form controls as editable surfaces
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
};

// reject panes hidden by desktop or mobile layout rules
const containerIsVisible = (container: HTMLElement): boolean => {
  // reject detached and semantically hidden terminals
  if (!container.isConnected || container.closest('[hidden], [aria-hidden="true"]') !== null) return false;
  const style = window.getComputedStyle(container);
  // reject stylesheet-hidden terminals and ancestors
  return style.visibility !== 'hidden' && style.display !== 'none' && container.getClientRects().length > 0;
};

// find which registered terminal owns one selection endpoint
const selectionEndpointOwner = (node: Node | null): HTMLElement | undefined => {
  // prefer the first containing terminal
  for (const candidate of selectionContainers) {
    // return the endpoint's terminal
    if (node !== null && candidate.contains(node)) return candidate;
  }
  return undefined;
};

// attach selection freezing, actions and copy feedback to one terminal
export function attachTerminalSelection(container: HTMLElement, handle: StreamedTerminalHandle, options: TerminalSelectionOptions): TerminalSelectionController {
  const terminal = handle.terminal;
  const terminalScreen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  let disposed = false;
  let nativeSelectionWasActive = false;
  let mouseSelectionGesture = false;
  let pinnedSelectionMode = false;
  let rectangularSelection: boolean | undefined;
  let linkSelectionOrigin: { node: Node; offset: number; x: number; y: number } | undefined;
  let linkSelectionDragged = false;
  let copiedSelectionTimer: number | undefined;
  let terminalThemeFlashed = false;
  // a toolbar Copy drops the selection once its copied flash has shown
  let clearAfterFlash = false;
  // whether the pane is on screen; the view observer below keeps it current
  let inView = true;
  const paneIsVisible = () => inView && containerIsVisible(container);
  selectionContainers.add(container);

  // freeze rendering and publish the same mode throughout a selection gesture
  const setSelectionMode = (active: boolean) => {
    handle.setOutputPaused(active);
    options.onSelectionModeChange?.(active);
  };

  // Drop xterm's selection by replacing it with an empty range, never with clearSelection(): told
  // there is no selection, xterm's DOM renderer keeps the last range it drew and repaints it on
  // the next resize, so a pane that loses its selection and then resizes (restoring a fullscreen
  // panel does both) shows a ghost highlight. An empty range resets what it draws. It notifies
  // selection listeners only when a selection existed.
  const dropTerminalSelection = () => terminal.select(0, 0, 0);

  // scope the browser selection to one terminal
  const nativeSelectionActive = (): boolean => {
    const selection = window.getSelection();
    // ignore empty browser selections
    if (selection === null || selection.isCollapsed) return false;
    const anchorOwner = selectionEndpointOwner(selection.anchorNode);
    // make cross-pane selections belong to their starting pane
    if (anchorOwner !== undefined) return anchorOwner === container;
    return selection.focusNode !== null && container.contains(selection.focusNode);
  };

  // place the toolbar below the selection's end; CSS keeps it horizontally on screen
  const toolbarPosition = (bottom: number, right: number): Pick<TerminalSelection, 'top' | 'left'> => {
    const maximumTop = Math.max(8, window.innerHeight - 48);
    return { top: Math.max(8, Math.min(maximumTop, bottom + 8)), left: right };
  };

  // restore a flashed xterm palette only outside native selection mode
  const restoreTerminalTheme = () => {
    // preserve the flash and avoid repainting browser-owned selection nodes
    if (!terminalThemeFlashed || copiedSelectionTimer !== undefined || nativeSelectionActive()) return;
    terminal.options.theme = computeTerminalTheme();
    terminalThemeFlashed = false;
  };

  // flash both native and terminal-rendered selections after copying
  const flashCopiedSelection = () => {
    // ignore late clipboard completions
    if (disposed) return;
    options.flashElement.classList.add('selection-copied');
    const flashTerminalSelection = terminal.hasSelection() && !nativeSelectionActive();
    // repaint only xterm-rendered selections
    if (flashTerminalSelection) {
      const theme = computeTerminalTheme();
      terminal.options.theme = { ...theme, selectionBackground: theme.green, selectionInactiveBackground: theme.green };
      terminalThemeFlashed = true;
    }
    // restart the flash when another copy completes
    if (copiedSelectionTimer !== undefined) window.clearTimeout(copiedSelectionTimer);
    // restore the current palette without clearing the copied selection
    copiedSelectionTimer = window.setTimeout(() => {
      copiedSelectionTimer = undefined;
      options.flashElement.classList.remove('selection-copied');
      restoreTerminalTheme();
      if (clearAfterFlash) clear();
    }, options.copyFlashMs);
  };

  // copy one selection and acknowledge successful writes
  const copy = async (value: string): Promise<void> => {
    const leadingColumns = options.copyLeadingColumns ?? 0;
    const text = leadingColumns > 0 && (nativeSelectionActive() || terminal.hasSelection()) ? selectedOutput(leadingColumns) : value;
    await options.copyText(text);
    // suppress effects after disposal
    if (!disposed) flashCopiedSelection();
  };

  // publish the current terminal or browser selection
  const syncSelectionMode = (claimShortcuts = false) => {
    // release hidden panes instead of retaining global shortcut ownership
    if (!paneIsVisible()) {
      mouseSelectionGesture = false;
      pinnedSelectionMode = false;
      nativeSelectionWasActive = false;
      // discard browser ranges owned by the hidden pane
      if (nativeSelectionActive()) window.getSelection()?.removeAllRanges();
      // prevent stale terminal selections from returning after layout changes
      if (terminal.hasSelection()) dropTerminalSelection();
      setSelectionMode(false);
      options.onSelection(undefined);
      // release only this pane's shortcut claim
      if (shortcutOwner === container) shortcutOwner = undefined;
      restoreTerminalTheme();
      return;
    }
    const nativeActive = nativeSelectionActive();
    // clear xterm's mirror when the browser selection leaves output
    if (!nativeActive && nativeSelectionWasActive) {
      nativeSelectionWasActive = false;
      // let the nested xterm event finish the state transition
      if (terminal.hasSelection()) {
        dropTerminalSelection();
        return;
      }
    }
    nativeSelectionWasActive = nativeActive;
    restoreTerminalTheme();
    const hasTerminalSelection = terminal.hasSelection();
    const hasSelection = hasTerminalSelection || nativeActive;
    setSelectionMode(pinnedSelectionMode || mouseSelectionGesture || hasSelection);
    // claim shortcuts only from an event local to this pane
    if (hasSelection && claimShortcuts) shortcutOwner = container;
    // release only this pane's cleared shortcut claim
    if (!hasSelection && shortcutOwner === container) shortcutOwner = undefined;
    // position browser-native selections below their final row
    if (nativeActive) {
      const selection = window.getSelection();
      const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
      const bounds = range === undefined ? undefined : (Array.from(range.getClientRects()).at(-1) ?? range.getBoundingClientRect());
      const text = projectedSelectionText(selection, terminal) ?? selection?.toString() ?? '';
      options.onSelection(!text || bounds === undefined ? undefined : { text, ...toolbarPosition(bounds.bottom, bounds.right) });
      return;
    }
    // clear the toolbar with the terminal selection
    if (!hasTerminalSelection) {
      options.onSelection(undefined);
      return;
    }
    const text = terminal.getSelection();
    const position = terminal.getSelectionPosition();
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    // require enough grid geometry to locate the selected row
    if (!text || position === undefined || screen === null || screen === undefined || terminal.rows < 1) {
      options.onSelection(undefined);
      return;
    }
    const screenBounds = screen.getBoundingClientRect();
    const viewportRow = position.end.y - terminal.buffer.active.viewportY + 1;
    const selectionBottom = screenBounds.top + viewportRow * (screenBounds.height / terminal.rows);
    // xterm reports the end column 0-based and exclusive, so it counts the cells before the end edge
    const selectionRight = screenBounds.left + position.end.x * (screenBounds.width / terminal.cols);
    options.onSelection({ text, ...toolbarPosition(selectionBottom, selectionRight) });
  };

  // identify browser-owned text independently of terminal mouse reporting
  const nativeMouseSurface = (target: Element): boolean => target.closest('.terminal-selection-surface, .xterm-accessibility') !== null;

  // normalize caret offsets without depending on xterm's accessibility mirror
  const normalizeNativeCaret = (caret: { node: Node; offset: number } | undefined): { node: Node; offset: number } | undefined => {
    const element = eventTargetElement(caret?.node ?? null);
    // reject unrelated or detached text surfaces
    if (caret === undefined || element === null || !container.contains(element) || !nativeMouseSurface(element)) return undefined;
    // text nodes already use character offsets
    if (caret.node instanceof Text) return caret;
    const atEnd = caret.offset >= element.childNodes.length;
    let text: Node | null = element.childNodes[caret.offset] ?? element.lastChild;
    // row endpoints may contain fixed-width spans rather than direct text
    while (text instanceof Element) text = atEnd ? text.lastChild : text.firstChild;
    // normalize element child indexes to text positions
    if (text instanceof Text) return { node: text, offset: atEnd ? text.length : 0 };
    return undefined;
  };

  // resolve native text beneath transparent link overlays without changing row markup
  const nativeCaretAtPoint = (x: number, y: number): { node: Node; offset: number } | undefined => {
    container.classList.add('selection-hit-test');
    try {
      const position = document.caretPositionFromPoint?.(x, y);
      const caret = normalizeNativeCaret(position == null ? undefined : { node: position.offsetNode, offset: position.offset });
      // use the standard caret API where available
      if (caret !== undefined) return caret;
      const range = document.caretRangeFromPoint?.(x, y);
      return normalizeNativeCaret(range == null ? undefined : { node: range.startContainer, offset: range.startOffset });
    } finally {
      container.classList.remove('selection-hit-test');
    }
  };

  // release an explicitly pinned selection mode from an ordinary output click
  const releasePinnedSelectionMode = () => {
    // retain natural selections until their owner clears them
    if (!pinnedSelectionMode) return;
    pinnedSelectionMode = false;
    if (!nativeSelectionActive() && !terminal.hasSelection()) setSelectionMode(false);
  };

  // Drop this pane's selection — xterm's own and a browser range it owns — which closes its
  // toolbar and releases the output it froze. A selection action calls it once it is done.
  const clear = () => {
    // ignore late completions after cleanup
    if (disposed) return;
    clearAfterFlash = false;
    if (nativeSelectionActive()) window.getSelection()?.removeAllRanges();
    // unconditionally: the pane may have dropped its selection already (hidden mid-transition)
    // yet still hold a stale drawn range
    dropTerminalSelection();
    syncSelectionMode();
  };

  // copy from the toolbar: the same copy and flash as a shortcut, then the selection is dropped
  // once the flash has shown. A failed copy keeps the selection for another try.
  const copyThenClear = async (value: string): Promise<void> => {
    await copy(value);
    // the flash timer clears it; a copy that could not flash clears now
    if (copiedSelectionTimer === undefined) clear();
    else clearAfterFlash = true;
  };

  // freeze before xterm commits desktop drag selections on mouseup
  const beginOutputSelection = (event: PointerEvent) => {
    linkSelectionOrigin = undefined;
    linkSelectionDragged = false;
    // keep a secondary press from reaching xterm mouse reporting
    if (event.pointerType === 'mouse' && event.button === 2 && event.target instanceof Element && (event.target.closest('.xterm-screen') !== null || nativeMouseSurface(event.target))) {
      event.stopPropagation();
      return;
    }
    // leave hidden panes, touch scrolling, secondary clicks and scrollbar drags alone
    if (!paneIsVisible() || event.pointerType !== 'mouse' || event.button !== 0 || !(event.target instanceof Element)) return;
    // bridge link-start drags only when native text is the active selection surface
    if (event.target.closest('.output-link-overlay')) {
      const surface = container.querySelector('.terminal-selection-surface');
      // leave raw terminal links unchanged when native text is not interactive
      if (surface === null || getComputedStyle(surface).pointerEvents === 'none') return;
      const caret = nativeCaretAtPoint(event.clientX, event.clientY);
      // retain ordinary link behavior if the browser cannot resolve underlying text
      if (caret === undefined) return;
      linkSelectionOrigin = { ...caret, x: event.clientX, y: event.clientY };
    } else if (!event.target.closest('.xterm-screen') && !nativeMouseSurface(event.target)) return;
    releasePinnedSelectionMode();
    const nativeSurface = linkSelectionOrigin !== undefined || nativeMouseSurface(event.target);
    // preserve live application mouse gestures without the platform override
    if (!nativeSurface && terminal.modes.mouseTrackingMode !== 'none') {
      const forceSelection = navigator.platform.startsWith('Mac')
        ? event.altKey && terminal.options.macOptionClickForcesSelection
        : event.shiftKey;
      // require xterm's mouse-reporting override
      if (!forceSelection) return;
    }
    mouseSelectionGesture = true;
    shortcutOwner = container;
    setSelectionMode(true);
  };

  // let the browser select native text without xterm focusing or reporting the drag
  const preserveNativeMouseSelection = (event: MouseEvent) => {
    const target = eventTargetElement(event.target);
    // preserve focus, mode and selected text until the contextmenu action runs
    if (event.button === 2 && target !== null && (target.closest('.xterm-screen') !== null || nativeMouseSurface(target))) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // remember xterm's selection shape without depending on private selection services
    if (event.button === 0 && linkSelectionOrigin === undefined && target?.closest('.xterm-screen') && !nativeMouseSurface(target) && !(event.shiftKey && terminal.hasSelection())) {
      rectangularSelection = event.detail < 2 && event.altKey && !(navigator.platform.startsWith('Mac') && terminal.options.macOptionClickForcesSelection === true);
    }
    // delay link activation until a click or text drag is known
    if (event.button === 0 && linkSelectionOrigin !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // isolate the legacy accessibility surface outside the linkifier boundary
    if (event.button === 0 && event.target instanceof Element && event.target.closest('.xterm-accessibility')) event.stopPropagation();
  };

  // allow xterm's screen-level hyperlink handler before stopping root mouse reporting
  const preserveNativeScreenSelection = (event: MouseEvent) => {
    // leave secondary clicks and application-owned terminal surfaces unchanged
    if (event.button === 0 && event.target instanceof Element && event.target.closest('.terminal-selection-surface')) event.stopPropagation();
  };

  // a text drag must not also activate an osc hyperlink on mouseup
  const suppressSelectedHyperlink = (event: MouseEvent) => {
    // preserve ordinary hyperlink clicks without a selected range
    if (event.target instanceof Element && event.target.closest('.terminal-selection-surface') && nativeSelectionActive()) event.stopPropagation();
  };

  // keep any-motion mouse reporting out of a browser-owned selection gesture
  const preserveNativeMouseDrag = (event: MouseEvent) => {
    // xterm has no drag listeners when its initial mousedown was isolated
    if (mouseSelectionGesture && event.target instanceof Element && nativeMouseSurface(event.target)) event.stopPropagation();
  };

  // extend browser text when a drag began on a transparent semantic link
  const extendLinkSelection = (event: PointerEvent) => {
    const origin = linkSelectionOrigin;
    // leave small click movements and unrelated pointers alone
    if (origin === undefined || event.pointerType !== 'mouse' || (!linkSelectionDragged && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 4)) return;
    const caret = nativeCaretAtPoint(event.clientX, event.clientY);
    // constrain link-start selections to this terminal's native rows
    if (caret === undefined) return;
    linkSelectionDragged = true;
    window.getSelection()?.setBaseAndExtent(origin.node, origin.offset, caret.node, caret.offset);
    syncSelectionMode(true);
  };

  // prevent a completed text drag from also opening its starting link
  const suppressSelectedLinkClick = (event: MouseEvent) => {
    // preserve ordinary and keyboard link activation
    if (!linkSelectionDragged || event.detail === 0) return;
    linkSelectionDragged = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // release an empty pinned mode for touch taps that synthesize only a click
  const releasePinnedOnClick = (event: MouseEvent) => {
    // preserve secondary activation and completed selections
    if (event.button === 0 && !nativeSelectionActive() && !terminal.hasSelection()) releasePinnedSelectionMode();
  };

  // keep completed selections frozen but release empty or cancelled drags
  const endOutputSelection = (event: Event) => {
    linkSelectionOrigin = undefined;
    // cancellation does not produce a click to suppress
    if (event.type !== 'pointerup') linkSelectionDragged = false;
    // ignore unrelated pointer releases and window focus changes
    if (!mouseSelectionGesture) return;
    mouseSelectionGesture = false;
    syncSelectionMode();
  };

  // intentional viewport changes invalidate the frozen projection's cell geometry
  const clearProjectedSelection = () => {
    const selection = window.getSelection();
    const surface = container.querySelector('.terminal-selection-surface');
    // leave terminal-rendered selections and other panes unchanged
    if (selection === null || surface === null || !nativeSelectionActive() || (!surface.contains(selection.anchorNode) && !surface.contains(selection.focusNode))) return;
    mouseSelectionGesture = false;
    linkSelectionOrigin = undefined;
    linkSelectionDragged = false;
    selection.removeAllRanges();
    syncSelectionMode();
  };

  // identify events owned by another output surface
  const targetsForeignOutput = (target: Element | null): boolean => {
    // body-level mobile shortcuts have no foreign surface
    if (target === null) return false;
    // accept events from this terminal's own DOM
    if (container.contains(target)) return false;
    const ownOutput = container.closest('.terminal-pane, .log-output');
    const targetOutput = target.closest('.terminal-pane, .log-output');
    // isolate terminal and log surfaces from one another
    if (targetOutput !== null) return targetOutput !== ownOutput;
    // portal toolbars never belong to another pane's shortcut handler
    return target.closest('.output-selection-toolbar') !== null;
  };

  // return the selected text owned by this pane
  const selectedOutput = (leadingColumns = 0): string => {
    // prefer the browser's current range over an older terminal selection
    if (nativeSelectionActive()) {
      const selection = window.getSelection();
      return projectedSelectionText(selection, terminal, leadingColumns) ?? selection?.toString() ?? '';
    }
    return terminal.hasSelection() ? terminalSelectionText(terminal, leadingColumns, rectangularSelection) : '';
  };

  // select the entire terminal buffer through xterm's public selection API
  const selectAll = () => {
    pinnedSelectionMode = true;
    rectangularSelection = false;
    // remove a browser projection before creating the terminal selection
    if (nativeSelectionActive()) window.getSelection()?.removeAllRanges();
    terminal.selectAll();
    shortcutOwner = container;
    syncSelectionMode(true);
  };

  // switch modes only from an explicit menu choice
  const setMode = (mode: 'prompt' | 'output' | 'selection') => {
    pinnedSelectionMode = mode === 'selection';
    // selection mode must not keep sending keys to xterm
    if (pinnedSelectionMode) {
      terminal.blur();
      shortcutOwner = container;
      setSelectionMode(true);
      return;
    }
    // output mode releases every owned selection before focusing input
    if (nativeSelectionActive()) window.getSelection()?.removeAllRanges();
    if (terminal.hasSelection()) dropTerminalSelection();
    options.onSelection(undefined);
    setSelectionMode(false);
    // prompt mode hands focus to its composer instead of xterm
    if (mode === 'output') handle.focus();
    else terminal.blur();
  };

  // The copy-selection key binding (y, C-S-c, and C-c or Cmd-C over a selection): copy this pane's
  // selection, or decline so the key goes on (C-c still interrupts with nothing selected).
  const copySelectionShortcut = (event: KeyboardEvent | undefined, context: KeyActionContext | undefined): boolean => {
    // ignore late events after cleanup
    if (disposed || event === undefined) return false;
    const target = eventTargetElement(event.target);
    const localTarget = target !== null && container.contains(target);
    // the browser's own copy chords copy a terminal selection only from inside the pane; elsewhere
    // they copy whatever the page has selected, and C-c with nothing selected interrupts
    if (!localTarget && (context?.chord === 'C-c' || context?.chord === 'Super-c')) return false;
    // require ownership only for body-level and other neutral targets
    if (!localTarget && shortcutOwner !== container) return false;
    // leave fields outside this terminal untouched
    if (isEditableTarget(target) && (target === null || !container.contains(target))) return false;
    // leave every other output surface untouched
    if (targetsForeignOutput(target)) return false;
    // measure visibility only for this pane's copy shortcuts
    if (!paneIsVisible()) return false;
    const selected = selectedOutput();
    // preserve the key when selection has cleared
    if (!selected) return false;
    void copy(selected);
    return true;
  };

  // apply the same clipboard policy to native and xterm context-menu copies
  const nativeOutputCopied = (event: ClipboardEvent) => {
    const target = eventTargetElement(event.target);
    const localTarget = target !== null && container.contains(target);
    // leave other panes and ordinary page selections untouched
    if (!paneIsVisible() || targetsForeignOutput(target) || (isEditableTarget(target) && !localTarget)) return;
    const leadingColumns = options.copyLeadingColumns ?? 0;
    let text: string | undefined;
    // normalize the owned browser range before the browser writes its clipboard
    if (nativeSelectionActive()) text = projectedSelectionText(window.getSelection(), terminal, leadingColumns);
    else {
      // leave unmodified terminals and copies outside this pane to their existing handlers
      if (leadingColumns === 0 || !localTarget || !terminal.hasSelection()) return;
      text = terminalSelectionText(terminal, leadingColumns, rectangularSelection);
    }
    // retain successful empty crops when only the gutter was selected
    if (text !== undefined && event.clipboardData !== null) {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    }
    flashCopiedSelection();
  };

  container.addEventListener('pointerdown', beginOutputSelection, true);
  container.addEventListener('mousedown', preserveNativeMouseSelection, true);
  terminalScreen?.addEventListener('mousedown', preserveNativeScreenSelection);
  container.addEventListener('mouseup', suppressSelectedHyperlink, true);
  container.addEventListener('mousemove', preserveNativeMouseDrag, true);
  container.addEventListener('click', releasePinnedOnClick, true);
  container.addEventListener('click', suppressSelectedLinkClick, true);
  window.addEventListener('pointermove', extendLinkSelection, true);
  window.addEventListener('pointerup', endOutputSelection, true);
  window.addEventListener('pointercancel', endOutputSelection, true);
  window.addEventListener('blur', endOutputSelection);
  const selectionSub = terminal.onSelectionChange(() => syncSelectionMode(true));
  const selectionScrollSub = terminal.onScroll(clearProjectedSelection);
  const selectionSizeSub = terminal.onResize(clearProjectedSelection);
  const unsubscribeSelectionFont = subscribeTerminalFontSize(clearProjectedSelection);
  // xterm clears the selection itself when a resize changes the row count, and that clear (or ours,
  // when both land in one frame) leaves the renderer's stale range for the resize to repaint.
  // Resetting to an empty range on every resize without a selection keeps the ghost from
  // appearing; outside a drag it is invisible, and a drag keeps its mouse listeners.
  const resizeSub = terminal.onResize(() => {
    if (!disposed && !mouseSelectionGesture && !terminal.hasSelection()) dropTerminalSelection();
  });
  // claim native selection shortcuts only in the pane containing the selection
  const nativeSelectionChanged = () => syncSelectionMode(nativeSelectionActive());
  document.addEventListener('selectionchange', nativeSelectionChanged);
  document.addEventListener('copy', nativeOutputCopied);
  const unregisterCopyShortcut = registerKeyAction('copy-selection', copySelectionShortcut);
  // follow fullscreen and responsive visibility changes without selection events
  const selectionResizeObserver = new ResizeObserver(() => {
    // ignore callbacks queued before cleanup
    if (!disposed) syncSelectionMode();
  });
  selectionResizeObserver.observe(container);
  // A pane swiped out of the phone's panel carousel is hidden too, though its size is unchanged.
  // Its neighbour's edge still touches the screen, which counts as intersecting at ratio 0, so a
  // pane is on screen only while a sliver of it shows.
  const selectionViewObserver = new IntersectionObserver(entries => {
    const entry = entries.at(-1);
    if (entry !== undefined) inView = entry.intersectionRatio >= minimumInViewRatio;
    // ignore callbacks queued before cleanup
    if (!disposed) syncSelectionMode();
  }, { threshold: minimumInViewRatio });
  selectionViewObserver.observe(container);

  // release every listener and transient visual state
  const dispose = () => {
    // make cleanup idempotent
    if (disposed) return;
    disposed = true;
    // release only this pane's shortcut claim
    if (shortcutOwner === container) shortcutOwner = undefined;
    // cancel any pending flash cleanup
    if (copiedSelectionTimer !== undefined) window.clearTimeout(copiedSelectionTimer);
    copiedSelectionTimer = undefined;
    options.flashElement.classList.remove('selection-copied');
    selectionSub.dispose();
    selectionScrollSub.dispose();
    selectionSizeSub.dispose();
    unsubscribeSelectionFont();
    resizeSub.dispose();
    selectionResizeObserver.disconnect();
    selectionViewObserver.disconnect();
    container.removeEventListener('pointerdown', beginOutputSelection, true);
    container.removeEventListener('mousedown', preserveNativeMouseSelection, true);
    terminalScreen?.removeEventListener('mousedown', preserveNativeScreenSelection);
    container.removeEventListener('mouseup', suppressSelectedHyperlink, true);
    container.removeEventListener('mousemove', preserveNativeMouseDrag, true);
    container.removeEventListener('click', releasePinnedOnClick, true);
    container.removeEventListener('click', suppressSelectedLinkClick, true);
    window.removeEventListener('pointermove', extendLinkSelection, true);
    window.removeEventListener('pointerup', endOutputSelection, true);
    window.removeEventListener('pointercancel', endOutputSelection, true);
    window.removeEventListener('blur', endOutputSelection);
    document.removeEventListener('selectionchange', nativeSelectionChanged);
    document.removeEventListener('copy', nativeOutputCopied);
    unregisterCopyShortcut();
    setSelectionMode(false);
    options.onSelection(undefined);
    // avoid mutating native selection nodes during teardown
    if (!nativeSelectionActive()) restoreTerminalTheme();
    selectionContainers.delete(container);
  };

  return {
    copy,
    copyThenClear,
    clear,
    // keep transfer actions faithful to the selection; copy applies its own gutter crop
    getSelectedText: () => selectedOutput(),
    selectAll,
    setMode,
    dispose
  };
}
