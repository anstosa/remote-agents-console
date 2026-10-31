import { at, GithubRequestError, githubErrorMessage, graphqlError, type GithubClient, type GithubRepository, type GraphqlPayload } from './github.js';

// Every write the console makes to a pull request's reviews and Review threads, for the GitHub panel
// and Review tour posting. Each mutation is sent once, since a lost response may still have been
// applied; the caller decides what to read back.

// writes read and change more than a list read, so GitHub gets longer to answer
const timeoutMs = 15_000;
const batchTimeoutMs = 30_000;
const maxCommentPages = 50;
// per-alias GraphQL error types that are not GitHub refusing the thread itself
const unrefusedTypes = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'RATE_LIMITED']);

/** The viewer's unsubmitted review (CONTEXT.md's Draft review; GitHub's PENDING review). */
export type DraftReview = { id: string; body: string; commit?: string };
/** A pull request as a Draft review needs it: its node id, head, and the viewer's Draft review on it. */
export type DraftReviewTarget = { id: string; number: number; url: string; state: string; branch: string; headOwner: string; headSha: string; draft?: DraftReview };
/** One aliased thread's outcome; `refused` is GitHub rejecting that thread itself (a line it cannot resolve, a range it does not accept), as against a permission, rate limit, or request failure. */
export type ThreadOutcome = { created: true } | { created: false; reason: string; refused: boolean };
/** A batch either reports each thread, or failed in a way that may have applied some of it. */
export type BatchOutcome = { ambiguous: false; outcomes: ThreadOutcome[] } | { ambiguous: true; reason: string };

const draftTargetQuery = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id number url state headRefName headRefOid headRepositoryOwner{login} reviews(states:[PENDING],first:1){nodes{id body commit{oid}}}}}}';
const draftContentQuery = 'query($id:ID!,$after:String){node(id:$id){...on PullRequestReview{id body comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{body subjectType}}}}}';

// a mutation's lost answer (not a rate limit's hold, which sent nothing) may hide a write that applied
function mayHaveApplied(error: unknown, note: string): unknown {
  return error instanceof GithubRequestError && error.kind === 'transient' && error.until === undefined ? new GithubRequestError(`${error.message} ${note}`, error.statusCode, error.githubStatus, error.kind) : error;
}

/**
 * A reply to a Review thread. It names no review, so GitHub publishes it at once rather than adding
 * it to a Draft review; `pending` says GitHub held it in one anyway.
 */
export async function replyToThread(client: GithubClient, token: string, threadId: string, body: string): Promise<{ id: string; url?: string; pending: boolean }> {
  const action = 'GitHub could not post the reply';
  let payload: GraphqlPayload;
  try {
    payload = await client.mutate(token, 'mutation($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{id url state}}}', { input: { pullRequestReviewThreadId: threadId, body } }, action, timeoutMs);
  } catch (error) {
    throw mayHaveApplied(error, 'It may have posted anyway; check the thread before sending it again.');
  }
  const comment = at(payload.data, 'addPullRequestReviewThreadReply', 'comment');
  const [id, url] = [at(comment, 'id'), at(comment, 'url')];
  if (typeof id !== 'string') throw graphqlError(payload, action);
  return { id, ...(typeof url === 'string' ? { url } : {}), pending: at(comment, 'state') === 'PENDING' };
}

export async function resolveThread(client: GithubClient, token: string, threadId: string): Promise<void> {
  const action = 'GitHub could not resolve the thread';
  const payload = await client.mutate(token, 'mutation($input:ResolveReviewThreadInput!){resolveReviewThread(input:$input){thread{id isResolved}}}', { input: { threadId } }, action, timeoutMs);
  if (at(payload.data, 'resolveReviewThread', 'thread', 'isResolved') !== true) throw graphqlError(payload, action);
}

/** Ask reviewers for another review of a pull request, each named by its node id under its kind. */
export async function rerequestReviews(client: GithubClient, token: string, pullRequestId: string, reviewers: { userIds?: string[]; botIds?: string[]; teamIds?: string[] }): Promise<void> {
  const action = 'GitHub could not re-request the review';
  const payload = await client.mutate(token, 'mutation($input:RerequestReviewsInput!){rerequestReviews(input:$input){pullRequest{id}}}', { input: { pullRequestId, ...reviewers } }, action, timeoutMs);
  if (typeof at(payload.data, 'rerequestReviews', 'pullRequest', 'id') !== 'string') throw graphqlError(payload, action);
}

/** Open a pull request from `head`, a branch already pushed to the repository itself. */
export async function createPullRequest(client: GithubClient, token: string, repository: GithubRepository, input: { base: string; head: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }> {
  const action = 'GitHub could not create the pull request';
  const found = await client.query(token, 'query PullRequestRepository($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}', { owner: repository.owner, name: repository.name }, action, timeoutMs);
  const repositoryId = at(found.data, 'repository', 'id');
  if (typeof repositoryId !== 'string') throw graphqlError(found, action);
  let payload: GraphqlPayload;
  try {
    payload = await client.mutate(token, 'mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{number url}}}', { input: { repositoryId, baseRefName: input.base, headRefName: input.head, title: input.title, body: input.body, draft: input.draft } }, action, timeoutMs);
  } catch (error) {
    throw mayHaveApplied(error, 'It may have been created anyway; refresh the panel before trying again.');
  }
  const pull = at(payload.data, 'createPullRequest', 'pullRequest');
  const [number, url] = [at(pull, 'number'), at(pull, 'url')];
  if (!Number.isInteger(number) || typeof url !== 'string') throw graphqlError(payload, action);
  return { number: number as number, url };
}

/** A pull request's head and the viewer's Draft review on it; undefined when it has none by that number. */
export async function draftReviewTarget(client: GithubClient, token: string, repository: GithubRepository, number: number): Promise<DraftReviewTarget | undefined> {
  const action = 'GitHub could not load the pull request';
  const payload = await client.query(token, draftTargetQuery, { owner: repository.owner, name: repository.name, number }, action, timeoutMs);
  const found = at(payload.data, 'repository');
  if (found === null || typeof found !== 'object') throw graphqlError(payload, action);
  const node = at(found, 'pullRequest');
  if (node === null || typeof node !== 'object') return undefined;
  const [id, url, headRefOid] = [at(node, 'id'), at(node, 'url'), at(node, 'headRefOid')];
  if (typeof id !== 'string' || typeof url !== 'string' || typeof headRefOid !== 'string') throw new GithubRequestError('GitHub returned invalid pull request data.');
  const review = (at(node, 'reviews', 'nodes') as unknown[] | undefined)?.[0];
  const [reviewId, reviewBody, commit] = [at(review, 'id'), at(review, 'body'), at(review, 'commit', 'oid')];
  return {
    id, number, url, state: String(at(node, 'state')), branch: String(at(node, 'headRefName')), headOwner: String(at(node, 'headRepositoryOwner', 'login')), headSha: headRefOid.toLowerCase(),
    ...(typeof reviewId === 'string' ? { draft: { id: reviewId, body: typeof reviewBody === 'string' ? reviewBody : '', ...(typeof commit === 'string' ? { commit: commit.toLowerCase() } : {}) } } : {})
  };
}

/** A Draft review's body and every comment it holds, page by page. */
export async function draftReviewContent(client: GithubClient, token: string, reviewId: string): Promise<{ body: string; comments: Array<{ body: string; subjectType?: string }> }> {
  const action = 'GitHub could not read the draft review';
  const comments: Array<{ body: string; subjectType?: string }> = [];
  let body = '';
  let after: string | undefined;
  for (let page = 0; page < maxCommentPages; page += 1) {
    const payload = await client.query(token, draftContentQuery, { id: reviewId, ...(after === undefined ? {} : { after }) }, action, timeoutMs);
    const node = at(payload.data, 'node');
    const nodes = at(node, 'comments', 'nodes');
    if (!Array.isArray(nodes)) throw graphqlError(payload, action);
    body = typeof at(node, 'body') === 'string' ? at(node, 'body') as string : '';
    for (const comment of nodes) {
      const [text, subjectType] = [at(comment, 'body'), at(comment, 'subjectType')];
      if (typeof text === 'string') comments.push({ body: text, ...(typeof subjectType === 'string' ? { subjectType } : {}) });
    }
    const cursor = at(node, 'comments', 'pageInfo', 'endCursor');
    if (at(node, 'comments', 'pageInfo', 'hasNextPage') !== true || typeof cursor !== 'string') break;
    after = cursor;
  }
  return { body, comments };
}

/** Open the viewer's Draft review on a commit (no `event` keeps it pending), returning its id. */
export async function startDraftReview(client: GithubClient, token: string, pullRequestId: string, commit: string, body: string): Promise<string> {
  const action = 'GitHub could not start a draft review';
  const payload = await client.mutate(token, 'mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id}}}', { input: { pullRequestId, commitOID: commit, ...(body === '' ? {} : { body }) } }, action, timeoutMs);
  const id = at(payload.data, 'addPullRequestReview', 'pullRequestReview', 'id');
  if (typeof id !== 'string') throw graphqlError(payload, action);
  return id;
}

/** Replace a Draft review's body. */
export async function updateDraftReview(client: GithubClient, token: string, reviewId: string, body: string): Promise<void> {
  const action = 'GitHub could not update the draft review';
  const payload = await client.mutate(token, 'mutation($input:UpdatePullRequestReviewInput!){updatePullRequestReview(input:$input){pullRequestReview{id}}}', { input: { pullRequestReviewId: reviewId, body } }, action, timeoutMs);
  if (typeof at(payload.data, 'updatePullRequestReview', 'pullRequestReview', 'id') !== 'string') throw graphqlError(payload, action);
}

/** Add Review threads (each an AddPullRequestReviewThreadInput) in one request; a refused request fails each thread, a lost or broken one is ambiguous. */
export async function addReviewThreads(client: GithubClient, token: string, inputs: Array<Record<string, unknown>>): Promise<BatchOutcome> {
  const action = 'GitHub could not add the comments';
  const mutation = threadMutation(inputs);
  let payload: GraphqlPayload;
  try {
    payload = await client.mutate(token, mutation.query, mutation.variables, action, batchTimeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : `${action}.`;
    return error instanceof GithubRequestError && error.kind !== 'transient' ? { ambiguous: false, outcomes: inputs.map(() => ({ created: false, reason, refused: false })) } : { ambiguous: true, reason };
  }
  return ambiguousBatch(payload) ? { ambiguous: true, reason: graphqlError(payload, action).message } : { ambiguous: false, outcomes: threadOutcomes(inputs.length, payload) };
}

// one GraphQL request adding every thread, aliased t0, t1, … with one input variable each
export function threadMutation(inputs: Array<Record<string, unknown>>): { query: string; variables: Record<string, unknown> } {
  const declarations = inputs.map((_, index) => `$i${index}:AddPullRequestReviewThreadInput!`).join(',');
  const fields = inputs.map((_, index) => `t${index}:addPullRequestReviewThread(input:$i${index}){thread{id}}`).join(' ');
  return { query: `mutation(${declarations}){${fields}}`, variables: Object.fromEntries(inputs.map((input, index) => [`i${index}`, input])) };
}

// a batch whose outcome is unknown: no data and an error naming no alias
export function ambiguousBatch(payload: GraphqlPayload): boolean {
  const errors = Array.isArray(payload.errors) ? payload.errors as unknown[] : [];
  return (payload.data === null || payload.data === undefined) && errors.length > 0 && errors.every(error => !Array.isArray(at(error, 'path')));
}

// each aliased thread's outcome; GraphQL succeeds partially, naming a failed alias in an error's `path`
export function threadOutcomes(count: number, payload: unknown): ThreadOutcome[] {
  const value = payload !== null && typeof payload === 'object' ? payload as GraphqlPayload : {};
  const byAlias = new Map<string, { reason: string; refused: boolean }>();
  let general: string | undefined;
  for (const error of Array.isArray(value.errors) ? value.errors as unknown[] : []) {
    const message = githubErrorMessage(error) ?? 'GitHub rejected the comment.';
    const path = at(error, 'path');
    const alias = Array.isArray(path) && typeof path[0] === 'string' ? path[0] : undefined;
    const type = at(error, 'type');
    // an error without a path failed the whole request
    if (alias === undefined) general ??= message;
    else if (!byAlias.has(alias)) byAlias.set(alias, { reason: message, refused: !(typeof type === 'string' && unrefusedTypes.has(type)) });
  }
  const data = value.data !== null && typeof value.data === 'object' ? value.data : {};
  return Array.from({ length: count }, (_, index): ThreadOutcome => {
    if (typeof at(data[`t${index}`], 'thread', 'id') === 'string') return { created: true };
    return { created: false, ...byAlias.get(`t${index}`) ?? { reason: general ?? 'GitHub did not create the comment thread.', refused: false } };
  });
}
