import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import {
  supportedIntegrationScopes,
  type AccessAuthenticationRequest,
  type AuthorizationCodeTokenRequest,
  type AuthorizationGrant,
  type AuthorizationRequest,
  type DynamicClientRegistrationRequest,
  type IntegrationAuditData,
  type IntegrationPrincipal,
  type IntegrationScope,
  type LocalIntegrationSubject,
  type OAuthAuthorizationServerMetadata,
  type OAuthFailure,
  type OAuthProtectedResourceMetadata,
  type OAuthResult,
  type OAuthTokenResponse,
  type PublicIntegrationScope,
  type RefreshTokenRequest,
  type RegisteredPublicClient
} from './types.js';

type StoredClient = {
  id: string;
  issuedAt: number;
  name?: string;
  redirectUris: string[];
};

type StoredAuthorizationCode = {
  clientId: string;
  subjectId: string;
  resource: string;
  scopes: PublicIntegrationScope[];
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
};

type StoredAccessToken = {
  clientId: string;
  subjectId: string;
  resource: string;
  scopes: PublicIntegrationScope[];
  issuedAt: number;
  expiresAt: number;
};

type StoredRefreshToken = StoredAccessToken & {
  familyId: string;
};

type SpentRefreshToken = {
  familyId: string;
  expiresAt: number;
};

type StoredState = {
  version: 1;
  clients: Record<string, StoredClient>;
  authorizationCodes: Record<string, StoredAuthorizationCode>;
  accessTokens: Record<string, StoredAccessToken>;
  refreshTokens: Record<string, StoredRefreshToken>;
  spentRefreshTokens: Record<string, SpentRefreshToken>;
  revokedRefreshFamilies: Record<string, number>;
};

export type IntegrationAuthOptions = {
  issuer: string;
  resource: string;
  stateFile: string;
  realtimeAuthenticator?: (token: string) => IntegrationPrincipal | undefined;
  now?: () => number;
  authorizationCodeTtlMs?: number;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
};

const tokenBytes = 32;
const maxSerializedBytes = 16 * 1024 * 1024;
const maxClients = 1_000;
const maxAuthorizationCodes = 5_000;
const maxAccessTokens = 10_000;
const maxRefreshTokens = 5_000;
const maxSpentRefreshTokens = 10_000;
const maxRevokedFamilies = 15_000;
const maxRedirectUris = 10;
const maxUriLength = 2_048;
const maxNameLength = 200;
const maxSubjectLength = 200;
const maxStateLength = 1_024;
const maxScopeStringLength = 256;
const minCodeVerifierLength = 43;
const maxCodeVerifierLength = 128;
const defaultAuthorizationCodeTtlMs = 5 * 60_000;
const defaultAccessTokenTtlMs = 10 * 60_000;
const defaultRefreshTokenTtlMs = 30 * 24 * 60 * 60_000;
const supportedScopeSet = new Set<string>(supportedIntegrationScopes);
const clientIdPattern = /^[A-Za-z0-9_-]{20,64}$/u;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const pkcePattern = /^[A-Za-z0-9._~-]{43,128}$/u;
const challengePattern = /^[A-Za-z0-9_-]{43}$/u;

// create an empty versioned durable store
function emptyState(): StoredState {
  return { version: 1, clients: {}, authorizationCodes: {}, accessTokens: {}, refreshTokens: {}, spentRefreshTokens: {}, revokedRefreshFamilies: {} };
}

// create a typed OAuth failure
function failure(error: OAuthFailure['error'], error_description: string, status: OAuthFailure['status'] = 400): OAuthFailure {
  return { ok: false, error, error_description, status };
}

// hash a bearer secret before lookup or storage
function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

// generate one high-entropy opaque secret
function opaqueToken(): string {
  return randomBytes(tokenBytes).toString('base64url');
}

// compare equal-length secret material without content-dependent timing
function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

// locate a hashed secret without direct string equality
function findSecret<T>(records: Record<string, T>, presented: string): [string, T] | undefined {
  const presentedHash = hashSecret(presented);
  let match: [string, T] | undefined;
  // scan bounded stored hashes with constant-time comparisons
  for (const [storedHash, value] of Object.entries(records)) {
    // retain only an exact digest match without ending the bounded scan early
    if (constantTimeEqual(storedHash, presentedHash)) match = [storedHash, value];
  }
  return match;
}

// validate one absolute HTTPS URL without credentials or fragments
function validHttpsUrl(value: unknown): value is string {
  // reject oversized and control-character inputs before parsing
  if (typeof value !== 'string' || value.length === 0 || value.length > maxUriLength || /[\u0000-\u001F\u007F]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === '' && parsed.origin !== 'null';
  } catch {
    return false;
  }
}

// normalize a server base URL without a trailing slash
function normalizedHttpsUrl(value: string, label: string): string {
  // reject invalid configuration at construction time
  if (!validHttpsUrl(value)) throw new Error(`${label} must be an absolute HTTPS URL`);
  const parsed = new URL(value);
  // require base URLs without query parameters
  if (parsed.search !== '') throw new Error(`${label} must not include a query string`);
  return parsed.toString().replace(/\/$/u, '');
}

// parse and validate a requested scope collection
function parseScopes(value: string | readonly string[] | undefined): OAuthResult<PublicIntegrationScope[]> {
  // require an explicit scope request
  if (value === undefined) return failure('invalid_scope', 'scope is required');
  // reject non-string JSON values before iteration
  if (typeof value !== 'string' && !Array.isArray(value)) return failure('invalid_scope', 'scope must be a string or string array');
  // bound serialized scope input before splitting
  if (typeof value === 'string' && value.length > maxScopeStringLength) return failure('invalid_scope', 'scope is too long');
  const raw = typeof value === 'string' ? value.split(' ') : [...value];
  // reject empty, duplicate, or oversized scope lists
  if (raw.length === 0 || raw.length > supportedIntegrationScopes.length || raw.some(scope => typeof scope !== 'string' || scope.length === 0) || new Set(raw).size !== raw.length) return failure('invalid_scope', 'scope must contain distinct supported values');
  // reject any unsupported capability
  if (raw.some(scope => !supportedScopeSet.has(scope))) return failure('invalid_scope', 'one or more requested scopes are unsupported');
  return { ok: true, value: raw as PublicIntegrationScope[] };
}

// ensure one requested scope list is a subset of a grant
function scopesWithin(requested: readonly IntegrationScope[], granted: readonly IntegrationScope[]): boolean {
  const grantedSet = new Set(granted);
  return requested.every(scope => grantedSet.has(scope));
}

// validate a local subject identifier
function validSubjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxSubjectLength && !/[\u0000-\u001F\u007F]/u.test(value);
}

// validate configurable OAuth lifetimes
function boundedTtl(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const ttl = value ?? fallback;
  // fail on unsafe or unexpectedly long configured lifetimes
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > maximum) throw new Error(`${label} is outside supported bounds`);
  return ttl;
}

// validate a plain record value
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// validate one persisted client record
function parseClient(value: unknown, key: string): StoredClient | undefined {
  // require the exact bounded client fields
  if (!plainRecord(value) || value.id !== key || !clientIdPattern.test(key) || !Number.isSafeInteger(value.issuedAt) || !Array.isArray(value.redirectUris)) return undefined;
  const redirectUris = value.redirectUris;
  // reject invalid durable redirect URIs
  if (redirectUris.length === 0 || redirectUris.length > maxRedirectUris || redirectUris.some(uri => typeof uri !== 'string' || !validHttpsUrl(uri)) || new Set(redirectUris).size !== redirectUris.length) return undefined;
  // reject invalid optional names
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > maxNameLength || /[\u0000-\u001F\u007F]/u.test(value.name))) return undefined;
  return { id: key, issuedAt: value.issuedAt as number, redirectUris: redirectUris as string[], ...(value.name === undefined ? {} : { name: value.name as string }) };
}

// parse one persisted scope list
function parseStoredScopes(value: unknown): PublicIntegrationScope[] | undefined {
  // validate the durable array without coercion
  if (!Array.isArray(value) || value.length === 0 || value.length > supportedIntegrationScopes.length || value.some(scope => typeof scope !== 'string' || !supportedScopeSet.has(scope)) || new Set(value).size !== value.length) return undefined;
  return value as PublicIntegrationScope[];
}

// validate shared persisted token fields
function parseTokenFields(value: unknown): StoredAccessToken | undefined {
  // require a bounded plain token record
  if (!plainRecord(value) || typeof value.clientId !== 'string' || !clientIdPattern.test(value.clientId) || typeof value.subjectId !== 'string' || !validSubjectId(value.subjectId) || typeof value.resource !== 'string' || !validHttpsUrl(value.resource) || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= (value.issuedAt as number)) return undefined;
  const scopes = parseStoredScopes(value.scopes);
  // reject malformed stored scopes
  if (scopes === undefined) return undefined;
  return { clientId: value.clientId, subjectId: value.subjectId, resource: value.resource, scopes, issuedAt: value.issuedAt as number, expiresAt: value.expiresAt as number };
}

// validate one persisted authorization code
function parseAuthorizationCode(value: unknown): StoredAuthorizationCode | undefined {
  // require authorization-specific fields
  if (!plainRecord(value) || typeof value.clientId !== 'string' || !clientIdPattern.test(value.clientId) || typeof value.subjectId !== 'string' || !validSubjectId(value.subjectId) || typeof value.resource !== 'string' || !validHttpsUrl(value.resource) || typeof value.redirectUri !== 'string' || !validHttpsUrl(value.redirectUri) || typeof value.codeChallenge !== 'string' || !challengePattern.test(value.codeChallenge) || !Number.isSafeInteger(value.expiresAt)) return undefined;
  const scopes = parseStoredScopes(value.scopes);
  // reject malformed stored scopes
  if (scopes === undefined) return undefined;
  return { clientId: value.clientId, subjectId: value.subjectId, resource: value.resource, scopes, redirectUri: value.redirectUri, codeChallenge: value.codeChallenge, expiresAt: value.expiresAt as number };
}

// validate one persisted refresh token
function parseRefreshToken(value: unknown): StoredRefreshToken | undefined {
  const token = parseTokenFields(value);
  // require a valid family identity
  if (token === undefined || !plainRecord(value) || typeof value.familyId !== 'string' || !clientIdPattern.test(value.familyId)) return undefined;
  return { ...token, familyId: value.familyId };
}

// validate one persisted secret-hash record
function validHashKey(value: string): boolean {
  return challengePattern.test(value);
}

// parse and bound the complete persisted state
function parseState(value: unknown): StoredState {
  // fail closed on a malformed root
  if (!plainRecord(value) || value.version !== 1 || !plainRecord(value.clients) || !plainRecord(value.authorizationCodes) || !plainRecord(value.accessTokens) || !plainRecord(value.refreshTokens) || !plainRecord(value.spentRefreshTokens) || !plainRecord(value.revokedRefreshFamilies)) throw new Error('invalid integration auth state');
  const state = emptyState();
  const groups = [value.clients, value.authorizationCodes, value.accessTokens, value.refreshTokens, value.spentRefreshTokens, value.revokedRefreshFamilies] as Array<Record<string, unknown>>;
  const limits = [maxClients, maxAuthorizationCodes, maxAccessTokens, maxRefreshTokens, maxSpentRefreshTokens, maxRevokedFamilies];
  // enforce aggregate record-count boundaries
  for (let index = 0; index < groups.length; index += 1) {
    // reject an oversized durable collection
    if (Object.keys(groups[index]!).length > limits[index]!) throw new Error('integration auth state exceeds storage limits');
  }
  // parse every public client
  for (const [key, raw] of Object.entries(value.clients)) {
    const client = parseClient(raw, key);
    // fail closed on any corrupt client
    if (client === undefined) throw new Error('invalid integration auth state');
    state.clients[key] = client;
  }
  // parse every authorization code hash
  for (const [key, raw] of Object.entries(value.authorizationCodes)) {
    const code = validHashKey(key) ? parseAuthorizationCode(raw) : undefined;
    // fail closed on any corrupt authorization code
    if (code === undefined) throw new Error('invalid integration auth state');
    state.authorizationCodes[key] = code;
  }
  // parse every access token hash
  for (const [key, raw] of Object.entries(value.accessTokens)) {
    const token = validHashKey(key) ? parseTokenFields(raw) : undefined;
    // fail closed on any corrupt access token
    if (token === undefined) throw new Error('invalid integration auth state');
    state.accessTokens[key] = token;
  }
  // parse every refresh token hash
  for (const [key, raw] of Object.entries(value.refreshTokens)) {
    const token = validHashKey(key) ? parseRefreshToken(raw) : undefined;
    // fail closed on any corrupt refresh token
    if (token === undefined) throw new Error('invalid integration auth state');
    state.refreshTokens[key] = token;
  }
  // parse every spent refresh token tombstone
  for (const [key, raw] of Object.entries(value.spentRefreshTokens)) {
    // require a valid bounded tombstone
    if (!validHashKey(key) || !plainRecord(raw) || typeof raw.familyId !== 'string' || !clientIdPattern.test(raw.familyId) || !Number.isSafeInteger(raw.expiresAt)) throw new Error('invalid integration auth state');
    state.spentRefreshTokens[key] = { familyId: raw.familyId, expiresAt: raw.expiresAt as number };
  }
  // parse every revoked family expiry
  for (const [key, raw] of Object.entries(value.revokedRefreshFamilies)) {
    // require a valid family and expiry
    if (!clientIdPattern.test(key) || !Number.isSafeInteger(raw)) throw new Error('invalid integration auth state');
    state.revokedRefreshFamilies[key] = raw as number;
  }
  return state;
}

// remove expired ephemeral grants and tombstones
function pruneState(state: StoredState, now: number): boolean {
  let changed = false;
  const expiringGroups: Array<Record<string, { expiresAt: number }>> = [state.authorizationCodes, state.accessTokens, state.refreshTokens, state.spentRefreshTokens];
  // inspect each bounded expiring collection
  for (const records of expiringGroups) {
    // remove every expired record
    for (const [key, record] of Object.entries(records)) {
      // expire at the exact boundary
      if (record.expiresAt <= now) { delete records[key]; changed = true; }
    }
  }
  // remove expired family revocations
  for (const [familyId, expiresAt] of Object.entries(state.revokedRefreshFamilies)) {
    // release expired replay state
    if (expiresAt <= now) { delete state.revokedRefreshFamilies[familyId]; changed = true; }
  }
  return changed;
}

// remove every live refresh token in one family
function revokeFamily(state: StoredState, familyId: string, expiresAt: number): void {
  // retain bounded family replay state when capacity permits
  if (state.revokedRefreshFamilies[familyId] !== undefined || Object.keys(state.revokedRefreshFamilies).length < maxRevokedFamilies) state.revokedRefreshFamilies[familyId] = expiresAt;
  // remove active descendants after revocation or replay
  for (const [hash, token] of Object.entries(state.refreshTokens)) {
    // remove only this token family
    if (token.familyId === familyId) delete state.refreshTokens[hash];
  }
}

// expose a client without any secret material
function publicClient(client: StoredClient): RegisteredPublicClient {
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.issuedAt / 1_000),
    ...(client.name === undefined ? {} : { client_name: client.name }),
    redirect_uris: [...client.redirectUris],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  };
}

// expose a bearer principal without token material
function principal(token: StoredAccessToken): IntegrationPrincipal {
  return { authentication: 'oauth', subjectId: token.subjectId, clientId: token.clientId, audience: token.resource, scopes: [...token.scopes], expiresAt: token.expiresAt };
}

export class IntegrationAuthService {
  private mutation = Promise.resolve();
  private readonly issuer: string;
  private readonly resource: string;
  private readonly stateFile: string;
  private readonly now: () => number;
  private readonly authorizationCodeTtlMs: number;
  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  private readonly realtimeAuthenticator?: (token: string) => IntegrationPrincipal | undefined;

  // validate security-critical configuration once
  constructor(options: IntegrationAuthOptions) {
    // require a usable durable path before any OAuth operation
    if (typeof options.stateFile !== 'string' || options.stateFile.length === 0 || options.stateFile.length > 4_096 || options.stateFile.includes('\0')) throw new Error('state file is invalid');
    this.issuer = normalizedHttpsUrl(options.issuer, 'issuer');
    this.resource = normalizedHttpsUrl(options.resource, 'resource');
    this.stateFile = options.stateFile;
    this.now = options.now ?? Date.now;
    this.authorizationCodeTtlMs = boundedTtl(options.authorizationCodeTtlMs, defaultAuthorizationCodeTtlMs, 10 * 60_000, 'authorization code lifetime');
    this.accessTokenTtlMs = boundedTtl(options.accessTokenTtlMs, defaultAccessTokenTtlMs, 60 * 60_000, 'access token lifetime');
    this.refreshTokenTtlMs = boundedTtl(options.refreshTokenTtlMs, defaultRefreshTokenTtlMs, 90 * 24 * 60 * 60_000, 'refresh token lifetime');
    this.realtimeAuthenticator = options.realtimeAuthenticator;
  }

  // return RFC 9728-style protected-resource metadata
  protectedResourceMetadata(): OAuthProtectedResourceMetadata {
    return protectedResourceMetadata(this.issuer, this.resource);
  }

  // return OAuth authorization-server metadata
  authorizationServerMetadata(): OAuthAuthorizationServerMetadata {
    return authorizationServerMetadata(this.issuer);
  }

  // register one public authorization-code client
  async registerClient(request: DynamicClientRegistrationRequest): Promise<OAuthResult<RegisteredPublicClient>> {
    // require a JSON object request
    if (!plainRecord(request)) return failure('invalid_request', 'registration request must be an object');
    // require a bounded exact redirect list
    if (!Array.isArray(request.redirect_uris) || request.redirect_uris.length === 0 || request.redirect_uris.length > maxRedirectUris || request.redirect_uris.some(uri => typeof uri !== 'string' || !validHttpsUrl(uri)) || new Set(request.redirect_uris).size !== request.redirect_uris.length) return failure('invalid_request', 'redirect_uris must contain distinct absolute HTTPS callback URLs');
    // allow only public PKCE client authentication
    if (request.token_endpoint_auth_method !== undefined && request.token_endpoint_auth_method !== 'none') return failure('invalid_client', 'only public clients are supported');
    // allow only the supported grants
    if (request.grant_types !== undefined && (!Array.isArray(request.grant_types) || request.grant_types.length === 0 || request.grant_types.length > 2 || request.grant_types.some(grant => grant !== 'authorization_code' && grant !== 'refresh_token'))) return failure('invalid_request', 'unsupported grant_types');
    // require authorization-code capability when grants are explicit
    if (request.grant_types !== undefined && !request.grant_types.includes('authorization_code')) return failure('invalid_request', 'authorization_code grant is required');
    // allow only code responses
    if (request.response_types !== undefined && (!Array.isArray(request.response_types) || request.response_types.length !== 1 || request.response_types[0] !== 'code')) return failure('invalid_request', 'only code response_type is supported');
    // validate a bounded display name
    if (request.client_name !== undefined && (typeof request.client_name !== 'string' || request.client_name.length === 0 || request.client_name.length > maxNameLength || /[\u0000-\u001F\u007F]/u.test(request.client_name))) return failure('invalid_request', 'client_name is invalid');
    return await this.mutate<OAuthResult<RegisteredPublicClient>>(state => {
      // enforce the durable client limit
      if (Object.keys(state.clients).length >= maxClients) return { result: failure('invalid_request', 'client registration limit reached'), changed: false };
      const client: StoredClient = { id: opaqueToken(), issuedAt: this.now(), redirectUris: [...request.redirect_uris], ...(request.client_name === undefined ? {} : { name: request.client_name }) };
      state.clients[client.id] = client;
      return { result: { ok: true, value: publicClient(client) } as const, changed: true };
    });
  }

  // issue a one-time code after local authentication and consent
  async authorize(request: AuthorizationRequest, subject: LocalIntegrationSubject | undefined): Promise<OAuthResult<AuthorizationGrant>> {
    // require an authenticated bounded local subject
    if (!plainRecord(subject) || !validSubjectId(subject.id)) return failure('access_denied', 'local authentication is required', 403);
    // require a JSON object request
    if (!plainRecord(request)) return failure('invalid_request', 'authorization request must be an object');
    // require the OAuth authorization-code and PKCE S256 profile
    if (request.response_type !== 'code' || request.code_challenge_method !== 'S256' || typeof request.code_challenge !== 'string' || !challengePattern.test(request.code_challenge)) return failure('invalid_request', 'authorization code with PKCE S256 is required');
    // bind every grant to the configured MCP audience
    if (typeof request.resource !== 'string' || request.resource !== this.resource) return failure('invalid_request', 'resource does not identify this protected resource');
    // reject oversized state values before echoing them
    if (request.state !== undefined && (typeof request.state !== 'string' || request.state.length > maxStateLength)) return failure('invalid_request', 'state is invalid');
    // require bounded client and callback identifiers
    if (typeof request.client_id !== 'string' || !clientIdPattern.test(request.client_id) || !validHttpsUrl(request.redirect_uri)) return failure('invalid_request', 'client_id or redirect_uri is malformed');
    const scopes = parseScopes(request.scope);
    // return scope validation failures directly
    if (!scopes.ok) return scopes;
    return await this.mutate<OAuthResult<AuthorizationGrant>>(state => {
      const client = state.clients[request.client_id];
      // require a known public client
      if (client === undefined) return { result: failure('invalid_client', 'unknown client_id'), changed: false };
      // require exact pre-registered redirect matching
      if (!client.redirectUris.includes(request.redirect_uri)) return { result: failure('invalid_request', 'redirect_uri is not registered'), changed: false };
      // enforce the outstanding code limit
      if (Object.keys(state.authorizationCodes).length >= maxAuthorizationCodes) return { result: failure('invalid_request', 'authorization code limit reached'), changed: false };
      const code = opaqueToken();
      const expiresAt = this.now() + this.authorizationCodeTtlMs;
      state.authorizationCodes[hashSecret(code)] = { clientId: client.id, subjectId: subject.id, resource: this.resource, scopes: scopes.value, redirectUri: request.redirect_uri, codeChallenge: request.code_challenge, expiresAt };
      const grant: AuthorizationGrant = { code, redirect_uri: request.redirect_uri, expires_in: Math.ceil(this.authorizationCodeTtlMs / 1_000), ...(request.state === undefined ? {} : { state: request.state }) };
      return { result: { ok: true, value: grant } as const, changed: true };
    });
  }

  // exchange and consume one authorization code
  async exchangeCode(request: AuthorizationCodeTokenRequest): Promise<OAuthResult<OAuthTokenResponse>> {
    // require a JSON object request
    if (!plainRecord(request)) return failure('invalid_request', 'token request must be an object');
    // require the supported grant and bounded public inputs
    if (request.grant_type !== 'authorization_code' || typeof request.client_id !== 'string' || !clientIdPattern.test(request.client_id) || typeof request.code !== 'string' || !opaqueTokenPattern.test(request.code) || typeof request.code_verifier !== 'string' || !pkcePattern.test(request.code_verifier) || !validHttpsUrl(request.redirect_uri)) return failure('invalid_request', 'malformed authorization code exchange');
    // require the exact resource at the token endpoint
    if (request.resource !== this.resource) return failure('invalid_grant', 'resource does not match the authorization grant');
    return await this.mutate<OAuthResult<OAuthTokenResponse>>(state => {
      const found = findSecret(state.authorizationCodes, request.code);
      // reject unknown or already-consumed codes
      if (found === undefined) return { result: failure('invalid_grant', 'authorization code is invalid or already used'), changed: false };
      const [codeHash, grant] = found;
      delete state.authorizationCodes[codeHash];
      const computedChallenge = createHash('sha256').update(request.code_verifier).digest('base64url');
      // consume the code on every attempted exchange and verify every binding
      if (grant.expiresAt <= this.now() || grant.clientId !== request.client_id || grant.redirectUri !== request.redirect_uri || grant.resource !== request.resource || !constantTimeEqual(grant.codeChallenge, computedChallenge)) return { result: failure('invalid_grant', 'authorization code binding is invalid'), changed: true };
      const issued = this.issueTokenPair(state, grant.clientId, grant.subjectId, grant.resource, grant.scopes);
      // surface capacity failure without restoring the consumed code
      if (!issued.ok) return { result: issued, changed: true };
      return { result: issued, changed: true };
    });
  }

  // exchange one refresh token and rotate its family
  async refresh(request: RefreshTokenRequest): Promise<OAuthResult<OAuthTokenResponse>> {
    // require a JSON object request
    if (!plainRecord(request)) return failure('invalid_request', 'token request must be an object');
    // require the supported grant and bounded token inputs
    if (request.grant_type !== 'refresh_token') return failure('unsupported_grant_type', 'only refresh_token is accepted by this method');
    // reject malformed public identifiers and opaque tokens
    if (typeof request.client_id !== 'string' || !clientIdPattern.test(request.client_id) || typeof request.refresh_token !== 'string' || !opaqueTokenPattern.test(request.refresh_token)) return failure('invalid_request', 'malformed refresh token exchange');
    // require the exact configured audience
    if (request.resource !== this.resource) return failure('invalid_grant', 'resource does not match the refresh grant');
    const requestedScopes = request.scope === undefined ? undefined : parseScopes(request.scope);
    // return scope validation failures directly
    if (requestedScopes !== undefined && !requestedScopes.ok) return requestedScopes;
    return await this.mutate<OAuthResult<OAuthTokenResponse>>(state => {
      const active = findSecret(state.refreshTokens, request.refresh_token);
      // detect replay and revoke every active descendant
      if (active === undefined) {
        const spent = findSecret(state.spentRefreshTokens, request.refresh_token);
        // reject unknown tokens without a durable mutation
        if (spent === undefined) return { result: failure('invalid_grant', 'refresh token is invalid'), changed: false };
        const replay = spent[1];
        revokeFamily(state, replay.familyId, replay.expiresAt);
        return { result: failure('invalid_grant', 'refresh token replay detected'), changed: true };
      }
      const [refreshHash, grant] = active;
      // reject expired, revoked, or mismatched grants without enabling token invalidation attacks
      if (grant.expiresAt <= this.now() || state.revokedRefreshFamilies[grant.familyId] !== undefined || grant.clientId !== request.client_id || grant.resource !== request.resource) return { result: failure('invalid_grant', 'refresh token binding is invalid'), changed: false };
      const scopes = requestedScopes?.value ?? grant.scopes;
      // prevent refresh-time privilege expansion
      if (!scopesWithin(scopes, grant.scopes)) return { result: failure('invalid_scope', 'requested scope exceeds the original grant'), changed: false };
      // preserve the active grant when a new token pair cannot be recorded safely
      if (Object.keys(state.accessTokens).length >= maxAccessTokens || Object.keys(state.spentRefreshTokens).length >= maxSpentRefreshTokens) return { result: failure('invalid_grant', 'token storage limit reached'), changed: false };
      delete state.refreshTokens[refreshHash];
      state.spentRefreshTokens[refreshHash] = { familyId: grant.familyId, expiresAt: grant.expiresAt };
      const issued = this.issueTokenPair(state, grant.clientId, grant.subjectId, grant.resource, scopes, grant.familyId, grant.expiresAt);
      return { result: issued, changed: true };
    });
  }

  // authenticate one opaque OAuth access token
  async authenticateAccessToken(token: string, request: AccessAuthenticationRequest): Promise<OAuthResult<IntegrationPrincipal>> {
    // reject malformed bearer inputs before durable lookup
    if (typeof token !== 'string' || !opaqueTokenPattern.test(token)) return failure('invalid_token', 'access token is malformed', 401);
    // require a JSON object authentication request
    if (!plainRecord(request)) return failure('invalid_request', 'authentication request must be an object');
    // reject requests for another resource
    if (request.resource !== this.resource) return failure('invalid_token', 'access token audience does not match', 401);
    // reject unsupported required scope values
    if (request.scopes !== undefined && (!Array.isArray(request.scopes) || request.scopes.length > supportedIntegrationScopes.length || request.scopes.some(scope => typeof scope !== 'string' || !supportedScopeSet.has(scope)))) return failure('invalid_scope', 'required scope is unsupported');
    return await this.mutate<OAuthResult<IntegrationPrincipal>>(state => {
      const found = findSecret(state.accessTokens, token);
      // reject missing or expired bearer tokens
      if (found === undefined || found[1].expiresAt <= this.now()) return { result: failure('invalid_token', 'access token is invalid or expired', 401), changed: false };
      const grant = found[1];
      // enforce the exact token audience
      if (grant.resource !== request.resource) return { result: failure('invalid_token', 'access token audience does not match', 401), changed: false };
      // enforce all required capabilities
      if (request.scopes !== undefined && !scopesWithin(request.scopes, grant.scopes)) return { result: failure('insufficient_scope', 'access token lacks a required scope', 403), changed: false };
      return { result: { ok: true, value: principal(grant) } as const, changed: false };
    });
  }

  // authenticate one registry-backed per-lease Realtime principal
  authenticateRealtimeToken(token: string): OAuthResult<IntegrationPrincipal> {
    // fail closed when no lease registry is connected
    if (this.realtimeAuthenticator === undefined) return failure('invalid_token', 'realtime authentication is not configured', 401);
    // bound raw input before delegating to the digest-only registry
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return failure('invalid_token', 'realtime token is invalid', 401);
    const principal = this.realtimeAuthenticator(token);
    // require the registry to return an exact Realtime lease identity
    if (principal?.authentication !== 'realtime' || principal.stableOwnerKey === undefined || principal.leaseKey === undefined) return failure('invalid_token', 'realtime token is invalid or expired', 401);
    return { ok: true, value: principal };
  }

  // revoke a refresh family idempotently
  async revokeRefreshToken(token: string): Promise<OAuthResult<{ revoked: true }>> {
    // avoid storage scans for malformed input
    if (typeof token !== 'string' || !opaqueTokenPattern.test(token)) return { ok: true, value: { revoked: true } };
    return await this.mutate<OAuthResult<{ revoked: true }>>(state => {
      const active = findSecret(state.refreshTokens, token);
      const spent = active === undefined ? findSecret(state.spentRefreshTokens, token) : undefined;
      const record = active?.[1] ?? spent?.[1];
      // preserve idempotent OAuth revocation for unknown tokens
      if (record === undefined) return { result: { ok: true, value: { revoked: true } } as const, changed: false };
      revokeFamily(state, record.familyId, record.expiresAt);
      return { result: { ok: true, value: { revoked: true } } as const, changed: true };
    });
  }

  // copy only non-secret principal fields into audit context
  auditData(value: IntegrationPrincipal): IntegrationAuditData {
    return { authentication: value.authentication, subjectId: value.subjectId, audience: value.audience, scopes: [...value.scopes], ...(value.clientId === undefined ? {} : { clientId: value.clientId }) };
  }

  // issue one access token and rotating refresh token
  private issueTokenPair(state: StoredState, clientId: string, subjectId: string, resource: string, scopes: PublicIntegrationScope[], familyId = opaqueToken(), refreshExpiresAt = this.now() + this.refreshTokenTtlMs): OAuthResult<OAuthTokenResponse> {
    // enforce active token boundaries before recording new secrets
    if (Object.keys(state.accessTokens).length >= maxAccessTokens || Object.keys(state.refreshTokens).length >= maxRefreshTokens) return failure('invalid_grant', 'token storage limit reached');
    const now = this.now();
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const accessExpiresAt = now + this.accessTokenTtlMs;
    state.accessTokens[hashSecret(accessToken)] = { clientId, subjectId, resource, scopes: [...scopes], issuedAt: now, expiresAt: accessExpiresAt };
    state.refreshTokens[hashSecret(refreshToken)] = { clientId, subjectId, resource, scopes: [...scopes], issuedAt: now, expiresAt: refreshExpiresAt, familyId };
    return { ok: true, value: { access_token: accessToken, token_type: 'Bearer', expires_in: Math.max(1, Math.ceil((accessExpiresAt - now) / 1_000)), refresh_token: refreshToken, refresh_token_expires_in: Math.max(1, Math.ceil((refreshExpiresAt - now) / 1_000)), scope: scopes.join(' ') } };
  }

  // serialize each durable read-modify-write operation
  private async mutate<T>(change: (state: StoredState) => { result: T; changed: boolean }): Promise<T> {
    const operation = this.mutation.then(async () => {
      const state = await this.read();
      const pruned = pruneState(state, this.now());
      const outcome = change(state);
      // persist explicit mutations and expiry pruning atomically
      if (outcome.changed || pruned) await this.write(state);
      return outcome.result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // load and validate current durable state
  private async read(): Promise<StoredState> {
    let serialized: string;
    try {
      serialized = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      // treat only a missing store as new state
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    // reject oversized state before JSON parsing
    if (Buffer.byteLength(serialized) > maxSerializedBytes) throw new Error('integration auth state exceeds storage limits');
    return parseState(JSON.parse(serialized) as unknown);
  }

  // atomically replace durable state using restrictive permissions
  private async write(state: StoredState): Promise<void> {
    const serialized = JSON.stringify(state);
    // enforce the aggregate serialized boundary
    if (Buffer.byteLength(serialized) > maxSerializedBytes) throw new Error('integration auth state exceeds storage limits');
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const next = `${this.stateFile}.next-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(next, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(next, this.stateFile);
    } catch (error) {
      // remove only this operation's unpublished temporary file
      await rm(next, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
