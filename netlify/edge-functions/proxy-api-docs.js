export default async (request, context) => {
  const url = new URL(request.url);
  // Redirects from the old API paths to the new Bump.sh ones
  const redirects = {
    "/api/admin-api": "/api/doc/admin/",
    "/api/http-proxy-api": "/api/doc/http-proxy/",
    "/api/schema-registry-api": "/api/doc/schema-registry/",
    "/api/cloud-controlplane-api": "/api/doc/cloud-controlplane/",
    "/api/cloud-dataplane-api": "/api/doc/cloud-dataplane/",
  };

  const normalizedPath = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;

  const target = redirects[normalizedPath];
  if (target) {
    return Response.redirect(`${url.origin}${target}`, 301);
  }

  // Change target host to Bump.sh
  url.host = "bump.sh";
  // Change target path to Bump.sh' Redpanda Hub
  url.pathname = `/redpanda/hub/redpanda${url.pathname.replace('/api', '')}`;
  const bumpUrl = url;
  const secret = Netlify.env.get("BUMP_PROXY_SECRET");

  const bumpRes = await fetch(bumpUrl, {
    headers: {
      "X-BUMP-SH-PROXY": secret,
      "X-BUMP-SH-EMBED": "true",
    },
  });

  const contentType = bumpRes.headers.get("content-type") || "";


  // Only inject if it's HTML
  if (contentType.includes("text/html")) {
    const [originalHtml, headerWidget, footerWidget] = await Promise.all([
      bumpRes.text(),
      fetch(`${url.origin}/_/assets/widgets/header-content.html`).then((res) =>
        res.ok ? res.text() : ""
      ),
      fetch(`${url.origin}/_/assets/widgets/footer.html`).then((res) =>
        res.ok ? res.text() : ""
      ),
    ]);

    const modifiedHtml = originalHtml
      .replace(`<meta name="custom-head" />`, `<meta name="custom-head-hello" />`)
      .replace(`<div id="embed-top-body" data-embed-target="top"></div>`, headerWidget)
      .replace(`<div id="embed-bottom-body-hello"></div>`, footerWidget);

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