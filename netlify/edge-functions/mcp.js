// Redpanda Docs MCP Server on Netlify Edge Functions
// ---------------------------------------------------
// This Edge Function implements an authless MCP (Model Context Protocol) server
// that proxies requests to Kapa AI’s chat and search APIs for Redpanda documentation.
// It uses the official MCP SDK plus the Netlify adapter (modelfetch) to support
// JSON-RPC over HTTP and SSE streaming.
//
// For background and reference implementations, see:
// - Kapa AI blog: Build an MCP Server with Kapa AI
//   https://www.kapa.ai/blog/build-an-mcp-server-with-kapa-ai
// - Netlify guide: Writing MCPs on Netlify
//   https://developers.netlify.com/guides/write-mcps-on-netlify/
//
// Key challenges on Netlify Edge:
// 1. ESM-only runtime: import via https://esm.sh for all modules (no local npm installs).
// 2. Edge transport: leverage the `streamingHttp` protocol via the `@modelfetch/netlify` adapter, which under the hood uses `StreamableHTTPServerTransport` to handle SSE streams in Edge environments. Adapter docs:
//    - Modelfetch npm: https://www.npmjs.com/package/@modelfetch/netlify
//    - Modelfetch GitHub: https://github.com/modelcontextprotocol/modelfetch
// 3. Header requirements: MCP expects both application/json and text/event-stream in Accept,
//    and requires Content-Type: application/json on incoming JSON-RPC messages.

import { McpServer } from 'https://esm.sh/@modelcontextprotocol/sdk@1.17.0/server/mcp.js'
import { z } from 'https://esm.sh/zod@3.22.4'
import handle from 'https://esm.sh/@modelfetch/netlify@0.15.2'
// NOTE: some esm.sh builds of hono-rate-limiter export differently; this shim ensures compatibility.
import rateLimiterModule from 'https://esm.sh/hono-rate-limiter@0.1.0'
const makeRateLimiter = rateLimiterModule.rateLimiter || rateLimiterModule

const API_BASE = 'https://api.kapa.ai'
// Fetch Netlify env vars
const KAPA_API_KEY = Netlify.env.get('KAPA_API_KEY')
const KAPA_PROJECT_ID = Netlify.env.get('KAPA_PROJECT_ID')
const KAPA_INTEGRATION_ID = Netlify.env.get('KAPA_INTEGRATION_ID')

// Helper to compute a stable limiter key (shared IPs, proxy headers, or fallback)
const computeLimiterKey = (c) => {
  const h = (name) => c.req.header(name) || ''

  // Allow clients to provide their own stable identifier
  const clientKey = h('x-client-key')
  if (clientKey) return `ck:${clientKey}`

  // Try Netlify’s client IP first
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

  // Fallback: use user-agent + accept header
  const ua = h('user-agent')
  const accept = h('accept')
  return `ua:${ua}|${accept}`
}

const SERVER_VERSION = '0.2.0';

// Initialize MCP Server and register tools
const server = new McpServer({
  name: 'Redpanda Docs MCP', // Display name visible for inspectors
  version: SERVER_VERSION,
})


server.registerTool(
  'ask_redpanda_question',
  {
    title: 'Search Redpanda Sources',
    description: 'Search the official Redpanda documentation and return the most relevant sections from it for a user query. Each returned section includes the url and its actual content in markdown. Use this tool to for all queries that require Redpanda knowledge.',
    inputSchema: { question: z.string() },
  },
  async (args) => {
    const q = (args?.question ?? '').trim();
    if (!q) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'missing_query', message: 'Provide a non-empty "question".' }) }]
      };
    }
    try {
      const response = await fetch(
        `${API_BASE}/query/v1/projects/${KAPA_PROJECT_ID}/retrieval/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': KAPA_API_KEY,
          },
          body: JSON.stringify({
            integration_id: KAPA_INTEGRATION_ID,
            query: q,
          }),
        }
      );

      const raw = await response.text();
      let data; try { data = raw ? JSON.parse(raw) : []; } catch { data = []; }

      if (!response.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'upstream_error',
              status: response.status,
              statusText: response.statusText,
              body: raw || null,
            })
          }]
        };
      }

      const arr = Array.isArray(data) ? data : [];
      return { content: [{ type: 'text', text: JSON.stringify(arr) }] };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'exception', message: msg }) }] };
    }
  }
);

// Wrap the server with the Netlify Edge handler
// ---------------------------------------------
// The `handle` function from `@modelfetch/netlify` does several things:
// 1. Adapts the Edge `fetch` Request/Response to the Node-style HTTP transport
//    that the MCP SDK expects (using streamingHttp under the hood).
// 2. Parses incoming JSON-RPC payloads from the request body.
// 3. Routes `initialize`, `tool:discover`, and `tool:invoke` JSON-RPC methods
//    to the registered tools on our `server` instance.
// 4. Manages Server-Sent Events (SSE) streaming: it takes ReadableStreams
//    returned by streaming tools and writes them as
//    text/event-stream chunks back through the Edge Function response.
// 5. Handles error formatting according to JSON-RPC (wrapping exceptions in
//    appropriate error objects).
const baseHandler = handle({
  server: server,
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
      await next();
      c.res.headers.set('X-MCP-Server', `Redpanda Docs MCP/${SERVER_VERSION}`);
    });
  },
})

// Wrapper to handle both browser requests (show docs) and MCP client requests
export default async (request, context) => {
  const url = new URL(request.url)

  // Simple health check for POP/routing tests (no SSE)
  if (request.method === 'GET' && url.pathname === '/mcp/health') {
    return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
  }

  // Check if this is a browser request (not an MCP client)
  const userAgent = request.headers.get('user-agent') || ''
  const accept = request.headers.get('accept') || ''
  const contentType = request.headers.get('content-type') || ''

  // Detect browser requests:
  // - User-Agent contains browser identifiers
  // - Accept header includes text/html
  // - NOT a JSON-RPC POST request
  const isBrowserRequest = (
    request.method === 'GET' &&
    (userAgent.includes('Mozilla') || userAgent.includes('Chrome') || userAgent.includes('Safari') || userAgent.includes('Edge')) &&
    accept.includes('text/html') &&
    !contentType.includes('application/json')
  )

  // If it's a browser request, redirect to the documentation page
  if (isBrowserRequest) {
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/home/mcp-setup', // Redirect to the built docs page
      },
    })
  }

  // Enforce POST for /mcp (some tools accidentally send GET)
  if (url.pathname === '/mcp' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { 'Allow': 'POST' } })
  }

  // Otherwise, handle as MCP client request
  const patchedHeaders = new Headers(request.headers)
  patchedHeaders.set('accept', 'application/json, text/event-stream')
  patchedHeaders.set('content-type', 'application/json')

  const patchedRequest = new Request(request, { headers: patchedHeaders })
  return baseHandler(patchedRequest, context)
}

export const config = { path: '/mcp' }
