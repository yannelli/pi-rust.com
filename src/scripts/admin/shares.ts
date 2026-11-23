/** Shares: every account's shares. Open a link share, make a share private, or delete it. */

import { copyText, el, formatBytes, formatDate, relativeTime, toast } from '../account/ui';
import { adminApi, confirmAction, emptyRow, meta, pill, plural, reportError, sensitive } from './common';
import { AdminList } from './list';
import { menuButton, type MenuAction } from './menu';

interface AdminShare {
  id: string;
  title: string;
  size: number;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  visibility: 'link' | 'private';
  views: number;
  lastViewedAt: string | null;
  url: string | null;
  owner: { id: string; email: string; suspended: boolean };
}

function row(share: AdminShare): HTMLLIElement {
  const name = share.url
    ? el('a', { className: 'row__name', href: share.url, target: '_blank', rel: 'noopener' }, share.title)
    : el('span', { className: 'row__name' }, share.title);
  const title = el('div', { className: 'row__title' }, name);
  if (share.visibility === 'private') title.append(pill('Only the owner', 'quiet'));
  if (share.expired) title.append(pill('Expired', 'warn'));
  if (share.owner.suspended) title.append(pill('Owner suspended', 'warn'));
  const details = meta(
    share.owner.email,
    formatBytes(share.size),
    `Shared ${formatDate(share.createdAt)}`,
    share.views ? `${plural(share.views, 'view')}, last viewed ${relativeTime(share.lastViewedAt)}` : 'No views',
    share.expiresAt && !share.expired ? `Expires ${formatDate(share.expiresAt)}` : null,
  );
  return el(
    'li',
    {},
    el('div', { className: 'row__text' }, title, el('span', { className: 'row__meta' }, details)),
    el('div', { className: 'row__actions' }, menuButton(`Actions for ${share.title}`, () => actions(share))),
  );
}

function actions(share: AdminShare): MenuAction[] {
  const items: MenuAction[] = [];
  if (share.url) {
    const url = share.url;
    items.push({ label: 'Open', run: () => window.open(url, '_blank', 'noopener') });
    items.push({ label: 'Copy link', run: () => copyText(url, 'Link copied') });
  }
  items.push({
    label: 'Filter by owner',
    run: () => {
      const search = document.querySelector<HTMLInputElement>('[data-find]');
      if (!search) return;
      search.value = share.owner.email;
      list.load();
    },
  });
  if (share.visibility === 'link') {
    items.push({
      label: 'Make private',
      separate: true,
      run: async () => {
        const text = 'Only the owner can open it from now on. The owner can share it again.';
        if (!(await confirmAction(`Make “${share.title}” private?`, text, 'Make private', false))) return;
        try {
          await adminApi(`shares/${share.id}/hide`, { body: {} });
          toast('Share made private');
          await list.load();
        } catch (error) {
          reportError(error);
        }
      },
    });
  }
  items.push({
    label: 'Delete share…',
    separate: share.visibility !== 'link',
    danger: true,
    run: async () => {
      const text = `The share of ${share.owner.email} stops working for everyone, the owner too. This can’t be undone.`;
      if (!(await confirmAction(`Delete “${share.title}”?`, text, 'Delete share'))) return;
      try {
        if (!(await sensitive(() => adminApi(`shares/${share.id}`, { method: 'DELETE', body: {} })))) return;
        toast('Share deleted');
        await list.load();
      } catch (error) {
        reportError(error);
      }
    },
  });
  return items;
}

const list = new AdminList<AdminShare>({
  endpoint: 'shares',
  key: 'shares',
  filterParam: 'filter',
  row,
  empty: (searching) => (searching ? emptyRow('No matching shares', 'Try another title, owner, or filter.') : emptyRow('No shares yet', 'Sessions shared from the pi CLI appear here.')),
  count: (total) => plural(total, 'share'),
});

list.load();
