// The tmux control-mode wire protocol, parsed as a stream of lines into typed
// events. Control mode is a line-oriented text protocol: a command's reply is a
// `%begin`/`%end` (or `%error`) block, and between blocks tmux emits notifications
// — `%output` for pane bytes, `%pause`/`%continue`, `%exit`, and others this slice
// ignores. See docs/research/tmux-pane-io-options.md §3.1 and the block parser in
// docs/research/probes/tmux-io-probe.mjs. This module is pure: it is fed bytes and
// emits events, so it can be unit-tested without a tmux server.

// a completed command block: its output lines, and whether it ended with %end (ok) or %error
export type CommandReply = { ok: boolean; lines: string[] };
export type ControlEvent =
  // `data` is the raw (still octal-escaped) %output value; a consumer that needs the
  // bytes calls decodeControlOutput. This slice only needs "the pane changed", so it
  // does not pay to decode every %output.
  | ({ type: 'block' } & CommandReply)
  | { type: 'output'; pane: string; data: string }
  | { type: 'pause'; pane: string }
  | { type: 'continue'; pane: string }
  // a window's layout changed (external resize, zoom or unzoom) or a window closed (a
  // pane killed, taking its last pane with it); the viewer re-asserts its Size claim and,
  // finding a gone pane, ends its stream
  | { type: 'layout'; window: string }
  // a `refresh-client -B` format subscription changed (a terminal attached, detached or resized);
  // the viewer re-clamps. Only the name routes the change — the value is a signal, never read —
  // and tmux reports it at most once a second.
  | { type: 'subscription'; name: string }
  // a paste buffer was created or replaced (a copy in a pane, or a load-buffer/set-buffer)
  | { type: 'paste-buffer'; name: string }
  | { type: 'exit'; reason: string };

const beginPattern = /^%begin \d+ (\d+)/u;
// a command's reply ends with the %end/%error carrying its %begin command number
const endPattern = /^%(end|error) \d+ (\d+)/u;
// a control line is always newline-terminated; an unterminated remainder past this is a
// broken stream, dropped so it cannot grow the pending buffer without bound
const maxPendingBytes = 8 * 1024 * 1024;
// a real reply block is bounded by the capture depth (<=5000 lines); a block that grows
// far past that is a desynced/forged stream, so end it and let the client reconnect
const maxBlockLines = 100_000;

/**
 * Decode a `%output` value into the exact bytes the pane produced. The value is a
 * latin1 string (one JS char per byte, so bytes are preserved 1:1). tmux escapes a
 * backslash and every byte below 0x20 as a three-digit octal `\ooo`; every other
 * byte — printable ASCII and the 0x80–0xff bytes of a UTF-8 sequence — is verbatim
 * (control.c). Decoding at the byte level, and never as UTF-8 here, lets a
 * multi-byte character split across two `%output` notifications reassemble once the
 * decoded buffers are concatenated.
 */
export function decodeControlOutput(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c && index + 3 < value.length) {
      const a = value.charCodeAt(index + 1);
      const b = value.charCodeAt(index + 2);
      const c = value.charCodeAt(index + 3);
      const isOctalDigit = (n: number) => n >= 0x30 && n <= 0x37;
      if (isOctalDigit(a) && isOctalDigit(b) && isOctalDigit(c)) {
        bytes.push(((a - 0x30) << 6) | ((b - 0x30) << 3) | (c - 0x30));
        index += 3;
        continue;
      }
    }
    bytes.push(code & 0xff);
  }
  return Buffer.from(bytes);
}

export class ControlProtocolParser {
  private buffer: Buffer = Buffer.alloc(0);
  // the lines collected since the current block's %begin, or null between blocks
  private block: string[] | null = null;
  // the command number of the open block, matched against its %end/%error
  private blockNumber = '';

  constructor(private readonly emit: (event: ControlEvent) => void) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      let end = newline;
      // tolerate CRLF as well as LF line endings
      if (end > 0 && this.buffer[end - 1] === 0x0d) end -= 1;
      const line = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(newline + 1);
      this.handleLine(line);
    }
    // the remainder is one partial line; a real one is small, so an oversized one is a
    // broken stream — drop it rather than accumulate without bound
    if (this.buffer.length > maxPendingBytes) this.buffer = Buffer.alloc(0);
  }

  private handleLine(line: string): void {
    if (this.block !== null) {
      const terminator = endPattern.exec(line);
      // only the %end/%error whose command number matches this block closes it, so a
      // captured pane line that starts with "%end " is kept as reply text
      if (terminator !== null && terminator[2] === this.blockNumber) {
        const lines = this.block;
        this.block = null;
        this.blockNumber = '';
        this.emit({ type: 'block', ok: terminator[1] === 'end', lines });
        return;
      }
      // a block that never closes (a desynced or forged stream) would accumulate every
      // line; end the connection instead so viewers reconnect on a fresh client
      if (this.block.length >= maxBlockLines) {
        this.block = null;
        this.blockNumber = '';
        this.emit({ type: 'exit', reason: 'control block overflow' });
        return;
      }
      this.block.push(line);
      return;
    }
    const begin = beginPattern.exec(line);
    if (begin !== null) {
      this.block = [];
      this.blockNumber = begin[1]!;
      return;
    }
    if (line.startsWith('%output ')) return this.emitOutput(line.slice('%output '.length));
    if (line.startsWith('%extended-output ')) return this.emitExtendedOutput(line.slice('%extended-output '.length));
    if (line.startsWith('%pause ')) return this.emit({ type: 'pause', pane: line.slice('%pause '.length).trim() });
    if (line.startsWith('%continue ')) return this.emit({ type: 'continue', pane: line.slice('%continue '.length).trim() });
    if (line.startsWith('%layout-change ')) return this.emitLayout(line.slice('%layout-change '.length));
    // A window went away because its last pane closed (a Console shell exiting on its own or
    // being killed). tmux reports a linked window as %window-close and a background one as
    // %unlinked-window-close; re-check either as a layout change so the viewer finds its pane
    // gone and ends the stream with "pane closed".
    if (line.startsWith('%window-close ')) return this.emitLayout(line.slice('%window-close '.length));
    if (line.startsWith('%unlinked-window-close ')) return this.emitLayout(line.slice('%unlinked-window-close '.length));
    if (line.startsWith('%subscription-changed ')) return this.emitSubscription(line.slice('%subscription-changed '.length));
    if (line.startsWith('%paste-buffer-changed ')) return this.emit({ type: 'paste-buffer', name: line.slice('%paste-buffer-changed '.length).trim() });
    if (line === '%exit' || line.startsWith('%exit ')) {
      return this.emit({ type: 'exit', reason: line.slice('%exit'.length).trim() || 'server exited' });
    }
    // %window-*, %session-*, %client-* and the rest are not acted on
  }

  // %layout-change window-id layout visible-layout flags
  private emitLayout(rest: string): void {
    const window = rest.split(' ', 1)[0] ?? '';
    if (window !== '') this.emit({ type: 'layout', window });
  }

  // %subscription-changed name [context] : value — the name is the first token and is all the
  // viewer needs to route the change; the value that follows is a change signal, never read
  private emitSubscription(rest: string): void {
    const name = rest.split(' ', 1)[0] ?? '';
    if (name !== '') this.emit({ type: 'subscription', name });
  }

  // %output pane-id value
  private emitOutput(rest: string): void {
    const space = rest.indexOf(' ');
    if (space < 0) return;
    this.emit({ type: 'output', pane: rest.slice(0, space), data: rest.slice(space + 1) });
  }

  // %extended-output pane-id age <flags> : value  (sent instead of %output under pause-after)
  private emitExtendedOutput(rest: string): void {
    const space = rest.indexOf(' ');
    const marker = rest.indexOf(' : ');
    if (space < 0 || marker < 0) return;
    this.emit({ type: 'output', pane: rest.slice(0, space), data: rest.slice(marker + 3) });
  }
}
