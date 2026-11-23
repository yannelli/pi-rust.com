/**
 * An admin list: rows from a paged /api/admin/ endpoint, with a search field, filter chips, a count, and
 * "Load more". The search and filter are kept in the address, so a reload or a shared link shows the same list.
 */

import { accessError, adminApi, emptyRow } from './common';

export interface ListConfig<T> {
  /** The endpoint under /api/admin/, such as `users`. */
  endpoint: string;
  /** The array in the response, such as `users`. */
  key: string;
  /** The query parameter the filter chips set; the first chip is the default. */
  filterParam?: string;
  row: (item: T) => HTMLElement;
  empty: (searching: boolean) => HTMLLIElement;
  count: (total: number) => string;
}

interface Page {
  next: number | null;
  total?: number;
  [key: string]: unknown;
}

export class AdminList<T> {
  items: T[] = [];
  private next: number | null = null;
  private request = 0;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement | null;
  private readonly filters: HTMLButtonElement[];
  private readonly more: HTMLButtonElement | null;
  private readonly countLine: HTMLElement | null;

  constructor(private readonly config: ListConfig<T>) {
    this.list = document.querySelector<HTMLElement>('[data-list]')!;
    this.search = document.querySelector<HTMLInputElement>('[data-find]');
    this.filters = [...document.querySelectorAll<HTMLButtonElement>('[data-filter]')];
    this.more = document.querySelector<HTMLButtonElement>('[data-more]');
    this.countLine = document.querySelector<HTMLElement>('[data-count]');

    const params = new URLSearchParams(location.search);
    // Text typed before this script ran stays.
    const q = params.get('q');
    if (this.search && q !== null) this.search.value = q;
    const filter = config.filterParam ? params.get(config.filterParam) : null;
    if (filter && this.filters.some((chip) => chip.dataset.filter === filter)) this.select(filter);

    let timer = 0;
    this.search?.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this.load(), 250);
    });
    this.search?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      window.clearTimeout(timer);
      this.load();
    });
    for (const chip of this.filters) {
      chip.addEventListener('click', () => {
        if (chip.getAttribute('aria-pressed') === 'true') return;
        this.select(chip.dataset.filter!);
        this.load();
      });
    }
    this.more?.addEventListener('click', () => this.loadMore());
  }

  private select(value: string): void {
    for (const chip of this.filters) chip.setAttribute('aria-pressed', String(chip.dataset.filter === value));
  }

  private get filter(): string {
    return this.filters.find((chip) => chip.getAttribute('aria-pressed') === 'true')?.dataset.filter ?? this.filters[0]?.dataset.filter ?? '';
  }

  private get q(): string {
    return this.search?.value.trim() ?? '';
  }

  private params(offset: number): URLSearchParams {
    const params = new URLSearchParams();
    if (this.q) params.set('q', this.q);
    if (this.config.filterParam && this.filter && this.filter !== this.filters[0]?.dataset.filter) params.set(this.config.filterParam, this.filter);
    if (offset) params.set('offset', String(offset));
    return params;
  }

  private async fetch(offset: number): Promise<Page | undefined> {
    const request = ++this.request;
    const query = this.params(offset).toString();
    const page = await adminApi<Page>(`${this.config.endpoint}${query ? `?${query}` : ''}`);
    return request === this.request ? page : undefined;
  }

  private show(page: Page, append: boolean): void {
    const items = page[this.config.key] as T[];
    this.items = append ? this.items.concat(items) : items;
    this.next = page.next;
    if (append) this.list.append(...items.map((item) => this.config.row(item)));
    else this.list.replaceChildren(...(items.length ? items.map((item) => this.config.row(item)) : [this.config.empty(Boolean(this.q) || this.filter !== this.filters[0]?.dataset.filter)]));
    if (this.more) this.more.hidden = this.next === null;
    if (this.countLine && typeof page.total === 'number') this.countLine.textContent = this.config.count(page.total);
  }

  /** Loads the first page for the current search and filter. */
  async load(): Promise<void> {
    const address = this.params(0).toString();
    history.replaceState(null, '', `${location.pathname}${address ? `?${address}` : ''}`);
    this.list.setAttribute('aria-busy', 'true');
    try {
      const page = await this.fetch(0);
      if (page) this.show(page, false);
    } catch (error) {
      if (accessError(error)) return;
      this.list.replaceChildren(emptyRow('Could not load this list', (error as Error).message, true));
    } finally {
      this.list.removeAttribute('aria-busy');
    }
  }

  private async loadMore(): Promise<void> {
    if (this.next === null || !this.more) return;
    this.more.disabled = true;
    try {
      const page = await this.fetch(this.next);
      if (page) this.show(page, true);
    } catch (error) {
      if (!accessError(error)) this.list.append(emptyRow('Could not load more', (error as Error).message, true));
    } finally {
      this.more.disabled = false;
    }
  }
}
