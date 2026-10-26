import type { TmuxCommandRegistry } from './command-registry.js';
import type { Pane, PaneListingSnapshot, SocketRef } from '../domain/models.js';
import { lastPromptFromHistory, latestAgentMessageFromHistory, latestCompletedAssistantMessage } from '../adapters/codex-turns.js';
import type { AttentionState, TmuxKey } from '../adapters/types.js';
import { processNameOption, processPaneRole, processWorktreeOption } from './stack-sessions.js';
import { capturePaneArgs, paneIdPattern as paneId, run, sessionIdPattern as sessionId, socketIsCurrent, tmuxBinary, tmuxFormatLiteral } from './command.js';

const attentionStates: ReadonlySet<string> = new Set(['working', 'finished', 'question']);
const inputBlockingPaneModes: ReadonlySet<string> = new Set(['copy-mode', 'view-mode']);
const paneModeFormat = '#{pane_in_mode}\t#{pane_mode}';

// a chord written in one send-keys is read as Meta; wait this long after Escape
const postEscapeDelayMs = 120;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const paneSnapshotTtlMs = 2_000;

// sanitize terminal controls without rewriting semantic SGR state
function safeTerminalText(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '\x1b') {
      const next = value[index + 1];
      if (next === '[') {
        let end = index + 2;
        while (end < value.length && (value.charCodeAt(end) < 0x40 || value.charCodeAt(end) > 0x7e)) end += 1;
        if (value[end] === 'm') result += value.slice(index, end + 1);
        index = end < value.length ? end : value.length;
        continue;
      }
      if (next === ']' || next === 'P' || next === '^' || next === '_') {
        index += 1;
        while (index + 1 < value.length && value[index] !== '\x07' && !(value[index] === '\x1b' && value[index + 1] === '\\')) index += 1;
        if (value[index] === '\x1b') index += 1;
        continue;
      }
      index += next === undefined ? 0 : 1;
      continue;
    }
    if (character >= '\x20' || character === '\n' || character === '\r' || character === '\t') result += character;
  }
  return result.replace(/(?:[ \t]*\r?\n)+[ \t]*$/u, '');
}

// prevent background bleed only when preparing a browser snapshot
function safeSnapshot(value: string): string {
  const trimmed = safeTerminalText(value);
  return trimmed && `${trimmed.replace(/\r?\n/g, '\x1b[49m\n')}\x1b[49m`;
}

function bottomAlignedWindow(lines: string[], rows: number): string[] {
  // tmux returns unused rows after the pane content. Move that space above
  // the content so a short browser frame remains anchored to the bottom.
  let contentEnd = lines.length;
  while (contentEnd > 0) {
    const visible = safeSnapshot(lines[contentEnd - 1]!).replace(/\x1b\[[0-?]*[ -/]*m/gu, '').trim();
    if (visible) break;
    contentEnd -= 1;
  }
  const content = lines.slice(0, contentEnd);
  return [...Array.from({ length: Math.max(0, rows - content.length) }, () => ''), ...content];
}

export type CapturedWindow = { text: string; older: boolean; lastPrompt?: string; latestAgentMessage?: string; latestAssistantMessage?: string; latestAssistantMessageOverflows?: boolean };

// Run a `capture-pane` for a pane at the given scrollback depth and return its raw
// stdout, or undefined on failure. The default spawns a tmux process; the log socket
// passes one that issues the capture over its control-mode connection (ADR 0008), so
// the live view captures with no process spawn while the processing below is shared.
export type PaneCaptureRunner = (depth: number) => Promise<string | undefined>;

export type PaneSize = { cols: number; rows: number };
// clientLimit: the largest pane size every tmux client attached to the pane's
// session can display; absent when nothing is attached
export type PaneGeometry = PaneSize & { clientLimit?: PaneSize };
// The console imposes no size ceiling of its own; the only bound is tmux's own maximum
// window dimension (WINDOW_MAXIMUM, 10000). A pane tmux has already made larger (a wide
// attached terminal) is still reported as it is. (Sizing, ADR 0008: the old 500x300 clamp
// is gone.)
export const paneSizeLimit: PaneSize = { cols: 10_000, rows: 10_000 };

type Layout = { windowCols: number; windowRows: number; paneCols: number; paneRows: number };
const layoutFormat = '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}';
// one attached client per line: tty width, tty height, flags, its session's status-line setting
const clientFormat = '#{client_width}\t#{client_height}\t#{client_flags}\t#{status}';

function parseLayout(line: string | undefined): Layout | undefined {
  const match = /^(\d+)\t(\d+)\t(\d+)\t(\d+)$/u.exec(line ?? '');
  if (match === null) return undefined;
  return { windowCols: Number(match[1]), windowRows: Number(match[2]), paneCols: Number(match[3]), paneRows: Number(match[4]) };
}

// `status` is off, on, or a line count
const statusLines = (status: string): number => status === 'off' ? 0 : status === 'on' ? 1 : Number.parseInt(status, 10) || 1;

// Mirror tmux's own ignore_client_size(): suspended clients do not count, and an
// ignore-size client counts only when no other client is attached. The console's
// own control-mode client (ADR 0008) attaches with `ignore-size` and never declares
// a size, but tmux still lists it, sometimes with a phantom 80x24; it is never a real
// viewport, so it is dropped outright rather than allowed to clamp every pane to
// 80x24. tmux sizes a window to the space beneath each client's status line, and the
// console sizes a pane to the window minus its companion panes, so both come off the limit.
function clientLimit(layout: Layout, lines: string[]): PaneSize | undefined {
  const clients = lines.flatMap(line => {
    const match = /^(\d+)\t(\d+)\t([^\t]*)\t([^\t]*)$/u.exec(line);
    if (match === null) return [];
    const flags = new Set(match[3]!.split(','));
    const ttyCols = Number(match[1]);
    const ttyRows = Number(match[2]);
    if (flags.has('suspended') || flags.has('control-mode') || ttyCols < 2 || ttyRows < 2) return [];
    return [{ cols: ttyCols, rows: ttyRows - statusLines(match[4]!), ignored: flags.has('ignore-size') }];
  });
  const counted = clients.some(client => !client.ignored) ? clients.filter(client => !client.ignored) : clients;
  if (counted.length === 0) return undefined;
  const extraCols = Math.max(0, layout.windowCols - layout.paneCols);
  const extraRows = Math.max(0, layout.windowRows - layout.paneRows);
  return {
    cols: Math.max(2, Math.min(...counted.map(client => client.cols)) - extraCols),
    rows: Math.max(2, Math.min(...counted.map(client => client.rows)) - extraRows)
  };
}

export class TmuxAdapter {
  private readonly binary = tmuxBinary();
  private readonly inputQueues = new Map<string, Promise<boolean>>();
  private commandsClosed = false;
  private readonly paneSnapshots = new Map<string, { fingerprint: string; at: number; status: 'pending'|'available'|'unavailable'; panes?: Pane[]; retryAt?: number }>();

  // production supplies server-owned reads; standalone adapters retain spawned commands
  constructor(private readonly commands?: Pick<TmuxCommandRegistry, 'listPanes' | 'retainSockets' | 'closeAll'>) {}

  // expose recent complete and failed observations for dashboard stack state
  paneSnapshotsNow(): ReadonlyMap<string, PaneListingSnapshot> {
    const snapshots = new Map<string, PaneListingSnapshot>();
    const now = Date.now();
    // prune observations after their reuse window
    for (const [path, entry] of this.paneSnapshots) {
      // in-flight reads have made no observation yet
      if (entry.status === 'pending') continue;
      const expiresAt = entry.status === 'unavailable' && entry.retryAt !== undefined ? entry.retryAt : entry.at + paneSnapshotTtlMs;
      // expired observations become not observed
      if (expiresAt <= now) { this.paneSnapshots.delete(path); continue; }
      // complete listings may be empty; failed listings remain unknown
      snapshots.set(path, entry.status === 'available' && entry.panes !== undefined ? { status: 'available', panes: entry.panes } : { status: 'unavailable' });
    }
    return snapshots;
  }

  // reap sockets missing from discovery, including identities replaced at the same path
  retainSockets(sockets: readonly SocketRef[]): void {
    this.commands?.retainSockets(sockets);
    const live = new Map(sockets.map(socket => [socket.path, socket.fingerprint]));
    // discard matching stale observations with their transports
    for (const [path, entry] of this.paneSnapshots) {
      // only the same socket identity can reuse a snapshot
      if (live.get(path) !== entry.fingerprint) this.paneSnapshots.delete(path);
    }
  }

  // app shutdown owns the persistent dashboard transport
  closeCommands(): void { this.commandsClosed = true; this.commands?.closeAll(); this.paneSnapshots.clear(); }

  // leave history views but reject unrelated selectors
  private async preparePaneInput(socket: SocketRef, pane: string): Promise<boolean> {
    const status = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, paneModeFormat]);
    // require one current pane-mode snapshot
    if (status.code !== 0) return false;
    const match = /^([01])\t([^\r\n]*)\r?\n?$/u.exec(status.stdout);
    // reject malformed or unsupported mode state
    if (match === null) return false;
    // normal panes accept input directly
    if (match[1] === '0') return true;
    // never inject into selectors or other pane modes
    if (!inputBlockingPaneModes.has(match[2]!)) return false;
    return (await run(this.binary, ['-S', socket.path, 'send-keys', '-X', '-t', pane, 'cancel'])).code === 0;
  }

  // the mode holding a pane that input cannot leave (a picker such as `choose-tree`'s
  // tree-mode); a history view is left by the next keystroke, so it reads as none
  async heldPaneMode(socket: SocketRef, pane: string): Promise<string | undefined> {
    if (!paneId.test(pane)) return undefined;
    const status = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, paneModeFormat]);
    const match = status.code === 0 ? /^1\t([^\r\n]+)\r?\n?$/u.exec(status.stdout) : null;
    return match === null || inputBlockingPaneModes.has(match[1]!) ? undefined : match[1];
  }

  // leave whatever mode holds a pane, pickers included (`copy-mode -q` cancels every mode)
  async exitPaneMode(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'copy-mode', '-q', '-t', pane])).code === 0;
  }

  // read live panes while retaining dead process rows for dashboard stack state
  async listPanes(socket: SocketRef, { backoffMissingServer = false }: { backoffMissingServer?: boolean } = {}): Promise<Pane[]> {
    // shutdown cannot spawn a fallback from a late refresh
    if (this.commandsClosed) return [];
    const previous = this.paneSnapshots.get(socket.path);
    // ordinary dashboard polls back off only confirmed absent servers
    if (backoffMissingServer && previous?.fingerprint === socket.fingerprint && previous.status === 'unavailable' && (previous.retryAt ?? 0) > Date.now()) return [];
    const format = `#{pane_id}\t#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{@rac_display_label}\t#{pane_start_command}\t#{@rac_attention}\t#{@rac_session}\t#{@rac_sandboxed}\t#{@rac_question}\t#{@rac_console_managed}\t#{@rac_role}\t#{@rac_pane_name}\t#{window_id}\t#{?pane_in_mode,#{pane_mode},}\t#{@rac_place}\t#{${processNameOption}}\t#{@rac_review_run}\t#{pane_dead}\t#{pane_dead_status}\t#{@rac_key_binding}\t#{${processWorktreeOption}}`;
    const entry: { fingerprint: string; at: number; status: 'pending'|'available'|'unavailable'; panes?: Pane[]; retryAt?: number } = { fingerprint: socket.fingerprint, at: Date.now(), status: 'pending' };
    this.paneSnapshots.set(socket.path, entry);
    const persistent = await this.commands?.listPanes(socket, format).catch(() => undefined);
    // only fallback pays for identity validation; healthy persistent reads do not stat
    const current = this.commands === undefined || persistent !== undefined || await socketIsCurrent(socket);
    // shutdown may have raced the asynchronous identity check
    if (this.commandsClosed || !current) {
      // a rejected identity made no pane observation
      if (!this.commandsClosed && this.paneSnapshots.get(socket.path) === entry) this.paneSnapshots.delete(socket.path);
      return [];
    }
    const out = persistent === undefined ? await run(this.binary, ['-S', socket.path, 'list-panes', '-a', '-F', format]) : { code: 0, stdout: persistent, stderr: '' };
    // stale socket files otherwise fork a failed client on every dashboard tick
    if (out.code === 1 && /no server running on /u.test(out.stderr)) entry.retryAt = Date.now() + 5_000;
    // failed reads cannot claim that the stack stopped
    if (this.commandsClosed || out.code !== 0) { entry.status = 'unavailable'; entry.at = Date.now(); return []; }
    const lines = out.stdout.split('\n').filter(Boolean);
    const panes: Pane[] = lines.flatMap((line) => {
      const [id, session, name, pid, path, command, title, displayLabel, startCommand, attention, sessionRef, sandboxed, question, consoleManaged, role, paneName, windowId, mode, placeMark, processName, reviewRun, dead, status, keyBinding, ...worktree] = line.split('\t');
      const exitCode = status && /^\d+$/u.test(status) ? Number(status) : undefined;
      // dead remain-on-exit panes may have neither cwd nor a live pid
      if (!paneId.test(id) || !sessionId.test(session) || !name || (dead !== '1' && (!/^\d+$/.test(pid) || !path))) return [];
      return [{ paneId: id, sessionId: session, sessionName: name, pid: Number(pid) || 0, path: path ?? '', command: command ?? '', title: title ?? '', ...(displayLabel ? { displayLabel } : {}), ...(startCommand ? { startCommand } : {}), ...(attention ? { reportedAttention: attention } : {}), ...(sessionRef ? { reportedSession: sessionRef } : {}), ...(sandboxed ? { reportedSandboxed: sandboxed } : {}), ...(question ? { reportedQuestion: question } : {}), ...(consoleManaged === '1' ? { consoleManaged: true } : {}), ...(role ? { role } : {}), ...(role === processPaneRole && processName ? { processName } : {}), ...(paneName ? { paneName } : {}), ...(windowId ? { windowId } : {}), ...(mode && !inputBlockingPaneModes.has(mode) ? { paneMode: mode } : {}), ...(placeMark ? { placeMark } : {}), ...(reviewRun ? { reviewRun } : {}), ...(dead === '0' || dead === '1' ? { dead: dead === '1' } : {}), ...(exitCode === undefined ? {} : { exitCode }), ...(keyBinding ? { keyBinding } : {}), ...(worktree.length === 0 ? {} : { processWorktree: worktree.join('\t') }), socket }];
    });
    // retain only a complete reply; a malformed row must not hide a running process
    entry.status = panes.length === lines.length ? 'available' : 'unavailable';
    entry.at = Date.now();
    // complete replies carry their panes, including an empty list
    if (entry.status === 'available') entry.panes = panes;
    return panes.filter(pane => pane.dead !== true);
  }

  // the pane ids of one tmux session, for the pane socket's membership check: a pane may
  // be streamed only if it belongs to the target Agent's session (Decided at charting).
  // A fresh listing on every socket open, so a pane split by hand in an attached terminal
  // is pickable and a stale id is refused.
  async sessionPaneIds(socket: SocketRef, session: string): Promise<string[]> {
    if (!sessionId.test(session)) return [];
    const out = await run(this.binary, ['-S', socket.path, 'list-panes', '-s', '-t', session, '-F', '#{pane_id}']);
    if (out.code !== 0) return [];
    return out.stdout.split('\n').map(line => line.trim()).filter(id => paneId.test(id));
  }

  // clear the console-owned reported-state options once a pane's agent is gone
  async unsetReportedState(socket: SocketRef, pane: string): Promise<boolean> {
    if (!paneId.test(pane)) return false;
    const results = await Promise.all(['@rac_attention', '@rac_session', '@rac_sandboxed', '@rac_question'].map(
      option => run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '-u', option])
    ));
    return results.every(result => result.code === 0);
  }

  // hand a Review run's pane back to the operator: drop its `@rac_review_run` mark, so its Agent
  // is an ordinary one again (completion notifications, launch adoption)
  async unmarkReviewRun(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '-u', '@rac_review_run'])).code === 0;
  }

  // Mark a session as the Workspace of a Place: `@rac_place` is a session option, so every pane
  // of the session, in any window made later too, reads it (`Pane.placeMark`). `target` is the
  // session id or one of its pane ids.
  async markSessionPlace(socket: SocketRef, target: string, placeId: string): Promise<boolean> {
    if ((!sessionId.test(target) && !paneId.test(target)) || placeId.length === 0 || /[\0\r\n]/u.test(placeId)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-t', target, '@rac_place', placeId])).code === 0;
  }

  // Mark a pane as a Console shell (ADR 0001 style): `@rac_role=shell` so launch adoption,
  // Remove's blind kill and cleanup all skip it, and `@rac_pane_name` (the picker's name,
  // empty by default). Both are set at creation so a restart rediscovers the shell from them.
  async markConsoleShell(socket: SocketRef, pane: string, name: string): Promise<boolean> {
    if (!paneId.test(pane) || name.length > 120 || /[\0\r\n]/u.test(name)) return false;
    if ((await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_role', 'shell'])).code !== 0) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_pane_name', name])).code === 0;
  }

  // Open a Console shell in a new detached window of an existing session, cwd the Worktree,
  // running the given login-shell argv, and mark it. Returns the new pane id, or undefined on
  // failure. The window is detached (`-d`) so an attached terminal is not yanked to it (spec).
  async createConsoleShellWindow(socket: SocketRef, session: string, cwd: string, shellArgv: readonly string[], name: string): Promise<string | undefined> {
    if (!sessionId.test(session) && !/^[A-Za-z0-9_@%+=:,./-]+$/u.test(session)) return undefined;
    const created = await run(this.binary, ['-S', socket.path, 'new-window', '-d', '-t', session, '-c', tmuxFormatLiteral(cwd), '-P', '-F', '#{pane_id}', '--', ...shellArgv]);
    if (created.code !== 0) return undefined;
    const pane = created.stdout.trim();
    if (!paneId.test(pane)) return undefined;
    if (await this.markConsoleShell(socket, pane, name)) return pane;
    // an unmarked shell would be adopted by a later Launch (it looks like an idle landing
    // shell); end it rather than leak an operator-owned pane the console cannot see
    await this.close(socket, pane);
    return undefined;
  }

  // rename one Console shell: write (or clear, when empty) its `@rac_pane_name` option, the
  // name the picker shows. Rejects control characters and an over-long name; an empty name
  // unsets the option so the picker falls back to `command · ~/path`.
  async renamePaneName(socket: SocketRef, pane: string, name: string): Promise<boolean> {
    if (!paneId.test(pane) || name.length > 120 || /[\0\r\n]/u.test(name)) return false;
    const args = name === ''
      ? ['-S', socket.path, 'set-option', '-p', '-t', pane, '-u', '@rac_pane_name']
      : ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_pane_name', name];
    return (await run(this.binary, args)).code === 0;
  }

  // assign one server-owned pane label
  async label(socket: SocketRef, pane: string, label: string): Promise<boolean> {
    // reject unsafe pane coordinates and control characters
    if (!paneId.test(pane) || label.length === 0 || label.length > 120 || /[\0\r\n]/u.test(label)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_display_label', label])).code === 0;
  }

  // preserve original styles for adapter-owned semantic parsing
  async capture(socket: SocketRef, pane: string): Promise<string | undefined> {
    // reject unsafe pane coordinates
    if (!paneId.test(pane)) return undefined;
    const out = await run(this.binary, ['-S', socket.path, ...capturePaneArgs(pane, 800)]);
    return out.code === 0 ? safeTerminalText(out.stdout).slice(-96_000) : undefined;
  }

  // capture a pane's scrollback to the given depth, spawning a tmux process unless a
  // control-connection runner is supplied (ADR 0008)
  private async captureText(socket: SocketRef, pane: string, depth: number, captureVia?: PaneCaptureRunner): Promise<string | undefined> {
    if (captureVia !== undefined) return await captureVia(depth);
    const out = await run(this.binary, ['-S', socket.path, ...capturePaneArgs(pane, depth)]);
    return out.code === 0 ? out.stdout : undefined;
  }

  // capture only the current browser window
  async captureRecentWindow(socket: SocketRef, pane: string, rows: number, captureVia?: PaneCaptureRunner): Promise<CapturedWindow | undefined> {
    // reject unsafe pane coordinates
    if (!paneId.test(pane) || !Number.isInteger(rows) || rows < 2 || rows > paneSizeLimit.rows) return undefined;
    const depth = Math.min(300, rows + 24);
    const stdout = await this.captureText(socket, pane, depth, captureVia);
    // reject failed captures
    if (stdout === undefined) return undefined;
    const lines = stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    const start = Math.max(0, lines.length - rows);
    const window = bottomAlignedWindow(lines.slice(start), rows);
    return { text: safeSnapshot(window.join('\n')), older: start > 0 };
  }

  // The deep Capture the derive reads (lastPrompt and the latest agent/assistant messages come
  // from the full history); returns the concrete bottom window of `rows` lines.
  async captureWindow(socket: SocketRef, pane: string, rows: number, captureVia?: PaneCaptureRunner): Promise<CapturedWindow | undefined> {
    if (!paneId.test(pane) || !Number.isInteger(rows) || rows < 2 || rows > paneSizeLimit.rows) return undefined;
    const stdout = await this.captureText(socket, pane, 5_000, captureVia);
    if (stdout === undefined) return undefined;
    const lines = stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    const start = Math.max(0, lines.length - rows);
    const lastPrompt = lastPromptFromHistory(stdout);
    const latestAgentMessage = latestAgentMessageFromHistory(stdout);
    const assistantMessage = latestCompletedAssistantMessage(stdout);
    const latestAssistantMessage = assistantMessage !== undefined && assistantMessage.text.length <= 30_000 ? assistantMessage.text : undefined;
    const latestAssistantMessageOverflows = assistantMessage === undefined || latestAssistantMessage === undefined ? undefined : assistantMessage.rows > rows;
    const window = bottomAlignedWindow(lines.slice(start), rows);
    return { text: safeSnapshot(window.join('\n')), older: start > 0, ...(lastPrompt === undefined ? {} : { lastPrompt }), ...(latestAgentMessage === undefined ? {} : { latestAgentMessage }), ...(latestAssistantMessage === undefined ? {} : { latestAssistantMessage, latestAssistantMessageOverflows }) };
  }

  async resize(socket: SocketRef, pane: string, cols: number, rows: number): Promise<boolean> {
    if (!paneId.test(pane) || !Number.isInteger(cols) || cols < 2 || cols > paneSizeLimit.cols || !Number.isInteger(rows) || rows < 2 || rows > paneSizeLimit.rows) return false;
    const readLayout = async () => {
      const out = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, layoutFormat]);
      return out.code === 0 ? parseLayout(out.stdout.trim()) : undefined;
    };
    const apply = async (windowCols: number, windowRows: number) => {
      if (windowCols < 2 || windowRows < 2) return false;
      if ((await run(this.binary, ['-S', socket.path, 'resize-window', '-t', pane, '-x', String(windowCols), '-y', String(windowRows)])).code !== 0) return false;
      return (await run(this.binary, ['-S', socket.path, 'resize-pane', '-t', pane, '-x', String(cols), '-y', String(rows)])).code === 0;
    };

    const before = await readLayout();
    if (before === undefined) return false;
    if (before.paneCols === cols && before.paneRows === rows) return true;

    // A worktree window can contain HUD or worker panes. Those panes and their
    // borders consume part of the window, so making the whole window the same
    // size as the browser leaves the agent pane too short. Preserve the
    // non-agent portion of each axis and size the target pane exactly.
    const extraCols = Math.max(0, before.windowCols - before.paneCols);
    const extraRows = Math.max(0, before.windowRows - before.paneRows);
    if (!await apply(cols + extraCols, rows + extraRows)) return false;

    const after = await readLayout();
    if (after === undefined) return false;
    if (after.paneCols === cols && after.paneRows === rows) return true;

    // Some tiled layouts redistribute space during the first window resize.
    // Correct once using the observed delta rather than accepting tmux's
    // successful-but-clamped resize-pane result.
    if (!await apply(after.windowCols + cols - after.paneCols, after.windowRows + rows - after.paneRows)) return false;
    const corrected = await readLayout();
    return corrected?.paneCols === cols && corrected.paneRows === rows;
  }

  async size(socket: SocketRef, pane: string): Promise<PaneGeometry | undefined> {
    if (!paneId.test(pane)) return undefined;
    // one tmux process answers both questions; the layout line comes first
    const out = await run(this.binary, ['-S', socket.path, 'display-message', '-p', '-t', pane, layoutFormat, ';', 'list-clients', '-t', pane, '-F', clientFormat]);
    if (out.code !== 0) return undefined;
    const [first, ...clients] = out.stdout.split('\n').filter(line => line !== '');
    const layout = parseLayout(first);
    if (layout === undefined) return undefined;
    const { paneCols: cols, paneRows: rows } = layout;
    if (cols < 1 || rows < 1) return undefined;
    const limit = clientLimit(layout, clients);
    return limit === undefined ? { cols, rows } : { cols, rows, clientLimit: limit };
  }

  // resize-window pins the window at a manual size that ignores attached
  // clients; unsetting the option hands the size back to tmux
  async unpinWindowSize(socket: SocketRef, pane: string): Promise<boolean> {
    if (!paneId.test(pane)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-w', '-t', pane, '-u', 'window-size'])).code === 0;
  }

  // paste one named buffer into the live process
  async pastePrompt(socket: SocketRef, pane: string, buffer: string, prompt: string): Promise<boolean> {
    // require safe tmux coordinates
    if (!paneId.test(pane) || !/^rac-[a-zA-Z0-9_-]+$/.test(buffer)) return false;
    const load = await run(this.binary, ['-S', socket.path, 'load-buffer', '-b', buffer, '-'], prompt);
    // stop on buffer failure
    if (load.code !== 0) return false;
    // restore the live pane before pasting
    if (!await this.preparePaneInput(socket, pane)) {
      await run(this.binary, ['-S', socket.path, 'delete-buffer', '-b', buffer]);
      return false;
    }
    return (await run(this.binary, ['-S', socket.path, 'paste-buffer', '-p', '-d', '-b', buffer, '-t', pane])).code === 0;
  }

  // submit the composed launch command into a reused idle shell (launch path)
  async enter(socket: SocketRef, pane: string): Promise<boolean> {
    // require one writable pane
    if (!paneId.test(pane) || !await this.preparePaneInput(socket, pane)) return false;
    return (await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, 'Enter'])).code === 0;
  }

  /**
   * Send an Adapter-composed key sequence one `send-keys` at a time (ADR 0002).
   * The keys are the Adapter's own words (submit, interrupt, option select); the
   * console performs the side effect. One invocation per key keeps a chord from
   * being read as Meta, and a key following `Escape` waits so the same does not
   * happen across the pair (Claude's interrupt is `Escape` then `C-c`).
   */
  async sendKeys(socket: SocketRef, pane: string, keys: readonly TmuxKey[]): Promise<boolean> {
    // require one writable pane
    if (!paneId.test(pane) || keys.length === 0) return false;
    if (!await this.preparePaneInput(socket, pane)) return false;
    // preserve adapter key ordering
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      // stop after the first rejected key
      if ((await run(this.binary, ['-S', socket.path, 'send-keys', '-t', pane, key])).code !== 0) return false;
      // prevent one escape chord
      if (key === 'Escape' && index + 1 < keys.length) await delay(postEscapeDelayMs);
    }
    return true;
  }

  // keep managed Claude arming and submission in one guarded tmux batch
  async armAndSendKeys(socket: SocketRef, pane: string, arm: string, keys: readonly TmuxKey[]): Promise<boolean> {
    // reject unsafe pane coordinates and unbounded or malformed opaque arm bytes
    if (!paneId.test(pane) || keys.length === 0 || !/^[A-Za-z0-9_-]{1,16384}$/u.test(arm)) return false;
    // apply the same history-view and selector safety as ordinary adapter input
    if (!await this.preparePaneInput(socket, pane)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_calendar_arm', arm, ';', 'send-keys', '-t', pane, ...keys])).code === 0;
  }

  // write a console-owned Attention state on a pane (e.g. `finished` after an interrupt)
  async setReportedAttention(socket: SocketRef, pane: string, state: AttentionState): Promise<boolean> {
    if (!paneId.test(pane) || !attentionStates.has(state)) return false;
    return (await run(this.binary, ['-S', socket.path, 'set-option', '-p', '-t', pane, '@rac_attention', state])).code === 0;
  }

  // serialize terminal frames for each pane
  async input(socket: SocketRef, pane: string, value: string): Promise<boolean> {
    // require bounded terminal input
    if (!paneId.test(pane) || !value || value.length > 65_536 || value.includes('\0')) return false;
    const key = `${socket.path}\0${pane}`;
    const previous = this.inputQueues.get(key) ?? Promise.resolve(true);
    const queued = previous.catch(() => false).then((ready) => ready && this.sendInput(socket, pane, value));
    this.inputQueues.set(key, queued);
    try {
      return await queued;
    } finally {
      if (this.inputQueues.get(key) === queued) this.inputQueues.delete(key);
    }
  }

  private async sendInput(socket: SocketRef, pane: string, value: string): Promise<boolean> {
    // restore the live pane once per ordered input frame
    if (!await this.preparePaneInput(socket, pane)) return false;
    // preserve input order across literal and named keys
    for (const part of value.split(/(\r\n|\r|\n|\x03)/u)) {
      // skip split gaps
      if (!part) continue;
      const args = /^(?:\r\n|\r|\n)$/u.test(part)
        ? ['-S', socket.path, 'send-keys', '-t', pane, 'Enter']
        : part === '\x03'
          ? ['-S', socket.path, 'send-keys', '-t', pane, 'C-c']
          : ['-S', socket.path, 'send-keys', '-l', '-t', pane, part];
      // stop after the first rejected input part
      if ((await run(this.binary, args)).code !== 0) return false;
    }
    return true;
  }

  async close(socket: SocketRef, pane: string): Promise<boolean> {
    return paneId.test(pane) && (await run(this.binary, ['-S', socket.path, 'kill-pane', '-t', pane])).code === 0;
  }

  // run one shell command through the agent's tmux server, so under the host
  // bridge it executes on the host — the same side the agent's files live on.
  // tmux format-expands a run-shell argument before running it, so a `#(…)` in
  // the command would execute as a format substitution before `/bin/sh` ever
  // sees it. Double every `#` so tmux collapses it back to a literal `#` and the
  // command reaches the shell exactly as composed — the callers here compose a
  // plain shell command and never a tmux format (existing callers carry no `#`,
  // so this is a no-op for them), while a command built over an agent-controlled
  // path (a teardown's `cd -- '<workspace>'`) cannot smuggle a `#(…)` through.
  async runShell(socket: SocketRef, command: string): Promise<boolean> {
    if (!command || command.includes('\0')) return false;
    const literal = command.replaceAll('#', '##');
    return (await run(this.binary, ['-S', socket.path, 'run-shell', literal])).code === 0;
  }

  async terminateHostProcess(socket: SocketRef, pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    return await this.runShell(socket, `kill -TERM -- ${pid}`);
  }

  async closeSession(socket: SocketRef, session: string): Promise<boolean> {
    return sessionId.test(session) && (await run(this.binary, ['-S', socket.path, 'kill-session', '-t', session])).code === 0;
  }

  async attachArgs(socket: SocketRef, session: string): Promise<string[] | undefined> {
    return sessionId.test(session) ? ['-S', socket.path, 'attach-session', '-t', session] : undefined;
  }
}
