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
export async function recordUser({ sub, email, domain }) {
  const key = sub || email
  if (!key) return

  const now = new Date().toISOString()
  const existing = await store().get(key, { type: 'json' }).catch(() => null)
  const isNew = !existing

  const record = isNew
    ? { sub, email, domain, firstSeenAt: now, lastSeenAt: now, requestCount: 1 }
    : { ...existing, email, domain, lastSeenAt: now, requestCount: (existing.requestCount || 0) + 1 }

  await store().setJSON(key, record).catch((e) =>
    console.warn('[store] recordUser write failed', { error: e?.message })
  )

  if (isNew) {
    console.log(JSON.stringify({ event: 'mcp_user_captured', domain, sub, ts: now }))
    if (process.env.CRM_WEBHOOK_URL) {
      fetch(process.env.CRM_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, domain, sub, source: 'mcp', timestamp: now }),
      }).catch((e) => console.warn('[store] CRM webhook failed', { error: e?.message }))
    }
  }
}
