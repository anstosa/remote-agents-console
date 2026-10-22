import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlessReviewRunner } from '../src/review-runs/headless.js';
import { ModeDispatchReviewRunner } from '../src/review-runs/dispatch.js';
import { acceptsReviewEffort, reviewAgentKinds, reviewEfforts, reviewRunsFor } from '../src/review-runs/kinds.js';
import { adapters } from '../src/adapters/registry.js';
import { ReviewRunError, type KindReviewRunner, type ReviewRunCapability, type ReviewRunner, type ReviewRunRequest } from '../src/review-runs/runner.js';

const roots: string[] = [];
// each kind's headless runner, as the console builds it from the kind's Adapter
const codexRunner = (binary: string) => new HeadlessReviewRunner(reviewRunsFor('codex').headless, binary);
const claudeRunner = (binary: string) => new HeadlessReviewRunner(reviewRunsFor('claude').headless, binary);
const schema = { type: 'object', properties: { answer: { type: 'string' } } };

// one Review run request in a fixture workspace
function request(workspace: string, extra: Partial<ReviewRunRequest> = {}): ReviewRunRequest {
  return { kind: 'codex', workspace, worktreeId: 'proj:/w', prompt: 'Explain the change.', schema, timeoutMs: 10_000, label: '🗺 Tour · feature', ...extra };
}

// write one executable fake CLI into a fresh root
async function fakeCli(name: string, body: string): Promise<{ root: string; binary: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-review-run-'));
  roots.push(root);
  const binary = join(root, name);
  await writeFile(binary, `#!/usr/bin/env bash\nset -eu\n${body.replaceAll('$ROOT', root)}`);
  await chmod(binary, 0o700);
  return { root, binary };
}

// a fake Codex recording its run arguments, schema and prompt, then writing `result`
async function fakeCodex(result: unknown): Promise<{ root: string; binary: string }> {
  return await fakeCli('codex', `if [[ "\${1:-}" == "exec" && "\${2:-}" == "--help" ]]; then echo '--ephemeral --ignore-user-config --ignore-rules --sandbox --output-schema --output-last-message'; exit 0; fi
if [[ "\${1:-}" == "login" ]]; then exit 0; fi
printf '%s\\n' "$@" >"$ROOT/args"
output=''; schema=''
while [[ $# -gt 0 ]]; do
  case "$1" in --output-last-message) output="$2"; shift 2;; --output-schema) schema="$2"; shift 2;; *) shift;; esac
done
cp "$schema" "$ROOT/schema"
cat >"$ROOT/prompt"
printf '%s' ${JSON.stringify(JSON.stringify(result))} >"$output"
`);
}

afterEach(async () => {
  // remove fake executables
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('headless Codex Review runner', () => {
  it('runs read-only with the schema and prompt, and returns the parsed last message', async () => {
    const fixture = await fakeCodex({ answer: 'yes' });
    const runner = codexRunner(fixture.binary);
    await expect(runner.run(request(fixture.root), new AbortController().signal)).resolves.toEqual({ answer: 'yes' });
    const args = (await readFile(join(fixture.root, 'args'), 'utf8')).trim().split('\n');
    expect(args).toEqual(['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--output-schema', expect.stringMatching(/\/schema\.json$/u), '--output-last-message', expect.stringMatching(/\/result\.json$/u), '--color', 'never', '-C', fixture.root, '-']);
    expect(args).not.toContain('-m');
    expect(args).not.toContain('-c');
    expect(JSON.parse(await readFile(join(fixture.root, 'schema'), 'utf8'))).toEqual(schema);
    expect(await readFile(join(fixture.root, 'prompt'), 'utf8')).toBe('Explain the change.');
  });

  it('passes the model and reasoning effort when given', async () => {
    const fixture = await fakeCodex({ answer: 'yes' });
    await codexRunner(fixture.binary).run(request(fixture.root, { model: 'gpt-5-codex', effort: 'minimal' }), new AbortController().signal);
    const args = (await readFile(join(fixture.root, 'args'), 'utf8')).trim().split('\n');
    expect(args.slice(6, 10)).toEqual(['-m', 'gpt-5-codex', '-c', 'model_reasoning_effort=minimal']);
  });

  it('refuses a reply over the bound or not JSON, and removes the run\'s private files after', async () => {
    const big = await fakeCodex({ answer: 'x'.repeat(300_000) });
    await expect(codexRunner(big.binary).run(request(big.root), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'malformed_result', retryable: true });
    const garbled = await fakeCli('codex', `if [[ "\${1:-}" == "exec" && "\${2:-}" == "--help" ]]; then echo '--ephemeral --ignore-user-config --ignore-rules --sandbox --output-schema --output-last-message'; exit 0; fi
if [[ "\${1:-}" == "login" ]]; then exit 0; fi
printf '%s\\n' "$@" >"$ROOT/args"
while [[ $# -gt 0 ]]; do case "$1" in --output-last-message) printf 'not json' >"$2"; shift 2;; *) shift;; esac; done
cat >/dev/null
`);
    await expect(codexRunner(garbled.binary).run(request(garbled.root), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'malformed_result' });
    const args = (await readFile(join(garbled.root, 'args'), 'utf8')).trim().split('\n');
    await expect(readFile(args[args.indexOf('--output-schema') + 1]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an unconfigured binary unavailable and refuses to run', async () => {
    const runner = codexRunner('');
    await expect(runner.capability()).resolves.toEqual({ available: false, reason: 'configuration_invalid' });
    await expect(runner.run(request('/tmp'), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'capability_unavailable', retryable: false });
  });

  it('times out a run that outlives its deadline', async () => {
    const fixture = await fakeCli('codex', `if [[ "\${1:-}" == "exec" && "\${2:-}" == "--help" ]]; then echo '--ephemeral --ignore-user-config --ignore-rules --sandbox --output-schema --output-last-message'; exit 0; fi
if [[ "\${1:-}" == "login" ]]; then exit 0; fi
cat >/dev/null
sleep 30
`);
    await expect(codexRunner(fixture.binary).run(request(fixture.root, { timeoutMs: 100 }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'timed_out', retryable: true });
  }, 5_000);
});

type FakeClaudeOptions = { stdout?: string; exit?: number; stderr?: string; delaySeconds?: number; help?: string };

// a fake Claude recording its arguments, working directory and prompt, then printing `stdout`
async function fakeClaude(options: FakeClaudeOptions = {}): Promise<{ root: string; binary: string }> {
  const { stdout = '', exit = 0, stderr = '', delaySeconds = 0, help = '--json-schema --tools --output-format --effort --no-session-persistence --strict-mcp-config' } = options;
  return await fakeCli('claude', `if [[ "\${1:-}" == "--help" ]]; then echo ${JSON.stringify(help)}; exit 0; fi
printf '%s\\n' "$@" >"$ROOT/args"
pwd >"$ROOT/cwd"
cat >"$ROOT/prompt"
trap 'exit 143' TERM INT
${delaySeconds > 0 ? `sleep ${delaySeconds}` : ':'}
printf '%s' ${JSON.stringify(stderr)} >&2
printf '%s' ${JSON.stringify(stdout)}
exit ${exit}
`);
}
const claudeResult = (extra: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session', total_cost_usd: 0.01, ...extra });

describe('headless Claude Review runner', () => {
  it('runs print mode with only the read tools and returns the structured output', async () => {
    const fixture = await fakeClaude({ stdout: claudeResult({ structured_output: { answer: 'yes' } }) });
    const runner = claudeRunner(fixture.binary);
    await expect(runner.capability()).resolves.toEqual({ available: true });
    await expect(runner.run(request(fixture.root, { kind: 'claude' }), new AbortController().signal)).resolves.toEqual({ answer: 'yes' });
    const args = (await readFile(join(fixture.root, 'args'), 'utf8')).trim().split('\n');
    expect(args).toEqual(['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', 'Read,Grep,Glob,Skill', '--strict-mcp-config', '--no-session-persistence']);
    expect((await readFile(join(fixture.root, 'cwd'), 'utf8')).trim()).toBe(fixture.root);
    expect(await readFile(join(fixture.root, 'prompt'), 'utf8')).toBe('Explain the change.');
  });

  it('passes the model and effort when given', async () => {
    const fixture = await fakeClaude({ stdout: claudeResult({ structured_output: { answer: 'yes' } }) });
    await claudeRunner(fixture.binary).run(request(fixture.root, { kind: 'claude', model: 'opus', effort: 'max' }), new AbortController().signal);
    const args = (await readFile(join(fixture.root, 'args'), 'utf8')).trim().split('\n');
    expect(args.slice(-4)).toEqual(['--model', 'opus', '--effort', 'max']);
  });

  it('fails an error result, a non-zero exit and a missing structured output distinctly', async () => {
    const errored = await fakeClaude({ stdout: claudeResult({ is_error: true, subtype: 'error_during_execution' }) });
    await expect(claudeRunner(errored.binary).run(request(errored.root, { kind: 'claude' }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'generation_failed', retryable: true });
    const exited = await fakeClaude({ stdout: claudeResult({ structured_output: { answer: 'yes' } }), exit: 1 });
    await expect(claudeRunner(exited.binary).run(request(exited.root, { kind: 'claude' }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'generation_failed' });
    const missing = await fakeClaude({ stdout: claudeResult({}) });
    await expect(claudeRunner(missing.binary).run(request(missing.root, { kind: 'claude' }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'malformed_result', retryable: true });
    const garbled = await fakeClaude({ stdout: 'not json' });
    await expect(claudeRunner(garbled.binary).run(request(garbled.root, { kind: 'claude' }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'malformed_result' });
  });

  it('bounds the structured output by the request, else the tour limit', async () => {
    const fixture = await fakeClaude({ stdout: claudeResult({ structured_output: { answer: 'x'.repeat(100_000) } }) });
    await expect(claudeRunner(fixture.binary).run(request(fixture.root, { kind: 'claude' }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'malformed_result' });
    await expect(claudeRunner(fixture.binary).run(request(fixture.root, { kind: 'claude', maxOutputBytes: 200_000 }), new AbortController().signal)).resolves.toEqual({ answer: 'x'.repeat(100_000) });
  });

  it('classifies a missing login as authentication required', async () => {
    const fixture = await fakeClaude({ stdout: claudeResult({ is_error: true, result: 'Invalid API key · Please run /login' }), exit: 1 });
    await expect(claudeRunner(fixture.binary).run(request(fixture.root, { kind: 'claude' }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'authentication_required', retryable: false });
  });

  it('reports unconfigured and unsupported CLIs unavailable', async () => {
    await expect(claudeRunner('').capability()).resolves.toEqual({ available: false, reason: 'configuration_invalid' });
    await expect(claudeRunner('/nonexistent/claude').capability()).resolves.toEqual({ available: false, reason: 'generator_unavailable' });
    const old = await fakeClaude({ help: '--output-format --tools' });
    await expect(claudeRunner(old.binary).capability()).resolves.toEqual({ available: false, reason: 'unsupported_cli' });
  });

  it('times out and cancels delayed process groups', async () => {
    const slow = await fakeClaude({ delaySeconds: 30 });
    await expect(claudeRunner(slow.binary).run(request(slow.root, { kind: 'claude', timeoutMs: 100 }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'timed_out', retryable: true });
    const controller = new AbortController();
    const pending = claudeRunner(slow.binary).run(request(slow.root, { kind: 'claude' }), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject<ReviewRunError>({ code: 'cancelled', retryable: true });
  }, 8_000);
});

describe('Review run dispatch by mode', () => {
  // a kind runner that records the runs it receives
  const recording = (name: string, capability: ReviewRunCapability = { available: true }) => {
    const runs: string[] = [];
    const runner: KindReviewRunner = { capability: async () => capability, run: async request => { runs.push(`${name}:${request.label}`); return { from: name }; } };
    return { runner, runs };
  };

  it('routes headless kinds to their own runner', async () => {
    const codex = recording('codex'); const claude = recording('claude', { available: false, reason: 'unsupported_cli' });
    const dispatch = new ModeDispatchReviewRunner({ codex: { mode: 'headless' }, claude: { mode: 'headless' } }, { codex: codex.runner, claude: claude.runner });
    await expect(dispatch.capability('codex')).resolves.toEqual({ available: true });
    await expect(dispatch.capability('claude')).resolves.toEqual({ available: false, reason: 'unsupported_cli' });
    await expect(dispatch.run(request('/w', { kind: 'claude', label: 'Review · Deep' }), new AbortController().signal)).resolves.toEqual({ from: 'claude' });
    expect(claude.runs).toEqual(['claude:Review · Deep']);
    expect(codex.runs).toEqual([]);
  });

  it('reports interactive kinds unavailable without an interactive runner, and routes to one when injected', async () => {
    const codex = recording('codex'); const claude = recording('claude');
    const modes = { codex: { mode: 'headless' as const }, claude: { mode: 'interactive' as const } };
    const bare = new ModeDispatchReviewRunner(modes, { codex: codex.runner, claude: claude.runner });
    await expect(bare.capability('claude')).resolves.toEqual({ available: false, reason: 'interactive_unavailable' });
    await expect(bare.run(request('/w', { kind: 'claude' }), new AbortController().signal)).rejects.toMatchObject<ReviewRunError>({ code: 'capability_unavailable', retryable: false });
    const kinds: string[] = [];
    const interactive: ReviewRunner = { capability: async kind => { kinds.push(kind); return { available: true }; }, run: async run => ({ interactive: run.label }) };
    const wired = new ModeDispatchReviewRunner(modes, { codex: codex.runner, claude: claude.runner }, interactive);
    await expect(wired.capability('claude')).resolves.toEqual({ available: true });
    await expect(wired.run(request('/w', { kind: 'claude', label: 'Tour · main' }), new AbortController().signal)).resolves.toEqual({ interactive: 'Tour · main' });
    expect(kinds).toEqual(['claude']);
    expect(claude.runs).toEqual([]);
  });
});

describe('Review run kinds', () => {
  it('are the Adapters that describe Review runs, in registry order', () => {
    expect(reviewAgentKinds).toEqual(['codex', 'claude']);
    expect(adapters.filter(adapter => adapter.reviewRuns === undefined).map(adapter => adapter.kind)).toEqual(['omx']);
  });
});

describe('Review effort levels', () => {
  it('accepts each kind\'s own levels only', () => {
    expect(reviewEfforts.codex).toContain('minimal');
    expect(acceptsReviewEffort('codex', 'minimal')).toBe(true);
    expect(acceptsReviewEffort('claude', 'minimal')).toBe(false);
    expect(acceptsReviewEffort('claude', 'max')).toBe(true);
    expect(acceptsReviewEffort('codex', 'max')).toBe(false);
  });
});
