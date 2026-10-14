import { describe, expect, it } from 'vitest';
import { buildUpstreamUrl, interpretUpstreamFailure, parseUpstreamFailure } from './pipeline';

/**
 * 上游失败的解析纪律（这是本项目第一轮探针就踩过的坑）：
 *   401 = 鉴权失败
 *   400 + 5 位业务码 = **已过鉴权**，是参数问题
 * 如果只数 HTTP 200，会把"鉴权已通过、只是参数不对"误判成"凭证路径不成立"。
 */

describe('parseUpstreamFailure', () => {
  it('① JSON 体里的 5 位业务码被识别（11101 / 11102 / 11128 / 11133）', () => {
    for (const code of [11101, 11102, 11128, 11133]) {
      const f = parseUpstreamFailure(400, JSON.stringify({ code, message: 'x' }));
      expect(f.businessCode).toBe(code);
      expect(f.httpStatus).toBe(400);
    }
  });

  it('② 业务码藏在 error.code / error.message 里也能识别', () => {
    expect(parseUpstreamFailure(400, JSON.stringify({ error: { code: 11128 } })).businessCode).toBe(11128);
    expect(
      parseUpstreamFailure(400, JSON.stringify({ error: { message: 'model [x] service info not found 11102' } }))
        .businessCode,
    ).toBe(11102);
  });

  it('③ 纯文本 404 体（实测存在）不崩，能从文本抠出业务码', () => {
    const f = parseUpstreamFailure(404, '404 page not found');
    expect(f.businessCode).toBeNull();
    expect(f.rawBody).toBe('404 page not found');

    const g = parseUpstreamFailure(400, 'error: 11128 system message required');
    expect(g.businessCode).toBe(11128);
  });

  it('④ 空体 / 非 JSON / 二进制垃圾都不抛异常', () => {
    expect(parseUpstreamFailure(500, '').businessCode).toBeNull();
    expect(parseUpstreamFailure(500, '<<<>>>').businessCode).toBeNull();
    expect(parseUpstreamFailure(500, '{ broken').businessCode).toBeNull();
  });

  it('⑤ 不带业务码的 JSON 返回 null，不误抓无关数字', () => {
    const f = parseUpstreamFailure(500, JSON.stringify({ retry_after: 30, status: 500 }));
    expect(f.businessCode).toBeNull();
  });
});

describe('interpretUpstreamFailure —— 错误码映射与排障方向', () => {
  it('⑥ ★ 上游 401 映射成 502 + upstream_credential_invalid，绝不原样 401', () => {
    const err = interpretUpstreamFailure(parseUpstreamFailure(401, '{"message":"unauthorized"}'));
    expect(err.httpStatus).toBe(502);
    expect(err.code).toBe('upstream_credential_invalid');
    // 错误信息必须把排障方向指向"上游访问密钥"，落点正确（客户端与密钥 → 上游连接），
    // 而不是指向"你的本机接入密钥"
    expect(err.message).toContain('上游访问密钥');
    expect(err.message).toContain('客户端与密钥 → 上游连接');
  });

  it('⑦ 11102 -> 400 + model_not_available（该账号未开通，不是全局不存在）', () => {
    const err = interpretUpstreamFailure(
      parseUpstreamFailure(400, JSON.stringify({ code: 11102 })),
    );
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe('model_not_available');
    expect(err.upstreamCode).toBe(11102);
  });

  it('⑧ 11101 / 11128 -> 502 upstream_*，说明上游协议或瞬时故障', () => {
    const e1 = interpretUpstreamFailure(parseUpstreamFailure(400, JSON.stringify({ code: 11101 })));
    expect(e1.httpStatus).toBe(502);
    expect(e1.code).toBe('upstream_11101');

    const e2 = interpretUpstreamFailure(parseUpstreamFailure(400, JSON.stringify({ code: 11128 })));
    expect(e2.httpStatus).toBe(502);
    expect(e2.code).toBe('upstream_11128');
  });

  it('⑨ 11133 -> 400 invalid_max_tokens', () => {
    const err = interpretUpstreamFailure(parseUpstreamFailure(400, JSON.stringify({ code: 11133 })));
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe('invalid_max_tokens');
  });

  it('⑩ 上游 429 -> 429 rate_limited（限流要如实传，客户端才懂退避）', () => {
    const err = interpretUpstreamFailure(parseUpstreamFailure(429, 'slow down'));
    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe('rate_limited');
  });

  it('⑪ 未知业务码不吞掉，带码返回便于排障', () => {
    const err = interpretUpstreamFailure(parseUpstreamFailure(400, JSON.stringify({ code: 11999 })));
    expect(err.code).toBe('upstream_11999');
    expect(err.httpStatus).toBe(502);
  });

  it('⑫ 上游 5xx -> 502 upstream_error', () => {
    const err = interpretUpstreamFailure(parseUpstreamFailure(503, 'maintenance'));
    expect(err.httpStatus).toBe(502);
    expect(err.code).toBe('upstream_error');
  });
});

describe('buildUpstreamUrl', () => {
  it('⑬ 尾部斜杠不会造成双斜杠', () => {
    expect(buildUpstreamUrl('https://copilot.tencent.com')).toBe('https://copilot.tencent.com/v2/chat/completions');
    expect(buildUpstreamUrl('https://copilot.tencent.com/')).toBe(
      'https://copilot.tencent.com/v2/chat/completions',
    );
    expect(buildUpstreamUrl('https://copilot.tencent.com///')).toBe(
      'https://copilot.tencent.com/v2/chat/completions',
    );
  });
});
