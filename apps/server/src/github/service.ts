import { run } from '../tmux/command.js';
import { repositoryArgs } from '../git/worktrees.js';
import type { Project, PullRequestCheckStatus, PullRequestComment, PullRequestComments, PullRequestIssues, PullRequestReviewThread, PullRequestSummary, Worktree } from '../domain/models.js';
import { at, GithubClient, GithubRequestError, graphqlError, githubRepository, githubToken, repositoryPath, type Command, type GithubRepository, type GraphqlPayload, type Request, type Token } from './github.js';

export type PullRequestCleanupStatus = 'merged' | 'closed';
export type PullRequestChoice = { number: number; title: string; branch: string; headSha: string; headOnOrigin: boolean; draft: boolean; url: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };
export type OpenPullRequestChoices = { own: PullRequestChoice[]; others: PullRequestChoice[] };
export type RepositoryIssue = { number: number; title: string; url: string };
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
 * One row of the Overview. `reasons` is empty unless it is Waiting on me; the rest are hints:
 * commits pushed since my review, an approval, a draft, the Issues a PR closes, the PRs linked to
 * an Issue, labels. `checks` is set on my own PRs only.
 */
export type OverviewItem = {
  repository: string; number: number; title: string; url: string; author?: string; updatedAt?: string;
  draft?: true; checks?: PullRequestCheckStatus; reasons: OverviewReason[];
  newCommits?: true; approved?: true; closes?: number[]; linkedPullRequests?: number[]; labels?: string[];
  destination?: OverviewDestination;
};
/** The Overview's three lists, each GitHub's newest first, with how many GitHub found in all. */
export type Overview = Fetched<{ mine: OverviewItem[]; reviews: OverviewItem[]; issues: OverviewItem[]; totals: { mine: number; reviews: number; issues: number } }>;
/** Runs the poll; injected so tests turn the clock by hand. */
export type Timer = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
export type GithubServiceOptions = { request?: Request; command?: Command; now?: () => number; token?: Token; timer?: Timer; projects?: () => readonly Project[]; worktrees?: () => readonly Worktree[] };

// one pull request as the module keeps it; `unresolvedThreads` and `closingIssues` are only known
// from a read that asked for them
type Pull = { number: number; title: string; url: string; state: 'open' | 'closed' | 'merged'; draft: boolean; baseBranch?: string; branch: string; headSha: string; headOnOrigin: boolean; mine: boolean; conflicts: boolean; checks: PullRequestCheckStatus; unresolvedThreads?: number; closingIssues?: number[] };
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
// an Overview row as read, with the heads that find its Worktree: a PR's own, an Issue's linked PRs'
type OverviewRow = Omit<OverviewItem, 'destination'> & { heads: { number: number; branch: string; onOrigin: boolean }[] };
type OverviewEntry = Entry & { mine?: OverviewRow[]; reviews?: OverviewRow[]; issues?: OverviewRow[]; totals?: Overview['totals'] };

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
// bound the final heads one branch's ancestry check compares against, and the comparisons kept
const maxAncestorCompares = 3;
const maxCompares = 1_000;
const maxRemoteHeads = 8;
// a Refresh this soon after the last read answers from it, so repeated clicks cannot drain the budget
const refreshFloorMs = 10_000;

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

const commentsQuery = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  id author{login __typename} body createdAt url
  reviewThreads(first:100){nodes{id isResolved isOutdated path line startLine originalLine originalStartLine comments(first:50){nodes{id author{login __typename} body createdAt url diffHunk}}}}
  reviews(last:100){nodes{id author{login __typename} state body submittedAt url}}
  comments(last:100){nodes{id author{login __typename} body createdAt url}}
}}}`;
// what every read takes of a pull request; the open lists and a waiting read of one branch also
// count its threads and the issues it closes
const pullFields = 'number title url state isDraft baseRefName headRefName headRefOid isCrossRepository viewerDidAuthor mergeable statusCheckRollup{state}';
const fullPullFields = `${pullFields} reviewThreads(first:100){nodes{isResolved isOutdated}} closingIssuesReferences(first:10){nodes{number}}`;
// the Overview's three searches, newest first; review threads and their last speaker are read
// for my own PRs only, since they cost the most
const overviewPullFields = 'number title url state isDraft updatedAt repository{nameWithOwner} author{login} headRefName headRefOid isCrossRepository mergeable statusCheckRollup{state} labels(first:5){nodes{name}}';
const overviewSearches = {
  mine: { query: 'is:pr is:open author:@me archived:false sort:updated-desc', first: 20, fields: `...on PullRequest{${overviewPullFields} latestOpinionatedReviews(first:10){nodes{id state author{login} commit{oid}}} reviewThreads(last:50){nodes{id isResolved isOutdated path comments(last:1){nodes{author{login} viewerDidAuthor}}}} closingIssuesReferences(first:5){nodes{number}}}` },
  reviews: { query: 'is:pr is:open review-requested:@me archived:false sort:updated-desc', first: 30, fields: `...on PullRequest{${overviewPullFields} viewerLatestReviewRequest{id} viewerLatestReview{state commit{oid}}}` },
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
  const base = at(value, 'baseRefName');
  const threads = at(value, 'reviewThreads', 'nodes');
  const closing = at(value, 'closingIssuesReferences', 'nodes');
  return {
    number, title, url, branch, headSha: headSha.toLowerCase(),
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
  const [number, title, url] = [positive(at(value, 'number')), at(value, 'title'), githubUrl(at(value, 'url'))];
  return number === undefined || typeof title !== 'string' || url === undefined ? [] : [{ number, title, url }];
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
      `issues(states:OPEN,first:${issuePage},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url}}`
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
  return { repository, number, title, url, ...(typeof author === 'string' ? { author } : {}), ...(typeof updatedAt === 'string' ? { updatedAt } : {}), reasons: [], ...(labels.length === 0 ? {} : { labels }), heads: [] };
}

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
  const threads = nodes(at(value, 'reviewThreads')).flatMap((thread): OverviewReason[] => {
    const [id, path, last] = [at(thread, 'id'), at(thread, 'path'), nodes(at(thread, 'comments'))[0]];
    if (typeof id !== 'string' || typeof path !== 'string' || last === undefined || at(thread, 'isResolved') !== false || at(thread, 'isOutdated') !== false || at(last, 'viewerDidAuthor') !== false) return [];
    const author = at(last, 'author', 'login');
    return [{ kind: 'thread', id, path, author: typeof author === 'string' ? author : 'ghost' }];
  });
  const changes = reviews.flatMap((review): OverviewReason[] => {
    const [id, author] = [at(review, 'id'), at(review, 'author', 'login')];
    return at(review, 'state') === 'CHANGES_REQUESTED' && typeof id === 'string' && at(review, 'commit', 'oid') === at(value, 'headRefOid') ? [{ kind: 'changes', id, author: typeof author === 'string' ? author : 'ghost' }] : [];
  });
  const reasons: OverviewReason[] = draft ? [] : [...threads, ...(checks === 'failed' ? [{ kind: 'checks' as const }] : []), ...(at(value, 'mergeable') === 'CONFLICTING' ? [{ kind: 'conflicts' as const }] : []), ...changes];
  const states = reviews.map(review => at(review, 'state'));
  const closes = nodes(at(value, 'closingIssuesReferences')).map(issue => positive(at(issue, 'number'))).filter((issue): issue is number => issue !== undefined);
  return [{
    ...row, heads: pullHead(value, row.number), checks, reasons,
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
  const reRequested = reviewed && at(value, 'viewerLatestReviewRequest', 'id') !== undefined;
  const reviewedAt = reviewed ? at(review, 'commit', 'oid') : undefined;
  return [{
    ...row, heads: pullHead(value, row.number),
    ...(draft ? { draft: true as const } : { reasons: [reRequested ? { kind: 'review', reRequested: true } : { kind: 'review' }] }),
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
  private readonly now: () => number;
  private readonly readToken: Token;
  private readonly timer: Timer;
  private readonly projects: () => readonly Project[];
  private readonly worktrees: () => readonly Worktree[];
  private readonly overviewEntry: OverviewEntry = {};
  private viewerMemo?: { token: string; login: Promise<string> };
  private viewers = 0;
  private scheduled?: unknown;
  private lastPollAt?: number;
  private changes = 0;

  constructor({ request = fetch, command = run, now = () => Date.now(), token = githubToken, timer = realTimer, projects = () => [], worktrees = () => [] }: GithubServiceOptions = {}) {
    this.command = command;
    this.now = now;
    this.readToken = token;
    this.timer = timer;
    this.projects = projects;
    this.worktrees = worktrees;
    this.client = new GithubClient(request, { now, refused: () => { this.viewerMemo = undefined; } });
  }

  /** Moves whenever the data the module serves changes, so views know to read it again. */
  get revision(): number { return this.changes; }

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

  /** The login the token belongs to, looked up once per token and again after GitHub refuses it. */
  async viewer(): Promise<string> {
    const token = await this.token();
    if (token === undefined) throw new GithubRequestError(missingToken, 503);
    if (this.viewerMemo?.token !== token) this.viewerMemo = { token, login: this.viewerLogin(token) };
    const memo = this.viewerMemo;
    try {
      return await memo.login;
    } catch (error) {
      // a failed lookup is not kept
      if (this.viewerMemo === memo) this.viewerMemo = undefined;
      throw error;
    }
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
    const entry = this.repositoryEntry(repository);
    if (this.stale(entry)) {
      const refreshing = this.refreshRepository(repository);
      if (wait || entry.fetchedAt === undefined) await refreshing; else this.background(refreshing);
    }
    const open = entry.open ?? [];
    return { own: open.filter(pull => pull.mine).map(choice), others: open.filter(pull => !pull.mine).map(choice), issues: entry.issues ?? [], ...fetched(entry) };
  }

  /**
   * The operator's open Pull requests, Review requests and assigned Issues across every repository
   * they can access, with why each is Waiting on me and where tapping it goes. Answers from what the
   * poll read; data older than a minute is refreshed behind the answer, unless it was never read,
   * or `fresh` asks for it read again now (Refresh, Retry), which data under ten seconds old answers.
   */
  async overview({ fresh = false }: { fresh?: boolean } = {}): Promise<Overview> {
    const entry = this.overviewEntry;
    const forced = fresh && (entry.fetchedAt === undefined || this.now() - entry.fetchedAt >= refreshFloorMs);
    if (forced || this.stale(entry)) {
      const refreshing = entry.refreshing ?? this.read([], false, true);
      if (forced || entry.fetchedAt === undefined) await refreshing; else this.background(refreshing);
    }
    const destination = await this.destinations();
    const rows = (list: OverviewRow[] | undefined): OverviewItem[] => (list ?? []).map(({ heads, ...row }) => {
      const found = destination(row.repository, heads);
      return found === undefined ? row : { ...row, destination: found };
    });
    return { mine: rows(entry.mine), reviews: rows(entry.reviews), issues: rows(entry.issues), totals: entry.totals ?? { mine: 0, reviews: 0, issues: 0 }, ...fetched(entry) };
  }

  // where an Overview row in a repository goes: the Worktree holding one of its heads, else its
  // Project's main worktree; nowhere in the console for a repository with no Project
  private async destinations(): Promise<(repository: string, heads: OverviewRow['heads']) => OverviewDestination | undefined> {
    const projects = new Map<string, Project>();
    for (const { project, repository } of await this.projectRepositories()) if (!projects.has(repositoryKey(repository))) projects.set(repositoryKey(repository), project);
    const worktrees = this.worktrees();
    return (repository, heads) => {
      // GitHub's `owner/name`, keyed as `repositoryKey` keys it
      const project = projects.get(repository.toLowerCase());
      if (project === undefined) return undefined;
      const own = worktrees.filter(worktree => worktree.projectId === project.id);
      const holder = own.find(worktree => worktree.branch !== undefined && heads.some(head => forkCheckoutNumber(worktree.branch!) === head.number || (head.onOrigin && worktree.branch === head.branch)));
      if (holder !== undefined) return { kind: 'worktree', worktreeId: holder.id, label: holder.label };
      const main = own.find(worktree => worktree.main);
      return main === undefined ? undefined : { kind: 'project', worktreeId: main.id, label: project.label };
    };
  }

  // each repository Project and the GitHub repository its origin names
  private async projectRepositories(): Promise<{ project: Project; repository: GithubRepository }[]> {
    const found: { project: Project; repository: GithubRepository }[] = [];
    for (const project of this.projects()) {
      const repository = project.mode === 'repository' ? await this.repositoryAt(project.path).catch(() => undefined) : undefined;
      if (repository !== undefined) found.push({ project, repository });
    }
    return found;
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

  /** The description, review threads, review summaries and conversation of one pull request, read fresh. */
  async pullRequest(repository: GithubRepository, number: number): Promise<PullRequestComments> {
    const token = await this.token();
    if (token === undefined) throw new GithubRequestError(missingToken, 503);
    const payload = await this.client.query(token, commentsQuery, { owner: repository.owner, repo: repository.name, number }, 'GitHub could not load the pull request comments');
    const node = at(payload, 'data', 'repository', 'pullRequest');
    if (node === null || typeof node !== 'object') throw graphqlError(payload, 'GitHub could not load the pull request comments');
    const threads = nodes(at(node, 'reviewThreads')).flatMap((thread): PullRequestReviewThread[] => {
      const comments = nodes(at(thread, 'comments')).flatMap(prComment);
      const path = at(thread, 'path');
      const id = at(thread, 'id');
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
    // GitHub's own URL survives a renamed repository
    const url = at(node, 'url');
    return { number, url: typeof url === 'string' && url.startsWith('https://github.com/') ? url : `https://github.com/${repositoryPath(repository)}/pull/${number}`, ...(description === undefined ? {} : { description }), threads, reviews, comments: nodes(at(node, 'comments')).flatMap(prComment) };
  }

  /** An outside writer (Review tour posting) changed a pull request: its repository is read again now. */
  changed(repository: GithubRepository, _number: number): void {
    this.background(this.refreshRepository(repository));
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
    const key = `${repositoryKey(repository)}:${name}`;
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
      else this.store(this.overviewEntry, started, { mine: nodes(mine).flatMap(myPullRow), reviews: nodes(reviews).flatMap(reviewRow), issues: nodes(assigned).flatMap(issueRow), totals: { mine: total(mine), reviews: total(reviews), issues: total(assigned) } });
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

  // identify the authenticated GitHub user
  private async viewerLogin(token: string): Promise<string> {
    const response = await this.client.get('https://api.github.com/user', token, 'GitHub could not identify the authenticated user');
    const value = await response.json().catch(() => undefined);
    // require the authenticated login
    if (value === null || typeof value !== 'object' || typeof (value as { login?: unknown }).login !== 'string') throw new GithubRequestError('GitHub returned invalid authenticated user data.');
    return (value as { login: string }).login;
  }
}

// one well-formed comment; a deleted account reads as GitHub's own `ghost`
function prComment(value: unknown): PullRequestComment[] {
  const [id, body, createdAt, url] = [at(value, 'id'), at(value, 'body'), at(value, 'createdAt'), at(value, 'url')];
  if (typeof id !== 'string' || typeof body !== 'string' || typeof createdAt !== 'string' || typeof url !== 'string' || !url.startsWith('https://github.com/')) return [];
  const login = at(value, 'author', 'login');
  return [{ id, author: typeof login === 'string' ? login : 'ghost', bot: at(value, 'author', '__typename') === 'Bot', body, createdAt, url }];
}
