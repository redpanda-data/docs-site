// RFC 9727: API Catalog for automated API discovery
// https://www.rfc-editor.org/rfc/rfc9727
export default async (request: Request) => {
  const siteUrl = new URL(request.url).origin;

  const apiCatalog = {
    linkset: [
      {
        anchor: `${siteUrl}/api/doc/admin/`,
        "service-desc": {
          href: "https://bump.sh/redpanda/hub/redpanda/doc/admin/",
          type: "application/vnd.oai.openapi+json;version=3.1"
        },
        "service-doc": {
          href: `${siteUrl}/api/doc/admin/`,
          type: "text/html"
        },
        "service-meta": {
          href: `${siteUrl}/api/admin-api/`,
          type: "text/html"
        },
        status: {
          href: `${siteUrl}/api/doc/admin/`,
          type: "text/html"
        }
      },
      {
        anchor: `${siteUrl}/api/doc/cloud-controlplane/`,
        "service-desc": {
          href: "https://bump.sh/redpanda/hub/redpanda/doc/cloud-controlplane/",
          type: "application/vnd.oai.openapi+json;version=3.1"
        },
        "service-doc": {
          href: `${siteUrl}/api/doc/cloud-controlplane/`,
          type: "text/html"
        },
        "service-meta": {
          href: `${siteUrl}/api/cloud-controlplane-api/`,
          type: "text/html"
        },
        status: {
          href: `${siteUrl}/api/doc/cloud-controlplane/`,
          type: "text/html"
        }
      },
      {
        anchor: `${siteUrl}/api/doc/cloud-dataplane/`,
        "service-desc": {
          href: "https://bump.sh/redpanda/hub/redpanda/doc/cloud-dataplane/",
          type: "application/vnd.oai.openapi+json;version=3.1"
        },
        "service-doc": {
          href: `${siteUrl}/api/doc/cloud-dataplane/`,
          type: "text/html"
        },
        "service-meta": {
          href: `${siteUrl}/api/cloud-dataplane-api/`,
          type: "text/html"
        },
        status: {
          href: `${siteUrl}/api/doc/cloud-dataplane/`,
          type: "text/html"
        }
      },
      {
        anchor: `${siteUrl}/api/doc/http-proxy/`,
        "service-desc": {
          href: "https://bump.sh/redpanda/hub/redpanda/doc/http-proxy/",
          type: "application/vnd.oai.openapi+json;version=3.1"
        },
        "service-doc": {
          href: `${siteUrl}/api/doc/http-proxy/`,
          type: "text/html"
        },
        "service-meta": {
          href: `${siteUrl}/api/http-proxy/`,
          type: "text/html"
        },
        status: {
          href: `${siteUrl}/api/doc/http-proxy/`,
          type: "text/html"
        }
      },
      {
        anchor: `${siteUrl}/api/doc/schema-registry/`,
        "service-desc": {
          href: "https://bump.sh/redpanda/hub/redpanda/doc/schema-registry/",
          type: "application/vnd.oai.openapi+json;version=3.1"
        },
        "service-doc": {
          href: `${siteUrl}/api/doc/schema-registry/`,
          type: "text/html"
        },
        "service-meta": {
          href: `${siteUrl}/api/schema-registry/`,
          type: "text/html"
        },
        status: {
          href: `${siteUrl}/api/doc/schema-registry/`,
          type: "text/html"
        }
      }
    ]
  };

  return new Response(JSON.stringify(apiCatalog, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    }
  });
};

export const config = {
  path: "/.well-known/api-catalog"
};
