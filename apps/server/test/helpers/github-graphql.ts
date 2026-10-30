import type { Request, ResponseLike } from '../../src/github/github.js';

// A scripted GitHub that answers the module's GraphQL reads from a small world of pull requests
// and issues, the way GitHub would: each `rN:repository` alias gets its open list and issues if
// it asked for them, and each `bN` alias gets the pull requests for its head branch (or number).

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
  threads?: { isResolved: boolean; isOutdated: boolean }[];
  closes?: number[];
  url?: string;
};
export type IssueFixture = { number: number; title: string };
export type World = Record<string, { pulls?: PullFixture[]; issues?: IssueFixture[] }>;
export type GraphqlCall = { query: string; variables: Record<string, unknown> };

export const sha = (character: string): string => character.repeat(40);

export function reply(body: unknown, status = 200, headers: Record<string, string> = {}): ResponseLike {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

// one pull request as GitHub's GraphQL API returns it, with its threads and closing issues only
// when the selection asks for them
export function pullNode(repository: string, pull: PullFixture, selection = 'reviewThreads closingIssuesReferences'): Record<string, unknown> {
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
    ...(selection.includes('reviewThreads') ? { reviewThreads: { nodes: pull.threads ?? [] } } : {}),
    ...(selection.includes('closingIssuesReferences') ? { closingIssuesReferences: { nodes: (pull.closes ?? []).map(number => ({ number })) } } : {})
  };
}

// the data GitHub returns for one module query over `world`
export function answer(world: World, { query, variables }: GraphqlCall): Record<string, unknown> {
  const data: Record<string, unknown> = {};
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

// a request function over `world` that records every GraphQL call; anything else is refused
export function graphqlGithub(world: World | (() => World)): { request: Request; calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  const request: Request = async (url, init) => {
    if (!url.endsWith('/graphql')) return reply({ message: 'Not Found' }, 404);
    const call = JSON.parse(String(init?.body)) as GraphqlCall;
    calls.push(call);
    return reply(answer(typeof world === 'function' ? world() : world, call));
  };
  return { request, calls };
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
