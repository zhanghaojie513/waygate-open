import { useState } from 'react';
import { Check, Copy, Link2, ShieldAlert } from 'lucide-react';
import { accessBaseUrl } from '../../lib/accessUrl';

/**
 * 接入卡 ——「客户端与密钥」页显著位置，回答用户唯一真正会问的问题：
 *   「反代之后的地址是啥？我在 agent 工具里该怎么填？」
 *
 * 地址来自 `lib/accessUrl`（`location.origin + '/v1'`），与官网共用**同一处计算**，
 * **绝不硬编码** —— 地址随域名 / 端口 / 隧道而变，硬编码必然过期。
 *
 * 之所以把「自签证书」也写进这张卡：这是地址填对了却仍连不上的头号原因，
 * 不提前说清，用户会去反复改地址。
 */
export function AccessPanel() {
  const baseUrl = accessBaseUrl();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 无剪贴板权限：静默降级，不弹错（与密钥弹层一致） */
    }
  };

  return (
    <div className="card access-card">
      <div className="access-head">
        <span className="access-title">
          <Link2 size={13} aria-hidden />
          接入地址
        </span>
        <span className="access-sub">客户端与 API 同源 —— 这就是你当前访问控制台的地址</span>
      </div>

      <div className="key-plain access-url">
        <code>{baseUrl}</code>
        <button
          type="button"
          className="copy"
          aria-label={copied ? '已复制接入地址' : '复制接入地址'}
          onClick={() => void copy()}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>

      <p className="chain-note">
        客户端里要填两组值：<b>base_url</b> 就是上面这串；<b>API Key</b> 用你在本页<b>新建的那把</b>
        <span className="code-chip">sk-waygate-…</span>（明文只在创建时显示一次，丢了只能删掉重建）。
      </p>

      <div className="cred-note access-cert">
        <ShieldAlert size={14} aria-hidden />
        <span>
          本服务的 TLS 是<b>自签证书</b>：客户端得先信任它的根证书，否则会以「证书错误」失败 —— 那
          <b>不是</b>地址填错。把根证书装进系统信任库，或让客户端通过
          <span className="code-chip">NODE_EXTRA_CA_CERTS</span> /<span className="code-chip">SSL_CERT_FILE</span>
          指向随部署产出的<span className="code-chip">relay-ca.crt</span>。
        </span>
      </div>
    </div>
  );
}
// @zbiti-ai:f:70:93b41f5b
