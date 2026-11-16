import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostHolderRuntime } from '../src/adapters/host-runtime.js';

const roots: string[] = [];

// remove only generic runtime fixtures
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// provision matching local and host module closures
async function runtime(files: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), 'rac-host-runtime-'));
  roots.push(root);
  const modules = join(root, 'local');
  const host = join(root, 'apps/server/dist');
  // mirror every requested helper byte for byte
  for (const name of ['transports/holder.js', ...files]) {
    for (const base of [modules, host]) {
      await mkdir(dirname(join(base, name)), { recursive: true });
      await writeFile(join(base, name), `// ${name}\n`);
    }
  }
  return { root, modules, host, env: { RAC_HOST_TMUX_DIR: '/host-tmux', RAC_HOST_NODE_BIN: '/host/node', RAC_HOST_REPOSITORY: root } };
}

describe('the generic host holder runtime', () => {
  it('requires no Pi state or packages and returns only verified host paths', async () => {
    const fixture = await runtime(['reply-suggestions/native-worker.js']);

    expect(hostHolderRuntime(fixture.env, { modules: fixture.modules }, ['reply-suggestions/native-worker.js'])).toEqual({
      node: '/host/node', holder: join(fixture.host, 'transports/holder.js'), modules: fixture.host, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });

  it('rejects a stale additional helper and a path outside the module closure', async () => {
    const fixture = await runtime(['reply-suggestions/native-worker.js']);
    await writeFile(join(fixture.host, 'reply-suggestions/native-worker.js'), '// stale\n');

    expect(() => hostHolderRuntime(fixture.env, { modules: fixture.modules }, ['reply-suggestions/native-worker.js'])).toThrow(/build mismatch/u);
    expect(() => hostHolderRuntime(fixture.env, { modules: fixture.modules }, ['../secret'])).toThrow(/module-relative/u);
  });
});
