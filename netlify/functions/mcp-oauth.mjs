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
import {
  putAuthRequest, takeAuthRequest, putAuthCode, takeAuthCode,
  putRefresh, getRefresh, consumeRefresh, putFamily, getFamily, revokeFamily,
} from './lib/oauth/store.mjs'
import { buildAuthorizeUrl, exchangeCode, UPSTREAM_MODE } from './lib/oauth/upstream.mjs'
import { verifyChallenge, generatePair } from './lib/oauth/pkce.mjs'
import { registerClient, getClient, redirectUriAllowed, isCimdClientId } from './lib/oauth/clients.mjs'
import { hashRefresh, newRefreshToken, newFamilyId, decideRefresh } from './lib/oauth/refresh.mjs'
import { loginInterstitialHtml } from './lib/oauth/pages.mjs'
import { allowRegister, allowCimd, clientIp } from './lib/oauth/ratelimit.mjs'
import { PATHS, SCOPES, ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC, REQUIRE_WORK_EMAIL, UPSTREAM_MISCONFIGURED, SIGNUP_URL, PRIVACY_URL, LOGIN_INTERSTITIAL, endpoints } from './lib/oauth/config.mjs'
import { isWorkEmail, emailDomain } from './lib/auth.mjs'
import { recordUser } from './lib/store.mjs'

// CORS for the endpoints browser-based OAuth clients fetch cross-origin
// (discovery, JWKS, /token, /register). Public discovery + public-client token
// exchange, so a wildcard origin is appropriate.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })
const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
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

  // CORS preflight for browser-based clients (discovery, JWKS, /token, /register).
  // /authorize and /callback are top-level browser navigations, not fetches, so
  // they don't need it — but a blanket 204 here is harmless.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
  }

  // -------- Discovery (RFC 8414) --------
  if (path === PATHS.metadata) {
    return json({
      issuer: ep.issuer,
      authorization_endpoint: ep.authorization_endpoint,
      token_endpoint: ep.token_endpoint,
      jwks_uri: ep.jwks_uri,
      registration_endpoint: ep.registration_endpoint,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES,
      client_id_metadata_document_supported: true, // CIMD (clients may use a URL client_id)
    })
  }

  if (path === PATHS.jwks) return json(await getJwks())

  // -------- /register: Dynamic Client Registration (RFC 7591) --------
  if (path === PATHS.register && request.method === 'POST') {
    const rl = await allowRegister(clientIp(request))
    if (!rl.allowed) {
      return json({ error: 'rate_limited', error_description: 'too many registrations; try again later' }, 429)
    }
    const meta = await request.json().catch(() => null)
    if (!meta) return json({ error: 'invalid_client_metadata', error_description: 'JSON body required' }, 400)
    try {
      return json(await registerClient(meta), 201)
    } catch (e) {
      return json({ error: e.code || 'invalid_client_metadata', error_description: e.message }, 400)
    }
  }

  // Fail closed: if no real upstream is configured and dev-mock isn't explicitly
  // allowed (e.g. a prod deploy missing the client_id), refuse the flow rather
  // than issuing mock identities. Discovery + JWKS above stay available.
  if (UPSTREAM_MISCONFIGURED) {
    return json({ error: 'server_error', error_description: 'authorization server upstream not configured' }, 503)
  }

  // -------- /authorize: downstream client starts the flow --------
  if (path === PATHS.authorize) {
    const clientId = q.get('client_id')
    const redirectUri = q.get('redirect_uri')
    const codeChallenge = q.get('code_challenge')
    if (!clientId || !redirectUri) return json({ error: 'invalid_request', error_description: 'client_id and redirect_uri required' }, 400)

    // Resolve + validate the client and redirect_uri BEFORE any redirect — never
    // redirect to an unvalidated URI (open-redirect / code-injection guard).
    // CIMD resolution makes an outbound fetch, so rate-limit it per IP (the
    // resolved result is also cached in getClient).
    if (isCimdClientId(clientId) && !(await allowCimd(clientIp(request))).allowed) {
      return json({ error: 'rate_limited', error_description: 'too many client-resolution requests; try again later' }, 429)
    }
    const client = await getClient(clientId)
    if (!client) return json({ error: 'invalid_client', error_description: 'unknown client_id (register via DCR or use a CIMD URL)' }, 400)
    if (!redirectUriAllowed(client, redirectUri)) {
      return json({ error: 'invalid_request', error_description: 'redirect_uri not registered for this client' }, 400)
    }

    // redirect_uri is now trusted, so PKCE errors may be returned to it.
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

    const upstreamUrl = buildAuthorizeUrl({ origin, state: reqId, redirectUri: ep.callback_uri, codeChallenge: upstream.challenge })

    // Interstitial: show a "Continue / Sign up" page (so users without a Cloud
    // account get a signup link) before bouncing to the IdP. Disable with
    // MCP_OAUTH_INTERSTITIAL=off to redirect straight through.
    if (LOGIN_INTERSTITIAL) {
      return html(loginInterstitialHtml({ continueUrl: upstreamUrl, signupUrl: SIGNUP_URL, privacyUrl: PRIVACY_URL }))
    }
    return redirect(upstreamUrl)
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

    // Lead capture (best-effort, non-blocking). We capture email_verified rather
    // than blocking on it — SSO logins often omit it (see recordUser).
    recordUser({ sub: user.sub, email: user.email, domain, emailVerified: user.email_verified === true }).catch(() => {})

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

    const audience = `${origin}/mcp`
    const mintAccess = (u, scope) =>
      signAccessToken(
        { sub: u.sub, email: u.email, email_verified: u.email_verified, org_id: u.org_id, org_name: u.org_name, scope },
        { issuer: ep.issuer, audience, ttlSec: ACCESS_TOKEN_TTL_SEC }
      )
    const issueRefresh = async (familyId, clientId, user, scope) => {
      const { token, hash } = newRefreshToken()
      await putRefresh(hash, { familyId, clientId, user, scope, used: false, expiresAt: Date.now() + REFRESH_TOKEN_TTL_SEC * 1000 })
      return token
    }

    // ---- authorization_code grant ----
    if (body.grant_type === 'authorization_code') {
      const rec = await takeAuthCode(body.code)
      if (!rec) return json({ error: 'invalid_grant', error_description: 'invalid or used code' }, 400)
      // Public clients don't authenticate, so client_id is REQUIRED in the token
      // request and must match the client the code was issued to (RFC 6749 §3.2.1).
      if (!body.client_id) {
        return json({ error: 'invalid_request', error_description: 'client_id is required' }, 400)
      }
      if (body.client_id !== rec.clientId) {
        return json({ error: 'invalid_grant', error_description: 'client_id does not match the authorization request' }, 400)
      }
      if (body.redirect_uri !== rec.clientRedirectUri) return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400)
      if (!verifyChallenge(body.code_verifier, rec.clientCodeChallenge)) {
        return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
      }

      const scope = SCOPES.join(' ')
      const access_token = await mintAccess(rec.user, scope)
      const familyId = newFamilyId()
      await putFamily(familyId, { revoked: false, clientId: rec.clientId, createdAt: Date.now() })
      const refresh_token = await issueRefresh(familyId, rec.clientId, rec.user, scope)
      return json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, scope, refresh_token })
    }

    // ---- refresh_token grant (rotation + reuse detection) ----
    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return json({ error: 'invalid_request', error_description: 'refresh_token required' }, 400)
      const oldHash = hashRefresh(body.refresh_token)
      const record = await getRefresh(oldHash)
      const family = record ? await getFamily(record.familyId) : null
      const decision = decideRefresh({ record, family, nowMs: Date.now() })

      if (decision.action === 'reuse') {
        await revokeFamily(record.familyId) // theft signal — kill the whole session
        return json({ error: 'invalid_grant', error_description: 'refresh token reuse detected; session revoked' }, 400)
      }
      if (decision.action === 'invalid') return json({ error: 'invalid_grant', error_description: decision.reason }, 400)
      if (!body.client_id) {
        return json({ error: 'invalid_request', error_description: 'client_id is required' }, 400)
      }
      if (body.client_id !== record.clientId) {
        return json({ error: 'invalid_grant', error_description: 'client_id does not match the refresh token' }, 400)
      }

      // Atomically consume (supersede) the presented token. On the Neon backend
      // this is a single UPDATE…WHERE used=false RETURNING, so only one of two
      // concurrent requests wins; the loser gets null and is treated as reuse
      // (theft signal), closing the rotation race. On Blobs this is best-effort.
      const consumed = await consumeRefresh(oldHash)
      if (!consumed) {
        await revokeFamily(record.familyId)
        return json({ error: 'invalid_grant', error_description: 'refresh token reuse detected; session revoked' }, 400)
      }

      const refresh_token = await issueRefresh(record.familyId, record.clientId, record.user, record.scope)
      const access_token = await mintAccess(record.user, record.scope)
      return json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, scope: record.scope, refresh_token })
    }

    return json({ error: 'unsupported_grant_type' }, 400)
  }

  return json({ error: 'not_found', path }, 404)
}

// NOTE: Netlify statically analyzes `config.path` at bundle time, so these MUST
// be literal strings (not imported constants). Keep in sync with PATHS in
// lib/oauth/config.mjs.
export const config = {
  path: [
    '/.well-known/oauth-authorization-server',
    '/.well-known/jwks.json',
    '/oauth/authorize',
    '/oauth/token',
    '/oauth/register',
    '/mcp/callback',
    '/oauth/mock-idp/authorize',
  ],
  preferStatic: false,
}
