export default async (request, context) => {
  const url = new URL(request.url);
  const originalOrigin = url.origin;  // Redirects from the old API paths to the new Bump.sh ones
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
  const bumpUrl = new URL(request.url);
  bumpUrl.host = "bump.sh";
  // Change target path to Bump.sh' Redpanda Hub
  bumpUrl.pathname = `/redpanda/hub/redpanda${bumpUrl.pathname.replace('/api', '')}`;
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
    // Fetch original HTML and all widget fragments
    const [
      originalHtml,
      headStyles,
      headScript,
      headerWidget,
      footerWidget,
    ] = await Promise.all([
      bumpRes.text(),
      fetch(`${originalOrigin}/_/assets/widgets/head-styles.html`).then((res) =>
        res.ok ? res.text() : ""
      ),
      fetch(`${originalOrigin}/_/assets/widgets/head-script.html`).then((res) =>
        res.ok ? res.text() : ""
      ),
      fetch(`${originalOrigin}/_/assets/widgets/header-content.html`).then((res) =>
        res.ok ? res.text() : ""
      ),
      fetch(`${originalOrigin}/_/assets/widgets/footer.html`).then((res) =>
        res.ok ? res.text() : ""
      ),
    ]);

    const combinedHead = `${headStyles}\n${headScript}`;

    const modifiedHtml = originalHtml
      .replace(`<meta name="custom-head" />`, combinedHead)
      .replace(`<div id="embed-top-body" data-embed-target="top"></div>`, headerWidget)
      .replace(`<div id="embed-bottom-body"></div>`, footerWidget);

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