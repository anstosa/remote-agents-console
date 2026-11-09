import type { PaneClientFrame, PaneConnectionHandlers, PaneConnector, PaneServerFrame, PaneSharedSocket } from './pane-stream.js';

// The real transport behind the streamed terminal's `PaneConnector` seam: every pane stream
// of the page rides one `/ws/panes` WebSocket (spec "The pane socket"), opened with a freshly
// minted single-use `panes` ticket as the second subprotocol (the pattern every socket uses).
// A stream is `{type:'open', stream, target, pane?}` … `{type:'close', stream}`; every other
// JSON frame both ways carries its `stream` id, binary frames are pane bytes behind a 4-byte
// big-endian stream id, and `{type:'closed', stream, code}` is the server ending one stream.
// The component drives this; tests drive a scripted connector instead (streamed-terminal-fixture).
//
// `request` is injected rather than imported so this module stays free of the app's
// internals and can be exercised on its own. It is the app's fetch wrapper.
type Request = (url: string, init?: RequestInit) => Promise<Response>;

type Stream = { handlers: PaneConnectionHandlers; open: Record<string, unknown>; outbox: PaneClientFrame[]; sent: boolean };
type Attempt = { ws?: WebSocket; open: boolean };

// The shared socket opens with the first stream, holds stream opens while it connects, and
// closes `idleCloseMs` after its last stream ends, so a workspace switch (old streams close,
// new ones open), or a minute on a Workspace with no panes, keeps it. When it drops, every
// stream gets `onClose` with the socket's code, and their reconnects open it again once.
export const createPaneMux = (request: Request, idleCloseMs = 60_000) => {
  const streams = new Map<number, Stream>();
  let nextStream = 1;
  let current: Attempt | undefined;
  let idleTimer: number | undefined;

  const write = (frame: Record<string, unknown>) => current?.ws?.send(JSON.stringify(frame));
  // put a stream on the wire once the socket is open: its `open`, then what it queued
  const begin = (id: number, stream: Stream) => {
    if (stream.sent || streams.get(id) !== stream || current?.open !== true) return;
    stream.sent = true;
    write(stream.open);
    for (const frame of stream.outbox.splice(0)) write({ ...frame, stream: id });
    stream.handlers.onOpen();
  };
  const scheduleIdleClose = () => {
    if (streams.size > 0 || current === undefined || idleTimer !== undefined) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = undefined;
      if (streams.size > 0) return;
      const idle = current;
      current = undefined;
      idle?.ws?.close();
    }, idleCloseMs);
  };
  // the socket is gone, or never came up: every stream ends with its close
  const drop = (code: number, reason: string) => {
    current = undefined;
    const ended = [...streams.values()];
    streams.clear();
    for (const stream of ended) stream.handlers.onClose({ code, reason });
  };
  const receive = (data: unknown) => {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 4) return;
      streams.get(new DataView(data).getUint32(0))?.handlers.onBytes(new Uint8Array(data, 4));
      return;
    }
    // A non-JSON text frame is not part of the contract; drop it rather than throw.
    let frame: { stream?: unknown; type?: unknown; code?: unknown };
    try { frame = JSON.parse(String(data)) as typeof frame; } catch { return; }
    const stream = typeof frame?.stream === 'number' ? streams.get(frame.stream) : undefined;
    // a stream this page closed may still have frames in flight
    if (stream === undefined) return;
    if (frame.type === 'closed') {
      streams.delete(frame.stream as number);
      stream.handlers.onClose({ code: typeof frame.code === 'number' ? frame.code : 1006, reason: '' });
      scheduleIdleClose();
      return;
    }
    stream.handlers.onFrame(frame as PaneServerFrame);
  };
  const connectSocket = () => {
    const attempt: Attempt = { open: false };
    current = attempt;
    void (async () => {
      try {
        const response = await request('/api/panes/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error('pane ticket unavailable');
        const { ticket } = await response.json();
        if (current !== attempt) return;
        const ws = new WebSocket(`${location.origin.replace(/^http/u, 'ws')}/ws/panes`, ['rac', ticket]);
        ws.binaryType = 'arraybuffer';
        attempt.ws = ws;
        ws.onopen = () => {
          if (current !== attempt) return;
          attempt.open = true;
          for (const [id, stream] of streams) begin(id, stream);
        };
        ws.onmessage = event => { if (current === attempt) receive(event.data); };
        ws.onclose = event => { if (current === attempt) drop(event.code, event.reason); };
        ws.onerror = () => ws.close();
      } catch {
        // A failed mint or open reads as a lost connection, so each component shows its
        // reconnecting status and subscribes again after its delay.
        if (current === attempt) drop(1006, 'connection failed');
      }
    })();
  };

  // a connector for streams of `target` (an Agent or a Place id), optionally naming one `pane`
  // of its set
  return (target: string, pane?: string): PaneConnector => handlers => {
    const id = nextStream++;
    const stream: Stream = { handlers, open: { type: 'open', stream: id, target, ...(pane === undefined ? {} : { pane }) }, outbox: [], sent: false };
    window.clearTimeout(idleTimer);
    idleTimer = undefined;
    const shared: PaneSharedSocket = current === undefined ? 'new' : current.open ? 'open' : 'connecting';
    streams.set(id, stream);
    handlers.onSocket?.(shared);
    if (current === undefined) connectSocket();
    // never call back into the component before `connect` has returned its connection
    else queueMicrotask(() => begin(id, stream));
    return {
      send: frame => {
        if (streams.get(id) !== stream) return;
        if (stream.sent) write({ ...frame, stream: id }); else stream.outbox.push(frame);
      },
      close: () => {
        if (streams.get(id) !== stream) return;
        streams.delete(id);
        if (stream.sent) write({ type: 'close', stream: id });
        scheduleIdleClose();
      }
    };
  };
};

let pageMux: ReturnType<typeof createPaneMux> | undefined;

// Opens Agent pane connections: the target is the Agent id and the stream is its own
// pane (the server defaults to it).
export const createAgentPaneConnector = (id: string, request: Request): PaneConnector =>
  (pageMux ??= createPaneMux(request))(id);

// Opens a Terminal's pane connection: the target is the Worktree and the stream is one of
// its panes (a Console shell, a hand-split pane, or any pane of its Agent's session; spec
// "The pane socket", Worktree-keyed form).
export const createWorktreePaneConnector = (worktreeId: string, paneId: string, request: Request): PaneConnector =>
  (pageMux ??= createPaneMux(request))(worktreeId, paneId);
