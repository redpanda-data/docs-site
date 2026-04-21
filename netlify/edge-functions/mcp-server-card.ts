// MCP Server Card (SEP-1649) for agent discovery
// https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127
export default async (request: Request) => {
  const siteUrl = new URL(request.url).origin;

  const serverCard = {
    $schema: "https://modelcontextprotocol.io/schemas/server-card.json",
    serverInfo: {
      name: "redpanda-doc-tools-assistant",
      version: "1.0.0",
      description: "MCP server for generating and managing Redpanda documentation including properties, metrics, RPK commands, connectors, Helm charts, CRDs, and OpenAPI specs"
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
    metadata: {
      homepage: `${siteUrl}`,
      documentation: `${siteUrl}/current/home/`,
      repository: "https://github.com/redpanda-data/docs-extensions-and-macros",
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
