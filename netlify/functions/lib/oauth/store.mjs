// OAuth state storage — backend selector.
//
// The public interface here is stable; callers (mcp-oauth.mjs, clients.mjs)
// don't know or care which backend is active. The one-time-use / transactional
// state (auth requests, auth codes, refresh tokens, families) is served by
// either the Blobs backend (default) or the Neon Postgres backend, chosen by
// STORE_BACKEND. The Neon backend exists because Blobs has no compare-and-swap,
// so its one-time-use is best-effort; Neon makes consume atomic.
//
// Rollout: deploy with STORE_BACKEND=blobs (default), flip a preview to neon,
// verify, then flip prod. Roll back by resetting the env var — no code revert.
//
// NOTE: flipping blobs→neon does not migrate existing rows, so any live refresh
// tokens (in Blobs) won't exist in Neon — users re-authenticate once at cutover.
// Auth codes (60s TTL) are unaffected in practice. Flip during low traffic.

import * as blobs from './db/blobs.mjs'
import * as neon from './db/neon.mjs'

const backend = (process.env.STORE_BACKEND || 'blobs').toLowerCase() === 'neon' ? neon : blobs

// One-time-use / transactional OAuth state — backend-selectable.
export const putAuthRequest = (...a) => backend.putAuthRequest(...a)
export const takeAuthRequest = (...a) => backend.takeAuthRequest(...a)
export const putAuthCode = (...a) => backend.putAuthCode(...a)
export const takeAuthCode = (...a) => backend.takeAuthCode(...a)
export const putRefresh = (...a) => backend.putRefresh(...a)
export const getRefresh = (...a) => backend.getRefresh(...a)
export const consumeRefresh = (...a) => backend.consumeRefresh(...a)
export const putFamily = (...a) => backend.putFamily(...a)
export const getFamily = (...a) => backend.getFamily(...a)
export const revokeFamily = (...a) => backend.revokeFamily(...a)

// DCR-registered clients always live on Blobs: they are plain persistence (not
// one-time-use), so the Neon migration's atomicity buys nothing here. Keeping
// them on Blobs keeps the migration surface small.
export const putClient = blobs.putClient
export const getStoredClient = blobs.getStoredClient
