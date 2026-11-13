/**
 * The Codex adapter's pure parsing and submission descriptions (ADR 0002).
 *
 * These functions turn a raw `capture-pane` snapshot into Codex's Turns and read
 * a prompt back out of one, and shape a prompt into the exact text Codex's
 * composer needs. They are dependency-free string transforms: the Codex Adapter
 * exposes them through `submission`/`turns`, and the console imports the handful
 * it still runs directly — the captured-window enrichment and the Codex-only
 * update-advisor flow. They used to live in the tmux and prompts modules; moving
 * them here is what makes Turn capture the Adapter's concern, not the console's.
 */

import type { SubmissionDraftState } from './types.js';

const selectedChoice = /^›\s+(?:\[[ xX]\]\s*)?\d+[.)]\s/u;
// identify codex's model/worktree status row
const composerStatusLine = /^ {2}\S.*(?: · \S.*)+$/u;
// require a displayed workspace before treating an adjacent shortcuts row as chrome
const composerWorkspaceStatusLine = /^ {2}\S[^·]* · (?:~(?:[\\/][^·]*)?|\/[^·]*|[A-Za-z]:[\\/][^·]*)(?: · \S.*)?\s*$/u;
// empty composers expose shortcuts and optional native agent navigation
const composerShortcutsLine = /^ {2}(?:(?:← for agents · )?\? for shortcuts|← for agents)(?:\s|$)/u;
// filled idle composers suppress shortcuts but retain right-aligned warning notices
const composerWarningLine = /^ {2,}⚠ \d+(?: warnings? · \S+ to view| · \S+)?\s*$/u;
// filled working composers expose queue hints with optional native context counters
const composerQueueLine = /^ {2}(?:\S+ to queue(?: message)?(?: · Plan mode)?|Plan mode)(?:\s{2,}(?:\d+% context left|[\d.,]+[kKmMbB]? used))?\s*$/u;
// narrow panes wrap the native agent label below the workspace status
const composerAgentLabelContinuation = /^ {2}\[default\]\s*$/u;
// terminal modifier resets may clear more than one style bit
const modifierResets: Partial<Record<number, readonly number[]>> = {
  22: [1, 2], 23: [3], 24: [4, 21], 25: [5, 6], 27: [7], 28: [8], 29: [9]
};

// codex paints particles with RGB foreground/background and no modifiers; authored text retains its own style
export function withoutComposerSparkles(value: string): string {
  let rgbForeground = false;
  let rgbBackground = false;
  const modifiers = new Set<number>();
  // preserve OSC payloads while inspecting SGR changes and the eight decorative glyphs
  return value.replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|\x1b\[([0-9;:]*)m|[⠁⠂⠄⠈⠐⠠⡀⢀]/gu, (token: string, parameters: string | undefined) => {
    // normalize only rendered particles, never unstyled user-authored Braille
    if (parameters === undefined) return token.length === 1 && rgbForeground && rgbBackground && modifiers.size === 0 ? ' ' : token;
    const codes = parameters.split(';').map(Number);
    // track persistent styles across cells, rows, and combined SGR sequences
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]!;
      // clear all styles on a full terminal reset
      if (code === 0) {
        rgbForeground = false;
        rgbBackground = false;
        modifiers.clear();
      } else if (code === 38 || code === 48) {
        const mode = codes[index + 1];
        const rgb = mode === 2 && codes.length > index + 4;
        // keep foreground and background color modes independent
        if (code === 38) rgbForeground = rgb;
        else rgbBackground = rgb;
        index += mode === 2 ? 4 : mode === 5 ? 2 : 0;
      } else if (code === 39 || code >= 30 && code <= 37 || code >= 90 && code <= 97) rgbForeground = false;
      else if (code === 49 || code >= 40 && code <= 47 || code >= 100 && code <= 107) rgbBackground = false;
      else if (modifierResets[code] !== undefined) {
        // clear only the specified modifiers
        for (const modifier of modifierResets[code]) modifiers.delete(modifier);
      } else {
        modifiers.add(code);
        // unknown SGR formats remain literal until an explicit reset
        if (!(code >= 1 && code <= 9 || code === 21)) break;
      }
    }
    return token;
  });
}

/**
 * Tab is Codex's queue key.  Its completion menu owns Tab while the composer
 * ends in a token, though, so the prompt never reaches the queue.  A trailing
 * space dismisses that menu without changing the submitted prompt's meaning.
 */
export const queueReadyPrompt = (prompt: string) => /\s$/u.test(prompt) ? prompt : `${prompt} `;

// strip styling without adding semantic markup
const plainTerminalText = (value: string) => value
  .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/\r/gu, '');

// read only the bottom-most prompt or shell composer, excluding matching scrollback
function activeComposerFromCapture(value: string): string | undefined {
  const lines = plainTerminalText(withoutComposerSparkles(value)).split('\n');
  // native choice dialogs own input even when a background draft remains visible
  if (lines.some(line => /^\s*❯\s+(?:\[[ xX]\]\s*)?\d+[.)]\s/u.test(line))) return undefined;
  let finalVisibleRow = lines.length - 1;
  // locate the terminal footer row above trailing space
  while (finalVisibleRow >= 0 && !lines[finalVisibleRow]!.trim()) finalVisibleRow -= 1;
  let footerStart = finalVisibleRow;
  const auxiliary = lines[footerStart] ?? '';
  const statusEnd = composerShortcutsLine.test(auxiliary) || composerWarningLine.test(auxiliary) || composerQueueLine.test(auxiliary) ? footerStart - 1 : footerStart;
  const statusStart = composerAgentLabelContinuation.test(lines[statusEnd] ?? '') ? statusEnd - 1 : statusEnd;
  // require the native workspace and blank separator before excluding auxiliary or wrapped rows
  if (composerWorkspaceStatusLine.test(lines[statusStart] ?? '') && lines[statusStart - 1]?.trim() === '') footerStart = statusStart;
  // absent native chrome must not hide an authored shortcuts row
  if (!composerStatusLine.test(lines[footerStart] ?? '')) footerStart = lines.length;
  // inspect composer markers newest first
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^([›!])(?:\s(.*))?$/u.exec(lines[index]!);
    // skip non-composer rows
    if (match === null) continue;
    // restore the shell prefix that Codex renders as composer chrome
    const draft = [match[1] === '!' ? `!${match[2] ?? ''}` : match[2] ?? ''];
    let submitted = false;
    // collect wrapped paragraphs and blank composer rows
    for (let following = index + 1; following < lines.length; following += 1) {
      const line = lines[following]!;
      // exclude the entire native footer rather than only its last row
      if (following >= footerStart) break;
      // reject submitted prompt history followed by agent activity
      if (/^[•■─]/u.test(line)) {
        submitted = true;
        break;
      }
      draft.push(line.trim());
    }
    // inspect only a live composer
    if (submitted) continue;
    // retain visual wraps separately from authored spaces
    return draft.join('\n');
  }
  return undefined;
}

// share codex's Unicode-scalar count across native paste observers
export const codexCollapsedPasteLabel = (prompt: string): string => `[Pasted Content ${[...prompt].length} chars]`;

// bound regex compilation for visually wrapped ownership witnesses
const maxOwnershipWrapCharacters = 512;

// require complete content proof before retrying or deleting native input
export function codexOwnsDraft(capture: string, prompt: string): boolean | undefined {
  const composer = activeComposerFromCapture(capture);
  // hidden composers and native selection dialogs do not authorize input
  if (composer === undefined) return false;
  const normalizedComposer = composer.replace(/\s+/gu, ' ').trim().replace(/^!\s*/u, '!');
  const normalizedPrompt = prompt.replace(/\s+/gu, ' ').trim().replace(/^!\s*/u, '!');
  // identical-length replacements cannot be distinguished by collapsed labels
  const collapsedPaste = codexCollapsedPasteLabel(prompt);
  if (normalizedComposer === collapsedPaste || prompt.startsWith('!') && normalizedComposer === `!${collapsedPaste}`) return undefined;
  // preserve complete ordinary drafts and shell prefixes
  if (normalizedComposer === normalizedPrompt) return true;
  // reject known additions without compiling a full-prompt regex
  if (normalizedComposer.includes(collapsedPaste) || normalizedComposer.startsWith(normalizedPrompt)) return false;
  const promptCharacters = [...normalizedPrompt];
  // cropped or wrapped large drafts cannot provide bounded exact ownership proof
  if (promptCharacters.length > maxOwnershipWrapCharacters) return undefined;
  const wrappedPattern = promptCharacters.map(character => character === ' ' ? '\\s+' : character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(?: *\n *)?');
  const wrappedComposer = composer.replace(/[^\S\n]+/gu, ' ').trim().replace(/^!\s*/u, '!');
  return new RegExp(`^${wrappedPattern}$`, 'u').test(wrappedComposer);
}

// classify whether one exact Codex draft is still live after a paste or keypress
export function codexDraftState(capture: string, prompt: string): SubmissionDraftState {
  const composer = activeComposerFromCapture(capture);
  // a transition without a structurally valid composer is inconclusive
  if (composer === undefined) return 'unknown';
  const normalizedComposer = composer.replace(/\s+/gu, ' ').trim().replace(/^!\s*/u, '!');
  const normalizedPrompt = prompt.replace(/\s+/gu, ' ').trim().replace(/^!\s*/u, '!');
  // keep the visible tail on Unicode character boundaries
  const promptCharacters = [...normalizedPrompt];
  const visibleSuffix = promptCharacters.slice(-64).join('');
  // codex counts pasted Unicode scalar values rather than UTF-16 units
  const collapsedPaste = codexCollapsedPasteLabel(prompt);
  // accept Codex's exact long-paste placeholder
  if (normalizedComposer.includes(collapsedPaste)) return 'visible';
  const short = promptCharacters.length <= 64;
  // preserve the ordinary whitespace-normalized match
  if (short ? normalizedComposer.startsWith(normalizedPrompt) : normalizedComposer.includes(visibleSuffix)) return 'visible';
  // match literal text across visual wraps without discarding in-row spaces
  const witness = short ? normalizedPrompt : visibleSuffix;
  // escape authored punctuation and require authored whitespace
  const wrappedPattern = [...witness].map(character => character === ' ' ? '\\s+' : character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(?: *\n *)?');
  // keep short drafts anchored and long drafts tied to their exact visible tail
  const wrappedComposer = composer.replace(/[^\S\n]+/gu, ' ').trim().replace(/^!\s*/u, '!');
  return new RegExp(`${short ? '^' : ''}${wrappedPattern}`, 'u').test(wrappedComposer) ? 'visible' : 'cleared';
}

// a request failure or cancellation banner on the active (latest) turn
export function failedTurnFromCapture(capture: string): boolean {
  const latestPrompt = capture.lastIndexOf('\n› ');
  const latestTurn = latestPrompt < 0 ? capture : capture.slice(latestPrompt + 1);
  return /^■ (?:Request failed|Cancelled)\b/mu.test(latestTurn);
}

/**
 * `capture-pane -e` preserves the SGR codes tmux uses for its rendered
 * snapshot.  Keep those color/style codes, but discard every other terminal
 * control sequence: Codex can emit alternate-screen and OSC controls while a
 * completion menu is open, and replaying those in the browser xterm changes
 * its terminal state instead of just rendering the snapshot.
 */
export function lastPromptFromHistory(value: string): string | undefined {
  const lines = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^›\s+(.+)$/u.exec(lines[index]!);
    if (!match || selectedChoice.test(lines[index]!)) continue;
    const prompt = [match[1]];
    let continuation = index + 1;
    while (continuation < lines.length && /^ {2}\S/u.test(lines[continuation]!)) prompt.push(lines[continuation++]!.trim());
    while (continuation < lines.length && lines[continuation] === '') continuation += 1;
    if (/^•\s/u.test(lines[continuation] ?? '')) return prompt.join(' ');
  }
  return undefined;
}

const assistantMarkdown = (value: string) => {
  const withoutOsc = value.replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/gu, '');
  const sgr = /\x1b\[([0-9;]*)m/gu;
  let markdown = '';
  let cursor = 0;
  let codeColor = false;
  let underlined = false;
  let codeOpen = false;
  const syncCode = () => {
    const next = codeColor && !underlined;
    if (next !== codeOpen) markdown += '`';
    codeOpen = next;
  };
  for (const match of withoutOsc.matchAll(sgr)) {
    markdown += withoutOsc.slice(cursor, match.index);
    const parameters = (match[1] || '0').split(';').map(Number);
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      if (parameter === 0) { codeColor = false; underlined = false; }
      else if (parameter === 4) underlined = true;
      else if (parameter === 24) underlined = false;
      else if (parameter === 39) codeColor = false;
      else if (parameter === 36) codeColor = true;
      else if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) codeColor = false;
      else if (parameter === 38 && parameters[index + 1] === 5 && parameters[index + 2] !== undefined) {
        codeColor = parameters[index + 2] === 6;
        index += 2;
      } else if (parameter === 38 && parameters[index + 1] === 2 && parameters[index + 4] !== undefined) {
        codeColor = false;
        index += 4;
      }
    }
    syncCode();
    cursor = (match.index ?? 0) + match[0].length;
  }
  markdown += withoutOsc.slice(cursor);
  if (codeOpen) markdown += '`';
  return markdown.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r/gu, '');
};

export type CompletedAssistantTurn = { prompt?: string; text: string; rows: number };

// find the prompt associated with one completion boundary
const promptBeforeCompletion = (lines: string[], completedAt: number): { index: number; text: string } | undefined => {
  // search backward for the nearest started prompt
  for (let index = completedAt - 1; index >= 0; index -= 1) {
    const match = /^›\s+(.+)$/u.exec(lines[index]!);
    // skip non-prompt rows
    if (match === null || selectedChoice.test(lines[index]!)) continue;
    const prompt = [match[1]!];
    let following = index + 1;
    // collect wrapped prompt rows
    while (following < completedAt && /^ {2}\S/u.test(lines[following]!)) prompt.push(lines[following++]!.trim());
    // skip prompt spacing
    while (following < completedAt && lines[following] === '') following += 1;
    // require assistant activity for this prompt
    if (!/^•(?:\s|$)/u.test(lines[following] ?? '')) continue;
    return { index, text: prompt.join(' ') };
  }
  return undefined;
};

// detect output that makes an earlier boundary stale
const hasLaterAssistantActivity = (lines: string[], completedAt: number): boolean => {
  // inspect output after the candidate boundary
  for (let index = completedAt + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    // ignore non-response status announcements
    if (/^• Model changed to\b/u.test(line)) continue;
    // reject any later assistant response activity
    if (/^•(?:\s|$)/u.test(line)) return true;
  }
  return false;
};

// capture the newest prompt-coherent completed turn
export function latestCompletedAssistantTurn(value: string): CompletedAssistantTurn | undefined {
  // preserve dim completion chrome before stripping terminal styles
  const normalized = value.replace(/^\x1b\[2m {2}(Worked for \d+[hms](?: \d+[hms])* • \d{2}:\d{2})\x1b\[0m\r?$/gmu, '─ $1');
  const lines = assistantMarkdown(normalized).split('\n');
  // inspect completion boundaries newest first
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const timed = /^─ Worked for\b/u.test(lines[index]!);
    const untimed = /^─{3,}$/u.test(lines[index]!);
    // skip ordinary output rows
    if (!timed && !untimed) continue;
    // reject an intermediate divider or older completed turn
    if (hasLaterAssistantActivity(lines, index)) return undefined;
    const prompt = promptBeforeCompletion(lines, index);
    // require a prompt for ambiguous untimed dividers
    if (untimed && prompt === undefined) continue;
    const lowerBound = prompt?.index ?? -1;
    let start = index - 1;
    // find the final assistant message within this turn
    while (start > lowerBound && !/^•(?:\s|$)/u.test(lines[start]!)) start -= 1;
    // require final message content
    if (start <= lowerBound) continue;
    let contentEnd = index;
    // trim completion spacing
    while (contentEnd > start && !lines[contentEnd - 1]!.trim()) contentEnd -= 1;
    const rendered = lines.slice(start, contentEnd);
    rendered[0] = rendered[0]!.replace(/^•\s?/u, '');
    // remove terminal indentation
    for (let row = 1; row < rendered.length; row += 1) rendered[row] = rendered[row]!.replace(/^ {2}/u, '');
    const text = rendered.join('\n').trim();
    // return the first valid newest boundary
    if (text) return { ...(prompt === undefined ? {} : { prompt: prompt.text }), text, rows: contentEnd - start };
  }
  return undefined;
}

// expose only the completed response text
export function latestCompletedAssistantMessage(value: string): { text: string; rows: number } | undefined {
  const turn = latestCompletedAssistantTurn(value);
  return turn === undefined ? undefined : { text: turn.text, rows: turn.rows };
}

// capture the complete response after the latest prompt
export function latestAgentMessageFromHistory(value: string): string | undefined {
  const lines = plainTerminalText(value).split('\n');
  let promptAt = -1;
  // find the latest prompt boundary
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // ignore selected numbered choices
    if (/^›\s+\S/u.test(lines[index]!) && !selectedChoice.test(lines[index]!)) { promptAt = index; break; }
  }
  if (promptAt < 0) return undefined;
  let start = promptAt + 1;
  // skip wrapped prompt text
  while (start < lines.length && /^ {2}\S/u.test(lines[start]!)) start += 1;
  // skip prompt separation
  while (start < lines.length && !lines[start]!.trim()) start += 1;
  let end = lines.length;
  // trim unused terminal rows
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  const message = lines.slice(start, end).join('\n').trim();
  if (!message) return undefined;
  return message.length <= 64_000 ? message : message.slice(-64_000);
}
