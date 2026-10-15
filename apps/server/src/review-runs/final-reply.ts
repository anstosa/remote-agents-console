import { claudeLastAssistantText } from '../adapters/claude-conversations.js';
import { codexRolloutBaseline, codexTurnSince } from '../adapters/codex-conversations.js';
import type { CompletionBaseline } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';

// the discovered pane facts an interactive Review run's reply is read through (DiscoveryService)
export type ReplySources = {
  target(id: string, force?: boolean): Promise<{ agent: Agent } | undefined>;
  paneProcessId(id: string): number | undefined;
  paneWorkingDirectory(id: string): string | undefined;
  paneDirectory(id: string): string | undefined;
};

// the last assistant message of the Claude session the pane reports; `fresh` rescans the pane
async function claudeReply(sources: ReplySources, agentId: string, fresh: boolean): Promise<string | undefined> {
  const conversationId = (await sources.target(agentId, fresh))?.agent.conversationId;
  return conversationId === undefined ? undefined : await claudeLastAssistantText(conversationId, sources.paneDirectory(agentId));
}

// the pane's Codex rollout baseline: the exact fd-walk by pid, the unshared cwd as the fallback
async function codexBaseline(sources: ReplySources, agentId: string): Promise<CompletionBaseline | undefined> {
  const pid = sources.paneProcessId(agentId);
  if (pid === undefined) return undefined;
  const cwd = sources.paneWorkingDirectory(agentId);
  return await codexRolloutBaseline({ pid, ...(cwd === undefined ? {} : { cwd }) }).catch(() => undefined);
}

// the answer of the newest completed Codex turn past `before`, else from the start of the pane's rollout
async function codexReply(sources: ReplySources, agentId: string, before: CompletionBaseline | undefined, maxBytes: number): Promise<string | undefined> {
  const opened = before ?? await codexBaseline(sources, agentId);
  if (opened === undefined || !('rollout' in opened)) return undefined;
  const event = await codexTurnSince(before ?? { rollout: opened.rollout, ordinal: 0 }, maxBytes + 1).catch(() => undefined);
  return event?.kind === 'completed' ? event.answer : undefined;
}

// Snapshot an interactive Review run's transcript before a prompt and return a reader for that
// turn's final message (ADR 0010), undefined until there is one. Codex: the turn's
// `task_complete.last_agent_message` past the pre-prompt rollout ordinal; a fresh thread opens its
// rollout only at its first turn, so it is then read from the start once the pane holds it.
// Claude: the last assistant message of the reported session's transcript, once it differs from
// the one before the prompt. `maxBytes` bounds the Codex answer (one past it, so an over-long
// reply still reads as too long).
export async function beginReplyTurn(sources: ReplySources, agent: Pick<Agent, 'id' | 'kind'>, maxBytes: number): Promise<() => Promise<string | undefined>> {
  if (agent.kind === 'claude') {
    // the session is pinned by one fresh pane read before the prompt; the reader's repeated reads
    // take the discovery snapshot the dashboard poll keeps current
    const before = await claudeReply(sources, agent.id, true);
    return async () => { const text = await claudeReply(sources, agent.id, false); return text === before ? undefined : text; };
  }
  const before = await codexBaseline(sources, agent.id);
  return async () => await codexReply(sources, agent.id, before, maxBytes);
}

// The final message of the latest turn, read with no snapshot from before the prompt: the reply of
// an orphaned Review run, one a server restart forgot mid-run.
export async function latestReply(sources: ReplySources, agent: Pick<Agent, 'id' | 'kind'>, maxBytes: number): Promise<string | undefined> {
  return agent.kind === 'claude' ? await claudeReply(sources, agent.id, true) : await codexReply(sources, agent.id, undefined, maxBytes);
}
