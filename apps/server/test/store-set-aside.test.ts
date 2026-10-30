import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatches } from '../src/conductor/dispatches.js';
import { StructuredAgents } from '../src/transports/structured-agents.js';
import { Watches } from '../src/watches/service.js';

// A store the console cannot parse starts empty, but its file is kept aside rather than replaced
// by the next write, so what it held can still be recovered by hand.

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function corrupt(name: string): Promise<{ dir: string; file: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rac-set-aside-')));
  dirs.push(dir);
  const file = join(dir, name);
  await writeFile(file, '[{"id": "half-writ');
  return { dir, file };
}
const asideOf = async (dir: string, name: string) => (await readdir(dir)).filter(entry => entry.startsWith(`${name}.corrupt-`));

describe('a store file that does not parse', () => {
  it.each([
    ['Watches', 'watches.json', async (file: string) => {
      const watches = new Watches({ file, events: { on: () => undefined } } as never);
      expect(await watches.list('agent-1')).toEqual([]);
    }],
    ['dispatches', 'dispatches.json', async (file: string) => {
      const dispatches = new Dispatches({ file, submit: async () => undefined, queued: async () => [], history: async () => [], inFlight: () => undefined, notify: () => undefined });
      await dispatches.queued('agent-1', 'prompt-1', { from: 'conductor-1' });
    }],
    ['structured Agents', 'structured-agents.json', async (file: string) => {
      const agents = new StructuredAgents({} as never, { file });
      expect(await agents.agents()).toEqual([]);
    }]
  ])('is kept aside for %s, and says so', async (_store, name, use) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { dir, file } = await corrupt(name);
    await use(file);
    const aside = await asideOf(dir, name);
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, aside[0]!), 'utf8')).toBe('[{"id": "half-writ');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(aside[0]!));
  });
});
