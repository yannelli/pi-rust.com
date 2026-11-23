import { getCollection, type CollectionEntry } from 'astro:content';

export type Doc = CollectionEntry<'docs'>;

/** Install has its own top-level page; every other doc lives under /docs/. */
export const docHref = (doc: Doc) => (doc.id === 'install' ? '/install/' : `/docs/${doc.id}/`);

export async function docsInOrder() {
  return (await getCollection('docs')).sort((a, b) => a.data.order - b.data.order);
}

/** Groups in the order of their first page. */
export async function docsNav() {
  const groups = new Map<string, Doc[]>();
  for (const doc of await docsInOrder()) {
    groups.set(doc.data.group, [...(groups.get(doc.data.group) ?? []), doc]);
  }
  return [...groups].map(([name, docs]) => ({ name, docs }));
}
