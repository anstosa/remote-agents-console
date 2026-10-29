import { describe, expect, it, vi } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { inlineQuestionId } from '../src/adapters/inline-questions.js';
import { omxAdapter } from '../src/adapters/omx.js';

const banner = '• Queued follow-up inputs\n  ? 1 question\n    alt + ↑ to answer\n\n› Ask Codex to do anything\n  gpt-6-astra · /repo · main';
const socket = { fingerprint: 'socket', path: '/tmp/queued-question-test', device: 1, inode: 1 };
const agent = { id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/repo', kind: 'codex', title: 'Ready', attention: 'finished' };

// exercise real prompt guards without typing into a live agent
function fixture() {
  const target = vi.fn(async () => ({ agent, socket }));
  const capture = vi.fn(async (): Promise<string | undefined> => banner);
  const sendKeys = vi.fn(async () => true);
  const pastePrompt = vi.fn(async () => true);
  const service = new PromptService({ target, worktreesNow: () => [] } as never, { capture, sendKeys, pastePrompt } as never);
  return { target, capture, sendKeys, service };
}

// opening the editor must never submit a default answer or interrupt agent work
describe('native queued question activation', () => {
  // a quick follow-up may arrive before the derive observes an empty question queue
  it.each([0, 'Use the smaller change.'])('rearms after answering with %s without an empty-footer frame', async answer => {
    const { service, capture, sendKeys } = fixture();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    const expanded = '• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip   shift + → main prompt';
    capture.mockResolvedValue(expanded);
    await service.openQueuedQuestion(agent.id, expanded, () => true);
    await expect(service.answerQuestion(agent.id, inlineQuestionId('Which approach?', ['Small', 'Other']), answer)).resolves.toBe(true);
    capture.mockResolvedValue(banner);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    expect(sendKeys.mock.calls).toEqual([[socket, '%1', ['M-Up']], [socket, '%1', ['Enter']], [socket, '%1', ['M-Up']]]);
  });

  // a refused answer must not reopen the question after a deliberate manual collapse
  it.each([0, 'Use the smaller change.'])('retains suppression after a failed answer with %s', async answer => {
    const { service, capture, sendKeys } = fixture();
    await service.openQueuedQuestion(agent.id, banner, () => true);
    capture.mockResolvedValue('• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip   shift + → main prompt');
    sendKeys.mockResolvedValueOnce(false);
    await expect(service.answerQuestion(agent.id, inlineQuestionId('Which approach?', ['Small', 'Other']), answer)).resolves.toBe(false);
    capture.mockResolvedValue(banner);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  // answering an unrelated menu does not reopen a deliberately collapsed question
  it('retains suppression after selecting an unrelated parsed menu', async () => {
    const { service, capture, sendKeys } = fixture();
    await service.openQueuedQuestion(agent.id, banner, () => true);
    capture.mockResolvedValue('Which model?\n› 1. Small\n  2. Large\nPress enter to confirm or esc to go back');
    await expect(service.answerQuestion(agent.id, inlineQuestionId('Which model?', ['Small', 'Large']), 0)).resolves.toBe(true);
    capture.mockResolvedValue(banner);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  // structured omx questions have independent ownership from the native queued editor
  it('retains suppression after answering a structured OMX question', async () => {
    const sendKeys = vi.fn(async () => true);
    const service = new PromptService(
      { target: async () => ({ agent: { ...agent, kind: 'omx' }, socket }), worktreesNow: () => [] } as never,
      { capture: async () => banner, sendKeys } as never,
      undefined, undefined, undefined,
      // expose an independent question on the adapter's structured channel
      () => ({ ...omxAdapter, questions: { ...omxAdapter.questions, pending: async () => ({ id: 'structured-question', text: 'Which plan?', choices: ['Small', 'Broad'], source: 'structured', pane: { targetPaneId: '%2' } }) } })
    );
    await service.openQueuedQuestion(agent.id, banner, () => true);
    await expect(service.answerQuestion(agent.id, 'structured-question', 0)).resolves.toBe(true);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  // suppress repeats across viewers until the collapsed footer disappears
  it('opens once, preserves manual collapse, and rearms after completion', async () => {
    const { service, sendKeys } = fixture();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys.mock.calls).toEqual([[socket, '%1', ['M-Up']]]);
    await expect(service.openQueuedQuestion(agent.id, '• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip   shift + → main prompt', () => true)).resolves.toBe(false);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    await service.openQueuedQuestion(agent.id, '› Ask Codex to do anything', () => true);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  // reserve automatic input synchronously after resolving the target
  it('coalesces simultaneous viewers', async () => {
    const { service, sendKeys } = fixture();
    const results = await Promise.all([service.openQueuedQuestion(agent.id, banner, () => true), service.openQueuedQuestion(agent.id, banner, () => true)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });

  // honor the viewer control lease across asynchronous reads
  it('does not open after control is lost', async () => {
    const { service, capture, sendKeys } = fixture();
    let active = true;
    capture.mockImplementation(async () => { active = false; return banner; });
    await expect(service.openQueuedQuestion(agent.id, banner, () => active)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // refuse stale or unavailable captures without consuming future attempts
  it.each([undefined, 'already answered', banner.replace('alt + ↑', 'shift + ←')])('revalidates the live shortcut %s', async current => {
    const { service, capture, sendKeys } = fixture();
    capture.mockResolvedValueOnce(current);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });

  // keep all other adapters untouched
  it('ignores unsupported adapters', async () => {
    const { service, target, capture, sendKeys } = fixture();
    target.mockResolvedValue({ agent: { ...agent, kind: 'claude' }, socket });
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // refuse a target replaced between capture and delivery
  it.each([
    { agent: { ...agent, pane: { ...agent.pane, paneId: '%2' } }, socket },
    { agent, socket: { ...socket, fingerprint: 'other' } },
    { agent: { ...agent, kind: 'claude' }, socket }
  ])('revalidates target identity %j', async changed => {
    const { service, target, sendKeys } = fixture();
    target.mockResolvedValueOnce({ agent, socket }).mockResolvedValueOnce(changed);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // leave already active user operations alone
  it('waits for active manual input', async () => {
    const { service, sendKeys } = fixture();
    const release = service.beginAgentMutation(agent.id)!;
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
    release();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });

  // a manual operation must not hide the transition into the opened editor
  it('rearms when the footer disappears during manual input', async () => {
    const { service, sendKeys } = fixture();
    await service.openQueuedQuestion(agent.id, banner, () => true);
    const release = service.beginAgentMutation(agent.id)!;
    await service.openQueuedQuestion(agent.id, 'Which approach?\n› 1. Small\n  2. Other', () => true);
    release();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  // a restart reservation blocks automatic keystrokes
  it('respects restart reservations', async () => {
    const { service, sendKeys } = fixture();
    const release = await service.acquireRestartLock(agent.id);
    expect(release).toBeDefined();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
    release!();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });

  // a manual key arriving during revalidation wins
  it('abandons automatic input when the mutation generation changes', async () => {
    const { service, capture, sendKeys } = fixture();
    capture.mockImplementation(async () => { service.beginAgentMutation(agent.id)!(); return banner; });
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // only successful delivery suppresses a later attempt
  it('retries failed delivery and releases its mutation reservation', async () => {
    const { service, sendKeys } = fixture();
    sendKeys.mockResolvedValueOnce(false);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });
});
