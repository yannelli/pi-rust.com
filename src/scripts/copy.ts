/**
 * Copy buttons: any element with data-copy copies that text. Code blocks in long-form
 * pages get a copy button added here, so Markdown stays plain.
 */
const announcer = document.createElement('p');
announcer.className = 'sr-only';
announcer.setAttribute('role', 'status');
document.body.append(announcer);

async function copy(button: HTMLElement, text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  const label = button.querySelector('[data-copy-label]');
  const before = label?.textContent;
  button.setAttribute('data-copied', '');
  if (label) label.textContent = 'Copied';
  announcer.textContent = 'Copied to the clipboard';
  window.setTimeout(() => {
    button.removeAttribute('data-copied');
    if (label && before) label.textContent = before;
  }, 1600);
}

document.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('[data-copy]');
  if (button) copy(button, button.dataset.copy ?? '');
});

for (const pre of document.querySelectorAll<HTMLPreElement>('.prose pre')) {
  // The wrapper holds the button still while a long line scrolls the code sideways.
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  // A one-line command may wrap on a phone; a script keeps its lines and scrolls.
  const lines = (pre.querySelector('code')?.innerText ?? pre.innerText).trim().split('\n').length;
  if (lines === 1) wrap.classList.add('code-wrap--one');
  pre.replaceWith(wrap);
  wrap.append(pre);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-code';
  button.setAttribute('aria-label', 'Copy code');
  // Icon only, like the command copy buttons; the label is for screen readers.
  button.innerHTML =
    '<svg class="copy__icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 4.5V4a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2v10a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<svg class="copy__done" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '<span class="sr-only" data-copy-label>Copy code</span>';
  button.addEventListener('click', () => copy(button, pre.querySelector('code')?.innerText ?? pre.innerText));
  wrap.append(button);
}

// Short code in table cells stays on one line; see .code--short.
for (const code of document.querySelectorAll<HTMLElement>('.prose td code')) {
  if ((code.textContent ?? '').length <= 32) code.classList.add('code--short');
}

// Wide tables scroll inside a frame instead of widening the page. A table with three or more
// columns also gets its header text on every cell, so a phone can show each row as a labelled block.
for (const table of document.querySelectorAll<HTMLTableElement>('.prose > table')) {
  const frame = document.createElement('div');
  frame.className = 'table';
  table.replaceWith(frame);
  frame.append(table);
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
  if (headers.length < 3) continue;
  frame.classList.add('table--stack');
  // Explicit roles keep the cells announced as a table when CSS changes their display.
  table.setAttribute('role', 'table');
  table.querySelectorAll('tr').forEach((tr) => tr.setAttribute('role', 'row'));
  table.querySelectorAll('th').forEach((th) => th.setAttribute('role', 'columnheader'));
  table.querySelectorAll('tbody tr').forEach((tr) =>
    tr.querySelectorAll('td').forEach((td, index) => {
      td.setAttribute('role', 'cell');
      td.dataset.label = headers[index] ?? '';
    })
  );
}
