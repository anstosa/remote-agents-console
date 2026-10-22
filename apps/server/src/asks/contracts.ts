import { z } from 'zod';
import { reviewAgentKinds, validConversationId, type ReviewAgentKind } from '../review-runs/kinds.js';
import { diffRows } from '../review-tour/diff-rows.js';
import type { Finding } from '../code-review/contracts.js';
import type { ReviewChange } from '../review-tour/contracts.js';

export const MAX_ASK_QUESTION = 4_000;
// the longest answer kept, in bytes
export const MAX_ASK_ANSWER_BYTES = 64_000;
export const MAX_ASK_EXCERPT = 8_000;
export const MAX_ASK_THREADS = 200;
export const MAX_ASK_TURNS = 40;
export const ASK_TIMEOUT_MS = 600_000;
export const ASK_JOB_TTL_MS = 900_000;
export const ASK_REQUEST_BODY_BYTES = 16_384;
// the lines of context an excerpt keeps either side of the asked-about lines
const excerptContext = 3;

// Where a question points: the Finding asked about (its id and title), the Change and the line
// range on one side (`additions` are new-file line numbers, `deletions` old-file ones), and that
// range's hunk lines with a little context.
export type AskAnchor = { findingId: string; title: string; changeId: string; file: string; side: Finding['side']; startLine: number; endLine: number; excerpt: string };
// one question and how it settled: its answer, or why it has none
export type AskTurn = { id: string; question: string; askedAt: string; answer?: string; error?: { code: string; retryable: boolean } };
// One Ask thread: the questions asked about one anchor, all in one agent conversation. `reviewer` threads
// ask the Code review's own conversation about one of its Findings.
export type AskThread = { id: string; target: 'reviewer'; kind: ReviewAgentKind; conversation: string; anchor: AskAnchor; turns: AskTurn[] };
export type AskRequest = { findingId: string; question: string; fingerprint: string };

const text = (max: number) => z.string().max(max).refine(value => !value.includes('\0'));
const line = z.number().int().positive();
const id = z.string().min(1).max(64);
const turnSchema = z.object({ id, question: text(MAX_ASK_QUESTION).refine(value => value !== ''), askedAt: z.string().refine(value => Number.isFinite(Date.parse(value))), answer: z.string().max(MAX_ASK_ANSWER_BYTES).optional(), error: z.object({ code: z.string().min(1).max(64), retryable: z.boolean() }).strict().optional() }).strict();
const anchorSchema = z.object({ findingId: id, title: z.string().min(1).max(200), changeId: z.string().min(1).max(100), file: z.string().min(1).max(4_096), side: z.enum(['additions', 'deletions']), startLine: line, endLine: line, excerpt: text(MAX_ASK_EXCERPT) }).strict();
const threadSchema = z.object({ id, target: z.literal('reviewer'), kind: z.enum(reviewAgentKinds), conversation: z.string().min(1).max(200), anchor: anchorSchema, turns: z.array(turnSchema).max(MAX_ASK_TURNS) }).strict()
  .refine(thread => validConversationId(thread.kind, thread.conversation));
const requestSchema = z.object({ findingId: id, question: text(MAX_ASK_QUESTION), fingerprint: z.string().min(16).max(128) }).strict();

// validate a persisted Ask thread
export function parseAskThread(value: unknown): AskThread | undefined {
  const parsed = threadSchema.safeParse(value);
  return parsed.success ? parsed.data as AskThread : undefined;
}

// parse one question about a Finding; a blank question is refused
export function parseAskRequest(value: unknown): AskRequest | undefined {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const question = parsed.data.question.trim();
  return question === '' ? undefined : { ...parsed.data, question };
}

// The lines of a Change's patch around one side's line range: every row from the first to the last
// that falls in the range, with a few rows of context either way, bounded in length.
export function hunkExcerpt(change: Pick<ReviewChange, 'patch'>, side: Finding['side'], startLine: number, endLine: number): string {
  const rows = diffRows(change.patch);
  const lineOn = (row: (typeof rows)[number]) => side === 'additions' ? row.new : row.old;
  const inRange = rows.flatMap((row, index) => { const line = lineOn(row); return line !== undefined && line >= startLine && line <= endLine ? [index] : []; });
  if (inRange.length === 0) return '';
  const prefix = (row: (typeof rows)[number]) => row.old === undefined ? '+' : row.new === undefined ? '-' : ' ';
  return rows.slice(Math.max(0, inRange[0]! - excerptContext), inRange.at(-1)! + excerptContext + 1).map(row => `${prefix(row)}${row.text}`).join('\n').slice(0, MAX_ASK_EXCERPT);
}

// a Finding's anchor in the Change it cites
export function findingAnchor(finding: Finding, change: ReviewChange): AskAnchor {
  return { findingId: finding.id, title: finding.title, changeId: change.id, file: change.file, side: finding.side, startLine: finding.startLine, endLine: finding.endLine, excerpt: hunkExcerpt(change, finding.side, finding.startLine, finding.endLine) };
}

// One question to a reviewer about one of its own Findings. Each turn repeats the anchor, so a
// follow-up on a long conversation still says which lines it means.
export function reviewerAskPrompt(finding: Pick<Finding, 'severity' | 'body'>, anchor: AskAnchor, question: string): string {
  const lines = anchor.startLine === anchor.endLine ? `line ${anchor.startLine}` : `lines ${anchor.startLine}-${anchor.endLine}`;
  return [
    'The operator reviewing these changes has a question about one of the findings from your review. Answer it in Markdown, concisely. Read the repository as you need to, but do not change any files.',
    `Finding: ${anchor.title} (${finding.severity})`,
    finding.body,
    `Location: ${anchor.file}, ${anchor.side === 'additions' ? 'new' : 'old'} ${lines}`,
    ...(anchor.excerpt === '' ? [] : [`\`\`\`diff\n${anchor.excerpt}\n\`\`\``]),
    `Question: ${question}`
  ].join('\n\n');
}
