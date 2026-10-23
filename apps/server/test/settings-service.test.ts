import { afterEach, describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, type ValidatedConfig } from '../src/config/schema.js';
import { SettingsError, type CloudflareStatus, type HostReply, type HostRequest, type Installation } from '../src/settings/contracts.js';
import { readBounded, writePrivate } from '../src/settings/files.js';
import { applicationHash, contentHash, environmentProjection } from '../src/settings/proof.js';
import { SettingsService } from '../src/settings/service.js';
import type { SettingsTransport } from '../src/settings/transport.js';

type RequestRecord = { request: HostRequest; wait: boolean | undefined };
type Fixture = { root: string; controlRoot: string; appPath: string; envPath: string; app: Record<string, unknown>; env: string; config: ValidatedConfig; transport: FakeTransport; service: SettingsService };
type SettingsOptions = NonNullable<ConstructorParameters<typeof SettingsService>[1]>;
const roots: string[] = [];
const fixturePasswordHash = '$argon2id$v=19$m=65536,t=3,p=4$W6Jf7CIBeil2lGgc+goW/w$z3yGGK095rDAeqOGhI28zjP7P4l8lsioqjpausBDZ90';
const fixtureSessionSecret = Buffer.alloc(32, 70).toString('base64url');

// remove each isolated settings service fixture
afterEach(async () => {
  // restore isolated runtime environment values
  vi.unstubAllEnvs();
  // clear every fixture created by the current test
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('simple Cloudflare connector setup', () => {
  // status inspection must not take ownership of a saved settings restart
  it('keeps pending settings restartable after a read-only connector status query', async () => {
    const current = await fixture();
    await establishEffective(current);
    const before = source(await current.service.snapshot(), 'app');
    await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path: ['listen'], value: { host: '127.0.0.1', port: 9191 } }] }] });
    await current.service.cloudflareStatus();
    const query = current.transport.records.find(record => record.request.cloudflare?.action === 'status')!.request;
    await writePrivate(join(current.controlRoot, 'latest.json'), JSON.stringify({ id: query.id, kind: 'cloudflare', state: 'complete', phase: 'inspected' }));

    const status = await current.service.status();

    expect(status).toMatchObject({ pending: true, targets: ['rac'], restartAvailable: true });
    expect(status).not.toHaveProperty('operation');
    await expect(current.service.restart()).resolves.toMatchObject({ state: 'queued' });
  });

  // retain old restart discovery without granting inspection deployment authority
  it.each(['restart', 'reconcile'])('retains the legacy %s deployment pointer', async kind => {
    const current = await fixture();
    const operation = { id: 'legacy_restart_pointer_01', kind, state: 'running', phase: 'restarting' };
    await writePrivate(join(current.controlRoot, 'latest.json'), JSON.stringify(operation));

    await expect(current.service.status()).resolves.toMatchObject({ operation: { id: operation.id, state: 'running', phase: 'restarting' } });
  });

  // retain the configured public endpoint separately from the loopback upstream
  it('returns the configured tunnel endpoint without credentials or path selectors', async () => {
    const current = await fixture();
    current.transport.cloudflare = { supported: true, mode: 'local', enabled: true, tokenPresent: false, serviceUrl: 'http://127.0.0.1:8787', hostname: 'agents.example.com', endpoint: 'https://agents.example.com:8443', connected: true };
    await expect(current.service.cloudflareStatus()).resolves.toMatchObject({ endpoint: 'https://agents.example.com:8443', hostname: 'agents.example.com', connected: true });
  });
  // reject credential-bearing or noncanonical endpoint metadata before caching
  it.each(['https://operator:private@agents.example.com', 'javascript:alert(1)', 'https://agents.example.com/private'])('rejects unsafe configured tunnel endpoint metadata', async endpoint => {
    const current = await fixture();
    current.transport.cloudflare = { supported: true, mode: 'local', enabled: true, tokenPresent: false, serviceUrl: 'http://127.0.0.1:8787', endpoint, connected: true };
    await expect(current.service.cloudflareStatus()).rejects.toMatchObject({ code: 'settings_helper_invalid' });
  });
  // stage connector credentials privately and keep status responses redacted
  it('queues connector setup with app and installation compare-and-swap proof', async () => {
    const current = await fixture();
    const installationPath = await addInstallationSource(current);
    await establishCloudflareEffective(current, installationPath);
    const token = 'synthetic-connector-credential';

    const result = await current.service.configureCloudflare({ action: 'connect', token });
    const status = await current.service.cloudflareStatus();
    const runtime = await current.service.status();
    const connect = current.transport.records.find(record => record.request.cloudflare?.action === 'connect')!;
    const staged = await readFile(join(current.controlRoot, 'staging', result.operation.id, 'cloudflare-connect'), 'utf8');

    expect(result).toEqual({ operation: { id: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u), state: 'queued', kind: 'cloudflare' } });
    expect(connect).toMatchObject({ wait: false, request: { kind: 'cloudflare', cloudflare: { action: 'connect', candidate: 'cloudflare-connect' }, sources: [{ id: 'app', existed: true }, { id: 'installation', existed: true }] } });
    expect(JSON.parse(staged)).toEqual({ action: 'connect', token });
    expect(status).toMatchObject({ mode: 'unconfigured', tokenPresent: false, operation: result.operation });
    expect(runtime).toMatchObject({ pending: false, targets: [], operation: { id: result.operation.id, state: 'queued', kind: 'cloudflare' } });
    expect(JSON.stringify({ result, status })).not.toContain(token);
    expect(current.transport.records.filter(record => record.request.cloudflare?.action === 'status')).toHaveLength(1);
  });

  // consume durable terminal connector proof without issuing a status request behind it
  it('refreshes cached status from the completed asynchronous operation', async () => {
    const current = await fixture();
    const installationPath = await addInstallationSource(current);
    await establishCloudflareEffective(current, installationPath);
    const queued = await current.service.configureCloudflare({ action: 'connect', token: 'A'.repeat(100) });
    const proved = { supported: true, mode: 'token', enabled: true, tokenPresent: true, serviceUrl: 'http://remote-agent-console:8787', connected: true };
    const fresh = { ...proved, enabled: false, connected: false };
    await writePrivate(join(current.controlRoot, 'status', `${queued.operation.id}.json`), JSON.stringify({ version: 1, id: queued.operation.id, kind: 'cloudflare', state: 'complete', phase: 'connector-ready', cloudflare: proved }));
    current.transport.cloudflare = fresh;

    const status = await current.service.cloudflareStatus();
    const operation = await current.service.operation(queued.operation.id);

    expect(status).toEqual({ ...fresh, operation: { id: queued.operation.id, state: 'complete', kind: 'cloudflare', phase: 'connector-ready' } });
    expect(operation).toEqual({ id: queued.operation.id, state: 'complete', kind: 'cloudflare', phase: 'connector-ready' });
    expect(JSON.parse(await readFile(join(current.controlRoot, 'cloudflare-status.json'), 'utf8'))).toEqual(fresh);
    expect(current.transport.records.filter(record => record.request.cloudflare?.action === 'status')).toHaveLength(2);
  });

  // expose bounded rollback status after a failed asynchronous operation
  it('returns redacted failed operation and recovered connector status', async () => {
    const current = await fixture();
    const installationPath = await addInstallationSource(current);
    await establishCloudflareEffective(current, installationPath);
    const queued = await current.service.configureCloudflare({ action: 'connect', token: 'A'.repeat(100) });
    const recovered = { supported: true, mode: 'unconfigured', enabled: false, tokenPresent: false, serviceUrl: 'http://127.0.0.1:8787' };
    await writePrivate(join(current.controlRoot, 'status', `${queued.operation.id}.json`), JSON.stringify({ version: 1, id: queued.operation.id, kind: 'cloudflare', state: 'failed', error: 'cloudflare-connector-start-failed', cloudflare: recovered }));
    current.transport.cloudflare = recovered;

    const status = await current.service.cloudflareStatus();

    expect(status).toEqual({ ...recovered, operation: { id: queued.operation.id, state: 'failed', kind: 'cloudflare', error: 'cloudflare-connector-start-failed' } });
    expect(status).not.toHaveProperty('reconnectOrigin');
  });

  // validate the discriminated public request before any helper or staging work
  it.each([
    { action: 'connect', hostname: 'agents.example.com' },
    { action: 'connect', token: 'token with spaces' },
    { action: 'connect', token: 'docker' },
    { action: 'activate', hostname: 'https://agents.example.com' },
    { action: 'activate', hostname: 'Agents.Example.COM' },
    { action: 'activate', hostname: 'localhost' },
    { action: 'activate', hostname: 'agents.example.com', token: 'unexpected' }
  ])('rejects malformed connector input %#', async input => {
    const current = await fixture();
    await addInstallationSource(current);

    await expect(current.service.configureCloudflare(input)).rejects.toMatchObject({ code: 'invalid_cloudflare_request', statusCode: 400 });
    expect(current.transport.records).toHaveLength(0);
  });

  // reject helper payloads that add credential-shaped status fields
  it('does not cache or return connector credentials from host status', async () => {
    const current = await fixture();
    current.transport.cloudflare = { supported: true, mode: 'token', enabled: true, tokenPresent: true, serviceUrl: 'http://127.0.0.1:8787', token: 'must-not-escape' } as never;

    await expect(current.service.cloudflareStatus()).rejects.toMatchObject({ code: 'settings_helper_invalid', message: 'settings_helper_invalid' });
    await expect(readFile(join(current.controlRoot, 'cloudflare-status.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // verify only a connected saved connector and return the future origin without credentials
  it('queues hostname activation after connector readiness', async () => {
    const current = await fixture();
    const installationPath = await addInstallationSource(current);
    await establishCloudflareEffective(current, installationPath);
    current.transport.cloudflare = { supported: true, mode: 'token', enabled: true, tokenPresent: true, serviceUrl: 'http://127.0.0.1:8787', connected: true };

    const result = await current.service.configureCloudflare({ action: 'activate', hostname: 'agents.example.net' });
    const status = await current.service.cloudflareStatus();
    const activate = current.transport.records.find(record => record.request.cloudflare?.action === 'activate')!;
    const staged = JSON.parse(await readFile(join(current.controlRoot, 'staging', result.operation.id, 'cloudflare-connect'), 'utf8'));

    expect(result).toMatchObject({ operation: { state: 'queued' }, reconnectOrigin: 'https://agents.example.net' });
    expect(status).not.toHaveProperty('reconnectOrigin');
    expect(staged).toEqual({ action: 'activate', hostname: 'agents.example.net' });
    expect(activate.request.sources?.map(source => source.id)).toEqual(['app', 'installation']);

    const activated = { ...current.transport.cloudflare, hostname: 'agents.example.net', verifiedAt: '2026-10-18T20:00:00.000Z' };
    await writePrivate(join(current.controlRoot, 'status', `${result.operation.id}.json`), JSON.stringify({ version: 1, id: result.operation.id, kind: 'cloudflare', state: 'complete', phase: 'activated', cloudflare: activated }));
    current.transport.cloudflare = activated;
    await expect(current.service.cloudflareStatus()).resolves.toMatchObject({ reconnectOrigin: 'https://agents.example.net', operation: { state: 'complete', phase: 'activated' } });
  });

  // refuse route activation when the saved connector process is stopped
  it('rejects activation until the managed connector is running', async () => {
    const current = await fixture();
    const installationPath = await addInstallationSource(current);
    await establishCloudflareEffective(current, installationPath);
    current.transport.cloudflare = { supported: true, mode: 'token', enabled: true, tokenPresent: true, serviceUrl: 'http://127.0.0.1:8787', connected: false };

    await expect(current.service.configureCloudflare({ action: 'activate', hostname: 'agents.example.net' })).rejects.toMatchObject({ code: 'cloudflare_connector_not_ready', statusCode: 409 });
    expect(current.transport.records.some(record => record.request.cloudflare?.action === 'activate')).toBe(false);
  });

  // avoid applying unrelated pending settings during the activation restart
  it('rejects activation while restart-bound settings are pending', async () => {
    const current = await fixture();
    await addInstallationSource(current);
    current.transport.cloudflare = { supported: true, mode: 'token', enabled: true, tokenPresent: true, serviceUrl: 'http://127.0.0.1:8787', connected: true };

    await expect(current.service.configureCloudflare({ action: 'activate', hostname: 'agents.example.net' })).rejects.toMatchObject({ code: 'settings_changes_pending', statusCode: 409 });
    expect(current.transport.records.some(record => record.request.cloudflare?.action === 'activate')).toBe(false);
  });

  // block ordinary saves while an asynchronous connector mutation owns deployment
  it('prevents settings writes from queueing behind active connector setup', async () => {
    const current = await fixture();
    const installationPath = await addInstallationSource(current);
    await establishCloudflareEffective(current, installationPath);
    await current.service.configureCloudflare({ action: 'connect', token: 'A'.repeat(100) });
    const snapshot = await current.service.snapshot();

    await expect(current.service.save({ changes: [{ sourceId: 'app', revisionId: source(snapshot, 'app').revisionId, patches: [{ op: 'set', path: ['name'], value: 'Blocked' }] }] })).rejects.toMatchObject({ code: 'settings_operation_in_progress', statusCode: 409 });
    expect(current.transport.records.filter(record => record.request.kind === 'commit')).toHaveLength(0);
  });

  // reject replacement connector input while the first asynchronous action owns deployment
  it('does not queue a second connector action behind active setup', async () => {
    const current = await fixture();
    const installationPath = await addInstallationSource(current);
    await establishCloudflareEffective(current, installationPath);
    await current.service.configureCloudflare({ action: 'connect', token: 'A'.repeat(100) });

    await expect(current.service.configureCloudflare({ action: 'connect', token: 'B'.repeat(100) })).rejects.toMatchObject({ code: 'settings_operation_in_progress', statusCode: 409 });
    expect(current.transport.records.filter(record => record.request.cloudflare?.action === 'connect')).toHaveLength(1);
  });
});

// model only the fixed host boundary used by service tests
class FakeTransport implements SettingsTransport {
  readonly records: RequestRecord[] = [];
  readonly reads: string[] = [];
  failKind?: HostRequest['kind'];
  failError?: SettingsError;
  pendingKind?: HostRequest['kind'];
  cloudflare: Omit<CloudflareStatus, 'operation' | 'reconnectOrigin'> = { supported: true, mode: 'unconfigured', enabled: false, tokenPresent: false, serviceUrl: 'http://remote-agent-console:8787', connected: false };
  // bind the fixture authority and staging root
  constructor(readonly descriptor: Installation, readonly controlRoot: string) {}
  // return the immutable fixture installation
  async installation(): Promise<Installation> { return this.descriptor; }
  // read one allowlisted fixture source
  async read(sourceId: string): Promise<string | undefined> {
    this.reads.push(sourceId);
    const source = this.descriptor.sources[sourceId];
    // reject uncataloged fixture reads
    if (source === undefined) throw new SettingsError('settings_source_unavailable', 503);
    return await readBounded(source.serverPath ?? source.path, source.optional);
  }
  // return only bounded identity metadata for host-only fixture sources
  async inspect(sourceId: string): Promise<{ sourceId: string; contentHash: string; existed: boolean }> {
    const selected = this.descriptor.sources[sourceId]!;
    const content = await readBounded(selected.path, selected.optional);
    return { sourceId, contentHash: contentHash(content), existed: content !== undefined };
  }
  // validate or commit staged candidates without invoking a service manager
  async request(request: HostRequest, wait?: boolean, published?: () => void): Promise<HostReply> {
    this.records.push({ request: structuredClone(request), wait });
    // surface one exact structured helper failure when requested
    if (request.kind === this.failKind && this.failError !== undefined) throw this.failError;
    // surface one stable helper failure when requested
    if (request.kind === this.failKind) throw new SettingsError('settings_helper_unavailable', 503);
    published?.();
    // model an ambiguous wait timeout after the helper has claimed its stage
    if (request.kind === this.pendingKind) {
      await writePrivate(join(this.controlRoot, 'status', `${request.id}.json`), JSON.stringify({ version: 1, id: request.id, kind: request.kind, state: 'running' }));
      throw new SettingsError('settings_helper_pending', 503);
    }
    // copy only fixed staged source identities on commit
    if (request.kind === 'commit') {
      // apply each requested fixture source
      for (const selected of request.sources ?? []) {
        const source = this.descriptor.sources[selected.id];
        // reject uncataloged fixture writes
        if (source === undefined) throw new SettingsError('settings_source_unavailable', 503);
        const destination = source.serverPath ?? source.path;
        // remove only an explicitly optional source
        if (selected.remove) await unlink(destination).catch(() => undefined);
        else {
          // require one fixed staged identity
          if (selected.candidate === undefined) throw new SettingsError('settings_helper_invalid', 503);
          await writeFile(destination, await readFile(join(this.controlRoot, 'staging', request.id, selected.candidate)));
        }
      }
      await writePrivate(join(this.controlRoot, 'status', `${request.id}.json`), JSON.stringify({ version: 1, id: request.id, kind: request.kind, state: 'complete' }));
    }
    // publish terminal validation evidence for stage cleanup parity
    if (request.kind === 'validate') await writePrivate(join(this.controlRoot, 'status', `${request.id}.json`), JSON.stringify({ version: 1, id: request.id, kind: request.kind, state: 'complete' }));
    // return only redacted connector state for Cloudflare status reads
    if (request.kind === 'cloudflare' && request.cloudflare?.action === 'status') return { version: 1, id: request.id, kind: request.kind, state: 'complete', cloudflare: this.cloudflare };
    return { version: 1, id: request.id, kind: request.kind, state: ['restart', 'cloudflare'].includes(request.kind) ? 'queued' : 'complete' };
  }
}

// create a full file-backed Settings service without live installation access
async function fixture(overrides: { app?: Record<string, unknown>; env?: string; live?: SettingsOptions['live']; placeholderRuntime?: SettingsOptions['placeholderRuntime'] } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'rac-settings-service-'));
  roots.push(root);
  const controlRoot = join(root, 'control');
  const appPath = join(root, 'config.json');
  const envPath = join(root, '.env');
  const app = overrides.app ?? { publicOrigin: 'https://agents.example.com', name: 'Remote Agents' };
  const env = overrides.env ?? `RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\nTZ=UTC\n`;
  await writeFile(appPath, `${JSON.stringify(app, null, 2)}\n`);
  await writeFile(envPath, env, { mode: 0o600 });
  const config = await validateConfig(app, { checkExecutables: false });
  const descriptor: Installation = {
    version: 1,
    installationId: 'isolated-service-test',
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: 'compose',
    hostCheckout: root,
    hostControlRoot: controlRoot,
    serverCheckout: root,
    allowedRoots: [root],
    sources: {
      app: { path: appPath, serverPath: appPath, kind: 'json', apply: 'rac-restart' },
      env: { path: envPath, serverPath: envPath, kind: 'env', apply: 'rac-restart' }
    },
    compose: { projectDirectory: root, projectName: 'isolated-settings', files: [join(root, 'compose.yaml')], envFiles: [envPath], profiles: [] }
  };
  const transport = new FakeTransport(descriptor, controlRoot);
  const service = new SettingsService(config, { controlRoot, transport, configPath: appPath, checkout: root, placeholderRuntime: overrides.placeholderRuntime ?? (async () => ({ hostNode: '/host/bin/node', hostPath: '/host/bin:/usr/bin', timeZone: 'America/Los_Angeles' })), ...(overrides.live === undefined ? {} : { live: overrides.live }) });
  return { root, controlRoot, appPath, envPath, app, env, config, transport, service };
}

// publish exact private effective evidence for the current fixture files
async function establishEffective(current: Fixture): Promise<void> {
  const appContent = await readFile(current.appPath, 'utf8');
  const envContent = await readFile(current.envPath, 'utf8');
  await writePrivate(join(current.controlRoot, 'effective.json'), JSON.stringify({
    version: 1,
    targets: {
      rac: {
        generation: 1,
        hashes: { app: contentHash(appContent), env: contentHash(envContent) },
        semanticHashes: { app: applicationHash(JSON.parse(appContent)), env: contentHash(environmentProjection(envContent)) },
        targets: ['rac'],
        completedAt: '2026-10-10T12:00:00.000Z'
      }
    }
  }));
}

// add the authored installation source required by Cloudflare compare-and-swap
async function addInstallationSource(current: Fixture): Promise<string> {
  const path = join(current.root, 'installation-settings.json');
  await writeFile(path, `${JSON.stringify({ version: 1, compose: current.transport.descriptor.compose }, null, 2)}\n`);
  current.transport.descriptor.sources.installation = { path, serverPath: path, kind: 'installation', apply: 'rac-restart' };
  return path;
}

// prove every RAC-owned source in the Cloudflare fixture is already effective
async function establishCloudflareEffective(current: Fixture, installationPath: string): Promise<void> {
  await establishEffective(current);
  const path = join(current.controlRoot, 'effective.json');
  const effective = JSON.parse(await readFile(path, 'utf8')) as { targets: { rac: { hashes: Record<string, string> } } };
  effective.targets.rac.hashes.installation = contentHash(await readFile(installationPath, 'utf8'));
  await writePrivate(path, JSON.stringify(effective));
}

// locate one expected snapshot source
function source(snapshot: Awaited<ReturnType<SettingsService['snapshot']>>, id: string) {
  const selected = snapshot.sources.find(candidate => candidate.id === id);
  // fail fixtures missing a required source
  if (selected === undefined) throw new Error(`missing ${id} source`);
  return selected;
}

describe('settings snapshot and disclosure', () => {
  // preserve active tunnel intent for both structured edits and whole-source saves
  it.each([
    { active: true, kind: 'compose', raw: false, owner: 'cloudflared', profiles: ['metrics'], expected: ['metrics', 'tunnel'] },
    { active: true, kind: 'compose', raw: true, owner: 'cloudflared', profiles: ['metrics'], expected: ['metrics', 'tunnel'] },
    { active: true, kind: 'compose', raw: false, owner: 'cloudflared-credentials', profiles: ['metrics'], expected: ['metrics', 'tunnel'] },
    { active: true, kind: 'compose', raw: false, owner: 'cloudflared', profiles: ['tunnel', 'metrics'], expected: ['tunnel', 'metrics'] },
    { active: false, kind: 'compose', raw: false, owner: 'cloudflared', profiles: ['metrics'], expected: ['metrics'] },
    { active: false, kind: 'compose', raw: true, owner: 'cloudflared', profiles: ['metrics'], expected: ['metrics'] },
    { active: true, kind: 'systemd', raw: false, owner: 'cloudflared', profiles: ['metrics'], expected: ['metrics'] }
  ] as const)('normalizes hidden profiles for $kind active=$active raw=$raw owner=$owner profiles=$profiles', async ({ active, kind, raw, owner, profiles, expected }) => {
    const current = await fixture();
    const descriptor = current.transport.descriptor;
    descriptor.kind = kind;
    descriptor.native = { unit: 'rac.service', environmentFile: current.envPath };
    const installationPath = join(current.root, 'installation.json');
    const cloudflarePath = join(current.root, owner === 'cloudflared' ? 'cloudflared.yaml' : 'cloudflared.json');
    const value = { version: 1, compose: { ...descriptor.compose!, profiles: [...profiles] } };
    await writeFile(installationPath, `${JSON.stringify(value)}\n`);
    await writeFile(cloudflarePath, owner === 'cloudflared' ? 'tunnel: fixture\n' : '{}\n');
    descriptor.sources.installation = { path: installationPath, serverPath: installationPath, kind: 'installation', apply: 'rac-restart' };
    descriptor.sources[owner] = { path: cloudflarePath, serverPath: cloudflarePath, kind: owner === 'cloudflared' ? 'cloudflared' : 'credentials', apply: active ? 'cloudflared-recreate' : 'saved-only', optional: true };
    const snapshot = await current.service.snapshot();
    const source = snapshot.sources.find(entry => entry.id === 'installation')!;
    const original = await readFile(installationPath, 'utf8');
    const change = { sourceId: source.id, revisionId: source.revisionId, ...(raw ? { content: JSON.stringify({ ...value, compose: { ...value.compose, projectName: 'renamed' } }) } : { patches: [{ op: 'set' as const, path: ['compose', 'projectName'], value: 'renamed' }] }) };

    expect((await current.service.validate({ changes: [change] })).valid).toBe(true);
    expect(await readFile(installationPath, 'utf8')).toBe(original);
    await current.service.save({ changes: [change] });
    expect(JSON.parse(await readFile(installationPath, 'utf8')).compose.profiles).toEqual(expected);
    expect(JSON.parse(await readFile(installationPath, 'utf8')).compose.projectName).toBe('renamed');
    expect(JSON.parse(await readFile(installationPath, 'utf8')).compose.options).toEqual(value.compose.options);
    expect(current.transport.records.some(record => record.request.kind === 'restart')).toBe(false);
  });

  // retain managed token activation without enabling the legacy local tunnel
  it('preserves the helper-managed token profile in installation edits', async () => {
    const current = await fixture();
    current.transport.descriptor.compose!.profiles = ['tunnel-token'];
    const installationPath = join(current.root, 'installation.json');
    const value = { version: 1, compose: { ...current.transport.descriptor.compose, profiles: ['metrics'] } };
    await writeFile(installationPath, `${JSON.stringify(value)}\n`);
    current.transport.descriptor.sources.installation = { path: installationPath, serverPath: installationPath, kind: 'installation', apply: 'rac-restart' };
    const before = source(await current.service.snapshot(), 'installation');

    await current.service.save({ changes: [{ sourceId: 'installation', revisionId: before.revisionId, patches: [{ op: 'set', path: ['compose', 'projectName'], value: 'renamed' }] }] });

    expect(JSON.parse(await readFile(installationPath, 'utf8')).compose.profiles).toEqual(['metrics', 'tunnel-token']);
    expect(JSON.parse(await readFile(installationPath, 'utf8')).compose.profiles).not.toContain('tunnel');
  });

  // report the installed mode independently of editable source branches
  it.each(['compose', 'systemd'] as const)('exposes the authoritative %s installation kind', async kind => {
    const current = await fixture();
    current.transport.descriptor.kind = kind;
    expect(await current.service.snapshot()).toHaveProperty('installationKind', kind);
    expect(await current.service.snapshot(false)).toHaveProperty('installationKind', kind);
  });

  // do not invent an installation mode without an installed applier
  it('omits installation kind when the applier is unavailable', async () => {
    const current = await fixture();
    const unavailable = new SettingsService(current.config, { controlRoot: join(current.root, 'uninstalled'), transport: { installation: async () => undefined } as never });
    expect(await unavailable.snapshot()).not.toHaveProperty('installationKind');
  });

  // expose safe omission behavior to controllers without materializing authored values
  it('publishes environment fallbacks only in controller snapshots', async () => {
    const current = await fixture({ env: `RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\nCUSTOM_OPERATOR_SETTING=custom\n` });
    const controller = source(await current.service.snapshot(true, 'controller-session'), 'env');
    const tmux = controller.fields?.find(field => field.key === 'RAC_TMUX_BIN');
    const inheritedSecret = controller.fields?.find(field => field.key === 'RAC_INSTANCE_STATUS_SECRET');
    const requiredSecret = controller.fields?.find(field => field.key === 'RAC_SESSION_SECRET');
    const custom = controller.fields?.find(field => field.key === 'CUSTOM_OPERATOR_SETTING');

    expect(tmux).toMatchObject({ present: false, fallback: { value: '/usr/bin/tmux (from built-in default)', kind: 'literal' } });
    expect(tmux).not.toHaveProperty('value');
    expect(inheritedSecret).toMatchObject({ protected: true, present: false, fallback: { value: 'Hidden (from RAC_SESSION_SECRET)', kind: 'derived' } });
    expect(requiredSecret).toHaveProperty('fallback', { value: 'Required; no default', kind: 'derived' });
    expect(custom).not.toHaveProperty('fallback');
    expect(source(await current.service.snapshot(false), 'env').fields?.every(field => !Object.hasOwn(field, 'fallback'))).toBe(true);
  });

  // resolve source references without materializing placeholder text in the file
  it('publishes actual values before their sources and follows saved application edits', async () => {
    const current = await fixture();
    const before = await readFile(current.envPath, 'utf8');
    const first = source(await current.service.snapshot(), 'env');
    expect(first.fields?.find(field => field.key === 'RAC_HOST_NODE_BIN')).toMatchObject({ present: false, fallback: { value: '/host/bin/node (from host PATH)' } });
    expect(first.fields?.find(field => field.key === 'RAC_TEMP_PREVIEW_ORIGIN')).toHaveProperty('fallback.value', 'https://agents.example.com (from Application Public Origin)');
    await writeFile(current.appPath, JSON.stringify({ ...current.app, publicOrigin: 'https://next.example.org' }));
    const next = source(await current.service.snapshot(), 'env');
    expect(next.fields?.find(field => field.key === 'RAC_TEMP_PREVIEW_ORIGIN')).toHaveProperty('fallback.value', 'https://next.example.org (from Application Public Origin)');
    expect(await readFile(current.envPath, 'utf8')).toBe(before);
  });

  // observers perform no host inspection and concurrent controllers share one lookup
  it('deduplicates runtime facts without executing pending environment values', async () => {
    vi.stubEnv('RAC_HOST_PATH', '/applied/bin');
    const lookup = vi.fn(async () => ({ hostNode: `${process.env.RAC_HOST_PATH}/node` }));
    const current = await fixture({ env: 'RAC_HOST_PATH=/pending/bin\n', placeholderRuntime: lookup });
    await current.service.snapshot(false);
    expect(lookup).not.toHaveBeenCalled();
    const snapshots = await Promise.all([current.service.snapshot(), current.service.snapshot()]);
    expect(lookup).toHaveBeenCalledTimes(1);
    // pending PATH is configuration text rather than permission to execute it
    for (const snapshot of snapshots) expect(source(snapshot, 'env').fields?.find(field => field.key === 'RAC_HOST_NODE_BIN')).toHaveProperty('fallback.value', '/applied/bin/node (from host PATH)');
  });

  // unavailable host facts must not substitute the container runtime
  it('retains a usable snapshot when runtime inspection fails', async () => {
    const current = await fixture({ placeholderRuntime: async () => { throw new Error('host unavailable'); } });
    const env = source(await current.service.snapshot(), 'env');
    expect(env.fields?.find(field => field.key === 'RAC_HOST_NODE_BIN')).toHaveProperty('fallback.value', 'Unavailable (from host PATH)');
  });

  // inherited defaults remain subject to cross-source credential redaction
  it('suppresses concrete defaults that repeat protected bytes', async () => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', adapters: { codex: { program: `/host/${fixtureSessionSecret}/codex` } } }, placeholderRuntime: async () => ({ hostNode: `/host/${fixtureSessionSecret}/node`, hostPath: `/host/${fixtureSessionSecret}` }) });
    const snapshot = await current.service.snapshot();
    const env = source(snapshot, 'env');
    // filter both application references and fixed host inspection output
    for (const key of ['RAC_CODEX_BIN', 'RAC_HOST_CODEX_BIN', 'RAC_HOST_NODE_BIN', 'RAC_HOST_PATH']) expect(env.fields?.find(field => field.key === key)).not.toHaveProperty('fallback');
    expect(JSON.stringify(snapshot)).not.toContain(fixtureSessionSecret);
  });

  // keep missing bridge hints installation-aware and display-only
  it.each(['compose', 'systemd'] as const)('publishes missing TMUX guidance for %s without writing defaults', async kind => {
    const current = await fixture();
    current.transport.descriptor.kind = kind;
    const before = await readFile(current.envPath, 'utf8');
    const env = source(await current.service.snapshot(true, 'controller-session'), 'env');
    const expected = 'Not mounted (from native socket discovery)';
    expect(env.fields?.find(field => field.key === 'RAC_HOST_TMUX_DIR')).toMatchObject({ present: false, fallback: { value: expected, kind: 'derived' } });
    expect(env.fields?.find(field => field.key === 'HOST_TMUX_DIR')).toMatchObject({ present: false, fallback: { value: 'Unavailable (from host HOME)', kind: 'derived' } });
    expect(env.fields?.find(field => field.key === 'HOST_TMUX_BIN')).toMatchObject({ present: false, fallback: { value: '/usr/bin/tmux (from Docker bridge default)', kind: 'derived' } });
    expect(await readFile(current.envPath, 'utf8')).toBe(before);
    expect(source(await current.service.snapshot(false), 'env').fields?.every(field => !Object.hasOwn(field, 'fallback'))).toBe(true);
  });

  // distinguish explicit empty assignments from genuine omission defaults
  it('describes retained empty environment values without changing blank-aware node lookup', async () => {
    const current = await fixture({ env: 'RAC_TMUX_BIN=\nRAC_INSTANCE_STATUS_SECRET=\nRAC_HOST_NODE_BIN=\n' });
    const env = source(await current.service.snapshot(true, 'controller-session'), 'env');
    expect(env.fields?.find(field => field.key === 'RAC_TMUX_BIN')).toHaveProperty('emptyValueHint', 'Empty (from explicit environment assignment)');
    expect(env.fields?.find(field => field.key === 'RAC_INSTANCE_STATUS_SECRET')).toMatchObject({ hasValue: false, emptyValueHint: 'Empty (from explicit environment assignment)' });
    expect(env.fields?.find(field => field.key === 'RAC_HOST_NODE_BIN')).not.toHaveProperty('emptyValueHint');
    expect(env.fields?.find(field => field.key === 'RAC_HOST_NODE_BIN')).toHaveProperty('fallback', { value: '/host/bin/node (from host PATH)', kind: 'derived' });
    expect(source(await current.service.snapshot(false), 'env').fields?.every(field => !Object.hasOwn(field, 'emptyValueHint'))).toBe(true);
  });

  // expose the host-node omission default even when Compose explicitly passes blank
  it.each([undefined, '', ' \t '])('publishes the host PATH placeholder for blank Compose node %j', async running => {
    vi.stubEnv('RAC_HOST_NODE_BIN', running);
    const current = await fixture({ env: 'RAC_HOST_NODE_BIN=\n' });
    await establishEffective(current);
    const proofPath = join(current.controlRoot, 'effective.json');
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    proof.targets.rac.shadowedEnvironmentKeys = ['RAC_HOST_NODE_BIN'];
    await writePrivate(proofPath, JSON.stringify(proof));

    const snapshot = await current.service.snapshot(true, 'controller-session');
    const env = source(snapshot, 'env');
    expect(env.fields?.find(field => field.key === 'RAC_HOST_NODE_BIN')).toMatchObject({
      value: '', present: true, protected: false, fallback: { value: '/host/bin/node (from host PATH)', kind: 'derived' }
    });
    expect(await readFile(current.envPath, 'utf8')).toBe('RAC_HOST_NODE_BIN=\n');
    expect(source(await current.service.snapshot(false), 'env').fields?.every(field => !Object.hasOwn(field, 'fallback'))).toBe(true);
  });

  // trust only proved non-secret Compose values as omission fallbacks
  it('publishes confirmed Compose fallbacks without leaking protected bytes', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/host-tmux');
    vi.stubEnv('RAC_INSTANCE_STATUS_SECRET', 'runtime-instance-secret');
    vi.stubEnv('RAC_INTERACTIVE_SHELL', '');
    vi.stubEnv('RAC_TMUX_BIN', undefined);
    vi.stubEnv('RAC_PROJECT_PROXY_HOST', 'x'.repeat(4_097));
    vi.stubEnv('TZ', fixtureSessionSecret);
    vi.stubEnv('RAC_SESSION_SECRET', 'runtime-session-secret');
    const current = await fixture();
    await establishEffective(current);
    const proofPath = join(current.controlRoot, 'effective.json');
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    proof.targets.rac.shadowedEnvironmentKeys = ['RAC_HOST_TMUX_DIR', 'RAC_INSTANCE_STATUS_SECRET', 'RAC_INTERACTIVE_SHELL', 'RAC_TMUX_BIN', 'RAC_PROJECT_PROXY_HOST', 'TZ', 'RAC_SESSION_SECRET'];
    await writePrivate(proofPath, JSON.stringify(proof));

    const snapshot = await current.service.snapshot(true, 'controller-session');
    const env = source(snapshot, 'env');
    expect(env.fields?.find(field => field.key === 'RAC_HOST_TMUX_DIR')).toHaveProperty('fallback', { value: '/host-tmux (from Compose environment)', kind: 'compose' });
    expect(env.fields?.find(field => field.key === 'RAC_INSTANCE_STATUS_SECRET')).toHaveProperty('fallback', { value: 'Hidden (from Compose environment)', kind: 'derived' });
    expect(env.fields?.find(field => field.key === 'RAC_INTERACTIVE_SHELL')).not.toHaveProperty('fallback');
    expect(env.fields?.find(field => field.key === 'RAC_TMUX_BIN')).not.toHaveProperty('fallback');
    expect(env.fields?.find(field => field.key === 'RAC_PROJECT_PROXY_HOST')).not.toHaveProperty('fallback');
    expect(env.fields?.find(field => field.key === 'TZ')).not.toHaveProperty('fallback');
    expect(env.fields?.find(field => field.key === 'RAC_SESSION_SECRET')).toHaveProperty('fallback', { value: 'Hidden (from Compose environment)', kind: 'derived' });
    expect(env.fields?.find(field => field.key === 'RAC_HOST_TMUX_SOURCE')).toHaveProperty('fallback', { value: `/tmp/tmux-${process.getuid()} (from process UID)`, kind: 'derived' });
    expect(JSON.stringify(snapshot)).not.toContain('runtime-instance-secret');
    expect(JSON.stringify(snapshot)).not.toContain('runtime-session-secret');
    expect(JSON.stringify(snapshot)).not.toContain('x'.repeat(4_097));
    expect(source(await current.service.snapshot(false), 'env').fields?.every(field => !Object.hasOwn(field, 'fallback'))).toBe(true);
  });

  // require conflicting values and independently proved Compose ownership
  it.each([
    { label: 'confirmed Compose conflict', saved: 'file-value', running: 'compose-value', shadowed: true, winner: true },
    { label: 'equal values', saved: 'same-value', running: 'same-value', shadowed: true, winner: false },
    { label: 'unproved runtime difference', saved: 'file-value', running: 'runtime-value', shadowed: false, winner: false },
    { label: 'file-only value', saved: 'file-value', running: undefined, shadowed: true, winner: false },
    { label: 'absent file value', saved: undefined, running: 'compose-value', shadowed: true, winner: false },
    { label: 'ordinary file value', saved: 'file-value', running: 'file-value', shadowed: false, winner: false },
    { label: 'stale installation proof', saved: 'file-value', running: 'compose-value', shadowed: true, winner: false, stale: true },
    { label: 'non-Compose installation', saved: 'file-value', running: 'runtime-value', shadowed: true, winner: false, native: true },
    { label: 'protected Compose conflict', saved: 'file-secret', running: 'compose-secret', shadowed: true, winner: true, protected: true }
  ])('reports a winning source only for $label', async ({ saved, running, shadowed, winner, stale, native, protected: protectedValue }) => {
    const key = protectedValue ? 'RAC_SESSION_SECRET' : 'RAC_PROJECT_PROXY_HOST';
    vi.stubEnv(key, running);
    const current = await fixture({ env: saved === undefined ? '' : `${key}=${saved}\n` });
    await establishEffective(current);
    const proofPath = join(current.controlRoot, 'effective.json');
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    proof.targets.rac.shadowedEnvironmentKeys = shadowed ? [key] : [];
    // reject provenance outside the active installation
    if (stale) proof.targets.rac.generation = 0;
    if (native) current.transport.descriptor.kind = 'systemd';
    await writePrivate(proofPath, JSON.stringify(proof));

    const snapshot = await current.service.snapshot();
    const field = source(snapshot, 'env').fields?.find(candidate => candidate.key === key);
    // only a known conflicting winner gets provenance metadata
    if (winner) expect(field).toHaveProperty('winningSource', 'Compose environment');
    else expect(field).not.toHaveProperty('winningSource');
    // preserve secret masking while exposing value-free ownership
    if (protectedValue) {
      expect(field).toMatchObject({ protected: true, present: true });
      expect(JSON.stringify(snapshot)).not.toContain(saved);
      expect(JSON.stringify(snapshot)).not.toContain(running);
    }
  });

  // disclose only redacted host source text to the controller
  it('keeps host-only plaintext out of observer snapshots and controller editor content', async () => {
    const current = await fixture();
    const credentials = join(current.root, 'credentials.json');
    await writeFile(credentials, '{"AccountTag":"visible-account","TunnelSecret":"host-only-sentinel","TunnelID":"visible-tunnel"}');
    current.transport.descriptor.sources['cloudflared-credentials'] = { path: credentials, kind: 'credentials', apply: 'cloudflared-recreate', optional: true };
    const observer = await current.service.snapshot(false);
    await current.service.status();
    expect(source(observer, 'cloudflared-credentials')).toMatchObject({ exists: true, protected: true, hasProtectedContent: true });
    expect(source(observer, 'cloudflared-credentials')).not.toHaveProperty('content');
    expect(current.transport.reads).not.toContain('cloudflared-credentials');
    const controller = await current.service.snapshot(true, 'controller-session');
    expect(source(controller, 'cloudflared-credentials')).toMatchObject({ exists: true, protected: true, hasProtectedContent: true, content: expect.stringContaining('visible-account') });
    expect(JSON.stringify(controller)).not.toContain('host-only-sentinel');
    expect(current.transport.reads).toContain('cloudflared-credentials');
    current.transport.inspect = async () => { throw new SettingsError('settings_inspection_unavailable', 503); };
    await expect(current.service.snapshot()).rejects.toMatchObject({ code: 'settings_inspection_unavailable' });
  });

  // parse one selected host-only JSON path only inside its controller disclosure
  it('reveals a protected path from host-only JSON', async () => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', name: 'Remote Agents', adapters: { codex: { program: '/bin/sh', env: { TOKEN: 'host-json-secret' } } } } });
    const appSource = current.transport.descriptor.sources.app!;
    current.transport.descriptor.sources.app = { path: appSource.path, kind: appSource.kind, apply: appSource.apply };
    const snapshot = await current.service.snapshot(true, 'controller-session');
    const selected = source(snapshot, 'app');

    const disclosure = await current.service.reveal({ sourceId: 'app', revisionId: selected.revisionId, path: ['adapters', 'codex', 'env', 'TOKEN'] }, 'controller-session');

    expect(disclosure.value).toBe('host-json-secret');
    expect(JSON.stringify(snapshot)).not.toContain('host-json-secret');
  });

  // redact credentials while returning advanced operator settings directly
  it('returns complete editable structure with only credential values protected', async () => {
    const current = await fixture({
      app: {
        publicOrigin: 'https://agents.example.com',
        name: 'Remote Agents',
        editor: 'editor sentinel',
        adapters: { codex: { program: '/bin/sh', args: ['argument sentinel'], env: { TOKEN: 'adapter credential sentinel', SAFE_LOOKING_NAME: 'adapter environment sentinel' }, setup: 'setup sentinel' } },
        integrations: { enabled: true, realtime: { enabled: true, name: 'Davo', context: 'context sentinel' } },
        review: { tour: { agent: 'codex', prompt: 'review prompt sentinel' } },
        projects: [{ id: 'one', path: '/tmp/project', commands: { start: 'project command sentinel' }, newTask: 'new task sentinel', push: { label: 'Push', prompt: 'push prompt sentinel' } }]
      },
      env: "RAC_SESSION_SECRET='session secret sentinel'\nRAC_OPENAI_API_KEY='api key sentinel'\nUNKNOWN_OPERATOR_VALUE='unknown sentinel'\nDATABASE_URL='postgres://user:database-password@example.test/app'\nCURL_FLAGS='-H \"Authorization: Bearer header~credential\"'\nRAC_LISTEN_PORT=8787\nTZ=UTC\n"
    });

    const snapshot = await current.service.snapshot();
    const app = source(snapshot, 'app');
    const env = source(snapshot, 'env');
    const serialized = JSON.stringify(snapshot);

    expect(app.value).toMatchObject({
      editor: 'editor sentinel',
      adapters: { codex: { program: '/bin/sh', args: ['argument sentinel'], env: { TOKEN: { __racProtected: true, present: true }, SAFE_LOOKING_NAME: 'adapter environment sentinel' }, setup: 'setup sentinel' } },
      integrations: { realtime: { context: 'context sentinel' } },
      review: { tour: { prompt: 'review prompt sentinel' } },
      projects: [{ commands: { start: 'project command sentinel' }, newTask: 'new task sentinel', push: { prompt: 'push prompt sentinel' } }]
    });
    expect(env.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'RAC_SESSION_SECRET', protected: true, present: true, description: expect.stringContaining('browser sessions') }),
      expect.objectContaining({ key: 'RAC_OPENAI_API_KEY', protected: true, present: true, description: expect.stringContaining('voice') }),
      expect.objectContaining({ key: 'UNKNOWN_OPERATOR_VALUE', protected: false, present: true, value: 'unknown sentinel', description: expect.stringContaining('Custom environment variable') }),
      expect.objectContaining({ key: 'DATABASE_URL', protected: true, present: true }),
      expect.objectContaining({ key: 'CURL_FLAGS', protected: true, present: true }),
      expect.objectContaining({ key: 'RAC_LISTEN_PORT', protected: false, value: '8787', description: expect.stringContaining('TCP port') }),
      expect.objectContaining({ key: 'RAC_HOST_NODE_BIN', protected: false, present: false, description: expect.stringContaining('Files broker') })
    ]));
    expect(env.fields?.every(field => typeof field.description === 'string' && field.description.length >= 24)).toBe(true);
    expect(serialized).toMatch(/editor sentinel/u);
    expect(serialized).toMatch(/argument sentinel/u);
    expect(serialized).toMatch(/adapter environment sentinel/u);
    expect(serialized).toMatch(/setup sentinel/u);
    expect(serialized).toMatch(/context sentinel/u);
    expect(serialized).toMatch(/review prompt sentinel/u);
    expect(serialized).toMatch(/project command sentinel/u);
    expect(serialized).toMatch(/new task sentinel/u);
    expect(serialized).toMatch(/push prompt sentinel/u);
    expect(serialized).toMatch(/unknown sentinel/u);
    expect(serialized).not.toMatch(/(?:adapter credential|session secret|api key) sentinel|database-password|header~credential/u);
    expect(serialized).not.toMatch(/contentHash|semanticHashes|"hashes"/u);
    expect(app.revisionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(snapshot.revisionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(app.pathRevisions?.[JSON.stringify(['editor'])]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(app.pathRevisions?.[JSON.stringify(['adapters', 'codex', 'env', 'TOKEN'])]).toBeUndefined();

    const observer = await current.service.snapshot(false);
    expect(source(observer, 'app')).not.toHaveProperty('path');
    expect(source(observer, 'app').writable).toBe(false);
  });

  // distinguish empty protected leaves without changing nonempty marker compatibility
  it('marks null structured credentials empty and leaves nonempty markers unchanged', async () => {
    const current = await fixture();
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, adapters: { codex: { program: '/bin/sh', env: { EMPTY_TOKEN: null, FULL_TOKEN: 'structured secret' } } } }, null, 2)}\n`);

    const app = source(await current.service.snapshot(), 'app');
    const adapterEnv = (app.value as { adapters: { codex: { env: Record<string, unknown> } } }).adapters.codex.env;

    expect(adapterEnv.EMPTY_TOKEN).toEqual({ __racProtected: true, present: true, hasValue: false });
    expect(adapterEnv.FULL_TOKEN).toEqual({ __racProtected: true, present: true });
    expect(adapterEnv.FULL_TOKEN).not.toHaveProperty('hasValue');
  });

  // retain empty secret presence for removal while hiding its reveal affordance
  it('marks an explicitly empty environment credential and preserves missing and nonempty shapes', async () => {
    const current = await fixture({ env: `RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\nRAC_GITHUB_TOKEN=\nRAC_OPENAI_API_KEY='voice secret'\n` });
    const before = source(await current.service.snapshot(), 'env');
    const empty = before.fields?.find(field => field.key === 'RAC_GITHUB_TOKEN');
    const nonempty = before.fields?.find(field => field.key === 'RAC_OPENAI_API_KEY');
    const missing = before.fields?.find(field => field.key === 'RAC_REALTIME_MCP_TOKEN');

    expect(empty).toMatchObject({ protected: true, present: true, hasValue: false });
    expect(empty).not.toHaveProperty('value');
    expect(nonempty).toMatchObject({ protected: true, present: true });
    expect(nonempty).not.toHaveProperty('hasValue');
    expect(missing).toMatchObject({ protected: true, present: false });
    expect(missing).not.toHaveProperty('hasValue');

    await current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, patches: [{ op: 'remove', path: ['RAC_GITHUB_TOKEN'] }] }] }, 'controller-session');

    expect(await readFile(current.envPath, 'utf8')).not.toContain('RAC_GITHUB_TOKEN');
    const removed = source(await current.service.snapshot(), 'env').fields?.find(field => field.key === 'RAC_GITHUB_TOKEN');
    expect(removed).toMatchObject({ protected: true, present: false });
    expect(removed).not.toHaveProperty('hasValue');
  });

  // preserve legacy VAPID bytes for migration without exposing typed controls
  it('hides and rejects direct edits or disclosure of legacy VAPID environment values', async () => {
    const legacy = "export RAC_VAPID_PUBLIC_KEY='legacy public'\nRAC_VAPID_PRIVATE_KEY='legacy\nprivate'\n";
    const visible = `RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\nVISIBLE_SETTING=before\n`;
    const current = await fixture({ env: `${visible}${legacy}` });
    const before = source(await current.service.snapshot(true, 'controller-session'), 'env');

    expect(before.fields?.some(field => field.key.startsWith('RAC_VAPID_'))).toBe(false);
    expect(before.content).not.toContain('RAC_VAPID_');
    expect(before.content).not.toContain('legacy');
    await expect(current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, patches: [{ op: 'set', path: ['RAC_VAPID_PUBLIC_KEY'], value: 'replacement' }] }] }, 'controller-session')).rejects.toMatchObject({ code: 'invalid_environment_patch' });
    await expect(current.service.reveal({ sourceId: 'env', revisionId: before.revisionId, path: ['RAC_VAPID_PRIVATE_KEY'] }, 'controller-session')).rejects.toMatchObject({ code: 'invalid_settings_path' });
    const maskedSaved = await current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, content: before.content!.replace('VISIBLE_SETTING=before', 'VISIBLE_SETTING=masked') }] }, 'controller-session');
    expect(await readFile(current.envPath, 'utf8')).toBe(`${visible.replace('VISIBLE_SETTING=before', 'VISIBLE_SETTING=masked')}${legacy}`);

    const maskedSource = source(maskedSaved, 'env');
    const disclosure = await current.service.reveal({ sourceId: 'env', revisionId: maskedSource.revisionId }, 'controller-session');
    expect(disclosure.value).toBe(visible.replace('VISIBLE_SETTING=before', 'VISIBLE_SETTING=masked'));

    await current.service.save({ changes: [{ sourceId: 'env', revisionId: maskedSource.revisionId, content: String(disclosure.value).replace('VISIBLE_SETTING=masked', 'VISIBLE_SETTING=after') }] }, 'controller-session');
    expect(await readFile(current.envPath, 'utf8')).toBe(`${visible.replace('VISIBLE_SETTING=before', 'VISIBLE_SETTING=after')}${legacy}`);
  });

  // reject managed assignments submitted through the projected raw editor
  it.each(['RAC_VAPID_PUBLIC_KEY', 'RAC_VAPID_PRIVATE_KEY'])('rejects raw insertion of managed %s', async key => {
    const legacy = "RAC_VAPID_PUBLIC_KEY='legacy public'\nRAC_VAPID_PRIVATE_KEY='legacy private'\n";
    const current = await fixture({ env: `${legacy}RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\n` });
    const before = source(await current.service.snapshot(true, 'controller-session'), 'env');

    await expect(current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, content: `${before.content}${key}='replacement'\n` }] }, 'controller-session')).rejects.toMatchObject({ code: 'invalid_environment_patch' });
    expect(await readFile(current.envPath, 'utf8')).toBe(`${legacy}RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\n`);
  });

  // keep malformed ordinary dotenv bytes repairable while hiding managed records after them
  it('projects and repairs an unterminated environment assignment without exposing VAPID keys', async () => {
    const visible = `RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\nBROKEN="unfinished\nVISIBLE=ok\n`;
    const hidden = "RAC_VAPID_PRIVATE_KEY='legacy private'\nRAC_VAPID_PUBLIC_KEY='legacy public'\n";
    const current = await fixture({ env: `${visible.slice(0, -11)}${hidden}VISIBLE=ok\n` });
    const before = source(await current.service.snapshot(true, 'controller-session'), 'env');

    expect(before.content).toContain('BROKEN="unfinished');
    expect(before.content).not.toContain('RAC_VAPID_');
    const disclosure = await current.service.reveal({ sourceId: 'env', revisionId: before.revisionId }, 'controller-session');
    expect(disclosure.value).toBe(visible);

    const repaired = String(disclosure.value).replace('BROKEN="unfinished', 'BROKEN=fixed');
    await current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, content: repaired }] }, 'controller-session');
    expect(await readFile(current.envPath, 'utf8')).toBe(`${repaired}${hidden}`);
  });

  // redact one credential everywhere it is repeated across structured and raw sources
  it('does not leak cross-source credentials through ordinary fields or code editors', async () => {
    const credential = 'cross-source-credential-sentinel';
    const current = await fixture({
      app: { publicOrigin: 'https://agents.example.com', name: 'Remote Agents', editor: 'echo visible', review: { tour: { prompt: `run ${credential}` } } },
      env: `RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\nRAC_REALTIME_MCP_TOKEN='${credential}'\nVISIBLE_ALIAS='${credential}'\n`
    });
    const snapshot = await current.service.snapshot(true, 'controller-session');
    const app = source(snapshot, 'app');
    const env = source(snapshot, 'env');

    expect(JSON.stringify(snapshot)).not.toContain(credential);
    expect(app.content).toContain('echo visible');
    expect(app.value).toMatchObject({ review: { tour: { prompt: { __racProtected: true, present: true } } } });
    expect(env.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'VISIBLE_ALIAS', protected: true, present: true })]));
    expect(env.fields?.find(field => field.key === 'VISIBLE_ALIAS')).not.toHaveProperty('value');

    const saved = await current.service.save({ changes: [{ sourceId: app.id, revisionId: app.revisionId, content: app.content!.replace('echo visible', 'echo changed') }] }, 'controller-session');
    expect(JSON.stringify(saved)).not.toContain(credential);
    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ editor: 'echo changed', review: { tour: { prompt: `run ${credential}` } } });
  });

  // reveal exactly one selected value and reject stale revisions after external edits
  it('discloses only the selected revision-bound value and supports remask', async () => {
    const current = await fixture({ env: "RAC_SESSION_SECRET='selected secret'\nRAC_OPENAI_API_KEY='adjacent secret'\n" });
    const snapshot = await current.service.snapshot();
    const env = source(snapshot, 'env');

    const revealed = await current.service.reveal({ sourceId: 'env', revisionId: env.revisionId, path: ['RAC_SESSION_SECRET'] }, 'controller-session');
    expect(revealed.value).toBe('selected secret');
    expect(JSON.stringify(revealed)).not.toContain('adjacent secret');
    expect(revealed.leaseId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    await expect(current.service.remask(revealed.leaseId, 'controller-session')).resolves.toEqual({ ok: true });

    await writeFile(current.envPath, "RAC_SESSION_SECRET='rotated secret'\nRAC_OPENAI_API_KEY='adjacent secret'\n", { mode: 0o600 });
    await expect(current.service.reveal({ sourceId: 'env', revisionId: env.revisionId, path: ['RAC_SESSION_SECRET'] }, 'controller-session')).rejects.toMatchObject({ code: 'settings_conflict', statusCode: 409 });
  });

  // preserve masked raw credentials until an active whole-source disclosure authorizes replacement
  it('rehydrates editor markers and binds plaintext raw saves to the revealing session', async () => {
    const current = await fixture();
    const credentials = join(current.root, 'credentials.json');
    await writeFile(credentials, `${JSON.stringify({ AccountTag: 'account-before', TunnelSecret: 'credential sentinel', TunnelID: 'tunnel-id' })}\n`);
    current.transport.descriptor.sources['cloudflared-credentials'] = { path: credentials, serverPath: credentials, kind: 'credentials', apply: 'cloudflared-recreate', optional: true };
    const before = source(await current.service.snapshot(true, 'controller-session'), 'cloudflared-credentials');
    const redacted = before.content!.replace('account-before', 'account-after');

    const saved = await current.service.save({ changes: [{ sourceId: before.id, revisionId: before.revisionId, content: redacted }] }, 'controller-session');
    expect(JSON.parse(await readFile(credentials, 'utf8'))).toEqual({ AccountTag: 'account-after', TunnelSecret: 'credential sentinel', TunnelID: 'tunnel-id' });
    expect(JSON.stringify(saved)).not.toContain('credential sentinel');

    const currentSource = source(saved, 'cloudflared-credentials');
    const marker = /__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/u.exec(currentSource.content!)![0];
    await expect(current.service.save({ changes: [{ sourceId: currentSource.id, revisionId: currentSource.revisionId, content: currentSource.content!.replace(marker, `${marker}x`) }] }, 'controller-session')).rejects.toMatchObject({ code: 'settings_protected_content_changed' });

    const disclosure = await current.service.reveal({ sourceId: currentSource.id, revisionId: currentSource.revisionId }, 'controller-session');
    const revealed = String(disclosure.value).replace('credential sentinel', 'rotated credential sentinel');
    await expect(current.service.save({ changes: [{ sourceId: currentSource.id, revisionId: currentSource.revisionId, content: revealed }] }, 'other-session')).rejects.toMatchObject({ code: 'settings_protected_content_changed' });
    await current.service.save({ changes: [{ sourceId: currentSource.id, revisionId: currentSource.revisionId, content: revealed }] }, 'controller-session');
    expect(JSON.parse(await readFile(credentials, 'utf8'))).toMatchObject({ TunnelSecret: 'rotated credential sentinel' });
  });
});

describe('settings native editor source resolution', () => {
  // return only a current installed source path at its exact revision
  it('resolves current files and rejects unknown, missing, and stale sources', async () => {
    const current = await fixture();
    const missingPath = join(current.root, 'optional-missing.yaml');
    current.transport.descriptor.sources.optional = { path: missingPath, serverPath: missingPath, kind: 'compose', apply: 'rac-restart', optional: true };
    const snapshot = await current.service.snapshot(false);
    const app = source(snapshot, 'app');
    const missing = source(snapshot, 'optional');

    await expect(current.service.editorFile('app', app.revisionId)).resolves.toBe(current.appPath);
    await expect(current.service.editorFile('unknown', app.revisionId)).rejects.toMatchObject({ code: 'settings_source_unavailable', statusCode: 404 });
    await expect(current.service.editorFile('optional', missing.revisionId)).rejects.toMatchObject({ code: 'settings_source_unavailable', statusCode: 404 });
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, name: 'Externally changed' }, null, 2)}\n`);
    await expect(current.service.editorFile('app', app.revisionId)).rejects.toMatchObject({ code: 'settings_conflict', statusCode: 409 });
  });

  // inspect host-only identity without retrieving its plaintext
  it('uses host inspection for host-only files', async () => {
    const current = await fixture();
    const credentials = join(current.root, 'credentials.json');
    await writeFile(credentials, '{"TunnelSecret":"native-editor-secret"}\n');
    current.transport.descriptor.sources.credentials = { path: credentials, kind: 'credentials', apply: 'cloudflared-recreate' };
    const credentialsSource = source(await current.service.snapshot(false), 'credentials');
    current.transport.reads.length = 0;

    await expect(current.service.editorFile('credentials', credentialsSource.revisionId)).resolves.toBe(credentials);
    expect(current.transport.reads).not.toContain('credentials');
  });

  // keep pending migration paths outside current launch authority
  it('returns the installed path instead of a desired migration path', async () => {
    const current = await fixture();
    const desiredPath = join(current.root, 'next-config.json');
    const desired: Installation = {
      ...structuredClone(current.transport.descriptor),
      generation: current.transport.descriptor.generation + 1,
      sources: { ...structuredClone(current.transport.descriptor.sources), app: { ...current.transport.descriptor.sources.app!, path: desiredPath, serverPath: desiredPath } }
    };
    await writePrivate(join(current.controlRoot, 'desired-installation.json'), JSON.stringify(desired));
    const app = source(await current.service.snapshot(false), 'app');

    await expect(current.service.editorFile('app', app.revisionId)).resolves.toBe(current.appPath);
  });

  // fail closed when no settings applier installation owns the source allowlist
  it('rejects resolution without an installed settings descriptor', async () => {
    const current = await fixture();
    const unavailable = new SettingsService(current.config, { controlRoot: join(current.root, 'uninstalled'), transport: { installation: async () => undefined } as never });

    await expect(unavailable.editorFile('app', 'revision')).rejects.toMatchObject({ code: 'settings_applier_unavailable', statusCode: 503 });
  });
});

describe('settings save and validation', () => {
  // create an absent optional wrapper from the empty source revision
  it('saves an absent wrapper and leaves restart as an explicit follow-up', async () => {
    const current = await fixture();
    const wrapperPath = join(current.root, 'host-tmux');
    current.transport.descriptor.sources.wrapper = { path: wrapperPath, serverPath: wrapperPath, kind: 'wrapper', apply: 'rac-restart', optional: true };
    const before = source(await current.service.snapshot(), 'wrapper');
    const content = '#!/usr/bin/env bash\nexec tmux "$@"\n';
    expect(before).toMatchObject({ exists: false, writable: true });
    expect(before.content).toBeUndefined();

    const saved = await current.service.save({ changes: [{ sourceId: 'wrapper', revisionId: before.revisionId, content }] });

    expect(await readFile(wrapperPath, 'utf8')).toBe(content);
    expect(source(saved, 'wrapper')).toMatchObject({ exists: true, content });
    expect(saved.status).toMatchObject({ pending: true, targets: expect.arrayContaining(['rac']) });
    expect(current.transport.records.find(record => record.request.kind === 'commit')?.request.sources).toEqual([
      expect.objectContaining({ id: 'wrapper', existed: false, contentHash: contentHash(undefined), candidate: 'wrapper' })
    ]);
    expect(current.transport.records.some(record => record.request.kind === 'restart')).toBe(false);
  });

  // keep shortcut config durable and server-scoped without live browser preference writes
  it('saves keyboard bindings with sibling settings and preserves protected terminal commands', async () => {
    const terminal = `env PRIVATE_TOKEN=${fixtureSessionSecret} tool --full-command`;
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', keys: { prefix: { r: { terminal, reuse: true } } } } });
    await establishEffective(current);
    const snapshot = await current.service.snapshot(true, 'controller-session');
    expect(source(snapshot, 'app').value).toMatchObject({ keys: { prefix: { r: { terminal: { __racProtected: true } } } } });
    const saved = await current.service.save({ changes: [
      { sourceId: 'app', revisionId: source(snapshot, 'app').revisionId, patches: [
        { op: 'set', path: ['keys', 'prefix', 'n'], value: null },
        { op: 'set', path: ['keys', 'prefix', 'o'], value: null },
        { op: 'set', path: ['editor'], value: 'code --wait' }
      ] }
    ] }, 'controller-session');
    const persisted = JSON.parse(await readFile(current.appPath, 'utf8'));
    expect(persisted.keys.prefix).toEqual({ r: { terminal, reuse: true }, n: null, o: null });
    expect(persisted.editor).toBe('code --wait');
    expect(current.config.keys?.prefix?.n).toBeUndefined();
    expect(current.config.keys?.prefix?.r).toEqual({ terminal, reuse: true });
    expect(saved.status.pending).toBe(true);
    expect(current.transport.records.filter(record => record.request.kind === 'commit')).toHaveLength(1);
    expect(current.transport.records.some(record => record.request.kind === 'restart')).toBe(false);
  });

  // commit basic voice advanced voice and environment edits through one host transaction
  it('saves voice and environment together before applying voice live', async () => {
    const davo = vi.fn();
    const current = await fixture({
      app: { publicOrigin: 'https://agents.example.com', integrations: { realtime: { enabled: false, name: 'Davo', context: 'Before', writeToolsEnabled: false } } },
      live: { name: vi.fn(), defaultAgent: vi.fn(), davo }
    });
    await establishEffective(current);
    const snapshot = await current.service.snapshot(true, 'controller-session');
    const result = await current.service.save({ changes: [
      { sourceId: 'app', revisionId: source(snapshot, 'app').revisionId, patches: [
        { op: 'set', path: ['integrations', 'realtime', 'enabled'], value: true },
        { op: 'set', path: ['integrations', 'realtime', 'name'], value: 'Riley' },
        { op: 'set', path: ['integrations', 'realtime', 'context'], value: 'After' },
        { op: 'set', path: ['integrations', 'realtime', 'writeToolsEnabled'], value: true }
      ] },
      { sourceId: 'env', revisionId: source(snapshot, 'env').revisionId, patches: [{ op: 'set', path: ['TZ'], value: 'America/Los_Angeles' }] }
    ] }, 'controller-session');
    const commits = current.transport.records.filter(record => record.request.kind === 'commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.request.sources?.map(candidate => candidate.id)).toEqual(['app', 'env']);
    expect(JSON.parse(await readFile(current.appPath, 'utf8')).integrations.realtime).toEqual({ enabled: true, name: 'Riley', context: 'After', writeToolsEnabled: true });
    expect(await readFile(current.envPath, 'utf8')).toContain("TZ='America/Los_Angeles'");
    expect(davo).toHaveBeenCalledExactlyOnceWith({ enabled: true, name: 'Riley', context: 'After' });
    expect(result.status.pending).toBe(true);
    expect(current.transport.records.some(record => record.request.kind === 'restart')).toBe(false);
  });

  // preserve host-only application siblings across legacy name and voice writes
  it('loads host-only JSON before structured live preference edits', async () => {
    const name = vi.fn(); const davo = vi.fn();
    const current = await fixture({
      app: { publicOrigin: 'https://agents.example.com', name: 'Before', editor: 'sibling editor', integrations: { enabled: true, realtime: { enabled: false, name: 'Davo', context: 'Before context' } } },
      live: { name, defaultAgent: vi.fn(), davo }
    });
    const appSource = current.transport.descriptor.sources.app!;
    current.transport.descriptor.sources.app = { path: appSource.path, kind: appSource.kind, apply: appSource.apply };

    const before = source(await current.service.snapshot(true, 'controller-session'), 'app');
    expect(before.value).toMatchObject({ name: 'Before', editor: 'sibling editor', integrations: { realtime: { context: 'Before context' } } });

    await current.service.updateApplication([{ op: 'set', path: ['name'], value: 'After' }], 'controller-session');
    await current.service.updateApplication([
      { op: 'set', path: ['integrations', 'realtime', 'enabled'], value: true },
      { op: 'set', path: ['integrations', 'realtime', 'name'], value: 'Riley' },
      { op: 'set', path: ['integrations', 'realtime', 'context'], value: 'After context' }
    ], 'controller-session');

    const persisted = JSON.parse(await readFile(current.appPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({ name: 'After', editor: 'sibling editor', integrations: { realtime: { enabled: true, name: 'Riley', context: 'After context' } } });
    expect(name).toHaveBeenCalledExactlyOnceWith('After');
    expect(davo).toHaveBeenCalledExactlyOnceWith({ enabled: true, name: 'Riley', context: 'After context' });
  });

  // preserve every host-only dotenv sibling during one typed field edit
  it('loads host-only environment bytes before applying a typed patch', async () => {
    const current = await fixture();
    const envSource = current.transport.descriptor.sources.env!;
    current.transport.descriptor.sources.env = { path: envSource.path, kind: envSource.kind, apply: envSource.apply };
    const before = source(await current.service.snapshot(true, 'controller-session'), 'env');

    await current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, patches: [{ op: 'set', path: ['TZ'], value: 'America/Los_Angeles' }] }] }, 'controller-session');

    const persisted = await readFile(current.envPath, 'utf8');
    expect(persisted).toContain(`RAC_PASSWORD_HASH='${fixturePasswordHash}'`);
    expect(persisted).toContain(`RAC_SESSION_SECRET='${fixtureSessionSecret}'`);
    expect(persisted).toContain("TZ='America/Los_Angeles'");
  });

  // treat a blank structured value as assignment deletion only
  it('removes a cleared environment field without rewriting neighboring records', async () => {
    const env = `RAC_PASSWORD_HASH='${fixturePasswordHash}'\nRAC_SESSION_SECRET='${fixtureSessionSecret}'\n# keep this comment\nEXPLICIT_EMPTY=\nREMOVE_ME='before'\nKEEP = 'literal' # keep spacing\n`;
    const current = await fixture({ env });
    const before = source(await current.service.snapshot(), 'env');

    await current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, patches: [{ op: 'set', path: ['REMOVE_ME'], value: '' }] }] });

    expect(await readFile(current.envPath, 'utf8')).toBe(env.replace("REMOVE_ME='before'\n", ''));
  });

  // keep a missing blank field absent
  it('treats a blank structured value for a missing environment field as a byte no-op', async () => {
    const current = await fixture();
    const before = source(await current.service.snapshot(), 'env');

    await current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, patches: [{ op: 'set', path: ['MISSING_OPTIONAL'], value: '' }] }] });

    expect(await readFile(current.envPath, 'utf8')).toBe(current.env);
  });

  // retain deliberate empty assignments in the raw editor
  it('preserves explicit empty assignments in whole-source environment edits', async () => {
    const current = await fixture();
    const before = source(await current.service.snapshot(), 'env');
    const content = `${before.content}EXPLICIT_EMPTY=\n`;

    await current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, content }] });

    expect(await readFile(current.envPath, 'utf8')).toBe(`${current.env}EXPLICIT_EMPTY=\n`);
  });

  // load host-only validation dependencies while saving an unrelated source
  it('validates host-only application and environment truth for unrelated saves', async () => {
    const current = await fixture();
    const appSource = current.transport.descriptor.sources.app!; const envSource = current.transport.descriptor.sources.env!;
    current.transport.descriptor.sources.app = { path: appSource.path, kind: appSource.kind, apply: appSource.apply };
    current.transport.descriptor.sources.env = { path: envSource.path, kind: envSource.kind, apply: envSource.apply };
    const iconPath = join(current.root, 'icon.svg');
    await writeFile(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    current.transport.descriptor.sources['icon-heart'] = { path: iconPath, serverPath: iconPath, kind: 'svg', apply: 'live' };
    const before = source(await current.service.snapshot(true, 'controller-session'), 'icon-heart');

    await current.service.save({ changes: [{ sourceId: 'icon-heart', revisionId: before.revisionId, content: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>\n' }] }, 'controller-session');

    expect(await readFile(current.appPath, 'utf8')).toBe(`${JSON.stringify(current.app, null, 2)}\n`);
    expect(await readFile(current.envPath, 'utf8')).toBe(current.env);
  });

  // use exact receipt hashes for non-disclosing host-only status checks
  it('reports host-only application and environment files current after restart proof', async () => {
    const current = await fixture();
    await establishEffective(current);
    const appSource = current.transport.descriptor.sources.app!; const envSource = current.transport.descriptor.sources.env!;
    current.transport.descriptor.sources.app = { path: appSource.path, kind: appSource.kind, apply: appSource.apply };
    current.transport.descriptor.sources.env = { path: envSource.path, kind: envSource.kind, apply: envSource.apply };

    await expect(current.service.status()).resolves.toMatchObject({ pending: false, targets: [], effective: 'known' });
  });

  // preserve adjacent bytes while live-applying one explicit safe field
  it('commits a typed edit without restart and preserves visible advanced values', async () => {
    const name = vi.fn();
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', name: 'Before', editor: 'protected editor sentinel' }, live: { name, defaultAgent: vi.fn(), davo: vi.fn() } });
    await establishEffective(current);
    const before = await current.service.snapshot();
    const app = source(before, 'app');

    const saved = await current.service.save({ changes: [{ sourceId: 'app', revisionId: app.revisionId, patches: [{ op: 'set', path: ['name'], value: 'After' }] }] });
    const persisted = JSON.parse(await readFile(current.appPath, 'utf8')) as Record<string, unknown>;

    expect(persisted).toMatchObject({ name: 'After', editor: 'protected editor sentinel' });
    expect(JSON.stringify(saved)).toContain('protected editor sentinel');
    expect(name).toHaveBeenCalledExactlyOnceWith('After');
    expect(current.transport.records.map(record => record.request.kind)).toEqual(['commit']);
    expect(saved.status).toMatchObject({ pending: false, targets: [], effective: 'known' });
    await expect(stat(join(current.controlRoot, 'staging', current.transport.records[0]!.request.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // reject a stale document edit and preserve the newer manual source bytes
  it('invalidates old source and field revisions after identical-byte relocation', async () => {
    const current = await fixture();
    const before = source(await current.service.snapshot(), 'app');
    const relocated = join(current.root, 'relocated.json');
    await writeFile(relocated, await readFile(current.appPath));
    current.transport.descriptor.generation += 1;
    current.transport.descriptor.sources.app = { ...current.transport.descriptor.sources.app!, path: relocated, serverPath: relocated };
    await expect(current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path: ['name'], value: 'Stale owner edit', revisionId: before.pathRevisions?.[JSON.stringify(['name'])] }] }] })).rejects.toMatchObject({ code: 'settings_conflict', statusCode: 409 });
    expect(current.transport.records).toHaveLength(0);
  });

  // reject a stale document edit and preserve the newer manual source bytes
  it('blocks old-owner edits during a pending migration and restores edits after correction', async () => {
    const current = await fixture();
    const before = source(await current.service.snapshot(), 'app');
    const relocated = join(current.root, 'pending.json');
    await writeFile(relocated, await readFile(current.appPath));
    const desired = structuredClone(current.transport.descriptor); desired.generation += 1;
    desired.sources.app = { ...desired.sources.app!, path: relocated, serverPath: relocated };
    await writePrivate(join(current.controlRoot, 'desired-installation.json'), JSON.stringify(desired));
    const input = { changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set' as const, path: ['name'], value: 'Lost edit' }] }] };
    await expect(current.service.save(input)).rejects.toMatchObject({ code: 'source_migration_restart_required', statusCode: 409 });
    expect(current.transport.records).toHaveLength(0);
    await unlink(join(current.controlRoot, 'desired-installation.json'));
    const corrected = source(await current.service.snapshot(), 'app');
    expect(corrected.revisionId).toBe(before.revisionId);
    current.transport.failKind = 'commit';
    await expect(current.service.save({ changes: [{ ...input.changes[0]!, revisionId: corrected.revisionId }] })).rejects.toMatchObject({ code: 'settings_helper_unavailable' });
    expect(current.transport.records.at(-1)?.request.kind).toBe('commit');
  });

  // prevent env edits from disappearing into a replaced installation owner
  it.each(['compose', 'systemd'] as const)('blocks pending %s env-owner relocation but permits unchanged-owner selector corrections', async kind => {
    const current = await fixture();
    current.transport.descriptor.kind = kind;
    // identify the fixed native owner in the native fixture
    if (kind === 'systemd') current.transport.descriptor.native = { unit: 'remote-agent-console.service', environmentFile: current.envPath };
    const before = source(await current.service.snapshot(), 'env');
    const relocated = join(current.root, 'pending.env');
    await writeFile(relocated, current.env);
    const desired = structuredClone(current.transport.descriptor); desired.generation += 1;
    desired.sources.env = { ...desired.sources.env!, path: relocated, serverPath: relocated };
    // mirror the installation selector that owns the relocated file
    if (kind === 'systemd') desired.native!.environmentFile = relocated;
    else desired.compose!.envFiles = [relocated];
    await writePrivate(join(current.controlRoot, 'desired-installation.json'), JSON.stringify(desired));
    await expect(current.service.save({ changes: [{ sourceId: 'env', revisionId: before.revisionId, patches: [{ op: 'set', path: ['TZ'], value: 'Europe/London' }] }] })).rejects.toMatchObject({ code: 'source_migration_restart_required', statusCode: 409 });
    expect(current.transport.records).toHaveLength(0);
    expect(await readFile(current.envPath, 'utf8')).toBe(current.env);
    desired.sources.env = structuredClone(current.transport.descriptor.sources.env!);
    // retain a pending app selector without moving its dotenv owner
    desired.sources.app = { ...desired.sources.app!, path: join(current.root, 'pending-app.json') };
    await writePrivate(join(current.controlRoot, 'desired-installation.json'), JSON.stringify(desired));
    const unchangedOwner = source(await current.service.snapshot(), 'env');
    current.transport.failKind = 'commit';
    await expect(current.service.save({ changes: [{ sourceId: 'env', revisionId: unchangedOwner.revisionId, patches: [{ op: 'set', path: ['RAC_CONFIG'], value: current.appPath }] }] })).rejects.toMatchObject({ code: 'settings_helper_unavailable' });
    expect(current.transport.records.at(-1)?.request.kind).toBe('commit');
  });

  // reject a stale document edit and preserve the newer manual source bytes
  it('fails a stale whole-document revision without invoking the helper', async () => {
    const current = await fixture();
    const before = await current.service.snapshot();
    const app = source(before, 'app');
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, name: 'Manual edit' }, null, 2)}\n`);

    await expect(current.service.save({ changes: [{ sourceId: 'app', revisionId: app.revisionId, patches: [{ op: 'set', path: ['listen', 'port'], value: 9191 }] }] })).rejects.toMatchObject({ code: 'settings_conflict', statusCode: 409 });
    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ name: 'Manual edit' });
    expect(current.transport.records).toHaveLength(0);
  });

  // merge a disjoint safe path only when its opaque path revision still matches
  it('rebases a safe field over an unrelated external edit', async () => {
    const name = vi.fn();
    const current = await fixture({ live: { name, defaultAgent: vi.fn(), davo: vi.fn() } });
    const before = await current.service.snapshot();
    const app = source(before, 'app');
    const nameRevision = app.pathRevisions?.[JSON.stringify(['name'])];
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, listen: { host: '127.0.0.1', port: 9191 } }, null, 2)}\n`);

    await current.service.save({ changes: [{ sourceId: 'app', revisionId: app.revisionId, patches: [{ op: 'set', path: ['name'], value: 'Merged name', revisionId: nameRevision }] }] });

    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ name: 'Merged name', listen: { host: '127.0.0.1', port: 9191 } });
    expect(name).toHaveBeenCalledExactlyOnceWith('Merged name');
  });

  // do not rebase indexed capabilities onto a different equal-valued row
  it('rejects a stale collection field after equal-valued rows are reordered', async () => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', projects: [{ id: 'one', label: 'Same', path: '/tmp/one' }, { id: 'two', label: 'Same', path: '/tmp/two' }] } });
    const before = source(await current.service.snapshot(), 'app');
    const path = ['projects', '0', 'label'];
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, projects: [...current.app.projects as unknown[]].reverse() }, null, 2)}\n`);
    await expect(current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path, value: 'Wrong row', revisionId: before.pathRevisions?.[JSON.stringify(path)] }] }] })).rejects.toMatchObject({ code: 'settings_conflict', statusCode: 409 });
    expect(current.transport.records).toHaveLength(0);
  });

  // omit authored blank optional project fields without touching adjacent values
  it('removes blank optional Project fields and prunes only authored empty containers', async () => {
    const current = await fixture({ app: {
      publicOrigin: 'https://agents.example.com',
      projects: [{ id: 'one', path: '/tmp/one', label: 'One', commands: { start: 'pnpm dev' }, worktreeOverrides: [{ path: 'feature', commands: { start: 'pnpm feature' } }] }]
    } });
    const before = source(await current.service.snapshot(), 'app');

    await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [
      { op: 'set', path: ['projects', '0', 'label'], value: '' },
      { op: 'set', path: ['projects', '0', 'commands', 'start'], value: '' },
      { op: 'set', path: ['projects', '0', 'worktreeOverrides', '0', 'commands', 'start'], value: '' }
    ] }] });

    const project = (JSON.parse(await readFile(current.appPath, 'utf8')) as { projects: Record<string, unknown>[] }).projects[0]!;
    expect(project).not.toHaveProperty('label');
    expect(project).not.toHaveProperty('commands');
    expect(project).toMatchObject({ worktreeOverrides: [{ path: 'feature', commands: {} }] });
  });

  // preserve file-only preview fields during unrelated structured project edits
  it('preserves Project and Worktree preview selectors hidden from the editor', async () => {
    const project = { id: 'one', path: '/tmp/one', hostname: 'one.example.test', port: 3000, worktreeOverrides: [{ path: 'feature', hostname: 'feature.example.test', port: 3001 }] };
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', projects: [project] } });
    const before = (await current.service.snapshot()).sources.find(source => source.id === 'app')!;
    await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path: ['projects', '0', 'label'], value: 'Renamed' }] }] });
    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ projects: [{ ...project, label: 'Renamed' }] });
  });

  // create the optional project collection only when its first row is authored
  it('inserts the first Project into an absent collection', async () => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com' } });
    const before = source(await current.service.snapshot(), 'app');

    await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [
      { op: 'insert', path: ['projects'], value: { id: 'one', path: '/tmp/one', label: '' } }
    ] }] });

    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ projects: [{ id: 'one', path: '/tmp/one' }] });
  });

  // prune a process map only after deleting its final authored member
  it('rejects explicit empty Processes but saves deletion of the final process', async () => {
    const current = await fixture({ app: {
      publicOrigin: 'https://agents.example.com',
      projects: [{ id: 'one', path: '/tmp/one', commands: { processes: { web: 'pnpm dev' } } }]
    } });
    const before = source(await current.service.snapshot(), 'app');
    const invalid = await current.service.validate({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [
      { op: 'set', path: ['projects', '0', 'commands', 'processes'], value: {} }
    ] }] });

    expect(invalid).toMatchObject({ valid: false, issues: [expect.objectContaining({ path: ['projects', '0', 'commands', 'processes'] })] });
    await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [
      { op: 'remove', path: ['projects', '0', 'commands', 'processes', 'web'] }
    ] }] });

    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ projects: [{ id: 'one', path: '/tmp/one' }] });
    expect((JSON.parse(await readFile(current.appPath, 'utf8')) as { projects: Record<string, unknown>[] }).projects[0]).not.toHaveProperty('commands');
  });

  // surface forged project row selectors instead of accepting a blank no-op
  it('rejects blank edits addressed to a missing Project row', async () => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', projects: [{ id: 'one', path: '/tmp/one' }] } });
    const before = source(await current.service.snapshot(), 'app');
    const result = await current.service.validate({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [
      { op: 'set', path: ['projects', '999', 'label'], value: '' }
    ] }] });

    expect(result).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: 'invalid_settings_patch' })] });
  });

  // retain blank legacy values and sparse defaults outside the exact authored path
  it('preserves untouched Project blanks, order, and omitted defaults', async () => {
    const current = await fixture({ app: {
      publicOrigin: 'https://agents.example.com',
      projects: [
        { id: 'one', path: '/tmp/one', label: '' },
        { id: 'two', path: '/tmp/two' }
      ]
    } });
    const before = source(await current.service.snapshot(), 'app');

    await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path: ['projects', '1', 'label'], value: 'Second' }] }] });

    const projects = (JSON.parse(await readFile(current.appPath, 'utf8')) as { projects: Record<string, unknown>[] }).projects;
    expect(projects).toEqual([
      { id: 'one', path: '/tmp/one', label: '' },
      { id: 'two', path: '/tmp/two', label: 'Second' }
    ]);
    expect(projects[1]).not.toHaveProperty('push');
  });

  // retain scalar zero and fail required project blanks instead of silently restoring old values
  it.each([
    { path: ['projects', '0', 'path'], value: '' },
    { path: ['projects', '0', 'port'], value: 0 }
  ])('keeps invalid required or numeric Project input for validation at $path', async ({ path, value }) => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', projects: [{ id: 'one', path: '/tmp/one' }] } });
    const before = source(await current.service.snapshot(), 'app');
    const result = await current.service.validate({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path, value }] }] });

    expect(result).toMatchObject({ valid: false, issues: [expect.objectContaining({ sourceId: 'app', path })] });
    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ projects: [{ id: 'one', path: '/tmp/one' }] });
  });

  // explain reserved project names only for rejected attempts and never write them
  it.each(['agent', 'scratch'])('reports a field error instead of saving reserved Project ID %s', async id => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', projects: [{ id: 'one', path: '/tmp/one' }] } });
    const before = source(await current.service.snapshot(), 'app');
    const original = await readFile(current.appPath, 'utf8');
    const input = { changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set' as const, path: ['projects', '0', 'id'], value: id }] }] };
    const issues = [{ sourceId: 'app', path: ['projects', '0', 'id'], code: 'custom', message: 'Project IDs “agent” and “scratch” are reserved. Choose another ID.' }];

    expect(await current.service.validate(input)).toEqual({ valid: false, issues });
    await expect(current.service.save(input)).rejects.toMatchObject({ code: 'invalid_settings', issues });
    expect(await readFile(current.appPath, 'utf8')).toBe(original);
    expect(current.transport.records).toHaveLength(0);
    expect(await current.service.validate({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path: ['projects', '0', 'id'], value: `${id}-tools` }] }] })).toEqual({ valid: true, issues: [] });
  });

  // leave expert json normalization and formatting entirely under the author's control
  it('preserves blank optional Project fields in raw expert JSON saves', async () => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', projects: [{ id: 'one', path: '/tmp/one', label: '' }] } });
    const before = source(await current.service.snapshot(), 'app');
    const content = `${JSON.stringify({ publicOrigin: 'https://agents.example.com', name: 'Raw save', projects: [{ id: 'one', path: '/tmp/one', label: '' }] }, null, 2)}\n`;

    await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, content }] });

    expect(await readFile(current.appPath, 'utf8')).toBe(content);
  });

  // permit blind protected replacement at the current document revision but never accept mask text
  it('blind-replaces a protected scalar without disclosure and rejects placeholders', async () => {
    const current = await fixture({ app: { publicOrigin: 'https://agents.example.com', editor: 'old protected editor' } });
    const before = await current.service.snapshot();
    await current.service.save({ changes: [{ sourceId: 'app', revisionId: source(before, 'app').revisionId, patches: [{ op: 'set', path: ['editor'], value: 'new protected editor' }] }] });
    expect(JSON.parse(await readFile(current.appPath, 'utf8'))).toMatchObject({ editor: 'new protected editor' });

    const refreshed = await current.service.snapshot();
    const requests = current.transport.records.length;
    await expect(current.service.save({ changes: [{ sourceId: 'app', revisionId: source(refreshed, 'app').revisionId, patches: [{ op: 'set', path: ['editor'], value: '••••••' }] }] })).rejects.toMatchObject({ code: 'invalid_settings_value' });
    expect(current.transport.records).toHaveLength(requests);
  });

  // return field-safe validation issues without publishing invalid candidates
  it('rejects prototype paths and invalid application values before host validation', async () => {
    const current = await fixture();
    const before = await current.service.snapshot();
    const revisionId = source(before, 'app').revisionId;

    await expect(current.service.validate({ changes: [{ sourceId: 'app', revisionId, patches: [{ op: 'set', path: ['__proto__', 'polluted'], value: true }] }] })).resolves.toMatchObject({ valid: false, issues: [expect.objectContaining({ code: 'invalid_settings_patch' })] });
    await expect(current.service.validate({ changes: [{ sourceId: 'app', revisionId, patches: [{ op: 'set', path: ['listen', 'port'], value: 70_000 }] }] })).resolves.toMatchObject({ valid: false, issues: expect.arrayContaining([expect.objectContaining({ sourceId: 'app', path: ['listen', 'port'] })]) });
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(current.transport.records).toHaveLength(0);
  });

  // preserve helper-attributed handover owners instead of guessing the first edit
  it('returns every scoped migration-required issue from host validation', async () => {
    const current = await fixture();
    const before = await current.service.snapshot();
    const issues = [
      { sourceId: 'env', path: [], code: 'migration_required', message: 'Source handover is required before saving.' },
      { sourceId: 'app', path: [], code: 'migration_required', message: 'Source handover is required before saving.' }
    ];
    current.transport.failKind = 'validate';
    current.transport.failError = new SettingsError('migration_required', 400, issues);
    await expect(current.service.validate({ changes: [
      { sourceId: 'app', revisionId: source(before, 'app').revisionId, patches: [{ op: 'set', path: ['name'], value: 'After' }] },
      { sourceId: 'env', revisionId: source(before, 'env').revisionId, patches: [{ op: 'set', path: ['TZ'], value: 'America/Los_Angeles' }] }
    ] })).resolves.toEqual({ valid: false, issues });
  });

  // retain both required browser authentication credentials during rotation
  it('rejects deleting either required authentication credential', async () => {
    const passwordHash = await argon2.hash('fixture password', { type: argon2.argon2id });
    const sessionSecret = Buffer.alloc(32, 71).toString('base64url');
    const required = ['RAC_PASSWORD_HASH', 'RAC_SESSION_SECRET'];

    // validate each independently missing credential
    for (const key of required) {
      const current = await fixture({ env: `RAC_PASSWORD_HASH='${passwordHash}'\nRAC_SESSION_SECRET='${sessionSecret}'\n` });
      const before = await current.service.snapshot();
      const result = await current.service.validate({ changes: [{ sourceId: 'env', revisionId: source(before, 'env').revisionId, patches: [{ op: 'remove', path: [key] }] }] });
      expect(result).toMatchObject({ valid: false });
      expect(await readFile(current.envPath, 'utf8')).toContain(`${key}=`);
    }
  });

  // reject blank structured clears of required authentication too
  it('rejects clearing either required authentication credential', async () => {
    const required = ['RAC_PASSWORD_HASH', 'RAC_SESSION_SECRET'];
    // validate each independently cleared credential
    for (const key of required) {
      const current = await fixture();
      const before = await current.service.snapshot();
      const result = await current.service.validate({ changes: [{ sourceId: 'env', revisionId: source(before, 'env').revisionId, patches: [{ op: 'set', path: [key], value: '' }] }] });
      expect(result).toMatchObject({ valid: false });
      expect(await readFile(current.envPath, 'utf8')).toBe(current.env);
    }
  });

  // preserve authoritative bytes when the fixed host commit boundary fails
  it('retains helper-owned plaintext stages across running wait timeouts', async () => {
    // check both validation and commit publication ownership
    for (const kind of ['validate', 'commit'] as const) {
      const current = await fixture();
      current.transport.pendingKind = kind;
      const before = source(await current.service.snapshot(), 'app');
      const input = { changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set' as const, path: ['name'], value: 'Pending candidate' }] }] };
      await expect(kind === 'validate' ? current.service.validate(input) : current.service.save(input)).rejects.toMatchObject({ code: 'settings_helper_pending' });
      const id = current.transport.records.at(-1)!.request.id;
      expect(await readFile(join(current.controlRoot, 'staging', id, 'app'), 'utf8')).toContain('Pending candidate');
    }
  });

  // preserve authoritative bytes when the fixed host commit boundary fails
  it('surfaces helper commit failure without modifying the source or launching restart', async () => {
    const current = await fixture({ live: { name: vi.fn(), defaultAgent: vi.fn(), davo: vi.fn() } });
    const beforeBytes = await readFile(current.appPath, 'utf8');
    const before = await current.service.snapshot();
    current.transport.failKind = 'commit';

    await expect(current.service.save({ changes: [{ sourceId: 'app', revisionId: source(before, 'app').revisionId, patches: [{ op: 'set', path: ['name'], value: 'Not committed' }] }] })).rejects.toMatchObject({ code: 'settings_helper_unavailable', statusCode: 503 });
    expect(await readFile(current.appPath, 'utf8')).toBe(beforeBytes);
    await expect(stat(join(current.controlRoot, 'staging', current.transport.records.at(-1)!.request.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(current.transport.records.map(record => record.request.kind)).toEqual(['commit']);
  });
});

describe('settings pending and restart state', () => {
  // persist Docker changes as restart-pending without running Compose on save
  it('requires an explicit restart after saving a Docker override', async () => {
    const current = await fixture();
    const path = join(current.root, 'compose.override.yaml');
    const before = 'services:\n  remote-agent-console:\n    environment:\n      TZ: UTC\n';
    const after = before.replace('UTC', 'Europe/London');
    await writePrivate(path, before);
    current.transport.descriptor.sources['compose-override'] = { path, serverPath: path, kind: 'compose', apply: 'rac-restart' };
    await establishEffective(current);
    const effectivePath = join(current.controlRoot, 'effective.json');
    const effective = JSON.parse(await readFile(effectivePath, 'utf8'));
    effective.targets.rac.hashes['compose-override'] = contentHash(before);
    await writePrivate(effectivePath, JSON.stringify(effective));
    const snapshot = await current.service.snapshot(true, 'controller-session');
    expect(snapshot.status.pending).toBe(false);

    const saved = await current.service.save({ changes: [{ sourceId: 'compose-override', revisionId: source(snapshot, 'compose-override').revisionId, content: after }] }, 'controller-session');

    expect(await readFile(path, 'utf8')).toBe(after);
    expect(saved.status).toMatchObject({ pending: true, targets: ['rac'], restartAvailable: true });
    await expect(current.service.status()).resolves.toMatchObject({ pending: true, targets: ['rac'] });
    expect(current.transport.records.filter(record => record.request.kind === 'commit')).toHaveLength(1);
    expect(current.transport.records.some(record => record.request.kind === 'restart')).toBe(false);
  });

  // file-backed icon readers consume saved bytes without replacing RAC
  it('does not require restart for immediately served SVG assets', async () => {
    const current = await fixture();
    const icon = join(current.root, 'icon.svg');
    await writeFile(icon, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    current.transport.descriptor.sources['icon-heart'] = { path: icon, serverPath: icon, kind: 'svg', apply: 'live' };
    await establishEffective(current);
    const before = source(await current.service.snapshot(), 'icon-heart');
    const saved = await current.service.save({ changes: [{ sourceId: 'icon-heart', revisionId: before.revisionId, content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>' }] });
    expect(saved.status).toMatchObject({ pending: false, targets: [], effective: 'known' });
    expect(await readFile(icon, 'utf8')).toContain('circle');
  });

  // fixed Compose values do not make shadowed dotenv edits restart-bound
  it('compares only independently proven file-owned environment values', async () => {
    const current = await fixture();
    await establishEffective(current);
    const path = join(current.controlRoot, 'effective.json');
    const proof = JSON.parse(await readFile(path, 'utf8'));
    proof.targets.rac.environmentFileHashes = { RAC_PASSWORD_HASH: contentHash(fixturePasswordHash), RAC_SESSION_SECRET: contentHash(fixtureSessionSecret), TZ: contentHash('UTC') };
    proof.targets.rac.shadowedEnvironmentKeys = ['TZ'];
    await writePrivate(path, JSON.stringify(proof));
    await writeFile(current.envPath, current.env.replace('TZ=UTC', 'TZ=America/Los_Angeles'));
    await expect(current.service.status()).resolves.toMatchObject({ pending: false, targets: [], effective: 'known' });
    proof.targets.rac.shadowedEnvironmentKeys = [];
    await writePrivate(path, JSON.stringify(proof));
    await expect(current.service.status()).resolves.toMatchObject({ pending: true, targets: ['rac'] });
  });

  // report an unproved first-run baseline as unknown and pending
  it('keeps restart pending until exact effective evidence matches every consumed source', async () => {
    const current = await fixture();

    await expect(current.service.status()).resolves.toMatchObject({ pending: true, targets: ['rac'], effective: 'unknown', restartAvailable: true });
    await establishEffective(current);
    await expect(current.service.status()).resolves.toMatchObject({ pending: false, targets: [], effective: 'known', restartAvailable: true });
  });

  // detect manual restart-bound drift and clear it only after exact reversion
  it('detects external source changes and clears pending after reversion', async () => {
    const current = await fixture();
    const original = await readFile(current.appPath, 'utf8');
    await establishEffective(current);
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, listen: { host: '127.0.0.1', port: 9191 } }, null, 2)}\n`);

    await expect(current.service.status()).resolves.toMatchObject({ pending: true, targets: ['rac'], effective: 'known' });
    await writeFile(current.appPath, original);
    await expect(current.service.status()).resolves.toMatchObject({ pending: false, targets: [], effective: 'known' });
  });

  // manual live changes need proof while dormant changes have no running effect
  it('marks unapplied live edits pending but ignores saved-only manual edits', async () => {
    const current = await fixture();
    await establishEffective(current);
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, name: 'Manual live name', proxy: { trustedSourceIps: ['192.0.2.10'] } }, null, 2)}\n`);
    await expect(current.service.status()).resolves.toMatchObject({ pending: true, targets: ['rac'], effective: 'known' });
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, proxy: { trustedSourceIps: ['192.0.2.10'] } }, null, 2)}\n`);
    await expect(current.service.status()).resolves.toMatchObject({ pending: false, targets: [], effective: 'known' });
  });

  // preserve a restart requirement when a durable live edit cannot refresh runtime state
  it('does not invent live proof when saving a dormant field after an external live edit', async () => {
    const current = await fixture();
    await establishEffective(current);
    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, name: 'Unconsumed external name' }, null, 2)}\n`);
    const before = source(await current.service.snapshot(), 'app');
    const saved = await current.service.save({ changes: [{ sourceId: 'app', revisionId: before.revisionId, patches: [{ op: 'set', path: ['proxy', 'trustedSourceIps'], value: ['127.0.0.1'] }] }] });
    expect(saved.status).toMatchObject({ pending: true, targets: ['rac'], effective: 'known' });
  });

  // preserve a restart requirement when a durable live edit cannot refresh runtime state
  it('marks a committed live edit pending when its callback fails', async () => {
    const current = await fixture();
    await establishEffective(current);
    const before = await current.service.snapshot();

    const saved = await current.service.save({ changes: [{ sourceId: 'app', revisionId: source(before, 'app').revisionId, patches: [{ op: 'set', path: ['name'], value: 'Saved but not live' }] }] });

    expect(saved.status).toMatchObject({ pending: true, targets: ['rac'], effective: 'known' });
    expect(await readFile(join(current.controlRoot, 'live-pending.json'), 'utf8')).not.toContain('Saved but not live');
  });

  // clear prior callback failure only after a later durable live refresh succeeds
  it('clears stale live-pending evidence after a successful live callback', async () => {
    const current = await fixture();
    await establishEffective(current);
    const before = await current.service.snapshot();
    await current.service.save({ changes: [{ sourceId: 'app', revisionId: source(before, 'app').revisionId, patches: [{ op: 'set', path: ['name'], value: 'Saved but not live' }] }] });
    const recovered = new SettingsService(current.config, { controlRoot: current.controlRoot, transport: current.transport, configPath: current.appPath, checkout: current.root, live: { name: vi.fn(), defaultAgent: vi.fn(), davo: vi.fn() } });
    const failedSnapshot = await recovered.snapshot();

    const saved = await recovered.save({ changes: [{ sourceId: 'app', revisionId: source(failedSnapshot, 'app').revisionId, patches: [{ op: 'set', path: ['name'], value: 'Now live' }] }] });

    expect(saved.status).toMatchObject({ pending: false, targets: [], effective: 'known' });
  });

  // queue only the fixed pending targets and publish durable operation discovery
  it('queues a fixed restart without accepting commands or service names', async () => {
    const current = await fixture();

    const operation = await current.service.restart();

    expect(operation).toMatchObject({ state: 'queued' });
    expect(operation.id).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(current.transport.records).toHaveLength(1);
    expect(current.transport.records[0]).toMatchObject({ wait: false, request: { version: 1, id: operation.id, kind: 'restart', generation: 1, targets: ['rac'] } });
    expect(Object.keys(current.transport.records[0]!.request).sort()).toEqual(['generation', 'id', 'kind', 'sources', 'targets', 'version']);
    await expect(current.service.status()).resolves.toMatchObject({ operation: { id: operation.id, state: 'queued' } });
  });

  // expose only the exact watchdog-backed restart progress envelope
  it('projects valid restart progress and drops malformed metadata', async () => {
    const current = await fixture();
    const id = 'restart_progress_status01';
    const restart = { recoveryDeadline: 1_800_000_000_000, state: 'restarting' } as const;
    await writePrivate(join(current.controlRoot, 'latest-deploy.json'), JSON.stringify({ id, kind: 'restart', state: 'running' }));
    await writePrivate(join(current.controlRoot, 'status', `${id}.json`), JSON.stringify({ version: 1, id, kind: 'restart', state: 'running', phase: 'restarting', restart }));

    await expect(current.service.status()).resolves.toMatchObject({ operation: { id, state: 'running', phase: 'restarting', restart } });
    await expect(current.service.operation(id)).resolves.toEqual({ id, state: 'running', phase: 'restarting', restart });

    await writePrivate(join(current.controlRoot, 'status', `${id}.json`), JSON.stringify({ version: 1, id, kind: 'restart', state: 'failed', error: 'apply-failed', restart: { ...restart, state: 'recovered', extra: 'untrusted' } }));
    await expect(current.service.status()).resolves.toMatchObject({ operation: { id, state: 'failed', error: 'apply-failed' } });
    await expect(current.service.status()).resolves.not.toHaveProperty('operation.restart');
    await expect(current.service.operation(id)).resolves.toEqual({ id, state: 'failed', error: 'apply-failed' });
  });

  // coalesce repeated clicks onto the durable active operation
  it('reuses an already queued restart for the same pending state', async () => {
    const current = await fixture();

    const first = await current.service.restart();
    const second = await current.service.restart();

    expect(second).toEqual(first);
    expect(current.transport.records.map(record => record.request.kind)).toEqual(['restart']);
  });

  // launch nothing when no target is pending or when the host helper rejects the request
  it('rejects unnecessary and failed restarts without false durable success', async () => {
    const current = await fixture();
    await establishEffective(current);
    await expect(current.service.restart()).rejects.toMatchObject({ code: 'settings_restart_not_pending', statusCode: 409 });
    expect(current.transport.records).toHaveLength(0);

    await writeFile(current.appPath, `${JSON.stringify({ ...current.app, listen: { host: '127.0.0.1', port: 9191 } }, null, 2)}\n`);
    current.transport.failKind = 'restart';
    await expect(current.service.restart()).rejects.toMatchObject({ code: 'settings_helper_unavailable', statusCode: 503 });
    expect(current.transport.records.map(record => record.request.kind)).toEqual(['restart']);
    await expect(readFile(join(current.controlRoot, 'latest-deploy.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
