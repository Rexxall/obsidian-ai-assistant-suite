const { Plugin, Notice, PluginSettingTab, Setting, FuzzySuggestModal, Modal, ItemView } = require('obsidian');

const ASSISTANT_VIEW_TYPE = "ai-assistant-view";

const STRUCTURIZER_DEFAULT_PROMPT = `你是一位非常精准的笔记结构化编辑。你的任务是优化给定文本的结构和可读性，同时严格遵守以下规则。

**核心指令：**

1.  **保留原始措辞 (Preserve Wording)**：
    *   你 **不能** 大幅重写或重述句子。你的主要工作是"重排"和"格式化"，不是"重写"。
    *   只允许为了修正明显的语法错误而进行微小的修改。必须最大程度地保留用户的原始措辞和词汇。

2.  **正确处理嵌入内容和链接 (Handle Embeds & Links)**：
    *   任何形如 \`![[...]]\`、\`![...](...)\` 或 \`[...](...)\` 的文本都是嵌入内容或链接。
    *   你 **必须** 将这些语法块视为不可分割的整体。
    *   **严禁** 描述链接指向的内容（如图片、网页）。你只需保留链接本身。
    *   必须将它原封不动地保留，并放置在上下文中最合理的位置。

3.  **智能重排与格式化 (Restructure & Format)**：
    *   你 **被鼓励** 重新排列句子或整个段落的顺序，以优化文章的逻辑流程。
    *   使用 Markdown 标题 (\`#\`, \`##\`) 创建大纲，使用列表 (\`-\` 或 \`1.\`) 组织要点，使用粗体 (\`**...**\`) 突出关键词。
    *   **布局启发 (Layout Heuristic):** 在处理包含多种内容类型（如中文摘要和英文引文）的笔记时，优先将同类内容组织在一起以提升阅读流畅性。例如，避免将大段的、作为原始资料的引文频繁穿插在分析或总结性的文字中。你可以选择将引文紧跟在对应的分析点之后，或者如果引文很多，可以将它们统一放在一个清晰标识的区域。最终的布局选择，应以最能清晰地呈现当前笔记内容为准。

4.  **信息完整性 (No Deletion)**：确保原始文本中的每一个句子、每一个知识点和每一个链接都完整地出现在最终输出中。

5.  **直接输出结果**：你的输出必须且只能是经过你重构后的 Markdown 文本。不要包含任何额外的对话或评论。

**教学范例：**
*原始文本片段：*
\`\`\`
这是一段文字。[![截图](https://example.com/img.png)](https://example.com/img.png) 这是另一段文字。
\`\`\`
*你的正确输出：*
\`\`\`
这是一段文字。

[![截图](https://example.com/img.png)](https://example.com/img.png) 

这是另一段文字。
\`\`\`

**需要你重构的文本如下：**

---
{{content}}
---`;

const MOVER_DEFAULT_PROMPT = `你是一个精准的文件系统分类专家。你的任务是根据笔记内容，从一个给定的文件夹列表中，选择或创造最适合存放该笔记的文件夹路径。

**核心任务：**
提供 {{count}} 个最合适的路径建议。

**工作流程：**
1.  仔细阅读笔记内容，理解其核心主题。在分析时，请**专注于文本内容**，忽略任何Markdown链接或嵌入文件（如 \`![[...]]\` 或 \`[...](...)\`）所指向的视觉或外部信息。你的任务是根据文本的意义来分类，而不是描述链接。
2.  **首先**，在"现有文件夹列表"中寻找最匹配的路径。如果找到非常匹配的，将它们作为首选建议（至少2个）。
3.  **然后**，如果现有文件夹没有完美的匹配项，或者你认为可以有更好的组织方式，请**创造一个或多个逻辑清晰的新文件夹路径**。新路径应该符合现有文件夹的命名和层级风格。
4.  你的回答必须严格遵守JSON格式。返回一个包含 "suggestions" 键的JSON对象。该键的值是一个包含多个建议对象的数组，每个对象都有 "path" (字符串) 和 "is_new" (布尔值) 两个键。

**示例输出格式：**
{
  "suggestions": [
    { "path": "10 - Projects/TOEFL-Prep/2_Skills/Speaking", "is_new": false },
    { "path": "20 - Areas/Language-Learning/English/TOEFL-Speaking", "is_new": true },
    { "path": "10 - Projects/Personal-Development/Public-Speaking", "is_new": false }
  ]
}

**现有文件夹列表 (供你参考和选择):**
{{folder_list}}

**需要分类的笔记内容如下：**
\n\n{{content}}`;

const TAGGER_DEFAULT_PROMPT = `你是一个严格遵守指令的 Obsidian 标签生成专家。你的任务是为给定的文本生成标签，并严格遵循我现有的标签层级结构。

**核心指令：**
所有你新创建的标签 **必须** 采用 \`大分类/主题/子主题\` 的格式。绝对不允许生成单个词语的标签。每一个新标签都必须被归类到一个或多个层级之下。

**工作流程：**
1.  **分析文本内容**：在分析时，请**专注于文本内容本身**，忽略任何Markdown链接或嵌入文件（如 \`![[...]]\` 或 \`[...](...)\`）所指向的视觉或外部信息。你的任务是根据文本的意义来生成标签，而不是描述链接。
2.  查看我提供的"现有标签列表"。这是你必须遵守的结构和风格指南。
3.  **优先使用**列表中的现有标签。
4.  如果需要创建新标签，请思考它属于哪个"大分类"和"主题"，然后构建出完整的层级标签。
    *   **错误示范：** \`批判性思维\` (这是一个无效的、孤立的标签)
    *   **正确示范：** \`C/个人发展/批判性思维\` (这是一个有效的、被归类的标签)
5.  总共提供约 {{count}} 个标签，混合使用"现有标签"和"新创建的层级标签"。
6.  你的最终输出必须是一个以逗号分隔的标签列表，不要包含任何其他文字或Markdown标记。

**现有标签列表 (你的风格指南):**
{{existing_tags}}

**需要打标签的文本:**
{{content}}`;

const META_DEFAULT_PROMPT = `你是一个内容分析和总结专家。请基于以下提供的文本，执行以下任务：

**重要规则：**
如果文本中包含任何形式的 Markdown 链接或嵌入文件（如 \`![...]]\` 或 \`[...](...)\`），请在分析时**专注于文本内容本身**，忽略链接所指向的视觉或外部信息。你的任务是总结文本，而不是描述链接。

**任务列表：**
1.  **生成一个极其简洁的标题（最好在10个字以内）**。标题需像新闻标题一样精炼、引人注目，并准确概括文本核心。
2.  **撰写一段简短的摘要**。摘要应该用2-3句话总结文本的主要观点和结论。
3.  **生成一个一句话总结（25个字以内）**。这个总结需要高度概括，让人一眼就能了解核心。

请严格按照以下JSON格式返回结果，不要包含任何其他说明性文字或代码块标记：
{
  "title": "在这里填写生成的标题",
  "summary": "在这里填写生成的摘要",
  "tldr": "在这里填写一句话总结"
}

需要处理的文本如下：
\n\n{{content}}`;

const TRANSLATION_DEFAULT_PROMPT = `请将以下英文短语分别翻译成极其简洁且高度切题的 {{target_language}} 标签（最好是2-4个字）。每个翻译占一行，并与输入短语的顺序严格对应。请直接输出翻译结果，不要添加任何其他文字：
{{phrases_to_translate}}`;


const DEFAULT_SETTINGS = {
  // General API Settings
  apiKey: '',
  apiUrl: 'https://darthvader-133-vaderodyseus5.hf.space/v1/chat/completions',
  modelName: 'gemini-2.5-pro',
  auxiliaryModelName: 'gemini-2.5-flash',

  // Structurizer Settings
  structurizerPrompt: STRUCTURIZER_DEFAULT_PROMPT,

  // Mover Settings
  moverSuggestionsCount: 4,
  ignoredFolders: '40 - Obsidian',
  moverPrompt: MOVER_DEFAULT_PROMPT,

  // Tagger Settings
  taggerSuggestionsCount: 12,
  taggerEnableTranslation: true,
  taggerTranslationTargetLanguage: '中文',
  taggerTranslationMinLength: 16,
  taggerPrompt: TAGGER_DEFAULT_PROMPT,
  translationPrompt: TRANSLATION_DEFAULT_PROMPT,

  // Meta Settings
  metaFileNameMaxLength: 100,
  metaPrompt: META_DEFAULT_PROMPT,

  // One-Click Process Settings
  oneClickProcessActions: {
      structurizer: true,
      meta: true,
      tagger: true,
      mover: true,
  },


};

class AssistantView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.tasks = []; // Array to hold all active tasks
        this.currentFile = null; // 跟踪当前文件
        this.setupFileWatcher(); // 设置文件监听
    }

    getViewType() { return ASSISTANT_VIEW_TYPE; }
    getDisplayText() { return "AI Assistant"; }
    getIcon() { return "anchor"; }

    async onOpen() {
        this.render();
    }

    onClose() {
        // 清理文件监听
        if (this.fileWatcherRef) {
            this.plugin.app.workspace.offref(this.fileWatcherRef);
        }
    }

    // 设置文件监听器
    setupFileWatcher() {
        this.fileWatcherRef = this.plugin.app.workspace.on('active-leaf-change', () => {
            const newFile = this.plugin.app.workspace.getActiveFile();
            if (newFile !== this.currentFile) {
                this.currentFile = newFile;
                // 延迟刷新以避免频繁更新
                if (this.refreshTimeout) {
                    clearTimeout(this.refreshTimeout);
                }
                this.refreshTimeout = setTimeout(() => {
                    this.render();
                }, 300);
            }
        });
    }
    
    clear() {
        this.tasks = [];
        this.render();
    }

    addTask(task) {
        this.tasks.push(task);
        this.render();
    }

    updateTask(taskId, newProps) {
        const taskIndex = this.tasks.findIndex(t => t.id === taskId);
        if (taskIndex > -1) {
            this.tasks[taskIndex] = { ...this.tasks[taskIndex], ...newProps };
            this.render();
        }
    }

    getTask(taskId) {
        return this.tasks.find(task => task.id === taskId);
    }

    removeTask(taskId) {
        this.tasks = this.tasks.filter(t => t.id !== taskId);
        this.render();
    }

    render() {
        const container = this.containerEl.children[1];
        container.empty();
        const viewContainer = container.createDiv({ cls: "ai-assistant-view-container" });
        const titleEl = viewContainer.createEl("h2", { text: "AI 助手一键处理" });
        titleEl.style.textAlign = "center";

        // --- One-Click Process Toggles ---
        const buttonGroup = viewContainer.createDiv({ cls: "ai-assistant-button-group" });
        buttonGroup.style.display = 'flex';
        buttonGroup.style.gap = '8px';
        buttonGroup.style.justifyContent = 'center';
        buttonGroup.style.marginBottom = '1em';

        const actions = [
            { name: '优化结构', key: 'structurizer' },
            { name: '元数据', key: 'meta' },
            { name: '标签', key: 'tagger' },
            { name: '移动', key: 'mover' }
        ];

        actions.forEach(action => {
            const button = buttonGroup.createEl('button');
            button.setText(action.name);
            
            if (this.plugin.settings.oneClickProcessActions[action.key]) {
                button.addClass('mod-cta');
            }

            button.addEventListener('click', async () => {
                const newValue = !this.plugin.settings.oneClickProcessActions[action.key];
                this.plugin.settings.oneClickProcessActions[action.key] = newValue;
                await this.plugin.saveSettings();
                button.toggleClass('mod-cta', newValue);
                new Notice(`"${action.name}" 已${newValue ? '开启' : '关闭'}`);
            });
        });

        const runButton = buttonGroup.createEl('button');
        runButton.setText('🚀 运行');
        runButton.setAttribute('title', '对当前笔记执行已选的一键处理流程');
        runButton.addEventListener('click', () => {
            this.plugin.runOneClickSmartProcess();
        });

        viewContainer.createEl('hr');
        // --- End of Toggles ---

        // --- 处理结果区域 (优先显示) ---
        const tasksContainer = viewContainer.createDiv({ cls: "ai-assistant-tasks-container" });
        if (this.tasks.length === 0) {
            const placeholder = tasksContainer.createEl("p", { text: "暂无处理结果" });
            placeholder.style.textAlign = "center";
            placeholder.style.color = "var(--text-muted)";
            placeholder.style.fontSize = "var(--font-ui-small)";
            placeholder.style.margin = "8px 0";
        } else {
            // 添加结果标题
            const resultsTitle = tasksContainer.createEl("h3", { text: "🎯 处理结果" });
            resultsTitle.style.margin = "0 0 12px 0";
            resultsTitle.style.fontSize = "var(--font-ui-medium)";
            resultsTitle.style.color = "var(--text-normal)";

            this.tasks.forEach(task => {
                this.renderTask(tasksContainer, task);
            });
        }

        // --- 快速操作区域 ---
        this.renderQuickActions(viewContainer);

        // --- 最近处理历史 ---
        this.renderRecentHistory(viewContainer);

        // --- 使用统计 ---
        this.renderUsageStats(viewContainer);

        // --- 文件信息区域 ---
        this.renderFileInfo(viewContainer);

        // --- AI状态监控 ---
        this.renderAIStatus(viewContainer);
    }

    renderTask(container, task) {
        const card = container.createDiv({ cls: "ai-assistant-card" });

        // Double-click card to navigate
        card.addEventListener('dblclick', (e) => {
            // Prevent navigation when clicking on interactive elements
            if (e.target.closest('button, a, input, label')) return;
            if (task.content && task.content.file) {
                this.plugin.app.workspace.getLeaf().openFile(task.content.file);
            }
        });

        // Create a header container
        const header = card.createDiv();
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        
        // Add title to header
        header.createEl("h3", { text: task.title });
        
        // Add navigation button to header if file exists
        if (task.content && task.content.file) {
            const navButton = header.createEl("button", { text: "定位笔记" });
            navButton.addEventListener("click", () => {
                this.plugin.app.workspace.getLeaf().openFile(task.content.file);
            });
        }

        if (task.status === 'loading') {
            card.createEl("p", { text: "AI 正在处理中，请稍候..." });
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
                case 'batch-process':
                    this.renderBatchProcessTask(card, task);
                    break;
                case 'folder-batch-confirm':
                    this.renderFolderBatchConfirmTask(card, task);
                    break;
                case 'quick-action':
                    this.renderQuickActionTask(card, task);
                    break;
                case 'error':
                case 'success':
                    this.renderMessageTask(card, task);
                    break;
            }
        }
    }

    renderOneClickTask(card, task) {
        const { suggestions } = task.content;

        const hasMeta = suggestions.meta && Object.keys(suggestions.meta).length > 0;
        const hasTags = suggestions.tags && suggestions.tags.length > 0;
        const hasMover = suggestions.mover && suggestions.mover.length > 0;

        if (!hasMeta && !hasTags && !hasMover) {
            setTimeout(() => this.removeTask(task.id), 200);
            return;
        }

        let isFirstSection = true;

        if (hasMeta) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: '建议元数据' });
            const content = details.createDiv();
            this.renderOneClickMetaSection(content, { ...task, meta: suggestions.meta });
        }
        if (hasTags) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: '建议标签' });
            const content = details.createDiv();
            this.renderOneClickTaggerSection(content, { ...task, tags: suggestions.tags });
        }
        if (hasMover) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: '建议移动位置' });
            const content = details.createDiv();
            this.renderOneClickMoverSection(content, { ...task, mover: suggestions.mover });
        }

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: "全部跳过" });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderOneClickMetaSection(container, task) {
        container.addClass('ai-assistant-meta-section');
        const { title, summary, tldr } = task.meta;
        
        container.createEl("p", { text: `标题: ${title}` });
        container.createEl("p", { text: `摘要: ${summary}` });
        container.createEl("p", { text: `一句话总结: ${tldr}` });

        const sanitizedTitle = title.trim().replace(/[/\\:?*"<>|]/g, '-');
        const finalFilename = sanitizedTitle.substring(0, this.plugin.settings.metaFileNameMaxLength);
        const newPath = `${task.content.file.parent.path}/${finalFilename}.md`;
        const canRename = task.content.file.path !== newPath && !this.plugin.app.vault.getAbstractFileByPath(newPath);

        const buttonContainer = container.createDiv({ cls: "ai-assistant-button-container" });

        if (canRename) {
            const renameButton = buttonContainer.createEl("button", { text: "重命名文件", cls: "mod-cta" });
            renameButton.setAttribute('title', `重命名为 "${finalFilename}.md"`);
            renameButton.addEventListener("click", async () => {
                let notice = new Notice("正在重命名并更新元数据...", 0);
                try {
                    // 使用安全重命名方法
                    const newFile = await this.plugin.safeRenameFile(task.content.file, newPath);

                    // 更新元数据
                    await this.plugin.updateFrontmatter(newFile, title, summary, tldr);
                    notice.hide();
                    new Notice(`文件已重命名为: ${finalFilename}.md`, 4000);

                    // 添加到历史记录
                    this.addToHistory(finalFilename, newFile.path, "重命名+元数据", this.generateFileId(newFile));

                    // 更新任务内容
                    const newContent = { ...task.content, file: newFile };
                    delete newContent.suggestions.meta;
                    this.updateTask(task.id, { content: newContent });
                } catch (err) {
                    notice.hide();
                    console.error("重命名错误详情:", err);

                    // 提供更详细的错误信息和建议
                    let errorMessage = `重命名文件时出错: ${err.message}`;
                    let suggestions = [];

                    if (err.message.includes('已存在')) {
                        suggestions.push('请尝试使用不同的文件名');
                    } else if (err.message.includes('非法字符')) {
                        suggestions.push('请移除文件名中的特殊字符');
                    } else if (err.message.includes('过长')) {
                        suggestions.push('请使用更短的文件名');
                    } else if (err.message.includes('找不到文件')) {
                        suggestions.push('请稍后重试，或手动重命名文件');
                    }

                    if (suggestions.length > 0) {
                        errorMessage += `\n建议: ${suggestions.join(', ')}`;
                    }

                    new Notice(errorMessage, 8000);
                }
            });
        }

        const noRenameButton = buttonContainer.createEl("button", { text: "仅更新元数据" });
        noRenameButton.addEventListener("click", async () => {
            await this.plugin.updateFrontmatter(task.content.file, title, summary, tldr, false);
            new Notice("元数据已更新，文件名保持不变。");

            // 添加到历史记录
            this.addToHistory(task.content.file.basename, task.content.file.path, "更新元数据", this.generateFileId(task.content.file));

            const newContent = { ...task.content };
            delete newContent.suggestions.meta;
            this.updateTask(task.id, { content: newContent });
        });
    }

    renderOneClickTaggerSection(container, task) {
        container.addClass('ai-assistant-tagger-list');
        const selectedTags = new Set();

        task.tags.forEach(suggestion => {
            const itemEl = container.createDiv({ cls: "ai-assistant-tagger-item" });
            const checkbox = itemEl.createEl("input", { type: "checkbox" });
            checkbox.id = `one-click-tag-checkbox-${task.id}-${suggestion.final}`;
            const label = itemEl.createEl("label", { text: suggestion.display });
            label.setAttribute("for", checkbox.id);

            if (suggestion.is_new) {
                label.style.color = "var(--text-accent)";
                label.setAttribute('title', '新建议的标签');
            }

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedTags.add(suggestion.final);
                else selectedTags.delete(suggestion.final);
            });
        });
        
        const buttonContainer = container.createDiv({ cls: "ai-assistant-button-container" });
        const confirmButton = buttonContainer.createEl("button", { text: "添加选中标签", cls: "mod-cta" });
        
        confirmButton.addEventListener("click", async () => {
            if (selectedTags.size === 0) return new Notice("没有选择任何标签。");

            const tagsToAdd = Array.from(selectedTags);
            let notice = new Notice(`正在更新笔记标签...`, 0);
            try {
                await this.plugin.app.fileManager.processFrontMatter(task.content.file, (fm) => {
                    fm.tags = fm.tags || [];
                    const existingFmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : (fm.tags ? [String(fm.tags)] : []);
                    fm.tags = [...new Set([...existingFmTags, ...tagsToAdd])];
                });
                notice.hide();
                new Notice("笔记标签已成功更新！", 5000);

                // 添加到历史记录
                this.addToHistory(task.content.file.basename, task.content.file.path, `添加${tagsToAdd.length}个标签`, this.generateFileId(task.content.file));

                const newContent = { ...task.content };
                delete newContent.suggestions.tags;
                this.updateTask(task.id, { content: newContent });
            } catch (e) {
                notice.hide();
                new Notice(`更新标签失败: ${e.message}`, 0);
            }
        });
    }

    renderOneClickMoverSection(container, task) {
        container.addClass('ai-assistant-mover-list');

        task.mover.forEach(suggestion => {
            const moverItem = container.createDiv({ cls: "ai-assistant-mover-item" });
            const pathDiv = moverItem.createDiv({ cls: "ai-assistant-mover-path" });

            const pathSpan = pathDiv.createEl("span", { text: suggestion.path });
            if (suggestion.is_new) {
                pathSpan.style.color = "var(--text-accent)";
                pathSpan.setAttribute('title', '将创建新文件夹');
            }
            
            const button = moverItem.createEl("button", { text: "移动", cls: "mod-cta" });
            button.addEventListener("click", async () => {
                const destinationFolder = suggestion.path;
                const newPath = `${destinationFolder}/${task.content.file.name}`;

                if (task.content.file.path === newPath) {
                    new Notice("文件已在目标文件夹中。");
                    return;
                }
                if (this.app.vault.getAbstractFileByPath(newPath)) {
                    new Notice(`目标位置已存在同名文件，无法移动。`);
                    return;
                }
                let notice = new Notice(`正在移动文件...`, 0);
                try {
                    if (suggestion.is_new && !await this.app.vault.adapter.exists(destinationFolder)) {
                        await this.app.vault.createFolder(destinationFolder);
                        new Notice(`已创建新文件夹: ${destinationFolder}`, 4000);
                    }
                    await this.app.fileManager.renameFile(task.content.file, newPath);
                    notice.hide();
                    new Notice(`笔记已成功移动到: ${destinationFolder}`, 5000);

                    const newFile = this.plugin.app.vault.getAbstractFileByPath(newPath);

                    // 添加到历史记录
                    this.addToHistory(newFile.basename, newFile.path, "移动文件", this.generateFileId(newFile));

                    const newContent = { ...task.content, file: newFile };
                    delete newContent.suggestions.mover;
                    this.updateTask(task.id, { content: newContent });

                } catch(err) {
                    notice.hide();
                    new Notice(`移动文件时出错: ${err.message}`, 0);
                }
            });
        });
    }

    renderMoverTask(card, task) {
        const { suggestions, file } = task.content;
        
        suggestions.forEach(suggestion => {
            const moverItem = card.createDiv({ cls: "ai-assistant-mover-item" });
            const pathDiv = moverItem.createDiv({ cls: "ai-assistant-mover-path" });

            const pathSpan = pathDiv.createEl("span", { text: suggestion.path });
            if (suggestion.is_new) {
                pathSpan.style.color = "var(--text-accent)";
                pathSpan.setAttribute('title', '将创建新文件夹');
            }
            
            const button = moverItem.createEl("button", { text: "移动", cls: "mod-cta" });
            button.addEventListener("click", async () => {
                const destinationFolder = suggestion.path;
                const newPath = `${destinationFolder}/${file.name}`;

                if (file.path === newPath) {
                    new Notice("文件已在目标文件夹中。");
                    return;
                }
                if (this.app.vault.getAbstractFileByPath(newPath)) {
                    new Notice(`目标位置已存在同名文件，无法移动。`);
                    return;
                }
                let moveNotice = new Notice(`正在移动文件...`, 0);
                try {
                    if (suggestion.is_new && !await this.app.vault.adapter.exists(destinationFolder)) {
                        await this.app.vault.createFolder(destinationFolder);
                        new Notice(`已创建新文件夹: ${destinationFolder}`, 4000);
                    }
                    await this.app.fileManager.renameFile(file, newPath);
                    moveNotice.hide();
                    new Notice(`笔记已成功移动到: ${destinationFolder}`, 5000);
                    this.removeTask(task.id);
                } catch(err) {
                    moveNotice.hide();
                    new Notice(`移动文件时出错: ${err.message}`, 0);
                }
            });
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: "取消" });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderTaggerTask(card, task) {
        const { suggestions, file } = task.content;
        const listEl = card.createDiv({ cls: "ai-assistant-tagger-list" });
        const selectedTags = new Set();

        suggestions.forEach(suggestion => {
            const itemEl = listEl.createDiv({ cls: "ai-assistant-tagger-item" });
            const checkbox = itemEl.createEl("input", { type: "checkbox" });
            checkbox.id = `tag-checkbox-${task.id}-${suggestion.final}`;
            const label = itemEl.createEl("label", { text: suggestion.display });
            label.setAttribute("for", checkbox.id);

            if (suggestion.is_new) {
                label.style.color = "var(--text-accent)";
                label.setAttribute('title', '新建议的标签');
            }

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedTags.add(suggestion.final);
                else selectedTags.delete(suggestion.final);
            });
        });
        
        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const confirmButton = buttonContainer.createEl("button", { text: "添加选中标签", cls: "mod-cta" });
        const cancelButton = buttonContainer.createEl("button", { text: "取消" });

        cancelButton.addEventListener("click", () => this.removeTask(task.id));
        confirmButton.addEventListener("click", async () => {
            if (selectedTags.size === 0) return new Notice("没有选择任何标签。");

            const tagsToAdd = Array.from(selectedTags);
            let updateNotice = new Notice(`正在更新笔记标签...`, 0);
            try {
                await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                    fm.tags = fm.tags || [];
                    const existingFmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : (fm.tags ? [String(fm.tags)] : []);
                    fm.tags = [...new Set([...existingFmTags, ...tagsToAdd])];
                });
                updateNotice.hide();
                new Notice("笔记标签已成功更新！", 5000);

                // 添加到历史记录
                this.addToHistory(file.basename, file.path, `添加${tagsToAdd.length}个标签`, this.generateFileId(file));

                this.removeTask(task.id);
            } catch (e) {
                updateNotice.hide();
                new Notice(`更新标签失败: ${e.message}`, 0);
            }
        });
    }

    renderMetaTask(card, task) {
        const { title, summary, tldr, finalFilename, newPath, file } = task.content;

        let section = card.createDiv({cls: "ai-assistant-meta-section"});
        section.createEl("h4", { text: "建议标题" });
        section.createEl("p", { text: title });
        section = card.createDiv({cls: "ai-assistant-meta-section"});
        section.createEl("h4", { text: "摘要" });
        section.createEl("p", { text: summary });
        section = card.createDiv({cls: "ai-assistant-meta-section"});
        section.createEl("h4", { text: "一句话总结" });
        section.createEl("p", { text: tldr });

        const canRename = file.path !== newPath && !this.plugin.app.vault.getAbstractFileByPath(newPath);
        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        if (canRename) {
            const renameButton = buttonContainer.createEl("button", { text: "重命名文件", cls: "mod-cta" });
            renameButton.setAttribute('title', `重命名为 "${finalFilename}.md"`);
            renameButton.addEventListener("click", async () => {
                let renameNotice = new Notice("正在重命名并更新元数据...", 0);
                try {
                    // 使用安全重命名方法
                    const newFile = await this.plugin.safeRenameFile(file, newPath);

                    // 更新元数据
                    await this.plugin.updateFrontmatter(newFile, title, summary, tldr);
                    renameNotice.hide();
                    new Notice(`文件已重命名为: ${finalFilename}.md`, 4000);
                    this.removeTask(task.id);
                } catch (err) {
                    renameNotice.hide();
                    console.error("重命名错误详情:", err);

                    // 提供更详细的错误信息和建议
                    let errorMessage = `重命名文件时出错: ${err.message}`;
                    let suggestions = [];

                    if (err.message.includes('已存在')) {
                        suggestions.push('请尝试使用不同的文件名');
                    } else if (err.message.includes('非法字符')) {
                        suggestions.push('请移除文件名中的特殊字符');
                    } else if (err.message.includes('过长')) {
                        suggestions.push('请使用更短的文件名');
                    } else if (err.message.includes('找不到文件')) {
                        suggestions.push('请稍后重试，或手动重命名文件');
                    }

                    if (suggestions.length > 0) {
                        errorMessage += `\n建议: ${suggestions.join(', ')}`;
                    }

                    new Notice(errorMessage, 8000);
                }
            });
        }

        const noRenameButton = buttonContainer.createEl("button", { text: "仅更新元数据" });
        noRenameButton.addEventListener("click", async () => {
            await this.plugin.updateFrontmatter(file, title, summary, tldr);
            new Notice("元数据已更新，文件名保持不变。");

            // 添加到历史记录
            this.addToHistory(file.basename, file.path, "更新元数据", this.generateFileId(file));

            this.removeTask(task.id);
        });

        const cancelButton = buttonContainer.createEl("button", { text: "取消" });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderStructurizerTask(card, task) {
        card.createEl("p", { text: "笔记的结构和格式已成功优化。" });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: "好的", cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染批量处理任务
    renderBatchProcessTask(card, task) {
        const content = task.content;

        if (content.type === 'error') {
            card.createEl("p", { text: content.message, cls: "error-message" });
            const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
            const closeButton = buttonContainer.createEl("button", { text: "确定", cls: "mod-cta" });
            closeButton.addEventListener("click", () => this.removeTask(task.id));
            return;
        }

        if (content.message) {
            // 处理完成或中断的消息
            card.createEl("p", { text: content.message });
        } else {
            // 进行中的处理
            const progressInfo = card.createDiv({ cls: "batch-progress-info" });

            const statusText = progressInfo.createEl("p", {
                text: `正在处理第 ${content.processedCount} / ${content.totalFiles} 个文件`
            });

            if (content.currentFile) {
                progressInfo.createEl("p", {
                    text: `当前文件: ${content.currentFile}`,
                    cls: "current-file-name"
                });
            }

            // 进度条
            const progressContainer = progressInfo.createDiv({ cls: "progress-container" });
            const progressBar = progressContainer.createDiv({ cls: "progress-bar" });
            const progressFill = progressBar.createDiv({ cls: "progress-fill" });
            const percentage = Math.round((content.processedCount / content.totalFiles) * 100);
            progressFill.style.width = `${percentage}%`;

            const progressPercent = progressInfo.createEl("p", {
                text: `${percentage}%`,
                cls: "progress-percent"
            });
        }

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        if (content.canInterrupt) {
            const interruptButton = buttonContainer.createEl("button", {
                text: "🛑 中断处理",
                cls: "mod-warning interrupt-btn"
            });
            interruptButton.addEventListener("click", () => {
                this.batchProcessInterrupted = true;
                interruptButton.disabled = true;
                interruptButton.textContent = "正在中断...";
            });
        }

        const closeButton = buttonContainer.createEl("button", { text: "关闭" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染文件夹批量处理确认任务
    renderFolderBatchConfirmTask(card, task) {
        const content = task.content;

        const infoContainer = card.createDiv({ cls: "folder-batch-info" });

        const folderInfo = infoContainer.createDiv({ cls: "info-item" });
        folderInfo.innerHTML = `
            <span class="info-icon">📁</span>
            <div class="info-content">
                <strong>文件夹路径:</strong><br>
                <code>${content.folderPath}</code>
            </div>
        `;

        const fileInfo = infoContainer.createDiv({ cls: "info-item" });
        fileInfo.innerHTML = `
            <span class="info-icon">📄</span>
            <div class="info-content">
                <strong>文件数量:</strong><br>
                ${content.fileCount} 个 Markdown 文件
            </div>
        `;

        const warningBox = infoContainer.createDiv({ cls: "warning-box" });
        warningBox.innerHTML = `
            <span class="warning-icon">⚠️</span>
            <div class="warning-content">
                <strong>注意:</strong> 批量处理将对所有文件执行AI智能处理，这可能需要较长时间。处理过程中可以随时中断。
            </div>
        `;

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        const confirmButton = buttonContainer.createEl("button", {
            text: "开始处理",
            cls: "mod-cta"
        });
        confirmButton.addEventListener("click", () => {
            this.removeTask(task.id);
            this.plugin.runBatchProcess(content.files);
        });

        const cancelButton = buttonContainer.createEl("button", { text: "取消" });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染消息任务（错误、成功等）
    renderMessageTask(card, task) {
        const content = task.content;

        const messageEl = card.createEl("p", {
            text: content.message,
            cls: content.type === 'error' ? 'error-message' : 'success-message'
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: "确定", cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染快速操作任务
    renderQuickActionTask(card, task) {
        const { action, result, originalContent } = task.content;

        // 显示原始内容（如果有）
        if (originalContent) {
            const originalSection = card.createDiv({ cls: "ai-assistant-meta-section" });
            originalSection.createEl("h4", { text: "原始内容" });
            const originalEl = originalSection.createEl("p", { text: originalContent });
            originalEl.style.cssText = `
                background-color: var(--background-modifier-border);
                padding: 8px;
                border-radius: 4px;
                font-size: var(--font-ui-small);
                color: var(--text-muted);
                font-style: italic;
            `;
        }

        // 显示AI处理结果
        const resultSection = card.createDiv({ cls: "ai-assistant-meta-section" });
        resultSection.createEl("h4", { text: `${action}结果` });
        const resultEl = resultSection.createEl("div");
        resultEl.innerHTML = result.replace(/\n/g, '<br>');
        resultEl.style.cssText = `
            background-color: var(--background-primary);
            padding: 12px;
            border-radius: 6px;
            border-left: 3px solid var(--interactive-accent);
            line-height: 1.5;
        `;

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        // 复制结果按钮
        const copyButton = buttonContainer.createEl("button", { text: "📋 复制结果", cls: "mod-cta" });
        copyButton.addEventListener("click", async () => {
            await navigator.clipboard.writeText(result);
            new Notice("结果已复制到剪贴板", 2000);
        });

        // 插入到编辑器按钮
        const insertButton = buttonContainer.createEl("button", { text: "📝 插入到编辑器" });
        insertButton.addEventListener("click", () => {
            const activeEditor = this.plugin.app.workspace.activeEditor?.editor;
            if (activeEditor) {
                const cursor = activeEditor.getCursor();
                activeEditor.replaceRange(result, cursor);
                new Notice("结果已插入到编辑器", 2000);
            } else {
                new Notice("没有活动的编辑器", 3000);
            }
        });

        // 关闭按钮
        const closeButton = buttonContainer.createEl("button", { text: "关闭" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染快速操作区域
    renderQuickActions(container) {
        const section = container.createDiv({ cls: "ai-assistant-section" });

        // 标题区域，包含刷新按钮
        const titleContainer = section.createDiv({ cls: "section-title-container" });
        const title = titleContainer.createEl("h3", { text: "🚀 快速操作" });
        title.style.margin = "0";
        title.style.flex = "1";

        // 刷新按钮放在标题旁边
        const refreshBtn = titleContainer.createEl("button", {
            text: "🔄",
            cls: "ai-assistant-refresh-btn"
        });
        refreshBtn.title = "刷新面板";
        refreshBtn.addEventListener('click', () => {
            this.render();
            new Notice("面板已刷新", 1500);
        });

        const actionGrid = section.createDiv({ cls: "ai-assistant-action-grid" });

        const actions = [
            {
                name: "批量处理",
                icon: "📦",
                desc: "选择文件或文件夹",
                action: () => this.showBatchProcessingModal()
            },

            {
                name: "打开设置",
                icon: "⚙️",
                desc: "快速打开插件设置",
                action: () => {
                    this.plugin.app.setting.open();
                    this.plugin.app.setting.openTabById('ai-assistant-suite');
                }
            }
        ];

        actions.forEach(action => {
            const actionBtn = actionGrid.createDiv({ cls: "ai-assistant-action-btn" });
            actionBtn.createEl("div", { text: action.icon, cls: "action-icon" });
            actionBtn.createEl("div", { text: action.name, cls: "action-name" });
            actionBtn.createEl("div", { text: action.desc, cls: "action-desc" });

            actionBtn.addEventListener("click", action.action);
        });
    }

    // 显示批量处理选择模态框
    showBatchProcessingModal() {
        const modal = new BatchProcessingModal(this.plugin.app, (type, selection) => {
            if (type === 'files') {
                this.plugin.runBatchProcess(selection);
            } else if (type === 'folder') {
                this.plugin.runFolderBatchProcess(selection);
            }
        });
        modal.open();
    }

    // 渲染文件信息区域
    renderFileInfo(container) {
        const currentFile = this.plugin.app.workspace.getActiveFile();
        if (!currentFile) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: "📄 当前文件信息" });

        const infoGrid = section.createDiv({ cls: "ai-assistant-info-grid" });

        // 文件基本信息
        const fileInfo = infoGrid.createDiv({ cls: "info-item" });
        fileInfo.createEl("span", { text: "文件名:", cls: "info-label" });
        fileInfo.createEl("span", { text: currentFile.basename, cls: "info-value" });

        const pathInfo = infoGrid.createDiv({ cls: "info-item" });
        pathInfo.createEl("span", { text: "路径:", cls: "info-label" });
        pathInfo.createEl("span", { text: currentFile.path, cls: "info-value" });

        // 文件统计
        this.plugin.app.vault.read(currentFile).then(content => {
            const stats = this.getFileStats(content);

            const wordInfo = infoGrid.createDiv({ cls: "info-item" });
            wordInfo.createEl("span", { text: "字数:", cls: "info-label" });
            wordInfo.createEl("span", { text: stats.words.toString(), cls: "info-value" });

            const charInfo = infoGrid.createDiv({ cls: "info-item" });
            charInfo.createEl("span", { text: "字符数:", cls: "info-label" });
            charInfo.createEl("span", { text: stats.chars.toString(), cls: "info-value" });

            const lineInfo = infoGrid.createDiv({ cls: "info-item" });
            lineInfo.createEl("span", { text: "行数:", cls: "info-label" });
            lineInfo.createEl("span", { text: stats.lines.toString(), cls: "info-value" });
        });
    }

    // 获取文件统计信息
    getFileStats(content) {
        const lines = content.split('\n').length;
        const chars = content.length;
        const words = content.trim() ? content.trim().split(/\s+/).length : 0;

        return { lines, chars, words };
    }

    // 渲染AI状态监控
    renderAIStatus(container) {
        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: "🤖 AI状态监控" });

        const statusGrid = section.createDiv({ cls: "ai-assistant-status-grid" });

        // API状态
        const apiStatus = statusGrid.createDiv({ cls: "status-item" });
        apiStatus.createEl("span", { text: "API状态:", cls: "status-label" });
        const apiIndicator = apiStatus.createEl("span", { cls: "status-indicator" });

        if (this.plugin.settings.apiKey && this.plugin.settings.apiUrl) {
            apiIndicator.setText("🟢 已配置");
            apiIndicator.addClass("status-good");
        } else {
            apiIndicator.setText("🔴 未配置");
            apiIndicator.addClass("status-error");
        }



        // 模型信息
        const modelStatus = statusGrid.createDiv({ cls: "status-item" });
        modelStatus.createEl("span", { text: "主模型:", cls: "status-label" });
        modelStatus.createEl("span", {
            text: this.plugin.settings.modelName || "未设置",
            cls: "status-value"
        });
    }

    // 渲染最近处理历史
    renderRecentHistory(container) {
        const history = this.getRecentHistory();
        if (history.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: "📚 最近处理" });

        const historyList = section.createDiv({ cls: "ai-assistant-history-list" });

        // 过滤出仍然存在的文件，并更新路径信息
        const validHistory = [];
        const updatedHistory = [];

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

        // 如果历史记录有更新，保存到localStorage
        if (updatedHistory.length !== history.length ||
            updatedHistory.some((item, index) =>
                item.filePath !== history[index]?.filePath)) {
            localStorage.setItem('ai-assistant-history', JSON.stringify(updatedHistory));
        }

        if (validHistory.length === 0) {
            const emptyMessage = historyList.createDiv({ cls: "history-empty" });
            emptyMessage.textContent = "暂无有效的处理历史";
            return;
        }

        validHistory.slice(0, 5).forEach(item => { // 只显示最近5个
            const historyItem = historyList.createDiv({ cls: "history-item" });

            // 显示当前文件名（可能已更新）
            const fileNameSpan = historyItem.createEl("span", {
                text: item.fileName,
                cls: "history-filename"
            });

            // 如果文件被重命名，显示提示
            const file = this.findFileByHistory(item);
            if (file && file.path !== item.filePath) {
                fileNameSpan.title = `原路径: ${item.filePath}\n当前路径: ${file.path}`;
                fileNameSpan.addClass("history-renamed");
            }

            historyItem.createEl("span", {
                text: this.formatTime(item.timestamp),
                cls: "history-time"
            });

            historyItem.createEl("span", {
                text: item.action,
                cls: "history-action"
            });

            // 点击跳转到文件
            historyItem.addEventListener("click", () => {
                const file = this.findFileByHistory(item);
                if (file) {
                    this.plugin.app.workspace.getLeaf().openFile(file);
                } else {
                    // 在助手面板中显示错误信息
                    this.addTask({
                        id: Date.now().toString(),
                        type: 'error',
                        title: '文件访问错误',
                        status: 'displaying',
                        content: {
                            message: `文件 "${item.fileName}" 不存在或已被移动`,
                            type: 'error'
                        }
                    });
                }
            });
        });

        // 清理历史按钮
        const clearBtn = section.createEl("button", {
            text: "清理历史",
            cls: "ai-assistant-clear-history-btn"
        });
        clearBtn.addEventListener("click", () => {
            localStorage.removeItem('ai-assistant-history');
            this.render();
            // 在助手面板中显示成功信息
            this.addTask({
                id: Date.now().toString(),
                type: 'success',
                title: '历史记录已清理',
                status: 'displaying',
                content: {
                    message: '所有历史记录已成功清理',
                    type: 'success'
                }
            });
        });
    }

    // 获取最近处理历史
    getRecentHistory() {
        try {
            const history = localStorage.getItem('ai-assistant-history');
            return history ? JSON.parse(history) : [];
        } catch {
            return [];
        }
    }

    // 添加历史记录
    addToHistory(fileName, filePath, action, fileId = null) {
        const history = this.getRecentHistory();

        // 如果没有提供fileId，尝试从文件路径生成一个唯一标识
        if (!fileId) {
            const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
            fileId = file ? this.generateFileId(file) : filePath;
        }

        const newItem = {
            fileName,
            filePath,
            action,
            timestamp: Date.now(),
            fileId // 添加文件唯一标识
        };

        // 移除同一文件的重复操作记录
        const filtered = history.filter(item =>
            !(item.fileId === fileId && item.action === action)
        );

        // 添加新项到开头
        filtered.unshift(newItem);

        // 限制历史记录数量
        const limited = filtered.slice(0, 20);

        localStorage.setItem('ai-assistant-history', JSON.stringify(limited));
    }

    // 生成文件唯一标识
    generateFileId(file) {
        // 使用文件的创建时间和初始路径作为唯一标识
        // 这样即使文件被重命名或移动，我们仍能跟踪它
        return `${file.stat.ctime}-${file.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
    }

    // 查找文件的当前位置
    findFileByHistory(historyItem) {
        const allFiles = this.plugin.app.vault.getMarkdownFiles();

        // 首先尝试直接路径匹配
        let file = this.plugin.app.vault.getAbstractFileByPath(historyItem.filePath);
        if (file) return file;

        // 如果直接路径不存在，尝试通过文件ID查找
        if (historyItem.fileId) {
            for (const f of allFiles) {
                if (this.generateFileId(f) === historyItem.fileId) {
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
    formatTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;

        if (diff < 60000) return "刚刚";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
        return `${Math.floor(diff / 86400000)}天前`;
    }

    // 渲染使用统计
    renderUsageStats(container) {
        const history = this.getRecentHistory();
        if (history.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: "📊 使用统计" });

        const statsGrid = section.createDiv({ cls: "ai-assistant-stats-grid" });

        // 标准化action名称的映射
        const actionMapping = {
            "重命名+元数据": "重命名+元数据",
            "更新元数据": "重命名+元数据",
            "结构优化": "优化结构",
            "添加标签": "标签",
            "移动": "移动"
        };

        // 统计各种操作的次数，使用标准化的action名称
        const actionCounts = {};
        history.forEach(item => {
            // 标准化action名称
            let normalizedAction = item.action;

            // 处理包含数字的标签操作
            if (item.action.includes("标签")) {
                normalizedAction = "标签";
            } else if (actionMapping[item.action]) {
                normalizedAction = actionMapping[item.action];
            }

            actionCounts[normalizedAction] = (actionCounts[normalizedAction] || 0) + 1;
        });

        // 总处理次数
        const totalStat = statsGrid.createDiv({ cls: "stat-item" });
        totalStat.createEl("span", { text: "总处理次数:", cls: "stat-label" });
        totalStat.createEl("span", { text: history.length.toString(), cls: "stat-value" });

        // 最常用功能
        const mostUsed = Object.entries(actionCounts)
            .sort(([,a], [,b]) => b - a)[0];

        if (mostUsed) {
            const mostUsedStat = statsGrid.createDiv({ cls: "stat-item" });
            mostUsedStat.createEl("span", { text: "最常用功能:", cls: "stat-label" });
            mostUsedStat.createEl("span", {
                text: `${mostUsed[0]} (${mostUsed[1]}次)`,
                cls: "stat-value"
            });
        }

        // 今日处理次数
        const today = new Date().toDateString();
        const todayCount = history.filter(item =>
            new Date(item.timestamp).toDateString() === today
        ).length;

        const todayStat = statsGrid.createDiv({ cls: "stat-item" });
        todayStat.createEl("span", { text: "今日处理:", cls: "stat-label" });
        todayStat.createEl("span", { text: todayCount.toString(), cls: "stat-value" });


    }
}

class PromptEditModal extends Modal {
    constructor(app, plugin, settingName, title) {
        super(app);
        this.plugin = plugin;
        this.settingName = settingName;
        this.title = title;
        this.saved = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.title });

        new Setting(contentEl)
            .addTextArea(text => {
                text.setValue(this.plugin.settings[this.settingName])
                    .onChange(value => {
                        this.plugin.settings[this.settingName] = value;
                        this.saved = true; 
                    });
                text.inputEl.style.width = '100%';
                text.inputEl.style.height = '300px';
                text.inputEl.style.minHeight = '150px';
            });
            
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('保存')
                .setCta()
                .onClick(async () => {
                    if (this.saved) {
                       await this.plugin.saveSettings();
                       new Notice('Prompt 已保存!');
                    }
                    this.close();
                }));
    }
}


class CheckboxModal extends Modal {
    constructor(app, tags, onChoose) {
        super(app);
        this.tags = tags;
        this.onChoose = onChoose;
        this.selectedTags = [];
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '选择要添加的标签' });

        this.tags.forEach(tag => {
            new Setting(contentEl)
                .setName(tag.display)
                .addToggle(toggle => 
                    toggle.onChange(value => {
                        if (value) {
                            this.selectedTags.push(tag.final);
                        } else {
                            const index = this.selectedTags.indexOf(tag.final);
                            if (index > -1) {
                                this.selectedTags.splice(index, 1);
                            }
                        }
                    })
                );
        });

        new Setting(contentEl)
            .addButton(btn => 
                btn
                .setButtonText('添加选中标签')
                .setCta()
                .onClick(() => {
                    this.onChoose(this.selectedTags);
                    this.close();
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class SuggestionModal extends FuzzySuggestModal {
    constructor(app, items, onChoose) {
        super(app);
        this.items = items;
        this.onChoose = onChoose;
    }

    getItems() {
        return this.items;
    }

    getItemText(item) {
        return item.is_new ? `(创建新文件夹) ${item.path}` : item.path;
    }

    onChooseItem(item) {
        this.onChoose(item);
    }
}

// 批量文件选择模态框
class BatchFileSelectionModal extends Modal {
    constructor(app, files, onChoose) {
        super(app);
        this.files = files;
        this.onChoose = onChoose;
        this.selectedFiles = [];
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '选择要批量处理的文件' });

        // 全选/取消全选按钮
        const buttonContainer = contentEl.createDiv({ cls: 'batch-selection-buttons' });
        buttonContainer.style.marginBottom = '16px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '8px';

        const selectAllBtn = buttonContainer.createEl('button', { text: '全选' });
        selectAllBtn.onclick = () => {
            const checkboxes = contentEl.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = true);
            this.selectedFiles = [...this.files];
        };

        const deselectAllBtn = buttonContainer.createEl('button', { text: '取消全选' });
        deselectAllBtn.onclick = () => {
            const checkboxes = contentEl.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = false);
            this.selectedFiles = [];
        };

        // 文件列表
        const fileList = contentEl.createDiv({ cls: 'batch-file-list' });
        fileList.style.maxHeight = '400px';
        fileList.style.overflowY = 'auto';
        fileList.style.border = '1px solid var(--background-modifier-border)';
        fileList.style.borderRadius = '6px';
        fileList.style.padding = '8px';

        this.files.forEach(file => {
            const fileItem = fileList.createDiv({ cls: 'batch-file-item' });
            fileItem.style.display = 'flex';
            fileItem.style.alignItems = 'center';
            fileItem.style.padding = '4px 8px';
            fileItem.style.borderRadius = '4px';
            fileItem.style.marginBottom = '4px';

            const checkbox = fileItem.createEl('input', { type: 'checkbox' });
            checkbox.style.marginRight = '8px';
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    this.selectedFiles.push(file);
                } else {
                    this.selectedFiles = this.selectedFiles.filter(f => f !== file);
                }
            };

            const fileName = fileItem.createEl('span', { text: file.path });
            fileName.style.fontSize = 'var(--font-ui-small)';
        });

        // 确认按钮
        const confirmContainer = contentEl.createDiv();
        confirmContainer.style.marginTop = '16px';
        confirmContainer.style.textAlign = 'right';

        const confirmBtn = confirmContainer.createEl('button', { text: '开始批量处理' });
        confirmBtn.style.marginRight = '8px';
        confirmBtn.onclick = () => {
            this.close();
            this.onChoose(this.selectedFiles);
        };

        const cancelBtn = confirmContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => {
            this.close();
            this.onChoose(null);
        };
    }
}

class AiAssistantSuite extends Plugin {
  view = null;

  debounceTimers = new Map(); // 添加防抖定时器

  async onload() {
    console.log('Loading AI Assistant Suite...');
    await this.loadSettings();

    // 初始化快速操作面板
    this.quickActionsPanel = new QuickActionsPanel(this);



    this.registerView(
        ASSISTANT_VIEW_TYPE,
        (leaf) => (this.view = new AssistantView(leaf, this))
    );

    this.addRibbonIcon("anchor", "打开 AI 助手面板", () => {
        this.activateView();
    });

    // --- Ribbon Icon 1: Structurizer ---
    this.addRibbonIcon('brain-circuit', 'AI Structurizer - 优化笔记结构', () => {
      this.runAiStructurizer();
    });

    // --- Ribbon Icon 2: Mover ---
    this.addRibbonIcon('folder-input', 'AI Mover - 移动当前笔记', () => {
      this.runAiMover();
    });

    // --- Ribbon Icon 3: Tagger ---
    this.addRibbonIcon('tags', 'AI Tagger - 智能生成标签', () => {
      this.runAiTagger();
    });

    // --- Ribbon Icon 4: Meta ---
    this.addRibbonIcon('file-signature', 'AI Meta - 生成标题/摘要', () => {
      this.runAiMeta();
    });

    this.addCommand({
        id: 'open-ai-assistant-view',
        name: 'Open AI Assistant View (打开助手面板)',
        callback: () => {
            this.activateView();
        }
    });

    // --- Command 1: Structurizer ---
    this.addCommand({
      id: 'run-ai-structurizer',
      name: 'Run AI Suite: Restructure current note (优化结构)',
      callback: () => {
        this.runAiStructurizer();
      }
    });

    // --- Command 2: Mover ---
    this.addCommand({
        id: 'run-ai-mover',
        name: 'Run AI Suite: Move current note (移动笔记)',
        callback: () => {
            this.runAiMover();
        }
    });

    // --- Command 3: Tagger ---
    this.addCommand({
        id: 'run-ai-tagger',
        name: 'Run AI Suite: Tag current note (智能标签)',
        callback: () => {
            this.runAiTagger();
        }
    });

    // --- Command 4: Meta ---
    this.addCommand({
        id: 'run-ai-meta',
        name: 'Run AI Suite: Generate Metadata (生成元数据)',
        callback: () => {
            this.runAiMeta();
        }
    });

    this.addCommand({
        id: 'run-ai-one-click-process',
        name: 'AI Suite: One-click Smart Process Note (一键智能处理笔记)',
        hotkeys: [{ modifiers: ["Mod", "Shift"], key: "a" }],
        callback: () => {
            this.runOneClickSmartProcess();
        }
    });

    // 添加批量处理命令
    this.addCommand({
        id: 'run-ai-batch-process',
        name: 'AI Suite: Batch Process Files (批量处理文件)',
        callback: () => {
            this.runBatchProcess();
        }
    });

    // 添加快速切换侧边栏的命令
    this.addCommand({
        id: 'toggle-ai-assistant-view',
        name: 'AI Suite: Toggle Assistant Panel (切换助手面板)',
        hotkeys: [{ modifiers: ["Mod", "Alt"], key: "a" }],
        callback: () => {
            const leaves = this.app.workspace.getLeavesOfType(ASSISTANT_VIEW_TYPE);
            if (leaves.length > 0) {
                // 如果面板已打开，关闭它
                leaves[0].detach();
            } else {
                // 如果面板未打开，打开它
                this.activateView();
            }
        }
    });

    // 添加快速操作命令
    this.addCommand({
        id: 'ai-quick-summarize',
        name: 'AI Quick: Summarize (快速总结)',
        hotkeys: [{ modifiers: ["Ctrl"], key: "1" }],
        callback: () => {
            this.runQuickAction('summarize');
        }
    });

    this.addCommand({
        id: 'ai-quick-improve',
        name: 'AI Quick: Improve (快速优化)',
        hotkeys: [{ modifiers: ["Ctrl"], key: "2" }],
        callback: () => {
            this.runQuickAction('improve');
        }
    });

    this.addCommand({
        id: 'ai-quick-translate',
        name: 'AI Quick: Translate (快速翻译)',
        hotkeys: [{ modifiers: ["Ctrl"], key: "3" }],
        callback: () => {
            this.runQuickAction('translate');
        }
    });

    this.addCommand({
        id: 'ai-quick-explain',
        name: 'AI Quick: Explain (快速解释)',
        hotkeys: [{ modifiers: ["Ctrl"], key: "4" }],
        callback: () => {
            this.runQuickAction('explain');
        }
    });

    // 注册右键菜单
    this.registerEvent(
        this.app.workspace.on('editor-menu', (menu, editor, view) => {
            this.addQuickActionsToMenu(menu, editor, view);
        })
    );

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new AiAssistantSettingTab(this.app, this));
  }

  onunload() {
    console.log('Unloading AI Assistant Suite...');

    this.debounceTimers.clear();
  }



  // 验证文件名是否有效
  validateFileName(fileName) {
    // 检查文件名是否包含非法字符
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(fileName)) {
      throw new Error('文件名包含非法字符');
    }

    // 检查文件名长度
    if (fileName.length > 255) {
      throw new Error('文件名过长');
    }

    // 检查是否为空或只包含空格
    if (!fileName.trim()) {
      throw new Error('文件名不能为空');
    }

    return true;
  }

  // 安全重命名文件的辅助方法
  async safeRenameFile(oldFile, newPath) {
    try {
      // 验证新文件名
      const fileName = newPath.split('/').pop();
      this.validateFileName(fileName);

      // 检查目标路径是否已存在
      const existingFile = this.app.vault.getAbstractFileByPath(newPath);
      if (existingFile) {
        throw new Error(`目标文件 "${newPath}" 已存在`);
      }

      // 确保目标目录存在
      const dirPath = newPath.substring(0, newPath.lastIndexOf('/'));
      if (dirPath && !this.app.vault.getAbstractFileByPath(dirPath)) {
        // 如果目录不存在，创建它
        await this.app.vault.createFolder(dirPath);
      }

      // 执行重命名
      await this.app.fileManager.renameFile(oldFile, newPath);

      // 等待文件系统更新，然后重试获取文件
      let newFile = null;
      let retries = 0;
      const maxRetries = 10;

      while (!newFile && retries < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 50));
        newFile = this.app.vault.getAbstractFileByPath(newPath);
        retries++;
      }

      if (!newFile) {
        throw new Error(`重命名后无法找到文件: ${newPath}。请检查文件路径是否有效。`);
      }

      return newFile;
    } catch (error) {
      console.error('重命名文件时出错:', error);
      throw error;
    }
  }

  // 验证API配置
  async validateApiConfig() {
    if (!this.settings.apiKey || !this.settings.apiUrl) {
      return { valid: false, error: '请填写API Key和API URL' };
    }

    try {
      const testPrompt = "测试连接";
      const response = await fetch(this.settings.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
          model: this.settings.modelName,
          messages: [{ role: "user", content: testPrompt }],
          max_tokens: 10
        })
      });

      if (response.ok) {
        return { valid: true, error: null };
      } else {
        return { valid: false, error: `API响应错误: ${response.status}` };
      }
    } catch (error) {
      return { valid: false, error: `连接失败: ${error.message}` };
    }
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(ASSISTANT_VIEW_TYPE);
    // If view is not open, create it
    if (leaves.length === 0) {
        await this.app.workspace.getRightLeaf(false).setViewState({
            type: ASSISTANT_VIEW_TYPE,
            active: true,
        });
    }
    // Whether it was open or we just created it, reveal it
    this.app.workspace.revealLeaf(
        this.app.workspace.getLeavesOfType(ASSISTANT_VIEW_TYPE)[0]
    );
  }

  // 通用API请求方法
  async makeApiRequest(prompt, modelName = null) {
    if (!this.settings.apiKey || !this.settings.apiUrl) {
      throw new Error('请先在AI Assistant Suite插件设置中填写您的API Key和API URL。');
    }

    const model = modelName || this.settings.modelName;

    const response = await fetch(this.settings.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.settings.apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("API Error Response:", errorText);
      throw new Error(`AI 请求失败: ${response.status} ${response.statusText}. 响应内容: ${errorText.substring(0, 200)}`);
    }

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error("Failed to parse JSON response:", responseText);
      throw new Error(`API返回了无效的JSON响应。响应内容: ${responseText.substring(0, 200)}`);
    }

    return data;
  }

  // 批量处理文件
  async runBatchProcess(selectedFiles = null) {
    if (!selectedFiles) {
      const files = this.app.vault.getMarkdownFiles();
      selectedFiles = await this.showFileSelectionModal(files);
    }

    if (!selectedFiles || selectedFiles.length === 0) {
      await this.activateView();
      this.view.addTask({
        id: Date.now().toString(),
        type: 'batch-process',
        title: '批量处理',
        status: 'displaying',
        content: {
          message: '未选择任何文件',
          type: 'error'
        }
      });
      return;
    }

    // 设置中断标志
    this.batchProcessInterrupted = false;

    // 在助手面板中显示进度
    await this.activateView();
    const taskId = Date.now().toString();
    this.view.addTask({
      id: taskId,
      type: 'batch-process',
      title: '批量处理进行中',
      status: 'displaying',
      content: {
        totalFiles: selectedFiles.length,
        processedCount: 0,
        errorCount: 0,
        currentFile: '',
        canInterrupt: true
      }
    });

    let processedCount = 0;
    let errorCount = 0;

    for (const file of selectedFiles) {
      // 检查是否被中断
      if (this.batchProcessInterrupted) {
        this.view.updateTask(taskId, {
          title: '批量处理已中断',
          content: {
            ...this.view.getTask(taskId).content,
            processedCount,
            errorCount,
            canInterrupt: false,
            message: `处理已中断！已处理: ${processedCount}, 失败: ${errorCount}`
          }
        });
        return;
      }

      try {
        // 更新进度
        this.view.updateTask(taskId, {
          content: {
            ...this.view.getTask(taskId).content,
            processedCount: processedCount + 1,
            errorCount,
            currentFile: file.basename
          }
        });

        // 设置当前文件为活动文件
        await this.app.workspace.getLeaf().openFile(file);

        // 运行一键处理
        await this.runOneClickSmartProcess();

        processedCount++;

        // 添加延迟以避免API限制
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`处理文件 ${file.basename} 时出错:`, error);
        errorCount++;
      }
    }

    // 完成处理
    this.view.updateTask(taskId, {
      title: '批量处理完成',
      content: {
        ...this.view.getTask(taskId).content,
        processedCount,
        errorCount,
        canInterrupt: false,
        message: `批量处理完成！成功: ${processedCount}, 失败: ${errorCount}`
      }
    });
  }

  // 文件夹批量处理
  async runFolderBatchProcess(folderPath) {
    const allFiles = this.app.vault.getMarkdownFiles();
    const folderFiles = allFiles.filter(file => file.path.startsWith(folderPath + '/'));

    if (folderFiles.length === 0) {
      await this.activateView();
      this.view.addTask({
        id: Date.now().toString(),
        type: 'batch-process',
        title: '文件夹批量处理',
        status: 'displaying',
        content: {
          message: `文件夹 "${folderPath}" 中没有找到 Markdown 文件`,
          type: 'error'
        }
      });
      return;
    }

    // 在助手面板中显示确认信息
    await this.activateView();
    const taskId = Date.now().toString();
    this.view.addTask({
      id: taskId,
      type: 'folder-batch-confirm',
      title: '确认文件夹批量处理',
      status: 'displaying',
      content: {
        folderPath,
        fileCount: folderFiles.length,
        files: folderFiles
      }
    });
  }

  // 显示文件选择模态框
  async showFileSelectionModal(files) {
    return new Promise((resolve) => {
      new BatchFileSelectionModal(this.app, files, resolve).open();
    });
  }

  async runAiStructurizer(showCompletionCard = true) {
    const app = this.app;

    if (!this.settings.apiKey || !this.settings.apiUrl) {
      new Notice('请先在AI Assistant Suite插件设置中填写您的API Key和API URL。');
      return;
    }
    
    const currentFile = app.workspace.getActiveFile();
    if (!currentFile) {
      new Notice("没有活动的笔记文件。");
      return;
    }

    let contentToProcess = "";
    const activeEditor = app.workspace.activeEditor?.editor;
    let isSelection = false;
    let originalFrontmatter = "";

    if (activeEditor && activeEditor.getSelection()) {
      contentToProcess = activeEditor.getSelection();
      isSelection = true;
    } else {
      const fullFileContent = await app.vault.read(currentFile);
      const fileCache = app.metadataCache.getFileCache(currentFile);
      
      let fmFoundByAPI = false;
      if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position && fileCache.frontmatter.position.end.offset) {
        const fmEndOffset = fileCache.frontmatter.position.end.offset;
        originalFrontmatter = fullFileContent.substring(0, fmEndOffset);
        contentToProcess = fullFileContent.substring(fmEndOffset);
        fmFoundByAPI = true;
      }

      if (!fmFoundByAPI && fullFileContent.trim().startsWith('---')) {
          const match = fullFileContent.match(/^(---[\s\S]*?---\s*)/);
          if (match) {
              originalFrontmatter = match[1];
              contentToProcess = fullFileContent.substring(originalFrontmatter.length);
          } else {
              contentToProcess = fullFileContent;
          }
      } else if (!fmFoundByAPI) {
          contentToProcess = fullFileContent;
      }
    }

    if (!contentToProcess || contentToProcess.trim() === "") {
      new Notice("笔记或选中内容为空，无需处理。");
      return;
    }

    let progressNotice = new Notice("AI 正在重构您的笔记结构...", 0);
    try {
      const prompt = this.getStructurizerPrompt(contentToProcess);
      
      const response = await fetch(this.settings.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + this.settings.apiKey },
        body: JSON.stringify({ model: this.settings.modelName, messages: [{ role: "user", content: prompt }] })
      });

      if (!response.ok) { throw new Error(`AI 请求失败: ${response.status} ${response.statusText}`); }
      
      const data = await response.json();
      const newContent = data.choices[0]?.message?.content;
      if (!newContent) { throw new Error("AI未能返回有效内容。"); }

      if (isSelection) {
        if(activeEditor) activeEditor.replaceSelection(newContent);
      } else {
        const finalContent = originalFrontmatter + newContent.trim();
        if (activeEditor) activeEditor.setValue(finalContent);
        else await app.vault.modify(currentFile, finalContent);
      }

      progressNotice.hide();
      new Notice("笔记结构已成功优化！", 5000);

      // 添加到历史记录
      if (this.view) {
        this.view.addToHistory(currentFile.basename, currentFile.path, "结构优化", this.view.generateFileId(currentFile));
      }

      if (showCompletionCard) {
        await this.activateView();
        const taskId = `structurizer-${Date.now()}`;
        this.view.addTask({
            id: taskId,
            type: 'structurizer',
            status: 'displaying',
            title: `结构优化完成: ${currentFile.basename}`,
            content: { file: currentFile }
        });
      }

    } catch (error) {
      progressNotice?.hide();
      new Notice(`处理失败: ${error.message}`, 0);
      console.error("AI Structurizer Error:", error);
    }
  }

  async runAiMover() {
    const app = this.app;
    const currentFile = app.workspace.getActiveFile();

    if (!currentFile) {
        new Notice("没有活动的笔记文件。");
        return;
    }
     if (!this.settings.apiKey || !this.settings.apiUrl) {
      new Notice('请先在AI Assistant Suite插件设置中填写您的API Key和API URL。');
      return;
    }

    let progressNotice = new Notice("正在准备 AI 文件助手...", 0);

    try {
        progressNotice.setMessage("正在扫描仓库文件夹...");

        const ignoredFoldersList = this.settings.ignoredFolders.split('\n').map(f => f.trim()).filter(Boolean);
        
        const allAbstractFiles = app.vault.getAllLoadedFiles();
        const folderPaths = allAbstractFiles
            .filter(file => file.children) 
            .map(folder => folder.path)
            .filter(path => {
                if (path === '/') return false;
                return !ignoredFoldersList.some(ignoredFolder => path.startsWith(ignoredFolder));
            });

        if (folderPaths.length === 0) {
            throw new Error("仓库中未能找到任何可用的文件夹。请检查忽略文件夹列表设置。");
        }
        
        progressNotice.setMessage("正在读取当前笔记内容...");
        const fileText = await app.vault.read(currentFile);
        const fileCache = app.metadataCache.getFileCache(currentFile);
        let content = fileText;
        if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position) {
            content = fileText.substring(fileCache.frontmatter.position.end.offset).trim();
        }
        if (!content) {
            throw new Error("笔记内容为空。");
        }
  
        progressNotice.setMessage("正在请求 AI 分析最佳文件夹...");
        const prompt = this.getMoverPrompt(folderPaths, content);
        const response = await fetch(this.settings.apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.apiKey}` },
            body: JSON.stringify({
                model: this.settings.modelName,
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" },
            })
        });
  
        if (!response.ok) throw new Error(`AI 请求失败: ${response.status} ${response.statusText}`);
        
        const data = await response.json();
        const messageContent = data.choices[0]?.message?.content;
        if (!messageContent) throw new Error("AI未能返回有效内容。");
        
        let parsedContent;
        try {
            let contentToParse = messageContent.match(/```json\n([\s\S]*?)\n```/)?.[1] || messageContent;
            parsedContent = JSON.parse(contentToParse);
        } catch (e) {
            console.error("解析AI返回的JSON时出错:", e, "原始返回内容:", messageContent);
            throw new Error("无法解析AI返回的JSON。");
        }
        
        const { suggestions } = parsedContent;
        if (!suggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
            throw new Error("AI未能提供有效的路径建议。");
        }

        progressNotice.hide();
        
        await this.activateView();
        
        const taskId = `mover-${Date.now()}`;
        this.view.addTask({
            id: taskId,
            type: 'mover',
            status: 'displaying',
            title: `移动笔记: ${currentFile.basename}`,
            content: { suggestions: suggestions, file: currentFile }
        });

    } catch (error) {
        if (progressNotice) progressNotice.hide();
        new Notice(`处理失败: ${error.message}`, 0);
        console.error("aiMover Script Error:", error);
    }
  }

  async runAiTagger() {
    const app = this.app;
    const currentFile = app.workspace.getActiveFile();

    if (!currentFile) {
      new Notice("没有活动的笔记文件。");
      return;
    }
     if (!this.settings.apiKey || !this.settings.apiUrl) {
      new Notice('请先在AI Assistant Suite插件设置中填写您的API Key和API URL。');
      return;
    }

    let content = "";
    const activeEditor = app.workspace.activeEditor?.editor;
    if (activeEditor) {
        const selection = activeEditor.getSelection();
        if (selection) {
            content = selection;
        } else {
            content = activeEditor.getValue();
        }
    } else {
        content = await app.vault.read(currentFile);
    }

    if (!content || content.trim() === "") {
      new Notice("笔记内容为空。");
      return;
    }

    let progressNotice = new Notice("正在准备 AI 标签助手...", 0);
    try {
      progressNotice.setMessage("正在扫描知识库中的所有标签...");
      const allTagsFromCache = this.app.metadataCache.getTags();
      const existingTags = Object.keys(allTagsFromCache).map(tag => tag.substring(1));

      progressNotice.setMessage("正在请求 AI 生成初步标签...");
      const taggerPrompt = this.getTaggerPrompt(existingTags, content);

      await this.activateView();
      const taskId = `tagger-${Date.now()}`;
      this.view.addTask({
          id: taskId,
          type: 'tagger',
          status: 'loading',
          title: `标签建议: ${currentFile.basename}`
      });
      
      const response = await fetch(this.settings.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + this.settings.apiKey },
        body: JSON.stringify({
          model: this.settings.modelName,
          messages: [{ role: "user", content: taggerPrompt }],
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`AI初步标签请求失败: ${response.status}. ${errorData.error?.message || ''}`);
      }

      const data = await response.json();
      let rawTagsContent = data.choices[0]?.message?.content;
      if (!rawTagsContent) throw new Error("AI未能返回有效内容。");
      
      const prefixesToRemove = [
        /好的，这是从文本中提取的标签：/i,
        /当然，这是标签列表：/i,
        /以下是建议的标签：/i,
        /这是从文本中提取的标签：/i,
      ];
      for (const prefixRegex of prefixesToRemove) {
          rawTagsContent = rawTagsContent.replace(prefixRegex, "");
      }
      rawTagsContent = rawTagsContent.trim();
      rawTagsContent = rawTagsContent.replace(/\s*-\s*\*\*[^*]+\*\*\s*[:：-]?\s*/g, "");
      rawTagsContent = rawTagsContent.replace(/```/g, "").trim();

      const rawAiTags = rawTagsContent.split(/[,，]/).map(tag => tag.replace(/[*-]/g, "").trim()).filter(Boolean);

      if (rawAiTags.length === 0) {
        throw new Error("AI 未能生成任何初步标签。");
      }

      let processedTags = [...rawAiTags];
      if (this.settings.taggerEnableTranslation) {
        const tagsToTranslate = [];
        const originalIndicesOfTagsToTranslate = [];

        rawAiTags.forEach((tag, index) => {
          const isLikelyEnglish = !/[\u3000-\u303F\u4e00-\u9fff\uff00-\uffef]/.test(tag);
          if (isLikelyEnglish && tag.length >= this.settings.taggerTranslationMinLength) {
            tagsToTranslate.push(tag);
            originalIndicesOfTagsToTranslate.push(index);
          }
        });

        if (tagsToTranslate.length > 0) {
          progressNotice.setMessage(`检测到 ${tagsToTranslate.length} 个长英文标签，正在翻译...`);
          const translationPrompt = this.getTranslationPrompt(tagsToTranslate);
          try {
            const translationResponse = await fetch(this.settings.apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.apiKey}` },
                body: JSON.stringify({
                    model: this.settings.auxiliaryModelName,
                    messages: [{ role: "user", content: translationPrompt }],
                })
            });

            if (translationResponse.ok) {
                const translationData = await translationResponse.json();
                const translations = translationData.choices?.[0]?.message?.content.trim().split('\n');
                if (translations && translations.length === tagsToTranslate.length) {
                    translations.forEach((translatedTag, i) => {
                        const originalIndex = originalIndicesOfTagsToTranslate[i];
                        processedTags[originalIndex] = translatedTag.trim();
                    });
                    progressNotice.setMessage("翻译完成，准备显示选项...");
                } else {
                    new Notice("翻译结果数量与请求不符，跳过翻译。", 3000);
                }
            } else {
                new Notice(`翻译API请求失败: ${translationResponse.status}.`, 3000);
            }
          } catch (translationError) {
              new Notice("翻译过程中发生错误。", 3000);
              console.error("Error during translation fetch:", translationError);
          }
        }
      }

      const tagsForPrompt = [];
      processedTags.forEach(tag => {
        const finalTag = tag.replace(/\s+/g, '-').replace(/，/g, '-');
        const isNew = !existingTags.includes(finalTag);
        tagsForPrompt.push({ display: finalTag, final: finalTag, is_new: isNew });
      });

      progressNotice.hide();

      this.view.updateTask(taskId, {
          status: 'displaying',
          content: { suggestions: tagsForPrompt, file: currentFile }
      });

    } catch (error) {
      progressNotice?.hide();
      this.view.removeTask(taskId);
      new Notice(`处理失败: ${error.message}`, 0);
      console.error("AI Tagger Error:", error);
    }
  }

  async runAiMeta() {
    const app = this.app;
    const currentFile = app.workspace.getActiveFile();

    if (!currentFile) {
      new Notice("没有活动的笔记文件。");
      return;
    }
     if (!this.settings.apiKey || !this.settings.apiUrl) {
      new Notice('请先在AI Assistant Suite插件设置中填写您的API Key和API URL。');
      return;
    }

    let progressNotice = new Notice("正在准备 AI 元数据助手...", 0);
    try {
        let fileText = await app.vault.read(currentFile);
        const fileCache = app.metadataCache.getFileCache(currentFile);
        let content = fileText;
        if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position) {
            content = fileText.substring(fileCache.frontmatter.position.end.offset).trim();
        }

        const editor = app.workspace.activeEditor?.editor;
        if (editor && editor.getSelection()) {
            const selection = editor.getSelection();
            if (selection.trim()) {
                content = selection;
                new Notice("使用选中文本生成元数据...");
            }
        }

        if (!content || content.trim() === "") {
            throw new Error("笔记内容为空，无法生成元数据。");
        }

        progressNotice.setMessage("正在请求 AI 生成标题和摘要...");
        const prompt = this.getMetaPrompt(content);
        const response = await fetch(this.settings.apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.apiKey}` },
            body: JSON.stringify({
                model: this.settings.modelName,
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" },
            })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API 请求失败: ${response.status}. ${errorText}`);
        }

        const data = await response.json();
        const messageContent = data.choices[0]?.message?.content;
        if (!messageContent) throw new Error("AI未能返回有效内容。");

        let parsedContent;
        try {
            const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
            parsedContent = JSON.parse(jsonMatch ? jsonMatch[1] : messageContent);
        } catch (e) {
            throw new Error(`无法解析AI返回的JSON: ${e.message}`);
        }

        const { title, summary, tldr } = parsedContent;
        if (!title || !summary || !tldr) {
            throw new Error("AI返回的JSON中缺少必要字段。");
        }

        progressNotice.hide();

        const sanitizedTitle = title.trim().replace(/[/\\:?*"<>|]/g, '-');
        const finalFilename = sanitizedTitle.substring(0, this.settings.metaFileNameMaxLength);
        const newPath = `${currentFile.parent.path}/${finalFilename}.md`;
        
        await this.activateView();
        const taskId = `meta-${Date.now()}`;
        this.view.addTask({
            id: taskId,
            type: 'meta',
            status: 'displaying',
            title: `元数据建议: ${currentFile.basename}`,
            content: { title, summary, tldr, finalFilename, newPath, file: currentFile }
        });

    } catch (error) {
        progressNotice?.hide();
        new Notice(`处理失败: ${error.message}`, 0);
        console.error("AI Meta Error:", error);
    }
  }

  async runOneClickSmartProcess() {
    const app = this.app;
    let currentFile = app.workspace.getActiveFile();

    if (!currentFile) {
        new Notice("没有活动的笔记文件。");
        return;
    }
    if (!this.settings.apiKey || !this.settings.apiUrl) {
        new Notice('请先在AI Assistant Suite插件设置中填写您的API Key和API URL。');
        return;
    }

    const { oneClickProcessActions } = this.settings;
    const actions = Object.keys(oneClickProcessActions).filter(k => oneClickProcessActions[k]);

    if (actions.length === 0) {
        new Notice('没有在设置中启用任何"一键处理"步骤。');
        return;
    }

    let progressNotice = new Notice("启动一键智能处理...", 0);

    try {
        // --- 1. Structurizer (if enabled) ---
        if (oneClickProcessActions.structurizer) {
            progressNotice.setMessage("正在优化笔记结构...");
            await this.runAiStructurizer(false);
            // Re-read file content after potential modification
            currentFile = app.workspace.getActiveFile(); 
        }

        const interactiveActions = actions.filter(a => a !== 'structurizer');
        if (interactiveActions.length === 0) {
            progressNotice.hide();
            new Notice("结构优化完成。没有其他已启用的处理步骤。");
            return;
        }

        // --- 2. Prepare for combined AI call ---
        progressNotice.setMessage("正在准备组合式 AI 请求...");
        let contentToProcess = await app.vault.read(currentFile);
        const fileCache = app.metadataCache.getFileCache(currentFile);
        if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position) {
            contentToProcess = contentToProcess.substring(fileCache.frontmatter.position.end.offset).trim();
        }
        if (!contentToProcess) throw new Error("笔记内容为空。");

        let contextForPrompt = "";
        let jsonStructure = {};
        
        if (oneClickProcessActions.tagger) {
            const allTagsFromCache = this.app.metadataCache.getTags();
            const existingTags = Object.keys(allTagsFromCache).map(tag => tag.substring(1));
            contextForPrompt += `\n\n**现有标签列表 (你的风格指南):**\n${existingTags.join(', ')}`;
            jsonStructure.tags = ["tag1/subtag", "tag2"];
        }
        if (oneClickProcessActions.mover) {
            const ignoredFoldersList = this.settings.ignoredFolders.split('\n').map(f => f.trim()).filter(Boolean);
            const folderPaths = app.vault.getAllLoadedFiles()
                .filter(file => file.children)
                .map(folder => folder.path)
                .filter(path => path !== '/' && !ignoredFoldersList.some(ignored => path.startsWith(ignored)));
            contextForPrompt += `\n\n**现有文件夹列表 (供你参考和选择):**\n${JSON.stringify(folderPaths, null, 2)}`;
            jsonStructure.mover_suggestions = [{ path: "path/to/folder", is_new: false }];
        }
        if (oneClickProcessActions.meta) {
            jsonStructure.meta = { title: "string", summary: "string", tldr: "string" };
        }

        let prompt = `你是一个强大的多任务AI助手。请基于以下提供的文本，执行所有请求的任务。

**核心规则**:
1. 在分析时，请**专注于文本内容本身**，忽略任何Markdown链接或嵌入文件（如 \`![...]]\` 或 \`[...](...)\`）所指向的视觉或外部信息。
2. 你的回答必须是一个严格遵守以下结构的JSON对象。

**任务列表:**
${oneClickProcessActions.meta ? `- **生成元数据**: 生成一个极其简洁的标题（14个字以内）、一段简短摘要（3-4句话）、以及一个一句话总结（25个字以内）。\n` : ''}${oneClickProcessActions.tagger ? `- **生成标签**: 提供约 ${this.settings.taggerSuggestionsCount} 个标签。优先使用"现有标签列表"中的标签，新标签必须是层级格式 (如 a/b/c)。\n` : ''}${oneClickProcessActions.mover ? `- **建议文件夹**: 提供 ${this.settings.moverSuggestionsCount} 个最合适的存放路径建议，可以从"现有文件夹列表"中选择或创造新的。\n` : ''}
**JSON 输出格式:**
\`\`\`json
${JSON.stringify(jsonStructure, null, 2)}
\`\`\`
${contextForPrompt}

**需要处理的文本如下：**
\n\n${contentToProcess}`;

        progressNotice.setMessage("正在请求 AI 进行综合分析...");

        const response = await fetch(this.settings.apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.apiKey}` },
            body: JSON.stringify({
                model: this.settings.modelName,
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" },
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("API Error Response:", errorText);
            throw new Error(`AI 请求失败: ${response.status} ${response.statusText}. 响应内容: ${errorText.substring(0, 200)}`);
        }

        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.error("Failed to parse JSON response:", responseText);
            throw new Error(`API返回了无效的JSON响应。响应内容: ${responseText.substring(0, 200)}`);
        }
        const messageContent = data.choices[0]?.message?.content;
        if (!messageContent) throw new Error("AI未能返回有效内容。");
        
        let parsedContent;
        try {
            const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
            const contentToParse = jsonMatch ? jsonMatch[1] : messageContent;
            parsedContent = JSON.parse(contentToParse);
        } catch (e) {
            console.error("解析AI返回的JSON时出错:", e, "原始返回内容:", messageContent);
            throw new Error("无法解析AI返回的JSON。");
        }

        // --- 3. Process Tagger results if present (incl. translation) ---
        let tagSuggestions = [];
        if (parsedContent.tags) {
            // Processing similar to runAiTagger...
            const rawAiTags = parsedContent.tags;
            const existingTags = Object.keys(this.app.metadataCache.getTags()).map(tag => tag.substring(1));
            let processedTags = [...rawAiTags];
            
            // Add translation logic for long english tags
            if (this.settings.taggerEnableTranslation && rawAiTags.length > 0) {
                const tagsToTranslate = [];
                const originalIndicesOfTagsToTranslate = [];

                rawAiTags.forEach((tag, index) => {
                    const isLikelyEnglish = !/[\u3000-\u303F\u4e00-\u9fff\uff00-\uffef]/.test(tag);
                    if (isLikelyEnglish && tag.length >= this.settings.taggerTranslationMinLength) {
                        tagsToTranslate.push(tag);
                        originalIndicesOfTagsToTranslate.push(index);
                    }
                });

                if (tagsToTranslate.length > 0) {
                    progressNotice.setMessage(`检测到 ${tagsToTranslate.length} 个长英文标签，正在翻译...`);
                    const translationPrompt = this.getTranslationPrompt(tagsToTranslate);
                    try {
                        const translationResponse = await fetch(this.settings.apiUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.apiKey}` },
                            body: JSON.stringify({
                                model: this.settings.auxiliaryModelName,
                                messages: [{ role: "user", content: translationPrompt }],
                            })
                        });

                        if (translationResponse.ok) {
                            const translationData = await translationResponse.json();
                            const translations = translationData.choices?.[0]?.message?.content.trim().split('\n');
                            if (translations && translations.length === tagsToTranslate.length) {
                                translations.forEach((translatedTag, i) => {
                                    const originalIndex = originalIndicesOfTagsToTranslate[i];
                                    processedTags[originalIndex] = translatedTag.trim();
                                });
                                progressNotice.setMessage("翻译完成，准备显示选项...");
                            } else {
                                new Notice("翻译结果数量与请求不符，跳过翻译。", 3000);
                            }
                        } else {
                            new Notice(`翻译API请求失败: ${translationResponse.status}.`, 3000);
                        }
                    } catch (translationError) {
                        new Notice("翻译过程中发生错误。", 3000);
                        console.error("Error during translation fetch:", translationError);
                    }
                }
            }

            tagSuggestions = processedTags.map(tag => {
                const finalTag = tag.replace(/\s+/g, '-').replace(/，/g, '-');
                const isNew = !existingTags.includes(finalTag);
                return { display: finalTag, final: finalTag, is_new: isNew };
            });
        }
        
        // --- 4. Display results in sidebar ---
        await this.activateView();
        const taskId = `one-click-${Date.now()}`;
        this.view.addTask({
            id: taskId,
            type: 'one-click',
            status: 'displaying',
            title: `智能处理建议: ${currentFile.basename}`,
            content: {
                suggestions: {
                    meta: parsedContent.meta,
                    tags: tagSuggestions.length > 0 ? tagSuggestions : null,
                    mover: parsedContent.mover_suggestions,
                },
                file: currentFile 
            }
        });

        progressNotice.hide();

    } catch (error) {
        progressNotice?.hide();
        new Notice(`一键处理失败: ${error.message}`, 0);
        console.error("One Click Process Error:", error);
    }
  }

  // 快速操作方法
  async runQuickAction(actionId) {
    const currentFile = this.app.workspace.getActiveFile();
    if (!currentFile) {
        new Notice("没有活动的笔记文件。");
        return;
    }

    // 获取选中的文本或整个文件内容
    let content = "";
    const activeEditor = this.app.workspace.activeEditor?.editor;
    if (activeEditor) {
        const selection = activeEditor.getSelection();
        if (selection) {
            content = selection;
        } else {
            content = activeEditor.getValue();
        }
    } else {
        content = await this.app.vault.read(currentFile);
    }

    if (!content || content.trim() === "") {
        new Notice("没有内容可以处理。");
        return;
    }

    await this.runQuickActionWithText(actionId, content);
  }

  async runQuickActionWithText(actionId, content) {
    if (!this.settings.apiKey || !this.settings.apiUrl) {
        new Notice('请先在AI Assistant Suite插件设置中填写您的API Key和API URL。');
        return;
    }

    const action = this.quickActionsPanel.quickActions.find(a => a.id === actionId);
    if (!action) {
        new Notice(`未找到操作: ${actionId}`);
        return;
    }

    const prompt = action.prompt.replace('{{content}}', content);
    let progressNotice = new Notice(`正在执行${action.name}...`, 0);

    try {
        const response = await fetch(this.settings.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + this.settings.apiKey
            },
            body: JSON.stringify({
                model: this.settings.auxiliaryModelName || this.settings.modelName,
                messages: [{ role: "user", content: prompt }],
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`AI请求失败: ${response.status}. ${errorData.error?.message || ''}`);
        }

        const data = await response.json();
        const result = data.choices[0]?.message?.content;
        if (!result) {
            throw new Error("AI未能返回有效内容。");
        }

        progressNotice.hide();

        // 显示结果
        await this.activateView();
        const taskId = `quick-action-${Date.now()}`;
        this.view.addTask({
            id: taskId,
            type: 'quick-action',
            status: 'displaying',
            title: `${action.icon} ${action.name}结果`,
            content: {
                action: action.name,
                result: result,
                originalContent: content.length > 200 ? content.substring(0, 200) + "..." : content
            }
        });

    } catch (error) {
        progressNotice?.hide();
        new Notice(`${action.name}失败: ${error.message}`, 0);
        console.error("Quick Action Error:", error);
    }
  }

  // 添加快速操作到右键菜单
  addQuickActionsToMenu(menu, editor, view) {
    const selection = editor.getSelection();
    if (!selection) return;

    // 添加分隔符
    menu.addSeparator();

    // 添加快速操作子菜单
    const quickActionsSubmenu = menu.addItem((item) => {
        item.setTitle("🚀 AI快速操作")
            .setIcon("zap");
    });

    this.quickActionsPanel.quickActions.forEach(action => {
        quickActionsSubmenu.addItem((item) => {
            item.setTitle(`${action.icon} ${action.name}`)
                .onClick(() => {
                    this.runQuickActionWithText(action.id, selection);
                });
        });
    });
  }

  async updateFrontmatter(file, title, summary, tldr) {
      let progressNotice = new Notice("正在更新笔记元数据...", 0);
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm.title = title.trim();
            if (!fm.summary) fm.summary = summary.trim();
            if (!fm.tldr) fm.tldr = tldr.trim();
        });
        progressNotice.hide();
        new Notice("笔记元数据已成功更新！", 5000);
      } catch (err) {
        progressNotice.hide();
        new Notice(`更新Frontmatter时出错: ${err.message}`, 0);
      }
  }

  getMetaPrompt(content) {
    return this.settings.metaPrompt.replace('{{content}}', content);
  }

  getTaggerPrompt(existingTags, content) {
    return this.settings.taggerPrompt
        .replace('{{existing_tags}}', existingTags.join('， '))
        .replace('{{content}}', content)
        .replace('{{count}}', this.settings.taggerSuggestionsCount);
  }

  getMoverPrompt(folderPaths, content) {
    return this.settings.moverPrompt
        .replace('{{folder_list}}', JSON.stringify(folderPaths, null, 2))
        .replace('{{content}}', content)
        .replace('{{count}}', this.settings.moverSuggestionsCount);
  }

  getTranslationPrompt(phrases) {
      return this.settings.translationPrompt
          .replace('{{target_language}}', this.settings.taggerTranslationTargetLanguage)
          .replace('{{phrases_to_translate}}', phrases.join('\n'));
  }

  getStructurizerPrompt(contentToProcess) {
    return this.settings.structurizerPrompt.replace('{{content}}', contentToProcess);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class AiAssistantSettingTab extends PluginSettingTab {
	plugin;

	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: 'AI Assistant Suite Settings'});

        containerEl.createEl('h3', { text: 'API 设置' });

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('在这里填入你的AI服务API密钥。')
			.addText(text => text
				.setPlaceholder('Enter your API key')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API URL')
			.setDesc('在这里填入你的AI服务API URL，例如本地模型的地址。')
			.addText(text => text
				.setPlaceholder('https://api.example.com/v1/chat/completions')
				.setValue(this.plugin.settings.apiUrl)
				.onChange(async (value) => {
					this.plugin.settings.apiUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('AI 主模型名称 (Main Model Name)')
			.setDesc('指定用于内容生成、分析等核心任务的 AI 模型。')
			.addText(text => text
				.setPlaceholder('e.g., gemini-2.5-pro')
				.setValue(this.plugin.settings.modelName)
				.onChange(async (value) => {
					this.plugin.settings.modelName = value;
					await this.plugin.saveSettings();
				}));
        
        new Setting(containerEl)
            .setName('AI 辅助模型名称 (Auxiliary Model Name)')
            .setDesc('指定用于翻译等轻量级任务的 AI 模型，可以选一个更快的。')
            .addText(text => text
                .setPlaceholder('e.g., gemini-2.5-flash')
                .setValue(this.plugin.settings.auxiliaryModelName)
                .onChange(async (value) => {
                    this.plugin.settings.auxiliaryModelName = value;
                    await this.plugin.saveSettings();
                }));



        containerEl.createEl('h3', { text: '功能参数设置' });

        // -- Mover --
        containerEl.createEl('h4', { text: 'AI Mover' });
        new Setting(containerEl)
            .setName('建议数量')
            .setDesc('AI Mover 建议移动的目标文件夹数量。')
            .addText(text => text
                .setPlaceholder('4')
                .setValue(this.plugin.settings.moverSuggestionsCount)
                .onChange(async (value) => {
                    this.plugin.settings.moverSuggestionsCount = parseInt(value, 10) || 4;
                    await this.plugin.saveSettings();
                }));
        
		new Setting(containerEl)
			.setName('忽略的文件夹 (Ignored Folders)')
			.setDesc('AI Mover功能将忽略这些文件夹及其子文件夹。每行一个文件夹路径。')
			.addTextArea(text => text
				.setPlaceholder('例如：\n40 - Obsidian\nTemplates\nAttachments')
				.setValue(this.plugin.settings.ignoredFolders)
				.onChange(async (value) => {
					this.plugin.settings.ignoredFolders = value;
					await this.plugin.saveSettings();
				}));
        
        // -- Tagger --
        containerEl.createEl('h4', { text: 'AI Tagger' });
        new Setting(containerEl)
            .setName('建议数量')
            .setDesc('AI Tagger 建议的标签数量。')
            .addText(text => text
                .setPlaceholder('12')
                .setValue(this.plugin.settings.taggerSuggestionsCount)
                .onChange(async (value) => {
                    this.plugin.settings.taggerSuggestionsCount = parseInt(value, 10) || 12;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('翻译长英文标签')
            .setDesc('启用后，会自动将 AI 生成的过长的英文标签翻译成更简洁的目标语言标签。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.taggerEnableTranslation)
                .onChange(async (value) => {
                    this.plugin.settings.taggerEnableTranslation = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide related settings
                }));
        
        if (this.plugin.settings.taggerEnableTranslation) {
            new Setting(containerEl)
                .setName('触发翻译的最小长度')
                .setDesc('当一个英文标签的长度达到此值时，会触发自动翻译。')
                .addText(text => text
                    .setPlaceholder('16')
                    .setValue(this.plugin.settings.taggerTranslationMinLength)
                    .onChange(async (value) => {
                        this.plugin.settings.taggerTranslationMinLength = parseInt(value, 10) || 16;
                        await this.plugin.saveSettings();
                    }));
            
            new Setting(containerEl)
                .setName('目标翻译语言')
                .setDesc('指定长标签的目标翻译语言。')
                .addText(text => text
                    .setPlaceholder('中文')
                    .setValue(this.plugin.settings.taggerTranslationTargetLanguage)
                    .onChange(async (value) => {
                        this.plugin.settings.taggerTranslationTargetLanguage = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // -- Meta --
        containerEl.createEl('h4', { text: 'AI Meta' });
        new Setting(containerEl)
            .setName('文件名最大长度')
            .setDesc('使用 AI Meta 生成标题重命名文件时，文件名的最大长度。')
            .addText(text => text
                .setPlaceholder('100')
                .setValue(this.plugin.settings.metaFileNameMaxLength)
                .onChange(async (value) => {
                    this.plugin.settings.metaFileNameMaxLength = parseInt(value, 10) || 100;
                    await this.plugin.saveSettings();
                }));
        
        containerEl.createEl('h3', { text: '一键智能处理 (One-Click Smart Process)' });
        new Setting(containerEl)
            .setDesc('选择"一键处理"命令要执行的步骤。启用"优化结构"会首先修改笔记内容，然后其他启用的步骤会基于新内容在一个统一的侧边栏卡片中提供建议。');

        new Setting(containerEl)
            .setName('优化结构 (Structurizer)')
            .setDesc('首先运行，直接修改笔记内容以优化格式。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.structurizer)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.structurizer = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('生成元数据 (Meta)')
            .setDesc('在一个组合卡片中建议标题、摘要和TLDR。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.meta)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.meta = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName('智能标签 (Tagger)')
            .setDesc('在一个组合卡片中建议标签。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.tagger)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.tagger = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName('移动笔记 (Mover)')
            .setDesc('在一个组合卡片中建议新的存放位置。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.mover)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.mover = value;
                    await this.plugin.saveSettings();
                }));



        containerEl.createEl('h3', { text: 'Prompts 设置' });
        containerEl.createEl('p', { text: '在这里自定义每个功能的系统提示词(Prompt)。请注意，占位符(例如 {{content}})是必需的，用于在运行时动态插入内容。' });

        new Setting(containerEl)
            .setName('优化结构 (Structurizer)')
            .setDesc('编辑用于优化笔记结构的 Prompt。')
            .addButton(button => {
                button.setButtonText('编辑').onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'structurizerPrompt', '编辑优化结构 Prompt').open();
                });
            });

        new Setting(containerEl)
            .setName('移动笔记 (Mover)')
            .setDesc('编辑用于建议存放文件夹的 Prompt。')
            .addButton(button => {
                button.setButtonText('编辑').onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'moverPrompt', '编辑移动笔记 Prompt').open();
                });
            });

        new Setting(containerEl)
            .setName('智能标签 (Tagger)')
            .setDesc('编辑用于生成标签的 Prompt。')
            .addButton(button => {
                button.setButtonText('编辑').onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'taggerPrompt', '编辑智能标签 Prompt').open();
                });
            });

        new Setting(containerEl)
            .setName('生成元数据 (Meta)')
            .setDesc('编辑用于生成标题和摘要的 Prompt。')
            .addButton(button => {
                button.setButtonText('编辑').onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'metaPrompt', '编辑生成元数据 Prompt').open();
                });
            });

        new Setting(containerEl)
            .setName('翻译标签 (Tagger Translation)')
            .setDesc('编辑用于翻译长标签的 Prompt。')
            .addButton(button => {
                button.setButtonText('编辑').onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'translationPrompt', '编辑翻译 Prompt').open();
                });
            });

        containerEl.createEl('h3', { text: '配置管理' });

        new Setting(containerEl)
            .setName('导出设置')
            .setDesc('将当前所有设置导出为JSON文件，便于备份或分享。')
            .addButton(button => {
                button.setButtonText('导出设置').onClick(() => {
                    this.exportSettings();
                });
            });

        new Setting(containerEl)
            .setName('导入设置')
            .setDesc('从JSON文件导入设置配置。')
            .addButton(button => {
                button.setButtonText('导入设置').onClick(() => {
                    this.importSettings();
                });
            });

        new Setting(containerEl)
            .setName('重置设置')
            .setDesc('将所有设置重置为默认值。')
            .addButton(button => {
                button.setButtonText('重置设置')
                .setWarning()
                .onClick(() => {
                    this.resetSettings();
                });
            });
	}

    // 导出设置
    exportSettings() {
        const settingsJson = JSON.stringify(this.plugin.settings, null, 2);
        const blob = new Blob([settingsJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'ai-assistant-suite-settings.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        new Notice('设置已导出！', 3000);
    }

    // 导入设置
    importSettings() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const importedSettings = JSON.parse(text);

                // 验证导入的设置
                if (typeof importedSettings !== 'object') {
                    throw new Error('无效的设置文件格式');
                }

                // 合并设置（保留默认值）
                this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS, importedSettings);
                await this.plugin.saveSettings();

                // 刷新设置界面
                this.display();

                new Notice('设置导入成功！', 3000);
            } catch (error) {
                new Notice(`导入失败: ${error.message}`, 5000);
            }
        };
        input.click();
    }

    // 重置设置
    async resetSettings() {
        const confirmed = confirm('确定要重置所有设置为默认值吗？此操作不可撤销。');
        if (confirmed) {
            this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
            await this.plugin.saveSettings();
            this.display();
            new Notice('设置已重置为默认值！', 3000);
        }
    }
}

// 批量处理选择模态框
class BatchProcessingModal extends Modal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "选择批量处理方式" });

        // 选择文件
        const filesOption = contentEl.createDiv({ cls: "batch-option" });
        filesOption.innerHTML = `
            <div class="batch-option-icon">📄</div>
            <div class="batch-option-content">
                <h3>选择多个文件</h3>
                <p>手动选择要处理的文件</p>
            </div>
        `;
        filesOption.addEventListener('click', () => {
            this.close();
            this.showFileSelector();
        });

        // 选择文件夹
        const folderOption = contentEl.createDiv({ cls: "batch-option" });
        folderOption.innerHTML = `
            <div class="batch-option-icon">📁</div>
            <div class="batch-option-content">
                <h3>选择文件夹</h3>
                <p>处理整个文件夹中的所有文件</p>
            </div>
        `;
        folderOption.addEventListener('click', () => {
            this.close();
            this.showFolderSelector();
        });

        // 取消按钮
        const cancelBtn = contentEl.createEl("button", { text: "取消", cls: "mod-cancel" });
        cancelBtn.addEventListener('click', () => this.close());
    }

    showFileSelector() {
        const files = this.app.vault.getMarkdownFiles();
        const modal = new FileSelectionModal(this.app, files, (selectedFiles) => {
            this.onChoose('files', selectedFiles);
        });
        modal.open();
    }

    showFolderSelector() {
        const folders = this.app.vault.getAllLoadedFiles()
            .filter(file => file.children)
            .map(folder => folder.path);

        const modal = new FolderSelectionModal(this.app, folders, (selectedFolder) => {
            this.onChoose('folder', selectedFolder);
        });
        modal.open();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 文件选择模态框
class FileSelectionModal extends Modal {
    constructor(app, files, onChoose) {
        super(app);
        this.files = files;
        this.onChoose = onChoose;
        this.selectedFiles = new Set();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "选择要处理的文件" });

        // 全选/取消全选
        const selectAllContainer = contentEl.createDiv({ cls: "select-all-container" });
        const selectAllBtn = selectAllContainer.createEl("button", { text: "全选" });
        const deselectAllBtn = selectAllContainer.createEl("button", { text: "取消全选" });

        selectAllBtn.addEventListener('click', () => {
            this.files.forEach(file => this.selectedFiles.add(file));
            this.updateCheckboxes();
        });

        deselectAllBtn.addEventListener('click', () => {
            this.selectedFiles.clear();
            this.updateCheckboxes();
        });

        // 文件列表
        const fileList = contentEl.createDiv({ cls: "file-list" });
        this.fileList = fileList;

        this.files.forEach(file => {
            const fileItem = fileList.createDiv({ cls: "file-item" });

            const checkbox = fileItem.createEl("input", { type: "checkbox" });
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedFiles.add(file);
                } else {
                    this.selectedFiles.delete(file);
                }
            });

            fileItem.createEl("span", { text: file.path });
        });

        // 按钮
        const buttonContainer = contentEl.createDiv({ cls: "button-container" });
        const confirmBtn = buttonContainer.createEl("button", { text: "确认", cls: "mod-cta" });
        const cancelBtn = buttonContainer.createEl("button", { text: "取消" });

        confirmBtn.addEventListener('click', () => {
            if (this.selectedFiles.size > 0) {
                this.onChoose(Array.from(this.selectedFiles));
                this.close();
            } else {
                new Notice("请至少选择一个文件", 2000);
            }
        });

        cancelBtn.addEventListener('click', () => this.close());
    }

    updateCheckboxes() {
        const checkboxes = this.fileList.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach((checkbox, index) => {
            checkbox.checked = this.selectedFiles.has(this.files[index]);
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 文件夹选择模态框
class FolderSelectionModal extends FuzzySuggestModal {
    constructor(app, folders, onChoose) {
        super(app);
        this.folders = folders;
        this.onChoose = onChoose;
    }

    getItems() {
        return this.folders;
    }

    getItemText(folder) {
        return folder;
    }

    onChooseItem(folder) {
        this.onChoose(folder);
    }
}

// 快速操作面板类
class QuickActionsPanel {
    constructor(plugin) {
        this.plugin = plugin;
        this.quickActions = [
            {
                id: 'summarize',
                name: '总结',
                icon: '📝',
                hotkey: 'Ctrl+1',
                prompt: '请对以下内容进行简洁的总结，突出主要观点和关键信息：\n\n{{content}}'
            },
            {
                id: 'improve',
                name: '优化',
                icon: '✨',
                hotkey: 'Ctrl+2',
                prompt: '请优化以下内容的表达方式，使其更加清晰、准确和易读：\n\n{{content}}'
            },
            {
                id: 'translate',
                name: '翻译',
                icon: '🌐',
                hotkey: 'Ctrl+3',
                prompt: '请将以下内容翻译成中文（如果原文是中文则翻译成英文）：\n\n{{content}}'
            },
            {
                id: 'explain',
                name: '解释',
                icon: '💡',
                hotkey: 'Ctrl+4',
                prompt: '请详细解释以下内容，包括背景、含义和相关概念：\n\n{{content}}'
            }
        ];
    }

    // 创建浮动快速操作面板
    createFloatingPanel(x, y, selectedText) {
        // 移除已存在的面板
        this.removeExistingPanel();

        const panel = document.createElement('div');
        panel.className = 'ai-quick-actions-panel';
        panel.style.cssText = `
            position: fixed;
            top: ${y}px;
            left: ${x}px;
            background: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 1000;
            display: flex;
            gap: 4px;
            max-width: 300px;
            flex-wrap: wrap;
        `;

        this.quickActions.forEach(action => {
            const button = document.createElement('button');
            button.className = 'ai-quick-action-btn';
            button.innerHTML = `${action.icon} ${action.name}`;
            button.title = `${action.name} (${action.hotkey})`;
            button.style.cssText = `
                padding: 6px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-secondary);
                color: var(--text-normal);
                cursor: pointer;
                font-size: 12px;
                transition: all 0.2s ease;
                white-space: nowrap;
            `;

            button.addEventListener('mouseenter', () => {
                button.style.background = 'var(--interactive-accent)';
                button.style.color = 'var(--text-on-accent)';
            });

            button.addEventListener('mouseleave', () => {
                button.style.background = 'var(--background-secondary)';
                button.style.color = 'var(--text-normal)';
            });

            button.addEventListener('click', () => {
                this.removeExistingPanel();
                this.plugin.runQuickActionWithText(action.id, selectedText);
            });

            panel.appendChild(button);
        });

        document.body.appendChild(panel);

        // 点击其他地方关闭面板
        setTimeout(() => {
            const closeHandler = (e) => {
                if (!panel.contains(e.target)) {
                    this.removeExistingPanel();
                    document.removeEventListener('click', closeHandler);
                }
            };
            document.addEventListener('click', closeHandler);
        }, 100);

        return panel;
    }

    // 移除已存在的面板
    removeExistingPanel() {
        const existingPanel = document.querySelector('.ai-quick-actions-panel');
        if (existingPanel) {
            existingPanel.remove();
        }
    }
}

module.exports = AiAssistantSuite;