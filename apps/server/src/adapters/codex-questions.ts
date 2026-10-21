import { inlineQuestionId } from './inline-questions.js';
import { normalizedLines } from './capture-text.js';
import type { InlineQuestion, TmuxKey } from './types.js';

// admit text only in native question editors, never in arbitrary numbered menus
export function codexQuestionTextEntry(question: InlineQuestion, capture: string): TmuxKey[] | undefined {
  // structured OMX renderers have a different text-entry protocol
  if (question.targetPaneId !== undefined) return undefined;
  const lines = normalizedLines(capture).filter(Boolean);
  const footer = lines.slice(-8).join(' ');
  // the asynchronous editor moves bracketed pastes directly into its other field
  const queued = queuedCodexQuestion(capture);
  if (queued !== undefined && queued.key === undefined) return [];
  // the blocking editor retains its selected option when notes are pasted
  if (!/\benter to submit answer\b/u.test(footer) || question.selectedIndex === undefined) return undefined;
  const other = question.choices.findIndex(choice => /^None of the above(?:\s|$)/u.test(choice));
  // custom text must not silently endorse the preselected recommendation
  if (other < 0) return undefined;
  const distance = other - question.selectedIndex;
  return Array.from({ length: Math.abs(distance) }, () => distance < 0 ? 'Up' : 'Down');
}

// open only the live question footer with an explicitly supported advertised binding
export function queuedCodexQuestion(capture: string): { key?: TmuxKey } | undefined {
  const lines = normalizedLines(capture).filter(Boolean);
  const header = lines.lastIndexOf('• Queued follow-up inputs');
  // ignore ordinary queued messages and historical banners above newer output
  if (header < 0) return undefined;
  const footer = lines.slice(header + 1);
  // keep an opened question remembered when the operator returns to the main prompt
  const editorHint = footer.findIndex(line => /^enter submit(?:\s|$)/u.test(line));
  // navigation hints may wrap, and current codex omits spaces around modifier chords
  if (editorHint >= 0 && /^enter submit\s+ctrl\s*\+\s*\] skip(?:\s+(?:alt|⌥|shift)\s*\+\s*[↑↓←→] (?:main prompt|prev question|next question|queued messages))*$/u.test(footer.slice(editorHint).join(' '))) return {};
  const summary = footer.findIndex(line => /^\? [1-9]\d* questions?(?: · \d+s)?$/u.test(line));
  // require the collapsed summary directly followed by its answer shortcut
  if (summary < 0) return undefined;
  const hint = footer[summary + 1];
  const key = /^(?:alt|⌥)\s*\+\s*↑ to answer$/u.test(hint ?? '') ? 'M-Up'
    : /^shift\s*\+\s*← to answer$/u.test(hint ?? '') ? 'S-Left' : undefined;
  // reject a newer turn, open choice list, or modal below the queued footer
  if (key === undefined || footer.slice(summary + 2).some(line => !/^›(?: |$)/u.test(line)
    && !/^(?![•■])\S.* · \S/u.test(line) && !/^(?:\? for shortcuts(?:\s|$)|\d+% context left$)/u.test(line))) return undefined;
  return { key };
}

/**
 * The Codex inline-question logic, moved server-side (chunk 1 commit 5). An
 * Inline question reaches the console three ways: the agent draws a numbered
 * choice list on its pane (parsed here), OMX writes a structured question file
 * (`omx-questions.ts`, ADR 0005), or a Claude Agent reports one through its pane
 * (`claude-questions.ts`, ADR 0006). All are normalised to one {@link InlineQuestion}
 * with the same id rule (`inline-questions.ts`); the console renders it and
 * answers it through the Adapter's `selectOption`.
 */

// one numbered (or checkbox) choice row: leading selection caret, optional
// `[ ]`/`[x]` box, the displayed number, then the label
const questionChoiceLine = /^([›❯>]\s*)?(?:\[([ xX])\]\s*)?(\d+)[.)]\s+(.+)$/u;
// preserve paragraph boundaries and indentation while removing terminal styling
const agentMessageLines = (message: string) => message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split('\n');
// native question boundaries must never become question or answer content
const questionHeader = /^(?:• Queued follow-up inputs|question \d+(?: of |\/)\d+(?: \(\d+ unanswered\))?)$/iu;
const questionChrome = /^(?:[•■─]|[›❯>](?:\s|$))/u;
// allow wrapped native shortcuts after a choice list, never later agent output
const questionFooter = /^(?:tab to add notes\b|enter (?:submit|to submit answer|to select)\b|esc to (?:interrupt|cancel)\b|press enter to confirm\b|ctrl\s*\+\s*\] skip\b|(?:alt|⌥|shift)\s*\+\s*[↑↓←→] (?:main prompt|prev question|next question|queued messages)\b|←\/→ to navigate questions\b|[↑↓←→](?:\s|$)|[›❯>]\s*$)/iu;

type ChoiceBlock = { labelColumn: number; rows: string[] };

// read aligned label and description columns separately instead of interleaving their wraps
function choiceLabels(blocks: ChoiceBlock[]): string[] {
  const columns = new Map<number, number>();
  // native two-column rows share a description start after at least two padding spaces
  for (const block of blocks) {
    // continuation rows also identify a column when only one option has a description
    for (const row of block.rows) {
      // exclude the option number and label indentation from column candidates
      for (const gap of row.slice(block.labelColumn).matchAll(/ {2,}(?=\S)/gu)) {
        const column = block.labelColumn + gap.index + gap[0].length;
        columns.set(column, (columns.get(column) ?? 0) + 1);
      }
    }
  }
  const descriptionColumn = [...columns].filter(([, count]) => count > 1).sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left - right)[0]?.[0];
  // keep each option's complete label before its complete description
  return blocks.map(block => {
    const first = block.rows[0]!;
    const twoColumns = descriptionColumn !== undefined && first.slice(0, descriptionColumn).endsWith('  ') && /^\S/u.test(first.slice(descriptionColumn));
    const labels = block.rows.map(row => row.slice(block.labelColumn, twoColumns ? descriptionColumn : undefined).trim());
    const descriptions = twoColumns ? block.rows.map(row => row.slice(descriptionColumn).trim()) : [];
    // rendered rows cannot distinguish hard token wraps from authored whitespace
    return [...labels, ...descriptions].join(' ').replace(/\s+/gu, ' ').trim();
  });
}

// read the whole native question or the adjacent prose paragraph for ordinary menus
function choiceQuestionText(lines: string[], start: number, interactive: boolean): string | undefined {
  let end = start;
  // omit the blank gap above the options
  while (end > 0 && !lines[end - 1]!.trim()) end -= 1;
  let begin = end;
  let paragraphStart: number | undefined;
  // native headers allow paragraph breaks inside a question
  while (begin > 0) {
    const line = lines[begin - 1]!.trim();
    // keep all paragraphs after an explicit question header
    if (questionHeader.test(line)) {
      paragraphStart = undefined;
      break;
    }
    // do not absorb earlier menus, progress messages, or prompt chrome
    if (questionChoiceLine.test(line) || questionChrome.test(line) || questionFooter.test(line)) break;
    // without a native header, use only the paragraph nearest the options
    if (!line && paragraphStart === undefined) paragraphStart = begin;
    begin -= 1;
  }
  const context = lines.slice(paragraphStart ?? begin, end).map(line => line.trim()).filter(Boolean);
  // preserve the existing question cue requirement for noninteractive lists
  if (!interactive && !context.some(line => /[?]$|^(?:question|select|choose)\b/iu.test(line))) return undefined;
  return context.join(' ').replace(/^[›❯>]\s*/u, '') || undefined;
}

/**
 * detect a numbered choice list the agent drew on its pane, adapted from
 * the web's `questionFromAgentMessage`: scan the latest output for a run of two
 * or more sequential numbered choices and the question that introduced them.
 * `choices` retain labels and descriptions; the console renders position + 1 as the number
 * and answers by position relative to the freshly captured selection caret.
 */
export function parseChoiceQuestion(message: string): InlineQuestion | undefined {
  const lines = agentMessageLines(message);
  let lastContent = lines.length - 1;
  // find the live content boundary once rather than rescanning every rejected suffix
  while (lastContent >= 0 && (!lines[lastContent]!.trim() || questionFooter.test(lines[lastContent]!.trim()))) lastContent -= 1;
  let detected: { text: string; choices: string[]; selectedIndex?: number } | undefined;
  // inspect complete choice blocks even when narrow panes wrap them over many rows
  for (let start = 0; start < lines.length; start += 1) {
    // skip prose without rescanning it as an option block
    if (!questionChoiceLine.test(lines[start]!.trim())) continue;
    const choiceStart = start;
    const blocks: ChoiceBlock[] = [];
    let interactive = false;
    let selectedIndex: number | undefined;
    let caretCount = 0;
    let end = start;
    let expectedNumber: number | undefined;
    let labelColumn = 0;
    let separated = false;
    // retain every wrapped label and description in its owning answer
    while (end < lines.length) {
      const raw = lines[end]!;
      const line = raw.trim();
      const match = questionChoiceLine.exec(line);
      // retain sequential choices
      if (match) {
        const number = Number(match[3]);
        // reject invalid displayed numbers
        if (number < 1) break;
        // stop at another numbered block
        if (expectedNumber !== undefined && number !== expectedNumber) break;
        interactive ||= match[1] !== undefined || match[2] !== undefined;
        // track the keyboard cursor separately from checked or current values
        if (match[1] !== undefined) {
          selectedIndex = blocks.length;
          caretCount += 1;
        }
        expectedNumber = number + 1;
        labelColumn = raw.indexOf(line) + match[0].length - match[4]!.length;
        blocks.push({ labelColumn, rows: [raw] });
        separated = false;
      } else if (line) {
        // continuation rows align with answer text and stay inside the option paragraph
        if (blocks.length === 0 || separated || questionChrome.test(line) || questionFooter.test(line) || raw.length - raw.trimStart().length < labelColumn) break;
        blocks[blocks.length - 1]!.rows.push(raw);
      } else separated = true;
      end += 1;
    }
    // skip consumed rows even when an old or incomplete menu is rejected
    start = Math.max(start, end - 1);
    // require real choices
    if (blocks.length < 2) continue;
    // keep old menus out of answer mode without truncating a long active menu
    if (end <= lastContent) continue;
    // quoted or malformed lists must not invent a unique keyboard cursor
    if (caretCount !== 1) selectedIndex = undefined;
    const question = choiceQuestionText(lines, choiceStart, interactive);
    // retain the latest question
    if (question) detected = { text: question, choices: choiceLabels(blocks), ...(selectedIndex === undefined ? {} : { selectedIndex }) };
  }
  return detected === undefined
    ? undefined
    : { ...detected, id: inlineQuestionId(detected.text, detected.choices), source: 'parsed' };
}
