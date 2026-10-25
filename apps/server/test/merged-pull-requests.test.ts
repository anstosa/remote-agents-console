import { describe, expect, it } from 'vitest';
import { PullRequestService } from '../src/pull-requests/service.js';
import type { Command, Request, ResponseLike } from '../src/pull-requests/github.js';

const mergedSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);

// build one complete GitHub pull request identity
function pull(options: { branch?: string; repository?: string; sha?: string; state?: string; mergedAt?: unknown } = {}): unknown {
  return {
    state: options.state ?? 'closed',
    merged_at: options.mergedAt === undefined ? '2026-10-10T12:00:00Z' : options.mergedAt,
    head: {
      ref: options.branch ?? 'feature/cleanup',
      sha: options.sha ?? mergedSha,
      repo: { full_name: options.repository ?? 'octo/repo' }
    }
  };
}

// provide one supported origin without host credential reads
function service(request: Request, now?: () => number, token: () => Promise<string | undefined> = async () => 'token', command: Command = async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' })): PullRequestService {
  return new PullRequestService(command, request, now, token);
}

// return one JSON response through the request boundary
function response(value: unknown, status = 200): ResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

describe('merged pull request evidence', () => {
  it('classifies an exact closed-unmerged head without changing merged-only evidence', async () => {
    let requests = 0;
    const github = service(async () => {
      requests += 1;
      return response([pull({ mergedAt: null })]);
    });

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe('closed');
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
    expect(requests).toBe(1);
  });

  it('prefers merged evidence when the exact head has merged and closed-unmerged pull requests', async () => {
    const github = service(async () => response([pull({ mergedAt: null }), pull()]));

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe('merged');
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);
  });

  it.each([
    ['older head', pull({ mergedAt: null, sha: otherSha })],
    ['fork head', pull({ mergedAt: null, repository: 'someone/fork' })]
  ])('excludes closed-unmerged evidence for a mismatched %s', async (_name, candidate) => {
    const github = service(async () => response([candidate]));

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
  });

  it('lets a later-page reopened branch veto closed-unmerged cleanup evidence', async () => {
    const pages: number[] = [];
    const fullPage = [pull({ mergedAt: null }), ...Array.from({ length: 99 }, (_, index) => pull({ branch: `fork/${index}`, repository: 'other/repo', sha: otherSha }))];
    const github = service(async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      // expose the reopened branch only after the full first page
      if (page === 2) return response([pull({ state: 'open', mergedAt: null, sha: otherSha })]);
      return response(fullPage);
    });

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
    expect(pages).toEqual([1, 2]);
  });

  it.each([
    ['missing merge marker', { state: 'closed', head: { ref: 'feature/cleanup', sha: mergedSha, repo: { full_name: 'octo/repo' } } }],
    ['numeric merge marker', pull({ mergedAt: 1 })],
    ['empty merge marker', pull({ mergedAt: ' ' })]
  ])('excludes closed cleanup evidence with a %s', async (_name, candidate) => {
    const github = service(async () => response([candidate]));

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
  });

  // a fork PR checks out as `rac/pr/<n>/<sha12>`, a name GitHub never lists as a head branch
  it.each([
    ['merged', { mergedAt: '2026-10-10T12:00:00Z' }, 'merged'],
    ['closed', { mergedAt: null }, 'closed'],
    ['open', { state: 'open', mergedAt: null }, undefined],
    ['moved on', { sha: otherSha, mergedAt: null }, undefined]
  ] as const)('classifies a console fork checkout by its pull request number when %s', async (_name, options, expected) => {
    const requests: string[] = [];
    const github = service(async (url) => {
      requests.push(url);
      return response({ number: 42, ...pull({ ...options, branch: 'contributor-branch', repository: 'someone/fork' }) as object });
    });

    await expect(github.cleanupHead('/workspace', `rac/pr/42/${mergedSha.slice(0, 12)}`, mergedSha)).resolves.toBe(expected);
    expect(requests).toEqual(['https://api.github.com/repos/octo/repo/pulls/42']);
  });

  // a worktree offer also takes a checkout the author pushed past before the pull request closed;
  // branch deletion keeps requiring the exact final head
  it.each([
    ['behind', 'merged'],
    ['identical', 'merged'],
    ['ahead', undefined],
    ['diverged', undefined]
  ] as const)('accepts a head behind a closed pull request\'s final head for a worktree offer only when GitHub compares it %s', async (status, expected) => {
    const compares: string[] = [];
    const github = service(async (url) => {
      if (url.includes('/compare/')) { compares.push(url); return response({ status }); }
      return response([pull({ sha: otherSha })]);
    });

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha, false, true)).resolves.toBe(expected);
    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha, false, true)).resolves.toBe(expected);
    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
    // cached like the exact-head check
    expect(compares).toEqual([`https://api.github.com/repos/octo/repo/compare/${otherSha}...${mergedSha}`]);
  });

  it('accepts a fork checkout behind its pull request\'s final head, and fails closed when GitHub cannot compare', async () => {
    const fork = `rac/pr/42/${mergedSha.slice(0, 12)}`;
    let compare: ResponseLike = response({ status: 'behind' });
    const github = service(async (url) => url.includes('/compare/') ? compare : response({ number: 42, ...pull({ sha: otherSha, mergedAt: null, branch: 'contributor-branch', repository: 'someone/fork' }) as object }));

    await expect(github.cleanupHead('/workspace', fork, mergedSha, false, true)).resolves.toBe('closed');
    compare = response({ message: 'Not Found' }, 404);
    await expect(github.cleanupHead('/workspace', fork, mergedSha, true, true)).resolves.toBeUndefined();
  });

  it('replaces cached closed evidence when fresh validation finds the branch open', async () => {
    let open = false;
    let requests = 0;
    const github = service(async () => {
      requests += 1;
      return response([pull(open ? { state: 'open', mergedAt: null } : { mergedAt: null })]);
    });

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe('closed');
    open = true;
    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha, true)).resolves.toBeUndefined();
    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
    expect(requests).toBe(2);
  });

  it('replaces cached closed evidence when fresh validation fails', async () => {
    let requests = 0;
    const github = service(async () => {
      requests += 1;
      // fail every retry after the initial closed proof
      if (requests > 1) throw new Error('offline');
      return response([pull({ mergedAt: null })]);
    });

    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe('closed');
    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha, true)).resolves.toBeUndefined();
    await expect(github.cleanupHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBeUndefined();
    expect(requests).toBe(4);
  });

  it('accepts an exact merged head into any base branch without unrelated API calls', async () => {
    const requests: string[] = [];
    const github = service(async (url) => {
      requests.push(url);
      return response([{ ...pull({ repository: 'OCTO/REPO', sha: mergedSha.toUpperCase() }), base: { ref: 'release/2026.10' } }]);
    });

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/repos/octo/repo/pulls?');
    expect(requests[0]).not.toContain('base=');
    expect(requests.every(url => url.includes('/pulls?'))).toBe(true);
  });

  it('encodes the owner-qualified head query and exact page controls', async () => {
    const branch = 'feature/slash + space';
    let requested = '';
    const github = service(async (url) => {
      requested = url;
      return response([pull({ branch })]);
    });

    await expect(github.mergedHead('/workspace', branch, mergedSha)).resolves.toBe(true);

    const url = new URL(requested);
    expect(url.searchParams.get('state')).toBe('all');
    expect(url.searchParams.get('head')).toBe(`octo:${branch}`);
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('page')).toBe('1');
    expect(requested).toContain('head=octo%3Afeature%2Fslash+%2B+space');
  });

  it('continues after a matched merge and lets a later open pull request veto cleanup', async () => {
    const pages: number[] = [];
    const fullPage = [pull(), ...Array.from({ length: 99 }, (_, index) => pull({ branch: `fork/${index}`, repository: 'other/repo', sha: otherSha }))];
    const github = service(async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      // expose an open reuse only after the full first page
      if (page === 2) return response([pull({ state: 'open', mergedAt: null, sha: otherSha })]);
      return response(fullPage);
    });

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
    expect(pages).toEqual([1, 2]);
  });

  it('finds an exact merge on a later page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => pull({ branch: `other/${index}`, repository: 'other/repo', sha: otherSha }));
    const github = service(async (url) => response(new URL(url).searchParams.get('page') === '1' ? fullPage : [pull()]));

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);
  });

  it('rejects a merge for an older commit after a branch has been reused', async () => {
    const github = service(async () => response([pull({ sha: otherSha })]));

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
  });

  it.each([
    ['missing head identity', { state: 'closed', merged_at: '2026-10-10T12:00:00Z' }],
    ['malformed head sha', pull({ sha: 'not-a-sha' })],
    ['fork head identity', pull({ repository: 'someone/fork' })],
    ['different branch identity', pull({ branch: 'feature/other' })],
    ['closed but unmerged', pull({ mergedAt: null })],
    ['empty merge timestamp', pull({ mergedAt: ' ' })]
  ])('fails closed for %s', async (_name, candidate) => {
    const github = service(async () => response([candidate]));

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
  });

  it('coalesces and caches exact identities until a fresh failure replaces success', async () => {
    let requests = 0;
    let release!: (value: ResponseLike) => void;
    const pending = new Promise<ResponseLike>((resolve) => { release = resolve; });
    const github = service(async () => {
      requests += 1;
      // hold the initial request so concurrent callers must share it
      if (requests === 1) return await pending;
      throw new Error('offline');
    });

    const first = github.mergedHead('/workspace', 'feature/cleanup', mergedSha);
    const second = github.mergedHead('/workspace', 'feature/cleanup', mergedSha);
    release(response([pull()]));
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);
    expect(requests).toBe(1);

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha, true)).resolves.toBe(false);
    expect(requests).toBe(4);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
    expect(requests).toBe(4);
  });

  it('bypasses cached origin discovery during fresh revalidation', async () => {
    const origins = ['git@github.com:octo/repo.git\n', 'git@github.com:current/repo.git\n'];
    let commands = 0;
    const requests: string[] = [];
    const github = service(async (url) => {
      requests.push(url);
      return response(url.includes('/repos/octo/repo/') ? [pull()] : []);
    }, undefined, async () => 'token', async () => ({ code: 0, stdout: origins[commands++]! }));

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha, true)).resolves.toBe(false);

    expect(commands).toBe(2);
    expect(requests[0]).toContain('/repos/octo/repo/pulls?');
    expect(requests[1]).toContain('/repos/current/repo/pulls?');
  });

  it('does not reuse success after fresh origin discovery fails', async () => {
    let commands = 0;
    let requests = 0;
    const github = service(async () => {
      requests += 1;
      return response([pull()]);
    }, undefined, async () => 'token', async () => {
      commands += 1;
      // make only destructive revalidation lose origin discovery
      if (commands === 2) throw new Error('git unavailable');
      return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    });

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha, true)).resolves.toBe(false);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);

    expect(commands).toBe(3);
    expect(requests).toBe(2);
  });

  it('keeps branch and commit cache identities separate and expires results after sixty seconds', async () => {
    let now = 0;
    let requests = 0;
    const github = service(async () => {
      requests += 1;
      return response([pull()]);
    }, () => now);

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(true);
    await expect(github.mergedHead('/workspace', 'feature/other', mergedSha)).resolves.toBe(false);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', otherSha)).resolves.toBe(false);
    expect(requests).toBe(3);
    now = 59_999;
    await github.mergedHead('/workspace', 'feature/cleanup', mergedSha);
    expect(requests).toBe(3);
    now = 60_000;
    await github.mergedHead('/workspace', 'feature/cleanup', mergedSha);
    expect(requests).toBe(4);
  });

  it('invalidates rejected credentials and fails closed', async () => {
    let tokens = 0;
    const seenAuthorization: Array<string | null> = [];
    const github = service(async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenAuthorization.push(headers.get('Authorization'));
      return response({ message: 'Bad credentials' }, 401);
    }, undefined, async () => `token-${++tokens}`);

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha, true)).resolves.toBe(false);

    expect(tokens).toBe(2);
    expect(seenAuthorization).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('fails closed when pagination reaches the bounded maximum without an ending page', async () => {
    let requests = 0;
    const fullPage = Array.from({ length: 100 }, (_, index) => pull({ branch: `other/${index}`, repository: 'other/repo', sha: otherSha }));
    const github = service(async () => {
      requests += 1;
      return response(fullPage);
    });

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
    expect(requests).toBe(100);
  });

  it('rejects invalid input and unavailable repositories before GitHub I/O', async () => {
    let commands = 0;
    let requests = 0;
    const command: Command = async () => {
      commands += 1;
      return { code: 1, stdout: '' };
    };
    const github = service(async () => {
      requests += 1;
      return response([pull()]);
    }, undefined, async () => 'token', command);

    await expect(github.mergedHead('/workspace', 'feature/cleanup', 'invalid')).resolves.toBe(false);
    expect(commands).toBe(0);
    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
    expect(commands).toBe(1);
    expect(requests).toBe(0);
  });

  it('fails closed when repository discovery throws', async () => {
    const github = service(async () => response([pull()]), undefined, async () => 'token', async () => { throw new Error('git unavailable'); });

    await expect(github.mergedHead('/workspace', 'feature/cleanup', mergedSha)).resolves.toBe(false);
  });
});
