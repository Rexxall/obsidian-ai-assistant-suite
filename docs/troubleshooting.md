Copy the prompt for your problem into your AI coding assistant, replacing `<vault>` with your vault folder.

## Connection test fails or suggestions do not arrive

```text
AI Assistant Suite's connection test fails, or Generate suggestions returns no result. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/ai-assistant-suite/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Check the enabled connection, provider, API URL, model, selected key name and Allow as backup settings. Ask me for the exact error and Copy diagnostics output. Distinguish a missing or rejected key, balance or quota problems, rate limits, an unknown model, a rejected parameter, a wrong URL, a timeout and a provider failure. Keys are in this device's Obsidian Keychain; have me select the key in settings without sharing its value. After switching devices, the key must be selected again. For a local model, ask me whether the server is running on the same computer. Do not inspect that server's files or enable cloud backups without asking me.
To confirm the fix, have me press Test in Settings → AI Assistant Suite → Connections. The address, key/account, model and parameter checks should pass. Then have me generate suggestions for the note I name: suggestions should appear without changing the note. Wait for the complete response; answers do not stream. These checks may use provider credit. If they fail, report the remaining error.
```

## The assistant panel does not open

```text
AI Assistant Suite's anchor icon does not open the assistant panel. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/ai-assistant-suite/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Ask me to confirm that the plugin is enabled and Obsidian is version 1.13 or later. Check manifest.json, main.js and styles.css in the allowed folder, view registration and the startup error I provide. Ask me to try Open assistant panel from the command palette. Do not reset settings, history or the workspace.
To confirm the fix, have me open the panel with the anchor icon and then with Open assistant panel. Both should display the assistant and its controls, or the setup state offering Load example when no AI is connected. Repeat after restarting Obsidian.
```

## Applying suggestions stops with a changed-note or name-conflict message

```text
AI Assistant Suite refuses to apply suggestions because the note changed or a file with the same name already exists. Help me check the cause and restore the review workflow.
You may inspect and change only <vault>/.obsidian/plugins/ai-assistant-suite/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Check the saved proposal, original-content comparison, selected review rows and proposed rename or folder move. Ask me to report any name conflict; do not inspect the conflicting note. A changed note or occupied destination is an intended safeguard. Do not bypass that check or overwrite a file. Have me regenerate suggestions from the current note and untick any conflicting rename or move.
To confirm the workflow, have me generate a fresh preview for the note I name, check one intended change and apply it without editing the note in between. Only that checked change should be written, and unchecked changes should remain unapplied. I will perform the note-changing steps myself. If it still refuses, report the exact remaining error.
```

## Undo refuses to restore a note

```text
AI Assistant Suite refuses to undo an applied change. Help me check why without losing later edits.
You may inspect and change only <vault>/.obsidian/plugins/ai-assistant-suite/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Check the plugin's undo snapshot, whether it has expired or was already used, and the comparison with the applied content. Read the note I name only if needed. Ask me whether I edited the note afterwards or whether a file now occupies its original location. Do not inspect that other file, reset history, remove snapshots or force an older snapshot over newer text. Explain when undo is correctly blocked.
If the snapshot is valid and the note has no later edits or path conflict, have me run Undo this note and confirm that the pre-apply text and path return. I will perform this operation myself. If the snapshot is missing or conflicts with later edits, stop and report that safe undo is unavailable; confirm that the current note is unchanged. Do not report that as a successful undo.
```

[Open an issue](https://github.com/Rexxall/obsidian-ai-assistant-suite/issues/new/choose).
