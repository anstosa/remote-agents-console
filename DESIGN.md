# Design

## Source of truth
Status: Active. Updated: 2026-10-30. Scope: Settings page headers, navigation, search, Cloudflare setup, notices, shared spinner timing, prompt submission controls, workspace toolbar decorators, public homepage and policies, independent file previews, conversation browsing.
Evidence: existing Settings forms and split confirmation, `compose.yaml`, the
host settings queue/applier, and Cloudflare's official Tunnel setup documentation.
Toolbar evidence: `apps/web/src/styles.css`, browser layout regressions, and the
requirement to retain mobile decorator placement at every viewport width.
Homepage evidence: Google's [homepage requirements](https://support.google.com/cloud/answer/13807376)
and [OAuth branding requirements](https://support.google.com/cloud/answer/15549049).

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
Keep the prompt Send button borderless in idle and pending states while retaining
its keyboard focus outline, gradient and in-flight progress feedback.
Reuse existing theme variables, monospace control typography, outlined secondary
buttons, purple primary action, and compact single-column Settings spacing.
Copy blocks wrap or scroll within the content pane, never the page.
Use light purple for section headings to distinguish groups from field labels.
Every Settings page uses one shared header: a nonempty scope eyebrow, the page's
navigation title, and one concise purpose sentence. Use only Browser settings,
Server settings, or Deployment settings for the eyebrow. File format, presence,
and path are subordinate source metadata, never the eyebrow or description.
Keep page actions top-right beside the title, with the description spanning the
full header width below that row. Loading and unavailable states retain the same
header contract on reachable pages.
Application has one page title and a top-right Edit base file action, matching
Docker's compact base-file placement without an inline editor-mode banner.
Multi-instance federation follows the configured remote-server list automatically;
do not expose a separate toggle or search result for the derived feature.

## Components
Reuse `SplitConfirmation`, `SettingsRevealButton`, the Settings navigation and
host operation status. Add one feature-local Cloudflare setup component; no new
design-system layer or dependencies.

## Accessibility
Use semantic labels and headings, keyboard-accessible copy/actions, visible focus,
polite progress and assertive errors. Mask token inputs. Use the existing modal's
focus management. Do not communicate connection state with color alone.

## Responsive behavior
Workspace toolbar decorators keep the same corner anchors on phones and desktops:
counts above the top-right edge, git status dots inside the top-right corner, and
compact PR status icons inside the bottom-right corner. Only labels and control
widths adapt; do not move decorators into the centered content row. PR cards keep
their separate inline status presentation.
Notes use a slightly overlapping upper-right row of circular counts, ordered
gray for shared notes, yellow for locked non-shared notes, and purple for all
remaining notes. Shared status takes precedence over locking; omit empty categories.
Keep category colors even for unread queued notes, using the button's existing red
attention treatment instead. Describe the categories accessibly alongside the total.

Settings stay in one form column. Support desktop navigation and the mobile selector.
Keep action labels and copyable URLs usable at 390px and in narrow splits.
Settings code editors use natural content height: a one-line file occupies one code
line plus field padding. Include every source line and leave vertical scrolling to
the active tab rather than inside editors. Retain horizontal scrolling, compact
closed sections and manual expansion. Extend the narrow number gutter through all
padding and manually expanded space, aligned with the number column's right border.
Toasts overlap Settings content like other splits; only the wrapped Settings
toolbar reserves space. Showing or dismissing notices must not move the tab.

## Interaction states
Read-only content loads are skeleton-first: reserve the geometry of the rows,
properties, code, images, usage, or labels being fetched. Skeletons are decorative,
noninteractive, and owned by one accessible busy container. Successful empty or zero
results, unavailable data, and failures are settled states, not indefinite loading.
Refreshes hide stale Files, account/usage, version, and cleanup-candidate values while
retaining the last good snapshot where rollback is supported. Code's live soft
refresh is an explicit exception: keep its patch, selection, and scroll until an
authoritative replacement can swap atomically; hard loads use semantic skeletons.
User actions and LLM work retain two accelerating/decelerating border half turns per
two-second cycle. Voice connection and tool work share one non-scrolling chat-area
border around a nested scrolling transcript; connecting takes precedence, connected
idle has none. Agent and terminal connections use output-line skeletons for initial
attachment and automatic reconnects, retaining the mounted terminal underneath.
Their skeletons fill the entire available output height, adapting to split and font
resizing. Agent placeholders alternate prompts, paragraphs and indented tool output;
terminal placeholders use denser shell-command and column-shaped output rows.
Fresh stream seeds clear the skeleton; explicit failure reasons remain readable.
Startup/auth and fullscreen connection loaders retain a constant-speed turn.
Each border type shares the document timeline, including late mounts and portals.
Reduced motion makes skeletons static and replaces retained travelling borders with
compact synchronized one-second spinners. Do not animate status dots or run a
continuous JavaScript animation clock.
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
console renames first. Remove the separate row action area and trash controls.
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
activation follows the browser Interface setting Default file action; preserve Edit as
the initial default and fall back to Preview when no editor is configured or launch fails.
Explicit Preview never launches an editor. Settings base-file previews remain redacted
and read-only. Preview shares split resizing, expand/close, keyboard navigation and the
phone carousel. Uploads remain available.
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
Pending restart notices omit recovery details until RAC actually starts restarting.
Reload UI and Restart fade fully into one fullscreen loader before navigation or
the restart request begins. Block background interaction during the transition.
During restart, count down against the host watchdog's fixed recovery deadline,
including while disconnected. Keep countdown and manual recovery guidance inside
the centered loader, not a competing toast. Respect reduced-motion preferences.
Show dismissible proved success or recovery-warning
toasts after completion; recovery does not silently discard pending saved edits.
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
Search is an attached typeahead, not a filter for the settings navigation. Keep
all pages visible while loading and identify unavailable results without opening
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
