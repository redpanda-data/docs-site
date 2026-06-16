import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPair, exportJWK, calculateJwkThumbprint } from 'jose'
import { verifyChallenge, s256, generatePair } from '../netlify/functions/lib/oauth/pkce.mjs'
import { resolveUpstreamMode } from '../netlify/functions/lib/oauth/config.mjs'

// --- Fail-closed upstream mode resolution ---
describe('resolveUpstreamMode (fail-closed)', () => {
  it('unconfigured (prod, no client_id, no dev flag) -> null (refuse)', () => {
    expect(resolveUpstreamMode({})).toBeNull()
  })
  it('client_id present -> auth0', () => {
    expect(resolveUpstreamMode({ REDPANDA_OAUTH_CLIENT_ID: 'abc' })).toBe('auth0')
  })
  it('mock only under an explicit dev signal', () => {
    expect(resolveUpstreamMode({ NETLIFY_DEV: 'true' })).toBe('mock')
    expect(resolveUpstreamMode({ MCP_OAUTH_ALLOW_MOCK: 'true' })).toBe('mock')
  })
  it('explicit mock without the dev signal -> null (no silent prod mock)', () => {
    expect(resolveUpstreamMode({ MCP_OAUTH_UPSTREAM: 'mock' })).toBeNull()
  })
  it('explicit auth0 without a client_id -> null', () => {
    expect(resolveUpstreamMode({ MCP_OAUTH_UPSTREAM: 'auth0' })).toBeNull()
  })
  it('client_id wins even with dev flag set', () => {
    expect(resolveUpstreamMode({ REDPANDA_OAUTH_CLIENT_ID: 'abc', NETLIFY_DEV: 'true' })).toBe('auth0')
  })
})

// --- PKCE ---
describe('PKCE (S256)', () => {
  it('verifies a matching verifier/challenge', () => {
    const { verifier, challenge } = generatePair()
    expect(verifyChallenge(verifier, challenge)).toBe(true)
  })
  it('rejects a wrong verifier and empty inputs', () => {
    const { challenge } = generatePair()
    expect(verifyChallenge('wrong', challenge)).toBe(false)
    expect(verifyChallenge('', challenge)).toBe(false)
    expect(verifyChallenge('x', '')).toBe(false)
  })
  it('s256 is base64url SHA-256', () => {
    // RFC 7636 Appendix B test vector
    expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

// --- JWT issue/verify via our keys module (env-provided key, no Blobs) ---
describe('access token issue + verify (jose)', () => {
  let keys: typeof import('../netlify/functions/lib/oauth/keys.mjs')
  const ISS = 'https://docs.test'
  const AUD = 'https://docs.test/mcp'

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
    const publicJwk = await exportJWK(publicKey)
    const privateJwk = await exportJWK(privateKey)
    const kid = await calculateJwkThumbprint(publicJwk)
    process.env.MCP_OAUTH_SIGNING_JWK = JSON.stringify({ privateJwk, publicJwk, kid })
    keys = await import('../netlify/functions/lib/oauth/keys.mjs')
  })

  it('JWKS exposes a public key (no private material)', async () => {
    const jwks = await keys.getJwks()
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0].use).toBe('sig')
    expect(jwks.keys[0].kid).toBeTruthy()
    expect(jwks.keys[0].d).toBeUndefined() // never leak the private exponent
  })

  it('round-trips a signed token', async () => {
    const t = await keys.signAccessToken({ sub: 'auth0|1', email: 'jake@redpanda.com' }, { issuer: ISS, audience: AUD, ttlSec: 60 })
    const r = await keys.verifyAccessToken(t, { issuer: ISS, audience: AUD })
    expect(r.valid).toBe(true)
    expect(r.claims.email).toBe('jake@redpanda.com')
    expect(r.claims.iss).toBe(ISS)
    expect(r.claims.aud).toBe(AUD)
  })

  it('rejects wrong audience and tampered tokens', async () => {
    const t = await keys.signAccessToken({ sub: 'auth0|1' }, { issuer: ISS, audience: AUD, ttlSec: 60 })
    expect((await keys.verifyAccessToken(t, { issuer: ISS, audience: 'https://evil/mcp' })).valid).toBe(false)
    expect((await keys.verifyAccessToken(t + 'x', { issuer: ISS, audience: AUD })).valid).toBe(false)
    expect((await keys.verifyAccessToken('not.a.jwt', { issuer: ISS, audience: AUD })).valid).toBe(false)
  })
})
