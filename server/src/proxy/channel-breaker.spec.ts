/**
 * [v1.6.27] 11128 渠道熔断纯逻辑单测。时钟注入，不睡真时间。
 *
 * 钉死的行为（与 channel-breaker.ts 头注的状态机一一对应）：
 *   ① 阈值前不开闸（blocked === null）；
 *   ② 连续第 3 次渠道级拒绝开闸，blocked 返回剩余毫秒；
 *   ③ 开闸期内 recordChannelRejection 继续升退避档（×2 封顶 300s）；
 *   ④ 冷却到期 → 半开放行（blocked === null）；
 *   ⑤ recordHealthy 全复位（成功 / 非 11128 业务失败都走它）；
 *   ⑥ 提供商之间状态独立。
 */
import { describe, expect, it } from 'vitest';
import {
  ChannelBreaker,
  BREAKER_THRESHOLD,
  BREAKER_BASE_COOLDOWN_MS,
  BREAKER_MAX_COOLDOWN_MS,
} from './channel-breaker';

function makeBreaker() {
  let t = 1_000_000;
  const breaker = new ChannelBreaker(() => t);
  const tick = (ms: number) => (t += ms);
  return { breaker, tick };
}

describe('ChannelBreaker 11128 渠道熔断', () => {
  it('① 阈值前不开闸', () => {
    const { breaker } = makeBreaker();
    for (let i = 1; i < BREAKER_THRESHOLD; i += 1) {
      const tr = breaker.recordChannelRejection('p_wb');
      expect(tr.opened).toBe(false);
      expect(breaker.blocked('p_wb')).toBeNull();
    }
  });

  it('② 第 3 次连续拒绝开闸，blocked 返回剩余毫秒', () => {
    const { breaker } = makeBreaker();
    breaker.recordChannelRejection('p_wb');
    breaker.recordChannelRejection('p_wb');
    const tr = breaker.recordChannelRejection('p_wb');
    expect(tr.opened).toBe(true);
    expect(tr.opens).toBe(1);
    expect(tr.cooldownMs).toBe(BREAKER_BASE_COOLDOWN_MS);
    expect(breaker.blocked('p_wb')).toBe(BREAKER_BASE_COOLDOWN_MS);
  });

  it('③ 阵发期内再拒绝 → 退避升档（×2），封顶 BREAKER_MAX_COOLDOWN_MS', () => {
    const { breaker, tick } = makeBreaker();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) breaker.recordChannelRejection('p_wb'); // 开闸 30s

    tick(BREAKER_BASE_COOLDOWN_MS); // 冷却到期 → 半开
    expect(breaker.blocked('p_wb')).toBeNull();
    const tr2 = breaker.recordChannelRejection('p_wb'); // 探测仍 11128 → 再开闸
    expect(tr2.opened).toBe(true);
    expect(tr2.opens).toBe(2);
    expect(tr2.cooldownMs).toBe(BREAKER_BASE_COOLDOWN_MS * 2);

    tick(BREAKER_BASE_COOLDOWN_MS * 2); // 到期 → 半开 → 探测又败
    const tr3 = breaker.recordChannelRejection('p_wb');
    expect(tr3.cooldownMs).toBe(BREAKER_BASE_COOLDOWN_MS * 4);

    // 连续失败足够多次后封顶
    let last = tr3;
    for (let i = 0; i < 10; i += 1) {
      tick(last.cooldownMs);
      last = breaker.recordChannelRejection('p_wb');
      expect(last.cooldownMs).toBeLessThanOrEqual(BREAKER_MAX_COOLDOWN_MS);
    }
    expect(last.cooldownMs).toBe(BREAKER_MAX_COOLDOWN_MS);
  });

  it('④ 冷却到期 → 半开放行；探测成功 → 全复位', () => {
    const { breaker, tick } = makeBreaker();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) breaker.recordChannelRejection('p_wb');
    tick(BREAKER_BASE_COOLDOWN_MS + 1);
    expect(breaker.blocked('p_wb')).toBeNull();

    breaker.recordHealthy('p_wb'); // 探测请求成功
    expect(breaker.snapshot('p_wb')).toBeNull();
    // 复位后要重新累计满阈值才会再开闸（不是从旧计数继续）
    for (let i = 1; i < BREAKER_THRESHOLD; i += 1) {
      expect(breaker.recordChannelRejection('p_wb').opened).toBe(false);
    }
  });

  it('⑤ 成功信号清零连续计数：两次拒绝夹一次健康 → 永不开闸', () => {
    const { breaker } = makeBreaker();
    breaker.recordChannelRejection('p_wb');
    breaker.recordChannelRejection('p_wb');
    breaker.recordHealthy('p_wb'); // 中间的成功（如 MiniMax 流量打进来）
    const tr = breaker.recordChannelRejection('p_wb');
    expect(tr.opened).toBe(false);
    expect(breaker.blocked('p_wb')).toBeNull();
  });

  it('⑥ 提供商之间状态独立（WorkBuddy 开闸不拦 MiniMax）', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) breaker.recordChannelRejection('p_wb');
    expect(breaker.blocked('p_wb')).not.toBeNull();
    expect(breaker.blocked('p_mm')).toBeNull();
  });
});
