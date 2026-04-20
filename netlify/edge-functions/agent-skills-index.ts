// Agent Skills Discovery Index (RFC v0.2.0)
// https://github.com/cloudflare/agent-skills-discovery-rfc

export default async (request: Request) => {
  const siteUrl = new URL(request.url).origin;

  // Define skills
  const skills = [
    {
      name: "search-redpanda-docs",
      type: "web",
      description: "Search Redpanda documentation for topics including Kafka compatibility, streaming data, cluster configuration, and more",
      url: `${siteUrl}/.well-known/agent-skills/search-redpanda-docs.md`
    },
    {
      name: "get-redpanda-api-docs",
      type: "web",
      description: "Access Redpanda API documentation including Admin API, Cloud Control Plane, HTTP Proxy, and Schema Registry",
      url: `${siteUrl}/.well-known/agent-skills/get-redpanda-api-docs.md`
    },
    {
      name: "llms-txt",
      type: "web",
      description: "Access LLM-friendly documentation index in plain text format",
      url: `${siteUrl}/llms.txt`
    }
  ];

  // Calculate SHA256 digests for each skill
  // Note: In production, these would be calculated from actual skill file contents
  const skillsWithDigests = await Promise.all(
    skills.map(async (skill) => {
      try {
        // Fetch the skill content to calculate digest
        const response = await fetch(skill.url);
        if (response.ok) {
          const content = await response.text();
          const encoder = new TextEncoder();
          const data = encoder.encode(content);
          const hashBuffer = await crypto.subtle.digest("SHA-256", data);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const digest = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

          return {
            ...skill,
            sha256: digest
          };
        }
      } catch (e) {
        // If skill file doesn't exist yet, use placeholder
        console.warn(`Could not fetch skill ${skill.name}:`, e);
      }

      // Placeholder digest if file doesn't exist
      return {
        ...skill,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000"
      };
    })
  );

  const index = {
    $schema: "https://agentskills.io/schemas/v0.2.0/index.json",
    skills: skillsWithDigests
  };

  return new Response(JSON.stringify(index, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    }
  });
};

export const config = {
  path: "/.well-known/agent-skills/index.json"
};
