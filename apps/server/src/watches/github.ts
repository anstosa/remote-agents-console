import { at, GithubClient, GithubRequestError, graphqlError, githubRepository, githubToken, type GithubRepository, type Request, type Token } from '../pull-requests/github.js';
import { run } from '../tmux/command.js';

/** The GitHub repository a checkout's origin names, if it names one. */
export async function originRepository(checkout: string): Promise<GithubRepository | undefined> {
  const remote = await run('/usr/bin/git', ['-C', checkout, 'remote', 'get-url', 'origin']).catch(() => undefined);
  return remote?.code === 0 ? githubRepository(remote.stdout) : undefined;
}

/** A pull request as a Watch compares it: its state, head commit, settled checks, mergeability and review threads. */
export type PullRequestState = {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  head: string;
  // undefined while GitHub has not worked mergeability out, or the commit has no checks
  conflict?: boolean;
  checks?: 'pending' | 'passed' | 'failed';
  threads: Array<{ id: string; unresolved: boolean; author?: string }>;
};
/** What stands in for a request's id when GitHub's latest timeline items do not name it. */
export const standInRequest = 'pull-';
/** An open pull request asking the token's own user for a review, by the latest such request. */
export type ReviewRequest = { number: number; url: string; request: string };

/** What Watches read from GitHub, with the console's GitHub token. */
export interface WatchGithub {
  pullRequest(repository: GithubRepository, number: number): Promise<PullRequestState>;
  reviewRequests(repository: GithubRepository): Promise<ReviewRequest[]>;
}

const pullRequestQuery = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  state mergeable url headRefOid
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}
  reviewThreads(last:100){nodes{id isResolved isOutdated comments(first:1){nodes{author{login}}}}}
}}}`;
// `user-review-requested` matches a request naming the user, not one of their teams
const reviewRequestsQuery = `query($q:String!){viewer{login} search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{
  number url
  timelineItems(itemTypes:[REVIEW_REQUESTED_EVENT],last:20){nodes{... on ReviewRequestedEvent{id requestedReviewer{... on User{login}}}}}
}}}}`;
const checkStates: Record<string, PullRequestState['checks']> = { SUCCESS: 'passed', FAILURE: 'failed', ERROR: 'failed', PENDING: 'pending', EXPECTED: 'pending' };
const nodes = (connection: unknown): unknown[] => { const value = at(connection, 'nodes'); return Array.isArray(value) ? value : []; };

export class GithubWatchReader implements WatchGithub {
  private readonly github: GithubClient;
  constructor(request: Request = fetch, private readonly token: Token = githubToken) { this.github = new GithubClient(request); }

  async pullRequest({ owner, name }: GithubRepository, number: number): Promise<PullRequestState> {
    const action = `GitHub could not read pull request #${number}`;
    const payload = await this.github.query(await this.required(), pullRequestQuery, { owner, repo: name, number }, action);
    const node = at(payload, 'data', 'repository', 'pullRequest');
    const [state, url, head] = [at(node, 'state'), at(node, 'url'), at(node, 'headRefOid')];
    if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED' || typeof url !== 'string' || typeof head !== 'string') throw graphqlError(payload, action);
    const mergeable = at(node, 'mergeable');
    const checks = checkStates[String(at(nodes(at(node, 'commits'))[0], 'commit', 'statusCheckRollup', 'state'))];
    const threads = nodes(at(node, 'reviewThreads')).flatMap(thread => {
      const id = at(thread, 'id');
      const author = at(nodes(at(thread, 'comments'))[0], 'author', 'login');
      return typeof id === 'string' ? [{ id, unresolved: at(thread, 'isResolved') === false && at(thread, 'isOutdated') !== true, ...(typeof author === 'string' ? { author } : {}) }] : [];
    });
    return { state, url, head, ...(mergeable === 'CONFLICTING' ? { conflict: true } : mergeable === 'MERGEABLE' ? { conflict: false } : {}), ...(checks === undefined ? {} : { checks }), threads };
  }

  async reviewRequests({ owner, name }: GithubRepository): Promise<ReviewRequest[]> {
    const action = `GitHub could not read the review requests in ${owner}/${name}`;
    const payload = await this.github.query(await this.required(), reviewRequestsQuery, { q: `repo:${owner}/${name} is:pr is:open user-review-requested:@me` }, action);
    const viewer = at(payload, 'data', 'viewer', 'login');
    const found = at(payload, 'data', 'search');
    if (typeof viewer !== 'string' || found === null || typeof found !== 'object') throw graphqlError(payload, action);
    return nodes(found).flatMap(pull => {
      const [number, url] = [at(pull, 'number'), at(pull, 'url')];
      if (!Number.isInteger(number) || typeof url !== 'string') return [];
      // the latest request naming the user; a request GitHub no longer lists still counts once
      const request = nodes(at(pull, 'timelineItems')).filter(event => at(event, 'requestedReviewer', 'login') === viewer).map(event => at(event, 'id')).filter((id): id is string => typeof id === 'string').at(-1);
      return [{ number: number as number, url, request: request ?? `${standInRequest}${String(number)}` }];
    });
  }

  private async required(): Promise<string> {
    const token = await this.token();
    if (token === undefined) throw new GithubRequestError('GitHub authentication is not configured: set RAC_GITHUB_TOKEN or log in with gh.', 503);
    return token;
  }
}
