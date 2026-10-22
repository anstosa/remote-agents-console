import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gitCommonDir, type GitRun } from '../git/worktrees.js';
import { run } from '../tmux/command.js';
import { interactiveShellPath } from '../tmux/interactive-shell.js';
import { validateConfig } from '../config/schema.js';
import { serverCheckout } from '../workspaces/server-checkout.js';
import {
  DataFileError,
  isLegacyConfig,
  planMigration,
  resolutionRequests,
  rewriteListStore,
  rewriteReviewTours,
  rewriteWorktreeRecords,
  type CommandResolution,
  type EntryFacts,
  type MigrationPlan,
  type ResolvedFacts,
} from './worktrees-to-projects.js';

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A migration that cannot proceed: every content or writability problem, listed. */
export class MigrationError extends Error {
  constructor(public readonly errors: string[]) { super(errors.join('\n')); this.name = 'MigrationError'; }
}

/** One `.data` store the migration re-keys, resolved to its on-disk path. */
type Store = { key: string; file: string; rewrite: (raw: unknown, plan: MigrationPlan, warnings: string[]) => { value: Record<string, unknown>; count: number }; createForWorktreeState?: boolean };

/** The resolved paths of every re-keyed `.data` store; each defaults to its store's own default. */
export type DataFilePaths = Partial<Record<'notes' | 'savedPrompts' | 'queued' | 'history' | 'reviewTours' | 'worktrees', string>>;

export type MigrationDeps = {
  /** the config read path — `RAC_CONFIG`. */
  configPath: string;
  /** the config write target — `RAC_CONFIG_WRITE_PATH`; a value that differs from `configPath` is unwritable. */
  configWritePath?: string;
  /** per-store file overrides; each falls back to the store's env var / default. */
  dataFiles?: DataFilePaths;
  /** the host bridge cannot resolve host program names from the container; defer them. */
  bridge?: boolean;
  /** `config:check --compose`: report bare program names as resolved at boot rather than resolving them. */
  compose?: boolean;
  /** injectable git runner (tests stub it). */
  git?: GitRun;
  /** injectable bare-name resolver (tests stub it). */
  resolveCommand?: (name: string) => Promise<CommandResolution>;
  /** a pre-parsed config to plan against instead of the on-disk one (`config:check --compose` host mapping). */
  raw?: unknown;
  env?: NodeJS.ProcessEnv;
};

/** What the migration did (or would do), for the boot log and the dry run. */
export type MigrationReport = {
  projects: { id: string; mergedFrom: string[] }[];
  codexProgram?: string;
  counts: Record<string, number>;
  backups: string[];
  warnings: string[];
};

// resolve one store's path: an explicit override, else its env var, else its default
function storePath(key: keyof DataFilePaths, envVar: string, fallback: string, deps: MigrationDeps): string {
  const env = deps.env ?? process.env;
  return deps.dataFiles?.[key] ?? env[envVar] ?? fallback;
}

// match each runtime store's default without relying on the migration process cwd
function stores(deps: MigrationDeps): Store[] {
  return [
    { key: 'notes', file: storePath('notes', 'RAC_NOTES_FILE', '.data/notes.json', deps), rewrite: (raw, plan) => rewriteListStore(raw, plan.keyMaps.notes) },
    { key: 'saved-prompts', file: storePath('savedPrompts', 'RAC_SAVED_PROMPTS_FILE', '.data/saved-prompts.json', deps), rewrite: (raw, plan) => rewriteListStore(raw, plan.keyMaps.savedPrompts) },
    { key: 'queued-prompts', file: storePath('queued', 'RAC_QUEUED_PROMPTS_FILE', '.data/queued-prompts.json', deps), rewrite: (raw, plan) => rewriteListStore(raw, plan.keyMaps.queued) },
    { key: 'prompt-history', file: storePath('history', 'RAC_PROMPT_HISTORY_FILE', '.data/prompt-history.json', deps), rewrite: (raw, plan) => rewriteListStore(raw, plan.keyMaps.history) },
    { key: 'review-tours', file: storePath('reviewTours', 'RAC_REVIEW_TOURS_FILE', '.data/review-tours.json', deps), rewrite: (raw, plan, warnings) => rewriteReviewTours(raw, plan.keyMaps.reviewTours, warnings) },
    { key: 'worktrees', file: storePath('worktrees', 'RAC_WORKTREES_FILE', join(serverCheckout(deps.env), '.data/worktrees.json'), deps), rewrite: (raw, plan) => rewriteWorktreeRecords(raw, plan.keyMaps.worktrees, plan.pins, plan.labels), createForWorktreeState: true },
  ];
}

// realpath, git toplevel, common dir and Main-vs-Linked for one entry path
async function resolveEntryFacts(path: string, git: GitRun): Promise<EntryFacts> {
  const canonical = await realpath(path).catch(() => undefined);
  if (canonical === undefined) return {};
  const commonDir = await gitCommonDir(canonical, git);
  if (commonDir === undefined) return { realpath: canonical };
  const topResult = await git('/usr/bin/git', ['-C', canonical, 'rev-parse', '--path-format=absolute', '--show-toplevel']);
  const toplevel = topResult.code === 0 ? await realpath(topResult.stdout.trim()).catch(() => topResult.stdout.trim()) : canonical;
  const gitDirResult = await git('/usr/bin/git', ['-C', canonical, 'rev-parse', '--path-format=absolute', '--git-dir']);
  const gitDir = gitDirResult.code === 0 ? await realpath(gitDirResult.stdout.trim()).catch(() => gitDirResult.stdout.trim()) : undefined;
  return { realpath: canonical, toplevel, commonDir, main: gitDir === undefined ? undefined : gitDir === commonDir };
}

// resolve one bare program name through the operator's interactive shell, exactly the
// environment launches run in; deferred under the bridge or a Compose dry run
async function resolveCommandName(name: string, deps: MigrationDeps): Promise<CommandResolution> {
  if (deps.resolveCommand !== undefined) return deps.resolveCommand(name);
  if (deps.bridge || deps.compose) return { kind: 'deferred' };
  const shell = interactiveShellPath();
  const result = await execute(shell, ['-ic', `command -v ${quote(name)}`], { timeout: 5_000 }).then(
    output => ({ code: 0, stdout: output.stdout }),
    (error: { code?: number; stdout?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? '' }),
  );
  const output = result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '').pop() ?? '';
  if (result.code !== 0 || output === '') return { kind: 'missing' };
  return output.startsWith('/') ? { kind: 'absolute', path: output } : { kind: 'alias', value: output };
}

async function resolveFacts(raw: unknown, deps: MigrationDeps): Promise<ResolvedFacts> {
  const git = deps.git ?? ((command, args) => run(command, args));
  const requests = resolutionRequests(raw);
  const entries = await Promise.all(requests.paths.map(path => resolveEntryFacts(path, git)));
  const commands: Record<string, CommandResolution> = {};
  for (const name of requests.programNames) commands[name] = await resolveCommandName(name, deps);
  return { entries, commands };
}

/**
 * One data store's planned rewrite: the parsed content, its re-keyed form, and whether the
 * migration would write it. A missing file is skipped unless the worktrees store must be
 * created to hold config pins or labels; an unparseable or non-object file is a content error.
 */
type PlannedStore = { store: Store; originalText?: string; value: Record<string, unknown>; changed: boolean; count: number };

async function planStore(store: Store, plan: MigrationPlan, warnings: string[], errors: string[]): Promise<PlannedStore | undefined> {
  let originalText: string | undefined;
  try { originalText = await readFile(store.file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { errors.push(`${store.file}: ${(error as Error).message}`); return undefined; } }
  // a missing file is never created, except when migrated Worktree state needs a home
  const stateNeedsFile = store.createForWorktreeState === true && (Object.keys(plan.pins).length > 0 || Object.keys(plan.labels).length > 0);
  if (originalText === undefined && !stateNeedsFile) return undefined;
  let parsed: unknown = {};
  if (originalText !== undefined) {
    try { parsed = JSON.parse(originalText); }
    catch { errors.push(`${store.file} is not valid JSON`); return undefined; }
  }
  try {
    const { value, count } = store.rewrite(parsed, plan, warnings);
    return { store, originalText, value, changed: count > 0 || stateNeedsFile, count };
  } catch (error) {
    if (error instanceof DataFileError) { errors.push(`${store.file}: ${error.message}`); return undefined; }
    throw error;
  }
}

/** Resolve the raw config (or a caller-supplied one), every fact, the plan, and each store's rewrite. */
async function prepare(deps: MigrationDeps): Promise<{ plan: MigrationPlan; planned: PlannedStore[]; errors: string[] }> {
  let raw: unknown;
  if (deps.raw !== undefined) raw = deps.raw;
  else {
    const rawText = await readFile(deps.configPath, 'utf8');
    try { raw = JSON.parse(rawText); } catch { throw new MigrationError([`${deps.configPath} is not valid JSON`]); }
  }
  const facts = await resolveFacts(raw, deps);
  const plan = planMigration(raw, facts);
  const errors = [...plan.errors];
  const planned: PlannedStore[] = [];
  for (const store of stores(deps)) {
    const result = await planStore(store, plan, plan.warnings, errors);
    if (result !== undefined) planned.push(result);
  }
  return { plan, planned, errors };
}

// the nearest existing ancestor directory of a target, which a recursive mkdir + rename
// needs writable (every write here is rename-based, so the directory is what must be writable)
async function nearestExistingDir(target: string): Promise<string> {
  let directory = dirname(target);
  while (!await access(directory, constants.F_OK).then(() => true).catch(() => false)) {
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return directory;
}

// treat a differing config write path as unwritable, then probe every target's directory —
// each write is `.next`/`.tmp` + rename with a `wx` backup, so directory write permission is
// what every one of them requires and what pre-flight must confirm before anything is written
async function unwritableTargets(deps: MigrationDeps, changedFiles: string[]): Promise<string[]> {
  const problems: string[] = [];
  const configWrite = deps.configWritePath ?? deps.configPath;
  if (configWrite !== deps.configPath) problems.push(`config write path ${configWrite} differs from read path ${deps.configPath}; the migrated config would never be read back`);
  const targets = configWrite === deps.configPath ? [deps.configPath, ...changedFiles] : changedFiles;
  const directories = new Set(await Promise.all(targets.map(nearestExistingDir)));
  for (const directory of directories) if (!await access(directory, constants.W_OK).then(() => true).catch(() => false)) problems.push(`cannot write into ${directory}`);
  return problems;
}

// write a sibling <file>.pre-projects.bak with the original bytes, never overwriting an
// existing backup (the older original wins); returns the backup path when one was written
async function backup(file: string, original: string): Promise<string | undefined> {
  const path = `${file}.pre-projects.bak`;
  try { await writeFile(path, original, { flag: 'wx', mode: 0o600 }); return path; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const next = `${file}.next`;
  await writeFile(next, content, { mode: 0o600 });
  await rename(next, file);
}

async function writeConfig(deps: MigrationDeps, config: Record<string, unknown>): Promise<void> {
  const target = deps.configWritePath ?? deps.configPath;
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function buildReport(plan: MigrationPlan, planned: PlannedStore[], backups: string[]): MigrationReport {
  const counts: Record<string, number> = {};
  for (const entry of planned) if (entry.changed) counts[entry.store.key] = entry.count;
  return { projects: plan.projectsCreated, ...(plan.codexProgram === undefined ? {} : { codexProgram: plan.codexProgram }), counts, backups, warnings: plan.warnings };
}

/**
 * Run the migration: plan, validate the output against the schema, pre-flight every write,
 * then write backups → data files → the config last (the commit marker). Refuses with every
 * problem listed and nothing written on any content or writability error. Returns the report.
 */
export async function runMigration(deps: MigrationDeps): Promise<MigrationReport> {
  const { plan, planned, errors } = await prepare(deps);
  // schema validation of the output; a validation failure is a migration error
  if (errors.length === 0) {
    try { await validateConfig(plan.newConfig, { checkExecutables: false }); }
    catch (error) { errors.push((error as Error).message); }
  }
  if (errors.length > 0) throw new MigrationError(errors);
  const changedFiles = planned.filter(entry => entry.changed).map(entry => entry.store.file);
  const unwritable = await unwritableTargets(deps, changedFiles);
  if (unwritable.length > 0) throw new MigrationError([...unwritable, 'fix: mount it rw under Docker; or move the config somewhere writable and point RAC_CONFIG at it; or run `pnpm config:migrate` as a user who can write it']);
  // backups first (config included), then data files, then the config last
  const backups: string[] = [];
  const configBackup = await backup(deps.configWritePath ?? deps.configPath, await readFile(deps.configPath, 'utf8'));
  if (configBackup !== undefined) backups.push(configBackup);
  for (const entry of planned) if (entry.changed && entry.originalText !== undefined) { const path = await backup(entry.store.file, entry.originalText); if (path !== undefined) backups.push(path); }
  for (const entry of planned) if (entry.changed) await writeAtomic(entry.store.file, JSON.stringify(entry.value));
  await writeConfig(deps, plan.newConfig);
  return buildReport(plan, planned, backups);
}

/** The dry-run report for `config:check`: the plan and per-store counts, plus any errors, without writing. */
export type MigrationDryRun = { report: MigrationReport; errors: string[]; newConfig: Record<string, unknown> };

/** Plan the migration and, off the bridge/Compose, validate the output — but write nothing. */
export async function dryRunMigration(deps: MigrationDeps): Promise<MigrationDryRun> {
  const { plan, planned, errors } = await prepare(deps);
  // validate the output against the schema except under Compose, where programs are container paths
  if (errors.length === 0 && deps.compose !== true) {
    try { await validateConfig(plan.newConfig, { checkExecutables: false }); }
    catch (error) { errors.push((error as Error).message); }
  }
  return { report: buildReport(plan, planned, []), errors, newConfig: plan.newConfig };
}

export { isLegacyConfig };
