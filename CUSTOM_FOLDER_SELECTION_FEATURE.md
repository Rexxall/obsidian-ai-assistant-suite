# AI Mover 自定义文件夹选择功能

## 功能概述

在AI Mover建议的文件夹选项下方，新增了"选择其他位置"功能，让用户可以手动选择任意文件夹作为移动目标。

## 功能特性

### 🎯 **灵活的文件夹选择**
- **AI建议 + 手动选择**：既可以使用AI推荐的文件夹，也可以手动选择任意位置
- **模糊搜索**：使用Obsidian内置的FuzzySuggestModal，支持快速搜索文件夹
- **实时过滤**：输入文件夹名称即可快速定位目标位置

### 🎨 **直观的用户界面**
- **清晰的分隔**：自定义选择区域与AI建议区域有明显的视觉分隔
- **一致的操作体验**：与AI建议选项保持相同的操作逻辑
- **响应式设计**：适配不同屏幕尺寸和主题

## 使用方法

### 1. 在一键处理中使用
```
🎯 处理结果
├── 📁 建议移动位置
│   ├── 📂 Projects/Notes          [移动]
│   ├── 📂 Archive/2024           [移动]
│   ├── 📂 Reference/Articles     [移动]
│   └── ─────────────────────────────────
│       📁 选择其他位置...        [浏览]
```

### 2. 在独立Mover任务中使用
```
📁 AI移动建议: example.md
├── 📂 Suggested/Folder/Path      [移动]
├── 📂 Another/Suggested/Path     [移动]
└── ─────────────────────────────────────
    📁 选择其他位置...            [浏览]
    
[取消]
```

### 3. 操作流程
1. **查看AI建议**：首先查看AI推荐的文件夹选项
2. **选择自定义位置**：如果AI建议不满意，点击"浏览"按钮
3. **搜索文件夹**：在弹出的模态框中输入文件夹名称进行搜索
4. **确认移动**：选择目标文件夹后自动执行移动操作

## 技术实现

### 1. 渲染层改进
```javascript
// 在AI建议列表后添加自定义选择选项
const customMoverItem = container.createDiv({ 
    cls: "ai-assistant-mover-item ai-assistant-custom-mover" 
});
const customPathDiv = customMoverItem.createDiv({ 
    cls: "ai-assistant-mover-path" 
});
customPathDiv.createEl("span", { 
    text: "选择其他位置...", 
    cls: "custom-location-text"
});

const customButton = customMoverItem.createEl("button", { 
    text: "浏览", 
    cls: "mod-secondary" 
});
```

### 2. 文件夹选择逻辑
```javascript
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
```

### 3. 统一的移动逻辑
```javascript
// 提取通用的文件移动逻辑
async moveFileToFolder(task, destinationFolder, isNew = false) {
    // 验证目标路径
    // 创建文件夹（如需要）
    // 执行文件移动
    // 更新历史记录
    // 更新任务状态
}
```

## CSS样式设计

### 1. 视觉分隔
```css
.ai-assistant-custom-mover {
    border-top: 1px solid var(--background-modifier-border);
    margin-top: 8px;
    padding-top: 8px;
}
```

### 2. 文本样式
```css
.custom-location-text {
    color: var(--text-muted);
    font-style: italic;
    font-size: var(--font-ui-small);
}

.ai-assistant-custom-mover:hover .custom-location-text {
    color: var(--text-normal);
}
```

### 3. 按钮样式
```css
.ai-assistant-custom-mover button.mod-secondary {
    background-color: var(--background-modifier-border);
    color: var(--text-normal);
    border: 1px solid var(--background-modifier-border);
    transition: all 0.2s ease-in-out;
}

.ai-assistant-custom-mover button.mod-secondary:hover {
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: var(--interactive-accent);
}
```

## 用户体验优势

### 1. **更大的灵活性**
- 不受AI建议限制，可以选择任意文件夹
- 支持移动到新创建的文件夹结构中

### 2. **更好的控制权**
- 用户完全掌控文件的最终位置
- 可以根据个人的文件组织习惯进行调整

### 3. **更高的效率**
- 模糊搜索快速定位目标文件夹
- 一键完成文件移动操作

### 4. **一致的体验**
- 与现有的批量处理文件夹选择保持一致
- 遵循Obsidian的UI设计规范

## 兼容性

- ✅ 支持一键处理中的Mover功能
- ✅ 支持独立的Mover任务
- ✅ 兼容现有的AI建议逻辑
- ✅ 保持原有的错误处理机制
- ✅ 适配所有Obsidian主题

## 使用建议

1. **优先考虑AI建议**：AI推荐的文件夹通常基于内容分析，具有较高的准确性
2. **自定义选择的场景**：
   - AI建议的文件夹不存在或不合适
   - 需要移动到特定的项目文件夹
   - 按照个人的文件组织系统进行归档
3. **搜索技巧**：在文件夹选择器中可以输入部分文件夹名称快速定位

这个功能让AI Mover变得更加灵活和实用，既保留了AI的智能建议，又给用户提供了完全的控制权。
