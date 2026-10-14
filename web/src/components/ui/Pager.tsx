import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatInt } from '../../lib/format';
import { Select } from './Select';

const LIMITS = [20, 50, 100];

/** 分页器：页码窗口 + 每页条数。对应原型 .pager（每页条数用设计稿的 `.sel sm`）。 */
export function Pager({
  page,
  limit,
  total,
  onPage,
  onLimit,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (p: number) => void;
  onLimit: (l: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const windowed: Array<number | '…'> = [];
  const push = (n: number | '…') => {
    if (windowed[windowed.length - 1] !== n) windowed.push(n);
  };
  const around = [1, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  let prev = 0;
  around.forEach((n) => {
    if (n - prev > 1) push('…');
    push(n);
    prev = n;
  });

  return (
    <div className="pager">
      <span className="txt">
        第 {page} / {pages} 页 · 每页 {limit} 条，共 {formatInt(total)} 条
      </span>
      <span className="btns">
        <Select
          value={String(limit)}
          options={LIMITS.map((n) => ({ value: String(n), label: `${n} / 页` }))}
          onChange={(v) => onLimit(Number(v))}
          size="sm"
          width={92}
          ariaLabel="每页条数"
        />
        <button type="button" className="pg" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="上一页">
          <ChevronLeft size={13} />
        </button>
        {windowed.map((n, i) =>
          n === '…' ? (
            <span key={`gap-${i}`} className="pg" style={{ cursor: 'default', background: 'transparent', border: 'none' }}>
              …
            </span>
          ) : (
            <button key={n} type="button" className={`pg${n === page ? ' on' : ''}`} onClick={() => onPage(n)}>
              {n}
            </button>
          ),
        )}
        <button type="button" className="pg" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="下一页">
          <ChevronRight size={13} />
        </button>
      </span>
    </div>
  );
}
// @zbiti-ai:f:68:ff169f44
