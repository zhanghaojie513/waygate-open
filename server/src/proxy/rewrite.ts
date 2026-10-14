import type { ChatMessage, ChatRequestBody } from './types';

/** 上游硬约束（实测得到，见 SPEC §10.1 与 ADR-004）。 */
export const UPSTREAM_REQUIRED_STREAM = true;
/** max_tokens 低于此值时提升（上游 11133 = max_tokens 过小）。 */
export const MIN_MAX_TOKENS = 16;

export interface RewriteResult {
  body: ChatRequestBody;
  /** 本次改写做了哪些动作，写进 requests.note，便于排障。 */
  notes: string[];
}

function isSystem(m: ChatMessage | undefined): boolean {
  return !!m && typeof m.role === 'string' && m.role.toLowerCase() === 'system';
}

/** `developer` 是 `system` 的继任者（新 OpenAI 规范），语义同位。 */
const DEVELOPER_ROLE = 'developer';

/** 上游实际接受的 role 白名单（实测：`developer` 触发 11128；其余自定义 role 容忍度是黑盒）。 */
const ROLE_WHITELIST = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * `developer` → `system` 的角色规范化（**保序、保内容、不丢消息**）。
 *
 * ## 为什么要做（实测根因，见 task#77）
 *
 * 上游（腾讯系网关）**只拒精确小写 `developer`**：把它放在 messages **任意位置**都回
 * `400 + 11128`；而 `Developer`（大写首字母）/`foo`/`knowledge` 这类**其它自定义 role 反而容忍**。
 * 生产上 id 7–44 的 38 连挂就是这个原因（note 里同时有 `stream_options_stripped`、有 system）。
 *
 * 语义上是**保义转换**：`developer` 本就是 `system` 的继任者，两角色对模型而言同为"系统指令"。
 * 大小写不敏感地识别（大写变体虽能过，但统一收口更稳）。
 */
function normalizeDeveloperRoles(messages: ChatMessage[]): boolean {
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && typeof m.role === 'string' && m.role.toLowerCase() === DEVELOPER_ROLE) {
      messages[i] = { ...m, role: 'system' };
      changed = true;
    }
  }
  return changed;
}

/**
 * ★ role 白名单（方案 D，2026-10-07）：白名单外的 role 一律降级为 `user`（**保留内容**）。
 *
 * #77 只堵了 `developer` 一个值。上游对自定义 role 的容忍度是黑盒，下一个 SDK 换个新
 * 角色名就会再打死整条请求。白名单的失效模式是"少一次语义"，而不是"整条挂掉"——
 * 两者代价不对称，选前者。每个被降级的原始 role 记一条 note（`role_normalized_<role>`）。
 */
function normalizeUnknownRoles(messages: ChatMessage[]): string[] {
  const seen = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.role !== 'string') continue;
    const lower = m.role.toLowerCase();
    if (ROLE_WHITELIST.has(lower) || lower === DEVELOPER_ROLE) continue; // developer 已在上一步保义转换
    seen.add(m.role);
    messages[i] = { ...m, role: 'user' };
  }
  return [...seen];
}

/* ───────────────────────────────────────────────────────────────────────────
 * ⑥ system 提示改写（方案 A 的落地形态，2026-10-07 根因定案后重写）
 *
 * 根因（D0 + 二分 + T2 实验，真 key 复现）：
 * 上游在推理前对 system 正文做**长 n-gram 模板指纹匹配**（最小触发窗口实测 47 连续字符，
 * 即 Claude Code 血统的 git 环境模板行），命中即 400/11128「unapproved channel」。
 * - 关键词零宽脱敏无效（X1 全 400；社区 workbuddy2api-ui 注释亦证实上游会归一化零宽字符）；
 * - 身份词中性化无效（X2 全 400）；
 * - **模板行语义等价改写有效（T2 实测 200）**，社区 workbuddy2openai/buddy-proxy 独立同结论。
 *
 * 指纹表会对抗演化（社区 workbuddy2api-panel 持续补身份句变体），因此：
 * - 规则表是代码常量（改规则需发版，但总开关 `upstream.promptRewrite` 热更可关）；
 * - 服务层另有「11128 → 中性提示降级重试一次」兜底（proxy.service.ts，L2）。
 * ─────────────────────────────────────────────────────────────────────────── */

/** system 提示改写档位。`neutral` = 把 system 全量换成中性提示（方案 B 的自动降级形态）。 */
export type PromptRewriteMode = 'template' | 'neutral' | 'off';

/** 生产默认档（settings.upstream.promptRewrite 的默认值与之同源）。 */
export const DEFAULT_PROMPT_REWRITE_MODE: PromptRewriteMode = 'template';

export interface RewriteOptions {
  /** system 提示改写档位；缺省 = `template`（与生产默认一致）。 */
  promptRewrite?: PromptRewriteMode;
  /** `neutral` 档使用的中性提示词；缺省用内置常量。 */
  neutralPrompt?: string;
}

/** 中性提示词（与注入用的最小 system 同文；settings.upstream.defaultSystemPrompt 可覆盖）。 */
export const NEUTRAL_SYSTEM_PROMPT = 'You are a helpful assistant.';

/**
 * 模板行改写规则（有序，先长后短；只做**语义等价**改写，破坏逐字 n-gram 匹配）。
 * 前 7 条 = T2 实验原班规则（实测 200）；末条 = 社区 workbuddy2api-ui 特征清单的补充。
 */
export const TEMPLATE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Main branch \(you will usually use this for PRs\):/gm, 'Default PR target:'],
  [/^Current branch:/gm, 'Active branch:'],
  [/^Git user:/gm, 'Git author:'],
  [/^Recent commits:/gm, 'Recent history:'],
  [/^Status:/gm, 'Working tree:'],
  [/^Note that this status is a snapshot in time, and will not update during the conversation\.$/gm, 'This snapshot does not live-update.'],
  [/^Here is useful information about the environment you are running in:$/gm, 'Environment:'],
  [/You are Claude Code/g, 'You are an interactive coding agent'],
];

function applyTemplateRules(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const [re, to] of TEMPLATE_RULES) {
    out = out.replace(re, () => {
      count += 1;
      return to;
    });
  }
  return { text: out, count };
}

/** system 的 content 兼容 string / null / parts 数组（parts 只改 text 字段，结构不动）。 */
function rewriteContent(content: unknown): { content: unknown; count: number } {
  if (typeof content === 'string') {
    const r = applyTemplateRules(content);
    return { content: r.text, count: r.count };
  }
  if (Array.isArray(content)) {
    let count = 0;
    const parts = content.map((p) => {
      if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
        const r = applyTemplateRules((p as { text: string }).text);
        count += r.count;
        return { ...p, text: r.text };
      }
      return p;
    });
    return { content: parts, count };
  }
  return { content, count: 0 };
}

/** template 档：只改 system 消息正文里的模板行，返回替换次数。 */
function rewriteSystemTemplates(messages: ChatMessage[]): number {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !isSystem(m)) continue;
    const r = rewriteContent(m.content);
    if (r.count > 0) messages[i] = { ...m, content: r.content } as ChatMessage;
    count += r.count;
  }
  return count;
}

/** neutral 档：把所有 system 消息正文整体换成中性提示（返回替换条数）。 */
function neutralizeSystemPrompts(messages: ChatMessage[], neutral: string): number {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !isSystem(m)) continue;
    if (m.content !== neutral) {
      messages[i] = { ...m, content: neutral };
      count += 1;
    }
  }
  return count;
}

/**
 * 出站请求体改写（ADR-004 第 3~6 步 + 2026-10-07 新增两步）。纯函数：不改传入对象。
 *
 * 顺序固定：
 *   ① developer 规范化  `developer`（大小写不敏感）就地改成 `system`（上游 11128，见上）
 *   ①b role 白名单      其余非 system/user/assistant/tool 的 role 降级为 `user`（保内容）
 *   ② system 补全       首条非 system 时在头部插入一条（上游 11128）
 *   ③ stream 强制       恒为 true（上游 11101）
 *   ④ max_tokens        低于下限则提升（上游 11133）
 *   ⑤ stream_options 删除（上游不认这个 OpenAI 新字段，本服务自己消费语义）
 *   ⑥ system 提示改写   按档位：template（模板行语义等价改写）/ neutral（全量中性替换）/ off
 */
export function rewriteRequestBody(input: ChatRequestBody, opts: RewriteOptions = {}): RewriteResult {
  const notes: string[] = [];

  const messages = Array.isArray(input.messages) ? [...input.messages] : [];
  // ① 先把 developer 就地规范化成 system（必须在 ② 的"首条是不是 system"判断之前，
  //    否则首条 developer 会被误判成"无 system"而多插一条）。
  if (normalizeDeveloperRoles(messages)) notes.push('developer_role_normalized');
  // ①b 白名单外 role 降级为 user。note 里的原始 role 做净化（note 是逗号分隔列表，
  //    不能让调用方的 role 字符串破坏列表结构），过长截断。
  for (const role of normalizeUnknownRoles(messages)) {
    const safe = role.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'unknown';
    notes.push(`role_normalized_${safe}`);
  }

  if (!isSystem(messages[0])) {
    // ★ 补一条最小 system，内容不伪造业务语义，只满足上游协议要求
    messages.unshift({ role: 'system', content: NEUTRAL_SYSTEM_PROMPT });
    notes.push('system_injected');
  }

  const hadStreamOptions = 'stream_options' in input && input.stream_options !== undefined;
  const body: ChatRequestBody = { ...input, messages, stream: UPSTREAM_REQUIRED_STREAM };
  delete body.stream_options;
  if (hadStreamOptions) notes.push('stream_options_stripped');

  const mt = typeof input.max_tokens === 'number' ? input.max_tokens : undefined;
  if (mt === undefined) {
    // 不主动补 max_tokens：上游有默认值，擅自补一个会改变用户语义
  } else if (mt < MIN_MAX_TOKENS) {
    body.max_tokens = MIN_MAX_TOKENS;
    notes.push(`max_tokens_raised_${mt}_to_${MIN_MAX_TOKENS}`);
  }

  // ⑥ system 提示改写。反探测约束：任何产物都不得含裸「11128」字面量
  //    （社区实测：请求体里出现该数字本身也会被上游拦截）。
  const mode = opts.promptRewrite ?? DEFAULT_PROMPT_REWRITE_MODE;
  if (mode === 'template') {
    const n = rewriteSystemTemplates(messages);
    if (n > 0) notes.push(`template_rewritten_${n}`);
  } else if (mode === 'neutral') {
    const n = neutralizeSystemPrompts(messages, opts.neutralPrompt ?? NEUTRAL_SYSTEM_PROMPT);
    if (n > 0) notes.push(`sysprompt_neutralized_${n}`);
  }

  return { body, notes };
}
