// Agent Skill: Get Redpanda API Documentation
export default async () => {
  const skill = `# Get Redpanda API Documentation

## Description
Access comprehensive API documentation for Redpanda's REST APIs including Admin, Cloud Control Plane, HTTP Proxy, and Schema Registry.

## Available APIs

### Admin API
Management and monitoring of Redpanda clusters
- URL: https://docs.redpanda.com/api/doc/admin/
- Purpose: Cluster administration, broker management, partition operations

### Cloud Control Plane API
Manage Redpanda Cloud resources
- URL: https://docs.redpanda.com/api/doc/cloud-controlplane/
- Purpose: Cloud cluster management, user management, resource provisioning

### Cloud Data Plane API
Direct access to Redpanda Cloud clusters
- URL: https://docs.redpanda.com/api/doc/cloud-dataplane/
- Purpose: Topic management, consumer groups, data operations

### HTTP Proxy API
Kafka protocol over HTTP
- URL: https://docs.redpanda.com/api/doc/http-proxy/
- Purpose: Produce and consume messages via HTTP, topic metadata

### Schema Registry API
Schema management for data validation
- URL: https://docs.redpanda.com/api/doc/schema-registry/
- Purpose: Register schemas, compatibility checking, schema versions

## API Catalog
For automated discovery, see: https://docs.redpanda.com/.well-known/api-catalog

## Authentication
Most APIs require authentication via:
- API tokens (Cloud APIs)
- HTTP Basic Auth (Admin API)
- SASL/SCRAM or mTLS (Data Plane)

See individual API documentation for specific authentication requirements.
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
  path: "/.well-known/agent-skills/get-redpanda-api-docs.md"
};
