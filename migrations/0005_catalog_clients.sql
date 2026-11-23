-- Daily unique pi-rust clients, counted from model catalog requests. See docs/admin.md.

-- One random salt per UTC day (YYYY-MM-DD). The hourly cleanup deletes it once the day is over, so a
-- day's hashes can no longer be recomputed from an address.
CREATE TABLE catalog_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);

-- A client on one UTC day: the HMAC-SHA256 of its IP address, platform, and architecture with that day's
-- salt (32 hex characters), and the version it ran. A client that updates during the day has a row per
-- version. No IP address is stored. The hourly cleanup deletes rows after 90 days.
CREATE TABLE catalog_clients (
  day TEXT NOT NULL,
  client TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  PRIMARY KEY (day, client, version)
);
