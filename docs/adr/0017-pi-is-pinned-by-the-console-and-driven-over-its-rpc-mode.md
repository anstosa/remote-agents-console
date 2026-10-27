---
status: accepted
date: 2026-10-27
---

# Pi is pinned by the console and driven over its RPC mode

Pi is the first structured Agent (ADR 0015). Every other kind is a CLI the operator installs: `adapters.<kind>.program` names it, and the Agent updates list upgrades it through the operator's `updates` commands. Pi is coupled to the console in three places those kinds are not: the console's protocol client speaks Pi's RPC wire format, the console-shipped sandbox extension (ADR 0004) depends on Pi's extension hook API, and that extension registers the console's MCP server through `pi.registerMcpServer`. Pi also releases quickly (1.0.0 on 2026-10-01, 1.4.0 on 2026-10-21). An operator upgrade could break any of the three, and a break in the hook API leaves every Pi Agent refusing its tools. So the console pins Pi itself, exactly, as a dependency of `apps/server` like the sandbox runtime, and drives `pi --mode rpc -e <RAC extension>` under the holder (ADR 0016) with a thin protocol client of its own. A Pi upgrade is a change to the pinned version, merged only when a contract suite against that version passes.

## Considered options

- **Operator-installed, like the other kinds.** Consistent, and upgradable from the Agent updates list, but the console could not test against the version it drives, and one click could break the protocol client, the sandbox or MCP registration.
- **A third-party Pi ACP adapter.** Pi has no ACP mode and its maintainer points integrations at RPC mode. The adapters are thinly maintained or archived, lack steer, and drop the `input` and `editor` dialogs; an ACP adapter also owns the Pi child, so the holder could not keep Pi alive across a console restart.
- **The Pi SDK in a console-owned host program inside the holder.** Full access to Pi's internals, but a second program built against Pi's TypeScript API and rebuilt for every Pi minor release. It must bind extensions itself, or the sandbox extension never starts, and add MCP and code mode by hand. RPC mode loads all of these as Pi's own CLI does, and its wire protocol changes slowly.

## Consequences

- **The console supplies Pi's program.** `adapters.pi` enables the kind and carries `args`, `env`, `setup` and `teardown`; a `program` or `updates` key under it is refused at validation, with a message saying why.
- **A contract suite gates every Pi version.** It runs the pinned Pi with the RAC extension against a stub OpenAI-compatible provider, and covers starting, prompting and the event stream, steer and follow-up, an extension dialog round trip, a reconnect through the holder with `get_entries since`, `set_model`, the sandbox refusing an out-of-policy command and failing closed, and MCP registration.
- **A Pi Agent must report in before it is used.** At `session_start` the extension reports that it is loaded, that the sandbox is engaged, and Pi's version. The console dispatches nothing to the Agent until that report arrives; without it the Agent is shown as failed with Pi's stderr.
- **The protocol client speaks only the pinned version**, and logs and ignores fields and events it does not know. After a deploy that changes the pin, a live Pi Agent on another version is restarted at its next idle point: Pi is stopped and the same Conversation resumed on the pinned version, keeping the Agent's id and Queued prompts. The restart is automatic so that Schedules and the Conductor do not wait on the operator.
- **A turn in flight across a pin change can fail.** Installing the new version may delete files the running Pi has not loaded yet. Pin changes are rare and deliberate, so this is accepted rather than avoided with version-keyed installs; such an Agent becomes Exited and resumes on the new version.
- **Pi's update check is built in and only informs.** Its current version is the pin and its latest is the npm registry's; the Agent updates list shows that a newer Pi exists, with no Run action, because upgrading is a change to the console.
- **Pi shares the operator's `~/.pi/agent`.** Logins (`/login openai`, `/login openrouter`) are made once in a Pi TUI, and Conversations started by the console can be resumed by hand. A hand-run `pi` should be the pinned version, since both write the same session files.
