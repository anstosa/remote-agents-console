import { run } from '../tmux/command.js';
import type { PullRequestCheckStatus, PullRequestComment, PullRequestComments, PullRequestIssues, PullRequestReviewThread, PullRequestSummary } from '../domain/models.js';
import { at, GithubClient, GithubRequestError, graphqlError, githubRepository, githubToken, type Command, type GithubRepository, type Request, type ResponseLike, type Token } from './github.js';

// the lookup failure the switch routes surface, kept under its old name
export { GithubRequestError as PullRequestLookupError, githubRepository } from './github.js';

type PullRequestCandidate = PullRequestSummary & { headSha?: string };
type PullRequestChoiceCandidate = PullRequestChoice & { ownedByViewer: boolean };
export type PullRequestCleanupStatus = 'merged' | 'closed';
export type PullRequestChoice = { number: number; title: string; branch: string; headSha: string; headOnOrigin: boolean; draft: boolean; url: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };
export type OpenPullRequestChoices = { own: PullRequestChoice[]; others: PullRequestChoice[] };
const cacheTtlMs = 60_000;
const repositoryCacheTtlMs = 30_000;
const commentsQuery = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  reviewThreads(first:100){nodes{id isResolved isOutdated path line startLine originalLine originalStartLine comments(first:50){nodes{id author{login __typename} body createdAt url diffHunk}}}}
  reviews(last:100){nodes{id author{login __typename} state body submittedAt url}}
  comments(last:100){nodes{id author{login __typename} body createdAt url}}
}}}`;
const failingCheckConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

// the `nodes` of one GraphQL connection
function nodes(connection: unknown): unknown[] {
  const value = at(connection, 'nodes');
  return Array.isArray(value) ? value : [];
}

function positive(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

// one well-formed comment; a deleted account reads as GitHub's own `ghost`
function prComment(value: unknown): PullRequestComment[] {
  const [id, body, createdAt, url] = [at(value, 'id'), at(value, 'body'), at(value, 'createdAt'), at(value, 'url')];
  if (typeof id !== 'string' || typeof body !== 'string' || typeof createdAt !== 'string' || typeof url !== 'string' || !url.startsWith('https://github.com/')) return [];
  const login = at(value, 'author', 'login');
  return [{ id, author: typeof login === 'string' ? login : 'ghost', bot: at(value, 'author', '__typename') === 'Bot', body, createdAt, url }];
}

// identify rejected GitHub credentials
function githubAuthenticationFailure(error: unknown): boolean {
  return error instanceof GithubRequestError && (error.githubStatus === 401 || error.githubStatus === 403);
}

export class PullRequestService {
  private readonly cache = new Map<string, { expiresAt: number; value?: PullRequestSummary; pending?: Promise<PullRequestSummary | undefined> }>();
  private readonly cleanupHeads = new Map<string, { branch: string; headSha: string; expiresAt?: number; pending: Promise<PullRequestCleanupStatus | undefined> }>();
  private readonly repositories = new Map<string, { expiresAt?: number; pending: Promise<GithubRepository | undefined> }>();
  private token?: Promise<string | undefined>;
  private viewer?: Promise<string>;
  private readonly github: GithubClient;

  constructor(private readonly command: Command = run, private readonly request: Request = fetch, private readonly now: () => number = Date.now, private readonly getToken: Token = githubToken) { this.github = new GithubClient(request); }

  async url(workspace: string, branch?: string): Promise<string | undefined> {
    const cached = await this.lookupCached(workspace, branch);
    return (cached?.pending === undefined ? cached?.value : await cached.pending)?.url;
  }

  // group open pull requests around the authenticated user
  async open(workspace: string): Promise<OpenPullRequestChoices> {
    const repository = await this.repository(workspace);
    // require one GitHub repository
    if (repository === undefined) throw new GithubRequestError('The worktree does not have a supported GitHub origin.', 503);
    this.token ??= this.getToken();
    const token = await this.token;
    // retry authentication discovery later
    if (token === undefined) {
      this.token = undefined;
      throw new GithubRequestError('GitHub authentication is not configured for pull request lookup.', 503);
    }
    this.viewer ??= this.viewerLogin(token);
    let viewer: string;
    try {
      viewer = await this.viewer;
    } catch (error) {
      // do not cache a failed viewer lookup
      this.viewer = undefined;
      // reload rejected credentials
      if (githubAuthenticationFailure(error)) this.token = undefined;
      throw error;
    }
    const query = new URLSearchParams({ state: 'open', per_page: '100' });
    let response: ResponseLike;
    try {
      response = await this.github.get(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, token, 'GitHub could not load pull requests');
    } catch (error) {
      // reload rejected credentials and viewer identity
      if (githubAuthenticationFailure(error)) {
        this.token = undefined;
        this.viewer = undefined;
      }
      throw error;
    }
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
      const url = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pull/${number}`;
      const originRepository = `${repository.owner}/${repository.name}`;
      const headOnOrigin = typeof value.head.repo?.full_name === 'string' && value.head.repo.full_name.toLowerCase() === originRepository.toLowerCase();
      return [{ number, title: value.title, branch: value.head.ref, headSha: value.head.sha.toLowerCase(), headOnOrigin, draft: value.draft === true, url, ownedByViewer: value.user.login === viewer }];
    });
    const own = choices.filter(choice => choice.ownedByViewer);
    const others = choices.filter(choice => !choice.ownedByViewer).map(({ ownedByViewer: _ownedByViewer, ...choice }) => choice);
    return { own: await Promise.all(own.map(async ({ ownedByViewer: _ownedByViewer, ...choice }) => {
      const { headSha } = choice;
      const { checks, issues } = await this.issueStatus(repository, choice.number, headSha, token);
      return { ...choice, checks, ...(Object.keys(issues).length === 0 ? {} : { issues }) };
    })), others };
  }

  // the review threads, review summaries and conversation of the branch's open pull request, read fresh
  async comments(workspace: string, branch: string | undefined): Promise<PullRequestComments> {
    const repository = await this.cachedRepository(workspace);
    if (repository === undefined) throw new GithubRequestError('The worktree does not have a supported GitHub origin.', 404);
    const cached = await this.lookupCached(workspace, branch);
    const pullRequest = cached?.pending === undefined ? cached?.value : await cached.pending;
    if (pullRequest === undefined || pullRequest.status === 'merged') throw new GithubRequestError('This branch has no open pull request.', 404);
    this.token ??= this.getToken();
    const token = await this.token;
    if (token === undefined) {
      this.token = undefined;
      throw new GithubRequestError('GitHub authentication is not configured for pull request lookup.', 503);
    }
    const payload = await this.github.query(token, commentsQuery, { owner: repository.owner, repo: repository.name, number: pullRequest.number }, 'GitHub could not load the pull request comments');
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
    return { number: pullRequest.number, url: pullRequest.url, threads, reviews, comments: nodes(at(node, 'comments')).flatMap(prComment) };
  }

  async supports(workspace: string): Promise<boolean> { return await this.repository(workspace) !== undefined; }

  async actionsUrl(workspace: string): Promise<string | undefined> {
    const repository = await this.repository(workspace);
    return repository === undefined ? undefined : `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions`;
  }

  // preserve merged-only callers while cleanup distinguishes closed pull requests
  async mergedHead(workspace: string, branch: string, headSha: string, fresh = false): Promise<boolean> {
    return await this.cleanupHead(workspace, branch, headSha, fresh) === 'merged';
  }

  // classify one exact branch head with no open successor
  async cleanupHead(workspace: string, branch: string, headSha: string, fresh = false): Promise<PullRequestCleanupStatus | undefined> {
    // reject incomplete identities before touching git or GitHub
    if (branch.trim() === '' || !/^[a-f0-9]{40}$/iu.test(headSha)) return undefined;
    // fresh proof cannot fall back to any earlier origin or cleanup success
    if (fresh) {
      this.repositories.delete(workspace);
      for (const [key, entry] of this.cleanupHeads) {
        // remove matching identities even when current origin discovery fails
        if (entry.branch === branch && entry.headSha === headSha.toLowerCase()) this.cleanupHeads.delete(key);
      }
    }
    let repository: GithubRepository | undefined;
    try {
      // destructive revalidation must observe the current origin
      repository = fresh ? await this.repository(workspace) : await this.cachedRepository(workspace);
    } catch {
      // origin discovery failures cannot prove cleanup eligibility
      return undefined;
    }
    // unsupported and missing origins cannot prove cleanup eligibility
    if (repository === undefined) return undefined;
    const key = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}:${branch}:${headSha.toLowerCase()}`;
    const now = this.now();
    // discard completed expired identities on each cache miss
    for (const [cachedKey, entry] of this.cleanupHeads) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.cleanupHeads.delete(cachedKey);
    }
    const cached = this.cleanupHeads.get(key);
    // share pending work and completed results inside the bounded window
    if (!fresh && cached !== undefined) return await cached.pending;
    const entry: { branch: string; headSha: string; expiresAt?: number; pending: Promise<PullRequestCleanupStatus | undefined> } = { branch, headSha: headSha.toLowerCase(), pending: Promise.resolve(undefined) };
    entry.pending = this.lookupCleanupHead(repository, branch, headSha).catch((error: unknown) => {
      // rejected credentials must be rediscovered on the next lookup
      if (githubAuthenticationFailure(error)) {
        this.token = undefined;
        this.viewer = undefined;
      }
      return undefined;
    }).then((status) => {
      // only the current generation may establish its cache window
      if (this.cleanupHeads.get(key) === entry) entry.expiresAt = this.now() + cacheTtlMs;
      return status;
    });
    this.cleanupHeads.set(key, entry);
    return await entry.pending;
  }

  // discard dashboard origin lookups after checkout changes
  invalidateRepositories(): void { this.repositories.clear(); }

  /**
   * Dashboard rendering must not wait on GitHub. It can use a previous URL,
   * start a refresh when needed, and pick up the result on its next poll.
   */
  async cachedPullRequest(workspace: string, branch?: string): Promise<PullRequestSummary | undefined> {
    return (await this.lookupCached(workspace, branch))?.value;
  }

  private async lookupCached(workspace: string, branch?: string): Promise<{ expiresAt: number; value?: PullRequestSummary; pending?: Promise<PullRequestSummary | undefined> } | undefined> {
    if (!branch) return undefined;
    const repository = await this.cachedRepository(workspace);
    if (repository === undefined) return undefined;
    const key = `${repository.owner}/${repository.name}:${branch}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached;
    const pending = this.lookup(repository, branch).catch(() => undefined).then((value) => {
      const refreshed = { expiresAt: this.now() + cacheTtlMs, ...(value === undefined ? {} : { value }) };
      this.cache.set(key, refreshed);
      return value;
    });
    const refreshing = { expiresAt: this.now() + cacheTtlMs, ...(cached?.value === undefined ? {} : { value: cached.value }), pending };
    this.cache.set(key, refreshing);
    return refreshing;
  }

  // reuse bounded origin discovery for dashboard refreshes
  private async cachedRepository(workspace: string): Promise<GithubRepository | undefined> {
    const now = this.now();
    const cached = this.repositories.get(workspace);
    // reuse completed and pending origin discovery
    if (cached !== undefined && (cached.expiresAt === undefined || cached.expiresAt > now)) return await cached.pending;
    // prune expired workspaces on cache misses
    for (const [key, entry] of this.repositories) {
      // remove completed expired lookups
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.repositories.delete(key);
    }
    const entry: { expiresAt?: number; pending: Promise<GithubRepository | undefined> } = { pending: this.repository(workspace) };
    entry.pending = entry.pending.then((repository) => {
      // expire only the current generation after completion
      if (this.repositories.get(workspace) === entry) entry.expiresAt = this.now() + repositoryCacheTtlMs;
      return repository;
    }, (error: unknown) => {
      // retry only the rejected current generation
      if (this.repositories.get(workspace) === entry) this.repositories.delete(workspace);
      throw error;
    });
    this.repositories.set(workspace, entry);
    return await entry.pending;
  }

  private async repository(workspace: string): Promise<GithubRepository | undefined> {
    const remote = await this.command('/usr/bin/git', ['-C', workspace, 'remote', 'get-url', 'origin']);
    return remote.code === 0 ? githubRepository(remote.stdout) : undefined;
  }

  // identify the authenticated GitHub user
  private async viewerLogin(token: string): Promise<string> {
    const response = await this.github.get('https://api.github.com/user', token, 'GitHub could not identify the authenticated user');
    const value = await response.json().catch(() => undefined);
    // require the authenticated login
    if (value === null || typeof value !== 'object' || typeof (value as { login?: unknown }).login !== 'string') throw new GithubRequestError('GitHub returned invalid authenticated user data.');
    return (value as { login: string }).login;
  }

  // load one branch-bound pull request
  private async lookup(repository: GithubRepository, branch: string): Promise<PullRequestSummary | undefined> {
    const query = new URLSearchParams({ state: 'all', head: `${repository.owner}:${branch}`, per_page: '100' });
    this.token ??= this.getToken();
    const token = await this.token;
    // retry token discovery later
    if (token === undefined) this.token = undefined;
    const response = await this.request(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, { headers: { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    const pulls = await response.json().catch(() => undefined);
    if (!Array.isArray(pulls)) return undefined;
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
  private async lookupCleanupHead(repository: GithubRepository, branch: string, headSha: string): Promise<PullRequestCleanupStatus | undefined> {
    this.token ??= this.getToken();
    let token: string | undefined;
    try {
      token = await this.token;
    } catch (error) {
      // retry rejected token discovery later
      this.token = undefined;
      throw error;
    }
    // retry missing token discovery later while allowing public repositories
    if (token === undefined) this.token = undefined;
    const origin = `${repository.owner}/${repository.name}`;
    let status: PullRequestCleanupStatus | undefined;
    // cap pagination while preserving later-page open-branch vetoes
    for (let page = 1; page <= 100; page += 1) {
      const query = new URLSearchParams({ state: 'all', head: `${repository.owner}:${branch}`, per_page: '100', page: String(page) });
      const response = await this.github.get(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`, token, 'GitHub could not verify the branch cleanup status');
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
        const exactBranch = value.head.ref === branch && fullName.toLowerCase() === origin.toLowerCase();
        // unrelated forks and branch names do not affect this identity
        if (!exactBranch) continue;
        // an open use of the branch always blocks cleanup
        if (value.state === 'open') return undefined;
        // unexpected states cannot prove the branch is closed
        if (value.state !== 'closed') return undefined;
        const mergedAt = value.merged_at;
        // require GitHub's complete closed-state marker
        if (mergedAt !== null && (typeof mergedAt !== 'string' || mergedAt.trim() === '')) return undefined;
        // only the exact commit proves this checkout can be cleaned up
        if (sha.toLowerCase() !== headSha.toLowerCase()) continue;
        // a merged proof outranks a closed-unmerged proof for the same commit
        if (typeof mergedAt === 'string') status = 'merged';
        else if (status === undefined) status = 'closed';
      }
      // a short page proves there are no later vetoes
      if (pulls.length < 100) return status;
    }
    // a full final page leaves possible later vetoes unknown
    return undefined;
  }

  private async issueStatus(repository: GithubRepository, number: number, headSha: string | undefined, token: string | undefined): Promise<{ checks: PullRequestCheckStatus; issues: PullRequestIssues; unresolvedThreads: number }> {
    const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const headers = { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) };
    const detailRequest = this.request(`${base}/pulls/${number}`, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    const checksRequest = headSha === undefined ? Promise.resolve(undefined) : this.request(`${base}/commits/${headSha}/check-runs?per_page=100`, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    const statusRequest = headSha === undefined ? Promise.resolve(undefined) : this.request(`${base}/commits/${headSha}/status`, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
    const reviewRequest = token === undefined ? Promise.resolve(undefined) : this.request('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated}}}}}',
        variables: { owner: repository.owner, repo: repository.name, number }
      }),
      signal: AbortSignal.timeout(8_000)
    }).catch(() => undefined);
    const [detailResponse, checksResponse, statusResponse, reviewResponse] = await Promise.all([detailRequest, checksRequest, statusRequest, reviewRequest]);
    const [detail, checks, status, reviews] = await Promise.all([
      detailResponse?.ok ? detailResponse.json().catch(() => undefined) : undefined,
      checksResponse?.ok ? checksResponse.json().catch(() => undefined) : undefined,
      statusResponse?.ok ? statusResponse.json().catch(() => undefined) : undefined,
      reviewResponse?.ok ? reviewResponse.json().catch(() => undefined) : undefined
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
    const threads = reviews !== null && typeof reviews === 'object' ? (reviews as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } } }).data?.repository?.pullRequest?.reviewThreads?.nodes : undefined;
    const unresolvedThreads = Array.isArray(threads) ? threads.filter(thread => thread !== null && typeof thread === 'object' && (thread as { isResolved?: unknown }).isResolved === false && (thread as { isOutdated?: unknown }).isOutdated !== true).length : 0;
    if (unresolvedThreads > 0) issues.unresolvedComments = true;
    return { checks: checkStatus, issues, unresolvedThreads };
  }
}
