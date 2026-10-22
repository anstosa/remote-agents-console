import { describe, expect, it } from 'vitest';
import { anchorRange, generatedCodeReviewJsonSchema, parseCodeReview, parseCodeReviewAdd, parseCodeReviewOptions, parseGeneratedCodeReview, parseReviewTourStart, sameCodeReviewOptions, MAX_CODE_REVIEW_OUTPUT_BYTES, CODE_REVIEW_TIMEOUT_MS } from '../src/code-review/contracts.js';
import { codeReviewPrompt, CodeReviewer } from '../src/code-review/reviewer.js';
import type { ReviewPreset } from '../src/review-runs/config.js';
import type { ReviewRunCapability, ReviewRunner, ReviewRunRequest } from '../src/review-runs/runner.js';
import type { ReviewChange, ReviewComparison } from '../src/review-tour/contracts.js';

// a hunk replacing old lines 10-12 with new lines 20-23
const hunk: ReviewChange = { id: 'chg_hunk0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', oldStart: 10, oldLines: 3, newStart: 20, newLines: 4, patch: '@@ -10,3 +20,4 @@\n-a\n-b\n-c\n+a\n+b\n+c\n+d' };
const added: ReviewChange = { id: 'chg_added001', file: 'src/new.ts', category: 'implementation', kind: 'hunk', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, patch: '@@ -0,0 +1,2 @@\n+one\n+two' };
const untracked: ReviewChange = { id: 'chg_untrack1', file: 'notes.txt', category: 'implementation', kind: 'untracked', patch: '--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n' };
const binary: ReviewChange = { id: 'chg_binary01', file: 'logo.png', category: 'implementation', kind: 'binary', patch: 'new binary file logo.png (12 bytes)' };
const changes = [hunk, added, untracked, binary];
const finding = (changeId: string, side: 'additions' | 'deletions', startLine: number, endLine: number, title = 'Off by one') => ({ changeId, side, startLine, endLine, severity: 'high' as const, title, body: 'The loop skips the last item.' });
const comparison: ReviewComparison = { agentId: 'agent-1', worktreeId: 'cora', workspace: '/worktrees/cora', branch: 'feature/review', scope: 'pr', base: 'origin/main', includeTests: true, includeDocs: false, fingerprint: 'fingerprint-1234567890', changes };
const preset: ReviewPreset = { id: 'correctness', label: 'Correctness', agent: 'claude', effort: 'high', prompt: 'Review these changes for correctness.' };

// a fake runner that records its requests and answers with one output
function fakeRunner(output: unknown, capability: ReviewRunCapability = { available: true }, conversation?: string): ReviewRunner & { requests: ReviewRunRequest[] } {
  const requests: ReviewRunRequest[] = [];
  return { requests, capability: async () => capability, run: async request => { requests.push(request); return { value: output, ...(conversation === undefined ? {} : { conversation }) }; }, closeWorktree: async () => {} };
}

describe('code review anchoring', () => {
  it('keeps findings inside the hunk on their side', () => {
    const parsed = parseGeneratedCodeReview({ findings: [finding(hunk.id, 'additions', 20, 23), finding(hunk.id, 'deletions', 10, 12, 'Removed guard'), finding(added.id, 'additions', 2, 2, 'New file')], general: [] }, changes);
    expect(parsed?.findings.map(item => [item.changeId, item.side, item.startLine, item.endLine])).toEqual([[hunk.id, 'additions', 20, 23], [hunk.id, 'deletions', 10, 12], [added.id, 'additions', 2, 2]]);
    expect(parsed?.general).toEqual([]);
  });

  it('turns out-of-range, reversed, empty-side and unknown findings into general ones', () => {
    const parsed = parseGeneratedCodeReview({ findings: [finding(hunk.id, 'additions', 19, 21, 'Before'), finding(hunk.id, 'additions', 23, 24, 'After'), finding(hunk.id, 'deletions', 12, 10, 'Reversed'), finding(added.id, 'deletions', 1, 1, 'No old side'), finding('chg_unknown1', 'additions', 1, 1, 'Unknown')], general: [] }, changes);
    expect(parsed?.findings).toEqual([]);
    expect(parsed?.general.map(item => [item.title, item.file])).toEqual([['Before', hunk.file], ['After', hunk.file], ['Reversed', hunk.file], ['No old side', added.file], ['Unknown', undefined]]);
    expect(parsed?.general[0]).toMatchObject({ severity: 'high', body: 'The loop skips the last item.' });
  });

  it('anchors untracked additions to the patch line count and refuses binary changes', () => {
    expect(anchorRange(untracked, 'additions')).toEqual({ first: 1, last: 3 });
    expect(anchorRange(untracked, 'deletions')).toBeUndefined();
    // a content line starting with `++ ` reads as `+++ ` in the patch and still counts
    expect(anchorRange({ ...untracked, patch: '--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1,2 @@\n+++ counter\n+x\n' }, 'additions')).toEqual({ first: 1, last: 2 });
    expect(anchorRange({ ...untracked, patch: '--- /dev/null\n+++ b/one.txt\n@@ -0,0 +1 @@\n+only\n' }, 'additions')).toEqual({ first: 1, last: 1 });
    expect(anchorRange({ ...untracked, patch: '--- /dev/null\n+++ b/empty.txt\n@@ -0,0 +1,0 @@\n' }, 'additions')).toBeUndefined();
    expect(anchorRange(binary, 'additions')).toBeUndefined();
    const parsed = parseGeneratedCodeReview({ findings: [finding(untracked.id, 'additions', 1, 3), finding(untracked.id, 'additions', 3, 4, 'Past end'), finding(binary.id, 'additions', 1, 1, 'Binary')], general: [] }, changes);
    expect(parsed?.findings.map(item => item.changeId)).toEqual([untracked.id]);
    expect(parsed?.general.map(item => [item.title, item.file])).toEqual([['Past end', untracked.file], ['Binary', binary.file]]);
  });

  it('keeps the model general findings with their optional file', () => {
    const parsed = parseGeneratedCodeReview({ findings: [], general: [{ severity: 'low', title: 'Missing test', body: 'Nothing covers the error path.', file: null }, { severity: 'medium', title: 'Docs', body: 'The README is stale.', file: 'README.md' }] }, changes);
    expect(parsed?.general.map(item => item.file)).toEqual([undefined, 'README.md']);
  });

  it('rejects output outside the schema', () => {
    expect(parseGeneratedCodeReview({ findings: [] }, changes)).toBeUndefined();
    expect(parseGeneratedCodeReview({ findings: [{ ...finding(hunk.id, 'additions', 20, 20), severity: 'critical' }], general: [] }, changes)).toBeUndefined();
    expect(parseGeneratedCodeReview({ findings: [{ ...finding(hunk.id, 'additions', 20, 20), title: 'x'.repeat(201) }], general: [] }, changes)).toBeUndefined();
    expect(parseGeneratedCodeReview({ findings: [{ ...finding(hunk.id, 'additions', 20, 20), body: 'x'.repeat(4_001) }], general: [] }, changes)).toBeUndefined();
    expect(parseGeneratedCodeReview({ findings: Array.from({ length: 101 }, () => finding(hunk.id, 'additions', 20, 20)), general: [] }, changes)).toBeUndefined();
    expect(parseGeneratedCodeReview({ findings: [], general: Array.from({ length: 31 }, () => ({ severity: 'low', title: 't', body: 'b', file: null })) }, changes)).toBeUndefined();
    expect(parseGeneratedCodeReview({ findings: [{ ...finding(hunk.id, 'additions', 0, 1) }], general: [] }, changes)).toBeUndefined();
  });
});

describe('code review finding ids', () => {
  it('names findings by a stable content digest and dedupes identical ones', () => {
    const output = { findings: [finding(hunk.id, 'additions', 20, 21), finding(hunk.id, 'additions', 20, 21), finding(hunk.id, 'additions', 20, 22)], general: [{ severity: 'low', title: 'Same', body: 'Same body.', file: null }, { severity: 'low', title: 'Same', body: 'Same body.', file: null }] };
    const first = parseGeneratedCodeReview(output, changes)!;
    const second = parseGeneratedCodeReview(output, changes)!;
    expect(first.findings).toHaveLength(2);
    expect(first.general).toHaveLength(1);
    expect(first.findings[0]!.id).toMatch(/^fnd_[A-Za-z0-9_-]{16}$/u);
    expect(first.findings[0]!.id).not.toBe(first.findings[1]!.id);
    expect([...first.findings, ...first.general].map(item => item.id)).toEqual([...second.findings, ...second.general].map(item => item.id));
  });
});

describe('code review requests', () => {
  it('parses options, tour starts and add requests', () => {
    expect(parseCodeReviewOptions({ preset: 'correctness', effort: 'high', focus: '  the cache  ' })).toEqual({ preset: 'correctness', effort: 'high', focus: 'the cache' });
    expect(parseCodeReviewOptions({ preset: 'correctness', focus: '   ' })).toEqual({ preset: 'correctness' });
    expect(parseCodeReviewOptions({ preset: 'correctness', focus: 'x'.repeat(2_001) })).toBeUndefined();
    expect(parseCodeReviewOptions({ preset: 'bad preset' })).toBeUndefined();
    expect(parseCodeReviewOptions({ preset: 'correctness', extra: true })).toBeUndefined();
    expect(parseReviewTourStart({ scope: 'pr', includeTests: false, includeDocs: false, effort: 'low', codeReview: { preset: 'correctness' } })).toEqual({ input: { scope: 'pr', includeTests: false, includeDocs: false, effort: 'low' }, codeReview: { preset: 'correctness' } });
    expect(parseReviewTourStart({ scope: 'pr', includeTests: false, includeDocs: false })).toEqual({ input: { scope: 'pr', includeTests: false, includeDocs: false } });
    expect(parseReviewTourStart({ scope: 'pr', includeTests: false, includeDocs: false, codeReview: { preset: 3 } })).toBeUndefined();
    expect(parseReviewTourStart({ scope: 'pr', includeTests: false, includeDocs: false, codeReview: null })).toBeUndefined();
    expect(parseCodeReviewAdd({ scope: 'working', includeTests: true, includeDocs: false, fingerprint: 'fingerprint-1234567890', preset: 'correctness', effort: 'max' })).toEqual({ input: { scope: 'working', includeTests: true, includeDocs: false }, fingerprint: 'fingerprint-1234567890', options: { preset: 'correctness', effort: 'max' } });
    expect(parseCodeReviewAdd({ scope: 'working', includeTests: true, includeDocs: false, preset: 'correctness' })).toBeUndefined();
    expect(sameCodeReviewOptions({ preset: 'a', focus: 'x' }, { preset: 'a', focus: 'x' })).toBe(true);
    expect(sameCodeReviewOptions({ preset: 'a' }, { preset: 'a', effort: 'high' })).toBe(false);
    expect(sameCodeReviewOptions(undefined, undefined)).toBe(true);
  });

  it('keeps every output property required for strict structured output', () => {
    expect(generatedCodeReviewJsonSchema.properties.general.items.required).toContain('file');
    expect(generatedCodeReviewJsonSchema.properties.findings.items.required).toEqual(['changeId', 'side', 'startLine', 'endLine', 'severity', 'title', 'body']);
  });
});

describe('code review prompt', () => {
  it('appends the focus and the server-owned contract after the preset prompt', () => {
    const prompt = codeReviewPrompt(preset.prompt, 'Watch the retry loop.', comparison);
    expect(prompt.startsWith(preset.prompt)).toBe(true);
    expect(prompt.indexOf('Additional focus for this review: Watch the retry loop.')).toBeGreaterThan(prompt.indexOf(preset.prompt));
    expect(prompt).toContain('Review only the provided changes');
    expect(prompt).toContain('new-file line numbers');
    expect(prompt).toContain('old-file line numbers');
    expect(prompt).toContain('`general`');
    expect(prompt).toContain('Severity: high');
    expect(prompt).toContain('Return empty arrays when you find nothing.');
    expect(prompt).toContain('Return JSON matching the supplied schema.');
    expect(prompt).toContain('Scope: pr; base: origin/main; tests included: true; docs included: false.');
    const list = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as { changes: Array<Record<string, unknown>> };
    expect(list.changes[0]).toEqual({ id: hunk.id, file: hunk.file, kind: 'hunk', oldStart: 10, oldLines: 3, newStart: 20, newLines: 4, patch: hunk.patch });
    expect(codeReviewPrompt(preset.prompt, undefined, comparison)).not.toContain('Additional focus');
  });
});

describe('code reviewer', () => {
  it('validates presets and efforts and defaults the effort to the preset', async () => {
    const reviewer = new CodeReviewer(fakeRunner({}), { presets: [preset], defaultPreset: preset.id });
    await expect(reviewer.resolve({ preset: 'missing' })).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    await expect(reviewer.resolve({ preset: preset.id, effort: 'minimal' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await reviewer.resolve({ preset: preset.id })).toMatchObject({ preset, effort: 'high' });
    expect(await reviewer.resolve({ preset: preset.id, effort: 'max', focus: 'cache' })).toMatchObject({ effort: 'max', focus: 'cache' });
    const unavailable = new CodeReviewer(fakeRunner({}, { available: false, reason: 'interactive_unavailable' }), { presets: [preset], defaultPreset: preset.id });
    await expect(unavailable.resolve({ preset: preset.id })).rejects.toMatchObject({ code: 'capability_unavailable', retryable: false });
    expect(await unavailable.capability()).toEqual({ defaultPreset: 'correctness', presets: [{ id: 'correctness', label: 'Correctness', agent: 'claude', effort: 'high', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], available: false, reason: 'interactive_unavailable' }] });
  });

  it('runs the preset on its agent and returns an anchored review', async () => {
    const conversation = '6f1c2a90-1111-4222-8333-444455556666';
    const runner = fakeRunner({ findings: [finding(hunk.id, 'additions', 20, 20), finding(hunk.id, 'additions', 99, 99, 'Outside')], general: [] }, undefined, conversation);
    const reviewer = new CodeReviewer(runner, { presets: [{ ...preset, model: 'opus' }], defaultPreset: preset.id });
    const review = await reviewer.run(comparison, await reviewer.resolve({ preset: preset.id, focus: 'retries' }), new AbortController().signal);
    expect(runner.requests[0]).toMatchObject({ kind: 'claude', workspace: '/worktrees/cora', model: 'opus', effort: 'high', timeoutMs: CODE_REVIEW_TIMEOUT_MS, maxOutputBytes: MAX_CODE_REVIEW_OUTPUT_BYTES, label: '🔍 Review · Correctness', reply: { kind: 'json', schema: generatedCodeReviewJsonSchema } });
    // an interactive run checks the output shape and quotes what failed in its one correction
    const { reply } = runner.requests[0]!;
    const validate = reply.kind === 'json' ? reply.validate : undefined;
    expect(validate?.({ findings: [], general: [] })).toBeUndefined();
    expect(validate?.({ findings: [] })).toBe('general: Required');
    expect(runner.requests[0]!.prompt).toContain('Additional focus for this review: retries');
    // the review keeps the reviewer's conversation for an Ask about a Finding
    expect(review).toMatchObject({ fingerprint: comparison.fingerprint, preset: { id: 'correctness', label: 'Correctness', agent: 'claude' }, effort: 'high', focus: 'retries', findings: [{ startLine: 20 }], general: [{ title: 'Outside', file: hunk.file }], conversation });
    expect(parseCodeReview(review)).toEqual(review);
    // a conversation the reviewer's agent could not resume is neither kept nor accepted from storage
    const unresumable = await new CodeReviewer(fakeRunner({ findings: [], general: [] }, undefined, '--resume'), { presets: [preset], defaultPreset: preset.id }).run(comparison, { preset }, new AbortController().signal);
    expect(unresumable).not.toHaveProperty('conversation');
    expect(parseCodeReview({ ...review, conversation: 'not-a-conversation' })).toBeUndefined();
    await expect(new CodeReviewer(fakeRunner({ nope: true }), { presets: [preset], defaultPreset: preset.id }).run(comparison, { preset }, new AbortController().signal)).rejects.toMatchObject({ code: 'malformed_result', retryable: true });
  });
});
