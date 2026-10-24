import { useEffect, useRef, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * 行内「更多」菜单 —— 低频操作收口。
 *
 * ## 为什么需要它
 *
 * 提供商行此前有 5 枚按钮并排（配置 / 模型列表 / 签到 / 启停 / 删除）。
 * 并排需要约 380px，而操作列只有 ~300px，于是折成两行 ——
 * **行高由按钮数量决定**：WorkBuddy 行 76px、DeepSeek 行 108px，
 * 表格失去横向基线，扫读时找不到同一列的对应关系。
 *
 * 改成 nowrap 能保住行高，代价是整表横向溢出 89px，
 * 要把「删除」滑出来才能点 —— 低频操作不该占用横向滚动这个高成本资源。
 *
 * 所以：高频三枚（配置 / 模型列表 / 启停）留在行内，
 * 低频两枚（签到 / 删除）收进这里。
 *
 * ## 为什么用 `<details>` 而不是自绘弹层
 *
 * 原生 `<details>` 自带三件自绘要实现的事：键盘可达（Enter/Space 切换）、
 * 焦点顺序正确、屏幕阅读器语义（expanded 状态）。自绘这三样都要手写，
 * 而且很容易漏掉焦点陷阱或 Esc。
 * 唯一的缺口是「点外部关闭」—— 用下面那个 pointerdown 监听补上。
 */
export function RowMenu({
  children,
  label = '更多操作',
  disabled = false,
}: {
  children: ReactNode;
  label?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  /**
   * 展开方向自适应。
   *
   * 表格的滚动容器是 `.tbl-scroll { overflow: auto }` —— 它会裁掉一切溢出内容。
   * 最后一行向下展开时，菜单底部会落到容器之外：**命中测试拿到的不是按钮而是底下的卡片**，
   * 也就是「看得见但点不到」。这不是 z-index 能解决的，z-index 管不了祖先的 overflow。
   *
   * 所以展开时量一下：下方放不下就翻到上方（`row-menu--up` 把 `top` 换成 `bottom`）。
   */
  const place = () => {
    const el = ref.current;
    const list = el?.querySelector<HTMLElement>('.row-menu-list');
    if (!el || !list) return;
    el.classList.remove('row-menu--up');
    const box = el.getBoundingClientRect();
    const height = list.getBoundingClientRect().height;
    const scroller = el.closest<HTMLElement>('.tbl-scroll');
    const bottomLimit = (scroller ?? document.documentElement).getBoundingClientRect().bottom;
    const topLimit = scroller ? scroller.getBoundingClientRect().top : 0;
    const needed = height + 8;
    if (box.bottom + needed > bottomLimit && box.top - needed > topLimit) {
      el.classList.add('row-menu--up');
    }
  };

  /* 点外部关闭：details 原生不会自动收起。
     pointerdown 而不是 click —— 后者要等 mouseup，
     用户按住拖动时菜单会一直挂着。 */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    /* Esc 关闭：原生 details 也不管这个。 */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && el.open) {
        el.open = false;
        el.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <details
      className="row-menu"
      ref={ref}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) place();
      }}
    >
      <summary
        className="mini-pill row-menu-trigger"
        aria-label={label}
        aria-disabled={disabled}
        onClick={(e) => {
          /* disabled 时阻止展开 —— summary 没有 disabled 属性，
             只能靠 preventDefault。 */
          if (disabled) e.preventDefault();
        }}
      >
        <MoreHorizontal size={12} />
        更多
      </summary>
      <div className="row-menu-list" role="group" aria-label={label}>
        {children}
      </div>
    </details>
  );
}

/** 菜单项：外观与 mini-pill 同族，但整行左对齐、可带图标。 */
export function RowMenuItem({
  children,
  onClick,
  danger = false,
  disabled = false,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`row-menu-item${danger ? ' danger' : ''}`}
      aria-disabled={disabled}
      title={title}
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
    >
      {children}
    </button>
  );
}
