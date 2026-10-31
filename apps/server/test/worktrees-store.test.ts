import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeLaunchStore, scratchLaunchKey } from '../src/worktrees/store.js';

const dirs: string[] = [];
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'rac-worktrees-'));
  dirs.push(root);
  const file = join(root, 'worktrees.json');
  return { file, store: new WorktreeLaunchStore({ file }) };
}
// restore process defaults and remove isolated storage
afterEach(async () => {
  vi.unstubAllEnvs();
  // clean up each temporary store
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// a Worktree wire id keyed by `<projectId>:<realpath>`
const cora = 'proj:/worktrees/cora';

describe('WorktreeLaunchStore', () => {
  // use the persistent checkout rather than the packaged server's working directory
  it('defaults labels, pins and launch profiles to the server checkout', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-worktrees-checkout-'));
    dirs.push(checkout);
    const file = join(checkout, '.data/worktrees.json');
    await mkdir(join(checkout, '.data'));
    await writeFile(file, JSON.stringify({ [cora]: { label: 'Before', launchProfile: 'codex' } }));
    vi.stubEnv('RAC_SERVER_CHECKOUT', checkout);
    vi.stubEnv('RAC_WORKTREES_FILE', undefined);
    const worktrees = new WorktreeLaunchStore();
    // prove the read path before allowing any mutation
    expect(await worktrees.labels()).toEqual({ [cora]: 'Before' });
    await worktrees.setLabel(cora, 'After');
    await worktrees.setPinned(cora, false);
    expect(await new WorktreeLaunchStore().labels()).toEqual({ [cora]: 'After' });
    expect(await new WorktreeLaunchStore().pins()).toEqual({ [cora]: false });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [cora]: { label: 'After', launchProfile: 'codex', pinned: false } });
  });

  // explicit file options and environment overrides retain their existing precedence
  it('prefers an explicit file over the environment and the environment over the checkout', async () => {
    const { file: envFile } = await store();
    const { file: optionFile } = await store();
    vi.stubEnv('RAC_WORKTREES_FILE', envFile);
    vi.stubEnv('RAC_SERVER_CHECKOUT', '/unused-checkout');
    await new WorktreeLaunchStore().setLabel(cora, 'Environment');
    await new WorktreeLaunchStore({ file: optionFile }).setLabel(cora, 'Option');
    expect(JSON.parse(await readFile(envFile, 'utf8'))).toEqual({ [cora]: { label: 'Environment' } });
    expect(JSON.parse(await readFile(optionFile, 'utf8'))).toEqual({ [cora]: { label: 'Option' } });
  });

  it('remembers and reads a per-worktree launch profile by wire id, persisting atomically', async () => {
    const { file, store: worktrees } = await store();
    expect(await worktrees.launchProfile(cora)).toBeUndefined();
    await worktrees.rememberLaunchProfile(cora, 'codex');
    expect(await worktrees.launchProfile(cora)).toBe('codex');
    // the scratch group is keyed independently and survives reload
    await worktrees.rememberLaunchProfile(scratchLaunchKey, 'codex');
    expect(await new WorktreeLaunchStore({ file }).launchProfile(scratchLaunchKey)).toBe('codex');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [cora]: { launchProfile: 'codex' }, scratch: { launchProfile: 'codex' } });
  });

  it('reads every remembered profile in one snapshot for the dashboard', async () => {
    const { store: worktrees } = await store();
    expect(await worktrees.launchProfiles()).toEqual({});
    await worktrees.rememberLaunchProfile(cora, 'codex');
    await worktrees.rememberLaunchProfile(scratchLaunchKey, 'claude');
    // the snapshot maps each key to its kind, not to the stored record
    expect(await worktrees.launchProfiles()).toEqual({ [cora]: 'codex', scratch: 'claude' });
  });

  it('records and reads explicit pin overrides beside the launch profile', async () => {
    const { file, store: worktrees } = await store();
    expect(await worktrees.pins()).toEqual({});
    await worktrees.rememberLaunchProfile(cora, 'codex');
    await worktrees.setPinned(cora, false);
    await worktrees.setPinned('proj:/worktrees/dana', true);
    // only explicit overrides are stored; discovery applies the main-pinned default otherwise
    expect(await worktrees.pins()).toEqual({ [cora]: false, 'proj:/worktrees/dana': true });
    // pin and profile share one record for the Worktree
    expect(JSON.parse(await readFile(file, 'utf8'))[cora]).toEqual({ launchProfile: 'codex', pinned: false });
  });

  it('records, reads and clears a custom worktree label', async () => {
    const { file, store: worktrees } = await store();
    expect(await worktrees.labels()).toEqual({});
    await worktrees.rememberLaunchProfile(cora, 'codex');
    await worktrees.setLabel(cora, '🥔 Dave');
    // the custom label shares the Worktree record with its launch state
    expect(await worktrees.labels()).toEqual({ [cora]: '🥔 Dave' });
    expect(JSON.parse(await readFile(file, 'utf8'))[cora]).toEqual({ launchProfile: 'codex', label: '🥔 Dave' });
    await worktrees.setLabel(cora, undefined);
    expect(await worktrees.labels()).toEqual({});
    expect(JSON.parse(await readFile(file, 'utf8'))[cora]).toEqual({ launchProfile: 'codex' });
  });

  it('deletes an empty record when its custom label is cleared', async () => {
    const { store: worktrees } = await store();
    await worktrees.setLabel(cora, 'Dave');
    await worktrees.setLabel(cora, undefined);
    expect(await worktrees.keys()).toEqual([]);
  });

  it('ignores unsafe keys and unknown kinds instead of persisting them', async () => {
    const { file, store: worktrees } = await store();
    await worktrees.rememberLaunchProfile('has\nnewline', 'codex');
    await worktrees.setPinned('has\0nul', true);
    await worktrees.setLabel(cora, 'has\nnewline');
    await worktrees.rememberLaunchProfile(cora, 'bogus' as never);
    expect(await worktrees.launchProfile('has\nnewline')).toBeUndefined();
    expect(await worktrees.launchProfile(cora)).toBeUndefined();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists every stored key and deletes one record outright', async () => {
    const { store: worktrees } = await store();
    await worktrees.rememberLaunchProfile(cora, 'codex');
    await worktrees.setPinned('proj:/worktrees/dana', true);
    expect((await worktrees.keys()).sort()).toEqual([cora, 'proj:/worktrees/dana']);
    // Remove deletes the whole record — both the pin and the last-used kind go
    await worktrees.delete(cora);
    expect(await worktrees.keys()).toEqual(['proj:/worktrees/dana']);
    expect(await worktrees.launchProfile(cora)).toBeUndefined();
    // an unsafe key is a no-op, never a throw
    await worktrees.delete('has\nnewline');
    expect(await worktrees.keys()).toEqual(['proj:/worktrees/dana']);
  });

  it('records the Issue a Worktree was created for beside its other state, refusing anything but a positive integer', async () => {
    const { file, store: worktrees } = await store();
    await worktrees.setPinned(cora, true);
    for (const bad of [0, -3, 1.5, Number.NaN]) await worktrees.setIssue(cora, bad);
    await worktrees.setIssue('has\nnewline', 7);
    expect(await worktrees.issues()).toEqual({});
    await worktrees.setIssue(cora, 12);
    expect(await worktrees.issues()).toEqual({ [cora]: 12 });
    expect(JSON.parse(await readFile(file, 'utf8'))[cora]).toEqual({ pinned: true, issue: 12 });
  });

  it('rejects a structurally invalid storage file', async () => {
    const { file, store: worktrees } = await store();
    await writeFile(file, JSON.stringify({ [cora]: { launchProfile: 'nope' } }));
    await expect(worktrees.launchProfile(cora)).rejects.toThrow('invalid worktrees file');
    await writeFile(file, JSON.stringify({ [cora]: { issue: '12' } }));
    await expect(worktrees.issues()).rejects.toThrow('invalid worktrees file');
  });
});
