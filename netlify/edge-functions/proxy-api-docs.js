export default async (request, context) => {
  const url = new URL(request.url);
  // Redirects from the old API paths to the new Bump.sh ones
  const redirects = {
    "/api/admin-api/": "/api/doc/admin/",
    "/api/http-proxy-api/": "/api/doc/http-proxy/",
    "/api/schema-registry-api/": "/api/doc/schema-registry/",
    "/api/cloud-controlplane-api/": "/api/doc/cloud-controlplane/",
    "/api/cloud-dataplane-api/": "/api/doc/cloud-dataplane/",
  };

  const target = redirects[url.pathname];
  if (target) {
    return Response.redirect(`${url.origin}${target}`, 301);
  }

  const bumpUrl = `https://bump.sh/redpanda/hub/redpanda${url.pathname.replace('/api', '')}${url.search}`;
  const secret = Netlify.env.get("BUMP_PROXY_SECRET");

  const bumpRes = await fetch(bumpUrl, {
    headers: {
      "X-BUMP-SH-PROXY": secret,
      "Accept": "*/*"
    },
  });

  const contentType = bumpRes.headers.get("content-type") || "";

  if (url.searchParams.has("partial")) {
    return bumpRes;
  }

  // Only inject if it's HTML
  if (contentType.includes("text/html")) {
    const originalHtml = await bumpRes.text();

    const modifiedHtml = originalHtml
      .replace(`<meta name="custom-head" />`, `<meta name="custom-head-hello" />`)
      .replace(`<div id="embed-top-body"></div>`, `<div id="embed-top-body-hello"></div>`)
      .replace(`<div id="embed-bottom-body"></div>`, `<div id="embed-bottom-body-hello"></div>`);

    return new Response(modifiedHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  // For JS, JSON, CSS, just pass through the response
  return bumpRes;
};