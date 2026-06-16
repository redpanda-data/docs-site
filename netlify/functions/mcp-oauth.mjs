// Docs MCP OAuth 2.1 Authorization Server.
// ----------------------------------------
// Our service is the AS for MCP clients (ChatGPT, Claude, …) and federates the
// human login upstream to the Redpanda Cloud IdP (Auth0). It issues our own
// signed access tokens; the /mcp resource server validates them.
//
// Implemented (Milestone 1): discovery, JWKS, /authorize (PKCE), /callback
// (federation), /token (authorization_code + PKCE).
// Deferred: DCR/CIMD client registration (M2), refresh_token grant (M3),
// consent screen, revocation.

import { getJwks, signAccessToken } from './lib/oauth/keys.mjs'
import { putAuthRequest, takeAuthRequest, putAuthCode, takeAuthCode } from './lib/oauth/store.mjs'
import { buildAuthorizeUrl, exchangeCode, UPSTREAM_MODE } from './lib/oauth/upstream.mjs'
import { verifyChallenge, generatePair } from './lib/oauth/pkce.mjs'
import { PATHS, SCOPES, ACCESS_TOKEN_TTL_SEC, REQUIRE_WORK_EMAIL, endpoints } from './lib/oauth/config.mjs'
import { isWorkEmail, emailDomain } from './lib/auth.mjs'
import { recordUser } from './lib/store.mjs'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
const redirect = (location) => new Response(null, { status: 302, headers: { Location: location } })

// Send an OAuth error back to the downstream client's redirect_uri.
function clientError(redirectUri, state, error, description) {
  const u = new URL(redirectUri)
  u.searchParams.set('error', error)
  if (description) u.searchParams.set('error_description', description)
  if (state) u.searchParams.set('state', state)
  return redirect(u.toString())
}

export default async (request) => {
  const url = new URL(request.url)
  const origin = url.origin
  const path = url.pathname
  const q = url.searchParams
  const ep = endpoints(origin)

  // -------- Discovery (RFC 8414) --------
  if (path === PATHS.metadata) {
    return json({
      issuer: ep.issuer,
      authorization_endpoint: ep.authorization_endpoint,
      token_endpoint: ep.token_endpoint,
      jwks_uri: ep.jwks_uri,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'], // + refresh_token (M3)
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES,
    })
  }

  if (path === PATHS.jwks) return json(await getJwks())

  // -------- /authorize: downstream client starts the flow --------
  if (path === PATHS.authorize) {
    const clientId = q.get('client_id')
    const redirectUri = q.get('redirect_uri')
    const codeChallenge = q.get('code_challenge')
    if (!clientId || !redirectUri) return json({ error: 'invalid_request', error_description: 'client_id and redirect_uri required' }, 400)
    if (!codeChallenge || q.get('code_challenge_method') !== 'S256') {
      return clientError(redirectUri, q.get('state'), 'invalid_request', 'PKCE S256 required')
    }

    const upstream = generatePair() // our PKCE for the upstream leg
    const reqId = await putAuthRequest({
      clientId,
      clientRedirectUri: redirectUri,
      clientState: q.get('state') || '',
      clientCodeChallenge: codeChallenge,
      upstreamVerifier: upstream.verifier,
    })

    return redirect(
      buildAuthorizeUrl({ origin, state: reqId, redirectUri: ep.callback_uri, codeChallenge: upstream.challenge })
    )
  }

  // -------- Dev-only mock upstream --------
  if (path === PATHS.mockIdp) {
    if (UPSTREAM_MODE !== 'mock') return json({ error: 'not_found' }, 404)
    const back = new URL(q.get('redirect_uri'))
    back.searchParams.set('code', 'mock-upstream-code')
    back.searchParams.set('state', q.get('state'))
    return redirect(back.toString())
  }

  // -------- /callback: upstream returns; we mint our own code --------
  if (path === PATHS.callback) {
    const authReq = await takeAuthRequest(q.get('state'))
    if (!q.get('code') || !authReq) return json({ error: 'invalid_request', error_description: 'unknown or expired state' }, 400)

    let user
    try {
      user = await exchangeCode({ code: q.get('code'), codeVerifier: authReq.upstreamVerifier, redirectUri: ep.callback_uri })
    } catch (e) {
      return clientError(authReq.clientRedirectUri, authReq.clientState, 'server_error', 'upstream login failed')
    }

    const domain = emailDomain(user.email)
    if (REQUIRE_WORK_EMAIL && user.email && !isWorkEmail(domain).ok) {
      return clientError(authReq.clientRedirectUri, authReq.clientState, 'access_denied', 'A work account is required')
    }

    // Lead capture (best-effort, non-blocking).
    recordUser({ sub: user.sub, email: user.email, domain }).catch(() => {})

    const code = await putAuthCode({
      clientId: authReq.clientId,
      clientRedirectUri: authReq.clientRedirectUri,
      clientCodeChallenge: authReq.clientCodeChallenge,
      user: { sub: user.sub, email: user.email, email_verified: user.email_verified, org_id: user.org_id, org_name: user.org_name, domain },
    })

    const back = new URL(authReq.clientRedirectUri)
    back.searchParams.set('code', code)
    if (authReq.clientState) back.searchParams.set('state', authReq.clientState)
    return redirect(back.toString())
  }

  // -------- /token: exchange our code (+ PKCE) for an access token --------
  if (path === PATHS.token && request.method === 'POST') {
    const ct = request.headers.get('content-type') || ''
    const body = ct.includes('application/json')
      ? await request.json().catch(() => ({}))
      : Object.fromEntries(new URLSearchParams(await request.text()))

    if (body.grant_type !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400)
    const rec = await takeAuthCode(body.code)
    if (!rec) return json({ error: 'invalid_grant', error_description: 'invalid or used code' }, 400)
    if (body.redirect_uri !== rec.clientRedirectUri) return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400)
    if (!verifyChallenge(body.code_verifier, rec.clientCodeChallenge)) {
      return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
    }

    const u = rec.user
    const access_token = await signAccessToken(
      { sub: u.sub, email: u.email, email_verified: u.email_verified, org_id: u.org_id, org_name: u.org_name, scope: SCOPES.join(' ') },
      { issuer: ep.issuer, audience: `${origin}/mcp`, ttlSec: ACCESS_TOKEN_TTL_SEC }
    )
    return json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, scope: SCOPES.join(' ') })
  }

  return json({ error: 'not_found', path }, 404)
}

export const config = {
  path: [PATHS.metadata, PATHS.jwks, PATHS.authorize, PATHS.token, PATHS.callback, PATHS.mockIdp],
  preferStatic: false,
}
