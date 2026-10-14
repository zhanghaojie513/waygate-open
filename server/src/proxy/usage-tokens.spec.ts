import { describe, expect, it } from 'vitest';
import { extractCachedTokens, extractReasoningTokens, extractUpstreamCredit, NO_CACHED_TOKENS } from './usage-tokens';

/**
 * ★★ task#62 的**防陷阱回归测试** ★★
 *
 * 这段逻辑的价值全在「顶层 cached_tokens 是假的」这一个反直觉事实上。
 * 如果哪天有人把实现改成读顶层字段，命中率会**永远为 0 却不报错** ——
 * 那是最危险的沉默逻辑错误。这些断言就是拦它的网。
 */
describe('extractCachedTokens · 缓存命中采集（防陷阱）', () => {
  it('★★ 顶层 cached_tokens=0 是假的：真值取嵌套 prompt_tokens_details.cached_tokens=7 → 返回 7 不是 0', () => {
    // 实测形状：同一次调用里顶层恒 0，真值在嵌套里。
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cached_tokens: 0, // ← 假的，绝不能用
      prompt_tokens_details: { cached_tokens: 7 }, // ← 真值
    };
    expect(extractCachedTokens(usage)).toBe(7);
  });

  it('顶层有值、嵌套也有值时，**以嵌套为准**（顶层永远不可信）', () => {
    const usage = {
      cached_tokens: 999, // 假
      prompt_tokens_details: { cached_tokens: 3 }, // 真
    };
    expect(extractCachedTokens(usage)).toBe(3);
  });

  it('只有顶层 cached_tokens（无嵌套）→ 忽略它，回落/归零（返回 0）', () => {
    // 关键：不能因为顶层写了个非 0 数就信它。
    expect(extractCachedTokens({ cached_tokens: 42 })).toBe(0);
  });

  it('回落：无 prompt_tokens_details 时取 DeepSeek 系 prompt_cache_hit_tokens', () => {
    expect(extractCachedTokens({ prompt_cache_hit_tokens: 11 })).toBe(11);
  });

  it('优先级：prompt_tokens_details.cached_tokens 存在时，不再看 prompt_cache_hit_tokens', () => {
    const usage = {
      prompt_tokens_details: { cached_tokens: 5 },
      prompt_cache_hit_tokens: 88,
    };
    expect(extractCachedTokens(usage)).toBe(5);
  });

  it('嵌套 cached_tokens 为 null/字符串/负数 → 视为无此数据，回落下一档', () => {
    expect(extractCachedTokens({ prompt_tokens_details: { cached_tokens: null }, prompt_cache_hit_tokens: 4 })).toBe(4);
    expect(extractCachedTokens({ prompt_tokens_details: { cached_tokens: '7' }, prompt_cache_hit_tokens: 4 })).toBe(4);
    expect(extractCachedTokens({ prompt_tokens_details: { cached_tokens: -1 }, prompt_cache_hit_tokens: 4 })).toBe(4);
  });

  it('真实 0（嵌套给了 0）→ 返回 0（这是真值，不是「无数据」）', () => {
    expect(extractCachedTokens({ prompt_tokens_details: { cached_tokens: 0 } })).toBe(0);
  });

  it('无 usage / 非对象 / 空对象 → 0（不抛、不估算）', () => {
    expect(extractCachedTokens(undefined)).toBe(0);
    expect(extractCachedTokens(null)).toBe(0);
    expect(extractCachedTokens('nope')).toBe(0);
    expect(extractCachedTokens({})).toBe(0);
    expect(extractCachedTokens({})).toBe(NO_CACHED_TOKENS);
  });

  it('小数 token 数向下取整（token 是整数）', () => {
    expect(extractCachedTokens({ prompt_tokens_details: { cached_tokens: 7.9 } })).toBe(7);
  });
});

/**
 * [2026-10-07 v0.2.0] 思考 tokens 提取：completion_tokens **包含** reasoning（上游计费口径），
 * 拆开展示才能解释「这条为什么这么贵/这么慢」。校准探针实测两个真值位置。
 */
describe('extractReasoningTokens · 思考 tokens 采集', () => {
  it('★ 标准位：completion_tokens_details.reasoning_tokens（校准探针实测形状）', () => {
    expect(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 9 } }, 11)).toBe(9);
  });

  it('回落位：顶层 completion_thinking_tokens（该网关的等价字段）', () => {
    expect(extractReasoningTokens({ completion_thinking_tokens: 16 }, 16)).toBe(16);
  });

  it('标准位优先于顶层回落', () => {
    expect(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 5 }, completion_thinking_tokens: 99 }, 10)).toBe(5);
  });

  it('钳制：不许越过 completion_tokens（防御脏数据）', () => {
    expect(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 999 } }, 130)).toBe(130);
  });

  it('两处都没有 → 0（不估算）；非法值同样归 0/回落', () => {
    expect(extractReasoningTokens({}, 10)).toBe(0);
    expect(extractReasoningTokens(undefined, 10)).toBe(0);
    expect(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: '9' }, completion_thinking_tokens: 3 }, 10)).toBe(3);
    expect(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: -1 } }, 10)).toBe(0);
  });
});

/** [2026-10-07] 上游实扣 credit 提取（积分数值的唯一权威来源）。 */
describe('extractUpstreamCredit · 上游实扣', () => {
  it('合法数字 → 原样（2 位舍入）', () => {
    expect(extractUpstreamCredit({ credit: 0.08 })).toBe(0.08);
    expect(extractUpstreamCredit({ credit: 0 })).toBe(0); // 免费模型合法
    expect(extractUpstreamCredit({ credit: 0.005 })).toBe(0.01);
  });

  it('缺失/非法 → null（走兜底公式）', () => {
    expect(extractUpstreamCredit({})).toBeNull();
    expect(extractUpstreamCredit(undefined)).toBeNull();
    expect(extractUpstreamCredit({ credit: '0.08' })).toBeNull();
    expect(extractUpstreamCredit({ credit: -1 })).toBeNull();
    expect(extractUpstreamCredit({ credit: Number.NaN })).toBeNull();
  });
});
