import { describe, expect, it } from 'vitest';
import { agentToolNames, createAgentTools, type AgentToolName, type AgentToolPorts } from '../src/integrations/mcp/agent-tools.js';
import { validateToolSchema } from '../src/integrations/mcp/legacy-output.js';

// build every descriptor through its public binding path
function tools() {
  const ports = Object.fromEntries(agentToolNames.map(name => [name, async () => ({ ok: true as const, version: 'v2' as const, value: {} })])) as AgentToolPorts;
  return createAgentTools(ports);
}

const descriptors = tools();

// select one exact paired contract
function descriptor(name: AgentToolName) {
  const found = descriptors.find(candidate => candidate.name === name);
  // fail loudly when inventory drifts
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
}

// compare one input against both advertised validators
function expectInput(name: AgentToolName, value: Record<string, unknown>, expected: boolean): void {
  const contract = descriptor(name);
  expect(contract.schema.safeParse(value).success).toBe(expected);
  expect(validateToolSchema(contract.inputSchema, value)).toBe(expected);
}

// compare one output against Zod data and JSON envelope validators
function expectOutput(name: AgentToolName, value: unknown, expected: boolean): void {
  const contract = descriptor(name);
  expect(contract.output.safeParse(value).success).toBe(expected);
  expect(validateToolSchema(contract.outputSchema, { ok: true, contract_version: 'v2', correlation_id: 'parity', data: value })).toBe(expected);
}

const sha40 = 'a'.repeat(40);
const sha64 = 'b'.repeat(64);

describe('MCP agent paired schema parity', () => {
  it('requires commit exactly for commit comparison inputs', () => {
    const cases: Array<[AgentToolName, Record<string, unknown>]> = [
      ['get_comparison', { agent_id: 'agent-1', mode: 'working' }],
      ['get_comparison_file', { agent_id: 'agent-1', mode: 'working', path: 'src/a.ts' }],
      ['ask_comparison', { agent_id: 'agent-1', question: 'why', mode: 'working', request_id: 'request-1' }]
    ];
    // compare both conditional arms for every mode-based tool
    for (const [name, common] of cases) {
      expectInput(name, common, true);
      expectInput(name, { ...common, commit: sha40 }, false);
      expectInput(name, { ...common, mode: 'commit' }, false);
      expectInput(name, { ...common, mode: 'commit', commit: sha64 }, true);
    }
  });

  it('requires commit exactly for commit review starts and empty results', () => {
    const tour = { agent_id: 'agent-1', fingerprint: 'f'.repeat(16), scope: 'working', request_id: 'request-1' };
    const code = { ...tour, include_tests: true, include_docs: false };
    // compare both conditional arms for each review start
    for (const [name, common] of [['start_review_tour', tour], ['start_code_review', code]] as const) {
      expectInput(name, common, true);
      expectInput(name, { ...common, commit: sha40 }, false);
      expectInput(name, { ...common, scope: 'commit' }, false);
      expectInput(name, { ...common, scope: 'commit', commit: sha64 }, true);
    }
    const comparison = { base: 'HEAD', fingerprint: 'f'.repeat(16), include_tests: true, include_docs: true };
    expectOutput('start_review_tour', { kind: 'empty', comparison: { ...comparison, scope: 'working' } }, true);
    expectOutput('start_review_tour', { kind: 'empty', comparison: { ...comparison, scope: 'working', commit: sha40 } }, false);
    expectOutput('start_review_tour', { kind: 'empty', comparison: { ...comparison, scope: 'commit' } }, false);
    expectOutput('start_review_tour', { kind: 'empty', comparison: { ...comparison, scope: 'commit', commit: sha64 } }, true);
  });

  it('keeps tour output commit ids at exactly 40 or 64 lowercase hex characters', () => {
    const result = {
      source: 'job', review_id: 'review-1', job_id: 'job-1', worktree_id: 'worktree-1', kind: 'tour', fingerprint: 'f'.repeat(16), scope: 'commit', base: 'HEAD',
      include_tests: true, include_docs: true, title: 'Tour', overview: 'Overview', items: [], total_items: 1, truncated: false
    };
    expectOutput('get_review_job', { kind: 'ready', job_id: 'job-1', result: { ...result, commit: sha40 } }, true);
    expectOutput('get_review_job', { kind: 'ready', job_id: 'job-1', result: { ...result, commit: sha64 } }, true);
    // reject every near-miss object-id width
    for (const width of [39, 41, 63, 65]) expectOutput('get_review_job', { kind: 'ready', job_id: 'job-1', result: { ...result, commit: 'a'.repeat(width) } }, false);
    expectOutput('get_review_job', { kind: 'ready', job_id: 'job-1', result }, false);
    expectOutput('get_review_job', { kind: 'ready', job_id: 'job-1', result: { ...result, scope: 'working', commit: sha40 } }, false);
  });

  it('requires a model or effort and trims conversation names coherently', () => {
    const model = { agent_id: 'agent-1', request_id: 'request-1' };
    expectInput('set_agent_model_effort', model, false);
    expectInput('set_agent_model_effort', { ...model, model: 'gpt-test' }, true);
    expectInput('set_agent_model_effort', { ...model, effort: 'high' }, true);
    const rename = { agent_id: 'agent-1', conversation_id: 'conversation-1', request_id: 'request-1' };
    expectInput('rename_conversation', { ...rename, name: '   ' }, false);
    expectInput('rename_conversation', { ...rename, name: '  alpha  ' }, true);
    expectInput('rename_conversation', { ...rename, name: ` ${'a'.repeat(120)} ` }, true);
    expectInput('rename_conversation', { ...rename, name: 'a'.repeat(121) }, false);
    expectInput('new_conversation', { agent_id: 'agent-1', name: '\n\t', request_id: 'request-1' }, false);
  });

  it('requires exact launch destination keys', () => {
    expectInput('get_launch_options', { destination_kind: 'worktree', worktree_id: 'worktree-1' }, true);
    expectInput('get_launch_options', { destination_kind: 'folder', folder_place_id: 'folder-1' }, true);
    expectInput('get_launch_options', { destination_kind: 'scratch' }, true);
    expectInput('get_launch_options', { destination_kind: 'worktree' }, false);
    expectInput('get_launch_options', { destination_kind: 'worktree', worktree_id: 'worktree-1', folder_place_id: 'folder-1' }, false);
    expectInput('get_launch_options', { destination_kind: 'scratch', worktree_id: 'worktree-1' }, false);
  });

  it('requires nonempty attachments, launch control options, and review scopes', () => {
    const queue = { agent_id: 'agent-1', prompt: 'Review this', request_id: 'request-1' };
    expectInput('queue_prompt_with_attachments', { ...queue, attachments: [] }, false);
    expectInput('queue_prompt_with_attachments', { ...queue, attachments: [{ object_token: 't'.repeat(20), name: 'a.txt', size: 1 }] }, true);
    const launch = {
      option_id: 'option-1', expires_at: '2026-11-05T00:00:00.000Z', ordinary_launch: true,
      kinds: [{
        kind: 'codex', options_revision: 'revision-1', model_policy: { state: 'empty', allowed: [], default_selection: { mode: 'native-default' }, catalog: [], catalog_status: 'ready' },
        security: { controls: [{ id: 'sandbox', label: 'Sandbox', icon: 'shield', options: [{ id: 'safe', label: 'Safe', risk: 'normal', detail: '' }] }], defaults: {}, constraints: [], status: 'ready' }
      }]
    };
    expectOutput('get_launch_options', launch, true);
    const emptyOptions = structuredClone(launch);
    emptyOptions.kinds[0]!.security.controls[0]!.options = [];
    expectOutput('get_launch_options', emptyOptions, false);
    const review = { fingerprint: 'f'.repeat(16), presets: [], scopes: [{ scope: 'working', label: 'Working', available: true }], selections: [], selection_total: 0, truncated: false };
    expectOutput('list_review_options', review, true);
    expectOutput('list_review_options', { ...review, scopes: [] }, false);
  });
});
