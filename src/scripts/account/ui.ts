/** Small DOM helpers for the account pages: steps, field errors, busy buttons, and formatting. */

import { ApiError } from './api';

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

export function input(form: HTMLFormElement, name: string): HTMLInputElement {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input ${name}`);
  return element;
}

/** Shows one `[data-step]` section and moves focus to its first field, or its heading. */
export function showStep(name: string, root: ParentNode = document): void {
  for (const step of root.querySelectorAll<HTMLElement>('[data-step]')) step.hidden = step.dataset.step !== name;
  const step = root.querySelector<HTMLElement>(`[data-step="${name}"]`);
  if (!step) return;
  const target = step.querySelector<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([readonly]), [data-focus]') ?? step.querySelector<HTMLElement>('h1, h2');
  if (target) {
    if (!target.matches('input, button, a')) target.tabIndex = -1;
    target.focus({ preventScroll: false });
  }
}

/** The error line for an input: the element its aria-describedby names with a field__error class. */
function errorLine(field: HTMLInputElement): HTMLElement | null {
  for (const id of (field.getAttribute('aria-describedby') ?? '').split(/\s+/)) {
    const element = id ? document.getElementById(id) : null;
    if (element?.classList.contains('field__error')) return element;
  }
  return null;
}

export function setFieldError(field: HTMLInputElement, message: string): void {
  field.setAttribute('aria-invalid', 'true');
  const line = errorLine(field);
  if (line) line.textContent = message;
  field.focus();
}

export function clearErrors(root: ParentNode): void {
  for (const field of root.querySelectorAll<HTMLInputElement>('[aria-invalid]')) {
    field.removeAttribute('aria-invalid');
    const line = errorLine(field);
    if (line) line.textContent = '';
  }
  for (const notice of root.querySelectorAll<HTMLElement>('[data-form-error]')) notice.textContent = '';
}

/** Shows an API error on its field when it names one, else in the form's notice. */
export function showError(form: HTMLFormElement, error: unknown, fallbackField?: string): void {
  const message = error instanceof Error ? error.message : 'Something went wrong. Try again.';
  const name = error instanceof ApiError && error.field ? error.field : fallbackField;
  const field = name ? form.elements.namedItem(name) : null;
  if (field instanceof HTMLInputElement) {
    setFieldError(field, message);
    return;
  }
  const notice = form.querySelector<HTMLElement>('[data-form-error]');
  if (notice) notice.textContent = message;
  else toast(message);
}

/** Disables a button while its request runs. */
export async function busy<T>(button: HTMLButtonElement | null, work: () => Promise<T>): Promise<T> {
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  try {
    return await work();
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

let toastTimer = 0;
export function toast(message: string): void {
  const element = document.querySelector<HTMLElement>('[data-toast]');
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (element.hidden = true), 3200);
}

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function formatDate(iso: string | null | undefined): string {
  return iso ? dateFormat.format(new Date(iso)) : '';
}

/** "just now", "5 minutes ago", "3 hours ago", else the date. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return formatDate(iso);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Builds an element with text content only, so no API value is ever parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  Object.assign(element, props);
  element.append(...children);
  return element;
}

/** Copies text and says so. */
export async function copyText(text: string, done = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Could not copy. Select the text and copy it.');
  }
}
