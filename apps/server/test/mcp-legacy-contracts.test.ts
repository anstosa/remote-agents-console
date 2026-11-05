import { describe, expect, it } from 'vitest';
import { integrationTools } from '../src/integrations/mcp/catalog.js';
import { validateToolSchema } from '../src/integrations/mcp/legacy-output.js';

const fixtures: Record<string, unknown> = {
  list_instances: [{ id: 'local', name: 'Local', url: 'https://agents.example', local: true }],
  list_worktrees: [], get_worktree_status: { id: 'worktree', label: 'Worktree', available: true, pinned: true, active: false, order: 0, agentIds: [] }, list_agents: [], get_agent_status: { id: 'agent', title: 'Agent', label: 'Agent', attention: 'working', unread: false },
  get_agent_latest_response: { text: '', source: 'history', truncated: false }, summarize_agent_response: { text: '', source: 'history', truncated: false }, get_agent_log_tail: { text: '', rows: 2, older: false, truncated: false }, list_prompt_history: { prompts: [] }, list_queued_prompts: { prompts: [] }, get_stack_status: { actions: [] }, get_stack_log: { action: 'build', active: false, startedAt: '2026-01-01T00:00:00Z', output: '' }, preview_file: { path: 'a', size: 0, binary: false, truncated: false }, get_process_log: { name: 'server', path: 'server.log', output: '' }, list_notes: { notes: [] }, get_pull_request_status: {},
  get_github_overview: { freshness: { state: 'cold', fetchedAt: null, ageSeconds: null, network: 'none', problem: null, backgroundPoll: 'none' }, coverage: { viewer: null, repositories: [], lists: {}, notCovered: [] } },
  get_github_pull_request: { freshness: { state: 'cold', fetchedAt: null, ageSeconds: null, network: 'none', problem: null, backgroundPoll: 'none' }, repository: 'owner/name', number: 1, pullRequest: null }, get_review_status: {}, summarize_workspace: { text: '', worktrees: [], scratchAgents: [] }, summarize_attention_items: { state: 'idle', text: '', agents: [] },
  queue_prompt: { accepted: true, prompt_id: 'prompt' }, update_queued_prompt: { id: 'prompt', text: 'text', createdAt: '2026-01-01T00:00:00Z' }, move_queued_prompt: { prompts: [] }, remove_queued_prompt: { removed: true }, answer_agent_question: { answered: true }, cancel_agent: { cancelled: true }, launch_worktree_agent: { launched: true }, launch_scratch_agent: { launched: true }, deactivate_agent: { deactivated: true }, start_new_task: { started: true }, run_stack_action: { started: true }, start_review: { kind: 'pending', job: { id: 'job', expiresAt: '2026-01-01T00:00:01Z', retryAfterMs: 1000, startedAt: '2026-01-01T00:00:00Z' } }, spawn_agent: { agent_id: 'worker' }, create_worktree: { worktree_id: 'worktree' }, close_agent: { closed: true }, create_note: { note_id: 'note' }, update_note: { updated: true }, delete_note: { deleted: true }, schedule_note: { scheduled: true }, watch_pull_request: { watch_id: 'watch', state: { url: 'https://github.com/a/b/pull/1', head: 'a'.repeat(40), checks: 'pending', merge_conflict: false, unresolved_threads: 0 } }, watch_process: { watch_id: 'watch' }, watch_review_requests: { watch_id: 'watch', requested: [] }, watch_command: { watch_id: 'watch' }, list_watches: { watches: [] }, unwatch: { removed: true }, switch_pull_request: { switched: true }
};

// compare published JSON schemas and runtime output validators for all existing names
for (const tool of integrationTools) {
  describe(`legacy contract ${tool.name}`, () => {
    // the catalog may not inherit an untyped generic output envelope
    it('validates a complete serialized success and failure fixture', () => {
      expect(fixtures).toHaveProperty(tool.name);
      const data = fixtures[tool.name];
      const envelope = { ok: true, contract_version: 'v1', correlation_id: 'test', data };
      expect(tool.output?.safeParse(data).success).toBe(true);
      expect(validateToolSchema(tool.outputSchema, envelope)).toBe(true);
      expect(validateToolSchema(tool.outputSchema, { ok: false, contract_version: 'v1', correlation_id: 'test', error: { code: 'not_found', message: 'Unavailable', retryable: false } })).toBe(true);
      expect(validateToolSchema(tool.outputSchema, { ...envelope, unexpected: 'secret' })).toBe(false);
    });
    // bounded replay storage is not a guarantee of semantic idempotence forever
    it('publishes truthful default idempotence hints', () => {
      expect(tool.annotations.idempotentHint).toBe(tool.risk === 'read');
      expect(tool.annotations.readOnlyHint).toBe(tool.risk === 'read');
    });
  });
}

describe('paired input refinements', () => {
  // compare the schema boundary, stripping the transport-only instance selector before Zod
  it.each([
    ['preview_file', { path: 'a' }, false], ['preview_file', { path: 'a', agent_id: 'a', worktree_id: 'w' }, false], ['preview_file', { path: 'a', agent_id: 'a' }, true],
    ['get_agent_status', { agent_id: 'a\0b' }, false], ['update_note', { worktree_id: 'w', note_id: 'n', request_id: 'request-1' }, false],
    ['watch_command', { command: 'a\0b', description: 'watch', request_id: 'request-1' }, false],
    ['get_github_pull_request', { repository: 'bad', number: 1 }, false], ['get_github_pull_request', { repository: 'a/b', number: 2147483648 }, false], ['get_github_pull_request', { repository: 'a/b', number: 1, cursor: '' }, false], ['get_github_pull_request', { repository: 'a/b', number: 1 }, true]
  ] as const)('keeps %s coherent for %j', (name, data, expected) => {
    const tool = integrationTools.find(candidate => candidate.name === name)!;
    expect(tool.schema.safeParse(data).success).toBe(expected);
    expect(validateToolSchema(tool.inputSchema, data)).toBe(expected);
  });
  // the status schema cannot describe or validate log content under status:read
  it('separates stack status and stack log contracts', () => {
    const status = integrationTools.find(tool => tool.name === 'get_stack_status')!;
    expect(status.output?.safeParse({ actions: [], log: { output: 'secret' } }).success).toBe(false);
    const log = integrationTools.find(tool => tool.name === 'get_stack_log')!;
    expect(log.requiredScopes).toEqual(['logs:read']);
    expect(log.output?.safeParse(fixtures.get_stack_log).success).toBe(true);
  });
});
