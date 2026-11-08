// The wire contract for a Pane stream (spec "The pane socket"). A stream delivers the
// pane's raw bytes as binary frames — the seed first, then live output — and JSON frames
// for everything else; the browser sends JSON frames back. Every stream of the page
// shares one WebSocket (pane-socket-client.ts adds the stream ids). The component is built against this contract; the server side is built in
// parallel ("Pane socket streams the Agent pane") and the two meet in "Agent Panel
// switches to the Pane stream". The transport is abstracted behind `PaneConnector`
// so the component can be driven by a real WebSocket in the app and by a scripted
// socket in tests.

// the latest assistant response and capture overflow feed notes
// the derive owns the shape; the component only forwards it
export interface PaneMetadata {
  message: string;
  overflow: boolean;
}

// Browser → server.
export type PaneClientFrame =
  // The panel's grid and scrollback depth: a request the console arbitrates (the
  // Size claim). The browser always conforms to the `size` it gets back.
  | { type: 'viewport'; cols: number; rows: number; scrollback: number }
  // Bytes typed into the pane, base64url of the UTF-8 encoding, at most 64 KiB decoded.
  | { type: 'input'; data: string }
  // Bytes consumed since the last ack, for the server's drop-while-behind flow control.
  | { type: 'ack'; bytes: number }
  // Ask the Agent pane's derive to resend the current question and metadata.
  | { type: 'metadata' }
  // This stream's connection timeline, sent once after its first seed is parsed; the server
  // logs it with its own steps to pane-timing.jsonl.
  | ({ type: 'timing' } & PaneTiming);

// The page's shared pane socket when a stream was requested: already open, still connecting
// (minting its ticket or mid-handshake), or opened for this stream.
export type PaneSharedSocket = 'open' | 'connecting' | 'new';

// Milliseconds from the attempt's start (performance.now() offsets), except `page`, whose
// values are offsets from page load and which only the page's first timing frame carries.
// `socket` is the stream requested and `open` its `open` frame sent on the shared socket, so
// `open - socket` is the wait for that socket (none when it was already open).
export interface PaneTiming {
  attempt: 'initial' | 'reconnect' | 'revisit';
  sincePageLoad: number;
  sharedSocket?: PaneSharedSocket;
  renderer: 'webgl' | 'dom';
  browser: 'firefox' | 'chrome' | 'safari' | 'other';
  mobile: boolean;
  seedBytes?: number;
  marks: Partial<Record<'socket' | 'open' | 'viewport' | 'firstFrame' | 'seed' | 'parsed' | 'cover' | 'painted', number>>;
  page?: Partial<Record<'responseEnd' | 'domContentLoaded' | 'session' | 'dashboard', number>>;
}

// Server → browser (the JSON frames; raw pane bytes arrive as binary frames).
export type PaneServerFrame =
  // The pane's actual columns and rows, after every apply and every layout change.
  | { type: 'size'; cols: number; rows: number }
  // Drop everything and await a fresh seed (flow-control recovery or `%pause`).
  | { type: 'reseed' }
  // The stream ended; `reason` is pane closed, session ended or control client lost.
  | { type: 'exit'; reason: string }
  // The Agent pane's current Inline question, or null when there is none.
  | { type: 'question'; question: unknown }
  // The Agent pane's latest Turn.
  | { type: 'metadata'; metadata: PaneMetadata }
  // Text copied in a pane of the session (OSC 52 or a tmux copy-mode yank).
  | { type: 'clipboard'; text: string }
  // The pane's foreground command (tmux `pane_current_command`), on subscribe and on change.
  | { type: 'foreground'; command: string };

export interface PaneConnectionHandlers {
  // the stream was requested, with the shared socket's state at that moment
  onSocket?: (shared: PaneSharedSocket) => void;
  // the stream is on the wire; frames sent from here go straight out
  onOpen: () => void;
  onBytes: (bytes: Uint8Array) => void;
  onFrame: (frame: PaneServerFrame) => void;
  onClose: (info: { code: number; reason: string }) => void;
}

export interface PaneConnection {
  send: (frame: PaneClientFrame) => void;
  close: () => void;
}

// Opens one pane connection, wiring the handlers, and returns the control side. The
// component calls it once per subscribe (including every reconnect).
export type PaneConnector = (handlers: PaneConnectionHandlers) => PaneConnection;

// The most bytes one input frame may carry decoded (spec "The pane socket"); larger
// input is split across frames, which the server replays in order onto the pane.
export const maxInputFrameBytes = 64 * 1024;

// base64url of raw bytes. Assembled in 32 KiB windows so a large paste cannot overflow
// the argument list of `String.fromCharCode`.
export const encodeInputBytes = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

// base64url of a string's UTF-8 bytes, the encoding the input frame carries (same as
// the Log viewer's interactive socket).
export const encodePaneInput = (data: string): string => encodeInputBytes(new TextEncoder().encode(data));
