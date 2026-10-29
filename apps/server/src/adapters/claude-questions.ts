// the shared capture normaliser: drop ANSI, box-drawing and bar glyphs to spaces,
// collapse whitespace, so a wrapped or box-framed line matches its plain string
import { normalizeLine as normalize } from './capture-text.js';
import { inlineQuestionId } from './inline-questions.js';
import type { InlineQuestion, TmuxKey } from './types.js';

/**
 * Claude Code's `AskUserQuestion` dialog rendered as an Inline question (ADR 0006).
 * The console never parses the TUI: the question's content arrives exact through the
 * hook payload the Agent reports on its pane (`@rac_question`), and two presence
 * checks on the pane's capture — both built from the payload's own strings — decide
 * whether the dialog is still open. An Esc cancel fires no hook, and the transcript
 * repeats every answered or declined question's text, so a question counts as live
 * only when its text *and* its first numbered option row are on screen.
 *
 * A call carrying several questions walks one tab at a time: only the active tab's
 * text and rows are drawn, so exactly one of the payload's questions is live at a
 * time. After the last answer a review page repeats every question's text with its
 * answer and offers Submit answers / Cancel; that page is matched by its own literal
 * before any question text, and rendered as the two-choice question `selectOption(0)`
 * submits.
 *
 * A free-text answer goes through the `N+1. Type something.` row drawn under the N
 * options: Down × N from the first option focuses its inline input, a bracketed
 * paste fills it, and Enter submits it as the answer. The input keeps Up for itself
 * (Up × 6 on the row stays put), so the caret cannot be homed from there.
 *
 * Below that row, past a rule, Claude draws `N+2. Chat about this`: selecting it
 * declines the question so the conversation can discuss it. When drawn it is offered
 * as one more choice whose on-screen row skips the text input.
 */

// only the bottom of the screen holds the live dialog; the transcript above repeats
// answered and declined question text, so scrollback must not count
const questionWindowLines = 80;

// a single-choice question ready to render: its text and its option labels. The
// review/submit step of a multi-question call is one more of these — its prompt as
// the text, Submit answers / Cancel as the choices — so it matches through the same
// `isLive` check and renders through the same `asInline`.
type Renderable = { text: string; choices: string[]; descriptions?: string[] };
const reviewStep: Renderable = { text: 'Ready to submit your answers?', choices: ['Submit answers', 'Cancel'] };
const chatChoice = 'Chat about this';

type ReportedOption = { label?: unknown; description?: unknown };
type ReportedQuestion = { question?: unknown; options?: unknown; multiSelect?: unknown };
type ReportedPayload = { hook_event_name?: unknown; tool_name?: unknown; tool_input?: { questions?: unknown } };

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

// the questions array of a well-formed PreToolUse AskUserQuestion body, or undefined
function decodeQuestions(payload: string): ReportedQuestion[] | undefined {
  let parsed: ReportedPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as ReportedPayload;
  } catch { return undefined; }
  if (parsed?.hook_event_name !== 'PreToolUse' || parsed.tool_name !== 'AskUserQuestion') return undefined;
  const questions = parsed.tool_input?.questions;
  // agent-controlled content: validate the shape defensively
  return Array.isArray(questions) && questions.length >= 1 && questions.length <= 4 ? questions as ReportedQuestion[] : undefined;
}

// one single-choice question with 2–16 labelled options, or undefined (multiSelect,
// option-less text/number kinds, and malformed option lists render nothing in v1)
function renderableQuestion(question: ReportedQuestion): Renderable | undefined {
  if (question.multiSelect === true || !isNonEmptyString(question.question) || !Array.isArray(question.options)) return undefined;
  const choices = question.options.map(option => (option as ReportedOption)?.label).filter(isNonEmptyString);
  // every option must carry a label, and the list must be a real choice set
  if (choices.length !== question.options.length || choices.length < 2 || choices.length > 16) return undefined;
  const descriptions = question.options.map(option => {
    const description = (option as ReportedOption).description;
    return typeof description === 'string' ? description : '';
  });
  return { text: question.question, choices, ...(descriptions.some(Boolean) ? { descriptions } : {}) };
}

// descriptions ride along for display only; the id stays text + labels
const asInline = ({ text, choices, descriptions }: Renderable): InlineQuestion =>
  ({ id: inlineQuestionId(text, choices), text, choices: [...choices], ...(descriptions === undefined ? {} : { descriptions: [...descriptions] }), source: 'structured' });

// append the Chat about this row when the dialog draws it under the text input
function withChat(question: Renderable, window: string): InlineQuestion {
  const count = question.choices.length;
  if (!window.includes(normalize(`${count + 2}. ${chatChoice}`))) return asInline(question);
  const descriptions = question.descriptions === undefined ? undefined : [...question.descriptions, ''];
  const rows = [...question.choices.keys(), count + 1];
  return { ...asInline({ text: question.text, choices: [...question.choices, chatChoice], descriptions }), pane: { rows } };
}

// the normalised last-80-line window. Claude pads blank rows below the dialog to
// the pane height, so trailing blanks are trimmed before windowing — otherwise a
// tall pane with a short session would push the dialog's top (its question text)
// above the last 80 lines
function captureWindow(capture: string): string {
  const lines = capture.split('\n');
  while (lines.length > 0 && normalize(lines[lines.length - 1]!) === '') lines.pop();
  return normalize(lines.slice(-questionWindowLines).join('\n'));
}

// a question is live only when its text (or its 48-char prefix, for a truncating
// narrow pane) and its first numbered option row are both on screen; the
// answered/declined summaries repeat the text but never draw a numbered row
function isLive({ text, choices }: Renderable, window: string): boolean {
  const normalizedText = normalize(text);
  const textPresent = window.includes(normalizedText) || window.includes(normalizedText.slice(0, 48));
  return textPresent && window.includes(normalize(`1. ${choices[0]}`));
}

/**
 * The Inline question a Claude Agent reported through its pane, confirmed live on
 * the capture. `payload` is the base64 PreToolUse hook body from `@rac_question`;
 * `capture` is a raw `capture-pane -e -p` snapshot. Pure and side-effect-free.
 */
export function reportedClaudeQuestion(payload: string, capture: string): InlineQuestion | undefined {
  const questions = decodeQuestions(payload);
  if (questions === undefined) return undefined;
  const window = captureWindow(capture);
  // A multi-question call ends on a review page that repeats every question's text,
  // so the submit step is matched by its own prompt before any question text; its
  // Submit answers row is drawn first, so selectOption(0) submits.
  if (questions.length >= 2 && isLive(reviewStep, window)) return asInline(reviewStep);
  // Otherwise the one question on screen. Only the active tab is drawn, so exactly
  // one renderable question is live; zero (answered/cancelled) or several
  // (indistinguishable identical text and first option) render nothing.
  const live = questions
    .map(renderableQuestion)
    .filter((question): question is Renderable => question !== undefined && isLive(question, window));
  return live.length === 1 ? withChat(live[0]!, window) : undefined;
}

/**
 * Keys that move a freshly opened dialog's caret from option 1 onto its
 * `Type something.` row, or undefined when that row is not on screen — the review
 * page offers no free-text row, and a text answer must never land on an option.
 * Like `selectOption`, this assumes the caret opens on row 1 (ADR 0006).
 */
export function claudeQuestionTextEntry(question: InlineQuestion, capture: string): TmuxKey[] | undefined {
  if (question.source !== 'structured') return undefined;
  // the text input is the row right after the options — the one row the choices skip
  const options = question.pane?.rows === undefined ? question.choices.length : question.choices.length - 1;
  const row = normalize(`${options + 1}. Type something.`);
  if (!captureWindow(capture).includes(row)) return undefined;
  return Array.from({ length: options }, (): TmuxKey => 'Down');
}

// the Type something input drops line breaks (a pasted `a\nb` answers `ab`), so
// join lines with a space to keep the words apart
export const claudeQuestionTextAnswer = (text: string): string => text.trim().replace(/\s*\n\s*/gu, ' ');
