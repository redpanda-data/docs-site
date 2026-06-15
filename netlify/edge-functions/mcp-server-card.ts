// MCP Server Card (SEP-1649) for agent discovery
// https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127
export default async (request: Request) => {
  const siteUrl = new URL(request.url).origin;

  const serverCard = {
    $schema: "https://modelcontextprotocol.io/schemas/server-card.json",
    serverInfo: {
      name: "redpanda-doc-tools-assistant",
      version: "1.2.0",
      description: "MCP server for searching Redpanda documentation and querying API references"
    },
    transport: {
      type: "http",
      url: "https://docs.redpanda.com/mcp"
    },
    capabilities: {
      resources: true,
      tools: true,
      prompts: false
    },
    authentication: {
      type: "oauth2",
      required: false,
      protected_resource_metadata: `${siteUrl}/.well-known/oauth-protected-resource`,
      authorization_servers: ["https://auth.prd.cloud.redpanda.com/"],
      description: "Sign in with your Redpanda Cloud account. MCP clients discover the OAuth flow via the protected-resource metadata and obtain a token automatically."
    },
    metadata: {
      homepage: `${siteUrl}`,
      documentation: `${siteUrl}/current/home/`,
      authDocumentation: `${siteUrl}/data-platform/how-to-use-these-docs#authentication`,
      repository: "https://github.com/redpanda-data/docs-site",
      support: "https://support.redpanda.com",
      tags: ["documentation", "redpanda", "kafka", "streaming", "agentic data plane"]
    }
  };

  return new Response(JSON.stringify(serverCard, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    }
  });
};

export const config = {
  path: "/.well-known/mcp/server-card.json"
};
