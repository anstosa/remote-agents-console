import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { ControlService } from '../src/auth/control.js';
import type { ValidatedConfig } from '../src/config/schema.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // remove every private application fixture
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('application integration surfaces', () => {
  it('derives federation route availability from remote servers for direct config fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-integration-federation-app-'));
    roots.push(root);
    const secret = Buffer.alloc(32, 5).toString('base64url');
    vi.stubEnv('RAC_SESSION_SECRET', secret);
    vi.stubEnv('RAC_INTEGRATION_AUTH_FILE', join(root, 'auth.json'));
    vi.stubEnv('RAC_INTEGRATION_STATE_FILE', join(root, 'policy.json'));
    vi.stubEnv('RAC_INTEGRATION_AUDIT_FILE', join(root, 'audit.jsonl'));
    const base: ValidatedConfig = {
      listen: { host: '127.0.0.1', port: 8787 },
      name: 'Remote Agents',
      publicOrigin: new URL('https://agents.example.com'),
      remoteServers: [],
      trustedProxyIps: new Set(['127.0.0.1']),
      pollIntervalMs: 500,
      adapters: {},
      integrations: { enabled: true, mcp: { readEnabled: true, writeEnabled: false, dangerousEnabled: false }, realtime: { enabled: false, name: 'Davo', context: '', writeToolsEnabled: false }, multiInstance: { enabled: true } },
      projects: []
    };
    const auth = new AuthService('$argon2id$unused', secret);
    const withoutRemotes = await buildApp(base, { auth, reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never });
    try {
      const disabled = await withoutRemotes.inject({ method: 'POST', url: '/api/integration-federation', headers: { host: 'agents.example.com' }, payload: {} });
      expect(disabled.statusCode).toBe(404);
    } finally { await withoutRemotes.close(); }

    const withRemotes = await buildApp({ ...base, remoteServers: [{ url: new URL('https://peer.example.com') }], integrations: { ...base.integrations!, multiInstance: { enabled: false } } }, { auth, reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never });
    try {
      const enabled = await withRemotes.inject({ method: 'POST', url: '/api/integration-federation', headers: { host: 'agents.example.com' }, payload: {} });
      expect(enabled.statusCode).toBe(401);
    } finally { await withRemotes.close(); }

    const masterDisabled = await buildApp({ ...base, remoteServers: [{ url: new URL('https://peer.example.com') }], integrations: undefined }, { auth, reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never });
    try {
      const metadata = await masterDisabled.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource', headers: { host: 'agents.example.com' } });
      expect(metadata.statusCode).toBe(404);
    } finally { await masterDisabled.close(); }
  });

  it('registers OAuth, MCP, and authenticated Realtime status behind feature gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-integration-app-'));
    roots.push(root);
    const secret = Buffer.alloc(32, 4).toString('base64url');
    vi.stubEnv('RAC_SESSION_SECRET', secret);
    vi.stubEnv('RAC_INTEGRATION_AUTH_FILE', join(root, 'auth.json'));
    vi.stubEnv('RAC_INTEGRATION_STATE_FILE', join(root, 'policy.json'));
    vi.stubEnv('RAC_INTEGRATION_AUDIT_FILE', join(root, 'audit.jsonl'));
    vi.stubEnv('RAC_OPENAI_API_KEY', 'test-key');
    vi.stubEnv('RAC_DAVO_STATE_FILE', join(root, 'davo.json'));
    vi.stubEnv('RAC_PROMPT_OPERATIONS_FILE', join(root, 'operations.json'));
    vi.stubEnv('RAC_DAVO_PUSH_ATTEMPTS_FILE', join(root, 'push-attempts.json'));
    // preserve documented blank optional secrets
    vi.stubEnv('RAC_REALTIME_MCP_TOKEN', ' ');
    vi.stubEnv('RAC_INTEGRATION_FEDERATION_SECRET', ' ');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('/realtime/calls') ? new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_integration_test' } }) : new Response(JSON.stringify({ value: 'ek_testcredential' }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const config: ValidatedConfig = {
      listen: { host: '127.0.0.1', port: 8787 },
      name: 'Remote Agents',
      publicOrigin: new URL('https://agents.example.com'),
      remoteServers: [],
      trustedProxyIps: new Set(['127.0.0.1']),
      pollIntervalMs: 500,
      adapters: {},
      integrations: { enabled: true, mcp: { readEnabled: true, writeEnabled: true, dangerousEnabled: false }, realtime: { enabled: true, name: 'Davo', context: '', writeToolsEnabled: true }, multiInstance: { enabled: false } },
      projects: []
    };
    const auth = new AuthService('$argon2id$unused', secret);
    const control = new ControlService();
    const app = await buildApp(config, { auth, control, reviewTours: { capability: async () => ({ available: false, reason: 'generator_unavailable' }) } as never });
    try {
      const metadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource', headers: { host: 'agents.example.com' } });
      expect(metadata.json().resource).toBe('https://agents.example.com/mcp');
      const signed = auth.sign({ id: 'browser-session', csrf: 'browser-csrf' });
      const registration = await app.inject({ method: 'POST', url: '/oauth/register', headers: { host: 'agents.example.com' }, payload: { redirect_uris: ['https://chatgpt.com/connector/oauth/test-callback'] } });
      const consent = { response_type: 'code', client_id: registration.json().client_id, redirect_uri: 'https://chatgpt.com/connector/oauth/test-callback', resource: 'https://agents.example.com/mcp', scope: 'status:read', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' };
      // missing CSRF cannot bypass origin validation on an authenticated consent POST
      for (const [origin, csrf] of [['https://evil.example', undefined], ['https://agents.example.com', undefined], ['https://evil.example', 'browser-csrf'], [undefined, 'browser-csrf'], ['https://agents.example.com', 'wrong-csrf']]) {
        const denied = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}`, ...(origin === undefined ? {} : { origin }) }, payload: { ...consent, ...(csrf === undefined ? {} : { csrf }) } });
        expect(denied.statusCode).toBe(401);
        expect(denied.headers.location).toBeUndefined();
      }
      const approved = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}`, origin: 'https://agents.example.com' }, payload: { ...consent, csrf: 'browser-csrf' } });
      expect(approved.statusCode).toBe(302);
      const status = await app.inject({ method: 'GET', url: '/api/integrations/status', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}` } });
      expect(status.json()).toMatchObject({ enabled: true, control: { voiceActive: false }, realtime: { enabled: true, available: true, writeToolsEnabled: true } });
      const voiceSessionId = 'voice-session-123456789';
      // authentication alone cannot start voice mode or acquire control
      const inactiveRealtime = await app.inject({ method: 'POST', url: '/api/realtime/session', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: `__Host-rac=${signed}`, 'x-csrf-token': 'browser-csrf' }, payload: { voiceSessionId } });
      expect(inactiveRealtime.statusCode).toBe(423);
      // establish explicit ownership before exercising the voice lifecycle
      await control.take('browser-session');
      const snapshot = await app.inject({ method: 'GET', url: '/api/davo/conversation', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}` } });
      const generation = snapshot.json().generation;
      const audioHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: `__Host-rac=${signed}`, 'x-csrf-token': 'browser-csrf' };
      const realtime = await app.inject({ method: 'POST', url: '/api/realtime/session', headers: audioHeaders, payload: { voiceSessionId, generation } });
      expect(realtime.statusCode).toBe(200);
      expect(JSON.stringify(realtime.json())).not.toContain('ek_testcredential');
      const negotiated = await app.inject({ method: 'POST', url: '/api/realtime/negotiate', headers: audioHeaders, payload: { voiceSessionId, generation, negotiationId: realtime.json().negotiationId, sdp: 'v=0\r\noffer' } });
      expect(negotiated.statusCode).toBe(200);
      const ready = await app.inject({ method: 'POST', url: '/api/davo/session/ready', headers: audioHeaders, payload: { voiceSessionId, generation, readinessId: negotiated.json().readinessId, responseId: 'readiness-response', importedTools: negotiated.json().readinessResponse.tools[0].allowed_tools } });
      expect(ready.statusCode).toBe(200);
      const admitted = await app.inject({ method: 'POST', url: '/api/davo/transcripts/user', headers: audioHeaders, payload: { voiceSessionId, generation, providerSessionId: 'session-test', providerItemId: 'item-test', text: 'What is running?' } });
      expect(admitted.statusCode).toBe(200);
      const bearer = admitted.json().response.tools[0].authorization as string;
      const mcpHeaders = { host: 'agents.example.com', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${bearer}` };
      const listed = await app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(listed.statusCode).toBe(200);
      const names = listed.json().result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['get_agent_runtime', 'list_agent_models', 'list_conversations', 'get_comparison', 'list_notes', 'bind_davo_target', 'delegate_request', 'relay_agent_question_answer', 'answer_davo_choice']));
      expect(names).toEqual(expect.not.arrayContaining(['queue_prompt', 'restart_agent', 'launch_agent', 'begin_file_upload', 'create_note', 'spawn_agent', 'create_worktree', 'create_pull_request_review_draft']));
      expect(names).not.toContain('watch_command');
      const denied = await app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'watch_command', arguments: { command: 'echo unsafe', description: 'unavailable', request_id: 'request-denied-command' } } } });
      expect(denied.json().error.code).toBe(-32602);
      const activeStatus = await app.inject({ method: 'GET', url: '/api/integrations/status', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}` } });
      expect(activeStatus.json()).toMatchObject({ control: { voiceActive: true } });
      const heartbeat = await app.inject({ method: 'POST', url: '/api/realtime/session/heartbeat', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: `__Host-rac=${signed}`, 'x-csrf-token': 'browser-csrf' }, payload: { voiceSessionId, generation } });
      expect(heartbeat.statusCode).toBe(200);
      const stopped = await app.inject({ method: 'POST', url: '/api/realtime/session/stop', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: `__Host-rac=${signed}`, 'x-csrf-token': 'browser-csrf' }, payload: { voiceSessionId, generation } });
      expect(stopped.statusCode).toBe(200);
      const stoppedStatus = await app.inject({ method: 'GET', url: '/api/integrations/status', headers: { host: 'agents.example.com', cookie: `__Host-rac=${signed}` } });
      expect(stoppedStatus.json()).toMatchObject({ control: { voiceActive: false } });
      const revoked = await app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders, payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
      expect(revoked.statusCode).toBe(401);
      expect(realtime.headers['content-security-policy']).toContain('https://api.openai.com');
    } finally { await app.close(); }
  });
});
