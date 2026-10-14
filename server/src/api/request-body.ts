/**
 * 请求/响应体文本 → 结构化片段的解析（纯函数，无 DB / 无副作用）。
 *
 * 从 `RequestQueryService` 抽出：读取逻辑（列表/详情）与「把库里的 body 文本解析成片段」
 * 是两件事，混在一起会让 service 逼近 300 行上限，也让解析逻辑难以单独测。
 *
 * 两条纪律（沿用原实现，勿放宽）：
 *   - 解析失败**返回空值**（[]/null），绝不抛 —— 一条脏日志不该让整页读接口 500。
 *   - 响应体可能是聚合 JSON，也可能是一串 SSE 帧；两种都尽力解析，失败就 null（不猜内容）。
 */

/** 从记录的请求体里抽出 messages（解析失败返回空数组，不抛）。 */
export function parseMessages(body: string | null): Array<{ role: string; content: string }> {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) return [];
    return parsed.messages
      .filter((m): m is { role: unknown; content: unknown } => !!m && typeof m === 'object')
      .map((m) => ({
        role: typeof m.role === 'string' ? m.role : 'unknown',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      }));
  } catch {
    return [];
  }
}

/** 从记录的响应体里抽助手回复预览（聚合 JSON 或 SSE 帧皆可；失败返回 null）。 */
export function parseAssistantPreview(body: string | null): string | null {
  if (!body) return null;

  const fromJson = (text: string): string | null => {
    try {
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = parsed.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : null;
    } catch {
      return null;
    }
  };

  const direct = fromJson(body);
  if (direct !== null) return direct;

  // SSE：逐帧取 delta.content 拼起来
  let acc = '';
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      const piece = chunk.choices?.[0]?.delta?.content;
      if (typeof piece === 'string') acc += piece;
    } catch {
      /* 单帧坏了跳过，不影响其余帧 */
    }
  }
  return acc.length > 0 ? acc : null;
}
