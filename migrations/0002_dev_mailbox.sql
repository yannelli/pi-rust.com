-- Local development and tests only: with DEV_MAILBOX=1 on localhost, account email is written here
-- instead of being sent, and GET /__dev/mailbox reads it. It stays empty in production.
CREATE TABLE dev_mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX dev_mailbox_to ON dev_mailbox(to_address);
