/**
 * User-Agent → 「请求来自哪个工具」的关键词表（api-contract §4 规则 3 的**显示侧**实现）。
 *
 * ── 这个文件解决什么问题 ────────────────────────────────────────────────
 *
 * 控制台原来的「客户端」列回答的其实是「**哪把密钥**进来的」（`client_id` = `key_id`），
 * 而不是「哪个工具发的」。两者在自用场景下经常不是一回事：
 * 同一把 `sk-waygate-…` 既可能给 Claude Code 用、也可能被一个脚本调用，
 * 于是「谁在花我的积分」这个问题在界面上答不出来。
 *
 * `requests.ua` 一直在采（`proxy.controller.ts` 的 `beginContext`），只是从没被解释过。
 * 这里把它解释成一个**工具名**，补上那个缺失的答案。
 *
 * ⛔ **为什么不写进 `client_id`（即为什么不实现「规则 3 改写身份」）**
 *
 * spec-v4-client-id §2 把 `client_id = key_id` 锁成不变量，三处依赖它：
 *   ① `resolveClientName` 的回落链（绑定名 → 密钥名 → 已删除的密钥·掩码）
 *   ② `clients.service.ts` 的 `boundKeyIds = [clientId]`
 *   ③ AC-C01「改一次绑定名，条数与积分数一字不变」
 * 若让 UA 参与 `client_id`，同一把密钥的请求会分裂成多个 client_id，
 * ②③ 当场不成立，而③正是这个产品最贵的那条保证（改名不能让历史数据错位）。
 *
 * 所以这里的定位是**显示层的派生字段**：`tool` 与 `client` 并列展示，
 * 不改身份、不改分组、不需要迁移。`client_rule` 因此仍只写 2 / 4 ——
 * 这是刻意的，不是漏做。
 *
 * ✅ 附带的好处：`ua` 是原样落库的，所以这张表**随时可增补**，
 *    改完立刻对所有历史行生效（读取时解释，不是写入时固化）——
 *    「先观察真实 UA 分布，再决定关键词」这条路因此走得通。
 */

export interface ToolMatch {
  /** 工具显示名，如 `Claude Code`。 */
  tool: string;
  /** 命中的关键词，回显给用户看"凭什么这么判"。 */
  keyword: string;
}

/**
 * 关键词表 —— **顺序敏感**：先匹配到的胜出，所以更具体的必须排在更笼统的前面。
 *
 * 例：Claude Code 的 UA 形如 `claude-cli/1.0.60 (external, cli)`，而某些客户端
 * 会在 UA 里带上 `axios/…`；若把 `axios` 排在前面就会误判。同理 `node` 极笼统，
 * 放在 `openai-node` / `claude-cli` 之后。
 *
 * 匹配一律**小写包含**（`includes`），不做正则 —— 关键词表要能被非作者安全地增补，
 * 正则写错一个元字符就会静默失配，而失配的表现只是"没识别出来"，不会报错。
 */
const UA_TABLE: ReadonlyArray<{ keyword: string; tool: string }> = [
  // —— CLI / 官方客户端 ——
  { keyword: 'claude-cli', tool: 'Claude Code' },
  { keyword: 'claude-code', tool: 'Claude Code' },
  { keyword: 'anthropic-sdk', tool: 'Anthropic SDK' },
  { keyword: 'codebuddy', tool: 'CodeBuddy' },
  { keyword: 'codex', tool: 'Codex CLI' },
  { keyword: 'gemini-cli', tool: 'Gemini CLI' },
  { keyword: 'aider', tool: 'Aider' },
  { keyword: 'cline', tool: 'Cline' },
  { keyword: 'roo-code', tool: 'Roo Code' },
  { keyword: 'continue', tool: 'Continue' },

  // —— IDE / 桌面 ——
  { keyword: 'cursor', tool: 'Cursor' },
  // 同一个产品的 UA 有三种常见写法（连字符 / 无分隔 / 空格）。
  // 这是**单测逼出来的一条**：最初只写了前两种，`Cherry Studio/1.2.0` 直接掉进"认不出来"。
  { keyword: 'cherry-studio', tool: 'Cherry Studio' },
  { keyword: 'cherrystudio', tool: 'Cherry Studio' },
  { keyword: 'cherry studio', tool: 'Cherry Studio' },
  { keyword: 'vscode', tool: 'VS Code' },
  { keyword: 'jetbrains', tool: 'JetBrains' },
  { keyword: 'chatbox', tool: 'Chatbox' },
  { keyword: 'lobechat', tool: 'LobeChat' },
  { keyword: 'open-webui', tool: 'Open WebUI' },
  { keyword: 'nextchat', tool: 'NextChat' },

  // —— SDK / 语言运行时（较笼统，放在具体客户端之后）——
  // [v0.4.24] **语言/运行时优先于 SDK 名**：`OpenAI/Python 2.24.0` 若先命中 `openai/`
  // 会判成「OpenAI SDK」——那是"哪个 SDK"，不是"什么语言"。而语言/运行时才是
  // 排障时有用的维度（Python 慢、Node 快、版本对不上），也是参考图里第二行显示的东西。
  // 故 python / node 两族整体提到 `openai/` 之前。整体仍"具体在前、笼统在后"。
  { keyword: 'python-requests', tool: 'Python requests' },
  { keyword: 'python-urllib', tool: 'Python urllib' },
  { keyword: 'httpx', tool: 'Python httpx' },
  { keyword: 'aiohttp', tool: 'Python aiohttp' },
  { keyword: 'openai-python', tool: 'Python' },
  { keyword: 'python', tool: 'Python' },
  { keyword: 'axios', tool: 'Node axios' },
  { keyword: 'undici', tool: 'Node undici' },
  { keyword: 'node-fetch', tool: 'Node fetch' },
  { keyword: 'openai-node', tool: 'Node.js' },
  { keyword: 'node', tool: 'Node.js' },
  { keyword: 'deno', tool: 'Deno' },
  { keyword: 'bun/', tool: 'Bun' },
  // —— SDK 兜底（语言认不出时按 SDK 判）——
  { keyword: 'openai/', tool: 'OpenAI SDK' },
  { keyword: 'anthropic/', tool: 'Anthropic SDK' },
  { keyword: 'okhttp', tool: 'Android okhttp' },
  { keyword: 'go-http-client', tool: 'Go http' },
  { keyword: 'guzzle', tool: 'PHP Guzzle' },
  { keyword: 'curl', tool: 'curl' },
  { keyword: 'wget', tool: 'wget' },
  { keyword: 'postman', tool: 'Postman' },
  { keyword: 'insomnia', tool: 'Insomnia' },
];

/**
 * 从 UA 解析工具名。**解析不出就返回 `null`** —— 由调用方决定显示什么，
 * 这里不编一个「未知工具」的假名（那和真识别出某个工具在界面上长得一样）。
 *
 * `null` 有三种来源，都不该被粉饰：没有 UA、UA 是空串、UA 不在表里。
 */
export function detectTool(ua: string | null | undefined): ToolMatch | null {
  if (typeof ua !== 'string') return null;
  const low = ua.trim().toLowerCase();
  if (low === '') return null;
  for (const entry of UA_TABLE) {
    if (low.includes(entry.keyword)) return { tool: entry.tool, keyword: entry.keyword };
  }
  return null;
}

/**
 * UA 的展示截断：长 UA 会带一长串注释（如 `(external, cli; +https://…)`），
 * 详情抽屉里放不下。**截断而不是丢弃** —— 前 48 字符已足够认出工具，
 * 而完整原文仍留在库里、随时可查。
 */
export const UA_DISPLAY_MAX = 48;

export function shortenUa(ua: string | null | undefined, max = UA_DISPLAY_MAX): string | null {
  if (typeof ua !== 'string') return null;
  const t = ua.trim();
  if (t === '') return null;
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** 供测试与「关键词表自检」使用：表内关键词不得重复（重复说明顺序意图被写糊了）。 */
export function uaTableKeywords(): string[] {
  return UA_TABLE.map((e) => e.keyword);
}
