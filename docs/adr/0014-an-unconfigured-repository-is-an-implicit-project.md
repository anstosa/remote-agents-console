---
status: accepted
date: 2026-10-22
---

# An unconfigured repository is an implicit Project

The operator works in many repositories, and most of them need nothing from the console beyond agents, Code panel diffs, the review tour and Terminals. Until now each one had to be written into `projects[]` to get any of that, and the console then needed a restart. Without a config entry, an agent run in an unconfigured repository landed in an ad-hoc Scratch Place (ADR 0003), where every git route answers 409.

We decided that an unconfigured git checkout is an **implicit Project**: the Project that a config entry naming only its `path` would load. It is never written to config. Its id is derived from the common git directory alone: a slug of the repository's folder name (`repo` for `repo/.git` or a bare `repo.git`) and 8 hex of the sha256 of that directory's path. Adding or removing a checkout therefore never changes it. A config entry with no `id` derives the same id, so the operator can add a repository to config later and its Notes, pins and launch profile carry over. An implicit Project carries no commands, `newTask`, Project buttons or preview, because those come only from config. Like Scratch, it shows only the application-wide buttons, which are the operator's own config. Its Worktrees are discovered from git and served by the same routes as any Worktree, Add, Remove and Prune included.

## Lifetime

Discovery rebuilds the implicit Projects on every Worktree scan, from the Place ids that name them: tmux session marks (ADR 0009) and pins. A Place id `<id>:<path>` names an implicit Project when no configured Project has that `id`, and when `<path>` is a git checkout whose derived id is `<id>`. That rebuilds the Project from a mark after a restart, the way an ad-hoc Scratch mark is rebuilt today. A Project that no mark or pin names any more drops out, and its Worktrees go with it. Its Main worktree starts unpinned, so a repository that an agent once ran in does not keep a tab.

## Claims

ADR 0009's claim of an unmarked session changes in two ways when the root (git toplevel, else cwd) is a checkout git lists. A root in no configured Place is marked with its implicit Project's Worktree instead of `scratch:<root>`. A root below the configured Scratch folder is treated the same way. With `scratchDirectory` unset, the Scratch folder is the account home, and it would otherwise swallow every repository. A Scratch folder that is itself a repository (a dotfiles home, say) stays Scratch. A root whose repository is a configured Project, but whose checkout the last scan did not list, is marked with that Project's Worktree. A claim naming a Worktree not listed yet re-scans the Worktrees once, in the same dashboard build. Marks already written are never re-derived: a repository first seen as `scratch:<root>` stays that Scratch Place for that session.

## Open folder

Any folder can be opened as a Workspace, by path or from a list of recent folders. It opens at the Place of its root by the claim rule, so a subfolder of a repository opens that repository's Worktree. One exception: a folder that is no git checkout is its own Scratch Place (`scratch:<realpath>`) even below the configured Scratch folder, where a claim would put it in the Scratch folder itself. A session marked with such a folder belongs to it, though no claim ever writes that mark. Opening launches an Agent, opens a Console shell, or pins the Place. An Agent can therefore launch in an ad-hoc Scratch folder, but only from Open folder: Runs, Schedules and Buttons still refuse one. Opening a Worktree that no scan lists names it for the rest of the run, so it is listed before anything runs there. After a restart its session mark or pin names it, as any implicit Project's does.

A first launch in a folder the agent has not seen may stop on the agent's own trust prompt (Claude's defaults to "No, exit"). Open folder reports that as needing the operator, who answers it in the Workspace, rather than as a failed launch.

The recent folders live in `.data`: at most 50, newest first, one per realpath. A folder that no longer exists is left out of the list but kept, and Forget removes only the entry. A damaged list starts again rather than refusing every later open. Recent folders do not name implicit Projects. An implicit Project kept alive by every recent repository would scan each one's git state on every poll.

## Considered options

- **Auto-discover repositories** under configured roots. ADR 0003 rejected this because a Project carries trusted stack commands and push actions (push actions are now Buttons). An implicit Project carries neither, but scanning would still list every repository on disk. Implicit Projects exist only where the operator ran something, pinned something, or opened a folder.
- **Give git routes to ad-hoc Scratch Places.** Every git route would grow a second, Place-shaped path. An implicit Project reuses the Worktree path unchanged.
- **Key an implicit Project by its path.** The id would change with every checkout of the repository, and Project-wide state (Notes) would split between them.

## Consequences

- **A configured Project wins.** An implicit Project whose repository a configured Project manages is dropped. A session marked with the implicit id is then unplaced (ADR 0009: a mark naming no Place), unless the config entry omits `id` and so derives the same one.
- **A Project configured without an `id`** whose path is missing at boot does not load at all, with a boot warning, because it has no identity to derive an id from. A non-git directory Project derives its id from its own path. The Settings form still requires an `id`, so clearing one there cannot silently re-key a Project and orphan its state. Omitting the key in the source is the deliberate way to derive one.
- **Schedules and branch cleanup skip implicit Projects.** An unattended Run closes its pane, after which an unpinned implicit Project drops and the Schedule's target is gone. Branch cleanup would query GitHub and notify about repositories the operator never opted into.
- **The Project list changes at runtime.** Discovery answers `projectsNow()`, and every consumer that can meet an implicit Project reads it each time. Those that act only on directory Projects, stack commands or the console's own checkout keep the boot-time config list, because no implicit Project has any of them.
- **The launcher lists configured Projects only.** The dashboard marks an implicit Project `implicit`, and its Worktrees show as tabs while occupied or pinned.
