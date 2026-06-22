// OAuth state storage — Neon Postgres (Netlify DB) backend.
//
// Selected when STORE_BACKEND=neon (see store.mjs). Exists to make one-time-use
// of auth codes and refresh tokens ATOMIC: each consume is a single
// `UPDATE … WHERE used = false RETURNING *` (or `DELETE … RETURNING *`), so two
// concurrent requests with the same code/token cannot both succeed — exactly
// one wins the row, the loser sees zero rows. This closes the replay/reuse race
// that the Blobs backend documents.
//
// Scope: the four one-time-use / transactional tables only. DCR clients stay on
// Blobs (they are plain persistence, not one-time-use — no atomicity benefit).
//
// Uses @netlify/database's zero-config client (getDatabase().httpClient), which
// reads NETLIFY_DATABASE_URL automatically and is the HTTP Neon query function
// (tagged-template SQL). Imported lazily so this module can be loaded without
// the dependency or a database URL present (e.g. STORE_BACKEND=blobs in tests).

import { randomUUID, randomBytes } from 'node:crypto'
import { AUTH_REQUEST_TTL_SEC, AUTH_CODE_TTL_SEC } from '../config.mjs'

let _sql = null
async function db() {
  if (_sql) return _sql
  const { getDatabase } = await import('@netlify/database')
  // Throws MissingDatabaseConnectionError if no URL is configured (fail-closed).
  _sql = getDatabase().httpClient
  return _sql
}

const toMs = (ts) => (ts ? new Date(ts).getTime() : 0)

// --- auth requests (one-time; consumed by delete) ---
export async function putAuthRequest(data) {
  const sql = await db()
  const id = randomUUID()
  const expiresMs = Date.now() + AUTH_REQUEST_TTL_SEC * 1000
  await sql`
    INSERT INTO auth_requests (id, client_id, client_redirect_uri, client_state, client_code_challenge, upstream_verifier, expires_at)
    VALUES (${id}, ${data.clientId}, ${data.clientRedirectUri}, ${data.clientState ?? null}, ${data.clientCodeChallenge ?? null}, ${data.upstreamVerifier ?? null}, to_timestamp(${expiresMs} / 1000.0))
  `
  return id
}

export async function takeAuthRequest(id) {
  if (!id) return null
  const sql = await db()
  const rows = await sql`DELETE FROM auth_requests WHERE id = ${id} RETURNING *`
  const row = rows[0]
  if (!row || toMs(row.expires_at) < Date.now()) return null
  return {
    clientId: row.client_id,
    clientRedirectUri: row.client_redirect_uri,
    clientState: row.client_state,
    clientCodeChallenge: row.client_code_challenge,
    upstreamVerifier: row.upstream_verifier,
    expiresAt: toMs(row.expires_at),
  }
}

// --- authorization codes (one-time; atomic check+consume) ---
export async function putAuthCode(data) {
  const sql = await db()
  const code = randomBytes(32).toString('base64url')
  const expiresMs = Date.now() + AUTH_CODE_TTL_SEC * 1000
  await sql`
    INSERT INTO auth_codes (code, client_id, client_redirect_uri, client_code_challenge, user_data, used, expires_at)
    VALUES (${code}, ${data.clientId}, ${data.clientRedirectUri}, ${data.clientCodeChallenge ?? null}, ${JSON.stringify(data.user)}::jsonb, false, to_timestamp(${expiresMs} / 1000.0))
  `
  return code
}

export async function takeAuthCode(code) {
  if (!code) return null
  const sql = await db()
  // Atomic: only the first caller flips used=false→true and gets the row.
  const rows = await sql`
    UPDATE auth_codes SET used = true
    WHERE code = ${code} AND used = false AND expires_at > now()
    RETURNING *
  `
  const row = rows[0]
  if (!row) return null
  return {
    clientId: row.client_id,
    clientRedirectUri: row.client_redirect_uri,
    clientCodeChallenge: row.client_code_challenge,
    user: row.user_data,
    expiresAt: toMs(row.expires_at),
  }
}

// --- refresh tokens (by hash) ---
export async function putRefresh(hash, rec) {
  const sql = await db()
  await sql`
    INSERT INTO refresh_tokens (hash, family_id, client_id, user_data, scope, used, expires_at)
    VALUES (${hash}, ${rec.familyId}, ${rec.clientId}, ${JSON.stringify(rec.user)}::jsonb, ${rec.scope ?? null}, ${rec.used ?? false}, to_timestamp(${rec.expiresAt} / 1000.0))
  `
}

export async function getRefresh(hash) {
  if (!hash) return null
  const sql = await db()
  const rows = await sql`SELECT * FROM refresh_tokens WHERE hash = ${hash}`
  const row = rows[0]
  if (!row) return null
  return {
    familyId: row.family_id,
    clientId: row.client_id,
    user: row.user_data,
    scope: row.scope,
    used: row.used,
    expiresAt: toMs(row.expires_at),
  }
}

// Atomic consume: exactly one concurrent caller flips used=false→true and gets
// the row back. A loser (already used / missing) gets null → caller trips reuse.
export async function consumeRefresh(hash) {
  if (!hash) return null
  const sql = await db()
  const rows = await sql`
    UPDATE refresh_tokens SET used = true
    WHERE hash = ${hash} AND used = false
    RETURNING *
  `
  const row = rows[0]
  if (!row) return null
  return {
    familyId: row.family_id,
    clientId: row.client_id,
    user: row.user_data,
    scope: row.scope,
    used: true,
    expiresAt: toMs(row.expires_at),
  }
}

// --- refresh-token families ---
export async function putFamily(id, rec) {
  const sql = await db()
  await sql`
    INSERT INTO refresh_families (id, client_id, revoked, created_at)
    VALUES (${id}, ${rec.clientId ?? null}, ${rec.revoked ?? false}, to_timestamp(${rec.createdAt ?? Date.now()} / 1000.0))
    ON CONFLICT (id) DO NOTHING
  `
}

export async function getFamily(id) {
  if (!id) return null
  const sql = await db()
  const rows = await sql`SELECT * FROM refresh_families WHERE id = ${id}`
  const row = rows[0]
  if (!row) return null
  return {
    clientId: row.client_id,
    revoked: row.revoked,
    createdAt: toMs(row.created_at),
    revokedAt: row.revoked_at ? toMs(row.revoked_at) : null,
  }
}

export async function revokeFamily(id) {
  const sql = await db()
  await sql`UPDATE refresh_families SET revoked = true, revoked_at = now() WHERE id = ${id}`
}

// TTL cleanup (run on a schedule). Deletes expired one-time-use rows. Only
// past-expiry refresh tokens are removed, so reuse detection still works for
// every token within its lifetime; families with no remaining tokens are then
// swept. Reads already filter on expires_at, so this is purely housekeeping.
export async function cleanupExpired() {
  const sql = await db()
  const reqs = await sql`DELETE FROM auth_requests WHERE expires_at < now() RETURNING id`
  const codes = await sql`DELETE FROM auth_codes WHERE expires_at < now() RETURNING code`
  const toks = await sql`DELETE FROM refresh_tokens WHERE expires_at < now() RETURNING hash`
  const fams = await sql`
    DELETE FROM refresh_families f
    WHERE NOT EXISTS (SELECT 1 FROM refresh_tokens t WHERE t.family_id = f.id)
    RETURNING id
  `
  return { authRequests: reqs.length, authCodes: codes.length, refreshTokens: toks.length, families: fams.length }
}
