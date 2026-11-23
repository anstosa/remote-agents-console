import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter } from '../adapters/types.js';
import type { RuntimeCommandCatalog } from './codex-app-server.js';

/**
 * The prompt-box command catalog, served per Agent from the Adapter (ADR 0002).
 * The web no longer carries hard-coded `$skill`/`/slash` arrays: the console
 * asks the agent runtime for its effective skill catalog and dynamic commands,
 * invokes each skill as the Adapter says (`$name` for Codex), and appends the
 * Adapter's built-in slash list. The compatibility scanner follows symlinks and
 * tolerates a zero-byte file where a skills root should be.
 */

export type CatalogCommand = { value: string; description?: string };
type SkillSummary = { name: string; description: string };
export type RuntimeCatalogLoader = (workspace: string, stateDirectory: string) => Promise<RuntimeCommandCatalog | undefined>;
type CachedRuntimeCatalog = { value: RuntimeCommandCatalog | undefined; expiresAt: number };

const skillName = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const maxSkillFileBytes = 128 * 1024;
const maxSkillsPerRoot = 256;
// bound the entries `stat`ed per root so a directory full of (broken) symlinks cannot amplify one request
const maxEntriesPerRoot = 4_096;
const maxPluginMarketplaces = 64;
const maxCachedPlugins = 256;
const maxCachedPluginVersions = 512;
const maxCodexConfigBytes = 1024 * 1024;
const runtimeCacheMs = 30_000;
const runtimeFailureCacheMs = 5_000;

function scalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === 'string' ? parsed : undefined;
    } catch { return undefined; }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function metadata(contents: string): SkillSummary | undefined {
  const lines = contents.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.slice(1).findIndex(line => line.trim() === '---');
  if (end < 0) return undefined;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end + 1)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
  }
  const name = scalar(fields.get('name') ?? '');
  const description = scalar(fields.get('description') ?? '');
  if (!name || !description || !skillName.test(name)) return undefined;
  return { name, description: description.replace(/\s+/gu, ' ').slice(0, 500) };
}

// read one skill manifest, ignoring oversized or non-file entries
async function readSkill(path: string): Promise<SkillSummary | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxSkillFileBytes) return undefined;
    return metadata(await readFile(path, 'utf8'));
  } catch { return undefined; }
}

// treat a directory, or a symlink resolving to one, as a skill entry
async function isSkillDirectory(root: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return await stat(join(root, entry.name)).then(info => info.isDirectory()).catch(() => false);
}

// scan one skills root, tolerating a zero-byte file where the root should be
async function scanRoot(root: string): Promise<SkillSummary[]> {
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, maxEntriesPerRoot);
  const directories: string[] = [];
  for (const entry of entries) {
    if (directories.length >= maxSkillsPerRoot) break;
    if (await isSkillDirectory(root, entry)) directories.push(entry.name);
  }
  const discovered = await Promise.all(directories.map(name => readSkill(join(root, name, 'SKILL.md'))));
  return discovered.filter((skill): skill is SkillSummary => skill !== undefined);
}

// list bounded child directories and followed directory symlinks
async function childDirectories(root: string, limit: number): Promise<string[]> {
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, maxEntriesPerRoot);
  const directories: string[] = [];
  // retain directory names within one caller budget
  for (const entry of entries) {
    // stop at the caller limit
    if (directories.length >= limit) break;
    // follow valid directory entries
    if (await isSkillDirectory(root, entry)) directories.push(entry.name);
  }
  return directories;
}

// read explicit plugin enablement from codex configuration
async function configuredPlugins(stateDirectory: string): Promise<Map<string, boolean>> {
  const path = join(stateDirectory, 'config.toml');
  // read one bounded regular config file
  const contents = await stat(path).then(info => info.isFile() && info.size <= maxCodexConfigBytes ? readFile(path, 'utf8') : '').catch(() => '');
  const configured = new Map<string, boolean>();
  let plugin: string | undefined;
  // parse only plugin sections and their enabled flag
  for (const line of contents.split(/\r?\n/gu)) {
    const section = /^\s*\[plugins\."([A-Za-z0-9_-]+@[A-Za-z0-9_-]+)"\]\s*$/u.exec(line);
    // begin or leave one plugin section
    if (section !== null) {
      plugin = section[1];
      continue;
    }
    // leave plugin parsing at another section
    if (/^\s*\[/u.test(line)) {
      plugin = undefined;
      continue;
    }
    const enabled = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/u.exec(line)?.[1];
    // retain one explicit boolean
    if (plugin !== undefined && enabled !== undefined) configured.set(plugin, enabled === 'true');
  }
  return configured;
}

// detect one installed remote plugin marker
async function remotePluginInstalled(path: string): Promise<boolean> {
  return await stat(join(path, '.codex-remote-plugin-install.json')).then(info => info.isFile()).catch(() => false);
}

// scan codex's cached plugin layout and apply plugin namespaces
async function scanPluginCache(stateDirectory: string): Promise<SkillSummary[]> {
  const cache = join(stateDirectory, 'plugins', 'cache');
  const configured = await configuredPlugins(stateDirectory);
  const plugins: Array<{ name: string; path: string }> = [];
  // collect bounded marketplace plugins
  for (const marketplace of await childDirectories(cache, maxPluginMarketplaces)) {
    // stop at the total plugin budget
    if (plugins.length >= maxCachedPlugins) break;
    const marketplaceRoot = join(cache, marketplace);
    // collect valid plugin namespaces
    for (const plugin of await childDirectories(marketplaceRoot, maxCachedPlugins - plugins.length)) {
      // reject unsafe namespace tokens
      if (!skillName.test(plugin)) continue;
      const path = join(marketplaceRoot, plugin);
      const enabled = configured.get(`${plugin}@${marketplace}`) ?? await remotePluginInstalled(path);
      // exclude disabled and merely cached plugins
      if (!enabled) continue;
      plugins.push({ name: plugin, path });
    }
  }
  const skills: SkillSummary[] = [];
  let versionsScanned = 0;
  // scan cached plugin versions
  for (const plugin of plugins) {
    // stop at the total version budget
    if (versionsScanned >= maxCachedPluginVersions) break;
    const versions = await childDirectories(plugin.path, maxCachedPluginVersions - versionsScanned);
    // choose the newest cached version
    const version = versions.sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1);
    // skip plugins without a cached active version
    if (version === undefined) continue;
    versionsScanned += 1;
    // namespace plugin-provided skills
    for (const candidate of await scanRoot(join(plugin.path, version, 'skills'))) {
      const name = `${plugin.name}:${candidate.name}`;
      // retain safe effective names
      if (skillName.test(name)) skills.push({ ...candidate, name });
    }
  }
  return skills;
}

// scan every codex fallback source in precedence order
async function scanCodexFallback(roots: string[], stateDirectory: string): Promise<SkillSummary[]> {
  const skills = [
    ...await scanRoot(join(stateDirectory, 'skills', '.system')),
    ...await scanPluginCache(stateDirectory),
  ];
  // let user and workspace roots override bundled entries
  for (const root of roots) skills.push(...await scanRoot(root));
  return skills;
}

export class CommandCatalogService {
  private readonly runtimeCache = new Map<string, CachedRuntimeCatalog>();
  private readonly runtimeLoads = new Map<string, Promise<RuntimeCommandCatalog | undefined>>();

  // accept one runtime loader for deterministic tests and compatibility fallback
  constructor(private readonly loadRuntimeCatalog: RuntimeCatalogLoader) {}

  // cache and coalesce one workspace runtime lookup
  private async runtimeCatalog(workspace: string, stateDirectory: string): Promise<RuntimeCommandCatalog | undefined> {
    const key = `${stateDirectory}\0${workspace}`;
    const cached = this.runtimeCache.get(key);
    // return one fresh positive or negative cache entry
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const active = this.runtimeLoads.get(key);
    // share one in-flight app-server request
    if (active !== undefined) return await active;
    const load = this.loadRuntimeCatalog(workspace, stateDirectory)
      // report one runtime failure
      .catch(error => {
        console.error('[commands] Codex runtime catalog unavailable:', error instanceof Error ? error.message : 'unknown error');
        return undefined;
      })
      // cache one bounded result
      .then(value => {
        this.runtimeCache.set(key, { value, expiresAt: Date.now() + (value === undefined ? runtimeFailureCacheMs : runtimeCacheMs) });
        return value;
      });
    this.runtimeLoads.set(key, load);
    try {
      return await load;
    } finally {
      // remove only this completed load
      if (this.runtimeLoads.get(key) === load) this.runtimeLoads.delete(key);
    }
  }

  // build the prompt-box catalog for one Agent's kind
  async catalog(adapter: Adapter, workspace: string, stateDirectory: string): Promise<CatalogCommand[]> {
    const commands = adapter.commands;
    if (commands === undefined) return [];
    const byName = new Map<string, SkillSummary>();
    const runtime = commands.runtimeCatalog === 'codex-app-server' ? await this.runtimeCatalog(workspace, stateDirectory) : undefined;
    // prefer codex's effective runtime catalog
    if (runtime !== undefined) {
      // preserve codex's first effective entry
      for (const skill of runtime.skills) {
        // keep the first effective duplicate
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    } else {
      const roots = commands.skillDirectories(workspace, stateDirectory);
      const fallback = commands.runtimeCatalog === 'codex-app-server' ? await scanCodexFallback(roots, stateDirectory) : (await Promise.all(roots.map(scanRoot))).flat();
      // retain each valid fallback skill
      for (const skill of fallback) byName.set(skill.name, skill);
    }
    const skills = [...byName.values()]
      .map(skill => ({ value: commands.skillInvocation(skill.name), description: skill.description }))
      .sort((left, right) => left.value.localeCompare(right.value));
    const slash = new Map<string, CatalogCommand>();
    // retain built-ins before dynamic aliases
    for (const command of [...commands.slash(), ...(runtime?.slash ?? [])]) {
      // keep one command per trigger
      if (!slash.has(command.name)) slash.set(command.name, { value: command.name, description: command.description });
    }
    // one deduped list: a skill wins over a built-in that shares its trigger. This
    // only bites where the two namespaces collide (Claude invokes skills as `/name`,
    // the same `/` the built-ins use); Codex's `$name` skills never overlap.
    const skillTriggers = new Set(skills.map(skill => skill.value));
    return [...skills, ...[...slash.values()].filter(command => !skillTriggers.has(command.value))];
  }
}
