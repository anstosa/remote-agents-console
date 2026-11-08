import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { paneTimingLog, parsePaneTiming } from '../src/logs/pane-timing.js';

describe('pane timing frames', () => {
  it('keeps the known fields of a well-formed frame', () => {
    const frame = { type: 'timing', attempt: 'reconnect', sincePageLoad: 812.4, sharedSocket: 'new', renderer: 'webgl', browser: 'firefox', mobile: true, seedBytes: 5120, marks: { socket: 9.1, open: 40, viewport: 40.2, firstFrame: 61, seed: 70, parsed: 80, cover: 80.1, painted: 92 }, page: { responseEnd: 120, domContentLoaded: 300, session: 410, dashboard: 650 } };
    const { type: _type, ...expected } = frame;
    expect(parsePaneTiming(frame)).toEqual(expected);
  });

  it('drops unknown keys, invalid values and non-enum strings', () => {
    expect(parsePaneTiming({
      type: 'timing', attempt: 'injected\n{"x":1}', sharedSocket: 'reused', renderer: 'canvas', browser: '<script>', mobile: 'yes',
      sincePageLoad: -1, connectingSockets: 2, seedBytes: '10', extra: 'nope',
      marks: { open: 5, seed: Number.NaN, parsed: -3, painted: '9', evil: 2 },
      page: 'not-an-object'
    })).toEqual({ marks: { open: 5 } });
  });

  it('refuses a frame without a marks object', () => {
    expect(parsePaneTiming({ type: 'timing', attempt: 'initial' })).toBeUndefined();
    expect(parsePaneTiming({ type: 'timing', marks: null })).toBeUndefined();
  });
});

describe('pane timing log', () => {
  it('appends one JSON line per record', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'pane-timing-')), 'nested', 'pane-timing.jsonl');
    const append = paneTimingLog(file);
    void append({ n: 1 });
    await append({ n: 2 });
    expect((await readFile(file, 'utf8')).split('\n')).toEqual(['{"n":1}', '{"n":2}', '']);
  });

  it('rotates to .1 once the file passes the size limit, replacing an older rotation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pane-timing-'));
    const file = join(directory, 'pane-timing.jsonl');
    await writeFile(`${file}.1`, 'oldest\n');
    await writeFile(file, 'x'.repeat(100));
    const append = paneTimingLog(file, 64);
    await append({ n: 1 });
    expect(await readFile(`${file}.1`, 'utf8')).toBe('x'.repeat(100));
    expect(await readFile(file, 'utf8')).toBe('{"n":1}\n');
    await append({ n: 2 });
    expect((await stat(file)).size).toBe(16);
  });

  it('logs a failed write and keeps accepting records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pane-timing-'));
    // a directory where the file should be makes every append fail
    const append = paneTimingLog(directory);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(append({ n: 1 })).resolves.toBeUndefined();
    await expect(append({ n: 2 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
