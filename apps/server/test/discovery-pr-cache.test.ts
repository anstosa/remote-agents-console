import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitComparisonSummary, GitStatusSummary } from '../src/domain/models.js';
import type { WorktreeEntry } from '../src/git/worktrees.js';

const git = vi.hoisted(() => ({
  run: vi.fn(),
  workingStatus: vi.fn(),
  addUntrackedLineStats: vi.fn(),
  prComparisonCandidates: vi.fn(),
  comparisonAgainst: vi.fn()
}));

vi.mock('../src/tmux/command.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/tmux/command.js')>()), run: git.run }));
vi.mock('../src/git/comparison.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/comparison.js')>()),
  workingStatus: git.workingStatus,
  addUntrackedLineStats: git.addUntrackedLineStats,
  prComparisonCandidates: git.prComparisonCandidates,
  comparisonAgainst: git.comparisonAgainst
}));

import { DiscoveryService } from '../src/discovery/service.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';
import { testProject } from './helpers/config.js';

const cleanStatus: GitStatusSummary = { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changes: [] };
const configuredBases = new Map<string, string>();
const sourceBases = new Map<string, string>();
const unavailableBases = new Set<string>();

// normalize the target the same way the git comparison pipeline does
function comparisonBase(base: string): string {
  return base.startsWith('origin/') || base.startsWith('refs/') ? base : `origin/${base}`;
}

// return comparisons whose ordered fallbacks include one base
function comparisonCallsWith(base: string): unknown[][] {
  return git.comparisonAgainst.mock.calls.filter(([, candidates]) => (candidates as string[]).includes(base));
}

// return candidate reads for one normalized PR base
function candidateCallsWith(base: string): unknown[][] {
  return git.prComparisonCandidates.mock.calls.filter(([, , prBase]) => prBase === base);
}

// make one ordinary named worktree
function worktree(path: string, branch = 'feature/cache'): WorktreeEntry {
  return { path, head: 'abcdef1234567', branch, detached: false, bare: false, locked: false, prunable: false };
}

beforeEach(() => {
  vi.restoreAllMocks();
  git.run.mockReset().mockImplementation(async (_binary: string, args: string[]) => {
    const workspaceIndex = args.indexOf('-C');
    const workspace = workspaceIndex === -1 ? '' : args[workspaceIndex + 1] ?? '';
    // resolve pane paths without touching a real repository
    if (args.includes('--show-toplevel')) return { code: 0, stdout: `${workspace}\n` };
    // keep every synthetic checkout on one stable branch
    if (args.includes('symbolic-ref') && args.at(-1) === 'HEAD') return { code: 0, stdout: 'feature/cache\n' };
    return { code: 1, stdout: '' };
  });
  git.workingStatus.mockReset().mockResolvedValue(cleanStatus);
  git.addUntrackedLineStats.mockReset().mockResolvedValue(undefined);
  configuredBases.clear();
  sourceBases.clear();
  unavailableBases.clear();
  // preserve the production priority while isolating Git resolution from cache tests
  git.prComparisonCandidates.mockReset().mockImplementation(async (workspace: string, _branch: string | undefined, prBase?: string, defaultBranch?: string) => [...new Set([
    configuredBases.get(workspace),
    prBase,
    sourceBases.get(workspace),
    defaultBranch,
    'main'
  ].filter((base): base is string => base !== undefined).map(comparisonBase))]);
  git.comparisonAgainst.mockReset().mockImplementation(async (_workspace: string, candidates: string[]) => {
    const base = candidates.find(candidate => !unavailableBases.has(candidate));
    // all unavailable candidates produce no comparison
    return base === undefined ? undefined : { comparison: { base, files: 1, changes: [] }, gitBase: 'abc123' };
  });
});

describe('DiscoveryService pull request comparison cache', () => {
  // incomplete PR metadata retains the ordinary fallback order
  it.each([true, false])('uses the project default for a PR without a base with active agent %s', async active => {
    const workspace = '/workspaces/missing-pr-base';
    const project = testProject({ id: 'missing-base', path: workspace, defaultBranch: 'develop' });
    // simulate incomplete GitHub metadata without a lookup failure
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 9, title: 'Incomplete', status: 'open' as const, url: 'https://github.com/acme/app/pull/9' }) };
    const panes = active ? [{ paneId: '%1', sessionId: '$1', pid: 101, path: workspace, title: 'Ready' }] : [];
    // expose a synthetic checkout for either presentation path
    const service = new DiscoveryService(socketFinder(), paneLister(panes) as never, processInspector(), pullRequests, undefined, [project], undefined, async () => [worktree(workspace)]);

    const dashboard = await service.dashboard(false, true);
    const view = dashboard.agents[0] ?? dashboard.projects[0]?.worktrees[0];
    expect(view?.pullRequest?.number).toBe(9);
    expect(view?.gitPrStatus).toMatchObject({ base: 'origin/develop' });
    expect(git.prComparisonCandidates).toHaveBeenCalledWith(workspace, 'feature/cache', undefined, 'develop');
  });

  // a configured GitHub base remains ahead of PR metadata that arrives later
  it.each([true, false])('keeps the configured base ahead of a late PR with active agent %s', async active => {
    const workspace = '/workspaces/configured';
    const project = testProject({ id: 'configured', path: workspace, defaultBranch: 'develop' });
    configuredBases.set(workspace, 'release/configured');
    let baseBranch: string | undefined;
    // publish PR metadata after the initial fallback snapshot
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => baseBranch === undefined ? undefined : { number: 9, title: 'Release', status: 'open' as const, url: 'https://github.com/acme/app/pull/9', baseBranch } };
    const panes = active ? [{ paneId: '%1', sessionId: '$1', pid: 101, path: workspace, title: 'Ready' }] : [];
    // expose one synthetic checkout without real filesystem dependencies
    const service = new DiscoveryService(socketFinder(), paneLister(panes) as never, processInspector(), pullRequests, undefined, [project], undefined, async () => [worktree(workspace)]);

    const fallback = await service.dashboard(false, true);
    expect(service.worktreesNow()[0]?.defaultBranch).toBe('develop');
    expect(fallback.agents[0]?.gitPrStatus ?? fallback.projects[0]?.worktrees[0]?.gitPrStatus).toMatchObject({ base: 'origin/release/configured' });
    expect(git.prComparisonCandidates).toHaveBeenCalledWith(workspace, 'feature/cache', undefined, 'develop');

    baseBranch = 'release';
    const withPullRequest = await service.dashboard(false, true);
    expect(withPullRequest.agents[0]?.gitPrStatus ?? withPullRequest.projects[0]?.worktrees[0]?.gitPrStatus).toMatchObject({ base: 'origin/release/configured' });
    expect(git.comparisonAgainst).toHaveBeenCalledTimes(1);
  });

  // an unavailable configured base falls through to the PR before source and default
  it.each([true, false])('uses the PR after an unavailable configured base with active agent %s', async active => {
    const workspace = '/workspaces/pr-fallback';
    const project = testProject({ id: 'pr-fallback', path: workspace, defaultBranch: 'develop' });
    configuredBases.set(workspace, 'missing/configured');
    sourceBases.set(workspace, 'source/task');
    unavailableBases.add('origin/missing/configured');
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 9, title: 'Release', status: 'open' as const, url: 'https://github.com/acme/app/pull/9', baseBranch: 'release/foo' }) };
    const panes = active ? [{ paneId: '%1', sessionId: '$1', pid: 101, path: workspace, title: 'Ready' }] : [];
    const service = new DiscoveryService(socketFinder(), paneLister(panes) as never, processInspector(), pullRequests, undefined, [project], undefined, async () => [worktree(workspace)]);

    const dashboard = await service.dashboard(false, true);
    const view = dashboard.agents[0] ?? dashboard.projects[0]?.worktrees[0];
    expect(view?.gitPrStatus).toMatchObject({ base: 'origin/release/foo' });
    expect(git.prComparisonCandidates).toHaveBeenCalledWith(workspace, 'feature/cache', 'origin/release/foo', 'develop');
  });

  it('coalesces agents sharing one workspace and reuses their PR-base comparison on fresh pane scans', async () => {
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 1, title: 'Cache', status: 'open' as const, url: 'https://github.com/acme/app/pull/1', baseBranch: 'release' }) };
    const panes = [
      { paneId: '%1', sessionId: '$1', pid: 101, path: '/workspaces/app', title: '⠋ Working' },
      { paneId: '%2', sessionId: '$2', pid: 102, path: '/workspaces/app', title: 'Ready' }
    ];
    const service = new DiscoveryService(socketFinder(), paneLister(panes) as never, processInspector(), pullRequests);

    const first = await service.dashboard(false, true);
    panes[0]!.title = 'Ready';
    const second = await service.dashboard(false, true);

    expect(first.agents[0]?.attention).toBe('working');
    expect(second.agents[0]?.attention).toBe('finished');
    expect(first.agents.map(agent => agent.gitPrStatus)).toEqual([
      { base: 'origin/release', files: 1, changes: [] },
      { base: 'origin/release', files: 1, changes: [] }
    ]);
    expect(second.agents.map(agent => agent.gitPrStatus)).toEqual(first.agents.map(agent => agent.gitPrStatus));
    expect(candidateCallsWith('origin/release')).toHaveLength(1);
    expect(comparisonCallsWith('origin/release')).toHaveLength(1);
  });

  it('uses metadata fallback directly when PR metadata is absent or names the same base', async () => {
    let baseBranch: string | undefined;
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => baseBranch === undefined ? undefined : { number: 1, title: 'Main base', status: 'open' as const, url: 'https://github.com/acme/app/pull/1', baseBranch } };
    const service = new DiscoveryService(socketFinder(), paneLister([
      { paneId: '%1', sessionId: '$1', pid: 101, path: '/workspaces/app', title: 'Ready' }
    ]) as never, processInspector(), pullRequests);

    const withoutPullRequest = await service.dashboard(false, true);
    baseBranch = 'main';
    const matchingBase = await service.dashboard(false, true);

    expect(withoutPullRequest.agents[0]?.gitPrStatus).toEqual({ base: 'origin/main', files: 1, changes: [] });
    expect(matchingBase.agents[0]?.gitPrStatus).toEqual(withoutPullRequest.agents[0]?.gitPrStatus);
    expect(git.comparisonAgainst).toHaveBeenCalledTimes(1);
  });

  it('keys cached comparisons by normalized base and workspace', async () => {
    const bases = new Map([['/workspaces/app-a', 'staging'], ['/workspaces/app-b', 'staging']]);
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async (workspace: string) => ({ number: 1, title: 'Cache', status: 'open' as const, url: 'https://github.com/acme/app/pull/1', baseBranch: bases.get(workspace) }) };
    const service = new DiscoveryService(socketFinder(), paneLister([
      { paneId: '%1', sessionId: '$1', pid: 101, path: '/workspaces/app-a', title: 'Ready' },
      { paneId: '%2', sessionId: '$2', pid: 102, path: '/workspaces/app-b', title: 'Ready' }
    ]) as never, processInspector(), pullRequests);

    await service.dashboard(false, true);
    bases.set('/workspaces/app-a', 'release');
    await service.dashboard(false, true);
    bases.set('/workspaces/app-a', 'origin/release');
    await service.dashboard(false, true);

    expect(comparisonCallsWith('origin/staging').map(([workspace, candidates]) => [workspace, (candidates as string[])[0]])).toEqual([
      ['/workspaces/app-a', 'origin/staging'],
      ['/workspaces/app-b', 'origin/staging']
    ]);
    expect(comparisonCallsWith('origin/release').map(([workspace, candidates]) => [workspace, (candidates as string[])[0]])).toEqual([
      ['/workspaces/app-a', 'origin/release']
    ]);
  });

  it('reuses the cached PR-base comparison for an idle worktree', async () => {
    const workspace = '/workspaces/idle';
    const project = testProject({ id: 'idle', label: 'Idle', path: workspace });
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 2, title: 'Idle cache', status: 'open' as const, url: 'https://github.com/acme/app/pull/2', baseBranch: 'release' }) };
    const service = new DiscoveryService(socketFinder([]), paneLister([]) as never, processInspector({ codex: false }), pullRequests, undefined, [project], undefined, async path => path === workspace ? [worktree(workspace)] : undefined);

    const first = await service.dashboard(false, true);
    const second = await service.dashboard(false, true);

    expect(first.projects[0]?.worktrees[0]?.gitPrStatus).toEqual({ base: 'origin/release', files: 1, changes: [] });
    expect(second.projects[0]?.worktrees[0]?.gitPrStatus).toEqual(first.projects[0]?.worktrees[0]?.gitPrStatus);
    expect(comparisonCallsWith('origin/release')).toHaveLength(1);
  });

  it('starts a new comparison after metadata expiry and explicit invalidation', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 3, title: 'Refresh cache', status: 'open' as const, url: 'https://github.com/acme/app/pull/3', baseBranch: 'release' }) };
    const service = new DiscoveryService(socketFinder(), paneLister([
      { paneId: '%1', sessionId: '$1', pid: 101, path: '/workspaces/app', title: 'Ready' }
    ]) as never, processInspector(), pullRequests);

    await service.dashboard(false, true);
    now += 30_001;
    // the expiry tick starts a background metadata refresh
    await service.dashboard(false, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    // the next tick observes the replacement metadata generation
    await service.dashboard(false, true);
    service.invalidateWorktrees();
    await service.dashboard(false, true);

    expect(comparisonCallsWith('origin/release')).toHaveLength(3);
  });

  it('caches the fallback after an unavailable PR base for the metadata generation', async () => {
    unavailableBases.add('origin/release');
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 4, title: 'Missing base', status: 'open' as const, url: 'https://github.com/acme/app/pull/4', baseBranch: 'release' }) };
    const service = new DiscoveryService(socketFinder(), paneLister([
      { paneId: '%1', sessionId: '$1', pid: 101, path: '/workspaces/app', title: 'Ready' }
    ]) as never, processInspector(), pullRequests);

    const first = await service.dashboard(false, true);
    const second = await service.dashboard(false, true);

    expect(first.agents[0]?.gitPrStatus).toEqual({ base: 'origin/main', files: 1, changes: [] });
    expect(second.agents[0]?.gitPrStatus).toEqual(first.agents[0]?.gitPrStatus);
    expect(comparisonCallsWith('origin/release')).toHaveLength(1);
  });

  it('evicts a rejected comparison so the next dashboard can retry', async () => {
    let failures = 1;
    git.comparisonAgainst.mockImplementation(async (_workspace: string, candidates: string[]) => {
      // fail only the first authoritative comparison
      if (candidates[0] === 'origin/release' && failures-- > 0) throw new Error('comparison failed');
      return { comparison: { base: candidates[0]!, files: 1, changes: [] }, gitBase: 'abc123' };
    });
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 5, title: 'Retry cache', status: 'open' as const, url: 'https://github.com/acme/app/pull/5', baseBranch: 'release' }) };
    const service = new DiscoveryService(socketFinder(), paneLister([
      { paneId: '%1', sessionId: '$1', pid: 101, path: '/workspaces/app', title: 'Ready' }
    ]) as never, processInspector(), pullRequests);

    await expect(service.dashboard(false, true)).rejects.toThrow('comparison failed');
    await expect(service.dashboard(false, true)).resolves.toMatchObject({ agents: [{ gitPrStatus: { base: 'origin/release' } }] });

    expect(comparisonCallsWith('origin/release')).toHaveLength(2);
  });

  it('isolates a pending comparison from metadata created after invalidation', async () => {
    let markStarted!: () => void;
    let releaseOld!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const blocked = new Promise<void>(resolve => { releaseOld = resolve; });
    let targetCalls = 0;
    git.comparisonAgainst.mockImplementation(async (_workspace: string, candidates: string[]): Promise<{ comparison: GitComparisonSummary; gitBase: string } | undefined> => {
      // keep metadata fallback reads immediate
      if (candidates[0] === 'origin/main') return { comparison: { base: 'origin/main', files: 1, changes: [] }, gitBase: 'main123' };
      targetCalls += 1;
      const call = targetCalls;
      // hold only the pre-invalidation comparison
      if (call === 1) { markStarted(); await blocked; }
      return { comparison: { base: candidates[0]!, files: call, changes: [] }, gitBase: `release${call}` };
    });
    // stateless PR responses need no cache invalidation
    const pullRequests = { invalidateRepositories: () => {}, cachedPullRequest: async () => ({ number: 6, title: 'Invalidate cache', status: 'open' as const, url: 'https://github.com/acme/app/pull/6', baseBranch: 'release' }) };
    const service = new DiscoveryService(socketFinder(), paneLister([
      { paneId: '%1', sessionId: '$1', pid: 101, path: '/workspaces/app', title: 'Ready' }
    ]) as never, processInspector(), pullRequests);

    const stale = service.dashboard(false, true);
    await started;
    service.invalidateWorktrees();
    const fresh = await service.dashboard(false, true);
    releaseOld();
    const oldResult = await stale;
    const retained = await service.dashboard(false, true);

    expect(oldResult.agents[0]?.gitPrStatus?.files).toBe(1);
    expect(fresh.agents[0]?.gitPrStatus?.files).toBe(2);
    expect(retained.agents[0]?.gitPrStatus?.files).toBe(2);
    expect(comparisonCallsWith('origin/release')).toHaveLength(2);
  });
});
