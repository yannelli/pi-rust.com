/** Activity: what admins did, newest first. */

import { el, relativeTime } from '../account/ui';
import { avatar, emptyRow } from './common';
import { AdminList } from './list';

interface AdminEvent {
  id: string;
  admin: string;
  action: string;
  target: { type: string; id: string; label: string };
  detail: string | null;
  createdAt: string;
}

/** "suspended", "made … an admin": the words between the admin and the target, and after it. */
function phrase(event: AdminEvent): [string, string] {
  switch (event.action) {
    case 'role':
      return event.detail === 'admin' ? ['made', 'an admin'] : ['removed admin access from', ''];
    case 'suspend':
      return ['suspended', ''];
    case 'restore':
      return ['restored', ''];
    case 'sign-out':
      return ['signed out', 'everywhere'];
    case 'delete-account':
      return ['deleted the account', ''];
    case 'hide-share':
      return ['made the share', 'private'];
    case 'delete-share':
      return ['deleted the share', ''];
    case 'close-report':
      return ['closed the bug report', ''];
    case 'reopen-report':
      return ['reopened the bug report', ''];
    case 'delete-report':
      return ['deleted the bug report', ''];
    default:
      return [event.action, ''];
  }
}

function row(event: AdminEvent): HTMLLIElement {
  const [verb, after] = phrase(event);
  const sentence = el('span', { className: 'row__name activity__text' }, el('strong', {}, event.admin), ` ${verb} `, el('strong', {}, event.target.label), after ? ` ${after}` : '');
  const text = el('div', { className: 'row__text' }, sentence);
  if (event.action === 'suspend' && event.detail) text.append(el('span', { className: 'row__detail' }, `Reason: ${event.detail}`));
  return el(
    'li',
    {},
    avatar(event.admin),
    text,
    el('span', { className: 'row__time', title: new Date(event.createdAt).toLocaleString() }, relativeTime(event.createdAt)),
  );
}

new AdminList<AdminEvent>({
  endpoint: 'activity',
  key: 'events',
  row,
  empty: () => emptyRow('No admin activity yet', 'Changes made in the admin area appear here.'),
  count: () => '',
}).load();
