# Agent upgrade smoke

Run this smoke before promoting a new Codex, OMX, Claude, or Pi version. It has
two gates: a deterministic repository test and an operator-run check against the
actual candidate.

## 1. Repository gate

From the repository root, run:

```sh
pnpm test:agent-upgrade
```

The command reuses the existing adapter, structured transport, launch/resume,
prompt queue, inline-question, and reply-suggestion suites. Adapter behavior is
checked against committed pane fixtures. The structured transport suite launches
the repository-pinned Pi package against a local stub provider.

This command does **not** install or execute the configured Codex, OMX, or Claude
candidate. It does not use an operator account, change credentials, select a
fallback model, or send a request to a model provider. Passing it is necessary,
but it is not proof that the actual candidate works.

## 2. Actual-candidate gate

Run this checklist manually for every adapter and transport the installation will
promote. Use a disposable test project, Agent, and Conversation with no sensitive
context; do not reuse, stop, or modify an existing work session. Record the
adapter kind, transport, executable path, reported version, account, and selected
model before starting.

The checklist does not install the candidate, log in, refresh credentials, or
change account/model selection. Prepare those separately through the normal
operator-controlled update and settings flows. The prompts below make real model
requests and may consume paid usage; run them only after choosing to do so.

1. **Launch.** Start a new Agent from the console and confirm the candidate's
   reported version, kind, model, and idle state are the expected ones.
2. **Send and queue.** Send `Reply with the word ready and one short sentence.`
   Immediately queue `Reply with the word queued.` Confirm the first turn settles,
   the queued prompt is delivered exactly once, in order, and the queue becomes
   empty.
3. **Answer an inline question.** Ask the agent to use the question tool for its
   adapter and transport (see below) to present Yes and No options and wait for
   your answer. Answer in the console. Confirm the question closes, the exact
   answer reaches the candidate, and the turn settles normally.
4. **Resume.** Stop the candidate without deleting its Conversation, then resume
   that same Conversation using the console's Resume action or Conversation
   selector. Confirm its earlier turns are present and a new prompt completes.
5. **Verify reply suggestions.** On an installation where **Agents → Reply
   suggestions** has deliberately been enabled and restarted, finish a turn with
   `End your reply with one direct question asking which smoke step to repeat.`
   Confirm reply chips appear. Select one and confirm it only drafts editable text
   in the composer; it must not submit the text. Then discard the draft.
6. **Clean up.** Close only the disposable Agent/Conversation created for the
   smoke. Restore any operator setting that was deliberately changed for the test.

Treat a missing, duplicated, reordered, or auto-submitted prompt; a question that
cannot be answered; lost resume history; or absent/non-drafting suggestions as a
failed promotion. Capture the candidate version and console diagnostics, then fix
or explicitly reject the candidate. Do not infer compatibility by widening a
version check or parser without evidence from the failing candidate.

## Adapter-specific checks

- **Codex:** exercise the native inline question UI.
- **OMX:** confirm the session is detected as OMX rather than plain Codex and that
  hidden worker panes do not become operator Agents. Repeat the paused-goal
  `/goal resume` check when applicable: the suggestion must appear and only draft
  the command before submission.
- **Claude:** use Claude's built-in `AskUserQuestion` in Terminal (`tmux`).
  In Transcript (`structured`), use the console's `ask_user` tool instead;
  that transport denies `AskUserQuestion`. If a structured Claude Conductor
  is enabled, also confirm it reaches ready under its existing sandbox and
  permission policy; do not widen either for the smoke.
- **Pi:** record and confirm the exact candidate, whether it is the repository's
  bundled pin or an explicitly newer host installation. Then exercise the RPC
  `ask_user` dialog and resume the same named Conversation.

Promotion passes only when the repository command and every relevant
actual-candidate checklist pass. The repository command is safe for CI; the
actual-candidate gate remains intentionally manual because it uses installed
binaries, real accounts, and model inference.
