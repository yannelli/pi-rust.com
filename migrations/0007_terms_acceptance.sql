-- Which Terms of Service a user accepted at sign-up, and when. See docs/accounts.md.
--
-- terms_version is TERMS_VERSION from src/lib/legal.ts (the date those Terms took effect, YYYY-MM-DD);
-- terms_accepted_at is Unix milliseconds. Accounts created before this migration have both null.
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
