import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayConfigService } from './config.service';
import { defaultSettings } from './settings.defaults';

/**
 * `RelayConfigService.loadSettings` —— **从 `settings.json` 重载**的行为。
 *
 * ## 为什么专门为这条写测试
 *
 * `deepMerge` 曾经是 `if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;`
 * —— 它把「patch 是标量」和「patch 缺值」混为一谈，于是 `settings.json` 里**所有标量设置**
 * 在启动加载时被**默认值覆盖**：控制台改的值一重启就静默回退；`false` 还会被 `!patch` 吃掉，
 * 导致默认 true 的开关**根本关不掉**。
 *
 * 它长期没被发现，是因为**运行时 `PUT /api/settings` 走另一条路径**（直接改内存），当场生效，
 * 控制台看起来一切正常 —— 只有「重启后从文件重载」这一条是坏的，而它只在**重启**时暴露。
 * 最终由 task#43 的实测暴露：把 `service.listenPort=29123` 写进 `settings.json`、
 * 启动后看它绑哪个端口 → **实际绑了 8787（默认）**。
 *
 * 本文件用**真实文件 + 真实构造**复现那条路径（不是 mock 一个对象），所以它能抓住这个类别的回归。
 */
describe('RelayConfigService — 从 settings.json 重载', () => {
  let dir: string;
  const ORIG = process.env.RELAY_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-cfg-'));
    process.env.RELAY_DATA_DIR = dir;
  });

  afterEach(() => {
    if (ORIG === undefined) delete process.env.RELAY_DATA_DIR;
    else process.env.RELAY_DATA_DIR = ORIG;
    rmSync(dir, { recursive: true, force: true });
  });

  /** 写一份 settings.json（以默认值为底，套用 patch）。 */
  function writeSettings(patch: Record<string, unknown>): void {
    const base = defaultSettings();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { ...base, ...patch } }, null, 2),
      'utf8',
    );
  }

  it('★ 标量（number）必须来自文件 —— 这正是 listenPort 栽的地方', () => {
    writeSettings({ service: { ...defaultSettings().service, listenPort: 29123 } });
    const svc = new RelayConfigService();
    expect(svc.get().service.listenPort).toBe(29123);
  });

  it('★ 标量（string）必须来自文件 —— baseUrl 同理', () => {
    writeSettings({
      upstream: { ...defaultSettings().upstream, baseUrl: 'https://example.invalid/' },
    });
    const svc = new RelayConfigService();
    expect(svc.get().upstream.baseUrl).toBe('https://example.invalid/');
  });

  it('★ 布尔 false 必须生效（`!patch` 会把它当成缺值，于是默认 true 的开关关不掉）', () => {
    const base = defaultSettings();
    expect(base.upstream.spoofUA).toBe(true); // 前提：默认是 true，否则本用例无意义
    writeSettings({ upstream: { ...base.upstream, spoofUA: false } });
    const svc = new RelayConfigService();
    expect(svc.get().upstream.spoofUA).toBe(false);
  });

  it('文件里缺的字段回落到默认值（合并而不是替换）', () => {
    // 只给 service 组，其余组缺失
    writeSettings({ service: { listenHost: '127.0.0.1', listenPort: 29123 } as never });
    const svc = new RelayConfigService();
    expect(svc.get().service.listenPort).toBe(29123);
    expect(svc.get().limits.concurrency).toBe(defaultSettings().limits.concurrency);
  });

  it('文件不存在时以默认值落盘（并真的写出来）', () => {
    const svc = new RelayConfigService();
    expect(svc.get().service.listenPort).toBe(defaultSettings().service.listenPort);
    const p = join(dir, 'settings.json');
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8')).settings.service.listenPort).toBe(
      defaultSettings().service.listenPort,
    );
  });

  it('损坏的 JSON 要抛错并指出文件路径（不能静默用默认值顶过去）', () => {
    writeFileSync(join(dir, 'settings.json'), '{ this is not json', 'utf8');
    expect(() => new RelayConfigService()).toThrow(/settings\.json|读取/);
  });
});
