import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexDraftState, codexGoalResumeAvailable, codexOwnsDraft } from '../../src/adapters/codex-turns.js';
import { codexNewConversation } from '../../src/adapters/codex-new-conversation.js';
import { codexComposerWithAuxiliary, codexComposerWithFooter, codexGoalFooters } from '../helpers/codex-composer.js';

// reproduce the single-dot animation that Codex draws over blank composer cells
const sparkleDots = [...'⠁⠂⠄⠈⠐⠠⡀⢀'];
// reproduce per-cell truecolor decoration over the composer background
const animated = (value: string) => `\x1b[48;2;30;30;30m${value.replace(/[⠁⠂⠄⠈⠐⠠⡀⢀]/gu, dot => `\x1b[38;2;20;20;20m${dot}\x1b[39m`)}\x1b[49m`;
// include animated padding and the real status footer
const capture = (composer: string) => [
  animated('    ⠈        ⡀'),
  composer,
  animated('       ⢀⠐'),
  '  gpt-6-astra xhigh fast · ~/repo · main                  Goal paused (/goal resume)'
].join('\n');
// reuse captured wide and narrow native footer layouts
const capturedFooters = JSON.parse(readFileSync(new URL('../fixtures/codex/queued-questions.json', import.meta.url), 'utf8')) as { name: string; lines: string[] }[];
// retain the actual failed filled-composer frame rather than translating a placeholder
const failedFilledComposer = JSON.parse(readFileSync(new URL('../fixtures/codex/filled-composer-warning.json', import.meta.url), 'utf8')) as { prompt: string; lines: string[] };

// verify the resume command follows native footer layouts, not conversation text
describe('Codex goal resume badge', () => {
  // exercise a wrapped native agent label and a plain footer
  it.each(codexGoalFooters)('reads the live goal state from %s', footer => {
    expect(codexGoalResumeAvailable(codexComposerWithAuxiliary('', footer, true))).toBe(footer.includes('/goal resume'));
  });

  // support both wide inline badges and the auxiliary row without workspace labels
  it('recognizes paused chrome with and without a workspace segment', () => {
    expect(codexGoalResumeAvailable(capture('› Ask Codex to do anything'))).toBe(true);
    expect(codexGoalResumeAvailable('› Ask Codex to do anything\n\n  ? for shortcuts     Goal paused (/goal resume)\n')).toBe(true);
  });

  // a wrapped draft can sit above a lone goal footer when the workspace row is absent
  it('finds a standalone pause badge beneath a wrapped composer', () => {
    expect(codexGoalResumeAvailable('› first line\n  wrapped continuation\n\n        Goal paused (/goal resume)\n')).toBe(true);
  });

  // native compact widths can keep just a one-column gap between footer groups
  it('recognizes a compact pause badge sharing the auxiliary row', () => {
    expect(codexGoalResumeAvailable(codexComposerWithAuxiliary('', '  ? for shortcuts Goal paused (/goal resume) · IDE'))).toBe(true);
  });

  // do not mistake authored text or scrolled-off footer chrome for the current status
  it.each([
    '• The banner reads Goal paused (/goal resume)',
    '  GPT-6.2-Sol high · ~/repo · main     Goal paused (/goal resume)',
    '› Goal paused (/goal resume)',
    '› A long draft\n  Goal paused (/goal resume)',
    '› First draft\n\n  Goal paused (/goal resume) and more text',
    `${capture('› Previous composer')}\n• Working\n${codexComposerWithFooter('')}`
  ])('ignores a non-footer resume mention in %j', pane => {
    expect(codexGoalResumeAvailable(pane)).toBe(false);
  });
});

// keep composer acknowledgements independent of decorative animation
describe('Codex draft observation', () => {
  // codex can render its warning key without a workspace status row
  it.each(['100% context left · ⚠ 2 warnings · \x1b[1mf2\x1b[0m to view', '100% context left · ⚠ 2 · \x1b[1mf2\x1b[0m'])('owns a draft above standalone warning chrome %j', warning => {
    const prompt = 'check the standalone footer';
    const pane = `\x1b[1m›\x1b[0m ${prompt}\n\n                     ${warning}`;
    expect(codexDraftState(pane, prompt)).toBe('visible');
    expect(codexOwnsDraft(pane, prompt)).toBe(true);
    expect(codexOwnsDraft(pane.replace(prompt, `${prompt} plus edits`), prompt)).toBe(false);
  });

  // the native theme paints the bold warning shortcut and its suffix in different colors
  it('owns /clear above a colored standalone warning footer', () => {
    const warning = '  100% context left · ⚠ \x1b[38;2;196;167;103m3 warnings\x1b[38;2;135;140;164m · \x1b[1m\x1b[38;2;205;214;244mf2\x1b[0m\x1b[38;2;135;140;164m to view\x1b[39m';
    const pane = `› /clear\n\n${warning}`;
    expect(codexDraftState(pane, '/clear ')).toBe('visible');
    expect(codexOwnsDraft(pane, '/clear ')).toBe(true);
    expect(codexOwnsDraft(pane.replace('/clear', '/clear plus edits'), '/clear ')).toBe(false);
  });

  // matching plain text and adjacent styled text are insufficient to hide an authored line
  it.each([
    '\n  100% context left · ⚠ 2 warnings · f2 to view',
    '                     100% context left · ⚠ 2 warnings · \x1b[1mf2\x1b[0m to view'
  ])('preserves text resembling standalone warning chrome %j', continuation => {
    expect(codexOwnsDraft(`› original draft\n${continuation}`, 'original draft')).toBe(false);
  });

  // native magenta identifies a lone goal footer without trusting lookalike draft text
  it('owns a wrapped draft above styled standalone goal chrome', () => {
    const draft = '› first line\n  wrapped continuation';
    const prompt = 'first line wrapped continuation';
    const footer = '        \x1b[38;5;5mGoal paused (/goal resume)\x1b[0m';
    const pane = `${draft}\n\n${footer}`;
    expect(codexDraftState(pane, prompt)).toBe('visible');
    expect(codexOwnsDraft(pane, prompt)).toBe(true);
    expect(codexOwnsDraft(pane.replace('wrapped continuation', 'wrapped continuation plus edits'), prompt)).toBe(false);
    expect(codexOwnsDraft(`${draft}\n\n  Goal paused (/goal resume) · IDE`, prompt)).toBe(false);
  });

  // goal badges remain native chrome even while the draft hides shortcut hints
  it.each(codexGoalFooters)('owns a draft above the goal footer %s', auxiliary => {
    // cover wide footers and narrow wrapped agent labels
    for (const wrapped of [false, true]) {
      const pane = codexComposerWithAuxiliary('owned draft', auxiliary, wrapped);
      expect(codexDraftState(pane, 'owned draft ')).toBe('visible');
      expect(codexOwnsDraft(pane, 'owned draft ')).toBe(true);
      expect(codexOwnsDraft(pane.replace('owned draft', 'owned draft plus edits'), 'owned draft ')).toBe(false);
    }
  });

  // goal-like authored text cannot hide arbitrary operator additions
  it.each([
    '  Goal stalled (/goal resume) plus operator edits',
    '  Pursuing goal (3m 08s) plus operator edits'
  ])('retains non-native auxiliary text %s', auxiliary => {
    expect(codexOwnsDraft(codexComposerWithAuxiliary('owned draft', auxiliary), 'owned draft ')).toBe(false);
  });

  // only the bottom anchored footer may be removed from authored composer content
  it('preserves goal-shaped composer paragraphs above a separate native footer', () => {
    const authored = 'owned draft\n\n  GPT-6.2-Sol · ~/repo · main\n  Goal stalled (/goal resume)';
    const pane = codexComposerWithAuxiliary(authored, codexGoalFooters[0]);
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(false);
    expect(codexOwnsDraft(pane, authored)).toBe(true);
    expect(codexOwnsDraft('› owned draft\n  GPT-6.2-Sol · ~/repo · main\n  Goal stalled (/goal resume)', 'owned draft ')).toBe(false);
  });

  // goal recognition cannot turn a same-length hidden paste into exact content proof
  it('keeps collapsed paste ownership inconclusive above goal chrome', () => {
    const pane = codexComposerWithAuxiliary('[Pasted Content 81 chars]', codexGoalFooters[0]);
    expect(codexDraftState(pane, `${'😀'.repeat(80)} `)).toBe('visible');
    expect(codexOwnsDraft(pane, `${'😀'.repeat(80)} `)).toBeUndefined();
    expect(codexOwnsDraft(pane, `${'😎'.repeat(80)} `)).toBeUndefined();
  });

  // the real filled composer suppresses shortcuts without removing its warning row
  it('owns the exact failed native draft with its prepared trailing space', () => {
    const pane = failedFilledComposer.lines.join('\n');
    const prompt = `${failedFilledComposer.prompt} `;
    expect(codexDraftState(pane, prompt)).toBe('visible');
    expect(codexOwnsDraft(pane, prompt)).toBe(true);
    expect(codexOwnsDraft(pane.replace(failedFilledComposer.prompt, `${failedFilledComposer.prompt} operator edit`), prompt)).toBe(false);
  });

  // native auxiliary rows change with width, remapped keys and task state
  it.each([
    '                             ⚠ 1 warning · f2 to view',
    '                             ⚠ 2 warnings · f4 to view',
    '                  ⚠ 2 warnings · /warnings to view',
    '             ⚠ 2 · f2',
    '       ⚠ 2',
    '  98% context left · ⚠ 3 warnings · f2 to view',
    '  tab to queue message  ⚠ 3 warnings · f2 to view',
    '  tab to queue message',
    '  tab to queue',
    '  tab to queue message · Plan mode',
    '  tab to queue message                         98% context left',
    '  tab to queue                192K used',
    '  Plan mode',
    '  ← for agents · ? for shortcuts',
    '  ← for agents'
  ])('excludes the native auxiliary row %s', auxiliary => {
    const pane = ['› owned draft', '', '  GPT-6.1-Sol xhigh fast · ~/repo · Main [default]', auxiliary].join('\n');
    expect(codexDraftState(pane, 'owned draft ')).toBe('visible');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(true);
    expect(codexOwnsDraft(pane.replace('owned draft', 'owned draft plus edits'), 'owned draft ')).toBe(false);
  });

  // narrow weather and ferry panes wrap the native agent label below the workspace
  it.each([
    '  ← for agents · ? for shortcuts  ⚠ 2 warnings · f2 to view',
    '                           ⚠ 2 warnings · f2 to view',
    '  tab to queue message',
    ''
  ])('owns a draft beneath a wrapped agent label and auxiliary row %s', auxiliary => {
    const pane = ['› owned draft', '', '  GPT-6.1-Sol xhigh Fast · ~/ferry.fyi · production · Main', '  [default]', auxiliary].join('\n');
    expect(codexDraftState(pane, 'owned draft ')).toBe('visible');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(true);
    expect(codexOwnsDraft(pane.replace('owned draft', 'owned draft plus edits'), 'owned draft ')).toBe(false);
    expect(codexDraftState(pane, '[default]')).toBe('cleared');
  });

  // arbitrary authored continuations and missing separators must retain exact ownership checks
  it.each([
    '› owned draft\n\n  GPT-6.1-Sol xhigh Fast · ~/ferry.fyi · production · Main\n  operator text\n  ? for shortcuts',
    '› owned draft\n  GPT-6.1-Sol xhigh Fast · ~/ferry.fyi · production · Main\n  [default]\n  ? for shortcuts'
  ])('preserves footer-shaped operator additions in %s', pane => {
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(false);
  });

  // workspace-shaped authored text must not hide arbitrary operator additions
  it('preserves an authored status row followed by non-native text', () => {
    const prompt = 'first line\n\nGPT-6.1-Sol · ~/repo · main\noperator text';
    const pane = '› first line\n\n  GPT-6.1-Sol · ~/repo · main\n  operator text';
    expect(codexOwnsDraft(pane, 'first line')).toBe(false);
    expect(codexOwnsDraft(pane, prompt)).toBe(true);
    const editedQueueHint = pane.replace('operator text', 'tab to queue message plus operator edits');
    expect(codexOwnsDraft(editedQueueHint, 'first line')).toBe(false);
  });

  // native chrome must not look like operator edits to a freshly pasted prompt
  it.each([true, false])('owns the weather draft beneath a two-row footer with warnings=%s', warnings => {
    const prompt = 'Show the icons for humidity, air quality, pressure, and UV in gold when adjustment is on too';
    const pane = codexComposerWithFooter(prompt, warnings);
    expect(codexDraftState(pane, `${prompt} `)).toBe('visible');
    expect(codexOwnsDraft(pane, `${prompt} `)).toBe(true);
    expect(codexDraftState(pane, 'GPT-6.1-Sol')).toBe('cleared');
    expect(codexDraftState(pane, '? for shortcuts')).toBe('cleared');
    expect(codexOwnsDraft(codexComposerWithFooter(`${prompt} plus operator edits`, warnings), `${prompt} `)).toBe(false);
  });

  // native cwd displays vary with platform and home-directory shortening
  it.each(['~', '~/repo', '/', '/repo', 'C:\\repo'])('recognizes a two-row footer displaying %s', workspace => {
    const pane = ['› owned draft', '', `  gpt-6.1-sol xhigh · ${workspace} · main`, '  ? for shortcuts'].join('\n');
    expect(codexOwnsDraft(pane, 'owned draft')).toBe(true);
  });

  // narrow panes omit the optional branch or conversation segment
  it.each(capturedFooters.filter(frame => frame.name.includes(' hold ')))('owns a draft beneath the captured $name footer', frame => {
    const pane = frame.lines.join('\n').replace('Ask Codex to do anything', 'owned draft');
    expect(codexOwnsDraft(pane, 'owned draft')).toBe(true);
  });

  // trim only terminal chrome rather than every footer-shaped authored row
  it('preserves authored middle-dot and shortcuts rows above the native footer', () => {
    const prompt = 'first line\nalpha · beta\n? for shortcuts';
    expect(codexOwnsDraft(codexComposerWithFooter('first line\n  alpha · beta\n  ? for shortcuts'), prompt)).toBe(true);
    expect(codexOwnsDraft('› first line\n  ? for shortcuts', 'first line')).toBe(false);
    expect(codexOwnsDraft('› first line\n  ? for shortcuts', 'first line\n? for shortcuts')).toBe(true);
    const authoredRows = '› first line\n  alpha · beta\n  ? for shortcuts';
    expect(codexOwnsDraft(authoredRows, 'first line')).toBe(false);
    expect(codexOwnsDraft(authoredRows, prompt)).toBe(true);
    const adjacentStatusRows = '› first line\n  GPT-5.5 default · /repo/work · main\n  ? for shortcuts';
    expect(codexOwnsDraft(adjacentStatusRows, 'first line')).toBe(false);
    expect(codexOwnsDraft(adjacentStatusRows, 'first line\nGPT-5.5 default · /repo/work · main\n? for shortcuts')).toBe(true);
  });

  // recovery ownership must reject edits while still tolerating terminal wraps
  it('owns exact ordinary, wrapped and multiline drafts', () => {
    expect(codexOwnsDraft(capture('› abc\n  def'), 'abcdef ')).toBe(true);
    expect(codexOwnsDraft(capture('› first paragraph\n\n  second paragraph'), 'first paragraph\n\nsecond paragraph ')).toBe(true);
    expect(codexOwnsDraft(capture('! git status'), '!git status')).toBe(true);
    expect(codexOwnsDraft(capture('› owned draft plus operator changes'), 'owned draft ')).toBe(false);
    expect(codexOwnsDraft(capture('› [Pasted Content 81 chars] plus edits'), `${'😀'.repeat(80)} `)).toBe(false);
    expect(codexOwnsDraft(capture('› unrelated draft'), 'owned draft ')).toBe(false);
  });

  // equal-length rich pastes cannot establish ownership of hidden content
  it('keeps exact collapsed-paste ownership inconclusive', () => {
    const pane = capture('› [Pasted Content 81 chars]');
    expect(codexDraftState(pane, `${'😀'.repeat(80)} `)).toBe('visible');
    expect(codexOwnsDraft(pane, `${'😀'.repeat(80)} `)).toBeUndefined();
    expect(codexOwnsDraft(pane, `${'😎'.repeat(80)} `)).toBeUndefined();
  });

  // maximum-sized drafts must not compile unbounded ownership regexes
  it('bounds ownership matching for cropped and edited large drafts', () => {
    const prompt = `${'x'.repeat(32_000)} `;
    expect(codexOwnsDraft(capture(`› ${'x'.repeat(64)}`), prompt)).toBeUndefined();
    expect(codexOwnsDraft(capture(`› ${prompt} plus operator changes`), prompt)).toBe(false);
    expect(codexOwnsDraft(capture('› [Pasted Content 32001 chars] plus edits'), prompt)).toBe(false);
  });

  // historical quote syntax is not a live native selector
  it('preserves ownership beneath quoted numbered scrollback', () => {
    const pane = ['• prior output', '> 1. old quote', '> 2. another old quote', capture('› owned draft')].join('\n');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(true);
  });

  // a native selector takes priority over its background composer
  it('keeps background drafts unknown while a native choice dialog owns input', () => {
    const pane = ['Choose an action', '\x1b[1;7m❯ 1. Approve\x1b[0m', '  2. Reject', capture('› owned draft')].join('\n');
    expect(codexDraftState(pane, 'owned draft ')).toBe('unknown');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(false);
  });

  it('does not treat imitateable plain numbered text as a native selector', () => {
    const pane = ['Authored example', '❯ 1. not native chrome', '  2. still authored', capture('› owned draft')].join('\n');
    expect(codexDraftState(pane, 'owned draft ')).toBe('visible');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(true);
  });

  it('does not let one inverse-styled authored row imitate a native selector', () => {
    const pane = ['\x1b[1;7m❯ 1. styled prose\x1b[0m', capture('› owned draft')].join('\n');
    expect(codexDraftState(pane, 'owned draft ')).toBe('visible');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(true);
  });

  // accept every animation frame without changing the expected prompt
  it.each(sparkleDots)('recognizes a draft with %s in its blank cells', dot => {
    expect(codexDraftState(capture(animated(`›${dot}review,${dot}commit,${dot}and${dot}push`)), 'review, commit, and push ')).toBe('visible');
  });

  // acknowledge submission even while the empty composer animates
  it.each(sparkleDots)('recognizes a cleared composer with %s after its marker', dot => {
    expect(codexDraftState(capture(animated(`›${dot}Ask Codex to do anything`)), 'review, commit, and push ')).toBe('cleared');
  });

  // reset readiness must share the submission parser's decorative-blank handling
  it.each(sparkleDots)('recognizes an empty post-reset composer decorated with %s', dot => {
    expect(codexNewConversation.composerEmpty(capture(animated(`›${dot}Ask${dot}Codex to do anything`)))).toBe(true);
    expect(codexNewConversation.composerEmpty(capture(animated(`›${dot}`)))).toBe(true);
    expect(codexNewConversation.composerEmpty(capture(animated(`›${dot}draft`)))).toBe(false);
    expect(codexNewConversation.composerEmpty(capture(`› ${dot}`))).toBe(false);
  });

  // preserve visible tails through animated paragraph spacing
  it('matches the tail of a long multiline draft', () => {
    const prompt = 'Please inspect the entire prompt submission path and fix the race.\n\nKeep the change small and add a regression test.';
    const composer = '›⠁Please inspect the entire prompt submission path and fix the race.\n  ⠂\n ⠐Keep the change small⠄and add a regression test.';
    expect(codexDraftState(capture(animated(composer)), prompt)).toBe('visible');
  });

  // reproduce attachment paths wrapped inside a single token
  it.each([24, 40, 60])('matches attachment paths wrapped across %s-column composer rows', width => {
    const path = '@node_modules/.remote-agent-console/attachments/abcdefghijklmnop/notes[final].txt';
    const prompt = `Review this attachment.\n\nAttached files:\n${path} `;
    // preserve row boundaries from the narrow terminal
    const rows = Array.from({ length: Math.ceil(path.length / width) }, (_value, index) => `  ${path.slice(index * width, (index + 1) * width)}`);
    const composer = ['› Review this attachment.', '', '  Attached files:', ...rows].join('\n');
    expect(codexDraftState(capture(composer), prompt)).toBe('visible');
    expect(codexDraftState(capture(composer), prompt.replace('final', 'other'))).toBe('cleared');
    expect(codexDraftState(capture(composer), prompt.replace('notes', 'no tes'))).toBe('cleared');
  });

  // preserve filename spaces and Unicode through multiple visual wraps
  it('matches wrapped attachment filenames containing spaces and emoji', () => {
    const path = '@node_modules/.remote-agent-console/attachments/abcdefghijklmnop/weather 🌤 notes.txt';
    const composer = ['› Read this.', '', '  Attached files:', '  @node_modules/.remote-agent-console/attach', '  ments/abcdefghijklmnop/weather', '  🌤 notes.txt'].join('\n');
    expect(codexDraftState(capture(composer), `Read this.\n\nAttached files:\n${path} `)).toBe('visible');
    expect(codexDraftState(capture(composer), `Read this.\n\nAttached files:\n${path.replace('notes', 'other')} `)).toBe('cleared');
  });

  // distinguish terminal wrapping from authored spaces within tokens
  it('matches wrapped short tokens without accepting different text', () => {
    expect(codexDraftState(capture('› abc\n  def'), 'abcdef ')).toBe('visible');
    expect(codexDraftState(capture('› abc def'), 'abcdef ')).toBe('cleared');
    expect(codexDraftState(capture('› abc\n  deg'), 'abcdef ')).toBe('cleared');
    expect(codexDraftState(capture('› abcdef'), 'abc def ')).toBe('cleared');
  });

  // recognize the same animated blanks in collapsed paste labels and shell mode
  it('matches collapsed drafts and shell commands', () => {
    expect(codexDraftState(capture(animated('›⠁[Pasted⠂Content⠄80⠈chars]')), 'x'.repeat(80))).toBe('visible');
    expect(codexDraftState(capture(animated('›⠁[Pasted⠂Content⠄80⠈chars]')), '😀'.repeat(80))).toBe('visible');
    expect(codexDraftState(capture(animated('!⠁git⠂status')), '!git status')).toBe('visible');
    expect(codexDraftState('! ', '!')).toBe('visible');
  });

  // retain literal Braille and regex punctuation supplied by the user
  it('does not erase prompt characters or interpret them as regex syntax', () => {
    expect(codexDraftState(capture(`${animated('›⠁Explain⠂')}⠁⠂⠄⠈⠐⠠⡀⢀${animated('⠐and⠠[a-z]+.')}`), 'Explain ⠁⠂⠄⠈⠐⠠⡀⢀ and [a-z]+.')).toBe('visible');
    expect(codexDraftState(capture(animated('›⠁Explain⠂and⠠[a-z]+.')), 'Explain ⠁⠂⠄⠈⠐⠠⡀⢀ and [a-z]+.')).toBe('cleared');
    expect(codexDraftState(capture(animated('›⠁Explain⠂aaaa')), 'Explain [a-z]+.')).toBe('cleared');
    expect(codexDraftState(capture(`${animated('›⠁')}⠂literal${animated('⠄text')}`), '⠂literal text')).toBe('visible');
    expect(codexDraftState(capture(animated('›⠁Explain⠂🌤️⠄weather')), 'Explain 🌤️ weather')).toBe('visible');
  });

  // never split an emoji at the visible-tail boundary
  it('matches Unicode characters at the start of the visible tail', () => {
    const prompt = `${'Long context '.repeat(10)}🌤${'x'.repeat(63)}`;
    expect(codexDraftState(capture(animated(`›⠁${prompt}`)), prompt)).toBe('visible');
    const shortPrompt = `😀${'x'.repeat(63)}`;
    expect(codexDraftState(capture(animated(`›⠁${shortPrompt}`)), shortPrompt)).toBe('visible');
    expect(codexDraftState(capture(animated(`›⠁Unrelated ${shortPrompt}`)), shortPrompt)).toBe('cleared');
  });

  // never substitute arbitrary characters or match old output and footer text
  it('keeps unrelated content out of the live draft', () => {
    expect(codexDraftState(capture(animated('›⠁review,xcommit, and push')), 'review, commit, and push')).toBe('cleared');
    expect(codexDraftState(capture(animated('›⠁Ask Codex to do anything')), 'gpt-6-astra')).toBe('cleared');
    expect(codexDraftState(animated('›⠁review, commit, and push\n\n• Working'), 'review, commit, and push')).toBe('unknown');
    expect(codexDraftState(capture('›xreview, commit, and push'), 'review, commit, and push')).toBe('unknown');
  });

  // keep authored or ambiguously styled dots out of the whitespace match
  it.each([
    ['default foreground', '\x1b[48;2;30;30;30m'],
    ['palette foreground', '\x1b[48;2;30;30;30;38;5;20m'],
    ['palette background', '\x1b[48;5;20;38;2;20;20;20m'],
    ['bold text', '\x1b[48;2;30;30;30;38;2;20;20;20;1m'],
    ['dim text', '\x1b[48;2;30;30;30;38;2;20;20;20;2m'],
    ['underlined text', '\x1b[48;2;30;30;30;38;2;20;20;20;4m'],
    ['reset background', '\x1b[48;2;30;30;30;38;2;20;20;20;49m'],
    ['reset style', '\x1b[48;2;30;30;30;38;2;20;20;20m\x1b[0m']
  ])('preserves Braille with %s', (_name, style) => {
    const composer = `${style}› a⠁b\x1b[0m`;
    expect(codexDraftState(capture(composer), 'a b')).toBe('cleared');
    expect(codexDraftState(capture(composer), 'a⠁b')).toBe('visible');
  });

  // follow persistent and combined SGR state without depending on theme colors
  it('normalizes only decorated cells across style transitions', () => {
    const composer = '\x1b[48;2;240;241;242;38;2;1;2;3;1m› a\x1b[22m⠁b⠂c\x1b[39m⠄d\x1b[0m';
    expect(codexDraftState(capture(composer), 'a b c⠄d')).toBe('visible');
    expect(codexDraftState(capture(composer), 'a b c d')).toBe('cleared');
  });
});
