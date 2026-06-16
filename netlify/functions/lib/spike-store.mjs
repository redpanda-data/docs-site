// SPIKE ONLY — file-backed storage for the AS flow.
//
// SPIKE FINDING: in-memory Maps do NOT survive across function invocations
// (even under local `functions:serve`), and the OAuth flow spans multiple
// requests (/authorize → /callback → /token). So persistence is mandatory just
// for the flow to function — confirming the production need for **Netlify DB
// (Neon Postgres)**. This file-backed store (os.tmpdir) is a stand-in with the
// exact put/take shape the DB tables will have (auth_requests,
// authorization_codes, refresh_tokens).

import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILE = join(tmpdir(), 'mcp-as-spike-store.json')
const TTL_MS = 10 * 60 * 1000

function load() {
  if (!existsSync(FILE)) return { authRequests: {}, authCodes: {} }
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return { authRequests: {}, authCodes: {} }
  }
}
function save(db) {
  writeFileSync(FILE, JSON.stringify(db))
}
const expired = (rec) => Date.now() - rec.createdAt > TTL_MS

// ---- auth requests: in-flight flow between /authorize and /callback ----
export function putAuthRequest(data) {
  const db = load()
  const id = randomUUID()
  db.authRequests[id] = { ...data, createdAt: Date.now() }
  save(db)
  return id
}

export function takeAuthRequest(id) {
  const db = load()
  const rec = db.authRequests[id]
  delete db.authRequests[id] // one-time
  save(db)
  if (!rec || expired(rec)) return null
  return rec
}

// ---- authorization codes: issued to the downstream client at /callback ----
export function putAuthCode(data) {
  const db = load()
  const code = randomBytes(32).toString('base64url')
  db.authCodes[code] = { ...data, createdAt: Date.now(), used: false }
  save(db)
  return code
}

export function takeAuthCode(code) {
  const db = load()
  const rec = db.authCodes[code]
  if (!rec || rec.used || expired(rec)) return null
  rec.used = true // one-time use
  db.authCodes[code] = rec
  save(db)
  return rec
}
