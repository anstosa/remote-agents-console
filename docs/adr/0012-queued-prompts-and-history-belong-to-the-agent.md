---
status: accepted
date: 2026-10-14
---

# Queued prompts and history belong to the Agent

ADR 0003 keyed queued prompts and prompt history by Worktree. That held while a Worktree ran one Agent. Now a Workspace can hold several, and every Agent at the Worktree drained the one queue. A prompt sent to a busy Agent was queued, and on the next tick an idle sibling at the same Worktree took it and started work, because the queue recorded nothing about which Agent the prompt was for.

Both stores are now keyed by the Agent, `agent:<agent id>`, where the id is its pane (`<socket fingerprint>:<pane id>`). A queued prompt is delivered only to the Agent it was sent to, and an Agent's history lists only its own prompts. Update advisors and Review runs were already keyed this way. Every Agent now is.

## Considered options

- **Keep the Worktree key and record the target Agent on each prompt.** This fixes delivery but still needs the in-flight prompt state per Agent. History would stay shared, so one Agent's history would list a sibling's prompts.

## Consequences

- **A departed Agent's queue becomes Notes.** Once an Agent has been missing from discovery for 30 seconds, its queued prompts are saved as queued-prompt Notes, the same as a halted queue, and its history is dropped. The grace period covers a socket that briefly fails to list. Each queued prompt records where its Agent ran (`origin`: home and Place), so the Notes still go to the right Project or Place after the pane is gone. A prompt with nowhere to go stays queued and is retried after another grace period.
- **A restart hands over.** An idle restart replaces the pane, so the id changes. While the restart lock is still held, the old Agent's queue and history move to the replacement. If the restart fails, the old Agent's queue becomes Notes.
- **Worktree-keyed records left from before this change** have no live owner. Their queued prompts drain into the Worktree's Project notes, and their history is dropped.
- **Remove no longer clears queues or history.** A Worktree can only be removed when no Agent is running there, so its Agents' scopes have already been retired.
