// SPIKE ONLY — minimal OAuth 2.1 Authorization Server slice to prove the
// broker architecture on Netlify Functions:
//   downstream client --(/authorize, PKCE)--> us
//        us --(redirect)--> upstream IdP login --> our /callback
//        us --(issue our own JWT)--> downstream client --> /token --> access token
//        access token --> /protected (we validate via our JWKS)
//
// Federates to a MOCK upstream by default (no Auth0 client_id needed yet);
// flip SPIKE_UPSTREAM=auth0 + env to hit the real Cloud IdP later.
// NOT production: in-memory store, ephemeral signing key, no DCR/refresh,
// hand-rolled JWT. Those are later milestones.

import { createHash } from 'node:crypto'
import { jwks, signJwt, verifyJwt } from './lib/spike-jwt.mjs'
import { putAuthRequest, takeAuthRequest, putAuthCode, takeAuthCode } from './lib/spike-store.mjs'
import { buildUpstreamAuthorizeUrl, exchangeUpstreamCode, UPSTREAM_MODE } from './lib/spike-upstream.mjs'

const BASE = '/mcp-as'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const redirect = (location) => new Response(null, { status: 302, headers: { Location: location } })

const s256 = (v) => createHash('sha256').update(v).digest('base64url')

export default async (request) => {
  const url = new URL(request.url)
  const origin = url.origin
  const path = url.pathname
  const issuer = `${origin}${BASE}`
  const q = url.searchParams

  // ---- Discovery: our RFC 8414 metadata ----
  if (path === `${BASE}/.well-known/oauth-authorization-server`) {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['openid', 'email', 'profile'],
      _spike: { upstream_mode: UPSTREAM_MODE },
    })
  }

  if (path === `${BASE}/jwks.json`) return json(jwks())

  // ---- /authorize: downstream client (the AI tool) starts the flow ----
  if (path === `${BASE}/authorize`) {
    const clientId = q.get('client_id')
    const redirectUri = q.get('redirect_uri')
    const codeChallenge = q.get('code_challenge')
    const method = q.get('code_challenge_method')
    if (!clientId || !redirectUri || !codeChallenge) {
      return json({ error: 'invalid_request', detail: 'client_id, redirect_uri, code_challenge required' }, 400)
    }
    if (method !== 'S256') return json({ error: 'invalid_request', detail: 'PKCE S256 required' }, 400)

    // Our own PKCE for the upstream call (mock ignores it; auth0 uses it).
    const upstreamVerifier = s256(`${clientId}:${Date.now()}:${Math.random()}`) // any high-entropy string
    const upstreamChallenge = s256(upstreamVerifier)

    const reqId = putAuthRequest({
      clientId,
      clientRedirectUri: redirectUri,
      clientState: q.get('state') || '',
      clientCodeChallenge: codeChallenge,
      upstreamVerifier,
    })

    return redirect(
      buildUpstreamAuthorizeUrl({
        origin,
        state: reqId,
        redirectUri: `${issuer}/callback`,
        codeChallenge: upstreamChallenge,
      })
    )
  }

  // ---- Mock upstream IdP: immediately bounce back to /callback ----
  if (path === `${BASE}/mock-idp/authorize`) {
    const redirectUri = q.get('redirect_uri')
    const state = q.get('state')
    const back = new URL(redirectUri)
    back.searchParams.set('code', 'mock-upstream-code')
    back.searchParams.set('state', state)
    return redirect(back.toString())
  }

  // ---- /callback: upstream returns here; we mint our own auth code ----
  if (path === `${BASE}/callback`) {
    const code = q.get('code')
    const state = q.get('state')
    const authReq = state ? takeAuthRequest(state) : null
    if (!code || !authReq) return json({ error: 'invalid_request', detail: 'unknown or expired state' }, 400)

    let claims
    try {
      claims = await exchangeUpstreamCode({
        code,
        codeVerifier: authReq.upstreamVerifier,
        redirectUri: `${issuer}/callback`,
      })
    } catch (e) {
      return json({ error: 'upstream_error', detail: e.message }, 502)
    }

    const ourCode = putAuthCode({
      clientId: authReq.clientId,
      clientRedirectUri: authReq.clientRedirectUri,
      clientCodeChallenge: authReq.clientCodeChallenge,
      claims,
    })

    const back = new URL(authReq.clientRedirectUri)
    back.searchParams.set('code', ourCode)
    if (authReq.clientState) back.searchParams.set('state', authReq.clientState)
    return redirect(back.toString())
  }

  // ---- /token: downstream client exchanges our code (+ PKCE) for a token ----
  if (path === `${BASE}/token` && request.method === 'POST') {
    const ct = request.headers.get('content-type') || ''
    const body = ct.includes('application/json')
      ? await request.json().catch(() => ({}))
      : Object.fromEntries(new URLSearchParams(await request.text()))

    if (body.grant_type !== 'authorization_code') {
      return json({ error: 'unsupported_grant_type' }, 400)
    }
    const rec = takeAuthCode(body.code)
    if (!rec) return json({ error: 'invalid_grant', detail: 'bad or used code' }, 400)
    if (body.redirect_uri !== rec.clientRedirectUri) {
      return json({ error: 'invalid_grant', detail: 'redirect_uri mismatch' }, 400)
    }
    // PKCE: verify the client's code_verifier against the stored challenge.
    if (!body.code_verifier || s256(body.code_verifier) !== rec.clientCodeChallenge) {
      return json({ error: 'invalid_grant', detail: 'PKCE verification failed' }, 400)
    }

    const accessToken = signJwt(
      { sub: rec.claims.sub, email: rec.claims.email, email_verified: rec.claims.email_verified, org: rec.claims.org, scope: 'openid email profile' },
      { issuer, audience: `${origin}/mcp`, expiresInSec: 3600 }
    )
    return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 })
  }

  // ---- /protected: demo resource-server validation of OUR token ----
  if (path === `${BASE}/protected`) {
    const auth = request.headers.get('authorization') || ''
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (!m) return json({ error: 'unauthorized' }, 401)
    const { valid, claims, error } = verifyJwt(m[1])
    if (!valid) return json({ error: 'invalid_token', detail: error }, 401)
    return json({ ok: true, you_are: { email: claims.email, sub: claims.sub, org: claims.org }, full_claims: claims })
  }

  return json({ error: 'not_found', path }, 404)
}

export const config = {
  path: '/mcp-as/*',
  preferStatic: false,
}
