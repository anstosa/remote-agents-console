import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PullRequestSwitchService } from '../src/pull-requests/switch-service.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import type { AttentionState } from '../src/adapters/types.js';

const exec = promisify(execFile);
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen: { host: '127.0.0.1', port: 8787 }, publicOrigin: new URL('https://agents.example.com'), trustedProxyIps: new Set(), pollIntervalMs: 500, adapters: {}, projects: [] };
const octo = { owner: 'octo', name: 'repo' };
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('/usr/bin/git', ['-C', cwd, ...args])).stdout.trim();
}

async function commit(cwd: string, file: string, content: string, message: string, ...flags: string[]): Promise<string> {
  await writeFile(join(cwd, file), content);
  await git(cwd, 'add', file);
  await git(cwd, 'commit', '-q', ...flags, '-m', message);
  return await git(cwd, 'rev-parse', 'HEAD');
}

// a bare origin; the author's clone, which pushes `feature` (PR #7); and the reviewer's Worktree,
// a clone with `feature` checked out tracking origin/feature
async function repositories() {
  const root = await mkdtemp(join(tmpdir(), 'rac-update-head-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const author = join(root, 'author');
  const target = join(root, 'target');
  await exec('/usr/bin/git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await exec('/usr/bin/git', ['clone', '-q', origin, author]);
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) await git(author, 'config', key!, value!);
  await commit(author, 'base.txt', 'base\n', 'base');
  await git(author, 'push', '-q', 'origin', 'HEAD:main');
  await git(author, 'switch', '-q', '-c', 'feature');
  const reviewed = await commit(author, 'feature.txt', 'one\n', 'feature');
  await git(author, 'push', '-q', '-u', 'origin', 'feature');
  await exec('/usr/bin/git', ['clone', '-q', origin, target]);
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) await git(target, 'config', key!, value!);
  await git(target, 'switch', '-q', 'feature');
  return { root, origin, author, target, reviewed };
}

type Detail = { number: number; branch: string; headSha: string; headOnOrigin: boolean; state?: 'open' | 'closed' | 'merged' };

// the switch service over the reviewer's Worktree, with GitHub answering `detail` for its pull request
function updater(target: string, detail: () => Detail, attention?: AttentionState) {
  const worktree = { id: `cora:${target}`, projectId: 'cora', label: 'Cora', path: target, identity: target, available: true, pinned: true, main: true, detached: false, locked: false };
  const agents = attention === undefined ? [] : [{ id: 'agent-1', pane: { paneId: '%1', sessionId: '$1', socketFingerprint: 'socket' }, home: target, branch: 'feature', title: 'Ready', attention }];
  const discovery = { worktreesNow: () => [worktree], refresh: async () => agents, dashboard: async () => ({ generation: 1, places: [], agents, projects: [] }) };
  const github = {
    repositoryAt: async () => octo,
    branch: async () => ({ pullRequest: { number: detail().number, title: 'Feature', status: 'open', url: 'https://github.com/octo/repo/pull/7' } }),
    pullRequestDetail: async () => ({ pullRequest: { title: 'Feature', url: 'https://github.com/octo/repo/pull/7', draft: false, checks: 'none', state: 'open', ...detail() } })
  };
  return { service: new PullRequestSwitchService(config, discovery as never, github as never), worktreeId: worktree.id };
}

describe('updating a Worktree to its pull request head', () => {
  it('fast-forwards the branch when the pull request only gained commits', async () => {
    const repo = await repositories();
    const head = await commit(repo.author, 'feature.txt', 'one\ntwo\n', 'more');
    await git(repo.author, 'push', '-q', 'origin', 'feature');
    const { service, worktreeId } = updater(repo.target, () => ({ number: 7, branch: 'feature', headSha: head, headOnOrigin: true }));

    await expect(service.updateToHead(worktreeId)).resolves.toBe('switched');

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(repo.target, 'branch', '--show-current')).toBe('feature');
    expect(await git(repo.target, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature');
  }, 20_000);

  // the author amends the reviewed commit and force-pushes it
  async function forcePush(repo: Awaited<ReturnType<typeof repositories>>): Promise<string> {
    const head = await commit(repo.author, 'feature.txt', 'one, amended\n', 'feature', '--amend');
    await git(repo.author, 'push', '-q', '--force', 'origin', 'feature');
    return head;
  }
  const feature = (headSha: string): Detail => ({ number: 7, branch: 'feature', headSha, headOnOrigin: true });

  it('resets the branch to a force-pushed head when every commit on it was on origin', async () => {
    const repo = await repositories();
    const head = await forcePush(repo);
    const { service, worktreeId } = updater(repo.target, () => feature(head));

    await expect(service.updateToHead(worktreeId)).resolves.toBe('switched');

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(repo.target, 'feature.txt'), 'utf8')).toBe('one, amended\n');
    expect(await git(repo.target, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(await git(repo.target, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature');
  }, 20_000);

  it('still resets after a plain fetch already moved origin/feature to the force-pushed head', async () => {
    const repo = await repositories();
    const head = await forcePush(repo);
    await git(repo.target, 'fetch', '-q', 'origin');
    const { service, worktreeId } = updater(repo.target, () => feature(head));

    await expect(service.updateToHead(worktreeId)).resolves.toBe('switched');

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(head);
  }, 20_000);

  it.each([
    ['a staged change', async (target: string) => { await writeFile(join(target, 'feature.txt'), 'staged\n'); await git(target, 'add', 'feature.txt'); }],
    ['an unstaged change', async (target: string) => { await writeFile(join(target, 'feature.txt'), 'unstaged\n'); }],
    ['an untracked file', async (target: string) => { await writeFile(join(target, 'notes.txt'), 'mine\n'); }]
  ])('refuses with %s and changes nothing, not even origin/feature', async (_name, dirty) => {
    const repo = await repositories();
    const head = await forcePush(repo);
    await dirty(repo.target);
    const status = await git(repo.target, 'status', '--porcelain=v1', '--untracked-files=all');
    const { service, worktreeId } = updater(repo.target, () => feature(head));

    await expect(service.updateToHead(worktreeId)).resolves.toEqual({ error: 'The worktree has uncommitted changes. Commit or stash them, then try again.' });

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(repo.reviewed);
    expect(await git(repo.target, 'rev-parse', 'origin/feature')).toBe(repo.reviewed);
    expect(await git(repo.target, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(status);
  }, 20_000);

  it.each([
    ['the author force-pushed', forcePush],
    ['the author pushed more', async (repo: Awaited<ReturnType<typeof repositories>>) => {
      const head = await commit(repo.author, 'other.txt', 'more\n', 'more');
      await git(repo.author, 'push', '-q', 'origin', 'feature');
      return head;
    }]
  ])('refuses a branch with a local commit that was never pushed when %s', async (_name, move) => {
    const repo = await repositories();
    const local = await commit(repo.target, 'local.txt', 'local work\n', 'local work');
    const head = await move(repo);
    const { service, worktreeId } = updater(repo.target, () => feature(head));

    await expect(service.updateToHead(worktreeId)).resolves.toEqual({ error: 'feature has commits that are not on the pull request. Push them or move them to another branch, then update.' });

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(local);
    expect(await readFile(join(repo.target, 'local.txt'), 'utf8')).toBe('local work\n');
  }, 20_000);

  it('resets a branch whose own commit was pushed before the author force-pushed over it', async () => {
    const repo = await repositories();
    await commit(repo.target, 'local.txt', 'pushed work\n', 'pushed work');
    await git(repo.target, 'push', '-q', 'origin', 'feature');
    const head = await forcePush(repo);
    const { service, worktreeId } = updater(repo.target, () => feature(head));

    await expect(service.updateToHead(worktreeId)).resolves.toBe('switched');

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(head);
  }, 20_000);

  it('refuses while the Worktree\'s agent is working', async () => {
    const repo = await repositories();
    const head = await forcePush(repo);
    const { service, worktreeId } = updater(repo.target, () => feature(head), 'working');

    await expect(service.updateToHead(worktreeId)).resolves.toBe('busy');

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(repo.reviewed);
  }, 20_000);

  it('refuses when the pull request moved on after GitHub was read', async () => {
    const repo = await repositories();
    const listed = await forcePush(repo);
    await commit(repo.author, 'feature.txt', 'newer\n', 'newer');
    await git(repo.author, 'push', '-q', 'origin', 'feature');
    const { service, worktreeId } = updater(repo.target, () => feature(listed));

    await expect(service.updateToHead(worktreeId)).resolves.toEqual({ error: 'Pull request #7 changed on GitHub after it was listed. Reopen the list and try again.' });

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(repo.reviewed);
  }, 20_000);

  it('answers a branch already at the head without touching it, and refuses a second update while one runs', async () => {
    const repo = await repositories();
    const { service, worktreeId } = updater(repo.target, () => feature(repo.reviewed));

    const [first, second] = await Promise.all([service.updateToHead(worktreeId), service.updateToHead(worktreeId)]);

    expect(first).toBe('switched');
    expect(second).toEqual({ error: 'Another branch checkout or move is already running. Try again when it finishes.' });
  }, 20_000);

  it('refuses a fork checkout without fetching its new head', async () => {
    const repo = await repositories();
    await git(repo.author, 'push', '-q', 'origin', `${repo.reviewed}:refs/pull/8/head`);
    const old = `rac/pr/8/${repo.reviewed.slice(0, 12)}`;
    await git(repo.target, 'switch', '-q', '--no-track', '-c', old, repo.reviewed);
    const head = await forcePush(repo);
    await git(repo.author, 'push', '-q', '--force', 'origin', `${head}:refs/pull/8/head`);
    const { service, worktreeId } = updater(repo.target, () => ({ number: 8, branch: 'main', headSha: head, headOnOrigin: false }));

    await expect(service.updateToHead(worktreeId)).resolves.toEqual({ error: `${old} has no open pull request from a branch on origin.` });

    expect(await git(repo.target, 'branch', '--show-current')).toBe(old);
    expect(await git(repo.target, 'for-each-ref', 'refs/rac')).toBe('');
  }, 20_000);

  it('refuses a branch whose pull request is headed in a fork, even under the same name', async () => {
    const repo = await repositories();
    const head = await forcePush(repo);
    const { service, worktreeId } = updater(repo.target, () => ({ ...feature(head), headOnOrigin: false }));

    await expect(service.updateToHead(worktreeId)).resolves.toEqual({ error: 'feature has no open pull request from a branch on origin.' });

    expect(await git(repo.target, 'rev-parse', 'HEAD', 'origin/feature')).toBe(`${repo.reviewed}\n${repo.reviewed}`);
  }, 20_000);

  it('resets on the value origin/feature had before the fetch when the repository keeps no reflog', async () => {
    const repo = await repositories();
    await git(repo.target, 'config', 'core.logAllRefUpdates', 'false');
    const pushed = await commit(repo.author, 'feature.txt', 'one\ntwo\n', 'more');
    await git(repo.author, 'push', '-q', 'origin', 'feature');
    await git(repo.target, 'pull', '-q', '--ff-only');
    expect(await git(repo.target, 'log', '--walk-reflogs', '--format=%H', 'refs/remotes/origin/feature', '--')).toBe('');
    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(pushed);
    const head = await forcePush(repo);
    const { service, worktreeId } = updater(repo.target, () => feature(head));

    await expect(service.updateToHead(worktreeId)).resolves.toBe('switched');

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(head);
  }, 20_000);

  it('refuses a pull request headed by a branch of another name', async () => {
    const repo = await repositories();
    const head = await forcePush(repo);
    const { service, worktreeId } = updater(repo.target, () => ({ ...feature(head), branch: 'other' }));

    await expect(service.updateToHead(worktreeId)).resolves.toEqual({ error: 'feature has no open pull request from a branch on origin.' });

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(repo.reviewed);
  }, 20_000);

  it('refuses a head that adds a file this Worktree holds as an ignored file', async () => {
    const repo = await repositories();
    await writeFile(join(repo.target, '.git', 'info', 'exclude'), '.env\n');
    await writeFile(join(repo.target, '.env'), 'SECRET=mine\n');
    const head = await commit(repo.author, '.env', 'SECRET=example\n', 'add an example env');
    await git(repo.author, 'push', '-q', 'origin', 'feature');
    const { service, worktreeId } = updater(repo.target, () => feature(head));

    await expect(service.updateToHead(worktreeId)).resolves.toEqual({ error: 'The pull request head adds .env, which would overwrite an ignored file or folder here. Move it aside, then update.' });

    expect(await git(repo.target, 'rev-parse', 'HEAD')).toBe(repo.reviewed);
    expect(await readFile(join(repo.target, '.env'), 'utf8')).toBe('SECRET=mine\n');
  }, 20_000);
});
