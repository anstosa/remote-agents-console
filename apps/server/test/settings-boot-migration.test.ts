import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireConfig } from '../src/migrations/boot.js';
import type { ConfigSourceMigration } from '../src/migrations/runner.js';
import { attestBoot } from '../src/settings/boot.js';
import type { Installation } from '../src/settings/contracts.js';
import { contentHash } from '../src/settings/proof.js';

const directories: string[] = [];

// restore the environment and remove every isolated boot fixture
afterEach(async () => {
  vi.unstubAllEnvs();
  // keep test configuration outside the live checkout
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// bind the actual boot payload to its consumed migrated configuration
it('attests the exact buttons transition without replaying it on a later boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rac-boot-migration-'));
  directories.push(root);
  const path = join(root, 'app.json');
  const original = JSON.stringify({ publicOrigin: 'https://agents.example.com', projects: [] });
  await writeFile(path, original);
  vi.stubEnv('RAC_CONFIG', path);
  const installation = { generation: 1, sources: { app: { serverPath: path } } } as Installation;
  let consumed = '';
  let transition: ConfigSourceMigration | undefined;
  // retain only evidence supplied by this configuration acquisition
  const loaded = (content: string, migration?: ConfigSourceMigration) => { consumed = content; transition = migration; };
  const config = await acquireConfig({ RAC_CONFIG: path }, () => {}, loaded);
  await attestBoot(installation, config, consumed, root, transition);
  const boot = JSON.parse(await readFile(join(root, 'boot.json'), 'utf8'));
  expect(boot.hashes.app).toBe(contentHash(consumed));
  expect(boot.sourceMigrations).toEqual({ app: { kind: 'push-to-buttons-v1', fromHash: contentHash(original), toHash: boot.hashes.app } });
  expect(JSON.stringify(boot)).not.toContain('https://agents.example.com');

  const laterConfig = await acquireConfig({ RAC_CONFIG: path }, () => {}, loaded);
  await attestBoot(installation, laterConfig, consumed, root, transition);
  const laterBoot = JSON.parse(await readFile(join(root, 'boot.json'), 'utf8'));
  expect(laterBoot.hashes.app).toBe(boot.hashes.app);
  expect(laterBoot).not.toHaveProperty('sourceMigrations');
});
