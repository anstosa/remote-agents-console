import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileHead, readFileTail } from './bounded-file.js';
import { FileChangeCache } from './file-change-cache.js';
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
// a `-p`/SDK run is persisted but hidden from Claude's own picker and `--continue`; its
// message records carry one of these entrypoints (read from the head or the tail).
const sdkEntrypoints = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);
// bound the final-message read: the reply sits at the transcript's end, and a Review run's
// JSON reply may run to hundreds of kilobytes once escaped
const maxFinalMessageScanBytes = 8 * 1024 * 1024;
// discovery polls this reader, so keep each pane read small and fail safe on an oversized record
const maxLatestMessageScanBytes = 512 * 1024;
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
  customTitle?: unknown;
  aiTitle?: unknown;
  promptSource?: unknown;
  origin?: { kind?: unknown };
  message?: { content?: unknown };
};

type TranscriptTitle = { customTitle?: string; aiTitle?: string; firstPrompt?: string };

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
    // retain the first typed human prompt as the fallback
    else if (firstPrompt === undefined && record.type === 'user' && record.promptSource === 'typed' && record.origin?.kind === 'human' && typeof record.message?.content === 'string' && record.message.content.length > 0) firstPrompt = record.message.content;
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

// what one transcript's bounded head+tail scan yields for listing
type TranscriptScan = { customTitle?: string; aiTitle?: string; lastActiveAt: number; sdk: boolean };

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
    // `--print`/SDK runs are hidden from the picker; their marker sits on message records
    if (typeof record.entrypoint === 'string' && sdkEntrypoints.has(record.entrypoint)) scan.sdk = true;
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
  const scan: TranscriptScan = { lastActiveAt: 0, sdk: false };
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

// summarize one transcript, or undefined when it is an SDK run or carries no name
async function summarizeTranscript(path: string, size: number, id: string, directory: string): Promise<ConversationSummary | undefined> {
  const head = await summaryHeadCache.get(path).catch(() => undefined);
  // an unreadable head cannot identify a conversation
  if (head === undefined) return undefined;
  // read the tail too only when the file exceeds the head window; a smaller file was read whole
  const tail = size > maxListHeadBytes ? await summaryTailCache.get(path).catch(() => undefined) : undefined;
  const scan: TranscriptScan = {
    customTitle: tail?.customTitle ?? head.customTitle,
    aiTitle: tail?.aiTitle ?? head.aiTitle,
    lastActiveAt: Math.max(head.lastActiveAt, tail?.lastActiveAt ?? 0),
    sdk: head.sdk || tail?.sdk === true
  };
  if (scan.sdk) return undefined;
  // the sidecar is an equal source for the human name (as in `claudeConversationName`):
  // it recovers a `custom-title` set long ago that fell outside the bounded window with no
  // re-emit, so a human-named row is neither mislabelled automatic nor dropped. Consulted
  // only when the window found no `custom-title`; a genuinely automatic row has no sidecar
  // directory, so the read fails fast.
  const customTitle = scan.customTitle ?? await sidecarCustomTitle(path, id);
  const name = compactTitle((customTitle ?? scan.aiTitle) ?? '');
  // list only Named conversations — a transcript with neither title is unnamed
  if (name === undefined) return undefined;
  return { id, name, automatic: customTitle === undefined, lastActiveAt: scan.lastActiveAt, directory };
}

/**
 * The Named Claude conversations started under each of the given directories, newest
 * (most recently active) first across all of them. For each directory the reader lists
 * the top-level `<uuid>.jsonl` transcripts under `projects/<encoded cwd>/`, skips 0-byte
 * files, opens only the newest 200 by mtime (mtime only ever runs ahead of activity, so
 * it is a safe pre-filter), and skips SDK/`--print` runs and any transcript with no name.
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

type AssistantRecord = { type?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { id?: unknown; role?: unknown; content?: unknown } };

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
 * Code's internal one, so this is the single place that reads it: each content block of one model
 * message (thinking, text, tool use) is its own `type: "assistant"` record carrying the same
 * `message.id`, so the last message is the text blocks of the records sharing the last assistant
 * record's id, joined in order. Subagent (sidechain) records are skipped. `undefined` when there is
 * no assistant message; `text` is absent when the last one has no text.
 */
export function lastAssistantMessageFromRecords(lines: Iterable<string>): ClaudeAssistantMessage | undefined {
  let message: ClaudeAssistantMessage | undefined;
  let messageId: unknown;
  let texts: string[] = [];
  for (const line of lines) {
    if (line === '') continue;
    let record: AssistantRecord;
    try { record = JSON.parse(line) as AssistantRecord; } catch { continue; }
    if (record.type !== 'assistant' || record.isSidechain === true || record.message === undefined || record.message === null) continue;
    // a new message id starts the next model message
    if (record.message.id !== messageId || messageId === undefined) { messageId = record.message.id; texts = []; }
    const content = record.message.content;
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) for (const block of content as Array<{ type?: unknown; text?: unknown }>) if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    const text = texts.join('\n\n');
    message = { ...(typeof messageId === 'string' ? { id: messageId } : {}), ...(text.trim() === '' ? {} : { text }) };
  }
  return message;
}

// reuse parsed final replies without retaining their bounded raw tails
const lastAssistantMessageCache = new FileChangeCache<ClaudeAssistantMessage | undefined>(
  async path => lastAssistantMessageFromRecords(await readFileTail(path, maxFinalMessageScanBytes)),
  { maxEntries: 512 }
);

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

/** read the latest unanswered message from claude's reported conversation */
export async function claudeConversationLatestMessage(pane: { pid: number; cwd?: string; conversationId?: string }, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  // require the reported id and raw pane cwd that key Claude's transcript
  if (pane.conversationId === undefined || !validClaudeSessionId(pane.conversationId) || pane.cwd === undefined) return undefined;
  return latestMessageCache.get(transcriptPath(pane.conversationId, pane.cwd, env)).catch(() => undefined);
}
