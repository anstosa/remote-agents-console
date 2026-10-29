import { describe, expect, it } from 'vitest';
import { claudeQuestionTextAnswer, claudeQuestionTextEntry, reportedClaudeQuestion } from '../../src/adapters/claude-questions.js';
import { inlineQuestionId } from '../../src/adapters/inline-questions.js';

type Option = { label: string; description?: string };
type Question = { question: string; header?: string; options?: Option[]; multiSelect?: boolean };

// encode a PreToolUse AskUserQuestion body the way the reporter stores it on the pane
const encode = (questions: Question[], overrides: Record<string, unknown> = {}): string =>
  Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, ...overrides })).toString('base64');

const deploy: Question = {
  question: 'Which environment should I deploy this build to, given that the staging database was refreshed this morning and production is under load?',
  header: 'Deploy target',
  options: [
    { label: 'Staging', description: 'Rehearse first' },
    { label: 'Production', description: 'Ship to live' },
    { label: 'Neither, hold the build until the smoke tests finish', description: 'Wait' },
  ],
};

// the dialog Claude draws for `deploy` at the given caret row (1-based), wide
const wideDialog = (caret = 1): string => [
  '❯ Read the file spec-single.json and call AskUserQuestion',
  '  Read 1 file (ctrl+o to expand)',
  '────────────────────────────────────────────────────────────',
  ' ☐ Deploy target',
  '',
  `│ ${deploy.question}`,
  '',
  `${caret === 1 ? '❯' : ' '} 1. Staging`,
  '     Rehearse first',
  `${caret === 2 ? '❯' : ' '} 2. Production`,
  '     Ship to live',
  '  3. Neither, hold the build until the smoke tests finish',
  '     Wait',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

describe('reportedClaudeQuestion', () => {
  it('renders a single reported question with the option labels as its choices', () => {
    // the drawn Chat about this row rides along as a last choice whose row skips the text input
    const choices = ['Staging', 'Production', 'Neither, hold the build until the smoke tests finish', 'Chat about this'];
    expect(reportedClaudeQuestion(encode([deploy]), wideDialog())).toEqual({
      id: inlineQuestionId(deploy.question, choices),
      text: deploy.question,
      choices,
      descriptions: ['Rehearse first', 'Ship to live', 'Wait', ''],
      pane: { rows: [0, 1, 2, 4] },
      source: 'structured',
    });
  });

  it('matches the same question when the pane wraps it at a narrow width', () => {
    const choices = ['Staging', 'Production', 'Neither, hold the build until the smoke tests finish'];
    const narrow = [
      '  Read 1 file (ctrl+o to expand)',
      '──────────────────────────────',
      ' ☐ Deploy target',
      '',
      '│ Which environment should I deploy this build to, given',
      '│ that the staging database was refreshed this morning and',
      '│ production is under load?',
      '',
      '❯ 1. Staging',
      '     Rehearse first',
      '  2. Production',
      '  3. Neither, hold the build until the smoke tests finish',
      '     and then ask me again later today',
      '  4. Type something.',
    ].join('\n');
    // choices come from the payload (its id is width-independent), so the wrapped
    // capture must still be recognised as the same live question
    expect(reportedClaudeQuestion(encode([deploy]), narrow)).toEqual({
      id: inlineQuestionId(deploy.question, choices), text: deploy.question, choices, descriptions: ['Rehearse first', 'Ship to live', 'Wait'], source: 'structured',
    });
  });

  it('still matches when the caret sits on another option', () => {
    const choices = ['Staging', 'Production', 'Neither, hold the build until the smoke tests finish', 'Chat about this'];
    expect(reportedClaudeQuestion(encode([deploy]), wideDialog(2))).toEqual({
      id: inlineQuestionId(deploy.question, choices), text: deploy.question, choices, descriptions: ['Rehearse first', 'Ship to live', 'Wait', ''], pane: { rows: [0, 1, 2, 4] }, source: 'structured',
    });
  });

  it('falls back to the first 48 characters when a narrow pane truncates the question', () => {
    const truncated = [
      ' ☐ Deploy target',
      '│ Which environment should I deploy this build to, gi…',
      '❯ 1. Staging',
      '  2. Production',
    ].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), truncated)?.text).toBe(deploy.question);
  });

  it('returns undefined once the dialog is answered (text on screen, no numbered row)', () => {
    const answered = [
      '● User answered Claude\'s questions:',
      `  ⎿  · ${deploy.question} → Production`,
      '',
      '● done',
      '❯ ',
    ].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), answered)).toBeUndefined();
  });

  it('returns undefined after an Esc cancel (the declined summary repeats the text)', () => {
    const declined = [
      '● User declined to answer questions',
      `  ⎿  · ${deploy.question} (Staging / Production / Neither...)`,
      '',
      '❯ ',
    ].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), declined)).toBeUndefined();
  });

  it('only considers the last 80 lines, so a dialog scrolled out of the window does not match', () => {
    const scrolledOut = [wideDialog(), ...Array.from({ length: 90 }, () => 'idle output line')].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), scrolledOut)).toBeUndefined();
  });

  it('requires the numbered row even when the question text is present', () => {
    const noRow = [' ☐ Deploy target', `│ ${deploy.question}`, '  (no options drawn)'].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), noRow)).toBeUndefined();
  });

  it('skips a multiSelect question even when its rows would otherwise match', () => {
    const multi: Question = { question: 'Which checks should run?', options: [{ label: 'Lint' }, { label: 'Unit tests' }], multiSelect: true };
    // a row-check-passing capture (no checkbox glyph) so the multiSelect guard, not
    // the row miss, is the sole reason this renders nothing
    const dialog = ['Which checks should run?', '❯ 1. Lint', '  2. Unit tests'].join('\n');
    expect(reportedClaudeQuestion(encode([multi]), dialog)).toBeUndefined();
  });

  it('skips an option-less text-kind question', () => {
    const text: Question = { question: 'What should this be called?' };
    const dialog = ['What should this be called?', '❯ 1. Type something.'].join('\n');
    expect(reportedClaudeQuestion(encode([text]), dialog)).toBeUndefined();
  });

  // a two-question call and the tab it draws for whichever question is active
  const region: Question = { question: 'Which region should host the deploy?', header: 'Region', options: [{ label: 'us-east' }, { label: 'eu-west' }] };
  const rollout: Question = { question: 'How should the rollout proceed?', header: 'Rollout', options: [{ label: 'Canary' }, { label: 'All at once' }] };
  const tab = (active: Question): string => [
    '────────────────────────────────────────',
    '←  ☐ Region  ☐ Rollout  ✔ Submit  →',
    '',
    active.question,
    '',
    `❯ 1. ${active.options![0]!.label}`,
    `  2. ${active.options![1]!.label}`,
    '  3. Type something.',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');

  it('renders the question currently on screen from a multi-question call', () => {
    const choices = ['us-east', 'eu-west'];
    expect(reportedClaudeQuestion(encode([region, rollout]), tab(region))).toEqual({
      id: inlineQuestionId(region.question, choices), text: region.question, choices, source: 'structured',
    });
  });

  it('advances to the second question once the first tab has been answered', () => {
    // only the active tab's text and rows are drawn, so a capture showing the
    // second question renders it even though the first is earlier in the payload
    const choices = ['Canary', 'All at once'];
    expect(reportedClaudeQuestion(encode([region, rollout]), tab(rollout))).toEqual({
      id: inlineQuestionId(rollout.question, choices), text: rollout.question, choices, source: 'structured',
    });
  });

  it('renders Submit answers / Cancel at the review step', () => {
    // the review page repeats every question's text, so it is matched by its own
    // literal before any question text; Submit is drawn first so selectOption(0) submits
    const review = [
      '←  ☒ Region  ☒ Rollout  ✔ Submit  →',
      '',
      'Review your answers',
      '',
      ' ● Which region should host the deploy?',
      '   → us-east',
      ' ● How should the rollout proceed?',
      '   → All at once',
      '',
      'Ready to submit your answers?',
      '',
      '❯ 1. Submit answers',
      '  2. Cancel',
    ].join('\n');
    const choices = ['Submit answers', 'Cancel'];
    expect(reportedClaudeQuestion(encode([region, rollout]), review)).toEqual({
      id: inlineQuestionId('Ready to submit your answers?', choices),
      text: 'Ready to submit your answers?', choices, source: 'structured',
    });
  });

  it('renders nothing when two questions share the same text and first option', () => {
    // an on-screen dialog matches both tabs, so the console cannot tell which is live
    const a: Question = { question: 'Which should I pick?', options: [{ label: 'Left' }, { label: 'Right' }] };
    const b: Question = { question: 'Which should I pick?', options: [{ label: 'Left' }, { label: 'Up' }] };
    const dialog = ['Which should I pick?', '❯ 1. Left', '  2. Right'].join('\n');
    expect(reportedClaudeQuestion(encode([a, b]), dialog)).toBeUndefined();
  });

  it('renders nothing when none of several questions is on screen', () => {
    // the answered transcript repeats each question's text but draws no numbered row
    const answered = [
      "● User answered Claude's questions:",
      '  ⎿  · Which region should host the deploy? → us-east',
      '     · How should the rollout proceed? → All at once',
    ].join('\n');
    expect(reportedClaudeQuestion(encode([region, rollout]), answered)).toBeUndefined();
  });

  it('does not treat the review step of a single-question call as a submit prompt', () => {
    // a lone question never shows the multi-question review page; the submit-literal
    // shortcut is gated on two or more questions so a stray match cannot fire
    const review = ['Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel'].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), review)).toBeUndefined();
  });

  it('rejects fewer than two or more than sixteen options', () => {
    const one: Question = { question: 'Pick?', options: [{ label: 'Only' }] };
    const many: Question = { question: 'Pick?', options: Array.from({ length: 17 }, (_, i) => ({ label: `Option ${i}` })) };
    expect(reportedClaudeQuestion(encode([one]), 'Pick?\n❯ 1. Only')).toBeUndefined();
    expect(reportedClaudeQuestion(encode([many]), 'Pick?\n❯ 1. Option 0')).toBeUndefined();
  });

  it('rejects an option whose label is missing or not a string', () => {
    // three options, one label-less: two valid labels remain (so the < 2 guard does
    // not fire), and the completeness check is the sole reason this is rejected
    const holed = { question: 'Pick?', options: [{ label: 'Staging' }, { description: 'no label' }, { label: 'Production' }] } as unknown as Question;
    expect(reportedClaudeQuestion(encode([holed]), 'Pick?\n❯ 1. Staging\n  2. Production')).toBeUndefined();
  });

  it('rejects a non-PreToolUse or non-AskUserQuestion payload', () => {
    expect(reportedClaudeQuestion(encode([deploy], { hook_event_name: 'PostToolUse' }), wideDialog())).toBeUndefined();
    expect(reportedClaudeQuestion(encode([deploy], { tool_name: 'Bash' }), wideDialog())).toBeUndefined();
  });

  it('rejects a payload that is not valid base64 JSON', () => {
    expect(reportedClaudeQuestion('not+valid+base64+json', wideDialog())).toBeUndefined();
    expect(reportedClaudeQuestion(Buffer.from('not json').toString('base64'), wideDialog())).toBeUndefined();
    expect(reportedClaudeQuestion(Buffer.from('[]').toString('base64'), wideDialog())).toBeUndefined();
  });
});

describe('claudeQuestionTextEntry', () => {
  it('moves from option 1 onto the Type something row below the options', () => {
    const question = reportedClaudeQuestion(encode([deploy]), wideDialog())!;
    expect(claudeQuestionTextEntry(question, wideDialog())).toEqual(['Down', 'Down', 'Down']);
  });

  it('refuses when the Type something row is not drawn at the expected number', () => {
    // the review page offers no free-text row; a text answer must not land on an option
    const review = { id: 'review', text: 'Ready to submit your answers?', choices: ['Submit answers', 'Cancel'], source: 'structured' as const };
    expect(claudeQuestionTextEntry(review, 'Ready to submit your answers?\n❯ 1. Submit answers\n  2. Cancel')).toBeUndefined();
    const question = reportedClaudeQuestion(encode([deploy]), wideDialog())!;
    expect(claudeQuestionTextEntry(question, wideDialog().replace('4. Type something.', '4. Something else'))).toBeUndefined();
  });

  it('still finds the Type something row when Chat about this is offered as a choice', () => {
    // three options plus Chat: the text input is row 4, three Downs from option 1
    const question = reportedClaudeQuestion(encode([deploy]), wideDialog())!;
    expect(question.choices).toHaveLength(4);
    expect(claudeQuestionTextEntry(question, wideDialog())).toEqual(['Down', 'Down', 'Down']);
    const withoutChat = reportedClaudeQuestion(encode([deploy]), wideDialog().replace('5. Chat about this', ''))!;
    expect(withoutChat.choices).toHaveLength(3);
    expect(withoutChat.rows).toBeUndefined();
    expect(claudeQuestionTextEntry(withoutChat, wideDialog())).toEqual(['Down', 'Down', 'Down']);
  });

  it('refuses a parsed question', () => {
    const question = { ...reportedClaudeQuestion(encode([deploy]), wideDialog())!, source: 'parsed' as const };
    expect(claudeQuestionTextEntry(question, wideDialog())).toBeUndefined();
  });
});

describe('claudeQuestionTextAnswer', () => {
  it('joins lines with a space because the Type something input drops line breaks', () => {
    expect(claudeQuestionTextAnswer('  first line\n\n  second line \n')).toBe('first line second line');
    expect(claudeQuestionTextAnswer('one line')).toBe('one line');
  });
});
