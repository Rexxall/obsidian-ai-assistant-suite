# Changelog

## 1.5.0 — 2026-10-29

- **Local models:** new provider *Local model (Ollama, LM Studio)*. No API key needed; notes never leave the computer. Defaults to Ollama's address.
- **Only existing tags:** a tagger setting that limits suggestions to tags already in the vault. The result is filtered against the vault's tags afterwards, so no new tag slips through even if the model ignores the rule.
- **Batch send summary:** before a batch runs, the plugin says how many notes and how much text will be sent, and to which configuration first and which ones after it if it fails; local models are marked as staying on the computer.
- Every request goes through Obsidian's `requestUrl` (no CORS problems, works on mobile). Answers no longer stream in piece by piece; the result appears when it is complete.
- Settings follow the Obsidian guidelines: native section headings instead of HTML headings, no page title, no inline styles, Obsidian confirmation dialogs instead of the browser's `confirm()`.
- **New look:** an Apple-style glass interface, shared with the author's other plugins. Sidebar, cards and settings are solid grouped lists; the sidebar header and every dialog are glass. Buttons are capsules, the sidebar's two views and the settings pages are segmented controls, the main action sits on the right in the accent colour, destructive buttons only turn their text red. The old cream and sage palette is gone; everything follows the theme's colours and accent, and *Reduce transparency*, *Increase contrast* and *Reduce motion* are respected.
- **Backups need your consent:** each configuration has *Allow as backup* (off by default). When the main service fails, the request goes only to ticked configurations; with none ticked it stops and says which step failed, instead of sending the note to another provider. The batch summary says a local model keeps notes on the computer only when no cloud backup is ticked, and otherwise names the cloud services a note may reach.
- **Review checklist:** after a note's suggestions are ready, a sheet lists tags, each changed property, the folder move and the body text as separate rows with *New / Changed / Move* labels; untick any row and *Apply N items* writes only the rest. Unticking the title also skips renaming the file.
- Sidebar: the file card shows a file icon, the secondary entries (history, batch, custom actions, settings and more) moved into a "…" menu, and the prepare page lists the last few processed notes.
- Commands have plain names without the plugin prefix and follow Obsidian's language (Chinese or English); default hotkeys removed.
- All `innerHTML` replaced with DOM helpers; folder names in two file pickers were inserted without escaping and are now plain text.
- Removed an optional `require('../obsidian-utils/dist')` that looked outside the plugin folder; 78 inline style assignments moved to CSS classes; timers use `window.setTimeout`.
- Source moved to `src/main.js` with ES imports; `npm run build` (esbuild, not minified) produces the release `main.js`, which is no longer committed. Passes the official `eslint-plugin-obsidianmd` rules with no errors; unused code (two old file pickers) removed and English jargon in the Chinese interface (Apply, Fallback, Action, Prompt) replaced.
- Settings: the configuration picker no longer shows blank and the priority no longer reads #0 when the saved active configuration is missing; delete and reorder act on the configuration shown.
- With *Increase contrast*, hints and placeholders are shown at secondary strength.
- Settings use Obsidian's settings pages (1.13): four pages (models, processing, actions and prompts, backup) that show up in settings search.
- Upgrading keeps everything from 1.3.x: one-service settings from before 1.3 become a configuration with the same key and model; all configurations, history, counters and prompts carry over. The old default address and an author-specific ignored folder are gone from the defaults.
- Minimum Obsidian version is now 1.13.0.

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
