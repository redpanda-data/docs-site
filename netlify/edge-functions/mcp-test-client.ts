// TEMPORARY — CIMD probe. Serves a valid OAuth client metadata document
// (RFC 7591 / SEP-991) whose client_id equals its own URL, so we can test
// whether the Cloud IdP fetches & honors Client ID Metadata Documents.
// Remove after the test.
export default async (request: Request) => {
  const url = new URL(request.url);
  const clientId = `${url.origin}/mcp-test-client.json`;
  const doc = {
    client_id: clientId,
    client_name: "Redpanda Docs MCP CIMD probe",
    redirect_uris: ["https://example.com/cb"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: "openid email profile",
  };
  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

export const config = { path: "/mcp-test-client.json" };
