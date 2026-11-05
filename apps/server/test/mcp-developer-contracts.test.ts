import { describe, expect, it } from 'vitest';
import { agentToolNames, createAgentTools, type AgentToolPorts } from '../src/integrations/mcp/agent-tools.js';
import { createWorkspaceTools, type WorkspaceToolsDependencies } from '../src/integrations/mcp/workspace-tools.js';
import { createWorkerTools, type DeveloperWorkerDependencies } from '../src/integrations/mcp/worker-tools.js';
import { validateToolSchema } from '../src/integrations/mcp/legacy-output.js';

// construct descriptors without running domain operations or external services
const ports = Object.fromEntries(agentToolNames.map(name => [name, async () => ({ ok: true, version: 'v2', value: {} })])) as AgentToolPorts;
const tools = [...createAgentTools(ports), ...createWorkspaceTools({} as WorkspaceToolsDependencies), ...createWorkerTools({} as DeveloperWorkerDependencies)];
const workspaceNames = [
  'list_agent_destinations', 'switch_branch', 'move_branch', 'move_pull_request',
  'assess_branch_removal', 'prepare_branch_removal', 'execute_branch_removal',
  'assess_worktree_removal', 'prepare_worktree_removal', 'execute_worktree_removal',
  'assess_worktree_prune', 'prepare_worktree_prune', 'execute_worktree_prune',
  'reply_github_thread', 'resolve_github_thread', 'rerequest_github_review', 'get_pull_request_draft', 'create_pull_request',
  'get_files_capabilities', 'list_files', 'preview_file_object', 'prepare_file_operation', 'prepare_confirmed_file_operation', 'execute_file_operation', 'get_file_operation',
  'begin_file_upload', 'upload_file_chunk', 'finalize_file_upload', 'get_file_transfer', 'cancel_file_transfer', 'download_file_chunk',
  'list_notes', 'create_note', 'update_note', 'delete_note', 'schedule_note', 'get_note', 'set_note_lock', 'set_note_visibility', 'delete_note_with_undo', 'undo_note_delete',
  'list_note_attachments', 'add_note_attachment', 'remove_note_attachment', 'list_schedule_targets', 'preview_note_schedule', 'set_note_schedule', 'remove_note_schedule', 'run_note_now',
  'list_configured_actions', 'resolve_configured_action', 'invoke_configured_action', 'get_configured_action_status',
  'watch_pull_request', 'watch_review_requests', 'watch_process', 'list_watches', 'unwatch', 'get_watch_events', 'ack_watch_events',
  'spawn_agent', 'close_agent', 'create_worktree'
];

describe('complete internal MCP descriptor inventory', () => {
  // freeze the developer surface while leaving the public OAuth catalog unchanged
  it('includes every planned operation with unambiguous audience projections', () => {
    expect(new Set(tools.map(tool => tool.name))).toEqual(new Set([...agentToolNames, ...workspaceNames]));
    const projections = tools.flatMap(tool => tool.audiences.map(audience => `${audience}:${tool.name}`));
    expect(new Set(projections).size).toBe(projections.length);
    expect(tools.every(tool => !tool.audiences.some(audience => (audience as string) === 'oauth'))).toBe(true);
  });
});

// compile each published schema using the same standard engine as contract validation
for (const tool of tools) {
  describe(`${tool.audiences.join('+')}:${tool.name}`, () => {
    // references, discriminated arms and exact error envelopes must all resolve
    it('publishes valid closed schemas and a complete typed failure envelope', () => {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema.type).toBe('object');
      expect(typeof validateToolSchema(tool.inputSchema, {})).toBe('boolean');
      expect(validateToolSchema(tool.inputSchema, { undeclared: 'value' })).toBe(false);
      const failure = { ok: false, contract_version: tool.contractVersion ?? 'v2', correlation_id: 'correlation', error: { code: 'not_found', message: 'Unavailable', retryable: false } };
      expect(validateToolSchema(tool.outputSchema, failure)).toBe(true);
      expect(validateToolSchema(tool.outputSchema, { ...failure, host_path: '/private' })).toBe(false);
      expect(validateToolSchema(tool.outputSchema, { ...failure, error: { ...failure.error, stack: 'private' } })).toBe(false);
      expect(validateToolSchema(tool.outputSchema, { ...failure, error: { code: 'not_found' } })).toBe(false);
    });

    // only monotonic transfer and Watch cursors bypass the generic replay store
    it('retains explicit replay and risk annotations', () => {
      const cursor = ['upload_file_chunk', 'ack_watch_events'].includes(tool.name);
      expect(tool.annotations.readOnlyHint).toBe(tool.risk === 'read');
      expect(tool.annotations.idempotentHint).toBe(tool.risk === 'read' || cursor);
      // ordinary mutations, including durable restarts, always require a request id
      if (tool.risk !== 'read' && !cursor) expect(tool.schema.safeParse({}).success).toBe(false);
      expect(tool.idempotency === 'domain_cursor').toBe(cursor);
    });
  });
}
