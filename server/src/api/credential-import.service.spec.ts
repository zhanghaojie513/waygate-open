/**
 * 本机凭证自动导入服务测试（v1.6.5）。
 *
 * 重点：
 *   · 分离部署（本机无客户端登录态）→ 如实返回 `unavailable`，并给出本机推送命令
 *   · WorkBuddy（openai）不需要本机导入 → 直接 `unavailable` 且说明原因
 *   · providerId 形状非法 → 拒绝（参数注入防线）
 * 不打真客户端、不跑真脚本（脚本路径不存在时的分支另行覆盖）。
 */
import 'reflect-metadata';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { CredentialImportService } from './credential-import.service';

describe('CredentialImportService', () => {
  let svc: CredentialImportService;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    svc = new CredentialImportService();
    /* 把客户端登录态指到必然不存在的位置 —— 稳定走「分离部署」分支。 */
    savedEnv.QODER_APP_DIR = process.env.QODER_APP_DIR;
    savedEnv.MINIMAX_AUTH_FILE = process.env.MINIMAX_AUTH_FILE;
    process.env.QODER_APP_DIR = 'C:/definitely/not/here/qoder';
    process.env.MINIMAX_AUTH_FILE = 'C:/definitely/not/here/minimax/auth.json';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('分离部署：本机无 MiniMax 客户端 → unavailable 并给推送命令', async () => {
    const r = await svc.importFromLocal('p_mm0001', 'anthropic');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('unavailable');
    expect(r.message).toContain('import-credential-push.mjs');
    expect(r.message).toContain('minimax');
  });

  it('分离部署：本机无 Qoder 客户端 → unavailable 并给推送命令', async () => {
    const r = await svc.importFromLocal('p_qoder01', 'qoder');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('unavailable');
    expect(r.message).toContain('import-credential-push.mjs');
    expect(r.message).toContain('qoder');
  });

  it('WorkBuddy（openai）不走本机导入 → unavailable 且说明用密钥', async () => {
    const r = await svc.importFromLocal('p_default00', 'openai');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('unavailable');
    expect(r.message).toContain('静态 API 密钥');
  });

  it('providerId 形状非法 → 拒绝（参数注入防线）', async () => {
    const r = await svc.importFromLocal('../../etc/passwd', 'qoder');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('error');
    expect(r.message).toContain('非法');
  });
});
