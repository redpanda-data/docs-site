// Refresh-token rotation + reuse detection (OAuth 2.1 / RFC 6819 BCP).
//
// Each refresh issues a NEW refresh token and supersedes the old one (rotation).
// Tokens belong to a "family"; if a *superseded* (already-used) token is ever
// replayed, the whole family is revoked (reuse detection) — a theft signal that
// forces re-authentication. We only store hashes of refresh tokens.

import { randomBytes, createHash, randomUUID } from 'node:crypto'

export function hashRefresh(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function newRefreshToken() {
  const token = `rt_${randomBytes(32).toString('base64url')}`
  return { token, hash: hashRefresh(token) }
}

export function newFamilyId() {
  return randomUUID()
}

// Pure decision (unit-tested). `record` = the refresh token's stored record,
// `family` = its family doc, both possibly null. Times in ms.
export function decideRefresh({ record, family, nowMs }) {
  if (!record) return { action: 'invalid', reason: 'unknown_token' }
  if (!family || family.revoked) return { action: 'invalid', reason: 'family_revoked' }
  if (record.expiresAt && record.expiresAt < nowMs) return { action: 'invalid', reason: 'expired' }
  if (record.used) return { action: 'reuse', reason: 'token_reuse' } // caller revokes the family
  return { action: 'rotate' }
}
