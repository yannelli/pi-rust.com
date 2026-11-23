import upstream from '../data/upstream.json';

/**
 * Rows of the daily parity report that the site shows. Each row counts pi's own items
 * that pi-rust lacks, and its allowlist holds only pi-rust extras, so 0 means pi-rust
 * has every one. `noun` is the lowercase plural for sentences.
 */
const SHOWN = [
  { section: 'CLI flags', label: 'CLI flags', noun: 'CLI flags' },
  { section: 'Slash commands', label: 'Slash commands', noun: 'slash commands' },
  { section: 'Built-in tools', label: 'Built-in tools', noun: 'built-in tools' },
  { section: 'Extension API', label: 'Extension API', noun: 'extension API calls' },
];

export const PARITY_DATE = upstream.parity.date;

export const parityRows = SHOWN.flatMap(({ section, label, noun }) => {
  const row = upstream.parity.sections.find((s) => s.name === section);
  return row ? [{ label, noun, missing: row.missing, complete: row.missing === 0 }] : [];
});

const list = (words: string[], last: string) =>
  words.length < 3 ? words.join(` ${last} `) : `${words.slice(0, -1).join(', ')}, ${last} ${words.at(-1)}`;

/** "pi-rust has all of pi's CLI flags, slash commands, ...", or '' when every row has a gap. */
export const paritySentence = (() => {
  const complete = parityRows.filter((row) => row.complete).map((row) => row.noun);
  return complete.length ? `The latest report shows pi-rust has all of pi's ${list(complete, 'and')}.` : '';
})();
