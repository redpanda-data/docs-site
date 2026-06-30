import { describe, it, expect } from 'vitest'
import { hashRefresh, newRefreshToken, newFamilyId, decideRefresh } from '../netlify/functions/lib/oauth/refresh.mjs'

describe('refresh token primitives', () => {
  it('newRefreshToken has rp prefix and matching hash; hashRefresh deterministic', () => {
    const { token, hash } = newRefreshToken()
    expect(token.startsWith('rt_')).toBe(true)
    expect(hash).toBe(hashRefresh(token))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(token)
  })
  it('family ids are unique', () => {
    expect(newFamilyId()).not.toBe(newFamilyId())
  })
})

describe('decideRefresh (rotation + reuse detection)', () => {
  const now = 1_000_000
  const fam = { revoked: false }
  const fresh = { used: false, expiresAt: now + 10_000, familyId: 'f1' }

  it('valid unused token -> rotate', () => {
    expect(decideRefresh({ record: fresh, family: fam, nowMs: now }).action).toBe('rotate')
  })
  it('already-used (superseded) token -> reuse', () => {
    expect(decideRefresh({ record: { ...fresh, used: true }, family: fam, nowMs: now }).action).toBe('reuse')
  })
  it('revoked family -> invalid', () => {
    expect(decideRefresh({ record: fresh, family: { revoked: true }, nowMs: now })).toEqual({ action: 'invalid', reason: 'family_revoked' })
  })
  it('expired token -> invalid', () => {
    expect(decideRefresh({ record: { ...fresh, expiresAt: now - 1 }, family: fam, nowMs: now })).toEqual({ action: 'invalid', reason: 'expired' })
  })
  it('unknown token / missing family -> invalid', () => {
    expect(decideRefresh({ record: null, family: null, nowMs: now }).action).toBe('invalid')
    expect(decideRefresh({ record: fresh, family: null, nowMs: now }).action).toBe('invalid')
  })
})
