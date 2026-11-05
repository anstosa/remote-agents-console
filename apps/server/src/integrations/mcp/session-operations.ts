import type { Agent, Worktree } from '../../domain/models.js';
import type { IntegrationPrincipal } from '../auth/index.js';
import type { McpFileTransferService } from '../../host-files/mcp-transfer.js';
import type { HostFilesOwnerContext } from '../../host-files/contracts.js';
import type { PromptService } from '../../prompts/service.js';
import { validIntegrationPrompt } from '../../orchestration/service.js';
import { validPrompt, type PromptAttachment } from '../../prompts/validation.js';
import type { AgentToolPorts } from './agent-tools.js';
import { developerFailure, developerSuccess, type DeveloperResult } from './developer-tool.js';

export type DeveloperConversation = { id: string; kind: Agent['kind']; name?: string; lastActiveAt: number; current: boolean; exited?: boolean };
export type SessionOperationDependencies = {
  resolveAgent: (principal: IntegrationPrincipal, agentId: string, access: 'read' | 'mutate') => Promise<{ agent: Agent; worktree?: Worktree } | undefined>;
  conversations: (agent: Agent) => Promise<DeveloperConversation[]>;
  switchConversation: (agent: Agent, conversation: DeveloperConversation) => Promise<boolean>;
  forgetConversation: (agent: Agent, conversation: DeveloperConversation) => Promise<boolean>;
  prompts: Pick<PromptService, 'submitFrom' | 'inFlight' | 'steer' | 'answerQuestion'>;
  transfers: McpFileTransferService;
  owner: (principal: IntegrationPrincipal) => HostFilesOwnerContext | undefined;
};

// retain bounded opaque paging without widening conversation scope
function offsetOf(cursor: unknown): number | undefined {
  // the first page has no cursor
  if (cursor === undefined) return 0;
  // reject anything outside the server's offset encoding
  if (typeof cursor !== 'string') return undefined;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^\d{1,10}$/u.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
}

// use the existing queue and conversation engines through first-class principal guards
export function createSessionOperations(deps: SessionOperationDependencies): AgentToolPorts {
  return {
    // conversation reads are Place-scoped even when state changes are owner-scoped
    list_conversations: async (input, principal) => {
      const target = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      // no row or count reveals a hidden target
      if (target === undefined) return developerFailure('not_found', 'Agent not found.');
      const rows = await deps.conversations(target.agent);
      const offset = offsetOf(input.cursor);
      // refuse stale or malformed cursors before projecting rows
      if (offset === undefined || offset > rows.length) return developerFailure('invalid_request', 'Invalid conversation cursor.');
      const items: unknown[] = [];
      const limit = typeof input.limit === 'number' ? input.limit : 50;
      // never exceed the collection's item or serialized-byte boundary
      for (const row of rows.slice(offset)) {
        const item = { id: row.id, ...(row.name === undefined ? {} : { name: row.name.slice(0, 120) }), active: row.current, exited: row.exited ?? !row.current, updated_at: new Date(row.lastActiveAt).toISOString() };
        // leave the next row for a subsequent bounded page
        if (items.length >= limit || Buffer.byteLength(JSON.stringify([...items, item])) > 48_000) break;
        items.push(item);
      }
      const next = offset + items.length;
      return developerSuccess({ items, ...(next < rows.length ? { next_cursor: Buffer.from(String(next)).toString('base64url') } : {}), truncated: next < rows.length });
    },
    // switching validates the selected conversation against the target's current allowed roots
    switch_conversation: async (input, principal) => {
      const target = await deps.resolveAgent(principal, input.agent_id as string, 'mutate');
      // state changes never borrow another Conductor's worker
      if (target === undefined) return developerFailure('not_found', 'Agent not found.');
      const conversation = (await deps.conversations(target.agent)).find(row => row.id === input.conversation_id);
      // no arbitrary provider path or unknown conversation can be resumed
      if (conversation === undefined) return developerFailure('not_found', 'Conversation not found.');
      return await deps.switchConversation(target.agent, conversation) ? developerSuccess({ conversation_id: conversation.id, active: true, queue_preserved: true }) : developerFailure('invalid_state', 'The agent cannot switch this conversation now.', true);
    },
    // forgetting removes only RAC's own record, never provider history
    forget_conversation: async (input, principal) => {
      const target = await deps.resolveAgent(principal, input.agent_id as string, 'mutate');
      // preserve the same state-change ownership rule as switches and renames
      if (target === undefined) return developerFailure('not_found', 'Agent not found.');
      const conversation = (await deps.conversations(target.agent)).find(row => row.id === input.conversation_id);
      // a foreign or stale record is not an existence oracle
      if (conversation?.current === true) return developerFailure('active_conversation', 'The active conversation cannot be forgotten.');
      // only a visible inactive console record may be removed
      if (conversation === undefined || !await deps.forgetConversation(target.agent, conversation)) return developerFailure('not_found', 'Conversation record not found.');
      return developerSuccess({ conversation_id: conversation.id, forgotten_console_record: true, provider_history_deleted: false });
    },
    // uploaded capabilities are dereferenced as their authenticated owner before queuing
    queue_prompt_with_attachments: async (input, principal) => {
      const target = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      const owner = deps.owner(principal);
      // C may send to a visible non-self target, not only its own workers
      if (target === undefined || owner === undefined || principal.authentication === 'conductor' && target.agent.id === principal.subjectId) return developerFailure('not_found', 'Agent not found.');
      // current structured adapters do not accept attachments; never silently drop them
      if (target.agent.transport === 'structured') return developerFailure('capability_not_supported', 'This agent does not accept attachments.');
      const refs = input.attachments as Array<{ object_token: string; name: string; size: number }>;
      // reject shell-mode and forged labelled prompts as the existing integration does
      if (!validIntegrationPrompt(input.prompt as string) || refs.reduce((total, ref) => total + ref.size, 0) > 25 * 1024 * 1024) return developerFailure('invalid_request', 'Invalid prompt or attachment total.');
      const attachments: PromptAttachment[] = [];
      // keep the existing prompt attachment aggregate as the only materialized body
      for (const ref of refs) {
        const chunks: Buffer[] = [];
        let offset = 0;
        let finished = false;
        // read bounded chunks and stop at the capability's declared total
        while (!finished) {
          const chunk = await deps.transfers.download(owner, ref.object_token, offset);
          const bytes = Buffer.from(chunk.data_base64, 'base64');
          // changed objects and non-progressing downloads cannot be queued
          if (offset + bytes.length > ref.size || !chunk.eof && bytes.length === 0) return developerFailure('target_changed', 'Attachment changed before dispatch.');
          chunks.push(bytes); offset += bytes.length; finished = chunk.eof;
        }
        // a forged size cannot truncate or extend the referenced file
        if (offset !== ref.size) return developerFailure('target_changed', 'Attachment size changed.');
        attachments.push({ name: ref.name, data: Buffer.concat(chunks).toString('base64') });
      }
      // apply the actual adapter-independent prompt validation to the resolved content
      if (!validPrompt(input.prompt as string, attachments)) return developerFailure('invalid_request', 'Invalid prompt attachments.');
      const id = await deps.prompts.submitFrom(target.agent.id, input.prompt as string, principal.authentication === 'conductor' ? { from: principal.subjectId } : {}, attachments);
      return id === undefined ? developerFailure('invalid_state', 'Prompt could not be queued.', true) : developerSuccess({ accepted: true, prompt_id: id });
    },
    // steering preserves ownership of the currently dispatched Turn rather than the Agent
    steer_agent: async (input, principal) => {
      const target = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      const dispatched = target === undefined ? undefined : deps.prompts.inFlight(target.agent.id);
      // a Conductor may steer only the exact Turn it dispatched
      if (target === undefined || principal.authentication === 'conductor' && dispatched?.sender.from !== principal.subjectId) return developerFailure('not_found', 'Turn not found.');
      // steering cannot become a new raw shell entry point
      if (!validIntegrationPrompt(input.text as string)) return developerFailure('invalid_request', 'Invalid steering text.');
      return await deps.prompts.steer(target.agent.id, input.text as string, principal.authentication !== 'conductor' || dispatched === undefined ? undefined : { promptId: dispatched.promptId, from: principal.subjectId }) === 'sent' ? developerSuccess({ accepted: true, steered: true }) : developerFailure('capability_not_supported', 'This turn cannot be steered.');
    },
    // only a current authenticated Davo lease can relay one explicit question answer
    relay_agent_question_answer: async (input, principal): Promise<DeveloperResult> => {
      // never let the Conductor approve for the user
      if (principal.authentication !== 'realtime' || principal.leaseKey === undefined) return developerFailure('approval_required', 'A current Davo lease is required.');
      const target = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      // exact question identity is rechecked by the existing prompt service
      if (target === undefined) return developerFailure('not_found', 'Agent not found.');
      const relayed = input.index !== undefined ? 'index' : input.text !== undefined ? 'text' : 'dismiss';
      const answer = relayed === 'index' ? input.index as number : relayed === 'text' ? input.text as string : { dismiss: true as const };
      return await deps.prompts.answerQuestion(target.agent.id, input.question_id as string, answer) ? developerSuccess({ answered: true, relayed }) : developerFailure('target_changed', 'The exact question is no longer active.');
    }
  };
}
