import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * 可复制的命令块（提供给「无法手填凭证」的场景：MiniMax / Qoder 的导入命令）。
 * 传空 command 则不渲染 —— 调用方按协议决定。
 * 复制失败降级为提示（无 clipboard 权限的浏览器），与 PlaintextKey 同策略。
 *
 * [v1.6.10] 从 `clients/ProvidersPanel.tsx` 提出来：新增弹窗也要用它，
 * 而弹窗是被 ProvidersPanel 引的 —— 就地复用会形成循环 import。
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  if (!command) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="cred-guide-cmd">
      <code>{command}</code>
      <button
        type="button"
        className="copy"
        aria-label={copied ? '已复制命令' : '复制命令'}
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}
