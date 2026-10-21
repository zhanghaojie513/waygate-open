import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import type { ProviderImpact } from '../../types/api';
import { formatInt } from '../../lib/format';

/**
 * 提供商**影响面**区块（v1.7.1）—— 「动这家会碰到谁」。
 *
 * 删除弹窗与配置抽屉共用。四段按依赖强度递减排列：
 *   ① 绑定的密钥（停用/删除后它们会失去首选提供商 → 换到别家或报 403）
 *   ② 模型范围点名这家的模型（**可能**受影响 —— 不是独家，界面上不能说得比事实更硬）
 *   ③ 过去 N 小时的流量（provider_id 事实列；无归属老行不计）
 *   ④ 不可逆清单（分协议，由服务端生成，前端不自己编）
 *
 * 为什么会话要异步拉：影响面是联查（密钥 × 目录 × 请求），比列表重；且删除弹窗
 * 打开时才需要它，不该拖慢提供商列表。
 */
export function ProviderImpactBlock({
  providerId,
  hours = 24,
  compact = false,
}: {
  providerId: string;
  hours?: number;
  /** 紧凑模式（删除弹窗里用）：只留计数与不可逆清单，省略逐条明细。 */
  compact?: boolean;
}) {
  const [data, setData] = useState<ProviderImpact | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(null);
    api
      .providerImpact(providerId, hours)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e: unknown) => {
        /* 影响面拉不到**不该挡住删除** —— 它只是辅助信息。如实说"没取到"，不假装是空的。 */
        if (alive) setErr(e instanceof Error ? e.message : '影响面没取到');
      });
    return () => {
      alive = false;
    };
  }, [providerId, hours]);

  if (err) {
    return (
      <div className="impact-block">
        <div className="impact-note">
          影响面没取到（{err}）—— 下面的数字可能不全，删除前请自行确认谁在用这家。
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="impact-block">
        <div className="impact-note">正在统计影响面…</div>
      </div>
    );
  }

  const { boundKeys, scopedKeys, recent, irreversible } = data;
  const noDependency = boundKeys.length === 0 && scopedKeys.length === 0 && recent.requests === 0;

  return (
    <div className="impact-block">
      {/* compact（删除弹窗）里标题由外层「会失去什么」承担，这行只留数字。 */}
      <div className="impact-head">
        {compact ? null : <b>影响面</b>}
        <span className="impact-sub">
          {`${data.modelCount} 个模型（${data.modelEnabled} 启用）· ${boundKeys.length} 个密钥绑定 · ${scopedKeys.length} 个范围点名 · 近 ${hours}h ${formatInt(recent.requests)} 条请求`}
        </span>
      </div>

      {noDependency ? (
        <div className="impact-note impact-ok">
          目前没有密钥依赖它，近 {hours} 小时也没有流量 —— 停用或删除不会立刻影响任何调用方。
        </div>
      ) : null}

      {!compact && boundKeys.length > 0 ? (
        <div className="impact-group">
          <div className="impact-label">绑定的密钥（删除后这些密钥会失去这家作为候选）</div>
          <ul className="impact-list">
            {boundKeys.map((k) => (
              <li key={k.id}>
                <span className="mono">{k.keyHint}</span> {k.name}
                {k.rank === 0 ? <span className="impact-tag">首选</span> : null}
                {k.legacyByName ? (
                  <span className="impact-tag impact-tag-warn" title="这条绑定存的是提供商名字（旧数据），不是 id">
                    按名绑定
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!compact && scopedKeys.length > 0 ? (
        <div className="impact-group">
          <div className="impact-label">模型范围点名了这家的模型（可能受影响，不一定是独家）</div>
          <ul className="impact-list">
            {scopedKeys.map((k) => (
              <li key={k.id}>
                <span className="mono">{k.name}</span>：{k.modelIds.join('、')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {irreversible.length > 0 ? (
        <div className="impact-group">
          <div className="impact-label">删除会失去</div>
          <ul className="impact-list impact-lose">
            {irreversible.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="impact-note">
            删除前会自动留档（行 + 模型 + 偏好 + 凭证文件原文）到 <span className="mono">backup/</span>，
            最近 20 份保留。留档含凭证原文，属敏感文件（0600）。
          </div>
        </div>
      ) : null}
    </div>
  );
}
