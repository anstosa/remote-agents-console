export const supportedIntegrationScopes = [
  'status:read',
  'logs:read',
  'files:read',
  'prompts:write',
  'agents:control',
  'stack:operate',
  'review:write',
  'admin:dangerous'
] as const;

export const SUPPORTED_INTEGRATION_SCOPES = supportedIntegrationScopes;

export type IntegrationScope = typeof supportedIntegrationScopes[number];

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'access_denied'
  | 'invalid_token'
  | 'insufficient_scope';

export type OAuthFailure = {
  ok: false;
  error: OAuthErrorCode;
  error_description: string;
  status: 400 | 401 | 403;
};

export type OAuthSuccess<T> = { ok: true; value: T };
export type OAuthResult<T> = OAuthSuccess<T> | OAuthFailure;

export type OAuthProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ['header'];
  scopes_supported: readonly IntegrationScope[];
  resource_name: string;
};

export type OAuthAuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: ['code'];
  grant_types_supported: ['authorization_code', 'refresh_token'];
  token_endpoint_auth_methods_supported: ['none'];
  code_challenge_methods_supported: ['S256'];
  scopes_supported: readonly IntegrationScope[];
};

export type DynamicClientRegistrationRequest = {
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: 'none';
  grant_types?: Array<'authorization_code' | 'refresh_token'>;
  response_types?: Array<'code'>;
};

export type RegisteredPublicClient = {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
};

export type LocalIntegrationSubject = { id: string };

export type AuthorizationRequest = {
  response_type: 'code';
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string | readonly string[];
  code_challenge: string;
  code_challenge_method: 'S256';
  state?: string;
};

export type AuthorizationGrant = {
  code: string;
  redirect_uri: string;
  expires_in: number;
  state?: string;
};

export type AuthorizationCodeTokenRequest = {
  grant_type: 'authorization_code';
  client_id: string;
  code: string;
  redirect_uri: string;
  code_verifier: string;
  resource: string;
};

export type RefreshTokenRequest = {
  grant_type: 'refresh_token';
  client_id: string;
  refresh_token: string;
  resource: string;
  scope?: string | readonly string[];
};

export type OAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
};

export type AccessAuthenticationRequest = {
  resource: string;
  scopes?: readonly IntegrationScope[];
};

/**
 * Who calls the gateway: an OAuth client, the Realtime voice assistant, or the Conductor (an Agent
 * holding a console token, ADR 0018). `places` limits the Worktrees it may read to those it admits.
 */
export type IntegrationPrincipal = {
  authentication: 'oauth' | 'realtime' | 'conductor';
  subjectId: string;
  audience: string;
  scopes: IntegrationScope[];
  clientId?: string;
  expiresAt?: number;
  places?: (worktree: { id: string; projectId: string }) => boolean;
};

export type IntegrationAuditData = {
  authentication: IntegrationPrincipal['authentication'];
  subjectId: string;
  audience: string;
  scopes: IntegrationScope[];
  clientId?: string;
};
