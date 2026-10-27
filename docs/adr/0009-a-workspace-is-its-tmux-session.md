---
status: accepted
date: 2026-09-25
---

# A Workspace is its tmux session

*Amended by ADR 0015 (2026-10-26):* a Workspace has a tmux session rather than being one. Pane membership still follows the session mark as decided here, but a Workspace's structured Agents are recorded at its Place, and its other Panels need no pane.

ADR 0003 placed every pane by its cwd: the nearest Place containing its root. A Console shell opened in one Workspace that then `cd`'d into another Worktree's folder was split between two Places. The pane listing still streamed it, because its session held the first Place's other panes. The rename, end and Remove-gate lookups placed it at the second Place, so renaming or ending it from the first answered 404. A new Terminal at the second Place would also join the first Place's session.

Membership is now the tmux session. Every session the console creates carries a session option `@rac_place=<Place id>`, which every pane in it reads through `list-panes #{@rac_place}`, including panes in windows opened later. A pane belongs to the Place its session is marked with, wherever its shell has `cd`'d, and no pane outside a marked session belongs to any Place, even one sitting in a Place's folder. One rule places Agents (`placeId`), lists and counts Console shells, bounds the panes a Terminal may stream, picks the session a new Terminal or launch joins, and scopes Remove's idle-shell kill.

## Considered options

- **Stamp the Place on each Console shell pane.** This fixes rename and end, but a pane split by hand, or a window opened in an attached tmux, would carry no stamp. Membership would then still need the cwd rule as a fallback, which leaves two rules.
- **Match the session name.** Names are derived from the Place folder, but they gain `-2`/`-3` suffixes on collision and the operator can rename them.

## Consequences

- **Unmarked sessions are claimed once.** A session the console did not create (every session running before this change, or the operator's own session with an agent started by hand) is marked by the dashboard with the nearest Place, by ADR 0003's rule. The pane used is its Agent's, else a Console shell's, else a console-managed pane's. The mark is never re-derived afterwards. A session with none of these, such as the operator's own shells or `rac-stack-*` runs, stays unmarked and is never shown. Only the dashboard claims, because it has a settled Worktree list. A claim made against a list that has not been scanned yet would mark a Worktree's session as Scratch permanently.
- **A mark that names no listed Place leaves its session unplaced** and is never overwritten. This covers a Worktree the snapshot has not caught up to, or one since removed. An ad-hoc Scratch mark rebuilds its Place from the id while its folder lies in no configured Place.
- **An Agent started from a Workspace's Terminal belongs to that Workspace.** This holds even when it was started in another folder (`cd ../other && claude`). The server-side Agent still keeps `home` as the folder it runs in.
- **Launches never type into an existing shell.** A Worktree or Place launch prefers its live Agent's session, then a Console shell or Stack process session, then any session already marked for that Workspace. It starts the Agent in a new detached window, leaving every existing pane and any pending input untouched even when a shell is open in a Terminal, labelled, or has changed directories. This supersedes ADR 0003's idle-shell adoption rule: tmux can report the foreground shell and cwd, but cannot prove that zsh, bash or fish has an empty line-editor buffer.
- **A launch never displaces an unproven session.** When the Workspace has no marked session, the launch creates one under an available name. A name collision receives a `-2`/`-3` suffix instead of renaming, killing, or replacing the existing session.
- **This narrows ADR 0003's accepted risk.** Before, with `scratchDirectory` unset, the Scratch Place streamed every session holding a pane under the account home. Now it streams only sessions the console created or claimed, which means sessions holding an Agent or a Console shell.
- **Known limitation.** A claim made while a Project is unavailable (a missing mount) places that session in Scratch for good. Clearing the option by hand (`tmux set-option -u -t <session> @rac_place`) lets the next dashboard claim it again.
