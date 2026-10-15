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

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const agent = { id: 'agent-9', kind: 'claude' } as Agent;
const schema = { type: 'object', required: ['ok'] };
const request = (extra: Partial<ReviewRunRequest> = {}): ReviewRunRequest => ({ kind: 'claude', workspace: '/w', worktreeId: 'proj:/w', prompt: 'Review the change.', schema, timeoutMs: 60_000, label: '🔍 Review · Correctness', effort: 'high', ...extra });

// a scripted console: each attention poll takes the next state (the last one repeats), and each
// turn's reader returns that turn's reply; an orphan's latest reply is `latest`, and its recovery
// is finished through `recover`
function fakeHost(script: { attention: Array<AttentionState | undefined>; replies?: Array<string | undefined>; latest?: string; recover?: OrphanRecovery; launch?: boolean; submit?: boolean; onAttention?: () => void }) {
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
    await expect(runner.run(request({ onStarted: run => started.push(run.agentId) }), new AbortController().signal)).resolves.toEqual({ ok: true });
    expect(world.calls).toEqual(['launch:proj:/w:claude', 'name:🔍 Review · Correctness', 'close:agent-9']);
    expect(world.launches[0]).toMatchObject({ label: '🔍 Review · Correctness', extraArgs: ['--tools', 'Read,Grep,Glob,Skill', '--strict-mcp-config', '--add-dir', '/tmp/runs', '--effort', 'high'] });
    expect(world.submitted).toEqual([`Review the change.\n\n${replyInstruction(schema)}`]);
    expect(replyInstruction(schema)).toContain('When you are done, reply with ONLY one JSON object matching this JSON Schema as your final message — no prose, no code fences:');
    expect(started).toEqual(['agent-9']);
  });

  it('keeps waiting through a question, reporting it, until the turn finishes', async () => {
    const world = fakeHost({ attention: ['working', 'question', 'question', 'working', 'finished'], replies: ['{"ok":true}'] });
    const attention: boolean[] = [];
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request({ onAttention: needsInput => attention.push(needsInput) }), new AbortController().signal)).resolves.toEqual({ ok: true });
    expect(attention).toEqual([true, false]);
    expect(world.calls.filter(call => call.startsWith('close')).length).toBe(1);
  });

  it('sends one correction prompt in the same conversation after a failed validation', async () => {
    const world = fakeHost({ attention: ['working', 'finished', 'working', 'finished'], replies: ['{"ok":false}', '{"ok":true}'] });
    const validate = (value: unknown) => (value as { ok?: boolean }).ok === true ? undefined : 'ok must be true';
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request({ validate }), new AbortController().signal)).resolves.toEqual({ ok: true });
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
    await expect(runner.run(request({ recovery: { kind: 'code-review' }, maxOutputBytes: 900 }), new AbortController().signal)).resolves.toEqual({ ok: true });
    expect(await left).toEqual({ deliveredAt: 5_000, deadline: 65_000, maxBytes: 900, recovery: { kind: 'code-review' } });
    expect(await readdir(dir)).toEqual([]);
  });

  it('finishes an orphan from the recovery its run left, keeping a reply that validates and closing the pane', async () => {
    const dir = await promptDirectory();
    const runId = 'run_left_by_a_restart';
    await writeFile(join(dir, `${runId}.json`), JSON.stringify({ deliveredAt: 0, deadline: 10_000_000, maxBytes: 1_000, recovery: { kind: 'code-review' } }));
    await writeFile(join(dir, `${runId}.md`), 'The long instructions.');
    const saved: unknown[] = [];
    const world = fakeHost({ attention: ['working', 'finished'], latest: 'Done:\n{"ok":true}', recover: { validate: value => (value as { ok?: boolean }).ok === true ? undefined : 'ok must be true', save: async value => { saved.push(value); return true; } } });
    await new InteractiveReviewRunner(world.host, { promptDirectory: dir, now: () => 1_000 }).releaseOrphans([{ ...agent, id: 'agent-old', reviewRun: runId }]);
    expect(saved).toEqual([{ ok: true }]);
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
    await expect(runner.run(request(), new AbortController().signal)).resolves.toEqual({ ok: true });
  });

  it('hands a prompt too long to paste over in a private file, laid out for a reading tool, and removes it after', async () => {
    const dir = await promptDirectory();
    const patch = Array.from({ length: 800 }, (_value, index) => `+line ${index} ${'x'.repeat(40)}`).join('\n');
    const prompt = `Review the change.\n\n${JSON.stringify({ changes: [{ id: 'c1', patch }] })}`;
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['{"ok":true}'] });
    let written = '';
    const read = world.host.beginTurn;
    world.host.beginTurn = async (candidate, maxBytes) => { const [file] = await readdir(dir); written = await readFile(join(dir, file!), 'utf8'); return await read(candidate, maxBytes); };
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: dir }).run(request({ prompt }), new AbortController().signal)).resolves.toEqual({ ok: true });
    expect(world.submitted[0]).toMatch(new RegExp(`^Read the review instructions in ${dir}/[A-Za-z0-9_-]+\\.md and follow them exactly`, 'u'));
    expect(written.split('\n').every(line => line.length <= 2_000)).toBe(true);
    expect(written).toContain('"+line 799');
    expect(written.trimEnd().endsWith(JSON.stringify(schema))).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('bounds the reply by the request', async () => {
    const world = fakeHost({ attention: ['working', 'finished', 'working', 'finished'], replies: [`{"ok":"${'x'.repeat(200)}"}`, '{"ok":true}'] });
    await expect(new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }).run(request({ maxOutputBytes: 100 }), new AbortController().signal)).resolves.toEqual({ ok: true });
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
    const headless = (from: string): KindReviewRunner => ({ capability: async () => ({ available: true }), run: async () => ({ from }) });
    const world = fakeHost({ attention: ['working', 'finished'], replies: ['{"from":"pane"}'] });
    const dispatch = new ModeDispatchReviewRunner({ claude: { mode: 'interactive' }, codex: { mode: 'headless' } }, { codex: headless('codex'), claude: headless('claude') }, new InteractiveReviewRunner(world.host, { promptDirectory: '/tmp/runs' }));
    await expect(dispatch.run(request(), new AbortController().signal)).resolves.toEqual({ from: 'pane' });
    await expect(dispatch.run(request({ kind: 'codex' }), new AbortController().signal)).resolves.toEqual({ from: 'codex' });
    await expect(dispatch.capability('claude')).resolves.toEqual({ available: true });
  });
});

describe('interactive Review run reply turns', () => {
  it('reads a Claude turn\'s reply only once it differs from the message before the prompt', async () => {
    const configDir = await promptDirectory();
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const projectDir = join(configDir, 'projects', '-worktrees-cora');
    await mkdir(projectDir, { recursive: true });
    const transcript = join(projectDir, `${sessionId}.jsonl`);
    const message = (id: string, text: string) => `${JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })}\n`;
    await writeFile(transcript, message('msg_1', '{"ok":false}'));
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
});
