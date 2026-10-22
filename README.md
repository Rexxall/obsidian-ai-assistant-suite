# AI Assistant Suite

An Obsidian plugin that lets an AI **propose** changes to a note — tags, metadata, structure, the folder it belongs in, furigana for Japanese — while the person decides what is applied.

一个 Obsidian 插件：AI 只负责**提议**（标签、元数据、结构、该放哪个文件夹、日文假名），改不改由人决定。

## The problem / 解决什么问题

My notes grew faster than I could tidy them: inconsistent tags, no summaries, notes in the wrong folder. Doing it by hand was slow; letting an AI rewrite notes directly was risky, because it could silently change what I wrote.

笔记越来越多，标签不统一、没有摘要、放错文件夹。手工整理太慢，直接让 AI 改又怕它悄悄改掉我写的内容。

## Design choices / 设计取舍

| Choice | Why | Cost |
|---|---|---|
| AI results go to a review panel, never straight into the note | The person keeps the final say | One extra click per change |
| Full-document preview is the default view | Comparing changes line by line did not show how the whole note would look | Long notes take more screen space |
| Folder and tag suggestions come as several options | Filing is a judgement call; the AI offers candidates, the person picks | The AI's top choice is not applied automatically |
| Batch results are grouped per note, one note at a time | Batch runs produced many scattered result cards | Reviewing a whole batch still takes time |
| Before writing, the note is compared with the version the AI saw | If the note changed meanwhile, the write stops instead of overwriting new text | The user may need to regenerate |
| Undo / redo for every applied change | Mistakes are cheap to reverse | Snapshots are stored in plugin data |
| Several API configurations with automatic fallback (OpenAI-compatible, DeepSeek, Gemini); the one that answered last is tried first; every request has a timeout | One provider being down or silent should not block the work | The same note may be sent to a second provider; the plugin shows a notice when that happens |

## Install / 安装

1. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/ai-assistant-suite/`.
2. Enable **AI Assistant Suite** in Settings → Community plugins.
3. In the plugin settings, add at least one API configuration (provider, key, model). Keys are stored in this vault's plugin data; do not commit `data.json` to Git.

No build step: `main.js` is the source.

## Two-minute demo / 两分钟演示

Use a test vault, not your daily vault.

1. Open a messy note → command **Run AI Suite: Tag current note**.
2. The suggestions appear in the side panel; accept only some of them.
3. Edit the note, then try to apply an old suggestion → the plugin refuses and asks to regenerate.
4. Undo the last applied change.
5. Run a batch on a folder → review the results note by note.

## Development / 开发

```bash
node --check main.js
for t in *.test.cjs; do node "$t"; done
```

The tests cover guarded writes, partial acceptance, full-document preview, per-note review, DeepSeek requests, request timeouts and fallback order. They run without Obsidian by loading `main.js` in a sandbox with stub classes.

## How it was built / 开发方式

Built with AI coding agents. I wrote the requirements, designed the review workflow, tested each release in my own vault and gave the feedback that led to the full-document preview and per-note review.

由 AI 编码代理写出代码；需求、审阅流程设计、每版测试和改版反馈由我完成。
