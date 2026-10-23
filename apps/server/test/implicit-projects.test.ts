import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { implicitProject, validateConfig } from '../src/config/schema.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { run } from '../src/tmux/command.js';
import type { Pane } from '../src/domain/models.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';
import { testProject } from './helpers/config.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => { const result = await run('/usr/bin/git', ['-C', cwd, ...args]); if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`); };

// a realpath'd temp folder holding a git repository `name` with one commit
async function gitRepo(name = 'ferry'): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-implicit-')));
  dirs.push(root);
  const repo = join(root, name);
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'readme.md'), 'hi\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
  return { root, repo };
}

const noPullRequests = { cachedPullRequest: async () => undefined, invalidateRepositories: () => {} };
// a discovery over one agent pane in `path`, session `$0`, optionally already marked
function discovery(path: string, options: { mark?: string; projects?: Parameters<typeof testProject>[0][]; pins?: Record<string, boolean>; scratchDirectory?: string; panes?: Partial<Pane>[] } = {}) {
  const tmux = paneLister(options.panes ?? [{ paneId: '%1', sessionId: '$0', pid: 123, path, title: 'Agent' }]);
  if (options.mark !== undefined) tmux.marks.set('$0', options.mark);
  const pinStore = { pins: async () => options.pins ?? {} };
  const service = new DiscoveryService(socketFinder(), tmux as never, processInspector(), noPullRequests as never, undefined, (options.projects ?? []).map(testProject), pinStore as never, undefined, options.scratchDirectory ?? '/nonexistent-scratch');
  return { service, tmux };
}

describe('a Project configured without an id', () => {
  it('derives the id an implicit Project of the same repository carries, and is labelled by its folder', async () => {
    const { repo } = await gitRepo();
    const config = await validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ path: repo }] });

    expect(config.projects[0]).toMatchObject({ label: 'ferry', mode: 'repository' });
    expect(config.projects[0]!.id).toMatch(/^ferry-[0-9a-f]{8}$/);
    expect((await implicitProject(repo))?.id).toBe(config.projects[0]!.id);
  });

  it('does not load, with a warning, when its path is missing', async () => {
    const warnings: string[] = [];
    const config = await validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ path: '/nonexistent/ferry' }] }, { warn: message => warnings.push(message) });

    expect(config.projects).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('/nonexistent/ferry')]);
  });
});

describe('implicit Projects', () => {
  it('claims an agent started by hand in an unconfigured repository as its implicit Main worktree, unpinned', async () => {
    const { repo } = await gitRepo();
    const id = (await implicitProject(repo))!.id;
    const { service, tmux } = discovery(repo);

    const dashboard = await service.dashboard();

    expect(tmux.marks.get('$0')).toBe(`${id}:${repo}`);
    expect(dashboard.projects).toEqual([expect.objectContaining({ id, implicit: true, label: 'ferry', worktrees: [expect.objectContaining({ id: `${id}:${repo}`, main: true, pinned: false })] })]);
    expect(dashboard.agents[0]).toMatchObject({ worktreeId: `${id}:${repo}`, projectId: id });
  });

  it('rebuilds the implicit Project from a session mark after a restart', async () => {
    const { repo } = await gitRepo();
    const id = (await implicitProject(repo))!.id;
    const { service } = discovery(repo, { mark: `${id}:${repo}` });

    const dashboard = await service.dashboard();

    expect(dashboard.projects.map(project => project.id)).toEqual([id]);
    expect(dashboard.agents[0]?.worktreeId).toBe(`${id}:${repo}`);
  });

  it('keeps a pinned implicit Worktree with nothing running, and drops an unpinned one', async () => {
    const { repo } = await gitRepo();
    const id = (await implicitProject(repo))!.id;

    const pinned = await discovery(repo, { panes: [], pins: { [`${id}:${repo}`]: true } }).service.dashboard();
    const unpinned = await discovery(repo, { panes: [], pins: { [`${id}:${repo}`]: false } }).service.dashboard();

    expect(pinned.projects).toEqual([expect.objectContaining({ id, worktrees: [expect.objectContaining({ pinned: true })] })]);
    expect(unpinned.projects).toEqual([]);
  });

  it('defers to a configured Project of the same repository', async () => {
    const { repo } = await gitRepo();
    const configured = (await validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'ferry', path: repo }] })).projects[0]!;
    const id = (await implicitProject(repo))!.id;
    const { service } = discovery(repo, { mark: `${id}:${repo}`, projects: [configured] });

    const dashboard = await service.dashboard();

    expect(dashboard.projects.map(project => project.id)).toEqual(['ferry']);
    expect(dashboard.agents[0]?.worktreeId).toBeUndefined();
  });

  it('hands a marked session to a config entry for the same repository that omits its id', async () => {
    const { repo } = await gitRepo();
    const configured = (await validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ path: repo }] })).projects[0]!;
    const { service } = discovery(repo, { mark: `${configured.id}:${repo}`, projects: [configured] });

    const dashboard = await service.dashboard();

    expect(dashboard.projects).toEqual([expect.not.objectContaining({ implicit: true })]);
    expect(dashboard.agents[0]).toMatchObject({ worktreeId: `${configured.id}:${repo}`, projectId: configured.id });
  });

  it('claims a repository below the configured Scratch folder as its implicit Worktree, not as Scratch', async () => {
    const { root, repo } = await gitRepo();
    const id = (await implicitProject(repo))!.id;
    const { service, tmux } = discovery(repo, { scratchDirectory: root });

    await service.dashboard();

    expect(tmux.marks.get('$0')).toBe(`${id}:${repo}`);
  });

  it('leaves a folder that is not a git checkout its own Scratch Place', async () => {
    const { root } = await gitRepo();
    const folder = join(root, 'notes');
    await mkdir(folder);
    const { service, tmux } = discovery(folder);

    const dashboard = await service.dashboard();

    expect(tmux.marks.get('$0')).toBe(`scratch:${folder}`);
    expect(dashboard.projects).toEqual([]);
  });
});
