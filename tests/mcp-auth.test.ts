import { describe, it, expect, vi } from 'vitest'
import {
  normalizeEmail,
  isWorkEmail,
  generateToken,
  looksLikeToken,
  hashToken,
  extractBearerToken,
  buildUnauthorizedResponse,
  isAuthEnforced,
  decideAuth,
} from '../netlify/functions/lib/auth.mjs'

describe('normalizeEmail (Layer 1: format)', () => {
  it('lowercases and trims, returns domain', () => {
    expect(normalizeEmail('  Jake@Redpanda.COM ')).toEqual({ email: 'jake@redpanda.com', domain: 'redpanda.com' })
  })
  it('throws on malformed input', () => {
    for (const bad of ['', 'nope', 'a@b', 'no domain.com', '@redpanda.com', 'jake@']) {
      expect(() => normalizeEmail(bad)).toThrowError()
    }
  })
})

describe('isWorkEmail (Layer 2: work-domain filter)', () => {
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

describe('tokens', () => {
  it('generateToken has the rp_mcp_ prefix and is unique', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()))
    expect(tokens.size).toBe(500)
    for (const t of tokens) {
      expect(t.startsWith('rp_mcp_')).toBe(true)
      expect(looksLikeToken(t)).toBe(true)
    }
  })
  it('hashToken is deterministic 64-hex', () => {
    const t = generateToken()
    const h = hashToken(t)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(t)).toBe(h)
    expect(hashToken(generateToken())).not.toBe(h)
  })
})

describe('extractBearerToken', () => {
  it('parses the Authorization header (case-insensitive)', () => {
    expect(extractBearerToken('Bearer abc123', null)).toBe('abc123')
    expect(extractBearerToken('bearer  xyz  ', null)).toBe('xyz')
  })
  it('falls back to the query token', () => {
    expect(extractBearerToken('', 'qtok')).toBe('qtok')
    expect(extractBearerToken(null, 'qtok')).toBe('qtok')
  })
  it('returns null when absent', () => {
    expect(extractBearerToken('', null)).toBeNull()
    expect(extractBearerToken('Basic abc', null)).toBeNull()
  })
})

describe('buildUnauthorizedResponse', () => {
  it('returns a 401 with WWW-Authenticate and registration_url', () => {
    const r = buildUnauthorizedResponse({ registrationUrl: 'https://x.test/mcp/register' })
    expect(r.status).toBe(401)
    expect(r.headers['WWW-Authenticate']).toContain('Bearer')
    expect(r.headers['WWW-Authenticate']).toContain('https://x.test/mcp/register')
    expect(r.body.error).toBe('authentication_required')
    expect(r.body.registration_url).toBe('https://x.test/mcp/register')
  })
})

describe('isAuthEnforced', () => {
  it('only true when REQUIRE_AUTH === "true"', () => {
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
})

describe('decideAuth matrix', () => {
  const record = { email: 'jake@redpanda.com', domain: 'redpanda.com', revoked: false }

  it('valid record -> allow + context', () => {
    const r = decideAuth({ record, enforced: true })
    expect(r.allow).toBe(true)
    expect(r.userContext).toEqual({ email: 'jake@redpanda.com', domain: 'redpanda.com' })
    expect(r.unauthorized).toBeNull()
  })
  it('revoked record + enforced -> 401', () => {
    const r = decideAuth({ record: { ...record, revoked: true }, enforced: true })
    expect(r.allow).toBe(false)
    expect(r.unauthorized.status).toBe(401)
  })
  it('no token + grace -> allow with null context', () => {
    const r = decideAuth({ record: null, enforced: false })
    expect(r.allow).toBe(true)
    expect(r.userContext).toBeNull()
    expect(r.unauthorized).toBeNull()
  })
  it('no token + enforced -> 401', () => {
    const r = decideAuth({ record: null, enforced: true })
    expect(r.allow).toBe(false)
    expect(r.unauthorized.status).toBe(401)
  })
})

describe('hasValidMx (Layer 3: MX) with mocked resolver', () => {
  it('accepts a domain with MX records, rejects NXDOMAIN', async () => {
    vi.resetModules()
    vi.doMock('node:dns', () => ({
      promises: {
        resolveMx: vi.fn(async (d: string) => {
          if (d === 'redpanda.com') return [{ exchange: 'mx.redpanda.com', priority: 10 }]
          throw new Error('ENOTFOUND')
        }),
        resolve: vi.fn(async () => {
          throw new Error('ENOTFOUND')
        }),
      },
    }))
    const { hasValidMx } = await import('../netlify/functions/lib/email.mjs')
    expect(await hasValidMx('redpanda.com')).toBe(true)
    expect(await hasValidMx('nope-not-a-real-domain-xyz.com')).toBe(false)
    vi.doUnmock('node:dns')
  })
})
