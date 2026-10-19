import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostReply, HostRequest, Installation, RevealEnvelope } from '../src/settings/contracts.js';
import { readBounded, writePrivate } from '../src/settings/files.js';
import { HostSettingsTransport, settingsControlRoot } from '../src/settings/transport.js';

const roots: string[] = [];

// remove each isolated settings control fixture
afterEach(async () => {
  // clear every fixture created by the current test
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// create one private isolated control root
async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-settings-security-'));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

// build a minimum versioned installation descriptor
function installation(root: string, override: Partial<Installation> = {}): Installation {
  return {
    version: 1,
    installationId: 'isolated-settings-test',
    generation: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    kind: 'compose',
    hostCheckout: root,
    hostControlRoot: root,
    serverCheckout: root,
    allowedRoots: [root],
    sources: {
      app: { path: join(root, 'config.json'), serverPath: join(root, 'config.json'), kind: 'json', apply: 'rac-restart' }
    },
    compose: { projectDirectory: root, projectName: 'isolated-settings-test', files: [join(root, 'compose.yaml')], envFiles: [], profiles: [] },
    ...override
  };
}

// encrypt one host response for the exact ephemeral request binding
function encryptedReply(request: HostRequest, plaintext: string, mutate: Partial<RevealEnvelope> = {}): HostReply {
  // require a reveal envelope fixture
  if (request.reveal === undefined) throw new Error('expected reveal request');
  const sender = generateKeyPairSync('x25519');
  const recipient = createPublicKey({ key: Buffer.from(request.reveal.publicKey, 'base64url'), type: 'spki', format: 'der' });
  const secret = diffieHellman({ privateKey: sender.privateKey, publicKey: recipient });
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const info = Buffer.concat([Buffer.from('rac-settings-reveal/v1'), createHash('sha256').update(request.reveal.binding).digest()]);
  const derived = Buffer.from(hkdfSync('sha256', secret, salt, info, 32));
  const cipher = createCipheriv('aes-256-gcm', derived, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(request.reveal.binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope: RevealEnvelope = {
    version: 1,
    publicKey: sender.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    binding: request.reveal.binding,
    expiresAt: request.reveal.expiresAt,
    ...mutate
  };
  secret.fill(0);
  derived.fill(0);
  return { version: 1, id: request.id, kind: request.kind, state: 'complete', response: envelope };
}

describe('settings private files', () => {
  // publish replacement metadata with private permissions
  it('writes private files atomically with mode 0600', async () => {
    const root = await fixtureRoot();
    const path = join(root, 'nested', 'state.json');

    await writePrivate(path, '{"revision":1}');
    await writePrivate(path, '{"revision":2}');

    expect(await readFile(path, 'utf8')).toBe('{"revision":2}');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, 'nested'))).mode & 0o777).toBe(0o700);
  });

  // accept bounded regular text and reject final symlinks or exposed private files
  it('reads only bounded regular utf8 files through the selected path', async () => {
    const root = await fixtureRoot();
    const publicPath = join(root, 'public.txt');
    const privatePath = join(root, 'private.txt');
    const aliasPath = join(root, 'alias.txt');
    await writeFile(publicPath, 'visible\n');
    await writeFile(privatePath, 'private\n', { mode: 0o600 });
    await symlink(publicPath, aliasPath);

    expect(await readBounded(publicPath)).toBe('visible\n');
    expect(await readBounded(privatePath, false, true)).toBe('private\n');
    await chmod(privatePath, 0o644);
    await expect(readBounded(privatePath, false, true)).rejects.toThrowError('settings_source_unavailable');
    await expect(readBounded(aliasPath)).rejects.toThrowError('settings_source_unavailable');
    await expect(readBounded(join(root, 'missing.txt'), true)).resolves.toBeUndefined();
  });

  // refuse binary and excessive source documents
  it('rejects invalid utf8, nul bytes, and oversized files', async () => {
    const root = await fixtureRoot();
    const invalid = join(root, 'invalid');
    const nul = join(root, 'nul');
    const excessive = join(root, 'excessive');
    await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await writeFile(nul, Buffer.from('before\0after'));
    await writeFile(excessive, Buffer.alloc(1_048_577, 0x61));

    await expect(readBounded(invalid)).rejects.toThrowError('settings_source_unavailable');
    await expect(readBounded(nul)).rejects.toThrowError('settings_source_unavailable');
    await expect(readBounded(excessive)).rejects.toThrowError('settings_source_unavailable');
  });
});

describe('settings host transport', () => {
  // resolve only an explicit fixed command-line locator
  it('selects the fixed control root without interpreting adjacent arguments', () => {
    expect(settingsControlRoot([])).toBe('/run/rac-settings-control');
    expect(settingsControlRoot(['--other', 'value', '--settings-control', '/private/control', '--later'])).toBe('/private/control');
    expect(settingsControlRoot(['--settings-control'])).toBe('/run/rac-settings-control');
  });

  // accept a private descriptor for the current uid and reject incompatible authority
  it('loads only a private versioned current-user installation descriptor', async () => {
    const root = await fixtureRoot();
    const descriptor = join(root, 'installation.json');
    await writeFile(descriptor, JSON.stringify(installation(root)), { mode: 0o600 });
    const transport = new HostSettingsTransport(root, 20);

    await expect(transport.installation()).resolves.toMatchObject({ version: 1, generation: 1, installationId: 'isolated-settings-test' });
    await writeFile(descriptor, JSON.stringify(installation(root, { generation: 0 })), { mode: 0o600 });
    await expect(transport.installation()).rejects.toThrowError('settings_installation_invalid');
    await writeFile(descriptor, JSON.stringify(installation(root, { uid: process.getuid() + 1 })), { mode: 0o600 });
    await expect(transport.installation()).rejects.toThrowError('settings_installation_invalid');
    await chmod(descriptor, 0o644);
    await expect(transport.installation()).rejects.toThrowError('settings_source_unavailable');
  });

  // reject malformed selectors before they can become server-side file reads
  it('rejects malformed installation source shapes and uncataloged selectors', async () => {
    const root = await fixtureRoot();
    const descriptor = join(root, 'installation.json');
    const transport = new HostSettingsTransport(root, 20);
    const malformed = [
      { ...installation(root), sources: [] },
      { ...installation(root), sources: { arbitrary: { path: join(root, 'arbitrary'), kind: 'env', apply: 'rac-restart' } } },
      { ...installation(root), sources: { app: { path: 'relative/config.json', kind: 'json', apply: 'rac-restart' } } },
      { ...installation(root), sources: { app: { path: join(root, 'config.json'), kind: 'executable', apply: 'rac-restart' } } },
      { ...installation(root), sources: { app: { path: join(root, 'config.json'), kind: 'json', apply: 'execute-command' } } },
      { ...installation(root), sources: { app: { path: join(root, 'config.json'), kind: 'json', apply: 'rac-restart', command: '/bin/false' } } },
      { ...installation(root), kind: 'systemd', compose: undefined, native: { unit: 'arbitrary.service', environmentFile: join(root, '.env') } }
    ];

    // check every independently invalid descriptor
    for (const candidate of malformed) {
      await writeFile(descriptor, JSON.stringify(candidate), { mode: 0o600 });
      await expect(transport.installation()).rejects.toThrowError('settings_installation_invalid');
    }
  });

  // keep descriptor-selected files within a declared absolute installation root
  it('rejects lexical source and checkout escapes from allowed roots', async () => {
    const root = await fixtureRoot();
    const descriptor = join(root, 'installation.json');
    const transport = new HostSettingsTransport(root, 20);
    const outside = join(root, '..', 'outside-settings-source');
    const escapedSource = installation(root, {
      sources: { app: { path: outside, serverPath: outside, kind: 'json', apply: 'rac-restart' } }
    });
    await writeFile(descriptor, JSON.stringify(escapedSource), { mode: 0o600 });
    await expect(transport.installation()).rejects.toThrowError('settings_installation_invalid');

    const escapedCheckout = installation(root, { hostCheckout: outside });
    await writeFile(descriptor, JSON.stringify(escapedCheckout), { mode: 0o600 });
    await expect(transport.installation()).rejects.toThrowError('settings_installation_invalid');

    const relativeRoot = installation(root, { allowedRoots: ['relative/root'] });
    await writeFile(descriptor, JSON.stringify(relativeRoot), { mode: 0o600 });
    await expect(transport.installation()).rejects.toThrowError('settings_installation_invalid');
  });

  // queue only canonical operation identifiers and private request envelopes
  it('publishes asynchronous requests privately and rejects invalid operation ids', async () => {
    const root = await fixtureRoot();
    const transport = new HostSettingsTransport(root, 20);
    const request: HostRequest = { version: 1, id: 'abcdefghijklmnopqrstuvwx', kind: 'restart', generation: 1, targets: ['rac'] };

    await expect(transport.request(request, false)).resolves.toMatchObject({ id: request.id, kind: 'restart', state: 'queued' });
    const queued = join(root, 'queued', `${request.id}.json`);
    expect(JSON.parse(await readFile(queued, 'utf8'))).toEqual(request);
    expect((await lstat(queued)).mode & 0o777).toBe(0o600);
    await expect(transport.request({ ...request, id: '../invalid' }, false)).rejects.toThrowError('invalid_settings_operation');
  });

  // accept only a matching terminal reply for the queued operation
  it('waits for the exact matching terminal host reply', async () => {
    const root = await fixtureRoot();
    const transport = new HostSettingsTransport(root, 20);
    const id = 'matchingterminalreply01';
    const request: HostRequest = { version: 1, id, kind: 'validate', generation: 2, sources: [] };
    await mkdir(join(root, 'status'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'status', `${id}.json`), JSON.stringify({ version: 1, id, kind: 'validate', state: 'complete' }), { mode: 0o600 });

    await expect(transport.request(request)).resolves.toMatchObject({ id, kind: 'validate', state: 'complete' });
    await writeFile(join(root, 'status', `${id}.json`), JSON.stringify({ version: 1, id, kind: 'commit', state: 'complete' }), { mode: 0o600 });
    await expect(transport.request(request)).rejects.toThrowError('settings_helper_invalid');
  });

  // convert only scoped migration requirements into field-safe validation issues
  it('maps scoped migration failures and rejects unscoped or malformed metadata', async () => {
    const root = await fixtureRoot();
    const transport = new HostSettingsTransport(root, 20);
    await mkdir(join(root, 'status'), { recursive: true, mode: 0o700 });
    const sources = [
      { id: 'app', contentHash: 'a'.repeat(64), candidate: 'app' },
      { id: 'env', contentHash: 'b'.repeat(64), candidate: 'env' }
    ];
    // build one exact validation request identity
    const request = (id: string): HostRequest => ({ version: 1, id, kind: 'validate', generation: 1, sources });
    // publish one private helper failure for the request
    const status = async (id: string, errorMetadata?: unknown) => {
      await writeFile(join(root, 'status', `${id}.json`), JSON.stringify({ version: 1, id, kind: 'validate', state: 'failed', error: 'migration-required', ...(errorMetadata === undefined ? {} : { errorMetadata }) }), { mode: 0o600 });
    };
    const scopedId = 'scopedmigrationreply001';
    await status(scopedId, { sourceIds: ['env', 'app'] });
    await expect(transport.request(request(scopedId))).rejects.toMatchObject({
      code: 'migration_required',
      statusCode: 400,
      issues: [
        { sourceId: 'env', path: [], code: 'migration_required', message: 'Source handover is required before saving.' },
        { sourceId: 'app', path: [], code: 'migration_required', message: 'Source handover is required before saving.' }
      ]
    });
    const malformed = [
      undefined,
      { sourceIds: [] },
      { sourceIds: ['env', 'env'] },
      { sourceIds: ['compose'] },
      { sourceIds: ['env'], path: '/private/config' }
    ];
    // reject every legacy, duplicate, foreign, or overbroad envelope
    for (const [index, metadata] of malformed.entries()) {
      const id = `invalidmigrationreply${String(index).padStart(2, '0')}`;
      await status(id, metadata);
      await expect(transport.request(request(id))).rejects.toMatchObject({ code: 'settings_helper_invalid', statusCode: 503 });
    }
  });

  // decrypt only an authenticated response bound to the ephemeral request
  it('consumes identity inspection statuses without accumulating poll artifacts', async () => {
    const root = await fixtureRoot();
    await writePrivate(join(root, 'installation.json'), JSON.stringify(installation(root)));
    const transport = new HostSettingsTransport(root, 20);
    const paths: string[] = [];
    transport.request = async request => {
      const path = join(root, 'status', `${request.id}.json`); paths.push(path);
      await writePrivate(path, '{}');
      return { version: 1, id: request.id, kind: request.kind, state: 'complete', sourceMetadata: { sourceId: 'app', contentHash: 'a'.repeat(64), existed: true } };
    };
    // every routine poll consumes its private one-shot result
    for (let index = 0; index < 3; index += 1) await transport.inspect('app');
    // none of the consumed identities survives in durable status storage
    for (const path of paths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // decrypt only an authenticated response bound to the ephemeral request
  it('reads a host-only source through an authenticated ephemeral envelope', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'installation.json'), JSON.stringify(installation(root, {
      sources: { env: { path: join(root, '.env'), kind: 'env', apply: 'rac-restart' } }
    })), { mode: 0o600 });
    const transport = new HostSettingsTransport(root, 20);
    const sentinel = 'RAC_SESSION_SECRET=not-written-to-control-root\n';
    transport.request = async request => encryptedReply(request, sentinel);

    await expect(transport.read('env', { bootNonce: 'synthetic_boot_nonce_00001', sessionBinding: 's'.repeat(43), revisionId: 'r'.repeat(43), contentHash: 'a'.repeat(64), existed: true })).resolves.toBe(sentinel);
    expect(await readFile(join(root, 'installation.json'), 'utf8')).not.toContain(sentinel);
  });

  // reject a replayed binding and remove its one-shot status envelope
  it('rejects substituted reveal envelopes and deletes the terminal response', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'installation.json'), JSON.stringify(installation(root, {
      sources: { env: { path: join(root, '.env'), kind: 'env', apply: 'rac-restart' } }
    })), { mode: 0o600 });
    await mkdir(join(root, 'status'), { recursive: true, mode: 0o700 });
    const transport = new HostSettingsTransport(root, 20);
    let statusPath = '';
    transport.request = async request => {
      statusPath = join(root, 'status', `${request.id}.json`);
      await writeFile(statusPath, '{}', { mode: 0o600 });
      return encryptedReply(request, 'secret', { binding: 'substituted-binding' });
    };

    await expect(transport.read('env', { bootNonce: 'synthetic_boot_nonce_00001', sessionBinding: 's'.repeat(43), revisionId: 'r'.repeat(43), contentHash: 'a'.repeat(64), existed: true })).rejects.toThrowError('settings_reveal_unavailable');
    await expect(lstat(statusPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
