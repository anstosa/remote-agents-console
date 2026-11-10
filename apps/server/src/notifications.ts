import { randomUUID } from 'node:crypto';
import { isReviewRun, type Agent } from './domain/models.js';
import type { AttentionState } from './adapters/types.js';
import type { ConsoleEvents } from './events.js';
import { agentLogicalTag, createAgentNotificationEvent, type NotificationEvent, type NotificationState } from './notification-events.js';

export type AgentAttentionState = AttentionState;
export type AgentNotificationContext = {
  projectName: string;
  worktreeName: string;
  multipleWorktrees: boolean;
};
export type AgentNotificationContent = {
  kind: 'question' | 'finished';
  title: string;
  body: string;
  tag: string;
  url: string;
  worktreeId?: string;
};
export type AgentNotification = NotificationEvent & Pick<AgentNotificationContent, 'title' | 'body'>;
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
export type DavoNotification = { kind: 'davo'; title: 'Davo update'; body: 'Your request is complete' | 'Your input is needed'; tag: string; url: '/#davo' };
export type PushMessage = AgentNotification | CleanupNotification | ReviewNotification | ScheduleNotification | ConductorNotification | DavoNotification;

type NotificationDelivery = (notification: AgentNotification) => void | Promise<void>;
// retain current ordinary-delivery authority per agent
type NotificationDeliveryPolicy = { davoOwned: boolean; suppressed: boolean };

// Attention is resolved once, server-side, in DiscoveryService (ADR 0001/0002);
// every consumer, including this coordinator, reads that resolved state.
export function agentAttentionState(agent: Pick<Agent, 'attention'>): AgentAttentionState {
  return agent.attention;
}

// promote latest-message questions only on presentation surfaces
export function agentPresentationAttentionState(agent: Pick<Agent, 'attention' | 'hasMessageQuestion'>): AgentAttentionState {
  return agent.attention === 'finished' && agent.hasMessageQuestion === true ? 'question' : agent.attention;
}

// scope coalescing to one Agent even when Agents share a Worktree
export const agentNotificationTag = (agent: Pick<Agent, 'id'>) => agentLogicalTag(agent.id);

// build one review-ready push payload
export function reviewNotification(worktreeId: string, projectName: string, worktreeName: string): ReviewNotification {
  return { kind: 'review', title: `Review ready in ${projectName}`, body: `${worktreeName} is ready for review`, tag: `review-ready-${worktreeId}`, url: `/#worktree=${encodeURIComponent(worktreeId)}`, worktreeId };
}

// build one generic event-bound Davo outcome payload
export function davoNotification(eventId: string, outcome: 'done' | 'choice'): DavoNotification {
  return {
    kind: 'davo',
    title: 'Davo update',
    body: outcome === 'done' ? 'Your request is complete' : 'Your input is needed',
    tag: `davo-${eventId}`,
    url: '/#davo'
  };
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
export function agentNotification(previous: AgentAttentionState | undefined, current: AgentAttentionState, agent: Agent, context?: AgentNotificationContext): AgentNotificationContent | undefined {
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
  private readonly semanticStates = new Map<string, string>();
  private readonly pendingCompletions = new Map<string, { id: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly unread = new Map<string, string>();
  private readonly events = new Map<string, NotificationEvent>();
  private readonly revisions = new Map<string, NotificationState>();
  private readonly deliveryPolicies = new Map<string, NotificationDeliveryPolicy>();
  private readonly eventEpoch = randomUUID();
  private eventSequence = 0;

  constructor(private readonly deliver: NotificationDelivery, private readonly completionDelayMs = 2_000) {}

  // track each agent independently even when several share one workspace; a `quiet` Turn (one
  // another Agent or the console started) still marks its end unread but pushes nothing
  observe(agent: Agent, hasQueuedPrompt = false, context?: AgentNotificationContext, quiet = false, davoOwned = false): void {
    const key = agent.id;
    const current = agentPresentationAttentionState(agent);
    const previous = this.states.get(key);
    const semantic = current === 'question' ? `question:${agent.question?.id ?? 'message'}` : current;
    const previousSemantic = this.semanticStates.get(key);
    const previousPolicy = this.deliveryPolicies.get(key);
    const requestedSuppression = davoOwned || current === 'finished' && (quiet || hasQueuedPrompt);
    // never unsuppress an already identified event on an unchanged snapshot
    const retainedSuppression = previousSemantic === semantic && this.events.has(key) && previousPolicy?.suppressed === true;
    const suppressed = requestedSuppression || retainedSuppression;
    const policy = { davoOwned, suppressed };
    const policyChanged = previousPolicy?.davoOwned !== policy.davoOwned || previousPolicy?.suppressed !== policy.suppressed;
    this.states.set(key, current);
    this.semanticStates.set(key, semantic);
    this.deliveryPolicies.set(key, policy);

    // seed process-local state without replaying a startup snapshot
    if (previousSemantic === undefined) {
      this.advanceRevision(key);
      return;
    }
    // cancel a completion when queued work appears on an unchanged finished poll
    if (current === 'finished' && hasQueuedPrompt) {
      const hadCompletion = this.completionId(agent) !== undefined;
      this.cancelCompletion(key);
      this.unread.delete(key);
      this.events.delete(key);
      // publish the queue-driven relevance change exactly once
      if (previousSemantic !== semantic || hadCompletion || policyChanged) this.advanceRevision(key);
      return;
    }
    // ignore unchanged polling snapshots
    if (previousSemantic === semantic) {
      // publish a policy-only ownership change to dashboard subscribers
      if (policyChanged) this.advanceRevision(key);
      return;
    }
    const revision = this.advanceRevision(key);
    this.events.delete(key);

    // suppress intermediate queue completions
    if (current !== 'finished') {
      this.cancelCompletion(key);
      this.unread.delete(key);
    }
    const notification = agentNotification(previous === current && current === 'question' ? 'working' : previous, current, agent, context);
    if (notification === undefined) return;
    if (notification.kind === 'question') {
      const event = this.eventFor(agent, notification, agent.question?.id ?? randomUUID(), revision);
      this.events.set(key, event);
      // davo surfaces only an exact correlated human choice through its own outbox
      if (!davoOwned) this.deliverSafely({ ...notification, ...event });
      return;
    }

    this.cancelCompletion(key);
    // identify the turn during grace so an early view can dismiss only this turn
    const id = randomUUID();
    const event = this.eventFor(agent, notification, id, revision);
    this.events.set(key, event);
    // promote the same identified turn after its grace period
    const timer = setTimeout(() => {
      this.pendingCompletions.delete(key);
      // discard a completion superseded during its grace period
      if (this.states.get(key) !== 'finished') return;
      this.unread.set(key, id);
      const currentPolicy = this.deliveryPolicies.get(key);
      // suppress current Davo ownership explicitly, including when policy changed during grace
      if (currentPolicy?.davoOwned !== true && currentPolicy?.suppressed !== true) this.deliverSafely({ ...notification, ...event });
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

  // expose the current exact event for authoritative reconciliation
  notificationEvent(agent: Pick<Agent, 'id'>): NotificationEvent | undefined {
    return this.events.get(agent.id);
  }

  // expose freshness even when the current state is not alertable
  notificationState(agent: Pick<Agent, 'id'>): NotificationState | undefined {
    return this.revisions.get(agent.id);
  }

  // expose the exact ordinary-delivery policy for the current snapshot
  notificationSuppressed(agent: Pick<Agent, 'id'>): boolean {
    return this.deliveryPolicies.get(agent.id)?.suppressed ?? false;
  }

  // dismiss only the completed turn the browser actually viewed
  view(agent: Pick<Agent, 'id'>, completionId?: string): void {
    // a stale dismissal must not clear or cancel a newer completed turn
    if (completionId === undefined || this.completionId(agent) !== completionId) return;
    this.unread.delete(agent.id);
    this.cancelCompletion(agent.id);
    this.events.delete(agent.id);
    this.advanceRevision(agent.id);
  }

  // retire removed agents without transferring their state to replacements
  retain(agents: Iterable<Pick<Agent, 'id'>>): void {
    const retained = new Set(Array.from(agents, agent => agent.id));
    // clear state and timers belonging to removed panes
    for (const key of this.states.keys()) {
      if (retained.has(key)) continue;
      this.cancelCompletion(key);
      this.states.delete(key);
      this.semanticStates.delete(key);
      this.unread.delete(key);
      this.events.delete(key);
      this.revisions.delete(key);
      this.deliveryPolicies.delete(key);
    }
  }

  // release timers and unread identities when the coordinator stops
  stop(): void {
    // cancel every pending turn
    for (const pending of this.pendingCompletions.values()) clearTimeout(pending.timer);
    this.pendingCompletions.clear();
    this.unread.clear();
    this.events.clear();
    this.deliveryPolicies.clear();
  }

  // cancel only the identified pending turn for this agent
  private cancelCompletion(agentId: string): void {
    const pending = this.pendingCompletions.get(agentId);
    // leave agents without a pending turn unchanged
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingCompletions.delete(agentId);
  }

  // allocate one comparable revision within this process epoch
  private advanceRevision(agentId: string): NotificationState {
    this.eventSequence += 1;
    const revision = { eventEpoch: this.eventEpoch, eventSequence: this.eventSequence };
    this.revisions.set(agentId, revision);
    return revision;
  }

  // bind visible content to one stable event identity and revision
  private eventFor(agent: Agent, notification: AgentNotificationContent, eventId: string, revision: NotificationState): NotificationEvent {
    return createAgentNotificationEvent({
      agentId: agent.id,
      eventId,
      eventEpoch: revision.eventEpoch,
      eventSequence: revision.eventSequence,
      generatedAt: Date.now(),
      kind: notification.kind,
      url: notification.url,
      ...(notification.worktreeId === undefined ? {} : { worktreeId: notification.worktreeId })
    });
  }

  // isolate delivery failures from observation state
  private deliverSafely(notification: AgentNotification): void {
    void Promise.resolve(this.deliver(notification)).catch(() => {});
  }
}

/**
 * Push notifications, the console events' first subscriber (ADR 0019): each snapshot's Agents
 * through the coordinator, which diffs them, a ready review, and a Schedule Run that needs the operator.
 */
export function pushNotifications(events: ConsoleEvents, coordinator: AgentNotificationCoordinator, deliver: (message: PushMessage) => Promise<void>): void {
  const send = (message: PushMessage) => { void deliver(message).catch(() => undefined); };
  events.on('agents', ({ agents }) => {
    for (const { agent, queued, context, quiet, davoOwned } of agents) coordinator.observe(agent, queued, context, quiet, davoOwned);
    coordinator.retain(agents.map(({ agent }) => agent));
  });
  events.on('review-ready', ({ worktreeId, projectName, worktreeName }) => send(reviewNotification(worktreeId, projectName, worktreeName)));
  events.on('schedule-run', ({ type: _type, ...run }) => send(scheduleNotification(run)));
}
