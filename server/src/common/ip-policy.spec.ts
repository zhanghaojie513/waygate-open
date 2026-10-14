/**
 * IP 白名单条目解析与匹配的纯函数测试（v0.4.35）。
 * 守卫热路径每个请求都走这里 —— 边界值必须钉死。
 */
import { describe, expect, it } from 'vitest';
import { ipAllowed, ipMatches, normalizeIpEntry } from './ip-policy';

describe('normalizeIpEntry', () => {
  it('接受 IPv4 / IPv4 CIDR / IPv6，归一化输出', () => {
    expect(normalizeIpEntry('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIpEntry('  203.0.113.0/24  ')).toBe('203.0.113.0/24');
    expect(normalizeIpEntry('2001:DB8::1')).toBe('2001:db8::1'); // v6 小写化
    expect(normalizeIpEntry('0.0.0.0/0')).toBe('0.0.0.0/0');
  });

  it('拒绝垃圾输入（返回 null，由调用方报 400）', () => {
    expect(normalizeIpEntry('')).toBeNull();
    expect(normalizeIpEntry('999.1.1.1')).toBeNull();
    expect(normalizeIpEntry('1.2.3')).toBeNull();
    expect(normalizeIpEntry('10.0.0.0/33')).toBeNull();
    expect(normalizeIpEntry('10.0.0.0/abc')).toBeNull();
    expect(normalizeIpEntry('2001:db8::/64')).toBeNull(); // v6 CIDR 不支持（文件头声明）
    expect(normalizeIpEntry('example.com')).toBeNull();
  });
});

describe('ipMatches', () => {
  it('精确 IPv4', () => {
    expect(ipMatches('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipMatches('203.0.113.8', '203.0.113.7')).toBe(false);
  });

  it('IPv4 CIDR 网段', () => {
    expect(ipMatches('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipMatches('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipMatches('192.168.1.255', '192.168.1.0/24')).toBe(true);
    expect(ipMatches('192.168.2.0', '192.168.1.0/24')).toBe(false);
    expect(ipMatches('192.168.1.1', '192.168.1.1/32')).toBe(true); // /32 = 精确
    expect(ipMatches('8.8.8.8', '0.0.0.0/0')).toBe(true); // /0 = 全放行（按字面）
  });

  it('IPv6 精确（大小写不敏感）', () => {
    expect(ipMatches('2001:db8::1', '2001:DB8::1')).toBe(true);
    expect(ipMatches('2001:db8::2', '2001:db8::1')).toBe(false);
  });
});

describe('ipAllowed（整表判定）', () => {
  it('空白名单 = 不限，任何来源都放行', () => {
    expect(ipAllowed('1.2.3.4', [])).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
  });

  it('命中任一条目即放行', () => {
    expect(ipAllowed('10.0.0.5', ['203.0.113.7', '10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
  });

  it('不命中则拒绝', () => {
    expect(ipAllowed('10.0.0.5', ['203.0.113.7'])).toBe(false);
  });

  it('★ 白名单非空且来源未知 → 拒绝（fail closed：设了名单就意味着只许名单内）', () => {
    expect(ipAllowed(null, ['203.0.113.7'])).toBe(false);
    expect(ipAllowed('', ['203.0.113.7'])).toBe(false);
    expect(ipAllowed('unknown', ['203.0.113.7'])).toBe(false);
  });
});
