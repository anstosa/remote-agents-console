import { randomUUID } from 'node:crypto';
import { isReviewRun, type Agent } from './domain/models.js';
import type { AttentionState } from './adapters/types.js';

export type AgentAttentionState = AttentionState;
export type AgentNotificationContext = {
  projectName: string;
  worktreeName: string;
  multipleWorktrees: boolean;
};
export type AgentNotification = {
  kind: 'question' | 'finished';
  title: string;
  body: string;
  tag: string;
  url: string;
  worktreeId?: string;
};
export type CleanupNotification = {
  kind: 'cleanup';
  title: string;
  body: string;
  tag: 'runtime-cleanup';
  url: '/#cleanup';
};
export type ReviewNotification = {
  kind: 'review';
  title: string;
  body: string;
  tag: string;
  url: string;
  worktreeId: string;
};
export type ScheduleNotification = {
  kind: 'schedule';
  title: string;
  body: string;
  tag: string;
  url: string;
  worktreeId?: string;
};
export type ConductorNotification = { kind: 'conductor'; title: string; body: string; tag: string; url: string };
export type PushMessage = AgentNotification | CleanupNotification | ReviewNotification | ScheduleNotification | ConductorNotification;

type NotificationDelivery = (notification: AgentNotification) => void | Promise<void>;

// Attention is resolved once, server-side, in DiscoveryService (ADR 0001/0002);
// every consumer, including this coordinator, reads that resolved state.
export function agentAttentionState(agent: Pick<Agent, 'attention'>): AgentAttentionState {
  return agent.attention;
}

// promote latest-message questions only on presentation surfaces
export function agentPresentationAttentionState(agent: Pick<Agent, 'attention' | 'hasMessageQuestion'>): AgentAttentionState {
  return agent.attention === 'finished' && agent.hasMessageQuestion === true ? 'question' : agent.attention;
}

export const agentNotificationTag = (agent: Pick<Agent, 'id' | 'worktreeId'>) => agent.worktreeId === undefined ? `agent-status-${agent.id}` : `worktree-status-${agent.worktreeId}`;

// build one review-ready push payload
export function reviewNotification(agentId: string, worktreeId: string, projectName: string, worktreeName: string): ReviewNotification {
  return { kind: 'review', title: `Review ready in ${projectName}`, body: `${worktreeName} is ready for review`, tag: `review-ready-${worktreeId}`, url: `/#agent=${encodeURIComponent(agentId)}`, worktreeId };
}

// build one skipped/failed scheduled-Run push payload. The url deep-links to the agent when the Run has a
// pane, else to the Worktree for a Worktree target, else the console root. `worktreeId` is carried for
// Worktree targets, and the service worker prefers it over the url — so a Worktree Run always opens the
// Worktree (as agent notifications do), while a Scratch/Project Run with a pane uses the /#agent url. A
// launched Run sends nothing, so only skipped and failed reach here.
// a closed managed Run drops its agentId (there is no pane to open), so `needs-input`/`timed-out`
// fall back to the Worktree or console root exactly as a pane-less skip does
const scheduleStatusLabel: Record<'skipped' | 'failed' | 'needs-input' | 'timed-out', string> = {
  skipped: 'skipped',
  failed: 'failed',
  'needs-input': 'needs input',
  'timed-out': 'timed out'
};
export function scheduleNotification(params: {
  status: 'skipped' | 'failed' | 'needs-input' | 'timed-out';
  targetLabel: string;
  noteId: string;
  noteTitle?: string;
  detail?: string;
  agentId?: string;
  worktreeId?: string;
}): ScheduleNotification {
  const { status, targetLabel, noteId, noteTitle, detail, agentId, worktreeId } = params;
  const url = agentId !== undefined
    ? `/#agent=${encodeURIComponent(agentId)}`
    : worktreeId !== undefined ? `/#worktree=${encodeURIComponent(worktreeId)}` : '/';
  return {
    kind: 'schedule',
    title: `Scheduled run ${scheduleStatusLabel[status]} in ${targetLabel}`,
    body: `${noteTitle ?? 'Untitled note'}${detail === undefined ? '' : ` · ${detail}`}`,
    tag: `schedule-${noteId}`,
    url,
    ...(worktreeId === undefined ? {} : { worktreeId })
  };
}

// build one agent-state push payload
export function agentNotification(previous: AgentAttentionState | undefined, current: AgentAttentionState, agent: Agent, context?: AgentNotificationContext): AgentNotification | undefined {
  if (previous === undefined || previous === current) return undefined;
  const fallbackName = agent.displayLabel ?? agent.home.split('/').filter(Boolean).at(-1) ?? agent.title;
  const projectName = context?.projectName ?? fallbackName;
  const worktreeName = context?.worktreeName ?? fallbackName;
  const shared = { tag: agentNotificationTag(agent), url: `/#agent=${encodeURIComponent(agent.id)}`, ...(agent.worktreeId === undefined ? {} : { worktreeId: agent.worktreeId }) };
  if (current === 'question') {
    const body = agent.question === undefined
      ? `${worktreeName}: has a question`
      : `${context?.multipleWorktrees === true ? `${worktreeName}: ` : ''}${agent.question.text}`;
    return {
      ...shared,
      kind: 'question',
      title: `Question in ${projectName}`,
      body
    };
  }
  // a Review run's Agent finishing is covered by the tour's own ready state (ADR 0010); its question still notifies
  if (previous === 'working' && current === 'finished' && !isReviewRun(agent)) {
    return { ...shared, kind: 'finished', title: `Done working in ${projectName}`, body: `${worktreeName} is ready for a new prompt` };
  }
  return undefined;
}

export class AgentNotificationCoordinator {
  private readonly states = new Map<string, AgentAttentionState>();
  private readonly pendingCompletions = new Map<string, { id: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly unread = new Map<string, string>();

  constructor(private readonly deliver: NotificationDelivery, private readonly completionDelayMs = 2_000) {}

  // track each agent independently even when several share one workspace
  observe(agent: Agent, hasQueuedPrompt = false, context?: AgentNotificationContext): void {
    const key = agent.id;
    const current = agentPresentationAttentionState(agent);
    const previous = this.states.get(key);
    this.states.set(key, current);

    // suppress intermediate queue completions
    if (current === 'finished' && hasQueuedPrompt) {
      this.cancelCompletion(key);
      this.unread.delete(key);
      return;
    }
    if (current !== 'finished') {
      this.cancelCompletion(key);
      this.unread.delete(key);
    }
    const notification = agentNotification(previous, current, agent, context);
    if (notification === undefined) return;
    if (notification.kind === 'question') {
      this.deliverSafely(notification);
      return;
    }

    this.cancelCompletion(key);
    // identify the turn during grace so an early view can dismiss only this turn
    const id = randomUUID();
    // promote the same identified turn after its grace period
    const timer = setTimeout(() => {
      this.pendingCompletions.delete(key);
      if (this.states.get(key) !== 'finished') return;
      this.unread.set(key, id);
      this.deliverSafely(notification);
    }, this.completionDelayMs);
    this.pendingCompletions.set(key, { id, timer });
  }

  // expose unread state only for the agent whose turn finished
  isUnread(agent: Pick<Agent, 'id'>): boolean {
    return this.unread.has(agent.id);
  }

  // identify the completion so clients can reject replayed unread snapshots
  completionId(agent: Pick<Agent, 'id'>): string | undefined {
    return this.unread.get(agent.id) ?? this.pendingCompletions.get(agent.id)?.id;
  }

  // dismiss only the completed turn the browser actually viewed
  view(agent: Pick<Agent, 'id'>, completionId?: string): void {
    // a stale dismissal must not clear or cancel a newer completed turn
    if (completionId === undefined || this.completionId(agent) !== completionId) return;
    this.unread.delete(agent.id);
    this.cancelCompletion(agent.id);
  }

  // retire removed agents without transferring their state to replacements
  retain(agents: Iterable<Pick<Agent, 'id'>>): void {
    const retained = new Set(Array.from(agents, agent => agent.id));
    // clear state and timers belonging to removed panes
    for (const key of this.states.keys()) {
      if (retained.has(key)) continue;
      this.cancelCompletion(key);
      this.states.delete(key);
      this.unread.delete(key);
    }
  }

  // release timers and unread identities when the coordinator stops
  stop(): void {
    // cancel every pending turn
    for (const pending of this.pendingCompletions.values()) clearTimeout(pending.timer);
    this.pendingCompletions.clear();
    this.unread.clear();
  }

  // cancel only the identified pending turn for this agent
  private cancelCompletion(agentId: string): void {
    const pending = this.pendingCompletions.get(agentId);
    // leave agents without a pending turn unchanged
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingCompletions.delete(agentId);
  }

  private deliverSafely(notification: AgentNotification): void {
    void Promise.resolve(this.deliver(notification)).catch(() => {});
  }
}
