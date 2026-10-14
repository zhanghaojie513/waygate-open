import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Banner } from '../ui/Banner';
import { api } from '../../services/api';
import type { DangerAction, DangerResult } from '../../types/api';
import { ApiError } from '../../services/http';
import { Modal } from '../ui/Modal';
import { errorDetail } from '../ui/StateBlock';

export interface DangerSpec {
  action: DangerAction;
  title: string;
  body: string;
  lose: string;
  ok: string;
}

/**
 * 危险操作二次确认（对应原型 #ov-danger）。
 * 三条硬性交互：
 *   ① 必须让用户手动输入「确认」二字，打错一个字就不能继续
 *   ② 破坏性按钮用琥珀描边
 *   ③ 安全选项（取消）才是主按钮
 */
export function DangerConfirmModal({
  spec,
  onClose,
  onDone,
}: {
  spec: DangerSpec;
  onClose: () => void;
  onDone: (res: DangerResult) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ok = text === '确认';

  const run = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.danger(spec.action, text);
      onDone(res);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 0));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={spec.title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            取消（保持现状）
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={!ok || busy}
            onClick={() => void run()}
          >
            {busy ? <Loader2 size={14} /> : null}
            {busy ? '执行中…' : spec.ok}
          </button>
        </>
      }
    >
      <p className="ov-sub">{spec.body}</p>
      <div className="ov-lose">
        <b>会失去什么：</b>
        {spec.lose}
      </div>
      <div className="ov-field">
        <label htmlFor="danger-confirm">
          输入 <b style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>确认</b> 以继续
        </label>
        <input
          id="danger-confirm"
          className="field-input text"
          style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
          value={text}
          autoFocus
          placeholder="确认"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="ov-hint">打错一个字就没法继续。破坏性操作值得这一步。</div>
      </div>
      {error ? <Banner tone="error">{errorDetail(error)}</Banner> : null}
    </Modal>
  );
}
