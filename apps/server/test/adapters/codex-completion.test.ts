import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexManagedLifecycleCompatible, codexPromptAccepted, codexRolloutBaseline, codexTurnSince, completionFromRecords, managedPromptLifecycleFromRecords, maxOrdinalFromRecords, promptAcceptedFromRecords } from '../../src/adapters/codex-conversations.js';
import { codexHome, fakeProc, tempDir } from '../helpers/codex-fixtures.js';

type Record = { type: string; ordinal: number; payload: unknown };

// one turn's lifecycle as Codex records it: task_started, the response items, then a
// terminal task_complete carrying the answer (a real rollout, trimmed to essentials)
const turnRecords = (base: number, turnId: string, prompt: string, answer: string): Record[] => [
  { type: 'response_item', ordinal: base, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
  { type: 'event_msg', ordinal: base + 1, payload: { type: 'task_started', turn_id: turnId, started_at: '2026-08-30T15:32:24.000Z' } },
  { type: 'response_item', ordinal: base + 2, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } },
  { type: 'event_msg', ordinal: base + 3, payload: { type: 'task_complete', turn_id: turnId, last_agent_message: answer, duration_ms: 1200, completed_at: '2026-08-30T15:32:25.200Z' } }
];

// write one representative Codex rollout with ordinal-stamped records, returning
// its path. `createdAt` sets both the `session_meta` timestamp and the file's
// date-partition and name (Codex names a rollout after its second-precision start).
async function writeRollout(home: string, id: string, records: Record[], cwd = '/home/ubuntu/cora', createdAt = '2026-08-30T15:32:23.000Z'): Promise<string> {
  const [year, month, day] = createdAt.slice(0, 10).split('-');
  const directory = join(home, 'sessions', year, month, day);
  await mkdir(directory, { recursive: true });
  const meta = { type: 'session_meta', ordinal: 0, payload: { id, cwd, timestamp: createdAt, originator: 'codex-tui', cli_version: '0.164.0' } };
  const stamp = createdAt.slice(0, 19).replace(/:/gu, '-');
  const file = join(directory, `rollout-${stamp}-${id}.jsonl`);
  await writeFile(file, `${[meta, ...records].map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

const lines = (records: Record[]): string[] => records.map(record => JSON.stringify(record));

// build one durable Codex user-prompt receipt
const promptRecord = (ordinal: number, prompt: string): Record => ({
  type: 'response_item',
  ordinal,
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }
});

describe('Codex rollout completion', () => {
  it('correlates one exact numeric native turn without using record timestamps', () => {
    const prompt = 'Do it';
    const identity = { fingerprint: createHash('sha256').update(prompt).digest('hex'), transportFingerprint: createHash('sha256').update(`${prompt} `).digest('hex') };
    const records: Record[] = [
      promptRecord(1, prompt),
      { type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_792_775_807 } },
      { type: 'event_msg', ordinal: 3, payload: { type: 'task_complete', turn_id: 'other', completed_at: 1_792_775_900 } },
      { type: 'event_msg', ordinal: 4, payload: { type: 'task_complete', turn_id: 'turn-1', completed_at: 1_792_776_107 } }
    ];
    expect(managedPromptLifecycleFromRecords(lines(records), 0, identity)).toEqual({ state: 'finished', source: 'codex-rollout', parserVersion: 1, receiptOrdinal: 1, startOrdinal: 2, terminalOrdinal: 4, turnId: 'turn-1', startedAt: '2026-10-23T17:16:47.000Z', finishedAt: '2026-10-23T17:21:47.000Z' });
  });

  it('fails closed for string payload times and competing receipts', () => {
    const prompt = 'Do it';
    const identity = { fingerprint: createHash('sha256').update(prompt).digest('hex'), transportFingerprint: createHash('sha256').update(`${prompt} `).digest('hex') };
    const stringTime: Record[] = [promptRecord(1, prompt), { type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 'turn-1', started_at: '2026-10-23T09:30:07Z' } }];
    expect(managedPromptLifecycleFromRecords(lines(stringTime), 0, identity)).toEqual({ state: 'invalid', reason: 'unsupported_lifecycle_contract' });
    const competing: Record[] = [promptRecord(1, prompt), promptRecord(2, 'direct terminal input'), { type: 'event_msg', ordinal: 3, payload: { type: 'task_started', turn_id: 'turn-2', started_at: 1_792_775_807 } }];
    expect(managedPromptLifecycleFromRecords(lines(competing), 0, identity)).toEqual({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
  });

  it('continues from persisted exact start evidence after the receipt leaves the bounded tail', () => {
    const prompt = 'Do it';
    const identity = { fingerprint: createHash('sha256').update(prompt).digest('hex'), transportFingerprint: createHash('sha256').update(`${prompt} `).digest('hex') };
    const terminal: Record[] = [{ type: 'event_msg', ordinal: 500, payload: { type: 'task_complete', turn_id: 'turn-long', completed_at: 1_792_776_107 } }];
    expect(managedPromptLifecycleFromRecords(lines(terminal), 0, identity, { receiptOrdinal: 1, startOrdinal: 2, turnId: 'turn-long', startedAt: '2026-10-23T17:16:47.000Z' })).toEqual({ state: 'finished', source: 'codex-rollout', parserVersion: 1, receiptOrdinal: 1, startOrdinal: 2, terminalOrdinal: 500, turnId: 'turn-long', startedAt: '2026-10-23T17:16:47.000Z', finishedAt: '2026-10-23T17:21:47.000Z' });
  });

  it('gates managed lifecycle parsing on the pinned Codex compatibility probe', () => {
    expect(codexManagedLifecycleCompatible('0.164.0')).toBe(true);
    expect(codexManagedLifecycleCompatible('0.165.0')).toBe(false);
    expect(codexManagedLifecycleCompatible(undefined)).toBe(true);
    const fixture = readFileSync(new URL('../fixtures/codex/managed-lifecycle-v1.jsonl', import.meta.url), 'utf8').trim().split('\n');
    expect(JSON.parse(fixture[0]!).payload.cli_version).toBe('0.164.0');
    const prompt = 'sanitized managed lifecycle probe';
    const identity = { fingerprint: createHash('sha256').update(prompt).digest('hex'), transportFingerprint: createHash('sha256').update(`${prompt} `).digest('hex') };
    expect(managedPromptLifecycleFromRecords(fixture, 40, identity).state).toBe('finished');
  });

  it('reads a completed turn and its answer from the task_complete event', () => {
    const records = turnRecords(1, 't1', 'Summarize the change', 'It renames the flag.');
    expect(completionFromRecords(lines(records), 0)).toEqual({ kind: 'completed', ordinal: 4, answer: 'It renames the flag.' });
  });

  it('only reports turns recorded past the baseline ordinal', () => {
    const records = [...turnRecords(1, 't1', 'First', 'First answer'), ...turnRecords(5, 't2', 'Second', 'Second answer')];
    // baseline just before the second turn: the first turn's completion is ignored
    expect(completionFromRecords(lines(records), 4)).toEqual({ kind: 'completed', ordinal: 8, answer: 'Second answer' });
    // baseline at or past the newest completion: nothing new yet
    expect(completionFromRecords(lines(records), 8)).toEqual({ kind: 'pending' });
    // a Review run reads past the captured-Turn bound
    const long = 'x'.repeat(70_000);
    const longRecords = [{ type: 'event_msg', ordinal: 1, payload: { type: 'task_complete', last_agent_message: long } }];
    expect((completionFromRecords(lines(longRecords), 0) as { answer: string }).answer).toHaveLength(64_000);
    expect((completionFromRecords(lines(longRecords), 0, 100_000) as { answer: string }).answer).toHaveLength(70_000);
  });

  it('reports an interrupted turn as aborted', () => {
    const records: Record[] = [
      { type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it' }] } },
      { type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 't1', started_at: '2026-08-30T15:32:24.000Z' } },
      { type: 'event_msg', ordinal: 3, payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted', duration_ms: 400, completed_at: '2026-08-30T15:32:24.400Z' } }
    ];
    expect(completionFromRecords(lines(records), 0)).toEqual({ kind: 'aborted', ordinal: 3 });
  });

  it('stays pending while only task_started has been recorded', () => {
    const records: Record[] = [
      { type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it' }] } },
      { type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 't1', started_at: '2026-08-30T15:32:24.000Z' } }
    ];
    expect(completionFromRecords(lines(records), 0)).toEqual({ kind: 'pending' });
  });

  it('ignores truncated JSON lines and honours the newest terminal event', () => {
    const records = turnRecords(1, 't1', 'Prompt', 'Answer');
    expect(completionFromRecords([...lines(records), '{"type":"event_msg","ordina'], 0)).toEqual({ kind: 'completed', ordinal: 4, answer: 'Answer' });
  });

  it('reports the max ordinal as a baseline, skipping unparseable lines', () => {
    const records = turnRecords(1, 't1', 'Prompt', 'Answer');
    expect(maxOrdinalFromRecords([...lines(records), 'not json'])).toBe(4);
    expect(maxOrdinalFromRecords([])).toBeUndefined();
  });

  // preserve prompt bytes except documented transport padding
  it('accepts exact prompt text and the known trailing transport space', () => {
    expect(promptAcceptedFromRecords(lines([promptRecord(5, 'yes, fix it')]), 4, 'yes, fix it')).toBe(true);
    expect(promptAcceptedFromRecords(lines([promptRecord(5, 'yes, fix it ')]), 4, 'yes, fix it')).toBe(true);
  });

  // distinguish meaningful whitespace changes
  it('rejects differences in internal spaces, newlines, and indentation', () => {
    expect(promptAcceptedFromRecords(lines([promptRecord(5, 'yes,  fix it')]), 4, 'yes, fix it')).toBe(false);
    expect(promptAcceptedFromRecords(lines([promptRecord(5, 'yes,\nfix it')]), 4, 'yes, fix it')).toBe(false);
    expect(promptAcceptedFromRecords(lines([promptRecord(5, 'line one\n code')]), 4, 'line one\n  code')).toBe(false);
  });

  // preserve authored trailing whitespace
  it('rejects deletion of user-authored trailing whitespace', () => {
    expect(promptAcceptedFromRecords(lines([promptRecord(5, 'yes, fix it')]), 4, 'yes, fix it ')).toBe(false);
    expect(promptAcceptedFromRecords(lines([promptRecord(5, 'yes, fix it')]), 4, 'yes, fix it\n')).toBe(false);
  });

  // exclude old and unrelated receipts
  it('rejects prompt receipts at the baseline or with different text', () => {
    const records = [promptRecord(4, 'yes, fix it'), promptRecord(5, 'no, leave it')];
    expect(promptAcceptedFromRecords(lines(records), 4, 'yes, fix it')).toBe(false);
  });

  // accept only one user text record
  it('rejects assistant, tool, instruction, and mixed-content records', () => {
    const records: Record[] = [
      { type: 'response_item', ordinal: 5, payload: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'yes, fix it' }] } },
      { type: 'response_item', ordinal: 6, payload: { type: 'function_call', role: 'user', content: [{ type: 'input_text', text: 'yes, fix it' }] } },
      { type: 'response_item', ordinal: 7, payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'yes, fix it' }] } },
      { type: 'response_item', ordinal: 8, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'yes, fix it' }, { type: 'tool_result', text: 'extra' }] } }
    ];
    expect(promptAcceptedFromRecords(lines(records), 4, 'yes, fix it')).toBe(false);
  });

  // fail closed on invalid rollout records
  it('rejects malformed and truncated prompt records', () => {
    const malformed = JSON.stringify({ type: 'response_item', ordinal: 5, payload: { type: 'message', role: 'user', content: [{ type: 'input_text' }] } });
    expect(promptAcceptedFromRecords(['null', '[]', '7', '"text"', malformed, '{"type":"response_item","ordinal":6'], 4, 'yes, fix it')).toBe(false);
  });

  it('resolves the pane rollout by fd-walk and reads its baseline and newest completion', async () => {
    const home = await codexHome();
    const id = '0198d100-0000-7000-8000-000000000001';
    const file = await writeRollout(home, id, turnRecords(1, 't1', 'Add the reader', 'Reader added.'));
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [file]);

    // session_meta(0) + 4 turn records -> max ordinal 4, pinned to the resolved file
    await expect(codexRolloutBaseline({ pid: 321 })).resolves.toEqual({ rollout: file, ordinal: 4 });
    await expect(codexTurnSince({ rollout: file, ordinal: 0 })).resolves.toEqual({ kind: 'completed', ordinal: 4, answer: 'Reader added.' });
    await expect(codexTurnSince({ rollout: file, ordinal: 4 })).resolves.toEqual({ kind: 'pending' });
  });

  // acknowledge only fresh input in the original rollout
  it('reads prompt acceptance from the pinned pre-send rollout baseline', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const file = await writeRollout(home, '0198d100-0000-7000-8000-000000000011', turnRecords(1, 'old', 'Earlier', 'Earlier answer.'), cwd);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [file]);
    const baseline = await codexRolloutBaseline({ pid: 321, cwd });
    expect(baseline).toEqual({ rollout: file, ordinal: 4 });

    await appendFile(file, `${JSON.stringify(promptRecord(5, 'yes, fix it'))}\n`);
    await expect(codexPromptAccepted(baseline!, 'yes, fix it')).resolves.toBe(true);
    await expect(codexPromptAccepted({ rollout: file, ordinal: 5 }, 'yes, fix it')).resolves.toBe(false);
  });

  // retain recovery without readable receipt evidence
  it('returns false when the pinned rollout cannot be read', async () => {
    const missing = join(tmpdir(), `rac-missing-rollout-${Date.now()}.jsonl`);
    await expect(codexPromptAccepted({ rollout: missing, ordinal: 0 }, 'yes, fix it')).resolves.toBe(false);
  });

  it('falls back to the working-directory match when the fd-walk is blocked', async () => {
    const home = await codexHome();
    const id = '0198d100-0000-7000-8000-000000000002';
    // writeRollout records cwd '/home/ubuntu/cora' in session_meta
    const file = await writeRollout(home, id, turnRecords(1, 't1', 'Add it', 'Added.'));
    process.env.CODEX_HOME = home;
    // no descriptors: a confined service cannot readlink a sandboxed pane's fds
    process.env.RAC_HOST_PROC = await fakeProc(321, []);

    await expect(codexRolloutBaseline({ pid: 321, cwd: '/home/ubuntu/cora' })).resolves.toEqual({ rollout: file, ordinal: 4 });
    // a non-matching directory resolves nothing rather than a stranger's rollout
    await expect(codexRolloutBaseline({ pid: 321, cwd: '/home/ubuntu/other' })).resolves.toBeUndefined();
  });

  it('matches the raw host cwd even when realpath resolves elsewhere (Docker bind mounts)', async () => {
    const home = await codexHome();
    // the host worktree the pane reports (`#{pane_current_path}`) is, inside the
    // container, a symlink whose realpath differs — as a differently bind-mounted
    // worktree would be; Codex recorded that same host path string in session_meta
    const realDir = await tempDir('rac-real-');
    const linkParent = await tempDir('rac-link-');
    const hostCwd = join(linkParent, 'project');
    await symlink(realDir, hostCwd);
    const id = '0198d100-0000-7000-8000-000000000003';
    const file = await writeRollout(home, id, turnRecords(1, 't1', 'Do it', 'Done.'), hostCwd);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, []);

    // realpath(hostCwd) === realDir !== hostCwd, so only the raw-string match resolves it
    await expect(codexRolloutBaseline({ pid: 321, cwd: hostCwd })).resolves.toEqual({ rollout: file, ordinal: 4 });
  });

  it('returns undefined when neither the fd-walk nor the cwd resolves a rollout', async () => {
    process.env.CODEX_HOME = await codexHome();
    process.env.RAC_HOST_PROC = await fakeProc(321, []);
    await expect(codexRolloutBaseline({ pid: 321 })).resolves.toBeUndefined();
    await expect(codexRolloutBaseline({ pid: 321, cwd: '/home/ubuntu/cora' })).resolves.toBeUndefined();
    // a pinned rollout that no longer exists reads as undefined, not a throw
    await expect(codexTurnSince({ rollout: join(tmpdir(), 'rac-missing-rollout.jsonl'), ordinal: 0 })).resolves.toBeUndefined();
  });

  it('defers a reset baseline past the stale open rollout and resolves the post-reset thread', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    // the pane still holds the pre-reset rollout open, so a naive fd-walk would pin it
    const staleId = '0198d100-0000-7000-8000-0000000000a1';
    const staleFile = await writeRollout(home, staleId, turnRecords(1, 't0', 'Before reset', 'Stale answer.'), cwd, '2026-08-30T15:00:00.000Z');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [staleFile]);
    const resetAt = Date.parse('2026-08-30T15:30:00.000Z');

    // a reset instant defers to cwd + instant rather than pinning the stale open rollout
    const baseline = await codexRolloutBaseline({ pid: 321, cwd }, resetAt);
    expect(baseline).toEqual({ cwd, resetAt, ordinal: 0 });
    // no rollout newer than the reset exists yet: the post-reset turn stays pending
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'pending' });

    // Codex opens the new thread's rollout at its first turn; since now reads that file
    const freshId = '0198d100-0000-7000-8000-0000000000a2';
    await writeRollout(home, freshId, turnRecords(1, 't1', 'After reset', 'Fresh answer.'), cwd, '2026-08-30T16:00:00.000Z');
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'completed', ordinal: 4, answer: 'Fresh answer.' });
  });

  // follow the fresh post-reset conversation
  it('finds a prompt receipt when a deferred reset rollout appears', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const resetAt = Date.parse('2026-08-30T15:30:00.000Z');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, []);
    const baseline = await codexRolloutBaseline({ pid: 321, cwd }, resetAt);
    expect(baseline).toEqual({ cwd, resetAt, ordinal: 0 });
    await expect(codexPromptAccepted(baseline!, 'yes, fix it')).resolves.toBe(false);

    await writeRollout(home, '0198d100-0000-7000-8000-0000000000a4', [promptRecord(1, 'yes, fix it')], cwd, '2026-08-30T16:00:00.000Z');
    await expect(codexPromptAccepted(baseline!, 'yes, fix it')).resolves.toBe(true);
  });

  it('pins an already-open post-reset rollout after an external first turn', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const resetAt = Date.parse('2026-08-30T15:30:00.000Z');
    const freshId = '0198d100-0000-7000-8000-0000000000a3';
    // the external turn opened and completed the fresh rollout before console delivery
    const freshFile = await writeRollout(home, freshId, turnRecords(1, 'external', 'Typed locally', 'External answer.'), cwd, '2026-08-30T15:30:00.000Z');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [freshFile]);

    // pin after the external completion so it cannot satisfy the next managed prompt
    const baseline = await codexRolloutBaseline({ pid: 321, cwd }, resetAt);
    expect(baseline).toEqual({ rollout: freshFile, ordinal: 4 });
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'pending' });
  });

  it('follows one pane rollout replacement after an externally observed reset', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const staleFile = await writeRollout(home, '0198d100-0000-7000-8000-0000000000d1', turnRecords(1, 'old', 'Before reset', 'Old answer.'), cwd, '2026-08-30T14:00:00.000Z');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [staleFile]);

    // follow the pane identity because an external reset has no reliable reset timestamp
    const baseline = await codexRolloutBaseline({ pid: 321, cwd }, undefined, true);
    expect(baseline).toEqual({ rollout: staleFile, ordinal: 4, resetPane: { pid: 321, cwd } });
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'pending' });

    const observedResetAt = Date.parse('2026-08-30T15:30:00.000Z');
    const freshCreatedAt = '2026-08-30T15:00:00.000Z';
    // the replacement identity, not its older metadata timestamp, proves the reset
    expect(Date.parse(freshCreatedAt)).toBeLessThan(observedResetAt);
    const freshFile = await writeRollout(home, '0198d100-0000-7000-8000-0000000000d2', turnRecords(1, 'new', 'After reset', 'Fresh answer.'), cwd, freshCreatedAt);
    process.env.RAC_HOST_PROC = await fakeProc(321, [freshFile]);
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'completed', ordinal: 4, answer: 'Fresh answer.' });
    expect(baseline).toEqual({ rollout: freshFile, ordinal: 0 });

    // clear the follow marker after the first replacement so later panes cannot drift it
    const laterFile = await writeRollout(home, '0198d100-0000-7000-8000-0000000000d3', turnRecords(1, 'later', 'Later pane', 'Wrong answer.'), cwd, '2026-08-30T16:00:00.000Z');
    process.env.RAC_HOST_PROC = await fakeProc(321, [laterFile]);
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'completed', ordinal: 4, answer: 'Fresh answer.' });
  });

  it('keeps a normal resolved baseline pinned when the pane changes rollout', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const pinnedFile = await writeRollout(home, '0198d100-0000-7000-8000-0000000000e1', turnRecords(1, 'old', 'Before', 'Old answer.'), cwd, '2026-08-30T14:00:00.000Z');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [pinnedFile]);
    const baseline = await codexRolloutBaseline({ pid: 321, cwd });

    // ordinary turns never follow a later pane rollout
    const replacementFile = await writeRollout(home, '0198d100-0000-7000-8000-0000000000e2', turnRecords(1, 'new', 'After', 'Wrong answer.'), cwd, '2026-08-30T16:00:00.000Z');
    process.env.RAC_HOST_PROC = await fakeProc(321, [replacementFile]);
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'pending' });
    expect(baseline).toEqual({ rollout: pinnedFile, ordinal: 4 });
  });

  // isolate receipts from sibling conversations
  it('does not accept a matching receipt from a sibling rollout', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const pinnedFile = await writeRollout(home, '0198d100-0000-7000-8000-0000000000e3', turnRecords(1, 'old', 'Earlier', 'Earlier answer.'), cwd, '2026-08-30T14:00:00.000Z');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [pinnedFile]);
    const baseline = await codexRolloutBaseline({ pid: 321, cwd });

    const siblingFile = await writeRollout(home, '0198d100-0000-7000-8000-0000000000e4', [promptRecord(1, 'yes, fix it')], cwd, '2026-08-30T16:00:00.000Z');
    process.env.RAC_HOST_PROC = await fakeProc(321, [siblingFile]);
    await expect(codexPromptAccepted(baseline!, 'yes, fix it')).resolves.toBe(false);
    expect(baseline).toEqual({ rollout: pinnedFile, ordinal: 4 });
  });

  it('reads an aborted post-reset turn from a deferred baseline', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, []);
    const resetAt = Date.parse('2026-08-30T15:30:00.000Z');
    const baseline = await codexRolloutBaseline({ pid: 321, cwd }, resetAt);
    expect(baseline).toEqual({ cwd, resetAt, ordinal: 0 });

    const freshId = '0198d100-0000-7000-8000-0000000000b2';
    const aborted: Record[] = [
      { type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'After reset' }] } },
      { type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 't1', started_at: '2026-08-30T16:00:01.000Z' } },
      { type: 'event_msg', ordinal: 3, payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } }
    ];
    await writeRollout(home, freshId, aborted, cwd, '2026-08-30T16:00:00.000Z');
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'aborted', ordinal: 3 });
  });

  it('never resolves a deferred baseline to a rollout created before the reset', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    // a matching-cwd rollout that predates the reset is not the post-reset thread
    await writeRollout(home, '0198d100-0000-7000-8000-0000000000c1', turnRecords(1, 't0', 'Old', 'Old answer.'), cwd, '2026-08-30T15:00:00.000Z');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, []);
    const baseline = await codexRolloutBaseline({ pid: 321, cwd }, Date.parse('2026-08-30T15:30:00.000Z'));
    await expect(codexTurnSince(baseline!)).resolves.toEqual({ kind: 'pending' });
  });

  it('cannot defer a reset baseline without a pane working directory', async () => {
    process.env.CODEX_HOME = await codexHome();
    process.env.RAC_HOST_PROC = await fakeProc(321, []);
    // deferred resolution keys entirely on the cwd; without one the console falls back
    await expect(codexRolloutBaseline({ pid: 321 }, Date.parse('2026-08-30T15:30:00.000Z'))).resolves.toBeUndefined();
  });
});
