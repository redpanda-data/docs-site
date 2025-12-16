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

const SERVER_VERSION = '1.1.0'

// Hardcoded upstream
const KAPA_MCP_SERVER_URL = 'https://redpanda.mcp.kapa.ai'
const KAPA_TOOL_NAME = 'search_redpanda_knowledge_sources'

// Secret
const KAPA_API_KEY = process.env.KAPA_API_KEY

// Limits and timeouts
const CONNECT_TIMEOUT_MS = 8_000
const CALL_TIMEOUT_MS = 22_000
const MAX_QUERY_CHARS = 2_000
const DEFAULT_TOP_K = 5
const MIN_TOP_K = 1
const MAX_TOP_K = 15

// -------------------- Helpers --------------------

function requireEnv() {
  if (!KAPA_API_KEY) {
    throw new Error('Missing env var: KAPA_API_KEY')
  }
}

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

  // Allow clients to provide their own stable identifier
  const clientKey = h('x-client-key')
  if (clientKey) return `ck:${clientKey}`

  // Try Netlify's client IP first
  // Prefer context.ip / c.ip if present
  if (c.ip) return `ip:${c.ip}`

  // Fall back to headers (for older runtimes)
  const nfIp = h('x-nf-client-connection-ip')
  if (nfIp) return `ip:${nfIp}`

  // Then Cloudflare
  const cfIp = h('cf-connecting-ip')
  if (cfIp) return `ip:${cfIp}`

  // Then generic proxy chain
  const xff = h('x-forwarded-for').split(',')[0]?.trim()
  if (xff) return `ip:${xff}`

  // Then Real-IP
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

  requireEnv()

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

function callKapaSearch(query, top_k) {
  return kapaClient.callTool({
    name: KAPA_TOOL_NAME,
    arguments: { query, top_k },
  })
}

// -------------------- MCP Server --------------------

const server = new McpServer({
  name: 'Redpanda Docs MCP',
  version: SERVER_VERSION,
})

server.registerTool(
  'ask_redpanda_question',
  {
    title: 'Search Redpanda Sources',
    description: 'Search the official Redpanda documentation and return the most relevant sections from it for a user query. Each returned section includes the url and its actual content in markdown. Use this tool for all queries that require Redpanda knowledge. Results are ordered by relevance, with the most relevant result returned first.',
    inputSchema: {
      question: z.string(),
      top_k: z.number().int().min(MIN_TOP_K).max(MAX_TOP_K).optional().describe('Number of results to return (1-15). Defaults to 5 for optimal token usage.'),
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

    const topK = Math.max(
      MIN_TOP_K,
      Math.min(MAX_TOP_K, args?.top_k ?? DEFAULT_TOP_K)
    )

    try {
      await withTimeout(
        ensureKapaConnected(),
        CONNECT_TIMEOUT_MS,
        'kapa_connect'
      )

      return await withTimeout(
        callKapaSearch(q, topK),
        CALL_TIMEOUT_MS,
        'kapa_callTool'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

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
            callKapaSearch(q, topK),
            CALL_TIMEOUT_MS,
            'kapa_callTool_retry'
          )
        } catch (retryErr) {
          const retryMsg =
            retryErr instanceof Error ? retryErr.message : String(retryErr)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: retryMsg.includes('timeout')
                    ? 'timeout'
                    : 'upstream_error',
                  message:
                    'Upstream Kapa MCP request failed after retry.',
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
              error: msg.includes('timeout')
                ? 'timeout'
                : 'upstream_error',
              message: 'Upstream Kapa MCP request failed.',
              duration_ms: Date.now() - start,
            }),
          },
        ],
      }
    }
  }
);

// Wrap the server with the Netlify handler
// -----------------------------------------
// The `handle` function from `@modelfetch/netlify` does several things:
// 1. Adapts the serverless function Request/Response to the Node-style HTTP transport
//    that the MCP SDK expects (using streamingHttp under the hood).
// 2. Parses incoming JSON-RPC payloads from the request body.
// 3. Routes `initialize`, `tool:discover`, and `tool:invoke` JSON-RPC methods
//    to the registered tools on our `server` instance.
// 4. Manages Server-Sent Events (SSE) streaming: it takes ReadableStreams
//    returned by streaming tools and writes them as
//    text/event-stream chunks back through the serverless function response.
// 5. Handles error formatting according to JSON-RPC (wrapping exceptions in
//    appropriate error objects).
const baseHandler = handle({
  server,
  pre: (app) => {
    app.use(
      '/mcp',
      makeRateLimiter({
        windowMs: 15 * 60 * 1000, // 15 minutes
        limit: 60,                // limit each key to 60 requests per windowMs (tune as needed)
        keyGenerator: computeLimiterKey, // use our custom key generator
        standardHeaders: true,    // send RateLimit-* headers if supported
        legacyHeaders: true,      // also send X-RateLimit-* headers
      }),
    )

    app.use('/mcp', async (c, next) => {
      await next()
      c.res.headers.set(
        'X-MCP-Server',
        `Redpanda Docs MCP/${SERVER_VERSION}`
      )
      c.res.headers.set('Cache-Control', 'no-store')
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

  // Check if this is a browser request (not an MCP client)
  const ua = request.headers.get('user-agent') || ''
  const accept = request.headers.get('accept') || ''
  const contentType = request.headers.get('content-type') || ''

  const isBrowserRequest =
    request.method === 'GET' &&
    accept.includes('text/html') &&
    !contentType.includes('application/json') &&
    /(Mozilla|Chrome|Safari|Edge)/.test(ua)

  if (isBrowserRequest) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/home/mcp-setup' },
    })
  }

  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST, GET' },
    })
  }

  const patchedHeaders = new Headers(request.headers)
  patchedHeaders.set('accept', 'application/json, text/event-stream')
  if (request.method === 'POST') {
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