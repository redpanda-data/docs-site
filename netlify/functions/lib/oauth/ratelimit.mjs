// Per-IP fixed-window rate limiter for /oauth/register, backed by Netlify Blobs.
//
// In-memory counters don't survive across serverless invocations (the same
// finding that drove strong-consistency storage), so this is Blobs-backed with
// strong consistency. Best-effort: there's no atomic CAS, so a burst can
// slightly undercount — fine for blunting registration spam.

import { getStore } from '@netlify/blobs'

const WINDOW_SEC = Number(process.env.MCP_OAUTH_REGISTER_WINDOW_SEC || 3600)
const LIMIT = Number(process.env.MCP_OAUTH_REGISTER_LIMIT || 20)

function store() {
  return getStore({ name: 'mcp-oauth-rl', consistency: 'strong' })
}

export function clientIp(request) {
  return (
    request.headers.get('x-nf-client-connection-ip') ||
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  )
}

// Returns { allowed, count, limit }. Increments the current window's counter.
export async function allowRegister(ip) {
  const id = ip || 'unknown'
  const windowIdx = Math.floor(Date.now() / 1000 / WINDOW_SEC)
  const key = `reg:${id}:${windowIdx}`
  let count = 0
  try {
    const rec = await store().get(key, { type: 'json' })
    count = rec?.n || 0
  } catch {
    // store unavailable → don't block legitimate registration
    return { allowed: true, count: 0, limit: LIMIT }
  }
  if (count >= LIMIT) return { allowed: false, count, limit: LIMIT }
  try {
    await store().setJSON(key, { n: count + 1 })
  } catch {
    /* best-effort */
  }
  return { allowed: true, count: count + 1, limit: LIMIT }
}
