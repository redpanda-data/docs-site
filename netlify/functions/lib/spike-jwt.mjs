// SPIKE ONLY — minimal RS256 JWT sign/verify + JWKS using node:crypto.
// Production will use `jose`; this just proves the flow with zero new deps.
//
// SPIKE FINDING (same as the store): the signing key can't live only in memory
// — each serverless invocation would generate a different key, so tokens signed
// at /token wouldn't verify at /protected. So the key is persisted to a file
// here; PRODUCTION persists it in env/secret + supports rotation.

import {
  generateKeyPairSync, createPrivateKey, createPublicKey,
  createSign, createVerify, createHash, randomUUID,
} from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY_FILE = join(tmpdir(), 'mcp-as-spike-key.json')

function loadOrCreateKeys() {
  if (existsSync(KEY_FILE)) {
    const { privateKeyPem, publicKeyPem } = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    return { privateKey: createPrivateKey(privateKeyPem), publicKey: createPublicKey(publicKeyPem) }
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  writeFileSync(KEY_FILE, JSON.stringify({ privateKeyPem: privateKey, publicKeyPem: publicKey }))
  return { privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(publicKey) }
}

const { privateKey, publicKey } = loadOrCreateKeys()
const publicJwk = publicKey.export({ format: 'jwk' })
const kid = createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex').slice(0, 16)

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const b64urlJson = (obj) => b64url(JSON.stringify(obj))

export function jwks() {
  return { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }
}

export function signJwt(claims, { issuer, audience, expiresInSec = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT', kid }
  const payload = { iss: issuer, aud: audience, iat: now, exp: now + expiresInSec, jti: randomUUID(), ...claims }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(privateKey)
  return `${signingInput}.${b64url(signature)}`
}

export function verifyJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return { valid: false, error: 'malformed' }
  const [h, p, s] = parts
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).end().verify(publicKey, Buffer.from(s, 'base64url'))
  if (!ok) return { valid: false, error: 'bad_signature' }
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return { valid: false, error: 'expired' }
  return { valid: true, claims: payload }
}
