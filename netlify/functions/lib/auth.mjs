// OAuth resource-server core for the Redpanda Docs MCP server.
// ------------------------------------------------------------
// Pure, dependency-light helpers (no network, no Blobs) so they can be
// unit-tested without the Netlify runtime. Token validation against the
// Redpanda Cloud IdP lives in idp.mjs; user capture lives in store.mjs.
//
// The MCP server acts as an OAuth 2.1 Resource Server (per the MCP authorization
// spec). MCP clients (ChatGPT, Claude, Cursor, …) discover the authorization
// server via /.well-known/oauth-protected-resource (RFC 9728), sign in with a
// Redpanda Cloud account, and send `Authorization: Bearer <token>`. We validate
// the token and capture the user's verified work email.

import { createHash } from 'node:crypto'

// -------------------- Email classification --------------------

// Free consumer providers — rejected when a work email is required.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'ymail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'pm.me', 'aol.com', 'gmx.com', 'gmx.net', 'yandex.com', 'yandex.ru',
  'mail.com', 'zoho.com', 'qq.com', '163.com', '126.com',
])

// Disposable / throwaway providers. Best-effort seed list, not exhaustive.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'guerrillamail.info',
  'sharklasers.com', 'getnada.com', 'nada.email', 'yopmail.com', 'trashmail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'maildrop.cc',
  'dispostable.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com',
])

export function emailDomain(email) {
  const e = String(email || '').trim().toLowerCase()
  const at = e.lastIndexOf('@')
  return at === -1 ? '' : e.slice(at + 1)
}

// Returns { ok, reason? }. Rejects free + disposable providers.
export function isWorkEmail(domain) {
  const d = String(domain || '').trim().toLowerCase()
  if (!d) return { ok: false, reason: 'invalid_format' }
  if (FREE_EMAIL_DOMAINS.has(d)) return { ok: false, reason: 'free_provider' }
  if (DISPOSABLE_DOMAINS.has(d)) return { ok: false, reason: 'disposable' }
  return { ok: true }
}

// -------------------- Request parsing --------------------

// OAuth bearer tokens travel in the Authorization header only. (The MCP/OAuth
// spec forbids tokens in the query string, and ChatGPT only sends them as a
// header, so there is no ?token= fallback here.)
export function extractBearerToken(authHeader) {
  const m = String(authHeader || '').match(/^\s*Bearer\s+(.+?)\s*$/i)
  return m ? m[1] : null
}

// Used as a cache key / opaque reference. Tokens are never logged in the clear.
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

// -------------------- Config flags --------------------

// Auth is enforced only when REQUIRE_AUTH === 'true' (default = grace period).
export function isAuthEnforced() {
  return process.env.REQUIRE_AUTH === 'true'
}

// Require a work email (reject free/disposable). Default false — with Cloud
// login the email is already verified, so we accept any verified Cloud account.
// Set REQUIRE_WORK_EMAIL=true to reject free/disposable providers.
export function isWorkEmailRequired() {
  return process.env.REQUIRE_WORK_EMAIL === 'true'
}

// -------------------- Responses --------------------

const DOCS_URL = 'https://docs.redpanda.com/data-platform/how-to-use-these-docs#authentication'

// RFC 6750 / RFC 9728 compliant 401. The `resource_metadata` parameter points
// MCP clients at our protected-resource-metadata document so they can discover
// the Redpanda Cloud authorization server and start the OAuth flow.
export function buildUnauthorizedResponse({ resourceMetadataUrl, error = 'invalid_token', description } = {}) {
  const meta = resourceMetadataUrl || 'https://docs.redpanda.com/.well-known/oauth-protected-resource'
  const desc = description || 'Sign in with your Redpanda Cloud account to use the Redpanda Docs MCP server.'
  return {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer realm="redpanda-docs-mcp", error="${error}", error_description="${desc}", resource_metadata="${meta}"`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: {
      error: 'authentication_required',
      message: desc,
      resource_metadata: meta,
      docs_url: DOCS_URL,
    },
  }
}

function buildForbiddenWorkEmail(reason) {
  const message =
    reason === 'disposable'
      ? 'Disposable email addresses are not accepted. Sign in with your work account.'
      : 'Please sign in with your work account. Personal email providers (Gmail, Outlook, etc.) are not accepted.'
  return {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { error: 'work_email_required', reason, message, docs_url: DOCS_URL },
  }
}

// -------------------- Decision logic (pure, unit-tested) --------------------
//
// `claims` is the validated token's userinfo (or null if no/invalid token).
// Returns { allow, userContext, response } where `response` is a framework-
// agnostic { status, headers, body } to return on rejection.
export function decideAuth({ claims, enforced, workEmailRequired, resourceMetadataUrl }) {
  if (!claims) {
    if (enforced) {
      return { allow: false, userContext: null, response: buildUnauthorizedResponse({ resourceMetadataUrl }) }
    }
    // Grace period: allow through with no attribution.
    return { allow: true, userContext: null, response: null }
  }

  const email = String(claims.email || '').trim().toLowerCase()
  const domain = emailDomain(email)

  if (workEmailRequired && email) {
    const work = isWorkEmail(domain)
    if (!work.ok) {
      return { allow: false, userContext: null, response: buildForbiddenWorkEmail(work.reason) }
    }
  }

  return {
    allow: true,
    userContext: {
      sub: claims.sub || null,
      email: email || null,
      domain: domain || null,
      emailVerified: claims.email_verified === true,
    },
    response: null,
  }
}
