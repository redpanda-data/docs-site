// Auth core for the Redpanda Docs MCP server.
// -------------------------------------------
// Pure, dependency-light helpers so they can be unit-tested without the Netlify
// runtime (no Netlify Blobs, no DNS, no email here). All side-effecting code
// lives in store.mjs (Blobs) and email.mjs (DNS + provider).

import { createHash, randomBytes } from 'node:crypto'

// -------------------- Email classification --------------------

// Free consumer providers. We want *work* emails, so these are rejected.
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'aol.com',
  'gmx.com',
  'gmx.net',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'zoho.com',
  'qq.com',
  '163.com',
  '126.com',
])

// Disposable / throwaway providers. Best-effort seed list, not exhaustive.
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'sharklasers.com',
  'getnada.com',
  'nada.email',
  'yopmail.com',
  'trashmail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'maildrop.cc',
  'dispostable.com',
  'fakeinbox.com',
  'mintemail.com',
  'mohmal.com',
])

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Layer 1: format. Returns { email, domain } or throws a typed error.
export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase()
  if (!email || !EMAIL_SHAPE.test(email)) {
    const err = new Error('invalid email format')
    err.code = 'invalid_format'
    throw err
  }
  const domain = email.slice(email.lastIndexOf('@') + 1)
  return { email, domain }
}

// Layer 2: work-domain filter. Returns { ok, reason? }.
export function isWorkEmail(domain) {
  const d = String(domain || '').trim().toLowerCase()
  if (!d) return { ok: false, reason: 'invalid_format' }
  if (FREE_EMAIL_DOMAINS.has(d)) return { ok: false, reason: 'free_provider' }
  if (DISPOSABLE_DOMAINS.has(d)) return { ok: false, reason: 'disposable' }
  return { ok: true }
}

// -------------------- Tokens --------------------

const TOKEN_PREFIX = 'rp_mcp_'

// Opaque, high-entropy bearer token. The prefix makes tokens greppable in logs
// and configs and lets us fast-reject obviously malformed values.
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

export function looksLikeToken(token) {
  return typeof token === 'string' && token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length + 20
}

// We store only the hash. Tokens are 256-bit random, so a plain SHA-256 is
// sufficient (no salt/KDF needed — they aren't guessable like passwords).
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

// -------------------- Request parsing --------------------

// Extract a bearer token from the Authorization header, falling back to a
// ?token= / ?key= query param for MCP clients that can't set static headers
// (e.g. some ChatGPT/Connectors configurations).
export function extractBearerToken(authHeader, urlQueryToken) {
  const header = String(authHeader || '')
  const match = header.match(/^\s*Bearer\s+(.+)\s*$/i)
  if (match) return match[1].trim()
  if (urlQueryToken) return String(urlQueryToken).trim()
  return null
}

// -------------------- Responses --------------------

const DOCS_URL = 'https://docs.redpanda.com/data-platform/how-to-use-these-docs#authentication'

// Framework-agnostic 401 ({ status, headers, body }) so it can be returned from
// either the Hono layer or a raw handler, and asserted in unit tests.
export function buildUnauthorizedResponse({ registrationUrl, reason } = {}) {
  const regUrl = registrationUrl || 'https://docs.redpanda.com/mcp/register'
  const description =
    'Register a free token with your work email, then send Authorization: Bearer <token>.'
  return {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer realm="redpanda-docs-mcp", error="${reason || 'invalid_token'}", error_description="${description}", resource_metadata="${regUrl}"`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: {
      error: 'authentication_required',
      message: `${description} Get one at ${regUrl}`,
      registration_url: regUrl,
      docs_url: DOCS_URL,
    },
  }
}

// -------------------- Enforcement --------------------

// Auth is enforced only when REQUIRE_AUTH is exactly 'true'. Anything else
// (unset, 'false', etc.) is the grace period: requests pass through.
export function isAuthEnforced() {
  return process.env.REQUIRE_AUTH === 'true'
}

// Pure decision helper so the middleware's branching logic is unit-testable
// without Hono or Blobs. `record` is the stored token record (or null).
export function decideAuth({ record, enforced }) {
  if (record && !record.revoked) {
    return {
      allow: true,
      userContext: { email: record.email, domain: record.domain },
      unauthorized: null,
    }
  }
  if (enforced) {
    return { allow: false, userContext: null, unauthorized: buildUnauthorizedResponse({}) }
  }
  // Grace period: allow through with no attribution.
  return { allow: true, userContext: null, unauthorized: null }
}
