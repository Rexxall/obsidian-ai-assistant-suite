# AI Assistant Suite

**An AI that proposes; a person who decides.**

An Obsidian plugin that lets an AI suggest changes to a note — tags, properties, structure, the folder it belongs in, furigana for Japanese — and shows them for review. Nothing is written until you accept it.

一个 Obsidian 插件：AI 只负责**提议**（标签、属性、结构、该放哪个文件夹、日文假名），改不改由人决定。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/review-dark.jpg">
  <img src="docs/screenshots/review.jpg" width="860">
</picture>

## The problem

My notes grew faster than I could tidy them: inconsistent tags, no summaries, notes in the wrong folder. Doing it by hand was slow; letting an AI rewrite notes directly was risky, because it could silently change what I wrote.

笔记越来越多，标签不统一、没有摘要、放错文件夹。手工整理太慢，直接让 AI 改又怕它悄悄改掉我写的内容。

## How it works

1. Open a note, open the assistant in the right sidebar, choose what you want done: tidy the structure, add properties, suggest tags, suggest a folder, add furigana, or a custom action.
2. The AI returns one proposal for this note. You see the **whole note as it would look**, can switch to a change-by-change view, and untick anything you do not want.
3. **Apply** writes only what you kept. If the note changed while you were reviewing, the write stops and asks you to regenerate. Every applied change can be undone.
4. For a folder, run a batch: results are reviewed **one note at a time**, then the next.

## Design choices

| Choice | Why | Cost |
|---|---|---|
| AI results go to a review panel, never straight into the note | The person keeps the final say | One extra click per change |
| Full-document preview is the default view | Comparing changes line by line did not show how the whole note would look | Long notes take more screen space |
| Folder and tag suggestions come as several options | Filing is a judgement call; the AI offers candidates, the person picks | The AI's top choice is not applied automatically |
| Batch results are grouped per note, one note at a time | Batch runs produced many scattered result cards | Reviewing a whole batch still takes time |
| Before writing, the note is compared with the version the AI saw | If the note changed meanwhile, the write stops instead of overwriting new text | The user may need to regenerate |
| Undo / redo for every applied change | Mistakes are cheap to reverse | Snapshots are stored in plugin data |
| Several API configurations with automatic fallback; the one that answered last is tried first; every request has a timeout | One provider being down or silent should not block the work | The same note may be sent to a second provider; the plugin shows a notice when that happens |

## Install

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/ai-assistant-suite/`.
2. Enable **AI Assistant Suite** in *Settings → Community plugins*.
3. In the plugin settings, add at least one API configuration: provider (OpenAI-compatible, DeepSeek or Gemini), key, model. Test the connection from the settings page.

Works on desktop and mobile. No build step: `main.js` is the source.

## Two-minute demo

Use a test vault, not your daily vault.

1. Open a messy note → in the sidebar choose **Suggest tags** and **Add properties** → **Generate**.
2. The proposal appears as a full-note preview; untick one suggestion and apply the rest.
3. Edit the note, then try to apply the old proposal again → the plugin refuses and asks you to regenerate.
4. Undo the last applied change.
5. Run a batch on a folder → review the results note by note.

## Privacy

| What | Where it goes |
|---|---|
| Note text you ask the AI about | Sent to the API provider you configured, and only when you press Generate |
| API keys | Stored in this vault's plugin data (`data.json`), obfuscated, never sent anywhere except the provider they belong to |
| Proposals, undo snapshots, processing history | This vault's plugin data |
| Anything else | Nothing is sent; there is no telemetry |

Do not commit `data.json` to Git.

## Limits

- Suggestions are only as good as the model and the prompt; review them.
- Batch runs send one request per note; large folders cost accordingly.
- The key obfuscation in `data.json` protects against casual reading, not against someone with access to the file.
- Interface text is Chinese.

## Development

```bash
node --check main.js
for t in *.test.cjs; do node "$t"; done
```

The tests cover guarded writes, partial acceptance, full-document preview, per-note review, DeepSeek requests, request timeouts and fallback order. They run without Obsidian by loading `main.js` in a sandbox with stub classes. Design notes are in [docs/](docs/); versions are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
