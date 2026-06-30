// Signing-key management + JWT issue/verify for our AS, using `jose`.
//
// Key source:
//  - Production: load the RS256 keypair from env `MCP_OAUTH_SIGNING_JWK`
//    (a JSON object {privateJwk, publicJwk, kid}).
//  - Dev/no-env: generate once and persist to Netlify Blobs, so the key is
//    stable across invocations (the spike proved an in-memory key breaks the
//    flow — tokens signed at /token wouldn't verify at /mcp).
//
// PRODUCTION TODO: key rotation (publish multiple JWKS entries; sign with newest).

import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose'
import { getStore } from '@netlify/blobs'

const ALG = 'RS256'
const KEY_STORE = 'mcp-oauth-keys'
const KEY_NAME = 'active'

let cache = null // { privateKey, publicJwk, kid }

async function materialize({ privateJwk, publicJwk, kid }) {
  const privateKey = await importJWK(privateJwk, ALG)
  return { privateKey, publicJwk: { ...publicJwk, kid, alg: ALG, use: 'sig' }, kid }
}

async function generate() {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const privateJwk = await exportJWK(privateKey)
  const kid = await calculateJwkThumbprint(publicJwk)
  return { privateJwk, publicJwk, kid }
}

async function loadKeys() {
  if (cache) return cache

  const fromEnv = process.env.MCP_OAUTH_SIGNING_JWK
  if (fromEnv) {
    cache = await materialize(JSON.parse(fromEnv))
    return cache
  }

  // Dev: persist a generated key in Blobs so it survives warm invocations.
  // Strong consistency so a second function (e.g. the resource server reading
  // the key the AS just wrote) sees it immediately rather than regenerating.
  const store = getStore({ name: KEY_STORE, consistency: 'strong' })
  let stored = await store.get(KEY_NAME, { type: 'json' }).catch(() => null)
  if (!stored) {
    stored = await generate()
    await store.setJSON(KEY_NAME, stored).catch(() => {})
  }
  cache = await materialize(stored)
  return cache
}

export async function getJwks() {
  const { publicJwk } = await loadKeys()
  return { keys: [publicJwk] }
}

export async function signAccessToken(claims, { issuer, audience, ttlSec }) {
  const { privateKey, kid } = await loadKeys()
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(`${ttlSec}s`)
    .sign(privateKey)
}

export async function verifyAccessToken(token, { issuer, audience }) {
  const { privateKey } = await loadKeys()
  // For a single local key we can verify with the private key's public half;
  // importing the public JWK keeps it explicit.
  const { publicJwk } = await loadKeys()
  const publicKey = await importJWK(publicJwk, ALG)
  try {
    // Pin RS256 (defense-in-depth against alg-confusion, on top of the RSA key).
    const { payload } = await jwtVerify(token, publicKey, { issuer, audience, algorithms: [ALG] })
    return { valid: true, claims: payload }
  } catch (e) {
    return { valid: false, error: e?.code || e?.message || 'invalid_token' }
  }
}
