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
    fingerprint: string;
    [key: string]: unknown;
}

export interface RollbackSnapshot {
    id: string;
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

/** What a task carries. Each task type fills in its own fields. */
export interface TaskContent {
    file?: TFile;
    demo?: boolean;
    [key: string]: unknown;
}

export interface Task {
    id: string;
    type: string;
    status?: string;
    title?: string;
    content: TaskContent;
}

/** Panel state shared by the side panel and the workbench (both views read and write it). */
export interface AssistantSession {
    tasks: Task[];
    workbenchPage?: string;
    selectedTaskId?: string | null;
    sessionActions?: unknown;
    sessionPreset?: unknown;
    workbenchRunning?: boolean;
    workbenchCancelled?: boolean;
    workbenchOptionsOpen?: boolean;
    pinnedFile?: TFile | null;
    noteApplying?: boolean;
}
