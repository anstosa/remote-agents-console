---
status: accepted
date: 2026-10-28
---

# The Conductor wakes only for what it Watches

The Conductor (ADR 0018) is always running and acts while the operator is away, so something other than the operator must wake it. The console has no event bus: one dashboard poll drives everything, and only push notifications diff it into events. We add one console event emitter, fed by diffs of consecutive dashboard snapshots and by job callbacks. Push notifications become its first subscriber, with no change in behaviour. The Conductor reaches it only through *Watches* (`CONTEXT.md`) it sets itself: a pull request (checks settled, a new unresolved thread, a merge conflict, merged or closed), a Stack process (exited), a Project's review requests (the operator's review requested or re-requested), or a command the console runs whose stdout lines are events, modelled on Claude Code's Monitor. Every event is a model Turn that costs money, so the Conductor hears only about what it chose to care about. Events reach it as queued prompts through its durable queue, beside reports on its dispatches (ADR 0018) and Runs of Schedules aimed at it.

## Considered options

- **Every console event in scope.** Each PR change and Stack exit in every Project would cost a Turn.
- **An operator-written event filter in config.** It is static, and it separates what is watched from the work the watching is for.
- **Monitors inside Pi**, a Conductor tool that runs the command and injects lines straight into the session. Cheap, but it bypasses the durable queue and the turn budget, the UI cannot see it, it dies whenever the Conductor restarts, and only a Pi Agent could ever use it.
- **Per-target Agents ("Stewards")** that each subscribe to their own events. Retired: one Conductor can hand a busy pull request to a worker it spawns.

## Consequences

- **The Conductor is a role behind a seam, not Pi machinery.** A kind hosts it when its protocol client provides a structured Transport, the console's MCP endpoint and token delivered in-band and kept out of its commands, a launch report confirming its sandbox, the console's role prompt, and launch on a configured model. Watches, events, reports, Schedules and budgets sit above the seam, keyed by Agent id. Only `pi` is accepted for now.
- **Watches belong to the Conductor, not its Conversation**, and survive New Conversation, restarts and deploys. The console keeps the last state each Watch saw, so a deploy neither drops nor repeats an event.
- **A command Watch runs under the Conductor's sandbox policy** in a tagged window of its Workspace, like a Stack process. Lines within 200 ms are one event, exit arrives as a final event with its code, a Watch emitting more than about 20 events a minute is stopped and reported, and it is re-armed after a reboot. Nothing in it assumes the Conductor, so ordinary Agents could be given it later.
- **A budget bounds self-started Turns**: reports, events and the Conductor's own Runs, by default 30 an hour. Anything beyond that waits in the queue, with one push.
- **Schedules gain a Conductor target.** A Run queues the Note's text and is recorded as delivered. The Conductor may put Schedules on its own Notes, aimed at itself only.
- **Pushes stay for people.** A worker's `finished` is suppressed for a Turn the Conductor dispatched, and a Conductor Turn it started itself pushes only if it ends in a question.

*Amended 2026-10-29 while building it:* the emitter carries each dashboard snapshot's Agents and Stack processes, which subscribers diff, and job callbacks (a ready review, a Schedule Run that needs the operator); the Agent and job pushes subscribe first. The Conductor's own notices (throttled, stopped, off) and the cleanup notice still push directly. Process Watches subscribe to it. Pull request and review-request Watches poll GitHub on their own, once a minute, since the dashboard knows only the pull request of a checked-out branch. Each Watch's event is written to its outbox with the state it saw in one write, then queued; an event found waiting in the outbox at start is queued only if the owner's queue and history do not already hold it. A command Watch runs under the holder, so its stdout lines are numbered and a restarted console reads on from the last line its events took; its process is the console's sandbox runner, which builds the session policy as the RAC Pi extension does.
