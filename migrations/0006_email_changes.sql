-- Changing the email address of an account. See docs/accounts.md.
--
-- A change waits for the link sent to the new address ('confirm', 24 hours). Once it is made, the old
-- address gets a link that undoes it ('undo', 7 days). Tokens are stored as SHA-256 and work once.
-- requested_at is when the change was asked for: undoing it removes the passkeys and two-step
-- verification added since then.
CREATE TABLE email_changes (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm', 'undo')),
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX email_changes_user ON email_changes(user_id);
