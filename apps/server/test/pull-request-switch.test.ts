import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PullRequestSwitchService } from '../src/pull-requests/switch-service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import type { GitCommand } from '../src/git/worktree-state.js';
import type { AttentionState } from '../src/adapters/types.js';
import { run } from '../src/tmux/command.js';
import * as commands from '../src/tmux/command.js';

const worktree = { id: 'cora:/worktrees/cora', projectId: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: true, main: true, detached: false, locked: false };
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(), pollIntervalMs: 500, adapters: {}, projects: [] };
const agent = { id: 'agent-1', paneId: '%1', sessionId: '$1', socketFingerprint: 'socket', home: worktree.identity, branch: 'feature/current', title: 'Ready', attention: 'finished' as AttentionState };
const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const headSha = 'a'.repeat(40);
const choices = [{ number: 7, title: 'Draft work', branch: 'feature/draft', headSha, headOnOrigin: true, draft: true, url: 'https://github.com/octo/repo/pull/7' }];

const commonRepositoryResult = { code: 0, stdout: '/repositories/project/.git\n' };
const cleanCommand = async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('--git-common-dir') ? commonRepositoryResult.stdout : args.includes('status') ? '' : args.includes('refs/heads') ? '' : 'refs/remotes/origin/feature/current\n' });

// create one linked repository fixture
async function createMoveRepository(withSubmodule = false) {
  const root = await mkdtemp(join(tmpdir(), 'rac-pr-move-'));
  const targetPath = join(root, 'cora');
  const sourcePath = join(root, 'delta');
  await run('/usr/bin/git', ['init', targetPath]);
  await run('/usr/bin/git', ['-C', targetPath, 'config', 'user.name', 'Test User']);
  await run('/usr/bin/git', ['-C', targetPath, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(targetPath, 'tracked.txt'), 'original\n');
  await run('/usr/bin/git', ['-C', targetPath, 'add', 'tracked.txt']);
  await run('/usr/bin/git', ['-C', targetPath, 'commit', '-m', 'initial']);
  // add one dirty state that normal stash cannot capture
  if (withSubmodule) {
    const submoduleSource = join(root, 'module-source');
    await run('/usr/bin/git', ['init', submoduleSource]);
    await run('/usr/bin/git', ['-C', submoduleSource, 'config', 'user.name', 'Test User']);
    await run('/usr/bin/git', ['-C', submoduleSource, 'config', 'user.email', 'test@example.com']);
    await writeFile(join(submoduleSource, 'module.txt'), 'original module\n');
    await run('/usr/bin/git', ['-C', submoduleSource, 'add', 'module.txt']);
    await run('/usr/bin/git', ['-C', submoduleSource, 'commit', '-m', 'module']);
    await run('/usr/bin/git', ['-c', 'protocol.file.allow=always', '-C', targetPath, 'submodule', 'add', submoduleSource, 'module']);
    await run('/usr/bin/git', ['-C', targetPath, 'commit', '-am', 'add module']);
  }
  await run('/usr/bin/git', ['-C', targetPath, 'branch', '-M', 'main']);
  await run('/usr/bin/git', ['-C', targetPath, 'branch', 'feature/draft']);
  await run('/usr/bin/git', ['-C', targetPath, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await run('/usr/bin/git', ['-C', targetPath, 'worktree', 'add', sourcePath, 'feature/draft']);
  // initialize the linked submodule fixture
  if (withSubmodule) await run('/usr/bin/git', ['-c', 'protocol.file.allow=always', '-C', sourcePath, 'submodule', 'update', '--init']);
  const head = await run('/usr/bin/git', ['-C', sourcePath, 'rev-parse', 'HEAD']);
  return { root, targetPath, sourcePath, headSha: head.stdout.trim() };
}

// create one repository fixture for the switch path: a target worktree on main with an origin
// holding a head-on-origin branch and a pull request head ref, plus a local branch open nowhere
async function createSwitchRepository() {
  const root = await mkdtemp(join(tmpdir(), 'rac-pr-switch-'));
  const originPath = join(root, 'origin');
  const targetPath = join(root, 'target');
  await run('/usr/bin/git', ['init', '-b', 'main', originPath]);
  await run('/usr/bin/git', ['-C', originPath, 'config', 'user.name', 'Test User']);
  await run('/usr/bin/git', ['-C', originPath, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(originPath, 'base.txt'), 'base\n');
  await run('/usr/bin/git', ['-C', originPath, 'add', 'base.txt']);
  await run('/usr/bin/git', ['-C', originPath, 'commit', '-m', 'base']);
  // a head-on-origin branch, fetched into a remote-tracking ref by clone
  await run('/usr/bin/git', ['-C', originPath, 'switch', '-c', 'feature/draft']);
  await writeFile(join(originPath, 'draft.txt'), 'draft\n');
  await run('/usr/bin/git', ['-C', originPath, 'add', 'draft.txt']);
  await run('/usr/bin/git', ['-C', originPath, 'commit', '-m', 'draft']);
  const draft = await run('/usr/bin/git', ['-C', originPath, 'rev-parse', 'HEAD']);
  // a pull request head reachable only through refs/pull/<n>/head, never fetched by clone
  await run('/usr/bin/git', ['-C', originPath, 'switch', '-c', 'pr-source', 'main']);
  await writeFile(join(originPath, 'pr.txt'), 'pr\n');
  await run('/usr/bin/git', ['-C', originPath, 'add', 'pr.txt']);
  await run('/usr/bin/git', ['-C', originPath, 'commit', '-m', 'pr']);
  const pr = await run('/usr/bin/git', ['-C', originPath, 'rev-parse', 'HEAD']);
  await run('/usr/bin/git', ['-C', originPath, 'update-ref', 'refs/pull/8/head', pr.stdout.trim()]);
  await run('/usr/bin/git', ['-C', originPath, 'branch', '-D', 'pr-source']);
  await run('/usr/bin/git', ['-C', originPath, 'switch', 'main']);
  await run('/usr/bin/git', ['clone', originPath, targetPath]);
  await run('/usr/bin/git', ['-C', targetPath, 'config', 'user.name', 'Test User']);
  await run('/usr/bin/git', ['-C', targetPath, 'config', 'user.email', 'test@example.com']);
  await run('/usr/bin/git', ['-C', targetPath, 'branch', 'feature/solo']);
  return { root, originPath, targetPath, draftSha: draft.stdout.trim(), prSha: pr.stdout.trim() };
}

type PullRequestChoiceFixture = { number: number; branch: string; headSha: string; headOnOrigin: boolean };

// assemble one switch service around a real repository, with the target agent's attention and git command configurable
// an undefined attention leaves the worktree with no agent
function switchService(repository: Awaited<ReturnType<typeof createSwitchRepository>>, choice: PullRequestChoiceFixture, attention: AttentionState | undefined = 'finished', command: GitCommand = run) {
  const targetWorktree = { ...worktree, id: `cora:${repository.targetPath}`, path: repository.targetPath, identity: repository.targetPath };
  const targetAgent = { ...agent, home: repository.targetPath, branch: 'main', attention };
  const agents = attention === undefined ? [] : [targetAgent];
  const discovery = { worktreesNow: () => [targetWorktree], refresh: async () => agents, dashboard: async () => ({ generation: 1, places: [], agents, projects: [] }) };
  const pulls = { supports: async () => true, open: async () => ({ own: [{ number: choice.number, title: 'Draft work', branch: choice.branch, headSha: choice.headSha, headOnOrigin: choice.headOnOrigin, draft: false, url: `https://github.com/octo/repo/pull/${choice.number}` }], others: [] }) };
  const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);
  return { service, targetWorktree };
}

// add staged, unstaged, and untracked source changes
async function dirtyMoveSource(sourcePath: string) {
  await writeFile(join(sourcePath, 'tracked.txt'), 'staged\n');
  await run('/usr/bin/git', ['-C', sourcePath, 'add', 'tracked.txt']);
  await writeFile(join(sourcePath, 'tracked.txt'), 'staged\nunstaged\n');
  await writeFile(join(sourcePath, 'notes.txt'), 'untracked\n');
}

// assemble one standard move service around a real repository
function moveService(repository: Awaited<ReturnType<typeof createMoveRepository>>, command: GitCommand = run, pulls: object = { supports: async () => true, open: async () => ({ own: [{ ...choices[0], headSha: repository.headSha }], others: [] }) }, targetAttention: AttentionState = 'finished', sourceAttention: AttentionState = 'finished') {
  const targetWorktree = { ...worktree, id: `cora:${repository.targetPath}`, path: repository.targetPath, identity: repository.targetPath };
  const sourceWorktree = { ...worktree, id: 'delta', projectId: 'cora', label: 'Delta', path: repository.sourcePath, identity: repository.sourcePath };
  const targetAgent = { ...agent, home: repository.targetPath, branch: 'main', attention: targetAttention };
  const sourceAgent = { ...agent, id: 'agent-2', paneId: '%2', home: repository.sourcePath, branch: 'feature/draft', worktreeId: 'delta', attention: sourceAttention };
  const discovery = {
    worktreesNow: () => [targetWorktree, sourceWorktree],
    refresh: async () => [targetAgent, sourceAgent],
    dashboard: async () => ({ generation: 1, places: [], agents: [targetAgent, sourceAgent], projects: [] })
  };
  const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);
  return { service, targetWorktree };
}

// list local branches with no pull requests, so feature/draft appears as a plain branch
const branchOnlyPulls = { supports: async () => true, open: async () => ({ own: [], others: [] }) };

describe('pull request switching', () => {
  it('finds GitHub Actions for configured worktrees and scratch repositories', async () => {
    const requested: string[] = [];
    const pulls = { actionsUrl: async (workspace: string) => { requested.push(workspace); return 'https://github.com/octo/repo/actions'; } };
    const configured = new PullRequestSwitchService(config, { worktreesNow: () => [worktree], target: async () => ({ agent, socket }) } as never, pulls as never, cleanCommand);
    const scratchAgent = { ...agent, home: '/scratch/repo' };
    const scratch = new PullRequestSwitchService(config, { worktreesNow: () => [worktree], target: async () => ({ agent: scratchAgent, socket }) } as never, pulls as never, cleanCommand);

    await expect(configured.actionsUrl(agent.id)).resolves.toBe('https://github.com/octo/repo/actions');
    await expect(scratch.actionsUrl(scratchAgent.id)).resolves.toBe('https://github.com/octo/repo/actions');
    expect(requested).toEqual([worktree.identity, scratchAgent.home]);
  });

  it('marks a pull request unavailable when another agent has its branch checked out', async () => {
    const discovery = { worktreesNow: () => [worktree, { ...worktree, id: 'delta', label: 'Delta', path: '/worktrees/delta', identity: '/worktrees/delta' }], dashboard: async () => ({ generation: 1, places: [], agents: [agent, { ...agent, id: 'agent-2', home: '/worktrees/delta', branch: 'feature/draft', worktreeId: 'delta' }], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, cleanCommand);

    await expect(service.available(worktree.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }], otherPullRequests: [], branches: [], pullRequestsSupported: true });
    await expect(service.switch(worktree.id, 7)).resolves.toEqual({ error: 'feature/draft is already checked out in Delta.' });
  });

  // reject a no-op checkout in the current worktree
  it('marks a pull request unavailable when the target worktree already has its branch checked out', async () => {
    const currentAgent = { ...agent, branch: 'feature/draft', worktreeId: worktree.id };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent: currentAgent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [currentAgent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // expose the current symbolic branch
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'feature/draft\n' };
      return await cleanCommand(_binary, args);
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { worktreeId: worktree.id, worktreeName: 'Cora' } }], otherPullRequests: [], branches: [], pullRequestsSupported: true });
    await expect(service.switch(worktree.id, 7)).resolves.toEqual({ error: 'feature/draft is already checked out in Cora.' });
  });

  // prefer the live branch over cached dashboard metadata
  it('marks the live target branch checked out when the dashboard branch is stale', async () => {
    const staleAgent = { ...agent, worktreeId: worktree.id };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent: staleAgent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [staleAgent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // expose the branch changed after dashboard caching
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'feature/draft\n' };
      return await cleanCommand(_binary, args);
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ pullRequests: [{ number: 7, checkedOut: true, openIn: { worktreeId: worktree.id, worktreeName: 'Cora' } }] });
  });

  it('matches linked worktrees whose common repository has different mount paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-pr-repository-alias-'));
    try {
      const common = join(root, 'common.git');
      const targetAlias = join(root, 'target.git');
      const sourceAlias = join(root, 'source.git');
      await mkdir(common);
      await symlink(common, targetAlias, 'dir');
      await symlink(common, sourceAlias, 'dir');
      const sourceWorktree = { ...worktree, id: 'delta', label: 'Delta', identity: '/worktrees/delta', path: '/worktrees/delta' };
      const sourceAgent = { ...agent, id: 'agent-2', home: sourceWorktree.identity, branch: 'feature/draft', worktreeId: 'delta' };
      const discovery = { worktreesNow: () => [worktree, sourceWorktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent, sourceAgent], projects: [] }) };
      const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
      const command = async (_binary: string, args: string[]) => {
        // expose two paths for one repository directory
        if (args.includes('--git-common-dir')) return { code: 0, stdout: `${args[1] === worktree.identity ? targetAlias : sourceAlias}\n` };
        return await cleanCommand(_binary, args);
      };
      const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

      await expect(service.available(worktree.id)).resolves.toMatchObject({ pullRequests: [{ number: 7, checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // preserve the newest git state after remote metadata loading
  it('checks worktree readiness after loading pull request metadata', async () => {
    let pullRequestsLoaded = false;
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = {
      supports: async () => true,
      open: async () => {
        // delay the simulated remote lookup
        await Promise.resolve();
        // finish the worktree transition
        pullRequestsLoaded = true;
        return { own: choices, others: [] };
      }
    };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      // expose the state transition to clean
      if (args.includes('status')) return { code: 0, stdout: pullRequestsLoaded ? '' : ' M apps/server/src/app.ts\n' };
      return { code: 0, stdout: 'refs/remotes/origin/feature/current\n' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ enabled: true });
  });

  it('identifies a pull request checked out in an inactive worktree', async () => {
    const deltaView = { id: 'delta', projectId: 'cora', label: 'Delta', path: '/worktrees/delta', available: true, pinned: false, main: false, detached: false, locked: false, order: 1, branch: 'feature/draft' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [{ id: 'cora', label: 'Cora', available: true, worktrees: [deltaView] }] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, cleanCommand);

    await expect(service.available(worktree.id)).resolves.toEqual({ enabled: true, pullRequests: [{ ...choices[0], checkoutBranch: 'feature/draft', checkedOut: true, openIn: { worktreeId: 'delta', worktreeName: 'Delta' } }], otherPullRequests: [], branches: [], pullRequestsSupported: true });
  });

  // list one clean local-branch payload alongside the pull requests
  function branchListingCommand(branches: string, current = 'feature/current') {
    return async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      // expose clean working state
      if (args.includes('status')) return { code: 0, stdout: '' };
      // enumerate the requested local branches
      if (args.includes('refs/heads') && args.includes('--format=%(refname:short)')) return { code: 0, stdout: branches };
      // keep the worktree switchable through a remote-tracked HEAD
      if (args.includes('--contains=HEAD')) return { code: 0, stdout: 'refs/remotes/origin/feature/current\n' };
      // expose the current branch
      if (args.includes('symbolic-ref')) return { code: 0, stdout: `${current}\n` };
      return { code: 0, stdout: '' };
    };
  }

  it('lists local branches annotated with the worktree that holds each', async () => {
    const deltaView = { id: 'delta', projectId: 'cora', label: 'Delta', path: '/worktrees/delta', available: true, pinned: false, main: false, detached: false, locked: false, order: 1, branch: 'feature/draft' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [{ id: 'cora', label: 'Cora', available: true, worktrees: [deltaView] }] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: [], others: [] }) };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, branchListingCommand('feature/current\nfeature/draft\nfeature/solo\n'));

    const availability = await service.available(worktree.id);
    expect(availability?.branches).toEqual([
      { branch: 'feature/draft', checkedOut: true, openIn: { worktreeId: 'delta', worktreeName: 'Delta' } },
      { branch: 'feature/solo', checkedOut: false }
    ]);
    expect(availability?.pullRequestsSupported).toBe(true);
  });

  it('excludes the current branch and branches already shown as pull requests', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, branchListingCommand('feature/current\nfeature/draft\nfeature/solo\n'));

    const availability = await service.available(worktree.id);
    // feature/current is the target branch; feature/draft is pull request #7
    expect(availability?.branches).toEqual([{ branch: 'feature/solo', checkedOut: false }]);
  });

  it('caps the local-branch list for repositories with very many branches', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: [], others: [] }) };
    const listing = Array.from({ length: 250 }, (_value, index) => `feature/branch-${index}`).join('\n');
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, branchListingCommand(listing));

    const availability = await service.available(worktree.id, false);
    expect(availability?.branches).toHaveLength(200);
  });

  // optional history reads must not hold checkout choices hostage
  it('returns every branch with fresh readiness when the summary budget expires', async () => {
    const discovery = { worktreesNow: () => [worktree], dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] }) };
    const pulls = { supports: async () => false };
    const listing = Array.from({ length: 200 }, (_value, index) => `feature/branch-${index}`).join('\n');
    let dirty = false;
    const listBranches = branchListingCommand(listing);
    // change working state while optional summaries are loading
    const command: GitCommand = async (binary, args) => args.includes('status')
      ? { code: 0, stdout: dirty ? ' M tracked.txt\n' : '' }
      : await listBranches(binary, args);
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);
    vi.useFakeTimers();
    // finish successfully at the subprocess deadline to exercise the next-command guard
    const history = vi.spyOn(commands, 'run').mockImplementation((_binary, _args, _input, timeoutMs = 5_000) => new Promise(resolve => {
      setTimeout(() => { dirty = true; resolve({ code: 0, stdout: '', stderr: '' }); }, timeoutMs);
    }));
    try {
      let returned = false;
      // observe completion without awaiting a stuck request
      const availability = service.available(worktree.id).then(value => { returned = true; return value; });
      await vi.waitFor(() => { expect(history).toHaveBeenCalledTimes(4); });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(returned).toBe(true);
      const listed = await availability;
      expect(listed?.enabled).toBe(false);
      expect(listed?.branches).toHaveLength(200);
      expect(listed?.branches.every(branch => branch.commitSummary === undefined)).toBe(true);
      // no active pipeline or later batch may resume after the response
      await vi.advanceTimersByTimeAsync(10_000);
      expect(history).toHaveBeenCalledTimes(4);
      expect(listed?.branches.every(branch => branch.commitSummary === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
      history.mockRestore();
    }
  });

  it('returns local branches with pull requests unsupported when there is no GitHub origin', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    // fail closed if the GitHub-only path is ever queried
    const pulls = { supports: async () => false, open: async () => { throw new Error('GitHub must not be queried without a supported origin'); } };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, branchListingCommand('feature/current\nfeature/solo\n'));

    await expect(service.available(worktree.id)).resolves.toEqual({ enabled: true, pullRequests: [], otherPullRequests: [], branches: [{ branch: 'feature/solo', checkedOut: false }], pullRequestsSupported: false });
  });

  it('returns undefined when the target worktree is not a git checkout', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => false, open: async () => { throw new Error('unused'); } };
    // reject an unreadable repository identity before any listing
    const command = async (_binary: string, args: string[]) => args.includes('--git-common-dir') ? { code: 128, stdout: '' } : { code: 0, stdout: '' };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toBeUndefined();
  });

  it('ignores matching branch names from another repository', async () => {
    const otherWorktree = { ...worktree, id: 'delta', label: 'Delta', path: '/worktrees/delta', identity: '/worktrees/delta' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [{ ...agent, id: 'agent-2', home: otherWorktree.identity, branch: 'feature/draft', worktreeId: 'delta' }], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // separate repository identities by worktree path
      if (args.includes('--git-common-dir')) return { code: 0, stdout: args[1] === worktree.identity ? '/repositories/target/.git\n' : '/repositories/source/.git\n' };
      return await cleanCommand(_binary, args);
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ pullRequests: [{ number: 7, checkedOut: false }] });
    await expect(service.move(worktree.id, 7)).resolves.toBe('unavailable');
  });

  it('moves an occupied pull request here and recovers every source change', async () => {
    const repository = await createMoveRepository();
    try {
      await writeFile(join(repository.targetPath, 'tracked.txt'), 'existing stash\n');
      await run('/usr/bin/git', ['-C', repository.targetPath, 'stash', 'push', '--message', 'existing backup']);
      await dirtyMoveSource(repository.sourcePath);
      const { service, targetWorktree } = moveService(repository);

      await expect(service.move(targetWorktree.id, 7)).resolves.toBe('moved');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'symbolic-ref', '--quiet', 'HEAD'])).resolves.toMatchObject({ code: 1 });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: '' });
      await expect(readFile(join(repository.targetPath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
      await expect(readFile(join(repository.targetPath, 'notes.txt'), 'utf8')).resolves.toBe('untracked\n');
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: 'MM tracked.txt\n?? notes.txt\n' });
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'stash', 'list'])).resolves.toMatchObject({ stdout: expect.stringContaining('existing backup') });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('restores the source branch and changes when the target checkout fails', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const command = async (binary: string, args: string[]) => {
        // fail only the destination checkout
        if (args[1] === repository.targetPath && args[2] === 'switch' && args.at(-1) === 'feature/draft') return { code: 1, stdout: '' };
        return await run(binary, args);
      };
      const { service, targetWorktree } = moveService(repository, command);

      await expect(service.move(targetWorktree.id, 7)).resolves.toBe('unavailable');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(readFile(join(repository.sourcePath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
      await expect(readFile(join(repository.sourcePath, 'notes.txt'), 'utf8')).resolves.toBe('untracked\n');
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: 'MM tracked.txt\n?? notes.txt\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list'])).resolves.toMatchObject({ stdout: '' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('revalidates a source branch that moved before the transaction', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      // the source branch changed since the availability snapshot
      await run('/usr/bin/git', ['-C', repository.sourcePath, 'switch', '-c', 'feature/other']);
      const { service, targetWorktree } = moveService(repository);

      await expect(service.move(targetWorktree.id, 7)).resolves.toBe('unavailable');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/other\n' });
      await expect(readFile(join(repository.sourcePath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list'])).resolves.toMatchObject({ stdout: '' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('never applies an existing stash when the dirty state cannot be stashed', async () => {
    const repository = await createMoveRepository(true);
    try {
      await writeFile(join(repository.targetPath, 'tracked.txt'), 'existing stash\n');
      await run('/usr/bin/git', ['-C', repository.targetPath, 'stash', 'push', '--message', 'existing backup']);
      await writeFile(join(repository.sourcePath, 'module', 'module.txt'), 'dirty module\n');
      const { service, targetWorktree } = moveService(repository);

      await expect(service.move(targetWorktree.id, 7)).resolves.toBe('unavailable');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(readFile(join(repository.sourcePath, 'module', 'module.txt'), 'utf8')).resolves.toBe('dirty module\n');
      const stashes = await run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list']);
      expect(stashes.stdout.match(/^stash@/gmu)).toHaveLength(1);
      expect(stashes.stdout).toContain('existing backup');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports recovery-required when rollback cannot restore the source branch', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const command = async (binary: string, args: string[]) => {
        // fail destination checkout and source rollback
        if (args[2] === 'switch' && args.at(-1) === 'feature/draft') return { code: 1, stdout: '' };
        return await run(binary, args);
      };
      const { service, targetWorktree } = moveService(repository, command);

      await expect(service.move(targetWorktree.id, 7)).resolves.toBe('recovery-required');

      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'symbolic-ref', '--quiet', 'HEAD'])).resolves.toMatchObject({ code: 1 });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list', '--format=%gs'])).resolves.toMatchObject({ stdout: expect.stringMatching(/rac move \S+ feature\/draft/) });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports recovery-required when a created stash cannot be identified', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const command = async (binary: string, args: string[]) => {
        // hide the newly created stash from exact recovery tracking
        if (args[1] === repository.sourcePath && args[2] === 'stash' && args[3] === 'list' && args.includes('--format=%H%x09%gs')) return { code: 1, stdout: '' };
        return await run(binary, args);
      };
      const { service, targetWorktree } = moveService(repository, command);

      await expect(service.move(targetWorktree.id, 7)).resolves.toBe('recovery-required');

      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: '' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list', '--format=%gs'])).resolves.toMatchObject({ stdout: expect.stringMatching(/rac move \S+ feature\/draft/) });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('checks out a head-on-origin pull request in-process without touching a pane', async () => {
    const repository = await createSwitchRepository();
    try {
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true });

      await expect(service.switch(targetWorktree.id, 7)).resolves.toBe('switched');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'rev-parse', 'HEAD'])).resolves.toMatchObject({ stdout: `${repository.draftSha}\n` });
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: '' });
      // a head-on-origin checkout tracks the origin branch (--track)
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'config', '--get', 'branch.feature/draft.remote'])).resolves.toMatchObject({ code: 0, stdout: 'origin\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses a head-on-origin pull request whose origin advanced past the reviewed head', async () => {
    const repository = await createSwitchRepository();
    try {
      // origin's branch moves beyond the SHA the service is told to pin
      await run('/usr/bin/git', ['-C', repository.originPath, 'switch', 'feature/draft']);
      await writeFile(join(repository.originPath, 'draft.txt'), 'advanced\n');
      await run('/usr/bin/git', ['-C', repository.originPath, 'commit', '-am', 'advance draft']);
      await run('/usr/bin/git', ['-C', repository.originPath, 'switch', 'main']);
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true });

      await expect(service.switch(targetWorktree.id, 7)).resolves.toEqual({ error: 'Pull request #7 changed on GitHub after it was listed. Reopen the list and try again.' });

      // the fetched ref no longer matches the reviewed head, so the checkout is refused and HEAD stays
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('checks out a SHA-pinned pull request ref in-process without touching a pane', async () => {
    const repository = await createSwitchRepository();
    try {
      const { service, targetWorktree } = switchService(repository, { number: 8, branch: 'main', headSha: repository.prSha, headOnOrigin: false });
      const checkoutBranch = `rac/pr/8/${repository.prSha.slice(0, 12)}`;

      await expect(service.switch(targetWorktree.id, 8)).resolves.toBe('switched');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: `${checkoutBranch}\n` });
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'rev-parse', 'HEAD'])).resolves.toMatchObject({ stdout: `${repository.prSha}\n` });
      // a pull-request-ref checkout is detached from origin tracking (--no-track)
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'config', '--get', `branch.${checkoutBranch}.remote`])).resolves.toMatchObject({ code: 1, stdout: '' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('plain-switches to a local branch in-process without touching a pane', async () => {
    const repository = await createSwitchRepository();
    try {
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true });

      await expect(service.switchBranch(targetWorktree.id, 'feature/solo')).resolves.toBe('switched');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/solo\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('lists and switches branches in a worktree with no agent', async () => {
    const repository = await createSwitchRepository();
    try {
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true }, undefined);

      await expect(service.available(targetWorktree.id)).resolves.toMatchObject({ enabled: true, pullRequests: [{ number: 7, checkedOut: false }], branches: [{ branch: 'feature/solo', checkedOut: false }] });
      await expect(service.switchBranch(targetWorktree.id, 'feature/solo')).resolves.toBe('switched');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/solo\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  // enrich a checked-out local branch from the worktree that owns its creation reflog
  it.each([true, false])('lists the oldest unique commit summary in another worktree with agent worktree id: %s', async hasWorktreeId => {
    const repository = await createMoveRepository();
    try {
      await run('/usr/bin/git', ['-C', repository.sourcePath, 'commit', '--allow-empty', '-m', 'source-only base']);
      await run('/usr/bin/git', ['-C', repository.sourcePath, 'switch', '-c', 'feature/summary']);
      await run('/usr/bin/git', ['-C', repository.sourcePath, 'commit', '--allow-empty', '-m', 'first summary line\ncontinued same paragraph']);
      await run('/usr/bin/git', ['-C', repository.sourcePath, 'commit', '--allow-empty', '-m', 'newest summary commit']);
      const targetWorktree = { ...worktree, id: `cora:${repository.targetPath}`, path: repository.targetPath, identity: repository.targetPath, defaultBranch: 'main' };
      const sourceWorktree = { ...worktree, id: 'delta', projectId: 'cora', label: 'Delta', path: repository.sourcePath, identity: repository.sourcePath, defaultBranch: 'main' };
      const targetAgent = { ...agent, home: repository.targetPath, branch: 'main' };
      const sourceAgent = { ...agent, id: 'agent-2', home: repository.sourcePath, branch: 'feature/summary', ...(hasWorktreeId ? { worktreeId: 'delta' } : {}) };
      const discovery = {
        worktreesNow: () => [targetWorktree, sourceWorktree],
        dashboard: async () => ({ generation: 1, places: [], agents: [targetAgent, sourceAgent], projects: [] })
      };
      const service = new PullRequestSwitchService(config, discovery as never, branchOnlyPulls as never, run);

      const listed = await service.available(targetWorktree.id);
      expect(listed?.branches.find(candidate => candidate.branch === 'feature/summary')).toEqual({
        branch: 'feature/summary',
        checkedOut: true,
        ...(hasWorktreeId ? { openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } } : {}),
        commitSummary: { subject: 'first summary line', count: 2 }
      });
      const revalidated = await service.available(targetWorktree.id, false);
      expect(revalidated?.branches.find(candidate => candidate.branch === 'feature/summary')?.commitSummary).toBeUndefined();
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reuses an existing local branch when it already matches the reviewed head', async () => {
    const repository = await createSwitchRepository();
    try {
      // a local branch already at the reviewed head is switched to, not recreated
      await run('/usr/bin/git', ['-C', repository.targetPath, 'branch', 'feature/draft', repository.draftSha]);
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true });

      await expect(service.switch(targetWorktree.id, 7)).resolves.toBe('switched');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'rev-parse', 'HEAD'])).resolves.toMatchObject({ stdout: `${repository.draftSha}\n` });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses to reuse a local branch that diverges from the reviewed head', async () => {
    const repository = await createSwitchRepository();
    try {
      // a stale local branch off the reviewed head must not be checked out silently
      await run('/usr/bin/git', ['-C', repository.targetPath, 'branch', 'feature/draft', 'main']);
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true });

      await expect(service.switch(targetWorktree.id, 7)).resolves.toEqual({ error: 'The local branch feature/draft differs from the pull request head. Update or delete it, then try again.' });

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports why the pull request fetch failed and leaves the branch', async () => {
    const repository = await createSwitchRepository();
    try {
      const command: GitCommand = async (binary, args) => {
        if (args.includes('fetch')) return { code: 128, stdout: '', stderr: 'Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf\nfatal: Could not read from remote repository.\n' };
        return await run(binary, args);
      };
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true }, 'finished', command);

      await expect(service.switch(targetWorktree.id, 7)).resolves.toEqual({ error: 'Pull request #7 could not be fetched from origin. git fetch failed: Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf' });

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports git\'s reason and leaves the branch when git switch fails', async () => {
    const repository = await createSwitchRepository();
    try {
      const command: GitCommand = async (binary, args) => {
        // fail the local checkout while leaving availability reads intact
        if (args[2] === 'switch' && args.at(-1) === 'feature/solo') return { code: 128, stdout: '', stderr: 'fatal: invalid reference: feature/solo\n' };
        return await run(binary, args);
      };
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true }, 'finished', command);

      await expect(service.switchBranch(targetWorktree.id, 'feature/solo')).resolves.toEqual({ error: 'git switch failed: invalid reference: feature/solo' });

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses every checkout while the target agent is working and changes nothing', async () => {
    const repository = await createSwitchRepository();
    try {
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true }, 'working');

      await expect(service.switch(targetWorktree.id, 7)).resolves.toBe('busy');
      await expect(service.switchBranch(targetWorktree.id, 'feature/solo')).resolves.toBe('busy');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses a move while an involved agent is working and changes nothing', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      // a working destination blocks the move even though the source is idle
      const move = moveService(repository, run, undefined, 'working');
      await expect(move.service.move(move.targetWorktree.id, 7)).resolves.toBe('busy');
      // a working source blocks it too
      const busySource = moveService(repository, run, undefined, 'finished', 'working');
      await expect(busySource.service.move(busySource.targetWorktree.id, 7)).resolves.toBe('busy');
      // the branch move honours the same gate
      const branchMove = moveService(repository, run, branchOnlyPulls, 'working');
      await expect(branchMove.service.moveBranch(branchMove.targetWorktree.id, 'feature/draft')).resolves.toBe('busy');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(readFile(join(repository.sourcePath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps switching disabled when the working tree is dirty', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      // uncommitted changes must still block the switch
      if (args.includes('status')) return { code: 0, stdout: ' M tracked.txt\n' };
      return { code: 0, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ enabled: false });
  });

  it('allows switching when HEAD is pushed to a remote branch without a configured upstream', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('for-each-ref')) return { code: 0, stdout: 'refs/remotes/origin/main\n' };
      return { code: 128, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ enabled: true });
  });

  it('allows switching from a clean detached HEAD without requiring a remote ref', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('symbolic-ref')) return { code: 1, stdout: '' };
      return { code: 0, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ enabled: true });
  });

  it('allows switching from a clean branch whose configured upstream is gone', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'refs/heads/feature/merged\n' };
      if (args.includes('--contains=HEAD')) return { code: 0, stdout: '' };
      if (args.includes('--format=%(upstream:track)')) return { code: 0, stdout: '[gone]\n' };
      return { code: 0, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ enabled: true });
  });

  it('enables switching from a clean branch that is not yet pushed', async () => {
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [] }) };
    const command = async (_binary: string, args: string[]) => {
      // share one fake repository identity
      if (args.includes('--git-common-dir')) return commonRepositoryResult;
      // clean tree on a named branch whose commits are not on any origin ref
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'refs/heads/feature/unpushed\n' };
      if (args.includes('--contains=HEAD')) return { code: 0, stdout: '' };
      if (args.includes('--format=%(upstream:track)')) return { code: 0, stdout: '[ahead 1]\n' };
      return { code: 0, stdout: '' };
    };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, command);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ enabled: true });
  });

  it('returns and switches pull requests by other authors', async () => {
    const otherHeadSha = 'b'.repeat(40);
    const other = { number: 8, title: 'Other work', branch: 'main', headSha: otherHeadSha, headOnOrigin: false, draft: false, url: 'https://github.com/octo/repo/pull/8' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent, { ...agent, id: 'agent-2', branch: 'main' }], projects: [] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: choices, others: [other] }) };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, cleanCommand);

    await expect(service.available(worktree.id)).resolves.toMatchObject({ pullRequests: [{ number: 7 }], otherPullRequests: [{ number: 8, branch: 'main', checkoutBranch: `rac/pr/8/${otherHeadSha.slice(0, 12)}`, checkedOut: false }] });
  });

  it('rejects a branch outside the availability list without a git mutation', async () => {
    const repository = await createSwitchRepository();
    try {
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true });

      // feature/missing is unlisted; feature/draft is offered only as pull request #7; main is the current branch
      await expect(service.switchBranch(targetWorktree.id, 'feature/missing')).resolves.toEqual({ error: 'feature/missing is not a local branch that can be checked out here.' });
      await expect(service.switchBranch(targetWorktree.id, 'feature/draft')).resolves.toEqual({ error: 'feature/draft is not a local branch that can be checked out here.' });
      await expect(service.switchBranch(targetWorktree.id, '')).resolves.toEqual({ error: 'No branch was named.' });
      await expect(service.moveBranch(targetWorktree.id, 'feature/missing')).resolves.toBe('unavailable');
      // feature/solo is open nowhere, so it can only be switched, never moved
      await expect(service.moveBranch(targetWorktree.id, 'feature/solo')).resolves.toBe('unavailable');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'main\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects a plain switch to a branch open in another worktree', async () => {
    const deltaView = { id: 'delta', projectId: 'cora', label: 'Delta', path: '/worktrees/delta', available: true, pinned: false, main: false, detached: false, locked: false, order: 1, branch: 'feature/draft' };
    const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }), dashboard: async () => ({ generation: 1, places: [], agents: [agent], projects: [{ id: 'cora', label: 'Cora', available: true, worktrees: [deltaView] }] }) };
    const pulls = { supports: async () => true, open: async () => ({ own: [], others: [] }) };
    const service = new PullRequestSwitchService(config, discovery as never, pulls as never, branchListingCommand('feature/current\nfeature/draft\nfeature/solo\n'));

    // feature/draft is open in another worktree, so it must be moved, never plain-switched
    await expect(service.switchBranch(worktree.id, 'feature/draft')).resolves.toEqual({ error: 'feature/draft is already checked out in Delta.' });
  });

  it('moves an occupied local branch here and recovers a dirty source', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      const { service, targetWorktree } = moveService(repository, run, branchOnlyPulls);

      await expect(service.moveBranch(targetWorktree.id, 'feature/draft')).resolves.toBe('moved');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'symbolic-ref', '--quiet', 'HEAD'])).resolves.toMatchObject({ code: 1 });
      await expect(readFile(join(repository.targetPath, 'tracked.txt'), 'utf8')).resolves.toBe('staged\nunstaged\n');
      await expect(readFile(join(repository.targetPath, 'notes.txt'), 'utf8')).resolves.toBe('untracked\n');
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: 'MM tracked.txt\n?? notes.txt\n' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('moves an occupied local branch here from a clean source', async () => {
    const repository = await createMoveRepository();
    try {
      const { service, targetWorktree } = moveService(repository, run, branchOnlyPulls);

      await expect(service.moveBranch(targetWorktree.id, 'feature/draft')).resolves.toBe('moved');

      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'branch', '--show-current'])).resolves.toMatchObject({ stdout: 'feature/draft\n' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'symbolic-ref', '--quiet', 'HEAD'])).resolves.toMatchObject({ code: 1 });
      await expect(run('/usr/bin/git', ['-C', repository.targetPath, 'status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: '' });
      await expect(run('/usr/bin/git', ['-C', repository.sourcePath, 'stash', 'list'])).resolves.toMatchObject({ stdout: '' });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects a branch mutation while a pull request switch holds the shared lock', async () => {
    const repository = await createSwitchRepository();
    try {
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let blocked = false;
      // hold the lock across an await by stalling the switch's fetch
      const command: GitCommand = async (binary, args) => {
        if (!blocked && args.includes('fetch')) { blocked = true; started(); await gate; }
        return await run(binary, args);
      };
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true }, 'finished', command);

      const switching = service.switch(targetWorktree.id, 7);
      await startedPromise;
      // the shared branchMutation lock rejects an overlapping branch switch that would otherwise succeed
      await expect(service.switchBranch(targetWorktree.id, 'feature/solo')).resolves.toEqual({ error: 'Another branch checkout or move is already running. Try again when it finishes.' });
      release();
      await expect(switching).resolves.toBe('switched');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects a pull request mutation while a branch switch holds the shared lock', async () => {
    const repository = await createSwitchRepository();
    try {
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let blocked = false;
      // stall the plain switch's checkout so its lock stays held
      const command: GitCommand = async (binary, args) => {
        if (!blocked && args[2] === 'switch' && args.at(-1) === 'feature/solo') { blocked = true; started(); await gate; }
        return await run(binary, args);
      };
      const { service, targetWorktree } = switchService(repository, { number: 7, branch: 'feature/draft', headSha: repository.draftSha, headOnOrigin: true }, 'finished', command);

      const switching = service.switchBranch(targetWorktree.id, 'feature/solo');
      await startedPromise;
      // the same lock rejects an overlapping pull request switch that would otherwise succeed, proving it is shared both ways
      await expect(service.switch(targetWorktree.id, 7)).resolves.toEqual({ error: 'Another branch checkout or move is already running. Try again when it finishes.' });
      release();
      await expect(switching).resolves.toBe('switched');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects an overlapping pull request move while a move holds the shared lock', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let blocked = false;
      // stall the in-flight move at its first source read (before any mutation) so its lock stays held
      const command: GitCommand = async (binary, args) => {
        if (!blocked && args[1] === repository.sourcePath && args.includes('symbolic-ref')) { blocked = true; started(); await gate; }
        return await run(binary, args);
      };
      const { service, targetWorktree } = moveService(repository, command);

      const moving = service.move(targetWorktree.id, 7);
      await startedPromise;
      // without the lock the second move would proceed into the transaction and race; the lock rejects it
      await expect(service.move(targetWorktree.id, 7)).resolves.toBe('unavailable');
      release();
      await expect(moving).resolves.toBe('moved');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects an overlapping branch move while a branch move holds the shared lock', async () => {
    const repository = await createMoveRepository();
    try {
      await dirtyMoveSource(repository.sourcePath);
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let blocked = false;
      const command: GitCommand = async (binary, args) => {
        if (!blocked && args[1] === repository.sourcePath && args.includes('symbolic-ref')) { blocked = true; started(); await gate; }
        return await run(binary, args);
      };
      const { service, targetWorktree } = moveService(repository, command, branchOnlyPulls);

      const moving = service.moveBranch(targetWorktree.id, 'feature/draft');
      await startedPromise;
      await expect(service.moveBranch(targetWorktree.id, 'feature/draft')).resolves.toBe('unavailable');
      release();
      await expect(moving).resolves.toBe('moved');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  }, 15_000);
});
