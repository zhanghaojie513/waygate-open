/**
 * 页面骨架（v0.4.25 用户要求：首次加载不突兀）—— 用与最终布局**同形状**的
 * 占位块代替「正在加载…」文字卡，数据到达后骨架原位替换为真实内容。
 *
 * 为什么不用 Spinner / 文字卡：出数据时整页突然弹出来，视觉跳变大。
 * 骨架的形状与最终布局一致，用户视线不需要重新定位。
 *
 * 用的是已有的 `.skeleton` 类（app.css，带 shimmer 扫光动画）。
 * 每个变体对应一个页面的真实区块结构——改页面布局时同步改这里。
 * [v0.5.17] 概览/用量两页对齐当前布局：概览补「积分账本 + 客户端/模型摘要」
 * （替换掉早已下线的「最近请求」块）；用量补「按提供商条形 + 数据来源卡」，
 * 统计条格与趋势头部也对齐现结构（副注行 / 口径切换 seg + 单位 pill）。
 */

/** 通用骨架条（宽 × 高，可选圆角档） */
function Bar({ w, h = 14, r = 'sm' }: { w: string | number; h?: number; r?: 'sm' | 'md' | 'lg' | 'pill' }) {
  return <div className="skeleton" style={{ width: typeof w === 'number' ? `${w}px` : w, height: `${h}px`, borderRadius: `var(--radius-${r})` }} />;
}

/** 通用骨架卡（有内边距的区块壳） */
function Card({ children, h }: { children: React.ReactNode; h?: number }) {
  return (
    <div className="card panel" style={h ? { minHeight: `${h}px` } : undefined}>
      {children}
    </div>
  );
}

/* [v9] BannerSkeleton 已删 —— 概览横幅撤出页面后无使用者。 */

/** 表格面板骨架：panel-head（标题 + 右上 pill）+ 表头 + N 数据行 + 可选底注。
 *  `head` 每项是该列的骨架宽（末列若是「分布」占比条，传 'track' 占位）。
 *  数据行宽度带 row 间抖动，避免一整列等宽像栅格。 */
function TablePanelSkeleton({
  head,
  rows,
  footer,
}: {
  head: Array<number | 'track'>;
  rows: number;
  footer?: boolean;
}) {
  return (
    <div className="card panel">
      <div className="panel-head">
        <Bar w={100} h={15} />
        <Bar w={132} h={20} r='pill' />
      </div>
      <div style={{ padding: '0 20px 14px' }}>
        <div style={{ display: 'flex', gap: 18, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
          {head.map((w, i) =>
            w === 'track' ? (
              <div key={i} style={{ flex: 1 }} />
            ) : (
              <Bar key={i} w={w} h={10} />
            ),
          )}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div
            key={r}
            style={{ display: 'flex', gap: 18, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}
          >
            {head.map((w, i) =>
              w === 'track' ? (
                /* 「分布」列：占位条轨道 */
                <div key={i} style={{ flex: 1 }}>
                  <div className="skeleton" style={{ width: `${28 + Math.abs(Math.sin(r * 1.7 + i)) * 55}%`, height: 8, borderRadius: 'var(--radius-pill)' }} />
                </div>
              ) : (
                <Bar key={i} w={w + (r % 3) * 10} h={11} />
              ),
            )}
          </div>
        ))}
        {footer ? (
          <div style={{ marginTop: 12 }}>
            <Bar w='68%' h={10} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 概览页骨架：[v9] 与当前结构同形 —— 四卡 → 活跃度 → 折线 → 两张摘要表。
 *
 *  [v9] 相对上一版的三处修正（页面已变、骨架没跟上，加载完成会连跳三次）：
 *    ① 撤掉 BannerSkeleton —— 概览的横幅（CreditBanner）已删；
 *    ② 撤掉「积分账本」表 —— v0.5.7 时代就移出了概览；
 *    ③ 补上「活跃度」与「token 消耗折线」两个新面板。
 *  热力图的占位用一格阵纹理（.ah-skel-grid，两层正交的 repeating-gradient），
 *  不逐格渲染 91 个 div —— 骨架只承诺形状，不承诺格数。
 */
export function OverviewSkeleton() {
  return (
    <div className="view-body stack">
      <KpiRowSkeleton count={4} />

      {/* 活跃度：面板头 + 格阵 + 统计行 */}
      <div className="card panel">
        <div className="panel-head">
          <Bar w={72} h={15} />
          <Bar w={132} h={20} r='pill' />
        </div>
        <div style={{ padding: '6px 20px 0' }}>
          <div className="ah-skel-grid" />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--border-subtle)' }}>
            <Bar w={220} h={11} />
            <Bar w={120} h={11} />
          </div>
        </div>
      </div>

      {/* token 消耗折线：面板头 + 图区（与图表同高 168）+ 脚注 */}
      <div className="card panel">
        <div className="panel-head">
          <Bar w={110} h={15} />
          <Bar w={90} h={20} r='pill' />
        </div>
        <div style={{ padding: '4px 20px 8px' }}>
          <div className="skeleton" style={{ width: '100%', height: 168, borderRadius: 'var(--radius-md)' }} />
          <Bar w={280} h={10} />
        </div>
      </div>

      {/* 提供商用量摘要（6 列 × 6 行，末列分布条） */}
      <TablePanelSkeleton head={[110, 72, 88, 76, 56, 'track']} rows={6} />

      {/* 模型用量摘要（6 列 × 8 行，末列分布条 + 底注） */}
      <TablePanelSkeleton head={[150, 72, 88, 76, 56, 'track']} rows={8} footer />
    </div>
  );
}

/** 用量页骨架：[v6] 三张卡 → 读数行 → 口径脚注 → 趋势图 → 明细。
 *
 *  必须跟最终结构同形状 —— 此前是「横幅 + 4 格统计条」，
 *  而页面已经改成「3 张卡 + 读数带」，加载完成时会整块跳一次。
 *  这里复用 KpiRowSkeleton(3) 与 .substats 的排版，
 *  脚注也给一行灰条（它是常驻内容，不是加载态才有的）。 */
export function UsageSkeleton() {
  return (
    <div className="view-body stack">
      <KpiRowSkeleton count={3} />

      {/* 读数行：日均 / 可用天数 —— 与 .substats 同排版 */}
      <div className="substats">
        {[0, 1].map((i) => (
          <span className="ss-cell" key={i}>
            <Bar w={64} h={11} />
            <Bar w={44} h={15} />
          </span>
        ))}
      </div>

      {/* 口径脚注（两行灰字） */}
      <div style={{ marginBottom: 22 }}>
        <Bar w='88%' h={10} />
        <div style={{ marginTop: 6 }}><Bar w='64%' h={10} /></div>
      </div>

      {/* 趋势图（标题 + 右侧口径切换 seg + 单位 pill；柱区 30 根） */}
      <div className="card panel">
        <div className="panel-head">
          <Bar w={86} h={15} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <div className="skeleton" style={{ width: 104, height: 26, borderRadius: 8 }} />
            <Bar w={132} h={20} r='pill' />
          </span>
        </div>
        <div style={{ padding: '0 20px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 240 }}>
            {Array.from({ length: 30 }, (_, i) => {
              const h = 20 + Math.abs(Math.sin(i * 0.7)) * 70;
              return <div key={i} className="skeleton" style={{ flex: 1, height: `${h}%`, borderRadius: '4px 4px 0 0' }} />;
            })}
          </div>
        </div>
      </div>

      {/* 按模型消耗明细（模型/请求/tokens/积分/平均单次，5 列 × 5 行） */}
      <TablePanelSkeleton head={[170, 72, 84, 76, 76]} rows={5} />

      {/* 按提供商消耗（BreakdownBars：名称 + 全宽轨道条 + 尾注） */}
      <div className="card panel">
        <div className="panel-head">
          <Bar w={96} h={15} />
          <Bar w={80} h={20} r='pill' />
        </div>
        <div style={{ padding: '4px 20px 14px' }}>
          {Array.from({ length: 4 }, (_, r) => (
            <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0' }}>
              <Bar w={86 + (r % 2) * 20} h={12} />
              <div style={{ flex: 1 }}>
                <div className="skeleton" style={{ width: `${34 + Math.abs(Math.sin(r * 2.1)) * 56}%`, height: 10, borderRadius: 'var(--radius-pill)' }} />
              </div>
              <Bar w={148} h={10} />
            </div>
          ))}
          <div style={{ marginTop: 10 }}><Bar w='62%' h={10} /></div>
        </div>
      </div>

      {/* 配额数据来源（两栏来源卡：各栏小节头 + 几行来源说明） */}
      <div className="card panel">
        <div className="panel-head">
          <Bar w={120} h={15} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 26px', padding: '0 20px 16px' }}>
          {[0, 1].map((col) => (
            <div key={col}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="skeleton" style={{ width: 14, height: 14, borderRadius: 4 }} />
                <Bar w={104} h={10} />
                <Bar w={52} h={16} r='pill' />
              </div>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0' }}>
                  <Bar w={col === 0 ? 130 + i * 14 : 150 - i * 12} h={11} />
                  <Bar w={64 + i * 6} h={10} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 请求日志页骨架：筛选条 → 表格行 × 若干 */
export function RequestsSkeleton() {
  return (
    <div className="view-body stack">
      {/* 筛选条 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ width: 150, height: 32, borderRadius: 9 }} />)}
        <div className="skeleton" style={{ flex: 1, height: 32, borderRadius: 9 }} />
      </div>

      {/* [v0.6.5] 统计条（当前筛选命中 / 本页条数 / 当前页异常 / 上游访问密钥失效）——
          此前这部分不在骨架里，加载时显示一排 0；现在与真实布局同形状。 */}
      <KpiRowSkeleton />

      {/* 表格 */}
      <Card>
        {/* 表头 */}
        <div style={{ display: 'flex', gap: 16, padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          {['时间', '令牌', '模型 / 提供商', 'User Agent', '状态', '耗时', 'Tokens', '积分'].map((_label, i) => (
            <Bar key={i} w={i === 2 ? 100 : 56} h={11} />
          ))}
        </div>
        {/* 数据行 */}
        {Array.from({ length: 12 }, (_, row) => (
          <div key={row} style={{ display: 'flex', gap: 16, padding: '9px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
            <Bar w={40} h={11} />
            <Bar w={90} h={11} />
            <Bar w={100 + (row % 3) * 20} h={11} />
            <div style={{ flex: 1 }}><Bar w={`${50 + (row % 4) * 10}%`} h={11} /></div>
            <Bar w={30} h={11} />
            <Bar w={36} h={11} />
            <Bar w={44} h={11} />
            <Bar w={48} h={11} />
          </div>
        ))}
      </Card>
    </div>
  );
}

/**
 * [v5] 指标卡骨架（4 张等宽卡）。
 *
 * 形状必须跟 `.kpi-row-grid + .kpi` 一致 —— 左右两栏（图标列 + 内容列），
 * 否则加载完成后会有一次"读数行 → 卡片"的跳变。
 * 用于 API Keys / 用量 / 请求日志 / 提供商管理。
 */
function KpiRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="kpi-row-grid" data-count={count}>
      {Array.from({ length: count }, (_, i) => (
        <div className="kpi" key={i}>
          <div className="kpi-side">
            <div className="skeleton" style={{ width: 30, height: 30, borderRadius: 'var(--radius-sm)' }} />
          </div>
          <div className="kpi-body">
            <Bar w={72} h={11} />
            <div style={{ marginTop: 7 }}><Bar w={104} h={23} /></div>
            <div style={{ marginTop: 6 }}><Bar w={132} h={10} /></div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * [v0.6.5] API Keys 页骨架：统计条（4 格）→ 密钥列表面板（7 列 × 6 行）。
 * 形状对齐 KeyTable —— 名称/密钥、绑定客户端、权限范围、近24h、最后使用、状态/到期、操作。
 */
export function KeysSkeleton() {
  return (
    <div className="view-body stack">
      <KpiRowSkeleton />
      <div className="card panel">
        <div className="panel-head">
          <Bar w={80} h={15} />
          <Bar w={200} h={20} r='pill' />
        </div>
        <div style={{ padding: '0 20px 14px' }}>
          <div style={{ display: 'flex', gap: 18, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
            {[110, 90, 70, 60, 70, 80, 110].map((w, i) => <Bar key={i} w={w} h={10} />)}
          </div>
          {Array.from({ length: 6 }, (_, row) => (
            <div key={row} style={{ display: 'flex', gap: 18, alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ width: 110 }}>
                <Bar w={70 + (row % 2) * 20} h={12} />
                <div style={{ marginTop: 5 }}><Bar w={96} h={10} /></div>
              </div>
              <Bar w={80 + (row % 2) * 14} h={12} />
              <Bar w={62 + (row % 3) * 8} h={12} />
              <Bar w={40} h={12} />
              <Bar w={56} h={12} />
              <Bar w={76} h={12} />
              <div style={{ marginLeft: 'auto' }}><Bar w={104} h={20} r='sm' /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * [v0.6.5] 提供商管理页骨架：提供商表（名称/密钥/请求次数/消耗积分/最后活跃/操作，3 行）
 * + 每行下方的嵌套客户端明细行。形状对齐 ProviderTable。
 * 注意：**不带 view-body 包装** —— 它被嵌进 ProvidersPanel 的 Panel 内使用。
 */
export function ClientsSkeleton() {
  return (
    <div>
      <div style={{ display: 'flex', gap: 18, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
        {[130, 120, 66, 66, 66, 108].map((w, i) => <Bar key={i} w={w} h={10} />)}
      </div>
      {Array.from({ length: 3 }, (_, p) => (
        <div key={p}>
          {/* 提供商行 */}
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
            <Bar w={90 + (p % 2) * 18} h={12} />
            <Bar w={110} h={11} />
            <Bar w={44} h={11} />
            <Bar w={52} h={11} />
            <Bar w={48} h={11} />
            <div style={{ marginLeft: 'auto' }}><Bar w={96} h={20} r='sm' /></div>
          </div>
          {/* 嵌套客户端明细行（数量 0-2） */}
          {Array.from({ length: p % 3 }, (_, c) => (
            <div key={c} style={{ display: 'flex', gap: 18, alignItems: 'center', padding: '9px 0 9px 22px', borderBottom: '1px solid var(--border-subtle)' }}>
              <Bar w={72 + c * 14} h={11} />
              <Bar w={96} h={10} />
              <Bar w={40} h={10} />
              <Bar w={48} h={10} />
              <Bar w={44} h={10} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
