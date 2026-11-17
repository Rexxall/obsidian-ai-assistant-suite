import { Notice, PluginSettingTab, SettingPage, Setting, setIcon } from 'obsidian';
import { renderAiSettings } from './vendor/rex-ai-kit/settingsUI';
import { DEFAULT_SETTINGS, aiLang, confirmAction, defaultModelOf, providerLabel, providerOf, slotOf, tr } from './shared';
import { PromptEditModal } from './modals';

// 给每组最后一行加 .ap-group-end，让它圆角收尾；CSS 不用 :has 就看不到“下一行是标题或说明”。分页局部重画时也跟着更新。
export function watchSettingGroupEnds(rootEl) {
    const mark = () => {
        for (const item of Array.from(rootEl.querySelectorAll('.setting-item:not(.setting-item-heading)'))) {
            const next = item.nextElementSibling;
            item.toggleClass('ap-group-end', !next || next.classList.contains('setting-item-heading') || !next.classList.contains('setting-item'));
        }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(rootEl, { childList: true, subtree: true });
    return observer;
}

export class AiAssistantSettingTab extends PluginSettingTab {
    plugin;

    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.containerEl.addClass('ap', 'ap-settings', 'assistant-settings-morning');
    }

    addSectionHeading(containerEl, name) {
        const heading = new Setting(containerEl).setName(name).setHeading();
        heading.settingEl.addClass('ai-assistant-settings-section');
        return heading;
    }

    // Obsidian 1.13 起设置页由定义渲染：四个分页各是一个 SettingPage，内容沿用下面的渲染代码
    static PAGES = [
        { name: tr('模型连接', 'Connections'), aliases: ['API', tr('密钥', 'Key'), tr('模型', 'Model'), tr('备用', 'Backup'), 'DeepSeek', 'Gemini', 'OpenAI', 'Ollama'] },
        { name: tr('处理偏好', 'Preferences'), aliases: [tr('标签', 'Tags'), tr('归档', 'Folder'), tr('忽略文件夹', 'Ignored folders'), tr('翻译', 'Translation')] },
        { name: tr('动作与提示词', 'Actions and prompts'), aliases: [tr('自定义动作', 'Custom actions'), tr('提示词', 'Prompts')] },
        { name: tr('备份与恢复', 'Backup and restore'), aliases: [tr('导出', 'Export'), tr('导入', 'Import'), tr('重置', 'Reset')] }
    ];

    getSettingDefinitions() {
        return AiAssistantSettingTab.PAGES.map((page, index) => ({
            type: 'page',
            name: page.name,
            aliases: page.aliases,
            page: () => this.createPage(index, page.name)
        }));
    }

    createPage(index, title) {
        class AssistantSettingsPage extends SettingPage {
            constructor(owner) {
                super();
                this.owner = owner;
                this.title = title;
            }
            display() {
                this.owner.currentPage = this;
                this.owner.renderPage(this.containerEl, index);
            }
        }
        return new AssistantSettingsPage(this);
    }

    // 改了会影响页面结构的设置后，重画当前分页
    refresh() {
        this.currentPage?.display();
    }

    hide() {
        this.groupEndObserver?.disconnect();
        this.groupEndObserver = null;
        this.aiUi?.destroy();
        this.aiUi = null;
        super.hide();
    }

    renderPage(containerEl, index) {
        containerEl.empty();
        containerEl.addClass('ap', 'ap-settings', 'plugin-settings-workspace', 'assistant-settings-morning');
        this.renderSettingsBody(containerEl);
        const isSection = el => el.classList?.contains('ai-assistant-settings-section');
        let page = -1, section = -1;
        for (const el of Array.from(containerEl.children)) {
            if (isSection(el)) {
                section += 1;
                page = section === 0 ? 0 : section <= 2 ? 1 : section <= 4 ? 2 : 3;
            }
            if (page !== index) el.remove();
        }
        // 分页标题后面紧跟另一个标题时，它没有自己的内容，去掉
        for (const el of Array.from(containerEl.children)) {
            if (isSection(el) && el.nextElementSibling?.classList.contains('setting-item-heading')) el.remove();
        }
        this.groupEndObserver?.disconnect();
        this.groupEndObserver = watchSettingGroupEnds(containerEl);
    }

    renderSettingsBody(containerEl) {
        // 上一次画的 AI 设置组：取消它还在跑的检查
        this.aiUi?.destroy();
        this.aiUi = null;
        this.addSectionHeading(containerEl, tr('连接你的模型', 'Connect your model'));

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
        topContainer.addClass('ai-assistant-u-top-row');
        
        new Setting(topContainer)
            .setName(tr('编辑配置', 'Edit configuration'))
            .addDropdown(dropdown => {
                apiConfigs.forEach(config => {
                    const name = this.plugin.configLabel(config);
                    const label = config.enabled === false ? tr(`[禁用] ${name}`, `[off] ${name}`) : name;
                    dropdown.addOption(config.id, label);
                });
                dropdown.setValue(activeConfig?.id ?? '');
                dropdown.onChange(async (value) => {
                    this.plugin.settings.activeConfigId = value;
                    await this.plugin.saveSettings();
                    this.refresh();
                });
            });

        const actionsContainer = new Setting(topContainer).setClass('ai-assistant-config-actions').controlEl;
        const addButton = actionsContainer.createEl('button', { text: tr('新增配置', 'Add configuration') });
        addButton.onclick = async () => {
            const newId = 'config_' + Date.now();
            this.plugin.settings.apiConfigs.push({
                id: newId,
                name: '',
                ai: this.plugin.firstRunSlot(),
                auxiliaryModelName: '',
                deepseekThinking: false,
                enabled: true,
                allowFallback: false
            });
            this.plugin.settings.activeConfigId = newId;
            await this.plugin.saveSettings();
            this.refresh();
        };

        const delButton = actionsContainer.createEl('button', { text: tr('删除当前配置', 'Delete this configuration') });
        if (apiConfigs.length <= 1) {
            delButton.disabled = true;
        } else {
            delButton.onclick = async () => {
                this.plugin.settings.apiConfigs = apiConfigs.filter(c => c !== activeConfig);
                this.plugin.settings.activeConfigId = this.plugin.settings.apiConfigs[0].id;
                await this.plugin.saveSettings();
                this.refresh();
            };
        }

        // 优先级调整按钮
        const currentIdx = apiConfigs.indexOf(activeConfig);
        const upBtn = actionsContainer.createEl('button', { text: tr('↑ 提高优先级', '↑ Raise priority') });
        upBtn.disabled = currentIdx <= 0;
        upBtn.onclick = async () => {
            if (currentIdx <= 0) return;
            const tmp = apiConfigs[currentIdx - 1];
            apiConfigs[currentIdx - 1] = apiConfigs[currentIdx];
            apiConfigs[currentIdx] = tmp;
            await this.plugin.saveSettings();
            this.refresh();
        };

        const downBtn = actionsContainer.createEl('button', { text: tr('↓ 降低优先级', '↓ Lower priority') });
        downBtn.disabled = currentIdx >= apiConfigs.length - 1;
        downBtn.onclick = async () => {
            if (currentIdx >= apiConfigs.length - 1) return;
            const tmp = apiConfigs[currentIdx + 1];
            apiConfigs[currentIdx + 1] = apiConfigs[currentIdx];
            apiConfigs[currentIdx] = tmp;
            await this.plugin.saveSettings();
            this.refresh();
        };
        
        if (!activeConfig) return;

        // 显示当前配置的优先级
        const priorityIdx = apiConfigs.indexOf(activeConfig);
        const enabledCount = apiConfigs.filter(c => c.enabled !== false).length;
        containerEl.createEl('p', {
            text: tr(`优先级 #${priorityIdx + 1}（共 ${apiConfigs.length} 个配置，其中 ${enabledCount} 个已启用）`, `Priority #${priorityIdx + 1} (${apiConfigs.length} configurations, ${enabledCount} enabled)`),
            cls: 'ai-assistant-settings-accent-note'
        });

        new Setting(containerEl)
            .setName(tr('启用此配置', 'Enable this configuration'))
            .addToggle(toggle => toggle
                .setValue(activeConfig.enabled !== false)
                .onChange(async (value) => {
                    activeConfig.enabled = value;
                    await this.plugin.saveSettings();
                    this.refresh();
                }));

        new Setting(containerEl)
            .setName(tr('允许用作备用', 'Allow as backup'))
            .setDesc(tr('主服务失败时可以改用它。不勾就不会把笔记发给它；没有备用时，失败就停下。', 'Used if the main service fails. Untick it and notes are never sent to it; with no backups, a failure stops.'))
            .addToggle(toggle => toggle
                .setValue(activeConfig.allowFallback === true)
                .onChange(async (value) => {
                    activeConfig.allowFallback = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('配置名称', 'Configuration name'))
            .addText(text => text
                .setPlaceholder(providerLabel(activeConfig))
                .setValue(activeConfig.name || '')
                .onChange(async (value) => {
                    activeConfig.name = value.trim();
                    await this.plugin.saveSettings();
                }));

        // 服务商、密钥、模型和地址：各插件共用的设置组（rex-ai-kit）。打开设置不联网，点“检查”或“刷新”才请求
        const providerBefore = slotOf(activeConfig).provider;
        this.aiUi = renderAiSettings(containerEl, {
            app: this.app,
            client: this.plugin.aiClient(),
            slot: slotOf(activeConfig),
            scene: 'cheap',
            lang: aiLang(),
            heading: false,
            privateContent: true,
            allowLocalAgents: true,
            onChange: async (slot) => {
                activeConfig.ai = { ...slot };
                await this.plugin.saveSettings();
                // 换了服务商，下面跟服务商有关的行（深度思考）要重画
                if (slot.provider !== providerBefore) this.refresh();
            },
        });
        const provider = providerOf(activeConfig);

        new Setting(containerEl)
            .setName(tr('辅助模型', 'Helper model'))
            .setDesc(tr('翻译标签这类轻活用它；留空就用主模型。', 'Used for light jobs such as translating tags. Leave empty to use the main model.'))
            .addText(text => text
                .setPlaceholder(slotOf(activeConfig).model || defaultModelOf(provider.id))
                .setValue(activeConfig.auxiliaryModelName || '')
                .onChange(async (value) => {
                    activeConfig.auxiliaryModelName = value.trim();
                    await this.plugin.saveSettings();
                }));

        if (provider.id === 'deepseek') {
            new Setting(containerEl).setName(tr('深度思考', 'Deep thinking'))
                .setDesc(tr('复杂内容效果更好，但要等更久。', 'Better for complex content, but slower.'))
                .addToggle(toggle => toggle.setValue(!!activeConfig.deepseekThinking).onChange(async value => {
                    activeConfig.deepseekThinking = value; await this.plugin.saveSettings();
                }));
        }

        let connectionStatus;
        new Setting(containerEl)
            .setName(tr('测试连接', 'Test connection'))
            .setDesc(provider.group === 'local' && !provider.localAgent
                ? tr('发一句很短的话给本地模型，看它能不能回答。不读笔记，不收费。', 'Sends one short line to the local model to see if it answers. No notes are read; free.')
                : tr('发一句很短的话，只要求很短的回答，看能不能连通。不读笔记；按服务商价格计费，一般不到一分钱。', 'Sends one short line and asks for a very short answer to check the connection. No notes are read; billed at the provider\'s price, usually a tiny fraction of a cent.'))
            .addButton(button => button.setButtonText(tr('测试', 'Test')).onClick(async () => {
                button.setButtonText(tr('正在测试…', 'Testing…')).setDisabled(true);
                connectionStatus.empty();
                connectionStatus.setText(tr('正在连接…', 'Connecting…'));
                try {
                    const result = await this.plugin.validateApiConfig(activeConfig);
                    connectionStatus.empty();
                    connectionStatus.toggleClass('is-error', !result.valid);
                    const checks = connectionStatus.createDiv({ cls: 'ai-assistant-connection-checks' });
                    for (const check of result.checks || []) {
                        const row = checks.createSpan({ cls: `ai-assistant-connection-check is-${check.state}` });
                        setIcon(row.createSpan({ cls: 'ai-assistant-connection-check-icon' }), check.state === 'ok' ? 'check' : check.state === 'fail' ? 'x' : 'minus');
                        row.createSpan({ text: check.label });
                        row.setAttr('aria-label', `${check.label}: ${check.state === 'ok' ? tr('通过', 'passed') : check.state === 'fail' ? tr('出错', 'failed') : tr('未检查', 'not checked')}`);
                    }
                    const line = connectionStatus.createDiv();
                    if (result.valid) {
                        line.setText(tr('连接成功，可以开始整理笔记。', 'Connected. You can start tidying notes.'));
                    } else {
                        line.createEl('strong', { text: result.message });
                        line.createSpan({ text: ` ${result.next}` });
                        if (result.keyPage) line.createEl('a', { text: ` ${tr('打开服务商后台', 'Open provider console')}`, href: result.keyPage });
                    }
                } finally {
                    button.setButtonText(tr('测试', 'Test')).setDisabled(false);
                }
            }))
            .addButton(button => button.setButtonText(tr('复制诊断信息', 'Copy diagnostics')).onClick(async () => {
                await navigator.clipboard.writeText(this.plugin.buildDiagnostics());
                new Notice(tr('诊断信息已复制，里面没有密钥和笔记内容。', 'Diagnostics copied. They contain no key and no note text.'));
            }));
        connectionStatus = containerEl.createEl('div', { cls: 'atelier-connection-status', attr: { role: 'status', 'aria-live': 'polite' } });

        this.addSectionHeading(containerEl, tr('功能参数设置', 'Action settings'));

        // -- Mover --
        new Setting(containerEl).setName(tr('文件夹建议', 'Folder suggestions')).setHeading();
        new Setting(containerEl)
            .setName(tr('建议数量', 'Number of suggestions'))
            .addText(text => text
                .setPlaceholder('4')
                .setValue(this.plugin.settings.moverSuggestionsCount)
                .onChange(async (value) => {
                    this.plugin.settings.moverSuggestionsCount = parseInt(value, 10) || 4;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('忽略的文件夹', 'Ignored folders'))
            .setDesc(tr('包括子文件夹。每行一个路径。', 'Subfolders included. One path per line.'))
            .addTextArea(text => text
                .setPlaceholder(tr('例如：\n40 - Obsidian\ntemplates\nattachments', 'For example:\n40 - Obsidian\ntemplates\nattachments'))
                .setValue(this.plugin.settings.ignoredFolders)
                .onChange(async (value) => {
                    this.plugin.settings.ignoredFolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('只用现有文件夹', 'Existing folders only'))
            .setDesc(tr('不建议新建文件夹；模型给出的新路径会被去掉。', 'No new folders are suggested; new paths from the model are dropped.'))
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.moverExistingOnly)
                .onChange(async (value) => {
                    this.plugin.settings.moverExistingOnly = value;
                    await this.plugin.saveSettings();
                }));

        // -- Tagger --
        new Setting(containerEl).setName(tr('标签建议', 'Tag suggestions')).setHeading();
        new Setting(containerEl)
            .setName(tr('建议数量', 'Number of suggestions'))
            .addText(text => text
                .setPlaceholder('12')
                .setValue(this.plugin.settings.taggerSuggestionsCount)
                .onChange(async (value) => {
                    this.plugin.settings.taggerSuggestionsCount = parseInt(value, 10) || 12;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('只用现有标签', 'Existing tags only'))
            .setDesc(tr('结果会再按现有标签过滤一遍，不会出现新标签。', 'Results are filtered again, so no new tag appears.'))
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.taggerExistingOnly)
                .onChange(async (value) => {
                    this.plugin.settings.taggerExistingOnly = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('允许的标签根', 'Allowed tag roots'))
            .setDesc(tr('每行一个。不以这些根开头的标签不会出现；留空不限。', 'One per line. Tags outside these roots are dropped; leave empty for no limit.'))
            .addTextArea(text => text
                .setPlaceholder(tr('例如：\nC\nP\nType', 'For example:\nC\nP\nType'))
                .setValue(this.plugin.settings.taggerAllowedRoots || '')
                .onChange(async (value) => {
                    this.plugin.settings.taggerAllowedRoots = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('父子标签只留子标签', 'Keep only the child tag'))
            .setDesc(tr('已有或建议了 a/b/c，就不再建议 a/b。', 'If a/b/c is present or suggested, a/b is not suggested.'))
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.taggerDropParentTags)
                .onChange(async (value) => {
                    this.plugin.settings.taggerDropParentTags = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('翻译长英文标签', 'Translate long English tags'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.taggerEnableTranslation)
                .onChange(async (value) => {
                    this.plugin.settings.taggerEnableTranslation = value;
                    await this.plugin.saveSettings();
                    this.refresh(); // Refresh to show/hide related settings
                }));

        if (this.plugin.settings.taggerEnableTranslation) {
            new Setting(containerEl)
                .setName(tr('触发翻译的最小长度', 'Minimum length to translate'))
                .addText(text => text
                    .setPlaceholder('16')
                    .setValue(this.plugin.settings.taggerTranslationMinLength)
                    .onChange(async (value) => {
                        this.plugin.settings.taggerTranslationMinLength = parseInt(value, 10) || 16;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName(tr('目标翻译语言', 'Target language'))
                .addText(text => text
                    .setPlaceholder(tr('中文', 'Chinese'))
                    .setValue(this.plugin.settings.taggerTranslationTargetLanguage)
                    .onChange(async (value) => {
                        this.plugin.settings.taggerTranslationTargetLanguage = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // -- Meta --
        new Setting(containerEl).setName(tr('属性生成', 'Properties')).setHeading();
        new Setting(containerEl)
            .setName(tr('文件名最大长度', 'Maximum file name length'))
            .setDesc(tr('按生成的标题重命名时使用。', 'Used when renaming to the generated title.'))
            .addText(text => text
                .setPlaceholder('100')
                .setValue(this.plugin.settings.metaFileNameMaxLength)
                .onChange(async (value) => {
                    this.plugin.settings.metaFileNameMaxLength = parseInt(value, 10) || 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('默认用标题重命名', 'Rename to the title by default'))
            .setDesc(tr('复核时“同时用标题重命名文件”默认勾上。', 'Ticks "Also rename the file to the title" in the review.'))
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.metaRenameDefault)
                .onChange(async (value) => {
                    this.plugin.settings.metaRenameDefault = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('补上缺少的属性', 'Fill in missing properties'))
            .setDesc(tr('YAML。应用属性时只补笔记里还没有的字段，已有的不动。', 'YAML. When properties are applied, only fields the note lacks are added.'))
            .addTextArea(text => text
                .setPlaceholder(tr('例如 status: draft', 'For example, status: draft'))
                .setValue(this.plugin.settings.metaFieldDefaults || '')
                .onChange(async (value) => {
                    this.plugin.settings.metaFieldDefaults = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('只给这些文件夹补', 'Only in these folders'))
            .setDesc(tr('每行一个，含子文件夹；按笔记应用前所在的位置算。留空不限。', 'One per line, subfolders included; based on where the note is before it moves. Leave empty for all folders.'))
            .addTextArea(text => text
                .setPlaceholder(tr('例如：\nInbox', 'For example:\nInbox'))
                .setValue(this.plugin.settings.metaFieldDefaultsFolders || '')
                .onChange(async (value) => {
                    this.plugin.settings.metaFieldDefaultsFolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName(tr('库的规矩', 'Vault rules')).setHeading();
        new Setting(containerEl)
            .setName(tr('写给 AI 的长期说明', 'Standing notes for the AI'))
            .setDesc(tr('每次生成都会带上，例如标题怎么起、标题层级从几级开始。', 'Sent with every request, for example how titles are named or which heading level to start from.'))
            .addTextArea(text => {
                text.setPlaceholder(tr('例如：标题写成能搜到的短语，不要标题党。正文从二级标题开始。', 'For example: titles are searchable phrases, not headlines. Body headings start at level 2.'))
                    .setValue(this.plugin.settings.vaultConventions || '')
                    .onChange(async (value) => {
                        this.plugin.settings.vaultConventions = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 6;
            });

        new Setting(containerEl).setName(tr('手账写法', 'Notebook marks')).setHeading();
        new Setting(containerEl)
            .setName(tr('整理正文时能用的写法', 'Marks the text tidy may use'))
            .setDesc(tr('一行一种，写法加一句什么时候用。留空就是普通整理。清单外的纸片和类名会被去掉。', 'One per line: the syntax and when to use it. Leave empty for a plain tidy. Cards and classes not listed are removed.'))
            .addTextArea(text => {
                text.setPlaceholder(tr('例如：> [!summary] 一句话结论，放最前面', 'For example: > [!summary] the one-line conclusion, at the top'))
                    .setValue(this.plugin.settings.structurizerMarks || '')
                    .onChange(async (value) => { this.plugin.settings.structurizerMarks = value; await this.plugin.saveSettings(); });
                text.inputEl.rows = 8;
            });
        new Setting(containerEl)
            .setName(tr('一篇最多几张纸片', 'Most cards per note'))
            .addSlider(slider => slider.setLimits(1, 10, 1).setValue(Number(this.plugin.settings.structurizerMaxCards) || 4).setDynamicTooltip()
                .onChange(async (value) => { this.plugin.settings.structurizerMaxCards = value; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName(tr('时间线和对话可以缩写', 'Timelines and chats may condense'))
            .setDesc(tr('打开后纸片会多一些，但这两种纸片里的原话会被压成一行；其他地方仍然一字不改。', 'More cards, but the original words inside these two cards get condensed to one line; everything else stays word for word.'))
            .addToggle(toggle => toggle.setValue(!!this.plugin.settings.structurizerCondense)
                .onChange(async (value) => { this.plugin.settings.structurizerCondense = value; await this.plugin.saveSettings(); }));

        new Setting(containerEl).setName(tr('样式类', 'Style classes')).setHeading();
        const styleText = (name, desc, key, placeholder) => new Setting(containerEl).setName(name).setDesc(desc)
            .addTextArea(text => text.setPlaceholder(placeholder).setValue(this.plugin.settings[key] || '')
                .onChange(async (value) => { this.plugin.settings[key] = value.trim(); await this.plugin.saveSettings(); }));
        styleText(tr('副题类', 'Subtitle class'), tr('填了就提议把一句话总结放进正文第一行的 span。类名来自你的主题；留空不提议。', 'If set, offers to put the one-line summary in a span on the first line. The class comes from your theme; leave empty to skip.'), 'styleSubtitleClass', tr('例如 subtitle', 'For example, subtitle'));
        styleText(tr('卡片类', 'Card class'), tr('笔记放进下面的文件夹时，提议加进 cssclasses。', 'Offered for cssclasses when the note ends up in the folders below.'), 'styleCardClass', tr('例如 card', 'For example, card'));
        styleText(tr('卡片文件夹', 'Card folders'), tr('每行一个，含子文件夹。', 'One per line, subfolders included.'), 'styleCardFolders', tr('例如 Cards', 'For example, Cards'));
        styleText(tr('旧笔记类', 'Old-note classes'), tr('每行“天数 类名”，按 created 或 date 字段算，没有就用创建时间；取满足的最长那条。', 'One "days class" per line, from the created or date field, else the file creation time; the longest rule met wins.'), 'styleAgedRules', tr('例如 365 old-note', 'For example, 365 old-note'));

        new Setting(containerEl).setName(tr('侧栏', 'Sidebar')).setHeading();
        new Setting(containerEl).setName(tr('衬线数字', 'Serif numbers')).setDesc(tr('“全部接受”上的数字用 Didot 斜体。', 'The number on “Accept all” in Didot italic.')).addToggle(t=>t.setValue(this.plugin.settings.serifNumbers!==false).onChange(async value=>{this.plugin.settings.serifNumbers=value;await this.plugin.saveSettings();this.plugin.refreshAssistantViews?.();}));
        new Setting(containerEl).setName(tr('外观', 'Look')).addDropdown(d=>d.addOption('standard',tr('标准','Standard')).addOption('journal',tr('手账','Journal')).setValue(this.plugin.settings.look==='journal'?'journal':'standard').onChange(async value=>{this.plugin.settings.look=value;await this.plugin.saveSettings();this.plugin.refreshAssistantViews?.();}));
        new Setting(containerEl).setName(tr('紧凑侧栏', 'Compact sidebar')).addToggle(t=>t.setValue(this.plugin.settings.sidebarCompact!==false).onChange(async value=>{this.plugin.settings.sidebarCompact=value;await this.plugin.saveSettings();this.plugin.refreshAssistantViews?.();}));
        new Setting(containerEl).setName(tr('确认后进入下一篇', 'Next note after confirming')).setDesc(tr('只在批量审阅时生效。', 'Batch review only.')).addToggle(t=>t.setValue(this.plugin.settings.sidebarAutoNext!==false).onChange(async value=>{this.plugin.settings.sidebarAutoNext=value;await this.plugin.saveSettings();}));
        this.addSectionHeading(containerEl, tr('默认处理步骤', 'Default steps'));

        new Setting(containerEl)
            .setName(tr('优化结构', 'Tidy structure'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.structurizer)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.structurizer = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('假名标注', 'Furigana'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.furigana)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.furigana = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('生成元数据', 'Generate properties'))
            .setDesc(tr('标题、摘要和一句话总结。', 'Title, summary and one-liner.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.meta)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.meta = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('智能标签', 'Smart tags'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.tagger)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.tagger = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(tr('移动笔记', 'Move note'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.oneClickProcessActions.mover)
                .onChange(async (value) => {
                    this.plugin.settings.oneClickProcessActions.mover = value;
                    await this.plugin.saveSettings();
                }));


        this.addSectionHeading(containerEl, tr('自定义动作', 'Custom actions'));
        containerEl.createEl('p', {
            text: tr('Prompt 支持 {{content}}、{{selection}}、{{file_name}}、{{file_path}}。新增动作会立即出现在侧边栏；若要作为 Obsidian 命令/热键使用，重载插件后会注册。', 'Prompts support {{content}}, {{selection}}, {{file_name}} and {{file_path}}. New actions appear in the sidebar at once; to use them as Obsidian commands or hotkeys, reload the plugin.'),
            cls: 'ai-assistant-settings-note'
        });

        const customActions = this.plugin.settings.customActions || [];
        customActions.forEach((action, index) => {
            const actionContainer = containerEl.createDiv({ cls: 'custom-action-settings-block' });
            new Setting(actionContainer).setName(action.name || tr(`自定义动作 ${index + 1}`, `Custom action ${index + 1}`)).setHeading();

            new Setting(actionContainer)
                .setName(tr('启用', 'Enabled'))
                .addToggle(toggle => toggle
                    .setValue(action.enabled !== false)
                    .onChange(async (value) => {
                        action.enabled = value;
                        await this.plugin.saveSettings();
                        this.refresh();
                    }));

            new Setting(actionContainer)
                .setName(tr('名称', 'Name'))
                .addText(text => text
                    .setPlaceholder(tr('例如：提取行动项', 'For example: extract action items'))
                    .setValue(action.name || '')
                    .onChange(async (value) => {
                        action.name = value || tr('自定义动作', 'Custom action');
                        await this.plugin.saveSettings();
                    }));

            new Setting(actionContainer)
                .setName(tr('输出模式', 'Output'))
                .addDropdown(dropdown => dropdown
                    .addOption('sidebar', tr('侧边栏显示', 'Sidebar'))
                    .addOption('diff', tr('差异预览', 'Change preview'))
                    .addOption('append', tr('追加到当前笔记', 'Append to current note'))
                    .addOption('new-note', tr('创建新笔记', 'Create new note'))
                    .setValue(action.outputMode || 'sidebar')
                    .onChange(async (value) => {
                        action.outputMode = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(actionContainer)
                .setName('Prompt')
                .addTextArea(text => {
                    text.setPlaceholder(tr('请基于以下内容执行任务：\n\n{{selection}}\n\n{{content}}', 'Do the task using the following:\n\n{{selection}}\n\n{{content}}'))
                        .setValue(action.prompt || '')
                        .onChange(async (value) => {
                            action.prompt = value;
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.addClass('ai-assistant-u-prompt-editor-small');
                });

            new Setting(actionContainer)
                .setName(tr('删除', 'Delete'))
                .addButton(button => button
                    .setButtonText(tr('删除', 'Delete'))
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.customActions = customActions.filter(item => item.id !== action.id);
                        await this.plugin.saveSettings();
                        this.refresh();
                    }));
        });

        new Setting(containerEl)
            .setName(tr('添加自定义动作', 'Add custom action'))
            .addButton(button => button
                .setButtonText(tr('新增', 'Add'))
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.customActions.push({
                        id: `custom_${Date.now()}`,
                        name: tr(`自定义动作 ${customActions.length + 1}`, `Custom action ${customActions.length + 1}`),
                        prompt: tr('请基于以下内容执行任务：\n\n{{selection}}\n\n{{content}}', 'Do the task using the following:\n\n{{selection}}\n\n{{content}}'),
                        outputMode: 'sidebar',
                        enabled: true
                    });
                    await this.plugin.saveSettings();
                    this.refresh();
                }));


        this.addSectionHeading(containerEl, tr('内置提示词', 'Built-in prompts'));
        containerEl.createEl('p', { cls: 'ai-assistant-settings-note', text: tr('占位符（例如 {{content}}）要保留，运行时会换成笔记内容。', 'Keep placeholders such as {{content}}; they are filled in when the action runs.') });

        new Setting(containerEl)
            .setName(tr('优化结构', 'Tidy structure'))
            .addButton(button => {
                button.setButtonText(tr('编辑', 'Edit')).onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'structurizerPrompt', tr('编辑优化结构 Prompt', 'Edit tidy structure prompt')).open();
                });
            });

        new Setting(containerEl)
            .setName(tr('移动笔记', 'Move note'))
            .addButton(button => {
                button.setButtonText(tr('编辑', 'Edit')).onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'moverPrompt', tr('编辑移动笔记 Prompt', 'Edit move note prompt')).open();
                });
            });

        new Setting(containerEl)
            .setName(tr('智能标签', 'Smart tags'))
            .addButton(button => {
                button.setButtonText(tr('编辑', 'Edit')).onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'taggerPrompt', tr('编辑智能标签 Prompt', 'Edit smart tags prompt')).open();
                });
            });

        new Setting(containerEl)
            .setName(tr('生成元数据', 'Generate properties'))
            .addButton(button => {
                button.setButtonText(tr('编辑', 'Edit')).onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'metaPrompt', tr('编辑生成元数据 Prompt', 'Edit properties prompt')).open();
                });
            });

        new Setting(containerEl)
            .setName(tr('翻译标签', 'Translate tags'))
            .addButton(button => {
                button.setButtonText(tr('编辑', 'Edit')).onClick(() => {
                    new PromptEditModal(this.app, this.plugin, 'translationPrompt', tr('编辑翻译 Prompt', 'Edit translation prompt')).open();
                });
            });

        this.addSectionHeading(containerEl, tr('配置管理', 'Manage settings'));

        new Setting(containerEl)
            .setName(tr('导出设置', 'Export settings'))
            .setDesc(tr('导出配置与提示词，密钥会被移除。导入后需要另行填写密钥。', 'Export configurations and prompts. Keys are removed; enter them again after importing.'))
            .addButton(button => {
                button.setButtonText(tr('导出设置', 'Export settings')).onClick(() => {
                    this.exportSettings();
                });
            });

        new Setting(containerEl)
            .setName(tr('导入设置', 'Import settings'))
            .setDesc(tr('合并进当前设置，已保存的密钥不会被覆盖。', 'Merged into the current settings; saved keys are kept.'))
            .addButton(button => {
                button.setButtonText(tr('导入设置', 'Import settings')).onClick(() => {
                    this.importSettings();
                });
            });

        new Setting(containerEl)
            .setName(tr('重置设置', 'Reset settings'))
            .addButton(button => {
                button.setButtonText(tr('重置设置', 'Reset settings'))
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

        new Notice(tr('设置已导出！', 'Settings exported.'), 3000);
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
                    throw new Error(tr('无效的设置文件格式', 'Invalid settings file'));
                }

                // 合并设置（保留默认值），且不让 [REDACTED] 覆盖已保存密钥
                this.plugin.settings = this.plugin.mergeImportedSettings(importedSettings);
                this.plugin.normalizeSettings();
                await this.plugin.moveKeysToSecretStorage();
                await this.plugin.saveSettings();

                // 刷新设置界面
                this.refresh();

                new Notice(tr('设置导入成功！', 'Settings imported.'), 3000);
            } catch (error) {
                new Notice(tr(`导入失败: ${error.message}`, `Import failed: ${error.message}`), 5000);
            }
        };
        input.click();
    }

    // 重置设置
    async resetSettings() {
        const confirmed = await confirmAction(this.app, tr('确定要重置所有设置为默认值吗？此操作不可撤销。', 'Reset every setting to its default? This cannot be undone.'), tr('重置', 'Reset'));
        if (confirmed) {
            this.plugin.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            await this.plugin.saveSettings();
            this.refresh();
            new Notice(tr('设置已重置为默认值！', 'Settings reset to defaults.'), 3000);
        }
    }
}
