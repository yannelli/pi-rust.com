-- Sign in with GitHub. See docs/accounts.md.
--
-- An account made with GitHub has no password until its owner sets one: users.password_hash is ''.

-- The GitHub account connected to a pi-rust account, at most one each way. github_id is GitHub's numeric
-- user ID, which never changes; login is the GitHub username at the last sign-in, shown on the Security page.
CREATE TABLE github_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- One trip to GitHub and back (10 minutes, single use). The __Host-pirs_github cookie holds a 256-bit token;
-- only its SHA-256 is stored. purpose is sign-in, connect, or reauth on the way out. A GitHub account with no
-- pi-rust account comes back as a 'sign-up' row, with a new token, that holds its ID, login, and verified
-- primary email until the Terms are accepted.
CREATE TABLE github_states (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign-in', 'connect', 'reauth', 'sign-up')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  -- The PKCE code verifier; null on a 'sign-up' row.
  code_verifier TEXT,
  -- Where to go afterwards: an /account/, /admin/, or /device/ path, or a share.
  next TEXT NOT NULL,
  github_id INTEGER,
  login TEXT,
  email TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
