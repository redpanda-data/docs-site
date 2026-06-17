// HTML for the login interstitial shown at /authorize before redirecting to the
// upstream IdP. Pure (returns a string) so it's unit-testable.

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// `continueUrl` is the upstream (Auth0) authorize URL; `signupUrl` points users
// without a Redpanda Cloud account at the Cloud signup page.
export function loginInterstitialHtml({ continueUrl, signupUrl }) {
  const c = escapeAttr(continueUrl)
  const s = escapeAttr(signupUrl)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Redpanda Docs MCP</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f7f7f8; color: #1a1a1a; margin: 0;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #fff; max-width: 420px; width: 90%; padding: 32px; border-radius: 12px;
          box-shadow: 0 1px 4px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #555; font-size: 15px; line-height: 1.5; margin: 0 0 24px; }
  .btn { display: block; background: #e2401c; color: #fff; text-decoration: none; font-size: 16px;
         font-weight: 600; padding: 12px 18px; border-radius: 8px; }
  .btn:hover { background: #c8381a; }
  .signup { margin-top: 20px; font-size: 14px; color: #555; }
  .signup a { color: #e2401c; }
  .note { margin-top: 24px; font-size: 12px; color: #888; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect to Redpanda Docs</h1>
    <p>Sign in with your Redpanda Cloud account to use the documentation tools in your AI client.</p>
    <a class="btn" href="${c}">Continue with Redpanda Cloud</a>
    <div class="signup">
      Don't have an account? <a href="${s}" target="_blank" rel="noopener">Sign up at cloud.redpanda.com</a>
    </div>
    <p class="note">We use your verified work email to track documentation usage and attribute it to your organization. We don't store the content of your queries.</p>
  </div>
</body>
</html>`
}
