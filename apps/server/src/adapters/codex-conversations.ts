import { createHash } from 'node:crypto';
import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileHead, readFileTail } from './bounded-file.js';
import { queueReadyPrompt } from './codex-turns.js';
import { FileChangeCache } from './file-change-cache.js';
import type { CompletionBaseline, CompletionEvent, Conversation, ConversationSummary, ManagedPromptLifecycleEvidence } from './types.js';

/**
 * Codex conversation lookup, gathered behind the Adapter (ADR 0002). These are
 * the only filesystem-touching functions the Codex Adapter owns: the `/proc`
 * fd-walk that finds the rollout files a pane holds open, the bounded
 * `session_meta` read that picks the single top-level Conversation, the
 * discover-time title scan, and the Conversation-name read from the
 * `session_index.jsonl` sidecar. Roots are injectable through the same
 * environment variables the console has always used (`RAC_HOST_PROC`,
 * `CODEX_HOME`), so behaviour is unchanged from when this lived in
 * `discovery/processes.ts`. ("Rollout" is Codex's own
 * name for these `.jsonl` files; "Session" is reserved for tmux, per CONTEXT.md.)
 */

const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// validate one exact Codex thread UUID
export const validCodexThreadId = (value: string): boolean => threadIdPattern.test(value);

const maxMetadataBytes = 128 * 1024;
const maxTitleLength = 120;
const maxTitleScanBytes = 4 * 1024 * 1024;
const maxCompletionScanBytes = 4 * 1024 * 1024;
// discovery polls this reader, so keep each pane read small and fail safe on an oversized record
const maxLatestMessageScanBytes = 512 * 1024;
// bound the account-global session-index read to its recent tail. The sidecar is
// append-only and last-write-wins, so the current name is at the file's end; a
// smaller-than-cap file is read whole (a true forward read). `readName`'s callers
// (the console read-back, the discover-time name) target a recently active thread, whose
// line is near the tail. Above the cap the oldest threads' names fail *safe* — an
// unread line yields `undefined` (a generic label), never a wrong name. A future
// `list` that enumerates long-idle threads must not lean on this by-id read.
const maxIndexScanBytes = 8 * 1024 * 1024;
const maxAnswerLength = 64_000;
const maxRolloutEntries = 4_096;
// rollout files inspected when matching by working directory: the live session is
// effectively always among the newest, so a smaller bound keeps the per-turn scan
// cheap on a host with deep history
const maxCwdRolloutScans = 512;
// bound the per-rollout tail read that finds a listed row's `lastActiveAt`: the newest
// record's timestamp sits at the very end, so a small tail suffices (mirrors Claude's list)
const maxListTailBytes = 256 * 1024;

type RolloutRef = { id: string; relativePath: string };
type RolloutMetadata = { id: string; cwd: string; parentThreadId?: string; createdAt?: number; cliVersion?: string };
type SidecarName = { id: string; name: string };
type SessionIndex = { byId: Record<string, string>; named: Record<string, string> };

function procRoot(): string {
  return process.env.RAC_HOST_PROC ?? '/proc';
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
}

// validate one session-relative rollout path before it reaches the filesystem
function validRolloutRef(value: RolloutRef): boolean {
  const parts = value.relativePath.split('/');
  return validCodexThreadId(value.id)
    && value.relativePath.length <= 4_096
    && parts[0] === 'sessions'
    && parts.length >= 3
    && parts.every(part => part.length > 0 && part !== '.' && part !== '..')
    && value.relativePath.endsWith(`-${value.id}.jsonl`);
}

// collect exact rollout identities held open by one pane process tree
export async function openRollouts(root: number): Promise<RolloutRef[]> {
  const proc = procRoot();
  const pending = [root];
  const seen = new Set<number>();
  const rollouts = new Map<string, RolloutRef>();
  let inspectedDescriptors = 0;
  // bound process and descriptor traversal
  while (pending.length > 0 && seen.size < 256 && inspectedDescriptors < maxRolloutEntries) {
    const pid = pending.pop()!;
    // inspect each live process once
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      const children = (await readFile(`${proc}/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/u).filter(Boolean).map(Number);
      // retain live descendants
      for (const child of children) if (Number.isInteger(child) && child > 0) pending.push(child);
      // read bounded open-file targets (a confined service cannot readlink a
      // sandboxed pane's descriptors: the readlink then fails and the pane's
      // rollout is instead matched by its working directory, below)
      const descriptors = await readdir(`${proc}/${pid}/fd`).catch(() => []);
      for (const descriptor of descriptors) {
        if (inspectedDescriptors >= maxRolloutEntries) break;
        inspectedDescriptors += 1;
        const target = await readlink(`${proc}/${pid}/fd/${descriptor}`).catch(() => '');
        const match = /(?:^|\/)(sessions\/[^\0]{1,3800}\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl)$/iu.exec(target);
        // retain exact Codex rollout filenames only
        if (match?.[1] !== undefined && match[2] !== undefined && !match[1].split('/').includes('..')) rollouts.set(`${match[2]}:${match[1]}`, { id: match[2], relativePath: match[1] });
      }
    } catch {
      // ignore exited or unreadable processes
    }
  }
  return [...rollouts.values()];
}

// parse bounded metadata from one Codex rollout
function parseRolloutMetadata(lines: readonly string[]): RolloutMetadata | undefined {
  try {
    const [firstLine] = lines;
    // reject missing records
    if (!firstLine) return undefined;
    const record = JSON.parse(firstLine) as { type?: unknown; payload?: unknown };
    // require session metadata
    if (record.type !== 'session_meta' || record.payload === null || typeof record.payload !== 'object') return undefined;
    const payload = record.payload as { id?: unknown; cwd?: unknown; originator?: unknown; parent_thread_id?: unknown; timestamp?: unknown; cli_version?: unknown };
    // accept only top-level interactive Codex conversations
    if (typeof payload.id !== 'string' || !validCodexThreadId(payload.id) || typeof payload.cwd !== 'string' || payload.originator !== 'codex-tui') return undefined;
    // the recorded session start, epoch ms; used to tell a post-reset rollout from the pre-reset one
    const createdAt = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
    return { id: payload.id, cwd: payload.cwd, ...(typeof payload.parent_thread_id === 'string' ? { parentThreadId: payload.parent_thread_id } : {}), ...(Number.isFinite(createdAt) ? { createdAt } : {}), ...(typeof payload.cli_version === 'string' ? { cliVersion: payload.cli_version } : {}) };
  } catch {
    return undefined;
  }
}

// cover one full cwd scan without evicting its earliest metadata entries
const rolloutMetadataCache = new FileChangeCache<RolloutMetadata | undefined>(
  async file => parseRolloutMetadata(await readFileHead(file, maxMetadataBytes)),
  { maxEntries: 1_024 }
);

// normalize a user message into a compact title, ignoring injected session context
function messageTitle(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.startsWith('# AGENTS.md instructions') || normalized.startsWith('<environment_context>')) return undefined;
  return compactName(normalized);
}

// extract message text from one Codex response item
function userMessage(payload: unknown): string | undefined {
  // require one user message payload
  if (payload === null || typeof payload !== 'object') return undefined;
  const message = payload as { type?: unknown; role?: unknown; content?: unknown };
  // reject non-user records
  if (message.type !== 'message' || message.role !== 'user' || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((item): item is { text: string } => item !== null && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string')
    .map(item => item.text)
    .join('\n');
  return messageTitle(text);
}

// parse the latest useful user message in one rollout's bounded tail
function rolloutTitleFromRecords(lines: Iterable<string>): string | undefined {
  let title: string | undefined;
  // inspect every record in tail order
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as { type?: unknown; payload?: unknown };
      // retain the newest visible user request
      if (record.type === 'response_item') title = userMessage(record.payload) ?? title;
    } catch {
      // preserve earlier valid records
    }
  }
  return title;
}

// retain compact titles for a full bounded rollout scan
const rolloutTitleCache = new FileChangeCache<string | undefined>(
  async file => rolloutTitleFromRecords(await readFileTail(file, maxTitleScanBytes)),
  { maxEntries: 1_024 }
);

// locate the pane's one top-level rollout, failing closed on ambiguity
async function selectTopLevelRollout(refs: RolloutRef[]): Promise<{ id: string; file: string } | undefined> {
  const home = codexHome();
  const matches: Array<{ id: string; file: string }> = [];
  // inspect only rollouts held open by the selected pane
  for (const ref of refs) {
    // reject malformed rollout paths before opening them
    if (!validRolloutRef(ref)) continue;
    const file = join(home, ref.relativePath);
    const metadata = await rolloutMetadataCache.get(file).catch(() => undefined);
    // retain top-level conversations only
    if (metadata !== undefined && metadata.parentThreadId === undefined && metadata.id === ref.id) matches.push({ id: metadata.id, file });
  }
  // fail closed on missing or ambiguous pane identity
  if (matches.length !== 1) return undefined;
  return matches[0];
}

/**
 * The pane's current top-level Codex conversation, resolved by the fd-walk plus
 * the `session_meta` read, failing closed when the pane holds no single
 * unambiguous top-level rollout. The working-directory match (`cwd`, supplied
 * only when unique among live panes) is the same privilege-free fallback
 * `codexRolloutBaseline` uses when a confined service cannot readlink the
 * pane's descriptors and the fd-walk finds nothing. Reproduces the old
 * `discovery.sessions` + `selectedSession` pair that resolved a pane to its
 * exact rollout.
 */
export async function discoverCodexConversation(pane: { pid: number; cwd?: string }): Promise<Conversation | undefined> {
  const selected = await paneRollout(pane);
  // require one exact pane-to-conversation mapping
  if (selected === undefined) return undefined;
  const title = await rolloutTitleCache.get(selected.file).catch(() => undefined);
  return { id: selected.id, ...(title === undefined ? {} : { title }) };
}

/**
 * The pane's live top-level rollout located by its working directory, for the
 * confined service that cannot readlink a sandboxed pane's descriptors (the
 * fd-walk then finds nothing). Walks the bounded sessions tree newest-first and
 * returns the first top-level Codex rollout whose recorded `cwd` matches, so the
 * live conversation is found before older history in the same directory. The
 * caller supplies `cwd` only when it is unique among live panes, so a directory
 * running two agents never resolves to a sibling's rollout.
 *
 * When `createdAfter` is given (a `/new` reset instant), a matching rollout must
 * also have been recorded after it, so the pane's still-open pre-reset rollout is
 * skipped and only the freshly opened post-reset thread resolves.
 */
async function rolloutByCwd(cwd: string, createdAfter?: number): Promise<{ id: string; file: string } | undefined> {
  // Codex records a host-canonical `cwd` and the pane path is host-canonical too
  // (tmux reads it from the pane's `/proc/<pid>/cwd`), so match the raw string first.
  // That holds under Docker, where a host worktree can be bind-mounted at a different
  // container path and an in-container `realpath` would resolve it somewhere else; the
  // canonical form is only a fallback for a genuinely symlinked local pane path.
  const canonical = await realpath(cwd).catch(() => cwd);
  for await (const { file, metadata } of walkRollouts(codexHome())) {
    // match the pane's live top-level conversation in this directory, skipping any
    // rollout that predates a supplied reset instant (the pre-reset thread)
    if (metadata !== undefined && metadata.parentThreadId === undefined && (metadata.cwd === cwd || metadata.cwd === canonical)
      && (createdAfter === undefined || (metadata.createdAt !== undefined && metadata.createdAt > createdAfter))) return { id: metadata.id, file };
  }
  return undefined;
}

// Walk a Codex home's sessions tree newest-first — newest rollout within a date partition,
// newest partition across them — yielding each rollout's path and bounded `session_meta` up to
// the `maxCwdRolloutScans` cap. The live-pane working-directory match and the Named-conversation
// listing share this one bounded walk (an early `break` in the caller stops the generator, so a
// match found among the newest files never reads the rest of a deep-history home).
async function* walkRollouts(home: string): AsyncGenerator<{ file: string; metadata: RolloutMetadata | undefined }> {
  const pending = [join(home, 'sessions')];
  let inspected = 0;
  while (pending.length > 0 && inspected < maxCwdRolloutScans) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    // newest rollout first within a partition, newest date-partition first across them
    const files = entries.filter(entry => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')).map(entry => entry.name).sort((left, right) => right.localeCompare(left));
    const subdirectories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort((left, right) => left.localeCompare(right)).map(name => join(directory, name));
    for (const name of files) {
      if (inspected >= maxCwdRolloutScans) break;
      inspected += 1;
      const file = join(directory, name);
      yield { file, metadata: await rolloutMetadataCache.get(file).catch(() => undefined) };
    }
    // ascending push + LIFO pop visits the highest-numbered (most recent) partition first
    pending.push(...subdirectories);
  }
}

// the pane's single top-level rollout: the exact fd-walk, else the privilege-free
// working-directory match when a confined service cannot readlink the descriptors
async function paneRollout(pane: { pid: number; cwd?: string }): Promise<{ id: string; file: string } | undefined> {
  return await selectTopLevelRollout(await openRollouts(pane.pid))
    ?? (pane.cwd === undefined ? undefined : await rolloutByCwd(pane.cwd));
}

// retain visible assistant text from one native message payload
function assistantText(value: unknown): string | undefined {
  // accept direct event text
  if (typeof value === 'string') {
    const text = value.trim() === '' ? undefined : value;
    return text;
  }
  // reject non-message content
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((item): item is { type?: string; text: string } => item !== null && typeof item === 'object'
      && ((item as { type?: unknown }).type === 'output_text' || (item as { type?: unknown }).type === 'text')
      && typeof (item as { text?: unknown }).text === 'string')
    .map(item => item.text)
    .join('\n');
  // reject assistant records without visible text
  if (text.trim() === '') return undefined;
  return text;
}

/**
 * fold a rollout tail into its latest unanswered assistant message; user and turn
 * boundaries clear earlier text so an old question cannot reappear after activity.
 */
export function latestCodexMessageFromRecords(lines: Iterable<string>): string | undefined {
  let latest: string | undefined;
  // apply rollout records in file order
  for (const line of lines) {
    let parsed: unknown;
    // skip malformed tail fragments
    try { parsed = JSON.parse(line) as unknown; } catch { continue; }
    // reject json primitives and arrays
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as { type?: unknown; payload?: unknown };
    // require one structured payload
    if (record.payload === null || typeof record.payload !== 'object') continue;
    const payload = record.payload as { type?: unknown; role?: unknown; content?: unknown; message?: unknown; last_agent_message?: unknown };
    // inspect only authored user and assistant messages
    if (record.type === 'response_item' && payload.type === 'message') {
      // clear an older reply when a new real turn enters the rollout
      if (payload.role === 'user') latest = undefined;
      // replace with this assistant message, including an empty one
      else if (payload.role === 'assistant') latest = assistantText(payload.content);
      continue;
    }
    // ignore unrelated rollout records
    if (record.type !== 'event_msg') continue;
    // clear terminal and prompt boundaries before later assistant output
    if (payload.type === 'task_started' || payload.type === 'user_message' || payload.type === 'turn_aborted') latest = undefined;
    // native prose events replace any earlier assistant text
    else if (payload.type === 'agent_message') latest = assistantText(payload.message);
    // completion is the final assistant message even without an ordinal
    else if (payload.type === 'task_complete') latest = assistantText(payload.last_agent_message);
  }
  return latest;
}

// retain parsed latest replies while their rollout bytes remain unchanged
const latestMessageCache = new FileChangeCache<string | undefined>(
  async file => latestCodexMessageFromRecords(await readFileTail(file, maxLatestMessageScanBytes)),
  { maxEntries: 1_024 }
);

/** read the latest unanswered assistant message from one exact pane rollout */
export async function codexLatestMessage(pane: { pid: number; cwd?: string; conversationId?: string }): Promise<string | undefined> {
  // reject a malformed reported identity before any filesystem scan
  if (pane.conversationId !== undefined && !validCodexThreadId(pane.conversationId)) return undefined;
  const selected = await paneRollout(pane).catch(() => undefined);
  // fail closed when the pane no longer matches its reported conversation
  if (selected === undefined || (pane.conversationId !== undefined && selected.id !== pane.conversationId)) return undefined;
  return latestMessageCache.get(selected.file).catch(() => undefined);
}

// normalize whitespace and clamp a Codex display string to the shared bound, so
// neither a stored thread name nor a user message reaches the UI unbounded
function compactName(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return undefined;
  return normalized.length <= maxTitleLength ? normalized : `${normalized.slice(0, maxTitleLength - 1).trimEnd()}…`;
}

// index one account sidecar for constant-time by-id and listing lookups
function indexSessionNames(lines: Iterable<string>): SessionIndex {
  const byId: Record<string, string> = {};
  const named: Record<string, string> = {};
  // preserve each reader's whitespace handling while folding once
  for (const record of sidecarNameLines(lines)) {
    const name = compactName(record.name);
    // by-id treats a whitespace-only final rename as unnamed
    if (name === undefined) delete byId[record.id]; else byId[record.id] = name;
    // listing ignores a later whitespace-only rename and retains the prior valid name
    if (name !== undefined) named[record.id] = name;
  }
  return { byId, named };
}

// share one derived account index across by-id and listing reads
const sessionIndexCache = new FileChangeCache<SessionIndex>(
  async path => indexSessionNames(await readFileTail(path, maxIndexScanBytes)),
  { maxEntries: 64 }
);

/**
 * The current Conversation name of an already-known Codex/OMX thread, read from
 * the account-global `session_index.jsonl` sidecar (`<CODEX_HOME>/session_index.jsonl`).
 * The sidecar is append-only — one `{ id, thread_name, updated_at }` line per name
 * change — so the last line carrying this id wins. Both codex and omx share
 * `~/.codex`, so this reads the same store for either kind. `undefined` when the
 * sidecar is absent (a fresh thread with no name yet) or carries no line for the id.
 */
export async function codexConversationName(id: string): Promise<string | undefined> {
  // reject material before it reaches a comparison
  if (!validCodexThreadId(id)) return undefined;
  const index = await sessionIndexCache.get(join(codexHome(), 'session_index.jsonl')).catch(() => undefined);
  return index?.byId[id];
}

// every valid, non-empty `{ id, thread_name }` entry of the session-index sidecar, in file
// order — the shared parse the by-id read (`codexConversationName`) and the enumerate-all read
// (`codexConversationNames`) both fold in their own way.
function* sidecarNameLines(lines: Iterable<string>): Generator<SidecarName> {
  for (const line of lines) {
    let record: { id?: unknown; thread_name?: unknown };
    // skip unparseable or truncated lines
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (typeof record.id === 'string' && validCodexThreadId(record.id) && typeof record.thread_name === 'string' && record.thread_name.length > 0) yield { id: record.id, name: record.thread_name };
  }
}

/**
 * The current name of every Codex/OMX thread, read once from the account-global
 * `session_index.jsonl` sidecar. Unlike `codexConversationName`'s by-id read — which scans
 * the tail for one recently active thread and fails *safe* for anything older — `list`
 * enumerates long-idle threads, so it makes one forward pass over the (bounded) sidecar and
 * maps every id at once, the last line for an id winning. An absent sidecar maps nothing; a
 * thread whose name predates the `maxIndexScanBytes` tail is likewise treated as unnamed
 * (fails safe to a generic label, never a wrong name).
 */
async function codexConversationNames(env: NodeJS.ProcessEnv): Promise<Readonly<Record<string, string>>> {
  const index = await sessionIndexCache.get(join(codexHome(env), 'session_index.jsonl')).catch(() => undefined);
  // missing or unreadable sidecars list no names
  return index?.named ?? {};
}

// the newest record timestamp in a rollout's bounded tail (epoch ms), never the file mtime —
// Codex appends open/close bookkeeping that would move mtime past the last real activity.
// Every rollout record carries a top-level ISO `timestamp`; 0 when none is readable.
function rolloutLastActiveAtFromRecords(lines: Iterable<string>): number {
  let latest = 0;
  // retain the newest valid timestamp in the bounded tail
  for (const line of lines) {
    let record: { timestamp?: unknown };
    // skip unparseable or truncated lines
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (typeof record.timestamp !== 'string') continue;
    const at = Date.parse(record.timestamp);
    if (!Number.isNaN(at) && at > latest) latest = at;
  }
  return latest;
}

// cover all 512 rollout candidates without scan-order churn
const rolloutLastActiveAtCache = new FileChangeCache(
  async file => rolloutLastActiveAtFromRecords(await readFileTail(file, maxListTailBytes)),
  { maxEntries: 1_024 }
);

// preserve a zero recency fallback on transient read errors
async function rolloutLastActiveAt(file: string): Promise<number> {
  return rolloutLastActiveAtCache.get(file).catch(() => 0);
}

/**
 * The Named Codex/OMX conversations started under each of the given directories, newest
 * (most recently active) first. One walk of the sessions tree — the same newest-first order
 * and 512-file cap `rolloutByCwd` uses — reads each rollout's `session_meta` first line for
 * id, cwd, originator and parentage, keeps only top-level (`parent_thread_id`-less)
 * `codex-tui` conversations whose recorded cwd matches one of the given directories raw or
 * canonical, and reads a bounded tail for `lastActiveAt`. The name is the sidecar's — a
 * rollout with no sidecar line is unnamed and omitted; `automatic` is never set for this kind,
 * which cannot tell a generated title from a typed one. Archived rollouts leave the sessions
 * tree, so they are absent. `directory` on each row is the given directory that matched (not
 * the possibly-canonical recorded cwd), so a listed row resolves back to its Worktree. On a
 * home deeper than the shared `maxCwdRolloutScans` cap the oldest Named rows are dropped, as
 * for the live-pane match.
 */
export async function codexConversationSummaries(directories: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ConversationSummary[]> {
  if (directories.length === 0) return [];
  // map a recorded cwd (raw or canonical) back to the given directory it should report as
  const directoryByPath = new Map<string, string>();
  for (const directory of directories) {
    if (!directoryByPath.has(directory)) directoryByPath.set(directory, directory);
    const canonical = await realpath(directory).catch(() => directory);
    if (!directoryByPath.has(canonical)) directoryByPath.set(canonical, directory);
  }
  const names = await codexConversationNames(env);
  const summaries: ConversationSummary[] = [];
  for await (const { file, metadata } of walkRollouts(codexHome(env))) {
    // keep only a top-level conversation started in one of the wanted directories
    if (metadata === undefined || metadata.parentThreadId !== undefined) continue;
    const startedIn = directoryByPath.get(metadata.cwd);
    if (startedIn === undefined) continue;
    // list only Named conversations — an unnamed rollout has no sidecar line
    const conversationName = names[metadata.id];
    if (conversationName === undefined) continue;
    summaries.push({ id: metadata.id, name: conversationName, lastActiveAt: await rolloutLastActiveAt(file), directory: startedIn });
  }
  summaries.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  return summaries;
}

/**
 * Codex records a turn's lifecycle in its rollout as ordinal-stamped events: a
 * `task_started`, the response items, then one terminal `task_complete` (carrying
 * the answer as `last_agent_message`) or `turn_aborted` on an interrupt. These
 * are the completion signal the native-Codex TUI never renders, so the console
 * reads them here instead of scraping the pane. Every record carries a monotonic
 * `ordinal`; the baseline snapshotted before a turn starts scopes the read to
 * that one turn.
 */

// the newest terminal turn among these rollout records past `sinceOrdinal`, its answer clamped
// to `maxAnswer` characters (a Review run reads a longer one than a captured Turn)
export function completionFromRecords(lines: Iterable<string>, sinceOrdinal: number, maxAnswer = maxAnswerLength): CompletionEvent {
  let newest: { kind: 'completed'; ordinal: number; answer: string } | { kind: 'aborted'; ordinal: number } | undefined;
  for (const line of lines) {
    let record: { type?: unknown; ordinal?: unknown; payload?: unknown };
    // skip unparseable or truncated lines
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    // consider only lifecycle events recorded after the baseline
    if (record.type !== 'event_msg' || typeof record.ordinal !== 'number' || record.ordinal <= sinceOrdinal) continue;
    // keep the newest terminal event; ignore non-terminal events at higher ordinals
    if (newest !== undefined && record.ordinal <= newest.ordinal) continue;
    if (record.payload === null || typeof record.payload !== 'object') continue;
    const payload = record.payload as { type?: unknown; last_agent_message?: unknown };
    if (payload.type === 'task_complete') {
      const message = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
      newest = { kind: 'completed', ordinal: record.ordinal, answer: message.length <= maxAnswer ? message : message.slice(0, maxAnswer) };
    } else if (payload.type === 'turn_aborted') {
      newest = { kind: 'aborted', ordinal: record.ordinal };
    }
  }
  return newest ?? { kind: 'pending' };
}

// the highest ordinal among these rollout records, or undefined when none parse
export function maxOrdinalFromRecords(lines: Iterable<string>): number | undefined {
  let max: number | undefined;
  for (const line of lines) {
    let ordinal: unknown;
    // skip unparseable or truncated lines
    try { ordinal = (JSON.parse(line) as { ordinal?: unknown }).ordinal; } catch { continue; }
    if (typeof ordinal === 'number' && (max === undefined || ordinal > max)) max = ordinal;
  }
  return max;
}

// compare one exact submitted prompt with durable user-message receipts
export function promptAcceptedFromRecords(lines: Iterable<string>, sinceOrdinal: number, prompt: string): boolean {
  const transported = queueReadyPrompt(prompt);
  // inspect each bounded rollout record
  for (const line of lines) {
    let parsed: unknown;
    // reject unparseable or truncated records
    try { parsed = JSON.parse(line) as unknown; } catch { continue; }
    // reject non-record json values
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as { type?: unknown; ordinal?: unknown; payload?: unknown };
    // require a response recorded after the pre-send baseline
    if (record.type !== 'response_item' || typeof record.ordinal !== 'number' || !Number.isFinite(record.ordinal) || record.ordinal <= sinceOrdinal) continue;
    // require one record payload
    if (record.payload === null || typeof record.payload !== 'object') continue;
    const payload = record.payload as { type?: unknown; role?: unknown; content?: unknown };
    // require one structured user message
    if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content) || payload.content.length !== 1) continue;
    const [content] = payload.content;
    // reject tool, instruction, and malformed content
    if (content === null || typeof content !== 'object') continue;
    const input = content as { type?: unknown; text?: unknown };
    // require one text input
    if (input.type !== 'input_text' || typeof input.text !== 'string') continue;
    // accept exact text or the known transport suffix
    if (input.text === prompt || input.text === transported) return true;
  }
  return false;
}

// convert a native finite epoch-second value exactly once
function lifecycleInstant(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value * 1_000;
  // reject values outside the ECMAScript date range
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return undefined;
  try { return new Date(milliseconds).toISOString(); } catch { return undefined; }
}

// read the single exact managed turn following one exact prompt receipt
export function managedPromptLifecycleFromRecords(lines: Iterable<string>, sinceOrdinal: number, prompt: { fingerprint: string; transportFingerprint: string }, checkpoint: { receiptOrdinal?: number; startOrdinal?: number; turnId?: string; startedAt?: string } = {}): ManagedPromptLifecycleEvidence {
  let receiptOrdinal = checkpoint.receiptOrdinal;
  let startOrdinal = checkpoint.startOrdinal;
  let turnId = checkpoint.turnId;
  let startedAt = checkpoint.startedAt;
  // reject incomplete or malformed durable checkpoints
  if (startOrdinal !== undefined && (receiptOrdinal === undefined || typeof turnId !== 'string' || turnId.length < 1 || turnId.length > 256 || startedAt === undefined || !Number.isFinite(Date.parse(startedAt)))) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
  // inspect the bounded rollout in native ordinal order
  for (const line of lines) {
    let parsed: unknown;
    // skip malformed tail fragments without inventing evidence
    try { parsed = JSON.parse(line) as unknown; } catch { continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as { type?: unknown; ordinal?: unknown; payload?: unknown };
    if (typeof record.ordinal !== 'number' || !Number.isFinite(record.ordinal) || record.ordinal <= Math.max(sinceOrdinal, startOrdinal ?? receiptOrdinal ?? sinceOrdinal)) continue;
    if (record.payload === null || typeof record.payload !== 'object') continue;
    const payload = record.payload as { type?: unknown; role?: unknown; content?: unknown; turn_id?: unknown; started_at?: unknown; completed_at?: unknown };
    const userText = record.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content) && payload.content.length === 1
      && payload.content[0] !== null && typeof payload.content[0] === 'object' && (payload.content[0] as { type?: unknown }).type === 'input_text'
      && typeof (payload.content[0] as { text?: unknown }).text === 'string' ? (payload.content[0] as { text: string }).text : undefined;
    // a later user receipt cannot belong to the already-pinned native turn
    if (userText !== undefined && startOrdinal !== undefined) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
    // bind exactly one receipt and reject a competing user turn before start
    if (userText !== undefined && startOrdinal === undefined) {
      const fingerprint = createHash('sha256').update(userText).digest('hex');
      if (receiptOrdinal === undefined && (fingerprint === prompt.fingerprint || fingerprint === prompt.transportFingerprint)) receiptOrdinal = record.ordinal;
      else return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
      continue;
    }
    // a native start before the managed receipt cannot belong to this prompt
    if (receiptOrdinal === undefined && record.type === 'event_msg' && payload.type === 'task_started') return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
    // the first event after receipt must establish a valid native turn
    if (receiptOrdinal !== undefined && startOrdinal === undefined && record.type === 'event_msg' && payload.type === 'task_started') {
      const instant = lifecycleInstant(payload.started_at);
      if (typeof payload.turn_id !== 'string' || payload.turn_id.length < 1 || payload.turn_id.length > 256 || instant === undefined) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      startOrdinal = record.ordinal;
      turnId = payload.turn_id;
      startedAt = instant;
      continue;
    }
    // a competing turn start makes the remaining terminal sequence ambiguous
    if (startOrdinal !== undefined && record.type === 'event_msg' && payload.type === 'task_started' && payload.turn_id !== turnId) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
    // terminalize only the exact native turn
    if (startOrdinal !== undefined && record.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
      if (payload.turn_id !== turnId) continue;
      const finishedAt = lifecycleInstant(payload.completed_at);
      if (finishedAt === undefined || Date.parse(finishedAt) <= Date.parse(startedAt!)) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      return { state: 'finished', source: 'codex-rollout', parserVersion: 1, receiptOrdinal: receiptOrdinal!, startOrdinal, terminalOrdinal: record.ordinal, turnId: turnId!, startedAt: startedAt!, finishedAt };
    }
  }
  return { state: 'pending', source: 'codex-rollout', parserVersion: 1, ...(receiptOrdinal === undefined ? {} : { receiptOrdinal }), ...(startOrdinal === undefined ? {} : { startOrdinal, turnId, startedAt }) };
}

// read one rollout's current ordinal without leaking filesystem failures
async function rolloutOrdinal(file: string): Promise<number | undefined> {
  const lines = await readFileTail(file, maxCompletionScanBytes).catch(() => undefined);
  return lines === undefined ? undefined : maxOrdinalFromRecords(lines);
}

// share receipt and completion rollout resolution
type BaselineRollout = { kind: 'pending' } | { kind: 'resolved'; file: string };

// resolve the rollout named by one completion baseline
async function rolloutForBaseline(baseline: CompletionBaseline): Promise<BaselineRollout> {
  // a resolved external-reset baseline follows its exact pane once
  if ('rollout' in baseline) {
    const resetPane = baseline.resetPane;
    const replacement = resetPane === undefined ? undefined : await paneRollout(resetPane).catch(() => undefined);
    // pin the first replacement and stop later pane changes from drifting the turn
    if (resetPane !== undefined && baseline.resetPane === resetPane && replacement !== undefined && replacement.file !== baseline.rollout) {
      baseline.rollout = replacement.file;
      baseline.ordinal = 0;
      delete baseline.resetPane;
    }
    return { kind: 'resolved', file: baseline.rollout };
  }
  const resolved = await rolloutByCwd(baseline.cwd, baseline.resetAt).catch(() => undefined);
  // Codex opens the new thread's rollout only at its first turn
  return resolved === undefined ? { kind: 'pending' } : { kind: 'resolved', file: resolved.file };
}

// the newest terminal turn recorded past the baseline's ordinal. A resolved
// baseline reads the exact file it pinned, so it never drifts to a sibling pane's
// rollout mid-turn; a deferred baseline resolves the post-reset thread first (the
// newest cwd-matching rollout created after the reset), staying `pending` until it
// appears. `maxAnswer` clamps the answer, the captured-Turn bound when absent.
export async function codexTurnSince(baseline: CompletionBaseline, maxAnswer = maxAnswerLength): Promise<CompletionEvent | undefined> {
  const rollout = await rolloutForBaseline(baseline);
  // keep polling until a deferred rollout appears
  if (rollout.kind === 'pending') return { kind: 'pending' };
  const lines = await readFileTail(rollout.file, maxCompletionScanBytes).catch(() => undefined);
  return lines === undefined ? undefined : completionFromRecords(lines, baseline.ordinal, maxAnswer);
}

// confirm Codex durably recorded the submitted prompt after its baseline
export async function codexPromptAccepted(baseline: CompletionBaseline, prompt: string): Promise<boolean> {
  const rollout = await rolloutForBaseline(baseline);
  // a deferred rollout cannot contain a receipt until it exists
  if (rollout.kind === 'pending') return false;
  const lines = await readFileTail(rollout.file, maxCompletionScanBytes).catch(() => undefined);
  return lines === undefined ? false : promptAcceptedFromRecords(lines, baseline.ordinal, prompt);
}

// reconcile exact managed-turn evidence from the pinned rollout only
export async function codexManagedPromptLifecycle(baseline: CompletionBaseline, prompt: { fingerprint: string; transportFingerprint: string }, checkpoint?: { receiptOrdinal?: number; startOrdinal?: number; turnId?: string; startedAt?: string }): Promise<ManagedPromptLifecycleEvidence> {
  const rollout = await rolloutForBaseline(baseline);
  // a deferred rollout has not recorded a receipt yet
  if (rollout.kind === 'pending') return { state: 'pending', source: 'codex-rollout', parserVersion: 1 };
  const metadata = await rolloutMetadataCache.get(rollout.file).catch(() => undefined);
  if (metadata?.cliVersion !== managedLifecycleCodexVersion) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
  const lines = await readFileTail(rollout.file, maxCompletionScanBytes).catch(() => undefined);
  return lines === undefined ? { state: 'invalid', reason: 'missing_lifecycle_evidence' } : managedPromptLifecycleFromRecords(lines, baseline.ordinal, prompt, checkpoint);
}

export const managedLifecycleCodexVersion = '0.164.0';
const compatibilityPrompt = 'sanitized managed lifecycle probe';
const compatibilityIdentity = { fingerprint: createHash('sha256').update(compatibilityPrompt).digest('hex'), transportFingerprint: createHash('sha256').update(queueReadyPrompt(compatibilityPrompt)).digest('hex') };
const compatibilityRecords = [
  JSON.stringify({ type: 'session_meta', ordinal: 0, payload: { id: '019a1234-5678-7000-8000-000000000001', cwd: '/sanitized/worktree', originator: 'codex-tui', cli_version: managedLifecycleCodexVersion } }),
  JSON.stringify({ type: 'response_item', ordinal: 41, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: compatibilityPrompt }] } }),
  JSON.stringify({ type: 'event_msg', ordinal: 42, payload: { type: 'task_started', turn_id: 'sanitized-turn', started_at: 1_792_775_807 } }),
  JSON.stringify({ type: 'event_msg', ordinal: 43, payload: { type: 'task_complete', turn_id: 'sanitized-turn', completed_at: 1_792_776_107 } })
];

// require the pinned native version and its sanitized structural probe
export function codexManagedLifecycleCompatible(version = process.env.CODEX_VERSION): boolean {
  if (version !== undefined && version !== managedLifecycleCodexVersion) return false;
  const evidence = managedPromptLifecycleFromRecords(compatibilityRecords, 40, compatibilityIdentity);
  return evidence.state === 'finished' && evidence.receiptOrdinal === 41 && evidence.startOrdinal === 42 && evidence.terminalOrdinal === 43 && evidence.turnId === 'sanitized-turn';
}

// resolve the pane's rollout and snapshot its current max ordinal before a turn
// starts. The fd-walk (`pid`) is exact; the working-directory match (`cwd`) is the
// privilege-free fallback when a confined service cannot readlink the pane's
// descriptors. Returns undefined when no single rollout resolves or it cannot be read.
//
// `resetAt` marks a turn after a conversation reset. When the pane already holds a
// rollout created at or after that instant, pin its current ordinal: an external
// first turn may have opened or completed it and must not satisfy the next managed
// prompt. Otherwise defer by cwd + instant until Codex opens the post-reset rollout
// (the completion contract in `types.ts` covers why deferral needs the cwd).
// `followReset` instead observes the exact pane's first file replacement when the
// reset was discovered too late to have a trustworthy timestamp.
export async function codexRolloutBaseline(pane: { pid: number; cwd?: string }, resetAt?: number, followReset = false): Promise<CompletionBaseline | undefined> {
  const selected = await paneRollout(pane);
  // an externally observed reset follows this exact pane from its current file
  if (followReset) {
    // require one current rollout to follow
    if (selected === undefined) return undefined;
    const ordinal = await rolloutOrdinal(selected.file);
    // require a readable starting position
    if (ordinal === undefined) return undefined;
    return { rollout: selected.file, ordinal, resetPane: { pid: pane.pid, ...(pane.cwd === undefined ? {} : { cwd: pane.cwd }) } };
  }
  // prefer an already-open fresh rollout over the deferred reset lookup
  if (resetAt !== undefined && selected !== undefined) {
    const metadata = await rolloutMetadataCache.get(selected.file).catch(() => undefined);
    // require a session created no earlier than the submitted reset
    if (metadata?.createdAt !== undefined && metadata.createdAt >= resetAt) {
      const ordinal = await rolloutOrdinal(selected.file);
      // exclude every external event already recorded in the fresh thread
      if (ordinal !== undefined) return { rollout: selected.file, ordinal };
    }
  }
  // a stale or unresolved pane rollout still needs post-reset cwd resolution
  if (resetAt !== undefined) return pane.cwd === undefined ? undefined : { cwd: pane.cwd, resetAt, ordinal: 0 };
  // require one normal rollout to pin
  if (selected === undefined) return undefined;
  const ordinal = await rolloutOrdinal(selected.file);
  return ordinal === undefined ? undefined : { rollout: selected.file, ordinal };
}
