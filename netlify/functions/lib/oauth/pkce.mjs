// PKCE helpers (RFC 7636), S256 only.
import { createHash, randomBytes } from 'node:crypto'

export const s256 = (verifier) => createHash('sha256').update(verifier).digest('base64url')

export function verifyChallenge(verifier, challenge) {
  if (!verifier || !challenge) return false
  return s256(verifier) === challenge
}

// Generate a verifier/challenge pair for our own (upstream) leg of the flow.
export function generatePair() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: s256(verifier) }
}
