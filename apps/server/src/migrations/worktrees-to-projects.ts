import { isAbsolute, resolve } from 'node:path';
import { worktreeWireId } from '../workspaces/resolver.js';

/**
 * The one-time, boot-time migration from the retired `worktrees[]` configuration (and
 * its per-worktree `command`/`resumeCommand`/`launch` and top-level `newAgentCommand`/
 * `launch` keys) to `projects[]` + `adapters.codex`, re-keying every `.data` store to
 * the Projects layout (ADR 0003). This module is the pure core: detection, the
 * resolution requests the runner must satisfy, the planner (raw config + resolved facts
 * → plan), and the per-file data rewrites. All I/O — reading files, resolving realpaths
 * and git dirs, running `command -v`, writing backups and outputs — lives in the runner
 * (`./runner.ts`). The `migrations/` path is deliberate: it trips the update advisor's
 * `state` review on the update that ships it (server-admin/service.ts).
 */

// the retired agent keys, at the top level or inside a worktree/project entry
const legacyAgentKeys = ['command', 'newAgentCommand', 'launch', 'resumeCommand'] as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
// normalize legacy labels to the durable Worktree store contract
const normalizedWorktreeLabel = (value: unknown): string | undefined => {
  // ignore absent non-string labels
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return label.length >= 1 && label.length <= 120 && !/[\0-\x1f\x7f]/u.test(label) ? label : undefined;
};

/** The retired top-level `launch` template and its per-worktree form. */
export type LegacyLaunch = { program?: unknown; args?: unknown };
/** One retired `worktrees[]` entry, read from the raw file (never through the schema). */
export type LegacyWorktree = {
  id?: unknown; label?: unknown; path?: unknown; hostPath?: unknown; saveKey?: unknown;
  pinned?: unknown; port?: unknown; hostname?: unknown; command?: unknown; resumeCommand?: unknown;
  launch?: unknown; commands?: unknown; newTask?: unknown; push?: unknown;
};

/**
 * A bare program name resolved once by the runner: an `absolute` executable path, an
 * `alias` (a `command -v` result that is not an absolute path — a shell alias, function
 * or builtin), `missing` (not on `PATH`), or `deferred` (the container cannot resolve a
 * host program under the bridge, or `config:check --compose` reports it for boot).
 */
export type CommandResolution =
  | { kind: 'absolute'; path: string }
  | { kind: 'alias'; value: string }
  | { kind: 'missing' }
  | { kind: 'deferred' };

/** Per-entry filesystem facts the runner resolves for the planner (parallel to `worktrees[]`). */
export type EntryFacts = {
  /** `realpath(path)`, or undefined when the path is missing. */
  realpath?: string;
  /** realpath of the entry's git toplevel — its old `identity` — or undefined when not a checkout. */
  toplevel?: string;
  /** realpath of the common git dir — the Project identity — or undefined when not a checkout. */
  commonDir?: string;
  /** whether this checkout is the Main worktree (`--git-dir` equals `--git-common-dir`); undefined when unresolved. */
  main?: boolean;
};

/** Everything the runner resolves off the raw config so the planner stays pure. */
export type ResolvedFacts = { entries: EntryFacts[]; commands: Record<string, CommandResolution> };

/** What the runner must resolve before planning: entry paths and the bare program names. */
export type ResolutionRequests = { paths: string[]; programNames: string[] };

/** One Project the plan creates, with the ids of the entries that merged into it (for the report). */
export type ProjectCreated = { id: string; mergedFrom: string[] };

/**
 * The old→new key maps for one data store, in old-config order. `notes`,
 * `savedPrompts`, `queued` and `history` are array-valued stores; `reviewTours` and
 * `worktrees` are object-valued. Every map is keyed by the store's *old* key and yields
 * the *new* key; a source key absent from its map is left untouched.
 */
export type DataKeyMaps = {
  notes: Record<string, string>;
  savedPrompts: Record<string, string>;
  queued: Record<string, string>;
  history: Record<string, string>;
  reviewTours: Record<string, string>;
  worktrees: Record<string, string>;
};

/** The migration plan: the new config, the data-store rewrites, and the report material. */
export type MigrationPlan = {
  newConfig: Json;
  keyMaps: DataKeyMaps;
  /** explicit config pins that differ from the new default, keyed by `<projectId>:<realpath>`. */
  pins: Record<string, boolean>;
  /** legacy per-worktree labels, keyed by `<projectId>:<realpath>`. */
  labels: Record<string, string>;
  /** the resolved Codex program (or a bare name when deferred to boot under the bridge/compose). */
  codexProgram?: string;
  projectsCreated: ProjectCreated[];
  warnings: string[];
  errors: string[];
};

/**
 * Whether the raw config is legacy and needs migrating: it carries `worktrees`, or any
 * retired agent key at the top level or inside a `worktrees[]`/`projects[]` entry. A
 * config with none of these runs nothing and reads no data file.
 */
export function isLegacyConfig(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  if ('worktrees' in raw) return true;
  if (legacyAgentKeys.some(key => key in raw)) return true;
  for (const list of [raw.worktrees, raw.projects]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) if (isObject(entry) && legacyAgentKeys.some(key => key in entry)) return true;
  }
  return false;
}

// split a shell command string into its program (first word) and arguments (the rest)
function splitCommand(command: string): { program: string; args: string[] } {
  const parts = command.trim().split(/\s+/u).filter(part => part.length > 0);
  return { program: parts[0] ?? '', args: parts.slice(1) };
}

// the launch spec one worktree would run, or undefined when it falls through to the
// global default: its own `command` (first word → program, rest → args), else its own
// `launch`, else the global `launch`. `newAgentCommand` is the scratch default.
function entrySpec(entry: LegacyWorktree, globalLaunch: unknown): { program: string; args: string[]; launch: boolean } | undefined {
  if (typeof entry.command === 'string') return { ...splitCommand(entry.command), launch: false };
  const launch = entry.launch ?? globalLaunch;
  if (isObject(launch)) {
    const program = typeof launch.program === 'string' ? launch.program : '';
    const args = Array.isArray(launch.args) ? launch.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return { program, args, launch: true };
  }
  return undefined;
}

// every bare program name the adapter mapping would resolve, so the runner resolves each
// once. Empty when `adapters.codex` is already configured (the legacy keys are dropped
// unresolved then). Only the bare names actually referenced are resolved — an all-absolute
// config resolves nothing — and `codex` is the fallback only when no launch key exists at all.
function programNames(raw: Json): string[] {
  if (isObject(raw.adapters) && isObject((raw.adapters as Json).codex)) return [];
  const names = new Set<string>();
  const add = (program: string) => { if (program !== '' && !program.includes('/')) names.add(program); };
  const globalLaunch = raw.launch;
  let hasSpec = false;
  if (typeof raw.newAgentCommand === 'string') { hasSpec = true; add(splitCommand(raw.newAgentCommand).program); }
  const entries = Array.isArray(raw.worktrees) ? raw.worktrees : [];
  for (const entry of entries) { if (!isObject(entry)) continue; const spec = entrySpec(entry, globalLaunch); if (spec !== undefined) { hasSpec = true; add(spec.program); } }
  const topLaunch = entrySpec({} as LegacyWorktree, globalLaunch);
  if (topLaunch !== undefined) { hasSpec = true; add(topLaunch.program); }
  // the schema default is resolved only when no launch key exists at all
  if (!hasSpec) names.add('codex');
  return [...names];
}

/**
 * The paths and bare program names the runner resolves before planning. `paths` is kept
 * index-aligned with `worktrees[]` — a path-less or non-object entry contributes an empty
 * string, never a gap — because the planner reads `facts.entries[index]` by the full entry
 * index; filtering here would shift every later entry onto another checkout's git identity.
 */
export function resolutionRequests(raw: unknown): ResolutionRequests {
  if (!isObject(raw)) return { paths: [], programNames: [] };
  const entries = Array.isArray(raw.worktrees) ? raw.worktrees : [];
  const paths = entries.map(entry => (isObject(entry) && typeof entry.path === 'string' ? entry.path : ''));
  return { paths, programNames: programNames(raw) };
}

// resolve one program token to an absolute path, recording an error otherwise. An
// absolute path passes through; a relative path with a slash is rejected; a bare name is
// looked up in the resolved `command -v` facts (alias/missing are errors, deferred passes
// the bare name through for a boot-time resolution under the bridge/compose).
function resolveProgram(program: string, source: string, facts: ResolvedFacts, errors: string[]): string | undefined {
  if (program === '') { errors.push(`${source}: empty launch command`); return undefined; }
  if (isAbsolute(program)) return program;
  if (program.includes('/')) { errors.push(`${source}: launch program \`${program}\` is a relative path; set an absolute path in adapters.codex.program`); return undefined; }
  const resolution = facts.commands[program];
  if (resolution === undefined || resolution.kind === 'missing') { errors.push(`${source}: \`${program}\` was not found on PATH; set adapters.codex.program to an absolute path`); return undefined; }
  if (resolution.kind === 'alias') { errors.push(`${source}: \`${program}\` resolves to \`${resolution.value}\`, not an absolute executable; set adapters.codex.program to an absolute path`); return undefined; }
  if (resolution.kind === 'deferred') return program;
  return resolution.path;
}

// the single `adapters.codex` entry the legacy launch keys map to: every entry's launch
// command, the global launch and `newAgentCommand` must agree after resolution — a
// disagreement is an error listing the values, never a guess. When no launch key exists
// the schema default `codex` is resolved. Placeholders in a launch template are an error.
function resolveCodexEntry(raw: Json, facts: ResolvedFacts, errors: string[]): { entry: Json; program: string } | undefined {
  const specs: { source: string; program: string; args: string[] }[] = [];
  const globalLaunch = raw.launch;
  const consider = (spec: { program: string; args: string[]; launch: boolean } | undefined, source: string) => {
    if (spec === undefined) return;
    if (spec.launch) for (const arg of spec.args) if (/\{worktreePath\}|\{worktreeId\}/u.test(arg)) errors.push(`${source}: launch template argument \`${arg}\` uses a per-worktree placeholder the single adapters.codex cannot carry`);
    specs.push({ source, program: spec.program, args: spec.args });
  };
  if (typeof raw.newAgentCommand === 'string') consider({ ...splitCommand(raw.newAgentCommand), launch: false }, 'newAgentCommand');
  const entries = Array.isArray(raw.worktrees) ? raw.worktrees : [];
  entries.forEach((entry, index) => { if (isObject(entry)) consider(entrySpec(entry, globalLaunch), `worktree ${typeof entry.id === 'string' ? entry.id : index}`); });
  // the global launch as its own source, so a config with only a top-level launch still maps
  if (specs.length === 0) consider(entrySpec({} as LegacyWorktree, globalLaunch), 'launch');
  // resolve to (program, args); the schema default when no launch key exists at all
  const resolved = specs.map(spec => ({ source: spec.source, program: resolveProgram(spec.program, spec.source, facts, errors), args: spec.args }));
  if (specs.length === 0) { const program = resolveProgram('codex', 'default program', facts, errors); return program === undefined ? undefined : { entry: { program }, program }; }
  if (resolved.some(spec => spec.program === undefined)) return undefined;
  const distinct = new Map<string, { program: string; args: string[] }>();
  for (const spec of resolved) distinct.set(JSON.stringify([spec.program, spec.args]), { program: spec.program!, args: spec.args });
  if (distinct.size > 1) {
    const listed = resolved.map(spec => `${spec.source} → ${[spec.program, ...spec.args].join(' ')}`).join('; ');
    errors.push(`worktree launch commands disagree, so no single adapters.codex can be derived: ${listed}`);
    return undefined;
  }
  const [{ program, args }] = distinct.values();
  return { entry: { program, ...(args.length === 0 ? {} : { args }) }, program };
}

// the retired keys dropped from the top level and from a pass-through `projects[]` entry
const retiredTopLevelKeys = new Set(['newAgentCommand', 'launch', 'command', 'resumeCommand', 'adapters']);
const retiredEntryKeys = ['command', 'resumeCommand', 'launch', 'saveKey', 'pinned'] as const;

// place `projects` (and `adapters` immediately after) where `worktrees`/`projects` sat in
// the file, dropping the retired top-level keys and preserving the order of the rest.
function composeConfig(raw: Json, projects: unknown[], adapters: Json | undefined): Json {
  const out: Json = {};
  let placed = false;
  const place = () => { out.projects = projects; if (adapters !== undefined) out.adapters = adapters; placed = true; };
  for (const key of Object.keys(raw)) {
    if (key === 'worktrees' || key === 'projects') { if (!placed) place(); continue; }
    if (retiredTopLevelKeys.has(key)) continue;
    out[key] = raw[key];
  }
  if (!placed) place();
  return out;
}

// drop the retired keys from a pass-through `projects[]` entry (a config whose `projects`
// already exist), keeping every new-schema field the operator wrote
function stripRetiredKeys(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const out = { ...(entry as Json) };
  for (const key of retiredEntryKeys) delete out[key];
  return out;
}

// the Project defaults for one merge group come from the first entry (ADR 0003), carrying
// only the keys the new schema keeps; saveKey/command/resumeCommand/launch/pinned drop
function projectEntry(entry: LegacyWorktree): Json {
  const project: Json = { id: entry.id, path: entry.path };
  for (const key of ['label', 'hostPath', 'port', 'hostname', 'commands', 'newTask', 'push'] as const) {
    if (entry[key] !== undefined) project[key] = entry[key];
  }
  return project;
}

// choose the checkout identity discovery will use, with a stable path fallback
function canonicalEntryPath(entry: LegacyWorktree, facts: EntryFacts): string {
  return facts.toplevel ?? facts.realpath ?? resolve(typeof entry.path === 'string' ? entry.path : String(entry.id));
}

// compare command maps by action rather than object key order; absent and empty both disable controls
function sameCommands(left: unknown, right: unknown): boolean {
  const normalizedLeft = left === undefined ? {} : left;
  const normalizedRight = right === undefined ? {} : right;
  // preserve invalid legacy values for schema validation
  if (!isObject(normalizedLeft) || !isObject(normalizedRight)) return Object.is(normalizedLeft, normalizedRight);
  const keys = new Set([...Object.keys(normalizedLeft), ...Object.keys(normalizedRight)]);
  // compare every configured action
  for (const key of keys) {
    // require an override on the first mismatch
    if (normalizedLeft[key] !== normalizedRight[key]) return false;
  }
  return true;
}

// preserve one merged member's settings when they differ from the first entry's defaults
function worktreeOverride(defaults: LegacyWorktree, member: { entry: LegacyWorktree; facts: EntryFacts }): Json | undefined {
  const override: Json = { path: canonicalEntryPath(member.entry, member.facts) };
  // commands replace the whole inherited map; empty explicitly disables inherited controls
  if (!sameCommands(defaults.commands, member.entry.commands)) override.commands = member.entry.commands === undefined ? {} : member.entry.commands;
  const previewDiffers = defaults.hostname !== member.entry.hostname || defaults.port !== member.entry.port;
  // preview fields remain a pair; null/null explicitly disables the inherited preview
  if (previewDiffers) {
    override.hostname = member.entry.hostname ?? null;
    override.port = member.entry.port ?? null;
  }
  // omit a path-only record when every setting inherits unchanged
  return Object.keys(override).length === 1 ? undefined : override;
}

/**
 * Build the migration plan from the raw legacy config and the runner's resolved facts.
 * Pure: it reads no files and runs no commands. Every content problem is collected into
 * `errors` (the runner refuses boot with all of them); non-fatal facts land in `warnings`.
 */
export function planMigration(raw: unknown, facts: ResolvedFacts): MigrationPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const keyMaps: DataKeyMaps = { notes: {}, savedPrompts: {}, queued: {}, history: {}, reviewTours: {}, worktrees: {} };
  const pins: Record<string, boolean> = {};
  const labels: Record<string, string> = {};
  const projectsCreated: ProjectCreated[] = [];
  if (!isObject(raw)) { errors.push('configuration is not a JSON object'); return { newConfig: {}, keyMaps, pins, labels, projectsCreated, warnings, errors }; }
  if ('worktrees' in raw && 'projects' in raw) errors.push('configuration declares both `worktrees` and `projects`; keep one');

  const entries = Array.isArray(raw.worktrees) ? (raw.worktrees as LegacyWorktree[]) : [];
  // group entries by Project identity (common git dir); an unresolved identity is its own group
  const groups: { projectId: string; project: Json; members: { entry: LegacyWorktree; facts: EntryFacts }[] }[] = [];
  const byIdentity = new Map<string, number>();
  entries.forEach((entry, index) => {
    const entryFacts = facts.entries[index] ?? {};
    const identity = entryFacts.commonDir;
    if (identity !== undefined && byIdentity.has(identity)) {
      groups[byIdentity.get(identity)!]!.members.push({ entry, facts: entryFacts });
      return;
    }
    if (identity !== undefined) byIdentity.set(identity, groups.length);
    groups.push({ projectId: String(entry.id), project: projectEntry(entry), members: [{ entry, facts: entryFacts }] });
  });

  // keep first-entry settings as project defaults and preserve only differing merged members
  const projects = groups.map(group => {
    const defaults = group.members[0]!.entry;
    const worktreeOverrides: Json[] = [];
    // compare every later checkout with the project defaults
    for (const member of group.members.slice(1)) {
      const override = worktreeOverride(defaults, member);
      // omit members whose settings already inherit exactly
      if (override !== undefined) worktreeOverrides.push(override);
    }
    return worktreeOverrides.length === 0 ? group.project : { ...group.project, worktreeOverrides };
  });
  for (const group of groups) {
    const mergedFrom = group.members.map(member => String(member.entry.id));
    projectsCreated.push({ id: group.projectId, mergedFrom });
    // report every repository merge and the resulting default source
    if (mergedFrom.length > 1) warnings.push(`merged worktree entries ${mergedFrom.join(', ')} into project ${group.projectId} (they share one git repository; the first entry's settings become project defaults)`);
    // every member's data re-keys onto this Project; each keeps its own checkout realpath
    for (const { entry, facts: entryFacts } of group.members) {
      const oldId = String(entry.id);
      const noteKey = typeof entry.saveKey === 'string' ? entry.saveKey : oldId;
      const realpath = canonicalEntryPath(entry, entryFacts);
      if (entryFacts.toplevel === undefined) warnings.push(`worktree ${oldId}: path is not a resolvable git checkout; its data is keyed by ${realpath} and can be cleared with Prune`);
      const worktreeKey = worktreeWireId(group.projectId, realpath);
      // notes are Project-scoped: saveKey ?? id → <projectId>; a saveKey shared across repositories warns
      if (keyMaps.notes[noteKey] !== undefined && keyMaps.notes[noteKey] !== group.projectId) warnings.push(`save key ${noteKey} spans repositories; its notes go to project ${keyMaps.notes[noteKey]}`);
      else keyMaps.notes[noteKey] = group.projectId;
      // saved prompts, queued prompts and history were Worktree-scoped, keyed by the Worktree wire
      // id `<projectId>:<realpath>`; ADR 0012 moved the last two to the Agent, and the departed-Agent
      // sweep drains these Worktree-keyed records
      keyMaps.savedPrompts[`worktree:${oldId}`] = worktreeKey;
      keyMaps.queued[`worktree:${oldId}`] = worktreeKey;
      keyMaps.history[`worktree:${oldId}`] = worktreeKey;
      keyMaps.reviewTours[oldId] = worktreeKey;
      keyMaps.worktrees[oldId] = worktreeKey;
      // preserve each retired entry's distinct display name after its Project merge
      const label = normalizedWorktreeLabel(entry.label);
      if (label !== undefined) labels[worktreeKey] = label;
      // leave an unsafe legacy label out of the strict state store
      else if (typeof entry.label === 'string') warnings.push(`worktree ${oldId}: its invalid label was not preserved as a Worktree alias`);
      // only an explicit pin that differs from the new default (main pinned, linked unpinned) migrates
      if (typeof entry.pinned === 'boolean') {
        const isMain = entryFacts.main !== false;
        if (entry.pinned !== isMain) pins[worktreeKey] = entry.pinned;
      }
    }
  }

  // adapters.codex: keep an operator's existing one (dropping the legacy keys unresolved),
  // else derive the single entry from the legacy launch keys
  const rawAdapters = isObject(raw.adapters) ? (raw.adapters as Json) : undefined;
  let adapters = rawAdapters;
  let codexProgram: string | undefined;
  if (rawAdapters?.codex !== undefined) {
    codexProgram = isObject(rawAdapters.codex) && typeof rawAdapters.codex.program === 'string' ? rawAdapters.codex.program : undefined;
  } else {
    const codex = resolveCodexEntry(raw, facts, errors);
    if (codex !== undefined) { adapters = { codex: codex.entry, ...rawAdapters }; codexProgram = codex.program; }
  }

  // a `worktrees[]` config yields freshly-built Projects; a config whose `projects[]` already
  // exist (only its agent keys are legacy) passes them through with any retired keys stripped
  const projectsForConfig = 'worktrees' in raw ? projects : (Array.isArray(raw.projects) ? raw.projects.map(stripRetiredKeys) : []);
  const newConfig = composeConfig(raw, projectsForConfig, adapters);
  return { newConfig, keyMaps, pins, labels, ...(codexProgram === undefined ? {} : { codexProgram }), projectsCreated, warnings, errors };
}

// ---- per-file data rewrites (pure) ---------------------------------------------------

/** Thrown when a data file's parsed content is not the flat object every store persists. */
export class DataFileError extends Error {}

// dedupe records by their `id`, preserving first occurrence
function dedupeById(records: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const record of records) {
    const id = isObject(record) && typeof record.id === 'string' ? record.id : undefined;
    if (id !== undefined) { if (seen.has(id)) continue; seen.add(id); }
    out.push(record);
  }
  return out;
}

/**
 * Rewrite one array-valued store (notes, saved prompts, queued prompts,
 * history): re-key by `keyMap`, leave unmapped keys untouched, concatenate arrays that
 * merge onto one new key (deduped by `id`, old-config order), and optionally back-fill a
 * record field. `count` is the number of source keys re-keyed.
 */
export function rewriteListStore(raw: unknown, keyMap: Record<string, string>, backfill?: (record: unknown) => unknown): { value: Json; count: number } {
  if (!isObject(raw)) throw new DataFileError('data file is not a JSON object');
  const out: Json = {};
  let count = 0;
  // untouched keys first, so a mapped new key can merge onto a pre-existing bare key
  for (const [key, value] of Object.entries(raw)) if (keyMap[key] === undefined) out[key] = value;
  // mapped keys in keyMap (old-config) order, concatenating merges
  for (const [oldKey, newKey] of Object.entries(keyMap)) {
    if (!(oldKey in raw)) continue;
    count += 1;
    const source = raw[oldKey];
    const records = Array.isArray(source) ? (backfill === undefined ? source : source.map(backfill)) : [];
    const existing = Array.isArray(out[newKey]) ? (out[newKey] as unknown[]) : [];
    out[newKey] = dedupeById([...existing, ...records]);
  }
  return { value: out, count };
}

/**
 * Rewrite `.data/review-tours.json`: re-key each tour to its Worktree wire id and rewrite
 * the record's `worktreeId` to match (the store requires the two to agree). When two old
 * ids merge onto one key the newest `savedAt` wins, with a warning.
 */
export function rewriteReviewTours(raw: unknown, keyMap: Record<string, string>, warnings: string[]): { value: Json; count: number } {
  if (!isObject(raw)) throw new DataFileError('data file is not a JSON object');
  const out: Json = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) if (keyMap[key] === undefined) out[key] = value;
  for (const [oldKey, newKey] of Object.entries(keyMap)) {
    if (!(oldKey in raw)) continue;
    count += 1;
    const record = raw[oldKey];
    const rewritten = isObject(record) ? { ...record, worktreeId: newKey } : record;
    const existing = out[newKey];
    if (existing !== undefined) {
      const existingAt = isObject(existing) && typeof existing.savedAt === 'string' ? Date.parse(existing.savedAt) : 0;
      const candidateAt = isObject(rewritten) && typeof (rewritten as Json).savedAt === 'string' ? Date.parse((rewritten as Json).savedAt as string) : 0;
      warnings.push(`review tours for ${oldKey} merge onto ${newKey}; keeping the newest`);
      if (!(candidateAt > existingAt)) continue;
    }
    out[newKey] = rewritten;
  }
  return { value: out, count };
}

/**
 * rewrite `.data/worktrees.json`: re-key each `{ pinned?, launchProfile?, label? }` record
 * to its Worktree wire id, then apply legacy config pins and labels. Config values win
 * their fields; a re-keyed record's `launchProfile` is preserved.
 */
export function rewriteWorktreeRecords(raw: unknown, keyMap: Record<string, string>, pins: Record<string, boolean>, labels: Record<string, string>): { value: Json; count: number } {
  if (!isObject(raw)) throw new DataFileError('data file is not a JSON object');
  const out: Json = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) if (keyMap[key] === undefined) out[key] = value;
  for (const [oldKey, newKey] of Object.entries(keyMap)) {
    if (!(oldKey in raw)) continue;
    count += 1;
    out[newKey] = { ...(isObject(out[newKey]) ? out[newKey] as Json : {}), ...(isObject(raw[oldKey]) ? raw[oldKey] as Json : {}) };
  }
  for (const [key, pinned] of Object.entries(pins)) out[key] = { ...(isObject(out[key]) ? out[key] as Json : {}), pinned };
  // apply every legacy display name after record merges
  for (const [key, label] of Object.entries(labels)) out[key] = { ...(isObject(out[key]) ? out[key] as Json : {}), label };
  return { value: out, count };
}
