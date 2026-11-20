import { createHash } from 'node:crypto';
import { readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileHead, readFileTail } from './bounded-file.js';
import { queueReadyPrompt } from './codex-turns.js';
import { FileChangeCache } from './file-change-cache.js';
import { boundedReplyMessages, readStableJsonlTail, type AuthoredReplyMessage } from './reply-conversation.js';
import type { CompletionBaseline, CompletionEvent, Conversation, ConversationSummary, ManagedPromptLifecycleEvidence } from './types.js';

/**
 * Codex conversation lookup, gathered behind the Adapter (ADR 0002). These are
 * the only filesystem-touching functions the Codex Adapter owns: the `/proc`
 * fd-walk that finds the rollout files and writer locks a pane holds open, the bounded
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
const maxReplySourceScanBytes = 8 * 1024 * 1024;
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
// a catalog slot belongs to a listed conversation, not a scanned file
const maxListedConversations = 512;
// bound the per-rollout tail read that finds a listed row's `lastActiveAt`: the newest
// record's timestamp sits at the very end, so a small tail suffices (mirrors Claude's list)
const maxListTailBytes = 256 * 1024;

type RolloutRef = { id: string; relativePath: string };
type RolloutMetadata = { id: string; cwd: string; parentThreadId?: string; createdAt?: number };
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

// require an exclusive writer lock on this profile's file across host mounts
async function ownsWriterLock(proc: string, pid: number, descriptor: string, id: string): Promise<boolean> {
  const info = await readFile(`${proc}/${pid}/fdinfo/${descriptor}`, 'utf8').catch(() => '');
  // opening the file alone does not prove ownership
  const owner = /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s/mu.exec(info)?.[1];
  if (owner !== String(pid)) return false;
  const held = await stat(`${proc}/${pid}/fd/${descriptor}`, { bigint: true }).catch(() => undefined);
  const local = await stat(join(codexHome(), 'thread-writer-locks', `${id}.lock`), { bigint: true }).catch(() => undefined);
  return held !== undefined && local !== undefined && held.dev === local.dev && held.ino === local.ino;
}

// collect exact rollout and writer identities held by one pane process tree
export async function openPaneThreads(root: number): Promise<{ rollouts: RolloutRef[]; writers: Set<string> }> {
  const proc = procRoot();
  const pending = [root];
  const seen = new Set<number>();
  const rollouts = new Map<string, RolloutRef>();
  const writers = new Set<string>();
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
      // use the directory fallback only when exact file evidence is unavailable
      const descriptors = await readdir(`${proc}/${pid}/fd`).catch(() => []);
      // inspect the bounded descriptor set for either native history format
      for (const descriptor of descriptors) {
        if (inspectedDescriptors >= maxRolloutEntries) break;
        inspectedDescriptors += 1;
        const target = await readlink(`${proc}/${pid}/fd/${descriptor}`).catch(() => '');
        const match = /(?:^|\/)(sessions\/[^\0]{1,3800}\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl)$/iu.exec(target);
        // retain exact Codex rollout filenames only
        if (match?.[1] !== undefined && match[2] !== undefined && !match[1].split('/').includes('..')) rollouts.set(`${match[2]}:${match[1]}`, { id: match[2], relativePath: match[1] });
        const writer = /(?:^|\/)thread-writer-locks\/([^/]+)\.lock$/u.exec(target)?.[1];
        // paginated and unwritten threads may hold only a writer lock
        if (writer !== undefined && validCodexThreadId(writer) && await ownsWriterLock(proc, pid, descriptor, writer)) writers.add(writer);
      }
    } catch {
      // ignore exited or unreadable processes
    }
  }
  return { rollouts: [...rollouts.values()], writers };
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
    const payload = record.payload as { id?: unknown; cwd?: unknown; originator?: unknown; parent_thread_id?: unknown; timestamp?: unknown };
    // accept only top-level interactive Codex conversations
    if (typeof payload.id !== 'string' || !validCodexThreadId(payload.id) || typeof payload.cwd !== 'string' || payload.originator !== 'codex-tui') return undefined;
    // the recorded session start, epoch ms; used to tell a post-reset rollout from the pre-reset one
    const createdAt = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
    return { id: payload.id, cwd: payload.cwd, ...(typeof payload.parent_thread_id === 'string' ? { parentThreadId: payload.parent_thread_id } : {}), ...(Number.isFinite(createdAt) ? { createdAt } : {}) };
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
  // cap raw reads only for the live-pane fallback
  for await (const file of rolloutFiles(codexHome(), maxCwdRolloutScans)) {
    const metadata = await rolloutMetadataCache.get(file).catch(() => undefined);
    // match the pane's live top-level conversation in this directory, skipping any
    // rollout that predates a supplied reset instant (the pre-reset thread)
    if (metadata !== undefined && metadata.parentThreadId === undefined && (metadata.cwd === cwd || metadata.cwd === canonical)
      && (createdAfter === undefined || (metadata.createdAt !== undefined && metadata.createdAt > createdAfter))) return { id: metadata.id, file };
  }
  return undefined;
}

// walk filenames newest-first so callers can choose a limit before opening transcripts
async function* rolloutFiles(home: string, limit = Infinity): AsyncGenerator<string> {
  const pending = [join(home, 'sessions')];
  let inspected = 0;
  // visit the newest date partition first
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    // newest rollout first within a partition, newest date-partition first across them
    const files = entries.filter(entry => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')).map(entry => entry.name).sort((left, right) => right.localeCompare(left));
    const subdirectories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort((left, right) => left.localeCompare(right)).map(name => join(directory, name));
    // yield paths without statting or opening transcripts
    for (const name of files) {
      yield join(directory, name);
      // stop the live-pane scan at its raw-file budget
      if (++inspected >= limit) return;
    }
    // ascending push + LIFO pop visits the highest-numbered (most recent) partition first
    pending.push(...subdirectories);
  }
}

// resolve writer ids exactly and exclude proven subagents
async function rolloutByWriters(writers: ReadonlySet<string>, open: readonly RolloutRef[]): Promise<{ id: string; file: string } | undefined> {
  const home = codexHome();
  const unresolved = new Set(writers);
  const main: Array<{ id: string; file: string }> = [];
  // classify only the current writers with matching metadata
  const inspect = async (id: string, file: string): Promise<void> => {
    // skip unrelated or already resolved ids
    if (!unresolved.has(id)) return;
    const metadata = await rolloutMetadataCache.get(file).catch(() => undefined);
    // a missing or mismatched rollout cannot rule out another top-level thread
    if (metadata?.id !== id) return;
    unresolved.delete(id);
    // classify children without selecting them
    if (metadata.parentThreadId === undefined) main.push({ id, file });
  };
  // use the pane's open rollouts first
  for (const ref of open) {
    // open only valid paths in this store
    if (validRolloutRef(ref)) await inspect(ref.id, join(home, ref.relativePath));
  }
  // paginated history may not hold a file open, so find only its exact filename
  if (unresolved.size > 0) {
    // scan bounded filenames for unresolved writers
    for await (const file of rolloutFiles(home, maxRolloutEntries)) {
      const id = /-([0-9a-f-]{36})\.jsonl$/iu.exec(file)?.[1];
      // ignore filenames without a thread suffix
      if (id !== undefined) await inspect(id, file);
      // stop once every writer is classified
      if (unresolved.size === 0) break;
    }
  }
  return unresolved.size === 0 && main.length === 1 ? main[0] : undefined;
}

// the pane's single top-level rollout or the legacy directory fallback
async function paneRollout(pane: { pid: number; cwd?: string }): Promise<{ id: string; file: string } | undefined> {
  const { rollouts, writers } = await openPaneThreads(pane.pid);
  // a known writer must never inherit a different thread's history
  if (writers.size > 0) return await rolloutByWriters(writers, rollouts);
  return await selectTopLevelRollout(rollouts) ?? (pane.cwd === undefined ? undefined : await rolloutByCwd(pane.cwd));
}

/** one exact live Codex rollout's current reply-suggestion evidence */
export type CodexReplyConversation = {
  conversationId: string;
  model: string;
  provider: string;
  effort: string;
  messages: AuthoredReplyMessage[];
  transcriptGeneration: string;
};

// exclude context records injected into the user role by the host runtime
function codexInjectedContext(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<permissions instructions>')
    || trimmed.startsWith('<apps_instructions>')
    || trimmed.startsWith('<skills_instructions>')
    || trimmed.startsWith('<hook_prompt')
    || trimmed.startsWith('Message Type: NEW_TASK')
    || trimmed.startsWith('Message Type: MESSAGE');
}

// read one authored message record without tool, attachment or reasoning blocks
function codexReplyMessage(record: { ordinal?: unknown; payload?: unknown }): AuthoredReplyMessage | undefined {
  // require one stable rollout ordinal and structured response item
  if (!Number.isSafeInteger(record.ordinal) || record.payload === null || typeof record.payload !== 'object') return undefined;
  const payload = record.payload as { type?: unknown; id?: unknown; role?: unknown; content?: unknown; internal_chat_message_metadata_passthrough?: unknown };
  // ignore every nonmessage payload
  if (payload.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant') || !Array.isArray(payload.content)) return undefined;
  const allowed = payload.role === 'user' ? new Set(['input_text']) : new Set(['output_text', 'text']);
  // copy only authored text while dropping attachments, tools and reasoning
  const text = payload.content.flatMap(block => block !== null && typeof block === 'object' && allowed.has((block as { type?: unknown }).type as string)
    && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []).join('\n');
  // omit empty and injected context records
  if (text.trim() === '' || (payload.role === 'user' && codexInjectedContext(text))) return undefined;
  if (payload.role === 'user' && payload.internal_chat_message_metadata_passthrough !== undefined) {
    const metadata = payload.internal_chat_message_metadata_passthrough;
    // require metadata to acknowledge the authored text even when attachments accompany it
    if (metadata === null || typeof metadata !== 'object' || !Array.isArray((metadata as { content_item_kinds?: unknown }).content_item_kinds)
      || !(metadata as { content_item_kinds: unknown[] }).content_item_kinds.includes('user.text')) return undefined;
  }
  const nativeId = typeof payload.id === 'string' && payload.id !== '' ? payload.id : payload.role;
  return { id: `${record.ordinal}:${nativeId}`, role: payload.role, text };
}

// parse the newest exact-thread settings and bounded authored messages
function codexReplyRecords(lines: readonly string[], conversationId: string, truncated: boolean): Omit<CodexReplyConversation, 'transcriptGeneration'> | undefined {
  let settings: { model: string; provider: string; effort: string } | undefined;
  const messages: AuthoredReplyMessage[] = [];
  let reachedBoundary = !truncated;
  // preserve rollout order while selecting the last current-settings event
  for (const line of lines) {
    let parsed: unknown;
    // malformed complete records make the source ambiguous
    try { parsed = JSON.parse(line) as unknown; } catch { return undefined; }
    // reject primitive rollout records
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as { type?: unknown; ordinal?: unknown; payload?: unknown };
    if (record.type === 'event_msg' && record.payload !== null && typeof record.payload === 'object' && (record.payload as { type?: unknown }).type === 'thread_settings_applied') {
      const payload = record.payload as { thread_id?: unknown; thread_settings?: unknown };
      // another thread's copied settings do not describe this rollout
      if (typeof payload.thread_id !== 'string' || payload.thread_id.toLowerCase() !== conversationId.toLowerCase()) continue;
      const selected = payload.thread_settings;
      // the pinned native event nests its authoritative settings rather than flattening them
      if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) return undefined;
      const current = selected as { model?: unknown; model_provider_id?: unknown; reasoning_effort?: unknown };
      // malformed matching settings fail closed rather than falling back
      if (typeof current.model !== 'string' || current.model === '' || typeof current.model_provider_id !== 'string' || current.model_provider_id === ''
        || typeof current.reasoning_effort !== 'string' || current.reasoning_effort === '') return undefined;
      settings = { model: current.model, provider: current.model_provider_id, effort: current.reasoning_effort };
      continue;
    }
    // only response items can contribute authored context
    if (record.type !== 'response_item') continue;
    const message = codexReplyMessage(record);
    // nonmessage response items and excluded context stay outside inference
    if (message === undefined) continue;
    // a typed user record is the first safe boundary after a truncated prefix
    if (!reachedBoundary && message.role === 'user') reachedBoundary = true;
    if (reachedBoundary) messages.push(message);
  }
  // require current exact settings and a complete post-boundary context
  if (settings === undefined || !reachedBoundary) return undefined;
  const bounded = boundedReplyMessages(messages);
  return bounded === undefined ? undefined : { conversationId, ...settings, messages: bounded };
}

/** read the exact pane rollout, current settings and authored reply context */
export async function codexReplyConversation(pane: { pid: number; cwd?: string; conversationId?: string }): Promise<CodexReplyConversation | undefined> {
  // reject a malformed reported thread before filesystem discovery
  if (pane.conversationId !== undefined && !validCodexThreadId(pane.conversationId)) return undefined;
  const selected = await paneRollout(pane).catch(() => undefined);
  // require one exact selected rollout and any reported id to match it
  if (selected === undefined || (pane.conversationId !== undefined && selected.id !== pane.conversationId)) return undefined;
  const tail = await readStableJsonlTail(selected.file, maxReplySourceScanBytes).catch(() => undefined);
  // unstable and unreadable generations are not source evidence
  if (tail === undefined) return undefined;
  const parsed = codexReplyRecords(tail.lines, selected.id, tail.truncated);
  return parsed === undefined ? undefined : { ...parsed, transcriptGeneration: tail.generation };
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

// cover a full catalog's recency reads without scan-order churn
const rolloutLastActiveAtCache = new FileChangeCache(
  async file => rolloutLastActiveAtFromRecords(await readFileTail(file, maxListTailBytes)),
  { maxEntries: 1_024 }
);

// preserve a zero recency fallback on transient read errors
async function rolloutLastActiveAt(file: string): Promise<number> {
  return rolloutLastActiveAtCache.get(file).catch(() => 0);
}

/**
 * The Named Codex/OMX conversations started under the given directories. Walk active
 * rollout filenames newest-first, opening only IDs present in the name index. Unnamed
 * threads, children and out-of-scope directories don't consume the listing budget.
 * Order the selected conversations by last activity, using a bounded tail read.
 * `directory` is the given path that matched, so the row resolves back to its Worktree.
 */
export async function codexConversationSummaries(directories: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ConversationSummary[]> {
  // skip stores that cannot contribute a named conversation
  if (directories.length === 0) return [];
  const names = await codexConversationNames(env);
  if (Object.keys(names).length === 0) return [];
  // map a recorded cwd (raw or canonical) back to the given directory it should report as
  const directoryByPath = new Map<string, string>();
  for (const directory of directories) {
    if (!directoryByPath.has(directory)) directoryByPath.set(directory, directory);
    const canonical = await realpath(directory).catch(() => directory);
    if (!directoryByPath.has(canonical)) directoryByPath.set(canonical, directory);
  }
  const summaries: ConversationSummary[] = [];
  // walk past unmatched filenames without reading their transcripts
  for await (const file of rolloutFiles(codexHome(env))) {
    const id = /-([0-9a-f-]{36})\.jsonl$/iu.exec(file)?.[1];
    const conversationName = id === undefined ? undefined : names[id];
    // an unindexed rollout cannot contribute a listed row
    if (conversationName === undefined) continue;
    const metadata = await rolloutMetadataCache.get(file).catch(() => undefined);
    // verify identity and parentage before exposing a transcript
    if (metadata === undefined || metadata.id !== id || metadata.parentThreadId !== undefined) continue;
    const startedIn = directoryByPath.get(metadata.cwd);
    // preserve the requested folder scope
    if (startedIn === undefined) continue;
    summaries.push({ id: metadata.id, name: conversationName, lastActiveAt: await rolloutLastActiveAt(file), directory: startedIn });
    // apply the catalog limit only after all eligibility checks pass
    if (summaries.length >= maxListedConversations) break;
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

// convert native integer epoch seconds without accepting changed timestamp units
function lifecycleInstant(value: unknown): string | undefined {
  // reject duration-like values, changed units and dates outside modern four-digit years
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 946_684_800 || value >= 253_402_300_800) return undefined;
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
  // require exact distinct checkpoints after the managed baseline
  if (!Number.isSafeInteger(sinceOrdinal) || sinceOrdinal < 0 || receiptOrdinal !== undefined && (!Number.isSafeInteger(receiptOrdinal) || receiptOrdinal <= sinceOrdinal) || startOrdinal !== undefined && (!Number.isSafeInteger(startOrdinal) || startOrdinal <= sinceOrdinal || startOrdinal === receiptOrdinal)) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
  // publish a native start only when an exact receipt already binds it
  if (startOrdinal !== undefined && (receiptOrdinal === undefined || typeof turnId !== 'string' || turnId.length < 1 || turnId.length > 256 || startedAt === undefined || !Number.isFinite(Date.parse(startedAt)) || Date.parse(startedAt) <= 0)) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
  const sinceCheckpoint = Math.max(sinceOrdinal, startOrdinal ?? sinceOrdinal, receiptOrdinal ?? sinceOrdinal);
  let lastOrdinal = sinceCheckpoint;
  const records = Array.from(lines);
  // inspect the bounded rollout in native ordinal order
  for (let index = 0; index < records.length; index += 1) {
    const line = records[index]!;
    const finalSegment = index === records.length - 1;
    // a final delimiter is not an additional native record
    if (finalSegment && line === '') continue;
    let parsed: unknown;
    // parse one native record before trusting its fields
    try { parsed = JSON.parse(line) as unknown; } catch {
      // wait only for a possible final append-in-progress fragment
      if (finalSegment) break;
      return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
    }
    // complete non-record values cannot establish native evidence
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
    const record = parsed as { type?: unknown; ordinal?: unknown; payload?: unknown };
    // reject changed ordinal formats rather than guessing record order
    if (typeof record.ordinal !== 'number' || !Number.isSafeInteger(record.ordinal) || record.ordinal < 0) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
    // skip historical records only before the first unprocessed record
    if (record.ordinal <= sinceCheckpoint && lastOrdinal === sinceCheckpoint) continue;
    // duplicate or reversed native ordinals cannot prove one exact turn
    if (record.ordinal <= lastOrdinal) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
    lastOrdinal = record.ordinal;
    // require a typed native envelope with a structured payload
    if (typeof record.type !== 'string' || record.type.length === 0 || record.payload === null || typeof record.payload !== 'object' || Array.isArray(record.payload)) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
    const payload = record.payload as { type?: unknown; role?: unknown; content?: unknown; turn_id?: unknown; started_at?: unknown; completed_at?: unknown; internal_chat_message_metadata_passthrough?: unknown };
    const userText = record.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content) && payload.content.length === 1
      && payload.content[0] !== null && typeof payload.content[0] === 'object' && (payload.content[0] as { type?: unknown }).type === 'input_text'
      && typeof (payload.content[0] as { text?: unknown }).text === 'string' ? (payload.content[0] as { text: string }).text : undefined;
    // correlate only native user receipts and explicitly classified bootstrap context
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const rawMetadata = payload.internal_chat_message_metadata_passthrough;
      // reject changed receipt metadata shapes rather than dropping their turn identity
      if (rawMetadata !== undefined && (rawMetadata === null || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata))) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      const metadata = rawMetadata as { turn_id?: unknown; content_item_kinds?: unknown } | undefined;
      const receiptTurnId = metadata?.turn_id;
      // validate direct turn identity whenever the native format supplies metadata
      if (metadata !== undefined && (typeof receiptTurnId !== 'string' || receiptTurnId.length < 1 || receiptTurnId.length > 256)) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      // a receipt for another native turn cannot belong to this managed prompt
      if (turnId !== undefined && receiptTurnId !== undefined && receiptTurnId !== turnId) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
      const kinds = metadata?.content_item_kinds;
      // validate the two native bootstrap blocks without reading instruction contents
      const bootstrap = Array.isArray(kinds) && kinds.length === 2 && kinds[0] === 'agents_md.instructions' && kinds[1] === 'environments.environment_context'
        && Array.isArray(payload.content) && payload.content.length === 2 && payload.content.every(item => item !== null && typeof item === 'object' && item.type === 'input_text' && typeof item.text === 'string');
      // skip only bootstrap context bound to the still-unclaimed native start
      if (bootstrap && startOrdinal !== undefined && receiptOrdinal === undefined && receiptTurnId === turnId) continue;
      // other multipart messages cannot prove an exact prompt receipt
      if (userText === undefined) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
      // start-first formats must directly bind the receipt to their tentative turn
      if (startOrdinal !== undefined && receiptTurnId === undefined) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      const fingerprint = createHash('sha256').update(userText).digest('hex');
      // a second or unrelated receipt contaminates this managed interval
      if (receiptOrdinal === undefined && (fingerprint === prompt.fingerprint || fingerprint === prompt.transportFingerprint)) receiptOrdinal = record.ordinal;
      else return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
      // retain direct receipt binding across receipt-first polling checkpoints
      if (typeof receiptTurnId === 'string') turnId = receiptTurnId;
      continue;
    }
    // keep an early native start tentative until its exact receipt arrives
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      // multiple starts cannot identify one uncontaminated managed turn
      if (startOrdinal !== undefined) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
      // preserve a receipt-first turn identity across later native evidence
      if (turnId !== undefined && payload.turn_id !== turnId) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
      const instant = lifecycleInstant(payload.started_at);
      // require explicit native identity and time fields
      if (typeof payload.turn_id !== 'string' || payload.turn_id.length < 1 || payload.turn_id.length > 256 || instant === undefined) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      startOrdinal = record.ordinal;
      turnId = payload.turn_id;
      startedAt = instant;
      continue;
    }
    // terminalize only the exact native turn
    if (record.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
      // malformed identities cannot masquerade as unrelated valid terminals
      if (typeof payload.turn_id !== 'string' || payload.turn_id.length < 1 || payload.turn_id.length > 256) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      // another turn's terminal cannot complete this activity
      if (startOrdinal === undefined || payload.turn_id !== turnId) continue;
      // a terminal preceding the receipt cannot be paired with a later prompt
      if (receiptOrdinal === undefined) return { state: 'invalid', reason: 'missing_lifecycle_evidence' };
      const finishedAt = lifecycleInstant(payload.completed_at);
      // preserve only explicit positive native intervals
      if (finishedAt === undefined || Date.parse(finishedAt) <= Date.parse(startedAt!)) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
      return { state: 'finished', source: 'codex-rollout', parserVersion: 1, receiptOrdinal: receiptOrdinal!, startOrdinal, terminalOrdinal: record.ordinal, turnId: turnId!, startedAt: startedAt!, finishedAt };
    }
  }
  return { state: 'pending', source: 'codex-rollout', parserVersion: 1, ...(receiptOrdinal === undefined ? {} : { receiptOrdinal, ...(turnId === undefined ? {} : { turnId }), ...(startOrdinal === undefined ? {} : { startOrdinal, startedAt }) }) };
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
  // require native session metadata without pinning a CLI release label
  if (metadata === undefined) return { state: 'invalid', reason: 'unsupported_lifecycle_contract' };
  const lines = await readFileTail(rollout.file, maxCompletionScanBytes).catch(() => undefined);
  return lines === undefined ? { state: 'invalid', reason: 'missing_lifecycle_evidence' } : managedPromptLifecycleFromRecords(lines, baseline.ordinal, prompt, checkpoint);
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
