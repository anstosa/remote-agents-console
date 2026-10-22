import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFileContext, hostVisibleRepoRoot, renderAdapterFiles } from '../../src/adapters/files.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function filesDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'rac-files-')); dirs.push(dir); return dir; }

describe('adapter file rendering', () => {
  it('renders each kind into <filesDir>/<kind>/<name> at 0644 with host paths handed back', async () => {
    const dir = await filesDir();
    const rendered = await renderAdapterFiles({ RAC_ADAPTER_FILES_DIR: dir, RAC_HOST_REPOSITORY: '/srv/remoteagents', RAC_TMUX_BIN: '/usr/bin/tmux' } as NodeJS.ProcessEnv);
    const hooksPath = rendered.claude?.['hooks.json'];
    expect(hooksPath).toBe(join(dir, 'claude', 'hooks.json'));
    const info = await stat(hooksPath!);
    expect(info.mode & 0o777).toBe(0o644);
    const content = await readFile(hooksPath!, 'utf8');
    expect(content).toContain('/srv/remoteagents/scripts/hooks/rac-attention working');
    expect(content).toContain('RAC_TMUX_BIN=/usr/bin/tmux');
    // Codex declares no files
    expect(rendered.codex).toBeUndefined();
  });

  // repair both content and permissions left by an earlier boot
  it('rewrites the file every boot, restoring content and permissions that drifted', async () => {
    const dir = await filesDir();
    const env = { RAC_ADAPTER_FILES_DIR: dir, RAC_HOST_REPOSITORY: '/srv/remoteagents' } as NodeJS.ProcessEnv;
    const first = (await renderAdapterFiles(env)).claude!['hooks.json']!;
    const golden = await readFile(first, 'utf8');
    // a stale/edited file from a previous boot is overwritten, not left in place
    await writeFile(first, 'CORRUPT');
    await chmod(first, 0o600);
    await renderAdapterFiles(env);
    expect(await readFile(first, 'utf8')).toBe(golden);
    expect((await stat(first)).mode & 0o777).toBe(0o644);
  });

  // preserve host-readable adapter files even with a private process default
  it('renders files at 0644 under a restrictive umask', async () => {
    const dir = await filesDir();
    const previousMask = process.umask(0o077);
    try {
      const rendered = await renderAdapterFiles({ RAC_ADAPTER_FILES_DIR: dir, RAC_HOST_REPOSITORY: '/srv/remoteagents' });
      expect((await stat(rendered.claude!['hooks.json']!)).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previousMask);
    }
  });

  it('names paths against RAC_HOST_REPOSITORY and drops the tmux prefix under the bridge', () => {
    const bridged = adapterFileContext({ RAC_HOST_TMUX_DIR: '/host/tmux', RAC_HOST_REPOSITORY: '/host/checkout' } as NodeJS.ProcessEnv);
    expect(bridged?.context).toEqual({ repoRoot: '/host/checkout' });
    expect(bridged?.filesDir).toBe('/host/checkout/.data/adapters');
  });

  it('has no host-visible root — and renders nothing — under a bridge without RAC_HOST_REPOSITORY', async () => {
    const env = { RAC_HOST_TMUX_DIR: '/host/tmux' } as NodeJS.ProcessEnv;
    expect(hostVisibleRepoRoot(env)).toBeUndefined();
    expect(adapterFileContext(env)).toBeUndefined();
    expect(await renderAdapterFiles(env)).toEqual({});
  });

  it('off the bridge falls back to the console checkout and the local tmux', () => {
    const resolved = adapterFileContext({} as NodeJS.ProcessEnv);
    expect(resolved?.context.repoRoot).toMatch(/remoteagents$/);
    expect(resolved?.context.tmuxBin).toBe('/usr/bin/tmux');
  });
});
