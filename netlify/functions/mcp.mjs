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
import { z } from 'zod'
import handle from '@modelfetch/netlify'
// NOTE: some npm builds of hono-rate-limiter export differently; this shim ensures compatibility.
import rateLimiterModule from 'hono-rate-limiter'
const makeRateLimiter = rateLimiterModule.rateLimiter || rateLimiterModule.default || rateLimiterModule

const API_BASE = 'https://api.kapa.ai'
// Fetch Netlify env vars
const KAPA_API_KEY = process.env.KAPA_API_KEY
const KAPA_PROJECT_ID = process.env.KAPA_PROJECT_ID
const KAPA_INTEGRATION_ID = process.env.KAPA_INTEGRATION_ID

// Helper to compute a stable limiter key (shared IPs, proxy headers, or fallback)
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

  // Fallback: use user-agent + accept header
  const ua = h('user-agent')
  const accept = h('accept')
  return `ua:${ua}|${accept}`
}

const SERVER_VERSION = '1.0.0';

// Initialize MCP Server and register tools
const server = new McpServer({
  name: 'Redpanda Docs MCP', // Display name visible for inspectors
  version: SERVER_VERSION,
})


server.registerTool(
  'ask_redpanda_question',
  {
    title: 'Search Redpanda Sources',
    description: 'Search the official Redpanda documentation and return the most relevant sections from it for a user query. Each returned section includes the url and its actual content in markdown. Use this tool for all queries that require Redpanda knowledge. Results are ordered by relevance, with the most relevant result returned first. Returns up to 5 results by default to manage token usage. Use top_k parameter (1-15) to request more or fewer results.',
    inputSchema: {
      question: z.string(),
      top_k: z.number().int().min(1).max(15).optional().describe('Number of results to return (1-15). Defaults to 5 for optimal token usage.')
    },
  },
  async (args) => {
    const q = (args?.question ?? '').trim();
    if (!q) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'missing_query', message: 'Provide a non-empty "question".' }) }]
      };
    }
    // Extract top_k parameter with default of 5, clamped to valid range
    const topK = Math.max(1, Math.min(15, args?.top_k ?? 5));

    const startTime = Date.now();
    try {
      // Add timeout to prevent function from hanging indefinitely
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout

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
            top_k: topK,
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);
      const fetchDuration = Date.now() - startTime;

      // Log slow requests to help diagnose issues
      if (fetchDuration > 1000) {
        console.warn(`Slow Kapa AI API request: ${fetchDuration}ms for query: "${q.substring(0, 50)}..."`);
      }

      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : [];
      } catch (error) {
        console.error('JSON parse error from upstream response:', error.message, 'Raw response:', raw);
        data = [];
      }

      if (!response.ok) {
        console.error(`Kapa AI API error: ${response.status} ${response.statusText} (${fetchDuration}ms)`);
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
      console.log(`Kapa AI request successful: ${fetchDuration}ms, returned ${arr.length} results`);
      return { content: [{ type: 'text', text: JSON.stringify(arr) }] };

    } catch (error) {
      const duration = Date.now() - startTime;
      const msg = error instanceof Error ? error.message : String(error);

      // Distinguish between timeout and other errors
      if (error.name === 'AbortError') {
        console.error(`Kapa AI API timeout after ${duration}ms for query: "${q.substring(0, 50)}..."`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'timeout',
              message: 'Request to Kapa AI API timed out after 25 seconds. Please try again or simplify your query.',
              duration_ms: duration
            })
          }]
        };
      }

      console.error(`Kapa AI API exception after ${duration}ms:`, msg);
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'exception', message: msg, duration_ms: duration }) }] };
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
  if (request.method === 'GET' && url.pathname.endsWith('/health')) {
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
  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: { 'Allow': 'POST, GET' } })
  }

  // Otherwise, handle as MCP client request
  const patchedHeaders = new Headers(request.headers)
  patchedHeaders.set('accept', 'application/json, text/event-stream')
  if (request.method === 'POST') {
    patchedHeaders.set('content-type', 'application/json')
  }

  const patchedRequest = new Request(request, { headers: patchedHeaders })
  return baseHandler(patchedRequest, context)
}

export const config = {
  path: '/mcp',
  preferStatic: false
}
