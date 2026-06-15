// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server.
// MCP clients (ChatGPT, Claude, Cursor, …) fetch this to discover the
// authorization server, then run the OAuth login against Redpanda Cloud.
// https://datatracker.ietf.org/doc/html/rfc9728

const AUTH_SERVER =
  Deno.env.get("REDPANDA_OAUTH_ISSUER") || "https://auth.prd.cloud.redpanda.com/";

export default async (request: Request) => {
  const origin = new URL(request.url).origin;

  const metadata = {
    resource: `${origin}/mcp`,
    authorization_servers: [AUTH_SERVER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile"],
    resource_documentation: `${origin}/data-platform/how-to-use-these-docs#authentication`,
  };

  return new Response(JSON.stringify(metadata, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
};

export const config = {
  path: "/.well-known/oauth-protected-resource",
};
