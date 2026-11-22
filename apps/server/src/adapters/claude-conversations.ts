import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readFileHead, readFileTail } from './bounded-file.js';
import { FileChangeCache } from './file-change-cache.js';
import { boundedReplyMessages, readStableJsonlTail, type AuthoredReplyMessage } from './reply-conversation.js';
import type { ConversationSummary } from './types.js';

/**
 * Claude Code Conversation lookup for the Adapter (ADR 0002). A Conversation id is
 * a session UUID; its name is read from the transcript on disk. The console never
 * walks `/proc` for Claude (its transcript fd is not held open) and has no
 * `discover` — a reported `@rac_session` id, or nothing.
 *
 * The config directory is resolved under an injectable root: the test seam
 * `RAC_CLAUDE_CONFIG_DIR` wins, then Claude's own `CLAUDE_CONFIG_DIR`, then
 * `~/.claude`.
 */

const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// bound the transcript read: the human `custom-title`, the generated `ai-title`
// and the first typed prompt all sit near the head, so a bounded head scan finds
// a name without loading a long conversation into memory (mirrors Codex's bounded
// rollout reads).
const maxTitleScanBytes = 4 * 1024 * 1024;
// the sidecar holds one small `{ "customTitle": "…" }` object; bound its read like
// every other read in this file rather than slurping an arbitrary path
const maxSidecarBytes = 64 * 1024;
const maxTitleLength = 120;
// listing bounds: open only the newest transcripts per directory, and scan a bounded
// head (the entrypoint marker and any leading `custom-title` sit near it) plus a bounded
// tail (Claude re-emits `custom-title`/`ai-title` at every prompt boundary and the last
// timestamped record lives at the end).
const maxListedTranscripts = 200;
const maxListHeadBytes = 128 * 1024;
const maxListTailBytes = 256 * 1024;
// a `-p`/SDK run is persisted but hidden from Claude's own picker; its records carry one of
// these entrypoints
const sdkEntrypoints = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);
// bound the final-message read: the reply sits at the transcript's end, and a Review run's
// JSON reply may run to hundreds of kilobytes once escaped
const maxFinalMessageScanBytes = 8 * 1024 * 1024;
// bound the transcript a structured Agent's history is read from: its latest records
const maxHistoryScanBytes = 8 * 1024 * 1024;
// discovery polls this reader, so keep each pane read small and fail safe on an oversized record
const maxLatestMessageScanBytes = 512 * 1024;
const maxReplySourceScanBytes = 8 * 1024 * 1024;
// a top-level transcript filename is exactly `<session-uuid>.jsonl`
const transcriptFile = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

export function validClaudeSessionId(id: string): boolean {
  return sessionId.test(id);
}

// a Conversation's transcript path under the config directory
function transcriptPath(id: string, cwd: string, env: NodeJS.ProcessEnv): string {
  return join(claudeConfigDir(env), 'projects', encodeProject(cwd), `${id}.jsonl`);
}

// whitespace-normalize and clamp a title, so unbounded operator text never reaches
// a Conversation row or the UI (mirrors Codex's `messageTitle`).
function compactTitle(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return undefined;
  return normalized.length <= maxTitleLength ? normalized : `${normalized.slice(0, maxTitleLength - 1).trimEnd()}…`;
}

// Claude's config directory, honoring the test seam then the real environment.
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAC_CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude');
}

// Claude's 31-multiplier int32 string hash over the original path, base36, ported from
// the binary's `wK`/`Te` encoder for the long-directory case below.
function projectHash(cwd: string): string {
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

// Claude stores a transcript under `projects/<cwd-with-non-alphanumerics-dashed>/`
// (docs/sessions). A dashed name over 200 characters is truncated to 200 and a hash of
// the original path appended, matching the binary's `gA` encoder.
function encodeProject(cwd: string): string {
  const dashed = cwd.replace(/[^a-zA-Z0-9]/gu, '-');
  return dashed.length <= 200 ? dashed : `${dashed.slice(0, 200)}-${projectHash(cwd)}`;
}

type TranscriptRecord = {
  type?: string;
  attachment?: { type?: unknown; hookEvent?: unknown; stdout?: unknown };
  customTitle?: unknown;
  aiTitle?: unknown;
  promptSource?: unknown;
  origin?: { kind?: unknown };
  message?: { content?: unknown };
};

type TranscriptTitle = { customTitle?: string; aiTitle?: string; firstPrompt?: string };

// a record's prompt when it is one a person wrote: typed in the TUI, or sent over the structured
// Transport (`sdk`), never a command, its output or the CLI's own meta records
function writtenPrompt(record: TranscriptRecord & { isMeta?: unknown }): string | undefined {
  if (record.type !== 'user' || record.isMeta === true || typeof record.message?.content !== 'string' || record.message.content.length === 0) return undefined;
  const typed = record.promptSource === 'typed' && record.origin?.kind === 'human';
  return typed || record.promptSource === 'sdk' && !/^[</]/u.test(record.message.content) ? record.message.content : undefined;
}

// parse the bounded title window without retaining raw transcript text
function transcriptTitle(lines: Iterable<string>): TranscriptTitle {
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  // inspect each record in file order
  for (const line of lines) {
    // skip empty separators
    if (line === '') continue;
    let record: TranscriptRecord;
    // preserve earlier valid records across malformed lines
    try { record = JSON.parse(line) as TranscriptRecord; } catch { continue; }
    // several records of each kind per file; the last in the scanned window wins
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.length > 0) customTitle = record.customTitle;
    else if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.length > 0) aiTitle = record.aiTitle;
    // retain the first prompt a person wrote as the fallback
    else firstPrompt ??= writtenPrompt(record);
  }
  return { customTitle, aiTitle, firstPrompt };
}

// reuse title fields while the transcript fingerprint is unchanged
const transcriptTitleCache = new FileChangeCache(
  async path => transcriptTitle(await readFileHead(path, maxTitleScanBytes)),
  { maxEntries: 512 }
);

// reuse the small parsed sidecar independently from its transcript
const sidecarTitleCache = new FileChangeCache<string | undefined>(async path => {
  const lines = await readFileHead(path, maxSidecarBytes);
  // malformed sidecars are a stable unnamed result until their bytes change
  try {
    const parsed = JSON.parse(lines.join('\n')) as { customTitle?: unknown };
    return typeof parsed.customTitle === 'string' && parsed.customTitle.length > 0 ? parsed.customTitle : undefined;
  } catch {
    return undefined;
  }
}, { maxEntries: 512 });

// the per-session `custom-title.json` sidecar's human name, when present. Claude
// writes it next to the transcript (`projects/<enc>/<id>/custom-title.json`) on a
// `/rename` or `--name`, but a `-p --name` run writes only the transcript record,
// so an absent sidecar is "unnamed", not an error.
async function sidecarCustomTitle(transcriptPath: string, id: string): Promise<string | undefined> {
  return sidecarTitleCache.get(join(dirname(transcriptPath), id, 'custom-title.json')).catch(() => undefined);
}

/**
 * The current name of a known Claude Conversation: the human `custom-title` (the
 * transcript's last such record, or the per-session sidecar, which are equal
 * sources), else the last generated `ai-title`, else the first typed human prompt.
 * The human title wins over any `ai-title` regardless of record order — Claude
 * re-emits an `ai-title` after every prompt boundary, so a renamed session's
 * transcript ends on a generated title the console must not show (the read-back
 * and renamed-session bug). `undefined` on any error — an unknown id, an unknown cwd, or
 * an unreadable/absent transcript. `cwd` locates the transcript and is required.
 */
export async function claudeConversationName(id: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!validClaudeSessionId(id) || cwd === undefined) return undefined;
  const path = transcriptPath(id, cwd, env);
  const title = await transcriptTitleCache.get(path).catch(() => undefined);
  // unreadable transcripts remain unknown and are retried on the next request
  if (title === undefined) return undefined;
  // the sidecar is an equal source for the human name, and survives a bounded head
  // scan that missed a re-emitted `custom-title` deep in a long transcript
  return compactTitle((title.customTitle ?? await sidecarCustomTitle(path, id)) ?? title.aiTitle ?? title.firstPrompt ?? '');
}

/**
 * The launch nonce a SessionStart hook printed, as JSON `{ "rac": "<nonce>" }` on any line of its
 * stdout: what the console's structured Claude launches echo (`claude-hooks.ts`).
 */
export function claudeHookNonce(stdout: unknown): string | undefined {
  if (typeof stdout !== 'string') return undefined;
  for (const line of stdout.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { rac?: unknown }).rac === 'string') return (parsed as { rac: string }).rac;
    } catch { /* another hook's output */ }
  }
  return undefined;
}

// what one transcript's bounded head+tail scan yields for listing: its window's first entrypoint
// and written prompt, and whether a console launch's SessionStart hook ran in it (`launched`)
type TranscriptScan = { customTitle?: string; aiTitle?: string; lastActiveAt: number; entrypoint?: string; firstPrompt?: string; launched: boolean };

// accumulate a transcript's name, recency and provenance from raw JSONL lines. Called on
// the head then the tail, so the last `custom-title`/`ai-title` seen (nearest the tail)
// wins, exactly as `claudeConversationName` prefers the last record in its window.
function scanTranscript(lines: Iterable<string>, scan: TranscriptScan): void {
  for (const line of lines) {
    if (line === '') continue;
    let record: TranscriptRecord & { entrypoint?: unknown; timestamp?: unknown };
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.length > 0) scan.customTitle = record.customTitle;
    else if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.length > 0) scan.aiTitle = record.aiTitle;
    if (scan.entrypoint === undefined && typeof record.entrypoint === 'string') scan.entrypoint = record.entrypoint;
    scan.firstPrompt ??= writtenPrompt(record);
    if (record.type === 'attachment' && record.attachment?.type === 'hook_success' && record.attachment.hookEvent === 'SessionStart' && claudeHookNonce(record.attachment.stdout) !== undefined) scan.launched = true;
    // last-active is the newest timestamped record, never the file mtime (bookkeeping
    // records without timestamps are appended at open/close and would move mtime)
    if (typeof record.timestamp === 'string') {
      const at = Date.parse(record.timestamp);
      if (!Number.isNaN(at) && at > scan.lastActiveAt) scan.lastActiveAt = at;
    }
  }
}

// parse one bounded listing window into compact fields
function transcriptScan(lines: Iterable<string>): TranscriptScan {
  const scan: TranscriptScan = { lastActiveAt: 0, launched: false };
  scanTranscript(lines, scan);
  return scan;
}

// reuse bounded listing fields for up to two full 200-row directory scans
const summaryHeadCache = new FileChangeCache(
  async path => transcriptScan(await readFileHead(path, maxListHeadBytes)),
  { maxEntries: 512 }
);
const summaryTailCache = new FileChangeCache(
  async path => transcriptScan(await readFileTail(path, maxListTailBytes)),
  { maxEntries: 512 }
);

// summarize one transcript, or undefined when it began as an SDK run the console did not launch
// as a structured Agent (a headless Review run, ADR 0010) or carries no name
async function summarizeTranscript(path: string, size: number, id: string, directory: string): Promise<ConversationSummary | undefined> {
  const head = await summaryHeadCache.get(path).catch(() => undefined);
  // an unreadable head cannot identify a conversation
  if (head === undefined) return undefined;
  // read the tail too only when the file exceeds the head window; a smaller file was read whole
  const tail = size > maxListHeadBytes ? await summaryTailCache.get(path).catch(() => undefined) : undefined;
  // how a Conversation began says what it is, whichever Transport resumed it since: a structured
  // Agent's starts with its launch's SessionStart hook. A head too long to parse (one huge first
  // record) leaves the tail to say whether it is an SDK run.
  const entrypoint = head.entrypoint ?? tail?.entrypoint;
  if (entrypoint !== undefined && sdkEntrypoints.has(entrypoint) && !head.launched) return undefined;
  // the sidecar is an equal source for the human name (as in `claudeConversationName`):
  // it recovers a `custom-title` set long ago that fell outside the bounded window with no
  // re-emit, so a human-named row is neither mislabelled automatic nor dropped. Consulted
  // only when the window found no `custom-title`; a genuinely automatic row has no sidecar
  // directory, so the read fails fast.
  const customTitle = tail?.customTitle ?? head.customTitle ?? await sidecarCustomTitle(path, id);
  // print mode writes no `ai-title`, so a Conversation the console launched is named by its first
  // prompt until it is renamed
  const name = compactTitle((customTitle ?? tail?.aiTitle ?? head.aiTitle ?? (head.launched ? head.firstPrompt : undefined)) ?? '');
  // list only Named conversations — a transcript with no title (and no such prompt) is unnamed
  if (name === undefined) return undefined;
  return { id, name, automatic: customTitle === undefined, lastActiveAt: Math.max(head.lastActiveAt, tail?.lastActiveAt ?? 0), directory };
}

/**
 * The Named Claude conversations started under each of the given directories, newest
 * (most recently active) first across all of them. For each directory the reader lists
 * the top-level `<uuid>.jsonl` transcripts under `projects/<encoded cwd>/`, skips 0-byte
 * files, opens only the newest 200 by mtime (mtime only ever runs ahead of activity, so
 * it is a safe pre-filter), and skips a transcript that began as an SDK/`--print` run, unless the
 * console launched it as a structured Agent, and any transcript with no name.
 * A missing or unreadable project directory contributes nothing. `directory` on each row
 * is the scanned cwd, matched exactly as Claude's own picker does.
 */
export async function claudeConversationSummaries(directories: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ConversationSummary[]> {
  const configDir = claudeConfigDir(env);
  const summaries: ConversationSummary[] = [];
  for (const directory of directories) {
    const projectDir = join(configDir, 'projects', encodeProject(directory));
    const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ id: string; path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = transcriptFile.exec(entry.name);
      if (match === null) continue;
      const path = join(projectDir, entry.name);
      const info = await stat(path).catch(() => undefined);
      // skip an unreadable or empty transcript (a 0-byte file has no message record)
      if (info === undefined || info.size === 0) continue;
      candidates.push({ id: match[1].toLowerCase(), path, size: info.size, mtimeMs: info.mtimeMs });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates.slice(0, maxListedTranscripts)) {
      const summary = await summarizeTranscript(candidate.path, candidate.size, candidate.id, directory).catch(() => undefined);
      if (summary !== undefined) summaries.push(summary);
    }
  }
  summaries.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  return summaries;
}

type AssistantRecord = { type?: unknown; isMeta?: unknown; isSidechain?: unknown; isApiErrorMessage?: unknown; synthetic?: unknown; message?: { id?: unknown; role?: unknown; model?: unknown; content?: unknown; stop_reason?: unknown } };

// identify a typed main-thread user message rather than a tool result
function isRealUserMessage(record: AssistantRecord): boolean {
  // ignore synthetic and sidechain records
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true || record.message?.role !== 'user') return false;
  const content = record.message.content;
  // direct string content is a typed prompt
  if (typeof content === 'string') return content.trim() !== '';
  // reject tool results and malformed content
  if (!Array.isArray(content)) return false;
  return content.some(block => block !== null && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string'
    && (block as { text: string }).text.trim() !== '');
}

// append the visible text blocks from one Claude message record
function appendClaudeText(content: unknown, texts: string[]): void {
  // accept direct assistant text
  if (typeof content === 'string') {
    // retain non-empty direct text
    if (content.trim() !== '') texts.push(content);
    return;
  }
  // reject non-message content
  if (!Array.isArray(content)) return;
  // retain only rendered text blocks
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') texts.push(block.text);
}

/**
 * the latest unanswered main-thread assistant message; a later typed user message
 * clears stale assistant text; tool results and sidechains do not change it.
 */
export function latestClaudeMessageFromRecords(lines: Iterable<string>): string | undefined {
  let messageId: unknown;
  let texts: string[] = [];
  // apply transcript records in file order
  for (const line of lines) {
    let parsed: unknown;
    // skip malformed tail fragments
    try { parsed = JSON.parse(line) as unknown; } catch { continue; }
    // reject json primitives and arrays
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as AssistantRecord;
    // clear only typed user prompts
    if (isRealUserMessage(record)) {
      messageId = undefined;
      texts = [];
      continue;
    }
    // ignore sidechains and non-assistant bookkeeping
    if (record.type !== 'assistant' || record.isSidechain === true || record.message === undefined || record.message === null) continue;
    // reset when a newer assistant message begins, even before it emits text
    if (record.message.id !== messageId || messageId === undefined) { messageId = record.message.id; texts = []; }
    appendClaudeText(record.message.content, texts);
  }
  const text = texts.join('\n\n');
  return text === '' ? undefined : text;
}

/** The last assistant message of a transcript: its model message id, and its text when it has any. */
export type ClaudeAssistantMessage = { id?: string; text?: string };

/**
 * The last assistant message among these transcript records. The transcript format is Claude
 * Code's internal one (read here and, for a structured Agent's history, by the Claude client): each content block of one model
 * message (thinking, text, tool use) is its own `type: "assistant"` record carrying the same
 * `message.id`, so the last message is the text blocks of the records sharing the last assistant
 * record's id, joined in order. Subagent (sidechain) records are skipped. `undefined` when there is
 * no assistant message; `text` is absent when the last one has no text.
 */
export function lastAssistantMessageFromRecords(lines: Iterable<string>, requireText = false): ClaudeAssistantMessage | undefined {
  let message: ClaudeAssistantMessage | undefined;
  let messageId: unknown;
  let texts: string[] = [];
  for (const line of lines) {
    if (line === '') continue;
    let record: AssistantRecord;
    try { record = JSON.parse(line) as AssistantRecord; } catch { continue; }
    if (record?.type !== 'assistant' || record.isSidechain === true || record.message === undefined || record.message === null) continue;
    // a new message id starts the next model message
    if (record.message.id !== messageId || messageId === undefined) { messageId = record.message.id; texts = []; }
    const content = record.message.content;
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) for (const block of content as Array<{ type?: unknown; text?: unknown }>) if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    const text = texts.join('\n\n');
    // an empty thinking or tool message is not a replacement for visible prose
    if (requireText && !text.trim()) continue;
    message = { ...(typeof messageId === 'string' ? { id: messageId } : {}), ...(text.trim() === '' ? {} : { text }) };
  }
  return message;
}

// reuse parsed final replies without retaining their bounded raw tails
const lastAssistantMessageCache = new FileChangeCache<ClaudeAssistantMessage | undefined>(
  async path => lastAssistantMessageFromRecords(await readFileTail(path, maxFinalMessageScanBytes)),
  { maxEntries: 512 }
);

// identify when a rich native transcript exposes the strict post-answer chain
function claudeResponseHasNativeChain(records: readonly (ClaudeReplyRecord & Record<string, unknown>)[], assistant: ClaudeReplyAssistantLeaf, sessionId: string): boolean {
  // the attachment directly after this assistant makes terminal correlation available
  return records.some((record, index) => index > assistant.index && record.type === 'attachment'
    && record.parentUuid === assistant.uuid && record.isSidechain === false && claudeReplySameSession(record, sessionId));
}

// retain only protocol-completed main-thread responses
export function latestClaudeResponseFromRecords(lines: Iterable<string>): string | undefined {
  const records: Array<ClaudeReplyRecord & Record<string, unknown>> = [];
  const nodes = new Map<string, ClaudeReplyNode>();
  const duplicateNodes = new Set<string>();
  // retain valid transcript records and their exact native links
  for (const line of lines) {
    let parsed: unknown;
    // malformed tail fragments cannot create completion evidence
    try { parsed = JSON.parse(line) as unknown; } catch { continue; }
    // reject primitives without discarding earlier proven output
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as ClaudeReplyRecord & Record<string, unknown>;
    const index = records.push(record) - 1;
    const uuid = claudeReplyUuid(record.uuid);
    // duplicate identifiers make only the strict chain unusable
    if (uuid !== undefined && !duplicateNodes.has(uuid) && !nodes.has(uuid)) nodes.set(uuid, { index, record });
    else if (uuid !== undefined) {
      nodes.delete(uuid);
      duplicateNodes.add(uuid);
    }
  }
  let response: string | undefined;
  let messageId: unknown;
  let texts: string[] = [];
  let completed = false;
  let eligible = true;
  let assistantLeaf: ClaudeReplyAssistantLeaf | undefined;
  let sessionId: string | undefined;
  // publish one assembled message only with its strongest available proof
  const finish = () => {
    const text = texts.join('\n\n');
    if (!eligible || !completed || text.trim() === '') return;
    const strict = assistantLeaf !== undefined && sessionId !== undefined && claudeResponseHasNativeChain(records, assistantLeaf, sessionId);
    // a correlated native chain supersedes the message-local end-turn fallback
    if (!strict || claudeReplyTurnComplete(records, nodes, assistantLeaf, sessionId!, false)) response = text;
  };
  // fold split content blocks into their native message
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    // reject sidechains and non-assistant bookkeeping
    if (record.type !== 'assistant' || record.isSidechain === true || record.message === undefined || record.message === null) continue;
    // close one message before accumulating the next
    if (record.message.id !== messageId || messageId === undefined) {
      finish();
      messageId = record.message.id;
      texts = [];
      completed = false;
      eligible = true;
      assistantLeaf = undefined;
      sessionId = undefined;
    }
    const synthetic = record.isMeta === true || record.isApiErrorMessage === true || record.synthetic === true || record.message.model === '<synthetic>';
    // one synthetic or API-error fragment invalidates the whole native message
    if (synthetic) eligible = false;
    else appendClaudeText(record.message.content, texts);
    // tool-use and partial messages remain candidates until a real end turn
    if (!synthetic && record.message.stop_reason === 'end_turn') completed = true;
    const uuid = claudeReplyUuid(record.uuid);
    const currentSession = typeof record.sessionId === 'string' && claudeReplySameSession(record, record.sessionId) ? record.sessionId : undefined;
    // strict proof follows the newest valid physical fragment of this message
    if (!synthetic && uuid !== undefined && currentSession !== undefined) {
      assistantLeaf = { index, messageId: typeof messageId === 'string' ? messageId : '', uuid };
      sessionId = currentSession;
    }
  }
  finish();
  return response;
}

// reuse only completion-proven replies while transcript bytes remain unchanged
const latestResponseCache = new FileChangeCache<string | undefined>(
  async path => latestClaudeResponseFromRecords(await readFileTail(path, maxFinalMessageScanBytes)),
  { maxEntries: 512 }
);

// require the reported Claude session id and pane cwd before reading any response
export async function claudeLatestResponse(id: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  // unknown identities must never inherit another conversation's response
  if (!validClaudeSessionId(id) || cwd === undefined) return undefined;
  return latestResponseCache.get(transcriptPath(id, cwd, env)).catch(() => undefined);
}

// reuse the latest visible reply while discovery continues checking file metadata
const latestMessageCache = new FileChangeCache<string | undefined>(
  async path => latestClaudeMessageFromRecords(await readFileTail(path, maxLatestMessageScanBytes)),
  { maxEntries: 512 }
);

/**
 * The last assistant message of a known Claude Conversation (an interactive Review run's reply,
 * ADR 0010), read from a bounded tail of its transcript. `undefined` on an invalid id, an unknown
 * cwd, an unreadable transcript or one with no assistant message.
 */
export async function claudeLastAssistantMessage(id: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeAssistantMessage | undefined> {
  if (!validClaudeSessionId(id) || cwd === undefined) return undefined;
  return lastAssistantMessageCache.get(transcriptPath(id, cwd, env)).catch(() => undefined);
}

/**
 * The Effort the last main-thread reply of a Claude Conversation ran at, from the `effort` its
 * transcript records carry (Claude's stream never names it, and with no `--effort` it is Claude's
 * own default). `undefined` when no reply in the bounded tail names one.
 */
export async function claudeConversationEffort(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!validClaudeSessionId(id)) return undefined;
  const lines = await readFileTail(transcriptPath(id, cwd, env), maxLatestMessageScanBytes).catch(() => []);
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    let record: AssistantRecord & { effort?: unknown };
    try { record = JSON.parse(lines[at]!) as typeof record; } catch { continue; }
    if (record.type === 'assistant' && record.isSidechain !== true && typeof record.effort === 'string') return record.effort;
  }
  return undefined;
}

/** read the latest unanswered message from claude's reported conversation */
export async function claudeConversationLatestMessage(pane: { pid: number; cwd?: string; conversationId?: string }, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  // require the reported id and raw pane cwd that key Claude's transcript
  if (pane.conversationId === undefined || !validClaudeSessionId(pane.conversationId) || pane.cwd === undefined) return undefined;
  return latestMessageCache.get(transcriptPath(pane.conversationId, pane.cwd, env)).catch(() => undefined);
}

/** one exact Claude transcript generation and its authored reply context */
export type ClaudeReplyConversation = {
  conversationId: string;
  messages: AuthoredReplyMessage[];
  transcriptGeneration: string;
};

type ClaudeReplyRecord = TranscriptRecord & {
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  subtype?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  synthetic?: unknown;
  preventedContinuation?: unknown;
  durationMs?: unknown;
  messageCount?: unknown;
  leafUuid?: unknown;
  local_command_source?: unknown;
  local_command_run?: unknown;
  message?: { id?: unknown; role?: unknown; model?: unknown; content?: unknown; stop_reason?: unknown };
};

type ClaudeReplyNode = { index: number; record: ClaudeReplyRecord & Record<string, unknown> };
type ClaudeReplyAssistantLeaf = { index: number; messageId: string; uuid: string };

// exact pinned native aggregate keys
const claudeCostStateFields = new Set([
  'type', 'sessionId', 'totalCostUSD', 'totalAPIDuration', 'totalAPIDurationWithoutRetries',
  'totalToolDuration', 'totalLinesAdded', 'totalLinesRemoved', 'totalDuration', 'startTime',
  'modelUsage', 'hasUnknownModelCost'
]);
// exact pinned per-model accounting keys
const claudeCostModelFields = new Set([
  'inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
  'cacheCreationEphemeral5mInputTokens', 'cacheCreationEphemeral1hInputTokens', 'webSearchRequests', 'costUSD'
]);
// mandatory pinned aggregate counters
const requiredClaudeCostFields = [
  'totalCostUSD', 'totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalToolDuration',
  'totalLinesAdded', 'totalLinesRemoved', 'totalDuration', 'startTime'
] as const;
// mandatory pinned per-model counters
const requiredClaudeCostModelFields = [
  'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'
] as const;

// accept one finite nonnegative native accounting value
function claudeCostNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// recognize only the pinned native accounting schema as generation-inert
function claudeInertCostState(record: ClaudeReplyRecord & Record<string, unknown>, sessionId: string): boolean {
  // reject other record types and incomplete native cost records
  if (record.type !== 'cost-state' || record.sessionId !== sessionId) return false;
  // future or selection-bearing fields remain generation-significant
  for (const key of Object.keys(record)) if (!claudeCostStateFields.has(key)) return false;
  // every required aggregate must match the pinned numeric schema
  for (const key of requiredClaudeCostFields) if (!claudeCostNumber(record[key])) return false;
  // the optional uncertainty marker must retain its native type
  if (record.hasUnknownModelCost !== undefined && typeof record.hasUnknownModelCost !== 'boolean') return false;
  const modelUsage = record.modelUsage;
  // model accounting must remain a plain record
  if (modelUsage === null || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return false;
  // validate each dynamic model accounting entry
  for (const [model, value] of Object.entries(modelUsage)) {
    // native model keys exclude control and format characters
    if (model === '' || /[\p{Cc}\p{Cf}]/u.test(model) || value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    // future model fields remain generation-significant
    for (const key of Object.keys(value)) if (!claudeCostModelFields.has(key)) return false;
    // every required model counter must match the pinned numeric schema
    for (const key of requiredClaudeCostModelFields) if (!claudeCostNumber((value as Record<string, unknown>)[key])) return false;
    // optional token counters retain the same numeric bounds
    for (const key of ['thinkingTokens', 'cacheCreationEphemeral5mInputTokens', 'cacheCreationEphemeral1hInputTokens'] as const) {
      const counter = (value as Record<string, unknown>)[key];
      // absent optional counters are valid
      if (counter !== undefined && !claudeCostNumber(counter)) return false;
    }
  }
  return true;
}

// accept one bounded noncontrol native transcript identifier
function claudeReplyUuid(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : undefined;
}

// require both native session spellings to identify the expected conversation
function claudeReplySameSession(record: ClaudeReplyRecord, sessionId: string): boolean {
  return record.sessionId === sessionId && (record.session_id === undefined || record.session_id === sessionId);
}

// prove the latest physical assistant record reached the native terminal leaf
function claudeReplyTurnComplete(records: readonly (ClaudeReplyRecord & Record<string, unknown>)[], nodes: ReadonlyMap<string, ClaudeReplyNode>, assistant: ClaudeReplyAssistantLeaf | undefined, sessionId: string, latestOnly = true): boolean {
  // no authored assistant leaf means no reply can be terminal
  if (assistant === undefined) return false;
  let turnEnd = records.length;
  // the next main-thread user or assistant record begins another turn
  for (let index = assistant.index + 1; index < records.length; index += 1) {
    const record = records[index]!;
    const sameSession = record.sessionId === undefined || claudeReplySameSession(record, sessionId);
    // session files may omit the redundant session id on message records
    if (sameSession && record.isSidechain !== true && (record.type === 'user' || record.type === 'assistant')) {
      turnEnd = index;
      break;
    }
  }
  let latestTerminal: { attachmentUuid: string; terminalUuid: string } | undefined;
  // inspect each possible terminal after the latest assistant record
  for (let index = assistant.index + 1; index < turnEnd; index += 1) {
    const terminal = records[index]!;
    // require the pinned main-thread terminal shape and current session
    if (terminal.type !== 'system' || terminal.subtype !== 'turn_duration' || terminal.isMeta !== false || terminal.isSidechain !== false
      || !Number.isInteger(terminal.durationMs) || (terminal.durationMs as number) < 0
      || !Number.isInteger(terminal.messageCount) || (terminal.messageCount as number) < 0
      || !claudeReplySameSession(terminal, sessionId)) continue;
    const terminalUuid = claudeReplyUuid(terminal.uuid);
    const stopUuid = claudeReplyUuid(terminal.parentUuid);
    // incomplete terminal links cannot authorize a source
    if (terminalUuid === undefined || stopUuid === undefined) continue;
    const stop = nodes.get(stopUuid);
    // the stop summary must precede the terminal and belong to this main thread
    if (stop === undefined || stop.index <= assistant.index || stop.index >= index || stop.record.type !== 'system'
      || stop.record.subtype !== 'stop_hook_summary' || stop.record.isSidechain !== false
      || stop.record.preventedContinuation !== false || !claudeReplySameSession(stop.record, sessionId)) continue;
    const attachmentUuid = claudeReplyUuid(stop.record.parentUuid);
    // a missing attachment endpoint cannot close the native chain
    if (attachmentUuid === undefined) continue;
    const attachment = nodes.get(attachmentUuid);
    // the observed attachment must follow and point directly to the latest assistant leaf
    if (attachment === undefined || attachment.index <= assistant.index || attachment.index >= stop.index
      || attachment.record.type !== 'attachment' || attachment.record.isSidechain !== false
      || !claudeReplySameSession(attachment.record, sessionId) || attachment.record.parentUuid !== assistant.uuid) continue;
    // retain the newest fully linked terminal for latest-marker corroboration
    latestTerminal = { attachmentUuid, terminalUuid };
  }
  // an incomplete native chain cannot establish either historical or latest completion
  if (latestTerminal === undefined) return false;
  let turnMarkerIndex: number | undefined;
  let latestSessionMarkerIndex: number | undefined;
  // select physical marker order before validating leaf shape
  for (let index = assistant.index + 1; index < records.length; index += 1) {
    const record = records[index]!;
    // only same-session markers participate in this conversation
    if (record.type !== 'last-prompt' || !claudeReplySameSession(record, sessionId)) continue;
    latestSessionMarkerIndex = index;
    // historical completion uses the actual last marker inside this turn
    if (index < turnEnd) turnMarkerIndex = index;
  }
  // current-source callers require this turn's marker to remain physically latest
  if (latestOnly && latestSessionMarkerIndex !== turnMarkerIndex) return false;
  const latestLeafUuid = turnMarkerIndex === undefined ? undefined : claudeReplyUuid(records[turnMarkerIndex]!.leafUuid);
  // malformed or superseding markers never fall back to earlier valid evidence
  return latestLeafUuid !== undefined && (latestTerminal.terminalUuid === latestLeafUuid || latestTerminal.attachmentUuid === latestLeafUuid);
}

// extract only text a person typed, excluding attachments and tool results
function claudeReplyUserText(record: ClaudeReplyRecord): string | undefined {
  // require the native typed-human provenance
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true || record.promptSource !== 'typed' || record.origin?.kind !== 'human' || record.message?.role !== 'user') return undefined;
  const content = record.message.content;
  // retain direct typed prose
  if (typeof content === 'string') return content.trim() === '' ? undefined : content;
  // copy text blocks only when attachments accompany a prompt
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(block => block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []).join('\n');
  return text.trim() === '' ? undefined : text;
}

// extract only visible text from a main-thread assistant record
function claudeReplyAssistantText(content: unknown): string {
  // retain direct assistant prose
  if (typeof content === 'string') return content;
  // nonarray content has no visible prose
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []).join('\n');
}

// parse complete current-conversation messages and every generation-significant record
function claudeReplyRecords(lines: readonly string[], truncated: boolean, fileIdentity: string, sessionId: string): { messages: AuthoredReplyMessage[]; generation: string } | undefined {
  const messages: AuthoredReplyMessage[] = [];
  const significant: string[] = [];
  const records: Array<ClaudeReplyRecord & Record<string, unknown>> = [];
  const nodes = new Map<string, ClaudeReplyNode>();
  let reachedBoundary = !truncated;
  let assistant: { id: string; text: string } | undefined;
  let assistantLeaf: ClaudeReplyAssistantLeaf | undefined;
  // flush one assembled streaming assistant message
  const flushAssistant = (): void => {
    // omit empty and pre-boundary model records
    if (assistant !== undefined && reachedBoundary && assistant.text.trim() !== '') messages.push({ id: `assistant:${assistant.id}`, role: 'assistant', text: assistant.text });
    assistant = undefined;
  };
  // apply transcript records in append order
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    // malformed complete records make the source generation unusable
    try { parsed = JSON.parse(lines[index]!); } catch { return undefined; }
    // nonrecord JSON cannot be a native transcript entry
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as ClaudeReplyRecord & Record<string, unknown>;
    records.push(record);
    const uuid = record.uuid === undefined ? undefined : claudeReplyUuid(record.uuid);
    // malformed or duplicate native identifiers make the chain ambiguous
    if ((record.uuid !== undefined && uuid === undefined) || (uuid !== undefined && nodes.has(uuid))) return undefined;
    // retain one physical append position per native node
    if (uuid !== undefined) nodes.set(uuid, { index, record });
    // only the pinned cost schema is inert; every other raw record detects selection ABA
    if (!claudeInertCostState(record, sessionId)) significant.push(lines[index]!);
    // a typed main-thread human prompt is the only user context boundary
    const prompt = claudeReplyUserText(record);
    if (prompt !== undefined) {
      flushAssistant();
      reachedBoundary = true;
      const id = typeof record.uuid === 'string' && record.uuid !== '' ? record.uuid : `line-${index}`;
      messages.push({ id: `user:${id}`, role: 'user', text: prompt });
      continue;
    }
    // ignore sidechains, tool results, hooks, metadata and nonassistant records
    if (record.type !== 'assistant' || record.isSidechain === true || record.local_command_source !== undefined || record.local_command_run !== undefined
      || record.message?.role !== 'assistant' || typeof record.message.id !== 'string' || record.message.id === '') continue;
    // the newest accepted assistant record owns terminal availability
    assistantLeaf = uuid !== undefined && record.isSidechain === false && claudeReplySameSession(record, sessionId)
      ? { index, messageId: record.message.id, uuid }
      : undefined;
    // a new native message id completes the prior assistant reply
    if (assistant?.id !== record.message.id) {
      flushAssistant();
      assistant = { id: record.message.id, text: '' };
    }
    const text = claudeReplyAssistantText(record.message.content);
    // concatenate only visible text blocks from this native message
    if (text !== '') assistant.text = assistant.text === '' ? text : `${assistant.text}\n${text}`;
  }
  flushAssistant();
  // a truncated tail must reach a typed user boundary before retaining output
  if (!reachedBoundary) return undefined;
  // publish only after the native turn terminal links to the latest assistant leaf
  if (!claudeReplyTurnComplete(records, nodes, assistantLeaf, sessionId)) return undefined;
  const bounded = boundedReplyMessages(messages);
  // never publish an older visible question for a newer empty assistant turn
  if (assistantLeaf === undefined || bounded?.at(-1)?.id !== `assistant:${assistantLeaf.messageId}`) return undefined;
  // replacement inodes and every ordered nonaccounting record define Claude source identity
  const generation = createHash('sha256').update(fileIdentity).update('\0').update(significant.join('\n')).digest('base64url');
  return { messages: bounded, generation };
}

/** read one exact Claude session without copying tools, hooks or private reasoning */
export async function claudeReplyConversation(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeReplyConversation | undefined> {
  // require the exact reported session and project directory
  if (!validClaudeSessionId(id) || cwd === '') return undefined;
  const tail = await readStableJsonlTail(transcriptPath(id, cwd, env), maxReplySourceScanBytes).catch(() => undefined);
  // reject unstable transcript generations
  if (tail === undefined) return undefined;
  const parsed = claudeReplyRecords(tail.lines, tail.truncated, tail.fileIdentity, id);
  return parsed === undefined ? undefined : { conversationId: id, messages: parsed.messages, transcriptGeneration: parsed.generation };
}

/**
 * The latest records of a known Claude Conversation's transcript, as raw JSONL lines from a
 * bounded tail, for a structured Agent's history. `undefined` on an invalid id or an unreadable
 * (or not yet written) transcript.
 */
export async function claudeTranscriptRecords(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string[] | undefined> {
  if (!validClaudeSessionId(id)) return undefined;
  return readFileTail(transcriptPath(id, cwd, env), maxHistoryScanBytes).catch(() => undefined);
}

/** The reference a structured Claude launch resumes: the session id, once its transcript exists under `cwd`'s project directory. */
export async function locateClaudeSession(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!validClaudeSessionId(id)) return undefined;
  return (await stat(transcriptPath(id, cwd, env)).catch(() => undefined))?.isFile() === true ? id : undefined;
}

/**
 * The newest Conversation listed for `cwd`, which a structured launch that continues the latest
 * one resumes (`claude -p --continue` would take a headless Review run, which is not listed).
 */
export async function latestClaudeConversation(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return (await claudeConversationSummaries([cwd], env))[0]?.id;
}

// the folders Claude trusts, from the `projects` of its global config; read whole, since a
// cut file is no record at all, and kept until the file changes
const maxGlobalConfigBytes = 64 * 1024 * 1024;
const trustedFolders = new FileChangeCache<readonly string[]>(async path => {
  if ((await stat(path)).size > maxGlobalConfigBytes) throw new Error('Claude\'s global config is too large to read');
  const { projects } = JSON.parse(await readFile(path, 'utf8')) as { projects?: unknown };
  if (typeof projects !== 'object' || projects === null) return [];
  return Object.entries(projects).flatMap(([folder, project]) => (project as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted === true ? [folder] : []);
}, { maxEntries: 4 });

// The folder Claude keys a project's trust by: inside git, the main worktree's top level (so a
// linked worktree shares its main one's), found from `.git` as git finds it; elsewhere the folder.
// Real paths throughout, as Claude resolves them.
async function trustKey(cwd: string): Promise<string> {
  const folder = await realpath(cwd);
  for (let dir = folder; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    const info = await lstat(dotGit).catch(() => undefined);
    if (info?.isDirectory() === true) return dir;
    if (info?.isFile() === true) {
      // a linked worktree's (or submodule's) `.git` file names its git directory, whose `commondir`
      // is the main repository's `.git`
      const gitdir = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim();
      if (gitdir === undefined) return dir;
      const own = resolve(dir, gitdir);
      const common = await readFile(join(own, 'commondir'), 'utf8').then(text => resolve(own, text.trim()), () => undefined);
      return common !== undefined && basename(common) === '.git' ? await realpath(dirname(common)).catch(() => dir) : dir;
    }
    if (dirname(dir) === dir) return folder;
  }
}

/**
 * Whether Claude trusts `cwd` as its TUI's trust dialog records it, by Claude's own rule: the
 * exact key of the folder (`trustKey`) in `projects` with `hasTrustDialogAccepted`, never a folder
 * above it. Print mode skips that dialog and takes every folder as trusted, so the console asks
 * first. The record is the launch's own: `$CLAUDE_CONFIG_DIR/.claude.json` when its environment
 * names a config directory, else `.claude.json` in its home. False when it cannot be read.
 */
export async function claudeFolderTrusted(cwd: string, env: { HOME?: string; CLAUDE_CONFIG_DIR?: string }): Promise<boolean> {
  const path = env.CLAUDE_CONFIG_DIR === undefined ? join(env.HOME ?? homedir(), '.claude.json') : join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  const [folders, key] = await Promise.all([trustedFolders.get(path).catch(() => undefined), trustKey(cwd).catch(() => undefined)]);
  return folders !== undefined && key !== undefined && folders.includes(key);
}
