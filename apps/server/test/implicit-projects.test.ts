import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivedProjectId, implicitProject, validateConfig } from '../src/config/schema.js';
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

const noPullRequests = { repositoryAt: async () => undefined, branch: async () => ({}), invalidateRepositories: () => {} };
// a discovery over one agent pane in `path`, session `$0`, optionally already marked
function discovery(path: string, options: { mark?: string; projects?: Parameters<typeof testProject>[0][]; pins?: Record<string, boolean>; scratchDirectory?: string; panes?: Partial<Pane>[] } = {}) {
  const tmux = paneLister(options.panes ?? [{ paneId: '%1', sessionId: '$0', pid: 123, path, title: 'Agent' }]);
  if (options.mark !== undefined) tmux.marks.set('$0', options.mark);
  const pinStore = { pins: async () => options.pins ?? {} };
  const service = new DiscoveryService(socketFinder(), tmux as never, processInspector(), noPullRequests as never, undefined, (options.projects ?? []).map(testProject), pinStore as never, undefined, options.scratchDirectory ?? '/nonexistent-scratch');
  return { service, tmux };
}

describe('a Project configured without an id', () => {
  it('derives a fixed id from the repository identity alone, a bare repository included', () => {
    expect(derivedProjectId('/code/ferry/.git')).toBe('ferry-167c8de4');
    expect(derivedProjectId('/code/ferry.git')).toBe('ferry-d0e4e870');
  });

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

  it('resolves a pin on a Linked worktree to the same implicit Project as its Main worktree', async () => {
    const { root, repo } = await gitRepo();
    const linked = join(root, 'ferry-feature');
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const id = (await implicitProject(repo))!.id;

    const dashboard = await discovery(repo, { panes: [], pins: { [`${id}:${linked}`]: true } }).service.dashboard();

    expect(dashboard.projects).toEqual([expect.objectContaining({ id, worktrees: [expect.objectContaining({ id: `${id}:${repo}`, pinned: false }), expect.objectContaining({ id: `${id}:${linked}`, pinned: true })] })]);
  });

  it('ignores a mark whose id the repository does not derive', async () => {
    const { repo } = await gitRepo();

    const dashboard = await discovery(repo, { mark: `ferry:${repo}` }).service.dashboard();

    expect(dashboard.projects).toEqual([]);
  });

  it('drops an implicit Project once nothing names it', async () => {
    const { repo } = await gitRepo();
    const id = (await implicitProject(repo))!.id;
    const panes: Partial<Pane>[] = [{ paneId: '%1', sessionId: '$0', pid: 123, path: repo, title: 'Agent' }];
    const { service } = discovery(repo, { mark: `${id}:${repo}`, panes });
    expect((await service.dashboard()).projects.map(project => project.id)).toEqual([id]);

    panes.length = 0;

    expect((await service.dashboard(true)).projects).toEqual([]);
  });

  it('marks a Console shell in a new checkout of a configured repository with that Project', async () => {
    const { root, repo } = await gitRepo();
    const configured = (await validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'ferry', path: repo }] })).projects[0]!;
    const panes: Partial<Pane>[] = [];
    const tmux = paneLister(panes);
    const service = new DiscoveryService(socketFinder(), tmux as never, processInspector({ codex: false }), noPullRequests as never, undefined, [configured], { pins: async () => ({}) } as never, undefined, '/nonexistent-scratch');
    await service.dashboard();
    const linked = join(root, 'ferry-feature');
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    panes.push({ paneId: '%2', sessionId: '$1', pid: 124, path: linked, title: 'zsh', role: 'shell' });

    const dashboard = await service.dashboard(false, true);

    expect(tmux.marks.get('$1')).toBe(`ferry:${linked}`);
    expect(dashboard.projects.flatMap(project => project.worktrees).map(worktree => worktree.id)).toContain(`ferry:${linked}`);
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

  it('leaves a Scratch folder that is itself a repository as Scratch', async () => {
    const { repo } = await gitRepo();
    const { service, tmux } = discovery(repo, { scratchDirectory: repo });

    await service.dashboard();

    expect(tmux.marks.get('$0')).toBe(`scratch:${repo}`);
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

describe('opening a folder', () => {
  it("opens a subfolder of an unconfigured repository as its implicit Main worktree, listed before anything runs there", async () => {
    const { repo } = await gitRepo();
    const sub = join(repo, 'src');
    await mkdir(sub);
    const id = (await implicitProject(repo))!.id;
    const { service } = discovery(repo, { panes: [] });

    const place = await service.openFolder(sub);

    expect(place).toMatchObject({ id: `${id}:${repo}`, kind: 'worktree', home: repo });
    expect((await service.dashboard(true)).projects).toEqual([expect.objectContaining({ id, implicit: true, worktrees: [expect.objectContaining({ id: `${id}:${repo}` })] })]);
  });

  it('opens a folder inside a configured Worktree as that Worktree', async () => {
    const { repo } = await gitRepo();
    const sub = join(repo, 'src');
    await mkdir(sub);
    const configured = (await validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'ferry', path: repo }] })).projects[0]!;
    const { service } = discovery(repo, { panes: [], projects: [configured] });

    expect(await service.openFolder(sub)).toMatchObject({ id: `ferry:${repo}`, kind: 'worktree' });
  });

  it('opens a linked worktree added inside a configured one since the last scan as itself', async () => {
    const { repo } = await gitRepo();
    const configured = (await validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'ferry', path: repo }] })).projects[0]!;
    const { service } = discovery(repo, { panes: [], projects: [configured] });
    await service.dashboard();
    const nested = join(repo, '.worktrees', 'feature');
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', nested);

    expect(await service.openFolder(nested)).toMatchObject({ id: `ferry:${nested}`, kind: 'worktree' });
  });

  it('opens the folder itself when git names a toplevel the folder is not in', async () => {
    const { root, repo } = await gitRepo();
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await git(repo, 'config', 'core.worktree', elsewhere);
    const { service } = discovery(repo, { panes: [] });

    expect((await service.openFolder(repo))?.home).toBe(repo);
  });

  it('opens a folder that is no git checkout as its own Scratch Place, below the configured Scratch folder too', async () => {
    const { root } = await gitRepo();
    const folder = join(root, 'notes');
    await mkdir(folder);
    const { service } = discovery(folder, { panes: [], scratchDirectory: root });

    expect(await service.openFolder(folder)).toMatchObject({ id: `scratch:${folder}`, kind: 'scratch', home: folder, label: 'notes', adhoc: true });
  });

  it('places a session marked with a folder below the configured Scratch folder in that folder, not the Scratch folder', async () => {
    const { root } = await gitRepo();
    const folder = join(root, 'notes');
    await mkdir(folder);
    const { service } = discovery(folder, { mark: `scratch:${folder}`, scratchDirectory: root });

    const dashboard = await service.dashboard();

    expect(dashboard.agents[0]?.placeId).toBe(`scratch:${folder}`);
    expect(dashboard.places.map(place => place.id)).toContain(`scratch:${folder}`);
  });

  it('opens the configured Scratch folder itself as the Scratch folder', async () => {
    const { root } = await gitRepo();
    const { service } = discovery(root, { panes: [], scratchDirectory: root });

    expect(await service.openFolder(root)).toMatchObject({ id: `scratch:${root}`, kind: 'scratch' });
    expect((await service.openFolder(root))?.adhoc).toBeUndefined();
  });
});
