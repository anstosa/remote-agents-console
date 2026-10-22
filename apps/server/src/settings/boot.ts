import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { ValidatedConfig } from '../config/schema.js';
import type { Installation } from './contracts.js';
import { readBounded, writePrivate } from './files.js';
import { applicationHash, contentHash, environmentProjection } from './proof.js';
import { environment } from './env.js';
import { HostSettingsTransport, settingsControlRoot, validateInstallation } from './transport.js';
import type { ConfigSourceMigration } from '../migrations/runner.js';

// select only an installer-authorized next generation for replacement proof
export async function bootInstallation(root = settingsControlRoot()): Promise<Installation | undefined> {
  const active = await new HostSettingsTransport(root).installation();
  // leave installations without settings bootstrap unchanged
  if (active === undefined) return undefined;
  const raw = await readBounded(join(root, 'desired-installation.json'), true, true);
  if (raw === undefined) return active;
  const desired = validateInstallation(JSON.parse(raw));
  // reject replacement identity or generation substitution
  if (desired.installationId !== active.installationId || desired.generation !== active.generation + 1 || desired.hostControlRoot !== active.hostControlRoot) return active;
  return desired;
}
// attest consumed bytes locally without queueing behind a waiting restart helper
export async function attestBoot(installation: Installation | undefined, config: ValidatedConfig, applicationContent: string, root = settingsControlRoot(), sourceMigration?: ConfigSourceMigration): Promise<void> {
  // uninstalled capability has no effective-state claim
  if (installation === undefined) return;
  const hashes: Record<string, string> = {}; const semanticHashes: Record<string, string> = {};
  // hash only files actually visible in this process's installed mapping
  for (const [id, source] of Object.entries(installation.sources)) {
    if (source.serverPath === undefined) continue;
    if (id === 'app') {
      // prove the consumed app rather than rereading a possible manual edit
      if (resolve(source.serverPath) === resolve(process.env.RAC_CONFIG ?? '')) { hashes.app = contentHash(applicationContent); semanticHashes.app = applicationHash(JSON.parse(applicationContent)); }
    } else {
      const content = await readBounded(source.serverPath, source.optional);
      hashes[id] = contentHash(content);
      if (id === 'env') semanticHashes.env = contentHash(environmentProjection(content ?? ''));
    }
  }
  const environmentHashes = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, contentHash(value)]));
  const environmentFile = installation.sources.env?.serverPath;
  const environmentFileHashes = environmentFile === undefined ? {} : Object.fromEntries(Object.entries(environment(await readBounded(environmentFile, installation.sources.env?.optional) ?? '')).map(([key, value]) => [key, contentHash(value)]));
  // bind migration evidence to the same consumed app bytes as the boot proof
  if (sourceMigration !== undefined && sourceMigration.toHash !== hashes.app) throw new Error('configuration migration proof does not match consumed bytes');
  const sourceMigrations = sourceMigration === undefined ? undefined : { app: sourceMigration };
  await writePrivate(join(root, 'boot.json'), JSON.stringify({ version: 1, generation: installation.generation, bootNonce: randomBytes(24).toString('base64url'), hashes, semanticHashes, environmentHashes, environmentFileHashes, ...(sourceMigrations === undefined ? {} : { sourceMigrations }), listen: config.listen, createdAt: new Date().toISOString() }));
}
