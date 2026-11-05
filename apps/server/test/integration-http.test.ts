import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationAuthService, registerIntegrationAuthServer } from '../src/integrations/auth/index.js';
import { integrationTools, registerMcpServer } from '../src/integrations/mcp/index.js';

const roots: string[] = [];

// create one isolated OAuth and MCP application
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rac-integration-http-'));
  roots.push(root);
  const app = Fastify();
  const origin = 'https://agents.example.com';
  const resource = `${origin}/mcp`;
  const auth = new IntegrationAuthService({ issuer: origin, resource, stateFile: join(root, 'auth.json') });
  registerIntegrationAuthServer({ app, auth, resource, localSubject: (_request, csrf) => csrf === undefined || csrf === 'csrf-value' ? { id: 'local-user', csrf: 'csrf-value' } as never : undefined });
  const gateway = {
    listTools: () => integrationTools.filter(tool => tool.risk === 'read'),
    call: async (_principal: unknown, name: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, name }) }], structuredContent: { ok: true, name } })
  };
  registerMcpServer({ app, publicOrigin: origin, auth, gateway: gateway as never, realtimeScopes: ['status:read'] });
  return { app, origin, resource };
}

// exchange a standards-bound public client grant
async function accessToken(app: Awaited<ReturnType<typeof fixture>>['app'], resource: string): Promise<string> {
  const host = 'agents.example.com';
  const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
  const registration = await app.inject({ method: 'POST', url: '/oauth/register', headers: { host }, payload: { redirect_uris: [redirectUri], client_name: 'ChatGPT' } });
  const clientId = registration.json().client_id as string;
  const verifier = 'a'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { host, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, resource, scope: 'status:read', code_challenge: challenge, code_challenge_method: 'S256', csrf: 'csrf-value' }).toString() });
  const code = new URL(String(authorize.headers.location)).searchParams.get('code');
  const token = await app.inject({ method: 'POST', url: '/oauth/token', headers: { host, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: code ?? '', redirect_uri: redirectUri, code_verifier: verifier, resource }).toString() });
  return token.json().access_token as string;
}

afterEach(async () => {
  // remove every private integration fixture
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('integration HTTP surfaces', () => {
  it('publishes OAuth metadata and completes PKCE before listing MCP tools', async () => {
    const { app, resource } = await fixture();
    try {
      const metadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource', headers: { host: 'agents.example.com' } });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json().resource).toBe(resource);
      const token = await accessToken(app, resource);
      expect(token).toHaveLength(43);
      const initialized = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'agents.example.com', authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } } });
      expect(initialized.json().result.protocolVersion).toBe('2025-06-18');
      const listed = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'agents.example.com', authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toContain('list_instances');
      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).not.toContain('queue_prompt');
    } finally { await app.close(); }
  });

  it('challenges unauthenticated MCP calls and rejects GET transport', async () => {
    const { app, origin } = await fixture();
    try {
      const denied = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'agents.example.com' }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['www-authenticate']).toContain(`${origin}/.well-known/oauth-protected-resource`);
      expect((await app.inject({ method: 'GET', url: '/mcp', headers: { host: 'agents.example.com' } })).statusCode).toBe(405);
    } finally { await app.close(); }
  });
});
