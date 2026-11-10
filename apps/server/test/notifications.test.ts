import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import { resolveAttention } from '../src/adapters/attention.js';
import { AgentNotificationCoordinator, agentAttentionState, agentNotification, agentPresentationAttentionState, reviewNotification, scheduleNotification, type AgentNotification, type AgentNotificationContext } from '../src/notifications.js';

// Resolve attention from the title exactly as DiscoveryService would, so the
// coordinator reads the same resolved state the wire carries.
const agent = (overrides: Partial<Agent> = {}): Agent => {
  const title = overrides.title ?? 'Ready';
  return {
    id: 'socket:%1',
    pane: { paneId: '%1', sessionId: '$1', socketFingerprint: 'socket' },
    home: '/workspace',
    title,
    kind: 'codex',
    attention: resolveAttention({ kind: 'codex', title, hasQuestion: overrides.question !== undefined }),
    worktreeId: 'eric',
    displayLabel: 'Eric',
    ...overrides
  };
};
const context: AgentNotificationContext = { projectName: 'Remote Agents', worktreeName: 'Eric', multipleWorktrees: true };

describe('agent notifications', () => {
  afterEach(() => vi.useRealTimers());

  it('distinguishes questions from completed work', () => {
    const questioning = agent({ title: '⠋ Working', question: { id: 'question-1', text: 'Deploy now?', choices: ['Yes', 'No'], source: 'structured', pane: { targetPaneId: '%2' } } });

    expect(agentAttentionState(questioning)).toBe('question');
    expect(agentNotification('working', 'question', questioning, context)).toEqual({
      kind: 'question',
      title: 'Question in Remote Agents',
      body: 'Eric: Deploy now?',
      tag: 'agent-status-socket:%1',
      url: '/#agent=socket%3A%251',
      worktreeId: 'eric'
    });
    expect(agentNotification('working', 'finished', agent(), context)).toEqual({
      kind: 'finished',
      title: 'Done working in Remote Agents',
      body: 'Eric is ready for a new prompt',
      tag: 'agent-status-socket:%1',
      url: '/#agent=socket%3A%251',
      worktreeId: 'eric'
    });
  });

  it('presents a latest-message question without changing canonical attention', () => {
    const questioning = agent({ attention: 'finished', hasMessageQuestion: true });

    expect(agentAttentionState(questioning)).toBe('finished');
    expect(agentPresentationAttentionState(questioning)).toBe('question');
    expect(agentPresentationAttentionState({ ...questioning, attention: 'working' })).toBe('working');
  });

  it('does not misreport an action-required transition as completion', () => {
    const questioning = agent({ title: 'Action required | Approve command' });

    expect(agentAttentionState(questioning)).toBe('question');
    expect(agentNotification('working', 'question', questioning, context)?.body).toBe('Eric: has a question');
    expect(agentNotification('question', 'finished', agent())).toBeUndefined();
  });

  it('omits the worktree name from a single-worktree question', () => {
    const questioning = agent({ question: { id: 'question-1', text: 'Deploy now?', choices: ['Yes', 'No'], source: 'structured', pane: { targetPaneId: '%2' } } });

    expect(agentNotification('working', 'question', questioning, { ...context, multipleWorktrees: false })?.body).toBe('Deploy now?');
  });

  it('builds a project-scoped guided review notification', () => {
    expect(reviewNotification('eric', 'Remote Agents', 'Eric')).toEqual({
      kind: 'review',
      title: 'Review ready in Remote Agents',
      body: 'Eric is ready for review',
      tag: 'review-ready-eric',
      url: '/#worktree=eric',
      worktreeId: 'eric'
    });
  });

  it('builds a skipped scheduled-run notification that deep-links to the reused pane and carries the Worktree', () => {
    expect(scheduleNotification({ status: 'skipped', targetLabel: 'Atlas', noteId: 'note-1', noteTitle: 'Morning triage', detail: 'previous run still working', agentId: 'agent-9', worktreeId: 'wt-main' })).toEqual({
      kind: 'schedule',
      title: 'Scheduled run skipped in Atlas',
      body: 'Morning triage · previous run still working',
      tag: 'schedule-note-1',
      url: '/#agent=agent-9',
      worktreeId: 'wt-main'
    });
  });

  it('deep-links a pane-less failed Worktree run to its Worktree, and falls back to Untitled note and the root', () => {
    expect(scheduleNotification({ status: 'failed', targetLabel: 'Atlas', noteId: 'note-2', detail: 'launch refused', worktreeId: 'wt-main' })).toEqual({
      kind: 'schedule',
      title: 'Scheduled run failed in Atlas',
      body: 'Untitled note · launch refused',
      tag: 'schedule-note-2',
      url: '/#worktree=wt-main',
      worktreeId: 'wt-main'
    });
    // a Scratch/Project target with no pane has no Worktree deep-link, so it points at the console root
    expect(scheduleNotification({ status: 'skipped', targetLabel: 'Scratch', noteId: 'note-3', noteTitle: 'Ping', detail: 'target is gone' })).toEqual({
      kind: 'schedule',
      title: 'Scheduled run skipped in Scratch',
      body: 'Ping · target is gone',
      tag: 'schedule-note-3',
      url: '/'
    });
  });

  it('suppresses completion when another queued prompt starts during the grace period', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.observe(agent({ title: '⠙ Working' }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toEqual([]);
    coordinator.stop();
  });

  it('notifies for a latest-message question without creating an unread completion', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ attention: 'finished', hasMessageQuestion: true }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toEqual([expect.objectContaining({ kind: 'question', body: 'Eric: has a question' })]);
    expect(coordinator.isUnread(agent())).toBe(false);
    expect(coordinator.completionId(agent())).toBeUndefined();
    coordinator.stop();
  });

  it('suppresses completion while a prompt remains queued', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }), true);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(delivered).toEqual([]);
    expect(coordinator.isUnread(agent())).toBe(false);
    coordinator.stop();
  });

  // cancel grace when queued work appears on an unchanged finished snapshot
  it('suppresses a pending completion when a prompt becomes queued during grace', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent());
    const pending = coordinator.notificationEvent(agent());
    expect(pending).toBeDefined();
    coordinator.observe(agent(), true);
    const queuedState = coordinator.notificationState(agent());
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toEqual([]);
    expect(coordinator.completionId(agent())).toBeUndefined();
    expect(coordinator.notificationEvent(agent())).toBeUndefined();
    expect(queuedState!.eventSequence).toBeGreaterThan(pending!.eventSequence);
    coordinator.observe(agent(), true);
    expect(coordinator.notificationState(agent())).toEqual(queuedState);
    coordinator.stop();
  });

  // publish one stable identity per completed turn and dismiss only its agent
  it('delivers completion after the agent remains finished', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    const pendingId = coordinator.completionId(agent());
    expect(pendingId).toEqual(expect.any(String));
    expect(coordinator.isUnread(agent())).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe('finished');
    expect(coordinator.isUnread(agent())).toBe(true);
    const completionId = coordinator.completionId(agent());
    expect(completionId).toBe(pendingId);
    expect(completionId).toEqual(expect.any(String));
    coordinator.observe(agent());
    expect(coordinator.completionId(agent())).toBe(completionId);
    const replacement = agent({ id: 'socket:%2', paneId: '%2' });
    expect(coordinator.isUnread(replacement)).toBe(false);
    coordinator.view(replacement);
    expect(coordinator.isUnread(agent())).toBe(true);
    coordinator.view(agent(), completionId);
    expect(coordinator.isUnread(agent())).toBe(false);
    expect(coordinator.completionId(agent())).toBeUndefined();
    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(coordinator.completionId(agent())).toEqual(expect.any(String));
    expect(coordinator.completionId(agent())).not.toBe(completionId);
    coordinator.stop();
  });

  // carry one exact completion event from grace through provider delivery
  it('keeps completion identity and freshness stable through grace and read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    const workingState = coordinator.notificationState(agent());
    coordinator.observe(agent());
    const pendingId = coordinator.completionId(agent());
    const pendingEvent = coordinator.notificationEvent(agent());
    expect(pendingEvent).toMatchObject({
      schemaVersion: 1,
      eventId: pendingId,
      eventEpoch: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      eventSequence: expect.any(Number),
      entityId: 'agent:socket:%1',
      generatedAt: 1_700_000_000_000,
      kind: 'finished',
      agentId: 'socket:%1',
      tag: 'agent-status-socket:%1',
      displayTag: 'rac-v1-agent-status-socket:%1',
      url: '/#agent=socket%3A%251',
      worktreeId: 'eric'
    });
    expect(pendingEvent?.eventSequence).toBeGreaterThan(workingState!.eventSequence);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(delivered).toEqual([{ title: 'Done working in Eric', body: 'Eric is ready for a new prompt', ...pendingEvent }]);
    expect(coordinator.notificationEvent(agent())).toEqual(pendingEvent);
    coordinator.view(agent(), pendingId);
    expect(coordinator.notificationEvent(agent())).toBeUndefined();
    expect(coordinator.notificationState(agent())?.eventSequence).toBeGreaterThan(pendingEvent!.eventSequence);
    coordinator.stop();
  });

  // retain a live question id and separate Agents sharing one Worktree
  it('keeps question identity stable and scopes tags by Agent', () => {
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification));
    const first = agent({ id: 'agent-one', question: { id: 'question-one', text: 'First?', choices: ['Yes'], source: 'structured', pane: { targetPaneId: '%2' } } });
    const second = agent({ id: 'agent-two', question: { id: 'question-two', text: 'Second?', choices: ['Yes'], source: 'structured', pane: { targetPaneId: '%3' } } });

    coordinator.observe({ ...first, question: undefined, attention: 'working' });
    coordinator.observe({ ...second, question: undefined, attention: 'working' });
    coordinator.observe(first);
    coordinator.observe(first);
    coordinator.observe(second);

    expect(delivered).toHaveLength(2);
    expect(delivered.map(notification => notification.eventId)).toEqual(['question-one', 'question-two']);
    expect(delivered.map(notification => notification.tag)).toEqual(['agent-status-agent-one', 'agent-status-agent-two']);
    expect(delivered.map(notification => notification.displayTag)).toEqual(['rac-v1-agent-status-agent-one', 'rac-v1-agent-status-agent-two']);
    expect(delivered.map(notification => notification.worktreeId)).toEqual(['eric', 'eric']);
    coordinator.stop();
  });

  it('never notifies a Review run Agent finishing, but still notifies its question', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);
    const run = (overrides: Partial<Agent> = {}) => agent({ reviewRun: 'run_abcdefgh1234', ...overrides });

    coordinator.observe(run({ title: '⠋ Working' }));
    coordinator.observe(run({ title: 'Ready' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delivered).toEqual([]);
    expect(coordinator.isUnread(run())).toBe(false);
    expect(agentNotification('working', 'finished', run(), context)).toBeUndefined();

    coordinator.observe(run({ title: '⠋ Working', question: { id: 'question-1', text: 'Read outside the worktree?', choices: ['Yes', 'No'], source: 'structured' } }));
    expect(delivered.map(notification => notification.kind)).toEqual(['question']);
    coordinator.stop();
  });

  // sibling activity must not fabricate a new completed turn after dismissal
  it('keeps each agent completion independent across unchanged worktree polls', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);
    const working = agent({ title: '⠋ Working' });
    const sibling = agent({ id: 'socket:%2', pane: { paneId: '%2', sessionId: '$1', socketFingerprint: 'socket' }, title: 'Ready' });
    coordinator.observe(agent({ id: sibling.id, pane: sibling.pane, title: '⠋ Working' }));
    coordinator.observe(sibling);
    await vi.advanceTimersByTimeAsync(2_000);
    coordinator.view(sibling, coordinator.completionId(sibling));

    coordinator.observe(working);
    coordinator.observe(sibling);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(coordinator.isUnread(sibling)).toBe(false);
    expect(delivered).toHaveLength(1);
    coordinator.observe(agent());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(coordinator.isUnread(working)).toBe(true);
    expect(coordinator.isUnread(sibling)).toBe(false);
    coordinator.view(sibling);
    expect(coordinator.isUnread(working)).toBe(true);
    coordinator.stop();
  });

  // an old browser dismissal must neither cancel nor clear a newer completion
  it('ignores delayed dismissals for an earlier completed turn', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);
    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent());
    await vi.advanceTimersByTimeAsync(2_000);
    const firstId = coordinator.completionId(agent());

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent());
    coordinator.view(agent(), firstId);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delivered).toHaveLength(2);
    const secondId = coordinator.completionId(agent());
    expect(secondId).toEqual(expect.any(String));
    expect(secondId).not.toBe(firstId);

    coordinator.view(agent(), firstId);
    expect(coordinator.completionId(agent())).toBe(secondId);
    coordinator.view(agent());
    expect(coordinator.completionId(agent())).toBe(secondId);
    coordinator.view(agent(), secondId);
    expect(coordinator.isUnread(agent())).toBe(false);
    coordinator.stop();
  });

  // delayed visits during grace must not cancel a subsequent turn's grace timer
  it('identifies pending completions before accepting a dismissal', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);
    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent());
    const firstId = coordinator.completionId(agent());
    expect(firstId).toEqual(expect.any(String));
    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent());
    const secondId = coordinator.completionId(agent());
    expect(secondId).not.toBe(firstId);

    coordinator.view(agent(), firstId);
    coordinator.view(agent());
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toHaveLength(1);
    expect(coordinator.completionId(agent())).toBe(secondId);
    expect(coordinator.isUnread(agent())).toBe(true);
    coordinator.stop();
  });

  it('clears the unread completion when a queued prompt starts', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(coordinator.isUnread(agent())).toBe(true);

    coordinator.observe(agent({ title: '⠙ Working' }));

    expect(coordinator.isUnread(agent())).toBe(false);
    coordinator.stop();
  });

  it('does not mark a completion unread when it is viewed during the grace period', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    coordinator.view(agent(), coordinator.completionId(agent()));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(coordinator.isUnread(agent())).toBe(false);
    expect(delivered).toEqual([]);
    coordinator.stop();
  });

  it('cancels pending completion when the agent disappears', async () => {
    vi.useFakeTimers();
    const delivered: AgentNotification[] = [];
    const coordinator = new AgentNotificationCoordinator(notification => delivered.push(notification), 2_000);

    coordinator.observe(agent({ title: '⠋ Working' }));
    coordinator.observe(agent({ title: 'Ready' }));
    coordinator.retain([]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delivered).toEqual([]);
    coordinator.stop();
  });
});
