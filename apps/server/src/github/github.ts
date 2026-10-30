import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tmux/command.js';

// The console's one way to talk to GitHub: which token, which repository an origin names, how a
// failure reads, and the one client every request goes through. A query (a REST GET or a GraphQL
// query) is retried on a gateway failure; a mutation is sent once, since a lost response may still
// have been applied.

export type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
export type ResponseLike = { ok: boolean; status?: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> };
export type Request = (input: string, init?: RequestInit) => Promise<ResponseLike>;
export type Token = () => Promise<string | undefined>;
export type GithubRepository = { owner: string; name: string };
export type GraphqlPayload = { data?: Record<string, unknown> | null; errors?: unknown };
// `transient`: the request failed in transit, timed out, or GitHub was briefly unable (a lost
// mutation response may still have been applied); `forbidden`: the token was refused or lacks
// permission; `rejected`: GitHub refused the request itself, so repeating it will not help
export type GithubFailureKind = 'transient' | 'forbidden' | 'rejected';

const graphqlUrl = 'https://api.github.com/graphql';
const queryAttempts = 3;
const retryableStatuses = new Set([500, 502, 503, 504]);
const forbiddenGraphqlTypes = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES']);
// GitHub's advice for a 429 that names no time to wait
const defaultRateLimitWaitMs = 60_000;
// a rate limit resets within the hour, so a longer wait is a bad header or a skewed clock
const maxHoldMs = 3_600_000;

export class GithubRequestError extends Error {
  // `statusCode` is the console's own reply status; `githubStatus` is GitHub's; `until` is when a
  // rate limit lets requests through again
  constructor(message: string, readonly statusCode = 502, readonly githubStatus?: number, readonly kind: GithubFailureKind = 'rejected', readonly until?: number) {
    super(message);
    this.name = 'GithubRequestError';
  }
}

// read one bounded GitHub error message
export function githubErrorMessage(value: unknown): string | undefined {
  const message = value !== null && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string' ? (value as { message: string }).message.trim().replace(/\s+/gu, ' ').slice(0, 300) : '';
  return message || undefined;
}

// read a nested value without trusting the payload's shape
export function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}

// the owner and name an origin URL names on github.com
export function githubRepository(remote: string): GithubRepository | undefined {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match === null ? undefined : { owner: match[1]!, name: match[2]! };
}

// `owner/name`, encoded for a URL path
export function repositoryPath({ owner, name }: GithubRepository): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** The GitHub repository a checkout's origin names, if it names one. */
export async function originRepository(checkout: string): Promise<GithubRepository | undefined> {
  const remote = await run('/usr/bin/git', ['-C', checkout, 'remote', 'get-url', 'origin']).catch(() => undefined);
  return remote?.code === 0 ? githubRepository(remote.stdout) : undefined;
}

// the active github.com token in gh's hosts.yml: the host-level `oauth_token` of the `github.com:`
// block, never one under its `users:` map (other accounts) or another host's block
export function hostsToken(hosts: string): string | undefined {
  const lines = hosts.split(/\r?\n/u);
  const start = lines.findIndex(line => /^["']?github\.com["']?:\s*$/u.test(line));
  if (start < 0) return undefined;
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const depth = line.length - line.trimStart().length;
    // the next top-level key ends the block
    if (depth === 0) break;
    indent ??= depth;
    // skip anything nested deeper, such as the users map
    if (depth !== indent) continue;
    const match = /^oauth_token:\s*(["']?)([^\s"']+)\1\s*$/u.exec(line.trim());
    if (match !== null) return match[2];
  }
  return undefined;
}

// the console's GitHub token: RAC_GITHUB_TOKEN, else the gh CLI's active github.com one
export async function githubToken(): Promise<string | undefined> {
  if (process.env.RAC_GITHUB_TOKEN) return process.env.RAC_GITHUB_TOKEN;
  return hostsToken(await readFile(process.env.RAC_GH_HOSTS ?? join(homedir(), '.config/gh/hosts.yml'), 'utf8').catch(() => ''));
}

export function githubHeaders(token: string | undefined): Record<string, string> {
  return { Accept: 'application/vnd.github+json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) };
}

// classify an HTTP failure; a 403 for a rate limit is a pause, not a refusal
function failureKind(status: number | undefined, message: string | undefined): GithubFailureKind {
  if (status === 429 || status !== undefined && retryableStatuses.has(status) || status === 403 && /rate limit/iu.test(message ?? '')) return 'transient';
  return status === 401 || status === 403 ? 'forbidden' : 'rejected';
}

// the error a GraphQL payload's `errors` describe; an untyped error is GitHub's own trouble
export function graphqlError(payload: GraphqlPayload, action: string): GithubRequestError {
  const errors = Array.isArray(payload.errors) ? payload.errors as unknown[] : [];
  const types = errors.map(error => at(error, 'type')).filter((type): type is string => typeof type === 'string');
  const kind: GithubFailureKind = types.some(type => forbiddenGraphqlTypes.has(type)) ? 'forbidden' : types.length === 0 || types.includes('RATE_LIMITED') ? 'transient' : 'rejected';
  const first = githubErrorMessage(errors[0]);
  return new GithubRequestError(first === undefined ? `${action}.` : `${action}: ${first}`, 502, undefined, kind);
}

type ClientOptions = { timeoutMs?: number; now?: () => number; refused?: () => void };

// Every request the console sends goes through one client, as GitHub asks: one at a time, slower
// while any budget runs low, and none while a rate limit holds them back. `refused` hears of a 401,
// or a 403 that is not a rate limit, so the token and viewer are looked up again.
export class GithubClient {
  private queue: Promise<unknown> = Promise.resolve();
  // when each token's rate limit lets requests through again ('' for none)
  private readonly holds = new Map<string, number>();
  // the last budget GitHub reported for each resource (core, graphql, search…)
  private readonly budgets = new Map<string, { low: boolean; reset: number }>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly request: Request = fetch, private readonly options: ClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? Date.now;
  }

  // `ms`, doubled while any budget is below 20% remaining
  interval(ms: number): number {
    const now = this.now();
    return [...this.budgets.values()].some(budget => budget.low && budget.reset > now) ? ms * 2 : ms;
  }

  // one REST GET, retried on a gateway failure
  async get(url: string, token: string | undefined, action: string, timeoutMs = this.timeoutMs): Promise<ResponseLike> {
    return await this.send(url, token, { headers: githubHeaders(token) }, action, queryAttempts, timeoutMs);
  }

  // one GraphQL query, retried on a gateway failure; `errors` are the caller's to read
  async query(token: string, query: string, variables: Record<string, unknown>, action: string, timeoutMs = this.timeoutMs): Promise<GraphqlPayload> {
    return await this.graphql(token, query, variables, action, queryAttempts, timeoutMs);
  }

  // one GraphQL mutation, sent once
  async mutate(token: string, query: string, variables: Record<string, unknown>, action: string, timeoutMs = this.timeoutMs): Promise<GraphqlPayload> {
    return await this.graphql(token, query, variables, action, 1, timeoutMs);
  }

  private async graphql(token: string, query: string, variables: Record<string, unknown>, action: string, attempts: number, timeoutMs: number): Promise<GraphqlPayload> {
    const response = await this.send(graphqlUrl, token, { method: 'POST', headers: { ...githubHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }, action, attempts, timeoutMs);
    const payload = await response.json().catch(() => undefined);
    if (payload === null || typeof payload !== 'object') throw new GithubRequestError(`${action}: GitHub returned invalid data.`, 502, response.status, 'transient');
    return payload as GraphqlPayload;
  }

  // send one request, up to `attempts` times while GitHub's gateway fails
  private async send(input: string, token: string | undefined, init: RequestInit, action: string, attempts: number, timeoutMs: number): Promise<ResponseLike> {
    let failure = new GithubRequestError(`${action} because the request failed.`, 502, undefined, 'transient');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let sent: { response: ResponseLike; until?: number };
      try {
        sent = await this.turn(input, token, init, action, timeoutMs);
      } catch (error) {
        // a rate limit's hold is final; transport failures and timeouts are retried
        if (error instanceof GithubRequestError) throw error;
        failure = new GithubRequestError(`${action} because the request failed.`, 502, undefined, 'transient');
        continue;
      }
      const { response } = sent;
      if (response.ok) return response;
      const detail = githubErrorMessage(await response.json().catch(() => undefined));
      const status = Number.isInteger(response.status) ? ` (${response.status})` : '';
      // a secondary rate limit may name no wait; GitHub asks for at least a minute
      const until = sent.until ?? ((response.status === 403 || response.status === 429) && /rate limit/iu.test(detail ?? '') ? this.hold(token, this.now() + defaultRateLimitWaitMs) : undefined);
      if (response.status === 401 || response.status === 403 && until === undefined) this.options.refused?.();
      failure = new GithubRequestError(detail === undefined ? `${action}${status}.` : `${action}${status}: ${detail}`, 502, response.status, until === undefined ? failureKind(response.status, detail) : 'transient', until);
      // a permanent failure is not retried
      if (!retryableStatuses.has(response.status ?? 0)) break;
    }
    throw failure;
  }

  // send one request once every earlier one has finished, unless a rate limit holds back the
  // token's requests; `until` is the hold this response started
  private async turn(input: string, token: string | undefined, init: RequestInit, action: string, timeoutMs: number): Promise<{ response: ResponseLike; until?: number }> {
    const turn = this.queue.then(async () => {
      const held = this.holds.get(token ?? '') ?? 0;
      if (held > this.now()) throw new GithubRequestError(`${action}: GitHub's rate limit holds requests until ${new Date(held).toISOString()}.`, 502, undefined, 'transient', held);
      const response = await this.request(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const until = this.observe(response, token);
      return { response, ...(until === undefined ? {} : { until }) };
    });
    this.queue = turn.catch(() => undefined);
    return await turn;
  }

  // record the budget a response reports, and hold back the token's requests after a 403 or 429
  // that names a wait
  private observe(response: ResponseLike, token: string | undefined): number | undefined {
    const header = (name: string): number | undefined => {
      const value = response.headers?.get(name)?.trim();
      return value === undefined || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value);
    };
    const [remaining, limit, reset] = [header('x-ratelimit-remaining'), header('x-ratelimit-limit'), header('x-ratelimit-reset')];
    if (remaining !== undefined && limit !== undefined && limit > 0 && reset !== undefined) this.budgets.set(response.headers?.get('x-ratelimit-resource') ?? 'core', { low: remaining < limit * 0.2, reset: reset * 1_000 });
    if (response.status !== 403 && response.status !== 429) return undefined;
    const retryAfter = header('retry-after');
    const until = retryAfter !== undefined ? this.now() + retryAfter * 1_000 : remaining === 0 && reset !== undefined ? reset * 1_000 : response.status === 429 ? this.now() + defaultRateLimitWaitMs : undefined;
    return until === undefined ? undefined : this.hold(token, until);
  }

  // hold back one token's requests until `until`, never past GitHub's hourly window; a hold
  // reached without a token does not hold back the token found later
  private hold(token: string | undefined, until: number): number {
    const held = Math.max(this.holds.get(token ?? '') ?? 0, Math.min(until, this.now() + maxHoldMs));
    this.holds.set(token ?? '', held);
    return held;
  }
}
