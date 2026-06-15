// Token storage for the MCP server, backed by Netlify Blobs.
// -----------------------------------------------------------
// Sole consumer of @netlify/blobs so the rest of the auth code stays runtime-
// agnostic and unit-testable. Records are keyed by the SHA-256 hash of the
// token (see auth.mjs:hashToken) so a store leak never exposes usable tokens.

import { getStore as netlifyGetStore } from '@netlify/blobs'

const STORE_NAME = 'mcp-tokens'

// Only persist lastUsedAt/requestCount roughly every N requests to avoid a
// Blobs write on every single query (writes are best-effort and off the hot path).
const TOUCH_EVERY = 10

function store() {
  return netlifyGetStore(STORE_NAME)
}

export async function saveRegistration({ tokenHash, email, domain }) {
  const record = {
    email,
    domain,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    requestCount: 0,
    revoked: false,
  }
  await store().setJSON(tokenHash, record)
  return record
}

export async function lookupToken(tokenHash) {
  if (!tokenHash) return null
  return store().get(tokenHash, { type: 'json' })
}

// Fire-and-forget usage bump. Never awaited on the hot path, never throws.
// Throttled so we don't write on every request.
export function touchToken(tokenHash, record) {
  try {
    const count = (record?.requestCount || 0) + 1
    // Always update the in-memory count for the throttle check, but only persist
    // periodically (and on the very first use).
    if (count === 1 || count % TOUCH_EVERY === 0) {
      const updated = {
        ...record,
        lastUsedAt: new Date().toISOString(),
        requestCount: count,
      }
      // Intentionally not awaited.
      store().setJSON(tokenHash, updated).catch((e) => {
        console.warn('[store] touchToken write failed', { error: e?.message })
      })
    }
  } catch (e) {
    console.warn('[store] touchToken error', { error: e?.message })
  }
}

export async function revokeToken(tokenHash) {
  const record = await lookupToken(tokenHash)
  if (!record) return false
  await store().setJSON(tokenHash, { ...record, revoked: true, revokedAt: new Date().toISOString() })
  return true
}
