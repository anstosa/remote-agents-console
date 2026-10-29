import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { applyListenOverrides, resolveAgentProgram, validateConfig } from '../src/config/schema.js';
import { builtInCorrectnessPrompt, builtInTourPrompt } from '../src/review-runs/config.js';
import { defaultDavoContext } from '../src/integrations/realtime/settings.js';
import { run } from '../src/tmux/command.js';
import { accountHome } from '../src/places/places.js';

const dirs: string[] = [];
// restore configuration overrides and temporary repositories
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`); return r.stdout.trim(); };

// a temp git repository with one commit; the returned path is realpath'd so it equals discovery's
async function gitRepo(name = 'work'): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-cfg-')));
  dirs.push(root);
  const repo = join(root, name);
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'readme.md'), 'hi\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}
// a config over one Project at `path`, with a valid origin
const withProject = async (path: string, extra: Record<string, unknown> = {}) => ({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'a', path, ...extra }] });

describe('project configuration', () => {
  // inherited host paths must not export the container account home
  it('inherits each project path on the host bridge for project and scratch launches', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    vi.stubEnv('HOME', '/home/node');
    const repo = await gitRepo();
    const folder = join(repo, '..', 'notes');
    await mkdir(folder);
    const missing = join(repo, '..', 'missing');
    const input = { publicOrigin: 'https://agents.example.com', projects: [
      { id: 'repo', path: repo },
      { id: 'notes', path: folder },
      { id: 'missing', path: missing },
      { id: 'mapped', path: '/not-mounted', hostPath: '/host/operator/mapped' }
    ] };
    const config = await validateConfig(input);

    expect(config.projects.map(project => project.hostPath)).toEqual([repo, folder, missing, '/host/operator/mapped']);
    expect(accountHome(config.projects)).toBe(join(repo, '..'));
    expect(accountHome(config.projects, 'notes')).toBe(join(folder, '..'));
    expect(accountHome(config.projects, 'mapped')).toBe('/host/operator');
    expect(input.projects[0]).not.toHaveProperty('hostPath');
  });

  // native projects retain their own account instead of deriving one from checkout paths
  it('leaves omitted host paths absent outside the host bridge', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', undefined);
    vi.stubEnv('HOME', '/native/account');
    const config = await validateConfig(await withProject(await gitRepo()));

    expect(config.projects[0]).not.toHaveProperty('hostPath');
    expect(accountHome(config.projects)).toBe('/native/account');
  });

  // retain an optional comparison default without changing unconfigured projects
  it('accepts a project default branch and leaves it absent when unset', async () => {
    const repo = await gitRepo();
    const configured = await validateConfig(await withProject(repo, { defaultBranch: 'release/stable' }));
    expect(configured.projects[0]?.defaultBranch).toBe('release/stable');
    expect((await validateConfig(await withProject(repo))).projects[0]?.defaultBranch).toBeUndefined();
  });

  // reject option-like values and revision expressions at the config boundary
  it.each(['', ' ', '-main', 'main\n', 'bad\0branch', 'main~1', 'main..other', '@{-1}', 'a//b', 'a.lock', 'HEAD', 'refs/tags/v1', 'refs/notes/x'])('rejects invalid default branch %j', async defaultBranch => {
    await expect(validateConfig(await withProject('/unused-project', { defaultBranch }))).rejects.toThrow();
  });

  // resolve independent stack settings without merging command sets
  it('canonicalizes worktree overrides and resolves inherited or disabled settings', async () => {
    const repo = await gitRepo();
    const alias = join(repo, '..', 'alias');
    await symlink(repo, alias);
    const commands = { start: 'full up', stop: 'full stop', migrate: 'full migrate' };
    const config = await validateConfig(await withProject(repo, {
      port: 3000, hostname: 'main.example.com', commands,
      worktreeOverrides: [
        { path: '../alias', port: 4000, hostname: 'main-override.example.com' },
        { path: '../feature', commands: { start: 'ui up' } },
        { path: '../readonly', port: null, hostname: null, commands: {} }
      ]
    }));
    expect(config.projects[0]?.worktreeOverrides).toEqual([
      { path: repo, projectPort: 4000, projectUrl: 'https://main-override.example.com', commands },
      { path: join(repo, '..', 'feature'), projectPort: 3000, projectUrl: 'https://main.example.com', commands: { start: 'ui up' } },
      { path: join(repo, '..', 'readonly'), commands: {} }
    ]);
    expect(config.projects[0]?.commands).toEqual(commands);
    expect(config.projects[0]?.projectUrl).toBe('https://main.example.com');
  });

  // resolve direct preview inheritance and complete mode replacement
  it('canonicalizes direct external previews and worktree preview modes', async () => {
    const repo = await gitRepo();
    const config = await validateConfig(await withProject(repo, {
      externalUrl: 'https://Preview.Example.com:443/',
      worktreeOverrides: [
        { path: '../inherited' },
        { path: '../direct', externalUrl: 'https://direct.example.com' },
        { path: '../proxied', hostname: 'proxy.example.com', port: 4041 },
        { path: '../disabled-direct', externalUrl: null },
        { path: '../disabled-proxy', hostname: null, port: null }
      ]
    }));

    expect(config.projects[0]).toMatchObject({ projectUrl: 'https://preview.example.com' });
    expect(config.projects[0]).not.toHaveProperty('projectPort');
    expect(config.projects[0]?.worktreeOverrides).toEqual([
      { path: join(repo, '..', 'inherited'), projectUrl: 'https://preview.example.com' },
      { path: join(repo, '..', 'direct'), projectUrl: 'https://direct.example.com' },
      { path: join(repo, '..', 'proxied'), projectUrl: 'https://proxy.example.com', projectPort: 4041 },
      { path: join(repo, '..', 'disabled-direct') },
      { path: join(repo, '..', 'disabled-proxy') }
    ]);
  });

  // reject ambiguous or unsafe checkout settings
  it.each([
    { path: '' }, { path: 'bad\0path' }, { path: '.', port: 4000 },
    { path: '.', hostname: 'feature.example.com' }, { path: '.', port: null },
    { path: '.', port: 4000, hostname: null }, { path: '.', port: null, hostname: 'feature.example.com' },
    { path: '.', externalUrl: 'https://direct.example.com', port: 4000, hostname: 'feature.example.com' },
    { path: '.', externalUrl: null, port: null, hostname: null },
    { path: '.', externalUrl: 'http://direct.example.com' },
    { path: '.', externalUrl: 'https://direct.example.com/path' },
    { path: '.', port: 0, hostname: 'feature.example.com' },
    { path: '.', port: 4000, hostname: 'https://feature.example.com' },
    { path: '.', commands: { start: 'bad\0command' } }, { path: '.', commands: { unknown: 'run' } },
    { path: '.', unknown: true }
  ])('rejects invalid worktree override %j', async override => {
    // invalid settings fail before checkout resolution
    await expect(validateConfig(await withProject('/unused-project', { worktreeOverrides: [override] }))).rejects.toThrow();
  });

  // aliases cannot select conflicting runtime settings
  it('rejects duplicate canonical worktree override paths', async () => {
    const repo = await gitRepo();
    const alias = join(repo, '..', 'alias');
    await symlink(repo, alias);
    await expect(validateConfig(await withProject(repo, { worktreeOverrides: [{ path: '.' }, { path: '../alias' }] }))).rejects.toThrow('duplicate worktree override path');
  });

  // preserve operator order while resolving checkout aliases
  it('resolves worktreeOrder paths relative to the configured checkout', async () => {
    const repo = await gitRepo();
    const alias = join(repo, '..', 'alias');
    await symlink(repo, alias);
    const config = await validateConfig(await withProject(repo, { worktreeOrder: ['../alias', '../future', repo] }));
    expect(config.projects[0]?.worktreeOrder).toEqual([repo, join(repo, '..', 'future'), repo]);
  });

  // reject invalid ordering entries at the config boundary
  it.each([{ order: [''] }, { order: ['bad\0path'] }, { order: [1] }, { order: 'not-an-array' }])('rejects invalid worktreeOrder $order', async ({ order }) => {
    const repo = await gitRepo();
    await expect(validateConfig(await withProject(repo, { worktreeOrder: order }))).rejects.toThrow();
  });

  it('canonicalizes an available project and derives its identity from the common git dir', async () => {
    const repo = await gitRepo();
    const config = await validateConfig(await withProject(repo));
    const project = config.projects[0]!;
    expect(project.id).toBe('a');
    expect(project.label).toBe('a');
    expect(project.path).toBe(repo);
    expect(project.identity).toBe(await realpath(join(repo, '.git')));
    expect(project.available).toBe(true);
    // default worktrees directory: a `<basename>-worktrees` sibling of the main worktree
    expect(project.worktreesDirectory).toBe(join(repo, '..', 'work-worktrees'));
    expect(project.push).toEqual({ label: 'Commit/Push', prompt: 'review, commit, and push' });
  });

  it('accepts a bare repository as an available Project with a sibling Worktrees directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-cfg-bare-')));
    dirs.push(root);
    const bare = join(root, 'store.git'); await mkdir(bare); await git(bare, 'init', '--bare', '-q');
    const config = await validateConfig(await withProject(bare));
    expect(config.projects[0]).toMatchObject({ available: true, mode: 'repository' });
    // with no Main worktree the default resolves against the bare repository itself
    expect(config.projects[0]?.worktreesDirectory).toBe(join(root, 'store.git-worktrees'));
  });

  it('configures a Project through a linked worktree and shares one identity', async () => {
    const repo = await gitRepo();
    const linked = `${repo}-feature`;
    dirs.push(linked);
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const config = await validateConfig(await withProject(linked));
    // the common git dir is the same repository, so identity points at the main checkout's .git
    expect(config.projects[0]?.identity).toBe(await realpath(join(repo, '.git')));
    expect(config.projects[0]?.available).toBe(true);
  });

  it('loads a missing path as unavailable with a boot warning instead of failing', async () => {
    const warnings: string[] = [];
    const missing = await validateConfig(await withProject('/no/such/path'), { warn: m => warnings.push(m) });
    expect(missing.projects[0]).toMatchObject({ available: false, mode: 'repository' });
    expect(missing.projects[0]?.unavailableReason).toContain('was not found');
    expect(warnings.some(w => w.includes('projects.a') && w.includes('was not found'))).toBe(true);
  });

  it('loads an existing non-git path as an available directory Project keyed by its own realpath', async () => {
    const warnings: string[] = [];
    const plainRoot = await realpath(await mkdtemp(join(tmpdir(), 'rac-plain-')));
    dirs.push(plainRoot);
    const plain = await validateConfig(await withProject(plainRoot), { warn: m => warnings.push(m) });
    const project = plain.projects[0]!;
    // a non-git directory is launchable in place (like Scratch), never unavailable
    expect(project).toMatchObject({ available: true, mode: 'directory' });
    expect(project.unavailableReason).toBeUndefined();
    // its identity is its own path, so it dedups against another entry at the same directory
    expect(project.identity).toBe(plainRoot);
    expect(project.path).toBe(plainRoot);
    // an available directory Project needs no boot warning
    expect(warnings.some(w => w.includes('projects.a'))).toBe(false);
    // two directory Projects at the same path still collide on identity
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'a', path: plainRoot }, { id: 'b', path: plainRoot }] })).rejects.toThrow('duplicate project identity');
  });

  it('refuses two Projects that resolve to the same repository, including through a symlink', async () => {
    const repo = await gitRepo();
    const alias = `${repo}-alias`;
    dirs.push(alias);
    await symlink(repo, alias);
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'a', path: repo }, { id: 'b', path: alias }] })).rejects.toThrow('duplicate project identity');
  });

  it('refuses duplicate project ids and the reserved ids', async () => {
    const repo = await gitRepo();
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'a', path: repo }, { id: 'a', path: repo }] })).rejects.toThrow('duplicate project id');
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'agent', path: repo }] })).rejects.toThrow();
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'scratch', path: repo }] })).rejects.toThrow();
  });

  it('accepts an editor command line, omits it when unset, and refuses a multi-line one', async () => {
    const set = await validateConfig({ publicOrigin: 'https://agents.example.com', editor: ' /usr/bin/nvim -p ' });
    expect(set.editor).toBe('/usr/bin/nvim -p');
    expect((await validateConfig({ publicOrigin: 'https://agents.example.com' })).editor).toBeUndefined();
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', editor: 'nvim\nrm -rf ~' })).rejects.toThrow('newlines');
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', editor: '  ' })).rejects.toThrow();
  });

  it('accepts keys tables with canonical chords, omits them when unset, and refuses a forbidden chord', async () => {
    const set = await validateConfig({ publicOrigin: 'https://agents.example.com', keys: { root: { 'C-g': { table: 'git' } }, git: { L: { terminal: ' lazygit ', reuse: true } } } });
    expect(set.keys).toEqual({ root: { 'C-g': { table: 'git' } }, git: { 'S-l': { terminal: 'lazygit', reuse: true } } });
    expect((await validateConfig({ publicOrigin: 'https://agents.example.com' })).keys).toBeUndefined();
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', keys: { root: { 'C-w': 'next-panel' } } })).rejects.toThrow('keys.root.C-w: Firefox and Chromium both reserve it');
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', keys: { root: { x: 'next-panel' } } })).rejects.toThrow('cannot steal typing');
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', keys: { root: { 'C-g': { table: 'git' } } } })).rejects.toThrow('no table named git');
  });

  it('accepts an absolute scratchDirectory, omits it when unset, and refuses a relative one', async () => {
    const set = await validateConfig({ publicOrigin: 'https://agents.example.com', scratchDirectory: '/srv/scratch' });
    expect(set.scratchDirectory).toBe('/srv/scratch');
    const unset = await validateConfig({ publicOrigin: 'https://agents.example.com' });
    expect(unset.scratchDirectory).toBeUndefined();
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', scratchDirectory: 'relative/path' })).rejects.toThrow('absolute path');
  });

  it('resolves worktreesDirectory: default, relative to the main worktree, and absolute as given', async () => {
    const repo = await gitRepo();
    const relative = await validateConfig(await withProject(repo, { worktreesDirectory: '../elsewhere' }));
    expect(relative.projects[0]?.worktreesDirectory).toBe(join(repo, '..', 'elsewhere'));
    const absolute = await validateConfig(await withProject(repo, { worktreesDirectory: '/var/checkouts' }));
    expect(absolute.projects[0]?.worktreesDirectory).toBe('/var/checkouts');
  });

  it('derives the preview URL from a configured port and hostname, requiring both', async () => {
    const repo = await gitRepo();
    const config = await validateConfig(await withProject(repo, { port: 4041, hostname: 'a.example.com' }));
    expect(config.projects[0]?.projectUrl).toBe('https://a.example.com');
    expect(config.projects[0]?.projectPort).toBe(4041);
    await expect(validateConfig(await withProject(repo, { port: 4041 }))).rejects.toThrow('both port and hostname');
  });

  // reject ambiguous and non-canonical direct project previews
  it.each([
    { externalUrl: 'https://direct.example.com', hostname: 'proxy.example.com', port: 4041 },
    { externalUrl: 'http://direct.example.com' },
    { externalUrl: 'https://user:secret@direct.example.com' },
    { externalUrl: 'https://direct.example.com/path' },
    { externalUrl: 'https://direct.example.com?mode=preview' },
    { externalUrl: 'https://direct.example.com#preview' }
  ])('rejects invalid project preview %j', async preview => {
    const repo = await gitRepo();
    await expect(validateConfig(await withProject(repo, preview))).rejects.toThrow();
  });

  it('accepts project-level push, stack commands, new task and hostPath', async () => {
    const repo = await gitRepo();
    const config = await validateConfig(await withProject(repo, { push: { label: 'Finish and PR', prompt: '$finish' }, commands: { start: 'up', setup: 'pnpm install' }, newTask: 'detach && new {taskId}', hostPath: '/host/repo' }));
    const project = config.projects[0]!;
    expect(project.push).toEqual({ label: 'Finish and PR', prompt: '$finish' });
    // `setup` is a run-once worktree-creation hook: a valid command, but never a stack action
    expect(project.commands).toEqual({ start: 'up', setup: 'pnpm install' });
    expect(project.newTask).toBe('detach && new {taskId}');
    expect(project.hostPath).toBe('/host/repo');
    await expect(validateConfig(await withProject(repo, { newTask: 'new {unknown}' }))).rejects.toThrow('unknown new task placeholder');
  });

  // a Stack process is a named foreground command; start/stop/restart/status derive from the set
  describe('Stack processes', () => {
    it('accepts one process beside the one-shot build, migrate and setup commands', async () => {
      const repo = await gitRepo();
      const commands = { processes: { 'dev_server-2': 'cd web && pnpm dev' }, build: 'pnpm build', migrate: 'pnpm migrate', setup: 'pnpm install' };
      const config = await validateConfig(await withProject(repo, { commands }));
      expect(config.projects[0]?.commands).toEqual(commands);
    });

    it('accepts up to 20 processes, keeping their order', async () => {
      const repo = await gitRepo();
      const processes = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`service-${20 - index}`, `run ${index}`]));
      const config = await validateConfig(await withProject(repo, { commands: { processes } }));
      expect(Object.keys(config.projects[0]?.commands?.processes ?? {})).toEqual(Object.keys(processes));
    });

    it('rejects more than 20 processes, and an empty map', async () => {
      const repo = await gitRepo();
      const processes = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`service-${index}`, `run ${index}`]));
      await expect(validateConfig(await withProject(repo, { commands: { processes } }))).rejects.toThrow(/at most 20/);
      await expect(validateConfig(await withProject(repo, { commands: { processes: {} } }))).rejects.toThrow();
    });

    it.each(['start', 'stop', 'restart', 'status'])('rejects a process beside %s, whose action it derives', async action => {
      const repo = await gitRepo();
      await expect(validateConfig(await withProject(repo, { commands: { processes: { dev: 'pnpm dev' }, [action]: 'run' } }))).rejects.toThrow(new RegExp(`\`${action}\``));
    });

    it.each(['dev server', 'dev.server', 'dev:1', 'dév', '', 'x'.repeat(41)])('rejects the process name %j', async name => {
      const repo = await gitRepo();
      await expect(validateConfig(await withProject(repo, { commands: { processes: { [name]: 'pnpm dev' } } }))).rejects.toThrow();
    });

    it('rejects an empty or NUL-bearing process command', async () => {
      const repo = await gitRepo();
      await expect(validateConfig(await withProject(repo, { commands: { processes: { dev: '' } } }))).rejects.toThrow();
      await expect(validateConfig(await withProject(repo, { commands: { processes: { dev: 'pnpm\0dev' } } }))).rejects.toThrow();
    });

    // the string form is shorthand for `{ command }`; the config keeps the form written
    it('accepts a process as a command string or as `{ command, dependsOn }`', async () => {
      const repo = await gitRepo();
      const processes = { sync: 'ods exec sync', api: { command: 'ods exec api', dependsOn: ['sync'] }, web: { command: 'ods exec web' } };
      const config = await validateConfig(await withProject(repo, { commands: { processes } }));
      expect(config.projects[0]?.commands?.processes).toEqual(processes);
    });

    it('rejects an object form without a command, with an empty one, or with an unknown key', async () => {
      const repo = await gitRepo();
      await expect(validateConfig(await withProject(repo, { commands: { processes: { api: { dependsOn: [] } } } }))).rejects.toThrow();
      await expect(validateConfig(await withProject(repo, { commands: { processes: { api: { command: '' } } } }))).rejects.toThrow();
      await expect(validateConfig(await withProject(repo, { commands: { processes: { api: { command: 'run', cwd: 'web' } } } }))).rejects.toThrow();
    });

    // each rejection names the offending entry by its path in the config
    it.each([
      ['an undeclared process', { api: { command: 'run', dependsOn: ['sync'] } }, ['projects', 0, 'commands', 'processes', 'api', 'dependsOn', 0], /`api` depends on `sync`, which is not declared/],
      ['itself', { sync: 'run', api: { command: 'run', dependsOn: ['sync', 'api'] } }, ['projects', 0, 'commands', 'processes', 'api', 'dependsOn', 1], /`api` cannot depend on itself/],
      ['a cycle', { web: { command: 'run', dependsOn: ['api'] }, api: { command: 'run', dependsOn: ['sync'] }, sync: { command: 'run', dependsOn: ['web'] } }, ['projects', 0, 'commands', 'processes', 'web', 'dependsOn'], /`web` → `api` → `sync` → `web`/],
      // an entry that only leads into the cycle is not on it, so the path names one that is
      ['a cycle reached from another entry', { docs: { command: 'run', dependsOn: ['api'] }, web: { command: 'run', dependsOn: ['api'] }, api: { command: 'run', dependsOn: ['web'] } }, ['projects', 0, 'commands', 'processes', 'api', 'dependsOn'], /`api` → `web` → `api`/]
    ])('rejects a dependsOn naming %s, with its path', async (_case, processes, path, message) => {
      const repo = await gitRepo();
      const failure = await validateConfig(await withProject(repo, { commands: { processes } })).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ZodError);
      expect((failure as ZodError).issues).toEqual([expect.objectContaining({ path, message: expect.stringMatching(message) })]);
    });

    it("validates a Worktree override's dependsOn by the same rules", async () => {
      const repo = await gitRepo();
      const failure = await validateConfig(await withProject(repo, { worktreeOverrides: [{ path: '../web', commands: { processes: { api: { command: 'run', dependsOn: ['sync'] } } } }] })).catch((error: unknown) => error);
      expect((failure as ZodError).issues).toEqual([expect.objectContaining({ path: ['projects', 0, 'worktreeOverrides', 0, 'commands', 'processes', 'api', 'dependsOn', 0] })]);
    });

    // an override's `commands` replaces the Project's whole set, `processes` included
    it('lets a Worktree override replace commands as a whole, processes included', async () => {
      const repo = await gitRepo();
      const config = await validateConfig(await withProject(repo, {
        commands: { processes: { dev: 'pnpm dev' }, build: 'pnpm build' },
        worktreeOverrides: [
          { path: '../daemon', commands: { start: 'docker compose up -d', stop: 'docker compose down' } },
          { path: '../web', commands: { processes: { web: 'cd web && pnpm dev' } } },
          { path: '../inherit', port: 4000, hostname: 'inherit.example.com' }
        ]
      }));
      expect(config.projects[0]?.worktreeOverrides?.map(override => override.commands)).toEqual([
        { start: 'docker compose up -d', stop: 'docker compose down' },
        { processes: { web: 'cd web && pnpm dev' } },
        { processes: { dev: 'pnpm dev' }, build: 'pnpm build' }
      ]);
      // the same rules bind an override's commands
      await expect(validateConfig(await withProject(repo, { worktreeOverrides: [{ path: '../web', commands: { processes: { dev: 'pnpm dev' }, start: 'up' } }] }))).rejects.toThrow(/`start`/);
    });
  });

  it('refuses a legacy worktrees[] configuration with a pointer to the migration', async () => {
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', worktrees: [] })).rejects.toThrow(/migration/);
    await expect(validateConfig({ publicOrigin: 'https://agents.example.com', worktrees: [{ id: 'a', path: '/x', command: 'codex' }] })).rejects.toThrow(/retired `worktrees\[\]`/);
  });

  it('rejects unknown project keys and the removed saveKey/command/launch fields', async () => {
    const repo = await gitRepo();
    await expect(validateConfig(await withProject(repo, { saveKey: 'x' }))).rejects.toThrow(/[Uu]nrecognized/);
    await expect(validateConfig(await withProject(repo, { command: 'codex' }))).rejects.toThrow(/[Uu]nrecognized/);
    await expect(validateConfig(await withProject(repo, { launch: { program: '/bin/echo' } }))).rejects.toThrow(/[Uu]nrecognized/);
  });
});

describe('configuration safety', () => {
  const scratch = { publicOrigin: 'https://agents.example.com', projects: [] as unknown[] };
  it('defaults the listener, name and integrations for a scratch-only console', async () => {
    const config = await validateConfig(scratch);
    expect(config.projects).toEqual([]);
    expect(config.listen.host).toBe('127.0.0.1');
    expect(config.name).toBe('Remote Agents');
    expect(config.defaultAgent).toBeUndefined();
    expect(config.integrations).toEqual({ enabled: false, mcp: { readEnabled: true, writeEnabled: false, dangerousEnabled: false }, realtime: { enabled: false, name: 'Davo', context: defaultDavoContext, writeToolsEnabled: false }, multiInstance: { enabled: false } });
  });
  it('accepts a known default agent and rejects unknown kinds', async () => {
    expect((await validateConfig({ ...scratch, defaultAgent: 'claude' })).defaultAgent).toBe('claude');
    await expect(validateConfig({ ...scratch, defaultAgent: 'unknown' })).rejects.toThrow();
  });
  it('accepts a specific non-loopback listen address but rejects wildcards and non-IP hosts', async () => {
    expect((await validateConfig({ ...scratch, listen: { host: '172.19.0.1', port: 8787 } })).listen).toEqual({ host: '172.19.0.1', port: 8787 });
    expect((await validateConfig({ ...scratch, listen: { host: '::1', port: 8787 } })).listen.host).toBe('::1');
    await expect(validateConfig({ ...scratch, listen: { host: '0.0.0.0', port: 8787 } })).rejects.toThrow('wildcard');
    await expect(validateConfig({ ...scratch, listen: { host: 'localhost', port: 8787 } })).rejects.toThrow('IP address');
  });
  it('lets RAC_LISTEN_HOST and RAC_LISTEN_PORT override the listen block', async () => {
    expect(applyListenOverrides(scratch, {})).toBe(scratch);
    expect((await validateConfig(applyListenOverrides(scratch, { RAC_LISTEN_HOST: '172.19.0.1' }))).listen).toEqual({ host: '172.19.0.1', port: 8787 });
    const both = await validateConfig(applyListenOverrides({ ...scratch, listen: { host: '::1', port: 9000 } }, { RAC_LISTEN_HOST: ' 172.19.0.1 ', RAC_LISTEN_PORT: '8788' }));
    expect(both.listen).toEqual({ host: '172.19.0.1', port: 8788 });
    expect(() => applyListenOverrides(scratch, { RAC_LISTEN_PORT: 'abc' })).toThrow('integer');
  });
  it('accepts explicit integration feature gates', async () => {
    const config = await validateConfig({ ...scratch, integrations: { enabled: true, mcp: { writeEnabled: true }, realtime: { enabled: true, name: 'Riley', context: 'Dry and direct.', writeToolsEnabled: true }, multiInstance: { enabled: true } } });
    expect(config.integrations).toMatchObject({ enabled: true, mcp: { readEnabled: true, writeEnabled: true, dangerousEnabled: false }, realtime: { enabled: true, name: 'Riley', context: 'Dry and direct.', writeToolsEnabled: true }, multiInstance: { enabled: false } });
    await expect(validateConfig({ ...scratch, integrations: { realtime: { name: '   ' } } })).rejects.toThrow();
    await expect(validateConfig({ ...scratch, integrations: { realtime: { context: 'x'.repeat(16_001) } } })).rejects.toThrow();
  });
  it('derives multi-instance federation only from configured remote servers', async () => {
    const none = await validateConfig({ ...scratch, integrations: { multiInstance: { enabled: true } } });
    const one = await validateConfig({ ...scratch, remoteServers: [{ url: 'https://peer.example.com' }], integrations: { multiInstance: { enabled: false } } });
    const many = await validateConfig({ ...scratch, remoteServers: [{ url: 'https://peer.example.com' }, { url: 'https://archive.example.com' }] });

    expect(none.integrations?.multiInstance.enabled).toBe(false);
    expect(one.integrations?.multiInstance.enabled).toBe(true);
    expect(many.integrations?.multiInstance.enabled).toBe(true);
  });
  it('rejects a non HTTPS origin', async () => {
    await expect(validateConfig({ ...scratch, publicOrigin: 'http://agents.example.com' })).rejects.toThrow('HTTPS');
  });
  it('validates local identity and preserves optional remote identity overrides', async () => {
    const config = await validateConfig({ ...scratch, name: 'X1 Carbon', publicOrigin: 'https://x1carbon.santosa.dev', remoteServers: [{ url: 'https://framework.santosa.dev', name: 'Workshop' }, { url: 'https://archive.santosa.dev', icon: 'potato' }] });
    expect(config.name).toBe('X1 Carbon');
    expect(config.remoteServers).toEqual([{ url: new URL('https://framework.santosa.dev'), name: 'Workshop' }, { url: new URL('https://archive.santosa.dev'), icon: 'potato' }]);
    await expect(validateConfig({ ...scratch, remoteServers: [{ url: 'https://framework.santosa.dev' }, { url: 'https://framework.santosa.dev' }] })).rejects.toThrow('unique');
  });
});

describe('adapter configuration', () => {
  const scratch = { publicOrigin: 'https://agents.example.com', projects: [] as unknown[] };
  it('accepts an adapters block with an executable program and normalizes args and env', async () => {
    const warnings: string[] = [];
    const config = await validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, args: ['--model', 'o3'], env: { RAC_TEST: '1' } } } }, { warn: m => warnings.push(m) });
    expect(config.adapters?.codex).toEqual({ program: process.execPath, args: ['--model', 'o3'], env: { RAC_TEST: '1' }, launchable: true });
    expect(warnings).toEqual([]);
  });
  it('disables a non-executable adapter program with a reason instead of refusing boot', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-exec-')));
    dirs.push(root);
    const fake = join(root, 'not-exec');
    await writeFile(fake, 'echo hi\n', { mode: 0o644 });
    const warnings: string[] = [];
    const config = await validateConfig({ ...scratch, adapters: { codex: { program: fake } } }, { warn: m => warnings.push(m) });
    expect(config.adapters?.codex).toMatchObject({ program: fake, launchable: false });
    expect(config.adapters?.codex?.unavailableReason).toContain('not an executable');
  });
  it('requires an absolute adapter program and bounds unknown keys', async () => {
    await expect(validateConfig({ ...scratch, adapters: { codex: { program: 'codex' } } })).rejects.toThrow('absolute');
    await expect(validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, extra: true } } })).rejects.toThrow(/[Uu]nrecognized/);
  });
  it('treats an empty or omitted adapters block as observe-only', async () => {
    expect((await validateConfig({ ...scratch, adapters: {} })).adapters).toEqual({});
    expect((await validateConfig(scratch)).adapters).toEqual({});
  });
  it('accepts setup and teardown lifecycle commands and carries them onto the launch config', async () => {
    const lifecycle = { setup: 'rm -f .omx/state/session.json', teardown: 'rm -f .omx/state/session.json' };
    const config = await validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, ...lifecycle } } });
    expect(config.adapters?.codex).toMatchObject(lifecycle);
    // bounded like every other command: no NUL, ≤32k
    await expect(validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, setup: 'rm\0-f' } } })).rejects.toThrow('NUL');
    await expect(validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, teardown: 'x'.repeat(32_001) } } })).rejects.toThrow();
  });
  it('accepts a complete agent update command contract and rejects partial or unknown fields', async () => {
    const updates = { current: 'codex --version', latest: 'npm view @openai/codex version', run: 'codex update' };
    const config = await validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, updates } } });
    expect(config.adapters?.codex?.updates).toEqual(updates);
    await expect(validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, updates: { ...updates, extra: 'no' } } } })).rejects.toThrow(/[Uu]nrecognized/);
  });

  // reject each incomplete or blank update command position
  it.each([
    ['missing current', { latest: 'npm view @openai/codex version', run: 'codex update' }],
    ['missing latest', { current: 'codex --version', run: 'codex update' }],
    ['missing update', { current: 'codex --version', latest: 'npm view @openai/codex version' }],
    ['empty current', { current: '', latest: 'npm view @openai/codex version', run: 'codex update' }],
    ['empty latest', { current: 'codex --version', latest: '', run: 'codex update' }],
    ['empty update', { current: 'codex --version', latest: 'npm view @openai/codex version', run: '' }],
    ['blank current', { current: ' \t ', latest: 'npm view @openai/codex version', run: 'codex update' }],
    ['blank latest', { current: 'codex --version', latest: '\n ', run: 'codex update' }],
    ['blank update', { current: 'codex --version', latest: 'npm view @openai/codex version', run: '   ' }]
  ])('rejects %s in an authored agent update contract', async (_name, updates) => {
    await expect(validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, updates } } })).rejects.toThrow();
  });

  // preserve meaningful command bytes without trimming
  it('preserves surrounding whitespace in complete agent update commands', async () => {
    const updates = { current: ' codex --version ', latest: '\tnpm view @openai/codex version', run: 'codex update\n' };
    const config = await validateConfig({ ...scratch, adapters: { codex: { program: process.execPath, updates } } });

    expect(config.adapters?.codex?.updates).toEqual(updates);
  });
});

describe('out-of-band agent programs', () => {
  it('take each kind\'s own environment override, else its configured program', () => {
    const config = { adapters: { codex: { program: '/opt/codex', args: [], env: {}, launchable: true }, claude: { program: '/opt/claude', args: [], env: {}, launchable: true } } };
    expect(resolveAgentProgram(config, 'codex', {})).toBe('/opt/codex');
    expect(resolveAgentProgram(config, 'claude', {})).toBe('/opt/claude');
    expect(resolveAgentProgram(config, 'codex', { RAC_CODEX_BIN: '/env/codex', RAC_CLAUDE_BIN: '/env/claude' })).toBe('/env/codex');
    expect(resolveAgentProgram(config, 'claude', { RAC_CODEX_BIN: '/env/codex', RAC_CLAUDE_BIN: '/env/claude' })).toBe('/env/claude');
    expect(resolveAgentProgram({ adapters: {} }, 'claude', {})).toBeUndefined();
  });
});

describe('claude adapter configuration', () => {
  const scratch = { publicOrigin: 'https://agents.example.com', projects: [] as unknown[] };
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string | undefined) => { if (!(key in saved)) saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  afterEach(() => { for (const key of Object.keys(saved)) { const value = saved[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; delete saved[key]; } });

  it('warns about and drops reserved Claude arguments the console composes itself', async () => {
    const warnings: string[] = [];
    const config = await validateConfig({ ...scratch, adapters: { claude: { program: process.execPath, args: ['--model', 'opus', '--settings', '/tmp/x', '--continue', '-p'] } } }, { warn: m => warnings.push(m) });
    expect(config.adapters?.claude?.args).toEqual(['--model', 'opus']);
    expect(warnings.some(w => w.includes('adapters.claude') && w.includes('--settings') && w.includes('--continue') && w.includes('-p'))).toBe(true);
  });

  it('enables Pi with the pinned program and refuses a program or update commands of its own', async () => {
    const config = await validateConfig({ ...scratch, adapters: { pi: { args: ['--verbose'], env: { RAC_TEST: '1' } } } });
    expect(config.adapters?.pi).toEqual({ program: process.execPath, args: ['--verbose'], env: { RAC_TEST: '1' }, launchable: true, sandbox: { allowedDomains: [], deniedDomains: [], allowWrite: [], denyWrite: [], denyRead: [], env: [] } });
    await expect(validateConfig({ ...scratch, adapters: { pi: { program: process.execPath } } })).rejects.toThrow(/pinned/u);
    await expect(validateConfig({ ...scratch, adapters: { pi: { updates: { current: 'a', latest: 'b', run: 'c' } } } })).rejects.toThrow(/pinned/u);
  });

  it('carries Pi\'s Allowed models in order, each an exact provider/id listed once with a Pi Effort', async () => {
    const allowedModels = [{ model: 'openai/gpt-5.6', effort: 'medium' }, { model: 'openrouter/~anthropic/claude-opus-latest' }];
    expect((await validateConfig({ ...scratch, adapters: { pi: { allowedModels } } })).adapters?.pi?.allowedModels).toEqual(allowedModels);
    // an empty list is no list: Pi runs on its own default
    expect((await validateConfig({ ...scratch, adapters: { pi: { allowedModels: [] } } })).adapters?.pi?.allowedModels).toBeUndefined();
    await expect(validateConfig({ ...scratch, adapters: { pi: { allowedModels: [{ model: 'gpt-5.6' }] } } })).rejects.toThrow(/provider\/id/u);
    await expect(validateConfig({ ...scratch, adapters: { pi: { allowedModels: [{ model: 'openai/gpt-5.6' }, { model: 'openai/gpt-5.6' }] } } })).rejects.toThrow(/once/u);
    await expect(validateConfig({ ...scratch, adapters: { pi: { allowedModels: [{ model: 'openai/gpt-5.6', effort: 'extreme' }] } } })).rejects.toThrow();
  });

  it('gives Pi the shared sandbox lists followed by its own, without repeats', async () => {
    const config = await validateConfig({ ...scratch,
      sandbox: { allowedDomains: ['registry.npmjs.org', '*.github.com'], denyRead: ['~/.ssh'], env: ['GH_TOKEN'] },
      adapters: { pi: { sandbox: { allowedDomains: ['*.github.com', 'pypi.org'], deniedDomains: ['evil.example'], allowWrite: ['~/.cache/pnpm'], denyWrite: ['/etc'], env: ['NPM_TOKEN'] } } } });
    expect(config.adapters?.pi?.sandbox).toEqual({ allowedDomains: ['registry.npmjs.org', '*.github.com', 'pypi.org'], deniedDomains: ['evil.example'], allowWrite: ['~/.cache/pnpm'], denyWrite: ['/etc'], denyRead: ['~/.ssh'], env: ['GH_TOKEN', 'NPM_TOKEN'] });
  });

  it('refuses sandbox paths that are not absolute or home-relative, URLs as domains, and bad variable names', async () => {
    await expect(validateConfig({ ...scratch, sandbox: { allowWrite: ['relative/dir'] } })).rejects.toThrow(/absolute or start with ~/u);
    await expect(validateConfig({ ...scratch, adapters: { pi: { sandbox: { allowedDomains: ['https://github.com'] } } } })).rejects.toThrow(/not a URL/u);
    await expect(validateConfig({ ...scratch, sandbox: { env: ['NOT-A-NAME'] } })).rejects.toThrow(/invalid environment variable name/u);
    await expect(validateConfig({ ...scratch, sandbox: { allowAllUnixSockets: true } })).rejects.toThrow(/allowAllUnixSockets/u);
  });

  it('leaves Pi unlaunchable under the host bridge', async () => {
    setEnv('RAC_HOST_TMUX_DIR', '/host/tmux');
    const config = await validateConfig({ ...scratch, adapters: { pi: {} } });
    expect(config.adapters?.pi).toMatchObject({ launchable: false });
    expect(config.adapters?.pi?.unavailableReason).toContain('bridge');
  });

  it('leaves Claude unlaunchable under a bridge without RAC_HOST_REPOSITORY', async () => {
    setEnv('RAC_HOST_TMUX_DIR', '/host/tmux'); setEnv('RAC_HOST_REPOSITORY', undefined);
    const config = await validateConfig({ ...scratch, adapters: { claude: { program: '/abs/claude' } } });
    expect(config.adapters?.claude).toMatchObject({ launchable: false });
    expect(config.adapters?.claude?.unavailableReason).toContain('RAC_HOST_REPOSITORY');
  });

  it('launches Claude under a bridge once RAC_HOST_REPOSITORY names the host checkout', async () => {
    setEnv('RAC_HOST_TMUX_DIR', '/host/tmux'); setEnv('RAC_HOST_REPOSITORY', '/host/checkout');
    const config = await validateConfig({ ...scratch, adapters: { claude: { program: '/abs/claude' } } });
    expect(config.adapters?.claude).toMatchObject({ launchable: true });
  });
});

describe('omx adapter configuration', () => {
  const scratch = { publicOrigin: 'https://agents.example.com', projects: [] as unknown[] };
  // two executable stand-ins named like the real programs, so only the name-based warnings fire
  const programsNamed = async (...names: string[]): Promise<string[]> => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-omx-cfg-')));
    dirs.push(root);
    return Promise.all(names.map(async name => { const path = join(root, name); await writeFile(path, '#!/bin/sh\n', { mode: 0o755 }); return path; }));
  };

  it('accepts adapters.omx beside adapters.codex, each with its own lifecycle commands', async () => {
    const [codex, omx] = await programsNamed('codex', 'omx');
    const warnings: string[] = [];
    const lifecycle = { setup: 'rm -f .omx/state/session.json', teardown: 'rm -f .omx/state/session.json' };
    const config = await validateConfig({ ...scratch, adapters: { codex: { program: codex! }, omx: { program: omx!, ...lifecycle } } }, { warn: m => warnings.push(m) });
    expect(config.adapters?.omx).toEqual({ program: omx, args: [], env: {}, launchable: true, ...lifecycle });
    expect(config.adapters?.codex).toEqual({ program: codex, args: [], env: {}, launchable: true });
    expect(warnings).toEqual([]);
  });

  it('warns about and drops the tmux-policy flags the OMX Adapter composes itself', async () => {
    const [omx] = await programsNamed('omx');
    const warnings: string[] = [];
    const config = await validateConfig({ ...scratch, adapters: { omx: { program: omx!, args: ['--direct', '--preset=minimal', '--tmux'] } } }, { warn: m => warnings.push(m) });
    expect(config.adapters?.omx?.args).toEqual(['--preset=minimal']);
    expect(warnings).toEqual(['adapters.omx: ignoring reserved arguments --direct, --tmux']);
  });

  it('warns when adapters.codex points at OMX and when adapters.omx points at plain Codex', async () => {
    const [codex, omx, omxJs] = await programsNamed('codex', 'omx', 'omx.js');
    const crossed: string[] = [];
    await validateConfig({ ...scratch, adapters: { codex: { program: omx! }, omx: { program: codex! } } }, { warn: m => crossed.push(m) });
    expect(crossed).toEqual([
      'adapters.codex.program looks like OMX; configure it under adapters.omx so it is recognised, badged and torn down as OMX',
      'adapters.omx.program looks like plain Codex; configure it under adapters.codex so it is recognised, badged and torn down as Codex'
    ]);
    // the packaged CLI entry counts as OMX too, and a lone legacy OMX-under-codex config warns the same way
    const legacy: string[] = [];
    await validateConfig({ ...scratch, adapters: { codex: { program: omxJs! } } }, { warn: m => legacy.push(m) });
    expect(legacy).toEqual([expect.stringContaining('adapters.codex.program looks like OMX')]);
  });
});

describe('review configuration', () => {
  const scratch = { publicOrigin: 'https://agents.example.com', projects: [] as unknown[] };
  const codex = { codex: { program: process.execPath } };
  const claude = { claude: { program: process.execPath } };
  const both = { ...codex, ...claude };
  const preset = (extra: Record<string, unknown> = {}) => ({ id: 'deep', label: 'Deep', agent: 'claude', prompt: 'Look hard.', ...extra });

  it('defaults to headless runs, a Codex tour and one built-in Correctness preset on the tour agent', async () => {
    const config = await validateConfig({ ...scratch, adapters: both });
    expect(config.review.agents).toEqual({ codex: { mode: 'headless' }, claude: { mode: 'headless' } });
    expect(config.review.tour).toEqual({ agent: 'codex', prompt: builtInTourPrompt });
    expect(config.review.presets).toEqual([{ id: 'correctness', label: 'Correctness', agent: 'codex', prompt: builtInCorrectnessPrompt }]);
    expect(config.review.defaultPreset).toBe('correctness');
  });

  it('falls back to Claude without Codex, and to an unavailable Codex with neither', async () => {
    expect((await validateConfig({ ...scratch, adapters: claude })).review.tour.agent).toBe('claude');
    expect((await validateConfig({ ...scratch, adapters: claude })).review.presets[0]!.agent).toBe('claude');
    expect((await validateConfig(scratch)).review.tour.agent).toBe('codex');
  });

  it('carries configured modes, tour settings, presets and the default preset', async () => {
    const config = await validateConfig({ ...scratch, adapters: both, review: { agents: { claude: { mode: 'interactive' } }, tour: { agent: 'claude', model: 'claude-opus-4-1[1m]', effort: 'max', prompt: 'Narrate it.' }, presets: [{ id: 'quick', label: 'Quick', agent: 'codex', effort: 'minimal', prompt: 'Skim.' }, preset({ model: 'opus' })], defaultPreset: 'deep' } });
    expect(config.review.agents).toEqual({ codex: { mode: 'headless' }, claude: { mode: 'interactive' } });
    expect(config.review.tour).toEqual({ agent: 'claude', model: 'claude-opus-4-1[1m]', effort: 'max', prompt: 'Narrate it.' });
    expect(config.review.presets).toEqual([{ id: 'quick', label: 'Quick', agent: 'codex', effort: 'minimal', prompt: 'Skim.' }, { id: 'deep', label: 'Deep', agent: 'claude', model: 'opus', prompt: 'Look hard.' }]);
    expect(config.review.defaultPreset).toBe('deep');
    expect((await validateConfig({ ...scratch, adapters: both, review: { presets: [preset()] } })).review.defaultPreset).toBe('deep');
  });

  it('refuses unconfigured or unknown agents and efforts the agent does not accept', async () => {
    await expect(validateConfig({ ...scratch, adapters: codex, review: { tour: { agent: 'claude' } } })).rejects.toThrow('review.tour runs on claude, which is not configured');
    await expect(validateConfig({ ...scratch, adapters: codex, review: { presets: [preset()] } })).rejects.toThrow('review.presets.deep runs on claude');
    await expect(validateConfig({ ...scratch, adapters: { ...both, omx: { program: process.execPath } }, review: { tour: { agent: 'omx' } } })).rejects.toThrow();
    await expect(validateConfig({ ...scratch, adapters: codex, review: { tour: { effort: 'max' } } })).rejects.toThrow("effort `max` is not one of codex's levels");
    await expect(validateConfig({ ...scratch, adapters: both, review: { presets: [preset({ effort: 'minimal' })] } })).rejects.toThrow("not one of claude's levels");
  });

  it('refuses duplicate preset ids, an unknown default preset and out-of-bounds fields', async () => {
    await expect(validateConfig({ ...scratch, adapters: both, review: { presets: [preset(), preset()] } })).rejects.toThrow('duplicate id `deep`');
    await expect(validateConfig({ ...scratch, adapters: both, review: { defaultPreset: 'deep' } })).rejects.toThrow('review.defaultPreset `deep` names no preset');
    await expect(validateConfig({ ...scratch, adapters: both, review: { presets: [preset({ id: 'has space' })] } })).rejects.toThrow('preset ids');
    await expect(validateConfig({ ...scratch, adapters: both, review: { presets: [preset({ label: 'x'.repeat(81) })] } })).rejects.toThrow();
    await expect(validateConfig({ ...scratch, adapters: both, review: { presets: [preset({ prompt: 'x'.repeat(8_001) })] } })).rejects.toThrow();
    await expect(validateConfig({ ...scratch, adapters: both, review: { tour: { model: '--dangerous' } } })).rejects.toThrow('model names');
    await expect(validateConfig({ ...scratch, adapters: both, review: { agents: { codex: { mode: 'sometimes' } } } })).rejects.toThrow();
    await expect(validateConfig({ ...scratch, adapters: both, review: { extra: true } })).rejects.toThrow(/[Uu]nrecognized/);
  });
});

describe('Conductor configuration', () => {
  const pi = { pi: { allowedModels: [{ model: 'openai/gpt-5.6', effort: 'medium' }, { model: 'openrouter/z/glm' }] } };
  // a console whose `conductor` lives in a directory Project `home`, beside a repository Project `code`
  const configured = async (conductor: Record<string, unknown>, adapters: Record<string, unknown> = pi) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'rac-conductor-')));
    dirs.push(home);
    return { publicOrigin: 'https://agents.example.com', adapters, projects: [{ id: 'home', path: home }, { id: 'code', path: await gitRepo() }], conductor };
  };

  it('runs Pi in a directory Project on an Allowed model, with every scope but admin:dangerous by default', async () => {
    const config = await validateConfig(await configured({ kind: 'pi', project: 'home', model: 'openrouter/z/glm' }));
    expect(config.conductor).toEqual({ kind: 'pi', projectId: 'home', model: 'openrouter/z/glm', scopes: ['status:read', 'logs:read', 'files:read', 'prompts:write', 'agents:control', 'stack:operate', 'review:write'], maxWorkers: 4, maxSelfStartedTurnsPerHour: 30, scriptDeadlineMinutes: 10 });
    const chosen = await validateConfig(await configured({ kind: 'pi', project: 'home', model: 'openai/gpt-5.6', effort: 'high', scopes: ['status:read'], maxWorkers: 2, maxSelfStartedTurnsPerHour: 5, scriptDeadlineMinutes: 3 }));
    expect(chosen.conductor).toEqual({ kind: 'pi', projectId: 'home', model: 'openai/gpt-5.6', effort: 'high', scopes: ['status:read'], maxWorkers: 2, maxSelfStartedTurnsPerHour: 5, scriptDeadlineMinutes: 3 });
    expect((await validateConfig({ publicOrigin: 'https://agents.example.com' })).conductor).toBeUndefined();
  });

  it('refuses another kind, a model that is not Allowed, a repository or unknown Project, an unknown scope, and Pi left unconfigured', async () => {
    await expect(validateConfig(await configured({ kind: 'claude', project: 'home', model: 'openai/gpt-5.6' }))).rejects.toThrow();
    await expect(validateConfig(await configured({ kind: 'pi', project: 'home', model: 'openai/gpt-4' }))).rejects.toThrow(/Allowed model/u);
    await expect(validateConfig(await configured({ kind: 'pi', project: 'code', model: 'openai/gpt-5.6' }))).rejects.toThrow(/directory Project/u);
    await expect(validateConfig(await configured({ kind: 'pi', project: 'nowhere', model: 'openai/gpt-5.6' }))).rejects.toThrow(/directory Project/u);
    await expect(validateConfig(await configured({ kind: 'pi', project: 'home', model: 'openai/gpt-5.6', scopes: ['everything'] }))).rejects.toThrow();
    await expect(validateConfig(await configured({ kind: 'pi', project: 'home', model: 'openai/gpt-5.6' }, {}))).rejects.toThrow(/adapters\.pi/u);
  });
});
