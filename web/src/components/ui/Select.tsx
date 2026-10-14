import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/**
 * 控制台通用下拉 —— **自绘 listbox**，对齐设计稿 `prototype/v4/console.css`
 * 的 `.sel` / `.sel.sm`（32px / 28px）。
 *
 * 为什么不再是原生 `<select>`：
 *   原生 select 的弹出列表由**操作系统**绘制，CSS 完全碰不到 —— 在深色玻璃界面里
 *   永远协调不了（用户原话："所有下拉框都丑"）。设计稿本身用的就是自绘下拉
 *   （`console-views.js:709` 的 `<button class="sel" aria-haspopup="listbox">`）。
 *   所以这里按设计稿自绘，并把原生控件白送的那套键盘行为**逐条补回来**：
 *   ↑↓ / Home / End / Enter / Space / Esc / 首字母跳转 / 点击外部关闭。
 *
 * 行为与无障碍（对齐 WAI-ARIA listbox：「打开时焦点落面板」这一做法）：
 *   · 触发器 `<button type="button">`，带 `aria-haspopup="listbox"` / `aria-expanded`；
 *   · 打开时焦点移到面板 `[role=listbox][tabindex=-1]`，`aria-activedescendant` 指活动项；
 *   · 选项 `[role=option][aria-selected]`，当前项右侧带 Check 勾（矢量图标，非 emoji）。
 *
 * 为什么面板用 portal + `position: fixed`：
 *   `.card:hover` 带 `transform: translateY(-2px)`（console-fx.css:214）—— 卡片一旦被
 *   悬停，它就成了 `position: fixed` 后代的包含块，面板会跟着卡片"飞"。而 `.card`
 *   又是 `overflow: hidden`，直接绝对定位还会被裁掉。挂到 `document.body` 上，
 *   两个问题一起消失（`position: fixed` 的包含块回到视口）。
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  width,
  disabled,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  width?: number;
  /**
   * 禁用。**必须有** —— 原先只有 `SettingControl` 的 switch / number / text 三个分支
   * 支持禁用，select 分支无处可传，于是"只读项"一旦是下拉就会变成「点得动、存不了」。
   * 后端对只读项是**硬拒**的，所以那种不一致会表现为"界面允许改、保存被拒"，
   * 正是本项目一直在收的那类缺陷。
   */
  disabled?: boolean;
  /** 尺寸档：`md` = 设计稿 `.sel`(32px)，`sm` = `.sel.sm`(28px，分页/设置行用)。 */
  size?: 'md' | 'sm';
  /** 无可见 <label> 时补一个可访问名（如分页「每页条数」）。 */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; bottom: number; width: number } | null>(null);
  const [dropUp, setDropUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ buf: '', at: 0 });
  const baseId = useId();
  const listId = `${baseId}list`;
  const optId = (i: number) => `${baseId}opt${i}`;

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));

  /** 读触发器的视口矩形 —— 面板是 fixed 的，坐标每次都得现算。 */
  const measure = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    setRect({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
  }, []);

  const openList = useCallback(() => {
    if (disabled || options.length === 0) return;
    typed.current = { buf: '', at: 0 };
    setActive(selectedIdx);
    measure();
    setOpen(true);
  }, [disabled, measure, options.length, selectedIdx]);

  const commit = useCallback(
    (i: number) => {
      const o = options[i];
      if (o) onChange(o.value);
      setOpen(false);
      btnRef.current?.focus();
    },
    [onChange, options],
  );

  /* 打开后把焦点移进面板。 */
  useLayoutEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  /* 面板高度量出来之后再决定往上弹还是往下弹，避免贴着视口底被切一半。 */
  useLayoutEffect(() => {
    if (!open || !rect) return;
    const el = listRef.current;
    if (!el) return;
    const below = window.innerHeight - rect.bottom;
    setDropUp(below < el.offsetHeight + 12 && rect.top > below);
  }, [open, rect, options.length]);

  /* 活动项跟着键盘走 —— 保证它始终在面板可视区内。 */
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-opt="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  /* 打开期间：滚动/改尺寸跟随按钮；点「面板与触发器以外」则关闭。 */
  useEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (btnRef.current?.contains(t) || listRef.current?.contains(t))) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, measure]);

  /* 首字母跳转：700ms 内的连续按键拼成前缀（"se" 能命中 "settings"）。 */
  const typeAhead = useCallback(
    (ch: string, from: number) => {
      const now = Date.now();
      const buf = (now - typed.current.at > 700 ? '' : typed.current.buf) + ch;
      typed.current = { buf, at: now };
      const q = buf.toLowerCase();
      const n = options.length;
      const start = buf.length === 1 ? (from + 1) % n : 0;
      for (let k = 0; k < n; k += 1) {
        const i = (start + k) % n;
        if (options[i].label.toLowerCase().startsWith(q)) {
          setActive(i);
          return;
        }
      }
    },
    [options],
  );

  const printable = (e: ReactKeyboardEvent) =>
    e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key);

  const onBtnKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openList();
      return;
    }
    if (printable(e)) {
      e.preventDefault();
      openList();
      typeAhead(e.key, selectedIdx);
    }
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = options.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => (i + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => (i - 1 + n) % n);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(n - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(active);
        break;
      case 'Escape':
        /* stopPropagation：面板在 body 上，Esc 会冒泡到 document —— 不拦住的话
           弹窗里的下拉按下 Esc 会把整个弹窗一起关掉（Modal 监听的是 document）。 */
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
        break;
      /* Tab：收面板并把焦点交回触发器。**不** preventDefault —— 焦点此刻已在按钮上，
         浏览器便从触发器继续顺序导航，等同于原生控件的 Tab 行为（否则焦点会从
         body 末尾的 portal 里跳飞）。 */
      case 'Tab':
        setOpen(false);
        btnRef.current?.focus();
        break;
      default:
        if (printable(e)) typeAhead(e.key, active);
    }
  };

  const label = options[selectedIdx]?.label ?? '';

  return (
    <div className="sel-field" style={width ? { width } : undefined}>
      <button
        type="button"
        ref={btnRef}
        className={size === 'sm' ? 'sel sm' : 'sel'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onBtnKey}
      >
        <span className="sel-val">{label}</span>
        <ChevronDown size={size === 'sm' ? 12 : 13} className="ic caret-glyph" aria-hidden />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-activedescendant={options.length ? optId(active) : undefined}
              className={size === 'sm' ? 'sel-pop sm' : 'sel-pop'}
              onKeyDown={onListKey}
              style={{
                left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 168) - 8)),
                top: dropUp ? undefined : rect.bottom + 6,
                bottom: dropUp ? window.innerHeight - rect.top + 6 : undefined,
                minWidth: rect.width,
              }}
            >
              {options.map((o, i) => (
                <div
                  key={o.value}
                  id={optId(i)}
                  data-opt={i}
                  /* 值挂到 DOM 上：自绘 listbox 没有原生 option，测试/探针要读值得有个稳定锚点。 */
                  data-value={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  className={`sel-opt${i === active ? ' on' : ''}${o.value === value ? ' picked' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => commit(i)}
                >
                  <span className="sel-opt-lb">{o.label}</span>
                  {o.value === value ? <Check size={13} className="ic" aria-hidden /> : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
// @zbiti-ai:f:281:cedfd67e
