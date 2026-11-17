import { Notice } from 'obsidian';
import type { App, TFile, TFolder } from 'obsidian';
import { GlassFuzzySuggestModal, GlassModal, tr } from './shared';
import { at, list as items, str } from './vendor/rex-ai-kit/json';

/** What the batch chooser hands back: picked notes, or the path of one folder. */
export type BatchChoice = ['files', TFile[]] | ['folder', string];

/** The conditions of the advanced picker; only one is set at a time. */
export interface FileFilters {
    folder: string;
    tags: string;
    properties: string;
    missingProperties?: string;
    customQuery: string;
    dateRange: { start: string; end: string };
    fileSize: { min: string; max: string };
}

/** Frontmatter values come from the note as written, so they are read as unknown. */
const frontmatterOf = (app: App, file: TFile): Record<string, unknown> => app.metadataCache.getFileCache(file)?.frontmatter || {};

/** `value.toString()`, which throws on null and undefined just as the untyped code did. */
const toText = (value: unknown): string => (value as { toString(): string }).toString();

// 批量处理选择模态框
export class BatchProcessingModal extends GlassModal {
    onChoose: (...choice: BatchChoice) => void;

    constructor(app: App, onChoose: (...choice: BatchChoice) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: tr("选择批量处理方式", 'Choose how to batch') });

        // 选择文件
        const filesOption = contentEl.createDiv({ cls: "batch-option" });
        filesOption.createDiv({ cls: "batch-option-icon", text: "📄" });
        const filesOptionContent = filesOption.createDiv({ cls: "batch-option-content" });
        filesOptionContent.createEl("h3", { text: tr("选择多个文件", 'Choose several files') });
        filesOptionContent.createEl("p", { text: tr("手动选择要处理的文件", 'Pick the files to process by hand') });
        filesOption.addEventListener('click', () => {
            this.close();
            this.showFileSelector();
        });

        // 选择文件夹
        const folderOption = contentEl.createDiv({ cls: "batch-option" });
        folderOption.createDiv({ cls: "batch-option-icon", text: "📁" });
        const folderOptionContent = folderOption.createDiv({ cls: "batch-option-content" });
        folderOptionContent.createEl("h3", { text: tr("选择文件夹", 'Choose a folder') });
        folderOptionContent.createEl("p", { text: tr("处理整个文件夹中的所有文件", 'Process every file in a folder') });
        folderOption.addEventListener('click', () => {
            this.close();
            this.showFolderSelector();
        });

        // 取消按钮
        const cancelBtn = contentEl.createEl("button", { text: tr("取消", 'Cancel'), cls: "mod-cancel" });
        cancelBtn.addEventListener('click', () => this.close());
    }

    showFileSelector(): void {
        const modal = new AdvancedFileSelectionModal(this.app, (selectedFiles) => {
            this.onChoose('files', selectedFiles);
        });
        modal.open();
    }

    showFolderSelector(): void {
        const folders = this.app.vault.getAllLoadedFiles()
            .filter((file): file is TFolder => 'children' in file && !!file.children)
            .map(folder => folder.path);

        const modal = new FolderSelectionModal(this.app, folders, (selectedFolder) => {
            this.onChoose('folder', selectedFolder);
        });
        modal.open();
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 高级文件选择模态框 - 支持多种筛选条件
export class AdvancedFileSelectionModal extends GlassModal {
    onChoose: (files: TFile[]) => void;
    selectedFiles: Set<TFile>;
    allFiles: TFile[];
    filteredFiles: TFile[];
    filters: FileFilters;
    filesByFolder: Map<string, TFile[]>;
    statsText?: HTMLElement;
    fileListContainer?: HTMLElement;
    bottomSelectedCount?: HTMLElement;

    constructor(app: App, onChoose: (files: TFile[]) => void) {
        super(app);
        this.onChoose = onChoose;
        this.selectedFiles = new Set<TFile>();
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
        this.filesByFolder = new Map<string, TFile[]>();
        this.allFiles.forEach(file => {
            const folderPath = file.parent?.path || '/';
            if (!this.filesByFolder.has(folderPath)) {
                this.filesByFolder.set(folderPath, []);
            }
            this.filesByFolder.get(folderPath)!.push(file);
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        // 移除固定尺寸，让Obsidian自适应

        contentEl.createEl("h2", { text: tr("高级文件选择器", 'Advanced file picker') });

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

    renderFilterBar(container: HTMLElement): void {
        // 筛选类型选择器
        const filterTypeSelect = container.createEl("select", { cls: "ai-assistant-filter-type-select" });
        [
            ["", tr("选择筛选类型", 'Filter type')],
            ["folder", tr("文件夹路径", 'Folder path')],
            ["tags", tr("标签", 'Tag')],
            ["properties", tr("属性", 'Property')],
            ["missing-properties", tr("缺少属性", 'Missing property')],
            ["query", tr("查询语法", 'Query')],
            ["date", tr("修改日期", 'Modified date')],
            ["size", tr("文件大小", 'File size')]
        ].forEach(([value, text]) => filterTypeSelect.createEl("option", { value, text }));

        // 筛选值容器
        const filterValueContainer = container.createDiv({ cls: "ai-assistant-filter-value-container" });

        // 筛选值输入框
        const filterInput = filterValueContainer.createEl("input", {
            type: "text",
            placeholder: tr("输入筛选条件...", 'Enter a filter…'),
            cls: "ai-assistant-filter-value-input"
        });

        // 下拉选择器容器
        const dropdownContainer = filterValueContainer.createDiv({ cls: "ai-assistant-filter-dropdown-container" });
        dropdownContainer.hide();

        // 当前筛选类型
        let currentFilterType = '';

        // 筛选类型变化处理
        filterTypeSelect.addEventListener('change', () => {
            currentFilterType = filterTypeSelect.value;
            filterInput.placeholder = this.getFilterPlaceholder(currentFilterType);
            filterInput.value = '';

            // 显示/隐藏下拉选择器
            this.updateFilterDropdown(dropdownContainer, currentFilterType, filterInput);

            this.clearFilters();
        });

        // 筛选值输入处理
        filterInput.addEventListener('input', () => {
            const value = filterInput.value;
            this.applySingleFilter(currentFilterType, value);
        });

        // 清除按钮
        const clearButton = container.createEl("button", {
            text: tr("清除", 'Clear'),
            cls: "ai-assistant-clear-filter-btn"
        });
        clearButton.addEventListener('click', () => {
            filterTypeSelect.value = '';
            filterInput.value = '';
            dropdownContainer.hide();
            currentFilterType = '';
            this.clearFilters();
        });

        // 快速筛选按钮组
        const quickFilters = container.createDiv({ cls: "ai-assistant-quick-filters" });
        [
            ["folder", "", tr("所有文件", 'All files')],
            ["folder", "current", tr("当前文件夹", 'Current folder')],
            ["properties", "status: ❌", "status: ❌"],
            ["missing-properties", "status", tr("缺少 status 属性", 'Missing status property')],
            ["missing-properties", "tags", tr("缺少 tags 属性", 'Missing tags property')]
        ].forEach(([type, value, text]) => quickFilters.createEl("button", {
            cls: "ai-assistant-quick-filter-btn",
            text,
            attr: { "data-type": type, "data-value": value }
        }));

        // 快速筛选按钮事件
        quickFilters.addEventListener('click', (e) => {
            // The buttons hold only text, so a click lands on an element.
            const target = e.target as HTMLElement;
            if (target.classList.contains('ai-assistant-quick-filter-btn')) {
                const type = target.dataset.type!;
                let value = target.dataset.value!;

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

    getFilterPlaceholder(type: string): string {
        const placeholders: Record<string, string> = {
            'folder': tr('输入文件夹路径，支持通配符 * 和 ?', 'Folder path; wildcards * and ? work'),
            'tags': tr('输入标签，多个标签用逗号分隔', 'Tags, separated by commas'),
            'properties': tr('格式: 属性名=值 或 属性名:值', 'Format: name=value or name:value'),
            'missing-properties': tr('输入属性名，多个属性用逗号分隔', 'Property names, separated by commas'),
            'query': tr('使用查询语法，如: path:folder/ tag:#important', 'Query, for example: path:folder/ tag:#important'),
            'date': tr('格式: 2024-01-01 或 2024-01-01,2024-12-31', 'Format: 2024-01-01 or 2024-01-01,2024-12-31'),
            'size': tr('格式: 10 或 10,100 (KB)', 'Format: 10 or 10,100 (KB)')
        };
        return placeholders[type] || tr('输入筛选条件...', 'Enter a filter…');
    }

    updateFilterDropdown(container: HTMLElement, type: string, inputElement: HTMLInputElement): void {
        container.empty();

        if (!type || !['folder', 'tags', 'properties', 'missing-properties'].includes(type)) {
            container.hide();
            return;
        }

        container.show();

        let options: string[] = [];

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
            container.hide();
            return;
        }

        // 创建可搜索的下拉选择器
        const dropdown = container.createEl("select", { cls: "ai-assistant-filter-dropdown" });
        dropdown.size = Math.min(options.length + 1, 15); // 显示最多15个选项
        dropdown.createEl("option", { value: "", text: tr("选择现有值...", 'Choose an existing value…') });

        options.forEach(option => {
            dropdown.createEl("option", {
                text: option,
                value: option
            });
        });

        // 下拉选择器变化处理
        dropdown.addEventListener('change', () => {
            if (dropdown.value) {
                inputElement.value = dropdown.value;
                // 触发筛选
                this.applySingleFilter(type, dropdown.value);
            }
        });

        // 输入框输入时过滤下拉选项
        inputElement.addEventListener('input', () => {
            const searchTerm = inputElement.value.toLowerCase();
            const dropdownOptions = dropdown.querySelectorAll('option');

            dropdownOptions.forEach(option => {
                if (option.value === '') return; // 保留提示选项

                const optionText = option.text.toLowerCase();
                if (optionText.includes(searchTerm)) {
                    option.show();
                } else {
                    option.hide();
                }
            });

            // 同时触发筛选
            this.applySingleFilter(type, inputElement.value);
        });

        // 输入框聚焦时显示下拉选择器
        inputElement.addEventListener('focus', () => {
            container.show();
        });

        // 下拉选择器聚焦时保持显示
        dropdown.addEventListener('focus', () => {
            container.show();
        });

        // 点击外部时隐藏下拉选择器
        const hideDropdown = (e: MouseEvent) => {
            if (!container.contains(e.target as Node | null) && e.target !== inputElement) {
                container.hide();
            }
        };

        // 延迟添加事件监听器，避免立即触发
        window.setTimeout(() => {
            document.addEventListener('click', hideDropdown);
        }, 100);
    }

    getAllFolders(): string[] {
        const folders = new Set<string>();
        this.allFiles.forEach(file => {
            const folderPath = file.parent?.path || '/';
            if (folderPath !== '/') {
                folders.add(folderPath);
            }
        });
        return Array.from(folders).sort();
    }

    getAllTags(): string[] {
        const tags = new Set<string>();
        this.allFiles.forEach(file => {
            try {
                const cache = this.app.metadataCache.getFileCache(file);

                // 从frontmatter中获取标签
                const frontmatterTags: unknown = cache?.frontmatter?.tags || [];
                if (Array.isArray(frontmatterTags)) {
                    items(frontmatterTags).forEach(tag => {
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
                        const text = str(at(section, 'text'));
                        if (section.type === 'paragraph' && text) {
                            const tagMatches = text.match(/#[\w\u4e00-\u9fff-]+/g);
                            if (tagMatches) {
                                tagMatches.forEach(tag => tags.add(tag));
                            }
                        }
                    });
                }
            } catch {
                // 忽略错误
            }
        });
        return Array.from(tags).sort();
    }

    getAllProperties(): string[] {
        const properties = new Set<string>();
        this.allFiles.forEach(file => {
            try {
                const frontmatter = frontmatterOf(this.app, file);
                Object.keys(frontmatter).forEach(key => properties.add(key));
            } catch {
                // 忽略错误
            }
        });
        return Array.from(properties).sort();
    }

    applySingleFilter(type: string, value: string): void {
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

    parseDateFilter(value: string): void {
        if (value.includes(',')) {
            const [start, end] = value.split(',').map(s => s.trim());
            this.filters.dateRange.start = start;
            this.filters.dateRange.end = end;
        } else {
            this.filters.dateRange.start = value;
        }
    }

    parseSizeFilter(value: string): void {
        if (value.includes(',')) {
            const [min, max] = value.split(',').map(s => s.trim());
            this.filters.fileSize.min = min;
            this.filters.fileSize.max = max;
        } else {
            this.filters.fileSize.min = value;
        }
    }

    renderFilePanel(container: HTMLElement): void {
        // 文件统计信息
        const statsContainer = container.createDiv({ cls: "ai-assistant-file-stats" });
        this.statsText = statsContainer.createSpan({
            text: tr(`显示 ${this.filteredFiles.length} / ${this.allFiles.length} 个文件`, `Showing ${this.filteredFiles.length} of ${this.allFiles.length} files`)
        });

        // 全选/取消全选按钮
        const selectAllContainer = container.createDiv({ cls: "ai-assistant-select-all-container" });
        const selectAllBtn = selectAllContainer.createEl("button", { text: tr("全选当前结果", 'Select all results') });
        const deselectAllBtn = selectAllContainer.createEl("button", { text: tr("取消全选", 'Select none') });

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

    updateFileList(): void {
        if (!this.fileListContainer) return;

        this.fileListContainer.empty();
        this.updateSelectionDisplays();

        if (this.filteredFiles.length === 0) {
            this.fileListContainer.createDiv({
                text: tr("没有找到匹配的文件", 'No matching files'),
                cls: "ai-assistant-no-files-message"
            });
            return;
        }

        // 按文件夹分组显示
        const groupedFiles = new Map<string, TFile[]>();
        this.filteredFiles.forEach(file => {
            const folderPath = file.parent?.path || '/';
            if (!groupedFiles.has(folderPath)) {
                groupedFiles.set(folderPath, []);
            }
            groupedFiles.get(folderPath)!.push(file);
        });

        // 按文件夹路径排序
        const sortedFolders = Array.from(groupedFiles.keys()).sort();

        sortedFolders.forEach(folderPath => {
            const files = groupedFiles.get(folderPath)!;

            const folderSection = this.fileListContainer!.createDiv({ cls: "ai-assistant-folder-section" });

            // 文件夹标题
            const folderHeader = folderSection.createDiv({ cls: "ai-assistant-folder-header" });
            folderHeader.createSpan({ cls: "ai-assistant-folder-name", text: `📁 ${folderPath}` });
            folderHeader.createSpan({ cls: "ai-assistant-folder-count", text: tr(`${files.length} 个文件`, `${files.length} files`) });

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
                fileList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => cb.checked = folderSelectAll.checked);
                this.updateFolderSelectAllState(folderSection, files);
                this.updateSelectionDisplays();
            });

            // 文件列表
            const fileList = folderSection.createDiv({ cls: "ai-assistant-file-list" });

            // 点击文件夹头展开/收起
            folderHeader.addEventListener('click', (event) => {
                // 跳过点击复选框的情况
                if ((event.target as Element).closest('input[type="checkbox"]')) {
                    return;
                }
                const isExpanded = fileList.classList.toggle('expanded');
                folderHeader.classList.toggle('expanded', isExpanded);
            });

            files.forEach(file => {
                const fileItem = fileList.createDiv({ cls: "ai-assistant-file-item" });

                const checkbox = fileItem.createEl("input", {
                    type: "checkbox"
                });
                // createEl has no `checked` option; set it on the element so picked files stay ticked.
                checkbox.checked = this.selectedFiles.has(file);

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
                fileInfo.createDiv({ cls: "ai-assistant-file-name", text: file.basename });
                const fileMeta = fileInfo.createDiv({ cls: "ai-assistant-file-meta" });
                fileMeta.createSpan({ cls: "ai-assistant-file-size", text: `${Math.round(file.stat.size / 1024)} KB` });
                fileMeta.createSpan({ cls: "ai-assistant-file-date", text: new Date(file.stat.mtime).toLocaleDateString() });
            });
        });
    }

    /** Folder checkbox follows its files: ticked when all are picked, mixed when some are. */
    updateFolderSelectAllState(section: HTMLElement, files: TFile[]): void {
        const box = section.querySelector<HTMLInputElement>('.ai-assistant-folder-select-all');
        if (!box || files.length === 0) return;
        const count = files.filter(f => this.selectedFiles.has(f)).length;
        box.checked = count === files.length;
        box.indeterminate = count > 0 && count < files.length;
    }

    applyFilters(): void {
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
                    const allFileTags = new Set<string>();

                    // 从frontmatter中获取标签
                    const frontmatterTags: unknown = cache?.frontmatter?.tags || [];
                    if (Array.isArray(frontmatterTags)) {
                        items(frontmatterTags).forEach(tag => {
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
                            const text = str(at(section, 'text'));
                            if (section.type === 'paragraph' && text) {
                                const tagMatches = text.match(/#[\w\u4e00-\u9fff-]+/g);
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
                    console.error(tr('标签筛选错误:', 'Tag filter error:'), e);
                    return false;
                }
            });
        }

        // 属性筛选
        if (this.filters.properties) {
            const propertyPairs = this.filters.properties.split(',').map(pair => pair.trim());
            filtered = filtered.filter(file => {
                try {
                    const frontmatter = frontmatterOf(this.app, file);

                    return propertyPairs.every(pair => {
                        const [key, value] = pair.split(/[=:]/).map(s => s.trim());
                        if (!key || !value) return true;

                        const fileValue = frontmatter[key];
                        if (typeof fileValue === 'string') {
                            return fileValue.toLowerCase().includes(value.toLowerCase());
                        } else if (Array.isArray(fileValue)) {
                            return items(fileValue).some(v =>
                                toText(v).toLowerCase().includes(value.toLowerCase())
                            );
                        }
                        return false;
                    });
                } catch {
                    return false;
                }
            });
        }

        // 缺少属性筛选
        if (this.filters.missingProperties) {
            const missingProps = this.filters.missingProperties.split(',').map(prop => prop.trim()).filter(prop => prop);
            filtered = filtered.filter(file => {
                try {
                    const frontmatter = frontmatterOf(this.app, file);

                    return missingProps.every(prop => {
                        // 检查属性是否不存在或为空
                        const value = frontmatter[prop];
                        return value === undefined || value === null || value === '' ||
                            (Array.isArray(value) && value.length === 0);
                    });
                } catch {
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
                    const frontmatter: Record<string, unknown> = cache?.frontmatter || {};
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
                                return items(fileValue).some(v =>
                                    toText(v).toLowerCase().includes(value)
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
                console.error(tr('查询语法解析错误:', 'Query parse error:'), e);
            }
        }

        this.filteredFiles = filtered;
        this.updateFileList();
    }

    clearFilters(): void {
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
        const inputs = this.contentEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.filter-input, .filter-textarea, .date-input, .size-input');
        inputs.forEach(input => input.value = '');

        this.filteredFiles = [...this.allFiles];
        this.updateFileList();
    }

    renderBottomActions(container: HTMLElement): void {
        const actionsContainer = container.createDiv({ cls: "ai-assistant-bottom-actions" });

        const selectedCount = actionsContainer.createSpan({
            text: tr(`已选择 ${this.selectedFiles.size} 个文件`, `${this.selectedFiles.size} files selected`),
            cls: "ai-assistant-selected-count"
        });
        this.bottomSelectedCount = selectedCount;

        const confirmBtn = actionsContainer.createEl("button", {
            text: tr("确认选择", 'Confirm'),
            cls: "mod-cta"
        });

        const cancelBtn = actionsContainer.createEl("button", {
            text: tr("取消", 'Cancel'),
            cls: "mod-cancel"
        });

        confirmBtn.addEventListener('click', () => {
            if (this.selectedFiles.size === 0) {
                new Notice(tr("请至少选择一个文件", 'Select at least one file'), 2000);
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
    updateSelectionDisplays(): void {
        if (this.statsText) {
            this.statsText.textContent = tr(`显示 ${this.filteredFiles.length} / ${this.allFiles.length} 个文件，已选择 ${this.selectedFiles.size} 个`, `Showing ${this.filteredFiles.length} of ${this.allFiles.length} files, ${this.selectedFiles.size} selected`);
        }
        if (this.bottomSelectedCount) {
            this.bottomSelectedCount.textContent = tr(`已选择 ${this.selectedFiles.size} 个文件`, `${this.selectedFiles.size} files selected`);
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class FolderSelectionModal extends GlassFuzzySuggestModal<string> {
    folders: string[];
    onChoose: (folder: string) => void;

    constructor(app: App, folders: string[], onChoose: (folder: string) => void) {
        super(app);
        this.folders = folders;
        this.onChoose = onChoose;
    }

    getItems(): string[] {
        return this.folders;
    }

    getItemText(folder: string): string {
        return folder;
    }

    onChooseItem(folder: string): void {
        this.onChoose(folder);
    }
}
