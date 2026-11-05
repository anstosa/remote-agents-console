import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IntegrationAuthService,
  supportedIntegrationScopes,
  type AuthorizationRequest,
  type OAuthResult,
  type RegisteredPublicClient
} from '../src/integrations/auth/index.js';

const issuer = 'https://console.example.test';
const resource = 'https://console.example.test/mcp';
const chatGptCallback = 'https://chatgpt.com/connector/oauth/callback';
const directories: string[] = [];

// extract one successful OAuth result
function valueOf<T>(result: OAuthResult<T>): T {
  expect(result.ok).toBe(true);
  // fail the test with the typed OAuth detail
  if (!result.ok) throw new Error(`${result.error}: ${result.error_description}`);
  return result.value;
}

// build one deterministic PKCE challenge
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// register the standard public test client
async function register(service: IntegrationAuthService): Promise<RegisteredPublicClient> {
  return valueOf(await service.registerClient({ client_name: 'ChatGPT', redirect_uris: [chatGptCallback] }));
}

// issue one valid authorization code
async function authorize(service: IntegrationAuthService, client: RegisteredPublicClient, verifier: string, scopes = 'status:read logs:read') {
  const request: AuthorizationRequest = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: chatGptCallback,
    resource,
    scope: scopes,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'chatgpt-state'
  };
  return await service.authorize(request, { id: 'local-user' });
}

// remove isolated auth stores
afterEach(async () => {
  // clean each test directory
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// exercise the isolated OAuth service
describe('integration OAuth authentication', () => {
  // verify metadata and public DCR boundaries
  it('publishes OAuth metadata and registers only public clients with HTTPS callbacks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-integration-auth-dcr-'));
    directories.push(directory);
    const file = join(directory, 'auth.json');
    const service = new IntegrationAuthService({ issuer, resource, stateFile: file });

    expect(service.protectedResourceMetadata()).toEqual({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: supportedIntegrationScopes,
      resource_name: 'Remote Agent Console MCP'
    });
    expect(service.authorizationServerMetadata()).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    });

    expect(await service.registerClient(null as never)).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await service.registerClient({ redirect_uris: [chatGptCallback], grant_types: 'authorization_code' } as never)).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await service.registerClient({ redirect_uris: ['http://chatgpt.com/callback'] })).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await service.registerClient({ redirect_uris: [`${chatGptCallback}#fragment`] })).toMatchObject({ ok: false, error: 'invalid_request' });
    const client = await register(service);
    expect(client).toMatchObject({ client_name: 'ChatGPT', redirect_uris: [chatGptCallback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(client).not.toHaveProperty('client_secret');
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const persisted = await readFile(file, 'utf8');
    expect(persisted).toContain(client.client_id);
    expect(persisted).not.toContain('client_secret');
    const restarted = new IntegrationAuthService({ issuer, resource, stateFile: file });
    const durableGrant = valueOf(await authorize(restarted, client, 'v'.repeat(64)));
    const exchangeRestarted = new IntegrationAuthService({ issuer, resource, stateFile: file });
    expect((await exchangeRestarted.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: durableGrant.code, redirect_uri: chatGptCallback, code_verifier: 'v'.repeat(64), resource })).ok).toBe(true);
  });

  // verify grant binding and opaque bearer authentication
  it('binds single-use codes to PKCE, client, redirect, resource, subject, and scopes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-integration-auth-code-'));
    directories.push(directory);
    const file = join(directory, 'auth.json');
    const service = new IntegrationAuthService({ issuer, resource, stateFile: file });
    const client = await register(service);
    const verifier = 'correct-verifier-'.padEnd(64, 'x');

    expect(await service.authorize(null as never, { id: 'local-user' })).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await service.exchangeCode(null as never)).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await service.authorize({
      response_type: 'code', client_id: client.client_id, redirect_uri: chatGptCallback, resource: 'https://other.example.test/mcp', scope: 'status:read', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256'
    }, { id: 'local-user' })).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await service.authorize({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example.test/callback', resource, scope: 'status:read', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256'
    }, { id: 'local-user' })).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(await service.authorize({
      response_type: 'code', client_id: client.client_id, redirect_uri: chatGptCallback, resource, scope: 'unknown:scope', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256'
    }, { id: 'local-user' })).toMatchObject({ ok: false, error: 'invalid_scope' });
    expect(await service.authorize({
      response_type: 'code', client_id: client.client_id, redirect_uri: chatGptCallback, resource, scope: 'actions:invoke', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256'
    }, { id: 'local-user' })).toMatchObject({ ok: false, error: 'invalid_scope' });
    expect(await service.authorize({
      response_type: 'code', client_id: client.client_id, redirect_uri: chatGptCallback, resource, scope: 'status:read', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256'
    }, undefined)).toMatchObject({ ok: false, error: 'access_denied' });

    const failedGrant = valueOf(await authorize(service, client, verifier));
    expect(await service.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: failedGrant.code, redirect_uri: chatGptCallback, code_verifier: 'wrong-verifier-'.padEnd(64, 'x'), resource })).toMatchObject({ ok: false, error: 'invalid_grant' });
    expect(await service.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: failedGrant.code, redirect_uri: chatGptCallback, code_verifier: verifier, resource })).toMatchObject({ ok: false, error: 'invalid_grant' });

    const grant = valueOf(await authorize(service, client, verifier));
    expect(grant.state).toBe('chatgpt-state');
    expect(await service.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: grant.code, redirect_uri: chatGptCallback, code_verifier: verifier, resource: 'https://other.example.test/mcp' })).toMatchObject({ ok: false, error: 'invalid_grant' });
    const tokens = valueOf(await service.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: grant.code, redirect_uri: chatGptCallback, code_verifier: verifier, resource }));
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'status:read logs:read' });
    expect(tokens.access_token).toHaveLength(43);
    expect(tokens.refresh_token).toHaveLength(43);

    expect(await service.authenticateAccessToken(tokens.access_token, { resource, scopes: ['files:read'] })).toMatchObject({ ok: false, error: 'insufficient_scope' });
    expect(await service.authenticateAccessToken(tokens.access_token, { resource: 'https://other.example.test/mcp' })).toMatchObject({ ok: false, error: 'invalid_token' });
    const restarted = new IntegrationAuthService({ issuer, resource, stateFile: file });
    const principal = valueOf(await restarted.authenticateAccessToken(tokens.access_token, { resource, scopes: ['status:read'] }));
    expect(principal).toEqual({ authentication: 'oauth', subjectId: 'local-user', clientId: client.client_id, audience: resource, scopes: ['status:read', 'logs:read'], expiresAt: expect.any(Number) });
    expect(restarted.auditData(principal)).toEqual({ authentication: 'oauth', subjectId: 'local-user', clientId: client.client_id, audience: resource, scopes: ['status:read', 'logs:read'] });
    expect(JSON.stringify(principal)).not.toContain(tokens.access_token);
    expect(JSON.stringify(restarted.auditData(principal))).not.toContain(tokens.refresh_token);

    const persisted = await readFile(file, 'utf8');
    expect(persisted).not.toContain(grant.code);
    expect(persisted).not.toContain(tokens.access_token);
    expect(persisted).not.toContain(tokens.refresh_token);
  });

  // verify refresh rotation and family replay defense
  it('rotates refresh tokens, prevents scope expansion, revokes on replay, and supports explicit revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-integration-auth-refresh-'));
    directories.push(directory);
    const file = join(directory, 'auth.json');
    const service = new IntegrationAuthService({ issuer, resource, stateFile: file });
    const client = await register(service);
    const verifier = 'refresh-verifier-'.padEnd(64, 'r');
    const grant = valueOf(await authorize(service, client, verifier, 'status:read logs:read files:read'));
    const initial = valueOf(await service.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: grant.code, redirect_uri: chatGptCallback, code_verifier: verifier, resource }));

    const restarted = new IntegrationAuthService({ issuer, resource, stateFile: file });
    expect(await restarted.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: initial.refresh_token, resource: 'https://other.example.test/mcp' })).toMatchObject({ ok: false, error: 'invalid_grant' });
    const narrowed = valueOf(await restarted.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: initial.refresh_token, resource, scope: 'status:read logs:read' }));
    expect(narrowed.refresh_token).not.toBe(initial.refresh_token);
    expect(narrowed.scope).toBe('status:read logs:read');
    expect(await restarted.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: narrowed.refresh_token, resource, scope: 'files:read' })).toMatchObject({ ok: false, error: 'invalid_scope' });
    const afterRejectedExpansion = valueOf(await restarted.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: narrowed.refresh_token, resource }));

    const replayRestarted = new IntegrationAuthService({ issuer, resource, stateFile: file });
    expect(await replayRestarted.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: initial.refresh_token, resource })).toMatchObject({ ok: false, error: 'invalid_grant' });
    expect(await replayRestarted.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: afterRejectedExpansion.refresh_token, resource })).toMatchObject({ ok: false, error: 'invalid_grant' });

    const nextGrant = valueOf(await authorize(replayRestarted, client, verifier, 'status:read'));
    const next = valueOf(await replayRestarted.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: nextGrant.code, redirect_uri: chatGptCallback, code_verifier: verifier, resource }));
    expect(await replayRestarted.revokeRefreshToken(next.refresh_token)).toEqual({ ok: true, value: { revoked: true } });
    expect(await replayRestarted.revokeRefreshToken(next.refresh_token)).toEqual({ ok: true, value: { revoked: true } });
    expect(await replayRestarted.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: next.refresh_token, resource })).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  // verify exact expiry boundaries and separate Realtime authentication
  it('expires codes, access tokens, and refresh tokens while keeping Realtime credentials out of OAuth state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-integration-auth-expiry-'));
    directories.push(directory);
    const file = join(directory, 'auth.json');
    let currentTime = 1_800_000_000_000;
    // provide a controllable clock
    const clock = () => currentTime;
    const realtimeToken = 'r'.repeat(43);
    const realtimePrincipal = { authentication: 'realtime' as const, subjectId: 'stable-owner', stableOwnerKey: 'o'.repeat(43), leaseKey: 'l'.repeat(43), audience: 'realtime', scopes: ['status:read' as const], expiresAt: currentTime + 10_000 };
    const service = new IntegrationAuthService({ issuer, resource, stateFile: file, now: clock, authorizationCodeTtlMs: 1_000, accessTokenTtlMs: 1_000, refreshTokenTtlMs: 2_000, realtimeAuthenticator: token => token === realtimeToken && currentTime < (realtimePrincipal.expiresAt ?? 0) ? realtimePrincipal : undefined });
    const client = await register(service);
    const verifier = 'expiry-verifier-'.padEnd(64, 'e');

    const expiredGrant = valueOf(await authorize(service, client, verifier));
    currentTime += 1_000;
    expect(await service.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: expiredGrant.code, redirect_uri: chatGptCallback, code_verifier: verifier, resource })).toMatchObject({ ok: false, error: 'invalid_grant' });

    const liveGrant = valueOf(await authorize(service, client, verifier));
    const tokens = valueOf(await service.exchangeCode({ grant_type: 'authorization_code', client_id: client.client_id, code: liveGrant.code, redirect_uri: chatGptCallback, code_verifier: verifier, resource }));
    currentTime += 1_000;
    expect(await service.authenticateAccessToken(tokens.access_token, { resource })).toMatchObject({ ok: false, error: 'invalid_token' });
    currentTime += 1_000;
    expect(await service.refresh({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource })).toMatchObject({ ok: false, error: 'invalid_grant' });

    expect(service.authenticateRealtimeToken('wrong-token-that-is-also-long-enough')).toMatchObject({ ok: false, error: 'invalid_token' });
    expect(valueOf(service.authenticateRealtimeToken(realtimeToken))).toEqual(realtimePrincipal);
    expect(await service.authenticateAccessToken(realtimeToken, { resource })).toMatchObject({ ok: false, error: 'invalid_token' });
    expect(await readFile(file, 'utf8')).not.toContain(realtimeToken);
  });
});
