# Remote Agent Console

A self-hosted browser console that watches and drives coding-agent CLIs running inside tmux panes on the host. This glossary fixes the words used across the server, the web app, and the config.

## Language

### Repositories and checkouts

**Project**:
A configured git repository. Owns everything that is true for the whole repository: label, stack commands, new-task and push actions, the Worktrees directory, and the preview URL.
_Avoid_: Repo entry, workspace

**Worktree**:
One checkout of a Project as reported by `git worktree list`, the main checkout included. Discovered from git, never declared in config.
_Avoid_: Worktree entry (Workspace is a different thing: the Panels open at a Place)

**Main worktree**:
The checkout that holds the repository's git directory; git lists it first. A Project may be configured through any of its Worktrees, but only the Main worktree can differ between the console's view and the host's.
_Avoid_: Primary checkout, root worktree

**Linked worktree**:
Any other checkout of the Project, created with `git worktree add` by the console or by hand.
_Avoid_: Secondary worktree, branch checkout

**Pinned**:
A Place whose Workspace the operator keeps even while no Agent runs there. Chosen per Place in the console; a Main worktree starts pinned, every other Place does not.
_Avoid_: Favourite, sticky, visible

**Worktrees directory**:
Where the console creates a Project's new Worktrees. Says nothing about where Worktrees may live; git is the only source of what exists.
_Avoid_: Worktree root, checkout folder

**Stale worktree**:
A Worktree whose checkout is gone but whose trace remains: an entry git still lists with a missing directory, or console records for a Worktree git no longer lists. Cleared only by Prune.
_Avoid_: Prunable (git's word for one half of it), orphan, ghost

**Prune**:
The explicit per-Project action that clears a Project's Stale worktrees, both git's entries and the console's records. Never runs on its own.
_Avoid_: Cleanup (reserved for agents), garbage collection, auto-prune

**Scratch**:
A folder that belongs to no configured Project, seen as a Place. The console launches into one configured Scratch folder, but any unconfigured folder an agent runs in is a Scratch of its own.
_Avoid_: Unconfigured worktree, scratch pane

**Place**:
Where a Workspace lives and what its panes belong to: a Worktree, a directory Project, or a Scratch folder. Each has a home folder. A pane belongs to the Place its tmux session is marked with, wherever its shell has `cd`'d; a session the console did not create is claimed once, by the nearest Place whose home contains its Agent or Console shell.
_Avoid_: Location, target, context

### Agents

**Agent**:
A live tmux pane whose process tree runs an agent CLI. Carries a kind naming the Adapter that recognised it.
_Avoid_: Session, process

**Adapter**:
The server module that knows one agent CLI: how to launch and resume it, recognise its processes, read its state, submit prompts, and find its Conversations. It describes the agent; the console performs every action.
_Avoid_: Driver, plugin, agent type (use "kind" for the identifier, "Adapter" for the module)

**Conversation**:
The agent CLI's resumable transcript, identified by an id whose shape depends on the Adapter. What a resume brings back; distinct from the Agent, which is the live pane. It belongs to the Worktree directory it was started in and resumes there.
_Avoid_: Session (that word is reserved for tmux), thread, chat

**Conversation name**:
What the agent CLI calls a Conversation: the name a human gave it, or failing that the title the agent generated. The console only ever sets one through the agent CLI's own rename command.
_Avoid_: Bookmark, session name, summary

**Named conversation**:
A Conversation that has a Conversation name. What the console lists and offers to resume; a Conversation with only its id is not shown.
_Avoid_: Bookmark, saved chat, session

**Launch profile**:
The choice a worktree launches with: an Adapter plus whether the agent is Sandboxed. The Adapter is remembered per Worktree as the last one used; Sandboxed starts on whenever the Adapter offers it and is never remembered.
_Avoid_: Agent selection, launch preset

**Setup command / Teardown command**:
Operator-configured lifecycle commands on an adapter entry, keyed by kind. The setup command runs in the launched pane before the program and aborts the launch on failure; the teardown command runs best-effort in the agent's home folder after the console stops an agent of that kind. Home for host-specific repairs (the OMX-on-ZFS pointer cleanup, on the OMX Adapter's entry), not part of the Adapter module.
_Avoid_: Pre/post hooks (hooks name the agent-CLI mechanism Adapters inject)

**Sandboxed**:
An agent whose model-driven commands run with filesystem and network restrictions. The agent process itself is not confined: each Adapter sandboxes the commands its own way, natively where the CLI can, otherwise through a console-shipped extension.
_Avoid_: Isolated, jailed, wrapped

**Attention state**:
What an Agent needs from the operator right now: working, finished, or question.
The UI, notifications, and integration attention/workspace summaries also show a question when an idle Agent's latest unanswered message asks one in prose. This does not create an Inline question or switch the composer into answer mode; replies still use the normal prompt path.
_Avoid_: Status, activity

**Reported state**:
An Attention state the Agent announced itself. Takes precedence over Inferred state, and counts only while the Agent that announced it is still alive.
_Avoid_: Hook state, pushed state

**Inferred state**:
An Attention state the console derived from what the pane shows, used when the Agent has announced nothing.
_Avoid_: Scraped state, heuristic state

**Turn**:
One prompt and the Agent's complete response to it. What prompt history records; not every Adapter can recover one from the pane.
_Avoid_: Exchange, round, message pair

**Inline question**:
A question the Agent is asking that the console can answer on the operator's behalf by choosing one of its options, whether the Agent wrote it as a file, reported it through its pane (Claude's `AskUserQuestion` payload, ADR 0006), or only drew it on the pane.
_Avoid_: Choice list, structured question, parsed question, reported question (those name where it came from, not what it is)

### Panes

**Capture**:
What a pane shows and has scrolled off, read from tmux at one instant. What the console reads a Turn or an Inline question from; never what a viewer watches.
_Avoid_: Snapshot, frame, scrape, log text

**Pane stream**:
A pane program's output delivered to the browser byte for byte as it happens. What a viewer watches; the console never parses it.
_Avoid_: Log feed, output channel, live capture

**Size claim**:
A panel's standing request that its pane be sized to the panel's grid, yielding to any smaller terminal attached to the window. One per window, held only while the panel is shown; the panel always conforms to the size the pane actually gets.
_Avoid_: Viewport lease, pin, resize request

**Workspace**:
The set of Panels open at one Place, and the console's unit of navigation: one per Place, selected from the tab row. Its panes are those of the tmux session marked with its Place, and no others. It exists while its Place has an Agent, a Console shell, or a pending launch, or is Pinned; which Panels are open is remembered per browser.
_Avoid_: Tab (the selector entry), session, worktree (a kind of Place)

**Panel**:
One of the six things a Workspace shows side by side: agent, terminal, notes, browser, code, stack. All share one header whose buttons and text vary by kind; the agent panel holds the composer and switches between the Agents at its Place.
_Avoid_: Pane (tmux's word), split, view

**Terminal**:
A pane shown as a Panel, whichever pane it is: a Console shell, a pane split by hand in an attached tmux, or the Agent's own.
_Avoid_: Terminal mode, swap, interactive pane

**Console shell**:
A login shell pane the console created at a Place, marked so a launch never adopts it. It stays at its Place wherever its shell `cd`s, outlives the Agent, and ends only when its shell exits or the operator ends it.
_Avoid_: Shell pane, companion pane, landing shell (the wrapper's prompt left behind when an Agent exits)

### Operator state

**Console-named conversation**:
A Named conversation whose name was set through the console. The console remembers which Conversations these are and shows them first; the name itself stays with the agent.
_Avoid_: Bookmark, favourite, pinned conversation (Pinned is a Worktree word)

**Queued prompt**:
A prompt accepted while the Agent was busy, held durably until it can be dispatched.
_Avoid_: Pending prompt, backlog

**Note**:
Operator text kept with a Project, or with a Scratch directory, and edited in the console. A Note can opt into visibility in all Workspaces while retaining one original record. The console's only saved text: what gets sent as a prompt, given a Schedule, or simply kept.
_Avoid_: Saved prompt (retired), sticky note, snippet

**Schedule**:
A standing instruction on a Note: when to run it, with which Adapter, and in which target (a Worktree, a directory Project, or Scratch). At most one per Note; carries the outcome of its last Run.
_Avoid_: Cron job, timer, recurring prompt

**Run**:
One firing of a Schedule. The console starts a fresh Conversation in the Schedule's own pane, launching one when there is none, and submits the Note's text as its first prompt. Recorded on the Schedule as launched, skipped, or failed.
_Avoid_: Execution, job, invocation

**Stack commands**:
The Project's trusted start/stop/build/restart/migrate/status commands, run in their own tmux session.
_Avoid_: Scripts, tasks

**Stack process**:
A named, long-running foreground command a Project or Worktree declares (`dev: pnpm dev`), in place of daemon-style start/stop/status commands. A Worktree may declare several, run as one stack, and a process may name others of the same Worktree it `dependsOn`: Start opens them dependencies first, ties in config order, and Stop stops them in reverse. Each can also be started, stopped or restarted alone; starting one first starts whatever it depends on that is not running. `dependsOn` orders starts only and never waits for readiness. Each runs as a tagged window of its Worktree's Workspace session, found again by those tags, so it outlives a console restart; the console starts, stops (Ctrl+C, then a kill), and reads its state straight from that window. Its output since it last started is also written to `rac/processes/<name>.log` in the Worktree's git directory, where an agent finds it with `git rev-parse --git-path`. The one-shot Stack commands still run beside it. It never blocks a Remove: the Remove stops it first.
_Avoid_: Dev server, daemon, service, background job

**Process notice**:
A short message a Stack process reports to the console about its own run, by writing JSON to the file the console names in `RAC_PROCESS_NOTICES`, optionally naming a process in another Worktree that it needs. It shows under its process in the stack menu, a warning marks the stack badge, and one naming a process hides while that process runs. One naming another Worktree offers Open, which switches to it, and, for a declared process there that is not running, Start, which the operator clicks; the console never starts it on its own. It lasts until its process next starts or stops.
_Avoid_: Alert, health check, status message

**Uses**:
The processes in other Worktrees that a Stack process reports relying on, by writing JSON to the file the console names in `RAC_PROCESS_USES`: each a checkout path and a process name, which the console resolves to a Worktree as it does a notice's, showing that process's live state there, running or not. Every Start replaces them and a Stop leaves them, so a stopped process still shows what it used last. A used process counts as down only when it is not running and a process here that uses it is running or starting. The stack menu gathers them as "Other worktrees".
_Avoid_: Peers, external dependencies

**Stack panel**:
The Panel showing one Worktree's Stack processes and the processes they use: a list on the left, and the selected one's actions, what it needs, what needs it, what it uses and its live output on the right. Acting on a used process acts on its own Worktree, and only ever on the operator's click.
_Avoid_: Stack view, process manager

### Reviewing changes

**Change**:
One changed path in a Comparison, carrying its status code and, where git reports them, its line counts.
_Avoid_: File change, diff entry, hunk (a hunk is one span inside a Change)

**Comparison**:
A base, a head, and the Changes between them. Two exist: Working (HEAD versus the working tree, staged and unstaged folded together, untracked included) and All PR (the merge base of HEAD and the branch's target versus the working tree). The base is always a parameter, so per-commit Comparisons stay cheap to add.
_Avoid_: Diff, scope, snapshot

**Code panel**:
The Panel kind that shows a Comparison's Changes — all files in one scroll or one file — or a whole file.
_Avoid_: Diff view, file viewer, review panel

**Review tour**:
The existing guided review of a Comparison's Changes; the user-facing name is kept.
_Avoid_: Snapshot, walkthrough

**Code review**:
An opt-in AI critique of a Review tour's Comparison, run alongside the tour by a Review preset; it produces Findings.
_Avoid_: AI review (as a domain term — fine as a UI label), critique, audit

**Finding**:
One concern a Code review raises, anchored to a Change's line range (or general, when it cannot be anchored). It is a suggestion until the operator Keeps it as an inline comment or Dismisses it.
_Avoid_: Issue, warning, suggestion

**Review preset**:
A configured agent, model, effort and prompt for a Code review, picked when the tour starts.
_Avoid_: Review profile, reviewer

**Review run**:
One turn sent to an agent in a Worktree, in a new Conversation or a resumed one, answered with validated JSON (the tour's narration, a Code review) or Markdown text (an Ask). Headless or interactive, by the agent kind's configured mode.
_Avoid_: Review job (a job is the server's tracking of one run's result)

**Ask**:
A question about changed code, sent as a Review run that resumes the Conversation of the run being asked: the reviewer's about one of its Findings, or the tour guide's (the agent that narrated the tour) about some of its diff lines. In the Code panel it goes to the tour guide while the stored tour covers the panel's Comparison and the asked-about file, and otherwise to that Comparison's diff conversation, which its first question starts on the tour's agent. The questions about one Finding, or one set of picked lines, form an Ask thread, stored with the tour, or for the Code panel per Worktree and scope.
_Avoid_: Chat (a Conversation is the agent's own transcript)

**Pull request**:
The GitHub pull request a Worktree's branch is open as, found through the Worktree's `origin`. The operator picks it when posting a Review tour, and the console checks it is open and from this branch.
_Avoid_: PR (fine as a UI label), merge request

**Draft review**:
The operator's unsubmitted GitHub review on a Pull request, which a Review tour's notes and inline comments can be posted to. The console only ever creates or adds to it; the operator submits or discards it on GitHub. GitHub's API calls it a pending review.
_Avoid_: Pending review, review draft, submitted review

**Review thread**:
Comments on a Pull request anchored to lines of one file, with their replies. Only GitHub resolves one. The git flyout's PR comments list shows the unresolved ones, alongside review summaries and conversation comments, and adds the ones the operator picks to the composer; the console never writes back.
_Avoid_: Inline comment (a Review tour's own), PR comment (for a thread)
