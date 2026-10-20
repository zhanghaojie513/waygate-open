import { useState } from 'react';
import { Check, Download, Loader2, Plus } from 'lucide-react';
import { api } from '../../services/api';
import { ApiError } from '../../services/http';
import { useResource } from '../../hooks/useResource';
import type { ProviderItem, TimeWindow } from '../../types/api';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';
import { Drawer } from '../ui/Drawer';
import { Modal } from '../ui/Modal';
import { StateBlock, errorDetail } from '../ui/StateBlock';
import { ProviderTable } from './ProviderTable';
import { ClientsSkeleton } from '../ui/PageSkeleton';
import { ImportClientModal } from './ImportClientModal';
import { CustomProviderModal } from './CustomProviderModal';
import { UpstreamModels } from './UpstreamModels';
import type { CatalogMsg } from './UpstreamModels';
import { Tooltip } from '../ui/Tooltip';
import { Banner } from '../ui/Banner';
import { CopyCommand } from '../ui/CopyCommand';
import { useToast } from '../ui/Toast';

/**
 * 提供商面板（2026-10-09 从设置页搬来，随后与用量**合并成一张表**）。
 *
 * ## 为什么合成一张
 * 这个部署是**反代一个客户端订阅** —— 提供商本身就是"某个客户端的订阅"，
 * 所以两者是同一件事的两端。拆成两张表时各只有一行，看着就是重复。
 * 表的结构（提供商行=汇总 + 客户端行=明细）与层级成立条件写在 `ProviderTable.tsx`。
 *
 * ## 明细走抽屉，不占版面
 * ## 明细走抽屉，不占版面
 * 「配置」与「模型列表」各开一个右侧抽屉（复用请求日志那套 `Drawer`）：
 * 表格只留**可比的那几列**，明细按需展开。
 * 提供商**全局策略**（请求头伪装 / system 提示改写）仍留在设置页 —— 它们不属于任何一家。
 */
export function ProvidersPanel({ window }: { window: TimeWindow }) {
  const providers = useResource(() => api.providers(), [], { cacheKey: 'providers' });
  const [viewingModels, setViewingModels] = useState<ProviderItem | null>(null);
  /* [v0.5.4] 按正在查看的提供商拉它自己的分区（各自的清单，不再合并显示）。 */
  const catalogRes = useResource(() => api.catalog(viewingModels?.id), [viewingModels?.id], {
    cacheKey: viewingModels?.id ? `catalog:${viewingModels.id}` : 'catalog',
  });
  /* 提供商用量按本页的时间选择器取 —— 与表格头部的窗口选择器同源。 */
  const clientsRes = useResource(() => api.clients(window), [window], { cacheKey: `clients:${window}` });
  /* [v1.6.12] 「导入客户端」弹窗（选客户端 → 官方授权 → 自动落盘凭证）。
     [v1.6.13] 凭证的唯一入口（ck_ 退役、手填创建下线）；传 provider = 对该行重新导入。 */
  const [importing, setImporting] = useState(false);
  const [reimporting, setReimporting] = useState<ProviderItem | null>(null);
  /* [v1.7.0] 「新增自定义提供商」弹窗（OpenAI 兼容端点 + 静态 API key）。 */
  const [addingCustom, setAddingCustom] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderItem | null>(null);
  const [deleting, setDeleting] = useState<ProviderItem | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [catalogMsg, setCatalogMsg] = useState<CatalogMsg | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  /* 项目级提示：签到/领取的结果浮在页面顶部 —— 表格行里没有安放反馈的位置，
     而用户点完必须立刻知道「成了没有」（用户口径：不能没反馈）。 */
  const toast = useToast();

  const rows = providers.data?.items ?? [];
  const byProvider = clientsRes.data?.byProvider ?? [];

  const reload = () => {
    providers.reload();
    catalogRes.reload();
    clientsRes.reload();
  };

  /** [v0.5.1] 启用提供商：加入出站路由并同步它自己的模型目录。 */
  const activate = async (row: ProviderItem) => {
    setBusyId(row.id);
    setErr(null);
    try {
      await api.activateProvider(row.id);
      setCatalogMsg(null);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    } finally {
      setBusyId(null);
    }
  };

  /** [v0.5.1] 停用提供商：退出出站路由（最后一个生效的服务端会拒）。 */
  const deactivate = async (row: ProviderItem) => {
    setBusyId(row.id);
    setErr(null);
    try {
      await api.deactivateProvider(row.id);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    } finally {
      setBusyId(null);
    }
  };

  /** [v0.5.6] 立即签到（幂等：今天签过服务端原样返回）。 */
  const signin = async (row: ProviderItem) => {
    setBusyId(row.id);
    setErr(null);
    try {
      const res = await api.providerSigninNow(row.id);
      setCatalogMsg({ kind: res.ok ? 'ok' : 'error', text: res.message });
      /* 三种结果分别给话：抢到了 / 今天已签过 / 失败。用 outcome 而不是只看 ok ——
         'none'（今天已签）是成功路径，但说成「签到成功」会让用户以为多领了一次。 */
      if (res.ok) {
        toast.push(res.outcome === 'none'
          ? { tone: 'info', message: `${row.name}：${res.message}` }
          : { tone: 'success', message: `${row.name} 签到成功${res.points ? ` · +${res.points} 积分` : ''}。` });
      } else {
        toast.push({ tone: 'error', message: `${row.name} 签到失败：${res.message}` });
      }
      providers.reload();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(String(e), 0, 0);
      setErr(err);
      /* ⚠️ 异常路径也必须弹 —— 它恰恰是最需要反馈的一类失败（HTTP 非 2xx /
         网络中断 / 上游拒绝）。只 setErr 的话提示落在页内区块，用户点了行内按钮
         根本看不到（本轮实测就是这样漏掉的）。 */
      toast.push({ tone: 'error', message: `${row.name} 签到失败：${err.message || '请求未完成'}` });
    } finally {
      setBusyId(null);
    }
  };

  /** [v1.4.0] 手动跑一轮 WorkBuddy 领取（签到 + 任务 + 兑换；需已导入 OAuth）。 */
  const growthRun = async (row: ProviderItem) => {
    setBusyId(row.id);
    setErr(null);
    try {
      const res = await api.providerGrowthRun(row.id);
      const claimed = res.tasks?.filter((t) => t.outcome === 'claimed').length ?? 0;
      const already = res.tasks?.filter((t) => t.outcome === 'already').length ?? 0;
      const skipped = res.tasks?.filter((t) => t.outcome === 'skipped').length ?? 0;
      const text = res.ok
        ? `领取完成：签到 ${res.signin?.points ?? 0} 积分；任务新领 ${claimed}、已领过 ${already}、待完成 ${skipped}；本轮合计 +${res.creditsGained ?? 0}。`
        : (res.message ?? '领取失败。');
      setCatalogMsg({ kind: res.ok ? 'ok' : 'error', text });
      toast.push(res.ok ? { tone: 'success', message: `${row.name}：${text}` } : { tone: 'error', message: `${row.name} 领取失败：${res.message ?? '未知原因'}` });
      providers.reload();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(String(e), 0, 0);
      setErr(err);
      toast.push({ tone: 'error', message: `${row.name} 领取失败：${err.message || '请求未完成'}` });
    } finally {
      setBusyId(null);
    }
  };

  /** [v1.4.0] 导入 WorkBuddy OAuth 凭证（粘贴导出工具的 JSON；转发不受影响）。 */
  const oauthImport = async (row: ProviderItem) => {
    /* 项目类型环境里 window 被窄化（TimeWindow）；prompt 走显式形状断言。 */
    const pasted = (globalThis as unknown as { prompt?: (a: string, b: string) => string | null }).prompt?.('粘贴 WorkBuddy OAuth 凭证 JSON（tools/wb-oauth-export.mjs 的输出）：', '') ?? null;
    if (!pasted) return;
    let payload: unknown;
    try {
      payload = JSON.parse(pasted);
    } catch {
      setCatalogMsg({ kind: 'error', text: '不是合法 JSON —— 请完整复制导出文件内容。' });
      return;
    }
    setBusyId(row.id);
    setErr(null);
    try {
      const res = await api.providerOauthImport(row.id, payload);
      setCatalogMsg({ kind: res.ok ? 'ok' : 'error', text: res.message });
      providers.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || busyId) return;
    const target = deleting;
    setBusyId(target.id);
    setErr(null);
    try {
      await api.deleteProvider(target.id);
      setDeleting(null);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
      setDeleting(null);
    } finally {
      setBusyId(null);
    }
  };

  /** 「获取模型」：逐个实测（真打上游），结果就贴在抽屉里。 */
  const refreshCatalog = async () => {
    if (catalogBusy) return;
    setCatalogBusy(true);
    setCatalogMsg(null);
    setErr(null);
    try {
      const out = await api.refreshCatalog();
      const multNote =
        out.configPulled === false
          ? ' 倍率未从接口取到，沿用本地快照。'
          : out.multipliersUpdated
            ? ` 倍率已按接口同步（${out.multipliersUpdated} 项有更新）。`
            : '';
      /* [v1.5.3] 刷新是**全库**动作（三家各拉各测），但抽屉只展示当前这一家 ——
         用合计数字（如 52）会让用户以为和抽屉的 35 对不上。取当前家的明细来报。 */
      const mine = out.perProvider?.find((x) => x.id === viewingModels?.id);
      const nChecked = mine?.checked ?? out.checked;
      const nOk = mine?.ok ?? out.ok;
      const nFailed = mine?.failed.length ?? out.failed.length;
      setCatalogMsg(
        nFailed > 0
          ? {
              kind: 'partial',
              text: `已实测 ${nChecked} 个模型：${nOk} 个可用、${nFailed} 个未通过（可能未订阅）。未通过的不会删除，订阅后可再拉一次。${multNote}`,
            }
          : { kind: 'ok', text: `已实测 ${nChecked} 个模型，全部可用。${multNote}` },
      );
      catalogRes.reload();
      /* [v1.4.8] 拉取合并会改变目录（只增不减）——提供商表的模型数量列（modelCount/
         modelEnabled）来自 providers 资源，必须一起刷，否则停在旧值。 */
      providers.reload();
    } catch (e) {
      const er = e instanceof ApiError ? e : new ApiError(String(e), 0, 0);
      setCatalogMsg({ kind: 'error', text: `获取模型失败：${errorDetail(er)}` });
    } finally {
      setCatalogBusy(false);
    }
  };

  const toggleModel = async (id: string, enabled: boolean) => {
    setErr(null);
    try {
      await api.setModelEnabled(id, enabled, viewingModels?.id);
      catalogRes.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    }
  };

  const activeRows = rows.filter((p) => p.active);
  const activeCount = activeRows.length;

  return (
    <>
      {err ? <Banner tone="error">{errorDetail(err)}</Banner> : null}

      {/* 客户端取数失败必须显式报 —— 合并成一张表后，客户端行是表体的一部分，
          静默失败会让"生效提供商下一条客户端都没有"看起来像**真的没有客户端**。
          （这一条是合并带来的新责任：拆表时客户端加载态有自己那块 StateBlock。） */}
      {clientsRes.error ? (
        <Banner
          tone="error"
          actions={
            <button type="button" className="btn btn-quiet btn-sm" onClick={clientsRes.reload}>
              重试
            </button>
          }
        >
          提供商用量没取到：{errorDetail(clientsRes.error)}
        </Banner>
      ) : null}

      <Panel
        title="提供商"
        aside={
          <span className="panel-aside-row">
            {activeCount > 0 ? (
              <Pill tone="live" dot>
                已启用 {activeCount} 家
              </Pill>
            ) : null}
            {/* [v1.6.12] 「导入客户端」——三家统一走官方授权（凭证在客户端登录态里、用户拿不到）。
                [v1.6.13] 这是**唯一的凭证/新建入口**：「新增提供商」手填（含 WorkBuddy 的
                ck_ 密钥）已下线 —— 三家都改用官方授权，行内「配置」也改为「重新导入授权」。 */}
            <Tooltip content="选一个客户端（WorkBuddy / MiniMax Code / Qoder CN），用它的官方授权导入凭证">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setImporting(true)}>
                <Download size={14} />
                导入客户端
              </button>
            </Tooltip>
            {/* [v1.7.0] 「新增自定义」——与左边并列的第二条新建路径：API-key 制端点
                （DeepSeek / OpenRouter / 自建 vLLM…）没有「官方授权」可走，手填就是正路。 */}
            <Tooltip content="添加任意 OpenAI 兼容端点（Base URL + API Key，如 DeepSeek / OpenRouter）">
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAddingCustom(true)}>
                <Plus size={14} />
                新增自定义
              </button>
            </Tooltip>
          </span>
        }
        padded={false}
      >
        {providers.initial && providers.loading ? (
          /* [v0.6.5] 首次加载：与最终布局同形状的骨架（提供商表 + 嵌套客户端明细行）——
             此前是文字卡「正在读取提供商…」，出数据时整块弹出、视觉跳变大。 */
          <div style={{ padding: '0 20px 18px' }}>
            <ClientsSkeleton />
          </div>
        ) : providers.error ? (
          <div style={{ padding: '0 20px 18px' }}>
            <StateBlock
              kind="error"
              title="提供商列表没取到"
              detail={errorDetail(providers.error)}
              onRetry={providers.reload}
            />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '0 20px 18px' }}>
            <StateBlock kind="empty" title="还没有任何提供商" detail="先登记一个上游，再按需启用它的出站路由。" />
          </div>
        ) : (
          <ProviderTable
            rows={rows}

            byProvider={byProvider}
            busyId={busyId}
            onEdit={setEditing}
            onSignin={(p) => void signin(p)}
            onGrowthRun={(p) => void growthRun(p)}
            onOauthImport={(p) => void oauthImport(p)}
            onModels={(p) => {
              setCatalogMsg(null);
              setViewingModels(p);
            }}
            onActivate={(p) => void activate(p)}
            onDeactivate={(p) => void deactivate(p)}
            onDelete={setDeleting}
          />
        )}
        <div className="footer-note" style={{ padding: '0 20px 18px' }}>
          启用提供商会让它加入出站路由，并同步它自己的模型清单；已启用的提供商可以并行生效，模型按各自目录路由。
          三家凭证都来自各客户端的<b>官方授权</b>（用户无需也无法手填）——点「重新导入授权」即可换账号或刷新令牌；
          令牌只存在服务端，任何接口都读不回完整值。
          <br />
          {'行内三列用量按'}<b>提供商</b>{'归属：请求日志自 v1.6.30 起逐行记录实际路由的提供商（provider_id 事实列），统计与之一致；模型不属于任何生效目录的行归到「未归属」，不冒充某一家。'}
        </div>
      </Panel>

      {/* [v1.6.12] 导入客户端：选客户端 → 官方授权 → 自动落盘凭证。
          [v1.6.13] 唯一的新建/凭证入口（手填「新增提供商」已下线）。 */}
      {importing ? (
        <ImportClientModal
          onClose={() => {
            setImporting(false);
            reload();
          }}
          onImported={() => reload()}
        />
      ) : null}

      {/* [v1.7.0] 新增自定义提供商：OpenAI 兼容端点 + 静态 API key（与「导入客户端」并列的第二条路径）。 */}
      {addingCustom ? (
        <CustomProviderModal
          onClose={() => {
            setAddingCustom(false);
            reload();
          }}
          onCreated={() => reload()}
        />
      ) : null}

      {/* [v1.6.13] 行内「重新导入授权」：对该提供商重新走一次官方授权。 */}
      {reimporting ? (
        <ImportClientModal
          provider={{ id: reimporting.id, name: reimporting.name, protocol: reimporting.protocol }}
          onClose={() => {
            setReimporting(null);
            reload();
          }}
          onImported={() => reload()}
        />
      ) : null}

      {editing ? (
        <EditProviderDrawer
          provider={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onReimport={() => {
            const p = editing;
            setEditing(null);
            if (p) setReimporting(p);
          }}
        />
      ) : null}

      {viewingModels ? (
        <Drawer
          title={`模型列表 · ${viewingModels.name}`}
          subtitle={viewingModels.baseUrl}
          onClose={() => setViewingModels(null)}
        >
          <div className="drawer-body">
            <UpstreamModels
              catalog={catalogRes.data}
              catalogLoading={catalogBusy}
              catalogMsg={catalogMsg}
              catalogError={catalogRes.error}
              onCatalogRefresh={() => void refreshCatalog()}
              onCatalogReload={catalogRes.reload}
              onModelToggled={toggleModel}
              /* [v1.7.0] 手动补模型只给 custom 家 —— 内置三家清单以上游接口为准。 */
              manualAdd={
                viewingModels.protocol === 'custom'
                  ? { providerId: viewingModels.id, onAdded: catalogRes.reload }
                  : null
              }
            />
          </div>
        </Drawer>
      ) : null}

      {deleting ? (
        <Modal
          title="删除这个提供商？"
          onClose={() => {
            if (!busyId) setDeleting(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={Boolean(busyId)}
                onClick={() => setDeleting(null)}
              >
                取消（保留）
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={Boolean(busyId)}
                onClick={() => void confirmDelete()}
              >
                {busyId ? <Loader2 size={14} className="spin" /> : null}
                {busyId ? '删除中…' : '确认删除'}
              </button>
            </>
          }
        >
          <div className="ov-lose">
            <b>会失去什么：</b>
            提供商「{deleting.name}」（{deleting.baseUrl}）的登记与它的凭证文件一并删除，
            需要重新登记并填一次 ck_ 密钥。此操作不可撤销。
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * 「配置」抽屉 —— 只改**名称与地址**；凭证一律走「重新导入授权」（三家统一）。
 *
 * [v1.6.13] 为什么这里没有任何凭证输入：三家凭证都来自各客户端的**官方授权**
 *   （WorkBuddy OAuth / MiniMax 登录态 refresh token / Qoder 身份 JSON），
 *   用户拿不到、也手敲不出来。给输入框等于让他填一个无从获取的值。
 *   点「重新导入授权」走官方授权通道（`ImportClientModal`）。
 *
 * 试通语义（与 `POST /api/providers/:id/test` 同源）：测**已导入**的凭证是否还通。
 */
function EditProviderDrawer({
  provider,
  onClose,
  onSaved,
  onReimport,
}: {
  provider: ProviderItem;
  onClose: () => void;
  onSaved: () => void;
  /** [v1.6.13] 打开「重新导入授权」（由父组件挂出 ImportClientModal）。 */
  onReimport: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  /* [v1.7.0] custom 家的换 key 输入（API-key 制：换 key = 重新填一次，没有授权通道）。 */
  /* [v1.6.5] 自动导入（服务端跑项目脚本读客户端登录态）的状态与结果。 */
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<
    { kind: 'ok' | 'unavailable' | 'error'; text: string; command?: string } | null
  >(null);

  /** [v1.6.5] 点「从本机客户端读取」：服务端跑 tools/ 里的脚本读客户端登录态。
   *  同机部署 → 真·一键；分离部署 → 返回 unavailable，降级给出推送命令。 */
  const autoImport = async () => {
    if (importing) return;
    setImporting(true);
    setImportMsg(null);
    setErr(null);
    try {
      const r = await api.providerImportLocal(provider.id);
      if (r.ok) {
        setImportMsg({ kind: 'ok', text: r.message + (r.detail ? `
${r.detail}` : '') });
        onSaved();
      } else if (r.outcome === 'unavailable') {
        setImportMsg({
          kind: 'unavailable',
          text: r.message,
          ...(provider.protocol !== 'openai' && provider.protocol !== 'custom'
            ? {
                command: `node tools/import-credential-push.mjs ${location.origin} ${
                  provider.protocol === 'qoder' ? 'qoder' : 'minimax'
                } --provider ${provider.id}`,
              }
            : {}),
        });
      } else {
        setImportMsg({ kind: 'error', text: r.message + (r.detail ? `
${r.detail}` : '') });
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    } finally {
      setImporting(false);
    }
  };

  const [newKey, setNewKey] = useState('');
  const [chatPath, setChatPath] = useState(provider.chatPath ?? '');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    model: string;
    elapsedMs: number;
    upstreamCode: number | null;
    httpStatus: number | null;
    reason: string | null;
  } | null>(null);
  const isCustom = provider.protocol === 'custom';

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const input: { name?: string; baseUrl?: string; credential?: string; chatPath?: string | null } = {};
      if (name.trim() !== provider.name) input.name = name.trim();
      if (baseUrl.trim() !== provider.baseUrl) input.baseUrl = baseUrl.trim();
      if (isCustom) {
        if (newKey.trim()) input.credential = newKey.trim();
        const nextPath = chatPath.trim() || null;
        if (nextPath !== provider.chatPath) input.chatPath = nextPath;
      }
      if (Object.keys(input).length > 0) await api.patchProvider(provider.id, input);
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2 : new ApiError(String(e2), 0, 0));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setErr(null);
    setTestResult(null);
    try {
      /* [v1.6.13] 不再传草稿凭证（ck_ 退役、三家都不手填）—— 测的就是已导入的授权。 */
      setTestResult(await api.testProvider(provider.id, undefined));
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Drawer title={`配置提供商 · ${provider.name}`} subtitle={provider.baseUrl} onClose={onClose}>
      <div className="drawer-body">
        {err ? <Banner tone="error">{errorDetail(err)}</Banner> : null}

        <form onSubmit={(e) => void save(e)} className="prov-edit" style={{ marginTop: 6 }}>
          <div className="up-row">
            <div className="up-lab">名称</div>
            <input
              className="field-input text"
              style={{ width: '100%' }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="提供商名称"
            />
          </div>
          <div className="up-row">
            <div className="up-lab">地址</div>
            <input
              className="field-input text"
              style={{ width: '100%' }}
              value={baseUrl}
              placeholder="https://api.example.com"
              onChange={(e) => setBaseUrl(e.target.value)}
              aria-label="提供商地址"
            />
          </div>
          <div className="up-row">
            <div className="up-lab">凭证</div>
            {/* [v1.6.13] 三家统一：凭证来自各客户端的**官方授权**，用户拿不到、也手敲不出来
                （WorkBuddy 的 ck_ 密钥已退役）。故这里不给任何输入框，只给一个授权入口。
                [v1.6.15] 「从本机客户端读取」已下线（用户口径）：它读的是**relay 服务端
                所在机器**的客户端登录态 —— 线上 relay 在服务器、客户端在你本机，永远读不到，
                只会在界面上给一句无用的「读不到」。那个能力只对「同机部署」有意义
                （开源版本地启动形态），故仅在那里保留。
                [v1.7.0] custom 是例外：API-key 制端点的 key 就在用户手上，「重新填」就是
                它的换凭证形态 —— 给输入框，不给授权按钮。 */}
            {isCustom ? (
              <div className="cred-guide">
                <div className="cred-guide-note">
                  当前：<b>{provider.configured ? provider.credentialMask : '未配置'}</b>。
                  换 key（或过期）时填新的，保存即生效；测试按钮测的是<b>已保存</b>的那把。
                </div>
                <input
                  className="field-input text"
                  style={{ width: '100%', marginTop: 8 }}
                  type="password"
                  value={newKey}
                  placeholder="留空 = 不改；新 API Key（8 位以上）"
                  onChange={(e) => setNewKey(e.target.value)}
                  aria-label="新 API Key"
                />
              </div>
            ) : (
              <div className="cred-guide">
                <div className="cred-guide-note">
                  {provider.protocol === 'openai' ? (
                    <>凭证来自 WorkBuddy <b>官方 OAuth 授权</b>（桌面端 / 插件同一条通道），无需手填。</>
                  ) : provider.protocol === 'anthropic' ? (
                    <>
                      凭证是客户端登录态里的 <span className="code-chip">mmort_…</span> refresh token。
                      请用<b>专用账号</b>（与桌面端共用会互相顶下线）。
                    </>
                  ) : (
                    <>凭证来自 Qoder 客户端登录态（一段<b>身份 JSON</b>）。桌面客户端与它<b>互不影响</b>。</>
                  )}
                </div>
                <div className="cred-guide-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => onReimport()}
                  >
                    <Download size={14} />
                    重新导入授权
                  </button>
                  {/* [v1.6.28] 「从本机客户端读取」只对 **有本机登录态文件** 的两家有意义：
                      MiniMax（~/.minimax/auth/.../auth.json）、Qoder（auth.v1.dat）。
                      WorkBuddy 走 OAuth、custom 是手填 key —— 本机都没有可读文件，
                      显示这个按钮只会给出一条永远走不通的误导提示。 */}
                  {provider.protocol === 'openai' || provider.protocol === 'custom' ? null : (
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      disabled={importing}
                      onClick={() => void autoImport()}
                    >
                      {importing ? <Loader2 size={14} /> : <Download size={14} />}
                      从本机客户端读取
                    </button>
                  )}
                </div>
                {/* [v1.6.5] 自动导入的结果 / 降级提示（分离部署时给推送命令） */}
                {importMsg ? (
                  <Banner tone={importMsg.kind === 'ok' ? 'success' : importMsg.kind === 'unavailable' ? 'warn' : 'error'}>
                    <span>
                      {importMsg.text}
                      {importMsg.command ? (
                        <>
                          <br />
                          在<b>装了客户端的那台机器</b>的仓库目录下跑：
                          <CopyCommand command={importMsg.command} />
                        </>
                      ) : null}
                    </span>
                  </Banner>
                ) : null}
                {provider.protocol === 'qoder' ? (
                  <div className="cred-guide-note">
                    本服务<b>不自动刷新</b> Qoder 令牌；过期后重跑一次导入即可。
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {isCustom ? (
            <div className="up-row">
              <div className="up-lab">API 路径</div>
              <input
                className="field-input text"
                style={{ width: '100%' }}
                value={chatPath}
                placeholder="留空 = 智能默认（无版本段拼 /v1/chat/completions；以 /vN 结尾只拼 /chat/completions）"
                onChange={(e) => setChatPath(e.target.value)}
                aria-label="API 路径覆盖"
              />
            </div>
          ) : null}
          <div className="up-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? <Loader2 size={14} /> : <Check size={14} />}
              保存
            </button>
            <Tooltip content="用已导入的授权测这家上游是否还通">
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                disabled={testing}
                onClick={() => void runTest()}
              >
                {testing ? <Loader2 size={14} /> : null}
                测试
              </button>
            </Tooltip>
          </div>
        </form>

        {/* 试通结果：通 / 连上了但被拒（key 坏或没订阅）/ 网络都没到 —— 三种都要能读。 */}
        {testResult ? (
          <Banner tone={testResult.ok ? 'success' : 'warn'}>
            <span>
              {testResult.ok ? (
                <>通了：{provider.name} 接受了这次 1 token 探测（{testResult.elapsedMs}ms）。</>
              ) : testResult.httpStatus === null ? (
                <>没连上（网络层）：{testResult.reason ?? '未知原因'}。先查地址与出网，再看凭证。</>
              ) : (
                <>
                  连上了但被拒（HTTP {testResult.httpStatus}
                  {testResult.upstreamCode !== null ? ` · 业务码 ${testResult.upstreamCode}` : ''}）。
                  {testResult.upstreamCode === 11102
                    ? '业务码 11102 = 账号没订阅这个模型。key 可能是好的，换个模型再测或直接切换。'
                    : '通常是凭证问题；换一把再测。'}
                </>
              )}
            </span>
          </Banner>
        ) : null}

        <div className="up-note" style={{ marginTop: 18 }}>
          <span>凭证只存在<b>服务端</b>：界面只显示账号摘要或掩码，任何接口都读不回完整值。</span>
        </div>
      </div>
    </Drawer>
  );
}
