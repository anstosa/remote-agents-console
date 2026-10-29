---
status: accepted
date: 2026-10-26
---

# Structured Agent processes are held in the Workspace session

A structured Agent (ADR 0015) is a child process speaking a protocol over stdio, and Pi's RPC mode shuts down when its stdin closes. If the console spawned it, every deploy would kill it: the user unit's default `KillMode=control-group` takes the console's children down on each restart, including a Pi Agent that is itself deploying the console. Instead, each structured Agent's process runs under a small console-shipped *holder* in its own tagged window of the Place's Workspace session, the way Stack processes do. The holder owns the child's stdio and serves it on a Unix socket. A restarted console reconnects, and the holder replays every output line the console has not yet read. A turn in flight therefore loses nothing across a deploy, and Agents of both Transports share one lifetime: they survive deploys and die with tmux on reboot.

## Considered options

- **Children of the console server.** Simplest, but a deploy interrupts every turn in flight, the Conductor included. The Conversation resumes with `--session`, but the turn, Pi's in-memory queues and any open dialog are lost.
- **One long-lived agent-host service**, a second systemd unit the console reconnects to. A new deployable with its own upgrade story, and no fit for Docker's container-local tmux.
- **A `systemd-run --user` scope per Agent.** It escapes the console's cgroup, but it is systemd-only and invisible to the operator.
- **A FIFO or file instead of a socket.** A FIFO is a path, so a sandboxed model could write RPC commands into its own Agent wherever the policy allows writes. seccomp already blocks the model's commands from connecting to any Unix socket (ADR 0004).

## Consequences

- **The holder is protocol-neutral.** It holds any stdio child and passes its lines through without parsing them, so Codex's app-server or an ACP adapter would use it unchanged. Because the stream itself survives, a restarted console can even carry on an ACP connection without a new `initialize`, as long as it has saved the negotiated capabilities.
- **The holder protocol stays trivial.** Running holders keep their code across console deploys, so the console must keep speaking to older ones.
- **Replay is bounded.** On overflow the holder says so, and the console resyncs from the protocol instead (for Pi, `get_state` and `get_entries since <cursor>`) and treats any pending dialog as unknown.
- **The holder never restarts its child.** When the child exits the holder exits too, and `remain-on-exit on` keeps the pane, so its stderr shows on the Agent. The Agent is then Exited: its record and Queued prompts are kept, the queue is not dispatched, and the process is resumed on the same Conversation only when the operator sends a prompt or chooses Resume. This applies after a reboot too.
- **Closing the Agent stops the child** (SIGTERM, then a kill) and removes the window. A window or session killed by hand leaves the Agent Exited, not closed. Only a live structured Agent blocks Remove, and Remove closes an Exited one, turning its queue into Notes.
- **Discovery skips holder windows.** They carry an `@rac_role` mark, so the CLI inside is never listed as a Terminal or recognised as a hand-started tmux Agent.

*Amended 2026-10-28 for the Conductor (ADR 0018, ADR 0019):* the Conductor is the one exception to "resumed only when the operator sends a prompt or chooses Resume". The console launches it when it is configured and not running, at console start (so also after a reboot) and whenever it exits, because it has to act while the operator is away. The holder still never restarts its child; the console does. After 3 exits in 10 minutes the console stops trying, leaves it Exited and sends a push, and its queue keeps filling until the operator resumes it. The Conductor offers no Close, only Restart and New Conversation; removing its configuration turns it off.

*Amended 2026-10-29 while building it:* the console saves how many lines it has read only at idle points (the launch report and each Turn's end), not per line, so a restarted console's replay starts at the Turn in flight and the protocol client sees that Turn whole. Lines between Turns may be read twice; the Pi client tolerates that, as its request ids are unique per connection. On overflow the Pi client resyncs from `get_state` and the Conversation's history (`get_messages`), which it reloads on every reconnect anyway; `get_entries since` is not needed, because an overflow drops only the oldest lines, so the Turn's answer and end are always in the replayed tail.
