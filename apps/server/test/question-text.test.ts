import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PromptService } from '../src/prompts/service.js';
import { inlineQuestionId } from '../src/adapters/inline-questions.js';

const socket = { fingerprint: 'socket', path: '/tmp/question-text', device: 1, inode: 1 };
const agent = { id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/repo', kind: 'codex', title: 'Question', attention: 'question' };
const questionId = inlineQuestionId('Which approach?', ['Small', 'Broad', 'Other']);
const legacyQuestionId = inlineQuestionId('Which approach?', ['Small', 'Broad', 'None of the above']);
const choices = 'Which approach?\n› 1. Small\n  2. Broad\n  3. Other';
const asyncCapture = `• Queued follow-up inputs\n${choices}\nenter submit   ctrl + ] skip   shift + → main prompt`;
const legacyCapture = `${choices.replace('3. Other', '3. None of the above')}\ntab to add notes | enter to submit answer | esc to interrupt`;

// record question delivery without touching a live agent
function fixture(capture = asyncCapture, kind = 'codex') {
  const target = vi.fn(async () => ({ agent: { ...agent, kind }, socket }));
  const tmux = {
    // expose a still-current question throughout delivery
    capture: vi.fn(async () => capture),
    // preserve bracketed text separately from submit keys
    pastePrompt: vi.fn(async () => true),
    // record explicit navigation and submission
    sendKeys: vi.fn(async () => true)
  };
  // expose queue activity and no pending reset
  const queued = { enqueue: vi.fn(), list: vi.fn(), resets: { get: vi.fn().mockResolvedValue(undefined) } };
  const service = new PromptService({ target, worktreesNow: () => [] } as never, tmux as never, undefined, queued as never);
  return { service, target, tmux, queued };
}

// a question answer must never wait behind the turn it unblocks
describe('text question answers', () => {
  // paste safely into the async custom-answer editor and submit rather than tab-queue
  it.each(['codex', 'omx'])('sends a %s text answer immediately without touching the prompt queue', async kind => {
    // current codex renders compact modifier chords
    const { service, tmux, queued } = fixture(asyncCapture.replace(/ \+ /gu, '+'), kind);
    await expect(service.answerQuestion(agent.id, questionId, 'Use the smaller change.\nKeep the tests.')).resolves.toBe(true);
    expect(tmux.pastePrompt).toHaveBeenCalledWith(socket, '%1', expect.stringMatching(/^rac-/u), 'Use the smaller change.\nKeep the tests.');
    expect(tmux.sendKeys.mock.calls).toEqual([[socket, '%1', ['Enter']]]);
    expect(queued.enqueue).not.toHaveBeenCalled();
    expect(queued.list).not.toHaveBeenCalled();
  });

  // avoid implicitly submitting the recommended option alongside a custom answer
  it('moves the legacy menu to the custom-answer row before pasting', async () => {
    const { service, tmux } = fixture(legacyCapture);
    await expect(service.answerQuestion(agent.id, legacyQuestionId, 'A different approach.')).resolves.toBe(true);
    expect(tmux.sendKeys.mock.calls).toEqual([[socket, '%1', ['Down', 'Down']], [socket, '%1', ['Enter']]]);
    expect(tmux.sendKeys.mock.invocationCallOrder[0]).toBeLessThan(tmux.pastePrompt.mock.invocationCallOrder[0]!);
  });

  // reject stale, unsupported, empty and terminal-control-bearing answers
  it.each([
    { id: 'stale', text: 'Answer', capture: asyncCapture },
    { id: questionId, text: ' ', capture: asyncCapture },
    { id: questionId, text: 'x'.repeat(32_001), capture: asyncCapture },
    { id: questionId, text: 'unsafe\x1b[201~', capture: asyncCapture },
    { id: questionId, text: 'Answer', capture: `${choices}\nPress enter to confirm or esc to go back` },
    { id: legacyQuestionId, text: 'Answer', capture: legacyCapture.replace('› ', '  ') }
  ])('refuses an unavailable text answer %#', async ({ id, text, capture }) => {
    const { service, tmux, queued } = fixture(capture);
    await expect(service.answerQuestion(agent.id, id, text)).resolves.toBe(false);
    expect(tmux.pastePrompt).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(queued.enqueue).not.toHaveBeenCalled();
  });

  // do not send enter after failed or stale delivery
  it('leaves the question unsubmitted when paste fails', async () => {
    const { service, tmux } = fixture();
    tmux.pastePrompt.mockResolvedValue(false);
    await expect(service.answerQuestion(agent.id, questionId, 'Answer')).resolves.toBe(false);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  // recheck target identity before the submit key
  it('does not submit after the target changes during paste', async () => {
    const { service, target, tmux } = fixture();
    tmux.pastePrompt.mockImplementation(async () => {
      target.mockResolvedValue({ agent: { ...agent, pane: { ...agent.pane, paneId: '%2' } }, socket });
      return true;
    });
    await expect(service.answerQuestion(agent.id, questionId, 'Answer')).resolves.toBe(false);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  // lifecycle reservations must cover the entire answer delivery
  it('refuses answers during a restart handoff and releases its own reservation', async () => {
    const { service, tmux } = fixture();
    const release = await service.acquireRestartLock(agent.id);
    await expect(service.answerQuestion(agent.id, questionId, 'Answer')).resolves.toBe(false);
    expect(tmux.pastePrompt).not.toHaveBeenCalled();
    release!();
    await expect(service.answerQuestion(agent.id, questionId, 'Answer')).resolves.toBe(true);
    const nextRelease = await service.acquireRestartLock(agent.id);
    expect(nextRelease).toBeDefined();
    nextRelease!();
  });

  // Claude answers free text through its dialog's Type something row, one line only
  it('pastes a flattened Claude answer into the Type something row and submits it', async () => {
    const question = { question: 'Which fruit?', options: [{ label: 'Apple', description: 'Crisp' }, { label: 'Banana' }] };
    const payload = Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [question] } })).toString('base64');
    const dialog = [' ☐ Fruit', 'Which fruit?', '❯ 1. Apple', '     Crisp', '  2. Banana', '  3. Type something.', '─────', '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    const target = vi.fn(async () => ({ agent: { ...agent, kind: 'claude' }, socket }));
    const tmux = { capture: vi.fn(async () => dialog), pastePrompt: vi.fn(async () => true), sendKeys: vi.fn(async () => true) };
    const queued = { enqueue: vi.fn(), list: vi.fn(), resets: { get: vi.fn().mockResolvedValue(undefined) } };
    const discovery = { target, worktreesNow: () => [], reportedQuestionPayload: () => payload };
    const service = new PromptService(discovery as never, tmux as never, undefined, queued as never);
    const fruitId = inlineQuestionId('Which fruit?', ['Apple', 'Banana', 'Chat about this']);
    await expect(service.answerQuestion(agent.id, fruitId, 'Neither.\nA pear.')).resolves.toBe(true);
    expect(tmux.sendKeys.mock.calls).toEqual([[socket, '%1', ['Down', 'Down']], [socket, '%1', ['Enter']]]);
    expect(tmux.pastePrompt).toHaveBeenCalledWith(socket, '%1', expect.stringMatching(/^rac-/u), 'Neither. A pear.');
    expect(tmux.sendKeys.mock.invocationCallOrder[0]).toBeLessThan(tmux.pastePrompt.mock.invocationCallOrder[0]!);
    // Chat about this is choice 2 but screen row 3: it skips the Type something input
    tmux.sendKeys.mockClear();
    await expect(service.answerQuestion(agent.id, fruitId, 2)).resolves.toBe(true);
    expect(tmux.sendKeys.mock.calls).toEqual([[socket, '%1', ['Down', 'Down', 'Down', 'Enter']]]);
  });
});

const { lines: folderTrustLines } = JSON.parse(readFileSync(new URL('./fixtures/claude/folder-trust.json', import.meta.url), 'utf8')) as { lines: string[] };
const folderTrustCapture = folderTrustLines.join('\n');
const folderTrustId = inlineQuestionId('Do you trust /workspaces/example?', ['No, exit', 'Yes, I trust this folder']);

// native folder permissions are direct operator answers, never queued prompts
describe('folder trust answers', () => {
  // move relative to the freshly captured cursor rather than assuming the first row
  it.each([
    { selected: 0, answer: 1, keys: ['Down', 'Enter'] },
    { selected: 0, answer: 0, keys: ['Enter'] },
    { selected: 1, answer: 0, keys: ['Up', 'Enter'] },
    { selected: 1, answer: 1, keys: ['Enter'] }
  ])('delivers explicit choice $answer from native row $selected', async ({ selected, answer, keys }) => {
    const capture = selected === 0 ? folderTrustCapture : folderTrustCapture.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust');
    const { service, tmux, queued } = fixture(capture, 'claude');
    await expect(service.answerQuestion(agent.id, folderTrustId, answer, { operator: true })).resolves.toBe(true);
    expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith(socket, '%1', keys);
    expect(tmux.pastePrompt).not.toHaveBeenCalled();
    expect(queued.enqueue).not.toHaveBeenCalled();
  });

  // a caller without operator consent must not choose either native folder action
  it.each([0, 1])('refuses non-operator folder choice %s', async answer => {
    const { service, tmux } = fixture(folderTrustCapture, 'claude');
    await expect(service.answerQuestion(agent.id, folderTrustId, answer)).resolves.toBe(false);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.pastePrompt).not.toHaveBeenCalled();
  });

  // even a matching shortened-display id cannot authorize an ambiguous folder
  it.each(['/workspaces/ex…mple', '/workspaces/.../example'])('refuses the shortened folder %s without sending keys', async folder => {
    const { service, tmux } = fixture(folderTrustCapture.replace('/workspaces/example', folder), 'claude');
    const id = inlineQuestionId(`Do you trust ${folder}?`, ['No, exit', 'Yes, I trust this folder']);
    await expect(service.answerQuestion(agent.id, id, 1, { operator: true })).resolves.toBe(false);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.pastePrompt).not.toHaveBeenCalled();
  });

  // stale folders, missing highlights, and prose cannot authorize a native trust action
  it.each([
    { capture: folderTrustCapture.replace('/workspaces/example', '/workspaces/other'), answer: 1 },
    { capture: `${folderTrustCapture}\nClaude is ready\n❯ `, answer: 1 },
    { capture: folderTrustCapture.replace('❯ No, exit', '  No, exit'), answer: 1 },
    { capture: folderTrustCapture, answer: 'Yes, trust it.' }
  ])('refuses an unavailable folder answer %#', async ({ capture, answer }) => {
    const { service, tmux } = fixture(capture, 'claude');
    await expect(service.answerQuestion(agent.id, folderTrustId, answer, { operator: true })).resolves.toBe(false);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.pastePrompt).not.toHaveBeenCalled();
  });
});

const { lines: codexTrustLines } = JSON.parse(readFileSync(new URL('./fixtures/codex/folder-trust.json', import.meta.url), 'utf8')) as { lines: string[] };
const codexTrustCapture = codexTrustLines.join('\n');
const codexTrustId = inlineQuestionId('Do you trust /workspaces/example?', ['Trust and continue', 'Quit']);

// codex and omx require the same explicit native folder decision as claude
for (const kind of ['codex', 'omx']) {
  describe(`${kind} folder trust answers`, () => {
    // source-verified native actions must match whole labels instead of ordinary prefixes
    it.each(['Open restricted settings', 'Open existing task preferences', 'Trust and continue with tests'])('answers the ordinary choice %s', async label => {
      const capture = `Which approach?\n› 1. ${label}\n  2. Broad\nenter confirm`;
      const { service, tmux } = fixture(capture, kind);
      const id = inlineQuestionId('Which approach?', [label, 'Broad']);
      await expect(service.answerQuestion(agent.id, id, 0)).resolves.toBe(true);
      expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith(socket, '%1', ['Enter']);
    });

    // exact native labels remain ordinary answers unless native structural chrome is present
    it.each(['Trust and continue', 'Open restricted', 'Open existing task'])('answers exact ordinary choice %s with or without quoted chrome', async label => {
      // neither a bare action label nor a quoted heading grants native permission semantics
      for (const prose of ['', 'Folder access\n/workspaces/example\nThis is an example configuration section.\n\n']) {
        const capture = `${prose}Which approach?\n› 1. ${label}\n  2. Broad\nenter confirm`;
        const { service, tmux } = fixture(capture, kind);
        const id = inlineQuestionId('Which approach?', [label, 'Broad']);
        await expect(service.answerQuestion(agent.id, id, 0)).resolves.toBe(true);
        expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith(socket, '%1', ['Enter']);
        expect(tmux.pastePrompt).not.toHaveBeenCalled();
      }
    });

    // a quoted native heading must not prevent answering an unrelated ordinary question
    it('answers a normal question after prose containing the folder-access heading', async () => {
      const capture = 'Folder access\n/workspaces/example\nThis is an example configuration section.\n\nWhich approach?\n› 1. Small\n  2. Broad\nenter confirm';
      const { service, tmux } = fixture(capture, kind);
      const id = inlineQuestionId('Which approach?', ['Small', 'Broad']);
      await expect(service.answerQuestion(agent.id, id, 1)).resolves.toBe(true);
      expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith(socket, '%1', ['Down', 'Enter']);
    });

    // freshly captured highlights determine navigation, never the default affirmative row
    it.each([
      { selected: 0, answer: 0, keys: ['Enter'] },
      { selected: 0, answer: 1, keys: ['Down', 'Enter'] },
      { selected: 1, answer: 0, keys: ['Up', 'Enter'] },
      { selected: 1, answer: 1, keys: ['Enter'] }
    ])('delivers explicit choice $answer from native row $selected', async ({ selected, answer, keys }) => {
      const capture = selected === 0 ? codexTrustCapture : codexTrustCapture.replace('› 1.', '  1.').replace('  2.', '› 2.');
      const { service, tmux, queued } = fixture(capture, kind);
      await expect(service.answerQuestion(agent.id, codexTrustId, answer, { operator: true })).resolves.toBe(true);
      expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith(socket, '%1', keys);
      expect(tmux.pastePrompt).not.toHaveBeenCalled();
      expect(queued.enqueue).not.toHaveBeenCalled();
    });

    // automated callers cannot choose either native folder action
    it.each([0, 1])('refuses non-operator choice %s', async answer => {
      const { service, tmux } = fixture(codexTrustCapture, kind);
      await expect(service.answerQuestion(agent.id, codexTrustId, answer)).resolves.toBe(false);
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      expect(tmux.pastePrompt).not.toHaveBeenCalled();
    });

    // malformed, stale, and prose answers must never submit the default trust selection
    it.each([
      { capture: codexTrustCapture.replace('/workspaces/example', '/workspaces/other'), answer: 0 },
      { capture: codexTrustCapture.replace('/workspaces/example', '/workspaces/ex…mple'), answer: 0 },
      { capture: codexTrustCapture.replace('Your trust decision will be saved.', ''), answer: 0 },
      { capture: codexTrustCapture.replace('› 1.', '  1.'), answer: 0 },
      { capture: `${codexTrustCapture}\n• Ready\n› Ask Codex to do anything`, answer: 0 },
      { capture: codexTrustCapture, answer: 'Yes, trust it.' }
    ])('refuses an unavailable trust answer %#', async ({ capture, answer }) => {
      const { service, tmux } = fixture(capture, kind);
      await expect(service.answerQuestion(agent.id, codexTrustId, answer, { operator: true })).resolves.toBe(false);
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      expect(tmux.pastePrompt).not.toHaveBeenCalled();
    });
  });
}
