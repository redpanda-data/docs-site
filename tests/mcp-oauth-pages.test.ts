import { describe, it, expect } from 'vitest'
import { loginInterstitialHtml } from '../netlify/functions/lib/oauth/pages.mjs'

describe('loginInterstitialHtml', () => {
  const continueUrl = 'https://auth.prd.cloud.redpanda.com/authorize?client_id=docs&state=abc&scope=openid+email'
  const signupUrl = 'https://cloud.redpanda.com'
  const privacyUrl = 'https://www.redpanda.com/legal/privacy-policy'
  const out = loginInterstitialHtml({ continueUrl, signupUrl, privacyUrl })

  it('renders a Continue link to the upstream URL and a signup link', () => {
    expect(out).toContain('Continue with Redpanda Cloud')
    expect(out).toContain('Sign up at cloud.redpanda.com')
    expect(out).toContain('href="https://cloud.redpanda.com"')
  })
  it('discloses what we collect and links the privacy policy', () => {
    expect(out).toContain('verified work email')
    expect(out).toContain('Privacy Policy')
    expect(out).toContain('href="https://www.redpanda.com/legal/privacy-policy"')
  })
  it('escapes & in the continue URL href (valid HTML attribute)', () => {
    expect(out).toContain('client_id=docs&amp;state=abc') // & -> &amp;
    expect(out).not.toContain('client_id=docs&state=abc') // raw & should not appear
  })
  it('escapes quotes to prevent attribute breakout', () => {
    const evil = loginInterstitialHtml({ continueUrl: 'https://x/?a="><script>', signupUrl })
    expect(evil).not.toContain('"><script>')
    expect(evil).toContain('&quot;&gt;&lt;script&gt;')
  })
})
