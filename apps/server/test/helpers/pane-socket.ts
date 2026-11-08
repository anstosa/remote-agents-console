import type { TicketStore } from '../../src/auth/tickets.js';

// A browser's `/ws/panes` socket for tests: opens streams on it and splits what comes back
// per stream, so a test reads one stream's JSON frames (without their `stream` id), its pane
// bytes (without their 4-byte header) and how it ended, as it would a socket of its own.

export type PaneStreamProbe = {
  frames: Record<string, unknown>[];
  binary: Buffer[];
  // every message in arrival order, so a test can assert the seed never precedes its size
  order: string[];
  send: (frame: Record<string, unknown>) => void;
  close: () => void;
  // the code of the stream's `closed` frame, else the socket's close code
  closeCode: () => number | undefined;
};

export async function openPaneSocket(port: number, tickets: TicketStore, options: { ack?: boolean } = {}) {
  const ticket = tickets.mint('session', 'panes', 'panes').id;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/panes`, ['rac', ticket]);
  ws.binaryType = 'arraybuffer';
  const streams = new Map<number, { probe: PaneStreamProbe; closed?: number }>();
  const unknown: unknown[] = [];
  let socketClose: number | undefined;
  const send = (frame: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };
  ws.addEventListener('message', event => {
    const data = (event as MessageEvent).data;
    if (typeof data === 'string') {
      const { stream, ...frame } = JSON.parse(data) as Record<string, unknown>;
      const entry = streams.get(stream as number);
      if (entry === undefined) { unknown.push(data); return; }
      if (frame.type === 'closed') { entry.closed ??= frame.code as number; return; }
      entry.probe.frames.push(frame);
      entry.probe.order.push(`frame:${String(frame.type)}`);
      return;
    }
    const bytes = Buffer.from(data as ArrayBuffer);
    const stream = bytes.readUInt32BE(0);
    const entry = streams.get(stream);
    if (entry === undefined) { unknown.push(bytes); return; }
    const chunk = bytes.subarray(4);
    entry.probe.binary.push(chunk);
    entry.probe.order.push('binary');
    if (options.ack) send({ type: 'ack', bytes: chunk.length, stream });
  });
  ws.addEventListener('close', event => { socketClose = (event as CloseEvent).code; });
  await new Promise<void>(resolve => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('close', () => resolve());
    ws.addEventListener('error', () => resolve());
  });
  // open stream `id` of `target` (and `pane`); `then` goes out right behind the open, while the
  // server is still resolving the target
  const stream = (id: number, target: string, pane?: string, then?: Record<string, unknown>): PaneStreamProbe => {
    const entry: { probe: PaneStreamProbe; closed?: number } = {
      probe: {
        frames: [],
        binary: [],
        order: [],
        send: frame => send({ ...frame, stream: id }),
        close: () => send({ type: 'close', stream: id }),
        closeCode: () => entry.closed ?? socketClose
      }
    };
    streams.set(id, entry);
    send({ type: 'open', stream: id, target, ...(pane === undefined ? {} : { pane }) });
    if (then !== undefined) entry.probe.send(then);
    return entry.probe;
  };
  return { ws, stream, send, sendRaw: (data: string | Buffer) => ws.send(data), closeCode: () => socketClose, unknown };
}
