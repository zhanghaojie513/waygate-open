import { useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

/**
 * 通用弹层。对应原型 .overlay/.ov-modal，支持 Esc、遮罩点击和焦点回收。
 * danger 变体：琥珀描边 + 主按钮是「安全选项」，破坏性按钮才用琥珀。
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(modalRef, onClose);

  return (
    <div
      className="overlay on"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="ov-modal"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="ov-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="ov-x" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        {description ? <div id={descriptionId} className="ov-description">{description}</div> : null}
        {children}
        {footer ? (
          <>
            <div className="ov-div" />
            <div className="ov-foot">{footer}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 点击遮罩关闭的包装（内层点击不冒泡）。 */
export function ModalScrim({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{ display: 'contents' }}
    >
      {children}
    </div>
  );
}
