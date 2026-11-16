import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { files, readFile } = vi.hoisted(() => ({ files: new Map<string, string>(), readFile: vi.fn() }));
// count proc reads without mocking recognition or tree traversal
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), readFile }));
import { ProcInspector } from '../src/discovery/processes.js';

const proc = '/proc-fixture';
let now = 10_000;
// model the kernel stat layout including names containing spaces or parentheses
function processNode(pid: number, parentPid: number, comm: string, argv = [comm], children: number[] = [], startTime = '100'): void {
  const fields = ['S', String(parentPid), ...Array<string>(17).fill('0'), startTime];
  files.set(`${proc}/${pid}/stat`, `${pid} (${comm}) ${fields.join(' ')}\n`);
  files.set(`${proc}/${pid}/comm`, `${comm}\n`);
  files.set(`${proc}/${pid}/cmdline`, `${argv.join('\0')}\0`);
  files.set(`${proc}/${pid}/task/${pid}/children`, children.join(' '));
}
// opt in only for polling callers
const recognize = (inspector: ProcInspector, root = 100) => inspector.recognizeAgent(root, { reusePositive: true });
// inspect only child traversal reads
const childReads = () => readFile.mock.calls.filter(([path]) => String(path).endsWith('/children')).length;
// isolate proc state and the expiry clock
beforeEach(() => {
  now = 10_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('RAC_HOST_PROC', proc);
  files.clear();
  readFile.mockReset().mockImplementation(async (path: string) => {
    const value = files.get(path);
    // exited or inaccessible processes behave like missing proc files
    if (value === undefined) throw Object.assign(new Error('missing proc file'), { code: 'ENOENT' });
    return value;
  });
  processNode(100, 1, 'bash', ['bash'], [101]);
  processNode(101, 100, 'codex');
});
// restore global environment and clock
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('established agent recognition', () => {
  // the common shallow case must not pay more proc reads across an expiry window
  it.each([false, true])('avoids read overhead for shallow trees with direct agent %s', async direct => {
    // direct agents need no descendant cache at all
    if (direct) processNode(100, 1, 'codex');
    const inspector = new ProcInspector();
    // measure four dashboard ticks at the unchanged 500 ms cadence
    for (let tick = 0; tick < 4; tick += 1) {
      await recognize(inspector);
      now += 500;
    }
    const pollingReads = readFile.mock.calls.length;
    readFile.mockClear();
    // compare with the same four original uncached scans
    for (let tick = 0; tick < 4; tick += 1) await inspector.recognizeAgent(100);
    expect(pollingReads).toBeLessThanOrEqual(readFile.mock.calls.length);
  });

  // a wide tree makes the avoided work observable at the filesystem boundary
  it('validates only the established lineage rather than walking unrelated descendants', async () => {
    const siblings = Array.from({ length: 200 }, (_, index) => 200 + index);
    processNode(100, 1, 'bash', ['bash'], [101, ...siblings]);
    // visit non-agent siblings before the winning agent in stack order
    for (const pid of siblings) processNode(pid, 100, 'sleep');
    const inspector = new ProcInspector();
    expect(await recognize(inspector)).toEqual({ kind: 'codex', pid: 101, startTime: '100', wrapped: false });
    expect(childReads()).toBe(201);
    readFile.mockClear();
    expect(await recognize(inspector)).toEqual({ kind: 'codex', pid: 101, startTime: '100', wrapped: false });
    expect(childReads()).toBe(0);
    expect(readFile.mock.calls.length).toBeLessThanOrEqual(6);
    expect(readFile.mock.calls.every(([path]) => /^\/proc-fixture\/10[01]\//u.test(String(path)))).toBe(true);
  });

  // deep lineages must not fan out every proc read at once
  it('bounds in-flight reads while validating an established lineage', async () => {
    processNode(101, 100, 'sh', ['sh'], [102]);
    processNode(102, 101, 'bwrap', ['bwrap'], [103]);
    processNode(103, 102, 'codex');
    const inspector = new ProcInspector();
    await recognize(inspector);
    const read = readFile.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    // measure concurrent filesystem operations without exposing inspector internals
    readFile.mockImplementation(async (path: string) => {
      active += 1;
      peak = Math.max(peak, active);
      try { return await read(path); }
      finally { active -= 1; }
    });
    expect(await recognize(inspector)).toEqual({ kind: 'codex', pid: 103, startTime: '100', wrapped: true });
    expect(peak).toBeLessThanOrEqual(2);
  });

  // hits must not postpone a full scan indefinitely
  it('rescans competing descendants after a fixed two-second expiry', async () => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    processNode(100, 1, 'bash', ['bash'], [101, 102]);
    processNode(102, 100, 'claude');
    now += 1_999;
    expect((await recognize(inspector))?.pid).toBe(101);
    now += 1;
    expect(await recognize(inspector)).toEqual({ kind: 'claude', pid: 102, startTime: '100', wrapped: false });
  });

  // slow validation cannot extend the permitted off-path staleness
  it('rescans when the expiry passes during lineage validation', async () => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    let release!: (value: string) => void;
    const stat = files.get(`${proc}/100/stat`)!;
    readFile.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = recognize(inspector);
    processNode(100, 1, 'bash', ['bash'], [101, 102]);
    processNode(102, 100, 'claude');
    now += 2_000;
    release(stat);
    expect((await pending)?.pid).toBe(102);
  });

  // destructive callers retain the original fresh-by-default behavior
  it('bypasses and invalidates cached recognition for default fresh callers', async () => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    processNode(100, 1, 'bash', ['bash'], [101, 102]);
    processNode(102, 100, 'claude');
    expect((await inspector.recognizeAgent(100))?.pid).toBe(102);
    expect((await recognize(inspector))?.pid).toBe(102);
  });

  // a lifetime change invalidates even otherwise identical command metadata
  it.each([100, 101])('rescans when cached pid %i is reused', async pid => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    const stat = files.get(`${proc}/${pid}/stat`)!;
    files.set(`${proc}/${pid}/stat`, stat.replace(/100\n$/u, '200\n'));
    processNode(100, 1, 'bash', ['bash'], [101, 102], pid === 100 ? '200' : '100');
    processNode(102, 100, 'claude');
    expect((await recognize(inspector))?.pid).toBe(102);
  });

  // exec can change argv without changing pid, starttime or comm
  it('recognizes an agent-kind change in an unchanged node launcher', async () => {
    processNode(101, 100, 'MainThread', ['node', '/usr/bin/codex']);
    const inspector = new ProcInspector();
    await recognize(inspector);
    processNode(101, 100, 'MainThread', ['node', '/opt/@anthropic-ai/claude-code/cli.js']);
    expect(await recognize(inspector)).toEqual({ kind: 'claude', pid: 101, startTime: '100', wrapped: false });
  });

  // an ancestor becoming OMX takes precedence over its surviving Codex child
  it('rescans ancestor exec and wrapper changes', async () => {
    processNode(100, 1, 'bwrap', ['bwrap'], [101]);
    const inspector = new ProcInspector();
    expect((await recognize(inspector))?.wrapped).toBe(true);
    processNode(100, 1, 'bash', ['bash'], [101]);
    expect((await recognize(inspector))?.wrapped).toBe(false);
    processNode(100, 1, 'MainThread', ['node', '/usr/bin/omx', '--direct'], [101]);
    expect(await recognize(inspector)).toEqual({ kind: 'omx', pid: 100, startTime: '100', wrapped: false });
  });

  // the same process must still belong to this pane
  it('does not retain a reparented agent', async () => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    processNode(101, 1, 'codex');
    processNode(100, 1, 'bash');
    expect(await recognize(inspector)).toBeUndefined();
  });

  // exited processes cannot survive solely through a positive cache entry
  it('discovers a replacement immediately after the established process exits', async () => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    // remove all files for the exited agent
    for (const path of files.keys()) {
      // leave the pane and replacement files untouched
      if (path.startsWith(`${proc}/101/`)) files.delete(path);
    }
    processNode(100, 1, 'bash', ['bash'], [102]);
    processNode(102, 100, 'claude');
    expect((await recognize(inspector))?.pid).toBe(102);
  });

  // non-agent results must not hide a newly launched process
  it('does not cache negative recognition', async () => {
    processNode(101, 100, 'sleep');
    const inspector = new ProcInspector();
    expect(await recognize(inspector)).toBeUndefined();
    processNode(101, 100, 'codex');
    expect((await recognize(inspector))?.kind).toBe('codex');
  });

  // a surviving process can stop being an agent without exiting
  it('drops a cached agent after exec into an unrelated program', async () => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    processNode(101, 100, 'sleep');
    expect(await recognize(inspector)).toBeUndefined();
  });

  // restricted proc mounts can recognize agents without proving reusable identity
  it.each(['missing', 'malformed'])('falls back to uncached recognition with %s stat', async mode => {
    const inspector = new ProcInspector();
    // retain command recognition even when stat is unavailable
    if (mode === 'missing') files.delete(`${proc}/101/stat`);
    else files.set(`${proc}/101/stat`, 'invalid');
    expect((await recognize(inspector))?.pid).toBe(101);
    readFile.mockClear();
    expect((await recognize(inspector))?.pid).toBe(101);
    expect(childReads()).toBe(1);
  });

  // parser delimiters must not confuse a legal comm with stat fields
  it('reuses a lineage containing a parenthesized process name', async () => {
    processNode(100, 1, 'shell (worker)', ['bash'], [101]);
    const inspector = new ProcInspector();
    await recognize(inspector);
    readFile.mockClear();
    expect((await recognize(inspector))?.pid).toBe(101);
    expect(childReads()).toBe(0);
  });

  // overlapping polling consumers share one tree walk
  it('coalesces concurrent ordinary recognition', async () => {
    const inspector = new ProcInspector();
    expect(await Promise.all([recognize(inspector), recognize(inspector), recognize(inspector)]))
      .toEqual(Array(3).fill({ kind: 'codex', pid: 101, startTime: '100', wrapped: false }));
    expect(childReads()).toBe(1);
  });

  // a slow earlier poll cannot reinstate recognition invalidated by a fresh caller
  it('bypasses in-flight polling and prevents its late cache publication', async () => {
    const inspector = new ProcInspector();
    let release!: (value: string) => void;
    readFile.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = recognize(inspector);
    await expect(inspector.recognizeAgent(100)).resolves.toMatchObject({ pid: 101 });
    release('bash\n');
    await pending;
    processNode(100, 1, 'bash', ['bash'], [101, 102]);
    processNode(102, 100, 'claude');
    expect((await recognize(inspector))?.pid).toBe(102);
  });

  // bound retention even when many short-lived panes appear within the expiry window
  it('evicts old roots once the bounded cache is full', async () => {
    const inspector = new ProcInspector();
    await recognize(inspector);
    // overflow the 512-root limit without advancing the clock
    for (let pid = 1_000; pid < 2_024; pid += 2) {
      processNode(pid, 1, 'bash', ['bash'], [pid + 1]);
      processNode(pid + 1, pid, 'codex');
      await recognize(inspector, pid);
    }
    processNode(100, 1, 'bash', ['bash'], [101, 102]);
    processNode(102, 100, 'claude');
    expect((await recognize(inspector))?.pid).toBe(102);
  });
});
