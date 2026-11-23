-- The admin area: roles, suspension, the bug report index, and the admin activity log. See docs/admin.md.

-- 'admin' opens /admin/ (with two-step verification on). The first admin is set with
-- `wrangler d1 execute`; admins make other admins in the admin area.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
-- Unix milliseconds. A suspended account cannot sign in, has no sessions or CLI tokens, and its
-- shares answer 404. NULL means not suspended.
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
CREATE INDEX users_created ON users(created_at);
CREATE INDEX shares_created ON shares(created_at);

-- One row per /bug report, so the admin area can list, search, and close them. The files stay in
-- R2 at bug-reports/<id>/; the hourly cleanup indexes a report whose row is missing and deletes
-- rows after 90 days, when the bucket's lifecycle rule deletes the files.
CREATE TABLE bug_reports (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  -- The user's description (report.json "hint"), at most 4,000 characters.
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  model TEXT NOT NULL,
  -- JSON array of {"name", "size"}, one per uploaded part.
  files TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at INTEGER
);
CREATE INDEX bug_reports_received ON bug_reports(received_at);

-- What each admin did, and to which account, share, or report. No foreign keys, so an entry
-- outlives the admin and the target. The hourly cleanup deletes entries after 365 days.
CREATE TABLE admin_events (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  -- role, suspend, restore, sign-out, delete-account, hide-share, delete-share, close-report,
  -- reopen-report, delete-report
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('account', 'share', 'bug-report')),
  target_id TEXT NOT NULL,
  -- The email, share title, or report description at the time, since the target may be deleted.
  target_label TEXT NOT NULL,
  -- A detail such as the new role or a suspension reason.
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_events_created ON admin_events(created_at);
