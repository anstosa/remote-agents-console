import { isAbsolute } from 'node:path';
import { stripAnsi } from './capture-text.js';
import { inlineQuestionId } from './inline-questions.js';
import type { InlineQuestion } from './types.js';

const safetyWarning = 'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.';
const nativeFooter = 'enter continue · esc quit';
const choiceRow = /^([›❯>]\s*)?([12])\.\s+(.+)$/u;

// a recognized but unsupported trust surface still blocks generic answers and startup prompts
type TrustDialog = { question?: InlineQuestion };

// read the current local codex trust surface without granting or persisting consent
export function codexFolderTrustDialog(capture: string): TrustDialog | undefined {
  const lines = stripAnsi(capture).split('\n').map(line => line.trim()).filter(Boolean);
  const heading = lines.lastIndexOf('Folder access');
  const dialog = heading < 0 ? lines : lines.slice(heading + 1);
  let firstChoice = -1;
  // only the latest numbered menu may identify the current native dialog
  for (let index = 0; index < dialog.length; index += 1) {
    // a later ordinary question supersedes earlier native choice rows
    if (/^[›❯>]?\s*1\./u.test(dialog[index]!)) firstChoice = index;
  }
  const nativeAction = /^[›❯>]?\s*1\. (?:Trust and continue|Open restricted|Open existing task)$/u.test(dialog[firstChoice] ?? '');
  const folder = dialog[0];
  const footer = dialog.findIndex(line => /^enter continue\b/iu.test(line));
  const nativeChrome = /^enter continue · esc (?:quit|back)$/u.test(dialog[footer]?.toLowerCase() ?? '');
  const knownWarning = heading >= 0 && dialog.slice(1, firstChoice).join(' ').replace(/\s+/gu, ' ') === safetyWarning;
  // action labels need native context; quoted headings alone must not suppress ordinary menus
  if (!(nativeAction && (nativeChrome || knownWarning)) && !(heading >= 0 && folder !== undefined && isAbsolute(folder) && nativeChrome)) return undefined;
  const footerText = footer < 0 ? '' : dialog.slice(footer).join(' ').toLowerCase();
  // resolved startup chrome must not suppress newer ordinary questions
  if (/^enter continue · esc (?:quit|back) .+/u.test(footerText)) return undefined;
  // malformed trust chrome is terminal-only, never an ordinary unprivileged question
  if (heading < 0 || footer < 0 || footerText !== nativeFooter) return {};
  // omitted or shortened paths cannot identify the folder the operator would authorize
  if (folder === undefined || !isAbsolute(folder) || /…|\.\.\./u.test(folder)) return {};
  // require the complete verified warning rather than silently accepting a wider grant
  if (firstChoice < 2 || dialog.slice(1, firstChoice).join(' ').replace(/\s+/gu, ' ') !== safetyWarning) return {};
  const rows = dialog.slice(firstChoice, footer).map(line => choiceRow.exec(line));
  // local linux startup has exactly these two ordered choices and no sandbox or git-root grant
  if (rows.length !== 2 || rows[0]?.[2] !== '1' || rows[0]?.[3] !== 'Trust and continue' || rows[1]?.[2] !== '2' || rows[1]?.[3] !== 'Quit') return {};
  const selected = rows.flatMap((row, index) => row?.[1] === undefined ? [] : [index]);
  // an ambiguous cursor must never let enter approve a different choice
  if (selected.length !== 1) return {};
  const text = `Do you trust ${folder}?`;
  const choices = ['Trust and continue', 'Quit'];
  return { question: { id: inlineQuestionId(text, choices), text, detail: safetyWarning, choices, permission: true, source: 'parsed', pane: { selectedIndex: selected[0]! } } };
}
