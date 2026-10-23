import type { AdapterCapability, AgentKind, AttentionState, InlineQuestion } from '../adapters/types.js';
import type { ProjectButtons } from '../config/buttons.js';

export type SocketRef = { fingerprint: string; path: string; device: number; inode: number };
// `role` is the console's pane-role marker (`@rac_role`): `shell` on a Console shell the
// operator created, so launch adoption, Remove's blind kill and cleanup all skip it, and
// discovery can count a Worktree's shells; `process` on a Stack process's pane, whose
// `processName` (its window's `@rac_process`) names it in the picker. `paneName`
// (`@rac_pane_name`) is the operator's name for a Console shell, empty by default (the picker
// then falls back to `command · ~/path`).
// `placeMark` is the pane's session's `@rac_place`, the id of the Place whose Workspace the
// session is: every pane of the session belongs there, wherever its shell has `cd`'d.
// `reviewRun` is the pane's `@rac_review_run`, the id of the interactive Review run that
// launched it (ADR 0010); the Agent carries it too.
// shared snapshots also retain dead stack panes without a cwd; live listings omit them
export type Pane = { paneId: string; sessionId: string; sessionName?: string; windowId?: string; pid: number; path: string; title: string; displayLabel?: string; command: string; startCommand?: string; reportedAttention?: string; reportedSession?: string; reportedSandboxed?: string; reportedQuestion?: string; consoleManaged?: boolean; role?: string; processName?: string; paneName?: string; paneMode?: string; placeMark?: string; reviewRun?: string; processWorktree?: string; dead?: boolean; exitCode?: number; keyBinding?: string; socket: SocketRef };
// a dashboard pane read distinguishes a complete listing from a known failed read
export type PaneListingSnapshot = { status: 'available'; panes: readonly Pane[] } | { status: 'unavailable' };
export type PullRequestIssues = { mergeConflicts?: boolean; failingChecks?: boolean; unresolvedComments?: boolean };
export type PullRequestCheckStatus = 'passed' | 'pending' | 'failed';
export type PullRequestSummary = { number: number; title: string; status: 'draft' | 'open' | 'merged'; url: string; baseBranch?: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues; unresolvedThreads?: number };
// One comment on a Pull request as the console reads it from GitHub; `bot` is a GitHub App author
export type PullRequestComment = { id: string; author: string; bot: boolean; body: string; createdAt: string; url: string };
// A Review thread: comments anchored to lines of one file; `line`/`startLine` fall back to the
// original lines once the thread is outdated, and `diffHunk` is the code the first comment was on
export type PullRequestReviewThread = { id: string; path: string; line?: number; startLine?: number; resolved: boolean; outdated: boolean; diffHunk: string; comments: PullRequestComment[] };
export type PullRequestReviewSummary = PullRequestComment & { state: string };
// `description` is the pull request's own body, the comment its author opened it with
export type PullRequestComments = { number: number; url: string; description?: PullRequestComment; threads: PullRequestReviewThread[]; reviews: PullRequestReviewSummary[]; comments: PullRequestComment[] };
export const stackActions = ['start', 'stop', 'build', 'restart', 'migrate'] as const;
export type StackAction = typeof stackActions[number];
// `status` (a health probe) and `setup` (a run-once, worktree-creation hook) are commands
// but not operator actions, so they live here yet are absent from `stackActions`.
// `processes` maps each Stack process's name to its foreground command, in display order
// (config/schema.ts caps the count), as the config writes it: a command string, or the
// command with the processes it `dependsOn`, which order its Start (stack-processes.ts);
// they derive start/stop/restart and the running state, so they never sit beside those.
export type StackProcessCommand = string | { command: string; dependsOn?: string[] };
export type StackCommands = Partial<Record<StackAction | 'status' | 'setup', string>> & { processes?: Record<string, StackProcessCommand> };
// A Process notice as the dashboard serves it: a message a Stack process reported about its own
// run, and, when it names a discovered Worktree, that Worktree as the dashboard labels it, with
// the process it names there and that process's state when the Worktree declares it
export type ProcessNotice = { level: 'warning' | 'info'; message: string; target?: { worktreeId: string; label: string; process?: string; state?: 'exited' | 'stopped' } };
// A process in another Worktree that a Stack process reported it uses, as the dashboard serves
// it: when its checkout is a discovered Worktree that declares it, that Worktree, labelled
// "<Project> / <Worktree>", and the process's state there, running or not; otherwise only the
// checkout path as its label, with nothing to act on
export type ProcessUse = { worktreeId?: string; label: string; process: string; state?: 'running' | 'exited' | 'stopped'; exitCode?: number };
// one Stack process as tmux shows it: its pane live, dead with the exit status tmux kept
// (absent after a signal), or no window at all; `operation` is an action on it alone in flight,
// `notices` the Process notices it reported that are showing, `dependsOn` the processes here it
// needs and `uses` those in other Worktrees it last reported using, each absent when empty
export type StackProcessState = { name: string; state: 'running' | 'exited' | 'stopped'; exitCode?: number; operation?: StackAction; notices?: ProcessNotice[]; dependsOn?: string[]; uses?: ProcessUse[] };
// canonical checkout settings with project defaults already resolved
export type WorktreeOverride = { path: string; commands?: StackCommands; projectUrl?: string; projectPort?: number };
export type PromptAction = { label: string; prompt: string };
export type GitStatusChange = { code: string; path: string; originalPath?: string; additions?: number; deletions?: number; category?: 'implementation' | 'test' | 'doc' };
export type GitStatusSummary = { files: number; staged: number; unstaged: number; untracked: number; conflicted: number; changes?: GitStatusChange[] };
export type GitComparisonSummary = { base: string; files: number; changes?: GitStatusChange[] };
export type GitUpstreamSummary = { upstream: string; ahead: number; behind: number };
export type Agent = { id: string; paneId: string; sessionId: string; socketFingerprint: string; home: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; title: string; kind: AgentKind; attention: AttentionState; hasMessageQuestion?: true; sandboxed?: boolean; conversationId?: string; displayLabel?: string; placeId?: string; projectId?: string; worktreeId?: string; newTaskConfigured?: boolean; push?: PromptAction; projectUrl?: string; projectProxied?: boolean; pullRequest?: PullRequestSummary; question?: InlineQuestion; paneMode?: string; reviewRun?: string };
// An Agent's `sessionId` is the console's composite id `${socketFingerprint}:${tmuxSession}`
// (discovery keys agents that way). Recover the raw tmux session name a command targets.
// whether an Agent is an interactive Review run's own (ADR 0010): it belongs to its run, so the
// Worktree's own flows (launch matching, Restart, switch chat, a Run's reuse) never count or take it
export const isReviewRun = (agent: Pick<Agent, 'reviewRun'>): boolean => agent.reviewRun !== undefined;
// the operator's own Agents in one Worktree: every Agent there but a Review run's
export const worktreeAgents = <T extends Pick<Agent, 'worktreeId' | 'reviewRun'>>(agents: readonly T[], worktreeId: string): T[] => agents.filter(agent => agent.worktreeId === worktreeId && !isReviewRun(agent));
export const agentTmuxSession = (agent: Pick<Agent, 'sessionId' | 'socketFingerprint'>): string => agent.sessionId.slice(agent.socketFingerprint.length + 1);
/**
 * A configured directory the console manages (config `projects[]`). A `repository`
 * Project's identity is the realpath of its common git directory, so two entries
 * pointing at the same repository are refused as duplicates and a Project may be
 * configured through any of its checkouts (ADR 0003). A `directory` Project's path
 * exists but is not a git checkout: it has no Worktrees and an agent launches directly
 * in it, like Scratch, so its identity is just its own realpath'd path. `path` is
 * unavailable only when it is missing at boot, which loads the Project as
 * `available: false` rather than failing to boot. stack commands and preview settings
 * are defaults; canonical worktree overrides replace them for individual checkouts.
 * discovered worktrees denormalise the resolved settings for convenience. An `implicit`
 * Project is an unconfigured git repository that a tmux session mark or a pin names (ADR 0014),
 * loaded as a config entry naming only its path would be; it is never written to config.
 */
export type Project = { id: string; implicit?: true; label: string; defaultBranch?: string; path: string; identity: string; mode: 'repository' | 'directory'; hostPath?: string; worktreeOrder?: string[]; worktreeOverrides?: WorktreeOverride[]; worktreesDirectory: string; available: boolean; unavailableReason?: string; commands?: StackCommands; newTask?: string; buttons?: ProjectButtons; push: PromptAction; projectUrl?: string; projectPort?: number };
/**
 * One checkout of a Project as `git worktree list` reports it, keyed by the wire id
 * `<projectId>:<realpath>` (ADR 0003). `identity` equals the checkout's realpath
 * (this Worktree's own git toplevel) and is what an Agent's home matches; a
 * Docker main Worktree also matches its `hostPath`. `main`/`detached`/`locked` come
 * from git; a Stale worktree (git's `prunable`) is excluded by discovery, never carried
 * here. `pinned` and `customLabel` identify the operator's per-Worktree choices from
 * `.data`. resolved stack commands and preview settings, plus project-wide newTask/push,
 * are copied on so worktree-scoped services keep reading them from the worktree.
 */
export type Worktree = { id: string; projectId: string; defaultBranch?: string; label: string; customLabel?: boolean; path: string; identity: string; hostPath?: string; available: boolean; pinned: boolean; main: boolean; detached: boolean; locked: boolean; lockedReason?: string; branch?: string; sha?: string; commands?: StackCommands; newTask?: string; push?: PromptAction; projectUrl?: string; projectPort?: number };
export type CleanupTargetKind = 'orphan-worker' | 'stale-agent' | 'hud-pane' | 'hud-process' | 'merged-branch' | 'closed-pr-branch';
export type CleanupTarget = { id: string; kind: CleanupTargetKind; label: string; detail: string };
/**
 * One Worktree on the wire. Carries the git identity fields the web renders (label,
 * whether that label was explicitly saved, branch/sha, main/detached/locked, pin), a stable tab `order`, and — for a Worktree
 * with no live Agent — the same idle git metadata the flat list used to carry. Active
 * Worktrees omit the metadata (their Agent carries it).
 */
export type DashboardWorktree = { id: string; projectId: string; label: string; customLabel?: boolean; path: string; available: boolean; pinned: boolean; main: boolean; detached: boolean; locked: boolean; order: number; branch?: string; sha?: string; consoleShells?: number; projectUrl?: string; projectProxied?: boolean; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; pullRequest?: PullRequestSummary };
// `manageWorktrees` (with a reason when false) gates the Add/Remove/Prune controls: a
// Project whose checkout is missing, which is a non-git `directory` Project, or which the
// Docker bridge does not mount at its host path, cannot have Worktrees created or removed
// even when its Worktrees still show. `mode` distinguishes a git `repository` (launched
// through its Worktrees) from a non-git `directory` (launched in place, like Scratch — the
// web renders a Project-level Launch button for it). `stalePaths` are the checkouts an
// explicit Prune would clear (git's prunable entries plus console records whose path git
// lists nowhere, ADR 0003); the Project header shows their count as `N stale · Prune` and
// the confirm lists them by path. Empty when nothing is stale. `setup` is true only when
// the Project configures a `commands.setup`: the web shows a "running setup" notice while a
// new Worktree is being created, without ever receiving the (shell) command itself.
export type DashboardProject = { id: string; implicit?: true; label: string; mode: 'repository' | 'directory'; available: boolean; unavailableReason?: string; manageWorktrees: boolean; manageWorktreesReason?: string; stalePaths: string[]; setup?: boolean; worktrees: DashboardWorktree[] };
// One directory-Project or Scratch Place on the wire, beside the Worktrees `projects[]` already
// lists (a Worktree is a Place too, with the same id). Lists every available directory Project,
// the configured Scratch folder, and any other Scratch Place holding an Agent or a Console shell.
// `adhoc` marks such an other Scratch Place: the console cannot launch an Agent into it.
export type DashboardPlace = { id: string; kind: 'directory' | 'scratch'; projectId: string; label: string; home: string; adhoc?: true; pinned: boolean; consoleShells?: number };
export type Dashboard = { generation: number; serverStartedAt?: number; adapters: Partial<Record<AgentKind, AdapterCapability>>; agents: Agent[]; projects: DashboardProject[]; places: DashboardPlace[] };
