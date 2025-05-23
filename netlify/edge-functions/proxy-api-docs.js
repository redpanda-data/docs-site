export default async (request, context) => {
  const url = new URL(request.url);
  // Manual redirect from /api/admin-api to /api/doc/admin-api
  if (url.pathname === "/api/admin-api/") {
    return Response.redirect(`${url.origin}/api/doc/admin-api/`, 301);
  }

  const bumpUrl = `https://bump.sh/redpanda/hub/redpanda${new URL(request.url).pathname.replace('/api', '')}`;
  const secret = Netlify.env.get("BUMP_PROXY_SECRET");

  const bumpRes = await fetch(bumpUrl, {
    headers: {
      "X-BUMP-SH-PROXY": secret,
      "Accept": "*/*"
    },
  });

  const contentType = bumpRes.headers.get("content-type") || "";

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