import { describe, it, expect } from 'vitest'
import {
  emailDomain,
  isWorkEmail,
  extractBearerToken,
  hashToken,
  buildUnauthorizedResponse,
  isAuthEnforced,
  isWorkEmailRequired,
  decideAuth,
} from '../netlify/functions/lib/auth.mjs'

describe('emailDomain', () => {
  it('extracts and lowercases the domain', () => {
    expect(emailDomain('Jake@Redpanda.COM')).toBe('redpanda.com')
    expect(emailDomain('no-at')).toBe('')
    expect(emailDomain('')).toBe('')
  })
})

describe('isWorkEmail', () => {
  it('accepts work domains', () => {
    expect(isWorkEmail('redpanda.com')).toEqual({ ok: true })
    expect(isWorkEmail('acme-corp.io')).toEqual({ ok: true })
  })
  it('rejects free providers', () => {
    for (const d of ['gmail.com', 'outlook.com', 'hotmail.com', 'proton.me', 'yahoo.com', 'icloud.com']) {
      expect(isWorkEmail(d)).toEqual({ ok: false, reason: 'free_provider' })
    }
  })
  it('rejects disposable providers', () => {
    expect(isWorkEmail('mailinator.com')).toEqual({ ok: false, reason: 'disposable' })
    expect(isWorkEmail('yopmail.com')).toEqual({ ok: false, reason: 'disposable' })
  })
})

describe('extractBearerToken', () => {
  it('parses the Authorization header (case-insensitive)', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123')
    expect(extractBearerToken('bearer  xyz  ')).toBe('xyz')
  })
  it('returns null when absent or non-bearer', () => {
    expect(extractBearerToken('')).toBeNull()
    expect(extractBearerToken(null)).toBeNull()
    expect(extractBearerToken('Basic abc')).toBeNull()
  })
  it('does NOT accept a query token (spec forbids tokens in the URL)', () => {
    // single-arg signature only — no query fallback
    expect(extractBearerToken(undefined)).toBeNull()
  })
})

describe('hashToken', () => {
  it('is deterministic 64-hex and never returns the raw token', () => {
    const h = hashToken('rp-secret-token')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('rp-secret-token')).toBe(h)
    expect(h).not.toContain('rp-secret-token')
  })
})

describe('buildUnauthorizedResponse', () => {
  it('returns a 401 with WWW-Authenticate + resource_metadata', () => {
    const r = buildUnauthorizedResponse({ resourceMetadataUrl: 'https://x.test/.well-known/oauth-protected-resource' })
    expect(r.status).toBe(401)
    expect(r.headers['WWW-Authenticate']).toContain('Bearer')
    expect(r.headers['WWW-Authenticate']).toContain('resource_metadata="https://x.test/.well-known/oauth-protected-resource"')
    expect(r.body.error).toBe('authentication_required')
    expect(r.body.resource_metadata).toBe('https://x.test/.well-known/oauth-protected-resource')
  })
})

describe('config flags', () => {
  it('isAuthEnforced only true when REQUIRE_AUTH === "true"', () => {
    const orig = process.env.REQUIRE_AUTH
    process.env.REQUIRE_AUTH = 'true'
    expect(isAuthEnforced()).toBe(true)
    for (const v of ['false', '', '1', 'yes']) {
      process.env.REQUIRE_AUTH = v
      expect(isAuthEnforced()).toBe(false)
    }
    delete process.env.REQUIRE_AUTH
    expect(isAuthEnforced()).toBe(false)
    if (orig !== undefined) process.env.REQUIRE_AUTH = orig
  })
  it('isWorkEmailRequired defaults true, false only when explicitly "false"', () => {
    const orig = process.env.REQUIRE_WORK_EMAIL
    delete process.env.REQUIRE_WORK_EMAIL
    expect(isWorkEmailRequired()).toBe(true)
    process.env.REQUIRE_WORK_EMAIL = 'false'
    expect(isWorkEmailRequired()).toBe(false)
    process.env.REQUIRE_WORK_EMAIL = 'true'
    expect(isWorkEmailRequired()).toBe(true)
    if (orig === undefined) delete process.env.REQUIRE_WORK_EMAIL
    else process.env.REQUIRE_WORK_EMAIL = orig
  })
})

describe('decideAuth matrix', () => {
  const workClaims = { sub: 'auth0|123', email: 'jake@redpanda.com', email_verified: true }
  const freeClaims = { sub: 'auth0|456', email: 'someone@gmail.com', email_verified: true }

  it('no token + grace -> allow with null context', () => {
    const r = decideAuth({ claims: null, enforced: false, workEmailRequired: true })
    expect(r.allow).toBe(true)
    expect(r.userContext).toBeNull()
    expect(r.response).toBeNull()
  })
  it('no token + enforced -> 401', () => {
    const r = decideAuth({ claims: null, enforced: true, workEmailRequired: true })
    expect(r.allow).toBe(false)
    expect(r.response.status).toBe(401)
  })
  it('valid work email -> allow + context', () => {
    const r = decideAuth({ claims: workClaims, enforced: true, workEmailRequired: true })
    expect(r.allow).toBe(true)
    expect(r.userContext).toEqual({ sub: 'auth0|123', email: 'jake@redpanda.com', domain: 'redpanda.com', emailVerified: true })
  })
  it('free email + work required -> 403 forbidden', () => {
    const r = decideAuth({ claims: freeClaims, enforced: true, workEmailRequired: true })
    expect(r.allow).toBe(false)
    expect(r.response.status).toBe(403)
    expect(r.response.body.error).toBe('work_email_required')
  })
  it('free email + work NOT required -> allow + context', () => {
    const r = decideAuth({ claims: freeClaims, enforced: true, workEmailRequired: false })
    expect(r.allow).toBe(true)
    expect(r.userContext.email).toBe('someone@gmail.com')
  })
})
