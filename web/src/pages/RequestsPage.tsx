import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CameraOff, Search } from 'lucide-react';
import { api } from '../services/api';
import { useResource } from '../hooks/useResource';
import { useFx } from '../hooks/useFx';
import { useDebounced } from '../hooks/useDebounced';
import type { RequestLogRow } from '../types/api';
import { Topbar } from '../components/ui/Topbar';
import { Pill } from '../components/ui/Pill';
import { Select } from '../components/ui/Select';
import { Panel, StatBar } from '../components/ui/Panel';
import { StateBlock, errorDetail } from '../components/ui/StateBlock';
import { RequestsSkeleton } from '../components/ui/PageSkeleton';
import { Drawer } from '../components/ui/Drawer';
import { Pager } from '../components/ui/Pager';
import { Tooltip } from '../components/ui/Tooltip';
import { Banner } from '../components/ui/Banner';
import { RequestTable } from '../components/requests/RequestTable';
import { RequestDetailView } from '../components/requests/RequestDetailView';
import { formatInt, formatPercent, NOTE_CREDENTIAL_INVALID } from '../lib/format';
import { ApiError } from '../services/http';

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'success', label: '仅成功' },
  { value: 'error', label: '仅异常' },
  /* [注意]「上游访问密钥失效」**不是状态码**：上游 401 按契约落的是 502
     （`status` = 客户端实际收到的码），且 502 与其它上游错误共用。识别它只能靠 `note`。
     所以这一项的 value 是 note 标记，不是 `'401'` —— `'401'` 会永远筛不出东西。 */
  { value: NOTE_CREDENTIAL_INVALID, label: '上游访问密钥失效' },
  { value: '429', label: '429 限流' },
  { value: '504', label: '504 上游超时' },
];

/** [v0.2.0 B7] 一键取证的窗口时长（毫秒）。服务端另有自动过期闸（logs.recordBodyUntil）。 */
const CAPTURE_WINDOW_MS = 30 * 60 * 1000;

/**
 * 取证倒计时文案。单独成组件是性能考虑：每秒的 setState 只重渲染这一小段文字，
 * 不再带着整页（含最多 100 行 × 多个 Tooltip 的请求表）每秒协调一次。
 */
function CaptureCountdown({ until, onExpire }: { until: number; onExpire: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, until - Date.now()));
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    // 返回 true 表示已到点
    const tick = () => {
      const l = until - Date.now();
      if (l <= 0) {
        onExpireRef.current();
        return true;
      }
      setLeft(l);
      return false;
    };
    if (tick()) return;
    const timer = setInterval(() => {
      if (tick()) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);

  return <>{`取证中 ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} · 点击关闭`}</>;
}

/**
 * 请求日志 —— 表 + 详情抽屉 + 分页 + 筛选。
 * 上游失败（5 位业务码 / 上游访问密钥失效）在详情里给出处置提示；错误码在统计条与筛选条可分组过滤。
 * [注意]「上游访问密钥失效」按 `note` 识别，不按 `status === 401`（见上）。
 */
export function RequestsPage() {
  const [page, setPage] = useState(1);
  /* 页码 → 游标。顺序「下一页」时记下上一页给的 nextCursor，之后来回翻这些页都走游标
     （服务端每页代价恒定，翻页期间有新请求写入也不会出现重复行）；
     跳到没记过游标的页则回落页码（OFFSET）。筛选条件一变就整体作废。 */
  const [pageCursors, setPageCursors] = useState<{ key: string; map: Record<number, string> }>({ key: '', map: {} });
  const [limit, setLimit] = useState(20);
  const [status, setStatus] = useState('all');
  /* 客户端筛选的**状态里存的是 `clientId`**（稳定标识），不存显示名 ——
     名字会随改名而变，存名字的话改一次名这个筛选就静默失配（AC-C06）。 */
  const [clientId, setClientId] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('clientId') ?? 'all');
  useEffect(() => {
    const sync = () => {
      setClientId(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('clientId') ?? 'all');
      setPage(1);
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q);

  const [openId, setOpenId] = useState<number | null>(null);
  const [reasoningOpen, setReasoningOpen] = useState(false);

  /* 客户端筛选下拉 + 日志行「当前名」映射的数据源：**client_keys（密钥清单）**，
     不是 `/api/clients` 的窗口聚合 —— 聚合从 requests 表推导，30 天窗口里
     旧 clientId（改名/删除前的）会带着快照名混进下拉（实测出现过 Curs0r、
     Cherry Studio 2 这类幽灵行）；且映射受窗口限制（无近期流量就映射不到正名）。
     密钥清单 = 提供商管理的权威集合：管理里有几个，下拉就有几个（用户口径）。 */
  const clientKeys = useResource(() => api.keys(), [], { cacheKey: 'keys' });

  /* [v0.4.14] 模型目录 → 计价标签查表（夜间折扣/限时免费等）。
     请求日志的行级没有 tag 字段 —— 标签属于**模型目录**的属性，
     这里按 `r.model`（模型 ID）去目录里查，不改服务端契约。
     [v0.5.13] 同一份目录再建一张 模型 → 提供商 表：日志的「提供商」列按模型解析。
     密钥的绑定名只是**路由偏好**，不能冒充提供商（绑定 WorkBuddy 的密钥请求
     MiniMax 模型时实际走 MiniMax Code）；requests 表没有 provider_id，
     按目录归属是当前能做到的最诚实口径。同 id 多家时取目录里第一家（确定性行为）。 */
  const catalog = useResource(() => api.catalog(), [], { cacheKey: 'catalog' });
  const tagByModel = useMemo(() => {
    const m = new Map<string, string>();
    for (const mod of catalog.data?.models ?? []) {
      if (mod.tag) m.set(mod.id, mod.tag);
    }
    return m;
  }, [catalog.data]);
  const modelTagOf = (modelId: string) => tagByModel.get(modelId) ?? null;
  /* [v1.6.33] 提供商解析优先级（用户实测报障后改）：
       ① `requests.providerId`（迁移 018 的**事实列**）→ 用 id → 名字表翻；
       ② 回落「模型目录反解」—— 只服务迁移前的老行（那时没这一列）。

     ⚠️ 旧实现只有 ②，于是同名模型永远显示错家：`MiniMax-M3.1-Flash` 同时出现在
     「MiniMax Code」与「MiniMax Code2」的目录里，反解取到先登记的那家，
     Code2 的流量全被显示成 Code。**目录反解本质是"猜"，事实列才是"记"。** */
  const providersRes = useResource(() => api.providers(), [], { cacheKey: 'providers' });
  /* id → 名字表：**提供商列表是权威源**（目录只有"启用中且有模型"的提供商 ——
     提供商停用后目录行消失，它的历史请求会翻不到名字，又退回错家的反解）。
     目录只作兜底补位（providers 接口失败时不至于整列空）。 */
  const providerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providersRes.data?.items ?? []) m.set(p.id, p.name);
    for (const mod of catalog.data?.models ?? []) {
      if (mod.providerId && !m.has(mod.providerId)) m.set(mod.providerId, mod.provider);
    }
    return m;
  }, [providersRes.data, catalog.data]);
  const providerByModel = useMemo(() => {
    const m = new Map<string, string>();
    for (const mod of catalog.data?.models ?? []) {
      if (!m.has(mod.id)) m.set(mod.id, mod.provider);
    }
    return m;
  }, [catalog.data]);
  /** 逐行提供商：优先事实列，回落目录反解（仅老行）。 */
  const providerOf = (row: { providerId?: string | null; model: string }): string | null => {
    if (row.providerId) {
      const byId = providerNameById.get(row.providerId);
      if (byId) return byId;
    }
    return providerByModel.get(row.model) ?? null;
  };

  const clientOptions = useMemo(
    () => [
      { value: 'all', label: '全部 API Key' },
      ...(clientKeys.data ?? []).map((k) => ({ value: k.id, label: k.name })),
    ],
    [clientKeys.data],
  );

  /**
   * `clientId` → **当前显示名**（`spec-v4-client-id.md` §9.2）。
   *
   * 日志行的 `client` 是**写入时的快照**，改名后它仍是旧名 —— 直接渲染会让同一行
   * 出现「表里是旧名、客户端页是新名」的观感误导。所以这里用 `clientId` 去
   * `/api/clients` 映射到最新名；**映射不到（如该客户端已超出窗口）才回落到快照**，
   * 绝不反过来拿快照当正解。
   */
  const clientNameById = useMemo(() => {
    const m = new Map<string, string>();
    (clientKeys.data ?? []).forEach((k) => m.set(k.id, k.name));
    return m;
  }, [clientKeys.data]);
  const currentClientName = (row: { clientId: string; client: string }) =>
    clientNameById.get(row.clientId) ?? row.client;

  /* 「上游访问密钥失效」不是状态码而是 note 标记 —— 后端 `q` 会搜 note 列
     （`requests.service.ts` 的 `r.note LIKE ?`），所以拿它当检索词，无需改后端。 */
  const credentialReason = status === NOTE_CREDENTIAL_INVALID;
  /* 游标的有效范围 = 产生它的那组筛选条件（用**实际发出去的** debouncedQ，而不是输入框里的 q）。
     条件一变，旧游标自动失效 —— 否则防抖窗口内翻页会拿旧条件的游标去查新条件的数据，漏行。 */
  const filterKey = `${limit}|${status}|${clientId}|${debouncedQ}`;
  const query = useMemo(
    () => ({
      page,
      limit,
      cursor: page > 1 && pageCursors.key === filterKey ? pageCursors.map[page] : undefined,
      status: status === 'all' || status === NOTE_CREDENTIAL_INVALID ? undefined : status,
      clientId: clientId === 'all' ? undefined : clientId,
      q: status === NOTE_CREDENTIAL_INVALID ? NOTE_CREDENTIAL_INVALID : debouncedQ || undefined,
    }),
    [page, limit, status, clientId, debouncedQ, pageCursors, filterKey],
  );

  const list = useResource(() => api.requests(query), [
    query.page,
    query.cursor,
    query.limit,
    query.status,
    query.clientId,
    query.q,
  ]);
  /* 抽屉未打开（openId 为 null）时不请求：原先会发出 /api/requests/null，关抽屉时还会再发一次 */
  const detail = useResource(() => api.requestDetail(openId as number), [openId], { enabled: openId !== null });
  useFx(`requests-${list.initial ? 'load' : 'ok'}`);

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  const openDetail = (row: RequestLogRow) => {
    setReasoningOpen(false);
    setOpenId(row.id);
  };

  const resetTo = (fn: () => void) => {
    fn();
    setPage(1);
  };

  /* 翻页：顺序到下一页时记录游标（与 setPage 同批提交，query 一次就带上游标）。
     只在**当前页已加载完、且数据确实是当前页**时才记：快速连点「下一页」时上一页还在加载，
     list.data 仍是更早那页 —— 拿它的 nextCursor 会让第 N+1 页重复显示第 N 页。
     不满足时不记游标，这一页回落页码（OFFSET）取，结果仍然正确。 */
  const goPage = (p: number) => {
    const next = list.data?.nextCursor;
    if (p === page + 1 && next && !list.loading && list.data?.page === page) {
      setPageCursors((c) => ({ key: filterKey, map: { ...(c.key === filterKey ? c.map : {}), [p]: next } }));
    }
    setPage(p);
  };

  /* [v0.2.0 B7] 一键取证：开 = PUT recordRequestBody:true + recordBodyUntil(now+30min)；
     服务端到点自动失效（隐私兜底），前端倒计时只是可视化的提醒与手动关的入口。 */
  const [captureUntil, setCaptureUntil] = useState<number | null>(null);
  const [captureErr, setCaptureErr] = useState<string | null>(null);

  useEffect(() => {
    // 恢复会话内状态：如果取证仍在生效期（如刚在别的页开的），把倒计时接回来
    api
      .settings()
      .then((s) => {
        const logs = s.groups.find((g) => g.id === 'logs')?.items ?? [];
        const on = logs.find((i) => i.key === 'logs.recordRequestBody')?.value === true;
        const until = logs.find((i) => i.key === 'logs.recordBodyUntil')?.value;
        if (on && typeof until === 'number' && until > Date.now()) setCaptureUntil(until);
        else if (on && (until === null || until === undefined)) setCaptureUntil(Number.MAX_SAFE_INTEGER);
      })
      .catch(() => {});
  }, []);

  /* 到点：本地先灭灯，再异步把开关关掉（服务端本来也会过期，双保险） */
  const expireCapture = useCallback(() => {
    setCaptureUntil(null);
    void api.putSettings([{ key: 'logs.recordRequestBody', value: false }]).catch(() => {});
  }, []);

  const toggleCapture = async () => {
    setCaptureErr(null);
    try {
      if (captureUntil !== null) {
        await api.putSettings([
          { key: 'logs.recordRequestBody', value: false },
          { key: 'logs.recordBodyUntil', value: null },
        ]);
        setCaptureUntil(null);
      } else {
        const until = Date.now() + CAPTURE_WINDOW_MS;
        await api.putSettings([
          { key: 'logs.recordRequestBody', value: true },
          { key: 'logs.recordBodyUntil', value: until },
        ]);
        setCaptureUntil(until);
      }
    } catch (err) {
      setCaptureErr(err instanceof ApiError ? err.message : String(err));
    }
  };

  const captureLabel =
    captureUntil === null
      ? '取证 30 分钟'
      : captureUntil === Number.MAX_SAFE_INTEGER
        ? '取证中（不限时）· 点击关闭'
        : <CaptureCountdown until={captureUntil} onExpire={expireCapture} />;

  return (
    <div className="view on">
      <Topbar
        title="请求日志"
        status={list.data ? <Pill tone="live" dot>共 {formatInt(total)} 条</Pill> : null}
        actions={
          <>
            {/* [v0.2.0 B7] 排障入口：免走去设置页开关「记录请求体」。30 分钟自动失效。 */}
            <Tooltip content="开启后，接下来 30 分钟内经本服务转发的请求体会写入本地库（详情页可查看原始请求）。到点自动关闭。">
              <button
                type="button"
                className={`btn btn-sm ${captureUntil === null ? 'btn-quiet' : 'btn-primary'}`}
                onClick={() => void toggleCapture()}
              >
                {captureUntil === null ? <Camera size={14} /> : <CameraOff size={14} />}
                {captureLabel}
              </button>
            </Tooltip>
          </>
        }
      />
      {captureErr ? (
        <div className="view-body stack" style={{ paddingTop: 0 }}>
          <Banner tone="error">取证开关没切成功：{captureErr}</Banner>
        </div>
      ) : null}

      <div className="view-body stack">
        {/* [v0.6.5] 首次加载：整页骨架（筛选条 + 统计卡 + 表格）。
            此前骨架只嵌在「请求流」Panel 内 —— 上方统计卡此时显示一排 0（假数据），
            看起来像"真的没有请求"。现在首屏整体骨架化，出数据后原位替换。 */}
        {list.initial && list.loading ? (
          <RequestsSkeleton />
        ) : (
          <>
        <div className="filters">
          <Select value={status} options={STATUS_OPTIONS} onChange={(v) => resetTo(() => setStatus(v))} />
          <Select
            value={clientId}
            options={clientOptions}
            onChange={(v) => resetTo(() => setClientId(v))}
          />
          <label className="search" style={{ gridColumn: 'span 3' }}>
            <Search size={14} color="var(--text-faint)" aria-hidden />
            {credentialReason ? (
              <Tooltip className="tooltip-fill" content="「上游访问密钥失效」本身就是一个筛选条件；清除它才能再按文本搜索。">
                <input
                  value={q}
                  placeholder="已按「上游访问密钥失效」筛选"
                  disabled
                  onChange={(e) => resetTo(() => setQ(e.target.value))}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: 'var(--text-secondary)',
                    font: 'inherit',
                    fontSize: 12.5,
                  }}
                />
              </Tooltip>
            ) : (
              <input
                value={q}
                placeholder="搜索模型、客户端或标记"
                onChange={(e) => resetTo(() => setQ(e.target.value))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--text-secondary)',
                  font: 'inherit',
                  fontSize: 12.5,
                }}
              />
            )}
          </label>
        </div>

{/* [2026-10-17 评审收尾] 统计条 4→3 格：
           ① 删「上游访问密钥失效」格 —— 停摆级状态已升格为概览顶部横幅
             （alerts.credentialInvalid，单次即报），这格只统计当前页 20 行、
             与其严重性不匹配；「注 token」密码式缩写一并消失（人设红旗）。
           ② 「本页条数」保留 —— 它是「筛选命中 vs 实际可见」的即时对照，
             分页器只显示页码范围，不回应这个对照。 */}
        <StatBar
          items={[
            { label: '当前筛选命中', value: formatInt(total), detail: '当前筛选全部命中' },
            { label: '本页条数', value: formatInt(rows.length), tone: 'live', detail: `每页 ${limit} 条` },
            { label: '当前页异常', value: formatInt(rows.filter((r) => r.status >= 400).length), detail: 'status ≥ 400' },
          ]}
        />

        {/* [2026-10-07] 「读取口径」从**右列**改为常驻在请求流**下方**。
            原来它和请求流并排（`.row2` + 固定 383px），把表格容器压到 685px，
            而那张 8 列表的自然宽是 797px ⇒ 最后一列「标记」被面板右缘裁掉 112px
            （1440px 视口就是这样，只看得见「已补 syst」）。
            把说明卡放到下面之后，表格拿到整幅宽度，问题从"根"上没有了 ——
            不必再靠换行/横向滚动去兜，也不会有"哪一档视口会漏"的边界。 */}
        <Panel
          title="请求流"
          aside={<Pill>{formatPercent(total ? rows.filter((r) => r.status < 400).length / Math.max(1, rows.length) : null, 1)} 本页成功率</Pill>}
          padded={false}
        >
          <div style={{
                padding: '0 20px',
                opacity: list.loading && !list.initial ? 0.55 : 1,
                transition: 'opacity 200ms var(--ease-out)',
                pointerEvents: list.loading && !list.initial ? 'none' : undefined,
              }}>
            {list.error ? (
              <StateBlock kind="error" title="日志没取到" detail={errorDetail(list.error)} onRetry={list.reload} />
            ) : rows.length === 0 ? (
              <StateBlock
                kind="empty"
                title="没有匹配的请求"
                detail="换个状态或清空搜索词试试。如果一条都没有，说明服务还没收到过 /v1/* 请求。"
              />
            ) : (
              <RequestTable
                rows={rows}
                activeId={openId}
                onOpen={openDetail}
                resolveClientName={currentClientName}
                modelTagOf={modelTagOf}
                providerOf={providerOf}
              />
            )}
          </div>
          {rows.length > 0 ? (
            <Pager
              page={page}
              limit={limit}
              total={total}
              onPage={goPage}
              onLimit={(l) => resetTo(() => setLimit(l))}
            />
          ) : null}
        </Panel>
          </>
        )}

        <Panel title="读取口径" aside={<Pill>本地聚合</Pill>}>
          <div className="detail-row">
            <span className="k">异常定义</span>
            <span className="v">status ≥ 400</span>
          </div>
          <div className="detail-row">
            <span className="k">重试计入</span>
            <span className="v">仅首次尝试</span>
          </div>
          <div className="detail-row">
            <span className="k">积分口径</span>
            <span className="v">经转发 · 上游实扣（未回报即未知，不估算）</span>
          </div>
          <div className="footer-note">
            上游访问密钥失效是这套方案唯一会让服务停摆的状态 —— 所有提供商共用同一把上游访问密钥，它一失效即整体不可用。
            {/* [2026-10-09] 指路更正：那页早已改名「提供商管理」，且提供商在其表格里（原写「客户端与密钥」，是旧页名）。 */}
            这类失败在日志里<b>不是</b> 401：状态码是 502，标记为「上游访问密钥失效」。出现时去「提供商管理 → 提供商」的「配置」里换新。
            {/* [v7.0-d] 上面那张卡右上角只写了「注 token」—— 卡片右侧空间放不下 26 个字符的
                token 名（会被截成省略号）。完整 token 在这里给，那里有一整行。 */}
            筛选框选「上游访问密钥失效」即按 note 里的 <code>upstream_credential_invalid</code> 匹配。
          </div>
        </Panel>
      </div>

      {openId !== null ? (
        <Drawer
          title={detail.data ? `请求详情 · ${detail.data.model}` : '请求详情'}
          subtitle={detail.data ? `req_${detail.data.id.toString(16)} · ${currentClientName(detail.data)}` : undefined}
          onClose={() => setOpenId(null)}
        >
          {detail.initial && detail.loading ? (
            <StateBlock kind="loading" title="正在读取详情…" />
          ) : detail.error ? (
            <StateBlock kind="error" title="详情没取到" detail={errorDetail(detail.error)} onRetry={detail.reload} />
          ) : detail.data ? (
            <RequestDetailView
              row={detail.data}
              reasoningOpen={reasoningOpen}
              onToggleReasoning={() => setReasoningOpen((v) => !v)}
              resolveClientName={currentClientName}
              modelTagOf={modelTagOf}
              providerOf={providerOf}
            />
          ) : null}
        </Drawer>
      ) : null}
    </div>
  );
}
// @zbiti-ai:f:344:8993810b
