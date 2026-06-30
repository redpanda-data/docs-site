// User capture for the MCP server, backed by Netlify Blobs.
// ----------------------------------------------------------
// Sole consumer of @netlify/blobs. Records each authenticated user (their
// verified work email + org/domain) for lead capture and usage attribution.
// On first sight of a user, optionally forwards the lead to a CRM webhook.

import { getStore } from '@netlify/blobs'

const STORE_NAME = 'mcp-users'

function store() {
  return getStore(STORE_NAME)
}

// Record an authenticated user. Best-effort and idempotent: dedupes by `sub`
// (falling back to email). Call fire-and-forget — never block the request.
// We record (don't block on) emailVerified: enterprise/SSO logins often omit it,
// so blocking would lock out legitimate users. Capturing the flag lets downstream
// (CRM / lead scoring) distinguish verified emails when needed.
export async function recordUser({ sub, email, domain, emailVerified = false }) {
  const key = sub || email
  if (!key) return

  const now = new Date().toISOString()
  const existing = await store().get(key, { type: 'json' }).catch(() => null)
  const isNew = !existing

  const record = isNew
    ? { sub, email, domain, emailVerified, firstSeenAt: now, lastSeenAt: now, requestCount: 1 }
    : { ...existing, email, domain, emailVerified, lastSeenAt: now, requestCount: (existing.requestCount || 0) + 1 }

  await store().setJSON(key, record).catch((e) =>
    console.warn('[store] recordUser write failed', { error: e?.message })
  )

  if (isNew) {
    console.log(JSON.stringify({ event: 'mcp_user_captured', domain, sub, emailVerified, ts: now }))
    if (process.env.CRM_WEBHOOK_URL) {
      fetch(process.env.CRM_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, domain, sub, emailVerified, source: 'mcp', timestamp: now }),
      }).catch((e) => console.warn('[store] CRM webhook failed', { error: e?.message }))
    }
  }
}
