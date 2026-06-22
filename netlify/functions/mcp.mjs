// Redpanda Docs MCP Server on Netlify Functions
// -----------------------------------------------
// This serverless function implements the MCP (Model Context Protocol) server
// that proxies requests to Kapa AI's chat and search APIs for Redpanda documentation.
// It uses the official MCP SDK plus the Netlify adapter (modelfetch) to support
// JSON-RPC over HTTP and SSE streaming.
//
// Auth: acts as an OAuth 2.0 resource server. The auth middleware below validates
// our own access tokens (issued by the AS in mcp-oauth.mjs); enforcement is gated
// by REQUIRE_AUTH. Tokens are issued via the separate authorization-server function.
//
// For background and reference implementations, see:
// - Kapa AI blog: Build an MCP Server with Kapa AI
//   https://www.kapa.ai/blog/build-an-mcp-server-with-kapa-ai
// - Netlify guide: Writing MCPs on Netlify
//   https://developers.netlify.com/guides/write-mcps-on-netlify/

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import handle from '@modelfetch/netlify'

import { extractBearerToken, decideAuth, isAuthEnforced, isWorkEmailRequired } from './lib/auth.mjs'
import { verifyAccessToken } from './lib/oauth/keys.mjs'
import { recordUser } from './lib/store.mjs'

import rateLimiterModule from 'hono-rate-limiter'
const makeRateLimiter =
  rateLimiterModule.rateLimiter ||
  rateLimiterModule.default ||
  rateLimiterModule

// -------------------- Config --------------------

const SERVER_VERSION = '1.3.0'

// Hardcoded upstream
const KAPA_MCP_SERVER_URL = 'https://redpanda.mcp.kapa.ai'
const KAPA_TOOL_NAME = 'search_redpanda_knowledge_sources'

// Secret
const KAPA_API_KEY = process.env.KAPA_API_KEY

// Bump.sh API documentation MCP (hub endpoint)
// Provides structured access to OpenAPI-based API docs
// Note: Bump's MCP server is public and doesn't require authentication
// Using the hub endpoint allows searching across all APIs or scoping to specific ones
const BUMP_HUB_MCP_URL = 'https://bump.sh/redpanda/hub/redpanda/mcp'
const API_BASE_URL = 'https://docs.redpanda.com/api/doc'

// Map api param to full URL for scoping (Bump validates the actual API names)
function apiToUrl(api) {
  if (!api || api === 'all') return undefined // No scoping = search all APIs
  return `${API_BASE_URL}/${api}`
}

// Limits and timeouts
const CONNECT_TIMEOUT_MS = 8_000
const CALL_TIMEOUT_MS = 22_000
const MAX_QUERY_CHARS = 2_000
const MAX_FEEDBACK_CHARS = 5_000

// Feedback is submitted to the existing `api-feedback` Netlify form — the same
// store our docs feedback uses. Registered fields live in
// home/modules/ROOT/attachments/api-feedback-registration.html (keep in sync).
//
// IMPORTANT: Netlify only processes a form POST if it reaches a static 200 page;
// the site root `/` 301-redirects to `/home/`, and a redirect drops the POST
// body (so the form is never recorded). We therefore POST to a non-redirecting
// page (`/home/`) and use `redirect: 'error'` below so a redirect surfaces as a
// failure instead of a false success. Override the path with MCP_FEEDBACK_FORM_PATH.
const FEEDBACK_FORM_NAME = 'api-feedback'
const FEEDBACK_FORM_PATH = process.env.MCP_FEEDBACK_FORM_PATH || '/home/'
const SITE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || ''

// -------------------- Helpers --------------------

function withTimeout(promise, ms, label) {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}_timeout`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutId)
  )
}

// Submit a field map to the `api-feedback` Netlify form (URL-encoded POST to a
// non-redirecting page, with the required form-name). `redirect: 'error'` means
// any 3xx (e.g. hitting a redirect that would drop the POST body) throws rather
// than following it to a 200 and falsely reporting success. Throws on a missing
// site URL or a non-2xx so the caller surfaces a clear failure to the agent.
async function submitFeedback(fields) {
  if (!SITE_URL) throw new Error('site URL not configured')
  const body = new URLSearchParams({ 'form-name': FEEDBACK_FORM_NAME, ...fields })
  const res = await fetch(`${SITE_URL}${FEEDBACK_FORM_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`feedback submission failed: ${res.status}`)
}

// -------------------- Rate limiting --------------------

const computeLimiterKey = (c) => {
  const h = (name) => c.req.header(name) || ''

  // Authenticated requests get per-user limits (set by the auth middleware).
  const auth = c.get('auth')
  if (auth?.sub) return `sub:${auth.sub}`
  if (auth?.email) return `email:${auth.email}`

  const clientKey = h('x-client-key')
  if (clientKey) return `ck:${clientKey}`

  if (c.ip) return `ip:${c.ip}`

  const nfIp = h('x-nf-client-connection-ip')
  if (nfIp) return `ip:${nfIp}`

  const cfIp = h('cf-connecting-ip')
  if (cfIp) return `ip:${cfIp}`

  const xff = h('x-forwarded-for').split(',')[0]?.trim()
  if (xff) return `ip:${xff}`

  const realIp = h('x-real-ip')
  if (realIp) return `ip:${realIp}`

  return `ua:${h('user-agent')}|${h('accept')}`
}

// -------------------- Upstream MCP client --------------------
//
// Global state reused across warm Netlify invocations.
// Reset + retry-once handles stale connections safely.

const kapaClient = new Client({
  name: 'redpanda-netlify-proxy',
  version: SERVER_VERSION,
})

let kapaConnectPromise = null
let kapaTransport = null

function resetKapaConnection() {
  kapaConnectPromise = null
  kapaTransport = null
}

function isTransientError(msg) {
  return (
    msg.includes('timeout') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket') ||
    msg.includes('fetch') ||
    msg.includes('stream') ||
    msg.includes('EPIPE') ||
    msg.includes('ENOTFOUND')
  )
}

function ensureKapaConnected() {
  if (kapaConnectPromise) return kapaConnectPromise

  if (!KAPA_API_KEY) {
    // Throwing here is fine. Tool handler will capture and return a clean error.
    throw new Error('Missing env var: KAPA_API_KEY')
  }

  kapaTransport = new StreamableHTTPClientTransport(
    new URL(KAPA_MCP_SERVER_URL),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${KAPA_API_KEY}`,
        },
      },
    }
  )

  kapaConnectPromise = kapaClient.connect(kapaTransport)
  return kapaConnectPromise
}

// Kapa Hosted MCP search tool accepts `query`. When we have an authenticated
// user we also attach `_meta.user` for Kapa-side usage attribution.
function callKapaSearch(query, user = null) {
  const toolCall = {
    name: KAPA_TOOL_NAME,
    arguments: { query },
  }
  if (user?.email) {
    toolCall._meta = {
      user: {
        email: user.email,
        company_name: user.domain || undefined,
      },
    }
  }
  return kapaClient.callTool(toolCall)
}

// -------------------- Bump.sh API Docs MCP client --------------------
//
// Single hub client that can search across all APIs or scope to specific ones.
// Much simpler than managing 5 separate clients!

const bumpClient = new Client({
  name: 'redpanda-bump-hub',
  version: SERVER_VERSION,
})

let bumpConnectPromise = null

function resetBumpConnection() {
  bumpConnectPromise = null
}

function ensureBumpConnected() {
  if (bumpConnectPromise) return bumpConnectPromise

  const transport = new StreamableHTTPClientTransport(
    new URL(BUMP_HUB_MCP_URL)
  )

  bumpConnectPromise = bumpClient.connect(transport)
  return bumpConnectPromise
}

function callBumpTool(toolName, args) {
  return bumpClient.callTool({
    name: toolName,
    arguments: args,
  })
}

// -------------------- MCP Server --------------------

const server = new McpServer({
  name: 'Redpanda Docs MCP',
  version: SERVER_VERSION,
})

// -------------------- MCPcat Analytics --------------------
// Initialize MCPcat tracking (if MCPCAT_PROJECT is set)
// MCPcat is an open-source analytics platform for MCP usage tracking.
// See https://www.mcpcat.com/ for details.

const MCPCAT_PROJECT = process.env.MCPCAT_PROJECT

if (MCPCAT_PROJECT) {
  try {
    // Dynamic import to avoid bundler issues
    const { track } = await import('mcpcat')
    track(server, MCPCAT_PROJECT)
  } catch (e) {
    // Don't crash the MCP server if analytics fail to load.
    console.warn('[mcpcat] disabled due to import error:', e)
  }
}

server.registerTool(
  'ask_redpanda_question',
  {
    title: 'Search Redpanda Sources',
    description:
      'Search the official Redpanda documentation and return the most relevant sections from it for a user query. Each returned section includes the url and its actual content in markdown. Use this tool for all queries that require Redpanda knowledge. Results are ordered by relevance, with the most relevant result returned first.',
    inputSchema: {
      question: z.string(),

      // Accepted for compatibility, but ignored.
      top_k: z.number().optional(),
    },
  },
  async (args, extra) => {
    const start = Date.now()

    // Authenticated user context, attached by the auth middleware via c.set('auth').
    const user = extra?.authInfo || null

    const q = String(args?.question || '').trim()
    if (!q) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'missing_query',
              message: 'Provide a non-empty "question".',
            }),
          },
        ],
      }
    }

    if (q.length > MAX_QUERY_CHARS) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'query_too_long',
              message: `Question exceeds ${MAX_QUERY_CHARS} characters.`,
            }),
          },
        ],
      }
    }

    try {
      await withTimeout(
        ensureKapaConnected(),
        CONNECT_TIMEOUT_MS,
        'kapa_connect'
      )

      return await withTimeout(
        callKapaSearch(q, user),
        CALL_TIMEOUT_MS,
        'kapa_callTool'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Kapa MCP call failed, retrying', {
        error: msg,
        phase: 'initial',
        upstream: 'kapa-mcp',
      })

      // If Kapa rejected the request because of our user metadata, retry once
      // without it (attribution is best-effort; never block the answer).
      if (/_meta|metadata/i.test(msg) && user) {
        try {
          return await withTimeout(callKapaSearch(q, null), CALL_TIMEOUT_MS, 'kapa_callTool_no_meta')
        } catch {
          // fall through to the normal transient-retry path below
        }
      }

      if (isTransientError(msg)) {
        // retry once
        try {
          resetKapaConnection()
          await withTimeout(
            ensureKapaConnected(),
            CONNECT_TIMEOUT_MS,
            'kapa_reconnect'
          )
          return await withTimeout(
            callKapaSearch(q, user),
            CALL_TIMEOUT_MS,
            'kapa_callTool_retry'
          )
        } catch (retryErr) {
          const retryMsg =
            retryErr instanceof Error ? retryErr.message : String(retryErr)
            console.error('Kapa MCP retry failed', {
              error: retryMsg,
              phase: 'retry',
              upstream: 'kapa-mcp',
              duration_ms: Date.now() - start,
            })

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: retryMsg.includes('timeout')
                    ? 'timeout'
                    : 'upstream_error',
                  message: 'Upstream Kapa MCP request failed after retry.',
                  detail: retryMsg, // include detail for debugging (no query logged)
                  duration_ms: Date.now() - start,
                }),
              },
            ],
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: msg.includes('timeout') ? 'timeout' : 'upstream_error',
              message: 'Upstream Kapa MCP request failed.',
              detail: msg, // include detail for debugging (no query logged)
              duration_ms: Date.now() - start,
            }),
          },
        ],
      }
    }
  }
)

// -------------------- Bump.sh API Documentation Tools --------------------
// These tools provide structured access to Redpanda API documentation hosted on Bump.sh.
// They use the hub endpoint which can search across all APIs or scope to specific ones.

server.registerTool(
  'list_api_reference_pages',
  {
    title: 'List API Reference Pages',
    description:
      `List pages in Redpanda API reference documentation. Returns endpoints, schemas, and topic pages with URL, title, type, and description.

SCOPING (important for accurate results):
- api="all" or omit: Lists all available APIs
- api="admin": Cluster management operations (brokers, partitions, configs, users)
- api="cloud-controlplane": Redpanda Cloud resource management (clusters, networks, namespaces)
- api="cloud-dataplane": Cloud cluster data operations (topics, ACLs, connectors)
- api="http-proxy": Kafka operations over HTTP (produce, consume, offsets)
- api="schema-registry": Schema management (register, retrieve, compatibility)

Use this to browse API structure. For general Redpanda docs, use ask_redpanda_question instead.`,
    inputSchema: {
      api: z.string().optional().describe('Which API to list: "all" or omit for overview of all APIs, or a specific API name (admin, cloud-controlplane, cloud-dataplane, http-proxy, schema-registry)'),
      url: z.string().optional().describe('Specific URL path to list children of (optional, defaults to API root)'),
    },
  },
  async (args) => {
    const start = Date.now()

    try {
      await withTimeout(ensureBumpConnected(), CONNECT_TIMEOUT_MS, 'bump_connect')

      // Build args for hub endpoint - use url param for scoping
      const hubArgs = {}
      const scopeUrl = apiToUrl(args.api)
      if (scopeUrl) hubArgs.url = args.url || scopeUrl
      else if (args.url) hubArgs.url = args.url

      return await withTimeout(
        callBumpTool('list_pages', hubArgs),
        CALL_TIMEOUT_MS,
        'bump_list_pages'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Bump MCP list_pages failed', { error: msg, api: args.api, phase: 'initial' })

      if (isTransientError(msg)) {
        try {
          resetBumpConnection()
          await withTimeout(ensureBumpConnected(), CONNECT_TIMEOUT_MS, 'bump_reconnect')

          const hubArgs = {}
          const scopeUrl = apiToUrl(args.api)
          if (scopeUrl) hubArgs.url = args.url || scopeUrl
          else if (args.url) hubArgs.url = args.url

          return await withTimeout(
            callBumpTool('list_pages', hubArgs),
            CALL_TIMEOUT_MS,
            'bump_list_pages_retry'
          )
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
          console.error('Bump MCP list_pages retry failed', { error: retryMsg, api: args.api, duration_ms: Date.now() - start })
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: retryMsg.includes('timeout') ? 'timeout' : 'upstream_error',
                message: 'Upstream Bump MCP request failed after retry.',
                detail: retryMsg,
                duration_ms: Date.now() - start,
              }),
            }],
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: msg.includes('timeout') ? 'timeout' : 'upstream_error',
            message: 'Upstream Bump MCP request failed.',
            detail: msg,
            duration_ms: Date.now() - start,
          }),
        }],
      }
    }
  }
)

server.registerTool(
  'search_api_reference',
  {
    title: 'Search API Reference',
    description:
      `Search Redpanda API reference documentation by keyword. Returns up to 20 matching endpoints, schemas, or topics with URL, title, and text excerpts.

SCOPING (important for accurate results):
- api="all" or omit: Search across ALL APIs at once - useful when unsure which API contains the endpoint
- api="admin": Search only cluster management (brokers, partitions, configs, users, maintenance)
- api="cloud-controlplane": Search only Cloud resource management (clusters, networks, namespaces)
- api="cloud-dataplane": Search only Cloud data operations (topics, ACLs, connectors)
- api="http-proxy": Search only HTTP Proxy (produce, consume, offsets over HTTP)
- api="schema-registry": Search only Schema Registry (register, retrieve, compatibility)

WHEN TO USE WHICH:
- User asks "broker endpoints" → api="admin" (brokers are cluster management)
- User asks "create topic API" → api="all" (topics exist in admin AND cloud-dataplane)
- User asks "Cloud cluster API" → api="cloud-controlplane"
- User asks about Redpanda APIs generally → api="all" or omit

For general Redpanda questions (not API-specific), use ask_redpanda_question instead.`,
    inputSchema: {
      api: z.string().optional().describe('Scope: "all" or omit to search all APIs, or specific API name (admin, cloud-controlplane, cloud-dataplane, http-proxy, schema-registry)'),
      query: z.string().describe('Search keywords (e.g., "broker", "create topic", "ACL")'),
      type: z.string().optional().describe('Filter by type: operation (endpoints), schema (data types), topic (guides), authentication, webhook'),
    },
  },
  async (args) => {
    const start = Date.now()

    try {
      await withTimeout(ensureBumpConnected(), CONNECT_TIMEOUT_MS, 'bump_connect')

      // Build args for hub endpoint
      const hubArgs = { query: args.query }
      const scopeUrl = apiToUrl(args.api)
      if (scopeUrl) hubArgs.url = scopeUrl
      if (args.type) hubArgs.type = args.type

      return await withTimeout(
        callBumpTool('search', hubArgs),
        CALL_TIMEOUT_MS,
        'bump_search'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Bump MCP search failed', { error: msg, api: args.api, phase: 'initial' })

      if (isTransientError(msg)) {
        try {
          resetBumpConnection()
          await withTimeout(ensureBumpConnected(), CONNECT_TIMEOUT_MS, 'bump_reconnect')

          const hubArgs = { query: args.query }
          const scopeUrl = apiToUrl(args.api)
          if (scopeUrl) hubArgs.url = scopeUrl
          if (args.type) hubArgs.type = args.type

          return await withTimeout(
            callBumpTool('search', hubArgs),
            CALL_TIMEOUT_MS,
            'bump_search_retry'
          )
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
          console.error('Bump MCP search retry failed', { error: retryMsg, api: args.api, duration_ms: Date.now() - start })
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: retryMsg.includes('timeout') ? 'timeout' : 'upstream_error',
                message: 'Upstream Bump MCP request failed after retry.',
                detail: retryMsg,
                duration_ms: Date.now() - start,
              }),
            }],
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: msg.includes('timeout') ? 'timeout' : 'upstream_error',
            message: 'Upstream Bump MCP request failed.',
            detail: msg,
            duration_ms: Date.now() - start,
          }),
        }],
      }
    }
  }
)

server.registerTool(
  'get_api_reference_content',
  {
    title: 'Get API Reference Content',
    description:
      `Retrieve full content of API reference pages by URL. Returns complete endpoint details including parameters, request/response schemas, and examples.

Use this after finding pages via list_api_reference_pages or search_api_reference. Pass the URLs from those results directly.

Returns up to 10 pages per request. URLs must be from docs.redpanda.com/api/doc/*.`,
    inputSchema: {
      urls: z.array(z.string()).max(10).describe('Page URLs to retrieve (max 10). Use URLs from list_api_reference_pages or search_api_reference results.'),
    },
  },
  async (args) => {
    const start = Date.now()

    try {
      await withTimeout(ensureBumpConnected(), CONNECT_TIMEOUT_MS, 'bump_connect')
      return await withTimeout(
        callBumpTool('get_pages', { urls: args.urls }),
        CALL_TIMEOUT_MS,
        'bump_get_pages'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Bump MCP get_pages failed', { error: msg, phase: 'initial' })

      if (isTransientError(msg)) {
        try {
          resetBumpConnection()
          await withTimeout(ensureBumpConnected(), CONNECT_TIMEOUT_MS, 'bump_reconnect')
          return await withTimeout(
            callBumpTool('get_pages', { urls: args.urls }),
            CALL_TIMEOUT_MS,
            'bump_get_pages_retry'
          )
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
          console.error('Bump MCP get_pages retry failed', { error: retryMsg, duration_ms: Date.now() - start })
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: retryMsg.includes('timeout') ? 'timeout' : 'upstream_error',
                message: 'Upstream Bump MCP request failed after retry.',
                detail: retryMsg,
                duration_ms: Date.now() - start,
              }),
            }],
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: msg.includes('timeout') ? 'timeout' : 'upstream_error',
            message: 'Upstream Bump MCP request failed.',
            detail: msg,
            duration_ms: Date.now() - start,
          }),
        }],
      }
    }
  }
)

// -------------------- Feedback tool --------------------
// Lets agents forward user feedback (bugs, doc gaps, frustrations, feature
// requests) straight to the Redpanda team — the docs/DX team's MCP feedback
// channel. Goes to the same `api-feedback` Netlify form as our docs feedback.

server.registerTool(
  'submit_documentation_feedback',
  {
    title: 'Submit Documentation Feedback',
    description:
      `Send feedback about the Redpanda documentation or products directly to the Redpanda team.

If the user hits a bug, a documentation gap, incorrect or missing information, or expresses frustration while using Redpanda, ASK whether they'd like to send feedback to the Redpanda team. Only call this tool once the user agrees — never submit feedback without their consent. Summarize their feedback clearly and include the relevant documentation page URL or context when you know it.`,
    inputSchema: {
      feedback: z
        .string()
        .min(1)
        .max(MAX_FEEDBACK_CHARS)
        .describe('The user feedback to submit, in clear prose. Summarize the bug, gap, or request.'),
      category: z
        .enum(['bug', 'documentation_gap', 'feature_request', 'other'])
        .optional()
        .describe('The type of feedback.'),
      page_url: z
        .string()
        .optional()
        .describe('The documentation page URL the feedback relates to, if known.'),
    },
  },
  async (args, extra) => {
    const start = Date.now()

    const feedback = String(args?.feedback || '').trim()
    if (!feedback) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'missing_feedback', message: 'Provide non-empty feedback text.' }),
        }],
      }
    }

    // Attach the authenticated user (set by the auth middleware) so the team can
    // follow up; anonymous when unauthenticated. Never logs the raw email.
    const user = extra?.authInfo || null
    const category = args?.category || 'other'
    const pageUrl = String(args?.page_url || '')
    const timestamp = new Date().toISOString()

    try {
      await withTimeout(
        submitFeedback({
          feedback: feedback.slice(0, MAX_FEEDBACK_CHARS),
          category,
          'page-path': pageUrl,
          'user-email': user?.email || '',
          'user-domain': user?.domain || '',
          'bot-field': '',
        }),
        CALL_TIMEOUT_MS,
        'feedback_submit'
      )

      console.log(JSON.stringify({
        event: 'mcp_feedback_submitted',
        category,
        domain: user?.domain || null,
        authed: !!user,
        ts: timestamp,
      }))

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'submitted', message: 'Thanks — your feedback has been sent to the Redpanda team.' }),
        }],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Feedback submission failed', { error: msg, duration_ms: Date.now() - start })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'submission_failed',
            message: 'Could not submit feedback right now. Please try again later.',
            detail: msg,
          }),
        }],
      }
    }
  }
)

// -------------------- Netlify handler --------------------

const baseHandler = handle({
  server,
  pre: (app) => {
    // IMPORTANT:
    // Streamable HTTP opens a long-lived SSE stream via GET requests.
    // Some rate limiter middleware can interfere with SSE and cause 500s on reconnect/idle.
    // We therefore apply rate limiting ONLY to POST/DELETE (expensive operations),
    // and allow GET (SSE stream) through un-limited.

    const limiter = makeRateLimiter({
      windowMs: 15 * 60 * 1000, // 15 minutes
      limit: 60,                // limit each key to 60 requests per windowMs (tune as needed)
      keyGenerator: computeLimiterKey, // use our custom key generator
      standardHeaders: true,    // send RateLimit-* headers if supported
      legacyHeaders: true,      // also send X-RateLimit-* headers
    })

    // OAuth resource-server middleware. Runs BEFORE the limiter so authenticated
    // requests can be keyed per-user. Never gates OPTIONS or the GET/SSE stream.
    // Grace period (REQUIRE_AUTH != 'true'): unauthenticated requests pass
    // through. Enforced: a 401 points MCP clients at our protected-resource
    // metadata so they can sign in with a Redpanda Cloud account.
    app.use('/mcp', async (c, next) => {
      const method = c.req.method
      // GET (the SSE stream) and OPTIONS are not gated, so SSE reconnection isn't
      // broken. This is safe: tool calls are POST (gated below), and a streamable-
      // HTTP session is only usable after a POST `initialize` — which is gated — so
      // an enforced deployment can't yield a usable unauthenticated channel via GET.
      if (method === 'OPTIONS' || method === 'GET') return next()

      // Validate OUR OWN access token (issued by our AS), not the upstream IdP.
      const origin = new URL(c.req.url).origin
      const token = extractBearerToken(c.req.header('authorization'))
      const verified = token
        ? await verifyAccessToken(token, { issuer: origin, audience: `${origin}/mcp` })
        : { valid: false }
      const claims = verified.valid ? verified.claims : null

      const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', c.req.url).toString()
      const { allow, userContext, response } = decideAuth({
        claims,
        enforced: isAuthEnforced(),
        workEmailRequired: isWorkEmailRequired(),
        resourceMetadataUrl,
      })

      if (userContext) {
        c.set('auth', userContext)
        recordUser(userContext).catch(() => {}) // fire-and-forget lead capture
      }

      if (!allow && response) {
        return c.json(response.body, response.status, response.headers)
      }

      if (!userContext) {
        // Grace period, unauthenticated: log for adoption tracking.
        console.log(JSON.stringify({ event: 'mcp_unauthenticated', enforced: false, ua: c.req.header('user-agent') || '' }))
      }

      return next()
    })

    app.use('/mcp', async (c, next) => {
      const method = c.req.method
      if (method === 'GET') {
        // Let SSE stream open/reconnect without limiter interference
        return next()
      }
      // Apply limiter to POST + DELETE (and anything else, if ever present)
      return limiter(c, next)
    })

    app.use('/mcp', async (c, next) => {
      await next()
      c.res.headers.set('X-MCP-Server', `Redpanda Docs MCP/${SERVER_VERSION}`)
      c.res.headers.set('Cache-Control', 'no-store')
      // CORS headers for browser MCP clients
      c.res.headers.set('Access-Control-Allow-Origin', '*')
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, x-request-id, x-client-key')
    })
  },
})

// -------------------- Request wrapper --------------------

export default async (request, context) => {
  const url = new URL(request.url)

  // Health check
  if (request.method === 'GET' && url.pathname.endsWith('/health')) {
    return new Response('ok', {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    })
  }

  // Browser redirect
  const ua = request.headers.get('user-agent') || ''
  const accept = request.headers.get('accept') || ''
  const contentType = request.headers.get('content-type') || ''

  // Markdown content negotiation
  const wantsMarkdown =
    request.method === 'GET' &&
    (accept.includes('text/markdown') || accept.includes('text/plain'))

  if (wantsMarkdown) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/data-platform/how-to-use-these-docs.md' },
    })
  }

  const isBrowserRequest =
    request.method === 'GET' &&
    accept.includes('text/html') &&
    !contentType.includes('application/json') &&
    /(Mozilla|Chrome|Safari|Edge)/.test(ua)

  if (isBrowserRequest) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/data-platform/how-to-use-these-docs' },
    })
  }

  // CORS preflight handling for browser MCP clients
  if (request.method === 'OPTIONS') {
    const requestedHeaders = request.headers.get('access-control-request-headers') || ''
    const mcpHeaders = 'Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, x-request-id, x-client-key'
    const allowedHeaders = requestedHeaders ? `${requestedHeaders}, ${mcpHeaders}` : mcpHeaders

    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': allowedHeaders,
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  // Streamable HTTP requires POST + GET (SSE) + DELETE
  if (
    request.method !== 'POST' &&
    request.method !== 'GET' &&
    request.method !== 'DELETE'
  ) {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST, GET, DELETE, OPTIONS' },
    })
  }

  const patchedHeaders = new Headers(request.headers)

  // Only set Accept if the client didn't send one.
  if (!patchedHeaders.get('accept')) {
    patchedHeaders.set('accept', 'application/json, text/event-stream')
  }

  // Only set content-type if missing on POST
  if (request.method === 'POST' && !patchedHeaders.get('content-type')) {
    patchedHeaders.set('content-type', 'application/json')
  }

  return baseHandler(
    new Request(request, { headers: patchedHeaders }),
    context
  )
}

export const config = {
  path: '/mcp',
  preferStatic: false,
}
