/** Bug reports: the list, a report's details and files, close or reopen, and delete. */

import { $, busy, el, formatBytes, formatDate, relativeTime, toast } from '../account/ui';
import { accessError, adminApi, confirmAction, emptyRow, meta, pill, plural, reportError, sensitive } from './common';
import { AdminList } from './list';

interface Report {
  id: string;
  receivedAt: string;
  description: string;
  version: string;
  platform: string;
  model: string;
  files: { name: string; size: number }[];
  size: number;
  status: 'open' | 'closed';
  closedAt: string | null;
}

type Json = Record<string, unknown>;

interface ReportDetail {
  report: Report;
  reportJson: Json | null;
  diagnostics: Json | null;
}

const dialog = $('[data-report]') as HTMLDialogElement;
const statusButton = $('[data-report-status]') as HTMLButtonElement;
const deleteButton = $('[data-report-delete]') as HTMLButtonElement;
let current: Report | undefined;

/** The first line of the description, or a stand-in. */
const headline = (report: Report) => report.description.split('\n')[0].trim() || 'No description';

function row(report: Report): HTMLLIElement {
  const open = el('button', { type: 'button', className: 'row__name' }, headline(report));
  open.addEventListener('click', () => show(report.id));
  const title = el('div', { className: 'row__title' }, open);
  if (report.status === 'closed') title.append(pill('Closed', 'quiet'));
  const details = meta(report.version && `pi ${report.version}`, report.platform, report.model, formatBytes(report.size));
  return el(
    'li',
    {},
    el('div', { className: 'row__text' }, title, el('span', { className: 'row__meta' }, details || 'No environment details')),
    el('span', { className: 'row__time', title: new Date(report.receivedAt).toLocaleString() }, relativeTime(report.receivedAt)),
  );
}

function value(source: unknown, ...path: string[]): string {
  let node = source;
  for (const key of path) node = node && typeof node === 'object' ? (node as Json)[key] : undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  return '';
}

const length = (source: unknown, key: string) => {
  const list = source && typeof source === 'object' ? (source as Json)[key] : undefined;
  return Array.isArray(list) ? list.length : 0;
};

function fact(term: string, detail: string): Node[] {
  return detail ? [el('dt', {}, term), el('dd', {}, detail)] : [];
}

function render(detail: ReportDetail): void {
  const { report, reportJson, diagnostics } = detail;
  current = report;
  $('[data-report-title]').textContent = headline(report);
  $('[data-report-pills]').replaceChildren(
    pill(report.status === 'closed' ? `Closed ${formatDate(report.closedAt)}` : 'Open', report.status === 'closed' ? 'quiet' : 'neutral'),
    pill(`Received ${formatDate(report.receivedAt)}`, 'quiet'),
  );
  const text = $('[data-report-text]');
  text.textContent = report.description || 'The report has no description.';
  const session = reportJson ? (value(reportJson, 'session', 'included') === 'true' ? 'Included' : 'Not included') : '';
  $('[data-report-facts]').replaceChildren(
    ...fact('Report ID', report.id),
    ...fact('Version', report.version),
    ...fact('Platform', report.platform),
    ...fact('Model', report.model ? `${report.model}${value(reportJson, 'thinkingLevel') ? ` (thinking ${value(reportJson, 'thinkingLevel')})` : ''}` : ''),
    ...fact('Transcript', session),
    ...fact('Failed turns', diagnostics ? String(length(diagnostics, 'assistant')) : ''),
    ...fact('Crashes', diagnostics ? String(length(diagnostics, 'crashes')) : ''),
    ...fact('Extensions', reportJson ? `${length(reportJson, 'extensions')}, ${plural(length(reportJson, 'extensionErrors'), 'error')}` : ''),
  );
  $('[data-report-files]').replaceChildren(
    ...report.files.map((file) => {
      const link = el('a', { className: 'btn btn--secondary btn--small', href: `/api/admin/bug-reports/${report.id}/files/${file.name}` }, 'Download');
      link.setAttribute('download', '');
      link.setAttribute('aria-label', `Download ${file.name}`);
      return el('li', {}, el('div', {}, el('code', {}, file.name), ' ', el('span', {}, formatBytes(file.size))), link);
    }),
  );
  const json = (name: string, data: Json | null) =>
    data ? [el('details', { className: 'json' }, el('summary', {}, name), el('pre', {}, JSON.stringify(data, null, 2)))] : [];
  $('[data-report-json]').replaceChildren(...json('report.json', reportJson), ...json('diagnostics.json', diagnostics));
  statusButton.textContent = report.status === 'closed' ? 'Reopen' : 'Close report';
}

async function show(id: string): Promise<void> {
  try {
    render(await adminApi<ReportDetail>(`bug-reports/${id}`));
    if (!dialog.open) dialog.showModal();
    $('[data-report-done]').focus();
  } catch (error) {
    if (!accessError(error)) reportError(error);
  }
}

$('[data-report-done]').addEventListener('click', () => dialog.close());

statusButton.addEventListener('click', async () => {
  if (!current) return;
  const status = current.status === 'closed' ? 'open' : 'closed';
  try {
    await busy(statusButton, () => adminApi(`bug-reports/${current!.id}`, { method: 'PATCH', body: { status } }));
    dialog.close();
    toast(status === 'closed' ? 'Report closed' : 'Report reopened');
    await list.load();
  } catch (error) {
    reportError(error);
  }
});

deleteButton.addEventListener('click', async () => {
  if (!current) return;
  const report = current;
  dialog.close();
  if (!(await confirmAction('Delete this bug report?', 'Its files are deleted from storage. The email copy, if one was sent, stays. This can’t be undone.', 'Delete report'))) return;
  try {
    if (!(await sensitive(() => adminApi(`bug-reports/${report.id}`, { method: 'DELETE', body: {} })))) return;
    toast('Report deleted');
    await list.load();
  } catch (error) {
    reportError(error);
  }
});

const list = new AdminList<Report>({
  endpoint: 'bug-reports',
  key: 'reports',
  filterParam: 'status',
  row,
  empty: (searching) => (searching ? emptyRow('No matching reports', 'Try other words or another filter.') : emptyRow('No open bug reports', 'Reports sent with /bug in pi-rust appear here.')),
  count: (total) => plural(total, 'report'),
});

// A link such as /admin/bug-reports/#<id>, from the report's email, opens that report. Read it before the
// list replaces the address.
const linked = location.hash.slice(1);
list.load();
if (/^[0-9a-f-]{36}$/.test(linked)) show(linked);
