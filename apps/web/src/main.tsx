import { cloneElement, Component, createContext, type Dispatch, Fragment, lazy, type ReactElement, type ReactNode, type SetStateAction, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { pollWhileVisible } from './client-scheduling.js';
import { closeOnMiddleClick, preserveMiddleClickPress } from './middle-click.js';
import { currentOutputLinkUrl, outputUrlMatchesHost } from './output-links.js';
import { mountStreamedTerminal } from './streamed-terminal.js';
import { attachTerminalSelection, type TerminalSelection, type TerminalSelectionController } from './terminal-selection.js';
import { createAgentPaneConnector, createWorktreePaneConnector } from './pane-socket-client.js';
import { FlyoutPortal } from './flyout-portal.js';
import { ContextMenuHost, contextMenuOwnsFocus, openContextMenu, type ContextMenuItem } from './context-menu.js';
import { SelectionActionsContext, openSelectionContextMenu, preserveContextMenuPress, useSelectionActions, type ClipboardContents, type SelectionActions } from './selection-context-menu.js';
import { ContextFlyoutEvents } from './context-flyouts.js';
import { agentSplitHidden, setAgentSplitHidden, workspaceAlias, setWorkspaceAlias, settingsSplitOpen, setSettingsSplitOpen, useWorkspaceViewRevision, workspaceViews, pendingWorkspaceJumps, type WorkspaceSplit, type WorkspaceView } from './workspace-view.js';
import { PanelExpandContext, type PanelAction, type PanelExpansion, PanelHeader, PanelIcon, panelIcons, type ProgressColor, useExpansionScope, usePanelExpand, usePanelExpansion, usePhoneLayout } from './panel-header.js';
import { type CarouselPanel, type PanelCarousel, PanelDots, usePanelCarousel, usePanelSwipe } from './panel-carousel.js';
import { NoteMarkdown } from './note-markdown.js';
import { ProjectOpen } from './project-open.js';
import type { CodePanelReview } from './code-panel/code-panel.js';
import type { EditorTarget } from './code-panel/editor-jump.js';
import { savedCodeOpen, saveCodeOpen, supportingChange, useCodePanel, type CodePanelCommit, type CodePanelController, type CodePanelMode } from './code-panel/comparison.js';
import { PullRequestCard, PullRequestFixup, PullRequestIndicators, type PullRequestSummary } from './pull-request-card.js';
import { PullRequestCommentsPanel, unresolvedThreadCount, type PullRequestComments } from './pull-request-comments.js';
import { isStackOperationLog, isStackProcessOutput, type StackAction, type StackOperationLog, type StackProcessOutput, type StackProcessState, type StackSelection, type StartableNoticeTarget } from './stack-operations.js';
import { StackPanel } from './stack-panel.js';
import { StackIcon, stackGlyphs, type ProcessAction, type StackHandlers } from './stack-controls.js';
import { SyntaxHighlightedCode } from './syntax-highlight.js';
import { isPromptKeyboardTarget, useWorkspaceCycleKeys } from './tab-navigation.js';
import { confirmKey, KeyboardLayer, KeyPicker, keyTarget, shortcutSettingsNavigationEvent, terminalBindingAction, useKeyAction, useKeyActions, type KeyPickerOption } from './keyboard.js';
import type { KeysConfig } from '../../server/src/config/keys.js';
import { applyColorTheme } from './color-theme.js';
import { useDynamicWorktrees } from './dynamic-worktrees.js';
import { applyReducedMotion } from './reduced-motion.js';
import { useFullscreenAction } from './fullscreen-loader.js';
import { applyFlyoutMarkers } from './flyout-markers.js';
import { UpstreamRebaseNotification, type GitUpstreamSummary } from './upstream-rebase.js';
import { useViewportFlyout } from './viewport-flyout.js';
import { isReviewTour, ReviewPanelColumn, ReviewTourPanel, type ReviewLaunch, type ReviewPanelSlot, type ReviewScope, type ReviewTarget, type ReviewTour, type ReviewTourIndicator } from './review-tour.js';
import { ReviewStartSheet, reviewTourUnavailableText, type ReviewTourCapability } from './review-start.js';
import { codeReviewCapability, codeReviewFrom, isCodeReviewJob, type CodeReview, type CodeReviewCapability, type CodeReviewJob } from './code-review.js';
import { VoiceDialog, type VoiceWorktree } from './voice/voice-dialog.js';
import { AdaptersContext, AgentLaunchSettingsContext, AgentAccountsMenuContext, agentKindGlyph, agentKindLabel, agentKinds, configuredKinds, defaultSandboxed, LaunchMenu, LaunchSplitButton, LaunchTabBadge, launchRequestInit, originCopy, sandboxCopy, type AdapterCapabilities, type AgentKind, type AgentUpdateStatus, type LaunchMenuEntry, type LaunchResolution, type LaunchChoice } from './launch-profile.js';
import { ScheduleEditor, defaultScheduleCron, lastRunNeedsAttention, scheduleInvalid, type Schedule, type ScheduleAdapterOption, type ScheduleSetBody, type ScheduleTarget, type ScheduleTargetOption } from './schedule-editor.js';
import { useBrowserPermissionBroker } from './browser-permissions.js';
import { FilesPanel } from './files-panel/files-panel.js';
import { saveFilesOpen, useFilesController } from './files-panel/controller.js';
import type { FileEntry } from './files-panel/contracts.js';
import { SettingsCenter, useSettingsSession, type SettingsCloseGuard } from './settings/settings-center.js';
import { SettingsHeaderActionsContext } from './settings/header-actions.js';
import { isSettingsSnapshot, settingsResponseError } from './settings/contracts.js';
import { SettingsTerminalEditorContext, type SettingsEditorTarget, type SettingsPreviewTarget } from './settings/terminal-editor.js';
import { ConsoleFullscreenLoader, SettingsRestartNotice, SettingsRuntimeProvider, StandaloneSettingsRestartNotice, useSettingsRestartNoticeVisible } from './settings/runtime.js';
import './styles.css';

// preserve both middle-click and context-menu presses
const preserveWorkspacePress = (event: React.MouseEvent | React.PointerEvent) => {
  preserveMiddleClickPress(event);
  preserveContextMenuPress(event);
};

// reuse the sticky-note edit and delete glyphs across app controls
const actionIconPaths = {
  pencil: 'm4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5zM12 15v2',
  unlock: 'M7 11V7a5 5 0 0 1 9.5-2M5 11h14v10H5zM12 15v2',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4Z',
  queue: 'M4 6h10M4 11h10M4 16h7M18 13v6m-3-3h6'
};

// the fields the web reads off the server's inline-question payload; the server
// also carries targetPaneId for its own keystroke targeting, which the web ignores
type InlineQuestion = { id: string; text: string; choices: string[]; descriptions?: string[]; source: 'structured' | 'parsed' };
type Stack = { actions: StackAction[]; running?: boolean; transition?: 'starting'|'migrating'; operation?: StackAction; tunnel?: boolean; processes?: StackProcessState[] };
type PullRequestChoice = { number: number; title: string; branch: string; draft: boolean; url: string } & Pick<PullRequestSummary, 'checks' | 'issues'>;
type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
type SwitchablePullRequest = PullRequestChoice & { checkedOut: boolean; openIn?: PullRequestWorktree };
type SwitchableBranch = { branch: string; checkedOut: boolean; openIn?: PullRequestWorktree; commitSummary?: { subject: string; count: number } };
type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[]; otherPullRequests: SwitchablePullRequest[]; branches: SwitchableBranch[]; pullRequestsSupported: boolean };
type DashboardTarget = { worktreeId: string; agentId?: string };
type PromptAction = { label: string; prompt: string };
type GitStatusChange = { code: string; path: string; originalPath?: string; additions?: number; deletions?: number; category?: 'implementation'|'test'|'doc' };
type GitStatusSummary = { files: number; staged: number; unstaged: number; untracked: number; conflicted: number; changes?: GitStatusChange[] };
type GitComparisonSummary = { base: string; files: number; changes?: GitStatusChange[] };
// A value that changes whenever a Worktree's live change summary moves, fed to the Code panel so it
// refreshes an open Comparison in place. Covers both Comparisons (Working and All PR) so either one
// updating triggers a refetch. Per-change line counts catch most edits; folding in the Agent's
// Attention state also refreshes at each turn boundary, which catches an in-place edit that leaves
// the +/- counts unchanged (numstat reports counts, not content). JSON.stringify keeps it free of
// delimiter collisions on paths that contain separator characters.
// `attention` is the Place's Agents' attention, so any of them ending a turn refreshes it
const comparisonChangeSignal = (status?: GitStatusSummary, pr?: GitComparisonSummary, attention?: string): string => {
  const changes = (list?: GitStatusChange[]) => (list ?? []).map(change => [change.code, change.path, change.additions ?? null, change.deletions ?? null]);
  return JSON.stringify([attention ?? null,
    status?.files ?? 0, status?.staged ?? 0, status?.unstaged ?? 0, status?.untracked ?? 0, status?.conflicted ?? 0, changes(status?.changes),
    pr?.files ?? 0, changes(pr?.changes)]);
};
type NewTaskAvailability = { enabled: boolean; reason?: string };
type OperationFeedback = { id: number; tone: 'pending'|'success'|'error'; message: string; detail: string; worktreeId?: string; expires?: number };
const toastDurationMs = 5_000;
type CleanupTarget = { id: string; kind: 'orphan-worker'|'stale-agent'|'hud-pane'|'hud-process'|'merged-branch'|'closed-pr-branch'; label: string; detail: string };
type BranchRemovalFacts = { branch: string; checkedOut: boolean; dirtyCount: number; pushed: boolean; merged: boolean; defaultBranch: boolean };
type AttentionState = 'working' | 'finished' | 'question';

// apply one shared progress border without replacing the control's content
const progressBorder = (busy: boolean, color: ProgressColor) => busy ? ` progress-border progress-${color}` : '';
// render the shared ring as the busy host's direct child
function ProgressRing({ busy }: { busy: boolean }) {
  return busy ? <span className="update-progress-ring" aria-hidden="true" /> : null;
}
// `worktreeLabel`/`worktreeOrder` are no longer on the wire (the server carries them on the
// Worktree); they remain as optional read-only fallbacks the tab bar consults when an Agent's
// Worktree is not present in the payload, absent from the real server.
type Agent = { id: string; sessionId: string; home: string; reviewRun?: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; title: string; kind?: AgentKind; attention?: AttentionState; hasMessageQuestion?: true; sandboxed?: boolean; conversationId?: string; displayLabel?: string; placeId?: string; projectId?: string; worktreeId?: string; worktreeLabel?: string; worktreeOrder?: number; newTaskConfigured?: boolean; push?: PromptAction; projectUrl?: string; projectProxied?: boolean; pullRequest?: PullRequestSummary; question?: InlineQuestion; paneMode?: string; stack?: Stack; unread?: boolean; completionId?: string; queuedPromptCount: number; launch?: LaunchResolution };
type Worktree = { id: string; projectId: string; label: string; customLabel?: boolean; path: string; main: boolean; detached: boolean; locked: boolean; branch?: string; sha?: string; consoleShells?: number; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; available: boolean; pinned: boolean; order: number; projectUrl?: string; projectProxied?: boolean; pullRequest?: PullRequestSummary; stack?: Stack; launch?: LaunchResolution };
// `mode: 'directory'` marks a non-git Project the console launches in place (like Scratch);
// `launch` is its resolved Launch profile for the Project-level Launch button. A git
// `repository` Project omits `launch` and launches through its worktrees.
type Project = { id: string; label: string; mode?: 'repository' | 'directory'; available: boolean; unavailableReason?: string; manageWorktrees?: boolean; manageWorktreesReason?: string; stalePaths?: string[]; setup?: boolean; worktrees: Worktree[]; launch?: LaunchResolution };
// one branch the Add dialog can offer: `ref` is the commit-ish that resolves it and the
// picker's value, `remote` marks a remote-only ref git will track, and `checkedOut` marks a
// local branch a Worktree already holds — it can base a new branch but not be checked out
type BranchOption = { name: string; ref: string; remote: boolean; checkedOut: boolean };
// the fresh facts the Remove dialog decides with (GET /api/worktrees/:id/removal)
type RemovalFacts = { main: boolean; detached: boolean; locked: boolean; lockedReason?: string; branch?: string; dirtyCount: number; pushed: boolean; merged: boolean; ahead?: number; behind?: number; blockers: string[]; stopsProcesses: string[] };
type StoredReviewSummary = { worktreeId: string; branch: string; savedAt: string; title: string; scope: ReviewScope; commit?: string; includeTests: boolean; includeDocs: boolean; fingerprint: string };
// The Review button's state where a review is held. While the review's panel is open in this
// Worktree, `panel` is its split column and `onMinimize` closes it.
type ReviewButtonState = ReviewTourIndicator & { onOpen: () => void; panel?: ReactNode; onMinimize?: () => void };
// a directory-Project or Scratch Place, listed beside the Worktrees (a Worktree is a Place with the same id)
// `adhoc` marks a Scratch folder other than the configured one: the console cannot launch into it
type Place = { id: string; kind: 'directory' | 'scratch'; projectId: string; label: string; home: string; adhoc?: true; pinned: boolean; consoleShells?: number; launch?: LaunchResolution };
type Dashboard = { notesRevision?: number; generation?: number; serverStartedAt?: number; adapters?: AdapterCapabilities; agents: Agent[]; projects: Project[]; places?: Place[]; cleanupPending?: number; scratchLaunch?: LaunchResolution; reviewTour?: ReviewTourCapability; codeReview?: CodeReviewCapability; reviews?: StoredReviewSummary[]; editor?: boolean; keys?: KeysConfig };
// every Worktree across the dashboard's Projects, flattened for tab and launcher rendering
const allWorktrees = (dashboard: Pick<Dashboard, 'projects'>): Worktree[] => dashboard.projects.flatMap(project => project.worktrees);
// why a Worktree's Remove is disabled (it is the Project's Main checkout, git holds a lock,
// or the container does not mount the Project at its host path), or undefined when it can be
// removed — shared by the launcher row and the Workspace toolbar's ⋮ so both say the same
const worktreeRemoveDisabledReason = (worktree: Pick<Worktree, 'locked' | 'main' | 'consoleShells'>, project: Pick<Project, 'manageWorktrees' | 'manageWorktreesReason'> | undefined): string | undefined =>
  worktree.main ? 'The main worktree cannot be removed'
    : worktree.locked ? 'Locked worktrees cannot be removed'
    : project?.manageWorktrees === false ? project.manageWorktreesReason ?? 'This project cannot be managed here.'
    : (worktree.consoleShells ?? 0) > 0 ? 'End the open terminals before removing this worktree'
    : undefined;
// what a launcher row calls a Worktree. Generated labels shed their redundant Project
// prefix, while an operator's custom label is kept exactly as written
const launcherRowLabel = (worktree: Worktree, project: Project): string => {
  // preserve explicit aliases exactly
  if (worktree.customLabel === true) return worktree.label;
  // name generated main rows by branch
  if (worktree.label === project.label) return worktree.branch ?? worktree.label;
  const prefix = `${project.label} · `;
  // remove a redundant generated project prefix
  if (worktree.label.startsWith(prefix)) return worktree.label.slice(prefix.length);
  return worktree.label;
};
// a Worktree's stack as the stack controls name it: its Project, and the Worktree, Main or as its
// launcher row names it (the server names a process used in another Worktree the same way)
const stackPlaceName = (worktreeId: string | undefined, projects: readonly Project[]): { project: string; worktree: string } | undefined => {
  for (const project of projects) {
    const worktree = project.worktrees.find(candidate => candidate.id === worktreeId);
    if (worktree !== undefined) return { project: project.label, worktree: worktree.main && worktree.customLabel !== true ? 'Main' : launcherRowLabel(worktree, project) };
  }
  return undefined;
};
// reproduce discovery's label when an operator clears a custom Worktree name
const generatedWorktreeLabel = (worktree: Worktree, project: Project): string => {
  // main inherits the Project name
  if (worktree.main) return project.label;
  // linked branches inherit their branch
  if (worktree.branch !== undefined) return `${project.label} · ${worktree.branch}`;
  return `${project.label} · ${worktree.sha ?? worktree.path.split('/').pop() ?? worktree.path}`;
};
// fold pending-handoff placeholder Worktrees back into their Project (a minimal Project is
// created when the server no longer reports one), so tabs survive a launch/new-task handoff
const mergeRetainedWorktrees = (projects: Project[], retained: Worktree[]): Project[] => {
  const byId = new Map(projects.map(project => [project.id, { ...project, worktrees: [...project.worktrees] }]));
  for (const worktree of retained) {
    const project = byId.get(worktree.projectId) ?? { id: worktree.projectId, label: worktree.projectId, available: false, worktrees: [] };
    project.worktrees.push(worktree);
    byId.set(worktree.projectId, project);
  }
  return [...byId.values()];
};
// validate durable review dashboard summaries
const isStoredReviewSummary = (value: unknown): value is StoredReviewSummary => value !== null && typeof value === 'object'
  && typeof (value as StoredReviewSummary).worktreeId === 'string'
  && typeof (value as StoredReviewSummary).branch === 'string'
  && typeof (value as StoredReviewSummary).savedAt === 'string'
  && typeof (value as StoredReviewSummary).title === 'string'
  && ['working', 'pr', 'commit'].includes((value as StoredReviewSummary).scope)
  && typeof (value as StoredReviewSummary).includeTests === 'boolean'
  && typeof (value as StoredReviewSummary).includeDocs === 'boolean'
  && typeof (value as StoredReviewSummary).fingerprint === 'string';
const isDashboard = (value: unknown): value is Dashboard => {
  if (value === null || typeof value !== 'object') return false;
  const dashboard = value as { serverStartedAt?: unknown; agents?: unknown; projects?: unknown; cleanupPending?: unknown; reviews?: unknown };
  return (dashboard.serverStartedAt === undefined || typeof dashboard.serverStartedAt === 'number' && Number.isSafeInteger(dashboard.serverStartedAt) && dashboard.serverStartedAt >= 0)
    && Array.isArray(dashboard.agents)
    && Array.isArray(dashboard.projects)
    && (dashboard.cleanupPending === undefined || Number.isInteger(dashboard.cleanupPending) && (dashboard.cleanupPending as number) >= 0)
    && (dashboard.reviews === undefined || Array.isArray(dashboard.reviews) && dashboard.reviews.every(isStoredReviewSummary));
};
const isDashboardFrame = (value: unknown): value is { v: 1; type: 'dashboard'; dashboard: Dashboard } => value !== null && typeof value === 'object' && (value as { v?: unknown }).v === 1 && (value as { type?: unknown }).type === 'dashboard' && isDashboard((value as { dashboard?: unknown }).dashboard);
// validate cleanup targets including explicitly selected closed PR branches
const isCleanupTarget = (value: unknown): value is CleanupTarget => value !== null && typeof value === 'object'
  && typeof (value as CleanupTarget).id === 'string'
  && ['orphan-worker', 'stale-agent', 'hud-pane', 'hud-process', 'merged-branch', 'closed-pr-branch'].includes((value as CleanupTarget).kind)
  && typeof (value as CleanupTarget).label === 'string'
  && typeof (value as CleanupTarget).detail === 'string';
// validate fresh branch deletion facts
const isBranchRemovalFacts = (value: unknown): value is BranchRemovalFacts => value !== null && typeof value === 'object'
  && typeof (value as BranchRemovalFacts).branch === 'string'
  && typeof (value as BranchRemovalFacts).checkedOut === 'boolean'
  && Number.isInteger((value as BranchRemovalFacts).dirtyCount)
  && (value as BranchRemovalFacts).dirtyCount >= 0
  && typeof (value as BranchRemovalFacts).pushed === 'boolean'
  && typeof (value as BranchRemovalFacts).merged === 'boolean'
  && typeof (value as BranchRemovalFacts).defaultBranch === 'boolean';
type AgentState = 'working' | 'prompt-done' | 'action-required' | 'closed';
type DashboardOperation = 'launching'|'restarting'|'clearing'|'deactivating'|'new-task';
type PendingSessionLaunch = { id: string; draftId: string; label: string; resolution?: LaunchResolution; choice?: LaunchChoice; kind?: AgentKind; sandboxed?: boolean; phase: 'launching'|'confirming'|'delayed'|'failed'; agentId?: string; error?: string; confirmationTimer?: number } & ({ scope: 'scratch' } | { scope: 'directory'; projectId: string });
// One tab: a Place (its Agents, and its Worktree or directory-Project/Scratch Place when listed),
// an Agent the dashboard placed nowhere, or a scratch/directory launch not yet discovered.
// `placeId` is the Place the tab stands for; `state` and `unread` roll up its Agents. A
// `transient` tab is a Place opened from + that nothing keeps yet, so it closes when left.
type DashboardItem = { key: string; label: string; state: AgentState; order: number; unread: boolean; operation?: DashboardOperation; agents: Agent[]; placeId?: string; worktree?: Worktree; place?: Place; pendingLaunch?: PendingSessionLaunch; transient?: boolean };
// the Place an Agent's tab groups under (discovery stamps `placeId`; a Worktree Agent's is its Worktree id)
const agentPlaceId = (agent: Pick<Agent, 'placeId' | 'worktreeId'>): string | undefined => agent.placeId ?? agent.worktreeId;
// the tab key of a Place (a Worktree, directory Project or Scratch folder)
const placeItemKey = (placeId: string): string => `place-${placeId}`;
// the tab key an Agent is shown under: its Place's, or its own when placed nowhere
const agentItemKey = (agent: Pick<Agent, 'id' | 'placeId' | 'worktreeId'>): string => { const placeId = agentPlaceId(agent); return placeId === undefined ? `agent-${agent.id}` : placeItemKey(placeId); };
// A Place tab's rolled-up state, most urgent first: a question, then unread output, then work.
// There are no counts; the switcher lists each Agent's own state.
function placeTabState(agents: readonly Agent[]): { state: AgentState; unread: boolean } {
  const states = agents.map(agentState);
  if (states.includes('action-required')) return { state: 'action-required', unread: false };
  if (agents.some(agent => agent.unread === true)) return { state: 'prompt-done', unread: true };
  if (states.includes('working')) return { state: 'working', unread: false };
  return { state: states.length === 0 ? 'closed' : 'prompt-done', unread: false };
}
type ChoiceOption = { label: string; number: number; answerIndex: number; description?: string };
type ChoiceQuestion = { text: string; choices: ChoiceOption[]; id: string; source: 'structured' | 'parsed' };
type QueuedPrompt = { id: string; text: string; createdAt: string; attachments?: Array<{ name: string; size: number }> };
type PromptHistoryEntry = { id: string; text: string; createdAt: string; answer?: string; answeredAt?: string };
// validate prompt history responses
const isPromptHistoryEntry = (value: unknown): value is PromptHistoryEntry => value !== null
  && typeof value === 'object'
  && typeof (value as PromptHistoryEntry).id === 'string'
  && typeof (value as PromptHistoryEntry).text === 'string'
  && typeof (value as PromptHistoryEntry).createdAt === 'string'
  && ((value as PromptHistoryEntry).answer === undefined || typeof (value as PromptHistoryEntry).answer === 'string')
  && ((value as PromptHistoryEntry).answeredAt === undefined || typeof (value as PromptHistoryEntry).answeredAt === 'string');
const isQueuedPrompt = (value: unknown): value is QueuedPrompt => value !== null
  && typeof value === 'object'
  && typeof (value as QueuedPrompt).id === 'string'
  && typeof (value as QueuedPrompt).text === 'string'
  && typeof (value as QueuedPrompt).createdAt === 'string'
  && ((value as QueuedPrompt).attachments === undefined || Array.isArray((value as QueuedPrompt).attachments) && (value as QueuedPrompt).attachments!.every(attachment => attachment !== null && typeof attachment === 'object' && typeof attachment.name === 'string' && Number.isInteger(attachment.size) && attachment.size >= 0));
type NoteAttachment = { name: string; size: number };
type WorktreeNote = { id: string; text: string; title?: string; locked?: boolean; allWorkspaces?: boolean; attachments?: NoteAttachment[]; source?: 'queued-prompt'; schedule?: Schedule; nextRun?: string };
// keep deletion recovery available after changing workspaces
const NoteFeedbackContext = createContext<{ deleted: (label: string, undoToken: string) => void; toasts: ReactNode[] } | undefined>(undefined);
// the Adapter and target a new Schedule pre-fills with, plus the launcher rows the note pane's
// Adapter and target pickers offer, all resolved from the dashboard for the active tab's context
type SchedulePrefill = { kind: AgentKind; target: ScheduleTarget; runsOnText: string; adapters: ScheduleAdapterOption[]; targets: ScheduleTargetOption[]; liveAgentIds: string[] };
type AssistantFile = { path: string; size: number };
type AssistantPreviewImage = { mediaType: 'image/gif'|'image/jpeg'|'image/png'|'image/webp'; base64: string };
type AssistantFilePreview = AssistantFile & { truncated: boolean } & ({ binary: true; image?: AssistantPreviewImage } | { binary: false; content: string });
type FilePreviewState = 'loading'|'ready'|'error';
type InstanceIcon = 'terminal'|'potato'|'heart';
// retain inherited peer identity separately from local navigation overrides
type RemoteServer = { name: string; url: string; icon?: InstanceIcon; defaultName?: string; defaultIcon?: InstanceIcon };
type ServerInfo = { name: string; url: string; icon?: InstanceIcon; remotes: RemoteServer[] };
type InstanceAttention = 'idle'|'working'|'question'|'completed'|'unavailable';
type InstanceStatus = RemoteServer & { attention: InstanceAttention };
type DavoSettings = { enabled: boolean; available: boolean; name: string; context: string };
type SessionInfo = { csrfToken: string; active: boolean; deviceName?: string; controllingDeviceName?: string; defaultAgent?: AgentKind; davo?: DavoSettings; server?: ServerInfo };
type CodexLimitWindow = { usedPercent: number; windowDurationMins?: number; resetsAt?: number };
type ApiKeySpend = { status: 'available'; todayUsd: number; weekUsd: number; asOf: number } | { status: 'unconfigured' | 'unavailable' };
type CodexAccount = { id: string; label: string; active: boolean; authMode?: 'apikey'; spend?: ApiKeySpend; email?: string; planType?: string; primary?: CodexLimitWindow; secondary?: CodexLimitWindow; resetCount?: number; error?: string };
type CodexAccountRestart = { worktreeId: string; status: 'restarted'|'skipped'|'failed'; error?: string };
type CodexAccountResetOutcome = 'reset'|'nothingToReset'|'noCredit'|'alreadyRedeemed';
type CodexAccountLogin = { loginId: string; verificationUrl: string; userCode: string };
type CodexAccountLoginStatus = { status: 'pending'|'succeeded'|'failed'; account?: CodexAccount; error?: string };
// The prompt box's `$skill`/`/slash` catalog is served per Agent by the server
// from the addressed Agent's Adapter (ADR 0002); the web no longer hard-codes it.
type PromptCommand = { value: string; description?: string };
type CommandToken = { start: number; end: number; prefix: '$'|'/'; query: string };
const validCommandValue = /^[$/][^\s]+$/u;
const commandTokenAt = (value: string, cursor: number): CommandToken | undefined => {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)([$/])([^\s]*)$/u.exec(before);
  if (!match) return undefined;
  const prefix = match[1];
  if (prefix !== '$' && prefix !== '/') return undefined;
  const token = `${prefix}${match[2]}`;
  const suffix = /^\S*/u.exec(value.slice(cursor))?.[0] ?? '';
  return { start: cursor - token.length, end: cursor + suffix.length, prefix, query: `${match[2]}${suffix}` };
};

// Attention is resolved server-side (ADR 0001/0002); the web reads it and never regexes a title.
// present latest-message questions without changing composer readiness
const actionRequired = (agent: Agent) => agent.attention === 'question' || agent.attention === 'finished' && agent.hasMessageQuestion === true;
// reuse the same displayed attention for badges and notifications
const agentState = (agent: Agent): AgentState => actionRequired(agent) ? 'action-required' : agent.attention === 'working' ? 'working' : 'prompt-done';
const agentLabel = (agent: Agent) => (agent.displayLabel ?? (actionRequired(agent) ? agent.title.replace(/(?:\[\s*.\s*\]\s*)?action required\s*\|?\s*/i, '🚨 ') : agent.title)) || agent.home;
// keep server-owned update advisors inside their modal surface
const isEmbeddedUpdateAdvisor = (agent: Pick<Agent, 'displayLabel' | 'worktreeId'>): boolean => agent.worktreeId === undefined && /^Update Advisor (?:(?:Starting v[34]|v[234]) )?[0-9a-f]{7}$/u.test(agent.displayLabel ?? '');
// list other open worktrees once, labelling each by its Worktree (the server carries the
// label there; agent.worktreeLabel is the legacy fallback for a Worktree not in the payload)
const otherOpenWorktrees = (agents: Agent[], activeWorktreeId: string | undefined, labelById: Map<string, string>): VoiceWorktree[] => {
  const worktrees = new Map<string, VoiceWorktree>();
  // collect live worktree sessions
  for (const agent of agents) {
    // skip scratch sessions and the active worktree
    if (agent.worktreeId === undefined || agent.worktreeId === activeWorktreeId) continue;
    worktrees.set(agent.worktreeId, { id: agent.worktreeId, label: labelById.get(agent.worktreeId) ?? agent.worktreeLabel ?? agentLabel(agent) });
  }
  return [...worktrees.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
};
type SpeechRecognitionResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type SpeechRecognitionInstance = { continuous: boolean; interimResults: boolean; lang: string; start: () => void; abort: () => void; onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResult> }) => void) | null; onend: (() => void) | null; onerror: ((event: { error?: string }) => void) | null };
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

const promptDrafts = new Map<string, string>();
const promptDraftListeners = new Map<string, Set<() => void>>();
type PromptNoteSource = Pick<Agent, 'id' | 'placeId' | 'worktreeId'> & { onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void };
const promptDraftKey = (id: string) => `remote-agent-console:prompt-draft:${id}`;
const readPromptDraft = (id: string) => {
  try { return localStorage.getItem(promptDraftKey(id)) ?? ''; }
  catch { return ''; }
};
const savePromptDraft = (id: string, value: string) => {
  try {
    if (value) localStorage.setItem(promptDraftKey(id), value);
    else localStorage.removeItem(promptDraftKey(id));
  } catch { /* Private browsing or storage quota must not block prompting. */ }
};
const getPromptDraft = (id: string) => {
  if (!promptDrafts.has(id)) promptDrafts.set(id, readPromptDraft(id));
  return promptDrafts.get(id) ?? '';
};
const subscribeToPromptDraft = (id: string, listener: () => void) => {
  const listeners = promptDraftListeners.get(id) ?? new Set();
  listeners.add(listener);
  promptDraftListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) promptDraftListeners.delete(id);
  };
};
const setPromptDraft = (id: string, next: SetStateAction<string>) => {
  const current = getPromptDraft(id);
  const value = typeof next === 'function' ? next(current) : next;
  if (value === current) return;
  promptDrafts.set(id, value);
  savePromptDraft(id, value);
  promptDraftListeners.get(id)?.forEach(listener => listener());
};
const usePromptDraft = (id: string): [string, Dispatch<SetStateAction<string>>] => [
  useSyncExternalStore(listener => subscribeToPromptDraft(id, listener), () => getPromptDraft(id), () => ''),
  next => setPromptDraft(id, next)
];
// retain selected files across composer remounts without persisting file contents
const promptAttachments = new Map<string, File[]>();
const emptyPromptAttachments: File[] = [];
// identify drafts prepared before a worktree has an agent
const worktreePromptId = (worktreeId: string) => `worktree-prompt:${worktreeId}`;
const promptHandoffFocus = new Map<string, { start: number; end: number }>();
// publish file changes even when the composer is minimized
const setPromptAttachments = (id: string, next: SetStateAction<File[]>) => {
  const current = promptAttachments.get(id) ?? emptyPromptAttachments;
  const files = typeof next === 'function' ? next(current) : next;
  // release file buffers when the draft is cleared
  if (files.length === 0) promptAttachments.delete(id);
  else promptAttachments.set(id, files);
  // notify every mounted draft consumer
  promptDraftListeners.get(id)?.forEach(listener => listener());
};
// share attachment snapshots with the draft's existing subscription
const usePromptAttachments = (id: string): [File[], Dispatch<SetStateAction<File[]>>] => [
  useSyncExternalStore(listener => subscribeToPromptDraft(id, listener), () => promptAttachments.get(id) ?? emptyPromptAttachments),
  next => setPromptAttachments(id, next)
];
// hand a prepared draft to the dashboard-confirmed agent without sending it
const handoffPromptDraft = (from: string, to: string) => {
  const value = getPromptDraft(from);
  const files = promptAttachments.get(from);
  const input = document.activeElement;
  const focused = input instanceof HTMLTextAreaElement && input.dataset.promptId === from;
  // leave unrelated dashboard refreshes free of draft writes
  if (!value && files === undefined && !focused) return;
  // preserve an in-progress edit without stealing focus from another tab
  if (focused) {
    promptHandoffFocus.set(to, { start: input.selectionStart, end: input.selectionEnd });
  }
  // retain selected files through the placeholder remount
  if (files !== undefined) promptAttachments.set(to, [...files, ...(promptAttachments.get(to) ?? [])]);
  // retain any existing draft on the discovered agent
  if (value) setPromptDraft(to, current => current ? `${value}\n\n${current}` : value);
  // refresh a previously mounted destination for attachment-only drafts
  if (files !== undefined) promptDraftListeners.get(to)?.forEach(listener => listener());
  promptAttachments.delete(from);
  promptDrafts.delete(from);
  savePromptDraft(from, '');
};
const terminalInputs = new Map<string, (value: string) => boolean>();
const exitTerminalInput = new Map<string, () => void>();
// focus a mounted Terminal panel's xterm, by pane id
const terminalFocusers = new Map<string, () => void>();
// open a mounted Console shell panel's rename field, by pane id
const terminalRenamers = new Map<string, () => void>();
const answeredQuestionActions = new Map<string, (question: ChoiceQuestion) => void>();
// the id of a just-answered question, kept per agent so its optimistic dismissal survives a remount
const dismissedQuestionIds = new Map<string, string>();
const mobileModifiers = new Map<string, { alt: boolean; ctrl: boolean; shift: boolean; fn: boolean }>();
// default every pane's sticky modifiers
const stickyModifiers = (id: string) => mobileModifiers.get(id) ?? { alt: false, ctrl: false, shift: false, fn: false };
// translate fn digits before applying the existing printable-key modifiers
const applyStickyModifiers = (id: string, data: string): string => {
  const { alt, ctrl, shift, fn } = stickyModifiers(id);
  // interpret only a single digit as a function key
  if (fn && /^[0-9]$/u.test(data)) {
    const key = Number(data) || 10;
    const modifier = 1 + Number(shift) + Number(alt) * 2 + Number(ctrl) * 4;
    // match xterm's ss3 and modified csi sequences for f1 through f4
    if (key <= 4) return modifier === 1 ? `\x1bO${'PQRS'[key - 1]}` : `\x1b[1;${modifier}${'PQRS'[key - 1]}`;
    const code = [15, 17, 18, 19, 20, 21][key - 5];
    return `\x1b[${code}${modifier === 1 ? '' : `;${modifier}`}~`;
  }
  const first = data.charAt(0);
  return `${alt ? '\x1b' : ''}${ctrl && /^[a-z]$/iu.test(first) ? String.fromCharCode(first.toLowerCase().charCodeAt(0) - 96) : shift && /^[a-z]$/iu.test(first) ? `${first.toUpperCase()}${data.slice(1)}` : data}`;
};
// Worktree ids changed to `<projectId>:<realpath>` (ADR 0003), so per-Worktree browser
// prefs keyed by the old config ids are stale; clear those namespaces once.
(() => {
  try {
    const marker = 'rac.worktree-id-reset:v1';
    if (localStorage.getItem(marker) === '1') return;
    for (const prefix of ['rac.note-view:', 'rac.browser-viewport:', 'rac.browser-split:', 'rac.browser-url:']) {
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
    localStorage.setItem(marker, '1');
  } catch { /* private-mode storage is non-fatal */ }
})();
type WorktreeNoteView = { noteId: string; expanded: boolean };
const retainedWorktreeNoteViews = new Map<string, WorktreeNoteView>();
// force a note view's list to refetch from a sibling component (the queued panel's Save as note
// lives in Prompt, while the notes hook lives in the sibling Log), keyed by note view id
const noteReloadRequests = new Map<string, () => void>();
const queuedNoteSeenKey = 'rac.seen-queued-notes';
// validate optional browser acknowledgements
const parseSeenQueuedNotes = (serialized: string | null): Set<string> => {
  try {
    const stored: unknown = JSON.parse(serialized ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
  } catch { return new Set(); }
};
// retain acknowledgements when browser storage is unavailable
const seenQueuedNoteIds = (() => {
  try { return parseSeenQueuedNotes(localStorage.getItem(queuedNoteSeenKey)); }
  catch { return new Set<string>(); }
})();
const queuedNoteSeenListeners = new Set<() => void>();
// merge concurrent acknowledgements without echoing already converged storage
const persistSeenQueuedNotes = () => {
  try {
    const stored = parseSeenQueuedNotes(localStorage.getItem(queuedNoteSeenKey));
    // retain acknowledgements made by another tab before this write
    for (const id of stored) seenQueuedNoteIds.add(id);
    // write only when this tab knows additional acknowledgements
    if (stored.size !== seenQueuedNoteIds.size) localStorage.setItem(queuedNoteSeenKey, JSON.stringify([...seenQueuedNoteIds]));
  } catch { /* browser storage is optional */ }
};
// converge overlapping writes and refresh badges in other browser tabs
window.addEventListener('storage', event => {
  // ignore unrelated preferences and explicit storage removal
  if (event.storageArea !== localStorage || event.key !== queuedNoteSeenKey || event.newValue === null) return;
  // preserve event data even if a newer write has already reached storage
  for (const id of parseSeenQueuedNotes(event.newValue)) seenQueuedNoteIds.add(id);
  persistSeenQueuedNotes();
  // notify every notes control after merging
  queuedNoteSeenListeners.forEach(listener => listener());
});
// share acknowledgements with every mounted notes control
const subscribeToQueuedNoteSeen = (listener: () => void) => {
  queuedNoteSeenListeners.add(listener);
  return () => { queuedNoteSeenListeners.delete(listener); };
};
// acknowledge only queued notes actually shown in the notes list
const markQueuedNotesSeen = (notes: WorktreeNote[]) => {
  const unread = notes.filter(note => note.source === 'queued-prompt' && !seenQueuedNoteIds.has(note.id));
  // avoid duplicate writes during background refreshes
  if (unread.length === 0) return;
  // keep acknowledgement independent of editable titles and worktree tabs
  for (const note of unread) seenQueuedNoteIds.add(note.id);
  persistSeenQueuedNotes();
  // refresh every badge sharing these notes
  queuedNoteSeenListeners.forEach(listener => listener());
};
const worktreeNoteViewKey = (worktreeId: string) => `rac.note-view:${worktreeId}`;
const getWorktreeNoteView = (worktreeId: string) => {
  const retained = retainedWorktreeNoteViews.get(worktreeId);
  if (retained !== undefined) return retained;
  try {
    const stored = JSON.parse(localStorage.getItem(worktreeNoteViewKey(worktreeId)) ?? 'null') as Partial<WorktreeNoteView> | null;
    if (stored !== null && typeof stored.noteId === 'string' && typeof stored.expanded === 'boolean') {
      const view = { noteId: stored.noteId, expanded: stored.expanded };
      retainedWorktreeNoteViews.set(worktreeId, view);
      return view;
    }
  } catch { /* browser storage is optional */ }
  return undefined;
};
const setWorktreeNoteView = (worktreeId: string, view: WorktreeNoteView) => {
  retainedWorktreeNoteViews.set(worktreeId, view);
  try { localStorage.setItem(worktreeNoteViewKey(worktreeId), JSON.stringify(view)); }
  catch { /* browser storage is optional */ }
};
const clearWorktreeNoteView = (worktreeId: string) => {
  retainedWorktreeNoteViews.delete(worktreeId);
  try { localStorage.removeItem(worktreeNoteViewKey(worktreeId)); }
  catch { /* browser storage is optional */ }
};
const pendingOperations = new Set<string>();
// serialize lifecycle and prompt mutations within one workspace
const pendingWorkspaceScopes = new Map<string, string>();
const pendingOperationListeners = new Map<string, Set<() => void>>();
const pendingNewTaskSources = new Map<string, string>();
// retain launch handoffs by place
// `excludedAgentIds` are the Agents already at the Worktree when the launch began (a restart's
// siblings), none of which can be the launch's replacement
type PendingWorktreeLaunch = { operationKey: string; kind?: AgentKind; sourceAgentId?: string; excludedAgentIds?: readonly string[]; agentId?: string; confirmationTimer?: number };
const pendingWorktreeLaunches = new Map<string, PendingWorktreeLaunch>();
const worktreeLaunchConfirmationMs = 30_000;
const pullRequestSwitchCache = new Map<string, PullRequestSwitchAvailability>();
const newTaskOperationKey = (worktreeId: string) => `new-task:${worktreeId}`;
const launchOperationKey = (worktreeId: string) => `worktree-launch:${worktreeId}`;
const deactivateOperationKey = (worktreeId: string) => `deactivate:${worktreeId}`;
// track restart transitions by worktree
const restartOperationKey = (worktreeId: string) => `restart:${worktreeId}`;
// track clear transitions by agent
const clearOperationKey = (agentId: string) => `clear:${agentId}`;
// select one active agent transition
const agentPendingOperation = (agent: Agent): DashboardOperation | undefined => {
  const scope = agent.worktreeId ?? agent.id;
  // prioritize new-task replacement
  if (pendingOperations.has(newTaskOperationKey(scope))) return 'new-task';
  // preserve restart handoff state
  if (pendingOperations.has(restartOperationKey(scope))) return 'restarting';
  // expose conversation clearing
  if (pendingOperations.has(clearOperationKey(agent.id))) return 'clearing';
  // expose permanent shutdown
  if (pendingOperations.has(deactivateOperationKey(scope))) return 'deactivating';
  return undefined;
};
// select one inactive worktree transition
const worktreePendingOperation = (worktree: Worktree): DashboardOperation | undefined => {
  // prioritize new-task replacement
  if (pendingOperations.has(newTaskOperationKey(worktree.id))) return 'new-task';
  // preserve restart handoff state
  if (pendingOperations.has(restartOperationKey(worktree.id))) return 'restarting';
  // expose a Turn off that outlasts its agent
  if (pendingOperations.has(deactivateOperationKey(worktree.id))) return 'deactivating';
  // expose fresh launches
  if (pendingOperations.has(launchOperationKey(worktree.id))) return 'launching';
  return undefined;
};
const dashboardOperationLabels: Record<DashboardOperation, string> = { launching: 'Starting agent', restarting: 'Restarting', clearing: 'Clearing', deactivating: 'Turning off', 'new-task': 'Starting new task' };
// label one optional dashboard transition
const dashboardOperationLabel = (operation: DashboardOperation | undefined) => operation === undefined ? undefined : dashboardOperationLabels[operation];
const tabStateLabels: Record<AgentState, string> = { working: 'Working', 'prompt-done': 'Prompt done', 'action-required': 'Action required', closed: 'Agent closed' };
// a tab's status as its label and classes say it: a transition in flight outranks its Agents' state
const tabStatus = (entry: DashboardItem) => {
  const transition = dashboardOperationLabel(entry.operation);
  const label = `${transition ?? tabStateLabels[entry.state]}${entry.unread ? ' — Unread' : ''}`;
  // waiting states retain their colors without advertising active work
  const progress: ProgressColor | undefined = entry.operation === 'restarting' ? 'yellow'
    : entry.operation === 'clearing' || entry.operation === 'deactivating' ? 'red'
      : entry.operation === 'launching' || entry.operation === 'new-task' ? 'blue'
        : entry.state === 'working' ? 'peach' : undefined;
  const busy = entry.operation !== undefined || entry.state === 'working';
  return { transition, label, progress, busy, className: `${transition === undefined ? `status-${entry.state}` : 'status-transitioning'}${entry.unread ? ' unread' : ''}${progress === undefined ? '' : ` progress-border progress-${progress}`}` };
};
const defaultPushAction: PromptAction = { label: 'Commit/Push', prompt: 'review, commit, and push' };
const subscribeToPendingOperation = (key: string, listener: () => void) => {
  const listeners = pendingOperationListeners.get(key) ?? new Set();
  listeners.add(listener);
  pendingOperationListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) pendingOperationListeners.delete(key);
  };
};
const setPendingOperation = (key: string, pending: boolean) => {
  // release ownership with the existing operation lifecycle
  if (!pending) pendingWorkspaceScopes.delete(key);
  if (pending === pendingOperations.has(key)) return;
  if (pending) pendingOperations.add(key);
  else pendingOperations.delete(key);
  pendingOperationListeners.get(key)?.forEach(listener => listener());
};
const beginPendingOperation = (key: string, workspaceKey?: string) => {
  // reject duplicate or competing workspace mutations synchronously
  if (pendingOperations.has(key)) return false;
  if (workspaceKey !== undefined && [...pendingWorkspaceScopes.values()].includes(workspaceKey)) return false;
  // retain scope until completion or handoff releases the operation
  if (workspaceKey !== undefined) pendingWorkspaceScopes.set(key, workspaceKey);
  setPendingOperation(key, true);
  return true;
};
const usePendingOperation = (key: string) => useSyncExternalStore(
  listener => subscribeToPendingOperation(key, listener),
  () => pendingOperations.has(key),
  () => false
);
// read one complete metadata envelope
// preserve one structured choice number
const choiceFromLabel = (label: string, answerIndex: number): ChoiceOption => {
  const numbered = /^(\d+)[.)]\s+(.+)$/u.exec(label);
  return numbered === null
    ? { label, number: answerIndex + 1, answerIndex }
    : { label: numbered[2]!, number: Number(numbered[1]), answerIndex };
};

// project one server inline question into the renderable choice model. The
// server parses numbered lists and reads OMX files now, so the web no longer
// parses pane text; it only maps the labels to numbered choices.
const choiceQuestionFromInline = (question: InlineQuestion): ChoiceQuestion => ({ id: question.id, text: question.text, choices: question.choices.map((label, index) => {
  const choice = choiceFromLabel(label, index);
  const description = question.descriptions?.[index];
  return description ? { ...choice, description } : choice;
}), source: question.source });

let csrf = '';
const currentUiVersion = (() => {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return script === null ? undefined : new URL(script.src).pathname;
})();
type ConsoleConnectionListener = (reachable: boolean) => void;
const consoleConnectionListeners = new Set<ConsoleConnectionListener>();
const unavailableStatuses = new Set([502, 503, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
let consoleReachable = true;
let consoleReachabilityRevision = 0;
let consoleHealthCheck: Promise<boolean> | undefined;
// publish connectivity without allowing older probes to override a successful response
const setConsoleReachable = (reachable: boolean) => {
  // every definitive observation supersedes outstanding failure checks
  consoleReachabilityRevision += 1;
  // notify only connection transitions
  if (reachable === consoleReachable) return;
  consoleReachable = reachable;
  // update mounted connection observers
  consoleConnectionListeners.forEach(listener => listener(reachable));
};
const subscribeToConsoleConnection = (listener: ConsoleConnectionListener) => {
  consoleConnectionListeners.add(listener);
  return () => {
    consoleConnectionListeners.delete(listener);
  };
};
// distinguish an unavailable operation from an unavailable console
const confirmConsoleReachability = () => {
  // share one bounded probe across concurrent failed requests
  if (consoleHealthCheck !== undefined) return;
  const revision = consoleReachabilityRevision;
  consoleHealthCheck = fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(4_000) })
    .then(response => response.ok, () => false)
    .finally(() => { consoleHealthCheck = undefined; });
  // preserve responses and errors while checking connectivity in the background
  void consoleHealthCheck.then(reachable => {
    // ignore a check superseded by newer definitive connectivity evidence
    if (revision !== consoleReachabilityRevision) return;
    setConsoleReachable(reachable);
  });
};
// observe console health without promoting operation failures into global outages
const consoleFetch = async (url: string, init: RequestInit = {}) => {
  try {
    const response = await fetch(url, init);
    // confirm gateway-like statuses before blocking the interface
    if (unavailableStatuses.has(response.status)) confirmConsoleReachability();
    else setConsoleReachable(true);
    return response;
  } catch (error) {
    // caller-owned cancellation does not indicate a connection failure
    if (!init.signal?.aborted) setConsoleReachable(false);
    throw error;
  }
};
const request = async (url: string, init: RequestInit = {}, observeReachability = true) => {
  const headers = new Headers(init.headers);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  try {
    const options = { ...init, credentials: 'same-origin' as const, headers };
    return await (observeReachability ? consoleFetch(url, options) : fetch(url, options));
  } catch {
    return new Response(JSON.stringify({ error: 'Console unavailable' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'application/json' }
    });
  }
};
// read a Worktree branch's pull request comments fresh from GitHub
const loadPullRequestComments = async (worktreeId: string): Promise<PullRequestComments> => {
  const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/pull-request/comments`);
  const payload: unknown = await response.json().catch(() => undefined);
  const error = payload !== null && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
  if (!response.ok) throw new Error(typeof error === 'string' ? error : 'Could not load the pull request comments.');
  const value = payload as Partial<PullRequestComments> | undefined;
  if (!Array.isArray(value?.threads) || !Array.isArray(value.reviews) || !Array.isArray(value.comments) || typeof value.number !== 'number') throw new Error('The console returned invalid pull request comments.');
  return value as PullRequestComments;
};
// preserve explicit json framing for otherwise bodyless mutations
const emptyJsonMutation = (method: 'POST' | 'DELETE'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
// load the newest retained stack output
const stackLog = async (worktreeId: string): Promise<StackOperationLog | undefined> => {
  const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/commands/log`);
  // allow stacks that have not run yet
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('stack log unavailable');
  const payload: unknown = await response.json();
  // reject malformed log payloads
  if (!isStackOperationLog(payload)) throw new Error('invalid stack log');
  return payload;
};
// read a Stack process's recent output from its pane
const processOutput = async (worktreeId: string, name: string): Promise<StackProcessOutput> => {
  const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/processes/${encodeURIComponent(name)}/output`);
  // a process no longer configured (404) is a failed read, shown as such rather than a wait
  if (!response.ok) throw new Error('process output unavailable');
  const payload: unknown = await response.json();
  // reject malformed output payloads
  if (!isStackProcessOutput(payload)) throw new Error('invalid process output');
  return payload;
};
// empty a Stack process's pane so its output starts fresh
const clearProcessOutput = async (worktreeId: string, name: string): Promise<void> => {
  const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/processes/${encodeURIComponent(name)}/output`, emptyJsonMutation('DELETE'));
  if (!response.ok) throw new Error('process output not cleared');
};
// the route that starts, stops or restarts one Stack process of a Worktree
const processActionUrl = (worktreeId: string, name: string, action: StackAction) => `/api/worktrees/${encodeURIComponent(worktreeId)}/processes/${encodeURIComponent(name)}/${action}`;
// start the process a notice names in its own Worktree, as that Worktree's menu would, throwing
// the console's reason when it refuses (busy) or fails
const startNoticeProcess = (target: StartableNoticeTarget) => sendUseAction(target.worktreeId, target.process, 'start');
// start or stop a process another Worktree declares, as that Worktree's own stack menu would,
// throwing the console's reason when it refuses (busy) or fails
const sendUseAction = async (worktreeId: string, name: string, action: ProcessAction) => {
  const response = await request(processActionUrl(worktreeId, name, action), emptyJsonMutation('POST'));
  // accept successful actions
  if (response.ok) return;
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  throw new Error(typeof payload?.error === 'string' ? payload.error : `Unable to ${action} ${name}.`);
};
// the actions one Worktree's stack controls send: the whole stack, one of its processes, and a
// process it uses in another Worktree
const stackHandlers = (worktreeId: string): StackHandlers => ({
  onStackAction: action => request(`/api/worktrees/${encodeURIComponent(worktreeId)}/commands/${action}`, emptyJsonMutation('POST')),
  onProcessAction: (name, action) => request(processActionUrl(worktreeId, name, action), emptyJsonMutation('POST')),
  onUseAction: sendUseAction
});
// The stack menu a notice's Open asked a Worktree's toolbar to show once it mounts, as switching
// to that Worktree's tab does (each tab's card is keyed by its Place, so it mounts afresh). It
// lapses unshown if the tab never comes.
let requestedStackMenu: { worktreeId: string; expires: number } | undefined;
const requestStackMenu = (worktreeId: string) => { requestedStackMenu = { worktreeId, expires: Date.now() + 10_000 }; };
// whether this Worktree's stack menu was asked for, taking the request so it opens only once
function useRequestedStackMenu(worktreeId: string | undefined): boolean {
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    const pending = requestedStackMenu;
    if (worktreeId === undefined || pending?.worktreeId !== worktreeId) return;
    requestedStackMenu = undefined;
    if (pending.expires > Date.now()) setRequested(true);
  }, [worktreeId]);
  return requested;
}
function usePromptHistory(agentId: string) {
  // stamped with its Agent, so a response that lands after the switcher moves on is never shown
  const [loaded, setLoaded] = useState<{ agentId: string; prompts: PromptHistoryEntry[] }>();
  const refresh = useCallback(async () => {
    const response = await request(`/api/agents/${encodeURIComponent(agentId)}/prompt-history`);
    if (!response.ok) return;
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) return;
    const prompts = (payload as { prompts: unknown[] }).prompts.filter(isPromptHistoryEntry);
    if (prompts.length === (payload as { prompts: unknown[] }).prompts.length) setLoaded({ agentId, prompts });
  }, [agentId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const history = useMemo(() => loaded?.agentId === agentId ? loaded.prompts : [], [loaded, agentId]);
  return { history, refresh };
}
const maxAttachmentMegabytes = 25;
const maxAttachmentBytes = maxAttachmentMegabytes * 1024 * 1024;
const mergeSpeechSegments = (current: string, next: string) => {
  const left = current.trim().split(/\s+/u).filter(Boolean);
  const right = next.trim().split(/\s+/u).filter(Boolean);
  const comparable = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  let overlap = Math.min(left.length, right.length);
  while (overlap > 0 && !left.slice(-overlap).every((word, index) => comparable(word) === comparable(right[index]!))) overlap -= 1;
  return [...left, ...right.slice(overlap)].join(' ');
};
// fit existing lines without reserving a blank row
const fitPromptInput = (input: HTMLTextAreaElement) => {
  const style = getComputedStyle(input);
  const borderHeight = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
  const minHeight = Number.parseFloat(style.minHeight) || 0;
  input.style.minHeight = '0';
  input.style.height = '0';
  const contentHeight = input.scrollHeight;
  input.style.removeProperty('min-height');
  input.style.height = `${Math.max(minHeight, contentHeight + borderHeight)}px`;
};
const encodeAttachment = async (file: File): Promise<{ name: string; data: string }> => await new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment'));
  reader.onload = () => {
    const result = reader.result;
    if (typeof result !== 'string') return reject(new Error('Unable to read attachment'));
    const separator = result.indexOf(',');
    if (separator < 0) return reject(new Error('Unable to read attachment'));
    resolve({ name: file.name, data: result.slice(separator + 1) });
  };
  reader.readAsDataURL(file);
});
const agentNotificationTag = (agent: Pick<Agent, 'id' | 'worktreeId'>) => agent.worktreeId === undefined ? `agent-status-${agent.id}` : `worktree-status-${agent.worktreeId}`;
const reviewNotificationTag = (worktreeId: string) => `review-ready-${worktreeId}`;
// resolve user-facing names for one agent alert
const agentNotificationNames = (agent: Agent, projects: Project[]) => {
  const project = projects.find(candidate => candidate.id === agent.projectId);
  const worktree = project?.worktrees.find(candidate => candidate.id === agent.worktreeId);
  const fallbackName = agent.worktreeLabel ?? agent.displayLabel ?? agent.home.split('/').filter(Boolean).at(-1) ?? agent.title;
  return { projectName: project?.label ?? fallbackName, worktreeName: worktree?.label ?? fallbackName, multipleWorktrees: (project?.worktrees.length ?? 0) > 1 };
};
const pageFocused = () => document.visibilityState === 'visible' && document.hasFocus();
const notificationSoundPaths = { finished: '/notification-success.wav', question: '/notification-warning.wav' } as const;
const recentNotificationSounds = new Map<string, number>();

// play one distinct agent alert chime
const playNotificationSound = async (kind: 'question' | 'finished' | 'system', tag: string): Promise<boolean> => {
  // leave system alerts unchanged
  if (kind === 'system') return false;
  const now = Date.now();
  const previous = recentNotificationSounds.get(tag);
  // suppress duplicate polling and push alerts
  if (previous !== undefined && now - previous < 3_000) return true;
  recentNotificationSounds.set(tag, now);
  window.setTimeout(() => recentNotificationSounds.delete(tag), 3_000);
  try {
    const sound = new Audio(notificationSoundPaths[kind]);
    sound.volume = kind === 'question' ? 0.48 : 0.42;
    await sound.play();
    return true;
  } catch {
    recentNotificationSounds.delete(tag);
    return false;
  }
};

// show alerts with durable worktree metadata
const showNotification = async (kind: 'question' | 'finished' | 'system', title: string, body: string, tag: string, url = '/', worktreeId?: string) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const customSoundPlayed = await playNotificationSound(kind, tag);
  const options = { body, tag, icon: '/favicon.svg', badge: '/notification-badge.png', requireInteraction: kind === 'question', silent: customSoundPlayed, data: { url, kind, worktreeId } };
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, options);
    return;
  }
  new Notification(title, options);
};

const dismissNotification = async (tag: string) => {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    (await registration.getNotifications({ tag })).forEach(notification => notification.close());
  } catch { /* Notification access must not interfere with tab navigation. */ }
};

// bind server acknowledgement to the completed turn visible in this snapshot
const dismissAgentNotifications = (agent: Pick<Agent, 'id' | 'worktreeId' | 'completionId'>) => {
  const tags = new Set([agentNotificationTag(agent), `agent-status-${agent.id}`]);
  // close the local notifications associated with this agent
  for (const tag of tags) void dismissNotification(tag);
  void request(`/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completionId: agent.completionId }) });
};

// finish only after a successful clipboard write
const copyText = async (value: string) => {
  // use the async clipboard when available
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  try {
    textarea.select();
    // never report a failed fallback as safe to delete from the source
    if (!document.execCommand('copy')) throw new Error('Clipboard copy failed');
  } finally { textarea.remove(); }
};
const selectionCopyFlashMs = 600;
const voiceHoldDelayMs = 450;

const ServerContext = createContext<ServerInfo | undefined>(undefined);
const ServerStatusContext = createContext<Readonly<Record<string, InstanceAttention>>>({});
const VoiceTriggerContext = createContext<{ open: () => void; active: boolean; visible: boolean; name: string } | undefined>(undefined);
// the dashboard's Projects and their Worktrees, which name a Worktree's stack "<Project> / <Worktree>"
const ProjectsContext = createContext<readonly Project[]>([]);
// whether the server configures an `editor`, which adds the toolbar's Editor button
const EditorConfiguredContext = createContext(false);
// refresh open schedules on dashboard advances and closed badges on queued-note additions
const DashboardGenerationContext = createContext<{ generation?: number; notesRevision?: number; serverStartedAt?: number }>({});
type ServerUpdateState = 'queued' | 'running' | 'complete' | 'failed';
type ServerUpdateAvailability = { available: boolean; commitCount?: number; targetSha?: string };
type ServerRevision = { sha: string; committedAt: string };
type AgentUpdateJob =
  | { id: string; kind: AgentKind; state: 'running' }
  | { id: string; kind: AgentKind; state: 'complete'; agent: AgentUpdateStatus }
  | { id: string; kind: AgentKind; state: 'failed'; error: string };
type ServerUpdateCommit = { sha: string; subject: string; author: string; authoredAt: string };
type ServerUpdateAdvisoryReason = { kind: 'config' | 'compose' | 'runtime' | 'dependency' | 'state' | 'other'; paths: string[] };
type ServerUpdatePreview = { available: boolean; rebuildRetryAvailable: boolean; baseSha: string; targetSha: string; fastForwardable: boolean; commitCount: number; commits: ServerUpdateCommit[]; commitsTruncated: boolean; filesTruncated: boolean; advisory: { required: boolean; reasons: ServerUpdateAdvisoryReason[] }; settingsImpact?: { pendingTargets: Array<'rac' | 'cloudflared'>; warning: string } };
type ClientSettings = {
  deviceName: string;
  serverName: string;
  serverUrl: string;
  clientUpdateAvailable: boolean;
  serverUpdateAvailable: boolean;
  serverUpdateVisible: boolean;
  serverUpdateMinimized: boolean;
  davo: DavoSettings;
  renameClient: (name: string) => Promise<string | undefined>;
  renameServer: (name: string) => Promise<string | undefined>;
  loadServerRevision: () => Promise<ServerRevision | undefined>;
  reloadClient: () => void;
  openServerUpdate: () => void;
  refreshDavo: () => Promise<void>;
  disableDavo: () => Promise<string | undefined>;
  codexAccounts: () => Promise<{ accounts?: CodexAccount[]; error?: string }>;
  claudeAccounts: () => Promise<{ accounts?: CodexAccount[]; error?: string }>;
  switchCodexAccount: (id: string) => Promise<{ account?: CodexAccount; restarts?: CodexAccountRestart[]; error?: string }>;
  renameCodexAccount: (id: string, label: string) => Promise<{ account?: CodexAccount; error?: string }>;
  resetCodexAccount: (id: string) => Promise<{ outcome?: CodexAccountResetOutcome; account?: CodexAccount; error?: string }>;
  addCodexApiKeyAccount: (apiKey: string) => Promise<{ account?: CodexAccount; error?: string }>;
  startCodexAccountLogin: (repairAccountId?: string) => Promise<{ login?: CodexAccountLogin; error?: string }>;
  codexAccountLoginStatus: (id: string) => Promise<CodexAccountLoginStatus | undefined>;
  cancelCodexAccountLogin: (id: string) => Promise<boolean>;
};
const ClientSettingsContext = createContext<ClientSettings | undefined>(undefined);
const legacyDavoSettings: DavoSettings = { enabled: true, available: true, name: 'Davo', context: '' };
// validate one agent kind returned by the settings API
const isAgentKind = (value: unknown): value is AgentKind => (agentKinds as readonly unknown[]).includes(value);
// validate one configured agent update status
const isAgentUpdateStatus = (value: unknown): value is AgentUpdateStatus => value !== null
  && typeof value === 'object'
  && isAgentKind((value as AgentUpdateStatus).kind)
  && ((value as AgentUpdateStatus).currentVersion === undefined || typeof (value as AgentUpdateStatus).currentVersion === 'string')
  && ((value as AgentUpdateStatus).latestVersion === undefined || typeof (value as AgentUpdateStatus).latestVersion === 'string')
  && typeof (value as AgentUpdateStatus).updateAvailable === 'boolean'
  && ((value as AgentUpdateStatus).error === undefined || typeof (value as AgentUpdateStatus).error === 'string');
// validate one background update without trusting its terminal payload
const isAgentUpdateJob = (value: unknown): value is AgentUpdateJob => {
  // require an object before reading the job envelope
  if (value === null || typeof value !== 'object') return false;
  const job = value as { id?: unknown; kind?: unknown; state?: unknown; agent?: unknown; error?: unknown };
  // require an opaque identity and configured agent kind
  if (typeof job.id !== 'string' || job.id.length === 0 || !isAgentKind(job.kind)) return false;
  return job.state === 'running'
    || job.state === 'failed' && typeof job.error === 'string'
    || job.state === 'complete' && isAgentUpdateStatus(job.agent) && job.agent.kind === job.kind;
};
// validate one public voice settings response
const isDavoSettings = (value: unknown): value is DavoSettings => value !== null
  && typeof value === 'object'
  && typeof (value as DavoSettings).enabled === 'boolean'
  && typeof (value as DavoSettings).available === 'boolean'
  && typeof (value as DavoSettings).name === 'string'
  && typeof (value as DavoSettings).context === 'string';
// validate one deployed server revision
const isServerRevision = (value: unknown): value is ServerRevision => value !== null
  && typeof value === 'object'
  && /^[0-9a-f]{40}$/u.test((value as ServerRevision).sha)
  && typeof (value as ServerRevision).committedAt === 'string'
  && !Number.isNaN(Date.parse((value as ServerRevision).committedAt));
// format one server host
const serverHostLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
// validate one upstream availability response
const isServerUpdateAvailability = (value: unknown): value is ServerUpdateAvailability => {
  const candidate = value as Partial<ServerUpdateAvailability> | null;
  const commitCount = candidate?.commitCount;
  const targetSha = candidate?.targetSha;
  return candidate !== null
    && typeof candidate === 'object'
    && typeof candidate.available === 'boolean'
    && (commitCount === undefined || Number.isSafeInteger(commitCount) && commitCount >= 0)
    && (targetSha === undefined || /^[0-9a-f]{40}$/u.test(targetSha));
};
const announcedAgentUpdates = new Map<AgentKind, string>();
// announce each newly discovered agent version once
const announceAgentUpdates = (statuses: AgentUpdateStatus[]) => {
  // inspect every configured updater
  for (const status of statuses) {
    const current = status.currentVersion;
    const latest = status.latestVersion;
    // clear obsolete notifications and fingerprints
    if (!status.updateAvailable || current === undefined || latest === undefined) {
      announcedAgentUpdates.delete(status.kind);
      void dismissNotification(`agent-update-${status.kind}`);
      continue;
    }
    const fingerprint = `${current}->${latest}`;
    // suppress repeat polling alerts
    if (announcedAgentUpdates.get(status.kind) === fingerprint) continue;
    announcedAgentUpdates.set(status.kind, fingerprint);
    void showNotification('system', `${agentKindLabel[status.kind]} update available`, `${current} -> ${latest}`, `agent-update-${status.kind}`, '/#launch');
  }
};
// validate one bounded upstream commit
const isServerUpdateCommit = (value: unknown): value is ServerUpdateCommit => value !== null
  && typeof value === 'object'
  && /^[0-9a-f]{40}$/u.test((value as ServerUpdateCommit).sha)
  && typeof (value as ServerUpdateCommit).subject === 'string'
  && typeof (value as ServerUpdateCommit).author === 'string'
  && typeof (value as ServerUpdateCommit).authoredAt === 'string';
// validate one advisory reason
const isServerUpdateAdvisoryReason = (value: unknown): value is ServerUpdateAdvisoryReason => value !== null
  && typeof value === 'object'
  && ['config', 'compose', 'runtime', 'dependency', 'state', 'other'].includes((value as ServerUpdateAdvisoryReason).kind)
  && Array.isArray((value as ServerUpdateAdvisoryReason).paths)
  && (value as ServerUpdateAdvisoryReason).paths.every(path => typeof path === 'string');
// validate one exact update preview
const isServerUpdatePreview = (value: unknown): value is ServerUpdatePreview => {
  // require one object envelope
  if (value === null || typeof value !== 'object') return false;
  const preview = value as ServerUpdatePreview;
  const advisory = preview.advisory;
  return typeof preview.available === 'boolean'
    && typeof preview.rebuildRetryAvailable === 'boolean'
    && /^[0-9a-f]{40}$/u.test(preview.baseSha)
    && /^[0-9a-f]{40}$/u.test(preview.targetSha)
    && typeof preview.fastForwardable === 'boolean'
    && Number.isSafeInteger(preview.commitCount)
    && Array.isArray(preview.commits)
    && preview.commits.every(isServerUpdateCommit)
    && typeof preview.commitsTruncated === 'boolean'
    && typeof preview.filesTruncated === 'boolean'
    && advisory !== null
    && typeof advisory === 'object'
    && typeof advisory.required === 'boolean'
    && Array.isArray(advisory.reasons)
    && advisory.reasons.every(isServerUpdateAdvisoryReason);
};
// validate one configured icon name
const isInstanceIcon = (value: unknown): value is InstanceIcon => value === 'terminal' || value === 'potato' || value === 'heart';
// validate one server switch target
const isRemoteServer = (value: unknown): value is RemoteServer => value !== null && typeof value === 'object'
  && typeof (value as RemoteServer).name === 'string'
  && typeof (value as RemoteServer).url === 'string'
  && ((value as RemoteServer).icon === undefined || isInstanceIcon((value as RemoteServer).icon))
  && ((value as RemoteServer).defaultName === undefined || typeof (value as RemoteServer).defaultName === 'string')
  && ((value as RemoteServer).defaultIcon === undefined || isInstanceIcon((value as RemoteServer).defaultIcon));
// validate public server metadata
const isServerInfo = (value: unknown): value is ServerInfo => isRemoteServer(value)
  && Array.isArray((value as ServerInfo).remotes)
  && (value as ServerInfo).remotes.every(isRemoteServer);
// validate one instance attention value
const isInstanceAttention = (value: unknown): value is InstanceAttention => value === 'idle' || value === 'working' || value === 'question' || value === 'completed' || value === 'unavailable';
// validate one aggregated instance status
const isInstanceStatus = (value: unknown): value is InstanceStatus => value !== null
  && typeof value === 'object'
  && isRemoteServer(value)
  && isInstanceAttention((value as InstanceStatus).attention);
// validate one published instance snapshot
const serverStatusesFrom = (value: unknown): { attention: Record<string, InstanceAttention>; servers: InstanceStatus[] } | undefined => {
  // require the aggregate response envelope
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { servers?: unknown }).servers)) return undefined;
  const servers = (value as { servers: unknown[] }).servers;
  // reject partial or malformed lists
  if (!servers.every(isInstanceStatus)) return undefined;
  const published = servers as InstanceStatus[];
  return { attention: Object.fromEntries(published.map(status => [status.url, status.attention])), servers: published };
};
// compare sanitized status maps without rerendering unchanged state
const sameServerStatuses = (left: Readonly<Record<string, InstanceAttention>>, right: Readonly<Record<string, InstanceAttention>>): boolean => {
  const leftEntries = Object.entries(left);
  // require the same keys and attention values
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([url, attention]) => right[url] === attention);
};
// provide backward-compatible identity while older servers update
const fallbackServerInfo = (): ServerInfo => ({ name: 'Remote Agents', url: location.origin, remotes: [] });
// resolve bundled server artwork
const serverIconPath = (icon: InstanceIcon | undefined): string => `/instance-icons/${icon ?? 'terminal'}.svg`;
// describe one server attention marker
const instanceAttentionLabel = (attention: InstanceAttention): string | undefined => {
  // map only visible attention states
  switch (attention) {
    case 'idle': return 'Idle';
    case 'question': return 'Active question';
    case 'working': return 'Working';
    case 'completed': return 'Completed notification';
    case 'unavailable': return 'Server unavailable';
    default: return undefined;
  }
};

// validate one optional unsigned integer
const isOptionalUnsignedInteger = (value: unknown): boolean => value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
// validate one provider limit window
const isCodexLimitWindow = (value: unknown): value is CodexLimitWindow => value !== null
  && typeof value === 'object'
  && Number.isFinite((value as CodexLimitWindow).usedPercent)
  && (value as CodexLimitWindow).usedPercent >= 0
  && (value as CodexLimitWindow).usedPercent <= 100
  && isOptionalUnsignedInteger((value as CodexLimitWindow).windowDurationMins)
  && isOptionalUnsignedInteger((value as CodexLimitWindow).resetsAt);
// validate exact provider spend without accepting partial totals
const isApiKeySpend = (value: unknown): value is ApiKeySpend => {
  // require one object result
  if (value === null || typeof value !== 'object') return false;
  const spend = value as { status?: unknown; todayUsd?: unknown; weekUsd?: unknown; asOf?: unknown };
  // accept explicit missing-data states
  if (spend.status === 'unconfigured' || spend.status === 'unavailable') return true;
  return spend.status === 'available' && typeof spend.todayUsd === 'number' && Number.isFinite(spend.todayUsd)
    && typeof spend.weekUsd === 'number' && Number.isFinite(spend.weekUsd)
    && typeof spend.asOf === 'number' && Number.isSafeInteger(spend.asOf) && spend.asOf >= 0;
};
// validate one safe account summary
const isCodexAccount = (value: unknown): value is CodexAccount => value !== null
  && typeof value === 'object'
  && typeof (value as CodexAccount).id === 'string'
  && typeof (value as CodexAccount).label === 'string'
  && typeof (value as CodexAccount).active === 'boolean'
  && ((value as CodexAccount).authMode === undefined || (value as CodexAccount).authMode === 'apikey')
  && ((value as CodexAccount).spend === undefined || isApiKeySpend((value as CodexAccount).spend))
  && ((value as CodexAccount).email === undefined || typeof (value as CodexAccount).email === 'string')
  && ((value as CodexAccount).planType === undefined || typeof (value as CodexAccount).planType === 'string')
  && ((value as CodexAccount).primary === undefined || isCodexLimitWindow((value as CodexAccount).primary))
  && ((value as CodexAccount).secondary === undefined || isCodexLimitWindow((value as CodexAccount).secondary))
  && isOptionalUnsignedInteger((value as CodexAccount).resetCount)
  && ((value as CodexAccount).error === undefined || typeof (value as CodexAccount).error === 'string');
// validate one reset-credit outcome
const isCodexAccountResetOutcome = (value: unknown): value is CodexAccountResetOutcome => value === 'reset' || value === 'nothingToReset' || value === 'noCredit' || value === 'alreadyRedeemed';
// validate one account restart result
const isCodexAccountRestart = (value: unknown): value is CodexAccountRestart => value !== null
  && typeof value === 'object'
  && typeof (value as CodexAccountRestart).worktreeId === 'string'
  && ['restarted', 'skipped', 'failed'].includes((value as CodexAccountRestart).status)
  && ((value as CodexAccountRestart).error === undefined || typeof (value as CodexAccountRestart).error === 'string');
// validate one device-code login response
const isCodexAccountLogin = (value: unknown): value is CodexAccountLogin => {
  // require the exact public fields
  if (value === null || typeof value !== 'object' || typeof (value as CodexAccountLogin).loginId !== 'string' || typeof (value as CodexAccountLogin).userCode !== 'string' || typeof (value as CodexAccountLogin).verificationUrl !== 'string') return false;
  try {
    return new URL((value as CodexAccountLogin).verificationUrl).protocol === 'https:';
  } catch {
    return false;
  }
};
// label one provider plan
const codexPlanLabel = (plan: string | undefined): string | undefined => plan === undefined ? undefined : plan.replaceAll('_', ' ').replace(/\b\w/gu, letter => letter.toUpperCase());
// hide generated slot suffixes without changing custom names
const codexAccountName = (account: Pick<CodexAccount, 'id' | 'label' | 'authMode'>): string => account.authMode === 'apikey' && account.label === `API key (${account.id})` ? 'API key' : account.label;
// load one agent's sanitized account list
const loadAccounts = async (path: string, fallbackError: string): Promise<{ accounts?: CodexAccount[]; error?: string }> => {
  const response = await request(path);
  const payload = await response.json().catch(() => undefined) as { accounts?: unknown; error?: unknown } | undefined;
  // require one sanitized account list
  if (!response.ok || !Array.isArray(payload?.accounts) || !payload.accounts.every(isCodexAccount)) return { error: typeof payload?.error === 'string' ? payload.error : fallbackError };
  return { accounts: payload.accounts };
};
// load the signed-in Claude account and its usage
const loadClaudeAccounts = () => loadAccounts('/api/claude/accounts', 'Unable to load Claude usage.');
// retain cents in compact dollar totals
const usdSpend = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
// show dollars only after a successful billing query
function ApiKeySpendSummary({ spend, now }: { spend: ApiKeySpend | undefined; now: number }) {
  const stale = spend?.status === 'available' && Math.floor(spend.asOf / 86_400) !== Math.floor(now / 86_400_000);
  const available = spend?.status === 'available' && !stale;
  const today = available ? usdSpend.format(spend.todayUsd) : 'Unavailable';
  const week = available ? usdSpend.format(spend.weekUsd) : 'Unavailable';
  let detail = 'Billing totals unavailable. Reopen settings to refresh.';
  // label only the state established by the billing response
  if (available) detail = `As of ${new Date(spend.asOf * 1_000).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
  else if (stale) detail = 'Previous-day totals hidden. Reopen settings to refresh.';
  else if (spend?.status === 'unavailable') detail = 'Billing query failed. Reopen settings to retry.';
  else if (spend?.status === 'unconfigured') detail = 'OpenAI billing is not configured for this key.';
  return <><span className="api-key-spend"><span><small>Spent today</small><strong>{today}</strong></span><span><small>Spent this week</small><strong>{week}</strong></span></span><small className="api-key-spend-detail">{detail}</small></>;
}
// label one limit duration
const codexLimitDuration = (minutes: number | undefined): string => {
  // prefer whole days
  if (minutes !== undefined && minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  // prefer whole hours
  if (minutes !== undefined && minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes === undefined ? 'Limit' : `${minutes}m`;
};
// format one live reset countdown
const codexResetCountdown = (timestamp: number | undefined, now: number): string | undefined => {
  // omit unavailable reset times
  if (timestamp === undefined) return undefined;
  const totalSeconds = Math.max(0, Math.ceil(timestamp - now / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds % 86_400 / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
};
// render one account limit meter
function CodexLimitUsage({ window, now }: { window: CodexLimitWindow; now: number }) {
  const duration = codexLimitDuration(window.windowDurationMins);
  const countdown = codexResetCountdown(window.resetsAt, now);
  return <span className={`chatgpt-limit${window.usedPercent >= 100 ? ' at-limit' : ''}`}><span className="chatgpt-limit-heading"><small>{duration} limit</small><small>{window.usedPercent}% consumed</small></span><progress aria-label={`${duration} limit consumed`} max={100} value={window.usedPercent}>{window.usedPercent}%</progress>{countdown !== undefined && <small className="chatgpt-limit-reset">Resets in {countdown}</small>}</span>;
}
// render one account's name, plan, usage, and error
function AccountCopy({ account, now }: { account: CodexAccount; now: number }) {
  // identify api keys instead of showing a subscription plan
  const plan = account.authMode === 'apikey' ? 'API Key' : codexPlanLabel(account.planType);
  const details = (account.authMode === 'apikey' ? [] : [account.primary, account.secondary]).filter((window): window is CodexLimitWindow => window !== undefined);
  const name = codexAccountName(account);
  return <span className="chatgpt-account-copy"><strong title={name}>{name}{plan === undefined ? '' : ` (${plan})`}</strong>{account.email !== undefined && account.email !== account.label && <small>{account.email}</small>}{account.authMode === 'apikey' && <ApiKeySpendSummary spend={account.spend} now={now} />}{details.map((window, index) => <CodexLimitUsage key={`${account.id}:${index}`} window={window} now={now} />)}{account.authMode !== 'apikey' && account.resetCount !== undefined && account.resetCount > 0 && <small>{account.resetCount} {account.resetCount === 1 ? 'reset' : 'resets'} available</small>}{account.error !== undefined && <small className="chatgpt-account-error">{account.error}</small>}</span>;
}

const updateAdvisoryLabels: Record<ServerUpdateAdvisoryReason['kind'], string> = { config: 'Configuration', compose: 'Compose', runtime: 'Host runtime', dependency: 'Dependencies', state: 'Persisted state', other: 'Other changes' };
// format one commit timestamp
const updateCommitDate = (value: string): string => {
  const date = new Date(value);
  // preserve malformed server values visibly
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

// render one isolated full advisor output
function EmbeddedAgentOutput({ id, onMetadata }: { id: string; onMetadata: (response: string | undefined, question: ChoiceQuestion | undefined) => void }) {
  const onMetadataRef = useRef(onMetadata);
  const responseRef = useRef<string | undefined>(undefined);
  const questionRef = useRef<ChoiceQuestion | undefined>(undefined);
  onMetadataRef.current = onMetadata;
  // publish one complete response
  const publishResponse = useCallback((response: string | undefined) => {
    responseRef.current = response;
    onMetadataRef.current(response, questionRef.current);
  }, []);
  // publish one inferred question
  const publishQuestion = useCallback((question: ChoiceQuestion | undefined) => {
    questionRef.current = question;
    onMetadataRef.current(responseRef.current, question);
  }, []);
  return <div className="update-advisor-output" aria-label="Update advisor output"><section className="log-shell embedded-log-shell"><div className="log embedded-log"><ResizableLogSplit output={<Log id={id} onQuestion={publishQuestion} onMetadata={publishResponse} codexScrollControls embedded />} /></div></section><MobileTerminalKeys id={id} /></div>;
}

// review and launch one exact server update
function ServerUpdateDialog({ open, minimized, onMinimize, onClose }: { open: boolean; minimized: boolean; onMinimize: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<ServerUpdatePreview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updateId, setUpdateId] = useState<string>();
  const [updateState, setUpdateState] = useState<ServerUpdateState>();
  const [updateSubmitting, setUpdateSubmitting] = useState(false);
  const [advisorId, setAdvisorId] = useState<string>();
  const [advisorState, setAdvisorState] = useState<AgentState>();
  const [advisorQuestion, setAdvisorQuestion] = useState<ChoiceQuestion>();
  const [inferredQuestion, setInferredQuestion] = useState<ChoiceQuestion>();
  const [advisorResponse, setAdvisorResponse] = useState<string>();
  const [advisorResponsePending, setAdvisorResponsePending] = useState(false);
  const advisorResponseBaseline = useRef<string | undefined>(undefined);
  const answeredAdvisorQuestions = useRef(new Set<string>());
  const [advisorError, setAdvisorError] = useState('');
  const [advisorAcknowledged, setAdvisorAcknowledged] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  // suppress answered questions without hiding the next approval request
  const visibleQuestion = [advisorQuestion, inferredQuestion].find(question => question !== undefined && !answeredAdvisorQuestions.current.has(question.id));
  const staleQuestionPending = advisorState === 'action-required' && visibleQuestion === undefined && (advisorQuestion !== undefined || inferredQuestion !== undefined);
  const advisorNeedsInput = visibleQuestion !== undefined || advisorState === 'action-required' && !staleQuestionPending;
  const feedbackBlocked = feedbackPending || staleQuestionPending || !advisorNeedsInput && (advisorResponsePending || advisorResponse === undefined);
  const updating = updateSubmitting || updateState === 'queued' || updateState === 'running';
  // allow identical questions after both transports clear the previous occurrence
  useEffect(() => {
    // preserve dismissal while either source still reports an answered question
    if (advisorQuestion !== undefined || inferredQuestion !== undefined) return;
    answeredAdvisorQuestions.current.clear();
  }, [advisorQuestion, inferredQuestion]);
  // reconcile responses that can arrive before the send request completes
  useEffect(() => {
    // require fresh guidance after the acknowledged submission
    if (!advisorResponsePending || advisorResponse === undefined || advisorResponse === advisorResponseBaseline.current) return;
    setAdvisorResponsePending(false);
  }, [advisorResponse, advisorResponsePending]);
  // focus the update surface when restored
  useEffect(() => { if (open && !minimized) dialog.current?.focus(); }, [minimized, open]);
  // load one fresh preview and advisor
  useEffect(() => {
    // stop hidden preview work
    if (!open) return;
    let active = true;
    setPreview(undefined);
    setLoading(true);
    setError('');
    setUpdateId(undefined);
    setUpdateState(undefined);
    setUpdateSubmitting(false);
    setAdvisorId(undefined);
    setAdvisorState(undefined);
    setAdvisorQuestion(undefined);
    setInferredQuestion(undefined);
    setAdvisorResponse(undefined);
    setAdvisorResponsePending(false);
    advisorResponseBaseline.current = undefined;
    answeredAdvisorQuestions.current.clear();
    setAdvisorError('');
    setAdvisorAcknowledged(false);
    setFeedback('');
    setFeedbackMessage('');
    // resolve the exact current range
    const load = async () => {
      const response = await request('/api/server/update-preview');
      const payload: unknown = await response.json().catch(() => undefined);
      // retain a visible preview failure
      if (!response.ok || !isServerUpdatePreview(payload)) {
        if (active) {
          setLoading(false);
          setError('Unable to load the pending update.');
        }
        return;
      }
      if (!active) return;
      setPreview(payload);
      setLoading(false);
      // launch advice only for conservatively flagged ranges
      if (!payload.available || !payload.advisory.required) return;
      const advisorResponse = await request('/api/server/update-advisor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetSha: payload.targetSha }) });
      const advisorPayload = await advisorResponse.json().catch(() => undefined) as { agentId?: unknown; error?: unknown } | undefined;
      // retain advisor launch failures without losing the commit review
      if (!active) return;
      if (!advisorResponse.ok || typeof advisorPayload?.agentId !== 'string') {
        setAdvisorError(typeof advisorPayload?.error === 'string' ? advisorPayload.error : 'Unable to start the update advisor.');
        return;
      }
      setAdvisorId(advisorPayload.agentId);
    };
    void load();
    return () => { active = false; };
  }, [open]);
  // follow advisor state and structured questions
  useEffect(() => {
    // require one launched advisor
    if (!open || advisorId === undefined) return;
    let active = true;
    const refresh = async () => {
      const response = await request('/api/dashboard', undefined, false);
      const payload: unknown = await response.json().catch(() => undefined);
      // retain the last good advisor state
      if (!active || !response.ok || !isDashboard(payload)) return;
      const agent = payload.agents.find(candidate => candidate.id === advisorId);
      // report vanished advisor sessions
      if (agent === undefined) {
        setAdvisorError('The update advisor is no longer available.');
        return;
      }
      setAdvisorState(agentState(agent));
      setAdvisorQuestion(agent.question === undefined ? undefined : choiceQuestionFromInline(agent.question));
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [advisorId, open]);
  // follow one update across the expected restart
  useEffect(() => {
    // require one active operation
    if (!open || updateId === undefined || updateState === 'complete' || updateState === 'failed') return;
    let active = true;
    const poll = async () => {
      const response = await request(`/api/server/update/${encodeURIComponent(updateId)}`);
      // tolerate the rebuild outage
      if (!active || !response.ok) return;
      const payload = await response.json().catch(() => undefined) as { state?: unknown } | undefined;
      // accept one canonical lifecycle state
      if (payload?.state === 'queued' || payload?.state === 'running' || payload?.state === 'complete' || payload?.state === 'failed') setUpdateState(payload.state);
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [open, updateId, updateState]);
  // answer one advisor choice or free-form question
  const answerAdvisor = async (selection: number | string) => {
    // require one current question
    if (advisorId === undefined || visibleQuestion === undefined || feedbackPending) return;
    setFeedbackPending(true);
    setFeedbackMessage('');
    // every inline question — structured or parsed — answers through one endpoint
    const response = await request(`/api/agents/${encodeURIComponent(advisorId)}/question`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: visibleQuestion.id, ...(typeof selection === 'number' ? { index: selection } : { text: selection }) }) });
    setFeedbackPending(false);
    // retain rejected answers
    if (!response.ok) {
      setFeedbackMessage('Unable to answer the advisor question.');
      return;
    }
    // require review of the advisor's next response
    answeredAdvisorQuestions.current.add(visibleQuestion.id);
    advisorResponseBaseline.current = advisorResponse;
    setAdvisorResponsePending(true);
    setAdvisorState('working');
    setAdvisorAcknowledged(false);
    // clear only the submitted text answer
    if (typeof selection === 'string') setFeedback(current => current.trim() === selection ? '' : current);
  };
  // send direct terminal input for free-form question feedback through the advisor's own
  // Pane stream: the embedded advisor terminal registers its pane input under `advisorId`
  const sendAdvisorInput = (value: string): boolean => {
    const send = advisorId === undefined ? undefined : terminalInputs.get(advisorId);
    // require one mounted advisor pane whose stream is connected (not mid-reconnect)
    if (send === undefined) return false;
    return send(`${value}\r`);
  };
  // submit one advisor follow-up
  const submitFeedback = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = feedback.trim();
    // prevent empty or duplicate feedback
    if (!value || advisorId === undefined || feedbackBlocked) return;
    // answer an open question instead of queueing behind the blocked turn
    if (visibleQuestion !== undefined) {
      await answerAdvisor(value);
      return;
    }
    setFeedbackPending(true);
    setFeedbackMessage('');
    const directInput = advisorNeedsInput && visibleQuestion === undefined;
    const sent = directInput
      ? sendAdvisorInput(value)
      : (await request(`/api/agents/${encodeURIComponent(advisorId)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value, attachments: [] }) })).ok;
    setFeedbackPending(false);
    // retain failed feedback
    if (!sent) {
      setFeedbackMessage('Unable to send feedback to the advisor.');
      return;
    }
    // require review of the advisor's follow-up response
    advisorResponseBaseline.current = advisorResponse;
    setAdvisorResponsePending(true);
    setAdvisorState('working');
    setAdvisorAcknowledged(false);
    setFeedback('');
    setFeedbackMessage(directInput ? 'Feedback sent.' : 'Feedback queued.');
  };
  // reveal questions independently of completed assistant responses
  const advisorMetadata = (response: string | undefined, question: ChoiceQuestion | undefined) => {
    setInferredQuestion(question);
    setAdvisorResponse(response);
  };
  // start one pinned host update
  const startUpdate = async () => {
    // require one current preview
    if (preview === undefined || updating) return;
    setError('');
    setUpdateSubmitting(true);
    const response = await request('/api/server/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedTargetSha: preview.targetSha, advisoryAcknowledged: advisorAcknowledged }) });
    const payload = await response.json().catch(() => undefined) as { id?: unknown; state?: unknown; error?: unknown } | undefined;
    // retain launch or stale-preview failures
    if (!response.ok || typeof payload?.id !== 'string') {
      setUpdateSubmitting(false);
      setError(typeof payload?.error === 'string' ? payload.error : 'Unable to start the server update.');
      return;
    }
    setUpdateId(payload.id);
    setUpdateState(payload.state === 'running' ? 'running' : 'queued');
    setUpdateSubmitting(false);
  };
  // close the modal and stop its dedicated advisor
  const closeDialog = () => {
    // preserve the advisor throughout an active host update
    if (updating) return;
    const targetSha = preview?.targetSha;
    onClose();
    // serialize server cleanup behind any in-flight advisor launch
    if (targetSha !== undefined) void request('/api/server/update-advisor', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetSha }) });
  };
  // contain keyboard focus inside the modal
  const dialogKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // minimize active updates on escape
    if (event.key === 'Escape') { updating ? onMinimize() : closeDialog(); return; }
    // retain ordinary keys
    if (event.key !== 'Tab' || dialog.current === null) return;
    const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter(control => control.offsetParent !== null);
    // retain focus when no controls exist
    if (controls.length === 0) { event.preventDefault(); dialog.current.focus(); return; }
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? controls.indexOf(active) : -1;
    let next = index + 1;
    // wrap backward focus
    if (event.shiftKey) next = index <= 0 ? controls.length - 1 : index - 1;
    // wrap forward focus
    else if (index < 0 || index === controls.length - 1) next = 0;
    event.preventDefault();
    controls.at(next)?.focus();
  };
  // keep update polling alive while hidden
  if (!open || minimized) return null;
  const adviceReady = !advisorError && advisorResponse !== undefined && !advisorResponsePending && !feedbackPending && advisorState === 'prompt-done' && visibleQuestion === undefined;
  // advertise readiness only when the acknowledgement is available
  const advisorDisplayState = advisorNeedsInput ? 'action-required' : adviceReady ? 'prompt-done' : advisorId === undefined ? 'starting' : 'working';
  const advisorBusy = advisorDisplayState === 'starting' || advisorDisplayState === 'working';
  const updateBlocked = preview === undefined || !preview.available && !preview.rebuildRetryAvailable || !preview.fastForwardable || updating || updateState === 'complete' || preview.advisory.required && (!adviceReady || !advisorAcknowledged);
  let body: ReactNode;
  // render preview loading
  if (loading) {
    body = <div className="update-review-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Fetching commits from origin/main…</div>;
  // render preview failure
  } else if (preview === undefined) {
    body = <div className="update-review-loading error" role="alert">{error || 'Update preview unavailable.'}</div>;
  // render a durable rebuild retry
  } else if (preview.rebuildRetryAvailable) {
    body = <div className="update-review-loading"><strong>Host rebuild needs another attempt.</strong><span>Git reached {preview.targetSha.slice(0, 7)}, but the last Compose rebuild failed.</span></div>;
  // render current state
  } else if (!preview.available) {
    body = <div className="update-review-loading"><strong>Server is current.</strong><span>No upstream commits are waiting.</span></div>;
  // render the exact pending range
  } else {
    body = <div className="update-review-body"><section className="update-review-summary"><div><small>{preview.baseSha.slice(0, 7)}</small><span aria-hidden="true">→</span><strong>{preview.targetSha.slice(0, 7)}</strong></div><span>{preview.commitCount} new {preview.commitCount === 1 ? 'commit' : 'commits'}{preview.commitsTruncated ? ` · showing ${preview.commits.length}` : ''}</span></section>{!preview.fastForwardable && <p className="update-review-warning" role="alert">Local main cannot be fast-forwarded to this update. Resolve the checkout manually before updating.</p>}{preview.settingsImpact !== undefined && <p className="update-review-warning" role="alert">{preview.settingsImpact.warning}</p>}<ol className="update-commit-list" aria-label="Pending commits">{preview.commits.map(commit => <li key={commit.sha}><code>{commit.sha.slice(0, 7)}</code><span><strong>{commit.subject}</strong><small>{commit.author} · {updateCommitDate(commit.authoredAt)}</small></span></li>)}</ol>{preview.advisory.required && <section className="update-advisor"><header><div><small>UPDATE ADVISOR</small><h3>Host changes need review</h3></div><span className={`update-advisor-state ${advisorDisplayState}${progressBorder(advisorBusy, 'mauve')}`} aria-busy={advisorBusy || undefined}><ProgressRing busy={advisorBusy} />{advisorError ? 'Unavailable' : advisorDisplayState === 'action-required' ? 'Needs input' : adviceReady ? 'Ready' : advisorId === undefined ? 'Starting' : 'Reviewing'}</span></header><p>The changed paths below may require host-local actions. The advisor inspects the exact commit range without modifying it.</p><div className="update-advisory-reasons">{preview.advisory.reasons.map(reason => <div key={reason.kind}><strong>{updateAdvisoryLabels[reason.kind]}</strong>{reason.paths.length === 0 ? <span>Manual Git reconciliation required</span> : reason.paths.map(path => <code key={path}>{path}</code>)}</div>)}</div>{preview.filesTruncated && <small className="update-review-warning">Changed-path review was truncated; the advisor will inspect the complete Git range.</small>}{advisorError ? <div className="update-advisor-error" role="alert">{advisorError}</div> : advisorId === undefined ? <div className="update-advisor-launching progress-border progress-mauve" role="status" aria-busy="true"><ProgressRing busy />Starting a dedicated advisor…</div> : <><EmbeddedAgentOutput id={advisorId} onMetadata={advisorMetadata} />{visibleQuestion !== undefined && <div className="update-advisor-question"><strong>{visibleQuestion.text}</strong><div>{visibleQuestion.choices.map(choice => <button type="button" key={`${choice.answerIndex}-${choice.label}`} disabled={feedbackPending} onClick={() => void answerAdvisor(choice.answerIndex)}><b>{choice.number}</b><span>{choice.label}</span></button>)}</div></div>}<form className="update-advisor-feedback" onSubmit={event => void submitFeedback(event)}><label>Approval or feedback<textarea value={feedback} maxLength={32_000} disabled={feedbackBlocked} placeholder={advisorNeedsInput ? 'Reply to the advisor…' : advisorResponsePending || advisorResponse === undefined ? 'Waiting for the advisor response…' : 'Queue a follow-up for the advisor…'} onFocus={() => { /* leave terminal input */ if (advisorId !== undefined) exitTerminalInput.get(advisorId)?.(); }} onChange={event => setFeedback(event.target.value)} /></label><button type="submit" className={feedbackPending ? 'progress-border progress-blue' : undefined} aria-busy={feedbackPending || undefined} disabled={feedbackBlocked || !feedback.trim()}><ProgressRing busy={feedbackPending} />{feedbackPending ? 'Sending…' : 'Send'}</button></form>{feedbackMessage && <small className="update-advisor-feedback-status" role="status">{feedbackMessage}</small>}{adviceReady && <label className="update-advisor-acknowledgement"><input type="checkbox" checked={advisorAcknowledged} onChange={event => setAdvisorAcknowledged(event.target.checked)} /><span>I reviewed the advisor guidance for this exact update.</span></label>}</>}</section>}</div>;
  }
  const progress = updateState === undefined ? null : <div className={`update-review-progress ${updateState}${progressBorder(updateState === 'queued' || updateState === 'running', 'mauve')}`} role="status" aria-busy={updateState === 'queued' || updateState === 'running' || undefined}><ProgressRing busy={updateState === 'queued' || updateState === 'running'} />{updateState === 'failed' ? <span>Update failed. Check the server update log.</span> : updateState === 'complete' ? <><strong>Update complete.</strong><button type="button" onClick={() => location.reload()}>Reload</button></> : <span>{updateState === 'queued' ? 'Waiting for the host…' : 'Pulling the reviewed revision, rebuilding, and restarting…'}</span>}</div>;
  return createPortal(<div ref={dialog} className="dialog server-update-dialog" role="dialog" aria-modal="true" aria-labelledby="server-update-review-title" tabIndex={-1} onKeyDown={dialogKey}><div><header><div><small>SERVER UPDATE</small><h2 id="server-update-review-title">Review update</h2></div><span className="server-update-controls"><button type="button" aria-label="Minimize server update" title="Minimize" onClick={onMinimize}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button><button type="button" aria-label="Close server update" title="Close" disabled={updating} onClick={closeDialog}><PanelIcon path={panelIcons.close} /></button></span></header>{body}{error && preview !== undefined && <p className="update-review-error" role="alert">{error}</p>}{progress}<footer><span>{preview?.advisory.required && !advisorAcknowledged ? 'Advisor acknowledgement required' : preview?.fastForwardable === false ? 'Manual Git reconciliation required' : preview?.rebuildRetryAvailable ? 'Retry the failed host rebuild.' : 'The update will rebuild this host only.'}</span><button type="button" className={updating ? 'progress-border progress-mauve' : undefined} aria-busy={updating || undefined} disabled={updateBlocked} onClick={() => void startUpdate()}><ProgressRing busy={updating} />{updating ? 'Updating…' : preview?.rebuildRetryAvailable ? 'Retry rebuild' : 'Update'}</button></footer></div></div>, document.body);
}

// share the global settings panel with the active workspace split and tab trigger
const ClientSettingsSplitContext = createContext<{ open: boolean; page: ReactNode; trigger: ReactNode; close: () => Promise<boolean>; renameServer: () => void } | null>(null);

// keep global notices below any visible settings toolbar with file actions
const syncSettingsToastClearance = () => {
  let clearance = 0;
  // ignore offscreen carousel panels and settings hidden by another dialog
  for (const header of Array.from(document.querySelectorAll<HTMLElement>('.settings-center-page:not([aria-hidden="true"]):not([inert]) > .panel-header:has(.settings-header-actions > button)'))) {
    const bounds = header.getBoundingClientRect();
    // reserve only toolbar geometry that intersects this browser viewport
    if (bounds.width > 0 && bounds.right > 0 && bounds.left < window.innerWidth && bounds.bottom > 0 && bounds.top < window.innerHeight) clearance = Math.max(clearance, Math.ceil(bounds.bottom + 8));
  }
  const root = document.documentElement;
  const next = `${clearance}px`;
  // avoid feedback when measuring unchanged header geometry
  if (root.style.getPropertyValue('--settings-header-toast-clearance') === next) return;
  root.style.setProperty('--settings-header-toast-clearance', next);
};

// apply split expansion inside the owning workspace context
function ClientSettingsPage({ panelRef, busy, hidden, onKeyDown, onClose, children }: { panelRef: React.RefObject<HTMLDivElement | null>; busy: boolean; hidden: boolean; onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void; onClose: () => void; children: ReactNode }) {
  const expanded = usePanelExpand('settings')?.expanded === true;
  const [actionsTarget, setActionsTarget] = useState<HTMLSpanElement | null>(null);
  // keep scrollable content below header actions when a narrow split wraps
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const header = actionsTarget?.closest<HTMLElement>('.panel-header');
    // wait for the existing toolbar's mount target
    if (panel === null || header == null) return;
    // measure only the header rather than changing any split geometry
    const measure = () => {
      panel.style.setProperty('--settings-header-clearance', `${Math.ceil(header.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 6)}px`);
      syncSettingsToastClearance();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(panel);
    // action width can change even while the outer header remains one row
    if (actionsTarget?.parentElement !== null && actionsTarget?.parentElement !== undefined) observer.observe(actionsTarget.parentElement);
    const intersection = new IntersectionObserver(measure);
    intersection.observe(header);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); intersection.disconnect(); window.removeEventListener('resize', measure); requestAnimationFrame(syncSettingsToastClearance); };
  }, [actionsTarget, hidden, panelRef]);
  // restore expansion before allowing escape to close the split
  const panelKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && expanded) return;
    onKeyDown(event);
  };
  return <SettingsHeaderActionsContext.Provider value={actionsTarget}><div ref={panelRef} id="global-settings-page" className={`client-settings-page settings-center-page${expanded ? ' expanded' : ''}${progressBorder(busy, 'blue')}`} role="dialog" aria-hidden={hidden || undefined} inert={hidden} aria-labelledby="global-settings-title" aria-busy={busy || undefined} tabIndex={-1} onKeyDown={panelKey}><ProgressRing busy={busy} /><PanelHeader panelKey="settings" label="settings" title={<h1 id="global-settings-title">Settings</h1>} actions={<span ref={setActionsTarget} className="settings-header-actions" />} close={{ key: 'close', label: 'Close settings', icon: <PanelIcon path={panelIcons.close} />, onSelect: onClose }} /><div className="client-settings-page-content">{children}</div></div></SettingsHeaderActionsContext.Provider>;
}

// scope split visibility while retaining one shared settings transaction
function ClientSettingsLayout({ settings, workspaceKey, children, onOperationFeedback }: { settings: ClientSettings; workspaceKey: string; children: ReactNode; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const serverIdentity = useContext(ServerContext);
  const adapters = useContext(AdaptersContext);
  // Codex account management is available only when adapters.codex is configured
  const codexConfigured = adapters?.codex?.program !== undefined;
  const claudeConfigured = adapters?.claude?.program !== undefined;
  // observe the same optional persistence used by other workspace controls
  useWorkspaceViewRevision();
  const open = settingsSplitOpen(workspaceKey);
  const setOpen = useCallback((next: boolean) => setSettingsSplitOpen(workspaceKey, next), [workspaceKey]);
  const currentWorkspace = useRef(workspaceKey);
  currentWorkspace.current = workspaceKey;
  const settingsSession = useSettingsSession();
  const [requestedSection, setRequestedSection] = useState<{ id: string; request: number; workspaceKey: string }>();
  const [accountsVisible, setAccountsVisible] = useState(false);
  const [dialog, setDialog] = useState<'server' | 'account-login' | 'account-rename'>();
  const [name, setName] = useState(settings.serverName);
  const [renamingAccount, setRenamingAccount] = useState<CodexAccount>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [switchingAccountId, setSwitchingAccountId] = useState<string>();
  const [resettingAccountId, setResettingAccountId] = useState<string>();
  const [accountMessage, setAccountMessage] = useState('');
  const [claudeAccounts, setClaudeAccounts] = useState<CodexAccount[]>([]);
  const [claudeAccountMessage, setClaudeAccountMessage] = useState('');
  // clear stale feedback when opening an account-aware launcher
  const showAccounts = useCallback(() => { setAccountMessage(''); setAccountsVisible(true); }, []);
  // stop account polling when the launcher closes
  const hideAccounts = useCallback(() => setAccountsVisible(false), []);
  const [accountClock, setAccountClock] = useState(() => Date.now());
  const accountDay = Math.floor(accountClock / 86_400_000);
  const [accountLogin, setAccountLogin] = useState<CodexAccountLogin>();
  const [accountLoginTarget, setAccountLoginTarget] = useState<{ email: string }>();
  const [accountLoginState, setAccountLoginState] = useState<'idle' | 'pending' | 'failed'>('pending');
  const [accountApiKey, setAccountApiKey] = useState('');
  const [accountApiKeyError, setAccountApiKeyError] = useState('');
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const accountLoginRequest = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const settingsCloseGuard = useRef<SettingsCloseGuard>(null);
  const pendingSettingsClose = useRef(new Map<string, Promise<boolean>>());
  // honor settings links while the authenticated workspace stays mounted
  useEffect(() => {
    // reopen the panel without disturbing unrelated hash destinations
    const openFromHash = () => {
      // accept only the settings destination
      if (location.hash === '#settings') setSettingsSplitOpen(currentWorkspace.current, true);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, []);
  // retain keyboard navigation requests even when the settings split is closed
  useEffect(() => {
    // stage navigation without changing the saved keyboard configuration
    const openShortcuts = () => {
      const owner = currentWorkspace.current;
      setRequestedSection(current => ({ id: 'keyboard', request: (current?.request ?? 0) + 1, workspaceKey: owner }));
      setSettingsSplitOpen(owner, true);
    };
    window.addEventListener(shortcutSettingsNavigationEvent, openShortcuts);
    return () => window.removeEventListener(shortcutSettingsNavigationEvent, openShortcuts);
  }, []);
  // consume a navigation request only after the target section accepts it
  const consumeSettingsSection = useCallback((request: number) => {
    setRequestedSection(current => current?.request === request && current.workspaceKey === workspaceKey ? undefined : current);
  }, [workspaceKey]);
  // return server rename focus to its selector after the dialog closes
  useEffect(() => {
    if (dialog !== 'server') return;
    return () => { window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.server-selector')?.focus()); };
  }, [dialog]);
  // move focus into the page and restore the trigger on close
  useEffect(() => {
    // skip focus work while the page is closed
    if (!open) return;
    const trigger = triggerRef.current;
    pageRef.current?.focus();
    return () => trigger?.focus();
  }, [open]);
  // refresh accounts when their launcher opens and at utc day rollover
  useEffect(() => {
    // skip hidden launchers and consoles without a configured Codex adapter
    if (!accountsVisible || !codexConfigured) return;
    let active = true;
    setAccountsLoading(true);
    void settings.codexAccounts().then(result => {
      // ignore closed-launcher responses
      if (!active) return;
      setAccountsLoading(false);
      // retain the last good list on failure
      if (result.accounts === undefined) {
        setAccountMessage(result.error ?? 'Unable to load ChatGPT accounts.');
        return;
      }
      setAccounts(result.accounts);
    });
    return () => { active = false; };
  }, [accountsVisible, codexConfigured, settings.codexAccounts, accountDay]);
  // refresh Claude usage when the launcher opens
  useEffect(() => {
    if (!accountsVisible || !claudeConfigured) return;
    let active = true;
    void settings.claudeAccounts().then(result => {
      // ignore closed-launcher responses
      if (!active) return;
      setClaudeAccountMessage(result.error ?? '');
      // retain the last good usage on failure
      if (result.accounts !== undefined) setClaudeAccounts(result.accounts);
    });
    return () => { active = false; };
  }, [accountsVisible, claudeConfigured, settings.claudeAccounts]);
  // update visible reset countdowns every second
  useEffect(() => {
    // stop the clock while the account-aware launcher is hidden
    if (!accountsVisible) return;
    setAccountClock(Date.now());
    const interval = window.setInterval(() => setAccountClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [accountsVisible]);
  // start editing the current server name
  const beginServerRename = () => {
    setName(settings.serverName);
    setError('');
    setDialog('server');
  };
  // edit a saved label without selecting the account
  const beginAccountRename = (account: CodexAccount) => {
    setRenamingAccount(account);
    setName(codexAccountName(account));
    setError('');
    setDialog('account-rename');
  };
  // switch the global Codex account
  const switchAccount = async (account: CodexAccount) => {
    // ignore active or duplicate selections
    if (account.active || switchingAccountId !== undefined || resettingAccountId !== undefined) return;
    setSwitchingAccountId(account.id);
    setAccountMessage('');
    const result = await settings.switchCodexAccount(account.id);
    setSwitchingAccountId(undefined);
    // keep the current account after failure
    if (result.account === undefined) {
      setAccountMessage(result.error ?? 'Unable to switch ChatGPT accounts.');
      return;
    }
    const switchedAccount = result.account;
    setAccounts(current => current.map(candidate => candidate.id === switchedAccount.id ? { ...candidate, ...switchedAccount, active: true } : { ...candidate, active: false }));
    const restarted = result.restarts?.filter(item => item.status === 'restarted').length ?? 0;
    const failed = result.restarts?.filter(item => item.status === 'failed').length ?? 0;
    setAccountMessage(`Switched to ${codexAccountName(account)}. Restarted ${restarted} idle ${restarted === 1 ? 'worktree' : 'worktrees'}${failed === 0 ? '.' : `; ${failed} failed.`}`);
  };
  // redeem one available reset credit
  const useAccountReset = async (account: CodexAccount) => {
    const atLimit = account.primary?.usedPercent === 100 || account.secondary?.usedPercent === 100;
    // require an eligible idle account action
    if (!atLimit || !account.resetCount || switchingAccountId !== undefined || resettingAccountId !== undefined) return;
    setResettingAccountId(account.id);
    setAccountMessage('');
    const result = await settings.resetCodexAccount(account.id);
    // retain current usage after transport failures
    if (result.outcome === undefined) {
      setResettingAccountId(undefined);
      setAccountMessage(result.error ?? 'Unable to use the ChatGPT reset.');
      return;
    }
    // publish a refreshed provider snapshot when available
    if (result.account !== undefined) {
      const refreshedAccount = result.account;
      setAccounts(current => current.map(candidate => candidate.id === refreshedAccount.id ? { ...candidate, ...refreshedAccount } : candidate));
    } else {
      const refreshed = await settings.codexAccounts();
      // replace stale usage after a successful provider action
      if (refreshed.accounts !== undefined) setAccounts(refreshed.accounts);
    }
    setResettingAccountId(undefined);
    // report the provider outcome without inventing success
    const email = codexAccountName(account);
    if (result.outcome === 'reset') setAccountMessage(`Used one reset for ${email}.`);
    else if (result.outcome === 'nothingToReset') setAccountMessage(`${email} no longer has a limit available to reset.`);
    else if (result.outcome === 'noCredit') setAccountMessage(`${email} has no resets available.`);
    else setAccountMessage(`The reset for ${email} was already used.`);
  };
  // start one device-code login
  const beginAccountLogin = async (account?: CodexAccount) => {
    // preserve an in-flight account save
    if (pending) return;
    const requestId = accountLoginRequest.current + 1;
    accountLoginRequest.current = requestId;
    setDialog('account-login');
    setAccountLogin(undefined);
    setAccountLoginTarget(account === undefined ? undefined : { email: codexAccountName(account) });
    setAccountLoginState('pending');
    setDeviceCodeCopied(false);
    setAccountApiKey('');
    setAccountApiKeyError('');
    setError('');
    const result = await settings.startCodexAccountLogin(account?.id);
    // cancel logins created after the dialog closes or another request starts
    if (accountLoginRequest.current !== requestId) {
      // stop the late server session
      if (result.login !== undefined) await settings.cancelCodexAccountLogin(result.login.loginId);
      return;
    }
    // retain a visible failure
    if (result.login === undefined) {
      setAccountLoginState('failed');
      setError(result.error ?? 'Unable to start ChatGPT login.');
      return;
    }
    setAccountLogin(result.login);
  };
  // save an API key instead of completing device authorization
  const submitAccountApiKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const apiKey = accountApiKey.trim();
    // reject empty keys and duplicate or repair submissions
    if (!apiKey || pending || accountLoginTarget !== undefined) return;
    // reject malformed pasted credentials locally
    if (apiKey.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(apiKey)) {
      setAccountApiKeyError('Enter an API key without spaces or control characters.');
      return;
    }
    accountLoginRequest.current += 1;
    setPending(true);
    setAccountApiKeyError('');
    setAccountLoginState('idle');
    setAccountLogin(undefined);
    // stop device polling before storing a different credential
    if (accountLogin !== undefined && accountLoginState === 'pending') {
      const cancelled = await settings.cancelCodexAccountLogin(accountLogin.loginId);
      // check whether device completion won the cancellation race
      if (!cancelled) {
        const status = await settings.codexAccountLoginStatus(accountLogin.loginId);
        // wait for an authorized device login rather than saving two accounts
        if (status?.status !== 'failed') {
          setAccountLogin(accountLogin);
          setAccountLoginState('pending');
          setPending(false);
          setAccountApiKeyError('Device sign-in could not be cancelled. Wait for it to finish or try again.');
          return;
        }
      }
    }
    const result = await settings.addCodexApiKeyAccount(apiKey);
    setPending(false);
    // retain the masked key for correction or retry
    if (result.account === undefined) {
      setAccountApiKeyError(result.error ?? 'Unable to save API key.');
      return;
    }
    const addedAccount = result.account;
    // preserve list-only billing metadata and row order for existing keys
    setAccounts(current => {
      // merge a reused identity without discarding its existing snapshot
      if (current.some(account => account.id === addedAccount.id)) return current.map(account => account.id === addedAccount.id ? { ...account, ...addedAccount } : account);
      return [...current, addedAccount];
    });
    setAccountApiKey('');
    setDialog(undefined);
    // distinguish an existing selected key from a newly saved account
    setAccountMessage(addedAccount.active ? `${codexAccountName(addedAccount)} saved. This account is already selected.` : `${codexAccountName(addedAccount)} added. Select it to use it.`);
  };
  // copy the current device code
  const copyDeviceCode = async () => {
    // require one ready login
    if (accountLogin === undefined) return;
    try {
      await copyText(accountLogin.userCode);
      setDeviceCodeCopied(true);
    } catch {
      setDeviceCodeCopied(false);
    }
  };
  // close the active popup
  const closeDialog = () => {
    // keep pending writes stable
    if (pending) return;
    // stop abandoned and in-flight device logins
    if (dialog === 'account-login' && accountLoginState === 'pending') {
      accountLoginRequest.current += 1;
      // cancel a started server session
      if (accountLogin !== undefined) void settings.cancelCodexAccountLogin(accountLogin.loginId);
    }
    setDialog(undefined);
    setRenamingAccount(undefined);
    setAccountApiKey('');
    setAccountApiKeyError('');
    setError('');
  };
  // keep keyboard navigation inside the account popup
  const accountLoginKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // close only after any credential save finishes
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); return; }
    // preserve ordinary input keys
    if (event.key !== 'Tab') return;
    // select visible enabled controls in popup order
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href]')).filter(control => control.offsetParent !== null);
    event.preventDefault();
    // retain focus while all controls are disabled
    if (controls.length === 0) return;
    const activeElement = document.activeElement;
    const index = activeElement instanceof HTMLElement ? controls.indexOf(activeElement) : -1;
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    controls.at(next)?.focus();
  };
  // save a display name without changing account selection
  const submitRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // prevent duplicate writes and missing targets
    if (pending || (dialog !== 'server' && dialog !== 'account-rename')) return;
    const normalized = name.trim();
    // reject empty or control-bearing names locally
    if (!normalized || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
      setError('Enter a name without control characters.');
      return;
    }
    setPending(true);
    setError('');
    try {
      // update only the saved account label
      if (dialog === 'account-rename') {
        // retain the editor if its target disappeared
        if (renamingAccount === undefined) { setError('Account unavailable.'); return; }
        const result = await settings.renameCodexAccount(renamingAccount.id, normalized);
        // keep failed edits available for retry
        if (result.account === undefined) { setError(result.error ?? 'Unable to rename account.'); return; }
        const renamed = result.account;
        // retain limits and selection from the current snapshot
        setAccounts(current => current.map(account => account.id === renamed.id ? { ...account, label: renamed.label } : account));
        setAccountMessage(`Renamed to ${renamed.label}.`);
      } else {
        const failure = await settings.renameServer(normalized);
        // retain the editor after a failed rename
        if (failure !== undefined) { setError(failure); return; }
      }
      setDialog(undefined);
      setRenamingAccount(undefined);
    } catch {
      setError('Unable to rename. Try again.');
    } finally {
      setPending(false);
    }
  };
  // poll one device-code login
  useEffect(() => {
    // require an active login
    if (dialog !== 'account-login' || accountLogin === undefined || accountLoginState !== 'pending') return;
    let active = true;
    const requestId = accountLoginRequest.current;
    // ignore device responses after an API-key submission
    const poll = async () => {
      const status = await settings.codexAccountLoginStatus(accountLogin.loginId);
      // ignore transient or stale reads
      if (!active || requestId !== accountLoginRequest.current || status === undefined || status.status === 'pending') return;
      // show provider failures in place
      if (status.status === 'failed') {
        setAccountLoginState('failed');
        setError(status.error ?? 'ChatGPT login failed.');
        return;
      }
      // publish the completed account before the list refresh
      if (status.account !== undefined) {
        const completedAccount = status.account;
        setAccounts(current => [...current.filter(account => account.id !== completedAccount.id), completedAccount]);
      }
      const refreshed = await settings.codexAccounts();
      // publish the newly configured account list
      if (active && requestId === accountLoginRequest.current && refreshed.accounts !== undefined) setAccounts(refreshed.accounts);
      // close the login dialog into a visible success state
      if (active && requestId === accountLoginRequest.current) {
        setDialog(undefined);
        setAccountLogin(undefined);
        setAccountApiKey('');
        // leave the account submenu open behind the completed login
        const addedName = status.account === undefined ? 'ChatGPT account' : codexAccountName(status.account);
        setAccountMessage(accountLoginTarget === undefined ? `${addedName} added.` : `Re-login complete for ${accountLoginTarget.email}.`);
      }
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [accountLogin, accountLoginState, accountLoginTarget, dialog, settings.codexAccountLoginStatus, settings.codexAccounts]);
  // render each configured account
  const accountRows = accounts.map(account => {
    const email = codexAccountName(account);
    // api keys do not support chatgpt limit resets
    const atLimit = account.authMode !== 'apikey' && [account.primary, account.secondary].some(window => window?.usedPercent === 100);
    const busy = accountsLoading || switchingAccountId !== undefined || resettingAccountId !== undefined || pending;
    const switching = switchingAccountId === account.id;
    const resetting = resettingAccountId === account.id;
    return <div key={account.id} className="chatgpt-account-option"><button className={`chatgpt-account-select${progressBorder(switching, 'blue')}`} type="button" role="radio" aria-busy={switching || undefined} aria-checked={account.active} disabled={account.active || busy} onClick={() => void switchAccount(account)}><ProgressRing busy={switching} /><span className="chatgpt-account-check" aria-hidden="true">{account.active ? '✓' : ''}</span><AccountCopy account={account} now={accountClock} /></button>{/* keep account actions in one shared row */}<div className="chatgpt-account-actions" role="group" aria-label={`Actions for ${email}`}><button className="chatgpt-account-rename" type="button" aria-label={`Rename ${email}`} disabled={busy} onClick={() => { /* edit this account label */ beginAccountRename(account); }}>Rename</button>{atLimit && account.resetCount !== undefined && account.resetCount > 0 && <button className={`chatgpt-account-reset${progressBorder(resetting, 'blue')}`} type="button" aria-busy={resetting || undefined} aria-label={`Use reset for ${email}`} disabled={busy} onClick={() => void useAccountReset(account)}><ProgressRing busy={resetting} />{resetting ? 'Using reset…' : 'Use reset'}</button>}{account.error !== undefined && account.authMode !== 'apikey' && <button className="chatgpt-account-relogin" type="button" aria-label={`Re-login to ${email}`} disabled={busy} onClick={() => void beginAccountLogin(account)}>Re-login</button>}</div></div>;
  });
  // the Codex accounts section renders only when adapters.codex is configured
  const accountsSection = !codexConfigured ? null : <section className="client-settings-section client-settings-accounts" aria-labelledby="launcher-accounts-title"><header><small>CODEX</small><h2 id="launcher-accounts-title">Accounts</h2><button className="chatgpt-account-add" type="button" disabled={accountsLoading || switchingAccountId !== undefined || resettingAccountId !== undefined} onClick={() => void beginAccountLogin()}>+ Add account</button></header>{/* define billing periods separately from account selection */}{accounts.some(account => account.authMode === 'apikey') && <p className="api-key-spend-note">API-key spend is in USD, using UTC days and weeks starting Monday. OpenAI reporting may be delayed.</p>}<div className="client-settings-account-list" role="radiogroup" aria-label="ChatGPT accounts">{accountsLoading && accounts.length === 0 ? <div className="chatgpt-account-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Loading ChatGPT accounts…</div> : accountRows}</div>{accountMessage && <span className="chatgpt-account-message" role="status">{accountMessage}</span>}</section>;
  // Claude has one signed-in account, so its section only reports usage
  const claudeAccountsSection = !claudeConfigured ? null : <section className="client-settings-section client-settings-accounts" aria-labelledby="launcher-claude-accounts-title"><header><small>CLAUDE</small><h2 id="launcher-claude-accounts-title">Account</h2></header><div className="client-settings-account-list">{claudeAccounts.length === 0 && !claudeAccountMessage ? <div className="chatgpt-account-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Loading Claude usage…</div> : claudeAccounts.map(account => <div key={account.id} className="chatgpt-account-option"><AccountCopy account={account} now={accountClock} /></div>)}</div>{claudeAccountMessage && <span className="chatgpt-account-message" role="status">{claudeAccountMessage}</span>}</section>;
  // serialize closes within their originating workspace until explicitly resolved
  const closeSettings = useCallback((): Promise<boolean> => {
    // share one unresolved confirmation across header, keyboard and workspace callers
    const pendingClose = pendingSettingsClose.current.get(workspaceKey);
    if (pendingClose !== undefined) return pendingClose;
    // an already closed split has no draft to discard
    if (!settingsSplitOpen(workspaceKey)) return Promise.resolve(true);
    // stale workspace callbacks must never discard another workspace's visible draft
    if (currentWorkspace.current !== workspaceKey || settingsCloseGuard.current === null) return Promise.resolve(false);
    const decision = settingsCloseGuard.current.requestClose();
    const closing = decision.then(confirmed => {
      // cancelled close requests leave the mounted draft untouched
      if (!confirmed) return false;
      setOpen(false);
      // remove only the settings hash
      if (currentWorkspace.current === workspaceKey && location.hash === '#settings') history.replaceState(null, '', `${location.pathname}${location.search}`);
      return true;
    }).finally(() => { pendingSettingsClose.current.delete(workspaceKey); });
    pendingSettingsClose.current.set(workspaceKey, closing);
    return closing;
  }, [workspaceKey, setOpen]);
  // close the nonmodal split without trapping focus away from static controls
  const pageKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // ignore keys belonging to a child dialog
    if (event.key === 'Escape' && !event.defaultPrevented && dialog === undefined) { event.preventDefault(); event.stopPropagation(); void closeSettings(); }
  };
  // render staged browser and file-backed settings through one shared workspace
  const settingsPage = !open ? null : <ClientSettingsPage panelRef={pageRef} busy={false} hidden={settings.serverUpdateVisible} onKeyDown={pageKey} onClose={closeSettings}><SettingsCenter active={open} session={settingsSession} closeGuardRef={settingsCloseGuard} remoteServers={serverIdentity?.remotes} browser={{ deviceName: settings.deviceName, renameClient: settings.renameClient }} voice={settings.davo} onSaved={settings.refreshDavo} onSaveNotice={(tone, detail) => { /* share timed successes and persistent failures with the global toast stack */ onOperationFeedback({ tone, message: tone === 'success' ? 'Saved' : 'Settings save incomplete', detail }); }} requestedSection={requestedSection?.workspaceKey === workspaceKey ? requestedSection : undefined} onSectionSelected={consumeSettingsSection} /></ClientSettingsPage>;
  const renameTarget = dialog === 'server' || dialog === 'account-rename' ? dialog : undefined;
  let renameTitle = renamingAccount?.authMode === 'apikey' ? 'API key' : 'account';
  let renameMaxLength = 120;
  // retain the existing bound for server identity
  if (renameTarget === 'server') { renameTitle = 'Server'; renameMaxLength = 80; }
  // reuse the bounded name editor for accounts and console identities
  const renameDialog = renameTarget === undefined ? null : createPortal(<div className="dialog client-rename-dialog" data-launch-submenu-dialog={renameTarget === 'account-rename' || undefined} role="dialog" aria-modal="true" aria-labelledby="settings-rename-title" onKeyDown={accountLoginKey}><div><header><div><small>{renameTarget === 'server' ? 'SERVER' : 'CODEX ACCOUNTS'}</small><h2 id="settings-rename-title">Rename {renameTitle}</h2></div><button type="button" aria-label={`Close rename ${renameTitle.toLowerCase()}`} disabled={pending} onClick={closeDialog}><PanelIcon path={panelIcons.close} /></button></header><form onSubmit={event => { /* save the edited name */ void submitRename(event); }}><label>{renameTitle} name<input autoFocus type="text" value={name} maxLength={renameMaxLength} autoComplete="off" disabled={pending} onChange={event => { /* retain the current draft */ setName(event.target.value); }} /></label>{error && <span className="auth-error" role="alert">{error}</span>}<footer><button type="button" disabled={pending} onClick={closeDialog}>Cancel</button><button type="submit" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending || !name.trim()}><ProgressRing busy={pending} />{pending ? 'Renaming…' : 'Save'}</button></footer></form></div></div>, document.body);
  let accountLoginContent: ReactNode;
  // offer device authorization again after an API-key attempt
  if (accountLoginState === 'idle') {
    accountLoginContent = <button type="button" disabled={pending} onClick={() => { /* restart device login */ void beginAccountLogin(); }}>Use device authentication</button>;
  // render a failed login
  } else if (accountLoginState === 'failed') {
    accountLoginContent = <span className="auth-error">{error || 'ChatGPT login failed.'}</span>;
  // render an active device-code login
  } else if (accountLogin !== undefined) {
    accountLoginContent = <><span>{accountLoginTarget === undefined ? 'Open ChatGPT to add this account.' : `Open ChatGPT to repair ${accountLoginTarget.email}.`}</span><a href={accountLogin.verificationUrl} target="_blank" rel="noreferrer">Open activation page ↗</a><span className="chatgpt-device-code-wrap"><small>DEVICE CODE</small><button className="chatgpt-device-code" type="button" title="Copy login code" onClick={() => void copyDeviceCode()}>{accountLogin.userCode}</button><small className={deviceCodeCopied ? 'copied' : undefined} aria-live="polite">{deviceCodeCopied ? 'Copied!' : 'Click the code to copy it'}</small></span><small>Waiting for authorization…</small></>;
  // render login startup
  } else {
    accountLoginContent = <span>Starting secure ChatGPT login…</span>;
  }
  // keep API keys out of the repair flow and browser persistence
  const accountApiKeyForm = accountLoginTarget !== undefined ? null : <form id="chatgpt-api-key-form" className="chatgpt-api-key-form" onSubmit={event => { /* save the pasted credential */ void submitAccountApiKey(event); }} aria-labelledby="chatgpt-api-key-title"><h3 id="chatgpt-api-key-title">Or use an API key</h3><p id="chatgpt-api-key-description">Use an OpenAI API key instead of device authentication. API usage is billed separately from ChatGPT.</p><label>API key<input type="password" value={accountApiKey} placeholder="Paste your API key" maxLength={8192} {...noAutofill} disabled={pending} aria-describedby="chatgpt-api-key-description" onChange={event => { /* keep the credential only in this dialog */ setAccountApiKey(event.target.value); setAccountApiKeyError(''); }} /></label>{accountApiKeyError && <span className="auth-error" role="alert">{accountApiKeyError}</span>}</form>;
  // render both account-add alternatives with one shared cancel action
  const loginStarting = accountLoginState === 'pending' && accountLogin === undefined;
  const accountLoginDialog = dialog !== 'account-login' ? null : createPortal(<div className="dialog client-rename-dialog chatgpt-account-dialog" data-launch-submenu-dialog role="dialog" aria-modal="true" aria-labelledby="account-login-title" onKeyDown={accountLoginKey}><div><header><div><small>CODEX ACCOUNTS</small><h2 id="account-login-title">{accountLoginTarget === undefined ? 'Add ChatGPT account' : 'Re-login to ChatGPT'}</h2></div><button autoFocus type="button" aria-label="Close account login" disabled={pending} onClick={closeDialog}><PanelIcon path={panelIcons.close} /></button></header><div className={`chatgpt-account-login ${accountLoginState}${progressBorder(loginStarting, 'blue')}`} role="status" aria-busy={loginStarting || undefined}><ProgressRing busy={loginStarting} />{accountLoginContent}</div>{accountApiKeyForm}<footer className="chatgpt-account-login-actions"><button type="button" disabled={pending} onClick={closeDialog}>Cancel</button>{accountLoginTarget === undefined && <button type="submit" form="chatgpt-api-key-form" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending || !accountApiKey.trim()}><ProgressRing busy={pending} />{pending ? 'Saving…' : 'Add API key'}</button>}</footer></div></div>, document.body);
  // toggle the settings page as a fresh user action
  const toggleSettings = () => {
    // consume notification routes when closing
    if (open) closeSettings();
    else setOpen(true);
    setError('');
  };
  // keep ui update guidance in the toast instead of settings
  const trigger = <span className="server-switcher-settings-wrap"><button ref={triggerRef} type="button" className="server-switcher-button server-switcher-settings" aria-label="Global settings" aria-haspopup="dialog" aria-controls="global-settings-page" aria-expanded={open} onClick={toggleSettings}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1-1.55V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06-.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.55 1H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></svg></button></span>;
  // reuse the saved label for the selected launcher account
  const activeName = (list: CodexAccount[]) => { const active = list.find(account => account.active); return active === undefined ? undefined : codexAccountName(active); };
  const accountMenus = { ...(accountsSection === null ? {} : { codex: { content: accountsSection, activeName: activeName(accounts) } }), ...(claudeAccountsSection === null ? {} : { claude: { content: claudeAccountsSection, activeName: activeName(claudeAccounts) } }) };
  // keep account mutations mounted while the launch flyout changes menu pages
  const accountsMenu = Object.keys(accountMenus).length === 0 ? undefined : { menus: accountMenus, onOpen: showAccounts, onClose: hideAccounts };
  return <ClientSettingsSplitContext.Provider value={{ open, page: settingsPage, trigger, close: closeSettings, renameServer: beginServerRename }}><AgentAccountsMenuContext.Provider value={accountsMenu}>{children}</AgentAccountsMenuContext.Provider>{renameDialog}{accountLoginDialog}</ClientSettingsSplitContext.Provider>;
}

// place the global settings button at the end of the static tab row
function ClientSettingsTrigger() {
  return useContext(ClientSettingsSplitContext)?.trigger ?? null;
}

// omit settings state when the active client has no settings authority
function OptionalClientSettingsLayout({ settings, workspaceKey, children, onOperationFeedback }: { settings?: ClientSettings; workspaceKey: string; children: ReactNode; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  // leave unavailable settings out of the workspace tree
  if (settings === undefined) return <>{children}</>;
  return <ClientSettingsLayout settings={settings} workspaceKey={workspaceKey} onOperationFeedback={onOperationFeedback}>{children}</ClientSettingsLayout>;
}

// the current server first, then its configured remotes
const serverTargets = (server: ServerInfo): RemoteServer[] => [{ name: server.name, url: server.url, icon: server.icon }, ...server.remotes];

// render one server with its attention: the current one as a button, the others as native links for WebAPK capture
function ServerTargetLink({ target, current, className, onSelectCurrent }: { target: RemoteServer; current: boolean; className: string; onSelectCurrent?: () => void }) {
  const statuses = useContext(ServerStatusContext);
  const attention = statuses[target.url] ?? 'idle';
  const attentionLabel = instanceAttentionLabel(attention);
  const label = `${target.name}${attentionLabel === undefined ? '' : ` — ${attentionLabel}`}`;
  const content = <><img src={serverIconPath(target.icon)} alt="" /><span>{target.name}</span><i className={`server-switcher-attention ${attention}`} aria-hidden="true" title={attentionLabel} /></>;
  if (current) return <button type="button" className={`${className} attention-${attention}`} aria-current="page" aria-label={label} onClick={onSelectCurrent}>{content}</button>;
  return <a href={target.url} className={`${className} attention-${attention}`} aria-label={label}>{content}</a>;
}

// list the servers inline on the sign-in and takeover screens
function ServerSwitcher({ className = '' }: { className?: string }) {
  const server = useContext(ServerContext) ?? fallbackServerInfo();
  const clientSettings = useContext(ClientSettingsContext);
  return <div className={`server-switcher${className ? ` ${className}` : ''}`} role="group" aria-label="Remote Agents servers">{serverTargets(server).map(target => <ServerTargetLink key={target.url} target={target} current={target.url === server.url} className="server-switcher-button" />)}{clientSettings && <ClientSettingsTrigger />}</div>;
}

// the remote attention named by the closed selector, most urgent first; an unreachable remote is not attention
const remoteAttentionOrder: readonly InstanceAttention[] = ['question', 'completed', 'working'];
const serverStatusCycleMs = 1_000;

// pick a server or manage the current server from one selector
function ServerSelector() {
  const server = useContext(ServerContext) ?? fallbackServerInfo();
  const statuses = useContext(ServerStatusContext);
  const settings = useContext(ClientSettingsContext);
  const settingsSplit = useContext(ClientSettingsSplitContext);
  const [open, setOpen] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const [revision, setRevision] = useState<ServerRevision>();
  const [revisionLoading, setRevisionLoading] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLButtonElement>(open);
  // refresh the deployed revision while the server menu is visible
  useEffect(() => {
    if (!open || settings === undefined) return;
    let active = true;
    setRevisionLoading(true);
    void settings.loadServerRevision().then(result => {
      // discard a reply after the selector closes
      if (!active) return;
      setRevision(result);
      setRevisionLoading(false);
    });
    return () => { active = false; };
  }, [open, settings?.loadServerRevision, settings?.serverUrl]);
  // keep a remote's question or unread result visible while the menu is closed
  const remoteAttention = remoteAttentionOrder.find(attention => server.remotes.some(remote => statuses[remote.url] === attention));
  const remoteLabel = remoteAttention === undefined ? undefined : instanceAttentionLabel(remoteAttention);
  // keep an open or minimized update review visibly in progress
  const updateInProgress = settings?.serverUpdateVisible === true || settings?.serverUpdateMinimized === true;
  const updateAvailable = settings?.serverUpdateAvailable === true || updateInProgress;
  let updateLabel = settings?.serverUpdateAvailable === true ? 'Update available' : 'Up to date';
  // announce the open review instead of another available update
  if (settings?.serverUpdateVisible === true) updateLabel = 'Update review open';
  // keep the resumable review's state available while its dialog is hidden
  if (settings?.serverUpdateMinimized === true) updateLabel = 'Update review minimized';
  const selectorLabel = `Switch server (${server.name})${remoteLabel === undefined ? '' : ` — ${remoteLabel} on another server`}${updateAvailable ? ` — ${updateLabel.toLowerCase()}` : ''}`;
  const targets = serverTargets(server);
  const targetSignature = targets.map(target => target.url).join('\u0000');
  // cycle one corner dot through servers and a pending update
  useEffect(() => {
    setStatusIndex(0);
    const count = targets.length + Number(updateAvailable);
    // keep a single status steady when no update is pending
    if (count < 2) return;
    const timer = window.setInterval(() => setStatusIndex(index => (index + 1) % count), serverStatusCycleMs);
    return () => window.clearInterval(timer);
  }, [targetSignature, updateAvailable]);
  const shownTarget = targets[statusIndex % targets.length]!;
  const showingUpdate = updateAvailable && statusIndex === targets.length;
  const targetAttention = statuses[shownTarget.url] ?? 'idle';
  const shownAttention = showingUpdate ? 'update' : targetAttention;
  const shownLabel = showingUpdate ? `${server.name} — ${updateLabel}` : `${shownTarget.name} — ${instanceAttentionLabel(targetAttention)}`;
  const revisionLabel = revisionLoading ? 'Checking revision…' : revision === undefined ? 'Revision unavailable' : <><code>{revision.sha.slice(0, 7)}</code><time dateTime={revision.committedAt}>{updateCommitDate(revision.committedAt)}</time></>;
  // close the selector before handing focus to an administration dialog
  const rename = () => { setOpen(false); settingsSplit?.renameServer(); };
  // close the selector before opening the update review
  const showUpdate = () => { setOpen(false); settings?.openServerUpdate(); };
  return <><button ref={anchorRef} type="button" className={`server-switcher-button server-selector${updateAvailable ? ' updates-available' : ''}${updateInProgress ? ' updates-in-progress progress-border progress-mauve' : ''}`} aria-busy={updateInProgress || undefined} aria-label={selectorLabel} aria-description={shownLabel} title={selectorLabel} data-context-flyout aria-expanded={open} onClick={() => setOpen(value => !value)}><ProgressRing busy={updateInProgress} /><span className="flyout-caret" aria-hidden="true" /><img src={serverIconPath(server.icon)} alt="" /><span className="server-selector-name">{server.name}</span><svg className="server-selector-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg><i className={`server-switcher-attention ${shownAttention}`} aria-hidden="true" title={shownLabel} /></button>{open && <FlyoutPortal onDismiss={() => setOpen(false)}><div className="more-menu flyout-menu server-menu" ref={flyoutRef} style={style} role="group" aria-label="Remote Agents servers"><div className="server-menu-details" role="group" aria-label="Current server details"><small>CURRENT SERVER</small><strong>{settings?.serverName ?? server.name}</strong><span>{serverHostLabel(settings?.serverUrl ?? server.url)}</span><span className={`server-menu-revision${progressBorder(revisionLoading, 'blue')}`} aria-busy={revisionLoading || undefined} aria-label={revision === undefined ? 'Server revision unavailable' : `Server revision ${revision.sha.slice(0, 7)}, committed ${updateCommitDate(revision.committedAt)}`}><ProgressRing busy={revisionLoading} />{revisionLabel}</span><span className={`server-menu-update-state${updateAvailable ? ' available' : ''}`}>{updateLabel}</span>{settings !== undefined && <div className="server-menu-actions"><button type="button" aria-label="Rename Server" onClick={rename}>Rename</button>{updateAvailable && <button type="button" className="server-menu-update" aria-label={settings.serverUpdateMinimized ? 'Reopen server update' : 'View upstream update'} onClick={showUpdate}>{settings.serverUpdateMinimized ? 'Reopen update' : 'View update'}</button>}</div>}</div><hr className="more-menu-divider" />{targets.map(target => <ServerTargetLink key={target.url} target={target} current={target.url === server.url} className="server-menu-item" onSelectCurrent={() => setOpen(false)} />)}</div></FlyoutPortal>}</>;
}

// lead the tab row with the server selector and the always-visible Call button
function TabRowLead() {
  const voice = useContext(VoiceTriggerContext);
  const settings = useContext(ClientSettingsContext);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string>();
  // disable the assistant through the same persisted settings action
  const disableDavo = async () => {
    // serialize repeated menu requests
    if (settings === undefined || disabling) return;
    setDisabling(true);
    setDisableError(undefined);
    try {
      const error = await settings.disableDavo();
      setDisableError(error);
    } catch { setDisableError('Unable to disable Davo. Try again.'); }
    finally { setDisabling(false); }
  };
  // keep right-click separate from starting a voice call
  const voiceMenu = (event: React.MouseEvent<HTMLButtonElement>) => openContextMenu(event, {
    label: 'Davo options',
    items: [{ type: 'action', id: 'disable-davo', label: 'Disable Davo', disabled: disabling || settings === undefined, onSelect: disableDavo }]
  });
  const voiceLabel = voice?.active ? voice.visible ? `Ongoing ${voice.name} call` : `Show ongoing ${voice.name} call` : `Call ${voice?.name ?? 'voice assistant'}`;
  return <div className="tab-row-lead"><ServerSelector />{voice && <button type="button" className={`server-switcher-button server-switcher-voice${voice.active ? ' active' : ''}`} aria-label={voiceLabel} aria-pressed={voice.visible} onPointerDownCapture={preserveContextMenuPress} onMouseDownCapture={preserveContextMenuPress} onContextMenu={voiceMenu} onClick={voice.open}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.08 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.84.56 2.8.69A2 2 0 0 1 22 16.92Z" /></svg><span>{voice.active ? 'Ongoing' : `Call ${voice.name}`}</span></button>}{disableError && <span role="alert">{disableError}</span>}</div>;
}

function Login({ done, initialError }: { done: (session: SessionInfo) => void; initialError?: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!response.ok) return setError('Invalid credentials');
    const session = await response.json() as SessionInfo;
    csrf = session.csrfToken;
    setPassword('');
    done(session);
  };
  return <main className="auth-screen"><div className="auth-glow" /><form className="auth-card" onSubmit={login}><div className="auth-mark" aria-hidden="true"><span>&gt;_</span></div><div className="auth-heading"><ServerSwitcher className="auth-server-switcher" /><p>REMOTE // AGENTS</p><h1>Console access</h1></div><label className="sr-only">Username<input type="text" name="username" autoComplete="username" tabIndex={-1} /></label><label>Password<input autoFocus type="password" name="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="auth-submit">Authenticate <span aria-hidden="true">↗</span></button></form></main>;
}

// frame full-screen loading with the shared clockwise progress border
function LoadingScreen({ label = 'Restoring secure session' }: { label?: string }) {
  return <main className="auth-screen loading-screen" aria-live="polite"><div className="auth-glow" /><div className="loading-console progress-border progress-mauve" aria-busy="true"><ProgressRing busy /><div className="loading-line">{label}</div></div></main>;
}


function ControlScreen({ session, claimed }: { session: SessionInfo; claimed: (next: SessionInfo) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const needsName = session.deviceName === undefined;
  const namingOnly = session.active && needsName;
  const takeControl = async () => {
    if (pending || (needsName && !deviceName.trim())) return;
    setPending(true); setError('');
    try {
      const response = await request('/api/auth/take-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(needsName ? { deviceName } : {}) });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Unable to take control. Try again.');
      }
      claimed(await response.json() as SessionInfo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to take control. Try again.');
      setPending(false);
    }
  };
  const controller = session.controllingDeviceName ?? 'Another device';
  return <main className="auth-screen loading-screen" aria-live="polite"><div className="auth-glow" /><section className="loading-console console-recovery"><ServerSwitcher className="auth-server-switcher" /><strong className={namingOnly ? undefined : 'control-owner'}>{namingOnly ? 'Name this device.' : `${controller} is active`}</strong>{namingOnly && <span>Give this device a name before continuing.</span>}{needsName && <label>Device name<input autoFocus type="text" value={deviceName} maxLength={64} autoComplete="nickname" placeholder="e.g. Kitchen iPad" onChange={event => setDeviceName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && deviceName.trim()) void takeControl(); }} /></label>}{error && <span className="auth-error" role="alert">{error}</span>}<button type="button" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending || (needsName && !deviceName.trim())} onClick={() => void takeControl()}><ProgressRing busy={pending} />{pending ? namingOnly ? 'Saving name' : 'Taking control' : namingOnly ? 'Save device name' : 'Take control'}</button><NotificationControl /></section></main>;
}

class ConsoleBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="auth-screen loading-screen" role="alert"><div className="auth-glow" /><section className="loading-console console-recovery"><strong>Console needs to reconnect</strong><span>The interface hit a temporary problem.</span><button type="button" onClick={() => location.reload()}>Reload console</button></section></main>;
  }
}

// the agent panel's power menu: Restart, Restart as…, Clear, New Task and Turn off
// `restartAs` adds a "Restart as…" item that opens the Launch menu as
// a second page within the same flyout, restarting the agent under the chosen kind.
type RestartAs = { label: string; resolution?: LaunchResolution; onLaunch: (choice: LaunchChoice) => void };
// `disabledReason` holds the menu shut (an Agent at work) and explains why in the button's title.
// An Agent outside a Worktree (Scratch, a directory Project) has no Restart: Turn off closes it.
type NewTaskPower = { agentId: string; worktreeId?: string; configured: boolean; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void };
type AgentPowerMenuProps = { pending: boolean; progressColor?: ProgressColor; hidden?: boolean; disabledReason?: string; className?: string; onTurnOff: () => void; onRestart?: () => void; onClear: () => void; restartAs?: RestartAs; newTask?: NewTaskPower };
// keep task availability and the handoff alive while the power flyout closes
function useNewTaskPowerOption(task: NewTaskPower | undefined, open: boolean, closeMenu: () => void): ReactNode {
  const [availability, setAvailability] = useState<NewTaskAvailability>();
  const [loading, setLoading] = useState(false);
  const agentId = task?.agentId;
  const worktreeId = task?.worktreeId;
  const configured = task?.configured === true;
  const operationKey = newTaskOperationKey(worktreeId ?? agentId ?? 'unavailable');
  const starting = usePendingOperation(operationKey);
  // check availability only while this menu is open
  useEffect(() => {
    // skip closed or agentless menus
    if (!open || agentId === undefined) return;
    setAvailability(undefined);
    setLoading(configured);
    // leave unconfigured tasks disabled
    if (!configured) return;
    let cancelled = false;
    void request(`/api/agents/${encodeURIComponent(agentId)}/new-task`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      // reject incomplete availability responses
      if (cancelled || payload === null || typeof payload !== 'object' || typeof (payload as { enabled?: unknown }).enabled !== 'boolean') throw new Error('invalid new task availability');
      const result = payload as { enabled: boolean; reason?: unknown };
      setAvailability({ enabled: result.enabled, reason: typeof result.reason === 'string' ? result.reason : undefined });
    }).catch(() => {
      // preserve one actionable failure
      if (!cancelled) setAvailability({ enabled: false, reason: 'Unable to check whether a new task can start.' });
    }).finally(() => {
      // finish only the current request
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, agentId, configured]);
  // release a failed or expired handoff
  const clearTask = () => {
    // clear only this agent's source mapping
    if (worktreeId !== undefined && pendingNewTaskSources.get(worktreeId) === agentId) pendingNewTaskSources.delete(worktreeId);
    setPendingOperation(operationKey, false);
  };
  // replace the current Agent with a fresh task
  const start = async () => {
    // require live availability and one pending operation
    if (task === undefined || !configured || starting || !availability?.enabled || !beginPendingOperation(operationKey, worktreeId === undefined ? `agent-${agentId}` : placeItemKey(worktreeId))) return;
    // track replacement of a known worktree
    if (worktreeId !== undefined) pendingNewTaskSources.set(worktreeId, task.agentId);
    closeMenu();
    task.onOperationFeedback({ tone: 'pending', message: 'Starting a new task…', detail: 'Closing the current session and preparing a fresh agent. You can keep using other tabs.', worktreeId });
    try {
      // give chunked transports an explicit json media type and body
      const response = await request(`/api/agents/${encodeURIComponent(task.agentId)}/new-task`, emptyJsonMutation('POST'));
      // surface a rejected replacement
      if (!response.ok) {
        clearTask();
        setAvailability({ enabled: false, reason: 'Unable to start a new task.' });
        task.onOperationFeedback({ tone: 'error', message: 'New task did not start', detail: await launchError(response), worktreeId });
        return;
      }
      window.setTimeout(() => {
        // require one worktree handoff
        if (worktreeId === undefined) return clearTask();
        // ignore completed replacements
        if (pendingNewTaskSources.get(worktreeId) !== task.agentId) return;
        // retain the recovery tab
        setPendingOperation(operationKey, false);
        task.onOperationFeedback({ tone: 'error', message: 'New task is taking longer than expected', detail: 'No fresh agent appeared within 30 seconds. Check the worktree status before trying again.', worktreeId });
      }, 30_000);
    } catch {
      clearTask();
      setAvailability({ enabled: false, reason: 'Unable to start a new task.' });
      task.onOperationFeedback({ tone: 'error', message: 'New task did not start', detail: 'The console could not be reached. The current agent is unchanged.', worktreeId });
    }
  };
  // hide this option outside a git agent
  if (task === undefined) return null;
  const reason = !configured ? 'Not configured for this worktree.' : availability === undefined ? 'Checking availability…' : availability.enabled ? 'Start a fresh task for this worktree.' : availability.reason ?? 'New Task is currently unavailable.';
  const busy = loading || starting;
  return <div className="new-task-option" role="none"><button type="button" role="menuitem" className={busy ? 'progress-border progress-blue' : undefined} aria-busy={busy || undefined} disabled={!configured || loading || !availability?.enabled || starting} onClick={() => void start()}><ProgressRing busy={busy} /><MoreMenuIcon name="new-task" />{starting ? 'Starting New Task' : 'New Task'}</button><span className="more-menu-reason" role="status">{reason}</span></div>;
}
// render configured-agent power choices
function AgentPowerMenu(props: AgentPowerMenuProps) {
  const { pending, hidden = false, disabledReason, className = 'danger icon-button deactivate-agent', onRestart } = props;
  const adapters = useContext(AdaptersContext);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'root' | 'restart-as'>('root');
  const { anchorRef, flyoutRef, style } = useViewportFlyout(open);
  const newTaskOption = useNewTaskPowerOption(props.newTask, open, () => setOpen(false));
  // reopen every menu on its root page
  useEffect(() => { if (!open) setView('root'); }, [open]);
  // choose one power action
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  // "Restart as…" only when there is a configured kind to choose (a legacy config with no
  // `adapters` block has none — its Codex still restarts via plain Restart)
  const restartAs = onRestart !== undefined && configuredKinds(adapters).length > 0 ? props.restartAs : undefined;
  // a held menu closes rather than stranding an open flyout
  useEffect(() => { if (disabledReason !== undefined) setOpen(false); }, [disabledReason]);
  // Restart as… sits between Restart and Clear
  const stateActions = <>{onRestart !== undefined && <button type="button" role="menuitem" onClick={() => choose(onRestart)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.3-5.7L20 7.6M20 3v4.6h-4.6" /></svg>Restart</button>}{restartAs !== undefined && <button type="button" role="menuitem" data-context-flyout aria-haspopup="menu" onClick={() => setView('restart-as')}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.3-5.7L20 7.6M20 3v4.6h-4.6" /></svg>Restart as…</button>}<button type="button" role="menuitem" onClick={() => choose(props.onClear)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 15 8-8 5 5-8 8H4v-5Zm7-7 5 5M10 20h10" /></svg>Clear</button></>;
  const restartAsPage = restartAs === undefined ? null : <LaunchMenu verb="Restart" label={restartAs.label} resolution={restartAs.resolution} onLaunch={choice => choose(() => restartAs.onLaunch(choice))} />;
  // Turn off at the foot of the menu
  const footAction = <button className="agent-power-off" type="button" role="menuitem" onClick={() => choose(props.onTurnOff)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9m5.7-5.7a8 8 0 1 1-11.4 0" /></svg>Turn off</button>;
  const menuLabel = 'Agent power options';
  // keep restart choices in the same compact power flyout
  return <><span className="power-menu-wrap" ref={anchorRef} hidden={hidden}><button className={`${className}${progressBorder(pending, props.progressColor ?? 'red')}`} type="button" disabled={pending || disabledReason !== undefined || hidden} aria-busy={pending || undefined} aria-label={menuLabel} data-context-flyout aria-expanded={open && !hidden} aria-haspopup="menu" title={disabledReason ?? menuLabel} onClick={() => setOpen(current => !current)}><ProgressRing busy={pending} /><span className="flyout-caret" aria-hidden="true" /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9m5.7-5.7a8 8 0 1 1-11.4 0" /></svg></button></span>{open && !hidden && <FlyoutPortal onDismiss={() => setOpen(false)}><div className="more-menu flyout-menu agent-power-menu" ref={flyoutRef} style={style} role="menu" aria-label={menuLabel}>{view === 'restart-as' && restartAs !== undefined ? restartAsPage : <>{stateActions}{newTaskOption}{footAction}</>}</div></FlyoutPortal>}</>;
}

// render reusable mobile terminal controls
function MobileTerminalKeys({ id }: { id: string }) {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const [fnActive, setFnActive] = useState(false);
  // publish the mounted pane's sticky toggle state
  useEffect(() => {
    mobileModifiers.set(id, { alt: altActive, ctrl: ctrlActive, shift: shiftActive, fn: fnActive });
    // discard modifiers when these controls unmount
    return () => { mobileModifiers.delete(id); };
  }, [id, altActive, ctrlActive, shiftActive, fnActive]);
  // toggle one sticky modifier
  const toggleModifier = (name: 'alt'|'ctrl'|'shift'|'fn') => {
    const setters = { alt: setAltActive, ctrl: setCtrlActive, shift: setShiftActive, fn: setFnActive };
    const current = stickyModifiers(id);
    mobileModifiers.set(id, { ...current, [name]: !current[name] });
    // mirror the immediate modifier change in the button state
    setters[name](value => !value);
  };
  // send one mobile key sequence
  const mobileKey = (key: 'tab'|'up'|'down'|'left'|'right'|'dollar'|'slash') => {
    const { alt, ctrl, shift } = stickyModifiers(id);
    const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
    let value = key === 'tab' ? (shift ? '\x1b[Z' : '\t') : key === 'dollar' ? '$' : key === 'slash' ? '/' : (ctrl || shift || alt ? `\x1b[1;${ctrl && shift ? 6 : ctrl && alt ? 7 : shift && alt ? 4 : ctrl ? 5 : shift ? 2 : 3}${arrows[key]}` : `\x1b[${arrows[key]}`);
    // prefix modified printable keys
    if (alt && (key === 'dollar' || key === 'slash' || key === 'tab')) value = `\x1b${value}`;
    terminalInputs.get(id)?.(value);
  };
  // send one direct control character
  const mobileControl = (value: '\x1b'|'\x03') => { terminalInputs.get(id)?.(value); };
  return <div className="mobile-terminal-keys" aria-label="Terminal keys"><div className="mobile-control-keys"><button type="button" aria-label="Esc" onPointerDown={event => { event.preventDefault(); mobileControl('\x1b'); }}>Esc</button><button type="button" aria-label="Ctrl+C" onPointerDown={event => { event.preventDefault(); mobileControl('\x03'); }}>Ctrl+C</button></div><div className="mobile-key-modifiers"><button type="button" aria-label="Tab" onPointerDown={event => { event.preventDefault(); mobileKey('tab'); }}>Tab</button><button type="button" className={shiftActive ? 'active' : ''} aria-pressed={shiftActive} onPointerDown={event => { event.preventDefault(); toggleModifier('shift'); }}>Shift</button><button type="button" className={ctrlActive ? 'active' : ''} aria-pressed={ctrlActive} onPointerDown={event => { event.preventDefault(); toggleModifier('ctrl'); }}>Ctrl</button><button type="button" className={altActive ? 'active' : ''} aria-pressed={altActive} onPointerDown={event => { event.preventDefault(); toggleModifier('alt'); }}>Alt</button><button type="button" className={`mobile-key-fn${fnActive ? ' active' : ''}`} aria-pressed={fnActive} title="Function keys: 1–9 for F1–F9, 0 for F10" onPointerDown={event => { /* preserve terminal focus while toggling fn */ event.preventDefault(); toggleModifier('fn'); }}>Fn</button></div><div className="mobile-arrow-keys"><button type="button" aria-label="Slash" onPointerDown={event => { event.preventDefault(); mobileKey('slash'); }}>/</button><button type="button" aria-label="Up arrow" onPointerDown={event => { event.preventDefault(); mobileKey('up'); }}><MobileKeyIcon name="up" /></button><button type="button" aria-label="Dollar" onPointerDown={event => { event.preventDefault(); mobileKey('dollar'); }}>$</button><button type="button" aria-label="Left arrow" onPointerDown={event => { event.preventDefault(); mobileKey('left'); }}><MobileKeyIcon name="left" /></button><button type="button" aria-label="Down arrow" onPointerDown={event => { event.preventDefault(); mobileKey('down'); }}><MobileKeyIcon name="down" /></button><button type="button" aria-label="Right arrow" onPointerDown={event => { event.preventDefault(); mobileKey('right'); }}><MobileKeyIcon name="right" /></button></div></div>;
}

// render the agent panel's composer: prompt history above attach on the left, the prompt, and
// queued prompts above send on the right; a detected question swaps in the answer layout
function Prompt({ id, ready = true, history, onHistoryChanged, onPromptFocus, onOperationFeedback, question, worktreeId, placeId, historyControl }: { id: string; ready?: boolean; history: PromptHistoryEntry[]; onHistoryChanged: () => Promise<void>; onPromptFocus: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void; question?: ChoiceQuestion; worktreeId?: string; placeId?: string; historyControl?: ReactNode }) {
  // the notes this composer saves into, and the notes fly-out to refresh: the Place's (a Worktree's
  // Place id is its Worktree id), keyed as the Workspace's notes are
  const notesPlaceId = placeId ?? worktreeId;
  const notesViewId = notesPlaceId ?? `agent:${id}`;
  const [value, setValue] = usePromptDraft(id);
  const selectionActions = useSelectionActions();
  // use the shared mobile text-editing breakpoint
  const phone = usePhoneLayout();
  const [commandToken, setCommandToken] = useState<CommandToken>();
  const [activeCommand, setActiveCommand] = useState(0);
  const [promptCommands, setPromptCommands] = useState<PromptCommand[]>([]);
  const pendingKey = `prompt:${id}`;
  const pending = usePendingOperation(pendingKey);
  const [attachments, setAttachments] = usePromptAttachments(id);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const attachmentDragDepth = useRef(0);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [queuedPromptsOpen, setQueuedPromptsOpen] = useState(false);
  const [queuedPromptAction, setQueuedPromptAction] = useState<{ id: string; kind: 'cancel' | 'edit' | 'move' | 'save' }>();
  const [queuedPromptEdit, setQueuedPromptEdit] = useState<{ id: string; text: string }>();
  const [queuedPromptError, setQueuedPromptError] = useState<string>();
  const [normalPromptQuestionId, setNormalPromptQuestionId] = useState<string>();
  const [notesQuestionId, setNotesQuestionId] = useState<string>();
  const answerMode = question === undefined || normalPromptQuestionId !== question.id;
  const questionNotesOpen = question !== undefined && notesQuestionId === question.id;
  // keep file intake out of snapshots and modes without attachment controls
  const attachmentInputDisabled = pending || (question !== undefined && answerMode);
  // clear the drop target when the active composer changes or becomes unavailable
  useEffect(() => {
    attachmentDragDepth.current = 0;
    setDraggingAttachments(false);
  }, [id, attachmentInputDisabled, question?.id, answerMode]);
  const copiedSelectionTimer = useRef<number | undefined>(undefined);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const promptInput = useRef<HTMLTextAreaElement | null>(null);
  const promptSelection = useRef<number | undefined>(undefined);
  const historyIndex = useRef<number | undefined>(undefined);
  const historyDraft = useRef('');
  // reset composer navigation after either note-save entry point clears its draft
  useEffect(() => {
    // preserve navigation for a newer nonempty draft
    if (value) return;
    historyIndex.current = undefined;
    historyDraft.current = '';
    setCommandToken(undefined);
  }, [value]);
  const focusPromptAtEnd = useRef(false);
  const { anchorRef: queuedPromptAnchorRef, flyoutRef: queuedPromptFlyoutRef, style: queuedPromptFlyoutStyle } = useViewportFlyout<HTMLDivElement>(queuedPromptsOpen, { matchContainerWidth: '.agent-panel' });
  const { anchorRef: commandAnchorRef, flyoutRef: commandFlyoutRef, style: commandFlyoutStyle } = useViewportFlyout<HTMLDivElement>(commandToken !== undefined, { placement: 'above', matchAnchorWidth: true });
  const commandOptions = commandToken === undefined ? [] : promptCommands.filter(command => command.value.startsWith(commandToken.prefix) && command.value.slice(1).toLocaleLowerCase().includes(commandToken.query.toLocaleLowerCase()));
  useEffect(() => { historyIndex.current = undefined; historyDraft.current = ''; }, [id]);
  // load commands only after the agent exists
  useEffect(() => {
    let cancelled = false;
    setPromptCommands([]);
    // keep startup composers local
    if (!ready) return;
    void request(`/api/agents/${encodeURIComponent(id)}/commands`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled || payload === null || typeof payload !== 'object' || !Array.isArray((payload as { commands?: unknown }).commands)) return;
      const catalog = (payload as { commands: unknown[] }).commands.flatMap(command => {
        if (command === null || typeof command !== 'object') return [];
        const { value, description } = command as { value?: unknown; description?: unknown };
        return typeof value === 'string' && validCommandValue.test(value) ? [{ value, ...(typeof description === 'string' ? { description } : {}) }] : [];
      });
      setPromptCommands(catalog);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id, ready]);
  // refresh only a live agent queue
  const refreshQueuedPrompts = useCallback(async () => {
    // wait for dashboard confirmation
    if (!ready) return;
    const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts`);
    if (!response.ok) return;
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) return;
    const prompts = (payload as { prompts: unknown[] }).prompts.filter(isQueuedPrompt);
    if (prompts.length !== (payload as { prompts: unknown[] }).prompts.length) return;
    setQueuedPrompts(prompts);
    if (prompts.length === 0) setQueuedPromptsOpen(false);
  }, [id, ready]);
  // start queue polling when the agent becomes available
  useEffect(() => {
    setQueuedPrompts([]);
    setQueuedPromptsOpen(false);
    setQueuedPromptEdit(undefined);
    // avoid idle polling before launch completes
    if (!ready) return;
    return pollWhileVisible(refreshQueuedPrompts, 2_000, true, 15_000);
  }, [refreshQueuedPrompts, ready]);
  useEffect(() => () => {
    if (copiedSelectionTimer.current !== undefined) window.clearTimeout(copiedSelectionTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (!focusPromptAtEnd.current) return;
    focusPromptAtEnd.current = false;
    const input = promptInput.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [value]);
  useLayoutEffect(() => {
    const input = promptInput.current;
    if (input !== null) fitPromptInput(input);
  }, [value]);
  // restore controlled-input selection
  useLayoutEffect(() => {
    const cursor = promptSelection.current;
    const input = promptInput.current;
    promptSelection.current = undefined;
    // apply only requested live selections
    if (cursor !== undefined && input !== null) {
      input.focus();
      input.setSelectionRange(cursor, cursor);
    }
  }, [value]);
  useLayoutEffect(() => {
    const input = promptInput.current;
    const composer = input?.parentElement;
    if (input === null || input === undefined || composer === null || composer === undefined) return;
    let width = composer.clientWidth;
    const observer = new ResizeObserver(() => {
      if (composer.clientWidth === width) return;
      width = composer.clientWidth;
      fitPromptInput(input);
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const [listening, setListening] = useState(false);
  // continue typing at the same caret after the launch placeholder is replaced
  useLayoutEffect(() => {
    const selection = promptHandoffFocus.get(id);
    promptHandoffFocus.delete(id);
    // restore only the composer that owned focus at handoff
    if (selection === undefined || promptInput.current === null) return;
    promptInput.current.focus();
    promptInput.current.setSelectionRange(selection.start, selection.end);
  }, [id]);
  const recognition = useRef<SpeechRecognitionInstance | undefined>(undefined);
  const voiceHoldTimer = useRef<number | undefined>(undefined);
  const voiceHoldPointer = useRef<number | undefined>(undefined);
  const voiceHoldStarted = useRef(false);
  const voiceEnabled = useRef(false);
  const voiceRestartTimer = useRef<number | undefined>(undefined);
  const promptValue = useRef(value);
  promptValue.current = value;
  const speechPrefix = useRef('');
  const speechSegments = useRef(new Map<number, string>());
  const speechWindow = window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  const supportsSpeechRecognition = speechWindow.SpeechRecognition !== undefined || speechWindow.webkitSpeechRecognition !== undefined;
  useEffect(() => () => {
    if (voiceHoldTimer.current !== undefined) window.clearTimeout(voiceHoldTimer.current);
    if (voiceRestartTimer.current !== undefined) window.clearTimeout(voiceRestartTimer.current);
    voiceEnabled.current = false;
    recognition.current?.abort();
  }, []);
  // apply one attachment policy to file-picker, clipboard, and drop inputs
  const chooseAttachments = (files: FileList | File[] | null) => {
    // preserve attachment snapshots owned by pending operations
    if (!files || attachmentInputDisabled) return;
    const next = [...attachments, ...Array.from(files)];
    // preserve earlier files when an addition exceeds the byte limit
    if (next.reduce((total, file) => total + file.size, 0) > maxAttachmentBytes) return setAttachmentError(`Attachments must total ${maxAttachmentMegabytes} MB or less.`);
    setAttachmentError(undefined);
    setAttachments(next);
  };
  // leave text and link drags to the browser while accepting file drops
  const dragAttachments = (event: React.DragEvent<HTMLElement>) => {
    // file contents are protected until drop, but their transfer type is available
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    // balance nested child enters without flickering the drop indicator
    if (event.type === 'dragenter') attachmentDragDepth.current += 1;
    event.dataTransfer.dropEffect = attachmentInputDisabled ? 'none' : 'copy';
    setDraggingAttachments(!attachmentInputDisabled);
  };
  // clear feedback after the drag finishes or is cancelled
  const clearAttachmentDrag = () => {
    attachmentDragDepth.current = 0;
    setDraggingAttachments(false);
  };
  // keep feedback while moving between children inside the prompt
  const leaveAttachmentDrag = () => {
    attachmentDragDepth.current = Math.max(0, attachmentDragDepth.current - 1);
    // hide only after leaving the whole drop target
    if (attachmentDragDepth.current === 0) setDraggingAttachments(false);
  };
  // append dropped files through the same validation as the attachment picker
  const dropAttachments = (event: React.DragEvent<HTMLElement>) => {
    clearAttachmentDrag();
    // preserve normal text dragging without opening dropped files in the browser
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    // reject drops while another operation owns the attachment snapshot
    if (attachmentInputDisabled) return;
    // reject folders rather than silently staging empty directory placeholders
    if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
      setAttachmentError('Folders cannot be attached. Drop individual files instead.');
      return;
    }
    chooseAttachments(event.dataTransfer.files);
  };
  const pasteAttachments = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items).flatMap((item, index) => {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) return [];
      const image = item.getAsFile();
      if (image === null) return [];
      const subtype = image.type.slice('image/'.length).toLowerCase();
      const extension = subtype === 'jpeg' ? 'jpg' : /^[a-z0-9]+$/u.test(subtype) ? subtype : 'png';
      const name = image.name || `pasted-image-${index + 1}.${extension}`;
      return [new File([image], name, { type: image.type, lastModified: image.lastModified })];
    });
    if (images.length === 0) return;
    event.preventDefault();
    chooseAttachments(images);
  };
  const flashCopiedPromptSelection = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    if (input.selectionStart === input.selectionEnd) return;
    input.classList.add('selection-copied');
    if (copiedSelectionTimer.current !== undefined) window.clearTimeout(copiedSelectionTimer.current);
    copiedSelectionTimer.current = window.setTimeout(() => {
      copiedSelectionTimer.current = undefined;
      input.classList.remove('selection-copied');
    }, selectionCopyFlashMs);
  };
  const stopVoice = () => {
    voiceEnabled.current = false;
    if (voiceRestartTimer.current !== undefined) window.clearTimeout(voiceRestartTimer.current);
    voiceRestartTimer.current = undefined;
    recognition.current?.abort();
    recognition.current = undefined;
    setListening(false);
  };
  // submit only after the launch handoff has a real agent
  const submit = async () => {
    // preserve startup drafts on enter
    if (!ready || pending || (!value && attachments.length === 0)) return;
    stopVoice();
    if (!beginPendingOperation(pendingKey, agentItemKey({ id, placeId, worktreeId }))) return;
    const submittedValue = value;
    const submittedAttachments = attachments;
    const restoreSubmission = () => {
      setValue(current => submittedValue ? current ? `${submittedValue}\n\n${current}` : submittedValue : current);
      setAttachments(current => [...submittedAttachments, ...current]);
    };
    historyIndex.current = undefined;
    historyDraft.current = '';
    setValue('');
    setAttachments([]);
    setCommandToken(undefined);
    setAttachmentError(undefined);
    try {
      const payload = await Promise.all(submittedAttachments.map(encodeAttachment));
      const response = await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: submittedValue, attachments: payload }) });
      if (!response.ok) {
        restoreSubmission();
        setAttachmentError(submittedAttachments.length > 0 ? 'Unable to queue the prompt with these attachments.' : 'Unable to queue the prompt.');
      } else {
        // release the composer after acceptance
        void Promise.all([onHistoryChanged(), refreshQueuedPrompts()]).catch(() => {});
      }
    } catch {
      restoreSubmission();
      setAttachmentError('Unable to read the selected attachments.');
    }
    finally { setPendingOperation(pendingKey, false); }
  };
  const moveQueuedPrompt = async (queued: QueuedPrompt, direction: 'earlier' | 'later') => {
    if (queuedPromptAction !== undefined) return;
    setQueuedPromptAction({ id: queued.id, kind: 'move' });
    setQueuedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction }) });
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) throw new Error();
      const prompts = (payload as { prompts: unknown[] }).prompts.filter(isQueuedPrompt);
      if (prompts.length !== (payload as { prompts: unknown[] }).prompts.length) throw new Error();
      setQueuedPrompts(prompts);
    } catch { setQueuedPromptError('Unable to reorder this queued prompt.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  const cancelQueuedPrompt = async (queued: QueuedPrompt) => {
    if (queuedPromptAction !== undefined) return;
    setQueuedPromptAction({ id: queued.id, kind: 'cancel' });
    setQueuedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      setQueuedPrompts(current => {
        const remaining = current.filter(prompt => prompt.id !== queued.id);
        if (remaining.length === 0) setQueuedPromptsOpen(false);
        return remaining;
      });
      if (queuedPromptEdit?.id === queued.id) setQueuedPromptEdit(undefined);
    } catch { setQueuedPromptError('Unable to cancel this queued prompt.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  const saveQueuedPromptAsNote = async (queued: QueuedPrompt) => {
    if (queuedPromptAction !== undefined) return;
    setQueuedPromptAction({ id: queued.id, kind: 'save' });
    setQueuedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}/save`, { method: 'POST' });
      if (!response.ok) throw new Error();
      const note: unknown = await response.json();
      if (!isWorktreeNote(note)) throw new Error();
      setQueuedPrompts(current => {
        const remaining = current.filter(prompt => prompt.id !== queued.id);
        if (remaining.length === 0) setQueuedPromptsOpen(false);
        return remaining;
      });
      if (queuedPromptEdit?.id === queued.id) setQueuedPromptEdit(undefined);
      // refetch the sibling notes fly-out so the new Note appears there
      noteReloadRequests.get(notesViewId)?.();
    } catch { setQueuedPromptError('Unable to save this queued prompt as a note.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  // keep undiscovered scratch composers local while sharing the retained-draft save
  const saveDraftAsNote = async () => {
    // wait for a discovered agent or a persistent place
    if (!ready && notesPlaceId === undefined) return;
    await savePromptDraftAsNote({ id, placeId, worktreeId, onOperationFeedback });
  };
  // C-s in this composer saves its draft as a Note; anywhere else the key passes through
  useKeyAction('save-note', event => { if (event === undefined || keyTarget(event) !== promptInput.current) return false; void saveDraftAsNote(); });
  const saveQueuedPromptEdit = async (queued: QueuedPrompt) => {
    if (queuedPromptAction !== undefined || queuedPromptEdit?.id !== queued.id) return;
    setQueuedPromptAction({ id: queued.id, kind: 'edit' });
    setQueuedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: queuedPromptEdit.text }) });
      if (!response.ok) throw new Error();
      const updated: unknown = await response.json();
      if (!isQueuedPrompt(updated)) throw new Error();
      setQueuedPrompts(current => current.map(prompt => prompt.id === updated.id ? updated : prompt));
      setQueuedPromptEdit(undefined);
    } catch { setQueuedPromptError('Unable to edit this queued prompt.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  // submit one numbered or text answer without queueing a new turn
  const answer = async (selection: number | string) => {
    // require one current unanswered question
    if (question === undefined || pending || (typeof selection === 'string' && !selection.trim()) || !beginPendingOperation(pendingKey, agentItemKey({ id, placeId, worktreeId }))) return;
    setAttachmentError(undefined);
    try {
      // every inline question — structured or parsed — answers through one endpoint
      const response = await request(`/api/agents/${encodeURIComponent(id)}/question`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: question.id, ...(typeof selection === 'number' ? { index: selection } : { text: selection }) }) });
      // retain the answer when delivery fails or the question changed
      if (!response.ok) throw new Error('question answer unavailable');
      // preserve edits made while the submitted answer was in flight
      if (typeof selection === 'string') setValue(current => current === selection ? '' : current);
      // optimistically retire a parsed question the server will next report as gone
      if (question.source !== 'structured') answeredQuestionActions.get(id)?.(question);
    } catch {
      setAttachmentError('Unable to send this answer. The question may have changed or may not support text answers.');
    } finally { setPendingOperation(pendingKey, false); }
  };
  const startVoice = () => {
    if (pending || !supportsSpeechRecognition || recognition.current !== undefined) return false;
    const Recognition = (speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition)!;
    const next = new Recognition();
    recognition.current = next;
    next.continuous = true;
    next.interimResults = true;
    next.lang = navigator.language;
    voiceEnabled.current = true;
    speechPrefix.current = promptValue.current;
    speechSegments.current.clear();
    next.onresult = event => {
      if (recognition.current !== next) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim() ?? '';
        if (transcript) speechSegments.current.set(index, transcript);
        else speechSegments.current.delete(index);
      }
      const transcript = [...speechSegments.current.entries()].sort(([left], [right]) => left - right).reduce((combined, [, segment]) => mergeSpeechSegments(combined, segment), '');
      if (!transcript) return;
      const nextValue = `${speechPrefix.current}${speechPrefix.current && !/\s$/u.test(speechPrefix.current) ? ' ' : ''}${transcript}`;
      promptValue.current = nextValue;
      setValue(nextValue);
    };
    next.onend = () => {
      if (recognition.current !== next) return;
      recognition.current = undefined;
      if (!voiceEnabled.current) return setListening(false);
      voiceRestartTimer.current = window.setTimeout(() => {
        voiceRestartTimer.current = undefined;
        if (voiceEnabled.current && recognition.current === undefined) startVoice();
      });
    };
    next.onerror = event => {
      if (event.error !== undefined && event.error !== 'no-speech' && event.error !== 'aborted') voiceEnabled.current = false;
    };
    setListening(true);
    try { next.start(); }
    catch {
      voiceEnabled.current = false;
      recognition.current = undefined;
      setListening(false);
      return false;
    }
    return true;
  };
  const beginVoiceHold = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    if (pending || !supportsSpeechRecognition || !event.isPrimary || event.button !== 0) return;
    if (voiceEnabled.current || listening) {
      event.preventDefault();
      stopVoice();
      return;
    }
    if (voiceHoldTimer.current !== undefined) window.clearTimeout(voiceHoldTimer.current);
    const pointerId = event.pointerId;
    voiceHoldPointer.current = pointerId;
    voiceHoldStarted.current = false;
    try { event.currentTarget.setPointerCapture(pointerId); } catch { /* Pointer capture may be unavailable in synthetic events. */ }
    voiceHoldTimer.current = window.setTimeout(() => {
      voiceHoldTimer.current = undefined;
      if (voiceHoldPointer.current === pointerId) voiceHoldStarted.current = startVoice();
    }, voiceHoldDelayMs);
  };
  const endVoiceHold = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    if (voiceHoldPointer.current !== event.pointerId) return;
    if (voiceHoldTimer.current !== undefined) window.clearTimeout(voiceHoldTimer.current);
    voiceHoldTimer.current = undefined;
    voiceHoldPointer.current = undefined;
    if (voiceHoldStarted.current) {
      event.preventDefault();
    }
    voiceHoldStarted.current = false;
  };
  // open the native file chooser
  const attachFiles = () => attachmentInput.current?.click();
  // keep file intake one step above lifecycle controls
  const attachmentButton = <button className="attachment-button icon-button" type="button" disabled={attachmentInputDisabled} aria-label="Attach files" title="Attach files" onClick={attachFiles}><MoreMenuIcon name="attachment" /></button>;
  const selectCommand = (command: PromptCommand) => {
    if (commandToken === undefined) return;
    const next = `${value.slice(0, commandToken.start)}${command.value}${value.slice(commandToken.end)}`;
    const cursor = commandToken.start + command.value.length;
    setValue(next);
    setCommandToken(undefined);
    window.requestAnimationFrame(() => { promptInput.current?.focus(); promptInput.current?.setSelectionRange(cursor, cursor); });
  };
  // insert text at the active selection
  const insertPromptText = (input: HTMLTextAreaElement, text: string) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const cursor = start + text.length;
    const next = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    // collapse unchanged replacements immediately
    if (next === input.value) {
      input.setSelectionRange(cursor, cursor);
      return;
    }
    promptSelection.current = cursor;
    setValue(next);
    setCommandToken(commandTokenAt(next, cursor));
    setActiveCommand(0);
  };
  // honor configurable newline shortcuts only in the focused prompt
  useKeyAction('prompt-newline', event => {
    const input = promptInput.current;
    // leave other editors and terminal input unchanged
    if (event === undefined || input === null || keyTarget(event) !== input) return false;
    insertPromptText(input, '\n');
  });
  // open prompt clipboard and selection actions without changing its caret first
  const openPromptContextMenu = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    // preserve the native mobile editing menu
    if (phone) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const snapshot = input.value;
    const selectedText = input.value.slice(start, end);
    // delete only after copying and only while the original draft is still current
    const cut = async () => {
      // protect an empty selection even if invoked outside the menu
      if (!selectedText) return;
      setAttachmentError(undefined);
      try { await copyText(selectedText); }
      catch {
        setAttachmentError('Unable to cut text. Clipboard access was denied or unavailable.');
        return;
      }
      // do not remove newer input or mutate a replaced composer after a delayed write
      if (!input.isConnected || promptInput.current !== input || input.value !== snapshot) return;
      input.focus();
      input.setSelectionRange(start, end);
      insertPromptText(input, '');
    };
    // insert against the snapshotted range after async clipboard access settles
    const paste = (contents: ClipboardContents, includeFiles: boolean) => {
      input.focus();
      input.setSelectionRange(start, end);
      // reuse the controlled editor's replacement and caret behavior
      if (contents.text) insertPromptText(input, contents.text);
      // ordinary paste retains image attachments while plain paste omits them
      if (includeFiles && contents.files.length > 0) chooseAttachments(contents.files);
    };
    openSelectionContextMenu(event, {
      label: 'Prompt actions',
      selectedText,
      selectAll: () => { input.focus(); input.setSelectionRange(0, input.value.length); },
      cut,
      copy: () => copyText(selectedText),
      paste: contents => paste(contents, true),
      pasteAcceptsFiles: true,
      pasteDisabled: attachmentInputDisabled,
      pastePlain: text => paste({ text, files: [] }, false),
      selectionActions
    });
  };
  const updatePrompt = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setValue(next);
    setCommandToken(commandTokenAt(next, event.target.selectionStart ?? next.length));
    setActiveCommand(0);
  };
  const recallPrompt = (direction: -1 | 1) => {
    if (history.length === 0) return;
    const current = historyIndex.current;
    if (direction < 0) {
      if (current === undefined) historyDraft.current = value;
      const next = current === undefined ? 0 : Math.min(history.length - 1, current + 1);
      historyIndex.current = next;
      setValue(history[next]!.text);
    } else {
      if (current === undefined) return;
      if (current === 0) {
        historyIndex.current = undefined;
        setValue(historyDraft.current);
      } else {
        historyIndex.current = current - 1;
        setValue(history[current - 1]!.text);
      }
    }
    setCommandToken(undefined);
    window.requestAnimationFrame(() => {
      const input = promptInput.current;
      if (input === null) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const composer = <div className="prompt-composer" ref={commandAnchorRef}><textarea ref={promptInput} data-prompt-id={id} className={listening ? 'voice-listening' : undefined} aria-label="Prompt" aria-description={supportsSpeechRecognition ? 'Press and hold to start dictation. Tap again to stop.' : undefined} aria-autocomplete="list" data-context-flyout aria-expanded={commandToken !== undefined} aria-controls={commandToken === undefined ? undefined : `prompt-commands-${id}`} aria-activedescendant={commandOptions[activeCommand] === undefined ? undefined : `prompt-command-${id}-${activeCommand}`} value={value} onFocus={() => { exitTerminalInput.get(id)?.(); onPromptFocus(); }} onBlur={() => setCommandToken(undefined)} onCopy={flashCopiedPromptSelection} onPaste={pasteAttachments} onPointerDownCapture={phone ? undefined : preserveContextMenuPress} onMouseDownCapture={phone ? undefined : preserveContextMenuPress} onPointerDown={beginVoiceHold} onPointerUp={endVoiceHold} onPointerCancel={endVoiceHold} onLostPointerCapture={endVoiceHold} onContextMenu={event => { /* preserve active dictation */ if (voiceHoldStarted.current) { event.preventDefault(); return; } openPromptContextMenu(event); }} onKeyDown={event => { const plainArrow = !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey; if (commandOptions.length > 0 && plainArrow && event.key === 'ArrowDown') { event.preventDefault(); setActiveCommand(current => (current + 1) % commandOptions.length); } else if (commandOptions.length > 0 && plainArrow && event.key === 'ArrowUp') { event.preventDefault(); setActiveCommand(current => (current + commandOptions.length - 1) % commandOptions.length); } else if (commandOptions.length > 0 && plainArrow && event.key === 'Enter') { event.preventDefault(); selectCommand(commandOptions[activeCommand] ?? commandOptions[0]!); } else if (plainArrow && event.key === 'ArrowUp' && (historyIndex.current !== undefined || event.currentTarget.selectionStart === event.currentTarget.selectionEnd && !value.slice(0, event.currentTarget.selectionStart).includes('\n'))) { event.preventDefault(); recallPrompt(-1); } else if (plainArrow && event.key === 'ArrowDown' && historyIndex.current !== undefined) { event.preventDefault(); recallPrompt(1); } else if (event.key === 'Escape' && commandToken !== undefined) { event.preventDefault(); setCommandToken(undefined); } else if (event.key === 'Tab') { event.preventDefault(); setValue(current => current + '\t'); } else if (event.key === 'Enter') { event.preventDefault(); /* disabled or remapped modified enter must never submit a prompt */ if (event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return; /* forward plain blank Enter to output */ else if (!event.metaKey && !event.altKey && !value && attachments.length === 0) terminalInputs.get(id)?.('\r'); /* preserve mobile multiline entry */ else if (window.matchMedia('(max-width: 600px)').matches) insertPromptText(event.currentTarget, '\n'); else void submit(); } }} onChange={updatePrompt} />{commandToken !== undefined && <FlyoutPortal onDismiss={() => setCommandToken(undefined)}><div ref={commandFlyoutRef} className="command-menu" style={commandFlyoutStyle} id={`prompt-commands-${id}`} role="listbox" aria-label={`${commandToken.prefix} commands`}>{commandOptions.length > 0 ? commandOptions.map((command, index) => <button key={command.value} id={`prompt-command-${id}-${index}`} type="button" role="option" aria-selected={index === activeCommand} className={index === activeCommand ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => selectCommand(command)}><code>{command.value}</code><span>{command.description}</span></button>) : <span className="command-menu-empty">No matching commands</span>}</div></FlyoutPortal>}</div>;
  const questionModeToggle = question === undefined ? null : <button type="button" className="question-mode-toggle" aria-label={`Switch to ${answerMode ? 'normal prompt' : 'answer'} mode`} onClick={() => { /* toggle detected question mode */ setNormalPromptQuestionId(answerMode ? question.id : undefined); }}>{answerMode ? 'Normal prompt' : 'Answer mode'}</button>;
  const questionNotesId = `question-notes-${id}`;
  const questionNotes = questionNotesOpen ? <div className="question-notes" id={questionNotesId}><textarea aria-label="Answer notes" maxLength={32_000} placeholder="Type an answer for the agent…" value={value} onFocus={() => { /* leave terminal input */ exitTerminalInput.get(id)?.(); onPromptFocus(); }} onChange={event => { /* update note draft */ setValue(event.target.value); }} /><div className="question-notes-actions"><button type="button" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending || !value.trim()} aria-label="Submit notes" onClick={() => { /* answer the active question directly */ void answer(value); }}><ProgressRing busy={pending} />{pending ? 'Submitting' : 'Submit notes'}</button></div></div> : null;
  // render numbered answers
  if (question && answerMode) return <section className="prompt question-prompt" aria-label="Agent question" onDragEnter={dragAttachments} onDragOver={dragAttachments} onDragLeave={leaveAttachmentDrag} onDragEnd={clearAttachmentDrag} onDrop={dropAttachments}><div className="question-heading"><div className="question-copy"><strong>Agent question</strong><span>{question.text}</span></div><div className="question-tools"><button type="button" className="question-notes-toggle" aria-controls={questionNotesId} data-context-flyout aria-expanded={questionNotesOpen} onClick={() => { /* toggle answer notes */ setNotesQuestionId(questionNotesOpen ? undefined : question.id); }}>{questionNotesOpen ? 'Hide notes' : 'Add notes'}</button>{questionModeToggle}</div></div><div className="question-choices">{question.choices.map(choice => <button key={`${choice.answerIndex}-${choice.label}`} className="question-choice" disabled={pending} onClick={() => void answer(choice.answerIndex)}><b aria-hidden="true">{choice.number}</b><span>{choice.label}{choice.description && <small>{choice.description}</small>}</span></button>)}</div>{questionNotes}{attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}</section>;
  const queueLabel = pending ? 'Queueing' : 'Queue';
  const queuePanel = queuedPromptsOpen && <FlyoutPortal onDismiss={() => setQueuedPromptsOpen(false)}><section className="queued-prompts-panel more-menu flyout-menu" ref={queuedPromptFlyoutRef} style={queuedPromptFlyoutStyle} aria-label="Queued prompts"><header><strong>Queued prompts</strong></header>{queuedPromptError && <p className="queued-prompt-error" role="alert">{queuedPromptError}</p>}<div className="queued-prompts-list">{queuedPrompts.map((queued, index) => { const label = queued.text || queued.attachments?.map(attachment => attachment.name).join(', ') || 'Attachments only'; const editing = queuedPromptEdit?.id === queued.id; const busy = queuedPromptAction !== undefined; return <div className={`queued-prompt-item${editing ? ' editing' : ''}`} key={queued.id}><span className="queued-prompt-order"><strong className="queued-prompt-position" aria-label={`Queue position ${index + 1}`}>{index + 1}</strong><span className="queued-prompt-order-buttons"><button type="button" disabled={busy || index === 0} aria-label={`Move queued prompt earlier: ${label}`} title="Move earlier" onClick={() => void moveQueuedPrompt(queued, 'earlier')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button type="button" disabled={busy || index === queuedPrompts.length - 1} aria-label={`Move queued prompt later: ${label}`} title="Move later" onClick={() => void moveQueuedPrompt(queued, 'later')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></span></span>{editing ? <textarea aria-label={`Edit queued prompt: ${label}`} value={queuedPromptEdit.text} maxLength={32_000} autoFocus onChange={event => setQueuedPromptEdit({ id: queued.id, text: event.target.value })} /> : <button className="queued-prompt-copy" type="button" disabled={busy} title={label} onClick={() => setQueuedPromptEdit({ id: queued.id, text: queued.text })}><span>{queued.text || 'Attachments only'}</span>{queued.attachments?.length ? <small>{queued.attachments.map(attachment => attachment.name).join(', ')}</small> : null}</button>}<span className="queued-prompt-actions">{editing ? <><button type="button" disabled={busy || !queuedPromptEdit.text.trim() && queued.attachments === undefined} aria-label={`Save queued prompt changes: ${label}`} title="Save changes" onClick={() => void saveQueuedPromptEdit(queued)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button><button type="button" disabled={busy} aria-label={`Stop editing queued prompt: ${label}`} title="Stop editing" onClick={() => setQueuedPromptEdit(undefined)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></> : <button type="button" className={queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'save' ? 'progress-border progress-blue' : undefined} aria-busy={queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'save' || undefined} disabled={busy} aria-label={`Save queued prompt as note: ${label}`} title="Save as note" onClick={() => void saveQueuedPromptAsNote(queued)}><ProgressRing busy={queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'save'} /><svg className="notes-icon" viewBox="0 0 24 24" aria-hidden="true"><path className="notes-icon-sheet" d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 21v-6h6" /></svg></button>}<button className={`queued-prompt-cancel${progressBorder(queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'cancel', 'red')}`} type="button" aria-busy={queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'cancel' || undefined} disabled={busy} aria-label={`Cancel queued prompt: ${label}`} title="Cancel queued prompt" onClick={() => void cancelQueuedPrompt(queued)}><ProgressRing busy={queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'cancel'} /><svg className="action-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.trash} /></svg></button></span></div>; })}</div></section></FlyoutPortal>;
  // the queued prompts stay one tap away: counted, and disabled while the queue is empty
  const queuedToggle = <button className={`queued-prompts-toggle icon-button${queuedPromptsOpen ? ' active' : ''}`} type="button" disabled={pending || queuedPrompts.length === 0} aria-label={`Queued prompts (${queuedPrompts.length})`} data-context-flyout aria-expanded={queuedPromptsOpen} title={queuedPrompts.length === 0 ? 'No queued prompts' : `${queuedPrompts.length} queued prompt${queuedPrompts.length === 1 ? '' : 's'}`} onClick={() => setQueuedPromptsOpen(open => !open)}><span className="flyout-caret" aria-hidden="true" /><svg viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.queue} /></svg>{queuedPrompts.length > 0 && <span className="saved-prompts-count queued-prompts-count" aria-hidden="true">{queuedPrompts.length}</span>}</button>;
  const sendButton = <button className={`queue icon-button${progressBorder(pending, 'blue')}`} aria-busy={pending || undefined} disabled={!ready || pending || (!value && attachments.length === 0)} aria-label={queueLabel} title={queueLabel} onClick={() => void submit()}><ProgressRing busy={pending} /><svg viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.send} /></svg></button>;
  return <section className="prompt agent-composer" aria-label="Prompt composer" onDragEnter={dragAttachments} onDragOver={dragAttachments} onDragLeave={leaveAttachmentDrag} onDragEnd={clearAttachmentDrag} onDrop={dropAttachments}>{draggingAttachments && <div className="prompt-drop-overlay" role="status">Drop files to attach</div>}<div className="agent-composer-column" aria-label="Prompt shortcuts">{historyControl}{attachmentButton}</div><div className="prompt-content">{composer}{attachments.length > 0 && <div className="prompt-attachments" aria-label="Selected attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`} title={file.name}>{file.name}<button type="button" disabled={pending} aria-label={`Remove ${file.name}`} onClick={() => setAttachments(current => current.filter((_, candidate) => candidate !== index))}><PanelIcon path={panelIcons.close} /></button></span>)}</div>}{attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}{queuedPromptError && !queuedPromptsOpen && <p className="queued-prompt-error" role="alert">{queuedPromptError}</p>}<input ref={attachmentInput} className="attachment-input" type="file" multiple onChange={event => { chooseAttachments(event.target.files); event.target.value = ''; }} />{questionModeToggle && <div className="prompt-actions">{questionModeToggle}</div>}</div><div className="agent-composer-column" ref={queuedPromptAnchorRef} role="group" aria-label="Prompt submission controls">{queuedToggle}{sendButton}</div>{queuePanel}</section>;
}

// render the complete composer without addressing an agent that discovery has not confirmed
function PreparingPrompt({ id, onOperationFeedback }: { id: string; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  return <Prompt id={id} ready={false} history={[]} onHistoryChanged={async () => { /* no discovered history */ }} onPromptFocus={() => { /* retain local draft focus */ }} onOperationFeedback={onOperationFeedback} />;
}

type MobileKeyIconName = 'control'|'shift'|'tab'|'up'|'down'|'left'|'right';
function MobileKeyIcon({ name }: { name: MobileKeyIconName }) {
  const paths: Record<MobileKeyIconName, string> = { control: 'M8 5h8v4h3v6h-3v4H8v-4H5V9h3zm2 2v4H7v2h3v4h4v-4h3v-2h-3V7z', shift: 'm12 4 6 6h-4v8h-4v-8H6z', tab: 'M4 8h11m0 0-3-3m3 3-3 3M20 16H9m0 0 3 3m-3-3 3-3', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6', left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6' };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

// validate lightweight note responses without loading file contents
const isWorktreeNote = (value: unknown): value is WorktreeNote => {
  // require a note-shaped record before inspecting metadata
  if (value === null || typeof value !== 'object') return false;
  const note = value as Partial<WorktreeNote>;
  const attachments = note.attachments;
  return typeof note.id === 'string' && typeof note.text === 'string' && (note.title === undefined || typeof note.title === 'string')
    && (note.locked === undefined || typeof note.locked === 'boolean')
    && (note.allWorkspaces === undefined || typeof note.allWorkspaces === 'boolean')
    && (attachments === undefined || Array.isArray(attachments) && attachments.every(
      // require valid file metadata before exposing note actions
      attachment => attachment !== null && typeof attachment === 'object' && typeof attachment.name === 'string' && Number.isSafeInteger(attachment.size) && attachment.size > 0
    ));
};
// treat attachment-only notes as useful content
const noteHasContent = (note: Pick<WorktreeNote, 'text'|'attachments'>) => Boolean(note.text.trim() || note.attachments?.length);
// fetch file bytes only when sending a note
const fetchNoteAttachments = async (resourceBase: string, note: WorktreeNote): Promise<Array<{ name: string; data: string }>> => {
  const expected = note.attachments;
  // retain the existing text-only request path
  if (expected === undefined || expected.length === 0) return [];
  const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}/attachments`);
  // never silently submit a note without its requested files
  if (!response.ok) throw new Error('note attachments unavailable');
  const payload: unknown = await response.json();
  const attachments = payload !== null && typeof payload === 'object' ? (payload as { attachments?: unknown }).attachments : undefined;
  // require the advertised files and valid byte payloads
  if (!Array.isArray(attachments) || attachments.length !== expected.length || !attachments.every(
    // reject stale or malformed file snapshots
    (attachment, index) => attachment !== null && typeof attachment === 'object' && typeof attachment.name === 'string' && attachment.name === expected[index]?.name && typeof attachment.data === 'string' && attachment.data.length > 0
  )) throw new Error('note attachments changed; reopen the note');
  return attachments as Array<{ name: string; data: string }>;
};
// validate note lists consistently across mount, manual and dashboard refreshes
const fetchWorktreeNotes = async (resourceBase: string): Promise<WorktreeNote[]> => {
  const response = await request(`${resourceBase}/notes`);
  // leave transport failures to the caller's foreground or background policy
  if (!response.ok) throw new Error('notes unavailable');
  const payload: unknown = await response.json();
  // reject malformed collections before updating any note state
  if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { notes?: unknown }).notes)) throw new Error('invalid notes');
  return (payload as { notes: unknown[] }).notes.filter(isWorktreeNote);
};
// derive an assistant response title
const assistantNoteTitle = (text: string) => {
  const firstLine = text.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? 'Assistant response';
  const cleaned = firstLine.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[*_`~]+/gu, '').trim() || 'Assistant response';
  const characters = Array.from(cleaned);
  return characters.length <= 80 ? cleaned : `${characters.slice(0, 79).join('').trimEnd()}…`;
};
// save one retained draft atomically without depending on composer visibility
const savePromptDraftAsNote = async (source: PromptNoteSource) => {
  const { id, placeId, worktreeId, onOperationFeedback } = source;
  const notesPlaceId = placeId ?? worktreeId;
  const base = persistenceResourceBase(notesPlaceId, id);
  const text = getPromptDraft(id);
  const submittedAttachments = promptAttachments.get(id) ?? emptyPromptAttachments;
  const title = text.trim() ? assistantNoteTitle(text) : submittedAttachments[0]?.name.slice(0, 120);
  // allow attachment-only keyboard saves without creating empty notes
  if (base === undefined || title === undefined) return;
  // reject oversized drafts without truncating their contents
  if (text.length > 30_000) {
    onOperationFeedback({ tone: 'error', message: 'Unable to save draft as a note', detail: 'Notes are limited to 30,000 characters', worktreeId });
    return;
  }
  const pendingKey = `prompt:${id}`;
  // explain competing workspace operations instead of silently ignoring the action
  if (!beginPendingOperation(pendingKey, agentItemKey(source))) {
    onOperationFeedback({ tone: 'error', message: 'Draft not saved', detail: 'Wait for the current workspace action to finish, then try again.', worktreeId });
    return;
  }
  try {
    const payload = await Promise.all(submittedAttachments.map(encodeAttachment));
    const response = await request(`${base}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, text, ...(payload.length === 0 ? {} : { attachments: payload }) }) });
    // retain the full draft after a failed save
    if (!response.ok) throw new Error();
    const note: unknown = await response.json();
    // require acknowledgement before releasing submitted files
    if (!isWorktreeNote(note)) throw new Error();
    // preserve text typed while the snapshot was saving
    if (getPromptDraft(id) === text) setPromptDraft(id, '');
    // release only files included in the successful snapshot
    setPromptAttachments(id, current => current.filter(file => !submittedAttachments.includes(file)));
    noteReloadRequests.get(notesPlaceId ?? `agent:${id}`)?.();
    onOperationFeedback({ tone: 'success', message: 'Draft saved to notes', detail: note.title ?? 'Note', worktreeId });
  } catch { onOperationFeedback({ tone: 'error', message: 'Unable to save draft as a note', detail: 'The console could not be reached, or this project has reached its note limit.', worktreeId }); }
  finally { setPendingOperation(pendingKey, false); }
};
// subscribe only the flyout action to draft edits, not the entire workspace
function SaveCurrentPromptButton({ source, disabled }: { source?: PromptNoteSource; disabled: boolean }) {
  const id = source?.id ?? 'unavailable';
  const [text] = usePromptDraft(id);
  const pending = usePendingOperation(`prompt:${id}`);
  const available = source !== undefined && Boolean(text.trim()) && text.length <= 30_000;
  return <button className="log-control save-current-prompt" type="button" disabled={disabled || pending || !available} title={text.length > 30_000 ? 'Notes are limited to 30,000 characters' : undefined} onClick={() => {
    // read the retained snapshot at invocation time, including while minimized
    if (available && source !== undefined) void savePromptDraftAsNote(source);
  }}>Save current prompt</button>;
}
// find the newest response substantial enough to save
const latestSubstantialResponse = (latestAssistantMessage: string | undefined, history: PromptHistoryEntry[]) => {
  const candidates = [...(latestAssistantMessage === undefined ? [] : [latestAssistantMessage]), ...history.flatMap(entry => entry.answer === undefined ? [] : [entry.answer])];
  return candidates.find(response => response.length <= 30_000 && response.trim().split(/\s+/u).filter(Boolean).length >= 50);
};
// resolve a note menu label
// label attachment-only notes with their filenames
const noteName = (note: WorktreeNote) => note.title ?? (note.text.trim() ? notePreview(note.text) : note.attachments?.map(attachment => attachment.name).join(', ') || notePreview(note.text));
const notePreview = (text: string) => {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return `${words.length === 0 ? 'Blank note' : words.slice(0, 6).join(' ')}…`;
};
const appendTextBlock = (current: string, text: string) => `${current}${current ? current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n' : ''}${text}`;

// validate one referenced workspace file
const isAssistantFile = (value: unknown): value is AssistantFile => value !== null && typeof value === 'object'
  && typeof (value as AssistantFile).path === 'string'
  && Number.isInteger((value as AssistantFile).size)
  && (value as AssistantFile).size >= 0;
// validate one inline raster image
const isAssistantPreviewImage = (value: unknown): value is AssistantPreviewImage => value !== null && typeof value === 'object'
  && ((value as AssistantPreviewImage).mediaType === 'image/gif' || (value as AssistantPreviewImage).mediaType === 'image/jpeg' || (value as AssistantPreviewImage).mediaType === 'image/png' || (value as AssistantPreviewImage).mediaType === 'image/webp')
  && typeof (value as AssistantPreviewImage).base64 === 'string'
  && /^[A-Za-z0-9+/]*={0,2}$/u.test((value as AssistantPreviewImage).base64);
// validate one bounded workspace preview
const isAssistantFilePreview = (value: unknown): value is AssistantFilePreview => isAssistantFile(value)
  && typeof (value as AssistantFilePreview).binary === 'boolean'
  && typeof (value as AssistantFilePreview).truncated === 'boolean'
  && ((value as AssistantFilePreview).binary
    ? (value as { content?: unknown }).content === undefined && ((value as { image?: unknown }).image === undefined || isAssistantPreviewImage((value as { image?: unknown }).image))
    : typeof (value as { content?: unknown }).content === 'string' && (value as { image?: unknown }).image === undefined);
// render one explicit file-preview state
const filePreviewContent = (path: string, state: FilePreviewState, preview?: AssistantFilePreview): ReactNode => {
  // show pending requests
  if (state === 'loading') return <div className="response-file-message progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Loading preview…</div>;
  // show failed requests
  if (state === 'error' || preview === undefined) return <div className="response-file-message error" role="alert">Preview unavailable</div>;
  // show supported raster images
  if (preview.binary && preview.image !== undefined) return <div className="response-file-image"><img src={`data:${preview.image.mediaType};base64,${preview.image.base64}`} alt={`Preview of ${path}`} /></div>;
  // explain unsupported binary files
  if (preview.binary) return <div className="response-file-message">Binary file preview unavailable</div>;
  return <SyntaxHighlightedCode path={path} code={preview.content} label={`Contents of ${path}`} />;
};
// format compact file sizes
const assistantFileSize = (size: number) => size < 1_024 ? `${size} B` : size < 1_048_576 ? `${(size / 1_024).toFixed(1)} KB` : `${(size / 1_048_576).toFixed(1)} MB`;

// manage one stored or workspace file preview
function useFilePreview(previewUrl: string) {
  const [previewPath, setPreviewPath] = useState<string>();
  const [preview, setPreview] = useState<AssistantFilePreview>();
  const [previewState, setPreviewState] = useState<FilePreviewState>('loading');
  const [copied, setCopied] = useState(false);
  const previewRequest = useRef(0);
  const previewTrigger = useRef<HTMLElement | null>(null);

  // reset when the preview target changes
  useEffect(() => {
    setPreviewPath(undefined);
    setPreview(undefined);
    previewTrigger.current = null;
    // discard responses for closed or replaced targets
    return () => { previewRequest.current += 1; };
  }, [previewUrl]);
  // load one selected file preview
  const openFile = async (path: string) => {
    const requestId = ++previewRequest.current;
    previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPreviewPath(path);
    setPreview(undefined);
    setPreviewState('loading');
    setCopied(false);
    try {
      const response = await request(previewUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      // reject unavailable preview responses
      if (!response.ok) throw new Error('preview unavailable');
      const payload: unknown = await response.json();
      // require the shared bounded preview contract
      if (!isAssistantFilePreview(payload)) throw new Error('invalid preview');
      // ignore replaced or closed previews
      if (previewRequest.current !== requestId) return;
      setPreviewPath(payload.path);
      setPreview(payload);
      setPreviewState('ready');
    } catch {
      // leave newer previews untouched
      if (previewRequest.current === requestId) setPreviewState('error');
    }
  };
  // close the active file preview
  const closePreview = () => {
    previewRequest.current += 1;
    setPreviewPath(undefined);
    setPreview(undefined);
    setCopied(false);
    previewTrigger.current?.focus();
    previewTrigger.current = null;
  };
  // copy the canonical workspace path
  const copyPath = async () => {
    // skip closed previews
    if (previewPath === undefined) return;
    try { await copyText(previewPath); setCopied(true); } catch { setCopied(false); }
  };

  // keep preview shortcuts and focus inside the modal
  const previewKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // dismiss without closing the underlying note
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePreview();
      return;
    }
    // preserve ordinary preview navigation
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
    const index = controls.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    event.preventDefault();
    controls.at(next)?.focus();
  };

  // focus preview keyboard handling when the modal opens
  const dialog = previewPath === undefined ? null : createPortal(<div className="dialog response-file-dialog" role="dialog" aria-modal="true" aria-label={`File preview: ${previewPath}`} onKeyDown={previewKey}><div><header><strong title={previewPath}>{previewPath}</strong><button className="response-file-copy-path" type="button" onClick={() => { /* copy the displayed filename or path */ void copyPath(); }}>{copied ? 'Path copied' : 'Copy path'}</button><button type="button" autoFocus aria-label="Close file preview" title="Close" onClick={closePreview}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>{filePreviewContent(previewPath, previewState, preview)}{preview?.truncated && <footer>Preview limited to the first 256 KB.</footer>}</div></div>, document.body);
  return { dialog, openFile, closePreview };
}

// List the files referenced by the latest assistant response as a flyout control. A row (like a file
// link in the pane output) opens the file in the Code panel's File view via `onOpenFile`; the modal
// preview dialog it used to open is retired, so this hook no longer owns any preview state.
function useLatestAssistantFiles(agentId: string, message: string | undefined, onOpenFile: (path: string) => void) {
  const [files, setFiles] = useState<AssistantFile[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const { anchorRef, flyoutRef, style: flyoutStyle } = useViewportFlyout<HTMLDivElement>(menuOpen);

  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    setMenuOpen(false);
    // ignore sessions without a completed response
    if (message === undefined) return () => { cancelled = true; };
    void request(`/api/agents/${encodeURIComponent(agentId)}/message-files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) }).then(async response => {
      // reject malformed list responses
      if (!response.ok) throw new Error('file list unavailable');
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { files?: unknown }).files) || !(payload as { files: unknown[] }).files.every(isAssistantFile)) throw new Error('invalid file list');
      if (!cancelled) setFiles((payload as { files: AssistantFile[] }).files);
    }).catch(() => {
      // hide unavailable response files
      if (!cancelled) setFiles([]);
    });
    return () => { cancelled = true; };
  }, [agentId, message]);

  const label = `Files from latest response (${files.length})`;
  const control = files.length === 0 ? null : <div className="response-files-control" ref={anchorRef}><button className={`log-control page-arrow response-files-toggle${menuOpen ? ' active' : ''}`} type="button" aria-label={label} title={label} data-context-flyout aria-expanded={menuOpen} onPointerDown={event => event.preventDefault()} onClick={() => setMenuOpen(open => !open)}><span className="flyout-caret" aria-hidden="true" /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 12 5.7-5.7a3.5 3.5 0 1 1 5 5L11 20a5 5 0 1 1-7-7l8.3-8.3" /></svg><span className="saved-prompts-count response-files-count" aria-hidden="true">{files.length}</span></button>{menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div ref={flyoutRef} className="response-files-menu" style={flyoutStyle} aria-label="Files from latest response">{files.map(file => <button className="log-control" type="button" key={file.path} title={file.path} onClick={() => { setMenuOpen(false); onOpenFile(file.path); }}><span>{file.path}</span><small>{assistantFileSize(file.size)}</small></button>)}</div></FlyoutPortal>}</div>;
  return { control };
}

// one Named conversation the server lists (a row of GET …/conversations); `reviewRun` marks
// one a Tour or Review run named, which the list shows only to a search
type ListedConversation = { kind: AgentKind; id: string; name: string; automatic?: boolean; lastActiveAt: number; directory: string; worktreeId?: string; consoleNamed: boolean; reviewRun: boolean; current: boolean };
// validate one listed conversation
const isListedConversation = (value: unknown): value is ListedConversation => value !== null
  && typeof value === 'object'
  && agentKinds.includes((value as ListedConversation).kind)
  && typeof (value as ListedConversation).id === 'string'
  && typeof (value as ListedConversation).name === 'string'
  && ((value as ListedConversation).automatic === undefined || typeof (value as ListedConversation).automatic === 'boolean')
  && typeof (value as ListedConversation).lastActiveAt === 'number'
  && typeof (value as ListedConversation).directory === 'string'
  && ((value as ListedConversation).worktreeId === undefined || typeof (value as ListedConversation).worktreeId === 'string')
  && typeof (value as ListedConversation).consoleNamed === 'boolean'
  && typeof (value as ListedConversation).reviewRun === 'boolean'
  && typeof (value as ListedConversation).current === 'boolean';

// how long ago a Conversation was last active, phone-friendly (from the prototype)
const relativeAge = (at: number): string => {
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < minute) return 'just now';
  if (elapsed < hour) return `${Math.round(elapsed / minute)} min ago`;
  if (elapsed < day) return `${Math.round(elapsed / hour)} h ago`;
  const days = Math.round(elapsed / day);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} d ago`;
  return `${Math.round(days / 7)} wk ago`;
};

// resolve one configured or scratch persistence API
function persistenceResourceBase(worktreeId?: string, agentId?: string): string | undefined {
  // prefer stable configured worktree storage
  if (worktreeId !== undefined) return `/api/worktrees/${encodeURIComponent(worktreeId)}`;
  // fall back to one live scratch agent
  if (agentId !== undefined) return `/api/agents/${encodeURIComponent(agentId)}`;
  return undefined;
}

// list a Project's Named conversations in a fly-out and a full-screen searchable dialog.
// Tapping a dialog row resumes that Conversation in its home Worktree: a same-Worktree row
// switches in place, a sibling-Worktree row navigates to that Worktree's tab and switches
// there, and a row without a home Worktree or of an unlaunchable kind is listed but disabled.
// The list is fetched when the control opens, never polled, so the console does no
// background scan of the agents' stores.
function useWorktreeConversations(worktreeId?: string, agentId?: string, resume?: { onNavigateWorktree?: (worktreeId: string) => void; onOperationFeedback?: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const adapters = useContext(AdaptersContext);
  const [conversations, setConversations] = useState<ListedConversation[]>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resumingKey, setResumingKey] = useState<string>();
  const [nameDraft, setNameDraft] = useState('');
  const [naming, setNaming] = useState(false);
  const [removingKey, setRemovingKey] = useState<string>();
  const loadGeneration = useRef(0);
  const resourceBase = persistenceResourceBase(worktreeId, agentId);
  const { anchorRef, flyoutRef, style: flyoutStyle } = useViewportFlyout<HTMLDivElement>(menuOpen);

  // reset state between contexts, discarding any in-flight load from the previous context
  useEffect(() => {
    loadGeneration.current += 1;
    setConversations(undefined);
    setMenuOpen(false);
    setDialogOpen(false);
    setQuery('');
    setLoading(false);
    setError('');
    setResumingKey(undefined);
    setNameDraft('');
    setNaming(false);
    setRemovingKey(undefined);
  }, [agentId, worktreeId]);

  // compute one Project's conversation list on request
  const load = useCallback(async () => {
    // require one persistence context
    if (resourceBase === undefined) return undefined;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      // pass the live agent only when listing a worktree it is open on, so `current` resolves
      const query = worktreeId === undefined || agentId === undefined ? '' : `?agentId=${encodeURIComponent(agentId)}`;
      const response = await request(`${resourceBase}/conversations${query}`);
      // require a successful list response
      if (!response.ok) throw new Error('conversation list unavailable');
      const payload: unknown = await response.json();
      // validate every row
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { conversations?: unknown }).conversations) || !(payload as { conversations: unknown[] }).conversations.every(isListedConversation)) throw new Error('invalid conversation list');
      const loaded = (payload as { conversations: ListedConversation[] }).conversations;
      // ignore a superseded load
      if (generation !== loadGeneration.current) return undefined;
      setConversations(loaded);
      return loaded;
    } catch {
      // ignore a superseded failure
      if (generation === loadGeneration.current) setError('Unable to load conversations');
      return undefined;
    } finally {
      // retain loading state for the newest request
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [agentId, resourceBase, worktreeId]);

  // discard any in-flight load on unmount
  useEffect(() => () => { loadGeneration.current += 1; }, []);

  // toggle the fly-out, loading the list the first time it opens
  const toggle = async () => {
    // close an open menu
    if (menuOpen) return setMenuOpen(false);
    await load();
    setMenuOpen(true);
  };
  // open the full-screen dialog with a fresh list and an empty search
  const openDialog = async () => {
    setMenuOpen(false);
    setQuery('');
    setDialogOpen(true);
    await load();
  };
  const closeDialog = () => setDialogOpen(false);

  // why one row cannot be resumed, or `undefined` when it can: the current Conversation, a
  // Scratch/orphaned row with no home Worktree, or a kind whose program is not configured here
  const resumeBlockedReason = (conversation: ListedConversation): string | undefined =>
    conversation.current ? 'You are already in this conversation'
      : conversation.worktreeId === undefined ? 'This conversation has no worktree to resume into'
        : adapters?.[conversation.kind]?.launchable !== true ? `${agentKindLabel[conversation.kind]} is not configured on this server`
          : undefined;

  // resume one listed Conversation in its home Worktree. The pending handoff is keyed by the
  // home Worktree so its tab shows the restart and the resumed agent (as the agent restart
  // does). A sibling-Worktree resume moves to that tab first — so the
  // switch runs there and the dialog is gone — and surfaces a failure as a toast. A
  // same-Worktree resume stays put and shows the reason inline, closing only on success.
  const doResume = async (conversation: ListedConversation) => {
    const target = conversation.worktreeId;
    // resume only a launchable, homed, non-current Conversation, one at a time
    if (target === undefined || resumingKey !== undefined || resumeBlockedReason(conversation) !== undefined) return;
    const crossWorktree = target !== worktreeId;
    const operationKey = restartOperationKey(target);
    // share lifecycle state with the home Worktree's tab
    if (!beginPendingOperation(operationKey, placeItemKey(target))) return;
    // key the handoff by the home Worktree; name the source agent only when resuming in place
    pendingWorktreeLaunches.set(target, { operationKey, ...(!crossWorktree && agentId !== undefined ? { sourceAgentId: agentId } : {}) });
    setResumingKey(`${conversation.kind}:${conversation.id}`);
    setError('');
    resume?.onOperationFeedback?.({ tone: 'pending', message: `Resuming ${conversation.name}…`, detail: 'Reconnecting the conversation and waiting for the agent to become ready.', worktreeId: target });
    // move to the Conversation's home Worktree before the switch runs there
    if (crossWorktree) { resume?.onNavigateWorktree?.(target); setMenuOpen(false); setDialogOpen(false); }
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(target)}/conversations/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: conversation.kind, id: conversation.id }) });
      const payload: unknown = response.ok ? await response.json() : undefined;
      const nextAgentId = payload !== null && typeof payload === 'object' ? (payload as { agentId?: unknown }).agentId : undefined;
      // require the replacement identity
      if (typeof nextAgentId !== 'string') throw new Error(response.ok ? 'The conversation opened without a replacement agent.' : await launchError(response));
      const pending = pendingWorktreeLaunches.get(target);
      // avoid restoring a handoff already confirmed by dashboard push
      if (pending !== undefined) pendingWorktreeLaunches.set(target, { ...pending, agentId: nextAgentId });
      else setPendingOperation(operationKey, false);
      resume?.onOperationFeedback?.({ tone: 'success', message: `${conversation.name} resumed`, detail: 'The conversation reconnected and its output is loading.', worktreeId: target });
      // a same-Worktree resume kept the dialog open through the request; close it on success
      setMenuOpen(false);
      setDialogOpen(false);
    } catch (reason) {
      pendingWorktreeLaunches.delete(target);
      setPendingOperation(operationKey, false);
      const message = reason instanceof Error && reason.message ? reason.message : 'Unable to resume this conversation';
      // a same-Worktree resume still shows this dialog, so the reason lands inline; a
      // cross-Worktree one has navigated away, so its toast carries the reason instead
      setError(message);
      resume?.onOperationFeedback?.({ tone: 'error', message: 'Conversation could not be resumed', detail: message, worktreeId: target });
    } finally {
      setResumingKey(undefined);
    }
  };

  // name the current Conversation from the console: the server submits the agent's own rename
  // command into the pane, confirms it from the agent's store, then records it. On success the
  // list is reloaded so the new console-named row appears; a failure (e.g. the agent did not
  // confirm) is shown inline and nothing is recorded.
  const submitName = async () => {
    const name = nameDraft.trim();
    // a name is submitted only against a live agent, one at a time
    if (name === '' || naming || agentId === undefined) return;
    setNaming(true);
    setError('');
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agentId)}/conversations/name`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      // surface the server's reason (the confirm timeout, a question dialog, an in-flight rename)
      if (!response.ok) throw new Error(await launchError(response));
      setNameDraft('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : 'Unable to name this conversation');
    } finally {
      setNaming(false);
    }
  };

  // forget the console's record of one Conversation. The transcript and its name survive, so the
  // row drops out of the quick list but stays under All named; the flag is cleared in place.
  const doRemove = async (conversation: ListedConversation) => {
    const key = `${conversation.kind}:${conversation.id}`;
    // remove one record at a time
    if (removingKey !== undefined || resourceBase === undefined) return;
    setRemovingKey(key);
    setError('');
    try {
      const response = await request(`${resourceBase}/conversations/${encodeURIComponent(conversation.kind)}/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
      // a 404 means the record was already gone; either way it is no longer console-named
      if (!response.ok && response.status !== 404) throw new Error('remove failed');
      setConversations(current => current?.map(row => row.kind === conversation.kind && row.id === conversation.id ? { ...row, consoleNamed: false } : row));
    } catch {
      setError('Unable to remove this conversation from the list');
    } finally {
      setRemovingKey(undefined);
    }
  };

  // hide conversations without any persistence context
  if (resourceBase === undefined) return { control: null, currentName: undefined };
  // Tour and Review run conversations are not the operator's own: they surface only to a search
  const ownRows = (conversations ?? []).filter(conversation => !conversation.reviewRun);
  // the closed control counts the console-named rows
  const consoleNamedRows = ownRows.filter(conversation => conversation.consoleNamed);
  const consoleNamedCount = consoleNamedRows.length;
  const total = ownRows.length;
  const label = `Conversations (${consoleNamedCount})`;
  const needle = query.trim().toLocaleLowerCase();
  // search matches the Conversation name and the agent kind label
  const matches = (needle === '' ? ownRows : conversations ?? []).filter(conversation => needle === '' || conversation.name.toLocaleLowerCase().includes(needle) || agentKindLabel[conversation.kind].toLocaleLowerCase().includes(needle));
  // the quick list: the five most recently active Conversations the console named (the server
  // already orders newest-active first). The Name field placeholder shows the current name if any.
  const flyoutConsoleNamed = consoleNamedRows.slice(0, 5);
  const currentName = conversations?.find(conversation => conversation.current)?.name;
  // the dialog splits console-named rows out ahead of the rest so my own names come first
  // and searched-for run conversations into their own group after both
  const namedHere = matches.filter(conversation => conversation.consoleNamed && !conversation.reviewRun);
  const allNamed = matches.filter(conversation => !conversation.consoleNamed && !conversation.reviewRun);
  const reviewRuns = matches.filter(conversation => conversation.reviewRun);

  const row = (conversation: ListedConversation, removable = false) => {
    const key = `${conversation.kind}:${conversation.id}`;
    const blockedReason = resumeBlockedReason(conversation);
    const resuming = resumingKey === key;
    const removing = removingKey === key;
    // a listed-but-unresumable row (current, Scratch/orphaned, or an unconfigured kind) stays
    // inert with its reason as a hint; the working/asking/duplicate cases only surface server-side,
    // so tapping such a row runs the switch and lets its rejection land as a toast (see doResume)
    return <li key={key} className={`conversation-row${conversation.automatic ? ' automatic' : ''}${conversation.current ? ' current' : ''}`} aria-current={conversation.current ? 'true' : undefined}><button className={`conversation-choice${progressBorder(resuming, 'blue')}`} type="button" aria-busy={resuming || undefined} disabled={blockedReason !== undefined || resumingKey !== undefined} title={blockedReason ?? `Resume ${conversation.name}`} onClick={() => void doResume(conversation)}><ProgressRing busy={resuming} /><span className={`conversation-mark launch-kind-${conversation.kind}`} aria-hidden="true">{agentKindGlyph[conversation.kind]}</span><span className="conversation-copy"><strong>{conversation.name}</strong><small>{agentKindLabel[conversation.kind]} · {relativeAge(conversation.lastActiveAt)}{conversation.automatic ? ' · automatic title' : ''}</small>{blockedReason !== undefined && !conversation.current && <small className="conversation-blocked">{blockedReason}</small>}</span>{conversation.current && <em className="conversation-pill">CURRENT</em>}</button>{removable && <button className={`conversation-remove${progressBorder(removing, 'red')}`} type="button" aria-busy={removing || undefined} disabled={removingKey !== undefined} aria-label={`Remove ${conversation.name} from this list`} title={`Remove ${conversation.name} from this list`} onClick={() => void doRemove(conversation)}><ProgressRing busy={removing} /><svg className="conversation-remove-icon action-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.trash} /></svg></button>}</li>;
  };

  const dialog = dialogOpen && createPortal(<div className="dialog conversations-dialog" role="dialog" aria-modal="true" aria-labelledby="conversations-dialog-title" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeDialog(); } }} onClick={event => { if (event.target === event.currentTarget) closeDialog(); }}><div><header><div><small>NAMED CONVERSATIONS</small><h2 id="conversations-dialog-title">Conversations</h2></div><button type="button" aria-label="Close conversations" title="Close" onClick={closeDialog}><PanelIcon path={panelIcons.close} /></button></header><div className="conversations-tools"><label className="conversations-search"><span className="sr-only">Search conversations</span><input type="search" value={query} placeholder="Search by name or agent" autoFocus onChange={event => setQuery(event.target.value)} /></label>{/* one line of guidance for the whole list; per-row block reasons surface as a toast on tap */}<p className="conversations-note">Tap a conversation to resume it in its home worktree.</p>{/* a resume failure keeps the list; a load failure replaces it (below) */}{error && conversations !== undefined && <p className="conversations-error" role="alert">{error}</p>}</div><div className="conversations-list">{loading && conversations === undefined ? <div className="conversations-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Loading…</div> : error && conversations === undefined ? <p className="conversations-error" role="alert">{error}</p> : matches.length === 0 ? <p className="conversations-empty">{total === 0 ? 'No named conversations in this project yet.' : 'No matches.'}</p> : <>{namedHere.length > 0 && <><p className="conversations-heading">Named here</p><ul className="conversation-rows">{namedHere.map(conversation => row(conversation, true))}</ul></>}{allNamed.length > 0 && <><p className="conversations-heading">All named</p><ul className="conversation-rows">{allNamed.map(conversation => row(conversation))}</ul></>}{reviewRuns.length > 0 && <><p className="conversations-heading">Tour and Review runs</p><ul className="conversation-rows">{reviewRuns.map(conversation => row(conversation, conversation.consoleNamed))}</ul></>}</>}</div><footer><span>{total} named</span><button type="button" onClick={closeDialog}>Close</button></footer></div></div>, document.body);

  // distinguish conversations with left- and right-facing message bubbles
  const control = <div className="conversations-control" ref={anchorRef}><button className={`log-control page-arrow conversations-toggle${menuOpen ? ' active' : ''}${progressBorder(loading, 'blue')}`} type="button" aria-busy={loading || undefined} aria-label={label} title={label} data-context-flyout aria-expanded={menuOpen} disabled={loading} onPointerDown={event => event.preventDefault()} onClick={() => void toggle()}><ProgressRing busy={loading} /><span className="flyout-caret" aria-hidden="true" /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-5 4V5a2 2 0 0 1 2-2Z" /><path d="M20 8a2 2 0 0 1 2 2v11l-4-3h-7a2 2 0 0 1-2-2" /></svg>{consoleNamedCount > 0 && <span className="saved-prompts-count conversations-count" aria-hidden="true">{consoleNamedCount}</span>}</button>{menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div ref={flyoutRef} className="conversations-menu" style={flyoutStyle} aria-label="Conversations">{agentId !== undefined && <form className="conversation-name" onSubmit={event => { event.preventDefault(); void submitName(); }}><input type="text" value={nameDraft} maxLength={120} placeholder={currentName ? `Rename “${currentName}”` : 'Name this conversation'} aria-label="Name this conversation" onChange={event => setNameDraft(event.target.value)} /><button type="submit" className={naming ? 'progress-border progress-blue' : undefined} aria-busy={naming || undefined} disabled={naming || nameDraft.trim() === ''} aria-label="Name conversation"><ProgressRing busy={naming} />Name</button></form>}{error && <p className="conversation-error" role="alert">{error}</p>}{flyoutConsoleNamed.length > 0 && <><p className="conversations-note">Tap a conversation to resume it in its home worktree.</p><ul className="conversation-rows">{flyoutConsoleNamed.map(conversation => row(conversation, true))}</ul></>}<button className="log-control conversations-all" type="button" onClick={() => void openDialog()}><span>All conversations</span><small>{total}</small></button></div></FlyoutPortal>}{dialog}</div>;
  // the current Conversation's name, once the list has loaded (it is fetched on open, never polled)
  return { control, currentName };
}

// manage persistent worktree notes
// `expansion` is the Workspace's: the note pane expands through it, and a retained note view
// restores its expansion into it.
function useWorktreeNotes(worktreeId: string | undefined, expansion: PanelExpansion, agentId?: string, agentWorking = false, latestAssistantMessage?: string, latestAssistantMessageOverflows = false, onPromptHistoryChanged?: () => void | Promise<void>, promptHistory: PromptHistoryEntry[] = [], schedulePrefill?: SchedulePrefill, onLaunchAndRun?: (noteId: string) => Promise<boolean>, launchRunLabel?: string, promptNote?: PromptNoteSource) {
  const noteFeedback = useContext(NoteFeedbackContext);
  // use the shared mobile text-editing breakpoint
  const phone = usePhoneLayout();
  const [notes, setNotes] = useState<WorktreeNote[]>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeNote, setActiveNote] = useState<WorktreeNote>();
  const expanded = expansion.expanded === 'note';
  const { setExpanded: setPanelExpanded } = expansion;
  const setExpanded = useCallback((on: boolean) => setPanelExpanded('note', on), [setPanelExpanded]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useViewportFlyout<HTMLButtonElement>(pickerOpen);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renamePending, setRenamePending] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  // hold split restoration until the saved note has been checked
  const [initialNotesLoaded, setInitialNotesLoaded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [noteMetadataPending, setNoteMetadataPending] = useState(false);
  const [noteMetadataError, setNoteMetadataError] = useState('');
  // serialize note options with other metadata writes
  const noteMetadataMutation = useRef<{ noteId: string; resourceBase: string; option: 'locked' | 'allWorkspaces' } | undefined>(undefined);
  const [menuRenameDraft, setMenuRenameDraft] = useState<{ id: string; title: string }>();
  const [menuRenamingId, setMenuRenamingId] = useState<string>();
  const [menuDeletingId, setMenuDeletingId] = useState<string>();
  const [menuRunningId, setMenuRunningId] = useState<string>();
  // share mutation guards between handlers and controls
  const deleteBusy = deleting || menuDeletingId !== undefined;
  const renameBusy = renamePending || menuRenamingId !== undefined;
  const [menuError, setMenuError] = useState('');
  const [copyState, setCopyState] = useState<'idle'|'copied'|'error'>('idle');
  const [sendState, setSendState] = useState<'idle'|'sending'|'error'>('idle');
  // acknowledge each note independently in its pane and flyout
  const [queuedNoteFeedback, setQueuedNoteFeedback] = useState<Record<string, number>>({});
  const [dirtyCount, setDirtyCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<'saved'|'saving'|'error'>('saved');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleRunning, setScheduleRunning] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [noteAttachmentError, setNoteAttachmentError] = useState('');
  const [draggingNoteFiles, setDraggingNoteFiles] = useState(false);
  const noteAttachmentInput = useRef<HTMLInputElement | null>(null);
  const attachmentMutation = useRef(false);
  const resourceBase = persistenceResourceBase(worktreeId, agentId);
  // scope previews to the currently open note
  const noteFilePreview = useFilePreview(`${resourceBase}/notes/${encodeURIComponent(activeNote?.id ?? '')}/attachments/preview`);
  // keep metadata responses attached to their originating context
  const noteContext = useRef(resourceBase);
  noteContext.current = resourceBase;
  const noteViewId = worktreeId ?? (agentId === undefined ? undefined : `agent:${agentId}`);
  const { generation: dashboardGeneration, notesRevision, serverStartedAt } = useContext(DashboardGenerationContext);
  // scope the in-memory revision to its server process
  const notesRevisionKey = `${serverStartedAt ?? ''}:${notesRevision ?? ''}`;
  const seenGeneration = useRef<number | undefined>(undefined);
  const seenNotesRevision = useRef(notesRevisionKey);
  // order mount, manual and dashboard note loads through one request sequence
  const noteLoadSequence = useRef(0);
  // distinguish queue recovery from ordinary note creation without relying on titles
  const unreadQueuedNotes = useSyncExternalStore(subscribeToQueuedNoteSeen, () => notes?.some(note => note.source === 'queued-prompt' && !seenQueuedNoteIds.has(note.id)) ?? false);
  // opening the list acknowledges its queued notes, including arrivals while it remains open
  useEffect(() => {
    // background refreshes and restored note panes do not acknowledge unseen list entries
    if (menuOpen && notes !== undefined) markQueuedNotesSeen(notes);
  }, [menuOpen, notes]);
  const { anchorRef, flyoutRef, style: flyoutStyle } = useViewportFlyout<HTMLDivElement>(menuOpen, { placement: 'above', align: 'start', contentSized: true });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const titleEditorRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const selectionAtPointerDown = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const activeNoteRef = useRef<WorktreeNote | undefined>(undefined);
  const draftRef = useRef('');
  const acknowledgedTexts = useRef(new Map<string, string>());
  const dirtyTexts = useRef(new Map<string, string>());
  const queuedTexts = useRef(new Map<string, string>());
  const failedNotes = useRef(new Set<string>());
  const saveVersions = useRef(new Map<string, number>());
  const saveQueue = useRef(Promise.resolve());
  const actionStatusTimer = useRef<number | undefined>(undefined);
  const selectionCopiedTimer = useRef<number | undefined>(undefined);
  const [selectionToolbar, setSelectionToolbar] = useState<{ text: string; top: number }>();
  // share save guards with live and pre-launch composers
  const promptPendingKey = `prompt:${agentId ?? promptNote?.id ?? 'unavailable'}`;
  const promptPending = usePendingOperation(promptPendingKey);
  // Retain the open note's expansion with its view. Only an expansion change writes: when the view
  // itself changes, the ref still holds the previous view's note until the reset below clears it.
  const expansionRequest = useRef(expansion.expanded);
  expansionRequest.current = expansion.expanded;
  useEffect(() => {
    const note = activeNoteRef.current;
    if (noteViewId !== undefined && note !== undefined) setWorktreeNoteView(noteViewId, { noteId: note.id, expanded });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // expire clipboard feedback without interrupting prompt feedback
  const clearActionStatusLater = () => {
    // replace only the previous clipboard timer
    if (actionStatusTimer.current !== undefined) window.clearTimeout(actionStatusTimer.current);
    actionStatusTimer.current = window.setTimeout(() => {
      actionStatusTimer.current = undefined;
      setCopyState('idle');
    }, 1_600);
  };
  // retain each successful queue acknowledgement for two seconds
  const markNoteQueued = (noteId: string) => {
    // ignore a completed send from a replaced workspace
    if (noteContext.current !== resourceBase) return;
    setQueuedNoteFeedback(current => ({ ...current, [noteId]: Date.now() + 2_000 }));
  };
  // expire only acknowledgements whose own deadlines have passed
  useEffect(() => {
    const deadlines = Object.values(queuedNoteFeedback);
    // leave no timer behind when all acknowledgements have expired
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(() => {
      setQueuedNoteFeedback(current => Object.fromEntries(Object.entries(current).filter(([, expires]) => expires > Date.now())));
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [queuedNoteFeedback]);

  const persist = useCallback((noteId: string, text: string, immediate = false) => {
    // skip unavailable or duplicate saves
    if (resourceBase === undefined || (!immediate && queuedTexts.current.get(noteId) === text)) return;
    queuedTexts.current.set(noteId, text);
    const version = (saveVersions.current.get(noteId) ?? 0) + 1;
    saveVersions.current.set(noteId, version);
    if (activeNoteRef.current?.id === noteId) setSaveStatus('saving');
    const save = async () => {
      if (!immediate && saveVersions.current.get(noteId) !== version) return;
      try {
        const response = await request(`${resourceBase}/notes/${encodeURIComponent(noteId)}`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (!response.ok) throw new Error('note save failed');
        const saved: unknown = await response.json();
        if (!isWorktreeNote(saved)) throw new Error('invalid saved note');
        if (saveVersions.current.get(noteId) !== version) return;
        acknowledgedTexts.current.set(noteId, text);
        if (queuedTexts.current.get(noteId) === text) queuedTexts.current.delete(noteId);
        if (dirtyTexts.current.get(noteId) === text) dirtyTexts.current.delete(noteId);
        if (!dirtyTexts.current.has(noteId)) failedNotes.current.delete(noteId);
        setDirtyCount(dirtyTexts.current.size);
        // text acknowledgements must not overwrite newer attachment or schedule metadata
        setNotes(current => current?.map(note => note.id === saved.id && !dirtyTexts.current.has(noteId) ? { ...note, text: saved.text } : note));
        if (activeNoteRef.current?.id === noteId) setSaveStatus(dirtyTexts.current.has(noteId) ? failedNotes.current.has(noteId) ? 'error' : 'saving' : 'saved');
      } catch {
        if (saveVersions.current.get(noteId) !== version) return;
        if (queuedTexts.current.get(noteId) === text) queuedTexts.current.delete(noteId);
        if (dirtyTexts.current.get(noteId) === text) {
          failedNotes.current.add(noteId);
          setDirtyCount(dirtyTexts.current.size);
          if (activeNoteRef.current?.id === noteId) setSaveStatus('error');
        }
      }
    };
    if (immediate) void save();
    else saveQueue.current = saveQueue.current.then(save, save);
  }, [resourceBase]);

  const flush = useCallback(() => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const note = activeNoteRef.current;
    const text = note === undefined ? undefined : dirtyTexts.current.get(note.id);
    if (note !== undefined && text !== undefined) persist(note.id, text);
  }, [persist]);
  const flushAll = useCallback((immediate = false) => {
    if (immediate) {
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    } else flush();
    for (const [noteId, text] of dirtyTexts.current) persist(noteId, text, immediate);
  }, [flush, persist]);

  useEffect(() => {
    const pageHiding = () => flushAll(true);
    window.addEventListener('pagehide', pageHiding);
    return () => {
      window.removeEventListener('pagehide', pageHiding);
      flushAll(true);
    };
  }, [flushAll]);
  useEffect(() => () => {
    if (actionStatusTimer.current !== undefined) window.clearTimeout(actionStatusTimer.current);
    if (selectionCopiedTimer.current !== undefined) window.clearTimeout(selectionCopiedTimer.current);
  }, []);
  // reset note editing and refresh state when the selected view changes
  useEffect(() => {
    const retained = noteViewId === undefined ? undefined : getWorktreeNoteView(noteViewId);
    setNotes(undefined);
    noteLoadSequence.current += 1;
    setLoading(false);
    setInitialNotesLoaded(false);
    // reset refresh boundaries with the persistence context
    seenGeneration.current = undefined;
    seenNotesRevision.current = notesRevisionKey;
    setMenuOpen(false);
    setActiveNote(undefined);
    setExpanded(false);
    setEditing(false);
    setRenaming(false);
    setRenamePending(false);
    setTitleDraft('');
    setMenuRenameDraft(undefined);
    setMenuRenamingId(undefined);
    setMenuDeletingId(undefined);
    noteMetadataMutation.current = undefined;
    setNoteMetadataPending(false);
    setNoteMetadataError('');
    setMenuError('');
    setNoteAttachmentError('');
    setDraggingNoteFiles(false);
    activeNoteRef.current = undefined;
    draftRef.current = '';
    acknowledgedTexts.current.clear();
    dirtyTexts.current.clear();
    queuedTexts.current.clear();
    failedNotes.current.clear();
    saveVersions.current.clear();
    setCopyState('idle');
    setSendState('idle');
    setQueuedNoteFeedback({});
    setDirtyCount(0);
  }, [noteViewId]);
  // load and restore the current view without allowing older reads to overwrite newer ones
  useEffect(() => {
    // require one configured or scratch persistence context
    if (resourceBase === undefined || noteViewId === undefined) return;
    let cancelled = false;
    const sequence = ++noteLoadSequence.current;
    setLoading(true);
    void fetchWorktreeNotes(resourceBase).then(loaded => {
      // discard every mutation from a superseded response
      if (cancelled || sequence !== noteLoadSequence.current) return;
      for (const note of loaded) acknowledgedTexts.current.set(note.id, note.text);
      setNotes(loaded);
      // only a successful read can rule out a saved Note split
      setInitialNotesLoaded(true);
      const retained = getWorktreeNoteView(noteViewId);
      if (retained !== undefined) {
        const note = loaded.find(candidate => candidate.id === retained.noteId);
        if (note === undefined) clearWorktreeNoteView(noteViewId);
        else {
          activeNoteRef.current = note;
          draftRef.current = note.text;
          setDraft(note.text);
          setActiveNote(note);
          if (retained.expanded && expansionRequest.current === undefined) setExpanded(true);
          setEditing(false);
        }
      }
    }).catch(() => {
      // surface only the latest load's failure
      if (!cancelled && sequence === noteLoadSequence.current) setSaveStatus('error');
    }).finally(() => {
      // let the latest foreground request own its loading indicator
      if (!cancelled && sequence === noteLoadSequence.current) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [noteViewId, resourceBase]);
  // refresh recovered notes and visibility even while closed; schedule-only changes stay lazy
  useEffect(() => {
    // require a current snapshot and persistence context
    if (resourceBase === undefined || noteViewId === undefined || dashboardGeneration === undefined) return;
    // let foreground loads and option writes settle before consuming revisions
    if (loading || noteMetadataPending) return;
    const previous = seenGeneration.current;
    const notesChanged = notesRevisionKey !== seenNotesRevision.current;
    // establish the baseline on the first snapshot without refetching (the mount load already fetched)
    if (previous === undefined && !notesChanged) { seenGeneration.current = dashboardGeneration; return; }
    // skip snapshots whose notes have already been fetched
    if (previous === dashboardGeneration && !notesChanged) return;
    // keep schedule refreshes lazy without hiding note metadata changes
    if (!menuOpen && activeNote === undefined && !notesChanged) return;
    let cancelled = false;
    const sequence = ++noteLoadSequence.current;
    // capture a clean editor before allowing shared text to refresh
    const cleanAtLoad = activeNoteRef.current !== undefined && !dirtyTexts.current.has(activeNoteRef.current.id) ? activeNoteRef.current : undefined;
    // preserve drafts while refreshing server-owned note metadata
    void fetchWorktreeNotes(resourceBase).then(loaded => {
      // discard obsolete requests without consuming their refresh boundary
      if (cancelled || sequence !== noteLoadSequence.current) return;
      seenGeneration.current = dashboardGeneration;
      seenNotesRevision.current = notesRevisionKey;
      setNotes(loaded);
      // a successful refresh also settles initial split restoration
      setInitialNotesLoaded(true);
      // refresh server-owned metadata without disturbing the live text or draft
      const current = activeNoteRef.current;
      const fresh = current === undefined ? undefined : loaded.find(candidate => candidate.id === current.id);
      // keep the active editor attached to refreshed metadata
      if (current !== undefined && fresh !== undefined) {
        const refreshText = (current.allWorkspaces || fresh.allWorkspaces) && current === cleanAtLoad && !dirtyTexts.current.has(current.id);
        // synchronize shared text only when no local edit raced the request
        if (refreshText) {
          acknowledgedTexts.current.set(current.id, fresh.text);
          draftRef.current = fresh.text;
          setDraft(fresh.text);
        }
        const updated = { ...current, ...(refreshText ? { text: fresh.text } : {}), locked: fresh.locked, allWorkspaces: fresh.allWorkspaces, schedule: fresh.schedule, nextRun: fresh.nextRun, ...(attachmentMutation.current ? {} : { attachments: fresh.attachments }), ...(fresh.title === undefined ? {} : { title: fresh.title }) };
        activeNoteRef.current = updated;
        setActiveNote(updated);
      }
      // remove revoked shared notes while preserving unsaved text for recovery
      if (current?.allWorkspaces && fresh === undefined) {
        // keep a dirty editor available for copying instead of discarding its draft
        if (dirtyTexts.current.has(current.id)) setNoteMetadataError('This note is no longer available in this workspace. Copy your unsaved text before closing.');
        else forgetNote(current, false);
      }
    }).catch(() => undefined).finally(() => {
      // the latest read also releases any foreground indicator it superseded
      if (!cancelled && sequence === noteLoadSequence.current) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [dashboardGeneration, notesRevisionKey, resourceBase, noteViewId, menuOpen, activeNote, loading, noteMetadataPending]);
  // let a sibling component (the queued panel's Save as note, which lives in Prompt) force this
  // note view's list to refetch, so a newly saved Note appears when the fly-out is next opened
  useEffect(() => {
    if (noteViewId === undefined) return;
    const reload = () => { void load(true); };
    noteReloadRequests.set(noteViewId, reload);
    return () => { if (noteReloadRequests.get(noteViewId) === reload) noteReloadRequests.delete(noteViewId); };
  }, [noteViewId, resourceBase]);
  useLayoutEffect(() => { if (activeNote !== undefined && editing) editorRef.current?.focus(); }, [activeNote?.id, editing]);
  useLayoutEffect(() => { if (activeNote !== undefined && renaming) titleEditorRef.current?.select(); }, [activeNote?.id, renaming]);
  useEffect(() => {
    setSelectionToolbar(undefined);
    const preview = previewRef.current;
    if (preview === null || activeNote === undefined || editing) return;
    const syncSelection = () => {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0 || selection.anchorNode === null || selection.focusNode === null || !preview.contains(selection.anchorNode) || !preview.contains(selection.focusNode)) {
        setSelectionToolbar(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      const bounds = Array.from(range.getClientRects()).at(-1) ?? range.getBoundingClientRect();
      const text = selection.toString();
      if (!text) return setSelectionToolbar(undefined);
      setSelectionToolbar({ text, top: Math.max(8, Math.min(window.innerHeight - 48, bounds.bottom + 8)) });
    };
    document.addEventListener('selectionchange', syncSelection);
    preview.addEventListener('scroll', syncSelection);
    window.addEventListener('resize', syncSelection);
    syncSelection();
    return () => {
      document.removeEventListener('selectionchange', syncSelection);
      preview.removeEventListener('scroll', syncSelection);
      window.removeEventListener('resize', syncSelection);
    };
  }, [activeNote?.id, editing]);

  const restoreTriggerFocus = () => window.requestAnimationFrame(() => triggerRef.current?.focus());
  // open one note without abandoning pending metadata writes
  const open = (note: WorktreeNote, edit?: boolean, keepExpansion = false) => {
    // keep metadata mutations attached to the visible note
    if (attachmentMutation.current || noteMetadataMutation.current !== undefined) return;
    flush();
    const text = dirtyTexts.current.get(note.id) ?? note.text;
    const opened = { ...note, text };
    const editingOnOpen = edit ?? !text.trim();
    activeNoteRef.current = opened;
    draftRef.current = text;
    if (!acknowledgedTexts.current.has(note.id)) acknowledgedTexts.current.set(note.id, note.text);
    setDraft(text);
    setActiveNote(opened);
    const stayExpanded = keepExpansion && expanded;
    // reveal notes hidden by an expanded sibling while preserving picker navigation
    if (!keepExpansion) expansion.restore();
    // retain this context's open note
    if (noteViewId !== undefined) setWorktreeNoteView(noteViewId, { noteId: note.id, expanded: stayExpanded });
    setEditing(editingOnOpen);
    setRenaming(false);
    setTitleDraft(note.title ?? '');
    setCopyState('idle');
    setSendState('idle');
    setNoteAttachmentError('');
    setNoteMetadataError('');
    setSaveStatus(failedNotes.current.has(note.id) ? 'error' : dirtyTexts.current.has(note.id) ? 'saving' : 'saved');
    setMenuOpen(false);
    if (dirtyTexts.current.has(note.id)) persist(note.id, text);
  };
  // preserve the saved snapshot while visibility may revoke this workspace's access
  const updateDraft = (note: WorktreeNote, text: string) => {
    // preserve the snapshot during visibility writes and deletion
    if (noteMetadataMutation.current?.option === 'allWorkspaces' || deleting || menuDeletingId === note.id) return;
    draftRef.current = text;
    activeNoteRef.current = { ...note, text };
    setDraft(text);
    setCopyState('idle');
    setSendState('idle');
    setNotes(current => current?.map(candidate => candidate.id === note.id ? { ...candidate, text } : candidate));
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    failedNotes.current.delete(note.id);
    const clean = text === acknowledgedTexts.current.get(note.id) && queuedTexts.current.get(note.id) === undefined;
    if (clean) {
      dirtyTexts.current.delete(note.id);
      saveTimer.current = undefined;
      setDirtyCount(dirtyTexts.current.size);
      setSaveStatus('saved');
      return;
    }
    dirtyTexts.current.set(note.id, text);
    setDirtyCount(dirtyTexts.current.size);
    setSaveStatus('saving');
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      persist(note.id, dirtyTexts.current.get(note.id) ?? draftRef.current);
    }, 500);
  };
  // refresh on demand without publishing responses superseded by another note read
  const load = async (force = false) => {
    // require one persistence context
    if (resourceBase === undefined) return undefined;
    // reuse the current snapshot unless explicitly refreshing
    if (!force && notes !== undefined) return notes;
    // capture note writes that can race this server snapshot
    const saveVersionsAtLoad = new Map(saveVersions.current);
    const dirtyAtLoad = new Set(dirtyTexts.current.keys());
    const queuedAtLoad = new Set(queuedTexts.current.keys());
    const sequence = ++noteLoadSequence.current;
    setLoading(true);
    try {
      const loaded = await fetchWorktreeNotes(resourceBase);
      // stale reads must not change text acknowledgements or visible notes
      if (sequence !== noteLoadSequence.current) return undefined;
      // retain local text while accepting refreshed metadata and restored notes
      const merged = loaded.map(note => {
        const dirtyText = dirtyTexts.current.get(note.id);
        const queuedText = queuedTexts.current.get(note.id);
        const writeRacedLoad = (saveVersions.current.get(note.id) ?? 0) !== (saveVersionsAtLoad.get(note.id) ?? 0);
        const touched = dirtyAtLoad.has(note.id) || queuedAtLoad.has(note.id) || dirtyText !== undefined || queuedText !== undefined || writeRacedLoad;
        // acknowledge only notes untouched throughout this read
        if (!touched) {
          acknowledgedTexts.current.set(note.id, note.text);
          return note;
        }
        // prefer the newest local save boundary over stale server text
        return { ...note, text: dirtyText ?? queuedText ?? acknowledgedTexts.current.get(note.id) ?? note.text };
      });
      setNotes(merged);
      // a manual retry can complete an earlier failed initial read
      setInitialNotesLoaded(true);
      return merged;
    } catch {
      // ignore failures from replaced requests
      if (sequence === noteLoadSequence.current) setSaveStatus('error');
      return undefined;
    } finally {
      // preserve a newer request's loading indicator
      if (sequence === noteLoadSequence.current) setLoading(false);
    }
  };
  // create an optionally titled note
  const create = async (text = '', title?: string): Promise<boolean> => {
    // require one idle persistence context
    if (resourceBase === undefined || loading || noteMetadataMutation.current !== undefined) return false;
    setLoading(true);
    try {
      const response = await request(`${resourceBase}/notes`, { method: 'POST', ...(title === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }) });
      const note: unknown = response.ok ? await response.json() : undefined;
      // reject unsuccessful or malformed note creation
      if (!isWorktreeNote(note)) throw new Error();
      acknowledgedTexts.current.set(note.id, note.text);
      setNotes(current => [note, ...(current ?? [])]);
      open(note, !text.trim());
      // save selected text through the existing editor queue
      if (text) updateDraft(note, text);
      return true;
    } catch { setSaveStatus('error'); return false; }
    finally { setLoading(false); }
  };
  // toggle notes menu
  const toggle = async () => {
    if (menuOpen) return setMenuOpen(false);
    // refresh completed historical responses before choosing one
    await onPromptHistoryChanged?.();
    const loaded = await load();
    if (loaded === undefined) return;
    setMenuError('');
    setMenuOpen(true);
  };
  const changeDraft = (text: string) => {
    const note = activeNoteRef.current;
    if (note === undefined) return;
    updateDraft(note, text);
  };
  const appendToActive = (text: string) => {
    const note = activeNoteRef.current;
    const next = appendTextBlock(draftRef.current, text);
    if (note === undefined || !text || next.length > 30_000) return;
    updateDraft(note, next);
  };
  // disallow selection appends while visibility is being saved
  const canAppendToActive = (text: string) => noteMetadataMutation.current?.option !== 'allWorkspaces' && activeNoteRef.current !== undefined && appendTextBlock(draftRef.current, text).length <= 30_000;
  const copy = async () => {
    try {
      await copyText(draftRef.current);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    clearActionStatusLater();
  };
  const copySelection = async (text: string) => {
    await copyText(text);
    const preview = previewRef.current;
    preview?.classList.add('selection-copied');
    if (selectionCopiedTimer.current !== undefined) window.clearTimeout(selectionCopiedTimer.current);
    selectionCopiedTimer.current = window.setTimeout(() => {
      selectionCopiedTimer.current = undefined;
      preview?.classList.remove('selection-copied');
    }, selectionCopyFlashMs);
  };
  // keep file mutations separate from lightweight text autosaves
  const changeNoteAttachments = async (filesOrName: File[] | string) => {
    const note = activeNoteRef.current;
    // serialize file changes with actions that consume or delete the note
    if (resourceBase === undefined || note === undefined || attachmentMutation.current || noteMetadataMutation.current !== undefined || deleting || sendState === 'sending' || menuRunningId !== undefined) return;
    attachmentMutation.current = true;
    setAttachmentPending(true);
    setNoteAttachmentError('');
    const base = resourceBase;
    const path = `${base}/notes/${encodeURIComponent(note.id)}/attachments`;
    try {
      const response = typeof filesOrName === 'string'
        ? await request(`${path}?name=${encodeURIComponent(filesOrName)}`, { method: 'DELETE' })
        : await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attachments: await Promise.all(filesOrName.map(encodeAttachment)) }) });
      // retain the existing files when the server rejects a mutation
      if (!response.ok) throw new Error();
      const saved: unknown = await response.json();
      // require an acknowledged note in the original persistence context
      if (!isWorktreeNote(saved) || saved.id !== note.id) throw new Error();
      // ignore responses belonging to a tab that is no longer selected
      if (noteContext.current !== base) return;
      noteLoadSequence.current += 1;
      setLoading(false);
      // merge only file metadata so concurrent text edits remain intact
      setNotes(current => current?.map(candidate => candidate.id === note.id ? { ...candidate, attachments: saved.attachments } : candidate));
      const current = activeNoteRef.current;
      // retain the open editor's text and schedule state
      if (current?.id === note.id) {
        const updated = { ...current, attachments: saved.attachments };
        activeNoteRef.current = updated;
        setActiveNote(updated);
        setSendState('idle');
      }
    } catch {
      // surface failures only in the originating note context
      if (noteContext.current === base) setNoteAttachmentError(typeof filesOrName === 'string' ? 'Unable to remove this attachment. Please try again.' : 'Unable to save these attachments. Check the file limits and try again.');
    } finally {
      attachmentMutation.current = false;
      setAttachmentPending(false);
    }
  };
  // validate the combined file set before reading or uploading bytes
  const chooseNoteFiles = (files: FileList | File[] | null) => {
    const note = activeNoteRef.current;
    // preserve pending snapshots and ignore cancelled file pickers
    if (files === null || files.length === 0 || note === undefined || attachmentMutation.current) return;
    const selected = Array.from(files);
    const combined = [...(note.attachments ?? []), ...selected];
    // reject the entire addition rather than silently dropping files
    if (combined.reduce((sum, file) => sum + file.size, 0) > maxAttachmentBytes) return setNoteAttachmentError(`Attachments must total ${maxAttachmentMegabytes} MB or less.`);
    const names = new Set<string>();
    // enforce the server's normalized filename policy
    for (const file of combined) {
      const name = file.name.trim();
      // reject unreadable empty files and unsafe names before upload
      if (!name || name === '.' || name === '..' || name.length > 240 || /[\\/\0\r\n]/u.test(name) || file.size === 0) return setNoteAttachmentError('Choose non-empty files with valid filenames.');
      // avoid ambiguous removals and accidental duplicate uploads
      if (names.has(name)) return setNoteAttachmentError(`An attachment named ${name} already exists.`);
      names.add(name);
    }
    void changeNoteAttachments(selected);
  };
  // block actions while note options are being saved
  const noteVisibilityPending = noteMetadataPending && noteMetadataMutation.current?.option === 'allWorkspaces';
  const noteFilesDisabled = attachmentPending || noteMetadataPending || deleting || sendState === 'sending' || menuRunningId !== undefined;
  // accept files without changing ordinary text and link dragging
  const dragNoteFiles = (event: React.DragEvent<HTMLElement>) => {
    // browser file contents remain protected until drop
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = noteFilesDisabled ? 'none' : 'copy';
    setDraggingNoteFiles(!noteFilesDisabled);
  };
  // keep the drop indicator while moving between note children
  const leaveNoteFiles = (event: React.DragEvent<HTMLElement>) => {
    // ignore transitions inside the same note
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDraggingNoteFiles(false);
  };
  // apply the picker policy to file drops
  const dropNoteFiles = (event: React.DragEvent<HTMLElement>) => {
    setDraggingNoteFiles(false);
    // leave text dragging to the editor
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    // prevent changes while another action owns the note
    if (noteFilesDisabled) return;
    // reject directory placeholders rather than losing their contents
    if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) return setNoteAttachmentError('Folders cannot be attached. Drop individual files instead.');
    chooseNoteFiles(event.dataTransfer.files);
  };
  // preserve normal paste while attaching clipboard images
  const pasteNoteFiles = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    // let the browser insert clipboard text normally
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    // preserve an in-flight attachment snapshot
    if (!noteFilesDisabled) chooseNoteFiles(files);
  };
  // send the current text and fetch its saved files on demand
  const send = async () => {
    const prompt = draftRef.current;
    const note = activeNoteRef.current;
    // allow attachment-only notes without racing file writes
    if (resourceBase === undefined || note === undefined || agentId === undefined || !noteHasContent({ ...note, text: prompt }) || deleting || attachmentMutation.current || sendState === 'sending' || !beginPendingOperation(promptPendingKey, agentItemKey({ id: agentId, worktreeId }))) return;
    flush();
    setSendState('sending');
    setCopyState('idle');
    // a retry must not display an earlier success after it fails
    setQueuedNoteFeedback(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== note.id)));
    try {
      const attachments = await fetchNoteAttachments(resourceBase, note);
      const response = await request(`/api/agents/${encodeURIComponent(agentId)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, attachments }) });
      // report dispatch failures without clearing saved note content
      if (!response.ok) throw new Error();
      markNoteQueued(note.id);
      // keep completed sends from changing another note's pending state
      if (noteContext.current === resourceBase && activeNoteRef.current?.id === note.id) setSendState('idle');
      // history refresh failures do not turn accepted prompts into failed sends
      void Promise.resolve().then(onPromptHistoryChanged).catch(() => undefined);
    } catch {
      // keep failed sends attached to their originating note
      if (noteContext.current === resourceBase && activeNoteRef.current?.id === note.id) setSendState('error');
    } finally {
      setPendingOperation(promptPendingKey, false);
    }
  };
  // an idle worktree tab has no agent to prompt, so Run launches one first and runs the note on it
  const launchAndRunMode = agentId === undefined && onLaunchAndRun !== undefined;
  // reflect dashboard activity without changing server-owned prompt dispatch
  const noteActionLabel = agentWorking ? 'Queue note' : 'Send note';
  const noteActionIcon = agentWorking ? actionIconPaths.queue : actionIconPaths.send;
  // run one note: prompt the live agent (queues behind busy work), or — on an idle worktree
  // tab — launch an agent first and let it run the note, switching to the new agent tab
  const runNote = async (note: WorktreeNote) => {
    // serialize flyout mutations and attachment snapshots
    if (resourceBase === undefined || attachmentMutation.current || menuRunningId !== undefined || menuDeletingId !== undefined || menuRenamingId !== undefined) return;
    const promptOperation = !launchAndRunMode && agentId !== undefined;
    // keep live-agent note dispatch outside workspace shutdown
    if (promptOperation && !beginPendingOperation(promptPendingKey, agentItemKey({ id: agentId, worktreeId }))) return;
    setMenuRunningId(note.id);
    setMenuError('');
    // clear only this note's previous acknowledgement before retrying
    setQueuedNoteFeedback(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== note.id)));
    try {
      // wait for text persistence before launching from the stored note
      if (launchAndRunMode) {
        // persist the open note and let the queued save land before the server reads it, so the
        // Run submits the current text; the launch toasts and the tab switch carry the outcome
        flush();
        await saveQueue.current;
        await onLaunchAndRun!(note.id);
      // include saved files when sending directly to an existing agent
      } else if (agentId !== undefined && noteHasContent(note)) {
        const attachments = await fetchNoteAttachments(resourceBase, note);
        const response = await request(`/api/agents/${encodeURIComponent(agentId)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: note.text, attachments }) });
        // preserve the saved note after a failed dispatch
        if (!response.ok) throw new Error();
        markNoteQueued(note.id);
        // refresh history independently from the accepted prompt
        void Promise.resolve().then(onPromptHistoryChanged).catch(() => undefined);
      }
    } catch {
      setMenuError('Unable to run note');
    } finally {
      // release only the live-agent dispatch claimed here
      if (promptOperation) setPendingOperation(promptPendingKey, false);
      setMenuRunningId(undefined);
    }
  };
  // persist one note title while retaining local text
  const renameNote = async (note: WorktreeNote, title: string) => {
    // require one idle persistence context
    if (resourceBase === undefined || deleteBusy) throw new Error('note rename unavailable');
    const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    // require a complete renamed note
    if (!response.ok) throw new Error('note rename unavailable');
    const saved: unknown = await response.json();
    // reject malformed rename responses
    if (!isWorktreeNote(saved) || saved.title === undefined) throw new Error('note rename unavailable');
    setNotes(current => current?.map(candidate => candidate.id === note.id ? { ...candidate, title: saved.title } : candidate));
    const current = activeNoteRef.current;
    // keep the open note synchronized
    if (current?.id === note.id) {
      const renamed = { ...current, title: saved.title, text: dirtyTexts.current.get(note.id) ?? draftRef.current };
      activeNoteRef.current = renamed;
      setActiveNote(renamed);
      setTitleDraft(saved.title);
    }
    return saved.title;
  };
  // persist a note title
  const saveTitle = async () => {
    const note = activeNoteRef.current;
    const title = titleDraft.trim();
    // require one valid pane rename
    if (resourceBase === undefined || note === undefined || renamePending || deleteBusy || !title) return;
    // close unchanged names without writing
    if (title === note.title) {
      setRenaming(false);
      return;
    }
    setRenamePending(true);
    try {
      await renameNote(note, title);
      setRenaming(false);
    } catch { setSaveStatus('error'); }
    finally { setRenamePending(false); }
  };
  // persist an inline flyout title
  const saveMenuTitle = async () => {
    const title = menuRenameDraft?.title.trim();
    const note = notes?.find(candidate => candidate.id === menuRenameDraft?.id);
    // require one valid menu rename
    if (note === undefined || menuRenameDraft === undefined || menuRenamingId !== undefined || deleteBusy || !title) return;
    // close unchanged names without writing
    if (title === note.title) {
      setMenuRenameDraft(undefined);
      return;
    }
    setMenuRenamingId(note.id);
    setMenuError('');
    try {
      await renameNote(note, title);
      setMenuRenameDraft(undefined);
    } catch {
      setMenuError('Unable to rename note');
    } finally {
      setMenuRenamingId(undefined);
    }
  };
  // change one note option without replacing the current draft
  const toggleNoteOption = async (option: 'locked' | 'allWorkspaces') => {
    const note = activeNoteRef.current;
    // serialize options with deletes, renames, schedules and attachment writes
    if (resourceBase === undefined || note === undefined || noteMetadataMutation.current !== undefined || deleteBusy || renameBusy || scheduleBusy || scheduleRunning || attachmentMutation.current) return;
    const mutation = { noteId: note.id, resourceBase, option };
    const enabled = !note[option];
    noteMetadataMutation.current = mutation;
    setNoteMetadataPending(true);
    setNoteMetadataError('');
    try {
      // save before unsharing can remove this workspace's access
      if (option === 'allWorkspaces') {
        flush();
        await saveQueue.current;
        // keep unsaved content accessible after a failed autosave
        if (dirtyTexts.current.has(note.id)) throw new Error('note save unavailable');
        // do not write after switching persistence contexts
        if (noteMetadataMutation.current !== mutation || noteContext.current !== mutation.resourceBase) return;
      }
      const route = option === 'locked' ? 'lock' : 'visibility';
      const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}/${route}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [option]: enabled }) });
      // retain the last confirmed state after rejected writes
      if (!response.ok) throw new Error('note option unavailable');
      const saved: unknown = await response.json();
      // require confirmation of the requested option
      if (!isWorktreeNote(saved) || saved.id !== mutation.noteId || Boolean(saved[option]) !== enabled) throw new Error('invalid note option response');
      const visibleHere = (saved as WorktreeNote & { visibleHere?: unknown }).visibleHere;
      // visibility responses must confirm access after the change
      if (option === 'allWorkspaces' && typeof visibleHere !== 'boolean') throw new Error('invalid note visibility response');
      // ignore responses from a replaced worktree or scratch context
      if (noteMetadataMutation.current !== mutation || noteContext.current !== mutation.resourceBase) return;
      noteLoadSequence.current += 1;
      setLoading(false);
      // close a shared note removed from this workspace without deleting its original
      if (option === 'allWorkspaces' && !visibleHere) {
        forgetNote(note, true);
        return;
      }
      // merge only the changed option so concurrent edits remain intact
      setNotes(current => current?.map(candidate => candidate.id === note.id ? { ...candidate, [option]: enabled } : candidate));
      const current = activeNoteRef.current;
      // preserve the active note's live text and other metadata
      if (current?.id === note.id) {
        const updated = { ...current, [option]: enabled };
        activeNoteRef.current = updated;
        setActiveNote(updated);
      }
    } catch {
      // surface failures only in their originating context
      if (noteMetadataMutation.current === mutation && noteContext.current === mutation.resourceBase) setNoteMetadataError(option === 'allWorkspaces' ? 'Unable to change note visibility. Your draft is preserved. Please try again.' : enabled ? 'Unable to lock note. Please try again.' : 'Unable to unlock note. Please try again.');
    } finally {
      // do not release a newer context's pending operation
      if (noteMetadataMutation.current === mutation) {
        noteMetadataMutation.current = undefined;
        setNoteMetadataPending(false);
      }
    }
  };
  // remove one deleted note from local state
  const forgetNote = (note: WorktreeNote, restoreFocusAfterClose: boolean) => {
    acknowledgedTexts.current.delete(note.id);
    dirtyTexts.current.delete(note.id);
    queuedTexts.current.delete(note.id);
    failedNotes.current.delete(note.id);
    saveVersions.current.delete(note.id);
    setDirtyCount(dirtyTexts.current.size);
    setNotes(current => current?.filter(candidate => candidate.id !== note.id));
    setMenuRenameDraft(current => current?.id === note.id ? undefined : current);
    // close the pane when it displayed the deleted note
    if (activeNoteRef.current?.id === note.id) {
      activeNoteRef.current = undefined;
      // clear this context's retained note
      if (noteViewId !== undefined) clearWorktreeNoteView(noteViewId);
      setActiveNote(undefined);
      setExpanded(false);
      setEditing(false);
      setRenaming(false);
      // restore toolbar focus for pane deletes
      if (restoreFocusAfterClose) restoreTriggerFocus();
    }
  };
  // delete one note after pending saves settle
  const deleteNote = async (note: WorktreeNote, restoreFocusAfterClose: boolean) => {
    // keep every local deletion path behind the confirmed protection state
    if (note.locked || noteMetadataMutation.current !== undefined || renameBusy || scheduleBusy || scheduleRunning) throw new Error('note is busy or locked');
    // stop the debounce before preserving the exact draft for undo
    if (activeNoteRef.current?.id === note.id && saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    const text = dirtyTexts.current.get(note.id);
    // preserve unsaved edits in the server's deletion snapshot
    if (text !== undefined) persist(note.id, text);
    await saveQueue.current;
    // do not delete a draft the server could not preserve
    if (dirtyTexts.current.has(note.id)) throw new Error('note save failed');
    // require one persistence context
    if (resourceBase === undefined) throw new Error('note delete unavailable');
    // keep deletion compatible with proxies that forward chunked mutation bodies
    const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}`, emptyJsonMutation('DELETE'));
    // retain the note after a failed delete
    if (!response.ok) throw new Error('note delete unavailable');
    const deleted: unknown = await response.json().catch(() => undefined);
    const undoToken = (deleted as { undoToken?: unknown } | undefined)?.undoToken;
    // never announce a recoverable deletion without its matching server snapshot
    if (!isWorktreeNote(deleted) || deleted.id !== note.id || typeof undoToken !== 'string' || !undoToken.trim()) throw new Error('invalid note deletion response');
    noteFeedback?.deleted(noteName(deleted), undoToken);
    // leave a replacement workspace's note state and focus alone
    if (noteContext.current === resourceBase) {
      // prevent a pre-delete list response from resurrecting the note locally
      noteLoadSequence.current += 1;
      setLoading(false);
      forgetNote(note, restoreFocusAfterClose);
    }
  };
  // remove an unlocked note from its header or blank-note cleanup
  const remove = () => {
    const note = activeNoteRef.current;
    // serialize pane deletes
    if (resourceBase === undefined || note === undefined || note.locked || noteMetadataMutation.current !== undefined || deleting || renameBusy || attachmentMutation.current) return;
    setDeleting(true);
    void deleteNote(note, true).catch(() => {
      // preserve dirty state after a failed pane delete
      if (dirtyTexts.current.has(note.id)) failedNotes.current.add(note.id);
      setDirtyCount(dirtyTexts.current.size);
      setSaveStatus('error');
    }).finally(() => setDeleting(false));
  };
  // delete one note from the flyout
  const removeFromMenu = async (note: WorktreeNote) => {
    // serialize menu deletes
    if (note.locked || noteMetadataMutation.current !== undefined || menuDeletingId !== undefined || renameBusy) return;
    setMenuDeletingId(note.id);
    setMenuError('');
    try {
      await deleteNote(note, false);
    } catch {
      setMenuError('Unable to delete note');
    } finally {
      setMenuDeletingId(undefined);
    }
  };
  // retain shared, locked and attachment-only notes when closing the pane
  const close = () => {
    // wait for metadata writes before deciding whether a blank note is disposable
    if (attachmentMutation.current || noteMetadataMutation.current !== undefined) return;
    // remove only local unlocked notes without text or files
    if (!activeNoteRef.current?.locked && !activeNoteRef.current?.allWorkspaces && !noteHasContent({ text: draftRef.current, attachments: activeNoteRef.current?.attachments })) {
      remove();
      return;
    }
    flush();
    activeNoteRef.current = undefined;
    // clear this context's retained note
    if (noteViewId !== undefined) clearWorktreeNoteView(noteViewId);
    setActiveNote(undefined);
    setExpanded(false);
    setEditing(false);
    setRenaming(false);
    restoreTriggerFocus();
  };
  // merge a server Schedule update (schedule + computed nextRun) into local note state
  const mergeScheduleUpdate = (noteId: string, saved: WorktreeNote) => {
    setNotes(current => current?.map(candidate => candidate.id === noteId ? { ...candidate, schedule: saved.schedule, nextRun: saved.nextRun } : candidate));
    const current = activeNoteRef.current;
    // keep the open note synchronized
    if (current?.id === noteId) {
      const updated = { ...current, schedule: saved.schedule, nextRun: saved.nextRun };
      activeNoteRef.current = updated;
      setActiveNote(updated);
    }
  };
  // set or replace the open note's Schedule; the server returns it with nextRun
  const applySchedule = async (payload: ScheduleSetBody) => {
    const note = activeNoteRef.current;
    // serialize schedule writes for the open note
    if (resourceBase === undefined || note === undefined || scheduleBusy || deleteBusy || attachmentMutation.current) return;
    setScheduleBusy(true);
    try {
      const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}/schedule`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error('schedule save failed');
      const saved: unknown = await response.json();
      // reject malformed schedule responses
      if (!isWorktreeNote(saved)) throw new Error('invalid schedule response');
      mergeScheduleUpdate(note.id, saved);
    } catch { setSaveStatus('error'); }
    finally { setScheduleBusy(false); }
  };
  // remove the open note's Schedule, keeping the note
  const removeSchedule = async () => {
    const note = activeNoteRef.current;
    // preserve metadata while deletion captures its undo snapshot
    if (resourceBase === undefined || note === undefined || scheduleBusy || deleteBusy) return;
    setScheduleBusy(true);
    try {
      const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}/schedule`, { method: 'DELETE' });
      if (!response.ok) throw new Error('schedule remove failed');
      const saved: unknown = await response.json();
      if (!isWorktreeNote(saved)) throw new Error('invalid schedule response');
      mergeScheduleUpdate(note.id, saved);
    } catch { setSaveStatus('error'); }
    finally { setScheduleBusy(false); }
  };
  // Run the open note's Schedule now — synchronously on the server, exactly as the scheduler
  // will — and merge the recorded lastRun back into the note. A conflicting in-flight Run (409)
  // or any failure surfaces through the pane's save-status alert.
  const runScheduleNow = async () => {
    const note = activeNoteRef.current;
    // let note mutations finish before reading the stored run snapshot
    if (resourceBase === undefined || note === undefined || scheduleBusy || scheduleRunning || deleteBusy || attachmentMutation.current) return;
    setScheduleRunning(true);
    try {
      const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}/schedule/run`, { method: 'POST' });
      if (!response.ok) throw new Error('schedule run failed');
      const saved: unknown = await response.json();
      if (!isWorktreeNote(saved)) throw new Error('invalid schedule response');
      mergeScheduleUpdate(note.id, saved);
    } catch { setSaveStatus('error'); }
    finally { setScheduleRunning(false); }
  };
  // the server owns the clock, the zone and the parser, so the next-runs preview and the
  // raw-cron field's validity are both fetched, never computed here
  const previewSchedule = async (cron: string): Promise<{ next: string[]; error?: string }> => {
    const response = await request(`/api/schedule/preview?cron=${encodeURIComponent(cron)}`);
    const payload = await response.json().catch(() => ({})) as { next?: unknown; error?: unknown };
    if (!response.ok) return { next: [], error: typeof payload.error === 'string' ? payload.error : 'invalid cron expression' };
    return { next: Array.isArray(payload.next) ? payload.next.filter((value): value is string => typeof value === 'string') : [] };
  };

  // hide notes without any persistence context
  if (resourceBase === undefined) return { active: false, appendToActive, canAppendToActive, canCreate: false, canClose: false, close, control: null, createWithText: create, pane: null, toggleMenu: undefined };
  const noteCount = notes?.length ?? 0;
  const substantialResponse = latestSubstantialResponse(latestAssistantMessage, promptHistory);
  const latestResponseAvailable = notes !== undefined && substantialResponse !== undefined && !notes.some(note => note.text === substantialResponse);
  const highlightLatestResponse = latestResponseAvailable && substantialResponse === latestAssistantMessage && latestAssistantMessageOverflows;
  const notesLabel = dirtyCount === 0 ? `Notes (${noteCount})` : `Notes (${noteCount}; ${dirtyCount} unsaved)`;
  const noteMenuBusy = attachmentPending || noteMetadataPending || deleteBusy || renameBusy || menuRunningId !== undefined;
  // retain recovered-prompt attention while the notes list acknowledges it
  const control = <div className="notes-control" ref={anchorRef}>
    <button ref={triggerRef} className={`log-control page-arrow notes-toggle toolbar-button${unreadQueuedNotes ? ' unread-queued-prompts' : ''}${menuOpen || activeNote !== undefined ? ' active' : ''}${activeNote !== undefined ? ' panel-open' : ''}${dirtyCount > 0 ? ' unsaved' : ''}${highlightLatestResponse ? ' latest-response-available' : ''}${progressBorder(loading, 'blue')}`} aria-busy={loading || undefined} aria-label={notesLabel} title={`${notesLabel}${unreadQueuedNotes ? ' — unread queued prompts' : ''}`} data-context-flyout aria-expanded={menuOpen} disabled={loading} onPointerDown={event => event.preventDefault()} onClick={() => void toggle()}><ProgressRing busy={loading} /><span className="flyout-caret" aria-hidden="true" /><svg className="notes-icon" viewBox="0 0 24 24" aria-hidden="true"><path className="notes-icon-sheet" d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 21v-6h6" /></svg><span className="toolbar-label">Notes</span>{noteCount > 0 && <span className={`saved-prompts-count notes-count${unreadQueuedNotes ? ' unread' : ''}`} aria-hidden="true">{noteCount}</span>}</button>
    {menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div ref={flyoutRef} className="notes-menu" style={flyoutStyle} aria-label={worktreeId === undefined ? 'Scratch notes' : 'Worktree notes'}>
      <div className="note-capture-actions">
        <button className="log-control save-latest-response" disabled={!latestResponseAvailable || noteMenuBusy || menuRenameDraft !== undefined} onClick={() => {
          // save only an available response
          if (substantialResponse !== undefined) void create(substantialResponse, assistantNoteTitle(substantialResponse));
        }}>Save latest response</button>
        <SaveCurrentPromptButton source={promptNote} disabled={loading || noteMenuBusy || menuRenameDraft !== undefined} />
      </div>
      {launchAndRunMode && launchRunLabel !== undefined && <p className="note-menu-hint">No agent on this tab: Run becomes Launch and run ({launchRunLabel}).</p>}
      {menuError && <p className="note-menu-error" role="alert">{menuError}</p>}
      {notes?.map(note => {
        // render one sticky note row
        const label = noteName(note);
        const editingTitle = menuRenameDraft?.id === note.id;
        const noteQueued = queuedNoteFeedback[note.id] !== undefined;
        // resolve queued and launch feedback before rendering the action
        let actionTitle = noteActionLabel;
        let actionIcon = <svg viewBox="0 0 24 24" aria-hidden="true"><path d={noteActionIcon} /></svg>;
        if (noteQueued) {
          actionTitle = 'Note queued';
          actionIcon = <PanelIcon path={panelIcons.check} />;
        } else if (launchAndRunMode) {
          actionTitle = 'Launch and run note';
          actionIcon = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v11l9-5.5L7 4Z" /><path d="M4 20h16" /></svg>;
        }
        const running = menuRunningId === note.id;
        const menuDeleting = menuDeletingId === note.id;
        // require unlocking in the note header before exposing deletion
        const deletionControl = note.locked
          ? <button className="log-control note-menu-lock" type="button" disabled aria-label={`Locked note: ${label}`} title="Open note to unlock before deleting"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.lock} /></svg></button>
          : <button className={`log-control note-menu-delete${progressBorder(menuDeleting, 'red')}`} type="button" aria-busy={menuDeleting || undefined} disabled={noteMenuBusy || menuRenameDraft !== undefined || scheduleBusy || scheduleRunning} aria-label={`Delete note: ${label}`} title="Delete note" onClick={() => void removeFromMenu(note)}><ProgressRing busy={menuDeleting} /><svg className="action-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.trash} /></svg></button>;
        return <div className="note-row" key={note.id}>{editingTitle ? <form className="note-menu-rename-form" onSubmit={event => { event.preventDefault(); void saveMenuTitle(); }} onKeyDown={event => {
          // save or cancel from the keyboard
          if (event.key === 'Escape') { event.preventDefault(); setMenuRenameDraft(undefined); }
        }}><input aria-label="Note name" value={menuRenameDraft.title} maxLength={120} autoFocus disabled={menuRenamingId !== undefined} onChange={event => setMenuRenameDraft({ id: note.id, title: event.target.value })} /><button className={`log-control note-menu-rename-save${progressBorder(menuRenamingId === note.id, 'blue')}`} type="submit" aria-busy={menuRenamingId === note.id || undefined} disabled={noteMenuBusy || !menuRenameDraft.title.trim()} aria-label="Save note name" title="Save note name"><ProgressRing busy={menuRenamingId === note.id} /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button><button className="log-control note-menu-rename-cancel" type="button" disabled={noteMenuBusy} aria-label="Cancel note rename" title="Cancel" onClick={() => setMenuRenameDraft(undefined)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></form> : <><button className="log-control note-choice" type="button" disabled={noteMenuBusy || menuRenameDraft !== undefined} title={(note.title ?? note.text) || 'Blank note'} onClick={() => open(note)}>{note.schedule !== undefined && (() => {
          // dim the clock when the schedule is paused or its stored cron won't run (no server nextRun);
          // red when an enabled schedule's last Run failed or was skipped (a paused one stays dim)
          const invalid = scheduleInvalid(note);
          const dim = !note.schedule.enabled || invalid;
          const failed = !dim && lastRunNeedsAttention(note.schedule.lastRun);
          const badgeLabel = invalid ? 'Schedule invalid' : !note.schedule.enabled ? 'Schedule paused' : failed ? 'Last run needs attention' : 'Scheduled';
          return <span className={`note-schedule-badge${dim ? ' paused' : failed ? ' bad' : ''}`} aria-label={badgeLabel} title={badgeLabel}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span>;
        })()}<span className="note-menu-name">{label}</span></button><span className="note-menu-actions"><button className={`log-control note-menu-run${launchAndRunMode ? ' note-menu-launch-run' : ''}${noteQueued ? ' note-queued' : ''}${progressBorder(running, 'blue')}`} type="button" aria-busy={running || undefined} disabled={noteMenuBusy || menuRenameDraft !== undefined || !noteHasContent(note) || (!launchAndRunMode && agentId === undefined)} aria-label={`${actionTitle}: ${label}`} title={actionTitle} onClick={() => void runNote(note)}><ProgressRing busy={running} />{actionIcon}</button><button className="log-control note-menu-rename" type="button" disabled={noteMenuBusy || menuRenameDraft !== undefined} aria-label={`Rename note: ${label}`} title="Rename note" onClick={() => setMenuRenameDraft({ id: note.id, title: Array.from(note.title ?? label).slice(0, 120).join('') })}><svg className="action-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.pencil} /></svg></button>{deletionControl}</span></>}</div>;
      })}
      <button className="log-control new-note" disabled={noteMenuBusy || menuRenameDraft !== undefined} onClick={() => void create()}>+ New note</button>
    </div></FlyoutPortal>}
  </div>;
  const actionStatus = copyState === 'error' ? 'Copy failed' : sendState === 'error' ? 'Queue failed' : '';
  // open note modes and clipboard actions without moving the editor caret
  const openNoteContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    // preserve native mobile editing while retaining preview actions
    if (phone && editing) return;
    const editor = editorRef.current;
    const preview = previewRef.current;
    const browserSelection = window.getSelection();
    const previewOwnsSelection = preview !== null && browserSelection !== null && !browserSelection.isCollapsed && preview.contains(browserSelection.anchorNode) && preview.contains(browserSelection.focusNode);
    const start = editing && editor !== null ? editor.selectionStart : draftRef.current.length;
    const end = editing && editor !== null ? editor.selectionEnd : start;
    const selectedText = editing && editor !== null ? editor.value.slice(start, end) : previewOwnsSelection ? browserSelection?.toString() ?? '' : '';
    // insert text into the source editor and retain note attachment behavior
    const paste = (contents: ClipboardContents, includeFiles: boolean) => {
      const available = Math.max(0, 30_000 - (draftRef.current.length - (end - start)));
      const text = contents.text.slice(0, available);
      const next = text ? `${draftRef.current.slice(0, start)}${text}${draftRef.current.slice(end)}` : draftRef.current;
      const cursor = start + text.length;
      setEditing(true);
      // update only when a text representation exists
      if (text) changeDraft(next);
      // restore the inserted range after the editor mounts
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setSelectionRange(cursor, cursor);
      });
      // ordinary paste keeps images while plain paste stays text-only
      if (includeFiles && contents.files.length > 0) chooseNoteFiles(contents.files);
    };
    const workspaceKey = worktreeId !== undefined ? placeItemKey(worktreeId) : agentId === undefined ? undefined : `agent-${agentId}`;
    const agentOpen = agentId !== undefined && (workspaceKey === undefined || !agentSplitHidden(workspaceKey));
    const noteSelectionActions: SelectionActions = {
      agentOpen,
      noteOpen: true,
      canAppendToNote: canAppendToActive,
      canCreateNote: !loading,
      appendToNote: appendToActive,
      createNote: text => create(text, assistantNoteTitle(text)),
      addToPrompt: agentId === undefined ? undefined : text => setPromptDraft(agentId, current => appendTextBlock(current, text))
    };
    openSelectionContextMenu(event, {
      label: 'Note actions',
      modes: [
        { id: 'edit', label: 'Edit', checked: editing, onSelect: () => setEditing(true) },
        { id: 'selection', label: 'Selection', checked: !editing, onSelect: () => { flush(); setEditing(false); } }
      ],
      selectedText,
      selectAll: () => {
        // select the source text in edit mode
        if (editing && editor !== null) { editor.focus(); editor.setSelectionRange(0, editor.value.length); return; }
        // select the rendered note in selection mode
        if (preview !== null) { const range = document.createRange(); range.selectNodeContents(preview); browserSelection?.removeAllRanges(); browserSelection?.addRange(range); }
      },
      copy: () => copySelection(selectedText),
      paste: contents => paste(contents, true),
      pasteAcceptsFiles: true,
      pasteDisabled: noteFilesDisabled,
      pastePlain: text => paste({ text, files: [] }, false),
      selectionActions: noteSelectionActions
    });
  };
  const inferEditing = (target: EventTarget | null) => {
    if (target instanceof Element && target.closest('a, button, input')) {
      selectionAtPointerDown.current = false;
      return;
    }
    const selected = window.getSelection()?.toString() ?? '';
    if (selectionAtPointerDown.current || selected) {
      selectionAtPointerDown.current = false;
      return;
    }
    setEditing(true);
  };
  const selectionActions = activeNote === undefined || selectionToolbar === undefined ? null : createPortal(<div className="output-selection-toolbar note-selection-toolbar" role="toolbar" aria-label="Note selection actions" style={{ top: selectionToolbar.top }} onPointerDown={event => event.preventDefault()}>
    <button type="button" disabled={agentId === undefined} onClick={() => { if (agentId !== undefined) setPromptDraft(agentId, current => appendTextBlock(current, selectionToolbar.text)); }}>Add to prompt</button>
    <button type="button" onClick={() => void copySelection(selectionToolbar.text)}>Copy</button>
  </div>, document.body);
  // the note-pane Schedule editor (variant C): always shown under the toolbar when a prefill resolves.
  // Keyed on the note id so switching notes remounts it — the editor holds per-note session state
  // (whether the Adapter kind is still following the target), which must not leak across notes.
  // "Open agent" links to the last Run's pane, but only while that agent is still on the dashboard
  const lastRunAgentId = activeNote?.schedule?.lastRun?.agentId;
  const openAgentId = lastRunAgentId !== undefined && schedulePrefill?.liveAgentIds.includes(lastRunAgentId) ? lastRunAgentId : undefined;
  // show the schedule sentence only after this note has a schedule
  const scheduleArea = schedulePrefill === undefined || activeNote?.schedule === undefined ? null : <div className="schedule-area"><ScheduleEditor key={activeNote?.id} schedule={activeNote.schedule} nextRun={activeNote.nextRun} prefill={{ kind: schedulePrefill.kind, target: schedulePrefill.target }} runsOnText={schedulePrefill.runsOnText} adapterOptions={schedulePrefill.adapters} targetOptions={schedulePrefill.targets} onSet={payload => void applySchedule(payload)} onRemove={() => void removeSchedule()} onRunNow={() => void runScheduleNow()} running={scheduleRunning} {...(openAgentId === undefined ? {} : { openAgentId })} preview={previewSchedule} busy={scheduleBusy || attachmentPending || noteMetadataPending || deleteBusy} /></div>;
  // keep note visibility and scheduling in the existing actions menu
  const noteOptionsMenu = () => <><button className="panel-header-action panel-header-row" type="button" aria-pressed={Boolean(activeNote?.allWorkspaces)} disabled={noteFilesDisabled || renameBusy || scheduleBusy || scheduleRunning} onClick={() => { /* persist the shared visibility option */ void toggleNoteOption('allWorkspaces'); }}><PanelIcon path={activeNote?.allWorkspaces ? 'M3 3h18v18H3zM7 12l3 3 7-7' : 'M3 3h18v18H3z'} /><span>Show in all workspaces</span></button>{schedulePrefill !== undefined && activeNote?.schedule === undefined && <button className="panel-header-action panel-header-row" type="button" disabled={scheduleBusy || attachmentPending || noteMetadataPending || deleteBusy} onClick={() => { /* start with the editor's daily default */ void applySchedule({ cron: defaultScheduleCron, kind: schedulePrefill.kind, target: schedulePrefill.target, enabled: true }); }}><svg className="panel-header-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg><span>Schedule note</span></button>}</>;
  // keep the picker mounted even when the attachments area is empty
  const noteAttachmentPicker = <input ref={noteAttachmentInput} className="attachment-input" type="file" multiple aria-label="Note attachment files" disabled={noteFilesDisabled} onChange={event => { /* allow selecting the same file again after removal */ chooseNoteFiles(event.target.files); event.target.value = ''; }} />;
  const visibleNoteAttachments = activeNote?.attachments ?? [];
  const hasNoteAttachments = visibleNoteAttachments.length > 0;
  // show stored files and pending feedback without an empty attachment strip
  const noteAttachmentControls = !hasNoteAttachments && !attachmentPending && !noteAttachmentError ? null : <div className="note-attachments" role="group" aria-label="Note attachments">
    {hasNoteAttachments && <div className="note-attachment-list"><div className="prompt-attachments">{visibleNoteAttachments.map(
      // keep preview and removal as separate keyboard controls
      file => <span key={file.name} title={file.name}><button className="note-attachment-preview" type="button" disabled={noteFilesDisabled} aria-label={`Preview note attachment: ${file.name}`} onClick={() => { /* load only the selected attachment preview */ void noteFilePreview.openFile(file.name); }}>{file.name}</button><button type="button" disabled={noteFilesDisabled} aria-label={`Remove note attachment: ${file.name}`} onClick={() => { /* remove only the selected stored file */ void changeNoteAttachments(file.name); }}><PanelIcon path={panelIcons.close} /></button></span>
    )}</div><button className="note-attach" type="button" disabled={noteFilesDisabled} onClick={() => { /* reuse the note-specific file picker */ noteAttachmentInput.current?.click(); }}><MoreMenuIcon name="attachment" />Add attachment</button></div>}
    {attachmentPending && <span className="note-attachment-status progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Saving attachments…</span>}
    {noteAttachmentError && <p className="attachment-error" role="alert">{noteAttachmentError}</p>}
  </div>;
  const noteTitle = activeNote?.title ?? 'Note';
  // the title pill: the note picker (with the count of notes at this Place) or the rename field
  const noteTitlePill = activeNote === undefined ? null : renaming
    ? <form className="note-title-form" onSubmit={event => { event.preventDefault(); void saveTitle(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); } }}><input ref={titleEditorRef} aria-label="Note name" value={titleDraft} maxLength={120} disabled={renamePending} onChange={event => setTitleDraft(event.target.value)} /><button type="submit" className={renamePending ? 'progress-border progress-blue' : undefined} aria-busy={renamePending || undefined} disabled={renamePending || !titleDraft.trim()} aria-label="Save note name" title="Save note name"><ProgressRing busy={renamePending} /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button><button type="button" disabled={renamePending} aria-label="Cancel note rename" title="Cancel" onClick={() => setRenaming(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></form>
    : <><button ref={picker.anchorRef} type="button" className="note-picker" aria-label={`Switch note (${noteCount} here): ${noteTitle}`} data-context-flyout aria-expanded={pickerOpen} title={noteTitle} disabled={noteFilesDisabled} onClick={() => setPickerOpen(value => !value)} onKeyDown={event => { if (event.key === 'Escape' && pickerOpen) { event.preventDefault(); event.stopPropagation(); setPickerOpen(false); } }}><strong>{noteTitle}</strong>{noteCount > 1 && <span className="note-picker-count" aria-hidden="true">{noteCount}</span>}<svg className="note-picker-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button><span className="panel-header-sub">{activeNote.allWorkspaces ? 'All workspaces' : activeNote.schedule === undefined ? 'Note' : 'Scheduled'}</span>{saveStatus === 'error' && <span className="note-save-status error" role="alert" aria-live="assertive">Unable to save</span>}{actionStatus && <span className={`note-action-status${copyState === 'error' || sendState === 'error' ? ' error' : ''}`} role={copyState === 'error' || sendState === 'error' ? 'alert' : 'status'}>{actionStatus}</span>}</>;
  const notePicker = pickerOpen && activeNote !== undefined && <FlyoutPortal onDismiss={() => setPickerOpen(false)}><div ref={picker.flyoutRef} className="more-menu note-picker-menu" style={picker.style} role="group" aria-label="Notes here" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setPickerOpen(false); } }}>
    {notes?.map(note => <button key={note.id} type="button" className="note-picker-choice" aria-current={note.id === activeNote.id ? 'true' : undefined} onClick={() => { setPickerOpen(false); if (note.id !== activeNote.id) open(note, undefined, true); }}>{note.schedule !== undefined && <svg className="note-picker-scheduled" viewBox="0 0 24 24" aria-label="Scheduled"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>}<span>{noteName(note)}</span></button>)}
    <button type="button" className="note-picker-new" disabled={noteMenuBusy} onClick={() => { setPickerOpen(false); void create(); }}>+ New note</button>
  </div></FlyoutPortal>;
  const activeNoteQueued = activeNote !== undefined && queuedNoteFeedback[activeNote.id] !== undefined;
  // keep the pane's label, tooltip and icon aligned with queue feedback
  let noteSendLabel = `${noteActionLabel} as prompt`;
  let noteSendTitle = noteSendLabel;
  let noteSendIcon = <svg viewBox="0 0 24 24" aria-hidden="true"><path d={noteActionIcon} /></svg>;
  if (activeNoteQueued) {
    noteSendLabel = 'Note queued';
    noteSendTitle = noteSendLabel;
    noteSendIcon = <PanelIcon path={panelIcons.check} />;
  } else if (agentId === undefined) {
    noteSendTitle = 'Launch an agent to send this note';
  }
  const noteSending = sendState === 'sending';
  // send to the current agent or launch one where no agent runs here
  let noteSendAction: ReactNode = null;
  if (activeNote !== undefined) {
    // retain the separate launch-and-run control for idle workspaces
    if (launchAndRunMode) {
      const running = menuRunningId !== undefined;
      noteSendAction = <button className={`panel-header-action note-send note-launch-run${progressBorder(running, 'blue')}`} type="button" aria-busy={running || undefined} disabled={noteFilesDisabled || !noteHasContent({ ...activeNote, text: draft })} aria-label="Launch and run note" title={launchRunLabel === undefined ? 'Launch an agent and run this note' : `Launch and run (${launchRunLabel})`} onClick={() => { const note = activeNoteRef.current; if (note !== undefined) void runNote(note); }}><ProgressRing busy={running} />Launch and run</button>;
    } else {
      noteSendAction = <button className={`panel-header-action note-send${activeNoteQueued ? ' note-queued' : ''}${progressBorder(noteSending, 'blue')}`} type="button" aria-busy={noteSending || undefined} disabled={agentId === undefined || noteFilesDisabled || promptPending || !noteHasContent({ ...activeNote, text: draft })} aria-label={noteSendLabel} title={noteSendTitle} onClick={() => void send()}><ProgressRing busy={noteSending} />{noteSendIcon}</button>;
    }
  }
  // attach sits beside Send, and lock right before the delete it guards
  const noteSecondary: PanelAction[] = activeNote === undefined ? [] : [
    // open the note-specific file picker
    { key: 'attach', label: 'Attach files to note', title: 'Attach files', className: 'note-attach', disabled: noteFilesDisabled, icon: <MoreMenuIcon name="attachment" />, onSelect: () => noteAttachmentInput.current?.click() },
    { key: 'copy', label: copyState === 'copied' ? 'Note copied' : 'Copy note', title: copyState === 'copied' ? 'Copied' : 'Copy note', className: `note-copy${copyState === 'copied' ? ' copied' : ''}`, disabled: deleting, icon: <PanelIcon path={copyState === 'copied' ? panelIcons.check : panelIcons.copy} />, onSelect: () => void copy() },
    { key: 'rename', label: 'Rename note', className: 'note-rename', disabled: noteFilesDisabled || renamePending || menuDeletingId !== undefined, icon: <PanelIcon path={actionIconPaths.pencil} />, onSelect: () => { setTitleDraft(activeNote.title ?? ''); setRenaming(true); } },
    { key: 'lock', label: activeNote.locked ? 'Unlock note' : 'Lock note', className: 'note-lock', pressed: Boolean(activeNote.locked), disabled: noteFilesDisabled || menuDeletingId !== undefined, progress: noteMetadataPending && noteMetadataMutation.current?.option === 'locked' ? 'blue' : undefined, icon: <PanelIcon path={activeNote.locked ? actionIconPaths.lock : actionIconPaths.unlock} />, onSelect: () => void toggleNoteOption('locked') },
    // a locked note must be unlocked before it can be removed
    ...(activeNote.locked ? [] : [{ key: 'delete', label: 'Delete note', className: 'note-delete', disabled: noteFilesDisabled || renameBusy || scheduleBusy || scheduleRunning, progress: deleting ? 'red' as const : undefined, icon: <PanelIcon path={actionIconPaths.trash} />, onSelect: remove }])
  ];
  // a phone's full screen expands whichever panel is in view; the note keeps only a desktop
  // expansion with its view
  const paneExpanded = expanded || expansion.immersive;
  // Esc closes the note, unless it is expanded: then the Workspace restores its siblings first
  const pane = activeNote === undefined ? null : <><section className={`note-pane${paneExpanded ? ' expanded' : ''}${editing ? ' editing' : ' selecting'}`} role="dialog" aria-label="Note" onAuxClickCapture={event => closeOnMiddleClick(event, () => { /* preserve pending note mutations */ if (!noteFilesDisabled) close(); })} onPointerDownCapture={phone && editing ? undefined : preserveContextMenuPress} onMouseDownCapture={phone && editing ? undefined : preserveContextMenuPress} onContextMenu={openNoteContextMenu} onDragEnter={dragNoteFiles} onDragOver={dragNoteFiles} onDragLeave={leaveNoteFiles} onDrop={dropNoteFiles} onPaste={pasteNoteFiles} onKeyDown={event => { if (event.key === 'Escape' && !paneExpanded && !deleting && sendState !== 'sending') { event.preventDefault(); close(); } }}><PanelHeader panelKey="note" label="note" title={noteTitlePill} actions={noteSendAction} secondary={noteSecondary} menuContent={noteOptionsMenu} expandDisabled={noteFilesDisabled} close={{ key: 'close', label: 'Close note', className: 'note-close', disabled: noteFilesDisabled, icon: <PanelIcon path={panelIcons.close} />, onSelect: close }} /><div className="note-pane-head">{noteMetadataError && <p className="note-lock-error" role="alert">{noteMetadataError}</p>}{scheduleArea}{noteAttachmentPicker}{noteAttachmentControls}</div>{draggingNoteFiles && <div className="prompt-drop-overlay" role="status">Drop files to attach to this note</div>}{editing ? <textarea ref={editorRef} aria-label="Note content" value={draft} maxLength={30_000} disabled={deleting || menuDeletingId === activeNote.id || noteVisibilityPending} onChange={event => changeDraft(event.target.value)} onBlur={event => { flush(); /* native mobile popups must retain the editor */ if (phone && event.relatedTarget === null) return; /* menu focus must not unmount the source editor */ if (!contextMenuOwnsFocus(event.currentTarget)) setEditing(false); }} /> : <div className="note-preview-interaction" onPointerDown={() => { selectionAtPointerDown.current = Boolean(window.getSelection()?.toString()); }} onClick={event => inferEditing(event.target)}><NoteMarkdown text={draft} containerRef={previewRef} /></div>}</section>{selectionActions}{noteFilePreview.dialog}{notePicker}</>;
  return { active: activeNote !== undefined, appendToActive, canAppendToActive, canCreate: !loading && !noteMetadataPending, canClose: activeNote !== undefined && !noteFilesDisabled, close, initialNotesLoaded, control, createWithText: create, pane, toggleMenu: toggle };
}
type WorktreeNotes = ReturnType<typeof useWorktreeNotes>;

const browserViewportKey = (worktreeId: string) => `rac.browser-viewport:${worktreeId}`;
const browserSplitKey = (worktreeId: string) => `rac.browser-split:${worktreeId}`;
const browserUrlKey = (worktreeId: string) => `rac.browser-url:${worktreeId}`;
const browserDesktopViewportWidth = 980;
type ProjectBrowserNavigationRequest = { sequence: number; url: string };
// normalize safe web locations relative to the configured project
const normalizeBrowserUrl = (candidate: string, homeUrl: string) => {
  try {
    const home = new URL(homeUrl);
    const next = new URL(candidate, home);
    // refuse active schemes and embedded credentials
    if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) return undefined;
    return next.href;
  } catch { return undefined; }
};
// reserve proxy identity emulation for the configured project origin
const isManagedBrowserUrl = (url: string, homeUrl: string, proxied: boolean) => proxied && new URL(url).origin === new URL(homeUrl).origin;
// restore the last valid project location
const savedBrowserUrl = (homeUrl: string, worktreeId?: string) => {
  // skip storage for unscoped agents
  if (worktreeId === undefined) return normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl;
  try {
    const stored = localStorage.getItem(browserUrlKey(worktreeId));
    return stored === null ? normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl : normalizeBrowserUrl(stored, homeUrl) ?? homeUrl;
  } catch { return normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl; }
};
// persist a project location
const saveBrowserUrl = (worktreeId: string | undefined, url: string) => {
  // skip storage for unscoped agents
  if (worktreeId === undefined) return;
  try { localStorage.setItem(browserUrlKey(worktreeId), url); }
  catch { /* browser storage is optional */ }
};
const savedBrowserMobile = (worktreeId?: string) => {
  if (worktreeId === undefined) return false;
  try { return localStorage.getItem(browserViewportKey(worktreeId)) === 'mobile'; }
  catch { return false; }
};
const saveBrowserMobile = (worktreeId: string | undefined, mobile: boolean) => {
  if (worktreeId === undefined) return;
  try { localStorage.setItem(browserViewportKey(worktreeId), mobile ? 'mobile' : 'desktop'); }
  catch { /* browser storage is optional */ }
};
// route one frame load through the project device selector
const browserDeviceUrl = (target: string, mobile: boolean) => {
  const destination = new URL(target);
  const deviceUrl = new URL('/__rac/browser-device', destination.origin);
  deviceUrl.searchParams.set('mode', mobile ? 'mobile' : 'desktop');
  deviceUrl.searchParams.set('location', `${destination.pathname}${destination.search}${destination.hash}`);
  return deviceUrl.href;
};
const savedBrowserSplit = (worktreeId?: string) => {
  if (worktreeId === undefined) return false;
  try { return localStorage.getItem(browserSplitKey(worktreeId)) === 'open'; }
  catch { return false; }
};
const saveBrowserSplit = (worktreeId: string | undefined, open: boolean) => {
  if (worktreeId === undefined) return;
  try { localStorage.setItem(browserSplitKey(worktreeId), open ? 'open' : 'closed'); }
  catch { /* browser storage is optional */ }
};
// Whether a Worktree's Stack panel is open, remembered per Worktree like the browser split. What it
// shows is kept in memory only, so a Workspace switch returns to it, a reload starts on the first
// process, and closing the panel forgets it.
const stackPanelKey = (worktreeId: string) => `rac.stack-panel:${worktreeId}`;
const stackSelections = new Map<string, StackSelection>();
const savedStackPanel = (worktreeId: string) => {
  try { return localStorage.getItem(stackPanelKey(worktreeId)) === 'open'; }
  catch { return false; }
};
const saveStackPanel = (worktreeId: string, open: boolean) => {
  if (!open) stackSelections.delete(worktreeId);
  try { localStorage.setItem(stackPanelKey(worktreeId), open ? 'open' : 'closed'); }
  catch { /* browser storage is optional */ }
};
function useStackPanel(worktreeId: string | undefined) {
  const [open, setOpen] = useState(() => worktreeId !== undefined && savedStackPanel(worktreeId));
  const [selection, setSelection] = useState(() => worktreeId === undefined ? undefined : stackSelections.get(worktreeId));
  const save = (value: boolean) => {
    setOpen(value);
    if (worktreeId !== undefined) saveStackPanel(worktreeId, value);
  };
  const select = (next: StackSelection | undefined) => {
    setSelection(next);
    if (worktreeId === undefined) return;
    if (next === undefined) stackSelections.delete(worktreeId);
    else stackSelections.set(worktreeId, next);
  };
  // open the panel on `next`, or on its first process when nothing is named
  const openOn = (next?: StackSelection) => { select(next); save(true); };
  return { open: open && worktreeId !== undefined, selection, select, openOn, close: () => save(false) };
}
// retain browser state for one worktree
function useProjectBrowser(homeUrl?: string, worktreeId?: string, projectProxied?: boolean) {
  const proxied = projectProxied !== false;
  const [open, setOpen] = useState(() => homeUrl !== undefined && savedBrowserSplit(worktreeId));
  const [currentUrl, setCurrentUrl] = useState(() => homeUrl === undefined ? undefined : savedBrowserUrl(homeUrl, worktreeId));
  const [navigationRequest, setNavigationRequest] = useState<ProjectBrowserNavigationRequest>();
  // restore split state whenever the project context changes
  useEffect(() => {
    // close unavailable browser panes
    if (homeUrl === undefined) { setOpen(false); return; }
    // restore scoped split preferences
    if (worktreeId !== undefined) setOpen(savedBrowserSplit(worktreeId));
  }, [homeUrl, worktreeId]);
  useEffect(() => {
    setCurrentUrl(homeUrl === undefined ? undefined : savedBrowserUrl(homeUrl, worktreeId));
  }, [homeUrl, worktreeId]);
  // validate and retain explicit frame navigation
  const navigate = useCallback((candidate: string) => {
    // reject missing project navigation
    if (homeUrl === undefined) return false;
    const next = normalizeBrowserUrl(candidate, homeUrl);
    // reject malformed locations
    if (next === undefined) return false;
    saveBrowserUrl(worktreeId, next);
    setCurrentUrl(next);
    return true;
  }, [homeUrl, worktreeId]);
  // request one explicit frame navigation
  const openUrl = useCallback((candidate: string) => {
    // reject missing project navigation
    if (homeUrl === undefined) return false;
    const next = normalizeBrowserUrl(candidate, homeUrl);
    // reject malformed locations
    if (next === undefined) return false;
    saveBrowserUrl(worktreeId, next);
    setCurrentUrl(next);
    // distinguish repeated clicks on one retained URL
    setNavigationRequest(current => ({ sequence: (current?.sequence ?? 0) + 1, url: next }));
    return true;
  }, [homeUrl, worktreeId]);
  return {
    open: open && homeUrl !== undefined,
    homeUrl,
    proxied,
    url: open ? currentUrl : undefined,
    navigate,
    navigationRequest,
    openUrl,
    toggle: () => {
      // ignore unavailable browser panes
      if (homeUrl === undefined) return;
      setOpen(value => { const next = !value; saveBrowserSplit(worktreeId, next); return next; });
    },
    close: () => { saveBrowserSplit(worktreeId, false); setOpen(false); }
  };
}

type ProjectBrowserLocationMessage = { type: 'rac-browser-location'; url: string };
type ProjectBrowserRefreshMessage = { type: 'rac-browser-refresh' };
type ProjectBrowserDeviceErrorMessage = { type: 'rac-browser-device-error'; properties: string[] };
type ProjectBrowserThemeMessage = { type: 'rac-browser-theme'; color: string | null };
// keep unusable color reports from replacing the default backing
const normalizeBrowserChromeColor = (color: string | null) => {
  // restore the default for an explicit reset
  if (color === null) return undefined;
  const value = color.trim();
  // discard transparent and context-dependent colors
  if (/^(?:transparent|currentcolor|inherit|initial|unset|revert(?:-layer)?)$/iu.test(value)
    || /^rgba\([^)]*,\s*(?:0(?:\.0+)?|\.0+)%?\s*\)$/iu.test(value)
    || /\/\s*(?:0(?:\.0+)?|\.0+)%?\s*\)$/u.test(value)
    || /^#(?:[\da-f]{3}0|[\da-f]{6}00)$/iu.test(value)) return undefined;
  return value;
};
// accept only bounded browser color reports
const isProjectBrowserThemeMessage = (value: unknown): value is ProjectBrowserThemeMessage => {
  // ignore primitive messages
  if (value === null || typeof value !== 'object') return false;
  const { type, color } = value as { type?: unknown; color?: unknown };
  return type === 'rac-browser-theme' && (color === null || typeof color === 'string' && color.length <= 256 && CSS.supports('color', color));
};
// recognize cooperative frame navigation reports
const isProjectBrowserLocationMessage = (value: unknown): value is ProjectBrowserLocationMessage => value !== null && typeof value === 'object'
  && (value as ProjectBrowserLocationMessage).type === 'rac-browser-location'
  && typeof (value as ProjectBrowserLocationMessage).url === 'string';
// recognize cooperative frame refresh requests
const isProjectBrowserRefreshMessage = (value: unknown): value is ProjectBrowserRefreshMessage => value !== null && typeof value === 'object'
  && (value as ProjectBrowserRefreshMessage).type === 'rac-browser-refresh';
// recognize failed browser identity overrides
const isProjectBrowserDeviceErrorMessage = (value: unknown): value is ProjectBrowserDeviceErrorMessage => value !== null && typeof value === 'object'
  && (value as ProjectBrowserDeviceErrorMessage).type === 'rac-browser-device-error'
  && Array.isArray((value as ProjectBrowserDeviceErrorMessage).properties)
  && (value as ProjectBrowserDeviceErrorMessage).properties.every(property => typeof property === 'string');
// render the embedded project browser
function ProjectBrowserPane({ url, homeUrl, proxied, worktreeId, navigationRequest, onNavigate, onClose }: { url: string; homeUrl: string; proxied: boolean; worktreeId?: string; navigationRequest?: ProjectBrowserNavigationRequest; onNavigate: (url: string) => boolean; onClose: () => void }) {
  const selectionActions = useSelectionActions();
  const phone = usePhoneLayout();
  const [loading, setLoading] = useState(true);
  const expanded = usePanelExpand('browser')?.expanded === true;
  const [mobile, setMobile] = useState(() => savedBrowserMobile(worktreeId));
  const [deviceError, setDeviceError] = useState<string>();
  const [chromeColor, setChromeColor] = useState<string>();
  const [address, setAddress] = useState(url);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const addressComposing = useRef(false);
  const [addressFocused, setAddressFocused] = useState(false);
  const [clipboardUrl, setClipboardUrl] = useState<string>();
  const clipboardRequest = useRef(0);
  const [addressCopyStatus, setAddressCopyStatus] = useState<'copied' | 'failed'>();
  const addressHold = useRef<{ x: number; y: number; timer: number } | undefined>(undefined);
  const addressHoldCopied = useRef(false);
  const copyingAddress = useRef(false);
  const [frameSource, setFrameSource] = useState(() => isManagedBrowserUrl(url, homeUrl, proxied) ? browserDeviceUrl(url, mobile) : url);
  const [frameAwayFromKnownUrl, setFrameAwayFromKnownUrl] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameShellRef = useRef<HTMLDivElement | null>(null);
  const loadedFrameSource = useRef(url);
  const loadedFrameProxied = useRef(isManagedBrowserUrl(url, homeUrl, proxied));
  const expectedFrameLoad = useRef(true);
  const appliedNavigationSequence = useRef(navigationRequest?.sequence);
  const normalizedHomeUrl = normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl;
  const normalizedUrl = normalizeBrowserUrl(url, homeUrl) ?? normalizedHomeUrl;
  const managed = isManagedBrowserUrl(normalizedUrl, homeUrl, proxied);
  const atHome = normalizedUrl === normalizedHomeUrl && !frameAwayFromKnownUrl;
  const homeOrigin = new URL(homeUrl).origin;
  // trust permission messages only while the live source is a managed project preview
  const permissionFrameIsManaged = useCallback(() => proxied && loadedFrameProxied.current, [proxied]);
  const permissionBroker = useBrowserPermissionBroker({ frameRef, homeOrigin, isManaged: permissionFrameIsManaged });
  // opt into compatibility forwarding without exposing a referrer
  const permissionFrameName = proxied ? 'rac-managed-preview-v1' : undefined;
  // revoke the current document before changing its source
  const revokeFramePermissions = useCallback(() => {
    permissionBroker.revoke();
  }, [permissionBroker.revoke]);
  useEffect(() => setAddress(url), [url]);
  // discard unfinished holds and clipboard reads when this browser closes
  useEffect(() => () => {
    window.clearTimeout(addressHold.current?.timer);
    clipboardRequest.current += 1;
  }, []);
  // keep clipboard feedback brief without altering the editable url
  useEffect(() => {
    const timer = window.setTimeout(() => setAddressCopyStatus(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [addressCopyStatus]);
  // scale one desktop layout viewport into the visible phone frame
  useEffect(() => {
    const shell = frameShellRef.current;
    // skip an unavailable frame shell
    if (shell === null) return;
    // publish dimensions used by phone-only desktop emulation
    const measure = () => {
      const width = shell.clientWidth;
      const height = shell.clientHeight;
      // wait for a measurable frame
      if (width <= 0 || height <= 0) return;
      const scale = Math.min(width / browserDesktopViewportWidth, 1);
      shell.style.setProperty('--browser-desktop-width', `${browserDesktopViewportWidth}px`);
      shell.style.setProperty('--browser-desktop-scale', String(scale));
      shell.style.setProperty('--browser-desktop-height', `${height / scale}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    measure();
    return () => observer.disconnect();
  }, []);
  // navigate without replacing the frame
  const loadFrame = useCallback((target: string, device = mobile) => {
    revokeFramePermissions();
    loadedFrameSource.current = target;
    loadedFrameProxied.current = isManagedBrowserUrl(target, homeUrl, proxied);
    const source = loadedFrameProxied.current ? browserDeviceUrl(target, device) : target;
    setDeviceError(undefined);
    setChromeColor(undefined);
    setFrameSource(source);
    frameRef.current?.setAttribute('src', source);
  }, [homeUrl, mobile, proxied, revokeFramePermissions]);
  // refresh the retained location
  const refreshFrame = useCallback(() => {
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(loadedFrameSource.current);
  }, [loadFrame]);
  // revoke this project's saved approval and reload only after storage confirms removal
  const resetPreviewPermissions = () => {
    // preserve unsaved preview state when permission reset is cancelled
    if (!window.confirm('Reset preview permissions and reload this page? Unsaved preview changes may be lost.')) return;
    // keep the current frame revoked when its saved approvals could not be cleared
    if (!permissionBroker.forgetGrants()) return;
    refreshFrame();
  };
  // apply parent-directed navigation
  useEffect(() => {
    const explicitlyRequested = navigationRequest !== undefined && appliedNavigationSequence.current !== navigationRequest.sequence;
    const target = explicitlyRequested ? navigationRequest.url : normalizedUrl;
    // skip retained locations already loaded by the pane
    if (!explicitlyRequested && loadedFrameSource.current === target && loadedFrameProxied.current === isManagedBrowserUrl(target, homeUrl, proxied)) return;
    // consume one explicit navigation request
    if (explicitlyRequested) appliedNavigationSequence.current = navigationRequest.sequence;
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(target);
  }, [homeUrl, loadFrame, navigationRequest, normalizedUrl, proxied]);
  useEffect(() => {
    // direct previews do not expose the managed bridge
    if (!proxied) return;
    // accept reports only from this frame and project origin
    const syncReportedFrame = (event: MessageEvent<unknown>) => {
      // ignore unrelated messages
      if (event.source !== frameRef.current?.contentWindow || event.origin !== new URL(homeUrl).origin) return;
      // recover managed authority only through a valid home-origin location
      if (isProjectBrowserLocationMessage(event.data)) {
        const reportedUrl = normalizeBrowserUrl(event.data.url, homeUrl);
        // retain explicit outside navigation until its load completes
        if (reportedUrl === undefined || new URL(reportedUrl).origin !== event.origin || !loadedFrameProxied.current && expectedFrameLoad.current) return;
        // retain the current managed location
        if (onNavigate(reportedUrl)) {
          loadedFrameSource.current = reportedUrl;
          setFrameAwayFromKnownUrl(false);
          // reapply the selected identity after returning from an outside page
          if (!loadedFrameProxied.current) {
            expectedFrameLoad.current = true;
            setLoading(true);
            loadFrame(reportedUrl);
          }
        }
        return;
      }
      // outside pages cannot grant themselves theme or refresh authority
      if (!loadedFrameProxied.current) return;
      // tint only this browser's header backing
      if (isProjectBrowserThemeMessage(event.data)) { setChromeColor(normalizeBrowserChromeColor(event.data.color)); return; }
      // reload only the embedded browser
      if (isProjectBrowserRefreshMessage(event.data)) { refreshFrame(); return; }
      // surface failed identity emulation
      if (isProjectBrowserDeviceErrorMessage(event.data)) { setDeviceError(`Unable to apply device mode: ${event.data.properties.join(', ')}`); return; }
    };
    window.addEventListener('message', syncReportedFrame);
    return () => window.removeEventListener('message', syncReportedFrame);
  }, [homeUrl, loadFrame, onNavigate, proxied, refreshFrame]);
  // sync readable same-origin frame locations
  const syncFrameLocation = () => {
    permissionBroker.frameLoaded();
    const expected = expectedFrameLoad.current;
    expectedFrameLoad.current = false;
    setLoading(false);
    // discard the previous page's appearance after in-frame navigation
    if (!expected) setChromeColor(undefined);
    // probe the configured managed origin after a link or redirect returns there
    if (proxied) frameRef.current?.contentWindow?.postMessage({ type: 'rac-browser-theme-request' }, new URL(homeUrl).origin);
    // leave direct cross-origin locations opaque
    if (!loadedFrameProxied.current) return;
    // track unreported frame navigation
    if (!expected) setFrameAwayFromKnownUrl(true);
    try {
      const current = frameRef.current?.contentWindow?.location.href;
      // retain a readable frame location
      if (current !== undefined && onNavigate(current)) {
        loadedFrameSource.current = current;
        setFrameAwayFromKnownUrl(false);
      }
    } catch { /* cross-origin frames can report with rac-browser-location */ }
  };
  // submit a safe browser location
  const navigate = (candidate = address) => {
    clipboardRequest.current += 1;
    setClipboardUrl(undefined);
    const target = normalizeBrowserUrl(candidate, homeUrl);
    // restore the retained address after invalid input
    if (target === undefined) { setAddress(url); return; }
    setAddress(target);
    // avoid reloading an already known location
    if (target === normalizedUrl && !frameAwayFromKnownUrl) return;
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    // reload an unknown in-frame location
    loadFrame(target);
    onNavigate(target);
  };
  // restore editor focus before removing the selected clipboard action
  const navigateClipboard = (target: string) => {
    addressInputRef.current?.focus({ preventScroll: true });
    navigate(target);
  };
  // share native keyboard and arrow submission without stale input state
  const submitAddress = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // leave unfinished input-method composition in the editor
    if (addressComposing.current) return;
    navigate(addressInputRef.current?.value ?? address);
  };
  // prevent composition confirmation from becoming implicit navigation
  const addressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // all other keys retain the browser's native form behavior
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
  };
  // accept clipboard URLs only as complete safe web addresses
  const readAddressClipboard = async (request: number) => {
    try {
      const candidate = (await navigator.clipboard.readText()).trim();
      // ignore results from a dismissed or replaced address editor
      if (request !== clipboardRequest.current || !addressInputRef.current?.isConnected) return;
      const target = /^https?:\/\//iu.test(candidate) && !/\s/u.test(candidate) ? normalizeBrowserUrl(candidate, homeUrl) : undefined;
      setClipboardUrl(target);
    } catch { /* unreadable clipboard contents offer no action */ }
  };
  // inspect an already-permitted clipboard without prompting on focus
  const focusAddress = () => {
    // internal focus transfers retain the current suggestion
    if (addressFocused) return;
    setAddressFocused(true);
    setClipboardUrl(undefined);
    const request = ++clipboardRequest.current;
    // native paste remains available without the async clipboard API
    if (!phone || typeof navigator.clipboard?.readText !== 'function' || navigator.permissions === undefined) return;
    void navigator.permissions.query({ name: 'clipboard-read' as PermissionName }).then(permission => {
      // offer only clipboard contents already available without a permission prompt
      if (request === clipboardRequest.current && permission.state === 'granted') void readAddressClipboard(request);
    }).catch(() => { /* unavailable permissions offer no clipboard action */ });
  };
  // update the editable address
  const changeAddress = (event: React.ChangeEvent<HTMLInputElement>) => setAddress(event.target.value);
  // cancel a tap, drag or interrupted hold
  const cancelAddressHold = () => {
    window.clearTimeout(addressHold.current?.timer);
    addressHold.current = undefined;
  };
  // copy the full visible address without submitting it through fallback clipboard focus
  const copyAddress = (input: HTMLInputElement) => {
    window.clearTimeout(addressHold.current?.timer);
    // native contextmenu can arrive after the hold timer for the same gesture
    if (addressHoldCopied.current) return;
    addressHoldCopied.current = true;
    setAddressCopyStatus(undefined);
    const focused = document.activeElement === input;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    copyingAddress.current = true;
    const result = copyText(input.value);
    copyingAddress.current = false;
    // the legacy clipboard fallback temporarily focuses a hidden textarea
    if (focused && document.activeElement !== input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(start, end);
    }
    void result.then(() => setAddressCopyStatus('copied'), () => setAddressCopyStatus('failed'));
  };
  // track touch directly because native text selection can cancel pointer delivery
  const startAddressHold = (event: React.TouchEvent<HTMLInputElement>) => {
    cancelAddressHold();
    addressHoldCopied.current = false;
    // leave multi-finger gestures to the browser
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const input = event.currentTarget;
    addressHold.current = { x: touch.clientX, y: touch.clientY, timer: window.setTimeout(() => copyAddress(input), 450) };
  };
  // allow scrolling and selection drags without copying
  const moveAddressHold = (event: React.TouchEvent<HTMLInputElement>) => {
    const hold = addressHold.current;
    const touch = event.touches[0];
    // abandon gestures that move beyond tap slop
    if (hold !== undefined && (event.touches.length !== 1 || touch === undefined || Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > 10)) cancelAddressHold();
  };
  // replace touch callouts with copying while retaining desktop editing menus
  const addressContextMenu = (event: React.MouseEvent<HTMLInputElement>) => {
    const pointerType = (event.nativeEvent as PointerEvent).pointerType;
    // mouse and keyboard menus retain paste and selection commands
    if (pointerType !== 'touch' && addressHold.current === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    copyAddress(event.currentTarget);
  };
  // submit genuine focus changes rather than clipboard or menu focus transfers
  const blurAddress = (event: React.FocusEvent<HTMLFormElement>) => {
    // the arrow and clipboard choice must receive their click before dismissal
    if (event.currentTarget.contains(event.relatedTarget)) return;
    cancelAddressHold();
    // temporary focus changes must not navigate the preview
    if (copyingAddress.current || contextMenuOwnsFocus(addressInputRef.current ?? event.currentTarget)) return;
    setAddressFocused(false);
    setClipboardUrl(undefined);
    clipboardRequest.current += 1;
    addressComposing.current = false;
    // mobile native callouts are not an address submission gesture
    if (!phone || event.relatedTarget !== null) navigate(addressInputRef.current?.value ?? address);
  };
  // return to the configured root
  const goHome = () => {
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(homeUrl);
    onNavigate(homeUrl);
  };
  // stop the active frame navigation
  const stopFrame = () => {
    try {
      frameRef.current?.contentWindow?.stop();
      expectedFrameLoad.current = false;
    } catch {
      // abort inaccessible cross-origin navigation
      expectedFrameLoad.current = true;
      loadFrame(loadedFrameSource.current);
    }
    setLoading(false);
  };
  // switch between refresh and stop
  const toggleFrameLoad = () => {
    // stop an active navigation
    if (loading) { stopFrame(); return; }
    refreshFrame();
  };
  // Esc closes the browser, unless it is expanded: then the Workspace restores its siblings first
  const handleEscape = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || expanded) return;
    event.preventDefault();
    revokeFramePermissions();
    onClose();
  };
  // apply both viewport and browser identity
  const toggleDevice = () => {
    const nextMobile = !mobile;
    saveBrowserMobile(worktreeId, nextMobile);
    setMobile(nextMobile);
    // resize direct previews without claiming user-agent emulation
    if (!managed) return;
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(loadedFrameSource.current, nextMobile);
  };
  // offer browser chrome actions without accessing a cross-origin document
  const browserContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    const input = event.target instanceof HTMLInputElement ? event.target : undefined;
    const addressInput = event.currentTarget.querySelector<HTMLInputElement>('input[aria-label="Browser address"]');
    const selection = window.getSelection();
    const selected = input === undefined
      ? selection?.anchorNode !== null && selection?.anchorNode !== undefined && event.currentTarget.contains(selection.anchorNode) ? selection.toString() : ''
      : input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
    const start = input?.selectionStart ?? address.length;
    const end = input?.selectionEnd ?? start;
    // replace only the address range captured when the menu opened
    const pasteAddress = (text: string) => {
      // readonly browser chrome cannot receive text
      if (input === undefined || !input.isConnected) return;
      setAddress(current => `${current.slice(0, start)}${text}${current.slice(end)}`);
      window.requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + text.length, start + text.length); });
    };
    openSelectionContextMenu(event, {
      label: 'Browser options',
      modes: [
        { id: 'desktop', label: 'Desktop viewport', checked: !mobile, onSelect: () => { /* change only a different viewport */ if (mobile) toggleDevice(); } },
        { id: 'mobile', label: 'Mobile viewport', checked: mobile, onSelect: () => { /* change only a different viewport */ if (!mobile) toggleDevice(); } }
      ],
      selectedText: selected,
      selectAll: () => { /* select browser chrome without entering the embedded page */ addressInput?.focus(); addressInput?.select(); },
      copy: () => copyText(selected),
      paste: input === undefined ? undefined : contents => pasteAddress(contents.text),
      pastePlain: input === undefined ? undefined : pasteAddress,
      selectionActions
    });
  };
  // describe the applied preview capability
  const deviceLabel = managed ? mobile ? 'Use desktop viewport and user agent' : 'Use mobile viewport and user agent' : mobile ? 'Use desktop viewport' : 'Use mobile viewport';
  const deviceTitle = managed ? mobile ? 'Desktop viewport and user agent' : 'Mobile viewport and user agent' : mobile ? 'Desktop viewport' : 'Mobile viewport';
  const actions = <>
    {addressCopyStatus && <span className={`browser-copy-status${addressCopyStatus === 'failed' ? ' error' : ''}`} role={addressCopyStatus === 'failed' ? 'alert' : 'status'}>{addressCopyStatus === 'copied' ? 'URL copied' : 'Copy failed'}</span>}
    {deviceError && <span className="browser-device-error" role="alert" title={deviceError}>Mode failed</span>}
    {proxied && <button className="panel-header-action browser-permission-reset" type="button" aria-label="Reset preview permissions" title="Reset preview permissions" onClick={resetPreviewPermissions}><PanelIcon path="M12 3 3 7v6c0 5 9 8 9 8s9-3 9-8V7l-9-4M9 10l6 6M15 10l-6 6" /></button>}
    {managed
      ? <button className={`panel-header-action browser-refresh${loading ? ' loading progress-border progress-blue' : ''}`} type="button" aria-label={loading ? 'Stop loading browser' : 'Refresh browser'} aria-busy={loading || undefined} title={loading ? 'Stop' : 'Refresh'} onClick={toggleFrameLoad}><ProgressRing busy={loading} /><PanelIcon path={loading ? 'm6 6 12 12M18 6 6 18' : 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6'} /></button>
      : <button className={`panel-header-action browser-refresh${loading ? ' loading progress-border progress-blue' : ''}`} type="button" disabled={loading} aria-label="Refresh browser" aria-busy={loading || undefined} title={loading ? 'Loading external preview' : 'Refresh external preview'} onClick={refreshFrame}><ProgressRing busy={loading} /><PanelIcon path="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></button>}
    <a className="panel-header-action browser-open-tab" href={normalizedUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab"><PanelIcon path="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></a>
  </>;
  const secondary: PanelAction[] = [
    { key: 'home', label: 'Go to project home', title: 'Home', className: 'browser-home', disabled: atHome, icon: <PanelIcon path="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7" />, onSelect: goHome },
    { key: 'device', label: deviceLabel, title: deviceTitle, className: 'browser-device-toggle', pressed: mobile, icon: <svg className="panel-header-icon" data-device={mobile ? 'mobile' : 'desktop'} viewBox="0 0 24 24" aria-hidden="true">{mobile ? <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M10 5h4M11 19h2" /></> : <><rect x="3" y="5" width="18" height="13" rx="1" /><path d="M8 21h8M12 18v3" /></>}</svg>, onSelect: toggleDevice }
  ];
  // retain one visual input pill while providing native form submission
  const titleControl = <form className="browser-address-form" aria-label="Browser address navigation" onSubmit={submitAddress} onBlur={blurAddress}>
    <input ref={addressInputRef} className="panel-header-pill panel-header-title browser-address" type="text" inputMode="url" enterKeyHint="go" aria-label="Browser address" value={address} spellCheck={false} autoCapitalize="none" autoCorrect="off" onFocus={focusAddress} onChange={changeAddress} onKeyDown={addressKeyDown} onCompositionStart={() => { /* retain unfinished composition */ addressComposing.current = true; }} onCompositionEnd={() => { /* allow the next explicit submission */ addressComposing.current = false; }} onTouchStart={startAddressHold} onTouchMove={moveAddressHold} onTouchEnd={cancelAddressHold} onTouchCancel={cancelAddressHold} onContextMenu={addressContextMenu} />
    {phone && addressFocused && <>
      <button className="panel-header-action browser-address-go" type="submit" aria-label="Go to address" title="Go" onMouseDown={event => { /* retain the editor until the native click submits */ event.preventDefault(); }}><PanelIcon path="M5 12h14m-6-6 6 6-6 6" /></button>
      {clipboardUrl !== undefined && <div className="browser-address-suggestions">
        <button type="button" aria-label="Navigate to clipboard URL" title={clipboardUrl} onMouseDown={event => { /* retain the editor until the clipboard click completes */ event.preventDefault(); }} onClick={() => navigateClipboard(clipboardUrl)}><PanelIcon path={panelIcons.copy} /><span>Navigate to clipboard URL<small>{clipboardUrl}</small></span></button>
      </div>}
    </>}
  </form>;
  return <section className={`browser-pane ${mobile ? 'mobile' : 'desktop'}${expanded ? ' expanded' : ''}`} style={{ '--browser-chrome-color': chromeColor } as React.CSSProperties} role="dialog" aria-label="Browser" onAuxClickCapture={event => closeOnMiddleClick(event, () => { /* revoke embedded permissions before closing */ revokeFramePermissions(); onClose(); })} onPointerDownCapture={preserveContextMenuPress} onMouseDownCapture={preserveContextMenuPress} onContextMenu={browserContextMenu} onKeyDown={handleEscape}><PanelHeader panelKey="browser" label="browser" titleControl={titleControl} actions={actions} secondary={secondary} close={{ key: 'close', label: 'Close browser', title: 'Close', className: 'browser-close', icon: <PanelIcon path={panelIcons.close} />, onSelect: () => { /* revoke before hiding the frame */ revokeFramePermissions(); onClose(); } }} />{permissionBroker.consent}{permissionBroker.error && <p className="browser-permission-error" role="alert">{permissionBroker.error}</p>}<div ref={frameShellRef} className={`browser-frame-shell ${mobile ? 'mobile' : 'desktop'}`}><iframe ref={frameRef} src={frameSource} name={permissionFrameName} title="Project browser" referrerPolicy="no-referrer" onLoad={syncFrameLocation} /></div></section>;
}

// reuse the owning view's note persistence and prompt draft
// `addToPrompt` is absent where the tab has no composer (an agentless directory-Project or Scratch Place)
type TerminalSelectionActions = { canCreateNote: boolean; createNote: (text: string) => Promise<boolean>; addToPrompt?: (text: string) => void };
// let the split supply visibility and selection actions to terminal columns
type TerminalColumnProps = { selectionActions?: TerminalSelectionActions; mobileActive?: boolean };
// keep each rendered terminal keyed by its stable tmux pane id
type TerminalColumn = { key: string; label: string; node: ReactElement<TerminalColumnProps> };
type SplitSizes = Record<string, number>;
type SplitStyle = React.CSSProperties & { '--agent-split': string; '--note-split': string; '--browser-split': string; '--split-cols': string };
type SplitDrag = { pointerId: number; startX: number; left: string; right: string; leftWidth: number; rightWidth: number; sizes: SplitSizes; resized?: SplitSizes };
type FixedSplitPanelKey = 'agent' | 'note' | 'browser' | 'files' | 'code' | 'review' | 'stack' | 'settings';
type SplitPanelKind = FixedSplitPanelKey | 'terminal';
// keep fixed split identity in one typed source of truth
const fixedSplitPanels: { [Key in FixedSplitPanelKey]: { selector: string; kind: Key; title: string } } = {
  agent: { selector: '.log-output', kind: 'agent', title: 'Agent output' },
  note: { selector: '.note-pane', kind: 'note', title: 'Note' },
  browser: { selector: '.browser-pane', kind: 'browser', title: 'Project browser' },
  files: { selector: '.files-pane', kind: 'files', title: 'Files' },
  code: { selector: '.code-pane', kind: 'code', title: 'Code changes' },
  review: { selector: '.review-pane', kind: 'review', title: 'Guided review' },
  stack: { selector: '.stack-pane', kind: 'stack', title: 'Stack' },
  settings: { selector: '.client-settings-page', kind: 'settings', title: 'Settings' }
};
// return fixed metadata without treating terminal ids as object keys
const fixedSplitPanel = (key: string) => Object.prototype.hasOwnProperty.call(fixedSplitPanels, key) ? fixedSplitPanels[key as FixedSplitPanelKey] : undefined;
// use pane ids only for terminal selectors
const splitPanelSelector = (key: string): string => fixedSplitPanel(key)?.selector ?? `.terminal-pane[data-panel-key="${key}"]`;
const browserMobileWidth = 390;
const minimumSplitPanelWidth = browserMobileWidth;
// classify unknown keys as terminal panes
const splitPanelKind = (key: string): SplitPanelKind => fixedSplitPanel(key)?.kind ?? 'terminal';
// scope split layouts to one browser client and workspace composition
const splitSizesKey = (worktreeId: string, signature: string) => `rac.split-sizes:${worktreeId}:${signature}`;
// one panel weight is valid when finite, positive and not absurd
const validSplitWeight = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000;
// restore saved widths with a larger initial settings weight
const savedSplitSizes = (worktreeId: string | undefined, signature: string, keys: readonly string[]): SplitSizes => {
  const sizes: SplitSizes = {};
  for (const key of keys) sizes[key] = key === 'settings' ? 2 : 1;
  // keep unscoped agent layouts ephemeral
  if (worktreeId === undefined) return sizes;
  try {
    const stored = JSON.parse(localStorage.getItem(splitSizesKey(worktreeId, signature)) ?? 'null') as Record<string, unknown> | null;
    if (stored !== null && typeof stored === 'object') for (const key of keys) if (validSplitWeight(stored[key])) sizes[key] = stored[key];
  } catch { /* browser storage is optional */ }
  return sizes;
};
// persist one user-adjusted browser-local layout
const saveSplitSizes = (worktreeId: string | undefined, signature: string, sizes: SplitSizes) => {
  // keep unscoped agent layouts ephemeral
  if (worktreeId === undefined) return;
  try { localStorage.setItem(splitSizesKey(worktreeId, signature), JSON.stringify(sizes)); }
  catch { /* browser storage is optional */ }
};
// The Code panel is dynamically imported so `@pierre/diffs` (~177 kB gzip plus its lazy shiki
// grammar/theme chunks) never lands in the dashboard's eager bundle — it loads the first time a
// reviewer opens changes. Its module is the app's only importer of the library.
const CodePanel = lazy(() => import('./code-panel/code-panel.js'));
// Render one Worktree's open Code panel from its controller (callers gate on `controller.open`, so
// this is only mounted while open). The lazy chunk resolves behind a lightweight fallback so the
// split does not jump.
function CodePane({ controller, prAvailable, branch, review, onOpenInEditor, onReturnToFiles, onReturnToSettings }: { controller: CodePanelController; prAvailable: boolean; branch?: string; review?: CodePanelReview; onOpenInEditor?: (target: EditorTarget) => void; onReturnToFiles?: () => void; onReturnToSettings?: () => void }) {
  // return transient previews to their owning split
  const closeFile = () => {
    const fromFiles = controller.filePreview?.source === 'files';
    const fromSettings = controller.filePreview?.source === 'settings';
    controller.closeFilePreview();
    // restore files only for its explicit source
    if (fromFiles) onReturnToFiles?.();
    // restore settings without remounting or discarding its draft
    if (fromSettings) onReturnToSettings?.();
  };
  return <Suspense fallback={<section className="code-pane" role="region" aria-label="Code changes"><p className="code-pane-status">Loading changes…</p></section>}>
    <CodePanel mode={controller.mode} commit={controller.commit} state={controller.state} patch={controller.patch} selectedPath={controller.selectedPath} filePreview={controller.filePreview} prAvailable={prAvailable} branch={branch} review={review} loadFile={controller.loadFile} onSelectFile={controller.selectFile} onClearFile={controller.clearFile} onSetMode={controller.setMode} loadCommits={controller.loadCommits} onSelectCommit={controller.openCommit} onCloseFile={closeFile} onClose={controller.close} onRetry={controller.refresh} savedView={controller.savedView} onSaveView={controller.saveView} {...(onOpenInEditor === undefined ? {} : { onOpenInEditor })} />
  </Suspense>;
}
// render every ordered resizable panel
// `expansion` is the Workspace's expanded panel; a split without a Workspace keeps its own.
// On a phone the panels sit in a swipe carousel, one per screen; `onCarousel` hears its panels and
// the one in view, for the toolbar's dots.
function ResizableLogSplit({ worktreeId, output, empty, note, browser, files, code, codeController, review, stack, withSettings = false, terminals, terminalSelectionActions, onCarousel, initialPanelsReady, expansion: workspaceExpansion }: { worktreeId?: string; output?: ReactNode; empty?: ReactNode; note?: ReactNode; browser?: ReactNode; files?: ReactNode; code?: ReactNode; codeController?: CodePanelController; review?: ReactNode; stack?: ReactNode; withSettings?: boolean; terminals?: TerminalColumn[]; terminalSelectionActions?: TerminalSelectionActions; onCarousel?: (carousel: PanelCarousel) => void; initialPanelsReady?: boolean; expansion?: PanelExpansion }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const settingsState = useContext(ClientSettingsSplitContext);
  const editorConfigured = useContext(EditorConfiguredContext);
  const ownExpansion = usePanelExpansion();
  const expansion = workspaceExpansion ?? ownExpansion;
  // support read-only settings previews even before a workspace exists
  const standaloneCode = useCodePanel(undefined, request);
  const previewController = codeController ?? standaloneCode;
  // retire settings previews when their return destination is explicitly closed
  useEffect(() => {
    // retain ordinary file previews and any saved comparison behind the base file
    if (withSettings && !settingsState?.open && previewController.filePreview?.source === 'settings') previewController.closeFilePreview();
  }, [withSettings, settingsState?.open, previewController.filePreview?.source, previewController.closeFilePreview]);
  // return from the base file to the same settings split
  const returnToSettings = () => { expansion.restore(); carousel.show('settings'); };
  const codePane = code ?? (standaloneCode.open ? <CodePane controller={standaloneCode} prAvailable={false} onReturnToSettings={returnToSettings} /> : null);
  // resolve native editor ownership where the global Settings page is rendered
  const settingsEditor = {
    configured: editorConfigured,
    placeId: worktreeId,
    open: !editorConfigured || worktreeId === undefined ? undefined : async (target: SettingsEditorTarget) => {
      expansion.restore();
      return await openEditorShell(worktreeId, { settingsSource: target });
    },
    // reuse catalog bytes instead of sending a host path through Files
    preview: (target: SettingsPreviewTarget) => {
      expansion.restore();
      const mounted = previewController.open;
      previewController.openContentPreview(target.path, target.content);
      // wait for the destination column when opening Code for the first time
      if (mounted) carousel.show('code');
      else window.requestAnimationFrame(() => carousel.show('code'));
    }
  };
  const settingsPane = withSettings && settingsState?.open ? <SettingsTerminalEditorContext.Provider value={settingsEditor}>{settingsState.page}</SettingsTerminalEditorContext.Provider> : null;
  const hasSettings = settingsPane !== null;
  const dragRef = useRef<SplitDrag | undefined>(undefined);
  const hasNote = note !== undefined && note !== null;
  const hasBrowser = browser !== undefined && browser !== null;
  const hasFiles = files !== undefined && files !== null;
  const hasCode = codePane !== undefined && codePane !== null;
  const hasReview = review !== undefined && review !== null;
  const hasStack = stack !== undefined && stack !== null;
  const termCols = terminals ?? [];
  const hasTerminals = termCols.length > 0;
  const hasAgent = output !== undefined && output !== null;
  // the panels in column order, each with its key and rendered node
  const columns: { key: string; node: ReactNode }[] = [
    ...(hasAgent ? [{ key: 'agent', node: output }] : []),
    ...termCols.map(col => ({ key: col.key, node: col.node })),
    ...(hasNote ? [{ key: 'note', node: note }] : []),
    ...(hasBrowser ? [{ key: 'browser', node: browser }] : []),
    ...(hasFiles ? [{ key: 'files', node: files }] : []),
    ...(hasCode ? [{ key: 'code', node: codePane }] : []),
    ...(hasReview ? [{ key: 'review', node: review }] : []),
    ...(hasStack ? [{ key: 'stack', node: stack }] : []),
    ...(hasSettings ? [{ key: 'settings', node: settingsPane }] : [])
  ];
  const keys = columns.map(column => column.key);
  // one layout per open-panel composition (the ordered keys), so opening or closing a panel
  // restores that combination's own widths
  const signature = keys.join('|');
  const phone = usePhoneLayout();
  const carousel = usePanelCarousel(containerRef, keys, phone, worktreeId, initialPanelsReady);
  const expansionScope = useExpansionScope(expansion, keys, containerRef, carousel.visibleKey);
  const [sizes, setSizes] = useState<SplitSizes>(() => savedSplitSizes(worktreeId, signature, keys));
  // restore the exact workspace layout for each open-panel composition
  useEffect(() => setSizes(savedSplitSizes(worktreeId, signature, signature.split('|'))), [signature, worktreeId]);
  // collect current panel widths
  const measuredSizes = (): SplitSizes => {
    const container = containerRef.current;
    const measured: SplitSizes = {};
    // retain every visible panel width
    for (const key of keys) {
      measured[key] = 1;
      const element = container?.querySelector<HTMLElement>(`:scope > ${splitPanelSelector(key)}`);
      // skip closed panels
      if (element !== null && element !== undefined) measured[key] = element.getBoundingClientRect().width;
    }
    return measured;
  };
  // begin pointer resizing
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    // accept primary-button drags only
    if (event.button !== 0) return;
    const left = event.currentTarget.dataset.left!;
    const right = event.currentTarget.dataset.right!;
    const measured = measuredSizes();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, left, right, leftWidth: measured[left], rightWidth: measured[right], sizes: measured };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  // apply pointer resizing
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    // ignore unrelated pointers
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const combined = drag.leftWidth + drag.rightWidth;
    const minimum = minimumSplitPanelWidth;
    const leftWidth = Math.max(minimum, Math.min(combined - minimum, drag.leftWidth + event.clientX - drag.startX));
    const resized = { ...drag.sizes, [drag.left]: leftWidth, [drag.right]: combined - leftWidth };
    // retain the final pointer position for pointerup persistence
    dragRef.current = { ...drag, resized };
    setSizes(resized);
  };
  // finish pointer resizing
  const stopResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    // ignore unrelated pointers
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    // persist only layouts that the user actually moved
    if (drag.resized !== undefined) saveSplitSizes(worktreeId, signature, drag.resized);
    // release an active drag capture
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  // resize with arrow keys
  const keyboardResize = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // handle horizontal arrows only
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const left = event.currentTarget.dataset.left!;
    const right = event.currentTarget.dataset.right!;
    const measured = measuredSizes();
    const combined = measured[left] + measured[right];
    const minimum = minimumSplitPanelWidth;
    const direction = event.key === 'ArrowLeft' ? -32 : 32;
    const leftWidth = Math.max(minimum, Math.min(combined - minimum, measured[left] + direction));
    const resized = { ...measured, [left]: leftWidth, [right]: combined - leftWidth };
    setSizes(resized);
    saveSplitSizes(worktreeId, signature, resized);
    event.preventDefault();
  };
  // name each split for the phone flyout and the action that shows it
  const carouselPanels: CarouselPanel[] = columns.map(column => {
    const kind = splitPanelKind(column.key);
    const termLabel = termCols.find(col => col.key === column.key)?.label.trim();
    const title = fixedSplitPanel(column.key)?.title ?? `Terminal ${termLabel || termCols.findIndex(col => col.key === column.key) + 1}`;
    const label = `Show ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
    return { key: column.key, kind, title, label };
  });
  const contentSwipe = usePanelSwipe({ panels: carouselPanels, visibleKey: carousel.visibleKey, show: carousel.show });
  // enable carousel swipes over notes, wrapped diffs and noninteractive settings content
  const swipeContentTarget = (target: EventTarget | null) => target instanceof Element && (
    target.closest('.note-pane :is(.note-markdown, textarea)') !== null
    || target.closest('.code-pane[data-wrap-lines="true"] .code-pane-view') !== null
    || target.closest('.client-settings-page-content') !== null && target.closest('input, textarea, select, button, a, .settings-source-nav, .settings-code-editor') === null
  );
  // leave unwrapped horizontal diff scrolling alone
  const startContentSwipe = (event: React.PointerEvent<HTMLDivElement>) => {
    contentSwipe.onPointerDown(event, phone && swipeContentTarget(event.target));
  };
  // shadow-dom diff scrollers can cancel pointer events, so also follow the touch lifecycle
  const startContentTouchSwipe = (event: React.TouchEvent<HTMLDivElement>) => {
    contentSwipe.onTouchStart(event, phone && swipeContentTarget(event.target));
  };
  const carouselSignature = carouselPanels.map(panel => `${panel.key}\u0000${panel.title}`).join('\u0001');
  // report the carousel so the toolbar's dots follow the visible panel
  useLayoutEffect(() => {
    onCarousel?.({ panels: carouselPanels, visibleKey: carousel.visibleKey, show: carousel.show });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carouselSignature, carousel.visibleKey, carousel.show, onCarousel]);
  // one resizer between two adjacent panel keys
  const resizer = (left: string, right: string) => <div key={`resizer:${left}:${right}`} className={`split-resizer ${splitPanelKind(right)}-resizer`} role="separator" aria-label={`Resize ${splitPanelKind(left)} and ${splitPanelKind(right)} panels`} aria-orientation="vertical" tabIndex={0} data-left={left} data-right={right} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={keyboardResize} />;
  const style: SplitStyle = {
    '--agent-split': `${sizes.agent ?? 1}fr`, '--note-split': `${sizes.note ?? 1}fr`, '--browser-split': `${sizes.browser ?? 1}fr`,
    // keep the browser's removable divider inside its column group
    '--split-cols': columns.map((column, index) => {
      // omit a leading divider while keeping mobile preview's fixed-width override
      if (column.key === 'browser') return `var(--browser-split-cols, ${index === 0 ? '' : '.45rem '}minmax(var(--split-pane-min-width), var(--browser-split)))`;
      // retain dividers between the remaining resizable panels
      return `${index === 0 ? '' : '.45rem '}minmax(var(--split-pane-min-width), ${sizes[column.key] ?? 1}fr)`;
    }).join(' ')
  };
  // reveal the destination of a terminal selection action on phones
  const selectionActions: TerminalSelectionActions | undefined = terminalSelectionActions === undefined ? undefined : {
    canCreateNote: terminalSelectionActions.canCreateNote,
    // open the shared note pane after saving selected output
    createNote: async text => {
      const created = await terminalSelectionActions.createNote(text);
      // retain the selected terminal for retry when creation fails
      if (created) carousel.show('note');
      return created;
    },
    // show the composer without submitting the selected output
    addToPrompt: terminalSelectionActions.addToPrompt === undefined ? undefined : text => {
      terminalSelectionActions.addToPrompt?.(text);
      carousel.show('agent');
    }
  };
  // the panel columns interleaved with resizers
  const laidOut = columns.flatMap((column, index) => {
    const isTerminal = splitPanelKind(column.key) === 'terminal';
    // mount phone keys only for the visible Terminal so inactive splits keep no live controls
    const node = isTerminal ? cloneElement(column.node as ReactElement<TerminalColumnProps>, { key: column.key, selectionActions, mobileActive: phone && carousel.visibleKey === column.key }) : <Fragment key={column.key}>{column.node}</Fragment>;
    return index === 0 ? [node] : [resizer(columns[index - 1].key, column.key), node];
  });
  const mobileView = carousel.visibleKey !== undefined ? ` mobile-${splitPanelKind(carousel.visibleKey)}-view` : '';
  return <PanelExpandContext.Provider value={expansionScope.context}><div ref={containerRef} className={`log-split${hasAgent ? '' : ' no-agent'}${hasNote ? ' has-note' : ''}${hasBrowser ? ' has-browser' : ''}${hasFiles ? ' has-files' : ''}${hasCode ? ' has-code' : ''}${hasReview ? ' has-review' : ''}${hasStack ? ' has-stack' : ''}${hasSettings ? ' has-settings' : ''}${hasTerminals ? ' has-terminals' : ''}${mobileView}`} style={style} onKeyDown={expansionScope.onKeyDown} onPointerDownCapture={preserveMiddleClickPress} onMouseDownCapture={preserveMiddleClickPress} onPointerDown={startContentSwipe} onPointerUp={contentSwipe.onPointerUp} onPointerCancel={contentSwipe.onPointerCancel} onTouchStart={startContentTouchSwipe} onTouchEnd={contentSwipe.onTouchEnd} onTouchCancel={contentSwipe.onTouchCancel} onClickCapture={contentSwipe.onClickCapture}>{columns.length === 0 ? empty : laidOut}</div></PanelExpandContext.Provider>;
}

// One pane of a Worktree the picker can show as a Terminal (the wire shape of
// `GET /api/worktrees/:id/panes`): the Agent's session panes, its Console shells and any
// hand-split panes, each with its tmux window (for the one-Terminal-per-window rule).
type WorktreePane = { paneId: string; session: string; sessionName?: string; window?: string; role?: string; name?: string; command: string; path: string; title: string; agent: boolean; busy?: boolean };
// A Terminal panel the operator has open, remembered per Worktree by pane id and name.
type OpenTerminal = { paneId: string; name: string };
// last two path segments, so a picker row and a pane head read `command · …/foo/bar`
const shortWorktreePath = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
};
// a pane's operator name, or its `command · path` when it has none (spec, the picker)
const terminalPaneLabel = (pane: WorktreePane): string => pane.name !== undefined && pane.name.trim() !== '' ? pane.name : `${pane.command || 'shell'} · ${shortWorktreePath(pane.path)}`;
// remember open Terminal panels per Worktree, by tmux pane id (spec, Terminals as Panels).
// The stored list is bounded — at most `maxOpenTerminals` panels, each name clamped to the
// pane-name cap — so a corrupt or hostile localStorage value cannot grow unchecked.
const worktreeTerminalsKey = (worktreeId: string) => `rac.terminals:${worktreeId}`;
const maxOpenTerminals = 24;
const maxTerminalNameLength = 120;
const clampTerminalName = (name: string) => name.length > maxTerminalNameLength ? name.slice(0, maxTerminalNameLength) : name;
const savedTerminals = (worktreeId: string | undefined): OpenTerminal[] => {
  if (worktreeId === undefined) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(worktreeTerminalsKey(worktreeId)) ?? 'null') as unknown;
    if (Array.isArray(stored)) return stored.slice(0, maxOpenTerminals).flatMap(entry => entry !== null && typeof entry === 'object' && typeof (entry as OpenTerminal).paneId === 'string' && /^%\d+$/u.test((entry as OpenTerminal).paneId)
      ? [{ paneId: (entry as OpenTerminal).paneId, name: clampTerminalName(typeof (entry as OpenTerminal).name === 'string' ? (entry as OpenTerminal).name : (entry as OpenTerminal).paneId) }]
      : []);
  } catch { /* browser storage is optional */ }
  return [];
};
const saveTerminals = (worktreeId: string | undefined, open: OpenTerminal[]) => {
  if (worktreeId === undefined) return;
  try { localStorage.setItem(worktreeTerminalsKey(worktreeId), JSON.stringify(open.slice(0, maxOpenTerminals).map(terminal => ({ paneId: terminal.paneId, name: clampTerminalName(terminal.name) })))); }
  catch { /* browser storage is optional */ }
};
// forget the panels a Place last had open on this device, so its
// Workspace opens empty
const forgetOpenPanels = (placeId: string) => {
  saveTerminals(placeId, []);
  saveBrowserSplit(placeId, false);
  saveStackPanel(placeId, false);
  saveFilesOpen(placeId, false);
  clearWorktreeNoteView(placeId);
};
// a Place's live panes, or undefined when they could not be listed
const listPlacePanes = async (placeId: string): Promise<WorktreePane[] | undefined> => {
  try {
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/panes`);
    if (!response.ok) return undefined;
    const body = await response.json() as { panes?: WorktreePane[] };
    return Array.isArray(body.panes) ? body.panes : [];
  } catch { return undefined; }
};
// a Console shell the console opened, as against the Agent's own pane or a hand-made one
const isConsoleShell = (pane: WorktreePane): boolean => pane.role === 'shell' && !pane.agent;
const endingConsoleShells = new Set<string>();
// share managed-shell shutdown and busy confirmation
const endConsoleShell = async (placeId: string, pane: WorktreePane, confirmed = false): Promise<boolean | undefined> => {
  const key = JSON.stringify([placeId, pane.paneId]);
  // protect unmanaged panes and concurrent shutdowns
  if (!isConsoleShell(pane) || endingConsoleShells.has(key)) return undefined;
  endingConsoleShells.add(key);
  const confirmation = `End ${terminalPaneLabel(pane)}? It is running a command.`;
  try {
    // preserve consent before ending a busy shell
    if (pane.busy && !confirmed) {
      // leave cancelled work untouched
      if (!window.confirm(confirmation)) return undefined;
      confirmed = true;
    }
    const url = `/api/worktrees/${encodeURIComponent(placeId)}/panes/${encodeURIComponent(pane.paneId)}`;
    let response = await request(`${url}${confirmed ? '?confirm=1' : ''}`, { method: 'DELETE' });
    // recheck consent when an idle shell became busy
    if (response.status === 409 && !confirmed) {
      const body = await response.json() as { busy?: boolean };
      // keep unrelated conflicts visible
      if (body.busy !== true) return false;
      // preserve newly busy work on cancellation
      if (!window.confirm(confirmation)) return undefined;
      response = await request(`${url}?confirm=1`, { method: 'DELETE' });
    }
    return response.ok;
  } catch { return false; }
  finally { endingConsoleShells.delete(key); }
};
// keep full-host Files capabilities separate from relative Code and review paths
type EditorShellTarget = EditorTarget | { objectToken: string } | { settingsSource: SettingsEditorTarget };
// open a console shell: a plain one, the configured editor (`{ editor: true }` and an optional
// target), or a key binding's Terminal (`{ binding }`)
const createPlaceShell = async (placeId: string, payload: { editor?: true; binding?: { table: string; key: string }; settingsSource?: SettingsEditorTarget } & Partial<EditorTarget> & { objectToken?: string } = {}): Promise<{ paneId: string } | { error: string }> => {
  const operationKey = `shell-create:${placeId}`;
  // keep new shells outside workspace shutdown snapshots
  if (!beginPendingOperation(operationKey, placeItemKey(placeId))) return { error: 'This workspace is busy. Try again after its current operation finishes.' };
  try {
    const response = await request(`/api/worktrees/${encodeURIComponent(placeId)}/shells`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({})) as { paneId?: unknown; error?: unknown };
    if (response.ok && typeof body.paneId === 'string') return { paneId: body.paneId };
    return { error: typeof body.error === 'string' ? body.error : 'The console could not open a shell there.' };
  } catch { return { error: 'Unable to reach the console.' }; }
  finally { setPendingOperation(operationKey, false); }
};
// The + menu's Terminal asks a Place's Workspace to show one pane as a focused Terminal panel. The
// panel is saved as open first, so a Workspace that mounts afterwards opens it too; a mounted
// Workspace hears the request. A panel already mounted takes focus at once, and one still to
// mount takes it when it does.
const terminalOpenListeners = new Set<(placeId: string, terminal: OpenTerminal) => void>();
// The requested pane ids, each until it expires so a panel that never mounts (the operator left,
// the shell died) neither steals focus later nor stays pinned open: those awaiting their panel's
// mount to take focus, and those whose panel must survive a pane listing older than the shell.
const terminalRequestWindowMs = 10_000;
const pendingTerminalFocus = new Map<string, number>();
const requestedTerminals = new Map<string, number>();
const stillRequested = (requests: Map<string, number>, paneId: string): boolean => {
  const expires = requests.get(paneId);
  if (expires !== undefined && expires <= Date.now()) requests.delete(paneId);
  return requests.has(paneId);
};
const requestTerminalFocus = (placeId: string, terminal: OpenTerminal) => {
  const now = Date.now();
  for (const requests of [pendingTerminalFocus, requestedTerminals]) for (const [paneId, expires] of requests) if (expires <= now) requests.delete(paneId);
  requestedTerminals.set(terminal.paneId, now + terminalRequestWindowMs);
  const open = savedTerminals(placeId);
  if (!open.some(candidate => candidate.paneId === terminal.paneId)) saveTerminals(placeId, [...open, terminal]);
  terminalOpenListeners.forEach(listener => listener(placeId, terminal));
  const focus = terminalFocusers.get(terminal.paneId);
  if (focus === undefined) pendingTerminalFocus.set(terminal.paneId, now + terminalRequestWindowMs);
  else focus();
};
// open a relative editor jump or token-bound host file in a focused terminal
const openEditorShell = async (placeId: string, target: EditorShellTarget): Promise<string | undefined> => {
  const created = await createPlaceShell(placeId, { editor: true, ...target });
  if (!('paneId' in created)) return created.error;
  let panes = await listPlacePanes(placeId);
  let shell = panes?.find(pane => pane.paneId === created.paneId);
  // allow a stale first listing without persisting a confirmed missing Files editor
  if ('objectToken' in target) {
    // retry only successful listings that still omit the newly created pane
    for (let retry = 0; retry < 2 && panes !== undefined && shell === undefined; retry += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 100 * (retry + 1)));
      panes = await listPlacePanes(placeId);
      shell = panes?.find(pane => pane.paneId === created.paneId);
    }
    // repeated successful absence means Code is the usable fallback
    if (panes !== undefined && shell === undefined) return 'The editor terminal is no longer available.';
  }
  requestTerminalFocus(placeId, { paneId: created.paneId, name: shell === undefined ? 'editor' : terminalPaneLabel(shell) });
  return undefined;
};
// The open Terminal panels of one Worktree and the picker's live pane list. Panels persist
// per Worktree by pane id and are reconciled against the live panes on mount, so a reload
// reopens the ones whose pane still exists and forgets the rest (spec, Terminals as Panels).
function useWorktreeTerminals(worktreeId: string | undefined) {
  const [open, setOpen] = useState<OpenTerminal[]>(() => savedTerminals(worktreeId));
  const [panes, setPanes] = useState<WorktreePane[]>([]);
  const refreshPanes = useCallback(async (): Promise<WorktreePane[] | undefined> => {
    if (worktreeId === undefined) return undefined;
    const list = await listPlacePanes(worktreeId);
    if (list !== undefined) setPanes(list);
    return list;
  }, [worktreeId]);
  useEffect(() => {
    // show this Worktree's stored panels at once, then reconcile against the live panes
    setOpen(savedTerminals(worktreeId));
    let cancelled = false;
    void (async () => {
      const list = await refreshPanes();
      // a failed fetch (undefined) leaves the stored panels; a real listing prunes them
      if (cancelled || list === undefined) return;
      const byId = new Map(list.map(pane => [pane.paneId, pane] as const));
      setOpen(current => {
        // a pane the + menu's Terminal just asked for may postdate this listing
        const kept = current.filter(terminal => byId.has(terminal.paneId) || stillRequested(requestedTerminals, terminal.paneId)).map(terminal => { const pane = byId.get(terminal.paneId); return pane === undefined ? terminal : { paneId: terminal.paneId, name: terminalPaneLabel(pane) }; });
        if (kept.length !== current.length || kept.some((terminal, index) => terminal.name !== current[index]?.name)) saveTerminals(worktreeId, kept);
        return kept;
      });
    })();
    return () => { cancelled = true; };
  }, [worktreeId, refreshPanes]);
  const openPane = useCallback((paneId: string, name: string) => setOpen(current => {
    if (current.some(terminal => terminal.paneId === paneId)) return current;
    const next = [...current, { paneId, name }];
    saveTerminals(worktreeId, next);
    return next;
  }), [worktreeId]);
  // open the panel the + menu's Terminal asks this Place for
  useEffect(() => {
    const listener = (placeId: string, terminal: OpenTerminal) => { if (placeId === worktreeId) openPane(terminal.paneId, terminal.name); };
    terminalOpenListeners.add(listener);
    return () => { terminalOpenListeners.delete(listener); };
  }, [worktreeId, openPane]);
  const closePane = useCallback((paneId: string) => setOpen(current => {
    if (!current.some(terminal => terminal.paneId === paneId)) return current;
    const next = current.filter(terminal => terminal.paneId !== paneId);
    saveTerminals(worktreeId, next);
    return next;
  }), [worktreeId]);
  // forget ended panes without counting them as minimized shells
  const forgetPane = useCallback((paneId: string) => {
    closePane(paneId);
    // remove the ended pane from the current picker listing
    setPanes(current => current.filter(pane => pane.paneId !== paneId));
  }, [closePane]);
  // share managed-shell deletion between the header and picker
  const endPane = useCallback(async (pane: WorktreePane): Promise<boolean | undefined> => {
    // never delete agent panes or unmanaged session panes
    if (worktreeId === undefined || pane.role !== 'shell' || pane.agent) return false;
    const operationKey = `shell-delete:${worktreeId}:${pane.paneId}`;
    // exclude workspace shutdown and replacement during standalone deletion
    if (!beginPendingOperation(operationKey, placeItemKey(worktreeId))) return undefined;
    try {
      const ended = await endConsoleShell(worktreeId, pane);
      // retain rejected or cancelled shells
      if (ended !== true) return ended;
      forgetPane(pane.paneId);
      await refreshPanes();
      return true;
    } finally {
      setPendingOperation(operationKey, false);
    }
  }, [worktreeId, forgetPane, refreshPanes]);
  // rename a Console shell through the panes API, then read the pane back so the open panel's
  // head, its phone chip and the picker's row all show the stored name (spec, the picker)
  const renamePane = useCallback(async (paneId: string, name: string): Promise<boolean> => {
    if (worktreeId === undefined) return false;
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/panes/${encodeURIComponent(paneId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!response.ok) return false;
    } catch { return false; }
    const list = await refreshPanes();
    const renamed = list?.find(pane => pane.paneId === paneId);
    setOpen(current => {
      if (!current.some(terminal => terminal.paneId === paneId)) return current;
      const next = current.map(terminal => terminal.paneId === paneId ? { paneId, name: renamed ? terminalPaneLabel(renamed) : clampTerminalName(name) } : terminal);
      saveTerminals(worktreeId, next);
      return next;
    });
    return true;
  }, [worktreeId, refreshPanes]);
  return { open, panes, refreshPanes, openPane, closePane, forgetPane, endPane, renamePane };
}
type WorktreeTerminals = ReturnType<typeof useWorktreeTerminals>;

// render a live terminal with fullscreen, minimize and managed-shell delete actions
function TerminalPane({ worktreeId, paneId, name, onMinimize, onExit, onRename, onDelete, onOpenFile, selectionActions, mobileActive = false }: { worktreeId: string; paneId: string; name: string; onMinimize: () => void; onExit: () => void; onRename?: (name: string) => Promise<boolean>; onDelete?: () => Promise<boolean | undefined>; onOpenFile?: (path: string) => void } & TerminalColumnProps) {
  const canvas = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState<TerminalSelection>();
  const [selectionModeActive, setSelectionModeActive] = useState(false);
  // the toolbar's Copy copies, flashes, then deselects; its other actions deselect when done
  const copySelectionRef = useRef<(value: string) => Promise<void>>(copyText);
  const clearSelectionRef = useRef<() => void>(() => {});
  const selectionControllerRef = useRef<TerminalSelectionController | undefined>(undefined);
  const pasteTerminalRef = useRef<((text: string) => void) | undefined>(undefined);
  const workspaceSelectionActions = useSelectionActions();
  // this Terminal's share of the Workspace's expansion, keyed by its pane id
  const expand = usePanelExpand(paneId);
  const expanded = expand?.expanded === true;
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(name);
  const [renamePending, setRenamePending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  // the stream's status until its seed lands (Connecting, Reconnecting…); undefined while live
  const [connection, setConnection] = useState<string | undefined>('Connecting');
  // retain the Place file opener across terminal renders
  const openTerminalFileRef = useRef(onOpenFile);
  openTerminalFileRef.current = onOpenFile;
  // preserve the panel when deletion fails or confirmation is cancelled
  const deleteShell = async () => {
    // ignore duplicate deletion or non-managed panes
    if (deletePending || renamePending || onDelete === undefined || pendingOperations.has(deactivateOperationKey(worktreeId))) return;
    setDeletePending(true);
    setDeleteError(false);
    try {
      const deleted = await onDelete();
      setDeleteError(deleted === false);
    } finally { setDeletePending(false); }
  };
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const submitRename = async () => {
    const trimmed = renameDraft.trim();
    if (onRename === undefined || trimmed === '' || renamePending) return;
    setRenamePending(true);
    const ok = await onRename(trimmed);
    setRenamePending(false);
    if (ok) setRenaming(false);
  };
  // the keyboard's rename-panel opens this Console shell's name field
  const renameable = onRename !== undefined;
  useEffect(() => {
    if (!renameable) return;
    const open = () => { setRenameDraft(name); setRenaming(true); };
    terminalRenamers.set(paneId, open);
    return () => { if (terminalRenamers.get(paneId) === open) terminalRenamers.delete(paneId); };
  }, [paneId, name, renameable]);
  // keep selection and input scoped to this mounted terminal
  useEffect(() => {
    const container = canvas.current;
    // mount only after the terminal canvas exists
    if (container === null) return;
    setSelection(undefined);
    setSelectionModeActive(false);
    setConnection('Connecting');
    const handle = mountStreamedTerminal(container, {
      connect: createWorktreePaneConnector(worktreeId, paneId, request),
      transformInput: data => applyStickyModifiers(paneId, data),
      onExit: () => onExitRef.current(),
      onStatus: setConnection,
      // expose file links only when the owning Place supplied a destination
      ...(onOpenFile === undefined ? {} : { onOpenFile: (path: string) => openTerminalFileRef.current?.(path) })
    });
    const selection = attachTerminalSelection(container, handle, {
      onSelection: setSelection,
      onSelectionModeChange: setSelectionModeActive,
      copyText,
      flashElement: container.closest<HTMLElement>('.terminal-pane') ?? container,
      copyFlashMs: selectionCopyFlashMs
    });
    copySelectionRef.current = selection.copyThenClear;
    selectionControllerRef.current = selection;
    pasteTerminalRef.current = handle.paste;
    clearSelectionRef.current = selection.clear;
    const blur = () => handle.terminal.blur();
    terminalInputs.set(paneId, handle.sendInput);
    exitTerminalInput.set(paneId, blur);
    terminalFocusers.set(paneId, handle.focus);
    const onFocusIn = () => setFocused(true);
    // preserve terminal mode while its contextual menu owns focus
    const onFocusOut = () => { if (!contextMenuOwnsFocus(container)) setFocused(false); };
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    // the + menu's Terminal asked for this pane before its panel mounted
    if (stillRequested(pendingTerminalFocus, paneId)) { pendingTerminalFocus.delete(paneId); handle.focus(); }
    // release selection listeners before disposing the terminal
    return () => {
      selection.dispose();
      // release only this mounted controller
      if (selectionControllerRef.current === selection) selectionControllerRef.current = undefined;
      if (pasteTerminalRef.current === handle.paste) pasteTerminalRef.current = undefined;
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      // only clear our own registrations, so a fast remount of the same pane id keeps the new one
      if (terminalInputs.get(paneId) === handle.sendInput) terminalInputs.delete(paneId);
      if (exitTerminalInput.get(paneId) === blur) exitTerminalInput.delete(paneId);
      if (terminalFocusers.get(paneId) === handle.focus) terminalFocusers.delete(paneId);
      handle.dispose();
    };
  }, [worktreeId, paneId]);
  // open terminal modes and clipboard actions without sending a secondary mouse report
  const openTerminalContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    const controller = selectionControllerRef.current;
    const selectedText = controller?.getSelectedText() ?? '';
    const linkUrl = currentOutputLinkUrl(event.target);
    openSelectionContextMenu(event, {
      label: `Terminal ${name} actions`,
      modes: [
        { id: 'output', label: 'Output', checked: !selectionModeActive, onSelect: () => controller?.setMode('output') },
        { id: 'selection', label: 'Selection', checked: selectionModeActive, onSelect: () => controller?.setMode('selection') }
      ],
      selectedText,
      selectAll: () => controller?.selectAll(),
      copy: () => controller?.copy(selectedText),
      copyUrl: linkUrl === undefined ? undefined : () => copyText(linkUrl),
      paste: contents => { controller?.setMode('output'); if (contents.text) pasteTerminalRef.current?.(contents.text); },
      pastePlain: text => { controller?.setMode('output'); pasteTerminalRef.current?.(text); },
      selectionActions: workspaceSelectionActions
    });
  };
  const secondary: PanelAction[] = [];
  if (onRename !== undefined) secondary.push({ key: 'rename', label: `Rename terminal ${name}`, title: 'Rename terminal', className: 'pane-rename-toggle', disabled: deletePending || renaming, icon: <PanelIcon path={actionIconPaths.pencil} />, onSelect: () => { setRenameDraft(name); setRenaming(true); } });
  // keep managed-shell deletion visible even when rename folds into More
  const deleteControl = onDelete === undefined ? undefined : <button type="button" className={`panel-header-action pane-delete${progressBorder(deletePending, 'red')}`} aria-busy={deletePending || undefined} aria-label={`Delete terminal ${name}`} title="Delete shell (ends the running shell)" disabled={deletePending || renamePending} onClick={() => void deleteShell()}><ProgressRing busy={deletePending} /><PanelIcon path={actionIconPaths.trash} /></button>;
  return <section className={`terminal-pane${expanded ? ' expanded' : ''}${focused ? ' focused' : ''}${selectionModeActive ? ' selection-active' : ''}`} data-panel-key={paneId} onPointerDownCapture={preserveContextMenuPress} onMouseDownCapture={preserveContextMenuPress} onContextMenuCapture={openTerminalContextMenu} onAuxClickCapture={event => closeOnMiddleClick(event, () => void deleteShell())}>
    <PanelHeader panelKey={paneId} label={`terminal ${name}`} expandDisabled={deletePending} actions={deleteControl} secondary={secondary} close={{ key: 'minimize', label: `Minimize terminal ${name}`, title: 'Minimize terminal (the shell keeps running)', className: 'pane-minimize', disabled: deletePending, icon: <PanelIcon path="M5 12h14" />, onSelect: onMinimize }} title={<>
      {deleteError
      ? <span className="pane-status error" role="alert" title="Could not delete shell. Try again.">Delete failed</span>
      : connection !== undefined && <span className="pane-status" role="status">{connection}</span>}
      {renaming
      ? <form className="pane-rename" onSubmit={event => { event.preventDefault(); void submitRename(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); } }}><input aria-label={`Name for terminal ${name}`} value={renameDraft} maxLength={maxTerminalNameLength} autoFocus disabled={renamePending} onChange={event => setRenameDraft(event.target.value)} /><button type="submit" className={renamePending ? 'progress-border progress-blue' : undefined} aria-busy={renamePending || undefined} disabled={renamePending || renameDraft.trim() === ''} aria-label="Save terminal name" title="Save terminal name"><ProgressRing busy={renamePending} /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button><button type="button" disabled={renamePending} aria-label="Cancel terminal rename" title="Cancel" onClick={() => setRenaming(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></form>
      : <span className="pane-title" title={name}>{name}</span>}
    </>} />
    <div className="terminal-canvas" ref={canvas} aria-label={`Terminal ${name}`} />
    {/* keep phone keys with their terminal instead of replacing the static toolbar */}
    {mobileActive && <MobileTerminalKeys id={paneId} />}
    {/* keep selection actions hidden with their terminal panel */}
    {selection && <div className="output-selection-toolbar" role="toolbar" aria-label={`Selection actions for terminal ${name}`} style={{ top: selection.top, left: selection.left }} onPointerDown={event => event.preventDefault()}>
      <button type="button" disabled={!selectionActions?.canCreateNote || selection.text.length > 30_000} onClick={async () => { /* reveal and deselect only once the note is created, so a failure can be retried */ if (await selectionActions?.createNote(selection.text)) { expand?.restore(); clearSelectionRef.current(); } }}>Create note</button>
      <button type="button" disabled={selectionActions?.addToPrompt === undefined} onClick={() => { /* reveal the draft without sending it */ expand?.restore(); selectionActions?.addToPrompt?.(selection.text); clearSelectionRef.current(); }}>Add to prompt</button>
      <button type="button" onClick={() => void copySelectionRef.current(selection.text)}>Copy</button>
    </div>}
  </section>;
}

// windows already driven by a Terminal (an open panel or the Agent's own pane): one Size claim
// per window, so a second pane of the same window is not pickable
const claimedTerminalWindows = (panes: WorktreePane[], openIds: Set<string>) => {
  const claimed = new Set<string>();
  for (const pane of panes) if (pane.window !== undefined && (pane.agent || openIds.has(pane.paneId))) claimed.add(pane.window);
  return claimed;
};
const pickableTerminalPane = (pane: WorktreePane, openIds: Set<string>, claimedWindows: Set<string>) =>
  !pane.agent && !openIds.has(pane.paneId) && (pane.window === undefined || !claimedWindows.has(pane.window));

// make a new Console shell at the Place (running the configured editor when `editor`) and open
// it as a Terminal panel; returns the error when the shell could not be made
const openNewShell = async (worktreeId: string, { refreshPanes, openPane }: WorktreeTerminals, editor = false): Promise<string | undefined> => {
  const created = await createPlaceShell(worktreeId, editor ? { editor: true } : {});
  if (!('paneId' in created)) return created.error;
  const { paneId } = created;
  const list = await refreshPanes();
  const shell = list?.find(pane => pane.paneId === paneId);
  openPane(paneId, shell ? terminalPaneLabel(shell) : editor ? 'editor' : 'shell');
  return undefined;
};

// render the terminal action and available pane picker
function TerminalPicker({ worktreeId, terminals }: { worktreeId: string; terminals: WorktreeTerminals }) {
  const { open, panes, refreshPanes, openPane, endPane } = terminals;
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLSpanElement>(menuOpen, { placement: 'above', align: 'start' });
  const openIds = new Set(open.map(terminal => terminal.paneId));
  const claimedWindows = claimedTerminalWindows(panes, openIds);
  // match the marker and menu semantics to the click path
  const hasFlyout = menuOpen || panes.some(pane => pickableTerminalPane(pane, openIds, claimedWindows));
  const createShell = () => openNewShell(worktreeId, terminals);
  const newShell = async () => {
    setBusy(true);
    try {
      const failure = await createShell();
      setError(failure);
      if (failure === undefined) setMenuOpen(false);
    } finally { setBusy(false); }
  };
  // honor the displayed action even when panes change before a click
  // failed shell creation still opens the picker for recovery
  const toggle = async () => {
    if (menuOpen) { setMenuOpen(false); return; }
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // refresh picker contents without switching to direct shell creation
      if (hasFlyout) {
        await refreshPanes();
        setMenuOpen(true);
        return;
      }
      const failure = await createShell();
      if (failure !== undefined) { setError(failure); setMenuOpen(true); }
    } finally { setBusy(false); }
  };
  // reuse the header's managed-shell deletion and busy confirmation
  const endShell = async (pane: WorktreePane) => {
    setBusy(true);
    try { await endPane(pane); }
    finally { setBusy(false); }
  };
  const choose = (pane: WorktreePane) => { openPane(pane.paneId, terminalPaneLabel(pane)); setMenuOpen(false); };
  // the Agent's own pane and any hand-split siblings; a hidden Console shell (created but not
  // currently a Panel) is listed separately, with an End action
  const sessionPanes = panes.filter(pane => pane.role !== 'shell');
  const hiddenShells = panes.filter(pane => pane.role === 'shell' && !openIds.has(pane.paneId));
  // count only minimized managed shells, not agent panes or phone-hidden open panels
  const minimizedCount = hiddenShells.filter(pane => !pane.agent).length;
  const minimizedDescription = minimizedCount > 0 ? `${minimizedCount} minimized shell${minimizedCount === 1 ? '' : 's'}` : undefined;
  const paneRow = (pane: WorktreePane, showEnd: boolean) => {
    const claimed = pane.window !== undefined && claimedWindows.has(pane.window) && !openIds.has(pane.paneId);
    const disabled = !pickableTerminalPane(pane, openIds, claimedWindows);
    const reason = pane.agent ? 'The agent’s own pane' : openIds.has(pane.paneId) ? 'Already open' : claimed ? 'Another terminal already uses this window' : `${pane.session}${pane.sessionName ? ` (${pane.sessionName})` : ''} · ${pane.paneId}`;
    return <div className="terminal-picker-row" key={pane.paneId}>
      <button type="button" role="menuitem" className="terminal-picker-pane" disabled={disabled} title={reason} onClick={() => choose(pane)}><span className="terminal-picker-label">{terminalPaneLabel(pane)}</span><span className="terminal-picker-id" aria-hidden="true">{pane.paneId}</span></button>
      {showEnd && <button type="button" className="terminal-picker-end" aria-label={`End ${terminalPaneLabel(pane)}`} title="End this shell" disabled={busy} onClick={() => void endShell(pane)}><LauncherRowIcon name="trash" /></button>}
    </div>;
  };
  const toggleBusy = busy && !menuOpen;
  return <><span className="terminal-picker-wrap" ref={anchorRef}><button type="button" className={`terminal-picker-toggle toolbar-button${open.length > 0 ? ' panel-open' : ''}${progressBorder(toggleBusy, 'blue')}`} aria-haspopup={hasFlyout ? 'menu' : undefined} data-context-flyout={hasFlyout || undefined} aria-expanded={hasFlyout ? menuOpen : undefined} aria-busy={toggleBusy || undefined} aria-label="Open a terminal" aria-description={minimizedDescription} title="Open a terminal" onClick={() => void toggle()}><ProgressRing busy={toggleBusy} />{hasFlyout && <span className="flyout-caret" aria-hidden="true" />}<LauncherRowIcon name="terminal" /><span className="toolbar-label">Terminal</span>{minimizedCount > 0 && <span className="saved-prompts-count terminal-minimized-count" aria-hidden="true">{minimizedCount}</span>}</button></span>
    {menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div className="terminal-picker flyout-menu" ref={flyoutRef} style={style} role="menu" aria-label="Open a terminal">
      {error !== undefined && <div className="terminal-picker-empty" role="alert">{error}</div>}
      {panes.length === 0 && <div className="terminal-picker-empty">No panes yet</div>}
      {sessionPanes.length > 0 && <><div className="terminal-picker-heading">Session panes</div>{sessionPanes.map(pane => paneRow(pane, false))}</>}
      {hiddenShells.length > 0 && <><div className="terminal-picker-heading">Console shells</div>{hiddenShells.map(pane => paneRow(pane, true))}</>}
      <button type="button" role="menuitem" className="terminal-picker-newshell" disabled={busy} onClick={() => void newShell()}><span aria-hidden="true">＋</span> New shell</button>
    </div></FlyoutPortal>}</>;
}

// render the Editor button: a new Console shell that runs the configured editor, opened as a
// Terminal panel; a failure is reported as operation feedback
function EditorButton({ worktreeId, terminals, onOperationFeedback }: { worktreeId: string; terminals: WorktreeTerminals; onOperationFeedback?: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const [busy, setBusy] = useState(false);
  const openEditor = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const failure = await openNewShell(worktreeId, terminals, true);
      if (failure !== undefined) onOperationFeedback?.({ tone: 'error', message: 'The editor did not open', detail: failure });
    } finally { setBusy(false); }
  };
  return <button type="button" className={`editor-launch toolbar-button${progressBorder(busy, 'blue')}`} aria-busy={busy || undefined} aria-label="Open the editor" title="Open the editor in a new terminal" disabled={busy} onClick={() => void openEditor()}><ProgressRing busy={busy} /><LauncherRowIcon name="editor" /><span className="toolbar-label">Editor</span></button>;
}

// The split columns and the toolbar's Terminal (and, with an `editor` configured, Editor) buttons
// for a Place's Terminals, shared by the Agent tab and the agentless Worktree and Place tabs. A
// target the dashboard placed nowhere gets neither.
function useTerminalViews(worktreeId: string | undefined, onOperationFeedback?: (feedback: Omit<OperationFeedback, 'id'>) => void, onOpenFile?: (path: string) => void): { columns?: TerminalColumn[]; control?: ReactNode; closeAll: () => void; openFocused: (binding?: { table: string; key: string }) => Promise<string | undefined>; end: (paneId: string) => void } {
  const terminals = useWorktreeTerminals(worktreeId);
  const editorConfigured = useContext(EditorConfiguredContext);
  // minimize every visible shell without ending its process
  const closeAll = () => terminals.open.forEach(terminal => terminals.closePane(terminal.paneId));
  // open a new Console shell, or a key binding's Terminal (the server may hand back the one
  // already running), as a focused panel; resolves to its pane id
  const openFocused = async (binding?: { table: string; key: string }): Promise<string | undefined> => {
    if (worktreeId === undefined) return undefined;
    const created = await createPlaceShell(worktreeId, binding === undefined ? {} : { binding });
    if (!('paneId' in created)) { onOperationFeedback?.({ tone: 'error', message: 'The terminal did not open', detail: created.error }); return undefined; }
    const shell = (await terminals.refreshPanes())?.find(pane => pane.paneId === created.paneId);
    requestTerminalFocus(worktreeId, { paneId: created.paneId, name: shell === undefined ? 'shell' : terminalPaneLabel(shell) });
    return created.paneId;
  };
  // end a Console shell the keyboard already confirmed (a busy one still asks); minimize any other
  const end = (paneId: string) => {
    const pane = terminals.panes.find(candidate => candidate.paneId === paneId);
    if (pane !== undefined && isConsoleShell(pane)) void terminals.endPane(pane);
    else terminals.closePane(paneId);
  };
  if (worktreeId === undefined) return { closeAll, openFocused, end };
  // keep destructive actions limited to managed shells
  const columns = terminals.open.map(terminal => {
    const pane = terminals.panes.find(pane => pane.paneId === terminal.paneId);
    const managedShell = pane?.role === 'shell' && !pane.agent;
    return { key: terminal.paneId, label: terminal.name, node: <TerminalPane key={terminal.paneId} worktreeId={worktreeId} paneId={terminal.paneId} name={terminal.name} onMinimize={() => { /* keep the shell running */ terminals.closePane(terminal.paneId); }} onExit={() => { /* remove ended shells from the count */ terminals.forgetPane(terminal.paneId); }} onRename={managedShell ? (name => terminals.renamePane(terminal.paneId, name)) : undefined} onDelete={managedShell ? (() => terminals.endPane(pane)) : undefined} {...(onOpenFile === undefined ? {} : { onOpenFile })} /> };
  });
  return { columns, control: <><TerminalPicker worktreeId={worktreeId} terminals={terminals} />{editorConfigured && <EditorButton worktreeId={worktreeId} terminals={terminals} onOperationFeedback={onOperationFeedback} />}</>, closeAll, openFocused, end };
}

// format one git stat number
const gitNumberLabel = (count: number) => count.toLocaleString('en-US');
// pluralize one git stat count
const gitCountLabel = (count: number, label: string) => `${gitNumberLabel(count)} ${label}${count === 1 ? '' : 's'}`;
const gitConflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const gitChangeState = (code: string) => code === '??' ? 'untracked' : gitConflictCodes.has(code) ? 'conflicted' : code[0] !== ' ' && code[1] !== ' ' ? 'mixed' : code[0] !== ' ' ? 'staged' : 'unstaged';
// The Code panel owns the shared Implementation/Tests-&-docs classifier (it prefers the
// server-assigned category and falls back to the path heuristic); the flyout groups by the same rule.
const gitLineTotals = (changes: GitStatusChange[]) => changes.reduce((totals, change) => ({ additions: totals.additions + (change.additions ?? 0), deletions: totals.deletions + (change.deletions ?? 0) }), { additions: 0, deletions: 0 });
// render one git line summary
function GitLineSummary({ additions, deletions, className }: { additions: number; deletions: number; className: string }) {
  const label = [additions > 0 ? `${gitCountLabel(additions, 'line')} added` : undefined, deletions > 0 ? `${gitCountLabel(deletions, 'line')} removed` : undefined].filter(Boolean).join(', ') || 'No lines added or removed';
  return <span className={className} aria-label={label}><span className="git-lines-added">{additions > 0 ? `+${gitNumberLabel(additions)}` : ''}</span><span className="git-lines-deleted">{deletions > 0 ? `−${gitNumberLabel(deletions)}` : ''}</span></span>;
}
// render one clickable changed-file group
function GitChangeGroup({ label, changes, onOpenFile }: { label: string; changes: GitStatusChange[]; onOpenFile: (path: string) => void }) {
  if (changes.length === 0) return null;
  const totals = gitLineTotals(changes);
  return <span className="git-status-group" role="group" aria-label={`${label} files`}><span className="git-status-group-header"><strong>{label}</strong><span>{gitCountLabel(changes.length, 'file')}</span><GitLineSummary {...totals} className="git-status-group-lines" /></span><GitChangeList changes={changes} onOpenFile={onOpenFile} /></span>;
}
// render clickable changed-file rows
function GitChangeList({ changes, onOpenFile }: { changes: GitStatusChange[]; onOpenFile: (path: string) => void }) {
  return <span className="git-status-file-list">{changes.map((change, index) => <button className={`git-status-file ${gitChangeState(change.code)}`} type="button" aria-label={`View changes to ${change.path}`} title={`View changes to ${change.path}`} key={`${change.code}:${change.path}:${index}`} onClick={() => onOpenFile(change.path)}><span className="git-status-file-code" aria-hidden="true">{change.code}</span><span className="git-status-file-path">{change.originalPath === undefined ? change.path : `${change.originalPath} → ${change.path}`}</span>{change.additions === undefined || change.deletions === undefined ? <span className="git-status-file-lines unavailable">binary</span> : <GitLineSummary additions={change.additions} deletions={change.deletions} className="git-status-file-lines" />}</button>)}</span>;
}

// The commits an All PR Comparison spans, newest first, from GET /api/worktrees/:id/commits
type GitCommit = { sha: string; subject: string; body: string; author: string; authoredAt: string; merge: boolean; pushed: boolean; changes: GitStatusChange[] };
type GitCommitLog = { base: string; commits: GitCommit[]; truncated: boolean };
const isGitCommitLog = (value: unknown): value is GitCommitLog => value !== null && typeof value === 'object'
  && typeof (value as GitCommitLog).base === 'string' && typeof (value as GitCommitLog).truncated === 'boolean' && Array.isArray((value as GitCommitLog).commits)
  && (value as GitCommitLog).commits.every(commit => commit !== null && typeof commit === 'object' && typeof commit.sha === 'string' && typeof commit.subject === 'string' && typeof commit.body === 'string' && typeof commit.authoredAt === 'string' && typeof commit.merge === 'boolean' && typeof commit.pushed === 'boolean' && Array.isArray(commit.changes));
type GitChangeGrouping = 'kind' | 'commit';
const gitChangeGroupingKey = 'rac.git-change-grouping';
const savedGitChangeGrouping = (): GitChangeGrouping => { try { return localStorage.getItem(gitChangeGroupingKey) === 'commit' ? 'commit' : 'kind'; } catch { return 'kind'; } };
// git bodies are hard-wrapped near 72 columns; rejoin each paragraph so a narrow fly-out wraps it naturally
const reflowCommitBody = (body: string) => body.split(/\n{2,}/u).map(paragraph => paragraph.replace(/\n(?![-*] )/gu, ' ')).join('\n\n');
const uncommittedSectionKey = 'uncommitted';
// render one collapsible commit (or the uncommitted changes) with its files
function GitCommitSection({ title, meta, changes, collapsed, onToggle, body, messageOpen, onToggleMessage, onViewChanges, onReview, reviewDisabledReason, onOpenFile, className = '' }: { title: React.ReactNode; meta: React.ReactNode; changes: GitStatusChange[]; collapsed: boolean; onToggle: () => void; body?: string; messageOpen?: boolean; onToggleMessage?: () => void; onViewChanges?: () => void; onReview?: () => void; reviewDisabledReason?: string; onOpenFile: (path: string) => void; className?: string }) {
  const totals = gitLineTotals(changes);
  return <section className={`git-commit-section ${className}${collapsed ? ' collapsed' : ''}`}>
    {/* the whole header toggles; the caret is its keyboard control */}
    <div className="git-commit-head" onClick={onToggle}><button className="git-commit-caret" type="button" aria-expanded={!collapsed} aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={event => { event.stopPropagation(); onToggle(); }}>▾</button><span className="git-commit-title"><span className="git-commit-subject">{title}</span><span className="git-commit-meta">{meta}{!collapsed && body && onToggleMessage !== undefined && <button className="git-commit-message-toggle" type="button" aria-pressed={messageOpen} aria-label={`${messageOpen ? 'Hide' : 'Show'} commit message`} title={`${messageOpen ? 'Hide' : 'Show'} commit message`} onClick={event => { event.stopPropagation(); onToggleMessage(); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" /></svg></button>}{changes.length > 0 && onViewChanges !== undefined && <button className="git-commit-view-changes" type="button" aria-label="View this commit's changes" title="View this commit's changes in the Code panel" onClick={event => { event.stopPropagation(); onViewChanges(); }}><svg viewBox="0 0 24 24" aria-hidden="true">{codeGlyph}</svg></button>}{changes.length > 0 && onReview !== undefined && <button className="git-commit-review" type="button" disabled={reviewDisabledReason !== undefined} aria-label="Start a guided review of this commit" title={reviewDisabledReason ?? 'Start a guided review of this commit'} onClick={event => { event.stopPropagation(); onReview(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16" /></svg></button>}</span></span>{changes.length > 0 && <GitLineSummary {...totals} className="git-status-file-lines" />}</div>
    {!collapsed && messageOpen && body && <p className="git-commit-message">{reflowCommitBody(body)}</p>}
    {!collapsed && changes.length > 0 && <GitChangeList changes={changes} onOpenFile={onOpenFile} />}
  </section>;
}
// render the All PR files grouped under the commit that changed them, uncommitted changes first
function GitCommitSections({ log, error, uncommitted, collapsed, onToggle, messages, onToggleMessage, onViewCommit, onReviewCommit, reviewCommitDisabledReason, onOpenFile }: { log?: GitCommitLog; error?: string; uncommitted: GitStatusChange[]; collapsed: (key: string, merge?: boolean) => boolean; onToggle: (key: string, merge?: boolean) => void; messages: ReadonlySet<string>; onToggleMessage: (sha: string) => void; onViewCommit?: (commit: CodePanelCommit) => void; onReviewCommit?: (commit: CodePanelCommit) => void; reviewCommitDisabledReason?: string; onOpenFile: (path: string, mode: CodePanelMode) => void }) {
  return <>
    {uncommitted.length > 0 && <GitCommitSection className="uncommitted" title="Uncommitted changes" meta={gitCountLabel(uncommitted.length, 'file')} changes={uncommitted} collapsed={collapsed(uncommittedSectionKey)} onToggle={() => onToggle(uncommittedSectionKey)} onOpenFile={path => onOpenFile(path, 'working')} />}
    {log?.commits.map(commit => <GitCommitSection key={commit.sha} className={commit.merge ? 'merge' : ''}
      title={<>{commit.subject}{!commit.pushed && <span className="git-commit-badge local" title="Not on the upstream branch yet">local</span>}{/^(?:fixup|squash|amend)! /u.test(commit.subject) && <span className="git-commit-badge fixup" title="Folded into its target by an autosquash rebase">fixup</span>}{commit.merge && <span className="git-commit-badge merge">merge</span>}</>}
      meta={<><code className="git-commit-sha" title={commit.sha}>{commit.sha.slice(0, 7)}</code>{` · ${relativeAge(Date.parse(commit.authoredAt))}${commit.merge ? '' : ` · ${gitCountLabel(commit.changes.length, 'file')}`}`}</>}
      changes={commit.changes} body={commit.body} collapsed={collapsed(commit.sha, commit.merge)} onToggle={() => onToggle(commit.sha, commit.merge)} messageOpen={messages.has(commit.sha)} onToggleMessage={() => onToggleMessage(commit.sha)} onViewChanges={onViewCommit === undefined ? undefined : () => onViewCommit({ sha: commit.sha, subject: commit.subject })} onReview={onReviewCommit === undefined ? undefined : () => onReviewCommit({ sha: commit.sha, subject: commit.subject })} reviewDisabledReason={reviewCommitDisabledReason} onOpenFile={path => onOpenFile(path, 'pr')} />)}
    {log !== undefined && log.commits.length === 0 && uncommitted.length === 0 && <span className="git-status-empty">No PR changes</span>}
    {log?.truncated && <span className="git-status-empty">Showing the newest {gitNumberLabel(log.commits.length)} commits.</span>}
    {log === undefined && <span className="git-status-empty" role={error === undefined ? 'status' : 'alert'}>{error ?? 'Loading commits…'}</span>}
  </>;
}
// render working changes, current pr controls, and repository switchers
function GitStatus({ worktreeId, branch, summary, prSummary, pullRequest, onFixup, onAddToPrompt, expanded = false, onToggle, onOpenFile, onViewChanges, onViewCommit, onReview, onReviewCommit, review, reviewUnavailable, pushAction = defaultPushAction, pushPending = false, onPush, onSelectTarget, onOperationFeedback }: { worktreeId?: string; branch?: string; summary?: GitStatusSummary; prSummary?: GitComparisonSummary; pullRequest?: PullRequestSummary; onFixup?: () => Promise<boolean>; onAddToPrompt?: (text: string) => void; expanded?: boolean; onToggle?: () => void; onOpenFile: (path: string, mode: CodePanelMode) => void; onViewChanges?: (mode: CodePanelMode) => void; onViewCommit?: (commit: CodePanelCommit) => void; onReview?: (scope: ReviewScope) => void; onReviewCommit?: (commit: CodePanelCommit) => void; review?: ReviewTourIndicator; reviewUnavailable?: string; pushAction?: PromptAction; pushPending?: boolean; onPush?: () => Promise<boolean>; onSelectTarget?: (target: DashboardTarget) => void; onOperationFeedback?: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const [tab, setTab] = useState<'working' | 'prs' | 'branches'>('working');
  const [mode, setMode] = useState<'working' | 'pr'>(prSummary === undefined ? 'working' : 'pr');
  const [removingBranch, setRemovingBranch] = useState<SwitchableBranch>();
  const cachedPrSwitch = worktreeId === undefined ? undefined : pullRequestSwitchCache.get(worktreeId);
  const [prSwitch, setPrSwitch] = useState<PullRequestSwitchAvailability | undefined>(cachedPrSwitch);
  const [prSwitchLoaded, setPrSwitchLoaded] = useState(cachedPrSwitch !== undefined);
  const [prSwitchError, setPrSwitchError] = useState<string>();
  const [loadingPrSwitch, setLoadingPrSwitch] = useState(false);
  const [switchingPr, setSwitchingPr] = useState<number>();
  const [movingPr, setMovingPr] = useState<number>();
  const [switchingBranch, setSwitchingBranch] = useState<string>();
  const [movingBranch, setMovingBranch] = useState<string>();
  const [grouping, setGrouping] = useState<GitChangeGrouping>(savedGitChangeGrouping);
  const [commitLog, setCommitLog] = useState<GitCommitLog>();
  const [commitLogError, setCommitLogError] = useState<string>();
  // sections the user opened or closed; the rest keep their default (a merge starts collapsed)
  const [sectionOverrides, setSectionOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [openMessages, setOpenMessages] = useState<ReadonlySet<string>>(new Set());
  const [commentsOpen, setCommentsOpen] = useState(false);
  // the unresolved count of the last read, fresher than the dashboard's cached pull request
  const [unresolvedThreads, setUnresolvedThreads] = useState<number>();
  const loadComments = useCallback(async () => await loadPullRequestComments(worktreeId!), [worktreeId]);
  const commentsLoaded = useCallback((comments: PullRequestComments) => setUnresolvedThreads(unresolvedThreadCount(comments)), []);
  // reopening the flyout shows its files again
  useEffect(() => { if (!expanded) setCommentsOpen(false); }, [expanded]);
  const repositoryTabVisible = expanded && tab !== 'working';
  const byCommit = mode === 'pr' && grouping === 'commit' && worktreeId !== undefined;
  // default new branches to all pr changes
  useEffect(() => {
    setTab('working');
    setMode(prSummary === undefined ? 'working' : 'pr');
    setCommitLog(undefined);
    setSectionOverrides(new Map());
    setOpenMessages(new Set());
    setCommentsOpen(false);
    setUnresolvedThreads(undefined);
  }, [branch]);
  // load the commit log while By commit shows, and again whenever the git status moves
  useEffect(() => {
    if (!expanded || !byCommit || worktreeId === undefined) return;
    const controller = new AbortController();
    void request(`/api/worktrees/${encodeURIComponent(worktreeId)}/commits`, { signal: controller.signal }).then(async response => {
      const payload: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
      if (isGitCommitLog(payload)) {
        setCommitLog(payload);
        setCommitLogError(undefined);
      } else setCommitLogError('Commits unavailable');
    }).catch(() => {
      // ignore a closed flyout or a superseded load
      if (!controller.signal.aborted) setCommitLogError('Commits unavailable');
    });
    return () => controller.abort();
  }, [expanded, byCommit, worktreeId, summary, prSummary]);
  const sectionCollapsed = (key: string, merge = false) => sectionOverrides.get(key) ?? merge;
  const toggleSection = (key: string, merge = false) => setSectionOverrides(current => new Map(current).set(key, !(current.get(key) ?? merge)));
  const setAllSections = (collapsed: boolean) => setSectionOverrides(new Map([uncommittedSectionKey, ...(commitLog?.commits.map(commit => commit.sha) ?? [])].map(key => [key, collapsed])));
  const toggleMessage = (sha: string) => setOpenMessages(current => {
    const next = new Set(current);
    if (!next.delete(sha)) next.add(sha);
    return next;
  });
  const chooseGrouping = (next: GitChangeGrouping) => {
    setGrouping(next);
    try { localStorage.setItem(gitChangeGroupingKey, next); } catch { /* the choice still holds for this fly-out */ }
  };
  // keep the selected view available
  useEffect(() => {
    // fall back when comparison disappears
    if (mode === 'pr' && prSummary === undefined) setMode('working');
  }, [mode, prSummary]);
  // preload both repository lists whenever the flyout opens
  useEffect(() => {
    // defer remote choices until the flyout is open
    if (!expanded || worktreeId === undefined) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoadingPrSwitch(true);
    void request(`/api/worktrees/${encodeURIComponent(worktreeId)}/switch-prs`, { signal: controller.signal }).then(async response => ({ ok: response.ok, status: response.status, payload: await response.json().catch(() => undefined) })).then(({ ok, status, payload }) => {
      // ignore a closed flyout
      if (cancelled) return;
      // expose the server failure
      if (!ok) {
        const error = payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : `Unable to load repository choices (${status}).`;
        setPrSwitchError(error);
        setPrSwitchLoaded(true);
        setLoadingPrSwitch(false);
        return;
      }
      const availability = payload as { enabled?: unknown; pullRequests?: unknown; otherPullRequests?: unknown; branches?: unknown; pullRequestsSupported?: unknown };
      // validate successful availability
      if (payload !== null && typeof payload === 'object' && typeof availability.enabled === 'boolean' && Array.isArray(availability.pullRequests) && Array.isArray(availability.otherPullRequests) && Array.isArray(availability.branches) && typeof availability.pullRequestsSupported === 'boolean') {
        const next = {
          enabled: availability.enabled,
          pullRequests: switchablePullRequests(availability.pullRequests),
          otherPullRequests: switchablePullRequests(availability.otherPullRequests),
          branches: switchableBranches(availability.branches),
          pullRequestsSupported: availability.pullRequestsSupported
        };
        // cache one workspace list
        if (worktreeId !== undefined) pullRequestSwitchCache.set(worktreeId, next);
        setPrSwitch(next);
        setPrSwitchError(undefined);
      } else {
        setPrSwitchError('The console returned invalid repository data.');
      }
      setPrSwitchLoaded(true);
      setLoadingPrSwitch(false);
    }).catch(() => {
      // retain one actionable client error
      if (!cancelled) {
        setPrSwitchError('Unable to load repository choices.');
        setPrSwitchLoaded(true);
        setLoadingPrSwitch(false);
      }
    });
    // cancel stale repository responses
    return () => {
      cancelled = true;
      controller.abort();
      setLoadingPrSwitch(false);
    };
  }, [worktreeId, expanded]);
  // fit the popup above the toolbar
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    // wait for an expanded anchor
    if (!expanded || wrap === null) return;
    // measure the available viewport
    // place the portal at its former anchored position
    const syncPanelPosition = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const anchorRect = wrap.getBoundingClientRect();
      const anchorTop = anchorRect.top;
      const gap = rootFontSize * .7;
      // unrounded, so a full-height popup meets the viewport's top wherever the toolbar lays out
      const maxHeight = Math.max(0, anchorTop - viewportTop - gap);
    // open upward from the branch shortcut and clamp to the viewport
      const edge = rootFontSize * .375;
      // a phone's toolbar packs the git status near its right end, so the popup spans the screen;
      // wider screens get a fixed width from the button, shifted left to stay on screen
      const phone = window.matchMedia('(max-width: 600px)').matches;
      const width = phone ? window.innerWidth - 2 * edge : Math.min(rootFontSize * 45, window.innerWidth - 2 * edge);
      const left = phone ? edge : Math.max(edge, Math.min(anchorRect.left, window.innerWidth - edge - width));
      setPanelStyle({ position: 'fixed', top: 'auto', left, right: 'auto', bottom: window.innerHeight - anchorTop + gap, width, maxHeight, maxWidth: `calc(100vw - ${left}px - ${edge}px)`, visibility: 'visible' });
    };
    const observer = new ResizeObserver(syncPanelPosition);
    observer.observe(wrap);
    const shell = wrap.closest('.log-shell');
    // follow shell size changes
    if (shell !== null) observer.observe(shell);
    window.addEventListener('resize', syncPanelPosition);
    window.addEventListener('scroll', syncPanelPosition, true);
    window.visualViewport?.addEventListener('resize', syncPanelPosition);
    window.visualViewport?.addEventListener('scroll', syncPanelPosition);
    syncPanelPosition();
    // release viewport listeners
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncPanelPosition);
      window.removeEventListener('scroll', syncPanelPosition, true);
      window.visualViewport?.removeEventListener('resize', syncPanelPosition);
      window.visualViewport?.removeEventListener('scroll', syncPanelPosition);
    };
  }, [expanded]);
  // hide outside repositories
  if (branch === undefined) return null;
  const state = summary === undefined ? 'unavailable' : summary.files === 0 ? 'clean' : summary.conflicted > 0 ? 'conflicted' : 'dirty';
  const stateLabel = summary === undefined
    ? 'status unavailable'
    : summary.files === 0
      ? 'clean'
      : summary.conflicted > 0
        ? `${gitCountLabel(summary.conflicted, 'conflict')} · ${gitCountLabel(summary.files, 'change')}`
        : gitCountLabel(summary.files, 'change');
  const details = summary === undefined ? [] : [
    summary.staged > 0 ? gitCountLabel(summary.staged, 'staged file') : undefined,
    summary.unstaged > 0 ? gitCountLabel(summary.unstaged, 'unstaged file') : undefined,
    summary.untracked > 0 ? gitCountLabel(summary.untracked, 'untracked file') : undefined
  ].filter((value): value is string => value !== undefined);
  const label = `Git status: ${branch}; ${stateLabel}${details.length === 0 ? '' : ` (${details.join(', ')})`}${review?.generating ? '; generating guided review' : ''}`;
  const activeSummary = mode === 'working' ? summary : prSummary;
  const implementationChanges = activeSummary?.changes?.filter(change => !supportingChange(change)) ?? [];
  const supportingChanges = activeSummary?.changes?.filter(supportingChange) ?? [];
  const changedFiles = activeSummary?.changes;
  const prTotals = gitLineTotals(prSummary?.changes ?? []);
  // omit the implied remote only in comparison labels
  const prBaseLabel = prSummary?.base.replace(/^(?:refs\/remotes\/)?origin\//u, '');
  const panelDetails = mode === 'working'
    ? details
    : prSummary === undefined
      ? []
      : [`Compared with ${prBaseLabel}`, ...(byCommit && commitLog !== undefined ? [gitCountLabel(commitLog.commits.length, 'commit')] : []), gitCountLabel(prSummary.files, 'file'), `+${gitNumberLabel(prTotals.additions)} −${gitNumberLabel(prTotals.deletions)}`];
  const emptyLabel = activeSummary?.files === 0 ? mode === 'working' ? 'No working changes' : 'No PR changes' : 'Changed-file details unavailable';
  const disabledReviewReason = review !== undefined ? undefined : reviewUnavailable ?? (activeSummary === undefined ? 'Selected changes unavailable' : undefined);
  // a generating review stays readable while its border reports progress
  const reviewLabel = review?.generating ? 'Generating…' : review !== undefined ? 'Open Review' : 'Review';
  const mutationInFlight = switchingPr !== undefined || movingPr !== undefined || switchingBranch !== undefined || movingBranch !== undefined;
  const otherPullRequestCount = prSwitch?.otherPullRequests.length ?? 0;
  const pullRequestReason = pullRequestStatusReason(loadingPrSwitch, prSwitchError, prSwitchLoaded, prSwitch);
  const branchReason = branchStatusReason(loadingPrSwitch, prSwitchError, prSwitchLoaded, prSwitch);
  // queue the configured branch completion action
  const commitPush = async () => {
    // close only after the prompt was accepted
    if (await onPush?.()) onToggle?.();
  };
  // close the branch panel before navigating worktrees
  const selectWorktree = (target: DashboardTarget) => {
    onToggle?.();
    onSelectTarget?.(target);
  };
  // check out one pull request branch
  const switchPullRequest = async (number: number) => {
    // prevent duplicate checkout transactions
    if (worktreeId === undefined || mutationInFlight) return;
    setSwitchingPr(number);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/switch-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) });
      // surface a rejected server transaction
      if (!response.ok) {
        onOperationFeedback?.({ tone: 'error', message: 'Pull request could not be checked out', detail: await launchError(response), worktreeId });
        return;
      }
      // discard stale checkout ownership after success
      if (worktreeId !== undefined) pullRequestSwitchCache.delete(worktreeId);
      onToggle?.();
    } catch {
      onOperationFeedback?.({ tone: 'error', message: 'Pull request could not be checked out', detail: 'The console could not be reached. Check the worktree before trying again.', worktreeId });
    } finally {
      setSwitchingPr(undefined);
    }
  };
  // move one occupied pull request into this worktree
  const movePullRequest = async (number: number) => {
    // prevent duplicate move transactions
    if (worktreeId === undefined || mutationInFlight) return;
    setMovingPr(number);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/move-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) });
      // surface a rejected server transaction
      if (!response.ok) {
        onOperationFeedback?.({ tone: 'error', message: 'Pull request could not be moved', detail: await launchError(response), worktreeId });
        return;
      }
      // discard stale checkout ownership after success
      if (worktreeId !== undefined) pullRequestSwitchCache.delete(worktreeId);
      onToggle?.();
      onOperationFeedback?.({ tone: 'success', message: 'Pull request moved here', detail: 'The source worktree was detached and its uncommitted changes were restored here.', worktreeId });
    } catch {
      onOperationFeedback?.({ tone: 'error', message: 'Pull request could not be moved', detail: 'The console could not be reached. Check both worktrees before trying again.', worktreeId });
    } finally {
      setMovingPr(undefined);
    }
  };
  // check out one local branch
  const switchBranch = async (nextBranch: string) => {
    // prevent duplicate checkout transactions
    if (worktreeId === undefined || mutationInFlight) return;
    setSwitchingBranch(nextBranch);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/switch-branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: nextBranch }) });
      // surface a rejected server transaction
      if (!response.ok) {
        onOperationFeedback?.({ tone: 'error', message: 'Branch could not be checked out', detail: await launchError(response), worktreeId });
        return;
      }
      // discard stale checkout ownership after success
      if (worktreeId !== undefined) pullRequestSwitchCache.delete(worktreeId);
      onToggle?.();
    } catch {
      onOperationFeedback?.({ tone: 'error', message: 'Branch could not be checked out', detail: 'The console could not be reached. Check the worktree before trying again.', worktreeId });
    } finally {
      setSwitchingBranch(undefined);
    }
  };
  // move one occupied branch into this worktree
  const moveBranch = async (nextBranch: string) => {
    // prevent duplicate move transactions
    if (worktreeId === undefined || mutationInFlight) return;
    setMovingBranch(nextBranch);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/move-branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: nextBranch }) });
      // surface a rejected server transaction
      if (!response.ok) {
        onOperationFeedback?.({ tone: 'error', message: 'Branch could not be moved', detail: await launchError(response), worktreeId });
        return;
      }
      // discard stale checkout ownership after success
      if (worktreeId !== undefined) pullRequestSwitchCache.delete(worktreeId);
      onToggle?.();
      onOperationFeedback?.({ tone: 'success', message: 'Branch moved here', detail: 'The source worktree was detached and its uncommitted changes were restored here.', worktreeId });
    } catch {
      onOperationFeedback?.({ tone: 'error', message: 'Branch could not be moved', detail: 'The console could not be reached. Check both worktrees before trying again.', worktreeId });
    } finally {
      setMovingBranch(undefined);
    }
  };
  // open fresh branch deletion safeguards
  const reviewBranchRemoval = (nextBranch: SwitchableBranch) => {
    onToggle?.();
    setRemovingBranch(nextBranch);
  };
  // remove one deleted branch from cached and visible choices
  const branchRemoved = () => {
    // require the active deletion target
    if (removingBranch === undefined) return;
    // discard stale repository choices
    if (worktreeId !== undefined) pullRequestSwitchCache.delete(worktreeId);
    setPrSwitch(current => current === undefined ? current : { ...current, branches: current.branches.filter(candidate => candidate.branch !== removingBranch.branch) });
    setRemovingBranch(undefined);
    onOperationFeedback?.({ tone: 'success', message: 'Branch deleted', detail: `${removingBranch.branch} was deleted.`, worktreeId });
  };
  const groupingToolbar = mode === 'pr' && worktreeId !== undefined && <span className="git-status-grouping">{byCommit && <span className="git-status-grouping-actions"><button type="button" onClick={() => setAllSections(true)}>Collapse all</button><button type="button" onClick={() => setAllSections(false)}>Expand all</button></span>}<span className="git-status-mode" role="group" aria-label="Group files by"><button type="button" aria-pressed={grouping === 'kind'} onClick={() => chooseGrouping('kind')}>By kind</button><button type="button" aria-pressed={grouping === 'commit'} onClick={() => chooseGrouping('commit')}>By commit</button></span></span>;
  const commentsToggle = worktreeId === undefined ? undefined : { open: commentsOpen, unresolved: unresolvedThreads ?? pullRequest?.unresolvedThreads ?? 0, onToggle: () => setCommentsOpen(open => !open) };
  const commentsPanel = commentsOpen && worktreeId !== undefined && pullRequest !== undefined && pullRequest.status !== 'merged' ? <PullRequestCommentsPanel load={loadComments} onLoaded={commentsLoaded} onAddToPrompt={onAddToPrompt} /> : undefined;
  const workingPanel = <>{commentsPanel ?? <><span className="git-status-panel-header"><strong>{mode === 'working' ? 'Working changes' : 'PR changes'}</strong>{panelDetails.length > 0 && <small className="git-status-details">{panelDetails.join(' · ')}</small>}</span>{byCommit ? <span className="git-status-files">{groupingToolbar}<GitCommitSections log={commitLog} error={commitLogError} uncommitted={summary?.changes ?? []} collapsed={sectionCollapsed} onToggle={toggleSection} messages={openMessages} onToggleMessage={toggleMessage} onViewCommit={onViewCommit} onReviewCommit={onReviewCommit} reviewCommitDisabledReason={review === undefined ? undefined : 'Dismiss the current guided review to start another'} onOpenFile={onOpenFile} /></span> : changedFiles !== undefined && changedFiles.length > 0 ? <span className="git-status-files">{groupingToolbar}<GitChangeGroup label="Implementation" changes={implementationChanges} onOpenFile={path => onOpenFile(path, mode)} /><GitChangeGroup label="TESTS & DOCS" changes={supportingChanges} onOpenFile={path => onOpenFile(path, mode)} /></span> : <span className="git-status-empty">{emptyLabel}</span>}</>}<span className="git-status-panel-footer"><span className="git-status-actions">{onViewChanges !== undefined && <button className="git-status-view-changes" type="button" disabled={changedFiles === undefined || changedFiles.length === 0} title={`View all ${mode === 'working' ? 'Working' : 'All PR'} changes in the Code panel`} onClick={() => onViewChanges(mode)}>View changes</button>}<button className={`git-status-review${progressBorder(review?.generating === true, 'peach')}`} type="button" aria-busy={review?.generating || undefined} disabled={onReview === undefined || disabledReviewReason !== undefined} title={disabledReviewReason ?? (review?.generating ? 'Generating the guided review — open it to watch progress or cancel' : review !== undefined ? 'Open the current guided review' : `Start guided review of ${mode === 'working' ? 'Working' : 'All PR'} changes`)} onClick={() => onReview?.(mode)}><ProgressRing busy={review?.generating === true} />{reviewLabel}</button>{onPush !== undefined && <button className={`git-status-push${progressBorder(pushPending, 'blue')}`} type="button" aria-busy={pushPending || undefined} disabled={pushPending} onClick={() => void commitPush()}><ProgressRing busy={pushPending} /><MoreMenuIcon name="push" />{pushAction.label}</button>}{/* keep fixes beside the push action */}<PullRequestFixup pullRequest={pullRequest} onFixup={onFixup} pending={pushPending} /></span>{/* keep the current pr between actions and view modes */}<PullRequestCard pullRequest={pullRequest} comments={commentsToggle} /><span className="git-status-mode" role="group" aria-label="Git change view"><button type="button" aria-pressed={mode === 'working'} onClick={() => setMode('working')}>Working</button><button type="button" aria-pressed={mode === 'pr'} disabled={prSummary === undefined} title={prSummary === undefined ? 'Merge target unavailable' : `Compare with ${prBaseLabel}`} onClick={() => setMode('pr')}>All PR</button></span></span></>;
  const pullRequestPanel = <><span className="git-status-panel-header"><strong>Pull requests</strong>{pullRequestReason !== undefined && <small className={`git-status-details${prSwitchError === undefined ? '' : ' error'}`} role={prSwitchError === undefined ? 'status' : 'alert'} aria-label={pullRequestReason}>{pullRequestReason}</small>}</span><span className="git-status-switch-list">{prSwitch?.pullRequests.map(pullRequest => <SwitchPullRequestOption key={pullRequest.number} pullRequest={pullRequest} currentWorktreeId={worktreeId} enabled={prSwitch.enabled} loading={loadingPrSwitch} refreshFailed={prSwitchError !== undefined} switchingPr={switchingPr} movingPr={movingPr} onSwitch={switchPullRequest} onMove={movePullRequest} onSelectTarget={selectWorktree} />)}{prSwitch !== undefined && otherPullRequestCount > 0 && <details className="other-pull-requests"><summary>Pull requests by others <span>{otherPullRequestCount}</span></summary><div>{prSwitch.otherPullRequests.map(pullRequest => <SwitchPullRequestOption key={pullRequest.number} pullRequest={pullRequest} currentWorktreeId={worktreeId} enabled={prSwitch.enabled} loading={loadingPrSwitch} refreshFailed={prSwitchError !== undefined} switchingPr={switchingPr} movingPr={movingPr} onSwitch={switchPullRequest} onMove={movePullRequest} onSelectTarget={selectWorktree} />)}</div></details>}</span></>;
  const branchPanel = <><span className="git-status-panel-header"><strong>Branches</strong>{branchReason !== undefined && <small className={`git-status-details${prSwitchError === undefined ? '' : ' error'}`} role={prSwitchError === undefined ? 'status' : 'alert'} aria-label={branchReason}>{branchReason}</small>}</span><span className="git-status-switch-list">{prSwitch?.branches.map(candidate => <SwitchBranchOption key={candidate.branch} branch={candidate} enabled={prSwitch.enabled} loading={loadingPrSwitch} refreshFailed={prSwitchError !== undefined} switchingBranch={switchingBranch} movingBranch={movingBranch} onSwitch={switchBranch} onMove={moveBranch} onDelete={worktreeId === undefined ? undefined : reviewBranchRemoval} onSelectTarget={selectWorktree} />)}</span></>;
  let activePanel = workingPanel;
  // show pull request choices
  if (tab === 'prs') activePanel = pullRequestPanel;
  // show local branch choices
  if (tab === 'branches') activePanel = branchPanel;
  return <span ref={wrapRef} className={`git-status-wrap${expanded ? ' expanded' : ''}`}><button className={`git-status-summary ${state}${pullRequest === undefined ? '' : ` has-pull-request status-${pullRequest.status}`}${review !== undefined ? ' review-ready' : ''}${review?.generating ? ' review-generating progress-border progress-peach' : ''}${review?.stale ? ' review-stale' : ''}`} type="button" aria-label={label} aria-busy={review?.generating || undefined} data-context-flyout aria-expanded={expanded} title={label} onClick={onToggle}><ProgressRing busy={review?.generating === true} /><span className="flyout-caret" aria-hidden="true" /><svg className="git-branch-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="7" r="2.5" /><path d="M6 7.5v9M18 9.5v1a6 6 0 0 1-6 6H6" /></svg><span className="git-status-dot" aria-hidden="true" /><span className="git-branch">{branch}</span><span className="git-status-separator" aria-hidden="true">·</span><span className="git-worktree-state">{stateLabel}</span>{/* retain compact pr indicators beside the prompt */}{pullRequest !== undefined && <PullRequestIndicators checks={pullRequest.checks} issues={pullRequest.issues} />}</button>{expanded && <FlyoutPortal onDismiss={() => onToggle?.()}><div className="git-status-panel" role="region" aria-label="Changed files" aria-busy={repositoryTabVisible && loadingPrSwitch} style={panelStyle}>{activePanel}<span className="git-status-tabs" role="tablist" aria-label="Branch views"><button type="button" role="tab" aria-selected={tab === 'working'} onClick={() => setTab('working')}>Working</button><button type="button" role="tab" className={loadingPrSwitch ? 'progress-border progress-blue' : undefined} aria-selected={tab === 'prs'} aria-busy={loadingPrSwitch || undefined} disabled={worktreeId === undefined} title={worktreeId === undefined ? 'Pull requests are listed for worktrees only' : undefined} onClick={() => { /* keep preloading while changing views */ setTab('prs'); }}><ProgressRing busy={loadingPrSwitch} />PRs</button><button type="button" role="tab" className={loadingPrSwitch ? 'progress-border progress-blue' : undefined} aria-selected={tab === 'branches'} aria-busy={loadingPrSwitch || undefined} disabled={worktreeId === undefined} title={worktreeId === undefined ? 'Branches are listed for worktrees only' : undefined} onClick={() => { /* keep preloading while changing views */ setTab('branches'); }}><ProgressRing busy={loadingPrSwitch} />Branches</button></span></div></FlyoutPortal>}{removingBranch !== undefined && worktreeId !== undefined && <RemoveBranchDialog worktreeId={worktreeId} branch={removingBranch} onClose={() => setRemovingBranch(undefined)} onDeleted={branchRemoved} />}</span>;
}

// The Place a Workspace shows: the fields it reads from a Worktree, a directory-Project or Scratch
// Place, or an Agent. `id` is the Place id (a Worktree's is its Worktree id), which keys the
// Terminals, notes, browser and split sizes and their browser storage. `worktreeId` is set only
// when the Place is a git Worktree: the Code panel's Comparisons and the Named conversations are
// git-only routes. An Agent the dashboard placed nowhere passes neither. `path` is the folder the
// toolbar shows for a Place without git, and `stack` the Worktree's stack commands.
type WorkspacePlace = { id?: string; worktreeId?: string; path?: string; stack?: Stack; projectUrl?: string; projectProxied?: boolean; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; pullRequest?: PullRequestSummary; attention?: string };
// What the Place's notes need from the Agent there (or, with no Agent, how a note's Run launches one).
type WorkspaceNotesOptions = { agentWorking?: boolean; latestAssistantMessage?: string; latestAssistantMessageOverflows?: boolean; onPromptHistoryChanged?: () => void | Promise<void>; promptHistory?: PromptHistoryEntry[]; schedulePrefill?: SchedulePrefill; onLaunchAndRun?: (noteId: string) => Promise<boolean>; launchRunLabel?: string };

// keep all place-scoped panel state behind one tab
// and git expansion. The tab's card holds it, so it outlives a switch between the Agents there;
// the agent panel's composer drives the same browser and Terminals, and the Workspace renders it.
// `onCloseReview`, given while the guided review's panel is open here, minimizes it.
function useWorkspace(place: WorkspacePlace, { agentId, noteOptions: notes, onNavigateWorktree, onOperationFeedback, onCloseReview }: { agentId?: string; noteOptions: WorkspaceNotesOptions; onNavigateWorktree?: (worktreeId: string) => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void; onCloseReview?: () => void }) {
  const browser = useProjectBrowser(place.projectUrl, place.id, place.projectProxied);
  const code = useCodePanel(place.worktreeId, request, comparisonChangeSignal(place.gitStatus, place.gitPrStatus, place.attention));
  const files = useFilesController(place.id, request);
  const stackPanel = useStackPanel(place.worktreeId);
  // keep the toolbar dots aligned with the visible phone panel
  const [carousel, setCarousel] = useState<PanelCarousel>();
  const settingsSplit = useContext(ClientSettingsSplitContext);
  const conversations = useWorktreeConversations(place.worktreeId, agentId, { onNavigateWorktree, onOperationFeedback });
  // the panel filling the Workspace; the notes restore theirs, so they share it
  const expansion = usePanelExpansion();
  const terminalPlaceId = place.id;
  // open ordinary Terminal file mentions through the owning Place's preview route
  const openTerminalFile = terminalPlaceId === undefined ? undefined : (path: string) => {
    expansion.restore();
    const mounted = code.open;
    code.openFilePreview(path, `/api/worktrees/${encodeURIComponent(terminalPlaceId)}/file-preview`);
    // reveal the existing split immediately or after its first mount
    if (mounted) carousel?.show('code');
    else window.requestAnimationFrame(() => carousel?.show('code'));
  };
  const terminals = useTerminalViews(terminalPlaceId, onOperationFeedback, openTerminalFile);
  // keep note capture available even when the agent panel is minimized
  const promptDraftId = agentId ?? (place.worktreeId === undefined ? undefined : worktreePromptId(place.worktreeId));
  const promptNote = promptDraftId === undefined ? undefined : { id: promptDraftId, placeId: place.id, worktreeId: place.worktreeId, onOperationFeedback };
  const placeNotes = useWorktreeNotes(place.id, expansion, agentId, notes.agentWorking, notes.latestAssistantMessage, notes.latestAssistantMessageOverflows, notes.onPromptHistoryChanged, notes.promptHistory, notes.schedulePrefill, notes.onLaunchAndRun, notes.launchRunLabel, promptNote);
  const [gitExpanded, setGitExpanded] = useState(false);
  const key = place.id === undefined ? `agent-${agentId ?? 'pending'}` : placeItemKey(place.id);
  useWorkspaceViewRevision();
  const agentHidden = agentSplitHidden(key);
  // bring a requested split into view; focus its container, or with `input` its terminal or composer
  const jump = (panelKey: string, input = false) => {
    expansion.restore();
    carousel?.show(panelKey);
    window.requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>(`[data-workspace-key="${CSS.escape(key)}"] .log-split ${splitPanelSelector(panelKey)}`);
      panel?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (panel === null) return;
      // the agent panel's input is its composer, ahead of the xterm showing its output
      const field = input ? panel.querySelector<HTMLElement>('.prompt-composer textarea:not([disabled])') ?? panel.querySelector<HTMLElement>('.xterm-helper-textarea') : null;
      if (field !== null) { field.focus({ preventScroll: true }); return; }
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    });
  };
  // the panels focus last visited, newest first, for last-panel and the current panel
  const panelHistory = useRef<string[]>([]);
  const carouselRef = useRef(carousel);
  carouselRef.current = carousel;
  const panelKeyOf = (element: Element | null): string | undefined => {
    const panel = element?.closest(`[data-workspace-key="${CSS.escape(key)}"] .log-split > *`);
    return panel == null ? undefined : carouselRef.current?.panels.find(candidate => panel.matches(splitPanelSelector(candidate.key)))?.key;
  };
  useEffect(() => {
    const visit = (event: FocusEvent) => {
      const panel = panelKeyOf(event.target instanceof Element ? event.target : null);
      if (panel !== undefined && panel !== panelHistory.current[0]) panelHistory.current = [panel, ...panelHistory.current.filter(candidate => candidate !== panel)].slice(0, 8);
    };
    document.addEventListener('focusin', visit);
    return () => document.removeEventListener('focusin', visit);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const openKeys = () => carouselRef.current?.panels.map(panel => panel.key) ?? [];
  const currentPanel = () => panelKeyOf(document.activeElement) ?? panelHistory.current.find(panel => openKeys().includes(panel)) ?? carouselRef.current?.visibleKey ?? openKeys()[0];
  // close a panel the way its own header does, except a Console shell, which ends (tmux kill-pane)
  const closePanel = (panelKey: string) => {
    if (panelKey === 'agent') setAgentSplitHidden(key, true);
    else if (panelKey === 'note') { if (placeNotes.canClose) placeNotes.close(); }
    else if (panelKey === 'browser') browser.close();
    else if (panelKey === 'files') files.close();
    else if (panelKey === 'code') code.close();
    else if (panelKey === 'stack') stackPanel.close();
    else if (panelKey === 'review') onCloseReview?.();
    else if (panelKey === 'settings') settingsSplit?.close();
    else terminals.end(panelKey);
  };
  // open a Terminal (a new shell, or a key binding's). A new panel comes into view and takes focus
  // as it mounts; one already open (a reused binding) is jumped to here.
  const openTerminal = (binding?: { table: string; key: string }) => void terminals.openFocused(binding).then(paneId => {
    const live = workspaceViews.get(key);
    if (paneId !== undefined && live?.splits.some(split => split.key === paneId)) live.jump(paneId, true);
  });
  // publish only live view callbacks for the active workspace
  useLayoutEffect(() => {
    const view = {
      splits: (carousel?.panels ?? []).map(panel => ({ key: panel.key, label: panel.title })),
      canClose: !placeNotes.active || placeNotes.canClose,
      // preflight settings before external workspace shutdown can stop sessions
      prepareClose: () => settingsSplit?.close() ?? Promise.resolve(true),
      closeAll: async () => {
        // preserve attachment or metadata mutations before closing any siblings
        if (placeNotes.active && !placeNotes.canClose) return;
        // cancelled settings confirmation leaves every sibling split open
        if (settingsSplit?.open && !await settingsSplit.close()) return;
        // close only a visible note
        if (placeNotes.active) placeNotes.close();
        browser.close();
        files.close();
        code.close();
        stackPanel.close();
        onCloseReview?.();
        terminals.closeAll();
        expansion.restore();
        // retain a restore action only when an agent or draft was actually visible
        if (carousel?.panels.some(panel => panel.key === 'agent')) setAgentSplitHidden(key, true);
      },
      jump,
      currentPanel,
      lastPanel: () => { const current = currentPanel(); return panelHistory.current.find(panel => panel !== current && openKeys().includes(panel)); },
      toggleExpand: expansion.toggle,
      renamePanel: (panelKey: string) => { const open = terminalRenamers.get(panelKey); open?.(); return open !== undefined; },
      closePanel,
      openTerminal,
      ...(place.worktreeId === undefined ? {} : {
        toggleCode: () => {
          if (code.open) return code.close();
          // focus the panel once it reaches the carousel
          pendingWorkspaceJumps.set(key, 'code');
          code.openChanges('working');
        }
      })
    };
    workspaceViews.set(key, view);
    const requested = pendingWorkspaceJumps.get(key);
    // wait until restored panels have reached the carousel
    if (requested !== undefined && view.splits.some(panel => panel.key === requested)) {
      pendingWorkspaceJumps.delete(key);
      jump(requested);
    }
    return () => { /* release only this mounted view */ if (workspaceViews.get(key) === view) workspaceViews.delete(key); };
  });
  // restore and reveal a minimized agent without creating a new session
  const showAgent = () => { pendingWorkspaceJumps.set(key, 'agent'); setAgentSplitHidden(key, false); };
  // open the Stack panel (on `selection`, when given) and bring it into view
  const openStackPanel = (selection?: StackSelection) => { stackPanel.openOn(selection); pendingWorkspaceJumps.set(key, 'stack'); };
  // share configured-editor terminals between Code jumps and full-host Files entries
  const editorConfigured = useContext(EditorConfiguredContext);
  const placeId = place.id;
  const openInEditor = !editorConfigured || placeId === undefined ? undefined : async (target: EditorShellTarget): Promise<boolean> => {
    expansion.restore();
    const failure = await openEditorShell(placeId, target);
    // preserve editor failure feedback while allowing a Files preview fallback
    if (failure !== undefined) onOperationFeedback?.({ tone: 'error', message: 'objectToken' in target ? 'The editor did not open; trying Code instead' : 'The editor did not open', detail: failure });
    return failure === undefined;
  };
  return { place, browser, files, code, stackPanel, openStackPanel, terminals, carousel, setCarousel, conversations, notes: placeNotes, expansion, gitExpanded, setGitExpanded, agentHidden, showAgent, openInEditor, viewKey: key };
}
type WorkspaceState = ReturnType<typeof useWorkspace>;
// The git actions only an Agent offers (push, fixup, guided review); an agentless Workspace passes
// the reason review is unavailable plus the navigation and feedback branch checkout reports through.
type WorkspaceGitActions = Omit<Parameters<typeof GitStatus>[0], 'branch' | 'summary' | 'prSummary' | 'pullRequest' | 'expanded' | 'onToggle' | 'onOpenFile' | 'onViewChanges'>;

// The Place's git status control. Opening a changed file or the changes collapses it and shows them
// in the Code panel.
function WorkspaceGitStatus({ workspace, actions, onToggle }: { workspace: WorkspaceState; actions?: WorkspaceGitActions; onToggle?: () => void }) {
  const { place, code, setGitExpanded } = workspace;
  const onReview = actions?.onReview;
  const onReviewCommit = actions?.onReviewCommit;
  const onAddToPrompt = actions?.onAddToPrompt;
  return <GitStatus {...actions} onAddToPrompt={onAddToPrompt === undefined ? undefined : text => { setGitExpanded(false); workspace.expansion.restore(); onAddToPrompt(text); workspace.carousel?.show('agent'); }} worktreeId={place.worktreeId} branch={place.branch} summary={place.gitStatus} prSummary={place.gitPrStatus} pullRequest={place.pullRequest} expanded={workspace.gitExpanded} onToggle={() => { onToggle?.(); setGitExpanded(value => !value); }} onOpenFile={(path, mode) => { setGitExpanded(false); code.openChanges(mode, path); }} onViewChanges={mode => { setGitExpanded(false); code.openChanges(mode); }} onViewCommit={commit => { setGitExpanded(false); code.openCommit(commit); }} onReview={onReview === undefined ? undefined : scope => { setGitExpanded(false); onReview(scope); }} onReviewCommit={onReviewCommit === undefined ? undefined : commit => { setGitExpanded(false); onReviewCommit(commit); }} />;
}

// Render one Place's panels in the resizable split: the agent panel first (while an Agent runs or
// is starting here), then Terminals, note, browser, code and stack. With no panel open the Workspace
// shows `empty` instead. With no agent panel the Workspace is idle.
// `onOpenWorktreeStack` is a used process's Open in the Stack panel, which switches to its Worktree.
function Workspace({ workspace, output, empty, git, reviewPanel, onAddToPrompt, onOpenWorktreeStack }: { workspace: WorkspaceState; output?: ReactNode; empty?: ReactNode; git?: WorkspaceGitActions; reviewPanel?: ReactNode; onAddToPrompt?: (text: string) => void; onOpenWorktreeStack?: (worktreeId: string) => void }) {
  const { place, browser, files, code, stackPanel, notes, expansion } = workspace;
  const projects = useContext(ProjectsContext);
  const visibleOutput = workspace.agentHidden ? undefined : output;
  const idle = visibleOutput === undefined || visibleOutput === null;
  // With no Agent there is no output to split against, so the Code panel opens filling the Workspace.
  useLayoutEffect(() => { if (idle && code.open) expansion.setExpanded('code', true); }, [idle, code.open, expansion.setExpanded]);
  // Terminal selections save into this Place's notes or go to the card's composer.
  const terminalSelectionActions: TerminalSelectionActions = {
    canCreateNote: notes.canCreate,
    createNote: text => notes.createWithText(text, assistantNoteTitle(text)),
    addToPrompt: onAddToPrompt
  };
  // share selection destinations across every panel and its composer
  const selectionActions: SelectionActions = {
    agentOpen: !idle,
    noteOpen: notes.active,
    canCreateNote: notes.canCreate,
    canAppendToNote: notes.canAppendToActive,
    appendToNote: text => { expansion.restore(); notes.appendToActive(text); workspace.carousel?.show('note'); },
    createNote: async text => {
      const created = await notes.createWithText(text, assistantNoteTitle(text));
      // reveal a newly created note without disturbing failed saves
      if (created) { expansion.restore(); workspace.carousel?.show('note'); }
    },
    addToPrompt: onAddToPrompt === undefined ? undefined : text => { expansion.restore(); onAddToPrompt(text); workspace.carousel?.show('agent'); }
  };
  const browserPane = browser.url === undefined || browser.homeUrl === undefined ? null : <ProjectBrowserPane url={browser.url} homeUrl={browser.homeUrl} proxied={browser.proxied} worktreeId={place.id} navigationRequest={browser.navigationRequest} onNavigate={browser.navigate} onClose={browser.close} />;
  const review = git === undefined || (git.onReview === undefined && git.reviewUnavailable === undefined) ? undefined : { onReview: git.onReview, open: git.review !== undefined, generating: git.review?.generating === true, unavailable: git.reviewUnavailable };
  const openInEditor = workspace.openInEditor;
  // prefer the configured editor and retain Code as the file-open fallback
  const openFilesEntry = async (entry: FileEntry) => {
    // require one place for editor and preview routing
    if (place.id === undefined) return;
    expansion.restore();
    // keep host paths behind the server-validated object capability
    if (openInEditor !== undefined && await openInEditor({ objectToken: entry.objectToken })) return;
    const mounted = code.open;
    code.openFilePreview(entry.hostPath, `/api/worktrees/${encodeURIComponent(place.id)}/files/preview`, { body: { objectToken: entry.objectToken }, source: 'files' });
    // wait one frame only when the code split must mount first
    if (mounted) workspace.carousel?.show('code'); else window.requestAnimationFrame(() => workspace.carousel?.show('code'));
  };
  const filesPane = files.open && place.id !== undefined ? <FilesPanel controller={files} onOpenFile={openFilesEntry} /> : null;
  const codePane = code.open ? <CodePane controller={code} prAvailable={place.gitPrStatus !== undefined} branch={place.branch} review={review} onReturnToFiles={() => { expansion.restore(); workspace.carousel?.show('files'); }} onReturnToSettings={() => { /* retain settings drafts while returning from the read-only base */ expansion.restore(); workspace.carousel?.show('settings'); }} {...(openInEditor === undefined ? {} : { onOpenInEditor: (target: EditorTarget) => void openInEditor(target) })} /> : null;
  const stackName = stackPlaceName(place.worktreeId, projects);
  const placeId = place.id;
  // the Stack panel shows only for a Worktree whose stack has processes to show
  const stackPane = !stackPanel.open || place.worktreeId === undefined || (place.stack?.processes?.length ?? 0) === 0 ? null : <StackPanel worktreeId={place.worktreeId} title={stackName === undefined ? 'this worktree' : `${stackName.project} / ${stackName.worktree}`} stack={place.stack} selection={stackPanel.selection} onSelect={stackPanel.select} onClose={stackPanel.close} handlers={stackHandlers(place.worktreeId)} onOpenWorktree={onOpenWorktreeStack} onOpenTerminal={placeId === undefined ? undefined : (paneId, name) => { /* on a phone an already-open panel is scrolled to; a new one comes into view as it opens */ workspace.carousel?.show(paneId); requestTerminalFocus(placeId, { paneId, name }); }} readOutput={processOutput} clearOutput={clearProcessOutput} />;
  return <SelectionActionsContext.Provider value={selectionActions}><section className="log-shell" data-workspace-key={workspace.viewKey}><div className={`log${idle ? ' inactive-log' : ''}`}><ResizableLogSplit withSettings worktreeId={place.id} expansion={expansion} output={visibleOutput} empty={empty} note={notes.pane} browser={browserPane} files={filesPane} code={codePane} codeController={code} review={reviewPanel} stack={stackPane} terminals={workspace.terminals.columns} terminalSelectionActions={terminalSelectionActions} onCarousel={workspace.setCarousel} initialPanelsReady={notes.initialNotesLoaded} /></div></section></SelectionActionsContext.Provider>;
}

type LogProps = { id: string; onTurnOff?: () => void; embedded?: boolean; codexScrollControls?: boolean; onQuestion: (question: ChoiceQuestion | undefined) => void; onMetadata?: (response: string | undefined, overflow: boolean) => void; header?: (connection: string) => ReactNode; composer?: ReactNode; notes?: WorktreeNotes; onAddToPrompt?: (text: string) => void; onOpenUrl?: (url: string) => boolean; onOpenFile?: (path: string) => void; processingLabel?: string; processingDetail?: string };

// Render one Agent's live output: the streamed pane, its loading and status overlays and the
// selection toolbar. As the agent panel it also carries the header and composer the owning card
// hands it (the header receives the connection status to show); the embedded update advisor has
// neither. The Workspace around it owns everything Place-scoped (notes, browser, code, Terminals, git).
function Log({ id, onTurnOff, embedded = false, codexScrollControls = false, onQuestion, onMetadata, header, composer, notes, onAddToPrompt, onOpenUrl, onOpenFile, processingLabel, processingDetail }: LogProps) {
  const canvas = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | undefined>(undefined);
  // A Log mounts whenever its tab becomes active. Existing agents therefore
  // begin by attaching to their live output, not by starting a new process.
  const [status, setStatus] = useState('Connecting');
  const [hasRendered, setHasRendered] = useState(false);
  // The agent output's share of the Workspace's expansion. The `.expanded` class is what the
  // split's `:has()` rule promotes to fill the Workspace; the header's expand control drives it.
  const expand = usePanelExpand('agent');
  const expanded = expand?.expanded === true;
  const [inputActive, setInputActive] = useState(false);
  const [selectionActive, setSelectionActive] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<{ text: string; top: number }>();
  // the toolbar's Copy copies, flashes, then deselects; its other actions deselect when done
  const copyOutputSelectionRef = useRef<(value: string) => Promise<void>>(copyText);
  const clearOutputSelectionRef = useRef<() => void>(() => {});
  const selectionControllerRef = useRef<TerminalSelectionController | undefined>(undefined);
  const pasteOutputRef = useRef<((text: string) => void) | undefined>(undefined);
  const workspaceSelectionActions = useSelectionActions();
  const onMetadataRef = useRef(onMetadata);
  onMetadataRef.current = onMetadata;
  // retain the file opener across terminal reconnections (pane file links call it)
  const openOutputFileRef = useRef(onOpenFile);
  openOutputFileRef.current = onOpenFile;
  // retain browser routing across terminal connections
  const openOutputUrlRef = useRef(onOpenUrl);
  openOutputUrlRef.current = onOpenUrl;
  useEffect(() => {
    // The Agent's pane — and the embedded update advisor's pane — stream over `/ws/pane/:id`:
    // the streamed terminal component (xterm 6.0) is the only pane viewer. `embedded` drops the
    // panel chrome (server switcher, footer controls, the global font shortcut) but shares this mount.
    let disposed = false;
    let latestQuestion: InlineQuestion | undefined;
    let dismissedQuestionId = dismissedQuestionIds.get(id);
    setStatus('Connecting');
    setHasRendered(false);
    setInputActive(false);
    setSelectionActive(false);
    setSelectionToolbar(undefined);
    // The server derive reports the pane's inline question on `question` frames; the
    // web renders it and keeps the optimistic dismissal it always had.
    const applyQuestion = () => {
      if (dismissedQuestionId !== undefined && latestQuestion?.id !== dismissedQuestionId) {
        dismissedQuestionId = undefined;
        dismissedQuestionIds.delete(id);
      }
      if (latestQuestion === undefined || latestQuestion.id === dismissedQuestionId) return onQuestion(undefined);
      onQuestion(choiceQuestionFromInline(latestQuestion));
    };
    const answeredQuestion = (answered: ChoiceQuestion) => {
      dismissedQuestionId = answered.id;
      dismissedQuestionIds.set(id, answered.id);
      onQuestion(undefined);
    };
    answeredQuestionActions.set(id, answeredQuestion);
    const handle = mountStreamedTerminal(canvas.current!, {
      connect: createAgentPaneConnector(id, request),
      preferNativeMouseSelection: true,
      codexScrollControls,
      // Typed keys pass through the panel's sticky mobile modifiers before reaching the pane.
      transformInput: data => applyStickyModifiers(id, data),
      onOpenUrl: url => openOutputUrlRef.current?.(url) ?? false,
      // preserve absent file-preview capability in embedded output
      ...(onOpenFile === undefined ? {} : { onOpenFile: (path: string) => openOutputFileRef.current?.(path) }),
      onQuestion: question => { latestQuestion = (question ?? undefined) as InlineQuestion | undefined; applyQuestion(); },
      onMetadata: metadata => {
        if (disposed) return;
        onMetadataRef.current?.(metadata.message.trim() || undefined, metadata.overflow);
      }
    });
    const terminal = handle.terminal;
    terminalRef.current = terminal;
    // Helper keys, paste and the composer's blank-Enter forward reach the pane through
    // this; the composer's focus blurs it so keystrokes return to prompting.
    terminalInputs.set(id, handle.sendInput);
    const exitInput = () => terminal.blur();
    exitTerminalInput.set(id, exitInput);
    // The stream is live the moment the first bytes parse; the component owns the
    // transient reconnect status from there on.
    const renderSub = terminal.onWriteParsed(() => { if (!disposed) { setHasRendered(true); setStatus('Live'); } });
    // Focusing the pane drives `.input-active` (which collapses the composer to the
    // terminal helper keys on a phone); blurring it, or focusing the composer, reverts.
    const onFocusIn = () => { if (!disposed) setInputActive(true); };
    // preserve output mode while its contextual menu owns focus
    const onFocusOut = () => { if (!disposed && canvas.current !== null && !contextMenuOwnsFocus(canvas.current)) setInputActive(false); };
    canvas.current!.addEventListener('focusin', onFocusIn);
    canvas.current!.addEventListener('focusout', onFocusOut);
    // share selection freezing and copy feedback with terminal panels
    const selection = attachTerminalSelection(canvas.current!, handle, {
      // retain the agent's note and prompt selection actions
      onSelection: setSelectionToolbar,
      // show selection mode from drag start rather than waiting for mouseup
      onSelectionModeChange: setSelectionActive,
      copyText,
      // remove the agent gutter only when writing to the clipboard
      copyLeadingColumns: 2,
      flashElement: canvas.current!.closest<HTMLElement>('.log') ?? canvas.current!,
      copyFlashMs: selectionCopyFlashMs
    });
    copyOutputSelectionRef.current = selection.copyThenClear;
    selectionControllerRef.current = selection;
    pasteOutputRef.current = handle.paste;
    clearOutputSelectionRef.current = selection.clear;
    return () => {
      disposed = true;
      renderSub.dispose();
      selection.dispose();
      // release only this mounted controller
      if (selectionControllerRef.current === selection) selectionControllerRef.current = undefined;
      if (pasteOutputRef.current === handle.paste) pasteOutputRef.current = undefined;
      canvas.current?.removeEventListener('focusin', onFocusIn);
      canvas.current?.removeEventListener('focusout', onFocusOut);
      if (terminalInputs.get(id) === handle.sendInput) terminalInputs.delete(id);
      if (exitTerminalInput.get(id) === exitInput) exitTerminalInput.delete(id);
      if (answeredQuestionActions.get(id) === answeredQuestion) answeredQuestionActions.delete(id);
      if (terminalRef.current === terminal) terminalRef.current = undefined;
      handle.dispose();
    };
  }, [codexScrollControls, embedded, id, onQuestion]);
  // open agent modes and clipboard actions from any non-prompt part of the split
  const openOutputContextMenu = (event: MouseEvent) => {
    const controller = selectionControllerRef.current;
    const selectedText = controller?.getSelectedText() ?? '';
    const linkUrl = currentOutputLinkUrl(event.target);
    const promptInput = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea[data-prompt-id]')).find(input => input.dataset.promptId === id);
    const hasPrompt = !embedded && promptInput !== undefined;
    openSelectionContextMenu(event, {
      label: embedded ? 'Output actions' : 'Agent actions',
      modes: [
        ...(hasPrompt ? [{ id: 'prompt', label: 'Prompt', checked: !inputActive && !selectionActive, onSelect: () => { controller?.setMode('prompt'); promptInput.focus(); } }] : []),
        { id: 'output', label: 'Output', checked: !selectionActive && (inputActive || !hasPrompt), onSelect: () => controller?.setMode('output') },
        { id: 'selection', label: 'Selection', checked: selectionActive, onSelect: () => controller?.setMode('selection') }
      ],
      selectedText,
      selectAll: () => controller?.selectAll(),
      copy: () => controller?.copy(selectedText),
      copyUrl: linkUrl === undefined ? undefined : () => copyText(linkUrl),
      paste: contents => { controller?.setMode('output'); if (contents.text) pasteOutputRef.current?.(contents.text); },
      pastePlain: text => { controller?.setMode('output'); pasteOutputRef.current?.(text); },
      selectionActions: workspaceSelectionActions
    });
  };
  useEffect(() => {
    const panel = canvas.current?.closest<HTMLElement>(embedded ? '.log-output' : '.agent-panel');
    // skip a detached output surface
    if (panel === null || panel === undefined) return;
    // leave ordinary editors to their own clipboard behavior
    const isEditorTarget = (target: EventTarget | null) => {
      // retain the terminal menu for xterm's helper textarea
      if (!(target instanceof Element) || target.closest('.xterm') !== null) return false;
      return target.closest('input, textarea, select, [contenteditable]') !== null;
    };
    // preserve the current mode until contextmenu dispatch
    const preserveSecondaryPress = (event: MouseEvent | PointerEvent) => {
      // leave ordinary editors and non-secondary presses unchanged
      if (event.button !== 2 || isEditorTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // leave editors and explicit flyout triggers to their own context behavior
    const openPanelMenu = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // never route an answer or prompt paste into terminal input
      if (isEditorTarget(target) || target?.closest('[data-context-flyout]') !== null) return;
      openOutputContextMenu(event);
    };
    panel.addEventListener('pointerdown', preserveSecondaryPress, true);
    panel.addEventListener('mousedown', preserveSecondaryPress, true);
    panel.addEventListener('contextmenu', openPanelMenu, true);
    // release native panel handlers with this render surface
    return () => {
      panel.removeEventListener('pointerdown', preserveSecondaryPress, true);
      panel.removeEventListener('mousedown', preserveSecondaryPress, true);
      panel.removeEventListener('contextmenu', openPanelMenu, true);
    };
  }, [embedded, id, inputActive, selectionActive, workspaceSelectionActions]);
  const processing = processingLabel !== undefined;
  const loading = !hasRendered || processing;
  const visibleStatus = processing ? 'Starting' : status;
  const loadingLabel = processingLabel ?? (status === 'Live' ? 'Waiting for output' : status);
  // an expanded sibling hides the output, and its selection actions with it
  const selectionActions = selectionToolbar === undefined || (expand?.anyExpanded === true && !expanded) ? null : createPortal(<div className={`output-selection-toolbar${embedded ? ' embedded' : ''}`} role="toolbar" aria-label="Output selection actions" style={{ top: selectionToolbar.top }} onPointerDown={event => event.preventDefault()}>
    {notes !== undefined && <button type="button" disabled={!notes.canCreate || selectionToolbar.text.length > 30_000} onClick={() => void notes.createWithText(selectionToolbar.text, assistantNoteTitle(selectionToolbar.text)).then(created => { /* reveal the new note; a failure keeps the selection to retry */ if (created) { expand?.restore(); clearOutputSelectionRef.current(); } })}>Create note</button>}
    {notes?.active === true && <button type="button" disabled={!notes.canAppendToActive(selectionToolbar.text)} onClick={() => { expand?.restore(); notes.appendToActive(selectionToolbar.text); clearOutputSelectionRef.current(); }}>Append to note</button>}
    {onAddToPrompt !== undefined && <button type="button" onClick={() => { onAddToPrompt(selectionToolbar.text); clearOutputSelectionRef.current(); }}>Add to prompt</button>}
    <button type="button" onClick={() => void copyOutputSelectionRef.current(selectionToolbar.text)}>Copy</button>
  </div>, document.body);
  const stale = (status !== 'Live' && !hasRendered) || processing;
  const loadingOverlay = loading && <div className={`log-loading progress-border progress-${processing ? 'peach' : 'blue'}`} role={processing ? 'status' : undefined} aria-busy="true" aria-label={processing ? processingLabel : undefined}><ProgressRing busy /><strong>{loadingLabel}</strong>{processingDetail && <span>{processingDetail}</span>}</div>;
  const outputBody = <><div className="log-canvas" ref={canvas} aria-label="Live log" />{stale && <div className="log-stale-overlay" aria-hidden="true" />}</>;
  // the embedded advisor floats its status over the output; the agent panel's header shows it
  if (header === undefined) return <><div className={`log-output${inputActive ? ' input-active' : ''}${selectionActive ? ' selection-active' : ''}`}>{outputBody}{loadingOverlay}<span className={`status log-status ${visibleStatus.toLowerCase()}`}>{visibleStatus}</span></div>{selectionActions}</>;
  // confine connecting to output while task transitions still cover the whole split
  return <><AgentPanelFrame onTurnOff={onTurnOff} className={`${inputActive ? ' input-active' : ''}${selectionActive ? ' selection-active' : ''}`} header={header(visibleStatus)} composer={composer} mobileKeys={<MobileTerminalKeys id={id} />} overlay={processing && loadingOverlay}>{outputBody}{!processing && loadingOverlay}</AgentPanelFrame>{selectionActions}</>;
}

// The composer's prompt-history button and flyout for one Agent. The open state is the caller's,
// so opening history can collapse the Workspace's git status and toggling git can close history.
function PromptHistoryControl({ agentId, history, refreshHistory, notes, open, onOpenChange }: { agentId: string; history: PromptHistoryEntry[]; refreshHistory: () => Promise<void>; notes: WorktreeNotes; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [historyAnswerId, setHistoryAnswerId] = useState<string>();
  const { anchorRef: historyAnchorRef, flyoutRef: historyFlyoutRef, style: historyFlyoutStyle } = useViewportFlyout(open);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const historyPanelOpenRef = useRef(false);
  const historyPinnedToLatestRef = useRef(true);
  const historyScrollIntentRef = useRef(false);
  // refresh open history while answers arrive
  useEffect(() => {
    // require visible history
    if (!open) return;
    void refreshHistory();
    // catch completion persistence after the panel opens
    const interval = window.setInterval(() => { void refreshHistory(); }, 1_000);
    return () => window.clearInterval(interval);
  }, [open, refreshHistory]);
  // dismiss the history popup on Escape, like the command menu and note panes
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onOpenChange(false);
      setHistoryAnswerId(undefined);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);
  useLayoutEffect(() => {
    const list = historyListRef.current;
    // reset closed history tracking
    if (!open || list === null) {
      historyPanelOpenRef.current = false;
      historyScrollIntentRef.current = false;
      return;
    }
    const opening = !historyPanelOpenRef.current;
    historyPanelOpenRef.current = true;
    // reset user intent for each opening
    if (opening) historyScrollIntentRef.current = false;
    let alignmentFrame: number | undefined;
    // follow latest only when opening or already pinned
    if (opening || historyPinnedToLatestRef.current) {
      // align after both current and pending layout
      const alignLatest = () => {
        list.scrollTop = list.scrollHeight;
        historyPinnedToLatestRef.current = true;
      };
      alignLatest();
      alignmentFrame = window.requestAnimationFrame(() => {
        // preserve immediate user scrolling
        if (historyPinnedToLatestRef.current) alignLatest();
      });
    }
    const openAnswer = list.querySelector<HTMLElement>('.prompt-history-entry.answer-open');
    // keep the selected answer visible
    if (openAnswer !== null) openAnswer.scrollIntoView({ block: 'nearest' });
    const observer = new ResizeObserver(() => {
      // follow layout changes only while pinned
      if (historyPinnedToLatestRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
      // cancel pending alignment
      if (alignmentFrame !== undefined) window.cancelAnimationFrame(alignmentFrame);
    };
  }, [open, history, historyAnswerId]);
  // mark deliberate history navigation
  const markHistoryScrollIntent = () => { historyScrollIntentRef.current = true; };
  // track whether history should follow new prompts
  const updateHistoryPin = () => {
    const list = historyListRef.current;
    // ignore closed or programmatic scrolling
    if (list === null || !historyScrollIntentRef.current) return;
    historyPinnedToLatestRef.current = Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 1;
  };
  // restore a previous prompt
  const useHistoryEntry = (entry: PromptHistoryEntry) => {
    setPromptDraft(agentId, entry.text);
    onOpenChange(false);
    setHistoryAnswerId(undefined);
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  };
  // toggle one recorded answer
  const toggleHistoryAnswer = (entry: PromptHistoryEntry) => setHistoryAnswerId(current => current === entry.id ? undefined : entry.id);
  // save one recorded answer as a formatted note
  const saveHistoryAnswer = (entry: PromptHistoryEntry) => {
    // require a bounded final answer
    if (entry.answer === undefined || entry.answer.length > 30_000) return;
    onOpenChange(false);
    setHistoryAnswerId(undefined);
    void notes.createWithText(entry.answer, assistantNoteTitle(entry.answer));
  };
  const historyPanel = open && <FlyoutPortal onDismiss={() => { onOpenChange(false); setHistoryAnswerId(undefined); }}><section className="prompt-history-menu more-menu flyout-menu" ref={historyFlyoutRef} style={historyFlyoutStyle} aria-label="Prompt history"><header><strong>Prompt history</strong><span>{history.length}</span></header><div className="prompt-history-list" ref={historyListRef} onScroll={updateHistoryPin} onWheel={markHistoryScrollIntent} onTouchStart={markHistoryScrollIntent} onPointerDown={markHistoryScrollIntent} onKeyDown={markHistoryScrollIntent}>{history.length === 0 ? <p>No prompts have been sent to this agent yet.</p> : [...history].reverse().map(entry => <div className={`prompt-history-entry${historyAnswerId === entry.id ? ' answer-open' : ''}`} key={entry.id}><button className="prompt-history-prompt" type="button" title={entry.text} onClick={() => useHistoryEntry(entry)}><span>{entry.text}</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></button><button className="prompt-history-answer-toggle" type="button" disabled={entry.answer === undefined} title={entry.answer === undefined ? 'Answer not recorded yet' : 'View final answer'} aria-label={`View answer for ${entry.text}`} data-context-flyout aria-expanded={historyAnswerId === entry.id} onClick={() => toggleHistoryAnswer(entry)}>View answer</button>{historyAnswerId === entry.id && entry.answer !== undefined && <div className="prompt-history-answer" role="region" aria-label={`Answer for ${entry.text}`}><button className="prompt-history-save-note" type="button" disabled={!notes.canCreate || entry.answer.length > 30_000} onClick={() => saveHistoryAnswer(entry)}>Save as note</button><div className="prompt-history-answer-text">{entry.answer}</div></div>}</div>)}</div></section></FlyoutPortal>;
  // open or close prompt history
  const toggleHistory = () => {
    onOpenChange(!open);
    // discard closed answer details
    if (open) setHistoryAnswerId(undefined);
  };
  return <><span className="prompt-history-anchor" ref={historyAnchorRef}><button className={`prompt-history-toggle${open ? ' active' : ''}`} type="button" aria-label={`Prompt history (${history.length})`} title="Prompt history" data-context-flyout aria-expanded={open} onClick={event => { event.stopPropagation(); toggleHistory(); }}><span className="flyout-caret" aria-hidden="true" /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2" /></svg></button></span>{historyPanel}</>;
}

type MoreMenuIconName = 'actions'|'attachment'|'new-task'|'push'|'rename';
// render every menu action with the shared line-icon weight
function MoreMenuIcon({ name }: { name: MoreMenuIconName }) {
  const paths: Record<MoreMenuIconName, string> = {
    actions: 'M8 5v14l11-7L8 5ZM4 5h1M4 12h1M4 19h1',
    attachment: 'm9 12 5.7-5.7a3.5 3.5 0 1 1 5 5L11 20a5 5 0 1 1-7-7l8.3-8.3',
    'new-task': 'M12 5v14M5 12h14',
    push: 'M12 16V4m0 0-5 5m5-5 5 5M5 14v5h14v-5',
    rename: actionIconPaths.pencil
  };
  return <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

// the glyphs on a launcher row's icon controls
const launcherRowIcons = { pin: 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6ZM12 15v5', rename: actionIconPaths.pencil, trash: actionIconPaths.trash, terminal: 'M4 5h16v14H4V5Zm3 4 3 3-3 3m5 0h4', editor: actionIconPaths.pencil };
// render launcher actions at the shared line-icon size and stroke
const LauncherRowIcon = ({ name }: { name: keyof typeof launcherRowIcons }) => <svg className="launcher-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={launcherRowIcons[name]} /></svg>;

// validate the optional worktree carried by a checked-out switch target
function validCheckoutWorktree(openIn: unknown): openIn is PullRequestWorktree | undefined {
  return openIn === undefined || (openIn !== null && typeof openIn === 'object' && typeof (openIn as PullRequestWorktree).worktreeId === 'string' && typeof (openIn as PullRequestWorktree).worktreeName === 'string' && ((openIn as PullRequestWorktree).agentId === undefined || typeof (openIn as PullRequestWorktree).agentId === 'string'));
}

// vector label symbols share the width of an emoji prefix
const LauncherLabelIcon = ({ name }: { name: 'scratch' | 'add' }) => <span className="launcher-label-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d={name === 'scratch' ? 'M3 14c3-8 6-8 9-4s6 4 9-4' : 'M12 5v14M5 12h14'} /></svg></span>;

// retain only safe pull request actions
function switchablePullRequests(values: unknown[]): SwitchablePullRequest[] {
  return values.filter((value): value is SwitchablePullRequest => {
    // require the core pull request fields
    if (value === null || typeof value !== 'object' || !Number.isInteger((value as PullRequestChoice).number) || typeof (value as PullRequestChoice).title !== 'string' || typeof (value as PullRequestChoice).branch !== 'string' || typeof (value as PullRequestChoice).draft !== 'boolean' || typeof (value as PullRequestChoice).url !== 'string' || typeof (value as SwitchablePullRequest).checkedOut !== 'boolean') return false;
    const checks = (value as PullRequestChoice).checks;
    // constrain the optional CI status
    if (checks !== undefined && checks !== 'passed' && checks !== 'pending' && checks !== 'failed') return false;
    const issues = (value as PullRequestChoice).issues;
    // constrain the optional issue flags
    if (issues !== undefined && (issues === null || typeof issues !== 'object' || Object.entries(issues).some(([name, enabled]) => !['mergeConflicts', 'failingChecks', 'unresolvedComments'].includes(name) || typeof enabled !== 'boolean'))) return false;
    return validCheckoutWorktree((value as SwitchablePullRequest).openIn);
  });
}

// retain only well-formed local branch targets
function switchableBranches(values: unknown[]): SwitchableBranch[] {
  return values.filter((value): value is SwitchableBranch =>
    value !== null && typeof value === 'object' && typeof (value as SwitchableBranch).branch === 'string' && typeof (value as SwitchableBranch).checkedOut === 'boolean' && validCheckoutWorktree((value as SwitchableBranch).openIn)).map(value => {
      // discard malformed summaries without hiding checkout targets
      const summary = value.commitSummary;
      const validSummary = summary !== null && typeof summary === 'object' && typeof summary.subject === 'string' && Number.isSafeInteger(summary.count) && summary.count > 0;
      return { ...value, commitSummary: validSummary ? summary : undefined };
    });
}

// explain one unavailable switch target
function pullRequestCheckoutReason(pullRequest: SwitchablePullRequest, enabled: boolean, refreshFailed: boolean, checkedOutHere: boolean): string {
  // prioritize stale remote data
  if (refreshFailed) return 'Pull request list could not be refreshed';
  // identify the current checkout
  if (checkedOutHere) return 'Already checked out here';
  // reject an unresolvable checkout owner
  if (pullRequest.checkedOut && pullRequest.openIn === undefined) return 'Already open in another worktree';
  // protect a dirty working copy
  if (!enabled) return 'Commit or stash uncommitted changes first';
  return pullRequest.checkedOut ? `Move PR #${pullRequest.number} here` : `Checkout PR #${pullRequest.number}`;
}

// name the worktree that already holds a switch target: a link that focuses it, or a static note when it is here or unresolved
function SwitchOpenInLine({ openIn, here, operationPending, onSelectTarget }: { openIn?: PullRequestWorktree; here: boolean; operationPending: boolean; onSelectTarget: (target: DashboardTarget) => void }) {
  // the current worktree already holds it — nothing to switch to
  if (here) return <small className="switch-pr-open-in">Open here</small>;
  // an unresolved owner cannot be focused
  if (openIn === undefined) return <small className="switch-pr-open-in">Already open in another worktree</small>;
  return <button className="switch-pr-open-in switch-pr-open-in-link" type="button" disabled={operationPending} aria-label={`Switch to ${openIn.worktreeName}`} onClick={() => onSelectTarget(openIn)}>Open in {openIn.worktreeName}<span aria-hidden="true"> →</span></button>;
}

// render one pull request switch target
function SwitchPullRequestOption({ pullRequest, currentWorktreeId, enabled, loading, refreshFailed, switchingPr, movingPr, onSwitch, onMove, onSelectTarget }: { pullRequest: SwitchablePullRequest; currentWorktreeId?: string; enabled: boolean; loading: boolean; refreshFailed: boolean; switchingPr?: number; movingPr?: number; onSwitch: (number: number) => void | Promise<void>; onMove: (number: number) => void | Promise<void>; onSelectTarget: (target: DashboardTarget) => void }) {
  const status = pullRequest.draft ? 'draft' : 'open';
  const statusLabel = pullRequest.draft ? 'Draft' : 'Open';
  const label = `#${pullRequest.number}: ${pullRequest.title}`;
  const openIn = pullRequest.openIn;
  const checkedOutHere = currentWorktreeId !== undefined && openIn?.worktreeId === currentWorktreeId;
  const operationPending = switchingPr !== undefined || movingPr !== undefined;
  const busy = movingPr === pullRequest.number || switchingPr === pullRequest.number;
  const checkoutReason = pullRequestCheckoutReason(pullRequest, enabled, refreshFailed, checkedOutHere);
  // run one checkout transaction
  const checkout = () => {
    // ignore the current branch defensively
    if (checkedOutHere) return;
    // transfer occupied branches
    if (pullRequest.checkedOut) return void onMove(pullRequest.number);
    void onSwitch(pullRequest.number);
  };
  return <div className="switch-pr-option" role="group" aria-label={`${label}; ${statusLabel}`}><div className="switch-pr-main"><a className="switch-pr" href={pullRequest.url} target="_blank" rel="noreferrer" title={`Open ${label} in GitHub`} aria-label={label}><span className="switch-pr-copy"><span><strong className={`status-${status}`}>#{pullRequest.number}</strong><span>: {pullRequest.title}</span></span></span></a></div><span className="switch-pr-actions"><PullRequestIndicators checks={pullRequest.checks} issues={pullRequest.issues} /><button className={`switch-pr-action switch-pr-checkout outline-button${progressBorder(busy, 'blue')}`} aria-busy={busy || undefined} disabled={loading || refreshFailed || operationPending || !enabled || pullRequest.checkedOut && (openIn === undefined || checkedOutHere)} title={checkoutReason} onClick={checkout}><ProgressRing busy={busy} />{movingPr === pullRequest.number ? 'Moving…' : switchingPr === pullRequest.number ? 'Checking out…' : 'Checkout'}</button></span>{pullRequest.checkedOut && <div className="switch-pr-owner"><SwitchOpenInLine openIn={openIn} here={checkedOutHere} operationPending={operationPending} onSelectTarget={onSelectTarget} /></div>}</div>;
}

// explain one unavailable branch switch target
function branchCheckoutReason(branch: SwitchableBranch, enabled: boolean, refreshFailed: boolean): string {
  // prioritize stale branch data
  if (refreshFailed) return 'Branch list could not be refreshed';
  // reject an unresolvable checkout owner
  if (branch.checkedOut && branch.openIn === undefined) return 'Already open in another worktree';
  // protect a dirty working copy
  if (!enabled) return 'Commit or stash uncommitted changes first';
  return branch.checkedOut ? `Move ${branch.branch} here` : `Check out ${branch.branch}`;
}

// reuse Unicode grapheme boundaries across branch rows
const branchSummarySegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// cap the subject without splitting combining marks or compound emoji
function branchSummaryPreview(subject: string): string {
  let preview = '';
  let count = 0;
  // stop after fifty complete user-perceived characters
  for (const { segment } of branchSummarySegmenter.segment(subject)) {
    // leave the remaining subject available in the tooltip
    if (count === 50) break;
    preview += segment;
    count += 1;
  }
  return preview;
}

// render one local branch switch target
function SwitchBranchOption({ branch, enabled, loading, refreshFailed, switchingBranch, movingBranch, onSwitch, onMove, onDelete, onSelectTarget }: { branch: SwitchableBranch; enabled: boolean; loading: boolean; refreshFailed: boolean; switchingBranch?: string; movingBranch?: string; onSwitch: (branch: string) => void | Promise<void>; onMove: (branch: string) => void | Promise<void>; onDelete?: (branch: SwitchableBranch) => void; onSelectTarget: (target: DashboardTarget) => void }) {
  const openIn = branch.openIn;
  const summary = branch.commitSummary;
  // shorten only the subject and preserve the additional commit count
  const summarySubject = summary?.subject.split(/\r?\n/u, 1)[0] ?? '';
  const summaryMore = summary !== undefined && summary.count > 1 ? ` and ${summary.count - 1} more` : '';
  const operationPending = switchingBranch !== undefined || movingBranch !== undefined;
  const busy = movingBranch === branch.branch || switchingBranch === branch.branch;
  const checkoutReason = branchCheckoutReason(branch, enabled, refreshFailed);
  // run one checkout transaction
  const checkout = () => {
    // transfer branches already open elsewhere
    if (branch.checkedOut) return void onMove(branch.branch);
    void onSwitch(branch.branch);
  };
  return <div className="switch-pr-option switch-branch-option" role="group" aria-label={branch.branch}><div className="switch-pr-main"><strong className="switch-branch-name">{branch.branch}</strong>{summary !== undefined && <small className="switch-branch-summary" title={`${summarySubject}${summaryMore}`}><span>{branchSummaryPreview(summarySubject)}</span>{summaryMore !== '' && <span className="switch-branch-summary-more">{summaryMore}</span>}</small>}</div><span className="switch-pr-actions">{onDelete !== undefined && <button className="switch-pr-action switch-branch-delete icon-button outline-button" disabled={loading || operationPending} aria-label={`Delete ${branch.branch}`} title={`Review deletion safeguards for ${branch.branch}`} onClick={() => onDelete(branch)}><svg className="more-menu-icon action-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.trash} /></svg></button>}<button className={`switch-pr-action switch-pr-checkout outline-button${progressBorder(busy, 'blue')}`} aria-busy={busy || undefined} disabled={loading || refreshFailed || operationPending || !enabled || (branch.checkedOut && openIn === undefined)} title={checkoutReason} onClick={checkout}><ProgressRing busy={busy} />{movingBranch === branch.branch ? 'Moving…' : switchingBranch === branch.branch ? 'Checking out…' : 'Checkout'}</button></span>{branch.checkedOut && <div className="switch-pr-owner"><SwitchOpenInLine openIn={openIn} here={false} operationPending={operationPending} onSelectTarget={onSelectTarget} /></div>}</div>;
}

// explain pull request availability
function pullRequestStatusReason(loading: boolean, error: string | undefined, loaded: boolean, availability: PullRequestSwitchAvailability | undefined): string | undefined {
  // show loading in the tab instead of repeating it in the header
  if (loading) return undefined;
  // preserve one actionable error
  if (error !== undefined) return error;
  // distinguish an unavailable endpoint
  if (loaded && availability === undefined) return 'Pull requests unavailable.';
  // report a repository without a GitHub origin
  if (availability !== undefined && !availability.pullRequestsSupported) return 'Pull requests unavailable.';
  // explain an empty owned list
  if (availability?.pullRequests.length === 0) return availability.otherPullRequests.length > 0 ? 'No open pull requests by you.' : 'No open pull requests.';
  return undefined;
}

// explain local branch availability
function branchStatusReason(loading: boolean, error: string | undefined, loaded: boolean, availability: PullRequestSwitchAvailability | undefined): string | undefined {
  // show loading in the tab instead of repeating it in the header
  if (loading) return undefined;
  // expose the shared repository refresh error
  if (error !== undefined) return error;
  // distinguish an unavailable endpoint
  if (loaded && availability === undefined) return 'Branches unavailable.';
  // explain an empty list
  if (availability?.branches.length === 0) return 'No other local branches.';
  return undefined;
}

// confirm one guarded local branch deletion
function RemoveBranchDialog({ worktreeId, branch, onClose, onDeleted }: { worktreeId: string; branch: SwitchableBranch; onClose: () => void; onDeleted: () => void }) {
  const [facts, setFacts] = useState<BranchRemovalFacts>();
  const [factsError, setFactsError] = useState<string>();
  const [discardUnpushed, setDiscardUnpushed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // load current repository safety facts
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ branch: branch.branch });
    void request(`/api/worktrees/${encodeURIComponent(worktreeId)}/branch-removal?${query}`).then(async response => ({ ok: response.ok, detail: response.ok ? await response.json().catch(() => undefined) : await launchError(response) })).then(result => {
      // ignore a closed dialog
      if (cancelled) return;
      // require complete server facts
      if (!result.ok || !isBranchRemovalFacts(result.detail)) return setFactsError(typeof result.detail === 'string' ? result.detail : 'Could not load the branch details.');
      setFacts(result.detail);
    }).catch(() => {
      // retain one actionable connection failure
      if (!cancelled) setFactsError('Unable to reach the console.');
    });
    return () => { cancelled = true; };
  }, [branch.branch, worktreeId]);
  const blocked = facts?.defaultBranch === true || facts?.checkedOut === true;
  const atRisk = facts !== undefined && !facts.pushed && !facts.merged;
  // submit one explicitly guarded branch deletion
  const remove = async () => {
    setError(undefined);
    setPending(true);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/branch`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: branch.branch, discardUnpushed }) }).catch(() => undefined);
      // surface connection failures without closing
      if (response === undefined) return setError('Unable to reach the console.');
      // preserve the dialog on a fresh server refusal
      if (!response.ok) return setError(await launchError(response));
      onDeleted();
    } finally { setPending(false); }
  };
  const disabled = pending || facts === undefined || blocked || atRisk && !discardUnpushed;
  return createPortal(<div className="dialog remove-worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-branch-title"><div>
    <header className="remove-worktree-header"><div><h2 id="remove-branch-title">Delete branch</h2><p><code>{branch.branch}</code></p></div><button className="remove-worktree-close" type="button" aria-label="Close delete branch" disabled={pending} onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header>
    {factsError !== undefined ? <p className="remove-worktree-error" role="alert">{factsError}</p>
      : facts === undefined ? <p className="remove-worktree-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Loading branch details…</p>
      : <>
        <ul className="remove-worktree-facts">
          <li>{facts.dirtyCount > 0 ? <strong>{facts.dirtyCount} uncommitted {facts.dirtyCount === 1 ? 'change' : 'changes'}</strong> : 'No uncommitted changes'}</li>
          <li>{facts.pushed ? 'Pushed to a remote' : 'Not pushed'} · {facts.merged ? 'merged' : 'not merged'}</li>
        </ul>
        {facts.defaultBranch && <p className="remove-worktree-blocked" role="alert">The default branch cannot be deleted.</p>}
        {facts.checkedOut && <p className="remove-worktree-blocked" role="alert">This branch is checked out{facts.dirtyCount > 0 ? ' with uncommitted changes' : ''}. Remove its worktree first.</p>}
        {atRisk && <label className="remove-worktree-option"><input type="checkbox" checked={discardUnpushed} disabled={blocked} onChange={event => setDiscardUnpushed(event.target.checked)} />Delete unpushed work</label>}
        {atRisk && <p className={discardUnpushed ? 'remove-worktree-branch-warning armed' : 'remove-worktree-branch-warning'} role="alert"><code>{branch.branch}</code> is neither pushed nor merged. Deleting it can permanently lose commits.</p>}
      </>}
    {error !== undefined && <p className="remove-worktree-error" role="alert">{error}</p>}
    <footer className="remove-worktree-actions"><button type="button" className="outline-button" disabled={pending} onClick={onClose}>Cancel</button><button type="button" className={`danger${progressBorder(pending, 'red')}`} aria-busy={pending || undefined} disabled={disabled} onClick={() => void remove()}><ProgressRing busy={pending} />{pending ? 'Deleting…' : 'Delete branch'}</button></footer>
  </div></div>, document.body);
}

// the Workspace toolbar's remaining Place actions: panels, folder pin, GitHub Actions and removal
type PlaceMenuProps = { agentId?: string; worktreeId?: string; git?: boolean; pinned?: boolean; onTogglePin?: () => void; onRemoveWorktree?: () => void; removeDisabledReason?: string };
// a panel the phone menu opens after it leaves the direct toolbar
type PlaceMenuPanel = { key: string; label: string; icon: ReactNode; title: string; disabled?: boolean; onSelect: () => void };

// the toolbar's ⋮ keeps folder pin and worktree removal; GitHub Actions follows the current Place
function PlaceMenu({ agentId, worktreeId, git = false, pinned, onTogglePin, onRemoveWorktree, removeDisabledReason, panels = [] }: PlaceMenuProps & { panels?: PlaceMenuPanel[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const [githubActionsUrl, setGithubActionsUrl] = useState<string>();
  const [loadingGithubActions, setLoadingGithubActions] = useState(false);
  const githubActionsRoute = !git ? undefined : worktreeId !== undefined ? `/api/worktrees/${encodeURIComponent(worktreeId)}/github-actions` : agentId !== undefined ? `/api/agents/${encodeURIComponent(agentId)}/github-actions` : undefined;
  // refresh menu availability
  useEffect(() => {
    // wait for an open menu
    if (!menuOpen) return;
    let cancelled = false;
    if (githubActionsRoute === undefined) setLoadingGithubActions(false);
    else {
      setLoadingGithubActions(true);
      void request(githubActionsRoute).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
        // ignore closed menu work
        if (cancelled) return;
        // require one safe actions url
        if (payload === null || typeof payload !== 'object' || typeof (payload as { url?: unknown }).url !== 'string') return setGithubActionsUrl(undefined);
        try {
          const url = new URL((payload as { url: string }).url);
          // restrict links to github actions
          if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.endsWith('/actions')) setGithubActionsUrl(url.href);
          else setGithubActionsUrl(undefined);
        } catch { setGithubActionsUrl(undefined); }
      }).catch(() => {
        // clear stale actions links
        if (!cancelled) setGithubActionsUrl(undefined);
      }).finally(() => {
        // finish the active request
        if (!cancelled) setLoadingGithubActions(false);
      });
    }
    // cancel stale menu responses
    return () => { cancelled = true; };
  }, [menuOpen, githubActionsRoute]);
  // toggle one menu
  const toggleMenu = () => {
    // show fresh loading state immediately
    if (!menuOpen) {
      setLoadingGithubActions(githubActionsRoute !== undefined);
    }
    setMenuOpen(open => !open);
  };
  // close the menu, then act
  const choose = (action: () => void) => { setMenuOpen(false); action(); };
  // a Place with none of these actions has no menu
  if (panels.length === 0 && githubActionsRoute === undefined && onTogglePin === undefined && onRemoveWorktree === undefined) return null;
  const panelRows = panels.map(panel => <button key={panel.key} type="button" className={`place-menu-panel ${panel.key}-panel-row`} disabled={panel.disabled} title={panel.title} onClick={() => choose(panel.onSelect)}>{panel.icon}{panel.label}</button>);
  const pinToggle = onTogglePin !== undefined && <button className="more-pin-toggle" aria-pressed={pinned === true} onClick={() => choose(onTogglePin)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v5" /></svg>{`${pinned ? 'Unpin' : 'Pin'} folder`}</button>;
  const githubActions = githubActionsRoute === undefined ? null : loadingGithubActions ? <button className="github-actions-loading progress-border progress-blue" type="button" disabled aria-busy="true"><ProgressRing busy /><MoreMenuIcon name="actions" />GitHub Actions</button> : githubActionsUrl === undefined ? <button type="button" disabled title="GitHub Actions unavailable"><MoreMenuIcon name="actions" />GitHub Actions</button> : <a className="more-menu-link" href={githubActionsUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}><MoreMenuIcon name="actions" />GitHub Actions</a>;
  const removal = onRemoveWorktree !== undefined && <button className="remove-worktree-option" type="button" disabled={removeDisabledReason !== undefined} title={removeDisabledReason ?? 'Remove worktree'} onClick={() => choose(onRemoveWorktree)}><svg className="more-menu-icon action-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={actionIconPaths.trash} /></svg>Remove worktree…</button>;
  return <><span className="more-wrap" ref={anchorRef}><button className="more icon-button" aria-label="More options" data-context-flyout aria-expanded={menuOpen} title="Workspace options" onClick={toggleMenu}><span className="flyout-caret" aria-hidden="true" /><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg></button></span>{menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div className="more-menu flyout-menu place-menu" ref={flyoutRef} style={style} aria-busy={loadingGithubActions}>{panelRows}{pinToggle}{githubActions}{removal}</div></FlyoutPortal>}</>;
}

// render the Workspace of a Place where Agents run: the Place's panels and toolbar, with the agent
// panel showing the Agent chosen in its switcher. Only the agent panel follows the switcher; the
// place panels stay open across an agent switch
// The Agent a guided review binds to (its start, its stored tour and where its change request is
// sent): the shown Agent, unless that is a Review run's own, which is read-only and closes with its
// run; then another Agent of the same Worktree, if one runs there.
function reviewBindingAgent(agent: Agent | undefined, agents: readonly Agent[]): Agent | undefined {
  if (agent === undefined || agent.reviewRun === undefined) return agent;
  return agents.find(candidate => candidate.reviewRun === undefined && candidate.worktreeId !== undefined && candidate.worktreeId === agent.worktreeId);
}

function AgentPlaceCard({ agent, agents, onSelectAgent, active, tabBar, renderNotifications, cleanupControl, reviewCapability, review, onReview, onDeleted, onSelectTarget, onNavigateWorktree, onOpenWorktreeStack, onPromptFocus, onOperationFeedback, launch, pinned, onTogglePin, onRemoveWorktree, removeDisabledReason, worktreeLabel, schedulePrefill }: { agent: Agent; agents: readonly Agent[]; onSelectAgent: (agentId: string) => void; active: boolean; tabBar: ReactNode; renderNotifications: (content: ReactNode) => ReactNode; cleanupControl?: ReactNode; reviewCapability?: ReviewTourCapability; review?: ReviewButtonState; onReview: (target: ReviewTarget) => void; onDeleted: () => Promise<void>; onSelectTarget: (target: DashboardTarget) => void; onNavigateWorktree: (worktreeId: string) => void; onOpenWorktreeStack: (worktreeId: string) => void; onPromptFocus: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void; launch?: ToolbarLaunch; pinned?: boolean; onTogglePin?: () => void; onRemoveWorktree?: () => void; removeDisabledReason?: string; worktreeLabel?: string; schedulePrefill?: SchedulePrefill }) {
  // an Agent's Worktree label drives its feedback and power-menu copy; the server carries it on
  // the Worktree now, so it is resolved at the top level and passed in
  const displayLabel = worktreeLabel ?? agent.worktreeLabel ?? agentLabel(agent);
  const [historyOpen, setHistoryOpen] = useState(false);
  // the latest response the current Agent's output reported, for the note and response-file shortcuts
  const [latest, setLatest] = useState<{ agentId: string; message?: string; overflows: boolean }>();
  const latestAssistantMessage = latest?.agentId === agent.id ? latest.message : undefined;
  const latestAssistantMessageOverflows = latest?.agentId === agent.id && latest.overflows;
  // the current Agent's prompt history (the hook refetches when the switcher changes Agent)
  const promptHistory = usePromptHistory(agent.id);
  const workspace = useWorkspace({ id: agent.placeId ?? agent.worktreeId, worktreeId: agent.worktreeId, path: agent.home, stack: agent.stack, projectUrl: agent.projectUrl, projectProxied: agent.projectProxied, branch: agent.branch, gitStatus: agent.gitStatus, gitPrStatus: agent.gitPrStatus, pullRequest: agent.pullRequest, attention: agents.map(candidate => candidate.attention ?? '').join(' ') }, { agentId: agent.id, noteOptions: { agentWorking: active, latestAssistantMessage, latestAssistantMessageOverflows, onPromptHistoryChanged: promptHistory.refresh, promptHistory: promptHistory.history, schedulePrefill }, onNavigateWorktree, onOperationFeedback, onCloseReview: review?.onMinimize });
  const { browser: projectBrowser, code: projectCode, setGitExpanded } = workspace;
  // keep the latest response each Agent's output reports
  const reportMetadata = useCallback((agentId: string, message: string | undefined, overflows: boolean) => setLatest({ agentId, message, overflows }), []);
  // a switch closes the previous Agent's history
  useEffect(() => { setHistoryOpen(false); }, [agent.id]);
  // opening history collapses the git status; toggling git closes history
  const changeHistoryOpen = useCallback((open: boolean) => {
    setHistoryOpen(open);
    if (open) setGitExpanded(false);
  }, [setGitExpanded]);
  // Open a response-file row or a pane file link in the Code panel's File view, fetched from the
  // agent-keyed preview endpoint so the `/tmp` screenshot bridge keeps working.
  const openFileInCode = useCallback((path: string) => { void projectCode.openFilePreview(path, `/api/agents/${encodeURIComponent(agent.id)}/file-preview`); }, [projectCode, agent.id]);
  // route output links to the project browser only while its preview is open and the host matches
  const openOutputUrl = (url: string) => projectBrowser.url !== undefined && projectBrowser.homeUrl !== undefined && outputUrlMatchesHost(url, projectBrowser.homeUrl) && projectBrowser.openUrl(url);
  const pushPendingKey = `prompt:${agent.id}`;
  const pushPending = usePendingOperation(pushPendingKey);
  // explain review availability
  const reviewAgent = reviewBindingAgent(agent, agents);
  const reviewUnavailable = agent.worktreeId === undefined
    ? 'Guided review requires a configured worktree'
    : reviewAgent === undefined ? 'Guided review needs an agent here that is not running a review' : reviewTourUnavailableText(reviewCapability);
  const rebaseUpstream = agent.gitUpstream?.upstream;
  // serialize upstream prompts with workspace lifecycle actions
  const queueRebase = rebaseUpstream === undefined ? undefined : async () => {
    // preserve a concurrent prompt or shutdown
    if (pushPending || !beginPendingOperation(pushPendingKey, workspace.viewKey)) return false;
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: `$rebase ${rebaseUpstream}`, attachments: [] }) });
      // refresh only accepted prompts
      if (response.ok) await promptHistory.refresh();
      return response.ok;
    } finally {
      setPendingOperation(pushPendingKey, false);
    }
  };
  // scope dismissal to this checkout, branch and tracked upstream across agent switches
  const upstreamNotificationKey = JSON.stringify([agent.worktreeId ?? agent.placeId ?? agent.home, agent.branch, rebaseUpstream]);
  // reserve Remote Agents repository updates for the reviewed host update flow
  const upstreamRebase = agent.projectId === 'remoteagents' ? null : <UpstreamRebaseNotification key={upstreamNotificationKey} notificationKey={upstreamNotificationKey} summary={agent.gitUpstream} onRebase={queueRebase} />;
  // the configured commit-and-push prompt, or the default one
  const pushAction = agent.push ?? defaultPushAction;
  // queue the configured commit and push prompt
  const queuePush = async () => {
    // prevent duplicate prompt submissions
    if (pushPending || !beginPendingOperation(pushPendingKey, workspace.viewKey)) return false;
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: pushAction.prompt, attachments: [] }) });
      // keep the branch flyout open after rejection
      if (!response.ok) return false;
      await promptHistory.refresh();
      return true;
    } catch {
      // keep the branch flyout open after connection failure
      return false;
    } finally {
      setPendingOperation(pushPendingKey, false);
    }
  };
  // serialize fixup with other prompt submissions across popup remounts
  const queueFixup = async () => {
    // retain the shared prompt lock outside the popup lifecycle
    if (pushPending || !beginPendingOperation(pushPendingKey, workspace.viewKey)) return false;
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '$fixup', attachments: [] }) });
      // explain rejected submissions before allowing a retry
      if (!response.ok) {
        onOperationFeedback({ tone: 'error', message: 'Unable to queue $fixup', detail: await launchError(response), worktreeId: agent.worktreeId });
        return false;
      }
      await promptHistory.refresh();
      return true;
    } catch {
      // preserve uncertainty when the connection drops before acceptance
      onOperationFeedback({ tone: 'error', message: 'Could not confirm $fixup was queued', detail: 'The console could not be reached. Check prompt history before trying again.', worktreeId: agent.worktreeId });
      return false;
    } finally {
      setPendingOperation(pushPendingKey, false);
    }
  };
  // the Agent's push, fixup and guided-review actions on the git status
  const gitActions: WorkspaceGitActions = { worktreeId: agent.worktreeId, onFixup: queueFixup, onAddToPrompt: text => addToPrompt(text), onReview: agent.worktreeId === undefined || reviewAgent === undefined ? undefined : review === undefined ? scope => onReview({ agentId: reviewAgent.id, worktreeId: agent.worktreeId!, scope }) : () => { pendingWorkspaceJumps.set(workspace.viewKey, 'review'); review.onOpen(); }, onReviewCommit: agent.worktreeId === undefined || reviewAgent === undefined ? undefined : commit => onReview({ agentId: reviewAgent.id, worktreeId: agent.worktreeId!, scope: 'commit', commit: commit.sha, commitSubject: commit.subject }), review, reviewUnavailable: review === undefined || reviewAgent === undefined ? reviewUnavailable : undefined, pushAction, pushPending, onPush: queuePush, onSelectTarget, onOperationFeedback };
  // selected output and Terminal text append to the current Agent's draft without queueing it
  const addToPrompt = (text: string) => setPromptDraft(agent.id, current => appendTextBlock(current, text));
  // the panel is keyed by Agent, so a switch swaps its output, draft, queue and pending actions
  const output = <AgentPanel key={agent.id} agent={agent} agents={agents} onSelectAgent={onSelectAgent} active={active} displayLabel={displayLabel} workspace={workspace} promptHistory={promptHistory} historyOpen={historyOpen} onHistoryOpenChange={changeHistoryOpen} latestAssistantMessage={latestAssistantMessage} onMetadata={reportMetadata} onAddToPrompt={addToPrompt} onOpenFile={openFileInCode} onOpenUrl={openOutputUrl} onDeleted={onDeleted} onPromptFocus={onPromptFocus} onOperationFeedback={onOperationFeedback} />;
  return <article className="agent-view"><Workspace workspace={workspace} output={output} git={gitActions} reviewPanel={review?.panel} onAddToPrompt={addToPrompt} onOpenWorktreeStack={onOpenWorktreeStack} />{tabBar}{renderNotifications(upstreamRebase)}<WorkspaceToolbar workspace={workspace} agentCount={agents.length} launch={launch} onOpenWorktreeStack={onOpenWorktreeStack} git={gitActions} onGitToggle={() => setHistoryOpen(false)} cleanupControl={cleanupControl} menu={{ agentId: agent.id, worktreeId: agent.worktreeId, git: agent.worktreeId !== undefined || agent.placeId === undefined, pinned, onTogglePin, onRemoveWorktree, removeDisabledReason }} /></article>;
}

// One Agent's panel inside its Place's Workspace: the live output under the floating header (the
// switcher, state, conversations, response files and power menu) and the composer at its foot.
// Keyed by Agent, so its pending lifecycle actions and parsed question never leak across a switch.
function AgentPanel({ agent, agents, onSelectAgent, active, displayLabel, workspace, promptHistory, historyOpen, onHistoryOpenChange, latestAssistantMessage, onMetadata, onAddToPrompt, onOpenFile, onOpenUrl, onDeleted, onPromptFocus, onOperationFeedback }: { agent: Agent; agents: readonly Agent[]; onSelectAgent: (agentId: string) => void; active: boolean; displayLabel: string; workspace: WorkspaceState; promptHistory: ReturnType<typeof usePromptHistory>; historyOpen: boolean; onHistoryOpenChange: (open: boolean) => void; latestAssistantMessage?: string; onMetadata: (agentId: string, message: string | undefined, overflows: boolean) => void; onAddToPrompt: (text: string) => void; onOpenFile: (path: string) => void; onOpenUrl: (url: string) => boolean; onDeleted: () => Promise<void>; onPromptFocus: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const mounted = useRef(true);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [question, setQuestion] = useState<ChoiceQuestion>();
  const startingNewTask = usePendingOperation(newTaskOperationKey(agent.worktreeId ?? agent.id));
  const reportMetadata = useCallback((message: string | undefined, overflows: boolean) => onMetadata(agent.id, message, overflows), [onMetadata, agent.id]);
  const responseFiles = useLatestAssistantFiles(agent.id, latestAssistantMessage, onOpenFile);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // cancel active agent work
  const cancel = async () => { if (cancelling) return; setCancelling(true); try { await request(`/api/agents/${encodeURIComponent(agent.id)}/cancel`, { method: 'POST' }); } finally { if (mounted.current) setCancelling(false); } };
  // turn off an Agent outside a Worktree (Scratch, a directory Project): its pane closes
  const remove = async () => {
    const operationKey = deactivateOperationKey(agent.id);
    // prevent duplicate or competing workspace closure
    if (deleting || !beginPendingOperation(operationKey, workspace.viewKey)) return;
    setDeleting(true);
    const label = displayLabel;
    onOperationFeedback({ tone: 'pending', message: `Turning off ${label}…`, detail: 'The session is being stopped and removed from the console.' });
    try {
      // keep shutdown parseable when the tunnel uses chunked framing
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}`, emptyJsonMutation('DELETE'));
      // surface failed closure
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: await launchError(response) });
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: `${label} is off`, detail: 'The session was removed successfully.' });
    } catch { onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: 'The console could not be reached. The agent may still be running.' }); }
    finally { setPendingOperation(operationKey, false); if (mounted.current) setDeleting(false); }
  };
  // deactivate one configured agent
  const deactivate = async () => {
    // require an idle configured target
    if (deactivating || agent.worktreeId === undefined || !beginPendingOperation(deactivateOperationKey(agent.worktreeId), workspace.viewKey)) return;
    setDeactivating(true);
    const label = displayLabel;
    onOperationFeedback({ tone: 'pending', message: `Turning off ${label}…`, detail: 'Stopping the agent while keeping the worktree available to start again.', worktreeId: agent.worktreeId });
    try {
      // keep shutdown parseable when the tunnel uses chunked framing
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/deactivate`, emptyJsonMutation('POST'));
      // surface failed deactivation
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: await launchError(response), worktreeId: agent.worktreeId });
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: `${label} is off`, detail: 'The worktree is still available. Use Launch agent whenever you want to turn it back on.', worktreeId: agent.worktreeId });
    } catch { onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: 'The console could not be reached. The agent may still be running.', worktreeId: agent.worktreeId }); }
    finally {
      setPendingOperation(deactivateOperationKey(agent.worktreeId), false);
      if (mounted.current) setDeactivating(false);
    }
  };
  // restart one configured agent, optionally under a different kind ("Restart as…")
  const restart = async (choice?: LaunchChoice) => {
    // require an idle configured target
    if (restarting || agent.worktreeId === undefined || !beginPendingOperation(restartOperationKey(agent.worktreeId), workspace.viewKey)) return;
    const operationKey = restartOperationKey(agent.worktreeId);
    // the other Agents at the Worktree keep running and are never the replacement
    const excludedAgentIds = agents.filter(candidate => candidate.id !== agent.id).map(candidate => candidate.id);
    pendingWorktreeLaunches.set(agent.worktreeId, { operationKey, sourceAgentId: agent.id, excludedAgentIds });
    let handedOff = false;
    setRestarting(true);
    const label = displayLabel;
    onOperationFeedback({ tone: 'pending', message: `Restarting ${label}…`, detail: 'Closing the agent, running the resume alias, and waiting for the conversation to reconnect.', worktreeId: agent.worktreeId });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/restart`, choice === undefined ? { method: 'POST' } : launchRequestInit(choice));
      // surface failed restarts after refreshing the closed agent; the errors are global because
      // an unpinned Worktree's tab closes with its last agent, taking a tab-scoped message with it
      if (!response.ok) {
        const message = await launchError(response);
        await onDeleted();
        return onOperationFeedback({ tone: 'error', message: `${label} could not restart`, detail: message });
      }
      const payload = await response.json() as { agentId?: unknown };
      // require the discovered replacement agent
      if (typeof payload.agentId !== 'string') {
        await onDeleted();
        return onOperationFeedback({ tone: 'error', message: `${label} could not restart`, detail: 'The resume alias ran, but the replacement agent could not be opened.' });
      }
      const replacementId = payload.agentId;
      const pendingLaunch = pendingWorktreeLaunches.get(agent.worktreeId);
      // retain only handoffs not already confirmed by dashboard push
      if (pendingLaunch !== undefined) {
        const worktreeId = agent.worktreeId;
        const confirmationTimer = window.setTimeout(() => {
          const pending = pendingWorktreeLaunches.get(worktreeId);
          // ignore completed or replaced restarts
          if (pending?.agentId !== replacementId) return;
          pendingWorktreeLaunches.delete(worktreeId);
          setPendingOperation(operationKey, false);
          onOperationFeedback({ tone: 'error', message: `${label} did not finish restarting`, detail: 'The replacement agent did not remain discoverable. Check the worktree before trying again.' });
          void onDeleted();
        }, worktreeLaunchConfirmationMs);
        pendingWorktreeLaunches.set(worktreeId, { ...pendingLaunch, agentId: replacementId, confirmationTimer });
      }
      handedOff = true;
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: `${label} restarted`, detail: 'The previous Codex conversation resumed and its output is reconnecting.', worktreeId: agent.worktreeId });
    } catch {
      await onDeleted().catch(() => undefined);
      onOperationFeedback({ tone: 'error', message: `${label} could not restart`, detail: 'The console could not confirm the restart. Check the worktree before trying again.' });
    }
    finally {
      // keep successful replacements locked until dashboard confirmation
      if (!handedOff) {
        pendingWorktreeLaunches.delete(agent.worktreeId);
        setPendingOperation(operationKey, false);
      }
      // avoid updating an unmounted agent panel
      if (mounted.current) setRestarting(false);
    }
  };
  // clear one configured agent conversation
  const clear = async () => {
    const operationKey = clearOperationKey(agent.id);
    // serialize clear requests
    if (clearing || !beginPendingOperation(operationKey, workspace.viewKey)) return;
    setClearing(true);
    const label = displayLabel;
    onOperationFeedback({ tone: 'pending', message: `Clearing ${label}…`, detail: 'Sending /clear to reset the current Codex conversation.', worktreeId: agent.worktreeId });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '/clear', attachments: [] }) });
      // surface failed clears
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: `${label} could not clear`, detail: await launchError(response), worktreeId: agent.worktreeId });
      await promptHistory.refresh();
      onOperationFeedback({ tone: 'success', message: `${label} cleared`, detail: 'The /clear command was sent and the conversation is resetting.', worktreeId: agent.worktreeId });
    } catch {
      onOperationFeedback({ tone: 'error', message: `${label} could not clear`, detail: 'The console could not be reached. The conversation was not cleared.', worktreeId: agent.worktreeId });
    }
    finally {
      setPendingOperation(operationKey, false);
      // avoid updating an unmounted agent panel
      if (mounted.current) setClearing(false);
    }
  };
  // the inline question the dashboard reported for this agent (OMX files); the
  // Log socket supplies the parsed one, and the dashboard's takes precedence
  const dashboardQuestion = agent.question === undefined ? undefined : choiceQuestionFromInline(agent.question);
  const conversationName = useCurrentConversationName(agent.id, [agent.conversationId, workspace.conversations.currentName]);
  const panelState = agentPanelState(agent, startingNewTask);
  // Stop interrupts work in progress beside the hidden, disabled power control
  const cancelButton = active && <button type="button" className={`panel-header-action agent-cancel${progressBorder(cancelling, 'red')}`} disabled={cancelling} aria-busy={cancelling || undefined} aria-label="Cancel agent" title="Cancel agent" onClick={() => void cancel()}><ProgressRing busy={cancelling} /><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg></button>;
  const power = <AgentPowerMenu className="panel-header-action agent-power" pending={restarting || clearing || deactivating || deleting} progressColor={restarting ? 'yellow' : 'red'} hidden={active} {...(active ? { disabledReason: 'Cancel the agent’s work before restarting, clearing or turning it off' } : {})} onClear={() => void clear()} onTurnOff={() => void (agent.worktreeId === undefined ? remove() : deactivate())} newTask={agent.worktreeId !== undefined || agent.placeId === undefined ? { agentId: agent.id, worktreeId: agent.worktreeId, configured: agent.newTaskConfigured === true, onOperationFeedback } : undefined} {...(agent.worktreeId === undefined ? {} : { onRestart: () => void restart(), restartAs: { label: displayLabel, resolution: agent.launch, onLaunch: choice => void restart(choice) } })} />;
  const title = conversationName ?? displayLabel;
  const switcher = <AgentSwitcher agent={agent} agents={agents} title={title} placeLabel={displayLabel} onSelect={onSelectAgent} />;
  const header = (connection: string) => <PanelHeader panelKey="agent" label="agent output" title={<AgentPanelTitle kind={agent.kind} sandboxed={agent.sandboxed} title={title} switcher={switcher} state={panelState} connection={connection} />} actions={<>{workspace.conversations.control}{responseFiles.control}</>} close={<>{cancelButton}{power}<button type="button" className="panel-header-action pane-minimize" aria-label="Minimize agent output" title="Minimize agent (it keeps running)" onClick={() => setAgentSplitHidden(workspace.viewKey, true)}><PanelIcon path="M5 12h14" /></button></>} />;
  const prompt = <Prompt id={agent.id} history={promptHistory.history} onHistoryChanged={promptHistory.refresh} onPromptFocus={onPromptFocus} onOperationFeedback={onOperationFeedback} question={dashboardQuestion ?? question} worktreeId={agent.worktreeId} placeId={workspace.place.id} historyControl={<PromptHistoryControl agentId={agent.id} history={promptHistory.history} refreshHistory={promptHistory.refresh} notes={workspace.notes} open={historyOpen} onOpenChange={onHistoryOpenChange} />} />;
  const composer = agent.paneMode === undefined ? prompt : <><PaneModeNotice agentId={agent.id} mode={agent.paneMode} worktreeId={agent.worktreeId} onOperationFeedback={onOperationFeedback} />{prompt}</>;
  // reuse power actions without bypassing lifecycle safeguards
  const turnOff = () => {
    // keep active work protected like the power menu
    if (active) {
      onOperationFeedback({ tone: 'error', message: `${displayLabel} could not be turned off`, detail: 'Cancel the agent’s work before turning it off.', worktreeId: agent.worktreeId });
      return;
    }
    // ignore overlapping lifecycle operations
    if (restarting || clearing || deactivating || deleting || agentPendingOperation(agent) !== undefined || pendingOperations.has(deactivateOperationKey(workspace.place.id ?? agent.id))) return;
    void (agent.worktreeId === undefined ? remove() : deactivate());
  };
  // keep codex transcript shortcuts limited to codex and omx agent panels
  return <Log id={agent.id} onTurnOff={turnOff} codexScrollControls={agent.kind === undefined || agent.kind === 'codex' || agent.kind === 'omx'} onQuestion={setQuestion} onMetadata={reportMetadata} onAddToPrompt={onAddToPrompt} header={header} composer={composer} notes={workspace.notes} onOpenUrl={onOpenUrl} onOpenFile={onOpenFile} processingLabel={startingNewTask ? 'Starting new task…' : undefined} processingDetail={startingNewTask ? 'Closing this session and preparing a fresh agent. This can take a few seconds.' : undefined} />;
}

// whether an Agent has something for the operator: a question, or a finished turn not yet seen
const agentNeedsOperator = (agent: Agent): boolean => agentState(agent) === 'action-required' || agent.unread === true;

// The agent panel's title as the Agent switcher: the current conversation name ▾, the number of
// Agents at the Place (when more than one), and a pulsing dot while another Agent here needs an
// answer or has unread output. Its menu lists every Agent at the Place with its kind, name and
// state; launching another Agent stays a toolbar action.
function AgentSwitcher({ agent, agents, title, placeLabel, onSelect }: { agent: Agent; agents: readonly Agent[]; title: string; placeLabel: string; onSelect: (agentId: string) => void }) {
  const [open, setOpen] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout(open);
  const othersNeedYou = agents.some(candidate => candidate.id !== agent.id && agentNeedsOperator(candidate));
  const label = `Switch Agent at ${placeLabel}${othersNeedYou ? ' — another Agent needs you' : ''}`;
  const choose = (agentId: string) => {
    setOpen(false);
    if (agentId !== agent.id) onSelect(agentId);
  };
  return <><span className="agent-switcher-wrap" ref={anchorRef}><button type="button" className="agent-switcher" aria-label={label} aria-haspopup="menu" data-context-flyout aria-expanded={open} title={label} onClick={() => setOpen(value => !value)}>
    <span className="agent-panel-title">{title}</span>
    {agents.length > 1 && <span className="agent-switcher-count" aria-hidden="true">{agents.length}</span>}
    {othersNeedYou && <i className="agent-switcher-attention" aria-hidden="true" />}
    <svg className="agent-switcher-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
  </button></span>{open && <FlyoutPortal onDismiss={() => setOpen(false)}><div className="more-menu flyout-menu agent-switcher-menu" ref={flyoutRef} style={style} role="menu" aria-label={`Agents at ${placeLabel}`}>
    {agents.map(candidate => <AgentSwitcherRow key={candidate.id} agent={candidate} current={candidate.id === agent.id} onChoose={() => choose(candidate.id)} />)}
    <p className="agent-switcher-note">Launch another agent here from the toolbar. Each agent keeps its own draft, queue and history.</p>
  </div></FlyoutPortal>}</>;
}

// One switcher row: the Agent's kind, its current conversation's name and its state.
function AgentSwitcherRow({ agent, current, onChoose }: { agent: Agent; current: boolean; onChoose: () => void }) {
  // an untitled conversation says so; its kind stays on the line beneath, beside its state
  const conversation = useCurrentConversationName(agent.id, [agent.conversationId]);
  const name = conversation === null ? 'Untitled conversation' : conversation ?? (agent.kind === undefined ? agentLabel(agent) : agentKindLabel[agent.kind]);
  const state = agentPanelState(agent, false);
  const progress = agentStateProgress(state);
  return <button type="button" role="menuitemradio" aria-checked={current} aria-busy={agentStateBusy(state) || undefined} className={`agent-switcher-row${current ? ' current' : ''}${progress === undefined ? '' : ` progress-border progress-${progress}`}`} onClick={onChoose}>
    <ProgressRing busy={progress !== undefined} />
    {agent.kind !== undefined && <LaunchTabBadge kind={agent.kind} sandboxed={agent.sandboxed} />}
    <span className="agent-switcher-row-text"><strong>{name}</strong><small>{agent.kind === undefined ? '' : `${agentKindLabel[agent.kind]} · `}{state.label}</small></span>
    <span className={`agent-state-pill ${state.tone}`} aria-hidden="true" />
  </button>;
}

// The agent panel's state pill: its words and the tone that colours it.
type AgentPanelState = { label: string; tone: 'working' | 'starting' | 'restarting' | 'stopping' | 'needs-answer' | 'done' | 'idle' | 'off' | 'failed' };

// reserve progress borders for active work and lifecycle transitions
const agentStateProgress = (state: AgentPanelState): ProgressColor | undefined => state.tone === 'working' ? 'peach' : state.tone === 'starting' ? 'blue' : state.tone === 'restarting' ? 'yellow' : state.tone === 'stopping' ? 'red' : undefined;
const agentStateBusy = (state: AgentPanelState): boolean => state.tone === 'working' || state.tone === 'starting' || state.tone === 'restarting' || state.tone === 'stopping';

// A live Agent's state pill, from its attention and whether its finished turn is unread.
function agentPanelState(agent: Agent, starting: boolean): AgentPanelState {
  if (starting) return { label: 'Starting', tone: 'starting' };
  const state = agentState(agent);
  if (state === 'action-required') return { label: 'Needs answer', tone: 'needs-answer' };
  if (state === 'working') return { label: 'Working', tone: 'working' };
  return agent.unread === true ? { label: 'Done', tone: 'done' } : { label: 'Idle', tone: 'idle' };
}

// The current Conversation's name, which titles the agent panel. It is read once per Agent and
// again whenever `refreshOn` changes (a new conversation id after Clear, a name given from the
// Conversations fly-out); undefined until read, and null once read when the Conversation has no name.
function useCurrentConversationName(agentId: string, refreshOn: readonly unknown[]): string | null | undefined {
  const [name, setName] = useState<{ agentId: string; name?: string }>();
  const refreshKey = JSON.stringify(refreshOn);
  useEffect(() => {
    let cancelled = false;
    void request(`/api/agents/${encodeURIComponent(agentId)}/conversation`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled) return;
      const next = payload !== null && typeof payload === 'object' && typeof (payload as { name?: unknown }).name === 'string' ? (payload as { name: string }).name : undefined;
      setName({ agentId, ...(next === undefined ? {} : { name: next }) });
    }).catch(() => { /* keep the last name; the panel falls back to its label */ });
    return () => { cancelled = true; };
  }, [agentId, refreshKey]);
  return name?.agentId === agentId ? name.name ?? null : undefined;
}

// The agent panel's title pill: the kind mark, the title (the Agent switcher, once an Agent runs),
// the state and, while the output is not live, its connection status.
function AgentPanelTitle({ kind, sandboxed, title, switcher, state, connection = 'Live' }: { kind?: AgentKind; sandboxed?: boolean; title: string; switcher?: ReactNode; state: AgentPanelState; connection?: string }) {
  const progress = agentStateProgress(state);
  return <>
    {kind !== undefined && <LaunchTabBadge kind={kind} sandboxed={sandboxed} />}
    {switcher ?? <span className="agent-panel-title" title={title}>{title}</span>}
    <span className={`agent-state-pill ${state.tone}${progress === undefined ? '' : ` progress-border progress-${progress}`}`} aria-busy={agentStateBusy(state) || undefined}><ProgressRing busy={progress !== undefined} />{state.label}</span>
    {connection !== 'Live' && <span className={`status log-status ${connection.toLowerCase()}`}>{connection}</span>}
  </>;
}

// fill one agent split with a header, output, footer and full-frame overlay
function AgentPanelFrame({ header, composer, mobileKeys, overlay, className = '', children, onTurnOff }: { header: ReactNode; composer?: ReactNode; mobileKeys?: ReactNode; overlay?: ReactNode; className?: string; children?: ReactNode; onTurnOff?: () => void }) {
  const expanded = usePanelExpand('agent')?.expanded === true;
  // keep whole-split transitions outside the output cell and preserve footer controls
  return <div className={`log-output agent-panel${expanded ? ' expanded' : ''}${className}`} onAuxClickCapture={onTurnOff === undefined ? undefined : event => closeOnMiddleClick(event, onTurnOff)}>{header}<div className="agent-output">{children}</div>{composer}{mobileKeys}{overlay}</div>;
}

// How the toolbar launches an Agent at its Place: the kind the Place resolves (its last-used one),
// and what choosing a kind from the chevron does.
type ToolbarLaunch = { label: string; resolution?: LaunchResolution; start: (choice?: LaunchChoice) => void; disabled?: boolean; disabledReason?: string; pending?: boolean };
// keep a Scratch launch available when the active tab has no launchable Place
const GlobalLaunchContext = createContext<ToolbarLaunch | undefined>(undefined);

// The Workspace toolbar beneath the tab row: the current Workspace's controls, laid out the same
// with and without an Agent. Persistent Launch leads at the far left, followed by panel
// buttons, place status and actions; secondary phone panels move into the ⋮, and
// the carousel's position dots sit in the middle. `onOpenWorktreeStack` is a Process notice's
// Open, which switches to another Worktree with its stack menu open. `agentCount` is the Agents
// at the Place, which a minimized agent panel's Launch badge counts.
function WorkspaceToolbar({ workspace, agentCount = 0, launch, onOpenWorktreeStack, conversations, git, onGitToggle, cleanupControl, menu }: { workspace?: WorkspaceState; agentCount?: number; launch?: ToolbarLaunch; onOpenWorktreeStack?: (worktreeId: string) => void; conversations?: ReactNode; git?: WorkspaceGitActions; onGitToggle?: () => void; cleanupControl?: ReactNode; menu?: PlaceMenuProps }) {
  const phone = usePhoneLayout();
  const settingsSplit = useContext(ClientSettingsSplitContext);
  const globalLaunch = useContext(GlobalLaunchContext);
  const visibleLaunch = launch ?? globalLaunch;
  const place = workspace?.place;
  const worktreeId = place?.worktreeId;
  const projects = useContext(ProjectsContext);
  // a notice's Open in another Worktree asks this one's stack menu to open
  const stackMenuRequested = useRequestedStackMenu(worktreeId);
  // a Worktree shows its git status, a directory-Project or Scratch Place its path; an Agent the
  // dashboard placed nowhere (no Place id) still shows the git status discovery found for it
  const hasGit = worktreeId !== undefined || (place?.id === undefined && (place?.branch !== undefined || place?.gitStatus !== undefined));
  // on a phone the ⋮ opens secondary panels or brings an open one into view
  const menuPanels: PlaceMenuPanel[] = [];
  if (phone && workspace !== undefined) {
    const { browser, files, code, carousel } = workspace;
    if (browser.homeUrl !== undefined) menuPanels.push({ key: 'browser', label: 'Browser', icon: <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true">{browserGlyph}</svg>, title: 'Show the project in the browser panel', onSelect: () => browser.open ? carousel?.show('browser') : browser.toggle() });
    if (place?.id !== undefined) menuPanels.push({ key: 'files', label: 'Files', icon: <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true">{filesGlyph}</svg>, title: 'Show the host Files panel', onSelect: () => files.open ? carousel?.show('files') : files.show() });
    if (worktreeId !== undefined && (place?.stack?.processes?.length ?? 0) > 0) menuPanels.push({ key: 'stack', label: 'Stack', icon: <StackIcon path={stackGlyphs.panel} className="more-menu-icon" />, title: 'Show the Stack panel', onSelect: () => workspace.openStackPanel() });
    if (worktreeId !== undefined) menuPanels.push({ key: 'code', label: 'Code', icon: <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true">{codeGlyph}</svg>, title: 'Show the working changes in the Code panel', onSelect: () => code.open ? carousel?.show('code') : code.openChanges('working') });
  }
  // a phone toolbar action replaces the settings panel with its chosen workspace view
  return <section className="workspace-toolbar" aria-label="Workspace toolbar" onClickCapture={phone && settingsSplit?.open ? settingsSplit.close : undefined}><div className="workspace-toolbar-actions">
    {visibleLaunch !== undefined && <LaunchSplitButton label={visibleLaunch.label} resolution={visibleLaunch.resolution} quiet={agentCount > 0} disabled={visibleLaunch.disabled} disabledReason={visibleLaunch.disabledReason} pending={visibleLaunch.pending} alwaysShowMenu showAgentSettings onLaunch={visibleLaunch.start} minimized={workspace?.agentHidden ? { count: Math.max(agentCount, 1), onShow: workspace.showAgent } : undefined} />}
    {workspace?.agentHidden && visibleLaunch === undefined && <button type="button" className="toolbar-button" onClick={workspace.showAgent}>Show agent</button>}
    {conversations}
    {workspace?.terminals.control}
    {workspace?.notes.control}
    {workspace !== undefined && !phone && <BrowserToggle browser={workspace.browser} />}
    {workspace !== undefined && !phone && place?.id !== undefined && <FilesToggle files={workspace.files} />}
    {workspace !== undefined && !phone && worktreeId !== undefined && <CodeToggle code={workspace.code} />}
    {phone && workspace?.carousel !== undefined && workspace.carousel.panels.length > 1 ? <PanelDots carousel={workspace.carousel} /> : <span className="toolbar-spacer" aria-hidden="true" />}
    {cleanupControl}
    {workspace !== undefined && (hasGit ? <WorkspaceGitStatus workspace={workspace} actions={git} onToggle={onGitToggle} /> : place?.path !== undefined && <span className="toolbar-path" title={place.path}>{place.path}</span>)}
    {workspace !== undefined && <ProjectOpen url={place?.projectUrl} title={stackPlaceName(worktreeId, projects)?.worktree} stack={place?.stack} browserOpen={workspace.browser.open} onBrowserToggle={workspace.browser.toggle} {...(worktreeId === undefined ? {} : stackHandlers(worktreeId))} onStackLog={worktreeId === undefined ? undefined : () => stackLog(worktreeId)} onOpenStackPanel={worktreeId === undefined ? undefined : workspace.openStackPanel} worktreeId={worktreeId} onOpenWorktree={onOpenWorktreeStack} onStartNoticeTarget={startNoticeProcess} menuRequested={stackMenuRequested} />}
    {menu !== undefined && <PlaceMenu {...menu} panels={menuPanels} />}
  </div></section>;
}

// panel glyphs shared by toolbar buttons and phone rows
const browserGlyph = <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>;
const filesGlyph = <><path d="M3 7h7l2 2h9v10H3z" /><path d="M3 7V5h7l2 2" /></>;
const codeGlyph = <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />;

// The toolbar's Browser button: it opens and closes the Place's browser panel, tinted while open.
// A Place with no project URL has nothing to browse, so it shows no button at all.
function BrowserToggle({ browser }: { browser: WorkspaceState['browser'] }) {
  if (browser.homeUrl === undefined) return null;
  return <button type="button" className={`toolbar-button browser-toggle${browser.open ? ' panel-open' : ''}`} aria-label="Browser" aria-pressed={browser.open} title={browser.open ? 'Close the browser panel' : 'Open the project in the browser panel'} onClick={browser.toggle}><svg viewBox="0 0 24 24" aria-hidden="true">{browserGlyph}</svg><span className="toolbar-label">Browser</span></button>;
}

// open the retained host filesystem panel
function FilesToggle({ files }: { files: WorkspaceState['files'] }) {
  return <button type="button" className={`toolbar-button files-toggle${files.open ? ' panel-open' : ''}`} aria-label="Files" aria-pressed={files.open} title={files.open ? 'Close the Files panel' : 'Open the host Files panel'} onClick={files.toggle}><svg viewBox="0 0 24 24" aria-hidden="true">{filesGlyph}</svg><span className="toolbar-label">Files</span></button>;
}

// The toolbar's Code button: it opens the Worktree's working changes in the Code panel, or closes it.
function CodeToggle({ code }: { code: CodePanelController }) {
  return <button type="button" className={`toolbar-button code-toggle${code.open ? ' panel-open' : ''}`} aria-label="Code" aria-pressed={code.open} title={code.open ? 'Close the Code panel' : 'Open the working changes in the Code panel'} onClick={() => code.open ? code.close() : code.openChanges('working')}><svg viewBox="0 0 24 24" aria-hidden="true">{codeGlyph}</svg><span className="toolbar-label">Code</span></button>;
}

// what a tmux mode holding the Agent's pane looks like to the operator; the stream never
// shows it (tmux draws a mode for attached terminals, not into the pane's output)
const paneModeLabels: Record<string, string> = { 'tree-mode': 'tmux’s session picker', 'client-mode': 'tmux’s client picker', 'buffer-mode': 'tmux’s paste buffer picker', 'options-mode': 'tmux’s options editor', 'clock-mode': 'tmux’s clock' };
// a pane held by a tmux mode refuses prompts and keystrokes alike; offer the way out
function PaneModeNotice({ agentId, mode, worktreeId, onOperationFeedback }: { agentId: string; mode: string; worktreeId?: string; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const [leaving, setLeaving] = useState(false);
  const label = paneModeLabels[mode] ?? `tmux ${mode}`;
  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agentId)}/pane-mode/exit`, { method: 'POST' });
      if (!response.ok) onOperationFeedback({ tone: 'error', message: `Could not close ${label}`, detail: await launchError(response), worktreeId });
    } catch { onOperationFeedback({ tone: 'error', message: `Could not close ${label}`, detail: 'The console could not be reached.', worktreeId }); }
    finally { setLeaving(false); }
  };
  return <div className="pane-mode-notice" role="alert"><p><strong>The agent’s pane is stuck in {label}.</strong> Prompts and keystrokes can’t reach the agent until it closes; queued prompts send once it does.</p><button type="button" className={leaving ? 'progress-border progress-red' : undefined} aria-busy={leaving || undefined} disabled={leaving} onClick={() => void leave()}><ProgressRing busy={leaving} />Close it</button></div>;
}

function launchError(response: Response): Promise<string> {
  return response.json().then((body: { error?: unknown }) => typeof body.error === 'string' ? body.error : `Launch failed (${response.status}).`).catch(() => `Launch failed (${response.status}).`);
}

// what a starting agent panel says about the draft in its composer: it waits there, to queue once the Agent is ready
const pendingPromptDetail = 'Creating the agent session. Your prompt waits in the composer until the agent is ready.';
type InactiveWorktreePresentation = { ariaLabel?: string; heading: string; detail: string; status: string; tone: AgentPanelState['tone'] };
// describe one pending worktree launch
const worktreeLaunchPendingDetail = (kind: AgentKind | undefined): string => `Launching ${kind === undefined ? 'an agent' : agentKindLabel[kind]} and waiting for the agent session to become ready.`;
// describe one inactive worktree state (the Launch button now shows its own kind label)
const inactiveWorktreePresentation = (label: string, kind: AgentKind | undefined, state: { startingNewTask: boolean; restarting: boolean; turningOff: boolean; launching: boolean }): InactiveWorktreePresentation => {
  // name the configured launch agent
  const agentName = kind === undefined ? 'agent' : agentKindLabel[kind];
  // describe a fresh conversation
  if (state.startingNewTask) return { ariaLabel: 'Starting new task', heading: 'Starting new task…', detail: 'Waiting for the fresh agent session to become ready.', status: 'Starting', tone: 'starting' };
  // describe a restarted conversation
  if (state.restarting) return { ariaLabel: `Restarting ${label}`, heading: 'Restarting agent…', detail: 'Running the resume alias and reconnecting the previous conversation.', status: 'Restarting', tone: 'restarting' };
  // describe an Agent that is still stopping
  if (state.turningOff) return { ariaLabel: `Turning off ${label}`, heading: 'Turning off…', detail: 'Stopping the agent.', status: 'Turning off', tone: 'stopping' };
  // describe a fresh launch
  if (state.launching) return { ariaLabel: `Starting ${label}`, heading: `Starting ${agentName} at ${label}…`, detail: pendingPromptDetail, status: 'Starting', tone: 'starting' };
  return { heading: 'Agent is off', detail: 'This worktree is available. Launch an agent when you are ready to continue.', status: 'Off', tone: 'off' };
};

// render an inactive worktree
function WorktreeCard({ worktree, tabBar, renderNotifications, cleanupControl, transient = false, onLaunched, onOperationFeedback, onNavigateWorktree, onOpenWorktreeStack, onTogglePin, onRemove, removeDisabledReason, schedulePrefill }: { worktree: Worktree; tabBar: ReactNode; renderNotifications: (content: ReactNode) => ReactNode; cleanupControl?: ReactNode; transient?: boolean; onLaunched: (agentId: string, worktree: Worktree, operationKey: string) => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void; onNavigateWorktree: (worktreeId: string) => void; onOpenWorktreeStack: (worktreeId: string) => void; onTogglePin: () => void; onRemove?: () => void; removeDisabledReason?: string; schedulePrefill?: SchedulePrefill }) {
  const launchKey = launchOperationKey(worktree.id);
  const restartKey = restartOperationKey(worktree.id);
  const launching = usePendingOperation(launchKey);
  const restarting = usePendingOperation(restartKey);
  const turningOff = usePendingOperation(deactivateOperationKey(worktree.id));
  const startingNewTask = usePendingOperation(newTaskOperationKey(worktree.id));
  const processing = launching || restarting || turningOff || startingNewTask;
  const draftId = worktreePromptId(worktree.id);
  // keep a failed launch editable until retry, including after tab navigation
  const [promptOpened, setPromptOpened] = useState(() => Boolean(getPromptDraft(draftId) || promptAttachments.has(draftId)));
  // retain the composer when startup progress ends in an error
  useEffect(() => {
    // open immediately for a launch transition
    if (launching) setPromptOpened(true);
  }, [launching]);
  // prefer the explicitly selected pending agent
  const launchKind = pendingWorktreeLaunches.get(worktree.id)?.kind ?? worktree.launch?.kind;
  const presentation = inactiveWorktreePresentation(worktree.label, launchKind, { startingNewTask, restarting, turningOff, launching });
  const processingColor: ProgressColor = restarting ? 'yellow' : turningOff ? 'red' : 'blue';
  // keep place panels available without an agent
  const workspace = useWorkspace({ ...worktree, worktreeId: worktree.id }, { noteOptions: { schedulePrefill, onLaunchAndRun: noteId => launchAndRun(noteId), launchRunLabel: `${launchKind === undefined ? 'an agent' : agentKindLabel[launchKind]} on ${worktree.label}` }, onNavigateWorktree, onOperationFeedback });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  // start one inactive worktree
  const start = async (choice?: LaunchChoice) => {
    const operationKey = launchOperationKey(worktree.id);
    // serialize inactive worktree actions
    if (!worktree.available || processing || !beginPendingOperation(operationKey, placeItemKey(worktree.id))) return;
    const kind = choice?.kind ?? worktree.launch?.kind;
    pendingWorktreeLaunches.set(worktree.id, { operationKey, ...(kind === undefined ? {} : { kind }) });
    let handedOff = false;
    setError('');
    onOperationFeedback({ tone: 'pending', message: `Starting ${worktree.label}…`, detail: worktreeLaunchPendingDetail(kind), worktreeId: worktree.id });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, choice === undefined ? { method: 'POST' } : launchRequestInit(choice));
      // surface failed starts
      if (!response.ok) {
        const message = await launchError(response);
        setError(message);
        return onOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message, worktreeId: worktree.id });
      }
      const payload = await response.json() as { agentId?: unknown };
      // require the discovered replacement agent
      if (typeof payload.agentId !== 'string') {
        const message = 'The agent started but could not be opened.';
        setError(message);
        return onOperationFeedback({ tone: 'error', message: `${worktree.label} could not be opened`, detail: message, worktreeId: worktree.id });
      }
      onLaunched(payload.agentId, worktree, operationKey);
      handedOff = true;
      onOperationFeedback({ tone: 'success', message: `${worktree.label} is starting`, detail: 'The new agent session is ready and its output is connecting.', worktreeId: worktree.id });
    } catch {
      const message = 'Unable to reach the console while launching the agent.';
      setError(message);
      onOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message, worktreeId: worktree.id });
    }
    finally {
      // preserve successful handoffs until dashboard confirmation
      if (!handedOff) {
        pendingWorktreeLaunches.delete(worktree.id);
        setPendingOperation(operationKey, false);
      }
    }
  };
  // launch a fresh agent for this idle worktree and run one note on it, then hand the new
  // agent off so the tab switches to it — the frontend half of the Run primitive
  const launchAndRun = async (noteId: string): Promise<boolean> => {
    const operationKey = launchOperationKey(worktree.id);
    // serialize inactive worktree actions
    if (!worktree.available || processing || !beginPendingOperation(operationKey, placeItemKey(worktree.id))) return false;
    pendingWorktreeLaunches.set(worktree.id, { operationKey, ...(worktree.launch?.kind === undefined ? {} : { kind: worktree.launch.kind }) });
    let handedOff = false;
    setError('');
    onOperationFeedback({ tone: 'pending', message: `Starting ${worktree.label}…`, detail: 'Launching an agent to run the note.', worktreeId: worktree.id });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/notes/${encodeURIComponent(noteId)}/run`, { method: 'POST' });
      // surface a refused launch or a pane that never became ready
      if (!response.ok) {
        const message = await launchError(response);
        setError(message);
        onOperationFeedback({ tone: 'error', message: `${worktree.label} could not run the note`, detail: message, worktreeId: worktree.id });
        return false;
      }
      const payload = await response.json() as { agentId?: unknown };
      // require the discovered new agent
      if (typeof payload.agentId !== 'string') {
        const message = 'The agent started but could not be opened.';
        setError(message);
        onOperationFeedback({ tone: 'error', message: `${worktree.label} could not be opened`, detail: message, worktreeId: worktree.id });
        return false;
      }
      onLaunched(payload.agentId, worktree, operationKey);
      handedOff = true;
      onOperationFeedback({ tone: 'success', message: `${worktree.label} is running the note`, detail: 'The new agent session is ready and its output is connecting.', worktreeId: worktree.id });
      return true;
    } catch {
      const message = 'Unable to reach the console while launching the agent.';
      setError(message);
      onOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message, worktreeId: worktree.id });
      return false;
    } finally {
      // preserve successful handoffs until dashboard confirmation
      if (!handedOff) {
        pendingWorktreeLaunches.delete(worktree.id);
        setPendingOperation(operationKey, false);
      }
    }
  };
  // guided review needs an Agent
  const gitActions: WorkspaceGitActions = { reviewUnavailable: 'Launch agent to review', onAddToPrompt: text => addToPrompt(text), onSelectTarget: target => onNavigateWorktree(target.worktreeId), onOperationFeedback };
  // a starting Agent (or a draft typed before launch) gets the agent panel; with none, the
  // Workspace shows only its other panels
  const starting = launching || restarting || startingNewTask;
  // a draft with no launch under way can be dropped, which closes its panel
  const discardDraft: PanelAction = { key: 'discard', label: 'Discard draft', title: 'Discard this draft and its attachments', className: 'agent-discard', icon: <PanelIcon path={actionIconPaths.trash} />, onSelect: () => {
    // confirm before losing prepared text or files, as a failed launch's discard does
    if ((getPromptDraft(draftId) || promptAttachments.has(draftId)) && !window.confirm('Discard this draft and its attachments?')) return;
    promptAttachments.delete(draftId);
    setPromptDraft(draftId, '');
    setPromptOpened(false);
  } };
  const agentPanel = starting || promptOpened
    ? <PendingAgentPanel kind={launchKind} title={worktree.label} state={processing ? { label: presentation.status, tone: presentation.tone } : { label: 'Off', tone: 'off' }} loading={<PanelNotice busy={processing} progress={processingColor} ariaLabel={presentation.ariaLabel} heading={presentation.heading} detail={presentation.detail} />} close={starting ? undefined : discardDraft} composer={<Prompt id={draftId} ready={false} history={[]} onHistoryChanged={async () => { /* no agent history yet */ }} onPromptFocus={() => { /* draft belongs to the inactive worktree */ }} onOperationFeedback={onOperationFeedback} worktreeId={worktree.id} />} />
    : undefined;
  const launch: ToolbarLaunch = { label: worktree.label, resolution: worktree.launch, disabled: !worktree.available, pending: processing, start: choice => void start(choice) };
  // a starting or stopping Agent says so; otherwise, with no panel open, the Workspace is empty
  const empty = processing
    ? <PanelNotice className="workspace-empty" busy progress={processingColor} ariaLabel={presentation.ariaLabel} heading={presentation.heading} detail={presentation.detail} />
    : <EmptyWorkspace workspace={workspace} label={worktree.label} detail={worktree.branch === undefined ? worktree.path : `${worktree.path} · ${worktree.branch}`} launch={launch} onPin={transient ? onTogglePin : undefined} />;
  // a Terminal selection added to the prompt opens the draft composer
  const addToPrompt = (text: string) => {
    setPromptDraft(draftId, current => appendTextBlock(current, text));
    setPromptOpened(true);
  };
  // preserve the same dismissal when an agent starts or stops in this worktree
  const upstreamNotificationKey = JSON.stringify([worktree.id, worktree.branch, worktree.gitUpstream?.upstream]);
  return <article className="agent-view"><Workspace workspace={workspace} output={agentPanel} empty={empty} git={gitActions} onAddToPrompt={addToPrompt} onOpenWorktreeStack={onOpenWorktreeStack} />{tabBar}{renderNotifications(<UpstreamRebaseNotification key={upstreamNotificationKey} notificationKey={upstreamNotificationKey} summary={worktree.gitUpstream} />)}{error && <p className="launch-error" role="alert">{error}</p>}<WorkspaceToolbar workspace={workspace} launch={launch} onOpenWorktreeStack={onOpenWorktreeStack} conversations={workspace.conversations.control} git={gitActions} cleanupControl={cleanupControl} menu={{ worktreeId: worktree.id, git: true, onRemoveWorktree: onRemove, removeDisabledReason: processing ? 'An agent is starting or stopping here' : removeDisabledReason }} /></article>;
}

// keep startup and failure notices across the whole split
function PendingAgentPanel({ kind, title, state, loading, composer, close }: { kind?: AgentKind; title: string; state: AgentPanelState; loading: ReactNode; composer?: ReactNode; close?: PanelAction }) {
  return <AgentPanelFrame header={<PanelHeader panelKey="agent" label="agent output" close={close} title={<AgentPanelTitle kind={kind} title={title} state={state} />} />} composer={composer} overlay={loading} />;
}

// A startup, failure or idle notice centred in a panel or an empty Workspace.
function PanelNotice({ busy = false, progress = 'blue', ariaLabel, heading, detail, className = '', role }: { busy?: boolean; progress?: ProgressColor; ariaLabel?: string; heading: string; detail: string; className?: string; role?: 'status' }) {
  return <div className={`log-loading inactive${className === '' ? '' : ` ${className}`}${progressBorder(busy, progress)}`} role={role ?? (busy ? 'status' : undefined)} aria-busy={busy || undefined} aria-label={ariaLabel}><ProgressRing busy={busy} /><strong>{heading}</strong><span>{detail}</span></div>;
}

// render empty workspace actions and an optional pin warning
function EmptyWorkspace({ workspace, label, detail, launch, onPin }: { workspace: WorkspaceState; label: string; detail: string; launch?: ToolbarLaunch; onPin?: () => void }) {
  const toggleNotes = workspace.notes.toggleMenu;
  return <div className="empty-workspace" role="region" aria-label="Empty workspace"><div className="empty-workspace-card">
    <small className="empty-workspace-kicker">Empty workspace</small>
    <h2>{label}</h2>
    <p className="empty-workspace-detail">{detail}</p>
    <div className="empty-workspace-actions">
      {/* keep agent choices available on the empty card */}{launch !== undefined && <LaunchSplitButton label={launch.label} resolution={launch.resolution} disabled={launch.disabled} disabledReason={launch.disabledReason} pending={launch.pending} placeActions alwaysShowMenu onLaunch={launch.start} />}
      {workspace.terminals.control}
      {toggleNotes !== undefined && <button type="button" className="toolbar-button" aria-label="Notes" title="Open the notes here" onClick={() => void toggleNotes()}><svg className="notes-icon" viewBox="0 0 24 24" aria-hidden="true"><path className="notes-icon-sheet" d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 21v-6h6" /></svg><span className="toolbar-label">Notes</span></button>}
      <BrowserToggle browser={workspace.browser} />
      {workspace.place.worktreeId !== undefined && <CodeToggle code={workspace.code} />}
    </div>
    {onPin !== undefined && <p className="empty-workspace-warning">Nothing runs here, so this Workspace closes when you switch away.<button type="button" onClick={onPin}>Pin it</button></p>}
  </div></div>;
}

// How an agentless Place tab launches: the directory Project in place or the configured Scratch
// folder, shown with the Launch profile that path actually resolves; `endpoint` is the route that
// launches there, which the toolbar also uses to start another Agent beside a running one
type PlaceLaunch = { resolution?: LaunchResolution; endpoint: string; start: (choice?: LaunchChoice) => void };

// A Place's open-terminal count (when it has any) and its pin toggle, as a launcher row shows them.
// `noun` names the Place kind in the toggle's tooltip.
function PlaceShellsAndPin({ place, noun = 'folder', onTogglePin }: { place: { label: string; pinned: boolean; consoleShells?: number }; noun?: string; onTogglePin: () => void }) {
  const shellCount = place.consoleShells ?? 0;
  const shellsLabel = `${shellCount} open terminal${shellCount === 1 ? '' : 's'}`;
  return <>{shellCount > 0 && <span className="launcher-shells" title={shellsLabel} aria-label={shellsLabel}><LauncherRowIcon name="terminal" />{shellCount}</span>}<button type="button" className={`launcher-icon launcher-pin${place.pinned ? ' pinned' : ''}`} aria-pressed={place.pinned} aria-label={`${place.pinned ? 'Unpin' : 'Pin'} ${place.label}`} title={`${place.pinned ? 'Unpin' : 'Pin'} ${noun}`} onClick={onTogglePin}><LauncherRowIcon name="pin" /></button></>;
}

// render an agentless directory project or scratch place
// beside an idle placeholder, and the toolbar with its folder pin in the ⋮ and, unless the Place is an
// ad-hoc Scratch folder the console cannot launch into, a Launch button
function PlaceCard({ place, tabBar, cleanupControl, transient = false, launchDisabled, launch, onLaunched, onTogglePin, onOperationFeedback, schedulePrefill }: { place: Place; tabBar: ReactNode; cleanupControl?: ReactNode; transient?: boolean; launchDisabled: boolean; launch?: PlaceLaunch; onLaunched: (agentId: string, place: Pick<Place, 'id' | 'label'>, operationKey: string) => void; onTogglePin: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void; schedulePrefill?: SchedulePrefill }) {
  const [running, setRunning] = useState(false);
  // launch a fresh agent at this Place and run one note on it, then hand the new agent off so
  // the tab switches to it (the Place's notes Run route launches as a Launch here would)
  const launchAndRun = async (noteId: string): Promise<boolean> => {
    const operationKey = launchOperationKey(place.id);
    // serialize note launches with workspace shutdown
    if (running || !beginPendingOperation(operationKey, placeItemKey(place.id))) return false;
    pendingWorktreeLaunches.set(place.id, { operationKey });
    let handedOff = false;
    setRunning(true);
    onOperationFeedback({ tone: 'pending', message: `Starting ${place.label}…`, detail: 'Launching an agent to run the note.' });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(place.id)}/notes/${encodeURIComponent(noteId)}/run`, { method: 'POST' });
      if (!response.ok) {
        onOperationFeedback({ tone: 'error', message: `${place.label} could not run the note`, detail: await launchError(response) });
        return false;
      }
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') {
        onOperationFeedback({ tone: 'error', message: `${place.label} could not be opened`, detail: 'The agent started but could not be opened.' });
        return false;
      }
      onLaunched(payload.agentId, place, operationKey);
      handedOff = true;
      onOperationFeedback({ tone: 'success', message: `${place.label} is running the note`, detail: 'The new agent session is ready and its output is connecting.' });
      return true;
    } catch {
      onOperationFeedback({ tone: 'error', message: `${place.label} could not start`, detail: 'Unable to reach the console while launching the agent.' });
      return false;
    } finally {
      // retain successful handoffs until their agent is discovered
      if (!handedOff) {
        pendingWorktreeLaunches.delete(place.id);
        setPendingOperation(operationKey, false);
      }
      setRunning(false);
    }
  };
  const launchKind = launch?.resolution?.kind;
  const workspace = useWorkspace({ id: place.id, path: place.home }, { noteOptions: { schedulePrefill, ...(launch === undefined ? {} : { onLaunchAndRun: launchAndRun, launchRunLabel: `${launchKind === undefined ? 'an agent' : agentKindLabel[launchKind]} on ${place.label}` }) }, onOperationFeedback });
  // an ad-hoc Scratch folder has no launch: only its terminals and notes live here
  const toolbarLaunch: ToolbarLaunch | undefined = launch === undefined ? undefined : { label: place.label, resolution: launch.resolution, disabled: launchDisabled || running, pending: running, start: launch.start };
  const empty = <EmptyWorkspace workspace={workspace} label={place.label} detail={`${place.home} · ${place.kind === 'scratch' ? 'Scratch folder' : 'directory Project'}`} launch={toolbarLaunch} onPin={transient ? onTogglePin : undefined} />;
  // a note's Run launches here: the agent panel shows the start
  const agentPanel = running ? <PendingAgentPanel kind={launchKind} title={place.label} state={{ label: 'Starting', tone: 'starting' }} loading={<PanelNotice busy heading={`Starting ${launchKind === undefined ? 'agent' : agentKindLabel[launchKind]} at ${place.label}…`} detail="Launching an agent to run the note." />} /> : undefined;
  return <article className="agent-view"><Workspace workspace={workspace} output={agentPanel} empty={empty} />{tabBar}<WorkspaceToolbar workspace={workspace} launch={toolbarLaunch} cleanupControl={cleanupControl} menu={{ pinned: place.pinned, onTogglePin }} /></article>;
}

// render a scratch or directory session before discovery publishes its agent identity
function PendingSessionCard({ launch, tabBar, cleanupControl, retrying, onRetry, onDiscard, onOperationFeedback }: { launch: PendingSessionLaunch; tabBar: ReactNode; cleanupControl?: ReactNode; retrying: boolean; onRetry: (choice?: LaunchChoice) => void; onDiscard: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const processing = launch.phase !== 'failed';
  const kind = launch.kind ?? launch.resolution?.kind;
  let heading = `Starting ${kind === undefined ? 'agent' : agentKindLabel[kind]} at ${launch.label}…`;
  let detail = pendingPromptDetail;
  let state: AgentPanelState = { label: 'Starting', tone: 'starting' };
  // distinguish session creation, discovery and rejected starts
  switch (launch.phase) {
    case 'confirming':
    case 'delayed':
      heading = 'Connecting agent…';
      detail = 'The session started. Waiting for it to appear on the dashboard.';
      state = { label: 'Connecting', tone: 'starting' };
      break;
    case 'failed':
      heading = 'Agent did not start';
      detail = launch.error ?? 'Retry the launch when you are ready.';
      state = { label: 'Failed', tone: 'failed' };
      break;
  }
  const loading = <PanelNotice role="status" busy={processing} ariaLabel={processing ? `Starting ${launch.label}` : `${launch.label} launch failed`} heading={heading} detail={detail} />;
  const discard: PanelAction | undefined = launch.phase === 'failed' ? { key: 'discard', label: 'Discard failed launch', className: 'agent-discard', icon: <PanelIcon path={actionIconPaths.trash} />, onSelect: onDiscard } : undefined;
  // only a failed start offers Launch, which retries without replacing the prepared draft
  const retry: ToolbarLaunch | undefined = launch.phase === 'failed' ? { label: launch.label, resolution: launch.resolution, disabled: retrying, start: onRetry } : undefined;
  return <article className="agent-view"><section className="log-shell"><div className="log inactive-log"><ResizableLogSplit withSettings output={<PendingAgentPanel kind={kind} title={launch.label} state={state} loading={loading} close={discard} composer={<PreparingPrompt id={launch.draftId} onOperationFeedback={onOperationFeedback} />} />} /></div></section>{tabBar}{launch.error !== undefined && <p className="launch-error" role="alert">{launch.error}</p>}<WorkspaceToolbar launch={retry} cleanupControl={cleanupControl} /></article>;
}

// A tab's marks: one overlapping kind mark per Agent at the Place (or the kind a launch is
// starting), else a terminal glyph for a Place holding only shells, else a dashed square for an
// empty one.
function TabKindStack({ entry }: { entry: DashboardItem }) {
  const kinds = entry.agents.length > 0 ? entry.agents.flatMap(agent => agent.kind === undefined ? [] : [{ key: agent.id, kind: agent.kind, sandboxed: agent.sandboxed }])
    : entry.pendingLaunch?.kind !== undefined ? [{ key: entry.pendingLaunch.id, kind: entry.pendingLaunch.kind, sandboxed: entry.pendingLaunch.sandboxed }] : [];
  if (kinds.length > 0) return <span className="tab-kind-stack">{kinds.map(({ key, kind, sandboxed }) => <LaunchTabBadge key={key} kind={kind} sandboxed={sandboxed} />)}</span>;
  if (entry.agents.length > 0 || entry.pendingLaunch !== undefined) return null;
  const shells = (entry.worktree?.consoleShells ?? entry.place?.consoleShells ?? 0) > 0;
  return <span className="tab-kind-stack" aria-hidden="true">{shells
    ? <span className="tab-place-mark shells" title="Terminals only"><LauncherRowIcon name="terminal" /></span>
    : <span className="tab-place-mark empty" title="Empty workspace"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" /></svg></span>}</span>;
}

// The Agents outside `current` that wait on the operator: those with a question, and those with
// unread output (an Agent with both counts once, as a question).
function otherWorkspacesWaiting(items: readonly DashboardItem[], current: DashboardItem) {
  const agents = items.filter(entry => entry !== current).flatMap(entry => entry.agents);
  const questions = agents.filter(agent => agentState(agent) === 'action-required').length;
  return { questions, unread: agents.filter(agentNeedsOperator).length - questions };
}
// name a split type, counting only duplicates
const splitCountLabel = (count: number, noun: string) => count > 1 ? `${count} ${noun}s` : noun;
// summarize only open split types, then append any active status
function workspaceSheetDetail(entry: DashboardItem): string {
  const transition = dashboardOperationLabel(entry.operation);
  const state = transition !== undefined ? `${transition}…` : entry.state === 'action-required' ? 'Needs answer' : entry.unread ? 'Unread' : entry.state === 'working' ? 'Working' : undefined;
  const shells = entry.worktree?.consoleShells ?? entry.place?.consoleShells ?? 0;
  const agents = entry.agents.length + (entry.pendingLaunch === undefined ? 0 : 1);
  const splits = [...(agents > 0 ? [splitCountLabel(agents, 'Agent')] : []), ...(shells > 0 ? [splitCountLabel(shells, 'shell')] : [])];
  return [...(splits.length === 0 ? ['Empty'] : splits), ...(state === undefined ? [] : [state])].join(' · ');
}

// show the current workspace on phones, opening its chooser on a tap or upward swipe
function WorkspaceDropdown({ items, current, onSelect, onNewWorkspace, onRenameWorktree, renameDisabled, onContextMenu, onTurnOff }: { items: readonly DashboardItem[]; current: number; onSelect: (index: number) => void; onNewWorkspace: () => void; onRenameWorktree: (worktreeId: string) => void; renameDisabled: boolean; onContextMenu: (event: React.MouseEvent<HTMLButtonElement>, entry: DashboardItem) => void; onTurnOff: (entry: DashboardItem) => void }) {
  const [open, setOpen] = useState(false);
  const entry = items[current];
  // reuse single-step split swipes in the dropdown's workspace order
  const swipe = usePanelSwipe({
    panels: items,
    visibleKey: entry?.key,
    // use the same selection path as the workspace sheet
    show: key => { setOpen(false); onSelect(items.findIndex(candidate => candidate.key === key)); },
    // open rather than toggle so a swipe never closes the chooser
    onSwipeUp: () => setOpen(true)
  });
  // omit the selector when no workspace remains
  if (entry === undefined) return null;
  const { transition, label, className, progress, busy } = tabStatus(entry);
  const { questions, unread } = otherWorkspacesWaiting(items, entry);
  const waiting = questions + unread;
  const waitingLabel = `Other Workspaces: ${questions} need an answer, ${unread} unread`;
  const choose = (action: () => void) => { setOpen(false); action(); };
  return <><button id={`tab-${current}`} type="button" role="tab" aria-selected="true" aria-controls={`panel-${current}`} className={`workspace-dropdown active ${className}`} aria-haspopup="dialog" aria-expanded={open} aria-busy={busy || undefined} aria-label={`${entry.label} — ${label}`} aria-description={waiting > 0 ? waitingLabel : undefined} title="Switch Workspace" onPointerDown={swipe.onPointerDown} onPointerUp={swipe.onPointerUp} onPointerCancel={swipe.onPointerCancel} onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd} onTouchCancel={swipe.onTouchCancel} onClickCapture={swipe.onClickCapture} onPointerDownCapture={preserveWorkspacePress} onMouseDownCapture={preserveWorkspacePress} onContextMenu={event => onContextMenu(event, entry)} onAuxClickCapture={event => closeOnMiddleClick(event, () => onTurnOff(entry))} onClick={() => setOpen(value => !value)}>
    <ProgressRing busy={progress !== undefined} />
    <TabKindStack entry={entry} />
    {/* reuse the desktop two-line transition label on narrow workspace tabs */}
    <span className={`workspace-dropdown-label tab-label${transition === undefined ? '' : ' tab-transition-label'}`}><span>{entry.label}</span>{transition !== undefined && <small>{transition}…</small>}</span>
    {waiting > 0 && <span className={`workspace-dropdown-badge${questions > 0 ? ' question' : ''}`} title={waitingLabel} aria-hidden="true">{waiting}</span>}
    <svg className="workspace-dropdown-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
  </button>{open && <FlyoutPortal onDismiss={() => setOpen(false)}><div className="workspace-sheet" role="dialog" aria-label="Workspaces">
    <h2 className="workspace-sheet-heading">Workspaces</h2>
    {/* keep rename beside each worktree without nesting buttons */}
    {items.map((candidate, index) => {
      const worktree = candidate.worktree;
      const status = tabStatus(candidate);
      return <div key={candidate.key} className={`workspace-sheet-row ${status.className}`} aria-busy={status.busy || undefined}><ProgressRing busy={status.progress !== undefined} /><button type="button" className="workspace-sheet-entry" onPointerDownCapture={preserveWorkspacePress} onMouseDownCapture={preserveWorkspacePress} onContextMenu={event => { /* keep the target menu above the dismissed sheet */ setOpen(false); onContextMenu(event, candidate); }} onAuxClickCapture={event => closeOnMiddleClick(event, () => { /* close only the chosen workspace */ setOpen(false); onTurnOff(candidate); })} aria-current={index === current ? 'true' : undefined} autoFocus={index === current} onClick={() => choose(() => onSelect(index))}><TabKindStack entry={candidate} /><span className="workspace-sheet-copy"><strong className="tab-label">{candidate.label}</strong><small>{workspaceSheetDetail(candidate)}</small></span></button>{worktree !== undefined && <button type="button" className="workspace-sheet-rename" disabled={renameDisabled} aria-label={`Rename ${worktree.label}`} title="Rename worktree" onClick={() => choose(() => onRenameWorktree(worktree.id))}><LauncherRowIcon name="rename" /></button>}</div>;
    })}
    <hr />
    <button type="button" className="workspace-sheet-entry workspace-sheet-new" onClick={() => choose(onNewWorkspace)}><span className="tab-kind-stack" aria-hidden="true"><span className="tab-place-mark"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span></span><span className="workspace-sheet-copy"><strong>New Workspace…</strong><small>Launch, Terminal or Empty workspace</small></span></button>
  </div></FlyoutPortal>}</>;
}

// render browser notification enrollment
function NotificationControl() {
  const supported = 'Notification' in window;
  const [permission, setPermission] = useState<NotificationPermission | undefined>(() => supported ? Notification.permission : undefined);
  const [publicKey, setPublicKey] = useState<string>();
  useEffect(() => { void request('/api/push/public-key').then(response => response.ok ? response.json() : undefined).then((value: { publicKey?: unknown } | undefined) => typeof value?.publicKey === 'string' && setPublicKey(value.publicKey)); }, []);
  const syncSubscription = async () => {
    if (!publicKey || !('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await request('/api/push/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
  };
  useEffect(() => { if (permission === 'granted') void syncSubscription(); }, [permission, publicKey]);
  const enable = async () => {
    if (!supported || permission !== 'default' || !publicKey || !('serviceWorker' in navigator)) return;
    const next = await Notification.requestPermission();
    setPermission(next);
    if (next === 'granted') { await syncSubscription(); await showNotification('system', 'Alerts enabled', 'You will be notified when agents need attention and reviews or updates are ready.', 'rac-alerts-enabled'); }
  };
  if (!supported || !publicKey || permission === 'granted') return null;
  if (permission === 'denied') return <span className="notification-status" title="Enable notifications for this site in your browser settings">Alerts blocked</span>;
  return <button className="notification-control" type="button" onClick={() => void enable()}>Enable alerts</button>;
}

// resume the visual countdown from the same deadline used to dismiss the toast
function ToastTimerBar({ expires }: { expires: number }) {
  // keep the initial offset stable through rerenders and recalculate after remounts
  const delay = useMemo(() => Math.min(0, expires - Date.now() - toastDurationMs), [expires]);
  return <span key={expires} className="toast-timer-bar" aria-hidden="true" style={{ animationDuration: `${toastDurationMs}ms`, animationDelay: `${delay}ms` }} />;
}

// present timed successes and persistent failures with an optional accessible label
function OperationFeedbackToast({ feedback, onDismiss, ariaLabel }: { feedback: OperationFeedback; onDismiss: () => void; ariaLabel?: string }) {
  const role = feedback.tone === 'error' ? 'alert' : 'status';
  const pending = feedback.tone === 'pending';
  return <div className={`toast operation-feedback ${feedback.tone}${progressBorder(pending, 'peach')}`} role={role} aria-busy={pending || undefined} aria-label={ariaLabel} aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'}>
    <ProgressRing busy={pending} />
    <span className="operation-feedback-icon" aria-hidden="true">{feedback.tone === 'success' ? '✓' : feedback.tone === 'error' ? '!' : ''}</span>
    <span className="operation-feedback-copy"><strong>{feedback.message}</strong><span>{feedback.detail}</span></span>
    {feedback.tone !== 'pending' && <button type="button" aria-label="Dismiss operation status" title="Dismiss" onClick={onDismiss}><PanelIcon path={panelIcons.close} /></button>}
    {feedback.tone === 'success' && feedback.expires !== undefined && <ToastTimerBar expires={feedback.expires} />}
  </div>;
}

type DeletedNoteFeedback = { id: number; label: string; undoToken: string; expires: number; undoing?: boolean; error?: string };
// retain independent undo windows above workspace-specific note views
function NoteFeedbackProvider({ children }: { children: ReactNode }) {
  const [deletions, setDeletions] = useState<DeletedNoteFeedback[]>([]);
  const nextId = useRef(0);
  const restoring = useRef(new Set<number>());
  // start the five-second window only after the server confirms deletion
  const deleted = useCallback((label: string, undoToken: string) => {
    const entry = { id: ++nextId.current, label, undoToken, expires: Date.now() + toastDurationMs };
    setDeletions(current => [...current, entry]);
  }, []);
  // expire toasts by their original deadlines even when the workspace changes
  useEffect(() => {
    const expiring = deletions.filter(entry => !entry.undoing);
    // retain feedback while an undo request is in flight
    if (expiring.length === 0) return;
    const timer = window.setTimeout(() => {
      setDeletions(current => current.filter(entry => entry.undoing || entry.expires > Date.now()));
    }, Math.max(0, Math.min(...expiring.map(entry => entry.expires)) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deletions]);
  // restore the server-held snapshot without recreating a partial note
  const undo = async (entry: DeletedNoteFeedback) => {
    // ignore repeated clicks while the original undo is pending
    if (restoring.current.has(entry.id)) return;
    restoring.current.add(entry.id);
    setDeletions(current => current.map(candidate => candidate.id === entry.id ? { ...candidate, undoing: true, error: undefined } : candidate));
    try {
      // keep undo compatible with the same explicit json transport as deletion
      const response = await request(`/api/notes/deletions/${encodeURIComponent(entry.undoToken)}/undo`, emptyJsonMutation('POST'));
      // show failure rather than claiming a missing snapshot was restored
      if (!response.ok || !isWorktreeNote(await response.json())) throw new Error('note restore failed');
      // shared notes may be visible in several mounted note views
      for (const reload of noteReloadRequests.values()) reload();
      setDeletions(current => current.filter(candidate => candidate.id !== entry.id));
    } catch {
      setDeletions(current => current.map(candidate => candidate.id === entry.id ? { ...candidate, undoing: false, error: 'Unable to restore note. Try again.', expires: Date.now() + toastDurationMs } : candidate));
    } finally {
      restoring.current.delete(entry.id);
    }
  };
  // share the existing toast stack instead of overlaying a second region
  const toasts = deletions.map(entry => <section key={entry.id} className="toast note-deletion-toast" role="status" aria-label="Note deleted"><div><strong>Note “{entry.label}” was deleted</strong>{entry.error && <span role="alert">{entry.error}</span>}</div><button type="button" className={entry.undoing ? 'progress-border progress-blue' : undefined} aria-busy={entry.undoing || undefined} disabled={entry.undoing} onClick={() => { /* restore only this deletion */ void undo(entry); }}><ProgressRing busy={entry.undoing === true} />{entry.undoing ? 'Restoring…' : 'Undo'}</button>{!entry.undoing && <ToastTimerBar expires={entry.expires} />}</section>);
  return <NoteFeedbackContext.Provider value={{ deleted, toasts }}>{children}</NoteFeedbackContext.Provider>;
}

// overlay transient feedback and persistent notices without resizing split content
function ToastRegion({ children, feedback, onDismissFeedback, updateError, onDismissUpdateError, launchErrorMessage, launchErrorExpires }: { children?: ReactNode; feedback?: OperationFeedback; onDismissFeedback: () => void; updateError?: string; onDismissUpdateError: () => void; launchErrorMessage?: string; launchErrorExpires?: number }) {
  const clientSettings = useContext(ClientSettingsContext);
  const noteFeedback = useContext(NoteFeedbackContext);
  const [reloadingClient, setReloadingClient] = useState(false);
  const reloadClient = clientSettings?.reloadClient;
  // paint the committed progress border before replacing the document
  useEffect(() => {
    // schedule navigation only after the reload button is clicked
    if (!reloadingClient || reloadClient === undefined) return;
    let frame = window.requestAnimationFrame(() => {
      // leave one rendered frame before navigation can suspend painting
      frame = window.requestAnimationFrame(reloadClient);
    });
    // cancel navigation if this toast host unmounts before the next frame
    return () => window.cancelAnimationFrame(frame);
  }, [reloadClient, reloadingClient]);
  const showSettingsRestart = useSettingsRestartNoticeVisible();
  // keep stale-client guidance visible until the browser reloads
  const showClientUpdate = clientSettings?.clientUpdateAvailable === true;
  // the launch error is redundant while an error-tone operation toast already says the same thing
  const showLaunchError = Boolean(launchErrorMessage) && feedback?.tone !== 'error';
  // omit an empty stack when there is no persistent notice
  if (children == null && feedback === undefined && !updateError && !showLaunchError && !showClientUpdate && !showSettingsRestart && !noteFeedback?.toasts.length) return null;
  return createPortal(<div className="toast-region">
    {noteFeedback?.toasts}
    {showClientUpdate && <section className="toast client-update-notification" role="status" aria-label="UI update available"><div className="client-update-copy"><h2>UI update available</h2><span>Reload to use the latest version.</span></div><button type="button" className="progress-border progress-blue" data-fullscreen-focus-return="reload" disabled={reloadingClient} aria-busy={reloadingClient} onClick={() => {
      // keep reload feedback visible while the replacement document is loading
      if (reloadingClient) return;
      setReloadingClient(true);
    }}>{reloadingClient && <span className="update-progress-ring" aria-hidden="true" />}Reload UI</button></section>}
    <SettingsRestartNotice />
    {feedback && <OperationFeedbackToast key={feedback.id} feedback={feedback} onDismiss={onDismissFeedback} />}
    {/* keep update failures independent from other operation feedback */}
    {updateError && <OperationFeedbackToast ariaLabel="Agent update failed" feedback={{ id: 0, tone: 'error', message: 'Agent update failed', detail: updateError }} onDismiss={onDismissUpdateError} />}
    {showLaunchError && <p className="toast toast-error" role="alert">{launchErrorMessage}{launchErrorExpires !== undefined && <ToastTimerBar expires={launchErrorExpires} />}</p>}
    {children}
  </div>, document.body);
}

// what a successful worktree creation hands back to the launcher
type WorktreeCreated = { worktreeId: string; agentId?: string; launchError?: string; setupError?: string };

// Password managers offer to fill a lone text field in a dialog, reading a branch name as a
// username; `autoComplete="off"` alone does not stop them, so opt out per vendor as well.
const noAutofill = { autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'off', spellCheck: false, 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

// rename a non-git workspace on this browser without renaming its folder
function RenameWorkspaceDialog({ workspace, onClose }: { workspace: { key: string; label: string }; onClose: () => void }) {
  const [name, setName] = useState(workspace.label);
  // save the client-local alias without changing server identity
  const save = (event: React.FormEvent) => { event.preventDefault(); setWorkspaceAlias(workspace.key, name); onClose(); };
  return createPortal(<div className="dialog client-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-rename-title" onKeyDown={event => { /* dismiss without saving */ if (event.key === 'Escape') onClose(); }}><div><header><h2 id="workspace-rename-title">Rename workspace</h2><button type="button" aria-label="Close rename workspace" onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header><form onSubmit={save}><p>This name applies to this browser only.</p><label>Workspace name<input autoFocus value={name} maxLength={120} {...noAutofill} onChange={event => setName(event.target.value)} /></label><footer><button type="button" onClick={() => { /* restore the discovered name */ setWorkspaceAlias(workspace.key, ''); onClose(); }}>Use default name</button><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={!name.trim()}>Save</button></footer></form></div></div>, document.body);
}

// rename one discovered Worktree without moving its checkout or changing its branch
function RenameWorktreeDialog({ worktree, request, onClose, onRenamed }: { worktree: Worktree; request: (url: string, init?: RequestInit) => Promise<Response>; onClose: () => void; onRenamed: (label: string | undefined) => void }) {
  const [name, setName] = useState(worktree.label);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // write one normalized custom label
  const rename = async (event: React.FormEvent) => {
    event.preventDefault();
    const label = name.trim();
    // serialize and validate local submissions
    if (pending || label.length === 0) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/label`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) });
      // surface one server-side rejection
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Unable to rename this worktree.');
      }
      onRenamed(label);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to rename this worktree.');
      setPending(false);
    }
  };
  // restore discovery's Project-and-branch label
  const reset = async () => {
    // serialize reset with save
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/label`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: null }) });
      // surface one server-side rejection
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Unable to reset this worktree name.');
      }
      onRenamed(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to reset this worktree name.');
      setPending(false);
    }
  };
  return createPortal(<div className="dialog client-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-rename-title" onKeyDown={event => { /* close on escape */ if (event.key === 'Escape' && !pending) onClose(); }}><div><header><div><small>WORKTREE</small><h2 id="worktree-rename-title">Rename worktree</h2></div><button type="button" aria-label="Close rename worktree" disabled={pending} onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header><form onSubmit={event => void rename(event)}><p>Choose the name shown on tabs, launch controls and agent status.</p><label>Worktree name<input autoFocus type="text" value={name} maxLength={120} {...noAutofill} onChange={event => setName(event.target.value)} /></label>{error !== undefined && <span className="auth-error" role="alert">{error}</span>}<footer><button type="button" className="worktree-rename-reset" disabled={pending} onClick={() => void reset()}>Use branch name</button><button type="button" disabled={pending} onClick={onClose}>Cancel</button><button type="submit" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending || !name.trim()}><ProgressRing busy={pending} />{pending ? 'Saving…' : 'Save'}</button></footer></form></div></div>, document.body);
}

// The branch <select> both modes share: the Base a new branch starts from and the existing
// branch to check out. Options carry the git ref as their value so a remote-only branch
// resolves, and the fetch's loading, failure, and empty states render in the field's place.
function BranchSelect({ label, options, value, failed, empty, onChange }: { label: string; options: BranchOption[] | undefined; value: string; failed: boolean; empty: string; onChange: (ref: string) => void }) {
  if (failed) return <p className="new-worktree-error" role="alert">Could not load branches.</p>;
  if (options === undefined) return <p className="new-worktree-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Loading branches…</p>;
  if (options.length === 0) return <p className="new-worktree-empty">{empty}</p>;
  return <label>{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.ref} value={option.ref}>{option.name}{option.remote ? ' (remote)' : ''}</option>)}</select></label>;
}

// The "New worktree…" dialog: create a checkout for a new branch (name + a base chosen
// from the Project's branches, pre-selected to its default) or an existing local /
// remote-only branch, launching the Project's last-used kind by default. One dialog from
// branch to prompting.
function NewWorktreeDialog({ project, request, onClose, onCreated }: { project: Project; request: (url: string, init?: RequestInit) => Promise<Response>; onClose: () => void; onCreated: (result: WorktreeCreated) => void }) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [branches, setBranches] = useState<BranchOption[] | undefined>(undefined);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  // both pickers hold the selected option's ref, not its branch name
  const [base, setBase] = useState('');
  const [existingRef, setExistingRef] = useState('');
  const [launchAgent, setLaunchAgent] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // fetch the offerable branches and default base once the dialog opens
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await request(`/api/projects/${encodeURIComponent(project.id)}/branches`).catch(() => undefined);
      if (cancelled) return;
      if (response === undefined || !response.ok) return setBranchesFailed(true);
      const payload = await response.json().catch(() => undefined) as { branches?: BranchOption[]; defaultBranch?: string } | undefined;
      const offered = payload?.branches ?? [];
      setBranches(offered);
      // pre-select the default branch by the ref that resolves it, keeping the plain name
      // when git named a branch it did not list
      const fallback = typeof payload?.defaultBranch === 'string' ? offered.find(option => option.name === payload.defaultBranch)?.ref ?? payload.defaultBranch : undefined;
      if (fallback !== undefined && fallback !== '') setBase(current => current === '' ? fallback : current);
      const checkoutable = offered.find(option => !option.checkedOut);
      if (checkoutable !== undefined) setExistingRef(current => current === '' ? checkoutable.ref : current);
    })();
    return () => { cancelled = true; };
  }, [project.id]);
  // a Worktree already holds a checked-out branch, so only the base picker offers those
  const existingOptions = branches?.filter(option => !option.checkedOut);
  // an unlisted base (git named a default branch it did not list) stays selectable
  const baseOptions = branches === undefined || base === '' || branches.some(option => option.ref === base) ? branches : [{ name: base, ref: base, remote: false, checkedOut: false }, ...branches];
  const submit = async () => {
    setError(undefined);
    // git checks out an existing branch by name; the ref only told the picker where it lives
    const branch = mode === 'new' ? newBranch.trim() : existingOptions?.find(option => option.ref === existingRef)?.name ?? '';
    if (branch === '') return setError(mode === 'new' ? 'Enter a branch name.' : 'Choose a branch to check out.');
    setPending(true);
    try {
      // an empty base falls to the Project's default branch on the server
      const response = await request(`/api/projects/${encodeURIComponent(project.id)}/worktrees`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, branch, ...(mode === 'new' && base !== '' ? { base } : {}), launch: launchAgent }) }).catch(() => undefined);
      if (response === undefined) return setError('Unable to reach the console.');
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
        return setError(payload?.error ?? 'The worktree could not be created.');
      }
      const payload = await response.json() as WorktreeCreated;
      onCreated(payload);
    } finally { setPending(false); }
  };
  const noExisting = existingOptions !== undefined && existingOptions.length === 0;
  return createPortal(<div className="dialog new-worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="new-worktree-title"><div>
    <header className="new-worktree-header"><div><h2 id="new-worktree-title">New worktree</h2><p>{project.label}</p></div><button className="new-worktree-close" type="button" aria-label="Close new worktree" disabled={pending} onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header>
    <div className="new-worktree-modes" role="tablist" aria-label="Branch source">
      <button type="button" role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>New branch</button>
      <button type="button" role="tab" aria-selected={mode === 'existing'} className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}>Existing branch</button>
    </div>
    {mode === 'new'
      ? <div className="new-worktree-fields"><label>Branch name<input aria-label="Branch name" type="text" name="worktree-branch-name" value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="feature/login" autoFocus {...noAutofill} /></label><BranchSelect label="Base" options={baseOptions} value={base} failed={branchesFailed} empty="No branches are available as a base." onChange={setBase} /></div>
      : <div className="new-worktree-fields"><BranchSelect label="Branch" options={existingOptions} value={existingRef} failed={branchesFailed} empty="No branches are available to check out." onChange={setExistingRef} /></div>}
    <label className="new-worktree-launch"><input type="checkbox" checked={launchAgent} onChange={event => setLaunchAgent(event.target.checked)} />Launch agent in the new worktree</label>
    {pending && project.setup && <p className="new-worktree-status progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Running the setup command in the new worktree — this can take a minute.</p>}
    {error && <p className="new-worktree-error" role="alert">{error}</p>}
    <footer className="new-worktree-actions"><button type="button" className="outline-button" disabled={pending} onClick={onClose}>Cancel</button><button type="button" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending || (mode === 'existing' && (existingOptions === undefined || noExisting))} onClick={() => void submit()}><ProgressRing busy={pending} />{pending ? 'Creating…' : 'Create worktree'}</button></footer>
  </div></div>, document.body);
}

// The Remove dialog: fetch the worktree's fresh facts, then let the operator remove it —
// a dirty tree only behind "Discard uncommitted changes", the branch behind its own tick,
// which warns first when the branch is neither pushed nor merged (deleting it then loses
// those commits). A running Agent or stack session is a blocker that refuses it; a running
// Stack process is not, and the dialog names it as one the Remove stops.
function RemoveWorktreeDialog({ worktree, request, onClose, onRemoved }: { worktree: Worktree; request: (url: string, init?: RequestInit) => Promise<Response>; onClose: () => void; onRemoved: (message: string) => void }) {
  const [facts, setFacts] = useState<RemovalFacts | undefined>(undefined);
  const [factsError, setFactsError] = useState<string | undefined>(undefined);
  const [discard, setDiscard] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/removal`).catch(() => undefined);
      if (cancelled) return;
      const payload = response === undefined || !response.ok ? undefined : await response.json().catch(() => undefined) as RemovalFacts | undefined;
      if (cancelled) return;
      if (payload === undefined) return setFactsError('Could not load the worktree details.');
      setFacts(payload);
    })();
    return () => { cancelled = true; };
  }, [worktree.id]);
  const dirty = (facts?.dirtyCount ?? 0) > 0;
  const blocked = (facts?.blockers.length ?? 0) > 0;
  // deleting a branch that is neither pushed nor merged loses its commits; the operator may
  // still choose it, so this only escalates the warning rather than disabling the tick
  const branchAtRisk = facts?.branch !== undefined && !facts.pushed && !facts.merged;
  const submit = async () => {
    setError(undefined);
    setPending(true);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ discardChanges: discard, deleteBranch }) }).catch(() => undefined);
      if (response === undefined) return setError('Unable to reach the console.');
      if (!response.ok) return setError(await launchError(response));
      const payload = await response.json().catch(() => ({})) as { branchDeleted?: boolean; branchDeleteError?: string };
      onRemoved(payload.branchDeleteError !== undefined ? `${worktree.label} removed, but its branch was not deleted: ${payload.branchDeleteError}` : payload.branchDeleted ? `${worktree.label} and its branch were removed.` : `${worktree.label} was removed.`);
    } finally { setPending(false); }
  };
  const disabled = pending || facts === undefined || blocked || (dirty && !discard);
  return createPortal(<div className="dialog remove-worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-worktree-title"><div>
    <header className="remove-worktree-header"><div><h2 id="remove-worktree-title">Remove worktree</h2><p>{worktree.label}</p></div><button className="remove-worktree-close" type="button" aria-label="Close remove worktree" disabled={pending} onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header>
    {factsError !== undefined ? <p className="remove-worktree-error" role="alert">{factsError}</p>
      : facts === undefined ? <p className="remove-worktree-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Loading worktree details…</p>
      : <>
        <ul className="remove-worktree-facts">
          <li>{dirty ? <strong>{facts.dirtyCount} uncommitted {facts.dirtyCount === 1 ? 'change' : 'changes'}</strong> : 'No uncommitted changes'}</li>
          <li>{facts.pushed ? 'Pushed to a remote' : 'Not pushed'}{facts.branch === undefined ? '' : facts.merged ? ' · merged' : ' · not merged'}</li>
          {(facts.ahead !== undefined || facts.behind !== undefined) && <li>{facts.ahead ?? 0} ahead · {facts.behind ?? 0} behind upstream</li>}
          {facts.stopsProcesses.map(name => <li key={name}>Stops <code>{name}</code>, its running Stack process</li>)}
        </ul>
        {blocked && <p className="remove-worktree-blocked" role="alert">Cannot remove while {facts.blockers.join(' and ')} {facts.blockers.length === 1 ? 'is' : 'are'} running.</p>}
        {dirty && <label className="remove-worktree-option"><input type="checkbox" checked={discard} disabled={blocked} onChange={event => setDiscard(event.target.checked)} />Discard uncommitted changes</label>}
        {facts.branch !== undefined && <label className="remove-worktree-option"><input type="checkbox" checked={deleteBranch} disabled={blocked} onChange={event => setDeleteBranch(event.target.checked)} />Also delete branch <code>{facts.branch}</code></label>}
        {branchAtRisk && <p className={deleteBranch ? 'remove-worktree-branch-warning armed' : 'remove-worktree-branch-warning'} role="alert"><code>{facts.branch}</code> is neither pushed nor merged.</p>}
      </>}
    {error !== undefined && <p className="remove-worktree-error" role="alert">{error}</p>}
    <footer className="remove-worktree-actions"><button type="button" className="outline-button" disabled={pending} onClick={onClose}>Cancel</button><button type="button" className={`danger${progressBorder(pending, 'red')}`} aria-busy={pending || undefined} disabled={disabled} onClick={() => void submit()}><ProgressRing busy={pending} />{pending ? 'Removing…' : 'Remove worktree'}</button></footer>
  </div></div>, document.body);
}

// The Prune confirm: list the stale checkouts (git's prunable entries and the console's
// orphaned records) by path, warn under the Docker bridge that an unmounted host checkout
// only looks stale, then clear them all on confirm. Explicit and never automatic (ADR 0003).
function PruneWorktreesDialog({ project, request, onClose, onPruned }: { project: Project; request: (url: string, init?: RequestInit) => Promise<Response>; onClose: () => void; onPruned: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const stale = project.stalePaths ?? [];
  const prune = async () => {
    setError(undefined);
    setPending(true);
    try {
      const response = await request(`/api/projects/${encodeURIComponent(project.id)}/worktrees/prune`, { method: 'POST' }).catch(() => undefined);
      if (response === undefined) return setError('Unable to reach the console.');
      if (!response.ok) return setError(await launchError(response));
      onPruned();
    } finally { setPending(false); }
  };
  return createPortal(<div className="dialog prune-dialog" role="dialog" aria-modal="true" aria-labelledby="prune-title"><div>
    <header className="prune-header"><div><h2 id="prune-title">Prune worktrees</h2><p>{project.label}</p></div><button className="prune-close" type="button" aria-label="Close prune" disabled={pending} onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header>
    <p>Clear {stale.length} stale {stale.length === 1 ? 'checkout' : 'checkouts'} — git's prunable entries and the console's orphaned records.</p>
    <ul className="prune-paths">{stale.map(path => <li key={path}><code>{path}</code></li>)}</ul>
    <p className="prune-warning" role="note">A host checkout the container does not mount can look stale from inside the container — prune only what you know is gone.</p>
    {error !== undefined && <p className="prune-error" role="alert">{error}</p>}
    <footer className="prune-actions"><button type="button" className="outline-button" disabled={pending} onClick={onClose}>Cancel</button><button type="button" className={`danger${progressBorder(pending, 'red')}`} aria-busy={pending || undefined} disabled={pending || stale.length === 0} onClick={() => void prune()}><ProgressRing busy={pending} />{pending ? 'Pruning…' : 'Prune'}</button></footer>
  </div></div>, document.body);
}

// render the active console dashboard
function DashboardView({ onUnauthorized, onInactive, updateError, onDismissUpdateError }: { onUnauthorized: () => void; onInactive: () => void; updateError?: string; onDismissUpdateError: () => void }) {
  const serverInfo = useContext(ServerContext) ?? fallbackServerInfo();
  const clientSettings = useContext(ClientSettingsContext);
  const davo = clientSettings?.davo ?? legacyDavoSettings;
  const dynamicWorktrees = useDynamicWorktrees();
  useWorkspaceViewRevision();
  const [renameWorkspace, setRenameWorkspace] = useState<{ key: string; label: string }>();
  const [data, setData] = useState<Dashboard>();
  // the dashboard generation as reactive state, updated on every advancing snapshot even when the
  // content itself is deduped, so an open notes fly-out or pane refetches after any Run outcome
  const [dashboardGeneration, setDashboardGeneration] = useState<number>();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceCallRequest, setVoiceCallRequest] = useState(0);
  // close only the voice surface
  const closeVoice = useCallback(() => setVoiceOpen(false), []);
  // open, call, or reveal the shared voice surface
  const openVoice = useCallback(() => {
    // toggle only an ongoing mobile call
    if (voiceActive) {
      if (window.matchMedia('(max-width: 600px)').matches) setVoiceOpen(current => !current);
      else setVoiceOpen(true);
      return;
    }
    setVoiceOpen(true);
    setVoiceCallRequest(current => current + 1);
  }, [voiceActive]);
  // remove the call surface as soon as voice is disabled
  useEffect(() => {
    // retain state while voice remains enabled
    if (davo.enabled) return;
    setVoiceOpen(false);
    setVoiceActive(false);
  }, [davo.enabled]);
  // retain one stable voice trigger context
  const voiceTrigger = useMemo(() => davo.enabled ? { open: openVoice, active: voiceActive, visible: voiceOpen, name: davo.name } : undefined, [davo.enabled, davo.name, openVoice, voiceActive, voiceOpen]);
  const [reviewLaunch, setReviewLaunch] = useState<ReviewLaunch>();
  // counts tour starts, so each start mounts a fresh dialog
  const [reviewStarts, setReviewStarts] = useState(0);
  // the Worktree whose start sheet is open
  const [reviewStart, setReviewStart] = useState<ReviewTarget>();
  const [reviewInitialTour, setReviewInitialTour] = useState<ReviewTour>();
  // a restored tour's stored Code review, or the job still running one
  const [reviewInitialCodeReview, setReviewInitialCodeReview] = useState<{ review?: CodeReview; job?: CodeReviewJob }>({});
  const [reviewMinimized, setReviewMinimized] = useState(false);
  // the open review panel's column in the reviewed Worktree's split, while that tab is in view
  const [reviewSlot, setReviewSlot] = useState<ReviewPanelSlot>();
  const [reviewIndicator, setReviewIndicator] = useState<ReviewTourIndicator>({ generating: false, stale: false });
  const [reviewRestoringWorktreeId, setReviewRestoringWorktreeId] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [active, setActive] = useState(0);
  const [creatingAgent, setCreatingAgent] = useState(false);
  // the Place tab whose toolbar Launch is starting another Agent beside its running ones
  const [launchingAnotherAt, setLaunchingAnotherAt] = useState<string>();
  const [pendingSessionLaunches, setPendingSessionLaunches] = useState<PendingSessionLaunch[]>([]);
  const pendingSessionLaunchesRef = useRef<PendingSessionLaunch[]>([]);
  const pendingSessionLaunchSequence = useRef(0);
  const [activatePendingSessionId, setActivatePendingSessionId] = useState<string>();
  // update render state and dashboard reconciliation from one launch snapshot
  const updatePendingSessionLaunches = useCallback((update: (current: PendingSessionLaunch[]) => PendingSessionLaunch[]) => {
    const next = update(pendingSessionLaunchesRef.current);
    pendingSessionLaunchesRef.current = next;
    setPendingSessionLaunches(next);
  }, []);
  const [launcherOpen, setLauncherOpen] = useState(false);
  // consume the notification destination when its launcher closes
  const closeLauncher = () => {
    setLauncherOpen(false);
    // preserve unrelated navigation hashes
    if (location.hash === '#launch') history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  };
  // route update notifications to the agent launcher
  useEffect(() => {
    const openFromHash = () => { /* honor the launch destination */ if (location.hash === '#launch') setLauncherOpen(true); };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, []);
  const phone = usePhoneLayout();
  // Places opened from + (Terminal, Empty workspace) that keep a tab while the operator is on it
  // though nothing keeps them yet (no Agent, shell, pin or draft); leaving one closes it
  const [openedPlaces, setOpenedPlaces] = useState<ReadonlySet<string>>(() => new Set());
  // the Places whose + Terminal is still finding or creating a shell, so a repeat waits
  const terminalOpening = useRef(new Set<string>());
  const tabsRef = useRef<HTMLElement | null>(null);
  const { anchorRef: launcherRef, flyoutRef: launcherMenuRef, style: launcherStyle } = useViewportFlyout(launcherOpen);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const [plusAlone, setPlusAlone] = useState(false);
  const [launchErrorMessage, setLaunchErrorMessage] = useState('');
  // preserve the fallback notice's deadline when its region remounts
  const launchErrorExpires = useMemo(() => launchErrorMessage ? Date.now() + toastDurationMs : undefined, [launchErrorMessage]);
  const [operationFeedback, setOperationFeedback] = useState<OperationFeedback>();
  const operationFeedbackId = useRef(0);
  const [activateAgentId, setActivateAgentId] = useState<string>();
  const [activateWorktreeId, setActivateWorktreeId] = useState<string>();
  // the Project whose "New worktree…" dialog is open, if any
  const [newWorktreeProjectId, setNewWorktreeProjectId] = useState<string>();
  // the Worktree whose Remove dialog is open, and the Project whose Prune confirm is open
  const [removeWorktreeId, setRemoveWorktreeId] = useState<string>();
  const [renameWorktreeId, setRenameWorktreeId] = useState<string>();
  const [pruneProjectId, setPruneProjectId] = useState<string>();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupTargets, setCleanupTargets] = useState<CleanupTarget[]>([]);
  const [cleanupChecked, setCleanupChecked] = useState<Set<string>>(() => new Set());
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const cleanupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousCleanupCount = useRef(0);
  const refreshInFlight = useRef(false);
  const dashboardPushFreshUntil = useRef(0);
  const dashboardPushSynchronized = useRef(false);
  const dashboardContent = useRef('');
  const dashboardSnapshot = useRef<Dashboard | undefined>(undefined);
  const latestDashboardServerStartedAt = useRef<number | undefined>(undefined);
  const latestDashboardGeneration = useRef<number | undefined>(undefined);
  const selectedItemKey = useRef<string | undefined>(undefined);
  // the Agent each Place tab's switcher shows, by tab key; a tab with no choice (or whose chosen
  // Agent is gone) shows its first Agent
  const [agentChoice, setAgentChoice] = useState<Readonly<Record<string, string>>>({});
  // choose the Agent a tab's switcher shows
  const chooseAgent = useCallback((key: string, agentId: string) => setAgentChoice(current => current[key] === agentId ? current : { ...current, [key]: agentId }), []);
  // the Agent in view (the active tab's switcher choice), so its notifications stay quiet
  const viewedAgentId = useRef<string | undefined>(undefined);
  // retain the last viewed completion across buffered dashboard publications
  const viewedCompletions = useRef(new Map<string, string>());
  const dashboardMounted = useRef(true);
  // assign one shared deadline to each transient success and its countdown
  const showOperationFeedback = useCallback((feedback: Omit<OperationFeedback, 'id'>) => {
    operationFeedbackId.current += 1;
    setOperationFeedback({ ...feedback, id: operationFeedbackId.current, expires: feedback.tone === 'success' ? Date.now() + toastDurationMs : undefined });
  }, []);
  // remember the completion before clearing its optimistic highlight
  const viewAgent = useCallback((agent: Pick<Agent, 'id' | 'worktreeId' | 'completionId'>) => {
    const latest = dashboardSnapshot.current?.agents.find(candidate => candidate.id === agent.id);
    // ignore callbacks rendered for an older completed turn or removed agent
    if (latest === undefined || latest.completionId !== agent.completionId) return;
    // only identified completions can suppress a later replay
    if (agent.completionId !== undefined) viewedCompletions.current.set(agent.id, agent.completionId);
    setData(current => {
      // preserve a newer completion queued after this callback's snapshot check
      if (current === undefined || !current.agents.some(candidate => candidate.id === agent.id && candidate.completionId === agent.completionId && candidate.unread)) return current;
      return { ...current, agents: current.agents.map(candidate => candidate.id === agent.id && candidate.completionId === agent.completionId ? { ...candidate, unread: false } : candidate) };
    });
    dismissAgentNotifications(agent);
  }, []);
  // dismiss fallback launch notices when their countdown reaches zero
  useEffect(() => {
    // leave empty or persistent notices without a timer
    if (launchErrorExpires === undefined) return;
    const timer = window.setTimeout(() => setLaunchErrorMessage(''), Math.max(0, launchErrorExpires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [launchErrorExpires]);
  // expire only the success whose countdown was scheduled
  useEffect(() => {
    // pending operations and failures remain until explicitly resolved
    if (operationFeedback?.tone !== 'success' || operationFeedback.expires === undefined) return;
    const id = operationFeedback.id;
    const timer = window.setTimeout(() => setOperationFeedback(current => current?.id === id ? undefined : current), Math.max(0, operationFeedback.expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [operationFeedback]);
  const agentStates = useRef(new Map<string, AgentState>());
  const pendingCompletions = useRef(new Map<string, { due: number; timer: number }>());
  // release launch state when the dashboard leaves
  useEffect(() => () => {
    dashboardMounted.current = false;
    // clear every dashboard-owned launch
    for (const pendingLaunch of pendingWorktreeLaunches.values()) {
      // cancel confirmation recovery
      if (pendingLaunch.confirmationTimer !== undefined) window.clearTimeout(pendingLaunch.confirmationTimer);
      setPendingOperation(pendingLaunch.operationKey, false);
    }
    pendingWorktreeLaunches.clear();
    // cancel scratch and directory confirmation recovery
    for (const pendingLaunch of pendingSessionLaunchesRef.current) {
      // release only active confirmation timers
      if (pendingLaunch.confirmationTimer !== undefined) window.clearTimeout(pendingLaunch.confirmationTimer);
    }
    pendingSessionLaunchesRef.current = [];
  }, []);
  const applyDashboard = useCallback((payload: Dashboard) => {
    const latestServerStartedAt = latestDashboardServerStartedAt.current;
    // reject snapshots from an older server process
    if (payload.serverStartedAt !== undefined && latestServerStartedAt !== undefined && payload.serverStartedAt < latestServerStartedAt) return;
    // reject legacy snapshots after a scoped server snapshot arrives
    if (payload.serverStartedAt === undefined && latestServerStartedAt !== undefined) return;
    // reset generation ordering across server processes
    if (payload.serverStartedAt !== undefined && payload.serverStartedAt !== latestServerStartedAt) {
      latestDashboardServerStartedAt.current = payload.serverStartedAt;
      latestDashboardGeneration.current = undefined;
    }
    // reject stale HTTP snapshots that finish after newer pushes
    if (payload.generation !== undefined && latestDashboardGeneration.current !== undefined && payload.generation < latestDashboardGeneration.current) return;
    // retain the newest ordered snapshot boundary, and surface it reactively for the notes refetch
    if (payload.generation !== undefined) { latestDashboardGeneration.current = payload.generation; setDashboardGeneration(payload.generation); }
    const retainedWorktrees: Worktree[] = [];
    const priorWorktrees = dashboardSnapshot.current === undefined ? [] : allWorktrees(dashboardSnapshot.current);
    const pendingWorktreeIds = new Set([...pendingNewTaskSources.keys(), ...pendingWorktreeLaunches.keys()]);
    // preserve every pending handoff workspace
    for (const worktreeId of pendingWorktreeIds) {
      const visible = payload.agents.some(agent => agent.worktreeId === worktreeId) || allWorktrees(payload).some(worktree => worktree.id === worktreeId);
      // keep server-provided workspace entries
      if (visible) continue;
      const priorWorktree = priorWorktrees.find(worktree => worktree.id === worktreeId);
      const sourceAgentId = pendingNewTaskSources.get(worktreeId) ?? pendingWorktreeLaunches.get(worktreeId)?.sourceAgentId;
      const sourceAgent = dashboardSnapshot.current?.agents.find(agent => agent.id === sourceAgentId && agent.worktreeId === worktreeId);
      // the Project id is the wire id prefix `<projectId>:<realpath>` (a colon-less id is its own project)
      const projectId = sourceAgent?.projectId ?? (worktreeId.includes(':') ? worktreeId.slice(0, worktreeId.indexOf(':')) : worktreeId);
      const retained = priorWorktree ?? (sourceAgent === undefined ? undefined : { id: worktreeId, projectId, label: sourceAgent.worktreeLabel ?? agentLabel(sourceAgent), path: sourceAgent.home, main: false, detached: false, locked: false, branch: sourceAgent.branch, gitStatus: sourceAgent.gitStatus, gitPrStatus: sourceAgent.gitPrStatus, gitUpstream: sourceAgent.gitUpstream, available: false, pinned: false, order: Number.MAX_SAFE_INTEGER, projectUrl: sourceAgent.projectUrl, projectProxied: sourceAgent.projectProxied, pullRequest: sourceAgent.pullRequest, stack: sourceAgent.stack });
      // retain the last known workspace shape
      if (retained !== undefined) retainedWorktrees.push({ ...retained, available: false, pinned: false });
    }
    // keep a viewed completion read without suppressing a different completed turn
    const agents = payload.agents.map(agent => agent.completionId !== undefined && viewedCompletions.current.get(agent.id) === agent.completionId ? { ...agent, unread: false } : agent);
    const nextPayload = { ...payload, agents, ...(retainedWorktrees.length === 0 ? {} : { projects: mergeRetainedWorktrees(payload.projects, retainedWorktrees) }) };
    dashboardSnapshot.current = nextPayload;
    const activeAgentIds = new Set(nextPayload.agents.map(agent => agent.id));
    // bound viewed completion identities to agents still in the dashboard
    for (const id of viewedCompletions.current.keys()) {
      // forget a removed pane rather than carrying its dismissal to a replacement
      if (!activeAgentIds.has(id)) viewedCompletions.current.delete(id);
    }
    const activeWorktreeIds = new Set(allWorktrees(nextPayload).map(worktree => worktree.id));
    // move startup drafts only when their worktree has a discovered agent
    for (const agent of nextPayload.agents) {
      // scratch agents have no worktree placeholder
      if (agent.worktreeId === undefined) continue;
      activeWorktreeIds.add(agent.worktreeId);
      const pendingLaunch = pendingWorktreeLaunches.get(agent.worktreeId);
      // never hand a replacement draft to the old or mismatched session
      if (pendingLaunch?.sourceAgentId === agent.id || pendingLaunch?.excludedAgentIds?.includes(agent.id) === true || pendingNewTaskSources.get(agent.worktreeId) === agent.id
        || pendingLaunch?.agentId !== undefined && pendingLaunch.agentId !== agent.id) continue;
      handoffPromptDraft(worktreePromptId(agent.worktreeId), agent.id);
    }
    const confirmedSessionLaunchIds = new Set<string>();
    // hand scratch and directory drafts only to the exact returned agent
    for (const pendingLaunch of pendingSessionLaunchesRef.current) {
      // wait until both the launch response and dashboard agree on identity
      if (pendingLaunch.agentId === undefined || !activeAgentIds.has(pendingLaunch.agentId)) continue;
      const shouldActivate = selectedItemKey.current === `pending-${pendingLaunch.id}`;
      handoffPromptDraft(pendingLaunch.draftId, pendingLaunch.agentId);
      // cancel stale-agent recovery after discovery confirms the session
      if (pendingLaunch.confirmationTimer !== undefined) window.clearTimeout(pendingLaunch.confirmationTimer);
      confirmedSessionLaunchIds.add(pendingLaunch.id);
      // preserve navigation away from the pending tab: follow the Agent into its Place's tab
      const discovered = nextPayload.agents.find(agent => agent.id === pendingLaunch.agentId);
      if (shouldActivate && discovered !== undefined) {
        selectedItemKey.current = agentItemKey(discovered);
        setActivateAgentId(discovered.id);
      }
    }
    // remove only dashboard-confirmed placeholders
    if (confirmedSessionLaunchIds.size > 0) {
      updatePendingSessionLaunches(current => current.filter(launch => !confirmedSessionLaunchIds.has(launch.id)));
      setActivatePendingSessionId(current => current !== undefined && confirmedSessionLaunchIds.has(current) ? undefined : current);
    }
    const retainedPromptIds = new Set([...activeAgentIds, ...Array.from(activeWorktreeIds, worktreePromptId), ...pendingSessionLaunchesRef.current.map(launch => launch.draftId)]);
    // retire optimistic dismissals for removed agents
    for (const id of dismissedQuestionIds.keys()) if (!activeAgentIds.has(id)) dismissedQuestionIds.delete(id);
    // retain drafts while their agent or inactive worktree still exists
    for (const id of promptDrafts.keys()) {
      // retire removed draft caches
      if (!retainedPromptIds.has(id)) promptDrafts.delete(id);
    }
    // release attachment buffers belonging to removed workspaces
    for (const id of promptAttachments.keys()) {
      // keep pending launch files through dashboard updates
      if (!retainedPromptIds.has(id)) promptAttachments.delete(id);
    }
    for (const [worktreeId, sourceAgentId] of pendingNewTaskSources) {
      const replacement = nextPayload.agents.find(agent => agent.worktreeId === worktreeId && agent.id !== sourceAgentId && agent.reviewRun === undefined);
      const sourceStillActive = nextPayload.agents.some(agent => agent.id === sourceAgentId);
      // wait through both handoff sides
      if (replacement === undefined && (sourceStillActive || activeWorktreeIds.has(worktreeId))) continue;
      pendingNewTaskSources.delete(worktreeId);
      setPendingOperation(newTaskOperationKey(worktreeId), false);
      if (replacement !== undefined) showOperationFeedback({ tone: 'success', message: 'New task is ready', detail: `${agentLabel(replacement)} is ready for a fresh prompt.`, worktreeId });
    }
    // finish launches only after their dashboard agent appears
    for (const [worktreeId, pendingLaunch] of pendingWorktreeLaunches) {
      const replacement = pendingLaunch.agentId === undefined
        ? nextPayload.agents.find(agent => agentPlaceId(agent) === worktreeId && agent.id !== pendingLaunch.sourceAgentId && pendingLaunch.excludedAgentIds?.includes(agent.id) !== true && agent.reviewRun === undefined)
        : nextPayload.agents.find(agent => agent.id === pendingLaunch.agentId && agentPlaceId(agent) === worktreeId);
      // wait for the matching agent identity
      if (replacement === undefined) continue;
      const shouldActivate = selectedItemKey.current === placeItemKey(worktreeId);
      // cancel confirmation recovery
      if (pendingLaunch.confirmationTimer !== undefined) window.clearTimeout(pendingLaunch.confirmationTimer);
      pendingWorktreeLaunches.delete(worktreeId);
      setPendingOperation(pendingLaunch.operationKey, false);
      // preserve newer navigation choices
      if (shouldActivate) setActivateAgentId(replacement.id);
    }
    const content = JSON.stringify([nextPayload.agents, nextPayload.projects, nextPayload.places ?? [], nextPayload.cleanupPending ?? 0, nextPayload.reviewTour, nextPayload.codeReview, nextPayload.reviews, nextPayload.notesRevision, nextPayload.serverStartedAt, nextPayload.keys]);
    if (content !== dashboardContent.current || pendingCompletions.current.size > 0) {
      dashboardContent.current = content;
      setData(nextPayload);
    }
    setUnavailable(false);
  }, [showOperationFeedback, updatePendingSessionLaunches]);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const response = await request('/api/dashboard', { signal: AbortSignal.timeout(8_000) });
      if (response.status === 401) return onUnauthorized();
      if (response.status === 423) return onInactive();
      if (!response.ok) throw new Error('dashboard unavailable');
      const payload: unknown = await response.json();
      if (!isDashboard(payload)) throw new Error('invalid dashboard response');
      applyDashboard(payload);
      if (dashboardPushSynchronized.current) dashboardPushFreshUntil.current = Date.now() + 60_000;
    } catch { setUnavailable(true); }
    finally { refreshInFlight.current = false; }
  }, [applyDashboard, onInactive, onUnauthorized]);
  useEffect(() => {
    // wait for an active review binding
    if (reviewLaunch === undefined || data === undefined) return;
    // clear replaced or removed agent bindings (a sibling Agent at the Worktree is not a replacement)
    if (!data.agents.some(agent => agent.id === reviewLaunch.agentId && agent.worktreeId === reviewLaunch.worktreeId)) { setReviewLaunch(undefined); setReviewInitialTour(undefined); setReviewIndicator({ generating: false, stale: false }); }
  }, [data, reviewLaunch]);
  const closeCleanup = useCallback(() => {
    setCleanupOpen(false);
    setCleanupError('');
    if (location.hash === '#cleanup') history.replaceState(null, '', `${location.pathname}${location.search}`);
    void dismissNotification('runtime-cleanup');
    window.requestAnimationFrame(() => cleanupTriggerRef.current?.focus());
  }, []);
  // load suggestions without preselecting unmerged closed PR work
  const openCleanup = useCallback(async () => {
    setCleanupOpen(true);
    setCleanupLoading(true);
    setCleanupError('');
    try {
      const response = await request('/api/cleanup');
      // reject failed cleanup requests
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      const targets = payload !== null && typeof payload === 'object' && Array.isArray((payload as { targets?: unknown }).targets)
        ? (payload as { targets: unknown[] }).targets.filter(isCleanupTarget)
        : undefined;
      // refuse incomplete or unknown target lists
      if (targets === undefined || targets.length !== (payload as { targets: unknown[] }).targets.length) throw new Error();
      setCleanupTargets(targets);
      // require explicit selection before discarding closed PR work
      setCleanupChecked(new Set(targets.filter(target => target.kind !== 'closed-pr-branch').map(target => target.id)));
    } catch {
      setCleanupTargets([]);
      setCleanupChecked(new Set());
      setCleanupError('Unable to load cleanup targets.');
    } finally {
      setCleanupLoading(false);
    }
  }, []);
  // submit explicit choices and reset consent for unresolved closed PR branches
  const resolveCleanup = useCallback(async () => {
    // serialize cleanup submissions
    if (cleanupLoading) return;
    setCleanupLoading(true);
    setCleanupError('');
    try {
      const response = await request('/api/cleanup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetIds: [...cleanupChecked] }) });
      // reject failed cleanup requests
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      const targets = payload !== null && typeof payload === 'object' && Array.isArray((payload as { targets?: unknown }).targets)
        ? (payload as { targets: unknown[] }).targets.filter(isCleanupTarget)
        : undefined;
      // refuse incomplete or unknown target lists
      if (targets === undefined || targets.length !== (payload as { targets: unknown[] }).targets.length) throw new Error();
      // close only after every target is resolved
      if (targets.length === 0) closeCleanup();
      else {
        setCleanupTargets(targets);
        // require explicit selection before discarding closed PR work
        setCleanupChecked(new Set(targets.filter(target => target.kind !== 'closed-pr-branch').map(target => target.id)));
        setCleanupError('Some selected targets could not be cleaned up.');
      }
      await refresh();
    } catch {
      setCleanupError('Cleanup failed. No unresolved targets were dismissed.');
    } finally {
      setCleanupLoading(false);
    }
  }, [cleanupChecked, cleanupLoading, closeCleanup, refresh]);
  useEffect(() => {
    const count = data?.cleanupPending ?? 0;
    if (count > 0 && previousCleanupCount.current === 0) void showNotification('system', 'Cleanup available', `${count} cleanup ${count === 1 ? 'target is' : 'targets are'} ready.`, 'runtime-cleanup', '/#cleanup');
    if (count === 0 && previousCleanupCount.current > 0) void dismissNotification('runtime-cleanup');
    previousCleanupCount.current = count;
  }, [data?.cleanupPending]);
  useEffect(() => {
    const openFromHash = () => {
      if (location.hash === '#cleanup' && (data?.cleanupPending ?? 0) > 0 && !cleanupOpen) void openCleanup();
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [cleanupOpen, data?.cleanupPending, openCleanup]);
  useEffect(() => {
    if (!cleanupOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (isPromptKeyboardTarget(event.target) || event.key !== 'Escape' || cleanupLoading) return;
      event.preventDefault();
      closeCleanup();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [cleanupLoading, cleanupOpen, closeCleanup]);
  useEffect(() => pollWhileVisible(() => Date.now() < dashboardPushFreshUntil.current ? undefined : refresh(), 5_000, true, 30_000), [refresh]);
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let retryDelay = 500;
    const reconnect = () => {
      if (closed || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
    };
    // open one authenticated dashboard stream
    const connect = async () => {
      if (closed) return;
      try {
        const response = await request('/api/dashboard/ticket', emptyJsonMutation('POST'), false);
        if (!response.ok) return reconnect();
        const payload = await response.json() as { ticket?: unknown };
        if (closed || typeof payload.ticket !== 'string') return reconnect();
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/dashboard`, ['rac', payload.ticket]);
        socket = ws;
        ws.onmessage = event => {
          if (closed || socket !== ws) return;
          try {
            const frame: unknown = JSON.parse(event.data);
            if (!isDashboardFrame(frame)) throw new Error();
            dashboardPushSynchronized.current = true;
            dashboardPushFreshUntil.current = Date.now() + 60_000;
            retryDelay = 500;
            applyDashboard(frame.dashboard);
          } catch { ws.close(); }
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = undefined;
          dashboardPushSynchronized.current = false;
          dashboardPushFreshUntil.current = 0;
          reconnect();
        };
        ws.onerror = () => ws.close();
      } catch { reconnect(); }
    };
    void connect();
    return () => {
      closed = true;
      dashboardPushSynchronized.current = false;
      dashboardPushFreshUntil.current = 0;
      if (retry !== undefined) window.clearTimeout(retry);
      socket?.close();
    };
  }, [applyDashboard]);
  useEffect(() => () => {
    for (const pending of pendingCompletions.current.values()) window.clearTimeout(pending.timer);
    pendingCompletions.current.clear();
  }, []);
  useEffect(() => {
    if (!data) return;
    const next = new Map<string, AgentState>();
    const observed = new Set<string>();
    for (const agent of data.agents) {
      const state = agentState(agent);
      const previous = agentStates.current.get(agent.id);
      const tag = agentNotificationTag(agent);
      const names = agentNotificationNames(agent, data.projects);
      const focused = viewedAgentId.current === agent.id && pageFocused();
      const hasQueuedPrompt = agent.queuedPromptCount > 0;
      observed.add(agent.id);
      const pendingCompletion = pendingCompletions.current.get(agent.id);
      // cancel intermediate queue completions
      if ((state !== 'prompt-done' || hasQueuedPrompt) && pendingCompletion !== undefined) {
        window.clearTimeout(pendingCompletion.timer);
        pendingCompletions.current.delete(agent.id);
      }
      if (previous !== undefined && previous !== 'action-required' && state === 'action-required') {
        const body = agent.question === undefined
          ? `${names.worktreeName}: has a question`
          : `${names.multipleWorktrees ? `${names.worktreeName}: ` : ''}${agent.question.text}`;
        if (focused) dismissAgentNotifications(agent);
        else void showNotification('question', `Question in ${names.projectName}`, body, tag, `/#agent=${encodeURIComponent(agent.id)}`, agent.worktreeId);
      }
      if (previous === 'working' && state === 'prompt-done' && !hasQueuedPrompt) {
        const delay = 2_000;
        const timer = window.setTimeout(() => void refresh(), delay);
        pendingCompletions.current.set(agent.id, { due: Date.now() + delay, timer });
      } else if (state === 'prompt-done' && !hasQueuedPrompt && pendingCompletion !== undefined && Date.now() >= pendingCompletion.due) {
        window.clearTimeout(pendingCompletion.timer);
        pendingCompletions.current.delete(agent.id);
        void showNotification('finished', `Done working in ${names.projectName}`, `${names.worktreeName} is ready for a new prompt`, tag, `/#agent=${encodeURIComponent(agent.id)}`, agent.worktreeId);
      }
      // clear question notifications on every resolved presentation transition
      if (previous === 'action-required' && state !== 'action-required') void dismissNotification(tag);
      next.set(agent.id, state);
    }
    for (const [agentId, pending] of pendingCompletions.current) {
      if (observed.has(agentId)) continue;
      window.clearTimeout(pending.timer);
      pendingCompletions.current.delete(agentId);
    }
    agentStates.current = next;
  }, [data, viewAgent]);
  const worktrees = data === undefined ? [] : allWorktrees(data);
  // a Place tab shows and orders by its Worktree (the server no longer stamps the label/order on
  // the agent); a directory-Project or Scratch Place, and an Agent placed nowhere, sort last
  const worktreeLabelById = new Map(worktrees.map(worktree => [worktree.id, worktree.label] as const));
  const items: DashboardItem[] = [];
  if (data !== undefined) {
    // one tab per Place, however many Agents run there, in discovery order within the Place
    const agentsByPlace = new Map<string, Agent[]>();
    for (const agent of data.agents) {
      if (isEmbeddedUpdateAdvisor(agent)) continue;
      const key = agentItemKey(agent);
      agentsByPlace.set(key, [...(agentsByPlace.get(key) ?? []), agent]);
    }
    for (const [key, agents] of agentsByPlace) {
      const first = agents[0]!;
      const placeId = agentPlaceId(first);
      const worktree = placeId === undefined ? undefined : worktrees.find(candidate => candidate.id === placeId);
      const place = worktree !== undefined || placeId === undefined ? undefined : data.places?.find(candidate => candidate.id === placeId);
      const order = worktree?.order ?? first.worktreeOrder ?? Number.MAX_SAFE_INTEGER;
      const label = worktree?.label ?? place?.label ?? first.worktreeLabel ?? agentLabel(first);
      const operation = agents.map(agentPendingOperation).find(candidate => candidate !== undefined);
      items.push({ key, label, ...placeTabState(agents), order, operation, agents, placeId, worktree, place });
    }
    for (const worktree of worktrees) {
      // a Worktree with a live agent is already its Place's tab
      if (agentsByPlace.has(placeItemKey(worktree.id))) continue;
      const draftId = worktreePromptId(worktree.id);
      // retain pinned, pending and prepared idle tabs, and any Worktree that still has an
      // open Console shell so stopping the Agent never hides the operator's terminals
      const kept = worktree.pinned || (worktree.consoleShells ?? 0) > 0 || pendingNewTaskSources.has(worktree.id) || pendingWorktreeLaunches.has(worktree.id) || Boolean(getPromptDraft(draftId)) || promptAttachments.has(draftId);
      if (!kept && !openedPlaces.has(worktree.id)) continue;
      items.push({ key: placeItemKey(worktree.id), label: worktree.label, state: 'closed', order: worktree.order, unread: false, operation: worktreePendingOperation(worktree), agents: [], placeId: worktree.id, worktree, transient: !kept });
    }
    // a directory-Project or Scratch Place with no Agent there keeps a tab while it is pinned or
    // holds a Console shell, so turning its Agent off never hides the operator's terminals
    for (const place of data.places ?? []) {
      if (agentsByPlace.has(placeItemKey(place.id))) continue;
      const kept = place.pinned || (place.consoleShells ?? 0) > 0;
      if (!kept && !openedPlaces.has(place.id)) continue;
      items.push({ key: placeItemKey(place.id), label: place.label, state: 'closed', order: Number.MAX_SAFE_INTEGER, unread: false, agents: [], placeId: place.id, place, transient: !kept });
    }
    for (const pendingLaunch of pendingSessionLaunches) items.push({ key: `pending-${pendingLaunch.id}`, label: pendingLaunch.label, state: 'closed', order: Number.MAX_SAFE_INTEGER, unread: false, operation: pendingLaunch.phase === 'failed' ? undefined : 'launching', agents: [], pendingLaunch });
    // preserve server-owned worktree names and apply client-local aliases elsewhere
    for (const entry of items) {
      const alias = entry.worktree === undefined ? workspaceAlias(entry.key) : null;
      if (alias !== null) entry.label = alias;
    }
    items.sort((left, right) => left.order - right.order);
  }
  // the Agent a Place tab's switcher shows
  const currentAgentOf = (entry: DashboardItem | undefined): Agent | undefined => entry === undefined ? undefined : entry.agents.find(agent => agent.id === agentChoice[entry.key]) ?? entry.agents[0];
  const tabKey = items.map(item => item.key).join('\u0000');
  const selectedIndex = selectedItemKey.current === undefined ? -1 : items.findIndex(candidate => candidate.key === selectedItemKey.current);
  const visibleActive = selectedIndex >= 0 ? selectedIndex : Math.min(active, Math.max(items.length - 1, 0));
  const activeItemKey = items[visibleActive]?.key;
  // establish the first visible selection
  if (selectedItemKey.current === undefined) selectedItemKey.current = activeItemKey;
  viewedAgentId.current = currentAgentOf(items[visibleActive])?.id;
  // keep numeric tab state aligned without rendering a different key between snapshots
  useLayoutEffect(() => {
    // adopt the fallback only after a selected item disappears
    if (selectedIndex < 0) selectedItemKey.current = activeItemKey;
    setActive(current => current === visibleActive ? current : visibleActive);
  }, [activeItemKey, selectedIndex, tabKey, visibleActive]);
  // when the switcher's Agent goes (turned off) and the panel falls back to a sibling, the
  // operator is now looking at the sibling's output: mark it read, as choosing it would
  const shownAgentId = viewedAgentId.current;
  const lastShown = useRef<{ key?: string; agentId?: string }>({});
  useEffect(() => {
    const previous = lastShown.current;
    lastShown.current = { key: activeItemKey, agentId: shownAgentId };
    const agents = items[visibleActive]?.agents ?? [];
    if (previous.key !== activeItemKey || previous.agentId === undefined || previous.agentId === shownAgentId || agents.some(agent => agent.id === previous.agentId)) return;
    const shown = agents.find(agent => agent.id === shownAgentId);
    if (shown !== undefined) viewAgent(shown);
  }, [activeItemKey, shownAgentId]);
  // a Place opened from + closes once the operator leaves its tab; a pin, shell or Agent there
  // keeps it by the usual rules instead
  const previousActiveKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const left = previousActiveKey.current;
    previousActiveKey.current = activeItemKey;
    if (left === undefined || left === activeItemKey) return;
    setOpenedPlaces(current => {
      const placeId = [...current].find(candidate => placeItemKey(candidate) === left);
      if (placeId === undefined) return current;
      const next = new Set(current);
      next.delete(placeId);
      return next;
    });
  }, [activeItemKey]);
  // forget the switcher choice of a tab that has gone, so the record stays bounded by the tabs
  useEffect(() => {
    const keys = new Set(tabKey.split('\u0000'));
    setAgentChoice(current => Object.keys(current).every(key => keys.has(key)) ? current : Object.fromEntries(Object.entries(current).filter(([key]) => keys.has(key))));
  }, [tabKey]);
  useEffect(() => {
    // activate initial and same-document links
    const activateLinkedItem = () => {
      const hash = location.hash;
      const separator = hash.indexOf('=');
      const kind = hash.slice(1, separator);
      let target = '';
      try { target = decodeURIComponent(hash.slice(separator + 1)); } catch { /* retain the current tab */ }
      let linked = -1;
      let linkedAgentId: string | undefined;
      // resolve each supported dashboard destination explicitly
      switch (kind) {
        case 'worktree':
          linked = items.findIndex(item => item.placeId === target);
          break;
        case 'agent':
          // an Agent opens its Place's tab with the Agent chosen in the switcher
          linked = items.findIndex(item => item.agents.some(agent => agent.id === target));
          if (linked >= 0) linkedAgentId = target;
          break;
        case 'launch':
          linked = items.findIndex(item => item.pendingLaunch?.id === target);
          break;
        case 'tab':
          linked = items.findIndex(item => item.label === target);
          break;
      }
      // ignore unavailable destinations
      if (linked < 0) return;
      const linkedItem = items[linked]!;
      // keep linked navigation aligned with the stable selection key
      selectedItemKey.current = linkedItem.key;
      if (linkedAgentId !== undefined) chooseAgent(linkedItem.key, linkedAgentId);
      setActive(linked);
      // clear the selected notification state
      const viewed = linkedItem.agents.find(agent => agent.id === linkedAgentId) ?? currentAgentOf(linkedItem);
      if (viewed !== undefined) viewAgent(viewed);
    };
    activateLinkedItem();
    window.addEventListener('hashchange', activateLinkedItem);
    return () => window.removeEventListener('hashchange', activateLinkedItem);
  }, [tabKey, viewAgent]);
  // select a stable dashboard item (and, given `agentId`, that Agent in its switcher) and publish
  // its deep link
  const select = (index: number, agentId?: string) => {
    const item = items[index];
    // ignore stale navigation indices
    if (!item) return;
    const previousAgent = selectedItemKey.current === item.key ? currentAgentOf(item) : undefined;
    selectedItemKey.current = item.key;
    const chosen = item.agents.find(agent => agent.id === agentId);
    // explicit agent navigation restores a previously minimized output
    if (chosen !== undefined) { chooseAgent(item.key, chosen.id); setAgentSplitHidden(item.key, false); }
    const agent = chosen ?? currentAgentOf(item);
    // mark newly viewed agent output as read
    if (agent !== undefined && agent.id !== previousAgent?.id) viewAgent(agent);
    let target = `tab=${encodeURIComponent(item.label)}`;
    // keep pending launches distinct from same-label sessions
    if (item.pendingLaunch !== undefined) target = `launch=${encodeURIComponent(item.pendingLaunch.id)}`;
    // use the exact identity once discovery completes
    else if (agent !== undefined) target = `agent=${encodeURIComponent(agent.id)}`;
    history.replaceState(null, '', `${location.pathname}${location.search}#${target}`);
    setActive(index);
  };
  // select one canonical worktree from voice
  const selectVoiceWorktree = (worktreeId: string) => {
    const index = items.findIndex(candidate => candidate.placeId === worktreeId);
    // reject worktrees without a visible tab
    if (index < 0) return undefined;
    const selected = items[index];
    // retain the canonical dashboard label
    if (selected === undefined) return undefined;
    select(index);
    return { worktreeId, worktreeLabel: selected.worktree?.label ?? selected.label };
  };
  useWorkspaceCycleKeys(visibleActive, items.length, select);
  // the keyboard's Workspace and panel actions act on the Workspace in view
  const [keyPicker, setKeyPicker] = useState<'tree' | 'workspace'>();
  const workspaceHistory = useRef<{ current?: string; previous?: string }>({});
  useEffect(() => {
    if (activeItemKey !== workspaceHistory.current.current) workspaceHistory.current = { current: activeItemKey, previous: workspaceHistory.current.current };
  }, [activeItemKey]);
  // the handlers run after this render, so the helpers declared below it are initialized by then;
  // only the loading screen's render returns before them, and it has no Workspace to act on
  const activeEntry = () => data === undefined ? undefined : items[visibleActive];
  // run `act` on the mounted Workspace in view, with its panels and the current one
  const onPanels = (act: (view: WorkspaceView, panels: string[], current: string | undefined) => boolean | void) => () => {
    const entry = activeEntry();
    const view = entry === undefined ? undefined : workspaceViews.get(entry.key);
    if (view === undefined) return false;
    return act(view, view.splits.map(split => split.key), view.currentPanel());
  };
  const stepPanel = (step: -1 | 1, wrap: boolean) => onPanels((view, panels, current) => {
    const index = panels.indexOf(current ?? '');
    const next = wrap ? panels[(index + step + panels.length) % panels.length] : panels[index + step];
    if (next !== undefined) view.jump(next, true);
  });
  useKeyActions({
    'new-terminal': onPanels(view => view.openTerminal()),
    // the split is columns only, so beside and below both open a Terminal panel
    'split-beside': onPanels(view => view.openTerminal()),
    'split-below': onPanels(view => view.openTerminal()),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`select-panel-${index + 1}`, onPanels((view, panels) => { if (panels[index] !== undefined) view.jump(panels[index], true); })])),
    'next-panel': stepPanel(1, true),
    'previous-panel': stepPanel(-1, true),
    'select-panel-right': stepPanel(1, false),
    'select-panel-left': stepPanel(-1, false),
    'last-panel': onPanels(view => { const last = view.lastPanel(); if (last !== undefined) view.jump(last, true); }),
    'toggle-expand': onPanels((view, _panels, current) => { if (current !== undefined) view.toggleExpand(current); }),
    'toggle-code': onPanels(view => { if (view.toggleCode === undefined) return false; view.toggleCode(); }),
    'rename-panel': onPanels((view, _panels, current) => { if (current !== undefined) view.renamePanel(current); }),
    'close-panel': onPanels((view, _panels, current) => {
      const split = view.splits.find(candidate => candidate.key === current);
      // settings owns its dirty-aware confirmation instead of the generic key prompt
      if (split?.key === 'settings') { view.closePanel(split.key); return; }
      if (split !== undefined) confirmKey(`Close ${split.label}?`, () => view.closePanel(split.key));
    }),
    [terminalBindingAction]: (_event, context) => context === undefined ? false : onPanels(view => view.openTerminal({ table: context.table, key: context.chord }))(),
    'last-workspace': () => {
      const index = items.findIndex(entry => entry.key === workspaceHistory.current.previous);
      if (index < 0) return false;
      select(index);
    },
    'choose-tree': () => { if (activeEntry() === undefined) return false; setKeyPicker('tree'); },
    'choose-workspace': () => { if (activeEntry() === undefined) return false; setKeyPicker('workspace'); },
    'rename-workspace': () => { const entry = activeEntry(); if (entry === undefined) return false; renameWorkspaceEntry(entry); },
    'close-workspace': () => {
      const entry = activeEntry();
      if (entry === undefined) return false;
      confirmKey(`Turn off ${entry.label}?`, () => void turnOffWorkspace(entry));
    }
  });
  useEffect(() => {
    if (activateAgentId === undefined) return;
    const index = items.findIndex(candidate => candidate.agents.some(agent => agent.id === activateAgentId));
    if (index < 0) return;
    select(index, activateAgentId);
    setActivateAgentId(undefined);
  }, [activateAgentId, data]);
  // activate one newly opened worktree tab
  useEffect(() => {
    // wait for the pending tab
    if (activateWorktreeId === undefined) return;
    const index = items.findIndex(candidate => candidate.placeId === activateWorktreeId);
    // wait for the matching item
    if (index < 0) return;
    select(index);
    setActivateWorktreeId(undefined);
  }, [activateWorktreeId, tabKey]);
  // activate one scratch or directory launch placeholder
  useEffect(() => {
    // wait for the pending launch item
    if (activatePendingSessionId === undefined) return;
    const index = items.findIndex(candidate => candidate.pendingLaunch?.id === activatePendingSessionId);
    // wait for the matching placeholder
    if (index < 0) return;
    select(index);
    setActivatePendingSessionId(undefined);
  }, [activatePendingSessionId, tabKey]);
  // discard only a failed local launch and its prepared input
  const discardPendingSessionLaunch = (launchId: string) => {
    const launch = pendingSessionLaunchesRef.current.find(candidate => candidate.id === launchId);
    // successful launches remain available for exact-agent handoff
    if (launch?.phase !== 'failed') return;
    const hasDraft = Boolean(getPromptDraft(launch.draftId)) || promptAttachments.has(launch.draftId);
    // confirm before losing prepared text or files
    if (hasDraft && !window.confirm('Discard this failed launch and its prepared prompt and attachments?')) return;
    // release any remaining confirmation timer
    if (launch.confirmationTimer !== undefined) window.clearTimeout(launch.confirmationTimer);
    promptAttachments.delete(launch.draftId);
    promptHandoffFocus.delete(launch.draftId);
    promptDrafts.delete(launch.draftId);
    savePromptDraft(launch.draftId, '');
    updatePendingSessionLaunches(current => current.filter(candidate => candidate.id !== launchId));
    // clear only notices and activation owned by this failed launch
    setActivatePendingSessionId(current => current === launchId ? undefined : current);
    setLaunchErrorMessage(current => current === launch.error ? '' : current);
    setOperationFeedback(current => current?.tone === 'error' && current.detail === launch.error ? undefined : current);
    // preserve a different active tab
    if (selectedItemKey.current !== `pending-${launchId}`) return;
    const nextIndex = items.findIndex(candidate => candidate.key !== `pending-${launchId}`);
    // move the selection and hash to a remaining session
    if (nextIndex >= 0) select(nextIndex);
    else {
      selectedItemKey.current = undefined;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      setActive(0);
    }
  };
  // wait for dashboard discovery after one scratch-like launch returns
  const launched = (agentId: string, launchId: string) => {
    setLaunchErrorMessage('');
    const confirmationTimer = window.setTimeout(() => {
      const pendingLaunch = pendingSessionLaunchesRef.current.find(launch => launch.id === launchId);
      // ignore replaced or dashboard-confirmed sessions
      if (!dashboardMounted.current || pendingLaunch?.agentId !== agentId) return;
      const message = `${pendingLaunch.label} started, but connecting is taking longer than expected. Your prepared prompt will remain here until the agent appears.`;
      // retain the successful identity without offering a duplicate launch
      updatePendingSessionLaunches(current => current.map(launch => launch.id === launchId ? { ...launch, phase: 'delayed', error: message, confirmationTimer: undefined } : launch));
      void refresh();
    }, worktreeLaunchConfirmationMs);
    // retain the prepared composer until the exact agent appears
    updatePendingSessionLaunches(current => current.map(launch => launch.id === launchId ? { ...launch, phase: 'confirming', agentId, error: undefined, confirmationTimer } : launch));
    const snapshot = dashboardSnapshot.current;
    // reconcile an agent already discovered while its launch response was pending
    if (snapshot?.agents.some(agent => agent.id === agentId)) applyDashboard(snapshot);
    void refresh();
  };
  // complete one dashboard-confirmed place launch
  const worktreeLaunched = (agentId: string, worktree: Pick<Worktree, 'id' | 'label'>, operationKey: string) => {
    // ignore callbacks after dashboard teardown
    if (!dashboardMounted.current) return false;
    setLaunchErrorMessage('');
    const visible = dashboardSnapshot.current?.agents.some(agent => agent.id === agentId && agentPlaceId(agent) === worktree.id) === true;
    const existing = pendingWorktreeLaunches.get(worktree.id);
    // replace one prior confirmation timer
    if (existing?.confirmationTimer !== undefined) window.clearTimeout(existing.confirmationTimer);
    // retain the placeholder through dashboard propagation
    if (!visible) {
      const confirmationTimer = window.setTimeout(() => {
        const pendingLaunch = pendingWorktreeLaunches.get(worktree.id);
        // ignore replaced or completed handoffs
        if (!dashboardMounted.current || pendingLaunch?.agentId !== agentId) return;
        pendingWorktreeLaunches.delete(worktree.id);
        setPendingOperation(operationKey, false);
        const detail = `${worktree.label} started, but its agent did not remain discoverable. Try again.`;
        setLaunchErrorMessage(detail);
        showOperationFeedback({ tone: 'error', message: `${worktree.label} did not finish starting`, detail, worktreeId: worktree.id });
        void refresh();
      }, worktreeLaunchConfirmationMs);
      pendingWorktreeLaunches.set(worktree.id, { ...(existing ?? {}), operationKey, agentId, confirmationTimer });
    }
    else {
      pendingWorktreeLaunches.delete(worktree.id);
      setPendingOperation(operationKey, false);
      // preserve newer navigation choices
      if (selectedItemKey.current === placeItemKey(worktree.id)) setActivateAgentId(agentId);
    }
    void refresh();
    return true;
  };
  // execute one scratch-like launch while preserving its local composer
  const runPendingSessionLaunch = async (launch: PendingSessionLaunch, choice?: LaunchChoice) => {
    // never relaunch a session awaiting discovery
    if (creatingAgent || launch.agentId !== undefined) return;
    // keep every rejected launch on the same draft-preserving failure path
    const failLaunch = (message: string, headline: string) => {
      setLaunchErrorMessage(message);
      updatePendingSessionLaunches(current => current.map(candidate => candidate.id === launch.id ? { ...candidate, phase: 'failed', error: message } : candidate));
      showOperationFeedback({ tone: 'error', message: headline, detail: message });
    };
    const place = data?.places?.find(candidate => launch.scope === 'scratch' ? candidate.kind === 'scratch' && candidate.adhoc !== true : candidate.kind === 'directory' && candidate.projectId === launch.projectId);
    const operationKey = `session-launch:${launch.id}`;
    // keep scratch and directory launches out of workspace shutdowns
    if (!beginPendingOperation(operationKey, place === undefined ? `pending-${launch.id}` : placeItemKey(place.id))) return failLaunch('This workspace is busy. Try again after its current operation finishes.', `${launch.label} could not start`);
    const selectedChoice = choice ?? launch.choice;
    setLaunchErrorMessage('');
    closeLauncher();
    setCreatingAgent(true);
    updatePendingSessionLaunches(current => current.map(candidate => candidate.id === launch.id ? { ...candidate, phase: 'launching', choice: selectedChoice, kind: selectedChoice?.kind ?? candidate.resolution?.kind, sandboxed: selectedChoice?.sandboxed, agentId: undefined, error: undefined, confirmationTimer: undefined } : candidate));
    showOperationFeedback({ tone: 'pending', message: `Starting ${launch.label}…`, detail: launch.scope === 'scratch' ? 'Creating a new temporary session and waiting for it to become ready.' : 'Creating a new session in the project directory and waiting for it to become ready.' });
    try {
      const endpoint = launch.scope === 'scratch' ? '/api/agents/launch' : `/api/projects/${encodeURIComponent(launch.projectId)}/launch`;
      const response = await request(endpoint, selectedChoice === undefined ? { method: 'POST' } : launchRequestInit(selectedChoice));
      // preserve the prepared draft after a rejected start
      if (!response.ok) {
        const message = await launchError(response);
        return failLaunch(message, `${launch.label} could not start`);
      }
      const payload = await response.json() as { agentId?: unknown };
      // require one exact handoff identity
      if (typeof payload.agentId !== 'string') {
        const message = 'The agent started but could not be opened.';
        return failLaunch(message, `${launch.label} could not be opened`);
      }
      launched(payload.agentId, launch.id);
      showOperationFeedback({ tone: 'success', message: `${launch.label} is starting`, detail: 'The new session is ready and its output is connecting.' });
    } catch {
      const message = 'Unable to reach the console while launching the agent.';
      failLaunch(message, `${launch.label} could not start`);
    }
    finally { setPendingOperation(operationKey, false); setCreatingAgent(false); }
  };
  // expose one local scratch composer before its launch request begins
  const createAgent = (choice?: LaunchChoice) => {
    if (creatingAgent) return;
    pendingSessionLaunchSequence.current += 1;
    const id = `session-${Date.now()}-${pendingSessionLaunchSequence.current}`;
    const launch: PendingSessionLaunch = { id, draftId: `pending-launch:${id}`, label: 'Scratch', scope: 'scratch', resolution: data?.scratchLaunch, choice, kind: choice?.kind ?? data?.scratchLaunch?.kind, sandboxed: choice?.sandboxed, phase: 'launching' };
    updatePendingSessionLaunches(current => [...current, launch]);
    selectedItemKey.current = `pending-${id}`;
    setActivatePendingSessionId(id);
    void runPendingSessionLaunch(launch, choice);
  };
  // expose one local directory composer before its launch request begins
  const launchProjectDirectory = (project: Project, choice?: LaunchChoice) => {
    if (creatingAgent) return;
    pendingSessionLaunchSequence.current += 1;
    const id = `session-${Date.now()}-${pendingSessionLaunchSequence.current}`;
    const launch: PendingSessionLaunch = { id, draftId: `pending-launch:${id}`, label: project.label, scope: 'directory', projectId: project.id, resolution: project.launch, choice, kind: choice?.kind ?? project.launch?.kind, sandboxed: choice?.sandboxed, phase: 'launching' };
    updatePendingSessionLaunches(current => [...current, launch]);
    selectedItemKey.current = `pending-${id}`;
    setActivatePendingSessionId(id);
    void runPendingSessionLaunch(launch, choice);
  };
  useLayoutEffect(() => {
    // compare rendered rows across positioned and static tab controls
    const measure = () => {
      const tabs = tabsRef.current; const plus = plusRef.current;
      if (!tabs || !plus) return;
      const siblings = Array.from(tabs.children).filter(node => !node.contains(plus) && !(node as HTMLElement).classList.contains('tab-spacer')) as HTMLElement[];
      const plusTop = plus.getBoundingClientRect().top;
      setPlusAlone(!siblings.some(node => Math.abs(node.getBoundingClientRect().top - plusTop) < 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (tabsRef.current) observer.observe(tabsRef.current);
    return () => observer.disconnect();
  }, [items.length, launcherOpen, activeItemKey]);
  // an agentless Place tab launches like its launcher row: the directory Project in place, or the
  // configured Scratch folder; an ad-hoc Scratch folder has no launch
  const placeLaunch = (place: Place): PlaceLaunch | undefined => {
    if (place.kind === 'scratch') return place.adhoc === true ? undefined : { resolution: data?.scratchLaunch, endpoint: '/api/agents/launch', start: choice => createAgent(choice) };
    const project = data?.projects.find(candidate => candidate.id === place.projectId);
    return project === undefined ? undefined : { resolution: project.launch, endpoint: `/api/projects/${encodeURIComponent(project.id)}/launch`, start: choice => launchProjectDirectory(project, choice) };
  };
  // Launch another Agent at a Place that already has one, from its toolbar. It joins the Place's
  // session; the running Agents stay in view until the server reports it discovered, and then the
  // switcher shows it (the tab too, unless the operator has moved on).
  const launchAnother = async ({ key, label, endpoint, worktreeId }: { key: string; label: string; endpoint: string; worktreeId?: string }, choice?: LaunchChoice) => {
    const operationKey = `launch-another:${key}`;
    // keep launch and workspace shutdown mutually exclusive
    if (launchingAnotherAt !== undefined || !beginPendingOperation(operationKey, key)) return;
    let handedOff = false;
    setLaunchingAnotherAt(key);
    showOperationFeedback({ tone: 'pending', message: `Starting another agent at ${label}…`, detail: 'The running agents stay open while the new one starts.', worktreeId });
    try {
      const response = await request(endpoint, choice === undefined ? { method: 'POST' } : launchRequestInit(choice));
      if (!response.ok) return showOperationFeedback({ tone: 'error', message: `${label} could not start another agent`, detail: await launchError(response), worktreeId });
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') return showOperationFeedback({ tone: 'error', message: `${label} could not open the new agent`, detail: 'The agent started but could not be opened.', worktreeId });
      const agentId = payload.agentId;
      chooseAgent(key, agentId);
      if (selectedItemKey.current === key) setActivateAgentId(agentId);
      // keep discovered place launches locked through dashboard propagation
      if (key.startsWith('place-')) {
        handedOff = worktreeLaunched(agentId, { id: key.slice('place-'.length), label }, operationKey);
      }
      showOperationFeedback({ tone: 'success', message: `${label} started another agent`, detail: 'The new agent session is ready and its output is connecting.', worktreeId });
      await refresh();
    } catch {
      showOperationFeedback({ tone: 'error', message: `${label} could not start another agent`, detail: 'Unable to reach the console while launching the agent.', worktreeId });
    } finally {
      // release only launches without a pending discovery handoff
      if (!handedOff) setPendingOperation(operationKey, false);
      if (dashboardMounted.current) setLaunchingAnotherAt(undefined);
    }
  };
  // start from the launcher
  const launchWorktree = async (worktree: Worktree, choice?: LaunchChoice) => {
    const key = launchOperationKey(worktree.id);
    // prevent duplicate worktree launches
    if (!beginPendingOperation(key, placeItemKey(worktree.id))) return;
    const kind = choice?.kind ?? worktree.launch?.kind;
    pendingWorktreeLaunches.set(worktree.id, { operationKey: key, ...(kind === undefined ? {} : { kind }) });
    let handedOff = false;
    closeLauncher();
    setActivateWorktreeId(worktree.id);
    setLaunchErrorMessage('');
    showOperationFeedback({ tone: 'pending', message: `Starting ${worktree.label}…`, detail: worktreeLaunchPendingDetail(kind), worktreeId: worktree.id });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, choice === undefined ? { method: 'POST' } : launchRequestInit(choice));
      // surface failed starts
      if (!response.ok) {
        const message = await launchError(response);
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message, worktreeId: worktree.id });
      }
      const payload = await response.json() as { agentId?: unknown };
      // require the discovered replacement agent
      if (typeof payload.agentId !== 'string') {
        const message = 'The agent started but could not be opened.';
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: `${worktree.label} could not be opened`, detail: message, worktreeId: worktree.id });
      }
      worktreeLaunched(payload.agentId, worktree, key);
      handedOff = true;
      showOperationFeedback({ tone: 'success', message: `${worktree.label} started`, detail: 'The new agent session is ready and its output is connecting.', worktreeId: worktree.id });
    } catch {
      const message = 'Unable to reach the console while launching the agent.';
      setLaunchErrorMessage(message);
      showOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message, worktreeId: worktree.id });
    } finally {
      // preserve successful handoffs until dashboard confirmation
      if (!handedOff) {
        pendingWorktreeLaunches.delete(worktree.id);
        setPendingOperation(key, false);
      }
    }
  };
  const selectTarget = (target: DashboardTarget) => {
    const index = items.findIndex(candidate => (target.agentId !== undefined && candidate.agents.some(agent => agent.id === target.agentId)) || candidate.placeId === target.worktreeId);
    if (index >= 0) return select(index, target.agentId);
    const worktree = worktrees.find(candidate => candidate.id === target.worktreeId);
    if (worktree !== undefined) void launchWorktree(worktree);
  };
  // move to one Worktree's tab, deferring until a pending resume/launch has made it a tab — a
  // conversation resume already drives the handoff, so this never starts a fresh agent the way
  // selectTarget's PR-switch fallback does
  const navigateToWorktree = (worktreeId: string) => {
    const index = items.findIndex(candidate => candidate.placeId === worktreeId);
    if (index >= 0) return select(index);
    setActivateWorktreeId(worktreeId);
  };
  // pin or unpin one Place (a Worktree, directory Project or Scratch folder) so it keeps (or
  // drops) its tab while no Agent runs there
  const togglePin = async (place: Pick<Place, 'id' | 'pinned'>) => {
    const response = await request(`/api/worktrees/${encodeURIComponent(place.id)}/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: !place.pinned }) }).catch(() => undefined);
    if (response?.ok) await refresh();
  };
  // open a Place's Workspace from +: its tab stays while the operator is there, and is selected
  const openPlace = (placeId: string) => {
    closeLauncher();
    setOpenedPlaces(current => current.has(placeId) ? current : new Set(current).add(placeId));
    navigateToWorktree(placeId);
  };
  // a Process notice's Open: that Worktree's tab (a transient one when it has none), with its
  // stack menu open
  const openWorktreeStack = (worktreeId: string) => {
    requestStackMenu(worktreeId);
    openPlace(worktreeId);
  };
  // the tab standing for a Place: its own, or a Scratch or directory launch there not yet discovered
  const placeTabIndex = (placeId: string): number => {
    const place = data?.places?.find(candidate => candidate.id === placeId && candidate.adhoc !== true);
    return items.findIndex(candidate => candidate.placeId === placeId || (place !== undefined && candidate.pendingLaunch !== undefined
      && (candidate.pendingLaunch.scope === 'scratch' ? place.kind === 'scratch' : place.kind === 'directory' && candidate.pendingLaunch.projectId === place.projectId)));
  };
  // Empty workspace from +: focus the Place's Workspace when it has one, else open it with no panels
  const openEmptyWorkspace = (placeId: string) => {
    const index = placeTabIndex(placeId);
    if (index >= 0) {
      closeLauncher();
      return select(index);
    }
    forgetOpenPanels(placeId);
    openPlace(placeId);
  };
  // Terminal from +: open the Place's Workspace with one of its Console shells as a focused
  // Terminal panel (one already open here first), creating a shell only when the Place has none
  const openTerminalAt = async (placeId: string, label: string) => {
    if (terminalOpening.current.has(placeId)) return;
    terminalOpening.current.add(placeId);
    openPlace(placeId);
    const fail = (detail: string) => showOperationFeedback({ tone: 'error', message: `Could not open a terminal at ${label}`, detail, worktreeId: placeId });
    try {
      const panes = await listPlacePanes(placeId);
      if (panes === undefined) return fail('Unable to list the terminals there.');
      const open = new Set(savedTerminals(placeId).map(terminal => terminal.paneId));
      const shells = panes.filter(isConsoleShell);
      let shell: WorktreePane | undefined = shells.find(pane => open.has(pane.paneId)) ?? shells[0];
      let paneId = shell?.paneId;
      if (paneId === undefined) {
        const created = await createPlaceShell(placeId);
        if (!('paneId' in created)) return fail(created.error);
        paneId = created.paneId;
        shell = (await listPlacePanes(placeId))?.find(pane => pane.paneId === paneId);
      }
      requestTerminalFocus(placeId, { paneId, name: shell === undefined ? 'shell' : terminalPaneLabel(shell) });
      void refresh();
    } finally { terminalOpening.current.delete(placeId); }
  };
  // the guided review's jump to a line: open the editor in the Place, beside the review's panel
  const openEditorAt = async (placeId: string, target: EditorTarget) => {
    openPlace(placeId);
    const failure = await openEditorShell(placeId, target);
    if (failure !== undefined) showOperationFeedback({ tone: 'error', message: 'The editor did not open', detail: failure, worktreeId: placeId });
    void refresh();
  };
  // a worktree just created from the launcher: close everything, refresh, and select its
  // new tab (its agent when one launched, else the idle worktree)
  const worktreeCreated = async (result: WorktreeCreated) => {
    setNewWorktreeProjectId(undefined);
    closeLauncher();
    await refresh();
    if (result.agentId !== undefined) setActivateAgentId(result.agentId);
    else setActivateWorktreeId(result.worktreeId);
    // a failed setup gates the launch, so it is the reason no agent started — report it first
    if (result.setupError !== undefined) showOperationFeedback({ tone: 'error', message: 'Worktree created, setup failed', detail: result.setupError });
    else if (result.launchError !== undefined) showOperationFeedback({ tone: 'error', message: 'Worktree created, agent did not start', detail: result.launchError });
    else showOperationFeedback({ tone: 'success', message: 'Worktree created', detail: result.agentId === undefined ? 'The new worktree is ready.' : 'The new agent session is ready and its output is connecting.' });
  };
  // a worktree just removed from a tab or the launcher: close everything and refresh
  const worktreeRemoved = async (message: string) => {
    setRemoveWorktreeId(undefined);
    closeLauncher();
    await refresh();
    showOperationFeedback({ tone: 'success', message: 'Worktree removed', detail: message });
  };
  // stale checkouts and records just pruned for one Project
  const worktreesPruned = async () => {
    setPruneProjectId(undefined);
    closeLauncher();
    await refresh();
    showOperationFeedback({ tone: 'success', message: 'Worktrees pruned', detail: 'Stale checkouts and orphaned records were cleared.' });
  };
  // start a tour from the start sheet, replacing any review held for another Worktree
  const launchReview = (launch: ReviewLaunch) => {
    setReviewStart(undefined);
    setReviewIndicator({ generating: true, stale: false });
    setReviewInitialTour(undefined);
    setReviewInitialCodeReview({});
    setReviewStarts(count => count + 1);
    setReviewLaunch(launch);
    setReviewMinimized(true);
  };
  // close the start sheet, handing focus back to the Git status control it came from
  const cancelReviewStart = () => {
    setReviewStart(undefined);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.workspace-toolbar-actions .git-status-summary')?.focus());
  };
  // restore one durable review without starting generation
  const openStoredReview = async (agent: Agent, stored: StoredReviewSummary) => {
    // prevent duplicate restore requests
    if (reviewRestoringWorktreeId !== undefined) return;
    void dismissNotification(reviewNotificationTag(stored.worktreeId));
    setReviewRestoringWorktreeId(stored.worktreeId);
    setReviewIndicator({ generating: true, stale: false });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(stored.worktreeId)}/review-tour`);
      const payload: unknown = await response.json().catch(() => undefined);
      const review = payload !== null && typeof payload === 'object' && (payload as { review?: unknown }).review !== null && typeof (payload as { review?: unknown }).review === 'object' ? (payload as { review: { worktreeId?: unknown; branch?: unknown; tour?: unknown; codeReview?: unknown; codeReviewJob?: unknown } }).review : undefined;
      // require the dashboard-bound worktree and branch
      if (!response.ok || review?.worktreeId !== stored.worktreeId || review.branch !== stored.branch || !isReviewTour(review.tour)) throw new Error('invalid stored review');
      setReviewInitialTour(review.tour);
      // resume the stored Code review, or poll the job still running one
      const storedCodeReview = codeReviewFrom(review.codeReview);
      setReviewInitialCodeReview({ ...(storedCodeReview === undefined ? {} : { review: storedCodeReview }), ...(isCodeReviewJob(review.codeReviewJob) ? { job: review.codeReviewJob } : {}) });
      setReviewLaunch({ agentId: agent.id, worktreeId: stored.worktreeId, scope: review.tour.scope, ...(review.tour.commit === undefined ? {} : { commit: review.tour.commit }), includeTests: review.tour.includeTests, includeDocs: review.tour.includeDocs });
      setReviewIndicator({ generating: false, stale: false });
      setReviewMinimized(false);
    } catch {
      setReviewIndicator({ generating: false, stale: false });
      await refresh();
    } finally { setReviewRestoringWorktreeId(undefined); }
  };
  // remove one durable review and its local surface
  const dismissReview = async (): Promise<boolean> => {
    // require a bound review
    if (reviewLaunch === undefined) return false;
    const response = await request(`/api/worktrees/${encodeURIComponent(reviewLaunch.worktreeId)}/review-tour`, { method: 'DELETE' }).catch(() => undefined);
    // retain local state after a failed dismissal
    if (response === undefined || !response.ok) return false;
    setData(current => current === undefined ? current : { ...current, reviews: current.reviews?.filter(review => review.worktreeId !== reviewLaunch.worktreeId) });
    setReviewLaunch(undefined);
    setReviewInitialTour(undefined);
    setReviewIndicator({ generating: false, stale: false });
    setReviewMinimized(false);
    void dismissNotification(reviewNotificationTag(reviewLaunch.worktreeId));
    return true;
  };
  if (data === undefined) return <LoadingScreen label={unavailable ? 'Reconnecting to console' : 'Syncing console state'} />;
  const item = items[visibleActive];
  const cleanupCount = data.cleanupPending ?? 0;
  const cleanupControl = cleanupCount === 0 ? null : <button ref={cleanupTriggerRef} className="log-control page-arrow cleanup-toggle" aria-label={`Review ${cleanupCount} cleanup ${cleanupCount === 1 ? 'target' : 'targets'}`} title="Review cleanup" aria-haspopup="dialog" data-context-flyout aria-expanded={cleanupOpen} onPointerDown={event => event.preventDefault()} onClick={() => void openCleanup()}><svg className="broom-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m19.36 2.72 1.42 1.42-5.72 5.71c1.07 1.54 1.22 3.39.32 4.59L9.06 8.12c1.2-.9 3.05-.75 4.59.32l5.71-5.72ZM5.93 17.57c-2.01-2.01-3.24-4.41-3.58-6.65l4.88-2.09 7.44 7.44-2.09 4.88c-2.24-.34-4.64-1.57-6.65-3.58Z" /></svg><span className="saved-prompts-count cleanup-count" aria-hidden="true">{cleanupCount}</span></button>;
  const cleanupKindLabel: Record<CleanupTarget['kind'], string> = {
    'orphan-worker': 'Orphaned worker',
    'stale-agent': 'Stale agent',
    'hud-pane': 'HUD watcher window',
    'hud-process': 'HUD watcher',
    'merged-branch': 'Merged branch',
    'closed-pr-branch': 'Closed PR branch'
  };
  const cleanupDialog = !cleanupOpen ? null : createPortal(<div className="dialog cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title"><div><header className="cleanup-header"><div><h2 id="cleanup-title">Cleanup</h2><p>Select items to clean up. Unchecked items will be dismissed.</p></div><button className="cleanup-close" type="button" aria-label="Close cleanup" disabled={cleanupLoading} onClick={closeCleanup}><PanelIcon path={panelIcons.close} /></button></header>{cleanupLoading && cleanupTargets.length === 0 ? <p className="cleanup-loading progress-border progress-blue" role="status" aria-busy="true"><ProgressRing busy />Searching for cleanup targets…</p> : cleanupTargets.length === 0 ? <p className="cleanup-empty">No cleanup targets remain.</p> : <fieldset className="cleanup-targets" disabled={cleanupLoading}><legend className="sr-only">Cleanup targets</legend>{cleanupTargets.map(target => <label key={target.id} className="cleanup-target"><input type="checkbox" checked={cleanupChecked.has(target.id)} onChange={event => setCleanupChecked(current => { const next = new Set(current); if (event.target.checked) next.add(target.id); else next.delete(target.id); return next; })} /><span><strong><small>{cleanupKindLabel[target.kind]}</small>{target.label}</strong><span>{target.detail}</span></span></label>)}</fieldset>}{cleanupError && <p className="cleanup-error" role="alert">{cleanupError}</p>}<footer className="cleanup-actions"><span>{cleanupTargets.length === 0 ? 'Nothing selected' : `${cleanupChecked.size} of ${cleanupTargets.length} selected`}</span><button type="button" className={cleanupLoading ? 'progress-border progress-red' : undefined} aria-busy={cleanupLoading || undefined} disabled={cleanupLoading || cleanupError === 'Unable to load cleanup targets.'} onClick={() => void resolveCleanup()}><ProgressRing busy={cleanupLoading} />{cleanupLoading ? 'Working…' : cleanupChecked.size === 0 ? 'Dismiss all' : 'Cleanup'}</button></footer></div></div>, document.body);
  // the Agent the active tab's switcher shows
  const agent = currentAgentOf(item);
  const activeWorktreeId = item?.worktree?.id ?? agent?.worktreeId;
  // the discovered Worktree behind the active tab, for its pin toggle and Place actions
  const activeWorktree = item?.worktree;
  // the directory-Project or Scratch Place behind an active tab that has no Worktree, for its pin toggle
  const activePlace = item?.place;
  // the toolbar's Launch on a tab with Agents starts another Agent that joins the Place's session;
  // an ad-hoc Scratch folder, and an Agent placed nowhere, have no launch
  const activePlaceLaunch = activePlace === undefined ? undefined : placeLaunch(activePlace);
  const activeLaunchEndpoint = activeWorktree !== undefined ? `/api/worktrees/${encodeURIComponent(activeWorktree.id)}/launch` : activePlaceLaunch?.endpoint;
  const activeLaunchResolution = activeWorktree !== undefined ? activeWorktree.launch : activePlaceLaunch?.resolution;
  const activeLaunch: ToolbarLaunch | undefined = item === undefined || activeLaunchEndpoint === undefined ? undefined
    : { label: item.label, resolution: activeLaunchResolution, disabled: creatingAgent || launchingAnotherAt !== undefined || activeWorktree?.available === false, pending: launchingAnotherAt === item.key, start: choice => void launchAnother({ key: item.key, label: item.label, endpoint: activeLaunchEndpoint, worktreeId: activeWorktree?.id }, choice) };
  // the Project owning the active tab's Worktree, so an idle tab gates Remove on manageability
  const activeProject = data.projects.find(project => project.id === (item?.worktree?.projectId ?? agent?.projectId));
  // the Schedule pre-fill and the note pane's Adapter/target picker rows for a note pane: the
  // pre-fill is the Project's main worktree, the directory itself for a directory Project, or
  // Scratch with that target's resolved launch kind; the pickers mirror the launcher's rows so a
  // Schedule can retarget anywhere a Launch can.
  const resolveSchedulePrefill = (context: { projectId?: string }): SchedulePrefill => {
    const fallbackKind = (kind?: AgentKind) => kind ?? configuredKinds(data.adapters)[0] ?? 'claude';
    const originFor = (resolution?: LaunchResolution) => originCopy(resolution?.origin);
    // the Adapter picker rows: one per configured kind, with the launcher's sandbox line and reason
    const adapters: ScheduleAdapterOption[] = configuredKinds(data.adapters).map(kind => {
      const capability = data.adapters?.[kind];
      return { kind, launchable: capability?.launchable === true, detail: sandboxCopy(kind, capability, defaultSandboxed(capability)), ...(capability?.unavailableReason === undefined ? {} : { unavailableReason: capability.unavailableReason }) };
    });
    // the target picker rows: Scratch, then every Project's worktrees (repository) or its own
    // directory row, grouped by Project with the main worktree marked
    const targets: ScheduleTargetOption[] = [{ target: { scratch: true }, label: 'Scratch', available: true, kind: fallbackKind(data.scratchLaunch?.kind), origin: originFor(data.scratchLaunch) }];
    for (const project of data.projects) {
      if (project.mode === 'directory') {
        targets.push({ target: { projectId: project.id }, label: project.label, sublabel: 'directory', group: project.label, available: project.available, ...(project.available ? {} : { unavailableReason: project.unavailableReason ?? 'Project unavailable' }), kind: fallbackKind(project.launch?.kind), origin: originFor(project.launch) });
        continue;
      }
      for (const worktree of project.worktrees) {
        targets.push({ target: { worktreeId: worktree.id }, label: worktree.label, ...(worktree.main ? { sublabel: 'main worktree', main: true } : {}), group: project.label, available: worktree.available, ...(worktree.available ? {} : { unavailableReason: 'Worktree unavailable' }), kind: fallbackKind(worktree.launch?.kind ?? project.launch?.kind), origin: originFor(worktree.launch ?? project.launch) });
      }
    }
    // the live agents, so the note pane shows "Open agent" only while the Run's pane is still up
    const rows = { adapters, targets, liveAgentIds: data.agents.map(agent => agent.id) };
    const project = context.projectId === undefined ? undefined : data.projects.find(candidate => candidate.id === context.projectId);
    if (project !== undefined && project.mode === 'directory') return { target: { projectId: project.id }, kind: fallbackKind(project.launch?.kind), runsOnText: `${project.label} · directory`, ...rows };
    if (project !== undefined) {
      const main = project.worktrees.find(worktree => worktree.main) ?? project.worktrees[0];
      if (main !== undefined) return { target: { worktreeId: main.id }, kind: fallbackKind(main.launch?.kind ?? project.launch?.kind), runsOnText: `${project.label} · main worktree`, ...rows };
    }
    return { target: { scratch: true }, kind: fallbackKind(data.scratchLaunch?.kind), runsOnText: 'Scratch', ...rows };
  };
  const voiceContext = { server: serverInfo.name, serverUrl: serverInfo.url, openWorktrees: otherOpenWorktrees(data.agents, activeWorktreeId, worktreeLabelById), ...(activeWorktreeId === undefined ? {} : { worktreeId: activeWorktreeId, worktree: worktrees.find(worktree => worktree.id === activeWorktreeId)?.label ?? agent?.worktreeLabel ?? (agent === undefined ? activeWorktreeId : agentLabel(agent)) }), ...(agent === undefined ? {} : { agentId: agent.id, agent: activeWorktree?.label ?? agent.worktreeLabel ?? agentLabel(agent) }) };
  const voiceDialog = davo.enabled ? <VoiceDialog name={davo.name} open={voiceOpen} callRequest={voiceCallRequest} context={voiceContext} request={request} onClose={closeVoice} onSelectWorktree={selectVoiceWorktree} onActiveChange={setVoiceActive} /> : null;
  const visibleOperationFeedback = operationFeedback?.worktreeId === undefined || operationFeedback.worktreeId === activeWorktreeId ? operationFeedback : undefined;
  // minimize without discarding the cached review
  const minimizeReview = () => {
    setReviewMinimized(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.workspace-toolbar-actions .git-status-summary')?.focus());
  };
  // announce a newly generated review
  const notifyReviewReady = () => {
    // require the matching active review
    if (reviewLaunch === undefined) return;
    const agent = data.agents.find(candidate => candidate.id === reviewLaunch.agentId);
    const worktree = worktrees.find(candidate => candidate.id === reviewLaunch.worktreeId);
    const project = data.projects.find(candidate => candidate.id === worktree?.projectId);
    const worktreeName = worktree?.label ?? agent?.worktreeLabel ?? (agent === undefined ? reviewLaunch.worktreeId : agentLabel(agent));
    const projectName = project?.label ?? worktreeName;
    void showNotification('system', `Review ready in ${projectName}`, `${worktreeName} is ready for review`, reviewNotificationTag(reviewLaunch.worktreeId), `/#agent=${encodeURIComponent(reviewLaunch.agentId)}`, reviewLaunch.worktreeId);
  };
  // open and acknowledge the local review
  const openLocalReview = () => {
    // require the matching active review
    if (reviewLaunch === undefined) return;
    void dismissNotification(reviewNotificationTag(reviewLaunch.worktreeId));
    setReviewMinimized(false);
  };
  const newWorktreeProject = newWorktreeProjectId === undefined ? undefined : data.projects.find(project => project.id === newWorktreeProjectId);
  const newWorktreeDialog = newWorktreeProject === undefined ? null : <NewWorktreeDialog project={newWorktreeProject} request={request} onClose={() => setNewWorktreeProjectId(undefined)} onCreated={result => void worktreeCreated(result)} />;
  const removeWorktreeTarget = removeWorktreeId === undefined ? undefined : allWorktrees(data).find(worktree => worktree.id === removeWorktreeId);
  const removeWorktreeDialog = removeWorktreeTarget === undefined ? null : <RemoveWorktreeDialog worktree={removeWorktreeTarget} request={request} onClose={() => setRemoveWorktreeId(undefined)} onRemoved={message => void worktreeRemoved(message)} />;
  const renameWorktreeTarget = renameWorktreeId === undefined ? undefined : allWorktrees(data).find(worktree => worktree.id === renameWorktreeId);
  const renameWorktreeProject = renameWorktreeTarget === undefined ? undefined : data.projects.find(project => project.id === renameWorktreeTarget.projectId);
  // apply the saved label immediately, then reconcile with discovery in the background
  const renameWorktreeDialog = renameWorktreeTarget === undefined ? null : <RenameWorktreeDialog worktree={renameWorktreeTarget} request={request} onClose={() => setRenameWorktreeId(undefined)} onRenamed={label => {
    let visibleLabel = label;
    // regenerate only when the alias was cleared
    if (visibleLabel === undefined) visibleLabel = renameWorktreeProject === undefined ? renameWorktreeTarget.label : generatedWorktreeLabel(renameWorktreeTarget, renameWorktreeProject);
    // replace only the matching Worktree in the current dashboard
    setData(current => {
      // ignore a rename after dashboard teardown
      if (current === undefined) return current;
      return { ...current, projects: current.projects.map(project => {
        // leave unrelated Projects untouched
        if (project.id !== renameWorktreeTarget.projectId) return project;
        return { ...project, worktrees: project.worktrees.map(worktree => {
          // leave sibling Worktrees untouched
          if (worktree.id !== renameWorktreeTarget.id) return worktree;
          return { ...worktree, label: visibleLabel, customLabel: label !== undefined };
        }) };
      }) };
    });
    setRenameWorktreeId(undefined);
    void refresh();
  }} />;
  const pruneProject = pruneProjectId === undefined ? undefined : data.projects.find(project => project.id === pruneProjectId);
  const pruneDialog = pruneProject === undefined ? null : <PruneWorktreesDialog project={pruneProject} request={request} onClose={() => setPruneProjectId(undefined)} onPruned={() => void worktreesPruned()} />;
  const worktreeManagementDialogs = <>{renameWorkspace !== undefined && <RenameWorkspaceDialog key={renameWorkspace.key} workspace={renameWorkspace} onClose={() => setRenameWorkspace(undefined)} />}{newWorktreeDialog}{removeWorktreeDialog}{renameWorktreeDialog}{pruneDialog}</>;
  // the reviewed branch's open or draft pull request, which an All PR tour can post its feedback to
  const reviewPullRequest = reviewLaunch === undefined ? undefined : [data.agents.find(candidate => candidate.id === reviewLaunch.agentId)?.pullRequest, worktrees.find(candidate => candidate.id === reviewLaunch.worktreeId)?.pullRequest].find(pullRequest => pullRequest !== undefined && pullRequest.status !== 'merged');
  const reviewPanel = reviewLaunch === undefined ? null : <ReviewTourPanel key={`${reviewLaunch.worktreeId}:${reviewInitialTour?.fingerprint ?? `start-${reviewStarts}`}`} launch={reviewLaunch} request={request} slot={reviewSlot} initialTour={reviewInitialTour} tourAgent={data.reviewTour?.agent} {...(reviewInitialTour === undefined ? {} : { initialCodeReview: reviewInitialCodeReview.review, initialCodeReviewJob: reviewInitialCodeReview.job })} codeReviewCapability={codeReviewCapability(data.codeReview)} pullRequest={reviewPullRequest} onMinimize={minimizeReview} onDismiss={dismissReview} onIndicatorChange={setReviewIndicator} onReady={notifyReviewReady} onOpenAgent={setActivateAgentId} onError={(message, detail) => showOperationFeedback({ tone: 'error', message, detail, worktreeId: reviewLaunch.worktreeId })} {...(data.editor === true ? { onOpenInEditor: (target: EditorTarget) => void openEditorAt(reviewLaunch.worktreeId, target) } : {})} />;
  const reviewStartSheet = reviewStart === undefined ? null : <ReviewStartSheet target={reviewStart} prBase={data.agents.find(candidate => candidate.id === reviewStart.agentId)?.gitPrStatus?.base} request={request} tour={data.reviewTour} codeReview={codeReviewCapability(data.codeReview)} onStart={launchReview} onCancel={cancelReviewStart} />;
  const storedReview = agent?.worktreeId === undefined ? undefined : data.reviews?.find(review => review.worktreeId === agent.worktreeId);
  const localReview = agent?.worktreeId !== undefined && agent.worktreeId === reviewLaunch?.worktreeId;
  const reviewAgent = reviewBindingAgent(agent, item?.agents ?? []);
  const activeReview = localReview ? { ...reviewIndicator, onOpen: openLocalReview, ...(reviewMinimized ? {} : { panel: <ReviewPanelColumn onSlot={setReviewSlot} />, onMinimize: minimizeReview }) } : reviewAgent !== undefined && storedReview !== undefined ? { generating: reviewRestoringWorktreeId === storedReview.worktreeId, stale: false, onOpen: () => void openStoredReview(reviewAgent, storedReview) } : undefined;
  // append workspace actions after each place's agent choices
  const placeEntries = (place: { id: string; label: string; consoleShells?: number } | undefined): LaunchMenuEntry[] => place === undefined ? [] : [
    { key: 'terminal', label: 'Terminal', detail: (place.consoleShells ?? 0) > 0 ? 'Focus its shell' : 'Open the Workspace with a new shell', icon: <LauncherRowIcon name="terminal" />, onSelect: () => void openTerminalAt(place.id, place.label) },
    { key: 'empty', label: 'Empty workspace', detail: placeTabIndex(place.id) >= 0 ? 'Already open: focuses it' : 'No panels; add them from the toolbar', icon: <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" /></svg>, onSelect: () => openEmptyWorkspace(place.id) }
  ];
  // a + row's control while an Agent runs at its Place: Open selects it, and a kind from the menu
  // launches another beside it through `endpoint`, held back as the toolbar's launch-another is
  const openAgentSplit = (place: { id: string; label: string; consoleShells?: number }, agent: Agent, resolution: LaunchResolution | undefined, endpoint: string, { worktreeId, unavailable = false }: { worktreeId?: string; unavailable?: boolean } = {}): ReactNode =>
    <LaunchSplitButton label={place.label} resolution={resolution} compact placeActions alwaysShowMenu primary={{ label: 'Open', ariaLabel: `Open ${place.label}`, onSelect: () => { closeLauncher(); selectTarget({ worktreeId: place.id, agentId: agent.id }); } }} entries={placeEntries(place)} launchDisabled={creatingAgent || launchingAnotherAt !== undefined || unavailable} onLaunch={choice => { closeLauncher(); navigateToWorktree(place.id); void launchAnother({ key: placeItemKey(place.id), label: place.label, endpoint, worktreeId }, choice); }} />;
  // a directory-Project or Scratch row's control: Open while an Agent runs at its Place, else Launch
  const launcherPlaceSplit = (label: string, place: Place | undefined, resolution: LaunchResolution | undefined, endpoint: string, launch: (choice?: LaunchChoice) => void): ReactNode => {
    const running = place === undefined ? undefined : data.agents.find(agent => agentPlaceId(agent) === place.id);
    if (place !== undefined && running !== undefined) return openAgentSplit(place, running, resolution, endpoint);
    return <LaunchSplitButton label={label} resolution={resolution} compact placeActions alwaysShowMenu launchDisabled={creatingAgent} entries={placeEntries(place)} onLaunch={launch} />;
  };
  // render one worktree's launcher actions
  const launcherWorktreeControls = (worktree: Worktree, project: Project): ReactNode => {
    // bind active worktrees to their existing agent
    const openAgent = data.agents.find(agent => agent.worktreeId === worktree.id);
    const removeReason = worktreeRemoveDisabledReason(worktree, project);
    let action: ReactNode;
    // open the existing agent instead of launching another one; its kinds launch another beside it
    if (openAgent !== undefined) action = openAgentSplit(worktree, openAgent, worktree.launch, `/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { worktreeId: worktree.id, unavailable: !worktree.available });
    // launch one inactive worktree
    else action = <LaunchSplitButton label={worktree.label} resolution={worktree.launch} compact placeActions alwaysShowMenu launchDisabled={creatingAgent || pendingOperations.has(launchOperationKey(worktree.id))} entries={placeEntries(worktree)} onLaunch={choice => void launchWorktree(worktree, choice)} />;
    return <><PlaceShellsAndPin place={worktree} noun="worktree" onTogglePin={() => void togglePin(worktree)} /><button type="button" className="launcher-icon launcher-rename" disabled={creatingAgent} aria-label={`Rename ${worktree.label}`} title="Rename worktree" onClick={() => setRenameWorktreeId(worktree.id)}><LauncherRowIcon name="rename" /></button><button type="button" className="launcher-icon launcher-remove" disabled={creatingAgent || openAgent !== undefined || removeReason !== undefined} aria-label={`Remove ${worktree.label}`} title={openAgent === undefined ? removeReason ?? 'Remove worktree' : 'Turn off the agents here before removing this worktree'} onClick={() => setRemoveWorktreeId(worktree.id)}><LauncherRowIcon name="trash" /></button>{action}</>;
  };
  // the shell count and pin toggle a directory-Project or Scratch launcher row shows before its Launch
  const launcherPlaceControls = (place: Place | undefined): ReactNode => place === undefined ? null : <PlaceShellsAndPin place={place} onTogglePin={() => void togglePin(place)} />;
  // the listed Place of a directory Project, and the configured Scratch folder's
  const directoryPlace = (projectId: string) => data.places?.find(place => place.kind === 'directory' && place.projectId === projectId);
  const scratchPlace = data.places?.find(place => place.kind === 'scratch' && place.adhoc !== true);
  // render one launcher project at the selected density
  const launcherProject = (project: Project): ReactNode => {
    const inlineWorktree = !dynamicWorktrees && project.worktrees.length === 1 ? project.worktrees[0] : undefined;
    const visibleWorktrees = inlineWorktree === undefined ? project.worktrees : [];
    const staleCount = project.stalePaths?.length ?? 0;
    // render every non-compacted worktree row
    const rows = visibleWorktrees.map(worktree => <div key={worktree.id} className="launcher-row"><span className="launcher-row-label">{launcherRowLabel(worktree, project)}</span>{launcherWorktreeControls(worktree, project)}</div>);
    return <div key={project.id} className="launcher-project" role="group" aria-label={project.label}><div className={`launcher-project-header${inlineWorktree === undefined ? '' : ' inline-worktree'}`}><span>{project.label}</span>{staleCount > 0 && <button type="button" className="launcher-prune" disabled={creatingAgent || project.manageWorktrees === false} title={project.manageWorktrees === false ? project.manageWorktreesReason : undefined} onClick={() => setPruneProjectId(project.id)}>{staleCount} stale · Prune</button>}{inlineWorktree !== undefined && <div className="launcher-project-worktree-controls" role="group" aria-label={`${project.label} worktree controls`}>{launcherWorktreeControls(inlineWorktree, project)}</div>}</div>{rows}{project.mode === 'directory' && <div className="launcher-row"><span className="launcher-row-label">{project.label}</span>{launcherPlaceControls(directoryPlace(project.id))}{launcherPlaceSplit(project.label, directoryPlace(project.id), project.launch, `/api/projects/${encodeURIComponent(project.id)}/launch`, choice => void launchProjectDirectory(project, choice))}</div>}{dynamicWorktrees && <button type="button" className="launcher-new-worktree" disabled={creatingAgent || project.manageWorktrees === false} title={project.manageWorktrees === false ? project.manageWorktreesReason : undefined} onClick={() => setNewWorktreeProjectId(project.id)}><LauncherLabelIcon name="add" /><span>New worktree…</span></button>}</div>;
  };
  // offer one Scratch launch even before any Workspace has been opened
  const globalLaunch: ToolbarLaunch = { label: 'Scratch', resolution: data.scratchLaunch, pending: creatingAgent, start: choice => createAgent(choice) };
  // share one toast stack while the active agent supplies its rebase action
  const renderNotifications = (content: ReactNode = null) => <ToastRegion feedback={visibleOperationFeedback} onDismissFeedback={() => setOperationFeedback(undefined)} updateError={updateError} onDismissUpdateError={onDismissUpdateError} launchErrorMessage={launchErrorMessage} launchErrorExpires={launchErrorExpires}>{content}</ToastRegion>;
  // read an inactive workspace's retained splits without activating it
  const retainedSplits = (entry: DashboardItem): WorkspaceSplit[] => {
    const live = workspaceViews.get(entry.key);
    // use mounted panels rather than storage while the workspace is active
    if (live !== undefined) return live.splits;
    const splits: WorkspaceSplit[] = [];
    // include settings saved for this inactive workspace without opening it elsewhere
    if (settingsSplitOpen(entry.key)) splits.push({ key: 'settings', label: 'Settings' });
    // include the one visible agent panel
    if (!agentSplitHidden(entry.key) && (entry.agents.length > 0 || entry.pendingLaunch !== undefined)) splits.push({ key: 'agent', label: 'Agent output' });
    const placeId = entry.placeId;
    // restore only place-scoped terminal and project panels
    if (placeId !== undefined) {
      // keep each visible shell separately addressable
      for (const terminal of savedTerminals(placeId)) splits.push({ key: terminal.paneId, label: `Terminal ${terminal.name}` });
      // omit browser preferences for unavailable project previews
      if (savedBrowserSplit(placeId) && (entry.worktree?.projectUrl ?? entry.agents[0]?.projectUrl) !== undefined) splits.push({ key: 'browser', label: 'Project browser' });
      // include retained code views
      if (savedCodeOpen(placeId)) splits.push({ key: 'code', label: 'Code changes' });
      if (!reviewMinimized && reviewLaunch !== undefined && entry.agents.some(agent => agent.worktreeId === reviewLaunch.worktreeId)) splits.push({ key: 'review', label: 'Guided review' });
      // a Stack panel shows only for a stack with processes
      if (savedStackPanel(placeId) && ((entry.worktree?.stack ?? entry.agents[0]?.stack)?.processes?.length ?? 0) > 0) splits.push({ key: 'stack', label: 'Stack' });
    }
    const selectedAgent = currentAgentOf(entry);
    const noteViewId = placeId ?? (selectedAgent === undefined ? undefined : `agent:${selectedAgent.id}`);
    // retain notes belonging to agents without a discovered place too
    if (noteViewId !== undefined && getWorktreeNoteView(noteViewId) !== undefined) splits.push({ key: 'note', label: 'Note' });
    return splits;
  };
  // close panels only; process lifetime belongs to their explicit power controls
  const closeWorkspaceSplits = (entry: DashboardItem) => {
    const live = workspaceViews.get(entry.key);
    // flush mounted note drafts before minimizing their panels
    if (live !== undefined) { live.closeAll(); return; }
    // hiding an inactive settings split does not discard the shared in-memory draft
    setSettingsSplitOpen(entry.key, false);
    // inactive panes have already flushed on unmount
    if (entry.placeId !== undefined) { forgetOpenPanels(entry.placeId); saveCodeOpen(entry.placeId, false); }
    const selectedAgent = currentAgentOf(entry);
    // clear the unscoped note view without deleting its stored content
    if (entry.placeId === undefined && selectedAgent !== undefined) clearWorktreeNoteView(`agent:${selectedAgent.id}`);
    // keep empty workspaces free of a meaningless agent restore button
    if (entry.agents.length > 0 || retainedSplits(entry).some(split => split.key === 'agent')) setAgentSplitHidden(entry.key, true);
  };
  // stop every managed session with feedback visible even from inactive tabs
  const turnOffWorkspace = async (entry: DashboardItem) => {
    const worktreeId = entry.placeId;
    const operationKey = deactivateOperationKey(worktreeId ?? entry.agents[0]?.id ?? entry.key);
    // keep launches, mutations and unsaved attachment work protected
    if (entry.pendingLaunch !== undefined || entry.operation !== undefined || workspaceViews.get(entry.key)?.canClose === false) return;
    // preserve scratch and directory handoffs awaiting discovery
    if (pendingSessionLaunchesRef.current.some(launch => launch.phase !== 'failed' && (launch.scope === 'scratch' ? entry.place?.kind === 'scratch' && entry.place.adhoc !== true : entry.place?.kind === 'directory' && entry.place.projectId === launch.projectId))) return;
    // prevent repeated or competing workspace shutdowns
    if (!beginPendingOperation(operationKey, entry.key)) return;
    const agents = (dashboardSnapshot.current?.agents ?? entry.agents).filter(candidate => agentItemKey(candidate) === entry.key);
    // preserve working agents before touching any sibling shells
    if (agents.some(candidate => agentState(candidate) === 'working')) {
      showOperationFeedback({ tone: 'error', message: `${entry.label} could not be turned off`, detail: 'Cancel the agents’ work before turning off this workspace.' });
      setPendingOperation(operationKey, false);
      return;
    }
    try {
      const panes = worktreeId === undefined ? [] : await listPlacePanes(worktreeId);
      // refuse an unverified shell scope
      if (panes === undefined) throw new Error('The console could not list this workspace’s terminals. Nothing was turned off.');
      const shells = panes.filter(isConsoleShell);
      const confirmed = new Set<string>();
      // confirm known busy shells before the first shutdown
      for (const shell of shells) {
        // leave idle shells on the unconfirmed server path
        if (!shell.busy) continue;
        // preserve the entire workspace on declined preflight
        if (!window.confirm(`End ${terminalPaneLabel(shell)}? It is running a command.`)) return;
        confirmed.add(shell.paneId);
      }
      const prepareClose = workspaceViews.get(entry.key)?.prepareClose;
      // discard settings only after every cancellable shutdown preflight succeeds
      if (prepareClose !== undefined && !await prepareClose()) return;
      showOperationFeedback({ tone: 'pending', message: `Turning off ${entry.label}…`, detail: 'Stopping every agent and managed terminal in this workspace.' });
      // only discovered places can own managed terminals
      if (worktreeId !== undefined) {
        // end managed terminals without touching independent tmux or stack panes
        for (const shell of shells) {
          const ended = await endConsoleShell(worktreeId, shell, confirmed.has(shell.paneId));
          // keep remaining sessions and panels on cancellation or failure
          if (ended !== true) throw new Error(ended === false ? `Terminal ${terminalPaneLabel(shell)} could not be ended. Remaining sessions stay open.` : 'Terminal shutdown was cancelled. Remaining sessions stay open.');
        }
      }
      // turn off every agent rather than only the selected split
      for (const target of agents) {
        const configured = target.worktreeId !== undefined;
        const response = await request(`/api/agents/${encodeURIComponent(target.id)}${configured ? '/deactivate' : ''}`, emptyJsonMutation(configured ? 'POST' : 'DELETE'));
        // report partial shutdown rather than hiding surviving sessions
        if (!response.ok) throw new Error(await launchError(response));
      }
      closeWorkspaceSplits(entry);
      // release only this transient tab while preserving pins
      if (worktreeId !== undefined) setOpenedPlaces(current => { const next = new Set(current); next.delete(worktreeId); return next; });
      showOperationFeedback({ tone: 'success', message: `${entry.label} is off`, detail: 'Its agents and managed terminals are stopped. The worktree is still available.' });
    } catch (error) {
      showOperationFeedback({ tone: 'error', message: `${entry.label} could not be turned off`, detail: error instanceof Error ? error.message : 'The console could not be reached. Remaining sessions may still be running.' });
    } finally {
      setPendingOperation(operationKey, false);
      await refresh();
    }
  };
  // rename a Workspace: a Worktree through the server, any other Place as a browser-local alias
  const renameWorkspaceEntry = (entry: DashboardItem) => {
    if (entry.worktree !== undefined) setRenameWorktreeId(entry.worktree.id);
    else setRenameWorkspace({ key: entry.key, label: entry.label });
  };
  // switch to a Workspace's tab and bring one of its panels into view (its input too, with `input`)
  const jumpToSplit = (entry: DashboardItem, splitKey: string, input = false) => {
    const index = items.findIndex(candidate => candidate.key === entry.key);
    // ignore tabs removed since the menu opened
    if (index < 0) return;
    const live = workspaceViews.get(entry.key);
    // defer navigation until an inactive workspace mounts
    if (live !== undefined) live.jump(splitKey, input);
    else pendingWorkspaceJumps.set(entry.key, splitKey);
    select(index);
  };
  // route each tab menu action by identity rather than the currently selected tab
  const workspaceContextMenu = (event: React.MouseEvent<HTMLButtonElement>, entry: DashboardItem) => {
    const place = entry.worktree ?? entry.place;
    const splits = retainedSplits(entry);
    const kind = currentAgentOf(entry)?.kind ?? entry.pendingLaunch?.kind;
    // reuse each split's existing glyph without adding navigation verbs to its name
    const splitIcons: Record<string, ReactNode> = {
      agent: kind === undefined ? <PanelIcon path="M5 7h14v13H5zM12 3v4M8 12h1m6 0h1M9 16h6M2 11v5m20-5v5" /> : <span>{agentKindGlyph[kind]}</span>,
      terminal: <LauncherRowIcon name="terminal" />,
      note: <PanelIcon path="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM15 21v-6h6" />,
      browser: <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true">{browserGlyph}</svg>,
      code: <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true">{codeGlyph}</svg>,
      stack: <StackIcon path={stackGlyphs.panel} className="more-menu-icon" />,
      settings: <PanelIcon path="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 3v2m0 14v2M3 12h2m14 0h2M6 6l1 1m10 10 1 1M6 18l1-1m10-10 1-1" />
    };
    const menu: ContextMenuItem[] = [
      { type: 'action', id: 'pin', label: place?.pinned ? 'Unpin workspace' : 'Pin workspace', icon: place?.pinned ? <LauncherRowIcon name="pin" /> : undefined, mode: 'checkbox', checked: place?.pinned ?? false, disabled: place === undefined, onSelect: () => { /* require a pinnable discovered place */ if (place !== undefined) void togglePin(place); } },
      { type: 'action', id: 'rename', label: 'Rename', disabled: creatingAgent, onSelect: () => renameWorkspaceEntry(entry) },
      { type: 'action', id: 'close-all', label: 'Close all splits', disabled: splits.length === 0 || entry.pendingLaunch !== undefined || workspaceViews.get(entry.key)?.canClose === false, onSelect: () => closeWorkspaceSplits(entry) }
    ];
    // separate workspace commands from split navigation
    if (splits.length > 0) menu.push({ type: 'separator' });
    // capture each target workspace and split by identity
    for (const split of splits) menu.push({ type: 'action', id: `split-${split.key}`, label: split.label, icon: splitIcons[splitPanelKind(split.key)], onSelect: () => jumpToSplit(entry, split.key) });
    openContextMenu(event, { label: `${entry.label} workspace`, items: menu });
  };
  // the keyboard's Workspace picker (s), and with every Workspace's panels under it, its tree (w)
  const keyPickerOptions = (tree: boolean): KeyPickerOption[] => items.flatMap((entry, index) => [
    { id: entry.key, label: entry.label, detail: tabStatus(entry).label, current: index === visibleActive, onSelect: () => select(index) },
    ...(tree ? retainedSplits(entry).map(split => ({ id: `${entry.key}\u0000${split.key}`, label: split.label, nested: true, onSelect: () => jumpToSplit(entry, split.key, true) })) : [])
  ]);
  const keyboardOverlays = <><KeyboardLayer keys={data.keys} />{keyPicker !== undefined && <KeyPicker title={keyPicker === 'tree' ? 'Workspaces and panels' : 'Workspaces'} options={keyPickerOptions(keyPicker === 'tree')} onClose={() => setKeyPicker(undefined)} />}</>;
  // separate status text from each tab background and indicator
  const tabBar = <><nav className={`tabs${phone ? ' workspace-dropdown-row' : ''}`} ref={tabsRef} role="tablist" aria-label="Agents and worktrees"><TabRowLead />{phone ? <WorkspaceDropdown items={items} current={visibleActive} onSelect={index => select(index)} onNewWorkspace={() => setLauncherOpen(true)} onRenameWorktree={setRenameWorktreeId} renameDisabled={creatingAgent} onContextMenu={workspaceContextMenu} onTurnOff={entry => void turnOffWorkspace(entry)} /> : items.map((entry, index) => {
    const { transition, label, className, progress, busy } = tabStatus(entry);
    return <button key={entry.key} id={`tab-${index}`} role="tab" aria-selected={index === visibleActive} aria-controls={`panel-${index}`} tabIndex={index === visibleActive ? 0 : -1} className={`${index === visibleActive ? 'active ' : ''}${className}`} title={label} aria-label={`${entry.label} — ${label}`} aria-busy={busy || undefined} onPointerDownCapture={preserveWorkspacePress} onMouseDownCapture={preserveWorkspacePress} onContextMenu={event => workspaceContextMenu(event, entry)} onAuxClickCapture={event => closeOnMiddleClick(event, () => void turnOffWorkspace(entry))} onClick={() => select(index)}><ProgressRing busy={progress !== undefined} /><TabKindStack entry={entry} />{entry.worktree?.locked === true && <span className="tab-git-lock" aria-hidden="true" title="Git has locked this worktree">🔒</span>}{transition !== undefined ? <span className="tab-transition-label"><span>{entry.label}</span><small>{transition}…</small></span> : <span className="tab-label" aria-hidden="true">{entry.label}</span>}</button>;
  })}<NotificationControl /><span className="launcher" ref={launcherRef}><button ref={plusRef} className={`new-agent-tab${progressBorder(creatingAgent, 'blue')}`} type="button" disabled={creatingAgent} aria-busy={creatingAgent || undefined} aria-label={creatingAgent ? 'Starting agent' : 'Launch agent'} data-context-flyout aria-expanded={launcherOpen} onClick={() => { /* toggle the launcher */ if (launcherOpen) closeLauncher(); else setLauncherOpen(true); }}><ProgressRing busy={creatingAgent} /><span className="flyout-caret" aria-hidden="true" /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button></span>{launcherOpen && <FlyoutPortal onDismiss={closeLauncher}><div className="launcher-menu more-menu flyout-menu" ref={launcherMenuRef} style={launcherStyle} role="group" aria-label="Agent launcher"><div className="launcher-row"><span className="launcher-row-label launcher-symbol-label"><LauncherLabelIcon name="scratch" /><span>Scratch</span></span>{launcherPlaceControls(scratchPlace)}{launcherPlaceSplit('~ Scratch', scratchPlace, data.scratchLaunch, '/api/agents/launch', choice => void createAgent(choice))}</div>{data.projects.map(launcherProject)}</div></FlyoutPortal>}{plusAlone && <span className="tab-spacer" aria-hidden="true" />}{clientSettings && <ClientSettingsTrigger />}</nav>{agent === undefined && item?.worktree === undefined && renderNotifications()}</>;
  const consoleClass = `console${davo.enabled && voiceOpen ? ' voice-visible' : ''}`;
  // preserve editor availability when no workspace can own a terminal yet
  if (items.length === 0) return <EditorConfiguredContext.Provider value={data.editor === true}><AdaptersContext.Provider value={data.adapters}><ProjectsContext.Provider value={data.projects}><DashboardGenerationContext.Provider value={{ generation: dashboardGeneration, notesRevision: data.notesRevision, serverStartedAt: data.serverStartedAt }}><VoiceTriggerContext.Provider value={voiceTrigger}><OptionalClientSettingsLayout settings={clientSettings} onOperationFeedback={showOperationFeedback} workspaceKey="dashboard"><GlobalLaunchContext.Provider value={globalLaunch}><main className={consoleClass}>{voiceDialog}<article className="agent-view cleanup-empty-view"><section className="log-shell"><div className="log inactive-log"><ResizableLogSplit withSettings empty={<div className="empty-workspace"><h2>No sessions</h2></div>} /></div></section>{tabBar}<WorkspaceToolbar cleanupControl={cleanupControl} />{cleanupDialog}{worktreeManagementDialogs}{keyboardOverlays}{reviewPanel}{reviewStartSheet}</article></main></GlobalLaunchContext.Provider></OptionalClientSettingsLayout></VoiceTriggerContext.Provider></DashboardGenerationContext.Provider></ProjectsContext.Provider></AdaptersContext.Provider></EditorConfiguredContext.Provider>;
  return <AdaptersContext.Provider value={data.adapters}><EditorConfiguredContext.Provider value={data.editor === true}><ProjectsContext.Provider value={data.projects}><DashboardGenerationContext.Provider value={{ generation: dashboardGeneration, notesRevision: data.notesRevision, serverStartedAt: data.serverStartedAt }}><VoiceTriggerContext.Provider value={voiceTrigger}><OptionalClientSettingsLayout settings={clientSettings} onOperationFeedback={showOperationFeedback} workspaceKey={activeItemKey ?? 'dashboard'}><GlobalLaunchContext.Provider value={globalLaunch}><main className={consoleClass}>{voiceDialog}<section className="panel" role="tabpanel" id={`panel-${visibleActive}`} aria-labelledby={`tab-${visibleActive}`} tabIndex={0}>{item !== undefined && agent !== undefined && <AgentPlaceCard key={item.key} agent={agent} agents={item.agents} onSelectAgent={agentId => select(visibleActive, agentId)} active={agentState(agent) === 'working'} tabBar={tabBar} renderNotifications={renderNotifications} cleanupControl={cleanupControl} reviewCapability={data.reviewTour} review={activeReview} onReview={setReviewStart} onDeleted={refresh} onSelectTarget={selectTarget} onNavigateWorktree={navigateToWorktree} onOpenWorktreeStack={openWorktreeStack} onPromptFocus={() => viewAgent(agent)} onOperationFeedback={showOperationFeedback} schedulePrefill={resolveSchedulePrefill({ projectId: agent.projectId ?? (activePlace?.kind === 'directory' ? activePlace.projectId : undefined) })} launch={activeLaunch} {...(activeWorktree !== undefined || activePlace === undefined ? {} : { pinned: activePlace.pinned, onTogglePin: () => void togglePin(activePlace) })} {...(activeWorktree === undefined ? {} : { worktreeLabel: activeWorktree.label, ...(activeWorktree.main ? {} : { onRemoveWorktree: () => setRemoveWorktreeId(activeWorktree.id), removeDisabledReason: 'Turn off the agents here before removing this worktree' }) })} />}{item?.worktree !== undefined && agent === undefined && <WorktreeCard key={item.worktree.id} worktree={item.worktree} tabBar={tabBar} renderNotifications={renderNotifications} cleanupControl={cleanupControl} transient={item.transient === true} onLaunched={worktreeLaunched} onOperationFeedback={showOperationFeedback} onNavigateWorktree={navigateToWorktree} onOpenWorktreeStack={openWorktreeStack} onTogglePin={() => void togglePin(item.worktree!)} schedulePrefill={resolveSchedulePrefill({ projectId: item.worktree.projectId })} {...(item.worktree.main ? {} : { onRemove: () => setRemoveWorktreeId(item.worktree!.id), ...(worktreeRemoveDisabledReason(item.worktree, activeProject) === undefined ? {} : { removeDisabledReason: worktreeRemoveDisabledReason(item.worktree, activeProject) }) })} />}{item?.place !== undefined && agent === undefined && <PlaceCard key={item.place.id} place={item.place} tabBar={tabBar} cleanupControl={cleanupControl} transient={item.transient === true} launchDisabled={creatingAgent} launch={placeLaunch(item.place)} onLaunched={worktreeLaunched} onTogglePin={() => void togglePin(item.place!)} onOperationFeedback={showOperationFeedback} schedulePrefill={resolveSchedulePrefill({ projectId: item.place.kind === 'directory' ? item.place.projectId : undefined })} />}{item?.pendingLaunch && <PendingSessionCard key={item.pendingLaunch.id} launch={item.pendingLaunch} tabBar={tabBar} cleanupControl={cleanupControl} retrying={creatingAgent} onRetry={choice => { /* retain the same pending draft on retry */ void runPendingSessionLaunch(item.pendingLaunch!, choice); }} onDiscard={() => { /* discard only the selected failed placeholder */ discardPendingSessionLaunch(item.pendingLaunch!.id); }} onOperationFeedback={showOperationFeedback} />}</section>{cleanupDialog}{worktreeManagementDialogs}{keyboardOverlays}{reviewPanel}{reviewStartSheet}</main></GlobalLaunchContext.Provider></OptionalClientSettingsLayout></VoiceTriggerContext.Provider></DashboardGenerationContext.Provider></ProjectsContext.Provider></EditorConfiguredContext.Provider></AdaptersContext.Provider>;
}

// coordinate console session and update lifecycle
function App() {
  const { action, begin: beginFullscreenAction, finish: finishFullscreenAction, entered: fullscreenActionEntered } = useFullscreenAction();
  const [state, setState] = useState<'checking' | 'login' | 'naming' | 'ready' | 'inactive'>('checking');
  const [sessionInfo, setSessionInfo] = useState<SessionInfo>();
  const [serverInfo, setServerInfo] = useState<ServerInfo>(fallbackServerInfo);
  const [serverStatuses, setServerStatuses] = useState<Record<string, InstanceAttention>>({});
  const [error, setError] = useState('');
  const [clientUpdateAvailable, setClientUpdateAvailable] = useState(false);
  const [serverUpdateAvailable, setServerUpdateAvailable] = useState(false);
  const [serverUpdateOpen, setServerUpdateOpen] = useState(false);
  const [serverUpdateMinimized, setServerUpdateMinimized] = useState(false);
  const [agentUpdateStatuses, setAgentUpdateStatuses] = useState<AgentUpdateStatus[]>([]);
  const [updatingAgent, setUpdatingAgent] = useState<AgentKind>();
  const [agentUpdateError, setAgentUpdateError] = useState('');
  const [versionCheckError, setVersionCheckError] = useState('');
  const [defaultAgentError, setDefaultAgentError] = useState('');
  const [defaultAgentPending, setDefaultAgentPending] = useState(false);
  const announcedServerUpdateTarget = useRef<string | undefined>(undefined);
  const [reconnecting, setReconnecting] = useState(!consoleReachable);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const applySession = useCallback((current: SessionInfo) => {
    csrf = current.csrfToken;
    // retain validated server identity
    if (isServerInfo(current.server)) setServerInfo(current.server);
    setSessionInfo(current);
    setState(current.active ? current.deviceName === undefined ? 'naming' : 'ready' : 'inactive');
  }, []);
  // rename the current browser client
  const renameClient = useCallback(async (deviceName: string): Promise<string | undefined> => {
    const response = await request('/api/auth/device-name', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceName }) });
    // surface the server validation message
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      return typeof payload?.error === 'string' ? payload.error : 'Unable to rename this client.';
    }
    applySession(await response.json() as SessionInfo);
    return undefined;
  }, [applySession]);
  // rename the current server
  const renameServer = useCallback(async (name: string): Promise<string | undefined> => {
    const response = await request('/api/server/name', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    // surface the server validation message
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      return typeof payload?.error === 'string' ? payload.error : 'Unable to rename this server.';
    }
    const payload = await response.json() as { server?: unknown };
    // publish only validated identity
    if (isServerInfo(payload.server)) setServerInfo(payload.server);
    return undefined;
  }, []);
  // load the current deployed commit for settings
  const loadServerRevision = useCallback(async (): Promise<ServerRevision | undefined> => {
    try {
      const response = await request('/api/server/revision');
      // hide unavailable or malformed revision metadata
      if (!response.ok) return undefined;
      const payload: unknown = await response.json().catch(() => undefined);
      return isServerRevision(payload) ? payload : undefined;
    } catch {
      return undefined;
    }
  }, []);
  // reload one stale browser bundle only behind the painted cover
  const reloadClient = useCallback(async () => {
    // ignore repeated reload clicks while one transition owns the screen
    if (!await beginFullscreenAction('reload')) return;
    location.reload();
  }, [beginFullscreenAction]);
  // begin one restart after the shared cover is fully painted
  const beforeRestart = useCallback(() => beginFullscreenAction('restart'), [beginFullscreenAction]);
  // release the restart cover only after a proved settled status
  const onRestartSettled = useCallback(() => finishFullscreenAction('restart'), [finishFullscreenAction]);
  // persist the server-wide launch fallback
  const setDefaultAgent = useCallback(async (kind: AgentKind): Promise<string | undefined> => {
    const response = await request('/api/server/default-agent', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
    const payload = await response.json().catch(() => undefined) as { defaultAgent?: unknown; error?: unknown } | undefined;
    // surface validation and persistence failures
    if (!response.ok) return typeof payload?.error === 'string' ? payload.error : 'Unable to update the default agent.';
    // require the exact persisted choice
    if (!isAgentKind(payload?.defaultAgent)) return 'Unable to update the default agent.';
    const defaultAgent = payload.defaultAgent;
    setSessionInfo(current => current === undefined ? current : { ...current, defaultAgent });
    return undefined;
  }, []);
  // load configured agent version comparisons
  const agentUpdates = useCallback(async (): Promise<{ agents?: AgentUpdateStatus[]; error?: string }> => {
    const response = await request('/api/agents/updates');
    const payload = await response.json().catch(() => undefined) as { agents?: unknown; error?: unknown } | undefined;
    // surface request failures without discarding prior UI state
    if (!response.ok) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to check agent versions.' };
    // require a complete typed status list
    if (!Array.isArray(payload?.agents) || !payload.agents.every(isAgentUpdateStatus)) return { error: 'Unable to check agent versions.' };
    return { agents: payload.agents };
  }, []);
  // start once and poll without holding a tunnel request open during installation
  const updateAgent = useCallback(async (kind: AgentKind): Promise<{ agent?: AgentUpdateStatus; error?: string }> => {
    const path = `/api/agents/${encodeURIComponent(kind)}/update`;
    const unknownStatus = 'Update status is unavailable. The update may still be running; check installed versions before retrying.';
    // declare a json payload so chunked tunnel framing cannot reject an empty post
    const response = await request(path, { method: 'POST', headers: { 'content-type': 'application/json', Prefer: 'respond-async' }, body: JSON.stringify({}), signal: AbortSignal.timeout(10_000) }, false);
    const payload = await response.json().catch(() => undefined) as { agent?: unknown; update?: unknown; error?: unknown } | undefined;
    // never replay an installer after an ambiguous start response
    if (response.status >= 500) return { error: unknownStatus };
    // preserve explicit start refusals
    if (!response.ok) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to start the agent update.' };
    // accept older servers that return the completed update directly
    if (response.status === 200 && isAgentUpdateStatus(payload?.agent) && payload.agent.kind === kind) return { agent: payload.agent };
    // require the requested background job before polling
    if (!isAgentUpdateJob(payload?.update) || payload.update.kind !== kind) return { error: unknownStatus };
    let job = payload.update;
    const id = job.id;
    const deadline = Date.now() + 17 * 60_000;
    // outlast the bounded installer and version checks without retrying the mutation
    while (true) {
      // apply only a validated terminal result
      if (job.state === 'complete') return { agent: job.agent };
      // surface installer failures without declaring the console disconnected
      if (job.state === 'failed') return { error: job.error };
      // stop waiting without discarding a terminal response received at the deadline
      if (Date.now() >= deadline) return { error: unknownStatus };
      // pace short status reads independently of console reachability
      await new Promise<void>(resolve => window.setTimeout(resolve, 1_000));
      const poll = await request(`${path}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) }, false);
      // retry only status reads after transient proxy or transport failures
      if (poll.status >= 500 || poll.status === 429) continue;
      const status = await poll.json().catch(() => undefined) as { update?: unknown; error?: unknown } | undefined;
      // preserve unknown-job and authorization errors instead of rerunning the installer
      if (!poll.ok) return { error: typeof status?.error === 'string' ? status.error : unknownStatus };
      // reject another job or a malformed result without changing installed versions
      if (!isAgentUpdateJob(status?.update) || status.update.id !== id || status.update.kind !== kind) return { error: unknownStatus };
      job = status.update;
    }
  }, []);
  // refresh agent versions while the authenticated console is open
  useEffect(() => {
    // skip unauthenticated version checks
    if (state !== 'ready') return;
    let active = true;
    // retain the last good snapshot after request failures
    const refresh = async () => {
      const result = await agentUpdates();
      // ignore responses after unmount
      if (!active) return;
      // report failed version checks in launch menus
      if (result.agents === undefined) { setVersionCheckError(result.error ?? 'Unable to check agent versions.'); return; }
      setAgentUpdateStatuses(result.agents);
      setVersionCheckError('');
      announceAgentUpdates(result.agents);
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 15 * 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [agentUpdates, state]);
  // keep default selection alongside each agent's launch action
  const selectDefaultAgent = useCallback(async (kind: AgentKind) => {
    // ignore duplicate selections
    if (kind === sessionInfo?.defaultAgent || defaultAgentPending) return;
    setDefaultAgentPending(true);
    setDefaultAgentError('');
    const failure = await setDefaultAgent(kind);
    setDefaultAgentPending(false);
    // retain the previous choice on failure
    if (failure !== undefined) setDefaultAgentError(failure);
  }, [defaultAgentPending, sessionInfo?.defaultAgent, setDefaultAgent]);
  // update one agent and retain its version on failure
  const runAgentUpdate = useCallback(async (kind: AgentKind) => {
    // ignore concurrent installers
    if (updatingAgent !== undefined) return;
    setUpdatingAgent(kind);
    setAgentUpdateError('');
    const result = await updateAgent(kind);
    setUpdatingAgent(undefined);
    // retain the available version after failure
    if (result.agent === undefined) { setAgentUpdateError(result.error ?? 'Unable to update the agent.'); return; }
    const updated = result.agent;
    setAgentUpdateStatuses(current => [...current.filter(status => status.kind !== kind), updated]);
    // clear the completed update notification
    if (!updated.updateAvailable) {
      announcedAgentUpdates.delete(kind);
      void dismissNotification(`agent-update-${kind}`);
    }
  }, [updateAgent, updatingAgent]);
  // refresh applied voice state only after the shared file transaction commits
  const refreshDavo = useCallback(async () => {
    try {
      const response = await request('/api/auth/session', { cache: 'no-store' });
      const payload = await response.json().catch(() => undefined) as { davo?: unknown } | undefined;
      // retain known runtime state when a read is unavailable
      if (!response.ok || !isDavoSettings(payload?.davo)) return;
      const davo = payload.davo;
      setSessionInfo(current => current === undefined ? current : { ...current, davo });
    } catch {
      // a failed runtime read must not turn a durable save into a failed write
    }
  }, []);
  // disable only the feature gate without resending stale session name or context
  const disableDavo = useCallback(async (): Promise<string | undefined> => {
    const response = await request('/api/settings', { cache: 'no-store' });
    // refuse to invent a file revision when the catalog is unavailable
    if (!response.ok) return await settingsResponseError(response, 'Unable to load voice settings.');
    const snapshot: unknown = await response.json().catch(() => undefined);
    // require the authoritative source capability before writing
    if (!isSettingsSnapshot(snapshot)) return 'Unable to load voice settings.';
    const source = snapshot.sources.find(candidate => candidate.id === 'app');
    // invalid application JSON needs source repair not a destructive fallback
    if (source === undefined || !source.writable || source.value === undefined) return 'Repair the application config before disabling voice.';
    const path = ['integrations', 'realtime', 'enabled'];
    const revisionId = source.pathRevisions?.[JSON.stringify(path)];
    const saved = await request('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ sourceId: source.id, revisionId: source.revisionId, patches: [{ op: 'set', path, value: false, ...(revisionId === undefined ? {} : { revisionId }) }] }] }) });
    // never retry a failed or ambiguous commit automatically
    if (!saved.ok) return await settingsResponseError(saved, 'Unable to disable Davo.');
    await refreshDavo();
    return undefined;
  }, [refreshDavo]);
  // open or restore one shared update review
  const openServerUpdate = useCallback(() => {
    setServerUpdateOpen(true);
    setServerUpdateMinimized(false);
  }, []);
  // restore focus to the visible update entry point
  const focusServerUpdateEntry = useCallback(() => {
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.server-selector')?.focus());
  }, []);
  // hide one update review without stopping it
  const minimizeServerUpdate = useCallback(() => {
    setServerUpdateMinimized(true);
    focusServerUpdateEntry();
  }, [focusServerUpdateEntry]);
  // discard one inactive update review
  const closeServerUpdate = useCallback(() => {
    setServerUpdateOpen(false);
    setServerUpdateMinimized(false);
    // remove only the server-update hash
    if (location.hash === '#server-update') history.replaceState(null, '', `${location.pathname}${location.search}`);
    focusServerUpdateEntry();
  }, [focusServerUpdateEntry]);
  // open the update review from its notification route
  useEffect(() => {
    const openFromHash = () => {
      // wait for authenticated controls
      if (state === 'ready' && location.hash === '#server-update') openServerUpdate();
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [openServerUpdate, state]);
  // load every configured Codex account and its limits
  const codexAccounts = useCallback(() => loadAccounts('/api/codex/accounts', 'Unable to load ChatGPT accounts.'), []);
  // switch the active Codex account and restart idle worktrees
  const switchCodexAccount = useCallback(async (id: string): Promise<{ account?: CodexAccount; restarts?: CodexAccountRestart[]; error?: string }> => {
    const response = await request('/api/codex/accounts/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    const payload = await response.json().catch(() => undefined) as { account?: unknown; restarts?: unknown; error?: unknown } | undefined;
    // require one sanitized switch result
    if (!response.ok || !isCodexAccount(payload?.account) || !Array.isArray(payload?.restarts) || !payload.restarts.every(isCodexAccountRestart)) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to switch ChatGPT accounts.' };
    return { account: payload.account, restarts: payload.restarts };
  }, []);
  // persist one account display name through the controlled boundary
  const renameCodexAccount = useCallback(async (id: string, label: string): Promise<{ account?: CodexAccount; error?: string }> => {
    const response = await request(`/api/codex/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) });
    const payload = await response.json().catch(() => undefined) as { account?: unknown; error?: unknown } | undefined;
    // reject malformed or mismatched rename results
    if (!response.ok || !isCodexAccount(payload?.account) || payload.account.id !== id) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to rename account.' };
    return { account: payload.account };
  }, []);
  // redeem one ChatGPT rate-limit reset credit
  const resetCodexAccount = useCallback(async (id: string): Promise<{ outcome?: CodexAccountResetOutcome; account?: CodexAccount; error?: string }> => {
    const response = await request(`/api/codex/accounts/${encodeURIComponent(id)}/reset`, { method: 'POST' });
    const payload = await response.json().catch(() => undefined) as { outcome?: unknown; account?: unknown; error?: unknown } | undefined;
    // require one documented reset outcome
    if (!response.ok || !isCodexAccountResetOutcome(payload?.outcome) || payload?.account !== undefined && !isCodexAccount(payload.account)) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to use the ChatGPT reset.' };
    return { outcome: payload.outcome, ...(payload.account === undefined ? {} : { account: payload.account }) };
  }, []);
  // save a key through the authenticated server boundary
  const addCodexApiKeyAccount = useCallback(async (apiKey: string): Promise<{ account?: CodexAccount; error?: string }> => {
    const response = await request('/api/codex/accounts/api-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }) });
    // discard malformed responses without exposing credential-bearing content
    const payload = await response.json().catch(() => undefined) as { account?: unknown } | undefined;
    // keep server and provider diagnostics out of the credential form
    if (!response.ok || !isCodexAccount(payload?.account)) return { error: 'Unable to save API key. Check the key and try again.' };
    return { account: payload.account };
  }, []);
  // start one ChatGPT device-code login
  const startCodexAccountLogin = useCallback(async (repairAccountId?: string): Promise<{ login?: CodexAccountLogin; error?: string }> => {
    const response = await request('/api/codex/accounts/login', {
      method: 'POST',
      ...(repairAccountId === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repairAccountId }) })
    });
    const payload = await response.json().catch(() => undefined) as { login?: unknown; error?: unknown } | undefined;
    // require a safe HTTPS login target
    if (!response.ok || !isCodexAccountLogin(payload?.login)) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to start ChatGPT login.' };
    return { login: payload.login };
  }, []);
  // read one account-login state
  const codexAccountLoginStatus = useCallback(async (id: string): Promise<CodexAccountLoginStatus | undefined> => {
    const response = await request(`/api/codex/accounts/login/${encodeURIComponent(id)}`);
    const payload = await response.json().catch(() => undefined) as { status?: unknown; account?: unknown; error?: unknown } | undefined;
    const status = payload?.status;
    // retry transient failures through the polling loop
    if (!response.ok || status !== 'pending' && status !== 'succeeded' && status !== 'failed') return undefined;
    // reject malformed completed accounts
    if (payload?.account !== undefined && !isCodexAccount(payload.account)) return undefined;
    return { status, ...(payload?.account === undefined ? {} : { account: payload.account }), ...(typeof payload?.error === 'string' ? { error: payload.error } : {}) };
  }, []);
  // cancel one abandoned account login
  const cancelCodexAccountLogin = useCallback(async (id: string): Promise<boolean> => {
    const response = await request(`/api/codex/accounts/login/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return response.status === 204;
  }, []);
  const refreshSession = useCallback(async () => {
    try {
      const response = await consoleFetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
      if (response.status === 401) {
        setSessionInfo(undefined);
        setState('login');
        return;
      }
      if (response.ok) applySession(await response.json() as SessionInfo);
    } catch { /* keep the current screen while the reconnect overlay handles availability */ }
  }, [applySession]);
  // return an expired session to login
  const handleUnauthorized = useCallback(() => {
    setSessionInfo(undefined);
    setState('login');
  }, []);
  // refresh ownership after losing control
  const handleInactive = useCallback(() => {
    setState('checking');
    void refreshSession();
  }, [refreshSession]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let unobstructedHeight = Math.max(window.innerHeight, root.clientHeight, viewport?.height ?? 0);
    const editableFocused = () => {
      const element = document.activeElement;
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return !element.disabled;
      if (element instanceof HTMLInputElement) return !element.disabled && !element.readOnly && !['button', 'checkbox', 'file', 'hidden', 'radio', 'range', 'reset', 'submit'].includes(element.type);
      return element instanceof HTMLElement && element.isContentEditable;
    };
    const updateHeight = () => {
      const visibleHeight = viewport?.height ?? window.innerHeight;
      const focused = editableFocused();
      const currentLayoutHeight = Math.max(window.innerHeight, root.clientHeight);
      if (!focused) unobstructedHeight = Math.max(currentLayoutHeight, visibleHeight);
      const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
      const layoutHeight = Math.max(currentLayoutHeight, touchDevice ? unobstructedHeight : 0);
      const keyboardInset = layoutHeight - visibleHeight;
      root.style.setProperty('--app-height', `${visibleHeight}px`);
      root.classList.toggle('software-keyboard-open', focused && keyboardInset >= Math.max(120, layoutHeight * .15));
    };
    const updateAfterFocus = () => window.requestAnimationFrame(updateHeight);
    updateHeight();
    window.addEventListener('resize', updateHeight);
    viewport?.addEventListener('resize', updateHeight);
    viewport?.addEventListener('scroll', updateHeight);
    document.addEventListener('focusin', updateAfterFocus);
    document.addEventListener('focusout', updateAfterFocus);
    return () => {
      window.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('scroll', updateHeight);
      document.removeEventListener('focusin', updateAfterFocus);
      document.removeEventListener('focusout', updateAfterFocus);
      root.classList.remove('software-keyboard-open');
    };
  }, []);
  useEffect(() => {
    return subscribeToConsoleConnection(reachable => {
      setReconnecting(!reachable);
      if (reachable) setReconnectAttempt(attempt => attempt + 1);
    });
  }, []);
  // poll cross-instance attention for authenticated screens
  useEffect(() => {
    // clear stale attention after logout
    if (state === 'checking' || state === 'login') {
      setServerStatuses({});
      return;
    }
    // avoid an unnecessary poll on single-instance consoles
    if (serverInfo.remotes.length === 0) {
      setServerStatuses(current => sameServerStatuses(current, {}) ? current : {});
      return;
    }
    let active = true;
    // refresh the sanitized aggregate
    const refreshServerStatuses = async () => {
      try {
        const response = await request('/api/server-statuses', { signal: AbortSignal.timeout(8_000) }, false);
        // reject unsuccessful aggregate responses
        if (!response.ok) throw new Error('status aggregate unavailable');
        const snapshot = serverStatusesFrom(await response.json());
        // reject malformed aggregate responses
        if (snapshot === undefined) throw new Error('invalid status aggregate');
        // ignore a response after cleanup
        if (!active) return;
        setServerStatuses(current => sameServerStatuses(current, snapshot.attention) ? current : snapshot.attention);
        const local = snapshot.servers.find(candidate => candidate.url === serverInfo.url);
        // refresh names and icons published by every server
        if (local !== undefined) {
          const remotes = snapshot.servers.filter(candidate => candidate.url !== serverInfo.url).map(({ name, url, icon, defaultName, defaultIcon }) => ({ name, url, ...(icon === undefined ? {} : { icon }), ...(defaultName === undefined ? {} : { defaultName }), ...(defaultIcon === undefined ? {} : { defaultIcon }) }));
          setServerInfo(current => {
            const unchanged = current.name === local.name && current.url === local.url && current.icon === local.icon && current.remotes.length === remotes.length && remotes.every((remote, index) => current.remotes[index]?.name === remote.name && current.remotes[index]?.url === remote.url && current.remotes[index]?.icon === remote.icon && current.remotes[index]?.defaultName === remote.defaultName && current.remotes[index]?.defaultIcon === remote.defaultIcon);
            return unchanged ? current : { name: local.name, url: local.url, ...(local.icon === undefined ? {} : { icon: local.icon }), remotes };
          });
        }
      } catch {
        // replace stale remote attention with explicit unavailability
        if (active) {
          const unavailable: Record<string, InstanceAttention> = Object.fromEntries([[serverInfo.url, 'idle'], ...serverInfo.remotes.map(remote => [remote.url, 'unavailable'] as const)]);
          setServerStatuses(current => sameServerStatuses(current, unavailable) ? current : unavailable);
        }
      }
    };
    const stopPolling = pollWhileVisible(refreshServerStatuses, 5_000, true, 30_000);
    // stop updates after screen changes
    return () => {
      active = false;
      stopPolling();
    };
  }, [reconnectAttempt, serverInfo, state]);
  useEffect(() => {
    if (!reconnecting) return;
    let closed = false;
    let timer: number | undefined;
    const probe = async () => {
      try {
        const response = await fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
        if (response.ok) {
          setConsoleReachable(true);
          return;
        }
      } catch { /* Keep the overlay visible and retry. */ }
      if (!closed) timer = window.setTimeout(() => void probe(), 1_000);
    };
    void probe();
    return () => {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [reconnecting]);
  useEffect(() => {
    if (currentUiVersion === undefined) return;
    let closed = false;
    const checkForUpdate = async () => {
      try {
        const response = await consoleFetch('/api/ui-version', { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
        if (!response.ok || closed) return;
        const payload = await response.json() as { version?: unknown };
        if (typeof payload.version === 'string' && payload.version !== currentUiVersion) setClientUpdateAvailable(true);
      } catch { /* Retry at the next interval. */ }
    };
    const stopPolling = pollWhileVisible(checkForUpdate, 30_000, false);
    return () => { closed = true; stopPolling(); };
  }, []);
  // check origin main while the controlling console is open
  useEffect(() => {
    // avoid host fetches before authentication
    if (state !== 'ready') return;
    let closed = false;
    const checkForServerUpdate = async () => {
      const response = await request('/api/server/update-available', { signal: AbortSignal.timeout(30_000) }, false);
      // retry unavailable checks later
      if (!response.ok || closed) return;
      const payload: unknown = await response.json().catch(() => undefined);
      // reject malformed availability data
      if (!isServerUpdateAvailability(payload)) return;
      // latch a discovered upstream update or rebuild retry
      if (payload.available) setServerUpdateAvailable(true);
      // notify only for commits missing from local main
      if (!payload.available || payload.commitCount === undefined || payload.commitCount === 0) {
        announcedServerUpdateTarget.current = undefined;
        void dismissNotification('rac-update');
        return;
      }
      const target = payload.targetSha ?? `count:${payload.commitCount}`;
      // suppress repeat polling alerts
      if (announcedServerUpdateTarget.current === target) return;
      announcedServerUpdateTarget.current = target;
      void showNotification('system', 'Remote Agent Console update available', `${payload.commitCount} ${payload.commitCount === 1 ? 'commit' : 'commits'} upstream`, 'rac-update', '/#server-update');
    };
    const stopPolling = pollWhileVisible(checkForServerUpdate, 300_000, true, 1_800_000);
    return () => {
      closed = true;
      stopPolling();
    };
  }, [reconnectAttempt, state]);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setError('');
      try {
        const session = await consoleFetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
        if (session.ok) {
          const current = await session.json() as SessionInfo;
          if (active) applySession(current);
          return;
        }
        const bootstrap = await consoleFetch('/api/auth/bootstrap', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
        if (!bootstrap.ok) throw new Error('bootstrap unavailable');
        const payload = await bootstrap.json() as { csrfToken?: unknown; server?: unknown };
        if (typeof payload.csrfToken !== 'string') throw new Error('invalid bootstrap');
        csrf = payload.csrfToken;
        // publish unauthenticated server identity
        if (isServerInfo(payload.server)) setServerInfo(payload.server);
      } catch {
        if (active) setError('Unable to connect to the console');
      }
      if (active) setState('login');
    })();
    return () => { active = false; };
  }, [applySession, reconnectAttempt]);
  useEffect(() => {
    if (state === 'checking' || state === 'login') return;
    const checkControl = () => void refreshSession();
    window.addEventListener('focus', checkControl);
    return () => window.removeEventListener('focus', checkControl);
  }, [refreshSession, state]);
  const screen = state === 'checking'
      ? <LoadingScreen />
      : state === 'ready'
        ? <NoteFeedbackProvider><DashboardView onUnauthorized={handleUnauthorized} onInactive={handleInactive} updateError={agentUpdateError} onDismissUpdateError={() => { /* dismiss only the agent update failure */ setAgentUpdateError(''); }} /></NoteFeedbackProvider>
        : (state === 'inactive' || state === 'naming') && sessionInfo !== undefined
          ? <ControlScreen session={sessionInfo} claimed={applySession} />
          : <Login initialError={error} done={applySession} />;
  // expose settings without a manual server update bypass
  const clientSettings = useMemo<ClientSettings | undefined>(() => state === 'ready' && sessionInfo?.deviceName !== undefined ? { deviceName: sessionInfo.deviceName, serverName: serverInfo.name, serverUrl: serverInfo.url, clientUpdateAvailable, serverUpdateAvailable, serverUpdateVisible: serverUpdateOpen && !serverUpdateMinimized, serverUpdateMinimized, davo: sessionInfo.davo ?? legacyDavoSettings, renameClient, renameServer, loadServerRevision, reloadClient, openServerUpdate, disableDavo, refreshDavo, codexAccounts, claudeAccounts: loadClaudeAccounts, switchCodexAccount, renameCodexAccount, resetCodexAccount, addCodexApiKeyAccount, startCodexAccountLogin, codexAccountLoginStatus, cancelCodexAccountLogin } : undefined, [addCodexApiKeyAccount, cancelCodexAccountLogin, clientUpdateAvailable, codexAccountLoginStatus, codexAccounts, loadServerRevision, openServerUpdate, reloadClient, renameClient, renameServer, renameCodexAccount, resetCodexAccount, serverInfo.name, serverInfo.url, serverUpdateAvailable, serverUpdateMinimized, serverUpdateOpen, sessionInfo?.davo, sessionInfo?.deviceName, startCodexAccountLogin, state, switchCodexAccount, disableDavo, refreshDavo]);
  // share the current launch settings with every flyout
  const agentLaunchSettings = useMemo(() => ({ statuses: agentUpdateStatuses, updating: updatingAgent, errors: Array.from(new Set([defaultAgentError, versionCheckError, ...agentUpdateStatuses.map(status => status.error ?? '')].filter(Boolean))), defaultAgent: sessionInfo?.defaultAgent, defaultPending: defaultAgentPending, setDefaultAgent: (kind: AgentKind) => { /* persist one default */ void selectDefaultAgent(kind); }, updateAgent: (kind: AgentKind) => { /* run one installer */ void runAgentUpdate(kind); } }), [agentUpdateStatuses, updatingAgent, versionCheckError, defaultAgentError, sessionInfo?.defaultAgent, defaultAgentPending, selectDefaultAgent, runAgentUpdate]);
  return <SettingsRuntimeProvider request={request} enabled={sessionInfo !== undefined} canMutate={state === 'ready'} beforeRestart={beforeRestart} onRestartSettled={onRestartSettled}><ServerContext.Provider value={serverInfo}><ServerStatusContext.Provider value={serverStatuses}><ClientSettingsContext.Provider value={clientSettings}><AgentLaunchSettingsContext.Provider value={agentLaunchSettings}>{screen}{state !== 'ready' && sessionInfo !== undefined && <StandaloneSettingsRestartNotice />}<ContextMenuHost /><ContextFlyoutEvents /><ServerUpdateDialog open={serverUpdateOpen} minimized={serverUpdateMinimized} onMinimize={minimizeServerUpdate} onClose={closeServerUpdate} /><ConsoleFullscreenLoader action={action} reconnecting={reconnecting} onEntered={fullscreenActionEntered} /></AgentLaunchSettingsContext.Provider></ClientSettingsContext.Provider></ServerStatusContext.Provider></ServerContext.Provider></SettingsRuntimeProvider>;
}
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
// Reflect the stored flavour before the first render, now that the stylesheet is
// registered so `--base` resolves for the browser-chrome colour. A future ticket
// moves this ahead of first paint with an inline head script.
applyColorTheme();
applyReducedMotion();
applyFlyoutMarkers();
createRoot(document.getElementById('root')!).render(<ConsoleBoundary><App /></ConsoleBoundary>);
