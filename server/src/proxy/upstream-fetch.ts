/**
 * 反代出站 HTTP：带长保活连接池的 fetch（只给 /v1 转发的上游调用用）。
 *
 * ## 为什么不用全局 fetch
 * Node 内置 fetch 的全局连接池在上游**没有声明** `Keep-Alive: timeout=N` 时，空闲连接 **4 秒**就关
 * （undici 默认 keepAliveTimeout，已实测：间隔 3s 复用、间隔 5s 新建连接）。nginx 等网关默认不发这个头。
 * agent 场景里两次模型调用之间夹着工具执行，间隔经常超过 4 秒 —— 于是下一次请求要重新做
 * DNS + TCP + TLS 握手，首字延迟平白多出几十到几百毫秒。
 *
 * ## 为什么用 undici 包而不是给全局 fetch 传 dispatcher
 * 生产是 Node 22（内置 undici 6.x），开发机是 Node 26（内置 8.x）。把 npm 版 undici 的 Agent
 * 塞给**内置** fetch，等于让两个不同大版本的实现互相调用。这里 fetch 与 Agent 都取自同一个
 * undici 包，版本一致、行为确定。（undici 就是 Node 内置 fetch 的同一份实现，接口与错误形状一致：
 * 网络错误是 `TypeError('fetch failed')` + cause，中止是 `AbortError`。）
 *
 * ## 保活时长的取舍：30 秒
 * 客户端保活长于服务端空闲超时时，复用一条已被服务端关掉的连接会让 POST 直接失败（不能自动重试，
 * 非幂等）。常见网关 / 负载均衡的空闲超时在 60–75 秒以上（nginx 默认 75s），30 秒留足余量；
 * 上游若声明了更短的 `Keep-Alive: timeout`，undici 会按声明值（减 2 秒阈值）提前释放，不会越界。
 */
import { Agent, fetch as undiciFetch } from 'undici';

/** 上游未声明保活时长时，空闲连接保留多久（见文件头的取舍）。 */
export const UPSTREAM_KEEPALIVE_MS = 30_000;

/** TCP + TLS 建连超时：上游不可达时尽快失败（首字超时另由 ReadGuard 控制）。 */
const CONNECT_TIMEOUT_MS = 10_000;

const agent = new Agent({
  keepAliveTimeout: UPSTREAM_KEEPALIVE_MS,
  // 上游声明的保活时长上限（声明值大于此值时按此值）
  keepAliveMaxTimeout: 10 * 60_000,
  connect: { timeout: CONNECT_TIMEOUT_MS },
  /* ⚠️ [v1.5.4 事故] allowH2 必须**显式 false**：npm undici 8.x 会默认经 ALPN 协商出
     HTTP/2（Node 22 内置 fetch/undici 6.x 只说 h1），换连 h2 后 WorkBuddy 网关对
     h2 连接的使用模式不满，周期性掐流（NGHTTP2_ENHANCE_YOUR_CALM）→ 约 50% 请求
     502（2026-10-13 23:17 起，v1.5.4 上线 34 秒后开始；回滚 v1.5.3 即愈）。
     h2 默认值是「换实现时的沉默行为变化」——显式钉死，别让它再漂。 */
  allowH2: false,
});

/** 模块加载时的全局 fetch：用来识别测试里 `vi.stubGlobal('fetch', …)` 装上的替身。 */
const NATIVE_FETCH = globalThis.fetch;

/**
 * 发起一次上游请求（走长保活连接池）。
 *
 * 全局 fetch 被替换过（测试用 `vi.stubGlobal` mock 上游）时改走替身 —— 让既有测试的 mock 方式
 * 继续有效；生产进程里没有任何代码替换全局 fetch，这条分支不会命中。
 */
export function upstreamFetch(url: string, init: RequestInit): Promise<Response> {
  if (globalThis.fetch !== NATIVE_FETCH) return globalThis.fetch(url, init);
  // undici 包自带的 RequestInit/Response 类型与 DOM lib 的同名类型在声明上不完全一致（运行时同构），这里做类型桥接
  return undiciFetch(url, { ...(init as object), dispatcher: agent }) as unknown as Promise<Response>;
}

