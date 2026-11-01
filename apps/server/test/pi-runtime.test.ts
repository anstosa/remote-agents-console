import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostPiRuntime, verifyHostPiNode } from '../src/adapters/pi-runtime.js';
import { run } from '../src/tmux/command.js';

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
  // exact home roots use the host Pi account before any executable can run
  it('refuses Node below an exact home write root before executing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-node-home-'));
    roots.push(root);
    const home = join(root, 'home');
    const node = join(home, 'bin/node');
    const marker = join(root, 'executed');
    await mkdir(dirname(node), { recursive: true });
    await writeFile(node, `#!/bin/sh\nprintf ran > '${marker}'\nprintf "24.16.0\\n"\n`);
    await chmod(node, 0o700);
    const command: typeof run = async (_binary, args) => await run('/bin/sh', ['-c', args.at(-1)!]);

    await expect(verifyHostPiNode(node, { RAC_HOST_TMUX_DIR: '/host', HOME: home }, command, ['~'])).rejects.toThrow(/writable/u);
    await expect(verifyHostPiNode(node, { RAC_HOST_TMUX_DIR: '/host', HOME: home }, command, ['~/bin'])).rejects.toThrow(/writable/u);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['~', '~/place'])('requires explicit HOME for the %s writable root', async writeRoot => {
    const command = vi.fn<typeof run>();

    await expect(verifyHostPiNode('/host/node', { RAC_HOST_TMUX_DIR: '/host' }, command, [writeRoot])).rejects.toThrow(/HOME/u);
    expect(command).not.toHaveBeenCalled();
  });

  // global and pattern roots fail closed before trusted Node execution
  it('rejects global and glob writable roots without executing Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-node-global-'));
    roots.push(root);
    const node = join(root, 'node');
    const marker = join(root, 'executed');
    await writeFile(node, `#!/bin/sh\nprintf ran > '${marker}'\nprintf "24.16.0\\n"\n`);
    await chmod(node, 0o700);
    const command: typeof run = async (_binary, args) => await run('/bin/sh', ['-c', args.at(-1)!]);

    await expect(verifyHostPiNode(node, { RAC_HOST_TMUX_DIR: '/host' }, command, ['/'])).rejects.toThrow(/writable/u);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const unused = vi.fn<typeof run>();
    await expect(verifyHostPiNode(node, { RAC_HOST_TMUX_DIR: '/host' }, unused, ['/tmp/*'])).rejects.toThrow(/non-glob/u);
    expect(unused).not.toHaveBeenCalled();
  });

  // execute only the trusted host inspection script in a disposable local namespace
  it('refuses a pre-existing hard-link alias before executing Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-node-links-'));
    roots.push(root);
    const node = join(root, 'node');
    await writeFile(node, '#!/bin/sh\nprintf "24.16.0\\n"\n');
    await chmod(node, 0o700);
    await link(node, join(root, 'writable-alias'));
    const command: typeof run = async (_binary, args) => await run('/bin/sh', ['-c', args.at(-1)!]);

    await expect(verifyHostPiNode(node, { RAC_HOST_TMUX_DIR: '/host' }, command)).rejects.toThrow(/single-link/u);
  });

  // a benign-looking executable link must not point into any writable Place
  it('rejects a canonical Node target inside a writable root and fingerprints a safe target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-node-roots-'));
    roots.push(root);
    const writable = join(root, 'place');
    await mkdir(writable);
    const node = join(writable, 'node');
    const alias = join(root, 'node-link');
    await writeFile(node, '#!/bin/sh\nprintf "24.16.0\\n"\n');
    await chmod(node, 0o700);
    await symlink(node, alias);
    const command: typeof run = async (_binary, args) => await run('/bin/sh', ['-c', args.at(-1)!]);

    await expect(verifyHostPiNode(alias, { RAC_HOST_TMUX_DIR: '/host' }, command, [writable])).rejects.toThrow(/writable/u);
    await expect(verifyHostPiNode(alias, { RAC_HOST_TMUX_DIR: '/host' }, command, [join(root, 'another-place')])).resolves.toMatch(/^[a-f0-9]{64}$/u);
  });

  it('checks Node on the exact host tmux socket', async () => {
    const command = vi.fn(async () => ({ code: 0, stdout: `/host/bin/node\n${'a'.repeat(64)}\n24.16.0\n`, stderr: '' }));
    await verifyHostPiNode('/host/bin/node', { RAC_TMUX_BIN: '/bridge/tmux', RAC_HOST_TMUX_DIR: '/host-tmux' }, command);
    expect(command).toHaveBeenCalledWith('/bridge/tmux', ['-S', '/host-tmux/default', 'run-shell', expect.stringContaining("readlink -e -- '/host/bin/node'")], undefined, 5_000);
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
    expect(hostPiRuntime(env, sources)).toEqual({ node: '/host/bin/node', cli: join(root, 'apps/server/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), extension: join(root, 'apps/server/dist/adapters/pi-extension.js'), holder: join(root, 'apps/server/dist/transports/holder.js'), command: join(root, 'apps/server/dist/watches/sandboxed-command.js'), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
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
