// Per-IP fixed-window rate limiter (for /oauth/register and CIMD resolution),
// backed by Netlify Blobs.
//
// In-memory counters don't survive across serverless invocations (the same
// finding that drove strong-consistency storage), so this is Blobs-backed with
// strong consistency. Best-effort: there's no atomic CAS, so a burst can
// slightly undercount — fine for blunting abuse.

import { getStore } from '@netlify/blobs'

const REGISTER_WINDOW_SEC = Number(process.env.MCP_OAUTH_REGISTER_WINDOW_SEC || 3600)
const REGISTER_LIMIT = Number(process.env.MCP_OAUTH_REGISTER_LIMIT || 20)
// CIMD resolution triggers an outbound fetch from /authorize, so cap it per IP.
const CIMD_WINDOW_SEC = Number(process.env.MCP_OAUTH_CIMD_WINDOW_SEC || 600)
const CIMD_LIMIT = Number(process.env.MCP_OAUTH_CIMD_LIMIT || 30)

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

// Generic per-IP fixed-window check. Returns { allowed, count, limit };
// increments the current window's counter. Fails open if the store is down.
async function allow(bucket, ip, limit, windowSec) {
  const id = ip || 'unknown'
  const key = `${bucket}:${id}:${Math.floor(Date.now() / 1000 / windowSec)}`
  let count = 0
  try {
    count = (await store().get(key, { type: 'json' }))?.n || 0
  } catch {
    return { allowed: true, count: 0, limit }
  }
  if (count >= limit) return { allowed: false, count, limit }
  try {
    await store().setJSON(key, { n: count + 1 })
  } catch {
    /* best-effort */
  }
  return { allowed: true, count: count + 1, limit }
}

export const allowRegister = (ip) => allow('reg', ip, REGISTER_LIMIT, REGISTER_WINDOW_SEC)
export const allowCimd = (ip) => allow('cimd', ip, CIMD_LIMIT, CIMD_WINDOW_SEC)
