import type { DashboardPayload } from '../dashboard/updates.js';
import type { GitComparisonSummary, GitStatusSummary, GitUpstreamSummary, PullRequestSummary, StackAction, StackProcessState } from '../domain/models.js';
import type { AgentAttentionState } from '../notifications.js';
import type { PromptHistoryEntry } from '../prompt-history/service.js';
import type { QueuedPromptSummary } from '../prompts/queue.js';
import type { PullRequestSwitchAvailability } from '../pull-requests/switch-service.js';
import type { StoredReviewTour, StoredReviewTourSummary } from '../review-tour/contracts.js';
import type { ReviewTourInput } from '../review-tour/contracts.js';
import type { WorkspaceFilePreview } from '../workspace-files/service.js';
import type { StackOperationLog } from '../worktree-commands/service.js';

export const orchestrationContractVersion = 'v1' as const;

export type OrchestrationErrorCode = 'invalid_request' | 'not_found' | 'conflict' | 'unavailable' | 'operation_failed';
export type OrchestrationError = { code: OrchestrationErrorCode; message: string; retryable: boolean };
export type OrchestrationResult<T> =
  | { ok: true; version: typeof orchestrationContractVersion; value: T }
  | { ok: false; version: typeof orchestrationContractVersion; error: OrchestrationError };

export type InstanceV1 = {
  id: string;
  name: string;
  url: string;
  local: boolean;
  icon?: string;
};

export type AgentStatusV1 = {
  id: string;
  title: string;
  label: string;
  projectId?: string;
  worktreeId?: string;
  branch?: string;
  gitStatus?: GitStatusSummary;
  gitPrStatus?: GitComparisonSummary;
  gitUpstream?: GitUpstreamSummary;
  pullRequest?: PullRequestSummary;
  projectUrl?: string;
  projectProxied?: boolean;
  question?: { id: string; text: string; choices: string[] };
  attention: AgentAttentionState;
  unread: boolean;
};

export type StackStateV1 = {
  actions: StackAction[];
  running?: boolean;
  transition?: 'starting' | 'migrating';
  operation?: StackAction;
  tunnel?: boolean;
  processes?: Pick<StackProcessState, 'name' | 'state' | 'exitCode' | 'operation'>[];
};

export type WorktreeStatusV1 = {
  id: string;
  label: string;
  available: boolean;
  pinned: boolean;
  active: boolean;
  order: number;
  agentIds: string[];
  projectUrl?: string;
  projectProxied?: boolean;
  branch?: string;
  gitStatus?: GitStatusSummary;
  gitPrStatus?: GitComparisonSummary;
  gitUpstream?: GitUpstreamSummary;
  pullRequest?: PullRequestSummary;
  stack?: StackStateV1;
  review?: StoredReviewTourSummary;
};

export type LatestResponseV1 = {
  text: string;
  source: 'terminal' | 'history';
  truncated: boolean;
};

export type LogTailV1 = {
  text: string;
  rows: number;
  older: boolean;
  truncated: boolean;
};

export type PromptHistoryV1 = { prompts: PromptHistoryEntry[] };
export type QueuedPromptsV1 = { prompts: QueuedPromptSummary[] };
export type FilePreviewV1 = WorkspaceFilePreview;

export type PullRequestStatusV1 = {
  current?: PullRequestSummary;
  comparison?: GitComparisonSummary;
  switching?: PullRequestSwitchAvailability;
  actionsUrl?: string;
};

export type ReviewStatusV1 = {
  summary?: StoredReviewTourSummary;
  review?: StoredReviewTour;
};

export type StackStatusV1 = StackStateV1 & { log?: StackOperationLog };

export type WorkspaceSummaryEntryV1 = {
  id: string;
  label: string;
  active: boolean;
  agents: number;
  attention: AgentAttentionState | 'inactive';
  branch?: string;
  changes: number;
};

export type WorkspaceSummaryV1 = {
  text: string;
  worktrees: WorkspaceSummaryEntryV1[];
  scratchAgents: Array<{ id: string; label: string; attention: AgentAttentionState }>;
};

export type AttentionSummaryV1 = {
  state: 'idle' | 'working' | 'question' | 'completed';
  text: string;
  agents: Array<{ id: string; label: string; attention: AgentAttentionState; unread: boolean }>;
};

export type PreviewFileInputV1 = {
  path: string;
  agentId?: string;
  worktreeId?: string;
  maxBytes?: number;
};

export type QueuePromptInputV1 = { agentId: string; prompt: string };
export type UpdateQueuedPromptInputV1 = { agentId: string; promptId: string; prompt: string };
export type MoveQueuedPromptInputV1 = { agentId: string; promptId: string; direction: 'earlier' | 'later' };
export type RemoveQueuedPromptInputV1 = { agentId: string; promptId: string };
export type AnswerQuestionInputV1 = { agentId: string; questionId: string; index: number };
// `process` narrows a Stack process's own action to that one process
export type RunStackActionInputV1 = { worktreeId: string; action: StackAction; process?: string };
export type SwitchPullRequestInputV1 = { agentId: string; number: number };
export type StartReviewInputV1 = { agentId: string } & ReviewTourInput;

export type EnrichedDashboard = DashboardPayload;

// The Conductor's GitHub reads (ADR 0018 amendment): the console's cached GitHub data, held to the
// repositories of the configured Projects its Places admit.
export type GithubRefreshV1 = 'cached' | 'if_stale' | 'now';
/**
 * How old the data is and what this call did about GitHub. `state` is `cold` while it was never
 * read (so nothing listed means unknown, not none), `failed` when the last read failed beside older
 * data, `stale` past a minute, else `fresh`. `network` adds `rate_limited` and `no_token` to the
 * module's outcomes for a failed read. `backgroundPoll` says whether a browser keeps the poll going.
 */
export type GithubFreshnessV1 = {
  state: 'fresh' | 'stale' | 'cold' | 'failed'; fetchedAt: string | null; ageSeconds: number | null;
  network: 'none' | 'not_needed' | 'joined' | 'fetched' | 'throttled' | 'rate_limited' | 'no_token' | 'failed';
  problem: { kind: 'no_token' | 'rate_limited' | 'failing'; message: string; retryAt: string | null } | null;
  backgroundPoll: 'browser' | 'none';
};
/** A place in the console an item can go: a Worktree holding it, or else its Project's main worktree. Seeing one grants nothing. */
export type GithubDestinationV1 = { kind: 'worktree' | 'project'; worktreeId: string; projectId: string; label: string; branch?: string };
/** One reason a row may need the operator, as the GitHub panel shows it, and whether they have not been shown it yet. */
export type GithubReasonV1 =
  | { kind: 'thread'; threadId: string; path: string; lastAuthor: string; new: boolean }
  | { kind: 'checks'; new: boolean }
  | { kind: 'conflicts'; new: boolean }
  | { kind: 'changes'; reviewId: string; reviewer: string; new: boolean }
  | { kind: 'review'; reRequested: boolean; new: boolean };
export type GithubOverviewRowV1 = {
  repository: string; number: number; title: string; url: string; author?: string; updatedAt?: string; draft: boolean; labels: string[];
  waitingOnMe: GithubReasonV1[]; destinations: GithubDestinationV1[];
  // pull requests
  headSha?: string; mergeable?: 'mergeable' | 'conflicting' | 'unknown'; checks?: 'passed' | 'failed' | 'pending'; approved?: true; closes?: number[];
  request?: { direct: boolean; reRequested: boolean }; myLatestReview?: { state: 'approved' | 'changes' | 'commented' | 'dismissed'; atHead: boolean }; newCommitsSinceMyReview?: true;
  // issues
  linkedPullRequests?: number[];
};
/** One list's coverage: rows returned, in-scope rows cached, whether GitHub's search gave every row (null while unknown), and whether `limit` cut the rest. */
export type GithubListCoverageV1 = { returned: number; inScope: number; complete: boolean | null; pageLimit: number; truncatedByRequest: boolean };
export type GithubOverviewV1 = {
  freshness: GithubFreshnessV1;
  coverage: { viewer: string | null; repositories: string[]; lists: Partial<Record<'mine' | 'reviews' | 'issues', GithubListCoverageV1>>; notCovered: string[] };
  // null while never read
  mine?: GithubOverviewRowV1[] | null; reviews?: GithubOverviewRowV1[] | null; issues?: GithubOverviewRowV1[] | null;
};
export type GithubOverviewInputV1 = { lists?: ('mine' | 'reviews' | 'issues')[]; waitingOnly?: boolean; repository?: string; limit?: number; refresh?: GithubRefreshV1 };
/** A comment's text as GitHub holds it: untrusted, and cut at the caller's bound when `truncated`. */
export type GithubTextV1 = { text: string; truncated?: true };
export type GithubCommentV1 = { id: string; author: string; bot: boolean; mine: boolean; createdAt: string; url: string; body: GithubTextV1 };
export type GithubDiscussionEntryV1 =
  | ({ type: 'description' } & GithubCommentV1)
  | ({ type: 'review'; state: string } & GithubCommentV1)
  | ({ type: 'comment' } & GithubCommentV1)
  | { type: 'thread'; id: string; path: string; line?: number; startLine?: number; resolved: boolean; outdated: boolean; lastSpeakerIsMe: boolean; diffHunk?: GithubTextV1; comments: GithubCommentV1[]; omittedComments: number; olderCommentsMayBeMissing: boolean };
export type GithubPullRequestV1 = {
  freshness: GithubFreshnessV1;
  repository: string; number: number;
  // null while never read, or when GitHub has no such pull request
  pullRequest: null | {
    summary?: {
      title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean; author?: string; mine: boolean; updatedAt?: string;
      baseBranch?: string; branch: string; headSha: string; headOnOrigin: boolean; mergeable: 'mergeable' | 'conflicting' | 'unknown'; checks: 'passed' | 'failed' | 'pending';
      linkedIssues: { number: number; title: string; url: string; state: 'open' | 'closed' }[]; destinations: GithubDestinationV1[];
    };
    checks?: { runs: { name: string; status: 'passed' | 'failed' | 'pending' | 'skipped'; url?: string }[]; mayBeTruncated: boolean };
    reviewers?: { reviewers: { login: string; team?: true; bot?: true; state?: 'approved' | 'changes' | 'commented' | 'dismissed'; requested?: true; newCommitsSinceReview?: true }[]; mayBeTruncated: boolean; note: string };
    discussion?: { snapshot: string; entries: GithubDiscussionEntryV1[]; totalEntries: number; nextCursor: string | null; mayBeTruncated: { threads: boolean; reviews: boolean; comments: boolean } };
  };
};
export type GithubPullRequestInputV1 = {
  repository: string; number: number; sections?: ('summary' | 'checks' | 'reviewers' | 'discussion')[];
  threads?: 'unresolved' | 'all' | 'none'; includeOutdated?: boolean; includeDiffHunks?: boolean;
  maxBodyChars?: number; maxEntries?: number; maxThreadComments?: number; cursor?: string; refresh?: GithubRefreshV1;
};
