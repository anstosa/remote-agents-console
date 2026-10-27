---
status: accepted
date: 2026-10-26
---

# Agents are driven over a Transport; Adapters describe the CLI

Every Agent has been a tmux pane. Every operation (submit, cancel, answer, close, rename, launch) looked the Agent up and called tmux with its pane, and most of the Adapter interface (ADR 0002) is defined in pane terms: keys to send, captures to parse, titles to read. Pi is to join as an Agent with no TUI, driven by messages, and Codex and Claude may follow. An Agent now carries a *Transport* (`CONTEXT.md`) beside its kind: **tmux**, as today, or **structured**. The seam sits above the pane-based Adapter members. The tmux Transport keeps them, and a structured Agent is driven through a protocol-neutral interface that needs nothing pane-shaped. We chose this so that adding Codex or Claude over a structured protocol later, or moving one of their Conversations from the TUI to a structured Transport, is one more protocol client behind the same seam rather than parallel machinery per kind.

## Considered options

- **Fit structured Agents into the Adapter interface.** Rejected: `submission`, `turns`, `questions` and `inferState` are keystrokes and captures. A message-driven agent would have to fake a pane or leave most of the interface empty.
- **Shape the seam around ACP.** ACP was wanted as the generic interface across agent harnesses, but it specifies no steer or queue, and the Pi ACP adapters are immature. Pi's own RPC mode keeps steer and follow-up, and Claude and Codex also have SDK modes. The seam is instead shaped by what these protocols share, and none of them is privileged.
- **Use the CLI's session id as a structured Agent's id.** Rejected: it would make the Agent and its Conversation the same thing, when switching Conversation in place is a normal operation.

## Consequences

- **The structured interface is protocol-neutral.** It covers what Pi RPC, ACP, the Claude Agent SDK and the Codex app-server have in common: start or resume a session, send a prompt (as a steer or a follow-up where the protocol can tell them apart), cancel, a stream of updates (messages, tool calls, usage), permission requests and questions, and session settings such as the model. A kind is added by adding a protocol client behind it. Protocol-specific features stay inside that client unless a second protocol needs them.
- **Adapters still describe the CLI.** Launch arguments, sandbox needs, rendered files and the Conversation store apply over both Transports. The pane-based members (`submission`, `turns`, `inferState`, pane `questions`, `panes`) are used only by the tmux Transport.
- **Capabilities are derived per kind and Transport**, not per kind alone.
- **A structured Agent's id is minted by the console at launch.** It lasts until the Agent is closed, across restarts of its process and changes of Conversation, so it needs no handover (ADR 0012). A tmux Agent keeps its pane id, and restart still hands over to the new pane.
- **Console-owned state stays above the seam, keyed by Agent id.** That means Queued prompts and the decision to dispatch, prompt history, notifications, and a closed Agent's queue becoming Notes. A Transport only delivers. The console keeps its own durable queue even where a protocol queues in memory.
- **Pane details move off the Agent into an optional pane part**, and an Agent says whether its Panel shows a terminal or a transcript.
- **Launch returns the new Agent's id.** Waiting for a new pane to appear becomes the tmux Transport's internal concern.
- **The first step changes no behaviour.** The seam is introduced with only the tmux Transport behind it, and afterwards nothing outside it calls tmux with an Agent's pane.
- **A Workspace has a tmux session; it is not one.** Its session still holds its Terminals and tmux Agents, placed by the session mark (ADR 0009). Its structured Agents are recorded at its Place, and launching one creates the session if it is missing.
