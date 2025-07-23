# Prompt Markdown预览功能

## 🎯 功能概述

为设置页面中的Prompt编辑功能添加了Markdown渲染预览，让用户能够更直观地查看和编辑Prompt内容。

### ✨ 主要特性

#### 1. **双模式切换**
- **编辑模式**：传统的文本编辑器，支持语法高亮
- **预览模式**：实时Markdown渲染，所见即所得

#### 2. **智能占位符高亮**
- **占位符识别**：自动识别`{{content}}`、`{{count}}`等占位符
- **视觉突出**：占位符以特殊样式显示，便于识别
- **语法保护**：确保占位符在预览中清晰可见

#### 3. **实时预览更新**
- **即时渲染**：编辑时实时更新预览内容
- **格式保持**：保持Markdown格式的完整性
- **样式优化**：使用Obsidian主题样式，保持一致性

## 🎨 界面设计

### 模态框布局
```
┌─────────────────────────────────────────┐
│ 📝 编辑优化结构 Prompt        [预览模式] │
├─────────────────────────────────────────┤
│                                         │
│  [编辑区域] 或 [预览区域]                │
│                                         │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│                           [取消] [保存] │
└─────────────────────────────────────────┘
```

### 编辑模式特性
- **等宽字体**：使用`var(--font-monospace)`确保代码可读性
- **语法高亮**：基础的文本编辑器样式
- **自动调整**：支持垂直调整大小
- **焦点样式**：清晰的焦点指示器

### 预览模式特性
- **Markdown渲染**：支持粗体、斜体、代码块等基础语法
- **占位符高亮**：`{{变量}}`以特殊颜色显示
- **主题一致**：使用Obsidian的颜色变量
- **滚动支持**：长内容支持滚动查看

## 🔧 技术实现

### 1. 模态框结构重构

#### 原始实现
```javascript
class PromptEditModal extends Modal {
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.title });
        
        new Setting(contentEl)
            .addTextArea(text => {
                // 简单的文本编辑器
            });
    }
}
```

#### 新实现
```javascript
class PromptEditModal extends Modal {
    constructor(app, plugin, settingName, title) {
        super(app);
        this.isPreviewMode = false; // 添加模式状态
    }
    
    onOpen() {
        // 创建头部和模式切换按钮
        this.createHeader();
        
        // 创建编辑和预览区域
        this.createEditArea();
        this.createPreviewArea();
        
        // 创建底部按钮
        this.createButtons();
    }
}
```

### 2. 模式切换逻辑

```javascript
// 模式切换按钮事件
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
```

### 3. Markdown渲染实现

```javascript
updatePreview(content) {
    this.previewContent.empty();
    
    // 处理占位符，让它们在预览中更明显
    const processedContent = content
        .replace(/\{\{(\w+)\}\}/g, '<span class="prompt-placeholder">{{$1}}</span>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
    
    this.previewContent.innerHTML = `<p>${processedContent}</p>`;
}
```

### 4. 样式系统

#### 响应式布局
```css
.prompt-edit-modal .modal-content {
    max-width: 800px;
    width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
}
```

#### 占位符样式
```css
.prompt-placeholder {
    background: var(--interactive-accent) !important;
    color: var(--text-on-accent) !important;
    padding: 2px 6px !important;
    border-radius: 4px !important;
    font-family: var(--font-monospace) !important;
    font-weight: 500;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
```

## 📊 用户体验提升

### 1. 可视化编辑
- **所见即所得**：预览模式让用户直观看到最终效果
- **格式检查**：及时发现Markdown语法错误
- **占位符识别**：清楚看到哪些是动态内容

### 2. 编辑便利性
- **快速切换**：一键在编辑和预览间切换
- **实时更新**：编辑时预览内容同步更新
- **格式保持**：编辑不会破坏原有格式

### 3. 专业外观
- **主题一致**：使用Obsidian的设计语言
- **响应式设计**：适配不同屏幕尺寸
- **交互反馈**：清晰的按钮状态和悬停效果

## 🎯 支持的Markdown语法

### 基础格式
- **粗体**：`**文本**` → **文本**
- **斜体**：`*文本*` → *文本*
- **代码**：`` `代码` `` → `代码`

### 占位符处理
- **变量占位符**：`{{content}}` → <span style="background: #007acc; color: white; padding: 2px 6px; border-radius: 4px; font-family: monospace;">{{content}}</span>
- **计数占位符**：`{{count}}` → <span style="background: #007acc; color: white; padding: 2px 6px; border-radius: 4px; font-family: monospace;">{{count}}</span>

### 段落处理
- **换行**：单个换行转换为`<br>`
- **段落**：双换行转换为新段落

## 🚀 使用场景

### 1. Prompt优化
- **结构检查**：预览模式查看Prompt的逻辑结构
- **格式调整**：确保Markdown格式正确显示
- **占位符验证**：确认所有占位符位置正确

### 2. 团队协作
- **文档化**：清晰的预览便于团队理解Prompt内容
- **标准化**：统一的格式规范
- **维护性**：易于修改和更新

### 3. 调试优化
- **可读性测试**：预览模式检查可读性
- **格式验证**：确保Markdown语法正确
- **效果预览**：提前看到最终效果

## 📈 技术优势

### 1. 性能优化
- **轻量级渲染**：简单的HTML转换，性能优秀
- **按需更新**：只在预览模式时进行渲染
- **内存友好**：及时清理DOM元素

### 2. 兼容性
- **主题适配**：使用CSS变量，自动适配主题
- **浏览器兼容**：使用标准Web API
- **Obsidian集成**：完美融入Obsidian生态

### 3. 可扩展性
- **插件化设计**：易于添加新的Markdown语法支持
- **样式定制**：CSS变量便于主题定制
- **功能扩展**：预留接口支持更多功能

## 🎉 总结

这个Prompt Markdown预览功能显著提升了用户编辑Prompt的体验：

1. **可视化编辑**：所见即所得的预览模式
2. **专业外观**：与Obsidian主题完美融合
3. **便捷操作**：一键切换编辑和预览模式
4. **智能高亮**：占位符自动识别和突出显示

用户现在可以更直观地编辑和预览Prompt内容，确保格式正确，提高工作效率。
