---
status: accepted
date: 2026-10-27
---

# Only the Conductor acts on the console, and it spawns only Sandboxed Pi

The console's MCP server (`/mcp`, built for ChatGPT and the Davo voice assistant) is opened to Agents, but only to one: the *Conductor* (`CONTEXT.md`), which dispatches work to other Agents and spawns new ones. Ordinary Agents get no access. The Conductor is always Sandboxed, and the only Agents it can spawn are Sandboxed Pi Agents. We chose this because a per-Agent limit on what an MCP token may touch is only a boundary when the holder's commands cannot reach the token or the endpoint, and the console can guarantee that only where it arms and confirms the sandbox itself. For Pi it does: the console-shipped extension holds the token in the agent process, keeps it out of the environment of sandboxed commands, never allows the endpoint as a domain (ADR 0004 amendment), and reports at launch that the sandbox is engaged (ADR 0017). Claude's and Codex's sandboxes are configured in their own settings, so the console cannot tell whether one is on, and an Agent whose commands are unconfined can read any other Agent's token from `/proc`, `send-keys` into any pane, or derive the Realtime token from the console's `.env`.

**Before lifting the Pi-only spawn rule**, give the console a way to arm or confirm the other kind's sandbox, and keep its token out of that kind's commands. Before giving ordinary Agents access, solve the same problem for every kind.

## Considered options

- **A token for every launched Agent, limited to its own Project.** It matches "every Agent can act on the console", but each kind then needs its own token delivery (`--mcp-config` for Claude, `-c mcp_servers…` for Codex), and the limit is only a guardrail wherever commands are unsandboxed. A typical Agent has no need to drive other Agents.
- **"Never less sandboxed than the spawner."** It cannot be checked for Claude or Codex callers, whose sandbox state the console does not know. Always spawning Sandboxed Pi satisfies it without needing to know.
- **Treat Claude as sandboxed by its configuration.** This trusts settings the console neither writes nor reads.
- **Keep the Davo presence gate for the Conductor.** It would defeat the Conductor's purpose, which is to work while the operator is away.

## Consequences

- **The Conductor is a third kind of MCP principal**, after OAuth and Realtime. Its token is minted at launch, held only as a hash, registered by the RAC extension through `pi.registerMcpServer`, and revoked when the Conductor closes. It skips the Davo lease behind its own deployment flag, independent of the ChatGPT integrations. Feature gates, idempotency and audit apply unchanged, and it gets its own rate-limit bucket.
- **What it may call is the operator's choice**, through scopes in its config (the existing vocabulary plus `agents:spawn` and `notes:write`). By default it gets everything but `admin:dangerous`. Regardless of config, it can never call `answer_agent_question` (one Agent never consents for the operator) or the `launch_*` tools (they launch unsandboxed).
- **Agents it spawns get no token**, so spawning is one level deep. It may close the Agents it spawned, and no others.
- **A prompt it sends is reported back.** When the Turn ends (complete, failed, interrupted, or the target gone), a report queues to the Conductor, carrying the answer up to 8 KiB. A durable dispatch record makes this survive deploys. A target's questions still go to the operator.
- **The spawn tool and the docs say why** only Pi is offered, so the rule is not mistaken for an unfinished feature.

*Amended 2026-10-29 while building it:* the token reaches the Conductor's process over its protocol, never its environment or launch line (both show in the holder pane's start command): the seam's `consoleAccess`, which the Pi client sends as the RAC extension's `/rac-console` command. Pi runs an extension command at once and never adds it to the Conversation or the model's input; the command is registered in every RAC Pi, so it can never reach a model as a prompt, and only the Conductor takes it, once. The token's hash is kept on the Agent's record, so a deploy does not cut a Turn in flight off from the console. The Conductor's own deployment flag is its `conductor` configuration: `/mcp` is served whenever one is configured, independent of `integrations.enabled`, while the MCP feature gates still apply.
