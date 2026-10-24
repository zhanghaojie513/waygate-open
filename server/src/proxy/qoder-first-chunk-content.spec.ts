/**
 * v1.7.4 两处行为修正的**纯函数**部分：
 *   ① `firstChunkHasNoContent` —— Qoder 探首块时判「有字节但无内容」
 *   ② promptRewrite 的协议门（在 proxy.service 内联，这里测它所依赖的语义）
 *
 * 这两个判定都直接影响**是否重发上游请求**，所以边界必须钉死：
 * 误判「无内容」= 白花一次上游额度 + 用户多等；漏判 = 用户白等到超时。
 */
import { describe, expect, it } from 'vitest';
import { firstChunkHasNoContent, hasDataFrame } from './proxy.service';

describe('hasDataFrame · 帧判定', () => {
  it('正常 data 帧 → true', () => {
    expect(hasDataFrame('data: {"body":"{}"}\n\n')).toBe(true);
  });

  it('只有 [DONE] 不算有内容（上游没产出任何东西）', () => {
    expect(hasDataFrame('data: [DONE]\n\n')).toBe(false);
  });

  it('空 data 载荷 / 空串 → false', () => {
    expect(hasDataFrame('data:\n\n')).toBe(false);
    expect(hasDataFrame('data:   \n\n')).toBe(false);
    expect(hasDataFrame('')).toBe(false);
  });

  it('非 SSE 文本（HTML 错误页 / 纯 JSON）→ false', () => {
    expect(hasDataFrame('<html><body>503</body></html>')).toBe(false);
    expect(hasDataFrame('{"error":"upstream"}')).toBe(false);
  });

  it('多帧混合：只要有一帧有载荷就算有', () => {
    expect(hasDataFrame('data: [DONE]\n\ndata: {"x":1}\n\n')).toBe(true);
  });

  it('CRLF 行尾也认', () => {
    expect(hasDataFrame('data: {"x":1}\r\n\r\n')).toBe(true);
  });
});

describe('firstChunkHasNoContent · 「确定无内容」的保守判定', () => {
  it('★ 完整帧在 → false（有内容，不重试）', () => {
    expect(firstChunkHasNoContent('data: {"body":"hi"}\n\n')).toBe(false);
  });

  it('★ 帧被分块切断（以 data: 开头未完成）→ false（不能判无内容）', () => {
    /* 这是重点：首块只有半帧是**正常分片**，判成无内容会导致误重试。 */
    expect(firstChunkHasNoContent('data: {"bod')).toBe(false);
    expect(firstChunkHasNoContent('data: {"body":"一长串…')).toBe(false);
  });

  it('★ 空响应体 / 纯空白 → true（确定无内容，该重试）', () => {
    expect(firstChunkHasNoContent('')).toBe(true);
    expect(firstChunkHasNoContent('   \n  \n')).toBe(true);
  });

  it('★ 只有 [DONE] → true（上游零产出，与旧的零字节同义）', () => {
    expect(firstChunkHasNoContent('data: [DONE]\n\n')).toBe(true);
  });

  it('★ 非 SSE 的响应体（错误信封/HTML）→ true', () => {
    expect(firstChunkHasNoContent('{"code":"provider_error","message":"x"}')).toBe(true);
    expect(firstChunkHasNoContent('upstream error')).toBe(true);
  });

  it('★ 完整帧之后跟了个半帧 → false（有内容）', () => {
    expect(firstChunkHasNoContent('data: {"a":1}\n\ndata: {"b')).toBe(false);
  });

  it('判定方向是保守的：拿不准就当有内容', () => {
    /* 一个刚开的 SSE 流常常只有 `\n` 或 `: ping` 心跳 —— 这些不是 data 帧，
       若首块只有它们，说明上游还没开始产出 → 判 true 是合理的（会重试）。 */
    expect(firstChunkHasNoContent(': ping\n\n')).toBe(true);
  });
});
