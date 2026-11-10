import type { Page } from '@playwright/test';

// The shared binary-capable mock WebSocket for the streamed Agent panel. Every app-level
// spec that drives the panel installs this in place of its own private mock: it overrides
// `window.WebSocket` so the page's `/ws/panes` socket is scripted — it plays the server's side
// of the multiplexed protocol, keeping each stream the page opens by its pane id (the `open`
// frame's `pane`, else its target), delivering raw pane bytes as `arraybuffer` binary frames
// behind the stream id and JSON server frames as text — and captures the JSON frames each
// stream sends back. The spec drives it through `window.__pane`, which the helpers below wrap
// with a typed, `page`-bound API.
//
// It is a self-contained function so Playwright can serialise it into an init script (it
// closes over no module scope); the app opens the pane socket only after minting a `panes`
// ticket, so each spec must also fulfil `POST /api/panes/ticket` with `{ ticket }`.

export function installPaneStreamMock(): void {
  type MockStream = { socket: MockPaneSocket; id: number; paneId: string };
  // live streams per pane id, newest last
  const paneStreams = new Map<string, MockStream[]>();
  const connectCounts = new Map<string, number>();
  // Frames the panel has sent for an id, across every stream it opened (so a remount
  // reopening the pane keeps accumulating rather than resetting).
  const sentByPane = new Map<string, string[]>();
  const paneSockets: MockPaneSocket[] = [];

  class MockPaneSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    binaryType: 'blob' | 'arraybuffer' = 'blob';
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly streams = new Map<number, MockStream>();

    constructor(url: string | URL) {
      this.url = String(url);
      // other sockets (the dashboard's) are inert
      if (/\/ws\/panes$/u.test(this.url)) paneSockets.push(this);
      // Open on the next browser task, as a real socket would.
      window.setTimeout(() => {
        if (this.readyState !== MockPaneSocket.CONNECTING) return;
        this.readyState = MockPaneSocket.OPEN;
        this.onopen?.(new Event('open'));
      });
    }

    private forget(stream: MockStream) {
      this.streams.delete(stream.id);
      const list = paneStreams.get(stream.paneId);
      const index = list?.indexOf(stream) ?? -1;
      if (list && index >= 0) list.splice(index, 1);
    }

    send(data: string) {
      if (!paneSockets.includes(this)) return;
      const { stream: id, ...frame } = JSON.parse(data) as { stream: number; type?: string; target?: string; pane?: string; cols?: number; rows?: number };
      if (frame.type === 'open') {
        const stream = { socket: this, id, paneId: frame.pane ?? frame.target! };
        this.streams.set(id, stream);
        paneStreams.set(stream.paneId, [...paneStreams.get(stream.paneId) ?? [], stream]);
        connectCounts.set(stream.paneId, (connectCounts.get(stream.paneId) ?? 0) + 1);
        return;
      }
      const stream = this.streams.get(id);
      if (stream === undefined) return;
      if (frame.type === 'close') { this.forget(stream); return; }
      const log = sentByPane.get(stream.paneId) ?? [];
      log.push(JSON.stringify(frame));
      sentByPane.set(stream.paneId, log);
      // A single-client server arbitrates the pane to the browser's requested grid, so
      // echo every `viewport` back as a `size`. This keeps the terminal conforming to the
      // panel as it resizes (a split view opening, the font changing), like the console.
      if (frame.type === 'viewport' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
        const { cols, rows } = frame;
        window.setTimeout(() => this.deliver(stream, JSON.stringify({ type: 'size', cols, rows, stream: id })));
      }
    }

    deliver(stream: MockStream, data: string | ArrayBuffer) {
      if (this.readyState !== MockPaneSocket.OPEN || this.streams.get(stream.id) !== stream) return;
      this.onmessage?.(new MessageEvent('message', { data }));
    }

    close() { this.drop(1005, ''); }

    // Test-only: drop the connection as a lost socket would, with a code and reason.
    drop(code: number, reason: string) {
      if (this.readyState === MockPaneSocket.CLOSED) return;
      this.readyState = MockPaneSocket.CLOSED;
      for (const stream of [...this.streams.values()]) this.forget(stream);
      this.onclose?.(new CloseEvent('close', { code, reason }));
    }

    // Test-only: the server ends one stream, as a pane socket of its own closed once did.
    end(stream: MockStream, code: number) {
      this.deliver(stream, JSON.stringify({ type: 'closed', stream: stream.id, code }));
      this.forget(stream);
    }
  }

  Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockPaneSocket });

  const live = (id: string): MockStream | undefined => paneStreams.get(id)?.at(-1);
  const deliverFrame = (id: string, frame: Record<string, unknown>) => {
    const stream = live(id);
    stream?.socket.deliver(stream, JSON.stringify({ ...frame, stream: stream.id }));
  };
  const deliverBytes = (id: string, bytes: Uint8Array) => {
    const stream = live(id);
    if (stream === undefined) return;
    const framed = new Uint8Array(4 + bytes.length);
    new DataView(framed.buffer).setUint32(0, stream.id);
    framed.set(bytes, 4);
    stream.socket.deliver(stream, framed.buffer);
  };
  const decodeInput = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/gu, '+').replace(/_/gu, '/')), character => character.charCodeAt(0)));
  const parsedSent = (id: string) => (sentByPane.get(id) ?? []).map(raw => JSON.parse(raw) as Record<string, unknown>);
  const inputFrames = (id: string) => parsedSent(id).filter(frame => frame.type === 'input');

  Object.defineProperty(window, '__pane', {
    configurable: true,
    value: {
      // Pane ids with an open stream right now.
      openIds: () => [...paneStreams.entries()].filter(([, list]) => list.some(stream => stream.socket.readyState === MockPaneSocket.OPEN)).map(([id]) => id),
      ready: (id: string) => live(id)?.socket.readyState === MockPaneSocket.OPEN,
      // Streams ever opened for this id (grows on reconnect).
      connectCount: (id: string) => connectCounts.get(id) ?? 0,
      // Pane sockets ever constructed, and how many are open now.
      socketCount: () => paneSockets.length,
      openSocketCount: () => paneSockets.filter(socket => socket.readyState === MockPaneSocket.OPEN).length,
      // Server → browser.
      size: (id: string, cols: number, rows: number) => deliverFrame(id, { type: 'size', cols, rows }),
      bytes: (id: string, text: string) => deliverBytes(id, new TextEncoder().encode(text)),
      frame: (id: string, frame: Record<string, unknown>) => deliverFrame(id, frame),
      question: (id: string, question: unknown) => deliverFrame(id, { type: 'question', question }),
      metadata: (id: string, message: string, overflow: boolean) => deliverFrame(id, { type: 'metadata', metadata: { message, overflow } }),
      reseed: (id: string) => deliverFrame(id, { type: 'reseed' }),
      exit: (id: string, reason: string) => deliverFrame(id, { type: 'exit', reason }),
      // end this pane's stream with a close code; the shared socket stays up
      drop: (id: string, code: number) => { const stream = live(id); stream?.socket.end(stream, code); },
      // drop the whole shared socket under every stream
      dropSocket: (code: number, reason: string) => paneSockets.at(-1)?.drop(code, reason),
      // Browser → server (what the panel sent).
      frameTypes: (id: string) => parsedSent(id).map(frame => frame.type as string),
      lastViewport: (id: string) => parsedSent(id).filter(frame => frame.type === 'viewport').at(-1),
      inputText: (id: string) => inputFrames(id).map(frame => decodeInput(String(frame.data))).join(''),
      inputList: (id: string) => inputFrames(id).map(frame => decodeInput(String(frame.data))),
      inputCount: (id: string) => inputFrames(id).length,
      ackTotal: (id: string) => parsedSent(id).filter(frame => frame.type === 'ack').reduce((sum, frame) => sum + Number(frame.bytes), 0)
    }
  });
}

// --- Typed, page-bound accessors for specs -------------------------------------------

interface PaneApi {
  openIds: () => string[];
  ready: (id: string) => boolean;
  connectCount: (id: string) => number;
  socketCount: () => number;
  openSocketCount: () => number;
  size: (id: string, cols: number, rows: number) => void;
  bytes: (id: string, text: string) => void;
  frame: (id: string, frame: unknown) => void;
  question: (id: string, question: unknown) => void;
  metadata: (id: string, message: string, overflow: boolean) => void;
  reseed: (id: string) => void;
  exit: (id: string, reason: string) => void;
  drop: (id: string, code: number) => void;
  dropSocket: (code: number, reason: string) => void;
  frameTypes: (id: string) => string[];
  lastViewport: (id: string) => { cols: number; rows: number; scrollback: number } | undefined;
  inputText: (id: string) => string;
  inputList: (id: string) => string[];
  inputCount: (id: string) => number;
  ackTotal: (id: string) => number;
}

// `page.evaluate` callbacks run in the browser, so each reaches `window.__pane` directly
// rather than through a Node-side helper (a free variable would not serialise).
type PaneWindow = { __pane: PaneApi };

// call once before navigation; keep legacy DOM unless testing product defaults
export const installPaneMock = async (page: Page, { preserveWebglDefault = false }: { preserveWebglDefault?: boolean } = {}) => {
  // leave product defaults untouched for GPU cases
  if (!preserveWebglDefault) await page.addInitScript(() => {
    try {
      // preserve explicit seeds regardless of init-script order
      if (localStorage.getItem('rac.terminal-webgl') === null) localStorage.setItem('rac.terminal-webgl', 'disabled');
    } catch { /* denied storage must not block the socket mock */ }
  });
  await page.addInitScript(installPaneStreamMock);
};

// Wait until the panel has opened a pane stream for `id`, then push the first size so the
// seed can be applied at the browser's grid.
export const seedPaneSize = async (page: Page, id: string, cols = 80, rows = 24) => {
  await page.waitForFunction(paneId => (window as unknown as PaneWindow).__pane.ready(paneId), id);
  await page.evaluate(({ id, cols, rows }) => (window as unknown as PaneWindow).__pane.size(id, cols, rows), { id, cols, rows });
};

export const pushBytes = (page: Page, id: string, text: string) => page.evaluate(({ id, text }) => (window as unknown as PaneWindow).__pane.bytes(id, text), { id, text });
export const pushQuestion = (page: Page, id: string, question: unknown) => page.evaluate(({ id, question }) => (window as unknown as PaneWindow).__pane.question(id, question), { id, question });
export const pushMetadata = (page: Page, id: string, message: string, overflow = false) => page.evaluate(({ id, message, overflow }) => (window as unknown as PaneWindow).__pane.metadata(id, message, overflow), { id, message, overflow });
export const pushExit = (page: Page, id: string, reason: string) => page.evaluate(({ id, reason }) => (window as unknown as PaneWindow).__pane.exit(id, reason), { id, reason });
export const dropPane = (page: Page, id: string, code = 1006) => page.evaluate(({ id, code }) => (window as unknown as PaneWindow).__pane.drop(id, code), { id, code });
export const dropPaneSocket = (page: Page, code = 1006, reason = 'lost') => page.evaluate(({ code, reason }) => (window as unknown as PaneWindow).__pane.dropSocket(code, reason), { code, reason });
export const paneSocketCount = (page: Page) => page.evaluate(() => (window as unknown as PaneWindow).__pane.socketCount());
export const openPaneSocketCount = (page: Page) => page.evaluate(() => (window as unknown as PaneWindow).__pane.openSocketCount());
export const paneConnectCount = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.connectCount(id), id);
export const paneInputText = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.inputText(id), id);
export const paneInputList = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.inputList(id), id);
export const paneInputCount = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.inputCount(id), id);
export const paneFrameTypes = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.frameTypes(id), id);
export const paneLastViewport = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.lastViewport(id), id);
export const paneAckTotal = (page: Page, id: string) => page.evaluate(id => (window as unknown as PaneWindow).__pane.ackTotal(id), id);
