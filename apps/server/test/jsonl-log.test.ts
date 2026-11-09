import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { jsonlLog } from '../src/logs/jsonl-log.js';

describe('jsonl log', () => {
  it('appends one JSON line per record', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'jsonl-log-')), 'nested', 'log.jsonl');
    const append = jsonlLog(file);
    void append({ n: 1 });
    await append({ n: 2 });
    expect((await readFile(file, 'utf8')).split('\n')).toEqual(['{"n":1}', '{"n":2}', '']);
  });

  it('rotates to .1 once the file passes the size limit, replacing an older rotation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-log-'));
    const file = join(directory, 'log.jsonl');
    await writeFile(`${file}.1`, 'oldest\n');
    await writeFile(file, 'x'.repeat(100));
    const append = jsonlLog(file, 64);
    await append({ n: 1 });
    expect(await readFile(`${file}.1`, 'utf8')).toBe('x'.repeat(100));
    expect(await readFile(file, 'utf8')).toBe('{"n":1}\n');
    await append({ n: 2 });
    expect((await stat(file)).size).toBe(16);
  });

  it('logs a failed write and keeps accepting records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-log-'));
    // a directory where the file should be makes every append fail
    const append = jsonlLog(directory);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(append({ n: 1 })).resolves.toBeUndefined();
    await expect(append({ n: 2 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
