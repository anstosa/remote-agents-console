# Can structured Claude host the Conductor?

Probed 2026-11-21 against Claude Code 2.1.328 on voyager, to settle ADR 0018's precondition for a kind other than Pi: the console must arm or confirm the kind's sandbox, and keep the console token out of its commands. Both probes drive `claude -p --input-format stream-json --output-format stream-json` with the control protocol, as the Claude client does. Re-run them after a Claude update, since the console does not pin Claude.

- `probe.mjs`: role prompt, settings read-back, token handover, a sandboxed leak test, and compaction handoff.
- `probe2.mjs`: loading no setting sources, and the file-tool blocks outside the working folder.

Run each outside the sandbox (`node docs/research/claude-conductor/probe.mjs`). Each costs a few cents of Haiku and leaves session files under `~/.claude/projects` for its scratch folder.

## Findings

| Need | Mechanism | Result |
|---|---|---|
| Role prompt | `initialize` with `appendSystemPrompt` | Works: the model quoted a codeword from it. |
| Token over the protocol | `mcp_set_servers` with `{ rac: { type: 'http', url, headers: { Authorization } } }` | Works: `{"added":["rac"]}`; every MCP request carried the header; `mcp__rac__*` tools listed at the next Turn. The token appeared in no process's argv. |
| Token stays out of commands | Claude's sandbox (bwrap through the sandbox runtime) | A sandboxed command ran in its own PID namespace, saw 4 PIDs, and could not see the Claude process, so neither its `environ` nor its memory was reachable. This matters because `kernel.yama.ptrace_scope` is `0` on voyager. The sandbox runtime Pi uses passes `--unshare-pid` and `--proc` too (`linux-sandbox-utils.js`). |
| Network confined | inline `sandbox` settings | `curl https://example.com` was refused (`deny network-outbound … (user denied)` under `dontAsk`). |
| Confirm what is armed | `get_settings` control request | Returns `effective` (merged), `sources` (each source's raw settings, in merge order) and `applied`, which reports `outsideFileToolReadsBlocked` / `outsideFileToolWritesBlocked`. |
| Fail closed | `sandbox.failIfUnavailable: true`, `allowUnsandboxedCommands: false` | Both show in `effective.sandbox`. |
| No operator settings | `--setting-sources ''` | `sources` is only `flagSettings` (the inline `--settings`): no hooks, no plugins, none of the operator's sandbox lists. `--setting-sources none` is rejected (`Valid options are: user, project, local`). |
| File tools confined | `permissions.blockFileToolReadsOutsideWorkingDirectories`, `blockWritesOutsideWorkingDirectories` | Read and Write outside the working folder are refused with the setting named. A sandboxed `cat` outside still reads, as the sandbox's `denyRead` list allows. |
| Compaction handoff | `initialize.hooks.SessionStart: [{ matcher: 'compact', hookCallbackIds }]`, answered with `{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }` | The CLI sent a `hook_callback` for `SessionStart:compact`; afterwards the model quoted the added state verbatim. |

## Traps

- **Settings merge, they do not replace.** With `--setting-sources user`, the operator's `sandbox.network.allowedDomains` (which included `*.i.grosinger.net`, where the console lives), `sandbox.excludedCommands` (run unsandboxed), Bash allow rules, hooks (run unsandboxed) and plugins all merged into the inline settings. A Conductor must load no setting sources.
- **`mcp_status` echoes the server config, header included.** The console must never log that response.
- **`mcp_set_servers` replaces the whole set.** Sent with only `rac`, it answered `removed: ["operator"]` and dropped the SDK server the launch declared in `--mcp-config` and `initialize`. Sent with `operator: { type: 'sdk', name: 'operator' }` beside `rac`, it answered `added: ["rac"], removed: []`. (Checked on 2.1.328 with control requests alone, no Turn.)
- **`dontAsk` denies writes inside the working folder too.** A Conductor that may write in its own directory Project needs an explicit allow rule for Edit/Write; the outside-folder blocks keep that rule from reaching further.
- `get_settings` also reports `served_settings_state` (`ineligible` here); it is unrelated to the sandbox.
