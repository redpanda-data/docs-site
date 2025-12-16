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

const SERVER_VERSION = '1.1.2'

// Hardcoded upstream
const KAPA_MCP_SERVER_URL = 'https://redpanda.mcp.kapa.ai'
const KAPA_TOOL_NAME = 'search_redpanda_knowledge_sources'

// Secret
const KAPA_API_KEY = process.env.KAPA_API_KEY

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

// -------------------- MCP Server --------------------

const server = new McpServer({
  name: 'Redpanda Docs MCP',
  version: SERVER_VERSION,
})

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

  // Streamable HTTP requires POST + GET (SSE) + DELETE
  if (
    request.method !== 'POST' &&
    request.method !== 'GET' &&
    request.method !== 'DELETE'
  ) {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST, GET, DELETE' },
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
