import { z } from 'zod';
import { digest } from '../git/comparison.js';
import type { ReviewAgentKind } from '../review-runs/efforts.js';
import type { ReviewRunCapability } from '../review-runs/runner.js';
import { describeSchemaIssues, parseReviewTourInput, type ReviewChange, type ReviewTourInput } from '../review-tour/contracts.js';

export const CODE_REVIEW_TIMEOUT_MS = 900_000;
export const CODE_REVIEW_JOB_TTL_MS = 1_800_000;
export const MAX_CODE_REVIEW_FINDINGS = 100;
export const MAX_CODE_REVIEW_GENERAL = 30;
export const MAX_FINDING_TITLE = 200;
export const MAX_FINDING_BODY = 4_000;
export const MAX_CODE_REVIEW_FOCUS = 2_000;
// the largest structured result a Code review run may return: every finding at its bounds
export const MAX_CODE_REVIEW_OUTPUT_BYTES = 640_000;

export type FindingSeverity = 'high' | 'medium' | 'low';
export type FindingSide = 'additions' | 'deletions';
// one Finding anchored to a Change's lines: `additions` are new-file line numbers, `deletions` old-file ones
export type Finding = { id: string; changeId: string; side: FindingSide; startLine: number; endLine: number; severity: FindingSeverity; title: string; body: string };
// a concern that cannot anchor to a hunk; `file` names the Change's file when the model cited a known one
export type GeneralFinding = { id: string; severity: FindingSeverity; title: string; body: string; file?: string };
export type CodeReviewPresetRef = { id: string; label: string; agent: ReviewAgentKind };
export type CodeReview = { fingerprint: string; preset: CodeReviewPresetRef; effort?: string; focus?: string; findings: Finding[]; general: GeneralFinding[]; completedAt: string };
// the Comparison and settings one Code review run reviews, which its result carries
export type CodeReviewRun = Pick<CodeReview, 'fingerprint' | 'preset' | 'effort' | 'focus'>;
// what an interactive Code review run leaves beside its pane, so a run a restart orphans can still
// be finished: its run and the Worktree and branch whose stored tour the result joins
export type CodeReviewRecovery = CodeReviewRun & { kind: 'code-review'; worktreeId: string; branch: string };
export type CodeReviewOptions = { preset: string; effort?: string; focus?: string };
// one preset as the dashboard offers it, with its agent's runnable state and effort levels
export type CodeReviewPresetCapability = CodeReviewPresetRef & { effort?: string; efforts: string[]; available: boolean; reason?: string };
export type CodeReviewCapability = { defaultPreset: string; presets: CodeReviewPresetCapability[] };
export type GeneratedCodeReview = { findings: Finding[]; general: GeneralFinding[] };
export type ReviewPresetCapabilityInput = CodeReviewPresetRef & { effort?: string; efforts: readonly string[]; capability: ReviewRunCapability };

const severity = z.enum(['high', 'medium', 'low']);
const title = z.string().trim().min(1).max(MAX_FINDING_TITLE);
const body = z.string().trim().min(1).max(MAX_FINDING_BODY);
const file = z.string().min(1).max(4_096);
const line = z.number().int().positive();
const presetId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/u);
const focus = z.string().max(MAX_CODE_REVIEW_FOCUS).refine(value => !value.includes('\0'));
const optionsShape = { preset: presetId, effort: z.string().min(1).max(20).optional(), focus: focus.optional() };
const optionsSchema = z.object(optionsShape).strict();
const addSchema = z.object({ scope: z.enum(['working', 'pr']), includeTests: z.boolean(), includeDocs: z.boolean(), fingerprint: z.string().min(16).max(128), ...optionsShape }).strict();
const generatedFindingSchema = z.object({ changeId: z.string().min(1).max(100), side: z.enum(['additions', 'deletions']), startLine: line, endLine: line, severity, title, body }).strict();
const generatedGeneralSchema = z.object({ severity, title, body, file: file.nullable().optional() }).strict();
const generatedSchema = z.object({ findings: z.array(generatedFindingSchema).max(MAX_CODE_REVIEW_FINDINGS), general: z.array(generatedGeneralSchema).max(MAX_CODE_REVIEW_GENERAL) }).strict();
const findingId = z.string().min(1).max(64);
const findingSchema = generatedFindingSchema.extend({ id: findingId }).strict();
const generalSchema = z.object({ id: findingId, severity, title, body, file: file.optional() }).strict();
const codeReviewSchema = z.object({
  fingerprint: z.string().min(16).max(128),
  preset: z.object({ id: presetId, label: z.string().min(1).max(80), agent: z.enum(['codex', 'claude']) }).strict(),
  effort: z.string().min(1).max(20).optional(),
  focus: focus.optional(),
  findings: z.array(findingSchema).max(MAX_CODE_REVIEW_FINDINGS),
  general: z.array(generalSchema).max(MAX_CODE_REVIEW_GENERAL + MAX_CODE_REVIEW_FINDINGS),
  completedAt: z.string().refine(value => Number.isFinite(Date.parse(value)))
}).strict();
const recoverySchema = codeReviewSchema.pick({ fingerprint: true, preset: true, effort: true, focus: true }).extend({ kind: z.literal('code-review'), worktreeId: z.string().min(1).max(4_096), branch: z.string().min(1).max(1_024) }).strict();

// drop a blank focus so it neither reaches the prompt nor the idempotency check
function normalizedOptions(options: z.output<typeof optionsSchema>): CodeReviewOptions {
  const trimmed = options.focus?.trim();
  return { preset: options.preset, ...(options.effort === undefined ? {} : { effort: options.effort }), ...(trimmed === undefined || trimmed === '' ? {} : { focus: trimmed }) };
}

// parse one requested Code review
export function parseCodeReviewOptions(value: unknown): CodeReviewOptions | undefined {
  const parsed = optionsSchema.safeParse(value);
  return parsed.success ? normalizedOptions(parsed.data) : undefined;
}

// parse a tour start that may request a Code review beside it
export function parseReviewTourStart(value: unknown): { input: ReviewTourInput; codeReview?: CodeReviewOptions } | undefined {
  // require a plain object body
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { codeReview: requested, ...rest } = value as Record<string, unknown>;
  const input = parseReviewTourInput(rest);
  // reject a malformed tour request
  if (input === undefined) return undefined;
  // a tour without a Code review
  if (requested === undefined) return { input };
  const codeReview = parseCodeReviewOptions(requested);
  return codeReview === undefined ? undefined : { input, codeReview };
}

// parse an "Add AI review" request against an existing tour's Comparison
export function parseCodeReviewAdd(value: unknown): { input: ReviewTourInput; fingerprint: string; options: CodeReviewOptions } | undefined {
  const parsed = addSchema.safeParse(value);
  // require the exact request shape
  if (!parsed.success) return undefined;
  const { scope, includeTests, includeDocs, fingerprint, ...options } = parsed.data;
  return { input: { scope, includeTests, includeDocs }, fingerprint, options: normalizedOptions(options) };
}

// whether two requested Code reviews are the same logical request
export function sameCodeReviewOptions(left: CodeReviewOptions | undefined, right: CodeReviewOptions | undefined): boolean {
  return left?.preset === right?.preset && left?.effort === right?.effort && left?.focus === right?.focus;
}

// the line span one side of a Change covers, or undefined when that side cannot anchor a Finding
export function anchorRange(change: ReviewChange, side: FindingSide): { first: number; last: number } | undefined {
  if (change.kind === 'hunk') {
    const start = side === 'additions' ? change.newStart : change.oldStart;
    const count = side === 'additions' ? change.newLines : change.oldLines;
    // an absent or empty side covers no lines
    if (start === undefined || count === undefined || count < 1) return undefined;
    return { first: start, last: start + count - 1 };
  }
  // an untracked file is new: only its added lines, 1 to the count its `@@ -0,0 +1,N @@` header
  // gives (1 when omitted, per unified diff); a content line may itself start with `++ `
  if (change.kind === 'untracked' && side === 'additions') {
    const header = /^@@ -\d+(?:,\d+)? \+\d+(?:,(\d+))? @@/mu.exec(change.patch);
    const count = header === null ? 0 : Number(header[1] ?? 1);
    return count < 1 ? undefined : { first: 1, last: count };
  }
  return undefined;
}

// a short content digest naming one finding, stable for the same content
function contentId(parts: Array<string | number | undefined>): string {
  return `fnd_${digest(JSON.stringify(parts)).slice(0, 16)}`;
}

// validate model output and anchor each finding to a hunk's lines; a finding that cannot anchor
// (unknown Change, a line outside the hunk's span on its side, a binary, rename or metadata Change)
// becomes a general finding carrying the known Change's file, so nothing is dropped or clamped
export function parseGeneratedCodeReview(value: unknown, changes: ReviewChange[]): GeneratedCodeReview | undefined {
  const parsed = generatedSchema.safeParse(value);
  // require structural validity
  if (!parsed.success) return undefined;
  const byId = new Map(changes.map(change => [change.id, change]));
  const findings: Finding[] = [];
  const general: GeneralFinding[] = [];
  const seen = new Set<string>();
  // retain the first of identical general findings
  const addGeneral = (item: Omit<GeneralFinding, 'id'>) => {
    const id = contentId([item.severity, item.title, item.body, item.file]);
    if (seen.has(id)) return;
    seen.add(id);
    general.push({ id, ...item });
  };
  // anchor every cited finding
  for (const item of parsed.data.findings) {
    const change = byId.get(item.changeId);
    const range = change === undefined ? undefined : anchorRange(change, item.side);
    // demote a finding that cannot anchor inside its hunk
    if (range === undefined || item.startLine > item.endLine || item.startLine < range.first || item.endLine > range.last) {
      addGeneral({ severity: item.severity, title: item.title, body: item.body, ...(change === undefined ? {} : { file: change.file }) });
      continue;
    }
    const id = contentId([item.changeId, item.side, item.startLine, item.endLine, item.title, item.body]);
    // retain the first of identical findings
    if (seen.has(id)) continue;
    seen.add(id);
    findings.push({ id, changeId: item.changeId, side: item.side, startLine: item.startLine, endLine: item.endLine, severity: item.severity, title: item.title, body: item.body });
  }
  // keep every unanchored concern
  for (const item of parsed.data.general) addGeneral({ severity: item.severity, title: item.title, body: item.body, ...(item.file === undefined || item.file === null ? {} : { file: item.file }) });
  return { findings, general };
}

// what makes a model reply fail the output shape, in words an agent can correct; anchoring
// never fails a reply (an unanchored finding becomes a general one)
export function codeReviewReplyError(value: unknown): string | undefined {
  const parsed = generatedSchema.safeParse(value);
  return parsed.success ? undefined : describeSchemaIssues(parsed.error);
}

// the Code review a run's structured output makes, its findings anchored in the reviewed Changes
export function codeReviewFrom(output: unknown, changes: ReviewChange[], run: CodeReviewRun): CodeReview | undefined {
  const parsed = parseGeneratedCodeReview(output, changes);
  if (parsed === undefined) return undefined;
  return { fingerprint: run.fingerprint, preset: run.preset, ...(run.effort === undefined ? {} : { effort: run.effort }), ...(run.focus === undefined ? {} : { focus: run.focus }), findings: parsed.findings, general: parsed.general, completedAt: new Date().toISOString() };
}

// validate the recovery an orphaned Code review run left
export function parseCodeReviewRecovery(value: unknown): CodeReviewRecovery | undefined {
  const parsed = recoverySchema.safeParse(value);
  return parsed.success ? parsed.data as CodeReviewRecovery : undefined;
}

// validate a persisted Code review
export function parseCodeReview(value: unknown): CodeReview | undefined {
  const parsed = codeReviewSchema.safeParse(value);
  return parsed.success ? parsed.data as CodeReview : undefined;
}

// describe one preset's runnable state for the dashboard
export function presetCapability(input: ReviewPresetCapabilityInput): CodeReviewPresetCapability {
  return { id: input.id, label: input.label, agent: input.agent, ...(input.effort === undefined ? {} : { effort: input.effort }), efforts: [...input.efforts], available: input.capability.available, ...(input.capability.available ? {} : { reason: input.capability.reason }) };
}

// every property is required (`file` is nullable) so strict structured-output modes accept it
export const generatedCodeReviewJsonSchema = {
  type: 'object', additionalProperties: false, required: ['findings', 'general'],
  properties: {
    findings: { type: 'array', maxItems: MAX_CODE_REVIEW_FINDINGS, items: {
      type: 'object', additionalProperties: false, required: ['changeId', 'side', 'startLine', 'endLine', 'severity', 'title', 'body'],
      properties: {
        changeId: { type: 'string', minLength: 1, maxLength: 100 },
        side: { type: 'string', enum: ['additions', 'deletions'] },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        title: { type: 'string', minLength: 1, maxLength: MAX_FINDING_TITLE },
        body: { type: 'string', minLength: 1, maxLength: MAX_FINDING_BODY }
      }
    } },
    general: { type: 'array', maxItems: MAX_CODE_REVIEW_GENERAL, items: {
      type: 'object', additionalProperties: false, required: ['severity', 'title', 'body', 'file'],
      properties: {
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        title: { type: 'string', minLength: 1, maxLength: MAX_FINDING_TITLE },
        body: { type: 'string', minLength: 1, maxLength: MAX_FINDING_BODY },
        file: { type: ['string', 'null'], maxLength: 4_096 }
      }
    } }
  }
} as const;
