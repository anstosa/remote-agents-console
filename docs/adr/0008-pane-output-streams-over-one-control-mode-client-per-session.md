---
status: accepted
date: 2026-09-12
---

# The console streams pane output over one tmux control-mode client per session

The console showed an Agent by polling tmux every half second: a `setInterval` spawned a `capture-pane` per viewer, diffed the text, and repainted a scrollback-less xterm from scratch, while keystrokes went back as a `send-keys` process per chunk. That loop is why typing felt sluggish, why history was paged server-side instead of scrolled, why full-screen programs rendered wrong, and why the only "terminal" on offer was the Agent's own pane with the Agent suspended under Ctrl+Z. We decided that every pane the console shows becomes a **Pane stream**: one tmux control-mode client (`tmux -C attach-session`) per tmux session, started lazily while any viewer is subscribed and reaped when the last one leaves, delivers each pane's `%output` as it happens and carries the commands viewers need — Captures, and later `send-keys -H` input and the size subscription — on the same connection. The client attaches with `ignore-size` and never declares a size, so it stays invisible to tmux's window-size math and the existing viewport coordinator keeps sizing panes unchanged. This extends ADR 0001 (the console reads pane state from tmux), it does not reverse it: tmux stays the single source of truth and every text consumer keeps reading Captures.

The work ships in slices. This ADR is written with the first, which is option E below: attach the control client, use `%output` only as a "this pane changed" signal to drive an event-driven Capture, run that Capture on the connection, and leave the browser and the wire untouched. Later slices stream the bytes to an xterm with its own scrollback and move input onto the connection.

## Considered options

- **Tune the snapshot loop** (poll faster, diff smarter). Cheapest, but structural: it cannot give local-feeling input latency, browser-side scrollback, or correct full-screen rendering, because the browser never sees the pane's bytes — only periodic text snapshots. It buys an afternoon, not the feature.
- **Per-pane snapshots** (a snapshot socket per pane, still polled). Extends the picker to any pane but keeps every limit of the poll: no streaming, no scrollback, input still spawns a process. A larger version of the same dead end.
- **A pty-attached client per viewer** (`tmux attach-session` in a node-pty, bytes to xterm). Gives streaming and real TUIs, but needs node-pty, and it inverts sizing — every viewer is a real client that counts for `window-size`, so the yield-to-smallest coordinator no longer holds — and a client displays a *window* laid out by tmux, so a pane beside the Agent becomes a grouped session with a zoomed window, not a panel. The right shape for "give me a full tmux in a tab", the wrong one for "a pane next to my agent".
- **`pipe-pane -O` per pane.** The same raw bytes as control mode, but one forked pipe per pane that replaces any pipe the operator set, with no layout or mode events and a fan-out to build anyway. Strictly dominated by control mode.
- **A control client for events only, snapshots kept forever.** The stepping stone this slice ships — but as a permanent design it stops short: it still repaints from Captures, so it never earns byte streaming, scrollback, or correct full-screen rendering. We adopt it as the first slice of the control-mode client, not as the destination.
- **One control-mode client per session, streaming per pane (chosen).** `%output` covers every pane of the session, so any pane is streamable without changing tmux's current window; the client is size-invisible until it declares a size, so the coordinator is untouched; input is `send-keys -H` to an allowed pane only, so no tmux command syntax crosses the socket; and no process spawns on the hot path. Delivered as the events-only slice first so the latency win and the per-pane groundwork land with no wire change.

## Consequences

- **One client per (socket, session), lazily started and reaped.** The first viewer of any pane in a session starts the client; the last to unsubscribe ends it. Two viewers of panes in the same session share one client. The client runs the tmux binary the console already resolves, `-C` over pipes (never `-CC`).
- **The control protocol is a parser the console owns.** A small framer matches each `%end`/`%error` to its `%begin` by command number — so a captured pane line that begins with `%end ` cannot close a block — decodes `%output` octal escapes at the byte level before any UTF-8 decoding, continues and re-seeds a pane on `%pause`, and ends every subscriber with a reason on `%exit` or the child exiting, after which the browser reconnects.
- **The live log frame is event-driven.** A `%output` on the viewed pane arms a short quiet window; on expiry one Capture on the connection produces the frame, sent only if it changed. An idle pane is never captured. The periodic poll is gone; the only interval left is a lease heartbeat (it renews and checks the control lease, doing no tmux work), because sizing and the derive now follow control-mode events.
- **The derive is event-driven and Adapter-gated.** The per-frame question parse and the 30-second metadata refresh collapse into one derive: only an Adapter with Turns or an inline-question parser (Codex, OMX) takes the deep Capture the derive needs; on the same quiet window it feeds the question and Turn parsers, and `question`/`metadata` go out only on change (plus at subscribe and on the web's on-demand request). The parser is skipped when the pane did not change, so an idle re-capture never re-parses. Claude has neither, so it performs no derive Capture and its reported questions stay on the dashboard tick.
- **The Size claim follows control-mode events, keyed by window.** `%layout-change` (an external resize, zoom or unzoom) re-asserts the claim and a `refresh-client -B` subscription over attached clients' sizes (an `#{L:}` client loop, pushed at most once a second) re-clamps it when a terminal attaches, detaches or resizes — there is no periodic sizing tick. The claim is keyed by the pane's window id (read over the connection), so two panes of one window resolve to one claim. That claim is single-owner (the latest viewer to acquire it drives the pin; an earlier viewer's resize then no-ops), which is why the picker disables any pane whose window already has an open panel — two live viewers never share a window. If that ever changes, co-viewer behaviour needs its own decision. The reads and applies themselves stay spawned: they are infrequent and off the hot path, so moving them onto the connection buys nothing here. The old 500×300 viewport ceiling is removed; the only bound is tmux's own maximum window dimension.
- **The client-limit read ignores control-mode clients.** The console's own control client is a tmux client; unless it is dropped from the attached-client size computation it clamps every viewed pane to a phantom 80×24. Real attached terminals still bound the pane.
- **Panes nobody views stay `on` and are discarded server-side.** The console never turns a pane `off` and never sets `pause-after`, because turning a pane off while the console is the only client stops tmux reading it and blocks the program.
- **The log view now depends on the control client, and recovers rather than wedges.** A spawned `capture-pane` was independent per poll; a shared control connection is not. Every command carries a timeout, and a command block that never closes is capped, so a stalled, half-dead or desynced connection fails the client — its viewers get an exit and reconnect on a fresh one — instead of freezing the live view forever. A missing stdin-error listener would let an EPIPE (writing to a child whose server just died) crash the whole process, so the client installs one.
- **A capture reply is trusted to the command-number match.** Because a `capture-pane` reply can contain pane text that looks like a `%end`/`%begin` line, the framer distinguishes a real terminator by the command number, as every control-mode client (e.g. iTerm2) does. Enumerated protocol-shaped pane content can still desync a block; the timeout and block cap bound that to a recoverable reconnect rather than a permanent wedge, and the byte-streaming slice, which reworks this parser, is where a stronger guarantee belongs.
- **The browser and the wire are unchanged in this slice.** Frames keep their shape; the streamed xterm, scrollback, byte-exact sizing and input-on-the-connection arrive with the later slices.

## Dashboard command connections

Dashboard discovery keeps its configured cadence (500 ms by default) but sends
`list-panes` through a separate, server-owned connection per discovered socket.
It does not require a browser viewer and does not count as an open Terminal for
launch or removal protection. The command surface permits pane listings only;
mutations are never retried through this transport.

The observer attaches with `-N` (never start a server), `-E` (preserve the session
environment), and `ignore-size,no-output,no-detach-on-destroy`. It neither
streams pane output nor changes viewport sizing. It is still an attached tmux
client: `session_attached`, attach/detach hooks, and `destroy-unattached` can observe
its presence. It deliberately omits `read-only`: when this observer is the only
attached client, tmux can select it as the context for a separate spawned
`send-keys` command and reject launch or prompt submission with “client is
read-only”. The narrow server-owned listing method is the authorization boundary.

An attach or command failure disposes the connection. The same read falls back to
the existing spawned listing, with persistent reconnect attempts separated by
five seconds and each control reply bounded to two seconds. When the spawned
fallback confirms “no server running”, ordinary dashboard scans also back off that
socket for five seconds instead of polling a stale socket file. A changed socket
identity bypasses this backoff, as do forced discovery and lifecycle reads. Socket discovery
reaps removed or replaced identities, and application shutdown closes every
command connection. A continuous degraded period warns once; another successful
listing rearms that diagnostic, while intentional close, retention, and socket
replacement remain silent. Ending the initially attached session can move the
observer to another surviving session without a reconnect.

Stack display consumes the same successful pane snapshot for its configured
socket, including dead panes and their exit statuses. Failed or incomplete
listings are explicit unavailable observations, not authoritative empty snapshots,
so stack display stays unknown without spawning a duplicate listing during the
observer's retry window. Successful and unbacked failed observations expire after
two seconds; confirmed missing-server observations expire when their five-second
retry is due. A missing or malformed snapshot falls back to a fresh stack listing.
Start, Stop, Remove, pane membership, and other lifecycle-sensitive checks do not
use these display snapshots. A Starting stack also forces a listing begun after
the transition, so an older successful display snapshot cannot end a new Start.
