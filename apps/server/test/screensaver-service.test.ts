import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import { styledTerminalTail } from '../src/adapters/terminal-preview.js';
import { ScreensaverContentService } from '../src/screensaver/service.js';
import { screensaverPreviewIdentity, screensaverPreviewPublication } from '../src/screensaver/identity.js';
import { screensaverShowsOutput } from '../src/screensaver/contracts.js';

// build one minimal Agent for read-only content selection
const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  transport: 'tmux',
  panel: 'terminal',
  home: '/repo',
  title: 'Agent',
  kind: 'codex',
  attention: 'finished',
  ...overrides
});

// provide controllable conversation and terminal sources
const service = (options: { current?: Agent; afterRead?: Agent; published?: Agent; afterPublished?: Agent | null; identityMode?: 'output' | 'response'; tail?: string; oldPaneAnswer?: string; nativeAnswer?: string; tailError?: boolean; answerError?: boolean } = {}) => {
  const current = options.current ?? agent();
  const published = options.published ?? current;
  const mode = options.identityMode ?? (screensaverShowsOutput(published) ? 'output' : 'response');
  const publication = screensaverPreviewPublication(published, mode);
  const previewOutput = vi.fn(async (_id: string, rows: number) => {
    // exercise a transport read failure without throwing from the service
    if (options.tailError === true) throw new Error('capture failed');
    return options.tail === undefined ? undefined : styledTerminalTail(options.tail, rows);
  });
  const latestAnswer = vi.fn(async () => options.oldPaneAnswer);
  // keep native transcript reads independent of the pane frame
  const previewAnswer = vi.fn(async () => {
    // simulate unavailable conversation data during a switch
    if (options.answerError === true) throw new Error('answer failed');
    return options.nativeAnswer;
  });
  // resolve Agent state through the same selected Transport as its content
  let targetReads = 0;
  const target = vi.fn(async (id: string) => id === current.id ? { agent: targetReads++ === 0 ? current : options.afterRead ?? current } : undefined);
  const currentPublication = () => {
    const after = options.afterPublished === null ? undefined : options.afterPublished ?? (options.published === undefined ? options.afterRead ?? current : published);
    const issued = targetReads <= 1 ? published : after;
    return issued === undefined ? undefined : screensaverPreviewPublication(issued, options.identityMode ?? (screensaverShowsOutput(issued) ? 'output' : 'response'));
  };
  return {
    identity: publication.identity,
    runtimeIdentity: publication.runtimeIdentity,
    target,
    previewOutput,
    latestAnswer,
    previewAnswer,
    content: new ScreensaverContentService({
      prompts: { transportFor: async () => ({ target, previewOutput, latestAnswer, previewAnswer }) as never },
      currentPublication
    })
  };
};

describe('screensaver Agent content', () => {
  // request seven rows for working agents and agents waiting on a native question
  it.each(['working', 'question'] as const)('shows a live seven-line tail while %s', async attention => {
    const fixture = service({ current: agent({ attention }), tail: 'old\none\ntwo\nthree\nfour\nfive\nsix\nseven' });

    await expect(fixture.content.read('agent-1', fixture.identity)).resolves.toEqual({ identity: fixture.identity, kind: 'output', text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven', available: true });
    expect(fixture.previewOutput).toHaveBeenCalledWith('agent-1', 7, fixture.runtimeIdentity);
    expect(fixture.target).toHaveBeenCalledTimes(2);
    expect(fixture.latestAnswer).not.toHaveBeenCalled();
  });

  // dashboard enrichment may infer a question and replace display-only workspace fields
  it('accepts an enriched dashboard output token against the same raw transport target', async () => {
    const raw = agent({ attention: 'finished', home: '/pane/root', placeId: 'place-a', conversationId: 'conversation', recoveryProcessKey: 'process' });
    const enriched = { ...raw, attention: 'question' as const, home: '/canonical/worktree', placeId: 'place-b', worktreeId: 'worktree' };
    const fixture = service({ current: raw, published: enriched, tail: 'live question output' });

    expect(fixture.identity).toBe(screensaverPreviewIdentity(enriched, 'output'));
    await expect(fixture.content.read(raw.id, fixture.identity)).resolves.toMatchObject({ kind: 'output', text: 'live question output', available: true });
  });

  // an active publication registry must fail closed after an Agent is retired
  it('does not reconstruct a raw target token after its issued identity is retired', async () => {
    const current = agent({ conversationId: 'conversation', recoveryProcessKey: 'process' });
    const previewAnswer = vi.fn(async () => 'private response');
    const content = new ScreensaverContentService({
      prompts: { transportFor: async () => ({ target: async () => ({ agent: current }), previewAnswer }) as never },
      currentPublication: () => undefined
    });

    await expect(content.read(current.id, screensaverPreviewIdentity(current, 'response'))).resolves.toBeUndefined();
    expect(previewAnswer).not.toHaveBeenCalled();
  });

  // treat structured compaction as active work even before attention catches up
  it('shows live output while compacting', async () => {
    const fixture = service({ current: agent({ structured: { lifecycle: 'live', revision: 1, switchable: false, compacting: true } }), tail: 'compacting' });

    await expect(fixture.content.read('agent-1', fixture.identity)).resolves.toMatchObject({ identity: fixture.identity, kind: 'output', text: 'compacting', available: true });
  });

  // serve the current native response even when the pane still displays older scrollback
  it('shows the latest response for idle Agents', async () => {
    const fixture = service({ nativeAnswer: 'Current response', oldPaneAnswer: 'Older response' });

    await expect(fixture.content.read('agent-1', fixture.identity)).resolves.toEqual({ identity: fixture.identity, kind: 'response', text: 'Current response', available: true });
    expect(fixture.latestAnswer).not.toHaveBeenCalled();
  });

  // a new conversation must not borrow another conversation's screen or saved history
  it('returns no response until the current conversation has a readable answer', async () => {
    const fixture = service({ current: agent({ conversationId: 'new' }), answerError: true, oldPaneAnswer: 'Answer to the previous conversation' });

    await expect(fixture.content.read('agent-1', fixture.identity)).resolves.toEqual({ identity: fixture.identity, kind: 'response', text: '', available: false });
    expect(fixture.latestAnswer).not.toHaveBeenCalled();
  });

  // reject bytes captured across a conversation or display-mode handoff
  it.each([
    ['conversation', agent({ conversationId: 'next' })],
    ['mode', agent({ attention: 'working', conversationId: 'current' })],
    ['process', agent({ conversationId: 'current', recoveryProcessKey: 'pid:next' })]
  ] as const)('discards content after a %s handoff', async (_label, afterRead) => {
    const fixture = service({ current: agent({ conversationId: 'current' }), afterRead, nativeAnswer: 'Wrong lifetime' });

    await expect(fixture.content.read('agent-1', fixture.identity)).resolves.toBeUndefined();
  });

  // an unreported writer change is just as much a conversation handoff
  it('discards a preview when the fallback conversation changes in place', async () => {
    const current = agent({ attention: 'working', previewConversationId: 'first', recoveryProcessKey: 'same-process' });
    const fixture = service({ current, afterRead: { ...current, previewConversationId: 'second' }, tail: 'wrong conversation' });
    await expect(fixture.content.read(current.id, fixture.identity)).resolves.toBeUndefined();
  });

  // distinguish unavailable content and departed Agents
  it('returns explicit unavailable content and no result for a departed Agent', async () => {
    const unavailable = service({ current: agent({ attention: 'working' }), tailError: true });
    await expect(unavailable.content.read('agent-1', unavailable.identity)).resolves.toEqual({ identity: unavailable.identity, kind: 'output', text: '', available: false });
    await expect(unavailable.content.read('departed', unavailable.identity)).resolves.toBeUndefined();
  });

  // bound an unexpectedly large response without splitting the API response indefinitely
  it('caps response content at 64 KiB', async () => {
    const fixture = service({ nativeAnswer: `${'x'.repeat(70 * 1024)}LATEST` });
    const content = await fixture.content.read('agent-1', fixture.identity);

    expect(content).toMatchObject({ kind: 'response', available: true, truncated: true });
    expect(Buffer.byteLength(content?.text ?? '')).toBe(64 * 1024);
    expect(content?.text.endsWith('LATEST')).toBe(true);
  });

  // preserve the newest rows and suffix when an imperfect Transport over-returns output
  it('keeps the newest seven output lines and newest 64 KiB', async () => {
    const newest = `${'x'.repeat(70 * 1024)}THE-END`;
    const fixture = service({ current: agent({ attention: 'working' }), tail: `old-one\nold-two\nkeep-one\nkeep-two\nkeep-three\nkeep-four\nkeep-five\nkeep-six\n${newest}` });
    const content = await fixture.content.read('agent-1', fixture.identity);

    expect(content).toMatchObject({ kind: 'output', available: true, truncated: true });
    expect(content?.text.endsWith('THE-END')).toBe(true);
    expect(content?.text).not.toContain('old-one');
    expect(Buffer.byteLength(content?.text ?? '')).toBeLessThanOrEqual(64 * 1024);
  });

  // UTF-8 clipping of the latest tail must rebase its UTF-16 color ranges
  it('keeps the right colors after truncating an oversized live tail', async () => {
    const fixture = service({ current: agent({ attention: 'working' }), tail: `\x1b[31m${'🍐'.repeat(20_000)}\x1b[32mOK\x1b[0m` });
    const content = await fixture.content.read('agent-1', fixture.identity);
    const end = content!.text.length;

    expect(content).toMatchObject({ kind: 'output', available: true, truncated: true });
    expect(content!.text.endsWith('🍐OK')).toBe(true);
    expect(content!.colors).toEqual([{ from: 0, to: end - 2, foreground: 1 }, { from: end - 2, to: end, foreground: 2 }]);
  });
});
