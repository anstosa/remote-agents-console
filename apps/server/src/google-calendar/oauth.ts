import { readGoogleObject } from './bounded-response.js';
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import type { GooglePrincipal, GoogleTokens } from './provider-types.js';
import { GoogleCalendarError } from './provider-types.js';

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const jwksEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const calendarScope = 'https://www.googleapis.com/auth/calendar.app.created';
const transactionLifetimeMs = 10 * 60 * 1_000;
const maximumTransactions = 128;

type OAuthTransaction = {
  state: string;
  sessionId: string;
  reservationGeneration: string;
  clientGeneration: string;
  verifier: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
};

export type OAuthConfiguration = { clientId: string; clientSecret: string; redirectUri: string; clientGeneration: string };

export class OAuthTransactions {
  private readonly transactions = new Map<string, OAuthTransaction>();

  // create one controller-bound single-use authorization transaction
  begin(config: OAuthConfiguration, sessionId: string, reservationGeneration: string, now = Date.now()): { url: string; transaction: OAuthTransaction } {
    this.prune(now);
    // fail closed instead of evicting a live consent transaction
    if (this.transactions.size >= maximumTransactions) throw new GoogleCalendarError('oauth_transaction_capacity', 503);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const transaction = { state, sessionId, reservationGeneration, clientGeneration: config.clientGeneration, verifier, nonce, createdAt: now, expiresAt: now + transactionLifetimeMs };
    this.transactions.set(state, transaction);
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', `openid email ${calendarScope}`);
    url.searchParams.set('access_type', 'offline');
    // renew consent when a prior remote grant outlives locally removed credentials
    url.searchParams.set('prompt', 'consent select_account');
    url.searchParams.set('include_granted_scopes', 'false');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    return { url: url.toString(), transaction };
  }

  // atomically consume one exact callback state before external work
  consume(state: string, now = Date.now()): OAuthTransaction {
    this.prune(now);
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    // reject absent and expired state without disclosing its value
    if (transaction === undefined || transaction.expiresAt <= now) throw new GoogleCalendarError('oauth_transaction_invalid', 400);
    return transaction;
  }

  // prune every expired consent transaction at bounded entry points
  private prune(now: number): void {
    for (const [state, transaction] of this.transactions) {
      // remove only transactions whose fixed lifetime elapsed
      if (transaction.expiresAt <= now) this.transactions.delete(state);
    }
  }
}

// exchange one authorization code without retaining response bodies
export async function exchangeAuthorizationCode(config: OAuthConfiguration, transaction: OAuthTransaction, code: string, fetcher: typeof fetch, now = Date.now()): Promise<{ tokens: GoogleTokens; idToken: string }> {
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, code_verifier: transaction.verifier, grant_type: 'authorization_code', redirect_uri: config.redirectUri });
  let response: Response;
  let payload: Record<string, any>;
  try {
    response = await fetcher(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    payload = await readGoogleObject(response, 128 * 1024);
  } catch (error) {
    // preserve bounded provider errors and normalize transport failures
    if (error instanceof GoogleCalendarError) throw error;
    throw new GoogleCalendarError('google_unavailable', 503);
  }
  // require the documented successful token fields
  if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token.length > 32_768 || typeof payload.id_token !== 'string' || payload.id_token.length > 65_536 || typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) throw new GoogleCalendarError(response.status === 401 ? 'authorization_required' : 'oauth_transaction_invalid', 400);
  const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token.length <= 8192 ? payload.refresh_token : undefined;
  return { tokens: { accessToken: payload.access_token, ...(refreshToken === undefined ? {} : { refreshToken }), expiresAt: now + Math.min(payload.expires_in, 86_400) * 1_000 }, idToken: payload.id_token };
}

// refresh an existing grant without changing its identity
export async function refreshAuthorization(config: OAuthConfiguration, refreshToken: string, fetcher: typeof fetch, now = Date.now()): Promise<GoogleTokens> {
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  let response: Response;
  let payload: Record<string, any>;
  try {
    response = await fetcher(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    payload = await readGoogleObject(response, 128 * 1024);
  } catch (error) {
    // preserve bounded provider errors and normalize transport failures
    if (error instanceof GoogleCalendarError) throw error;
    throw new GoogleCalendarError('google_unavailable', 503);
  }
  // distinguish expired grants from transient provider failures
  if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token.length > 32_768 || typeof payload.expires_in !== 'number') throw new GoogleCalendarError(response.status === 400 || response.status === 401 ? 'authorization_required' : 'google_unavailable', 503);
  return { accessToken: payload.access_token, refreshToken, expiresAt: now + Math.min(Math.max(payload.expires_in, 1), 86_400) * 1_000 };
}

// verify one google oidc token against its declared signing key
export async function validateIdToken(idToken: string, clientId: string, nonce: string, fetcher: typeof fetch, now = Date.now()): Promise<GooglePrincipal> {
  const pieces = idToken.split('.');
  // require the compact jwt shape
  if (pieces.length !== 3 || pieces.some(piece => piece.length === 0 || piece.length > 16_384)) throw new GoogleCalendarError('oauth_transaction_invalid', 400);
  const header = decodeJson(pieces[0]!);
  const claims = decodeJson(pieces[1]!);
  // accept only google's rsa signing contract
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256) throw new GoogleCalendarError('oauth_transaction_invalid', 400);
  let response: Response;
  let document: Record<string, any>;
  try {
    response = await fetcher(jwksEndpoint, { headers: { accept: 'application/json' } });
    document = await readGoogleObject(response, 256 * 1024);
  } catch (error) {
    // preserve bounded provider errors and normalize transport failures
    if (error instanceof GoogleCalendarError) throw error;
    throw new GoogleCalendarError('google_unavailable', 503);
  }
  // require one bounded matching public jwk
  if (!response.ok || !Array.isArray(document.keys) || document.keys.length > 64) throw new GoogleCalendarError('google_unavailable', 503);
  const jwk = document.keys.find(candidate => candidate !== null && typeof candidate === 'object' && (candidate as Record<string, unknown>).kid === header.kid) as JsonWebKey | undefined;
  // reject unknown signing keys
  if (jwk === undefined) throw new GoogleCalendarError('oauth_transaction_invalid', 400);
  let signatureValid = false;
  try { signatureValid = verify('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(pieces[2]!, 'base64url')); } catch { signatureValid = false; }
  // validate signature and identity claims together
  if (!signatureValid || !validClaims(claims, clientId, nonce, now)) throw new GoogleCalendarError('oauth_transaction_invalid', 400);
  return { sub: claims.sub as string, ...(typeof claims.email === 'string' && claims.email.length <= 320 && !/[\u0000-\u001f\u007f]/u.test(claims.email) ? { email: claims.email } : {}) };
}

// validate bounded oidc identity and time claims
function validClaims(claims: Record<string, unknown>, clientId: string, nonce: string, now: number): boolean {
  const seconds = Math.floor(now / 1_000);
  const audience = claims.aud;
  const audienceValid = audience === clientId || Array.isArray(audience) && audience.length === 1 && audience[0] === clientId;
  return (claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com') && audienceValid && typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(claims.sub) && claims.nonce === nonce && typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > seconds && (claims.nbf === undefined || typeof claims.nbf === 'number' && Number.isFinite(claims.nbf) && claims.nbf <= seconds + 60);
}

// decode one bounded jwt object
function decodeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    // reject non-object jwt sections
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch { throw new GoogleCalendarError('oauth_transaction_invalid', 400); }
}
