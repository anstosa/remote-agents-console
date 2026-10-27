// One tmux control-mode client per (socket, session): the console attaches once
// with `tmux -C attach-session`, follows `%output` to learn which pane changed, and
// issues its Captures as commands on the same connection so the live view needs no
// process spawn (ADR 0008). The client attaches with `ignore-size` and never declares
// a size, so it stays invisible to tmux's window-size math and the viewport
// coordinator keeps sizing the pane unchanged. This slice discards the pane bytes and
// uses `%output` only as a "this pane changed" signal; a later ticket streams them.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { SocketRef } from '../domain/models.js';
import { capturePaneArgs, paneIdPattern as paneId, run, safeEnv, sessionIdPattern as sessionId, tmuxBinary } from './command.js';
import { ControlProtocolParser, decodeControlOutput, type CommandReply, type ControlEvent } from './control-protocol.js';

const maxCaptureDepth = 5_000;
// One `refresh-client -B` subscription per control client tracks every attached client's
// size. `what` is empty (the attached-session context, evaluated once) and the format is an
// `#{L:}` loop over all clients — a `-B` format may contain colons, as every `#{mod:…}` does.
// The comma separator keeps the argument space-free, so tmux's command tokenizer takes the
// whole `name::format` as one argument. The value is a change signal only, never parsed: any
// attach, detach or resize changes it and tmux reports it through %subscription-changed, at
// most once a second.
const clientSizeSubscription = 'rac-clients';
const clientSizeSubscribeArg = `${clientSizeSubscription}::#{L:#{client_width}x#{client_height},}`;
// a command whose reply block does not arrive in this long is a broken connection: the
// client fails and its viewers reconnect, mirroring run()'s SIGKILL timeout for spawns.
// Generous because tmux orders a reply behind pending %output.
const commandTimeoutMs = 10_000;
const inputBlockingPaneModes: ReadonlySet<string> = new Set(['copy-mode', 'view-mode']);
const paneModeFormat = '#{pane_in_mode}\t#{pane_mode}';

export type PaneActivitySubscriber = {
  // a %output for the subscribed pane arrived; the log socket arms its quiet-window
  // Capture from this. Optional so a pane-stream subscriber that only wants bytes need
  // not provide it.
  onActivity?: () => void;
  // the pane's raw bytes as they happen, decoded from %output; the Pane stream forwards
  // these to the browser. Optional and decoded lazily, so a subscriber that only needs
  // "the pane changed" (the log socket) never pays to decode every %output.
  onOutput?: (bytes: Buffer) => void;
  // tmux paused and resumed this pane; the viewer must re-capture
  onReseed: () => void;
  // a window layout changed or an attached terminal attached, detached or resized; the
  // viewer re-asserts and re-clamps its Size claim (Sizing, ADR 0008)
  onResize: () => void;
  // text copied in any pane of the session (OSC 52 under `set-clipboard on`, or a copy-mode
  // yank); the Pane stream hands it to the browser's clipboard
  onClipboard?: (text: string) => void;
  // the session or control client ended; `reason` is the Pane stream's exit reason
  // ('session ended' when tmux told us via %exit, 'control client lost' when our client
  // process died). The viewer forwards it and reconnects.
  onExit: (reason: string) => void;
};

// the pane-facing surface the log and pane sockets depend on; the real client and a test
// fake both satisfy it
export type PaneClient = {
  subscribe(pane: string, subscriber: PaneActivitySubscriber): () => void;
  capture(pane: string, depth: number): Promise<string | undefined>;
  // the id of the window holding the pane (`@N`), so the Size claim is keyed by window
  windowId(pane: string): Promise<string | undefined>;
  // type bytes into the pane byte-exact (`send-keys -H`) over the connection, no spawn
  sendInput(pane: string, bytes: Buffer): Promise<boolean>;
  // a Capture reconstructed as a byte seed for the Pane stream, issued on the connection
  // so tmux orders it exactly against `%output` (the browser applies the seed, then only
  // bytes after the reply's end). Alternate screen: each row painted with absolute
  // positioning and the cursor restored. Normal screen: history joined with CRLF, cleared
  // first and the cursor restored. An empty buffer on failure.
  seed(pane: string, depth: number): Promise<Buffer>;
};
export type PaneStreamProvider = {
  get(socket: SocketRef, session: string): PaneClient;
  // `fingerprint\0paneId` for every pane currently open as a Terminal (launch adoption skip)
  openPaneKeys(): Set<string>;
  closeAll(): void;
};

type BlockWaiter = { resolve: (reply: CommandReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class TmuxControlClient implements PaneClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser: ControlProtocolParser;
  // command replies resolve in the order commands were written (tmux serialises them)
  private readonly blockWaiters: BlockWaiter[] = [];
  private readonly subscribers = new Map<string, Set<PaneActivitySubscriber>>();
  private readonly inputQueues = new Map<string, Promise<boolean>>();
  private disposed = false;
  // resolves once the attach's own %begin/%end block has been consumed
  readonly ready: Promise<void>;

  // command clients suppress output and have server-owned lifetimes
  constructor(private readonly binary: string, private readonly socketPath: string, session: string | undefined, private readonly onGone: () => void, private readonly options: { commandOnly?: boolean; timeoutMs?: number } = {}) {
    this.parser = new ControlProtocolParser(event => this.onEvent(event));
    // `-C` over pipes (never `-CC`), `-f ignore-size` so the client does not affect any
    // window's size; default stdio is 'pipe' for all three fds. Never `read-only`: a command-line
    // `send-keys` without `-c` checks the most recently active client, which is this one whenever
    // no terminal is attached, and refuses with "client is read-only" (the paste still lands).
    const flags = options.commandOnly ? 'ignore-size,no-output,no-detach-on-destroy' : 'ignore-size';
    this.child = spawn(binary, ['-S', socketPath, ...(options.commandOnly ? ['-N'] : []), '-C', 'attach-session', ...(options.commandOnly ? ['-E'] : []), ...(session === undefined ? [] : ['-t', session]), '-f', flags], { env: safeEnv() });
    this.ready = new Promise<void>((resolve, reject) => this.blockWaiters.push({ resolve: reply => {
      // failed attaches are not usable connections
      if (reply.ok) resolve();
      else { reject(new Error('control attach failed')); this.fail('control client lost'); }
    }, reject, timer: this.armTimeout() }));
    // an attach that fails before any capture attaches a catch would otherwise be an unhandled rejection
    this.ready.catch(() => {});
    // once attached, subscribe to attached clients' sizes so a terminal resize is a push, not
    // a poll. If the subscription itself fails (an older tmux without `-B`, a transient error)
    // the client stays alive on %layout-change re-clamps only: attach/detach/resize of a second
    // terminal no longer re-clamps, and there is no periodic fallback. A tmux that old is not a
    // target here, so this soft-degrades rather than wedges.
    // dashboard clients neither stream panes nor coordinate viewport sizes
    if (!options.commandOnly) void this.ready.then(() => this.command(`refresh-client -B ${clientSizeSubscribeArg}`)).catch(() => { /* a broken connection tears the client down elsewhere */ });
    this.child.stdout.on('data', (chunk: Buffer) => this.parser.push(chunk));
    this.child.stderr.on('data', () => { /* tmux diagnostics are not actionable here */ });
    // a write to a child whose read-end has closed (server gone) raises EPIPE
    // asynchronously; without this listener it is an unhandled 'error' that crashes the
    // whole process, and the try/catch around writes only guards synchronous throws
    this.child.stdin.on('error', () => this.fail('control client lost'));
    this.child.on('error', () => this.fail('control client lost'));
    this.child.on('exit', () => this.fail('control client lost'));
  }

  private onEvent(event: ControlEvent): void {
    switch (event.type) {
      case 'block': {
        const waiter = this.blockWaiters.shift();
        if (waiter !== undefined) { clearTimeout(waiter.timer); waiter.resolve({ ok: event.ok, lines: event.lines }); }
        return;
      }
      case 'output': this.notifyActivity(event.pane, event.data); return;
      // we never pause our own read, so a %pause is tmux dropping us transiently;
      // continue the pane and tell subscribers to re-capture its current state
      case 'pause': void this.continuePane(event.pane); return;
      case 'continue': return;
      // a window layout changed (external resize, zoom, unzoom) or an attached terminal
      // attached, detached or resized (our client-size subscription): every viewer re-clamps.
      // Both are session-wide, so broadcast; a re-clamp on an unaffected pane is a no-op.
      case 'layout': this.notifyResize(); return;
      case 'subscription': if (event.name === clientSizeSubscription) this.notifyResize(); return;
      case 'paste-buffer': void this.forwardCopy(event.name); return;
      case 'exit': this.fail('session ended'); return;
    }
  }

  // bound each attach and command reply
  private armTimeout(): ReturnType<typeof setTimeout> {
    // a command whose reply never arrives means the connection is broken, not the session
    return setTimeout(() => this.fail('control client lost'), this.options.timeoutMs ?? commandTimeoutMs);
  }

  // send a command and await its reply block; rejects if the client is gone or stalls
  async command(text: string): Promise<CommandReply> {
    if (this.disposed) throw new Error('control client disposed');
    return await new Promise<CommandReply>((resolve, reject) => {
      this.blockWaiters.push({ resolve, reject, timer: this.armTimeout() });
      this.child.stdin.write(`${text}\n`);
    });
  }

  /**
   * Capture a pane's scrollback over the control connection and return the exact bytes
   * a spawned `capture-pane -e -p` would print, decoded as UTF-8. tmux orders this reply
   * behind any pending `%output`, so the capture reflects the pane's current screen.
   * Reply lines are byte-preserving (latin1); re-appending the terminating newline
   * reproduces the spawned stdout exactly, so the shared processing behaves identically.
   */
  async capture(pane: string, depth: number): Promise<string | undefined> {
    if (!paneId.test(pane) || !Number.isInteger(depth) || depth < 1 || depth > maxCaptureDepth) return undefined;
    await this.ready.catch(() => undefined);
    if (this.disposed) return undefined;
    const block = await this.command(capturePaneArgs(pane, depth).join(' ')).catch(() => undefined);
    if (block === undefined || !block.ok) return undefined;
    return Buffer.from(`${block.lines.join('\n')}\n`, 'latin1').toString('utf8');
  }

  // subscribe browser viewers only
  subscribe(pane: string, subscriber: PaneActivitySubscriber): () => void {
    // command ownership never participates in browser subscription teardown
    if (this.options.commandOnly) throw new Error('command client cannot stream panes');
    if (!paneId.test(pane)) throw new Error('bad pane id');
    if (this.disposed) throw new Error('control client disposed');
    const set = this.subscribers.get(pane) ?? new Set<PaneActivitySubscriber>();
    set.add(subscriber);
    this.subscribers.set(pane, set);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(pane);
      // the last viewer of this session left; tear the client down
      if (this.subscriberCount() === 0) this.dispose();
    };
  }

  subscriberCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }

  // the pane ids this session currently has an open subscriber for (a live pane socket): the
  // panes launch adoption and Remove's blind kill must treat as open Terminals and skip
  subscribedPanes(): string[] {
    return [...this.subscribers.keys()];
  }

  // fan a pane's `%output` out to its subscribers: the "changed" signal always, and the
  // decoded bytes to any subscriber that wants them. The bytes are decoded once, lazily,
  // so a session watched only by a log socket never pays the octal decode.
  private notifyActivity(pane: string, data: string): void {
    const subscribers = this.subscribers.get(pane);
    if (subscribers === undefined) return; // panes nobody is viewing are discarded here, never turned off
    let bytes: Buffer | undefined;
    for (const subscriber of [...subscribers]) {
      subscriber.onActivity?.();
      if (subscriber.onOutput !== undefined) subscriber.onOutput(bytes ??= decodeControlOutput(data));
    }
  }

  // a layout or attached-client change reaches every viewer of this session
  private notifyResize(): void {
    for (const set of [...this.subscribers.values()]) for (const subscriber of [...set]) subscriber.onResize();
  }

  // A copy makes an automatic `bufferN`; the console's own prompt buffers are named `rac-*` and
  // never reach the clipboard. Read with a spawn because a reply block over the connection
  // loses the buffer's trailing newline (a linewise yank).
  private async forwardCopy(name: string): Promise<void> {
    if (!/^buffer\d+$/u.test(name) || this.subscriberCount() === 0) return;
    const result = await run(this.binary, ['-S', this.socketPath, 'show-buffer', '-b', name]).catch(() => undefined);
    // run() keeps only the last 1,000,000 chars, so a copy that large is skipped, never truncated
    if (result?.code !== 0 || result.stdout === '' || result.stdout.length >= 1_000_000) return;
    for (const set of [...this.subscribers.values()]) for (const subscriber of [...set]) subscriber.onClipboard?.(result.stdout);
  }

  // the id of the pane's window (`@N`), read over the control connection so the Size claim
  // can be keyed by window with no process spawn
  async windowId(pane: string): Promise<string | undefined> {
    if (!paneId.test(pane)) return undefined;
    await this.ready.catch(() => undefined);
    if (this.disposed) return undefined;
    const block = await this.command(`display-message -p -t ${pane} '#{window_id}'`).catch(() => undefined);
    const id = block?.ok === true ? block.lines[0]?.trim() : undefined;
    return id !== undefined && /^@\d+$/u.test(id) ? id : undefined;
  }

  // leave history views but reject unrelated selectors
  private async preparePaneInput(pane: string): Promise<boolean> {
    const status = await this.command(`display-message -p -t ${pane} '${paneModeFormat}'`).catch(() => undefined);
    // require one current pane-mode snapshot
    if (status?.ok !== true) return false;
    const match = /^([01])\t([^\r\n]*)$/u.exec(status.lines[0] ?? '');
    // reject malformed or unsupported mode state
    if (match === null) return false;
    // normal panes accept input directly
    if (match[1] === '0') return true;
    // never inject into selectors or other pane modes
    if (!inputBlockingPaneModes.has(match[2]!)) return false;
    const cancelled = await this.command(`send-keys -X -t ${pane} cancel`).catch(() => undefined);
    return cancelled?.ok === true;
  }

  /**
   * leave a shared history view, then type raw bytes into a pane byte-exact as
   * `send-keys -H` (hex literals) on the control connection. `-H` takes each byte as a
   * two-digit hex literal, so control bytes, UTF-8 continuation bytes and a lone Ctrl+C
   * all reach the pane verbatim, unlike `-l` which reinterprets keys. Other pane modes
   * fail closed instead of receiving input meant for the process.
   */
  async sendInput(pane: string, bytes: Buffer): Promise<boolean> {
    // require safe nonempty input
    if (!paneId.test(pane) || bytes.length === 0) return false;
    const previous = this.inputQueues.get(pane) ?? Promise.resolve(true);
    const queued = previous.catch(() => false).then(ready => ready && this.writeInput(pane, bytes));
    this.inputQueues.set(pane, queued);
    try {
      return await queued;
    } finally {
      // clear only the final queued write
      if (this.inputQueues.get(pane) === queued) this.inputQueues.delete(pane);
    }
  }

  // prepare and write one ordered pane frame
  private async writeInput(pane: string, bytes: Buffer): Promise<boolean> {
    await this.ready.catch(() => undefined);
    // stop after connection loss
    if (this.disposed) return false;
    // restore the live process before delivery
    if (!await this.preparePaneInput(pane)) return false;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
    const block = await this.command(`send-keys -H -t ${pane} ${hex}`).catch(() => undefined);
    return block?.ok === true;
  }

  /**
   * reconstruct a pane's current screen as a byte seed for the pane stream, capturing on
   * the control connection so tmux orders the reply exactly against pending `%output`.
   * a full-screen program (alternate screen) is painted with each row placed absolutely
   * (`CSI row;1H`, no newline, so a full-width line can never wrap and scroll a row off)
   * with `-N` to keep trailing cells, and the cursor restored from `#{cursor_x/y}`. mouse
   * reporting and coordinate modes are restored for either buffer so a fresh browser can
   * send wheel input to the live program. the normal buffer is the history to `depth`, joined
   * with CRLF, cleared first and followed by the modes and cursor position. `capture-pane -e`
   * carries the pen from cell to cell and never resets it, so either capture is followed by an
   * SGR reset; otherwise the last captured cell's style (an underlined link, say) becomes the
   * browser's pen and colours everything the program writes next. reply lines are
   * byte-preserving (latin1); the ASCII control prefixes stay ASCII, so latin1 reproduces the
   * exact bytes a spawned capture would print.
   */
  async seed(pane: string, depth: number): Promise<Buffer> {
    if (!paneId.test(pane) || !Number.isInteger(depth) || depth < 1 || depth > maxCaptureDepth) return Buffer.alloc(0);
    await this.ready.catch(() => undefined);
    if (this.disposed) return Buffer.alloc(0);
    const meta = await this.command(`display-message -p -t ${pane} '#{alternate_on} #{cursor_x} #{cursor_y} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_utf8_flag} #{mouse_sgr_flag}'`).catch(() => undefined);
    if (meta?.ok !== true) return Buffer.alloc(0);
    const [alt, cursorX, cursorY, mouseStandard, mouseButton, mouseAll, mouseUtf8, mouseSgr] = (meta.lines[0] ?? '').trim().split(' ');
    // restore the live cursor after either screen capture
    const x = Number(cursorX);
    const y = Number(cursorY);
    const cursor = Number.isInteger(x) && Number.isInteger(y) ? `\x1b[${y + 1};${x + 1}H` : '';
    // restore only the reporting and encoding modes tmux currently has enabled
    const mouseModes = `${mouseStandard === '1' ? '\x1b[?1000h' : ''}${mouseButton === '1' ? '\x1b[?1002h' : ''}${mouseAll === '1' ? '\x1b[?1003h' : ''}${mouseUtf8 === '1' ? '\x1b[?1005h' : ''}${mouseSgr === '1' ? '\x1b[?1006h' : ''}`;
    if (alt === '1') {
      const capture = await this.command(`capture-pane -e -p -N -t ${pane}`).catch(() => undefined);
      if (capture?.ok !== true) return Buffer.alloc(0);
      let out = '\x1b[?1049h\x1b[H\x1b[2J';
      capture.lines.forEach((line, index) => { out += `\x1b[${index + 1};1H${line}`; });
      return Buffer.from(`${out}\x1b[0m${mouseModes}${cursor}`, 'latin1');
    }
    const capture = await this.command(`capture-pane -e -p -J -t ${pane} -S -${depth}`).catch(() => undefined);
    if (capture?.ok !== true) return Buffer.alloc(0);
    return Buffer.from(`\x1b[H\x1b[2J${capture.lines.join('\r\n')}\x1b[0m${mouseModes}${cursor}`, 'latin1');
  }

  private async continuePane(pane: string): Promise<void> {
    // the pane id comes from the parser; validate before it enters a command
    if (!paneId.test(pane)) return;
    const subscribers = this.subscribers.get(pane);
    if (subscribers === undefined) return;
    try { await this.command(`refresh-client -A ${pane}:continue`); } catch { /* client gone */ }
    for (const subscriber of [...subscribers]) subscriber.onReseed();
  }

  // the control connection ended: end every viewer with the reason, then tear down
  private fail(reason: string): void {
    if (this.disposed) return;
    const subscribers = [...this.subscribers.values()].flatMap(set => [...set]);
    this.subscribers.clear();
    this.dispose();
    for (const subscriber of subscribers) subscriber.onExit(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // settle any in-flight command so its awaiting caller does not hang forever
    for (const waiter of this.blockWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('control client disposed')); }
    try { this.child.stdin.write('detach\n'); } catch { /* pipe already closed */ }
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    this.onGone();
  }
}

/** Lazily starts and reaps one control client per (socket, session). */
export class PaneStreamRegistry implements PaneStreamProvider {
  private readonly clients = new Map<string, TmuxControlClient>();
  private readonly binary = tmuxBinary();

  get(socket: SocketRef, session: string): TmuxControlClient {
    if (!sessionId.test(session)) throw new Error('bad session');
    const key = `${socket.fingerprint}\0${session}`;
    const existing = this.clients.get(key);
    if (existing !== undefined) return existing;
    // get() spawns immediately, and a client is reaped only once it has had a subscriber
    // that then leaves (or the client fails). Every caller (the log and pane sockets)
    // subscribes synchronously after get(), so a zero-subscriber client is never left behind.
    const client = new TmuxControlClient(this.binary, socket.path, session, () => {
      // evict a disposed client unconditionally, so a reconnecting viewer never gets it
      if (this.clients.get(key) === client) this.clients.delete(key);
    });
    this.clients.set(key, client);
    return client;
  }

  // the number of live control clients (for tests and shutdown)
  get size(): number {
    return this.clients.size;
  }

  // `fingerprint\0paneId` for every pane a browser currently has open as a Terminal, across
  // all sessions. Launch adoption and Remove's blind kill consult this so a pane the operator
  // is streaming is never pasted into or killed (spec, Console shells).
  openPaneKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [key, client] of this.clients) {
      const fingerprint = key.slice(0, key.indexOf('\0'));
      for (const pane of client.subscribedPanes()) keys.add(`${fingerprint}\0${pane}`);
    }
    return keys;
  }

  closeAll(): void {
    for (const client of [...this.clients.values()]) client.dispose();
    this.clients.clear();
  }
}
