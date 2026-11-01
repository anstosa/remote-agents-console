import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostPiRuntime, verifyHostPiNode } from '../src/adapters/pi-runtime.js';

const roots: string[] = [];
// remove only fixtures this suite created
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

// provision matching host and console runtimes without installing packages
async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'rac-pi-runtime-'));
  roots.push(root);
  const modules = join(root, 'console');
  const host = join(root, 'apps/server/dist');
  // mirror the helper import closure as compiled bytes
  for (const name of ['adapters/pi-extension.js', 'adapters/pi-sandbox.js', 'git/overrides.js', 'transports/holder.js', 'watches/sandboxed-command.js']) {
    for (const base of [modules, host]) { await mkdir(dirname(join(base, name)), { recursive: true }); await writeFile(join(base, name), `// ${name}\n`); }
  }
  const packageRoot = (name: string) => join(root, 'apps/server/node_modules', name);
  // use real package metadata but no executable package code
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-codemode', '@anthropic-ai/sandbox-runtime']) {
    await mkdir(packageRoot(name), { recursive: true });
    await writeFile(join(packageRoot(name), 'package.json'), JSON.stringify({ version: '1.2.3' }));
  }
  const env = { RAC_HOST_TMUX_DIR: '/mounted-tmux', RAC_HOST_NODE_BIN: '/host/bin/node', RAC_HOST_REPOSITORY: root, PI_CODING_AGENT_DIR: join(root, '.data/pi-agent') };
  return { root, env, sources: { modules, packageRoot } };
}

describe('the pinned Pi host runtime', () => {
  it('checks Node on the exact host tmux socket', async () => {
    const command = vi.fn(async () => ({ code: 0, stdout: '24.16.0\n', stderr: '' }));
    await verifyHostPiNode('/host/bin/node', { RAC_TMUX_BIN: '/bridge/tmux', RAC_HOST_TMUX_DIR: '/host-tmux' }, command);
    expect(command).toHaveBeenCalledWith('/bridge/tmux', ['-S', '/host-tmux/default', 'run-shell', expect.stringContaining("exec '/host/bin/node'")], undefined, 5_000);
  });
  it.each(['22.18.0', '20.19.0', '', 'node: permission denied'])('rejects an unavailable or incompatible host Node: %s', async stdout => {
    await expect(verifyHostPiNode('/host/node', { RAC_HOST_TMUX_DIR: '/host' }, async () => ({ code: 0, stdout, stderr: '' }))).rejects.toThrow(/Node.js >=22.19.0/u);
  });
  it('leaves native launches unchanged without probing a host installation', () => { expect(hostPiRuntime({})).toBeUndefined(); });
  it('requires explicit absolute host Node, checkout and shared state paths', () => {
    expect(() => hostPiRuntime({ RAC_HOST_TMUX_DIR: '/host' })).toThrow(/absolute/u);
    expect(() => hostPiRuntime({ RAC_HOST_TMUX_DIR: '/host', RAC_HOST_NODE_BIN: 'node', RAC_HOST_REPOSITORY: '/repo', PI_CODING_AGENT_DIR: '/state' })).toThrow(/absolute/u);
  });
  it('returns only host paths when the helper closure and dependency pins match', async () => {
    const { root, env, sources } = await runtime();
    expect(hostPiRuntime(env, sources)).toEqual({ node: '/host/bin/node', cli: join(root, 'apps/server/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), extension: join(root, 'apps/server/dist/adapters/pi-extension.js'), holder: join(root, 'apps/server/dist/transports/holder.js'), command: join(root, 'apps/server/dist/watches/sandboxed-command.js') });
  });
  it('rejects a stale helper even when package versions still match', async () => {
    const { root, env, sources } = await runtime();
    await writeFile(join(root, 'apps/server/dist/adapters/pi-sandbox.js'), '// stale\n');
    expect(() => hostPiRuntime(env, sources)).toThrow(/build mismatch/u);
  });
  it('rejects an absent build', async () => {
    const { root, env, sources } = await runtime();
    await rm(join(root, 'apps/server/dist/transports/holder.js'));
    expect(() => hostPiRuntime(env, sources)).toThrow(/build mismatch/u);
  });
  it('rejects differing dependency pins without accepting a matching helper', async () => {
    const { root, env, sources } = await runtime();
    const local = join(root, 'local-package');
    await mkdir(local);
    await writeFile(join(local, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(() => hostPiRuntime(env, { ...sources, packageRoot: () => local })).toThrow(/dependency mismatch/u);
    expect(JSON.parse(await readFile(join(sources.packageRoot('@earendil-works/pi-coding-agent'), 'package.json'), 'utf8')).version).toBe('1.2.3');
  });
});
