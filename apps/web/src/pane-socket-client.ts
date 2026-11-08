import type { PaneClientFrame, PaneConnector, PaneServerFrame } from './pane-stream.js';

// The real transport behind the streamed terminal's `PaneConnector` seam: one
// `/ws/pane/:id` WebSocket per subscribe, opened with a freshly minted single-use
// `pane` ticket as the second subprotocol (the pattern every socket uses). Binary
// frames are raw pane bytes; text frames are the JSON server frames. The component
// drives this; tests drive a scripted connector instead (streamed-terminal-fixture).
//
// `request` is injected rather than imported so this module stays free of the app's
// internals and can be exercised on its own. It is the app's fetch wrapper.
type Request = (url: string, init?: RequestInit) => Promise<Response>;

// The pane socket for a target id, optionally naming a specific pane of its set (the
// server defaults an Agent target to its own pane; a Worktree target must name one).
const paneSocketUrl = (id: string, pane?: string): string =>
  `${location.origin.replace(/^http/u, 'ws')}/ws/pane/${encodeURIComponent(id)}${pane === undefined ? '' : `?pane=${encodeURIComponent(pane)}`}`;

// pane sockets constructed but not yet open or closed, across the page: Firefox lets only one
// WebSocket handshake per server IP proceed at a time, so this explains slow opens
let connectingSockets = 0;

// Shared connector body: mint a single-use `pane` ticket from `ticketPath`, then open the
// pane socket for `target` (optionally a specific `pane`) with the ticket as the second
// subprotocol. Each call mints its own ticket, so a reconnect never replays a spent one.
const createPaneConnector = (target: string, pane: string | undefined, ticketPath: string, request: Request): PaneConnector => handlers => {
  let socket: WebSocket | undefined;
  let closed = false;
  // Frames the component sends before the socket is open (its first `viewport` can be
  // proposed from a render that precedes the open) wait here and flush on open, in order.
  const outbox: PaneClientFrame[] = [];
  const flush = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    while (outbox.length > 0) socket.send(JSON.stringify(outbox.shift()!));
  };

  void (async () => {
    try {
      const response = await request(ticketPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'pane' })
      });
      if (!response.ok) throw new Error('pane ticket unavailable');
      const { ticket } = await response.json();
      if (closed) return;
      handlers.onSocket?.(connectingSockets);
      const ws = new WebSocket(paneSocketUrl(target, pane), ['rac', ticket]);
      let connecting = true;
      connectingSockets += 1;
      const settle = () => { if (connecting) { connecting = false; connectingSockets -= 1; } };
      ws.binaryType = 'arraybuffer';
      socket = ws;
      ws.onopen = () => { settle(); if (!closed && socket === ws) { handlers.onOpen(); flush(); } };
      ws.onmessage = event => {
        if (closed || socket !== ws) return;
        if (event.data instanceof ArrayBuffer) { handlers.onBytes(new Uint8Array(event.data)); return; }
        // A non-JSON text frame is not part of the contract; drop it rather than throw.
        try { handlers.onFrame(JSON.parse(String(event.data)) as PaneServerFrame); } catch { /* ignore malformed */ }
      };
      ws.onclose = event => {
        settle();
        if (closed || socket !== ws) return;
        socket = undefined;
        handlers.onClose({ code: event.code, reason: event.reason });
      };
      ws.onerror = () => ws.close();
    } catch {
      // A failed mint or open reads as a lost connection, so the component shows its
      // reconnecting status and subscribes again after its delay.
      if (!closed) handlers.onClose({ code: 1006, reason: 'connection failed' });
    }
  })();

  return {
    send: frame => { outbox.push(frame); flush(); },
    close: () => {
      closed = true;
      const current = socket;
      socket = undefined;
      current?.close();
    }
  };
};

// Opens Agent pane connections: the target is the Agent id and the stream is its own
// pane (the server defaults to it), the ticket minted from the Agent's route.
export const createAgentPaneConnector = (id: string, request: Request): PaneConnector =>
  createPaneConnector(id, undefined, `/api/agents/${encodeURIComponent(id)}/tickets`, request);

// Opens a Terminal's pane connection: the target is the Worktree and the stream is one of
// its panes (a Console shell, a hand-split pane, or any pane of its Agent's session), the
// ticket minted from the Worktree's route (spec "The pane socket", Worktree-keyed form).
export const createWorktreePaneConnector = (worktreeId: string, paneId: string, request: Request): PaneConnector =>
  createPaneConnector(worktreeId, paneId, `/api/worktrees/${encodeURIComponent(worktreeId)}/tickets`, request);
