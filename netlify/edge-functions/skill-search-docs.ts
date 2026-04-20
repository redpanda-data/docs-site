// Agent Skill: Search Redpanda Documentation
export default async () => {
  const skill = `# Search Redpanda Documentation

## Description
Search comprehensive Redpanda documentation covering Apache Kafka-compatible streaming, cluster management, data pipelines, and cloud deployment.

## Usage
Use this skill when you need to:
- Find information about Redpanda features and capabilities
- Learn about Kafka API compatibility
- Configure clusters and brokers
- Set up data streaming pipelines
- Deploy on Kubernetes, Docker, or bare metal
- Work with Redpanda Cloud
- Use Redpanda Connect for data integration

## Endpoints
- Main documentation: https://docs.redpanda.com/current/home/
- Redpanda Cloud: https://docs.redpanda.com/redpanda-cloud/
- Redpanda Connect: https://docs.redpanda.com/redpanda-connect/
- Labs & Examples: https://docs.redpanda.com/redpanda-labs/

## LLM-Friendly Format
For machine-readable documentation, use:
- https://docs.redpanda.com/llms.txt - Complete documentation index
- https://docs.redpanda.com/ROOT-full.txt - Full Redpanda text
- https://docs.redpanda.com/redpanda-cloud-full.txt - Cloud documentation
- https://docs.redpanda.com/redpanda-connect-full.txt - Connect documentation

## Example Queries
- "How do I configure cluster properties?"
- "What is the Kafka compatibility in Redpanda?"
- "How do I deploy Redpanda on Kubernetes?"
- "What connectors are available in Redpanda Connect?"
`;

  return new Response(skill, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    }
  });
};

export const config = {
  path: "/.well-known/agent-skills/search-redpanda-docs.md"
};
