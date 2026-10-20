/**
 * 模型实测探针：发一条 1 token 的流式请求，只看上游是否接受（task#18 从 models.service 抽出）。
 *
 * 「是否可用」是一次**真实上游调用**的结论，会消耗极少量积分；故：
 *   - 不做任何自动重试，失败就是失败
 *   - 读完第一条数据/拿到状态即返回，不读完整流
 *
 * 抽出的原因：models.service 同时承担「目录视图 / 刷新编排 / 试通凭证」三件事，
 * 已越过单文件 300 行门禁；把探针独立成可单测的小单元。
 */

import { Injectable } from '@nestjs/common';
import { RelayConfigService } from '../config/config.service';
import { buildChatCompletionsUrl, resolveUpstreamBase } from '../proxy/upstream-url';

export interface ProbeOutcome {
  id: string;
  ok: boolean;
  /**
   * 上游业务码（11102 等）。
   * 仅为 null 表示「拿到了响应、但里面没有可提取的业务码」（如上游 401/500 的 body 无数字码）。
   * ⚠️ 不要用它判断「有没有连上上游」——网络失败时它也是 null。那是 `httpStatus` 的职责。
   */
  upstreamCode: number | null;
  /**
   * 本次请求拿到的 HTTP 状态码。
   *   - `null` ⇔ **根本没拿到 HTTP 响应**（fetch 抛异常 / 超时 / 中断）——**只有这一种情况为 null**
   *   - 数字 ⇔ 上游**确实回了响应**，值即状态码（2xx 时也填，通常 200；4xx/5xx 时填 401/500…）
   *
   * 为什么必须有它：`upstreamCode === null` 在生产里有**两个来源** —— 真网络失败，与
   * 「上游回了非 2xx 但 body 无可提取业务码」。两者用 `upstreamCode` 无法区分，前端因此会把
   * 「上游 401 真的拒签了这把 key」误诊成「网络连不上，去查出网」（task#30 修的正是这个误诊）。
   */
  httpStatus: number | null;
  reason: string | null;
}

/** 每个模型的最小实测请求超时。 */
export const PROBE_TIMEOUT_MS = 15_000;
/** 串行实测的间隔（契约要求 200ms，避免触发上游限流）。 */
export const PROBE_INTERVAL_MS = 200;

@Injectable()
export class ModelProbeService {
  constructor(private readonly config: RelayConfigService) {}

  /**
   * 单个模型的最小实测：发一条 1 token 的流式请求，只看上游是否接受。
   *
   * @param overrideKey 用哪把凭证打这次请求。默认取当前生效的凭证；
   *   传入别的值时用于「试通一个还没保存的 key」。
   * @param overrideBase 打到哪个基地址。默认取当前生效的上游（与真实转发同一处
   *   URL 解析，task#37）；传入别的值时用于「试通一个**尚未激活**的提供商」——
   *   [2026-10-08] 自定义提供商的「先验后切」需要它：不切过去就能测那家的连通性。
   *   传了 overrideBase 而没传 overrideKey 时凭证仍取当前生效值（调用方负责组合）。
   * @param overrideUrl [v1.7.0] 完整端点 URL（custom 提供商用——它的路径由
   *   buildCustomChatUrl 智能解析，不是 WorkBuddy 的 /v2 布局）。优先于 overrideBase。
   */
  async probe(modelId: string, overrideKey?: string, overrideBase?: string, overrideUrl?: string): Promise<ProbeOutcome> {
    // 与真实转发共用同一处 URL 解析（task#37），避免「试通」与「转发」用不同的上游地址。
    const url = overrideUrl ?? buildChatCompletionsUrl(overrideBase ?? resolveUpstreamBase(this.config));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${overrideKey ?? this.config.upstreamKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: modelId,
          stream: true,
          max_tokens: 1,
          messages: [{ role: 'system', content: 'ping' }, { role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      if (res.ok) {
        void res.body?.cancel().catch(() => undefined);
        return { id: modelId, ok: true, upstreamCode: null, httpStatus: res.status, reason: null };
      }

      const text = await res.text().catch(() => '');
      const code = extractUpstreamCode(text);
      return {
        id: modelId,
        ok: false,
        upstreamCode: code,
        httpStatus: res.status,
        reason: code === null ? `HTTP ${res.status}` : `上游业务码 ${code}`,
      };
    } catch (err) {
      return {
        id: modelId,
        ok: false,
        upstreamCode: null,
        httpStatus: null,
        reason: err instanceof Error ? err.message : '未知网络错误',
      };
    }
  }

  /** 串行实测多个模型，固定间隔。返回逐项结论。
   *  [v0.5.1] key/base 覆写透传（多提供商：按各家的凭证与地址实测）。 */
  async probeAll(ids: string[], intervalMs: number = PROBE_INTERVAL_MS, key?: string, base?: string): Promise<ProbeOutcome[]> {
    const outcomes: ProbeOutcome[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (i > 0) await sleep(intervalMs);
      outcomes.push(await this.probe(ids[i]!, key, base));
    }
    return outcomes;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从上游错误体里抽出 5 位业务码，抽不到返回 null。 */
export function extractUpstreamCode(text: string): number | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown }; code?: unknown };
    const raw = parsed.error?.code ?? parsed.code;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && /^\d{5}$/.test(raw)) return Number.parseInt(raw, 10);
  } catch {
    /* 非 JSON，试正则 */
  }
  const m = /\b(111\d{2})\b/.exec(text);
  return m ? Number.parseInt(m[1]!, 10) : null;
}
