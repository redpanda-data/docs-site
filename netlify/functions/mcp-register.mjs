// Self-service registration for the Redpanda Docs MCP server.
// -----------------------------------------------------------
// A user submits their work email; after validation we generate a bearer token,
// store it (hashed), and DELIVER IT BY EMAIL ONLY. Receiving the token is the
// proof the address is real and owned, which is what prevents fake/non-emails.
// The token is never returned in the HTTP response body.

import { normalizeEmail, isWorkEmail, generateToken, hashToken } from './lib/auth.mjs'
import { hasValidMx, sendTokenEmail } from './lib/email.mjs'
import { saveRegistration } from './lib/store.mjs'

const REGISTRATION_URL = 'https://docs.redpanda.com/mcp/register'
const DOCS_URL = 'https://docs.redpanda.com/data-platform/how-to-use-these-docs#authentication'

// -------------------- Lightweight per-IP rate limit --------------------
// Best-effort, in-memory (resets on cold start). Blunts scripted abuse without
// a dependency. Not a security control.
const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_WINDOW = Number(process.env.MCP_REGISTER_RATE_LIMIT || 5)
const hits = new Map()

function clientIp(request) {
  return (
    request.headers.get('x-nf-client-connection-ip') ||
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  )
}

function rateLimited(ip) {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 })
    return false
  }
  entry.count += 1
  return entry.count > MAX_PER_WINDOW
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extraHeaders },
  })
}

const REASON_MESSAGES = {
  invalid_format: 'That doesn\'t look like a valid email address.',
  free_provider: 'Please use your work email. Free providers (Gmail, Outlook, etc.) aren\'t accepted.',
  disposable: 'Disposable email addresses aren\'t accepted. Please use your work email.',
  no_mx: 'We couldn\'t verify that email domain can receive mail. Check for typos.',
}

function formPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redpanda Docs MCP — Get an access token</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 22px; }
  input[type=email] { width: 100%; padding: 10px; font-size: 16px; box-sizing: border-box; margin: 8px 0; }
  button { background: #e2401c; color: #fff; border: 0; padding: 11px 18px; font-size: 16px; border-radius: 6px; cursor: pointer; }
  .note { color: #555; font-size: 13px; line-height: 1.5; margin-top: 24px; }
  #msg { margin-top: 16px; font-size: 15px; }
</style>
</head>
<body>
  <h1>Get a Redpanda Docs MCP token</h1>
  <p>Enter your work email to receive a free access token for the documentation MCP server. We'll email the token to you.</p>
  <form id="f">
    <input type="email" id="email" name="email" placeholder="you@yourcompany.com" required>
    <button type="submit">Email me a token</button>
  </form>
  <div id="msg"></div>
  <p class="note">
    We collect your work email address, its domain, and request counts to track usage and
    attribute it to your organization. This may be shared with our CRM and passed to our
    documentation search provider (Kapa) for usage attribution. We don't store the content of
    your queries. To revoke your token or delete your data, reply to the token email.
  </p>
  <script>
    const f = document.getElementById('f'), msg = document.getElementById('msg')
    f.addEventListener('submit', async (e) => {
      e.preventDefault()
      msg.textContent = 'Sending…'
      try {
        const r = await fetch('/mcp/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: document.getElementById('email').value })
        })
        const data = await r.json()
        msg.textContent = r.ok
          ? '✅ ' + (data.message || 'Check your inbox for your token.')
          : '⚠️ ' + (data.message || 'Something went wrong.')
      } catch (err) {
        msg.textContent = '⚠️ Network error. Please try again.'
      }
    })
  </script>
</body>
</html>`
}

async function parseEmail(request) {
  const ct = request.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    return body?.email
  }
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    return form?.get('email')
  }
  // Fallback: try JSON anyway.
  const body = await request.json().catch(() => ({}))
  return body?.email
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
  }

  if (request.method === 'GET') {
    const url = new URL(request.url)
    if (url.searchParams.get('format') === 'json') {
      return json({
        endpoint: REGISTRATION_URL,
        method: 'POST',
        body: { email: 'you@yourcompany.com' },
        note: 'On success, the token is emailed to you (202). It is never returned in the response.',
        docs: DOCS_URL,
      })
    }
    return new Response(formPage(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
    })
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST, OPTIONS' })
  }

  const ip = clientIp(request)
  if (rateLimited(ip)) {
    return json({ error: 'rate_limited', message: 'Too many registration attempts. Try again later.' }, 429)
  }

  // --- Validation pipeline (stop at first failure) ---
  let email, domain
  try {
    ;({ email, domain } = normalizeEmail(await parseEmail(request))) // Layer 1: format
  } catch {
    return json({ error: 'invalid_email', reason: 'invalid_format', message: REASON_MESSAGES.invalid_format }, 400)
  }

  const work = isWorkEmail(domain) // Layer 2: work-domain
  if (!work.ok) {
    return json({ error: 'invalid_email', reason: work.reason, message: REASON_MESSAGES[work.reason] }, 400)
  }

  if (!(await hasValidMx(domain))) { // Layer 3: MX
    return json({ error: 'invalid_email', reason: 'no_mx', message: REASON_MESSAGES.no_mx }, 400)
  }

  // --- Issue + store token ---
  const token = generateToken()
  const tokenHash = hashToken(token)
  try {
    await saveRegistration({ tokenHash, email, domain })
  } catch (e) {
    console.error('[mcp-register] store write failed', { error: e?.message })
    return json({ error: 'storage_error', message: 'Could not create your token. Please try again.' }, 500)
  }

  // --- Layer 4: deliver token by email (ownership proof). Token NOT in response. ---
  let sent
  try {
    sent = await sendTokenEmail({ to: email, token })
  } catch (e) {
    console.error('[mcp-register] email send error', { error: e?.message, domain })
    return json({ error: 'email_send_failed', message: 'Could not send the token email. Please try again.' }, 502)
  }
  if (!sent?.ok) {
    return json({ error: 'email_send_failed', message: 'Could not send the token email. Please try again.' }, 502)
  }

  // --- Lead-capture side effects (best-effort; never block the response) ---
  const emailHash = tokenHash.slice(0, 12) // non-reversible reference for logs
  console.log(JSON.stringify({ event: 'mcp_registration', domain, emailHash, ts: new Date().toISOString() }))

  if (process.env.CRM_WEBHOOK_URL) {
    fetch(process.env.CRM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, domain, source: 'mcp', timestamp: new Date().toISOString() }),
    }).catch((e) => console.warn('[mcp-register] CRM webhook failed', { error: e?.message }))
  }

  return json(
    { status: 'token_sent', email, message: `Token sent to ${email}. Check your inbox (and spam).` },
    202
  )
}

export const config = {
  path: '/mcp/register',
  preferStatic: false,
}
