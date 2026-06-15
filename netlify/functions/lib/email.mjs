// Email side effects for MCP registration: MX validation + token delivery.
// ------------------------------------------------------------------------
// Impure (DNS + network). Kept separate from auth.mjs so the pure logic stays
// unit-testable; these functions are mocked in tests.

import { promises as dns } from 'node:dns'

const MX_TIMEOUT_MS = 4_000

function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}_timeout`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

// Layer 3: reject domains that can't receive mail (typos, fake domains) before
// we attempt to send. Accept if the domain has MX records, or (fallback) an A
// record. Any lookup failure is treated as invalid.
export async function hasValidMx(domain) {
  const d = String(domain || '').trim().toLowerCase()
  if (!d) return false
  try {
    const mx = await withTimeout(dns.resolveMx(d), MX_TIMEOUT_MS, 'mx')
    if (Array.isArray(mx) && mx.length > 0) return true
  } catch {
    // fall through to A-record fallback
  }
  try {
    const a = await withTimeout(dns.resolve(d), MX_TIMEOUT_MS, 'a')
    return Array.isArray(a) && a.length > 0
  } catch {
    return false
  }
}

const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.MCP_FROM_EMAIL || 'Redpanda Docs <docs-mcp@redpanda.com>'

function tokenEmailBody(token) {
  const text = `Thanks for registering for the Redpanda Docs MCP server.

Your access token:

  ${token}

Add it to your MCP client as an Authorization header:

  Authorization: Bearer ${token}

Or, for clients that can't set headers, append it to the URL:

  https://docs.redpanda.com/mcp?token=${token}

Setup instructions: https://docs.redpanda.com/data-platform/how-to-use-these-docs#authentication

Keep this token private. If you need it revoked, reply to this email.`

  const html = `<p>Thanks for registering for the Redpanda Docs MCP server.</p>
<p>Your access token:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:14px">${token}</pre>
<p>Add it to your MCP client as an Authorization header:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:14px">Authorization: Bearer ${token}</pre>
<p>Or, for clients that can't set headers, append it to the URL:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:14px">https://docs.redpanda.com/mcp?token=${token}</pre>
<p><a href="https://docs.redpanda.com/data-platform/how-to-use-these-docs#authentication">Setup instructions</a></p>
<p style="color:#666;font-size:13px">Keep this token private. If you need it revoked, reply to this email.</p>`

  return { text, html }
}

// Layer 4: deliver the token to the address. Possession of a working token is
// the proof the email is real and owned, so the token is NEVER returned in the
// HTTP response — only here.
//
// Dev bypass: ONLY under `netlify dev`/`functions:serve` (which set
// NETLIFY_DEV=true) with no RESEND_API_KEY, log the token to the console so
// local testing works without a provider. In any deployed environment a missing
// key is a hard error — we never silently log tokens instead of emailing them.
export async function sendTokenEmail({ to, token }) {
  if (!RESEND_API_KEY) {
    if (process.env.NETLIFY_DEV === 'true') {
      console.log(`[mcp-register][dev-bypass] token for ${to}: ${token}`)
      return { ok: true, devBypass: true }
    }
    throw new Error('RESEND_API_KEY is required to deliver MCP tokens')
  }

  const { text, html } = tokenEmailBody(token)
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject: 'Your Redpanda Docs MCP access token',
      text,
      html,
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[mcp-register] Resend send failed', { status: res.status, detail: detail.slice(0, 300) })
    return { ok: false, status: res.status }
  }
  return { ok: true }
}
