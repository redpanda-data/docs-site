// netlify/edge-functions/mcp.js

// Redpanda Docs MCP Server on Netlify Edge Functions
// ---------------------------------------------------
// This Edge Function implements an authless MCP (Model Context Protocol) server
// that proxies requests to Kapa AI’s chat and search APIs for Redpanda documentation.
// It uses the official MCP SDK plus the Netlify adapter (modelfetch) to support
// JSON-RPC over HTTP and SSE streaming.
//
// For background and reference implementations, see:
// • Kapa AI blog: Build an MCP Server with Kapa AI
//   https://www.kapa.ai/blog/build-an-mcp-server-with-kapa-ai
// • Netlify guide: Writing MCPs on Netlify
//   https://developers.netlify.com/guides/write-mcps-on-netlify/
//
// Key challenges on Netlify Edge:
// 1. ESM-only runtime: import via https://esm.sh for all modules (no local npm installs).
// 2. Edge transport: leverage the `streamingHttp` protocol via the `@modelfetch/netlify` adapter, which under the hood uses `StreamableHTTPServerTransport` to handle SSE streams in Edge environments. Adapter docs:
//    - Modelfetch npm: https://www.npmjs.com/package/@modelfetch/netlify
//    - Modelfetch GitHub: https://github.com/modelcontextprotocol/modelfetch
// 3. Header requirements: MCP expects both application/json and text/event-stream in Accept,
//    and requires Content-Type: application/json on incoming JSON-RPC messages.
// 4. Unbuffered streaming: ensure the ReadableStream from Kapa’s SSE chat API is proxied directly through the Edge function without interim buffering.

import { McpServer } from 'https://esm.sh/@modelcontextprotocol/sdk@1.17.0/server/mcp.js'
import { z } from 'https://esm.sh/zod@3.22.4'
import handle from "https://esm.sh/@modelfetch/netlify@0.15.2";

const API_BASE = "https://api.kapa.ai";
// Fetch Netlify env vars
const KAPA_API_KEY = Netlify.env.get('KAPA_API_KEY');
const KAPA_PROJECT_ID = Netlify.env.get('KAPA_PROJECT_ID');
const KAPA_INTEGRATION_ID = Netlify.env.get('KAPA_INTEGRATION_ID');

// Initialize MCP Server and register tools
const server = new McpServer({
  name: "Redpanda Docs MCP", // Display name visible for inspectors
  version: "0.1.0",
});

server.registerTool(
  "ask_redpanda_question",
  {
    title: "Ask Redpanda Question",
    description: "Ask a question about Redpanda documentation",
    inputSchema: { question: z.string() },
  },
  async ({ question }) => {
    try {
      const response = await fetch(
        `${API_BASE}/query/v1/projects/${KAPA_PROJECT_ID}/chat/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": KAPA_API_KEY,
          },
          body: JSON.stringify({
            integration_id: KAPA_INTEGRATION_ID,
            query: question,
          }),
        }
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Error: kapa.ai API returned ${response.status} - ${response.statusText}`,
            },
          ],
        };
      }
      const data = await response.json();
      return {
        content: [
          {
            type: "text",
            text: data.answer || "No answer received",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Failed to call kapa.ai API - ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.registerTool(
  "search_redpanda_sources",
  {
    title: "Search Redpanda Sources",
    description: "Search across Redpanda documentation sources",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    try {
      const response = await fetch(
        `${API_BASE}/query/v1/projects/${KAPA_PROJECT_ID}/search/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": KAPA_API_KEY,
          },
          body: JSON.stringify({
            integration_id: KAPA_INTEGRATION_ID,
            query: query,
          }),
        }
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Error: kapa.ai API returned ${response.status} - ${response.statusText}`,
            },
          ],
        };
      }
      const data = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Failed to call kapa.ai API - ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
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
//    returned by streaming tools (e.g., chat API SSE) and writes them as
//    text/event-stream chunks back through the Edge Function response.
// 5. Handles error formatting according to JSON-RPC (wrapping exceptions in
//    appropriate error objects).
const baseHandler = handle(server);

// Wrapper to ensure the Accept header includes both JSON and SSE
export default async (request, context) => {
  // Clone and patch headers
  const origAccept = request.headers.get('accept') || '';
  let accept = origAccept;
  if (!origAccept.includes('application/json')) {
    accept = origAccept
      ? `${origAccept}, application/json`
      : 'application/json, text/event-stream';
  }
  const patchedHeaders = new Headers(request.headers);
  patchedHeaders.set('accept', accept);
  // Ensure the request Content-Type is JSON for initialization and calls
  patchedHeaders.set('content-type', 'application/json');

  const patchedRequest = new Request(request, { headers: patchedHeaders });
  return baseHandler(patchedRequest, context);
};

export const config = { path: "/mcp" };

