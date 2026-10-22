import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { checkMain } from '../src/config/check.js';
import { migrateMain } from '../src/config/migrate.js';
import { acquireConfig } from '../src/migrations/boot.js';
import type { CliContext } from '../src/config/cli.js';
import { defaultButtons } from '../src/config/buttons.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`); return r.stdout.trim(); };

async function gitRepo(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-cli-')));
  dirs.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'readme.md'), 'hi\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
  return { root, repo };
}

// data-file env pointing every store under the temp root, so no test touches the real .data
const dataEnv = (root: string): NodeJS.ProcessEnv => ({
  RAC_NOTES_FILE: join(root, 'notes.json'),
  RAC_SAVED_PROMPTS_FILE: join(root, 'saved.json'), RAC_QUEUED_PROMPTS_FILE: join(root, 'queued.json'),
  RAC_PROMPT_HISTORY_FILE: join(root, 'history.json'), RAC_REVIEW_TOURS_FILE: join(root, 'tours.json'),
  RAC_WORKTREES_FILE: join(root, 'worktrees.json'),
});
// a capturing CLI context whose data files live under the temp root, never the real .data
function context(root: string, args: string[]): CliContext & { stdout: () => string; stderr: () => string } {
  const out: string[] = []; const err: string[] = [];
  return { args, env: dataEnv(root), cwd: root, out: m => out.push(m), err: m => err.push(m), stdout: () => out.join(''), stderr: () => err.join('') };
}
const exists = (path: string) => readFile(path, 'utf8').then(() => true, () => false);

describe('config:migrate (migrateMain)', () => {
  it('migrates a legacy config in place and reports the plan', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: '/usr/bin/codex' }] }));
    const ctx = context(root, [configPath]);

    expect(await migrateMain(ctx)).toBe(0);
    expect(ctx.stdout()).toContain('Configuration migrated');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toHaveProperty('projects');
    expect(config.adapters).toEqual({ codex: { program: '/usr/bin/codex' } });
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(true);
  });

  it('reports nothing to do for a config already in the new shape', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', buttons: defaultButtons, adapters: { codex: { program: '/usr/bin/codex' } }, projects: [{ id: 'a', path: repo }] }));
    const ctx = context(root, [configPath]);

    expect(await migrateMain(ctx)).toBe(0);
    expect(ctx.stdout()).toContain('nothing to migrate');
  });

  it('exits 1 listing a content error, writing nothing', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    const original = JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'ghost-cli' }] });
    await writeFile(configPath, original);
    const ctx = context(root, [configPath]);

    expect(await migrateMain(ctx)).toBe(1);
    expect(ctx.stderr()).toContain('Configuration invalid');
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});

describe('config:check (checkMain) on a legacy config', () => {
  it('prints the migration plan and exits 0 with only warnings', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: '/usr/bin/codex' }] }));
    const ctx = context(root, [configPath]);

    expect(await checkMain(ctx)).toBe(0);
    expect(ctx.stdout()).toContain('Configuration migration plan');
    // a dry run never writes
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(false);
  });

  it('exits 1 listing a content error', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, port: 3000, command: '/usr/bin/codex' }] }));
    const ctx = context(root, [configPath]);

    expect(await checkMain(ctx)).toBe(1);
    expect(ctx.stderr()).toContain('Configuration invalid');
  });

  it('still validates a config already in the new shape', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', buttons: defaultButtons, adapters: { codex: { program: '/usr/bin/codex' } }, projects: [{ id: 'a', path: repo }] }));
    const ctx = context(root, [configPath]);

    expect(await checkMain(ctx)).toBe(0);
    expect(ctx.stdout()).toContain('Configuration valid');
  });
});

describe('acquireConfig', () => {
  it('skips a config already in the new shape, writing no backup', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', buttons: defaultButtons, adapters: { codex: { program: '/usr/bin/codex' } }, projects: [{ id: 'a', path: repo }] }));
    const logs: string[] = [];

    const config = await acquireConfig({ RAC_CONFIG: configPath, ...dataEnv(root) }, message => { logs.push(message); });
    expect(config.projects[0]!.id).toBe('a');
    expect(logs.some(line => line.includes('migrated'))).toBe(false);
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(false);
  });

  it('migrates a legacy config and returns the validated result', async () => {
    const { root, repo } = await gitRepo();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: '/usr/bin/codex' }] }));
    const logs: string[] = [];

    const config = await acquireConfig({ RAC_CONFIG: configPath, ...dataEnv(root) }, message => { logs.push(message); });
    expect(config.projects[0]!.id).toBe('a');
    expect(config.adapters?.codex?.program).toBe('/usr/bin/codex');
    expect(logs.some(line => line.includes('Configuration migrated'))).toBe(true);
  });
});
