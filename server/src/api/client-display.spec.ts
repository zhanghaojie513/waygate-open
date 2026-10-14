/**
 * client_id 契约 —— **显示名的回落与传播**。
 *
 * 一句话纪律（spec-v4-client-id §4）：
 *   「名字只用来显示」的完整含义是 —— **凡是展示名字的地方，都必须走同一个解析函数**。
 *   只要有一处直接渲染快照列，改一次名就会出现"列表里是新名、日志行里是旧名"。
 *
 * 覆盖：
 *   AC-C09 显示名回落链四段可测：绑定名 / 密钥名 / 密钥已删 / 未识别
 *   AC-C10 ★ 改名后，客户端列表 / 客户端排行 / 请求日志行 / 请求详情 / 最近请求 全部显示新名；全站搜不到旧名
 *   AC-C11 自由文本 q 用**新名**必须能搜到改名前的旧行
 *
 * 这两条都是「改之前会挂」的定向测试（先证伪再修）：见 team-lead 复核记录。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './client-harness';
import { resolveClientName } from './client-name';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.db.close();
});

const clientOf = (id: string) => h.clients.list(h.spec).items.find((i) => i.clientId === id);

describe('AC-C09 · 显示名回落链', () => {
  it('四段都能解析，且任何分支都不返回空串', () => {
    const unidentified = { clientId: 'unidentified', boundName: null, keyName: null, keyExists: false, keyHint: null };
    const bound = { clientId: 'k', boundName: 'Claude Code', keyName: '密钥甲', keyExists: true, keyHint: 'h' };
    const byKeyName = { clientId: 'k', boundName: '   ', keyName: '密钥甲', keyExists: true, keyHint: 'h' };
    const deleted = { clientId: 'k', boundName: null, keyName: null, keyExists: false, keyHint: 'sk-waygate-dead…beef' };

    expect(resolveClientName(unidentified)).toBe('未识别');
    expect(resolveClientName(bound)).toBe('Claude Code');
    expect(resolveClientName(byKeyName)).toBe('密钥甲');
    expect(resolveClientName(deleted)).toBe('已删除的密钥 · sk-waygate-dead…beef');

    // ⛔ 末端不许静默返回空串 —— 空串在界面上看起来像「没有客户端」
    for (const parts of [unidentified, bound, byKeyName, deleted]) {
      expect(resolveClientName(parts).length).toBeGreaterThan(0);
    }
    // 极端兜底：密钥已删且连 hint 都没有，也必须是可读的非空串
    expect(
      resolveClientName({ clientId: 'k_gone', boundName: null, keyName: null, keyExists: false, keyHint: null }),
    ).toBe('已删除的密钥 · k_gone');
  });

  it('密钥被删后：显示名回落为「已删除的密钥 · 掩码」，数字与 clientId 不变', () => {
    h.makeKey('k_del', '即将删除', 'sk-waygate-dead…beef');
    h.log({ clientId: 'k_del', client: '即将删除', clientRule: 2, keyId: 'k_del', keyHint: 'sk-waygate-dead…beef', credits: 3 });

    const before = clientOf('k_del');
    expect(before?.client).toBe('即将删除');

    h.keysRepo.remove('k_del');

    const after = clientOf('k_del');
    expect(after?.clientId).toBe('k_del');
    expect(after?.client).toBe('已删除的密钥 · sk-waygate-dead…beef');
    expect(after?.requests).toBe(before?.requests);
    expect(after?.credits).toBe(before?.credits);
  });
});

describe('AC-C10 · 改名后凡展示名字处都显示新名（全站搜不到旧名）', () => {
  it('客户端列表 / 概览 byClient / 请求日志行 / 请求详情 / 最近请求 全部显示新名', () => {
    h.makeKey('k_a', 'Claude Code', 'sk-waygate-aaaa…0001');
    h.log({ clientId: 'k_a', client: 'Claude Code', clientRule: 2, keyId: 'k_a', keyHint: 'sk-waygate-aaaa…0001', credits: 2 });

    const oldName = 'Claude Code';
    const newName = 'Renamed Client'; // 刻意与旧名无子串重叠，才能断言「全站搜不到旧名」
    h.keysRepo.patch('k_a', { client: newName });

    const li = h.clients.list(h.spec).items.find((i) => i.clientId === 'k_a')!;
    const ov = h.overview.build(h.spec);
    const ovClient = ov.byClient.find((c) => c.clientId === 'k_a')!;
    const rows = h.requestSvc.list({ page: 1, limit: 50, clientId: 'k_a' }).items;
    const detail = h.requestSvc.detail(rows[0]!.id);

    // 客户端列表
    expect(li.client).toBe(newName);
    // 客户端排行（概览 byClient）
    expect(ovClient.client).toBe(newName);
    // 请求日志行：必须显示当前名，不是写入时的快照名
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.client).toBe(newName);
      expect(r.client).not.toBe(oldName);
    }
    // 请求详情同样走同一解析函数
    expect(detail.client).toBe(newName);
    // 最近请求（概览 recent）：带 clientId，且显示当前名
    expect(ov.recent[0]?.clientId).toBe('k_a');
    expect(ov.recent[0]?.client).toBe(newName);
    // 全站搜不到旧名
    expect(JSON.stringify({ li, ovClient, rows, detail, recent: ov.recent })).not.toContain(oldName);
  });
});

describe('AC-C11 · 自由文本 q 用新名能搜到改名前的旧行', () => {
  it('改名后按新名搜索，命中数 = 改名前的命中数（且不为 0）', () => {
    h.makeKey('k_a', 'Claude Code', 'sk-waygate-aaaa…0001');
    for (let i = 0; i < 3; i++) {
      h.log({ clientId: 'k_a', client: 'Claude Code', clientRule: 2, keyId: 'k_a', keyHint: 'sk-waygate-aaaa…0001' });
    }
    h.log({ clientId: 'unidentified', client: '未识别', clientRule: 4 }); // 干扰行，不该被搜到

    const hitsByOld = h.requestSvc.list({ page: 1, limit: 50, q: 'Claude Code' }).total;
    expect(hitsByOld).toBe(3);

    h.keysRepo.patch('k_a', { client: 'Renamed Client' });

    // 改名前的旧行，用**新名**也必须能搜到（快照名匹配 + 该客户端当前名匹配，两条路任一命中）
    const hitsByNew = h.requestSvc.list({ page: 1, limit: 50, q: 'Renamed Client' }).total;
    expect(hitsByNew).toBe(hitsByOld);
    expect(hitsByNew).toBe(3);
  });
});
