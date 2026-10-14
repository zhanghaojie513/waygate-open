/** 请求/响应体截断口径单测（task#37 A3 的纯函数部分）。 */

import { describe, expect, it } from 'vitest';
import { BODY_CAP_CHARS, TRUNCATION_MARK, capBody } from './body-capture';

describe('capBody', () => {
  it('① null / undefined → null（不写空串）', () => {
    expect(capBody(null)).toBeNull();
    expect(capBody(undefined)).toBeNull();
  });

  it('② 未超限 → 原样返回', () => {
    expect(capBody('hello')).toBe('hello');
    expect(capBody('中文内容')).toBe('中文内容');
  });

  it('③ 恰好等于上限 → 不截断', () => {
    const s = 'a'.repeat(BODY_CAP_CHARS);
    expect(capBody(s)).toBe(s);
    expect(capBody(s)!.endsWith(TRUNCATION_MARK)).toBe(false);
  });

  it('④ 超限 → 截到上限 + 尾标记', () => {
    const s = 'a'.repeat(BODY_CAP_CHARS + 10);
    const out = capBody(s)!;
    expect(out.length).toBe(BODY_CAP_CHARS + TRUNCATION_MARK.length);
    expect(out.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(out.startsWith('a'.repeat(100))).toBe(true);
  });

  it('⑤ 空串 → 空串（不是 null）', () => {
    expect(capBody('')).toBe('');
  });
});
