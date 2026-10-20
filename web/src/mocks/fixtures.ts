/**
 * Mock 数据（仅 npm run dev:mock 启用）。
 * 数据不是编的：模型名取自 design/model-catalog.json 的 17 项实测清单（外加 1 项
 * upstream 演示项 `kimi-k3-1`，其倍率未知 ⇒ 用来验证「倍率未知」的渲染），
 * 客户端名 / 密钥 hint 取自 prototype/console.html，设置项取自 design/api-contract.md §3.8。
 */

import type {
  BreakdownItem,
  CatalogData,
  CatalogModel,
  ClientKeyRow,
  ClientRow,
  OverviewData,
  RequestDetail,
  RequestLogRow,
  SettingsData,
  TrendPoint,
} from '../types/api';
import { MOCKS_ENABLED } from '../services/http';
import { NOTE_CREDENTIAL_INVALID, hasNote } from '../lib/format';

const MODEL_SEED: Array<Pick<CatalogModel, 'displayName' | 'id' | 'tag' | 'multiplier'>> = [
  { displayName: 'Hy4 preview', id: 'hy4-preview', tag: '限时免费', multiplier: 0.0 },
  { displayName: 'Hy3', id: 'hy3', tag: '限时免费', multiplier: 0.0 },
  { displayName: 'Space-Bunny', id: 'space-bunny', tag: '限时折扣', multiplier: 0.03 },
  { displayName: 'Deepseek-V4.1-Flash', id: 'deepseek-v4.1-flash', tag: null, multiplier: 0.11 },
  { displayName: 'Deepseek-V4-Pro', id: 'deepseek-v4-pro', tag: null, multiplier: 0.51 },
  { displayName: 'GLM-5.3', id: 'glm-5.3', tag: '订阅优先', multiplier: 0.79 },
  { displayName: 'GLM-5.3-Flash', id: 'glm-5.3-flash', tag: '订阅优先', multiplier: 0.06 },
  { displayName: 'GLM-5.3-FlashX', id: 'glm-5.3-flashx', tag: '订阅优先', multiplier: 0.14 },
  { displayName: 'GLM-5.2', id: 'glm-5.2', tag: null, multiplier: 0.79 },
  { displayName: 'GLM-5.1', id: 'glm-5.1', tag: null, multiplier: 0.79 },
  { displayName: 'GLM-5v-Turbo', id: 'glm-5v-turbo', tag: null, multiplier: 0.71 },
  { displayName: 'MiniMax-M3', id: 'minimax-m3', tag: null, multiplier: 0.25 },
  { displayName: 'Kimi-K3', id: 'kimi-k3', tag: '订阅优先', multiplier: 1.62 },
  { displayName: 'Kimi-K2.8-Preview', id: 'kimi-k2.8-preview', tag: '订阅优先', multiplier: 0.77 },
  { displayName: 'Kimi-K2.7-Code', id: 'kimi-k2.7', tag: null, multiplier: 0.57 },
  { displayName: 'Kimi-K2.6', id: 'kimi-k2.6', tag: null, multiplier: 0.52 },
  { displayName: 'Step-5-Preview', id: 'step-5-preview', tag: '订阅优先', multiplier: 0.43 },
  // 上游目录新增、本地映射表尚无它的那一类 —— 倍率未知（null），不编造。
  { displayName: 'Kimi-K3-1', id: 'kimi-k3-1', tag: '订阅优先', multiplier: null },
];

/**
 * 来源演示（供「模型清单」按来源打标签）：
 *   - `kimi-k3-1`：从上游目录拉取（`upstream`），且本地倍率表尚无它 ⇒ `multiplier: null`
 *   - `step-5-preview`：演示人工添加（`manual`）
 *   - 其余仍是本地种子（`seed`，上游拉取失败时的回落）
 */
const UPSTREAM_SOURCE_IDS = new Set(['kimi-k3-1']);
const MANUAL_SOURCE_IDS = new Set(['step-5-preview']);
function sourceOf(id: string): CatalogModel['source'] {
  if (UPSTREAM_SOURCE_IDS.has(id)) return 'upstream';
  if (MANUAL_SOURCE_IDS.has(id)) return 'manual';
  return 'seed';
}

export const CATALOG: CatalogData = {
  source: 'seed',
  fetchedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  // mock 的 settings 里 credential.source 是有值的（已配置），
  // 这里也必须为 true —— 否则同一份 mock 数据自相矛盾，
  // 会让开发者在 Mock 下看到一个真实环境不可能出现的组合。
  upstreamReachable: true,
  models: MODEL_SEED.map((m) => ({
    ...m,
    family: m.id.split('-')[0],
    source: sourceOf(m.id),
    provider: m.id.startsWith('MiniMax-') || m.id.startsWith('minimax-') ? 'MiniMax Code' : 'WorkBuddy',
    verified: m.id === 'glm-5.1' || m.id === 'hy3' ? 0 : 1,
    enabled: true,
    lastVerifiedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  })),
};

/**
 * 客户端：**稳定 id 与显示名必须分离**（`spec-v4-client-id.md` §2/§5）。
 *
 * id 按契约的模型取：rule-2（密钥归属）= 这把客户端所用密钥的 `key_id`；
 * rule-4（兜底）= 字面量 `'unidentified'`。名字只是标签。
 *
 * ⚠️ 之所以不能拿名字当键：改一次名，按名字分组 / 过滤 / 聚合会**静默失配** ——
 * 不报错、不难看，只是那一批请求悄悄不算数了（AC-C06 要证的正是这条）。
 */
const CLIENTS: Array<{ id: string; name: string }> = [
  { id: 'k_8f21', name: 'Claude Code' },
  { id: 'k_1b83', name: 'Cherry Studio' },
  { id: 'k_9d02', name: 'Cursor' },
  { id: 'k_c3a5', name: 'Cron Job' },
  { id: 'k_77c1', name: '手机端（临时）' },
  { id: 'unidentified', name: '未识别客户端' },
];

/** 改名演练的覆盖表，key 恒为 `clientId`。 */
const CLIENT_NAME_OVERRIDE = new Map<string, string>();

/**
 * 当前显示名（按 id 查，再套覆盖）。
 * 查不到时返回固定文案而**不是**把 id 抛出去 —— 界面上不该出现裸 id（AC-C07）。
 */
function clientName(clientId: string): string {
  return (
    CLIENT_NAME_OVERRIDE.get(clientId) ?? CLIENTS.find((c) => c.id === clientId)?.name ?? '未知客户端'
  );
}

/* [2026-10-17 命名裁决] byClient 走**提供商**维度（生产 v0.5.15 起按「模型→目录
   →provider」归属，桶名=提供商名；面板标题已改「提供商用量摘要」）。
   4 桶 = 3 家提供商 + 1 个未归属桶（生产真实存在：模型不在任何生效目录时归 null 桶）。
   clientId 键与 CLIENTS 结构**不动** —— 自洽断言、AC-C06 改名演练仍按密钥跑。 */
const PROVIDER_OF_CLIENT: Record<string, string | null> = {
  k_9d02: 'Qoder CN',      // Cursor 的量全走 qfmodel
  k_8f21: 'WorkBuddy',     // Claude Code 订阅
  k_1b83: 'MiniMax Code',  // Cherry Studio 的 anthropic 方言
  k_c3a5: null,            // 目录已删的模型 → 未归属桶
};

/** byClient 桶的显示名：提供商名；null 桶如实显示「未归属」（不冒充任何一家）。 */
function providerBucketName(clientId: string): string {
  const p = PROVIDER_OF_CLIENT[clientId];
  return p ?? '未归属';
}

/**
 * **仅 Mock / 测试**：改掉某个客户端的显示名，`clientId` 一动不动。
 *
 * 存在的唯一理由：AC-C06（「改名后同一筛选的结果集不变」）必须能在 Mock 下**真的失败**。
 * 没有这条钩子就没法在 Mock 里演练改名，那条断言就成了恒真断言 ——
 * 而"复制一份逻辑的测试等于没有测试"。
 */
export function renameClientForTest(clientId: string, displayName: string): void {
  CLIENT_NAME_OVERRIDE.set(clientId, displayName);
}

/**
 * **写入时的快照名** —— 日志行的 `client` 用它，**不随改名回填**（`spec-v4-client-id.md` §4 / §9.2）。
 *
 * 与 `clientName()` 的区别是本任务的关键：
 *   · `clientName()` 查覆盖表 ⇒ **当前显示名**，随改名而变（clients 页 / byClient 用）
 *   · `clientSnapshotName()` 只认基线表 ⇒ **写入那一刻的名字**，改名后**故意**保持旧值
 * 日志表要显示"当前名"时，必须用 `clientId` 去 /api/clients 映射（§9.2），
 * 映射不到才回落到这个快照。若两者混用，改动就退化成"换个地方显示同一份名字"。
 */
function clientSnapshotName(clientId: string): string {
  return CLIENTS.find((c) => c.id === clientId)?.name ?? '未识别';
}

const KEY_HINTS = [
  'sk-waygate-4f9c…7a2e',
  'sk-waygate-1b83…c40f',
  'sk-waygate-9d02…3ee1',
  'sk-waygate-c3a5…91d7',
  'sk-waygate-77c1…b8f0',
  'sk-waygate-2e6b…0a13',
];
const HOT_MODELS = ['kimi-k3', 'glm-5.3', 'kimi-k2.7', 'deepseek-v4.1-flash', 'minimax-m3', 'kimi-k2.8-preview'];

function modelById(id: string): CatalogModel {
  return CATALOG.models.find((m) => m.id === id) ?? CATALOG.models[0];
}

/**
 * 每次请求的错误形态按序号轮转 —— 槽位 5 放在**第一页**，保证不翻页就能看到
 * 「上游访问密钥失效」，从而让筛选与统计卡能被验证（否则它们看起来像坏的）。
 *
 * ⚠️ 「上游访问密钥失效」= **status 502 + note `upstream_credential_invalid`**，
 * **不是 status 401**：`status` 是「客户端实际收到的码」，上游 401 按契约映射成 502
 * （`spec-v4-failure-logging.md` §3 的 ⚠️ 注）。识别它只能靠 note。
 */
function statusFor(i: number): { status: number; upstreamCode: number | null; note: string } {
  const slot = i % 37;
  if (slot === 5) return { status: 502, upstreamCode: null, note: NOTE_CREDENTIAL_INVALID };
  if (slot === 11) return { status: 429, upstreamCode: null, note: 'rate limited' };
  if (slot === 19) return { status: 504, upstreamCode: null, note: 'upstream timeout' };
  if (slot === 31) return { status: 400, upstreamCode: 11102, note: 'model_not_available' };
  /* [task#52] 原来 slot34 是 `'upstream_11128,retried'`、slot7 是 `'retried'` —— 两处都
     **凭空造了一个不存在的过程**：契约 §2.1.6 明写「v0.1 未实现自动重试，`retried` 恒不出现」。
     mock 里出现它，界面就会在请求日志列上打出「已自动重试」，
     与「11128 的处置文案不能声称已补发/已重试」是同一个缺陷。
     改成只会真实发生的标记（slot7 用 stream_options_stripped：入站带 stream_options 时后端会删并记）。 */
  if (slot === 34) return { status: 502, upstreamCode: 11128, note: 'upstream_11128' };
  if (slot === 7) return { status: 200, upstreamCode: null, note: 'stream_options_stripped' };
  if (slot === 3) return { status: 200, upstreamCode: null, note: 'cache hit' };
  // 上游未回报该次积分时，后端会在这行 note 里追加该标记（proxy-log.ts）。
  // 单独出现时是**第一个**标记 —— 正好用来验证 noteLabel 不会把裸英文抛上屏。
  // 槽位 9 落在第一页（每页 20 行），不必翻页就能看到。
  if (slot === 9) return { status: 200, upstreamCode: null, note: 'credits_unknown' };
  return { status: 200, upstreamCode: null, note: 'system_injected' };
}

export function makeRequestRow(i: number): RequestLogRow {
  const model = HOT_MODELS[i % HOT_MODELS.length];
  const client = CLIENTS[i % CLIENTS.length];
  const { status, upstreamCode, note } = statusFor(i);
  const failed = status >= 400;
  // 失败行不消耗积分：tokens / credits 记 0（契约 §3）。上游访问密钥失效那条同样如此。
  const zeroUsage = failed && hasNote(note);
  const promptTokens = zeroUsage ? 0 : 16 + ((i * 37) % 240);
  const completionTokens = failed ? 0 : 96 + ((i * 91) % 900);
  /* [v0.5.8] 单条积分在生产里**只来自上游回报**（`usage.credit`）—— 本服务不再自算。
     这里给的是**演示值**：数值形态与真实一致（随模型倍率与 tokens 走），但它是 Mock 的
     固定算式，不是生产计价逻辑（生产那份逻辑已整段删除，见 proxy-log.ts）。
     槽位 9 演示「上游未回报」：credits = null（界面渲染 `--`，不是 0）。
     ⚠️ 不要把这里当成计价公式的参考实现 —— 参考实现不存在，因为本服务不标定。 */
  const creditsUnknown = note.includes('credits_unknown');
  const multiplier = modelById(model).multiplier ?? NEUTRAL_MULTIPLIER;
  const credits = creditsUnknown
    ? null
    : Math.round((promptTokens + completionTokens) * multiplier * 100) / 100;
  /* [2026-10-08] 逐行缓存命中 tokens：三行里有一行命中，命中量取输入的约 72%。
     给的是**可读的样本**而不是与全局 hitRate 对齐的数 —— 详情卡要让人亲眼看到
     「这条便宜是因为缓存」。失败行恒 0（与 tokens 同一条口径）。 */
  const cachedTokens = zeroUsage ? 0 : i % 3 === 0 ? Math.round(promptTokens * 0.72) : 0;
  /* 工具名从 UA 现解析 —— 与生产同一条链（server/src/identify/ua-table.ts）。
     [2026-10-09] UA 原文**列表行也带**了：列表新增「User Agent」列，
     要同时显示原文与判定出的工具名（判定会错，原文才是依据）。
     生产同步改了 `requests.service.ts` 的 `toListItem`（此前只有详情带 ua）。 */
  const ua = MOCK_UA[i % MOCK_UA.length];
  return {
    id: 10241 - i,
    ts: new Date(Date.now() - i * 47_000).toISOString(),
    clientId: client.id,
    // 快照名（不随改名回填）—— 与生产一致；界面要显示当前名得自己按 clientId 映射（§9.2）。
    client: clientSnapshotName(client.id),
    model,
    modelDisplay: modelById(model).displayName,
    status,
    upstreamCode,
    ms: failed ? 310 + ((i * 53) % 900) : 640 + ((i * 67) % 2400),
    queuedMs: i % 9 === 0 ? 2400 : 0,
    firstByteMs: failed && status !== 429 ? null : 220 + ((i * 29) % 700),
    promptTokens,
    completionTokens,
    // [v0.2.0] 输出里的思考 tokens（含在 completionTokens 内）。失败行 0；部分成功行有思考。
    reasoningTokens: failed ? 0 : i % 3 === 0 ? Math.floor(completionTokens * 0.7) : 0,
    cachedTokens,
    credits,
    stream: true,
    /* 由 note 推导，不单独编数：v0.1 没有自动重试（`retried` 恒不出现），
       所以这里如实恒为 0；将来真做了重试，只要 note 带 `retried` 就自动跟上。 */
    retryCount: note.includes('retried') ? 1 : 0,
    note,
    keyHint: KEY_HINTS[i % KEY_HINTS.length],
    tool: toolOfUa(ua),
    ua,
  };
}

/**
 * Mock 的 UA 样本 —— 刻意混入**一条认不出来的**（`WeirdClient/9.9`），
 * 这样「认不出来的 UA」那一栏在 Mock 下也有内容可看，
 * 不至于要等真机才发现那段渲染是空的。
 */
const MOCK_UA = [
  'claude-cli/1.0.60 (external, cli)',
  'Cherry Studio/1.2.0',
  'Cursor/0.42.3 (darwin arm64)',
  'python-requests/2.32.3',
  'WeirdClient/9.9 (unknown-build)',
  /* [2026-10-09] 长 UA + 兜底关键词的**真实形态**：含 `runtime/node.js`，
     会被末尾的 `node` 兜底判成「Node.js」。Mock 必须带这一条 ——
     否则「User Agent 列被截断成什么样」「判定结果与原文并列长什么样」在 Mock 下看不到，
     而这两个正是新增那一列的理由。 */
  'ZCode/3.14.5 ai-sdk/provider-utils/4.0.39 runtime/node.js',
];

/**
 * UA → 工具名（与生产同源判定）。
 *
 * ⚠️ 这里**刻意只做一份很短的复制**，而不是从 server 引 —— 前后端是两个独立包，
 * 没有共享源码的通道。代价是两边可能漂移，所以 Mock 里只放**最少**的关键词
 * （够覆盖上面那 5 条样本），真正的权威表在 `server/src/identify/ua-table.ts`。
 * 若要在 Mock 里加样本，先确认它落在权威表的关键词覆盖内。
 */
function toolOfUa(ua: string): string | null {
  const low = ua.toLowerCase();
  if (low.includes('claude-cli')) return 'Claude Code';
  if (low.includes('cherry-studio') || low.includes('cherry studio')) return 'Cherry Studio';
  if (low.includes('cursor')) return 'Cursor';
  if (low.includes('python-requests')) return 'Python requests';
  /* [2026-10-09] 兜底项，与生产关键词表末尾的 `{ keyword: 'node', tool: 'Node.js' }` 对应。
     必须在具体客户端**之后** —— 表是顺序敏感的（生产的同一条纪律）。
     实测形态：`ZCode/3.14.5 … runtime/node.js` 里含 `node`，因此判为 Node.js。 */
  if (low.includes('node')) return 'Node.js';
  return null; // 认不出来 —— 与生产一样，不编造工具名
}

export const REQUEST_TOTAL = 1284;

export function makeRequestPage(page: number, limit: number): RequestLogRow[] {
  const start = (page - 1) * limit;
  return Array.from({ length: Math.min(limit, Math.max(0, REQUEST_TOTAL - start)) }, (_, k) =>
    makeRequestRow(start + k),
  );
}

export function makeRequestDetail(id: number): RequestDetail {
  const row = makeRequestRow(Math.max(0, 10241 - id));
  const upstream = hasNote(row.note);
  return {
    ...row,
    /* 详情端点独有字段 —— 与生产 `requests.service.ts` 的 `detail()` 逐字对齐：
       少了这些，详情卡的「来源」一行在 Mock 下永远是空的，而真机上却有值，
       那段渲染就要等真机才发现写错。 */
    totalTokens: row.promptTokens + row.completionTokens,
    clientRule: row.clientId === 'unidentified' ? 4 : 2,
    keyId: row.clientId === 'unidentified' ? null : row.clientId,
    remoteIp: '203.0.113.7',
    ua: MOCK_UA[Math.max(0, 10241 - id) % MOCK_UA.length],
    messages: [
      { role: 'system', content: upstream ? 'You are a helpful assistant.' : '你是一个安静的命令行助手。' },
      { role: 'user', content: '把当前目录里最近改过的三个文件列出来，只给文件名。' },
    ],
    assistantPreview: upstream
      ? null
      : '最近改过的三个文件：\n1. server/src/proxy/proxy.service.ts\n2. web/src/pages/RequestsPage.tsx\n3. design/api-contract.md',
    requestBody: null,
    responseBody: null,
  };
}

function trendPoint(daysAgo: number): TrendPoint {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  /* 30 天窗口的趋势是**日桶**（api-contract §3.4：7d/30d → 'YYYY-MM-DD'，无 T00 后缀；
     带 T 会被前端当小时桶显示「N时」，30 个同名日标签就废了）。 */
  const bucket = d.toISOString().slice(0, 10);
  const wave = 62 + Math.round(28 * Math.sin((daysAgo / 30) * Math.PI * 2));
  const requests = Math.max(12, wave + ((daysAgo * 13) % 17));
  /* [v0.5.11] tokens：每请求固定 1030（820 in + 210 out，与 metrics 的口径同源）——
     Σtrend.tokens === metrics.totalTokens 才能过自检（tokens 也进了那条硬规则）。 */
  const tokens = requests * (TOKENS_PER_REQUEST_PROMPT + TOKENS_PER_REQUEST_COMPLETION);
  return {
    bucket,
    requests,
    tokens,
    credits: Math.round(requests * 0.9 * 100) / 100,
    errors: daysAgo % 5 === 0 ? 3 : 0,
    /* 按模型切片（tooltip 用）：按 MODEL_MIX 的请求权重分账本桶 tokens，取前 5。
       生产端由服务端排好序；Mock 端自己排。 */
    models: modelSlicesFor(tokens),
  };
}

/**
 * 每个客户端常用的模型 —— **单一来源**。
 *
 * 客户端页（`makeClients().models` → 「常用模型」列）与用量页 tooltip
 * （`byClient[].models` 切片）都用它。两处各写一份必然漂移：客户端页显示
 * 「常用模型 kimi-k3」而 tooltip 列出别的模型，同一个 mock 自相矛盾。
 *
 * ⚠️ 位置有约束：必须声明在**模块加载期自检**（文件末尾的 `if (MOCKS_ENABLED)`）
 * 之前 —— 自检会调用 `makeOverview()`，而 `const` 在那之前处于 TDZ，
 * 晚声明会让自检拿到 undefined 直接抛错（实测：整个 mock 模式白屏）。
 */
const CLIENT_MODELS: Record<string, string[]> = {
  k_8f21: ['kimi-k3', 'glm-5.3'],
  k_1b83: ['glm-5.3', 'kimi-k2.8-preview'],
  k_9d02: ['kimi-k3'],
  k_c3a5: ['deepseek-v4.1-flash'],
};

const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((s, x) => s + f(x), 0);
/** 积分一律以「分」为整数单位参与求和 —— 浮点累加会让 Σ 与总额差出 1e-13 级的尾巴。 */
const cents = (credits: number) => Math.round(credits * 100);

/**
 * [v0.5.11] 一个趋势桶内的按模型 token 切片（tooltip 用）。
 * 按 MODEL_MIX 的请求权重把本桶 tokens 整数分账（Σ 恰等于桶总额），按 token 降序取前 5 ——
 * 与生产端 `overview.service.ts` 的 TREND_TOP_MODELS 同口径。
 * MODEL_MIX 在本文件更下方声明（const）—— 本函数只在造数时被调用，届时已初始化。
 */
function modelSlicesFor(tokens: number): Array<{ model: string; tokens: number }> {
  const parts = apportion(tokens, MODEL_MIX.map((m) => m.requests));
  return MODEL_MIX
    .map((m, i) => ({ model: m.id, tokens: parts[i] }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
}

/**
 * 30 天趋势 —— 概览所有数字的**唯一锚点**。
 *
 * 契约硬规则（design-spec §18.8 / api-contract §3.4）：
 *   Σtrend.credits === metrics.creditsUsed === ΣbyModel.credits === ΣbyClient.credits
 * 所以 metrics 与两份明细都由这里推导，不再各自写死。
 *
 * 趋势的 requests / credits 只由 daysAgo 决定、与"今天是哪天"无关，
 * 因此下面的自检可以在模块加载时跑，结果稳定。
 */
function buildTrend(): TrendPoint[] {
  return Array.from({ length: 30 }, (_, i) => trendPoint(29 - i));
}

/* ==========================================================================
   按窗口造数（2026-10-09）
   ---------------------------------------------------------------------------
   背景：控制台默认窗口改成「今日」后，Mock 原来的"一份 30 天数据集"就说不通了 ——
   选择器写着「今日」、数字却是 30 天的。这恰是下面 makeOverview 里那条注释
   早就警告过的自相矛盾（「窗口：最近 24 小时」配 30 天数字）。

   现在按窗口造数，**粒度与桶数镜像服务端** `server/src/api/window.ts`：

     window   桶粒度   桶数
     today    hour     本地零点到现在（1..24）
     1h       hour     2
     24h      hour     25
     7d       day      8
     30d      day      31

   [v1.6.31] 桶数不再是「窗口时长 ÷ 桶粒度」：服务端把桶序列的**起点向下对齐**
   到桶边界（`floor(from)`）再排到当前桶，图的覆盖区间 ⟨⊇⟩ 窗口区间，
   于是 `Σtrend.requests === metrics.requests` 成为结构性保证。
   代价是首/末桶各只覆盖窗口的一部分 —— 这由 `partial` 字段如实标出。

   硬规则不变（`assertOverviewConsistent`）：五路合计**逐分相等**。
   靠的是精确整数分账（`apportion`，最大余数法），不是各自 round ——
   各自 round 会让 Σ 差出几个单位，页面上「按模型」与「按客户端」两个总数就不一样。
   ========================================================================== */

/** 窗口键 —— 与服务端 `WindowKey` 一致。 */
export type MockWindow = 'today' | '1h' | '24h' | '7d' | '30d';

export const MOCK_WINDOWS: readonly MockWindow[] = ['today', '1h', '24h', '7d', '30d'];

const HOUR_MS = 3_600_000;

/**
 * 整数分账：把 `total` 按 `weights` 拆成整数，**和恰好等于 total**（最大余数法）。
 * 余数按小数部分从大到小派发、同分按下标 —— 结果确定，不随引擎/浮点实现漂移。
 */
function apportion(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0) || !(totalW > 0)) return new Array<number>(n).fill(0);
  const raw = weights.map((w) => (total * w) / totalW);
  const out = raw.map((v) => Math.floor(v));
  let rest = total - out.reduce((s, v) => s + v, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && rest > 0; k += 1) {
    out[order[k].i] += 1;
    rest -= 1;
  }
  return out;
}

/**
 * 24 小时权重（凌晨最低、晚间最高）。**常量**，前端与原型逐字镜像 ——
 * 改成随机数会让两侧的柱高对不上，而那种红看起来像"图表坏了"。
 */
const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2, 3, 6, 9, 11, 12, 12, 11, 12, 12, 11, 12, 13, 14, 15, 17, 18, 12, 6,
];

/** 本地小时桶标签 —— 与服务端 `api/window.ts` 的 `hourBucket` 同格式（`YYYY-MM-DDTHH`）。 */
function hourBucket(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/**
 * 窗口 → `[from, to)` 毫秒区间 —— **镜像服务端** `server/src/api/window.ts` 的 `windowRange`。
 *
 * Mock 要能如实标出「不足一格」的桶，就得有与服务端**同一个**窗口区间；
 * 否则两边的首/末桶判定会分叉（这正是本项目 mock 门禁在防的那类漂移）。
 */
function mockWindowRange(win: MockWindow, nowMs: number): { from: number; to: number } {
  if (win === 'today') {
    const d = new Date(nowMs);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { from, to: nowMs + 1 };
  }
  const ms = win === '1h' ? HOUR_MS : win === '24h' ? 24 * HOUR_MS : win === '7d' ? 7 * 86_400_000 : 30 * 86_400_000;
  return { from: nowMs - ms, to: nowMs + 1 };
}

/**
 * 该桶是否只覆盖窗口的一部分（**镜像服务端** `markPartialBuckets`）。
 *
 * 判定：桶的真实时间跨度 `[桶起点, 桶起点 + step)` 与窗口 `[from, to)` 的交集
 * 短于 step。服务端 1ms 容差（窗口末端是 `now + 1`），这里照抄。
 */
function markPartial(bucket: string, step: number, from: number, to: number): boolean {
  const s = new Date(bucket.includes('T') ? `${bucket}:00:00` : `${bucket}T00:00:00`).getTime();
  const covered = Math.min(s + step, to) - Math.max(s, from);
  return covered < step - 1;
}

/**
 * 把「今天」这一天的请求/积分/失败拆成 `count` 个小时桶，末桶 = 当前小时。
 * 桶数由窗口决定（today = 已过小时数、24h = 25、1h = 2），数值按 `HOUR_WEIGHTS` 分账。
 */
function hourlyTrend(count: number, nowMs: number, day: TrendPoint, partials?: boolean[]): TrendPoint[] {
  const endMs = new Date(nowMs).setMinutes(0, 0, 0);
  const stamps = Array.from({ length: count }, (_, i) => endMs - (count - 1 - i) * HOUR_MS);
  const weights = stamps.map((ms) => HOUR_WEIGHTS[new Date(ms).getHours()]);
  const reqs = apportion(day.requests, weights);
  const errs = apportion(day.errors, weights);
  /* [v0.5.11] tokens 与 requests 同权重分账（每请求 1030，日合计与日桶总数一致）。 */
  const toks = apportion(day.tokens, weights);
  return stamps.map((ms, i) => ({
    bucket: hourBucket(ms),
    requests: reqs[i],
    tokens: toks[i],
    /* credits 由 makeOverview 在定出本窗口积分总额后统一分账 —— 见那里的说明。
       这里先留 0，避免出现"看起来有值但最后被覆盖"的中间态。 */
    credits: 0,
    /* 失败数不能超过该桶的请求数（分账按权重摊，权重小的桶可能摊到 1 次失败但 0 次请求）。 */
    errors: Math.min(reqs[i], errs[i]),
    models: modelSlicesFor(toks[i]),
    /* [v1.6.31] 首/末桶常只覆盖窗口的一部分（窗口按 now 滚动、不对齐整点）。
       数字是真的，但不足一整格 —— 前端 tooltip 据此注明「不足一格」。 */
    partial: partials?.[i] ?? false,
  }));
}

/**
 * 按窗口造趋势（**不含 credits** —— 那一路由积分总额反向分账，见 `makeOverview`）。
 *
 * 数值只依赖"第几个桶"（沿用 `trendPoint` 的伪时间纪律），与"今天是哪天"无关；
 * 只有小时桶的**标签**跟着时钟走。
 *
 * [v1.6.31] 桶序列与服务端 `fillEmptyBuckets` 同语义：从窗口起点**向下对齐**到
 * 桶边界，到当前桶为止 —— 所以 24h 是 25 格、1h 是 2 格（不是时长 ÷ 1 小时）。
 * 旧 mock 也是"从末尾往前数 count 格"，与服务端一起错；两边同步修，才不会让
 * `dev:mock` 与真实行为悄悄分叉（本项目已有一道 mock 文案门禁在防这类漂移）。
 */
export function buildWindowTrend(win: MockWindow, nowMs: number = Date.now()): TrendPoint[] {
  const daily = buildTrend();
  const { from, to } = mockWindowRange(win, nowMs);
  /* 日桶窗口（7d/30d）：桶序列同样**向下对齐**到窗口起点那一天的零点，
     排到当前日 —— 7d → 8 格、30d → 31 格（与服务端 `fillEmptyBuckets` 同语义）。 */
  if (win === '30d' || win === '7d') {
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const end = new Date(to - 1);
    end.setHours(0, 0, 0, 0);
    const stamps: number[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) stamps.push(t);
    /* 取 daily 序列里桶标签对得上的那些（daily 是 30 天的日桶，标签 = YYYY-MM-DD）。 */
    const byLabel = new Map(daily.map((p) => [p.bucket, p]));
    return stamps.map((ms) => {
      const d = new Date(ms);
      const p = (n: number) => String(n).padStart(2, '0');
      const label = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const base = byLabel.get(label);
      const partial = markPartial(label, 86_400_000, from, to);
      if (!base) {
        return { bucket: label, requests: 0, tokens: 0, credits: 0, errors: 0, models: [], partial };
      }
      return { ...base, partial };
    });
  }
  const today = daily[daily.length - 1]; // daysAgo = 0
  /* 小时桶窗口：首/末桶常只覆盖窗口的一部分，如实标出。 */
  const count = win === '24h' ? 25 : win === '1h' ? 2 : new Date(nowMs).getHours() + 1;
  const endMs = new Date(nowMs).setMinutes(0, 0, 0);
  const startMs = endMs - (count - 1) * HOUR_MS;
  const partials = Array.from({ length: count }, (_, i) => {
    const s = startMs + i * HOUR_MS;
    return markPartial(hourBucket(s), HOUR_MS, from, to);
  });
  /* today：本地零点到现在 —— 桶数 = 当前小时 + 1（与服务端 windowRange 的日历日语义一致）。 */
  return hourlyTrend(count, nowMs, today, partials);
}

/**
 * 倍率未知时的**演示用中性系数**。
 *
 * [v0.5.8] ⚠️ 生产**不再**用它算积分（积分一律取上游实扣 `usage.credit`；上游未回报即
 * `null`）。这里只剩一个用途：让 Mock 里那些 `multiplier` 为 `null` 的**演示行**仍有一个
 * 可读的数字（否则演示数据会出现一串 0，看不出"贵的模型更贵"）。
 *
 * ⛔ 它只参与算数，**绝不作为倍率上屏** —— 屏幕上那一行写的是「倍率未知」。
 */
const NEUTRAL_MULTIPLIER = 1;

/**
 * 模型明细的**请求数种子**（积分由 请求数 × 倍率 推导，不写死）。
 * Σ 必须等于趋势总请求数（现为 2092）；倍率取模型目录的 multiplier ——
 * 于是「平均单次」逐行等于倍率，且严格随倍率递减。
 *
 * 其中 `kimi-k3-1` 的倍率是 `null`（未知）⇒ 该行的**演示积分**按中性系数算出来，
 * 用量页会把它标成「倍率未知」。注意：生产里倍率未知**不影响**积分可信度
 * （积分一律取上游实扣），这里只是让演示数据保序。
 */
const MODEL_MIX: Array<{ id: string; requests: number }> = [
  { id: 'kimi-k3', requests: 617 },
  { id: 'kimi-k3-1', requests: 137 },
  { id: 'glm-5.3', requests: 520 },
  { id: 'kimi-k2.7', requests: 502 },
  { id: 'minimax-m3', requests: 104 },
  { id: 'deepseek-v4.1-flash', requests: 212 },
];

/**
 * 客户端明细的请求数种子与单次均耗（Σ 请求数同上）。
 *
 * `rate` 是该客户端每请求的积分均耗，`mixMult` 是它常用模型的倍率均值
 * （与 `makeClients()` 里各客户端的 `models` 对应）。两者**次序必须一致** ——
 * 否则会出现「只跑 deepseek 的 Cron Job 单次比跑 kimi-k3 的 Cursor 还贵」这种一眼假。
 *
 * 各 `rate` 整体收敛到窗口均值 0.90（Σrequests × rate 恰好 = Σtrend.credits），
 * 但保序：Cursor(纯 kimi-k3) > Claude > Cherry > Cron(纯 deepseek)。
 */
const CLIENT_MIX: Array<{ clientId: string; requests: number; rate: number; mixMult: number }> = [
  { clientId: 'k_9d02', requests: 248, rate: 1.24, mixMult: 1.62 }, // Cursor
  { clientId: 'k_8f21', requests: 1209, rate: 0.93, mixMult: 1.205 }, // Claude Code
  { clientId: 'k_1b83', requests: 517, rate: 0.79, mixMult: 0.78 }, // Cherry Studio
  { clientId: 'k_c3a5', requests: 118, rate: 0.36, mixMult: 0.11 }, // Cron Job
];

/**
 * 「按工具消耗」的权重与单次均耗。
 *
 * 与 `CLIENT_MIX` **故意不完全重合**：4 个客户端、5 种工具，其中
 * `WeirdClient/9.9` 认不出来（进 `tool: null` 桶）—— 那正是要展示的状态。
 * `weight` 沿用原来的整数请求数种子（Σ = 2092，与 30 天窗口一致）。
 */
const TOOL_MIX: Array<{ tool: string | null; weight: number; rate: number }> = [
  { tool: 'Claude Code', weight: 1209, rate: 0.93 },
  { tool: 'Cherry Studio', weight: 517, rate: 0.79 },
  { tool: 'Cursor', weight: 248, rate: 1.24 },
  { tool: 'Python requests', weight: 114, rate: 0.36 },
  // 认不出来的那一条：UA 不在关键词表里（不编造工具名）
  { tool: null, weight: 4, rate: 0.36 },
];

/**
 * 每请求的 prompt / completion tokens（Mock 口径）。抽成常量是因为
 * `metrics.promptTokens` 与 `byClient.tokens` / `byModel.tokens` 的分账总额
 * 必须来自**同一组数字** —— 否则「Σ各分组 tokens === metrics.totalTokens」这条自检
 * 就变成各写各的，而它正是用来抓「某个分组漏算 tokens」那类缺陷的。
 */
const TOKENS_PER_REQUEST_PROMPT = 820;
const TOKENS_PER_REQUEST_COMPLETION = 210;

/**
 * 概览数据（按窗口）。
 *
 * 30 天窗口的数值与改造前**逐字节相同**：分账在"总权重 = 原整数种子"时会精确还原原值，
 * 所以原型侧的 30 天视图不受影响，历史截图也还能对得上。
 */
export function makeOverview(win: MockWindow = 'today', nowMs: number = Date.now()): OverviewData {
  const trend = buildWindowTrend(win, nowMs);
  const requests = sum(trend, (p) => p.requests);
  const errors = sum(trend, (p) => p.errors);

  /* 客户端先算：自检把 byClient 的积分**钉死**在「请求数 × 声明的 rate」上
     （`cents(credits) === cents(req × rate)`），所以它必须是最先定下来的那一路，
     本窗口的积分总额由它给出，模型 / 工具两路再向这个总额对齐。 */
  const clientReqs = apportion(requests, CLIENT_MIX.map((m) => m.requests));
  /* [2026-10-11] 每客户端 tokens：契约 §3.4 要求 `byClient` 带 `tokens`（与 byModel 同口径）。
     Mock 此前**没给这个字段** —— 于是「提供商用量摘要」在 mock 模式下也整列显示 0，
     正好把真机上那个真实缺陷（SQL 漏了 SUM(total_tokens)）掩盖掉了。
     现在按请求数把 tokens 总额分账到各路，与 metrics.totalTokens 同一总额。 */
  const totalTokens = requests * (TOKENS_PER_REQUEST_PROMPT + TOKENS_PER_REQUEST_COMPLETION);
  const clientTokens = apportion(totalTokens, CLIENT_MIX.map((m) => m.requests));
  const byClient: BreakdownItem[] = CLIENT_MIX.map((m, i) => ({
    model: null,
    displayName: null,
    clientId: m.clientId,
    client: providerBucketName(m.clientId),
    requests: clientReqs[i],
    tokens: clientTokens[i],
    credits: cents(clientReqs[i] * m.rate) / 100,
    share: 0,
  }));
  const creditsCenti = sum(byClient, (r) => cents(r.credits ?? 0));
  /* [2026-10-17] byProvider（概览「提供商用量摘要」改用此维度）：与 byClient 同源分账，
     但按提供商桶（CLIENT_MIX 一桶=一家提供商），providerId 取各家真实 id 前缀对齐 mock。 */
  const byProvider = CLIENT_MIX.map((m, i) => ({
    providerId: 'p_mock_' + i,
    provider: providerBucketName(m.clientId),
    requests: clientReqs[i],
    tokens: clientTokens[i],
    credits: cents(clientReqs[i] * m.rate) / 100,
    lastSeenAt: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
  }));

  /* 趋势的 credits **反向**从积分总额分账而来（权重 = 各桶请求数）。
     不能让它自己写 `requests × 0.9`：那会让 Σtrend.credits 与客户端侧的合计
     差出几分（整数分账的舍入），而契约要求这两路逐分相等。 */
  const trendCredits = apportion(creditsCenti, trend.map((p) => p.requests));
  for (let i = 0; i < trend.length; i += 1) trend[i].credits = trendCredits[i] / 100;

  /* 模型：请求数分账；积分按「请求数 × 倍率」的权重分账到**同一个总额**。 */
  /* 模型：请求数分账；积分按「请求数 × 倍率」的权重分账到**同一个总额**；
     tokens 同样按请求数分账（契约要求 byModel 带 tokens，与 byClient 同口径）。 */
  const modelReqs = apportion(requests, MODEL_MIX.map((m) => m.requests));
  const modelTokens = apportion(totalTokens, MODEL_MIX.map((m) => m.requests));
  const effMult = (id: string): number => modelById(id).multiplier ?? NEUTRAL_MULTIPLIER;
  const modelCredits = apportion(
    creditsCenti,
    MODEL_MIX.map((m, i) => modelReqs[i] * effMult(m.id)),
  );
  const byModel: BreakdownItem[] = MODEL_MIX.map((m, i) => {
    const meta = modelById(m.id);
    return {
      model: m.id,
      displayName: meta.displayName,
      clientId: null,
      client: null,
      requests: modelReqs[i],
      tokens: modelTokens[i],
      credits: modelCredits[i] / 100,
      multiplier: meta.multiplier,
      // 「这行为什么便宜」的直接答案（限时免费 / 夜间折扣 / 订阅优先）——
      // 生产由 overview.service.ts 从 model_catalog.tag 带出。
      tag: meta.tag,
      share: 0,
    };
  }).sort((a, b) => b.credits - a.credits);

  /* [v1.6.29] 追加一行**上游不回报积分**的真实形态（M3.1-Flash）。
     为什么 mock 里要放它：这个状态下界面的说辞（`--` + 「未回报 ≠ 没扣费」）
     正是本次改动的核心，但此前 mock 里没有任何一行 `credits === null`，
     那条提示在 mock 走查里**根本看不到**（生产有 97 条）。
     · credits = null（与生产一致：上游 usage 无 credit 字段）
     · creditsUnknownCount > 0（让 tooltip 说得出"本窗口 N 条"）
     · 不计入 Σcredits —— 求和不变量用 `?? 0`，与生产同构
     ⚠️ 请求数与 tokens 必须**从 donor 行整体搬移**（两项同步减），
        否则 `ΣbyModel.tokens === metrics.totalTokens` 与 `Σshare === 1` 会破。
        第一次写时只搬了 requests 没搬 tokens，被下方自检当场抓出（Σshare=1.0118）。 */
  {
    const donor = byModel[0]; // 已按 credits 降序，取最大那行
    const movedReqs = Math.max(1, Math.round(donor.requests * 0.04));
    const movedTokens = Math.round((donor.tokens ?? 0) * 0.04);
    donor.requests -= movedReqs;
    donor.tokens = (donor.tokens ?? 0) - movedTokens; // 同步搬移，保总量
    byModel.push({
      model: 'MiniMax-M3.1-Flash',
      displayName: 'M3.1-Flash',
      clientId: null,
      client: null,
      requests: movedReqs,
      tokens: movedTokens,
      credits: null, // ★ 上游未回报（不是 0）
      creditsUnknownCount: movedReqs,
      multiplier: null,
      tag: '限时免费',
      share: 0,
    });
    /* 未知积分行排在最后（排序键用 ?? -1，与「无数据靠后」的语义一致）。 */
    byModel.sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1));
  }

  /* 工具：同一份请求数的**第三种切法**，请求数与积分都要与上面两路合计相等。 */
  const toolReqs = apportion(requests, TOOL_MIX.map((t) => t.weight));
  /* 「未识别」桶每个窗口都尽量 ≥ 1：它下面挂着 UA 原文块，0 次时那一块整块消失，
     而"认不出来的 UA 长什么样"正是这一栏最该被看到的东西。样本太少时挪不出来就算了。 */
  const unknownIdx = TOOL_MIX.findIndex((t) => t.tool === null);
  if (requests >= TOOL_MIX.length && toolReqs[unknownIdx] === 0) {
    const donor = toolReqs.indexOf(Math.max(...toolReqs));
    toolReqs[donor] -= 1;
    toolReqs[unknownIdx] += 1;
  }
  const toolCredits = apportion(
    creditsCenti,
    TOOL_MIX.map((t, i) => toolReqs[i] * t.rate),
  );
  /* [v0.5.18] byTool 的 tokens：按请求数分账到同一总额（契约 §3.4：byTool 也带 tokens）。 */
  const toolTokens = apportion(totalTokens, toolReqs);
  const byTool = TOOL_MIX.map((t, i) => ({
    tool: t.tool,
    requests: toolReqs[i],
    tokens: toolTokens[i],
    credits: toolCredits[i] / 100,
    share: 0,
  })).sort((a, b) => b.tokens - a.tokens);

  /* 占比 = 该行 tokens ÷ 总额（**token 口径**，与服务端一致）。
     [v0.5.18 改口径] 原为积分占比；但各表都按 tokens 排序，积分占比会与排序错位
     （百分比不单调、条形长度与顺序矛盾）。不做三位小数舍入 —— 求和才恰好为 1。 */
  for (const row of byModel) row.share = totalTokens ? (row.tokens ?? 0) / totalTokens : 0;
  for (const row of byClient) row.share = totalTokens ? (row.tokens ?? 0) / totalTokens : 0;
  for (const row of byTool) row.share = totalTokens ? (row.tokens ?? 0) / totalTokens : 0;

  /* [v0.5.21] 每个客户端的**按模型切片**（两页「按客户端」模块的悬停提示用）。
     模型清单取自 CLIENT_MODELS（与客户端页「常用模型」同一份，见其注释）；
     请求/tokens/积分按模型**均分** —— mock 只求自洽：每行切片之和恰好等于该客户端合计
     （下面的自检就守这条），不追求与真实流量分布一致。 */
  for (const row of byClient) {
    /* clientId 类型上是 string | null（模型维度的行才恒为 null）——这里必须挡空值，
       否则索引类型报错，且真出现 null 时会取到 undefined 索引。 */
    const ids: string[] = (row.clientId && CLIENT_MODELS[row.clientId]) || [];
    if (ids.length === 0) {
      row.models = [];
      row.modelCount = 0;
      continue;
    }
    const w = ids.map(() => 1);
    const reqs = apportion(row.requests, w);
    const toks = apportion(row.tokens ?? 0, w);
    const creds = apportion(cents(row.credits ?? 0), w);
    row.models = ids
      .map((id, i) => ({
        model: id,
        displayName: modelById(id).displayName,
        requests: reqs[i],
        tokens: toks[i],
        credits: creds[i] / 100,
      }))
      .sort((a, b) => b.tokens - a.tokens);
    row.modelCount = ids.length;
  }

  /* task#62：订阅积分上游取不到，改展示本地可算的 tokens 指标。
     这里给一组自洽的 mock 值：total = prompt + completion；命中率 = cached / prompt。
     ⚠️ 每请求 token 数抽成常量：上面 byClient / byModel 的 tokens 分账用的是**同一个总额**
     （`totalTokens`），三处必须同源，否则自检里的「Σtokens === metrics.totalTokens」会破。 */
  const promptTokens = requests * TOKENS_PER_REQUEST_PROMPT;
  const completionTokens = requests * TOKENS_PER_REQUEST_COMPLETION;
  const cachedTokens = Math.round(promptTokens * 0.37);

  return {
    /* 如实回**请求的那个窗口**（不再是写死的 '30d'）—— 选择器与数字从此说的是同一件事。 */
    window: win,
    generatedAt: new Date(nowMs).toISOString(),
    alerts: {
      // Mock 口径：最近 1 小时 0 次 11128 → 概览横幅不亮（与后端 CHANNEL_REJECT_ALERT_THRESHOLD=3 对齐）。
      channelReject: { count: 0, threshold: 3 },
      credentialInvalid: { count: 0, threshold: 1 },
    },
    creditLedgers: [
      {
        providerId: 'p_mmx002',
        providerName: 'MiniMax Code',
        available: true, granted: 800, remaining: 717.69, consumed: 82.31,
        nextExpireAt: new Date(Date.now() + 22 * 86400_000).toISOString(),
        stale: false, fetchedAt: new Date(Date.now() - 40 * 60_000).toISOString(), message: '',
      },
      {
        providerId: 'p_default00',
        providerName: 'WorkBuddy',
        available: true, granted: 7901, remaining: 3741.03, consumed: 4159.97,
        nextExpireAt: new Date(Date.now() + 26 * 86400_000).toISOString(),
        stale: false, fetchedAt: new Date(Date.now() - 40 * 60_000).toISOString(), message: '',
      },
      {
        providerId: 'p_qoder01',
        providerName: 'Qoder CN',
        available: true, granted: 500, remaining: 495, consumed: 5,
        nextExpireAt: null,
        lifetimeConsumed: 241.82,
        stale: false, fetchedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        message: '口径：资源包余额（495/500）；到期时刻上游不提供',
      },
    ],
    quota: {
      available: false,
      reason: 'quota_endpoint_not_configured',
      remain: null,
      total: null,
      resetAt: null,
      stale: false,
      message: '额度接口未接入。需在设置 → 积分同步 配置端点后才能显示剩余积分。',
    },
    metrics: {
      requests,
      creditsUsed: creditsCenti / 100,
      successRate: requests > 0 ? Math.round(((requests - errors) / requests) * 1000) / 1000 : 1,
      avgLatencyMs: 1840,
      activeClients: byClient.filter((r) => r.requests > 0).length,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens,
      cacheHitRate: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 10000) / 10000 : 0,
      // [v0.5.8] 上游未回报积分的条数（真实后端按 `credits IS NULL` 计数）。
      creditsUnknownCount: 0,
    },
    trend,
    byModel,
    byClient,
    byProvider,
    byTool,
    /* 认不出来的 UA 原文 —— 直接对应的证据（生产取 TOP 10，空 UA 不入列）。
       刻意给一条"看起来像正经客户端"的，演示"该往关键词表里加什么"。
       合计 = 上面 `byTool` 里 `tool: null` 那一桶的 requests。 */
    unknownUas:
      toolReqs[unknownIdx] > 0
        ? [{ ua: 'WeirdClient/9.9 (unknown-build)', requests: toolReqs[unknownIdx] }]
        : [],
    recent: Array.from({ length: 14 }, (_, i) => makeRequestRow(i)),
    provenance: {
      creditsUsed: 'local',
      quotaRemain: 'none',
      note: '已消耗积分仅统计经本服务转发的请求，取上游实扣 usage.credit；上游未回报的行积分未知，不计入合计（条数见 creditsUnknownCount）。官方客户端直连不计入。剩余积分无数据源，不做估算。',
    },
  };
}

/**
 * 排序类自检的最小样本量：每行请求数低于它时，「单次均耗」的噪声大于倍率之间的差，
 * 再检查就是掷骰子（小时窗口必然落进这一支）。**逐分相等**那几条不受此限，全窗口强制。
 */
const MIN_SAMPLE = 20;

/**
 * 自检 —— 契约硬规则：五路积分必须相等（design-spec §18.8 / api-contract §3.4）。
 *
 * 对标设计侧 `prototype/v4/demo-data.js` 的 `assertConsistent()`：**不一致就抛错，不是 warn**。
 * 价值在于：以后任何人动 `trendPoint` / `MODEL_MIX` / `CLIENT_MIX`，一加载就会当场知道，
 * 而不是让「同一份数据有四个值」悄悄漂移 —— 这正是本 Mock 之前的状态。
 */
export function assertOverviewConsistent(d: OverviewData): void {
  const bad: string[] = [];
  const eq = (label: string, a: number, b: number) => {
    if (Math.abs(a - b) > 1e-6) bad.push(`${label}：${a} ≠ ${b}`);
  };

  const totalCenti = cents(d.metrics.creditsUsed);
  eq('Σtrend.requests 与 metrics.requests', sum(d.trend, (p) => p.requests), d.metrics.requests);
  eq('Σtrend.credits 与 metrics.creditsUsed', sum(d.trend, (p) => cents(p.credits)), totalCenti);
  eq('ΣbyModel.credits 与 metrics.creditsUsed', sum(d.byModel, (r) => cents(r.credits ?? 0)), totalCenti);
  eq('ΣbyClient.credits 与 metrics.creditsUsed', sum(d.byClient, (r) => cents(r.credits ?? 0)), totalCenti);
  eq('ΣbyModel.requests 与 metrics.requests', sum(d.byModel, (r) => r.requests), d.metrics.requests);
  eq('ΣbyClient.requests 与 metrics.requests', sum(d.byClient, (r) => r.requests), d.metrics.requests);
  eq('ΣbyModel.share', sum(d.byModel, (r) => r.share), 1);
  eq('ΣbyClient.share', sum(d.byClient, (r) => r.share), 1);

  /* [2026-10-08] byTool 是同一份 requests 的**第三种切法**，所以它也要守同一条口径 ——
     少这一条，上面三路都对、唯独工具那一栏对不上，而页面上它和「按提供商消耗」
     是并排的两块，观众一眼就能看出两个总数不一致。 */
  eq('ΣbyTool.credits 与 metrics.creditsUsed', sum(d.byTool, (r) => cents(r.credits)), totalCenti);
  eq('ΣbyTool.requests 与 metrics.requests', sum(d.byTool, (r) => r.requests), d.metrics.requests);
  eq('ΣbyTool.share', sum(d.byTool, (r) => r.share), 1);

  /* [2026-10-11] tokens 也要守「各分组合计 === metrics 合计」。
     为什么补这条：真机上 `byClient` 曾**整个漏了 tokens**（SQL 少一列），
     接口回 undefined、前端整列显示 0 —— 而 Mock 当时也没给这个字段，
     于是 mock 模式看起来"和真机一样"，把这个缺陷掩盖掉了。
     tokens 与积分是同一份请求的两种切法，就该守同一条纪律。 */
  eq('ΣbyClient.tokens 与 metrics.totalTokens', sum(d.byClient, (r) => r.tokens ?? 0), d.metrics.totalTokens);
  eq('ΣbyModel.tokens 与 metrics.totalTokens', sum(d.byModel, (r) => r.tokens ?? 0), d.metrics.totalTokens);
  /* [v0.5.18] byTool 也补了 tokens（占比改为 token 口径后，它必须同源）。 */
  eq('ΣbyTool.tokens 与 metrics.totalTokens', sum(d.byTool, (r) => r.tokens ?? 0), d.metrics.totalTokens);
  /* [v0.5.21] 每个客户端的模型切片之和 = 该客户端合计（悬停提示不能比它自己还多）。 */
  for (const c of d.byClient) {
    eq(`byClient[${c.clientId}] 切片 tokens 合计`, sum(c.models ?? [], (m) => m.tokens), c.tokens ?? 0);
    eq(`byClient[${c.clientId}] 切片 requests 合计`, sum(c.models ?? [], (m) => m.requests), c.requests);
  }
  /* [v0.5.11] 趋势桶同理（趋势图主量纲已换成 token，Σ 不对图就在说谎）。
     每桶的模型切片是 **top-5 截断**（生产与 Mock 同口径）—— 截断只允许**少**
     （Σmodels ≤ 该桶 tokens，超出即是编数）；模型数 ≤ 5 时应恰好相等。 */
  eq('Σtrend.tokens 与 metrics.totalTokens', sum(d.trend, (p) => p.tokens ?? 0), d.metrics.totalTokens);
  for (const p of d.trend) {
    const ms = sum(p.models ?? [], (m) => m.tokens);
    if (ms > (p.tokens ?? 0)) bad.push(`trend[${p.bucket}].Σmodels(${ms}) 超过该桶 tokens(${p.tokens}) —— 切片在编数`);
  }

  /* ⛔ 「未识别」桶的请求数必须等于 `unknownUas` 的合计。
     这两处讲的是同一件事（认不出来的那几个），分列在「按工具消耗」条和它下面的
     UA 原文块里。不一致时的观感极差：同一屏上写着「未识别 0 次」，
     紧跟着又说「认不出来的 4 次请求」—— 用户会先怀疑数，再怀疑整个页面。
     （这条是被真实截图里的一个笔误逼出来的：null 桶当时写的是 0，
      而 unknownUas 写的是 4。肉眼扫图能发现，但不该指望每次都扫。） */
  const nullBucket = d.byTool.find((t) => t.tool === null);
  eq(
    'byTool 未识别桶的请求数 与 unknownUas 合计',
    nullBucket?.requests ?? 0,
    sum(d.unknownUas, (u) => u.requests),
  );

  /* 认不出来的 UA 原文不能是空的（空串是「没采到」，不是「某个未知工具」——
     列出来只会让人以为漏配了关键词）。 */
  for (const u of d.unknownUas) {
    if (u.ua.trim() === '') bad.push('unknownUas 里出现了空 UA —— 空 UA 是「没采到」，不入列');
  }

  /* 经济性纪律：单次消耗严格随倍率递减。
     缺了这条，为了凑总数很容易把最便宜的模型算得比最贵的还高 —— 一眼假。
     未知倍率的行按**演示中性系数**参与排序（生产里倍率未知不影响积分，
     但演示数据仍需保序，否则「贵的模型更贵」这条一眼可见的常识会被破坏）。

     ⚠️ 只在**样本足够**时检查（`MIN_SAMPLE`）。小时窗口每行只有几次请求，
     那时"单次均耗"是 1~2 次请求的平均，噪声比倍率之间的差还大 ——
     拿它当纪律就是掷骰子。小窗口仍要守的是上面那几条**逐分相等**，那些全窗口强制。

     [v1.6.29] `credits === null` 的行**不参与**这条检查：那是「上游未回报」，
     其"单次均耗"根本不存在（`(null ?? 0)/n = 0`），拿 0 去比会误报
     「M3.1-Flash 单次 0.00 未高于 GLM-5.3」——它没有可比的量，不是"更便宜"。 */
  const rated = d.byModel.filter((r) => r.credits !== null);
  if (rated.every((r) => r.requests >= MIN_SAMPLE)) {
    const rates = rated
      .map((r) => ({
        name: r.displayName ?? r.model ?? '未知',
        mult: r.multiplier ?? NEUTRAL_MULTIPLIER,
        rate: (r.credits ?? 0) / r.requests,
      }))
      .sort((a, b) => b.mult - a.mult);
    for (let i = 1; i < rates.length; i += 1) {
      const hi = rates[i - 1];
      const lo = rates[i];
      if (hi.rate <= lo.rate) {
        bad.push(
          `单次消耗未随倍率递减：${hi.name}（倍率 ${hi.mult} → 单次 ${hi.rate.toFixed(2)}）` +
            `未高于 ${lo.name}（倍率 ${lo.mult} → 单次 ${lo.rate.toFixed(2)}）`,
        );
      }
    }
  }

  /* 客户端侧同一条纪律：单次均耗的次序必须与各自常用模型的倍率次序一致，
     否则会出现「只跑 deepseek 的 Cron Job 单次比跑 kimi-k3 的 Cursor 还贵」。
     同样只在样本足够时检查 —— 理由同上。 */
  if (d.byClient.every((r) => r.requests >= MIN_SAMPLE)) {
    const clientRates = CLIENT_MIX.map(({ clientId, mixMult }) => {
      const row = d.byClient.find((r) => r.clientId === clientId);
      return { clientId, mixMult, rate: row && row.requests > 0 ? (row.credits ?? 0) / row.requests : 0 };
    }).sort((a, b) => b.mixMult - a.mixMult);
    for (let i = 1; i < clientRates.length; i += 1) {
      const hi = clientRates[i - 1];
      const lo = clientRates[i];
      if (hi.rate <= lo.rate) {
        bad.push(
          `客户端单次均耗未随模型倍率递减：${providerBucketName(hi.clientId)}（模型倍率 ${hi.mixMult} → 单次 ${hi.rate.toFixed(2)}）` +
            `未高于 ${clientName(lo.clientId)}（模型倍率 ${lo.mixMult} → 单次 ${lo.rate.toFixed(2)}）`,
        );
      }
    }
  }

  /* 声明了 rate，就必须真按 rate 折算积分。
     ⚠️ 比的是**行自身的请求数**，不是 `CLIENT_MIX` 里那个静态种子数 ——
     按窗口造数后请求数由分账得出（30 天窗口才会恰好等于种子数），
     拿种子数比会在别的窗口全部误报。这条的语义是"积分确实等于 请求数 × rate"。 */
  for (const { clientId, rate } of CLIENT_MIX) {
    const row = d.byClient.find((r) => r.clientId === clientId);
    if (!row) {
      bad.push(`byClient 缺少「${clientName(clientId)}」`);
    } else if (cents(row.credits ?? 0) !== cents(row.requests * rate)) {
      bad.push(
        `「${clientName(clientId)}」积分未按声明的单次均耗算：${row.credits} ≠ ${cents(row.requests * rate) / 100}`,
      );
    }
  }

  /* ⛔ AC-C07 / AC-C06 的根：**显示名绝不能等于稳定 id**。
     一旦某个客户端的名字被写成它的 id，按名字匹配与按 id 匹配的差别就被掩盖了 ——
     「改不改名都一样」的测试会因此恒真通过；而界面上也会冒出用户看不懂的 `k_…`。
     所以这条必须在数据层就把它顶住。 */
  for (const r of [...d.byClient, ...d.recent]) {
    if (r.clientId !== null && r.clientId === r.client) {
      bad.push(`客户端显示名等于稳定 id（「${r.client}」）—— 显示名与 id 必须分离（AC-C06 / AC-C07）`);
    }
  }

  if (bad.length > 0) {
    throw new Error(`Mock 概览数据不自洽（design-spec §18.8 硬规则）：\n  - ${bad.join('\n  - ')}`);
  }
}

/* 模块加载即自检：数据改坏了，dev:mock 一启动就抛错，不必等到页面渲染出几个对不上的数。
   **五个窗口全查** —— 分账逻辑是共用的，只查一个窗口会让另外四个的问题漏到页面上。 */
if (MOCKS_ENABLED) {
  for (const w of MOCK_WINDOWS) assertOverviewConsistent(makeOverview(w));
  assertClientRowsConsistent(makeClients());
}

/**
 * 客户端列表。
 *
 * `clientId` = **稳定标识**（rule-2 = 密钥 `key_id`；rule-4 = `'unidentified'`），
 * 只作 React key / 过滤值 / 比较键；`client` = 显示名，走 `clientName()` 查表，
 * 所以 `renameClientForTest()` 一改，这里跟着变、`clientId` 一动不动 ——
 * 这正是 AC-C06 要演的「改名不改结果」。
 */
export function makeClients(): ClientRow[] {
  const rows: Array<{ clientId: string; rule: 1 | 2 | 3 | 4; ruleLabel: string; requests: number; credits: number; models: string[]; agoMs: number; boundKeyIds: string[]; named: boolean }> = [
    { clientId: 'k_8f21', rule: 2, ruleLabel: '密钥归属', requests: 760, credits: 602.0, models: CLIENT_MODELS.k_8f21 ?? [], agoMs: 40_000, boundKeyIds: ['k_8f21'], named: true },
    { clientId: 'k_1b83', rule: 1, ruleLabel: '显式声明', requests: 324, credits: 254.4, models: CLIENT_MODELS.k_1b83 ?? [], agoMs: 90_000, boundKeyIds: ['k_1b83'], named: true },
    { clientId: 'k_9d02', rule: 3, ruleLabel: 'User-Agent', requests: 154, credits: 121.6, models: CLIENT_MODELS.k_9d02 ?? [], agoMs: 3 * 3600_000, boundKeyIds: ['k_9d02'], named: true },
    { clientId: 'k_c3a5', rule: 2, ruleLabel: '密钥归属', requests: 78, credits: 42.9, models: CLIENT_MODELS.k_c3a5 ?? [], agoMs: 300_000, boundKeyIds: ['k_c3a5'], named: true },
    { clientId: 'k_77c1', rule: 2, ruleLabel: '密钥归属', requests: 0, credits: 0, models: [], agoMs: 3 * 86_400_000, boundKeyIds: ['k_77c1'], named: true },
    { clientId: 'unidentified', rule: 4, ruleLabel: '兜底', requests: 0, credits: 0, models: [], agoMs: 2 * 86_400_000, boundKeyIds: [], named: false },
  ];
  return rows.map(({ clientId, agoMs, ...rest }): ClientRow => ({
    clientId,
    client: clientName(clientId),
    ...rest,
    lastSeenAt: new Date(Date.now() - agoMs).toISOString(),
  }));
}

/**
 * 客户端列表的显示名必须与 id 分离（AC-C06 / AC-C07）——
 * 与 `assertOverviewConsistent` 里那条同源，但覆盖 `makeClients()` 这条数据路径：
 * 两条路径都要能挡住「把 id 当名字显示」。
 */
export function assertClientRowsConsistent(rows: ClientRow[]): void {
  const bad = rows
    .filter((r) => r.clientId === r.client)
    .map((r) => `显示名等于稳定 id：「${r.client}」（AC-C06 / AC-C07）`);
  if (bad.length > 0) {
    throw new Error(`Mock 客户端数据不自洽：\n  - ${bad.join('\n  - ')}`);
  }
}

/**
 * [v0.6.0] 提供商维度用量（`/api/clients` 的 byProvider 同款）——
 * 与 `makeClients()` 同窗口、合计口径一致（Σprovider = Σclient）。
 * WorkBuddy 承接主流量；MiniMax Code 只吃 MiniMax 系模型（目录归属）。
 */
export function makeProviderUsage(): Array<{
  providerId: string | null;
  provider: string | null;
  requests: number;
  tokens: number;
  credits: number;
  lastSeenAt: string | null;
}> {
  const clients = makeClients();
  const totalReq = clients.reduce((s, c) => s + c.requests, 0);
  const totalCredits = clients.reduce((s, c) => s + c.credits, 0);
  const mmReq = 42;
  const mmCredits = 33.6;
  const lastSeen = clients.reduce<string | null>((acc, c) => {
    if (!c.lastSeenAt) return acc;
    if (!acc) return c.lastSeenAt;
    return new Date(c.lastSeenAt) > new Date(acc) ? c.lastSeenAt : acc;
  }, null);
  return [
    { providerId: 'p_default00', provider: 'WorkBuddy', requests: totalReq - mmReq, tokens: Math.round((totalReq - mmReq) * 1.4), credits: Math.round((totalCredits - mmCredits) * 100) / 100, lastSeenAt: lastSeen },
    { providerId: 'p_mmx002', provider: 'MiniMax Code', requests: mmReq, tokens: Math.round(mmReq * 2.2), credits: mmCredits, lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
  ];
}

export function makeKeys(): ClientKeyRow[] {
  const now = Date.now();
  /* [v0.4.35] 策略字段默认值 —— 大多数 mock 密钥不限，个别行自己覆盖（演示用量展示）。 */
  const defaults = { ipWhitelist: [] as string[], maxIps: null as number | null, tokenQuota: null as number | null, usedIps: 0, usedTokens: 0 };
  /* [2026-10-18 与生产对齐] `clients` 是**绑定提供商**的有序列表，值自 v1.6.26 起是
     提供商 **id**（不是名字，更不是客户端名）。此前 mock 塞的是 'Claude Code' 这类
     客户端名，于是 `dev:mock` 的「修改密钥」把它们当孤儿绑定、列表列显示的含义也错了
     —— 这些图会进 README，读者会以为绑定的是 IDE。
     `client` 仍保留「这把密钥归属哪个客户端」的快照名，两者不是一回事。 */
  const rows: ClientKeyRow[] = [
    { ...defaults, id: 'k_8f21', name: 'Claude Code · 本机', hint: 'sk-waygate-4f9c…7a2e', scope: { type: 'all' }, client: 'Claude Code', clients: ['p_default00'], enabled: true, expiresAt: null, createdAt: new Date(now - 13 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 40_000).toISOString(), requests24h: 760 },
    { ...defaults, maxIps: 3, tokenQuota: 2_000_000, usedIps: 2, usedTokens: 1_234_567, id: 'k_1b83', name: 'Cherry Studio', hint: 'sk-waygate-1b83…c40f', scope: { type: 'all' }, client: 'Cherry Studio', clients: ['p_mmx002'], enabled: true, expiresAt: null, createdAt: new Date(now - 11 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 90_000).toISOString(), requests24h: 324 },
    { ...defaults, id: 'k_9d02', name: 'Cursor · 笔记本', hint: 'sk-waygate-9d02…3ee1', scope: { type: 'family', value: 'kimi' }, client: 'Cursor', clients: ['p_qoder01', 'p_default00'], enabled: true, expiresAt: null, createdAt: new Date(now - 9 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 3 * 3600_000).toISOString(), requests24h: 154 },
    { ...defaults, id: 'k_c3a5', name: 'Cron Job · 定时任务', hint: 'sk-waygate-c3a5…91d7', scope: { type: 'family', value: 'deepseek' }, client: 'Cron Job', clients: ['p_default00'], enabled: true, expiresAt: null, createdAt: new Date(now - 8 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 300_000).toISOString(), requests24h: 78 },
    { ...defaults, ipWhitelist: ['192.168.1.0/24'], id: 'k_77c1', name: '手机端（临时）', hint: 'sk-waygate-77c1…b8f0', scope: { type: 'all' }, client: '手机端（临时）', clients: ['p_mmx002'], enabled: false, expiresAt: null, createdAt: new Date(now - 30 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 3 * 86_400_000).toISOString(), requests24h: 0 },
    { ...defaults, id: 'k_2e6b', name: '测试脚本 · 本地', hint: 'sk-waygate-2e6b…0a13', scope: { type: 'tag', value: '夜间折扣' }, client: null, clients: [], enabled: true, expiresAt: new Date(now - 2 * 86_400_000).toISOString(), createdAt: new Date(now - 40 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 12 * 86_400_000).toISOString(), requests24h: 0 },
    { ...defaults, id: 'k_5d7f', name: '家人共享 · 只读', hint: 'sk-waygate-5d7f…22c8', scope: { type: 'models', value: ['glm-5.3', 'kimi-k2.7'] }, client: null, clients: [], enabled: false, expiresAt: null, createdAt: new Date(now - 20 * 86_400_000).toISOString(), lastSeenAt: new Date(now - 5 * 86_400_000).toISOString(), requests24h: 0 },
  ];
  return rows;
}

/** 7 组 25 项，逐项照抄 design/api-contract.md §3.8 */
export function makeSettings(): SettingsData {
  return {
    version: 3,
    groups: [
      {
        id: 'service',
        label: '服务',
        items: [
          // [task#37] listenHost 的 why 取**长版**（含 RELAY_ALLOW_PUBLIC_BIND 降级说明）——与契约 §3.8 / 后端 group-service.ts 一致。
          { key: 'service.listenHost', label: '监听地址', value: '127.0.0.1', type: 'text', why: '默认只对本机开放。改为 0.0.0.0 后局域网设备也能用（需环境变量 RELAY_ALLOW_PUBLIC_BIND=1；缺失时启动会降级回环并告警），但请自行确认网络可信。', readonly: false, requiresRestart: true },
          { key: 'service.listenPort', label: '端口', value: 8787, type: 'number', why: '控制台与 API 共用，建议不要改成 8080 等常见端口。', readonly: false, requiresRestart: true },
          // [task#37] readonly/why 逐字对齐后端 settings.catalog/group-*.ts（mock 模拟的就是它返回的形状）。
          { key: 'service.autostart', label: '开机自启', value: true, type: 'switch', why: '由部署时的 systemd 单元管理（systemctl enable relay）。控制台不设开关，避免与实际服务管理状态不一致。', readonly: true, requiresRestart: false },
          { key: 'service.forceStreamRewrite', label: '超长请求兜底', value: true, type: 'switch', why: '上游只接受流式请求。本服务恒开此兜底：收到非流式调用时自动改写为流式再拼接返回，不可关闭。', readonly: true, requiresRestart: false },
        ],
      },
      {
        /* [v0.6.5] 与后端 group-credential.ts 逐字同构：组名「提供商策略」，
           身份键（source/status）仍在但前端滤除；baseUrl 改只读说明位；新增可写 userAgent。 */
        id: 'credential',
        label: '提供商策略',
        items: [
          { key: 'credential.source', label: '活动提供商', value: 'ck_x••••3f7a', type: 'text', why: '当前生效提供商的凭证摘要（各家形态不同：WorkBuddy = 官方 OAuth 授权的账号前缀、MiniMax Code = 登录态 refresh token、Qoder CN = 身份 JSON）。逐家查看 / 重新导入请到「提供商管理 → 重新导入授权」。', readonly: true, requiresRestart: false },
          { key: 'credential.status', label: '凭证状态', value: '有效', type: 'badge', why: '活动提供商的凭证是否已导入（「有效」= 已通过官方授权导入）。只读运行态，只反映「导了没有」，不解析到期时间 —— 各家续期方式不同：MiniMax 自动刷新 refresh token、WorkBuddy / Qoder 需重新导入授权。', readonly: true, requiresRestart: false },
          { key: 'upstream.baseUrl', label: '提供商地址', value: '（按家维护于「提供商管理 → 提供商」）', type: 'text', why: '【只读】多提供商后，出站转发、目录拉取、额度探测都读各自提供商的 base_url；本项曾是可改的全局地址，现仅作说明位。改地址请到「提供商管理 → 配置」。', readonly: true, requiresRestart: false },
          { key: 'upstream.userAgent', label: 'WorkBuddy UA 基准值', value: 'WorkBuddy/5.8.0', type: 'text', why: '【仅对 WorkBuddy（openai 协议）生效】出站 User-Agent 的基准值，会展开成官方桌面端三段式（WorkBuddy/<ver> WorkBuddy/<ver> CLI/<cli>）。官方客户端升版后改这里即可跟上，无需改代码发版。MiniMax Code 固定发 MiniMaxCode、Qoder CN 固定发 qodercli/<ver>，均不受本项影响。留空时：伪装档（spoofUA=开，默认）回落到内置默认版本并覆盖入站 UA；透明转发档（spoofUA=关）才沿用入站 UA。', readonly: false, requiresRestart: false },
          { key: 'upstream.spoofUA', label: '请求头伪装（WorkBuddy）', value: true, type: 'switch', why: '【仅对 WorkBuddy（openai 协议）生效】开启时把出站请求伪装成官方 WorkBuddy 桌面端：UA 展开为三段式，并注入用量归因头族（X-Product / X-IDE-* / X-Agent-Purpose / X-Agent-Intent 等），个人中心「使用端」才归因到 WorkBuddy。MiniMax Code 走标准 Anthropic SDK 头、Qoder CN 走 COSY 签名头，本开关对它们无效果。', readonly: false, requiresRestart: false },
          { key: 'upstream.promptRewrite', label: 'system 提示改写', value: 'template', type: 'select', options: [{ value: 'template', label: '模板行改写（默认·推荐）' }, { value: 'neutral', label: '中性提示全量替换（激进）' }, { value: 'off', label: '关闭' }], why: '转发前对 system 正文做改写，三家提供商都会应用。改写要解决的主要是 WorkBuddy 的 11128 渠道校验（按 system 模板指纹拦截 Claude Code 系客户端）；MiniMax Code / Qoder CN 无此校验。「模板行改写」语义等价地改标签行（模型读法不变、指纹失效），被拒时自动降级重试一次；「中性替换」整段换掉（会改变模型行为，应急用）；「关闭」即不改写。改后立即生效。', readonly: false, requiresRestart: false },
        ],
      },
      {
        id: 'quota',
        label: '积分同步',
        items: [
          { key: 'quota.pollSeconds', label: '同步间隔', value: 30, type: 'number', why: '【仅对 WorkBuddy（openai 协议）生效】额度接口的轮询间隔。[v1.3.0] 已打通：POST /v2/billing/meter/get-user-resource 返回资源包列表并聚合出剩余/总量（旧版 GET 实测 404 的根因是方法错）。MiniMax Code 的积分走独立账本（每 5 分钟固定拉取，不走本项）；Qoder CN 的积分走 v2/me/usage（资源包余额，每轮活动检查时拉取）。', readonly: false, requiresRestart: false },
          { key: 'quota.backoffMaxSeconds', label: '失败退避', value: 300, type: 'number', why: '【仅对 WorkBuddy 生效】网络 / 临时失败时按指数退避，最长该值（秒）一次，避免拖垮上游。接口确定不存在（404）时退到每天一次。', readonly: false, requiresRestart: false },
          { key: 'quota.onFailure', label: '同步失败时', value: 'keep_and_mark', type: 'select', options: [{ value: 'keep_and_mark', label: '保留旧值 + 标记' }, { value: 'clear', label: '清空' }], why: '额度同步失败时的策略（保留旧值更稳，清空更诚实，二选一）。MiniMax Code 的账本失败时固定「保留旧值 + 标记数据偏旧」，不由此项控制。', readonly: false, requiresRestart: false },
          { key: 'quota.warnBelow', label: '额度告警', value: 500, type: 'number', why: '剩余积分低于该阈值时会在额度数据里标记 low。[v1.3.0] WorkBuddy 额度接口已打通，本项恢复真实行为；MiniMax Code 的余额展示由其账本卡片独立处理，不受本项影响。', readonly: false, requiresRestart: false },
        ],
      },
      {
        id: 'signin',
        label: '每日签到',
        items: [
          { key: 'signin.workBuddyEnabled', label: 'WorkBuddy 签到状态同步', value: true, type: 'switch', why: '每日 08:05 后自动为 WorkBuddy（openai 协议）提供商签到领积分（100/天 + 连签加成），凭证用已导入的授权，对客户端无影响。关闭只停自动，提供商管理页的手动签到按钮不受影响。MiniMax Code 的签到恒开（其凭证链要求由 relay 代签，客户端不再登录）。', readonly: false, requiresRestart: false },
        ],
      },
      {
        id: 'limits',
        label: '限流与重试',
        items: [
          { key: 'limits.concurrency', label: '并发上限', value: 4, type: 'number', why: '同时向上游发出的请求数。超过则本机直接回 429，不排队（客户端需自行退避重试）。', readonly: false, requiresRestart: false },
          { key: 'limits.retryOn429', label: '429 自动重试', value: 3, type: 'number', why: '429 自动重试尚未实现。此值当前不产生任何行为，设为只读以免误以为改了就生效。', readonly: true, noop: true, requiresRestart: false },
          { key: 'limits.retryCreditToOwner', label: '重试积分归属', value: true, type: 'switch', why: '依赖自动重试，而自动重试尚未实现。此值当前不产生任何行为，设为只读。', readonly: true, noop: true, requiresRestart: false },
          { key: 'limits.firstByteTimeoutMs', label: '首字超时（毫秒）', value: 30000, type: 'number', why: '从发出请求到上游送出首个数据帧的上限。已开始的流不受总时长限制，仅受「连续 5 分钟无数据」的挂死保护。', readonly: false, requiresRestart: false },
        ],
      },
      {
        id: 'logs',
        label: '日志',
        items: [
          { key: 'logs.retainDays', label: '保留天数', value: 30, type: 'number', why: '超期日志每日自动清理一次。它决定「积分与用量」页明细表能回溯多久。', readonly: false, requiresRestart: false },
          { key: 'logs.recordRequestBody', label: '记录请求体', value: false, type: 'switch', why: '关闭后只记模型、tokens 与状态。开启会把对话内容写进本地库（默认关闭，超长请求体会被截断到 128 KiB）。绝不记录任何密钥 —— Authorization 只在请求头，不入库。', readonly: false, requiresRestart: false },
          { key: 'logs.recordResponseBody', label: '记录响应体', value: false, type: 'switch', why: '同上，记录上游返回内容。默认关闭，排查上游异常时才临时打开（超长响应体会被截断）。', readonly: false, requiresRestart: false },
          { key: 'logs.dir', label: '日志文件', value: '~/.relay/logs/', type: 'text', why: '日志由 systemd / journald 收集（journalctl -u relay）。控制台不单独维护日志目录，故只读。', readonly: true, requiresRestart: false },
        ],
      },
      {
        id: 'danger',
        label: '危险操作',
        items: [
          { key: 'danger.clearLogs', label: '清空全部日志', type: 'action', tone: 'warn', value: null, why: '删除后「积分与用量」的按模型 / 客户端明细将一并归零，剩余积分不受影响。' },
          { key: 'danger.resetKeys', label: '重置全部密钥', type: 'action', tone: 'warn', value: null, why: '所有 sk-waygate- 密钥立即失效，已填进客户端的密钥需要逐个替换。' },
          { key: 'danger.restoreDefaults', label: '恢复默认配置', type: 'action', tone: 'warn', value: null, why: '设置回到初始值，上游地址与并发上限需要重新确认。' },
        ],
      },
      {
        id: 'mapping',
        label: '配置文件对应',
        items: [
          {
            key: 'config.mapping',
            label: 'config.yml 键位映射',
            type: 'mapping',
            value: {
              'service.listenHost': 'listen.host',
              'service.listenPort': 'listen.port',
              'service.autostart': 'autostart',
              'credential.source': 'credential.source',
              'upstream.baseUrl': 'upstream.baseUrl',
              'upstream.spoofUA': 'upstream.spoofUA',
              'upstream.promptRewrite': 'upstream.promptRewrite',
              'quota.pollSeconds': 'quota.poll',
              'quota.backoffMaxSeconds': 'quota.backoffMax',
              'quota.warnBelow': 'quota.warnBelow',
              'limits.concurrency': 'limits.concurrency',
              'limits.retryOn429': 'limits.retryOn429',
              'limits.firstByteTimeoutMs': 'limits.firstByteTimeout',
              'logs.retainDays': 'logs.retainDays',
              'logs.recordRequestBody': 'logs.body',
            },
            why: '自用工具的设置页最终会被「直接改配置文件」取代。先把映射关系摆出来，能省掉一整轮「这个开关对应哪个 key」的沟通。',
            readonly: true,
          },
        ],
      },
    ],
  };
}

/** 「已命名」客户端的显示名清单 —— 用 **id** 把未识别那条剔掉（名字是标签，不是键）。 */
export const CLIENT_NAMES = CLIENTS.filter((c) => c.id !== 'unidentified').map((c) => c.name);
export const MODEL_FAMILIES = ['kimi', 'deepseek', 'glm', 'minimax', 'hy'];
// @zbiti-ai:f:752:9d5c3adc
