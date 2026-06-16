// SPIKE ONLY — pluggable upstream IdP (the human-login federation).
//
// mode = 'mock' (default): a stand-in IdP so we can prove the whole flow with
//   no external dependency and no Auth0 client_id yet.
// mode = 'auth0': the real path (Redpanda Cloud Auth0). Wired here so dropping
//   in REDPANDA_OAUTH_ISSUER + SPIKE_AUTH0_CLIENT_ID later is a config change,
//   not a rewrite.

const MODE = process.env.SPIKE_UPSTREAM || 'mock'

// Build the URL we redirect the user to in order to log in upstream.
// `state` round-trips our auth-request id; `redirectUri` is our /callback.
export function buildUpstreamAuthorizeUrl({ origin, state, redirectUri, codeChallenge }) {
  if (MODE === 'auth0') {
    const issuer = process.env.REDPANDA_OAUTH_ISSUER || 'https://auth.prd.cloud.redpanda.com/'
    const clientId = process.env.SPIKE_AUTH0_CLIENT_ID
    if (!clientId) throw new Error('SPIKE_AUTH0_CLIENT_ID required for auth0 mode')
    const u = new URL('authorize', issuer)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', clientId)
    u.searchParams.set('redirect_uri', redirectUri)
    u.searchParams.set('scope', 'openid email profile')
    u.searchParams.set('state', state)
    u.searchParams.set('code_challenge', codeChallenge)
    u.searchParams.set('code_challenge_method', 'S256')
    return u.toString()
  }
  // mock: bounce straight back to our /callback with a fake code.
  const u = new URL('/mcp-as/mock-idp/authorize', origin)
  u.searchParams.set('state', state)
  u.searchParams.set('redirect_uri', redirectUri)
  return u.toString()
}

// Exchange the upstream code for the user's verified identity claims.
export async function exchangeUpstreamCode({ code, codeVerifier, redirectUri }) {
  if (MODE === 'auth0') {
    const issuer = process.env.REDPANDA_OAUTH_ISSUER || 'https://auth.prd.cloud.redpanda.com/'
    const clientId = process.env.SPIKE_AUTH0_CLIENT_ID
    const res = await fetch(new URL('oauth/token', issuer), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new Error(`upstream token exchange failed: ${res.status}`)
    const tok = await res.json()
    // PRODUCTION: validate id_token signature (Auth0 JWKS), iss, aud, exp, nonce.
    const idToken = tok.id_token
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
    return { sub: payload.sub, email: payload.email, email_verified: payload.email_verified, org: payload.org_id }
  }
  // mock: canned verified identity.
  return { sub: 'mock|123', email: 'spike@redpanda.com', email_verified: true, org: 'org_mock' }
}

export const UPSTREAM_MODE = MODE
