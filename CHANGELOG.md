# Changelog

## 1.6.0 — 2026-10-30

- **Providers:** provider, API URL, model and key are separate fields. Presets for DeepSeek (now the default for new installs), Qwen (Alibaba Cloud Model Studio), SiliconFlow, Kimi and Zhipu GLM fill in the official address and common models; leave the address empty to use it. Older "OpenAI-compatible" configurations that point at one of these hosts are recognised as that preset, with address, model and key unchanged.
- **Test connection:** tells apart a missing key, a rejected key (401/403), no balance or quota, rate limiting, an unknown model name, a wrong address, a timeout or network failure and a provider error, each with one next step and a link to the provider's key page where it helps. The setting says beforehand that one short line is sent and may cost a tiny amount.
- **Diagnostics:** *Copy diagnostics* gives versions, provider, host, model, whether a key is set and the last test result, without the key, the full address or note text. Provider error messages are scrubbed of anything that looks like a key, and raw AI answers are no longer printed to the console.
- **First run:** with no AI connected, the sidebar offers **Load example**: a note marked as a demo with pre-written suggestions that can be ticked, applied and undone without any network. Also available as a command; the demo note can be deleted from its banner.
- **Empty states:** not connected, no note open, working, nothing suggested and failed each say what happened and offer one next step. A failed run shows the kind of failure (for example out of quota) instead of the raw response.
- **Progress and cancel:** one-click runs show "Step n of m" in the notice and the sidebar banner and can be cancelled; after cancelling, the note is untouched and *Generate again* is offered.
- **Shrink warning:** when tidied text is much shorter than the original, the review card and the checklist say how much shorter and ask you to read it through before applying.
- **English interface:** every part of the interface, including errors, notices and empty states, follows Obsidian's language (Chinese, or English for every other language). Prompts sent to the model are unchanged. New installs in English do not translate long tags into Chinese.
- **Settings alignment:** headings, notes, row text and buttons share one left edge, and controls one right edge. The configuration picker and its four buttons are one card, without the extra divider; a custom action's rows no longer sit inside a second padding.
- **Toggles:** the switch thumb sits 2px from every edge when off, on and pressed. Sizes now go through Obsidian's own toggle variables instead of overriding the thumb's position, and pressing stretches the thumb sideways inside the track (from the left edge when off, from the right when on) instead of growing past it. On release it turns round before it slides; with *Reduce motion* there is no animation.
- **README:** English and Chinese versions with new screenshots, a data-flow table (what is sent, to whom, where the key is stored, other devices) and plugin and model costs listed separately.

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
