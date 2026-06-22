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
// without a Redpanda Cloud account at the Cloud signup page; `privacyUrl` links
// the privacy policy so users know what we collect before they sign in.
export function loginInterstitialHtml({ continueUrl, signupUrl, privacyUrl }) {
  const c = escapeAttr(continueUrl)
  const s = escapeAttr(signupUrl)
  const p = escapeAttr(privacyUrl)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Redpanda Docs MCP</title>
<link rel="icon" href="/_/img/favicon.png" type="image/png">
<style>
  /* Inter + brand palette pulled from docs.redpanda.com (served same-origin). */
  @font-face { font-family: 'Inter'; font-weight: 400; font-display: swap; src: url('/_/font/Inter-Regular.ttf') format('truetype'); }
  @font-face { font-family: 'Inter'; font-weight: 500; font-display: swap; src: url('/_/font/Inter-Medium.ttf') format('truetype'); }
  @font-face { font-family: 'Inter'; font-weight: 600; font-display: swap; src: url('/_/font/Inter-SemiBold.ttf') format('truetype'); }
  :root {
    --brand: #e24328;       /* brand-600 */
    --brand-dark: #c1331a;  /* brand-700 */
    --text: #181818;
    --faint: #667085;
    --footer: #98a2b3;
    --border: #eaeaea;
    --page: #f9f9f9;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: var(--page); color: var(--text);
         margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         -webkit-font-smoothing: antialiased; }
  .card { background: #fff; max-width: 400px; width: 100%; padding: 40px; border: 1px solid var(--border);
          border-radius: 12px; box-shadow: 0 2px 8px rgba(24,24,24,.06); text-align: center; }
  .logo { width: 44px; height: auto; margin: 0 auto 20px; display: block; }
  h1 { font-size: 22px; font-weight: 600; line-height: 1.3; margin: 0 0 10px; letter-spacing: -0.01em; }
  .lead { color: var(--faint); font-size: 15px; line-height: 1.55; margin: 0 0 28px; }
  .btn { display: block; background: var(--brand); color: #fff; text-decoration: none; font-size: 15px;
         font-weight: 600; padding: 13px 18px; border-radius: 8px; transition: background .15s ease; }
  .btn:hover { background: var(--brand-dark); }
  .signup { margin-top: 20px; font-size: 14px; color: var(--faint); }
  .signup a { color: var(--brand); font-weight: 500; text-decoration: none; }
  .signup a:hover { text-decoration: underline; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0 18px; }
  .note { font-size: 12.5px; color: var(--footer); line-height: 1.55; margin: 0; }
  .note a { color: var(--footer); text-decoration: underline; }
</style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/_/img/footer-logo.svg" alt="Redpanda" width="44" height="38">
    <h1>Connect to Redpanda Docs</h1>
    <p class="lead">Sign in with your Redpanda Cloud account to use the Redpanda documentation tools in your AI client.</p>
    <a class="btn" href="${c}">Continue with Redpanda Cloud</a>
    <div class="signup">
      New to Redpanda? <a href="${s}" target="_blank" rel="noopener">Create a free account</a>
    </div>
    <hr>
    <p class="note">When you sign in, we collect your verified work email to track documentation usage and attribute it to your organization. See our <a href="${p}" target="_blank" rel="noopener">Privacy Policy</a> for details.</p>
  </div>
</body>
</html>`
}
