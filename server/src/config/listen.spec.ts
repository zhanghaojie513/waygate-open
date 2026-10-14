/** 监听地址/端口解析单测（task#37 A2）——覆盖环境变量优先与公网绑定降级两条纪律。 */

import { describe, expect, it } from 'vitest';
import { resolveListen } from './listen';

const settings = (host: string, port: number) => ({ service: { listenHost: host, listenPort: port } });

describe('resolveListen', () => {
  it('① 默认取设置里的 host/port', () => {
    expect(resolveListen(settings('127.0.0.1', 9000), {})).toEqual({
      host: '127.0.0.1',
      port: 9000,
      downgraded: false,
    });
  });

  it('② RELAY_PORT 覆盖设置端口（自动化用随机端口，不能被磁盘端口覆盖）', () => {
    expect(resolveListen(settings('127.0.0.1', 9000), { RELAY_PORT: '54321' }).port).toBe(54321);
    // 非法端口回落到设置值，而不是 NaN
    expect(resolveListen(settings('127.0.0.1', 9000), { RELAY_PORT: 'abc' }).port).toBe(9000);
    expect(resolveListen(settings('127.0.0.1', 9000), { RELAY_PORT: '0' }).port).toBe(9000);
    expect(resolveListen(settings('127.0.0.1', 9000), { RELAY_PORT: '99999' }).port).toBe(9000);
  });

  it('③ ★ 非回环地址 + 无 RELAY_ALLOW_PUBLIC_BIND → 降级回 127.0.0.1 并标记', () => {
    const r = resolveListen(settings('0.0.0.0', 8787), {});
    expect(r.host).toBe('127.0.0.1');
    expect(r.downgraded).toBe(true);
  });

  it('④ 非回环地址 + RELAY_ALLOW_PUBLIC_BIND=1 → 放行（用户显式承担后果）', () => {
    const r = resolveListen(settings('0.0.0.0', 8787), { RELAY_ALLOW_PUBLIC_BIND: '1' });
    expect(r.host).toBe('0.0.0.0');
    expect(r.downgraded).toBe(false);
  });

  it('⑤ localhost / ::1 视为本机，不触发降级', () => {
    expect(resolveListen(settings('localhost', 8787), {}).downgraded).toBe(false);
    expect(resolveListen(settings('::1', 8787), {}).downgraded).toBe(false);
  });
});
