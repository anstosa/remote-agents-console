import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenedFolderStore } from '../src/places/opened-folders.js';
import { run } from '../src/tmux/command.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function folders(...names: string[]): Promise<{ file: string; paths: string[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-opened-')));
  dirs.push(root);
  const paths = names.map(name => join(root, name));
  for (const path of paths) await mkdir(path);
  return { file: join(root, 'data', 'opened-folders.json'), paths };
}

describe('the opened-folders store', () => {
  it('lists folders newest first, once each, and keeps them across a restart', async () => {
    const { file, paths: [a, b] } = await folders('a', 'b');
    const store = new OpenedFolderStore(file);
    await store.record(a!, 1);
    await store.record(b!, 2);
    await store.record(a!, 3);

    expect(await new OpenedFolderStore(file).list()).toEqual([{ path: a, openedAt: 3, kind: 'folder' }, { path: b, openedAt: 2, kind: 'folder' }]);
  });

  it('keeps the 50 newest', async () => {
    const names = Array.from({ length: 52 }, (_, index) => `f${index}`);
    const { file, paths } = await folders(...names);
    const store = new OpenedFolderStore(file);
    for (const [index, path] of paths.entries()) await store.record(path, index);

    const listed = await store.list();

    expect(listed).toHaveLength(50);
    expect(listed[0]?.path).toBe(paths[51]);
    expect(listed.at(-1)?.path).toBe(paths[2]);
  });

  it('forgets one folder', async () => {
    const { file, paths: [a, b] } = await folders('a', 'b');
    const store = new OpenedFolderStore(file);
    await store.record(a!, 1);
    await store.record(b!, 2);

    await store.forget(a!);

    expect((await store.list()).map(entry => entry.path)).toEqual([b]);
  });

  it('leaves out a folder that no longer exists without deleting its entry', async () => {
    const { file, paths: [a, b] } = await folders('a', 'b');
    const store = new OpenedFolderStore(file);
    await store.record(a!, 1);
    await store.record(b!, 2);
    await rm(b!, { recursive: true });

    expect((await store.list()).map(entry => entry.path)).toEqual([a]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(2);
  });

  it('marks a folder in a git checkout as git', async () => {
    const { file, paths: [repo] } = await folders('repo');
    await run('/usr/bin/git', ['-C', repo!, 'init', '-q']);
    const store = new OpenedFolderStore(file);
    await store.record(repo!, 1);

    expect(await store.list()).toEqual([{ path: repo, openedAt: 1, kind: 'git' }]);
  });
});
