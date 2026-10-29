import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RemoteServer } from '../../config/schema.js';
import { supportedIntegrationScopes, type IntegrationPrincipal, type IntegrationScope } from '../auth/index.js';
import type { ToolCallResult } from '../mcp/gateway.js';

const replayWindowMs = 30_000;
const maxFederationBodyBytes = 65_536;

export type FederationPayload = { principal: { subjectId: string; clientId?: string; scopes: IntegrationScope[] }; name: string; arguments: Record<string, unknown>; voiceAuthorized: boolean };

// create one signed cross-instance tool forwarding callback
export function federationForwarder(remoteServers: RemoteServer[], secret: string, fetcher: typeof fetch = fetch) {
  // forward only to one configured instance
  return async (instanceId: string, principal: IntegrationPrincipal, name: string, args: Record<string, unknown>, voiceAuthorized: boolean): Promise<ToolCallResult | undefined> => {
    const server = remoteServers.find(candidate => candidate.url.origin === instanceId);
    // reject unconfigured destinations and missing federation keys
    if (server === undefined || Buffer.from(secret, 'base64url').length < 32) return undefined;
    const payload: FederationPayload = { principal: { subjectId: principal.subjectId, ...(principal.clientId === undefined ? {} : { clientId: principal.clientId }), scopes: [...principal.scopes] }, name, arguments: args, voiceAuthorized };
    const serialized = JSON.stringify(payload);
    const timestamp = String(Date.now());
    try {
      const response = await fetcher(new URL('/api/integration-federation', server.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-rac-federation-timestamp': timestamp, 'x-rac-federation-signature': signature(secret, timestamp, serialized) }, body: serialized, signal: AbortSignal.timeout(15_000) });
      // return only successful bounded tool envelopes
      if (!response.ok) return undefined;
      const text = await response.text();
      // bound peer responses before parsing
      if (Buffer.byteLength(text) > maxFederationBodyBytes) return undefined;
      const value = JSON.parse(text) as unknown;
      return isToolCallResult(value) ? value : undefined;
    } catch { return undefined; }
  };
}

// validate one signed federation request without bearer forwarding
export function verifyFederationRequest(secret: string, timestampHeader: unknown, signatureHeader: unknown, payload: unknown): FederationPayload | undefined {
  // require a strong shared secret and scalar headers
  if (Buffer.from(secret, 'base64url').length < 32 || typeof timestampHeader !== 'string' || typeof signatureHeader !== 'string') return undefined;
  const timestamp = Number(timestampHeader);
  // reject stale and future replay windows
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > replayWindowMs) return undefined;
  const serialized = JSON.stringify(payload);
  // reject oversized and incorrectly signed envelopes
  if (Buffer.byteLength(serialized) > maxFederationBodyBytes || !safeEqual(signature(secret, timestampHeader, serialized), signatureHeader)) return undefined;
  return isFederationPayload(payload) ? payload : undefined;
}

// sign the exact timestamp and JSON payload
function signature(secret: string, timestamp: string, serialized: string): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${serialized}`).digest('base64url');
}

// compare fixed signatures without early exit
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

// validate one least-privilege delegated principal and tool call
function isFederationPayload(value: unknown): value is FederationPayload {
  // require one exact object envelope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { principal?: unknown; name?: unknown; arguments?: unknown; voiceAuthorized?: unknown };
  // require one safe tool and argument object
  if (typeof candidate.name !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/u.test(candidate.name) || candidate.arguments === null || typeof candidate.arguments !== 'object' || Array.isArray(candidate.arguments) || candidate.principal === null || typeof candidate.principal !== 'object' || Array.isArray(candidate.principal) || typeof candidate.voiceAuthorized !== 'boolean') return false;
  const principal = candidate.principal as { subjectId?: unknown; clientId?: unknown; scopes?: unknown };
  // accept only bounded subjects and known scopes
  if (typeof principal.subjectId !== 'string' || principal.subjectId.length === 0 || principal.subjectId.length > 256 || principal.clientId !== undefined && (typeof principal.clientId !== 'string' || principal.clientId.length > 256) || !Array.isArray(principal.scopes) || principal.scopes.length > supportedIntegrationScopes.length || !principal.scopes.every(scope => (supportedIntegrationScopes as readonly string[]).includes(scope))) return false;
  return true;
}

// validate one serialized MCP tool result
function isToolCallResult(value: unknown): value is ToolCallResult {
  // require structured and text response fields
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  return Array.isArray(result.content) && result.content.every(item => item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string') && result.structuredContent !== null && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent) && (result.isError === undefined || typeof result.isError === 'boolean');
}
