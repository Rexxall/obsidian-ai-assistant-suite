# Changelog

## 1.5.0 — 2026-10-29

- **Local models:** new provider *Local model (Ollama, LM Studio)*. No API key needed; notes never leave the computer. Defaults to Ollama's address.
- **Only existing tags:** a tagger setting that limits suggestions to tags already in the vault. The result is filtered against the vault's tags afterwards, so no new tag slips through even if the model ignores the rule.
- **Batch send summary:** before a batch runs, the plugin says how many notes and how much text will be sent, and to which configuration first and which ones after it if it fails; local models are marked as staying on the computer.
- Requests go through Obsidian's `requestUrl` (no CORS problems, works on mobile). Streaming still needs `fetch`; if a provider blocks it, the plugin retries once without streaming.
- Settings follow the Obsidian guidelines: native section headings instead of HTML headings, no page title, no inline styles, Obsidian confirmation dialogs instead of the browser's `confirm()`; the settings page now uses your theme's colours. The sidebar's own palette can be turned off (*Morning palette*).
- Commands have plain names without the plugin prefix and follow Obsidian's language (Chinese or English); default hotkeys removed.
- All `innerHTML` replaced with DOM helpers; folder names in two file pickers were inserted without escaping and are now plain text.
- Removed an optional `require('../obsidian-utils/dist')` that looked outside the plugin folder; 78 inline style assignments moved to CSS classes; timers use `window.setTimeout`.
- Minimum Obsidian version is now 1.8.7.

## 1.4.0 — 2026-10-25

- New sidebar: choose what to do for the current note, then review one proposal as a full-note preview with change-by-change toggles.
- Batch results are reviewed one note at a time.
- Every AI request has a timeout; after a provider fails, the one that answered last is tried first next time.
- Removed debug output; processing history is stored in plugin data only.
- README, LICENSE and changelog for the first public release; design notes moved to `docs/`.

## 1.3.7 — 2026-09-19

- Clear current-note, start and review areas in the sidebar; connection and usage details folded away.
- Apply, undo and redo compare the note's current content first and stop if it changed.
- HTML escaping for file names, folders and prompt previews.

## 1.3.6

- File-selection dialog redesigned; prompt editor with Markdown preview; processing history kept in plugin data.
