import { apiVersion, Platform, Plugin, Notice, parseYaml, stringifyYaml, requestUrl } from 'obsidian';
import { AiClient, ModelCache, getProvider, migrateKey, nodeCliRunner, requestUrlTransport } from './vendor/rex-ai-kit/index';
import * as mergeDraft from './merge-draft';
import { API_PROBLEM_KINDS, ASSISTANT_VIEW_TYPE, ASSISTANT_WORKBENCH_TYPE, DEFAULT_SETTINGS, FIRST_RUN_ORDER, GlassModal, PLUGIN_SECRET_PREFIX, PROMPT_DEFAULTS, REDACTED_API_KEY, SETTINGS_KINDS, aiLang, classifyApiError, connectionChecks, defaultModelOf, describeApiProblem, hostOf, isChineseInterface, providerLabel, providerOf, readLegacyKey, sharedSecretNameFor, slotFromLegacyConfig, slotOf, tr } from './shared';
import { AssistantNotePreview, AssistantView } from './views';
import { BatchFileSelectionModal, MERGE_BLOCKERS, MergeDraftModal, MergeNotePicker, mergeLabels } from './modals';
import { AiAssistantSettingTab } from './settings-tab';

class AiAssistantSuite extends Plugin {
    static mergeDraft = mergeDraft;
    view = null;

    debounceTimers = new Map(); // 添加防抖定时器

    // 1.3 之前只有一套服务，字段直接放在顶层；升级时转成一条配置，不丢密钥和模型
    migrateLegacySettings() {
        const legacyKeys = ['apiProvider', 'apiKey', 'apiUrl', 'modelName', 'auxiliaryModelName'];
        const hasLegacy = legacyKeys.some(key => this.settings[key] !== undefined);
        if (!hasLegacy) return false;
        if (!Array.isArray(this.settings.apiConfigs) || !this.settings.apiConfigs.some(c => c.apiKey || c.apiUrl)) {
            const config = { id: 'default', name: tr('默认配置', 'Default'), enabled: true, allowFallback: false };
            for (const key of legacyKeys) if (this.settings[key] !== undefined) config[key] = this.settings[key];
            this.settings.apiConfigs = [config];
            this.settings.activeConfigId = config.id;
        }
        for (const key of legacyKeys) delete this.settings[key];
        return true;
    }

    normalizeSettings() {
        if (!Array.isArray(this.settings.apiConfigs)) {
            this.settings.apiConfigs = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.apiConfigs));
        }
        this.settings.apiConfigs.forEach((config, index) => {
            if (!config.id) config.id = `config_${index}_${Date.now()}`;
            // 1.9 起每条配置只存一个 kit slot：{ provider, model, secretName?, baseUrl? }
            if (!config.ai || typeof config.ai !== 'object') {
                config.ai = slotFromLegacyConfig(config);
                // 旧版自动起的名字（“Deepseek”“Gemini”）不算本人起的：清掉，界面跟着服务商名显示
                const lower = String(config.name || '').trim().toLowerCase();
                const provider = getProvider(config.ai.provider);
                if (lower && provider && [provider.id, provider.name.toLowerCase(), provider.name.replace(/^Google\s+/i, '').toLowerCase()].includes(lower)) config.name = '';
            }
            for (const key of ['apiProvider', 'apiUrl', 'modelName', 'apiKeySecret']) delete config[key];
            if (typeof config.ai.model !== 'string') config.ai.model = '';
            if (config.name === undefined) config.name = '';
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
        return activeConfig?.auxiliaryModelName || activeConfig?.ai?.model || null;
    }

    // 配置在界面上的名字：本人起过名就用，没起就用服务商名
    configLabel(config) {
        return String(config?.name || '').trim() || providerLabel(config);
    }

    // 只读钥匙串里的名字，不联网。新装时用第一个已经存了密钥的服务商
    firstRunSlot() {
        const storage = this.app?.secretStorage;
        for (const id of FIRST_RUN_ORDER) {
            const provider = getProvider(id);
            try {
                if (provider?.secretName && storage?.getSecret(provider.secretName)?.trim()) return { provider: id, model: defaultModelOf(id) };
            } catch { /* 钥匙串读不了就当没有 */ }
        }
        return { provider: 'deepseek', model: defaultModelOf('deepseek') };
    }

    // 请求时才建客户端：深度思考这类 kit 不认识的参数，在发出前补进请求体
    aiClient(bodyPatch = null) {
        const transport = requestUrlTransport(requestUrl);
        const patched = bodyPatch ? async (req) => {
            if (req.body && /\/chat\/completions$/.test(req.url)) {
                try { req = { ...req, body: JSON.stringify({ ...JSON.parse(req.body), ...bodyPatch }) }; } catch { /* 不是 JSON 就原样发 */ }
            }
            return transport(req);
        } : transport;
        if (!this.aiCache) this.aiCache = new ModelCache(this.settings?.modelCache);
        return new AiClient({
            keys: this.app?.secretStorage,
            transport: patched,
            cache: this.aiCache,
            cli: Platform.isDesktopApp ? nodeCliRunner() : undefined,
            lang: aiLang(),
        });
    }

    // Try the configuration that last answered first, so one dead provider does not
    // add a failed request to every call; the user's order is kept for the rest.
    // 主服务是排在最前面的可用配置；备用只取本人勾了“允许用作备用”的配置，不勾就不会改发给别家
    fallbackChain(configs = this.settings.apiConfigs || []) {
        const usable = configs.filter(c => c.enabled !== false && this.isConfigUsable(c));
        if (!usable.length) return [];
        const [primary, ...rest] = usable;
        return this.orderConfigsForFallback([primary, ...rest.filter(c => c.allowFallback === true)]);
    }

    // 1.6 以前，主服务失败会自动改发给其他配置；之后要本人允许。旧数据里谁都没选过，第一次加载时问一次
    needsBackupReview() {
        const configs = this.settings.apiConfigs || [];
        const usable = configs.filter(c => c.enabled !== false && this.isConfigUsable(c));
        return !this.settings.backupReviewed && usable.length > 1 && configs.every(c => c.allowFallback === undefined);
    }

    async applyBackupChoice(keepOldBehaviour) {
        for (const config of this.settings.apiConfigs || []) config.allowFallback = keepOldBehaviour;
        this.settings.backupReviewed = true;
        await this.saveSettings();
    }

    askAboutBackups() {
        const usable = (this.settings.apiConfigs || []).filter(c => c.enabled !== false && this.isConfigUsable(c));
        const [primary, ...others] = usable;
        const modal = new GlassModal(this.app);
        modal.contentEl.createEl('h2', { text: tr('出错时要改发给别家吗？', 'Send to another service when one fails?') });
        const label = c => this.configLabel(c);
        modal.contentEl.createEl('p', { text: tr(
            `以前「${label(primary)}」失败时，会自动改发给 ${others.map(c => `「${label(c)}」`).join('、')}。现在要你允许才会改发。`,
            `Before, when "${label(primary)}" failed, notes were sent to ${others.map(c => `"${label(c)}"`).join(', ')} instead. Now that needs your permission.`) });
        const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
        const choose = async keep => { await this.applyBackupChoice(keep); modal.close(); };
        buttons.createEl('button', { text: tr('照旧改发', 'Keep sending to them') }).addEventListener('click', () => void choose(true));
        buttons.createEl('button', { cls: 'mod-cta', text: tr(`只用「${label(primary)}」`, `Only use "${label(primary)}"`) }).addEventListener('click', () => void choose(false));
        modal.open();
    }

    orderConfigsForFallback(candidates) {
        const index = candidates.findIndex(c => c.id === this.lastWorkingConfigId);
        if (index <= 0) return candidates;
        return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
    }

    // 密钥存在 Obsidian 的钥匙串里（本机，不随库同步）；配置里只记名字，发请求时才读
    hasStoredApiKey(config) {
        const provider = providerOf(config);
        if (!provider.needsKey || provider.localAgent) return true;
        try {
            return !!this.app?.secretStorage?.getSecret(provider.secretName)?.trim();
        } catch {
            return false;
        }
    }

    // 本地模型不需要密钥；“其他（OpenAI 兼容）”还要有地址
    isConfigUsable(config) {
        const provider = providerOf(config);
        if (provider.id === 'custom' && !provider.baseUrl) return false;
        return this.hasStoredApiKey(config);
    }

    // 1.7 以前密钥存在插件数据里（固定口令加密，等于明文）。启动时解开，用 kit 的 migrateKey 存进钥匙串
    // （不覆盖别的插件存在共用名下的不同密钥），存完从数据里删掉；读不出的旧值原样留着，不丢。
    // 另外：自己的名字下没有密钥、共用名下有时，改用共用名（别的插件已经存过）
    async moveKeysToSecretStorage() {
        const storage = this.app?.secretStorage;
        if (!storage) return false;
        let moved = false;
        for (const config of this.settings.apiConfigs || []) {
            if (!config.ai) continue;
            if ('apiKey' in config) {
                let key = '';
                if (config.apiKey && config.apiKey !== REDACTED_API_KEY) {
                    try {
                        key = (await readLegacyKey(config.apiKey)).trim();
                    } catch (error) {
                        console.error('AI Assistant Suite: could not read a saved key; it is left in the settings.', error);
                        continue;
                    }
                }
                if (key && !config.ai.secretName) {
                    const name = migrateKey(storage, sharedSecretNameFor(config), key, PLUGIN_SECRET_PREFIX);
                    if (name !== getProvider(config.ai.provider)?.secretName) config.ai.secretName = name;
                }
                delete config.apiKey;
                moved = true;
            }
            const own = config.ai.secretName;
            const shared = getProvider(config.ai.provider)?.secretName;
            if (own && shared && own !== shared && !this.readSecret(own) && this.readSecret(shared)) {
                delete config.ai.secretName;
                moved = true;
            }
        }
        return moved;
    }

    readSecret(name) {
        try {
            return this.app?.secretStorage?.getSecret(name)?.trim() || '';
        } catch {
            return '';
        }
    }

    redactSettingsForExport(settings) {
        const clone = JSON.parse(JSON.stringify(settings || {}));
        for (const config of clone.apiConfigs || []) delete config.apiKey;
        delete clone.apiKey;
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
                // 导入的设置没有密钥：同一条配置在本机已经选过的钥匙串名照旧用
                if (config.ai && !config.ai.secretName && existing?.ai?.secretName && existing.ai.provider === config.ai.provider) {
                    return { ...config, ai: { ...config.ai, secretName: existing.ai.secretName } };
                }
                if (!config.ai && !config.apiKeySecret && existing?.ai?.secretName) {
                    return { ...config, apiKeySecret: existing.ai.secretName };
                }
                return config;
            });
        }
        return merged;
    }

    beginAiOperation(label = tr('AI 请求', 'AI request')) {
        if (this.currentAbortController && !this.currentAbortController.signal.aborted) {
            this.cancelCurrentRequest(tr('新的 AI 操作已开始', 'A new AI task started'));
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

    cancelCurrentRequest(reason = tr('用户取消', 'Cancelled by user')) {
        if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
            new Notice(tr('当前没有正在运行的 AI 请求。', 'No AI request is running.'), 2000);
            return;
        }
        this.currentAbortController.abort(reason);
        new Notice(tr('AI 请求已取消。', 'AI request cancelled.'), 2500);
        this.view?.render();
    }

    isCancellationError(error) {
        return error?.name === 'AbortError' ||
            error?.code === 'ABORTED' ||
            error?.message?.includes('aborted') ||
            error?.message?.includes('取消');
    }

    createAbortError(message = tr('AI 请求已取消', 'AI request cancelled')) {
        const error = new Error(message);
        error.name = 'AbortError';
        error.code = 'ABORTED';
        return error;
    }

    normalizeActionName(action) {
        if (!action) return '其他';
        if (action.includes('标签') || /\btags?\b/i.test(action)) return '标签';
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
            '一键智能处理': '一键处理',
            // 英文界面下记下的动作名，归到同一个键
            'Tidy structure': '结构',
            'Rename + properties': '元数据',
            'Update properties': '元数据',
            'Move file': '移动',
            'Move note': '移动',
            'Furigana': '假名'
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
        this.app.workspace.onLayoutReady(() => { if (this.needsBackupReview()) this.askAboutBackups(); });

        this.registerView(
            ASSISTANT_VIEW_TYPE,
            (leaf) => new AssistantView(leaf, this)
        );

        this.registerView('ai-assistant-note-preview', leaf => new AssistantNotePreview(leaf,this));
        this.registerView(ASSISTANT_WORKBENCH_TYPE, leaf => new AssistantView(leaf, this, true));

        this.addRibbonIcon("anchor", tr("打开 AI 助手面板", 'Open AI assistant panel'), () => {
            this.activateView();
        });

        this.addRibbonIcon('zap', tr('AI 智能处理', 'AI processing'), () => {
            this.runOneClickSmartProcess();
        });

        this.addCommand({
            id: 'merge-two-notes',
            name: tr('把当前笔记和另一篇生成合并草稿', 'Merge the current note with another into a draft'),
            callback: () => this.startMergeDraft()
        });

        this.addCommand({
            id: 'undo-last-merge-draft',
            name: tr('撤销上次生成的合并草稿', 'Undo the last merge draft'),
            callback: () => void this.undoMergeDraft()
        });

        // 文件列表右键：一篇时再挑一篇，选中两篇时直接用这两篇
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (file?.extension !== 'md') return;
            menu.addItem(item => item.setTitle(tr('与另一篇生成合并草稿…', 'Merge with another note…')).setIcon('git-merge').onClick(() => this.startMergeDraft(file)));
        }));
        this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => {
            const notes = (files || []).filter(f => f?.extension === 'md');
            if (notes.length !== 2 || files.length !== 2) return;
            menu.addItem(item => item.setTitle(tr('生成合并草稿', 'Merge into a draft')).setIcon('git-merge').onClick(() => this.startMergeDraft(notes[0], notes[1])));
        }));

        this.addCommand({
            id: 'load-example',
            name: tr('载入示例（不联网）', 'Load example (no network)'),
            callback: () => this.loadDemo()
        });

        this.addCommand({
            id: 'open-ai-assistant-view',
            name: tr('打开助手面板', 'Open assistant panel'),
            callback: () => {
                this.activateView();
            }
        });

        // --- Command 1: Structurizer ---
        this.addCommand({
            id: 'run-ai-structurizer',
            name: tr('优化当前笔记的结构', 'Restructure the current note'),
            callback: () => {
                this.runAiStructurizer();
            }
        });

        // --- Command 2: Mover ---
        this.addCommand({
            id: 'run-ai-mover',
            name: tr('为当前笔记建议文件夹', 'Suggest a folder for the current note'),
            callback: () => {
                this.runAiMover();
            }
        });

        // --- Command 3: Tagger ---
        this.addCommand({
            id: 'run-ai-tagger',
            name: tr('为当前笔记建议标签', 'Suggest tags for the current note'),
            callback: () => {
                this.runAiTagger();
            }
        });

        // --- Command 4: Meta ---
        this.addCommand({
            id: 'run-ai-meta',
            name: tr('为当前笔记生成属性', 'Generate properties for the current note'),
            callback: () => {
                this.runAiMeta();
            }
        });

        // --- Command 5: Furigana ---
        this.addCommand({
            id: 'run-ai-furigana',
            name: tr('给日文加假名', 'Add furigana to Japanese text'),
            callback: () => {
                this.runAiFurigana();
            }
        });

        this.addCommand({
            id: 'run-ai-one-click-process',
            name: tr('一键处理当前笔记', 'Process the current note in one step'),
            callback: () => {
                this.runOneClickSmartProcess();
            }
        });

        this.addCommand({
            id: 'cancel-current-ai-request',
            name: tr('取消当前 AI 请求', 'Cancel the current AI request'),
            callback: () => {
                this.cancelCurrentRequest(tr('用户取消', 'Cancelled by user'));
            }
        });

        this.addCommand({
            id: 'rollback-last-ai-change',
            name: tr('撤销上次应用的修改', 'Undo the last applied change'),
            callback: () => {
                this.rollbackLastChange();
            }
        });

        this.addCommand({
            id: 'redo-last-ai-rollback',
            name: tr('重做上次撤销', 'Redo the last undo'),
            callback: () => {
                this.redoLastRollback();
            }
        });

        // 添加批量处理命令
        this.addCommand({
            id: 'run-ai-batch-process',
            name: tr('批量处理笔记', 'Process several notes'),
            callback: () => {
                this.runBatchProcess();
            }
        });

        // 添加快速切换侧边栏的命令
        this.addCommand({
            id: 'toggle-ai-assistant-view',
            name: tr('打开或关闭助手面板', 'Toggle assistant panel'),
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
            name: tr('快速总结当前笔记', 'Summarize the current note'),
            callback: () => {
                this.runSmartAction('summarize');
            }
        });

        this.addCommand({
            id: 'ai-smart-optimize',
            name: tr('快速优化当前笔记', 'Polish the current note'),
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
            this.currentAbortController.abort(tr('插件卸载', 'Plugin unloaded'));
        }
        this.debounceTimers.clear();
    }



    // 验证文件名是否有效
    validateFileName(fileName) {
        // 检查文件名是否包含非法字符
        const invalidChars = new RegExp(`[<>:"/\\\\|?*${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`);
        if (invalidChars.test(fileName)) {
            throw new Error(tr('文件名包含非法字符', 'File name contains invalid characters'));
        }

        // 检查文件名长度
        if (fileName.length > 255) {
            throw new Error(tr('文件名过长', 'File name is too long'));
        }

        // 检查是否为空或只包含空格
        if (!fileName.trim()) {
            throw new Error(tr('文件名不能为空', 'File name cannot be empty'));
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
                throw new Error(tr(`目标文件 "${newPath}" 已存在`, `Target file "${newPath}" already exists`));
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
                await new Promise(resolve => window.setTimeout(resolve, 50));
                newFile = this.app.vault.getAbstractFileByPath(newPath);
                retries++;
            }

            if (!newFile) {
                throw new Error(tr(`重命名后无法找到文件: ${newPath}。请检查文件路径是否有效。`, `Could not find the file after renaming: ${newPath}. Check that the path is valid.`));
            }

            return newFile;
        } catch (error) {
            console.error(tr('重命名文件时出错:', 'Error renaming file:'), error);
            throw error;
        }
    }

    // 测试连接：只发一句很短的话，按回答把失败分成几类，每类给一个下一步（不读笔记，不把密钥写进结果）
    // 一次失败给用户看的话：发生了什么 + 一个下一步。分不出类的照原话
    failureProblem(error) {
        const kind = classifyApiError(error);
        if (!API_PROBLEM_KINDS.includes(kind) || kind === 'other' || kind === 'aborted') return null;
        const config = (this.settings.apiConfigs || []).find(c => c.id === error?.configId) || this.getActiveApiConfig();
        return { ...describeApiProblem(kind, config, error), settings: SETTINGS_KINDS.includes(kind) };
    }

    failureText(error) {
        const problem = this.failureProblem(error);
        return problem ? `${problem.message} ${problem.next}` : String(error?.message || error);
    }

    errorContent(file, error) {
        return { type: 'error', file, message: error?.message || String(error), kind: classifyApiError(error), status: error?.status || null, detail: error?.detail || '', configId: error?.configId || null };
    }

    openSettings() {
        this.app.setting.open();
        this.app.setting.openTabById(this.manifest.id);
    }

    // ---- 合并草稿：两篇 → 一篇新笔记。原笔记不写；AI 只给分组，正文由程序从原文逐字拼 ----

    startMergeDraft(first = null, second = null) {
        const a = first?.extension === 'md' ? first : null;
        if (a && second?.extension === 'md') { new MergeDraftModal(this, a, second).open(); return; }
        const pick = (exclude, title, done) => new MergeNotePicker(this.app, exclude, title, done).open();
        if (a) pick(a, tr(`和「${a.basename}」合并的另一篇`, `The note to merge with "${a.basename}"`), b => new MergeDraftModal(this, a, b).open());
        else pick(null, tr('选第一篇笔记', 'Choose the first note'), x => pick(x, tr(`和「${x.basename}」合并的另一篇`, `The note to merge with "${x.basename}"`), y => new MergeDraftModal(this, x, y).open()));
    }

    // 草稿放在第一篇所在的文件夹；重名时加序号，不覆盖任何文件
    mergeDraftPath(a, b) {
        const clean = text => String(text).replace(/[\\/:*?"<>|#^[\]]/g, '-').trim();
        const folder = a.parent?.path && a.parent.path !== '/' ? a.parent.path : '';
        const base = clean(`${tr('合并草稿', 'Merge draft')} - ${a.basename} + ${b.basename}`).slice(0, 120);
        for (let n = 1; n < 100; n++) {
            const path = `${folder ? folder + '/' : ''}${base}${n > 1 ? ` ${n}` : ''}.md`;
            if (!this.app.vault.getAbstractFileByPath(path)) return path;
        }
        throw new Error(tr('同名草稿太多，请先整理一下。', 'Too many drafts with this name; tidy them first.'));
    }

    mergeDraftScope(a, b) {
        const config = this.fallbackChain()[0] || this.getActiveApiConfig();
        const provider = config ? providerOf(config) : null;
        return { config, label: config ? `${this.configLabel(config)} · ${slotOf(config).model || defaultModelOf(provider.id)}` : '', local: !!provider && provider.group === 'local' && !provider.localAgent };
    }

    // 不能合并的原因，点名是哪一篇；能合并时返回 null。只读两篇，不联网
    async mergeBlocker(a, b) {
        if (a.path === b.path) return { text: tr('两次选的是同一篇。', 'Both choices are the same note.'), side: 'B' };
        const [textA, textB] = await Promise.all([this.app.vault.read(a), this.app.vault.read(b)]);
        // 每篇单独查（另一边放一个字的占位），才知道是哪一篇的问题
        for (const [side, file, text] of [['A', a, textA], ['B', b, textB]]) {
            const why = mergeDraft.blocker(text, 'x');
            if (why === 'footnotes' || why === 'empty') return { text: MERGE_BLOCKERS[why](file.basename), side };
        }
        if (mergeDraft.blocker(textA, textB) === 'too-long') return { text: MERGE_BLOCKERS['too-long'](), side: null };
        return null;
    }

    // 读两篇、请 AI 分组、拼草稿。不写任何文件
    async generateMergeDraft(a, b, signal) {
        if (a.path === b.path) throw Object.assign(new Error(tr('两次选的是同一篇。', 'Both choices are the same note.')), { kind: 'merge' });
        const [textA, textB] = await Promise.all([this.app.vault.read(a), this.app.vault.read(b)]);
        const blocked = await this.mergeBlocker(a, b);
        if (blocked) throw Object.assign(new Error(blocked.text), { kind: 'merge', side: blocked.side });
        const A = mergeDraft.splitFrontmatter(textA), B = mergeDraft.splitFrontmatter(textB);
        const blocks = mergeDraft.prepareBlocks(A.body, B.body);
        const path = this.mergeDraftPath(a, b);
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const cache = this.app.metadataCache;
        const rewrite = (list, source) => list.map(block => ({ ...block, text: mergeDraft.rewriteLinks(block.text, {
            selfLink: cache.fileToLinktext(source, path, true),
            selfHref: mergeDraft.relativePath(folder, source.path),
            resolve: linkpath => cache.getFirstLinkpathDest(linkpath, source.path),
            linkFor: file => cache.fileToLinktext(file, path, true),
            relative: file => mergeDraft.relativePath(folder, file.path),
        }) }));
        const unpaired = blocks.a.length + blocks.b.length - blocks.identical.length * 2;
        let groups = [];
        if (unpaired > 0 && blocks.a.length > blocks.identical.length && blocks.b.length > blocks.identical.length) {
            const prompt = mergeDraft.buildPrompt({ nameA: a.basename, nameB: b.basename, ...blocks, english: !isChineseInterface() });
            const reply = await this.makeApiRequest(prompt, null, true, null, { signal, label: tr('合并草稿', 'Merge draft'), timeout: 180000 });
            groups = mergeDraft.parseGroups(reply, blocks);
        }
        const linkTo = file => `[[${cache.fileToLinktext(file, path, true)}]]`;
        const draft = mergeDraft.assembleDraft({
            a: rewrite(blocks.a, a), b: rewrite(blocks.b, b), identical: blocks.identical, groups,
            yamlA: A.yaml, yamlB: B.yaml, link: side => linkTo(side === 'A' ? a : b), labels: mergeLabels(), date: new Date().toISOString().slice(0, 10),
        });
        return { ...draft, path, a, b, sourceMarks: [mergeDraft.fingerprint(textA), mergeDraft.fingerprint(textB)] };
    }

    // 建草稿前再核一次：预览之后两篇都没改，目标位置还空着
    async createMergeDraft(result) {
        const [textA, textB] = await Promise.all([this.app.vault.read(result.a), this.app.vault.read(result.b)]);
        if (mergeDraft.fingerprint(textA) !== result.sourceMarks[0] || mergeDraft.fingerprint(textB) !== result.sourceMarks[1]) {
            throw new Error(tr('预览之后笔记又改过了，请重新生成。', 'A note changed after the preview. Generate it again.'));
        }
        if (this.app.vault.getAbstractFileByPath(result.path)) throw new Error(tr('目标位置已经有同名笔记，请重新生成。', 'A note with that name now exists. Generate it again.'));
        const file = await this.app.vault.create(result.path, result.text);
        const record = { id: `merge-${Date.now()}`, path: file.path, hash: mergeDraft.fingerprint(result.text), sources: [result.a.path, result.b.path], at: Date.now() };
        this.settings.mergeDrafts = [record, ...(this.settings.mergeDrafts || [])].slice(0, 10);
        await this.saveSettings();
        await this.app.workspace.getLeaf('tab').openFile(file);
        const fragment = createFragment(f => {
            f.appendText(tr('合并草稿已生成，两篇原笔记没有改动。', 'Merge draft created; both notes are unchanged.') + ' ');
            const undo = f.createEl('a', { text: tr('撤销', 'Undo'), href: '#' });
            undo.addEventListener('click', event => { event.preventDefault(); void this.undoMergeDraft(record.id); });
        });
        new Notice(fragment, 10000);
        return file;
    }

    // 撤销只删没被动过的草稿：改过、或已经有别的笔记链接到它，就留着并说明
    async undoMergeDraft(id = null) {
        const list = this.settings.mergeDrafts || [];
        const record = id ? list.find(r => r.id === id) : list[0];
        if (!record) { new Notice(tr('没有可以撤销的合并草稿。', 'No merge draft to undo.')); return false; }
        const forget = async () => { this.settings.mergeDrafts = list.filter(r => r.id !== record.id); await this.saveSettings(); };
        const file = this.app.vault.getAbstractFileByPath(record.path);
        if (!file || file.children) { await forget(); new Notice(tr('这篇草稿已经不在了。', 'That draft is already gone.')); return false; }
        const text = await this.app.vault.read(file);
        if (mergeDraft.fingerprint(text) !== record.hash) {
            new Notice(tr('草稿生成后改过，没有撤销。不需要的话可以自己删掉。', 'The draft was edited after it was made, so it was kept. Delete it yourself if you no longer need it.'), 8000);
            return false;
        }
        const linked = Object.entries(this.app.metadataCache.resolvedLinks || {}).some(([source, targets]) => source !== record.path && targets?.[record.path]);
        if (linked) {
            new Notice(tr('已经有别的笔记链接到这篇草稿，没有撤销。', 'Another note links to this draft, so it was kept.'), 8000);
            return false;
        }
        await this.app.fileManager.trashFile(file);
        await forget();
        new Notice(tr('已撤销：草稿移进了回收站，两篇原笔记一直没动。', 'Undone: the draft went to the trash; both notes were never changed.'));
        return true;
    }

    async validateApiConfig(configToTest = null) {
        const config = configToTest || this.getActiveApiConfig();
        if (!config) return { valid: false, ...describeApiProblem('no-config'), checks: connectionChecks('no-config', null, false) };
        const provider = providerOf(config);
        if (provider.id === 'custom' && !provider.baseUrl) return { valid: false, ...describeApiProblem('no-url', config), checks: connectionChecks('no-url', null, false) };
        if (!this.hasStoredApiKey(config)) return { valid: false, ...describeApiProblem('no-key', config), checks: connectionChecks('no-key', null, false) };
        if (!slotOf(config).model && !defaultModelOf(provider.id)) {
            return { valid: false, ...describeApiProblem('no-model', config), checks: connectionChecks('no-model', null, false) };
        }
        try {
            await this._callSingleConfig('Reply with OK.', null, false, config, { probe: true, timeout: 20000 });
            this.lastApiProblem = null;
            return { valid: true, kind: 'ok', checks: connectionChecks('ok') };
        } catch (error) {
            const kind = classifyApiError(error);
            this.lastApiProblem = { kind, status: error?.status || null, at: Date.now(), provider: slotOf(config).provider };
            return { valid: false, ...describeApiProblem(kind, config, error), checks: connectionChecks(kind, error?.status) };
        }
    }

    hasUsableConfig() {
        return (this.settings.apiConfigs || []).some(c => c.enabled !== false && this.isConfigUsable(c));
    }

    demoNotePath() {
        return tr('AI Assistant Suite 示例.md', 'AI Assistant Suite example.md');
    }

    // 载入示例：在库根目录放一篇标明是演示的笔记，配上预先写好的建议。不联网、不花钱；可以照常应用和撤销
    // 只有 frontmatter 里标了 ai-assistant-demo: true 的才算示例笔记；同名的用户笔记不碰
    async isDemoNote(file) {
        if (!file || file.children) return false;
        const fm = (await this.app.vault.cachedRead(file)).match(/^---\r?\n([\s\S]*?)\r?\n---/);
        return !!fm && /^ai-assistant-demo:\s*true\s*$/m.test(fm[1]);
    }

    async loadDemo() {
        const zh = isChineseInterface();
        const body = zh
            ? '---\nai-assistant-demo: true\n---\n> 这是 AI Assistant Suite 的示例笔记，可以随时删除。\n\n周三和小林聊了月底搬家的事 新房子三月一号能入住 要先给房东发邮件约退房检查 再订搬家公司\n\n要做的：纸箱先要二十个 邮件里写清楚退房日期 网络和电费月底前办好转移\n\n顺便记一下 他推荐了两家搬家公司 一家便宜 一家周末也能搬\n'
            : '---\nai-assistant-demo: true\n---\n> This is the AI Assistant Suite example note. Delete it any time.\n\nwed talked w/ Sam about the move. new place is ready march 1, need to email the landlord first to book the move-out check, then book movers\n\ntodo: get 20 boxes, say the move-out date in the email, move internet and power before the end of the month\n\nalso he recommended two moving companies one cheap one that works weekends\n';
        const structured = zh
            ? '---\nai-assistant-demo: true\n---\n> 这是 AI Assistant Suite 的示例笔记，可以随时删除。\n\n## 月底搬家（周三与小林）\n\n- 新房子**三月一日**起能入住。\n- 流程：先给房东发邮件约退房检查，再订搬家公司。\n\n## 待办\n\n- [ ] 准备二十个纸箱\n- [ ] 邮件里写清楚退房日期\n- [ ] 月底前办好网络和电费转移\n\n## 推荐的搬家公司\n\n- 一家便宜\n- 一家周末也能搬\n'
            : '---\nai-assistant-demo: true\n---\n> This is the AI Assistant Suite example note. Delete it any time.\n\n## Moving out (Wednesday, with Sam)\n\n- The new place is ready on **1 March**.\n- Steps: email the landlord to book the move-out check, then book movers.\n\n## To do\n\n- [ ] Get twenty boxes\n- [ ] Say the move-out date in the email\n- [ ] Move internet and power before the month ends\n\n## Recommended movers\n\n- One that is cheap\n- One that works weekends\n';
        let path = this.demoNotePath();
        let file = null;
        for (let n = 2; ; n++) {
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (!existing) break;
            if (await this.isDemoNote(existing)) { file = existing; break; }
            path = this.demoNotePath().replace(/\.md$/, ` ${n}.md`);
        }
        if (!file) file = await this.app.vault.create(path, body);
        else await this.app.vault.process(file, () => body);
        await this.app.workspace.getLeaf(false).openFile(file);
        await this.activateView();
        const folder = this.app.vault.getRoot().children.find(child => child.children && !child.name.startsWith('.'));
        const stamp = Date.now();
        await this.createDiffPreviewTask({ taskId: `demo-diff-${stamp}`, file, action: tr('整理正文（演示）', 'Tidy text (demo)'), title: tr('整理正文（演示）', 'Tidy text (demo)'), originalContent: body, proposedContent: structured });
        this.view.getTask(`demo-diff-${stamp}`).content.demo = true;
        this.view.addTask({
            id: `demo-${stamp}`, type: 'one-click', status: 'displaying', title: tr('示例建议', 'Example suggestions'),
            content: {
                demo: true, file, originalContent: body,
                suggestions: {
                    meta: zh ? { title: '月底搬家计划', summary: '新房子三月一日能入住：先给房东发邮件约退房检查，再订搬家公司。待办包括准备纸箱、写清退房日期、转移网络和电费。', tldr: '三月前约好退房检查和搬家公司，备好纸箱。' }
                        : { title: 'Moving plan for the end of the month', summary: 'The new place is ready on 1 March: email the landlord to book the move-out check, then book movers. To do: boxes, the move-out date, internet and power.', tldr: 'Book the move-out check and movers before March; get boxes.' },
                    tags: (zh ? ['示例/搬家', '示例/待办'] : ['example/moving', 'example/todo']).map(tag => ({ display: tag, final: tag, is_new: true })),
                    mover: folder ? [{ path: folder.path, is_new: false }] : null,
                },
            },
        });
        this.view.workbenchPage = 'review';
        this.view.render();
        new Notice(tr('已载入示例。这是演示，没有联网。', 'Example loaded. This is a demo; nothing was sent.'));
    }

    async removeDemo() {
        const stem = this.demoNotePath().replace(/\.md$/, '');
        const named = this.app.vault.getRoot().children.filter(f => !f.children && f.extension === 'md' && f.basename.startsWith(stem));
        let file = null;
        for (const f of named) if (await this.isDemoNote(f)) { file = f; break; }
        if (!file) file = this.app.vault.getMarkdownFiles().find(f => this.app.metadataCache.getFileCache(f)?.frontmatter?.['ai-assistant-demo'] === true) || null;
        if (this.view) {
            this.view.tasks = this.view.tasks.filter(t => !t.content?.demo);
            this.view.workbenchPage = 'prepare';
            this.view.render();
        }
        if (!file) return;
        await this.app.fileManager.trashFile(file);
        new Notice(tr('示例笔记已移到回收站。', 'Example note moved to trash.'));
    }

    // 模型偶尔会把重复或冗长的段落“整理”掉；正文明显变短时提醒本人先逐段看，再决定要不要应用
    shrinkWarning(task) {
        const before = String(task?.content?.originalContent || '').trim().length;
        const after = String(task?.content?.proposedContent || '').trim().length;
        if (before < 200 || after >= before * 0.6) return '';
        const lost = Math.round((1 - after / before) * 100);
        return tr(`建议的正文比原文短了 ${lost}%，可能删掉了内容。应用前请点“对比”逐段看一遍。`, `The suggested text is ${lost}% shorter than the original and may drop content. Open Compare and read it through before applying.`);
    }

    // 诊断信息：给排错用，只有版本、服务商、地址的域名、模型和最近一次失败的类别；不含密钥、完整地址和笔记内容
    buildDiagnostics() {
        const lines = [
            `AI Assistant Suite ${this.manifest?.version || ''}`,
            `Obsidian ${typeof apiVersion === 'string' ? apiVersion : ''}`,
            `Platform: ${Platform.isMobile ? 'mobile' : 'desktop'}${Platform.isMacOS ? ', macOS' : Platform.isWin ? ', Windows' : Platform.isLinux ? ', Linux' : Platform.isIosApp ? ', iOS' : Platform.isAndroidApp ? ', Android' : ''}`,
            `Language: ${isChineseInterface() ? 'zh' : 'en'}`,
            `Configurations: ${(this.settings.apiConfigs || []).length}, backups allowed: ${(this.settings.apiConfigs || []).filter(c => c.allowFallback === true).length}`,
        ];
        (this.settings.apiConfigs || []).forEach((config, index) => {
            const provider = providerOf(config);
            lines.push(`#${index + 1} provider=${provider.id} host=${hostOf(provider.baseUrl) || '-'}${slotOf(config).baseUrl ? ' (custom address)' : ''} model=${slotOf(config).model || '-'} helper=${config.auxiliaryModelName || '-'} key=${this.hasStoredApiKey(config) ? 'set' : 'none'} enabled=${config.enabled !== false}`);
        });
        const last = this.lastApiProblem;
        lines.push(last ? `Last test: ${last.kind}${last.status ? ` (HTTP ${last.status})` : ''} at ${new Date(last.at).toISOString()}` : 'Last test: none');
        return lines.join('\n');
    }

    getRecentHistory() {
        const history = this.settings.processingHistory;
        if (!history) return [];
        this.initializeUsageStatsFromHistory?.(history);
        return history;
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

    // 批量处理前的发送说明：几篇、多大、按什么顺序发给哪些服务（本地模型不出电脑）
    describeBatchSend(files) {
        const notes = (files || []).length;
        const bytes = (files || []).reduce((sum, file) => sum + (file?.stat?.size || 0), 0);
        const configs = this.fallbackChain();
        const destinations = configs.map(config => ({
            name: this.configLabel(config),
            // 本机的 Claude Code、Codex 也在“本机”分组，但它们会把内容发给各自的云服务
            local: providerOf(config).group === 'local' && !providerOf(config).localAgent
        }));
        const size = bytes >= 1024 * 1024
            ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
            : `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return { notes, bytes, size, destinations };
    }

    renderBatchSendSummary(container, files) {
        const { notes, size, destinations } = this.describeBatchSend(files);
        const box = container.createDiv({ cls: 'ai-assistant-batch-estimate' });
        box.createEl('strong', { text: tr(`将发送 ${notes} 篇笔记，约 ${size}。`, `Will send ${notes} notes, about ${size}.`) });
        if (destinations.length === 0) {
            box.createEl('p', { text: tr('还没有可用的 AI 配置，请先在设置里添加。', 'No usable AI configuration yet. Add one in settings first.') });
            return box;
        }
        for (const line of this.batchSendLines(destinations)) box.createEl('p', { text: line });
        return box;
    }

    // 批量说明按实际去向写：只有全部去向都是本地模型时，才说笔记不离开这台电脑
    batchSendLines(destinations) {
        const [first, ...backups] = destinations;
        if (!first) return [];
        const cloud = destinations.filter(d => !d.local);
        const lines = [first.local
            ? (cloud.length ? tr(`先发给「${first.name}」（本地模型）。`, `Sends to "${first.name}" first (local model).`) : tr(`先发给「${first.name}」（本地模型，不离开这台电脑）。`, `Sends to "${first.name}" first (local model; nothing leaves this computer).`))
            : tr(`先发给「${first.name}」。`, `Sends to "${first.name}" first.`)];
        if (!backups.length) {
            lines.push(tr('它失败时会停下来，不改发给其他服务。', 'If it fails, processing stops and nothing goes to another service.'));
        } else {
            lines.push(tr(`它失败时依次改用：${backups.map(d => d.local ? `${d.name}（本地）` : d.name).join('、')}。`, `If it fails, these are tried in order: ${backups.map(d => d.local ? `${d.name} (local)` : d.name).join(', ')}.`));
            if (first.local && cloud.length) lines.push(tr(`主服务失败时，笔记可能发给 ${cloud.map(d => `「${d.name}」`).join('、')}，不再只留在这台电脑。`, `If the main service fails, notes may go to ${cloud.map(d => `"${d.name}"`).join(', ')} and no longer stay on this computer.`));
        }
        return lines;
    }

    // 通用API请求方法（支持多 Config 顺序 Fallback、取消和 OpenAI-compatible streaming）
    async makeApiRequest(prompt, modelNameOverride = null, expectJson = false, configOverride = null, options = {}) {
        let operationController = null;
        const requestOptions = { ...options };
        if (!requestOptions.signal) {
            operationController = this.beginAiOperation(requestOptions.label || tr('AI 请求', 'AI request'));
            requestOptions.signal = operationController.signal;
        }

        try {
            if (configOverride) {
                return await this._callSingleConfig(prompt, modelNameOverride, expectJson, configOverride, requestOptions);
            }

            const candidates = this.fallbackChain();

            if (candidates.length === 0) {
                throw new Error(tr("没有可用的 API 配置，请在设置中至少启用一个配置。", 'No usable API configuration. Enable at least one in settings.'));
            }

            const errors = [];
            let lastError = null, lastConfig = null;
            for (let i = 0; i < candidates.length; i++) {
                if (requestOptions.signal?.aborted) {
                    throw this.createAbortError();
                }
                const config = candidates[i];
                const label = this.configLabel(config);
                try {
                    const result = await this._callSingleConfig(prompt, modelNameOverride, expectJson, config, requestOptions);
                    this.lastWorkingConfigId = config.id;
                    if (i > 0) {
                        new Notice(tr(`已切换到备用配置「${label}」并成功`, `Switched to backup "${label}" and it worked`));
                    }
                    return result;
                } catch (err) {
                    if (requestOptions.signal?.aborted || this.isCancellationError(err)) {
                        throw this.createAbortError();
                    }
                    const msg = tr(`配置「${label}」失败: ${err.message}`, `Configuration "${label}" failed: ${err.message}`);
                    errors.push(msg);
                    lastError = err; lastConfig = config;
                    console.warn(`[AI Assistant] ${msg}`);
                    if (i < candidates.length - 1) {
                        new Notice(tr(`${label} 失败，尝试下一个配置...`, `${label} failed, trying the next configuration…`), 2000);
                    }
                }
            }

            // 分类、状态码和是哪条配置都带上，界面才能给出对应的下一步
            const carry = error => Object.assign(error, { kind: classifyApiError(lastError), status: lastError?.status, detail: lastError?.detail, configId: lastConfig?.id });
            if (candidates.length === 1) {
                throw carry(new Error(tr(`${errors[0]}\n没有勾选“允许用作备用”的配置，所以没有改发给其他服务。`, `${errors[0]}\nNo configuration allows backup use, so nothing was sent to another service.`)));
            }
            throw carry(new Error(tr(`所有 API 配置均失败（共 ${candidates.length} 个）。\n最后错误: ${errors[errors.length - 1]}`, `All ${candidates.length} API configurations failed.\nLast error: ${errors[errors.length - 1]}`)));
        } finally {
            if (operationController) {
                this.finishAiOperation(operationController);
            }
        }
    }

    // 对单个配置发一次请求。地址、请求格式、超时和取消都交给 rex-ai-kit；请求一律走 requestUrl（不受跨域限制、手机可用）
    async _callSingleConfig(prompt, modelNameOverride, expectJson, activeConfig, options = {}) {
        const provider = providerOf(activeConfig);
        const slot = { ...slotOf(activeConfig), model: modelNameOverride || slotOf(activeConfig).model || defaultModelOf(provider.id) };
        if (provider.id === 'custom' && !provider.baseUrl) {
            throw Object.assign(new Error(tr('还没有填写接口地址，请在设置里填写。', 'No server address yet. Add one in settings.')), { kind: 'no-url' });
        }
        if (!this.hasStoredApiKey(activeConfig)) {
            throw Object.assign(new Error(tr(`还没有选 ${provider.name} 的密钥，请在设置里选择。`, `No ${provider.name} key is chosen yet. Choose one in settings.`)), { kind: 'no-key' });
        }
        if (options.signal?.aborted) throw this.createAbortError();
        // DeepSeek 默认会深度思考；没打开时明确关掉，回答更快
        const client = this.aiClient(provider.id === 'deepseek' ? { thinking: { type: activeConfig.deepseekThinking ? 'enabled' : 'disabled' } } : null);
        let result;
        try {
            result = await client.complete(slot, {
                messages: [{ role: 'user', content: prompt }],
                // 本地服务对 JSON 模式的支持不一，靠提示词要求 JSON
                json: !!expectJson && provider.group !== 'local',
                maxTokens: options.probe ? 16 : 8192,
                signal: options.signal,
                timeoutMs: options.timeout || 120000,
            });
        } catch (error) {
            if (options.signal?.aborted || error?.kind === 'aborted' || this.isCancellationError(error)) throw this.createAbortError();
            throw error;
        }
        // 测试连接只看服务商肯不肯答：回答到了就算通，不看内容
        if (options.probe) return 'OK';
        const resultText = result?.text;
        if (!resultText) {
            // 不把回答原样打到控制台：里面可能有笔记内容
            throw Object.assign(new Error(tr('AI 没有返回内容。', 'The AI returned no content.')), { kind: 'empty' });
        }
        options.onStream?.(resultText, resultText);
        return resultText;
    }

    truncatePreview(content, maxChars = 12000) {
        if (!content || content.length <= maxChars) return content || '';
        return content.substring(0, maxChars) + tr(`\n\n... 已截断预览，完整内容会在 Apply 时写入 ...`, `\n\n... Preview truncated; the full text is written on apply ...`);
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
            if (hunk.start < cursor || lines.slice(hunk.start, hunk.end).join('') !== hunk.before) throw new Error(tr('预览已失效，请重新生成。', 'The preview is out of date. Generate it again.'));
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
        if(source?.content.originalContent!==undefined&&source.content.originalContent!==current)throw new Error(tr('笔记已有新修改，请重新生成建议。', 'The note changed since. Generate suggestions again.'));
        if(diff&&diff.content.originalContent!==current)throw new Error(tr('正文预览已过期，请重新生成。', 'The text preview is out of date. Generate it again.'));
        let text=diff?this.composeReviewContent(current,diff.content.reviewHunks||this.buildReviewHunks(current,diff.content.proposedContent),diff.content.reviewSelected|| (diff.content.reviewHunks||this.buildReviewHunks(current,diff.content.proposedContent)).map(h=>h.id)):current;
        const styleChosen=Object.values(draft.style||{}).some(Boolean);
        const useDefaults=draft.useDefaults??(draft.useMeta&&!draft.skipDefaults);
        if(draft.useMeta||draft.useTags||styleChosen||useDefaults){
            const match=text.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
            const fm=match?(parseYaml(match[1])||{}):{};
            if(typeof fm!=='object'||Array.isArray(fm))throw new Error(tr('笔记属性不是有效的 YAML 对象，未写入。', 'The note properties are not a valid YAML object, so nothing was written.'));
            let body=match?text.slice(match[0].length):text;
            const styles=styleChosen?(draft.styleList||this.styleProposals(group.file,{...fm},draft,body)).filter(p=>draft.style[p.key]):[];
            if(draft.useMeta){for(const key of ['title','summary','tldr'])if(draft.meta[key]!==undefined&&String(draft.meta[key]).trim()&&!(draft.skipMeta||[]).includes(key))fm[key]=String(draft.meta[key]).trim();}
            if(useDefaults)this.fillFieldDefaults(fm,draft.originalPath||group.file.path);
            if(draft.useTags){const old=Array.isArray(fm.tags)?fm.tags:(fm.tags?[String(fm.tags)]:[]);fm.tags=[...new Set([...old,...draft.tags])];}
            const newline=current.includes('\r\n')?'\r\n':'\n';
            if(styles.length)body=this.applyStyleProposals(fm,body,styles).replace(/\r?\n/g,newline);
            text=`---${newline}${stringifyYaml(fm).trimEnd().replace(/\r?\n/g,newline)}${newline}---${newline}${body}`;
        }
        return text;
    }

    applyNoteGroup(group,draft) {
        return this.queueContentWrite(async()=>{
            if(group.tasks.at(-1)?.content.noteApplied)return;
            if(this.assistantSession?.workbenchRunning||(this.assistantSession?.tasks||[]).some(t=>t.type==='batch-process'&&t.content?.canInterrupt))throw new Error(tr('请等待当前生成任务结束后再确认。', 'Wait for the current run to finish before confirming.'));
            const file=group.file,originalPath=file.path,current=await this.app.vault.read(file);
            const proposed=this.composeNoteGroup(group,draft,current);
            let folder=draft.useFolder?draft.folder:(file.parent?.path||'/');
            folder=String(folder).replace(/^\/+|\/+$/g,'');
            if(folder.split('/').some(p=>p==='..'||p==='.')||/[\\:*?"<>|]/.test(folder))throw new Error(tr('目标文件夹路径无效。', 'The folder path is invalid.'));
            let name=file.name||originalPath.split('/').at(-1);
            if(draft.useMeta&&draft.rename&&!(draft.skipMeta||[]).includes('title')){const title=String(draft.meta.title||'').trim().replace(/[/\\:?*"<>|]/g,'-').slice(0,this.settings.metaFileNameMaxLength||100);if(!title||/^\.+$/.test(title))throw new Error(tr('请填写有效的文件名。', 'Enter a valid file name.'));name=title+'.md';}
            const destination=folder?folder+'/'+name:name;
            if(destination!==originalPath&&this.app.vault.getAbstractFileByPath(destination))throw new Error(tr('目标位置已有同名文件，未做修改。', 'A file with the same name exists there; nothing was changed.'));
            if(proposed===current&&destination===originalPath)throw new Error(tr('没有选中需要应用的修改。', 'Nothing selected to apply.'));
            if(folder&&!this.app.vault.getAbstractFileByPath(folder))await this.app.vault.createFolder(folder);
            const snapshot=await this.saveRollbackSnapshot({file,action:tr('笔记集中确认', 'Note review'),originalContent:current,appliedContent:proposed});
            snapshot.originalPath=originalPath;snapshot.filePath=destination;
            await this.saveSettings();
            let wrote=false;
            try{
                await this.guardedWrite(file,current,proposed);wrote=true;
                if(destination!==originalPath)await this.app.fileManager.renameFile(file,destination);
            }catch(error){
                let restored=!wrote;
                if(wrote&&file.path===originalPath){try{await this.guardedWrite(file,proposed,current);restored=true;}catch{/* 笔记已被改动，保留现状 */}}
                if(restored)this.settings.rollbackHistory=this.settings.rollbackHistory.filter(s=>s.id!==snapshot.id);
                else{snapshot.filePath=file.path;for(const task of group.tasks){task.content.noteSnapshotId=snapshot.id;task.content.noteApplied=true;}}
                await this.saveSettings();throw error;
            }
            snapshot.filePath=file.path;
            for(const task of group.tasks){task.content.noteSnapshotId=snapshot.id;task.content.noteApplied=true;}
            await this.saveSettings();
            this.addToHistory(file.basename,file.path,tr('笔记集中确认', 'Note review'),this.generateFileId(file));
            new Notice(tr('本篇建议已应用，可在任务中撤销。', 'Suggestions applied; you can undo them from the task.'));
        });
    }

    undoNoteGroup(group) {
        return this.queueContentWrite(async()=>{
            const id=group.tasks.find(t=>t.content.noteSnapshotId)?.content.noteSnapshotId;
            const snapshot=(this.settings.rollbackHistory||[]).find(s=>s.id===id);
            if(!snapshot)throw new Error(tr('撤销记录已过期或已撤销。', 'The undo record has expired or was already used.'));
            const file=this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if(!file)throw new Error(tr('笔记已移动或删除，请先恢复位置。', 'The note was moved or deleted. Restore its location first.'));
            const target=snapshot.originalPath||snapshot.filePath;
            if(target!==file.path&&this.app.vault.getAbstractFileByPath(target))throw new Error(tr('原位置已有文件，无法撤销归档。', 'A file already exists at the original location, so the move cannot be undone.'));
            if(await this.app.vault.read(file)!==snapshot.appliedContent)throw new Error(tr('笔记有后续编辑，已保留当前内容，无法直接撤销。', 'The note was edited since. The current text is kept and cannot be undone directly.'));
            await this.guardedWrite(file,snapshot.appliedContent,snapshot.originalContent);
            try{if(target!==file.path)await this.app.fileManager.renameFile(file,target);}catch(error){await this.guardedWrite(file,snapshot.originalContent,snapshot.appliedContent);throw error;}
            this.settings.rollbackHistory=this.settings.rollbackHistory.filter(s=>s.id!==id);
            this.settings.rollbackRedoHistory=[];
            for(const task of group.tasks){task.content.noteApplied=false;delete task.content.noteSnapshotId;if(task.content.noteDraft){task.content.noteDraft.applied=[];delete task.content.noteDraft.snapshotId;delete task.content.noteDraft.styleList;}}
            await this.saveSettings();new Notice(tr('已恢复本篇修改前的内容和位置。', 'Restored this note\'s content and location from before.'));
        });
    }

    // 面板里一块一块确认：块名 meta 标题与摘要、defaults 补属性、tags 标签、folder 归档、style 样式、body 正文
    noteSource(group, draft) {
        const source = group.tasks.find(t => t.id === draft.originalTaskId) || group.tasks.find(t => t.type === 'one-click');
        const diff = group.tasks.find(t => t.id === draft.diffId) || group.tasks.find(t => t.type === 'diff-preview');
        return { source, original: source?.content.originalContent ?? diff?.content.originalContent };
    }

    notePartsInfo(group, draft) {
        const { source, original } = this.noteSource(group, draft);
        const suggestions = source?.content.suggestions || {};
        const text = String(original ?? '');
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
        let fm = {};
        try { fm = match ? (parseYaml(match[1]) || {}) : {}; } catch { fm = {}; }
        if (typeof fm !== 'object' || Array.isArray(fm)) fm = {};
        const body = match ? text.slice(match[0].length) : text;
        const originalPath = draft.originalPath || group.file.path;
        const fromFolder = originalPath.includes('/') ? originalPath.slice(0, originalPath.lastIndexOf('/')) : '';
        const parts = {};
        if (suggestions.meta) parts.meta = true;
        if (suggestions.meta && (this.fieldDefaultsApplyTo?.(originalPath) ?? true)) {
            const missing = Object.entries(this.fieldDefaults?.() || {}).filter(([key]) => !['tags', 'title', 'summary', 'tldr'].includes(key) && (fm[key] === undefined || fm[key] === null || fm[key] === ''));
            if (missing.length) parts.defaults = missing;
        }
        if (suggestions.tags?.length) parts.tags = true;
        if (suggestions.mover?.length && String(draft.folder || '').replace(/^\/+|\/+$/g, '') !== fromFolder) parts.folder = true;
        const skipped = draft.skipped || [];
        const styleList = draft.styleList || this.styleProposals?.(group.file, { ...fm }, { ...draft, useMeta: !skipped.includes('meta'), useFolder: !skipped.includes('folder') }, body) || [];
        if (styleList.length) parts.style = styleList;
        if (group.tasks.some(t => t.type === 'diff-preview' && !t.content.applied)) parts.body = true;
        return { parts, original, fm, styleList };
    }

    // 某几块都接受后，笔记应该是什么样、放在哪
    notePartsTarget(group, draft, set, original) {
        const has = key => set.has(key);
        const view = { ...draft, useMeta: has('meta'), useDefaults: has('defaults'), useTags: has('tags') && draft.tags.length > 0, useFolder: has('folder'),
            diffId: has('body') ? draft.diffId : '', style: has('style') ? (draft.style || {}) : {}, rename: has('meta') && !!draft.rename };
        const text = this.composeNoteGroup(group, view, original);
        const originalPath = draft.originalPath || group.file.path;
        let folder = has('folder') ? String(draft.folder || '') : (originalPath.includes('/') ? originalPath.slice(0, originalPath.lastIndexOf('/')) : '');
        folder = folder.replace(/^\/+|\/+$/g, '');
        if (folder.split('/').some(p => p === '..' || p === '.') || /[\\:*?"<>|]/.test(folder)) throw new Error(tr('目标文件夹路径无效。', 'The folder path is invalid.'));
        let name = originalPath.split('/').at(-1);
        if (view.rename && !(draft.skipMeta || []).includes('title')) {
            const title = String(draft.meta.title || '').trim().replace(/[/\\:?*"<>|]/g, '-').slice(0, this.settings.metaFileNameMaxLength || 100);
            if (!title || /^\.+$/.test(title)) throw new Error(tr('请填写有效的文件名。', 'Enter a valid file name.'));
            name = title + '.md';
        }
        return { text, path: folder ? `${folder}/${name}` : name, folder };
    }

    // 把这篇改成“next 这几块已接受”的样子。每次都从生成建议时的原文重新算，所以先接受哪块、撤销哪块都不会互相打架。
    setNoteParts(group, draft, next) {
        return this.queueContentWrite(async () => {
            if (this.assistantSession?.workbenchRunning || (this.assistantSession?.tasks || []).some(t => t.type === 'batch-process' && t.content?.canInterrupt)) throw new Error(tr('请等待当前生成任务结束后再确认。', 'Wait for the current run to finish before confirming.'));
            const file = group.file;
            draft.originalPath ||= file.path;
            draft.applied ||= [];
            const info = this.notePartsInfo(group, draft);
            if (info.original === undefined) throw new Error(tr('建议已过期，请重新生成。', 'The suggestions are out of date. Generate them again.'));
            const wanted = [...new Set(next)].filter(k => info.parts[k]);
            // 样式提议在接受时定下来，之后改标题、换文件夹都不会让已写入的样式对不上
            if (wanted.includes('style') && !draft.styleList) draft.styleList = info.styleList;
            const before = this.notePartsTarget(group, draft, new Set(draft.applied), info.original);
            const after = this.notePartsTarget(group, draft, new Set(wanted), info.original);
            const current = await this.app.vault.read(file);
            if (current !== before.text || file.path !== before.path) throw new Error(tr('笔记已有新修改，请重新生成建议。', 'The note changed since. Generate suggestions again.'));
            if (after.path !== file.path && this.app.vault.getAbstractFileByPath(after.path)) throw new Error(tr('目标位置已有同名文件，未做修改。', 'A file with the same name exists there; nothing was changed.'));
            const fromPath = file.path;
            if (after.text !== current || after.path !== fromPath) {
                if (after.folder && !this.app.vault.getAbstractFileByPath(after.folder)) await this.app.vault.createFolder(after.folder);
                let wrote = false;
                try {
                    if (after.text !== current) { await this.guardedWrite(file, current, after.text); wrote = true; }
                    if (after.path !== fromPath) await this.app.fileManager.renameFile(file, after.path);
                } catch (error) {
                    if (wrote && file.path === fromPath) { try { await this.guardedWrite(file, after.text, current); } catch { /* 笔记已被改动，保留现状 */ } }
                    throw error;
                }
            }
            // 一篇只留一条撤销记录，记着最初的原文和位置
            let snapshot = (this.settings.rollbackHistory || []).find(s => s.id === draft.snapshotId);
            if (wanted.length) {
                if (!snapshot) {
                    snapshot = await this.saveRollbackSnapshot({ file, action: tr('笔记集中确认', 'Note review'), originalContent: info.original, appliedContent: after.text });
                    snapshot.originalPath = draft.originalPath;
                    draft.snapshotId = snapshot.id;
                }
                snapshot.appliedContent = after.text;
                snapshot.filePath = file.path;
            } else {
                if (snapshot) this.settings.rollbackHistory = this.settings.rollbackHistory.filter(s => s.id !== snapshot.id);
                delete draft.snapshotId;
            }
            draft.applied = wanted;
            if (!wanted.includes('style')) delete draft.styleList;
            const finished = wanted.length > 0 && Object.keys(info.parts).every(k => wanted.includes(k) || (draft.skipped || []).includes(k));
            for (const task of group.tasks) {
                if (wanted.length) task.content.noteSnapshotId = draft.snapshotId; else delete task.content.noteSnapshotId;
                task.content.noteApplied = finished;
            }
            await this.saveSettings();
            if (finished) this.addToHistory(file.basename, file.path, tr('笔记集中确认', 'Note review'), this.generateFileId(file));
        });
    }

    async undoReviewTask(taskId) {
        const task = this.view?.getTask(taskId), content = task?.content;
        if (!content?.applied || !content.reviewSnapshotId) return;
        try {
            await this.queueContentWrite(async () => {
                const history = this.settings.rollbackHistory || [];
                const snapshot = history.find(s => s.id === content.reviewSnapshotId);
                if (!snapshot) throw new Error(tr('此修改已撤回或不在撤回记录中。', 'This change was already undone or is not in the undo record.'));
                const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
                if (!file) throw new Error(tr('目标笔记已移动或删除。', 'The note was moved or deleted.'));
                await this.guardedWrite(file, snapshot.appliedContent, snapshot.originalContent);
                this.settings.rollbackHistory = history.filter(s => s.id !== snapshot.id);
                this.settings.rollbackRedoHistory = [snapshot, ...(this.settings.rollbackRedoHistory || [])].slice(0,30);
                await this.saveSettings();
                content.applied = false;
            });
            this.view.render();
            new Notice(tr('已撤回本次正文修改，审阅选择保留。', 'The text change was undone; your review choices are kept.'));
        } catch (error) { new Notice(tr(`无法撤回：${error.message}`, `Cannot undo: ${error.message}`), 6000); }
    }

    async createDiffPreviewTask({ taskId = null, file, action, title, originalContent, proposedContent, notebook = null }) {
        await this.activateView();
        const id = taskId || `diff-${Date.now()}`;
        const task = {
            id,
            type: 'diff-preview',
            status: 'displaying',
            title: title || tr(`变更预览: ${file.basename}`, `Change preview: ${file.basename}`),
            content: {
                file,
                action,
                originalContent,
                proposedContent,
                notebook,
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
            new Notice(tr('未找到可应用的变更预览。', 'No change preview to apply.'), 3000);
            return;
        }

        const content = task.content || {};
        const file = content.file;
        if (!file) {
            new Notice(tr('变更预览缺少目标文件。', 'The change preview has no target file.'), 3000);
            return;
        }

        if (content.applied) return;
        try {
            const hunks = content.reviewHunks || this.buildReviewHunks(content.originalContent || '', content.proposedContent || '');
            const selected = content.reviewSelected || hunks.map(h => h.id);
            if (!selected.length) { new Notice(tr('请至少选择一项修改。', 'Select at least one change.')); return; }
            const proposed = this.composeReviewContent(content.originalContent, hunks, selected);
            const snapshot = await this.applyContentChange(file, content.action || tr('AI 变更', 'AI change'), content.originalContent, proposed);
            content.applied = true;
            content.reviewSnapshotId = snapshot?.id;
            this.addToHistory(file.basename, file.path, content.action || tr('AI 变更', 'AI change'), this.generateFileId(file));
            this.view.updateTask(taskId, {
                title: task.title || tr('变更预览', 'Change preview'),
                content
            });
            new Notice(tr('变更已应用，可用“回滚上次修改”恢复。', 'Change applied. Use "Undo last change" to restore.'), 4000);
        } catch (error) {
            new Notice(tr(`应用变更失败: ${error.message}`, `Applying the change failed: ${error.message}`), 5000);
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
                throw new Error(tr('笔记已有新修改，已保留当前内容。请重新预览后再应用。', 'The note changed since; the current text is kept. Preview again before applying.'));
            }
            return replacement;
        });
    }

    applyContentChange(file, action, expected, replacement) {
        return this.queueContentWrite(async () => {
            const current = await this.app.vault.read(file);
            if (expected !== null && current !== expected) {
                throw new Error(tr('笔记已有新修改，已保留当前内容。请重新生成预览。', 'The note changed since; the current text is kept. Generate the preview again.'));
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
            if (!snapshot) { new Notice(tr('没有可撤销的内容修改。', 'Nothing to undo.')); return; }
            const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if (!file) { new Notice(tr('原笔记已移动或删除，请先找到原文件。', 'The original note was moved or deleted. Find it first.')); return; }
            try {
                await this.guardedWrite(file, snapshot.appliedContent || '', snapshot.originalContent || '');
                this.settings.rollbackHistory = history.slice(1);
                this.settings.rollbackRedoHistory = [snapshot, ...(this.settings.rollbackRedoHistory || [])].slice(0, 30);
                await this.saveSettings();
                new Notice(tr(`已撤销：${snapshot.fileName}`, `Undone: ${snapshot.fileName}`));
            } catch (error) { new Notice(tr(`无法撤销：${error.message}`, `Cannot undo: ${error.message}`), 6000); }
        });
    }

    async redoLastRollback() {
        return this.queueContentWrite(async () => {
            const history = this.settings.rollbackRedoHistory || [];
            const snapshot = history[0];
            if (!snapshot) { new Notice(tr('没有可重做的修改。', 'Nothing to redo.')); return; }
            const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if (!file) { new Notice(tr('原笔记已移动或删除，请先找到原文件。', 'The original note was moved or deleted. Find it first.')); return; }
            try {
                await this.guardedWrite(file, snapshot.originalContent || '', snapshot.appliedContent || '');
                this.settings.rollbackRedoHistory = history.slice(1);
                this.settings.rollbackHistory = [snapshot, ...(this.settings.rollbackHistory || [])].slice(0, 30);
                await this.saveSettings();
                new Notice(tr(`已重做：${snapshot.fileName}`, `Redone: ${snapshot.fileName}`));
            } catch (error) { new Notice(tr(`无法重做：${error.message}`, `Cannot redo: ${error.message}`), 6000); }
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
                title: tr('批量处理', 'Batch processing'),
                status: 'displaying',
                content: {
                    message: tr('未选择任何文件', 'No files selected'),
                    type: 'error'
                }
            });
            return;
        }

        const send = this.describeBatchSend(selectedFiles);
        const firstDestination = send.destinations[0];
        if (firstDestination) {
            new Notice(tr(`开始批量处理：${send.notes} 篇，约 ${send.size}，发给「${firstDestination.name}」${firstDestination.local ? '（本地模型）' : ''}${send.destinations.length > 1 ? `，失败时依次改用其余 ${send.destinations.length - 1} 个配置` : ''}。`, `Starting batch: ${send.notes} notes, about ${send.size}, to "${firstDestination.name}"${firstDestination.local ? ' (local model)' : ''}${send.destinations.length > 1 ? `, then the other ${send.destinations.length - 1} configurations if it fails` : ''}.`), 8000);
        }

        // 设置中断标志
        this.batchProcessInterrupted = false;

        // 在助手面板中显示进度
        await this.activateView();
        const taskId = Date.now().toString();
        this.view.addTask({
            id: taskId,
            type: 'batch-process',
            title: tr('批量处理进行中', 'Batch running'),
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
                    title: tr('批量处理已中断', 'Batch stopped'),
                    content: {
                        ...this.view.getTask(taskId).content,
                        processedCount,
                        errorCount,
                        canInterrupt: false,
                        message: tr(`处理已中断！已处理: ${processedCount}, 失败: ${errorCount}`, `Stopped. Done: ${processedCount}, failed: ${errorCount}`)
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
                await new Promise(resolve => window.setTimeout(resolve, 1000));

            } catch (error) {
                console.error(tr(`处理文件 ${file.basename} 时出错:`, `Error processing ${file.basename}:`), error);
                errorCount++;
            }
        }

        // 完成处理
        this.view.updateTask(taskId, {
            title: tr('批量处理完成', 'Batch finished'),
            content: {
                ...this.view.getTask(taskId).content,
                processedCount,
                errorCount,
                canInterrupt: false,
                message: tr(`批量处理完成！成功: ${processedCount}, 失败: ${errorCount}`, `Batch finished. Done: ${processedCount}, failed: ${errorCount}`)
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
                title: tr('文件夹批量处理', 'Folder batch'),
                status: 'displaying',
                content: {
                    message: tr(`文件夹 "${folderPath}" 中没有找到 Markdown 文件`, `No Markdown files in folder "${folderPath}"`),
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
            title: tr('确认文件夹批量处理', 'Confirm folder batch'),
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

        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
            return;
        }

        const currentFile = targetFile || app.workspace.getActiveFile();
        if (!currentFile) {
            new Notice(tr("没有活动的笔记文件。", 'No active note.'));
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
            new Notice(tr("笔记或选中内容为空，无需处理。", 'The note or selection is empty; nothing to do.'));
            return;
        }

        let progressNotice = new Notice(tr("AI 正在重构您的笔记结构...", 'The AI is restructuring your note…'), 0);
        let taskId = `structurizer-${Date.now()}`;
        try {
            await this.activateView();
            this.view.addTask({
                id: taskId,
                type: 'structurizer',
                status: 'loading',
                title: tr(`结构优化生成中: ${currentFile.basename}`, `Tidying structure: ${currentFile.basename}`),
                message: tr('正在接收 AI 输出...', 'Receiving AI output…'),
                content: { file: currentFile, streamingContent: '' }
            });

            const notebookFm = app.metadataCache.getFileCache(currentFile)?.frontmatter || {};
            const prompt = this.getStructurizerPrompt(contentToProcess, isSelection ? {} : notebookFm);

            const newContent = await this.makeApiRequest(prompt, null, false, null, {
                label: tr('结构优化', 'Tidy structure'),
                stream: true,
                onStream: (_delta, accumulated) => {
                    this.view?.updateTask(taskId, {
                        streamingContent: accumulated,
                        content: { file: currentFile, streamingContent: accumulated }
                    });
                }
            });

            let proposedContent;
            const notebook = !isSelection && this.notebookMarks() ? this.cleanNotebookMarks(newContent, contentToProcess, notebookFm) : null;
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
                proposedContent = originalFrontmatter + (notebook ? notebook.text : newContent).trim();
            }

            progressNotice.hide();
            await this.createDiffPreviewTask({
                taskId,
                notebook: notebook?.stats,
                file: currentFile,
                action: notebook ? tr('手账整理', 'Notebook tidy') : tr("结构优化", 'Tidy structure'),
                title: tr(`结构优化预览: ${currentFile.basename}`, `Structure preview: ${currentFile.basename}`),
                originalContent: originalFullContent,
                proposedContent
            });

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                this.view?.removeTask(taskId);
                return;
            }
            new Notice(tr(`处理失败：${this.failureText(error)}`, `Failed: ${this.failureText(error)}`), 0);
            this.view?.updateTask(taskId, { status: 'displaying', type: 'error', title: tr('这次处理未完成', 'This run did not finish'), content: this.errorContent(currentFile, error) });
            console.error("AI Structurizer Error:", error);
        }
    }

    async runAiFurigana(showCompletionCard = true, targetFile = null, showProgressNotice = true) {
        const app = this.app;

        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
            return;
        }

        const currentFile = targetFile || app.workspace.getActiveFile();
        if (!currentFile) {
            new Notice(tr("没有活动的笔记文件。", 'No active note.'));
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
            new Notice(tr("笔记或选中内容为空，无需处理。", 'The note or selection is empty; nothing to do.'));
            return;
        }

        let progressNotice = showProgressNotice ? new Notice(tr("AI 正在为日文汉字添加假名注音...", 'The AI is adding readings to Japanese kanji…'), 0) : null;
        let taskId = `furigana-${Date.now()}`;
        try {
            await this.activateView();
            this.view.addTask({
                id: taskId,
                type: 'furigana',
                status: 'loading',
                title: tr(`假名标注生成中: ${currentFile.basename}`, `Adding furigana: ${currentFile.basename}`),
                message: tr('正在接收 AI 输出...', 'Receiving AI output…'),
                content: { file: currentFile, streamingContent: '' }
            });

            const prompt = this.getFuriganaPrompt(contentToProcess);

            const newContent = await this.makeApiRequest(prompt, null, false, null, {
                label: tr('假名标注', 'Furigana'),
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
                action: tr("日文假名标注", 'Furigana'),
                title: tr(`假名标注预览: ${currentFile.basename}`, `Furigana preview: ${currentFile.basename}`),
                originalContent: originalFullContent,
                proposedContent
            });
            new Notice(tr("假名标注预览已生成，请在侧栏确认后应用。", 'Furigana preview ready. Confirm it in the sidebar to apply.'), 5000);

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                this.view?.removeTask(taskId);
                return;
            }
            new Notice(tr(`处理失败：${this.failureText(error)}`, `Failed: ${this.failureText(error)}`), 0);
            this.view?.updateTask(taskId, { status: 'displaying', type: 'error', title: tr('这次处理未完成', 'This run did not finish'), content: this.errorContent(currentFile, error) });
            console.error("AI Furigana Error:", error);
        }
    }

    async runAiMover(targetFile = null, showCompletionCard = true) {
        const app = this.app;
        const currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice(tr("没有活动的笔记文件。", 'No active note.'));
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
            return;
        }

        let progressNotice = new Notice(tr("正在准备 AI 文件助手...", 'Preparing the folder assistant…'), 0);

        try {
            progressNotice.setMessage(tr("正在扫描仓库文件夹...", 'Scanning vault folders…'));

            const folderPaths = this.vaultFolderPaths();

            if (folderPaths.length === 0) {
                throw new Error(tr("仓库中未能找到任何可用的文件夹。请检查忽略文件夹列表设置。", 'No usable folders found. Check the ignored folders setting.'));
            }

            progressNotice.setMessage(tr("正在读取当前笔记内容...", 'Reading the note…'));
            const fileText = await app.vault.read(currentFile);
            const fileCache = app.metadataCache.getFileCache(currentFile);
            let content = fileText;
            if (fileCache && fileCache.frontmatter && fileCache.frontmatter.position) {
                content = fileText.substring(fileCache.frontmatter.position.end.offset).trim();
            }
            if (!content) {
                throw new Error(tr("笔记内容为空。", 'The note is empty.'));
            }

            progressNotice.setMessage(tr("正在请求 AI 分析最佳文件夹...", 'Asking the AI for the best folder…'));
            const prompt = this.getMoverPrompt(folderPaths, content);
            const messageContent = await this.makeApiRequest(prompt, null, true);

            let parsedContent;
            try {
                let contentToParse = messageContent.match(/```json\n([\s\S]*?)\n```/)?.[1] || messageContent;
                parsedContent = JSON.parse(contentToParse);
            } catch (e) {
                // 不打印 AI 的原始回答：里面可能有笔记内容
                console.error("[AI Assistant] Could not parse the JSON returned by the AI:", e?.message);
                throw new Error(tr("无法解析AI返回的JSON。", 'Could not parse the JSON returned by the AI.'));
            }

            const suggestions = this.refineFolderSuggestions(parsedContent.suggestions);
            if (suggestions.length === 0) {
                throw new Error(this.settings.moverExistingOnly
                    ? tr("AI 建议的都是新文件夹；可以关掉“只用现有文件夹”再试。", 'The AI only suggested new folders; turn off "Existing folders only" and try again.')
                    : tr("AI未能提供有效的路径建议。", 'The AI gave no usable folder suggestion.'));
            }

            progressNotice.hide();

            await this.activateView();
            let taskId = `mover-${Date.now()}`;
            this.view.addTask({
                id: taskId,
                type: 'mover',
                status: 'displaying',
                title: tr(`移动笔记: ${currentFile.basename}`, `Move note: ${currentFile.basename}`),
                content: { suggestions: suggestions, file: currentFile }
            });

        } catch (error) {
            if (progressNotice) progressNotice.hide();
            if (this.isCancellationError(error)) {
                return;
            }
            new Notice(tr(`处理失败：${this.failureText(error)}`, `Failed: ${this.failureText(error)}`), 0);
            console.error("aiMover Script Error:", error);
        }
    }

    async runAiTagger(targetFile = null, showCompletionCard = true) {
        const app = this.app;
        const currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice(tr("没有活动的笔记文件。", 'No active note.'));
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
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
            new Notice(tr("笔记内容为空。", 'The note is empty.'));
            return;
        }

        let progressNotice = new Notice(tr("正在准备 AI 标签助手...", 'Preparing the tag assistant…'), 0);
        let taskId = null;
        try {
            progressNotice.setMessage(tr("正在扫描知识库中的所有标签...", 'Scanning all tags in the vault…'));
            const existingTags = this.vaultTagsByUse();

            progressNotice.setMessage(tr("正在请求 AI 生成初步标签...", 'Asking the AI for tags…'));
            const taggerPrompt = this.getTaggerPrompt(existingTags, content);

            await this.activateView();
            taskId = `tagger-${Date.now()}`;
            this.view.addTask({
                id: taskId,
                type: 'tagger',
                status: 'loading',
                title: tr(`标签建议: ${currentFile.basename}`, `Tag suggestions: ${currentFile.basename}`)
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
                throw new Error(tr("AI 未能生成任何初步标签。", 'The AI generated no tags.'));
            }

            let processedTags = [...rawAiTags];
            if (this.settings.taggerEnableTranslation) {
                const tagsToTranslate = [];
                const originalIndicesOfTagsToTranslate = [];

                rawAiTags.forEach((tag, index) => {
                    const isLikelyEnglish = !/[\u3000-\u303F\u4e00-\u9fff\uff00-\uffef]/.test(tag);
                    // 层级标签不整条翻译，否则 a/b/c 会被翻成一个没有层级的词
                    if (isLikelyEnglish && !tag.includes('/') && tag.length >= this.settings.taggerTranslationMinLength) {
                        tagsToTranslate.push(tag);
                        originalIndicesOfTagsToTranslate.push(index);
                    }
                });

                if (tagsToTranslate.length > 0) {
                    progressNotice.setMessage(tr(`检测到 ${tagsToTranslate.length} 个长英文标签，正在翻译...`, `Found ${tagsToTranslate.length} long English tags, translating…`));
                    const translationPrompt = this.getTranslationPrompt(tagsToTranslate);
                    try {
                        const translationResult = await this.makeApiRequest(translationPrompt, this.getAuxiliaryModelName());
                        const translations = translationResult.trim().split('\n');
                        if (translations && translations.length === tagsToTranslate.length) {
                            translations.forEach((translatedTag, i) => {
                                const originalIndex = originalIndicesOfTagsToTranslate[i];
                                processedTags[originalIndex] = translatedTag.trim();
                            });
                            progressNotice.setMessage(tr("翻译完成，准备显示选项...", 'Translation done, preparing options…'));
                        } else {
                            new Notice(tr("翻译结果数量与请求不符，跳过翻译。", 'Translation count did not match; translation skipped.'), 3000);
                        }
                    } catch (translationError) {
                        new Notice(tr("翻译过程中发生错误。", 'Translation failed.'), 3000);
                        console.error("Error during translation fetch:", translationError);
                    }
                }
            }

            if (this.settings.taggerExistingOnly) processedTags = rawAiTags;
            processedTags = this.refineTags(processedTags, existingTags, this.noteTags(currentFile));
            if (processedTags.length === 0 && this.settings.taggerExistingOnly) {
                new Notice(tr('AI 建议的标签都不在你的现有标签里；可以关掉“只用现有标签”再试。', 'None of the suggested tags are in your existing tags; turn off "Existing tags only" and try again.'), 6000);
            }

            const tagsForPrompt = processedTags.map(tag => ({ display: tag, final: tag, is_new: !existingTags.includes(tag) }));

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
            new Notice(tr(`处理失败：${this.failureText(error)}`, `Failed: ${this.failureText(error)}`), 0);
            console.error("AI Tagger Error:", error);
        }
    }

    async runAiMeta(targetFile = null, showCompletionCard = true) {
        const app = this.app;
        const currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice(tr("没有活动的笔记文件。", 'No active note.'));
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
            return;
        }

        let progressNotice = new Notice(tr("正在准备 AI 元数据助手...", 'Preparing the properties assistant…'), 0);
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
                    new Notice(tr("使用选中文本生成元数据...", 'Generating properties from the selection…'));
                }
            }

            if (!content || content.trim() === "") {
                throw new Error(tr("笔记内容为空，无法生成元数据。", 'The note is empty; no properties can be generated.'));
            }

            // 根据已有字段调整AI请求
            let aiGeneratedData = {};

            if (hasExistingSummary && hasExistingTldr) {
                // 如果summary和tldr都存在，只生成title
                progressNotice.setMessage(tr("检测到已有摘要和总结，仅生成标题...", 'Summary and one-liner exist; generating the title only…'));
                const titleOnlyPrompt = this.getTitleOnlyPrompt(content);
                const messageContent = await this.makeApiRequest(titleOnlyPrompt, null, true);

                let parsedContent;
                try {
                    const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
                    parsedContent = JSON.parse(jsonMatch ? jsonMatch[1] : messageContent);
                } catch (e) {
                    throw new Error(tr(`无法解析AI返回的JSON: ${e.message}`, `Could not parse the JSON returned by the AI: ${e.message}`));
                }

                aiGeneratedData = {
                    title: parsedContent.title || currentFile.basename,
                    summary: existingFrontmatter.summary,
                    tldr: existingFrontmatter.tldr
                };
            } else {
                // 正常生成所有字段，但会在后面使用已有的字段
                progressNotice.setMessage(tr("正在请求 AI 生成元数据...", 'Asking the AI for properties…'));
                const prompt = this.getMetaPrompt(content, hasExistingSummary, hasExistingTldr);
                const messageContent = await this.makeApiRequest(prompt, null, true);

                let parsedContent;
                try {
                    const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
                    parsedContent = JSON.parse(jsonMatch ? jsonMatch[1] : messageContent);
                } catch (e) {
                    throw new Error(tr(`无法解析AI返回的JSON: ${e.message}`, `Could not parse the JSON returned by the AI: ${e.message}`));
                }

                let { title, summary, tldr } = parsedContent;

                // 使用已有字段或AI生成的字段
                aiGeneratedData = {
                    title: title || currentFile.basename,
                    summary: hasExistingSummary ? existingFrontmatter.summary : (summary || ''),
                    tldr: hasExistingTldr ? existingFrontmatter.tldr : (tldr || '')
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
                title: tr(`元数据建议: ${currentFile.basename}`, `Property suggestions: ${currentFile.basename}`),
                content: { title, summary, tldr, finalFilename, newPath, file: currentFile }
            });

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                return;
            }
            new Notice(tr(`处理失败：${this.failureText(error)}`, `Failed: ${this.failureText(error)}`), 0);
            console.error("AI Meta Error:", error);
        }
    }

    // The sidebar passes the user's one-line request; every prompt built during this run includes it.
    async runOneClickSmartProcess(targetFile = null, selectedActions = null, shouldStop = () => false, instruction = '') {
        this.currentUserInstruction = String(instruction || '').trim();
        try {
            return await this.runOneClickSmartProcessSteps(targetFile, selectedActions, shouldStop);
        } finally {
            this.currentProgress = null;
            this.currentUserInstruction = '';
        }
    }

    userInstructionBlock() {
        if (!this.currentUserInstruction) return '';
        return tr(`\n\n**用户的补充要求（在不编造内容的前提下优先遵守）:**\n${this.currentUserInstruction}`, `\n\n**The user's extra request (follow it first, without making anything up):**\n${this.currentUserInstruction}`);
    }

    async runOneClickSmartProcessSteps(targetFile = null, selectedActions = null, shouldStop = () => false) {
        const app = this.app;
        let currentFile = targetFile || app.workspace.getActiveFile();

        if (!currentFile) {
            new Notice(tr("没有活动的笔记文件。", 'No active note.'));
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
            return;
        }

        const oneClickProcessActions = { ...(selectedActions || this.settings.oneClickProcessActions) };
        const actions = Object.keys(oneClickProcessActions).filter(k => oneClickProcessActions[k]);

        if (actions.length === 0) {
            new Notice(tr('没有在设置中启用任何"一键处理"步骤。', 'No one-click steps are enabled in settings.'));
            return;
        }

        let progressNotice = new Notice(tr('开始整理…', 'Starting…'), 0);
        // 走到哪一步：通知和侧栏横幅都显示“第 n 步，共 m 步”
        const interactiveCount = actions.filter(a => a !== 'structurizer' && a !== 'furigana').length ? 1 : 0;
        const totalSteps = (oneClickProcessActions.structurizer ? 1 : 0) + (oneClickProcessActions.furigana ? 1 : 0) + interactiveCount;
        let step = 0;
        const setStep = (text) => {
            step += 1;
            this.currentProgress = tr(`第 ${step} 步，共 ${totalSteps} 步：${text}`, `Step ${step} of ${totalSteps}: ${text}`);
            progressNotice.setMessage(this.currentProgress);
            this.view?.render();
        };
        this.lastCancelled = null;

        try {
            // --- 1. Structurizer (if enabled) ---
            if (oneClickProcessActions.structurizer) {
                setStep(tr('整理正文结构', 'tidying the structure'));
                await this.runAiStructurizer(false, currentFile);
                if (shouldStop()) { progressNotice.hide(); this.lastCancelled = currentFile.path; return; }
                // Re-read file content after potential modification
                // Keep currentFile pinned to the original target.
            }

            if (oneClickProcessActions.furigana) {
                setStep(tr('给日文加假名', 'adding furigana'));
                await this.runAiFurigana(false, currentFile, false);
                if (shouldStop()) { progressNotice.hide(); this.lastCancelled = currentFile.path; return; } // 复用一键处理的进度提示，不再额外弹窗
                // Keep currentFile pinned to the original target.
            }

            const interactiveActions = actions.filter(a => a !== 'structurizer' && a !== 'furigana');
            if (interactiveActions.length === 0) {
                progressNotice.hide();
                new Notice(tr("预处理步骤已完成。没有其他已启用的处理步骤。", 'Pre-processing done. No other steps are enabled.'));
                return;
            }

            // --- 2. Prepare for combined AI call ---
            setStep(tr('生成标题、标签和归档建议', 'suggesting title, tags and folder'));
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
            if (!contentToProcess) throw new Error(tr("笔记内容为空。", 'The note is empty.'));

            let contextForPrompt = "";
            let jsonStructure = {};

            if (oneClickProcessActions.tagger) {
                const existingTags = this.vaultTagsByUse();
                contextForPrompt += tr(`\n\n**现有标签列表 (你的风格指南):**\n${existingTags.join(', ')}`, `\n\n**Existing tags (your style guide):**\n${existingTags.join(', ')}`);
                jsonStructure.tags = ["tag1/subtag", "tag2"];
            }
            if (oneClickProcessActions.mover) {
                const folderPaths = this.vaultFolderPaths();
                contextForPrompt += tr(`\n\n**现有文件夹列表 (供你参考和选择):**\n${JSON.stringify(folderPaths, null, 2)}`, `\n\n**Existing folders (to choose from):**\n${JSON.stringify(folderPaths, null, 2)}`);
                jsonStructure.mover_suggestions = [{ path: "path/to/folder", is_new: false }];
            }
            if (oneClickProcessActions.meta) {
                // 根据已有字段调整JSON结构
                let metaFields = { title: "string" };
                if (!hasExistingSummary) metaFields.summary = "string";
                if (!hasExistingTldr) metaFields.tldr = "string";
                jsonStructure.meta = metaFields;
            }

            let prompt = tr(`你是一个强大的多任务AI助手。请基于以下提供的文本，执行所有请求的任务。

**核心规则**:
1. 在分析时，请**专注于文本内容本身**，忽略任何Markdown链接或嵌入文件（如 \`![...]]\` 或 \`[...](...)\`）所指向的视觉或外部信息。
2. 你的回答必须是一个严格遵守以下结构的JSON对象。标题和摘要用原文的语言写。

**任务列表:**
${oneClickProcessActions.meta ? this.getMetaTaskDescription(hasExistingSummary, hasExistingTldr) : ''}${oneClickProcessActions.tagger ? (this.settings.taggerExistingOnly ? `- **生成标签**: 提供最多 ${this.settings.taggerSuggestionsCount} 个标签，只能从"现有标签列表"中挑选，不要创造新标签。\n` : `- **生成标签**: 提供约 ${this.settings.taggerSuggestionsCount} 个标签。优先使用"现有标签列表"中的标签，新标签必须是层级格式 (如 a/b/c)。\n`) : ''}${oneClickProcessActions.mover ? (this.settings.moverExistingOnly ? `- **建议文件夹**: 提供最多 ${this.settings.moverSuggestionsCount} 个最合适的存放路径，只能从"现有文件夹列表"中选择。\n` : `- **建议文件夹**: 提供 ${this.settings.moverSuggestionsCount} 个最合适的存放路径建议，可以从"现有文件夹列表"中选择或创造新的。\n`) : ''}
**JSON 输出格式:**
\`\`\`json
${JSON.stringify(jsonStructure, null, 2)}
\`\`\`
${contextForPrompt}${this.vaultRulesBlock()}${this.languageHintBlock(contentToProcess)}${this.titleHintBlock()}${this.userInstructionBlock()}

**需要处理的文本如下：**
\n\n${contentToProcess}`, `You are a capable multi-task AI assistant. Based on the text below, carry out every requested task.

**Rules**:
1. Base your work on the **text itself** and ignore what Markdown links or embeds (such as \`![...]]\` or \`[...](...)\`) point to.
2. Reply with one JSON object that follows the structure below exactly. Write titles and summaries in the same language as the text.

**Tasks:**
${oneClickProcessActions.meta ? this.getMetaTaskDescription(hasExistingSummary, hasExistingTldr) : ''}${oneClickProcessActions.tagger ? (this.settings.taggerExistingOnly ? `- **Tags**: give at most ${this.settings.taggerSuggestionsCount} tags, chosen only from the existing tags; do not create new ones.\n` : `- **Tags**: give about ${this.settings.taggerSuggestionsCount} tags. Prefer the existing tags; new tags must be hierarchical (such as a/b/c).\n`) : ''}${oneClickProcessActions.mover ? (this.settings.moverExistingOnly ? `- **Folder**: give at most ${this.settings.moverSuggestionsCount} suggested paths, chosen only from the existing folders.\n` : `- **Folder**: give ${this.settings.moverSuggestionsCount} suggested paths, chosen from the existing folders or new.\n`) : ''}
**JSON output format:**
\`\`\`json
${JSON.stringify(jsonStructure, null, 2)}
\`\`\`
${contextForPrompt}${this.vaultRulesBlock()}${this.languageHintBlock(contentToProcess)}${this.titleHintBlock()}${this.userInstructionBlock()}

**The text to process:**
\n\n${contentToProcess}`);

            if (shouldStop()) { progressNotice.hide(); this.lastCancelled = currentFile.path; return; }

            const messageContent = await this.makeApiRequest(prompt, null, true);

            let parsedContent;
            try {
                const jsonMatch = messageContent.match(/```json\n([\s\S]*?)\n```/);
                const contentToParse = jsonMatch ? jsonMatch[1] : messageContent;
                parsedContent = JSON.parse(contentToParse);

                // 确保meta字段的完整性，使用已有字段或AI生成的字段
                if (parsedContent.meta) {
                    // 如果某些字段为空，提供默认值
                    // 缺的字段留空，不写“暂无摘要”这类占位话：空字段不会被写进笔记
                    if (!parsedContent.meta.title) parsedContent.meta.title = currentFile.basename;
                    if (hasExistingSummary) parsedContent.meta.summary = existingFrontmatter.summary;
                    else if (!parsedContent.meta.summary) parsedContent.meta.summary = '';
                    if (hasExistingTldr) parsedContent.meta.tldr = existingFrontmatter.tldr;
                    else if (!parsedContent.meta.tldr) parsedContent.meta.tldr = '';
                }
            } catch (e) {
                // 不打印 AI 的原始回答：里面可能有笔记内容
                console.error("[AI Assistant] Could not parse the JSON returned by the AI:", e?.message);
                throw new Error(tr("无法解析AI返回的JSON。", 'Could not parse the JSON returned by the AI.'));
            }

            // --- 3. Process Tagger results if present (incl. translation) ---
            let tagSuggestions = [];
            if (parsedContent.tags) {
                // Processing similar to runAiTagger...
                const rawAiTags = Array.isArray(parsedContent.tags) ? parsedContent.tags.map(String) : String(parsedContent.tags).split(/[,，]/);
                const existingTags = this.vaultTagsByUse();
                let processedTags = [...rawAiTags];

                // Add translation logic for long english tags
                if (this.settings.taggerEnableTranslation && rawAiTags.length > 0) {
                    const tagsToTranslate = [];
                    const originalIndicesOfTagsToTranslate = [];

                    rawAiTags.forEach((tag, index) => {
                        const isLikelyEnglish = !/[\u3000-\u303F\u4e00-\u9fff\uff00-\uffef]/.test(tag);
                        if (isLikelyEnglish && !tag.includes('/') && tag.length >= this.settings.taggerTranslationMinLength) {
                            tagsToTranslate.push(tag);
                            originalIndicesOfTagsToTranslate.push(index);
                        }
                    });

                    if (tagsToTranslate.length > 0) {
                        progressNotice.setMessage(tr(`检测到 ${tagsToTranslate.length} 个长英文标签，正在翻译...`, `Found ${tagsToTranslate.length} long English tags, translating…`));
                        const translationPrompt = this.getTranslationPrompt(tagsToTranslate);
                        try {
                            const translationResult = await this.makeApiRequest(translationPrompt, this.getAuxiliaryModelName());
                            const translations = translationResult.trim().split('\n');
                            if (translations && translations.length === tagsToTranslate.length) {
                                translations.forEach((translatedTag, i) => {
                                    const originalIndex = originalIndicesOfTagsToTranslate[i];
                                    processedTags[originalIndex] = translatedTag.trim();
                                });
                                progressNotice.setMessage(tr("翻译完成，准备显示选项...", 'Translation done, preparing options…'));
                            } else {
                                new Notice(tr("翻译结果数量与请求不符，跳过翻译。", 'Translation count did not match; translation skipped.'), 3000);
                            }
                        } catch (translationError) {
                            new Notice(tr("翻译过程中发生错误。", 'Translation failed.'), 3000);
                            console.error("Error during translation fetch:", translationError);
                        }
                    }
                }

                if (this.settings.taggerExistingOnly) processedTags = rawAiTags;
                processedTags = this.refineTags(processedTags, existingTags, this.noteTags(currentFile));
                tagSuggestions = processedTags.map(tag => ({ display: tag, final: tag, is_new: !existingTags.includes(tag) }));
            }

            const moverSuggestions = parsedContent.mover_suggestions ? this.refineFolderSuggestions(parsedContent.mover_suggestions) : [];

            // --- 4. Display results in sidebar ---
            await this.activateView();
            const taskId = `one-click-${Date.now()}`;
            this.view.addTask({
                id: taskId,
                type: 'one-click',
                status: 'displaying',
                title: tr(`智能处理建议: ${currentFile.basename}`, `Suggestions: ${currentFile.basename}`),
                content: {
                    originalContent: noteOriginalContent,
                    suggestions: {
                        meta: parsedContent.meta,
                        tags: tagSuggestions.length > 0 ? tagSuggestions : null,
                        mover: moverSuggestions.length ? moverSuggestions : null,
                    },
                    file: currentFile
                }
            });

            progressNotice.hide();

        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                this.lastCancelled = currentFile.path;
                return;
            }
            new Notice(tr(`整理失败：${this.failureText(error)}`, `Tidying failed: ${this.failureText(error)}`), 8000);
            this.view?.addTask({ id: `error-${Date.now()}`, status: 'displaying', type: 'error', title: tr('这次处理未完成', 'This run did not finish'), content: this.errorContent(currentFile, error) });
            console.error("One Click Process Error:", error);
        }
    }

    async updateFrontmatter(file, title, summary, tldr) {
        let progressNotice = new Notice(tr("正在更新笔记元数据...", 'Updating note properties…'), 0);
        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (String(title || '').trim()) fm.title = String(title).trim();
                if (!fm.summary && String(summary || '').trim()) fm.summary = String(summary).trim();
                if (!fm.tldr && String(tldr || '').trim()) fm.tldr = String(tldr).trim();
                this.fillFieldDefaults(fm, file.path);
            });
            progressNotice.hide();
            new Notice(tr("笔记元数据已成功更新！", 'Note properties updated.'), 5000);
        } catch (err) {
            progressNotice.hide();
            new Notice(tr(`更新Frontmatter时出错: ${err.message}`, `Error updating properties: ${err.message}`), 0);
        }
    }

    getMetaPrompt(content, hasExistingSummary = false, hasExistingTldr = false) {
        let prompt = this.promptSetting('metaPrompt');

        // 如果已有某些字段，修改提示词
        if (hasExistingSummary || hasExistingTldr) {
            let skipInstructions = [];
            if (hasExistingSummary) skipInstructions.push(tr("摘要", "summary"));
            if (hasExistingTldr) skipInstructions.push(tr("一句话总结", "one-sentence summary"));

            prompt += tr(`\n\n**注意**: 文件已有${skipInstructions.join("和")}字段，请跳过生成这些字段，只返回需要生成的字段。`, `\n\n**Note**: the note already has ${skipInstructions.join(" and ")}; skip ${skipInstructions.length > 1 ? "those fields" : "that field"} and return only the fields still needed.`);
        }

        return prompt.replace('{{content}}', content) + this.vaultRulesBlock(true) + this.languageHintBlock(content) + this.titleHintBlock();
    }

    // 提示词跟界面语言走：没改过的默认提示词，英文界面发英文版；本人改过的照原样发
    promptSetting(key) {
        const value = this.settings[key];
        const [zh, en] = PROMPT_DEFAULTS[key] || [];
        return !isChineseInterface() && value === zh ? en : value;
    }

    getTitleOnlyPrompt(content) {
        return tr(`请为以下文本内容生成一个简洁有力的标题：

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

确保返回的是有效的JSON格式。`, `Write a short, strong title for the text below:

${content}

Requirements:
1. The title reflects the main content of the text
2. At most 50 characters
3. No special symbols or punctuation
4. Usable as a file name
5. In the same language as the text

Reply in JSON:
{
  "title": "your title"
}

Make sure the JSON is valid.`) + this.vaultRulesBlock(true) + this.languageHintBlock(content) + this.titleHintBlock();
    }

    getMetaTaskDescription(hasExistingSummary, hasExistingTldr) {
        let tasks = [tr("生成一个极其简洁的标题（14个字以内）", "a very short title (under 8 words)")];

        if (!hasExistingSummary) {
            tasks.push(tr("一段简短摘要（3-4句话）", "a short summary (3–4 sentences)"));
        }

        if (!hasExistingTldr) {
            tasks.push(tr("一个一句话总结（25个字以内）", "a one-sentence summary (under 25 words)"));
        }

        let description = tr(`- **生成元数据**: ${tasks.join("、")}。`, `- **Properties**: ${tasks.join("; ")}.`);

        if (hasExistingSummary || hasExistingTldr) {
            let skipFields = [];
            if (hasExistingSummary) skipFields.push(tr("摘要", "summary"));
            if (hasExistingTldr) skipFields.push(tr("一句话总结", "one-sentence summary"));
            description += tr(` 注意：文件已有${skipFields.join("和")}字段，请跳过生成这些字段。`, ` Note: the note already has ${skipFields.join(" and ")}; skip ${skipFields.length > 1 ? "those fields" : "that field"}.`);
        }

        return description + "\n";
    }

    getTaggerPrompt(existingTags, content) {
        const prompt = this.promptSetting('taggerPrompt')
            .replace('{{existing_tags}}', existingTags.join('， '))
            .replace('{{content}}', content)
            .replace('{{count}}', this.settings.taggerSuggestionsCount) + this.vaultRulesBlock();
        if (!this.settings.taggerExistingOnly) return prompt;
        return tr(`${prompt}\n\n**额外规则：** 只能从“现有标签列表”里挑选，不要创造任何新标签；没有合适的就少给几个。`, `${prompt}\n\n**Extra rule:** choose only from the existing tags and create no new ones; if few fit, give fewer.`);
    }

    // “只用现有标签”：不信任模型是否守规矩，结果再按库里的标签过滤一遍，拼写以库里为准
    keepExistingTags(tags, existingTags) {
        const byLowerCase = new Map(existingTags.map(tag => [tag.toLowerCase(), tag]));
        const kept = [];
        for (const raw of tags || []) {
            const candidate = String(raw).trim().replace(/^#/, '').replace(/\s+/g, '-').replace(/，/g, '-');
            const existing = byLowerCase.get(candidate.toLowerCase());
            if (existing && !kept.includes(existing)) kept.push(existing);
        }
        return kept;
    }

    // ---- 库的词表：标签根白名单、父子去重、文件夹只用现有的。都靠设置打开，默认不改变行为 ----
    allowedTagRoots() {
        return String(this.settings.taggerAllowedRoots || '').split(/[\n,，]/).map(r => r.trim().replace(/^#/, '').replace(/\/+$/, '')).filter(Boolean);
    }

    // 设了根白名单时，只有根本身（如 Type）不算标签：Obsidian 的标签统计会把父级也单独列出来
    tagRootAllowed(tag, roots = this.allowedTagRoots()) {
        if (!roots.length) return true;
        if (!String(tag).includes('/')) return false;
        const root = String(tag).split('/')[0].toLowerCase();
        return roots.some(r => r.toLowerCase() === root);
    }

    // 库里的标签按使用次数从多到少排，常用的排前面，模型更容易沿用；有根白名单时只给白名单里的
    vaultTagsByUse() {
        const counts = this.app.metadataCache.getTags() || {};
        const roots = this.allowedTagRoots();
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag]) => tag.replace(/^#/, '')).filter(tag => this.tagRootAllowed(tag, roots));
    }

    noteTags(file) {
        const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
        const raw = fm?.tags ?? fm?.tag;
        const list = Array.isArray(raw) ? raw : (raw ? String(raw).split(/[,\s]+/) : []);
        return list.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean);
    }

    // 清理模型给的标签：统一写法、按库里拼写、去掉不在白名单根下的、笔记已有的和重复的；按设置去掉父标签
    refineTags(tags, existingTags, noteTags = []) {
        const byLowerCase = new Map(existingTags.map(tag => [tag.toLowerCase(), tag]));
        const roots = this.allowedTagRoots();
        const have = new Set(noteTags.map(t => t.toLowerCase()));
        const out = [];
        for (const raw of tags || []) {
            let tag = String(raw).trim().replace(/^#/, '').replace(/\s+/g, '-').replace(/，/g, '-').replace(/^\/+|\/+$/g, '');
            if (!tag) continue;
            tag = byLowerCase.get(tag.toLowerCase()) || tag;
            if (this.settings.taggerExistingOnly && !byLowerCase.has(tag.toLowerCase())) continue;
            if (!this.tagRootAllowed(tag, roots)) continue;
            if (have.has(tag.toLowerCase()) || out.some(t => t.toLowerCase() === tag.toLowerCase())) continue;
            out.push(tag);
        }
        if (!this.settings.taggerDropParentTags) return out;
        const all = [...out, ...noteTags].map(t => t.toLowerCase());
        return out.filter(tag => !all.some(other => other.startsWith(tag.toLowerCase() + '/')));
    }

    ignoredFolderList() {
        return String(this.settings.ignoredFolders || '').split('\n').map(f => f.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
    }

    isIgnoredFolder(path, ignored = this.ignoredFolderList()) {
        return ignored.some(folder => path === folder || path.startsWith(folder + '/'));
    }

    vaultFolderPaths() {
        const ignored = this.ignoredFolderList();
        return this.app.vault.getAllLoadedFiles().filter(f => f.children).map(f => f.path)
            .filter(path => path && path !== '/' && !this.isIgnoredFolder(path, ignored));
    }

    // 文件夹建议：“是否新建”按库里实际情况算，不信模型自报；忽略的文件夹不当目的地；按设置去掉新文件夹
    refineFolderSuggestions(suggestions) {
        const ignored = this.ignoredFolderList();
        const out = [];
        for (const item of Array.isArray(suggestions) ? suggestions : []) {
            const path = String(typeof item === 'string' ? item : item?.path || '').trim().replace(/^\/+|\/+$/g, '');
            if (!path || out.some(s => s.path === path) || this.isIgnoredFolder(path, ignored)) continue;
            const isNew = !this.app.vault.getAbstractFileByPath(path)?.children;
            if (isNew && this.settings.moverExistingOnly) continue;
            out.push({ path, is_new: isNew });
        }
        return out;
    }

    vaultRulesBlock(conventionsOnly = false) {
        const rules = [];
        if (!conventionsOnly) {
        const roots = this.allowedTagRoots();
        if (roots.length) rules.push(tr(`标签只能以这些根开头：${roots.map(r => r + '/').join('、')}；不要新建根，也不要单个词的标签。`, `Tags must start with one of these roots: ${roots.map(r => r + '/').join(', ')}. Do not create new roots or single-word tags.`));
        if (this.settings.taggerDropParentTags) rules.push(tr('不要同时给一个标签和它的父标签，只留更具体的那个。', 'Never give a tag together with its parent; keep only the more specific one.'));
        if (this.settings.moverExistingOnly) rules.push(tr('文件夹只能从“现有文件夹列表”里选，不要创造新路径。', 'Choose folders only from the existing folders; do not invent new paths.'));
        }
        const conventions = String(this.settings.vaultConventions || '').trim();
        if (!rules.length && !conventions) return '';
        return tr(`\n\n**这个库的规矩（必须遵守）:**\n${[...rules.map(r => '- ' + r), conventions].filter(Boolean).join('\n')}`, `\n\n**Rules of this vault (follow them):**\n${[...rules.map(r => '- ' + r), conventions].filter(Boolean).join('\n')}`);
    }

    // 应用属性时补上还没有的字段；YAML 写错就不补，免得把笔记写坏
    fieldDefaults() {
        const text = String(this.settings.metaFieldDefaults || '').trim();
        if (!text) return {};
        try {
            const value = parseYaml(text);
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch {
            return {};
        }
    }

    // 补属性只作用于设置里的文件夹；没设文件夹就不限
    fieldDefaultsApplyTo(path) {
        const folders = String(this.settings.metaFieldDefaultsFolders || '').split('\n').map(f => f.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
        if (!folders.length) return true;
        const parent = String(path || '').split('/').slice(0, -1).join('/');
        return folders.some(folder => parent === folder || parent.startsWith(folder + '/'));
    }

    fillFieldDefaults(fm, path) {
        if (path !== undefined && !this.fieldDefaultsApplyTo(path)) return fm;
        for (const [key, value] of Object.entries(this.fieldDefaults())) {
            if (key === 'tags' || key === 'title' || key === 'summary' || key === 'tldr') continue;
            if (fm[key] === undefined || fm[key] === null || fm[key] === '') fm[key] = value;
        }
        return fm;
    }

    // ---- 样式类提议 ----
    cssClassList(value) {
        const list = Array.isArray(value) ? value : (value ? String(value).split(/[\s,]+/) : []);
        return list.map(v => String(v).trim()).filter(Boolean);
    }

    noteAgeDays(file, fm) {
        for (const value of [fm?.created, fm?.date]) {
            if (!value) continue;
            const time = value instanceof Date ? value.getTime() : Date.parse(String(value).trim().replace(' ', 'T'));
            if (!Number.isNaN(time)) return Math.floor((Date.now() - time) / 86400000);
        }
        const ctime = file?.stat?.ctime;
        return ctime ? Math.floor((Date.now() - ctime) / 86400000) : null;
    }

    agedRules() {
        return String(this.settings.styleAgedRules || '').split('\n').map(line => line.trim().match(/^(\d+)\s+(\S+)$/)).filter(Boolean)
            .map(m => ({ days: Number(m[1]), cls: m[2] })).sort((a, b) => a.days - b.days);
    }

    // 按设置算出这篇笔记可以挂哪些样式类；destination 是应用后所在的文件夹
    styleProposals(file, fm = {}, draft = {}, body = '') {
        const out = [];
        const classes = this.cssClassList(fm.cssclasses ?? fm.cssclass);
        const sub = String(this.settings.styleSubtitleClass || '').trim();
        const draftTldr = draft.useMeta && !(draft.skipMeta || []).includes('tldr') ? String(draft.meta?.tldr || '').trim() : '';
        const tldr = draftTldr || String(fm.tldr || '').trim();
        if (sub && tldr && !this.hasSpanClass(body, sub)) out.push({ key: 'sub', cls: sub, text: tldr.replace(/\s+/g, ' ') });
        const card = String(this.settings.styleCardClass || '').trim();
        const folders = String(this.settings.styleCardFolders || '').split('\n').map(f => f.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
        const destination = String(draft.useFolder ? draft.folder : (file?.parent?.path || '')).replace(/^\/+|\/+$/g, '');
        if (card && folders.some(f => destination === f || destination.startsWith(f + '/')) && !classes.includes(card)) out.push({ key: 'card', cls: card, folder: destination });
        const rules = this.agedRules();
        const age = rules.length ? this.noteAgeDays(file, fm) : null;
        const rule = age === null ? null : rules.filter(r => age >= r.days).at(-1);
        // 同组只留一个，而且只往更旧升级：已有的同组类不比它短就不提议
        const present = rules.filter(r => classes.includes(r.cls));
        if (rule && !present.some(r => r.days >= rule.days)) out.push({ key: 'aged', cls: rule.cls, days: age, remove: rules.map(r => r.cls).filter(c => c !== rule.cls) });
        return out;
    }

    // 写法照 Ithaca 手账工具（ithaca-notebook-kit）：<span class="类">字</span> 单行；判断已有副题按 class 完全相等
    hasSpanClass(text, cls) {
        for (const m of String(text).matchAll(/<span class="([^"]*)">(.*?)<\/span>/g)) if (m[1] === cls) return true;
        return false;
    }

    // 副题放正文第一行：frontmatter 下原有的空行留着，下一行有字就隔一个空行
    insertSubtitleLine(body, cls, text) {
        const lines = String(body).split('\n');
        let row = 0;
        while (row < lines.length - 1 && lines[row].trim() === '') row++;
        const gap = (lines[row] ?? '').trim() !== '';
        const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        lines.splice(row, 0, `<span class="${cls}">${safe}</span>`, ...(gap ? [''] : []));
        return lines.join('\n');
    }

    // cssclasses 的增减照手账工具：先读 cssclasses，没有再读 cssclass；同组的先去掉再加；只有旧字段时才删旧字段
    applyStyleProposals(fm, body, proposals) {
        let classes = this.cssClassList(fm.cssclasses ?? fm.cssclass);
        for (const p of proposals) {
            if (p.key === 'sub') body = this.insertSubtitleLine(body, p.cls, p.text);
            else if (!classes.includes(p.cls)) classes = [...classes.filter(c => !(p.remove || []).includes(c)), p.cls];
        }
        if (proposals.some(p => p.key !== 'sub')) {
            if ('cssclass' in fm && !('cssclasses' in fm)) delete fm.cssclass;
            if (classes.length) fm.cssclasses = classes;
            else delete fm.cssclasses;
        }
        return body;
    }

    // 笔记主要用哪种文字：提示词是中文时，模型容易把英文笔记的标题和摘要也写成中文，所以明说一句
    noteScript(text) {
        const t = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/\[\[[^\]]*\]\]|\]\([^)]*\)|https?:\/\/\S+/g, '');
        const han = (t.match(/[一-鿿]/g) || []).length;
        const kana = (t.match(/[぀-ヿ]/g) || []).length;
        const hangul = (t.match(/[가-힯]/g) || []).length;
        const latin = (t.match(/[A-Za-z]/g) || []).length;
        if (kana >= 5 && kana * 5 >= han) return 'ja';
        if (hangul >= 5 && hangul >= han) return 'ko';
        if (latin >= 40 && latin > han * 3) return 'latin';
        if (han >= 5) return 'zh';
        return '';
    }

    languageHintBlock(text) {
        const script = this.noteScript(text);
        if (!script) return '';
        const zh = { ja: '日文', ko: '韩文', latin: '英文等拉丁字母文字', zh: '中文' }[script];
        const en = { ja: 'Japanese', ko: 'Korean', latin: 'English or another Latin-script language', zh: 'Chinese' }[script];
        return tr(`\n\n**语言:** 这篇笔记主要是${zh}。标题、摘要和一句话总结用笔记原文的语言写，不要翻译成别的语言。`, `\n\n**Language:** this note is mainly ${en}. Write the title, summary and one-line summary in the note's own language; do not translate.`);
    }

    // 标题按内容定主题：人名、日期本身是主题时照写，只是罗列参会人或日期时不行
    titleHintBlock() {
        return tr(`\n\n**标题:** 先读完内容，判断这篇主要讲什么，再定标题：只看标题就该知道主题、结论或要做的事。人名、日期是主题的一部分时照常写进标题（比如写某个人的笔记）；只把参会人、日期、星期拼在一起、看不出内容的标题不行。`, `\n\n**Title:** read the whole note and decide what it is mainly about before writing the title; the title alone should tell the topic, the conclusion or the action. Keep names and dates when they are part of the topic (a note about a person, say); a title that only strings together attendees, dates or weekdays and says nothing about the content is not acceptable.`);
    }

    // 手账写法：设置里列出能用的纸片和标注，整理正文时只许用这些
    notebookMarks() {
        const lines = String(this.settings.structurizerMarks || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return null;
        const callouts = new Set(), spans = new Set();
        for (const line of lines) {
            for (const m of line.matchAll(/\[!([\w-]+)\]/g)) callouts.add(m[1].toLowerCase());
            for (const m of line.matchAll(/class="([^"]+)"/g)) spans.add(m[1].trim());
        }
        // 清单里写着“取自属性”的标注（邮戳、条码这类），内容必须真在属性里
        const fromProps = new Set();
        for (const line of lines) for (const m of line.matchAll(/<span class="([^"]+)">(.*?)<\/span>/g)) {
            if (/属性|propert/i.test(line.slice(m.index + m[0].length))) fromProps.add(m[1].trim());
        }
        return { lines, callouts, spans, fromProps, max: Math.max(1, Number(this.settings.structurizerMaxCards) || 4) };
    }

    notebookPromptBlock(fm = {}) {
        const marks = this.notebookMarks();
        if (!marks) return '';
        const condense = this.condenseOverride ?? this.settings.structurizerCondense;
        const facts = Object.entries(fm || {}).filter(([k, v]) => !['summary', 'tldr', 'tags', 'position'].includes(k) && ['string', 'number'].includes(typeof v) && String(v).length <= 120).map(([k, v]) => `${k}: ${v}`);
        return tr(`\n\n**手账写法（只用下面这些）:**\n- 只能用清单里的写法，不要造新的纸片类型或类名。\n- 一篇最多 ${marks.max} 张纸片（> [!…]）。内容本来就是结论、原话金句、步骤、时间安排、对话或待办的，就放进对应的纸片；不是的不硬套。\n${condense ? '- 原话一个字不改，只挪位置、加小标题、包进纸片。只有时间线和对话纸片里，可以把一段原话压成一行，保留原来的关键词；压进纸片的段落不要再在正文里写一遍。\n' : '- 原话一个字不改，只挪位置、加小标题、包进纸片；时间线、对话里的每一行也用原话，不要缩写。\n'}- 原文已有的 <span class=…> 标注和纸片原样保留。\n- 不加圈重点、批注、贴纸这类表达个人判断的标注。\n- 正文不要重复属性里已有的标题、摘要和标签。\n- 频道、日期、链接这类信息只用下面属性里有的，没有就不放。\n\n清单：\n${marks.lines.join('\n')}${facts.length ? `\n\n属性：\n${facts.join('\n')}` : ''}`,
            `\n\n**Notebook marks (use only these):**\n- Use only the marks listed; do not invent callout types or class names.\n- At most ${marks.max} cards (> [!…]) per note. Put conclusions, memorable quotes, steps, schedules, conversations and to-dos into their card; do not force anything else into one.\n${condense ? '- Keep the original wording; only move it, add subheadings and wrap it in cards. Only inside timeline and chat cards may a passage be condensed to one line, keeping its key words; do not repeat a condensed passage elsewhere in the text.\n' : '- Keep the original wording; only move it, add subheadings and wrap it in cards. Timeline and chat lines use the original words too; do not shorten them.\n'}- Keep every <span class=…> mark and card already in the text as it is.\n- Do not add circles, margin notes or stickers; those carry the writer's own judgement.\n- Do not repeat the title, summary or tags that are already in the properties.\n- Take channel, date or link details only from the properties below; leave them out if missing.\n\nList:\n${marks.lines.join('\n')}${facts.length ? `\n\nProperties:\n${facts.join('\n')}` : ''}`);
    }

    // 模型给回来的正文按清单把关：清单外的纸片和类名去掉，超出张数的拆回普通引用，去掉和属性重复的行，数一数原话有没有被改
    cleanNotebookMarks(text, originalBody = '', fm = {}) {
        const marks = this.notebookMarks();
        const stats = { cards: 0, removed: 0, dupLines: 0, changed: 0 };
        if (!marks) return { text, stats };
        const original = String(originalBody || '');
        const had = new Set([...original.matchAll(/\[!([\w-]+)\]/g)].map(m => m[1].toLowerCase()));
        const hadSpan = new Set([...original.matchAll(/<span class="([^"]*)">/g)].map(m => m[1]));
        const dupKeys = ['tldr', 'summary', 'tags'].filter(k => fm && fm[k] !== undefined && fm[k] !== null && fm[k] !== '');
        if (dupKeys.includes('tags')) dupKeys.push('标签');
        const dupRe = dupKeys.length ? new RegExp(`^\\s*\\**\\s*(?:${dupKeys.join('|')})\\s*\\**\\s*[:：]`, 'i') : null;
        // 模型有时会在正文前面再抄一份属性，原文正文没有的话就去掉
        let source = String(text);
        if (!/^\s*---\r?\n/.test(original) && /^\s*---\r?\n/.test(source)) {
            const lines = source.replace(/^\s*---\r?\n/, '').split('\n');
            let i = 0;
            while (i < lines.length && /^([\w\u4e00-\u9fff-]+\s*:|\s+-\s|\s*$)/.test(lines[i]) && !/^\s*$/.test(lines[i] || 'x') ) i++;
            if (lines[i]?.trim() === '---') i++;
            source = lines.slice(i).join('\n');
        }
        // 也会把提示词里给的“属性：”几行原样抄在开头，去掉
        const factLines = new Set(Object.entries(fm || {}).filter(([, v]) => ['string', 'number'].includes(typeof v)).map(([k, v]) => `${k}: ${v}`));
        const head = source.split('\n');
        let skip = 0;
        while (skip < head.length && (factLines.has(head[skip].trim()) || /^(属性|Properties)[:：]?$/.test(head[skip].trim()) || (!head[skip].trim() && skip > 0 && factLines.has(head[skip - 1].trim())))) skip++;
        if (skip) source = head.slice(skip).join('\n');
        const propValues = new Set(Object.entries(fm || {}).filter(([k]) => !['title', 'summary', 'tldr', 'tags', 'position'].includes(k)).flatMap(([, v]) => Array.isArray(v) ? v : [v]).map(v => String(v).trim()).filter(Boolean));
        const out = [];
        for (let line of source.split('\n')) {
            if (dupRe && dupRe.test(line)) { stats.dupLines++; continue; }
            const head = line.match(/^(\s*>\s*)\[!([\w-]+)\]([+-]?)\s*(.*)$/);
            if (head && !/^\s*>\s*>/.test(line)) {
                const type = head[2].toLowerCase();
                const allowed = marks.callouts.has(type) || had.has(type);
                if (allowed && stats.cards < marks.max) stats.cards++;
                else { stats.removed++; line = head[4] ? `${head[1]}**${head[4]}**` : head[1].trimEnd(); }
            }
            line = line.replace(/<span class="([^"]*)">(.*?)<\/span>/g, (all, cls, inner) => {
                if (hadSpan.has(cls)) return all;
                if (!marks.spans.has(cls)) { stats.removed++; return inner; }
                const parts = inner.split(/<br\s*\/?>|\s+·\s+/).map(t => t.trim()).filter(Boolean);
                const made = marks.fromProps.has(cls) && !parts.every(t => propValues.has(t));
                if (made) { stats.removed++; return ''; }
                return all;
            });
            if (!line.trim() && out.length && !out.at(-1).trim()) continue;
            out.push(line);
        }
        let cleaned = out.join('\n');
        // 原文里没有的视频、图片和链接一律去掉：模型会编出不存在的视频地址
        const knownUrls = new Set((original.match(/https?:\/\/[^\s"'<>)\]]+/g) || []));
        const known = url => knownUrls.has(url);
        cleaned = cleaned
            .replace(/<iframe\b[^>]*src="([^"]+)"[^>]*>(?:\s*<\/iframe>)?/gi, (all, url) => known(url) ? all : (stats.removed++, ''))
            .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/g, (all, alt, url) => known(url) ? all : (stats.removed++, ''))
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)[^)]*\)/g, (all, text, url) => known(url) ? all : (stats.removed++, text))
            .replace(/\n{3,}/g, '\n\n');
        // 原文开头那行副题之类的标注被模型丢了，放回去
        const lead = original.split('\n').find(l => l.trim());
        if (lead && /^\s*<span class="[^"]*">.*<\/span>\s*$/.test(lead) && !cleaned.includes(lead.trim())) cleaned = `${lead.trim()}\n\n${cleaned.replace(/^\s+/, '')}`;
        // 原话检查：去掉标点、符号和空白后，原文里每一句（8 个字以上）都应该还能在新正文里找到
        const flat = t => String(t).replace(/<[^>]+>|\[![\w-]+\][+-]?|[#>*_`~\-|[\]()!=\s，。、；：“”‘’"'（）,.;:]/g, '');
        const body = flat(cleaned);
        const sentences = original.split('\n').filter(l => !(dupRe && dupRe.test(l))).join('\n').split(/[。！？!?\n]|\.\s/).map(flat).filter(t => t.length >= 8);
        stats.changed = sentences.filter(t => !body.includes(t)).length;
        return { text: cleaned, stats };
    }

    getMoverPrompt(folderPaths, content) {
        return this.promptSetting('moverPrompt')
            .replace('{{folder_list}}', JSON.stringify(folderPaths, null, 2))
            .replace('{{content}}', content)
            .replace('{{count}}', this.settings.moverSuggestionsCount) + this.vaultRulesBlock();
    }

    getTranslationPrompt(phrases) {
        return this.promptSetting('translationPrompt')
            .replace('{{target_language}}', this.settings.taggerTranslationTargetLanguage)
            .replace('{{phrases_to_translate}}', phrases.join('\n'));
    }

    getStructurizerPrompt(contentToProcess, fm = {}) {
        return this.promptSetting('structurizerPrompt').replace('{{content}}', contentToProcess) + this.vaultRulesBlock(true) + this.notebookPromptBlock(fm) + this.userInstructionBlock();
    }

    getFuriganaPrompt(contentToProcess) {
        return this.promptSetting('furiganaPrompt').replace('{{content}}', contentToProcess);
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
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
            return;
        }

        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile) {
            new Notice(tr("没有活动的笔记文件。", 'No active note.'));
            return;
        }

        let progressNotice = new Notice(tr(`正在执行${this.getActionName(action)}...`, `Running ${this.getActionName(action)}…`), 0);

        try {
            // 获取内容
            let content = "";
            const activeEditor = this.app.workspace.activeEditor?.editor;
            if (activeEditor) {
                const selection = activeEditor.getSelection();
                if (selection && selection.trim()) {
                    content = selection.trim();
                    new Notice(tr(`使用选中文本进行${this.getActionName(action)}...`, `Running ${this.getActionName(action)} on the selection…`));
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
                throw new Error(tr("没有内容可以处理。", 'Nothing to process.'));
            }

            // 构建提示词
            const prompt = this.getSmartActionPrompt(action, content);

            // 调用AI
            progressNotice.setMessage(tr(`正在执行AI${this.getActionName(action)}...`, `Running AI ${this.getActionName(action)}…`));

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
                title: tr(`${this.getActionIcon(action)} ${this.getActionName(action)}结果`, `${this.getActionIcon(action)} ${this.getActionName(action)} result`),
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
            new Notice(tr(`${this.getActionName(action)}失败：${this.failureText(error)}`, `${this.getActionName(action)} failed: ${this.failureText(error)}`), 0);
            console.error("Smart Action Error:", error);
        }
    }

    // 获取操作名称
    getActionName(action) {
        const actionNames = {
            'summarize': tr('总结', 'Summarise'),
            'optimize': tr('优化', 'Improve'),
            'explain': tr('解释', 'Explain'),
            'analyze': tr('分析', 'Analyse')
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
            'summarize': tr(`请对以下内容进行智能总结。根据内容类型和长度，自动调整总结的详细程度和结构：

${content}`, `Summarise the content below. Adjust the detail and structure of the summary to the kind and length of the content:

${content}`),

            'optimize': tr(`请优化以下内容的表达方式，使其更加清晰、准确和易读。保持原意不变，提升表达质量：

${content}`, `Improve how the content below is written so it is clearer, more precise and easier to read. Keep the meaning unchanged:

${content}`),

            'explain': tr(`请详细解释以下内容，包括背景、含义、相关概念和实际应用。根据内容复杂度调整解释深度：

${content}`, `Explain the content below in detail: background, meaning, related concepts and practical use. Adjust the depth to how complex it is:

${content}`),

            'analyze': tr(`请对以下内容进行综合分析，包括主要观点、逻辑结构、优缺点和改进建议：

${content}`, `Analyse the content below as a whole: main points, logical structure, strengths and weaknesses, and suggestions for improvement:

${content}`)
        };

        return prompts[action] || tr(`请处理以下内容：\n\n${content}`, `Process the content below:\n\n${content}`);
    }

    registerCustomActionCommands() {
        (this.settings.customActions || []).forEach(action => {
            if (action.enabled === false || !action.id) return;
            this.addCommand({
                id: `run-custom-action-${this.toCommandId(action.id)}`,
                name: `${tr('自定义动作', 'Custom action')}: ${action.name || tr('未命名', 'untitled')}`,
                callback: () => this.runCustomAction(action.id)
            });
        });
    }

    toCommandId(value) {
        return String(value || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    getCustomActionModeLabel(mode) {
        const labels = {
            sidebar: tr('显示到侧边栏', 'Show in sidebar'),
            diff: tr('生成变更预览', 'Generate change preview'),
            append: tr('追加到当前笔记', 'Append to current note'),
            'new-note': tr('创建新笔记', 'Create new note')
        };
        return labels[mode] || labels.sidebar;
    }

    async getCurrentActionContext(targetFile = null) {
        const currentFile = targetFile || this.app.workspace.getActiveFile() || this.assistantLastFile;
        if (!currentFile) {
            throw new Error(tr('没有活动的笔记文件。', 'No active note.'));
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
        return String(template || tr('请处理以下内容：\n\n{{content}}', 'Process the content below:\n\n{{content}}'))
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
            new Notice(tr('未找到启用的自定义动作。', 'No enabled custom action found.'), 3000);
            return;
        }
        const hasEnabledConfig = this.settings.apiConfigs && this.settings.apiConfigs.some(c => c.enabled !== false && this.isConfigUsable(c));
        if (!hasEnabledConfig) {
            new Notice(tr('请先在插件设置里添加并启用至少一个 AI 配置。', 'Add and enable at least one AI configuration in plugin settings first.'));
            return;
        }

        const taskId = `custom-action-${Date.now()}`;
        let progressNotice = new Notice(tr(`正在执行 ${action.name || '自定义动作'}...`, `Running ${action.name || 'custom action'}…`), 0);

        try {
            const context = await this.getCurrentActionContext(targetFile);
            const prompt = this.renderCustomPrompt(action.prompt, context);
            if (!prompt.trim()) {
                throw new Error(tr('自定义 Action 的 Prompt 为空。', 'The custom action prompt is empty.'));
            }

            await this.activateView();
            this.view.addTask({
                id: taskId,
                type: 'custom-action',
                status: 'loading',
                title: tr(`${action.name || '自定义动作'} 生成中`, `${action.name || 'Custom action'} generating`),
                message: tr('正在接收 AI 输出...', 'Receiving AI output…'),
                content: { file: context.file, streamingContent: '' }
            });

            const result = await this.makeApiRequest(prompt, this.getAuxiliaryModelName(), false, null, {
                label: action.name || tr('自定义动作', 'Custom action'),
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
                    action: action.name || tr('自定义动作', 'Custom action'),
                    title: tr(`${action.name || '自定义动作'} 预览: ${context.file.basename}`, `${action.name || 'Custom action'} preview: ${context.file.basename}`),
                    originalContent: context.originalContent,
                    proposedContent: this.buildReplacementContent(context, result)
                });
                new Notice(tr('自定义动作 预览已生成，请在侧栏确认后应用。', 'Custom action preview ready. Confirm it in the sidebar to apply.'), 5000);
                return;
            }

            if (outputMode === 'append') {
                await this.applyContentChange(context.file, action.name || tr('自定义动作追加', 'Custom action append'), null,
                    current => `${current}${current.endsWith('\n') ? '\n' : '\n\n'}${result.trim()}\n`);
                this.addToHistory(context.file.basename, context.file.path, action.name || tr('自定义动作', 'Custom action'), this.generateFileId(context.file));
                this.view.updateTask(taskId, {
                    type: 'success',
                    status: 'displaying',
                    title: tr(`${action.name || '自定义动作'} 已追加`, `${action.name || 'Custom action'} appended`),
                    content: { message: tr('结果已追加到当前笔记，可用回滚恢复。', 'The result was appended to the current note; undo restores it.'), type: 'success', file: context.file }
                });
                new Notice(tr('自定义动作 结果已追加。', 'Custom action result appended.'), 4000);
                return;
            }

            if (outputMode === 'new-note') {
                const folderPath = context.file.parent?.path || '';
                const newPath = await this.createUniqueMarkdownPath(folderPath, `${context.file.basename} - ${action.name || 'AI Result'}`);
                const newFile = await this.app.vault.create(newPath, result.trim() + '\n');
                this.view.updateTask(taskId, {
                    type: 'success',
                    status: 'displaying',
                    title: tr(`${action.name || '自定义动作'} 已创建新笔记`, `${action.name || 'Custom action'} created a note`),
                    content: { message: tr(`已创建: ${newPath}`, `Created: ${newPath}`), type: 'success', file: newFile }
                });
                new Notice(tr(`已创建新笔记: ${newPath}`, `Created note: ${newPath}`), 5000);
                return;
            }

            this.view.updateTask(taskId, {
                type: 'custom-action',
                status: 'displaying',
                title: tr(`${action.name || '自定义动作'} 结果`, `${action.name || 'Custom action'} result`),
                content: {
                    file: context.file,
                    result,
                    originalContent: (context.selection || context.content).substring(0, 500)
                }
            });
            this.addToHistory(context.file.basename, context.file.path, action.name || tr('自定义动作', 'Custom action'), this.generateFileId(context.file));
        } catch (error) {
            progressNotice?.hide();
            if (this.isCancellationError(error)) {
                this.view?.removeTask(taskId);
                return;
            }
            this.view?.updateTask(taskId, {
                type: 'error',
                status: 'displaying',
                title: tr(`${action.name || '自定义动作'} 失败`, `${action.name || 'Custom action'} failed`),
                content: { message: error.message, type: 'error' }
            });
            new Notice(tr(`自定义动作失败：${this.failureText(error)}`, `Custom action failed: ${this.failureText(error)}`), 5000);
            console.error('Custom Action Error:', error);
        }
    }







    async loadSettings() {
        const stored = await this.loadData() || {};
        this.settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), stored);
        if (!Array.isArray(stored.apiConfigs)) delete this.settings.apiConfigs;
        const upgraded = this.migrateLegacySettings();
        const firstRun = !Array.isArray(this.settings.apiConfigs);
        const reshaped = Array.isArray(stored.apiConfigs) && stored.apiConfigs.some(c => c && !c.ai);
        this.normalizeSettings();
        // 从没配过：用钥匙串里已经有的那家；只读名字，不联网
        if (firstRun) this.settings.apiConfigs[0].ai = this.firstRunSlot();
        const migrated = await this.moveKeysToSecretStorage();
        if (migrated || upgraded || reshaped) {
            await this.saveSettings();
        }
    }

    async saveSettings() {
        if (this.aiCache) this.settings.modelCache = this.aiCache.toJSON();
        await this.saveData(this.settings);
    }





    // 导出处理结果
    async exportProcessingResults() {
        if (!this.view || !this.view.history || this.view.history.length === 0) {
            new Notice(tr('没有可导出的处理结果', 'No results to export'));
            return;
        }

        const exportData = {
            exportTime: new Date().toISOString(),
            version: this.manifest.version,
            history: this.view.history,
            settings: {
                modelName: this.getActiveApiConfig()?.ai?.model,
                auxiliaryModelName: this.getAuxiliaryModelName()
            }
        };

        const exportContent = JSON.stringify(exportData, null, 2);
        const fileName = `ai-assistant-export-${new Date().toISOString().split('T')[0]}.json`;

        try {
            await this.app.vault.create(fileName, exportContent);
            new Notice(tr(`处理结果已导出到 ${fileName}`, `Results exported to ${fileName}`));
        } catch (error) {
            new Notice(tr(`导出失败: ${error.message}`, `Export failed: ${error.message}`));
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
                title: tr('📊 性能监控', 'Performance'),
                content: { stats }
            });
        }
    }


}

export default AiAssistantSuite;
