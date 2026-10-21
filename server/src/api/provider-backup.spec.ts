/**
 * 删除前留档（v1.7.1）—— 钉住四件事：
 *   ① 三个凭证文件（.key/.oauth/.access）**原文**进快照，缺的不写空串冒充；
 *   ② 行 / 目录分区 / 偏好三样都在，格式版本号是 1（将来能认出来）；
 *   ③ 文件权限 0600、目录 0700（里面有 refresh token 与 OAuth 授权）；
 *   ④ 保留期只留最近 20 份，坏的 JSON 不让整个列表失败。
 */
import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderBackupService } from './provider-backup.service';
import type { ProviderRow } from '../store/repositories/providers.repo';

function makeSvc() {
  const root = mkdtempSync(join(tmpdir(), 'prov-backup-'));
  const providersDir = join(root, 'providers');
  const backupDir = join(root, 'backup');
  const svc = new ProviderBackupService();
  svc.setDirForTest(backupDir);
  return { svc, providersDir, backupDir, root };
}

const ROW: ProviderRow = {
  id: 'p_test01', name: 'MiniMax Code', base_url: 'https://agent.minimax.cn', active: 1,
  protocol: 'anthropic', chat_path: null, cred_kind: 'oauth_minimax', access_expires_at: null,
  signin_checked_on: '2026-10-20', signin_streak: 12, signin_last_points: 1200,
  wb_signin_checked_on: null, wb_signin_streak: null, wb_signin_last_points: null,
  wb_oauth_expires_at: null, created_at: 1, updated_at: 2,
};

function writeCred(dir: string, suffix: string, content: string): void {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'p_test01' + suffix), content);
}

describe('留档 · 内容', () => {
  it('★ 三个凭证文件原文进快照（.key / .oauth / .access）', () => {
    const { svc, providersDir, backupDir } = makeSvc();
    writeCred(providersDir, '.key', 'mmort_refresh_token_value');
    writeCred(providersDir, '.oauth', '{"accessToken":"at","refreshToken":"rt","uid":"u1"}');
    writeCred(providersDir, '.access', 'mmoat_access_value');

    const file = svc.snapshot({
      provider: ROW, models: [{ id: 'MiniMax-M3', enabled: 1 }], prefs: [{ modelId: 'MiniMax-M3', enabled: true }], providersDir,
    });

    expect(file).toMatch(/^provider-p_test01-\d{8}-\d{6}\.json$/);
    const saved = JSON.parse(readFileSync(join(backupDir, file), 'utf8'));
    expect(saved.format).toBe(1);
    expect(saved.credentials['.key']).toBe('mmort_refresh_token_value');
    expect(saved.credentials['.oauth']).toContain('"refreshToken":"rt"');
    expect(saved.credentials['.access']).toBe('mmoat_access_value');
    expect(saved.provider.name).toBe('MiniMax Code');
    expect(saved.provider.signin_streak).toBe(12);
    expect(saved.models).toHaveLength(1);
    expect(saved.prefs).toHaveLength(1);
  });

  it('缺失的凭证文件不写空串（不冒充"存在但为空"）', () => {
    const { svc, providersDir, backupDir } = makeSvc();
    writeCred(providersDir, '.key', 'only_key');
    const file = svc.snapshot({ provider: ROW, models: [], prefs: [], providersDir });
    const saved = JSON.parse(readFileSync(join(backupDir, file), 'utf8'));
    expect(Object.keys(saved.credentials)).toEqual(['.key']);
  });

  it('★ 文件 0600、目录 0700（里面有 refresh token 与 OAuth 授权）', () => {
    const { svc, providersDir, backupDir } = makeSvc();
    writeCred(providersDir, '.key', 'k');
    const file = svc.snapshot({ provider: ROW, models: [], prefs: [], providersDir });
    /* Windows 不实现 POSIX 权限位，跳过断言（Linux/CI 上才有效）。 */
    if (process.platform !== 'win32') {
      expect(statSync(join(backupDir, file)).mode & 0o777).toBe(0o600);
      expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    }
  });
});

describe('留档 · 列表与保留期', () => {
  it('列表只给元数据，不含凭证内容', () => {
    const { svc, providersDir } = makeSvc();
    writeCred(providersDir, '.key', 'secret_value_must_not_leak');
    svc.snapshot({ provider: ROW, models: [], prefs: [], providersDir });
    const items = svc.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ providerId: 'p_test01', providerName: 'MiniMax Code', hasCredential: true });
    expect(JSON.stringify(items)).not.toContain('secret_value_must_not_leak');
  });

  it('坏 JSON 跳过，不影响其它行', () => {
    const { svc, providersDir, backupDir } = makeSvc();
    writeCred(providersDir, '.key', 'k');
    svc.snapshot({ provider: ROW, models: [], prefs: [], providersDir });
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'provider-broken-20260101-000000.json'), '{ not json');
    expect(svc.list()).toHaveLength(1);
  });

  it('★ 只保留最近 20 份（多的从最旧删）', () => {
    const { svc, providersDir, backupDir } = makeSvc();
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(backupDir, { recursive: true });
    /* 造 25 个旧文件（mtime 递增），再 snapshot 一次触发 prune。 */
    for (let i = 0; i < 25; i++) {
      writeFileSync(
        join(backupDir, `provider-p_old${i}-20260101-0000${String(i).padStart(2, '0')}.json`),
        JSON.stringify({ format: 1, takenAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, provider: { id: `p_old${i}`, name: 'x' }, credentials: {} }),
      );
    }
    writeCred(providersDir, '.key', 'k');
    svc.snapshot({ provider: ROW, models: [], prefs: [], providersDir });
    const files = require('node:fs').readdirSync(backupDir).filter((f: string) => f.endsWith('.json'));
    expect(files.length).toBe(20);
    /* 最新的那份（刚写的）必须在。 */
    expect(files.some((f: string) => f.includes('p_test01'))).toBe(true);
  });
});

describe('留档 · 失败不阻断', () => {
  it('目录不可写时返回空串（不抛 —— 否则用户无法清理提供商）', () => {
    const svc = new ProviderBackupService();
    /* 指向一个已存在**文件**的路径当目录 → mkdir 必失败。 */
    const root = mkdtempSync(join(tmpdir(), 'prov-backup-fail-'));
    const asFile = join(root, 'blocked');
    writeFileSync(asFile, 'x');
    svc.setDirForTest(asFile);
    const out = svc.snapshot({ provider: ROW, models: [], prefs: [], providersDir: root });
    expect(out).toBe('');
    expect(existsSync(asFile)).toBe(true);
  });
});
