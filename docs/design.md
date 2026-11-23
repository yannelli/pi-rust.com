# Design

- [Introduction](#introduction)
- [Color](#color)
- [Type](#type)
- [Motion](#motion)
- [Components](#components)
- [Docs Pages](#docs-pages)
- [Writing](#writing)

## Introduction

These are the rules every page follows, so that a new page matches the rest. The styles are plain CSS: `src/styles/global.css` for the site, `src/styles/account.css` for the account pages, and `src/styles/admin.css` for the admin area.

## Color

The interface is monochrome. The tokens are in `src/styles/global.css`:

| Token | Light | Use |
| --- | --- | --- |
| `--paper` | `#fafafa` | Page background |
| `--ink` | `#171717` | Text and primary buttons |
| `--graphite` | `#4d4d4d` | Secondary text |
| `--hairline` | `#ebebeb` | Borders |

Dark mode follows the system setting, with its own values for each token.

Rust `#de5e28`, oxide `#a33b1a`, and amber `#e6984f` are the three pieces of the pi-rust mark. They appear only where pi-rust itself does: the mark, its bar in the benchmark chart, and text selection. On the account and admin pages, red marks errors and states that stop something, such as a suspended account, and nothing else.

## Type

Geist for all text. Geist Mono only for commands, code, and values such as versions and IDs.

## Motion

One animation runs without input: the pieces of the home page mark drop into place on load (`src/components/Mark.astro`). With reduced motion, the mark shows assembled.

## Components

- **Buttons** are pills. A primary button is ink; a secondary one is a ringed surface. A form or dialog has one primary action.
- **Cards** are surfaces with a hairline border and rounded corners. Lists inside them separate rows with hairlines.
- **Status pills** always say the state in words; their tint only supports the words.
- **Dialogs** confirm destructive actions, and name what they change.

## Docs Pages

Docs pages have section navigation, a breadcrumb, an "On this page" list that marks the current section, copy buttons on code blocks, previous and next links, and a link to the source file at the release tag.

Search opens with `/`, Ctrl+K, or ⌘K. It runs on a [Pagefind](https://pagefind.app) index built with the site.

## Writing

- Plain words and short sentences, in sentence case.
- No hype words ("blazing", "seamless", "powerful") and no all-caps labels.
- No "→" in link text.
- Every claim about pi-rust comes from the synced docs; see [Content and Releases](content.md#hand-written-copy).
