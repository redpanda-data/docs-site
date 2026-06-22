// OAuth state storage — Netlify Blobs backend.
//
// Extracted from store.mjs so the backend can be selected at runtime (see
// store.mjs). This is the default backend. Keyed lookups by id/hash fit Blobs.
//
// KNOWN LIMITATION (the reason the Neon backend exists): one-time-use here is
// read-then-delete / read-then-mark, and Blobs has no compare-and-swap, so two
// *simultaneous* requests with the same auth code (or refresh token) can both
// observe it as unused before either consumes it. For refresh tokens a
// concurrent legit+stolen use inside that window would both rotate without
// tripping family revocation. The Neon backend fixes this with a single atomic
// `UPDATE … WHERE used = false RETURNING`.

import { getStore } from '@netlify/blobs'
import { randomUUID, randomBytes } from 'node:crypto'
import { AUTH_REQUEST_TTL_SEC, AUTH_CODE_TTL_SEC } from '../config.mjs'

const STORE = 'mcp-oauth'
const AR = (id) => `ar:${id}` // auth request
const AC = (code) => `ac:${code}` // authorization code
const CL = (id) => `client:${id}` // DCR-registered client
const RT = (h) => `rt:${h}` // refresh token (by hash)
const RTF = (id) => `rtf:${id}` // refresh-token family

function store() {
  // STRONG consistency: auth codes and refresh tokens are one-time use, and
  // Blobs' default eventual consistency propagates deletes/updates over up to
  // 60s — long enough for a consumed code/token to be replayed in that window.
  return getStore({ name: STORE, consistency: 'strong' })
}
const expired = (rec) => !rec || Date.now() > rec.expiresAt

export async function putAuthRequest(data) {
  const id = randomUUID()
  await store().setJSON(AR(id), { ...data, expiresAt: Date.now() + AUTH_REQUEST_TTL_SEC * 1000 })
  return id
}

export async function takeAuthRequest(id) {
  if (!id) return null
  const key = AR(id)
  const rec = await store().get(key, { type: 'json' }).catch(() => null)
  await store().delete(key).catch(() => {}) // one-time
  return expired(rec) ? null : rec
}

export async function putAuthCode(data) {
  const code = randomBytes(32).toString('base64url')
  await store().setJSON(AC(code), { ...data, used: false, expiresAt: Date.now() + AUTH_CODE_TTL_SEC * 1000 })
  return code
}

export async function takeAuthCode(code) {
  if (!code) return null
  const key = AC(code)
  const rec = await store().get(key, { type: 'json' }).catch(() => null)
  if (expired(rec) || rec.used) return null
  await store().delete(key).catch(() => {}) // one-time use
  return rec
}

// --- DCR-registered clients (persistent; no TTL) ---
export async function putClient(client) {
  await store().setJSON(CL(client.client_id), client)
  return client
}

export async function getStoredClient(clientId) {
  if (!clientId) return null
  // Resilient: a store error (e.g. Blobs unavailable) resolves to "unknown
  // client" rather than crashing the /authorize handler.
  try {
    return await store().get(CL(clientId), { type: 'json' })
  } catch {
    return null
  }
}

// --- refresh tokens (by hash) + families ---
export async function putRefresh(hash, rec) {
  await store().setJSON(RT(hash), rec)
}
export async function getRefresh(hash) {
  if (!hash) return null
  return store().get(RT(hash), { type: 'json' }).catch(() => null)
}

// Best-effort "consume": mark the token used and return it, or null if it was
// already used / missing. NOT atomic (no CAS on Blobs) — a concurrent caller
// can also observe it unused. The Neon backend makes this atomic.
export async function consumeRefresh(hash) {
  const rec = await getRefresh(hash)
  if (!rec || rec.used) return null
  await store().setJSON(RT(hash), { ...rec, used: true })
  return rec
}

export async function putFamily(id, rec) {
  await store().setJSON(RTF(id), rec)
}
export async function getFamily(id) {
  if (!id) return null
  return store().get(RTF(id), { type: 'json' }).catch(() => null)
}
export async function revokeFamily(id) {
  const fam = (await getFamily(id)) || {}
  await store().setJSON(RTF(id), { ...fam, revoked: true, revokedAt: Date.now() })
}
