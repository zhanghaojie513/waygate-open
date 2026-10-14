import { useEffect, useState } from 'react';
import { useSession } from '../hooks/useSession';
import { api } from '../services/api';

/**
 * 官网数据接入（login-aware）—— 契约见 spec-v4-landing-integration §5。
 *
 *   · 服务「运行中 / 离线」 ← GET /healthz（公开，裸 JSON），失败即离线态，不阻塞页面
 *   · 本窗口总 tokens / 缓存命中率 / 今日请求 / 成功率 ← /api/overview（需会话）
 *       —— **已登录**访客拉真实值；**未登录**显示示例值并标注。
 *   · 绝不把真实用量暴露给未登录访客。
 *
 * [注意] 这里**不再有**「订阅剩余积分 / 距积分重置」。上游没有额度查询接口
 * （额度端点实测 404，见 probe/03-upstream-verified.md），`quota.available` 恒为 false，
 * 那个数**根本取不到**（task#57/#62）。官网此前仍在徽标与状态条上承诺它 ——
 * 那等于对未登录访客展示一个从来没被验证过的数字（task#67 已改为可对账的真指标）。
 *
 * 为什么用 useSession 判定登录态：/api/auth/session 未登录时返回
 * `authenticated:false`（不返 401），是唯一一个「匿名也可调」的 /api 端点。
 * 未登录时本 hook **只**发 /healthz + /api/auth/session，不发任何需鉴权的 /api/*（AC-04）。
 */

export interface LandingNumbers {
  /**
   * 本窗口总 tokens（输入 + 输出，纯本地日志可算，永远有值）。
   * null = 已登录但取数失败（渲染「—」，绝不编造）。
   */
  totalTokens: number | null;
  /**
   * 缓存命中率 = cachedTokens / promptTokens。
   *
   * [注意] 这里存的是**百分比数值（0..100）**，不是 API 的 0..1 比率 —— 官网状态条是
   * `<span>{numProps(v,1)}</span><span class="unit">%</span>` 的结构，`numProps` 需要
   * 一个「已经乘过 100」的数才能滚出 62.4 而不是 0.6。换算在 hook 里做一次，组件不再换算。
   *
   * [注意] **为 0 就是 0**（DeepSeek 系上游真实返回 `cached_tokens: 0`），渲染成 `0.0%`，
   * 不回退到任何「未提供」文案（口径同 lib/format.ts 的 formatCacheHitRate）。
   */
  cacheHitRate: number | null;
  requestsToday: number | null;
  /**
   * 今日成功率，同样是**百分比数值（0..100）**。
   *
   * [task#67 顺带修正] /api/overview 的 `successRate` 是 0..1 的比率（后端
   * `overview.service.ts` 与 mock 都是 `(requests-errors)/requests`）。此前这里直接
   * 把比率塞给状态条、再拼一个 `%` —— 于是「99.7% 的成功率」在真实登录态下被渲染成
   * `1.0%`。这是「算了但悄悄算错」那类错误，一并修掉。
   */
  successRate: number | null;
}

export interface LandingStatus {
  /** 服务在线（/healthz 成功） */
  online: boolean;
  /** /healthz 回报的版本号；离线时为设计稿默认值 */
  version: string;
  /** 数字是否为真实值（已登录且取数成功）。false ⇒ 需标注「示例」 */
  real: boolean;
  numbers: LandingNumbers;
}

const DESIGN_VERSION = __APP_VERSION__;

/**
 * 未登录/取数失败时的示例值。
 *
 * 「今日请求数 1,284 / 今日成功率 99.7」沿用设计稿 index.html 的兜底数字；
 * [task#67] 前两项从设计稿的「剩余积分 3842 / 2h 18m」换成控制台**真有的**指标。
 * 示例 token 数与「今日请求数 1,284」自洽（≈1.5K tokens/请求），缓存命中率取一个
 * 有零头的常见值 —— 不写整数，免得看起来像被"凑"出来的。
 */
const EXAMPLE: LandingNumbers = {
  totalTokens: 1_930_000,
  cacheHitRate: 62.4,
  requestsToday: 1284,
  successRate: 99.7,
};

/** 千分位，与 page.js 的 group() 同算法 —— 全站同一数字只有一个格式化出处 */
export function formatGroup(n: number, dec = 0): string {
  const parts = n.toFixed(dec).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

/**
 * 百分比数值（0..100）→ `'62.4%'`；null → `'—'`（绝不编造）。
 * 非状态条（不参与数字滚动）的位置用它，与 `numProps + .unit` 的两个分支拼出同一串文本。
 */
export function formatPercentValue(v: number | null, dec = 1): string {
  return v == null ? '—' : `${v.toFixed(dec)}%`;
}

function readHealth(json: unknown): { ok: boolean; version?: string } {
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    return { ok: o.ok !== false, version: typeof o.version === 'string' ? o.version : undefined };
  }
  return { ok: true };
}

export function useLandingStatus(): LandingStatus {
  const session = useSession();
  const [online, setOnline] = useState(true);
  const [version, setVersion] = useState(DESIGN_VERSION);
  const [numbers, setNumbers] = useState<LandingNumbers>(EXAMPLE);
  const [real, setReal] = useState(false);

  /* ① 服务在线性：公开端点，匿名可持续探测；失败即离线态，页面其余部分照常可读。 */
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const res = await fetch('/healthz', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`healthz ${res.status}`);
        const h = readHealth(await res.json());
        if (!alive) return;
        setOnline(h.ok);
        if (h.version) setVersion(h.version);
      } catch {
        if (alive) setOnline(false);
      }
    };
    void probe();
    const id = window.setInterval(() => void probe(), 30000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  /* ② 数字：仅已登录访客拉真实值；其余情况停在示例值并保持 real=false。 */
  useEffect(() => {
    if (session.status !== 'authed') {
      setReal(false);
      setNumbers(EXAMPLE);
      return;
    }
    let alive = true;
    api
      .overview('24h')
      .then((d) => {
        if (!alive) return;
        /* 比率 → 百分比在这里换算一次（理由见 LandingNumbers 的注释）。 */
        setNumbers({
          totalTokens: d.metrics.totalTokens,
          cacheHitRate: d.metrics.cacheHitRate * 100,
          requestsToday: d.metrics.requests,
          successRate: d.metrics.successRate * 100,
        });
        setReal(true);
      })
      .catch(() => {
        if (!alive) return;
        /* 已登录但取数失败：退回示例值并标注 —— 不阻塞页面，也不编造。 */
        setReal(false);
        setNumbers(EXAMPLE);
      });
    return () => {
      alive = false;
    };
  }, [session.status]);

  return { online, version, real, numbers };
}
// @zbiti-ai:f:165:4be1d8be
