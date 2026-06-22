-- OAuth transactional state for the docs MCP authorization server.
-- Applied to the Neon (Netlify DB) database used when STORE_BACKEND=neon.
-- Idempotent: safe to run repeatedly.
--
-- Scope: the one-time-use / transactional tables only. DCR-registered clients
-- stay on Netlify Blobs (plain persistence, not one-time-use).

-- In-flight authorization requests (consumed by DELETE … RETURNING).
CREATE TABLE IF NOT EXISTS auth_requests (
  id                    uuid PRIMARY KEY,
  client_id             text NOT NULL,
  client_redirect_uri   text NOT NULL,
  client_state          text,
  client_code_challenge text,
  upstream_verifier     text,
  expires_at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_requests_expires ON auth_requests (expires_at);

-- Authorization codes (one-time; consumed by atomic UPDATE … WHERE used=false).
CREATE TABLE IF NOT EXISTS auth_codes (
  code                  text PRIMARY KEY,
  client_id             text NOT NULL,
  client_redirect_uri   text NOT NULL,
  client_code_challenge text,
  user_data             jsonb NOT NULL,
  used                  boolean NOT NULL DEFAULT false,
  expires_at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes (expires_at);

-- Refresh tokens, stored by hash (one-time; rotated via atomic UPDATE).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  hash       text PRIMARY KEY,
  family_id  uuid NOT NULL,
  client_id  text NOT NULL,
  user_data  jsonb NOT NULL,
  scope      text,
  used       boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family  ON refresh_tokens (family_id);

-- Refresh-token families (rotation lineage; revoked on reuse detection).
CREATE TABLE IF NOT EXISTS refresh_families (
  id         uuid PRIMARY KEY,
  client_id  text,
  revoked    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
