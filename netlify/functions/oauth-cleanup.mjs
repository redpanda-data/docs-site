// Scheduled cleanup of expired OAuth state (Neon backend only).
//
// Runs daily; deletes expired auth requests/codes and past-expiry refresh
// tokens, then sweeps empty token families. No-op unless STORE_BACKEND=neon and
// a database URL is configured, so it's safe to keep deployed during rollout.

import { cleanupExpired } from './lib/oauth/db/neon.mjs'

export default async () => {
  const backend = (process.env.STORE_BACKEND || 'blobs').toLowerCase()
  if (backend !== 'neon' || !process.env.NETLIFY_DATABASE_URL) {
    console.log(JSON.stringify({ event: 'oauth_cleanup_skipped', reason: 'not_neon_backend' }))
    return
  }
  try {
    const deleted = await cleanupExpired()
    console.log(JSON.stringify({ event: 'oauth_cleanup_ran', deleted }))
  } catch (e) {
    console.warn('[oauth-cleanup] failed', { error: e?.message })
  }
}

export const config = {
  schedule: '@daily',
}
