import { Notice, ItemView, MarkdownRenderer, Menu, setIcon } from 'obsidian';
import type { App, EventRef, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { ASSISTANT_VIEW_TYPE, ASSISTANT_WORKBENCH_TYPE, GlassFuzzySuggestModal, GlassModal, confirmAction, isChineseInterface, tr } from './shared';
import { AiAssistantSettingTab } from './settings-tab';
import { BatchProcessingModal, FolderSelectionModal } from './file-modals';
import type AiAssistantSuite from './main';
import type { AssistantSession, FolderSuggestion, HistoryItem, NoteDraft, NoteGroup, NoteMeta, NoteParts, NoteSuggestions, OneClickActions, StyleProposal, TagSuggestion, Task } from './types';

type SessionKey = keyof AssistantSession;
type NoteStatus = '已确认' | '需重试' | '待确认';
type MenuEntry = [string, () => unknown, string];
/** A row's edit area in the note review, plus the "leave this out" button that closes it. */
interface RowPanel { panel: HTMLElement; tail: () => void }

// Errors reach these handlers from the vault and the AI client, which always throw Error objects.
const messageOf = (error: unknown): string => (error as Error).message;

/** String(value) for a value read from YAML, whatever it turned out to be. */
const yamlText = (value: unknown): string => String(value);

// One-click tasks carry their suggestions as an object; mover and tagger tasks carry a list.
function noteSuggestionsOf(task: Task | undefined): NoteSuggestions | undefined {
    const suggestions = task?.content.suggestions;
    return suggestions && !Array.isArray(suggestions) ? suggestions : undefined;
}

// Older one-click runs may have stored a tag as a bare string.
function tagValue(tag: TagSuggestion | string): string {
    return typeof tag === 'string' ? tag : tag.final || tag.display;
}

// Folders are the vault entries with children (checked the same way the code always has, without instanceof).
function isFolder(file: TAbstractFile | null): file is TFolder {
    const folder: Partial<TFolder> | null = file;
    return !!folder?.children;
}

// Paths handed here always point at notes (history entries, a note just moved); the vault returns the base type.
function noteAt(app: App, path: string): TFile | null {
    return app.vault.getAbstractFileByPath(path) as TFile | null;
}

export class AssistantNotePreview extends ItemView {
    declare plugin: AiAssistantSuite;
    constructor(leaf: WorkspaceLeaf,plugin: AiAssistantSuite){super(leaf);this.plugin=plugin;}
    getViewType(){return 'ai-assistant-note-preview';}
    getDisplayText(){return tr('笔记整文预览', 'Whole-note preview');}
    getIcon(){return 'file-check';}
    async onOpen(){this.contentEl.createEl('p',{text:tr('在笔记助手中选择正文建议。', 'Choose a text suggestion in the note assistant.')});}
    async showTask(task: Task){
        this.contentEl.empty();
        this.contentEl.addClass('ap', 'sn-document-preview');
        this.contentEl.createEl('p',{text:tr('整文预览 · 原笔记尚未修改', 'Whole-note preview · the note is not changed yet'),cls:'sn-muted'});
        this.contentEl.createEl('h2',{text:task.content.file!.basename});
        const body=this.contentEl.createDiv({cls:'markdown-rendered'});
        const c=task.content,h=c.reviewHunks||this.plugin.buildReviewHunks(c.originalContent!,c.proposedContent!);
        const text=this.plugin.composeReviewContent(c.originalContent!,h,c.reviewSelected||h.map(v=>v.id)).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
        await MarkdownRenderer.render(this.app,text,body,task.content.file!.path,this);
    }
}

export class AssistantView extends ItemView {
    declare plugin: AiAssistantSuite;
    declare expanded: boolean;
    // Accessors over plugin.assistantSession, installed in the constructor so both views share one state.
    declare tasks: Task[];
    declare workbenchPage: string | undefined;
    declare selectedTaskId: string | null | undefined;
    declare sessionActions: Partial<OneClickActions> | null | undefined;
    declare sessionPreset: unknown;
    declare workbenchRunning: boolean | undefined;
    declare workbenchCancelled: boolean | undefined;
    declare workbenchOptionsOpen: boolean | undefined;
    declare pinnedFile: TFile | null | undefined;
    declare noteApplying: boolean | undefined;
    declare currentFile: TFile | null;
    declare fileWatcherRef: EventRef | null | undefined;
    declare refreshTimeout: number | undefined;
    declare documentRenderVersion: number | undefined;
    declare queueSelection: Set<string> | undefined;
    declare sessionCondense: boolean | undefined;
    declare sessionInstruction: string | undefined;
    declare openPart: { path: string; key: string } | null | undefined;
    declare batchProcessInterrupted: boolean | undefined;

    constructor(leaf: WorkspaceLeaf, plugin: AiAssistantSuite, expanded = false) {
        super(leaf);
        this.plugin = plugin;
        this.expanded = expanded;
        plugin.view = this;
        plugin.assistantSession ||= { tasks: [] };
        for (const key of ['tasks','workbenchPage','selectedTaskId','sessionActions','sessionPreset','workbenchRunning','workbenchCancelled','workbenchOptionsOpen','pinnedFile','noteApplying'] satisfies SessionKey[]) {
            Object.defineProperty(this, key, { get: () => plugin.assistantSession![key], set: (value: unknown) => { const session: Partial<Record<SessionKey, unknown>> = plugin.assistantSession!; session[key] = value; }, configurable: true });
        }
        this.currentFile = null; // 跟踪当前文件
        this.setupFileWatcher(); // 设置文件监听
    }

    getViewType() { return this.expanded ? ASSISTANT_WORKBENCH_TYPE : ASSISTANT_VIEW_TYPE; }
    getDisplayText() { return this.expanded ? tr("笔记工作台", 'Note workbench') : tr("笔记助手", 'Note assistant'); }
    getIcon() { return "anchor"; }

    async onOpen() {
        if (!this.fileWatcherRef) this.setupFileWatcher();
        this.render();
        this.contentEl?.addClass('ai-assistant-u-scroll-y');
    }

    async onClose() {
        this.documentRenderVersion = (this.documentRenderVersion || 0) + 1;
        if (this.plugin.view === this) {
            const otherType = this.expanded ? ASSISTANT_VIEW_TYPE : ASSISTANT_WORKBENCH_TYPE;
            // Leaves of the two assistant types only ever hold an AssistantView.
            this.plugin.view = (this.plugin.app.workspace.getLeavesOfType(otherType)[0]?.view as AssistantView | undefined) || null;
        }
        // 清理文件监听
        if (this.refreshTimeout) window.clearTimeout(this.refreshTimeout);
        if (this.fileWatcherRef) {
            this.plugin.app.workspace.offref(this.fileWatcherRef);
            this.fileWatcherRef = null;
        }
    }

    // 设置文件监听器
    setupFileWatcher() {
        this.fileWatcherRef = this.plugin.app.workspace.on('active-leaf-change', () => {
            const newFile = this.plugin.app.workspace.getActiveFile();
            if (newFile !== this.currentFile) {
                this.currentFile = newFile;
                if (newFile?.extension === 'md') { this.pinnedFile = null; this.plugin.assistantLastFile = newFile; }
                // 延迟刷新以避免频繁更新
                if (this.refreshTimeout) {
                    window.clearTimeout(this.refreshTimeout);
                }
                this.refreshTimeout = window.setTimeout(() => {
                    this.render();
                }, 300);
            }
        });
    }

    clear() {
        this.tasks = [];
        this.render();
        this.plugin.refreshAssistantViews?.(this);
    }

    addTask(task: Task) {
        this.tasks.push(task);
        this.selectedTaskId = task.id;
        this.workbenchPage = this.tasks.some(t=>t.type==='batch-process'&&t.content?.canInterrupt) ? 'queue' : 'review';
        this.render();
        this.plugin.refreshAssistantViews?.(this);
    }

    updateTask(taskId: string, newProps: Partial<Task>) {
        const taskIndex = this.tasks.findIndex(t => t.id === taskId);
        if (taskIndex > -1) {
            this.tasks[taskIndex] = { ...this.tasks[taskIndex], ...newProps };
            this.render();
            this.plugin.refreshAssistantViews?.(this);
        }
    }

    getTask(taskId: string) {
        return this.tasks.find(task => task.id === taskId);
    }

    removeTask(taskId: string) {
        this.tasks = this.tasks.filter(t => t.id !== taskId);
        this.render();
        this.plugin.refreshAssistantViews?.(this);
    }

    render() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('mist-sidebar-host');
        const root = container.createDiv({ cls: 'ap ap-view mist-sidebar' });
        if (this.plugin.settings.sidebarCompact !== false) root.addClass('mist-compact');
        // Signature layer (shared with the other plugins): one serif number, and the optional journal look.
        const journal = this.plugin.settings.look === 'journal';
        root.toggleClass('ap-signed', this.plugin.settings.serifNumbers !== false);
        root.toggleClass('ap-look-journal', journal);
        container.toggleClass('is-journal', journal);
        const page = this.workbenchPage || 'prepare';
        const activeNote = this.plugin.app.workspace.getActiveFile();
        if (activeNote?.extension === 'md') this.plugin.assistantLastFile = activeNote;
        const file = this.pinnedFile || (activeNote?.extension === 'md' ? activeNote : activeNote ? null : this.plugin.assistantLastFile || null);
        const busy = !!this.workbenchRunning || this.tasks.some(t => t.status === 'loading');
        const groups = this.getNoteGroups();

        const head = root.createDiv({ cls: 'mist-head' });
        const headMain = head.createDiv({ cls: 'mist-head-main' });
        headMain.createDiv({ cls: 'ap-fig', text: `FIG. AAS · ${String(groups.length).padStart(2, '0')}` });
        headMain.createEl('h3', { text: tr('笔记助手', 'Note assistant'), cls: 'mist-title ap-title' });
        const more = head.createEl('button', { cls: 'clickable-icon mist-more', attr: { 'aria-label': tr('更多', 'More'), 'aria-haspopup': 'menu' } });
        setIcon?.(more, 'ellipsis');
        more.onclick = event => this.openMistMenu(event);

        // Only two places in daily use: choosing what to do, and reviewing what the AI proposed.
        const pending = groups.filter(g => this.noteStatus(g) === '待确认').length;
        const views = root.createEl('nav', { cls: 'mist-views', attr: { 'aria-label': tr('笔记助手视图', 'Note assistant views') } });
        for (const [id, label] of [['prepare', tr('整理', 'Tidy')], ['review', pending ? tr(`本篇建议 · ${pending}`, `This note · ${pending}`) : tr('本篇建议', 'This note')]]) {
            const button = views.createEl('button', { text: label, cls: 'mist-view', attr: { 'aria-current': page === id ? 'page' : 'false' } });
            button.onclick = () => { this.workbenchPage = id; this.render(); this.plugin.refreshAssistantViews?.(this); };
        }

        const body = root.createDiv({ cls: 'mist-body' });
        if (!['prepare', 'review'].includes(page)) {
            body.createEl('button', { text: tr('← 回到整理', '← Back to Tidy'), cls: 'mist-back' }).onclick = () => { this.workbenchPage = 'prepare'; this.render(); };
        }
        if (page === 'settings') {
            const settings = new AiAssistantSettingTab(this.plugin.app, this.plugin);
            settings.containerEl = body.createDiv({ cls: 'mist-settings' });
            settings.display();
            return;
        }
        if (page === 'queue') { this.renderNoteQueue(body); return; }
        if (page === 'history') {
            const history = body.createDiv({ cls: 'mist-history' });
            const actions = history.createDiv({ cls: 'mist-links' });
            actions.createEl('button', { text: tr('回滚上次修改', 'Undo last change'), cls: 'mist-link' }).onclick = () => this.plugin.rollbackLastChange();
            actions.createEl('button', { text: tr('重新应用刚才的回滚', 'Redo the undone change'), cls: 'mist-link' }).onclick = () => this.plugin.redoLastRollback();
            if (!this.plugin.getRecentHistory().length) this.renderMistEmpty(history, tr('还没有处理记录', 'No history yet'), tr('完成一次整理后，可以在这里找回笔记。', 'After your first run you can find notes here again.'));
            else this.renderRecentHistory(history);
            return;
        }
        if (page === 'tools') {
            const tools = body.createDiv({ cls: 'mist-tools' });
            this.renderQuickActions(tools);
            const diagnostics = tools.createEl('details', { cls: 'ai-assistant-diagnostics' });
            diagnostics.createEl('summary', { text: tr('使用情况与连接信息', 'Usage and connection') });
            this.renderUsageStats(diagnostics); this.renderFileInfo(diagnostics); this.renderAIStatus(diagnostics);
            return;
        }
        if (page === 'review') { this.renderMistReview(body, file, groups); return; }
        this.renderMistPrepare(body, file, busy);
    }

    mistSecondaryEntries(): MenuEntry[] {
        return [
            [tr('处理记录', 'History'), () => { this.workbenchPage = 'history'; this.render(); }, 'history'],
            [tr('批量整理', 'Batch tidy'), () => this.showBatchProcessingModal(), 'files'],
            [tr('任务列表', 'Task list'), () => { this.workbenchPage = 'queue'; this.render(); }, 'list-checks'],
            [tr('自定义动作', 'Custom actions'), () => this.showAtelierCustomActions(), 'wand-sparkles'],
            [tr('合并两篇笔记', 'Merge two notes'), () => this.plugin.startMergeDraft(this.pinnedFile || this.plugin.app.workspace.getActiveFile()), 'git-merge'],
            [tr('其他工具', 'Other tools'), () => { this.workbenchPage = 'tools'; this.render(); }, 'wrench'],
            [tr('设置', 'Settings'), () => { this.plugin.app.setting.open(); this.plugin.app.setting.openTabById(this.plugin.manifest.id); }, 'settings']
        ];
    }

    openMistMenu(event: MouseEvent) {
        const menu = new Menu();
        const entries = this.mistSecondaryEntries();
        entries.forEach(([label, action, icon], index) => {
            if (index === entries.length - 1) menu.addSeparator();
            menu.addItem(item => item.setTitle(label).setIcon(icon).onClick(action));
        });
        menu.showAtMouseEvent(event);
    }

    // 整理页下半部分：最近处理过的几篇，点一下打开
    renderMistRecent(container: HTMLElement) {
        const recent = this.plugin.getRecentHistory()
            .map(item => ({ item, file: this.findFileByHistory(item) }))
            .filter((entry): entry is { item: HistoryItem; file: TFile } => !!entry.file)
            .filter((entry, index, all) => all.findIndex(other => other.file === entry.file) === index)
            .slice(0, 5);
        if (!recent.length) return;
        const section = container.createDiv({ cls: 'mist-recent' });
        const label = section.createDiv({ cls: 'mist-recent-head' });
        label.createSpan({ text: tr('最近处理', 'Recent'), cls: 'mist-label' });
        label.createEl('button', { text: tr('全部', 'All'), cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'history'; this.render(); };
        const list = section.createDiv({ cls: 'mist-recent-list' });
        for (const { item, file } of recent) {
            const row = list.createEl('button', { cls: 'mist-recent-row', attr: { 'aria-label': tr(`打开 ${file.basename}`, `Open ${file.basename}`) } });
            setIcon?.(row.createSpan({ cls: 'mist-recent-icon', attr: { 'aria-hidden': 'true' } }), 'file-text');
            const copy = row.createSpan({ cls: 'mist-recent-copy' });
            copy.createSpan({ text: file.basename, cls: 'mist-recent-name' });
            copy.createSpan({ text: tr(`${item.action || '整理'} · ${this.mistTimeLabel(item.timestamp)}`, `${item.action || 'Tidy'} · ${this.mistTimeLabel(item.timestamp)}`), cls: 'mist-recent-meta' });
            row.onclick = () => this.plugin.app.workspace.getLeaf(false).openFile(file);
        }
    }

    mistTimeLabel(timestamp: number) {
        const when = new Date(timestamp || Date.now());
        const now = new Date();
        const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
        if (when.toDateString() === now.toDateString()) return tr(`今天 ${time}`, `Today ${time}`);
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        if (when.toDateString() === yesterday.toDateString()) return tr(`昨天 ${time}`, `Yesterday ${time}`);
        return tr(`${when.getMonth() + 1}月${when.getDate()}日`, `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
    }

    afterNoteApplied(group: NoteGroup) {
        if (this.plugin.settings.sidebarAutoNext === false) return;
        const next = this.getNoteGroups().find(g => g.file !== group.file && this.noteStatus(g) === '待确认');
        if (next) this.selectedTaskId = next.tasks.at(-1)!.id;
    }

    getNoteGroups() {
        const groups = new Map<string, NoteGroup>();
        for (const task of this.tasks) {
            const file = task.content?.file;
            if (!file || !['one-click','diff-preview','error'].includes(task.type)) continue;
            const key = file.path;
            if (!groups.has(key)) groups.set(key, { file, tasks: [] });
            groups.get(key)!.tasks.push(task);
        }
        return [...groups.values()].map(group=>{const last=group.tasks.findLastIndex(t=>!!t.content.noteApplied);if(last>=0&&last<group.tasks.length-1)group.tasks=group.tasks.slice(last+1);return group;});
    }

    noteDraft(group: NoteGroup): NoteDraft {
        const latest = group.tasks.filter(t => t.type === 'one-click').at(-1);
        const anchor = (latest || group.tasks.at(-1))!;
        const suggestions: NoteSuggestions = noteSuggestionsOf(latest) || {};
        const diffs = group.tasks.filter(t => t.type === 'diff-preview' && !t.content.applied && !t.content.noteApplied);
        const signature = group.tasks.map(t => t.id).join('|');
        if (!anchor.content.noteDraft || anchor.content.noteDraft.signature !== signature) {
            anchor.content.noteDraft = { signature, meta: { ...suggestions.meta },
                tags: (suggestions.tags || []).map(tagValue),
                folder: suggestions.mover?.[0]?.path || group.file.parent?.path || '/',
                useMeta: !!suggestions.meta, useTags: !!suggestions.tags?.length, useFolder: !!suggestions.mover?.length,
                rename: !!this.plugin.settings.metaRenameDefault, diffId: diffs.at(-1)?.id || '', originalTaskId: latest?.id,
                originalPath: group.file.path, applied: [], skipped: [] };
        }
        return anchor.content.noteDraft;
    }

    // 状态键保持中文（逻辑里用来比较），显示时再翻
    statusLabel(status: NoteStatus) {
        return ({ '已确认': tr('已确认', 'Confirmed'), '需重试': tr('需重试', 'Retry'), '待确认': tr('待确认', 'To confirm') } satisfies Record<NoteStatus, string>)[status] || status;
    }

    // 使用统计的键是存进 data.json 的中文名，显示时再翻
    actionLabel(key: string) {
        const en: Record<string, string> = { '标签': 'Tags', '结构': 'Structure', '元数据': 'Properties', '移动': 'Move', '假名': 'Furigana', '一键处理': 'One-click', '其他': 'Other' };
        return isChineseInterface() ? key : en[key] || key;
    }

    noteStatus(group: NoteGroup): NoteStatus {
        if (group.tasks.at(-1)?.content.noteApplied) return '已确认';
        if (group.tasks.at(-1)?.type === 'error') return '需重试';
        return '待确认';
    }

    renderNoteQueue(container: HTMLElement) {
        const groups = this.getNoteGroups();
        const count = (status: NoteStatus) => groups.filter(g => this.noteStatus(g) === status).length;
        container.createEl('p', { text: tr(`${count('待确认')} 篇待确认 · ${count('已确认')} 篇已确认 · ${count('需重试')} 篇需重试`, `${count('待确认')} to confirm · ${count('已确认')} confirmed · ${count('需重试')} to retry`), cls: 'mist-caption' });
        container.createEl('button', { text: tr('＋ 批量整理笔记', '+ Batch tidy notes'), cls: 'mist-link' }).onclick = () => this.showBatchProcessingModal();
        this.queueSelection ||= new Set();
        for (const group of groups) {
            const row = container.createDiv({ cls: 'mist-queue-row' });
            const check = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': tr(`选择 ${group.file.basename}`, `Select ${group.file.basename}`) } });
            check.checked = this.queueSelection.has(group.file.path);
            check.disabled = this.noteStatus(group) !== '待确认';
            check.onchange = () => { if (check.checked) this.queueSelection!.add(group.file.path); else this.queueSelection!.delete(group.file.path); };
            const copy = row.createDiv({ cls: 'mist-queue-name' });
            copy.createEl('strong', { text: group.file.basename });
            copy.createEl('small', { text: this.statusLabel(this.noteStatus(group)) });
            row.createEl('button', { text: tr('查看', 'View'), cls: 'mist-link' }).onclick = () => { this.selectedTaskId = group.tasks.at(-1)!.id; this.workbenchPage = 'review'; this.render(); };
        }
        if (!groups.length) this.renderMistEmpty(container, tr('还没有待确认的笔记', 'No notes to confirm'), tr('生成的建议会按笔记集中在这里。', 'Suggestions gather here, one note at a time.'));
        if (groups.length) {
            const foot = container.createDiv({ cls: 'mist-foot' });
            const apply = foot.createEl('button', { text: tr('接受勾选的笔记', 'Accept ticked notes'), cls: 'mist-primary' });
            apply.onclick = async () => {
                if (this.noteApplying) return;
                const chosen = groups.filter(g => this.queueSelection!.has(g.file.path) && this.noteStatus(g) === '待确认');
                if (!chosen.length) { new Notice(tr('先勾选要接受的笔记。', 'Tick the notes to accept first.')); return; }
                this.noteApplying = true; apply.disabled = true; let done = 0;
                try {
                    for (const g of chosen) {
                        try { await this.acceptAllNote(g, this.noteDraft(g)); done++; }
                        catch (e) { new Notice(tr(`${g.file.basename}：${messageOf(e)}`, `${g.file.basename}: ${messageOf(e)}`), 6000); }
                    }
                } finally { this.noteApplying = false; this.queueSelection!.clear(); this.render(); new Notice(tr(`已确认 ${done} / ${chosen.length} 篇。`, `Confirmed ${done} of ${chosen.length}.`)); }
            };
        }
        for (const task of this.tasks.filter(t => t.type === 'batch-process' && t.content?.canInterrupt)) this.renderTask(container, task);
    }

    // The note this panel is about: shown on both pages so the user always knows what will change.
    renderMistNote(container: HTMLElement, file: TFile | null, allowSwap = true) {
        const note = container.createDiv({ cls: 'mist-note' });
        setIcon?.(note.createDiv({ cls: 'mist-note-glyph', attr: { 'aria-hidden': 'true' } }), 'file-text');
        const copy = note.createDiv({ cls: 'mist-note-copy' });
        copy.createEl('strong', { text: file ? file.basename : tr('选择一篇笔记', 'Choose a note') });
        copy.createEl('small', { text: file ? (file.parent?.path === '/' ? tr('笔记库根目录', 'Vault root') : (file.parent?.path || file.path)) : tr('打开或选择 Markdown 文件', 'Open or choose a Markdown file') });
        if (allowSwap) note.createEl('button', { text: file ? tr('换一篇', 'Change') : tr('选择笔记', 'Choose note'), cls: 'mist-link', attr: { 'aria-label': tr('选择要整理的笔记', 'Choose the note to tidy') } }).onclick = () => this.chooseAtelierNote();
    }

    // 空状态：一句发生了什么，最多一个下一步
    renderMistEmpty(container: HTMLElement, title: string, text: string, action: [string, () => unknown] | null = null) {
        const empty = container.createDiv({ cls: 'mist-empty' });
        empty.createEl('strong', { text: title });
        empty.createEl('p', { text });
        if (action) empty.createEl('button', { text: action[0], cls: 'mist-primary' }).onclick = action[1];
        return empty;
    }

    openPluginSettings() {
        this.plugin.app.setting.open();
        this.plugin.app.setting.openTabById(this.plugin.manifest.id);
    }

    renderMistPrepare(body: HTMLElement, file: TFile | null, busy: boolean) {
        const chosen = this.sessionActions || this.plugin.settings.oneClickProcessActions || {};
        const actions: [keyof OneClickActions, string, string][] = [['meta', tr('标题与摘要', 'Title & summary'), tr('补全笔记属性', 'Fill in properties')], ['tagger', tr('标签', 'Tags'), tr('连接已有分类', 'Link to existing tags')], ['mover', tr('归档', 'Folder'), tr('建议存放位置', 'Suggest where it goes')], ['furigana', tr('假名', 'Furigana'), tr('给日文加读音', 'Add readings to Japanese')], ['structurizer', tr('整理正文', 'Tidy text'), tr('梳理段落与标题', 'Sort paragraphs and headings')]];
        const configured = this.plugin.hasUsableConfig();
        if (!configured) {
            this.renderMistEmpty(body, tr('还没连上 AI 服务', 'No AI service connected yet'),
                tr('先看一个示例：建议是预先写好的，不联网，不花钱。', 'See an example first: the suggestions are pre-written, nothing is sent and nothing is charged.'),
                [tr('载入示例', 'Load example'), () => this.plugin.loadDemo()]).addClass('mist-setup');
        }
        this.renderMistNote(body, file);
        body.createEl('p', { text: tr('想做什么', 'What to do'), cls: 'mist-label' });
        const list = body.createDiv({ cls: 'mist-acts', attr: { role: 'group', 'aria-label': tr('选择处理功能', 'Choose actions') } });
        for (const [key, label, hint] of actions) {
            const on = !!chosen[key];
            const pill = list.createEl('button', { cls: on ? 'mist-act is-on' : 'mist-act', attr: { 'data-action': key, 'aria-pressed': String(on), title: hint } });
            pill.createSpan({ text: label });
            pill.onclick = () => { this.sessionActions = { ...chosen, [key]: !on }; this.render(); };
        }
        // 打开了手账写法时，整理正文可以选：原话优先，或者时间线和对话里允许缩写
        if (chosen.structurizer && this.plugin.notebookMarks?.()) {
            const condense = this.sessionCondense ?? !!this.plugin.settings.structurizerCondense;
            const seg = body.createDiv({ cls: 'mist-seg', attr: { role: 'group', 'aria-label': tr('手账整理方式', 'Notebook tidy mode') } });
            for (const [value, label, hint] of [[false, tr('原话优先', 'Keep wording'), tr('原话一字不改', 'Original words untouched')], [true, tr('允许缩写', 'Allow condensing'), tr('时间线和对话里可以压成一行', 'Timelines and chats may be condensed')]] satisfies [boolean, string, string][]) {
                const btn = seg.createEl('button', { text: label, cls: condense === value ? 'mist-seg-btn is-on' : 'mist-seg-btn', attr: { 'aria-pressed': String(condense === value), title: hint } });
                btn.onclick = () => { this.sessionCondense = value; this.render(); };
            }
        }
        const ask = body.createEl('label', { cls: 'mist-ask' });
        ask.createSpan({ text: tr('补充一句（可不填）', 'Add a note (optional)') });
        const input = ask.createEl('textarea', { attr: { rows: '1', placeholder: tr('例如：标签尽量用库里已有的', 'For example: prefer tags already in the vault'), 'aria-label': tr('补充要求', 'Extra request') } });
        input.value = this.sessionInstruction || '';
        input.oninput = () => { this.sessionInstruction = input.value; };

        const selected = actions.filter(([key]) => chosen[key]);
        const go = body.createDiv({ cls: 'mist-go' });
        go.createEl('small', { text: !configured ? tr('先在设置里连上 AI 服务', 'Connect an AI service in settings first') : !file ? tr('先打开一篇 Markdown 笔记', 'Open a Markdown note first') : selected.length ? tr('结果集中在这篇，原文先不动', 'Results gather here; the note is untouched for now') : tr('至少选一件事', 'Pick at least one action'), cls: 'mist-caption' });
        const run = go.createEl('button', { text: busy ? tr('正在生成…', 'Generating…') : tr('生成建议 →', 'Generate suggestions →'), cls: 'mist-primary', attr: { 'aria-label': tr('为当前笔记生成修改建议', 'Generate suggestions for the current note') } });
        run.disabled = !configured || !file || !selected.length || busy;
        run.onclick = async () => {
            if (this.workbenchRunning || !file) return;
            this.workbenchRunning = true; this.workbenchCancelled = false; this.workbenchPage = 'review';
            this.render(); this.plugin.refreshAssistantViews?.(this);
            this.plugin.condenseOverride = this.sessionCondense;
            try { await this.plugin.runOneClickSmartProcess(file, { ...chosen }, () => this.workbenchCancelled, this.sessionInstruction || ''); }
            finally { this.plugin.condenseOverride = undefined; this.workbenchRunning = false; this.render(); this.plugin.refreshAssistantViews?.(this); }
        };
        if (busy) this.renderCurrentRequestBanner(body);

        this.renderMistRecent(body);
    }

    renderMistReview(body: HTMLElement, file: TFile | null, groups: NoteGroup[]) {
        this.renderCurrentRequestBanner(body);
        const loose = this.tasks.filter(t => !groups.some(g => g.tasks.includes(t)));
        const selectedLoose = loose.find(t => t.id === this.selectedTaskId);
        const group = selectedLoose ? null
            : groups.find(g => g.tasks.some(t => t.id === this.selectedTaskId)) || groups.find(g => file && g.file.path === file.path) || groups.at(-1);
        if (group) { this.renderMistNoteReview(body, group, groups); return; }
        if (loose.length) {
            // Results from single tools and custom actions keep their own cards.
            const task = (selectedLoose || loose.at(-1))!;
            this.selectedTaskId = task.id;
            if (loose.length > 1) {
                const select = body.createEl('select', { cls: 'mist-select', attr: { 'aria-label': tr('选择处理结果', 'Choose a result') } });
                for (const t of loose) select.createEl('option', { value: t.id, text: tr(`${t.status === 'loading' ? '生成中 · ' : t.content?.applied ? '已接受 · ' : ''}${t.title || '处理结果'}`, `${t.status === 'loading' ? 'Generating · ' : t.content?.applied ? 'Accepted · ' : ''}${t.title || 'Result'}`) });
                select.value = task.id;
                select.onchange = () => { this.selectedTaskId = select.value; this.render(); };
            }
            this.renderTask(body, task);
            return;
        }
        if (this.workbenchRunning) {
            this.renderMistEmpty(body, tr('正在准备建议', 'Preparing suggestions'), this.plugin.currentProgress || tr('正在读取笔记，原文不会被改动。', 'Reading the note; the original is not changed.'));
        } else if (this.plugin.lastCancelled && file && this.plugin.lastCancelled === file.path) {
            this.renderMistEmpty(body, tr('已取消', 'Cancelled'), tr('原文没有改动。', 'The note was not changed.'),
                [tr('重新生成', 'Generate again'), () => { this.workbenchPage = 'prepare'; this.render(); }]);
        } else {
            this.renderMistEmpty(body, tr('这里会出现这篇的建议', 'Suggestions for this note appear here'), tr('在“整理”里选好要做的事，生成后集中在这里确认。', 'Choose what to do under Tidy; the suggestions gather here for you to confirm.'),
                [tr('去整理', 'Go to Tidy'), () => { this.workbenchPage = 'prepare'; this.render(); }]);
        }
    }

    renderMistNoteReview(body: HTMLElement, group: NoteGroup, groups: NoteGroup[]) {
        const draft = this.noteDraft(group);
        draft.applied ||= []; draft.skipped ||= [];
        const suggestions: NoteSuggestions = noteSuggestionsOf(group.tasks.filter(t => t.type === 'one-click').at(-1)) || {};
        const status = this.noteStatus(group);
        const done = status === '已确认';
        // 以前整篇一次确认的结果：没有分块记录，只能整篇撤销
        const wholeDone = done && !draft.applied.length;
        const busy = !!this.noteApplying || !!this.workbenchRunning;
        this.renderMistNote(body, group.file, false);
        if (group.tasks.some(t => t.content?.demo)) {
            const configured = this.plugin.hasUsableConfig();
            this.renderMistEmpty(body, tr('这是演示', 'This is a demo'),
                tr('下面的建议是预先写好的，没有联网，也没有花钱。可以照常应用和撤销，只会改这篇示例笔记。', 'The suggestions below are pre-written; nothing was sent or charged. You can apply and undo them as usual; only this example note changes.'),
                configured ? [tr('删除示例笔记', 'Delete example note'), () => this.plugin.removeDemo()] : [tr('连接 AI 服务', 'Connect an AI service'), () => this.openPluginSettings()]).addClass('mist-demo');
        }
        const { parts, fm } = this.plugin.notePartsInfo(group, draft);
        const keys = Object.keys(parts);
        const others = groups.filter(g => g !== group && this.noteStatus(g) === '待确认').length;
        // 每行自己说明状态（没勾、已应用、不要），这里只留行里看不出来的：生成失败、还有别的笔记在等
        const state = status === '需重试' || others ? body.createDiv({ cls: 'mist-state' }) : null;
        if (status === '需重试') state!.createSpan({ text: tr('生成失败 · 原文没有改动', 'Failed · the note was not changed'), cls: 'mist-dot is-done' });
        if (others) state!.createEl('button', { text: tr(`还有 ${others} 篇`, `${others} more`), cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'queue'; this.render(); };

        const run = async (work: () => Promise<void>) => {
            if (this.noteApplying) return;
            this.noteApplying = true; this.render();
            try { await work(); }
            catch (e) { new Notice(messageOf(e), 7000); }
            finally { this.noteApplying = false; this.render(); this.plugin.refreshAssistantViews?.(this); }
        };
        const setParts = (next: string[]) => run(async () => {
            const wasDone = this.noteStatus(group) === '已确认';
            await this.plugin.setNoteParts(group, draft, next);
            if (!wasDone && this.noteStatus(group) === '已确认') this.afterNoteApplied(group);
        });
        // 每块一行：勾、名字、一句改了什么、一个按钮。点这一行才展开编辑，一次只开一行。
        const openKey = this.openPart?.path === group.file.path ? this.openPart.key : '';
        const list = body.createDiv({ cls: 'mist-rows', attr: { role: 'list' } });
        const row = (key: string, title: string, summary: string, doneText: string, canApply = true, warn = false): RowPanel | null => {
            const applied = draft.applied.includes(key), skipped = draft.skipped.includes(key);
            const open = !applied && !skipped && !wholeDone && openKey === key;
            const el = list.createDiv({ cls: `mist-row${applied ? ' is-applied' : skipped ? ' is-skipped' : ''}${open ? ' is-open' : ''}`, attr: { role: 'listitem', 'data-part': key } });
            const line = el.createDiv({ cls: 'mist-row-line' });
            const main = line.createEl('button', { cls: 'mist-row-main', attr: { 'aria-expanded': String(open) } });
            // 行首：没应用时是这一块的图标，应用后换成勾
            if (applied) main.createSpan({ text: '✓', cls: 'mist-tick', attr: { 'aria-hidden': 'true' } });
            else setIcon?.(main.createSpan({ cls: 'mist-row-icon', attr: { 'aria-hidden': 'true' } }), { meta: 'heading', defaults: 'list-plus', tags: 'tag', folder: 'folder', style: 'palette', body: 'file-text' }[key] || 'dot');
            main.createSpan({ text: title, cls: 'mist-row-title' });
            const sumText = applied ? doneText : skipped ? tr('不要', 'Left out') : summary;
            main.createSpan({ text: sumText, cls: warn && !applied && !skipped ? 'mist-row-sum is-warn' : 'mist-row-sum', attr: { title: sumText } });
            main.disabled = applied || skipped || wholeDone;
            main.onclick = () => { this.openPart = open ? null : { path: group.file.path, key }; this.render(); };
            if (wholeDone) return null;
            const act = (text: string, cls: string, label: string, fn: () => unknown) => { const btn = line.createEl('button', { text, cls, attr: { 'aria-label': label } }); btn.disabled = busy; btn.onclick = fn; return btn; };
            if (applied) { act(tr('撤销', 'Undo'), 'mist-link', tr(`撤销${title}`, `Undo ${title}`), () => setParts(draft.applied.filter(k => k !== key))); return null; }
            if (skipped) { act(tr('恢复', 'Restore'), 'mist-link', tr(`恢复${title}`, `Restore ${title}`), () => { draft.skipped = draft.skipped.filter(k => k !== key); this.render(); }); return null; }
            if (canApply) act(tr('应用', 'Apply'), 'mist-row-apply', tr(`应用${title}`, `Apply ${title}`), () => setParts([...draft.applied, key]));
            else line.createSpan({ text: '›', cls: 'mist-row-more', attr: { 'aria-hidden': 'true' } });
            if (!open) return null;
            const panel = el.createDiv({ cls: 'mist-row-body' });
            // 编辑区在前，“这块不要”放最后
            const tail = () => { const no = panel.createEl('button', { text: tr('这块不要', 'Leave this out'), cls: 'mist-link mist-row-skip' }); no.disabled = busy; no.onclick = () => { draft.skipped = [...draft.skipped, key]; this.openPart = null; this.render(); }; };
            return { panel, tail };
        };

        if (parts.meta) {
            const fields: [keyof NoteMeta, string][] = [['title', tr('标题', 'Title')], ['summary', tr('摘要', 'Summary')], ['tldr', tr('一句话总结', 'One-line summary')]];
            const changed = fields.filter(([k]) => String(draft.meta[k] ?? '').trim() && String(draft.meta[k]).trim() !== yamlText(fm[k] ?? '').trim()).length;
            const r = row('meta', tr('标题与摘要', 'Title & summary'), tr(`改 ${changed} 项${draft.rename ? ' · 文件也改名' : ''}`, `${changed} changed${draft.rename ? ' · file renamed too' : ''}`),
                tr(`已写入${draft.rename ? ' · 文件已改名' : ''}`, `Written${draft.rename ? ' · file renamed' : ''}`), changed > 0 || !!draft.rename);
            if (r) {
                for (const [key, label] of fields) {
                    const input = r.panel.createEl('textarea', { cls: `mist-edit mist-edit-${key}`, attr: { rows: key === 'title' ? '1' : '2', 'aria-label': label, placeholder: label } });
                    input.value = draft.meta[key] || '';
                    input.oninput = () => { draft.meta[key] = input.value; };
                    input.onchange = () => this.render();
                }
                const rename = r.panel.createEl('label', { cls: 'mist-rename' });
                const check = rename.createEl('input', { type: 'checkbox' }); check.checked = draft.rename;
                rename.createSpan({ text: tr('同时用标题重命名文件', 'Also rename the file to the title') });
                check.onchange = () => { draft.rename = check.checked; this.render(); };
                r.tail();
            }
        }
        if (parts.defaults) {
            const text = parts.defaults.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : yamlText(v)}`).join(' · ');
            row('defaults', tr('补上属性', 'Add properties'), text, tr('已补上', 'Added'))?.tail();
        }
        if (parts.tags) {
            const first = draft.tags[0];
            const r = row('tags', tr('标签', 'Tags'), first ? `${first}${draft.tags.length > 1 ? ` +${draft.tags.length - 1}` : ''}` : tr('都去掉了', 'All removed'),
                tr(`已加 ${draft.tags.length} 个`, `${draft.tags.length} added`), draft.tags.length > 0);
            if (r) {
                const chips = r.panel.createDiv({ cls: 'mist-chips' });
                for (const tag of suggestions.tags!) {
                    const value = tagValue(tag);
                    const kept = draft.tags.includes(value);
                    const chip = chips.createEl('button', { text: `#${value}`, cls: kept ? 'mist-chip' : 'mist-chip is-off', attr: { 'aria-pressed': String(kept) } });
                    chip.onclick = () => { draft.tags = kept ? draft.tags.filter(t => t !== value) : [...draft.tags, value]; this.render(); };
                }
                r.tail();
            }
        }
        if (parts.folder) {
            const isNew = (p: string) => !isFolder(this.plugin.app.vault.getAbstractFileByPath(p));
            const tailPath = draft.folder.split('/').length > 2 ? `…/${draft.folder.split('/').slice(-2).join('/')}` : draft.folder;
            const r = row('folder', tr('归档', 'Folder'), `→ ${tailPath}${isNew(draft.folder) ? tr(' · 新建', ' · new') : ''}`, tr(`已移到 ${draft.folder}`, `Moved to ${draft.folder}`));
            if (r) {
                const alts = suggestions.mover!.map(v => v.path).filter(p => p && p !== draft.folder);
                if (alts.length) {
                    const altRow = r.panel.createDiv({ cls: 'mist-alts' });
                    altRow.createSpan({ text: tr('也可以放：', 'Or:') });
                    for (const p of alts) {
                        const alt = altRow.createEl('button', { text: p, cls: 'mist-alt' });
                        if (isNew(p)) alt.createSpan({ text: tr(' · 新', ' · new'), cls: 'mist-alt-new' });
                        alt.onclick = () => { draft.folder = p; this.render(); };
                    }
                }
                const other = r.panel.createEl('select', { cls: 'mist-select', attr: { 'aria-label': tr('其他文件夹', 'Other folder') } });
                other.createEl('option', { value: '', text: tr('其他文件夹…', 'Other folder…') });
                for (const f of this.plugin.app.vault.getAllLoadedFiles().filter(isFolder)) other.createEl('option', { value: f.path, text: f.path });
                other.onchange = () => { if (other.value) { draft.folder = other.value; this.render(); } };
                r.tail();
            }
        }
        if (parts.style) {
            const chosen = parts.style.filter(p => draft.style?.[p.key]);
            const name = (p: StyleProposal) => p.key === 'sub' ? tr('副题', 'Subtitle') : p.key === 'card' ? tr('卡片', 'Card') : tr('旧纸', 'Old paper');
            const r = row('style', tr('样式', 'Style'), chosen.length ? chosen.map(name).join(' · ') : tr(`${parts.style.map(name).join(' · ')} · 没勾`, `${parts.style.map(name).join(' · ')} · none ticked`),
                tr(`已加 ${chosen.length} 个`, `${chosen.length} added`), chosen.length > 0);
            if (r) {
                for (const p of parts.style) {
                    const item = r.panel.createEl('label', { cls: 'mist-rename' });
                    const check = item.createEl('input', { type: 'checkbox' }); check.checked = !!draft.style?.[p.key];
                    item.createSpan({ text: p.key === 'sub' ? tr(`副题：${p.text}`, `Subtitle: ${p.text}`) : p.key === 'card' ? tr(`卡片 ${p.cls}`, `Card ${p.cls}`) : tr(`旧纸 ${p.cls} · ${p.days} 天`, `Old paper ${p.cls} · ${p.days} days`) });
                    check.onchange = () => { draft.style = { ...(draft.style || {}), [p.key]: check.checked }; this.render(); };
                }
                r.tail();
            }
        }
        const diffs = group.tasks.filter(t => t.type === 'diff-preview' && !t.content.applied);
        if (parts.body) {
            const chosenDiff = diffs.find(t => t.id === draft.diffId);
            const shrink = this.plugin.shrinkWarning(chosenDiff);
            let stat = tr('先选一个版本', 'Choose a version first');
            if (chosenDiff) {
                const hunks = chosenDiff.content.reviewHunks || this.plugin.buildReviewHunks(chosenDiff.content.originalContent!, chosenDiff.content.proposedContent!);
                const lost = Math.round((1 - String(chosenDiff.content.proposedContent || '').length / Math.max(1, String(chosenDiff.content.originalContent || '').length)) * 100);
                stat = tr(`${shrink ? `短了 ${lost}% · ` : ''}${hunks.length} 处改动`, `${shrink ? `${lost}% shorter · ` : ''}${hunks.length} changes`);
                // 手账整理：说清放了几张纸片、去掉了几行重复属性；原话被改了放最前面
                const nb = chosenDiff.content.notebook;
                if (nb) stat = tr([nb.changed ? `改了 ${nb.changed} 句原话` : '', `${nb.cards} 张纸片`, nb.dupLines ? `去掉 ${nb.dupLines} 行重复属性` : ''].filter(Boolean).join(' · '),
                    [nb.changed ? `${nb.changed} sentences reworded` : '', `${nb.cards} cards`, nb.dupLines ? `${nb.dupLines} repeated property lines removed` : ''].filter(Boolean).join(' · '));
            }
            const bodyWarn = !!shrink && !chosenDiff?.content.notebook || !!chosenDiff?.content.notebook?.changed;
            const r = row('body', tr('正文', 'Text'), stat, tr('已替换', 'Replaced'), !!chosenDiff, bodyWarn);
            if (r) {
                const note = r.panel.createDiv({ cls: 'mist-body-note' });
                if (diffs.length > 1 || !draft.diffId) {
                    const select = note.createEl('select', { cls: 'mist-select', attr: { 'aria-label': tr('选择正文版本', 'Choose a text version') } });
                    select.createEl('option', { value: '', text: tr('保留当前正文', 'Keep current text') });
                    for (const task of diffs) select.createEl('option', { value: task.id, text: task.content.action || task.title });
                    select.value = draft.diffId;
                    select.onchange = () => { draft.diffId = select.value; this.render(); };
                } else {
                    note.createSpan({ text: chosenDiff?.content.action || chosenDiff?.title || tr('已生成整理后的正文', 'Tidied text is ready') });
                }
                const look = note.createEl('button', { text: tr('对比 ↗', 'Compare ↗'), cls: 'mist-link is-strong', attr: { 'aria-label': tr('在新标签页对比整理前后', 'Compare before and after in a new tab') } });
                look.onclick = () => { if (chosenDiff) void this.plugin.openNotePreview(chosenDiff); else new Notice(tr('先选择一个正文版本。', 'Choose a text version first.')); };
                if (shrink) r.panel.createDiv({ text: shrink, cls: 'mist-caption is-warn', attr: { role: 'alert' } });
                r.tail();
            }
        }
        const error = group.tasks.at(-1)?.type === 'error' ? group.tasks.at(-1) : null;
        if (!error && !wholeDone && !keys.length) {
            this.renderMistEmpty(body, tr('这次没有建议', 'No suggestions this time'), tr('AI 认为这篇不需要改，原文没有改动。', 'The AI found nothing to change; the note is untouched.'),
                [tr('换个功能再试', 'Try other actions'), () => { this.workbenchPage = 'prepare'; this.render(); }]);
        }
        if (error) {
            const problem = this.plugin.failureProblem({ ...error.content, message: error.content.message });
            const line = body.createEl('p', { cls: 'mist-caption', attr: { role: 'alert' } });
            line.setText(problem ? `${problem.message} ${problem.next}` : error.content.message!);
            const actions = body.createDiv({ cls: 'mist-error-actions' });
            if (problem?.settings) actions.createEl('button', { text: tr('打开设置', 'Open settings'), cls: 'mist-link is-strong' }).onclick = () => this.plugin.openSettings();
            if (problem?.keyPage) actions.createEl('a', { text: tr('打开服务商后台', 'Open provider console'), href: problem.keyPage, cls: 'mist-link' });
            actions.createEl('button', { text: problem?.settings ? tr('改好后重新生成', 'Generate again') : tr('重新生成本篇建议', 'Generate again'), cls: problem?.settings ? 'mist-link' : 'mist-link is-strong' }).onclick = async () => {
                if (this.workbenchRunning) return;
                this.workbenchRunning = true;
                try { await this.plugin.runOneClickSmartProcess(group.file); } finally { this.workbenchRunning = false; this.render(); }
            };
        }
        // 底部固定：一次接受剩下的，或一次撤销整篇
        const plan = this.acceptAllPlan(group, draft, parts);
        const foot = body.createDiv({ cls: 'mist-foot is-sticky' });
        if (wholeDone || (draft.applied.length && !plan.accept.length)) {
            foot.createEl('button', { text: tr('稍后再看', 'Later'), cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'queue'; this.render(); };
            const undo = foot.createEl('button', { text: tr('撤销这篇', 'Undo this note'), cls: 'mist-primary is-quiet' });
            undo.disabled = busy;
            undo.onclick = () => run(async () => { await (draft.applied.length ? this.plugin.setNoteParts(group, draft, []) : this.plugin.undoNoteGroup(group)); draft.skipped = []; });
            return;
        }
        if (!keys.length) return;
        if (draft.applied.length) foot.createEl('button', { text: tr('撤销这篇', 'Undo this note'), cls: 'mist-link' }).onclick = () => run(async () => { await this.plugin.setNoteParts(group, draft, []); draft.skipped = []; });
        else foot.createSpan();
        const all = foot.createEl('button', { cls: 'mist-primary' });
        all.appendText(tr('全部接受 · ', 'Accept all · '));
        all.createSpan({ text: String(plan.accept.length), cls: 'ap-sig-num' });
        all.appendText(tr(' 项', ''));
        all.disabled = busy || !plan.accept.length;
        all.onclick = () => this.acceptAllNote(group, draft, run);
    }

    // 全部接受：剩下没定的块里，有内容可写的接受；什么都没勾的（比如样式一个没勾）算跳过
    acceptAllPlan(group: NoteGroup, draft: NoteDraft, parts: NoteParts = this.plugin.notePartsInfo(group, draft).parts) {
        const pending = Object.keys(parts).filter(k => !(draft.applied || []).includes(k) && !(draft.skipped || []).includes(k));
        const empty = (k: string) => (k === 'tags' && !draft.tags.length) || (k === 'style' && !parts.style!.some(p => draft.style?.[p.key])) || (k === 'body' && !draft.diffId);
        return { accept: pending.filter(k => !empty(k)), skip: pending.filter(empty) };
    }

    acceptAllNote(group: NoteGroup, draft: NoteDraft, run: (work: () => Promise<void>) => Promise<void> = work => work()) {
        const plan = this.acceptAllPlan(group, draft);
        return run(async () => {
            draft.skipped = [...(draft.skipped || []), ...plan.skip];
            await this.plugin.setNoteParts(group, draft, [...(draft.applied || []), ...plan.accept]);
            if (this.noteStatus(group) === '已确认') this.afterNoteApplied(group);
        });
    }

    chooseAtelierNote() {
        const choose = (file: TFile) => {
            this.plugin.assistantLastFile = file;
            this.pinnedFile = file;
            this.workbenchPage = 'prepare';
            this.render();
            this.plugin.refreshAssistantViews?.(this);
        };
        class NotePicker extends GlassFuzzySuggestModal<TFile> {
            getItems(){return this.app.vault.getMarkdownFiles()}
            getItemText(file: TFile){return file.path}
            onChooseItem(file: TFile){choose(file)}
        }
        const picker=new NotePicker(this.plugin.app);picker.setPlaceholder(tr('选择要整理的笔记…', 'Choose the note to tidy…'));picker.open();
    }

    showAtelierCustomActions() {
        const modal=new GlassModal(this.plugin.app);modal.modalEl.addClass('assistant-atelier-modal');
        modal.contentEl.createEl('h2',{text:tr('按自己的方式处理', 'Your own way')});
        const actions=(this.plugin.settings.customActions||[]).filter(a=>a.enabled!==false);
        if(!actions.length)modal.contentEl.createEl('p',{text:tr('在插件设置中添加常用要求，保存为自定义动作。', 'Add frequent requests in plugin settings and save them as custom actions.')});
        for(const action of actions){
            const button=modal.contentEl.createEl('button',{text:action.name||tr('自定义动作', 'Custom actions'),cls:'at-custom-action'});
            button.onclick=()=>{modal.close();void this.plugin.runCustomAction(action.id, this.pinnedFile || this.plugin.assistantLastFile)};
        }
        modal.contentEl.createEl('button',{text:tr('管理自定义动作', 'Manage custom actions'),cls:'at-custom-action'}).onclick=()=>{modal.close();this.plugin.app.setting.open();this.plugin.app.setting.openTabById(this.plugin.manifest.id)};
        modal.open();
    }

    openAtelierSettings() {
        const modal=new GlassModal(this.plugin.app);modal.modalEl.addClass('assistant-atelier-modal');
        modal.contentEl.createEl('h2',{text:tr('处理偏好', 'Preferences')});
        const chosen: OneClickActions={...(this.plugin.settings.oneClickProcessActions||{})};
        for(const [key,label] of ([['structurizer',tr('整理结构', 'Tidy structure')],['furigana',tr('日文注音', 'Japanese readings')],['meta',tr('补全属性', 'Fill properties')],['tagger',tr('补充标签', 'Add tags')],['mover',tr('建议位置', 'Suggest folder')]] satisfies [keyof OneClickActions, string][])){
            const row=modal.contentEl.createEl('label',{cls:'at-settings-row'});
            const check=row.createEl('input',{type:'checkbox'});check.checked=!!chosen[key];
            row.createSpan({text:label});check.onchange=()=>{chosen[key]=check.checked};
        }
        const buttons=modal.contentEl.createDiv({cls:'at-settings-actions'});
        const save=buttons.createEl('button',{text:tr('保存默认步骤', 'Save default steps'),cls:'mod-cta'});
        save.onclick=async()=>{save.disabled=true;this.plugin.settings.oneClickProcessActions=chosen;await this.plugin.saveSettings();modal.close();this.render();this.plugin.refreshAssistantViews?.(this);new Notice(tr('默认处理步骤已保存。', 'Default steps saved.'))};
        buttons.createEl('button',{text:tr('完整设置 ↗', 'Full settings ↗')}).onclick=()=>{modal.close();this.plugin.app.setting.open();this.plugin.app.setting.openTabById(this.plugin.manifest.id)};
        modal.open();
    }

    renderWorkbenchEmpty(container: HTMLElement, title: string, description: string) {
        const empty = container.createDiv({ cls: 'aw-empty' });
        empty.createDiv({ cls:'aw-empty-mark', text:'↗', attr:{'aria-hidden':'true'} });
        empty.createEl('h3', { text:title });
        empty.createEl('p', { text:description });
    }

    cancelWorkbenchRequest() {
        this.workbenchCancelled = true;
        this.plugin.cancelCurrentRequest(tr('用户取消', 'Cancelled by user'));
    }

    renderCurrentRequestBanner(container: HTMLElement) {
        if (!this.workbenchRunning && (!this.plugin.currentAbortController || this.plugin.currentAbortController.signal.aborted)) {
            return;
        }
        const banner = container.createDiv({ cls: "ai-assistant-active-request" });
        const label = this.plugin.currentProgress || this.plugin.currentRequestLabel || tr('AI 请求', 'AI request');
        banner.createSpan({ text: label });
        const cancelButton = banner.createEl("button", { text: tr('取消', 'Cancel') });
        cancelButton.addEventListener("click", () => this.cancelWorkbenchRequest());
    }

    renderTask(container: HTMLElement, task: Task) {
        const card = container.createDiv({ cls: "ai-assistant-card" });

        // Double-click card to navigate
        card.addEventListener('dblclick', (e) => {
            // Prevent navigation when clicking on interactive elements
            // Double-clicks always land on an element inside the card.
            if ((e.target as Element).closest('button, a, input, label')) return;
            if (task.content && task.content.file) {
                void this.plugin.app.workspace.getLeaf().openFile(task.content.file);
            }
        });

        // Create a header container
        const header = card.createDiv({ cls: "assistant-task-heading" });
        header.addClass('ai-assistant-u-header');

        // Add title to header
        header.createEl("h3", { text: task.title || tr('AI 处理结果', 'AI result') });

        const headerActions = header.createDiv();
        headerActions.addClass('ai-assistant-u-header-actions');

        // Add navigation button to header if file exists
        if (task.content && task.content.file) {
            const navButton = headerActions.createEl("button", { text: tr("定位笔记", 'Show note') });
            navButton.addEventListener("click", () => {
                void this.plugin.app.workspace.getLeaf().openFile(task.content.file!);
            });
        }

        if (task.status !== 'loading' && task.canClose !== false) {
            const closeButton = headerActions.createEl("button", {
                cls: "ai-assistant-card-close",
                text: "×"
            });
            closeButton.setAttr("aria-label", tr("关闭卡片", 'Close card'));
            closeButton.addEventListener("click", () => this.removeTask(task.id));
        }

        if (task.status === 'loading') {
            card.createEl("p", { text: task.message || tr("AI 正在处理中，请稍候...", 'The AI is working, please wait…') });
            const streamingContent = task.streamingContent || task.content?.streamingContent;
            const chars = streamingContent ? streamingContent.length : 0;
            const meta = card.createDiv({ cls: "ai-assistant-streaming-meta" });
            meta.setText(chars > 0 ? tr(`已收到 ${chars} 字`, `Received ${chars} characters`) : tr('正在生成，结果到齐后一次显示', 'Generating; the result appears when complete'));
            if (streamingContent) {
                const streamBox = card.createEl("pre", { cls: "ai-assistant-streaming-output" });
                streamBox.setText(streamingContent + '▌');
            }
            const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
            const cancelButton = buttonContainer.createEl("button", { text: tr("取消当前请求", 'Cancel request') });
            cancelButton.addEventListener("click", () => this.cancelWorkbenchRequest());
        } else if (task.status === 'displaying') {
            switch (task.type) {
                case 'mover':
                    this.renderMoverTask(card, task);
                    break;
                case 'tagger':
                    this.renderTaggerTask(card, task);
                    break;
                case 'meta':
                    this.renderMetaTask(card, task);
                    break;
                case 'one-click':
                    this.renderOneClickTask(card, task);
                    break;
                case 'structurizer':
                    this.renderStructurizerTask(card, task);
                    break;
                case 'furigana':
                    this.renderStructurizerTask(card, task);
                    break;
                case 'diff-preview':
                    this.renderDiffPreviewTask(card, task);
                    break;
                case 'quick-action':
                case 'custom-action':
                    this.renderResultTask(card, task);
                    break;
                case 'batch-process':
                    this.renderBatchProcessTask(card, task);
                    break;
                case 'folder-batch-confirm':
                    this.renderFolderBatchConfirmTask(card, task);
                    break;

                case 'error':
                case 'success':
                    this.renderMessageTask(card, task);
                    break;
            }
        }
    }

    renderOneClickTask(card: HTMLElement, task: Task) {
        const suggestions = noteSuggestionsOf(task)!;

        const hasMeta = suggestions.meta && Object.keys(suggestions.meta).length > 0;
        const hasTags = suggestions.tags && suggestions.tags.length > 0;
        const hasMover = suggestions.mover && suggestions.mover.length > 0;

        if (!hasMeta && !hasTags && !hasMover) {
            window.setTimeout(() => this.removeTask(task.id), 200);
            return;
        }

        let isFirstSection = true;

        if (hasMeta) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: tr('属性 · 标题与摘要', 'Properties · title & summary') });
            const content = details.createDiv();
            this.renderOneClickMetaSection(content, { ...task, meta: suggestions.meta! });
        }
        if (hasTags) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: tr('属性 · 标签', 'Properties · tags') });
            const content = details.createDiv();
            this.renderOneClickTaggerSection(content, { ...task, tags: suggestions.tags! });
        }
        if (hasMover) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: tr('位置 · 归档建议', 'Location · folder') });
            const content = details.createDiv();
            this.renderOneClickMoverSection(content, { ...task, mover: suggestions.mover! });
        }

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: tr("全部跳过", 'Skip all') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderOneClickMetaSection(container: HTMLElement, task: Task & { meta: NoteMeta }) {
        container.addClass('ai-assistant-meta-section');
        const existing = this.plugin.app.metadataCache.getFileCache(task.content.file!)?.frontmatter || {};
        const before = container.createEl('details', { cls: 'assistant-review-current-properties' });
        before.createEl('summary', { text: tr('查看当前属性', 'Current properties') });
        for (const key of ['title','summary','tldr']) before.createEl('p', { text: tr(`${key}: ${existing[key] ?? '未设置'}`, `${key}: ${existing[key] ?? 'not set'}`) });
        const { title, summary, tldr } = task.meta;



        // 创建可编辑的元数据字段
        const editableData = {
            title: title || '',
            summary: summary || '',
            tldr: tldr || ''
        };

        // 标题编辑区域
        const titleSection = container.createDiv({ cls: "meta-field-section" });
        titleSection.createEl("label", { text: tr("标题:", 'Title:'), cls: "meta-field-label" });
        const titleInput = titleSection.createEl("input", {
            type: "text",
            value: title,
            cls: "meta-field-input"
        });
        titleInput.addEventListener("input", () => {
            editableData.title = titleInput.value;
        });

        // 摘要编辑区域
        const summarySection = container.createDiv({ cls: "meta-field-section" });
        summarySection.createEl("label", { text: tr("摘要:", 'Summary:'), cls: "meta-field-label" });
        const summaryTextarea = summarySection.createEl("textarea", {
            cls: "meta-field-textarea"
        });
        summaryTextarea.value = summary || '';
        summaryTextarea.placeholder = tr("请输入摘要...", 'Enter a summary…');
        summaryTextarea.addEventListener("input", () => {
            editableData.summary = summaryTextarea.value;
        });

        // 一句话总结编辑区域
        const tldrSection = container.createDiv({ cls: "meta-field-section" });
        tldrSection.createEl("label", { text: tr("一句话总结:", 'One-line summary:'), cls: "meta-field-label" });
        const tldrInput = tldrSection.createEl("input", {
            type: "text",
            value: tldr,
            cls: "meta-field-input"
        });
        tldrInput.addEventListener("input", () => {
            editableData.tldr = tldrInput.value;
        });

        // 动态计算文件名和路径
        const getUpdatedPaths = () => {
            const sanitizedTitle = editableData.title.trim().replace(/[/\\:?*"<>|]/g, '-');
            const finalFilename = sanitizedTitle.substring(0, this.plugin.settings.metaFileNameMaxLength);
            const newPath = `${task.content.file!.parent!.path}/${finalFilename}.md`;
            const canRename = task.content.file!.path !== newPath && !this.plugin.app.vault.getAbstractFileByPath(newPath);
            return { sanitizedTitle, finalFilename, newPath, canRename };
        };

        const buttonContainer = container.createDiv({ cls: "ai-assistant-button-container" });

        // 重命名文件按钮
        const renameButton = buttonContainer.createEl("button", { text: tr("重命名文件", 'Rename file'), cls: "mod-cta" });
        renameButton.addEventListener("click", () => void (async () => {
            const paths = getUpdatedPaths();
            if (!paths.canRename) {
                new Notice(tr("无法重命名：目标文件已存在或路径相同", 'Cannot rename: the target exists or the path is the same'));
                return;
            }

            let notice = new Notice(tr("正在重命名并更新元数据...", 'Renaming and updating properties…'), 0);
            try {
                // 使用安全重命名方法
                const newFile = await this.plugin.safeRenameFile(task.content.file!, paths.newPath);

                // 更新元数据
                await this.plugin.updateFrontmatter(newFile, editableData.title, editableData.summary, editableData.tldr);
                notice.hide();
                new Notice(tr(`文件已重命名为: ${paths.finalFilename}.md`, `File renamed to: ${paths.finalFilename}.md`), 4000);

                // 添加到历史记录
                this.plugin.addToHistory(paths.finalFilename, newFile.path, tr("重命名+元数据", 'Rename + properties'), this.plugin.generateFileId(newFile));

                // 更新任务内容
                const newContent = { ...task.content, file: newFile };
                delete noteSuggestionsOf(task)!.meta;
                this.updateTask(task.id, { content: newContent });
            } catch (err) {
                notice.hide();
                console.error(tr("重命名错误详情:", 'Rename error details:'), err);

                // 提供更详细的错误信息和建议
                let errorMessage = tr(`重命名文件时出错: ${messageOf(err)}`, `Error renaming the file: ${messageOf(err)}`);
                let suggestions = [];

                if (messageOf(err).includes(tr('已存在', 'already exists'))) {
                    suggestions.push(tr('请尝试使用不同的文件名', 'Try a different file name'));
                } else if (messageOf(err).includes(tr('非法字符', 'invalid characters'))) {
                    suggestions.push(tr('请移除文件名中的特殊字符', 'Remove special characters from the file name'));
                } else if (messageOf(err).includes(tr('过长', 'too long'))) {
                    suggestions.push(tr('请使用更短的文件名', 'Use a shorter file name'));
                } else if (messageOf(err).includes(tr('找不到文件', 'Could not find'))) {
                    suggestions.push(tr('请稍后重试，或手动重命名文件', 'Try again later, or rename the file by hand'));
                }

                if (suggestions.length > 0) {
                    errorMessage += tr(`\n建议: ${suggestions.join(', ')}`, `\nSuggestions: ${suggestions.join(', ')}`);
                }

                new Notice(errorMessage, 8000);
            }
        })());

        const noRenameButton = buttonContainer.createEl("button", { text: tr("仅更新元数据", 'Properties only') });
        noRenameButton.addEventListener("click", () => void (async () => {
            await this.plugin.updateFrontmatter(task.content.file!, editableData.title, editableData.summary, editableData.tldr);
            new Notice(tr("元数据已更新，文件名保持不变。", 'Properties updated; the file name is unchanged.'));

            // 添加到历史记录
            this.plugin.addToHistory(task.content.file!.basename, task.content.file!.path, tr("更新元数据", 'Update properties'), this.plugin.generateFileId(task.content.file!));

            const newContent = { ...task.content };
            delete noteSuggestionsOf(task)!.meta;
            this.updateTask(task.id, { content: newContent });
        })());
    }

    renderOneClickTaggerSection(container: HTMLElement, task: Task & { tags: TagSuggestion[] }) {
        container.addClass('ai-assistant-tagger-list');
        const selectedTags = new Set();

        task.tags.forEach(suggestion => {
            const itemEl = container.createDiv({ cls: "ai-assistant-tagger-item" });
            const checkbox = itemEl.createEl("input", { type: "checkbox" });
            checkbox.id = `one-click-tag-checkbox-${task.id}-${suggestion.final}`;
            const label = itemEl.createEl("label", { text: suggestion.display });
            label.setAttribute("for", checkbox.id);

            if (suggestion.is_new) {
                label.addClass('ai-assistant-u-accent');
                label.setAttribute('title', tr('新建议的标签', 'Newly suggested tags'));
            }

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedTags.add(suggestion.final);
                else selectedTags.delete(suggestion.final);
            });
        });

        const buttonContainer = container.createDiv({ cls: "ai-assistant-button-container" });
        const confirmButton = buttonContainer.createEl("button", { text: tr("添加选中标签", 'Add selected tags'), cls: "mod-cta" });

        confirmButton.addEventListener("click", () => void (async () => {
            if (selectedTags.size === 0) return new Notice(tr("没有选择任何标签。", 'No tags selected.'));

            const tagsToAdd = Array.from(selectedTags);
            let notice = new Notice(tr(`正在更新笔记标签...`, `Updating tags…`), 0);
            try {
                await this.plugin.app.fileManager.processFrontMatter(task.content.file!, (fm: { tags?: unknown[] | string | null }) => {
                    fm.tags = fm.tags || [];
                    const existingFmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : (fm.tags ? [String(fm.tags)] : []);
                    fm.tags = [...new Set([...existingFmTags, ...tagsToAdd])];
                });
                notice.hide();
                new Notice(tr("笔记标签已成功更新！", 'Tags updated.'), 5000);

                // 添加到历史记录
                this.plugin.addToHistory(task.content.file!.basename, task.content.file!.path, tr(`添加${tagsToAdd.length}个标签`, `Add ${tagsToAdd.length} tags`), this.plugin.generateFileId(task.content.file!));

                const newContent = { ...task.content };
                delete noteSuggestionsOf(task)!.tags;
                this.updateTask(task.id, { content: newContent });
            } catch (e) {
                notice.hide();
                new Notice(tr(`更新标签失败: ${messageOf(e)}`, `Updating tags failed: ${messageOf(e)}`), 0);
            }
        })());
    }

    renderOneClickMoverSection(container: HTMLElement, task: Task & { mover: FolderSuggestion[] }) {
        container.createEl('p', { text: tr(`当前位置：${task.content.file!.path}`, `Current location: ${task.content.file!.path}`), cls: 'assistant-review-path' });
        container.addClass('ai-assistant-mover-list');

        task.mover.forEach(suggestion => {
            const moverItem = container.createDiv({ cls: "ai-assistant-mover-item" });
            const pathDiv = moverItem.createDiv({ cls: "ai-assistant-mover-path" });

            const pathSpan = pathDiv.createSpan({ text: suggestion.path });
            if (suggestion.is_new) {
                pathSpan.addClass('ai-assistant-u-accent');
                pathSpan.setAttribute('title', tr('将创建新文件夹', 'A new folder will be created'));
            }

            const button = moverItem.createEl("button", { text: tr("移动", 'Move'), cls: "mod-cta" });
            button.addEventListener("click", () => void (async () => {
                await this.moveFileToFolder(task, suggestion.path, suggestion.is_new);
            })());
        });

        // 添加"选择其他位置"按钮
        const customMoverItem = container.createDiv({ cls: "ai-assistant-mover-item ai-assistant-custom-mover" });
        const customPathDiv = customMoverItem.createDiv({ cls: "ai-assistant-mover-path" });
        customPathDiv.createSpan({
            text: tr("选择其他位置...", 'Choose another location…'),
            cls: "custom-location-text"
        });

        const customButton = customMoverItem.createEl("button", { text: tr("浏览", 'Browse'), cls: "mod-secondary" });
        customButton.addEventListener("click", () => {
            this.showFolderSelectionForMove(task);
        });
    }

    // 提取移动文件的通用逻辑
    async moveFileToFolder(task: Task, destinationFolder: string, isNew = false) {
        const newPath = `${destinationFolder}/${task.content.file!.name}`;

        if (task.content.file!.path === newPath) {
            new Notice(tr("文件已在目标文件夹中。", 'The file is already in that folder.'));
            return;
        }
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(tr(`目标位置已存在同名文件，无法移动。`, `A file with the same name exists there, so it was not moved.`));
            return;
        }

        let notice = new Notice(tr(`正在移动文件...`, `Moving file…`), 0);
        try {
            if (isNew && !await this.app.vault.adapter.exists(destinationFolder)) {
                await this.app.vault.createFolder(destinationFolder);
                new Notice(tr(`已创建新文件夹: ${destinationFolder}`, `Created folder: ${destinationFolder}`), 4000);
            }
            await this.app.fileManager.renameFile(task.content.file!, newPath);
            notice.hide();
            new Notice(tr(`笔记已成功移动到: ${destinationFolder}`, `Note moved to: ${destinationFolder}`), 5000);

            const newFile = noteAt(this.plugin.app, newPath)!;

            // 添加到历史记录
            this.plugin.addToHistory(newFile.basename, newFile.path, tr("移动文件", 'Move file'), this.plugin.generateFileId(newFile));

            const newContent = { ...task.content, file: newFile };
            delete noteSuggestionsOf(task)!.mover;
            this.updateTask(task.id, { content: newContent });

        } catch (err) {
            notice.hide();
            new Notice(tr(`移动文件时出错: ${messageOf(err)}`, `Error moving the file: ${messageOf(err)}`), 0);
        }
    }

    // 显示文件夹选择器用于移动文件
    showFolderSelectionForMove(task: Task) {
        const folders = this.plugin.app.vault.getAllLoadedFiles()
            .filter(isFolder)
            .map(folder => folder.path)
            .filter(path => path !== '/'); // 排除根目录

        const modal = new FolderSelectionModal(this.plugin.app, folders, (selectedFolder) => {
            if (selectedFolder) {
                void this.moveFileToFolder(task, selectedFolder, false);
            }
        });
        modal.open();
    }

    renderMoverTask(card: HTMLElement, task: Task) {
        // A mover task carries a folder list and its note.
        const suggestions = task.content.suggestions as FolderSuggestion[];
        const file = task.content.file!;

        suggestions.forEach(suggestion => {
            const moverItem = card.createDiv({ cls: "ai-assistant-mover-item" });
            const pathDiv = moverItem.createDiv({ cls: "ai-assistant-mover-path" });

            const pathSpan = pathDiv.createSpan({ text: suggestion.path });
            if (suggestion.is_new) {
                pathSpan.addClass('ai-assistant-u-accent');
                pathSpan.setAttribute('title', tr('将创建新文件夹', 'A new folder will be created'));
            }

            const button = moverItem.createEl("button", { text: tr("移动", 'Move'), cls: "mod-cta" });
            button.addEventListener("click", () => void (async () => {
                await this.moveFileToFolderStandalone(file, suggestion.path, suggestion.is_new, task.id);
            })());
        });

        // 添加"选择其他位置"按钮
        const customMoverItem = card.createDiv({ cls: "ai-assistant-mover-item ai-assistant-custom-mover" });
        const customPathDiv = customMoverItem.createDiv({ cls: "ai-assistant-mover-path" });
        customPathDiv.createSpan({
            text: tr("选择其他位置...", 'Choose another location…'),
            cls: "custom-location-text"
        });

        const customButton = customMoverItem.createEl("button", { text: tr("浏览", 'Browse'), cls: "mod-secondary" });
        customButton.addEventListener("click", () => {
            this.showFolderSelectionForMoveStandalone(file, task.id);
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 独立Mover任务的移动文件逻辑
    async moveFileToFolderStandalone(file: TFile, destinationFolder: string, isNew = false, taskId: string) {
        const newPath = `${destinationFolder}/${file.name}`;

        if (file.path === newPath) {
            new Notice(tr("文件已在目标文件夹中。", 'The file is already in that folder.'));
            return;
        }
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(tr(`目标位置已存在同名文件，无法移动。`, `A file with the same name exists there, so it was not moved.`));
            return;
        }

        let moveNotice = new Notice(tr(`正在移动文件...`, `Moving file…`), 0);
        try {
            if (isNew && !await this.app.vault.adapter.exists(destinationFolder)) {
                await this.app.vault.createFolder(destinationFolder);
                new Notice(tr(`已创建新文件夹: ${destinationFolder}`, `Created folder: ${destinationFolder}`), 4000);
            }
            await this.app.fileManager.renameFile(file, newPath);
            moveNotice.hide();
            new Notice(tr(`笔记已成功移动到: ${destinationFolder}`, `Note moved to: ${destinationFolder}`), 5000);

            // 添加到历史记录
            const newFile = noteAt(this.plugin.app, newPath);
            if (newFile) {
                this.plugin.addToHistory(newFile.basename, newFile.path, tr("移动文件", 'Move file'), this.plugin.generateFileId(newFile));
            }

            this.removeTask(taskId);
        } catch (err) {
            moveNotice.hide();
            new Notice(tr(`移动文件时出错: ${messageOf(err)}`, `Error moving the file: ${messageOf(err)}`), 0);
        }
    }

    // 独立Mover任务的文件夹选择器
    showFolderSelectionForMoveStandalone(file: TFile, taskId: string) {
        const folders = this.plugin.app.vault.getAllLoadedFiles()
            .filter(isFolder)
            .map(folder => folder.path)
            .filter(path => path !== '/'); // 排除根目录

        const modal = new FolderSelectionModal(this.plugin.app, folders, (selectedFolder) => {
            if (selectedFolder) {
                void this.moveFileToFolderStandalone(file, selectedFolder, false, taskId);
            }
        });
        modal.open();
    }

    renderTaggerTask(card: HTMLElement, task: Task) {
        // A tagger task carries a tag list and its note.
        const suggestions = task.content.suggestions as TagSuggestion[];
        const file = task.content.file!;
        const listEl = card.createDiv({ cls: "ai-assistant-tagger-list" });
        const selectedTags = new Set();

        suggestions.forEach(suggestion => {
            const itemEl = listEl.createDiv({ cls: "ai-assistant-tagger-item" });
            const checkbox = itemEl.createEl("input", { type: "checkbox" });
            checkbox.id = `tag-checkbox-${task.id}-${suggestion.final}`;
            const label = itemEl.createEl("label", { text: suggestion.display });
            label.setAttribute("for", checkbox.id);

            if (suggestion.is_new) {
                label.addClass('ai-assistant-u-accent');
                label.setAttribute('title', tr('新建议的标签', 'Newly suggested tags'));
            }

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedTags.add(suggestion.final);
                else selectedTags.delete(suggestion.final);
            });
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const confirmButton = buttonContainer.createEl("button", { text: tr("添加选中标签", 'Add selected tags'), cls: "mod-cta" });
        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });

        cancelButton.addEventListener("click", () => this.removeTask(task.id));
        confirmButton.addEventListener("click", () => void (async () => {
            if (selectedTags.size === 0) return new Notice(tr("没有选择任何标签。", 'No tags selected.'));

            const tagsToAdd = Array.from(selectedTags);
            let updateNotice = new Notice(tr(`正在更新笔记标签...`, `Updating tags…`), 0);
            try {
                await this.plugin.app.fileManager.processFrontMatter(file, (fm: { tags?: unknown[] | string | null }) => {
                    fm.tags = fm.tags || [];
                    const existingFmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : (fm.tags ? [String(fm.tags)] : []);
                    fm.tags = [...new Set([...existingFmTags, ...tagsToAdd])];
                });
                updateNotice.hide();
                new Notice(tr("笔记标签已成功更新！", 'Tags updated.'), 5000);

                // 添加到历史记录
                this.plugin.addToHistory(file.basename, file.path, tr(`添加${tagsToAdd.length}个标签`, `Add ${tagsToAdd.length} tags`), this.plugin.generateFileId(file));

                this.removeTask(task.id);
            } catch (e) {
                updateNotice.hide();
                new Notice(tr(`更新标签失败: ${messageOf(e)}`, `Updating tags failed: ${messageOf(e)}`), 0);
            }
        })());
    }

    renderMetaTask(card: HTMLElement, task: Task) {
        const { title, summary, tldr } = task.content;
        const file = task.content.file!;



        // 创建可编辑的元数据字段
        const editableData = {
            title: title || '',
            summary: summary || '',
            tldr: tldr || ''
        };

        // 标题编辑区域
        const titleSection = card.createDiv({ cls: "meta-field-section" });
        titleSection.createEl("label", { text: tr("建议标题:", 'Suggested title:'), cls: "meta-field-label" });
        const titleInput = titleSection.createEl("input", {
            type: "text",
            value: title,
            cls: "meta-field-input"
        });
        titleInput.addEventListener("input", () => {
            editableData.title = titleInput.value;
        });

        // 摘要编辑区域
        const summarySection = card.createDiv({ cls: "meta-field-section" });
        summarySection.createEl("label", { text: tr("摘要:", 'Summary:'), cls: "meta-field-label" });
        const summaryTextarea = summarySection.createEl("textarea", {
            cls: "meta-field-textarea"
        });
        summaryTextarea.value = summary || '';
        summaryTextarea.placeholder = tr("请输入摘要...", 'Enter a summary…');
        summaryTextarea.addEventListener("input", () => {
            editableData.summary = summaryTextarea.value;
        });

        // 一句话总结编辑区域
        const tldrSection = card.createDiv({ cls: "meta-field-section" });
        tldrSection.createEl("label", { text: tr("一句话总结:", 'One-line summary:'), cls: "meta-field-label" });
        const tldrInput = tldrSection.createEl("input", {
            type: "text",
            value: tldr,
            cls: "meta-field-input"
        });
        tldrInput.addEventListener("input", () => {
            editableData.tldr = tldrInput.value;
        });

        // 动态计算文件名和路径
        const getUpdatedPaths = () => {
            const sanitizedTitle = editableData.title.trim().replace(/[/\\:?*"<>|]/g, '-');
            const finalFilename = sanitizedTitle.substring(0, this.plugin.settings.metaFileNameMaxLength);
            const newPath = `${file.parent!.path}/${finalFilename}.md`;
            const canRename = file.path !== newPath && !this.plugin.app.vault.getAbstractFileByPath(newPath);
            return { sanitizedTitle, finalFilename, newPath, canRename };
        };

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        // 重命名文件按钮
        const renameButton = buttonContainer.createEl("button", { text: tr("重命名文件", 'Rename file'), cls: "mod-cta" });
        renameButton.addEventListener("click", () => void (async () => {
            const paths = getUpdatedPaths();
            if (!paths.canRename) {
                new Notice(tr("无法重命名：目标文件已存在或路径相同", 'Cannot rename: the target exists or the path is the same'));
                return;
            }

            let renameNotice = new Notice(tr("正在重命名并更新元数据...", 'Renaming and updating properties…'), 0);
            try {
                // 使用安全重命名方法
                const newFile = await this.plugin.safeRenameFile(file, paths.newPath);

                // 更新元数据
                await this.plugin.updateFrontmatter(newFile, editableData.title, editableData.summary, editableData.tldr);
                renameNotice.hide();
                new Notice(tr(`文件已重命名为: ${paths.finalFilename}.md`, `File renamed to: ${paths.finalFilename}.md`), 4000);

                // 添加到历史记录
                this.plugin.addToHistory(paths.finalFilename, newFile.path, tr("重命名+元数据", 'Rename + properties'), this.plugin.generateFileId(newFile));

                this.removeTask(task.id);
            } catch (err) {
                renameNotice.hide();
                console.error(tr("重命名错误详情:", 'Rename error details:'), err);

                // 提供更详细的错误信息和建议
                let errorMessage = tr(`重命名文件时出错: ${messageOf(err)}`, `Error renaming the file: ${messageOf(err)}`);
                let suggestions = [];

                if (messageOf(err).includes(tr('已存在', 'already exists'))) {
                    suggestions.push(tr('请尝试使用不同的文件名', 'Try a different file name'));
                } else if (messageOf(err).includes(tr('非法字符', 'invalid characters'))) {
                    suggestions.push(tr('请移除文件名中的特殊字符', 'Remove special characters from the file name'));
                } else if (messageOf(err).includes(tr('过长', 'too long'))) {
                    suggestions.push(tr('请使用更短的文件名', 'Use a shorter file name'));
                } else if (messageOf(err).includes(tr('找不到文件', 'Could not find'))) {
                    suggestions.push(tr('请稍后重试，或手动重命名文件', 'Try again later, or rename the file by hand'));
                }

                if (suggestions.length > 0) {
                    errorMessage += tr(`\n建议: ${suggestions.join(', ')}`, `\nSuggestions: ${suggestions.join(', ')}`);
                }

                new Notice(errorMessage, 8000);
            }
        })());

        const noRenameButton = buttonContainer.createEl("button", { text: tr("仅更新元数据", 'Properties only') });
        noRenameButton.addEventListener("click", () => void (async () => {
            await this.plugin.updateFrontmatter(file, editableData.title, editableData.summary, editableData.tldr);
            new Notice(tr("元数据已更新，文件名保持不变。", 'Properties updated; the file name is unchanged.'));

            // 添加到历史记录
            this.plugin.addToHistory(file.basename, file.path, tr("更新元数据", 'Update properties'), this.plugin.generateFileId(file));

            this.removeTask(task.id);
        })());

        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderStructurizerTask(card: HTMLElement, task: Task) {
        card.createEl("p", { text: tr("笔记的结构和格式已成功优化。", 'The note structure and formatting were improved.') });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: tr("好的", 'OK'), cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderDiffPreviewTask(card: HTMLElement, task: Task, expanded = false) {
        const content = task.content || {};
        if (!content.reviewHunks) content.reviewHunks = this.plugin.buildReviewHunks(content.originalContent || '', content.proposedContent || '');
        if (!Array.isArray(content.reviewSelected)) content.reviewSelected = content.reviewHunks.map(h => h.id);
        const shrink = this.plugin.shrinkWarning(task);
        if (shrink) card.createDiv({ text: shrink, cls: 'assistant-shrink-warning', attr: { role: 'alert' } });
        if (content.reviewMode !== 'changes') {
            this.renderFullArticlePreview(card, task, expanded);
            return;
        }
        card.addClass('assistant-review-surface');
        card.createDiv({ text: content.file?.path || tr('当前笔记', 'Current note'), cls: 'assistant-review-path' });
        const summary = card.createDiv({ cls: 'assistant-review-summary', attr: { 'aria-live': 'polite' } });
        const controls = card.createDiv({ cls: 'assistant-review-toolbar' });
        controls.createEl('button', { text: tr('整文预览', 'Whole-note preview') }).onclick = () => {
            content.reviewMode = 'article'; card.empty(); this.renderDiffPreviewTask(card, task, expanded);
        };
        if (!expanded) controls.createEl('button', { text: tr('展开审阅', 'Review in full') }).onclick = () => {
            const modal = new GlassModal(this.plugin.app);
            modal.modalEl.addClass('assistant-review-modal');
            const paint = () => { modal.contentEl.empty(); modal.contentEl.createEl('h2', { text: task.title || tr('审阅修改', 'Review changes') }); this.renderDiffPreviewTask(modal.contentEl, task, true); };
            modal.onOpen = paint;
            modal.open();
        };
        const list = card.createDiv({ cls: 'assistant-review-hunks' });
        const checks: HTMLInputElement[] = [];
        for (const hunk of content.reviewHunks) {
            const row = list.createDiv({ cls: 'assistant-review-hunk' });
            const label = row.createEl('label', { cls: 'assistant-review-check' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = content.reviewSelected.includes(hunk.id);
            checkbox.disabled = !!content.applied || !!content.applying;
            label.createSpan({ text: hunk.atomic ? tr('整篇建议（保持文档结构完整）', 'Whole-note suggestion (keeps the document structure)') : tr(`修改 ${hunk.id + 1} · 原文第 ${hunk.start + 1} 行`, `Change ${hunk.id + 1} · line ${hunk.start + 1}`) });
            const columns = row.createDiv({ cls: 'assistant-review-columns' });
            for (const [title, value, kind] of [[tr('原内容', 'Original'),hunk.before,'before'],[tr('建议内容', 'Suggested'),hunk.after,'after']]) {
                const column = columns.createDiv();
                column.createSpan({ text: title, cls: 'assistant-review-muted' });
                column.createEl('pre', { text: value || (kind === 'before' ? tr('（此处新增）', '(added here)') : tr('（删除这段）', '(remove this part)')), cls: `assistant-review-${kind}` });
            }
            const updateRow = () => row.toggleClass('is-skipped', !checkbox.checked);
            checkbox.addEventListener('change', () => {
                content.reviewSelected = checkbox.checked ? [...content.reviewSelected!, hunk.id] : content.reviewSelected!.filter(id => id !== hunk.id);
                updateRow(); updateSummary();
            });
            updateRow(); checks.push(checkbox);
        }
        const buttons = card.createDiv({ cls: 'assistant-review-actions' });
        const apply = buttons.createEl('button', { cls: 'mod-cta' });
        const updateSummary = () => {
            const count = content.reviewSelected!.length;
            summary.setText(content.applied ? tr(`已接受 ${count} 项修改`, `Accepted ${count} changes`) : tr(`${content.reviewHunks!.length} 项建议 · 已选择 ${count} 项`, `${content.reviewHunks!.length} suggestions · ${count} selected`));
            apply.setText(content.applied ? tr('撤回本次正文修改', 'Undo this text change') : content.applying ? tr('正在应用…', 'Applying…') : tr(`接受所选 ${count} 项`, `Accept ${count} selected`));
            apply.disabled = !!content.applying || (!content.applied && !count);
        };
        apply.onclick = async () => {
            if (content.applying) return;
            content.applying = true; updateSummary(); checks.forEach(c => c.disabled = true);
            try {
                if (content.applied) await this.plugin.undoReviewTask(task.id);
                else await this.plugin.applyDiffPreview(task.id);
            } finally {
                content.applying = false;
                checks.forEach(c => c.disabled = !!content.applied);
                updateSummary();
                this.render();
            }
        };
        if (!content.applied) buttons.createEl('button', { text: tr('全不选', 'Select none') }).onclick = () => { if (content.applying) return; content.reviewSelected = []; checks.forEach(c => { c.checked = false; c.dispatchEvent(new Event('change')); }); updateSummary(); };
        card.createEl('p', { text: tr('只应用勾选的正文差异。笔记有新编辑时将停止应用；属性与位置建议单独确认。', 'Only the ticked text changes are applied. If the note was edited meanwhile, nothing is applied; property and folder suggestions are confirmed separately.'), cls: 'assistant-review-muted' });
        updateSummary();
    }

    renderFullArticlePreview(card: HTMLElement, task: Task, expanded = false) {
        const content = task.content;
        card.addClass('assistant-review-surface', 'assistant-article-surface');
        const toolbar = card.createDiv({ cls: 'assistant-article-toolbar' });
        const repaint = () => { card.empty(); this.renderDiffPreviewTask(card, task, expanded); };
        const original = content.articleSource === 'original';
        const tabs = toolbar.createDiv({ cls: 'assistant-article-tabs' });
        for (const [value, name] of [['result', tr('优化后', 'Tidied')], ['original', tr('原文', 'Original')]]) {
            const button = tabs.createEl('button', { text: name, attr: { 'aria-pressed': String(original === (value === 'original')) } });
            button.onclick = () => { content.articleSource = value; repaint(); };
        }
        toolbar.createEl('button', { text: tr('查看具体修改', 'See the changes'), cls: 'assistant-article-text-button' }).onclick = () => {
            content.reviewMode = 'changes'; repaint();
        };
        if (!expanded) toolbar.createEl('button', { text: tr('展开阅读', 'Read in full'), cls: 'assistant-article-text-button' }).onclick = () => {
            const modal = new GlassModal(this.plugin.app);
            modal.modalEl.addClass('assistant-review-modal');
            modal.onOpen = () => this.renderDiffPreviewTask(modal.contentEl, task, true);
            modal.open();
        };
        // renderDiffPreviewTask fills in the hunks and the selection before showing this preview.
        const selected = content.reviewSelected!;
        const hunks = content.reviewHunks!;
        card.createEl('p', { text: content.applied ? tr('已应用，可撤回本次修改。', 'Applied; you can undo this change.') : selected.length === hunks.length ? tr('整篇排版预览 · 原笔记尚未修改', 'Whole-note layout preview · the note is not changed yet') : tr('当前预览包含你选择的修改 · 原笔记尚未修改', 'Preview includes your chosen changes · the note is not changed yet'), cls: 'assistant-review-muted' });
        const article = card.createDiv({ cls: 'assistant-article-preview markdown-rendered' });
        const text = original ? content.originalContent : this.plugin.composeReviewContent(content.originalContent!, hunks, selected);
        const body = (text || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
        if (MarkdownRenderer?.render) {
            Promise.resolve(MarkdownRenderer.render(this.plugin.app, body, article, content.file?.path || '', this)).catch(() => {
                article.empty(); article.createEl('pre', { text: body });
            });
        } else article.createEl('pre', { text: body });
        const actions = card.createDiv({ cls: 'assistant-review-actions' });
        const apply = actions.createEl('button', { text: content.applied ? tr('撤回本次修改', 'Undo this change') : content.applying ? tr('正在应用…', 'Applying…') : selected.length === hunks.length ? tr('应用整篇优化', 'Apply whole note') : tr('应用所选修改', 'Apply selected changes'), cls: 'mod-cta' });
        apply.disabled = !!content.applying || (!content.applied && !selected.length);
        apply.onclick = async () => {
            if (content.applying) return;
            content.applying = true; apply.disabled = true; apply.setText(tr('正在处理…', 'Working…'));
            try {
                if (content.applied) await this.plugin.undoReviewTask(task.id);
                else await this.plugin.applyDiffPreview(task.id);
            } finally { content.applying = false; repaint(); this.render(); }
        };
    }

    renderResultTask(card: HTMLElement, task: Task) {
        const content = task.content || {};
        if (content.originalContent) {
            const original = card.createDiv({ cls: "ai-assistant-result-section" });
            original.createEl("h4", { text: "Input" });
            original.createEl("p", {
                text: content.originalContent,
                cls: "ai-assistant-result-preview"
            });
        }

        const result = card.createDiv({ cls: "ai-assistant-result-section" });
        result.createEl("h4", { text: "Result" });
        const output = result.createEl("pre", { cls: "ai-assistant-result-output" });
        output.setText(content.result || content.message || '');

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: tr("关闭", 'Close'), cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染批量处理任务
    renderBatchProcessTask(card: HTMLElement, task: Task) {
        const content = task.content;

        if (content.type === 'error') {
            card.createEl("p", { text: content.message, cls: "error-message" });
            const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
            const closeButton = buttonContainer.createEl("button", { text: tr("确定", 'OK'), cls: "mod-cta" });
            closeButton.addEventListener("click", () => this.removeTask(task.id));
            return;
        }

        if (content.message) {
            // 处理完成或中断的消息
            card.createEl("p", { text: content.message });
        } else {
            // 进行中的处理
            const progressInfo = card.createDiv({ cls: "batch-progress-info" });

            progressInfo.createEl("p", {
                text: tr(`正在处理第 ${content.processedCount} / ${content.totalFiles} 个文件`, `Processing file ${content.processedCount} of ${content.totalFiles}`)
            });

            if (content.currentFile) {
                progressInfo.createEl("p", {
                    text: tr(`当前文件: ${content.currentFile}`, `Current file: ${content.currentFile}`),
                    cls: "current-file-name"
                });
            }

            // 进度条
            const progressContainer = progressInfo.createDiv({ cls: "progress-container" });
            const progressBar = progressContainer.createDiv({ cls: "progress-bar" });
            const progressFill = progressBar.createDiv({ cls: "progress-fill" });
            const percentage = Math.round((content.processedCount! / content.totalFiles!) * 100);
            progressFill.style.width = `${percentage}%`;

            progressInfo.createEl("p", {
                text: `${percentage}%`,
                cls: "progress-percent"
            });
        }

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        if (content.canInterrupt) {
            const interruptButton = buttonContainer.createEl("button", {
                text: tr("🛑 中断处理", 'Stop'),
                cls: "mod-warning interrupt-btn"
            });
            interruptButton.addEventListener("click", () => {
                this.batchProcessInterrupted = true;
                interruptButton.disabled = true;
                interruptButton.textContent = tr("正在中断...", 'Stopping…');
            });
        }

        const closeButton = buttonContainer.createEl("button", { text: tr("关闭", 'Close') });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染文件夹批量处理确认任务
    renderFolderBatchConfirmTask(card: HTMLElement, task: Task) {
        const content = task.content;

        const infoContainer = card.createDiv({ cls: "folder-batch-info" });

        const folderInfo = infoContainer.createDiv({ cls: "info-item" });
        folderInfo.createSpan({ cls: "info-icon", text: "📁" });
        const folderInfoContent = folderInfo.createDiv({ cls: "info-content" });
        folderInfoContent.createEl("strong", { text: tr("文件夹路径:", 'Folder:') });
        folderInfoContent.createEl("br");
        folderInfoContent.createEl("code", { text: content.folderPath });

        const fileInfo = infoContainer.createDiv({ cls: "info-item" });
        fileInfo.createSpan({ cls: "info-icon", text: "📄" });
        const fileInfoContent = fileInfo.createDiv({ cls: "info-content" });
        fileInfoContent.createEl("strong", { text: tr("文件数量:", 'Files:') });
        fileInfoContent.createEl("br");
        fileInfoContent.appendText(tr(`${content.fileCount} 个 Markdown 文件`, `${content.fileCount} Markdown files`));

        const warningBox = infoContainer.createDiv({ cls: "warning-box" });
        warningBox.createSpan({ cls: "warning-icon", text: "⚠️" });
        const warningContent = warningBox.createDiv({ cls: "warning-content" });
        warningContent.createEl("strong", { text: tr("注意:", 'Note:') });
        warningContent.appendText(tr(" 批量处理会把每篇笔记发给你配置的 AI 服务，可能需要较长时间，过程中可以随时中断。", ' Batch processing sends every note to your AI service and may take a while. You can stop at any time.'));

        this.plugin.renderBatchSendSummary(infoContainer, content.files!);

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        const confirmButton = buttonContainer.createEl("button", {
            text: tr("开始处理", 'Start'),
            cls: "mod-cta"
        });
        confirmButton.addEventListener("click", () => {
            this.removeTask(task.id);
            void this.plugin.runBatchProcess(content.files);
        });

        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染消息任务（错误、成功等）
    renderMessageTask(card: HTMLElement, task: Task) {
        const content = task.content;

        card.createEl("p", {
            text: content.message,
            cls: content.type === 'error' || task.type === 'error' ? 'error-message' : 'success-message'
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: tr("确定", 'OK'), cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }









    // 渲染快速操作区域
    renderQuickActions(container: HTMLElement) {
        const section = container.createDiv({ cls: "ai-assistant-section" });

        // 标题区域，包含刷新按钮
        const titleContainer = section.createDiv({ cls: "section-title-container" });
        const title = titleContainer.createEl("h3", { text: tr("快速操作", 'Quick actions') });
        title.addClass('ai-assistant-u-title');

        // 刷新按钮放在标题旁边
        const refreshBtn = titleContainer.createEl("button", {
            text: tr("刷新", 'Refresh'),
            cls: "ai-assistant-refresh-btn"
        });
        refreshBtn.title = tr("刷新面板", 'Refresh panel');
        refreshBtn.addEventListener('click', () => {
            this.render();
            new Notice(tr("面板已刷新", 'Panel refreshed'), 1500);
        });

        const actionGrid = section.createDiv({ cls: "ai-assistant-action-grid" });

        const actions: { name: string; icon: string; desc: string; action: () => unknown }[] = [
            {
                name: tr("回滚上次", 'Undo last'),
                icon: "↩",
                desc: tr("恢复最近一次应用的内容变更", 'Restore the last applied change'),
                action: () => this.plugin.rollbackLastChange()
            },
            {
                name: tr("撤销回滚", 'Redo'),
                icon: "↪",
                desc: tr("重新应用刚刚回滚的 AI 变更", 'Re-apply the AI change you just undid'),
                action: () => this.plugin.redoLastRollback()
            },
            {
                name: tr("批量处理", 'Batch tidy'),
                icon: "📦",
                desc: tr("选择文件或文件夹", 'Choose files or a folder'),
                action: () => this.showBatchProcessingModal()
            },

            {
                name: tr("打开设置", 'Open settings'),
                icon: "⚙️",
                desc: tr("快速打开插件设置", 'Open plugin settings'),
                action: () => {
                    this.plugin.app.setting.open();
                    this.plugin.app.setting.openTabById('ai-assistant-suite');
                }
            }
        ];

        const customActions = (this.plugin.settings.customActions || []).filter(action => action.enabled !== false);
        customActions.forEach(action => {
            actions.push({
                name: action.name || tr('自定义动作', 'Custom actions'),
                icon: "✦",
                desc: this.plugin.getCustomActionModeLabel(action.outputMode),
                action: () => this.plugin.runCustomAction(action.id)
            });
        });

        actions.forEach(action => {
            const actionBtn = actionGrid.createEl("button", { cls: "ai-assistant-action-btn", attr: { type: "button", "aria-label": action.name + tr("：", ': ') + action.desc } });
            actionBtn.createSpan({ text: action.icon, cls: "action-icon" });
            actionBtn.createSpan({ text: action.name, cls: "action-name" });
            actionBtn.createSpan({ text: action.desc, cls: "action-desc" });

            actionBtn.addEventListener("click", action.action);
        });
    }

    // 显示批量处理选择模态框
    showBatchProcessingModal() {
        const modal = new BatchProcessingModal(this.plugin.app, (type, selection) => {
            if (type === 'files') {
                void this.plugin.runBatchProcess(selection);
            } else if (type === 'folder') {
                void this.plugin.runFolderBatchProcess(selection);
            }
        });
        modal.open();
    }

    // 渲染文件信息区域
    renderFileInfo(container: HTMLElement) {
        const currentFile = this.plugin.app.workspace.getActiveFile();
        if (!currentFile) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: tr("📄 当前文件信息", 'Current file') });

        const infoGrid = section.createDiv({ cls: "ai-assistant-info-grid" });

        // 文件基本信息
        const fileInfo = infoGrid.createDiv({ cls: "info-item" });
        fileInfo.createSpan({ text: tr("文件名:", 'Name:'), cls: "info-label" });
        fileInfo.createSpan({ text: currentFile.basename, cls: "info-value" });

        const pathInfo = infoGrid.createDiv({ cls: "info-item" });
        pathInfo.createSpan({ text: tr("路径:", 'Path:'), cls: "info-label" });
        pathInfo.createSpan({ text: currentFile.path, cls: "info-value" });

        // 文件统计
        void this.plugin.app.vault.read(currentFile).then(content => {
            const stats = this.getFileStats(content);

            const wordInfo = infoGrid.createDiv({ cls: "info-item" });
            wordInfo.createSpan({ text: tr("字数:", 'Words:'), cls: "info-label" });
            wordInfo.createSpan({ text: stats.words.toString(), cls: "info-value" });

            const charInfo = infoGrid.createDiv({ cls: "info-item" });
            charInfo.createSpan({ text: tr("字符数:", 'Characters:'), cls: "info-label" });
            charInfo.createSpan({ text: stats.chars.toString(), cls: "info-value" });

            const lineInfo = infoGrid.createDiv({ cls: "info-item" });
            lineInfo.createSpan({ text: tr("行数:", 'Lines:'), cls: "info-label" });
            lineInfo.createSpan({ text: stats.lines.toString(), cls: "info-value" });
        });
    }

    // 获取文件统计信息
    getFileStats(content: string) {
        const lines = content.split('\n').length;
        const chars = content.length;
        const words = content.trim() ? content.trim().split(/\s+/).length : 0;

        return { lines, chars, words };
    }

    // 渲染AI状态监控
    renderAIStatus(container: HTMLElement) {
        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: tr("🤖 AI状态监控", 'AI status') });

        const statusGrid = section.createDiv({ cls: "ai-assistant-status-grid" });

        // API状态
        const apiStatus = statusGrid.createDiv({ cls: "status-item" });
        apiStatus.createSpan({ text: tr("API状态:", 'API:'), cls: "status-label" });
        const apiIndicator = apiStatus.createSpan({ cls: "status-indicator" });

        const hasValidConfig = this.plugin.settings.apiConfigs?.some(c => c.enabled !== false && this.plugin.isConfigUsable(c));
        if (hasValidConfig) {
            apiIndicator.setText(tr("🟢 已配置", 'Configured'));
            apiIndicator.addClass("status-good");
        } else {
            apiIndicator.setText(tr("🔴 未配置", 'Not configured'));
            apiIndicator.addClass("status-error");
        }



        // 模型信息
        const modelStatus = statusGrid.createDiv({ cls: "status-item" });
        modelStatus.createSpan({ text: tr("主模型:", 'Main model:'), cls: "status-label" });
        const activeConfig = this.plugin.getActiveApiConfig();
        modelStatus.createSpan({
            text: activeConfig?.ai?.model || tr("未设置", 'Not set'),
            cls: "status-value"
        });
    }

    // 渲染最近处理历史
    renderRecentHistory(container: HTMLElement) {
        const history = this.plugin.getRecentHistory();
        if (history.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: tr("📚 最近处理", 'Recent') });

        const historyList = section.createDiv({ cls: "ai-assistant-history-list" });

        // 过滤出仍然存在的文件，并更新路径信息
        const validHistory: HistoryItem[] = [];
        const updatedHistory: HistoryItem[] = [];

        for (const item of history) {
            const file = this.findFileByHistory(item);
            if (file) {
                // 如果文件路径已改变，更新历史记录
                const updatedItem = { ...item };
                if (file.path !== item.filePath) {
                    updatedItem.filePath = file.path;
                    updatedItem.fileName = file.basename;
                }
                validHistory.push(updatedItem);
                updatedHistory.push(updatedItem);
            }
        }

        // 笔记改名或删除后，把修正过的历史存回插件设置
        if (updatedHistory.length !== history.length ||
            updatedHistory.some((item, index) =>
                item.filePath !== history[index]?.filePath)) {
            this.plugin.settings.processingHistory = updatedHistory;
            void this.plugin.saveSettings();
        }

        if (validHistory.length === 0) {
            const emptyMessage = historyList.createDiv({ cls: "history-empty" });
            emptyMessage.textContent = tr("暂无有效的处理历史", 'No valid history');
            return;
        }

        validHistory.forEach(item => { // 显示所有历史，通过CSS控制滚动
            const historyItem = historyList.createEl("button", { cls: "history-item", attr: { type: "button", "aria-label": tr("打开笔记：", 'Open note: ') + item.fileName } });

            // 显示当前文件名（可能已更新）
            const fileNameSpan = historyItem.createSpan({
                text: item.fileName,
                cls: "history-filename"
            });

            // 如果文件被重命名，显示提示
            const file = this.findFileByHistory(item);
            if (file && file.path !== item.filePath) {
                fileNameSpan.title = tr(`原路径: ${item.filePath}\n当前路径: ${file.path}`, `Old path: ${item.filePath}\nCurrent path: ${file.path}`);
                fileNameSpan.addClass("history-renamed");
            }

            historyItem.createSpan({
                text: this.formatTime(item.timestamp),
                cls: "history-time"
            });

            historyItem.createSpan({
                text: item.action,
                cls: "history-action"
            });

            // 点击跳转到文件
            historyItem.addEventListener("click", () => {
                const file = this.findFileByHistory(item);
                if (file) {
                    void this.plugin.app.workspace.getLeaf().openFile(file);
                } else {
                    // 在助手面板中显示错误信息
                    this.addTask({
                        id: Date.now().toString(),
                        type: 'error',
                        title: tr('文件访问错误', 'File access error'),
                        status: 'displaying',
                        content: {
                            message: tr(`文件 "${item.fileName}" 不存在或已被移动`, `File "${item.fileName}" does not exist or was moved`),
                            type: 'error'
                        }
                    });
                }
            });
        });

        // 清理历史按钮
        const clearBtn = section.createEl("button", {
            text: tr("清理历史", 'Clear history'),
            cls: "ai-assistant-clear-history-btn"
        });
        clearBtn.addEventListener("click", () => void (async () => {
            const confirmed = await confirmAction(this.app, tr('确定要清理所有处理历史记录吗？此操作不可撤销。', 'Clear all history? This cannot be undone.'), tr('清理', 'Clear'));
            if (confirmed) {
                // 清理插件设置中的历史记录
                this.plugin.settings.processingHistory = [];
                void this.plugin.saveSettings();

                this.render();
                // 在助手面板中显示成功信息
                this.addTask({
                    id: Date.now().toString(),
                    type: 'success',
                    title: tr('历史记录已清理', 'History cleared'),
                    status: 'displaying',
                    content: {
                        message: tr('所有历史记录已成功清理', 'All history cleared'),
                        type: 'success'
                    }
                });
            }
        })());
    }

    // 获取最近处理历史
    // 查找文件的当前位置
    findFileByHistory(historyItem: HistoryItem): TFile | null {
        const allFiles = this.plugin.app.vault.getMarkdownFiles();

        // 首先尝试直接路径匹配
        let file = noteAt(this.plugin.app, historyItem.filePath);
        if (file) return file;

        // 如果直接路径不存在，尝试通过文件ID查找
        if (historyItem.fileId) {
            for (const f of allFiles) {
                if (this.plugin.generateFileId(f) === historyItem.fileId) {
                    return f;
                }
            }
        }

        // 最后尝试通过文件名模糊匹配
        const baseName = historyItem.fileName.replace(/\.md$/, '');
        for (const f of allFiles) {
            if (f.basename === baseName) {
                return f;
            }
        }

        return null;
    }

    // 格式化时间
    formatTime(timestamp: number) {
        const now = Date.now();
        const diff = now - timestamp;

        if (diff < 60000) return tr("刚刚", 'just now');
        if (diff < 3600000) return tr(`${Math.floor(diff / 60000)}分钟前`, `${Math.floor(diff / 60000)} min ago`);
        if (diff < 86400000) return tr(`${Math.floor(diff / 3600000)}小时前`, `${Math.floor(diff / 3600000)} h ago`);
        return tr(`${Math.floor(diff / 86400000)}天前`, `${Math.floor(diff / 86400000)} d ago`);
    }

    // 渲染使用统计
    renderUsageStats(container: HTMLElement) {
        const history = this.plugin.getRecentHistory();
        if (history.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: tr("📊 使用统计", 'Usage') });

        const statsGrid = section.createDiv({ cls: "ai-assistant-stats-grid" });

        const persistentCounts = this.plugin.settings.actionUsageCounts || {};
        let actionCounts: Record<string, number> = { ...persistentCounts };

        // 如果还没有持久化数据，使用最近历史作为回退
        if (Object.keys(actionCounts).length === 0) {
            history.forEach(item => {
                const normalizedAction = this.plugin.normalizeActionName
                    ? this.plugin.normalizeActionName(item.action)
                    : item.action;
                actionCounts[normalizedAction] = (actionCounts[normalizedAction] || 0) + 1;
            });
        }

        // 总处理次数
        const totalCount = this.plugin.settings.totalProcessedCount || history.length;
        const totalStat = statsGrid.createDiv({ cls: "stat-item" });
        totalStat.createSpan({ text: tr("总处理次数:", 'Total runs:'), cls: "stat-label" });
        totalStat.createSpan({ text: totalCount.toString(), cls: "stat-value" });

        // 最常用功能
        const mostUsed = Object.entries(actionCounts)
            .sort(([, a], [, b]) => b - a)[0];

        if (mostUsed) {
            const mostUsedStat = statsGrid.createDiv({ cls: "stat-item" });
            mostUsedStat.createSpan({ text: tr("最常用功能:", 'Most used:'), cls: "stat-label" });
            mostUsedStat.createSpan({
                text: tr(`${mostUsed[0]} (${mostUsed[1]}次)`, `${this.actionLabel(mostUsed[0])} (${mostUsed[1]})`),
                cls: "stat-value"
            });
        }

        // 今日处理次数
        const todayKey = new Date().toISOString().split('T')[0];
        const todayCount = this.plugin.settings.dailyProcessedCounts?.[todayKey] ??
            history.filter(item =>
                new Date(item.timestamp).toISOString().split('T')[0] === todayKey
            ).length;

        const todayStat = statsGrid.createDiv({ cls: "stat-item" });
        todayStat.createSpan({ text: tr("今日处理:", 'Today:'), cls: "stat-label" });
        todayStat.createSpan({ text: todayCount.toString(), cls: "stat-value" });

        if (Object.keys(actionCounts).length > 0) {
            const chartTitle = section.createEl("h4", { text: tr("各功能累计次数", 'Runs per action'), cls: "stat-subtitle" });
            chartTitle.addClass('ai-assistant-u-chart-title');

            const chartContainer = section.createDiv({ cls: "usage-chart" });
            const sortedActions = Object.entries(actionCounts)
                .sort(([, a], [, b]) => b - a);
            const maxCount = sortedActions[0]?.[1] || 1;

            sortedActions.forEach(([action, count]) => {
                const row = chartContainer.createDiv({ cls: "usage-chart-row" });
                const label = row.createDiv({ cls: "usage-chart-label" });
                label.setText(`${action}`);

                const barWrapper = row.createDiv({ cls: "usage-chart-bar" });
                const barFill = barWrapper.createDiv({ cls: "usage-chart-bar-fill" });
                barFill.style.width = `${Math.max((count / maxCount) * 100, 5)}%`;
                barFill.setAttr('aria-label', `${action}: ${count}`);

                const countLabel = row.createDiv({ cls: "usage-chart-count" });
                countLabel.setText(`${count}`);
            });
        }


    }
}
