import type { ReplyPane } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';
import { isReviewAgentKind, reviewRunsFor } from './kinds.js';

// the discovered pane facts an interactive Review run's reply is read through (DiscoveryService)
export type ReplySources = {
  target(id: string, force?: boolean): Promise<{ agent: Agent } | undefined>;
  paneProcessId(id: string): number | undefined;
  paneWorkingDirectory(id: string): string | undefined;
  paneDirectory(id: string): string | undefined;
};

// the pane as its kind's reply reader sees it; `fresh` rescans the panes for the reported Conversation
function replyPane(sources: ReplySources, agentId: string, fresh: boolean): ReplyPane {
  const [pid, cwd] = [sources.paneProcessId(agentId), sources.paneWorkingDirectory(agentId)];
  return { ...(pid === undefined ? {} : { pid }), ...(cwd === undefined ? {} : { cwd }), conversationId: async () => (await sources.target(agentId, fresh))?.agent.conversationId, directory: () => sources.paneDirectory(agentId) };
}

// Snapshot an interactive Review run's transcript before a prompt and return a reader for that
// turn's final message (ADR 0010), undefined until there is one. The snapshot pins the transcript
// by one fresh pane read; the reader's repeated reads take the discovery snapshot the dashboard poll
// keeps current. `maxBytes` bounds the reply (read one past it, so an over-long reply still reads as
// too long). An Agent of a kind that cannot run a Review run has no reply.
export async function beginReplyTurn(sources: ReplySources, agent: Pick<Agent, 'id' | 'kind'>, maxBytes: number): Promise<() => Promise<string | undefined>> {
  if (!isReviewAgentKind(agent.kind)) return async () => undefined;
  const { reply } = reviewRunsFor(agent.kind).interactive;
  const mark = await reply.mark(replyPane(sources, agent.id, true));
  return async () => await reply.since(replyPane(sources, agent.id, false), mark, maxBytes);
}

// The final message of the latest turn, read with no snapshot from before the prompt: the reply of
// an orphaned Review run, one a server restart forgot mid-run.
export async function latestReply(sources: ReplySources, agent: Pick<Agent, 'id' | 'kind'>, maxBytes: number): Promise<string | undefined> {
  if (!isReviewAgentKind(agent.kind)) return undefined;
  return await reviewRunsFor(agent.kind).interactive.reply.since(replyPane(sources, agent.id, true), undefined, maxBytes);
}
