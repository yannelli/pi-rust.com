-- Share controls: an optional expiry, who can open a share, and a view count. See docs/sharing.md.
-- Existing shares keep today's behavior: no expiry, anyone with the link.

-- Unix milliseconds; NULL means the share never expires. The hourly cleanup deletes expired shares.
ALTER TABLE shares ADD COLUMN expires_at INTEGER;
-- 'link': anyone with the link. 'private': only the signed-in owner.
ALTER TABLE shares ADD COLUMN visibility TEXT NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'private'));
-- Views by anyone but the owner and link-preview bots. No IP address or user agent is stored.
ALTER TABLE shares ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shares ADD COLUMN last_viewed_at INTEGER;

CREATE INDEX shares_expires ON shares(expires_at);
