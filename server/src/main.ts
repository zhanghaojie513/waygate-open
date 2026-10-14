import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './api/api.filter';
import { RelayConfigService } from './config/config.service';
import { resolveListen } from './config/listen';

/**
 * 进程入口。
 *
 * ## 为什么是 Fastify，不是 Express
 * 目标机是华为云 Flexus L **2 核 2 GiB**（SPEC §4 内存预算表）。
 * Fastify 的空载内存与每请求开销都明显低于 Express，且 `reply.raw` 能拿到
 * 原生 `ServerResponse`，SSE 手动 flush 依然成立。Express 适配器已从依赖里移除。
 *
 * ## 监听地址：默认只对本机开放
 * 这是**安全底线**，不是性能选择。本进程持有：
 *   - 上游 `ck_` 凭证（能烧掉你的订阅额度）
 *   - `sk-waygate-` 密钥哈希的 HMAC secret（泄漏 = 可离线撞库）
 *   - 控制台管理口令
 * 一旦监听 `0.0.0.0`，这些全部直接暴露在公网上。
 *
 * 监听地址/端口现在读自设置项（`service.listenHost` / `listenPort`，task#37），
 * 但**放行对外监听需要环境变量 `RELAY_ALLOW_PUBLIC_BIND=1`**（`config/listen.ts`
 * 会在缺失时降级回 127.0.0.1 并告警）。`RELAY_PORT` 仍可覆盖端口，供自动化测试起
 * 随机端口的隔离实例。对外仍应只经 Nginx 暴露 `/v1/` 与 `/healthz`（deploy-security.md 第 3 章）。
 */

/**
 * 请求体上限 32MB（v0.2.1 起从 2MB 提高）。
 *
 * 生产实测（2026-10-08，nginx access log 两条 413）：agent 工具轮次的对话历史
 * （系统提示 + 工具输出 + 多模态 base64 图片）**轻易超过 2MB**，旧上限把长会话
 * 直接挡在门外。32MB 给足余量；真正的尺寸约束交给上游（它有自己的上下文上限），
 * 本层闸门只防内存滥用（32MB × 并发 8 = 256MB，在 systemd MemoryMax=768M 内）。
 */
const BODY_LIMIT = 32 * 1024 * 1024;

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: BODY_LIMIT,
      // 关闭 Fastify 自带的请求日志：SSE 长连接会把日志刷爆，
      // 且请求审计已经落在 SQLite 的 requests 表里（ProxyLogger），
      // 不需要第二份、还带不上 trace id 的日志。
      //
      // 注：fastify@5 会对这个顶层开关打 FSTDEP023 弃用警告，提示改用
      // `logController`。但 `logController` 要求传入完整的 LogController 实例
      // （requestIdLogLabel / isLogDisabled / incomingRequest / requestCompleted 等 10 个成员），
      // 为关一个请求日志去实现整套接口不划算 —— 保持顶层开关，接受这条警告。
      disableRequestLogging: true,
      // 不信任 X-Forwarded-* 的默认推导：客户端 IP 只用于审计展示，
      // 由 key.guard 自行读 x-forwarded-for 首段。这里显式关掉，避免
      // Fastify 把 remoteAddress 替换成可伪造的头值。
      trustProxy: false,
    }),
    {
      // 关掉 Nest 的默认日志冗余度，保留 warn/error 便于 systemd journal 排障
      logger: ['warn', 'error', 'log'],
    },
  );

  // 显式不调用 app.enableCors()：
  // 控制台与 API 同源（Nginx 同域），外部客户端走 `/v1/*` 用 Bearer 鉴权，
  // 两者都不需要 CORS。开 CORS 只会平白放宽浏览器侧边界。

  // `/api/*` 的错误信封：把 RelayHttpError / HttpException 统一转成
  // `{code,data,message}`（契约 §0.1）。过滤器内部会判断路径前缀，
  // 非 /api 的请求原样放行，所以 `/v1/*` 的 OpenAI 错误形状不受影响。
  app.useGlobalFilters(new ApiExceptionFilter());

  // 处理 SIGTERM/SIGINT：systemd 停止服务时发 SIGTERM，
  // 不优雅关闭会导致 better-sqlite3 的 WAL 未检查点、在途请求被硬切。
  app.enableShutdownHooks();

  const config = app.get(RelayConfigService);

  // 监听地址/端口读自设置（task#37）。设置加载发生在 RelayConfigService.onModuleInit，
  // NestFactory.create() 完成即已跑过，故此处 config.get() 拿到的是磁盘上的真实设置。
  const { host, port, downgraded } = resolveListen(config.get(), process.env);
  if (downgraded) {
    logger.warn(
      `service.listenHost 请求对非回环地址监听，但环境里没有 RELAY_ALLOW_PUBLIC_BIND=1 —— ` +
        `已降级为 ${host}。确需对外监听请显式设置该环境变量并自担公网暴露后果。`,
    );
  }

  await app.listen(port, host);

  logger.log(`Waygate 已在 http://${host}:${port} 就绪（默认仅回环，不对公网直接暴露）`);
  logger.log(`健康检查：http://${host}:${port}/healthz`);

  // 上游密钥缺失**不阻止启动**：让进程起来、`/healthz` 可答，
  // 这样部署后能立刻区分「服务没起来」和「密钥没配」两种故障。
  // 真正的失败会在调用 `/v1/chat/completions` 时以 502
  // `upstream_credential_invalid` 明确报出。配置缺失的告警由
  // RelayConfigService.onModuleInit 自己打印，此处不重复。
  if (!config.upstreamConfigured()) {
    logger.warn(
      '上游访问密钥未配置：/v1/chat/completions 会全部返回 502 upstream_credential_invalid。请设置 RELAY_UPSTREAM_KEY。',
    );
  }
}

void bootstrap();
