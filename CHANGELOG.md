# Changelog

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
