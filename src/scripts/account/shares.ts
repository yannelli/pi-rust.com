/** Shares: list, copy a link, open, download, rename, set the expiry and visibility, and delete. */

import { api } from './api';
import { confirmAction, reportError, sensitive } from './panel';
import './verify-banner';
import { $, busy, clearErrors, copyText, el, formatBytes, formatDate, input, relativeTime, setFieldError, showError, toast } from './ui';

interface Share {
  id: string;
  url: string;
  title: string;
  size: number;
  createdAt: string;
  expiresAt: string | null;
  visibility: 'link' | 'private';
  views: number;
  lastViewedAt: string | null;
}

const list = $('[data-shares]');
const foot = $('[data-shares-foot]');
const deleteExpiredButton = $('[data-delete-expired]') as HTMLButtonElement;
const deleteAllButton = $('[data-delete-all]') as HTMLButtonElement;
const menu = $('[data-share-menu]');
const renameDialog = $('[data-share-rename]') as HTMLDialogElement;
const renameForm = $('[data-share-rename-form]') as HTMLFormElement;

let shares: Share[] = [];
/** The share whose menu is open, and the button that opened it. */
let active: { share: Share; trigger: HTMLButtonElement } | undefined;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const isExpired = (share: Share) => share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now();

/** "Expires in 45 minutes", "Expires in 3 hours", "Expires in 6 days". */
function expiresText(iso: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  if (minutes < 60) return `Expires in ${plural(minutes, 'minute')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Expires in ${plural(hours, 'hour')}`;
  return `Expires in ${plural(Math.floor(hours / 24), 'day')}`;
}

function viewsText(share: Share): string {
  if (!share.views) return 'No views yet';
  return share.lastViewedAt ? `${plural(share.views, 'view')} · last viewed ${relativeTime(share.lastViewedAt)}` : plural(share.views, 'view');
}

function row(share: Share): HTMLLIElement {
  const expired = isExpired(share);
  const head = el('div', { className: 'share__head' }, el('span', { className: 'list__title' }, el('a', { href: share.url, target: '_blank', rel: 'noopener' }, share.title)));
  if (share.visibility === 'private') head.append(el('span', { className: 'badge' }, 'Only me'));
  if (expired) head.append(el('span', { className: 'badge badge--warn' }, 'Expired'));
  const details = [formatBytes(share.size), formatDate(share.createdAt)];
  if (share.expiresAt && !expired) details.push(expiresText(share.expiresAt));

  const more = el('button', { type: 'button', className: 'btn btn--secondary btn--small btn--icon' });
  more.setAttribute('aria-label', `More actions for ${share.title}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-controls', menu.id);
  more.setAttribute('aria-expanded', 'false');
  more.dataset.more = share.id;
  more.addEventListener('click', () => openMenu(share, more));

  const actions = el('div', { className: 'list__actions' });
  // An expired link no longer opens; its menu can give it a new expiry or delete it.
  if (!expired) {
    const copy = el('button', { type: 'button', className: 'btn btn--secondary btn--small' }, 'Copy link');
    copy.setAttribute('aria-label', `Copy link to ${share.title}`);
    copy.addEventListener('click', () => copyText(share.url, 'Link copied'));
    const open = el('a', { href: share.url, target: '_blank', rel: 'noopener', className: 'btn btn--secondary btn--small' }, 'Open');
    open.setAttribute('aria-label', `Open ${share.title}`);
    const download = el('a', { href: `${share.url}?download=1`, className: 'btn btn--secondary btn--small' }, 'Download');
    download.setAttribute('download', '');
    download.setAttribute('aria-label', `Download ${share.title}`);
    actions.append(copy, open, download);
  }
  actions.append(more);

  return el(
    'li',
    {},
    el('div', { className: 'list__text' }, head, el('span', { className: 'list__meta' }, details.join(' · ')), el('span', { className: 'list__meta' }, viewsText(share))),
    actions,
  );
}

function render(): void {
  list.replaceChildren(...(shares.length ? shares.map(row) : [el('li', { className: 'list__empty' }, 'No shared sessions.')]));
  const expired = shares.filter(isExpired).length;
  foot.hidden = shares.length === 0;
  $('[data-shares-count]').textContent = plural(shares.length, 'share');
  deleteExpiredButton.hidden = expired === 0;
}

/** Reloads the list. `focusId` puts focus back on that share's menu button, after a change made from its menu. */
async function load(focusId?: string): Promise<void> {
  try {
    shares = (await api<{ shares: Share[] }>('shares')).shares;
    render();
    if (focusId) list.querySelector<HTMLButtonElement>(`[data-more="${focusId}"]`)?.focus();
  } catch (error) {
    list.replaceChildren(el('li', { className: 'list__empty' }, (error as Error).message));
  } finally {
    list.removeAttribute('aria-busy');
  }
}

async function update(share: Share, body: Record<string, unknown>, done: string): Promise<void> {
  try {
    await api(`shares/${share.id}`, { method: 'PATCH', body });
    toast(done);
    await load(share.id);
  } catch (error) {
    reportError(error);
  }
}

// The menu: one manual popover, placed under the button that opened it. It closes on a click outside,
// Escape, Tab, scrolling, or resizing, as a menu button's menu does.
const menuItems = () => [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
const menuOpen = () => menu.matches(':popover-open');

function placeMenu(trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = menu;
  const left = Math.min(rect.right - width, window.innerWidth - width - 8);
  const below = rect.bottom + 4;
  const above = rect.top - height - 4;
  const top = below + height <= window.innerHeight - 8 || above < 8 ? below : above;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
}

function openMenu(share: Share, trigger: HTMLButtonElement): void {
  const same = active?.trigger === trigger;
  closeMenu(false);
  if (same) return;
  active = { share, trigger };
  for (const item of menu.querySelectorAll<HTMLElement>('[data-expires]')) {
    item.setAttribute('aria-checked', String(item.dataset.expires === 'never' && share.expiresAt === null));
  }
  for (const item of menu.querySelectorAll<HTMLElement>('[data-visibility]')) {
    item.setAttribute('aria-checked', String(item.dataset.visibility === share.visibility));
  }
  menu.showPopover();
  placeMenu(trigger);
  trigger.setAttribute('aria-expanded', 'true');
  menuItems()[0].focus();
}

/** Closes the menu; `refocus` puts focus back on the button that opened it. */
function closeMenu(refocus: boolean): void {
  if (menuOpen()) menu.hidePopover();
  if (!active) return;
  active.trigger.setAttribute('aria-expanded', 'false');
  if (refocus) active.trigger.focus();
  active = undefined;
}

menu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    return closeMenu(true);
  }
  // Focus goes back to the menu button, and Tab moves on from there.
  if (event.key === 'Tab') return closeMenu(true);
  const items = menuItems();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = ({ ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[event.key];
  if (next === undefined) return;
  event.preventDefault();
  items[(next + items.length) % items.length].focus();
});

document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node;
  if (menuOpen() && !menu.contains(target) && !active?.trigger.contains(target)) closeMenu(false);
});
window.addEventListener('resize', () => closeMenu(false));
document.addEventListener('scroll', () => closeMenu(false), { passive: true });

/** Runs a menu action for the share the menu was opened for. */
function onMenu(selector: string, action: (share: Share, item: HTMLElement) => void): void {
  for (const item of menu.querySelectorAll<HTMLElement>(selector)) {
    item.addEventListener('click', () => {
      const share = active?.share;
      closeMenu(false);
      if (share) action(share, item);
    });
  }
}

onMenu('[data-menu-rename]', (share) => rename(share));

onMenu('[data-expires]', (share, item) => {
  const seconds = item.dataset.expires === 'never' ? null : Number(item.dataset.expires);
  update(share, { expiresIn: seconds }, seconds === null ? 'Never expires' : `Expires in ${item.textContent?.trim()}`);
});

onMenu('[data-visibility]', (share, item) => {
  const visibility = item.dataset.visibility;
  if (visibility === share.visibility) return;
  update(share, { visibility }, visibility === 'private' ? 'Only you can open it' : 'Anyone with the link can open it');
});

onMenu('[data-menu-delete]', async (share) => {
  if (!(await confirmAction('Delete share?', `“${share.title}” will stop working for anyone with the link.`, 'Delete'))) return;
  try {
    await api(`shares/${share.id}`, { method: 'DELETE' });
    toast('Share deleted');
    await load();
  } catch (error) {
    reportError(error);
  }
});

function rename(share: Share): void {
  clearErrors(renameForm);
  const title = input(renameForm, 'title');
  title.value = share.title;
  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    clearErrors(renameForm);
    if (!title.value.trim()) return setFieldError(title, 'Enter a title.');
    try {
      await busy(renameForm.querySelector('button[type=submit]'), () => api(`shares/${share.id}`, { method: 'PATCH', body: { title: title.value.trim() } }));
      renameDialog.close();
      toast('Share renamed');
      await load(share.id);
    } catch (error) {
      showError(renameForm, error, 'title');
    }
  };
  renameForm.addEventListener('submit', onSubmit);
  renameDialog.addEventListener('close', () => renameForm.removeEventListener('submit', onSubmit), { once: true });
  $('[data-share-rename-cancel]').onclick = () => renameDialog.close();
  renameDialog.showModal();
  title.select();
}

deleteExpiredButton.addEventListener('click', async () => {
  const count = shares.filter(isExpired).length;
  if (!(await confirmAction(`Delete ${plural(count, 'expired share')}?`, 'Their links already stopped working.', 'Delete'))) return;
  try {
    const { deleted } = await busy(deleteExpiredButton, () => api<{ deleted: number }>('shares/delete-expired', { body: {} }));
    toast(`Deleted ${plural(deleted, 'expired share')}`);
    await load();
  } catch (error) {
    reportError(error);
  }
});

deleteAllButton.addEventListener('click', async () => {
  const count = shares.length;
  const title = count === 1 ? 'Delete 1 share?' : `Delete all ${count} shares?`;
  if (!(await confirmAction(title, 'Every link stops working at once. This can’t be undone.', 'Delete all'))) return;
  try {
    const result = await busy(deleteAllButton, () => sensitive(() => api<{ deleted: number }>('shares/delete-all', { body: {} })));
    if (!result) return;
    toast('All shares deleted');
    await load();
  } catch (error) {
    reportError(error);
  }
});

load();
