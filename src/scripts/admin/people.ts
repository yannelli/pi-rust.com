/** People: every account, with role, suspension, sign out everywhere, and deletion. */

import { $, busy, el, formatDate, relativeTime, toast } from '../account/ui';
import { adminApi, avatar, confirmAction, emptyRow, meta, pill, plural, reportError, sensitive } from './common';
import { AdminList } from './list';
import { menuButton, type MenuAction } from './menu';

interface Person {
  id: string;
  email: string;
  verified: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  admin: boolean;
  suspendedAt: string | null;
  totp: boolean;
  passkeys: number;
  shares: number;
  cliTokens: number;
  /** The username of the connected GitHub account, or null. */
  github: string | null;
  you: boolean;
}

const suspendDialog = $('[data-suspend]') as HTMLDialogElement;
const suspendForm = $('[data-suspend-form]') as HTMLFormElement;

function row(person: Person): HTMLLIElement {
  const title = el('div', { className: 'row__title' }, el('span', { className: 'row__name' }, person.email));
  if (person.you) title.append(el('span', { className: 'row__you' }, '(you)'));
  if (person.admin) title.append(pill('Admin', 'strong'));
  if (person.suspendedAt) title.append(pill('Suspended', 'warn'));
  if (!person.verified) title.append(pill('Unverified', 'quiet'));
  const twoStep = person.totp || person.passkeys > 0;
  const details = meta(
    person.suspendedAt ? `Suspended ${formatDate(person.suspendedAt)}` : `Joined ${formatDate(person.createdAt)}`,
    person.lastActiveAt ? `Active ${relativeTime(person.lastActiveAt)}` : 'Never active',
    plural(person.shares, 'share'),
    person.cliTokens ? plural(person.cliTokens, 'CLI token') : null,
    person.github ? `GitHub ${person.github}` : null,
    twoStep ? 'Two-step on' : null,
  );
  const item = el('li', {}, avatar(person.email), el('div', { className: 'row__text' }, title, el('span', { className: 'row__meta' }, details)));
  if (!person.you) item.append(el('div', { className: 'row__actions' }, menuButton(`Actions for ${person.email}`, () => actions(person))));
  return item;
}

/** Runs an action that needs a recent confirmation, then reloads the list. */
async function act(path: string, done: string, body: Record<string, unknown> = {}): Promise<void> {
  try {
    const result = await sensitive(() => adminApi(path, { body }));
    if (!result) return;
    toast(done);
    await list.load();
  } catch (error) {
    reportError(error);
  }
}

function actions(person: Person): MenuAction[] {
  const items: MenuAction[] = [];
  const base = `users/${person.id}`;
  if (person.admin) {
    items.push({
      label: 'Remove admin access',
      run: async () => {
        if (await confirmAction(`Remove admin access for ${person.email}?`, 'They keep their account and shares, and can no longer open the admin area.', 'Remove admin access')) {
          await act(`${base}/role`, 'Admin access removed', { role: 'user' });
        }
      },
    });
  } else if (!person.suspendedAt) {
    items.push({
      label: 'Make admin',
      run: async () => {
        const text = 'Admins can see every account and share, suspend and delete accounts, and read bug reports. They need two-step verification to open the admin area.';
        if (await confirmAction(`Make ${person.email} an admin?`, text, 'Make admin', false)) {
          await act(`${base}/role`, 'Made an admin', { role: 'admin' });
        }
      },
    });
  }
  items.push({
    label: 'Sign out everywhere',
    run: async () => {
      const text = 'Ends every browser session and CLI token of this account. They can sign in again.';
      if (await confirmAction(`Sign ${person.email} out everywhere?`, text, 'Sign out everywhere', false)) await act(`${base}/sign-out`, 'Signed out everywhere');
    },
  });
  if (person.suspendedAt) {
    items.push({
      label: 'Restore account',
      run: async () => {
        if (await confirmAction(`Restore ${person.email}?`, 'They can sign in again, and their shares open again.', 'Restore', false)) await act(`${base}/restore`, 'Account restored');
      },
    });
  } else if (!person.admin) {
    items.push({ label: 'Suspend account…', separate: true, danger: true, run: () => suspend(person) });
  }
  if (!person.admin) {
    items.push({
      label: 'Delete account…',
      separate: Boolean(person.suspendedAt),
      danger: true,
      run: async () => {
        const text = 'Deletes the account, its shares, passkeys, and CLI tokens, and emails them that it was deleted. The address can sign up again; suspend instead to stop that. This can’t be undone.';
        if (await confirmAction(`Delete ${person.email}?`, text, 'Delete account')) await act(`${base}/delete`, 'Account deleted');
      },
    });
  }
  return items;
}

function suspend(person: Person): void {
  suspendForm.reset();
  $('[data-suspend-title]').textContent = `Suspend ${person.email}?`;
  const reason = suspendForm.elements.namedItem('reason') as HTMLTextAreaElement;
  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    const submit = suspendForm.querySelector<HTMLButtonElement>('button[type=submit]');
    try {
      const result = await busy(submit, () => sensitive(() => adminApi(`users/${person.id}/suspend`, { body: { reason: reason.value.trim() } })));
      if (!result) return;
      suspendDialog.close();
      toast('Account suspended');
      await list.load();
    } catch (error) {
      reportError(error);
    }
  };
  suspendForm.addEventListener('submit', onSubmit);
  suspendDialog.addEventListener('close', () => suspendForm.removeEventListener('submit', onSubmit), { once: true });
  $('[data-suspend-cancel]').onclick = () => suspendDialog.close();
  suspendDialog.showModal();
  reason.focus();
}

const list = new AdminList<Person>({
  endpoint: 'users',
  key: 'users',
  filterParam: 'filter',
  row,
  empty: (searching) => (searching ? emptyRow('No matching accounts', 'Try another address, GitHub username, or filter.') : emptyRow('No accounts yet', 'Accounts appear here when people sign up.')),
  count: (total) => plural(total, 'account'),
});

list.load();
