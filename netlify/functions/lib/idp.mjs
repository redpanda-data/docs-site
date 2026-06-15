// Redpanda Cloud IdP token validation for the MCP server.
// --------------------------------------------------------
// Impure (network). Validates an incoming OAuth access token by calling the
// Cloud IdP's /userinfo endpoint and returns the user's claims (sub, email,
// email_verified, …). This works with the opaque access tokens Auth0 issues
// when no custom API/audience is registered.
//
// Production hardening (needs the identity team): register an Auth0 API for the
// MCP resource so access tokens are audience-bound JWTs, then validate via JWKS
// for audience binding instead of (or in addition to) /userinfo.

import { hashToken } from './auth.mjs'

const ISSUER = process.env.REDPANDA_OAUTH_ISSUER || 'https://auth.prd.cloud.redpanda.com/'
const USERINFO_URL =
  process.env.REDPANDA_OAUTH_USERINFO || new URL('/userinfo', ISSUER).toString()

const USERINFO_TIMEOUT_MS = 6_000
const CACHE_TTL_MS = 5 * 60 * 1000

// Per-token cache, reused across warm invocations, to avoid hitting /userinfo on
// every request. Keyed by token hash; never stores the raw token.
const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (hit.exp <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return hit.claims
}

// Validate the bearer token. Returns the claims object on success, or null if
// the token is missing/invalid/expired or the IdP is unreachable.
export async function validateToken(token) {
  if (!token) return null
  const key = hashToken(token)

  const cached = cacheGet(key)
  if (cached !== undefined) return cached

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), USERINFO_TIMEOUT_MS)
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      // Negatively cache invalid tokens briefly to blunt repeated bad calls.
      cache.set(key, { claims: null, exp: Date.now() + 30_000 })
      return null
    }
    const claims = await res.json()
    cache.set(key, { claims, exp: Date.now() + CACHE_TTL_MS })
    return claims
  } catch (e) {
    console.warn('[oauth] userinfo validation failed', { error: e?.message })
    return null
  } finally {
    clearTimeout(t)
  }
}
