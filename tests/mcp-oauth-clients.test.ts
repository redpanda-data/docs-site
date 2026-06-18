import { describe, it, expect, vi } from 'vitest'
import { isCimdClientId, redirectUriAllowed, validateCimdDocument, getClient, isBlockedHost } from '../netlify/functions/lib/oauth/clients.mjs'

describe('isBlockedHost (SSRF guard)', () => {
  it('blocks IPv4 private / loopback / link-local + localhost', () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '0.0.0.0', 'localhost', 'foo.local']) {
      expect(isBlockedHost(h), h).toBe(true)
    }
  })
  it('blocks IPv6 loopback / ULA / link-local / mapped — including bracketed form', () => {
    for (const h of ['::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', '[fd00::1]', 'fe80::1', '[fe80::1]', '::ffff:10.0.0.1']) {
      expect(isBlockedHost(h), h).toBe(true)
    }
  })
  it('allows public hosts (incl. public IPv6 and fc-prefixed DNS names)', () => {
    for (const h of ['claude.ai', 'chatgpt.com', 'example.com', '8.8.8.8', '2606:4700::1111', 'fc.example.com']) {
      expect(isBlockedHost(h), h).toBe(false)
    }
  })
})

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
  it('blocks loopback/private CIMD hosts (SSRF guard) -> null, including IPv6', async () => {
    const spy = vi.fn()
    for (const url of ['https://127.0.0.1/doc', 'https://localhost/doc', 'https://[::1]/doc', 'https://[fd00::1]/doc', 'https://[fe80::1]/doc']) {
      expect(await getClient(url, { fetchImpl: spy }), url).toBeNull()
    }
    expect(spy).not.toHaveBeenCalled() // never even fetched
  })
  it('rejects an oversized CIMD doc declared via content-length -> null', async () => {
    const url = 'https://big.example/oauth-client.json'
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'content-length' ? '999999999' : null) },
      text: async () => '{}',
    }))
    expect(await getClient(url, { fetchImpl })).toBeNull()
  })
  it('rejects an oversized CIMD doc with no content-length (streamed cap) -> null', async () => {
    const url = 'https://big2.example/oauth-client.json'
    const huge = 'x'.repeat(200_000)
    const fetchImpl = vi.fn(async () => ({ ok: true, headers: { get: () => null }, text: async () => huge }))
    expect(await getClient(url, { fetchImpl })).toBeNull()
  })
  it('a CIMD fetch that errors (e.g. blocked redirect) -> null, not a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('redirect blocked')
    })
    expect(await getClient('https://redir.example/oauth-client.json', { fetchImpl })).toBeNull()
  })
})
