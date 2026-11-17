// Shapes shared by the plugin, its views and its modals. Saved settings come back from disk as
// whatever an older version wrote, so loaders still check them; these types describe the shape
// after normalizeSettings() has run.
import type { TFile } from 'obsidian';
import type { AiSlot } from './vendor/rex-ai-kit/index';

/** One AI configuration: a kit slot plus the plugin's own switches. */
export interface ApiConfig {
    id: string;
    name: string;
    ai: AiSlot;
    auxiliaryModelName?: string;
    deepseekThinking?: boolean;
    enabled?: boolean;
    allowFallback?: boolean;
    /** Fields from 1.8 and earlier; read once by the migration, then deleted. */
    apiProvider?: string;
    apiKey?: string;
    apiUrl?: string;
    modelName?: string;
    apiKeySecret?: string;
}

export interface HistoryItem {
    fileName: string;
    filePath: string;
    action: string;
    timestamp: number;
    fileId: string;
}

export interface CustomAction {
    id: string;
    name: string;
    prompt: string;
    outputMode: string;
    enabled: boolean;
}

export interface MergeDraftRecord {
    id: string;
    path: string;
    /** mergeDraft.fingerprint() of the draft as created; an edited draft is not undone. */
    hash: string;
    sources: string[];
    at: number;
    [key: string]: unknown;
}

export interface RollbackSnapshot {
    id: string;
    timestamp: number;
    action: string;
    filePath: string;
    fileName: string;
    originalContent: string;
    appliedContent: string;
    /** Set when a note review may also have moved or renamed the note. */
    originalPath?: string;
    [key: string]: unknown;
}

export interface OneClickActions {
    structurizer: boolean;
    furigana: boolean;
    meta: boolean;
    tagger: boolean;
    mover: boolean;
}

export interface Settings {
    activeConfigId: string;
    apiConfigs: ApiConfig[];
    modelCache: unknown;
    structurizerPrompt: string;
    moverSuggestionsCount: number;
    ignoredFolders: string;
    moverExistingOnly: boolean;
    moverPrompt: string;
    taggerSuggestionsCount: number;
    taggerExistingOnly: boolean;
    taggerAllowedRoots: string;
    taggerDropParentTags: boolean;
    taggerEnableTranslation: boolean;
    taggerTranslationTargetLanguage: string;
    taggerTranslationMinLength: number;
    taggerPrompt: string;
    processingHistory: HistoryItem[];
    translationPrompt: string;
    totalProcessedCount: number;
    actionUsageCounts: Record<string, number>;
    dailyProcessedCounts: Record<string, number>;
    metaFileNameMaxLength: number;
    metaRenameDefault: boolean;
    metaFieldDefaults: string;
    metaFieldDefaultsFolders: string;
    metaPrompt: string;
    vaultConventions: string;
    structurizerMarks: string;
    structurizerMaxCards: number;
    structurizerCondense: boolean;
    serifNumbers: boolean;
    look: string;
    styleSubtitleClass: string;
    styleCardClass: string;
    styleCardFolders: string;
    styleAgedRules: string;
    furiganaPrompt: string;
    oneClickProcessActions: OneClickActions;
    rollbackHistory: RollbackSnapshot[];
    rollbackRedoHistory: RollbackSnapshot[];
    customActions: CustomAction[];
    mergeDrafts: MergeDraftRecord[];
    /** Sidebar switches with no default: unset reads as on. */
    sidebarCompact?: boolean;
    sidebarAutoNext?: boolean;
    /** Set once the user has answered the 1.6 question about backup services. */
    backupReviewed?: boolean;
}

/** Settings as loaded from disk, before migration: legacy top-level fields may still be there. */
export type StoredSettings = Settings & Partial<Record<'apiProvider' | 'apiKey' | 'apiUrl' | 'modelName' | 'auxiliaryModelName', unknown>>;

export interface TagSuggestion {
    display: string;
    final: string;
    is_new: boolean;
}

export interface FolderSuggestion {
    path: string;
    is_new: boolean;
}

/** Title, summary and one-line summary the AI proposes for a note. */
export interface NoteMeta {
    title?: string;
    summary?: string;
    tldr?: string;
}

/** What a one-click run proposes. Lists are null when the AI had nothing to suggest. */
export interface NoteSuggestions {
    meta?: NoteMeta;
    tags?: TagSuggestion[] | null;
    mover?: FolderSuggestion[] | null;
}

/** One changed region of a text suggestion; line numbers count from 0. */
export interface ReviewHunk {
    id: number;
    start: number;
    end: number;
    before: string;
    after: string;
    atomic?: boolean;
}

/** What the notebook tidy changed: reworded sentences, cards placed, repeated property lines dropped. */
export interface NotebookStats {
    changed: number;
    cards: number;
    dupLines: number;
    /** Marks taken out because they are not in the list (or were made up). */
    removed: number;
}

/** A style class the panel offers to add (subtitle, card, aged paper). */
export interface StyleProposal {
    key: string;
    cls: string;
    text?: string;
    folder?: string;
    days?: number | null;
    remove?: string[];
}

/** The parts of a note the panel confirms one by one. */
export interface NoteParts {
    meta?: boolean;
    defaults?: [string, unknown][];
    tags?: boolean;
    folder?: boolean;
    style?: StyleProposal[];
    body?: boolean;
}

/** What the user chose for one note in the panel, kept on the newest task of that note. */
export interface NoteDraft {
    signature: string;
    meta: NoteMeta;
    tags: string[];
    folder: string;
    useMeta: boolean;
    useTags: boolean;
    useFolder: boolean;
    rename: boolean;
    diffId: string;
    originalTaskId?: string;
    originalPath: string;
    applied: string[];
    skipped: string[];
    style?: Record<string, boolean>;
    styleList?: StyleProposal[];
    snapshotId?: string;
    skipMeta?: string[];
    /** Whether to fill in the field defaults; unset follows useMeta unless skipDefaults. */
    useDefaults?: boolean;
    skipDefaults?: boolean;
}

/** What a task carries. Each task type fills in its own fields. */
export interface TaskContent {
    file?: TFile;
    demo?: boolean;
    /** One-click tasks carry NoteSuggestions; mover tasks a FolderSuggestion list; tagger tasks a TagSuggestion list. */
    suggestions?: NoteSuggestions | TagSuggestion[] | FolderSuggestion[];
    noteDraft?: NoteDraft;
    noteApplied?: boolean;
    noteSnapshotId?: string;
    originalContent?: string;
    proposedContent?: string;
    reviewHunks?: ReviewHunk[];
    reviewSelected?: number[];
    reviewMode?: string;
    articleSource?: string;
    applied?: boolean;
    applying?: boolean;
    notebook?: NotebookStats | null;
    action?: string;
    message?: string;
    type?: string;
    result?: string;
    streamingContent?: string;
    title?: string;
    summary?: string;
    tldr?: string;
    canInterrupt?: boolean;
    processedCount?: number;
    totalFiles?: number;
    currentFile?: string;
    folderPath?: string;
    fileCount?: number;
    files?: TFile[];
    [key: string]: unknown;
}

/** One note in the panel and its tasks, oldest first. */
export interface NoteGroup {
    file: TFile;
    tasks: Task[];
}

export interface Task {
    id: string;
    type: string;
    status?: string;
    title?: string;
    message?: string;
    streamingContent?: string;
    canClose?: boolean;
    content: TaskContent;
}

/** Panel state shared by the side panel and the workbench (both views read and write it). */
export interface AssistantSession {
    tasks: Task[];
    workbenchPage?: string;
    selectedTaskId?: string | null;
    sessionActions?: Partial<OneClickActions> | null;
    sessionPreset?: unknown;
    workbenchRunning?: boolean;
    workbenchCancelled?: boolean;
    workbenchOptionsOpen?: boolean;
    pinnedFile?: TFile | null;
    noteApplying?: boolean;
}

declare module 'obsidian' {
    interface App {
        /** Obsidian's settings window. Not in the public typings, but stable across versions. */
        setting: { open(): void; openTabById(id: string): void };
    }
    interface MetadataCache {
        /** Every tag in the vault with its use count, keys with the leading '#'. Not in the public typings. */
        getTags(): Record<string, number>;
    }
}
