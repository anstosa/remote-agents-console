import { describe, expect, it, vi } from 'vitest';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { createReviewDraftPort } from '../src/integrations/mcp/review-draft.js';
import type { ReviewComparison } from '../src/review-tour/contracts.js';
import { PullRequestReviewError } from '../src/review-tour/pr-review.js';

const principal: IntegrationPrincipal = { authentication: 'realtime', subjectId: 'owner', stableOwnerKey: 'o'.repeat(43), leaseKey: 'l'.repeat(43), audience: 'realtime', scopes: ['github:write'] };
const comparison: ReviewComparison = {
  worktreeId: 'worktree-2', workspace: '/repo/two', branch: 'feature', scope: 'pr', base: 'main', includeTests: true, includeDocs: true,
  fingerprint: 'fingerprint-1234567890',
  changes: [{ id: 'change-12345678', file: 'src/a.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1,1 +1,1 @@\n-old\n+new' }]
};

const input = { repository: 'acme/repo', number: 7, fingerprint: comparison.fingerprint, body: 'Overall note', comments: [{ path: 'src/a.ts', line: 1, body: 'Change this.' }], request_id: 'request-12345678' };

// bind one deterministic prepared comparison to a post seam
function portFor(post: ReturnType<typeof vi.fn>) {
  return createReviewDraftPort({ worktrees: () => [{ id: 'worktree-2', path: '/repo/two', available: true }], repositoryAt: async () => ({ owner: 'acme', name: 'repo' }), current: async () => comparison, post });
}

describe('review draft port', () => {
  it('resolves the configured repository and fingerprint and maps only actual diff lines', async () => {
    const post = vi.fn(async () => ({ status: 'ok' as const, draftId: 'PRR_actual', review: { url: 'https://github.com/acme/repo/pull/7/files', pullRequest: { number: 7, url: 'https://github.com/acme/repo/pull/7' } }, sections: [], comments: [] }));
    const current = vi.fn(async (worktreeId: string) => worktreeId === 'worktree-2' ? comparison : { ...comparison, worktreeId, workspace: '/repo/one', fingerprint: 'different-12345678' });
    const port = createReviewDraftPort({
      worktrees: () => [{ id: 'worktree-1', path: '/repo/one', available: true }, { id: 'worktree-2', path: '/repo/two', available: true }],
      repositoryAt: async path => path === '/repo/one' || path === '/repo/two' ? { owner: 'Acme', name: 'Repo' } : undefined,
      current,
      post
    });
    await expect(port(input, principal)).resolves.toEqual({ ok: true, version: 'v2', value: { draft_id: 'PRR_actual', state: 'pending' } });
    expect(post).toHaveBeenCalledTimes(1);
    const [worktreeId, posted] = post.mock.calls[0]!;
    expect(worktreeId).toBe('worktree-2');
    expect(posted).toMatchObject({ scope: 'pr', fingerprint: comparison.fingerprint, pullRequestNumber: 7, comments: [{ changeId: 'change-12345678', startSide: 'additions', startLine: 1, endSide: 'additions', endLine: 1, body: 'Change this.' }] });
    expect(posted.sections[0].key).toMatch(/^mcp:/u);
    expect(posted.comments[0].id).toMatch(/^mcp_/u);
  });

  it('refuses an unavailable line before calling the GitHub draft port', async () => {
    const post = vi.fn();
    const port = createReviewDraftPort({ worktrees: () => [{ id: 'worktree-2', path: '/repo/two', available: true }], repositoryAt: async () => ({ owner: 'acme', name: 'repo' }), current: async () => comparison, post });
    const result = await port({ repository: 'acme/repo', number: 7, fingerprint: comparison.fingerprint, comments: [{ path: 'src/a.ts', line: 99, body: 'No anchor.' }], request_id: 'request-12345678' }, principal);
    expect(result).toMatchObject({ ok: false, error: { code: 'stale_preparation' } });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['github_failed', 'github_forbidden', 'pull_request_mismatch', 'pending_review_outdated'] as const)('propagates ambiguous %s outcomes', async code => {
    const provider = new PullRequestReviewError(code, true, 'private provider detail');
    const post = vi.fn(async () => { throw provider; });
    await expect(portFor(post)(input, principal)).rejects.toBe(provider);
    expect(post).toHaveBeenCalledOnce();
  });

  it('propagates missing effect evidence', async () => {
    const missingId = vi.fn(async () => ({ status: 'ok' as const, review: { url: 'https://github.com/acme/repo/pull/7/files', pullRequest: { number: 7, url: 'https://github.com/acme/repo/pull/7' } }, sections: [], comments: [] }));
    await expect(portFor(missingId)(input, principal)).rejects.toThrow('pending review outcome is uncertain');
    expect(missingId).toHaveBeenCalledOnce();
  });

  it.each([
    ['stale', 'stale_preparation'],
    ['no_pull_request', 'not_found'],
    ['no_github_token', 'forbidden'],
    ['uncommitted', 'invalid_state'],
    ['head_mismatch', 'invalid_state']
  ] as const)('maps proven pre-effect %s errors locally', async (code, expected) => {
    const post = vi.fn(async () => { throw new PullRequestReviewError(code, false, 'bounded guard'); });
    await expect(portFor(post)(input, principal)).resolves.toMatchObject({ ok: false, error: { code: expected } });
  });
});
