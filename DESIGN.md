# Design

## Source of truth
Status: Active. Updated: 2026-11-20. Scope: Settings page headers, navigation, search, Cloudflare setup, notices, shared spinner timing, prompt submission controls and reply suggestions, workspace toolbar decorators, main toolbar controls, public homepage and policies, independent file previews, conversation browsing, server resource monitoring, tmux recovery.
Evidence: existing Settings forms and split confirmation, `compose.yaml`, the
host settings queue/applier, and Cloudflare's official Tunnel setup documentation.
Toolbar evidence: `apps/web/src/styles.css`, browser layout regressions, and the
requirement to retain mobile decorator placement at every viewport width.
Reply-suggestion evidence: the canonical latest-message question detection in
`apps/server/src/discovery/service.ts`, the shared prompt composer in
`apps/web/src/main.tsx`, and `apps/web/e2e/reply-suggestions.spec.ts`.
Homepage evidence: Google's [homepage requirements](https://support.google.com/cloud/answer/13807376)
and [OAuth branding requirements](https://support.google.com/cloud/answer/15549049).
Resource evidence: `server-resources.tsx`, the host collector, shared skeletons,
and desktop/phone resource-monitoring browser fixtures.

## Brand
Practical administration, clear ownership, and truthful status. Avoid decorative
cards, secret exposure, and success claims based only on a running container.

## Product goals
Add remote access to a running Compose installation without a Cloudflare API key.
Give every Settings page a consistent scope, title, and purpose hierarchy.
Start the connector before the operator finishes Cloudflare's route wizard.
Verify the route before changing RAC's public origin. Preserve existing tunnels.
Account provisioning, DNS automation, and native service installation are non-goals.

## Personas and jobs
A self-hosting operator connects an existing Cloudflare account/domain to RAC.
They need copyable setup steps and origin values, safe credential entry, progress,
failure recovery, and an explicit final hostname transition.

## Information architecture
Publish `/privacy` and `/terms` as complete, readable HTML without login or control.
Link them from the public homepage beside the full product and data-use description and
from the Google Calendar disclosure before Connect. These documents need no app
JavaScript, account data, credentials or instance-specific details.
Unknown browser URLs use the same public document layout with an actual HTTP 404
and a return-to-console link. API and asset requests retain JSON errors.
The anonymous homepage identifies Remote Agent Console and describes agents,
prompts, repositories, reviews, files and project tools before a prominent Log in
action reveals password entry. Explain the optional Google Calendar connection,
account identity, encrypted tokens and restricted calendar/event access. Keep
password authentication separate from Google authorization. Restore existing
sessions before choosing the homepage, preserving naming/control safeguards and
workspace destinations. Offer a return from password entry to the homepage.
Publish the same information and policy links without JavaScript; never claim
Google domain verification or branding approval based on a code deployment.

Replace the two raw Cloudflare navigation entries with one Cloudflare page.
Existing tunnels show only the configured endpoint, process up/down status, and
expandable configuration files. Replace tunnel explicitly reopens setup without
modifying the connector. New or incomplete tunnels show dashboard instructions,
start connector, publish route, and verify/use hostname. Replacement drafts survive
tab changes; successful activation returns to the compact summary.

## Design principles
Separate connector startup from route activation; never make the operator race
a timeout while completing dashboard steps. Keep unsaved entries inside Settings'
discard/close protection. Never copy or return saved tokens to the browser.

## Visual language
Resource monitoring uses horizontal usage bars as the primary visual. CPU and
memory show percentages, with total memory in parentheses beside its label.
Disk rows show only the mount and used/total capacity.
All bars share status colors: teal below 85%, yellow from 85%, red from 95%.
Two mirrored five-minute gauges glow along the actual server button edge over
an opaque gray track, like the progress border but without an orbit. CPU is left
and memory right, both from bottom center (0%) to top center (100%). Keep the
icon, attention dot and focus outline visible, and expose numeric averages in
the description.
Omit recovery, EFI, and other non-user volumes. On WSL, leave the top group
untitled and label the lower Windows group “Host”. Long mount paths may truncate
visually while retaining their full accessible text and tooltip.
Keep the prompt Send button borderless in idle and pending states while retaining
its keyboard focus outline, gradient and in-flight progress feedback.
Reuse existing theme variables, monospace control typography, outlined secondary
buttons, purple primary action, and compact single-column Settings spacing.
Copy blocks wrap or scroll within the content pane, never the page.
Use light purple for section headings to distinguish groups from field labels.
Every Settings page uses one shared header: a Settings (or Deployment settings)
eyebrow, the navigation title, and one concise purpose sentence. Show a small
**This browser** pill beside each browser preference's label. Don't add a scope
label to shared settings. File format, presence, and path are subordinate source
metadata, never the eyebrow or description.
Keep Default file action on Files and sent-note cleanup on Notes. Put Reply
suggestions and Usage pace on Agents. Stars next to adapter names choose the
default using the same treatment as model stars, without opening the adapter card.
Keep page actions top-right beside the title, with the description spanning the
full header width below that row. Loading and unavailable states retain the same
header contract on reachable pages.
Application has one page title and a top-right Edit base file action, matching
Docker's compact base-file placement without an inline editor-mode banner.
Multi-instance federation follows the configured remote-server list automatically;
do not expose a separate toggle or search result for the derived feature.
MCP, Conductor, and Voice share one grouped Read/Write permission-table design.
MCP sets the ceiling; child pages show denied operations as unchecked and disabled.
Staged parent changes update child availability without rewriting child preferences.
Keep legacy authority gates subordinate to the shared controls, preserving their
runtime restrictions and the existing save/restart boundary.

## Components
Use one feature-local resource metric chart for CPU, memory, and each disk.
Reuse `Skeleton` for chart-shaped loading rows; do not add a chart dependency.
Reuse `SplitConfirmation`, `SettingsRevealButton`, the Settings navigation and
host operation status. Add one feature-local Cloudflare setup component; no new
design-system layer or dependencies.

## Accessibility
Resource bars expose named meters with percentage and exact-value descriptions.
Zero is a settled empty bar; unavailable metrics never masquerade as zero. One
busy region owns decorative loading skeletons. Do not announce every live sample.
Use semantic labels and headings, keyboard-accessible copy/actions, visible focus,
polite progress and assertive errors. Mask token inputs. Use the existing modal's
focus management. Do not communicate connection state with color alone.

## Responsive behavior
Resource charts remain a single column in the existing viewport-bounded server
flyout, with internal scrolling for many disks and no horizontal page overflow.
Workspace toolbar decorators keep the same corner anchors on phones and desktops:
counts above the top-right edge, git status dots inside the top-right corner, and
compact PR status icons inside the bottom-right corner. Only labels and control
widths adapt; do not move decorators into the centered content row. Button badges
paint in front of flyout markers where they overlap. PR cards keep their separate
inline status presentation.
Hide the main toolbar's Launch (+) control on phones; New Workspace in the
workspace chooser retains launch access. Icon-only GitHub Overview uses the
shared square control size, with its badge remaining in the corner.
Notes use a slightly overlapping upper-right row of circular counts, ordered
gray for shared notes, yellow for locked non-shared notes, and purple for all
remaining notes. Shared status takes precedence over locking; omit empty categories.
Keep category colors even for unread queued notes, using the button's existing red
attention treatment instead. Describe the categories accessibly alongside the total.

Settings stay in one form column. Support desktop navigation and the mobile selector.
Mobile carousel splits omit decorative borders, inset edges and content-footer
separators. Keep desktop dividers, inner card and control borders, and focus or
selection feedback unchanged.
Keep action labels and copyable URLs usable at 390px and in narrow splits.
Settings code editors use natural content height: a one-line file occupies one code
line plus field padding. Include every source line and leave vertical scrolling to
the active tab rather than inside editors. Retain horizontal scrolling, compact
closed sections and manual expansion. Extend the narrow number gutter through all
padding and manually expanded space, aligned with the number column's right border.
Toasts overlap Settings content like other splits; only the wrapped Settings
toolbar reserves space. Showing or dismissing notices must not move the tab.

## Interaction states
Resource monitoring is an installation-wide opt-in on Interface, effective
after a RAC restart. Browser storage never enables it. The enabled console checks
CPU and memory every minute and disks every ten minutes. Opening the flyout shows
cached readings immediately, then refreshes CPU and memory every second while visible
and refreshes disks without hiding their previous capacities. Button averages
use only the minute samples of the primary server (WSL when applicable), not
the faster flyout readings or synthetic zeroes. Skeletons reserve chart geometry
only before the first sample. Failed refreshes keep the latest usable readings
and signal failure; disabling monitoring cancels polling and clears the cache.

When a tmux socket stops responding, center the recovery modal over the inert
workspace with a lightly dimmed, blurred backdrop. Keep the card and agent list
scrollable in narrow viewports. Show a single agent list: attach last-known
dashboard details only to an exact live process match, and show unmatched
entries read-only. Reuse the workspace tab's Agent icons and show the full
dashboard name of identified Worktrees. Reuse the flyout's resource bars even
when routine monitoring is off; sample independently of tmux. On WSL, show guest readings separately
from Windows CPU, memory, and volumes sampled through the read-only host bridge.
If that bridge is unavailable, keep showing WSL readings without substituting
them for Windows data. Real outages recover automatically;
the manual preview uses the same stop controls and has a Return to dashboard action.
Disable stopping without fresh process data or host signalling, confirm only
the selected live agents, and distinguish signal delivery from confirmed exit.

Completed assistant replies that ask a prose question may offer a single row of tailored
reply suggestions at the top of the active prompt. The console-wide Reply suggestions
toggle lives in Settings > Agents and is off by default. Its description warns about
additional agent requests, increased agent usage and possible extra cost. When disabled,
do not observe suggestion sources or expose the generation endpoint. Generate them on demand from bounded
current-conversation context using the exact selected model and the Agent's own existing
login. Never select another model or account, invent user facts/preferences/approval, or
substitute generic replies when generation fails. Hide pills when the current model,
credential provenance, conversation or output cannot be verified. Supported verified
routes are Codex and OMX over tmux, controlled local Claude over tmux or the structured
transport, and managed structured Pi. Each route uses only its own verified native login
or stored credential; unverified routes remain unavailable rather than borrowing another
Agent's account. Dashboard polling never starts inference, and typing/Send remain
available while suggestions are pending or unavailable.
Native model discovery uses a vendor-scoped environment and inert startup controls.
The Codex/OMX reply helper accepts Codex CLI 0.169.0 and newer. It rejects
feature lists shorter than the baseline and disables every listed feature.
Unverified accounts, model selections, or protocol behavior still fail closed.
The Claude reply helper accepts Claude Code 2.1.311 and newer. Unverified
Claude account routes stay unavailable rather than selecting a fallback.

When the live OMX footer advertises `/goal resume`, show that command first in
the suggestion row independently of the Reply suggestions toggle, assistant
questions, or provider availability. Activation drafts the standalone command
without sending it. If text or attachments are already present, keep the option
visible but disabled rather than altering the existing draft. Remove it when the
footer no longer advertises it or the pane disconnects.

Labels contain at most three words. Each pill exposes its full editable draft in its
tooltip and accessible description. Suggestions are never selected, inserted or sent by
default. Activating a generated reply appends to and focuses the existing draft without
submitting a prompt, answering a question or sending terminal input. Preserve typed text
and earlier selections. Pills use half the standard control height with sufficient target
separation, without shrinking Send or answer-mode controls. Keep them in one horizontally
scrollable row on narrow screens without page overflow. Hide stale results during work,
conversation/model/account changes, non-question replies or native question/permission
presentation. Native answer-mode questions and permissions continue submitting on click.

Prompt dictation toggles with a deliberate single-finger upward swipe on the prompt
box. Taps, long presses and scrolling an overflowing draft remain native text editing. Each logical start or stop
gets one brief bounce and a distinct local recording cue; silent service restarts
never repeat toggle feedback. While enabled, retain the red border and a blinking,
noninteractive microphone centered just above the field. Reduced motion keeps a
static microphone and red border without bounce or blinking. Audio playback is
best effort under browser/device policy and is independent of notification-only
alert sounds; unavailable audio never prevents recording controls.
Stop dictation when its prompt enters question-only UI, output input mode, or an
offscreen phone split; an invisible prompt must never retain microphone ownership.

Read-only content loads are skeleton-first: reserve the geometry of the rows,
properties, code, images, usage, or labels being fetched. Skeletons are decorative,
noninteractive, and owned by one accessible busy container. Successful empty or zero
results, unavailable data, and failures are settled states, not indefinite loading.
Refreshes hide stale Files, account/usage, version, and cleanup-candidate values while
retaining the last good snapshot where rollback is supported. Code's live soft
refresh is an explicit exception: keep its patch, selection, and scroll until an
authoritative replacement can swap atomically; hard loads use semantic skeletons.
User actions and LLM work retain two accelerating/decelerating border half turns per
two-second cycle. Voice connecting covers the mounted scrolling transcript with
message-shaped skeletons instead of a progress border; connected idle has neither
treatment.
Muted listening keeps wake detection active without showing microphone-input motion.
Keep the Davo toggle visible and selected while its panel is open. Clicking it
hides or reveals the panel without restarting active listening; selection follows
panel visibility even when listening is off. On mobile, keep that same toggle
reachable beside the panel header rather than behind the fullscreen surface.
Voice pauses collect one unfinished turn; only a terminal spoken “over” releases
that complete turn for work or a reply. Do not auto-submit on silence. Stop, mute,
transport replacement, and retention expiry discard unfinished speech. Keep
operation and request identifiers internal; ask users only about meaningful choices.
For local-change status, summarize the purpose and progress of the work from
representative diffs and recent agent context, not filenames or change counts.
Lead with one short project or worktree sentence naming the evidenced task themes.
Discovery metadata is not enough; continue with available task and edit reads.
Do not substitute vague change-volume descriptions, Git-health judgments or
unsolicited cleanup advice. Previous assistant summaries are not fresh evidence.
Missing evidence is an explicit limitation, not permission to invent a task summary.
Keep a persistent idle status reading “Waiting for instructions...” when Davo has
no active work. Show each MCP call as a compact single-line activity entry in the
saved chat, without an author header, timestamp, or speech bubble. Update that same
entry from a friendly present-progress phrase to its confirmed outcome. Keep tool
arguments, results, and identifiers out of these labels; failed or uncertain calls
must not look successful. Activity rows are silent, excluded from model context,
and share the existing three-day retention window.
Agent and terminal pane connections use output skeletons for initial
attachment and automatic reconnects, retaining the mounted terminal underneath.
Keep loading artwork until the current seed has painted in the selected renderer,
not merely finished parsing. Load terminal font faces before WebGL activation and
never reset its shared glyph atlas when another panel mounts or unrelated fonts load.
Keep the initial covered renderer out of browser compositing while preserving its
transparent input target, then reveal the first committed seed and its semantic
controls together. Retain one matching measured grid as a startup allocation hint;
the server's size remains authoritative.
Redraw each owner after shared glyph-atlas page merges so ongoing editor output
does not need a manual resize or text selection to repair stale glyph coordinates.
Keep pane parsing, byte acknowledgements and interactive input independent of
presentation scheduling. Coalesce dirty terminal rows into the shared visual
pulse; only sustained rapid line output uses the sparse four-hertz cadence. Reveal the seed,
honor interactive scrolling and input, and flush a quiet output tail promptly.
Retain exact native selection geometry for touch and mouse-reporting programs;
plain desktop panes use xterm's own selection with a compact hidden text mirror.
Position semantic link hit targets in the contained terminal cell grid without
repeated layout measurement.
When available, agent skeletons replay the last visible text geometry for that pane,
preserving widths, indentation and blank rows without storing transcript text.
The geometry is cached in the current tab, scales with the terminal font size and is
clipped to the split. Without cached geometry, show just one new-conversation
layout: the shared Codex/OMX banner and prompt, Claude's logo and welcome details,
or an unbranded prompt when the agent is unknown. Match the native launch fixtures;
do not invent messages or tool output. RAC-native structured transcripts keep their
empty conversation layout and mounted composer. Standalone terminal placeholders
still repeat shell commands and column-shaped output through the available height.
Fresh stream seeds clear the skeleton; explicit failure reasons remain readable.
All active progress surfaces use a stationary two-pixel breathing border and
soft glow. Animate only its opacity over two seconds, never the gradient, mask
or border geometry. Busy icon buttons replace the glyph with a compact spinner
without moving the control; busy status-dot buttons replace their dot in place.
Text buttons keep their label and show a small inline spinner beside it.
Loading and working retain their semantic colors and busy accessibility state.
The small spinner uses transform-only rotation. A single shared phase updates
each busy control at 12Hz while quiet and shares the sparse 4Hz terminal
clock during rapid output or input, without autonomous animation loops.
Background tabs stop the clock, and reduced
motion leaves a steady border and indicator.
Update and unread-note glows settle after two pulses. In-flight loaders keep
moving; non-busy status dots stay still. Do not run per-surface or display-refresh clocks.
Conversations opens immediately into one flyout with search first and a scrollable
four-and-a-half-row maximum viewport, clamped to short screens. Size short lists
to their content instead of reserving empty rows. A starter list with fewer than
five confirmed renames fits all its visible rows, including an extra unnamed
current conversation; longer lists keep the clipped fifth-row scroll cue.
Keep a cwd/all switch beside
search: cwd defaults to the current workspace folder; all includes configured
worktree folders across every project, plus the current scratch folder when applicable.
Request that broader catalog explicitly from the server, keeping unknown paths outside
the scan boundary. Show directories only in all mode, and use
compact two-line rows in cwd mode. Use the server's worktree identity to scope cwd
across host/container path mappings; use the current conversation directory for
scratch contexts. Shared or canonical-equivalent host roots remain visible without a resumable
worktree identity; direct switches also reject ambiguous ownership.
Directory search remains available in both modes. Initially show
non-review console-named conversations plus the current conversation. RAC-generated
review labels stay behind search or expansion even when recorded as console-named;
the current row remains visible regardless of title provenance or review-run status.
Keep non-review console renames first and
newest activity within each group. Other generated, provider-only and
unknown-provenance titles remain behind search or explicit expansion. Keep current
naming available when the validated catalog has no current row.
Show all conversations expands the same list to automatic and review entries
without changing folder scope; Show fewer conversations restores the short
list. Search includes all conversations within the selected scope and keeps confirmed
console renames first. Rows carry no action area beyond one trailing trash control on console-named rows, a sibling of the resume button, which forgets the console's record (the row moves behind Show all; the transcript and its name stay).
Place the current conversation's Edit icon immediately after its name, within the
title line. Keep it keyboard-accessible and independent of any resume button:
the current row is noninteractive content containing Edit; historical rows remain
full-width resume buttons. Preserve the current badge and truncate long titles
without clipping the edit icon. Its inline form uses accessible check/X icon buttons.
Keep historical resume safeguards, current naming eligibility, mutation errors and
redaction boundaries intact. Removing row controls does not delete stored rename
records or transcripts. Reset scope and expansion when reopening the flyout.
File paths and stored Note attachment filenames open a dedicated Preview split through
the existing scoped preview routes, independently of Code comparisons. Reuse highlighted
source and bounded raster rendering with loading, failure, binary and truncation states.
Files menus offer Preview and, only with a configured editor, Edit. Filename and favorite
activation follows the Files setting Default file action; preserve Edit as
the initial default and fall back to Preview when no editor is configured or launch fails.
Explicit Preview never launches an editor. Settings base-file previews remain redacted
and read-only. Preview shares split resizing, expand/close, keyboard navigation and the
phone carousel. Uploads remain available.
Files tables mount only viewport rows with overscan, preserving the complete sorted
listing for selection and operations. Keep the sticky six-column header and native
horizontal scrolling; expose logical row counts and indices. Retain keyboard focus
without mounting the intervening rows, and dismiss row menus when their anchors scroll.
Cleanup loading rows contain decorative checkbox shapes, never consent inputs or
target identities. Only settled real controls determine destructive selections;
actual cleanup submission retains its working feedback and closed-PR opt-in rule.
While Settings files load or refresh, replace desktop and mobile navigation icons
and labels with skeleton placeholders and disable every tab and the mobile selector.
Keep the selected page header and show a loading message in its content area instead
of editors. Use static placeholders with reduced motion; restore browser-only
fallback pages after a catalog failure.
Show loading/retry, unsupported native setup, legacy configuration, connector
started but unverified, active verified hostname, in-flight operation, and safe
failure. Distinguish connector startup from end-to-end route health.
The pending restart notice says what saved changes need and who can restart.
Reload UI and Restart use one fullscreen loader that fully paints before the
request or navigation and blocks background interaction. Show plain-language
steps for preparing, checking settings, restarting, reconnecting, and restoring
the previous configuration. Never show raw host phases or error codes. Keep
the fixed recovery countdown visible when offline; offer the host command only
under Manual recovery after the deadline or a failed recovery. Respect reduced
motion. Report verified success or recovery with dismissible toasts; recovery
does not discard saved edits. In the initiating browser, check the deployed UI
build once after a verified restart, then reload only when it has changed.
Keep unsaved work and show the manual reload notice if reloading would lose it.
Settings saves use the shared toast stack: success expires after five seconds;
errors have no expiry and can be dismissed. Keep field-level validation inline.
Layer toasts below all flyouts, including Settings search results, and their
dismissal backdrops so notices cannot cover controls or intercept outside
dismissal. Keep modal dialogs and blocking loaders above both.
Validate the captured transaction on Save only; omit a separate Validate action.
Keep Save busy through validation and commit. Failed validation retains drafts and
marks affected source and dedicated-page navigation icons red on desktop and mobile;
ordinary unsaved-only indicators remain yellow. Successful validation, discard or
refresh clears the issue state.
Voice-only environment credentials live on Voice even while the feature is off;
they retain the environment source, masking, shared save and restart behavior.
Place write-tool controls directly below Context without an advanced-section
heading. Separate Environment & keys from the voice controls with whitespace.
Settings groups Agents and Google Calendar under Integrations. Put each adapter's
environment controls in a flat Environment & keys section: retain application-owned
custom adapter variables and environment-file-owned RAC variables in their original
backing sources, shared save transaction, masking and restart behavior. Show environment
controls only after their adapter is added and hide them when it is removed. Keep Setup and Teardown
visible for added adapters; blank commands remove their optional overrides. Keep
service executable overrides separate from launch programs; show image-build settings
only in Docker. Keep each adapter's Args and Updates sections visible while allowing
individual arguments to be removed.
Render each argument as an always-editable field in its row instead of a static
command preview. Omit the repeated visible Arg title and Edit/Close control while
retaining an accessible argument label and the reorder/remove actions.
Keep argument rows unframed, without wrapper-card borders or padding; retain the
input field's own outline.
Updates requires all three commands together, labeled Get current version command,
Get latest version command and Update command. Name adapter removal actions
`Remove <adapter name>`.
Application has a top-level Reviews page. Keep its optional fields and sections
permanently visible without eagerly authoring configuration; blank optional values
omit their keys and restore the documented default or disabled state. Keep required
custom-preset fields subject to validation. Review fields are not removable, while
user-added preset rows remain removable and their editors stay fully expanded.
Storage groups RAC-owned data files and directories plus the Scratch directory.
Keep deployment selectors, external-tool configuration and project topology on their
existing pages. Path edits retain source migration prompts and never move data just
by opening or navigating the Storage page.

## Content voice
Direct instructions. Distinguish tunnel token from an account/API token.
Explain that Cloudflare's dashboard owns DNS/routes and RAC owns the connector.
Warn that Cloudflare Access can block the verification request.

## Implementation constraints
React/TypeScript with existing CSS tokens. Compose-only token onboarding uses
private token-file storage and the existing authenticated host queue/locking.
Local plus public challenged health probes must prove the same RAC instance.
Only after successful verification may publicOrigin change and RAC restart.
Validate host/API safety with isolated tests and UI with fixture-backed Playwright;
do not modify the live tunnel during testing. Build/deploy the unchanged live
installation configuration before reporting completion.

## Open questions
None blocking this scope. Native tunnel provisioning remains explicitly unsupported.

## Settings search
Search is the Settings split's complete left header pill, matching the Browser
URL control rather than sitting below a separate Settings title. The main card
fills the split with matching header insets, without a centered page-width cap
or a second top gap below the header clearance. Retain Settings
as the dialog's accessible name. Its attached typeahead is not a navigation filter.
Keep all pages visible while loading and identify unavailable results without opening
a placeholder editor. Use the placeholder “Search all settings” with no visible
label or dirty-summary pill. Distinguish Page and Field results; show field
breadcrumbs using group, page, section and list-item metadata. Search names and
descriptions only, never field values, disclosed credentials or file contents.
Click or Enter navigates through the normal remasking boundary. Open existing
collection editors when needed, scroll only the active content pane and highlight
the exact destination. Index optional add controls rather than nonexistent
descendants, and omit conditional fields while their form is hidden. Search never
creates configuration or enables a feature. Support
arrow-key selection, Escape, outside dismissal and narrow split layouts. Results
overlap content and do not reserve space or move the active tab.
