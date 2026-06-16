// AS state storage — auth requests (in-flight) + authorization codes.
//
// Backed by Netlify Blobs (available today; key-value fits the AS state, which
// is all keyed lookups by id/hash). The interface below is the seam for a
// Netlify DB (Neon Postgres) backend when relational queries/analytics are
// needed — swap the four functions; callers don't change.
//
// NOTE: refresh tokens (Milestone 3) and registered clients/DCR (Milestone 2)
// will add tables/namespaces here.

import { getStore } from '@netlify/blobs'
import { randomUUID, randomBytes } from 'node:crypto'
import { AUTH_REQUEST_TTL_SEC, AUTH_CODE_TTL_SEC } from './config.mjs'

const STORE = 'mcp-oauth'
const AR = (id) => `ar:${id}` // auth request
const AC = (code) => `ac:${code}` // authorization code

function store() {
  return getStore(STORE)
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
