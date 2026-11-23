// The hourly cleanup (cron "17 * * * *" in wrangler.jsonc): deletes expired shares from R2 and D1, and
// expired sign-in rows that the request paths only delete now and then. See docs/sharing.md. It also
// keeps the admin area's bug report list in step with R2, drops old admin activity, and deletes the salts
// of past days and old daily client counts (docs/admin.md).

import type { AccountEnv } from './accounts/env';
import { BUG_REPORT_DAYS, indexMissingReports, type BugReportEnv } from './bug-reports';
import { dayOf } from './catalog-clients';
import { deleteExpiredShares } from './share/store';

/** Expired shares deleted per run. Each run takes the oldest first, so a backlog clears over a few hours. */
const SHARE_BATCH = 500;
const DAY = 24 * 60 * 60 * 1000;
/** Admin activity is kept for a year. */
const ADMIN_EVENT_DAYS = 365;
/** Daily client counts are kept for 90 days. */
const CATALOG_CLIENT_DAYS = 90;

export type CleanupEnv = AccountEnv & Pick<BugReportEnv, 'BUG_REPORTS'>;

export interface CleanupResult {
  shares: number;
  deviceCodes: number;
  signInChallenges: number;
  emailTokens: number;
  webauthnChallenges: number;
  /** Rows of reports whose files the bucket's lifecycle rule deleted. */
  bugReports: number;
  /** Rows added for reports in R2 that had none. */
  bugReportsIndexed: number;
  adminEvents: number;
  /** Salts of days before today. */
  catalogSalts: number;
  catalogClients: number;
  emailChanges: number;
}

export async function cleanup(env: CleanupEnv, now = Date.now()): Promise<CleanupResult> {
  const shares = await deleteExpiredShares(env, { now, limit: SHARE_BATCH });
  const [deviceCodes, signInChallenges, emailTokens, webauthnChallenges, bugReports, adminEvents, catalogSalts, catalogClients, emailChanges] = await env.DB.batch([
    // A day after expiry, as in device.ts, so a late poll still gets expired_token.
    env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(now - DAY),
    env.DB.prepare('DELETE FROM sign_in_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM email_tokens WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM bug_reports WHERE received_at < ?').bind(now - BUG_REPORT_DAYS * DAY),
    env.DB.prepare('DELETE FROM admin_events WHERE created_at < ?').bind(now - ADMIN_EVENT_DAYS * DAY),
    // Once its day is over, a salt is never needed again; without it, no one can recompute a day's hashes.
    env.DB.prepare('DELETE FROM catalog_salts WHERE day < ?').bind(dayOf(now)),
    env.DB.prepare('DELETE FROM catalog_clients WHERE day < ?').bind(dayOf(now - CATALOG_CLIENT_DAYS * DAY)),
    env.DB.prepare('DELETE FROM email_changes WHERE expires_at < ?').bind(now),
  ]);
  let bugReportsIndexed = 0;
  try {
    bugReportsIndexed = await indexMissingReports(env, now);
  } catch (error) {
    console.error('bug report indexing failed', (error as Error)?.message ?? error);
  }
  return {
    shares,
    deviceCodes: deviceCodes.meta.changes,
    signInChallenges: signInChallenges.meta.changes,
    emailTokens: emailTokens.meta.changes,
    webauthnChallenges: webauthnChallenges.meta.changes,
    bugReports: bugReports.meta.changes,
    bugReportsIndexed,
    adminEvents: adminEvents.meta.changes,
    catalogSalts: catalogSalts.meta.changes,
    catalogClients: catalogClients.meta.changes,
    emailChanges: emailChanges.meta.changes,
  };
}
