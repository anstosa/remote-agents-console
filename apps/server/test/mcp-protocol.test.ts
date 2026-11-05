import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { integrationTools } from '../src/integrations/mcp/catalog.js';
import { registerMcpServer } from '../src/integrations/mcp/server.js';

// isolate protocol handling from OAuth grant issuance and real mutations
async function fixture() {
  const app = Fastify();
  const gateway = { listTools: () => integrationTools, call: vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } })) };
  registerMcpServer({ app, publicOrigin: 'https://agents.example.com', gateway: gateway as never, realtimeScopes: [], conductor: { prefix: 'test_', authenticate: async () => ({ authentication: 'conductor', subjectId: 'agent', audience: 'https://agents.example.com/mcp', scopes: ['status:read'] }) } });
  // use an isolated authenticated fixture and optional version header
  const call = async (payload: unknown, version?: string) => await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'agents.example.com', authorization: 'Bearer test_token', ...(version === undefined ? {} : { 'mcp-protocol-version': version }) }, payload });
  return { app, gateway, call };
}

describe('MCP stateless protocol validation', () => {
  // reject malformed params without ever reaching a domain handler
  it.each([null, [], 'bad', 4])('rejects tools/call params %j without a 500', async params => {
    const { app, gateway, call } = await fixture();
    try {
      const response = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(1);
      expect(response.json().error.code).toBe(-32602);
      expect(gateway.call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  // notifications are acknowledged before their unused parameters are inspected
  it.each(['initialize', 'tools/list', 'tools/call', 'notifications/initialized', 'unknown'])('never dispatches malformed %s notifications', async method => {
    const { app, gateway, call } = await fixture();
    try {
      // every valid envelope without an id remains notification-only
      for (const params of [undefined, null, [], 'bad', 4, {}]) {
        const response = await call({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
        expect(response.statusCode).toBe(202);
        expect(response.body).toBe('');
      }
      expect(gateway.call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  // malformed params preserve both numeric and textual request identities
  it.each(['initialize', 'ping', 'tools/list', 'tools/call', 'unknown'])('returns correlated invalid-params errors for %s requests', async method => {
    const { app, gateway, call } = await fixture();
    try {
      // invalid values never reach a domain port for any request method
      for (const id of [0, 'request-id']) {
        // keep scalar and collection refusals identical
        for (const params of [null, [], 'bad', 4]) {
          const response = await call({ jsonrpc: '2.0', id, method, params });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject({ id, error: { code: -32602 } });
        }
      }
      expect(gateway.call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  // null, fractional and empty identifiers are not valid MCP request identities
  it.each([null, '', 1.5, {}, []])('rejects invalid request id %j', async id => {
    const { app, gateway, call } = await fixture();
    try {
      const response = await call({ jsonrpc: '2.0', id, method: 'ping' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(-32600);
      expect(gateway.call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  // explicit unsupported headers cannot silently use fallback semantics
  it.each(['', 'garbage', '2025-03-26', '2026-01-01'])('rejects unsupported version %j', async version => {
    const { app, gateway, call } = await fixture();
    try {
      expect((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, version)).statusCode).toBe(400);
      expect(gateway.call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  // missing headers use only legacy descriptor projection, never persisted negotiation
  it('projects schema and structured results per request version', async () => {
    const { app, call } = await fixture();
    try {
      const legacy = (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json().result.tools;
      expect(legacy[0]).not.toHaveProperty('outputSchema');
      const modern = (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, '2025-06-18')).json().result.tools;
      expect(modern[0]).toHaveProperty('outputSchema');
      const result = (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_instances' } })).json().result;
      expect(result).not.toHaveProperty('structuredContent');
      const repeated = (await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).json().result.tools;
      expect(repeated[0]).not.toHaveProperty('outputSchema');
    } finally { await app.close(); }
  });
  // initialization requires actual client capabilities and metadata
  it('validates initialize while negotiating a well-formed unsupported offer', async () => {
    const { app, call } = await fixture();
    try {
      expect((await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json().error.code).toBe(-32602);
      const response = await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'future', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
      expect(response.json().result.protocolVersion).toBe('2025-06-18');
    } finally { await app.close(); }
  });
  // tool notifications must not trigger mutations or ordinary tool reads
  it('acknowledges notifications without dispatch and refuses unknown or invalid calls', async () => {
    const { app, gateway, call } = await fixture();
    try {
      expect((await call({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'queue_prompt' } })).statusCode).toBe(202);
      expect((await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'missing' } })).json().error.code).toBe(-32602);
      expect((await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_agent_status', arguments: {} } })).json().error.code).toBe(-32602);
      expect(gateway.call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  // return a bounded JSON-RPC parse error instead of a framework error body
  it('returns a JSON-RPC parse error for malformed JSON', async () => {
    const { app, gateway } = await fixture();
    try {
      const response = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'agents.example.com', authorization: 'Bearer test_token', 'content-type': 'application/json' }, payload: '{' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(-32700);
      expect(gateway.call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
