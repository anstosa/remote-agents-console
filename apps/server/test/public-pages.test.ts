import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { ControlService } from '../src/auth/control.js';
import { testAuthService, testHost } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

describe('public publication pages', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let control: ControlService;
  let readSession: ReturnType<typeof vi.spyOn>;
  let claimControl: ReturnType<typeof vi.spyOn>;

  // retain another controller while exercising anonymous document access
  beforeEach(async () => {
    const auth = await testAuthService();
    control = new ControlService();
    await control.take('another-browser');
    readSession = vi.spyOn(auth, 'unsign');
    claimControl = vi.spyOn(control, 'connect');
    vi.stubEnv('RAC_GOOGLE_CALENDAR_CLIENT_SECRET', 'private-oauth-secret-marker');
    vi.stubEnv('RAC_GOOGLE_CALENDAR_TOKEN_KEY', 'private-token-key-marker');
    app = await buildApp(testConfig({ name: 'private-instance-name-marker' }), { auth, control });
  });

  // release each isolated server without changing installation credentials
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // publish complete documents without reading authentication or acquiring control
  it.each([
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Service']
  ])('serves %s to an anonymous reader while another browser controls RAC', async (url, title) => {
    const response = await app.inject({ method: 'GET', url, headers: { host: testHost, cookie: '__Host-rac=invalid' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.body).toContain('<!doctype html>');
    expect(response.body).toContain('<html lang="en">');
    expect(response.body).toContain(`<h1>${title}</h1>`);
    expect(response.body).toContain('Remote Agent Console');
    expect(response.body).toContain('href="/privacy"');
    expect(response.body).toContain('href="/terms"');
    expect(response.body).not.toMatch(/<script|private-oauth-secret-marker|private-token-key-marker|private-instance-name-marker|client_secret|Take control/iu);
    expect(readSession).not.toHaveBeenCalled();
    expect(claimControl).not.toHaveBeenCalled();
    expect(control.ownerSessionId()).toBe('another-browser');
  });

  // permit header-only verification without a session cookie or origin header
  it.each(['/privacy', '/terms'])('serves anonymous HEAD requests to %s', async url => {
    const response = await app.inject({ method: 'HEAD', url, headers: { host: testHost } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe('');
    expect(readSession).not.toHaveBeenCalled();
    expect(claimControl).not.toHaveBeenCalled();
  });

  // disclose actual calendar access and avoid promising deletion of retained records
  it('publishes the Google data purpose, limited use and deletion controls', async () => {
    const response = await app.inject({ method: 'GET', url: '/privacy', headers: { host: testHost } });
    expect(response.body).toContain('calendar.app.created');
    expect(response.body).toContain('Google API Services User Data Policy');
    expect(response.body).toContain('Limited Use');
    expect(response.body).toContain('encrypted');
    expect(response.body).toContain('Disconnect');
    expect(response.body).toContain('https://myaccount.google.com/permissions');
    expect(response.body).toContain('30 days');
    expect(response.body).toContain('instance administrator');
  });

  // make the descriptive homepage and policy links discoverable before javascript runs
  it('includes a public product description and legal links in the homepage HTML source', async () => {
    const source = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
    expect(source).toMatch(/<h1[^>]*>Remote Agent Console<\/h1>/u);
    expect(source).toContain('Google Calendar');
    expect(source).toContain('Run agents');
    expect(source).toContain('Manage repositories');
    expect(source).toContain('account ID and email');
    expect(source).toContain('encrypted access and refresh tokens');
    expect(source).toContain('calendar.app.created');
    expect(source).toContain('href="#login"');
    expect(source).toContain('href="/privacy"');
    expect(source).toContain('href="/terms"');
    expect(source).toMatch(/<noscript>[\s\S]*<main[\s\S]*<\/main>[\s\S]*<\/noscript>/u);
  });

  // show a real public error document without reflecting untrusted urls or claiming control
  it.each(['/404', '/missing/deep/page', '/privacy/missing?private=private-query-marker'])('serves a public HTML 404 for %s', async url => {
    const response = await app.inject({ method: 'GET', url, headers: { host: testHost, accept: 'text/html,application/xhtml+xml', cookie: '__Host-rac=invalid' } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toContain('<!doctype html>');
    expect(response.body).toContain('<h1>404 — Page not found</h1>');
    expect(response.body).toContain('<a href="/">Return to console</a>');
    expect(response.body).toContain('href="/privacy"');
    expect(response.body).toContain('href="/terms"');
    expect(response.body).not.toMatch(/<script|<form|private-query-marker|private-oauth-secret-marker|private-token-key-marker|private-instance-name-marker|client_secret|Take control/iu);
    expect(readSession).not.toHaveBeenCalled();
    expect(claimControl).not.toHaveBeenCalled();
    expect(control.ownerSessionId()).toBe('another-browser');
  });

  // preserve status and headers for browser-style header-only probes
  it.each(['text/html', 'application/json'])('serves an empty 404 for an unknown HEAD request accepting %s', async accept => {
    const headers = { host: testHost, accept };
    const response = await app.inject({ method: 'HEAD', url: '/missing', headers });
    const get = await app.inject({ method: 'GET', url: '/missing', headers });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(accept);
    expect(response.headers['content-length']).toBe(get.headers['content-length']);
    expect(response.body).toBe('');
  });

  // accept positive HTML quality values and case-insensitive media ranges
  it.each(['text/html;q=0.5', 'TEXT/HTML; Q=0.8'])('serves an HTML 404 for Accept %s', async accept => {
    const response = await app.inject({ method: 'GET', url: '/missing', headers: { host: testHost, accept } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<h1>404 — Page not found</h1>');
  });

  // keep machine requests and unknown API routes out of the HTML page renderer
  it.each([
    ['GET', '/missing', 'application/json'],
    ['GET', '/assets/missing.js', '*/*'],
    ['GET', '/assets/missing.js', 'text/html'],
    ['GET', '/fonts/missing.woff2', 'text/html'],
    ['GET', '/missing', 'application/json, text/html;q=0'],
    ['GET', '/missing', 'text/html;q=0.000'],
    ['GET', '/missing', undefined],
    ['GET', '/api/missing', 'text/html'],
    ['GET', '/api?unknown=true', 'text/html'],
    ['POST', '/missing', 'text/html']
  ] as const)('preserves JSON 404s for %s %s with Accept %s', async (method, url, accept) => {
    // omit absent headers rather than sending the string undefined
    const response = await app.inject({ method, url, headers: { host: testHost, ...(accept === undefined ? {} : { accept }) } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'not found' });
  });

  // keep origin validation and private API authentication unchanged
  it('does not turn public documents into an authentication bypass', async () => {
    const wrongHost = await app.inject({ method: 'GET', url: '/privacy', headers: { host: 'untrusted.example' } });
    expect(wrongHost.statusCode).toBe(403);
    const privateApi = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: testHost } });
    expect(privateApi.statusCode).toBe(401);
    const unknownHost = await app.inject({ method: 'GET', url: '/missing', headers: { host: 'untrusted.example', accept: 'text/html' } });
    expect(unknownHost.statusCode).toBe(403);
    expect(control.ownerSessionId()).toBe('another-browser');
  });
});
