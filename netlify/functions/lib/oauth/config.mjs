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

// Upstream IdP (Redpanda Cloud Auth0) mode resolution — FAIL-CLOSED.
//
// The dev mock issues canned identities, so it must NEVER be reachable in a
// real deployment by accident. Mock is only allowed under an explicit dev
// signal (NETLIFY_DEV, or MCP_OAUTH_ALLOW_MOCK=true). Anything that would
// otherwise fall back to mock (e.g. a prod deploy missing the client_id)
// resolves to `null` = misconfigured, and the AS refuses the flow rather than
// handing out mock tokens.
export function resolveUpstreamMode(env = process.env) {
  const allowMock = env.NETLIFY_DEV === 'true' || env.MCP_OAUTH_ALLOW_MOCK === 'true'
  const hasClientId = !!env.REDPANDA_OAUTH_CLIENT_ID
  const explicit = env.MCP_OAUTH_UPSTREAM
  if (explicit === 'auth0') return hasClientId ? 'auth0' : null // explicit auth0 needs a client_id
  if (explicit === 'mock') return allowMock ? 'mock' : null // mock only when explicitly allowed
  if (hasClientId) return 'auth0'
  if (allowMock) return 'mock'
  return null // unconfigured (e.g. prod without client_id) → fail closed
}

export const UPSTREAM_MODE = resolveUpstreamMode()
export const UPSTREAM_MISCONFIGURED = UPSTREAM_MODE === null
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
