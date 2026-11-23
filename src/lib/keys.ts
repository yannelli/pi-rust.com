/**
 * Keyboard keys in rendered markdown become <kbd> elements (.kbd, and .kbd-group for a
 * combination). The docs write keys as plain text, such as
 * "press Ctrl+Enter" or "| Tab, Shift+Tab |", so this runs on the built HTML and leaves
 * code, links, headings, and bold UI labels alone.
 */
const MODIFIERS = 'Ctrl|Alt|Shift|Cmd|Option|Meta|Super';
const NAMED = 'Page Up|Page Down|PageUp|PageDown|Enter|Tab|Space|Backspace|Delete|Home|End|Up|Down|Left|Right|Escape|Esc|Insert|F\\d{1,2}';
const COMBO = `(?:${MODIFIERS})(?:\\+(?:${MODIFIERS}))*\\+(?:${NAMED}|[A-Z0-9])`;
/** Words that are keys only mid-sentence or in a table's first column, so "Enter a name" stays a word. */
const AMBIGUOUS = 'Page Up|Page Down|Enter|Tab|Space|Backspace|Up|Down|Left|Right';
const PATTERN = new RegExp(`(?<![\\w+])(?:(${COMBO})|(Escape|Esc)|(${AMBIGUOUS}))(?![\\w+])`, 'g');

/** No keys inside these elements. */
const SKIP = new Set(['pre', 'code', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'kbd', 'script', 'style', 'svg', 'title']);
/** A sentence starts again at these elements. */
const BLOCKS = new Set(['p', 'li', 'td', 'th', 'dt', 'dd', 'div', 'blockquote', 'ul', 'ol', 'tr', 'table', 'br']);

const key = (name: string) => `<kbd class="kbd">${name}</kbd>`;

function kbd(match: string): string {
  const parts = match.split('+');
  return parts.length === 1 ? key(match) : `<kbd class="kbd-group">${parts.map(key).join('<span>+</span>')}</kbd>`;
}

export function withKeys(html: string): string {
  let skip = 0;
  let cell = 0;
  // The visible text of the current block so far, to tell a sentence start from mid-sentence.
  let block = '';
  return html
    .split(/(<[^>]+>)/)
    .map((token) => {
      const tag = token.match(/^<(\/?)([a-zA-Z][\w-]*)/);
      if (tag) {
        const [, closing, rawName] = tag;
        const name = rawName.toLowerCase();
        if (SKIP.has(name) && !token.endsWith('/>')) skip += closing ? -1 : 1;
        if (name === 'tr' && !closing) cell = 0;
        if ((name === 'td' || name === 'th') && !closing) cell += 1;
        if (BLOCKS.has(name)) block = '';
        return token;
      }
      if (skip > 0 || !token) {
        block += token;
        return token;
      }
      const out = token.replace(PATTERN, (match, combo, escape, word, offset: number) => {
        if (word) {
          const before = (block + token.slice(0, offset)).trimEnd();
          const sentenceStart = before === '' || /[.!?:]$/.test(before);
          if (sentenceStart && cell !== 1) return match;
        }
        return kbd(match);
      });
      block += token;
      return out;
    })
    .join('');
}
