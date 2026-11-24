import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { maxAgentUpdateOutputBytes } from '../src/agent-updates/diagnostics.js';
import { runConfiguredAgentProbe } from '../src/agent-updates/probes.js';
import { agentUpdateDirectory, InvalidAgentUpdateArtifact, readPrivateAgentArtifact } from '../src/agent-updates/storage.js';
import { tempDir } from './helpers/codex-fixtures.js';

const execFileAsync = promisify(execFile);

// build one native probe location
async function nativeLocation(prefix: string) {
  const checkout = await tempDir(prefix);
  const home = await tempDir(`${prefix}home-`);
  return { checkout, home, tmuxBinary: '/usr/bin/tmux', path: '/usr/local/bin:/usr/bin:/bin' };
}

// create one detached bridge client around the real host supervisor shell
async function fakeTmuxClient(checkout: string): Promise<string> {
  const path = join(checkout, 'fake-tmux');
  await writeFile(path, `#!/bin/bash
if [ "$3" != 'new-session' ]; then exit 1; fi
(cd -- "$8" && exec /bin/bash -lc "\${11}") </dev/null >/dev/null 2>&1 &
exit 0
`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

describe('agent update private storage', () => {
  it('creates each private component and supports absent optional lookup', async () => {
    const checkout = await tempDir('rac-agent-update-storage-');
    await expect(agentUpdateDirectory(checkout, { create: false })).resolves.toBeUndefined();
    await expect(stat(join(checkout, '.data'))).rejects.toMatchObject({ code: 'ENOENT' });

    const updates = await agentUpdateDirectory(checkout);
    const jobs = await agentUpdateDirectory(checkout, { jobs: true });

    expect(updates).toBe(join(checkout, '.data', 'agent-updates'));
    expect(jobs).toBe(join(updates!, 'jobs'));
    expect((await stat(join(checkout, '.data'))).mode & 0o777).toBe(0o700);
    expect((await stat(updates!)).mode & 0o777).toBe(0o700);
    expect((await stat(jobs!)).mode & 0o777).toBe(0o700);
  });

  it('accepts a read-only public data root but rejects writable roots before descendant creation', async () => {
    const accepted = await tempDir('rac-agent-update-storage-root-');
    await mkdir(join(accepted, '.data'), { mode: 0o755 });
    await chmod(join(accepted, '.data'), 0o755);
    await expect(agentUpdateDirectory(accepted)).resolves.toBe(join(accepted, '.data', 'agent-updates'));

    const rejected = await tempDir('rac-agent-update-storage-exposed-');
    await mkdir(join(rejected, '.data'), { mode: 0o775 });
    await chmod(join(rejected, '.data'), 0o775);
    await expect(agentUpdateDirectory(rejected)).rejects.toThrow(/private agent update directory/u);
    await expect(stat(join(rejected, '.data', 'agent-updates'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects linked and exposed update directories', async () => {
    const linked = await tempDir('rac-agent-update-storage-link-');
    const target = await tempDir('rac-agent-update-storage-target-');
    await mkdir(join(linked, '.data'));
    await symlink(target, join(linked, '.data', 'agent-updates'));
    await expect(agentUpdateDirectory(linked)).rejects.toThrow(/private agent update directory/u);
    await expect(readdir(target)).resolves.toEqual([]);

    const exposed = await tempDir('rac-agent-update-storage-mode-');
    const updates = join(exposed, '.data', 'agent-updates');
    await mkdir(updates, { recursive: true, mode: 0o700 });
    await chmod(updates, 0o750);
    await expect(agentUpdateDirectory(exposed)).rejects.toThrow(/private agent update directory/u);
  });

  it('reads bounded private files and rejects links, special files and oversized artifacts', async () => {
    const checkout = await tempDir('rac-agent-update-storage-artifact-');
    const directory = await agentUpdateDirectory(checkout);
    const artifact = join(directory!, 'probe.out');
    await writeFile(artifact, 'prefix-private-tail', { mode: 0o600 });
    await chmod(artifact, 0o600);

    await expect(readPrivateAgentArtifact(artifact, 7, true)).resolves.toEqual(Buffer.from('te-tail'));
    await expect(readPrivateAgentArtifact(artifact, 7)).rejects.toBeInstanceOf(InvalidAgentUpdateArtifact);

    const link = join(directory!, 'probe.link');
    await symlink(artifact, link);
    await expect(readPrivateAgentArtifact(link, 100)).rejects.toBeInstanceOf(InvalidAgentUpdateArtifact);

    const fifo = join(directory!, 'probe.fifo');
    await execFileAsync('/usr/bin/mkfifo', [fifo]);
    await chmod(fifo, 0o600);
    await expect(readPrivateAgentArtifact(fifo, 100)).rejects.toBeInstanceOf(InvalidAgentUpdateArtifact);
  });
});

describe('configured agent probes', () => {
  it('preserves the configured native account environment', async () => {
    const location = await nativeLocation('rac-agent-update-probe-env-');
    const result = await runConfiguredAgentProbe(location, `printf '%s|%s' "$HOME" "$PATH"`, 2_000);

    expect(result).toEqual({ code: 0, output: `${location.home}|${location.path}` });
  });

  it('keeps native stdout version evidence ahead of earlier stderr warnings', async () => {
    const location = await nativeLocation('rac-agent-update-probe-streams-');
    const result = await runConfiguredAgentProbe(location, `printf 'warning\\n' >&2; printf '1.2.3\\n'`, 2_000);

    expect(result).toEqual({ code: 0, output: '1.2.3\nwarning\n' });
  });

  it('times out a command whose descendant keeps its output pipe open', async () => {
    const location = await nativeLocation('rac-agent-update-probe-pipe-');
    const startedAt = Date.now();
    const result = await runConfiguredAgentProbe(location, '/bin/sleep 5 & printf done', 100);

    expect(result).toEqual({ code: -1, output: 'done', failure: 'timed_out' });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it('bounds native runtime and output', async () => {
    const location = await nativeLocation('rac-agent-update-probe-bounds-');
    const timedOut = await runConfiguredAgentProbe(location, '/bin/sleep 5', 100);
    const bounded = await runConfiguredAgentProbe(location, `/usr/bin/head -c ${maxAgentUpdateOutputBytes + 1000} /dev/zero | /usr/bin/tr '\\0' x`, 2_000);

    expect(timedOut).toMatchObject({ code: -1, failure: 'timed_out' });
    expect(Buffer.byteLength(bounded.output)).toBe(maxAgentUpdateOutputBytes);
    expect(bounded.code).toBe(0);
  });

  it('runs a harmless bridged probe and removes only confirmed artifacts', async () => {
    const location = await nativeLocation('rac-agent-update-probe-bridge-');
    const socket = join(location.checkout, 'tmux.sock');
    const tmuxBinary = await fakeTmuxClient(location.checkout);
    const result = await runConfiguredAgentProbe({ ...location, hostCheckout: location.checkout, socket, tmuxBinary }, 'printf 1.2.3', 2_000);

    expect(result).toEqual({ code: 0, output: '1.2.3' });
    const updates = join(location.checkout, '.data', 'agent-updates');
    expect((await readdir(updates)).filter(name => /^\w{24}\.(?:out|status)/u.test(name))).toEqual([]);
  }, 45_000);

  it('enforces a harmless bridge timeout on the host', async () => {
    const location = await nativeLocation('rac-agent-update-probe-bridge-timeout-');
    const socket = join(location.checkout, 'tmux.sock');
    const tmuxBinary = await fakeTmuxClient(location.checkout);
    const startedAt = Date.now();
    const result = await runConfiguredAgentProbe({ ...location, hostCheckout: location.checkout, socket, tmuxBinary }, '/bin/sleep 5', 100);

    expect(result).toMatchObject({ code: -1, failure: 'timed_out' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 45_000);
});
