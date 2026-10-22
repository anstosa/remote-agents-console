import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../src/tmux/command.js';
import { dryRunMigration, MigrationError, runMigration, type DataFilePaths, type MigrationDeps } from '../src/migrations/runner.js';
import type { CommandResolution } from '../src/migrations/worktrees-to-projects.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); } });
const git = async (cwd: string, ...args: string[]) => { const r = await run('/usr/bin/git', ['-C', cwd, ...args]); if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`); return r.stdout.trim(); };

// a temp git repository with one commit; the returned root is realpath'd to match discovery
async function workspace(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-mig-')));
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

const codex: Record<string, CommandResolution> = { codex: { kind: 'absolute', path: '/usr/bin/codex' } };
// isolate every implicit store from live process state
const deps = (configPath: string, dataFiles: DataFilePaths, commands = codex, extra: Partial<MigrationDeps> = {}): MigrationDeps => {
  const dataRoot = join(dirname(configPath), '.data');
  const isolatedDataFiles: DataFilePaths = {
    notes: join(dataRoot, 'notes.json'),
    savedPrompts: join(dataRoot, 'saved-prompts.json'),
    queued: join(dataRoot, 'queued-prompts.json'),
    history: join(dataRoot, 'prompt-history.json'),
    reviewTours: join(dataRoot, 'review-tours.json'),
    worktrees: join(dataRoot, 'worktrees.json'),
    ...dataFiles,
    ...extra.dataFiles,
  };
  return { configPath, resolveCommand: async name => commands[name] ?? { kind: 'missing' }, ...extra, dataFiles: isolatedDataFiles };
};
const exists = (path: string) => readFile(path, 'utf8').then(() => true, () => false);
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('runMigration', () => {
  // keep migration and runtime defaults on the same persistent checkout
  it('rekeys the default worktrees store under the injected server checkout', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'codex' }] }));
    const file = join(repo, '.data/worktrees.json');
    const record = { label: 'Custom name', pinned: false, launchProfile: 'codex' };
    await mkdir(join(repo, '.data'));
    await writeFile(file, JSON.stringify({ a: record }));
    const migration = deps(configPath, { worktrees: undefined }, codex, { env: { RAC_SERVER_CHECKOUT: repo } });
    // prove the default read path without risking a write to the process checkout
    const { report, errors } = await dryRunMigration(migration);
    expect(errors).toEqual([]);
    expect(report.counts.worktrees).toBe(1);
    await runMigration(migration);
    expect(await readJson(file)).toEqual({ [`a:${repo}`]: record });
  });

  it('migrates a full legacy config and re-keys the data files, leaving backups', async () => {
    const { root, repo } = await workspace();
    const wt = join(root, 'repo-wt');
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', newAgentCommand: 'codex', worktrees: [{ id: 'main', path: repo, saveKey: 'main', command: 'codex' }, { id: 'wt', path: wt, command: 'codex' }] }));
    const notes = join(root, 'notes.json');
    const queued = join(root, 'queued.json');
    const saved = join(root, 'saved.json');
    await writeFile(notes, JSON.stringify({ main: [{ id: 'note00000001', text: 'x' }] }));
    await writeFile(queued, JSON.stringify({ 'worktree:main': [{ id: 'qp0000000001', text: 'q', createdAt: '2026-01-01T00:00:00Z' }] }));
    await writeFile(saved, JSON.stringify({ 'worktree:main': [{ id: 'sp0000000001', text: 's' }] }));

    const result = await runMigration(deps(configPath, { notes, queued, savedPrompts: saved }));

    const configText = await readFile(configPath, 'utf8');
    // the config is written 2-space indented with a trailing newline (human-editable)
    expect(configText).toBe(`${JSON.stringify(JSON.parse(configText), null, 2)}\n`);
    const config = JSON.parse(configText) as Record<string, unknown>;
    expect(config).not.toHaveProperty('worktrees');
    expect(config).not.toHaveProperty('newAgentCommand');
    expect(config.projects).toEqual([{ id: 'main', path: repo }]);
    expect(config.adapters).toEqual({ codex: { program: '/usr/bin/codex' } });
    // queued prompts and saved prompts both re-key onto the worktree wire id (Worktree-scoped)
    expect(Object.keys(await readJson(queued))).toEqual([`main:${repo}`]);
    expect(Object.keys(await readJson(saved))).toEqual([`main:${repo}`]);
    // backups written for every rewritten file
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(true);
    expect(await exists(`${queued}.pre-projects.bak`)).toBe(true);
    expect(result.projects).toEqual([{ id: 'main', mergedFrom: ['main', 'wt'] }]);
    expect(result.codexProgram).toBe('/usr/bin/codex');
  });

  it('rewrites the config only when the data is already keyed by Project', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', newAgentCommand: 'codex', projects: [{ id: 'p', path: repo }] }));
    const notes = join(root, 'notes.json');
    await writeFile(notes, JSON.stringify({ p: [{ id: 'note00000001', text: 'x' }] }));

    await runMigration(deps(configPath, { notes }));

    const config = await readJson(configPath);
    expect(config).not.toHaveProperty('newAgentCommand');
    expect(config.adapters).toEqual({ codex: { program: '/usr/bin/codex' } });
    expect(config.projects).toEqual([{ id: 'p', path: repo }]);
    // the data file had no legacy key: untouched, no backup
    expect(await exists(`${notes}.pre-projects.bak`)).toBe(false);
  });

  it('refuses with nothing written when the config directory is not writable', async () => {
    const { root, repo } = await workspace();
    const locked = join(root, 'locked');
    await mkdir(locked);
    const configPath = join(locked, 'config.json');
    const original = JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'codex' }] });
    await writeFile(configPath, original);
    await chmod(locked, 0o500);

    await expect(runMigration(deps(configPath, {}))).rejects.toBeInstanceOf(MigrationError);
    await chmod(locked, 0o700);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(false);
  });

  it('migrates a read-only config file in a writable directory (rename replaces it)', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'codex' }] }));
    await chmod(configPath, 0o444);

    await runMigration(deps(configPath, {}));
    expect(await readJson(configPath)).toHaveProperty('projects');
  });

  it('isolates unspecified data stores from process environment paths', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    const poisonedHistory = join(root, 'poisoned-prompt-history.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'codex' }] }));
    await writeFile(poisonedHistory, '{ not valid json');
    vi.stubEnv('RAC_PROMPT_HISTORY_FILE', poisonedHistory);

    try {
      await runMigration(deps(configPath, {}));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(await readJson(configPath)).toHaveProperty('projects');
    expect(await readFile(poisonedHistory, 'utf8')).toBe('{ not valid json');
  });

  it('refuses with nothing written on a corrupt data file', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    const original = JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, saveKey: 'a', command: 'codex' }] });
    await writeFile(configPath, original);
    const notes = join(root, 'notes.json');
    await writeFile(notes, '{ this is not json');

    await expect(runMigration(deps(configPath, { notes }))).rejects.toThrow(/not valid JSON/);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(false);
  });

  it('never overwrites an existing backup', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'codex' }] }));
    await writeFile(`${configPath}.pre-projects.bak`, 'ORIGINAL BACKUP');

    await runMigration(deps(configPath, {}));

    expect(await readFile(`${configPath}.pre-projects.bak`, 'utf8')).toBe('ORIGINAL BACKUP');
    expect(await readJson(configPath)).toHaveProperty('projects');
  });

  it('refuses when a bare program name cannot be resolved, writing nothing', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    const original = JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'ghost-cli' }] });
    await writeFile(configPath, original);

    await expect(runMigration(deps(configPath, {}, {}))).rejects.toThrow(/ghost-cli/);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(false);
  });

  it('refuses when the config write path differs from the read path', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    const original = JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, command: 'codex' }] });
    await writeFile(configPath, original);

    await expect(runMigration({ ...deps(configPath, {}), configWritePath: join(root, 'elsewhere.json') })).rejects.toThrow(/differs from read path/);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(false);
    expect(await exists(join(root, 'elsewhere.json'))).toBe(false);
  });

  it('creates the worktrees store to hold a migrated config pin', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    // a Main checkout explicitly unpinned differs from the default, so a record is written
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, pinned: false, command: 'codex' }] }));
    const worktrees = join(root, 'worktrees.json');

    await runMigration(deps(configPath, { worktrees }));

    expect(await readJson(worktrees)).toEqual({ [`a:${repo}`]: { pinned: false } });
  });

  it('creates the worktrees store to preserve a migrated worktree label', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', label: '🥔 Dave', path: repo, command: 'codex' }] }));
    const worktrees = join(root, 'worktrees.json');

    await runMigration(deps(configPath, { worktrees }));

    expect(await readJson(worktrees)).toEqual({ [`a:${repo}`]: { label: '🥔 Dave' } });
  });
});

describe('dryRunMigration', () => {
  it('reports the plan and counts without writing', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    const original = JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, saveKey: 'a', command: 'codex' }] });
    await writeFile(configPath, original);
    const notes = join(root, 'notes.json');
    await writeFile(notes, JSON.stringify({ a: [{ id: 'note00000001', text: 'x' }] }));

    const { report, errors, newConfig } = await dryRunMigration(deps(configPath, { notes }));

    expect(errors).toEqual([]);
    expect(newConfig).toHaveProperty('projects');
    expect(report.counts.notes).toBe(1);
    // nothing written
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await exists(`${configPath}.pre-projects.bak`)).toBe(false);
  });

  it('collects a schema validation error from the migrated output', async () => {
    const { root, repo } = await workspace();
    const configPath = join(root, 'config.json');
    // a port without a hostname is carried through to the Project and the schema refuses it
    await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://x', worktrees: [{ id: 'a', path: repo, port: 3000, command: 'codex' }] }));

    const { errors } = await dryRunMigration(deps(configPath, {}));
    expect(errors.some(error => error.includes('port and hostname'))).toBe(true);
  });
});
