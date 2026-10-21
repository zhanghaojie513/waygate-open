/**
 * 请求时间轴的两个起点（v1.7.2）。
 *
 * ── 为什么需要两个而不是一个 ────────────────────────────────────────────
 * `beginContext()` 在 controller 方法体里执行，而 `@UseGuards(ClientKeyGuard)`
 * 在 controller **之前**跑 —— 所以 `ctx.started` 是**鉴权完成之后**的时刻。
 * 想量出「鉴权本身花了多久」，起点必须在 guard 之前拿。
 *
 * ── 但「进门」不等于「我们开始处理」────────────────────────────────────
 * 第一版只记 `onRequest`（最早的时刻），生产实测暴露了问题：`auth_ms` 出现
 * 2238 / 6744 / 9660ms 这样的值，且**逐次递增**。原因很具体：
 * `onRequest` 早于 **body 解析**，而 agent 客户端的 body 常有几十 MB（长会话 +
 * 图片 base64）。那段时间是**客户端在上传**，不是我们在鉴权。
 * 把它算进「我方开销」是错的 —— 会让「我方开销」看起来像几十秒。
 *
 * 所以记两个点：
 *   · `arrivedAt`   onRequest 阶段（含网络传输 + body 解析等待）
 *   · `bodyReadyAt` preHandler 阶段（body 已解析完、即将进 guard）← **我方开销的真正起点**
 *
 * `auth_ms` = `marks.authed - bodyReadyAt`（纯鉴权）
 * 传输/解析耗时另记 `ingress_ms` = `bodyReadyAt - arrivedAt` —— 它是**客户端侧**的
 * 成本，归因上不该混进「我方」，但也不能丢（用户问"为什么这次特别慢"时它会回答）。
 *
 * ── 边界（诚实口径）────────────────────────────────────────────────────
 * `arrivedAt` 不是「客户端拿起 TCP 连接」——那是内核/nginx 的事，进程看不到；
 * 它是「本进程开始处理这条 HTTP 请求」。跨 nginx 的那段延迟不在观测范围内。
 */

import type { FastifyInstance } from 'fastify';

/** 进门时刻（onRequest）。 */
export const ARRIVED_AT = Symbol('waygate.arrivedAt');
/** body 解析完成时刻（preHandler，早于 guard）。 */
export const BODY_READY_AT = Symbol('waygate.bodyReadyAt');

/** 承载时刻的请求形状（Fastify request 鸭子类型）。 */
export interface RequestWithArrival {
  [ARRIVED_AT]?: number;
  [BODY_READY_AT]?: number;
}

/** 取进门时刻（epoch ms）。未装钩子（如测试直构 controller）时为 undefined。 */
export function arrivedAtOf(req: unknown): number | undefined {
  return (req as RequestWithArrival | null | undefined)?.[ARRIVED_AT];
}

/** 取 body 就绪时刻。未装钩子时为 undefined。 */
export function bodyReadyAtOf(req: unknown): number | undefined {
  return (req as RequestWithArrival | null | undefined)?.[BODY_READY_AT];
}

/**
 * 装两段钩子。**只记时间戳**，不做任何 I/O、不读 body、不碰鉴权 ——
 * 对请求结果零影响。
 *
 * `preHandler` 在 guard 之前、body 解析之后执行，是「我方开始干活」的正确定位。
 */
export function installArrivalClock(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    (req as RequestWithArrival)[ARRIVED_AT] = Date.now();
    done();
  });
  app.addHook('preHandler', (req, _reply, done) => {
    (req as RequestWithArrival)[BODY_READY_AT] = Date.now();
    done();
  });
}
