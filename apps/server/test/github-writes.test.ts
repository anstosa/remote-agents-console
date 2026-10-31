import { describe, expect, it } from 'vitest';
import { GithubClient } from '../src/github/github.js';
import { forkCheckoutBranch } from '../src/github/service.js';
import { addReviewThreads, draftReviewContent, draftReviewTarget, replyToThread, rerequestReviews, resolveThread, startDraftReview, updateDraftReview } from '../src/github/writes.js';
import { detailNode, graphqlGithub, graphqlSyntaxError, polled, reply, settled, type GraphqlCall } from './helpers/github-graphql.js';

const repo = { owner: 'octo', name: 'repo' };
const isDetail = (call: GraphqlCall) => call.query.startsWith('query PullRequestDetail');
const isMutation = (call: GraphqlCall) => call.query.startsWith('mutation');

// the module over a GitHub whose lists come from a scripted world, whose detail read answers
// `detailNode()`, and whose mutations answer `mutation(call)`
function harness(mutation: (call: GraphqlCall) => unknown) {
  const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 9, branch: 'retries', mine: true }] } });
  const calls: GraphqlCall[] = [];
  const world = polled({}, {
    request: async (url, init) => {
      const call = JSON.parse(String(init?.body)) as GraphqlCall;
      calls.push(call);
      if (isDetail(call)) return reply({ data: { repository: { pullRequest: detailNode() } } });
      if (isMutation(call)) return reply(mutation(call));
      return await scripted.request(url, init);
    }
  });
  return { ...world, calls, searches: scripted.searches };
}

describe('replying to a Review thread', () => {
  it('posts the reply on the thread alone, never naming a draft review, and says whether GitHub published it', async () => {
    const { service, calls } = harness(() => ({ data: { addPullRequestReviewThreadReply: { comment: { id: 'C9', url: 'https://github.com/octo/repo/pull/9#discussion_r9', state: 'SUBMITTED' } } } }));
    expect(await service.replyToThread(repo, 9, 'PRRT_1', 'On it.')).toEqual({ id: 'C9', url: 'https://github.com/octo/repo/pull/9#discussion_r9', pending: false });
    const sent = calls.filter(isMutation);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.query).toContain('addPullRequestReviewThreadReply(');
    expect(sent[0]!.query).toContain('state');
    // a draft review's id would hold the reply back until the draft is submitted
    expect(sent[0]!.variables).toEqual({ input: { pullRequestReviewThreadId: 'PRRT_1', body: 'On it.' } });
  });

  it('refuses a thread the pull request does not have, and an empty or oversized reply, before writing', async () => {
    const { service, calls } = harness(() => { throw new Error('no write expected'); });
    for (const [thread, body, status] of [['PRRT_elsewhere', 'On it.', 404], ['PRRT_1', ' \n ', 400], ['PRRT_1', 'x'.repeat(65_537), 400]] as const) {
      await expect(service.replyToThread(repo, 9, thread, body)).rejects.toMatchObject({ statusCode: status });
    }
    expect(calls.filter(isMutation)).toHaveLength(0);
  });

  it('reports GitHub refusing the reply', async () => {
    const { service } = harness(() => ({ data: { addPullRequestReviewThreadReply: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }));
    await expect(service.replyToThread(repo, 9, 'PRRT_1', 'On it.')).rejects.toMatchObject({ kind: 'forbidden', message: expect.stringContaining('Resource not accessible') });
  });
});

describe('resolving a Review thread', () => {
  it('resolves one of the pull request\'s threads', async () => {
    const { service, calls } = harness(() => ({ data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } } }));
    await service.resolveThread(repo, 9, 'PRRT_1');
    const sent = calls.filter(isMutation);
    expect(sent.map(call => [call.query.includes('resolveReviewThread('), call.variables])).toEqual([[true, { input: { threadId: 'PRRT_1' } }]]);
    await expect(service.resolveThread(repo, 9, 'PRRT_elsewhere')).rejects.toMatchObject({ statusCode: 404 });
    expect(calls.filter(isMutation)).toHaveLength(1);
  });

  it('reports a resolve GitHub did not apply', async () => {
    const { service } = harness(() => ({ data: { resolveReviewThread: null }, errors: [{ type: 'FORBIDDEN', message: 'Must have push access' }] }));
    await expect(service.resolveThread(repo, 9, 'PRRT_1')).rejects.toMatchObject({ message: expect.stringContaining('Must have push access') });
  });
});

describe('re-requesting a review', () => {
  it('asks a user or bot who reviewed the pull request for another review by their node id', async () => {
    const { service, calls } = harness(() => ({ data: { rerequestReviews: { pullRequest: { id: 'PR_9' } } } }));
    expect((await service.pullRequestDetail(repo, 9)).pullRequest?.reviewers).toEqual([
      { login: 'mona', id: 'U_mona', state: 'changes', newCommits: true },
      { login: 'coderabbit', id: 'B_rabbit', bot: true, state: 'commented', newCommits: true },
      { login: 'core', id: 'T_core', team: true, requested: true }
    ]);
    await service.rerequestReview(repo, 9, 'mona');
    await service.rerequestReview(repo, 9, 'coderabbit');
    const sent = calls.filter(isMutation);
    expect(sent.every(call => call.query.includes('rerequestReviews('))).toBe(true);
    expect(sent.map(call => call.variables)).toEqual([{ input: { pullRequestId: 'PR_9', userIds: ['U_mona'] } }, { input: { pullRequestId: 'PR_9', botIds: ['B_rabbit'] } }]);
    // a login that is not one of its reviewers, or a team's
    for (const login of ['kai', 'core']) await expect(service.rerequestReview(repo, 9, login)).rejects.toMatchObject({ statusCode: 404 });
    expect(calls.filter(isMutation)).toHaveLength(2);
  });

  it('reports a re-request GitHub refused', async () => {
    const { service } = harness(() => ({ data: { rerequestReviews: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Review cannot be requested from pull request author.' }] }));
    await expect(service.rerequestReview(repo, 9, 'mona')).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('pull request author') });
  });
});

describe('after the console writes to a pull request', () => {
  it('reads its detail and repository again at once, and while watched the Overview once about ten seconds later', async () => {
    let write = 0;
    const { service, calls, searches, timers } = harness(() => {
      write += 1;
      return write === 1 ? { data: { addPullRequestReviewThreadReply: { comment: { id: 'C9', state: 'PENDING' } } } } : { data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } } };
    });
    const release = service.watch();
    await timers.fire();
    await service.pullRequestDetail(repo, 9);
    const lists = () => calls.filter(call => /\br0:repository\(/u.test(call.query)).length;
    const [listed, searched, revision] = [lists(), searches.length, service.revision];
    // GitHub held this one in the operator's Draft review
    expect(await service.replyToThread(repo, 9, 'PRRT_1', 'On it.')).toEqual({ id: 'C9', pending: true });
    await settled();
    expect(lists()).toBe(listed + 1);
    // every view showing the pull request asks again, and GitHub is read again
    expect(service.revision).toBeGreaterThan(revision);
    await service.pullRequestDetail(repo, 9);
    expect(calls.filter(isDetail)).toHaveLength(2);
    // GitHub's search index lags its writes; a second write soon after shares the later read
    await service.resolveThread(repo, 9, 'PRRT_1');
    expect(searches).toHaveLength(searched);
    release();
    expect(timers.delays()).toEqual([10_000]);
    await timers.fire();
    expect(searches).toHaveLength(searched + 1);
  });

  it('reads GitHub again after a write that failed, which may still have applied, and leaves an unwatched Overview to its next read', async () => {
    const { service, calls, timers } = harness(() => ({ data: { resolveReviewThread: null }, errors: [{ message: 'Something went wrong' }] }));
    await service.pullRequestDetail(repo, 9);
    await expect(service.resolveThread(repo, 9, 'PRRT_1')).rejects.toMatchObject({ kind: 'transient' });
    await service.pullRequestDetail(repo, 9);
    expect(calls.filter(isDetail)).toHaveLength(2);
    expect(timers.delays()).toEqual([]);
  });

  it('warns that a reply whose answer was lost may have posted', async () => {
    const { service } = harness(() => { throw new TypeError('fetch failed'); });
    await expect(service.replyToThread(repo, 9, 'PRRT_1', 'On it.')).rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining('may have posted anyway') });
  });
});

describe('what the module sends GitHub', () => {
  it('sends only GraphQL documents GitHub can parse: the poll, the searches, branch lookups, details and every write', async () => {
    const sent: GraphqlCall[] = [];
    const scripted = graphqlGithub({ 'octo/repo': { pulls: [{ number: 9, branch: 'retries', mine: true }], issues: [{ number: 4, title: 'Flaky', assigned: true }] } });
    const { service, timers } = polled({}, {
      request: async (url, init) => {
        sent.push(JSON.parse(String(init?.body)) as GraphqlCall);
        return await scripted.request(url, init);
      }
    });
    await service.reviewRequests(repo);
    const release = service.watch();
    await timers.fire();
    release();
    await service.branch(repo, 'retries', true, { wait: true });
    await service.branch(repo, forkCheckoutBranch({ number: 9, headSha: 'a'.repeat(40) }), false, { wait: true });
    await service.pullRequestDetail(repo, 9);
    await service.issueDetail(repo, 4);
    // the writes, each answered with nothing, which is GitHub refusing them
    const client = new GithubClient(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)) as GraphqlCall);
      return reply({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Not found' }] });
    });
    const writes: Promise<unknown>[] = [
      replyToThread(client, 'token', 'PRRT_1', 'On it.'), resolveThread(client, 'token', 'PRRT_1'), rerequestReviews(client, 'token', 'PR_9', { userIds: ['U_mona'] }),
      draftReviewTarget(client, 'token', repo, 9), draftReviewContent(client, 'token', 'PRR_1'), startDraftReview(client, 'token', 'PR_9', 'a'.repeat(40), 'Body'),
      updateDraftReview(client, 'token', 'PRR_1', 'Body'), addReviewThreads(client, 'token', [{ path: 'a.ts', line: 1, body: 'One' }, { path: 'b.ts', line: 2, body: 'Two' }])
    ];
    await Promise.allSettled(writes);
    expect(sent.filter(call => call.query.startsWith('mutation'))).toHaveLength(6);
    expect(sent.length).toBeGreaterThan(12);
    expect(sent.map(call => graphqlSyntaxError(call.query)).filter(error => error !== undefined)).toEqual([]);
  });

  it('knows a malformed document when it sees one', () => {
    expect(graphqlSyntaxError('query{repository{id}}')).toBeUndefined();
    expect(graphqlSyntaxError('query{repository{id}}}')).toBeDefined();
    expect(graphqlSyntaxError('query{repository{id}')).toBeDefined();
    expect(graphqlSyntaxError('query{repository(name:"}"){id)}')).toBeDefined();
    expect(graphqlSyntaxError('query{repository(name:"}"){id}}')).toBeUndefined();
  });
});
