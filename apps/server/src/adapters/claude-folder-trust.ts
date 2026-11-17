import { isAbsolute } from 'node:path';
import { stripAnsi } from './capture-text.js';
import { inlineQuestionId } from './inline-questions.js';
import type { InlineQuestion } from './types.js';

const affirmation = 'Yes, I trust this folder';
const refusals = new Set(['No, exit', 'No, continue without these permissions']);
const safetyWarning = "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here.";

// match the native startup permission dialog without needing an ask-user hook payload
export function claudeFolderTrustQuestion(capture: string): InlineQuestion | undefined {
  const lines = stripAnsi(capture).split('\n').map(line => line.trim()).filter(Boolean);
  const heading = lines.lastIndexOf('Accessing workspace:');
  // a question without its displayed folder cannot authorize trust
  if (heading < 0) return undefined;
  const dialog = lines.slice(heading + 1);
  const folder = dialog[0];
  // preserve literal punctuation but reject ambiguous shortened folder displays
  if (folder === undefined || !isAbsolute(folder) || /…|\.\.\./u.test(folder)) return undefined;
  const footer = dialog.findIndex(line => /^Enter to confirm\b/iu.test(line));
  // later output retires the entire dialog rather than leaving stale answer buttons
  if (footer < 0 || !/^Enter to confirm\s*·\s*Esc to cancel$/iu.test(dialog.slice(footer).join(' '))) return undefined;
  const firstChoice = dialog.findIndex(line => /^[❯›>]?\s*(?:Yes,|No,) /u.test(line));
  // keep the native warning separate from the exact unnumbered choices
  if (firstChoice < 2 || firstChoice >= footer) return undefined;
  // current claude adds one informational link after the unchanged safety warning
  const warningEnd = dialog[firstChoice - 1] === 'Security guide' ? firstChoice - 1 : firstChoice;
  const detail = dialog.slice(1, warningEnd).join(' ').replace(/\s+/gu, ' ');
  // the warning scope is fixed, so changed or incomplete permissions cannot share this id
  if (detail !== safetyWarning) return undefined;
  const options: Array<{ label: string; selected: boolean }> = [];
  // retain wrapped refusal labels and the current keyboard cursor
  for (const line of dialog.slice(firstChoice, footer)) {
    const row = /^([❯›>]\s*)?((?:Yes,|No,) .+)$/u.exec(line);
    // start a native choice before collecting its wrapped continuation
    if (row !== null) options.push({ label: row[2]!, selected: row[1] !== undefined });
    else {
      const previous = options.at(-1);
      // continuation text must belong to an existing choice
      if (previous === undefined) return undefined;
      previous.label += ` ${line}`;
    }
  }
  const choices = options.map(option => option.label);
  // the only supported permission is one affirmative and one exact native refusal
  if (choices.length !== 2 || choices.filter(label => label === affirmation).length !== 1 || choices.filter(label => refusals.has(label)).length !== 1) return undefined;
  const selected = options.flatMap((option, index) => option.selected ? [index] : []);
  // an unknown cursor must never cause enter to confirm the wrong trust choice
  if (selected.length !== 1) return undefined;
  const text = `Do you trust ${folder}?`;
  return { id: inlineQuestionId(text, choices), text, detail, choices, permission: true, source: 'parsed', pane: { selectedIndex: selected[0]! } };
}
