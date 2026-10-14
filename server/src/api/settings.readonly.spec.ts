/**
 * 设置「只读 / 可写」边界单测（task#37 B）。
 *
 * 证明三处**同源**：`buildSettingGroups` 的 `readonly` 标记、`EDITABLE_KEYS`
 * （PUT 的闸）、`validateSetting`（第二道闸）对一个 key 的判断一致；并证明本轮
 * 接线的可写项**没有**被误锁。
 */

import { describe, expect, it } from 'vitest';
import { buildSettingGroups } from './settings.catalog';
import { defaultSettings, EDITABLE_KEYS, REQUIRES_RESTART_KEYS } from '../config/settings.defaults';
import { validateSetting } from '../config/settings.validate';

const runtime = { credentialSource: 'ck_x••••3f7a', credentialStatus: '有效' };
const groups = buildSettingGroups(defaultSettings(), runtime);
const item = (key: string) => {
  for (const g of groups) for (const it of g.items) if (it.key === key) return it;
  return undefined;
};

/** 本轮（task#37）改为只读的 5 个 key，以及各自的「未实现 / 由外部管理」理由关键词。 */
const NEWLY_READONLY: Array<[string, RegExp]> = [
  ['service.autostart', /systemd/],
  ['service.forceStreamRewrite', /恒开|不可关闭/],
  ['limits.retryOn429', /尚未实现/],
  ['limits.retryCreditToOwner', /尚未实现/],
  ['logs.dir', /journald|systemd/],
  /* [v0.6.5] 多提供商后：出站/目录/额度都读 provider.base_url，全局位改它无效，
     故移出可写、加进只读（理由关键词「按家维护 / 提供商」）。 */
  ['upstream.baseUrl', /按家维护|提供商/],
];

describe('只读项三处同源', () => {
  it('① 5 个新只读项：catalog 标 readonly 且 why 如实说明原因', () => {
    for (const [key, whyRe] of NEWLY_READONLY) {
      const it0 = item(key);
      expect(it0, `catalog 缺少 ${key}`).toBeDefined();
      expect(it0!.readonly, `${key} 应为 readonly`).toBe(true);
      expect(it0!.why).toMatch(whyRe);
    }
  });

  it('② 这 5 个 key 不在 EDITABLE_KEYS（PUT 第一道闸会拒）', () => {
    for (const [key] of NEWLY_READONLY) {
      expect(EDITABLE_KEYS.has(key), `${key} 不应可写`).toBe(false);
    }
  });

  it('③ 这 5 个 key 被 validateSetting 拒（第二道闸，防绕过 EDITABLE_KEYS）', () => {
    const samples: Record<string, unknown> = {
      'service.autostart': true,
      'service.forceStreamRewrite': true,
      'limits.retryOn429': 3,
      'limits.retryCreditToOwner': true,
      'logs.dir': '/tmp/logs',
    };
    for (const [key] of NEWLY_READONLY) {
      const check = validateSetting(key, samples[key]);
      expect(check.ok, `${key} 应被拒`).toBe(false);
      expect(check.message).toContain('只读');
    }
  });
});

describe('接线项仍可写（未被误锁）', () => {
  const WIRED: Array<[string, unknown]> = [
    ['service.listenHost', '127.0.0.1'],
    ['service.listenPort', 9000],
    /* [v0.6.5] upstream.baseUrl 移出可写（改 provider.base_url 才有效）；
       upstream.userAgent 取而代之成为可写项（WorkBuddy UA 基准值）。 */
    ['upstream.userAgent', 'WorkBuddy/5.8.0'],
    ['upstream.spoofUA', true],
    ['limits.concurrency', 8],
    ['limits.firstByteTimeoutMs', 30000],
    ['logs.retainDays', 60],
    ['logs.recordRequestBody', true],
    ['logs.recordResponseBody', true],
    ['signin.workBuddyEnabled', false], // [v1.3.0] WorkBuddy 自动签到开关（实时读）
  ];

  it('④ 接线项：均在 EDITABLE_KEYS、校验通过、catalog 未标只读', () => {
    for (const [key, value] of WIRED) {
      expect(EDITABLE_KEYS.has(key), `${key} 应可写`).toBe(true);
      expect(validateSetting(key, value).ok, `${key} 应校验通过`).toBe(true);
      expect(item(key)!.readonly ?? false, `${key} 不应 readonly`).toBe(false);
    }
  });

  it('⑤ REQUIRES_RESTART_KEYS 只含仍需重启的可写项', () => {
    // task#58：upstream.baseUrl 已移出 —— 它由 proxy.service 逐请求实时读，改后立即生效、无需重启。
    // 剩下两个监听项确实只在 main.ts 的 resolveListen（app.listen 之前）读一次，仍需重启。
    expect([...REQUIRES_RESTART_KEYS].sort()).toEqual(['service.listenHost', 'service.listenPort'].sort());
  });

  it('⑥ catalog 的 requiresRestart 与 REQUIRES_RESTART_KEYS 同源（防再次漂移）', () => {
    // 可写项的「改后是否需重启」必须与写入口径（REQUIRES_RESTART_KEYS）一致：
    // 标 requiresRestart:true 但不在集合里 ⇒ 控制台提示重启但其实不用；
    // 标 false 但在集合里 ⇒ 该提示重启却没提示。两者都是 task#58 修的同类漂移。
    for (const g of groups) {
      for (const it of g.items) {
        if (it.readonly) continue; // 只读项不参与「改后是否需重启」语义
        expect(it.requiresRestart ?? false, it.key).toBe(REQUIRES_RESTART_KEYS.has(it.key));
      }
    }
  });
});
