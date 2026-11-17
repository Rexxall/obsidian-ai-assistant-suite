import { FuzzySuggestModal, Modal, getLanguage } from 'obsidian';
import type { App } from 'obsidian';
import { AiError, getProvider, inferProviderId, resolveProvider, slotFromEndpoint } from './vendor/rex-ai-kit/index';
import type { AiSlot, Provider } from './vendor/rex-ai-kit/index';
import { at, num, str } from './vendor/rex-ai-kit/json';
import type { ApiConfig, Settings } from './types';

// 界面主体是中文；命令名跟随 Obsidian 语言，非中文时用英文
export const isChineseInterface = (): boolean => {
    try {
        return (typeof getLanguage === 'function' ? getLanguage() : 'zh').toLowerCase().startsWith('zh');
    } catch {
        return true;
    }
};
export const tr = (zh: string, en: string): string => isChineseInterface() ? zh : en;

// 弹窗统一用玻璃风（apple-kit.css 的 .ap-modal）
export class GlassModal extends Modal {
    constructor(app: App) {
        super(app);
        this.modalEl?.addClass?.('ap', 'ap-modal');
    }
}
export abstract class GlassFuzzySuggestModal<T> extends FuzzySuggestModal<T> {
    constructor(app: App) {
        super(app);
        this.modalEl?.addClass?.('ap', 'ap-modal');
    }
}

// 审核一篇笔记的建议：标签、每个属性、移动、正文各占一行，逐项勾选后一次应用
// Obsidian 风格的确认框，代替浏览器自带的 confirm()
export function confirmAction(app: App, message: string, confirmText: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const modal = new GlassModal(app);
        let answered = false;
        const finish = (value: boolean) => {
            if (answered) return;
            answered = true;
            resolve(value);
            modal.close();
        };
        modal.contentEl.createEl('p', { text: message });
        const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
        buttons.createEl('button', { text: tr('取消', 'Cancel') }).addEventListener('click', () => finish(false));
        buttons.createEl('button', { cls: 'mod-warning', text: confirmText }).addEventListener('click', () => finish(true));
        modal.onClose = () => finish(false);
        modal.open();
    });
}

export const ASSISTANT_VIEW_TYPE = "ai-assistant-view";
export const ASSISTANT_WORKBENCH_TYPE = "ai-assistant-workbench-view";
export const REDACTED_API_KEY = '[REDACTED]';
export const PLUGIN_SECRET_PREFIX = 'ai-assistant-suite';
// 服务商、地址、型号和钥匙串名都来自共用的 rex-ai-kit；界面跟着插件语言（中文或英文）
export const aiLang = (): 'zh' | 'en' => isChineseInterface() ? 'zh' : 'en';
export const hostOf = (url: string | null | undefined): string => /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || '').trim())?.[1].toLowerCase() || '';
export const slotOf = (config: ApiConfig | null | undefined): AiSlot => config?.ai || { provider: 'deepseek', model: '' };
export const providerOf = (config: ApiConfig | null | undefined): Provider => resolveProvider(slotOf(config), aiLang());
export const providerLabel = (config: ApiConfig | null | undefined): string => providerOf(config).name;
export const defaultModelOf = (providerId: string): string => getProvider(providerId)?.picks.find(p => p.scene === 'cheap')?.id || getProvider(providerId)?.picks[0]?.id || '';
// 新装时先看钥匙串里已经有哪家的密钥（别的插件存过就不用再填）；都没有时用 DeepSeek。笔记是私人内容，不引导去 Gemini 免费档
export const FIRST_RUN_ORDER = ['anthropic', 'openai', 'deepseek', 'gemini', 'qwen', 'kimi', 'zhipu', 'siliconflow', 'openrouter'];

// 旧版（1.8 及以前）一条配置的“服务商 + 地址 + 模型 + 钥匙串名”转成 kit 的 slot；地址是官方的就不留，代理和本地端口照留
export function slotFromLegacyConfig(config: ApiConfig): AiSlot {
    const legacy = config.apiProvider || 'openai';
    const url = String(config.apiUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    let slot: AiSlot;
    if (legacy === 'local') {
        // 旧版本地模型默认走 Ollama；非常见端口的本地服务按 OpenAI 兼容格式走，不要求密钥
        const address = url || 'http://localhost:11434/v1';
        slot = slotFromEndpoint({ url: address, provider: inferProviderId(address) === 'ollama' ? 'ollama' : 'lmstudio', model: config.modelName, secretName: config.apiKeySecret });
    } else if (legacy === 'openai') {
        slot = slotFromEndpoint({ url, model: config.modelName, secretName: config.apiKeySecret });
    } else {
        slot = slotFromEndpoint({ url, provider: legacy, model: config.modelName, secretName: config.apiKeySecret });
    }
    if (!slot.model) slot.model = defaultModelOf(slot.provider);
    return slot;
}

// 把一次失败归到用户能处理的那一类。kit 已经分好大类，这里再把 404 地址错、400 参数错、空回答分出来
export function classifyApiError(error: unknown): string {
    const status = num(at(error, 'status'));
    const text = `${str(at(error, 'detail')) || ''} ${str(at(error, 'message')) || ''}`;
    if (error instanceof AiError) {
        if (error.kind === 'model' && status === 404 && !/model/i.test(error.detail || '')) return 'url';
        if (error.kind === 'bad-response') return status === 400 || status === 422 ? 'params' : status && status >= 200 && status < 300 ? 'empty' : 'other';
        return error.kind;
    }
    const kind = str(at(error, 'kind'));
    if (kind) return kind;
    if (!status && /net::|ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|getaddrinfo|Failed to fetch|network|CORS|certificate/i.test(text)) return 'network';
    return 'other';
}

// 每类失败：一句发生了什么，一个下一步，能直接点的后台链接
export function describeApiProblem(kind: string, config: ApiConfig | null = null, error: unknown = null): { kind: string; message: string; next: string; keyPage: string } {
    const provider = config ? providerOf(config) : null;
    const name = provider?.name || '';
    const keyPage = provider?.consoleUrl || '';
    const local = provider?.group === 'local' && !provider.localAgent;
    const errorDetail = str(at(error, 'detail'));
    const detail = errorDetail ? ` ${errorDetail}` : '';
    const errorStatus = num(at(error, 'status'));
    const table: Record<string, [string, string]> = {
        'no-config': [tr('还没有 AI 配置。', 'There is no AI configuration yet.'), tr('在设置里新增一条配置。', 'Add a configuration in settings.')],
        'no-key': [tr(`还没有选 ${name} 的密钥。`, `No ${name} key is chosen yet.`), tr(`到 ${name} 后台复制密钥，在“API 密钥”里新建一项粘贴进去。`, `Copy a key from ${name}, then create an entry under API key and paste it.`)],
        'no-url': [tr('“其他（OpenAI 兼容）”需要接口地址。', '“Other (OpenAI compatible)” needs a server address.'), tr('在“高级 → 接口地址”里填，例如 https://api.example.com/v1。', 'Enter it under Advanced → Server address, for example https://api.example.com/v1.')],
        'no-model': [tr('还没有选模型。', 'No model is chosen.'), tr('在“模型”里选一个，或填服务商给的模型名。', 'Pick one under Model, or type the name your provider gives.')],
        'auth': [tr(`${name} 不认这个密钥（HTTP ${errorStatus || 401}）。`, `${name} rejected the key (HTTP ${errorStatus || 401}).`), tr('到服务商后台重新复制密钥，确认没有多余空格，并且密钥属于这家服务商。', 'Copy the key again from the provider, check for extra spaces and that the key belongs to this provider.')],
        'quota': [tr(`${name} 账户余额或额度不足。`, `The ${name} account is out of balance or quota.`), tr('到服务商后台充值或查看额度，然后再测一次；也可以勾一条备用配置。', 'Top up or check the quota with the provider, then test again; or allow a backup configuration.')],
        'rate': [tr('请求太频繁，被服务商限流（HTTP 429）。', 'Too many requests; the provider is rate limiting (HTTP 429).'), tr('等一分钟再试。', 'Wait a minute and try again.')],
        'model': [tr(`${name} 没有这个模型，或你的账户用不了它。`, `${name} does not offer this model, or your account cannot use it.`), tr('在“模型”里从列表选一个；列表旧了点“刷新列表”。', 'Pick one from the list under Model; press Refresh list if it is old.')],
        'url': [tr('接口地址找不到（HTTP 404）。', 'The server address was not found (HTTP 404).'), tr('检查“高级 → 接口地址”；用官方服务时把它清空。', 'Check Advanced → Server address; clear it to use the official server.')],
        'timeout': [tr('等了太久没有回答。', 'No answer in time.'), local ? tr('确认本机的模型服务已经启动，模型已经下载。', 'Make sure the local model server is running and the model is downloaded.') : tr('检查网络和代理后再试；笔记很长时可以先分段处理。', 'Check the network and proxy, then try again; for a very long note, process it in parts.')],
        'network': [tr('连不上服务器。', 'Could not reach the server.'), local ? tr('确认本机的模型服务已经启动；手机访问不到电脑上的服务。', 'Make sure the local server is running; a phone cannot reach a server on your computer.') : tr('检查网络、代理和地址拼写。', 'Check the network, proxy and address.')],
        'params': [tr(`${name} 不接受请求里的参数（HTTP ${errorStatus || 400}）。`, `${name} rejected a request parameter (HTTP ${errorStatus || 400}).`), tr('关掉“深度思考”再测；自定义服务请确认它兼容 OpenAI 格式。', 'Turn off Deep thinking and test again; for a custom service, check that it is OpenAI-compatible.')],
        'server': [tr(`${name} 那边出错（HTTP ${errorStatus || 500}）。`, `${name} had an error (HTTP ${errorStatus || 500}).`), tr('稍后再试；一直失败可以勾一条备用配置。', 'Try again later; if it keeps failing, allow a backup configuration.')],
        'empty': [tr('服务商有回答，但没有内容。', 'The provider answered with no content.'), tr('换一个模型再试。', 'Try another model.')],
        'aborted': [tr('已取消。', 'Cancelled.'), tr('需要时再点一次。', 'Run it again when you need it.')],
        'other': [tr(`连接失败。${detail}`, `Connection failed.${detail}`), tr('复制诊断信息，对照服务商文档检查。', 'Copy the diagnostics and compare them with the provider\'s docs.')],
    };
    const [message, next] = table[kind] || table.other;
    return { kind, message, next, keyPage: kind === 'no-key' || kind === 'auth' || kind === 'quota' ? keyPage : '' };
}

// 这些失败要改设置才能好，界面给“打开设置”；其余的（限流、超时、网络、服务商出错）给“再试一次”
export const SETTINGS_KINDS: string[] = ['no-config', 'no-key', 'no-url', 'no-model', 'auth', 'quota', 'model', 'url', 'params'];
export const API_PROBLEM_KINDS: string[] = [...SETTINGS_KINDS, 'rate', 'timeout', 'network', 'server', 'empty'];

// 测试连接按地址、密钥和账户、模型、参数四项给结果：出错那一项之前的算通过，之后的没检查到
export const CONNECTION_CHECKS: [string, [string, string], string[]][] = [
    ['url', ['地址', 'Address'], ['url', 'no-url', 'network', 'timeout']],
    ['auth', ['密钥和账户', 'Key and account'], ['auth', 'no-key', 'quota', 'no-config']],
    ['model', ['模型', 'Model'], ['model', 'no-model']],
    ['params', ['参数', 'Parameters'], ['params']],
];
export function connectionChecks(kind: string, status: number | null = null, sent = true): { id: string; label: string; state: 'ok' | 'fail' | 'skip' }[] {
    const failed = CONNECTION_CHECKS.findIndex(([, , kinds]) => kinds.includes(kind));
    // 归不到某一项的失败（限流、服务商出错、没有内容）：有 HTTP 回答就说明地址通了，其余没检查到。请求没发出去时一项都没检查
    const reached = !sent ? 0 : kind === 'ok' ? CONNECTION_CHECKS.length : failed >= 0 ? failed : (status ? 1 : 0);
    return CONNECTION_CHECKS.map(([id, [zh, en]], index) => ({
        id, label: tr(zh, en),
        state: index < reached ? 'ok' : index === failed ? 'fail' : 'skip',
    }));
}

// 1.7 以前的密钥格式：__ENC__:命名空间:密文，口令写死在插件里。只为迁移读一次，不再写
export async function readLegacyKey(value: string): Promise<string> {
    if (!value.startsWith('__ENC__:')) return value;
    const payload = value.split(':').slice(2).join(':');
    const bytesOf = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (payload.startsWith('plain:')) return new TextDecoder().decode(bytesOf(payload.slice(6)));
    const subtle = window.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto is not available');
    const bytes = bytesOf(payload);
    const encoder = new TextEncoder();
    const material = await subtle.importKey('raw', encoder.encode('obsidian-default-passphrase-change-me'), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey(
        { name: 'PBKDF2', salt: encoder.encode('obsidian-utils-encrypted-settings-v1:ai-assistant-suite'), iterations: 100000, hash: 'SHA-256' },
        material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return new TextDecoder().decode(plain);
}

// 旧密钥搬进钥匙串时用的共用名：已知服务商用各插件共用的名字（如 deepseek-api-key）；
// 自定义服务每条配置一个自己的名字，免得两个不同的服务器抢同一个名字
export function sharedSecretNameFor(config: ApiConfig): string {
    const provider = getProvider(slotOf(config).provider);
    if (provider && provider.id !== 'custom' && provider.secretName) return provider.secretName;
    const id = String(config.id || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
    return `${PLUGIN_SECRET_PREFIX}-${id}-api-key`;
}

export const STRUCTURIZER_DEFAULT_PROMPT = `你是一位非常精准的笔记结构化编辑。你的任务是优化给定文本的结构和可读性，同时严格遵守以下规则。

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

export const MOVER_DEFAULT_PROMPT = `你是一个精准的文件系统分类专家。你的任务是根据笔记内容，从一个给定的文件夹列表中，选择或创造最适合存放该笔记的文件夹路径。

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

export const TAGGER_DEFAULT_PROMPT = `你是一个严格遵守指令的 Obsidian 标签生成专家。你的任务是为给定的文本生成标签，并严格遵循我现有的标签层级结构。

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

export const META_DEFAULT_PROMPT = `你是一个内容分析和总结专家。请基于以下提供的文本，执行以下任务：

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

export const TRANSLATION_DEFAULT_PROMPT = `请将以下英文短语分别翻译成极其简洁且高度切题的 {{target_language}} 标签（最好是2-4个字）。每个翻译占一行，并与输入短语的顺序严格对应。请直接输出翻译结果，不要添加任何其他文字：
{{phrases_to_translate}}`;

export const FURIGANA_DEFAULT_PROMPT = `你是一位专业的日文假名标注专家。你的任务是为文本中的日文汉字添加假名注音（振り仮名/ルビ）。

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

// English versions of the default prompts. A prompt still equal to its Chinese default is sent in
// English when the interface is English; a prompt the user edited is always sent as written.
export const STRUCTURIZER_DEFAULT_PROMPT_EN = `You are a precise editor who structures notes. Improve the structure and readability of the text below while following these rules strictly.

**Rules:**

1.  **Preserve wording**:
    *   Do **not** rewrite or rephrase sentences. Your job is to reorder and format, not to rewrite.
    *   Only fix obvious grammar mistakes. Keep the author's own words and vocabulary, in the language they wrote in.

2.  **Handle embeds and links**:
    *   Anything like \`![[...]]\`, \`![...](...)\` or \`[...](...)\` is an embed or a link.
    *   Treat each of these as one unbreakable unit.
    *   **Never** describe what a link points to (an image, a web page). Keep only the link itself.
    *   Keep it exactly as it is, in the place that makes most sense in context.

3.  **Restructure and format**:
    *   You **may** reorder sentences or whole paragraphs to improve the flow.
    *   Use Markdown headings (\`#\`, \`##\`) for an outline, lists (\`-\` or \`1.\`) for points and bold (\`**...**\`) for key terms.
    *   **Layout:** when a note mixes kinds of content (for example a summary and quoted source text), keep like with like. Do not scatter long quotations through the analysis; place each quotation right after the point it supports, or gather many of them in one clearly labelled section, whichever presents this note most clearly.

4.  **Delete nothing**: every sentence, fact and link in the original must appear in the output.

5.  **Output only the result**: reply with the restructured Markdown and nothing else.

**Example:**
*Original:*
\`\`\`
Some text. [![Screenshot](https://example.com/img.png)](https://example.com/img.png) More text.
\`\`\`
*Correct output:*
\`\`\`
Some text.

[![Screenshot](https://example.com/img.png)](https://example.com/img.png)

More text.
\`\`\`

**The text to restructure:**

---
{{content}}
---`;

export const MOVER_DEFAULT_PROMPT_EN = `You are a precise file organiser. Based on the note's content, choose or create the folder paths that suit it best, starting from the list of existing folders.

**Task:**
Give {{count}} path suggestions.

**Steps:**
1.  Read the note and work out its main topic. Base this on the **text itself** and ignore what Markdown links or embeds (such as \`![[...]]\` or \`[...](...)\`) point to.
2.  **First** look for the best matches in the existing folders. If there are good ones, suggest them first (at least two).
3.  **Then**, if no existing folder fits well or a better organisation is possible, **create one or more clear new paths** that follow the naming and depth of the existing folders.
4.  Reply strictly in JSON: an object with a "suggestions" key whose value is an array of objects, each with "path" (string) and "is_new" (boolean).

**Example output:**
{
  "suggestions": [
    { "path": "10 - Projects/TOEFL-Prep/2_Skills/Speaking", "is_new": false },
    { "path": "20 - Areas/Language-Learning/English/TOEFL-Speaking", "is_new": true },
    { "path": "10 - Projects/Personal-Development/Public-Speaking", "is_new": false }
  ]
}

**Existing folders (to choose from):**
{{folder_list}}

**The note to file:**
\n\n{{content}}`;

export const TAGGER_DEFAULT_PROMPT_EN = `You are an Obsidian tagging expert who follows instructions exactly. Generate tags for the text below and keep strictly to the existing tag hierarchy.

**Rule:**
Every new tag you create **must** use the form \`category/topic/subtopic\`. Single-word tags are never allowed; every new tag sits under one or more levels.

**Steps:**
1.  **Read the text.** Base the tags on the **text itself** and ignore what Markdown links or embeds (such as \`![[...]]\` or \`[...](...)\`) point to.
2.  Look at the existing tags below. They are the structure and style you must follow, including their language.
3.  **Prefer** existing tags.
4.  For a new tag, decide which category and topic it belongs to and build the full hierarchical tag.
    *   **Wrong:** \`critical-thinking\` (an isolated tag)
    *   **Right:** \`C/personal-growth/critical-thinking\` (a tag placed in the hierarchy)
5.  Give about {{count}} tags in all, mixing existing tags and new hierarchical ones.
6.  Reply with a comma-separated list of tags only, with no other text or Markdown.

**Existing tags (your style guide):**
{{existing_tags}}

**The text to tag:**
{{content}}`;

export const META_DEFAULT_PROMPT_EN = `You are an expert at analysing and summarising content. Based on the text below, do the following.

**Important:**
If the text contains Markdown links or embeds (such as \`![...]]\` or \`[...](...)\`), base your work on the **text itself** and ignore what they point to. Summarise the text; do not describe the links.

**Tasks:**
1.  **Write a very short title** (ideally under 8 words), crisp like a headline and true to the core of the text.
2.  **Write a short summary** of 2–3 sentences with the main points and conclusion.
3.  **Write a one-sentence summary** (under 25 words) that gives the core at a glance.

Write all three in the same language as the text. Reply strictly in this JSON format, with no other text or code fences:
{
  "title": "the title",
  "summary": "the summary",
  "tldr": "the one-sentence summary"
}

The text:
\n\n{{content}}`;

export const TRANSLATION_DEFAULT_PROMPT_EN = `Translate each of the following English phrases into a very short, on-topic {{target_language}} tag (ideally 1–3 words). Put each translation on its own line, in the same order as the phrases. Reply with the translations only:
{{phrases_to_translate}}`;

export const FURIGANA_DEFAULT_PROMPT_EN = `You are an expert at adding furigana to Japanese. Add readings (furigana / ruby) to the kanji in the text below.

**Rules:**

1. **Find the kanji**: find every Japanese word that contains kanji, including words mixing kanji and kana.
2. **Add readings**: give each such word its correct reading, judged from context.
3. **Format (important)**:
   - **Japanese outside code**: use HTML \`<ruby>\` tags:
     \`<ruby>漢字<rt>かんじ</rt></ruby>\`
     For words of several kanji: \`<ruby>日本語<rt>にほんご</rt></ruby>\`

   - **Japanese inside code** (inline code and code blocks):
     - Use brackets: \`漢字(かんじ)\` or \`漢字【かんじ】\`
     - For words of several kanji: \`日本語(にほんご)\` or \`日本語【にほんご】\`
     - Prefer round brackets: \`漢字(かんじ)\`
     - Annotate only Japanese strings; leave English, symbols and spaces in names unchanged
     - If you are not 100% sure of a reading, or whether something is Japanese, leave it as it is

4. **Recognise code**:
   - Text in single backticks (\`) is inline code
   - Text in triple backticks (\`\`\`) is a code block
   - Japanese inside code must use brackets, never HTML tags
5. **Keep everything else**:
   - Keep all non-Japanese content (Chinese, English, numbers and so on) unchanged
   - Keep all Markdown syntax (links, images and so on) unchanged
   - Keep all formatting and structure unchanged
6. **Kanji only**: words written only in kana (such as "です", "ます") need no reading.
7. **Output only the result**: reply with the whole text with readings added, and nothing else.

**Example:**
*Input:*
\`\`\`
私は\`コード内の日本語\`を勉強しています。
\`\`\`
*Output:*
\`\`\`
<ruby>私<rt>わたし</rt></ruby>は\`コード内(コードない)の日本語(にほんご)\`を<ruby>勉強<rt>べんきょう</rt></ruby>しています。
\`\`\`

Note:
- "私" and "勉強" outside code use \`<ruby>\` tags
- "コード内" and "日本語" inside code use brackets: \`コード内(コードない)\` and \`日本語(にほんご)\`

**The text to annotate:**

---
{{content}}
---`;

export const PROMPT_DEFAULTS: Record<string, [string, string]> = {
    structurizerPrompt: [STRUCTURIZER_DEFAULT_PROMPT, STRUCTURIZER_DEFAULT_PROMPT_EN],
    moverPrompt: [MOVER_DEFAULT_PROMPT, MOVER_DEFAULT_PROMPT_EN],
    taggerPrompt: [TAGGER_DEFAULT_PROMPT, TAGGER_DEFAULT_PROMPT_EN],
    metaPrompt: [META_DEFAULT_PROMPT, META_DEFAULT_PROMPT_EN],
    translationPrompt: [TRANSLATION_DEFAULT_PROMPT, TRANSLATION_DEFAULT_PROMPT_EN],
    furiganaPrompt: [FURIGANA_DEFAULT_PROMPT, FURIGANA_DEFAULT_PROMPT_EN],
};

export const DEFAULT_SETTINGS: Settings = {
    // General API Settings
    activeConfigId: 'default',
    apiConfigs: [
        {
            id: 'default',
            name: '',
            ai: { provider: 'deepseek', model: 'deepseek-flash' },
            auxiliaryModelName: '',
            deepseekThinking: false,
            enabled: true,
            allowFallback: false
        }
    ],
    // 各服务商的模型列表缓存（只在点“检查”或“刷新”时更新）
    modelCache: undefined,

    // Structurizer Settings
    structurizerPrompt: STRUCTURIZER_DEFAULT_PROMPT,

    // Mover Settings
    moverSuggestionsCount: 4,
    ignoredFolders: '',
    // 只在库里已有的文件夹里挑，不建新文件夹
    moverExistingOnly: false,
    moverPrompt: MOVER_DEFAULT_PROMPT,

    // Tagger Settings
    taggerSuggestionsCount: 12,
    taggerExistingOnly: false,
    // 标签只能以这些根开头（每行一个，例如 C、P、Type）；留空不限
    taggerAllowedRoots: '',
    // 父标签和子标签不同时出现，只留子标签
    taggerDropParentTags: false,
    // 把过长的英文标签翻成短的中文标签；英文界面下默认不翻
    taggerEnableTranslation: isChineseInterface(),
    taggerTranslationTargetLanguage: tr('中文', 'English'),
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
    // 复核时“同时用标题重命名文件”默认勾上
    metaRenameDefault: false,
    // 应用属性时补上笔记里还没有的字段（YAML），已有的不动
    metaFieldDefaults: '',
    // 上一项只对这些文件夹里的笔记生效（每行一个，含子文件夹）；留空不限
    metaFieldDefaultsFolders: '',
    metaPrompt: META_DEFAULT_PROMPT,

    // 库的规矩：写给 AI 的长期说明，每次生成都会带上
    vaultConventions: '',
    structurizerMarks: '',
    structurizerMaxCards: 4,
    structurizerCondense: false,
    serifNumbers: true,
    look: 'standard',

    // 样式类提议：类名由主题提供，插件不自带；留空就不提议。只在审核单里出现，默认不勾
    styleSubtitleClass: '',
    styleCardClass: '',
    styleCardFolders: '',
    // 每行“天数 类名”，例如 365 old-note
    styleAgedRules: '',

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
    // 生成过的合并草稿（最近 10 篇）：路径和指纹，撤销时用来确认草稿没被改过
    mergeDrafts: [],




};
