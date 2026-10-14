/**
 * 监听地址 / 端口的解析（task#37，A2）。
 *
 * 从 `main.ts` 抽出为纯函数：`main.ts` 是进程入口（顶部 `void bootstrap()` 有副作用），
 * 无法被单测 import，故把「设置 + 环境变量 → 实际 bind 的 host:port」这段决策单独成文件。
 *
 * 优先级与安全纪律：
 *   - **端口**：`RELAY_PORT`（环境变量）> `service.listenPort`（设置）> 8787（兜底）。
 *     环境变量优先是**刻意**的：冒烟脚本 / 自动化用随机端口起隔离实例，不能被磁盘上的
 *     固定端口覆盖（否则会误连残留进程 → "全绿但什么都没测"）。
 *   - **地址**：默认取 `service.listenHost`。若它是非回环地址、而环境里没有
 *     `RELAY_ALLOW_PUBLIC_BIND=1`，则**降级回 127.0.0.1 并置 `downgraded=true`**。
 *     这是 `PUT /api/settings` 那道闸之外的第二道：settings.json 可被手工编辑绕过接口，
 *     启动时再挡一次，避免本进程（持有上游凭证 + 管理口令）被静默推到公网。
 */

/** 视为「本机」的地址，不需要 RELAY_ALLOW_PUBLIC_BIND。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface ListenResolution {
  host: string;
  port: number;
  /** 设置里要对外监听但缺 RELAY_ALLOW_PUBLIC_BIND，已降级为回环。 */
  downgraded: boolean;
}

export interface ListenEnv {
  RELAY_PORT?: string;
  RELAY_ALLOW_PUBLIC_BIND?: string;
}

export function resolveListen(
  settings: { service: { listenHost: string; listenPort: number } },
  env: ListenEnv,
): ListenResolution {
  const wantedHost = settings.service.listenHost;
  const allowPublic = env.RELAY_ALLOW_PUBLIC_BIND === '1';
  const downgraded = !LOOPBACK_HOSTS.has(wantedHost) && !allowPublic;
  const host = downgraded ? '127.0.0.1' : wantedHost;

  const envPort = Number.parseInt(env.RELAY_PORT ?? '', 10);
  const port =
    Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535
      ? envPort
      : settings.service.listenPort;

  return { host, port, downgraded };
}
