import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarService } from '../src/google-calendar/runtime.js';
import type { GoogleCalendarConfig } from '../src/google-calendar/contracts.js';
import { exchangeAuthorizationCode, OAuthTransactions } from '../src/google-calendar/oauth.js';
import { AuthStore } from '../src/google-calendar/store.js';
import type { GoogleAuthState } from '../src/google-calendar/provider-types.js';
import { parseTokenKey } from '../src/google-calendar/crypto.js';
import { tempDir } from './helpers/codex-fixtures.js';

const config: GoogleCalendarConfig = { enabled: true, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' };

// sign one synthetic google oidc token
function idToken(clientId: string, nonce: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], kid: string, mutation: { header?: Record<string, unknown>; claims?: Record<string, unknown>; badSignature?: boolean } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, ...mutation.header })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId, sub: 'stable-subject', email: 'user@example.com', nonce, exp: Math.floor(Date.now() / 1_000) + 600, ...mutation.claims })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey);
  // change valid signature bytes without breaking compact jwt encoding
  if (mutation.badSignature) signature[0] = (signature[0] ?? 0) ^ 1;
  return `${header}.${claims}.${signature.toString('base64url')}`;
}

// cover pkce state and callback authority fences
describe('Google Calendar OAuth', () => {
  // reject every account-binding failure before publishing any authorization material
  it.each([
    ['algorithm', { header: { alg: 'HS256' } }],
    ['key id', { header: { kid: 'unknown-key' } }],
    ['signature', { badSignature: true }],
    ['issuer', { claims: { iss: 'https://untrusted.example.test' } }],
    ['audience', { claims: { aud: 'other-client' } }],
    ['multiple audiences', { claims: { aud: ['client', 'other-client'] } }],
    ['empty audience', { claims: { aud: [] } }],
    ['nonce', { claims: { nonce: 'wrong-nonce' } }],
    ['missing subject', { claims: { sub: undefined } }],
    ['empty subject', { claims: { sub: '' } }],
    ['oversized subject', { claims: { sub: 's'.repeat(256) } }],
    ['subject controls', { claims: { sub: 'private\nsubject' } }],
    ['expired token', { claims: { exp: 0 } }],
    ['invalid expiry type', { claims: { exp: 'not a number' } }],
    ['future not-before', { claims: { nbf: Math.floor(Date.now() / 1_000) + 600 } }]
  ] as const)('rejects an invalid %s and leaves authorization unpublished', async (_name, mutation) => {
    const directory = await tempDir('rac-google-calendar-');
    const authPath = join(directory, 'auth.json');
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let nonce = '';
    // expose only local synthetic exchange and signing-key responses
    const fetcher = vi.fn(async (input: string | URL) => {
      // return one token with exactly the selected invalid identity property
      if (String(input).includes('/token')) return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, id_token: idToken('client', nonce, pair.privateKey, 'key', mutation) }), { status: 200 });
      return new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256', use: 'sig' }] }), { status: 200 });
    });
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-client-secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: `active:${randomBytes(32).toString('base64url')}` }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const authorization = new URL(service.beginConnect('session', 'generation'));
    nonce = authorization.searchParams.get('nonce')!;
    await expect(service.completeConnect({ sessionId: 'session', reservationGeneration: 'generation', code: 'code', state: authorization.searchParams.get('state')!, reservationGenerationOf: () => 'generation', renewReservation: () => true, isSessionValid: () => true })).rejects.toMatchObject({ code: 'oauth_transaction_invalid' });
    expect(service.summary().connected).toBe(false);
    await expect(readFile(authPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  // only an active same-principal lineage may supply an omitted renewable grant
  it.each(['new', 'disconnected', 'active', 'foreign', 'empty'] as const)('requires a renewable grant for the %s connection', async scenario => {
    const directory = await tempDir('rac-google-calendar-renewable-');
    const authPath = join(directory, 'auth.json');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let nonce = '';
    const hasPrior = scenario !== 'new' && scenario !== 'empty';
    // retain the original durable lineage when a replacement callback cannot authorize
    if (hasPrior) {
      const prior: GoogleAuthState = { version: 1, clientId: 'client', principal: { sub: scenario === 'foreign' ? 'other-subject' : 'stable-subject' }, tokens: scenario === 'disconnected' ? { accessToken: '', expiresAt: 0 } : { accessToken: 'prior-access', refreshToken: 'prior-refresh', expiresAt: Date.now() + 3_600_000 }, calendars: [], ...(scenario === 'disconnected' ? { disconnected: true } : {}) };
      await new AuthStore(authPath, parseTokenKey(keyText)).save(prior);
    }
    const before = await readFile(authPath, 'utf8').catch(() => undefined);
    const fetcher = vi.fn(async (input: string | URL) => {
      // omit the grant deliberately while keeping all OIDC identity evidence valid
      if (String(input).includes('/token')) return new Response(JSON.stringify({ access_token: 'new-access', ...(scenario === 'empty' ? { refresh_token: '' } : {}), expires_in: 3600, id_token: idToken('client', nonce, pair.privateKey, 'key') }), { status: 200 });
      return new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256', use: 'sig' }] }), { status: 200 });
    });
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const authorization = new URL(service.beginConnect('session', 'generation'));
    nonce = authorization.searchParams.get('nonce')!;
    const completion = service.completeConnect({ sessionId: 'session', reservationGeneration: 'generation', code: 'code', state: authorization.searchParams.get('state')!, reservationGenerationOf: () => 'generation', renewReservation: () => true, isSessionValid: () => true });
    // an already-active exact identity retains its prior offline grant
    if (scenario === 'active') {
      await expect(completion).resolves.toBeUndefined();
      expect((await new AuthStore(authPath, parseTokenKey(keyText)).load())?.tokens).toMatchObject({ accessToken: 'new-access', refreshToken: 'prior-refresh' });
    } else {
      await expect(completion).rejects.toMatchObject({ code: 'authorization_required' });
      expect(await readFile(authPath, 'utf8').catch(() => undefined)).toBe(before);
      expect(service.summary().connected).toBe(scenario === 'foreign');
    }
  });

  // recover a token-free lineage even when remote revocation did not succeed
  it.each([true, false])('reconnects after rejected revocation only with a fresh grant: %s', async freshGrant => {
    const directory = await tempDir('rac-google-calendar-reconsent-');
    const authPath = join(directory, 'auth.json');
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calendars = [{ id: 'app-calendar', name: 'RAC Work' }];
    await new AuthStore(authPath, parseTokenKey(keyText)).save({ version: 1, clientId: 'client', principal: { sub: 'stable-subject' }, tokens: { accessToken: 'prior-access', refreshToken: 'prior-refresh', expiresAt: Date.now() + 3_600_000 }, calendars, selectedCalendarId: 'app-calendar' });
    let nonce = '';
    const fetcher = vi.fn(async (input: string | URL) => {
      // keep the remote grant alive while local disconnect still removes its tokens
      if (String(input).includes('/revoke')) return new Response('{}', { status: 500 });
      // model both a renewed grant and a provider that still omits it
      if (String(input).includes('/token')) return new Response(JSON.stringify({ access_token: 'new-access', ...(freshGrant ? { refresh_token: 'new-refresh' } : {}), expires_in: 3600, id_token: idToken('client', nonce, pair.privateKey, 'key') }), { status: 200 });
      return new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256', use: 'sig' }] }), { status: 200 });
    });
    const options = { config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath, activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch };
    const authority = { sessionId: 'session', reservationGeneration: 'generation', reservationGenerationOf: () => 'generation', renewReservation: () => true, isSessionValid: () => true };
    const first = await createGoogleCalendarService(options);
    await expect(first.disconnect(authority)).resolves.toMatchObject({ connected: false, calendars, selectedCalendarId: 'app-calendar' });
    expect(fetcher).toHaveBeenCalledOnce();
    const before = await readFile(authPath, 'utf8');
    expect((await new AuthStore(authPath, parseTokenKey(keyText)).load())?.tokens).toEqual({ accessToken: '', expiresAt: 0 });
    const restarted = await createGoogleCalendarService(options);
    const authorization = new URL(restarted.beginConnect('session', 'generation'));
    expect(authorization.searchParams.get('prompt')).toBe('consent select_account');
    nonce = authorization.searchParams.get('nonce')!;
    const completion = restarted.completeConnect({ ...authority, code: 'code', state: authorization.searchParams.get('state')! });
    // preserve the registry while publishing only genuinely renewable credentials
    if (freshGrant) {
      await expect(completion).resolves.toBeUndefined();
      expect(restarted.summary()).toMatchObject({ connected: true, calendars, selectedCalendarId: 'app-calendar' });
      expect((await new AuthStore(authPath, parseTokenKey(keyText)).load())?.tokens).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    } else {
      await expect(completion).rejects.toMatchObject({ code: 'authorization_required' });
      expect(restarted.summary().connected).toBe(false);
      expect(await readFile(authPath, 'utf8')).toBe(before);
    }
  });

  // emit only the selected least-privilege scope and consume state once
  it('builds exact pkce authorization and rejects replay', () => {
    const transactions = new OAuthTransactions();
    const begun = transactions.begin({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://agents.example.com/callback', clientGeneration: 'generation' }, 'session', 'reservation', 1_000);
    const url = new URL(begun.url);
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.app.created');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    expect(transactions.consume(begun.transaction.state, 2_000).sessionId).toBe('session');
    expect(() => transactions.consume(begun.transaction.state, 2_000)).toThrow('oauth_transaction_invalid');
  });

  // cap live consent state and reclaim every expired transaction
  it('bounds and prunes oauth transactions', () => {
    const transactions = new OAuthTransactions();
    const oauth = { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://agents.example.com/callback', clientGeneration: 'generation' };
    for (let index = 0; index < 128; index += 1) {
      // fill only the documented live transaction capacity
      transactions.begin(oauth, 'session', 'generation', 1_000);
    }
    expect(() => transactions.begin(oauth, 'session', 'generation', 1_000)).toThrow('oauth_transaction_capacity');
    expect(() => transactions.begin(oauth, 'session', 'generation', 601_001)).not.toThrow();
  });

  // cancel oversized oauth bodies before complete buffering
  it('bounds streamed oauth token responses', async () => {
    const oauth = { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://agents.example.com/callback', clientGeneration: 'generation' };
    const transaction = new OAuthTransactions().begin(oauth, 'session', 'generation', 1_000).transaction;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      // emit bounded chunks until the parser cancels
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
      // record early stream cancellation
      cancel() { cancelled = true; }
    });
    await expect(exchangeAuthorizationCode(oauth, transaction, 'code', (async () => new Response(oversized, { status: 200 })) as typeof fetch, 1_000)).rejects.toThrow('google_unavailable');
    expect(cancelled).toBe(true);
  });

  // accept long consent only while the exact session generation remains reserved
  it('publishes encrypted credentials after repeated exact authority fences', async () => {
    const directory = await tempDir('rac-google-calendar-');
    const clientId = 'client.apps.googleusercontent.com';
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'signing-key';
    let nonce = '';
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      // return the synthetic token exchange
      if (url.includes('/token')) return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, id_token: idToken(clientId, nonce, pair.privateKey, kid) }), { status: 200 });
      // return the exact signing key
      if (url.includes('/certs')) return new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }), { status: 200 });
      throw new Error('unexpected request');
    });
    const keyText = `active:${randomBytes(32).toString('base64url')}`;
    let now = 1_000;
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: clientId, RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: keyText }, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch, now: () => now });
    const authorization = new URL(service.beginConnect('session', 'generation'));
    nonce = authorization.searchParams.get('nonce')!;
    now += 20_000;
    const generation = () => 'generation';
    await service.completeConnect({ sessionId: 'session', reservationGeneration: 'generation', code: 'authorization-code', state: authorization.searchParams.get('state')!, reservationGenerationOf: generation, renewReservation: () => true, isSessionValid: () => true });
    expect(service.summary()).toMatchObject({ connected: true, accountEmail: 'user@example.com' });
    expect(JSON.stringify(service.summary())).not.toMatch(/access-secret|refresh-secret|stable-subject|client-secret/);
    const restored = await new AuthStore(join(directory, 'auth.json'), parseTokenKey(keyText)).load();
    expect(restored).toMatchObject({ clientId, principal: { sub: 'stable-subject', email: 'user@example.com' }, tokens: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: now + 3_600_000 } });
    expect(await readFile(join(directory, 'auth.json'), 'utf8')).not.toMatch(/access-secret|refresh-secret|stable-subject|client-secret/);
  });

  // stop after token exchange when a takeover displaces the initiating generation
  it('consumes state and blocks publication after mid-callback takeover', async () => {
    const directory = await tempDir('rac-google-calendar-');
    let resolveToken!: (response: Response) => void;
    const token = new Promise<Response>(resolve => { resolveToken = resolve; });
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes('/token') ? await token : new Response('{}', { status: 500 }));
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: 'client', RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: `active:${randomBytes(32).toString('base64url')}` }, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const authorization = new URL(service.beginConnect('session', 'old'));
    let generation = 'old';
    const completion = service.completeConnect({ sessionId: 'session', reservationGeneration: 'old', code: 'code', state: authorization.searchParams.get('state')!, reservationGenerationOf: () => generation, renewReservation: (_session, expected) => generation === expected, isSessionValid: () => true });
    generation = 'new';
    resolveToken(new Response(JSON.stringify({ access_token: 'secret', id_token: 'secret', expires_in: 3600 }), { status: 200 }));
    await expect(completion).rejects.toThrow('oauth_authority_lost');
    expect(service.summary().connected).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(service.completeConnect({ sessionId: 'session', reservationGeneration: 'old', code: 'code', state: authorization.searchParams.get('state')!, reservationGenerationOf: () => 'old', renewReservation: () => true, isSessionValid: () => true })).rejects.toThrow('oauth_transaction_invalid');
  });

  // recheck authority after jwks retrieval and before encrypted staging
  it.each(['takeover', 'logout'])('blocks publication after %s during oidc validation', async boundary => {
    const directory = await tempDir('rac-google-calendar-');
    const clientId = 'client';
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'kid';
    let nonce = '';
    let resolveJwks!: (response: Response) => void;
    const jwks = new Promise<Response>(resolve => { resolveJwks = resolve; });
    const fetcher = vi.fn(async (input: string | URL) => {
      // return tokens before holding signing-key validation
      if (String(input).includes('/token')) return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, id_token: idToken(clientId, nonce, pair.privateKey, kid) }), { status: 200 });
      return await jwks;
    });
    const service = await createGoogleCalendarService({ config, publicOrigin: 'https://agents.example.com', env: { RAC_GOOGLE_CALENDAR_CLIENT_ID: clientId, RAC_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', RAC_GOOGLE_CALENDAR_TOKEN_KEY: `active:${randomBytes(32).toString('base64url')}` }, authPath: join(directory, 'auth.json'), activitiesPath: join(directory, 'activities.json'), fetch: fetcher as typeof fetch });
    const authorization = new URL(service.beginConnect('session', 'old'));
    nonce = authorization.searchParams.get('nonce')!;
    let generation = 'old';
    let valid = true;
    const completion = service.completeConnect({ sessionId: 'session', reservationGeneration: 'old', code: 'code', state: authorization.searchParams.get('state')!, reservationGenerationOf: () => generation, renewReservation: (_session, expected) => generation === expected, isSessionValid: () => valid });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    // revoke only the selected authority fact while provider work is held
    if (boundary === 'takeover') generation = 'new';
    else valid = false;
    resolveJwks(new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }), { status: 200 }));
    await expect(completion).rejects.toMatchObject({ code: 'oauth_authority_lost' });
    expect(service.summary().connected).toBe(false);
    await expect(readFile(join(directory, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
