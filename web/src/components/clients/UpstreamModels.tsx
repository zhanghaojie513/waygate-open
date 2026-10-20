import { useState } from 'react';
import { CheckCircle2, Loader2, Plus, RefreshCw, XCircle } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { api } from '../../services/api';
import type { CatalogData, CatalogModel } from '../../types/api';
import { ApiError } from '../../services/http';
import { StateBlock, errorDetail } from '../ui/StateBlock';
import { Switch } from '../ui/Switch';
import { Tooltip } from '../ui/Tooltip';

/** 模型清单操作反馈（「获取模型」的进行中 / 结果）。 */
export interface CatalogMsg {
  kind: 'ok' | 'partial' | 'error';
  text: string;
}

/** 模型来源 → 界面小标签。分清「上游刚给的」和「本地表里留了很久的」。 */
export const SOURCE_LABEL: Record<CatalogModel['source'], string> = {
  upstream: '上游',
  seed: '种子',

  manual: '手工',
};

export const SOURCE_TITLE: Record<CatalogModel['source'], string> = {
  upstream: '从上游模型目录拉取到的',
  seed: '来自本地种子清单（上游拉取失败时的回落）',

  manual: '人工添加的',
};

/**
 * **已启用提供商**的模型清单（原为「提供商」卡的右列，2026-10-09 起装进「模型列表」抽屉）。
 *
 * 每家提供商维护自己的目录分区；启用一家会同步它自己的目录，不覆盖其它提供商。
 */
export function UpstreamModels({
  catalog,
  catalogLoading,
  catalogMsg,
  catalogError,
  onCatalogRefresh,
  onCatalogReload,
  onModelToggled,
  manualAdd,
}: {
  catalog: CatalogData | null;
  catalogLoading: boolean;
  catalogMsg: CatalogMsg | null;
  catalogError: ApiError | null;
  onCatalogRefresh: () => void;
  onCatalogReload: () => void;
  onModelToggled: (id: string, enabled: boolean) => Promise<void>;
  /** [v1.7.0] 手动补模型（仅 custom 提供商传入）：端点没有 /v1/models 时的唯一途径。 */
  manualAdd?: { providerId: string; onAdded: () => void } | null;
}) {
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [manualId, setManualId] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualErr, setManualErr] = useState<ApiError | null>(null);

  const addManual = async () => {
    if (!manualAdd || manualBusy || !manualId.trim()) return;
    setManualBusy(true);
    setManualErr(null);
    try {
      const r = await api.addManualModel(manualAdd.providerId, { id: manualId.trim() });
      setManualId('');
      /* added=false（已存在）不算错 —— 幂等，静默收起即可。 */
      if (r.added) manualAdd.onAdded();
    } catch (e) {
      setManualErr(e instanceof ApiError ? e : new ApiError(String(e), 0, 0));
    } finally {
      setManualBusy(false);
    }
  };

  const toggleModel = async (m: CatalogModel) => {
    setPendingModel(m.id);
    try {
      await onModelToggled(m.id, !m.enabled);
    } finally {
      setPendingModel(null);
    }
  };

  return (
    <div className="up-col">
      <div className="up-models-head">
        <div>
          <b>可用模型</b>
          <span>
            {catalog
              ? `${catalog.models.length} 个 · ${catalog.models.filter((m) => m.enabled).length} 个已启用`
              : '尚未获取'}
          </span>
        </div>
        <div className="up-models-actions">
          {catalogLoading ? (
            <button type="button" className="btn btn-quiet btn-sm" disabled>
              <Loader2 size={14} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
              正在实测模型…
            </button>
          ) : (
            <button type="button" className="btn btn-quiet btn-sm" onClick={onCatalogRefresh}>
              <RefreshCw size={14} />
              获取模型
            </button>
          )}
        </div>
      </div>

      {/* [task#54] 进行中 / 结果的反馈就贴在按钮下方 —— 用户点完按钮视线不用移动。 */}
      {catalogLoading ? (
        <div className="up-progress" role="status">
          <Loader2 size={14} className="spin" style={{ animation: 'spin 1s linear infinite' }} aria-hidden />
          <span>
            正在逐个实测模型（每个 1 token）…这一步会真打上游，<b>可能要几十秒</b>，请不要关掉页面；
            完成后结果会出现在这里，模型清单也会自动刷新。
          </span>
        </div>
      ) : null}

      {catalogMsg ? (
        <Banner tone={catalogMsg.kind === 'error' ? 'error' : catalogMsg.kind === 'partial' ? 'warn' : 'success'}>
          {catalogMsg.text}
        </Banner>
      ) : null}

      {/* [v1.7.0] 手动补模型（custom 专属）：端点没有 /v1/models（部分兼容服务器）时，
          手填模型 id 是唯一途径。manual 行不会被「获取模型」的替换式同步冲掉。 */}
      {manualAdd ? (
        <div className="up-manual-add" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <input
            className="field-input text"
            style={{ flex: 1 }}
            value={manualId}
            placeholder="手动补模型：填模型 ID（如 deepseek-chat），回车或点添加"
            onChange={(e) => setManualId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addManual();
              }
            }}
            aria-label="手动添加模型 ID"
          />
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            disabled={manualBusy || !manualId.trim()}
            onClick={() => void addManual()}
          >
            {manualBusy ? <Loader2 size={14} /> : <Plus size={14} />}
            添加
          </button>
        </div>
      ) : null}
      {manualErr ? (
        <Banner tone="error" >
          {errorDetail(manualErr)}
        </Banner>
      ) : null}

      {catalogError ? (
        <StateBlock kind="error" title="模型清单没拉到" detail={errorDetail(catalogError)} onRetry={onCatalogReload} />
      ) : catalogLoading && !catalog ? (
        <StateBlock kind="loading" title="正在向上游获取模型…" />
      ) : !catalog || catalog.models.length === 0 ? (
        <StateBlock
          kind="empty"
          title="还没有模型清单"
          detail="启用提供商后会自动同步一次它自己的模型清单；这里也可以手动点「获取模型」逐项实测是否真的能调通。"
        />
      ) : (
        <div className="up-models">
          {catalog.models.map((m) => (
            <div className={`up-model${m.enabled ? '' : ' off'}`} key={m.id}>
              <div className="um-info">
                <b>
                  {/* 「模型名：/模型ID：」标签用弱色 —— 名字与 ID 本身才是主角，
                      标签只负责让两行一眼可分辨。 */}
                  <span className="um-k">模型名：</span>
                  {m.displayName}
                  {/* 类名用 src- 前缀：裸的 m.source 值 "upstream" 会撞上请求详情弹窗
                      「上游响应」代码块的 .upstream 全局类（mono 字体 + pre-wrap），
                      等宽字体基线与 sans 不同，chip 会整体下沉 —— 就是标签不对齐的根因。 */}
                  <Tooltip content={SOURCE_TITLE[m.source]}>
                    <span className={`um-src src-${m.source}`}>{SOURCE_LABEL[m.source]}</span>
                  </Tooltip>
                  {/* 计价标签（夜间折扣/限时免费等）：与用量明细、请求日志同源同款式（.mu-tag）。
                      目录同步时跟随上游 badge，为空不渲染 —— 不占位。 */}
                  {m.tag ? (
                    <Tooltip content="上游计价标签，随目录同步更新">
                      <span className="mu-tag">{m.tag}</span>
                    </Tooltip>
                  ) : null}
                </b>
                <i className="code-chip"><span className="um-k">模型ID：</span>{m.id}</i>
              </div>
              <div className="um-meta">
                {m.verified ? (
                  <Tooltip content="实测可调通">
                    <span className="um-ok">
                      <CheckCircle2 size={12} />
                      可用
                    </span>
                  </Tooltip>
                ) : (
                  <Tooltip content="实测未通过（可能未订阅）">
                    <span className="um-bad">
                      <XCircle size={12} />
                      未通过
                    </span>
                  </Tooltip>
                )}
                {m.multiplier == null ? (
                  /* 不许留空、更不许显示 1.0 —— 那是把一个估算伪装成事实。
                     /v3/config 与本地快照都没有这一项时，倍率就是**未知**。
                     用 `==` 而非 `===`：键缺失（undefined）同样必须落进「未知」这一支。 */
                  <Tooltip content="接口与本地快照都没有该模型的倍率 —— 不编造">
                    <span className="um-mult unknown">倍率未知</span>
                  </Tooltip>
                ) : (
                  <Tooltip
                    content={
                      m.source === 'upstream'
                        ? '倍率取自上游 /v3/config 接口实时值，随目录刷新与每日同步更新。'
                        : '接口未覆盖该模型，倍率为内置快照，可能随官方调价过期。'
                    }
                  >
                    <span className="um-mult">×{m.multiplier}</span>
                  </Tooltip>
                )}
                <Switch
                  checked={m.enabled}
                  disabled={pendingModel === m.id}
                  label={`${m.enabled ? '停用' : '启用'} ${m.displayName}`}
                  onChange={() => void toggleModel(m)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="up-foot">
        实测会真打上游、消耗少量积分（每模型 1 token）。上游不接受的模型会标「未通过」，
        但<b>不删除</b> —— 订阅以后可能又开，随时可以再拉一次。
        倍率以 /v3/config 接口实时值为准（目录刷新与每日自动同步都会更新），
        接口未覆盖的模型回落内置快照。
        <br />
        启用提供商时会同步这家自己的清单；已有提供商的目录互不覆盖，启用/停用选择也分别保留。
      </div>
    </div>
  );
}
