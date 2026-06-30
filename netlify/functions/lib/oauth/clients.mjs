// OAuth client identity for the AS: Dynamic Client Registration (RFC 7591) +
// Client ID Metadata Documents (CIMD). MCP clients (ChatGPT, Claude, …) are
// third-party apps that identify themselves at runtime — either by registering
// (DCR) and getting a client_id, or by presenting a URL client_id whose
// metadata document we fetch (CIMD).

import { randomBytes } from 'node:crypto'
import { putClient, getStoredClient } from './store.mjs'

const CIMD_FETCH_TIMEOUT_MS = 5_000
const CIMD_MAX_BYTES = 32_000

// Short in-process cache of resolved CIMD clients (and negatives), so /authorize
// doesn't re-fetch the same client_id URL on every call. Bounded to cap memory
// against a flood of distinct URLs; /authorize also rate-limits CIMD resolution.
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000
const CIMD_NEG_TTL_MS = 30_000
const CIMD_CACHE_MAX = 500
const cimdCache = new Map() // clientId -> { client, exp }

export function isCimdClientId(clientId) {
  return typeof clientId === 'string' && clientId.startsWith('https://')
}

// --- redirect_uri matching (OAuth 2.1: exact match, with loopback flexibility) ---
// Native clients (e.g. Claude Code) use http://127.0.0.1:<random-port>/cb or
// http://localhost:<port>/cb, so for loopback we match everything except the port.
export function redirectUriAllowed(client, redirectUri) {
  const allowed = client?.redirect_uris || []
  if (allowed.includes(redirectUri)) return true
  let u
  try { u = new URL(redirectUri) } catch { return false }
  const isLoopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1')
  if (!isLoopback) return false
  return allowed.some((a) => {
    let r
    try { r = new URL(a) } catch { return false }
    return r.protocol === u.protocol && r.hostname === u.hostname && r.pathname === u.pathname // port may differ
  })
}

// --- validation of submitted/ fetched client metadata ---
function normalizeClientMetadata(meta) {
  const redirect_uris = Array.isArray(meta?.redirect_uris) ? meta.redirect_uris : []
  if (redirect_uris.length === 0) {
    const err = new Error('redirect_uris is required')
    err.code = 'invalid_redirect_uri'
    throw err
  }
  for (const uri of redirect_uris) {
    try { new URL(uri) } catch {
      const err = new Error(`invalid redirect_uri: ${uri}`)
      err.code = 'invalid_redirect_uri'
      throw err
    }
  }
  return {
    redirect_uris,
    client_name: typeof meta.client_name === 'string' ? meta.client_name.slice(0, 200) : undefined,
    token_endpoint_auth_method: 'none', // public clients only
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid email profile',
  }
}

// --- DCR (RFC 7591) ---
export async function registerClient(meta) {
  const normalized = normalizeClientMetadata(meta)
  const client_id = `mcp_${randomBytes(24).toString('base64url')}`
  const record = { client_id, ...normalized, client_id_issued_at: Math.floor(Date.now() / 1000) }
  await putClient(record)
  return record // RFC 7591 registration response (public client → no secret)
}

// Block loopback / private / link-local hosts (IPv4 and IPv6). Best-effort SSRF
// guard — residual: a DNS name that resolves to a private IP (DNS rebinding); a
// hardened deploy would also resolve + range-check the IP.
export function isBlockedHost(rawHost) {
  // Lowercase and strip IPv6 brackets (URL.hostname returns e.g. "[::1]").
  let host = String(rawHost || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.local')) return true

  if (host.includes(':')) {
    // IPv6 literal
    if (host === '::1' || host === '::') return true // loopback / unspecified
    if (host.startsWith('::ffff:')) return true // IPv4-mapped IPv6
    if (/^f[cd]/.test(host)) return true // fc00::/7 unique-local
    if (/^fe[89ab]/.test(host)) return true // fe80::/10 link-local
    return false
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    // IPv4 literal
    return (
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === '0.0.0.0'
    )
  }
  return false // DNS name (rebinding residual, see note above)
}

// --- CIMD: fetch + validate a URL client_id's metadata document ---
function assertSafeCimdUrl(clientId) {
  let u
  try { u = new URL(clientId) } catch { throw new Error('client_id is not a valid URL') }
  if (u.protocol !== 'https:') throw new Error('CIMD client_id must be https')
  if (isBlockedHost(u.hostname)) throw new Error('CIMD client_id host not allowed')
  return u
}

export function validateCimdDocument(clientId, doc) {
  if (!doc || typeof doc !== 'object') throw new Error('CIMD metadata not an object')
  if (doc.client_id !== clientId) throw new Error('CIMD client_id must equal the document URL')
  return normalizeClientMetadata(doc)
}

// Read a response body with a hard byte cap, streaming so we never buffer a
// huge/slow body. Falls back to text() for mocked responses without a stream.
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length') || 0)
  if (declared > maxBytes) throw new Error('CIMD metadata too large')
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        throw new Error('CIMD metadata too large')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const text = await res.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('CIMD metadata too large')
  return text
}

async function fetchCimdClient(clientId, fetchImpl = fetch) {
  assertSafeCimdUrl(clientId)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), CIMD_FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(clientId, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      // SSRF: do NOT follow redirects — the initial host passed assertSafeCimdUrl,
      // but a redirect Location is unvalidated and could point at an internal host.
      redirect: 'error',
    })
    if (!res.ok) throw new Error(`CIMD fetch failed: ${res.status}`)
    const doc = JSON.parse(await readCapped(res, CIMD_MAX_BYTES))
    return { client_id: clientId, ...validateCimdDocument(clientId, doc) }
  } finally {
    clearTimeout(t)
  }
}

// Resolve a client_id to a client record (DCR-stored or CIMD-fetched), or null.
export async function getClient(clientId, { fetchImpl } = {}) {
  if (!clientId) return null
  if (isCimdClientId(clientId)) {
    const hit = cimdCache.get(clientId)
    if (hit && hit.exp > Date.now()) return hit.client
    let client = null
    try { client = await fetchCimdClient(clientId, fetchImpl) } catch { client = null }
    if (cimdCache.size > CIMD_CACHE_MAX) cimdCache.clear()
    cimdCache.set(clientId, { client, exp: Date.now() + (client ? CIMD_CACHE_TTL_MS : CIMD_NEG_TTL_MS) })
    return client
  }
  return getStoredClient(clientId)
}
