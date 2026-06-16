// Upstream IdP federation (the human login leg).
//   mode 'auth0' — real Redpanda Cloud Auth0 (public client + PKCE).
//   mode 'mock'  — dev stand-in so the flow runs with no client_id yet.

import { jwtVerify, createRemoteJWKSet, decodeJwt } from 'jose'
import { UPSTREAM_MODE, AUTH0_ISSUER, AUTH0_CLIENT_ID, PATHS } from './config.mjs'

let jwksCache = null
function auth0Jwks() {
  if (!jwksCache) jwksCache = createRemoteJWKSet(new URL('.well-known/jwks.json', AUTH0_ISSUER))
  return jwksCache
}

// URL we redirect the user to in order to authenticate upstream.
export function buildAuthorizeUrl({ origin, state, redirectUri, codeChallenge }) {
  if (UPSTREAM_MODE === 'auth0') {
    if (!AUTH0_CLIENT_ID) throw new Error('REDPANDA_OAUTH_CLIENT_ID required for auth0 mode')
    const u = new URL('authorize', AUTH0_ISSUER)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', AUTH0_CLIENT_ID)
    u.searchParams.set('redirect_uri', redirectUri)
    u.searchParams.set('scope', 'openid email profile')
    u.searchParams.set('state', state)
    u.searchParams.set('code_challenge', codeChallenge)
    u.searchParams.set('code_challenge_method', 'S256')
    return u.toString()
  }
  if (UPSTREAM_MODE === 'mock') {
    const u = new URL(PATHS.mockIdp, origin)
    u.searchParams.set('state', state)
    u.searchParams.set('redirect_uri', redirectUri)
    return u.toString()
  }
  throw new Error('upstream IdP not configured') // fail-closed (see config.resolveUpstreamMode)
}

// Exchange the upstream code for the user's verified identity claims.
export async function exchangeCode({ code, codeVerifier, redirectUri }) {
  if (UPSTREAM_MODE === 'auth0') {
    const res = await fetch(new URL('oauth/token', AUTH0_ISSUER), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: AUTH0_CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new Error(`upstream token exchange failed: ${res.status}`)
    const tok = await res.json()
    // Validate the ID token against Auth0's JWKS (sig/iss/aud/exp).
    const { payload } = await jwtVerify(tok.id_token, auth0Jwks(), {
      issuer: AUTH0_ISSUER,
      audience: AUTH0_CLIENT_ID,
    })
    return {
      sub: payload.sub,
      email: payload.email,
      email_verified: payload.email_verified === true,
      org_id: payload.org_id || null,
      org_name: payload.org_name || null,
    }
  }
  if (UPSTREAM_MODE === 'mock') {
    // canned verified identity (dev only)
    return { sub: 'mock|123', email: 'spike@redpanda.com', email_verified: true, org_id: 'org_mock', org_name: 'Mock Org' }
  }
  throw new Error('upstream IdP not configured') // fail-closed
}

export { UPSTREAM_MODE }
