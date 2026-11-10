import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPushDiagnosticsFile, PushDiagnostics, type PushDiagnosticRecord } from '../src/push-diagnostics.js';

const directories: string[] = [];

// create one strict browser-stage fixture
const record = (id: string, at: number, overrides: Partial<PushDiagnosticRecord> = {}): PushDiagnosticRecord => ({
  id,
  stage: 'worker_received',
  at,
  eventId: 'question-1',
  eventEpoch: '11111111-1111-4111-8111-111111111111',
  eventSequence: 1,
  kind: 'question',
  ...overrides
});

// remove isolated journals after every case
afterEach(async () => {
  // delete only directories created by this test file
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('PushDiagnostics', () => {
  // retain only exact allowlisted content-free receipt records
  it('rejects unknown, malformed, secret-bearing, and oversized receipt records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-push-diagnostics-'));
    directories.push(directory);
    const diagnostics = new PushDiagnostics({ file: join(directory, 'diagnostics.json'), now: () => 1_700_000_000_000 });
    const valid = record('receipt-1', 1_700_000_000_000);

    expect(await diagnostics.receive([valid])).toBe(true);
    expect(await diagnostics.receive([{ ...valid, id: 'receipt-2', endpoint: 'https://secret.example/path' }])).toBe(false);
    expect(await diagnostics.receive([{ ...valid, id: 'receipt-3', title: 'secret question' }])).toBe(false);
    expect(await diagnostics.receive([{ ...valid, id: 'receipt-4', status: 'x'.repeat(129) }])).toBe(false);
    expect(await diagnostics.receive(Array.from({ length: 101 }, (_, index) => record(`receipt-${index + 10}`, valid.at)))).toBe(false);
    expect(await diagnostics.receive({ records: [valid] })).toBe(false);
    expect(await diagnostics.snapshot()).toEqual([
      valid,
      expect.objectContaining({ stage: 'receipt_reported', eventId: valid.eventId, status: 'accepted' })
    ]);
    const serialized = await readFile(join(directory, 'diagnostics.json'), 'utf8');
    expect(serialized).not.toContain('https://secret.example/path');
    expect(serialized).not.toContain('secret question');
  });

  // enforce retention and insertion caps with one injected clock
  it('caps records by age and insertion order and writes mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-push-diagnostics-'));
    directories.push(directory);
    const file = join(directory, 'diagnostics.json');
    let now = 8_000;
    const diagnostics = new PushDiagnostics({ file, now: () => now, maximumRecords: 3, retentionMs: 1_000 });

    expect(await diagnostics.receive([record('old', 6_999), record('first', 7_100)])).toBe(true);
    now = 8_100;
    expect(await diagnostics.receive([record('second', 8_050)])).toBe(true);
    const snapshot = await diagnostics.snapshot();
    expect(snapshot).toHaveLength(3);
    expect(snapshot.map(entry => entry.id)).toContain('second');
    expect(snapshot.map(entry => entry.id)).not.toContain('old');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // serialize concurrent writes and recover after a failed atomic replacement
  it('preserves concurrent records and recovers after a write failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-push-diagnostics-'));
    directories.push(directory);
    const file = join(directory, 'diagnostics.json');
    const diagnostics = new PushDiagnostics({ file, now: () => 1_700_000_000_000 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await mkdir(`${file}.next`, { recursive: true });
    await expect(diagnostics.record('generated', { kind: 'question' })).rejects.toMatchObject({ code: 'EISDIR' });
    await rm(`${file}.next`, { recursive: true });
    await Promise.all([
      diagnostics.record('send_started', { kind: 'question', attempt: 1 }),
      diagnostics.record('provider_accepted', { kind: 'question', status: 'accepted' })
    ]);
    expect((await diagnostics.snapshot()).map(entry => entry.stage)).toEqual(['send_started', 'provider_accepted']);
    expect(error).toHaveBeenCalledWith('[push] diagnostic store failed', { code: 'EISDIR', operation: 'write' });
    expect(JSON.stringify(error.mock.calls)).not.toContain(directory);
  });

  // derive the private file beside the subscription store
  it('derives the default journal path beside subscriptions', () => {
    expect(defaultPushDiagnosticsFile('/var/lib/rac/private/subscriptions.json')).toBe('/var/lib/rac/private/push-diagnostics.json');
  });
});
