# 驿站 · Relay — Server

反向代理服务端。把客户端（WorkBuddy 等）发出的 OpenAI 兼容请求转发到上游，
并在中间做密钥托管、模型改写、日志落库与控制台 API。

> 控制台前端在 `web/`（React + Vite）。接口契约见仓库根目录 `docs/openapi.yaml`。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22 |
| 框架 | NestJS 11 + Fastify |
| 存储 | SQLite（better-sqlite3），WAL 模式 |
| 语言 | TypeScript（strict） |
| 测试 | Vitest |

## 快速开始

```bash
npm install

# 复制环境变量样例并填写
cp .env.example .env

npm run dev        # tsc --watch
npm start          # 启动（读 .env）
```

默认监听 `127.0.0.1:8787`，**仅回环**。生产由 Nginx 反代，
不允许直接对公网暴露（需 `RELAY_ALLOW_PUBLIC_BIND=1` 才可绑非回环地址）。

## 常用命令

```bash
npm run build      # 编译到 dist/（含 copy-assets：schema.sql / model-catalog.json）
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest run
npm run smoke      # 本地冒烟（端到端，断言较多，需要 dist）
npm run smoke:boot # 启动门禁：真起 dist → 打 /healthz → 登录后 GET /api/models/catalog
```

> **门禁纪律**：改完一个模块跑 `typecheck → lint → test`。
> **特例（必须遵守）：凡是动了 Nest 的 module / provider 装配** —— 新增 provider、
> 改构造函数依赖、注入**原始类型**参数（`number` / `string` / `boolean`，必须配
> `@Inject(token)` + provider）、忘了 `@Injectable()` —— **必须再跑一次
> `npm run build && npm run smoke:boot` 真启动 dist**。
> 这类装配缺陷**单测抓不到**（单测直接 `new`，绕过 IoC 容器；测试会全绿但应用起不来），
> 只有真启动能拦住。已经栽过**两次**：
> ① `ProxyLogger` 缺 `@Injectable()`（运行时静默 no-op）；
> ② `CatalogSyncService` 第 5 参是 `number`（`UnknownDependenciesException`，整个服务启动失败）。

## 环境变量

全部见 `.env.example`，每个变量都带「为什么需要它」的说明。重点几个：

| 变量 | 说明 |
|---|---|
| `RELAY_UPSTREAM_KEY` | 出站凭证（`ck_` 开头）。空值会让 `/v1/chat/completions` 返回 `502 upstream_credential_invalid` |
| `RELAY_SECRET` | HMAC 密钥，用于 `client_keys.key_hash` 与会话令牌签名。**丢失等于所有密钥作废** |
| `RELAY_ADMIN_PASSWORD_HASH` | 管理口令的 scrypt 哈希，**可选但优先级最高** |
| `RELAY_DATA_DIR` | 数据目录（默认 `./data`） |
| `RELAY_PORT` | 监听端口（默认 8787） |

**任何真实密钥都不得提交进仓库。** `.env` 已在 `.gitignore` 中。

## 管理口令

控制台是本产品唯一的入口，口令按**四级优先级**装载：

```
① RELAY_ADMIN_PASSWORD_HASH 环境变量   ← 运维显式设定，最高
② 数据库 admin_credential 表           ← 控制台「设置 → 管理口令 → 重置」写入
③ <数据目录>/admin.hash 文件           ← 兼容旧部署；读到后顺手迁进数据库
④ 都没有 → 生成随机 16 字符口令，打印到 stdout 一次
```

- **改密**：控制台「设置 → 管理口令 → 重置」。**热生效、无需重启。**
- **忘记口令**：控制台进不去时，只能在服务器上直接改库：

  ```bash
  RELAY_NEW_PASSWORD_CODEPOINTS='[码点…]' node tools/force-set-password.mjs
  systemctl restart relay        # ★ 直接改库必须重启
  ```

  为什么必须重启：内存里的哈希只在**启动时**与**控制台 reset 时**更新，
  直接改库绕过了这两条路径。

- 产品内**不做**「忘记口令」的令牌/邮件自救通道（理由见接口契约 §3.1.3）。

## 数据库

SQLite，权威 DDL 是 `server/src/store/schema.sql`（构建时复制到 `dist/store/schema.sql`）。

**迁移纪律（ADR-002）**：绝不自动执行 `ALTER`。

| `user_version` | 行为 |
|---|---|
| `0` | 空库，执行 `schema.sql` 建表 |
| `< 期望` | **拒绝启动**，打印需要手动执行的迁移 |
| `> 期望` | 打 warning 后继续（允许降级容忍） |

迁移脚本在 `server/tools/migrate-0NN.mjs`（每个内含 `VACUUM INTO` 备份，执行前先备份）。

`EXPECTED_USER_VERSION` 在 `src/store/migrate.ts`；
`assertSchema` 做**双向自检**（缺列和多列都报错），
所以新增表**必须**同步加入 `src/store/self-check.ts` 的 `EXPECTED_COLUMNS`。

## 部署

`deploy/` 下有一份可参考的 Nginx 配置样例。完整步骤见仓库根 README「部署」一节。

两个容易踩的坑：

1. **`proxy_set_header Host` 必须用 `$http_host`**（不是 `$host`）——
   `$host` 不含端口，非标准端口下 CSRF 同源校验必然失败。
2. **`X-Forwarded-For` 必须覆写 `$remote_addr`**（不是 `$proxy_add_x_forwarded_for`）——
   后者是追加语义，首段可被客户端伪造，会导致审计记假 IP、限流可被绕过。

## 目录结构

```
src/
  api/        控制台 API（含 auth / settings / keys / 各业务服务）
  auth/       客户端密钥校验（sk-waygate-）
  catalog/    模型目录
  common/     通用工具（client-ip / crypto / mask / errors …）
  config/     配置装载与校验
  proxy/      转发核心（pipeline / headers / sse-stream / rewrite）
  store/      SQLite（db / migrate / self-check / repositories）
  main.ts     启动
scripts/      构建辅助（copy-assets / smoke-local）
tools/        运维脚本（迁移、应急设口令、启动冒烟 smoke-boot）
deploy/       Nginx / systemd 配置
```
