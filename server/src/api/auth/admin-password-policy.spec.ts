import { describe, expect, it } from 'vitest';
import { RelayHttpError } from '../../common/errors';
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  badAdminPassword,
  validateAdminPassword,
} from './admin-password-policy';

/**
 * 自定义管理口令的**校验策略**（契约 §3.1.4）。
 *
 * 这些断言是「用户自定义口令」路径的安全底线：一旦放行弱口令/空口令，
 * 控制台的唯一入口就形同虚设。故单独成文件、边界逐一钉住。
 */
describe('admin-password-policy · 校验', () => {
  it('① 合法口令原样返回（不 trim —— 用户带空格也保留）', () => {
    expect(validateAdminPassword('test-admin-pw-1')).toBe('test-admin-pw-1');
    // 前后带空格：校验用 trim 后的长度，但返回的是原串
    expect(validateAdminPassword('  abcdefgh  ')).toBe('  abcdefgh  ');
  });

  it('② 恰好下限（8）通过；7 拒绝且报错含长度', () => {
    expect(() => validateAdminPassword('a'.repeat(ADMIN_PASSWORD_MIN_LENGTH))).not.toThrow();

    let err: unknown = null;
    try {
      validateAdminPassword('a'.repeat(ADMIN_PASSWORD_MIN_LENGTH - 1));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RelayHttpError);
    expect((err as RelayHttpError).apiCode).toBe(40001);
    expect((err as RelayHttpError).message).toContain('至少 8');
    expect((err as RelayHttpError).message).toContain('7');
  });

  it('③ 恰好上限（128）通过；129 拒绝且报错含长度', () => {
    expect(() => validateAdminPassword('a'.repeat(ADMIN_PASSWORD_MAX_LENGTH))).not.toThrow();

    let err: unknown = null;
    try {
      validateAdminPassword('a'.repeat(ADMIN_PASSWORD_MAX_LENGTH + 1));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RelayHttpError);
    expect((err as RelayHttpError).message).toContain('128');
    expect((err as RelayHttpError).message).toContain('129');
  });

  it('④ 纯空白（空格 / Tab / 换行）一律拒绝', () => {
    for (const blank of ['        ', '  \t\n ', '\t\t\t', '\n\n']) {
      expect(() => validateAdminPassword(blank)).toThrow(RelayHttpError);
    }
  });

  it('⑤ 非字符串（数字 / undefined / null / 对象）拒绝，不静默转换', () => {
    for (const bad of [12345678, undefined, null, {}, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']]) {
      expect(() => validateAdminPassword(bad)).toThrow(RelayHttpError);
    }
  });

  it('⑥ 报错一律是 400 / 40001（契约 §3 只定义这一类参数错误）', () => {
    let err: unknown = null;
    try {
      validateAdminPassword('');
    } catch (e) {
      err = e;
    }
    expect((err as RelayHttpError).httpStatus).toBe(400);
    expect((err as RelayHttpError).apiCode).toBe(40001);
    expect((err as RelayHttpError).code).toBe('invalid_request_body');
  });

  it('⑦ badAdminPassword 构造的错误带给定 message', () => {
    expect(badAdminPassword('自定义原因').message).toBe('自定义原因');
  });
});
