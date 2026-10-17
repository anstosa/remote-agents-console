import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchCommitSummary, commitLog, comparisonAgainst, prComparisonCandidates } from '../src/git/comparison.js';
import * as command from '../src/tmux/command.js';

// fail one preferred-base operation while leaving a usable fallback
let failedOperation = '';
let failureCode = -1;

// isolate external Git command failures from repository fixtures
beforeEach(() => {
  failedOperation = '';
  failureCode = -1;
  vi.spyOn(command, 'run').mockImplementation(async (_binary, args) => {
    let operation = args.find(arg => ['show-ref', 'merge-base', 'config', 'remote'].includes(arg)) ?? '';
    // distinguish the two required diff reads
    if (args.includes('diff')) operation = args.includes('--numstat') ? 'numstat' : 'name-status';
    const preferred = args.includes('refs/heads/preferred') || args.includes('preferred-sha') || operation === 'config' || operation === 'remote';
    // fail only the higher-priority path
    if (operation === failedOperation && preferred) return { code: failureCode, stdout: '', stderr: 'git operation failed' };
    // keep merge bases distinct so a fallback would otherwise succeed
    if (operation === 'merge-base') return { code: 0, stdout: preferred ? 'preferred-sha' : 'fallback-sha', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
});

// restore the subprocess boundary between tests
afterEach(() => { vi.restoreAllMocks(); });

describe('comparison failure boundaries', () => {
  // ref and ancestry failures must agree across summaries and commit lists
  it.each([
    { operation: 'show-ref', code: -1 }, { operation: 'show-ref', code: 128 },
    { operation: 'merge-base', code: -1 }, { operation: 'merge-base', code: 128 }
  ])('does not choose a fallback after $operation exits with $code', async ({ operation, code }) => {
    failedOperation = operation;
    failureCode = code;

    await expect(comparisonAgainst('/workspace', ['preferred', 'fallback'])).resolves.toBeUndefined();
    await expect(commitLog('/workspace', ['preferred', 'fallback'])).resolves.toBeUndefined();
  });

  // a resolved target stays authoritative when either diff read fails
  it.each([
    { operation: 'name-status', code: -1 }, { operation: 'name-status', code: 128 },
    { operation: 'numstat', code: -1 }, { operation: 'numstat', code: 128 }
  ])('does not choose a fallback after $operation diff exits with $code', async ({ operation, code }) => {
    failedOperation = operation;
    failureCode = code;

    await expect(comparisonAgainst('/workspace', ['preferred', 'fallback'])).resolves.toBeUndefined();
  });

  // absence and disconnected history remain legitimate fallback cases
  it.each(['show-ref', 'merge-base'])('still falls back when %s reports absence', async operation => {
    failedOperation = operation;
    failureCode = 1;

    expect((await comparisonAgainst('/workspace', ['preferred', 'fallback']))?.comparison.base).toBe('fallback');
    expect((await commitLog('/workspace', ['preferred', 'fallback']))?.base).toBe('fallback');
  });

  // failed configuration reads must not masquerade as an unset preference
  it.each([-1, 128])('does not build a fallback ladder after config exits with %s', async code => {
    failedOperation = 'config';
    failureCode = code;

    await expect(prComparisonCandidates('/workspace', 'feature', 'release/pr', 'develop')).resolves.toEqual([]);
  });

  // malformed history metadata must omit enrichment rather than inventing a commit count
  it('omits a branch commit summary when rev-list returns a malformed count', async () => {
    const tip = 'a'.repeat(40);
    const base = 'b'.repeat(40);
    vi.mocked(command.run).mockImplementation(async (_binary, args) => {
      // resolve the exact local branch and fallback base
      if (args.includes('show-ref')) return { code: 0, stdout: '', stderr: '' };
      // pin the named branch tip
      if (args.includes('rev-parse')) return { code: 0, stdout: `${tip}\n`, stderr: '' };
      // leave branch-specific configuration and creation provenance absent
      if (args.includes('config')) return { code: 1, stdout: '', stderr: '' };
      // leave remote and source metadata empty
      if (args.includes('remote') || args.includes('reflog')) return { code: 0, stdout: '', stderr: '' };
      // resolve the main fallback and return the malformed count
      if (args.includes('merge-base')) return { code: 0, stdout: `${base}\n`, stderr: '' };
      // reject malformed history totals
      if (args.includes('rev-list')) return { code: 0, stdout: 'not-a-count\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(branchCommitSummary('/workspace', 'feature')).resolves.toBeUndefined();
  });

  // distinguish operational failures from ordinary missing optional metadata
  it.each([{ operation: 'show-ref', code: 128 }, { operation: 'remote', code: 1 }])('reports $operation exit $code while preserving branch summary unavailability', async ({ operation, code }) => {
    // fail the selected operation while allowing earlier ref and tip reads
    vi.mocked(command.run).mockImplementation(async (_binary, args) => {
      // inject one operational failure at the subprocess boundary
      if (args.includes(operation)) return { code, stdout: '', stderr: 'permission denied' };
      return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(branchCommitSummary('/workspace', 'feature')).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ workspace: '/workspace', branch: 'feature', code }));
  });

  // budget expiry is expected and must not launch a command or report an operational failure
  it('omits an expired summary without subprocesses or warnings', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(branchCommitSummary('/workspace', 'feature', undefined, Date.now() - 1)).resolves.toBeUndefined();
    expect(command.run).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  // remote discovery failures must not change branch namespace interpretation
  it.each([-1, 128])('does not choose a fallback after remote discovery exits with %s', async code => {
    failedOperation = 'remote';
    failureCode = code;

    await expect(prComparisonCandidates('/workspace', 'feature', 'release/pr', 'develop')).resolves.toEqual([]);
    await expect(comparisonAgainst('/workspace', ['upstream/preferred', 'fallback'])).resolves.toBeUndefined();
    await expect(commitLog('/workspace', ['upstream/preferred', 'fallback'])).resolves.toBeUndefined();
  });

  // source failures block lower defaults without discarding higher-priority candidates
  it.each([
    { operation: 'reflog', code: -1 }, { operation: 'reflog', code: 128 },
    { operation: 'show-ref', code: -1 }, { operation: 'show-ref', code: 128 },
    { operation: 'head-reflog', code: -1 }, { operation: 'head-reflog', code: 128 }
  ])('stops below the source after $operation exits with $code', async ({ operation, code }) => {
    vi.mocked(command.run).mockImplementation(async (_binary, args) => {
      // inject errors only at the source-resolution boundary
      const failed = operation === 'reflog' && args.includes('reflog')
        || operation === 'show-ref' && args.includes('show-ref') && args.includes('refs/heads/source')
        || operation === 'head-reflog' && args.includes('reflog') && args.includes('HEAD');
      // keep all other Git operations available
      if (failed) return { code, stdout: '', stderr: 'source lookup failed' };
      // provide retained creation provenance for source-ref and HEAD-reflog lookups
      if (args.includes('reflog')) return { code: 0, stdout: `feature@{100}\0abc123\0branch: Created from ${operation === 'head-reflog' ? 'HEAD' : 'source'}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(prComparisonCandidates('/workspace', 'feature', undefined, 'develop')).resolves.toEqual([]);
    await expect(prComparisonCandidates('/workspace', 'feature', 'release/pr', 'develop')).resolves.toEqual(['origin/release/pr', 'release/pr']);
  });
});
