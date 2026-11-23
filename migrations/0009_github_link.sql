-- Connecting GitHub to an existing account from the sign-in page. See docs/accounts.md.
--
-- A GitHub account that is not connected, whose verified primary email has a pi-rust account, now comes back as a
-- 'link' row: user_id is that account, and GitHub is connected once its owner signs in. SQLite cannot change a
-- CHECK constraint, so the table is made again. Its rows last 10 minutes, so a GitHub sign-in that is in
-- progress during the migration starts over.
DROP TABLE github_states;

-- One trip to GitHub and back (10 minutes, single use). The __Host-pirs_github cookie holds a 256-bit token;
-- only its SHA-256 is stored. purpose is sign-in, connect, or reauth on the way out. A GitHub account that is not
-- connected comes back with a new token as a 'sign-up' row, or as a 'link' row when its email has an account;
-- the row holds its ID, login, and verified primary email until the Terms are accepted or the owner signs in.
CREATE TABLE github_states (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign-in', 'connect', 'reauth', 'sign-up', 'link')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  -- The PKCE code verifier; null on a 'sign-up' or 'link' row.
  code_verifier TEXT,
  -- Where to go afterwards: an /account/, /admin/, or /device/ path, or a share.
  next TEXT NOT NULL,
  github_id INTEGER,
  login TEXT,
  email TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
