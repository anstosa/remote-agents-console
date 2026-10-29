import type { Agent, StackProcessState } from './domain/models.js';
import type { AgentNotificationContext } from './notifications.js';

/** One Agent as a dashboard snapshot saw it: whether prompts wait for it, its names, and whether its Turn is one another Agent or the console started. */
export type ObservedAgent = { agent: Agent; queued: boolean; context: AgentNotificationContext; quiet: boolean };

/**
 * What happens in the console (ADR 0019): each dashboard snapshot's Agents and Stack processes,
 * whose consecutive snapshots subscribers diff, and what a job finished: a review that is ready, or a Schedule Run
 * that needs the operator (skipped, failed, timed out, or ended asking).
 */
export type ConsoleEvent =
  | { type: 'agents'; agents: ObservedAgent[] }
  | { type: 'stack'; worktrees: Array<{ worktreeId: string; processes: StackProcessState[] }> }
  | { type: 'review-ready'; agentId: string; worktreeId: string; projectName: string; worktreeName: string }
  | { type: 'schedule-run'; status: 'skipped' | 'failed' | 'needs-input' | 'timed-out'; targetLabel: string; noteId: string; noteTitle?: string; detail?: string; agentId?: string; worktreeId?: string };

type Listener<T extends ConsoleEvent['type']> = (event: Extract<ConsoleEvent, { type: T }>) => void;

/** The console's one event emitter: push notifications are its first subscriber. */
export class ConsoleEvents {
  private readonly listeners = new Set<{ type: ConsoleEvent['type']; listener: (event: never) => void }>();

  on<T extends ConsoleEvent['type']>(type: T, listener: Listener<T>): () => void {
    const entry = { type, listener: listener as (event: never) => void };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }

  // a subscriber that throws never keeps the event from the others
  emit(event: ConsoleEvent): void {
    for (const { type, listener } of [...this.listeners]) {
      if (type !== event.type) continue;
      try { listener(event as never); } catch (error) { console.error(`[events] a ${event.type} subscriber failed:`, error); }
    }
  }
}
