// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server.
// MCP clients (ChatGPT, Claude, Cursor, …) fetch this to discover the
// authorization server. That AS is OUR OWN service (which federates the human
// login to the Redpanda Cloud IdP), so authorization_servers points back at
// this origin, where /.well-known/oauth-authorization-server lives.
// https://datatracker.ietf.org/doc/html/rfc9728

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default async (request: Request) => {
  // CORS preflight for browser-based MCP clients fetching the metadata.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  }

  const origin = new URL(request.url).origin;

  const metadata = {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile"],
    resource_documentation: `${origin}/data-platform/how-to-use-these-docs#authentication`,
  };

  return new Response(JSON.stringify(metadata, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      ...CORS,
    },
  });
};

export const config = {
  path: "/.well-known/oauth-protected-resource",
};
