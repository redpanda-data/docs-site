# Spike: MCP OAuth 2.1 Authorization Server (broker) — DOC-2262

**Purpose:** de-risk the agreed architecture before the full build — prove that our docs service can run an OAuth 2.1 Authorization Server on **Netlify Functions**, federate the human login to an upstream IdP, and issue/validate its own tokens. Federates to a **mock upstream** so it runs with no Auth0 `client_id` yet.

## What it proves
- AS endpoint plumbing on Netlify Functions (one function, `path: /mcp-as/*`).
- Downstream **PKCE** (the AI client ↔ our AS) — issue + verify.
- The **federation shape**: `/authorize` → upstream login → `/callback` → mint our own auth code → `/token` → our JWT.
- **Token issuance + JWKS validation** end-to-end (`/protected`).
- A clean **storage seam** (in-memory now → Netlify DB later) and **pluggable upstream** (mock now → Auth0 later via env).

## Run it
```bash
cd <worktree>
REQUIRE_AUTH=ignore npx -y netlify-cli@latest functions:serve --offline --port 9999   # any port
# in another shell:
BASE=http://localhost:9999 ./spike-test.sh
```
The script walks `/authorize → mock IdP → /callback → /token → /protected` and prints the issued token's claims, plus two negative checks (bad PKCE, tampered token).

## Switch to the real Cloud IdP later (no rewrite)
Set env and flip the mode — everything else is unchanged:
```bash
SPIKE_UPSTREAM=auth0
REDPANDA_OAUTH_ISSUER=https://auth.prd.cloud.redpanda.com/
SPIKE_AUTH0_CLIENT_ID=<from Santi>
```
(`lib/spike-upstream.mjs` already builds the Auth0 authorize URL + token exchange; only `id_token` signature validation is stubbed with a TODO.)

## Explicitly NOT production (these are the later milestones)
- **JWT/crypto:** hand-rolled RS256 via `node:crypto`. → use **`jose`**.
- **Storage:** in-memory Maps (won't survive across real serverless instances). → **Netlify DB (Neon)**.
- **Signing key:** ephemeral per process. → persisted key + rotation.
- **No DCR/CIMD** (uses an implicit test client), **no refresh-token grant**, no consent UI, no revocation. → milestones 2–3.
- Upstream `id_token` validation stubbed (mock). → validate sig/iss/aud/exp/nonce against Auth0 JWKS.

## Files
- `netlify/functions/mcp-as.mjs` — the AS (router: metadata, jwks, authorize, mock-idp, callback, token, protected)
- `netlify/functions/lib/spike-jwt.mjs` — RS256 sign/verify + JWKS (node:crypto)
- `netlify/functions/lib/spike-store.mjs` — in-memory store (Netlify DB seam)
- `netlify/functions/lib/spike-upstream.mjs` — mock vs Auth0 federation
- `spike-test.sh` — end-to-end driver
