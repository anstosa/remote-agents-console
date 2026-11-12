import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { instanceIconSvg } from '../src/instance-icon.js';
import { testConfig } from './helpers/config.js';
import { authenticatedHeaders, testAuthService, testHost, testOrigin } from './helpers/auth.js';

const firstFixture = '<svg data-fixture="first"></svg>\n';
const secondFixture = '<svg data-fixture="second"></svg>\n';
const firstFixtureHash = 'UHjj4_P0alhL5LClf1RYKMVFO6-7jyXV7YSxpIM6cBc';
const peerSecret = 'shared-status-secret-with-thirty-two-bytes';
// sign one peer request as another server would for the named surface
const peerHeaders = (label: string) => {
  const timestamp = String(Date.now());
  return { host: testHost, 'x-rac-status-timestamp': timestamp, 'x-rac-status-signature': createHmac('sha256', peerSecret).update(`${label}\n${testOrigin}\n${timestamp}`).digest('base64url') };
};
// bypass auth for public icon routes
const auth = { unsign: () => undefined, get: () => undefined } as never;
let app: FastifyInstance;
let root: string | undefined;
let iconDirectory: string;

// build against one isolated private icon directory
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rac-instance-icon-routes-'));
  const configPath = join(root, 'config', 'server.yaml');
  iconDirectory = join(root, 'config', 'instance-icons');
  await mkdir(iconDirectory, { recursive: true });
  await writeFile(configPath, 'name: synthetic\n');
  await writeFile(join(iconDirectory, 'heart.svg'), firstFixture);
  await writeFile(join(iconDirectory, 'potato.svg'), secondFixture);
  vi.stubEnv('RAC_CONFIG', configPath);
  app = await buildApp(testConfig({ icon: 'heart' }), { auth });
});

// release app and filesystem state
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  // remove only the test-owned directory
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

// preserve icon serving and host boundaries
describe('instance icon routes', () => {
  // serve configured and aliased private files unchanged
  it('serves the favicon and custom aliases byte-for-byte on the canonical host', async () => {
    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: testHost } });
    const firstAlias = await app.inject({ method: 'GET', url: '/instance-icons/heart.svg', headers: { host: testHost } });
    const secondAlias = await app.inject({ method: 'GET', url: '/instance-icons/potato.svg', headers: { host: testHost } });

    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['content-type']).toContain('image/svg+xml');
    expect(favicon.body).toBe(firstFixture);
    expect(firstAlias.statusCode).toBe(200);
    expect(firstAlias.body).toBe(firstFixture);
    expect(secondAlias.statusCode).toBe(200);
    expect(secondAlias.body).toBe(secondFixture);
  });

  // fall back for unavailable private files on both routes
  it('serves the generic icon when custom assets are missing', async () => {
    await rm(join(iconDirectory, 'heart.svg'));
    await rm(join(iconDirectory, 'potato.svg'));

    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: testHost } });
    const alias = await app.inject({ method: 'GET', url: '/instance-icons/potato.svg', headers: { host: testHost } });

    expect(favicon.statusCode).toBe(200);
    expect(favicon.body).toBe(instanceIconSvg());
    expect(alias.statusCode).toBe(200);
    expect(alias.body).toBe(instanceIconSvg());
  });

  // hide local paths while surfacing unreadable artwork
  it('returns a stable error when a custom asset cannot be read', async () => {
    await rm(join(iconDirectory, 'heart.svg'));
    await mkdir(join(iconDirectory, 'heart.svg'));

    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: testHost } });
    const alias = await app.inject({ method: 'GET', url: '/instance-icons/heart.svg', headers: { host: testHost } });

    expect(favicon.statusCode).toBe(500);
    expect(favicon.json()).toEqual({ error: 'icon unavailable' });
    expect(alias.statusCode).toBe(500);
    expect(alias.json()).toEqual({ error: 'icon unavailable' });
  });

  // serve any library file by name and the portable fallback for an absent one
  it('serves any named library icon and falls back for an absent name', async () => {
    const thirdFixture = '<svg data-fixture="third"></svg>\n';
    await writeFile(join(iconDirectory, 'rocket-2.svg'), thirdFixture);

    const added = await app.inject({ method: 'GET', url: '/instance-icons/rocket-2.svg', headers: { host: testHost } });
    const absent = await app.inject({ method: 'GET', url: '/instance-icons/absent.svg', headers: { host: testHost } });

    expect(added.statusCode).toBe(200);
    expect(added.body).toBe(thirdFixture);
    expect(absent.statusCode).toBe(200);
    expect(absent.body).toBe(instanceIconSvg());
  });

  // keep requests inside the library directory
  it('returns not found for a name outside the library pattern', async () => {
    await writeFile(join(iconDirectory, '..', 'x.svg'), firstFixture);

    for (const url of ['/instance-icons/..%2Fx.svg', '/instance-icons/Upper.svg', '/instance-icons/under_score.svg']) {
      const response = await app.inject({ method: 'GET', url, headers: { host: testHost } });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toEqual({ error: 'icon unavailable' });
    }
  });

  // publish the library only to signed-in browsers
  it('lists the icon library for an authenticated browser', async () => {
    const authenticated = await buildApp(testConfig({ icon: 'heart' }), { auth: await testAuthService() });
    try {
      const anonymous = await authenticated.inject({ method: 'GET', url: '/api/instance-icons', headers: { host: testHost } });
      const { host, cookie } = await authenticatedHeaders(authenticated);
      const listed = await authenticated.inject({ method: 'GET', url: '/api/instance-icons', headers: { host, cookie } });

      expect(anonymous.statusCode).toBe(401);
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ icons: [{ name: 'terminal' }, { name: 'heart' }, { name: 'potato' }] });
    } finally {
      await authenticated.close();
    }
  });

  // publish the chosen artwork to signed peers only
  it('announces the chosen artwork hash in status and serves the artwork to a peer signed for it', async () => {
    vi.stubEnv('RAC_INSTANCE_STATUS_SECRET', peerSecret);
    const publisher = await buildApp(testConfig({ icon: 'heart' }), { auth, discovery: { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] }) } as never });
    try {
      const status = await publisher.inject({ method: 'GET', url: '/api/instance-status', headers: peerHeaders('rac-instance-status-v1') });
      const artwork = await publisher.inject({ method: 'GET', url: '/api/instance-icon', headers: peerHeaders('rac-instance-icon-v1') });
      const statusSigned = await publisher.inject({ method: 'GET', url: '/api/instance-icon', headers: peerHeaders('rac-instance-status-v1') });
      const unsigned = await publisher.inject({ method: 'GET', url: '/api/instance-icon', headers: { host: testHost } });

      expect(status.json()).toEqual({ name: 'Remote Agents', icon: 'heart', iconHash: firstFixtureHash, attention: 'idle' });
      expect(artwork.statusCode).toBe(200);
      expect(artwork.headers['content-type']).toContain('image/svg+xml');
      expect(artwork.body).toBe(firstFixture);
      expect(statusSigned.statusCode).toBe(401);
      expect(unsigned.statusCode).toBe(401);
    } finally {
      await publisher.close();
    }
  });

  // viewers built before the icon library reject a whole identity whose icon is not one of their three names
  it('names the chosen icon in status only when older viewers know that name', async () => {
    vi.stubEnv('RAC_INSTANCE_STATUS_SECRET', peerSecret);
    await writeFile(join(iconDirectory, 'rocket-2.svg'), firstFixture);
    const publisher = await buildApp(testConfig({ icon: 'rocket-2' }), { auth, discovery: { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] }) } as never });
    try {
      const status = await publisher.inject({ method: 'GET', url: '/api/instance-status', headers: peerHeaders('rac-instance-status-v1') });

      expect(status.json()).toEqual({ name: 'Remote Agents', iconHash: firstFixtureHash, attention: 'idle' });
    } finally {
      await publisher.close();
    }
  });

  // an unreadable icon file must not take the status channel down with it
  it('keeps answering status without a hash when the chosen artwork cannot be read', async () => {
    vi.stubEnv('RAC_INSTANCE_STATUS_SECRET', peerSecret);
    await rm(join(iconDirectory, 'heart.svg'));
    await mkdir(join(iconDirectory, 'heart.svg'));
    const publisher = await buildApp(testConfig({ icon: 'heart' }), { auth, discovery: { worktreesNow: () => [], dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] }) } as never });
    try {
      const status = await publisher.inject({ method: 'GET', url: '/api/instance-status', headers: peerHeaders('rac-instance-status-v1') });

      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ name: 'Remote Agents', icon: 'heart', attention: 'idle' });
    } finally {
      await publisher.close();
    }
  });

  // serve verified peer artwork under this origin's isolated icon policy
  it('serves cached peer artwork by hash and the terminal icon for an unknown one', async () => {
    const peerArtwork = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
    const viewer = await buildApp(testConfig(), { auth, instanceStatusPoller: { statuses: async () => [], artwork: hash => hash === firstFixtureHash ? peerArtwork : undefined } });
    try {
      const cached = await viewer.inject({ method: 'GET', url: `/instance-icons/remote/${firstFixtureHash}.svg`, headers: { host: testHost } });
      const unknown = await viewer.inject({ method: 'GET', url: `/instance-icons/remote/${'A'.repeat(43)}.svg`, headers: { host: testHost } });
      const malformed = await viewer.inject({ method: 'GET', url: '/instance-icons/remote/..%2Fheart.svg', headers: { host: testHost } });

      expect(cached.statusCode).toBe(200);
      expect(cached.headers['content-type']).toContain('image/svg+xml');
      expect(cached.headers['content-security-policy']).toContain('sandbox');
      expect(cached.body).toBe(peerArtwork);
      expect(unknown.statusCode).toBe(200);
      expect(unknown.body).toBe(instanceIconSvg());
      expect(malformed.statusCode).toBe(404);
    } finally {
      await viewer.close();
    }
  });

  // preserve the canonical host boundary
  it('forbids favicon and alias requests from another host', async () => {
    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg', headers: { host: 'other.example.com' } });
    const alias = await app.inject({ method: 'GET', url: '/instance-icons/heart.svg', headers: { host: 'other.example.com' } });

    expect(favicon.statusCode).toBe(403);
    expect(alias.statusCode).toBe(403);
  });
});
