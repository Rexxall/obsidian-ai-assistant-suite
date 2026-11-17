import { Component, Notice, Setting, MarkdownRenderer, setIcon } from 'obsidian';
import { GlassFuzzySuggestModal, GlassModal, tr } from './shared';

export class PromptEditModal extends GlassModal {
    constructor(app, plugin, settingName, title) {
        super(app);
        this.plugin = plugin;
        this.settingName = settingName;
        this.title = title;
        this.saved = false;
        this.isPreviewMode = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('prompt-edit-modal');

        // 标题和模式切换按钮
        const headerContainer = contentEl.createDiv({ cls: 'prompt-modal-header' });
        headerContainer.createEl('h2', { text: this.title });

        const modeToggle = headerContainer.createEl('button', {
            text: tr('预览模式', 'Preview'),
            cls: 'prompt-mode-toggle'
        });

        // 内容容器
        this.contentContainer = contentEl.createDiv({ cls: 'prompt-content-container' });

        // 创建编辑区域
        this.createEditArea();

        // 创建预览区域（初始隐藏）
        this.createPreviewArea();

        // 模式切换逻辑
        modeToggle.addEventListener('click', () => {
            this.isPreviewMode = !this.isPreviewMode;
            if (this.isPreviewMode) {
                modeToggle.textContent = tr('编辑模式', 'Edit');
                this.showPreview();
            } else {
                modeToggle.textContent = tr('预览模式', 'Preview');
                this.showEdit();
            }
        });

        // 底部按钮
        const buttonContainer = contentEl.createDiv({ cls: 'prompt-modal-buttons' });

        const saveBtn = buttonContainer.createEl('button', {
            text: tr('保存', 'Save'),
            cls: 'mod-cta'
        });
        saveBtn.addEventListener('click', async () => {
            if (this.saved) {
                await this.plugin.saveSettings();
                new Notice(tr('Prompt 已保存!', 'Prompt saved.'));
            }
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: tr('取消', 'Cancel') });
        cancelBtn.addEventListener('click', () => this.close());
    }

    createEditArea() {
        this.editContainer = this.contentContainer.createDiv({ cls: 'prompt-edit-area' });

        const setting = new Setting(this.editContainer);
        setting.addTextArea(text => {
            this.textArea = text;
            text.setValue(this.plugin.promptSetting(this.settingName))
                .onChange(value => {
                    this.plugin.settings[this.settingName] = value;
                    this.saved = true;
                    // 如果在预览模式，实时更新预览
                    if (this.isPreviewMode) {
                        this.updatePreview(value);
                    }
                });
            text.inputEl.addClass('ai-assistant-u-prompt-editor');
        });
    }

    createPreviewArea() {
        this.previewContainer = this.contentContainer.createDiv({
            cls: 'prompt-preview-area'
        });
        this.previewContainer.hide();

        this.previewContent = this.previewContainer.createDiv({
            cls: 'prompt-preview-content'
        });
    }

    showPreview() {
        this.editContainer.hide();
        this.previewContainer.show();
        this.updatePreview(this.plugin.promptSetting(this.settingName));
    }

    showEdit() {
        this.previewContainer.hide();
        this.editContainer.show();
    }

    updatePreview(content) {
        // 使用Obsidian的MarkdownRenderer来渲染Markdown
        this.previewContent.empty();

        // 段落、换行照原样显示，{{占位符}} 标成小块，其余一律当纯文本
        for (const paragraph of String(content || '').split(/\n\n+/)) {
            const paragraphEl = this.previewContent.createEl('p');
            paragraph.split('\n').forEach((line, index) => {
                if (index > 0) paragraphEl.createEl('br');
                for (const part of line.split(/(\{\{\w+\}\})/)) {
                    if (/^\{\{\w+\}\}$/.test(part)) {
                        paragraphEl.createSpan({ cls: 'prompt-placeholder ai-assistant-u-code-chip', text: part });
                    } else if (part) {
                        paragraphEl.appendText(part);
                    }
                }
            });
        }
    }
}








// 批量文件选择模态框
export class BatchFileSelectionModal extends GlassModal {
    constructor(app, files, onChoose) {
        super(app);
        this.files = files;
        this.onChoose = onChoose;
        this.selectedFiles = [];
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: tr('选择要批量处理的文件', 'Choose files to process') });

        // 全选/取消全选按钮
        const buttonContainer = contentEl.createDiv({ cls: 'batch-selection-buttons' });
        buttonContainer.addClass('ai-assistant-u-button-row');

        const selectAllBtn = buttonContainer.createEl('button', { text: tr('全选', 'Select all') });
        selectAllBtn.onclick = () => {
            const checkboxes = contentEl.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = true);
            this.selectedFiles = [...this.files];
        };

        const deselectAllBtn = buttonContainer.createEl('button', { text: tr('取消全选', 'Select none') });
        deselectAllBtn.onclick = () => {
            const checkboxes = contentEl.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = false);
            this.selectedFiles = [];
        };

        // 文件列表
        const fileList = contentEl.createDiv({ cls: 'batch-file-list' });
        fileList.addClass('ai-assistant-u-file-list');

        this.files.forEach(file => {
            const fileItem = fileList.createDiv({ cls: 'batch-file-item' });
            fileItem.addClass('ai-assistant-u-file-row');

            const checkbox = fileItem.createEl('input', { type: 'checkbox' });
            checkbox.addClass('ai-assistant-u-checkbox');
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    this.selectedFiles.push(file);
                } else {
                    this.selectedFiles = this.selectedFiles.filter(f => f !== file);
                }
            };

            const fileName = fileItem.createEl('span', { text: file.path });
            fileName.addClass('ai-assistant-u-file-name');
        });

        // 确认按钮
        const confirmContainer = contentEl.createDiv();
        confirmContainer.addClass('ai-assistant-u-confirm-row');

        const confirmBtn = confirmContainer.createEl('button', { text: tr('开始批量处理', 'Start batch'), cls: 'mod-cta' });
        confirmBtn.onclick = () => {
            this.close();
            this.onChoose(this.selectedFiles);
        };

        const cancelBtn = confirmContainer.createEl('button', { text: tr('取消', 'Cancel') });
        cancelBtn.onclick = () => {
            this.close();
            this.onChoose(null);
        };
    }
}

export const MERGE_BLOCKERS = {
    footnotes: name => tr(`「${name}」用了脚注。合在一起编号会撞，这一版先不合并带脚注的笔记。`, `"${name}" has footnotes. Their numbers would clash, so this version does not merge notes with footnotes.`),
    empty: name => tr(`「${name}」是空的，没有可以合并的内容。`, `"${name}" is empty; there is nothing to merge.`),
    'too-long': () => tr('两篇加起来太长（超过 6 万字）。先把其中一篇拆短，或挑更短的两篇。', 'The two notes are too long together (over 60,000 characters). Shorten one first, or pick shorter notes.'),
};

export const mergeLabels = () => ({
    draftTitle: tr('合并草稿', 'Merge draft'),
    draftIntro: (a, b) => tr(`由 ${a} 和 ${b} 生成，两篇原笔记没有改动。每段都是原文，出处标在段落所在的小节。`, `Made from ${a} and ${b}; both notes are unchanged. Every passage is copied word for word; its source is named by its section.`),
    conflicts: tr('互相矛盾', 'Contradictions'),
    shared: tr('共同内容', 'Shared'),
    identical: tr('两篇一字不差', 'Identical in both'),
    onlyIn: link => tr(`只在 ${link} 里`, `Only in ${link}`),
    properties: tr('两篇的属性', 'Properties of both notes'),
    otherWording: link => tr(`${link} 的写法`, `How ${link} puts it`),
    source: tr('出处：', 'Source: '),
    count: n => tr(`（${n}）`, ` (${n})`),
    aiNote: tr('AI 指出：', 'AI note:'),
    untitled: tr('未命名', 'Untitled'),
});

export class MergeNotePicker extends GlassFuzzySuggestModal {
    constructor(app, exclude, placeholder, done) {
        super(app);
        this.exclude = exclude;
        this.done = done;
        this.setPlaceholder(placeholder);
    }
    getItems() {
        return this.app.vault.getMarkdownFiles().filter(f => f.path !== this.exclude?.path).sort((x, y) => y.stat.mtime - x.stat.mtime);
    }
    getItemText(file) {
        return file.path.replace(/\.md$/, '');
    }
    onChooseItem(file) {
        this.done(file);
    }
}

// 合并草稿的确认 → 生成 → 预览 → 建立，全在一个窗口里；关掉窗口就什么都不留
export class MergeDraftModal extends GlassModal {
    constructor(plugin, a, b) {
        super(plugin.app);
        this.plugin = plugin;
        this.a = a;
        this.b = b;
        this.state = 'confirm';
        this.modalEl.addClass('ai-merge-modal');
    }
    onOpen() { this.draw(); }
    onClose() {
        this.controller?.abort();
        this.preview?.unload();
        this.contentEl.empty();
    }
    draw() {
        const { contentEl } = this;
        contentEl.empty();
        this.preview?.unload();
        this.preview = null;
        this.titleEl.setText(tr('生成合并草稿', 'Merge into a draft'));
        if (this.state === 'running') return this.drawRunning(contentEl);
        if (this.state === 'preview') return this.drawPreview(contentEl);
        if (this.state === 'error') return this.drawError(contentEl);
        this.drawConfirm(contentEl);
    }
    noteRow(list, file, mark) {
        const row = list.createDiv({ cls: 'ai-merge-note' });
        row.createSpan({ text: mark, cls: 'ai-merge-mark' });
        const text = row.createDiv({ cls: 'ai-merge-note-text' });
        text.createDiv({ text: file.basename, cls: 'ai-merge-note-name' });
        text.createDiv({ text: file.parent?.path && file.parent.path !== '/' ? file.parent.path : tr('库根目录', 'Vault root'), cls: 'ai-merge-note-folder' });
    }
    drawConfirm(el) {
        const list = el.createDiv({ cls: 'ai-merge-notes' });
        this.noteRow(list, this.a, 'A');
        this.noteRow(list, this.b, 'B');
        const swap = list.createEl('button', { cls: 'clickable-icon ai-merge-swap', attr: { 'aria-label': tr('对调 A 和 B（草稿放在 A 的文件夹）', 'Swap A and B (the draft goes in A\'s folder)') } });
        setIcon(swap, 'arrow-up-down');
        swap.onclick = () => { [this.a, this.b] = [this.b, this.a]; this.draw(); };
        const scope = this.plugin.mergeDraftScope(this.a, this.b);
        const size = (this.a.stat?.size || 0) + (this.b.stat?.size || 0);
        const facts = el.createDiv({ cls: 'ai-merge-facts' });
        if (!scope.config || !this.plugin.isConfigUsable(scope.config)) {
            facts.createDiv({ text: tr('还没有能用的模型连接。', 'No model connection is ready yet.'), cls: 'ai-merge-warn' });
        } else {
            this.sendLine = facts.createDiv({ text: scope.local
                ? tr(`两篇全文（约 ${Math.max(1, Math.round(size / 1024))} KB）只发给本机的「${scope.label}」。`, `Both notes in full (about ${Math.max(1, Math.round(size / 1024))} KB) go only to "${scope.label}" on this computer.`)
                : tr(`两篇全文（约 ${Math.max(1, Math.round(size / 1024))} KB）会发给「${scope.label}」。`, `Both notes in full (about ${Math.max(1, Math.round(size / 1024))} KB) will be sent to "${scope.label}".`) });
        }
        let path = '';
        try { path = this.plugin.mergeDraftPath(this.a, this.b); } catch { /* 名字冲突在生成时再报 */ }
        if (path) facts.createDiv({ text: tr(`新笔记：${path}`, `New note: ${path}`), cls: 'ai-merge-path' });
        const buttons = el.createDiv({ cls: 'modal-button-container' });
        buttons.createEl('button', { text: tr('取消', 'Cancel') }).onclick = () => this.close();
        if (!scope.config || !this.plugin.isConfigUsable(scope.config)) {
            buttons.createEl('button', { text: tr('打开设置', 'Open settings'), cls: 'mod-cta' }).onclick = () => { this.close(); this.plugin.openSettings(); };
            return;
        }
        const go = buttons.createEl('button', { text: tr('生成预览', 'Preview'), cls: 'mod-cta' });
        go.onclick = () => void this.generate();
        go.disabled = true;
        // 先在本地看能不能合并（只读两篇，不联网）；不能就当场说明是哪一篇，并给“换一篇”
        const pair = [this.a, this.b];
        void this.plugin.mergeBlocker(this.a, this.b).then(blocked => {
            if (this.state !== 'confirm' || this.a !== pair[0] || this.b !== pair[1]) return;
            if (!blocked) { go.disabled = false; go.focus(); return; }
            this.sendLine?.remove();
            facts.createDiv({ text: blocked.text, cls: 'ai-merge-warn', attr: { role: 'alert' } });
            go.remove();
            this.addRepick(buttons, blocked.side).focus();
        });
    }
    // 换掉不能合并的那一篇（或第二篇），回到确认页
    addRepick(buttons, side) {
        const replace = side === 'A' ? 'a' : 'b';
        const keep = replace === 'a' ? this.b : this.a;
        const button = buttons.createEl('button', { text: tr('换一篇', 'Choose another'), cls: 'mod-cta' });
        button.onclick = () => new MergeNotePicker(this.app, keep, tr(`和「${keep.basename}」合并的另一篇`, `The note to merge with "${keep.basename}"`), file => {
            this[replace] = file;
            this.state = 'confirm';
            this.draw();
        }).open();
        return button;
    }

    async generate() {
        this.state = 'running';
        this.controller = new AbortController();
        this.draw();
        try {
            this.result = await this.plugin.generateMergeDraft(this.a, this.b, this.controller.signal);
            this.state = 'preview';
        } catch (error) {
            if (this.controller?.signal.aborted || this.plugin.isCancellationError(error)) return;
            this.error = error;
            this.state = 'error';
        } finally {
            this.controller = null;
        }
        this.draw();
    }
    drawRunning(el) {
        const box = el.createDiv({ cls: 'ai-merge-running', attr: { role: 'status', 'aria-live': 'polite' } });
        box.createDiv({ text: tr(`正在比较「${this.a.basename}」和「${this.b.basename}」…`, `Comparing "${this.a.basename}" and "${this.b.basename}"…`) });
        const buttons = el.createDiv({ cls: 'modal-button-container' });
        buttons.createEl('button', { text: tr('取消', 'Cancel') }).onclick = () => { this.controller?.abort(); this.state = 'confirm'; this.draw(); };
    }
    drawPreview(el) {
        const { counts } = this.result;
        const chips = el.createDiv({ cls: 'ai-merge-counts' });
        const chip = (n, label, cls = '') => { const c = chips.createSpan({ cls: `ai-merge-count ${cls}` }); c.createSpan({ text: String(n), cls: 'ap-sig-num' }); c.appendText(` ${label}`); };
        chip(counts.conflicts, tr('处矛盾', counts.conflicts === 1 ? 'contradiction' : 'contradictions'), counts.conflicts ? 'is-warn' : '');
        chip(counts.shared, tr('组共同', 'shared'));
        chip(counts.onlyA, tr('段只在 A', 'only in A'));
        chip(counts.onlyB, tr('段只在 B', 'only in B'));
        const scroll = el.createDiv({ cls: 'ai-merge-preview markdown-rendered' });
        this.preview = new Component();
        this.preview.load();
        void MarkdownRenderer.render(this.app, this.result.text, scroll, this.result.path, this.preview);
        el.createDiv({ text: tr(`会新建：${this.result.path}`, `Will create: ${this.result.path}`), cls: 'ai-merge-path' });
        const buttons = el.createDiv({ cls: 'modal-button-container' });
        buttons.createEl('button', { text: tr('返回', 'Back') }).onclick = () => { this.state = 'confirm'; this.draw(); };
        const create = buttons.createEl('button', { text: tr('创建草稿', 'Create draft'), cls: 'mod-cta' });
        create.onclick = async () => {
            create.disabled = true;
            try {
                await this.plugin.createMergeDraft(this.result);
                this.close();
            } catch (error) {
                this.error = error;
                this.state = 'error';
                this.draw();
            }
        };
    }
    drawError(el) {
        const problem = this.plugin.failureProblem(this.error);
        const box = el.createDiv({ cls: 'ai-merge-error', attr: { role: 'alert' } });
        box.createDiv({ text: problem ? problem.message : this.error?.message || String(this.error), cls: 'ai-merge-error-title' });
        if (problem) box.createDiv({ text: problem.next });
        if (problem?.keyPage) box.createEl('a', { text: tr('打开服务商后台', 'Open provider console'), href: problem.keyPage });
        const buttons = el.createDiv({ cls: 'modal-button-container' });
        buttons.createEl('button', { text: tr('返回', 'Back') }).onclick = () => { this.state = 'confirm'; this.draw(); };
        if (problem?.settings) buttons.createEl('button', { text: tr('打开设置', 'Open settings'), cls: 'mod-cta' }).onclick = () => { this.close(); this.plugin.openSettings(); };
        else if (this.error?.kind === 'merge') this.addRepick(buttons, this.error.side);
        else buttons.createEl('button', { text: tr('再试一次', 'Try again'), cls: 'mod-cta' }).onclick = () => void this.generate();
    }
}
