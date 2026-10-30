import { run } from '../tmux/command.js';
import { repositoryArgs } from '../git/worktrees.js';
import type { PullRequestCheckStatus, PullRequestComment, PullRequestComments, PullRequestIssues, PullRequestReviewThread, PullRequestSummary } from '../domain/models.js';
import { at, GithubClient, GithubRequestError, graphqlError, githubRepository, githubToken, repositoryPath, type Command, type GithubRepository, type Request, type Token } from './github.js';

type PullRequestCandidate = PullRequestSummary & { headSha?: string };
type PullRequestChoiceCandidate = PullRequestChoice & { ownedByViewer: boolean };
export type PullRequestCleanupStatus = 'merged' | 'closed';
export type PullRequestChoice = { number: number; title: string; branch: string; headSha: string; headOnOrigin: boolean; draft: boolean; url: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };
export type OpenPullRequestChoices = { own: PullRequestChoice[]; others: PullRequestChoice[] };
/** Why GitHub data may be missing or old: no token, a rate limit holding requests until `until`, or GitHub failing. */
export type GithubProblem = { kind: 'no-token' | 'rate-limited' | 'failing'; message: string; until?: number };
/** The last data GitHub gave, when it was fetched (never, while `fetchedAt` is absent), and why a later fetch failed. */
export type Fetched<T> = T & { fetchedAt?: number; problem?: GithubProblem };
export type BranchSummary = Fetched<{ pullRequest?: PullRequestSummary }>;
export type RepositoryPullRequests = Fetched<OpenPullRequestChoices>;
export type GithubServiceOptions = { request?: Request; command?: Command; now?: () => number; token?: Token };

type SummaryEntry = BranchSummary & { expiresAt: number; pending?: Promise<void> };
type CleanupEntry = { expiresAt?: number; pending: Promise<PullRequestCleanupStatus | undefined> };
type OriginEntry = { expiresAt?: number; pending: Promise<GithubRepository | undefined> };

const cacheTtlMs = 60_000;
const repositoryCacheTtlMs = 30_000;
const missingToken = 'GitHub authentication is not configured for pull request lookup.';
// bound the final heads one branch's ancestry check compares against
const maxAncestorCompares = 3;

// the console-owned local branch a fork pull request checks out as, since its head branch
// lives in another repository; `forkCheckoutNumber` reads the number back from one
export const forkCheckoutBranch = (pullRequest: Pick<PullRequestChoice, 'number' | 'headSha'>): string => `rac/pr/${pullRequest.number}/${pullRequest.headSha.slice(0, 12)}`;
export function forkCheckoutNumber(branch: string): number | undefined {
  const match = /^rac\/pr\/([1-9]\d{0,9})\/[a-f0-9]{12}$/u.exec(branch);
  return match === null ? undefined : Number(match[1]);
}
// how a closed pull request ended, from GitHub's `merged_at`; anything but null or a timestamp
// is an incomplete marker that proves nothing
function closedStatus(mergedAt: unknown): PullRequestCleanupStatus | undefined {
  if (mergedAt === null) return 'closed';
  return typeof mergedAt === 'string' && mergedAt.trim() !== '' ? 'merged' : undefined;
}
const commentsQuery = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  id author{login __typename} body createdAt url
  reviewThreads(first:100){nodes{id isResolved isOutdated path line startLine originalLine originalStartLine comments(first:50){nodes{id author{login __typename} body createdAt url diffHunk}}}}
  reviews(last:100){nodes{id author{login __typename} state body submittedAt url}}
  comments(last:100){nodes{id author{login __typename} body createdAt url}}
}}}`;
const reviewThreadsQuery = 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated}}}}}';
const failingCheckConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

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

// one well-formed comment; a deleted account reads as GitHub's own `ghost`
function prComment(value: unknown): PullRequestComment[] {
  const [id, body, createdAt, url] = [at(value, 'id'), at(value, 'body'), at(value, 'createdAt'), at(value, 'url')];
  if (typeof id !== 'string' || typeof body !== 'string' || typeof createdAt !== 'string' || typeof url !== 'string' || !url.startsWith('https://github.com/')) return [];
  const login = at(value, 'author', 'login');
  return [{ id, author: typeof login === 'string' ? login : 'ghost', bot: at(value, 'author', '__typename') === 'Bot', body, createdAt, url }];
}

/** The error a caller that cannot show last-known data raises for a problem, as reads raised before problems existed. */
export function problemError(problem: GithubProblem): GithubRequestError {
  return new GithubRequestError(problem.message, problem.kind === 'no-token' ? 503 : 502, undefined, problem.kind === 'rate-limited' ? 'transient' : 'rejected', problem.until);
}

// a summary's fields that are set
function presentSummary({ pullRequest, fetchedAt, problem }: BranchSummary): BranchSummary {
  return { ...(pullRequest === undefined ? {} : { pullRequest }), ...(fetchedAt === undefined ? {} : { fetchedAt }), ...(problem === undefined ? {} : { problem }) };
}

// what a failed read tells the operator
function problemOf(error: unknown, token: string | undefined): GithubProblem {
  if (error instanceof GithubRequestError && error.until !== undefined) return { kind: 'rate-limited', message: error.message, until: error.until };
  if (token === undefined) return { kind: 'no-token', message: missingToken };
  return { kind: 'failing', message: error instanceof GithubRequestError ? error.message : 'GitHub could not be read.' };
}

/**
 * The console's GitHub: every read and write, through one shared client, one token and one viewer.
 * Reads of lists and summaries never throw because GitHub is having trouble; they return the last
 * data they had, with a `problem` saying why it is not newer.
 */
export class GithubService {
  readonly client: GithubClient;
  private readonly summaries = new Map<string, SummaryEntry>();
  private readonly lists = new Map<string, RepositoryPullRequests>();
  private readonly cleanupHeads = new Map<string, CleanupEntry & { branch: string; headSha: string }>();
  private readonly origins = new Map<string, OriginEntry>();
  private readonly command: Command;
  private readonly now: () => number;
  private readonly readToken: Token;
  private viewerMemo?: { token: string; login: Promise<string> };

  constructor({ request = fetch, command = run, now = Date.now, token = githubToken }: GithubServiceOptions = {}) {
    this.command = command;
    this.now = now;
    this.readToken = token;
    this.client = new GithubClient(request, { now, refused: () => { this.viewerMemo = undefined; } });
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

  /** One repository's open pull requests, the viewer's own (with their checks and issues) apart from others'. */
  async repository(repository: GithubRepository): Promise<RepositoryPullRequests> {
    const key = repositoryKey(repository);
    const last = this.lists.get(key) ?? { own: [], others: [] };
    const token = await this.token();
    if (token === undefined) return { ...last, problem: { kind: 'no-token', message: missingToken } };
    try {
      const lists = { ...await this.openPullRequests(repository, token), fetchedAt: this.now() };
      this.lists.set(key, lists);
      return lists;
    } catch (error) {
      // anything but GitHub's own trouble is a bug
      if (!(error instanceof GithubRequestError)) throw error;
      return { ...last, problem: problemOf(error, token) };
    }
  }

  /**
   * The pull request of one branch, as last fetched. A read never waits on GitHub unless asked to
   * (`wait`): an old summary is returned at once and refreshed behind it, for the next read.
   * `published` (an upstream is configured) is not used yet; every branch is looked up.
   */
  async branch(repository: GithubRepository, name: string, _published: boolean, { wait = false }: { wait?: boolean } = {}): Promise<BranchSummary> {
    const key = `${repositoryKey(repository)}:${name}`;
    let entry = this.summaries.get(key);
    if (entry === undefined || entry.pending === undefined && entry.expiresAt <= this.now()) {
      const refreshing: SummaryEntry = { ...presentSummary(entry ?? {}), expiresAt: 0 };
      refreshing.pending = this.refreshBranch(key, refreshing, repository, name);
      this.summaries.set(key, refreshing);
      entry = refreshing;
    }
    if (wait) await entry.pending;
    return presentSummary(this.summaries.get(key) ?? entry);
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

  /** An outside writer (Review tour posting) changed a pull request: its summaries are refreshed on their next read. */
  changed(repository: GithubRepository, number: number): void {
    const prefix = `${repositoryKey(repository)}:`;
    for (const [key, entry] of this.summaries) {
      // replace rather than expire, so a lookup already running cannot restore what it read before the change
      if (key.startsWith(prefix) && entry.pullRequest?.number === number) this.summaries.set(key, { ...presentSummary(entry), expiresAt: 0 });
    }
  }

  // classify one exact branch head with no open successor. `acceptAncestor` (for offering a
  // worktree's removal, never for deleting a branch) also takes a head that GitHub shows is
  // behind a closed pull request's final head, as when the author pushed past the checkout.
  // Any failure proves nothing.
  async cleanupHead(repository: GithubRepository, branch: string, headSha: string, { fresh = false, acceptAncestor = false }: { fresh?: boolean; acceptAncestor?: boolean } = {}): Promise<PullRequestCleanupStatus | undefined> {
    // reject incomplete identities before touching GitHub
    if (branch.trim() === '' || !/^[a-f0-9]{40}$/iu.test(headSha)) return undefined;
    const sha = headSha.toLowerCase();
    // fresh proof cannot fall back to any earlier success
    if (fresh) {
      for (const [key, entry] of this.cleanupHeads) {
        if (entry.branch === branch && entry.headSha === sha) this.cleanupHeads.delete(key);
      }
    }
    const key = `${repositoryKey(repository)}:${branch}:${sha}${acceptAncestor ? ':ancestor' : ''}`;
    const now = this.now();
    // discard completed expired identities on each miss
    for (const [cachedKey, entry] of this.cleanupHeads) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.cleanupHeads.delete(cachedKey);
    }
    const cached = this.cleanupHeads.get(key);
    // share pending work and completed results inside the window
    if (cached !== undefined) return await cached.pending;
    const entry: CleanupEntry & { branch: string; headSha: string } = { branch, headSha: sha, pending: Promise.resolve(undefined) };
    entry.pending = this.lookupCleanupHead(repository, branch, sha, acceptAncestor).catch(() => undefined).then((status) => {
      // only the current generation may establish its cache window
      if (this.cleanupHeads.get(key) === entry) entry.expiresAt = this.now() + this.client.interval(cacheTtlMs);
      return status;
    });
    this.cleanupHeads.set(key, entry);
    return await entry.pending;
  }

  // look one branch up and store the result, unless the entry was replaced meanwhile; a failure
  // keeps the last summary beside the problem
  private async refreshBranch(key: string, entry: SummaryEntry, repository: GithubRepository, name: string): Promise<void> {
    const token = await this.token();
    let next: BranchSummary;
    try {
      const pullRequest = await this.lookup(repository, name, token);
      next = { ...(pullRequest === undefined ? {} : { pullRequest }), fetchedAt: this.now() };
    } catch (error) {
      next = { ...presentSummary(entry), problem: problemOf(error, token) };
    }
    if (this.summaries.get(key) === entry) this.summaries.set(key, { ...next, expiresAt: this.now() + this.client.interval(cacheTtlMs) });
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

  // group open pull requests around the authenticated user
  private async openPullRequests(repository: GithubRepository, token: string): Promise<OpenPullRequestChoices> {
    const viewer = await this.viewer();
    const query = new URLSearchParams({ state: 'open', per_page: '100' });
    const response = await this.client.get(apiUrl(repository, `pulls?${query}`), token, 'GitHub could not load pull requests');
    const pulls = await response.json().catch(() => undefined);
    // reject malformed success responses
    if (!Array.isArray(pulls)) throw new GithubRequestError('GitHub returned invalid pull request data.');
    const choices = pulls.flatMap((pull): PullRequestChoiceCandidate[] => {
      // ignore malformed pull requests
      if (pull === null || typeof pull !== 'object') return [];
      const value = pull as { number?: unknown; title?: unknown; draft?: unknown; user?: { login?: unknown }; head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } };
      // require one safe switch target
      if (!Number.isInteger(value.number) || (value.number as number) < 1 || typeof value.title !== 'string' || typeof value.head?.ref !== 'string' || typeof value.head.sha !== 'string' || !/^[a-f0-9]{40}$/iu.test(value.head.sha) || typeof value.user?.login !== 'string') return [];
      const number = value.number as number;
      const url = `https://github.com/${repositoryPath(repository)}/pull/${number}`;
      const headOnOrigin = typeof value.head.repo?.full_name === 'string' && value.head.repo.full_name.toLowerCase() === repositoryKey(repository);
      return [{ number, title: value.title, branch: value.head.ref, headSha: value.head.sha.toLowerCase(), headOnOrigin, draft: value.draft === true, url, ownedByViewer: value.user.login === viewer }];
    });
    const own = choices.filter(choice => choice.ownedByViewer);
    const others = choices.filter(choice => !choice.ownedByViewer).map(({ ownedByViewer: _ownedByViewer, ...choice }) => choice);
    return { own: await Promise.all(own.map(async ({ ownedByViewer: _ownedByViewer, ...choice }) => {
      const { checks, issues } = await this.issueStatus(repository, choice.number, choice.headSha, token);
      return { ...choice, checks, ...(Object.keys(issues).length === 0 ? {} : { issues }) };
    })), others };
  }

  // load one branch-bound pull request; without a token, a public repository still answers
  private async lookup(repository: GithubRepository, branch: string, token: string | undefined): Promise<PullRequestSummary | undefined> {
    const query = new URLSearchParams({ state: 'all', head: `${repository.owner}:${branch}`, per_page: '100' });
    const response = await this.client.get(apiUrl(repository, `pulls?${query}`), token, 'GitHub could not look up the branch\'s pull request');
    const pulls = await response.json().catch(() => undefined);
    if (!Array.isArray(pulls)) throw new GithubRequestError('GitHub returned invalid pull request data.');
    const summaries = pulls.flatMap((pull): PullRequestCandidate[] => {
      if (pull === null || typeof pull !== 'object') return [];
      const value = pull as { number?: unknown; title?: unknown; draft?: unknown; state?: unknown; merged_at?: unknown; html_url?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } };
      if (!Number.isInteger(value.number) || (value.number as number) < 1 || typeof value.title !== 'string' || typeof value.html_url !== 'string') return [];
      const status = typeof value.merged_at === 'string' ? 'merged' : value.state === 'open' ? value.draft === true ? 'draft' : 'open' : undefined;
      if (status === undefined) return [];
      try {
        const url = new URL(value.html_url);
        return url.protocol === 'https:' && url.hostname === 'github.com' ? [{ number: value.number as number, title: value.title, status, url: url.href, ...(typeof value.base?.ref === 'string' && value.base.ref !== '' ? { baseBranch: value.base.ref } : {}), ...(typeof value.head?.sha === 'string' && /^[a-f0-9]{40}$/iu.test(value.head.sha) ? { headSha: value.head.sha } : {}) }] : [];
      } catch { return []; }
    });
    const selected = summaries.find(pullRequest => pullRequest.status !== 'merged') ?? summaries[0];
    if (selected === undefined) return undefined;
    const { headSha, ...summary } = selected;
    const { checks, issues, unresolvedThreads } = await this.issueStatus(repository, summary.number, headSha, token);
    return { ...summary, checks, ...(summary.status === 'merged' || Object.keys(issues).length === 0 ? {} : { issues }), ...(summary.status === 'merged' || unresolvedThreads === 0 ? {} : { unresolvedThreads }) };
  }

  // scan every bounded result page so a later open pull request can veto cleanup
  private async lookupCleanupHead(repository: GithubRepository, branch: string, headSha: string, acceptAncestor: boolean): Promise<PullRequestCleanupStatus | undefined> {
    // a missing token still lets a public repository answer
    const token = await this.token();
    const forkNumber = forkCheckoutNumber(branch);
    if (forkNumber !== undefined) return await this.lookupCleanupNumber(repository, forkNumber, headSha, token, acceptAncestor);
    const origin = repositoryKey(repository);
    let status: PullRequestCleanupStatus | undefined;
    // the closed pull requests' other final heads, merged first, that an ancestor check may accept
    const finals: { sha: string; status: PullRequestCleanupStatus }[] = [];
    // cap pagination while preserving later-page open-branch vetoes
    for (let page = 1; page <= 100; page += 1) {
      const query = new URLSearchParams({ state: 'all', head: `${repository.owner}:${branch}`, per_page: '100', page: String(page) });
      const response = await this.client.get(apiUrl(repository, `pulls?${query}`), token, 'GitHub could not verify the branch cleanup status');
      const pulls = await response.json().catch(() => undefined);
      // malformed pages cannot prove a safe cleanup
      if (!Array.isArray(pulls)) return undefined;
      for (const pull of pulls) {
        // malformed rows could conceal an open successor
        if (pull === null || typeof pull !== 'object') return undefined;
        const value = pull as { state?: unknown; merged_at?: unknown; head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } };
        const fullName = value.head?.repo?.full_name;
        const sha = value.head?.sha;
        // every queried row needs a complete GitHub identity
        if (typeof value.state !== 'string' || typeof value.head?.ref !== 'string' || typeof fullName !== 'string' || typeof sha !== 'string' || !/^[a-f0-9]{40}$/iu.test(sha)) return undefined;
        // unrelated forks and branch names do not affect this identity
        if (value.head.ref !== branch || fullName.toLowerCase() !== origin) continue;
        // an open use of the branch always blocks cleanup
        if (value.state === 'open') return undefined;
        // unexpected states cannot prove the branch is closed
        if (value.state !== 'closed') return undefined;
        const closed = closedStatus(value.merged_at);
        if (closed === undefined) return undefined;
        // only the exact commit proves this checkout can be cleaned up
        if (sha.toLowerCase() !== headSha) {
          if (closed === 'merged') finals.unshift({ sha, status: closed }); else finals.push({ sha, status: closed });
          continue;
        }
        // a merged proof outranks a closed-unmerged proof for the same commit
        if (closed === 'merged') status = 'merged';
        else if (status === undefined) status = 'closed';
      }
      // a short page proves there are no later vetoes
      if (pulls.length < 100) return status ?? (acceptAncestor ? await this.ancestorStatus(repository, headSha, finals, token) : undefined);
    }
    // a full final page leaves possible later vetoes unknown
    return undefined;
  }

  // a fork checkout's branch is the console's own, so its pull request is read by number; only
  // that pull request's exact final head (or, with `acceptAncestor`, an ancestor of it) proves the checkout finished
  private async lookupCleanupNumber(repository: GithubRepository, number: number, headSha: string, token: string | undefined, acceptAncestor: boolean): Promise<PullRequestCleanupStatus | undefined> {
    const response = await this.client.get(apiUrl(repository, `pulls/${number}`), token, 'GitHub could not verify the branch cleanup status');
    const value = await response.json().catch(() => undefined) as { state?: unknown; merged_at?: unknown; head?: { sha?: unknown } } | null | undefined;
    const sha = value?.head?.sha;
    const status = value?.state === 'closed' ? closedStatus(value.merged_at) : undefined;
    if (status === undefined || typeof sha !== 'string' || !/^[a-f0-9]{40}$/iu.test(sha)) return undefined;
    if (sha.toLowerCase() === headSha) return status;
    return acceptAncestor ? await this.ancestorStatus(repository, headSha, [{ sha, status }], token) : undefined;
  }

  // the status of the first closed pull request whose final head GitHub shows `headSha` is behind
  // (or identical to); any failure proves nothing
  private async ancestorStatus(repository: GithubRepository, headSha: string, finals: readonly { sha: string; status: PullRequestCleanupStatus }[], token: string | undefined): Promise<PullRequestCleanupStatus | undefined> {
    for (const final of finals.slice(0, maxAncestorCompares)) {
      const response = await this.client.get(apiUrl(repository, `compare/${final.sha.toLowerCase()}...${headSha}`), token, 'GitHub could not compare the checkout with its pull request').catch(() => undefined);
      const compared = await response?.json().catch(() => undefined) as { status?: unknown } | null | undefined;
      if (compared?.status === 'behind' || compared?.status === 'identical') return final.status;
    }
    return undefined;
  }

  // a pull request's mergeability, checks and unresolved threads; a part GitHub does not answer is left unknown
  private async issueStatus(repository: GithubRepository, number: number, headSha: string | undefined, token: string | undefined): Promise<{ checks: PullRequestCheckStatus; issues: PullRequestIssues; unresolvedThreads: number }> {
    const action = 'GitHub could not read the pull request\'s status';
    const read = async (path: string): Promise<unknown> => await this.client.get(apiUrl(repository, path), token, action).then(async response => await response.json()).catch(() => undefined);
    const [detail, checks, status, reviews] = await Promise.all([
      read(`pulls/${number}`),
      headSha === undefined ? undefined : read(`commits/${headSha}/check-runs?per_page=100`),
      headSha === undefined ? undefined : read(`commits/${headSha}/status`),
      token === undefined ? undefined : this.client.query(token, reviewThreadsQuery, { owner: repository.owner, repo: repository.name, number }, action).catch(() => undefined)
    ]);
    const issues: PullRequestIssues = {};
    if (detail !== null && typeof detail === 'object') {
      const value = detail as { mergeable?: unknown; mergeable_state?: unknown };
      if (value.mergeable === false || value.mergeable_state === 'dirty') issues.mergeConflicts = true;
    }
    const checkRuns = checks !== null && typeof checks === 'object' && Array.isArray((checks as { check_runs?: unknown }).check_runs) ? (checks as { check_runs: unknown[] }).check_runs : undefined;
    const commitStatuses = status !== null && typeof status === 'object' && Array.isArray((status as { statuses?: unknown }).statuses) ? (status as { statuses: unknown[] }).statuses : undefined;
    const hasFailingRun = checkRuns?.some(run => run !== null && typeof run === 'object' && typeof (run as { conclusion?: unknown }).conclusion === 'string' && failingCheckConclusions.has((run as { conclusion: string }).conclusion)) === true;
    const hasFailingStatus = commitStatuses?.some(candidate => candidate !== null && typeof candidate === 'object' && ((candidate as { state?: unknown }).state === 'failure' || (candidate as { state?: unknown }).state === 'error')) === true;
    if (hasFailingRun || hasFailingStatus) issues.failingChecks = true;
    const hasPendingRun = checkRuns?.some(run => {
      if (run === null || typeof run !== 'object') return true;
      const value = run as { status?: unknown; conclusion?: unknown };
      return value.status !== 'completed' || value.conclusion === null || value.conclusion === undefined;
    }) === true;
    const hasPendingStatus = commitStatuses?.some(candidate => candidate === null || typeof candidate !== 'object' || (candidate as { state?: unknown }).state === 'pending') === true;
    const checkStatus: PullRequestCheckStatus = hasFailingRun || hasFailingStatus
      ? 'failed'
      : headSha === undefined || checkRuns === undefined || commitStatuses === undefined || hasPendingRun || hasPendingStatus
        ? 'pending'
        : 'passed';
    const threads = at(reviews, 'data', 'repository', 'pullRequest', 'reviewThreads', 'nodes');
    const unresolvedThreads = Array.isArray(threads) ? threads.filter(thread => at(thread, 'isResolved') === false && at(thread, 'isOutdated') !== true).length : 0;
    if (unresolvedThreads > 0) issues.unresolvedComments = true;
    return { checks: checkStatus, issues, unresolvedThreads };
  }
}
