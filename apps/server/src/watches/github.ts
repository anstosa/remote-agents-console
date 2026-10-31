import type { GithubRepository } from '../github/github.js';
import { GithubService, problemError } from '../github/service.js';

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

/**
 * Watches' GitHub, read through the console's one GitHub module: data under a minute old answers,
 * else just the watched pull request or repository is read. A read that failed is never compared,
 * even beside data kept from before; it throws, as GitHub's own errors did.
 */
export class GithubWatchReader implements WatchGithub {
  constructor(private readonly github: Pick<GithubService, 'pullRequestDetail' | 'reviewRequests'> = new GithubService()) {}

  async pullRequest(repository: GithubRepository, number: number): Promise<PullRequestState> {
    const { pullRequest: pull, problem } = await this.github.pullRequestDetail(repository, number);
    if (problem !== undefined || pull === undefined) throw problemError(problem ?? { kind: 'failing', message: `GitHub could not read pull request #${number}.` });
    return {
      state: pull.state.toUpperCase() as PullRequestState['state'], url: pull.url, head: pull.headSha,
      ...(pull.mergeable === 'unknown' ? {} : { conflict: pull.mergeable === 'conflicting' }),
      // the module counts a head with no checks as passed; a Watch has none to see settle
      ...(pull.checkRuns.length === 0 ? {} : { checks: pull.checks }),
      // the thread's opener, by name: the module calls a deleted account GitHub's `ghost`
      threads: pull.threads.map(({ id, resolved, outdated, comments: [opener] }) => ({ id, unresolved: !resolved && !outdated, ...(opener === undefined || opener.author === 'ghost' ? {} : { author: opener.author }) }))
    };
  }

  async reviewRequests(repository: GithubRepository): Promise<ReviewRequest[]> {
    const { requests, problem } = await this.github.reviewRequests(repository);
    if (problem !== undefined) throw problemError(problem);
    // a request GitHub no longer lists still counts once
    return requests.map(({ number, url, request }) => ({ number, url, request: request ?? `${standInRequest}${String(number)}` }));
  }
}
