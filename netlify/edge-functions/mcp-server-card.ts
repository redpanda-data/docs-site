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
      type: "bearer",
      required: false,
      registration_url: "https://docs.redpanda.com/mcp/register",
      description: "Register a free token with your work email, then send Authorization: Bearer <token> (or ?token=<token> for clients that can't set headers)."
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
