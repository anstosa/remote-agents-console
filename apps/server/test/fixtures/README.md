# Adapter fixtures

One directory per agent `kind`. The shared contract suite in
`../adapters/contract.test.ts` runs every registered Adapter against its own
fixture directory, so an Adapter cannot ship without evidence of what it
recognises and parses (ADR 0002).

Each `<kind>/` directory holds:

- **`processes.json`** — `{ match, noMatch }` process identities (`comm` + `argv`)
  fed to `recognizes()`. `recognizes` sees a single process; a sandbox wrapper
  (`srt`/`bwrap`) is an ancestor and belongs in `noMatch`.
- **`titles.json`** — `[{ title, state }]` pane titles fed to `inferState()`.
  A kind whose title carries no signal maps every title to `undefined`.
- **`prompts.json`** — `[{ prompt, mode, text, keys }]` fed to
  `submission.prepare()`. The suite also asserts the generic key rules on the
  produced keys (Enter never without a paste; never `Escape Escape`; never
  `C-c C-c`).
- **`captures.json`** *(optional; only for kinds with `turns`)* — raw
  `capture-pane -e -p` snapshots (`lines` joined with `\n`) and the expected
  `latestCompletedTurn` (`null` ⇒ none), `lastPrompt`, `latestMessage`, and
  `failed`.
- **`submission.json`** *(optional)* — `{ interrupt, selectOption }` key sequences
  pinned exactly (in addition to the generic key rules the suite always asserts).
- **`conversations.json`** *(optional; only for kinds with `conversations`)* —
  `{ valid, invalid }` conversation ids fed to `validId()`.
- **`new-conversation.json`** *(optional; only for kinds with `newConversation`)* —
  the reset `command` (also asserted to be an entry in that kind's slash catalog) and
  three case lists: `composerEmpty` (`{ lines, empty }` — empty composer, draft, open
  dialog), `settled` (`{ before, observed, elapsedMs, result }` snapshot sequences),
  and `ready` (`{ snapshot, lines, result }` fresh-launch snapshots). The captures and
  timings come from the settle probe
  (`docs/research/new-conversation-settle-probe.md`).
- **`hooks.json`** *(optional; only for kinds with a `files` capability)* — the
  golden render of that kind's console-owned settings file, pinned by the kind's
  own hooks test (not the shared contract suite).

## Codex

Captured from today's Codex behaviour: the inline strings already exercised by
`tmux.test.ts`, `prompts.test.ts` and `processes.test.ts`, which are themselves
snapshots of live Codex panes. Because chunk 1 commit 1 lands fixtures-first,
the suite runs green against today's code through the shim in
`../adapters/codex-shim.ts` before any Codex logic moves — so a later chunk that
drifts Codex behaviour fails the contract suite rather than a person.
`processes.json` recognises plain Codex only: the OMX wrapper is `noMatch`
because OMX is its own kind (ADR 0005), while the Codex child OMX launches still
matches by its own identity (the walker meets the OMX wrapper first).

Codex has no golden `files` (hooks/sandbox settings) to pin; those arrive with
the Claude and Pi kinds. The numbered-choice → Inline question parser still
lives in the web bundle today, so it is not yet exercised here; it moves
server-side (and gains capture fixtures) later in chunk 1.

## OMX

`recognizes` the OMX wrapper — a `comm` of `omx`, an argv[0] basename of `omx`,
or `node` running `…/dist/cli/omx.js` (the form every npm/mise install takes,
since the bin shim execs node) — and only in its Agent forms, decided from the
first argument after the entry as OMX's own dispatcher does: absent, `launch`,
`resume`, or a leading `--flag` is the launch. Every other subcommand
(`hud --watch`, `team`, `sidecar`, `mcp-serve`, …), the Codex child OMX
launches, and the notify-fallback watcher it spawns beside Codex are `noMatch`. The `(probed)` entries are verbatim `/proc` captures
of OMX 0.21.0 launched console-style (`--direct`, `--direct resume --last`,
`hud --watch`), with only the home directory renamed. `titles.json`,
`prompts.json`, `submission.json`, `conversations.json`, `questions.json` and
`new-conversation.json` mirror Codex's because OMX runs the Codex TUI and the
Adapter shares those objects by reference; a drift between the two directories
means the sharing broke (the suite asserts the new-conversation directories are
identical).

## Claude

`recognizes` the `claude` process (native comm, an argv[0] basename of `claude`,
or `node` running `@anthropic-ai/claude-code/cli.js`) but never a `bash -c` tool
child or an `srt` wrapper ancestor. Every title maps to `undefined` — Claude
reports its state through hooks (`stateSource: 'reported'`), so its title carries
no Attention signal. Prompts submit with paste + Enter in both modes (never Tab),
and `submission.json` pins the `Escape`/`C-c` interrupt and the option-select
sequences. `conversations.json` covers the session-UUID `validId`. `hooks.json` is
the golden render of the injected `--settings` file, pinned by
`../adapters/claude-hooks.test.ts`. `new-conversation.json` pins the `/clear`
reset: the empty `❯ ` composer, a fresh session's reported id, and the
untrusted-directory safety-check block. `final-message.jsonl` is a trimmed session
transcript (one record per content block, records of one message sharing
`message.id`, a sidechain reply) that `../adapters/claude-conversations.test.ts`
reads the final assistant message from, as an interactive Review run does.

`structured/` holds Claude Code 2.1.319 driven headless over stream-json (`claude
-p --input-format stream-json --output-format stream-json --verbose
--permission-prompts host`), recorded by probes and sanitized: the operator's
account, skills and paths removed, the probe sessions renamed to one (the session
`/clear` starts keeps its own id). Each `<scenario>.jsonl` is the CLI's stdout for
one exchange; a `control_response` to the client's own request names that
request's subtype in place of its id. `turn-steer-replay.jsonl`, `clear.jsonl` and
`initialize-again.jsonl` were recorded with `--replay-user-messages`, as the
console launches Claude: prompts echoed and their `command_lifecycle`, under the
ids the probe sent them with, which the tests swap for the client's. The others
predate that flag. `initialize-again.jsonl` is the answer to a second `initialize`
with its lists trimmed: `commands` (106 recorded) and `agents` (13) cut to one
each, and `models` (14) to `default`, `sonnet` and `haiku`; the entries kept and
every other field, `capabilities` included, are as recorded. The SessionStart hook output in `launch.jsonl` and
`compact.jsonl` is the shape the console's hook prints, as `clear.jsonl` records it.
`session-*.jsonl` are session transcripts as the CLI writes them;
`session-edit.jsonl` is hand-written in the shape of real Edit and Write records;
`session-unnamed.jsonl` is a probe-4 session cut to its queue, hook, prompt and
message records (bookkeeping, request and account records dropped, paths and
session id renamed, the nonce replaced).
`../claude-client.test.ts` and `../claude-history.test.ts` read them.
