/** Overview: the totals, pi-rust users per day and their versions, 30 days of new accounts and shares, and install pings. */

import { $, el, formatBytes } from '../account/ui';
import { accessError, adminApi, formatNumber, pill, plural } from './common';

interface Overview {
  accounts: { total: number; verified: number; admins: number; suspended: number; twoStep: number; newThisWeek: number };
  shares: { total: number; link: number; private: number; expiring: number; expired: number; bytes: number; views: number; newThisWeek: number };
  cliTokens: number;
  bugReports: { total: number; open: number; newThisWeek: number };
  days: { date: string; signUps: number; shares: number }[];
}

interface Installs {
  configured: boolean;
  error?: string;
  total?: number;
  versions?: { version: string; pings: number }[];
  platforms?: { platform: string; arch: string; pings: number }[];
  days?: { date: string; pings: number }[];
}

interface Versions {
  users: {
    today: number;
    /** The first day with a count, or null before the first one. */
    since: string | null;
    days: { date: string; users: number }[];
    /** Users counted once a day for each version they ran that day, over 30 days. */
    versions: { version: string; userDays: number }[];
    platforms: { platform: string; arch: string; userDays: number }[];
    todayVersions: { version: string; users: number }[];
  };
  requests: { configured: false } | { configured: true; error: string } | { configured: true; total: number };
}

interface Meter {
  label: string;
  value: number;
  /** Marks the latest pi-rust release. */
  latest?: boolean;
}

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));

function stat(id: string, value: string, note: string): void {
  $(`[data-stat="${id}"]`).textContent = value;
  $(`[data-stat-note="${id}"]`).textContent = note;
}

/** A bar per day. The chart is one image to a screen reader, labeled with its total. */
function chart(root: HTMLElement, label: string, days: { date: string; value: number }[]): void {
  const total = days.reduce((sum, day) => sum + day.value, 0);
  const max = Math.max(1, ...days.map((day) => day.value));
  const bars = el('div', { className: 'chart__bars' });
  bars.setAttribute('role', 'img');
  bars.setAttribute('aria-label', `${label}: ${formatNumber(total)} in the last ${days.length} days`);
  for (const day of days) {
    const bar = el('span', { className: 'chart__bar' });
    bar.dataset.tip = `${dayLabel(day.date)}: ${formatNumber(day.value)}`;
    if (day.value) bar.style.setProperty('--h', `${(day.value / max) * 100}%`);
    else bar.dataset.zero = '';
    bars.append(bar);
  }
  root.replaceChildren(
    el('div', { className: 'chart__head' }, el('span', { className: 'chart__title' }, label), el('span', { className: 'chart__total' }, formatNumber(total))),
    bars,
    el('div', { className: 'chart__axis' }, el('span', {}, dayLabel(days[0].date)), el('span', {}, 'Today')),
  );
}

function facts(name: string, rows: [string, string][]): void {
  $(`[data-facts="${name}"]`).replaceChildren(...rows.map(([label, value]) => el('li', {}, el('span', {}, label), el('span', {}, value))));
}

const share = (part: number, whole: number) => (whole ? `${formatNumber(part)} (${Math.round((part / whole) * 100)}%)` : formatNumber(part));

/** "52%", "4.5%", "<0.1%". */
function percent(part: number, whole: number): string {
  if (!whole || !part) return '0%';
  const value = (part / whole) * 100;
  if (value < 0.1) return '<0.1%';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/**
 * Bars for a ranked list. With `total`, each row shows its share of the total (and its count, unless
 * `counts` is false), and each bar is that share; without it, each row shows its count, and the bars are to
 * scale of the largest.
 */
function meters(rows: Meter[], total?: number, counts = true): HTMLUListElement {
  const scale = total ?? Math.max(1, ...rows.map((row) => row.value));
  return el(
    'ul',
    { className: 'meters' },
    ...rows.map((row) => {
      const fill = el('span', { className: 'meter__fill' });
      fill.style.setProperty('--w', `${(row.value / scale) * 100}%`);
      const track = el('span', { className: 'meter__track' }, fill);
      track.setAttribute('aria-hidden', 'true');
      const label = el('span', { className: 'meter__label' }, el('span', { className: 'meter__name', title: row.label }, row.label));
      if (row.latest) label.append(pill('Latest', 'strong'));
      const values = total
        ? [el('span', { className: 'meter__value' }, percent(row.value, total)), ...(counts ? [el('span', { className: 'meter__count' }, formatNumber(row.value))] : [])]
        : [el('span', { className: 'meter__value' }, formatNumber(row.value))];
      return el('li', { className: total ? (counts ? 'meter meter--share' : 'meter meter--percent') : 'meter' }, label, track, ...values);
    }),
  );
}

/** The first `limit - 1` rows, and the rest added up as one, so a long tail fits. */
function top(rows: Meter[], noun: string, limit = 8): Meter[] {
  if (rows.length <= limit) return rows;
  const rest = rows.slice(limit - 1);
  return [...rows.slice(0, limit - 1), { label: `${rest.length} other ${noun}`, value: rest.reduce((sum, row) => sum + row.value, 0) }];
}

function column(title: string, rows: Meter[], empty: string, total?: number, counts = true): HTMLElement {
  return el('div', {}, el('p', { className: 'chart__title meters__title' }, title), rows.length ? meters(rows, total, counts) : el('p', { className: 'list__empty meters__title' }, empty));
}

function notice(title: string, text: string): HTMLElement {
  return el('div', { className: 'empty' }, el('strong', {}, title), el('span', {}, text));
}

function figure(label: string, value: string, note: string): HTMLElement {
  return el('div', { className: 'figure' }, el('span', { className: 'stat__label' }, label), el('span', { className: 'figure__value' }, value), el('span', { className: 'stat__note' }, note));
}

async function loadOverview(): Promise<void> {
  const data = await adminApi<Overview>('overview');
  const { accounts, shares, bugReports } = data;
  stat('accounts', formatNumber(accounts.total), `${formatNumber(accounts.newThisWeek)} new this week`);
  stat('shares', formatNumber(shares.total), `${formatNumber(shares.newThisWeek)} new this week`);
  stat('reports', formatNumber(bugReports.open), `${formatNumber(bugReports.newThisWeek)} received this week`);
  $('[data-stats]').removeAttribute('aria-busy');

  chart($('[data-chart="signUps"]'), 'New accounts', data.days.map((day) => ({ date: day.date, value: day.signUps })));
  chart($('[data-chart="shares"]'), 'New shares', data.days.map((day) => ({ date: day.date, value: day.shares })));

  facts('accounts', [
    ['Verified email', share(accounts.verified, accounts.total)],
    ['Two-step verification or a passkey', share(accounts.twoStep, accounts.total)],
    ['Admins', formatNumber(accounts.admins)],
    ['Suspended', formatNumber(accounts.suspended)],
    ['CLI tokens', formatNumber(data.cliTokens)],
  ]);
  facts('shares', [
    ['Anyone with the link', formatNumber(shares.link)],
    ['Only the owner', formatNumber(shares.private)],
    ['Set to expire', formatNumber(shares.expiring)],
    ['Storage', formatBytes(shares.bytes)],
    ['Views', formatNumber(shares.views)],
  ]);
}

async function loadInstalls(): Promise<void> {
  const root = $('[data-installs]');
  let data: Installs;
  try {
    data = await adminApi<Installs>('installs');
  } catch (error) {
    if (accessError(error)) return;
    root.replaceChildren(notice('Could not load install stats', (error as Error).message));
    return;
  }
  if (!data.configured) {
    stat('installs', '–', 'Not set up');
    root.replaceChildren(
      notice(
        'Install stats are not set up',
        'Add a Cloudflare API token with Account Analytics Read as the CLOUDFLARE_ANALYTICS_TOKEN secret of the Worker. docs/admin.md has the steps.',
      ),
    );
    return;
  }
  if (data.error) {
    stat('installs', '–', 'Could not load');
    root.replaceChildren(notice('Could not load install stats', data.error));
    return;
  }
  stat('installs', formatNumber(data.total ?? 0), 'Last 30 days');
  const days = el('div', { className: 'chart' });
  chart(days, 'Pings per day', (data.days ?? []).map((day) => ({ date: day.date, value: day.pings })));
  const versions = (data.versions ?? []).map((row) => ({ label: row.version, value: row.pings }));
  const platforms = (data.platforms ?? []).map((row) => ({ label: `${row.platform} ${row.arch}`, value: row.pings }));
  root.replaceChildren(
    el('div', { className: 'surface--pad' }, days),
    el('div', { className: 'columns installs__columns' }, column('Versions', versions, 'No pings yet.'), column('Platforms', platforms, 'No pings yet.')),
  );
}

/** The latest pi-rust release, from the site's own /version.json; undefined when it cannot be read. */
async function latestRelease(): Promise<string | undefined> {
  try {
    const response = await fetch('/version.json');
    return response.ok ? ((await response.json()) as { version?: string }).version : undefined;
  } catch {
    return undefined;
  }
}

async function loadVersions(): Promise<void> {
  const root = $('[data-versions]');
  const latestPromise = latestRelease();
  let data: Versions;
  try {
    data = await adminApi<Versions>('versions');
  } catch (error) {
    if (accessError(error)) return;
    root.replaceChildren(notice('Could not load users', (error as Error).message));
    return;
  }
  const { users, requests } = data;
  if (!users.since) {
    root.replaceChildren(notice('No users counted yet', 'pi-rust 0.12.27 and later ask pi-rust.com for the model catalog. Each one counts here once a day.'));
    return;
  }
  const latest = await latestPromise;
  const today = new Date().toISOString().slice(0, 10);
  // Today is not over, so the average is over the full days since counting began.
  const fullDays = users.days.filter((day) => day.date >= users.since! && day.date < today);
  const average = fullDays.length ? fullDays.reduce((sum, day) => sum + day.users, 0) / fullDays.length : undefined;
  const onLatest = users.todayVersions.find((row) => row.version === latest)?.users ?? 0;
  const figures = el(
    'div',
    { className: 'figures' },
    figure('Users today', formatNumber(users.today), 'So far, in UTC'),
    figure('Users per day', average === undefined ? '–' : formatNumber(Math.round(average)), average === undefined ? 'After the first full day' : `Average of ${plural(fullDays.length, 'day')}`),
    figure(
      'On the latest release',
      latest && users.today ? percent(onLatest, users.today) : '–',
      latest ? `Of users today, on ${latest}` : 'Could not read the latest release',
    ),
    figure(
      'Catalog requests',
      requests.configured && 'total' in requests ? formatNumber(requests.total) : '–',
      !requests.configured ? 'Needs the analytics token' : 'total' in requests ? 'Last 30 days, estimated' : 'Could not load',
    ),
  );
  const days = el('div', { className: 'chart' });
  chart(days, 'Users per day', users.days.map((day) => ({ date: day.date, value: day.users })));
  const versionTotal = users.versions.reduce((sum, row) => sum + row.userDays, 0);
  const platformTotal = users.platforms.reduce((sum, row) => sum + row.userDays, 0);
  const versionRows = top(
    users.versions.map((row) => ({ label: row.version, value: row.userDays, latest: row.version === latest })),
    'versions',
  );
  const platformRows = top(
    users.platforms.map((row) => ({ label: row.arch === 'unknown' && row.platform === 'unknown' ? 'unknown' : `${row.platform} ${row.arch}`, value: row.userDays })),
    'platforms',
  );
  root.replaceChildren(
    el('div', { className: 'surface--pad versions__top' }, figures, days),
    el(
      'div',
      { className: 'columns installs__columns' },
      column('Versions', versionRows, 'No users yet.', versionTotal, false),
      column('Platforms', platformRows, 'No users yet.', platformTotal, false),
    ),
    el(
      'p',
      { className: 'surface__foot' },
      'A user is one IP address, platform, and architecture on one UTC day. The shares count each user once for every day they ran pi-rust in the last 30 days.',
    ),
  );
}

loadOverview().catch((error) => {
  if (accessError(error)) return;
  for (const id of ['accounts', 'shares', 'reports']) stat(id, '–', 'Could not load');
  $('[data-stats]').removeAttribute('aria-busy');
});
loadInstalls();
loadVersions();
