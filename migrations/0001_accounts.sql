-- pi-rust.com accounts and session sharing. See docs/accounts.md.
-- Times are Unix milliseconds. Tokens, codes, and secrets are stored only as hashes or ciphertext.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified_at INTEGER,
  -- "pbkdf2-sha256$<iterations>$<pepper id>$<salt>$<hash>", so the parameters can be upgraded per user.
  password_hash TEXT NOT NULL,
  -- AES-GCM ciphertext of the TOTP secret; totp_pending holds a secret until the first code confirms it.
  totp_secret TEXT,
  totp_pending TEXT,
  totp_enabled_at INTEGER,
  -- The last accepted TOTP time step, so a code cannot be used twice.
  totp_last_step INTEGER,
  -- The WebAuthn user handle (random, base64url).
  webauthn_user_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Browser sessions. The cookie holds the token; only its SHA-256 is stored.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Last password or passkey confirmation; sensitive actions need one in the last 10 minutes.
  reauth_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

-- A password sign-in waiting for its second step (TOTP, recovery code, or passkey).
CREATE TABLE sign_in_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Email verification and password reset links. Single use.
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX email_tokens_user ON email_tokens(user_id);

-- Two-step recovery codes, stored as HMAC-SHA256 with the pepper. Single use.
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  aaguid TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- One WebAuthn ceremony: 5 minutes, single use.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Bearer tokens for the pi CLI (pirs_...). Only the SHA-256 is stored. No expiry.
CREATE TABLE cli_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX cli_tokens_user ON cli_tokens(user_id);

-- RFC 8628 device authorization requests.
CREATE TABLE device_codes (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  client_label TEXT NOT NULL,
  -- pending, approved, denied, or done (the token was issued).
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  poll_interval INTEGER NOT NULL,
  last_polled_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Shared sessions. The HTML is in R2 at shares/<id>.html.
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX shares_user ON shares(user_id, created_at);
