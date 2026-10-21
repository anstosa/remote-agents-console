# Design

## Source of truth
Status: Active. Updated: 2026-10-20. Scope: Settings page headers, navigation, search, Cloudflare setup and notices.
Evidence: existing Settings forms and split confirmation, `compose.yaml`, the
host settings queue/applier, and Cloudflare's official Tunnel setup documentation.

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
Always one form column. Support desktop navigation and the mobile selector.
Keep action labels and copyable URLs usable at 390px and in narrow splits.
Settings code editors use natural content height: a one-line file occupies one code
line plus field padding. Include every source line and leave vertical scrolling to
the active tab rather than inside editors. Retain horizontal scrolling, compact
closed sections and manual expansion. Extend the narrow number gutter through all
padding and manually expanded space, aligned with the number column's right border.
Toasts overlap Settings content like other splits; only the wrapped Settings
toolbar reserves space. Showing or dismissing notices must not move the tab.

## Interaction states
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
Validate the captured transaction on Save only; omit a separate Validate action.
Keep Save busy through validation and commit. Failed validation retains drafts and
marks affected source and dedicated-page navigation icons red on desktop and mobile;
ordinary unsaved-only indicators remain yellow. Successful validation, discard or
refresh clears the issue state.
Voice-only environment credentials live on Voice even while the feature is off;
they retain the environment source, masking, shared save and restart behavior.
Place write-tool controls directly below Context without an advanced-section
heading. Separate Environment & keys from the voice controls with whitespace.
Application has a top-level Agents page for adapter configuration. Put each adapter's
environment controls in a flat Environment & keys section: retain application-owned
custom adapter variables and environment-file-owned RAC variables in their original
backing sources, shared save transaction, masking and restart behavior. Show environment
controls only after their adapter is added and hide them when it is removed. Keep Setup and Teardown
visible for added adapters; blank commands remove their optional overrides. Keep
service executable overrides separate from launch programs; show image-build settings
only in Docker. Keep each adapter's Args and Updates sections visible while allowing
individual arguments to be removed. Updates requires all three commands together, labeled Get current version
command, Get latest version command and Update command. Name adapter removal actions
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
