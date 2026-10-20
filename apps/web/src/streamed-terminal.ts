import { Terminal as XTerm, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { installPaneStreamSafety } from './pane-safety.js';
import { computeTerminalTheme, terminalFontFamily } from './terminal-theme.js';
import { attachTerminalTouchScroll } from './terminal-touch-scroll.js';
import { createTerminalSelectionSurface } from './terminal-selection-surface.js';
import { readTerminalFontSize, subscribeTerminalFontSize } from './terminal-font-size.js';
import { subscribeColorTheme } from './color-theme.js';
import { createOutputLinkOverlays } from './output-links.js';
import { safeHttpTarget } from './terminal-link-metadata.js';
import { preserveOutputLongPressSelection } from './output-touch.js';
import { encodeInputBytes, maxInputFrameBytes, type PaneConnection, type PaneConnector, type PaneMetadata, type PaneServerFrame } from './pane-stream.js';

export interface StreamedTerminalOptions {
  // Opens a pane connection; called once per subscribe, including every reconnect.
  connect: PaneConnector;
  // The scrollback depth the browser keeps and asks the seed to fill; defaults to a
  // few thousand lines, fewer on a phone.
  scrollback?: number;
  // prefer ordinary text selection over application mouse gestures in agent output
  preferNativeMouseSelection?: boolean;
  // recognize codex/omx's app-owned transcript return control
  codexScrollControls?: boolean;
  // Route a same-stack URL into the in-app browser; return true when it was handled.
  onOpenUrl?: (url: string) => boolean;
  // Open a workspace file mention in the internal preview.
  onOpenFile?: (path: string) => void;
  // The Agent pane's derive, forwarded verbatim (the higher-level panel renders them).
  onQuestion?: (question: unknown) => void;
  onMetadata?: (metadata: PaneMetadata) => void;
  // The pane ended (an `exit` server frame: the shell exited, was killed, or its session
  // is gone). A Terminal panel closes on it; when unset the stream reconnects as before.
  onExit?: (reason: string) => void;
  // Rewrite terminal input before it is sent, so the panel's sticky mobile modifiers
  // (Ctrl, Alt, …) apply to typed keys as they do in the Log viewer. Identity by default.
  transformInput?: (data: string) => string;
  // How long a lost stream shows its status before re-subscribing.
  reconnectDelayMs?: number;
  // The status notice changed: its text while the stream is lost or refreshing, undefined
  // once a fresh seed lands (a panel header can mirror it).
  onStatus?: (status: string | undefined) => void;
}

export interface StreamedTerminalHandle {
  readonly terminal: XTerm;
  focus: () => void;
  // Type bytes into the pane (helper keys, paste); goes out as an input frame. Returns
  // whether the bytes reached the connection (`false` only mid-reconnect).
  sendInput: (data: string) => boolean;
  // paste through xterm's newline and bracketed-paste handling without sticky modifiers
  paste: (data: string) => void;
  // Ask the Agent pane's derive to resend its question and metadata (on-demand).
  requestMetadata: () => void;
  // freeze visual updates while output text is selected
  setOutputPaused: (paused: boolean) => void;
  dispose: () => void;
}

const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

// mount one streamed pane with its local output controls
export const mountStreamedTerminal = (container: HTMLElement, options: StreamedTerminalOptions): StreamedTerminalHandle => {
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const coarse = coarsePointer();
  const scrollback = options.scrollback ?? (coarse ? 2000 : 5000);

  // Layout: the terminal renders at its natural grid top-left; when the pane is
  // smaller than the panel the surrounding area shows the terminal background, so a
  // smaller pane is letterboxed rather than stretched.
  container.classList.add('streamed-terminal');
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const host = document.createElement('div');
  host.className = 'streamed-terminal-host';
  Object.assign(host.style, { position: 'absolute', inset: '0', overflow: 'hidden' });
  container.append(host);

  const status = document.createElement('div');
  status.className = 'streamed-terminal-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  // separate the solid notice from the cached-output treatment
  const statusMessage = document.createElement('span');
  statusMessage.className = 'streamed-terminal-status-message';
  status.append(statusMessage);
  container.append(status);

  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'streamed-terminal-jump';
  jump.textContent = 'Jump to latest';
  jump.hidden = true;
  container.append(jump);

  const terminal = new XTerm({
    fontFamily: terminalFontFamily,
    fontSize: readTerminalFontSize(),
    scrollback,
    scrollOnUserInput: false,
    // keep option-drag selection available when a mac program tracks the mouse
    macOptionClickForcesSelection: true,
    screenReaderMode: coarse,
    theme: computeTerminalTheme()
  });
  // Used only to propose a grid for the viewport request; never call fit(). The browser
  // conforms to the server's `size` frame (the Size claim), so fit() would fight it.
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  // Enforce the pane-stream safety table before any byte is parsed.
  installPaneStreamSafety(terminal);
  // retain a safe native OSC fallback when semantic metadata cannot be resolved
  terminal.options.linkHandler = {
    activate: (event, uri) => {
      // allow only primary and middle-button activation
      if (event.button !== 0 && event.button !== 1) return;
      // explicit metadata never enables a non-http navigation
      if (!safeHttpTarget(uri)) return;
      const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      // modified activations stay external just like semantic anchors
      if (!plain || !(options.onOpenUrl?.(uri) ?? false)) window.open(uri, '_blank', 'noopener,noreferrer');
    }
  };
  terminal.open(host);
  // expose native text only where agent programs would otherwise capture dragging
  container.classList.toggle('native-mouse-selection', options.preferNativeMouseSelection === true);
  const selectionSurface = options.preferNativeMouseSelection ? createTerminalSelectionSurface(terminal) : undefined;
  // Mirror the font size onto the element as the font-size subscription does on change, so
  // the configured size is legible in the DOM from mount (not only after the first change).
  Object.assign(terminal.element!.style, { fontFamily: terminalFontFamily, fontSize: `${readTerminalFontSize()}px`, fontKerning: 'none', fontWeight: 'normal' });

  const applyContainerBackground = (background: string | undefined) => { container.style.background = background ?? ''; };
  applyContainerBackground(computeTerminalTheme().background);

  let suppressFocusUntil = 0;
  const overlays = createOutputLinkOverlays(
    container,
    () => { suppressFocusUntil = performance.now() + 250; },
    options.onOpenFile,
    options.onOpenUrl
  );

  let disposed = false;
  // Cover the terminal with the themed background until the first seed has rendered, so the
  // operator never sees xterm's brief pre-paint frame or its hardcoded-black viewport before
  // content arrives — the pane appears already populated instead of flashing empty. Only the
  // initial mount is covered; a reconnect keeps the existing screen, and the cover is long
  // gone by then, so it never masks a live pane.
  const cover = document.createElement('div');
  cover.className = 'streamed-terminal-cover';
  Object.assign(cover.style, { position: 'absolute', inset: '0', zIndex: '2', pointerEvents: 'none' });
  const applyCoverBackground = (background: string | undefined) => { cover.style.background = background ?? ''; };
  applyCoverBackground(computeTerminalTheme().background);
  container.append(cover);
  let revealed = false;
  const revealTerminal = () => { if (revealed) return; revealed = true; cover.remove(); };
  let connection: PaneConnection | undefined;
  let sizeApplied = false;
  // The next bytes are a fresh seed: clear the scrollback right before writing them, so
  // the mounted terminal stays as its own placeholder (with a status) until the fresh
  // seed arrives on subscribe/reconnect/reseed, and a stale frame never duplicates lines.
  let awaitingSeed = false;
  // Bytes that somehow arrived before the first size (the seed is captured at the grid,
  // so it can only be applied then). Size precedes the seed by contract, so this is
  // normally empty; capped so a misbehaving server cannot grow it without bound.
  const pendingBytes: Uint8Array[] = [];
  let pendingByteCount = 0;
  const maxPendingSeedBytes = 256 * 1024;
  type VisualFrame = Extract<PaneServerFrame, { type: 'size' | 'reseed' }>;
  const queuedOutput: Array<Uint8Array | VisualFrame> = [];
  let outputPaused = false;
  let writePending = false;
  let queuedByteCount = 0;
  let queuedSize: Extract<VisualFrame, { type: 'size' }> | undefined;
  let needsFreshSeed = false;
  // match the server's byte window and bound tiny-frame overhead separately
  const maxQueuedBytes = 256 * 1024;
  const maxQueuedFrames = 1024;
  let reconnectTimer: number | undefined;
  let overlayFrame: number | undefined;
  let viewportFrame: number | undefined;
  // retained placeholder output must never authorize a shortcut on a replacement stream
  let outputGeneration = 0;
  let parsedSeedGeneration = -1;
  // Re-proposes the viewport on each render until one carries, then drops itself (wired to
  // onRender below); see there for why the open and initial-resize sends aren't enough.
  let firstViewportSub: IDisposable | undefined;

  const scheduleOverlayRender = () => {
    if (overlayFrame !== undefined) return;
    overlayFrame = window.requestAnimationFrame(() => {
      overlayFrame = undefined;
      if (!disposed) overlays.render(terminal);
    });
  };

  // codex 0.162 centers this control above its composer instead of scrolling xterm
  const codexCanReturnToLatest = () => {
    const buffer = terminal.buffer.active;
    // never interpret shell output or another full-screen program as codex history
    if (!options.codexScrollControls || buffer.type !== 'alternate' || parsedSeedGeneration !== outputGeneration) return false;
    // inspect only parsed visible rows so fragmented bytes and stale history cannot match
    for (let row = 0; row < terminal.rows; row += 1) {
      const text = buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? '';
      const label = text.trim();
      // require a complete label rather than quoted text or the ambiguous arrow-only fallback
      if (!/^(?:(?:New activity|New) · )?↓ (?:Back to bottom|Bottom)(?: · esc)?$/u.test(label)) continue;
      const left = text.indexOf(label);
      const right = terminal.cols - left - label.length;
      // allow a narrower left-aligned transcript when codex reserves right-side pet space
      if (left > 0 && right > 0 && left <= right + 2) return true;
    }
    return false;
  };

  // follow both browser scrollback and codex's own transcript viewport
  const syncFollowState = () => {
    const buffer = terminal.buffer.active;
    jump.hidden = !codexCanReturnToLatest() && buffer.viewportY >= buffer.baseY;
  };

  // invalidate app-owned controls while retaining the old screen as a placeholder
  const invalidateCodexFollowState = () => {
    outputGeneration += 1;
    syncFollowState();
  };

  const sendViewport = () => {
    if (disposed || connection === undefined) return;
    const dimensions = fit.proposeDimensions();
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows) || dimensions.cols < 1 || dimensions.rows < 1) return;
    connection.send({ type: 'viewport', cols: dimensions.cols, rows: dimensions.rows, scrollback });
    // A grid was proposable, so the cell is now measured; stop re-proposing on every render.
    firstViewportSub?.dispose();
    firstViewportSub = undefined;
  };

  const scheduleViewport = () => {
    if (viewportFrame !== undefined) return;
    viewportFrame = window.requestAnimationFrame(() => {
      viewportFrame = undefined;
      sendViewport();
    });
  };
  // The first render measures the character cell proposeDimensions() needs; propose the
  // grid again on each render until one carries (sendViewport drops this listener then).
  firstViewportSub = terminal.onRender(() => sendViewport());

  // release buffered output at stream boundaries and after replay
  const clearQueuedOutput = () => {
    queuedOutput.length = 0;
    queuedByteCount = 0;
    queuedSize = undefined;
    needsFreshSeed = false;
  };
  // retain visual events without acknowledging bytes the terminal has not consumed
  const queueOutput = (output: Uint8Array | VisualFrame) => {
    // retain the latest grid even if an earlier burst overflowed
    if (!(output instanceof Uint8Array) && output.type === 'size') queuedSize = output;
    // a new snapshot supersedes older bytes and resets server acknowledgement accounting
    if (!(output instanceof Uint8Array) && output.type === 'reseed') {
      invalidateCodexFollowState();
      queuedOutput.length = 0;
      queuedByteCount = 0;
      pendingBytes.length = 0;
      pendingByteCount = 0;
      needsFreshSeed = false;
      // apply the latest deferred grid before the new snapshot
      if (queuedSize !== undefined) queuedOutput.push(queuedSize);
    }
    const byteCount = output instanceof Uint8Array ? output.length : 0;
    // a ready live snapshot may exceed the backlog cap and must not reconnect forever
    let readyBytes = 0;
    // exempt only the next immediately consumable live chunk
    if (!outputPaused && sizeApplied) {
      const head = queuedOutput[0];
      // an existing byte head will reach the parser first
      if (head instanceof Uint8Array) readyBytes = head.length;
      // an empty queue lets the incoming chunk become the head
      else if (queuedOutput.length === 0) readyBytes = byteCount;
    }
    // recover with a fresh connection rather than replaying an incomplete byte stream
    if (needsFreshSeed || queuedByteCount + pendingByteCount + byteCount - readyBytes > maxQueuedBytes || queuedOutput.length + pendingBytes.length >= maxQueuedFrames) {
      queuedOutput.length = 0;
      queuedByteCount = 0;
      needsFreshSeed = true;
    } else {
      queuedOutput.push(output);
      queuedByteCount += byteCount;
    }
    drainOutput();
  };

  // Every byte — the seed included — goes through the hooked parser; the seed is not
  // SGR-only. Ack the consumed count from the write callback so the server's
  // drop-while-behind flow control can advance.
  const writeBytes = (bytes: Uint8Array) => {
    const wasSeed = awaitingSeed;
    const generation = outputGeneration;
    if (awaitingSeed) {
      // Clear the placeholder/scrollback and its stale link overlays the instant the
      // fresh seed starts; the registered safety handlers survive the reset.
      terminal.reset();
      overlays.clear();
      awaitingSeed = false;
      hideStatus();
    }
    writePending = true;
    const source = connection;
    // gate at the parser task boundary before handing xterm any mutable output
    terminal.write('', () => {
      // an unmounted terminal must not accept another write
      if (disposed) return;
      // selection or a replacement snapshot can supersede a scheduled write
      if (outputPaused || connection !== source || queuedOutput[0] !== bytes) {
        writePending = false;
        // a postponed first seed must still uncover the terminal when eventually parsed
        if (wasSeed && connection === source && queuedOutput[0] === bytes) awaitingSeed = true;
        queueMicrotask(drainOutput);
        return;
      }
      queuedOutput.shift();
      queuedByteCount -= bytes.length;
      // xterm drains callback-enqueued bytes in this parser task without an input-event gap
      terminal.write(bytes, () => {
        writePending = false;
        // ignore completion after unmount
        if (disposed) return;
        // acknowledge only the connection that supplied these bytes
        if (connection === source) source?.send({ type: 'ack', bytes: bytes.length });
        // only the current stream's successfully parsed seed can restore app-owned controls
        if (wasSeed && connection === source && generation === outputGeneration) parsedSeedGeneration = generation;
        scheduleOverlayRender();
        syncFollowState();
        // uncover the first populated frame
        if (wasSeed) revealTerminal();
        // let xterm finish its parser turn before scheduling the next visual event
        queueMicrotask(drainOutput);
      });
    });
  };

  // conform to the server grid and refresh follow controls
  const applySize = (cols: number, rows: number) => {
    // resize only to a valid pane grid
    if (cols > 0 && rows > 0) terminal.resize(cols, rows);
    container.dataset.cols = String(terminal.cols);
    container.dataset.rows = String(terminal.rows);
    // release bytes buffered before the initial pane dimensions
    if (!sizeApplied) {
      sizeApplied = true;
      // Flush anything that arrived before the first size, in order, behind it.
      queuedOutput.unshift(...pendingBytes.splice(0));
      queuedByteCount += pendingByteCount;
      pendingByteCount = 0;
    }
    syncFollowState();
    scheduleOverlayRender();
  };

  // update the notice without replacing its styled container
  const showStatus = (text: string) => {
    statusMessage.textContent = text;
    status.hidden = false;
    container.dataset.status = text;
    options.onStatus?.(text);
  };
  const hideStatus = () => {
    status.hidden = true;
    delete container.dataset.status;
    options.onStatus?.(undefined);
  };

  const handleDisconnect = (reason: string) => {
    if (disposed) return;
    const current = connection;
    connection = undefined;
    invalidateCodexFollowState();
    if (current !== undefined) { try { current.close(); } catch { /* already closing */ } }
    // Keep the terminal mounted as its own placeholder with a status, then re-subscribe.
    showStatus(reason);
    if (reconnectTimer === undefined) {
      reconnectTimer = window.setTimeout(() => { reconnectTimer = undefined; subscribe(); }, reconnectDelayMs);
    }
  };

  const handleFrame = (frame: PaneServerFrame) => {
    switch (frame.type) {
      // serialize visual control frames with bytes so resizing cannot overtake parsing
      case 'size': case 'reseed': queueOutput(frame); break;
      // A pane that ended closes a Terminal panel (its onExit); the Agent panel supplies
      // none and shows the status + reconnects on a fresh control client, as before.
      case 'exit': if (options.onExit) options.onExit(frame.reason); else handleDisconnect(frame.reason); break;
      case 'question': options.onQuestion?.(frame.question); break;
      case 'metadata': options.onMetadata?.(frame.metadata); break;
      // the browser allows the write only shortly after a keypress in this tab (the yank), so
      // other open tabs and devices fail quietly
      case 'clipboard': navigator.clipboard?.writeText(frame.text).catch(() => {}); break;
    }
  };

  function subscribe(): void {
    if (disposed) return;
    // a replacement stream supplies its own size and seed
    clearQueuedOutput();
    sizeApplied = false;
    pendingBytes.length = 0;
    pendingByteCount = 0;
    // Keep the current screen as the placeholder; the fresh seed clears it when it lands.
    awaitingSeed = true;
    invalidateCodexFollowState();
    connection = options.connect({
      onOpen: () => sendViewport(),
      onBytes: queueOutput,
      onFrame: handleFrame,
      // keep transport codes out of the reconnect notice
      onClose: () => handleDisconnect('Reconnecting…')
    });
  }

  // consume one byte chunk at a time with control frames between completed writes
  const drainOutput = () => {
    // pause before parsing and wait for the previous write to finish
    if (disposed || outputPaused || writePending) return;
    // an incomplete stream must restart before rendering any more bytes
    if (needsFreshSeed) {
      handleDisconnect('Refreshing output…');
      // refresh immediately rather than waiting for the normal reconnect delay
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      subscribe();
      return;
    }
    // synchronous control frames may precede the next asynchronous byte write
    while (queuedOutput.length > 0) {
      const event = queuedOutput[0]!;
      // retain the head until its parser gate accepts the write
      if (event instanceof Uint8Array && sizeApplied) {
        let byteCount = event.length;
        let chunkCount = 1;
        // combine adjacent bytes without crossing a resize or snapshot boundary
        while (queuedOutput[chunkCount] instanceof Uint8Array) {
          byteCount += (queuedOutput[chunkCount] as Uint8Array).length;
          chunkCount += 1;
        }
        // amortize parser scheduling when a selected pane accumulated many small frames
        if (chunkCount > 1) {
          const bytes = new Uint8Array(byteCount);
          let offset = 0;
          // preserve the exact byte order within the combined chunk
          for (const chunk of queuedOutput.splice(0, chunkCount) as Uint8Array[]) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          queuedOutput.unshift(bytes);
        }
        writeBytes(queuedOutput[0] as Uint8Array);
        return;
      }
      queuedOutput.shift();
      // preserve the existing size-before-seed boundary for unexpected early bytes
      if (event instanceof Uint8Array) {
        queuedByteCount -= event.length;
        // keep the pre-size buffer bounded
        if (pendingByteCount + event.length > maxPendingSeedBytes) continue;
        pendingBytes.push(event);
        pendingByteCount += event.length;
      } else if (event.type === 'size') {
        applySize(event.cols, event.rows);
      } else {
        awaitingSeed = true;
        pendingBytes.length = 0;
        pendingByteCount = 0;
      }
    }
  };

  // resume the serialized stream when both native and terminal selections clear
  const setOutputPaused = (paused: boolean) => {
    // ignore repeated selection notifications and calls after unmount
    if (disposed || outputPaused === paused) return;
    outputPaused = paused;
    selectionSurface?.setPaused(paused);
    // a large live seed awaiting its parser gate cannot become an unbounded paused backlog
    if (paused && queuedByteCount + pendingByteCount > maxQueuedBytes) {
      clearQueuedOutput();
      needsFreshSeed = true;
    }
    drainOutput();
  };

  // Send bytes to the pane, split past the frame cap into byte-bounded frames; the
  // server replays them in order, so a boundary mid-UTF-8 is harmless.
  // Returns whether the bytes reached the connection (the connector buffers until open and
  // flushes in order); `false` only while there is no connection, i.e. mid-reconnect.
  const sendBytes = (bytes: Uint8Array): boolean => {
    if (connection === undefined || bytes.length === 0) return false;
    for (let offset = 0; offset < bytes.length; offset += maxInputFrameBytes) {
      connection.send({ type: 'input', data: encodeInputBytes(bytes.subarray(offset, offset + maxInputFrameBytes)) });
    }
    return true;
  };
  // Exposed for helper keys and paste, which already carry the exact bytes; the boolean lets a
  // caller that needs delivery confirmation (the update advisor's feedback) know it was sent.
  const sendInput = (data: string): boolean => sendBytes(new TextEncoder().encode(data));
  let pasting = false;
  // typed keys pass through sticky mobile modifiers while paste stays exact
  terminal.onData(data => sendBytes(new TextEncoder().encode(options.transformInput && !pasting ? options.transformInput(data) : data)));
  // Legacy (non-SGR) mouse tracking reports one byte per char code on onBinary; forward
  // those raw, without the modifier transform.
  terminal.onBinary(data => sendBytes(Uint8Array.from(data, character => character.charCodeAt(0))));
  terminal.onScroll(() => { syncFollowState(); scheduleOverlayRender(); });

  // Console-owned touch scrolling and long-press selection; the wheel stays native.
  const releaseTouchScroll = attachTerminalTouchScroll(host, terminal);
  const releaseLongPress = preserveOutputLongPressSelection(host, () => { suppressFocusUntil = performance.now() + 250; });

  // Tap/click-to-focus: focus xterm's hidden textarea synchronously inside the click so a
  // mobile browser opens and keeps the soft keyboard, mirroring the retired snapshot Log's
  // coarse-pointer affordance. It must be the click, not touchend: iOS Safari only raises
  // the keyboard for a focus() made from the click a genuine tap synthesizes, so focusing
  // on touchend leaves the textarea focused without a keyboard. A scroll drag never yields a
  // click (terminal-touch-scroll swallows the move), a long press is consumed before the
  // click (preserveOutputLongPressSelection), and suppressFocusUntil covers link taps and
  // long-press selection.
  // keep the click ending a selection from replacing its range with the input caret
  const focusOnClick = () => {
    const selection = window.getSelection();
    const nativeSelection = selection !== null && !selection.isCollapsed && container.contains(selection.anchorNode);
    // ordinary taps still enter input mode when no selected text needs preserving
    if (!nativeSelection && !terminal.hasSelection() && performance.now() >= suppressFocusUntil) terminal.focus();
  };
  // keep the current input target and output mode when clicking or tapping jump
  const preserveJumpFocus = (event: PointerEvent) => event.preventDefault();
  // route codex's dedicated ctrl-end shortcut without applying sticky input modifiers
  const jumpToBottom = () => {
    // recheck the live marker before sending input into an application-owned viewport
    if (codexCanReturnToLatest()) sendInput('\x1b[1;5F');
    // ordinary panes still follow their browser-owned scrollback without sending keys
    else terminal.scrollToBottom();
    syncFollowState();
  };
  host.addEventListener('click', focusOnClick);
  jump.addEventListener('pointerdown', preserveJumpFocus);
  jump.addEventListener('click', jumpToBottom);

  const unsubscribeFont = subscribeTerminalFontSize(() => {
    if (disposed) return;
    const px = readTerminalFontSize();
    terminal.options.fontSize = px;
    if (terminal.element) terminal.element.style.fontSize = `${px}px`;
    scheduleViewport();
    scheduleOverlayRender();
  });
  const unsubscribeTheme = subscribeColorTheme(() => {
    if (disposed) return;
    const theme = computeTerminalTheme();
    terminal.options.theme = theme;
    applyContainerBackground(theme.background);
    applyCoverBackground(theme.background);
    scheduleOverlayRender();
  });

  const resizeObserver = new ResizeObserver(() => {
    if (disposed) return;
    scheduleViewport();
    scheduleOverlayRender();
  });
  resizeObserver.observe(container);

  subscribe();

  return {
    terminal,
    focus: () => terminal.focus(),
    sendInput,
    // let xterm normalize line endings and honor application bracketed-paste mode
    paste: data => {
      pasting = true;
      try { terminal.paste(data); }
      finally { pasting = false; }
    },
    requestMetadata: () => connection?.send({ type: 'metadata' }),
    setOutputPaused,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearQueuedOutput();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (overlayFrame !== undefined) window.cancelAnimationFrame(overlayFrame);
      if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
      firstViewportSub?.dispose();
      const current = connection;
      connection = undefined;
      if (current !== undefined) { try { current.close(); } catch { /* already closing */ } }
      resizeObserver.disconnect();
      releaseTouchScroll();
      releaseLongPress();
      host.removeEventListener('click', focusOnClick);
      jump.removeEventListener('pointerdown', preserveJumpFocus);
      jump.removeEventListener('click', jumpToBottom);
      unsubscribeFont();
      unsubscribeTheme();
      overlays.clear();
      selectionSurface?.dispose();
      terminal.dispose();
      host.remove();
      cover.remove();
      status.remove();
      jump.remove();
      // Leave the caller's container as we found it, so a later re-mount starts clean.
      container.classList.remove('streamed-terminal', 'native-mouse-selection');
      container.style.background = '';
      delete container.dataset.cols;
      delete container.dataset.rows;
      delete container.dataset.status;
    }
  };
};
