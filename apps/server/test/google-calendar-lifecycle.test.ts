import { chmod, mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarAdmission, CalendarSignal } from '../src/google-calendar/contracts.js';
import { GoogleCalendarLifecycle } from '../src/google-calendar/lifecycle.js';
import { tempDir } from './helpers/codex-fixtures.js';

describe('Google Calendar managed lifecycle', () => {
  // every successful snapshot must remain readable across restart
  it.each([
    ['x'.repeat(90), 'x'.repeat(80)],
    ['😀'.repeat(90), '😀'.repeat(80)],
    ['  Main\u0000\nbranch  ', 'Main  branch']
  ])('normalizes display labels before admission and start persistence %#', async (raw, expected) => {
    const file = join(await tempDir('rac-calendar-label-restore-'), 'lifecycle.json');
    const admit = vi.fn(async () => true);
    const signals: CalendarSignal[] = [];
    const labels = { worktree: raw, project: raw, agent: 'private generated title' };
    const options = { file, sink: { admit, signal: async (signal: CalendarSignal) => { signals.push(signal); } }, labels: async () => labels };
    const admission = { id: 'labels', agentId: 'agent', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' };
    const first = new GoogleCalendarLifecycle(options);
    await first.admit(admission);
    expect(admit).toHaveBeenCalledWith({ ...admission, labels: { worktree: expected, project: expected, agent: 'Codex' } });
    const restarted = new GoogleCalendarLifecycle(options);
    await restarted.beforeSend({ ...admission, prompt: 'work', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    await restarted.observe('labels', { version: 1, compatible: () => true, inspect: async () => ({ state: 'pending', source: 'codex-rollout', parserVersion: 1, receiptOrdinal: 2, startOrdinal: 3, turnId: 'turn', startedAt: '2026-10-23T17:00:02.000Z' }) });
    expect(signals.find(signal => signal.type === 'started')?.labels).toEqual({ worktree: expected, project: expected, agent: 'Codex' });
    await expect(new GoogleCalendarLifecycle(options).pending()).resolves.toEqual([{ id: 'labels', agentId: 'agent', kind: 'codex' }]);
  });

  // contaminated native times must not poison a valid sibling's durable document
  it.each(['not a time', '1970-01-01T00:00:00.000Z', ' '.repeat(65) + '2026-10-23'])('rejects an invalid producer timestamp %# before publication', async startedAt => {
    const file = join(await tempDir('rac-calendar-time-restore-'), 'lifecycle.json');
    const signals: CalendarSignal[] = [];
    const options = { file, sink: { admit: async () => true, signal: async (signal: CalendarSignal) => { signals.push(signal); } }, labels: async () => ({ worktree: 'Main', agent: 'Codex' }) };
    const lifecycle = new GoogleCalendarLifecycle(options);
    // preserve a separate exact pending activity while rejecting contaminated evidence
    for (const id of ['valid', 'invalid']) {
      const admission = { id, agentId: id, kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' };
      await lifecycle.admit(admission);
      await lifecycle.beforeSend({ ...admission, prompt: 'work', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    }
    await lifecycle.observe('invalid', { version: 1, compatible: () => true, inspect: async () => ({ state: 'pending', source: 'codex-rollout', parserVersion: 1, receiptOrdinal: 2, startOrdinal: 3, turnId: 'turn', startedAt }) });
    expect(signals).toEqual([{ id: 'invalid', type: 'invalid', reason: 'missing_lifecycle_evidence' }]);
    await expect(new GoogleCalendarLifecycle(options).pending()).resolves.toEqual([{ id: 'valid', agentId: 'valid', kind: 'codex' }]);
  });

  // reject valid-json corruption before any provider or native-evidence work
  it.each([
    { prompt: 'private prompt content' },
    { baseline: { rollout: '/private/rollout.jsonl', ordinal: -1 } },
    { id: 'x'.repeat(257) },
    { submittedAt: 'not a timestamp' },
    { source: 'claude-hook', kind: 'codex' },
    { processId: 'not a process' },
    { promptFingerprint: 'not a hash' },
    { nonce: 'a'.repeat(24) },
    { baseline: { rollout: '/private/rollout.jsonl', cwd: '/private', ordinal: 0 } },
    { labels: { worktree: 'Cora', agent: 'Codex', response: 'private response' } },
    { duplicate: true }
  ])('rejects contaminated lifecycle records %# without inspecting evidence', async corruption => {
    const file = join(await tempDir('rac-calendar-lifecycle-'), 'lifecycle.json');
    const row = { id: 'tampered', agentId: 'agent', kind: 'codex', submittedAt: new Date().toISOString(), labels: { worktree: 'Cora', agent: 'Codex' }, admitted: true, sentAt: new Date().toISOString(), source: 'codex-rollout', parserVersion: 1, promptFingerprint: 'a'.repeat(64), transportFingerprint: 'b'.repeat(64), processGeneration: 'c'.repeat(64), baseline: { rollout: '/private/rollout.jsonl', ordinal: 0 }, socketPath: '/missing/socket', paneId: '%7' };
    const records = 'duplicate' in corruption ? [row, row] : [{ ...row, ...corruption }];
    await writeFile(file, JSON.stringify({ version: 1, records }), { mode: 0o600 });
    const sink = { admit: vi.fn(async () => true), signal: vi.fn(async () => undefined) };
    const inspect = vi.fn(async () => ({ state: 'pending' as const, source: 'codex-rollout' as const, parserVersion: 1 as const }));
    const lifecycle = new GoogleCalendarLifecycle({ file, sink, labels: async () => row.labels });
    expect(await lifecycle.pending()).toEqual([]);
    await lifecycle.observe(row.id, { version: 1, compatible: () => true, inspect });
    expect(inspect).not.toHaveBeenCalled();
    expect(sink.admit).not.toHaveBeenCalled();
    expect(sink.signal).not.toHaveBeenCalled();
  });
  // resolve the current test process generation through the production stat shape
  async function currentProcess() {
    const raw = await readFile(`/proc/${process.pid}/stat`, 'utf8');
    return { pid: process.pid, start: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]! };
  }

  // opt dormant helper tests into a synthetic contract without enabling production
  const claudeCompatibility = () => ({ cliVersion: 'synthetic-test', payloadContract: 'synthetic-test-v1' });

  it('persists sanitized intent before emitting exact short-turn evidence', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    const admissions: CalendarAdmission[] = [];
    const signals: CalendarSignal[] = [];
    const lifecycle = new GoogleCalendarLifecycle({
      file,
      sink: {
        // retain the provider snapshot before correlation begins
        admit: async admission => { admissions.push(admission); return true; },
        signal: async signal => { signals.push(signal); }
      },
      labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' })
    });
    await lifecycle.admit({ id: 'activity-1', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' });
    await lifecycle.beforeSend({ id: 'activity-1', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'secret prompt', baseline: { rollout: '/private/rollout.jsonl', ordinal: 7 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', processId: 42, sentAt: '2026-10-23T17:00:01.000Z' });
    const inspect = vi.fn(async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 8, startOrdinal: 9, terminalOrdinal: 10, turnId: 'turn-1', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:00:03.000Z' }));
    await lifecycle.observe('activity-1', { version: 1, compatible: () => true, inspect });

    expect(admissions).toHaveLength(1);
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started', 'finished']);
    expect(await stat(file).then(value => value.mode & 0o777)).toBe(0o600);
    const stored = await readFile(file, 'utf8');
    expect(stored).not.toContain('secret prompt');
    expect(JSON.parse(stored).records).toEqual([]);
    expect(inspect).toHaveBeenCalledOnce();
  });

  // accept exact native evidence when Codex records start before prompt receipt
  it('emits one exact short-turn interval for start-before-receipt evidence', async () => {
    const directory = await tempDir('rac-calendar-reversed-short-');
    const file = join(directory, 'lifecycle.json');
    const signals: CalendarSignal[] = [];
    const lifecycle = new GoogleCalendarLifecycle({
      file,
      sink: {
        // admit the synthetic activity
        admit: async () => true,
        // record each acknowledged boundary
        signal: async signal => { signals.push(signal); }
      },
      // return stable public labels
      labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' })
    });
    const admission = { id: 'reversed-short', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' };
    await lifecycle.admit(admission);
    await lifecycle.beforeSend({ ...admission, prompt: 'short turn', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    // expose a fully correlated reversed-order turn
    const inspect = vi.fn(async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 3, startOrdinal: 2, terminalOrdinal: 4, turnId: 'reversed-turn', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:00:03.000Z' }));
    await lifecycle.observe(admission.id, { version: 1, compatible: () => true, inspect });

    expect(signals).toEqual([
      { id: admission.id, type: 'sent', at: '2026-10-23T17:00:01.000Z' },
      { id: admission.id, type: 'started', at: '2026-10-23T17:00:02.000Z', labels: { worktree: 'Cora', project: 'RAC', agent: 'Codex' } },
      { id: admission.id, type: 'finished', at: '2026-10-23T17:00:03.000Z' }
    ]);
    expect(inspect).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual([]);
  });

  // reject non-strict native checkpoints regardless of event order
  it.each([
    { receiptOrdinal: 2, startOrdinal: 2, terminalOrdinal: 3 },
    { receiptOrdinal: 3, startOrdinal: 2, terminalOrdinal: 3 },
    { receiptOrdinal: 2, startOrdinal: 3, terminalOrdinal: 3 }
  ])('rejects overlapping native checkpoint ordinals %#', async evidence => {
    const directory = await tempDir('rac-calendar-overlapping-');
    const signals: CalendarSignal[] = [];
    const lifecycle = new GoogleCalendarLifecycle({
      file: join(directory, 'lifecycle.json'),
      sink: {
        // admit the synthetic activity
        admit: async () => true,
        // record terminal rejection
        signal: async signal => { signals.push(signal); }
      },
      // return stable public labels
      labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' })
    });
    const admission = { id: 'overlapping-checkpoints', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' };
    await lifecycle.admit(admission);
    await lifecycle.beforeSend({ ...admission, prompt: 'invalid turn', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    // return the selected overlapping checkpoint combination
    const inspect = async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, ...evidence, turnId: 'overlapping-turn', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:00:03.000Z' });
    await lifecycle.observe(admission.id, { version: 1, compatible: () => true, inspect });

    expect(signals).toEqual([{ id: admission.id, type: 'invalid', reason: 'missing_lifecycle_evidence' }]);
    await expect(lifecycle.pending()).resolves.toEqual([]);
  });

  it('reports unsupported evidence without blocking admission', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const signals: CalendarSignal[] = [];
    const lifecycle = new GoogleCalendarLifecycle({
      file: join(directory, 'lifecycle.json'),
      sink: { admit: async () => true, signal: async signal => { signals.push(signal); } },
      labels: async () => ({ worktree: 'Scratch', project: 'Scratch', agent: 'Claude' })
    });
    await lifecycle.admit({ id: 'activity-2', agentId: 'agent-2', kind: 'claude', submittedAt: '2026-10-23T17:00:00.000Z' });
    await lifecycle.beforeSend({ id: 'activity-2', agentId: 'agent-2', kind: 'claude', submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'do it', socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%2', sentAt: '2026-10-23T17:00:01.000Z' });
    expect(signals).toEqual([{ id: 'activity-2', type: 'invalid', reason: 'unsupported_lifecycle_contract' }]);
  });

  it('retries a rejected durable signal after a fresh collector restart', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    let rejectStart = true;
    const signals: CalendarSignal[] = [];
    const sink = {
      admit: async () => true,
      signal: async (signal: CalendarSignal) => {
        signals.push(signal);
        if (signal.type === 'started' && rejectStart) { rejectStart = false; throw new Error('disk unavailable'); }
      }
    };
    const options = { file, sink, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) };
    const first = new GoogleCalendarLifecycle(options);
    await first.admit({ id: 'activity-retry', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' });
    await first.beforeSend({ id: 'activity-retry', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'retry me', baseline: { rollout: '/private/rollout.jsonl', ordinal: 7 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    const inspect = vi.fn(async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 8, startOrdinal: 9, terminalOrdinal: 10, turnId: 'turn-retry', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:00:03.000Z' }));
    await first.observe('activity-retry', { version: 1, compatible: () => true, inspect });
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started']);

    const restarted = new GoogleCalendarLifecycle(options);
    await expect(restarted.pending()).resolves.toEqual([{ id: 'activity-retry', agentId: 'agent-1', kind: 'codex' }]);
    await restarted.observe('activity-retry', { version: 1, compatible: () => true, inspect });
    expect(inspect).toHaveBeenCalledOnce();
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started', 'started', 'finished']);
    await expect(restarted.pending()).resolves.toEqual([]);
  });

  it('does not mark terminal until the durable finished signal is acknowledged', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    let rejectFinish = true;
    const signals: CalendarSignal[] = [];
    const sink = { admit: async () => true, signal: async (signal: CalendarSignal) => { signals.push(signal); if (signal.type === 'finished' && rejectFinish) { rejectFinish = false; throw new Error('disk unavailable'); } } };
    const options = { file, sink, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) };
    const first = new GoogleCalendarLifecycle(options);
    await first.admit({ id: 'activity-terminal-retry', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' });
    await first.beforeSend({ id: 'activity-terminal-retry', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'finish me', baseline: { rollout: '/private/rollout.jsonl', ordinal: 7 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    const inspect = async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 8, startOrdinal: 9, terminalOrdinal: 10, turnId: 'turn-finish', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:00:03.000Z' });
    await first.observe('activity-terminal-retry', { version: 1, compatible: () => true, inspect });
    await expect(first.pending()).resolves.toEqual([{ id: 'activity-terminal-retry', agentId: 'agent-1', kind: 'codex' }]);

    const restarted = new GoogleCalendarLifecycle(options);
    await restarted.observe('activity-terminal-retry', { version: 1, compatible: () => true, inspect });
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started', 'finished', 'finished']);
    await expect(restarted.pending()).resolves.toEqual([]);
  });

  it('retries rejected invalid evidence without terminalizing the correlation', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    let rejectInvalid = true;
    const signals: CalendarSignal[] = [];
    const sink = { admit: async () => true, signal: async (signal: CalendarSignal) => { signals.push(signal); if (signal.type === 'invalid' && rejectInvalid) { rejectInvalid = false; throw new Error('disk unavailable'); } } };
    const options = { file, sink, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) };
    const first = new GoogleCalendarLifecycle(options);
    await first.admit({ id: 'invalid-retry', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' });
    await first.beforeSend({ id: 'invalid-retry', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'invalid', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    const unsupported = { version: 1 as const, compatible: () => false, inspect: async () => ({ state: 'pending' as const, source: 'codex-rollout' as const, parserVersion: 1 as const }) };
    await first.observe('invalid-retry', unsupported);
    await expect(first.pending()).resolves.toEqual([{ id: 'invalid-retry', agentId: 'agent-1', kind: 'codex' }]);

    const restarted = new GoogleCalendarLifecycle(options);
    await restarted.observe('invalid-retry', unsupported);
    expect(signals).toEqual([
      { id: 'invalid-retry', type: 'invalid', reason: 'unsupported_lifecycle_contract' },
      { id: 'invalid-retry', type: 'invalid', reason: 'unsupported_lifecycle_contract' }
    ]);
    await expect(restarted.pending()).resolves.toEqual([]);
  });

  // restore reversed native checkpoints before scanning a long turn terminal
  it('rehydrates exact receipt and start checkpoint for a long turn terminal scan', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    const signals: CalendarSignal[] = [];
    const options = { file, sink: { admit: async () => true, signal: async (signal: CalendarSignal) => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) };
    const first = new GoogleCalendarLifecycle(options);
    await first.admit({ id: 'long-activity', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z' });
    await first.beforeSend({ id: 'long-activity', agentId: 'agent-1', kind: 'codex', submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'long turn', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    await first.observe('long-activity', { version: 1, compatible: () => true, inspect: async () => ({ state: 'pending', source: 'codex-rollout', parserVersion: 1, receiptOrdinal: 3, startOrdinal: 2, turnId: 'long-turn', startedAt: '2026-10-23T17:00:02.000Z' }) });

    const terminalInspect = vi.fn(async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 3, startOrdinal: 2, terminalOrdinal: 500, turnId: 'long-turn', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:30:00.000Z' }));
    const restarted = new GoogleCalendarLifecycle(options);
    await restarted.observe('long-activity', { version: 1, compatible: () => true, inspect: terminalInspect });

    expect(terminalInspect.mock.calls[0]?.[2]).toEqual({ receiptOrdinal: 3, startOrdinal: 2, turnId: 'long-turn', startedAt: '2026-10-23T17:00:02.000Z' });
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started', 'finished']);
  });

  it.each([['codex', 'omx'], ['omx', 'codex']])('keeps one activity across queued %s to %s handover and refreshes start labels', async (fromKind, toKind) => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const signals: CalendarSignal[] = [];
    const lifecycle = new GoogleCalendarLifecycle({
      file: join(directory, 'lifecycle.json'),
      sink: { admit: async () => true, signal: async signal => { signals.push(signal); } },
      labels: async agentId => agentId === 'old-agent' ? { worktree: 'Old', project: 'RAC', agent: fromKind.toUpperCase() } : { worktree: 'New', project: 'RAC', agent: toKind.toUpperCase() }
    });
    await lifecycle.admit({ id: 'handover-activity', agentId: 'old-agent', kind: fromKind, submittedAt: '2026-10-23T17:00:00.000Z' });
    await lifecycle.handOver('old-agent', 'new-agent');
    await lifecycle.beforeSend({ id: 'handover-activity', agentId: 'new-agent', kind: toKind, submittedAt: '2026-10-23T17:00:00.000Z', prompt: 'handover', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: '2026-10-23T17:00:01.000Z' });
    const inspect = async () => ({ state: 'finished' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 2, startOrdinal: 3, terminalOrdinal: 4, turnId: 'turn-handover', startedAt: '2026-10-23T17:00:02.000Z', finishedAt: '2026-10-23T17:00:03.000Z' });
    await lifecycle.observe('handover-activity', { version: 1, compatible: () => true, inspect });
    expect(signals.find(signal => signal.type === 'started')?.labels).toEqual({ worktree: 'New', project: 'RAC', agent: toKind === 'codex' ? 'Codex' : 'OMX' });
    expect(signals.filter(signal => signal.type === 'finished')).toHaveLength(1);
  });

  it('fails closed when a Claude terminal clears its arm but cannot publish terminal journal evidence', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    const signals: CalendarSignal[] = [];
    let now = new Date();
    const lifecycle = new GoogleCalendarLifecycle({ file, now: () => now, claudeCompatibility, sink: { admit: async () => true, signal: async signal => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Claude' }) });
    await lifecycle.admit({ id: 'claude-journal-failure', agentId: 'agent-1', kind: 'claude', submittedAt: new Date().toISOString() });
    const intent = await lifecycle.beforeSend({ id: 'claude-journal-failure', agentId: 'agent-1', kind: 'claude', submittedAt: new Date().toISOString(), prompt: 'managed', socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%7', processId: process.pid, sentAt: new Date().toISOString() });
    const armed = JSON.parse(Buffer.from(intent.arm!, 'base64url').toString('utf8'));
    const journal = Buffer.from(JSON.stringify({ ...armed, state: 'active', startedAt: new Date().toISOString() })).toString('base64url');
    const tmux = join(directory, 'tmux');
    await writeFile(tmux, `#!/bin/sh\ncase "$*" in *'@rac_calendar_journal'*) printf '%s\\n' '${journal}' ;; *'@rac_calendar_arm'*) exit 1 ;; esac\n`, { mode: 0o755 });
    const previous = process.env.RAC_TMUX_BIN;
    process.env.RAC_TMUX_BIN = tmux;
    try {
      await lifecycle.observe('claude-journal-failure', undefined);
      expect(signals).toEqual([]);
      now = new Date(now.getTime() + 10 * 60_000);
      await lifecycle.observe('claude-journal-failure', undefined);
    } finally { if (previous === undefined) delete process.env.RAC_TMUX_BIN; else process.env.RAC_TMUX_BIN = previous; }
    expect(signals.at(-1)).toEqual({ id: 'claude-journal-failure', type: 'invalid', reason: 'missing_lifecycle_evidence' });
  });

  // malformed pane bytes must age out exactly like a stale journal
  it.each([
    { name: 'stale', payload: undefined },
    { name: 'null', payload: 'null' },
    { name: 'array', payload: '[]' },
    { name: 'malformed', payload: '{' }
  ])('bounds a $name Claude journal after the exact armed window expires', async ({ payload }) => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const signals: CalendarSignal[] = [];
    let now = new Date('2026-10-23T17:00:00.000Z');
    const lifecycle = new GoogleCalendarLifecycle({ file: join(directory, 'lifecycle.json'), now: () => now, claudeCompatibility, sink: { admit: async () => true, signal: async signal => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Claude' }) });
    await lifecycle.admit({ id: 'stale-journal', agentId: 'agent-1', kind: 'claude', submittedAt: now.toISOString() });
    const intent = await lifecycle.beforeSend({ id: 'stale-journal', agentId: 'agent-1', kind: 'claude', submittedAt: now.toISOString(), prompt: 'managed', socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%8', processId: process.pid, sentAt: now.toISOString() });
    const arm = intent.arm!;
    const stale = Buffer.from(payload ?? JSON.stringify({ activityId: 'old-activity', nonce: 'old-nonce', processGeneration: 'old-generation', state: 'active', startedAt: now.toISOString() })).toString('base64url');
    const tmux = join(directory, 'tmux-stale');
    await writeFile(tmux, `#!/bin/sh\ncase "$*" in *'@rac_calendar_journal'*) printf '%s\\n' '${stale}' ;; *'@rac_calendar_arm'*) printf '%s\\n' '${arm}' ;; esac\n`, { mode: 0o755 });
    const previous = process.env.RAC_TMUX_BIN;
    process.env.RAC_TMUX_BIN = tmux;
    try {
      await lifecycle.observe('stale-journal', undefined);
      now = new Date(now.getTime() + 31_000);
      await lifecycle.observe('stale-journal', undefined);
      expect(signals).toEqual([]);
      now = new Date(now.getTime() + 10 * 60_000);
      await lifecycle.observe('stale-journal', undefined);
    } finally { if (previous === undefined) delete process.env.RAC_TMUX_BIN; else process.env.RAC_TMUX_BIN = previous; }
    expect(signals).toEqual([{ id: 'stale-journal', type: 'invalid', reason: 'missing_lifecycle_evidence' }]);
  });

  it('bounds an absent old Codex owner before reporting missing evidence', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const signals: CalendarSignal[] = [];
    let now = new Date('2026-10-23T17:00:00.000Z');
    const lifecycle = new GoogleCalendarLifecycle({ file: join(directory, 'lifecycle.json'), now: () => now, sink: { admit: async () => true, signal: async signal => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) });
    await lifecycle.admit({ id: 'absent-codex', agentId: 'old-agent', kind: 'codex', submittedAt: now.toISOString() });
    await lifecycle.beforeSend({ id: 'absent-codex', agentId: 'old-agent', kind: 'codex', submittedAt: now.toISOString(), prompt: 'old turn', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: now.toISOString() });
    await lifecycle.missing('absent-codex');
    expect(signals).toEqual([]);
    now = new Date(now.getTime() + 10 * 60_000);
    await lifecycle.missing('absent-codex');
    expect(signals).toEqual([{ id: 'absent-codex', type: 'invalid', reason: 'missing_lifecycle_evidence' }]);
    await expect(lifecycle.pending()).resolves.toEqual([]);
  });

  // retain exact native evidence until the provider acknowledges its start
  it('retries durable start acknowledgement without losing native evidence', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const processGeneration = await currentProcess();
    const signals: CalendarSignal[] = [];
    let rejectStart = true;
    const lifecycle = new GoogleCalendarLifecycle({
      file: join(directory, 'lifecycle.json'),
      sink: { admit: async () => true, signal: async signal => { signals.push(signal); if (signal.type === 'started' && rejectStart) throw new Error('start unavailable'); } },
      labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' })
    });
    await lifecycle.admit({ id: 'deferred-question', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString() });
    await lifecycle.beforeSend({ id: 'deferred-question', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString(), prompt: 'ask later', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', processId: processGeneration.pid, sentAt: new Date().toISOString() });
    const capability = { version: 1 as const, compatible: () => true, inspect: async () => ({ state: 'pending' as const, source: 'codex-rollout' as const, parserVersion: 1 as const, receiptOrdinal: 2, startOrdinal: 3, turnId: 'deferred-turn', startedAt: new Date().toISOString() }) };
    await lifecycle.observe('deferred-question', capability);
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started']);
    rejectStart = false;
    await lifecycle.observe('deferred-question', capability);
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started', 'started']);
  });

  it('compensates provider admission and pre-key store failures without blocking', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const admissionFile = join(directory, 'admission-store');
    const signals: CalendarSignal[] = [];
    const admission = new GoogleCalendarLifecycle({
      file: admissionFile,
      sink: { admit: async () => { await mkdir(admissionFile); return true; }, signal: async signal => { signals.push(signal); } },
      labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' })
    });
    await expect(admission.admit({ id: 'admit-failure', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString() })).resolves.toBeUndefined();
    expect(signals).toContainEqual({ id: 'admit-failure', type: 'invalid', reason: 'capture_store_unavailable' });

    const malformed = join(directory, 'malformed.json');
    await writeFile(malformed, '{', { mode: 0o600 });
    const preKey = new GoogleCalendarLifecycle({ file: malformed, sink: { admit: async () => true, signal: async signal => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) });
    await preKey.beforeSend({ id: 'pre-key-failure', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString(), prompt: 'continue', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: new Date().toISOString() });
    expect(signals).toContainEqual({ id: 'pre-key-failure', type: 'invalid', reason: 'capture_store_unavailable' });

    const persistFile = join(directory, 'persist-failure.json');
    const persistFailure = new GoogleCalendarLifecycle({ file: persistFile, sink: { admit: async () => true, signal: async signal => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) });
    await persistFailure.admit({ id: 'pre-key-persist-failure', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString() });
    await persistFailure.pending();
    await rm(persistFile);
    await mkdir(persistFile);
    await persistFailure.beforeSend({ id: 'pre-key-persist-failure', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString(), prompt: 'continue', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', sentAt: new Date().toISOString() });
    expect(signals).toContainEqual({ id: 'pre-key-persist-failure', type: 'invalid', reason: 'capture_store_unavailable' });
  });

  // reject unsafe documents before allocating their bytes or admitting provider work
  it.each(['oversized', 'public'])('declines %s lifecycle storage before provider admission', async kind => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    await writeFile(file, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
    // make public permissions explicit regardless of the host umask
    if (kind === 'public') await chmod(file, 0o644);
    // use a sparse file to exercise the stat bound without a large allocation
    if (kind === 'oversized') await truncate(file, 33 * 1024 * 1024);
    const admit = vi.fn(async () => true);
    const lifecycle = new GoogleCalendarLifecycle({ file, sink: { admit, signal: async () => undefined }, labels: async () => ({ worktree: 'Cora', agent: 'Codex' }) });
    await expect(lifecycle.admit({ id: 'unsafe-store', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString() })).resolves.toBeUndefined();
    expect(admit).not.toHaveBeenCalled();
    expect(await lifecycle.pending()).toEqual([]);
  });

  it('clears Codex absence aging when exact live inspection resumes', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const processGeneration = await currentProcess();
    const signals: CalendarSignal[] = [];
    let now = new Date('2026-10-23T17:00:00.000Z');
    const lifecycle = new GoogleCalendarLifecycle({ file: join(directory, 'lifecycle.json'), now: () => now, sink: { admit: async () => true, signal: async signal => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) });
    await lifecycle.admit({ id: 'resumed-codex', agentId: 'agent-1', kind: 'codex', submittedAt: now.toISOString() });
    await lifecycle.beforeSend({ id: 'resumed-codex', agentId: 'agent-1', kind: 'codex', submittedAt: now.toISOString(), prompt: 'resume', baseline: { rollout: '/private/rollout.jsonl', ordinal: 1 }, socketFingerprint: 'socket', socketPath: '/tmp/socket', paneId: '%1', processId: processGeneration.pid, sentAt: now.toISOString() });
    await lifecycle.missing('resumed-codex');
    const capability = { version: 1 as const, compatible: () => true, inspect: async () => ({ state: 'pending' as const, source: 'codex-rollout' as const, parserVersion: 1 as const }) };
    await lifecycle.observe('resumed-codex', capability);
    now = new Date(now.getTime() + 10 * 60_000);
    await lifecycle.missing('resumed-codex');
    expect(signals).toEqual([]);
    now = new Date(now.getTime() + 10 * 60_000);
    await lifecycle.missing('resumed-codex');
    expect(signals).toEqual([{ id: 'resumed-codex', type: 'invalid', reason: 'missing_lifecycle_evidence' }]);
  });

  it('recovers an exact Claude terminal from the durable spool after pane loss', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    const spool = join(directory, 'claude.jsonl');
    const signals: CalendarSignal[] = [];
    const lifecycle = new GoogleCalendarLifecycle({ file, claudeSpoolFile: spool, claudeCompatibility, sink: { admit: async () => true, signal: async signal => { signals.push(signal); } }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Claude' }) });
    await lifecycle.admit({ id: 'spooled-terminal', agentId: 'agent-1', kind: 'claude', submittedAt: new Date().toISOString() });
    const intent = await lifecycle.beforeSend({ id: 'spooled-terminal', agentId: 'agent-1', kind: 'claude', submittedAt: new Date().toISOString(), prompt: 'managed', socketFingerprint: 'socket', socketPath: '/missing/socket', paneId: '%7', processId: process.pid, sentAt: new Date().toISOString() });
    const arm = JSON.parse(Buffer.from(intent.arm!, 'base64url').toString('utf8'));
    await writeFile(spool, `${JSON.stringify({ ...arm, state: 'terminal', startedAt: '2026-10-23T17:00:01.000Z', firstQuestionAt: '2026-10-23T17:00:01.500Z', finishedAt: '2026-10-23T17:00:02.000Z', recordedAt: '2026-10-23T17:00:02.000Z' })}\n`, { mode: 0o600 });
    await lifecycle.observe('spooled-terminal', undefined);
    expect(signals.map(signal => signal.type)).toEqual(['sent', 'started', 'question', 'finished']);
    await expect(lifecycle.pending()).resolves.toEqual([]);
    expect(await readFile(spool, 'utf8')).toBe('');
  });

  // avoid creating lifecycle storage for provider-suppressed admissions
  it('keeps suppressed admissions out of lifecycle storage', async () => {
    const directory = await tempDir('rac-calendar-lifecycle-');
    const file = join(directory, 'lifecycle.json');
    const lifecycle = new GoogleCalendarLifecycle({ file, sink: { admit: async () => false, signal: async () => undefined }, labels: async () => ({ worktree: 'Cora', project: 'RAC', agent: 'Codex' }) });
    await lifecycle.admit({ id: 'suppressed', agentId: 'agent-1', kind: 'codex', submittedAt: new Date().toISOString() });
    await expect(lifecycle.pending()).resolves.toEqual([]);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
