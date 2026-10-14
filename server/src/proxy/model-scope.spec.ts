/**
 * `scopeAllowsModel` 的判定表（api-contract §2.1.2 第 3 步附）。
 *
 * 这是**纯函数**单测：四态 × 边界（大小写、空标签、别名）逐条钉住。
 *
 * 为什么值得单独一个文件：这段判定以前**根本不存在**，而它缺位的后果不是报错，
 * 是「界面上写着『仅 kimi 系』的密钥实际能调任何模型」—— 一句看起来已生效的承诺。
 * 判定表本身只有十几行，但它每一个分支写反都会静默放行。
 */
import { describe, expect, it } from 'vitest';
import { scopeAllowsModel, describeScope } from './model-scope';
import type { KeyScope } from '../store/repositories/client-keys.repo';

/** 造一个判定目标（只取判定真正用到的三列）。 */
const model = (id: string, family: string, tag: string | null = null) => ({ id, family, tag });

describe('scopeAllowsModel · all（放行一切）', () => {
  it('任何模型都放行', () => {
    expect(scopeAllowsModel({ type: 'all' }, model('glm-5.3', 'glm'))).toBe(true);
    expect(scopeAllowsModel({ type: 'all' }, model('kimi-k3', 'kimi', '订阅优先'))).toBe(true);
  });

  it('scope 缺失时放行（守卫未设 keyContext 的路径，如测试桩）', () => {
    expect(scopeAllowsModel(undefined, model('glm-5.3', 'glm'))).toBe(true);
    expect(scopeAllowsModel(null, model('glm-5.3', 'glm'))).toBe(true);
  });
});

describe('scopeAllowsModel · family（仅某系）', () => {
  it('同系放行、异系拦截', () => {
    const s: KeyScope = { type: 'family', value: 'kimi' };
    expect(scopeAllowsModel(s, model('kimi-k3', 'kimi'))).toBe(true);
    expect(scopeAllowsModel(s, model('kimi-k2.7', 'kimi'))).toBe(true);
    expect(scopeAllowsModel(s, model('glm-5.3', 'glm'))).toBe(false);
  });

  it('大小写与空白不影响判定（catalog.resolve 本身就按小写 id 查，这里不能分裂）', () => {
    expect(scopeAllowsModel({ type: 'family', value: 'Kimi' }, model('kimi-k3', 'kimi'))).toBe(true);
    expect(scopeAllowsModel({ type: 'family', value: ' kimi ' }, model('kimi-k3', 'kimi'))).toBe(true);
  });

  it('★ 前缀相似但不是同一系（kimi vs kimi-k2 之类）不允许误命中', () => {
    // family 是精确分段比较，不是前缀匹配 —— 否则「仅 hy3 系」会放进 hy4 的模型
    expect(scopeAllowsModel({ type: 'family', value: 'hy3' }, model('hy3', 'hy3'))).toBe(true);
    expect(scopeAllowsModel({ type: 'family', value: 'hy3' }, model('hy4-preview', 'hy4'))).toBe(false);
  });
});

describe('scopeAllowsModel · tag（仅某标签）', () => {
  it('标签相同放行、不同拦截', () => {
    const s: KeyScope = { type: 'tag', value: '夜间折扣' };
    expect(scopeAllowsModel(s, model('deepseek-v4.1-flash', 'deepseek', '夜间折扣'))).toBe(true);
    expect(scopeAllowsModel(s, model('kimi-k3', 'kimi', '订阅优先'))).toBe(false);
  });

  it('★ 模型没有标签时**不放行**（「仅限时免费」不能因为"它没标签"就把无标签模型放进来）', () => {
    expect(scopeAllowsModel({ type: 'tag', value: '限时免费' }, model('kimi-k2.7', 'kimi', null))).toBe(false);
  });
});

describe('scopeAllowsModel · models（指定清单）', () => {
  it('在清单内放行、不在则拦截', () => {
    const s: KeyScope = { type: 'models', value: ['glm-5.3', 'kimi-k3'] };
    expect(scopeAllowsModel(s, model('glm-5.3', 'glm'))).toBe(true);
    expect(scopeAllowsModel(s, model('kimi-k3', 'kimi'))).toBe(true);
    expect(scopeAllowsModel(s, model('minimax-m3', 'minimax'))).toBe(false);
  });

  it('大小写不影响（清单里写 Kimi-K3，模型 id 是 kimi-k3）', () => {
    expect(scopeAllowsModel({ type: 'models', value: ['Kimi-K3'] }, model('kimi-k3', 'kimi'))).toBe(true);
  });

  it('★ 判定用的是**解析后的 id**，所以按显示名请求也会被正确判定', () => {
    // 请求发 "Kimi-K3"（显示名）→ resolveModel 解析成 id kimi-k3 → 再判 scope。
    // 这正是契约把 scope 判定放在第 3 步「模型映射」**之后**的原因。
    const s: KeyScope = { type: 'models', value: ['kimi-k3'] };
    const resolved = model('kimi-k3', 'kimi');
    expect(scopeAllowsModel(s, resolved)).toBe(true);
  });

  it('空清单（理论上 normalizeScope 已挡）拦截一切，不静默放行', () => {
    expect(scopeAllowsModel({ type: 'models', value: [] }, model('kimi-k3', 'kimi'))).toBe(false);
  });
});

describe('describeScope · 与前端 formatScope 逐字一致', () => {
  it('四态的措辞与 web/src/lib/format.ts 的 formatScope 相同', () => {
    /* 这些字符串必须与前端 formatScope 一模一样 —— 同一条 scope 在密钥列表里
       显示一种说法、在 403 报错里显示另一种，用户会以为是两个不同的东西。 */
    expect(describeScope({ type: 'all' })).toBe('全部模型');
    expect(describeScope({ type: 'family', value: 'kimi' })).toBe('仅 kimi 系');
    expect(describeScope({ type: 'tag', value: '夜间折扣' })).toBe('仅 夜间折扣');
    expect(describeScope({ type: 'models', value: ['a', 'b'] })).toBe('指定 2 个模型');
  });

  it('scope 缺失时回落「全部模型」（与该分支的放行语义一致）', () => {
    expect(describeScope(undefined)).toBe('全部模型');
  });
});
