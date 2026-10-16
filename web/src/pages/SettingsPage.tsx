import { useMemo, useState } from 'react';
import { KeyRound, RotateCcw, Save } from 'lucide-react';
import { api } from '../services/api';
import { useResource } from '../hooks/useResource';
import type { SettingGroup, SettingItem, SettingPatch } from '../types/api';
import { ApiError } from '../services/http';
import { Topbar } from '../components/ui/Topbar';
import { Banner } from '../components/ui/Banner';
import { Pill } from '../components/ui/Pill';
import { Panel } from '../components/ui/Panel';
import { StateBlock, errorDetail } from '../components/ui/StateBlock';
import { SettingControl } from '../components/settings/SettingControl';
import { AccessPanel } from '../components/clients/AccessPanel';
import { AdminPasswordModal } from '../components/settings/AdminPasswordModal';
import { DangerConfirmModal, type DangerSpec } from '../components/settings/DangerConfirmModal';
import { DANGER_SPECS } from '../lib/danger-specs';
import { ProviderHealthCard } from '../components/settings/ProviderHealthCard';

/**
 * 提供商**身份**键 —— 密钥来源 / 密钥状态。
 *
 * 契约 §3.12 写明「设置页不再单独渲染这两个键」：它们是**活提供商**的属性，
 * 由「提供商管理 → 提供商」表的「修改」抽屉呈现。
 *
 * [v0.6.5] `upstream.baseUrl` 已从滤除列表移出 —— 后端把它改成了**只读说明项**
 * （「提供商地址已按家维护」），保留显示反而能让用户找到正确入口，故留在页面上。
 */
const PROVIDER_IDENTITY_KEYS = new Set(['credential.source', 'credential.status']);

/** [v7.0] 设置分组在左侧导航中的色调 —— 与徽标色一并决定"这块属于哪一类"。 */
type NavTone = 'ghost' | 'cyan' | 'amber' | 'rose';

const NAV_TONE: Record<string, NavTone> = {
  service: 'ghost',
  credential: 'cyan',
  quota: 'amber',
  limits: 'rose',
  logs: 'ghost',
  password: 'amber',
  danger: 'amber',
  mapping: 'cyan',
};

/** 提供商配置在提供商管理页即时保存；其余设置项批量保存，危险操作二次确认。 */
export function SettingsPage() {
  const res = useResource(() => api.settings(), [], { cacheKey: 'settings' });
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<ApiError | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [dangerSpec, setDangerSpec] = useState<DangerSpec | null>(null);
  const [dangerMsg, setDangerMsg] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [active, setActive] = useState<string>('access');

  const groups: SettingGroup[] = res.data?.groups ?? [];

  /** [v7.0] 导航项**由真实 group 数据派生** —— 不硬编码组名，改后端设置组不用改这里。
   [2026-10-12 用户要求] 去掉「提供商健康」入口：它是只读总览，属于「提供商管理 → 提供商」
   的地盘；放在设置页的分组导航里会让导航读起来像"这里能改提供商状态"，而它一个字都改不了。
   `ProviderHealthCard` 本身仍在「接入地址」那一节渲染（它是接入信息的必要补充），
   只是不再单独占一个导航项。 */
  const navItems = useMemo(() => {
    const out: Array<{ id: string; label: string; tone: NavTone }> = [
      { id: 'access', label: '接入地址', tone: 'cyan' },
    ];
    for (const g of groups) {
      if (g.id === 'mapping') continue; // 映射单独一节，放最后
      out.push({ id: g.id, label: g.label, tone: NAV_TONE[g.id] ?? 'ghost' });
    }
    out.push({ id: 'password', label: '管理口令', tone: 'amber' });
    out.push({ id: 'mapping', label: '键位映射', tone: 'cyan' });
    return out;
  }, [groups]);

  /** 组内被改动的项数（供导航项右侧显示"这组有 N 项待保存"）。 */
  const dirtyCountByGroup = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of groups) {
      let n = 0;
      for (const it of g.items) {
        if (PROVIDER_IDENTITY_KEYS.has(it.key)) continue;
        if (it.readonly || it.type === 'action' || it.type === 'mapping') continue;
        if (it.key in edits && edits[it.key] !== it.value) n += 1;
      }
      if (n > 0) out[g.id] = n;
    }
    return out;
  }, [groups, edits]);

  const valueOf = (key: string, fallback: unknown) => (key in edits ? edits[key] : fallback);

  /* 可批量 PUT 的可写项。
     提供商**身份**三键不在此列 —— 它们由「修改」抽屉走 `/api/providers/:id`（PATCH），
     而 `upstream.baseUrl` 在设置里是"活提供商的落点"，从设置页直接改会绕过提供商表，
     两个入口各写一半正是要避免的。组里其余项（伪装 / 改写）照常参与批量保存。 */
  const dirtyPatch: SettingPatch[] = useMemo(() => {
    if (!res.data) return [];
    const out: SettingPatch[] = [];
    res.data.groups.forEach((g) =>
      g.items.forEach((it) => {
        if (PROVIDER_IDENTITY_KEYS.has(it.key)) return;
        if (it.readonly || it.type === 'action' || it.type === 'mapping') return;
        if (it.key in edits && edits[it.key] !== it.value) out.push({ key: it.key, value: edits[it.key] });
      }),
    );
    return out;
  }, [res.data, edits]);

  const save = async () => {
    if (dirtyPatch.length === 0 || saving) return;
    setSaving(true);
    setSaveErr(null);
    setSavedMsg(null);
    try {
      const out = await api.putSettings(dirtyPatch);
      setEdits({});
      setSavedMsg(
        out.requiresRestart
          ? `已应用 ${out.applied} 项，配置版本 → v${out.version}。其中含需重启才生效的项。`
          : `已应用 ${out.applied} 项，配置版本 → v${out.version}。`,
      );
      res.reload();
    } catch (err) {
      setSaveErr(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
    } finally {
      setSaving(false);
    }
  };

  const onDangerDone = (res2: { affected: { logs?: number; keys?: number | null } }) => {
    const n = res2.affected.logs ?? res2.affected.keys ?? 0;
    setDangerMsg(`操作已完成，影响 ${n} 条记录。`);
    setDangerSpec(null);
    res.reload();
  };

  const mapping = groups.find((g) => g.id === 'mapping')?.items[0];
  const activeGroup = groups.find((g) => g.id === active);
  /** [v7.0] 危险操作组的 items 走独立渲染（danger pill + why 文案），不进普通 SettingRow。 */
  const dangerItems = groups.find((g) => g.id === 'danger')?.items ?? [];

  return (
    <div className="view on">
      <Topbar
        title="设置"
        status={
          res.data ? (
            <Pill tone={dirtyPatch.length ? 'amber' : 'ghost'} dot={dirtyPatch.length > 0}>
              {dirtyPatch.length ? `${dirtyPatch.length} 项待保存` : `配置版本 v${res.data.version}`}
            </Pill>
          ) : null
        }
        actions={
          <>
            {dirtyPatch.length ? (
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEdits({})}>
                <RotateCcw size={14} />
                放弃改动
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={dirtyPatch.length === 0 || saving}
              onClick={() => void save()}
            >
              <Save size={14} />
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      />

      <div className="view-body stack">
        {saveErr ? (
          <Banner tone="error">{errorDetail(saveErr)}</Banner>
        ) : null}
        {savedMsg ? <Banner tone="success">{savedMsg}</Banner> : null}
        {dangerMsg ? <Banner tone="success">{dangerMsg}</Banner> : null}
        {pwMsg ? <Banner tone="success">{pwMsg}</Banner> : null}

        <div className="settings-split">
          {/* [v7.0] 左侧分组导航：原先 8+ 张 .card 平铺在 2 列网格里，
              一屏灌下去层次全糊；现在导航与内容分栏，一次只看一组。 */}
          <nav className="settings-nav" aria-label="设置分组">
            {navItems.map((item) => {
              const dirty = dirtyCountByGroup[item.id] ?? 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-i${active === item.id ? ' on' : ''}`}
                  aria-current={active === item.id ? 'page' : undefined}
                  onClick={() => setActive(item.id)}
                >
                  <span className="settings-nav-label">{item.label}</span>
                  {dirty > 0 ? <span className="settings-nav-dirty">{dirty}</span> : null}
                </button>
              );
            })}
          </nav>

          <div className="settings-content">
            {res.initial && res.loading ? (
              <Panel>
                <StateBlock kind="loading" title="正在读取配置…" />
              </Panel>
            ) : res.error ? (
              <Panel>
                <StateBlock kind="error" title="配置没取到" detail={errorDetail(res.error)} onRetry={res.reload} />
              </Panel>
            ) : (
              <>
                {active === 'access' ? (
                  <>
                    <AccessPanel />
                    <ProviderHealthCard />
                  </>
                ) : null}

                {active === 'password' ? (
                  <div className="card">
                    <div className="group-head">
                      <h3>
                        <KeyRound size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                        管理口令
                      </h3>
                      <p>控制台的唯一入口凭证</p>
                    </div>
                    <div className="set-row">
                      <div className="info">
                        <b>管理口令</b>
                        <span>
                          两种改法：<b>随机重置</b>由服务端生成 16 位新口令（更强，但需当场保存）；
                          <b>手动设定</b>由你输入一个方便记忆的口令（至少 8 个字符）。
                          两种都立即生效、无需重启；新口令不回显、不落浏览器任何位置。
                        </span>
                      </div>
                      <div className="ctl">
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          disabled={saving}
                          onClick={() => setPwOpen(true)}
                        >
                          <KeyRound size={13} />
                          修改
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {active === 'danger' ? (
                  <div className="card danger-zone">
                    <div className="group-head">
                      <h3 style={{ color: 'var(--warn-amber)' }}>危险操作</h3>
                      <p>不可撤销，需二次确认</p>
                    </div>
                    {dangerItems.map((it) => (
                      <div className="set-row" key={it.key}>
                        <div className="info">
                          <b>{it.label}</b>
                          <span>{it.why}</span>
                        </div>
                        <div className="ctl">
                          <button
                            type="button"
                            className="mini-pill danger"
                            disabled={saving}
                            onClick={() => setDangerSpec(DANGER_SPECS[it.key] ?? null)}
                          >
                            {it.label}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {active === 'mapping' ? (
                  mapping?.type === 'mapping' ? (
                    <Panel title={mapping.label} aside={<Pill>config.yml</Pill>}>
                      <div className="code" style={{ fontSize: 12 }}>
                        {Object.entries((mapping.value ?? {}) as Record<string, string>).map(([k, v]) => (
                          <div key={k}>
                            <span className="k">{k}</span> → <span className="st">{v}</span>
                          </div>
                        ))}
                      </div>
                      <div className="footer-note">{mapping.why}</div>
                    </Panel>
                  ) : null
                ) : null}

                {activeGroup && activeGroup.id !== 'danger' && activeGroup.id !== 'mapping' ? (
                  <SettingGroupCard
                    group={activeGroup}
                    saving={saving}
                    valueOf={valueOf}
                    onChange={(k, v) => setEdits((prev) => ({ ...prev, [k]: v }))}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      {dangerSpec ? (
        <DangerConfirmModal
          spec={dangerSpec}
          onClose={() => setDangerSpec(null)}
          onDone={onDangerDone}
        />
      ) : null}

      {pwOpen ? (
        <AdminPasswordModal
          onClose={() => setPwOpen(false)}
          onDone={() => {
            setPwMsg('管理口令已更新并立即生效。下次登录请使用新口令。');
            res.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * [v7.0] 单个设置组的卡片 —— 从原 `settings-grid` 里的 map 体抽出来，
 * 这样导航切组时只渲染当前组，DOM 里不会一次躺着 8+ 张卡。
 *
 * 组内 `noop`（改了也不生效）的项仍单列一块，用「暂未生效」计数行点开；
 * 这是原有纪律，导航化之后它变成了「这一组里唯一需要展开的东西」。
 */
function SettingGroupCard({
  group,
  saving,
  valueOf,
  onChange,
}: {
  group: SettingGroup;
  saving: boolean;
  valueOf: (key: string, fallback: unknown) => unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  /* 提供商组：只留**全局策略**，滤掉身份键（见 PROVIDER_IDENTITY_KEYS）。
     滤完为空的组不渲染 —— 一个只有副标题的空卡片比没有更糟。 */
  const items = group.items.filter((it) => !PROVIDER_IDENTITY_KEYS.has(it.key));
  if (items.length === 0) return null;

  /* [2026-10-08] 组内分流：`noop`（改了也不生效）的项单独成块。
     理由：这些项**可编辑但无行为** —— 混在正常项里，用户会改它、
     然后等一个不会发生的变化。原来的对策只是在 `why` 里写一句
     「此值当前不产生任何行为」，而十几项平铺的长列表里那半句会被跳过。
     现在按标志位机械分流，不依赖文案被读到。
     ⚠️ 组内**全部**是 noop 时（如积分同步组只剩缓存折扣 + 3 个空转项混排），
     正常块为空就不渲染，只剩「暂未生效」块。 */
  const live = items.filter((it) => !it.noop);
  const dormant = items.filter((it) => it.noop);

  return (
    <div className="card">
      <div className="group-head">
        <h3>{group.label}</h3>
        <p>{groupHint(group.id)}</p>
      </div>
      {live.map((it) => (
        <SettingRow
          key={it.key}
          item={it}
          value={valueOf(it.key, it.value)}
          saving={saving}
          onChange={(v) => onChange(it.key, v)}
        />
      ))}
      {dormant.length > 0 ? (
        <details className="dormant">
          <summary>
            {dormant.length} 项暂未生效
            <span>改了不会有任何变化 —— 依赖的功能未实现或上游未供货</span>
          </summary>
          {dormant.map((it) => (
            <SettingRow
              key={it.key}
              item={it}
              value={valueOf(it.key, it.value)}
              saving={saving}
              onChange={(v) => onChange(it.key, v)}
            />
          ))}
        </details>
      ) : null}
    </div>
  );
}

function groupHint(id: string): string {
  const map: Record<string, string> = {
    service: '进程监听与启动方式',
    /* [v0.6.5] 组名从「上游连接」改为「提供商策略」：本部署已是三家提供商并存
       （WorkBuddy / MiniMax Code / Qoder CN），提供商身份（地址/凭证/模型清单）
       在「提供商管理 → 提供商」；本组只剩跨提供商的全局策略，且各项生效范围不同
       （userAgent / spoofUA 仅 WorkBuddy；promptRewrite 三家都改写）。 */
    credential: '跨提供商的全局策略（部分项仅对 WorkBuddy 生效）',
    /* [v0.6.5] 如实化：轮询只对 WorkBuddy 生效；MiniMax 走独立账本；Qoder 走 v2/me/usage（随活动检查拉取）。 */
    quota: '积分口径与额度轮询（仅 WorkBuddy；MiniMax 走独立账本，Qoder 无端点）',
    /* [v1.3.0] 新组：WorkBuddy 自动签到开关（MiniMax 恒开、Qoder 无积分体系）。 */
    signin: '每日 08:05 自动签到（WorkBuddy 可关；MiniMax 恒开，Qoder 无签到）',
    limits: '自用场景的保护，而非配额限制',
    logs: '留在本机，不参与同步',
  };
  return map[id] ?? '';
}

/**
 * 单行设置：标题 + 为什么 + 右侧控件。
 *
 * 抽成组件是因为组内现在要**分两块渲染**（生效项 / 暂未生效项），
 * 两块的每一行长得完全一样 —— 不抽的话那段 JSX 会被复制一份，
 * 以后改行样式必然只改一处（这正是本项目反复踩过的"两份各写一半"）。
 */
function SettingRow({
  item,
  value,
  saving,
  onChange,
}: {
  item: SettingItem;
  value: unknown;
  saving: boolean;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="set-row">
      <div className="info">
        <b>
          {item.label}
          {item.requiresRestart ? (
            <span style={{ marginLeft: 8, fontSize: 10.5, color: 'var(--warn-amber)' }}>需重启</span>
          ) : null}
        </b>
        <span>{item.why}</span>
      </div>
      <div className="ctl">
        <SettingControl item={item} value={value} disabled={saving} onChange={onChange} />
      </div>
    </div>
  );
}
// @zbiti-ai:f:354:37432733