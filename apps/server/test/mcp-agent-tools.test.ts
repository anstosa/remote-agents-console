import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { createAgentOperations, recoverPendingAgentLifecycleCommands } from '../src/integrations/mcp/agent-operations.js';
import { agentToolNames, createAgentTools, type AgentToolPorts } from '../src/integrations/mcp/agent-tools.js';
import { StructuredAgents } from '../src/transports/structured-agents.js';
import { resolvedMergeBaseChoices, saveResolvedMergeBase } from '../src/git/comparison.js';
import { GeneralAskJobs } from '../src/asks/general-jobs.js';

const conductor: IntegrationPrincipal = { authentication: 'conductor', subjectId: 'agent-c', audience: 'rac', scopes: ['status:read'], stableOwnerKey: 'agent-c' };

// build a complete inert port map for descriptor validation
function completePorts(): AgentToolPorts {
  return Object.fromEntries(agentToolNames.map(name => [name, async () => ({ ok: true as const, version: 'v2' as const, value: {} })])) as AgentToolPorts;
}

// select one required test descriptor
function tool(name: typeof agentToolNames[number]) {
  const found = createAgentTools(completePorts()).find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
}

describe('MCP agent tool contracts', () => {
  it('advertises only operations backed by real ports', () => {
    expect(createAgentTools({})).toEqual([]);
    expect(createAgentTools({ get_agent_runtime: async () => ({ ok: true, version: 'v2', value: {} }) }).map(candidate => candidate.name)).toEqual(['get_agent_runtime']);
    expect(createAgentTools(completePorts())).toHaveLength(agentToolNames.length);
  });

  it('uses exactly the shared 40 or 64 lowercase local object ids', () => {
    const schemas = [tool('get_comparison').schema, tool('start_review_tour').schema, tool('ask_comparison').schema, tool('set_merge_base').schema];
    // validate both supported repository object formats
    for (const schema of schemas) {
      const common = schema === schemas[3]
        ? { agent_id: 'agent-1', ref: 'main', request_id: 'request-1' }
        : schema === schemas[1]
          ? { agent_id: 'agent-1', fingerprint: 'f'.repeat(16), scope: 'commit', request_id: 'request-1' }
          : schema === schemas[2]
            ? { agent_id: 'agent-1', question: 'why', mode: 'commit', request_id: 'request-1' }
            : { agent_id: 'agent-1', mode: 'commit' };
      const key = schema === schemas[3] ? 'sha' : 'commit';
      expect(schema.safeParse({ ...common, [key]: 'a'.repeat(40) }).success).toBe(true);
      expect(schema.safeParse({ ...common, [key]: 'b'.repeat(64) }).success).toBe(true);
      expect(schema.safeParse({ ...common, [key]: 'a'.repeat(39) }).success).toBe(false);
      expect(schema.safeParse({ ...common, [key]: 'A'.repeat(40) }).success).toBe(false);
    }
  });

  it('requires exactly one flattened question answer form', () => {
    const schema = tool('relay_agent_question_answer').schema;
    const common = { agent_id: 'agent-1', question_id: 'question-1', request_id: 'request-1' };
    expect(schema.safeParse({ ...common, index: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...common, text: 'answer' }).success).toBe(true);
    expect(schema.safeParse({ ...common, dismiss: true }).success).toBe(true);
    expect(schema.safeParse(common).success).toBe(false);
    expect(schema.safeParse({ ...common, index: 0, dismiss: true }).success).toBe(false);
    expect(tool('relay_agent_question_answer').inputSchema).toHaveProperty('oneOf');
  });

  it('rejects undeclared nested launch and review result keys', () => {
    const launch = {
      option_id: 'option-1', expires_at: '2026-11-05T00:00:00.000Z', ordinary_launch: false,
      kinds: [{ kind: 'codex', options_revision: 'revision-1', model_policy: { state: 'native-default', allowed: [], default_selection: { mode: 'native-default' }, catalog: [], catalog_status: 'ready' }, security: { controls: [], defaults: {}, constraints: [], status: 'ready' } }]
    };
    expect(tool('get_launch_options').output.safeParse(launch).success).toBe(true);
    expect(tool('get_launch_options').output.safeParse({ ...launch, kinds: [{ ...launch.kinds[0], leak: true }] }).success).toBe(false);
    const review = {
      kind: 'ready', job_id: 'job-1', result: {
        source: 'job', review_id: 'review-1', job_id: 'job-1', worktree_id: 'worktree-1', kind: 'tour', fingerprint: 'f'.repeat(16), scope: 'working', base: 'HEAD', include_tests: true, include_docs: true,
        title: 'Tour', overview: 'Overview', items: [], total_items: 1, truncated: false
      }
    };
    expect(tool('get_review_job').output.safeParse(review).success).toBe(true);
    expect(tool('get_review_job').output.safeParse({ ...review, result: { ...review.result, transcript: 'secret' } }).success).toBe(false);
  });

  it('marks recoverable restart as lifecycle-owned without claiming idempotence', () => {
    const restart = tool('restart_agent');
    expect(restart.idempotency).toBe('lifecycle');
    expect(restart.annotations.idempotentHint).toBe(false);
  });

  it('advertises exact risk, destructive, and open-world annotation overrides', () => {
    const launch = tool('launch_agent');
    expect(launch.risk).toBe('operational');
    expect(launch.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
    expect(tool('restart_agent').annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect(tool('queue_prompt_with_attachments').annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
    expect(tool('list_merge_bases').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });
});

describe('MCP agent operations', () => {
  it('projects authorized runtime state and durable generation', async () => {
    const agent = { id: 'agent-c', transport: 'structured', home: '/tmp/worktree', title: '', kind: 'codex', attention: 'finished', placeId: 'place-1', conversationId: 'conversation-1', structured: { lifecycle: 'live', revision: 1, switchable: true, model: { id: 'gpt-test', effort: 'high' } } };
    const resolveAgent = vi.fn(async () => ({ agent }));
    const operations = createAgentOperations({
      structuredAgents: {} as never,
      comparison: {} as never,
      resolveAgent: resolveAgent as never,
      processGeneration: async () => 7,
      capabilities: () => ({ attachments: true, steer: true, compact: true, resume: true, restart: true }),
      createdAt: () => undefined
    });
    await expect(operations.get_agent_runtime?.({ agent_id: 'agent-c' }, conductor)).resolves.toMatchObject({ ok: true, value: { agent_id: 'agent-c', state: 'idle', process_generation: 7, capabilities: { model_switch: true, attachments: true } } });
    expect(resolveAgent).toHaveBeenCalledWith(conductor, 'agent-c', 'read');
  });

  it('does not advertise lifecycle mutations on a foreign Conductor target', async () => {
    const agent = { id: 'agent-2', transport: 'structured', home: '/tmp/worktree', title: '', kind: 'codex', attention: 'finished', placeId: 'place-1', spawnedBy: 'another-conductor', structured: { lifecycle: 'live', revision: 1, switchable: true } };
    const operations = createAgentOperations({
      structuredAgents: { models: async () => ({ models: [], current: undefined }) } as never,
      comparison: {} as never,
      resolveAgent: async () => ({ agent: agent as never }),
      processGeneration: async () => 1,
      capabilities: () => ({ attachments: true, steer: true, compact: true, resume: true, restart: true }),
      createdAt: () => undefined
    });
    await expect(operations.get_agent_runtime?.({ agent_id: 'agent-2' }, conductor)).resolves.toMatchObject({ ok: true, value: { capabilities: { model_switch: false, effort_switch: false, compact: false, resume: false, restart: false, attachments: true, steer: true } } });
    await expect(operations.list_agent_models?.({ agent_id: 'agent-2' }, conductor)).resolves.toMatchObject({ ok: true, value: { can_switch: false } });
  });

  it('reads persisted generations and rejects stale lifecycle commands before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-generation-'));
    const file = join(root, 'structured.json');
    await writeFile(file, JSON.stringify([{ id: 'agent-1', kind: 'codex', placeId: 'place-1', home: root, sandboxed: false, lifecycle: 'live', origin: 'operator', launchedAt: Date.now(), processGeneration: 4, lifecycleCommand: { commandId: 'command-1', expectedGeneration: 4 } }]));
    const start = vi.fn();
    const agents = new StructuredAgents({ start } as never, { file });
    await expect(agents.processGeneration('agent-1')).resolves.toBe(4);
    await expect(agents.lifecycleCommandMarker('agent-1')).resolves.toEqual({ commandId: 'command-1', expectedGeneration: 4 });
    await expect(agents.restartAtGeneration('agent-1', 3)).resolves.toBe('target_changed');
    await expect(agents.restartAtGeneration('agent-1', 4, 'command-2')).resolves.toBe('target_changed');
    expect(start).not.toHaveBeenCalled();
  });

  it('reserves a generation-fenced restart through marker persistence and rechecks Close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-restart-cas-'));
    const file = join(root, 'structured.json');
    await writeFile(file, JSON.stringify([{ id: 'agent-1', kind: 'pi', placeId: 'place-1', home: root, sandboxed: true, lifecycle: 'live', origin: 'operator', launchedAt: 1, processGeneration: 4 }]));
    const start = vi.fn(async () => undefined);
    const agents = new StructuredAgents({ start } as never, { file, allowedModels: () => [{ model: 'gpt-test' }] });
    agents.usePlaces(async () => ({ id: 'place-1', home: root } as never));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    (agents as unknown as { mutation: Promise<void> }).mutation = held;
    const fenced = agents.restartAtGeneration('agent-1', 4, 'command-1');
    await vi.waitFor(() => expect((agents as unknown as { live: Map<string, { busy: boolean }> }).live.get('agent-1')?.busy).toBe(true));
    await expect(agents.restart('agent-1')).resolves.toBe(false);
    const live = (agents as unknown as { live: Map<string, { busy: boolean; connection?: { setModel: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }> }).live.get('agent-1')!;
    const setModel = vi.fn(async () => true);
    live.connection = { setModel, close: vi.fn() };
    await expect(agents.setModel('agent-1', { model: 'gpt-test' })).resolves.toBe('busy');
    expect(setModel).not.toHaveBeenCalled();
    const closing = agents.close('agent-1');
    await vi.waitFor(async () => expect(await agents.has('agent-1')).toBe(false));
    release();
    await expect(fenced).resolves.toBe('target_changed');
    await expect(closing).resolves.toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('reserves a generation-fenced resume while its marker save is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-resume-cas-'));
    const file = join(root, 'structured.json');
    await writeFile(file, JSON.stringify([{ id: 'agent-1', kind: 'pi', placeId: 'place-1', home: root, sandboxed: true, lifecycle: 'exited', origin: 'operator', launchedAt: 1, processGeneration: 4 }]));
    const start = vi.fn(async () => undefined);
    const agents = new StructuredAgents({ start } as never, { file });
    agents.usePlaces(async () => ({ id: 'place-1', home: root } as never));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    (agents as unknown as { mutation: Promise<void> }).mutation = held;
    const fenced = agents.resumeAtGeneration('agent-1', 4, undefined, 'command-1');
    await vi.waitFor(() => expect((agents as unknown as { live: Map<string, { busy: boolean }> }).live.get('agent-1')?.busy).toBe(true));
    await expect(agents.resume('agent-1')).resolves.toBe(false);
    expect(start).not.toHaveBeenCalled();
    release();
    await expect(fenced).resolves.toBe('invalid_state');
    expect(start).toHaveBeenCalledOnce();
  });

  it('does not retain or execute a lifecycle marker whose durable save failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-marker-failure-'));
    const file = join(root, 'structured.json');
    await writeFile(file, JSON.stringify([{ id: 'agent-1', kind: 'pi', placeId: 'place-1', home: root, sandboxed: true, lifecycle: 'live', origin: 'operator', launchedAt: 1, processGeneration: 4 }]));
    const start = vi.fn(async () => undefined);
    const agents = new StructuredAgents({ start } as never, { file });
    vi.spyOn(agents as unknown as { save: () => Promise<boolean> }, 'save').mockResolvedValueOnce(false);
    await expect(agents.restartAtGeneration('agent-1', 4, 'command-1')).resolves.toBe('invalid_state');
    await expect(agents.lifecycleCommandMarker('agent-1')).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect((agents as unknown as { live: Map<string, { busy: boolean }> }).live.get('agent-1')?.busy).toBe(false);
  });

  it('keeps Davo worker ownership separate from conductor and operator records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-worker-owner-'));
    const file = join(root, 'structured.json');
    await writeFile(file, JSON.stringify([
      { id: 'davo-a', kind: 'codex', placeId: 'place-1', home: root, sandboxed: true, lifecycle: 'live', origin: { davo: 'owner-a' }, launchedAt: 1 },
      { id: 'davo-b', kind: 'claude', placeId: 'place-1', home: root, sandboxed: true, lifecycle: 'exited', origin: { davo: 'owner-b' }, launchedAt: 2 },
      { id: 'conductor-worker', kind: 'codex', placeId: 'place-1', home: root, sandboxed: true, lifecycle: 'live', origin: { conductor: 'conductor-1' }, launchedAt: 3 },
      { id: 'operator', kind: 'pi', placeId: 'place-1', home: root, sandboxed: false, lifecycle: 'live', origin: 'operator', launchedAt: 4 }
    ]));
    const agents = new StructuredAgents({} as never, { file });
    await expect(agents.workerOwner('davo-a')).resolves.toBe('owner-a');
    await expect(agents.workerOwner('davo-b')).resolves.toBe('owner-b');
    await expect(agents.workerOwner('conductor-worker')).resolves.toBeUndefined();
    await expect(agents.workerOwner('operator')).resolves.toBeUndefined();
    await expect(agents.ownedWorkers('owner-a')).resolves.toMatchObject([{ id: 'davo-a' }]);
    await expect(agents.ownedWorkers('owner-b')).resolves.toMatchObject([{ id: 'davo-b' }]);
    await expect(agents.ownedWorkers('missing-owner')).resolves.toEqual([]);
    await expect(agents.agent('conductor-worker')).resolves.toMatchObject({ spawnedBy: 'conductor-1' });
    await expect(agents.agent('davo-a')).resolves.not.toHaveProperty('spawnedBy');
  });

  it('recovers only pending restart commands after lifecycle reconciliation', async () => {
    const restartAtGeneration = vi.fn(async () => 'ok' as const);
    const beginLifecycleCommand = vi.fn(async (id: string) => ({ id, state: 'running' }));
    const finishLifecycleCommand = vi.fn(async () => undefined);
    const processGeneration = vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(6);
    const dependencies = {
      structuredAgents: { restartAtGeneration },
      comparison: {},
      resolveAgent: async () => undefined,
      processGeneration,
      capabilities: () => ({ attachments: false, steer: false, compact: false, resume: false, restart: false }),
      createdAt: () => undefined,
      policy: {
        claimLifecycleCommand: async () => ({ kind: 'capacity' as const }),
        beginLifecycleCommand,
        finishLifecycleCommand,
        lifecycleCommand: async () => undefined,
        pendingLifecycleCommands: async () => [
          { id: 'restart-1', idempotencyRecordId: 'claim-1', targetAgentId: 'agent-1', operation: 'restart' as const, state: 'pending' as const, expectedGeneration: 5, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z' },
          { id: 'resume-1', idempotencyRecordId: 'claim-2', targetAgentId: 'agent-2', operation: 'resume_replacing' as const, state: 'pending' as const, expectedGeneration: 5, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z' }
        ]
      }
    };
    await recoverPendingAgentLifecycleCommands(dependencies as never);
    expect(beginLifecycleCommand).toHaveBeenCalledOnce();
    expect(beginLifecycleCommand).toHaveBeenCalledWith('restart-1', 5);
    expect(restartAtGeneration).toHaveBeenCalledWith('agent-1', 5, 'restart-1');
    expect(finishLifecycleCommand).toHaveBeenCalledWith('restart-1', 'succeeded', 6);
  });

  it('rechecks structured steer and interrupt guards before transport effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-turn-guard-'));
    const file = join(root, 'structured.json');
    await writeFile(file, JSON.stringify([{ id: 'agent-1', kind: 'pi', placeId: 'place-1', home: root, sandboxed: true, lifecycle: 'live', origin: 'operator', launchedAt: 1 }]));
    const steer = vi.fn(async () => true);
    const cancel = vi.fn(async () => []);
    const agents = new StructuredAgents({} as never, { file });
    const live = { working: true, connection: { steer, cancel }, draft: { id: 1, text: 'draft' } };
    (agents as unknown as { live: Map<string, unknown> }).live.set('agent-1', live);
    await expect(agents.steer('agent-1', 'redirect', () => false)).resolves.toBe('refused');
    await expect(agents.interrupt('agent-1', undefined, () => false)).resolves.toBe('unavailable');
    expect(steer).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await expect(agents.steer('agent-1', 'redirect', () => true)).resolves.toBe('sent');
    await expect(agents.interrupt('agent-1', undefined, () => true)).resolves.toBe('ok');
    expect(steer).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('refuses sensitive comparison files before reading Git', async () => {
    const file = vi.fn();
    const operations = createAgentOperations({
      structuredAgents: {} as never,
      comparison: { file } as never,
      resolveAgent: async () => ({ agent: {} as never, worktree: {} as never }),
      processGeneration: async () => 1,
      capabilities: () => ({ attachments: false, steer: false, compact: false, resume: false, restart: false }),
      createdAt: () => undefined
    });
    await expect(operations.get_comparison_file?.({ agent_id: 'agent-1', mode: 'working', path: '.env' }, conductor)).resolves.toMatchObject({ ok: false, error: { code: 'sensitive_path' } });
    expect(file).not.toHaveBeenCalled();
  });

  it('revalidates merge-base refs against their resolved object identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-merge-base-'));
    execFileSync('git', ['init', '-q', '-b', 'topic'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(join(root, 'file.txt'), 'one\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: root });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
    const choices = await resolvedMergeBaseChoices(root);
    expect(choices?.options).toEqual([{ ref: 'main', label: 'main', sha: expect.stringMatching(/^[0-9a-f]{40}$/u) }]);
    const selected = choices?.options[0];
    if (selected === undefined) throw new Error('merge base unavailable');
    await expect(saveResolvedMergeBase(root, selected.ref, '0'.repeat(selected.sha.length))).resolves.toBe('target_changed');
    await expect(saveResolvedMergeBase(root, selected.ref, selected.sha)).resolves.toBe('saved');
    expect(execFileSync('git', ['config', '--get', 'branch.topic.gh-merge-base'], { cwd: root, encoding: 'utf8' }).trim()).toBe('main');
  });
});

describe('general developer Ask jobs', () => {
  it('uses a real bounded runner without invented anchors and hides cross-owner jobs', async () => {
    const run = vi.fn(async () => ({ value: 'A grounded answer.' }));
    const jobs = new GeneralAskJobs({ capability: async () => ({ available: true }), run, closeWorktree: async () => {} }, { agent: 'codex' });
    const reviewId = jobs.issueReview('owner-a', 'worktree-1', 'f'.repeat(16));
    if (reviewId === undefined) throw new Error('review handle unavailable');
    const job = await jobs.askReview('owner-a', reviewId, 'What changed?', async handle => ({ worktreeId: handle.worktreeId, workspace: '/worktree', label: 'Stored review', context: '{"title":"Review","API_TOKEN":"secret-value"}' }));
    await vi.waitFor(() => expect(jobs.get('owner-a', job.id)?.state).toEqual({ kind: 'ready', answer: 'A grounded answer.' }));
    expect(jobs.get('owner-b', job.id)).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    const request = run.mock.calls[0]?.[0];
    expect(request?.prompt).toContain('<review-context>');
    expect(request?.prompt).not.toContain('anchor');
    expect(request?.prompt).toContain('[REDACTED]');
    expect(request?.prompt).not.toContain('secret-value');
  });

  it('freshly resolves review handles and fails closed at bounded capacity', async () => {
    const jobs = new GeneralAskJobs({ capability: async () => ({ available: true }), run: async () => ({ value: '' }), closeWorktree: async () => {} }, { agent: 'codex' });
    const reviewId = jobs.issueReview('owner-a', 'worktree-1', 'f'.repeat(16));
    if (reviewId === undefined) throw new Error('review handle unavailable');
    await expect(jobs.askReview('owner-a', reviewId, 'Question', async () => undefined)).rejects.toMatchObject({ code: 'stale_during_generation' });
    await expect(jobs.askReview('owner-b', reviewId, 'Question', async () => ({ worktreeId: 'worktree-1', workspace: '/worktree', label: 'Review', context: '{}' }))).rejects.toMatchObject({ code: 'target_unavailable' });
    // fill the remaining owner/fingerprint-bound handle slots without evicting live entries
    for (let index = 1; index < 128; index += 1) expect(jobs.issueReview('owner-a', `worktree-${index + 1}`, String(index).padStart(16, '0'))).toBeTypeOf('string');
    expect(jobs.issueReview('owner-a', 'overflow', 'x'.repeat(16))).toBeUndefined();
    expect(jobs.issueReview('owner-a', 'worktree-1', 'f'.repeat(16))).toBe(reviewId);
  });
});
