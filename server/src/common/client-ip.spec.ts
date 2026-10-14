import { describe, expect, it } from 'vitest';
import { clientIpOf, socketPeerOf } from './client-ip';

/**
 * 客户端 IP 提取的正确性。
 *
 * 为什么值得专门测：这是**审计日志与限流分桶的唯一依据**。
 * 取错了的后果很隐蔽 —— 服务照常工作，但
 *   - 日志里所有来源都是 127.0.0.1（无法追责）
 *   - 限流把所有用户算成一个桶（一个攻击者能锁死所有人）
 *   - 取到伪造的头 → 审计记假 IP、限流被逐个假 IP 绕过
 * 这些都不会让任何请求失败，所以必须有测试盯着。
 *
 * ★ 语义：取 XFF 的**最后一段**（紧邻代理写入的可信值），不是首段。
 *   原因见 client-ip.ts 文件头。
 */
describe('client-ip · 客户端地址提取', () => {
  it('① 单段 XFF 直接采用', () => {
    expect(clientIpOf({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe(
      '203.0.113.7',
    );
  });

  it('② ★ 多段 XFF 取最后一段（首段可被客户端伪造）', () => {
    // 这是真实攻击形态：客户端伪造 1.2.3.4，Nginx 追加真实 IP 120.243.96.59。
    // 取首段会得到伪造值；取末段才是可信的。
    expect(
      clientIpOf({
        ip: '127.0.0.1',
        headers: { 'x-forwarded-for': '1.2.3.4, 120.243.96.59' },
      }),
    ).toBe('120.243.96.59');
  });

  it('③ 多级代理链取末段（= 紧邻本服务的代理看到的对端）', () => {
    expect(
      clientIpOf({
        ip: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 172.16.0.9' },
      }),
    ).toBe('172.16.0.9');
  });

  it('④ 各段两端的空白被去掉', () => {
    expect(
      clientIpOf({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4 ,  198.51.100.2  ' } }),
    ).toBe('198.51.100.2');
  });

  it('⑤ 末尾有空段时跳过（容忍 "a, b, " 写法）', () => {
    expect(
      clientIpOf({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.2, ' } }),
    ).toBe('198.51.100.2');
  });

  it('⑥ 无 XFF 时回落到 req.ip', () => {
    expect(clientIpOf({ ip: '192.0.2.5', headers: {} })).toBe('192.0.2.5');
  });

  it('⑦ XFF 为空串 / 纯空白时回落到 req.ip（不返回空串）', () => {
    expect(clientIpOf({ ip: '192.0.2.5', headers: { 'x-forwarded-for': '' } })).toBe('192.0.2.5');
    expect(clientIpOf({ ip: '192.0.2.5', headers: { 'x-forwarded-for': '   ' } })).toBe('192.0.2.5');
  });

  it('⑧ XFF 全是逗号/空白时回落到 req.ip', () => {
    expect(clientIpOf({ ip: '192.0.2.5', headers: { 'x-forwarded-for': ' , , ' } })).toBe(
      '192.0.2.5',
    );
  });

  it('⑨ 两者都没有时返回 "unknown"，调用方无需再判 null', () => {
    expect(clientIpOf({ headers: {} })).toBe('unknown');
  });

  it('⑩ 头值是数组时也能处理（Fastify 对重复头的形态）', () => {
    expect(
      clientIpOf({ ip: '127.0.0.1', headers: { 'x-forwarded-for': ['1.2.3.4, 198.51.100.2'] } }),
    ).toBe('198.51.100.2');
  });

  it('⑪ socketPeerOf 忽略 XFF，只回 req.ip（用于比对是否有人伪造头）', () => {
    const req = { ip: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } };
    expect(socketPeerOf(req)).toBe('127.0.0.1');
    // 同一请求两个函数结果不同，这正是设计意图
    expect(clientIpOf(req)).toBe('1.2.3.4');
  });

  it('⑫ IPv6 形式也原样传递（不做规范化，避免改写语义）', () => {
    expect(clientIpOf({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '2001:db8::1' } })).toBe(
      '2001:db8::1',
    );
  });

  it('⑬ 混合 v4/v6 链取末段', () => {
    expect(
      clientIpOf({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4, ::ffff:10.0.0.1' } }),
    ).toBe('::ffff:10.0.0.1');
  });
});
