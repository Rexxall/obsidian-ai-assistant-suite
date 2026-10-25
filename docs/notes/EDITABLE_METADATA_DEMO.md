# 可编辑元数据功能演示

## 功能概述

这个新功能允许用户在AI助手侧边栏中直接编辑AI生成的元数据，包括：

- **标题**：用于文件重命名
- **摘要**：详细描述笔记内容  
- **一句话总结**：简洁的核心要点

## 技术实现

### 前端界面改进

1. **替换静态显示**
   ```javascript
   // 原来的静态显示
   container.createEl("p", { text: `标题: ${title}` });
   
   // 新的可编辑输入框
   const titleInput = titleSection.createEl("input", { 
       type: "text", 
       value: title,
       cls: "meta-field-input"
   });
   ```

2. **实时数据绑定**
   ```javascript
   const editableData = {
       title: title,
       summary: summary,
       tldr: tldr
   };
   
   titleInput.addEventListener("input", (e) => {
       editableData.title = e.target.value;
   });
   ```

3. **动态路径计算**
   ```javascript
   const getUpdatedPaths = () => {
       const sanitizedTitle = editableData.title.trim().replace(/[/\\:?*"<>|]/g, '-');
       const finalFilename = sanitizedTitle.substring(0, this.plugin.settings.metaFileNameMaxLength);
       const newPath = `${task.content.file.parent.path}/${finalFilename}.md`;
       const canRename = task.content.file.path !== newPath && !this.plugin.app.vault.getAbstractFileByPath(newPath);
       return { sanitizedTitle, finalFilename, newPath, canRename };
   };
   ```

### CSS样式设计

```css
.meta-field-section {
    margin-bottom: 12px;
}

.meta-field-label {
    display: block;
    font-size: var(--font-ui-small);
    font-weight: 500;
    color: var(--text-normal);
    margin-bottom: 4px;
}

.meta-field-input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background-color: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    transition: border-color 0.2s ease-in-out;
}

.meta-field-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
}

.meta-field-textarea {
    width: 100%;
    min-height: 60px;
    max-height: 120px;
    resize: vertical;
    /* 其他样式同input */
}
```

## 用户体验改进

### 1. 直观的编辑界面
- 清晰的标签标识每个字段
- 合适的输入框大小
- 响应式的焦点状态

### 2. 实时反馈
- 编辑内容立即反映在按钮操作中
- 文件重命名路径实时更新
- 输入验证和错误提示

### 3. 灵活的操作选项
- 可以只更新元数据而不重命名文件
- 可以重命名文件并同时更新元数据
- 支持取消操作

## 使用场景

### 场景1：AI标题不够准确
```
AI生成: "关于机器学习的笔记"
用户编辑: "深度学习神经网络基础教程"
```

### 场景2：摘要需要补充
```
AI生成: "本文介绍了机器学习的基本概念"
用户编辑: "本文介绍了机器学习的基本概念，包括监督学习、无监督学习和强化学习三大类型，并详细解释了神经网络的工作原理"
```

### 场景3：一句话总结需要精炼
```
AI生成: "这是一篇关于机器学习算法和应用的详细介绍文章"
用户编辑: "机器学习三大类型及神经网络原理详解"
```

## 技术优势

1. **无需重新请求AI**：编辑后直接使用，节省API调用
2. **保持用户控制权**：用户可以完全自定义最终结果
3. **提高工作效率**：减少来回修改的时间成本
4. **增强用户体验**：更直观、更灵活的操作方式

## 兼容性

- ✅ 支持所有现有的AI Meta功能
- ✅ 兼容一键处理流程
- ✅ 保持原有的按钮操作逻辑
- ✅ 适配现有的CSS主题系统

## 未来扩展

可以考虑在其他AI功能中也加入类似的编辑能力：
- 标签建议的编辑
- 文件夹路径的自定义
- 结构优化结果的微调
