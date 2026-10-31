import { run } from '../tmux/command.js';
import { checkoutBranch, repositoryArgs, repositoryDefaultBranch } from '../git/worktrees.js';
import type { Project, PullRequestCheckStatus, PullRequestComment, PullRequestComments, PullRequestIssues, PullRequestReviewThread, PullRequestSummary, Worktree } from '../domain/models.js';
import { SeenRecord } from './seen.js';
import { createPullRequest, replyToThread, rerequestReviews, resolveThread } from './writes.js';
import { at, GithubClient, GithubRequestError, graphqlError, githubRepository, githubToken, repositoryPath, type Command, type GithubRepository, type GraphqlPayload, type Request, type Token } from './github.js';

export type PullRequestCleanupStatus = 'merged' | 'closed';
export type PullRequestChoice = { number: number; title: string; branch: string; headSha: string; headOnOrigin: boolean; draft: boolean; url: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };
export type OpenPullRequestChoices = { own: PullRequestChoice[]; others: PullRequestChoice[] };
export type RepositoryIssue = { number: number; title: string; url: string; author?: string; updatedAt?: string };
/** Why GitHub data may be missing or old: no token, a rate limit holding requests until `until`, or GitHub failing. */
export type GithubProblem = { kind: 'no-token' | 'rate-limited' | 'failing'; message: string; until?: number };
/** The last data GitHub gave, when it was fetched (never, while `fetchedAt` is absent), and why a later fetch failed. */
export type Fetched<T> = T & { fetchedAt?: number; problem?: GithubProblem };
export type BranchSummary = Fetched<{ pullRequest?: PullRequestSummary }>;
export type RepositoryPullRequests = Fetched<OpenPullRequestChoices & { issues: RepositoryIssue[] }>;
/**
 * Why a Pull request is Waiting on me: a current, unresolved Review thread someone else spoke last
 * on; failing checks; merge conflicts; a reviewer's changes requested on the head as it still is;
 * or a Review request, flagged when it was Re-requested.
 */
export type OverviewReason =
  | { kind: 'thread'; id: string; author: string; path: string }
  | { kind: 'checks' }
  | { kind: 'conflicts' }
  | { kind: 'changes'; id: string; author: string }
  | { kind: 'review'; reRequested?: true };
/** Where tapping an Overview row goes: the Worktree holding the item, or else its Project's main worktree. */
export type OverviewDestination = { kind: 'worktree' | 'project'; worktreeId: string; label: string };
/**
 * One row of the Overview. `reasons` is empty unless it is Waiting on me; `unseen` names the
 * reason instances the operator has not been shown yet, for `markSeen`. The rest are hints:
 * commits pushed since my review, an approval, a draft, the Issues a PR closes, the PRs linked to
 * an Issue, labels. `checks` is set on my own PRs only.
 */
export type OverviewItem = {
  repository: string; number: number; title: string; url: string; author?: string; updatedAt?: string;
  draft?: true; checks?: PullRequestCheckStatus; reasons: OverviewReason[]; unseen?: string[];
  newCommits?: true; approved?: true; closes?: number[]; linkedPullRequests?: number[]; labels?: string[];
  destination?: OverviewDestination;
};
/** The Overview's three lists, each GitHub's newest first, with how many GitHub found in all. */
export type Overview = Fetched<{ mine: OverviewItem[]; reviews: OverviewItem[]; issues: OverviewItem[]; totals: { mine: number; reviews: number; issues: number } }>;
/** A GitHub panel row: an Overview row, or one from the repository's own lists; `state` marks one merged or closed. */
export type PanelItem = OverviewItem & { state?: 'merged' | 'closed' };
/**
 * One repository's lists for the GitHub panel. Mine, Review requested and Assigned to me are the
 * Overview's rows for the repository; Other open and the other Issues are the rest of its open
 * lists; Merged or closed are the pull requests of its Worktrees' branches with none open. A row's
 * `destination` is only ever the Worktree holding it.
 */
export type GithubPanel = Fetched<{ mine: PanelItem[]; reviews: PanelItem[]; other: PanelItem[]; done: PanelItem[]; assigned: PanelItem[]; issues: PanelItem[] }>;
/** One check on a head: a check run or a commit status, with where to read it (http(s) only). */
export type PullRequestCheck = { name: string; status: 'passed' | 'failed' | 'pending' | 'skipped'; url?: string };
/**
 * A reviewer of a pull request: their latest submitted review (none while only asked), whether a
 * review is asked of them now (`requested`), and whether the head moved since they reviewed. `id`,
 * their node id, is what re-requesting their review names.
 */
export type PullRequestReviewer = { login: string; id?: string; bot?: true; team?: true; state?: 'approved' | 'changes' | 'commented' | 'dismissed'; requested?: true; newCommits?: true };
export type LinkedIssue = { number: number; title: string; url: string; state: 'open' | 'closed' };
/**
 * Everything the GitHub panel shows of one pull request, for any repository: its state, head and
 * mergeability, each check, its reviewers, the Issues it closes, and its conversation (the
 * description, Review threads with their diff hunks, review summaries and comments; `mine` marks
 * what the viewer wrote, so the last speaker is known). `destination` is the Worktree holding it.
 */
export type PullRequestDetail = PullRequestComments & {
  id: string; repository: string; title: string; state: 'open' | 'merged' | 'closed'; draft: boolean; author?: string; mine: boolean; updatedAt?: string;
  branch: string; baseBranch?: string; headSha: string; headOnOrigin: boolean; mergeable: 'mergeable' | 'conflicting' | 'unknown';
  checks: PullRequestCheckStatus; checkRuns: PullRequestCheck[]; reviewers: PullRequestReviewer[]; linkedIssues: LinkedIssue[];
  destination?: OverviewDestination;
};
export type LinkedPullRequest = { number: number; title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean };
/**
 * An open pull request asking the viewer for a review directly, not only through a team, with the
 * newest review requested event naming them (`request`), when GitHub's latest timeline items hold one.
 */
export type ViewerReviewRequest = { number: number; url: string; request?: string };
/** A new pull request's prefill: the Worktree's branch, the base it goes into, a title, and the Issue the Worktree was made for. */
export type PullRequestDraft = { branch: string; base: string; title: string; issue?: number };
/** One Issue: its header, labels and body, the pull requests in its repository linked to close it, and the Worktree holding one. */
export type IssueDetail = { repository: string; number: number; title: string; url: string; state: 'open' | 'closed'; author?: string; updatedAt?: string; body: string; labels: string[]; linkedPullRequests: LinkedPullRequest[]; destination?: OverviewDestination };
/** Runs the poll; injected so tests turn the clock by hand. */
export type Timer = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
export type GithubServiceOptions = { request?: Request; command?: Command; now?: () => number; token?: Token; timer?: Timer; projects?: () => readonly Project[]; worktrees?: () => readonly Worktree[]; seenFile?: string };

// one pull request as the module keeps it; `unresolvedThreads` and `closingIssues` are only known
// from a read that asked for them
type Pull = { number: number; title: string; url: string; author?: string; updatedAt?: string; state: 'open' | 'closed' | 'merged'; draft: boolean; baseBranch?: string; branch: string; headSha: string; headOnOrigin: boolean; mine: boolean; conflicts: boolean; checks: PullRequestCheckStatus; unresolvedThreads?: number; closingIssues?: number[] };
type Entry = { fetchedAt?: number; problem?: GithubProblem; refreshing?: Promise<void> };
type RepositoryEntry = Entry & { repository: GithubRepository; open?: Pull[]; issues?: RepositoryIssue[] };
// `pulls` are every pull request GitHub has for the branch's head (or its number, for a fork
// checkout); `complete` is false when GitHub has more than it gave, or gave one it could not read
// `remoteHeads` are the commits its remote ref has named lately (null for none), across every
// checkout of the branch, so two clones fetched at different times do not read as a push
type BranchEntry = Entry & { repository: GithubRepository; name: string; published: boolean; remoteHeads?: (string | null)[]; readAt?: number; pulls?: Pull[]; complete?: boolean };
// one repository in one GraphQL read: its lists, and the branches to look up
type Plan = { repository: GithubRepository; list: boolean; branches: BranchEntry[] };
type OriginEntry = { expiresAt?: number; pending: Promise<GithubRepository | undefined> };
// an Overview row as read, with the heads that find its Worktree (a PR's own, an Issue's linked
// PRs'), the seen-record keys of its reasons (`instances`), and those kept while GitHub has not
// decided whether a reason still holds (`held`)
type OverviewRow = Omit<OverviewItem, 'destination' | 'unseen'> & { heads: { number: number; branch: string; onOrigin: boolean }[]; instances: string[]; held: string[] };
// `requests` are the viewer's own review requests, kept only when GitHub gave the whole list
type OverviewEntry = Entry & { mine?: OverviewRow[]; reviews?: OverviewRow[]; issues?: OverviewRow[]; totals?: Overview['totals']; requests?: RepositoryReviewRequest[] };
type RepositoryReviewRequest = ViewerReviewRequest & { repository: string };
// one pull request's or Issue's detail as last read, with each version a list read may show it at
// (`versions`): a pull request's with its thread count, and without, as a branch lookup reads it
type DetailEntry<T> = Entry & { data?: T; versions?: string[]; failedAt?: number };
// what a list or branch lookup read of a pull request or Issue, and when
type Known = { version: string; fetchedAt: number };

// how often the poll runs while watched, and how old data may be before a read refreshes it
const freshMs = 60_000;
// how long a branch stays in the poll after its last read
const trackMs = 600_000;
const repositoryCacheTtlMs = 30_000;
// one page of open pull requests and issues: at 50, a repository's lists cost one point a poll
const openPage = 50;
const issuePage = 50;
// pull requests read for one head branch, newest first
const branchPage = 20;
// head branches looked up in one read
const maxBranches = 50;
const missingToken = 'GitHub authentication is not configured for pull request lookup.';
const readAction = 'GitHub could not read pull requests';
const detailAction = 'GitHub could not read the pull request';
const issueAction = 'GitHub could not read the Issue';
const requestsAction = 'GitHub could not read the review requests';
// bound the final heads one branch's ancestry check compares against, and the comparisons kept
const maxAncestorCompares = 3;
const maxCompares = 1_000;
const maxRemoteHeads = 8;
// details kept, the least recently read dropped first
const maxDetails = 100;
// a Refresh this soon after the last read answers from it, so repeated clicks cannot drain the budget
const refreshFloorMs = 10_000;
// how long GitHub's search takes to show the console's own writes
const searchLagMs = 10_000;
// the longest comment GitHub takes, and the longest pull request title
const maxCommentLength = 65_536;
const maxTitleLength = 256;
// a push goes over the network to origin
const pushTimeoutMs = 60_000;

const realTimer: Timer = {
  set: (run, ms) => setTimeout(run, ms).unref(),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

// the console-owned local branch a fork pull request checks out as, since its head branch
// lives in another repository; `forkCheckoutNumber` reads the number back from one
export const forkCheckoutBranch = (pullRequest: Pick<PullRequestChoice, 'number' | 'headSha'>): string => `rac/pr/${pullRequest.number}/${pullRequest.headSha.slice(0, 12)}`;
export function forkCheckoutNumber(branch: string): number | undefined {
  const match = /^rac\/pr\/([1-9]\d{0,9})\/[a-f0-9]{12}$/u.exec(branch);
  return match === null ? undefined : Number(match[1]);
}

// what every read takes of a pull request; the open lists and a waiting read of one branch also
// count its threads and the issues it closes
const pullFields = 'number title url updatedAt author{login} state isDraft baseRefName headRefName headRefOid isCrossRepository viewerDidAuthor mergeable statusCheckRollup{state}';
const fullPullFields = `${pullFields} reviewThreads(first:100){nodes{isResolved isOutdated}} closingIssuesReferences(first:10){nodes{number}}`;
// one pull request's detail, with `pullFields` so its version compares with the lists'; the newest
// threads and comments, so the last speaker is right on a long thread
const commentFields = 'id author{login __typename} body createdAt url viewerDidAuthor';
const detailQuery = `query PullRequestDetail($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  ${pullFields} id author{__typename} body createdAt
  statusCheckRollup{contexts(first:100){nodes{__typename ...on CheckRun{name status conclusion detailsUrl} ...on StatusContext{context state targetUrl}}}}
  reviewRequests(first:20){nodes{requestedReviewer{__typename ...on User{login id} ...on Bot{login id} ...on Mannequin{login} ...on Team{slug id}}}}
  latestReviews(first:20){nodes{author{login __typename ...on User{id} ...on Bot{id}} state commit{oid}}}
  closingIssuesReferences(first:10){nodes{number title url state repository{nameWithOwner}}}
  reviewThreads(last:100){nodes{id isResolved isOutdated path line startLine originalLine originalStartLine comments(last:50){nodes{${commentFields} diffHunk}}}}
  reviews(last:100){nodes{id author{login __typename} state body submittedAt url viewerDidAuthor}}
  comments(last:100){nodes{${commentFields}}}
}}}`;
const issueQuery = `query IssueDetail($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
  number title url state updatedAt author{login} body labels(first:20){nodes{name}}
  closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number title url state isDraft headRefName isCrossRepository repository{nameWithOwner}}}
}}}`;
// whether a review is asked of the viewer directly, and the newest request events naming them
const viewerRequestFields = 'reviewRequests(first:100){nodes{requestedReviewer{...on User{isViewer}}}} timelineItems(itemTypes:[REVIEW_REQUESTED_EVENT],last:20){nodes{...on ReviewRequestedEvent{id requestedReviewer{...on User{isViewer}}}}}';
// one repository's pull requests asking the viewer directly for a review
const reviewRequestsQuery = `query ReviewRequests($q:String!){requests:search(type:ISSUE,first:50,query:$q){nodes{...on PullRequest{number url repository{nameWithOwner} ${viewerRequestFields}}}}}`;
// the Overview's three searches, newest first; review threads and their last speaker are read
// for my own PRs only, since they cost the most
const overviewPullFields = 'number title url state isDraft updatedAt repository{nameWithOwner} author{login} headRefName headRefOid isCrossRepository mergeable statusCheckRollup{state} labels(first:5){nodes{name}}';
const overviewSearches = {
  mine: { query: 'is:pr is:open author:@me archived:false sort:updated-desc', first: 20, fields: `...on PullRequest{${overviewPullFields} latestOpinionatedReviews(first:10){nodes{id state author{login} commit{oid}}} reviewThreads(last:50){nodes{id isResolved isOutdated path comments(last:1){nodes{id author{login} viewerDidAuthor}}}} closingIssuesReferences(first:5){nodes{number}}}` },
  reviews: { query: 'is:pr is:open review-requested:@me archived:false sort:updated-desc', first: 30, fields: `...on PullRequest{${overviewPullFields} viewerLatestReviewRequest{id} viewerLatestReview{state commit{oid}} ${viewerRequestFields}}` },
  assigned: { query: 'is:issue is:open assignee:@me archived:false sort:updated-desc', first: 50, fields: '...on Issue{number title url state updatedAt repository{nameWithOwner} author{login} labels(first:5){nodes{name}} closedByPullRequestsReferences(first:5){nodes{number headRefName isCrossRepository repository{nameWithOwner}}}}' }
} as const;

// the `nodes` of one GraphQL connection
function nodes(connection: unknown): unknown[] {
  const value = at(connection, 'nodes');
  return Array.isArray(value) ? value : [];
}

function positive(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

const repositoryKey = ({ owner, name }: GithubRepository): string => `${owner.toLowerCase()}/${name.toLowerCase()}`;
const branchKey = (repository: GithubRepository, name: string): string => `${repositoryKey(repository)}:${name}`;
const apiUrl = (repository: GithubRepository, path: string): string => `https://api.github.com/repos/${repositoryPath(repository)}/${path}`;

// GitHub's own link, only when it points at github.com
function githubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.username === '' ? url.href : undefined;
  } catch { return undefined; }
}

// a head's combined checks: GitHub's rollup counts cancelled, timed-out and action-required runs
// as failures, as the console did; no rollup means no checks
function checkStatus(rollup: unknown): PullRequestCheckStatus {
  if (rollup === null) return 'passed';
  const state = at(rollup, 'state');
  return state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : 'pending';
}

// one well-formed pull request
function readPull(value: unknown): Pull | undefined {
  const [number, title, state, branch, headSha] = [positive(at(value, 'number')), at(value, 'title'), at(value, 'state'), at(value, 'headRefName'), at(value, 'headRefOid')];
  const url = githubUrl(at(value, 'url'));
  if (number === undefined || typeof title !== 'string' || url === undefined || (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') || typeof branch !== 'string' || typeof headSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(headSha)) return undefined;
  const [base, author, updatedAt] = [at(value, 'baseRefName'), at(value, 'author', 'login'), at(value, 'updatedAt')];
  const threads = at(value, 'reviewThreads', 'nodes');
  const closing = at(value, 'closingIssuesReferences', 'nodes');
  return {
    number, title, url, branch, headSha: headSha.toLowerCase(),
    ...(typeof author === 'string' ? { author } : {}), ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    state: state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : 'closed',
    draft: at(value, 'isDraft') === true,
    ...(typeof base === 'string' && base !== '' ? { baseBranch: base } : {}),
    // the same repository even after a rename, which the origin URL may still predate
    headOnOrigin: at(value, 'isCrossRepository') === false,
    mine: at(value, 'viewerDidAuthor') === true,
    conflicts: at(value, 'mergeable') === 'CONFLICTING',
    checks: checkStatus(at(value, 'statusCheckRollup')),
    ...(Array.isArray(threads) ? { unresolvedThreads: threads.filter(thread => at(thread, 'isResolved') === false && at(thread, 'isOutdated') !== true).length } : {}),
    ...(Array.isArray(closing) ? { closingIssues: closing.map(issue => positive(at(issue, 'number'))).filter((issue): issue is number => issue !== undefined) } : {})
  };
}

function readIssue(value: unknown): RepositoryIssue[] {
  const [number, title, url, author, updatedAt] = [positive(at(value, 'number')), at(value, 'title'), githubUrl(at(value, 'url')), at(value, 'author', 'login'), at(value, 'updatedAt')];
  return number === undefined || typeof title !== 'string' || url === undefined ? [] : [{ number, title, url, ...(typeof author === 'string' ? { author } : {}), ...(typeof updatedAt === 'string' ? { updatedAt } : {}) }];
}

function pullIssues(pull: Pull): PullRequestIssues {
  return { ...(pull.conflicts ? { mergeConflicts: true } : {}), ...(pull.checks === 'failed' ? { failingChecks: true } : {}), ...((pull.unresolvedThreads ?? 0) > 0 ? { unresolvedComments: true } : {}) };
}

function choice(pull: Pull): PullRequestChoice {
  const issues = pullIssues(pull);
  return { number: pull.number, title: pull.title, branch: pull.branch, headSha: pull.headSha, headOnOrigin: pull.headOnOrigin, draft: pull.draft, url: pull.url, ...(pull.mine ? { checks: pull.checks, ...(Object.keys(issues).length === 0 ? {} : { issues }) } : {}) };
}

function summary(pull: Pull): PullRequestSummary {
  const status = pull.state === 'merged' ? 'merged' : pull.draft ? 'draft' : 'open';
  const issues = pullIssues(pull);
  return {
    number: pull.number, title: pull.title, status, url: pull.url, ...(pull.baseBranch === undefined ? {} : { baseBranch: pull.baseBranch }), checks: pull.checks,
    ...(status === 'merged' || Object.keys(issues).length === 0 ? {} : { issues }),
    ...(status === 'merged' || !pull.unresolvedThreads ? {} : { unresolvedThreads: pull.unresolvedThreads })
  };
}

// one GraphQL read of `plans`, and of the Overview's searches with `overview`; every name, number
// and search travels as a variable
function readQuery(plans: readonly Plan[], full: boolean, overview: boolean): { query: string; variables: Record<string, unknown> } {
  const declared: string[] = [];
  const variables: Record<string, unknown> = {};
  const searches = overview ? Object.entries(overviewSearches).map(([alias, search]) => {
    declared.push(`$q_${alias}:String!`);
    variables[`q_${alias}`] = search.query;
    return `${alias}:search(type:ISSUE,first:${search.first},query:$q_${alias}){issueCount nodes{${search.fields}}}`;
  }) : [];
  const repositories = plans.map((plan, index) => {
    declared.push(`$o${index}:String!`, `$n${index}:String!`);
    variables[`o${index}`] = plan.repository.owner;
    variables[`n${index}`] = plan.repository.name;
    const fields = plan.list ? [
      `open:pullRequests(states:OPEN,first:${openPage},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${fullPullFields}}}`,
      `issues(states:OPEN,first:${issuePage},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url updatedAt author{login}}}`
    ] : [];
    plan.branches.forEach((branch, position) => {
      const variable = `b${index}_${position}`;
      const fork = forkCheckoutNumber(branch.name);
      const selected = full ? fullPullFields : pullFields;
      variables[variable] = fork ?? branch.name;
      declared.push(`$${variable}:${fork === undefined ? 'String' : 'Int'}!`);
      fields.push(fork === undefined
        ? `b${position}:pullRequests(headRefName:$${variable},first:${branchPage},orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{${selected}}}`
        : `b${position}:pullRequest(number:$${variable}){${selected}}`);
    });
    return `r${index}:repository(owner:$o${index},name:$n${index}){${fields.join(' ')}}`;
  });
  return { query: `query(${declared.join(',')}){${[...searches, ...repositories].join(' ')}}`, variables };
}

// the fields every Overview row has; undefined for a node that is not one, or not open
function overviewRow(value: unknown): OverviewRow | undefined {
  const [number, title, url, repository, state] = [positive(at(value, 'number')), at(value, 'title'), githubUrl(at(value, 'url')), at(value, 'repository', 'nameWithOwner'), at(value, 'state')];
  if (number === undefined || typeof title !== 'string' || url === undefined || typeof repository !== 'string' || !repository.includes('/') || state !== 'OPEN') return undefined;
  const [author, updatedAt] = [at(value, 'author', 'login'), at(value, 'updatedAt')];
  const labels = nodes(at(value, 'labels')).map(label => at(label, 'name')).filter((name): name is string => typeof name === 'string');
  return { repository, number, title, url, ...(typeof author === 'string' ? { author } : {}), ...(typeof updatedAt === 'string' ? { updatedAt } : {}), reasons: [], ...(labels.length === 0 ? {} : { labels }), heads: [], instances: [], held: [] };
}

// a reason instance's key in the seen record: the pull request and what makes the reason new again
const seenKey = (row: Pick<OverviewRow, 'repository' | 'number'>, instance: string): string => `${row.repository.toLowerCase()}#${row.number}:${instance}`;

// a pull request's own head, which finds the Worktree holding it
function pullHead(value: unknown, number: number): OverviewRow['heads'] {
  const branch = at(value, 'headRefName');
  return typeof branch === 'string' ? [{ number, branch, onOrigin: at(value, 'isCrossRepository') === false }] : [];
}

// my pull request is Waiting on me, unless a draft, for each current, unresolved thread someone
// else (bots too) spoke last on, failing checks, conflicts, and each reviewer's changes requested
// on the head as it still is; pending checks and approvals never count. Approval is read from the
// reviews, since these repositories leave `reviewDecision` null.
function myPullRow(value: unknown): OverviewRow[] {
  const row = overviewRow(value);
  if (row === undefined) return [];
  const draft = at(value, 'isDraft') === true;
  const checks = checkStatus(at(value, 'statusCheckRollup'));
  const reviews = nodes(at(value, 'latestOpinionatedReviews'));
  const head = at(value, 'headRefOid');
  // each reason with the instance that makes it new again: a thread's newest comment, the head
  // that failed, a changes-requested review; conflicts are new again once they cleared
  type Found = { reason: OverviewReason; instance: string };
  const [checksFailed, conflicted] = [`checks:${String(head)}`, 'conflicts'];
  const threads = nodes(at(value, 'reviewThreads')).flatMap((thread): Found[] => {
    const [id, path, last] = [at(thread, 'id'), at(thread, 'path'), nodes(at(thread, 'comments'))[0]];
    if (typeof id !== 'string' || typeof path !== 'string' || last === undefined || at(thread, 'isResolved') !== false || at(thread, 'isOutdated') !== false || at(last, 'viewerDidAuthor') !== false) return [];
    const [author, comment] = [at(last, 'author', 'login'), at(last, 'id')];
    return [{ reason: { kind: 'thread', id, path, author: typeof author === 'string' ? author : 'ghost' }, instance: `thread:${id}:${typeof comment === 'string' ? comment : ''}` }];
  });
  const changes = reviews.flatMap((review): Found[] => {
    const [id, author] = [at(review, 'id'), at(review, 'author', 'login')];
    return at(review, 'state') === 'CHANGES_REQUESTED' && typeof id === 'string' && at(review, 'commit', 'oid') === head ? [{ reason: { kind: 'changes', id, author: typeof author === 'string' ? author : 'ghost' }, instance: `changes:${id}` }] : [];
  });
  const mergeable = at(value, 'mergeable');
  const found: Found[] = draft ? [] : [...threads, ...(checks === 'failed' ? [{ reason: { kind: 'checks' as const }, instance: checksFailed }] : []), ...(mergeable === 'CONFLICTING' ? [{ reason: { kind: 'conflicts' as const }, instance: conflicted }] : []), ...changes];
  // while checks run again on the same head, or GitHub is still working out mergeability, a
  // failure or conflict seen before is not new when it comes back
  const held = draft ? [] : [...(checks === 'pending' ? [checksFailed] : []), ...(mergeable === 'UNKNOWN' ? [conflicted] : [])];
  const states = reviews.map(review => at(review, 'state'));
  const closes = nodes(at(value, 'closingIssuesReferences')).map(issue => positive(at(issue, 'number'))).filter((issue): issue is number => issue !== undefined);
  return [{
    ...row, heads: pullHead(value, row.number), checks, reasons: found.map(({ reason }) => reason),
    instances: found.map(({ instance }) => seenKey(row, instance)), held: held.map(instance => seenKey(row, instance)),
    ...(draft ? { draft: true as const } : {}),
    ...(states.includes('APPROVED') && changes.length === 0 ? { approved: true as const } : {}),
    ...(closes.length === 0 ? {} : { closes })
  }];
}

// a Review request is Waiting on me while it still asks (the search's own rule, teams included)
// and is not a draft; it was Re-requested when it asks again after a review of mine, not counting
// my unsubmitted Draft review
function reviewRow(value: unknown): OverviewRow[] {
  const row = overviewRow(value);
  if (row === undefined) return [];
  const draft = at(value, 'isDraft') === true;
  const review = at(value, 'viewerLatestReview');
  const reviewed = review !== null && typeof review === 'object' && at(review, 'state') !== 'PENDING';
  const request = at(value, 'viewerLatestReviewRequest', 'id');
  const reRequested = reviewed && request !== undefined;
  const reviewedAt = reviewed ? at(review, 'commit', 'oid') : undefined;
  // each request is new; a team's request names none of mine, but leaves the search once I review
  return [{
    ...row, heads: pullHead(value, row.number),
    ...(draft ? { draft: true as const } : { reasons: [reRequested ? { kind: 'review', reRequested: true } : { kind: 'review' }], instances: [seenKey(row, `review:${typeof request === 'string' ? request : ''}`)] }),
    ...(typeof reviewedAt === 'string' && reviewedAt !== at(value, 'headRefOid') ? { newCommits: true as const } : {})
  }];
}

// an Issue is never Waiting on me; the pull requests linked to it in its own repository find its Worktree
function issueRow(value: unknown): OverviewRow[] {
  const row = overviewRow(value);
  if (row === undefined) return [];
  const linked = nodes(at(value, 'closedByPullRequestsReferences')).filter(pull => typeof at(pull, 'repository', 'nameWithOwner') === 'string' && (at(pull, 'repository', 'nameWithOwner') as string).toLowerCase() === row.repository.toLowerCase());
  const heads = linked.flatMap(pull => { const number = positive(at(pull, 'number')); return number === undefined ? [] : pullHead(pull, number); });
  return [{ ...row, heads, ...(heads.length === 0 ? {} : { linkedPullRequests: heads.map(head => head.number) }) }];
}

// the search results asking the viewer directly for a review, each with the newest request event
// naming them
function viewerRequests(results: unknown[]): RepositoryReviewRequest[] {
  return results.flatMap(pull => {
    const [number, url, repository] = [positive(at(pull, 'number')), githubUrl(at(pull, 'url')), at(pull, 'repository', 'nameWithOwner')];
    if (number === undefined || url === undefined || typeof repository !== 'string' || !nodes(at(pull, 'reviewRequests')).some(asked => at(asked, 'requestedReviewer', 'isViewer') === true)) return [];
    const request = nodes(at(pull, 'timelineItems')).filter(event => at(event, 'requestedReviewer', 'isViewer') === true).map(event => at(event, 'id')).filter((id): id is string => typeof id === 'string').at(-1);
    return [{ repository, number, url, ...(request === undefined ? {} : { request }) }];
  });
}

// a branch's pull requests as one alias gave them
function readBranch(value: unknown, fork: boolean): { pulls: Pull[]; complete: boolean } {
  // a fork checkout's pull request by number: none at all is a complete answer
  if (fork) {
    if (value === null || value === undefined) return { pulls: [], complete: true };
    const pull = readPull(value);
    return { pulls: pull === undefined ? [] : [pull], complete: pull !== undefined };
  }
  const listed = nodes(value);
  const pulls = listed.map(readPull).filter((pull): pull is Pull => pull !== undefined);
  const total = at(value, 'totalCount');
  return { pulls, complete: pulls.length === listed.length && Number.isInteger(total) && (total as number) <= listed.length };
}

/** The error a caller that cannot show last-known data raises for a problem, as reads raised before problems existed. */
export function problemError(problem: GithubProblem): GithubRequestError {
  return new GithubRequestError(problem.message, problem.kind === 'no-token' ? 503 : 502, undefined, problem.kind === 'rate-limited' ? 'transient' : 'rejected', problem.until);
}

// what a failed read tells the operator
function problemOf(error: GithubRequestError): GithubProblem {
  return error.until !== undefined ? { kind: 'rate-limited', message: error.message, until: error.until } : { kind: 'failing', message: error.message };
}

// what a reader sees of an entry: when it was fetched and why it is not newer
function fetched({ fetchedAt, problem }: Entry): Fetched<object> {
  return { ...(fetchedAt === undefined ? {} : { fetchedAt }), ...(problem === undefined ? {} : { problem }) };
}

/**
 * The console's GitHub: every read and write, through one shared client, one token and one viewer.
 *
 * One GraphQL poll reads each Project's open pull requests and issues and every tracked branch,
 * every minute while a browser shows the console (`watch()`) and never otherwise. Reads answer from what it
 * last read; a reader that waits refreshes data older than a minute, for just its branch or
 * repository. Reads never throw because GitHub is having trouble; they return the last data they
 * had, with a `problem` saying why it is not newer.
 */
export class GithubService {
  readonly client: GithubClient;
  private readonly repositories = new Map<string, RepositoryEntry>();
  private readonly branches = new Map<string, BranchEntry>();
  private readonly origins = new Map<string, OriginEntry>();
  // GitHub's comparison of a closed pull request's final head with a checkout, which never changes
  private readonly compares = new Map<string, unknown>();
  private readonly command: Command;
  // git through `command`; a git that could not run answers as one that failed
  private readonly git = async (binary: string, args: string[]) => await this.command(binary, args).catch(() => ({ code: -1, stdout: '' }));
  private readonly now: () => number;
  private readonly readToken: Token;
  private readonly timer: Timer;
  private readonly projects: () => readonly Project[];
  private readonly worktrees: () => readonly Worktree[];
  private readonly overviewEntry: OverviewEntry = {};
  private readonly seen: SeenRecord;
  private readonly details = new Map<string, DetailEntry<unknown>>();
  private viewers = 0;
  private scheduled?: unknown;
  private searchLag?: unknown;
  private lastPollAt?: number;
  private changes = 0;

  constructor({ request = fetch, command = run, now = () => Date.now(), token = githubToken, timer = realTimer, projects = () => [], worktrees = () => [], seenFile }: GithubServiceOptions = {}) {
    this.command = command;
    this.now = now;
    this.readToken = token;
    this.timer = timer;
    this.projects = projects;
    this.worktrees = worktrees;
    this.seen = new SeenRecord(seenFile);
    this.client = new GithubClient(request, { now });
  }

  /** Moves whenever the data the module serves changes, so views know to read it again. */
  get revision(): number { return this.changes; }

  /** How many of the Overview's Pull requests hold a reason the operator has not been shown. */
  get badge(): number {
    // Issues have no reasons, so only Pull requests count
    return this.overviewRows().filter(row => this.unseen(row).length > 0).length;
  }

  /**
   * The operator was shown these reason instances (an Overview row's `unseen`), on any device.
   * Only reasons that hold now are recorded.
   */
  async markSeen(keys: readonly string[]): Promise<void> {
    await this.seen.load();
    const live = new Set(this.overviewRows().flatMap(row => row.instances));
    if (await this.seen.add(keys.filter(key => live.has(key)))) this.changes += 1;
  }

  private overviewRows(): OverviewRow[] {
    return [...this.overviewEntry.mine ?? [], ...this.overviewEntry.reviews ?? [], ...this.overviewEntry.issues ?? []];
  }

  // a reason that stopped holding is new when it comes back; a Pull request missing from a list
  // GitHub cut short may only have been pushed off its page, so what was seen of it stays
  private async pruneSeen(): Promise<void> {
    const { mine = [], reviews = [], totals } = this.overviewEntry;
    const rows = this.overviewRows();
    const live = new Set(rows.flatMap(row => [...row.instances, ...row.held]));
    const listed = new Set(rows.map(row => seenKey(row, '')));
    const complete = totals !== undefined && mine.length >= totals.mine && reviews.length >= totals.reviews;
    await this.seen.retain(key => live.has(key) || (!complete && !listed.has(key.slice(0, key.indexOf(':') + 1)))).catch(() => undefined);
  }

  private unseen(row: OverviewRow): string[] {
    return row.instances.filter(key => !this.seen.has(key));
  }

  /** A browser showing the console: while any handle is held, the poll runs every minute. Call the result to let go. */
  watch(): () => void {
    this.viewers += 1;
    if (this.viewers === 1) this.schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.viewers -= 1;
      if (this.viewers === 0) this.unschedule();
    };
  }

  /** The console's token, read on every call (an environment variable or a small file) so a new login applies at once. */
  async token(): Promise<string | undefined> {
    return await this.readToken().catch(() => undefined);
  }

  /** The GitHub repository a checkout's origin names, remembered for 30s unless `fresh`. */
  async repositoryAt(path: string, fresh = false): Promise<GithubRepository | undefined> {
    const now = this.now();
    const cached = this.origins.get(path);
    if (fresh) this.origins.delete(path);
    else if (cached !== undefined && (cached.expiresAt === undefined || cached.expiresAt > now)) return await cached.pending;
    if (fresh) return await this.origin(path);
    // prune expired checkouts on a miss
    for (const [key, entry] of this.origins) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.origins.delete(key);
    }
    const entry: OriginEntry = { pending: this.origin(path) };
    entry.pending = entry.pending.then((repository) => {
      // only the current generation starts its window, from when the lookup finished
      if (this.origins.get(path) === entry) entry.expiresAt = this.now() + repositoryCacheTtlMs;
      return repository;
    }, (error: unknown) => {
      // a failed lookup is retried, unless a newer one has replaced it
      if (this.origins.get(path) === entry) this.origins.delete(path);
      throw error;
    });
    this.origins.set(path, entry);
    return await entry.pending;
  }

  // forget every checkout's origin after checkouts change
  invalidateRepositories(): void { this.origins.clear(); }

  /**
   * One repository's open pull requests (the viewer's own, with their checks and issues, apart
   * from others') and first page of open issues. Answers from what the poll read; data older than a
   * minute is refreshed behind the answer, unless the reader waits (`wait`, as before acting on
   * the list) or the repository was never read.
   */
  async repository(repository: GithubRepository, { wait = false }: { wait?: boolean } = {}): Promise<RepositoryPullRequests> {
    const entry = await this.listed(repository, { wait });
    const open = entry.open ?? [];
    return { own: open.filter(pull => pull.mine).map(choice), others: open.filter(pull => !pull.mine).map(choice), issues: entry.issues ?? [], ...fetched(entry) };
  }

  // one repository's lists as `repository()` reads them; `fresh` (Refresh) reads them again now,
  // unless the last read is under ten seconds old
  private async listed(repository: GithubRepository, { wait = false, fresh = false }: { wait?: boolean; fresh?: boolean }): Promise<RepositoryEntry> {
    const entry = this.repositoryEntry(repository);
    await this.refreshIfDue(entry, { wait, fresh }, () => this.refreshRepository(repository));
    return entry;
  }

  // read `entry` again with `start` when it is over a minute old, or when `fresh` asks and it is ten
  // seconds old; the caller waits for that when it asked to, when forced, or when nothing was ever read
  private async refreshIfDue(entry: Entry, { wait = false, fresh = false }: { wait?: boolean; fresh?: boolean }, start: () => Promise<void>): Promise<void> {
    const forced = fresh && (entry.fetchedAt === undefined || this.now() - entry.fetchedAt >= refreshFloorMs);
    if (!forced && !this.stale(entry)) return;
    const reading = start();
    if (forced || wait || entry.fetchedAt === undefined) await reading; else this.background(reading);
  }

  /**
   * One repository's lists for the GitHub panel, the same whichever Worktree asks. Mine, Review
   * requested and Assigned to me are the Overview's own rows, so the panel and the badge cannot
   * disagree. Answers from cache as `repository()` and `overview()` do; `fresh` reads both again.
   * `project` is the asking Project, whose Worktrees are preferred where several hold an item.
   */
  async panel(repository: GithubRepository, { fresh = false, project }: { fresh?: boolean; project?: string } = {}): Promise<GithubPanel> {
    const [entry, overview, destination] = await Promise.all([this.listed(repository, { fresh }), this.overview({ fresh, project }), this.destinations(project)]);
    const key = repositoryKey(repository);
    const name = `${repository.owner}/${repository.name}`;
    // a row is labelled only with the Worktree holding it
    const placed = ({ destination: found, ...item }: PanelItem): PanelItem => found?.kind === 'worktree' ? { ...item, destination: found } : item;
    const here = (items: OverviewItem[]) => items.filter(item => item.repository.toLowerCase() === key).map(placed);
    const [mine, reviews, assigned] = [here(overview.mine), here(overview.reviews), here(overview.issues)];
    const fields = (item: { number: number; title: string; url: string; author?: string; updatedAt?: string }): PanelItem => ({
      repository: name, number: item.number, title: item.title, url: item.url, reasons: [],
      ...(item.author === undefined ? {} : { author: item.author }), ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt })
    });
    const row = (pull: Pull, holder?: OverviewDestination): PanelItem => {
      const found = holder ?? destination(name, [{ number: pull.number, branch: pull.branch, onOrigin: pull.headOnOrigin }]);
      return placed({
        ...fields(pull), ...(pull.draft ? { draft: true as const } : {}), ...(pull.mine && pull.state === 'open' ? { checks: pull.checks } : {}),
        ...(pull.state === 'open' ? {} : { state: pull.state }), ...(found === undefined ? {} : { destination: found })
      });
    };
    const open = entry.open ?? [];
    // an open pull request past the Overview's first page is still mine
    const fromOverview = new Set([...mine, ...reviews].map(item => item.number));
    const rest = open.filter(pull => !fromOverview.has(pull.number));
    const done = (await this.finished(repository)).map(({ worktree, pull }) => row(pull, { kind: 'worktree', worktreeId: worktree.id, label: worktree.label }));
    const listedIssues = new Set(assigned.map(item => item.number));
    return {
      mine: [...mine, ...rest.filter(pull => pull.mine).map(pull => row(pull))], reviews, other: rest.filter(pull => !pull.mine).map(pull => row(pull)), done,
      assigned, issues: (entry.issues ?? []).filter(issue => !listedIssues.has(issue.number)).map(issue => {
        const closers = open.filter(pull => pull.closingIssues?.includes(issue.number)).map(pull => ({ number: pull.number, branch: pull.branch, onOrigin: pull.headOnOrigin }));
        const found = destination(name, closers, issue.number);
        return placed({ ...fields(issue), ...(found === undefined ? {} : { destination: found }) });
      }),
      // as old as the older of the two reads it is made of
      ...fetched({ fetchedAt: overview.fetchedAt === undefined || entry.fetchedAt === undefined ? entry.fetchedAt ?? overview.fetchedAt : Math.min(entry.fetchedAt, overview.fetchedAt), problem: entry.problem ?? overview.problem })
    };
  }

  // each of the repository's Worktrees whose branch's pull requests merged or closed, with none
  // open, and the one it finished with: the latest merged before one closed without merging, as
  // the branch's summary picks
  private async finished(repository: GithubRepository): Promise<{ worktree: Worktree; pull: Pull }[]> {
    const key = repositoryKey(repository);
    const projects = new Set((await this.projectRepositories()).filter(found => repositoryKey(found.repository) === key).map(found => found.project.id));
    const open = this.repositories.get(key)?.open ?? [];
    return this.worktrees().flatMap(worktree => {
      const branch = worktree.branch === undefined || !projects.has(worktree.projectId) ? undefined : this.branches.get(branchKey(repository, worktree.branch));
      if (branch === undefined) return [];
      const held = [...open, ...branch.pulls ?? []].filter(pull => this.holds(branch, pull));
      const last = held.some(pull => pull.state === 'open') ? undefined : held.find(pull => pull.state === 'merged') ?? held[0];
      return last === undefined ? [] : [{ worktree, pull: last }];
    });
  }

  /**
   * The operator's open Pull requests, Review requests and assigned Issues across every repository
   * they can access, with why each is Waiting on me and where tapping it goes. Answers from what the
   * poll read; data older than a minute is refreshed behind the answer, unless it was never read,
   * or `fresh` asks for it read again now (Refresh, Retry), which data under ten seconds old answers.
   */
  async overview({ fresh = false, project }: { fresh?: boolean; project?: string } = {}): Promise<Overview> {
    const entry = this.overviewEntry;
    await this.refreshIfDue(entry, { fresh }, () => entry.refreshing ?? this.read([], false, true));
    const destination = await this.destinations(project);
    const rows = (list: OverviewRow[] | undefined, issues = false): OverviewItem[] => (list ?? []).map(read => {
      const { heads, instances: _instances, held: _held, ...row } = read;
      const [found, unseen] = [destination(row.repository, heads, issues ? row.number : undefined), this.unseen(read)];
      return { ...row, ...(unseen.length === 0 ? {} : { unseen }), ...(found === undefined ? {} : { destination: found }) };
    });
    return { mine: rows(entry.mine), reviews: rows(entry.reviews), issues: rows(entry.issues, true), totals: entry.totals ?? { mine: 0, reviews: 0, issues: 0 }, ...fetched(entry) };
  }

  // where an Overview row in a repository goes: the Worktree holding one of its heads (or, for an
  // Issue, the one the console created for it) in any of the repository's Projects, the asking
  // Project's (`asking`) first; else the main worktree of that Project, or of the first; nowhere in
  // the console for a repository with no Project
  private async destinations(asking?: string): Promise<(repository: string, heads: OverviewRow['heads'], issue?: number) => OverviewDestination | undefined> {
    const projects = new Map<string, Project[]>();
    for (const { project, repository } of await this.projectRepositories()) {
      const found = projects.get(repositoryKey(repository)) ?? [];
      if (project.id === asking) found.unshift(project); else found.push(project);
      projects.set(repositoryKey(repository), found);
    }
    const worktrees = this.worktrees();
    return (repository, heads, issue) => {
      // GitHub's `owner/name`, keyed as `repositoryKey` keys it
      const candidates = projects.get(repository.toLowerCase()) ?? [];
      const own = candidates.flatMap(project => worktrees.filter(worktree => worktree.projectId === project.id));
      const holder = own.find(worktree => worktree.branch !== undefined && heads.some(head => forkCheckoutNumber(worktree.branch!) === head.number || (head.onOrigin && worktree.branch === head.branch)))
        ?? (issue === undefined ? undefined : own.find(worktree => worktree.issue === issue));
      if (holder !== undefined) return { kind: 'worktree', worktreeId: holder.id, label: holder.label };
      const [project] = candidates;
      const main = own.find(worktree => worktree.main && worktree.projectId === project?.id);
      return main === undefined ? undefined : { kind: 'project', worktreeId: main.id, label: project!.label };
    };
  }

  // each repository Project and the GitHub repository its origin names
  private async projectRepositories(): Promise<{ project: Project; repository: GithubRepository }[]> {
    const found: { project: Project; repository: GithubRepository }[] = [];
    for (const project of this.projects()) {
      const repository = await this.projectRepository(project);
      if (repository !== undefined) found.push({ project, repository });
    }
    return found;
  }

  /** The github.com repository a Project's origin names; none for a directory Project or another host. */
  async projectRepository(project: Project): Promise<GithubRepository | undefined> {
    return project.mode === 'repository' ? await this.repositoryAt(project.path).catch(() => undefined) : undefined;
  }

  /**
   * The pull request of one branch, as last read; reading it keeps the branch in the poll for ten
   * minutes. A published branch (an upstream, or an `origin/<branch>` ref) is polled by name, and
   * an unpublished one only matched against its repository's open list. `published` left out
   * keeps what the last reader said. A read waits on GitHub only when asked to (`wait`), and then
   * only if its data is older than a minute. `remoteHead`, the commit the branch's remote ref
   * names (null for none), refreshes the repository when it moves, as after a push.
   */
  async branch(repository: GithubRepository, name: string, published?: boolean, { wait = false, remoteHead }: { wait?: boolean; remoteHead?: string | null } = {}): Promise<BranchSummary> {
    const entry = this.branchEntry(repository, name);
    entry.readAt = this.now();
    if (published !== undefined) entry.published = published;
    if (remoteHead !== undefined && !(entry.remoteHeads ?? []).includes(remoteHead)) {
      if (entry.remoteHeads !== undefined) this.background(this.refreshRepository(repository));
      entry.remoteHeads = [remoteHead, ...(entry.remoteHeads ?? [])].slice(0, maxRemoteHeads);
    }
    if (wait) await this.refreshBranch(entry);
    return this.summaryOf(entry);
  }

  /**
   * One pull request's detail, for any repository. It is read on the first ask and kept while a
   * list read since, under a minute old, shows the pull request unchanged (its state, `updatedAt`,
   * head, checks, conflicts and unresolved threads); otherwise it is read again once a minute old.
   * `fresh` (Refresh) reads it again unless the last read is under ten seconds old; a failed read is
   * not tried again for ten seconds either.
   */
  async pullRequestDetail(repository: GithubRepository, number: number, { fresh = false, project }: { fresh?: boolean; project?: string } = {}): Promise<Fetched<{ pullRequest?: PullRequestDetail }>> {
    const key = `pull:${repositoryKey(repository)}#${number}`;
    const kept = this.details.get(key)?.data as PullRequestDetail | undefined;
    // while checks run or GitHub works out mergeability, a check run or the merge state may move
    // without the lists' version moving, so the detail is only kept for a minute
    const settling = kept?.checks === 'pending' || kept?.mergeable === 'unknown';
    const entry = await this.detail(key, settling ? undefined : this.knownPull(repository, number), fresh, async (token) => {
      const payload = await this.client.query(token, detailQuery, { owner: repository.owner, name: repository.name, number }, detailAction);
      return readDetail(repository, at(payload, 'data', 'repository', 'pullRequest')) ?? { kind: 'failing', message: graphqlError(payload, detailAction).message };
    });
    const pull = entry.data;
    let destination: OverviewDestination | undefined;
    if (pull?.state === 'open') destination = await this.holder(repository, [{ number, branch: pull.branch, onOrigin: pull.headOnOrigin }], undefined, project);
    else if (pull !== undefined) {
      // a merged or closed one only in a Worktree whose branch finished with it, at its final head
      const finished = (await this.finished(repository)).filter(found => found.pull.number === number && found.worktree.sha?.toLowerCase() === pull.headSha).map(found => found.worktree);
      const holder = finished.find(worktree => worktree.projectId === project) ?? finished[0];
      if (holder !== undefined) destination = { kind: 'worktree', worktreeId: holder.id, label: holder.label };
    }
    return { ...(pull === undefined ? {} : { pullRequest: { ...pull, ...(destination === undefined ? {} : { destination }) } }), ...fetched(entry) };
  }

  /** One Issue's detail, kept as a pull request's is while the repository's issue list shows it unchanged. */
  async issueDetail(repository: GithubRepository, number: number, { fresh = false, project }: { fresh?: boolean; project?: string } = {}): Promise<Fetched<{ issue?: IssueDetail }>> {
    const listed = this.repositories.get(repositoryKey(repository));
    const known = listed?.fetchedAt === undefined ? undefined : listed.issues?.find(issue => issue.number === number);
    const entry = await this.detail(`issue:${repositoryKey(repository)}#${number}`, known === undefined ? undefined : { version: known.updatedAt ?? '', fetchedAt: listed!.fetchedAt! }, fresh, async (token) => {
      const payload = await this.client.query(token, issueQuery, { owner: repository.owner, name: repository.name, number }, issueAction);
      return readIssueDetail(repository, at(payload, 'data', 'repository', 'issue')) ?? { kind: 'failing', message: graphqlError(payload, issueAction).message };
    });
    if (entry.data === undefined) return fetched(entry);
    const { heads, ...issue } = entry.data;
    const destination = await this.holder(repository, heads, number, project);
    return { issue: { ...issue, ...(destination === undefined ? {} : { destination }) }, ...fetched(entry) };
  }

  /**
   * One repository's open pull requests asking the viewer directly for a review, for a Watch. The
   * poll's Review requests answer while they are under a minute old, whole, and newer than this
   * repository's own read; otherwise just this repository's are read, once a minute old.
   */
  async reviewRequests(repository: GithubRepository): Promise<Fetched<{ requests: ViewerReviewRequest[] }>> {
    const key = repositoryKey(repository);
    const unnamed = ({ repository: _repository, ...request }: RepositoryReviewRequest): ViewerReviewRequest => request;
    const { requests: polled, problem, fetchedAt: polledAt } = this.overviewEntry;
    const targetedAt = this.details.get(`requests:${key}`)?.fetchedAt;
    if (polled !== undefined && problem === undefined && polledAt !== undefined && !this.stale(this.overviewEntry) && polledAt >= (targetedAt ?? -Infinity)) return { requests: polled.filter(request => request.repository.toLowerCase() === key).map(unnamed), fetchedAt: polledAt };
    const entry = await this.detail(`requests:${key}`, undefined, false, async (token) => {
      const payload = await this.client.query(token, reviewRequestsQuery, { q: `repo:${repository.owner}/${repository.name} is:pr is:open user-review-requested:@me` }, requestsAction);
      const found = at(payload, 'data', 'requests');
      return found !== null && typeof found === 'object' ? { data: viewerRequests(nodes(found)), versions: [] } : { kind: 'failing', message: graphqlError(payload, requestsAction).message };
    });
    // the search's `repo:` already chose them, under whatever name GitHub now gives the repository
    return { requests: (entry.data ?? []).map(unnamed), ...fetched(entry) };
  }

  // the Worktree holding one of these heads of a repository, or created for this Issue, if any
  private async holder(repository: GithubRepository, heads: OverviewRow['heads'], issue?: number, project?: string): Promise<OverviewDestination | undefined> {
    const found = (await this.destinations(project))(`${repository.owner}/${repository.name}`, heads, issue);
    return found?.kind === 'worktree' ? found : undefined;
  }

  // the pull request as the newest list or branch lookup holding it last read it
  private knownPull(repository: GithubRepository, number: number): Known | undefined {
    const key = repositoryKey(repository);
    const listed = this.repositories.get(key);
    const reads = [...listed === undefined ? [] : [{ fetchedAt: listed.fetchedAt, pulls: listed.open }], ...[...this.branches.values()].filter(branch => repositoryKey(branch.repository) === key)];
    let known: Known | undefined;
    for (const { fetchedAt, pulls } of reads) {
      const pull = pulls?.find(candidate => candidate.number === number);
      if (pull !== undefined && fetchedAt !== undefined && (known === undefined || fetchedAt > known.fetchedAt)) known = { version: pullVersion(pull), fetchedAt };
    }
    return known;
  }

  // one detail, read again when it is missing, when its last read failed, when Refresh asks, when a
  // list read since (and under a minute old) shows another version, or, when none has, once it is
  // a minute old; readers asking together share a read
  private async detail<T>(key: string, known: Known | undefined, fresh: boolean, read: (token: string) => Promise<{ data: T; versions: string[] } | GithubProblem>): Promise<DetailEntry<T>> {
    const entry = (this.details.get(key) ?? {}) as DetailEntry<T>;
    // the least recently read is dropped first
    this.details.delete(key);
    this.details.set(key, entry);
    for (const [other, kept] of this.details) {
      if (this.details.size <= maxDetails) break;
      if (kept.refreshing === undefined) this.details.delete(other);
    }
    // a reader arriving during a read (Refresh's, say) gets what it reads
    if (entry.refreshing !== undefined) {
      await entry.refreshing;
      return entry;
    }
    const { fetchedAt } = entry;
    const now = this.now();
    // asking again straight after a failure does not ask GitHub again
    if (entry.failedAt !== undefined && now - entry.failedAt < refreshFloorMs) return entry;
    const due = fetchedAt === undefined || entry.problem !== undefined
      || (fresh && now - fetchedAt >= refreshFloorMs)
      || (known !== undefined && known.fetchedAt > fetchedAt && !this.stale(known) ? !(entry.versions ?? []).includes(known.version) : this.stale(entry));
    if (due) await (entry.refreshing ??= this.readDetail(entry, read));
    return entry;
  }

  private async readDetail<T>(entry: DetailEntry<T>, read: (token: string) => Promise<{ data: T; versions: string[] } | GithubProblem>): Promise<void> {
    const started = this.now();
    try {
      const token = await this.token();
      const result = token === undefined ? { kind: 'no-token' as const, message: missingToken } : await read(token).catch((error: unknown) => {
        // anything but GitHub's own trouble is a bug
        if (!(error instanceof GithubRequestError)) throw error;
        return problemOf(error);
      });
      if (!('data' in result)) Object.assign(entry, { problem: result, failedAt: started });
      else if (entry.fetchedAt === undefined || entry.fetchedAt <= started) {
        Object.assign(entry, result, { fetchedAt: started });
        delete entry.problem;
        delete entry.failedAt;
      }
    } finally {
      delete entry.refreshing;
    }
  }

  /** Reply to one of the pull request's Review threads, published at once (see `writes.replyToThread`). */
  async replyToThread(repository: GithubRepository, number: number, threadId: string, body: string): Promise<{ id: string; url?: string; pending: boolean }> {
    if (body.trim() === '' || body.length > maxCommentLength) throw new GithubRequestError(`A reply must hold 1 to ${maxCommentLength} characters.`, 400);
    await this.thread(repository, number, threadId);
    return await this.write(repository, number, async token => await replyToThread(this.client, token, threadId, body));
  }

  async resolveThread(repository: GithubRepository, number: number, threadId: string): Promise<void> {
    await this.thread(repository, number, threadId);
    await this.write(repository, number, async token => await resolveThread(this.client, token, threadId));
  }

  /** Ask one of the pull request's reviewers, a user or bot who reviewed it, for another review. */
  async rerequestReview(repository: GithubRepository, number: number, login: string): Promise<void> {
    const pull = await this.writable(repository, number);
    const found = pull.reviewers.find(candidate => candidate.login === login && candidate.team !== true);
    if (found?.id === undefined) throw new GithubRequestError(`@${login} is not a reviewer of pull request #${number}.`, 404);
    const ids = [found.id];
    await this.write(repository, number, async token => await rerequestReviews(this.client, token, pull.id, found.bot ? { botIds: ids } : { userIds: ids }));
  }

  /**
   * What a new pull request from a Worktree's branch starts as: into the repository's default branch
   * (as the New worktree dialog finds it), titled after the branch's first commit past it, and the
   * Issue the Worktree was made for.
   */
  async pullRequestDraft(worktreeId: string): Promise<PullRequestDraft> {
    const { worktree, branch, base } = await this.pullRequestSource(worktreeId);
    const commits = await this.git('/usr/bin/git', [...repositoryArgs(worktree.identity), 'log', '--reverse', '--format=%s', `refs/remotes/origin/${base}..refs/heads/${branch}`, '--']);
    const title = commits.code === 0 ? commits.stdout.split('\n')[0]!.trim() : '';
    return { branch, base, title, ...(worktree.issue === undefined ? {} : { issue: worktree.issue }) };
  }

  /**
   * Push a Worktree's branch to origin with an upstream, then open its pull request. The push is
   * refused as git refuses it (nothing is forced); a creation that failed may still have applied,
   * so the repository is read again either way.
   */
  async createPullRequest(worktreeId: string, input: { title: string; body: string; base: string; draft: boolean }): Promise<{ number: number; url: string }> {
    const title = input.title.trim();
    if (title === '' || title.length > maxTitleLength) throw new GithubRequestError(`A title must hold 1 to ${maxTitleLength} characters.`, 400);
    if (input.body.length > maxCommentLength) throw new GithubRequestError(`A description must hold at most ${maxCommentLength} characters.`, 400);
    const base = input.base.trim();
    // a plain branch name: no leading `-`, `.` or `/`, no `..`
    if (!/^(?![-./])(?!.*\.\.)[\w./-]{1,255}$/u.test(base)) throw new GithubRequestError('The base must be a branch name.', 400);
    const { worktree, branch, repository } = await this.pullRequestSource(worktreeId);
    if (branch === base) throw new GithubRequestError(`A pull request from ${branch} cannot go into ${branch} itself.`, 409);
    const token = await this.token();
    if (token === undefined) throw new GithubRequestError(missingToken, 503);
    const pushed = await this.command('/usr/bin/git', [...repositoryArgs(worktree.identity), 'push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], undefined, pushTimeoutMs)
      .catch((error: unknown) => ({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    if (pushed.code !== 0) {
      // git's own lines say why (a rejected ref, a refused login), its hints how to go on
      const why = (pushed.stderr ?? '').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('hint:')).join(' ').slice(0, 500);
      throw new GithubRequestError(`The push failed: ${why || `git exited ${pushed.code}`}`, 409);
    }
    let created: { number: number; url: string } | undefined;
    try {
      created = await createPullRequest(this.client, token, repository, { base, head: branch, title, body: input.body, draft: input.draft });
      return created;
    } finally {
      this.changed(repository, created?.number);
    }
  }

  // a linked Worktree's branch on a github.com origin, which a pull request can be opened from: the
  // one git has checked out now, never a fork checkout or the repository's default branch (`base`)
  private async pullRequestSource(worktreeId: string): Promise<{ worktree: Worktree; branch: string; repository: GithubRepository; base: string }> {
    const worktree = this.worktrees().find(candidate => candidate.id === worktreeId);
    const project = worktree === undefined ? undefined : this.projects().find(candidate => candidate.id === worktree.projectId);
    const repository = project === undefined ? undefined : await this.projectRepository(project);
    if (worktree === undefined || project === undefined || repository === undefined) throw new GithubRequestError('No Worktree with a github.com origin by that id.', 404);
    if (worktree.main) throw new GithubRequestError('A pull request is opened from a linked Worktree, not the main one.', 409);
    const branch = await checkoutBranch(worktree.identity, this.git);
    if (branch === undefined || forkCheckoutNumber(branch) !== undefined) throw new GithubRequestError('This Worktree has no branch of its own to open a pull request from.', 409);
    const base = await repositoryDefaultBranch(project.path, this.git) ?? '';
    if (branch === base) throw new GithubRequestError(`${branch} is the repository's default branch; a pull request is opened from a branch of its own.`, 409);
    return { worktree, branch, repository, base };
  }

  // the pull request as its detail shows it, which a write must find its target in
  private async writable(repository: GithubRepository, number: number): Promise<PullRequestDetail> {
    const { pullRequest, problem } = await this.pullRequestDetail(repository, number);
    if (pullRequest === undefined) throw problemError(problem ?? { kind: 'failing', message: `${detailAction}.` });
    return pullRequest;
  }

  private async thread(repository: GithubRepository, number: number, threadId: string): Promise<void> {
    if (!(await this.writable(repository, number)).threads.some(thread => thread.id === threadId)) throw new GithubRequestError(`Pull request #${number} has no such Review thread.`, 404);
  }

  // one write to a pull request, after which what the console shows of it is read again
  private async write<T>(repository: GithubRepository, number: number, send: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token();
    if (token === undefined) throw new GithubRequestError(missingToken, 503);
    try {
      return await send(token);
    } finally {
      // even a failed write may have been applied
      this.changed(repository, number);
    }
  }

  /**
   * The console wrote to a pull request (here, or Review tour posting), or tried to create one
   * (`number` unknown when that failed): its detail and repository are read again now (the
   * revision moves, so every view showing it asks again), and while a browser watches, the
   * Overview's searches once GitHub's search index has caught up.
   */
  changed(repository: GithubRepository, number?: number): void {
    if (number !== undefined) this.details.delete(`pull:${repositoryKey(repository)}#${number}`);
    this.changes += 1;
    this.background(this.refreshRepository(repository));
    // one later read covers writes in quick succession
    if (this.searchLag !== undefined) this.timer.clear(this.searchLag);
    this.searchLag = this.viewers === 0 ? undefined : this.timer.set(() => {
      this.searchLag = undefined;
      this.background(this.overviewEntry.refreshing ?? this.read([], false, true));
    }, searchLagMs);
  }

  /**
   * Which of these branch heads a merged or closed pull request proves finished, from data under a
   * minute old (or read now, when `fresh` or older). Only the exact final head counts, unless
   * `acceptAncestor` (for offering a worktree's removal, never for deleting a branch) also takes a
   * head GitHub shows is behind one, as when the author pushed past the checkout. An open pull
   * request for the branch, or any doubt, proves nothing; so does a branch the dashboard reads as
   * unpublished, which is never looked up by name.
   */
  async cleanupHeads(repository: GithubRepository, heads: readonly { branch: string; head: string }[], { fresh = false, acceptAncestor = false }: { fresh?: boolean; acceptAncestor?: boolean } = {}): Promise<Map<string, PullRequestCleanupStatus>> {
    // reject incomplete identities before touching GitHub
    const valid = heads.filter(({ branch, head }) => branch.trim() !== '' && /^[a-f0-9]{40}$/iu.test(head)).map(({ branch, head }) => ({ entry: this.branchEntry(repository, branch), head: head.toLowerCase() })).filter(({ entry }) => !this.tracked(entry) || this.polledByName(entry));
    const due = [...new Set(valid.map(({ entry }) => entry).filter(entry => fresh || this.stale(entry)))];
    for (let offset = 0; offset < due.length; offset += maxBranches) await this.read([{ repository, list: false, branches: due.slice(offset, offset + maxBranches) }], false);
    const statuses = new Map<string, PullRequestCleanupStatus>();
    for (const { entry, head } of valid) {
      const status = await this.cleanupStatus(entry, head, acceptAncestor);
      if (status !== undefined) statuses.set(entry.name, status);
    }
    return statuses;
  }

  // the poll: start it now, or once the last one is a minute old
  private schedule(): void {
    this.unschedule();
    if (this.viewers === 0) return;
    const due = this.lastPollAt === undefined ? 0 : Math.max(0, this.lastPollAt + this.client.interval(freshMs) - this.now());
    this.scheduled = this.timer.set(() => {
      this.scheduled = undefined;
      this.background(this.poll().finally(() => { if (this.scheduled === undefined) this.schedule(); }));
    }, due);
  }

  // a read nobody waits for; GitHub's trouble is already kept as a problem
  private background(work: Promise<void>): void {
    work.catch(() => undefined);
  }

  private unschedule(): void {
    if (this.scheduled !== undefined) this.timer.clear(this.scheduled);
    this.scheduled = undefined;
  }

  // read every Project's lists and every tracked branch in one request
  private async poll(): Promise<void> {
    this.lastPollAt = this.now();
    const plans = new Map<string, Plan>();
    const plan = (repository: GithubRepository): Plan => {
      const key = repositoryKey(repository);
      const found = plans.get(key) ?? { repository, list: true, branches: [] };
      plans.set(key, found);
      return found;
    };
    for (const { repository } of await this.projectRepositories()) plan(repository);
    for (const entry of this.branches.values()) {
      if (!this.tracked(entry)) continue;
      const found = plan(entry.repository);
      if (this.polledByName(entry)) found.branches.push(entry);
    }
    // the searches go in a read of their own, so a slow or failing search cannot stall the lists
    await Promise.all([this.read([...plans.values()], false), this.overviewEntry.refreshing ?? this.read([], false, true)]);
  }

  private tracked(entry: BranchEntry): boolean {
    return entry.readAt !== undefined && this.now() - entry.readAt < trackMs;
  }

  // unpublished branches are never looked up by name, unless one held a pull request when it was
  // (its merge then pruned the remote ref); a fork checkout is looked up by number
  private polledByName(entry: BranchEntry): boolean {
    return entry.published || forkCheckoutNumber(entry.name) !== undefined || (entry.pulls ?? []).some(pull => this.holds(entry, pull));
  }

  private stale(entry: Entry): boolean {
    return entry.fetchedAt === undefined || this.now() - entry.fetchedAt >= this.client.interval(freshMs);
  }

  private repositoryEntry(repository: GithubRepository): RepositoryEntry {
    const key = repositoryKey(repository);
    const entry = this.repositories.get(key) ?? { repository };
    this.repositories.set(key, entry);
    return entry;
  }

  private branchEntry(repository: GithubRepository, name: string): BranchEntry {
    const key = branchKey(repository, name);
    const found = this.branches.get(key);
    if (found !== undefined) return found;
    // drop branches nobody read or looked up for ten minutes on each miss
    for (const [other, entry] of this.branches) {
      if (!this.tracked(entry) && entry.refreshing === undefined && Math.max(entry.readAt ?? 0, entry.fetchedAt ?? 0) + trackMs <= this.now()) this.branches.delete(other);
    }
    const entry: BranchEntry = { repository, name, published: false };
    this.branches.set(key, entry);
    return entry;
  }

  // read one repository's lists and its tracked branches, unless a read of them is running
  private async refreshRepository(repository: GithubRepository): Promise<void> {
    const entry = this.repositoryEntry(repository);
    if (entry.refreshing !== undefined) return await entry.refreshing;
    const key = repositoryKey(repository);
    const branches = [...this.branches.values()].filter(branch => repositoryKey(branch.repository) === key && this.tracked(branch) && this.polledByName(branch));
    await this.read([{ repository, list: true, branches: branches.slice(0, maxBranches) }], false);
  }

  // bring one branch's data under a minute old: by name when published, else through its repository's list
  private async refreshBranch(entry: BranchEntry): Promise<void> {
    if (!this.polledByName(entry)) {
      if (this.stale(this.repositoryEntry(entry.repository))) await this.refreshRepository(entry.repository);
      return;
    }
    if (entry.refreshing !== undefined) return await entry.refreshing;
    if (this.stale(entry)) await this.read([{ repository: entry.repository, list: false, branches: [entry] }], true);
  }

  // one GraphQL read of `plans` (and the Overview's searches, with `overview`), stored as it
  // arrives; a failure keeps every entry's last data beside the problem. `full` also counts a
  // looked-up branch's threads and closing issues.
  private async read(plans: readonly Plan[], full: boolean, overview = false): Promise<void> {
    const wanted = plans.filter(plan => plan.list || plan.branches.length > 0);
    if (wanted.length === 0 && !overview) return;
    const entries = [...wanted.flatMap(plan => this.planEntries(plan)), ...(overview ? [this.overviewEntry] : [])];
    const reading = this.fetch(wanted, full, overview);
    const settled = reading.then(() => undefined, () => undefined);
    for (const entry of entries) entry.refreshing = settled;
    try {
      await reading;
    } finally {
      for (const entry of entries) if (entry.refreshing === settled) delete entry.refreshing;
    }
  }

  private async fetch(plans: readonly Plan[], full: boolean, overview: boolean): Promise<void> {
    const started = this.now();
    const searched = overview ? [this.overviewEntry] : [];
    const token = await this.token();
    if (token === undefined) return this.failed(plans, { kind: 'no-token', message: missingToken }, searched);
    let payload: GraphqlPayload;
    try {
      const { query, variables } = readQuery(plans, full, overview);
      payload = await this.client.query(token, query, variables, readAction);
    } catch (error) {
      // anything but GitHub's own trouble is a bug
      if (!(error instanceof GithubRequestError)) throw error;
      return this.failed(plans, problemOf(error), searched);
    }
    if (overview) {
      const [mine, reviews, assigned] = [at(payload, 'data', 'mine'), at(payload, 'data', 'reviews'), at(payload, 'data', 'assigned')];
      const total = (search: unknown): number => positive(at(search, 'issueCount')) ?? 0;
      // a search GitHub withheld (named in `errors`) is not an empty one
      if ([mine, reviews, assigned].some(search => search === null || typeof search !== 'object')) this.failed([], { kind: 'failing', message: graphqlError(payload, readAction).message }, searched);
      else {
        // the badge counts against the seen record, so it is read before the lists land
        await this.seen.load();
        // a list cut at its page may miss a repository's requests, which a Watch then reads itself
        const complete = nodes(reviews).length >= total(reviews);
        this.store(this.overviewEntry, started, { mine: nodes(mine).flatMap(myPullRow), reviews: nodes(reviews).flatMap(reviewRow), issues: nodes(assigned).flatMap(issueRow), totals: { mine: total(mine), reviews: total(reviews), issues: total(assigned) }, requests: complete ? viewerRequests(nodes(reviews)) : undefined });
        await this.pruneSeen();
      }
    }
    plans.forEach((plan, index) => {
      const node = at(payload, 'data', `r${index}`);
      // GitHub answers for the repositories it can show and names the rest in `errors`
      if (node === null || typeof node !== 'object') return this.failed([plan], { kind: 'failing', message: graphqlError(payload, readAction).message });
      if (plan.list) {
        const [open, issues] = [at(node, 'open'), at(node, 'issues')];
        // a list GitHub withheld (named in `errors`) is not an empty one
        if (open === null || typeof open !== 'object' || issues === null || typeof issues !== 'object') this.failed([{ ...plan, branches: [] }], { kind: 'failing', message: graphqlError(payload, readAction).message });
        else this.store(this.repositoryEntry(plan.repository), started, { open: nodes(open).map(readPull).filter((pull): pull is Pull => pull !== undefined), issues: nodes(issues).flatMap(readIssue) });
      }
      plan.branches.forEach((entry, position) => this.store(entry, started, readBranch(at(node, `b${position}`), forkCheckoutNumber(entry.name) !== undefined)));
    });
  }

  // the cache entries one read fills
  private planEntries(plan: Plan): Entry[] {
    return [...(plan.list ? [this.repositoryEntry(plan.repository)] : []), ...plan.branches];
  }

  // keep what one read gave, unless a read that started later already stored newer data; the
  // revision moves when the data or its problem changes
  private store<T extends Entry>(entry: T, started: number, data: Partial<T>): void {
    if (entry.fetchedAt !== undefined && entry.fetchedAt > started) return;
    const changed = entry.problem !== undefined || (Object.keys(data) as (keyof T)[]).some(key => JSON.stringify(entry[key]) !== JSON.stringify(data[key]));
    Object.assign(entry, data, { fetchedAt: started });
    delete entry.problem;
    if (changed) this.changes += 1;
  }

  private failed(plans: readonly Plan[], problem: GithubProblem, others: readonly Entry[] = []): void {
    for (const entry of [...plans.flatMap(plan => this.planEntries(plan)), ...others]) {
      if (JSON.stringify(entry.problem) !== JSON.stringify(problem)) this.changes += 1;
      entry.problem = problem;
    }
  }

  // whether a pull request is this branch's: from its head on origin, or by number for a fork checkout
  private holds(entry: BranchEntry, pull: Pull): boolean {
    const fork = forkCheckoutNumber(entry.name);
    return fork === undefined ? pull.headOnOrigin && pull.branch === entry.name : pull.number === fork;
  }

  // the branch's pull request from the newer of its own lookup and its repository's open list:
  // an open one first, else the latest merged; one closed without merging shows nothing
  private summaryOf(entry: BranchEntry): BranchSummary {
    const listed = this.repositories.get(repositoryKey(entry.repository));
    const listedOpen = (listed?.open ?? []).filter(pull => this.holds(entry, pull));
    const own = (entry.pulls ?? []).filter(pull => this.holds(entry, pull));
    const ownNewer = entry.fetchedAt !== undefined && (listed?.fetchedAt === undefined || entry.fetchedAt >= listed.fetchedAt);
    // a lookup GitHub cut short may have missed the branch's own pull request among forks' of the same name
    const pulls = ownNewer && entry.complete === true ? own : [...listedOpen, ...own.filter(pull => pull.state !== 'open')];
    const chosen = pulls.find(pull => pull.state === 'open') ?? pulls.find(pull => pull.state === 'merged');
    // a lookup by name does not count threads; the open list does
    const counted = chosen?.unresolvedThreads === undefined ? listedOpen.find(pull => pull.number === chosen?.number) : undefined;
    return { ...(chosen === undefined ? {} : { pullRequest: summary({ ...chosen, ...(counted?.unresolvedThreads === undefined ? {} : { unresolvedThreads: counted.unresolvedThreads }) }) }), ...fetched(ownNewer || listed === undefined ? entry : listed) };
  }

  // what one branch's last lookup proves about one exact head; any failure or gap proves nothing
  private async cleanupStatus(entry: BranchEntry, head: string, acceptAncestor: boolean): Promise<PullRequestCleanupStatus | undefined> {
    if (entry.fetchedAt === undefined || entry.problem !== undefined || entry.complete !== true) return undefined;
    const pulls = (entry.pulls ?? []).filter(pull => this.holds(entry, pull));
    if (pulls.some(pull => pull.state === 'open')) return undefined;
    const exact = pulls.filter(pull => pull.headSha === head);
    if (exact.some(pull => pull.state === 'merged')) return 'merged';
    if (exact.length > 0) return 'closed';
    if (!acceptAncestor) return undefined;
    const finals = [...pulls.filter(pull => pull.state === 'merged'), ...pulls.filter(pull => pull.state === 'closed')];
    for (const final of finals.slice(0, maxAncestorCompares)) {
      const compared = await this.compare(entry.repository, final.headSha, head);
      if (compared === 'behind' || compared === 'identical') return final.state as PullRequestCleanupStatus;
    }
    return undefined;
  }

  // how `head` stands against `base` on GitHub, remembered once known; a failure is retried next time
  private async compare(repository: GithubRepository, base: string, head: string): Promise<unknown> {
    const key = `${repositoryKey(repository)}:${base}...${head}`;
    if (this.compares.has(key)) return this.compares.get(key);
    const token = await this.token();
    const response = await this.client.get(apiUrl(repository, `compare/${base}...${head}`), token, 'GitHub could not compare the checkout with its pull request').catch(() => undefined);
    const status = at(await response?.json().catch(() => undefined), 'status');
    if (typeof status !== 'string') return undefined;
    if (this.compares.size >= maxCompares) this.compares.delete(this.compares.keys().next().value!);
    this.compares.set(key, status);
    return status;
  }

  private async origin(path: string): Promise<GithubRepository | undefined> {
    const remote = await this.command('/usr/bin/git', [...repositoryArgs(path), 'remote', 'get-url', 'origin']);
    return remote.code === 0 ? githubRepository(remote.stdout) : undefined;
  }
}

// one well-formed comment; a deleted account reads as GitHub's own `ghost`; `mine` marks the viewer's
function prComment(value: unknown): PullRequestComment[] {
  const [id, body, createdAt, url] = [at(value, 'id'), at(value, 'body'), at(value, 'createdAt'), at(value, 'url')];
  if (typeof id !== 'string' || typeof body !== 'string' || typeof createdAt !== 'string' || typeof url !== 'string' || !url.startsWith('https://github.com/')) return [];
  const login = at(value, 'author', 'login');
  return [{ id, author: typeof login === 'string' ? login : 'ghost', bot: at(value, 'author', '__typename') === 'Bot', ...(at(value, 'viewerDidAuthor') === true ? { mine: true as const } : {}), body, createdAt, url }];
}

// what a detail was read at: a list or branch lookup reading the pull request otherwise means it changed
const pullVersion = (pull: Pull): string => [pull.state, pull.updatedAt, pull.headSha, pull.checks, pull.conflicts, pull.unresolvedThreads].join('|');

// a link to a web page, which a check may name on any host
function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

// one check run or commit status; a run that concluded counts as GitHub's rollup counts it, even
// one still reporting itself in progress
function readCheck(value: unknown): PullRequestCheck[] {
  const run = at(value, '__typename') === 'CheckRun';
  const [name, url] = run ? [at(value, 'name'), webUrl(at(value, 'detailsUrl'))] : [at(value, 'context'), webUrl(at(value, 'targetUrl'))];
  if (typeof name !== 'string') return [];
  const [conclusion, state] = [at(value, 'conclusion'), at(value, 'state')];
  const status: PullRequestCheck['status'] = run
    ? typeof conclusion !== 'string' ? 'pending' : conclusion === 'SUCCESS' ? 'passed' : conclusion === 'NEUTRAL' || conclusion === 'SKIPPED' ? 'skipped' : 'failed'
    : state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : 'pending';
  return [{ name, status, ...(url === undefined ? {} : { url }) }];
}

const reviewStates = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed' } as const;

// each reviewer's latest submitted review, then those asked for a review now (teams by slug)
function readReviewers(node: unknown, head: string): PullRequestReviewer[] {
  const reviewers = new Map<string, PullRequestReviewer>();
  for (const review of nodes(at(node, 'latestReviews'))) {
    const [login, state] = [at(review, 'author', 'login'), reviewStates[at(review, 'state') as keyof typeof reviewStates]];
    if (typeof login !== 'string' || state === undefined) continue;
    const [commit, id] = [at(review, 'commit', 'oid'), at(review, 'author', 'id')];
    reviewers.set(login, { login, ...(typeof id === 'string' ? { id } : {}), ...(at(review, 'author', '__typename') === 'Bot' ? { bot: true as const } : {}), state, ...(typeof commit === 'string' && commit.toLowerCase() !== head ? { newCommits: true as const } : {}) });
  }
  for (const request of nodes(at(node, 'reviewRequests'))) {
    const reviewer = at(request, 'requestedReviewer');
    const team = at(reviewer, '__typename') === 'Team';
    const login = at(reviewer, team ? 'slug' : 'login');
    if (typeof login !== 'string') continue;
    const key = team ? `team:${login}` : login;
    const id = at(reviewer, 'id');
    reviewers.set(key, { ...reviewers.get(key) ?? { login, ...(typeof id === 'string' ? { id } : {}), ...(team ? { team: true as const } : at(reviewer, '__typename') === 'Bot' ? { bot: true as const } : {}) }, requested: true });
  }
  return [...reviewers.values()];
}

// one pull request's detail as GitHub gave it; undefined for none, or one that is not well formed
function readDetail(repository: GithubRepository, node: unknown): { data: PullRequestDetail; versions: string[] } | undefined {
  const pull = readPull(node);
  if (pull === undefined) return undefined;
  const threads = nodes(at(node, 'reviewThreads')).flatMap((thread): PullRequestReviewThread[] => {
    const comments = nodes(at(thread, 'comments')).flatMap(prComment);
    const [id, path] = [at(thread, 'id'), at(thread, 'path')];
    if (typeof id !== 'string' || typeof path !== 'string' || comments.length === 0) return [];
    const line = positive(at(thread, 'line')) ?? positive(at(thread, 'originalLine'));
    const startLine = positive(at(thread, 'startLine')) ?? positive(at(thread, 'originalStartLine'));
    const diffHunk = at(nodes(at(thread, 'comments'))[0], 'diffHunk');
    return [{ id, path, ...(line === undefined ? {} : { line }), ...(startLine === undefined || startLine === line ? {} : { startLine }), resolved: at(thread, 'isResolved') === true, outdated: at(thread, 'isOutdated') === true, diffHunk: typeof diffHunk === 'string' ? diffHunk : '', comments }];
  });
  // a review with no summary text is only its inline threads; a pending one is the viewer's unsent draft
  const reviews = nodes(at(node, 'reviews')).flatMap(review => {
    const state = at(review, 'state');
    if (typeof state !== 'string' || state === 'PENDING') return [];
    return prComment({ ...review as object, createdAt: at(review, 'submittedAt') }).filter(comment => comment.body.trim() !== '').map(comment => ({ ...comment, state }));
  });
  // the submitter's opening comment, left out when they wrote none
  const [description] = prComment(node).filter(comment => comment.body.trim() !== '');
  const mergeable = at(node, 'mergeable');
  const name = `${repository.owner}/${repository.name}`;
  // only this repository's: the panel opens a Linked issue by number
  const linkedIssues = nodes(at(node, 'closingIssuesReferences')).filter(issue => String(at(issue, 'repository', 'nameWithOwner')).toLowerCase() === name.toLowerCase()).flatMap((issue): LinkedIssue[] => {
    const [number, title, url, state] = [positive(at(issue, 'number')), at(issue, 'title'), githubUrl(at(issue, 'url')), at(issue, 'state')];
    return number === undefined || typeof title !== 'string' || url === undefined ? [] : [{ number, title, url, state: state === 'CLOSED' ? 'closed' : 'open' }];
  });
  const { unresolvedThreads: _threads, closingIssues: _closing, conflicts: _conflicts, ...fields } = pull;
  return {
    data: {
      ...fields, id: String(at(node, 'id')), repository: name, ...(description === undefined ? {} : { description }), threads, reviews, comments: nodes(at(node, 'comments')).flatMap(prComment),
      mergeable: mergeable === 'CONFLICTING' ? 'conflicting' : mergeable === 'MERGEABLE' ? 'mergeable' : 'unknown',
      checkRuns: nodes(at(node, 'statusCheckRollup', 'contexts')).flatMap(readCheck), reviewers: readReviewers(node, pull.headSha), linkedIssues
    },
    versions: [pullVersion(pull), pullVersion({ ...pull, unresolvedThreads: undefined })]
  };
}

// one Issue's detail as GitHub gave it, with the heads of its own repository's linked pull
// requests, which find its Worktree
function readIssueDetail(repository: GithubRepository, node: unknown): { data: IssueDetail & { heads: OverviewRow['heads'] }; versions: string[] } | undefined {
  const [issue] = readIssue(node);
  const state = at(node, 'state');
  if (issue === undefined || (state !== 'OPEN' && state !== 'CLOSED')) return undefined;
  const name = `${repository.owner}/${repository.name}`;
  const body = at(node, 'body');
  const labels = nodes(at(node, 'labels')).map(label => at(label, 'name')).filter((label): label is string => typeof label === 'string');
  const linked = nodes(at(node, 'closedByPullRequestsReferences')).filter(pull => String(at(pull, 'repository', 'nameWithOwner')).toLowerCase() === name.toLowerCase()).flatMap(pull => {
    const [number, title, url, pullState] = [positive(at(pull, 'number')), at(pull, 'title'), githubUrl(at(pull, 'url')), at(pull, 'state')];
    if (number === undefined || typeof title !== 'string' || url === undefined) return [];
    return [{ pull: { number, title, url, state: pullState === 'MERGED' ? 'merged' as const : pullState === 'CLOSED' ? 'closed' as const : 'open' as const, draft: at(pull, 'isDraft') === true }, heads: pullHead(pull, number) }];
  });
  return {
    data: { ...issue, repository: name, state: state === 'OPEN' ? 'open' : 'closed', body: typeof body === 'string' ? body : '', labels, linkedPullRequests: linked.map(({ pull }) => pull), heads: linked.flatMap(({ heads }) => heads) },
    versions: [issue.updatedAt ?? '']
  };
}
