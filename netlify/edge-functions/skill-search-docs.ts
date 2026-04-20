// Agent Skill: Search Redpanda Documentation
export default async () => {
  const skill = `# Search Redpanda Documentation

## Description
Search comprehensive Redpanda documentation covering Apache Kafka-compatible streaming, cluster management, data pipelines, and cloud deployment. Redpanda is a Kafka-compatible streaming data platform that's simpler to deploy, operate, and scale.

## Search API
Use the search endpoint to find specific topics:

\`\`\`
GET https://docs.redpanda.com/search?q={query}
\`\`\`

**Examples:**
- https://docs.redpanda.com/search?q=kafka%20compatibility
- https://docs.redpanda.com/search?q=kubernetes%20deployment
- https://docs.redpanda.com/search?q=schema%20registry

## Documentation Sections

### Redpanda Core (Self-Hosted)
https://docs.redpanda.com/current/home/
- Getting started guides and quickstarts
- Deployment on Kubernetes, Docker, or Linux
- Configuration and tuning
- Security and authentication
- Monitoring and troubleshooting
- Kafka API compatibility
- Admin and management operations

### Redpanda Cloud
https://docs.redpanda.com/redpanda-cloud/
- Serverless, BYOC (Bring Your Own Cloud), and Dedicated clusters
- Cloud-specific features and management
- Networking and VPC peering
- Cloud API usage and automation

### Redpanda Connect
https://docs.redpanda.com/redpanda-connect/
- Stream processing and data integration
- 200+ connectors for sources and destinations
- Bloblang transformation language
- Pipeline configuration and patterns

### Redpanda Labs
https://docs.redpanda.com/redpanda-labs/
- Example applications and tutorials
- Docker Compose templates
- Integration guides and cookbooks

## LLM-Friendly Formats
For machine-readable full-text documentation:
- https://docs.redpanda.com/llms.txt - Complete documentation index
- https://docs.redpanda.com/ROOT-full.txt - Full Redpanda core docs
- https://docs.redpanda.com/redpanda-cloud-full.txt - Full Cloud docs
- https://docs.redpanda.com/redpanda-connect-full.txt - Full Connect docs
- https://docs.redpanda.com/redpanda-labs-full.txt - Full Labs docs

## Common Topics
- **Kafka Compatibility**: Redpanda is API-compatible with Apache Kafka
- **Performance**: Sub-10ms p99 latencies, no JVM, no ZooKeeper
- **Deployment**: Kubernetes (Helm), Docker, Linux (systemd/RPM/DEB)
- **Tiered Storage**: Store data in S3/GCS/Azure for cost-effective retention
- **Security**: SASL/SCRAM, mTLS, ACLs, OIDC integration
- **Schema Registry**: Compatible with Confluent Schema Registry API
- **Connectors**: Use Redpanda Connect for data integration pipelines
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
