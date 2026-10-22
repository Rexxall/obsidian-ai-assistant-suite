const escapeHtmlText = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); // guarded writes and focused workspace
const { Plugin, Notice, PluginSettingTab, Setting, FuzzySuggestModal, Modal, ItemView, TFile, MarkdownRenderer, parseYaml, stringifyYaml } = require('obsidian');

const ASSISTANT_VIEW_TYPE = "ai-assistant-view";
const ASSISTANT_WORKBENCH_TYPE = "ai-assistant-workbench-view";
const REDACTED_API_KEY = '[REDACTED]';

let SharedUtils = {};
try {
    SharedUtils = require('../obsidian-utils/dist');
} catch (error) {
    SharedUtils = {};
}

class FallbackEncryptedSettings {
    constructor(options = {}) {
        this.namespace = options.namespace || 'default';
        this.passphrase = options.passphrase || 'obsidian-default-passphrase-change-me';
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
    }

    isEncryptedValue(value) {
        return typeof value === 'string' && value.startsWith('__ENC__:');
    }

    async encryptValue(plaintext) {
        if (!plaintext) return plaintext;
        if (!globalThis.crypto?.subtle) {
            return `__ENC__:${this.namespace}:plain:${btoa(unescape(encodeURIComponent(plaintext)))}`;
        }
        const key = await this.deriveKey();
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await globalThis.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            this.encoder.encode(plaintext)
        );
        const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(encrypted), iv.byteLength);
        return `__ENC__:${this.namespace}:${this.arrayBufferToBase64(combined.buffer)}`;
    }

    async decryptValue(value) {
        if (!this.isEncryptedValue(value)) return value || '';
        const parts = value.split(':');
        const payload = parts.slice(2).join(':');
        if (payload.startsWith('plain:')) {
            return decodeURIComponent(escape(atob(payload.slice(6))));
        }
        if (!globalThis.crypto?.subtle) {
            throw new Error('当前环境不支持 Web Crypto，无法解密 API Key。');
        }
        const combined = this.base64ToArrayBuffer(payload);
        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);
        const key = await this.deriveKey();
        const decrypted = await globalThis.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(iv) },
            key,
            new Uint8Array(encrypted)
        );
        return this.decoder.decode(decrypted);
    }

    async deriveKey() {
        const keyMaterial = await globalThis.crypto.subtle.importKey(
            'raw',
            this.encoder.encode(this.passphrase),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return globalThis.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: this.encoder.encode(`obsidian-utils-encrypted-settings-v1:${this.namespace}`),
                iterations: 100000,
                hash: 'SHA-256',
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
}

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

const FURIGANA_DEFAULT_PROMPT = `你是一位专业的日文假名标注专家。你的任务是为文本中的日文汉字添加假名注音（振り仮名/ルビ）。

**核心指令：**

1. **识别日文汉字**：找出文本中所有的日文汉字（包括汉字、汉字与假名的混合词）。
2. **添加假名注音**：为每个日文汉字词添加正确的假名注音。根据上下文确定正确的读音。
3. **格式规则（重要）**：
   - **代码块外的日文**：使用HTML的\`<ruby>\`标签，格式为：
     \`<ruby>漢字<rt>かんじ</rt></ruby>\`
     对于多个汉字组成的词：\`<ruby>日本語<rt>にほんご</rt></ruby>\`
   
   - **代码块内的日文**（包括inline code和code block）：
     - 使用括号格式：\`漢字(かんじ)\` 或 \`漢字【かんじ】\`
     - 对于多个汉字：\`日本語(にほんご)\` 或 \`日本語【にほんご】\`
     - 优先使用圆括号格式：\`漢字(かんじ)\`
     - 只为纯日文字串添加注音，保持变量名中的英文、符号、空格完全不变
     - 如果无法 100% 确认读音或无法判断是否为日文，请保持原样
   
4. **识别代码块**：
   - 被单个反引号（\`）包裹的是 inline code
   - 被三个反引号（\`\`\`）包裹的是 code block
   - 代码块内的日文必须使用括号格式，不要使用HTML标签
5. **保留其他内容**：
   - 保留所有非日文内容（中文、英文、数字等）不变
   - 保留所有Markdown语法（链接、图片等）不变
   - 保留所有格式和结构不变
6. **只标注汉字**：已经只有假名的词（如"です"、"ます"）不需要标注。
7. **直接输出结果**：你的输出必须且只能是添加了假名注音后的完整文本，不要包含任何额外的说明或对话。

**示例：**
*输入：*
\`\`\`
私は\`コード内の日本語\`を勉強しています。
\`\`\`
*输出：*
\`\`\`
<ruby>私<rt>わたし</rt></ruby>は\`コード内(コードない)の日本語(にほんご)\`を<ruby>勉強<rt>べんきょう</rt></ruby>しています。
\`\`\`

注意：
- 代码块外的"私"和"勉強"使用\`<ruby>\`标签
- 代码块内的"コード内"和"日本語"使用括号格式\`コード内(コードない)\`和\`日本語(にほんご)\`

**需要添加假名注音的文本如下：**

---
{{content}}
---`;

const DEFAULT_SETTINGS = {
    // General API Settings
    activeConfigId: 'default',
    apiConfigs: [
        {
            id: 'default',
            name: 'Default Configuration',
            apiProvider: 'openai',
            apiKey: '',
            apiUrl: 'https://darthvader-133-vaderodyseus5.hf.space/v1/chat/completions',
            modelName: 'gemini-2.5-pro',
            auxiliaryModelName: 'gemini-2.5-flash',
            enabled: true
        }
    ],

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

    // Processing History (persistent storage)
    processingHistory: [],
    translationPrompt: TRANSLATION_DEFAULT_PROMPT,
    totalProcessedCount: 0,
    actionUsageCounts: {},
    dailyProcessedCounts: {},

    // Meta Settings
    metaFileNameMaxLength: 100,
    metaPrompt: META_DEFAULT_PROMPT,

    // Furigana Settings
    furiganaPrompt: FURIGANA_DEFAULT_PROMPT,

    // One-Click Process Settings
    oneClickProcessActions: {
        structurizer: true,
        furigana: false,
        meta: true,
        tagger: true,
        mover: true,
    },
    rollbackHistory: [],
    rollbackRedoHistory: [],
    customActions: [],




};

class AssistantNotePreview extends ItemView {
    constructor(leaf,plugin){super(leaf);this.plugin=plugin;}
    getViewType(){return 'ai-assistant-note-preview';}
    getDisplayText(){return '笔记整文预览';}
    getIcon(){return 'file-check';}
    async onOpen(){this.contentEl.createEl('p',{text:'在笔记助手中选择正文建议。'});}
    async showTask(task){
        this.contentEl.empty();
        this.contentEl.addClass('sn-document-preview');
        this.contentEl.createEl('p',{text:'整文预览 · 原笔记尚未修改',cls:'sn-muted'});
        this.contentEl.createEl('h2',{text:task.content.file.basename});
        const body=this.contentEl.createDiv({cls:'markdown-rendered'});
        const c=task.content,h=c.reviewHunks||this.plugin.buildReviewHunks(c.originalContent,c.proposedContent);
        const text=this.plugin.composeReviewContent(c.originalContent,h,c.reviewSelected||h.map(v=>v.id)).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
        await MarkdownRenderer.render(this.app,text,body,task.content.file.path,this);
    }
}

class AssistantView extends ItemView {
    constructor(leaf, plugin, expanded = false) {
        super(leaf);
        this.plugin = plugin;
        this.expanded = expanded;
        plugin.assistantSession ||= { tasks: [] };
        for (const key of ['tasks','workbenchPage','selectedTaskId','sessionActions','sessionPreset','workbenchRunning','workbenchCancelled','workbenchOptionsOpen','pinnedFile','noteApplying']) {
            Object.defineProperty(this, key, { get: () => plugin.assistantSession[key], set: value => { plugin.assistantSession[key] = value; }, configurable: true });
        }
        this.currentFile = null; // 跟踪当前文件
        this.setupFileWatcher(); // 设置文件监听
    }

    getViewType() { return this.expanded ? ASSISTANT_WORKBENCH_TYPE : ASSISTANT_VIEW_TYPE; }
    getDisplayText() { return this.expanded ? "笔记工作台" : "笔记助手"; }
    getIcon() { return "anchor"; }

    async onOpen() {
        if (!this.fileWatcherRef) this.setupFileWatcher();
        this.render();
        this.contentEl?.style.setProperty('overflow-y', 'auto');
    }

    onClose() {
        this.documentRenderVersion = (this.documentRenderVersion || 0) + 1;
        if (this.plugin.view === this) {
            const otherType = this.expanded ? ASSISTANT_VIEW_TYPE : ASSISTANT_WORKBENCH_TYPE;
            this.plugin.view = this.plugin.app.workspace.getLeavesOfType(otherType)[0]?.view || null;
        }
        // 清理文件监听
        if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
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
        this.plugin.refreshAssistantViews?.(this);
    }

    addTask(task) {
        this.tasks.push(task);
        this.selectedTaskId = task.id;
        this.workbenchPage = this.tasks.some(t=>t.type==='batch-process'&&t.content?.canInterrupt) ? 'queue' : 'review';
        this.render();
        this.plugin.refreshAssistantViews?.(this);
    }

    updateTask(taskId, newProps) {
        const taskIndex = this.tasks.findIndex(t => t.id === taskId);
        if (taskIndex > -1) {
            this.tasks[taskIndex] = { ...this.tasks[taskIndex], ...newProps };
            this.render();
            this.plugin.refreshAssistantViews?.(this);
        }
    }

    getTask(taskId) {
        return this.tasks.find(task => task.id === taskId);
    }

    removeTask(taskId) {
        this.tasks = this.tasks.filter(t => t.id !== taskId);
        this.render();
        this.plugin.refreshAssistantViews?.(this);
    }

    render() {
        const container = this.containerEl.children[1];
        container.empty();
        const root = container.createDiv({ cls: 'mist-sidebar' });
        if (this.plugin.settings.sidebarCompact !== false) root.addClass('mist-compact');
        const page = this.workbenchPage || 'prepare';
        const activeNote = this.plugin.app.workspace.getActiveFile();
        if (activeNote?.extension === 'md') this.plugin.assistantLastFile = activeNote;
        const file = this.pinnedFile || (activeNote?.extension === 'md' ? activeNote : activeNote ? null : this.plugin.assistantLastFile || null);
        const busy = !!this.workbenchRunning || this.tasks.some(t => t.status === 'loading');
        const groups = this.getNoteGroups();

        const head = root.createDiv({ cls: 'mist-head' });
        head.createEl('h3', { text: '笔记助手', cls: 'mist-title' });
        const more = head.createEl('details', { cls: 'mist-more' });
        more.createEl('summary', { text: '更多', attr: { 'aria-label': '笔记助手更多功能' } });
        const menu = more.createDiv({ cls: 'mist-menu' });
        for (const [label, action] of this.mistSecondaryEntries()) {
            menu.createEl('button', { text: label }).onclick = () => { more.open = false; action(); };
        }

        // Only two places in daily use: choosing what to do, and reviewing what the AI proposed.
        const pending = groups.filter(g => this.noteStatus(g) === '待确认').length;
        const views = root.createEl('nav', { cls: 'mist-views', attr: { 'aria-label': '笔记助手视图' } });
        for (const [id, label] of [['prepare', '整理'], ['review', pending ? `本篇建议 · ${pending}` : '本篇建议']]) {
            const button = views.createEl('button', { text: label, cls: 'mist-view', attr: { 'aria-current': page === id ? 'page' : 'false' } });
            button.onclick = () => { this.workbenchPage = id; this.render(); this.plugin.refreshAssistantViews?.(this); };
        }

        const body = root.createDiv({ cls: 'mist-body' });
        if (!['prepare', 'review'].includes(page)) {
            body.createEl('button', { text: '← 回到整理', cls: 'mist-back' }).onclick = () => { this.workbenchPage = 'prepare'; this.render(); };
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
            actions.createEl('button', { text: '回滚上次修改', cls: 'mist-link' }).onclick = () => this.plugin.rollbackLastChange();
            actions.createEl('button', { text: '重新应用刚才的回滚', cls: 'mist-link' }).onclick = () => this.plugin.redoLastRollback();
            if (!this.plugin.getRecentHistory().length) this.renderMistEmpty(history, '还没有处理记录', '完成一次整理后，可以在这里找回笔记。');
            else this.renderRecentHistory(history);
            return;
        }
        if (page === 'tools') {
            const tools = body.createDiv({ cls: 'mist-tools' });
            this.renderQuickActions(tools);
            const diagnostics = tools.createEl('details', { cls: 'ai-assistant-diagnostics' });
            diagnostics.createEl('summary', { text: '使用情况与连接信息' });
            this.renderUsageStats(diagnostics); this.renderFileInfo(diagnostics); this.renderAIStatus(diagnostics);
            return;
        }
        if (page === 'review') { this.renderMistReview(body, file, groups); return; }
        this.renderMistPrepare(body, file, busy);
    }

    mistSecondaryEntries() {
        return [
            ['处理记录', () => { this.workbenchPage = 'history'; this.render(); }],
            ['批量整理', () => this.showBatchProcessingModal()],
            ['任务列表', () => { this.workbenchPage = 'queue'; this.render(); }],
            ['自定义动作', () => this.showAtelierCustomActions()],
            ['其他工具', () => { this.workbenchPage = 'tools'; this.render(); }],
            ['设置', () => { this.plugin.app.setting.open(); this.plugin.app.setting.openTabById(this.plugin.manifest.id); }]
        ];
    }

    getNoteGroups() {
        const groups = new Map();
        for (const task of this.tasks) {
            const file = task.content?.file;
            if (!file || !['one-click','diff-preview','error'].includes(task.type)) continue;
            const key = file.path;
            if (!groups.has(key)) groups.set(key, { file, tasks: [] });
            groups.get(key).tasks.push(task);
        }
        return [...groups.values()].map(group=>{const last=group.tasks.findLastIndex(t=>t.content.noteApplied);if(last>=0&&last<group.tasks.length-1)group.tasks=group.tasks.slice(last+1);return group;});
    }

    noteDraft(group) {
        const latest = group.tasks.filter(t => t.type === 'one-click').at(-1);
        const anchor = latest || group.tasks.at(-1);
        const suggestions = latest?.content.suggestions || {};
        const diffs = group.tasks.filter(t => t.type === 'diff-preview' && !t.content.applied && !t.content.noteApplied);
        const signature = group.tasks.map(t => t.id).join('|');
        if (!anchor.content.noteDraft || anchor.content.noteDraft.signature !== signature) {
            anchor.content.noteDraft = { signature, meta: { ...suggestions.meta },
                tags: (suggestions.tags || []).map(t => t.final || t.display || t),
                folder: suggestions.mover?.[0]?.path || group.file.parent?.path || '/',
                useMeta: !!suggestions.meta, useTags: !!suggestions.tags?.length, useFolder: !!suggestions.mover?.length,
                rename: false, diffId: diffs.at(-1)?.id || '', originalTaskId: latest?.id };
        }
        return anchor.content.noteDraft;
    }

    noteStatus(group) {
        if (group.tasks.at(-1)?.content.noteApplied) return '已确认';
        if (group.tasks.at(-1)?.type === 'error') return '需重试';
        return '待确认';
    }

    renderNoteQueue(container) {
        const groups = this.getNoteGroups();
        const count = status => groups.filter(g => this.noteStatus(g) === status).length;
        container.createEl('p', { text: `${count('待确认')} 篇待确认 · ${count('已确认')} 篇已确认 · ${count('需重试')} 篇需重试`, cls: 'mist-caption' });
        container.createEl('button', { text: '＋ 批量整理笔记', cls: 'mist-link' }).onclick = () => this.showBatchProcessingModal();
        this.queueSelection ||= new Set();
        for (const group of groups) {
            const row = container.createDiv({ cls: 'mist-queue-row' });
            const check = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `选择 ${group.file.basename}` } });
            check.checked = this.queueSelection.has(group.file.path);
            check.disabled = this.noteStatus(group) !== '待确认';
            check.onchange = () => { check.checked ? this.queueSelection.add(group.file.path) : this.queueSelection.delete(group.file.path); };
            const copy = row.createDiv({ cls: 'mist-queue-name' });
            copy.createEl('strong', { text: group.file.basename });
            copy.createEl('small', { text: this.noteStatus(group) });
            row.createEl('button', { text: '查看', cls: 'mist-link' }).onclick = () => { this.selectedTaskId = group.tasks.at(-1).id; this.workbenchPage = 'review'; this.render(); };
        }
        if (!groups.length) this.renderMistEmpty(container, '还没有待确认的笔记', '生成的建议会按笔记集中在这里。');
        if (groups.length) {
            const foot = container.createDiv({ cls: 'mist-foot' });
            const apply = foot.createEl('button', { text: '接受勾选的笔记', cls: 'mist-primary' });
            apply.onclick = async () => {
                if (this.noteApplying) return;
                const chosen = groups.filter(g => this.queueSelection.has(g.file.path) && this.noteStatus(g) === '待确认');
                if (!chosen.length) { new Notice('先勾选要接受的笔记。'); return; }
                this.noteApplying = true; apply.disabled = true; let done = 0;
                try {
                    for (const g of chosen) {
                        try { await this.plugin.applyNoteGroup(g, this.noteDraft(g)); done++; }
                        catch (e) { new Notice(`${g.file.basename}：${e.message}`, 6000); }
                    }
                } finally { this.noteApplying = false; this.queueSelection.clear(); this.render(); new Notice(`已确认 ${done} / ${chosen.length} 篇。`); }
            };
        }
        for (const task of this.tasks.filter(t => t.type === 'batch-process' && t.content?.canInterrupt)) this.renderTask(container, task);
    }

    // The note this panel is about: shown on both pages so the user always knows what will change.
    renderMistNote(container, file, allowSwap = true) {
        const note = container.createDiv({ cls: 'mist-note' });
        note.createDiv({ cls: 'mist-note-glyph', attr: { 'aria-hidden': 'true' } });
        const copy = note.createDiv({ cls: 'mist-note-copy' });
        copy.createEl('strong', { text: file ? file.basename : '选择一篇笔记' });
        copy.createEl('small', { text: file ? (file.parent?.path === '/' ? '笔记库根目录' : (file.parent?.path || file.path)) : '打开或选择 Markdown 文件' });
        if (allowSwap) note.createEl('button', { text: '换一篇', cls: 'mist-link', attr: { 'aria-label': '选择要整理的笔记' } }).onclick = () => this.chooseAtelierNote();
    }

    renderMistEmpty(container, title, text) {
        const empty = container.createDiv({ cls: 'mist-empty' });
        empty.createEl('strong', { text: title });
        empty.createEl('p', { text });
    }

    renderMistPrepare(body, file, busy) {
        const chosen = this.sessionActions || this.plugin.settings.oneClickProcessActions || {};
        const actions = [['meta', '标题与摘要', '补全笔记属性'], ['tagger', '标签', '连接已有分类'], ['mover', '归档', '建议存放位置'], ['structurizer', '整理正文', '梳理段落与标题'], ['furigana', '假名', '给日文加读音']];
        this.renderMistNote(body, file);
        body.createEl('p', { text: '想做什么', cls: 'mist-label' });
        const list = body.createDiv({ cls: 'mist-acts', attr: { role: 'group', 'aria-label': '选择处理功能' } });
        for (const [key, label, hint] of actions) {
            const on = !!chosen[key];
            const pill = list.createEl('button', { cls: on ? 'mist-act is-on' : 'mist-act', attr: { 'data-action': key, 'aria-pressed': String(on), title: hint } });
            pill.createSpan({ text: label });
            if (key === 'mover') pill.createEl('small', { text: '建议放哪' });
            pill.onclick = () => { this.sessionActions = { ...chosen, [key]: !on }; this.render(); };
        }
        const ask = body.createEl('label', { cls: 'mist-ask' });
        ask.createSpan({ text: '补充一句（可不填）' });
        const input = ask.createEl('textarea', { attr: { rows: '2', placeholder: '例如：标签尽量用库里已有的', 'aria-label': '补充要求' } });
        input.value = this.sessionInstruction || '';
        input.oninput = () => { this.sessionInstruction = input.value; };

        const selected = actions.filter(([key]) => chosen[key]);
        const go = body.createDiv({ cls: 'mist-go' });
        go.createEl('small', { text: !file ? '先打开一篇 Markdown 笔记' : selected.length ? '结果集中在这篇，原文先不动' : '至少选一件事', cls: 'mist-caption' });
        const run = go.createEl('button', { text: busy ? '正在生成…' : '生成建议 →', cls: 'mist-primary', attr: { 'aria-label': '为当前笔记生成修改建议' } });
        run.disabled = !file || !selected.length || busy;
        run.onclick = async () => {
            if (this.workbenchRunning || !file) return;
            this.workbenchRunning = true; this.workbenchCancelled = false; this.workbenchPage = 'review';
            this.render(); this.plugin.refreshAssistantViews?.(this);
            try { await this.plugin.runOneClickSmartProcess(file, { ...chosen }, () => this.workbenchCancelled, this.sessionInstruction || ''); }
            finally { this.workbenchRunning = false; this.render(); this.plugin.refreshAssistantViews?.(this); }
        };
        if (busy) this.renderCurrentRequestBanner(body);

        const quiet = body.createDiv({ cls: 'mist-links mist-quiet' });
        for (const [label, action] of this.mistSecondaryEntries().filter(([label]) => ['处理记录', '批量整理', '自定义动作', '设置'].includes(label))) {
            quiet.createEl('button', { text: label, cls: 'mist-link' }).onclick = action;
        }
    }

    renderMistReview(body, file, groups) {
        this.renderCurrentRequestBanner(body);
        const loose = this.tasks.filter(t => !groups.some(g => g.tasks.includes(t)));
        const selectedLoose = loose.find(t => t.id === this.selectedTaskId);
        const group = selectedLoose ? null
            : groups.find(g => g.tasks.some(t => t.id === this.selectedTaskId)) || groups.find(g => file && g.file.path === file.path) || groups.at(-1);
        if (group) { this.renderMistNoteReview(body, group, groups); return; }
        if (loose.length) {
            // Results from single tools and custom actions keep their own cards.
            const task = selectedLoose || loose.at(-1);
            this.selectedTaskId = task.id;
            if (loose.length > 1) {
                const select = body.createEl('select', { cls: 'mist-select', attr: { 'aria-label': '选择处理结果' } });
                for (const t of loose) select.createEl('option', { value: t.id, text: `${t.status === 'loading' ? '生成中 · ' : t.content?.applied ? '已接受 · ' : ''}${t.title || '处理结果'}` });
                select.value = task.id;
                select.onchange = () => { this.selectedTaskId = select.value; this.render(); };
            }
            this.renderTask(body, task);
            return;
        }
        this.renderMistEmpty(body, this.workbenchRunning ? '正在准备建议' : '这里会出现这篇的建议', this.workbenchRunning ? '正在读取笔记，原文不会被改动。' : '在“整理”里选好要做的事，生成后集中在这里确认。');
        if (!this.workbenchRunning) body.createEl('button', { text: '去整理', cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'prepare'; this.render(); };
    }

    renderMistNoteReview(body, group, groups) {
        const draft = this.noteDraft(group);
        const suggestions = group.tasks.filter(t => t.type === 'one-click').at(-1)?.content.suggestions || {};
        const status = this.noteStatus(group);
        const done = status === '已确认';
        this.renderMistNote(body, group.file, false);
        const others = groups.filter(g => g !== group && this.noteStatus(g) === '待确认').length;
        const state = body.createDiv({ cls: 'mist-state' });
        state.createSpan({ text: done ? '已确认 · 可以撤销' : status === '需重试' ? '生成失败 · 原文没有改动' : '建议已生成 · 原文还没改', cls: done ? 'mist-dot is-done' : 'mist-dot' });
        if (others) state.createEl('button', { text: `还有 ${others} 篇`, cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'queue'; this.render(); };

        const part = (key, title, hint) => {
            const el = body.createDiv({ cls: 'mist-part' });
            const toggle = el.createEl('button', { cls: draft[key] ? 'mist-part-head is-on' : 'mist-part-head', attr: { 'aria-pressed': String(!!draft[key]) } });
            toggle.createSpan({ text: draft[key] ? '✓' : '', cls: 'mist-tick', attr: { 'aria-hidden': 'true' } });
            toggle.createSpan({ text: title });
            if (hint) toggle.createEl('small', { text: hint });
            toggle.disabled = done || !!this.noteApplying;
            toggle.onclick = () => { draft[key] = !draft[key]; this.render(); };
            return el;
        };
        if (suggestions.meta) {
            const paper = part('useMeta', '标题与摘要', '可以直接改').createDiv({ cls: 'mist-paper' });
            for (const [key, label] of [['title', '标题'], ['summary', '摘要'], ['tldr', '一句话总结']]) {
                const input = paper.createEl('textarea', { cls: `mist-edit mist-edit-${key}`, attr: { rows: key === 'title' ? '1' : '2', 'aria-label': label, placeholder: label } });
                input.value = draft.meta[key] || ''; input.disabled = done;
                input.oninput = () => { draft.meta[key] = input.value; };
            }
            const rename = paper.createEl('label', { cls: 'mist-rename' });
            const check = rename.createEl('input', { type: 'checkbox' }); check.checked = draft.rename; check.disabled = done;
            rename.createSpan({ text: '同时用标题重命名文件' });
            check.onchange = () => { draft.rename = check.checked; };
        }
        if (suggestions.tags?.length) {
            const chips = part('useTags', '标签', '点一下去掉').createDiv({ cls: 'mist-chips' });
            for (const tag of suggestions.tags) {
                const value = tag.final || tag.display || tag;
                const kept = draft.tags.includes(value);
                const chip = chips.createEl('button', { text: `#${value}`, cls: kept ? 'mist-chip' : 'mist-chip is-off', attr: { 'aria-pressed': String(kept) } });
                chip.disabled = done;
                chip.onclick = () => { draft.tags = kept ? draft.tags.filter(t => t !== value) : [...draft.tags, value]; this.render(); };
            }
        }
        if (suggestions.mover?.length) {
            const el = part('useFolder', '归档');
            const path = el.createDiv({ cls: 'mist-path' });
            path.createSpan({ text: `${group.file.parent?.path || '/'}/`.replace('//', '/'), cls: 'mist-from' });
            path.createSpan({ text: '→', attr: { 'aria-hidden': 'true' } });
            path.createSpan({ text: draft.folder, cls: 'mist-to' });
            const alts = suggestions.mover.map(v => v.path).filter(p => p && p !== draft.folder);
            if (alts.length && !done) {
                const row = el.createDiv({ cls: 'mist-alts' });
                row.createSpan({ text: '也可以放：' });
                for (const p of alts) row.createEl('button', { text: p, cls: 'mist-alt' }).onclick = () => { draft.folder = p; this.render(); };
            }
            if (!done) {
                const other = el.createEl('select', { cls: 'mist-select', attr: { 'aria-label': '其他文件夹' } });
                other.createEl('option', { value: '', text: '其他文件夹…' });
                for (const f of this.plugin.app.vault.getAllLoadedFiles().filter(f => f.children)) other.createEl('option', { value: f.path, text: f.path });
                other.onchange = () => { if (other.value) { draft.folder = other.value; this.render(); } };
            }
        }
        const diffs = group.tasks.filter(t => t.type === 'diff-preview' && !t.content.applied && !t.content.noteApplied);
        if (diffs.length && !done) {
            const el = body.createDiv({ cls: 'mist-part' });
            const head = el.createDiv({ cls: 'mist-part-head is-static' });
            head.createSpan({ text: draft.diffId ? '✓' : '', cls: 'mist-tick' });
            head.createSpan({ text: '正文' });
            const note = el.createDiv({ cls: 'mist-body-note' });
            if (diffs.length > 1 || !draft.diffId) {
                const select = note.createEl('select', { cls: 'mist-select', attr: { 'aria-label': '选择正文版本' } });
                select.createEl('option', { value: '', text: '保留当前正文' });
                for (const task of diffs) select.createEl('option', { value: task.id, text: task.content.action || task.title });
                select.value = draft.diffId;
                select.onchange = () => { draft.diffId = select.value; this.render(); };
            } else {
                note.createSpan({ text: diffs[0].content.action || diffs[0].title || '已生成整理后的正文' });
            }
            note.createEl('button', { text: '在左边看 ↗', cls: 'mist-link is-strong' }).onclick = () => {
                const task = diffs.find(t => t.id === draft.diffId);
                if (task) this.plugin.openNotePreview(task); else new Notice('先选择一个正文版本。');
            };
        }
        const error = group.tasks.at(-1)?.type === 'error' ? group.tasks.at(-1) : null;
        if (error) {
            body.createEl('p', { text: error.content.message, cls: 'mist-caption' });
            body.createEl('button', { text: '重新生成本篇建议', cls: 'mist-link is-strong' }).onclick = async () => {
                if (this.workbenchRunning) return;
                this.workbenchRunning = true;
                try { await this.plugin.runOneClickSmartProcess(group.file); } finally { this.workbenchRunning = false; this.render(); }
            };
        }
        const count = [draft.useMeta && suggestions.meta, draft.useTags && draft.tags.length, draft.useFolder && suggestions.mover?.length, draft.diffId].filter(Boolean).length;
        const foot = body.createDiv({ cls: 'mist-foot' });
        foot.createEl('button', { text: '稍后再看', cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'queue'; this.render(); };
        const accept = foot.createEl('button', { text: done ? '撤销这篇' : `确认这篇 · ${count} 项`, cls: done ? 'mist-primary is-quiet' : 'mist-primary' });
        accept.disabled = !!this.noteApplying || !!this.workbenchRunning || (!done && !count);
        accept.onclick = async () => {
            if (this.noteApplying) return;
            this.noteApplying = true; accept.disabled = true;
            try {
                if (done) await this.plugin.undoNoteGroup(group);
                else await this.plugin.applyNoteGroup(group, draft);
                if (!done && this.plugin.settings.sidebarAutoNext !== false) {
                    const next = this.getNoteGroups().find(g => g.file !== group.file && this.noteStatus(g) === '待确认');
                    if (next) this.selectedTaskId = next.tasks.at(-1).id;
                }
            } catch (e) { new Notice(e.message, 7000); }
            finally { this.noteApplying = false; this.render(); this.plugin.refreshAssistantViews?.(this); }
        };
        if (!done) body.createEl('p', { text: '确认后可以一键撤销', cls: 'mist-caption' });
    }

    chooseAtelierNote() {
        const view=this;
        class NotePicker extends FuzzySuggestModal {
            getItems(){return view.plugin.app.vault.getMarkdownFiles()}
            getItemText(file){return file.path}
            onChooseItem(file){view.plugin.assistantLastFile=file;view.pinnedFile=file;view.workbenchPage='prepare';view.render();view.plugin.refreshAssistantViews?.(view)}
        }
        const picker=new NotePicker(this.plugin.app);picker.setPlaceholder('选择要整理的笔记…');picker.open();
    }

    showAtelierCustomActions() {
        const modal=new Modal(this.plugin.app);modal.modalEl.addClass('assistant-atelier-modal');
        modal.contentEl.createEl('h2',{text:'按自己的方式处理'});
        const actions=(this.plugin.settings.customActions||[]).filter(a=>a.enabled!==false);
        if(!actions.length)modal.contentEl.createEl('p',{text:'在插件设置中添加常用要求，保存为自定义动作。'});
        for(const action of actions){
            const button=modal.contentEl.createEl('button',{text:action.name||'自定义动作',cls:'at-custom-action'});
            button.onclick=()=>{modal.close();this.plugin.runCustomAction(action.id, this.pinnedFile || this.plugin.assistantLastFile)};
        }
        modal.contentEl.createEl('button',{text:'管理自定义动作',cls:'at-custom-action'}).onclick=()=>{modal.close();this.plugin.app.setting.open();this.plugin.app.setting.openTabById(this.plugin.manifest.id)};
        modal.open();
    }

    openAtelierSettings() {
        const modal=new Modal(this.plugin.app);modal.modalEl.addClass('assistant-atelier-modal');
        modal.contentEl.createEl('h2',{text:'处理偏好'});
        modal.contentEl.createEl('p',{text:'调整默认步骤。模型、提示词和全部高级选项可在完整设置中管理。'});
        const chosen={...(this.plugin.settings.oneClickProcessActions||{})};
        for(const [key,label] of [['structurizer','整理结构'],['furigana','日文注音'],['meta','补全属性'],['tagger','补充标签'],['mover','建议位置']]){
            const row=modal.contentEl.createEl('label',{cls:'at-settings-row'});
            const check=row.createEl('input',{type:'checkbox'});check.checked=!!chosen[key];
            row.createSpan({text:label});check.onchange=()=>{chosen[key]=check.checked};
        }
        const buttons=modal.contentEl.createDiv({cls:'at-settings-actions'});
        const save=buttons.createEl('button',{text:'保存默认步骤',cls:'mod-cta'});
        save.onclick=async()=>{save.disabled=true;this.plugin.settings.oneClickProcessActions=chosen;await this.plugin.saveSettings();modal.close();this.render();this.plugin.refreshAssistantViews?.(this);new Notice('默认处理步骤已保存。')};
        buttons.createEl('button',{text:'完整设置 ↗'}).onclick=()=>{modal.close();this.plugin.app.setting.open();this.plugin.app.setting.openTabById(this.plugin.manifest.id)};
        modal.open();
    }

    renderWorkbenchEmpty(container, title, description) {
        const empty = container.createDiv({ cls: 'aw-empty' });
        empty.createDiv({ cls:'aw-empty-mark', text:'↗', attr:{'aria-hidden':'true'} });
        empty.createEl('h3', { text:title });
        empty.createEl('p', { text:description });
    }

    cancelWorkbenchRequest() {
        this.workbenchCancelled = true;
        this.plugin.cancelCurrentRequest('用户取消');
    }

    renderCurrentRequestBanner(container) {
        if (!this.workbenchRunning && (!this.plugin.currentAbortController || this.plugin.currentAbortController.signal.aborted)) {
            return;
        }
        const banner = container.createDiv({ cls: "ai-assistant-active-request" });
        const label = this.plugin.currentRequestLabel || 'AI 请求';
        banner.createEl("span", { text: `正在运行: ${label}` });
        const cancelButton = banner.createEl("button", { text: "取消" });
        cancelButton.addEventListener("click", () => this.cancelWorkbenchRequest());
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
        const header = card.createDiv({ cls: "assistant-task-heading" });
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';

        // Add title to header
        header.createEl("h3", { text: task.title || 'AI 处理结果' });

        const headerActions = header.createDiv();
        headerActions.style.display = 'flex';
        headerActions.style.gap = '6px';
        headerActions.style.alignItems = 'center';

        // Add navigation button to header if file exists
        if (task.content && task.content.file) {
            const navButton = headerActions.createEl("button", { text: "定位笔记" });
            navButton.addEventListener("click", () => {
                this.plugin.app.workspace.getLeaf().openFile(task.content.file);
            });
        }

        if (task.status !== 'loading' && task.canClose !== false) {
            const closeButton = headerActions.createEl("button", {
                cls: "ai-assistant-card-close",
                text: "×"
            });
            closeButton.setAttr("aria-label", "关闭卡片");
            closeButton.addEventListener("click", () => this.removeTask(task.id));
        }

        if (task.status === 'loading') {
            card.createEl("p", { text: task.message || "AI 正在处理中，请稍候..." });
            const streamingContent = task.streamingContent || task.content?.streamingContent;
            const chars = streamingContent ? streamingContent.length : 0;
            const meta = card.createDiv({ cls: "ai-assistant-streaming-meta" });
            meta.setText(chars > 0 ? `Streaming · 已接收 ${chars} 字` : 'Streaming · 等待首个响应片段');
            if (streamingContent) {
                const streamBox = card.createEl("pre", { cls: "ai-assistant-streaming-output" });
                streamBox.setText(streamingContent + '▌');
            }
            const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
            const cancelButton = buttonContainer.createEl("button", { text: "取消当前请求" });
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
            details.createEl('summary', { text: '属性 · 标题与摘要' });
            const content = details.createDiv();
            this.renderOneClickMetaSection(content, { ...task, meta: suggestions.meta });
        }
        if (hasTags) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: '属性 · 标签' });
            const content = details.createDiv();
            this.renderOneClickTaggerSection(content, { ...task, tags: suggestions.tags });
        }
        if (hasMover) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: '位置 · 归档建议' });
            const content = details.createDiv();
            this.renderOneClickMoverSection(content, { ...task, mover: suggestions.mover });
        }

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: "全部跳过" });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderOneClickMetaSection(container, task) {
        container.addClass('ai-assistant-meta-section');
        const existing = this.plugin.app.metadataCache.getFileCache(task.content.file)?.frontmatter || {};
        const before = container.createEl('details', { cls: 'assistant-review-current-properties' });
        before.createEl('summary', { text: '查看当前属性' });
        for (const key of ['title','summary','tldr']) before.createEl('p', { text: `${key}: ${existing[key] ?? '未设置'}` });
        const { title, summary, tldr } = task.meta;



        // 创建可编辑的元数据字段
        const editableData = {
            title: title || '',
            summary: summary || '',
            tldr: tldr || ''
        };

        // 标题编辑区域
        const titleSection = container.createDiv({ cls: "meta-field-section" });
        titleSection.createEl("label", { text: "标题:", cls: "meta-field-label" });
        const titleInput = titleSection.createEl("input", {
            type: "text",
            value: title,
            cls: "meta-field-input"
        });
        titleInput.addEventListener("input", (e) => {
            editableData.title = e.target.value;
        });

        // 摘要编辑区域
        const summarySection = container.createDiv({ cls: "meta-field-section" });
        summarySection.createEl("label", { text: "摘要:", cls: "meta-field-label" });
        const summaryTextarea = summarySection.createEl("textarea", {
            cls: "meta-field-textarea"
        });
        summaryTextarea.value = summary || '';
        summaryTextarea.placeholder = "请输入摘要...";
        summaryTextarea.addEventListener("input", (e) => {
            editableData.summary = e.target.value;
        });

        // 一句话总结编辑区域
        const tldrSection = container.createDiv({ cls: "meta-field-section" });
        tldrSection.createEl("label", { text: "一句话总结:", cls: "meta-field-label" });
        const tldrInput = tldrSection.createEl("input", {
            type: "text",
            value: tldr,
            cls: "meta-field-input"
        });
        tldrInput.addEventListener("input", (e) => {
            editableData.tldr = e.target.value;
        });

        // 动态计算文件名和路径
        const getUpdatedPaths = () => {
            const sanitizedTitle = editableData.title.trim().replace(/[/\\:?*"<>|]/g, '-');
            const finalFilename = sanitizedTitle.substring(0, this.plugin.settings.metaFileNameMaxLength);
            const newPath = `${task.content.file.parent.path}/${finalFilename}.md`;
            const canRename = task.content.file.path !== newPath && !this.plugin.app.vault.getAbstractFileByPath(newPath);
            return { sanitizedTitle, finalFilename, newPath, canRename };
        };

        const buttonContainer = container.createDiv({ cls: "ai-assistant-button-container" });

        // 重命名文件按钮
        const renameButton = buttonContainer.createEl("button", { text: "重命名文件", cls: "mod-cta" });
        renameButton.addEventListener("click", async () => {
            const paths = getUpdatedPaths();
            if (!paths.canRename) {
                new Notice("无法重命名：目标文件已存在或路径相同");
                return;
            }

            let notice = new Notice("正在重命名并更新元数据...", 0);
            try {
                // 使用安全重命名方法
                const newFile = await this.plugin.safeRenameFile(task.content.file, paths.newPath);

                // 更新元数据
                await this.plugin.updateFrontmatter(newFile, editableData.title, editableData.summary, editableData.tldr);
                notice.hide();
                new Notice(`文件已重命名为: ${paths.finalFilename}.md`, 4000);

                // 添加到历史记录
                this.plugin.addToHistory(paths.finalFilename, newFile.path, "重命名+元数据", this.plugin.generateFileId(newFile));

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

        const noRenameButton = buttonContainer.createEl("button", { text: "仅更新元数据" });
        noRenameButton.addEventListener("click", async () => {
            await this.plugin.updateFrontmatter(task.content.file, editableData.title, editableData.summary, editableData.tldr, false);
            new Notice("元数据已更新，文件名保持不变。");

            // 添加到历史记录
            this.plugin.addToHistory(task.content.file.basename, task.content.file.path, "更新元数据", this.plugin.generateFileId(task.content.file));

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
                this.plugin.addToHistory(task.content.file.basename, task.content.file.path, `添加${tagsToAdd.length}个标签`, this.plugin.generateFileId(task.content.file));

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
        container.createEl('p', { text: `当前位置：${task.content.file.path}`, cls: 'assistant-review-path' });
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
                await this.moveFileToFolder(task, suggestion.path, suggestion.is_new);
            });
        });

        // 添加"选择其他位置"按钮
        const customMoverItem = container.createDiv({ cls: "ai-assistant-mover-item ai-assistant-custom-mover" });
        const customPathDiv = customMoverItem.createDiv({ cls: "ai-assistant-mover-path" });
        customPathDiv.createEl("span", {
            text: "选择其他位置...",
            cls: "custom-location-text"
        });

        const customButton = customMoverItem.createEl("button", { text: "浏览", cls: "mod-secondary" });
        customButton.addEventListener("click", () => {
            this.showFolderSelectionForMove(task);
        });
    }

    // 提取移动文件的通用逻辑
    async moveFileToFolder(task, destinationFolder, isNew = false) {
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
            if (isNew && !await this.app.vault.adapter.exists(destinationFolder)) {
                await this.app.vault.createFolder(destinationFolder);
                new Notice(`已创建新文件夹: ${destinationFolder}`, 4000);
            }
            await this.app.fileManager.renameFile(task.content.file, newPath);
            notice.hide();
            new Notice(`笔记已成功移动到: ${destinationFolder}`, 5000);

            const newFile = this.plugin.app.vault.getAbstractFileByPath(newPath);

            // 添加到历史记录
            this.plugin.addToHistory(newFile.basename, newFile.path, "移动文件", this.plugin.generateFileId(newFile));

            const newContent = { ...task.content, file: newFile };
            delete newContent.suggestions.mover;
            this.updateTask(task.id, { content: newContent });

        } catch (err) {
            notice.hide();
            new Notice(`移动文件时出错: ${err.message}`, 0);
        }
    }

    // 显示文件夹选择器用于移动文件
    showFolderSelectionForMove(task) {
        const folders = this.plugin.app.vault.getAllLoadedFiles()
            .filter(file => file.children)
            .map(folder => folder.path)
            .filter(path => path !== '/'); // 排除根目录

        const modal = new FolderSelectionModal(this.plugin.app, folders, (selectedFolder) => {
            if (selectedFolder) {
                this.moveFileToFolder(task, selectedFolder, false);
            }
        });
        modal.open();
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
                await this.moveFileToFolderStandalone(file, suggestion.path, suggestion.is_new, task.id);
            });
        });

        // 添加"选择其他位置"按钮
        const customMoverItem = card.createDiv({ cls: "ai-assistant-mover-item ai-assistant-custom-mover" });
        const customPathDiv = customMoverItem.createDiv({ cls: "ai-assistant-mover-path" });
        customPathDiv.createEl("span", {
            text: "选择其他位置...",
            cls: "custom-location-text"
        });

        const customButton = customMoverItem.createEl("button", { text: "浏览", cls: "mod-secondary" });
        customButton.addEventListener("click", () => {
            this.showFolderSelectionForMoveStandalone(file, task.id);
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: "取消" });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 独立Mover任务的移动文件逻辑
    async moveFileToFolderStandalone(file, destinationFolder, isNew = false, taskId) {
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
            if (isNew && !await this.app.vault.adapter.exists(destinationFolder)) {
                await this.app.vault.createFolder(destinationFolder);
                new Notice(`已创建新文件夹: ${destinationFolder}`, 4000);
            }
            await this.app.fileManager.renameFile(file, newPath);
            moveNotice.hide();
            new Notice(`笔记已成功移动到: ${destinationFolder}`, 5000);

            // 添加到历史记录
            const newFile = this.plugin.app.vault.getAbstractFileByPath(newPath);
            if (newFile) {
                this.plugin.addToHistory(newFile.basename, newFile.path, "移动文件", this.plugin.generateFileId(newFile));
            }

            this.removeTask(taskId);
        } catch (err) {
            moveNotice.hide();
            new Notice(`移动文件时出错: ${err.message}`, 0);
        }
    }

    // 独立Mover任务的文件夹选择器
    showFolderSelectionForMoveStandalone(file, taskId) {
        const folders = this.plugin.app.vault.getAllLoadedFiles()
            .filter(f => f.children)
            .map(folder => folder.path)
            .filter(path => path !== '/'); // 排除根目录

        const modal = new FolderSelectionModal(this.plugin.app, folders, (selectedFolder) => {
            if (selectedFolder) {
                this.moveFileToFolderStandalone(file, selectedFolder, false, taskId);
            }
        });
        modal.open();
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
                this.plugin.addToHistory(file.basename, file.path, `添加${tagsToAdd.length}个标签`, this.plugin.generateFileId(file));

                this.removeTask(task.id);
            } catch (e) {
                updateNotice.hide();
                new Notice(`更新标签失败: ${e.message}`, 0);
            }
        });
    }

    renderMetaTask(card, task) {
        const { title, summary, tldr, file } = task.content;



        // 创建可编辑的元数据字段
        const editableData = {
            title: title || '',
            summary: summary || '',
            tldr: tldr || ''
        };

        // 标题编辑区域
        const titleSection = card.createDiv({ cls: "meta-field-section" });
        titleSection.createEl("label", { text: "建议标题:", cls: "meta-field-label" });
        const titleInput = titleSection.createEl("input", {
            type: "text",
            value: title,
            cls: "meta-field-input"
        });
        titleInput.addEventListener("input", (e) => {
            editableData.title = e.target.value;
        });

        // 摘要编辑区域
        const summarySection = card.createDiv({ cls: "meta-field-section" });
        summarySection.createEl("label", { text: "摘要:", cls: "meta-field-label" });
        const summaryTextarea = summarySection.createEl("textarea", {
            cls: "meta-field-textarea"
        });
        summaryTextarea.value = summary || '';
        summaryTextarea.placeholder = "请输入摘要...";
        summaryTextarea.addEventListener("input", (e) => {
            editableData.summary = e.target.value;
        });

        // 一句话总结编辑区域
        const tldrSection = card.createDiv({ cls: "meta-field-section" });
        tldrSection.createEl("label", { text: "一句话总结:", cls: "meta-field-label" });
        const tldrInput = tldrSection.createEl("input", {
            type: "text",
            value: tldr,
            cls: "meta-field-input"
        });
        tldrInput.addEventListener("input", (e) => {
            editableData.tldr = e.target.value;
        });

        // 动态计算文件名和路径
        const getUpdatedPaths = () => {
            const sanitizedTitle = editableData.title.trim().replace(/[/\\:?*"<>|]/g, '-');
            const finalFilename = sanitizedTitle.substring(0, this.plugin.settings.metaFileNameMaxLength);
            const newPath = `${file.parent.path}/${finalFilename}.md`;
            const canRename = file.path !== newPath && !this.plugin.app.vault.getAbstractFileByPath(newPath);
            return { sanitizedTitle, finalFilename, newPath, canRename };
        };

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        // 重命名文件按钮
        const renameButton = buttonContainer.createEl("button", { text: "重命名文件", cls: "mod-cta" });
        renameButton.addEventListener("click", async () => {
            const paths = getUpdatedPaths();
            if (!paths.canRename) {
                new Notice("无法重命名：目标文件已存在或路径相同");
                return;
            }

            let renameNotice = new Notice("正在重命名并更新元数据...", 0);
            try {
                // 使用安全重命名方法
                const newFile = await this.plugin.safeRenameFile(file, paths.newPath);

                // 更新元数据
                await this.plugin.updateFrontmatter(newFile, editableData.title, editableData.summary, editableData.tldr);
                renameNotice.hide();
                new Notice(`文件已重命名为: ${paths.finalFilename}.md`, 4000);

                // 添加到历史记录
                this.plugin.addToHistory(paths.finalFilename, newFile.path, "重命名+元数据", this.plugin.generateFileId(newFile));

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

        const noRenameButton = buttonContainer.createEl("button", { text: "仅更新元数据" });
        noRenameButton.addEventListener("click", async () => {
            await this.plugin.updateFrontmatter(file, editableData.title, editableData.summary, editableData.tldr);
            new Notice("元数据已更新，文件名保持不变。");

            // 添加到历史记录
            this.plugin.addToHistory(file.basename, file.path, "更新元数据", this.plugin.generateFileId(file));

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

    renderDiffPreviewTask(card, task, expanded = false) {
        const content = task.content || {};
        if (!content.reviewHunks) content.reviewHunks = this.plugin.buildReviewHunks(content.originalContent || '', content.proposedContent || '');
        if (!Array.isArray(content.reviewSelected)) content.reviewSelected = content.reviewHunks.map(h => h.id);
        if (content.reviewMode !== 'changes') {
            this.renderFullArticlePreview(card, task, expanded);
            return;
        }
        card.addClass('assistant-review-surface');
        card.createDiv({ text: content.file?.path || '当前笔记', cls: 'assistant-review-path' });
        const summary = card.createDiv({ cls: 'assistant-review-summary', attr: { 'aria-live': 'polite' } });
        const controls = card.createDiv({ cls: 'assistant-review-toolbar' });
        controls.createEl('button', { text: '整文预览' }).onclick = () => {
            content.reviewMode = 'article'; card.empty(); this.renderDiffPreviewTask(card, task, expanded);
        };
        if (!expanded) controls.createEl('button', { text: '展开审阅' }).onclick = () => {
            const modal = new Modal(this.plugin.app);
            modal.modalEl.addClass('assistant-review-modal');
            const paint = () => { modal.contentEl.empty(); modal.contentEl.createEl('h2', { text: task.title || '审阅修改' }); this.renderDiffPreviewTask(modal.contentEl, task, true); };
            modal.onOpen = paint;
            modal.open();
        };
        const list = card.createDiv({ cls: 'assistant-review-hunks' });
        const checks = [];
        for (const hunk of content.reviewHunks) {
            const row = list.createDiv({ cls: 'assistant-review-hunk' });
            const label = row.createEl('label', { cls: 'assistant-review-check' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = content.reviewSelected.includes(hunk.id);
            checkbox.disabled = !!content.applied || !!content.applying;
            label.createSpan({ text: hunk.atomic ? '整篇建议（保持文档结构完整）' : `修改 ${hunk.id + 1} · 原文第 ${hunk.start + 1} 行` });
            const columns = row.createDiv({ cls: 'assistant-review-columns' });
            for (const [title, value, kind] of [['原内容',hunk.before,'before'],['建议内容',hunk.after,'after']]) {
                const column = columns.createDiv();
                column.createEl('span', { text: title, cls: 'assistant-review-muted' });
                column.createEl('pre', { text: value || (kind === 'before' ? '（此处新增）' : '（删除这段）'), cls: `assistant-review-${kind}` });
            }
            const updateRow = () => row.toggleClass('is-skipped', !checkbox.checked);
            checkbox.addEventListener('change', () => {
                content.reviewSelected = checkbox.checked ? [...content.reviewSelected, hunk.id] : content.reviewSelected.filter(id => id !== hunk.id);
                updateRow(); updateSummary();
            });
            updateRow(); checks.push(checkbox);
        }
        const buttons = card.createDiv({ cls: 'assistant-review-actions' });
        const apply = buttons.createEl('button', { cls: 'mod-cta' });
        const updateSummary = () => {
            const count = content.reviewSelected.length;
            summary.setText(content.applied ? `已接受 ${count} 项修改` : `${content.reviewHunks.length} 项建议 · 已选择 ${count} 项`);
            apply.setText(content.applied ? '撤回本次正文修改' : content.applying ? '正在应用…' : `接受所选 ${count} 项`);
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
        if (!content.applied) buttons.createEl('button', { text: '全不选' }).onclick = () => { if (content.applying) return; content.reviewSelected = []; checks.forEach(c => { c.checked = false; c.dispatchEvent(new Event('change')); }); updateSummary(); };
        card.createEl('p', { text: '只应用勾选的正文差异。笔记有新编辑时将停止应用；属性与位置建议单独确认。', cls: 'assistant-review-muted' });
        updateSummary();
    }

    renderFullArticlePreview(card, task, expanded = false) {
        const content = task.content;
        card.addClass('assistant-review-surface', 'assistant-article-surface');
        const toolbar = card.createDiv({ cls: 'assistant-article-toolbar' });
        const repaint = () => { card.empty(); this.renderDiffPreviewTask(card, task, expanded); };
        const original = content.articleSource === 'original';
        const tabs = toolbar.createDiv({ cls: 'assistant-article-tabs' });
        for (const [value, name] of [['result', '优化后'], ['original', '原文']]) {
            const button = tabs.createEl('button', { text: name, attr: { 'aria-pressed': String(original === (value === 'original')) } });
            button.onclick = () => { content.articleSource = value; repaint(); };
        }
        toolbar.createEl('button', { text: '查看具体修改', cls: 'assistant-article-text-button' }).onclick = () => {
            content.reviewMode = 'changes'; repaint();
        };
        if (!expanded) toolbar.createEl('button', { text: '展开阅读', cls: 'assistant-article-text-button' }).onclick = () => {
            const modal = new Modal(this.plugin.app);
            modal.modalEl.addClass('assistant-review-modal');
            modal.onOpen = () => this.renderDiffPreviewTask(modal.contentEl, task, true);
            modal.open();
        };
        const selected = content.reviewSelected;
        card.createEl('p', { text: content.applied ? '已应用，可撤回本次修改。' : selected.length === content.reviewHunks.length ? '整篇排版预览 · 原笔记尚未修改' : '当前预览包含你选择的修改 · 原笔记尚未修改', cls: 'assistant-review-muted' });
        const article = card.createDiv({ cls: 'assistant-article-preview markdown-rendered' });
        const text = original ? content.originalContent : this.plugin.composeReviewContent(content.originalContent, content.reviewHunks, selected);
        const body = (text || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
        if (MarkdownRenderer?.render) {
            Promise.resolve(MarkdownRenderer.render(this.plugin.app, body, article, content.file?.path || '', this)).catch(() => {
                article.empty(); article.createEl('pre', { text: body });
            });
        } else article.createEl('pre', { text: body });
        const actions = card.createDiv({ cls: 'assistant-review-actions' });
        const apply = actions.createEl('button', { text: content.applied ? '撤回本次修改' : content.applying ? '正在应用…' : selected.length === content.reviewHunks.length ? '应用整篇优化' : '应用所选修改', cls: 'mod-cta' });
        apply.disabled = !!content.applying || (!content.applied && !selected.length);
        apply.onclick = async () => {
            if (content.applying) return;
            content.applying = true; apply.disabled = true; apply.setText('正在处理…');
            try {
                if (content.applied) await this.plugin.undoReviewTask(task.id);
                else await this.plugin.applyDiffPreview(task.id);
            } finally { content.applying = false; repaint(); this.render(); }
        };
    }

    renderResultTask(card, task) {
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
        const closeButton = buttonContainer.createEl("button", { text: "关闭", cls: "mod-cta" });
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
                <code>${escapeHtmlText(content.folderPath)}</code>
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
            cls: content.type === 'error' || task.type === 'error' ? 'error-message' : 'success-message'
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: "确定", cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }









    // 渲染快速操作区域
    renderQuickActions(container) {
        const section = container.createDiv({ cls: "ai-assistant-section" });

        // 标题区域，包含刷新按钮
        const titleContainer = section.createDiv({ cls: "section-title-container" });
        const title = titleContainer.createEl("h3", { text: "快速操作" });
        title.style.margin = "0";
        title.style.flex = "1";

        // 刷新按钮放在标题旁边
        const refreshBtn = titleContainer.createEl("button", {
            text: "刷新",
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
                name: "回滚上次",
                icon: "↩",
                desc: "恢复最近一次应用的内容变更",
                action: () => this.plugin.rollbackLastChange()
            },
            {
                name: "撤销回滚",
                icon: "↪",
                desc: "重新应用刚刚回滚的 AI 变更",
                action: () => this.plugin.redoLastRollback()
            },
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

        const customActions = (this.plugin.settings.customActions || []).filter(action => action.enabled !== false);
        customActions.forEach(action => {
            actions.push({
                name: action.name || '自定义动作',
                icon: "✦",
                desc: this.plugin.getCustomActionModeLabel(action.outputMode),
                action: () => this.plugin.runCustomAction(action.id)
            });
        });

        actions.forEach(action => {
            const actionBtn = actionGrid.createEl("button", { cls: "ai-assistant-action-btn", attr: { type: "button", "aria-label": action.name + "：" + action.desc } });
            actionBtn.createEl("span", { text: action.icon, cls: "action-icon" });
            actionBtn.createEl("span", { text: action.name, cls: "action-name" });
            actionBtn.createEl("span", { text: action.desc, cls: "action-desc" });

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

        const hasValidConfig = this.plugin.settings.apiConfigs?.some(c => c.enabled !== false && this.plugin.hasStoredApiKey(c));
        if (hasValidConfig) {
            apiIndicator.setText("🟢 已配置");
            apiIndicator.addClass("status-good");
        } else {
            apiIndicator.setText("🔴 未配置");
            apiIndicator.addClass("status-error");
        }



        // 模型信息
        const modelStatus = statusGrid.createDiv({ cls: "status-item" });
        modelStatus.createEl("span", { text: "主模型:", cls: "status-label" });
        const activeConfig = this.plugin.getActiveApiConfig();
        modelStatus.createEl("span", {
            text: activeConfig?.modelName || "未设置",
            cls: "status-value"
        });
    }

    // 渲染最近处理历史
    renderRecentHistory(container) {
        const history = this.plugin.getRecentHistory();
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

        // 笔记改名或删除后，把修正过的历史存回插件设置（旧版本存在 localStorage，已迁移）
        if (updatedHistory.length !== history.length ||
            updatedHistory.some((item, index) =>
                item.filePath !== history[index]?.filePath)) {
            this.plugin.settings.processingHistory = updatedHistory;
            void this.plugin.saveSettings();
        }

        if (validHistory.length === 0) {
            const emptyMessage = historyList.createDiv({ cls: "history-empty" });
            emptyMessage.textContent = "暂无有效的处理历史";
            return;
        }

        validHistory.forEach(item => { // 显示所有历史，通过CSS控制滚动
            const historyItem = historyList.createEl("button", { cls: "history-item", attr: { type: "button", "aria-label": "打开笔记：" + item.fileName } });

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
            // 确认对话框
            const confirmed = confirm('确定要清理所有处理历史记录吗？此操作不可撤销。');
            if (confirmed) {
                // 清理插件设置中的历史记录
                this.plugin.settings.processingHistory = [];
                this.plugin.saveSettings();

                // 同时清理可能存在的localStorage数据
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
            }
        });
    }

    // 获取最近处理历史
    // 查找文件的当前位置
    findFileByHistory(historyItem) {
        const allFiles = this.plugin.app.vault.getMarkdownFiles();

        // 首先尝试直接路径匹配
        let file = this.plugin.app.vault.getAbstractFileByPath(historyItem.filePath);
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
        const history = this.plugin.getRecentHistory();
        if (history.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: "📊 使用统计" });

        const statsGrid = section.createDiv({ cls: "ai-assistant-stats-grid" });

        const persistentCounts = this.plugin.settings.actionUsageCounts || {};
        let actionCounts = { ...persistentCounts };

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
        totalStat.createEl("span", { text: "总处理次数:", cls: "stat-label" });
        totalStat.createEl("span", { text: totalCount.toString(), cls: "stat-value" });

        // 最常用功能
        const mostUsed = Object.entries(actionCounts)
            .sort(([, a], [, b]) => b - a)[0];

        if (mostUsed) {
            const mostUsedStat = statsGrid.createDiv({ cls: "stat-item" });
            mostUsedStat.createEl("span", { text: "最常用功能:", cls: "stat-label" });
            mostUsedStat.createEl("span", {
                text: `${mostUsed[0]} (${mostUsed[1]}次)`,
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
        todayStat.createEl("span", { text: "今日处理:", cls: "stat-label" });
        todayStat.createEl("span", { text: todayCount.toString(), cls: "stat-value" });

        if (Object.keys(actionCounts).length > 0) {
            const chartTitle = section.createEl("h4", { text: "各功能累计次数", cls: "stat-subtitle" });
            chartTitle.style.marginTop = "12px";

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

class PromptEditModal extends Modal {
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
            text: '预览模式',
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
                modeToggle.textContent = '编辑模式';
                this.showPreview();
            } else {
                modeToggle.textContent = '预览模式';
                this.showEdit();
            }
        });

        // 底部按钮
        const buttonContainer = contentEl.createDiv({ cls: 'prompt-modal-buttons' });

        const saveBtn = buttonContainer.createEl('button', {
            text: '保存',
            cls: 'mod-cta'
        });
        saveBtn.addEventListener('click', async () => {
            if (this.saved) {
                await this.plugin.saveSettings();
                new Notice('Prompt 已保存!');
            }
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    createEditArea() {
        this.editContainer = this.contentContainer.createDiv({ cls: 'prompt-edit-area' });

        const setting = new Setting(this.editContainer);
        setting.addTextArea(text => {
            this.textArea = text;
            text.setValue(this.plugin.settings[this.settingName])
                .onChange(value => {
                    this.plugin.settings[this.settingName] = value;
                    this.saved = true;
                    // 如果在预览模式，实时更新预览
                    if (this.isPreviewMode) {
                        this.updatePreview(value);
                    }
                });
            text.inputEl.style.width = '100%';
            text.inputEl.style.height = '400px';
            text.inputEl.style.minHeight = '200px';
            text.inputEl.style.fontFamily = 'var(--font-monospace)';
            text.inputEl.style.fontSize = '14px';
            text.inputEl.style.lineHeight = '1.5';
        });
    }

    createPreviewArea() {
        this.previewContainer = this.contentContainer.createDiv({
            cls: 'prompt-preview-area'
        });
        this.previewContainer.style.display = 'none';

        this.previewContent = this.previewContainer.createDiv({
            cls: 'prompt-preview-content'
        });
    }

    showPreview() {
        this.editContainer.style.display = 'none';
        this.previewContainer.style.display = 'block';
        this.updatePreview(this.plugin.settings[this.settingName]);
    }

    showEdit() {
        this.previewContainer.style.display = 'none';
        this.editContainer.style.display = 'block';
    }

    updatePreview(content) {
        // 使用Obsidian的MarkdownRenderer来渲染Markdown
        this.previewContent.empty();

        // 处理占位符，让它们在预览中更明显
        const processedContent = escapeHtmlText(content)
            .replace(/\{\{(\w+)\}\}/g, '<span class="prompt-placeholder">{{$1}}</span>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        this.previewContent.innerHTML = `<p>${processedContent}</p>`;

        // 添加一些基本的样式处理
        this.previewContent.querySelectorAll('.prompt-placeholder').forEach(el => {
            el.style.backgroundColor = 'var(--interactive-accent)';
            el.style.color = 'var(--text-on-accent)';
            el.style.padding = '2px 6px';
            el.style.borderRadius = '4px';
            el.style.fontFamily = 'var(--font-monospace)';
            el.style.fontSize = '0.9em';
        });
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

    initializeSharedServices() {
        const EncryptedSettingsClass = SharedUtils.EncryptedSettings || FallbackEncryptedSettings;
        this.encryptedSettings = new EncryptedSettingsClass({
            namespace: 'ai-assistant-suite'
        });
        if (SharedUtils.RequestManager) {
            this.requestManager = new SharedUtils.RequestManager({
                maxRetries: 1,
                timeout: 120000,
                debug: false
            });
        } else {
            this.requestManager = null;
        }
    }

    normalizeSettings() {
        if (!Array.isArray(this.settings.apiConfigs)) {
            this.settings.apiConfigs = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.apiConfigs));
        }
        this.settings.apiConfigs.forEach((config, index) => {
            if (!config.id) config.id = `config_${index}_${Date.now()}`;
            if (!config.name) config.name = `Config ${index + 1}`;
            if (!config.apiProvider) config.apiProvider = 'openai';
            if (config.apiProvider === 'openai' && /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(config.apiUrl || '')) {
                config.apiProvider = 'deepseek';
            }
            if (config.enabled === undefined) config.enabled = true;
        });
        if (!this.settings.activeConfigId && this.settings.apiConfigs[0]) {
            this.settings.activeConfigId = this.settings.apiConfigs[0].id;
        }
        if (!Array.isArray(this.settings.rollbackHistory)) {
            this.settings.rollbackHistory = [];
        }
        if (!Array.isArray(this.settings.rollbackRedoHistory)) {
            this.settings.rollbackRedoHistory = [];
        }
        if (!Array.isArray(this.settings.customActions)) {
            this.settings.customActions = [];
        }
    }

    getActiveApiConfig() {
        return this.settings.apiConfigs?.find(c => c.id === this.settings.activeConfigId) || this.settings.apiConfigs?.[0] || null;
    }

    getAuxiliaryModelName() {
        const activeConfig = this.getActiveApiConfig();
        return activeConfig?.auxiliaryModelName || activeConfig?.modelName || null;
    }

    // Try the configuration that last answered first, so one dead provider does not
    // add a failed request to every call; the user's order is kept for the rest.
    orderConfigsForFallback(candidates) {
        const index = candidates.findIndex(c => c.id === this.lastWorkingConfigId);
        if (index <= 0) return candidates;
        return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
    }

    hasStoredApiKey(config) {
        return !!(config?.apiKey && config.apiKey !== REDACTED_API_KEY);
    }

    async setApiKey(config, value) {
        if (!config) return;
        if (!value) {
            config.apiKey = '';
            return;
        }
        config.apiKey = await this.encryptedSettings.encryptValue(value);
    }

    async getApiKey(config) {
        if (!config?.apiKey || config.apiKey === REDACTED_API_KEY) {
            return '';
        }
        if (this.encryptedSettings?.isEncryptedValue?.(config.apiKey)) {
            return await this.encryptedSettings.decryptValue(config.apiKey);
        }
        return config.apiKey;
    }

    async migrateApiKeys() {
        let migrated = false;
        for (const config of this.settings.apiConfigs || []) {
            if (config.apiKey &&
                config.apiKey !== REDACTED_API_KEY &&
                !this.encryptedSettings.isEncryptedValue(config.apiKey)) {
                config.apiKey = await this.encryptedSettings.encryptValue(config.apiKey);
                migrated = true;
            }
        }
        return migrated;
    }

    redactSettingsForExport(settings) {
        const clone = JSON.parse(JSON.stringify(settings || {}));
        if (Array.isArray(clone.apiConfigs)) {
            clone.apiConfigs = clone.apiConfigs.map(config => ({
                ...config,
                apiKey: config.apiKey ? REDACTED_API_KEY : ''
            }));
        }
        if (clone.apiKey) {
            clone.apiKey = REDACTED_API_KEY;
        }
        if (Array.isArray(clone.rollbackHistory)) {
            clone.rollbackHistory = [];
        }
        if (Array.isArray(clone.rollbackRedoHistory)) {
            clone.rollbackRedoHistory = [];
        }
        return clone;
    }

    mergeImportedSettings(importedSettings) {
        const existingConfigs = new Map((this.settings.apiConfigs || []).map(config => [config.id, config]));
        const merged = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), importedSettings);
        if (Array.isArray(importedSettings.apiConfigs)) {
            merged.apiConfigs = importedSettings.apiConfigs.map(config => {
                const existing = existingConfigs.get(config.id);
                if (config.apiKey === REDACTED_API_KEY && existing?.apiKey) {
                    return { ...config, apiKey: existing.apiKey };
                }
                return config;
            });
        }
        return merged;
    }

    beginAiOperation(label = 'AI 请求') {
        if (this.currentAbortController && !this.currentAbortController.signal.aborted) {
            this.cancelCurrentRequest('新的 AI 操作已开始');
        }
        this.currentAbortController = new AbortController();
        this.currentRequestLabel = label;
        this.view?.render();
        return this.currentAbortController;
    }

    finishAiOperation(controller) {
        if (this.currentAbortController === controller) {
            this.currentAbortController = null;
            this.currentRequestLabel = null;
            this.view?.render();
        }
    }

    cancelCurrentRequest(reason = '用户取消') {
        if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
            new Notice('当前没有正在运行的 AI 请求。', 2000);
            return;
        }
        this.currentAbortController.abort(reason);
        this.requestManager?.cancelAll?.();
        new Notice('AI 请求已取消。', 2500);
        this.view?.render();
    }

    isCancellationError(error) {
        return error?.name === 'AbortError' ||
            error?.code === 'ABORTED' ||
            error?.message?.includes('aborted') ||
            error?.message?.includes('取消');
    }

    createAbortError(message = 'AI 请求已取消') {
        const error = new Error(message);
        error.name = 'AbortError';
        error.code = 'ABORTED';
        return error;
    }

    normalizeActionName(action) {
        if (!action) return '其他';
        if (action.includes('标签')) return '标签';
        const mapping = {
            '结构优化': '结构',
            '优化结构': '结构',
            '结构': '结构',
            '重命名+元数据': '元数据',
            '更新元数据': '元数据',
            '元数据': '元数据',
            '移动笔记': '移动',
            '移动': '移动',
            '智能移动': '移动',
            '日文假名标注': '假名',
            '假名标注': '假名',
            '假名': '假名',
            '一键智能处理': '一键处理'
        };
        return mapping[action] || action;
    }

    pruneDailyProcessedCounts(maxDays = 90) {
        if (!this.settings.dailyProcessedCounts) return;
        const keys = Object.keys(this.settings.dailyProcessedCounts).sort();
        while (keys.length > maxDays) {
            const key = keys.shift();
            delete this.settings.dailyProcessedCounts[key];
        }
    }

    initializeUsageStatsFromHistory(history) {
        if (!Array.isArray(history) || history.length === 0) return;
        let updated = false;

        if (typeof this.settings.totalProcessedCount !== 'number' ||
            this.settings.totalProcessedCount < history.length) {
            this.settings.totalProcessedCount = history.length;
            updated = true;
        }

        if (!this.settings.actionUsageCounts ||
            Object.keys(this.settings.actionUsageCounts).length === 0) {
            const counts = {};
            history.forEach(item => {
                const normalizedAction = this.normalizeActionName(item.action);
                counts[normalizedAction] = (counts[normalizedAction] || 0) + 1;
            });
            this.settings.actionUsageCounts = counts;
            updated = true;
        }

        if (!this.settings.dailyProcessedCounts ||
            Object.keys(this.settings.dailyProcessedCounts).length === 0) {
            const dailyCounts = {};
            history.forEach(item => {
                const dayKey = new Date(item.timestamp).toISOString().split('T')[0];
                dailyCounts[dayKey] = (dailyCounts[dayKey] || 0) + 1;
            });
            this.settings.dailyProcessedCounts = dailyCounts;
            this.pruneDailyProcessedCounts();
            updated = true;
        }

        if (updated) {
            this.saveSettings();
        }
    }

    async onload() {
        await this.loadSettings();

        // 兼容和迁移旧版本配置到 apiConfigs
        if (!this.settings.apiConfigs || this.settings.apiConfigs.length === 0) {
            this.settings.apiConfigs = DEFAULT_SETTINGS.apiConfigs;
            this.settings.activeConfigId = 'default';
        }

        // 如果仍存在遗留的顶层配置，将其覆盖到 default 配置中且清理它
        if (this.settings.apiKey !== undefined && this.settings.modelName !== undefined) {
            let defaultIdx = this.settings.apiConfigs.findIndex(c => c.id === 'default');
            if (defaultIdx === -1) {
                // 如果没有 default 这个 id，就新建一个或者改第一个
                if (this.settings.apiConfigs.length > 0) {
                     defaultIdx = 0;
                } else {
                     this.settings.apiConfigs.push({...DEFAULT_SETTINGS.apiConfigs[0]});
                     defaultIdx = 0;
                }
            }
            this.settings.apiConfigs[defaultIdx] = {
                ...this.settings.apiConfigs[defaultIdx],
                apiProvider: this.settings.apiProvider || 'openai',
                apiKey: this.settings.apiKey,
                apiUrl: this.settings.apiUrl || DEFAULT_SETTINGS.apiConfigs[0].apiUrl,
                modelName: this.settings.modelName || DEFAULT_SETTINGS.apiConfigs[0].modelName,
                auxiliaryModelName: this.settings.auxiliaryModelName || DEFAULT_SETTINGS.apiConfigs[0].auxiliaryModelName
            };
            
            // 清理旧字段
            delete this.settings.apiProvider;
            delete this.settings.apiKey;
            delete this.settings.apiUrl;
            delete this.settings.modelName;
            delete this.settings.auxiliaryModelName;

            await this.migrateApiKeys();
            await this.saveSettings();
        }

        this.registerView(
            ASSISTANT_VIEW_TYPE,
            (leaf) => (this.view = new AssistantView(leaf, this))
        );

        this.registerView('ai-assistant-note-preview', leaf => new AssistantNotePreview(leaf,this));
        this.registerView(ASSISTANT_WORKBENCH_TYPE, leaf => (this.view = new AssistantView(leaf, this, true)));

        this.addRibbonIcon("anchor", "打开 AI 助手面板", () => {
            this.activateView();
        });

        this.addRibbonIcon('zap', 'AI 智能处理', () => {
            this.runOneClickSmartProcess();
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

        // --- Command 5: Furigana ---
        this.addCommand({
            id: 'run-ai-furigana',
            name: 'Run AI Suite: Add Furigana to Japanese (日文假名标注)',
            callback: () => {
                this.runAiFurigana();
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

        this.addCommand({
            id: 'cancel-current-ai-request',
            name: 'AI Suite: Cancel Current AI Request (取消当前请求)',
            callback: () => {
                this.cancelCurrentRequest('用户取消');
            }
        });

        this.addCommand({
            id: 'rollback-last-ai-change',
            name: 'AI Suite: Rollback Last Change (回滚上次修改)',
            callback: () => {
                this.rollbackLastChange();
            }
        });

        this.addCommand({
            id: 'redo-last-ai-rollback',
            name: 'AI Suite: Redo Last Rollback (撤销回滚)',
            callback: () => {
                this.redoLastRollback();
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

        // 添加简化的智能命令
        this.addCommand({
            id: 'ai-smart-summarize',
            name: 'AI Assistant: Quick Summarize (快速总结)',
            hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "s" }],
            callback: () => {
                this.runSmartAction('summarize');
            }
        });

        this.addCommand({
            id: 'ai-smart-optimize',
            name: 'AI Assistant: Quick Optimize (快速优化)',
            hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "o" }],
            callback: () => {
                this.runSmartAction('optimize');
            }
        });

        this.registerCustomActionCommands();

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new AiAssistantSettingTab(this.app, this));
    }

    onunload() {

        if (this.currentAbortController && !this.currentAbortController.signal.aborted) {
            this.currentAbortController.abort('插件卸载');
        }
        this.requestManager?.cancelAll?.();
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
    async validateApiConfig(configToTest = null) {
        let config = configToTest;
        if (!config) {
            const activeConfigId = this.settings.activeConfigId;
            config = this.settings.apiConfigs?.find(c => c.id === activeConfigId);
        }

        if (!config) {
            return { valid: false, error: '未找到选中的 API 配置。' };
        }

        if (!this.hasStoredApiKey(config) || (!['gemini', 'deepseek'].includes(config.apiProvider) && !config.apiUrl)) {
            return { valid: false, error: '请填写 API Key (以及 API URL 如果必要)。' };
        }

        try {
            const testPrompt = "测试连接，请回复OK";
            await this.makeApiRequest(testPrompt, null, false, config);
            return { valid: true, error: null };
        } catch (error) {
            return { valid: false, error: `连接失败: ${error.message}` };
        }
    }

    getRecentHistory() {
        try {
            if (this.settings.processingHistory) {
                this.initializeUsageStatsFromHistory?.(this.settings.processingHistory);
                return this.settings.processingHistory;
            }
            const history = localStorage.getItem('ai-assistant-history');
            if (history) {
                const parsedHistory = JSON.parse(history);
                this.settings.processingHistory = parsedHistory;
                this.saveSettings();
                this.initializeUsageStatsFromHistory?.(parsedHistory);
                localStorage.removeItem('ai-assistant-history');
                return parsedHistory;
            }
            return [];
        } catch {
            return [];
        }
    }

    addToHistory(fileName, filePath, action, fileId = null) {
        const history = this.getRecentHistory();
        if (!fileId) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            fileId = file ? this.generateFileId(file) : filePath;
        }
        const newItem = {
            fileName,
            filePath,
            action,
            timestamp: Date.now(),
            fileId
        };
        const filtered = history.filter(item =>
            !(item.fileId === fileId && item.action === action)
        );
        filtered.unshift(newItem);
        const limited = filtered.slice(0, 100);
        this.settings.processingHistory = limited;
        if (typeof this.settings.totalProcessedCount !== 'number') {
            this.settings.totalProcessedCount = 0;
        }
        this.settings.totalProcessedCount += 1;
        if (!this.settings.actionUsageCounts) {
            this.settings.actionUsageCounts = {};
        }
        const normalizedAction = this.normalizeActionName
            ? this.normalizeActionName(action)
            : action;
        this.settings.actionUsageCounts[normalizedAction] =
            (this.settings.actionUsageCounts[normalizedAction] || 0) + 1;
        if (!this.settings.dailyProcessedCounts) {
            this.settings.dailyProcessedCounts = {};
        }
        const todayKey = new Date().toISOString().split('T')[0];
        this.settings.dailyProcessedCounts[todayKey] =
            (this.settings.dailyProcessedCounts[todayKey] || 0) + 1;
        if (this.pruneDailyProcessedCounts) {
            this.pruneDailyProcessedCounts();
        }
        this.saveSettings();
    }

    generateFileId(file) {
        return `${file.stat.ctime}-${file.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
    }

    refreshAssistantViews(source = null) {
        for (const type of [ASSISTANT_VIEW_TYPE, ASSISTANT_WORKBENCH_TYPE]) {
            for (const leaf of this.app.workspace.getLeavesOfType(type)) {
                if (leaf.view !== source && leaf.view instanceof AssistantView) leaf.view.render();
            }
        }
    }

    async activateView(expanded = false) {
        const type = expanded ? ASSISTANT_WORKBENCH_TYPE : ASSISTANT_VIEW_TYPE;
        let leaf = this.app.workspace.getLeavesOfType(type)[0];
        if (!leaf) {
            leaf = expanded ? this.app.workspace.getLeaf('tab') : this.app.workspace.getRightLeaf(false);
            await leaf.setViewState({ type, active: true });
        }
        this.view = leaf.view;
        await this.app.workspace.revealLeaf(leaf);
        if (expanded) this.app.workspace.rightSplit?.collapse();
        else this.app.workspace.rightSplit?.expand();
        this.refreshAssistantViews();
    }

    // 通用API请求方法（支持多 Config 顺序 Fallback、取消和 OpenAI-compatible streaming）
    async makeApiRequest(prompt, modelNameOverride = null, expectJson = false, configOverride = null, options = {}) {
        let operationController = null;
        const requestOptions = { ...options };
        if (!requestOptions.signal) {
            operationController = this.beginAiOperation(requestOptions.label || 'AI 请求');
            requestOptions.signal = operationController.signal;
        }

        try {
            if (configOverride) {
                return await this._callSingleConfig(prompt, modelNameOverride, expectJson, configOverride, requestOptions);
            }

            const allConfigs = this.settings.apiConfigs || [];
            const candidates = this.orderConfigsForFallback(
                allConfigs.filter(c => c.enabled !== false && this.hasStoredApiKey(c))
            );

            if (candidates.length === 0) {
                throw new Error("没有可用的 API 配置，请在设置中至少启用一个配置。");
            }

            const errors = [];
            for (let i = 0; i < candidates.length; i++) {
                if (requestOptions.signal?.aborted) {
                    throw this.createAbortError();
                }
                const config = candidates[i];
                const label = config.name || config.id;
                try {
                    const result = await this._callSingleConfig(prompt, modelNameOverride, expectJson, config, requestOptions);
                    this.lastWorkingConfigId = config.id;
                    if (i > 0) {
                        new Notice(`已切换到备用配置「${label}」并成功`);
                    }
                    return result;
                } catch (err) {
                    if (requestOptions.signal?.aborted || this.isCancellationError(err)) {
                        throw this.createAbortError();
                    }
                    const msg = `配置「${label}」失败: ${err.message}`;
                    errors.push(msg);
                    console.warn(`[AI Assistant] ${msg}`);
                    if (i < candidates.length - 1) {
                        new Notice(`${label} 失败，尝试下一个配置...`, 2000);
                    }
                }
            }

            throw new Error(`所有 API 配置均失败（共 ${candidates.length} 个）。\n最后错误: ${errors[errors.length - 1]}`);
        } finally {
            if (operationController) {
                this.finishAiOperation(operationController);
            }
        }
    }

    resolveDeepSeekUrl(value) {
        const url = (value?.trim() || 'https://api.deepseek.com').replace(/\/+$/, '');
        return /\/chat\/completions$/.test(url) ? url : `${url}/chat/completions`;
    }

    // 对单个 config 执行实际的 API 请求
    async _callSingleConfig(prompt, modelNameOverride, expectJson, activeConfig, options = {}) {
        const model = modelNameOverride || activeConfig.modelName || (activeConfig.apiProvider === 'deepseek' ? 'deepseek-flash' : '');
        const provider = activeConfig.apiProvider || 'openai';
        const apiKey = await this.getApiKey(activeConfig);

        if (!apiKey) {
            throw new Error('API Key 为空，请在设置中填写。');
        }

        let url, requestOptions;

        if (provider === 'gemini') {
            url = options.stream && !expectJson
                ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`
                : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            const body = {
                contents: [{ parts: [{ text: prompt }] }]
            };
            if (expectJson) {
                body.generationConfig = { responseMimeType: "application/json" };
            }
            requestOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey
                },
                body: JSON.stringify(body)
            };
        } else {
            if (!activeConfig.apiUrl && provider !== 'deepseek') {
                throw new Error('API URL 为空，请在设置中填写。');
            }
            url = provider === 'deepseek' ? this.resolveDeepSeekUrl(activeConfig.apiUrl) : activeConfig.apiUrl;
            const body = {
                model: model,
                messages: [{ role: "user", content: prompt }]
            };
            if (provider === 'deepseek') body.thinking = { type: activeConfig.deepseekThinking ? 'enabled' : 'disabled' };
            if (expectJson) {
                body.response_format = { type: "json_object" };
            }
            if (options.stream && !expectJson) {
                body.stream = true;
            }
            requestOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(body)
            };
        }

        if (options.stream && provider !== 'gemini' && !expectJson) {
            return await this.callOpenAiStreaming(url, requestOptions, options);
        }
        if (options.stream && provider === 'gemini' && !expectJson) {
            return await this.callGeminiStreaming(url, requestOptions, options);
        }

        const data = await this.executeJsonRequest(url, requestOptions, options);

        let resultText = "";
        if (provider === 'gemini') {
            resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        } else {
            resultText = data.choices?.[0]?.message?.content;
        }

        if (!resultText) {
            console.error("Invalid Response Data:", data);
            throw new Error(`AI 未能返回有效内容。`);
        }

        return resultText;
    }

    // Wraps the caller's cancel signal with a timeout, so a silent server cannot hang the panel forever.
    createRequestTimeout(signal, timeoutMs = 120000) {
        const controller = new AbortController();
        let timedOut = false;
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener?.('abort', () => controller.abort(), { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        return {
            signal: controller.signal,
            clear: () => clearTimeout(timer),
            timedOut: () => timedOut,
            error: () => new Error(`AI 请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应，已停止等待。`)
        };
    }

    async executeJsonRequest(url, requestOptions, options = {}) {
        if (options.signal?.aborted) {
            throw this.createAbortError();
        }

        try {
            if (this.requestManager && !options.forceFetch) {
                const response = await this.requestManager.request({
                    url,
                    method: requestOptions.method || 'POST',
                    headers: requestOptions.headers || {},
                    body: requestOptions.body,
                    signal: options.signal,
                    timeout: options.timeout || 120000,
                    maxRetries: options.maxRetries ?? 1
                });
                if (response.json) return response.json;
                return JSON.parse(response.text);
            }

            const timeout = this.createRequestTimeout(options.signal, options.timeout || 120000);
            let text;
            let response;
            try {
                response = await fetch(url, {
                    ...requestOptions,
                    signal: timeout.signal
                });
                text = await response.text();
            } catch (error) {
                if (timeout.timedOut()) throw timeout.error();
                throw error;
            } finally {
                timeout.clear();
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}. ${text.substring(0, 200)}`);
            }
            return JSON.parse(text);
        } catch (error) {
            if (/秒未响应/.test(error?.message || '')) throw error;
            if (options.signal?.aborted || this.isCancellationError(error)) {
                throw this.createAbortError();
            }
            if (error.response) {
                throw new Error(`HTTP ${error.status || error.response.status}. ${(error.response.text || '').substring(0, 200)}`);
            }
            throw error;
        }
    }

    async callOpenAiStreaming(url, requestOptions, options = {}) {
        // 只限制“等服务器开始回答”的时间；开始输出后长回答不会被截断，仍可手动取消
        const timeout = this.createRequestTimeout(options.signal, options.timeout || 120000);
        let response;
        try {
            response = await fetch(url, {
                ...requestOptions,
                signal: timeout.signal
            });
        } catch (error) {
            if (timeout.timedOut()) throw timeout.error();
            throw error;
        } finally {
            timeout.clear();
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status} ${response.statusText}. ${errorText.substring(0, 200)}`);
        }

        if (!response.body?.getReader) {
            const data = await response.json();
            return data.choices?.[0]?.message?.content || '';
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

        while (true) {
            if (options.signal?.aborted) {
                try { await reader.cancel(); } catch (error) {}
                throw this.createAbortError();
            }
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';

            for (const event of events) {
                const lines = event.split(/\r?\n/).filter(line => line.startsWith('data:'));
                for (const line of lines) {
                    const payload = line.replace(/^data:\s*/, '').trim();
                    if (!payload) continue;
                    if (payload === '[DONE]') {
                        return accumulated;
                    }
                    try {
                        const json = JSON.parse(payload);
                        const delta = json.choices?.[0]?.delta?.content ||
                            json.choices?.[0]?.message?.content ||
                            json.choices?.[0]?.text ||
                            '';
                        if (delta) {
                            accumulated += delta;
                            options.onStream?.(delta, accumulated);
                        }
                    } catch (error) {
                        console.warn('[AI Assistant] 无法解析 streaming chunk');
                    }
                }
            }
        }

        return accumulated;
    }

    async callGeminiStreaming(url, requestOptions, options = {}) {
        // 只限制“等服务器开始回答”的时间；开始输出后长回答不会被截断，仍可手动取消
        const timeout = this.createRequestTimeout(options.signal, options.timeout || 120000);
        let response;
        try {
            response = await fetch(url, {
                ...requestOptions,
                signal: timeout.signal
            });
        } catch (error) {
            if (timeout.timedOut()) throw timeout.error();
            throw error;
        } finally {
            timeout.clear();
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status} ${response.statusText}. ${errorText.substring(0, 200)}`);
        }

        if (!response.body?.getReader) {
            const data = await response.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

        while (true) {
            if (options.signal?.aborted) {
                try { await reader.cancel(); } catch (error) {}
                throw this.createAbortError();
            }

            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';

            for (const event of events) {
                const lines = event.split(/\r?\n/).filter(line => line.startsWith('data:'));
                for (const line of lines) {
                    const payload = line.replace(/^data:\s*/, '').trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        const json = JSON.parse(payload);
                        const delta = json.candidates?.[0]?.content?.parts
                            ?.map(part => part.text || '')
                            .join('') || '';
                        if (delta) {
                            accumulated += delta;
                            options.onStream?.(delta, accumulated);
                        }
                    } catch (error) {
                        console.warn('[AI Assistant] 无法解析 Gemini streaming chunk');
                    }
                }
            }
        }

        return accumulated;
    }

    truncatePreview(content, maxChars = 12000) {
        if (!content || content.length <= maxChars) return content || '';
        return content.substring(0, maxChars) + `\n\n... 已截断预览，完整内容会在 Apply 时写入 ...`;
    }

    getDiffStats(originalContent = '', proposedContent = '') {
        const before = originalContent.split('\n');
        const after = proposedContent.split('\n');
        const max = Math.max(before.length, after.length);
        let changedLines = 0;
        for (let i = 0; i < max; i++) {
            if (before[i] !== after[i]) changedLines++;
        }
        return { changedLines, beforeLines: before.length, afterLines: after.length };
    }

    buildReviewHunks(original, proposed) {
        if (original === proposed) return [];
        const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
        const a = lines(original), b = lines(proposed);
        const frontmatter = text => text.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)?.[0] || '';
        // YAML and fenced code must never be partially accepted across structural boundaries.
        const atomic = a.length + b.length > 20000 || a.length * b.length > 1000000 || frontmatter(original) !== frontmatter(proposed)
            || /^\s*(```|~~~)/m.test(original + proposed);
        if (atomic) return [{ id: 0, start: 0, end: a.length, before: original, after: proposed, atomic: true }];
        const matrix = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
        for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
            matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
        const hunks = []; let i = 0, j = 0, hunk = null;
        const flush = () => { if (hunk) { hunk.id = hunks.length; hunks.push(hunk); hunk = null; } };
        while (i < a.length || j < b.length) {
            if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; continue; }
            if (!hunk) hunk = { start: i, end: i, before: '', after: '' };
            if (j < b.length && (i === a.length || matrix[i][j + 1] > matrix[i + 1][j])) hunk.after += b[j++];
            else { hunk.before += a[i++]; hunk.end = i; }
        }
        flush(); return hunks;
    }

    composeReviewContent(original, hunks, selected) {
        const lines = original.match(/[^\n]*\n|[^\n]+$/g) || [];
        let cursor = 0, result = '';
        for (const hunk of hunks) {
            if (hunk.start < cursor || lines.slice(hunk.start, hunk.end).join('') !== hunk.before) throw new Error('预览已失效，请重新生成。');
            result += lines.slice(cursor, hunk.start).join('');
            result += selected.includes(hunk.id) ? hunk.after : hunk.before;
            cursor = hunk.end;
        }
        return result + lines.slice(cursor).join('');
    }

    async openNotePreview(task) {
        const leaves=this.app.workspace.getLeavesOfType('ai-assistant-note-preview');
        const leaf=leaves[0]||this.app.workspace.getLeaf('tab');
        await leaf.setViewState({type:'ai-assistant-note-preview',active:true});
        await leaf.view.showTask(task);
        this.app.workspace.revealLeaf(leaf);
    }

    composeNoteGroup(group, draft, current) {
        const source=group.tasks.find(t=>t.id===draft.originalTaskId);
        const diff=group.tasks.find(t=>t.id===draft.diffId);
        if(source?.content.originalContent!==undefined&&source.content.originalContent!==current)throw new Error('笔记已有新修改，请重新生成建议。');
        if(diff&&diff.content.originalContent!==current)throw new Error('正文预览已过期，请重新生成。');
        let text=diff?this.composeReviewContent(current,diff.content.reviewHunks||this.buildReviewHunks(current,diff.content.proposedContent),diff.content.reviewSelected|| (diff.content.reviewHunks||this.buildReviewHunks(current,diff.content.proposedContent)).map(h=>h.id)):current;
        if(draft.useMeta||draft.useTags){
            const match=text.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
            const fm=match?(parseYaml(match[1])||{}):{};
            if(typeof fm!=='object'||Array.isArray(fm))throw new Error('笔记属性不是有效的 YAML 对象，未写入。');
            if(draft.useMeta)for(const key of ['title','summary','tldr'])if(draft.meta[key]!==undefined)fm[key]=String(draft.meta[key]).trim();
            if(draft.useTags){const old=Array.isArray(fm.tags)?fm.tags:(fm.tags?[String(fm.tags)]:[]);fm.tags=[...new Set([...old,...draft.tags])];}
            const newline=current.includes('\r\n')?'\r\n':'\n';
            text=`---${newline}${stringifyYaml(fm).trimEnd().replace(/\r?\n/g,newline)}${newline}---${newline}${match?text.slice(match[0].length):text}`;
        }
        return text;
    }

    applyNoteGroup(group,draft) {
        return this.queueContentWrite(async()=>{
            if(group.tasks.at(-1)?.content.noteApplied)return;
            if(this.assistantSession?.workbenchRunning||(this.assistantSession?.tasks||[]).some(t=>t.type==='batch-process'&&t.content?.canInterrupt))throw new Error('请等待当前生成任务结束后再确认。');
            const file=group.file,originalPath=file.path,current=await this.app.vault.read(file);
            const proposed=this.composeNoteGroup(group,draft,current);
            let folder=draft.useFolder?draft.folder:(file.parent?.path||'/');
            folder=String(folder).replace(/^\/+|\/+$/g,'');
            if(folder.split('/').some(p=>p==='..'||p==='.')||/[\\:*?"<>|]/.test(folder))throw new Error('目标文件夹路径无效。');
            let name=file.name||originalPath.split('/').at(-1);
            if(draft.useMeta&&draft.rename){const title=String(draft.meta.title||'').trim().replace(/[/\\:?*"<>|]/g,'-').slice(0,this.settings.metaFileNameMaxLength||100);if(!title||/^\.+$/.test(title))throw new Error('请填写有效的文件名。');name=title+'.md';}
            const destination=folder?folder+'/'+name:name;
            if(destination!==originalPath&&this.app.vault.getAbstractFileByPath(destination))throw new Error('目标位置已有同名文件，未做修改。');
            if(proposed===current&&destination===originalPath)throw new Error('没有选中需要应用的修改。');
            if(folder&&!this.app.vault.getAbstractFileByPath(folder))await this.app.vault.createFolder(folder);
            const snapshot=await this.saveRollbackSnapshot({file,action:'笔记集中确认',originalContent:current,appliedContent:proposed});
            snapshot.originalPath=originalPath;snapshot.filePath=destination;
            await this.saveSettings();
            let wrote=false;
            try{
                await this.guardedWrite(file,current,proposed);wrote=true;
                if(destination!==originalPath)await this.app.fileManager.renameFile(file,destination);
            }catch(error){
                let restored=!wrote;
                if(wrote&&file.path===originalPath){try{await this.guardedWrite(file,proposed,current);restored=true;}catch{}}
                if(restored)this.settings.rollbackHistory=this.settings.rollbackHistory.filter(s=>s.id!==snapshot.id);
                else{snapshot.filePath=file.path;for(const task of group.tasks){task.content.noteSnapshotId=snapshot.id;task.content.noteApplied=true;}}
                await this.saveSettings();throw error;
            }
            snapshot.filePath=file.path;
            for(const task of group.tasks){task.content.noteSnapshotId=snapshot.id;task.content.noteApplied=true;}
            await this.saveSettings();
            this.addToHistory(file.basename,file.path,'笔记集中确认',this.generateFileId(file));
            new Notice('本篇建议已应用，可在任务中撤销。');
        });
    }

    undoNoteGroup(group) {
        return this.queueContentWrite(async()=>{
            const id=group.tasks.find(t=>t.content.noteApplied)?.content.noteSnapshotId;
            const snapshot=(this.settings.rollbackHistory||[]).find(s=>s.id===id);
            if(!snapshot)throw new Error('撤销记录已过期或已撤销。');
            const file=this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if(!file)throw new Error('笔记已移动或删除，请先恢复位置。');
            const target=snapshot.originalPath||snapshot.filePath;
            if(target!==file.path&&this.app.vault.getAbstractFileByPath(target))throw new Error('原位置已有文件，无法撤销归档。');
            if(await this.app.vault.read(file)!==snapshot.appliedContent)throw new Error('笔记有后续编辑，已保留当前内容，无法直接撤销。');
            await this.guardedWrite(file,snapshot.appliedContent,snapshot.originalContent);
            try{if(target!==file.path)await this.app.fileManager.renameFile(file,target);}catch(error){await this.guardedWrite(file,snapshot.originalContent,snapshot.appliedContent);throw error;}
            this.settings.rollbackHistory=this.settings.rollbackHistory.filter(s=>s.id!==id);
            this.settings.rollbackRedoHistory=[];
            for(const task of group.tasks){task.content.noteApplied=false;delete task.content.noteSnapshotId;}
            await this.saveSettings();new Notice('已恢复本篇修改前的内容和位置。');
        });
    }

    async undoReviewTask(taskId) {
        const task = this.view?.getTask(taskId), content = task?.content;
        if (!content?.applied || !content.reviewSnapshotId) return;
        try {
            await this.queueContentWrite(async () => {
                const history = this.settings.rollbackHistory || [];
                const snapshot = history.find(s => s.id === content.reviewSnapshotId);
                if (!snapshot) throw new Error('此修改已撤回或不在撤回记录中。');
                const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
                if (!file) throw new Error('目标笔记已移动或删除。');
                await this.guardedWrite(file, snapshot.appliedContent, snapshot.originalContent);
                this.settings.rollbackHistory = history.filter(s => s.id !== snapshot.id);
                this.settings.rollbackRedoHistory = [snapshot, ...(this.settings.rollbackRedoHistory || [])].slice(0,30);
                await this.saveSettings();
                content.applied = false;
            });
            this.view.render();
            new Notice('已撤回本次正文修改，审阅选择保留。');
        } catch (error) { new Notice(`无法撤回：${error.message}`, 6000); }
    }

    async createDiffPreviewTask({ taskId = null, file, action, title, originalContent, proposedContent }) {
        await this.activateView();
        const id = taskId || `diff-${Date.now()}`;
        const task = {
            id,
            type: 'diff-preview',
            status: 'displaying',
            title: title || `变更预览: ${file.basename}`,
            content: {
                file,
                action,
                originalContent,
                proposedContent,
                originalPreview: this.truncatePreview(originalContent),
                proposedPreview: this.truncatePreview(proposedContent),
                applied: false
            }
        };

        if (this.view.getTask(id)) {
            this.view.updateTask(id, task);
        } else {
            this.view.addTask(task);
        }
        return id;
    }

    async applyDiffPreview(taskId) {
        const task = this.view?.getTask(taskId);
        if (!task || task.type !== 'diff-preview') {
            new Notice('未找到可应用的变更预览。', 3000);
            return;
        }

        const content = task.content || {};
        const file = content.file;
        if (!file) {
            new Notice('变更预览缺少目标文件。', 3000);
            return;
        }

        if (content.applied) return;
        try {
            const hunks = content.reviewHunks || this.buildReviewHunks(content.originalContent || '', content.proposedContent || '');
            const selected = content.reviewSelected || hunks.map(h => h.id);
            if (!selected.length) { new Notice('请至少选择一项修改。'); return; }
            const proposed = this.composeReviewContent(content.originalContent, hunks, selected);
            const snapshot = await this.applyContentChange(file, content.action || 'AI 变更', content.originalContent, proposed);
            content.applied = true;
            content.reviewSnapshotId = snapshot?.id;
            this.addToHistory(file.basename, file.path, content.action || 'AI 变更', this.generateFileId(file));
            this.view.updateTask(taskId, {
                title: task.title || '变更预览',
                content
            });
            new Notice('变更已应用，可用“回滚上次修改”恢复。', 4000);
        } catch (error) {
            new Notice(`应用变更失败: ${error.message}`, 5000);
            console.error('Apply Diff Preview Error:', error);
        }
    }

    async saveRollbackSnapshot({ file, action, originalContent, appliedContent }) {
        const snapshot = {
            id: `rollback-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            timestamp: Date.now(),
            action,
            filePath: file.path,
            fileName: file.basename,
            originalContent,
            appliedContent
        };
        const history = Array.isArray(this.settings.rollbackHistory) ? this.settings.rollbackHistory : [];
        history.unshift(snapshot);
        this.settings.rollbackHistory = history.slice(0, 30);
        this.settings.rollbackRedoHistory = [];
        await this.saveSettings();
        return snapshot;
    }

    queueContentWrite(operation) {
        const next = (this.contentWriteQueue || Promise.resolve()).then(operation);
        this.contentWriteQueue = next.catch(() => {});
        return next;
    }

    async guardedWrite(file, expected, replacement) {
        await this.app.vault.process(file, current => {
            if (current !== expected) {
                throw new Error('笔记已有新修改，已保留当前内容。请重新预览后再应用。');
            }
            return replacement;
        });
    }

    applyContentChange(file, action, expected, replacement) {
        return this.queueContentWrite(async () => {
            const current = await this.app.vault.read(file);
            if (expected !== null && current !== expected) {
                throw new Error('笔记已有新修改，已保留当前内容。请重新生成预览。');
            }
            const proposed = typeof replacement === 'function' ? replacement(current) : replacement;
            if (current === proposed) return;
            const previousUndo = [...(this.settings.rollbackHistory || [])];
            const previousRedo = [...(this.settings.rollbackRedoHistory || [])];
            try {
                const snapshot = await this.saveRollbackSnapshot({ file, action, originalContent: current, appliedContent: proposed });
                await this.guardedWrite(file, current, proposed);
                return snapshot;
            } catch (error) {
                this.settings.rollbackHistory = previousUndo;
                this.settings.rollbackRedoHistory = previousRedo;
                await this.saveSettings();
                throw error;
            }
        });
    }

    async rollbackLastChange() {
        const latest=this.settings.rollbackHistory?.[0];
        if(latest?.originalPath){const tasks=(this.assistantSession?.tasks||[]).filter(t=>t.content?.noteSnapshotId===latest.id);const group={tasks:tasks.length?tasks:[{content:{noteApplied:true,noteSnapshotId:latest.id}}]};try{await this.undoNoteGroup(group);this.view?.render();}catch(e){new Notice(e.message,6000);}return;}
        return this.queueContentWrite(async () => {
            const history = this.settings.rollbackHistory || [];
            const snapshot = history[0];
            if (!snapshot) { new Notice('没有可撤销的内容修改。'); return; }
            const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if (!file) { new Notice('原笔记已移动或删除，请先找到原文件。'); return; }
            try {
                await this.guardedWrite(file, snapshot.appliedContent || '', snapshot.originalContent || '');
                this.settings.rollbackHistory = history.slice(1);
                this.settings.rollbackRedoHistory = [snapshot, ...(this.settings.rollbackRedoHistory || [])].slice(0, 30);
                await this.saveSettings();
                new Notice(`已撤销：${snapshot.fileName}`);
            } catch (error) { new Notice(`无法撤销：${error.message}`, 6000); }
        });
    }

    async redoLastRollback() {
        return this.queueContentWrite(async () => {
            const history = this.settings.rollbackRedoHistory || [];
            const snapshot = history[0];
            if (!snapshot) { new Notice('没有可重做的修改。'); return; }
            const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if (!file) { new Notice('原笔记已移动或删除，请先找到原文件。'); return; }
            try {
                await this.guardedWrite(file, snapshot.originalContent || '', snapshot.appliedContent || '');
                this.settings.rollbackRedoHistory = history.slice(1);
                this.settings.rollbackHistory = [snapshot, ...(this.settings.rollbackHistory || [])].slice(0, 30);
                await this.saveSettings();
                new Notice(`已重做：${snapshot.fileName}`);
            } catch (error) { new Notice(`无法重做：${error.message}`, 6000); }
        });
    }

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
                // await this.app.workspace.getLeaf().openFile(file); // 注释掉自动跳转功能

                // 运行一键处理
                const beforeIds=new Set(this.view.tasks.map(t=>t.id));
                await this.runOneClickSmartProcess(file);
                const failed=this.view.tasks.some(t=>!beforeIds.has(t.id)&&t.type==='error'&&t.content?.file===file);
                if(failed)errorCount++;else processedCount++;

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

    async runAiStructurizer(showCompletionCard = true, targetFile = null) {
        const app = this.app;

        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
            return;
        }

        const currentFile = targetFile || app.workspace.getActiveFile();
        if (!currentFile) {
            new Notice("没有活动的笔记文件。");
            return;
        }

        let contentToProcess = "";
        // Only use activeEditor if we are in interactive mode (no targetFile) AND we want to check for selection
        const activeEditor = !targetFile ? app.workspace.activeEditor?.editor : null;
        let isSelection = false;
        let originalFrontmatter = "";
        let originalFullContent = await app.vault.read(currentFile);
        let selectionStartOffset = null;
        let selectionEndOffset = null;

        // Only process selection if explicitly interactive and selection exists
        if (activeEditor && activeEditor.getSelection()) {
            contentToProcess = activeEditor.getSelection();
            isSelection = true;
            if (activeEditor.posToOffset && activeEditor.getCursor) {
                selectionStartOffset = activeEditor.posToOffset(activeEditor.getCursor('from'));
                selectionEndOffset = activeEditor.posToOffset(activeEditor.getCursor('to'));
            }
        } else {
            const fileCache = app.metadataCache.getFileCache(currentFile);

            let fmFoundByAPI = false;
            if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position && fileCache.frontmatter.position.end.offset) {
                const fmEndOffset = fileCache.frontmatter.position.end.offset;
                originalFrontmatter = originalFullContent.substring(0, fmEndOffset);
                contentToProcess = originalFullContent.substring(fmEndOffset);
                fmFoundByAPI = true;
            }

            if (!fmFoundByAPI && originalFullContent.trim().startsWith('---')) {
                const match = originalFullContent.match(/^(---[\s\S]*?---\s*)/);
                if (match) {
                    originalFrontmatter = match[1];
                    contentToProcess = originalFullContent.substring(originalFrontmatter.length);
                } else {
                    contentToProcess = originalFullContent;
                }
            } else if (!fmFoundByAPI) {
                contentToProcess = originalFullContent;
            }
        }

        if (!contentToProcess || contentToProcess.trim() === "") {
            new Notice("笔记或选中内容为空，无需处理。");
            return;
        }

        let progressNotice = new Notice("AI 正在重构您的笔记结构...", 0);
        let taskId = `structurizer-${Date.now()}`;
        try {
            await this.activateView();
            this.view.addTask({
                id: taskId,
                type: 'structurizer',
                status: 'loading',
                title: `结构优化生成中: ${currentFile.basename}`,
                message: '正在接收 AI 输出...',
                content: { file: currentFile, streamingContent: '' }
            });

            const prompt = this.getStructurizerPrompt(contentToProcess);

            const newContent = await this.makeApiRequest(prompt, null, false, null, {
                label: '结构优化',
                stream: true,
                onStream: (_delta, accumulated) => {
                    this.view?.updateTask(taskId, {
                        streamingContent: accumulated,
                        content: { file: currentFile, streamingContent: accumulated }
                    });
                }
            });

            let proposedContent;
            if (isSelection && activeEditor) {
                const replacement = newContent.trim();
                if (selectionStartOffset !== null && selectionEndOffset !== null) {
                    proposedContent = originalFullContent.substring(0, selectionStartOffset) +
                        replacement +
                        originalFullContent.substring(selectionEndOffset);
                } else {
                    proposedContent = originalFullContent.replace(contentToProcess, replacement);
                }
            } else {
                proposedContent = originalFrontmatter + newContent.trim();
            }

            progressNotice.hide();
            await this.createDiffPreviewTask({
                taskId,
                file: currentFile,
                action: "结构优化",
                title: `结构优化预览: ${currentFile.basename}`,
                originalContent: originalFullContent,
                proposedContent
            });
            new Notice("结构优化预览已生成，请在侧边栏确认 Apply。", 5000);

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                this.view?.removeTask(taskId);
                return;
            }
            new Notice(`处理失败: ${error.message}`, 0);
            this.view?.updateTask(taskId, { status: 'displaying', type: 'error', title: '这次处理未完成', content: { type: 'error', file: currentFile, message: error.message } });
            console.error("AI Structurizer Error:", error);
        }
    }

    async runAiFurigana(showCompletionCard = true, targetFile = null, showProgressNotice = true) {
        const app = this.app;

        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
            return;
        }

        const currentFile = targetFile || app.workspace.getActiveFile();
        if (!currentFile) {
            new Notice("没有活动的笔记文件。");
            return;
        }

        let contentToProcess = "";
        // Only use activeEditor if we are in interactive mode (no targetFile) AND we want to check for selection
        const activeEditor = !targetFile ? app.workspace.activeEditor?.editor : null;
        let isSelection = false;
        let originalFrontmatter = "";
        let originalFullContent = await app.vault.read(currentFile);
        let selectionStartOffset = null;
        let selectionEndOffset = null;

        if (activeEditor && activeEditor.getSelection()) {
            contentToProcess = activeEditor.getSelection();
            isSelection = true;
            if (activeEditor.posToOffset && activeEditor.getCursor) {
                selectionStartOffset = activeEditor.posToOffset(activeEditor.getCursor('from'));
                selectionEndOffset = activeEditor.posToOffset(activeEditor.getCursor('to'));
            }
        } else {
            const fileCache = app.metadataCache.getFileCache(currentFile);

            let fmFoundByAPI = false;
            if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position && fileCache.frontmatter.position.end.offset) {
                const fmEndOffset = fileCache.frontmatter.position.end.offset;
                originalFrontmatter = originalFullContent.substring(0, fmEndOffset);
                contentToProcess = originalFullContent.substring(fmEndOffset);
                fmFoundByAPI = true;
            }

            if (!fmFoundByAPI && originalFullContent.trim().startsWith('---')) {
                const match = originalFullContent.match(/^(---[\s\S]*?---\s*)/);
                if (match) {
                    originalFrontmatter = match[1];
                    contentToProcess = originalFullContent.substring(originalFrontmatter.length);
                } else {
                    contentToProcess = originalFullContent;
                }
            } else if (!fmFoundByAPI) {
                contentToProcess = originalFullContent;
            }
        }

        if (!contentToProcess || contentToProcess.trim() === "") {
            new Notice("笔记或选中内容为空，无需处理。");
            return;
        }

        let progressNotice = showProgressNotice ? new Notice("AI 正在为日文汉字添加假名注音...", 0) : null;
        let taskId = `furigana-${Date.now()}`;
        try {
            await this.activateView();
            this.view.addTask({
                id: taskId,
                type: 'furigana',
                status: 'loading',
                title: `假名标注生成中: ${currentFile.basename}`,
                message: '正在接收 AI 输出...',
                content: { file: currentFile, streamingContent: '' }
            });

            const prompt = this.getFuriganaPrompt(contentToProcess);

            const newContent = await this.makeApiRequest(prompt, null, false, null, {
                label: '假名标注',
                stream: true,
                onStream: (_delta, accumulated) => {
                    this.view?.updateTask(taskId, {
                        streamingContent: accumulated,
                        content: { file: currentFile, streamingContent: accumulated }
                    });
                }
            });

            // 清理可能的代码块标记
            let cleanedContent = newContent.trim();
            if (cleanedContent.startsWith('```')) {
                const lines = cleanedContent.split('\n');
                if (lines[0].match(/^```/)) {
                    lines.shift();
                }
                if (lines[lines.length - 1].match(/^```/)) {
                    lines.pop();
                }
                cleanedContent = lines.join('\n').trim();
            }

            // 修正 inline code 中错误的 ruby：强制改成 括号假名 形式
            cleanedContent = this.convertRubyInInlineCode(cleanedContent);

            let proposedContent;
            if (isSelection && activeEditor) {
                if (selectionStartOffset !== null && selectionEndOffset !== null) {
                    proposedContent = originalFullContent.substring(0, selectionStartOffset) +
                        cleanedContent +
                        originalFullContent.substring(selectionEndOffset);
                } else {
                    proposedContent = originalFullContent.replace(contentToProcess, cleanedContent);
                }
            } else {
                proposedContent = originalFrontmatter + cleanedContent;
            }

            progressNotice?.hide();
            await this.createDiffPreviewTask({
                taskId,
                file: currentFile,
                action: "日文假名标注",
                title: `假名标注预览: ${currentFile.basename}`,
                originalContent: originalFullContent,
                proposedContent
            });
            new Notice("假名标注预览已生成，请在侧边栏确认 Apply。", 5000);

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                this.view?.removeTask(taskId);
                return;
            }
            new Notice(`处理失败: ${error.message}`, 0);
            this.view?.updateTask(taskId, { status: 'displaying', type: 'error', title: '这次处理未完成', content: { type: 'error', file: currentFile, message: error.message } });
            console.error("AI Furigana Error:", error);
        }
    }

    async runAiMover(targetFile = null, showCompletionCard = true) {
        const app = this.app;
        const currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice("没有活动的笔记文件。");
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
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
            const messageContent = await this.makeApiRequest(prompt, null, true);

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
            let taskId = `mover-${Date.now()}`;
            this.view.addTask({
                id: taskId,
                type: 'mover',
                status: 'displaying',
                title: `移动笔记: ${currentFile.basename}`,
                content: { suggestions: suggestions, file: currentFile }
            });

        } catch (error) {
            if (progressNotice) progressNotice.hide();
            if (this.isCancellationError(error)) {
                return;
            }
            new Notice(`处理失败: ${error.message}`, 0);
            console.error("aiMover Script Error:", error);
        }
    }

    async runAiTagger(targetFile = null, showCompletionCard = true) {
        const app = this.app;
        const currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice("没有活动的笔记文件。");
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
            return;
        }

        let content = "";
        const activeEditor = !targetFile ? app.workspace.activeEditor?.editor : null;
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
        let taskId = null;
        try {
            progressNotice.setMessage("正在扫描知识库中的所有标签...");
            const allTagsFromCache = this.app.metadataCache.getTags();
            const existingTags = Object.keys(allTagsFromCache).map(tag => tag.substring(1));

            progressNotice.setMessage("正在请求 AI 生成初步标签...");
            const taggerPrompt = this.getTaggerPrompt(existingTags, content);

            await this.activateView();
            taskId = `tagger-${Date.now()}`;
            this.view.addTask({
                id: taskId,
                type: 'tagger',
                status: 'loading',
                title: `标签建议: ${currentFile.basename}`
            });

            let rawTagsContent = await this.makeApiRequest(taggerPrompt);

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
                        const translationResult = await this.makeApiRequest(translationPrompt, this.getAuxiliaryModelName());
                        const translations = translationResult.trim().split('\n');
                        if (translations && translations.length === tagsToTranslate.length) {
                            translations.forEach((translatedTag, i) => {
                                const originalIndex = originalIndicesOfTagsToTranslate[i];
                                processedTags[originalIndex] = translatedTag.trim();
                            });
                            progressNotice.setMessage("翻译完成，准备显示选项...");
                        } else {
                            new Notice("翻译结果数量与请求不符，跳过翻译。", 3000);
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
                content: { suggestions: tagsForPrompt, file: currentFile, completed: !!targetFile }
            });

        } catch (error) {
            progressNotice?.hide();
            if (taskId) this.view.removeTask(taskId);
            if (this.isCancellationError(error)) {
                return;
            }
            new Notice(`处理失败: ${error.message}`, 0);
            console.error("AI Tagger Error:", error);
        }
    }

    async runAiMeta(targetFile = null, showCompletionCard = true) {
        const app = this.app;
        const currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice("没有活动的笔记文件。");
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
            return;
        }

        let progressNotice = new Notice("正在准备 AI 元数据助手...", 0);
        try {
            let fileText = await app.vault.read(currentFile);
            const fileCache = app.metadataCache.getFileCache(currentFile);
            let content = fileText;

            // 检查现有的frontmatter
            const existingFrontmatter = fileCache?.frontmatter || {};
            const hasExistingSummary = existingFrontmatter.summary && existingFrontmatter.summary.trim();
            const hasExistingTldr = existingFrontmatter.tldr && existingFrontmatter.tldr.trim();

            if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position) {
                content = fileText.substring(fileCache.frontmatter.position.end.offset).trim();
            }

            const editor = !targetFile ? app.workspace.activeEditor?.editor : null;
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

            // 根据已有字段调整AI请求
            let aiGeneratedData = {};

            if (hasExistingSummary && hasExistingTldr) {
                // 如果summary和tldr都存在，只生成title
                progressNotice.setMessage("检测到已有摘要和总结，仅生成标题...");
                const titleOnlyPrompt = this.getTitleOnlyPrompt(content);
                const messageContent = await this.makeApiRequest(titleOnlyPrompt, null, true);

                let parsedContent;
                try {
                    const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
                    parsedContent = JSON.parse(jsonMatch ? jsonMatch[1] : messageContent);
                } catch (e) {
                    throw new Error(`无法解析AI返回的JSON: ${e.message}`);
                }

                aiGeneratedData = {
                    title: parsedContent.title || "未命名标题",
                    summary: existingFrontmatter.summary,
                    tldr: existingFrontmatter.tldr
                };
            } else {
                // 正常生成所有字段，但会在后面使用已有的字段
                progressNotice.setMessage("正在请求 AI 生成元数据...");
                const prompt = this.getMetaPrompt(content, hasExistingSummary, hasExistingTldr);
                const messageContent = await this.makeApiRequest(prompt, null, true);

                let parsedContent;
                try {
                    const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
                    parsedContent = JSON.parse(jsonMatch ? jsonMatch[1] : messageContent);
                } catch (e) {
                    throw new Error(`无法解析AI返回的JSON: ${e.message}`);
                }

                let { title, summary, tldr } = parsedContent;

                // 使用已有字段或AI生成的字段
                aiGeneratedData = {
                    title: title || "未命名标题",
                    summary: hasExistingSummary ? existingFrontmatter.summary : (summary || "暂无摘要，请手动添加"),
                    tldr: hasExistingTldr ? existingFrontmatter.tldr : (tldr || "暂无总结")
                };
            }

            // 使用最终的数据
            const { title, summary, tldr } = aiGeneratedData;

            progressNotice.hide();

            const sanitizedTitle = title.trim().replace(/[/\\:?*"<>|]/g, '-');
            const finalFilename = sanitizedTitle.substring(0, this.settings.metaFileNameMaxLength);
            const newPath = `${currentFile.parent.path}/${finalFilename}.md`;

            await this.activateView();
            let taskId = `meta-${Date.now()}`;
            this.view.addTask({
                id: taskId,
                type: 'meta',
                status: 'displaying',
                title: `元数据建议: ${currentFile.basename}`,
                content: { title, summary, tldr, finalFilename, newPath, file: currentFile }
            });

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                return;
            }
            new Notice(`处理失败: ${error.message}`, 0);
            console.error("AI Meta Error:", error);
        }
    }

    // The sidebar passes the user's one-line request; every prompt built during this run includes it.
    async runOneClickSmartProcess(targetFile = null, selectedActions = null, shouldStop = () => false, instruction = '') {
        this.currentUserInstruction = String(instruction || '').trim();
        try {
            return await this.runOneClickSmartProcessSteps(targetFile, selectedActions, shouldStop);
        } finally {
            this.currentUserInstruction = '';
        }
    }

    userInstructionBlock() {
        if (!this.currentUserInstruction) return '';
        return `\n\n**用户的补充要求（在不编造内容的前提下优先遵守）:**\n${this.currentUserInstruction}`;
    }

    async runOneClickSmartProcessSteps(targetFile = null, selectedActions = null, shouldStop = () => false) {
        const app = this.app;
        let currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice("没有活动的笔记文件。");
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
            return;
        }

        const oneClickProcessActions = { ...(selectedActions || this.settings.oneClickProcessActions) };
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
                await this.runAiStructurizer(false, currentFile);
                if (shouldStop()) { progressNotice.hide(); return; }
                // Re-read file content after potential modification
                // Keep currentFile pinned to the original target.
            }

            if (oneClickProcessActions.furigana) {
                progressNotice.setMessage("正在为笔记添加日文假名注音...");
                await this.runAiFurigana(false, currentFile, false);
                if (shouldStop()) { progressNotice.hide(); return; } // 复用一键处理的进度提示，不再额外弹窗
                // Keep currentFile pinned to the original target.
            }

            const interactiveActions = actions.filter(a => a !== 'structurizer' && a !== 'furigana');
            if (interactiveActions.length === 0) {
                progressNotice.hide();
                new Notice("预处理步骤已完成。没有其他已启用的处理步骤。");
                return;
            }

            // --- 2. Prepare for combined AI call ---
            progressNotice.setMessage("正在准备组合式 AI 请求...");
            let contentToProcess = await app.vault.read(currentFile);
            const noteOriginalContent = contentToProcess;
            const fileCache = app.metadataCache.getFileCache(currentFile);

            // 检查现有的frontmatter
            const existingFrontmatter = fileCache?.frontmatter || {};
            const hasExistingSummary = existingFrontmatter.summary && existingFrontmatter.summary.trim();
            const hasExistingTldr = existingFrontmatter.tldr && existingFrontmatter.tldr.trim();

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
                // 根据已有字段调整JSON结构
                let metaFields = { title: "string" };
                if (!hasExistingSummary) metaFields.summary = "string";
                if (!hasExistingTldr) metaFields.tldr = "string";
                jsonStructure.meta = metaFields;
            }

            let prompt = `你是一个强大的多任务AI助手。请基于以下提供的文本，执行所有请求的任务。

**核心规则**:
1. 在分析时，请**专注于文本内容本身**，忽略任何Markdown链接或嵌入文件（如 \`![...]]\` 或 \`[...](...)\`）所指向的视觉或外部信息。
2. 你的回答必须是一个严格遵守以下结构的JSON对象。

**任务列表:**
${oneClickProcessActions.meta ? this.getMetaTaskDescription(hasExistingSummary, hasExistingTldr) : ''}${oneClickProcessActions.tagger ? `- **生成标签**: 提供约 ${this.settings.taggerSuggestionsCount} 个标签。优先使用"现有标签列表"中的标签，新标签必须是层级格式 (如 a/b/c)。\n` : ''}${oneClickProcessActions.mover ? `- **建议文件夹**: 提供 ${this.settings.moverSuggestionsCount} 个最合适的存放路径建议，可以从"现有文件夹列表"中选择或创造新的。\n` : ''}
**JSON 输出格式:**
\`\`\`json
${JSON.stringify(jsonStructure, null, 2)}
\`\`\`
${contextForPrompt}${this.userInstructionBlock()}

**需要处理的文本如下：**
\n\n${contentToProcess}`;

            if (shouldStop()) { progressNotice.hide(); return; }
            progressNotice.setMessage("正在请求 AI 进行综合分析...");

            const messageContent = await this.makeApiRequest(prompt, null, true);

            let parsedContent;
            try {
                const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
                const contentToParse = jsonMatch ? jsonMatch[1] : messageContent;
                parsedContent = JSON.parse(contentToParse);

                // 确保meta字段的完整性，使用已有字段或AI生成的字段
                if (parsedContent.meta) {
                    // 如果某些字段为空，提供默认值
                    if (!parsedContent.meta.title) parsedContent.meta.title = "未命名标题";

                    // 使用已有字段或AI生成的字段
                    if (hasExistingSummary) {
                        parsedContent.meta.summary = existingFrontmatter.summary;
                    } else if (!parsedContent.meta.summary) {
                        parsedContent.meta.summary = "暂无摘要，请手动添加";
                    }

                    if (hasExistingTldr) {
                        parsedContent.meta.tldr = existingFrontmatter.tldr;
                    } else if (!parsedContent.meta.tldr) {
                        parsedContent.meta.tldr = "暂无总结";
                    }
                }
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
                            const translationResult = await this.makeApiRequest(translationPrompt, this.getAuxiliaryModelName());
                            const translations = translationResult.trim().split('\n');
                            if (translations && translations.length === tagsToTranslate.length) {
                                translations.forEach((translatedTag, i) => {
                                    const originalIndex = originalIndicesOfTagsToTranslate[i];
                                    processedTags[originalIndex] = translatedTag.trim();
                                });
                                progressNotice.setMessage("翻译完成，准备显示选项...");
                            } else {
                                new Notice("翻译结果数量与请求不符，跳过翻译。", 3000);
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
                    originalContent: noteOriginalContent,
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
            if (this.isCancellationError(error)) {
                return;
            }
            new Notice(`一键处理失败: ${error.message}`, 0);
            this.view?.addTask({ id: `error-${Date.now()}`, status: 'displaying', type: 'error', title: '这次处理未完成', content: { type: 'error', file: currentFile, message: error.message } });
            console.error("One Click Process Error:", error);
        }
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

    getMetaPrompt(content, hasExistingSummary = false, hasExistingTldr = false) {
        let prompt = this.settings.metaPrompt;

        // 如果已有某些字段，修改提示词
        if (hasExistingSummary || hasExistingTldr) {
            let skipInstructions = [];
            if (hasExistingSummary) skipInstructions.push("摘要");
            if (hasExistingTldr) skipInstructions.push("一句话总结");

            prompt += `\n\n**注意**: 文件已有${skipInstructions.join("和")}字段，请跳过生成这些字段，只返回需要生成的字段。`;
        }

        return prompt.replace('{{content}}', content);
    }

    getTitleOnlyPrompt(content) {
        return `请为以下文本内容生成一个简洁有力的标题：

${content}

要求：
1. 标题应该准确反映文本的主要内容
2. 长度不超过50字符
3. 避免使用特殊符号和标点
4. 适合作为文件名使用

请返回JSON格式：
{
  "title": "你生成的标题"
}

确保返回的是有效的JSON格式。`;
    }

    getMetaTaskDescription(hasExistingSummary, hasExistingTldr) {
        let tasks = ["生成一个极其简洁的标题（14个字以内）"];

        if (!hasExistingSummary) {
            tasks.push("一段简短摘要（3-4句话）");
        }

        if (!hasExistingTldr) {
            tasks.push("一个一句话总结（25个字以内）");
        }

        let description = `- **生成元数据**: ${tasks.join("、")}。`;

        if (hasExistingSummary || hasExistingTldr) {
            let skipFields = [];
            if (hasExistingSummary) skipFields.push("摘要");
            if (hasExistingTldr) skipFields.push("一句话总结");
            description += ` 注意：文件已有${skipFields.join("和")}字段，请跳过生成这些字段。`;
        }

        return description + "\n";
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
        return this.settings.structurizerPrompt.replace('{{content}}', contentToProcess) + this.userInstructionBlock();
    }

    getFuriganaPrompt(contentToProcess) {
        return this.settings.furiganaPrompt.replace('{{content}}', contentToProcess);
    }

    // 将 inline code (`...`) 里的 <ruby>...<rt>...</rt></ruby> 转成 括号假名：漢字(かな)
    convertRubyInInlineCode(text) {
        if (!text) return text;
        return text.replace(/`([\s\S]*?)`/g, (match, inner) => {
            // 只在 code span 内部替换 ruby，不动反引号本身
            const converted = inner.replace(/<ruby>\s*([^<]+?)\s*<rt>\s*([^<]+?)\s*<\/rt>\s*<\/ruby>/g, (m, kanji, kana) => {
                return `${kanji}(${kana})`;
            });
            return '`' + converted + '`';
        });
    }

    // 提取代码块，用占位符替换，处理后再恢复
    extractCodeBlocks(text) {
        const codeBlocks = [];
        const placeholders = [];
        let placeholderIndex = 0;

        // 先提取代码块（三个反引号），避免行内代码匹配到代码块内的内容
        let processedText = text.replace(/```[\s\S]*?```/g, (match) => {
            const placeholder = `__CODE_BLOCK_${placeholderIndex}__`;
            codeBlocks.push(match);
            placeholders.push(placeholder);
            placeholderIndex++;
            return placeholder;
        });

        // 再提取行内代码（单个反引号，但不在代码块内）
        // 使用非贪婪匹配，避免匹配到多个行内代码
        processedText = processedText.replace(/`[^`]+?`/g, (match) => {
            const placeholder = `__INLINE_CODE_${placeholderIndex}__`;
            codeBlocks.push(match);
            placeholders.push(placeholder);
            placeholderIndex++;
            return placeholder;
        });

        return { processedText, codeBlocks, placeholders };
    }

    // 恢复代码块
    restoreCodeBlocks(text, codeBlocks, placeholders) {
        let restoredText = text;
        placeholders.forEach((placeholder, index) => {
            restoredText = restoredText.replace(placeholder, codeBlocks[index]);
        });
        return restoredText;
    }

    // 简化的智能操作方法
    async runSmartAction(action) {
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
            return;
        }

        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile) {
            new Notice("没有活动的笔记文件。");
            return;
        }

        let progressNotice = new Notice(`正在执行${this.getActionName(action)}...`, 0);

        try {
            // 获取内容
            let content = "";
            const activeEditor = this.app.workspace.activeEditor?.editor;
            if (activeEditor) {
                const selection = activeEditor.getSelection();
                if (selection && selection.trim()) {
                    content = selection.trim();
                    new Notice(`使用选中文本进行${this.getActionName(action)}...`);
                } else {
                    content = await this.app.vault.read(currentFile);
                    // 移除frontmatter
                    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
                    if (frontmatterMatch) {
                        content = content.substring(frontmatterMatch[0].length).trim();
                    }
                }
            } else {
                content = await this.app.vault.read(currentFile);
            }

            if (!content || content.trim() === "") {
                throw new Error("没有内容可以处理。");
            }

            // 构建提示词
            const prompt = this.getSmartActionPrompt(action, content);

            // 调用AI
            progressNotice.setMessage(`正在执行AI${this.getActionName(action)}...`);

            const result = await this.makeApiRequest(prompt, this.getAuxiliaryModelName(), false, null, {
                label: this.getActionName(action),
                stream: true
            });

            progressNotice.hide();

            // 显示结果
            await this.activateView();
            const taskId = `smart-action-${Date.now()}`;
            this.view.addTask({
                id: taskId,
                type: 'quick-action',
                status: 'displaying',
                title: `${this.getActionIcon(action)} ${this.getActionName(action)}结果`,
                content: {
                    action: action,
                    result: result,
                    originalContent: content.length > 200 ? content.substring(0, 200) + "..." : content
                }
            });

            // 添加到历史记录
            this.addToHistory(
                currentFile.basename,
                currentFile.path,
                `${this.getActionName(action)}`,
                this.generateFileId(currentFile)
            );

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                return;
            }
            new Notice(`${this.getActionName(action)}失败: ${error.message}`, 0);
            console.error("Smart Action Error:", error);
        }
    }

    // 获取操作名称
    getActionName(action) {
        const actionNames = {
            'summarize': '总结',
            'optimize': '优化',
            'explain': '解释',
            'analyze': '分析'
        };
        return actionNames[action] || action;
    }

    // 获取操作图标
    getActionIcon(action) {
        const actionIcons = {
            'summarize': '📝',
            'optimize': '✨',
            'explain': '💡',
            'analyze': '🔍'
        };
        return actionIcons[action] || '🤖';
    }

    // 获取智能操作的提示词
    getSmartActionPrompt(action, content) {
        const prompts = {
            'summarize': `请对以下内容进行智能总结。根据内容类型和长度，自动调整总结的详细程度和结构：

${content}`,

            'optimize': `请优化以下内容的表达方式，使其更加清晰、准确和易读。保持原意不变，提升表达质量：

${content}`,

            'explain': `请详细解释以下内容，包括背景、含义、相关概念和实际应用。根据内容复杂度调整解释深度：

${content}`,

            'analyze': `请对以下内容进行综合分析，包括主要观点、逻辑结构、优缺点和改进建议：

${content}`
        };

        return prompts[action] || `请处理以下内容：\n\n${content}`;
    }

    registerCustomActionCommands() {
        (this.settings.customActions || []).forEach(action => {
            if (action.enabled === false || !action.id) return;
            this.addCommand({
                id: `run-custom-action-${this.toCommandId(action.id)}`,
                name: `AI Suite Custom: ${action.name || '自定义动作'}`,
                callback: () => this.runCustomAction(action.id)
            });
        });
    }

    toCommandId(value) {
        return String(value || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    getCustomActionModeLabel(mode) {
        const labels = {
            sidebar: '显示到侧边栏',
            diff: '生成变更预览',
            append: '追加到当前笔记',
            'new-note': '创建新笔记'
        };
        return labels[mode] || labels.sidebar;
    }

    async getCurrentActionContext(targetFile = null) {
        const currentFile = targetFile || this.app.workspace.getActiveFile() || this.assistantLastFile;
        if (!currentFile) {
            throw new Error('没有活动的笔记文件。');
        }

        const editor = this.app.workspace.getActiveFile() === currentFile ? this.app.workspace.activeEditor?.editor : null;
        const originalContent = await this.app.vault.read(currentFile);
        let selection = '';
        let selectionStartOffset = null;
        let selectionEndOffset = null;

        if (editor && editor.getSelection()) {
            selection = editor.getSelection();
            if (editor.posToOffset && editor.getCursor) {
                selectionStartOffset = editor.posToOffset(editor.getCursor('from'));
                selectionEndOffset = editor.posToOffset(editor.getCursor('to'));
            }
        }

        return {
            file: currentFile,
            originalContent,
            content: originalContent,
            selection,
            selectionStartOffset,
            selectionEndOffset
        };
    }

    renderCustomPrompt(template, context) {
        const replacements = {
            content: context.content || '',
            selection: context.selection || '',
            file_name: context.file?.basename || '',
            file_path: context.file?.path || ''
        };
        return String(template || '请处理以下内容：\n\n{{content}}')
            .replace(/\{\{content\}\}/g, replacements.content)
            .replace(/\{\{selection\}\}/g, replacements.selection)
            .replace(/\{\{file_name\}\}/g, replacements.file_name)
            .replace(/\{\{file_path\}\}/g, replacements.file_path);
    }

    buildReplacementContent(context, replacement) {
        const cleaned = String(replacement || '').trim();
        if (context.selection) {
            if (context.selectionStartOffset !== null && context.selectionEndOffset !== null) {
                return context.originalContent.substring(0, context.selectionStartOffset) +
                    cleaned +
                    context.originalContent.substring(context.selectionEndOffset);
            }
            return context.originalContent.replace(context.selection, cleaned);
        }
        return cleaned;
    }

    async createUniqueMarkdownPath(folderPath, baseName) {
        const safeBaseName = (baseName || 'AI Result')
            .replace(/[/\\:?*"<>|]/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 80) || 'AI Result';
        const folderPrefix = folderPath && folderPath !== '/' ? `${folderPath}/` : '';
        let candidate = `${folderPrefix}${safeBaseName}.md`;
        let counter = 2;
        while (this.app.vault.getAbstractFileByPath(candidate)) {
            candidate = `${folderPrefix}${safeBaseName} ${counter}.md`;
            counter++;
        }
        return candidate;
    }

    async runCustomAction(actionId, targetFile = null) {
        const action = (this.settings.customActions || []).find(item => item.id === actionId);
        if (!action || action.enabled === false) {
            new Notice('未找到启用的自定义 AI Action。', 3000);
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.hasStoredApiKey(c));
        if (!hasEnabledConfig) {
            new Notice('请先在AI Assistant Suite插件设置中添加并启用至少一个API配置（需填写API Key）。');
            return;
        }

        const taskId = `custom-action-${Date.now()}`;
        let progressNotice = new Notice(`正在执行 ${action.name || '自定义动作'}...`, 0);

        try {
            const context = await this.getCurrentActionContext(targetFile);
            const prompt = this.renderCustomPrompt(action.prompt, context);
            if (!prompt.trim()) {
                throw new Error('自定义 Action 的 Prompt 为空。');
            }

            await this.activateView();
            this.view.addTask({
                id: taskId,
                type: 'custom-action',
                status: 'loading',
                title: `${action.name || '自定义动作'} 生成中`,
                message: '正在接收 AI 输出...',
                content: { file: context.file, streamingContent: '' }
            });

            const result = await this.makeApiRequest(prompt, this.getAuxiliaryModelName(), false, null, {
                label: action.name || '自定义动作',
                stream: true,
                onStream: (_delta, accumulated) => {
                    this.view?.updateTask(taskId, {
                        streamingContent: accumulated,
                        content: { file: context.file, streamingContent: accumulated }
                    });
                }
            });

            progressNotice.hide();
            const outputMode = action.outputMode || 'sidebar';

            if (outputMode === 'diff') {
                await this.createDiffPreviewTask({
                    taskId,
                    file: context.file,
                    action: action.name || '自定义动作',
                    title: `${action.name || '自定义动作'} 预览: ${context.file.basename}`,
                    originalContent: context.originalContent,
                    proposedContent: this.buildReplacementContent(context, result)
                });
                new Notice('自定义 Action 预览已生成，请在侧边栏确认 Apply。', 5000);
                return;
            }

            if (outputMode === 'append') {
                await this.applyContentChange(context.file, action.name || '自定义动作追加', null,
                    current => `${current}${current.endsWith('\n') ? '\n' : '\n\n'}${result.trim()}\n`);
                this.addToHistory(context.file.basename, context.file.path, action.name || '自定义动作', this.generateFileId(context.file));
                this.view.updateTask(taskId, {
                    type: 'success',
                    status: 'displaying',
                    title: `${action.name || '自定义动作'} 已追加`,
                    content: { message: '结果已追加到当前笔记，可用回滚恢复。', type: 'success', file: context.file }
                });
                new Notice('自定义 Action 结果已追加。', 4000);
                return;
            }

            if (outputMode === 'new-note') {
                const folderPath = context.file.parent?.path || '';
                const newPath = await this.createUniqueMarkdownPath(folderPath, `${context.file.basename} - ${action.name || 'AI Result'}`);
                const newFile = await this.app.vault.create(newPath, result.trim() + '\n');
                this.view.updateTask(taskId, {
                    type: 'success',
                    status: 'displaying',
                    title: `${action.name || '自定义动作'} 已创建新笔记`,
                    content: { message: `已创建: ${newPath}`, type: 'success', file: newFile }
                });
                new Notice(`已创建新笔记: ${newPath}`, 5000);
                return;
            }

            this.view.updateTask(taskId, {
                type: 'custom-action',
                status: 'displaying',
                title: `${action.name || '自定义动作'} 结果`,
                content: {
                    file: context.file,
                    result,
                    originalContent: (context.selection || context.content).substring(0, 500)
                }
            });
            this.addToHistory(context.file.basename, context.file.path, action.name || '自定义动作', this.generateFileId(context.file));
        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                this.view?.removeTask(taskId);
                return;
            }
            this.view?.updateTask(taskId, {
                type: 'error',
                status: 'displaying',
                title: `${action.name || '自定义动作'} 失败`,
                content: { message: error.message, type: 'error' }
            });
            new Notice(`自定义 Action 失败: ${error.message}`, 5000);
            console.error('Custom Action Error:', error);
        }
    }







    async loadSettings() {
        this.initializeSharedServices();
        this.settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), await this.loadData());
        this.normalizeSettings();
        const migrated = await this.migrateApiKeys();
        if (migrated) {
            await this.saveSettings();
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }





    // 导出处理结果
    async exportProcessingResults() {
        if (!this.view || !this.view.history || this.view.history.length === 0) {
            new Notice('没有可导出的处理结果');
            return;
        }

        const exportData = {
            exportTime: new Date().toISOString(),
            version: this.manifest.version,
            history: this.view.history,
            settings: {
                modelName: this.getActiveApiConfig()?.modelName,
                auxiliaryModelName: this.getAuxiliaryModelName()
            }
        };

        const exportContent = JSON.stringify(exportData, null, 2);
        const fileName = `ai-assistant-export-${new Date().toISOString().split('T')[0]}.json`;

        try {
            await this.app.vault.create(fileName, exportContent);
            new Notice(`处理结果已导出到 ${fileName}`);
        } catch (error) {
            new Notice(`导出失败: ${error.message}`);
        }
    }

    // 显示性能监控
    async showPerformanceMonitor() {
        const stats = {
            totalProcessed: this.view?.history?.length || 0,
            cacheHits: this.contextAwareSystem?.contextCache?.size || 0,
            memoryUsage: performance.memory ? {
                used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
                total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024)
            } : null
        };

        await this.activateView();
        if (this.view) {
            this.view.addTask({
                id: `performance-${Date.now()}`,
                type: 'performance',
                status: 'displaying',
                title: '📊 性能监控',
                content: { stats }
            });
        }
    }


}

class AiAssistantSettingTab extends PluginSettingTab {
    plugin;

    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        this.renderSettingsBody();
        const root = this.containerEl;
        root.addClass('plugin-settings-workspace', 'assistant-settings-morning');
        const nav = root.createDiv({ cls: 'atelier-settings-nav' });
        const pages = ['模型连接', '处理偏好', '动作与提示词', '备份与恢复'];
        const sections = Array.from(root.children).filter(el => el.tagName === 'H3');
        const groups = sections.map((heading, index) => {
            const nodes = [heading];
            let node = heading.nextElementSibling;
            while (node && node.tagName !== 'H3' && node !== nav) {
                nodes.push(node); node = node.nextElementSibling;
            }
            return { nodes, page: index === 0 ? 0 : index <= 2 ? 1 : index <= 4 ? 2 : 3 };
        });
        const buttons = [];
        const select = page => {
            this.settingsPage = page;
            groups.forEach(group => group.nodes.forEach(el => { el.hidden = group.page !== page; }));
            buttons.forEach((button, index) => {
                button.setAttribute('aria-pressed', String(index === page));
            });
        };
        pages.forEach((name, index) => {
            const button = nav.createEl('button', { text: name });
            button.onclick = () => select(index);
            buttons.push(button);
        });
        root.children[0].after(nav);
        select(this.settingsPage || 0);
    }

    renderSettingsBody() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: '笔记助手设置' });

        containerEl.createEl('h3', { text: '连接你的模型' });
        containerEl.createEl('p', {
            text: '每个服务独立保存。启用的配置按优先级依次尝试，连接失败时自动使用备用服务。',
            attr: { style: 'font-size: 0.85em; color: var(--text-muted); margin: -4px 0 12px 0;' }
        });

        const activeConfigId = this.plugin.settings.activeConfigId;
        const apiConfigs = this.plugin.settings.apiConfigs;
        // 确保所有配置有 enabled 字段（向后兼容）
        apiConfigs.forEach(c => { if (c.enabled === undefined) c.enabled = true; });
        let activeConfig = apiConfigs.find(c => c.id === activeConfigId);
        
        if (!activeConfig && apiConfigs.length > 0) {
            this.plugin.settings.activeConfigId = apiConfigs[0].id;
            activeConfig = apiConfigs[0];
        }

        const topContainer = containerEl.createDiv({ cls: "api-config-header" });
        topContainer.style.display = "flex";
        topContainer.style.alignItems = "center";
        topContainer.style.gap = "10px";
        topContainer.style.marginBottom = "15px";
        
        new Setting(topContainer)
            .setName('编辑配置')
            .setDesc('选择要查看/编辑的 API 配置（与 Fallback 顺序无关，顺序由列表位置决定）')
            .addDropdown(dropdown => {
                apiConfigs.forEach(config => {
                    const label = config.enabled === false ? `[禁用] ${config.name}` : config.name;
                    dropdown.addOption(config.id, label);
                });
                dropdown.setValue(activeConfigId);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.activeConfigId = value;
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        const actionsContainer = topContainer.createDiv();
        const addButton = actionsContainer.createEl('button', { text: '新增配置' });
        addButton.onclick = async () => {
            const newId = 'config_' + Date.now();
            this.plugin.settings.apiConfigs.push({
                id: newId,
                name: '模型连接 ' + (apiConfigs.length + 1),
                apiProvider: 'openai',
                apiKey: '',
                apiUrl: '',
                modelName: '',
                auxiliaryModelName: '',
                enabled: true
            });
            this.plugin.settings.activeConfigId = newId;
            await this.plugin.saveSettings();
            this.display();
        };

        const deepseekButton = actionsContainer.createEl('button', { text: '添加 DeepSeek' });
        deepseekButton.onclick = async () => {
            const config = { id: `deepseek_${Date.now()}`, name: 'DeepSeek', apiProvider: 'deepseek',
                apiKey: '', apiUrl: 'https://api.deepseek.com/chat/completions',
                modelName: 'deepseek-flash', auxiliaryModelName: 'deepseek-flash',
                deepseekThinking: false, enabled: true };
            apiConfigs.push(config);
            this.plugin.settings.activeConfigId = config.id;
            await this.plugin.saveSettings();
            this.display();
        };

        const delButton = actionsContainer.createEl('button', { text: '删除当前配置' });
        delButton.style.marginLeft = "8px";
        if (apiConfigs.length <= 1) {
            delButton.disabled = true;
        } else {
            delButton.onclick = async () => {
                this.plugin.settings.apiConfigs = apiConfigs.filter(c => c.id !== activeConfigId);
                this.plugin.settings.activeConfigId = this.plugin.settings.apiConfigs[0].id;
                await this.plugin.saveSettings();
                this.display();
            };
        }

        // 优先级调整按钮
        const currentIdx = apiConfigs.findIndex(c => c.id === activeConfigId);
        const upBtn = actionsContainer.createEl('button', { text: '↑ 提高优先级' });
        upBtn.style.marginLeft = "8px";
        upBtn.disabled = currentIdx <= 0;
        upBtn.onclick = async () => {
            if (currentIdx <= 0) return;
            const tmp = apiConfigs[currentIdx - 1];
            apiConfigs[currentIdx - 1] = apiConfigs[currentIdx];
            apiConfigs[currentIdx] = tmp;
            await this.plugin.saveSettings();
            this.display();
        };

        const downBtn = actionsContainer.createEl('button', { text: '↓ 降低优先级' });
        downBtn.style.marginLeft = "4px";
        downBtn.disabled = currentIdx >= apiConfigs.length - 1;
        downBtn.onclick = async () => {
            if (currentIdx >= apiConfigs.length - 1) return;
            const tmp = apiConfigs[currentIdx + 1];
            apiConfigs[currentIdx + 1] = apiConfigs[currentIdx];
            apiConfigs[currentIdx] = tmp;
            await this.plugin.saveSettings();
            this.display();
        };
        
        if (!activeConfig) return;

        containerEl.createEl('hr', { cls: 'atelier-settings-divider' });

        // 显示当前配置的优先级
        const priorityIdx = apiConfigs.findIndex(c => c.id === activeConfigId);
        const enabledCount = apiConfigs.filter(c => c.enabled !== false).length;
        containerEl.createEl('p', {
            text: `优先级 #${priorityIdx + 1}（共 ${apiConfigs.length} 个配置，其中 ${enabledCount} 个已启用）`,
            attr: { style: 'font-size: 0.82em; color: var(--text-accent); margin: 6px 0 12px 0;' }
        });

        new Setting(containerEl)
            .setName('启用此配置')
            .setDesc('禁用后此配置将在 Fallback 列表中被跳过。')
            .addToggle(toggle => toggle
                .setValue(activeConfig.enabled !== false)
                .onChange(async (value) => {
                    activeConfig.enabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('配置名称')
            .addText(text => text
                .setValue(activeConfig.name)
                .onChange(async (value) => {
                    activeConfig.name = value || 'Unnamed Config';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('服务商')
            .setDesc('选择您使用的 AI 服务提供商格式。')
            .addDropdown(dropdown => dropdown
                .addOption('openai', 'OpenAI (兼容格式)')
                .addOption('gemini', 'Google Gemini (官方格式)')
                .addOption('deepseek', 'DeepSeek 官方')
                .setValue(activeConfig.apiProvider || 'openai')
                .onChange(async (value) => {
                    activeConfig.apiProvider = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        let apiKeyInput = null;
        if (activeConfig.apiProvider === 'deepseek') {
            new Setting(containerEl)
                .setName('DeepSeek 模型预设')
                .setDesc('Flash 用于日常整理，Pro 用于复杂改写。下方仍可手动填写模型名。')
                .addDropdown(dropdown => dropdown
                    .addOption('', '选择模型…')
                    .addOption('deepseek-flash', 'DeepSeek Flash')
                    .addOption('deepseek-v4-pro', 'DeepSeek V4 Pro')
                    .setValue(['deepseek-flash', 'deepseek-v4-pro'].includes(activeConfig.modelName) ? activeConfig.modelName : '')
                    .onChange(async value => {
                        if (!value) return;
                        activeConfig.modelName = value;
                        await this.plugin.saveSettings(); this.display();
                    }));
            new Setting(containerEl).setName('深度思考')
                .setDesc('适合复杂内容；等待时间可能增加。默认关闭，方便快速整理笔记。')
                .addToggle(toggle => toggle.setValue(!!activeConfig.deepseekThinking).onChange(async value => {
                    activeConfig.deepseekThinking = value; await this.plugin.saveSettings();
                }));
            containerEl.createEl('p', { cls: 'atelier-provider-note', text: '官方地址：https://api.deepseek.com/chat/completions。留空使用官方地址；也支持填写基础地址。切换已有配置的服务商不会覆盖你保存的地址和模型。' });
        }

        new Setting(containerEl)
            .setName('API Key')
            .setDesc(this.plugin.hasStoredApiKey(activeConfig)
                ? '已保存 API Key。输入新值并点击保存可替换；不会在设置页显示明文。'
                : '在这里填入你的 AI 服务 API Key。保存后会以本地加密标记写入 data.json。')
            .addText(text => {
                text.inputEl.type = 'password';
                text.setPlaceholder(this.plugin.hasStoredApiKey(activeConfig) ? '已保存，输入新值可替换' : 'Enter your API key');
                text.setValue('');
                text.inputEl.autocomplete = 'off';
                text.inputEl.spellcheck = false;
                text.onChange(() => {});
                apiKeyInput = text;
            })
            .addButton(button => button
                .setButtonText('保存密钥')
                .onClick(async () => {
                    const value = apiKeyInput?.getValue?.() || '';
                    if (!value.trim()) {
                        new Notice('请输入新的 API Key。', 2500);
                        return;
                    }
                    await this.plugin.setApiKey(activeConfig, value.trim());
                    await this.plugin.saveSettings();
                    new Notice('API Key 已保存。', 3000);
                    this.display();
                }))
            .addButton(button => button
                .setButtonText('清除密钥')
                .setWarning()
                .onClick(async () => {
                    activeConfig.apiKey = '';
                    await this.plugin.saveSettings();
                    new Notice('API Key 已清除。', 3000);
                    this.display();
                }));

        new Setting(containerEl)
            .setName('API URL')
            .setDesc('在这里填入你的AI服务API URL，例如本地模型的地址。如果使用Gemini官方API，此项将被忽略。')
            .addText(text => text
                .setPlaceholder('https://api.example.com/v1/chat/completions')
                .setValue(activeConfig.apiUrl || '')
                .onChange(async (value) => {
                    activeConfig.apiUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('主模型')
            .setDesc('指定用于内容生成、分析等核心任务的 AI 模型。')
            .addText(text => text
                .setPlaceholder('e.g., gemini-2.5-pro')
                .setValue(activeConfig.modelName || '')
                .onChange(async (value) => {
                    activeConfig.modelName = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('辅助模型')
            .setDesc('指定用于翻译等轻量级任务的 AI 模型，可以选一个更快的。')
            .addText(text => text
                .setPlaceholder('e.g., gemini-2.5-flash')
                .setValue(activeConfig.auxiliaryModelName || '')
                .onChange(async (value) => {
                    activeConfig.auxiliaryModelName = value;
                    await this.plugin.saveSettings();
                }));

        let connectionStatus;
        new Setting(containerEl)
            .setName('检查连接')
            .setDesc('仅测试当前配置，发送一条简短测试消息，不读取笔记。')
            .addButton(button => button.setButtonText('测试连接').onClick(async () => {
                button.setButtonText('正在连接…').setDisabled(true);
                connectionStatus.setText('正在检查当前服务与主模型…');
                try {
                    const { valid, error } = await this.plugin.validateApiConfig(activeConfig);
                    connectionStatus.setText(valid ? '连接成功，可以开始整理笔记。' : error || '连接失败，请检查地址、模型和密钥。');
                } catch (error) {
                    connectionStatus.setText(`连接失败：${error.message}`);
                } finally {
                    button.setButtonText('测试连接').setDisabled(false);
                }
            }));
        connectionStatus = containerEl.createEl('p', { cls: 'atelier-connection-status', attr: { role: 'status', 'aria-live': 'polite' } });

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
            .setName('忽略的文件夹')
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

        new Setting(containerEl).setName('紧凑侧栏').setDesc('缩短建议之间的距离，适合窄侧栏。').addToggle(t=>t.setValue(this.plugin.settings.sidebarCompact!==false).onChange(async value=>{this.plugin.settings.sidebarCompact=value;await this.plugin.saveSettings();this.plugin.refreshAssistantViews?.();}));
        new Setting(containerEl).setName('确认后进入下一篇').setDesc('批量审阅时自动显示下一篇待确认笔记。').addToggle(t=>t.setValue(this.plugin.settings.sidebarAutoNext!==false).onChange(async value=>{this.plugin.settings.sidebarAutoNext=value;await this.plugin.saveSettings();}));
        containerEl.createEl('h3', { text: '默认处理步骤' });
        new Setting(containerEl)
            .setDesc('选择默认生成哪些建议。按笔记集中确认，正文在主编辑区预览后采用。');

        new Setting(containerEl)
            .setName('优化结构 (Structurizer)')
            .setDesc('生成结构与表达的修改建议，逐项审阅后再应用。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.structurizer)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.structurizer = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('假名标注 (Furigana)')
            .setDesc('为笔记中的日文添加假名注音，可与优化结构配合使用。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.furigana)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.furigana = value;
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


        containerEl.createEl('h3', { text: '自定义动作' });
        containerEl.createEl('p', {
            text: 'Prompt 支持 {{content}}、{{selection}}、{{file_name}}、{{file_path}}。新增动作会立即出现在侧边栏；若要作为 Obsidian 命令/热键使用，重载插件后会注册。',
            attr: { style: 'font-size: 0.85em; color: var(--text-muted); margin: -4px 0 12px 0;' }
        });

        const customActions = this.plugin.settings.customActions || [];
        customActions.forEach((action, index) => {
            const actionContainer = containerEl.createDiv({ cls: 'custom-action-settings-block' });
            actionContainer.createEl('h4', { text: action.name || `自定义动作 ${index + 1}` });

            new Setting(actionContainer)
                .setName('启用')
                .addToggle(toggle => toggle
                    .setValue(action.enabled !== false)
                    .onChange(async (value) => {
                        action.enabled = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            new Setting(actionContainer)
                .setName('名称')
                .addText(text => text
                    .setPlaceholder('例如：提取行动项')
                    .setValue(action.name || '')
                    .onChange(async (value) => {
                        action.name = value || '自定义动作';
                        await this.plugin.saveSettings();
                    }));

            new Setting(actionContainer)
                .setName('输出模式')
                .addDropdown(dropdown => dropdown
                    .addOption('sidebar', '侧边栏显示')
                    .addOption('diff', 'Diff Preview')
                    .addOption('append', '追加到当前笔记')
                    .addOption('new-note', '创建新笔记')
                    .setValue(action.outputMode || 'sidebar')
                    .onChange(async (value) => {
                        action.outputMode = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(actionContainer)
                .setName('Prompt')
                .addTextArea(text => {
                    text.setPlaceholder('请基于以下内容执行任务：\n\n{{selection}}\n\n{{content}}')
                        .setValue(action.prompt || '')
                        .onChange(async (value) => {
                            action.prompt = value;
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.style.width = '100%';
                    text.inputEl.style.minHeight = '120px';
                    text.inputEl.style.fontFamily = 'var(--font-monospace)';
                });

            new Setting(actionContainer)
                .setName('删除')
                .setDesc('删除此自定义动作。')
                .addButton(button => button
                    .setButtonText('删除')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.customActions = customActions.filter(item => item.id !== action.id);
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        });

        new Setting(containerEl)
            .setName('添加自定义动作')
            .addButton(button => button
                .setButtonText('新增')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.customActions.push({
                        id: `custom_${Date.now()}`,
                        name: `自定义动作 ${customActions.length + 1}`,
                        prompt: '请基于以下内容执行任务：\n\n{{selection}}\n\n{{content}}',
                        outputMode: 'sidebar',
                        enabled: true
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));


        containerEl.createEl('h3', { text: '内置提示词' });
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
            .setDesc('导出配置与提示词，密钥会被移除。导入后需要另行填写密钥。')
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
        const settingsJson = JSON.stringify(this.plugin.redactSettingsForExport(this.plugin.settings), null, 2);
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

                // 合并设置（保留默认值），且不让 [REDACTED] 覆盖已保存密钥
                this.plugin.settings = this.plugin.mergeImportedSettings(importedSettings);
                this.plugin.normalizeSettings();
                await this.plugin.migrateApiKeys();
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
            this.plugin.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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
        const modal = new AdvancedFileSelectionModal(this.app, (selectedFiles) => {
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

// 高级文件选择模态框 - 支持多种筛选条件
class AdvancedFileSelectionModal extends Modal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
        this.selectedFiles = new Set();
        this.allFiles = this.app.vault.getMarkdownFiles();
        this.filteredFiles = [...this.allFiles];

        // 筛选条件
        this.filters = {
            folder: '',
            tags: '',
            properties: '',
            customQuery: '',
            dateRange: { start: '', end: '' },
            fileSize: { min: '', max: '' }
        };

        // 按文件夹分组
        this.filesByFolder = new Map();
        this.allFiles.forEach(file => {
            const folderPath = file.parent?.path || '/';
            if (!this.filesByFolder.has(folderPath)) {
                this.filesByFolder.set(folderPath, []);
            }
            this.filesByFolder.get(folderPath).push(file);
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // 移除固定尺寸，让Obsidian自适应
        contentEl.style.width = '';
        contentEl.style.maxWidth = '';
        contentEl.style.height = '';

        contentEl.createEl("h2", { text: "高级文件选择器" });

        // 创建主容器
        const mainContainer = contentEl.createDiv({ cls: "ai-assistant-advanced-file-selector-compact" });

        // 顶部筛选栏
        const filterBar = mainContainer.createDiv({ cls: "ai-assistant-filter-bar" });
        this.renderFilterBar(filterBar);

        // 文件列表
        const filePanel = mainContainer.createDiv({ cls: "ai-assistant-file-panel" });
        this.renderFilePanel(filePanel);

        // 底部操作栏
        this.renderBottomActions(contentEl);
    }

    renderFilterBar(container) {
        // 筛选类型选择器
        const filterTypeSelect = container.createEl("select", { cls: "ai-assistant-filter-type-select" });
        filterTypeSelect.innerHTML = `
            <option value="">选择筛选类型</option>
            <option value="folder">文件夹路径</option>
            <option value="tags">标签</option>
            <option value="properties">属性</option>
            <option value="missing-properties">缺少属性</option>
            <option value="query">查询语法</option>
            <option value="date">修改日期</option>
            <option value="size">文件大小</option>
        `;

        // 筛选值容器
        const filterValueContainer = container.createDiv({ cls: "ai-assistant-filter-value-container" });

        // 筛选值输入框
        const filterInput = filterValueContainer.createEl("input", {
            type: "text",
            placeholder: "输入筛选条件...",
            cls: "ai-assistant-filter-value-input"
        });

        // 下拉选择器容器
        const dropdownContainer = filterValueContainer.createDiv({ cls: "ai-assistant-filter-dropdown-container" });
        dropdownContainer.style.display = 'none';

        // 当前筛选类型
        let currentFilterType = '';
        let currentDropdown = null;

        // 筛选类型变化处理
        filterTypeSelect.addEventListener('change', (e) => {
            currentFilterType = e.target.value;
            filterInput.placeholder = this.getFilterPlaceholder(currentFilterType);
            filterInput.value = '';

            // 显示/隐藏下拉选择器
            this.updateFilterDropdown(dropdownContainer, currentFilterType, filterInput);

            this.clearFilters();
        });

        // 筛选值输入处理
        filterInput.addEventListener('input', (e) => {
            const value = e.target.value;
            this.applySingleFilter(currentFilterType, value);
        });

        // 清除按钮
        const clearButton = container.createEl("button", {
            text: "清除",
            cls: "ai-assistant-clear-filter-btn"
        });
        clearButton.addEventListener('click', () => {
            filterTypeSelect.value = '';
            filterInput.value = '';
            dropdownContainer.style.display = 'none';
            currentFilterType = '';
            this.clearFilters();
        });

        // 快速筛选按钮组
        const quickFilters = container.createDiv({ cls: "ai-assistant-quick-filters" });
        quickFilters.innerHTML = `
            <button class="ai-assistant-quick-filter-btn" data-type="folder" data-value="">所有文件</button>
            <button class="ai-assistant-quick-filter-btn" data-type="folder" data-value="current">当前文件夹</button>
            <button class="ai-assistant-quick-filter-btn" data-type="properties" data-value="status: ❌">status: ❌</button>
            <button class="ai-assistant-quick-filter-btn" data-type="missing-properties" data-value="status">缺少status属性</button>
            <button class="ai-assistant-quick-filter-btn" data-type="missing-properties" data-value="tags">缺少tags属性</button>
        `;

        // 快速筛选按钮事件
        quickFilters.addEventListener('click', (e) => {
            if (e.target.classList.contains('ai-assistant-quick-filter-btn')) {
                const type = e.target.dataset.type;
                let value = e.target.dataset.value;

                // 处理当前文件夹
                if (type === 'folder' && value === 'current') {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile && activeFile.parent) {
                        value = activeFile.parent.path;
                    } else {
                        value = '';
                    }
                }

                filterTypeSelect.value = type;
                currentFilterType = type;
                filterInput.placeholder = this.getFilterPlaceholder(type);
                filterInput.value = value;

                this.applySingleFilter(type, value);
            }
        });
    }

    getFilterPlaceholder(type) {
        const placeholders = {
            'folder': '输入文件夹路径，支持通配符 * 和 ?',
            'tags': '输入标签，多个标签用逗号分隔',
            'properties': '格式: 属性名=值 或 属性名:值',
            'missing-properties': '输入属性名，多个属性用逗号分隔',
            'query': '使用查询语法，如: path:folder/ tag:#important',
            'date': '格式: 2024-01-01 或 2024-01-01,2024-12-31',
            'size': '格式: 10 或 10,100 (KB)'
        };
        return placeholders[type] || '输入筛选条件...';
    }

    updateFilterDropdown(container, type, inputElement) {
        container.empty();

        if (!type || !['folder', 'tags', 'properties', 'missing-properties'].includes(type)) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';

        let options = [];

        switch (type) {
            case 'folder':
                options = this.getAllFolders();
                break;
            case 'tags':
                options = this.getAllTags();
                break;
            case 'properties':
                options = this.getAllProperties();
                break;
            case 'missing-properties':
                options = this.getAllProperties();
                break;
        }

        if (options.length === 0) {
            container.style.display = 'none';
            return;
        }

        // 创建可搜索的下拉选择器
        const dropdown = container.createEl("select", { cls: "ai-assistant-filter-dropdown" });
        dropdown.size = Math.min(options.length + 1, 15); // 显示最多15个选项
        dropdown.innerHTML = '<option value="">选择现有值...</option>';

        options.forEach(option => {
            const optionEl = dropdown.createEl("option", {
                text: option,
                value: option
            });
        });

        // 下拉选择器变化处理
        dropdown.addEventListener('change', (e) => {
            if (e.target.value) {
                inputElement.value = e.target.value;
                // 触发筛选
                this.applySingleFilter(type, e.target.value);
            }
        });

        // 输入框输入时过滤下拉选项
        inputElement.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            const dropdownOptions = dropdown.querySelectorAll('option');

            dropdownOptions.forEach(option => {
                if (option.value === '') return; // 保留提示选项

                const optionText = option.text.toLowerCase();
                if (optionText.includes(searchTerm)) {
                    option.style.display = 'block';
                } else {
                    option.style.display = 'none';
                }
            });

            // 同时触发筛选
            this.applySingleFilter(type, e.target.value);
        });

        // 输入框聚焦时显示下拉选择器
        inputElement.addEventListener('focus', () => {
            container.style.display = 'block';
        });

        // 下拉选择器聚焦时保持显示
        dropdown.addEventListener('focus', () => {
            container.style.display = 'block';
        });

        // 点击外部时隐藏下拉选择器
        const hideDropdown = (e) => {
            if (!container.contains(e.target) && e.target !== inputElement) {
                container.style.display = 'none';
            }
        };

        // 延迟添加事件监听器，避免立即触发
        setTimeout(() => {
            document.addEventListener('click', hideDropdown);
        }, 100);
    }

    getAllFolders() {
        const folders = new Set();
        this.allFiles.forEach(file => {
            const folderPath = file.parent?.path || '/';
            if (folderPath !== '/') {
                folders.add(folderPath);
            }
        });
        return Array.from(folders).sort();
    }

    getAllTags() {
        const tags = new Set();
        this.allFiles.forEach(file => {
            try {
                const cache = this.app.metadataCache.getFileCache(file);

                // 从frontmatter中获取标签
                const frontmatterTags = cache?.frontmatter?.tags || [];
                if (Array.isArray(frontmatterTags)) {
                    frontmatterTags.forEach(tag => {
                        if (typeof tag === 'string') {
                            tags.add(tag.startsWith('#') ? tag : '#' + tag);
                        }
                    });
                }

                // 从文件内容中获取标签
                const fileTags = cache?.tags?.map(tag => tag.tag) || [];
                fileTags.forEach(tag => tags.add(tag));

                // 从文件内容中搜索标签模式
                if (cache?.sections) {
                    cache.sections.forEach(section => {
                        if (section.type === 'paragraph' && section.text) {
                            const tagMatches = section.text.match(/#[\w\u4e00-\u9fff-]+/g);
                            if (tagMatches) {
                                tagMatches.forEach(tag => tags.add(tag));
                            }
                        }
                    });
                }
            } catch (e) {
                // 忽略错误
            }
        });
        return Array.from(tags).sort();
    }

    getAllProperties() {
        const properties = new Set();
        this.allFiles.forEach(file => {
            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const frontmatter = cache?.frontmatter || {};
                Object.keys(frontmatter).forEach(key => properties.add(key));
            } catch (e) {
                // 忽略错误
            }
        });
        return Array.from(properties).sort();
    }

    applySingleFilter(type, value) {
        // 重置所有筛选条件
        this.filters = {
            folder: '',
            tags: '',
            properties: '',
            missingProperties: '',
            customQuery: '',
            dateRange: { start: '', end: '' },
            fileSize: { min: '', max: '' }
        };

        if (!type || !value) {
            this.filteredFiles = [...this.allFiles];
            this.updateFileList();
            return;
        }

        switch (type) {
            case 'folder':
                this.filters.folder = value;
                break;
            case 'tags':
                this.filters.tags = value;
                break;
            case 'properties':
                this.filters.properties = value;
                break;
            case 'missing-properties':
                this.filters.missingProperties = value;
                break;
            case 'query':
                this.filters.customQuery = value;
                break;
            case 'date':
                this.parseDateFilter(value);
                break;
            case 'size':
                this.parseSizeFilter(value);
                break;
        }

        this.applyFilters();
    }

    parseDateFilter(value) {
        if (value.includes(',')) {
            const [start, end] = value.split(',').map(s => s.trim());
            this.filters.dateRange.start = start;
            this.filters.dateRange.end = end;
        } else {
            this.filters.dateRange.start = value;
        }
    }

    parseSizeFilter(value) {
        if (value.includes(',')) {
            const [min, max] = value.split(',').map(s => s.trim());
            this.filters.fileSize.min = min;
            this.filters.fileSize.max = max;
        } else {
            this.filters.fileSize.min = value;
        }
    }

    renderFilePanel(container) {
        // 文件统计信息
        const statsContainer = container.createDiv({ cls: "ai-assistant-file-stats" });
        this.statsText = statsContainer.createEl("span", {
            text: `显示 ${this.filteredFiles.length} / ${this.allFiles.length} 个文件`
        });

        // 全选/取消全选按钮
        const selectAllContainer = container.createDiv({ cls: "ai-assistant-select-all-container" });
        const selectAllBtn = selectAllContainer.createEl("button", { text: "全选当前结果" });
        const deselectAllBtn = selectAllContainer.createEl("button", { text: "取消全选" });

        selectAllBtn.addEventListener('click', () => {
            this.filteredFiles.forEach(file => this.selectedFiles.add(file));
            this.updateFileList();
        });

        deselectAllBtn.addEventListener('click', () => {
            this.filteredFiles.forEach(file => this.selectedFiles.delete(file));
            this.updateFileList();
        });

        // 文件列表容器
        this.fileListContainer = container.createDiv({ cls: "ai-assistant-file-list-container" });
        this.updateFileList();
    }

    updateFileList() {
        if (!this.fileListContainer) return;

        this.fileListContainer.empty();
        this.updateSelectionDisplays();

        if (this.filteredFiles.length === 0) {
            this.fileListContainer.createEl("div", {
                text: "没有找到匹配的文件",
                cls: "ai-assistant-no-files-message"
            });
            return;
        }

        // 按文件夹分组显示
        const groupedFiles = new Map();
        this.filteredFiles.forEach(file => {
            const folderPath = file.parent?.path || '/';
            if (!groupedFiles.has(folderPath)) {
                groupedFiles.set(folderPath, []);
            }
            groupedFiles.get(folderPath).push(file);
        });

        // 按文件夹路径排序
        const sortedFolders = Array.from(groupedFiles.keys()).sort();

        sortedFolders.forEach(folderPath => {
            const files = groupedFiles.get(folderPath);

            const folderSection = this.fileListContainer.createDiv({ cls: "ai-assistant-folder-section" });

            // 文件夹标题
            const folderHeader = folderSection.createDiv({ cls: "ai-assistant-folder-header" });
            folderHeader.innerHTML = `
                <span class="ai-assistant-folder-name">📁 ${escapeHtmlText(folderPath)}</span>
                <span class="ai-assistant-folder-count">${files.length} 个文件</span>
            `;

            // 文件夹全选复选框
            const folderSelectAll = folderHeader.createEl("input", {
                type: "checkbox",
                cls: "ai-assistant-folder-select-all"
            });
            folderSelectAll.addEventListener('click', (e) => e.stopPropagation());

            const folderSelectedCount = files.filter(f => this.selectedFiles.has(f)).length;
            folderSelectAll.checked = folderSelectedCount === files.length;
            folderSelectAll.indeterminate = folderSelectedCount > 0 && folderSelectedCount < files.length;

            folderSelectAll.addEventListener('change', () => {
                if (folderSelectAll.checked) {
                    files.forEach(file => this.selectedFiles.add(file));
                } else {
                    files.forEach(file => this.selectedFiles.delete(file));
                }
                fileList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = folderSelectAll.checked);
                this.updateFolderSelectAllState(folderSection, files);
                this.updateSelectionDisplays();
            });

            // 文件列表
            const fileList = folderSection.createDiv({ cls: "ai-assistant-file-list" });

            // 点击文件夹头展开/收起
            folderHeader.addEventListener('click', (event) => {
                // 跳过点击复选框的情况
                if (event.target.closest('input[type="checkbox"]')) {
                    return;
                }
                const isExpanded = fileList.classList.toggle('expanded');
                folderHeader.classList.toggle('expanded', isExpanded);
            });

            files.forEach(file => {
                const fileItem = fileList.createDiv({ cls: "ai-assistant-file-item" });

                const checkbox = fileItem.createEl("input", {
                    type: "checkbox",
                    checked: this.selectedFiles.has(file)
                });

                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.selectedFiles.add(file);
                    } else {
                        this.selectedFiles.delete(file);
                    }
                    this.updateSelectionDisplays();
                    this.updateFolderSelectAllState(folderSection, files);
                });

                const fileInfo = fileItem.createDiv({ cls: "ai-assistant-file-info" });
                fileInfo.innerHTML = `
                    <div class="ai-assistant-file-name">${escapeHtmlText(file.basename)}</div>
                    <div class="ai-assistant-file-meta">
                        <span class="ai-assistant-file-size">${Math.round(file.stat.size / 1024)} KB</span>
                        <span class="ai-assistant-file-date">${new Date(file.stat.mtime).toLocaleDateString()}</span>
                    </div>
                `;
            });
        });
    }

    applyFilters() {
        let filtered = [...this.allFiles];

        // 文件夹筛选
        if (this.filters.folder) {
            const folderPattern = this.filters.folder.replace(/\*/g, '.*').replace(/\?/g, '.');
            const folderRegex = new RegExp(folderPattern, 'i');
            filtered = filtered.filter(file => {
                const folderPath = file.parent?.path || '/';
                return folderRegex.test(folderPath);
            });
        }

        // 标签筛选
        if (this.filters.tags) {
            const tags = this.filters.tags.split(',').map(tag => tag.trim()).filter(tag => tag);
            filtered = filtered.filter(file => {
                try {
                    const cache = this.app.metadataCache.getFileCache(file);

                    // 收集所有可能的标签
                    const allFileTags = new Set();

                    // 从frontmatter中获取标签
                    const frontmatterTags = cache?.frontmatter?.tags || [];
                    if (Array.isArray(frontmatterTags)) {
                        frontmatterTags.forEach(tag => {
                            if (typeof tag === 'string') {
                                allFileTags.add(tag.startsWith('#') ? tag : '#' + tag);
                            }
                        });
                    }

                    // 从文件内容中获取标签
                    const fileTags = cache?.tags?.map(tag => tag.tag) || [];
                    fileTags.forEach(tag => allFileTags.add(tag));

                    // 从文件内容中搜索标签模式
                    if (cache?.sections) {
                        cache.sections.forEach(section => {
                            if (section.type === 'paragraph' && section.text) {
                                const tagMatches = section.text.match(/#[\w\u4e00-\u9fff-]+/g);
                                if (tagMatches) {
                                    tagMatches.forEach(tag => allFileTags.add(tag));
                                }
                            }
                        });
                    }

                    // 检查是否匹配任何筛选标签
                    return tags.some(searchTag => {
                        const normalizedSearchTag = searchTag.toLowerCase();
                        return Array.from(allFileTags).some(fileTag => {
                            const normalizedFileTag = fileTag.toLowerCase();
                            // 支持精确匹配和包含匹配
                            return normalizedFileTag === normalizedSearchTag ||
                                normalizedFileTag.includes(normalizedSearchTag) ||
                                normalizedSearchTag.includes(normalizedFileTag);
                        });
                    });
                } catch (e) {
                    console.error('标签筛选错误:', e);
                    return false;
                }
            });
        }

        // 属性筛选
        if (this.filters.properties) {
            const propertyPairs = this.filters.properties.split(',').map(pair => pair.trim());
            filtered = filtered.filter(file => {
                try {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const frontmatter = cache?.frontmatter || {};

                    return propertyPairs.every(pair => {
                        const [key, value] = pair.split(/[=:]/).map(s => s.trim());
                        if (!key || !value) return true;

                        const fileValue = frontmatter[key];
                        if (typeof fileValue === 'string') {
                            return fileValue.toLowerCase().includes(value.toLowerCase());
                        } else if (Array.isArray(fileValue)) {
                            return fileValue.some(v =>
                                v.toString().toLowerCase().includes(value.toLowerCase())
                            );
                        }
                        return false;
                    });
                } catch (e) {
                    return false;
                }
            });
        }

        // 缺少属性筛选
        if (this.filters.missingProperties) {
            const missingProps = this.filters.missingProperties.split(',').map(prop => prop.trim()).filter(prop => prop);
            filtered = filtered.filter(file => {
                try {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const frontmatter = cache?.frontmatter || {};

                    return missingProps.every(prop => {
                        // 检查属性是否不存在或为空
                        const value = frontmatter[prop];
                        return value === undefined || value === null || value === '' ||
                            (Array.isArray(value) && value.length === 0);
                    });
                } catch (e) {
                    return false;
                }
            });
        }

        // 日期范围筛选
        if (this.filters.dateRange.start || this.filters.dateRange.end) {
            filtered = filtered.filter(file => {
                const fileDate = new Date(file.stat.mtime);
                const startDate = this.filters.dateRange.start ? new Date(this.filters.dateRange.start) : null;
                const endDate = this.filters.dateRange.end ? new Date(this.filters.dateRange.end) : null;

                if (startDate && fileDate < startDate) return false;
                if (endDate && fileDate > endDate) return false;
                return true;
            });
        }

        // 文件大小筛选
        if (this.filters.fileSize.min || this.filters.fileSize.max) {
            filtered = filtered.filter(file => {
                const fileSizeKB = file.stat.size / 1024;
                const minSize = this.filters.fileSize.min ? parseFloat(this.filters.fileSize.min) : 0;
                const maxSize = this.filters.fileSize.max ? parseFloat(this.filters.fileSize.max) : Infinity;

                return fileSizeKB >= minSize && fileSizeKB <= maxSize;
            });
        }

        // Obsidian查询语法筛选
        if (this.filters.customQuery) {
            try {
                // 简单的查询语法解析
                const query = this.filters.customQuery.toLowerCase();
                filtered = filtered.filter(file => {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const frontmatter = cache?.frontmatter || {};
                    const tags = cache?.tags?.map(tag => tag.tag) || [];

                    // 解析查询条件
                    const conditions = query.split(/\s+/);
                    return conditions.every(condition => {
                        if (condition.startsWith('path:')) {
                            const pathPattern = condition.substring(5);
                            return file.path.toLowerCase().includes(pathPattern);
                        } else if (condition.startsWith('tag:')) {
                            const tagPattern = condition.substring(4);
                            return tags.some(tag => tag.toLowerCase().includes(tagPattern));
                        } else if (condition.includes(':')) {
                            const [key, value] = condition.split(':');
                            const fileValue = frontmatter[key];
                            if (typeof fileValue === 'string') {
                                return fileValue.toLowerCase().includes(value);
                            } else if (Array.isArray(fileValue)) {
                                return fileValue.some(v =>
                                    v.toString().toLowerCase().includes(value)
                                );
                            }
                            return false;
                        } else {
                            // 全文搜索
                            return file.basename.toLowerCase().includes(condition);
                        }
                    });
                });
            } catch (e) {
                console.error('查询语法解析错误:', e);
            }
        }

        this.filteredFiles = filtered;
        this.updateFileList();
    }

    clearFilters() {
        this.filters = {
            folder: '',
            tags: '',
            properties: '',
            missingProperties: '',
            customQuery: '',
            dateRange: { start: '', end: '' },
            fileSize: { min: '', max: '' }
        };

        // 清除所有输入框
        const inputs = this.contentEl.querySelectorAll('.filter-input, .filter-textarea, .date-input, .size-input');
        inputs.forEach(input => input.value = '');

        this.filteredFiles = [...this.allFiles];
        this.updateFileList();
    }

    renderBottomActions(container) {
        const actionsContainer = container.createDiv({ cls: "ai-assistant-bottom-actions" });

        const selectedCount = actionsContainer.createEl("span", {
            text: `已选择 ${this.selectedFiles.size} 个文件`,
            cls: "ai-assistant-selected-count"
        });
        this.bottomSelectedCount = selectedCount;

        const confirmBtn = actionsContainer.createEl("button", {
            text: "确认选择",
            cls: "mod-cta"
        });

        const cancelBtn = actionsContainer.createEl("button", {
            text: "取消",
            cls: "mod-cancel"
        });

        confirmBtn.addEventListener('click', () => {
            if (this.selectedFiles.size === 0) {
                new Notice("请至少选择一个文件", 2000);
                return;
            }
            this.onChoose(Array.from(this.selectedFiles));
            this.close();
        });

        cancelBtn.addEventListener('click', () => this.close());
    }

    /**
     * 更新顶部/底部的选择计数与统计文本，不触发重渲染
     */
    updateSelectionDisplays() {
        if (this.statsText) {
            this.statsText.textContent = `显示 ${this.filteredFiles.length} / ${this.allFiles.length} 个文件，已选择 ${this.selectedFiles.size} 个`;
        }
        if (this.bottomSelectedCount) {
            this.bottomSelectedCount.textContent = `已选择 ${this.selectedFiles.size} 个文件`;
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 简洁的文件选择模态框 - 使用Obsidian原生样式
class SimpleFileSelectionModal extends Modal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
        this.selectedFiles = new Set();
        this.allFiles = this.app.vault.getMarkdownFiles();

        // 获取当前文件所在文件夹
        const activeFile = this.app.workspace.getActiveFile();
        this.currentFolder = activeFile?.parent;

        // 按文件夹分组
        this.filesByFolder = new Map();
        this.allFiles.forEach(file => {
            const folderPath = file.parent?.path || '/';
            if (!this.filesByFolder.has(folderPath)) {
                this.filesByFolder.set(folderPath, []);
            }
            this.filesByFolder.get(folderPath).push(file);
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "选择要批量处理的文件" });

        // 当前文件夹优先显示
        if (this.currentFolder) {
            this.renderFolderSection(contentEl, this.currentFolder.path || '/', '📁 当前文件夹', true);
        }

        // 其他文件夹
        const otherFolders = Array.from(this.filesByFolder.keys())
            .filter(path => path !== (this.currentFolder?.path || '/'))
            .sort();

        if (otherFolders.length > 0) {
            const otherSection = contentEl.createDiv({ cls: "ai-assistant-other-folders-section" });
            otherSection.createEl("h3", { text: "其他文件夹" });

            // 搜索框
            const searchContainer = otherSection.createDiv({ cls: "ai-assistant-search-container" });
            const searchInput = searchContainer.createEl("input", {
                type: "text",
                placeholder: "搜索文件夹或文件...",
                cls: "ai-assistant-search-input"
            });

            const foldersContainer = otherSection.createDiv({ cls: "ai-assistant-folders-container" });

            // 初始显示所有文件夹
            this.renderOtherFolders(foldersContainer, otherFolders);

            // 搜索功能
            searchInput.addEventListener('input', (e) => {
                const searchTerm = e.target.value.toLowerCase().trim();
                if (searchTerm === '') {
                    this.renderOtherFolders(foldersContainer, otherFolders);
                } else {
                    this.searchAndRender(foldersContainer, searchTerm);
                }
            });
        }

        // 底部信息和按钮
        this.renderBottom(contentEl);
    }

    renderFolderSection(container, folderPath, title, isExpanded = false) {
        const files = this.filesByFolder.get(folderPath) || [];
        if (files.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-folder-section" });

        const header = section.createDiv({ cls: "ai-assistant-folder-header" });

        // 创建标题和文件数量
        const titleContainer = header.createDiv({ cls: "ai-assistant-folder-title-container" });
        titleContainer.innerHTML = `
            <span class="ai-assistant-folder-title">${title}</span>
            <span class="ai-assistant-file-count">${files.length} 个文件</span>
        `;

        // 创建全选复选框
        const selectAllCheckbox = header.createEl("input", {
            type: "checkbox",
            cls: "ai-assistant-folder-select-all-checkbox"
        });

        selectAllCheckbox.addEventListener('change', (e) => {
            e.stopPropagation(); // 防止触发文件夹展开/收起
            if (selectAllCheckbox.checked) {
                files.forEach(file => this.selectedFiles.add(file));
            } else {
                files.forEach(file => this.selectedFiles.delete(file));
            }
            this.updateCheckboxes();
        });

        const fileList = section.createDiv({ cls: "ai-assistant-file-list" });
        // 强制可见，防止样式或点击问题导致看不到文件
        fileList.style.display = 'block';
        fileList.style.padding = '0';

        files.forEach(file => {
            const fileItem = fileList.createDiv({ cls: "ai-assistant-file-item" });
            fileItem.style.display = 'flex';
            fileItem.style.alignItems = 'center';
            fileItem.style.gap = '8px';

            const checkbox = fileItem.createEl("input", { type: "checkbox" });
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedFiles.add(file);
                } else {
                    this.selectedFiles.delete(file);
                }
                this.updateSelectedCount();
                this.updateFolderSelectAllState(section, files);
            });

            const fileInfo = fileItem.createDiv({ cls: "ai-assistant-file-info" });

            const label = fileInfo.createEl("label", { text: file.basename });
            label.addEventListener('click', () => {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            });

            const path = fileInfo.createEl("div", {
                text: file.path,
                cls: "ai-assistant-file-path"
            });
        });

        // 初始化全选复选框状态
        this.updateFolderSelectAllState(section, files);
    }

    renderOtherFolders(container, folderPaths) {
        container.empty();
        folderPaths.forEach(folderPath => {
            const displayName = folderPath === '/' ? '📁 根目录' : `📁 ${folderPath}`;
            this.renderFolderSection(container, folderPath, displayName);
        });
    }

    searchAndRender(container, searchTerm) {
        container.empty();

        let hasResults = false;
        this.filesByFolder.forEach((files, folderPath) => {
            const matchingFiles = files.filter(file =>
                file.basename.toLowerCase().includes(searchTerm) ||
                file.path.toLowerCase().includes(searchTerm)
            );

            if (matchingFiles.length > 0) {
                hasResults = true;
                const section = container.createDiv({ cls: "ai-assistant-folder-section" });

                const header = section.createDiv({ cls: "ai-assistant-folder-header expanded" });

                // 创建标题和文件数量
                const titleContainer = header.createDiv({ cls: "ai-assistant-folder-title-container" });
                const displayName = folderPath === '/' ? '📁 根目录' : `📁 ${folderPath}`;
                titleContainer.innerHTML = `
                    <span class="ai-assistant-folder-title">${displayName}</span>
                    <span class="ai-assistant-file-count">${matchingFiles.length} 个匹配文件</span>
                `;

                // 创建全选复选框
                const selectAllCheckbox = header.createEl("input", {
                    type: "checkbox",
                    cls: "ai-assistant-folder-select-all-checkbox"
                });

                selectAllCheckbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (selectAllCheckbox.checked) {
                        matchingFiles.forEach(file => this.selectedFiles.add(file));
                    } else {
                        matchingFiles.forEach(file => this.selectedFiles.delete(file));
                    }
                    this.updateCheckboxes();
                });

                const fileList = section.createDiv({ cls: "ai-assistant-file-list" });
                fileList.style.display = 'block';

                matchingFiles.forEach(file => {
                    const fileItem = fileList.createDiv({ cls: "ai-assistant-file-item" });

                    const checkbox = fileItem.createEl("input", { type: "checkbox" });
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) {
                            this.selectedFiles.add(file);
                        } else {
                            this.selectedFiles.delete(file);
                        }
                        this.updateSelectedCount();
                        this.updateFolderSelectAllState(section, matchingFiles);
                    });

                    const fileInfo = fileItem.createDiv({ cls: "ai-assistant-file-info" });

                    const label = fileInfo.createEl("label", { text: file.basename });
                    label.addEventListener('click', () => {
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                    });

                    const path = fileInfo.createEl("div", {
                        text: file.path,
                        cls: "ai-assistant-file-path"
                    });
                });

                // 初始化全选复选框状态
                this.updateFolderSelectAllState(section, matchingFiles);
            }
        });

        if (!hasResults) {
            const noResults = container.createDiv({ cls: "ai-assistant-no-results" });
            noResults.innerHTML = `
                <div class="ai-assistant-no-results-icon">🔍</div>
                <div class="ai-assistant-no-results-text">没有找到匹配的文件</div>
            `;
        }
    }

    renderBottom(container) {
        // 选中计数
        this.selectedCountEl = container.createDiv({ cls: "ai-assistant-selected-count" });
        this.updateSelectedCount();

        // 按钮
        const buttonContainer = container.createDiv({ cls: "modal-button-container" });

        const confirmBtn = buttonContainer.createEl("button", {
            text: "开始批量处理",
            cls: "mod-cta"
        });
        confirmBtn.addEventListener('click', () => {
            if (this.selectedFiles.size > 0) {
                this.onChoose(Array.from(this.selectedFiles));
                this.close();
            } else {
                new Notice("请至少选择一个文件");
            }
        });

        const cancelBtn = buttonContainer.createEl("button", { text: "取消" });
        cancelBtn.addEventListener('click', () => this.close());
    }

    updateSelectedCount() {
        if (this.selectedCountEl) {
            this.selectedCountEl.textContent = `已选择 ${this.selectedFiles.size} 个文件`;
        }
    }

    updateCheckboxes() {
        // 更新文件复选框
        const fileCheckboxes = this.contentEl.querySelectorAll('.ai-assistant-file-item input[type="checkbox"]');
        fileCheckboxes.forEach((checkbox) => {
            const fileItem = checkbox.closest('.ai-assistant-file-item');
            if (fileItem) {
                const label = fileItem.querySelector('label');
                if (label) {
                    const fileName = label.textContent;
                    const file = this.allFiles.find(f => f.basename === fileName);
                    if (file) {
                        checkbox.checked = this.selectedFiles.has(file);
                    }
                }
            }
        });

        // 更新所有文件夹的全选复选框状态
        const folderSections = this.contentEl.querySelectorAll('.ai-assistant-folder-section');
        folderSections.forEach(section => {
            const folderSelectAllCheckbox = section.querySelector('.ai-assistant-folder-select-all-checkbox');
            if (folderSelectAllCheckbox) {
                const titleElement = section.querySelector('.ai-assistant-folder-title');
                if (titleElement) {
                    const folderTitle = titleElement.textContent;
                    // 根据标题找到对应的文件夹路径
                    let folderPath = '/';
                    if (folderTitle.includes('当前文件夹')) {
                        folderPath = this.currentFolder?.path || '/';
                    } else {
                        // 从标题中提取文件夹路径
                        const pathMatch = folderTitle.match(/📁\s*(.+)/);
                        if (pathMatch) {
                            folderPath = pathMatch[1] === '根目录' ? '/' : pathMatch[1];
                        }
                    }

                    const files = this.filesByFolder.get(folderPath) || [];
                    this.updateFolderSelectAllState(section, files);
                }
            }
        });

        this.updateSelectedCount();
    }

    updateFolderSelectAllState(section, files) {
        const folderSelectAllCheckbox = section.querySelector('.ai-assistant-folder-select-all-checkbox');
        if (!folderSelectAllCheckbox || files.length === 0) return;

        const selectedFilesInFolder = files.filter(file => this.selectedFiles.has(file));

        if (selectedFilesInFolder.length === 0) {
            folderSelectAllCheckbox.checked = false;
            folderSelectAllCheckbox.indeterminate = false;
        } else if (selectedFilesInFolder.length === files.length) {
            folderSelectAllCheckbox.checked = true;
            folderSelectAllCheckbox.indeterminate = false;
        } else {
            folderSelectAllCheckbox.checked = false;
            folderSelectAllCheckbox.indeterminate = true;
        }
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
        const selectAllContainer = contentEl.createDiv({ cls: "ai-assistant-select-all-container" });
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
        const fileList = contentEl.createDiv({ cls: "ai-assistant-modal-file-list" });
        this.fileList = fileList;

        this.files.forEach(file => {
            const fileItem = fileList.createDiv({ cls: "ai-assistant-modal-file-item" });

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







module.exports = AiAssistantSuite;
