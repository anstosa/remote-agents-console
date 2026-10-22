import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttentionState } from '../src/adapters/types.js';
import type { Agent } from '../src/domain/models.js';
import type { ReviewRunLaunch } from '../src/launch/service.js';
import { ModeDispatchReviewRunner } from '../src/review-runs/dispatch.js';
import { beginReplyTurn, latestReply } from '../src/review-runs/final-reply.js';
import { correctionPrompt, InteractiveReviewRunner, parseReply, readablePrompt, replyInstruction, type InteractiveReviewHost, type OrphanRecovery } from '../src/review-runs/interactive.js';
import type { KindReviewRunner, ReviewRunRequest } from '../src/review-runs/runner.js';
import { codexHome, fakeProc } from './helpers/codex-fixtures.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const agent = { id: 'agent-9', kind: 'claude' } as Agent;
const schema = { type: 'object', required: ['ok'] };
const request = (extra: Partial<ReviewRunRequest> = {}): ReviewRunRequest => ({ kind: 'claude', workspace: '/w', worktreeId: 'proj:/w', prompt: 'Review the change.', reply: { kind: 'json', schema }, timeoutMs: 60_000, label: '🔍 Review · Correctness', effort: 'high', ...extra });
const conversation = '6f1c2a90-1111-4222-8333-444455556666';

// a scripted console: each attention poll takes the next state (the last one repeats), and each
// turn's reader returns that turn's reply; an orphan's latest reply is `latest`, and its recovery
// is finished through `recover`
function fakeHost(script: { attention: Array<AttentionState | undefined>; replies?: Array<string | undefined>; latest?: string; recover?: OrphanRecovery; launch?: boolean; submit?: boolean; conversation?: string; onAttention?: () => void }) {
  const calls: string[] = [];
  const submitted: string[] = [];
  const launches: ReviewRunLaunch[] = [];
  const attention = [...script.attention];
  let turn = -1;
  const host: InteractiveReviewHost = {
    capability: async () => ({ available: true }),
    agentIds: async () => new Set(['agent-1']),
    launch: async (worktreeId, kind, launch) => { calls.push(`launch:${worktreeId}:${kind}`); launches.push(launch); return script.launch ?? true; },
    waitForAgent: async (_before, runId) => (runId === launches[0]?.runId ? agent : undefined),
    waitForReadiness: async () => ({ state: 'ready' }),
    name: async (_id, name) => { calls.push(`name:${name}`); },
    beginTurn: async () => { const index = turn += 1; return async () => script.replies?.[index]; },
    latestReply: async () => script.latest,
    recover: async (recovery, agentId) => { calls.push(`recover:${agentId}:${JSON.stringify(recovery)}`); return script.recover; },
    submit: async (_id, text) => { submitted.push(text); return script.submit ?? true; },
    conversationId: async () => script.conversation,
    attention: async () => { script.onAttention?.(); return attention.length > 1 ? attention.shift() : attention[0]; },
    close: async id => { calls.push(`close:${id}`); },
    release: async id => { calls.push(`release:${id}`); },
    delay: async () => {}
  };
  return { host, calls, submitted, launches };
}

async function promptDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rac-review-runs-'));
  dirs.push(dir);
  return dir;
}

describe('interactive Review runner', () => {
  it('launches a marked read-only Agent, delivers the prompt with the reply instruction, and closes the pane on success', async () => {
    const world = fakeHost({ attention: ['finished', 'working', 'finished'], replies: ['Here it is:\n```json\n{"ok":true}\n```'] });
    const started: string[] = [];
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' });
    await expect(runner.run(request({ onStarted: run => started.push(run.agentId) }), new AbortController().signal)).resolves.toEqual({ value: { ok: true } });
    expect(world.calls).toEqual(['launch:proj:/w:claude', 'name:🔍 Review · Correctness', 'close:agent-9']);
    expect(world.launches[0]).toMatchObject({ label: '🔍 Review · Correctness', extraArgs: ['--tools', 'Read,Grep,Glob,Skill', '--strict-mcp-config', '--setting-sources', 'user', '--add-dir', '/tmp/runs', '--effort', 'high'] });
    expect(world.submitted).toEqual([`Review the change.\n\n${replyInstruction(schema)}`]);
    expect(replyInstruction(schema)).toContain('When you are done, reply with ONLY one JSON object matching this JSON Schema as your final message — no prose, no code fences:');
    expect(started).toEqual(['agent-9']);
  });

  it('keeps waiting through a question, reporting it, until the turn finishes', async () => {
    const world = fakeHost({ attention: ['working', 'question', 'question', 'working', 'finished'], replies: ['{"ok":true}'] });
    const attention: boolean[] = [];
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request({ onAttention: needsInput => attention.push(needsInput) }), new AbortController().signal)).resolves.toEqual({ value: { ok: true } });
    expect(attention).toEqual([true, false]);
    expect(world.calls.filter(call => call.startsWith('close')).length).toBe(1);
  });

  it('sends one correction prompt in the same conversation after a failed validation', async () => {
    const world = fakeHost({ attention: ['working', 'finished', 'working', 'finished'], replies: ['{"ok":false}', '{"ok":true}'] });
    const validate = (value: unknown) => (value as { ok?: boolean }).ok === true ? undefined : 'ok must be true';
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request({ reply: { kind: 'json', schema, validate } }), new AbortController().signal)).resolves.toEqual({ value: { ok: true } });
    expect(world.submitted[1]).toBe(correctionPrompt('ok must be true'));
    expect(world.submitted[1]).toBe('Your final message failed validation: ok must be true. Reply again with only the corrected JSON object.');
    expect(world.calls).toContain('close:agent-9');
  });

  it('leaves the pane open to the operator after a second failed validation', async () => {
    const world = fakeHost({ attention: ['working', 'finished', 'working', 'finished'], replies: ['no json here', '{"broken": }'] });
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'malformed_result', retryable: true });
    expect(world.submitted[1]).toBe(correctionPrompt('the reply holds no JSON object'));
    expect(world.calls).toContain('release:agent-9');
    expect(world.calls.some(call => call.startsWith('close'))).toBe(false);
  });

  it('times out from delivery and leaves a still-working pane open', async () => {
    let clock = 0;
    const world = fakeHost({ attention: ['working'] });
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs', now: () => (clock += 1_000) });
    await expect(runner.run(request({ timeoutMs: 5_000 }), new AbortController().signal)).rejects.toMatchObject({ code: 'timed_out' });
    expect(world.calls).toContain('release:agent-9');
    expect(world.calls.some(call => call.startsWith('close'))).toBe(false);
  });

  it('closes the pane when the run is cancelled', async () => {
    const controller = new AbortController();
    const world = fakeHost({ attention: ['working'], onAttention: () => controller.abort() });
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request(), controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(world.calls).toContain('close:agent-9');
  });

  it('hands back an Agent marked for a run not in flight, never a live run\'s', async () => {
    const controller = new AbortController();
    let runner: InteractiveReviewRunner | undefined;
    let sweep: Promise<void> | undefined;
    const world = fakeHost({ attention: ['working'], onAttention: () => {
      if (sweep !== undefined) return controller.abort();
      sweep = runner!.releaseOrphans([{ ...agent, reviewRun: world.launches[0]!.runId }, { ...agent, id: 'agent-old', reviewRun: 'run_left_by_a_restart' }, { ...agent, id: 'agent-plain' }]);
    } });
    runner = new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' });
    await expect(runner.run(request(), controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    await sweep;
    expect(world.calls.filter(call => call.startsWith('release:'))).toEqual(['release:agent-old']);
    // once its run has ended, a pane still marked for it (its close failed) is an orphan too
    await runner.releaseOrphans([{ ...agent, reviewRun: world.launches[0]!.runId }]);
    expect(world.calls.filter(call => call.startsWith('release:'))).toEqual(['release:agent-old', 'release:agent-9']);
  });

  it('leaves a delivered run\'s recovery beside its pane until the run settles', async () => {
    const dir = await promptDirectory();
    let left: Promise<unknown> | undefined;
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['{"ok":true}'], onAttention: () => { left ??= readFile(join(dir, `${world.launches[0]!.runId}.json`), 'utf8').then(JSON.parse); } });
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: dir, now: () => 5_000 });
    await expect(runner.run(request({ recovery: { kind: 'code-review' }, maxOutputBytes: 900 }), new AbortController().signal)).resolves.toEqual({ value: { ok: true } });
    expect(await left).toEqual({ deliveredAt: 5_000, deadline: 65_000, maxBytes: 900, recovery: { kind: 'code-review' } });
    expect(await readdir(dir)).toEqual([]);
  });

  it('finishes an orphan from the recovery its run left, keeping a reply that validates and closing the pane', async () => {
    const dir = await promptDirectory();
    const runId = 'run_left_by_a_restart';
    await writeFile(join(dir, `${runId}.json`), JSON.stringify({ deliveredAt: 0, deadline: 10_000_000, maxBytes: 1_000, recovery: { kind: 'code-review' } }));
    await writeFile(join(dir, `${runId}.md`), 'The long instructions.');
    const saved: unknown[] = [];
    const world = fakeHost({ attention: ['working', 'finished'], latest: 'Done:\n{"ok":true}', conversation, recover: { validate: value => (value as { ok?: boolean }).ok === true ? undefined : 'ok must be true', save: async (value, kept) => { saved.push([value, kept]); return true; } } });
    await new InteractiveReviewRunner(world.host, { promptDirectory: dir, now: () => 1_000 }).releaseOrphans([{ ...agent, id: 'agent-old', reviewRun: runId }]);
    // the reply is kept with the conversation the pane reports, so its review can be asked about
    expect(saved).toEqual([[{ ok: true }, conversation]]);
    expect(world.calls).toEqual(['recover:agent-old:{"kind":"code-review"}', 'close:agent-old']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('hands an orphan back when it cannot be finished: no recovery, a refused one, a question, a failing reply or a refused save', async () => {
    const dir = await promptDirectory();
    const keep: OrphanRecovery = { validate: value => (value as { ok?: boolean }).ok === true ? undefined : 'ok must be true', save: async () => true };
    const cases: Array<{ name: string; left: boolean; script: Parameters<typeof fakeHost>[0] }> = [
      { name: 'none', left: false, script: { attention: ['finished'], latest: '{"ok":true}', recover: keep } },
      { name: 'refused', left: true, script: { attention: ['finished'], latest: '{"ok":true}' } },
      { name: 'asked', left: true, script: { attention: ['working', 'question'], latest: '{"ok":true}', recover: keep } },
      { name: 'failing', left: true, script: { attention: ['finished'], latest: '{"ok":false}', recover: keep } },
      { name: 'unsaved', left: true, script: { attention: ['finished'], latest: '{"ok":true}', recover: { ...keep, save: async () => false } } },
    ];
    for (const each of cases) {
      const runId = `run_${each.name}_orphaned`;
      if (each.left) await writeFile(join(dir, `${runId}.json`), JSON.stringify({ deliveredAt: 0, deadline: 10_000_000, maxBytes: 1_000, recovery: {} }));
      const world = fakeHost(each.script);
      // past the start window, so an idle orphan reads as finished
      await new InteractiveReviewRunner(world.host, { promptDirectory: dir, now: () => 120_000 }).releaseOrphans([{ ...agent, reviewRun: runId }]);
      expect(world.calls.at(-1), each.name).toBe('release:agent-9');
      expect(world.calls, each.name).not.toContain('close:agent-9');
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails a run whose Agent vanished, a refused launch and an unavailable kind', async () => {
    const vanished = fakeHost({ attention: ['working', undefined] });
    await expect(new InteractiveReviewRunner(vanished.host, { promptDirectory: '/tmp/runs' }).run(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'generation_failed' });
    const refused = fakeHost({ attention: ['finished'], launch: false });
    await expect(new InteractiveReviewRunner(refused.host, { promptDirectory: '/tmp/runs' }).run(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'generation_failed' });
    const unavailable = fakeHost({ attention: ['finished'] });
    unavailable.host.capability = async () => ({ available: false, reason: 'interactive_unavailable' });
    await expect(new InteractiveReviewRunner(unavailable.host, { promptDirectory: '/tmp/runs' }).run(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(unavailable.calls).toEqual([]);
  });

  it('reads idle as finished past the start window even when work was never seen', async () => {
    let clock = 0;
    const world = fakeHost({ attention: ['finished'], replies: ['{"ok":true}'] });
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs', now: () => (clock += 1_000), startWindowMs: 3_000 });
    await expect(runner.run(request(), new AbortController().signal)).resolves.toEqual({ value: { ok: true } });
  });

  it('hands a prompt too long to paste over in a private file, laid out for a reading tool, and removes it after', async () => {
    const dir = await promptDirectory();
    const patch = Array.from({ length: 800 }, (_value, index) => `+line ${index} ${'x'.repeat(40)}`).join('\n');
    const prompt = `Review the change.\n\n${JSON.stringify({ changes: [{ id: 'c1', patch }] })}`;
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['{"ok":true}'] });
    let written = '';
    const read = world.host.beginTurn;
    world.host.beginTurn = async (candidate, maxBytes) => { const [file] = await readdir(dir); written = await readFile(join(dir, file!), 'utf8'); return await read(candidate, maxBytes); };
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: dir }).run(request({ prompt }), new AbortController().signal)).resolves.toEqual({ value: { ok: true } });
    expect(world.submitted[0]).toMatch(new RegExp(`^Read the review instructions in ${dir}/[A-Za-z0-9_-]+\\.md and follow them exactly`, 'u'));
    expect(written.split('\n').every(line => line.length <= 2_000)).toBe(true);
    expect(written).toContain('"+line 799');
    expect(written.trimEnd().endsWith(JSON.stringify(schema))).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('resumes a conversation through its own launch, keeps its name, and returns a text reply as it is', async () => {
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['The guard runs **first**.'] });
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request({ resume: conversation, reply: { kind: 'text' }, prompt: 'Why?' }), new AbortController().signal)).resolves.toEqual({ value: 'The guard runs **first**.', conversation });
    expect(world.launches[0]).toMatchObject({ conversationId: conversation });
    expect(world.calls).toEqual(['launch:proj:/w:claude', 'close:agent-9']);
    // no reply instruction for a text reply
    expect(world.submitted).toEqual(['Why?']);
  });

  it('returns the conversation a new Agent reports, and hands over a text turn with no answer without a correction', async () => {
    const fresh = fakeHost({ attention: ['working', 'finished'], replies: ['{"ok":true}'], conversation });
    await expect(new InteractiveReviewRunner(fresh.host, { promptDirectory: '/tmp/runs' }).run(request(), new AbortController().signal)).resolves.toEqual({ value: { ok: true }, conversation });
    const silent = fakeHost({ attention: ['working', 'finished'], replies: ['  '] });
    await expect(new InteractiveReviewRunner(silent.host, { promptDirectory: '/tmp/runs' }).run(request({ reply: { kind: 'text' } }), new AbortController().signal)).rejects.toMatchObject({ code: 'malformed_result' });
    expect(silent.submitted).toHaveLength(1);
    expect(silent.calls).toContain('release:agent-9');
  });

  it('keeps a follow-up run\'s Agent for its conversation\'s next turn, then closes it once idle', async () => {
    const dir = await promptDirectory();
    // the second run first checks the kept Agent is still there
    const world = fakeHost({ attention: ['working', 'finished', 'finished', 'working', 'finished'], replies: ['First answer.', 'Second answer.'], conversation });
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: dir, keptIdleMs: 20 });
    const started: string[] = [];
    await expect(runner.run(request({ reply: { kind: 'text' }, followUps: true, prompt: 'One?' }), new AbortController().signal)).resolves.toEqual({ value: 'First answer.', conversation });
    expect(world.calls.some(call => call.startsWith('close'))).toBe(false);
    // the kept Agent leaves a record an orphan sweep after a restart keeps it by
    const [record] = await readdir(dir);
    expect(JSON.parse(await readFile(join(dir, record!), 'utf8'))).toMatchObject({ kept: { kind: 'claude', worktreeId: 'proj:/w', conversation } });
    // the sweep leaves a kept Agent alone
    await runner.releaseOrphans([{ ...agent, reviewRun: world.launches[0]!.runId }]);
    await expect(runner.run(request({ reply: { kind: 'text' }, followUps: true, resume: conversation, prompt: 'Two?', onStarted: run => started.push(run.agentId) }), new AbortController().signal)).resolves.toEqual({ value: 'Second answer.', conversation });
    expect(world.launches).toHaveLength(1);
    expect(world.submitted).toEqual(['One?', 'Two?']);
    expect(started).toEqual(['agent-9']);
    expect(world.calls.filter(call => !call.startsWith('launch') && !call.startsWith('name'))).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(world.calls.at(-1)).toBe('close:agent-9');
    expect(await readdir(dir)).toEqual([]);
  });

  it('closes a kept Agent when its conversation is closed, and relaunches one that has gone', async () => {
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['First.', 'Again.'], conversation });
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' });
    await runner.run(request({ reply: { kind: 'text' }, followUps: true }), new AbortController().signal);
    expect(runner.idleKeptAgents()).toEqual(new Set(['agent-9']));
    await runner.closeWorktree('proj:/other');
    expect(world.calls.some(call => call.startsWith('close'))).toBe(false);
    await runner.closeWorktree('proj:/w');
    expect(world.calls.at(-1)).toBe('close:agent-9');
    await runner.closeWorktree('proj:/w');
    expect(world.calls.filter(call => call.startsWith('close'))).toHaveLength(1);
    expect(runner.idleKeptAgents()).toEqual(new Set());
    const gone = fakeHost({ attention: ['working', 'finished', undefined, 'working', 'finished'], replies: ['First.', 'Relaunched.'], conversation });
    const relaunching = new InteractiveReviewRunner(gone.host, { promptDirectory: '/tmp/runs' });
    await relaunching.run(request({ reply: { kind: 'text' }, followUps: true }), new AbortController().signal);
    gone.host.waitForAgent = async () => agent;
    await expect(relaunching.run(request({ reply: { kind: 'text' }, followUps: true, resume: conversation }), new AbortController().signal)).resolves.toEqual({ value: 'Relaunched.', conversation });
    expect(gone.launches.map(launch => launch.conversationId)).toEqual([undefined, conversation]);
  });

  it('refuses a follow-up while the operator uses the kept pane, keeping it for later', async () => {
    const world = fakeHost({ attention: ['working', 'finished', 'working', 'finished', 'working', 'finished'], replies: ['First.', 'Later.'], conversation });
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' });
    await runner.run(request({ reply: { kind: 'text' }, followUps: true }), new AbortController().signal);
    // the kept check reads `working`: the operator's turn
    await expect(runner.run(request({ reply: { kind: 'text' }, followUps: true, resume: conversation }), new AbortController().signal)).rejects.toMatchObject({ code: 'agent_busy' });
    expect(world.submitted).toHaveLength(1);
    expect(world.calls.some(call => call.startsWith('close') || call.startsWith('release'))).toBe(false);
    // `finished`, then the turn itself
    await expect(runner.run(request({ reply: { kind: 'text' }, followUps: true, resume: conversation }), new AbortController().signal)).resolves.toEqual({ value: 'Later.', conversation });
  });

  it('closes a kept Agent once its turn ends when its Worktree is closed meanwhile, and hands one that times out to the operator', async () => {
    let finishTurn = false;
    const world = fakeHost({ attention: ['working', 'finished', 'finished', 'working'], replies: ['First.', 'Second.'], conversation });
    const attention = world.host.attention;
    world.host.attention = async id => finishTurn ? 'finished' : await attention(id);
    // a real pause between polls, so the test's own timers run while the turn is watched
    world.host.delay = async () => await new Promise(resolve => setTimeout(resolve, 1));
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' });
    await runner.run(request({ reply: { kind: 'text' }, followUps: true }), new AbortController().signal);
    const turn = runner.run(request({ reply: { kind: 'text' }, followUps: true, resume: conversation }), new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    await runner.closeWorktree('proj:/w');
    expect(world.calls.some(call => call.startsWith('close'))).toBe(false);
    finishTurn = true;
    await expect(turn).resolves.toEqual({ value: 'Second.', conversation });
    expect(world.calls.at(-1)).toBe('close:agent-9');
    expect(runner.idleKeptAgents()).toEqual(new Set());

    let clock = 0;
    const slow = fakeHost({ attention: ['working', 'finished', 'finished', 'working'], replies: ['First.'], conversation });
    const timing = new InteractiveReviewRunner(slow.host, { promptDirectory: '/tmp/runs', now: () => (clock += 1_000) });
    await timing.run(request({ reply: { kind: 'text' }, followUps: true }), new AbortController().signal);
    await expect(timing.run(request({ reply: { kind: 'text' }, followUps: true, resume: conversation, timeoutMs: 5_000 }), new AbortController().signal)).rejects.toMatchObject({ code: 'timed_out' });
    expect(slow.calls.at(-1)).toBe('release:agent-9');
    // handed back, it is no longer kept: the next question relaunches the conversation
    expect(timing.idleKeptAgents()).toEqual(new Set());
  });

  it('writes a prompt holding a control character to a file rather than pasting it', async () => {
    const dir = await promptDirectory();
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['Answered.'] });
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: dir }).run(request({ reply: { kind: 'text' }, prompt: 'Why?\n```diff\n+evil \u001b[201~\u0015!rm\n```' }), new AbortController().signal)).resolves.toEqual({ value: 'Answered.' });
    expect(world.submitted[0]).toMatch(new RegExp(`^Read the instructions in ${dir}/[A-Za-z0-9_-]+\\.md and follow them exactly`, 'u'));
    expect(world.submitted[0]).not.toContain('\u001b');
  });

  it('keeps an orphaned kept Agent again once idle, and closes one with no conversation to keep it for', async () => {
    const dir = await promptDirectory();
    await writeFile(join(dir, 'run_kept_before_restart.json'), JSON.stringify({ deliveredAt: 0, deadline: 0, maxBytes: 1_000, kept: { kind: 'claude', worktreeId: 'proj:/w', conversation } }));
    await writeFile(join(dir, 'run_kept_without_conversation.json'), JSON.stringify({ deliveredAt: 0, deadline: 0, maxBytes: 1_000, kept: { kind: 'claude', worktreeId: 'proj:/w' } }));
    const world = fakeHost({ attention: ['finished', 'finished', 'finished', 'working', 'finished'], replies: ['After the restart.'] });
    const runner = new InteractiveReviewRunner(world.host, { promptDirectory: dir });
    await runner.releaseOrphans([{ ...agent, id: 'agent-kept', reviewRun: 'run_kept_before_restart' }, { ...agent, id: 'agent-lost', reviewRun: 'run_kept_without_conversation' }]);
    expect(world.calls).toEqual(['close:agent-lost']);
    await expect(runner.run(request({ reply: { kind: 'text' }, followUps: true, resume: conversation }), new AbortController().signal)).resolves.toEqual({ value: 'After the restart.', conversation });
    expect(world.launches).toEqual([]);
    expect(await readdir(dir)).toEqual(['run_kept_before_restart.json']);
  });

  it('leaves an orphaned kept Agent at work for a later sweep, and hands back one asking a question', async () => {
    const dir = await promptDirectory();
    await writeFile(join(dir, 'run_kept_and_working.json'), JSON.stringify({ deliveredAt: 0, deadline: 0, maxBytes: 1_000, kept: { kind: 'claude', worktreeId: 'proj:/w', conversation } }));
    const working = fakeHost({ attention: ['working'] });
    await new InteractiveReviewRunner(working.host, { promptDirectory: dir }).releaseOrphans([{ ...agent, reviewRun: 'run_kept_and_working' }]);
    expect(working.calls).toEqual([]);
    expect(await readdir(dir)).toEqual(['run_kept_and_working.json']);
    const asking = fakeHost({ attention: ['question'] });
    await new InteractiveReviewRunner(asking.host, { promptDirectory: dir }).releaseOrphans([{ ...agent, reviewRun: 'run_kept_and_working' }]);
    expect(asking.calls).toEqual(['release:agent-9']);
    expect(await readdir(dir)).toEqual([]);
    // a record naming a conversation its kind would not accept is no record
    await writeFile(join(dir, 'run_kept_forged_id.json'), JSON.stringify({ deliveredAt: 0, deadline: 0, maxBytes: 1_000, kept: { kind: 'claude', worktreeId: 'proj:/w', conversation: '--last' } }));
    const forged = fakeHost({ attention: ['finished'] });
    await new InteractiveReviewRunner(forged.host, { promptDirectory: dir, now: () => 120_000 }).releaseOrphans([{ ...agent, reviewRun: 'run_kept_forged_id' }]);
    expect(forged.calls).toEqual(['release:agent-9']);
  });

  it('bounds the reply by the request', async () => {
    const world = fakeHost({ attention: ['working', 'finished', 'working', 'finished'], replies: [`{"ok":"${'x'.repeat(200)}"}`, '{"ok":true}'] });
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request({ maxOutputBytes: 100 }), new AbortController().signal)).resolves.toEqual({ value: { ok: true } });
    expect(world.submitted[1]).toBe(correctionPrompt('the JSON object is longer than 100 bytes'));
  });
});

describe('interactive Review run replies', () => {
  it('takes the outermost object around fences or prose, and reports why a reply fails', () => {
    expect(parseReply('Sure.\n```json\n{"a":{"b":1}}\n```\nDone.', 1_000)).toEqual({ ok: true, value: { a: { b: 1 } } });
    expect(parseReply(undefined, 1_000)).toEqual({ ok: false, error: 'no final message was found' });
    expect(parseReply('{"a":', 1_000)).toEqual({ ok: false, error: 'the reply holds no JSON object' });
    expect(parseReply('{"a": nope}', 1_000)).toMatchObject({ ok: false, error: expect.stringMatching(/^the reply is not valid JSON/u) });
    expect(parseReply('{"a":1}', 1_000, () => 'a must be 2')).toEqual({ ok: false, error: 'a must be 2' });
  });

  it('leaves a prompt without long JSON lines untouched', () => {
    expect(readablePrompt('short\n{"a":1}')).toBe('short\n{"a":1}');
  });
});

describe('Review run dispatch to the interactive runner', () => {
  it('routes an interactive kind to the interactive runner and a headless one to its CLI', async () => {
    const headless = (from: string): KindReviewRunner => ({ capability: async () => ({ available: true }), run: async () => ({ value: { from } }) });
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['{"from":"pane"}'] });
    const dispatch = new ModeDispatchReviewRunner({ claude: { mode: 'interactive' }, codex: { mode: 'headless' } }, { codex: headless('codex'), claude: headless('claude') }, new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }));
    await expect(dispatch.run(request(), new AbortController().signal)).resolves.toEqual({ value: { from: 'pane' } });
    await expect(dispatch.run(request({ kind: 'codex' }), new AbortController().signal)).resolves.toEqual({ value: { from: 'codex' } });
    await expect(dispatch.capability('claude')).resolves.toEqual({ available: true });
  });
});

describe('interactive Review run reply turns', () => {
  it('reads a Claude turn\'s reply once a newer message than the one before the prompt is there, even with the same text', async () => {
    const configDir = await promptDirectory();
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const projectDir = join(configDir, 'projects', '-worktrees-cora');
    await mkdir(projectDir, { recursive: true });
    const transcript = join(projectDir, `${sessionId}.jsonl`);
    const message = (id: string, text: string) => `${JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })}\n`;
    await writeFile(transcript, message('msg_1', '{"ok":true}'));
    const saved = process.env.RAC_CLAUDE_CONFIG_DIR;
    process.env.RAC_CLAUDE_CONFIG_DIR = configDir;
    try {
      const forced: Array<boolean | undefined> = [];
      const sources = { target: async (_id: string, force?: boolean) => { forced.push(force); return { agent: { conversationId: sessionId } as Agent }; }, paneProcessId: () => undefined, paneWorkingDirectory: () => undefined, paneDirectory: () => '/worktrees/cora' };
      const read = await beginReplyTurn(sources, { id: 'agent-9', kind: 'claude' }, 1_000);
      await expect(read()).resolves.toBeUndefined();
      await appendFile(transcript, message('msg_2', '{"ok":true}'));
      await expect(read()).resolves.toBe('{"ok":true}');
      // one fresh pane read pins the session before the prompt; the reader's polls take the snapshot
      expect(forced).toEqual([true, false, false]);
      // an orphan, with no snapshot from before its prompt, reads the latest message with a fresh pane read
      await expect(latestReply(sources, { id: 'agent-9', kind: 'claude' }, 1_000)).resolves.toBe('{"ok":true}');
      expect(forced.at(-1)).toBe(true);
    } finally { if (saved === undefined) delete process.env.RAC_CLAUDE_CONFIG_DIR; else process.env.RAC_CLAUDE_CONFIG_DIR = saved; }
  });

  it('reads a Codex turn\'s reply past the rollout ordinal before the prompt, and an orphan\'s from the rollout\'s start', async () => {
    const home = await codexHome();
    process.env.CODEX_HOME = home;
    const directory = join(home, 'sessions', '2026', '08', '30');
    await mkdir(directory, { recursive: true });
    const rollout = join(directory, 'rollout-2026-08-30T15-32-23-019e0a6c-3c51-7f22-9c8f-1d7f0a7e5b11.jsonl');
    const record = (ordinal: number, payload: unknown) => `${JSON.stringify({ type: 'event_msg', ordinal, payload })}\n`;
    const turn = (ordinal: number, answer: string) => `${record(ordinal, { type: 'task_started', turn_id: `t${ordinal}` })}${record(ordinal + 1, { type: 'task_complete', turn_id: `t${ordinal}`, last_agent_message: answer })}`;
    await writeFile(rollout, `${JSON.stringify({ type: 'session_meta', ordinal: 0, payload: { id: '019e0a6c-3c51-7f22-9c8f-1d7f0a7e5b11', cwd: '/worktrees/cora', timestamp: '2026-08-30T15:32:23.000Z', originator: 'codex-tui' } })}\n${turn(1, 'Earlier answer')}`);
    process.env.RAC_HOST_PROC = await fakeProc(321, [rollout]);
    const sources = { target: async () => undefined, paneProcessId: () => 321, paneWorkingDirectory: () => undefined, paneDirectory: () => undefined };
    const read = await beginReplyTurn(sources, { id: 'agent-9', kind: 'codex' }, 1_000);
    // the turn before the prompt is not this turn's reply
    await expect(read()).resolves.toBeUndefined();
    await appendFile(rollout, turn(3, '{"ok":true}'));
    await expect(read()).resolves.toBe('{"ok":true}');
    // an orphan reads the newest finished turn from the rollout's start, one byte past the bound so an over-long reply still reads too long
    await expect(latestReply(sources, { id: 'agent-9', kind: 'codex' }, 1_000)).resolves.toBe('{"ok":true}');
    await expect(latestReply(sources, { id: 'agent-9', kind: 'codex' }, 3)).resolves.toBe('{"ok');
    // a pane with no process has no reply
    await expect(latestReply({ ...sources, paneProcessId: () => undefined }, { id: 'agent-9', kind: 'codex' }, 1_000)).resolves.toBeUndefined();
  });
});
