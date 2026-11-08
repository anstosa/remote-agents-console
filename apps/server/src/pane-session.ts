import type { ControlService } from './auth/control.js';
import { adapterFor } from './adapters/registry.js';
import { withQuestionShape } from './adapters/inline-questions.js';
import type { ShapedQuestion } from './adapters/types.js';
import type { DiscoveryService } from './discovery/service.js';
import { paneTmuxSession, type Agent, type SocketRef } from './domain/models.js';
import type { LaunchService } from './launch/service.js';
import { maxTimingFrameChars, parsePaneTiming } from './logs/pane-timing.js';
import { LatestViewportScheduler, type PaneViewportCoordinator } from './logs/viewport-scheduler.js';
import { boundedViewport } from './logs/viewport.js';
import type { Place } from './places/places.js';
import type { PromptService } from './prompts/service.js';
import type { TmuxAdapter } from './tmux/adapter.js';
import type { PaneStreamProvider } from './tmux/control.js';

// One Pane stream (ADR 0008, spec "The pane socket"): a pane's raw bytes — the seed first,
// then live `%output` over the shared control-mode client — out as binary frames, and input,
// sizing, flow-control acks and the Agent-pane derive as JSON frames. `/ws/panes` carries
// many of these over one socket, each behind its own `PaneTransport`.

// what a stream needs from the socket carrying it
export type PaneTransport = {
  // one JSON frame
  send: (frame: Record<string, unknown>) => void;
  // one binary frame of pane bytes
  sendBytes: (bytes: Buffer) => void;
  // end the stream with a WebSocket close code's meaning (1000 pane gone, 1008 policy, 1011
  // failure)
  close: (code: number) => void;
  open: () => boolean;
};

export type PaneSessionDependencies = {
  control: ControlService;
  discovery: DiscoveryService;
  resolvePlace: (id: string) => Promise<Place | undefined>;
  tmux: TmuxAdapter;
  launch: LaunchService;
  paneStream: PaneStreamProvider;
  paneViewports: PaneViewportCoordinator;
  prompts: PromptService;
  logPaneTiming: (record: unknown) => Promise<void>;
};

export type PaneSession = {
  // one client frame, as received
  receive: (raw: unknown) => void;
  // the transport closed; release the stream's subscriptions and Size claim
  closed: () => void;
  // the target resolution and setup finished, whether or not the stream came up
  settled: Promise<void>;
};

// how long a pane must be quiet after output before its live frame is captured
const logQuietWindowMs = 250;

// Opens the stream for `id` (an Agent or a Place) and `requestedPane` for an authenticated
// browser session holding control. A failed resolution or setup closes the transport 1008.
export function openPaneSession(deps: PaneSessionDependencies, transport: PaneTransport, sessionId: string, id: string, requestedPane: unknown, startedAt: number): PaneSession {
  const { control, discovery, resolvePlace, tmux, launch, paneStream, paneViewports, prompts, logPaneTiming } = deps;
  // this stream's setup steps in ms since `startedAt` (its `open` frame; first occurrence
  // only), merged with the browser's `timing` frame into one pane-timing.jsonl record
  const timing: Record<string, unknown> = {};
  const mark = (name: string) => { timing[name] ??= Math.round((performance.now() - startedAt) * 10) / 10; };
  // Buffer client frames from the instant the stream is up: the browser sends its first (and,
  // until a resize, only) `viewport` right on open — while the target/membership resolution
  // below still awaits (a Worktree pane spawns `list-panes`). Losing that one frame means no
  // size, no seed, a blank pane that still takes input. `handleRaw` buffers until setup swaps
  // in the real processor and replays what queued.
  const earlyFrames: unknown[] = [];
  let handleRaw: (raw: unknown) => void = raw => { earlyFrames.push(raw); };
  let cleanup: (() => void) | undefined;
  const setup = async () => {
    // Resolve the pane target: an Agent (default pane = the Agent's own, membership = every
    // pane of its tmux session, derive + mutation lock on its own pane) or a Place (an
    // explicit pane required, membership = the Place's pane set — every pane of every
    // session holding a pane at the Place, plus its Console shells — raw bytes, no derive, no
    // lock).
    // A snapshot miss is a Place, or an Agent launched since the last scan: only an id that
    // names no Place pays for the forced scan, so a Terminal never waits on one.
    let agentTarget = await discovery.snapshotTarget(id);
    const place = agentTarget === undefined ? await resolvePlace(id) : undefined;
    if (agentTarget === undefined && place === undefined) agentTarget = await discovery.target(id);
    let socketRef: SocketRef;
    let session: string;
    let pane: string;
    let isAgentPane = false;
    let agent: Agent | undefined;
    if (agentTarget !== undefined) {
      agent = agentTarget.agent;
      socketRef = agentTarget.socket;
      session = paneTmuxSession(agentTarget.agent.pane);
      pane = agentTarget.agent.pane.paneId;
      // the Agent's own pane by default; a requested pane must belong to its session
      if (typeof requestedPane === 'string' && requestedPane !== '') {
        if (!/^%\d+$/u.test(requestedPane) || !(await tmux.sessionPaneIds(socketRef, session)).includes(requestedPane)) throw new Error();
        pane = requestedPane;
      }
      isAgentPane = pane === agentTarget.agent.pane.paneId;
    } else {
      if (typeof requestedPane !== 'string' || !/^%\d+$/u.test(requestedPane)) throw new Error();
      if (place === undefined) throw new Error();
      const member = (await launch.placePanes(place)).find(candidate => candidate.paneId === requestedPane);
      if (member === undefined) throw new Error();
      // A live Agent's own pane is reachable through the Place set (its cwd is at the
      // Place), but it must be streamed only through its Agent target so input takes the
      // mutation lock and a lone Ctrl+C routes through queued-prompt cancellation. Refuse it
      // here (the picker lists it disabled, from the same snapshot), so the Place path only
      // ever drives raw panes.
      if (await discovery.snapshotTarget(`${member.socket.fingerprint}:${member.paneId}`) !== undefined) throw new Error();
      socketRef = member.socket;
      session = member.sessionId;
      pane = requestedPane;
    }
    // the browser may have disconnected during the awaits above (target/membership lookups);
    // bail before spawning/subscribing so a control client and lease are never left dangling
    if (!transport.open()) return;
    mark('target');
    const clientWanted = performance.now();
    const paneClient = paneStream.get(socketRef, session);
    if (paneClient.startedAt !== undefined) timing.control = paneClient.startedAt >= clientWanted ? 'attached' : 'reused';
    void paneClient.ready?.then(() => mark('controlReady'), () => {});
    const captureVia = (depth: number) => paneClient.capture(pane, depth);
    const adapter = agent === undefined ? undefined : adapterFor(agent.kind);
    // the Agent's derive (question/metadata) rides the Agent's own pane only, and only for
    // an Adapter with Turns or a question parser (Codex/OMX, not Claude)
    const derives = isAgentPane && (adapter?.turns !== undefined || adapter?.questions?.parse !== undefined);
    // One Size claim per window, keyed by window id resolved over the connection: every
    // caller awaits windowKeyReady first (see the INVARIANT below).
    let windowKey = pane;
    const windowKeyReady = paneClient.windowId(pane).then(w => { mark('windowKey'); if (w !== undefined) windowKey = w; }).catch(() => { /* keep the pane-id fallback */ });
    let paneViewport: ReturnType<typeof paneViewports.acquire> | undefined;
    // set once the stream ends; a viewport or re-clamp still awaiting `windowKeyReady` then
    // must not take a claim no one will release
    let ended = false;
    // INVARIANT: every caller must `await windowKeyReady` before the first call, so the
    // memoised claim is keyed by the window id, not the pane-id fallback.
    const viewportLease = () => ended ? undefined : paneViewport ??= paneViewports.acquire(
      `${socketRef.fingerprint}:${windowKey}`,
      async () => { const size = await tmux.size(socketRef, pane); timing.sizeBefore ??= size && `${size.cols}x${size.rows}`; return size; },
      (nextCols, nextRows) => tmux.resize(socketRef, pane, nextCols, nextRows),
      () => tmux.unpinWindowSize(socketRef, windowKey)
    );
    // gate every outbound frame on the control lease, like /ws/dashboard's send: a browser
    // that lost control (a take-control handoff) must stop receiving pane bytes at once,
    // not only when the lease heartbeat next fires
    const sendFrame = (value: Record<string, unknown>) => { if (!control.active(sessionId)) return transport.close(1008); if (transport.open()) transport.send(value); };
    const sendBinary = (bytes: Buffer) => { if (!control.active(sessionId)) return transport.close(1008); if (transport.open()) transport.sendBytes(bytes); };
    // report the pane's ACTUAL size, so a smaller attached terminal the coordinator yields
    // to is the grid the browser conforms to (Sizing, ADR 0008)
    const reportSize = async (): Promise<boolean> => {
      const size = await tmux.size(socketRef, pane);
      // an unknown grid cannot authorize the initial snapshot
      if (size === undefined) return false;
      sendFrame({ type: 'size', cols: size.cols, rows: size.rows });
      timing.size ??= `${size.cols}x${size.rows}`;
      mark('sizeSent');
      return transport.open();
    };
    let cols = 120;
    let rows = 36;
    let seedDepth = 2_000;
    let viewportEstablished = false;
    let reclamping = false;
    // Flow control: drop-while-behind + reseed, and the control pipe is never paused (spec).
    const highWatermark = 256 * 1024;
    const lowWatermark = 64 * 1024;
    let unacked = 0;
    let dropped = false;
    // discard pre-capture output already represented by the seed; its delivery opens the
    // live gate synchronously at the reply boundary, before any following redraw
    let seeding = true;
    let seeded = false;
    let seedGeneration = 0;
    const forward = (bytes: Buffer) => {
      if (seeding) return;
      if (unacked >= highWatermark) { dropped = true; return; }
      unacked += bytes.length;
      sendBinary(bytes);
    };
    // replace the screen and resume live bytes at the capture reply boundary
    const reseed = async () => {
      // a fresh seed re-establishes the whole screen, so the pre-reseed in-flight count is
      // void: reset it (and clear a lingering drop) so backpressure restarts from the seed
      seeding = true;
      mark('captureStart');
      const generation = ++seedGeneration;
      unacked = 0;
      dropped = false;
      const delivered = await paneClient.seed(pane, seedDepth, seed => {
        // an older capture cannot replace a newer snapshot or release its live gate
        if (generation !== seedGeneration || !transport.open()) return false;
        // preserve take-control policy before sending the snapshot
        if (!control.active(sessionId)) { transport.close(1008); return false; }
        mark('captured');
        timing.seedBytes ??= seed.length;
        sendBinary(seed);
        mark('seedSent');
        seeding = false;
        return true;
      }).catch(() => false);
      // a stale failure must not close a newer snapshot stream
      if (generation !== seedGeneration || delivered) return;
      seeding = false;
      // reconnect rather than forwarding live bytes without a usable baseline
      if (transport.open()) transport.close(1011);
    };
    const seedOnce = () => { if (seeded || !transport.open()) return; seeded = true; void reseed(); };
    // the Agent-pane derive: a quiet window after %output takes one deep Capture, feeding the
    // question and Turn parsers; question/metadata go out only on change, at subscribe, and on
    // the on-demand request (Captures and the derive, ADR 0008)
    let lastParseInput: string | undefined;
    let lastQuestion: ShapedQuestion | undefined;
    let lastQuestionKey = '';
    let lastMetadataKey = '';
    let deriving = false;
    let deriveQueued = false;
    let forceQueued = false;
    const runDerive = async (force = false) => {
      if (!derives) return;
      if (deriving) { deriveQueued = true; forceQueued ||= force; return; }
      deriving = true;
      try {
        // never derive for a browser that has lost the control lease
        if (!control.active(sessionId)) return transport.close(1008);
        const captured = await tmux.captureWindow(socketRef, pane, rows, captureVia);
        if (captured === undefined) return;
        // reveal native follow-up questions from live chrome, not isolated assistant text
        if (adapter?.questions?.queued !== undefined) {
          await prompts.openQueuedQuestion(id, captured.text, () => control.active(sessionId) && transport.open()).catch(() => false);
        }
        const parseInput = captured.latestAgentMessage ?? captured.text;
        if (parseInput !== lastParseInput) { lastParseInput = parseInput; const parsed = adapter?.questions?.parse?.(parseInput); lastQuestion = parsed === undefined ? undefined : withQuestionShape(parsed); }
        const question = lastQuestion;
        const metadata = { message: captured.latestAssistantMessage ?? '', overflow: captured.latestAssistantMessageOverflows === true };
        const questionKey = JSON.stringify(question ?? null);
        const metadataKey = JSON.stringify(metadata);
        if (!transport.open()) return;
        if (force || questionKey !== lastQuestionKey) { lastQuestionKey = questionKey; sendFrame({ type: 'question', question: question ?? null }); }
        if (force || metadataKey !== lastMetadataKey) { lastMetadataKey = metadataKey; sendFrame({ type: 'metadata', metadata }); }
      } finally {
        deriving = false;
        if (deriveQueued) { deriveQueued = false; const queued = forceQueued; forceQueued = false; void runDerive(queued); }
      }
    };
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const armDerive = () => {
      if (quietTimer !== undefined || !transport.open()) return;
      quietTimer = setTimeout(() => { quietTimer = undefined; void runDerive(); }, logQuietWindowMs);
    };
    // re-clamp on a layout / attached-client change, and check pane liveness: a gone pane
    // ends the stream with "pane closed" (session death arrives as onExit instead). Liveness
    // is a `#{window_id}` read over the CONTROL connection, not a spawned `tmux.size`: a gone
    // pane yields no window id, while a transient spawn hiccup in the sizing read must not be
    // misread as death and tear down a live stream.
    const reclamp = async () => {
      if (reclamping) return;
      reclamping = true;
      try {
        await windowKeyReady;
        if (!control.active(sessionId)) return transport.close(1008);
        if (await paneClient.windowId(pane) === undefined) { sendFrame({ type: 'exit', reason: 'pane closed' }); return transport.close(1000); }
        if (!viewportEstablished) return;
        const ensured = await viewportLease()?.ensure(cols, rows);
        if (ensured === undefined) return;
        if (!ensured.ok) return transport.close(1011);
        // report the pane's actual size only when it moved (a layout change may leave it put)
        if (ensured.resized) { const after = await tmux.size(socketRef, pane); if (after !== undefined) sendFrame({ type: 'size', cols: after.cols, rows: after.rows }); }
      } finally {
        reclamping = false;
      }
    };
    // Seed only after this task has reported the size, so the browser always gets its
    // `size` before the seed bytes (the client buffers only a small pre-size window and
    // silently drops a large seed that arrives first — a blank pane). Chaining the seed on
    // schedule()'s promise is wrong: a superseded viewport's promise fulfils via the
    // early-return path without ever reporting a size, firing the seed ahead of the winning
    // viewport's size when a mount-time viewport burst coalesces into one read.
    const viewport = new LatestViewportScheduler(
      async (nextCols, nextRows) => {
        await windowKeyReady;
        const lease = viewportLease();
        if (lease === undefined) return false;
        mark('resizeStart');
        const resized = await lease.resize(nextCols, nextRows);
        mark('resizeEnd');
        timing.claim ??= lease.held ? 'held' : 'new';
        const reported = await reportSize();
        // release the first snapshot only after its grid reached the viewer
        if (resized && reported) seedOnce();
        return resized && reported;
      },
      () => {}
    );
    const unsubscribePane = paneClient.subscribe(pane, {
      ...(derives ? { onActivity: armDerive } : {}),
      onOutput: forward,
      onReseed: () => {
        // the first successful viewport owns size-before-seed initialization
        if (!seeded) return;
        sendFrame({ type: 'reseed' });
        void reseed();
      },
      onResize: () => { void reclamp(); },
      onClipboard: (text: string) => sendFrame({ type: 'clipboard', text }),
      onForeground: (command: string) => sendFrame({ type: 'foreground', command }),
      // the session ended or the control client was lost; forward the reason and let the browser reconnect
      onExit: (reason: string) => { sendFrame({ type: 'exit', reason }); transport.close(1011); }
    });
    // route input to the pane byte-exact; the Agent's own pane takes the mutation lock and
    // routes a lone Ctrl+C through queued-prompt cancellation
    // a refused keystroke ends the stream unless a pane mode (a picker) refused it: the
    // stream is fine then, and reconnecting would only loop until the mode is left
    const refused = async () => { if (await tmux.heldPaneMode(socketRef, pane).catch(() => undefined) === undefined) transport.close(1011); };
    const handleInput = async (bytes: Buffer): Promise<void> => {
      if (!isAgentPane) { if (!await paneClient.sendInput(pane, bytes)) await refused(); return; }
      const release = prompts.beginAgentMutation(id);
      // a restart reservation holds the lock; refuse with a policy close (1008), not 1011
      if (release === undefined) { transport.close(1008); return; }
      const isInterrupt = bytes.length === 1 && bytes[0] === 0x03;
      try {
        const ok = isInterrupt
          ? await prompts.cancel(id).then(outcome => outcome === 'not-working' ? paneClient.sendInput(pane, bytes) : outcome === 'ok')
          : await paneClient.sendInput(pane, bytes);
        if (!ok) await refused();
      } finally {
        release();
      }
    };
    let timingLogged = false;
    const processFrame = (raw: unknown) => {
      try {
        const frame = JSON.parse(String(raw));
        if (typeof frame?.type !== 'string') throw new Error();
        if (frame.type === 'viewport') {
          const bounded = boundedViewport(frame);
          if (bounded === undefined) throw new Error();
          if (Number.isInteger(frame.scrollback) && frame.scrollback >= 1 && frame.scrollback <= 5_000) seedDepth = frame.scrollback;
          ({ cols, rows } = bounded);
          mark('viewport');
          viewportEstablished = true;
          void viewport.schedule({ cols, rows, history: 0, onFailure: () => transport.close(1011) });
          return;
        }
        if (frame.type === 'input') {
          if (!control.active(sessionId)) throw new Error();
          if (typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error();
          const bytes = Buffer.from(frame.data, 'base64url');
          if (!bytes.length || bytes.length > 65_536 || bytes.toString('base64url') !== frame.data) throw new Error();
          void handleInput(bytes).catch(() => transport.close(1011));
          return;
        }
        if (frame.type === 'ack') {
          if (!Number.isInteger(frame.bytes) || frame.bytes < 0) throw new Error();
          unacked = Math.max(0, unacked - frame.bytes);
          // recovered from a drop: clear the browser and reseed to the correct screen
          if (dropped && unacked < lowWatermark) { dropped = false; sendFrame({ type: 'reseed' }); void reseed(); }
          return;
        }
        if (frame.type === 'metadata') {
          if (derives) void runDerive(true);
          return;
        }
        // the browser's timeline for this stream: one per connection, and a malformed one is
        // dropped rather than closing the stream
        if (frame.type === 'timing') {
          const client = timingLogged || String(raw).length > maxTimingFrameChars ? undefined : parsePaneTiming(frame);
          timingLogged = true;
          if (client === undefined) return;
          mark('timing');
          void logPaneTiming({ at: new Date().toISOString(), session, pane, kind: isAgentPane ? agent!.kind : 'terminal', server: { ...timing }, client });
          return;
        }
        throw new Error();
      } catch { transport.close(1008); }
    };
    // Setup is done: process anything that queued during it (in arrival order), then send
    // every later frame straight through. No `await` runs between here and the swap, so no
    // frame can slip past unbuffered.
    for (const raw of earlyFrames.splice(0)) processFrame(raw);
    handleRaw = processFrame;
    cleanup = () => { ended = true; if (quietTimer !== undefined) clearTimeout(quietTimer); unsubscribePane(); if (paneViewport !== undefined) void paneViewport.release(); };
    // carry the derive once at subscribe, before any %output
    if (derives) void runDerive(true);
  };
  const settled = setup().catch(() => transport.close(1008));
  return {
    receive: raw => { mark('firstMessage'); handleRaw(raw); },
    closed: () => { cleanup?.(); },
    settled
  };
}
