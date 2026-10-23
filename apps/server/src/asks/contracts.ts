import { z } from 'zod';
import { reviewAgentKinds, validConversationId, type ReviewAgentKind } from '../review-runs/kinds.js';
import { diffRows } from '../review-tour/diff-rows.js';
import type { Finding } from '../code-review/contracts.js';
import type { ComparisonPatch } from '../git/comparison.js';
import type { ReviewChange } from '../review-tour/contracts.js';

export const MAX_ASK_QUESTION = 4_000;
// the longest answer kept, in bytes
export const MAX_ASK_ANSWER_BYTES = 64_000;
export const MAX_ASK_EXCERPT = 8_000;
export const MAX_ASK_THREADS = 200;
export const MAX_ASK_TURNS = 40;
// the most questions one Worktree may have waiting for an answer at once
export const MAX_ASK_PENDING = 10;
export const ASK_TIMEOUT_MS = 600_000;
export const ASK_JOB_TTL_MS = 900_000;
export const ASK_REQUEST_BODY_BYTES = 16_384;
// the most patch text a diff conversation's first prompt carries; later Changes are named without theirs
export const MAX_ASK_SEED_BYTES = 200_000;
// the lines of context an excerpt keeps either side of the asked-about lines
const excerptContext = 3;

type Side = Finding['side'];
// Lines of one Change (in the Code panel, where a Change is a file, its id is its path): a range on one side (`additions` are new-file line numbers, `deletions`
// old-file ones), or, with `startSide`, a range of a unified diff from a line on that side to
// `endLine` on `side`.
export type AskLines = { changeId: string; startSide?: Side; side: Side; startLine: number; endLine: number };
// Where a question points: its lines and file, their hunk lines with a little context, and, for a
// question about a Finding, the Finding's id and title.
export type AskAnchor = AskLines & { file: string; excerpt: string; findingId?: string; title?: string };
// one question and how it settled: its answer, or why it has none
export type AskTurn = { id: string; question: string; askedAt: string; answer?: string; error?: { code: string; retryable: boolean } };
// One Ask thread: the questions asked about one anchor, all in one agent conversation. `reviewer` threads
// ask the Code review's own conversation about one of its Findings, `guide` threads the tour's own
// conversation about some of its lines, and `diff` threads the conversation a Code panel's questions
// about one Comparison started.
export type AskThread = { id: string; target: 'reviewer' | 'guide' | 'diff'; kind: ReviewAgentKind; conversation: string; anchor: AskAnchor; turns: AskTurn[] };
// one question: to the reviewer about a Finding, or to the guide about new lines or on an existing thread
export type AskRequest = { question: string; fingerprint: string } & ({ target: 'reviewer'; findingId: string } | { target: 'guide'; lines: AskLines } | { target: 'guide'; threadId: string });
// One question about a Code panel's Comparison: about new lines, picked in the Comparison of
// `fingerprint`, or on an existing thread, which reads its lines in the Comparison as it is now.
export type ChangeAskRequest = { question: string } & ({ lines: AskLines; fingerprint: string } | { threadId: string });

const text = (max: number) => z.string().max(max).refine(value => !value.includes('\0'));
const line = z.number().int().positive();
const id = z.string().min(1).max(64);
const turnSchema = z.object({ id, question: text(MAX_ASK_QUESTION).refine(value => value !== ''), askedAt: z.string().refine(value => Number.isFinite(Date.parse(value))), answer: z.string().max(MAX_ASK_ANSWER_BYTES).optional(), error: z.object({ code: z.string().min(1).max(64), retryable: z.boolean() }).strict().optional() }).strict();
const side = z.enum(['additions', 'deletions']);
const linesShape = { changeId: z.string().min(1).max(4_096), startSide: side.optional(), side, startLine: line, endLine: line };
const anchorSchema = z.object({ ...linesShape, findingId: id.optional(), title: z.string().min(1).max(200).optional(), file: z.string().min(1).max(4_096), excerpt: text(MAX_ASK_EXCERPT) }).strict();
const threadSchema = z.object({ id, target: z.enum(['reviewer', 'guide', 'diff']), kind: z.enum(reviewAgentKinds), conversation: z.string().min(1).max(200), anchor: anchorSchema, turns: z.array(turnSchema).max(MAX_ASK_TURNS) }).strict()
  .refine(thread => validConversationId(thread.kind, thread.conversation) && (thread.target !== 'reviewer' || thread.anchor.findingId !== undefined && thread.anchor.title !== undefined));
const question = { question: text(MAX_ASK_QUESTION), fingerprint: z.string().min(16).max(128) };
const requestSchema = z.union([
  z.object({ target: z.literal('reviewer'), findingId: id, ...question }).strict(),
  z.object({ target: z.literal('guide'), lines: z.object(linesShape).strict(), ...question }).strict(),
  z.object({ target: z.literal('guide'), threadId: id, ...question }).strict()
]);
const changeRequestSchema = z.union([
  z.object({ lines: z.object(linesShape).strict(), ...question }).strict(),
  // a follow-up reads its lines as they are now, whatever Comparison the asker saw
  z.object({ threadId: id, ...question, fingerprint: question.fingerprint.optional() }).strict()
]);

// validate a persisted Ask thread
export function parseAskThread(value: unknown): AskThread | undefined {
  const parsed = threadSchema.safeParse(value);
  return parsed.success ? parsed.data as AskThread : undefined;
}

// parse one question; a blank question is refused
export function parseAskRequest(value: unknown): AskRequest | undefined {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const question = parsed.data.question.trim();
  return question === '' ? undefined : { ...parsed.data, question } as AskRequest;
}

// parse one question about a Code panel's Comparison; a blank question is refused
export function parseChangeAskRequest(value: unknown): ChangeAskRequest | undefined {
  const parsed = changeRequestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const question = parsed.data.question.trim();
  if (question === '') return undefined;
  return 'lines' in parsed.data ? { ...parsed.data, question } : { threadId: parsed.data.threadId, question };
}

// The lines of a Change's patch around some of its lines: every row from the first to the last that
// falls in them, with a few rows of context either way, bounded in length. Empty when the patch does
// not hold them.
export function hunkExcerpt(change: Pick<ReviewChange, 'patch'>, lines: Omit<AskLines, 'changeId'>): string {
  const rows = diffRows(change.patch);
  const lineOn = (row: (typeof rows)[number], on: Side) => on === 'additions' ? row.new : row.old;
  const startSide = lines.startSide ?? lines.side;
  const found = startSide === lines.side
    ? rows.flatMap((row, index) => { const at = lineOn(row, lines.side); return at !== undefined && at >= lines.startLine && at <= lines.endLine ? [index] : []; })
    : [rows.findIndex(row => lineOn(row, startSide) === lines.startLine), rows.findIndex(row => lineOn(row, lines.side) === lines.endLine)];
  if (found.length === 0 || found.includes(-1)) return '';
  const prefix = (row: (typeof rows)[number]) => row.old === undefined ? '+' : row.new === undefined ? '-' : ' ';
  return rows.slice(Math.max(0, Math.min(...found) - excerptContext), Math.max(...found) + excerptContext + 1).map(row => `${prefix(row)}${row.text}`).join('\n').slice(0, MAX_ASK_EXCERPT);
}

// the anchor of some lines in their Change
export function linesAnchor(lines: AskLines, change: Pick<ReviewChange, 'id' | 'file' | 'patch'>): AskAnchor {
  const { changeId: _changeId, startSide, ...rest } = lines;
  // a range on one side names no start side
  const range = startSide === undefined || startSide === rest.side ? rest : { ...rest, startSide };
  return { ...range, changeId: change.id, file: change.file, excerpt: hunkExcerpt(change, range) };
}

// a Finding's anchor in the Change it cites
export function findingAnchor(finding: Finding, change: ReviewChange): AskAnchor {
  return { findingId: finding.id, title: finding.title, ...linesAnchor({ changeId: change.id, side: finding.side, startLine: finding.startLine, endLine: finding.endLine }, change) };
}

// One question to a reviewer about one of its own Findings. Each turn repeats the anchor, so a
// follow-up on a long conversation still says which lines it means.
export function reviewerAskPrompt(finding: Pick<Finding, 'title' | 'severity' | 'body'>, anchor: AskAnchor, question: string): string {
  return [
    'The operator reviewing these changes has a question about one of the findings from your review. Answer it in Markdown, concisely. Read the repository as you need to, but do not change any files.',
    `Finding: ${finding.title} (${finding.severity})`,
    finding.body,
    ...anchorLines(anchor),
    `Question: ${question}`
  ].join('\n\n');
}

// One question to the tour's guide about some of the lines it narrated. The tour's JSON contract and
// its no-review rule were for the tour itself, so the prompt lifts them. Each turn repeats the anchor.
export function guideAskPrompt(anchor: AskAnchor, question: string): string {
  return [
    'The operator following the review tour you narrated has a question about some of the changed lines. This is a conversation, not another tour: the JSON format and the rule against reviewing no longer apply. Answer in Markdown, concisely, and assess the code if asked. Read the repository as you need to, but do not change any files.',
    ...anchorLines(anchor),
    `Question: ${question}`
  ].join('\n\n');
}

// One question about some lines of a Code panel's Comparison, in the conversation its first question
// started. Each turn repeats the anchor with its current hunk, since the changes move on, or, for lines
// the changes no longer hold (`current` false), the hunk as it was first asked about.
export function diffAskPrompt(anchor: AskAnchor, question: string, current = true): string {
  const lines = current ? 'the lines below are as they are now' : 'the lines below are as they were when first asked about, and the changes no longer hold them';
  return [
    `The operator has a question about some of the changed lines. The changes may have moved on since they were first shown to you; ${lines}. Answer in Markdown, concisely. Read the repository as you need to, but do not change any files.`,
    ...anchorLines(anchor),
    `Question: ${question}`
  ].join('\n\n');
}

// The first question about a Code panel's Comparison, which starts its conversation: what the
// Comparison is, its Changes and as many of their patches as fit, then the question.
export function diffSeedPrompt(comparison: { label: string; patch: ComparisonPatch }, anchor: AskAnchor, question: string): string {
  const { files, base } = comparison.patch;
  let budget = MAX_ASK_SEED_BYTES;
  let left = false;
  const patches = files.flatMap(file => {
    if (file.patch === '') return [];
    if (Buffer.byteLength(file.patch) > budget) { left = true; return []; }
    budget -= Buffer.byteLength(file.patch);
    return [`\`\`\`diff\n${file.patch.trimEnd()}\n\`\`\``];
  });
  const counts = (change: ComparisonPatch['files'][number]['change']) => change.additions === undefined && change.deletions === undefined ? '' : ` (+${change.additions ?? 0} -${change.deletions ?? 0})`;
  return [
    `The operator is reading a set of code changes in this repository (${comparison.label}, against ${base}) and will ask you questions about them. Answer in Markdown, concisely, and assess the code if asked. Read the repository as you need to, but do not change any files.`,
    `The changes:\n${files.map(file => `${file.change.code} ${file.change.originalPath === undefined ? '' : `${file.change.originalPath} -> `}${file.change.path}${counts(file.change)}`).join('\n')}`,
    ...patches.length === 0 ? [] : [`Their patches${left || comparison.patch.truncated || files.some(file => file.capped) ? ' (some left out for size)' : ''}:\n\n${patches.join('\n\n')}`],
    'Later questions carry their lines as they are then, since the changes may move on. The first question:',
    ...anchorLines(anchor),
    `Question: ${question}`
  ].join('\n\n');
}

// where an anchor points, and its hunk lines
function anchorLines(anchor: AskAnchor): string[] {
  const word = (side: Side) => side === 'additions' ? 'new' : 'old';
  const startSide = anchor.startSide ?? anchor.side;
  const lines = startSide !== anchor.side ? `${word(startSide)} line ${anchor.startLine} to ${word(anchor.side)} line ${anchor.endLine}`
    : anchor.startLine === anchor.endLine ? `${word(anchor.side)} line ${anchor.startLine}` : `${word(anchor.side)} lines ${anchor.startLine}-${anchor.endLine}`;
  return [`Location: ${anchor.file}, ${lines}`, ...(anchor.excerpt === '' ? [] : [`\`\`\`diff\n${anchor.excerpt}\n\`\`\``])];
}
