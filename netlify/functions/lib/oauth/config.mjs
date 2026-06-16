// Central config for the docs MCP OAuth 2.1 Authorization Server.
// The issuer is derived per-request from the origin (works across prod +
// deploy previews); everything else is env-tunable.

export const PATHS = {
  metadata: '/.well-known/oauth-authorization-server',
  jwks: '/.well-known/jwks.json',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  callback: '/mcp/callback', // matches the redirect URI registered in Auth0
  mockIdp: '/oauth/mock-idp/authorize', // dev only
}

export const SCOPES = ['openid', 'email', 'profile']
export const ACCESS_TOKEN_TTL_SEC = Number(process.env.MCP_OAUTH_ACCESS_TTL || 3600)
export const AUTH_REQUEST_TTL_SEC = 600
export const AUTH_CODE_TTL_SEC = 60

// Upstream IdP (Redpanda Cloud Auth0). Defaults to 'mock' for local dev until a
// real client_id is configured.
export const UPSTREAM_MODE =
  process.env.MCP_OAUTH_UPSTREAM || (process.env.REDPANDA_OAUTH_CLIENT_ID ? 'auth0' : 'mock')
export const AUTH0_ISSUER = process.env.REDPANDA_OAUTH_ISSUER || 'https://auth.prd.cloud.redpanda.com/'
export const AUTH0_CLIENT_ID = process.env.REDPANDA_OAUTH_CLIENT_ID // public client, no secret
export const REQUIRE_WORK_EMAIL = process.env.REQUIRE_WORK_EMAIL !== 'false'

// AS issuer = the public origin of the request (e.g. https://docs.redpanda.com).
export function issuerFor(origin) {
  return origin
}
export function endpoints(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${PATHS.authorize}`,
    token_endpoint: `${origin}${PATHS.token}`,
    jwks_uri: `${origin}${PATHS.jwks}`,
    callback_uri: `${origin}${PATHS.callback}`,
  }
}
