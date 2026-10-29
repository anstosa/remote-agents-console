import type { AgentKind } from '../adapters/types.js';

/**
 * The seam between the console and an Agent (ADR 0015). An Agent carries a Transport beside its
 * kind: `tmux` drives the CLI's TUI in a pane, `structured` exchanges messages with the CLI.
 * Console-owned state (the queue, history, notifications, Notes) stays above the seam, keyed by
 * Agent id; a Transport only delivers and reports.
 */
export type Transport = 'tmux' | 'structured';
/** What an Agent's Panel shows: its pane's terminal, or a transcript of its Turns. */
export type AgentPanel = 'terminal' | 'transcript';
export const agentPanel = (transport: Transport): AgentPanel => transport === 'tmux' ? 'terminal' : 'transcript';

/** One step of a Turn as its Transport observes it; `settled` carries the last assistant message. */
export type TurnEvent = { type: 'started' } | { type: 'settled'; message: string } | { type: 'failed' } | { type: 'aborted' };
/** An answer to an Inline question: a choice's index, text, or dismissing the question. */
export type QuestionAnswer = number | string | { dismiss: true };
export type InterruptOutcome = 'ok' | 'unavailable' | 'not-working';
/** `unsent` reached nothing; `stuck` may have left the name unsubmitted in the composer. */
export type RenameOutcome = 'sent' | 'unavailable' | 'busy' | 'unsent' | 'stuck';
/**
 * A Conversation to switch an Agent to: its kind and id, homed in the Worktree `worktreeId`, chosen
 * at the console's mutation generation `chosenAt` (a later mutation refuses the switch).
 */
export type ConversationTarget = { kind: AgentKind; id: string; worktreeId: string; chosenAt: number };
/** The Agent now on the Conversation (a new one when the switch restarted it), or why there is none. */
export type SwitchOutcome = { status: 'switched'; agentId: string } | { status: 'unavailable' | 'busy' | 'failed' | 'timed-out'; error: string };

/**
 * The operations every Transport performs on an Agent it looks up by id. `answer` and `rename`
 * take the Agent's input reservation (refused during a restart); `interrupt`, `close` and
 * `newConversation` do not, and prompt delivery runs under the reservation its caller holds.
 */
export interface AgentTransport {
  answer(agentId: string, questionId: string, answer: QuestionAnswer): Promise<boolean>;
  interrupt(agentId: string): Promise<InterruptOutcome>;
  close(agentId: string): Promise<boolean>;
  rename(agentId: string, name: string): Promise<RenameOutcome>;
  newConversation(agentId: string): Promise<boolean>;
  switchConversation(agentId: string, to: ConversationTarget): Promise<SwitchOutcome>;
}
