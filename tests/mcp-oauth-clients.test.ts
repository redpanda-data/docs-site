import { describe, it, expect, vi } from 'vitest'
import { isCimdClientId, redirectUriAllowed, validateCimdDocument, getClient } from '../netlify/functions/lib/oauth/clients.mjs'

describe('isCimdClientId', () => {
  it('treats https URLs as CIMD client_ids', () => {
    expect(isCimdClientId('https://claude.ai/.well-known/oauth-client')).toBe(true)
    expect(isCimdClientId('mcp_abc123')).toBe(false)
    expect(isCimdClientId('http://insecure/doc')).toBe(false) // not https
  })
})

describe('redirectUriAllowed', () => {
  const client = { redirect_uris: ['https://chatgpt.com/cb', 'http://127.0.0.1:0/callback'] }
  it('exact match', () => {
    expect(redirectUriAllowed(client, 'https://chatgpt.com/cb')).toBe(true)
    expect(redirectUriAllowed(client, 'https://evil.com/cb')).toBe(false)
  })
  it('loopback matches ignoring the port (native clients)', () => {
    expect(redirectUriAllowed(client, 'http://127.0.0.1:52345/callback')).toBe(true)
    expect(redirectUriAllowed(client, 'http://127.0.0.1:9999/other')).toBe(false) // path must match
  })
  it('non-loopback http is not port-flexible', () => {
    expect(redirectUriAllowed({ redirect_uris: ['http://example.com:1/cb'] }, 'http://example.com:2/cb')).toBe(false)
  })
})

describe('validateCimdDocument', () => {
  const url = 'https://claude.ai/oauth-client.json'
  it('accepts a doc whose client_id equals its URL', () => {
    const c = validateCimdDocument(url, { client_id: url, redirect_uris: ['https://claude.ai/cb'] })
    expect(c.redirect_uris).toEqual(['https://claude.ai/cb'])
    expect(c.token_endpoint_auth_method).toBe('none')
  })
  it('rejects client_id != URL, or missing redirect_uris', () => {
    expect(() => validateCimdDocument(url, { client_id: 'https://x/', redirect_uris: ['https://x/cb'] })).toThrow()
    expect(() => validateCimdDocument(url, { client_id: url })).toThrow()
  })
})

describe('getClient (CIMD fetch with injected fetch)', () => {
  it('fetches + validates a CIMD URL client_id', async () => {
    const url = 'https://claude.ai/oauth-client.json'
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ client_id: url, redirect_uris: ['https://claude.ai/cb'] }) }))
    const c = await getClient(url, { fetchImpl })
    expect(c.client_id).toBe(url)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('unknown DCR client_id -> null (store miss, no crash)', async () => {
    expect(await getClient('mcp_unknown', { fetchImpl: vi.fn() })).toBeNull()
  })
  it('blocks loopback/private CIMD hosts (SSRF guard) -> null', async () => {
    const spy = vi.fn()
    expect(await getClient('https://127.0.0.1/doc', { fetchImpl: spy })).toBeNull()
    expect(await getClient('https://localhost/doc', { fetchImpl: spy })).toBeNull()
    expect(spy).not.toHaveBeenCalled() // never even fetched
  })
})
