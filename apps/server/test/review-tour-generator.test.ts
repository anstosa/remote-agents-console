import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REVIEW_GENERATED_BYTES, ReviewTourError, type ReviewComparison } from '../src/review-tour/contracts.js';
import { ConfiguredReviewTourGenerator } from '../src/review-tour/generator.js';
import { HeadlessReviewRunner } from '../src/review-runs/headless.js';
import { reviewRunsFor } from '../src/review-runs/kinds.js';
import { builtInTourPrompt, type ResolvedReviewTour } from '../src/review-runs/config.js';
import type { ReviewRunner, ReviewRunRequest } from '../src/review-runs/runner.js';

const roots: string[] = [];
const defaultTour: ResolvedReviewTour = { agent: 'codex', prompt: builtInTourPrompt };
// a tour generator on the headless Codex runner, as app.ts wires a headless Codex tour
const codexGenerator = (binary: string, tour: ResolvedReviewTour = defaultTour) => new ConfiguredReviewTourGenerator(new HeadlessReviewRunner(reviewRunsFor('codex').headless, binary), tour);
const change = { id: 'chg_12345678', file: 'src/feature.ts', category: 'implementation' as const, kind: 'hunk' as const, patch: '@@ -1 +1 @@\n-old\n+new' };
type FakeCodexOptions = { delaySeconds?: number; supported?: boolean; authenticated?: boolean; stderrBytes?: number; failure?: string };

// build one generator input
function comparison(workspace: string): ReviewComparison {
  return { agentId: 'agent-1', worktreeId: 'cora', workspace, scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'fingerprint', changes: [change] };
}

// create a deterministic fake Codex executable
async function fakeCodex(result: unknown, options: FakeCodexOptions = {}): Promise<{ root: string; binary: string }> {
  const { delaySeconds = 0, supported = true, authenticated = true, stderrBytes = 0, failure } = options;
  const root = await mkdtemp(join(tmpdir(), 'rac-review-generator-'));
  roots.push(root);
  const binary = join(root, 'codex');
  const help = supported ? '--ephemeral --ignore-user-config --ignore-rules --sandbox --output-schema --output-last-message' : '--ephemeral';
  const script = `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "exec" && "\${2:-}" == "--help" ]]; then printf '%s\\n' '${help}'; exit 0; fi
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then exit ${authenticated ? 0 : 1}; fi
output=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-last-message" ]]; then output="$2"; shift 2; else shift; fi
done
cat >${JSON.stringify(join(root, 'prompt'))}
trap 'exit 143' TERM INT
${delaySeconds > 0 ? `sleep ${delaySeconds}` : ':'}
${stderrBytes > 0 ? `printf '%*s' ${stderrBytes} '' | tr ' ' x >&2` : ':'}
${failure === undefined ? ':' : `printf '%s\\n' ${JSON.stringify(failure)} >&2; exit 1`}
cat >"$output" <<'JSON'
${JSON.stringify(result)}
JSON
`;
  await writeFile(binary, script);
  await chmod(binary, 0o700);
  return { root, binary };
}

afterEach(async () => {
  // remove fake executables
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Codex headless review tour generator', () => {
  it('runs the supported structured read-only surface and validates its artifact', async () => {
    const generated = { title: 'Feature path', overview: 'Follow the feature path.', steps: [{ id: 'feature', title: 'Apply the feature', explanation: 'The implementation updates the value.', changeIds: [change.id] }] };
    const fixture = await fakeCodex(generated);
    const generator = codexGenerator(fixture.binary);
    await expect(generator.capability()).resolves.toEqual({ available: true, agent: 'codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] });
    await expect(generator.generate(comparison(fixture.root), new AbortController().signal)).resolves.toEqual(generated);
    const prompt = await readFile(join(fixture.root, 'prompt'), 'utf8');
    expect(prompt).toContain('Give the tour a concise, specific title naming the implementation change or outcome.');
    expect(prompt).toContain('Do not use a broad category label such as "Mobile layout" as the title.');
  });

  it('rejects finding-shaped output separately from malformed output', async () => {
    const fixture = await fakeCodex({ title: 'Finding: unsafe path', overview: 'Review result.', steps: [{ id: 'feature', title: 'Apply the feature', explanation: 'Explanation.', changeIds: [change.id] }] });
    const generator = codexGenerator(fixture.binary);
    await expect(generator.generate(comparison(fixture.root), new AbortController().signal)).rejects.toMatchObject<ReviewTourError>({ code: 'generation_rejected', retryable: true });
  });

  it('accepts valid output after bounded verbose diagnostics', async () => {
    const generated = { title: 'Large feature path', overview: 'Follow the complete feature path.', steps: [{ id: 'feature', title: 'Apply the feature', explanation: 'The implementation updates the value.', changeIds: [change.id] }] };
    const fixture = await fakeCodex(generated, { stderrBytes: MAX_REVIEW_GENERATED_BYTES + 1_024 });
    await expect(codexGenerator(fixture.binary).generate(comparison(fixture.root), new AbortController().signal)).resolves.toEqual(generated);
  });

  it('distinguishes an expired Codex login from other process failures', async () => {
    const expired = await fakeCodex({}, { failure: 'ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.' });
    const failed = await fakeCodex({}, { failure: 'user\nChanged code: Please sign in again.\nERROR: model generation stopped unexpectedly' });
    await expect(codexGenerator(expired.binary).generate(comparison(expired.root), new AbortController().signal)).rejects.toMatchObject<ReviewTourError>({ code: 'authentication_required', retryable: false });
    await expect(codexGenerator(failed.binary).generate(comparison(failed.root), new AbortController().signal)).rejects.toMatchObject<ReviewTourError>({ code: 'generation_failed', retryable: true });
  });

  it('reports unsupported binaries and cancels delayed process groups', async () => {
    const unsupported = await fakeCodex({}, { supported: false });
    await expect(codexGenerator(unsupported.binary).capability()).resolves.toMatchObject({ available: false, reason: 'unsupported_cli' });
    const unauthenticated = await fakeCodex({}, { authenticated: false });
    await expect(codexGenerator(unauthenticated.binary).capability()).resolves.toMatchObject({ available: false, reason: 'authentication_required' });
    const delayed = await fakeCodex({ title: 'Tour' }, { delaySeconds: 30 });
    const generator = codexGenerator(delayed.binary);
    const controller = new AbortController();
    const pending = generator.generate(comparison(delayed.root), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject<ReviewTourError>({ code: 'cancelled', retryable: true });
  }, 5_000);
});

describe('configured review tour generator', () => {
  const generated = { title: 'Feature path', overview: 'Follow the feature path.', steps: [{ id: 'feature', title: 'Apply the feature', explanation: 'The implementation updates the value.', changeIds: [change.id] }] };
  // a runner that records each request and answers with the generated tour
  const recording = () => {
    const requests: ReviewRunRequest[] = [];
    const runner: ReviewRunner = { capability: async () => ({ available: false, reason: 'interactive_unavailable' }), run: async request => { requests.push(request); return generated; } };
    return { runner, requests };
  };

  it('runs on the configured agent, model and effort, with a per-run effort taking precedence', async () => {
    const { runner, requests } = recording();
    const generator = new ConfiguredReviewTourGenerator(runner, { agent: 'claude', model: 'opus', effort: 'high', prompt: builtInTourPrompt });
    await expect(generator.capability()).resolves.toEqual({ available: false, reason: 'interactive_unavailable', agent: 'claude', effort: 'high', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    await expect(generator.generate({ ...comparison('/worktrees/cora'), branch: 'feature/x' }, new AbortController().signal)).resolves.toEqual(generated);
    await generator.generate(comparison('/worktrees/cora'), new AbortController().signal, 'max');
    expect(requests.map(request => [request.kind, request.model, request.effort, request.label])).toEqual([['claude', 'opus', 'high', '🗺 Tour · feature/x'], ['claude', 'opus', 'max', '🗺 Tour · cora']]);
    expect(requests[0]!.schema).toMatchObject({ required: ['title', 'overview', 'steps'] });
  });

  it('names the run for an interactive Agent and validates a reply with errors an agent can correct', async () => {
    const { runner, requests } = recording();
    await new ConfiguredReviewTourGenerator(runner, { agent: 'codex', prompt: builtInTourPrompt }).generate(comparison('/w'), new AbortController().signal);
    const validate = requests[0]!.validate!;
    expect(requests[0]!.worktreeId).toBe(comparison('/w').worktreeId);
    expect(validate(generated)).toBeUndefined();
    expect(validate({ ...generated, steps: [{ ...generated.steps[0]!, changeIds: ['chg_unknown01'] }] })).toBe('change ID "chg_unknown01" is not one of the provided change IDs');
    expect(validate({ title: 'Tour' })).toMatch(/^overview: Required/u);
  });

  it('omits the effort when neither the run nor the configuration names one', async () => {
    const { runner, requests } = recording();
    await new ConfiguredReviewTourGenerator(runner, defaultTour).generate(comparison('/w'), new AbortController().signal);
    expect(requests[0]).not.toHaveProperty('effort');
    expect(requests[0]).not.toHaveProperty('model');
  });

  it('replaces the narration guidance with a configured prompt but always appends the contract', async () => {
    const { runner, requests } = recording();
    await new ConfiguredReviewTourGenerator(runner, { agent: 'codex', prompt: 'Narrate like a pirate.' }).generate(comparison('/w'), new AbortController().signal);
    const prompt = requests[0]!.prompt;
    expect(prompt.startsWith('Narrate like a pirate.')).toBe(true);
    expect(prompt).not.toContain('Give the tour a concise, specific title');
    expect(prompt).toContain('Assign every change ID exactly once.');
    expect(prompt).toContain('Do not perform code review.');
    expect(prompt).toContain('Use only the provided change IDs in changeIds. Return JSON matching the supplied schema.');
    expect(prompt).toContain('Scope: working; base: HEAD; tests included: false; docs included: false.');
    expect(prompt).toContain(JSON.stringify(change.id));
  });

  it('still rejects output that does not assign every change exactly once', async () => {
    const runner: ReviewRunner = { capability: async () => ({ available: true }), run: async () => ({ ...generated, steps: [{ ...generated.steps[0], changeIds: ['chg_unknown0'] }] }) };
    await expect(new ConfiguredReviewTourGenerator(runner, defaultTour).generate(comparison('/w'), new AbortController().signal)).rejects.toMatchObject<ReviewTourError>({ code: 'malformed_result', retryable: true });
  });
});
