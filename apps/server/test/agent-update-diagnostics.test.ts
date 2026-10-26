import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  maxAgentUpdateOutputBytes,
  saveAgentUpdateFailure
} from '../src/agent-updates/diagnostics.js';
import { tempDir } from './helpers/codex-fixtures.js';

type StoredFailure = {
  version: number;
  id: string;
  kind: string;
  recordedAt: string;
  reason: string;
  exitCode?: number;
  output: string;
};

// read one returned report reference
async function storedFailure(checkout: string, reference: string): Promise<StoredFailure> {
  return JSON.parse(await readFile(join(checkout, reference), 'utf8')) as StoredFailure;
}

describe('agent update diagnostics', () => {
  it('durably writes a private failure report with a relative reference', async () => {
    const checkout = await tempDir('rac-agent-update-diagnostics-');
    const reference = await saveAgentUpdateFailure(checkout, {
      kind: 'omx',
      code: 17,
      output: 'installer failed\n',
      reason: 'command_failed'
    });

    expect(reference).toMatch(/^\.data\/agent-updates\/omx-[a-f0-9]{24}\.json$/u);
    const report = await storedFailure(checkout, reference);
    expect(report).toEqual({
      version: 1,
      id: reference.match(/[a-f0-9]{24}/u)?.[0],
      kind: 'omx',
      recordedAt: expect.any(String),
      reason: 'command_failed',
      exitCode: 17,
      output: 'installer failed\n'
    });
    expect(Number.isNaN(Date.parse(report.recordedAt))).toBe(false);
    expect((await stat(join(checkout, '.data', 'agent-updates'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(checkout, reference))).mode & 0o777).toBe(0o600);
  });

  it('retains only a valid utf8 tail and omits invalid exit codes', async () => {
    const checkout = await tempDir('rac-agent-update-diagnostics-tail-');
    const output = `discard this prefix:${'🙂'.repeat(maxAgentUpdateOutputBytes)}:keep this tail`;
    const reference = await saveAgentUpdateFailure(checkout, {
      kind: 'codex',
      code: 256,
      output,
      reason: 'invalid_completion'
    });
    const report = await storedFailure(checkout, reference);

    expect(Buffer.byteLength(report.output, 'utf8')).toBeLessThanOrEqual(maxAgentUpdateOutputBytes);
    expect(report.output.endsWith(':keep this tail')).toBe(true);
    expect(report.output).not.toContain('discard this prefix');
    expect(report.output).not.toContain('\ufffd');
    expect(report).not.toHaveProperty('exitCode');
  });

  it('retains at most 32 reports without removing bridge or unrelated files', async () => {
    const checkout = await tempDir('rac-agent-update-diagnostics-retention-');
    const directory = join(checkout, '.data', 'agent-updates');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'bridge.out'), 'output');
    await writeFile(join(directory, 'bridge.status'), '1');
    await writeFile(join(directory, 'notes.json'), '{}');
    let newest = '';
    // cross the retention bound
    for (let index = 0; index < 35; index += 1) {
      newest = await saveAgentUpdateFailure(checkout, {
        kind: 'omx',
        code: 1,
        output: `failure ${index}`,
        reason: 'command_failed'
      });
    }
    const entries = await readdir(directory);
    expect(entries.filter(name => /^omx-[a-f0-9]{24}\.json$/u.test(name))).toHaveLength(32);
    expect(entries).toEqual(expect.arrayContaining(['bridge.out', 'bridge.status', 'notes.json']));
    await expect(readFile(join(checkout, newest), 'utf8')).resolves.toContain('failure 34');
  });

  it('refuses a linked diagnostics directory and propagates the failure', async () => {
    const checkout = await tempDir('rac-agent-update-diagnostics-link-');
    const target = await tempDir('rac-agent-update-diagnostics-target-');
    await mkdir(join(checkout, '.data'));
    await symlink(target, join(checkout, '.data', 'agent-updates'));

    await expect(saveAgentUpdateFailure(checkout, {
      kind: 'omx',
      code: -1,
      output: 'private output',
      reason: 'launch_failed'
    })).rejects.toThrow(/private diagnostics directory/u);
    await expect(readdir(target)).resolves.toEqual([]);
  });

  it('refuses an existing diagnostics directory with public permissions', async () => {
    const checkout = await tempDir('rac-agent-update-diagnostics-mode-');
    const directory = join(checkout, '.data', 'agent-updates');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o755);

    await expect(saveAgentUpdateFailure(checkout, {
      kind: 'omx',
      code: -1,
      output: 'private output',
      reason: 'interrupted'
    })).rejects.toThrow(/private diagnostics directory/u);
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});
