import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexDraftState, codexOwnsDraft } from '../../src/adapters/codex-turns.js';
import { codexNewConversation } from '../../src/adapters/codex-new-conversation.js';
import { codexComposerWithFooter } from '../helpers/codex-composer.js';

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

// keep composer acknowledgements independent of decorative animation
describe('Codex draft observation', () => {
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
    const pane = ['Choose an action', '❯ 1. Approve', '  2. Reject', capture('› owned draft')].join('\n');
    expect(codexDraftState(pane, 'owned draft ')).toBe('unknown');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(false);
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
