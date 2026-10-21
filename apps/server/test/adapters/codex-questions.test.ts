import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseChoiceQuestion, queuedCodexQuestion } from '../../src/adapters/codex-questions.js';
import { codexSubmission, parseCodexQuestion } from '../../src/adapters/codex-tui.js';
import { inlineQuestionId } from '../../src/adapters/inline-questions.js';

// render a menu with a movable highlight and an independent current value
const menu = (selected: number) => [
  'Select Model and Effort',
  // keep the current-value marker distinct from the keyboard cursor
  ...['First model (current)', 'Second model', 'Third model'].map((label, index) => `${index === selected ? '› ' : '  '}${index + 1}. ${label}`),
  'Press enter to confirm or esc to go back'
].join('\n');

// preserve complete native questions instead of just the final terminal row
describe('Codex question content', () => {
  const question = 'The editable surface does not exist at the merge base, so the original benchmark is impossible. May I use the first editor commit as the baseline, clearly labeled in the review? I’ll continue the remaining work meanwhile.';
  const choices = ['Use first editor commit as baseline', 'Keep strict merge-base requirement; stop before review update', 'Other'];

  // reconstruct the screenshot shape without including progress or queue chrome
  it('retains every wrapped question line and paragraph', () => {
    const capture = [
      '• Working (57m 15s · esc to interrupt)',
      '• Queued follow-up inputs',
      '',
      '  The editable surface does not exist at the merge base, so the original benchmark is',
      '  impossible. May I use the first editor commit as the baseline, clearly labeled in the review?',
      '',
      '  I’ll continue the remaining work meanwhile.',
      '',
      '› 1. Use first editor commit as baseline',
      '  2. Keep strict merge-base requirement; stop before review update',
      '  3. Other',
      '',
      'enter submit   ctrl+] skip   shift+→ main prompt'
    ].join('\n');
    expect(parseCodexQuestion(capture)).toEqual({ text: question, choices, selectedIndex: 0, id: inlineQuestionId(question, choices), source: 'parsed' });
  });

  // width and highlight changes must not lose answer text or change its identity
  it('preserves wrapped labels and descriptions at different pane widths', () => {
    const wide = 'Which approach should I take?\n› 1. Small change Keep the existing API and add focused tests.\n  2. Broad change Replace the API and update every caller.\n  3. Other\nenter submit   ctrl+] skip   shift+→ main prompt';
    const narrow = [
      'Which approach should',
      'I take?',
      '',
      '  1. Small change',
      '     Keep the existing API',
      '     and add focused tests.',
      '› 2. Broad change Replace',
      '     the API and update',
      '     every caller.',
      '  3. Other',
      '',
      'enter submit   ctrl+] skip',
      'shift+→ main prompt'
    ].join('\n');
    const expected = { text: 'Which approach should I take?', choices: ['Small change Keep the existing API and add focused tests.', 'Broad change Replace the API and update every caller.', 'Other'], source: 'parsed' };
    expect(parseCodexQuestion(wide)).toMatchObject({ ...expected, selectedIndex: 0 });
    expect(parseCodexQuestion(narrow)).toEqual({ ...expected, selectedIndex: 1, id: parseCodexQuestion(wide)!.id });
  });

  // native hints and later prose are not part of the last answer
  it.each(['Press enter to confirm or esc to go back', 'tab to add notes | enter to submit answer | esc to interrupt', 'enter submit   ctrl+] skip   shift+→ main prompt'])('excludes trailing content: %s', footer => {
    expect(parseChoiceQuestion(`Choose a target\n› 1. First\n     Complete first description.\n  2. Second\n     Complete second description.\n\n  ${footer}`)).toMatchObject({ text: 'Choose a target', choices: ['First Complete first description.', 'Second Complete second description.'] });
  });

  // retain long native questions beyond the old four-row context window
  it('keeps long blocking questions and excludes the question counter', () => {
    const capture = 'Earlier agent output\n\nQuestion 2 of 3\n\nThe first sentence\ncontinues over several\nterminal rows because\nthe pane is narrow.\nWhich approach should\nI take for this\nchange?\n\n› 1. Small\n  2. Broad\ntab to add notes | enter to submit answer | esc to interrupt';
    expect(parseCodexQuestion(capture)).toMatchObject({ text: 'The first sentence continues over several terminal rows because the pane is narrow. Which approach should I take for this change?', choices: ['Small', 'Broad'] });
  });

  // current native counters use a slash and an unanswered count
  it.each(['Question 1/2 (2 unanswered)', 'Question 1/2 (1 unanswered)'])('excludes the native counter %s', header => {
    const capture = `${header}\nChoose an option.\n\n  1. First\n› 2. Second\n\ntab to add notes | enter to submit answer\n←/→ to navigate questions | esc to interrupt`;
    expect(parseCodexQuestion(capture)).toEqual({ text: 'Choose an option.', choices: ['First', 'Second'], selectedIndex: 1, source: 'parsed', id: inlineQuestionId('Choose an option.', ['First', 'Second']) });
  });

  // native labels and descriptions wrap independently in aligned terminal columns
  it('reads wrapped label and description columns in their original order', () => {
    const capture = [
      '  Question 1/1 (1 unanswered)',
      '  Choose an option.',
      '',
      '  › 1. Keep the complete      Preserve the existing',
      '       status model           statuses and include',
      '                              debugging context.',
      '    2. Simplify labels        Use fewer states.',
      '',
      '  tab to add notes | enter to submit answer | esc to interrupt'
    ].join('\n');
    const choices = ['Keep the complete status model Preserve the existing statuses and include debugging context.', 'Simplify labels Use fewer states.'];
    expect(parseCodexQuestion(capture)).toEqual({ text: 'Choose an option.', choices, selectedIndex: 0, source: 'parsed', id: inlineQuestionId('Choose an option.', choices) });
    const wide = 'Choose an option.\n› 1. Keep the complete status model  Preserve the existing statuses and include debugging context.\n  2. Simplify labels                 Use fewer states.\ntab to add notes | enter to submit answer | esc to interrupt';
    expect(parseCodexQuestion(wide)).toEqual(parseCodexQuestion(capture));
  });

  // descriptions can exceed the old eight-row continuation and forty-row search limits
  it('retains every option in a deeply wrapped menu', () => {
    const description = Array.from({ length: 20 }, (_, index) => `description part ${index + 1}`);
    const capture = ['Choose an approach', '', '› 1. First', ...description.map(line => `     ${line}`), '  2. Second', ...description.map(line => `     ${line}`), '  3. Other', 'enter submit   ctrl+] skip   shift+→ main prompt'].join('\n');
    expect(parseCodexQuestion(capture)).toMatchObject({ text: 'Choose an approach', choices: [`First ${description.join(' ')}`, `Second ${description.join(' ')}`, 'Other'], selectedIndex: 0 });
  });

  // expanding a long active menu must not revive old menus from scrollback
  it('ignores an old menu followed by newer agent output', () => {
    const laterOutput = Array.from({ length: 45 }, (_, index) => `Later output ${index + 1}`);
    expect(parseChoiceQuestion(['Choose a target', '› 1. First', '  2. Second', '', ...laterOutput].join('\n'))).toBeUndefined();
  });

  // rejected large lists must not prevent a later live menu from being discovered
  it('skips a long rejected block before the current menu', () => {
    const staleChoices = Array.from({ length: 2000 }, (_, index) => `${index + 1}. Earlier item`);
    const capture = ['Which earlier item?', ...staleChoices, '• Working', '', 'Choose the current target', '› 1. First', '  2. Second'].join('\n');
    expect(parseChoiceQuestion(capture)).toMatchObject({ text: 'Choose the current target', choices: ['First', 'Second'], selectedIndex: 0 });
  });

  // later prose, progress, and drafts cannot own a previous menu's answer buttons
  it.each(['Unrelated subsequent output', '     Indented subsequent output', '• Working (2s · esc to interrupt)', '› A new prompt'])('rejects a stale menu followed by %s', laterOutput => {
    expect(parseChoiceQuestion(`Choose a target\n› 1. First\n  2. Second\n\n${laterOutput}`)).toBeUndefined();
    expect(parseChoiceQuestion(`• Queued follow-up inputs\nChoose a target\n› 1. First\n  2. Second\n\nenter submit   ctrl+] skip   shift+→ main prompt\n${laterOutput}`)).toBeUndefined();
  });
});

// match only Codex's collapsed native question entry point
describe('queued Codex questions', () => {
  // retain exact current-cli footer captures, including narrow wrapped editor hints
  const currentCaptures = JSON.parse(readFileSync(new URL('../fixtures/codex/queued-questions.json', import.meta.url), 'utf8')) as Array<{ name: string; lines: string[]; queued: { key?: string } }>;
  // exercise the real renderer rather than only hand-authored shortcut samples
  it.each(currentCaptures)('recognizes $name', ({ lines, queued }) => {
    expect(queuedCodexQuestion(lines.join('\n'))).toEqual(queued);
    // actual narrow captures must retain the same complete question as wide captures
    if (queued.key === undefined) expect(parseCodexQuestion(lines.join('\n'))).toMatchObject({ text: 'Proceed with the exact follow-up reproduction?', choices: ['Yes (Recommended)', 'No', 'Other'] });
  });
  const banner = '• Queued follow-up inputs\n  ? 2 questions · 15s\n    alt + ↑ to answer';
  // honor the shortcut actually advertised by the current keymap
  it.each([['alt + ↑', 'M-Up'], ['⌥ + ↑', 'M-Up'], ['shift + ←', 'S-Left'], ['alt+↑', 'M-Up'], ['⌥+↑', 'M-Up'], ['shift+←', 'S-Left']])('opens with %s', (hint, key) => {
    const capture = banner.replace('alt + ↑', hint) + '\n\n› Ask Codex to do anything\n  gpt-6-astra xhigh · /repo · main';
    expect(queuedCodexQuestion(capture)).toEqual({ key });
  });
  // tolerate styled singular summaries without a countdown
  it('reads styled singular footers', () => {
    expect(queuedCodexQuestion('\x1b[2m• Queued follow-up inputs\n  ? 1 question\n    alt + ↑ to answer\x1b[0m')).toEqual({ key: 'M-Up' });
  });
  // preserve the default composer help footer
  it('allows the shortcut and context footer', () => {
    expect(queuedCodexQuestion(`${banner}\n› Ask Codex to do anything\n? for shortcuts            100% context left`)).toEqual({ key: 'M-Up' });
  });
  // keep expanded native questions distinct from an empty queue
  it('recognizes an expanded editor without an opening key', () => {
    expect(queuedCodexQuestion('• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip   shift + → main prompt')).toEqual({});
    expect(queuedCodexQuestion('• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip\nshift + → main prompt')).toEqual({});
  });
  // never treat messages, old output, open dialogs, or unknown bindings as an opener
  it.each([
    '• Queued follow-up inputs\n  ↳ follow up\n  alt + ↑ edit last queued message',
    'Here is a queued question: ? 2 questions\nalt + ↑ to answer',
    banner.replace('2 questions', '0 questions'),
    banner.replace('alt + ↑', 'ctrl + g'),
    `${banner}\n› next prompt\n• Working`,
    `${banner}\n› next prompt\n• Working (0s • esc to interrupt) · Running hook`,
    `${banner}\nChoose a model\n› 1. First\n  2. Second`,
    `${banner}\n• Queued follow-up inputs\n  ↳ ordinary message`
  ])('ignores non-live or unsupported footer %s', capture => {
    expect(queuedCodexQuestion(capture)).toBeUndefined();
  });
});

// lock cursor-aware parsing without changing question identity
describe('Codex menu highlight', () => {
  // keep the displayed cursor position separate from the choice labels
  it('retains the highlighted choice and keeps the id stable when it moves', () => {
    const first = parseChoiceQuestion(menu(0));
    const second = parseChoiceQuestion(menu(1));
    expect(first).toMatchObject({ selectedIndex: 0 });
    expect(second).toMatchObject({ selectedIndex: 1, choices: ['First model (current)', 'Second model', 'Third model'] });
    expect(second?.id).toBe(first?.id);
  });

  // parse colored reasoning menus without treating a checked box as the cursor
  it('uses the caret rather than a checked option', () => {
    const question = parseChoiceQuestion('Choose reasoning\n  [x] 1. Low\n\x1b[32m❯ [ ] 2. High\x1b[0m\n  [ ] 3. Extra high');
    expect(question).toMatchObject({ selectedIndex: 1, choices: ['Low', 'High', 'Extra high'] });
  });

  // preserve the existing fallback for noninteractive numbered lists
  it('leaves the cursor unspecified when there is no highlight', () => {
    expect(parseChoiceQuestion('Which environment?\n1. Staging\n2. Production')).not.toHaveProperty('selectedIndex');
  });

  // quoted or malformed lists do not identify a unique keyboard cursor
  it.each(['>', '›', '❯'])('ignores ambiguous %s markers on multiple rows', marker => {
    const question = parseChoiceQuestion(`Which environment?\n${marker} 1. Staging\n${marker} 2. Production\n${marker} 3. Cancel`);
    expect(question).toMatchObject({ choices: ['Staging', 'Production', 'Cancel'] });
    expect(question).not.toHaveProperty('selectedIndex');
  });
});

// exercise the shared menu once; adapter contracts cover Codex and OMX wiring
describe('Codex menu navigation', () => {
  // navigate from every highlighted row to every requested row
  it.each([
    { selected: 1, index: 0, keys: ['Up', 'Enter'] },
    { selected: 1, index: 1, keys: ['Enter'] },
    { selected: 1, index: 2, keys: ['Down', 'Enter'] },
    { selected: 2, index: 0, keys: ['Up', 'Up', 'Enter'] },
    { selected: 0, index: 2, keys: ['Down', 'Down', 'Enter'] }
  ])('selects index $index from highlighted index $selected', ({ selected, index, keys }) => {
    const question = parseCodexQuestion(menu(selected));
    expect(question).toMatchObject({ selectedIndex: selected });
    expect(codexSubmission.selectOption(index, question?.selectedIndex)).toEqual(keys);
  });
});
