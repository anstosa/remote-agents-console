import type { Request, ResponseLike } from '../../src/github/github.js';
import { GithubService, type GithubServiceOptions } from '../../src/github/service.js';
import { testProject } from './config.js';

// A scripted GitHub that answers the module's GraphQL reads from a small world of pull requests
// and issues, the way GitHub would: each `rN:repository` alias gets its open list and issues if
// it asked for them, and each `bN` alias gets the pull requests for its head branch (or number).
// The Overview's searches find, across the world, the viewer's open pull requests (`mine`), those
// asking for their review (`requested`), and the open issues assigned to them (`assigned`).

export type PullFixture = {
  number: number;
  branch: string;
  title?: string;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  draft?: boolean;
  sha?: string;
  // the head repository's `owner/name`, when it is not the base repository
  head?: string;
  mine?: boolean;
  // null for a base GitHub does not name
  base?: string | null;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  // `statusCheckRollup.state`; null for a head with no checks
  checks?: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
  // `last` is who wrote the thread's last comment, `viewer` for the viewer, and `lastId` its id
  threads?: { isResolved: boolean; isOutdated: boolean; id?: string; path?: string; last?: string; lastId?: string }[];
  closes?: number[];
  url?: string;
  author?: string;
  updatedAt?: string;
  labels?: string[];
  // the viewer's review is asked for, directly or through a team
  requested?: boolean;
  // `viewerLatestReviewRequest`'s id, and `viewerLatestReview`
  viewerRequest?: string;
  viewerReview?: { state: string; commit: string };
  // each reviewer's latest opinionated review
  reviews?: { id?: string; author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; commit: string }[];
};
export type IssueFixture = { number: number; title: string; assigned?: boolean; author?: string; updatedAt?: string; labels?: string[]; linked?: { number: number; branch: string; repository?: string }[] };
export type World = Record<string, { pulls?: PullFixture[]; issues?: IssueFixture[] }>;
export type GraphqlCall = { query: string; variables: Record<string, unknown> };

export const sha = (character: string): string => character.repeat(40);

export function reply(body: unknown, status = 200, headers: Record<string, string> = {}): ResponseLike {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

// one pull request as GitHub's GraphQL API returns it, with only the optional fields the selection
// asks for; a thread's comments are its opener (`opener`) and then its last speaker
export function pullNode(repository: string, pull: PullFixture, selection = 'reviewThreads closingIssuesReferences'): Record<string, unknown> {
  const asked = (field: string, value: () => unknown): Record<string, unknown> => selection.includes(field) ? { [field]: value() } : {};
  const lastComment = selection.includes('comments(last:1)');
  return {
    number: pull.number,
    title: pull.title ?? `PR ${pull.number}`,
    url: pull.url ?? `https://github.com/${repository}/pull/${pull.number}`,
    state: pull.state ?? 'OPEN',
    isDraft: pull.draft ?? false,
    baseRefName: pull.base === undefined ? 'main' : pull.base,
    headRefName: pull.branch,
    headRefOid: pull.sha ?? sha('a'),
    isCrossRepository: pull.head !== undefined && pull.head !== repository,
    viewerDidAuthor: pull.mine ?? false,
    mergeable: pull.mergeable ?? 'MERGEABLE',
    statusCheckRollup: pull.checks === null ? null : { state: pull.checks ?? 'SUCCESS' },
    ...asked('updatedAt', () => pull.updatedAt ?? '2026-10-30T12:00:00Z'),
    ...asked('repository', () => ({ nameWithOwner: repository })),
    ...asked('author', () => ({ login: pull.author ?? (pull.mine === true ? 'viewer' : 'someone') })),
    ...asked('labels', () => ({ nodes: (pull.labels ?? []).map(name => ({ name })) })),
    ...asked('viewerLatestReviewRequest', () => pull.viewerRequest === undefined ? null : { id: pull.viewerRequest }),
    ...asked('viewerLatestReview', () => pull.viewerReview === undefined ? null : { state: pull.viewerReview.state, commit: { oid: pull.viewerReview.commit } }),
    ...asked('latestOpinionatedReviews', () => ({ nodes: (pull.reviews ?? []).map((review, index) => ({ id: review.id ?? `review-${index}`, state: review.state, author: { login: review.author }, commit: { oid: review.commit } })) })),
    ...asked('reviewThreads', () => ({ nodes: (pull.threads ?? []).map((thread, index) => ({ id: thread.id ?? `thread-${index}`, path: thread.path ?? 'src/file.ts', isResolved: thread.isResolved, isOutdated: thread.isOutdated, comments: { nodes: [lastComment ? { id: thread.lastId ?? `comment-${index}`, author: { login: thread.last ?? 'reviewer' }, viewerDidAuthor: thread.last === 'viewer' } : { author: { login: 'opener' }, viewerDidAuthor: false }] } })) })),
    ...asked('closingIssuesReferences', () => ({ nodes: (pull.closes ?? []).map(number => ({ number })) }))
  };
}

function issueNode(repository: string, issue: IssueFixture, selection: string): Record<string, unknown> {
  const asked = (field: string, value: () => unknown): Record<string, unknown> => selection.includes(field) ? { [field]: value() } : {};
  return {
    number: issue.number, title: issue.title, url: `https://github.com/${repository}/issues/${issue.number}`, state: 'OPEN',
    ...asked('updatedAt', () => issue.updatedAt ?? '2026-10-30T12:00:00Z'),
    ...asked('repository', () => ({ nameWithOwner: repository })),
    ...asked('author', () => ({ login: issue.author ?? 'someone' })),
    ...asked('labels', () => ({ nodes: (issue.labels ?? []).map(name => ({ name })) })),
    ...asked('closedByPullRequestsReferences', () => ({ nodes: (issue.linked ?? []).map(pull => ({ number: pull.number, headRefName: pull.branch, isCrossRepository: false, repository: { nameWithOwner: pull.repository ?? repository } })) }))
  };
}

// the Overview's searches, each over every repository in `world`, chosen by its search string
function searches(world: World, { query, variables }: GraphqlCall): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const all = Object.entries(world);
  const pulls = (selection: string, keep: (pull: PullFixture) => boolean) => all.flatMap(([name, { pulls = [] }]) => pulls.filter(pull => (pull.state ?? 'OPEN') === 'OPEN' && keep(pull)).map(pull => pullNode(name, pull, selection)));
  const listed = (nodes: unknown[]) => ({ issueCount: nodes.length, nodes });
  for (const section of query.split(/(?=\b\w+:search\()/u).slice(1)) {
    const [, alias, variable] = /^(\w+):search\([^)]*query:\$(\w+)/u.exec(section)!;
    const search = String(variables[variable!]);
    if (search.includes('author:@me')) data[alias!] = listed(pulls(section, pull => pull.mine === true));
    else if (search.includes('review-requested:@me')) data[alias!] = listed(pulls(section, pull => pull.requested === true));
    else if (search.includes('assignee:@me')) data[alias!] = listed(all.flatMap(([name, { issues = [] }]) => issues.filter(issue => issue.assigned === true).map(issue => issueNode(name, issue, section))));
  }
  return data;
}

// the data GitHub returns for one module query over `world`
export function answer(world: World, call: GraphqlCall): Record<string, unknown> {
  const { query, variables } = call;
  const data: Record<string, unknown> = searches(world, call);
  // each repository alias and the text of its selection
  for (const section of query.split(/(?=\br\d+:repository\()/u).slice(1)) {
    const index = /^r(\d+):/u.exec(section)![1]!;
    const repository = `${String(variables[`o${index}`])}/${String(variables[`n${index}`])}`;
    const found = Object.entries(world).find(([name]) => name.toLowerCase() === repository.toLowerCase());
    if (found === undefined) { data[`r${index}`] = null; continue; }
    const [name, { pulls = [], issues = [] }] = found;
    const node: Record<string, unknown> = {};
    // each field of the repository and the text of its selection
    const fields = section.split(/(?=\b(?:open|issues|b\d+):?[a-zA-Z]*\()/u);
    const open = fields.find(field => field.startsWith('open:pullRequests('));
    if (open !== undefined) node.open = { nodes: pulls.filter(pull => !open.includes('states:OPEN') || (pull.state ?? 'OPEN') === 'OPEN').map(pull => pullNode(name, pull, open)) };
    if (fields.some(field => field.startsWith('issues('))) node.issues = { nodes: issues.map(issue => ({ ...issue, url: `https://github.com/${name}/issues/${issue.number}` })) };
    for (const field of fields) {
      const match = /^(b\d+):pullRequests?\((headRefName|number):\$(\w+)/u.exec(field);
      if (match === null) continue;
      const [, alias, by, variable] = match;
      const value = variables[variable!];
      if (by === 'number') {
        const pull = pulls.find(candidate => candidate.number === value);
        node[alias!] = pull === undefined ? null : pullNode(name, pull, field);
      } else {
        // newest first, as the module orders them
        const matching = pulls.filter(pull => pull.branch === value).reverse();
        node[alias!] = { totalCount: matching.length, nodes: matching.slice(0, 20).map(pull => pullNode(name, pull, field)) };
      }
    }
    data[`r${index}`] = node;
  }
  return { data };
}

// a request function over `world` that records every GraphQL call: the Overview's searches in
// `searches`, every other read (repositories and branches) in `calls`; anything else is refused
export function graphqlGithub(world: World | (() => World)): { request: Request; calls: GraphqlCall[]; searches: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  const searches: GraphqlCall[] = [];
  const request: Request = async (url, init) => {
    if (!url.endsWith('/graphql')) return reply({ message: 'Not Found' }, 404);
    const call = JSON.parse(String(init?.body)) as GraphqlCall;
    (/\bsearch\(/u.test(call.query) ? searches : calls).push(call);
    return reply(answer(typeof world === 'function' ? world() : world, call));
  };
  return { request, calls, searches };
}

// a timer the test runs by hand
export function manualTimer() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    timer: {
      set: (run: () => void, ms: number) => { next += 1; pending.set(next, { run, ms }); return next; },
      clear: (handle: unknown) => { pending.delete(handle as number); }
    },
    // the delays of the timers still waiting
    delays: () => [...pending.values()].map(({ ms }) => ms),
    // run every waiting timer once and let what it started settle
    async fire(): Promise<void> {
      const due = [...pending.entries()];
      for (const [handle] of due) pending.delete(handle);
      for (const [, { run }] of due) run();
      await settled();
    }
  };
}

// let queued promises and microtasks run
export async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

// the module over a scripted GraphQL world, with a hand-run timer and clock, whose Projects are
// checkouts named after their repository (`/src/octo/repo` is octo/repo, Project `octo-repo`)
export function polled(world: World | (() => World), options: GithubServiceOptions & { repositories?: string[] } = {}) {
  const clock = { now: 0 };
  const scripted = graphqlGithub(world);
  const timers = manualTimer();
  const projects = (options.repositories ?? ['octo/repo']).map(name => testProject({ id: name.replace('/', '-'), label: name.split('/')[1]!, path: `/src/${name}` }));
  const service = new GithubService({
    request: scripted.request,
    command: async (_binary, args) => ({ code: 0, stdout: `git@github.com:${args[args.indexOf('-C') + 1]!.slice('/src/'.length)}.git\n` }),
    token: async () => 'private-token',
    now: () => clock.now,
    timer: timers.timer,
    projects: () => projects,
    ...options
  });
  return { service, calls: scripted.calls, searches: scripted.searches, timers, clock };
}
