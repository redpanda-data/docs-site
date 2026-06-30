import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Atomicity tests for the Neon backend. These MUST run against a real Postgres
// (a fake honoring atomic semantics would prove nothing), so they're skipped
// unless TEST_NEON_URL points at a disposable test database, e.g.:
//   TEST_NEON_URL=postgres://... npx vitest run tests/mcp-oauth-neon.test.ts
const TEST_DB = process.env.TEST_NEON_URL

const migrationPath = fileURLToPath(
  new URL('../netlify/database/migrations/20260622110000_oauth_state.sql', import.meta.url)
)

describe.skipIf(!TEST_DB)('Neon backend — atomic one-time-use', () => {
  let store: typeof import('../netlify/functions/lib/oauth/db/neon.mjs')

  beforeAll(async () => {
    process.env.NETLIFY_DATABASE_URL = TEST_DB
    process.env.STORE_BACKEND = 'neon'

    const { getDatabase } = await import('@netlify/database')
    const sql = getDatabase().httpClient // zero-config, reads NETLIFY_DATABASE_URL
    // Apply schema, then clear any leftover rows from a previous run.
    for (const stmt of readFileSync(migrationPath, 'utf8').split(';').map((s) => s.trim()).filter(Boolean)) {
      await sql.query(stmt)
    }
    await sql.query('TRUNCATE auth_requests, auth_codes, refresh_tokens, refresh_families')

    store = await import('../netlify/functions/lib/oauth/db/neon.mjs')
  })

  it('auth code: two concurrent consumes -> exactly one succeeds', async () => {
    const code = await store.putAuthCode({
      clientId: 'c1',
      clientRedirectUri: 'https://c1/cb',
      clientCodeChallenge: 'chal',
      user: { sub: 'u1', email: 'a@b.com' },
    })
    const results = await Promise.all([store.takeAuthCode(code), store.takeAuthCode(code)])
    expect(results.filter(Boolean)).toHaveLength(1)
    // A third attempt always fails (already consumed).
    expect(await store.takeAuthCode(code)).toBeNull()
  })

  it('refresh token: two concurrent rotations -> exactly one wins (loser = reuse)', async () => {
    const familyId = crypto.randomUUID()
    const hash = 'hash_' + crypto.randomUUID()
    await store.putFamily(familyId, { revoked: false, clientId: 'c1', createdAt: Date.now() })
    await store.putRefresh(hash, {
      familyId,
      clientId: 'c1',
      user: { sub: 'u1' },
      scope: 'openid',
      used: false,
      expiresAt: Date.now() + 60_000,
    })

    const results = await Promise.all([store.consumeRefresh(hash), store.consumeRefresh(hash)])
    expect(results.filter(Boolean)).toHaveLength(1) // only one rotation wins
    expect(await store.consumeRefresh(hash)).toBeNull() // already consumed -> reuse signal
  })

  it('cleanupExpired removes past-expiry rows and empty families', async () => {
    const familyId = crypto.randomUUID()
    const hash = 'expired_' + crypto.randomUUID()
    await store.putFamily(familyId, { revoked: false, clientId: 'c1', createdAt: Date.now() - 120_000 })
    await store.putRefresh(hash, {
      familyId,
      clientId: 'c1',
      user: { sub: 'u1' },
      scope: 'openid',
      used: true,
      expiresAt: Date.now() - 1_000, // already expired
    })
    const deleted = await store.cleanupExpired()
    expect(deleted.refreshTokens).toBeGreaterThanOrEqual(1)
    expect(await store.getRefresh(hash)).toBeNull()
  })
})
