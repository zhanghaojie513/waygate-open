import { describe, expect, it } from 'vitest';
import { buildUpstreamHeaders, extractBearer, NEVER_FORWARD } from './headers';

/**
 * 这组测试守的是本项目最重要的一条安全红线：
 * **本机 sk-waygate- 密钥绝不能离开本机。**
 */

const LOCAL_KEY = 'sk-waygate-4f9c2a7e1b83d04f391c7a2e';
const UPSTREAM_KEY = 'ck_g01kgplrvsao.fake-for-test';

describe('buildUpstreamHeaders —— 凭证隔离', () => {
  it('① 入站 Authorization 被替换成上游凭证，出站头里不含 sk-waygate-', () => {
    const { headers } = buildUpstreamHeaders(
      { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
      UPSTREAM_KEY,
      true,
      'fake-ua',
    );

    expect(headers['authorization']).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(headers['authorization']).not.toContain('sk-waygate-');
    // 全量扫描：任何一个头都不能带本机密钥
    expect(JSON.stringify(headers)).not.toContain(LOCAL_KEY);
  });

  it('② allowlist 之外的头一律不出站（cookie / x-api-key / 自定义头）', () => {
    const { headers } = buildUpstreamHeaders(
      {
        authorization: `Bearer ${LOCAL_KEY}`,
        cookie: 'session=abc',
        'x-api-key': LOCAL_KEY,
        'x-forwarded-for': '1.2.3.4',
        'x-custom-secret': 'leak-me',
      },
      UPSTREAM_KEY,
      false,
      'fake-ua',
    );

    expect(headers['cookie']).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['x-custom-secret']).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('leak-me');
  });

  it('③ 敏感头清单里的每一个都不出现在出站头中（除 authorization 已被替换）', () => {
    const incoming: Record<string, string> = { 'content-type': 'application/json' };
    for (const h of NEVER_FORWARD) incoming[h] = 'SHOULD_NOT_LEAK';

    const { headers, leaked } = buildUpstreamHeaders(incoming, UPSTREAM_KEY, true, 'fake-ua');

    expect(leaked).toEqual([]);
    for (const h of NEVER_FORWARD) {
      if (h === 'authorization') {
        expect(headers[h]).toBe(`Bearer ${UPSTREAM_KEY}`);
      } else {
        expect(headers[h]).toBeUndefined();
      }
    }
    expect(JSON.stringify(headers)).not.toContain('SHOULD_NOT_LEAK');
  });

  it('④ spoofUA=true 时覆盖 UA；false 时保留入站 UA', () => {
    const on = buildUpstreamHeaders({ 'user-agent': 'client-ua/1.0' }, UPSTREAM_KEY, true, 'spoofed/9.9');
    expect(on.headers['user-agent']).toBe('spoofed/9.9');

    const off = buildUpstreamHeaders({ 'user-agent': 'client-ua/1.0' }, UPSTREAM_KEY, false, 'spoofed/9.9');
    expect(off.headers['user-agent']).toBe('client-ua/1.0');

    const missing = buildUpstreamHeaders({}, UPSTREAM_KEY, false, 'spoofed/9.9');
    expect(missing.headers['user-agent']).toBe('WorkBuddy/5.8.0');
  });

  it('④b spoofUA=true 时注入官方桌面端指纹：UA 展开三段式 + 用量归因头族（「使用端」归因的关键）', () => {
    const { headers } = buildUpstreamHeaders(
      { 'user-agent': 'client-ua/1.0', 'accept-language': 'en-US' },
      UPSTREAM_KEY,
      true,
      'WorkBuddy/5.8.0',
    );

    // UA 三段式（官方 RestOperations 形状）
    expect(headers['user-agent']).toBe('WorkBuddy/5.8.0 WorkBuddy/5.8.0 CLI/2.137.1');
    // 用量归因头族：缺这些头时上游归因 client/agentPurpose 为空，使用端显示网关特征
    expect(headers['x-agent-purpose']).toBe('conversation');
    expect(headers['x-ide-name']).toBe('WorkBuddy');
    expect(headers['x-ide-type']).toBe('WorkBuddy');
    expect(headers['x-ide-version']).toBe('5.8.0');
    // [v0.6.3] 官方 X-Product = deploymentType（实测 SaaS）
    expect(headers['x-product']).toBe('SaaS');
    expect(headers['x-agent-intent']).toBe('craft');
    expect(headers['x-private-data']).toBe('true');
    // 官方客户端公共头
    expect(headers['x-codebuddy-request']).toBe('1');
    expect(headers['origin']).toBe('https://www.codebuddy.cn');
    expect(headers['referer']).toBe('https://www.codebuddy.cn/');
    expect(headers['x-requested-with']).toBe('XMLHttpRequest');
    // 入站已有的 accept-language 透传优先，不覆盖
    expect(headers['accept-language']).toBe('en-US');
  });

  it('④c spoofUA=false（透明转发）不注入指纹头族；已含 CLI 段或自定义 UA 原样透传', () => {
    const off = buildUpstreamHeaders({ 'user-agent': 'client-ua/1.0' }, UPSTREAM_KEY, false, 'WorkBuddy/5.8.0');
    expect(off.headers['x-product']).toBeUndefined();
    expect(off.headers['x-ide-name']).toBeUndefined();

    const full = buildUpstreamHeaders({}, UPSTREAM_KEY, true, 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.63.2');
    expect(full.headers['user-agent']).toBe('WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.63.2');
    expect(full.headers['x-ide-version']).toBe('5.5.4');
  });

  it('⑤ content-type 强制为 application/json（客户端乱传也不影响上游）', () => {
    const { headers } = buildUpstreamHeaders(
      { 'content-type': 'text/plain' },
      UPSTREAM_KEY,
      false,
      'ua',
    );
    expect(headers['content-type']).toBe('application/json');
  });

  it('⑥ 入站头值是数组时安全拼接，不产生 [object Object]', () => {
    const { headers } = buildUpstreamHeaders(
      { accept: ['application/json', 'text/event-stream'], 'content-type': 'application/json' },
      UPSTREAM_KEY,
      false,
      'ua',
    );
    expect(headers['accept']).toBe('application/json, text/event-stream');
  });
});

describe('extractBearer', () => {
  it('大小写不敏感，容忍多余空格', () => {
    expect(extractBearer(`bearer  ${LOCAL_KEY} `)).toBe(LOCAL_KEY);
    expect(extractBearer(`Bearer ${LOCAL_KEY}`)).toBe(LOCAL_KEY);
  });

  it('非 Bearer / 空值返回 null', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer(['Bearer k1', 'Bearer k2'])).toBe('k1');
  });
});
