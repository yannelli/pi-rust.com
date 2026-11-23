/**
 * The admin pages' row menu: one popover (#row-menu in the layout), filled with a row's actions and placed
 * under the button that opened it. It closes on a click outside, Escape, Tab, scrolling, or resizing, and
 * arrow keys move between its items, as a menu button's menu does.
 */

import { $, el } from '../account/ui';

export interface MenuAction {
  label: string;
  run: () => void;
  danger?: boolean;
  /** Draws a separator above this action. */
  separate?: boolean;
}

const menu = $('[data-row-menu]');
let trigger: HTMLButtonElement | undefined;

const items = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const isOpen = () => menu.matches(':popover-open');

function place(button: HTMLElement): void {
  const rect = button.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = menu;
  const left = Math.min(rect.right - width, window.innerWidth - width - 8);
  const below = rect.bottom + 4;
  const above = rect.top - height - 4;
  const top = below + height <= window.innerHeight - 8 || above < 8 ? below : above;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
}

/** Closes the menu; `refocus` puts focus back on the button that opened it. */
export function closeMenu(refocus: boolean): void {
  if (isOpen()) menu.hidePopover();
  if (!trigger) return;
  trigger.setAttribute('aria-expanded', 'false');
  if (refocus) trigger.focus();
  trigger = undefined;
}

function open(button: HTMLButtonElement, actions: MenuAction[]): void {
  const same = trigger === button;
  closeMenu(false);
  if (same) return;
  trigger = button;
  menu.setAttribute('aria-label', button.getAttribute('aria-label') ?? 'Actions');
  menu.replaceChildren(
    ...actions.flatMap((action) => {
      const item = el('button', { type: 'button', className: `menu__item menu__item--plain${action.danger ? ' menu__item--danger' : ''}`, tabIndex: -1 }, action.label);
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', () => {
        closeMenu(false);
        action.run();
      });
      if (!action.separate) return [item];
      const separator = el('div', { className: 'menu__sep' });
      separator.setAttribute('role', 'separator');
      return [separator, item];
    }),
  );
  menu.showPopover();
  place(button);
  button.setAttribute('aria-expanded', 'true');
  items()[0]?.focus();
}

/** A row's "More actions" button. `actions` runs when it opens, so the menu always shows the row's current state. */
export function menuButton(label: string, actions: () => MenuAction[]): HTMLButtonElement {
  const button = el('button', { type: 'button', className: 'btn btn--secondary btn--small btn--icon' });
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-controls', menu.id);
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => open(button, actions()));
  return button;
}

menu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    return closeMenu(true);
  }
  if (event.key === 'Tab') return closeMenu(true);
  const list = items();
  const index = list.indexOf(document.activeElement as HTMLButtonElement);
  const next = ({ ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 } as Record<string, number>)[event.key];
  if (next === undefined) return;
  event.preventDefault();
  list[(next + list.length) % list.length].focus();
});

document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node;
  if (isOpen() && !menu.contains(target) && !trigger?.contains(target)) closeMenu(false);
});
window.addEventListener('resize', () => closeMenu(false));
document.addEventListener('scroll', () => closeMenu(false), { passive: true });
