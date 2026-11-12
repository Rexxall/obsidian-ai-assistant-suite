import { apiVersion, Platform, Plugin, Notice, PluginSettingTab, SettingPage, Setting, FuzzySuggestModal, Modal, ItemView, MarkdownRenderer, SecretComponent, Menu, setIcon, parseYaml, stringifyYaml, getLanguage, requestUrl } from 'obsidian';

// 界面主体是中文；命令名跟随 Obsidian 语言，非中文时用英文
const isChineseInterface = () => {
    try {
        return (typeof getLanguage === 'function' ? getLanguage() : 'zh').toLowerCase().startsWith('zh');
    } catch {
        return true;
    }
};
const tr = (zh, en) => isChineseInterface() ? zh : en;

// 弹窗统一用玻璃风（apple-kit.css 的 .ap-modal）
class GlassModal extends Modal {
    constructor(app) {
        super(app);
        this.modalEl?.addClass?.('ap', 'ap-modal');
    }
}
class GlassFuzzySuggestModal extends FuzzySuggestModal {
    constructor(app) {
        super(app);
        this.modalEl?.addClass?.('ap', 'ap-modal');
    }
}

// 审核一篇笔记的建议：标签、每个属性、移动、正文各占一行，逐项勾选后一次应用
// Obsidian 风格的确认框，代替浏览器自带的 confirm()
function confirmAction(app, message, confirmText) {
    return new Promise(resolve => {
        const modal = new GlassModal(app);
        let answered = false;
        const finish = value => {
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

const ASSISTANT_VIEW_TYPE = "ai-assistant-view";
const ASSISTANT_WORKBENCH_TYPE = "ai-assistant-workbench-view";
const REDACTED_API_KEY = '[REDACTED]';
// 服务商、型号和示例地址是专名，按各家原样拼写，界面文字里从这里取。
// 地址和型号核自各家官方文档（2026-10-29）；国内常用的放前面，默认 DeepSeek。
const PROVIDERS = {
    deepseek: { name: ['DeepSeek', 'DeepSeek'], url: 'https://api.deepseek.com/chat/completions',
        models: [['deepseek-flash', 'DeepSeek Flash'], ['deepseek-v4-pro', 'DeepSeek V4 Pro']], keyPage: 'https://platform.deepseek.com/api_keys' },
    qwen: { name: ['通义千问（阿里云百炼）', 'Qwen (Alibaba Cloud Model Studio)'], url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: [['qwen-plus', 'Qwen Plus'], ['qwen-max', 'Qwen Max'], ['qwen-flash', 'Qwen Flash']], keyPage: 'https://bailian.console.aliyun.com/' },
    siliconflow: { name: ['硅基流动', 'SiliconFlow'], url: 'https://api.siliconflow.cn/v1/chat/completions',
        models: [['deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash'], ['Qwen/Qwen3-32B', 'Qwen3 32B']], keyPage: 'https://cloud.siliconflow.cn/account/ak' },
    kimi: { name: ['Kimi（月之暗面）', 'Kimi (Moonshot AI)'], url: 'https://api.moonshot.cn/v1/chat/completions',
        models: [['kimi-k3', 'Kimi K3'], ['kimi-k2.6', 'Kimi K2.6']], keyPage: 'https://platform.kimi.com/' },
    zhipu: { name: ['智谱 GLM', 'Zhipu GLM'], url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        models: [['glm-5.3', 'GLM-5.3'], ['glm-5.3-flash', 'GLM-5.3 Flash']], keyPage: 'https://open.bigmodel.cn/' },
    local: { name: ['本地模型（Ollama、LM Studio）', 'Local model (Ollama, LM Studio)'], url: 'http://localhost:11434/v1/chat/completions', models: [], local: true },
    gemini: { name: ['Google Gemini', 'Google Gemini'], url: '', models: [['gemini-2.5-flash', 'Gemini 2.5 Flash'], ['gemini-2.5-pro', 'Gemini 2.5 Pro']], keyPage: 'https://aistudio.google.com/apikey' },
    openai: { name: ['自定义（OpenAI 兼容格式）', 'Custom (OpenAI-compatible)'], url: '', models: [] },
};
const providerInfo = (id) => PROVIDERS[id] || PROVIDERS.openai;
const hostOf = (url) => /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || '').trim())?.[1].toLowerCase() || '';
const presetForUrl = (url) => {
    const host = hostOf(url);
    return host ? ['deepseek', 'qwen', 'siliconflow', 'kimi', 'zhipu'].find(id => hostOf(PROVIDERS[id].url) === host) || null : null;
};
const providerName = (id) => { const [zh, en] = providerInfo(id).name; return tr(zh, en); };
// 错误说明和诊断里不能出现密钥：遮掉请求头里的那个值，以及常见的密钥样式
function redactSecrets(text, headers = {}) {
    let out = String(text ?? '');
    const values = [headers.Authorization?.replace(/^Bearer\s+/i, ''), headers['x-goog-api-key']].filter(v => v && v.length >= 6);
    for (const value of values) out = out.split(value).join('[key]');
    return out
        .replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [key]')
        .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[key]')
        .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, '[key]')
        .replace(/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1[key]');
}

// 把一次失败归到用户能处理的那一类
function classifyApiError(error) {
    if (error?.kind) return error.kind;
    const status = error?.status;
    const text = `${error?.detail || ''} ${error?.message || ''}`;
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'quota';
    if (status === 429) return /quota|balance|insufficient|billing|arrear|余额|欠费|额度/i.test(text) ? 'quota' : 'rate';
    if (status === 404) return /model/i.test(text) ? 'model' : 'url';
    if ((status === 400 || status === 422) && /model[^.]*(not|exist|found|invalid)|supported (api )?model|you passed|invalid model|model_not_found|模型不存在|模型.*不支持/i.test(text)) return 'model';
    if (status === 400 || status === 422) return 'params';
    if (status >= 500) return 'server';
    if (!status && /net::|ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|getaddrinfo|Failed to fetch|network|CORS|certificate/i.test(text)) return 'network';
    return 'other';
}

// 每类失败：一句发生了什么，一个下一步
function describeApiProblem(kind, config = null, error = null) {
    const name = config ? providerName(config.apiProvider) : '';
    const keyPage = config ? providerInfo(config.apiProvider).keyPage || '' : '';
    const detail = error?.detail ? ` ${error.detail}` : '';
    const table = {
        'no-config': [tr('还没有 AI 配置。', 'There is no AI configuration yet.'), tr('在设置里新增一条配置。', 'Add a configuration in settings.')],
        'no-key': [tr('这条配置还没有填 API 密钥。', 'This configuration has no API key.'), tr(`到${name}后台获取密钥，粘贴到“API 密钥”后点保存。`, `Get a key from ${name}, paste it into API key and save.`)],
        'no-url': [tr('自定义服务需要填写接口地址。', 'A custom service needs an API URL.'), tr(`填写完整地址，例如 ${API_URL_EXAMPLE}。`, `Enter the full address, for example ${API_URL_EXAMPLE}.`)],
        'no-model': [tr('还没有填写模型。', 'No model is set.'), tr('在“主模型”里填写服务商给的模型名。', 'Enter the model name from your provider under Main model.')],
        'auth': [tr(`密钥不对或已失效（HTTP ${error?.status || 401}）。`, `The key was rejected (HTTP ${error?.status || 401}).`), tr('到服务商后台重新复制密钥，确认没有多余空格，并且密钥属于这家服务商。', 'Copy the key again from the provider, check for extra spaces and that the key belongs to this provider.')],
        'quota': [tr('账户余额或额度不足。', 'The account is out of balance or quota.'), tr('到服务商后台充值或查看额度，然后再测一次。', 'Top up or check the quota with the provider, then test again.')],
        'rate': [tr('请求太频繁，被服务商限流（HTTP 429）。', 'Too many requests; the provider is rate limiting (HTTP 429).'), tr('等一分钟再试。', 'Wait a minute and try again.')],
        'model': [tr('服务商不认这个模型名。', 'The provider does not recognise this model name.'), tr('从下拉框里选一个预设模型，或到服务商文档核对型号拼写。', 'Pick a preset model, or check the spelling against the provider\'s docs.')],
        'url': [tr('接口地址找不到（HTTP 404）。', 'The API URL was not found (HTTP 404).'), tr('检查接口地址；预设服务商可以把地址留空，用官方地址。', 'Check the API URL; for a preset provider you can leave it empty to use the official one.')],
        'timeout': [tr('等了太久没有回答。', 'No answer in time.'), tr('检查网络和代理；本地模型请确认本地服务已经启动。', 'Check your network and proxy; for a local model make sure the local server is running.')],
        'network': [tr('连不上服务器。', 'Could not reach the server.'), tr('检查网络、代理和地址拼写；本地模型请确认本地服务已启动，手机上访问不到电脑的 localhost。', 'Check the network, proxy and address; for a local model make sure the server is running. A phone cannot reach your computer\'s localhost.')],
        'params': [tr(`服务商不接受请求里的参数（HTTP ${error?.status || 400}）。`, `The provider rejected a request parameter (HTTP ${error?.status || 400}).`), tr('关掉“深度思考”再测；自定义服务请确认它兼容 OpenAI 格式。', 'Turn off Deep thinking and test again; for a custom service, check that it is OpenAI-compatible.')],
        'server': [tr(`服务商那边出错（HTTP ${error?.status || 500}）。`, `The provider had an error (HTTP ${error?.status || 500}).`), tr('稍后再试；一直失败可以加一条备用配置。', 'Try again later; if it keeps failing, add a backup configuration.')],
        'empty': [tr('服务商有回答，但没有内容。', 'The provider answered with no content.'), tr('换一个模型再试。', 'Try another model.')],
        'other': [tr(`连接失败。${detail}`, `Connection failed.${detail}`), tr('复制诊断信息，对照服务商文档检查。', 'Copy the diagnostics and compare them with the provider\'s docs.')],
    };
    const [message, next] = table[kind] || table.other;
    return { kind, message, next, keyPage: kind === 'no-key' || kind === 'auth' || kind === 'quota' ? keyPage : '' };
}

// 测试连接按地址、密钥和账户、模型、参数四项给结果：出错那一项之前的算通过，之后的没检查到
const CONNECTION_CHECKS = [
    ['url', ['地址', 'Address'], ['url', 'no-url', 'network', 'timeout']],
    ['auth', ['密钥和账户', 'Key and account'], ['auth', 'no-key', 'quota', 'no-config']],
    ['model', ['模型', 'Model'], ['model', 'no-model']],
    ['params', ['参数', 'Parameters'], ['params']],
];
function connectionChecks(kind, status = null, sent = true) {
    const failed = CONNECTION_CHECKS.findIndex(([, , kinds]) => kinds.includes(kind));
    // 归不到某一项的失败（限流、服务商出错、没有内容）：有 HTTP 回答就说明地址通了，其余没检查到。请求没发出去时一项都没检查
    const reached = !sent ? 0 : kind === 'ok' ? CONNECTION_CHECKS.length : failed >= 0 ? failed : (status ? 1 : 0);
    return CONNECTION_CHECKS.map(([id, [zh, en]], index) => ({
        id, label: tr(zh, en),
        state: index < reached ? 'ok' : index === failed ? 'fail' : 'skip',
    }));
}

const API_URL_EXAMPLE = 'https://api.example.com/v1/chat/completions';
const LM_STUDIO_URL = 'http://localhost:1234/v1/chat/completions';
const LOCAL_MODEL_EXAMPLE = 'qwen3:8b';
const LOCAL_MODEL_DEFAULT_URL = PROVIDERS.local.url;


// 1.7 以前的密钥格式：__ENC__:命名空间:密文，口令写死在插件里。只为迁移读一次，不再写
async function readLegacyKey(value) {
    if (!value.startsWith('__ENC__:')) return value;
    const payload = value.split(':').slice(2).join(':');
    const bytesOf = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
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

// 已知服务商的密钥用各插件共用的名字（如 deepseek-api-key），在别的插件里填过就能直接选；
// 自定义地址和本地服务用本插件自己的名字
const SHARED_KEY_PROVIDERS = ['deepseek', 'qwen', 'siliconflow', 'kimi', 'zhipu', 'gemini'];
function secretNamesFor(config) {
    const id = String(config.id || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
    const own = `ai-assistant-suite-${id}-api-key`;
    return SHARED_KEY_PROVIDERS.includes(config.apiProvider) ? [`${config.apiProvider}-api-key`, own] : [own];
}

// 存到第一个空着或已是同一个值的名字下，不覆盖别的插件存的密钥
function storeSecret(storage, names, value) {
    const last = names[names.length - 1];
    const candidates = [...names, ...Array.from({ length: 98 }, (_, i) => `${last}-${i + 2}`)];
    const name = candidates.find(n => { const existing = storage.getSecret(n); return !existing || existing === value; });
    storage.setSecret(name, value);
    return name;
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

// English versions of the default prompts. A prompt still equal to its Chinese default is sent in
// English when the interface is English; a prompt the user edited is always sent as written.
const STRUCTURIZER_DEFAULT_PROMPT_EN = `You are a precise editor who structures notes. Improve the structure and readability of the text below while following these rules strictly.

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

const MOVER_DEFAULT_PROMPT_EN = `You are a precise file organiser. Based on the note's content, choose or create the folder paths that suit it best, starting from the list of existing folders.

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

const TAGGER_DEFAULT_PROMPT_EN = `You are an Obsidian tagging expert who follows instructions exactly. Generate tags for the text below and keep strictly to the existing tag hierarchy.

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

const META_DEFAULT_PROMPT_EN = `You are an expert at analysing and summarising content. Based on the text below, do the following.

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

const TRANSLATION_DEFAULT_PROMPT_EN = `Translate each of the following English phrases into a very short, on-topic {{target_language}} tag (ideally 1–3 words). Put each translation on its own line, in the same order as the phrases. Reply with the translations only:
{{phrases_to_translate}}`;

const FURIGANA_DEFAULT_PROMPT_EN = `You are an expert at adding furigana to Japanese. Add readings (furigana / ruby) to the kanji in the text below.

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

const PROMPT_DEFAULTS = {
    structurizerPrompt: [STRUCTURIZER_DEFAULT_PROMPT, STRUCTURIZER_DEFAULT_PROMPT_EN],
    moverPrompt: [MOVER_DEFAULT_PROMPT, MOVER_DEFAULT_PROMPT_EN],
    taggerPrompt: [TAGGER_DEFAULT_PROMPT, TAGGER_DEFAULT_PROMPT_EN],
    metaPrompt: [META_DEFAULT_PROMPT, META_DEFAULT_PROMPT_EN],
    translationPrompt: [TRANSLATION_DEFAULT_PROMPT, TRANSLATION_DEFAULT_PROMPT_EN],
    furiganaPrompt: [FURIGANA_DEFAULT_PROMPT, FURIGANA_DEFAULT_PROMPT_EN],
};

const DEFAULT_SETTINGS = {
    // General API Settings
    activeConfigId: 'default',
    apiConfigs: [
        {
            id: 'default',
            name: 'DeepSeek',
            apiProvider: 'deepseek',
            apiUrl: '',
            modelName: 'deepseek-flash',
            auxiliaryModelName: '',
            deepseekThinking: false,
            enabled: true,
            allowFallback: false
        }
    ],

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
    sidebarLook: 'kit',

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




};

class AssistantNotePreview extends ItemView {
    constructor(leaf,plugin){super(leaf);this.plugin=plugin;}
    getViewType(){return 'ai-assistant-note-preview';}
    getDisplayText(){return tr('笔记整文预览', 'Whole-note preview');}
    getIcon(){return 'file-check';}
    async onOpen(){this.contentEl.createEl('p',{text:tr('在笔记助手中选择正文建议。', 'Choose a text suggestion in the note assistant.')});}
    async showTask(task){
        this.contentEl.empty();
        this.contentEl.addClass('ap', 'sn-document-preview');
        this.contentEl.createEl('p',{text:tr('整文预览 · 原笔记尚未修改', 'Whole-note preview · the note is not changed yet'),cls:'sn-muted'});
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
    getDisplayText() { return this.expanded ? tr("笔记工作台", 'Note workbench') : tr("笔记助手", 'Note assistant'); }
    getIcon() { return "anchor"; }

    async onOpen() {
        if (!this.fileWatcherRef) this.setupFileWatcher();
        this.render();
        this.contentEl?.addClass('ai-assistant-u-scroll-y');
    }

    onClose() {
        this.documentRenderVersion = (this.documentRenderVersion || 0) + 1;
        if (this.plugin.view === this) {
            const otherType = this.expanded ? ASSISTANT_VIEW_TYPE : ASSISTANT_WORKBENCH_TYPE;
            this.plugin.view = this.plugin.app.workspace.getLeavesOfType(otherType)[0]?.view || null;
        }
        // 清理文件监听
        if (this.refreshTimeout) window.clearTimeout(this.refreshTimeout);
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
                    window.clearTimeout(this.refreshTimeout);
                }
                this.refreshTimeout = window.setTimeout(() => {
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
        container.addClass('mist-sidebar-host');
        const root = container.createDiv({ cls: 'ap ap-view mist-sidebar' });
        if (this.plugin.settings.sidebarCompact !== false) root.addClass('mist-compact');
        const paper = this.plugin.settings.sidebarLook === 'paper';
        container.toggleClass('is-paper', paper);
        root.toggleClass('is-paper', paper);
        const page = this.workbenchPage || 'prepare';
        const activeNote = this.plugin.app.workspace.getActiveFile();
        if (activeNote?.extension === 'md') this.plugin.assistantLastFile = activeNote;
        const file = this.pinnedFile || (activeNote?.extension === 'md' ? activeNote : activeNote ? null : this.plugin.assistantLastFile || null);
        const busy = !!this.workbenchRunning || this.tasks.some(t => t.status === 'loading');
        const groups = this.getNoteGroups();

        const head = root.createDiv({ cls: 'mist-head' });
        head.createEl('h3', { text: tr('笔记助手', 'Note assistant'), cls: 'mist-title' });
        const more = head.createEl('button', { cls: 'clickable-icon mist-more', attr: { 'aria-label': tr('更多', 'More'), 'aria-haspopup': 'menu' } });
        setIcon?.(more, 'ellipsis');
        more.onclick = event => this.openMistMenu(event);

        // Only two places in daily use: choosing what to do, and reviewing what the AI proposed.
        const pending = groups.filter(g => this.noteStatus(g) === '待确认').length;
        const views = root.createEl('nav', { cls: 'mist-views', attr: { 'aria-label': tr('笔记助手视图', 'Note assistant views') } });
        for (const [id, label] of [['prepare', tr('整理', 'Tidy')], ['review', pending ? tr(`本篇建议 · ${pending}`, `This note · ${pending}`) : tr('本篇建议', 'This note')]]) {
            const button = views.createEl('button', { text: label, cls: 'mist-view', attr: { 'aria-current': page === id ? 'page' : 'false' } });
            button.onclick = () => { this.workbenchPage = id; this.render(); this.plugin.refreshAssistantViews?.(this); };
        }

        const body = root.createDiv({ cls: 'mist-body' });
        if (!['prepare', 'review'].includes(page)) {
            body.createEl('button', { text: tr('← 回到整理', '← Back to Tidy'), cls: 'mist-back' }).onclick = () => { this.workbenchPage = 'prepare'; this.render(); };
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
            actions.createEl('button', { text: tr('回滚上次修改', 'Undo last change'), cls: 'mist-link' }).onclick = () => this.plugin.rollbackLastChange();
            actions.createEl('button', { text: tr('重新应用刚才的回滚', 'Redo the undone change'), cls: 'mist-link' }).onclick = () => this.plugin.redoLastRollback();
            if (!this.plugin.getRecentHistory().length) this.renderMistEmpty(history, tr('还没有处理记录', 'No history yet'), tr('完成一次整理后，可以在这里找回笔记。', 'After your first run you can find notes here again.'));
            else this.renderRecentHistory(history);
            return;
        }
        if (page === 'tools') {
            const tools = body.createDiv({ cls: 'mist-tools' });
            this.renderQuickActions(tools);
            const diagnostics = tools.createEl('details', { cls: 'ai-assistant-diagnostics' });
            diagnostics.createEl('summary', { text: tr('使用情况与连接信息', 'Usage and connection') });
            this.renderUsageStats(diagnostics); this.renderFileInfo(diagnostics); this.renderAIStatus(diagnostics);
            return;
        }
        if (page === 'review') { this.renderMistReview(body, file, groups); return; }
        this.renderMistPrepare(body, file, busy);
    }

    mistSecondaryEntries() {
        return [
            [tr('处理记录', 'History'), () => { this.workbenchPage = 'history'; this.render(); }, 'history'],
            [tr('批量整理', 'Batch tidy'), () => this.showBatchProcessingModal(), 'files'],
            [tr('任务列表', 'Task list'), () => { this.workbenchPage = 'queue'; this.render(); }, 'list-checks'],
            [tr('自定义动作', 'Custom actions'), () => this.showAtelierCustomActions(), 'wand-sparkles'],
            [tr('其他工具', 'Other tools'), () => { this.workbenchPage = 'tools'; this.render(); }, 'wrench'],
            [tr('设置', 'Settings'), () => { this.plugin.app.setting.open(); this.plugin.app.setting.openTabById(this.plugin.manifest.id); }, 'settings']
        ];
    }

    openMistMenu(event) {
        const menu = new Menu();
        this.mistSecondaryEntries().forEach(([label, action, icon], index) => {
            if (index === 5) menu.addSeparator();
            menu.addItem(item => item.setTitle(label).setIcon(icon).onClick(action));
        });
        menu.showAtMouseEvent(event);
    }

    // 整理页下半部分：最近处理过的几篇，点一下打开
    renderMistRecent(container) {
        const recent = this.plugin.getRecentHistory()
            .map(item => ({ item, file: this.findFileByHistory(item) }))
            .filter((entry, index, all) => entry.file && all.findIndex(other => other.file === entry.file) === index)
            .slice(0, 5);
        if (!recent.length) return;
        const section = container.createDiv({ cls: 'mist-recent' });
        const label = section.createDiv({ cls: 'mist-recent-head' });
        label.createSpan({ text: tr('最近处理', 'Recent'), cls: 'mist-label' });
        label.createEl('button', { text: tr('全部', 'All'), cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'history'; this.render(); };
        const list = section.createDiv({ cls: 'mist-recent-list' });
        for (const { item, file } of recent) {
            const row = list.createEl('button', { cls: 'mist-recent-row', attr: { 'aria-label': tr(`打开 ${file.basename}`, `Open ${file.basename}`) } });
            setIcon?.(row.createSpan({ cls: 'mist-recent-icon', attr: { 'aria-hidden': 'true' } }), 'file-text');
            const copy = row.createSpan({ cls: 'mist-recent-copy' });
            copy.createSpan({ text: file.basename, cls: 'mist-recent-name' });
            copy.createSpan({ text: tr(`${item.action || '整理'} · ${this.mistTimeLabel(item.timestamp)}`, `${item.action || 'Tidy'} · ${this.mistTimeLabel(item.timestamp)}`), cls: 'mist-recent-meta' });
            row.onclick = () => this.plugin.app.workspace.getLeaf(false).openFile(file);
        }
    }

    mistTimeLabel(timestamp) {
        const when = new Date(timestamp || Date.now());
        const now = new Date();
        const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
        if (when.toDateString() === now.toDateString()) return tr(`今天 ${time}`, `Today ${time}`);
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        if (when.toDateString() === yesterday.toDateString()) return tr(`昨天 ${time}`, `Yesterday ${time}`);
        return tr(`${when.getMonth() + 1}月${when.getDate()}日`, `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
    }

    afterNoteApplied(group) {
        if (this.plugin.settings.sidebarAutoNext === false) return;
        const next = this.getNoteGroups().find(g => g.file !== group.file && this.noteStatus(g) === '待确认');
        if (next) this.selectedTaskId = next.tasks.at(-1).id;
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
                rename: !!this.plugin.settings.metaRenameDefault, diffId: diffs.at(-1)?.id || '', originalTaskId: latest?.id,
                originalPath: group.file.path, applied: [], skipped: [] };
        }
        return anchor.content.noteDraft;
    }

    // 状态键保持中文（逻辑里用来比较），显示时再翻
    statusLabel(status) {
        return { '已确认': tr('已确认', 'Confirmed'), '需重试': tr('需重试', 'Retry'), '待确认': tr('待确认', 'To confirm') }[status] || status;
    }

    // 使用统计的键是存进 data.json 的中文名，显示时再翻
    actionLabel(key) {
        const en = { '标签': 'Tags', '结构': 'Structure', '元数据': 'Properties', '移动': 'Move', '假名': 'Furigana', '一键处理': 'One-click', '其他': 'Other' };
        return isChineseInterface() ? key : en[key] || key;
    }

    noteStatus(group) {
        if (group.tasks.at(-1)?.content.noteApplied) return '已确认';
        if (group.tasks.at(-1)?.type === 'error') return '需重试';
        return '待确认';
    }

    renderNoteQueue(container) {
        const groups = this.getNoteGroups();
        const count = status => groups.filter(g => this.noteStatus(g) === status).length;
        container.createEl('p', { text: tr(`${count('待确认')} 篇待确认 · ${count('已确认')} 篇已确认 · ${count('需重试')} 篇需重试`, `${count('待确认')} to confirm · ${count('已确认')} confirmed · ${count('需重试')} to retry`), cls: 'mist-caption' });
        container.createEl('button', { text: tr('＋ 批量整理笔记', '+ Batch tidy notes'), cls: 'mist-link' }).onclick = () => this.showBatchProcessingModal();
        this.queueSelection ||= new Set();
        for (const group of groups) {
            const row = container.createDiv({ cls: 'mist-queue-row' });
            const check = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': tr(`选择 ${group.file.basename}`, `Select ${group.file.basename}`) } });
            check.checked = this.queueSelection.has(group.file.path);
            check.disabled = this.noteStatus(group) !== '待确认';
            check.onchange = () => { check.checked ? this.queueSelection.add(group.file.path) : this.queueSelection.delete(group.file.path); };
            const copy = row.createDiv({ cls: 'mist-queue-name' });
            copy.createEl('strong', { text: group.file.basename });
            copy.createEl('small', { text: this.statusLabel(this.noteStatus(group)) });
            row.createEl('button', { text: tr('查看', 'View'), cls: 'mist-link' }).onclick = () => { this.selectedTaskId = group.tasks.at(-1).id; this.workbenchPage = 'review'; this.render(); };
        }
        if (!groups.length) this.renderMistEmpty(container, tr('还没有待确认的笔记', 'No notes to confirm'), tr('生成的建议会按笔记集中在这里。', 'Suggestions gather here, one note at a time.'));
        if (groups.length) {
            const foot = container.createDiv({ cls: 'mist-foot' });
            const apply = foot.createEl('button', { text: tr('接受勾选的笔记', 'Accept ticked notes'), cls: 'mist-primary' });
            apply.onclick = async () => {
                if (this.noteApplying) return;
                const chosen = groups.filter(g => this.queueSelection.has(g.file.path) && this.noteStatus(g) === '待确认');
                if (!chosen.length) { new Notice(tr('先勾选要接受的笔记。', 'Tick the notes to accept first.')); return; }
                this.noteApplying = true; apply.disabled = true; let done = 0;
                try {
                    for (const g of chosen) {
                        try { await this.acceptAllNote(g, this.noteDraft(g)); done++; }
                        catch (e) { new Notice(tr(`${g.file.basename}：${e.message}`, `${g.file.basename}: ${e.message}`), 6000); }
                    }
                } finally { this.noteApplying = false; this.queueSelection.clear(); this.render(); new Notice(tr(`已确认 ${done} / ${chosen.length} 篇。`, `Confirmed ${done} of ${chosen.length}.`)); }
            };
        }
        for (const task of this.tasks.filter(t => t.type === 'batch-process' && t.content?.canInterrupt)) this.renderTask(container, task);
    }

    // The note this panel is about: shown on both pages so the user always knows what will change.
    renderMistNote(container, file, allowSwap = true) {
        const note = container.createDiv({ cls: 'mist-note' });
        setIcon?.(note.createDiv({ cls: 'mist-note-glyph', attr: { 'aria-hidden': 'true' } }), 'file-text');
        const copy = note.createDiv({ cls: 'mist-note-copy' });
        copy.createEl('strong', { text: file ? file.basename : tr('选择一篇笔记', 'Choose a note') });
        copy.createEl('small', { text: file ? (file.parent?.path === '/' ? tr('笔记库根目录', 'Vault root') : (file.parent?.path || file.path)) : tr('打开或选择 Markdown 文件', 'Open or choose a Markdown file') });
        if (allowSwap) note.createEl('button', { text: file ? tr('换一篇', 'Change') : tr('选择笔记', 'Choose note'), cls: 'mist-link', attr: { 'aria-label': tr('选择要整理的笔记', 'Choose the note to tidy') } }).onclick = () => this.chooseAtelierNote();
    }

    // 空状态：一句发生了什么，最多一个下一步
    renderMistEmpty(container, title, text, action = null) {
        const empty = container.createDiv({ cls: 'mist-empty' });
        empty.createEl('strong', { text: title });
        empty.createEl('p', { text });
        if (action) empty.createEl('button', { text: action[0], cls: 'mist-primary' }).onclick = action[1];
        return empty;
    }

    openPluginSettings() {
        this.plugin.app.setting.open();
        this.plugin.app.setting.openTabById(this.plugin.manifest.id);
    }

    renderMistPrepare(body, file, busy) {
        const chosen = this.sessionActions || this.plugin.settings.oneClickProcessActions || {};
        const actions = [['meta', tr('标题与摘要', 'Title & summary'), tr('补全笔记属性', 'Fill in properties')], ['tagger', tr('标签', 'Tags'), tr('连接已有分类', 'Link to existing tags')], ['mover', tr('归档', 'Folder'), tr('建议存放位置', 'Suggest where it goes')], ['furigana', tr('假名', 'Furigana'), tr('给日文加读音', 'Add readings to Japanese')], ['structurizer', tr('整理正文', 'Tidy text'), tr('梳理段落与标题', 'Sort paragraphs and headings')]];
        const configured = this.plugin.hasUsableConfig();
        if (!configured) {
            this.renderMistEmpty(body, tr('还没连上 AI 服务', 'No AI service connected yet'),
                tr('先看一个示例：建议是预先写好的，不联网，不花钱。', 'See an example first: the suggestions are pre-written, nothing is sent and nothing is charged.'),
                [tr('载入示例', 'Load example'), () => this.plugin.loadDemo()]).addClass('mist-setup');
        }
        this.renderMistNote(body, file);
        body.createEl('p', { text: tr('想做什么', 'What to do'), cls: 'mist-label' });
        const list = body.createDiv({ cls: 'mist-acts', attr: { role: 'group', 'aria-label': tr('选择处理功能', 'Choose actions') } });
        for (const [key, label, hint] of actions) {
            const on = !!chosen[key];
            const pill = list.createEl('button', { cls: on ? 'mist-act is-on' : 'mist-act', attr: { 'data-action': key, 'aria-pressed': String(on), title: hint } });
            pill.createSpan({ text: label });
            pill.onclick = () => { this.sessionActions = { ...chosen, [key]: !on }; this.render(); };
        }
        // 打开了手账写法时，整理正文可以选：原话优先，或者时间线和对话里允许缩写
        if (chosen.structurizer && this.plugin.notebookMarks?.()) {
            const condense = this.sessionCondense ?? !!this.plugin.settings.structurizerCondense;
            const seg = body.createDiv({ cls: 'mist-seg', attr: { role: 'group', 'aria-label': tr('手账整理方式', 'Notebook tidy mode') } });
            for (const [value, label, hint] of [[false, tr('原话优先', 'Keep wording'), tr('原话一字不改', 'Original words untouched')], [true, tr('允许缩写', 'Allow condensing'), tr('时间线和对话里可以压成一行', 'Timelines and chats may be condensed')]]) {
                const btn = seg.createEl('button', { text: label, cls: condense === value ? 'mist-seg-btn is-on' : 'mist-seg-btn', attr: { 'aria-pressed': String(condense === value), title: hint } });
                btn.onclick = () => { this.sessionCondense = value; this.render(); };
            }
        }
        const ask = body.createEl('label', { cls: 'mist-ask' });
        ask.createSpan({ text: tr('补充一句（可不填）', 'Add a note (optional)') });
        const input = ask.createEl('textarea', { attr: { rows: '1', placeholder: tr('例如：标签尽量用库里已有的', 'For example: prefer tags already in the vault'), 'aria-label': tr('补充要求', 'Extra request') } });
        input.value = this.sessionInstruction || '';
        input.oninput = () => { this.sessionInstruction = input.value; };

        const selected = actions.filter(([key]) => chosen[key]);
        const go = body.createDiv({ cls: 'mist-go' });
        go.createEl('small', { text: !configured ? tr('先在设置里连上 AI 服务', 'Connect an AI service in settings first') : !file ? tr('先打开一篇 Markdown 笔记', 'Open a Markdown note first') : selected.length ? tr('结果集中在这篇，原文先不动', 'Results gather here; the note is untouched for now') : tr('至少选一件事', 'Pick at least one action'), cls: 'mist-caption' });
        const run = go.createEl('button', { text: busy ? tr('正在生成…', 'Generating…') : tr('生成建议 →', 'Generate suggestions →'), cls: 'mist-primary', attr: { 'aria-label': tr('为当前笔记生成修改建议', 'Generate suggestions for the current note') } });
        run.disabled = !configured || !file || !selected.length || busy;
        run.onclick = async () => {
            if (this.workbenchRunning || !file) return;
            this.workbenchRunning = true; this.workbenchCancelled = false; this.workbenchPage = 'review';
            this.render(); this.plugin.refreshAssistantViews?.(this);
            this.plugin.condenseOverride = this.sessionCondense;
            try { await this.plugin.runOneClickSmartProcess(file, { ...chosen }, () => this.workbenchCancelled, this.sessionInstruction || ''); }
            finally { this.plugin.condenseOverride = undefined; this.workbenchRunning = false; this.render(); this.plugin.refreshAssistantViews?.(this); }
        };
        if (busy) this.renderCurrentRequestBanner(body);

        this.renderMistRecent(body);
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
                const select = body.createEl('select', { cls: 'mist-select', attr: { 'aria-label': tr('选择处理结果', 'Choose a result') } });
                for (const t of loose) select.createEl('option', { value: t.id, text: tr(`${t.status === 'loading' ? '生成中 · ' : t.content?.applied ? '已接受 · ' : ''}${t.title || '处理结果'}`, `${t.status === 'loading' ? 'Generating · ' : t.content?.applied ? 'Accepted · ' : ''}${t.title || 'Result'}`) });
                select.value = task.id;
                select.onchange = () => { this.selectedTaskId = select.value; this.render(); };
            }
            this.renderTask(body, task);
            return;
        }
        if (this.workbenchRunning) {
            this.renderMistEmpty(body, tr('正在准备建议', 'Preparing suggestions'), this.plugin.currentProgress || tr('正在读取笔记，原文不会被改动。', 'Reading the note; the original is not changed.'));
        } else if (this.plugin.lastCancelled && file && this.plugin.lastCancelled === file.path) {
            this.renderMistEmpty(body, tr('已取消', 'Cancelled'), tr('原文没有改动。', 'The note was not changed.'),
                [tr('重新生成', 'Generate again'), () => { this.workbenchPage = 'prepare'; this.render(); }]);
        } else {
            this.renderMistEmpty(body, tr('这里会出现这篇的建议', 'Suggestions for this note appear here'), tr('在“整理”里选好要做的事，生成后集中在这里确认。', 'Choose what to do under Tidy; the suggestions gather here for you to confirm.'),
                [tr('去整理', 'Go to Tidy'), () => { this.workbenchPage = 'prepare'; this.render(); }]);
        }
    }

    renderMistNoteReview(body, group, groups) {
        const draft = this.noteDraft(group);
        draft.applied ||= []; draft.skipped ||= [];
        const suggestions = group.tasks.filter(t => t.type === 'one-click').at(-1)?.content.suggestions || {};
        const status = this.noteStatus(group);
        const done = status === '已确认';
        // 以前整篇一次确认的结果：没有分块记录，只能整篇撤销
        const wholeDone = done && !draft.applied.length;
        const busy = !!this.noteApplying || !!this.workbenchRunning;
        this.renderMistNote(body, group.file, false);
        if (group.tasks.some(t => t.content?.demo)) {
            const configured = this.plugin.hasUsableConfig();
            this.renderMistEmpty(body, tr('这是演示', 'This is a demo'),
                tr('下面的建议是预先写好的，没有联网，也没有花钱。可以照常应用和撤销，只会改这篇示例笔记。', 'The suggestions below are pre-written; nothing was sent or charged. You can apply and undo them as usual; only this example note changes.'),
                configured ? [tr('删除示例笔记', 'Delete example note'), () => this.plugin.removeDemo()] : [tr('连接 AI 服务', 'Connect an AI service'), () => this.openPluginSettings()]).addClass('mist-demo');
        }
        const { parts, fm } = this.plugin.notePartsInfo(group, draft);
        const keys = Object.keys(parts);
        const others = groups.filter(g => g !== group && this.noteStatus(g) === '待确认').length;
        // 每行自己说明状态（没勾、已应用、不要），这里只留行里看不出来的：生成失败、还有别的笔记在等
        const state = status === '需重试' || others ? body.createDiv({ cls: 'mist-state' }) : null;
        if (status === '需重试') state.createSpan({ text: tr('生成失败 · 原文没有改动', 'Failed · the note was not changed'), cls: 'mist-dot is-done' });
        if (others) state.createEl('button', { text: tr(`还有 ${others} 篇`, `${others} more`), cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'queue'; this.render(); };

        const run = async (work) => {
            if (this.noteApplying) return;
            this.noteApplying = true; this.render();
            try { await work(); }
            catch (e) { new Notice(e.message, 7000); }
            finally { this.noteApplying = false; this.render(); this.plugin.refreshAssistantViews?.(this); }
        };
        const setParts = next => run(async () => {
            const wasDone = this.noteStatus(group) === '已确认';
            await this.plugin.setNoteParts(group, draft, next);
            if (!wasDone && this.noteStatus(group) === '已确认') this.afterNoteApplied(group);
        });
        // 每块一行：勾、名字、一句改了什么、一个按钮。点这一行才展开编辑，一次只开一行。
        const openKey = this.openPart?.path === group.file.path ? this.openPart.key : '';
        const list = body.createDiv({ cls: 'mist-rows', attr: { role: 'list' } });
        const row = (key, title, summary, doneText, canApply = true, warn = false) => {
            const applied = draft.applied.includes(key), skipped = draft.skipped.includes(key);
            const open = !applied && !skipped && !wholeDone && openKey === key;
            const el = list.createDiv({ cls: `mist-row${applied ? ' is-applied' : skipped ? ' is-skipped' : ''}${open ? ' is-open' : ''}`, attr: { role: 'listitem', 'data-part': key } });
            const line = el.createDiv({ cls: 'mist-row-line' });
            const main = line.createEl('button', { cls: 'mist-row-main', attr: { 'aria-expanded': String(open) } });
            // 行首：没应用时是这一块的图标，应用后换成勾
            if (applied) main.createSpan({ text: '✓', cls: 'mist-tick', attr: { 'aria-hidden': 'true' } });
            else setIcon?.(main.createSpan({ cls: 'mist-row-icon', attr: { 'aria-hidden': 'true' } }), { meta: 'heading', defaults: 'list-plus', tags: 'tag', folder: 'folder', style: 'palette', body: 'file-text' }[key] || 'dot');
            main.createSpan({ text: title, cls: 'mist-row-title' });
            const sumText = applied ? doneText : skipped ? tr('不要', 'Left out') : summary;
            main.createSpan({ text: sumText, cls: warn && !applied && !skipped ? 'mist-row-sum is-warn' : 'mist-row-sum', attr: { title: sumText } });
            main.disabled = applied || skipped || wholeDone;
            main.onclick = () => { this.openPart = open ? null : { path: group.file.path, key }; this.render(); };
            if (wholeDone) return null;
            const act = (text, cls, label, fn) => { const btn = line.createEl('button', { text, cls, attr: { 'aria-label': label } }); btn.disabled = busy; btn.onclick = fn; return btn; };
            if (applied) { act(tr('撤销', 'Undo'), 'mist-link', tr(`撤销${title}`, `Undo ${title}`), () => setParts(draft.applied.filter(k => k !== key))); return null; }
            if (skipped) { act(tr('恢复', 'Restore'), 'mist-link', tr(`恢复${title}`, `Restore ${title}`), () => { draft.skipped = draft.skipped.filter(k => k !== key); this.render(); }); return null; }
            if (canApply) act(tr('应用', 'Apply'), 'mist-row-apply', tr(`应用${title}`, `Apply ${title}`), () => setParts([...draft.applied, key]));
            else line.createSpan({ text: '›', cls: 'mist-row-more', attr: { 'aria-hidden': 'true' } });
            if (!open) return null;
            const panel = el.createDiv({ cls: 'mist-row-body' });
            // 编辑区在前，“这块不要”放最后
            const tail = () => { const no = panel.createEl('button', { text: tr('这块不要', 'Leave this out'), cls: 'mist-link mist-row-skip' }); no.disabled = busy; no.onclick = () => { draft.skipped = [...draft.skipped, key]; this.openPart = null; this.render(); }; };
            return { panel, tail };
        };

        if (parts.meta) {
            const fields = [['title', tr('标题', 'Title')], ['summary', tr('摘要', 'Summary')], ['tldr', tr('一句话总结', 'One-line summary')]];
            const changed = fields.filter(([k]) => String(draft.meta[k] ?? '').trim() && String(draft.meta[k]).trim() !== String(fm[k] ?? '').trim()).length;
            const r = row('meta', tr('标题与摘要', 'Title & summary'), tr(`改 ${changed} 项${draft.rename ? ' · 文件也改名' : ''}`, `${changed} changed${draft.rename ? ' · file renamed too' : ''}`),
                tr(`已写入${draft.rename ? ' · 文件已改名' : ''}`, `Written${draft.rename ? ' · file renamed' : ''}`), changed > 0 || !!draft.rename);
            if (r) {
                for (const [key, label] of fields) {
                    const input = r.panel.createEl('textarea', { cls: `mist-edit mist-edit-${key}`, attr: { rows: key === 'title' ? '1' : '2', 'aria-label': label, placeholder: label } });
                    input.value = draft.meta[key] || '';
                    input.oninput = () => { draft.meta[key] = input.value; };
                    input.onchange = () => this.render();
                }
                const rename = r.panel.createEl('label', { cls: 'mist-rename' });
                const check = rename.createEl('input', { type: 'checkbox' }); check.checked = draft.rename;
                rename.createSpan({ text: tr('同时用标题重命名文件', 'Also rename the file to the title') });
                check.onchange = () => { draft.rename = check.checked; this.render(); };
                r.tail();
            }
        }
        if (parts.defaults) {
            const text = parts.defaults.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
            row('defaults', tr('补上属性', 'Add properties'), text, tr('已补上', 'Added'))?.tail();
        }
        if (parts.tags) {
            const first = draft.tags[0];
            const r = row('tags', tr('标签', 'Tags'), first ? `${first}${draft.tags.length > 1 ? ` +${draft.tags.length - 1}` : ''}` : tr('都去掉了', 'All removed'),
                tr(`已加 ${draft.tags.length} 个`, `${draft.tags.length} added`), draft.tags.length > 0);
            if (r) {
                const chips = r.panel.createDiv({ cls: 'mist-chips' });
                for (const tag of suggestions.tags) {
                    const value = tag.final || tag.display || tag;
                    const kept = draft.tags.includes(value);
                    const chip = chips.createEl('button', { text: `#${value}`, cls: kept ? 'mist-chip' : 'mist-chip is-off', attr: { 'aria-pressed': String(kept) } });
                    chip.onclick = () => { draft.tags = kept ? draft.tags.filter(t => t !== value) : [...draft.tags, value]; this.render(); };
                }
                r.tail();
            }
        }
        if (parts.folder) {
            const isNew = p => !this.plugin.app.vault.getAbstractFileByPath(p)?.children;
            const tailPath = draft.folder.split('/').length > 2 ? `…/${draft.folder.split('/').slice(-2).join('/')}` : draft.folder;
            const r = row('folder', tr('归档', 'Folder'), `→ ${tailPath}${isNew(draft.folder) ? tr(' · 新建', ' · new') : ''}`, tr(`已移到 ${draft.folder}`, `Moved to ${draft.folder}`));
            if (r) {
                const alts = suggestions.mover.map(v => v.path).filter(p => p && p !== draft.folder);
                if (alts.length) {
                    const altRow = r.panel.createDiv({ cls: 'mist-alts' });
                    altRow.createSpan({ text: tr('也可以放：', 'Or:') });
                    for (const p of alts) {
                        const alt = altRow.createEl('button', { text: p, cls: 'mist-alt' });
                        if (isNew(p)) alt.createSpan({ text: tr(' · 新', ' · new'), cls: 'mist-alt-new' });
                        alt.onclick = () => { draft.folder = p; this.render(); };
                    }
                }
                const other = r.panel.createEl('select', { cls: 'mist-select', attr: { 'aria-label': tr('其他文件夹', 'Other folder') } });
                other.createEl('option', { value: '', text: tr('其他文件夹…', 'Other folder…') });
                for (const f of this.plugin.app.vault.getAllLoadedFiles().filter(f => f.children)) other.createEl('option', { value: f.path, text: f.path });
                other.onchange = () => { if (other.value) { draft.folder = other.value; this.render(); } };
                r.tail();
            }
        }
        if (parts.style) {
            const chosen = parts.style.filter(p => draft.style?.[p.key]);
            const name = p => p.key === 'sub' ? tr('副题', 'Subtitle') : p.key === 'card' ? tr('卡片', 'Card') : tr('旧纸', 'Old paper');
            const r = row('style', tr('样式', 'Style'), chosen.length ? chosen.map(name).join(' · ') : tr(`${parts.style.map(name).join(' · ')} · 没勾`, `${parts.style.map(name).join(' · ')} · none ticked`),
                tr(`已加 ${chosen.length} 个`, `${chosen.length} added`), chosen.length > 0);
            if (r) {
                for (const p of parts.style) {
                    const item = r.panel.createEl('label', { cls: 'mist-rename' });
                    const check = item.createEl('input', { type: 'checkbox' }); check.checked = !!draft.style?.[p.key];
                    item.createSpan({ text: p.key === 'sub' ? tr(`副题：${p.text}`, `Subtitle: ${p.text}`) : p.key === 'card' ? tr(`卡片 ${p.cls}`, `Card ${p.cls}`) : tr(`旧纸 ${p.cls} · ${p.days} 天`, `Old paper ${p.cls} · ${p.days} days`) });
                    check.onchange = () => { draft.style = { ...(draft.style || {}), [p.key]: check.checked }; this.render(); };
                }
                r.tail();
            }
        }
        const diffs = group.tasks.filter(t => t.type === 'diff-preview' && !t.content.applied);
        if (parts.body) {
            const chosenDiff = diffs.find(t => t.id === draft.diffId);
            const shrink = this.plugin.shrinkWarning(chosenDiff);
            let stat = tr('先选一个版本', 'Choose a version first');
            if (chosenDiff) {
                const hunks = chosenDiff.content.reviewHunks || this.plugin.buildReviewHunks(chosenDiff.content.originalContent, chosenDiff.content.proposedContent);
                const lost = Math.round((1 - String(chosenDiff.content.proposedContent || '').length / Math.max(1, String(chosenDiff.content.originalContent || '').length)) * 100);
                stat = tr(`${shrink ? `短了 ${lost}% · ` : ''}${hunks.length} 处改动`, `${shrink ? `${lost}% shorter · ` : ''}${hunks.length} changes`);
                // 手账整理：说清放了几张纸片、去掉了几行重复属性；原话被改了放最前面
                const nb = chosenDiff.content.notebook;
                if (nb) stat = tr([nb.changed ? `改了 ${nb.changed} 句原话` : '', `${nb.cards} 张纸片`, nb.dupLines ? `去掉 ${nb.dupLines} 行重复属性` : ''].filter(Boolean).join(' · '),
                    [nb.changed ? `${nb.changed} sentences reworded` : '', `${nb.cards} cards`, nb.dupLines ? `${nb.dupLines} repeated property lines removed` : ''].filter(Boolean).join(' · '));
            }
            const bodyWarn = !!shrink && !chosenDiff?.content.notebook || !!chosenDiff?.content.notebook?.changed;
            const r = row('body', tr('正文', 'Text'), stat, tr('已替换', 'Replaced'), !!chosenDiff, bodyWarn);
            if (r) {
                const note = r.panel.createDiv({ cls: 'mist-body-note' });
                if (diffs.length > 1 || !draft.diffId) {
                    const select = note.createEl('select', { cls: 'mist-select', attr: { 'aria-label': tr('选择正文版本', 'Choose a text version') } });
                    select.createEl('option', { value: '', text: tr('保留当前正文', 'Keep current text') });
                    for (const task of diffs) select.createEl('option', { value: task.id, text: task.content.action || task.title });
                    select.value = draft.diffId;
                    select.onchange = () => { draft.diffId = select.value; this.render(); };
                } else {
                    note.createSpan({ text: chosenDiff?.content.action || chosenDiff?.title || tr('已生成整理后的正文', 'Tidied text is ready') });
                }
                const look = note.createEl('button', { text: tr('对比 ↗', 'Compare ↗'), cls: 'mist-link is-strong', attr: { 'aria-label': tr('在新标签页对比整理前后', 'Compare before and after in a new tab') } });
                look.onclick = () => { if (chosenDiff) this.plugin.openNotePreview(chosenDiff); else new Notice(tr('先选择一个正文版本。', 'Choose a text version first.')); };
                if (shrink) r.panel.createDiv({ text: shrink, cls: 'mist-caption is-warn', attr: { role: 'alert' } });
                r.tail();
            }
        }
        const error = group.tasks.at(-1)?.type === 'error' ? group.tasks.at(-1) : null;
        if (!error && !wholeDone && !keys.length) {
            this.renderMistEmpty(body, tr('这次没有建议', 'No suggestions this time'), tr('AI 认为这篇不需要改，原文没有改动。', 'The AI found nothing to change; the note is untouched.'),
                [tr('换个功能再试', 'Try other actions'), () => { this.workbenchPage = 'prepare'; this.render(); }]);
        }
        if (error) {
            const problem = error.content.kind && error.content.kind !== 'other' ? describeApiProblem(error.content.kind, this.plugin.getActiveApiConfig()) : null;
            body.createEl('p', { text: problem ? `${problem.message} ${problem.next}` : error.content.message, cls: 'mist-caption' });
            body.createEl('button', { text: tr('重新生成本篇建议', 'Generate again'), cls: 'mist-link is-strong' }).onclick = async () => {
                if (this.workbenchRunning) return;
                this.workbenchRunning = true;
                try { await this.plugin.runOneClickSmartProcess(group.file); } finally { this.workbenchRunning = false; this.render(); }
            };
        }
        // 底部固定：一次接受剩下的，或一次撤销整篇
        const plan = this.acceptAllPlan(group, draft, parts);
        const foot = body.createDiv({ cls: 'mist-foot is-sticky' });
        if (wholeDone || (draft.applied.length && !plan.accept.length)) {
            foot.createEl('button', { text: tr('稍后再看', 'Later'), cls: 'mist-link' }).onclick = () => { this.workbenchPage = 'queue'; this.render(); };
            const undo = foot.createEl('button', { text: tr('撤销这篇', 'Undo this note'), cls: 'mist-primary is-quiet' });
            undo.disabled = busy;
            undo.onclick = () => run(async () => { await (draft.applied.length ? this.plugin.setNoteParts(group, draft, []) : this.plugin.undoNoteGroup(group)); draft.skipped = []; });
            return;
        }
        if (!keys.length) return;
        if (draft.applied.length) foot.createEl('button', { text: tr('撤销这篇', 'Undo this note'), cls: 'mist-link' }).onclick = () => run(async () => { await this.plugin.setNoteParts(group, draft, []); draft.skipped = []; });
        else foot.createSpan();
        const all = foot.createEl('button', { text: tr(`全部接受 · ${plan.accept.length} 项`, `Accept all · ${plan.accept.length}`), cls: 'mist-primary' });
        all.disabled = busy || !plan.accept.length;
        all.onclick = () => this.acceptAllNote(group, draft, run);
    }

    // 全部接受：剩下没定的块里，有内容可写的接受；什么都没勾的（比如样式一个没勾）算跳过
    acceptAllPlan(group, draft, parts = this.plugin.notePartsInfo(group, draft).parts) {
        const pending = Object.keys(parts).filter(k => !(draft.applied || []).includes(k) && !(draft.skipped || []).includes(k));
        const empty = k => (k === 'tags' && !draft.tags.length) || (k === 'style' && !parts.style.some(p => draft.style?.[p.key])) || (k === 'body' && !draft.diffId);
        return { accept: pending.filter(k => !empty(k)), skip: pending.filter(empty) };
    }

    acceptAllNote(group, draft, run = work => work()) {
        const plan = this.acceptAllPlan(group, draft);
        return run(async () => {
            draft.skipped = [...(draft.skipped || []), ...plan.skip];
            await this.plugin.setNoteParts(group, draft, [...(draft.applied || []), ...plan.accept]);
            if (this.noteStatus(group) === '已确认') this.afterNoteApplied(group);
        });
    }

    chooseAtelierNote() {
        const choose = file => {
            this.plugin.assistantLastFile = file;
            this.pinnedFile = file;
            this.workbenchPage = 'prepare';
            this.render();
            this.plugin.refreshAssistantViews?.(this);
        };
        class NotePicker extends GlassFuzzySuggestModal {
            getItems(){return this.app.vault.getMarkdownFiles()}
            getItemText(file){return file.path}
            onChooseItem(file){choose(file)}
        }
        const picker=new NotePicker(this.plugin.app);picker.setPlaceholder(tr('选择要整理的笔记…', 'Choose the note to tidy…'));picker.open();
    }

    showAtelierCustomActions() {
        const modal=new GlassModal(this.plugin.app);modal.modalEl.addClass('assistant-atelier-modal');
        modal.contentEl.createEl('h2',{text:tr('按自己的方式处理', 'Your own way')});
        const actions=(this.plugin.settings.customActions||[]).filter(a=>a.enabled!==false);
        if(!actions.length)modal.contentEl.createEl('p',{text:tr('在插件设置中添加常用要求，保存为自定义动作。', 'Add frequent requests in plugin settings and save them as custom actions.')});
        for(const action of actions){
            const button=modal.contentEl.createEl('button',{text:action.name||tr('自定义动作', 'Custom actions'),cls:'at-custom-action'});
            button.onclick=()=>{modal.close();this.plugin.runCustomAction(action.id, this.pinnedFile || this.plugin.assistantLastFile)};
        }
        modal.contentEl.createEl('button',{text:tr('管理自定义动作', 'Manage custom actions'),cls:'at-custom-action'}).onclick=()=>{modal.close();this.plugin.app.setting.open();this.plugin.app.setting.openTabById(this.plugin.manifest.id)};
        modal.open();
    }

    openAtelierSettings() {
        const modal=new GlassModal(this.plugin.app);modal.modalEl.addClass('assistant-atelier-modal');
        modal.contentEl.createEl('h2',{text:tr('处理偏好', 'Preferences')});
        const chosen={...(this.plugin.settings.oneClickProcessActions||{})};
        for(const [key,label] of [['structurizer',tr('整理结构', 'Tidy structure')],['furigana',tr('日文注音', 'Japanese readings')],['meta',tr('补全属性', 'Fill properties')],['tagger',tr('补充标签', 'Add tags')],['mover',tr('建议位置', 'Suggest folder')]]){
            const row=modal.contentEl.createEl('label',{cls:'at-settings-row'});
            const check=row.createEl('input',{type:'checkbox'});check.checked=!!chosen[key];
            row.createSpan({text:label});check.onchange=()=>{chosen[key]=check.checked};
        }
        const buttons=modal.contentEl.createDiv({cls:'at-settings-actions'});
        const save=buttons.createEl('button',{text:tr('保存默认步骤', 'Save default steps'),cls:'mod-cta'});
        save.onclick=async()=>{save.disabled=true;this.plugin.settings.oneClickProcessActions=chosen;await this.plugin.saveSettings();modal.close();this.render();this.plugin.refreshAssistantViews?.(this);new Notice(tr('默认处理步骤已保存。', 'Default steps saved.'))};
        buttons.createEl('button',{text:tr('完整设置 ↗', 'Full settings ↗')}).onclick=()=>{modal.close();this.plugin.app.setting.open();this.plugin.app.setting.openTabById(this.plugin.manifest.id)};
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
        this.plugin.cancelCurrentRequest(tr('用户取消', 'Cancelled by user'));
    }

    renderCurrentRequestBanner(container) {
        if (!this.workbenchRunning && (!this.plugin.currentAbortController || this.plugin.currentAbortController.signal.aborted)) {
            return;
        }
        const banner = container.createDiv({ cls: "ai-assistant-active-request" });
        const label = this.plugin.currentProgress || this.plugin.currentRequestLabel || tr('AI 请求', 'AI request');
        banner.createEl("span", { text: label });
        const cancelButton = banner.createEl("button", { text: tr('取消', 'Cancel') });
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
        header.addClass('ai-assistant-u-header');

        // Add title to header
        header.createEl("h3", { text: task.title || tr('AI 处理结果', 'AI result') });

        const headerActions = header.createDiv();
        headerActions.addClass('ai-assistant-u-header-actions');

        // Add navigation button to header if file exists
        if (task.content && task.content.file) {
            const navButton = headerActions.createEl("button", { text: tr("定位笔记", 'Show note') });
            navButton.addEventListener("click", () => {
                this.plugin.app.workspace.getLeaf().openFile(task.content.file);
            });
        }

        if (task.status !== 'loading' && task.canClose !== false) {
            const closeButton = headerActions.createEl("button", {
                cls: "ai-assistant-card-close",
                text: "×"
            });
            closeButton.setAttr("aria-label", tr("关闭卡片", 'Close card'));
            closeButton.addEventListener("click", () => this.removeTask(task.id));
        }

        if (task.status === 'loading') {
            card.createEl("p", { text: task.message || tr("AI 正在处理中，请稍候...", 'The AI is working, please wait…') });
            const streamingContent = task.streamingContent || task.content?.streamingContent;
            const chars = streamingContent ? streamingContent.length : 0;
            const meta = card.createDiv({ cls: "ai-assistant-streaming-meta" });
            meta.setText(chars > 0 ? tr(`已收到 ${chars} 字`, `Received ${chars} characters`) : tr('正在生成，结果到齐后一次显示', 'Generating; the result appears when complete'));
            if (streamingContent) {
                const streamBox = card.createEl("pre", { cls: "ai-assistant-streaming-output" });
                streamBox.setText(streamingContent + '▌');
            }
            const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
            const cancelButton = buttonContainer.createEl("button", { text: tr("取消当前请求", 'Cancel request') });
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
            window.setTimeout(() => this.removeTask(task.id), 200);
            return;
        }

        let isFirstSection = true;

        if (hasMeta) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: tr('属性 · 标题与摘要', 'Properties · title & summary') });
            const content = details.createDiv();
            this.renderOneClickMetaSection(content, { ...task, meta: suggestions.meta });
        }
        if (hasTags) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: tr('属性 · 标签', 'Properties · tags') });
            const content = details.createDiv();
            this.renderOneClickTaggerSection(content, { ...task, tags: suggestions.tags });
        }
        if (hasMover) {
            const details = card.createEl('details', { cls: 'ai-assistant-collapsible-section' });
            if (isFirstSection) {
                details.setAttr('open', true);
                isFirstSection = false;
            }
            details.createEl('summary', { text: tr('位置 · 归档建议', 'Location · folder') });
            const content = details.createDiv();
            this.renderOneClickMoverSection(content, { ...task, mover: suggestions.mover });
        }

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: tr("全部跳过", 'Skip all') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderOneClickMetaSection(container, task) {
        container.addClass('ai-assistant-meta-section');
        const existing = this.plugin.app.metadataCache.getFileCache(task.content.file)?.frontmatter || {};
        const before = container.createEl('details', { cls: 'assistant-review-current-properties' });
        before.createEl('summary', { text: tr('查看当前属性', 'Current properties') });
        for (const key of ['title','summary','tldr']) before.createEl('p', { text: tr(`${key}: ${existing[key] ?? '未设置'}`, `${key}: ${existing[key] ?? 'not set'}`) });
        const { title, summary, tldr } = task.meta;



        // 创建可编辑的元数据字段
        const editableData = {
            title: title || '',
            summary: summary || '',
            tldr: tldr || ''
        };

        // 标题编辑区域
        const titleSection = container.createDiv({ cls: "meta-field-section" });
        titleSection.createEl("label", { text: tr("标题:", 'Title:'), cls: "meta-field-label" });
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
        summarySection.createEl("label", { text: tr("摘要:", 'Summary:'), cls: "meta-field-label" });
        const summaryTextarea = summarySection.createEl("textarea", {
            cls: "meta-field-textarea"
        });
        summaryTextarea.value = summary || '';
        summaryTextarea.placeholder = tr("请输入摘要...", 'Enter a summary…');
        summaryTextarea.addEventListener("input", (e) => {
            editableData.summary = e.target.value;
        });

        // 一句话总结编辑区域
        const tldrSection = container.createDiv({ cls: "meta-field-section" });
        tldrSection.createEl("label", { text: tr("一句话总结:", 'One-line summary:'), cls: "meta-field-label" });
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
        const renameButton = buttonContainer.createEl("button", { text: tr("重命名文件", 'Rename file'), cls: "mod-cta" });
        renameButton.addEventListener("click", async () => {
            const paths = getUpdatedPaths();
            if (!paths.canRename) {
                new Notice(tr("无法重命名：目标文件已存在或路径相同", 'Cannot rename: the target exists or the path is the same'));
                return;
            }

            let notice = new Notice(tr("正在重命名并更新元数据...", 'Renaming and updating properties…'), 0);
            try {
                // 使用安全重命名方法
                const newFile = await this.plugin.safeRenameFile(task.content.file, paths.newPath);

                // 更新元数据
                await this.plugin.updateFrontmatter(newFile, editableData.title, editableData.summary, editableData.tldr);
                notice.hide();
                new Notice(tr(`文件已重命名为: ${paths.finalFilename}.md`, `File renamed to: ${paths.finalFilename}.md`), 4000);

                // 添加到历史记录
                this.plugin.addToHistory(paths.finalFilename, newFile.path, tr("重命名+元数据", 'Rename + properties'), this.plugin.generateFileId(newFile));

                // 更新任务内容
                const newContent = { ...task.content, file: newFile };
                delete newContent.suggestions.meta;
                this.updateTask(task.id, { content: newContent });
            } catch (err) {
                notice.hide();
                console.error(tr("重命名错误详情:", 'Rename error details:'), err);

                // 提供更详细的错误信息和建议
                let errorMessage = tr(`重命名文件时出错: ${err.message}`, `Error renaming the file: ${err.message}`);
                let suggestions = [];

                if (err.message.includes(tr('已存在', 'already exists'))) {
                    suggestions.push(tr('请尝试使用不同的文件名', 'Try a different file name'));
                } else if (err.message.includes(tr('非法字符', 'invalid characters'))) {
                    suggestions.push(tr('请移除文件名中的特殊字符', 'Remove special characters from the file name'));
                } else if (err.message.includes(tr('过长', 'too long'))) {
                    suggestions.push(tr('请使用更短的文件名', 'Use a shorter file name'));
                } else if (err.message.includes(tr('找不到文件', 'Could not find'))) {
                    suggestions.push(tr('请稍后重试，或手动重命名文件', 'Try again later, or rename the file by hand'));
                }

                if (suggestions.length > 0) {
                    errorMessage += tr(`\n建议: ${suggestions.join(', ')}`, `\nSuggestions: ${suggestions.join(', ')}`);
                }

                new Notice(errorMessage, 8000);
            }
        });

        const noRenameButton = buttonContainer.createEl("button", { text: tr("仅更新元数据", 'Properties only') });
        noRenameButton.addEventListener("click", async () => {
            await this.plugin.updateFrontmatter(task.content.file, editableData.title, editableData.summary, editableData.tldr, false);
            new Notice(tr("元数据已更新，文件名保持不变。", 'Properties updated; the file name is unchanged.'));

            // 添加到历史记录
            this.plugin.addToHistory(task.content.file.basename, task.content.file.path, tr("更新元数据", 'Update properties'), this.plugin.generateFileId(task.content.file));

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
                label.addClass('ai-assistant-u-accent');
                label.setAttribute('title', tr('新建议的标签', 'Newly suggested tags'));
            }

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedTags.add(suggestion.final);
                else selectedTags.delete(suggestion.final);
            });
        });

        const buttonContainer = container.createDiv({ cls: "ai-assistant-button-container" });
        const confirmButton = buttonContainer.createEl("button", { text: tr("添加选中标签", 'Add selected tags'), cls: "mod-cta" });

        confirmButton.addEventListener("click", async () => {
            if (selectedTags.size === 0) return new Notice(tr("没有选择任何标签。", 'No tags selected.'));

            const tagsToAdd = Array.from(selectedTags);
            let notice = new Notice(tr(`正在更新笔记标签...`, `Updating tags…`), 0);
            try {
                await this.plugin.app.fileManager.processFrontMatter(task.content.file, (fm) => {
                    fm.tags = fm.tags || [];
                    const existingFmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : (fm.tags ? [String(fm.tags)] : []);
                    fm.tags = [...new Set([...existingFmTags, ...tagsToAdd])];
                });
                notice.hide();
                new Notice(tr("笔记标签已成功更新！", 'Tags updated.'), 5000);

                // 添加到历史记录
                this.plugin.addToHistory(task.content.file.basename, task.content.file.path, tr(`添加${tagsToAdd.length}个标签`, `Add ${tagsToAdd.length} tags`), this.plugin.generateFileId(task.content.file));

                const newContent = { ...task.content };
                delete newContent.suggestions.tags;
                this.updateTask(task.id, { content: newContent });
            } catch (e) {
                notice.hide();
                new Notice(tr(`更新标签失败: ${e.message}`, `Updating tags failed: ${e.message}`), 0);
            }
        });
    }

    renderOneClickMoverSection(container, task) {
        container.createEl('p', { text: tr(`当前位置：${task.content.file.path}`, `Current location: ${task.content.file.path}`), cls: 'assistant-review-path' });
        container.addClass('ai-assistant-mover-list');

        task.mover.forEach(suggestion => {
            const moverItem = container.createDiv({ cls: "ai-assistant-mover-item" });
            const pathDiv = moverItem.createDiv({ cls: "ai-assistant-mover-path" });

            const pathSpan = pathDiv.createEl("span", { text: suggestion.path });
            if (suggestion.is_new) {
                pathSpan.addClass('ai-assistant-u-accent');
                pathSpan.setAttribute('title', tr('将创建新文件夹', 'A new folder will be created'));
            }

            const button = moverItem.createEl("button", { text: tr("移动", 'Move'), cls: "mod-cta" });
            button.addEventListener("click", async () => {
                await this.moveFileToFolder(task, suggestion.path, suggestion.is_new);
            });
        });

        // 添加"选择其他位置"按钮
        const customMoverItem = container.createDiv({ cls: "ai-assistant-mover-item ai-assistant-custom-mover" });
        const customPathDiv = customMoverItem.createDiv({ cls: "ai-assistant-mover-path" });
        customPathDiv.createEl("span", {
            text: tr("选择其他位置...", 'Choose another location…'),
            cls: "custom-location-text"
        });

        const customButton = customMoverItem.createEl("button", { text: tr("浏览", 'Browse'), cls: "mod-secondary" });
        customButton.addEventListener("click", () => {
            this.showFolderSelectionForMove(task);
        });
    }

    // 提取移动文件的通用逻辑
    async moveFileToFolder(task, destinationFolder, isNew = false) {
        const newPath = `${destinationFolder}/${task.content.file.name}`;

        if (task.content.file.path === newPath) {
            new Notice(tr("文件已在目标文件夹中。", 'The file is already in that folder.'));
            return;
        }
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(tr(`目标位置已存在同名文件，无法移动。`, `A file with the same name exists there, so it was not moved.`));
            return;
        }

        let notice = new Notice(tr(`正在移动文件...`, `Moving file…`), 0);
        try {
            if (isNew && !await this.app.vault.adapter.exists(destinationFolder)) {
                await this.app.vault.createFolder(destinationFolder);
                new Notice(tr(`已创建新文件夹: ${destinationFolder}`, `Created folder: ${destinationFolder}`), 4000);
            }
            await this.app.fileManager.renameFile(task.content.file, newPath);
            notice.hide();
            new Notice(tr(`笔记已成功移动到: ${destinationFolder}`, `Note moved to: ${destinationFolder}`), 5000);

            const newFile = this.plugin.app.vault.getAbstractFileByPath(newPath);

            // 添加到历史记录
            this.plugin.addToHistory(newFile.basename, newFile.path, tr("移动文件", 'Move file'), this.plugin.generateFileId(newFile));

            const newContent = { ...task.content, file: newFile };
            delete newContent.suggestions.mover;
            this.updateTask(task.id, { content: newContent });

        } catch (err) {
            notice.hide();
            new Notice(tr(`移动文件时出错: ${err.message}`, `Error moving the file: ${err.message}`), 0);
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
                pathSpan.addClass('ai-assistant-u-accent');
                pathSpan.setAttribute('title', tr('将创建新文件夹', 'A new folder will be created'));
            }

            const button = moverItem.createEl("button", { text: tr("移动", 'Move'), cls: "mod-cta" });
            button.addEventListener("click", async () => {
                await this.moveFileToFolderStandalone(file, suggestion.path, suggestion.is_new, task.id);
            });
        });

        // 添加"选择其他位置"按钮
        const customMoverItem = card.createDiv({ cls: "ai-assistant-mover-item ai-assistant-custom-mover" });
        const customPathDiv = customMoverItem.createDiv({ cls: "ai-assistant-mover-path" });
        customPathDiv.createEl("span", {
            text: tr("选择其他位置...", 'Choose another location…'),
            cls: "custom-location-text"
        });

        const customButton = customMoverItem.createEl("button", { text: tr("浏览", 'Browse'), cls: "mod-secondary" });
        customButton.addEventListener("click", () => {
            this.showFolderSelectionForMoveStandalone(file, task.id);
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 独立Mover任务的移动文件逻辑
    async moveFileToFolderStandalone(file, destinationFolder, isNew = false, taskId) {
        const newPath = `${destinationFolder}/${file.name}`;

        if (file.path === newPath) {
            new Notice(tr("文件已在目标文件夹中。", 'The file is already in that folder.'));
            return;
        }
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(tr(`目标位置已存在同名文件，无法移动。`, `A file with the same name exists there, so it was not moved.`));
            return;
        }

        let moveNotice = new Notice(tr(`正在移动文件...`, `Moving file…`), 0);
        try {
            if (isNew && !await this.app.vault.adapter.exists(destinationFolder)) {
                await this.app.vault.createFolder(destinationFolder);
                new Notice(tr(`已创建新文件夹: ${destinationFolder}`, `Created folder: ${destinationFolder}`), 4000);
            }
            await this.app.fileManager.renameFile(file, newPath);
            moveNotice.hide();
            new Notice(tr(`笔记已成功移动到: ${destinationFolder}`, `Note moved to: ${destinationFolder}`), 5000);

            // 添加到历史记录
            const newFile = this.plugin.app.vault.getAbstractFileByPath(newPath);
            if (newFile) {
                this.plugin.addToHistory(newFile.basename, newFile.path, tr("移动文件", 'Move file'), this.plugin.generateFileId(newFile));
            }

            this.removeTask(taskId);
        } catch (err) {
            moveNotice.hide();
            new Notice(tr(`移动文件时出错: ${err.message}`, `Error moving the file: ${err.message}`), 0);
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
                label.addClass('ai-assistant-u-accent');
                label.setAttribute('title', tr('新建议的标签', 'Newly suggested tags'));
            }

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedTags.add(suggestion.final);
                else selectedTags.delete(suggestion.final);
            });
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const confirmButton = buttonContainer.createEl("button", { text: tr("添加选中标签", 'Add selected tags'), cls: "mod-cta" });
        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });

        cancelButton.addEventListener("click", () => this.removeTask(task.id));
        confirmButton.addEventListener("click", async () => {
            if (selectedTags.size === 0) return new Notice(tr("没有选择任何标签。", 'No tags selected.'));

            const tagsToAdd = Array.from(selectedTags);
            let updateNotice = new Notice(tr(`正在更新笔记标签...`, `Updating tags…`), 0);
            try {
                await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                    fm.tags = fm.tags || [];
                    const existingFmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : (fm.tags ? [String(fm.tags)] : []);
                    fm.tags = [...new Set([...existingFmTags, ...tagsToAdd])];
                });
                updateNotice.hide();
                new Notice(tr("笔记标签已成功更新！", 'Tags updated.'), 5000);

                // 添加到历史记录
                this.plugin.addToHistory(file.basename, file.path, tr(`添加${tagsToAdd.length}个标签`, `Add ${tagsToAdd.length} tags`), this.plugin.generateFileId(file));

                this.removeTask(task.id);
            } catch (e) {
                updateNotice.hide();
                new Notice(tr(`更新标签失败: ${e.message}`, `Updating tags failed: ${e.message}`), 0);
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
        titleSection.createEl("label", { text: tr("建议标题:", 'Suggested title:'), cls: "meta-field-label" });
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
        summarySection.createEl("label", { text: tr("摘要:", 'Summary:'), cls: "meta-field-label" });
        const summaryTextarea = summarySection.createEl("textarea", {
            cls: "meta-field-textarea"
        });
        summaryTextarea.value = summary || '';
        summaryTextarea.placeholder = tr("请输入摘要...", 'Enter a summary…');
        summaryTextarea.addEventListener("input", (e) => {
            editableData.summary = e.target.value;
        });

        // 一句话总结编辑区域
        const tldrSection = card.createDiv({ cls: "meta-field-section" });
        tldrSection.createEl("label", { text: tr("一句话总结:", 'One-line summary:'), cls: "meta-field-label" });
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
        const renameButton = buttonContainer.createEl("button", { text: tr("重命名文件", 'Rename file'), cls: "mod-cta" });
        renameButton.addEventListener("click", async () => {
            const paths = getUpdatedPaths();
            if (!paths.canRename) {
                new Notice(tr("无法重命名：目标文件已存在或路径相同", 'Cannot rename: the target exists or the path is the same'));
                return;
            }

            let renameNotice = new Notice(tr("正在重命名并更新元数据...", 'Renaming and updating properties…'), 0);
            try {
                // 使用安全重命名方法
                const newFile = await this.plugin.safeRenameFile(file, paths.newPath);

                // 更新元数据
                await this.plugin.updateFrontmatter(newFile, editableData.title, editableData.summary, editableData.tldr);
                renameNotice.hide();
                new Notice(tr(`文件已重命名为: ${paths.finalFilename}.md`, `File renamed to: ${paths.finalFilename}.md`), 4000);

                // 添加到历史记录
                this.plugin.addToHistory(paths.finalFilename, newFile.path, tr("重命名+元数据", 'Rename + properties'), this.plugin.generateFileId(newFile));

                this.removeTask(task.id);
            } catch (err) {
                renameNotice.hide();
                console.error(tr("重命名错误详情:", 'Rename error details:'), err);

                // 提供更详细的错误信息和建议
                let errorMessage = tr(`重命名文件时出错: ${err.message}`, `Error renaming the file: ${err.message}`);
                let suggestions = [];

                if (err.message.includes(tr('已存在', 'already exists'))) {
                    suggestions.push(tr('请尝试使用不同的文件名', 'Try a different file name'));
                } else if (err.message.includes(tr('非法字符', 'invalid characters'))) {
                    suggestions.push(tr('请移除文件名中的特殊字符', 'Remove special characters from the file name'));
                } else if (err.message.includes(tr('过长', 'too long'))) {
                    suggestions.push(tr('请使用更短的文件名', 'Use a shorter file name'));
                } else if (err.message.includes(tr('找不到文件', 'Could not find'))) {
                    suggestions.push(tr('请稍后重试，或手动重命名文件', 'Try again later, or rename the file by hand'));
                }

                if (suggestions.length > 0) {
                    errorMessage += tr(`\n建议: ${suggestions.join(', ')}`, `\nSuggestions: ${suggestions.join(', ')}`);
                }

                new Notice(errorMessage, 8000);
            }
        });

        const noRenameButton = buttonContainer.createEl("button", { text: tr("仅更新元数据", 'Properties only') });
        noRenameButton.addEventListener("click", async () => {
            await this.plugin.updateFrontmatter(file, editableData.title, editableData.summary, editableData.tldr);
            new Notice(tr("元数据已更新，文件名保持不变。", 'Properties updated; the file name is unchanged.'));

            // 添加到历史记录
            this.plugin.addToHistory(file.basename, file.path, tr("更新元数据", 'Update properties'), this.plugin.generateFileId(file));

            this.removeTask(task.id);
        });

        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderStructurizerTask(card, task) {
        card.createEl("p", { text: tr("笔记的结构和格式已成功优化。", 'The note structure and formatting were improved.') });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: tr("好的", 'OK'), cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    renderDiffPreviewTask(card, task, expanded = false) {
        const content = task.content || {};
        if (!content.reviewHunks) content.reviewHunks = this.plugin.buildReviewHunks(content.originalContent || '', content.proposedContent || '');
        if (!Array.isArray(content.reviewSelected)) content.reviewSelected = content.reviewHunks.map(h => h.id);
        const shrink = this.plugin.shrinkWarning(task);
        if (shrink) card.createDiv({ text: shrink, cls: 'assistant-shrink-warning', attr: { role: 'alert' } });
        if (content.reviewMode !== 'changes') {
            this.renderFullArticlePreview(card, task, expanded);
            return;
        }
        card.addClass('assistant-review-surface');
        card.createDiv({ text: content.file?.path || tr('当前笔记', 'Current note'), cls: 'assistant-review-path' });
        const summary = card.createDiv({ cls: 'assistant-review-summary', attr: { 'aria-live': 'polite' } });
        const controls = card.createDiv({ cls: 'assistant-review-toolbar' });
        controls.createEl('button', { text: tr('整文预览', 'Whole-note preview') }).onclick = () => {
            content.reviewMode = 'article'; card.empty(); this.renderDiffPreviewTask(card, task, expanded);
        };
        if (!expanded) controls.createEl('button', { text: tr('展开审阅', 'Review in full') }).onclick = () => {
            const modal = new GlassModal(this.plugin.app);
            modal.modalEl.addClass('assistant-review-modal');
            const paint = () => { modal.contentEl.empty(); modal.contentEl.createEl('h2', { text: task.title || tr('审阅修改', 'Review changes') }); this.renderDiffPreviewTask(modal.contentEl, task, true); };
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
            label.createSpan({ text: hunk.atomic ? tr('整篇建议（保持文档结构完整）', 'Whole-note suggestion (keeps the document structure)') : tr(`修改 ${hunk.id + 1} · 原文第 ${hunk.start + 1} 行`, `Change ${hunk.id + 1} · line ${hunk.start + 1}`) });
            const columns = row.createDiv({ cls: 'assistant-review-columns' });
            for (const [title, value, kind] of [[tr('原内容', 'Original'),hunk.before,'before'],[tr('建议内容', 'Suggested'),hunk.after,'after']]) {
                const column = columns.createDiv();
                column.createEl('span', { text: title, cls: 'assistant-review-muted' });
                column.createEl('pre', { text: value || (kind === 'before' ? tr('（此处新增）', '(added here)') : tr('（删除这段）', '(remove this part)')), cls: `assistant-review-${kind}` });
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
            summary.setText(content.applied ? tr(`已接受 ${count} 项修改`, `Accepted ${count} changes`) : tr(`${content.reviewHunks.length} 项建议 · 已选择 ${count} 项`, `${content.reviewHunks.length} suggestions · ${count} selected`));
            apply.setText(content.applied ? tr('撤回本次正文修改', 'Undo this text change') : content.applying ? tr('正在应用…', 'Applying…') : tr(`接受所选 ${count} 项`, `Accept ${count} selected`));
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
        if (!content.applied) buttons.createEl('button', { text: tr('全不选', 'Select none') }).onclick = () => { if (content.applying) return; content.reviewSelected = []; checks.forEach(c => { c.checked = false; c.dispatchEvent(new Event('change')); }); updateSummary(); };
        card.createEl('p', { text: tr('只应用勾选的正文差异。笔记有新编辑时将停止应用；属性与位置建议单独确认。', 'Only the ticked text changes are applied. If the note was edited meanwhile, nothing is applied; property and folder suggestions are confirmed separately.'), cls: 'assistant-review-muted' });
        updateSummary();
    }

    renderFullArticlePreview(card, task, expanded = false) {
        const content = task.content;
        card.addClass('assistant-review-surface', 'assistant-article-surface');
        const toolbar = card.createDiv({ cls: 'assistant-article-toolbar' });
        const repaint = () => { card.empty(); this.renderDiffPreviewTask(card, task, expanded); };
        const original = content.articleSource === 'original';
        const tabs = toolbar.createDiv({ cls: 'assistant-article-tabs' });
        for (const [value, name] of [['result', tr('优化后', 'Tidied')], ['original', tr('原文', 'Original')]]) {
            const button = tabs.createEl('button', { text: name, attr: { 'aria-pressed': String(original === (value === 'original')) } });
            button.onclick = () => { content.articleSource = value; repaint(); };
        }
        toolbar.createEl('button', { text: tr('查看具体修改', 'See the changes'), cls: 'assistant-article-text-button' }).onclick = () => {
            content.reviewMode = 'changes'; repaint();
        };
        if (!expanded) toolbar.createEl('button', { text: tr('展开阅读', 'Read in full'), cls: 'assistant-article-text-button' }).onclick = () => {
            const modal = new GlassModal(this.plugin.app);
            modal.modalEl.addClass('assistant-review-modal');
            modal.onOpen = () => this.renderDiffPreviewTask(modal.contentEl, task, true);
            modal.open();
        };
        const selected = content.reviewSelected;
        card.createEl('p', { text: content.applied ? tr('已应用，可撤回本次修改。', 'Applied; you can undo this change.') : selected.length === content.reviewHunks.length ? tr('整篇排版预览 · 原笔记尚未修改', 'Whole-note layout preview · the note is not changed yet') : tr('当前预览包含你选择的修改 · 原笔记尚未修改', 'Preview includes your chosen changes · the note is not changed yet'), cls: 'assistant-review-muted' });
        const article = card.createDiv({ cls: 'assistant-article-preview markdown-rendered' });
        const text = original ? content.originalContent : this.plugin.composeReviewContent(content.originalContent, content.reviewHunks, selected);
        const body = (text || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
        if (MarkdownRenderer?.render) {
            Promise.resolve(MarkdownRenderer.render(this.plugin.app, body, article, content.file?.path || '', this)).catch(() => {
                article.empty(); article.createEl('pre', { text: body });
            });
        } else article.createEl('pre', { text: body });
        const actions = card.createDiv({ cls: 'assistant-review-actions' });
        const apply = actions.createEl('button', { text: content.applied ? tr('撤回本次修改', 'Undo this change') : content.applying ? tr('正在应用…', 'Applying…') : selected.length === content.reviewHunks.length ? tr('应用整篇优化', 'Apply whole note') : tr('应用所选修改', 'Apply selected changes'), cls: 'mod-cta' });
        apply.disabled = !!content.applying || (!content.applied && !selected.length);
        apply.onclick = async () => {
            if (content.applying) return;
            content.applying = true; apply.disabled = true; apply.setText(tr('正在处理…', 'Working…'));
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
        const closeButton = buttonContainer.createEl("button", { text: tr("关闭", 'Close'), cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染批量处理任务
    renderBatchProcessTask(card, task) {
        const content = task.content;

        if (content.type === 'error') {
            card.createEl("p", { text: content.message, cls: "error-message" });
            const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
            const closeButton = buttonContainer.createEl("button", { text: tr("确定", 'OK'), cls: "mod-cta" });
            closeButton.addEventListener("click", () => this.removeTask(task.id));
            return;
        }

        if (content.message) {
            // 处理完成或中断的消息
            card.createEl("p", { text: content.message });
        } else {
            // 进行中的处理
            const progressInfo = card.createDiv({ cls: "batch-progress-info" });

            progressInfo.createEl("p", {
                text: tr(`正在处理第 ${content.processedCount} / ${content.totalFiles} 个文件`, `Processing file ${content.processedCount} of ${content.totalFiles}`)
            });

            if (content.currentFile) {
                progressInfo.createEl("p", {
                    text: tr(`当前文件: ${content.currentFile}`, `Current file: ${content.currentFile}`),
                    cls: "current-file-name"
                });
            }

            // 进度条
            const progressContainer = progressInfo.createDiv({ cls: "progress-container" });
            const progressBar = progressContainer.createDiv({ cls: "progress-bar" });
            const progressFill = progressBar.createDiv({ cls: "progress-fill" });
            const percentage = Math.round((content.processedCount / content.totalFiles) * 100);
            progressFill.style.width = `${percentage}%`;

            progressInfo.createEl("p", {
                text: `${percentage}%`,
                cls: "progress-percent"
            });
        }

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        if (content.canInterrupt) {
            const interruptButton = buttonContainer.createEl("button", {
                text: tr("🛑 中断处理", 'Stop'),
                cls: "mod-warning interrupt-btn"
            });
            interruptButton.addEventListener("click", () => {
                this.batchProcessInterrupted = true;
                interruptButton.disabled = true;
                interruptButton.textContent = tr("正在中断...", 'Stopping…');
            });
        }

        const closeButton = buttonContainer.createEl("button", { text: tr("关闭", 'Close') });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染文件夹批量处理确认任务
    renderFolderBatchConfirmTask(card, task) {
        const content = task.content;

        const infoContainer = card.createDiv({ cls: "folder-batch-info" });

        const folderInfo = infoContainer.createDiv({ cls: "info-item" });
        folderInfo.createSpan({ cls: "info-icon", text: "📁" });
        const folderInfoContent = folderInfo.createDiv({ cls: "info-content" });
        folderInfoContent.createEl("strong", { text: tr("文件夹路径:", 'Folder:') });
        folderInfoContent.createEl("br");
        folderInfoContent.createEl("code", { text: content.folderPath });

        const fileInfo = infoContainer.createDiv({ cls: "info-item" });
        fileInfo.createSpan({ cls: "info-icon", text: "📄" });
        const fileInfoContent = fileInfo.createDiv({ cls: "info-content" });
        fileInfoContent.createEl("strong", { text: tr("文件数量:", 'Files:') });
        fileInfoContent.createEl("br");
        fileInfoContent.appendText(tr(`${content.fileCount} 个 Markdown 文件`, `${content.fileCount} Markdown files`));

        const warningBox = infoContainer.createDiv({ cls: "warning-box" });
        warningBox.createSpan({ cls: "warning-icon", text: "⚠️" });
        const warningContent = warningBox.createDiv({ cls: "warning-content" });
        warningContent.createEl("strong", { text: tr("注意:", 'Note:') });
        warningContent.appendText(tr(" 批量处理会把每篇笔记发给你配置的 AI 服务，可能需要较长时间，过程中可以随时中断。", ' Batch processing sends every note to your AI service and may take a while. You can stop at any time.'));

        this.plugin.renderBatchSendSummary(infoContainer, content.files);

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });

        const confirmButton = buttonContainer.createEl("button", {
            text: tr("开始处理", 'Start'),
            cls: "mod-cta"
        });
        confirmButton.addEventListener("click", () => {
            this.removeTask(task.id);
            this.plugin.runBatchProcess(content.files);
        });

        const cancelButton = buttonContainer.createEl("button", { text: tr("取消", 'Cancel') });
        cancelButton.addEventListener("click", () => this.removeTask(task.id));
    }

    // 渲染消息任务（错误、成功等）
    renderMessageTask(card, task) {
        const content = task.content;

        card.createEl("p", {
            text: content.message,
            cls: content.type === 'error' || task.type === 'error' ? 'error-message' : 'success-message'
        });

        const buttonContainer = card.createDiv({ cls: "ai-assistant-button-container" });
        const closeButton = buttonContainer.createEl("button", { text: tr("确定", 'OK'), cls: "mod-cta" });
        closeButton.addEventListener("click", () => this.removeTask(task.id));
    }









    // 渲染快速操作区域
    renderQuickActions(container) {
        const section = container.createDiv({ cls: "ai-assistant-section" });

        // 标题区域，包含刷新按钮
        const titleContainer = section.createDiv({ cls: "section-title-container" });
        const title = titleContainer.createEl("h3", { text: tr("快速操作", 'Quick actions') });
        title.addClass('ai-assistant-u-title');

        // 刷新按钮放在标题旁边
        const refreshBtn = titleContainer.createEl("button", {
            text: tr("刷新", 'Refresh'),
            cls: "ai-assistant-refresh-btn"
        });
        refreshBtn.title = tr("刷新面板", 'Refresh panel');
        refreshBtn.addEventListener('click', () => {
            this.render();
            new Notice(tr("面板已刷新", 'Panel refreshed'), 1500);
        });

        const actionGrid = section.createDiv({ cls: "ai-assistant-action-grid" });

        const actions = [
            {
                name: tr("回滚上次", 'Undo last'),
                icon: "↩",
                desc: tr("恢复最近一次应用的内容变更", 'Restore the last applied change'),
                action: () => this.plugin.rollbackLastChange()
            },
            {
                name: tr("撤销回滚", 'Redo'),
                icon: "↪",
                desc: tr("重新应用刚刚回滚的 AI 变更", 'Re-apply the AI change you just undid'),
                action: () => this.plugin.redoLastRollback()
            },
            {
                name: tr("批量处理", 'Batch tidy'),
                icon: "📦",
                desc: tr("选择文件或文件夹", 'Choose files or a folder'),
                action: () => this.showBatchProcessingModal()
            },

            {
                name: tr("打开设置", 'Open settings'),
                icon: "⚙️",
                desc: tr("快速打开插件设置", 'Open plugin settings'),
                action: () => {
                    this.plugin.app.setting.open();
                    this.plugin.app.setting.openTabById('ai-assistant-suite');
                }
            }
        ];

        const customActions = (this.plugin.settings.customActions || []).filter(action => action.enabled !== false);
        customActions.forEach(action => {
            actions.push({
                name: action.name || tr('自定义动作', 'Custom actions'),
                icon: "✦",
                desc: this.plugin.getCustomActionModeLabel(action.outputMode),
                action: () => this.plugin.runCustomAction(action.id)
            });
        });

        actions.forEach(action => {
            const actionBtn = actionGrid.createEl("button", { cls: "ai-assistant-action-btn", attr: { type: "button", "aria-label": action.name + tr("：", ': ') + action.desc } });
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
        section.createEl("h3", { text: tr("📄 当前文件信息", 'Current file') });

        const infoGrid = section.createDiv({ cls: "ai-assistant-info-grid" });

        // 文件基本信息
        const fileInfo = infoGrid.createDiv({ cls: "info-item" });
        fileInfo.createEl("span", { text: tr("文件名:", 'Name:'), cls: "info-label" });
        fileInfo.createEl("span", { text: currentFile.basename, cls: "info-value" });

        const pathInfo = infoGrid.createDiv({ cls: "info-item" });
        pathInfo.createEl("span", { text: tr("路径:", 'Path:'), cls: "info-label" });
        pathInfo.createEl("span", { text: currentFile.path, cls: "info-value" });

        // 文件统计
        this.plugin.app.vault.read(currentFile).then(content => {
            const stats = this.getFileStats(content);

            const wordInfo = infoGrid.createDiv({ cls: "info-item" });
            wordInfo.createEl("span", { text: tr("字数:", 'Words:'), cls: "info-label" });
            wordInfo.createEl("span", { text: stats.words.toString(), cls: "info-value" });

            const charInfo = infoGrid.createDiv({ cls: "info-item" });
            charInfo.createEl("span", { text: tr("字符数:", 'Characters:'), cls: "info-label" });
            charInfo.createEl("span", { text: stats.chars.toString(), cls: "info-value" });

            const lineInfo = infoGrid.createDiv({ cls: "info-item" });
            lineInfo.createEl("span", { text: tr("行数:", 'Lines:'), cls: "info-label" });
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
        section.createEl("h3", { text: tr("🤖 AI状态监控", 'AI status') });

        const statusGrid = section.createDiv({ cls: "ai-assistant-status-grid" });

        // API状态
        const apiStatus = statusGrid.createDiv({ cls: "status-item" });
        apiStatus.createEl("span", { text: tr("API状态:", 'API:'), cls: "status-label" });
        const apiIndicator = apiStatus.createEl("span", { cls: "status-indicator" });

        const hasValidConfig = this.plugin.settings.apiConfigs?.some(c => c.enabled !== false && this.plugin.isConfigUsable(c));
        if (hasValidConfig) {
            apiIndicator.setText(tr("🟢 已配置", 'Configured'));
            apiIndicator.addClass("status-good");
        } else {
            apiIndicator.setText(tr("🔴 未配置", 'Not configured'));
            apiIndicator.addClass("status-error");
        }



        // 模型信息
        const modelStatus = statusGrid.createDiv({ cls: "status-item" });
        modelStatus.createEl("span", { text: tr("主模型:", 'Main model:'), cls: "status-label" });
        const activeConfig = this.plugin.getActiveApiConfig();
        modelStatus.createEl("span", {
            text: activeConfig?.modelName || tr("未设置", 'Not set'),
            cls: "status-value"
        });
    }

    // 渲染最近处理历史
    renderRecentHistory(container) {
        const history = this.plugin.getRecentHistory();
        if (history.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: tr("📚 最近处理", 'Recent') });

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

        // 笔记改名或删除后，把修正过的历史存回插件设置
        if (updatedHistory.length !== history.length ||
            updatedHistory.some((item, index) =>
                item.filePath !== history[index]?.filePath)) {
            this.plugin.settings.processingHistory = updatedHistory;
            void this.plugin.saveSettings();
        }

        if (validHistory.length === 0) {
            const emptyMessage = historyList.createDiv({ cls: "history-empty" });
            emptyMessage.textContent = tr("暂无有效的处理历史", 'No valid history');
            return;
        }

        validHistory.forEach(item => { // 显示所有历史，通过CSS控制滚动
            const historyItem = historyList.createEl("button", { cls: "history-item", attr: { type: "button", "aria-label": tr("打开笔记：", 'Open note: ') + item.fileName } });

            // 显示当前文件名（可能已更新）
            const fileNameSpan = historyItem.createEl("span", {
                text: item.fileName,
                cls: "history-filename"
            });

            // 如果文件被重命名，显示提示
            const file = this.findFileByHistory(item);
            if (file && file.path !== item.filePath) {
                fileNameSpan.title = tr(`原路径: ${item.filePath}\n当前路径: ${file.path}`, `Old path: ${item.filePath}\nCurrent path: ${file.path}`);
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
                        title: tr('文件访问错误', 'File access error'),
                        status: 'displaying',
                        content: {
                            message: tr(`文件 "${item.fileName}" 不存在或已被移动`, `File "${item.fileName}" does not exist or was moved`),
                            type: 'error'
                        }
                    });
                }
            });
        });

        // 清理历史按钮
        const clearBtn = section.createEl("button", {
            text: tr("清理历史", 'Clear history'),
            cls: "ai-assistant-clear-history-btn"
        });
        clearBtn.addEventListener("click", async () => {
            const confirmed = await confirmAction(this.app, tr('确定要清理所有处理历史记录吗？此操作不可撤销。', 'Clear all history? This cannot be undone.'), tr('清理', 'Clear'));
            if (confirmed) {
                // 清理插件设置中的历史记录
                this.plugin.settings.processingHistory = [];
                this.plugin.saveSettings();

                this.render();
                // 在助手面板中显示成功信息
                this.addTask({
                    id: Date.now().toString(),
                    type: 'success',
                    title: tr('历史记录已清理', 'History cleared'),
                    status: 'displaying',
                    content: {
                        message: tr('所有历史记录已成功清理', 'All history cleared'),
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

        if (diff < 60000) return tr("刚刚", 'just now');
        if (diff < 3600000) return tr(`${Math.floor(diff / 60000)}分钟前`, `${Math.floor(diff / 60000)} min ago`);
        if (diff < 86400000) return tr(`${Math.floor(diff / 3600000)}小时前`, `${Math.floor(diff / 3600000)} h ago`);
        return tr(`${Math.floor(diff / 86400000)}天前`, `${Math.floor(diff / 86400000)} d ago`);
    }

    // 渲染使用统计
    renderUsageStats(container) {
        const history = this.plugin.getRecentHistory();
        if (history.length === 0) return;

        const section = container.createDiv({ cls: "ai-assistant-section" });
        section.createEl("h3", { text: tr("📊 使用统计", 'Usage') });

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
        totalStat.createEl("span", { text: tr("总处理次数:", 'Total runs:'), cls: "stat-label" });
        totalStat.createEl("span", { text: totalCount.toString(), cls: "stat-value" });

        // 最常用功能
        const mostUsed = Object.entries(actionCounts)
            .sort(([, a], [, b]) => b - a)[0];

        if (mostUsed) {
            const mostUsedStat = statsGrid.createDiv({ cls: "stat-item" });
            mostUsedStat.createEl("span", { text: tr("最常用功能:", 'Most used:'), cls: "stat-label" });
            mostUsedStat.createEl("span", {
                text: tr(`${mostUsed[0]} (${mostUsed[1]}次)`, `${this.actionLabel(mostUsed[0])} (${mostUsed[1]})`),
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
        todayStat.createEl("span", { text: tr("今日处理:", 'Today:'), cls: "stat-label" });
        todayStat.createEl("span", { text: todayCount.toString(), cls: "stat-value" });

        if (Object.keys(actionCounts).length > 0) {
            const chartTitle = section.createEl("h4", { text: tr("各功能累计次数", 'Runs per action'), cls: "stat-subtitle" });
            chartTitle.addClass('ai-assistant-u-chart-title');

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

class PromptEditModal extends GlassModal {
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
class BatchFileSelectionModal extends GlassModal {
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

class AiAssistantSuite extends Plugin {
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
            if (!config.name) config.name = `Config ${index + 1}`;
            if (!config.apiProvider) config.apiProvider = 'openai';
            // 旧版只有“OpenAI 兼容”一项：地址是哪家官方的，就认成那家预设，地址和型号原样保留
            if (config.apiProvider === 'openai') config.apiProvider = presetForUrl(config.apiUrl) || 'openai';
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
        modal.contentEl.createEl('p', { text: tr(
            `以前「${primary.name}」失败时，会自动改发给 ${others.map(c => `「${c.name}」`).join('、')}。现在要你允许才会改发。`,
            `Before, when "${primary.name}" failed, notes were sent to ${others.map(c => `"${c.name}"`).join(', ')} instead. Now that needs your permission.`) });
        const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
        const choose = async keep => { await this.applyBackupChoice(keep); modal.close(); };
        buttons.createEl('button', { text: tr('照旧改发', 'Keep sending to them') }).addEventListener('click', () => void choose(true));
        buttons.createEl('button', { cls: 'mod-cta', text: tr(`只用「${primary.name}」`, `Only use "${primary.name}"`) }).addEventListener('click', () => void choose(false));
        modal.open();
    }

    orderConfigsForFallback(candidates) {
        const index = candidates.findIndex(c => c.id === this.lastWorkingConfigId);
        if (index <= 0) return candidates;
        return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
    }

    // 密钥存在 Obsidian 的钥匙串里（本机，不随库同步）；每套配置只记密钥的名字 apiKeySecret
    getApiKey(config) {
        const name = config?.apiKeySecret;
        return (name && this.app?.secretStorage?.getSecret(name)) || '';
    }

    hasStoredApiKey(config) {
        return !!this.getApiKey(config);
    }

    // 本地模型（Ollama、LM Studio）不需要密钥；其余服务商必须有密钥
    isConfigUsable(config) {
        if (config?.apiProvider === 'local') return true;
        return this.hasStoredApiKey(config);
    }

    // 1.7 以前密钥存在插件数据里（固定口令加密，等于明文）。启动时搬进钥匙串，搬完从数据里删掉；
    // 读不出的旧值原样留着，不丢
    async moveKeysToSecretStorage() {
        const storage = this.app?.secretStorage;
        if (!storage) return false;
        let moved = false;
        for (const config of this.settings.apiConfigs || []) {
            if (!('apiKey' in config)) continue;
            let key = '';
            if (config.apiKey && config.apiKey !== REDACTED_API_KEY) {
                try {
                    key = await readLegacyKey(config.apiKey);
                } catch (error) {
                    console.error('AI Assistant Suite: could not read a saved key; it is left in the settings.', error);
                    continue;
                }
            }
            if (key && !config.apiKeySecret) config.apiKeySecret = storeSecret(storage, secretNamesFor(config), key);
            delete config.apiKey;
            moved = true;
        }
        return moved;
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
                if (!config.apiKeySecret && existing?.apiKeySecret) {
                    return { ...config, apiKeySecret: existing.apiKeySecret };
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
            (leaf) => (this.view = new AssistantView(leaf, this))
        );

        this.registerView('ai-assistant-note-preview', leaf => new AssistantNotePreview(leaf,this));
        this.registerView(ASSISTANT_WORKBENCH_TYPE, leaf => (this.view = new AssistantView(leaf, this, true)));

        this.addRibbonIcon("anchor", tr("打开 AI 助手面板", 'Open AI assistant panel'), () => {
            this.activateView();
        });

        this.addRibbonIcon('zap', tr('AI 智能处理', 'AI processing'), () => {
            this.runOneClickSmartProcess();
        });

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
    async validateApiConfig(configToTest = null) {
        const config = configToTest || this.getActiveApiConfig();
        if (!config) return { valid: false, ...describeApiProblem('no-config'), checks: connectionChecks('no-config', null, false) };
        if (!this.isConfigUsable(config)) return { valid: false, ...describeApiProblem('no-key', config), checks: connectionChecks('no-key', null, false) };
        if (config.apiProvider === 'openai' && !config.apiUrl) return { valid: false, ...describeApiProblem('no-url', config), checks: connectionChecks('no-url', null, false) };
        if (config.apiProvider !== 'local' && !config.modelName && !providerInfo(config.apiProvider).models.length) {
            return { valid: false, ...describeApiProblem('no-model', config), checks: connectionChecks('no-model', null, false) };
        }
        try {
            await this._callSingleConfig('Reply with OK.', null, false, config, { probe: true, timeout: 20000 });
            this.lastApiProblem = null;
            return { valid: true, kind: 'ok', checks: connectionChecks('ok') };
        } catch (error) {
            const kind = classifyApiError(error);
            this.lastApiProblem = { kind, status: error?.status || null, at: Date.now(), provider: config.apiProvider };
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
            ? '---\nai-assistant-demo: true\n---\n> 这是 AI Assistant Suite 的示例笔记，可以随时删除。\n\n周三和小林聊了下学期的计划 他说实验室三月开始招人 要先发邮件 附上研究计划 还要准备面谈\n\n要做的：研究计划写到两页以内 邮件里说清楚为什么选这个研究室 日语面谈练三次\n\n顺便记一下 他推荐了两本书 一本讲实验设计 一本讲科研写作\n'
            : '---\nai-assistant-demo: true\n---\n> This is the AI Assistant Suite example note. Delete it any time.\n\nwed talked w/ Sam about next term. lab starts hiring in march, need to email first with a research plan, then an interview\n\ntodo: keep plan under 2 pages, say in the email why this lab, practice interview 3 times\n\nalso he recommended two books one on experiment design one on science writing\n';
        const structured = zh
            ? '---\nai-assistant-demo: true\n---\n> 这是 AI Assistant Suite 的示例笔记，可以随时删除。\n\n## 下学期计划（周三与小林）\n\n- 实验室**三月**开始招人。\n- 流程：先发邮件并附研究计划，之后面谈。\n\n## 待办\n\n- [ ] 研究计划控制在两页以内\n- [ ] 邮件里说清楚为什么选这个研究室\n- [ ] 日语面谈练习三次\n\n## 推荐书目\n\n- 一本讲实验设计\n- 一本讲科研写作\n'
            : '---\nai-assistant-demo: true\n---\n> This is the AI Assistant Suite example note. Delete it any time.\n\n## Next term (Wednesday, with Sam)\n\n- The lab starts hiring in **March**.\n- Steps: email first with a research plan, then an interview.\n\n## To do\n\n- [ ] Keep the plan under two pages\n- [ ] Say in the email why this lab\n- [ ] Practise the interview three times\n\n## Recommended books\n\n- One on experiment design\n- One on science writing\n';
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
                    meta: zh ? { title: '下学期研究室申请计划', summary: '实验室三月招人，需要先发邮件并附研究计划，再参加面谈。待办包括压缩研究计划、写清选择理由和练习面谈。', tldr: '三月前备好研究计划和邮件，练三次面谈。' }
                        : { title: 'Lab application plan for next term', summary: 'The lab hires from March: email with a research plan first, then an interview. To do: shorten the plan, explain the choice, practise the interview.', tldr: 'Have the plan and email ready before March; practise three times.' },
                    tags: (zh ? ['示例/申请', '示例/待办'] : ['example/application', 'example/todo']).map(tag => ({ display: tag, final: tag, is_new: true })),
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
            lines.push(`#${index + 1} provider=${config.apiProvider || 'openai'} host=${hostOf(this.resolveProviderUrl(config)) || '-'} model=${config.modelName || '-'} helper=${config.auxiliaryModelName || '-'} key=${this.hasStoredApiKey(config) ? 'set' : 'none'} enabled=${config.enabled !== false}`);
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
            name: config.name || config.id || tr('未命名配置', 'Unnamed configuration'),
            local: config.apiProvider === 'local'
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
                        new Notice(tr(`已切换到备用配置「${label}」并成功`, `Switched to backup "${label}" and it worked`));
                    }
                    return result;
                } catch (err) {
                    if (requestOptions.signal?.aborted || this.isCancellationError(err)) {
                        throw this.createAbortError();
                    }
                    const msg = tr(`配置「${label}」失败: ${err.message}`, `Configuration "${label}" failed: ${err.message}`);
                    errors.push(msg);
                    console.warn(`[AI Assistant] ${msg}`);
                    if (i < candidates.length - 1) {
                        new Notice(tr(`${label} 失败，尝试下一个配置...`, `${label} failed, trying the next configuration…`), 2000);
                    }
                }
            }

            if (candidates.length === 1) {
                throw new Error(tr(`${errors[0]}\n没有勾选“允许用作备用”的配置，所以没有改发给其他服务。`, `${errors[0]}\nNo configuration allows backup use, so nothing was sent to another service.`));
            }
            throw new Error(tr(`所有 API 配置均失败（共 ${candidates.length} 个）。\n最后错误: ${errors[errors.length - 1]}`, `All ${candidates.length} API configurations failed.\nLast error: ${errors[errors.length - 1]}`));
        } finally {
            if (operationController) {
                this.finishAiOperation(operationController);
            }
        }
    }

    // 预设服务商：留空用官方地址；填基础地址（如 https://api.deepseek.com 或 …/v1）时补上 /chat/completions。
    // 自定义和本地照填的地址原样用。
    resolveProviderUrl(config) {
        const provider = config?.apiProvider || 'openai';
        const info = providerInfo(provider);
        const value = (config?.apiUrl || '').trim();
        if (provider === 'openai') return value;
        if (provider === 'local') return value || info.url;
        const url = (value || info.url).replace(/\/+$/, '');
        return /\/chat\/completions$/.test(url) ? url : `${url}/chat/completions`;
    }

    resolveDeepSeekUrl(value) {
        return this.resolveProviderUrl({ apiProvider: 'deepseek', apiUrl: value });
    }

    defaultModelFor(provider) {
        return providerInfo(provider).models[0]?.[0] || '';
    }

    // 对单个 config 执行实际的 API 请求
    async _callSingleConfig(prompt, modelNameOverride, expectJson, activeConfig, options = {}) {
        const model = modelNameOverride || activeConfig.modelName || this.defaultModelFor(activeConfig.apiProvider);
        const provider = activeConfig.apiProvider || 'openai';
        const apiKey = this.getApiKey(activeConfig);

        if (!apiKey && provider !== 'local') {
            throw Object.assign(new Error(tr('还没有填写 API 密钥，请在设置里填写。', 'No API key yet. Add one in settings.')), { kind: 'no-key' });
        }

        let url, requestOptions;

        if (provider === 'gemini') {
            url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            const body = {
                contents: [{ parts: [{ text: prompt }] }]
            };
            if (expectJson) {
                body.generationConfig = { responseMimeType: "application/json" };
            }
            if (options.probe) body.generationConfig = { maxOutputTokens: 16 };
            requestOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey
                },
                body: JSON.stringify(body)
            };
        } else {
            url = this.resolveProviderUrl(activeConfig);
            if (!url) {
                throw Object.assign(new Error(tr('还没有填写接口地址，请在设置里填写。', 'No API URL yet. Add one in settings.')), { kind: 'no-url' });
            }
            const body = {
                model: model,
                messages: [{ role: "user", content: prompt }]
            };
            if (provider === 'deepseek') body.thinking = { type: activeConfig.deepseekThinking ? 'enabled' : 'disabled' };
            // 本地模型对 response_format 的支持不一，靠提示词要求 JSON
            if (expectJson && provider !== 'local') {
                body.response_format = { type: "json_object" };
            }
            if (options.probe) body.max_tokens = 16;
            const headers = { "Content-Type": "application/json" };
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            requestOptions = {
                method: "POST",
                headers,
                body: JSON.stringify(body)
            };
        }

        const data = await this.executeJsonRequest(url, requestOptions, options);
        // 测试连接只看服务商肯不肯答：回答到了就算通，不看内容
        if (options.probe) return 'OK';

        let resultText = "";
        if (provider === 'gemini') {
            resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        } else {
            resultText = data.choices?.[0]?.message?.content;
        }

        if (!resultText) {
            // 不把回答原样打到控制台：里面可能有笔记内容
            throw Object.assign(new Error(tr('AI 没有返回内容。', 'The AI returned no content.')), { kind: 'empty' });
        }

        // 请求一律走 requestUrl（不受跨域限制、手机可用），它不能逐段读取，所以结果到齐后一次交给界面
        options.onStream?.(resultText, resultText);
        return resultText;
    }

    // Wraps the caller's cancel signal with a timeout, so a silent server cannot hang the panel forever.
    createRequestTimeout(signal, timeoutMs = 120000) {
        const controller = new AbortController();
        let timedOut = false;
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener?.('abort', () => controller.abort(), { once: true });
        const timer = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        return {
            signal: controller.signal,
            clear: () => window.clearTimeout(timer),
            timedOut: () => timedOut,
            error: () => Object.assign(new Error(tr(`AI 请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应，已停止等待。`, `The AI did not answer within ${Math.round(timeoutMs / 1000)} seconds, so the request was stopped.`)), { kind: 'timeout' })
        };
    }

    async executeJsonRequest(url, requestOptions, options = {}) {
        if (options.signal?.aborted) {
            throw this.createAbortError();
        }

        // requestUrl 走 Obsidian 自己的网络层，不受跨域限制，桌面和手机都能用。
        // 它不能中途取消，所以和超时、手动取消赛跑：谁先到就按谁处理，迟到的回答直接丢掉。
        const timeout = this.createRequestTimeout(options.signal, options.timeout || 120000);
        const stopped = new Promise((_, reject) => {
            const stop = () => reject(timeout.timedOut() ? timeout.error() : this.createAbortError());
            if (timeout.signal.aborted) stop();
            else timeout.signal.addEventListener('abort', stop, { once: true });
        });
        stopped.catch(() => {});
        try {
            const response = await Promise.race([
                requestUrl({
                    url,
                    method: requestOptions.method || 'POST',
                    headers: requestOptions.headers || {},
                    body: requestOptions.body,
                    throw: false
                }),
                stopped
            ]);
            const text = typeof response.text === 'string' ? response.text : '';
            if (response.status < 200 || response.status >= 300) {
                // 服务商的错误说明可能带着密钥片段，先遮掉再显示
                const detail = redactSecrets(text.substring(0, 200), requestOptions.headers);
                throw Object.assign(new Error(`HTTP ${response.status}. ${detail}`), { status: response.status, detail });
            }
            return JSON.parse(text);
        } catch (error) {
            if (timeout.timedOut()) throw timeout.error();
            if (options.signal?.aborted || this.isCancellationError(error)) {
                throw this.createAbortError();
            }
            throw error;
        } finally {
            timeout.clear();
        }
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
            new Notice(tr(`处理失败: ${error.message}`, `Failed: ${error.message}`), 0);
            this.view?.updateTask(taskId, { status: 'displaying', type: 'error', title: tr('这次处理未完成', 'This run did not finish'), content: { type: 'error', file: currentFile, message: error.message } });
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
            new Notice(tr(`处理失败: ${error.message}`, `Failed: ${error.message}`), 0);
            this.view?.updateTask(taskId, { status: 'displaying', type: 'error', title: tr('这次处理未完成', 'This run did not finish'), content: { type: 'error', file: currentFile, message: error.message } });
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
            new Notice(tr(`处理失败: ${error.message}`, `Failed: ${error.message}`), 0);
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
            new Notice(tr(`处理失败: ${error.message}`, `Failed: ${error.message}`), 0);
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
            new Notice(tr(`处理失败: ${error.message}`, `Failed: ${error.message}`), 0);
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
            new Notice(tr(`整理失败：${error.message}`, `Tidying failed: ${error.message}`), 8000);
            this.view?.addTask({ id: `error-${Date.now()}`, status: 'displaying', type: 'error', title: tr('这次处理未完成', 'This run did not finish'), content: { type: 'error', file: currentFile, message: error.message, kind: classifyApiError(error) } });
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
            new Notice(tr(`${this.getActionName(action)}失败: ${error.message}`, `${this.getActionName(action)} failed: ${error.message}`), 0);
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
            new Notice(tr(`自定义 Action 失败: ${error.message}`, `Custom action failed: ${error.message}`), 5000);
            console.error('Custom Action Error:', error);
        }
    }







    async loadSettings() {
        const stored = await this.loadData() || {};
        this.settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), stored);
        if (!Array.isArray(stored.apiConfigs)) delete this.settings.apiConfigs;
        const upgraded = this.migrateLegacySettings();
        this.normalizeSettings();
        const migrated = await this.moveKeysToSecretStorage();
        if (migrated || upgraded) {
            await this.saveSettings();
        }
    }

    async saveSettings() {
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
                modelName: this.getActiveApiConfig()?.modelName,
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

// 给每组最后一行加 .ap-group-end，让它圆角收尾；CSS 不用 :has 就看不到“下一行是标题或说明”。分页局部重画时也跟着更新。
function watchSettingGroupEnds(rootEl) {
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

class AiAssistantSettingTab extends PluginSettingTab {
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
                    const label = config.enabled === false ? tr(`[禁用] ${config.name}`, `[off] ${config.name}`) : config.name;
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
                name: providerName('deepseek'),
                apiProvider: 'deepseek',
                apiUrl: '',
                modelName: this.plugin.defaultModelFor('deepseek'),
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
                .setValue(activeConfig.name)
                .onChange(async (value) => {
                    activeConfig.name = value || 'Unnamed Config';
                    await this.plugin.saveSettings();
                }));

        // 四项分开填：服务商 → 接口地址 → 模型 → 密钥，最后测试连接
        const provider = activeConfig.apiProvider || 'openai';
        const info = providerInfo(provider);
        new Setting(containerEl)
            .setName(tr('服务商', 'Provider'))
            .addDropdown(dropdown => {
                for (const id of Object.keys(PROVIDERS)) dropdown.addOption(id, providerName(id));
                return dropdown.setValue(provider).onChange(async (value) => {
                    // 只替换还是旧预设值的地址和模型；本人改过的照旧保留
                    const before = providerInfo(activeConfig.apiProvider);
                    if (!activeConfig.apiUrl || activeConfig.apiUrl === before.url) activeConfig.apiUrl = '';
                    if (!activeConfig.modelName || before.models.some(([id]) => id === activeConfig.modelName)) {
                        activeConfig.modelName = this.plugin.defaultModelFor(value);
                    }
                    if (!activeConfig.name || Object.keys(PROVIDERS).some(id => providerName(id) === activeConfig.name)) {
                        activeConfig.name = providerName(value);
                    }
                    activeConfig.apiProvider = value;
                    await this.plugin.saveSettings();
                    this.refresh();
                });
            });

        if (provider !== 'gemini') {
            const urlDesc = provider === 'openai'
                ? tr('填写完整的接口地址。', 'Enter the full chat completions address.')
                : provider === 'local'
                    ? tr(`留空用默认地址 ${LOCAL_MODEL_DEFAULT_URL}；另一种常见本地服务一般是 ${LM_STUDIO_URL}。笔记只发给你电脑上的模型，不经过云服务。手机访问不到电脑的 localhost。`,
                        `Leave empty for ${LOCAL_MODEL_DEFAULT_URL}; the other common local server is usually ${LM_STUDIO_URL}. Notes go only to the model on your computer. A phone cannot reach your computer's localhost.`)
                    : tr(`留空用官方地址 ${info.url}。用代理时填代理地址，基础地址也可以。`, `Leave empty for the official address ${info.url}. For a proxy, enter its address; a base URL works too.`);
            new Setting(containerEl)
                .setName(tr('接口地址', 'API URL'))
                .setDesc(urlDesc)
                .addText(text => text
                    .setPlaceholder(provider === 'openai' ? API_URL_EXAMPLE : info.url)
                    .setValue(activeConfig.apiUrl || '')
                    .onChange(async (value) => {
                        activeConfig.apiUrl = value.trim();
                        await this.plugin.saveSettings();
                    }));
        }

        const modelSetting = new Setting(containerEl)
            .setName(tr('主模型', 'Main model'))
            .setDesc(info.models.length
                ? ''
                : tr(`填写模型名，例如 ${provider === 'local' ? LOCAL_MODEL_EXAMPLE : 'gpt-4o-mini'}。`, `Enter the model name, for example ${provider === 'local' ? LOCAL_MODEL_EXAMPLE : 'gpt-4o-mini'}.`));
        if (info.models.length) {
            modelSetting.addDropdown(dropdown => {
                dropdown.addOption('', tr('手动填写', 'Custom'));
                for (const [id, label] of info.models) dropdown.addOption(id, label);
                return dropdown
                    .setValue(info.models.some(([id]) => id === activeConfig.modelName) ? activeConfig.modelName : '')
                    .onChange(async value => {
                        if (!value) return;
                        activeConfig.modelName = value;
                        await this.plugin.saveSettings();
                        this.refresh();
                    });
            });
        }
        modelSetting.addText(text => text
            .setPlaceholder(this.plugin.defaultModelFor(provider) || (provider === 'local' ? LOCAL_MODEL_EXAMPLE : ''))
            .setValue(activeConfig.modelName || '')
            .onChange(async (value) => {
                activeConfig.modelName = value.trim();
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName(tr('辅助模型', 'Helper model'))
            .setDesc(tr('翻译标签这类轻活用它；留空就用主模型。', 'Used for light jobs such as translating tags. Leave empty to use the main model.'))
            .addText(text => text
                .setPlaceholder(info.models[info.models.length - 1]?.[0] || '')
                .setValue(activeConfig.auxiliaryModelName || '')
                .onChange(async (value) => {
                    activeConfig.auxiliaryModelName = value.trim();
                    await this.plugin.saveSettings();
                }));

        if (provider === 'deepseek') {
            new Setting(containerEl).setName(tr('深度思考', 'Deep thinking'))
                .setDesc(tr('复杂内容效果更好，但要等更久。', 'Better for complex content, but slower.'))
                .addToggle(toggle => toggle.setValue(!!activeConfig.deepseekThinking).onChange(async value => {
                    activeConfig.deepseekThinking = value; await this.plugin.saveSettings();
                }));
        }

        const secretName = activeConfig.apiKeySecret || '';
        const keySetting = new Setting(containerEl)
            .setName(tr('API 密钥', 'API key'))
            .setDesc(provider === 'local'
                ? tr('本地模型一般不需要密钥，只有你给本地服务设了密钥时才选。', 'Local models usually need no key; choose one only if you set one on the local server.')
                : secretName && !this.plugin.hasStoredApiKey(activeConfig)
                    ? tr(`这台设备的钥匙串里没有「${secretName}」，请重新选择或新建。`, `"${secretName}" is not in this device's Keychain. Choose or create a key.`)
                    : tr('密钥存在本机 Obsidian 的钥匙串里，不随库同步；换设备后在这里重新选一次。', 'Keys live in Obsidian\'s Keychain on this device and do not sync with the vault. On another device, choose the key here again.'))
            .addComponent(el => new SecretComponent(this.app, el)
                .setValue(secretName)
                .onChange(async (value) => {
                    activeConfig.apiKeySecret = value || '';
                    await this.plugin.saveSettings();
                    this.refresh();
                }));
        if (info.keyPage) {
            keySetting.descEl.createEl('br');
            keySetting.descEl.createEl('a', { text: tr('去服务商后台获取密钥', 'Get a key from the provider'), href: info.keyPage });
        }

        let connectionStatus;
        new Setting(containerEl)
            .setName(tr('测试连接', 'Test connection'))
            .setDesc(provider === 'local'
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
        new Setting(containerEl).setName(tr('侧栏外观', 'Sidebar look')).addDropdown(d=>d.addOption('kit',tr('跟随主题','Follow theme')).addOption('paper',tr('暖纸','Warm paper')).setValue(this.plugin.settings.sidebarLook==='paper'?'paper':'kit').onChange(async value=>{this.plugin.settings.sidebarLook=value;await this.plugin.saveSettings();this.plugin.refreshAssistantViews?.();}));
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

// 批量处理选择模态框
class BatchProcessingModal extends GlassModal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
    }

    onOpen() {
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
class AdvancedFileSelectionModal extends GlassModal {
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

    renderFilterBar(container) {
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

    updateFilterDropdown(container, type, inputElement) {
        container.empty();

        if (!type || !['folder', 'tags', 'properties', 'missing-properties'].includes(type)) {
            container.hide();
            return;
        }

        container.show();

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
                    option.show();
                } else {
                    option.hide();
                }
            });

            // 同时触发筛选
            this.applySingleFilter(type, e.target.value);
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
        const hideDropdown = (e) => {
            if (!container.contains(e.target) && e.target !== inputElement) {
                container.hide();
            }
        };

        // 延迟添加事件监听器，避免立即触发
        window.setTimeout(() => {
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
            } catch {
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
            } catch {
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

    updateFileList() {
        if (!this.fileListContainer) return;

        this.fileListContainer.empty();
        this.updateSelectionDisplays();

        if (this.filteredFiles.length === 0) {
            this.fileListContainer.createEl("div", {
                text: tr("没有找到匹配的文件", 'No matching files'),
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
                fileInfo.createDiv({ cls: "ai-assistant-file-name", text: file.basename });
                const fileMeta = fileInfo.createDiv({ cls: "ai-assistant-file-meta" });
                fileMeta.createSpan({ cls: "ai-assistant-file-size", text: `${Math.round(file.stat.size / 1024)} KB` });
                fileMeta.createSpan({ cls: "ai-assistant-file-date", text: new Date(file.stat.mtime).toLocaleDateString() });
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
                    const cache = this.app.metadataCache.getFileCache(file);
                    const frontmatter = cache?.frontmatter || {};

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
                console.error(tr('查询语法解析错误:', 'Query parse error:'), e);
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
    updateSelectionDisplays() {
        if (this.statsText) {
            this.statsText.textContent = tr(`显示 ${this.filteredFiles.length} / ${this.allFiles.length} 个文件，已选择 ${this.selectedFiles.size} 个`, `Showing ${this.filteredFiles.length} of ${this.allFiles.length} files, ${this.selectedFiles.size} selected`);
        }
        if (this.bottomSelectedCount) {
            this.bottomSelectedCount.textContent = tr(`已选择 ${this.selectedFiles.size} 个文件`, `${this.selectedFiles.size} files selected`);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class FolderSelectionModal extends GlassFuzzySuggestModal {
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







export default AiAssistantSuite;
