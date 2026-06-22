// Redpanda Docs MCP Server on Netlify Functions
// -----------------------------------------------
// This serverless function implements an authless MCP (Model Context Protocol) server
// that proxies requests to Kapa AI's chat and search APIs for Redpanda documentation.
// It uses the official MCP SDK plus the Netlify adapter (modelfetch) to support
// JSON-RPC over HTTP and SSE streaming.
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

import rateLimiterModule from 'hono-rate-limiter'
const makeRateLimiter =
  rateLimiterModule.rateLimiter ||
  rateLimiterModule.default ||
  rateLimiterModule

// -------------------- Config --------------------

const SERVER_VERSION = '1.1.3'

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

// -------------------- Rate limiting --------------------

const computeLimiterKey = (c) => {
  const h = (name) => c.req.header(name) || ''

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

  // The transport keeps a persistent connection that's reused across warm
  // invocations. When the container freezes/thaws, the idle socket is dropped
  // and the error surfaces in the transport's background read loop. Handle it
  // here (at the source) so it resets the cache rather than bubbling up as an
  // unhandled rejection that crashes the invocation.
  kapaTransport.onerror = (err) => {
    console.warn('[mcp] kapa transport error; resetting connection', { error: err?.message || String(err) })
    resetKapaConnection()
  }
  kapaTransport.onclose = () => resetKapaConnection()

  kapaConnectPromise = kapaClient.connect(kapaTransport)
  return kapaConnectPromise
}

// Kapa Hosted MCP search tool only accepts `query`
function callKapaSearch(query) {
  return kapaClient.callTool({
    name: KAPA_TOOL_NAME,
    arguments: { query },
  })
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

  // Reset the cached connection if the persistent socket errors/closes in the
  // background (e.g. dropped on container freeze/thaw) so the next request
  // reconnects instead of the error crashing the invocation. See Kapa above.
  transport.onerror = (err) => {
    console.warn('[mcp] bump transport error; resetting connection', { error: err?.message || String(err) })
    resetBumpConnection()
  }
  transport.onclose = () => resetBumpConnection()

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
  async (args) => {
    const start = Date.now()

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
        callKapaSearch(q),
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
            callKapaSearch(q),
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

// -------------------- Netlify handler --------------------

// Safety net: even with transport onerror/onclose handlers, a stray background
// socket error from a cached upstream connection can surface as an unhandled
// rejection — which the Lambda runtime treats as fatal ("Invalid request ID").
// Recover by logging and resetting the cached connections so the next request
// reconnects, instead of crashing the invocation. Registered once per cold start.
const isUpstreamSocketError = (err) =>
  /ECONNRESET|socket hang up|EPIPE|ECONNREFUSED|\bsocket\b/i.test(
    err instanceof Error ? err.message : String(err)
  )

let processGuardsInstalled = false
function installProcessGuards() {
  if (processGuardsInstalled) return
  processGuardsInstalled = true
  const reset = (label, err) => {
    console.warn(`[mcp] ${label} (recovered, resetting upstream connections)`, {
      error: err instanceof Error ? err.message : String(err),
    })
    resetKapaConnection()
    resetBumpConnection()
  }
  // The original incident: a background-read-loop rejection with no awaiter that
  // the runtime treats as fatal. Recovering here (reset cached connections) is
  // cheap and safe, and the error is logged either way.
  process.on('unhandledRejection', (reason) => reset('unhandledRejection', reason))
  // uncaughtException is broader and can leave the process in a state Node's
  // docs flag as unsafe, so only recover from known upstream socket drops;
  // re-throw anything else so genuine bugs surface instead of being masked
  // (re-throwing inside this handler terminates the process, as intended).
  process.on('uncaughtException', (err) => {
    if (isUpstreamSocketError(err)) {
      reset('uncaughtException', err)
      return
    }
    console.error('[mcp] fatal uncaughtException (not recovering)', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    throw err
  })
}
installProcessGuards()

const baseHandler = handle({
  server,
  pre: (app) => {
    const limiter = makeRateLimiter({
      windowMs: 15 * 60 * 1000, // 15 minutes
      limit: 60,                // limit each key to 60 requests per windowMs (tune as needed)
      keyGenerator: computeLimiterKey, // use our custom key generator
      standardHeaders: true,    // send RateLimit-* headers if supported
      legacyHeaders: true,      // also send X-RateLimit-* headers
    })

    app.use('/mcp', async (c, next) => {
      const method = c.req.method
      if (method === 'GET') {
        // GET opens Streamable HTTP's optional server->client SSE stream. This
        // server is request/response only (it never pushes server-initiated
        // messages), so on serverless that stream just idles open until the
        // function hits its max duration — a wasted full-length invocation per
        // connected client. Decline it: the MCP spec allows 405 when the server
        // doesn't offer an SSE stream on GET, and clients fall back to POST.
        return c.text('Method Not Allowed', 405, {
          Allow: 'POST, DELETE, OPTIONS',
          'Access-Control-Allow-Origin': '*',
        })
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
