/**
 * Shared by the admin pages: calls to /api/admin/*, the two-step notice, and small builders for pills,
 * avatars, and empty states. The account panel script (sign out, confirm it's you, confirm dialogs)
 * runs here too.
 */

import { ApiError, callJson, toSignIn, type Json } from '../account/api';
import { account } from '../account/panel';
import { $, el } from '../account/ui';

export { confirmAction, reportError, sensitive } from '../account/panel';

export function adminApi<T = Json>(path: string, options?: { method?: string; body?: Json }): Promise<T> {
  return callJson<T>(`/api/admin/${path}`, options);
}

account().then(({ account }) => {
  $('[data-admin-avatar]').textContent = account.email.slice(0, 1);
});

// On a phone the sections are one row that scrolls sideways; bring the current one into view.
document.querySelector('.admin__nav [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

/**
 * Handles an error that means the page cannot be used: signed out, or no second step. Returns true when
 * it did, so the caller shows nothing else.
 */
export function accessError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401) toSignIn();
  if (error.code !== 'two_step_required' && error.code !== 'forbidden') return false;
  if (error.code === 'forbidden') {
    $('#gate-title').textContent = 'Admins only';
    $('[data-admin-gate] .btn').hidden = true;
  }
  $('[data-admin-gate-text]').textContent = error.message;
  $('[data-admin-gate]').hidden = false;
  $('[data-admin-content]').hidden = true;
  return true;
}

export type Tone = 'neutral' | 'strong' | 'warn' | 'quiet';

export function pill(text: string, tone: Tone = 'neutral'): HTMLSpanElement {
  return el('span', { className: tone === 'neutral' ? 'pill' : `pill pill--${tone}` }, text);
}

export function avatar(email: string): HTMLSpanElement {
  const element = el('span', { className: 'avatar' }, email.slice(0, 1));
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/** An empty or failed list: what would be here, or what went wrong. */
export function emptyRow(title: string, text: string, error = false): HTMLLIElement {
  return el('li', { className: error ? 'empty empty--error' : 'empty' }, el('strong', {}, title), el('span', {}, text));
}

const numberFormat = new Intl.NumberFormat('en-US');
export const formatNumber = (value: number) => numberFormat.format(value);

export const plural = (count: number, word: string, many = `${word}s`) => `${formatNumber(count)} ${count === 1 ? word : many}`;

/** Joins the parts that are set with a middle dot. */
export const meta = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' · ');
