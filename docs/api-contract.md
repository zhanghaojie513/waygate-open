# API 契约 — 驿站 · Relay v0.4.29

> 本文是 `SPEC.md` 第 5 章的可执行细化版，是前后端联调的**唯一依据**。
> 依据：`design/SPEC.md`（已锁定）· `probe/03-upstream-verified.md`（上游实测）· `design/model-catalog.json`（17 项实测）· `design/design-spec.md` §7.4 / §8.2
> 上游：`https://copilot.tencent.com/v2/chat/completions`，`Authorization: Bearer <ck_密钥>`
> 状态：草稿待评审（架构师 高见远，2026-10-03）

---

## 0. 通用约定

### 0.1 两套响应体，不要混

本项目有**两套**响应格式，混用会让 OpenAI 客户端直接解析失败。

| 路径族 | 响应体 | 原因 |
|---|---|---|
| `/v1/*` | **OpenAI 原生**：成功是原生 `chat.completion` / `chat.completion.chunk`；失败是 `{"error":{"message","type","code","param"}}` | 第三方客户端（Claude Code / Cursor / Cherry Studio / OpenAI SDK）按这个形状解析，改了就废 |
| `/api/*` | **本项目统一信封**：`{"code":0,"data":{},"message":""}` | 控制台自用，前端只认这一种 |
| `/healthz` | `{"status":"ok","version":"0.4.1"}` | 不鉴权，信息最小化 |

**硬约束**：`/v1/*` 的任何错误**禁止**返回 `{"code":...}` 信封；`/api/*` 的任何错误**禁止**返回 `{"error":...}`。

### 0.2 版本与路径

- `/v1/*` 路径由 OpenAI 协议钉死，不可加版本前缀（客户端就是打 `/v1/chat/completions`）。
- `/api/*` 按 `SPEC.md` §5.2 无版本前缀。**原因**：控制台是单部署、无外部消费者、前后端同仓同版发布，加版本前缀只增加维护面。若将来需要对外，新增 `/api/v2/` 并保留 `/api/` 至少 6 个月。

### 0.3 时间、分页、排序

| 项 | 约定 |
|---|---|
| 时间格式 | 对外**一律 ISO 8601 UTC**（`2026-10-03T06:12:44.000Z`）。前端按本地时区渲染。库内 `INTEGER` 存 epoch 毫秒 |
| 分页 | `?page=1&limit=20`，`limit` 上限 200。统一返回 `{items,total,page,limit,hasMore}` |
| 排序 | `?sort=ts&order=desc`，可选字段由各端点声明，白名单校验，不接受任意列名 |
| 统计窗口 | `?window=today|1h|24h|7d|30d`，默认 `today`。**窗口跟随筛选条，服务端不写死**（`build-plan.md` §2.3） |

### 0.4 缓存

所有 `/api/*` 响应头带 `Cache-Control: no-store`。`/v1/*` 流式响应带 `Cache-Control: no-cache`。

---

## 1. 鉴权模型

### 1.1 两套凭证，三个方向，永不交叉

| 凭证 | 方向 | 校验方 | 存储 |
|---|---|---|---|
| `sk-waygate-<24 位小写十六进制>` | 入站：客户端 → 本服务 | **我们自己的 Guard** | `client_keys.key_hash`（HMAC-SHA256），库内无明文 |
| `ck_…` | 出站：本服务 → 上游 | **上游服务端** | 环境变量 `RELAY_UPSTREAM_KEY`，不入库、不落盘、不进日志 |
| 会话 cookie `relay_sid` | 入站：浏览器 → 控制台 | **我们自己的 Guard** | 无服务端状态（HMAC 签名令牌，见 ADR-002） |

密钥全长 = `sk-waygate-`（11）+ 24 = **35 字符**（旧前缀 `sk-relay-` 为 9 + 24 = 33 字符，已退役）。生成用 `crypto.randomBytes(12).toString('hex')`（随机段固定 24 位小写十六进制）。

> **前缀更名（2026-10-11，产品由 relay-station 更名 Waygate）：`sk-relay-` → `sk-waygate-`。**
> **新建与校验一律用 `sk-waygate-`**（`KEY_PATTERN` = `sk-waygate-` + 24 位小写十六进制，共 35 字符）。
> 更名期为平滑过渡**曾短暂并存接受旧前缀 `sk-relay-`**；**2026-10-11 晚存量密钥已全部重签为 `sk-waygate-`、旧密钥删除后，校验已收窄，旧前缀不再被接受**。
> 为什么当初必须重签而不能只改前缀字面量：**前缀参与哈希**（`key_hash = base64url(HMAC_SHA256(RELAY_SECRET, 完整密钥))`），库里只有 hash、明文只在客户端手里，服务端无法把旧前缀「改」成新前缀，只能重签并把新明文交回客户端。这是本设计的一条记录。
> 存量行的 `key_hint` 是**签发时的快照**；更名期的旧行曾是 `sk-relay-` 形态，现已全部重签，库中不再有旧前缀行（见 §3.10）。

### 1.2 `/v1/*` 入站鉴权（AC-02）

```
1. 取 Authorization 头，必须是 `Bearer <token>`；缺或格式错 → 401 invalid_api_key
2. token 必须以 `sk-waygate-` 开头；否则 401（不查库，快速拒绝）。
   更名期曾短暂并存接受旧前缀 `sk-relay-`；2026-10-11 晚存量密钥全部重签后已收窄，旧前缀不再被接受
3. key_hash = base64url(HMAC_SHA256(RELAY_SECRET, token))，查 client_keys
4. 未命中 / 命中但 enabled=0 / 命中但 expires_at < now → **一律 401 `invalid_api_key`**
   （**不区分原因**：区分「不存在 / 已停用 / 已过期」等于告诉攻击者密钥是否存在，
   把爆破从随机猜测变成定向确认。三者只写服务端日志，不进响应体）
5. 通过。绝不转发到上游（AC-02 要求"不转发"）
```

失败响应（OpenAI 形状）：

```json
{
  "error": {
    "message": "Invalid API key provided: sk-waygate-xxxx. 请检查密钥是否有效、是否被停用。",
    "type": "invalid_request_error",
    "code": "invalid_api_key",
    "param": null
  }
}
```

### 1.3 出站凭证隔离（AC-03，最高优先级）

**用 allowlist 拷请求头，不用 denylist。** 这是本契约里最重要的一条实现约束。

```typescript
// 只允许这些头出站，其余一律丢弃（含入站的 Authorization / api-key / x-api-key）
const OUTBOUND_HEADERS = ['content-type', 'accept', 'accept-encoding'];
// 由本服务强制注入的值
headers['authorization'] = `Bearer ${process.env.RELAY_UPSTREAM_KEY}`;
headers['user-agent']    = cfg.upstream.spoofUA ? cfg.upstream.userAgent : (inboundUA ?? 'relay/0.1');
headers['x-request-id']  = traceId;          // 自己生成，不信任入站
headers['accept']        = 'text/event-stream';
```

被消费、不出站：`x-relay-client`（客户端识别用，§4）。

**验收断言**：在出口抓包，出站 `Authorization` **必须**是 `ck_…`，且请求头里**不得出现**任何 `sk-waygate-` 字符串。

### 1.4 `/api/*` 控制台鉴权

- `POST /api/auth/login` 成功后设置 cookie：
  `relay_sid=<payload>.<hmac>`；`HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=43200`（12 小时）
- 令牌内容（不加密，只签名）：`{"sub":"admin","iat":<epoch_s>,"exp":<epoch_s>,"jti":"<random>"}`
- 服务端校验：HMAC 一致 + `exp` 未过 + `sub==='admin'`
- **CSRF**：`SameSite=Strict` 之外，对 `POST/PUT/PATCH/DELETE` 额外校验 `Origin` 头必须等于本站 `Host`（缺失或非同源 → 403）
- **失败限流**：按来源 IP，10 分钟内失败 ≥ 10 次 → 锁定 10 分钟，返回 429 `40290` 并带 `retryAfterSeconds`

### 1.5 端点鉴权矩阵

| 路径 | 鉴权 |
|---|---|
| `POST /v1/chat/completions` | `sk-waygate-`（旧前缀 `sk-relay-` 已退役，不再接受） |
| `GET /v1/models` | `sk-waygate-`（旧前缀 `sk-relay-` 已退役，不再接受） |
| `GET /healthz` | **无**（且响应不得包含任何凭证/配置线索） |
| `POST /api/auth/login` | 口令 + IP 失败限流 |
| 其余 `/api/*` | 会话 cookie + Origin 校验 |

---

## 2. 代理端点 `/v1/*`

### 2.1 `POST /v1/chat/completions`

#### 2.1.1 入站请求体（客户端视角，OpenAI 标准）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 可接受 **API ID**（`kimi-k2.7`）或**显示名**（`Kimi-K2.7-Code` / `GLM-5.3`），走 §2.1.2 第 3 步映射 |
| `messages` | array | 是 | `[{role, content, name?, tool_calls?}]`；**首条不必是 system**，我们补 |
| `stream` | boolean | 否 | 无论传什么，内部恒为 `true`；传 `false` 时我们聚合后返回非流式对象 |
| `max_tokens` | integer | 否 | < `limits.minMaxTokens`(默认 64) 时提升到 64 |
| `temperature` `top_p` `n` `stop` `presence_penalty` `frequency_penalty` `logprobs` `top_logprobs` `response_format` `seed` `tools` `tool_choice` `parallel_tool_calls` `user` | — | 否 | **原样透传**，不校验、不改写 |
| `stream_options` | object | 否 | **由本服务消费并删除**，不转发（上游不认）。上游本身每个 chunk 都带 `usage`，语义天然满足 `include_usage` |

未在表中的字段：**静默丢弃**（不做白名单拒绝，避免新客户端的一个新字段就把整个请求打挂）。

#### 2.1.2 代理改写管线（顺序不可调换）

```
[1] 鉴权        -> 见 §1.2；失败即 401/403，不产生上游请求
[2] 头隔离      -> 见 §1.3；allowlist 拷头 + 强制注入 ck_ 凭证
[3] 模型映射    -> model_catalog 三级查找；未命中 400 model_not_found（不转发）
                   命中后校验 key.scope；越权 403 model_not_allowed（不转发）
[4a] role 规范化 -> `developer`（大小写不敏感；上游只拒「精确小写」，见 §2.1.5）就地改写成 `system`，
                   写 note: developer_role_normalized（task#77）
[4a-2] role 白名单 -> 其余不在 system/user/assistant/tool 白名单内的 role 一律降级为 `user`（**保留内容**），
                   每个 distinct 原始 role 记 note: role_normalized_<role>（2026-10-07 方案 D：
                   上游对自定义 role 的容忍度是黑盒，白名单让失效模式从「整条挂」变「少一次语义」）
[4b] system 补全 -> messages[0].role !== 'system' 时头部插入；
                   首条是 system 但 content 为空白串时填充默认值
[5] stream 强制 -> body.stream = true 恒成立；记录 originalStream 决定响应形态
[6] max_tokens  -> 存在且 < minMaxTokens 时提升到 minMaxTokens
                   缺失时不补（交由上游默认）；> 8192 时不拦截，原样透传
[6b] system 提示改写 -> 档位 upstream.promptRewrite（默认 template，热更）：
                   `template` = 对 system 正文的 Claude Code 血统模板行做**语义等价改写**
                   （git 环境块标签行 + 身份句，破坏上游 ≥47 字符的 n-gram 指纹匹配，实测见
                   probe/05-11128-fix-plan.md），记 note: template_rewritten_<n>；
                   `neutral` = 把所有 system 换成中性提示，记 note: sysprompt_neutralized_<n>；
                   `off` = 不改写。零宽脱敏与身份词中性化均已被 D0 实验证伪，不做。
[7] UA 伪装     -> spoofUA=true 时覆盖 User-Agent（默认值见设置项 upstream.spoofUA）
[8] 发送        -> POST {upstream.baseUrl}/v2/chat/completions，stream:true
[8a] 11133 幂等重试 -> 上游回 400/11133（网关瞬时抖动，社区实测 [1s,4s,10s,25s] 阶梯可解）时
                   同 payload 重发，本实现取阶梯前两档（最多 2 次，总等待 5s 封顶 —— 自用场景
                   更长阶梯会占住并发槽）。每次重发计 retry_count 并记 note: retried（v0.2.0）
[8b] 11128 降级重试 -> 上游回 400/11128 且档位非 off 时：以 neutral 档重写**原始 body** 重发一次
                   （此时未向客户端写过任何字节，重试无副作用），记 note: sysprompt_degraded_retry。
                   仅重试一次；重试成功落入正常流式路径。兜「规则表漏掉上游新增指纹变体」。
```

**第 3 步：模型映射三级查找**（AC-06）

```
L1 精确匹配  model_catalog.id = 入参（小写精确）
L2 显示名    lower(model_catalog.display_name) = lower(入参)
L3 规范化    lower(replace(display_name, ' ', '-')) = lower(replace(入参, ' ', '-'))
             —— 覆盖 "Hy4 preview" -> "hy4-preview"
未命中       -> 400 model_not_found，并列出可用模型的 id 供客户端纠正
```

已知反例（**禁止靠推导**）：`Kimi-K2.7-Code → kimi-k2.7`、`Hy4 preview → hy4-preview`。这张表就是为这两个反例存在的。

**第 3 步附：scope 判定**

`client_keys.scope` 取值：

| scope | 判定规则 |
|---|---|
| `{"type":"all"}` | 放行 |
| `{"type":"family","value":"kimi"}` | `model.family === value`，family = API ID 的第一个 `-` 分段（`kimi-k2.7` → `kimi`） |
| `{"type":"tag","value":"夜间折扣"}` | `model_catalog.tag === value`；**模型无标签（`tag` 为 NULL）时不放行** |
| `{"type":"models","value":["glm-5.3", ...]}` | `id ∈ value` |

**实现位置与生效状态（2026-10-08 补齐）**：判定在 `server/src/proxy/model-scope.ts`（纯函数
`scopeAllowsModel`），由 `ProxyService.resolveModel()` 在**解析出模型之后**调用 ——
即 `resolveModel` 是唯一收口点，`/v1/chat/completions` 与 `/v1/messages` **共用**（两条链都只走它）。

> ⚠️ **这段判定此前不存在。** v0.1 起 `scope` 就写在表里、创建时也校验形状、界面上还有一列
> 「权限范围」，但**请求路径上从未有人读过它** —— `keyContext.scope` 被解析后就没下文了。
> 于是写着「仅 kimi 系」的密钥实际能调任何模型：一句**看起来已经生效的承诺**。
> 现已强制，越权 403 `model_not_allowed`（不转发，见 §5.1）。

判定细节（都有单测：`model-scope.spec.ts` 13 项 + `scope-enforcement.spec.ts` 11 项）：

- **大小写与首尾空白不敏感**：`family` / `models` 里的标识符按小写去空白比较。
  理由：`catalog.resolve()` 本来就按小写 id 查找，权限判定若严格区分大小写，
  会出现「模型能解析出来、却被判定越权」的分裂。方向是刻意偏**宽松** ——
  一个因拼错大小写而**静默拒绝一切**的权限配置，比容忍大小写危险得多。
- **`family` 是精确分段比较，不是前缀匹配**：`仅 hy3 系` 不会放进 `hy4-preview`。
- **判定用「解析后的 `id`」**：按显示名 `Kimi-K3` 请求，先在 L2 解析成 `kimi-k3`，
  再按 `kimi-k3` 判 scope —— 这正是把 scope 判定放在第 3 步「模型映射」**之后**的原因。
- **与既有两条检查的顺序**：① 未命中 → 400 `model_not_found`；
  ② 已下架 → 403（文案含「已在控制台下架」）；③ 越权 → 403（文案含本密钥的范围）。
  **先报全局、再报个体**：已下架的模型对所有密钥都不可用，先提示「越权」会把人引去改密钥权限。
- 越权同样**落一行 `requests`**（status=403、credits=0、`note: model not permitted`），
  且带上已解析出的 model —— 否则日志里只有一条「403 但不知道是哪个模型被挡」的记录。

**第 4 步：role 规范化 + system 补全**（AC-05）

```json
{"role": "system", "content": "<upstream.defaultSystemPrompt>"}
```

默认值 `You are a helpful assistant.`，可在 `config.yml` 的 `upstream.defaultSystemPrompt` 改（v0.1 不在 UI 暴露，**接口 25 项**已锁定；设置页只渲染 19 项 = 16 设置项 + 3 危险操作，见 `design-spec.md` §18.8 口径）。
`role` 为 `developer` 时**不再视为非 system**：先在 4a 步就地规范化为 `system`（大小写不敏感），写 `note: developer_role_normalized`，**不**触发插入。
（task#77 实测：上游**只拒精确小写 `developer`**——放在 `messages` 任意位置都回 400 + 11128；`Developer`（首字母大写）/`foo`/`knowledge` 等其它自定义 role 反被容忍。规范化**必须先于**下面的判断，否则首条 `developer` 会被误判成"无 system"而多插一条。）
插入时写 `note: system_injected`。

#### 2.1.3 非流式聚合算法（AC-04）

当 `originalStream === false` 时执行。**上游永远返回 SSE**，我们在内存里拼完再一次性返回。

```
acc = { id:"", created:0, model:"", content:"", reasoning:"",
        toolCalls: Map<index, {id,type,function:{name,arguments}}>,
        finishReason:null, usage:null }

for chunk in sse:
  c = chunk.choices[0]
  if (acc.id === "") acc.id = chunk.id
  if (acc.created === 0) acc.created = chunk.created
  if (acc.model === "") acc.model = chunk.model          // 保留上游真实 id
  acc.content    += c.delta.content ?? ""
  acc.reasoning  += c.delta.reasoning_content ?? ""
  for tc in (c.delta.tool_calls ?? []):
     合并：index 相同的 arguments 字符串追加；id/type/function.name 以首次非空为准
  if (c.finish_reason !== null) acc.finishReason = c.finish_reason
  if (chunk.usage) acc.usage = chunk.usage               // 取最后一个非空

响应体构建（OpenAI chat.completion）：
{
  "id": acc.id, "object": "chat.completion", "created": acc.created, "model": acc.model,
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": acc.content,
      "reasoning_content": acc.reasoning || undefined,
      "tool_calls": acc.toolCalls.size ? [...acc.toolCalls.values()] : undefined
    },
    "logprobs": null,
    "finish_reason": acc.finishReason ?? "stop"
  }],
  "usage": acc.usage ?? { prompt_tokens:0, completion_tokens:0, total_tokens:0 }
}
```

**中途失败**：非流式模式下，若流未完成就收到上游错误或连接断开 → **整个请求失败**，返回 §2.1.5 映射后的 HTTP 错误，**绝不返回半截 completion**（半截对象是沉默逻辑错误的高发区）。

#### 2.1.4 流式 SSE 出站格式

响应头（Nginx 侧同样必须配置，见 `deploy-security.md`）：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

报文体：上游每个 `chat.completion.chunk` JSON 原样单行输出，以 `data: ` 前缀 + 两个换行分隔；结束时发 `data: [DONE]`。

```
data: {"id":"01497f24","object":"chat.completion.chunk","created":1791014749,"model":"deepseek-v3","choices":[{"index":0,"delta":{"role":"assistant","content":"ok","reasoning_content":""},"finish_reason":null}],"usage":null}

data: {"id":"01497f24","object":"chat.completion.chunk","created":1791014749,"model":"deepseek-v3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":16,"completion_tokens":1,"total_tokens":17}}

data: [DONE]

```

三条硬规则：

1. **不改写 chunk 内容**（`model` 保留上游真实 ID，便于排障）。两个例外：
   - 上游 chunk 里若带非标准错误体，按 §2.1.5 处理。
   - **delta 空值归一化（2026-10-07）**：上游网关每个 delta 都塞满全量空字段（思考帧
     `{"content":"","reasoning_content":"词","tool_calls":[],…}`，一帧一词；答案帧反之），
     ai-sdk 系客户端（实测 ZCode / provider-utils 4.0.39）把夹在 reasoning 帧之间的空
     `content:""` 当分段边界 → **思考被拆成一词一段**（UI 一词一条「思考」块）。故转发前
     丢弃 delta 里的无信息空值（空串 / null / 空数组 / `function_call` 空壳）；顶层
     `id`/`model`/`created`/`usage` 与非空字段逐字节保留，干净帧不重序列化
     （`sse-stream.ts:normalizeChunkDelta`）。
2. **心跳**：距上一个 chunk 超过 15s 无数据，发一行 `: ping\n\n`（SSE 注释行，客户端忽略），防止 Nginx `proxy_read_timeout` 与客户端空闲超时把长思考链掐断。
3. **上游读超时两段式（v0.2.1 修复）**：`limits.firstByteTimeoutMs`（默认 30s）只约束
   「发请求 → 上游送出**首个数据帧**」；此前误用 `AbortSignal.timeout` 挂整个 fetch，成了
   **全程超时** —— agent 工具调用的长流（总时长 >30s、首字 8-9s 已到）在 30s 整被本服务
   自己掐断（生产实测 30009ms 必死，note=stream_abort）。首帧到达后总时长**不再有上限**，
   仅受空闲看门狗约束：上游**连续 5 分钟无任何字节**才中止（`sse-stream.ts:ReadGuard`，
   代码常量非设置项）。keepalive 注释行（有字节、无数据帧）只续看门狗、不解除首字超时。
   首字超时触发 → 504 `upstream_timeout`；看门狗触发 → 流中 error 帧（`stream_aborted`）。
4. **流中错误**：200 头已发出，无法改状态码。此时发一个 OpenAI 形状的 error 事件再 `[DONE]`：
   `data: {"error":{"message":"上游在流中途返回错误：11128","type":"upstream_error","code":"upstream_11128"}}\n\ndata: [DONE]\n\n`

#### 2.1.5 上游错误码映射

| 上游响应 | 我们返回 HTTP | 我们返回 `error.code` | 处理动作 |
|---|---|---|---|
| `11101`（必须 stream） | 502 | `upstream_11101` | 不应发生（我们强制 stream）。发生即记 `note`，说明上游协议变更 |
| `11102`（未知模型） | 400 | `model_not_available` | 把该模型在 `model_catalog` 标 `verified=0`，控制台提示"该模型当前账号不可用" |
| `11115`（**上下文超限**，2026-10-12 取证） | 400 | `context_length_exceeded` | **不重试**（同 payload 必然同样被拒，只白翻延迟）。上游原文实测 `prompt is too long: 1266460 tokens > 1048576 maximum`——是**推理前**的 token 计数拒绝（`first_byte_ms=NULL`、未计费）。message 会附上游原文，把「超了多少 / 上限多少」交代清楚；处置方向是客户端精简历史/工具输出，代理**不做静默截断**（截断等于替客户端改语义） |
| `11128`（**根因定案 2026-10-07：system 提示命中上游的第三方客户端模板 n-gram 指纹**；`developer` role 是另一独立触发点，见下表后注） | 502 | `upstream_11128` | `retryable=false`（同指纹重试必然同样被拒，徒增延迟；ZCode 曾因 `retryable=true` 连重 10 次）。防线两道：第 6b 步模板行改写 + 第 8b 步降级重试；走到这条映射 = 两道都没救回来 |
| `11133`（max_tokens 过小） | 400 | `invalid_max_tokens` | rewrite 已把 `max_tokens` 提到下限；若仍回 11133 说明是网关瞬时抖动 → **自动幂等重试**（[8a]，1s/4s 两档，note 加 `retried`）；重试耗尽仍失败才返回 400 |
| HTTP 429 | 429 | `rate_limited` | 按 `Retry-After` 排队重试 ≤ `limits.retryOn429` 次（默认 3） |
| HTTP 401 / 403 | **502** | `upstream_credential_invalid` | **不要原样 401/403**——会让客户端误判成自己的 `sk-waygate-` 密钥错了，排障方向直接跑偏。代码对上游 **401 与 403 共用同一映射**（`upstream-errors.ts:mapUpstreamHttpStatus`） |
| HTTP 5xx | 502 | `upstream_error` | 重试 ≤ 1 次 |
| 首字超时 / 连接超时 | 504 | `upstream_timeout` | 不重试 |
| 网络不可达 / DNS 失败 | 502 | `upstream_unreachable` | 不重试 |

> **`11128` 根因定案（2026-10-07，task#79 → D0/二分/T2，全文见 `probe/05-11128-fix-plan.md`）**：
> 上游在**推理之前**对 `system` 正文做**长 n-gram 模板指纹匹配**——最小触发窗口实测 **47 连续字符**
> （`[7996, 8043)`，恰好是 Claude Code 血统 git 环境块里的 `Main branch (…for PRs)` 模板行），
> 命中即 400/11128「unapproved channel」。判定特征：耗时 150–450ms、`first_byte_ms=NULL`（前置拒绝）。
> 已被**排除**的因子：UA/spoofUA（35+ 次直连探针全 200）、自定义请求头（FORWARD_ALLOWLIST 只有 4 个头，
> 根本没透传）、安全关键词零宽脱敏（D0 X1 全 400；社区亦证实上游归一化零宽字符）、身份词中性化
> （X2 全 400）。
> **`developer` role（task#77）是另一个独立的触发点**，仍由第 4a 步规范化处理。
> **修复（两层，均已真 key 实测）**：第 6b 步模板行**语义等价改写**（T2 实验 200，社区
> workbuddy2openai/buddy-proxy 独立同结论）+ 第 8b 步**降级重试**（fail-open）。
> （历史备注：task#77 时期曾把 `developer` 当作 11128 的唯一成因 —— 那只是当时探到的第一个触发点。）

**重试口径**（`build-plan.md` §2.3）：一次客户端请求 = `requests` 表一行。重试只增加 `retry_count`，**不新增行**。重试后成功按 200 计入成功率，`note` 追加 `retried`。

#### 2.1.6 积分计算与额度来源

**已消耗积分**：本机按上游 `usage` × 倍率计算（见下文），**有真实数据源**。

**剩余额度（订阅积分）：上游不提供该数据**（task#57 收口）。
服务器侧用**真 key** 打 `GET <upstream.baseUrl>/v2/billing/meter/get-user-resource` →
**HTTP 404 `404 page not found`（Go 默认 404，响应体里没有任何字段）**；同级只读候选路径
（`/v2/enterprises/personal/{usage,quota,credit,…}` 等）亦全部 `404 Route Not Found`。
**正对照**：同宿主同 key 打 `/v2/enterprises/personal/models` → **200 JSON** ✅ ⇒ 证明**真 key 有效、
host 正确**，故那个 404 是**真实的「上游没有」**。
⇒ 本服务**无法取得剩余积分**：`GET /api/overview` 的 `quota.available` 恒 `false`、
`reason=upstream_not_provided`，由 `message` 明确说明原因；**已消耗积分不受影响**。
服务端仍以**每天一次**的稀疏频率重探（万一上游将来加上），**不按 `pollSeconds` 高频白打**必然 404 的路径。

> ⚠️ **纠偏（勿再当既有事实）**：
> ① 早前「假 key → 401 ⇒ 端点存在（能供货）」**已被证伪**。假 key 的 401 是 **APISIX 在鉴权插件层
>    拒 token 格式**（`{"message":"invalid_format"}`），请求**根本没到上游**；只有**真 key** 才过鉴权、
>    命中路由、被代理到上游、由上游回 404。故 **401 不能**作为「后端会返回额度 JSON」的证据。
> ② 「网关按 UA 分流」这一说法本轮**未能复现**（真 key 有无 / 大小写 UA 都 404；假 key 有无 UA 都 401），
>    **未经证实，不作为事实**写入契约或代码注释。

**已消耗积分**（**唯一权威来源 = 上游 usage 直接回报的 `credit` 字段**；2026-10-07 校准实验发现，v0.5.8 起**取消一切本地兜底公式**）：

```
credits = usage.credit   ← 上游回报了真实账单（已含模型倍率与缓存折扣）→ note 加 credits_from_upstream
credits = NULL           ← 上游未回报该次费用（未知）              → note 加 credits_unknown
```

- ⛔ **不估算、不补零**（v0.5.8 口径铁律）：本项目是**反向代理**，一切以上游真实返回为准。
  上游没回报就是**未知**（`requests.credits = NULL`），绝不用本地公式 / 倍率造一个数 ——
  自造数字会让整个面板失去可信度。历史上曾用「本地校准公式」兜底（`multiplier-unknown` /
  `cache_discounted` 两个 note），v0.5.8 已**整段移除**（迁移 014 把 `requests.credits` 改为可空）。
- **账户级真实消耗另有权威来源**：如 MiniMax 的 `GET /minimax-cloud/api/v1/credit/details` 账本
  （`overview.creditLedgers`，见 §3.4）。请求级与账户级**口径分开呈现，不互相折算**。
- **校准锚点**（仅供理解上游计价，**本服务不再用它算任何数**）：deepseek-v4.1-flash ×0.11，真 key 实测
  2,604 tokens 无缓存 → 实扣 **0.08**；同一提示重发（94% 缓存命中）→ 实扣 **0.01**。
  ⇒ 官方按**每 1K tokens ≈ 0.28 基础价 × 模型倍率**计价且缓存大幅折扣；旧公式 `(pt+ct)×倍率`
  量纲差 1000 倍，曾把一条 26k tokens 的请求记成 2,910 积分（真实约 0.09）。
- `cached` = `usage.prompt_tokens_details.cached_tokens`（顶层 `usage.cached_tokens` 恒 0 是假值，见 task#62），
  仅用于展示与命中率，**不参与积分计算**（上游 credit 已含折扣）。
- `usage` 缺失（上游未返回）时：`credits = NULL`，`note` 追加 `usage_missing`，**不估算**。
- **失败行**：**本地拒绝**（`logRejection`：body 形状 / 越权 / 并发闸，请求根本没到上游）⇒ `credits = 0`
  （未消耗是**事实**）；**上游路径失败**（`fail`：不可达 / 非 2xx / 超时）⇒ `credits = NULL` + `note: credits_unknown`
  （上游到底计没计费**未知**）。两种情形分开表达，不把「不知道」写成「0」。
- 口径必须在界面明示：「已消耗积分以上游实扣为准（usage.credit）；上游未回报即**未知**（显示 `—`），本服务不估算」。

**`note` 取值集合**（逗号分隔，写入 `requests.note`，请求日志与控制台可见）：

> 本表是 `note` 的**写入侧唯一事实来源**。后端每新增一处写入都必须在此登记；前端 `noteLabel()` 的映射表与之对齐，门禁 `web/scripts/check-note-tokens.mjs` 机械比对「契约 ∪ 代码」是否都有可读映射。**动态取值族见本表之后的单独小节**（无法静态枚举）。

| 值 | 写入位置（文件:函数） | 触发条件 | 用户可读标签 |
|---|---|---|---|
| `developer_role_normalized` | `proxy/rewrite.ts:rewriteRequestBody()` | 出站前把 `developer`（大小写不敏感识别；上游只拒精确小写）就地规范化为 `system`（task#77，上游 11128，见 §2.1.2 第 4 步 / §2.1.5） | 已规范 developer 角色 |
| `sysprompt_degraded_retry` | `proxy/proxy.service.ts:ProxyService.doCall()` | 上游渠道校验拒绝（11128）后以 neutral 档**降级重试一次**（§2.1.2 第 8b 步）；出现在行上 = 该请求曾命中指纹并被降级（无论重试最终成败） | 命中渠道校验，已降级重试 |
| `system_injected` | `proxy/rewrite.ts:rewriteRequestBody()` | 入站首条消息非 system 时补注入 system（AC-04 / AC-05）。**注**：`developer` 已在第 4a 步被先规范化为 `system`，**不再**走此路（task#77） | 已补 system |
| `stream_options_stripped` | `proxy/rewrite.ts:rewriteRequestBody()` | 入站带了 `stream_options`：本服务消费其语义后**删除**、不转发（上游不认） | 已移除 stream_options |
| `usage_missing` | `proxy/proxy-log.ts:ProxyLogger.persist()` | 上游 chunk 未返回 `usage`：`credits = NULL`（未知），**不按 tokens 估算** | 上游未返回用量 |
| `minimax tokens unavailable` | `proxy/proxy.service.ts:ProxyService.doCall()` | Anthropic/MiniMax 出站所需 token 未能取得，无法建立上游请求 | MiniMax token 不可用 |
| `token refresh failed` | `proxy/proxy.service.ts:ProxyService.doCall()` | 已有 token 过期或刷新失败，出站请求未能建立 | 上游 token 刷新失败 |
| `missing credential` | `proxy/proxy.service.ts:ProxyService.doCall()` | 当前提供商未配置必要的上游访问凭证 | 缺少上游访问凭证 |
| `wb oauth unavailable` | `proxy/proxy.service.ts:ProxyService.buildWorkBuddyHeaders()` | [v1.6.11] WorkBuddy OAuth 服务未装配（部署异常），无法建立上游请求 | WorkBuddy 授权服务不可用 |
| `missing wb oauth credential` | `proxy/proxy.service.ts:ProxyService.buildWorkBuddyHeaders()` | [v1.6.11] WorkBuddy 尚未导入官方授权（ck_ 已退役）—— 需在控制台「重新导入授权」 | WorkBuddy 未导入授权 |
| `wb token refresh failed` | `proxy/proxy.service.ts:ProxyService.buildWorkBuddyHeaders()` | [v1.6.11] 已有 WorkBuddy 授权刷新失败，出站请求未能建立 | WorkBuddy 授权刷新失败 |
| `qoder credential invalid` | `proxy/proxy.service.ts:ProxyService.doCall()` | Qoder COSY 凭证无法通过网关校验，出站请求未建立 | Qoder 凭证无效 |
| `multiplier-unknown` | ~~`proxy/proxy-log.ts:ProxyLogger.persist()`~~ | **[历史·v0.5.8 起不再写入]** 旧本地兜底公式在倍率未知时按 1.0 中性估算并打此标记；公式已整段移除（上游未回报即 `credits = NULL`）。保留此行仅为**历史行仍可读**（前端映射表亦保留） | 倍率未知（历史：积分按中性估算） |
| `cache_discounted` | ~~`proxy/proxy-log.ts:ProxyLogger.persist()`~~ | **[历史·v0.5.8 起不再写入]** 旧本地兜底公式对缓存命中部分打折计价时打此标记；公式已移除。保留此行仅为**历史行仍可读** | 缓存命中已按折扣计（历史） |
| `credits_from_upstream` | `proxy/proxy-log.ts:ProxyLogger.persist()` | 上游 usage 回报了 `credit` 字段：本行积分 = 上游实扣原值（真实账单，已含倍率与缓存折扣，2026-10-07 校准实验发现） | 上游实扣积分 |
| `credits_unknown` | `proxy/proxy-log.ts:ProxyLogger.persist()` / `persistFailure()` | 本行积分**未知**（`requests.credits = NULL`）：上游未回报 `credit`，或上游路径失败无从得知是否计费。**不估算**，界面显示 `—`（v0.5.8） | 上游未回报积分 |
| `credits_recalibrated` | 一次性数据订正脚本（2026-10-07，非请求路径写入） | 2026-10-07 15:46 之前落库的历史行按校准量纲公式重算过积分（上游 credit 无法回溯，用校准公式近似）；同时按缓存折扣规则补 `cache_discounted` | 历史积分已重算 |
| `estimate_voided` | 一次性数据订正脚本（2026-10-11，非请求路径写入） | **作废旧估算**：该行积分原为本地兜底公式编造（上游从未回报费用），已改为 `credits = NULL`（未知）+ 追加本标记留痕。触发实例：MiniMax 免费模型的 2 条请求被旧公式记成 40.18 积分（100% 虚构） | 历史估算已作废（上游未回报） |
| `retried` | `proxy/proxy.service.ts`（[8a]/[8b] 重试路径，v0.2.0 起激活） | 对**同一请求**发生上游重发（11133 幂等重试 / 11128 降级重试）后追加；重试只加 `retry_count`、**不新增行** | 已自动重试 |
| `bad request body` | `proxy/proxy-log.ts:rejectionNote()` ← `proxy.service.ts:logRejection()` | 本地拒绝：请求体非 JSON 对象 / `messages` 非数组 / `model` 为空（400，不转发） | 请求体不合法 |
| `model not found` | `proxy/proxy-log.ts:rejectionNote()` | 本地拒绝：模型既非 API ID 也匹配不到显示名（400，不转发） | 模型不存在 |
| `model not permitted` | `proxy/proxy-log.ts:rejectionNote()` | 本地拒绝：命中 scope 越权或模型已在控制台下架（403，不转发） | 模型未授权 |
| `concurrency limit` | `proxy/proxy-log.ts:rejectionNote()` | 本地拒绝：本机并发闸已满（429，**不排队**） | 本机并发上限 |
| `stream_aborted` | `proxy/sse-stream.ts:readUpstreamSse()` | **上游侧**：流未收到 `[DONE]` 即结束，或读流抛错（上游断流 / 超时）→ 整段按失败处理，不返回半截 | 流式中断 |
| `client_detached` | `proxy/sse-stream.ts:readUpstreamSse()` | **客户端侧**：流式进行中客户端断开 / 写回失败（`proxy.controller.ts` 的 `close` 回调 → `events.return()` 提前终止生成器）。与 `stream_aborted` **分开**：两者排障方向相反（查客户端/网络 vs 查上游），`credits` 仍按已聚合 usage 计 | 客户端已断开 |
| `upstream unreachable` | `proxy/proxy.service.ts:ProxyService.doCall()` | 出站 `fetch` 抛异常（网络不可达 / DNS 失败） | 上游不可达 |
| `upstream empty body` | `proxy/proxy.service.ts:ProxyService.doCall()` | 上游返回 200 但响应体为空，无法读取流 | 上游返回空响应 |
| `upstream_11101` | `proxy/upstream-errors.ts:mapUpstreamBusinessCode()` | 上游业务码 `11101`（已被强制 `stream:true` 仍要求非流式 = 协议变更信号） | 上游要求强制流式 |
| `upstream_11128` | `proxy/upstream-errors.ts:mapUpstreamBusinessCode()` | 上游业务码 `11128`（**根因定案 2026-10-07**：system 提示命中上游的第三方客户端模板 n-gram 指纹；`developer` role 是另一独立触发点。模板行改写与降级重试两道防线均未救回才落此行，见 §2.1.5 注） | 上游渠道校验拒绝（提示指纹） |
| `model_not_available` | `proxy/upstream-errors.ts:mapUpstreamBusinessCode()` | 上游业务码 `11102`（当前账号未开通该模型，同时把该行标 `verified=0`） | 账号未开通此模型 |
| `invalid_max_tokens` | `proxy/upstream-errors.ts:mapUpstreamBusinessCode()` | 上游业务码 `11133`（`max_tokens` 过小，提升到下限后仍失败） | max_tokens 不合法 |
| `context_length_exceeded` | `proxy/upstream-errors.ts:mapUpstreamBusinessCode()` | 上游业务码 `11115`（prompt 超过模型上下文上限，推理前拒绝；message 附上游原文的 token 数） | 上下文超限 |
| `rate_limited` | `proxy/upstream-errors.ts:mapUpstreamHttpStatus()` | 上游 HTTP 429（重试次数已尽） | 命中上游限流 |
| `upstream_credential_invalid` | `proxy/upstream-errors.ts:mapUpstreamHttpStatus()` | 上游 HTTP 401/403（上游访问密钥失效或被吊销） | 上游访问密钥失效 |
| `upstream_error` | `proxy/upstream-errors.ts:mapUpstreamHttpStatus()`；`proxy/proxy.controller.ts` | 上游 HTTP 5xx / 未预期状态码 / 流中断 / 200 空体 | 上游错误 |

**`note` 动态取值族（无法静态枚举，前端兜底原样上屏）**：

| 值（模式） | 写入位置 | 触发条件 | 展示 |
|---|---|---|---|
| `max_tokens_raised_<n>_to_<m>` | `proxy/rewrite.ts:rewriteRequestBody()` | 入站 `max_tokens` 存在且低于下限（`MIN_MAX_TOKENS`）时提升；`<n>` = 原值，`<m>` = 提升后值 | 前端按模式兜底**原样展示**（不列入静态集合，故不进 `noteLabel` 映射表） |
| `template_rewritten_<n>` | `proxy/rewrite.ts:rewriteRequestBody()`（§2.1.2 第 6b 步，`upstream.promptRewrite=template`） | system 正文的 Claude Code 血统模板行被语义等价改写；`<n>` = 替换次数（真 ZCode 提示典型值 5–7） | 同上，兜底原样展示 |
| `sysprompt_neutralized_<n>` | `proxy/rewrite.ts:rewriteRequestBody()`（§2.1.2 第 6b 步，`upstream.promptRewrite=neutral`） | 所有 system 消息被整体替换为中性提示；`<n>` = 被替换的 system 条数 | 同上，兜底原样展示 |
| `role_normalized_<role>` | `proxy/rewrite.ts:rewriteRequestBody()`（§2.1.2 第 4a-2 步） | role 不在 `system/user/assistant/tool` 白名单内、被降级为 `user`；`<role>` = 净化后的原始 role 名（非法字符转 `_`、截 24 字符） | 同上，兜底原样展示 |
| `upstream_<上游业务码>` | `proxy/upstream-errors.ts:mapUpstreamBusinessCode()`（兜底分支） | 上游返回的业务码不在已知集合（`11101`/`11102`/`11115`/`11128`/`11133`）时，按 `upstream_<码>` 留痕 | 同上，兜底原样展示 |

**剩余额度**（**上游不提供该数据** → 如实标 `available:false`）：

```json
{
  "available": false,
  "reason": "upstream_not_provided",
  "remain": null, "total": null, "resetAt": null,
  "stale": false, "low": false,
  "message": "上游订阅未提供额度查询接口（GET /v2/billing/meter/get-user-resource 实测 404，同级候选路径亦无路由）。本服务无法取得剩余积分；「已消耗积分」仍按本地日志计算，不受影响。"
}
```

- **`reason` 取值**：`upstream_not_provided`（上游就没有这条接口，**当前恒为它**）｜`upstream_credential_missing`（未配上游密钥）｜`fetch_failed`（无旧值且网络/临时失败）｜`pending`（首次拉取未完成）｜`ok` / `stale`（**仅当上游将来真供货、取到值后才会出现**）。`available` 当且仅当 `reason ∈ {ok, stale}`。
- **`low`**：`remain < quota.warnBelow`（`warnBelow<=0` 视为不告警）——仅在取到 `remain` 时有意义。
- **轮询策略（区分两类失败）**：`404 / 路由不存在` → 判为 **`upstream_not_provided`**，退避到**每天一次**（不按 `pollSeconds` 高频白打）；网络 / 临时失败（超时、5xx）→ 仍按 `quota.backoffMaxSeconds` 指数退避**重试**。
- **失败可观测**：快照保留「最近成功时间」与「最近错误」，映射进 `message`。
- **字段可知性**：万一上游将来供货，解析只认真实出现的字段；拿不到即 `null`，**绝不用 remain / used 推算**。
- `quota.endpoint` 设置项**已废弃、不再使用**：端点恒由 `upstream.baseUrl` 现读现拼（单一来源）。

前端在 `available === false` 时**必须**渲染 `--` + `message`，**禁止**用 0 或任何编造数字占位。

---

### 2.2 `GET /v1/models`

鉴权：`sk-waygate-`（旧前缀 `sk-relay-` 已退役，不再接受）。

拉取策略（AC-07）：清单 = **上游目录 ∪ 本地种子 ∪ 实际请求过的模型**（见 §3.11 / ADR-004）。
上游端点 = `GET {upstream.baseUrl}/v2/enterprises/personal/models`（国内版 `copilot.tencent.com`，
需 `Authorization: Bearer <ck_>` 且伪装 `User-Agent`）；拉取失败**静默回落**，不是错误。

```json
{
  "object": "list",
  "data": [
    {
      "id": "kimi-k2.7",
      "object": "model",
      "created": 1791014749,
      "owned_by": "relay",
      "display_name": "Kimi-K2.7-Code",
      "family": "kimi",
      "tag": null,
      "multiplier": 0.57,
      "source": "seed",
      "verified": 1
    }
  ]
}
```

`display_name` / `family` / `tag` / `multiplier` / `source` / `verified` 是**扩展字段**，OpenAI 客户端会忽略未知字段，不影响兼容。

`source` 取值：`upstream`（上游目录拉到）/ `seed`（随版本发布的本地种子）/ `observed`（实际成功调用过，
`requests.status=200`）/ `manual`（人工写入）。同一 id 命中多源取「更硬」者：`upstream > manual > seed > observed`。
**`observed` 不得伪装成订阅清单**——只被观测到的模型必须标 `observed`。

`multiplier` **可为 `null`**：/v3/config 接口与本地快照都缺该模型时返回 `null`（= 倍率未知），
**不得编造一个 1.0**。（v0.2.1 起倍率以 /v3/config 接口实时值为准，见 §3.11。）

---

### 2.3 `GET /healthz`

不鉴权。给 Nginx / 运维探活用，**信息最小化**。

```json
{"status": "ok", "version": "0.4.1"}
```

禁止包含：上游地址、密钥状态、数据库大小、客户端数量。这些只能从 `/api/overview`（需会话）拿。

---

### 2.4 `POST /v1/messages`（Anthropic Messages 适配层）

> ⚠️ **Anthropic 形状是本服务新增的翻译层，不是上游能力。**
> 上游订阅侧**只有 OpenAI Chat Completions**：`/v2/messages`、`/v2/responses` 实测**均 404**；
> 唯一可用的 `/v2/chat/completions` **只接受流式**（非流式回
> `{"code":11101,"msg":"Non-stream chat request is currently not supported"}`）。
> 因此本端点把 Anthropic 请求**翻译成** OpenAI 请求打上游，再把上游响应**翻回** Anthropic 形状。
> 这也是「本服务对上游恒发 `stream:true`」的上游事实依据（见 §2.1.2 第 5 步 / §2.1.5 的 `11101`）。

鉴权：`sk-waygate-` 密钥（旧前缀 `sk-relay-` 已退役，不再接受）。两种头都接受 —— `x-api-key: <key>`（Anthropic SDK 默认）或
`Authorization: Bearer <key>`（兼容）。**走的是同一个 `ClientKeyGuard`**（hash 比对 / 停用 / 过期三步完全一致，
`x-api-key` 仅在做鉴权前归一化为 `Authorization: Bearer`）。

#### 2.4.1 入站请求体（Anthropic Messages 形状）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 同 §2.1.2 第 3 步三级查找（API ID 或显示名） |
| `max_tokens` | integer | 是 | Anthropic 必填；映射到上游 `max_tokens`（< 下限仍按 §2.1.2 第 6 步提升） |
| `system` | string \| block[] | 否 | → 首条 `role:"system"`；blocks 取其 `text`，多块以 `\n` 连接 |
| `messages` | array | 是 | `{role, content}`；`content` 为 string 或 block 数组 |
| `tools` | array | 否 | `{name, description, input_schema}` → OpenAI `{type:"function", function:{name, description, parameters}}` |
| `tool_choice` | object | 否 | `{type:"auto"}`→`"auto"`、`{type:"any"}`→`"required"`、`{type:"none"}`→`"none"`、`{type:"tool",name}`→`{type:"function",function:{name}}` |
| `stop_sequences` | string[] | 否 | → 上游 `stop` |
| `stream` | boolean | 否 | true → Anthropic SSE（§2.4.3）；false/缺省 → 聚合后返回单个 `message`（§2.4.2） |
| `temperature` `top_p` | number | 否 | 原样透传 |
| 其它未列字段 | — | 否 | **静默忽略**（不报错、也不透传；与 §2.1.1 同口径） |

**`messages[].content` 内 block 的翻译**：
- `text` → 文本；`image`（`source.type = base64 | url`）→ OpenAI `image_url` part；
- assistant 的 `tool_use` → 该条 assistant 消息的 `tool_calls`（`input` 序列化为 `function.arguments`）；
- user 的 `tool_result` → **独立的** `role:"tool"` 消息（带 `tool_call_id`）；同条 user 里的文本/图片另起一条 `role:"user"`。

#### 2.4.2 非流式响应体

```json
{
  "id": "msg_…", "type": "message", "role": "assistant", "model": "kimi-k2.7",
  "content": [
    {"type": "text", "text": "你好"},
    {"type": "tool_use", "id": "call_1", "name": "get_weather", "input": {"city": "深圳"}}
  ],
  "stop_reason": "end_turn", "stop_sequence": null,
  "usage": {"input_tokens": 5, "output_tokens": 2}
}
```

`finish_reason` → `stop_reason`：`stop`→`end_turn`、`length`→`max_tokens`、`tool_calls`→`tool_use`
（`content_filter`→`refusal`，其它未识别→`end_turn`）。`usage.prompt_tokens/completion_tokens`
→ `input_tokens/output_tokens`。`tool_use.input` = 对上游 `function.arguments` 做 `JSON.parse`。
**中途上游出错/断流 → 整个请求按失败处理，绝不返回半截 `message`**（与 §2.1.3 同口径）。

#### 2.4.3 流式 SSE（**必带 `event:` 行**，顺序固定）

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_…","type":"message","role":"assistant","model":"kimi-k2.7","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":5,"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
```

工具调用（`tool_use` 块）：`content_block_start{content_block:{type:"tool_use", id, name, input:{}}}` 起块，
随后每个参数分片发 `content_block_delta{delta:{type:"input_json_delta", partial_json:"…"}}`，
客户端按序拼接 `partial_json` 即为工具入参 JSON（`content_block_start` 先于任何 `input_json_delta`）。

三条硬规则（与 §2.1.4 一致）：**① 逐块透传不缓冲**（首字延迟 = 上游首字延迟）；
**② 空档 >15s 发 `: ping` 注释行**保活；**③ 流中途出错**发一个 `event: error` 帧
（`data` 为 §2.4.4 的 Anthropic 错误体）。

**字段诚实性**：`message_start.message.usage` 的 `input_tokens`/`output_tokens` 在上游给出 usage
**之前不可得**，此处以 `0` 占位（Anthropic 自身在 message_start 也用 `output_tokens:0`），
**权威值在末尾 `message_delta.usage` 给出**。除此之外**任何字段都不以"看着像"的假值填充** ——
拿不到就留空/省略，`stop_reason` 认不出就按 §2.4.2 兜底，绝不编造。

#### 2.4.4 错误形状（Anthropic，与 OpenAI **不同**）

`/v1/messages` 的**所有**错误（含未鉴权 401、含守卫层抛出的）都是 Anthropic 形状：

```json
{"type":"error","error":{"type":"authentication_error","message":"Invalid API key provided. 请检查密钥是否有效、是否被停用或已过期。"}}
```

httpStatus → `error.type`：400→`invalid_request_error`、401→`authentication_error`、
403→`permission_error`、404→`not_found_error`、413→`request_too_large`、429→`rate_limit_error`、
529→`overloaded_error`、≥500 → `api_error`。上游错误码映射（§2.1.5）照旧：上游 401/403 →
**502 `api_error`**（不原样回 401，避免客户端误判成自己的 `sk-waygate-` 密钥错了）。

#### 2.4.5 审计与并发（复用既有管线，不另起一套）

本端点**不绕过**代理管线：鉴权走 `ClientKeyGuard`；并发闸 / 首字超时 / 上游错误映射走
`ProxyService`；落库走 `ProxyLogger` 的 `beginContext` / `persist` / `persistFailure` / `persistGuard`。
因此 §6 第 7 条审计不变式（**必有且仅有一行**）对 `/v1/messages` 同样成立；未鉴权（守卫层拒绝）
与框架层拒绝（畸形 JSON / 超 `bodyLimit`）两类例外同 §6 边界 (a)(b)。

---

## 3. 控制台端点 `/api/*`

统一信封：`{"code":0,"data":{...},"message":""}`。`code=0` 为成功。

### 3.1 `POST /api/auth/login`

请求：`{"password": "<管理口令>"}`

| 结果 | 响应 |
|---|---|
| 成功 | `200`，`data:{expiresAt:"<ISO>"}`，`Set-Cookie: relay_sid=…; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=43200` |
| 口令错 | `401`，`code:40101`，`message:"管理口令不正确"` |
| 触发限流 | `429`，`code:40290`，`data:{retryAfterSeconds: 600}` |

口令校验用 **timing-safe compare**。口令哈希由环境变量 `RELAY_ADMIN_PASSWORD_HASH`（scrypt，`scrypt$N$r$p$<salt_b64>$<hash_b64>`）提供；首次启动若未提供，生成随机 16 字符口令**打印到 stdout 一次**，哈希写入 `data/admin.hash`（`chmod 600`），**明文不落盘**。

#### 3.1.1 来源 IP 的取法（审计与限流都依赖它）

限流按**来源 IP** 分桶，日志也记它，因此取错会同时废掉两个能力。

- `src/main.ts` 刻意设 Fastify `trustProxy: false` —— 防止客户端用 `X-Forwarded-For`
  头伪造 `remoteAddress`。**代价是 `req.ip` 恒为 Nginx 的 `127.0.0.1`。**
- 所以真实客户端 IP 必须由应用层**显式**从 `X-Forwarded-For` 取：
  统一走 `src/common/client-ip.ts` 的 `clientIpOf(req)`。
- **取末段，不是首段。** Nginx 侧已把 XFF 改为**覆写**
  （`proxy_set_header X-Forwarded-For $remote_addr`）；后端仍取末段作为纵深防御。
  若两侧都按"追加 + 取首段"处理，客户端自填的 `1.2.3.4` 会被当真 —— 实测确认过。

> 实测踩坑：最初登录控制器直接用 `req.ip`，日志全是 `ip=127.0.0.1`，
> 且所有客户端共用同一个限流桶（本机与公网请求的累计计数连号）。

#### 3.1.2 登录审计日志

失败与成功都记，**绝不记口令内容、长度或任何派生值**：

```
WARN [AuthController] 登录失败（口令不正确）ip=<客户端IP> ua="<UA>" 累计失败 N 次[，已锁定 Ms]
LOG  [AuthController] 登录成功 ip=<客户端IP> ua="<UA>"
```

- UA 会清洗控制字符并截断到 120 字符（防日志注入与刷屏）。
- 对端不是回环却带着 XFF 时，额外附 `peer=<对端>(XFF 与直连对端不一致)`，提示有人伪造头。
- 查看：`journalctl -u relay | grep AuthController`
  （注：Nest 的 `warn` 经 stdout 输出后 systemd 不会打上优先级标记，
  所以 `journalctl -p warning` **捞不到**，需按关键字 grep）

#### 3.1.3 `POST /api/auth/password/reset` — 重置管理口令

**必须在已登录会话内调用**（端点挂在 `SessionGuard` 之后）。未登录 → `401`。

无请求体 —— **新口令由服务端随机生成**，不接受客户端传入。

```json
{"code":0,"data":{"password":"mthWs2nPPPrVU5Qz","persisted":true},"message":"ok"}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.password` | string | 16 字符新口令明文。**这是唯一一次能拿到它的机会** |
| `data.persisted` | boolean | `true`=哈希已落库，重启后仍有效；`false`=仅内存生效（库不可写），**重启会回到旧口令** |

##### 为什么不接受客户端传入新口令

让用户自己填口令会把「弱口令」变成产品责任。服务端生成的 16 位随机口令，
字符集为 `abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789`
（**已去掉 `0/O/1/l/I` 等易混字符**，降低人工誊抄出错率），熵远高于典型人工口令。

> **注**：本条（随机重置）**不接受**客户端传入新口令。若用户希望自己设定一个
> 方便记忆的口令，用 §3.1.4 的 `PUT /api/auth/password` —— 那是独立的端点，
> 有独立的最小长度校验，语义与本条不同（详见下）。

##### 为什么不做「忘记口令」的自救通道

不做令牌/邮件找回 —— 这需要引入第二条信任链（邮件服务、找回令牌存储），
对本产品「单管理员、自部署」的定位得不偿失。忘记口令的恢复路径是
**上服务器直接改库**（见 §9.4 部署清单）；代价是**必须重启服务**才生效，
因为内存里的 `storedHash` 只在 `onModuleInit` 与 `reset()` 两处被更新。

##### 明文的行为边界（安全上最关键）

- 明文只经**这一个响应**交出去，**不落盘、不进日志、不缓存**。
- 服务端**不长期持有明文**（不是成员变量），用完即弃。
- 数据库里只有 `scrypt` 存储串 —— 所以**没有「再次查看」接口**，
  前端也不该给一个在真机上必然失败的「查看」按钮。
- 重置**热生效、无需重启**：`reset()` 先写库、再无条件更新内存 `storedHash`。
- 落库失败**不抛 500**，降级为 `persisted:false` —— 内存已能生效，
  不该因为磁盘问题让用户拿不到新口令（那样他既用不了旧的、也拿不到新的）。

##### 落库位置与备份

写入 `admin_credential` 表（单行表，`id` 恒为 1）。它与 `relay.db` 同处
`/var/lib/relay/`，因此**会跟着每日 `VACUUM INTO` 备份一起走** ——
这是数据库方案相对早期 `admin.hash` 文件的实质优势。

##### 加载优先级（四级回落）

```
① RELAY_ADMIN_PASSWORD_HASH 环境变量   ← 运维显式设定，最高
② admin_credential 表                  ← 控制台改密后落在这里
③ <数据目录>/admin.hash 文件           ← 兼容旧部署；读到后**顺手迁进库**
④ 都没有 → 生成随机口令，打印到 stdout 一次，写入数据库
```

第 ③ 级是刻意保留的：升级前用户手上有效的口令只存在于文件里，
若跳过它，升级完就变成「口令被换了、新口令只在日志里」= 把自己锁在门外。
读到文件后立即 `upsert` 进库，之后改密会**同步刷新文件**（防将来回退到旧口令）。

#### 3.1.4 `PUT /api/auth/password` — 手动设定管理口令

**必须在已登录会话内调用**（端点挂在 `SessionGuard` 之后）。未登录 → `401`。

请求体携带用户输入的**明文新口令**：

```json
{"password":"my-easy-to-remember-pw"}
```

成功：

```json
{"code":0,"data":{"persisted":true},"message":""}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.persisted` | boolean | `true`=哈希已落库，重启后仍有效；`false`=仅内存生效（库不可写），**重启会回到旧口令** |

##### 与 §3.1.3（随机重置）的分工

| | §3.1.3 `POST /auth/password/reset` | §3.1.4 `PUT /auth/password`（本条） |
|---|---|---|
| 口令来源 | 服务端随机生成 16 位 | **用户输入** |
| 请求体 | 无 | `{"password":"…"}` |
| 响应回显明文 | **是**（`data.password`，唯一一次） | **否** —— 用户本就知道明文，回显只多开一条泄漏通道 |
| 语义 | 「触发一次生成」= 动作 | 「把口令设定为某个值」= PUT 资源 |

两者都在同一条 `SessionGuard` 之后（改密是已登录用户的自我服务操作，不是「忘记口令」自救）。

##### 校验规则（均在服务端强制执行）

- **拒绝非字符串**入参（不静默 `String()` 转换）。
- **拒绝纯空白**：`trim()` 后为空即拒（否则等于允许一个「看不见的」空口令）。
- **长度 ∈ [8, 128]**：
  - 下限 8 —— 这是控制台唯一入口凭据，不设下限等于允许弱口令/空口令。
  - 上限 128 —— scrypt 是 CPU 密集的，超长输入会被同步 scrypt 放大成可观的
    CPU 占用，成为一条廉价的 DoS 面。
- 校验失败 → `400` / `code 40001`，message 用中文**指明具体哪里不合格**
  （例：`管理口令至少 8 个字符，当前 7 个。`）。
- 校验失败时**内存哈希纹丝不动** —— 旧口令仍能通过（已被测试钉住）。

##### 会话不失效

改密**不把当前登录踢下线**：会话是 `HMAC(RELAY_SECRET, payload)` 的
自包含 cookie（见 §1.4 / `auth/session.ts`），与口令哈希**无关**。
所以「同一个人改自己的口令」后，当前这一步不需要重新登录。
（其它浏览器里的旧会话也仍然有效，直到各自过期 —— 这是刻意的：
会话凭据是 `RELAY_SECRET`，不是口令。若需要强制下线，那是另一项能力，本版本不做。）

##### 明文的生命周期

- 明文只在**请求体**里出现，服务端吃进即弃（`AdminCredentialService.setPassword`），
  与 `reset()` 一样**绝不落盘、绝不进日志**。
- 响应**不含**明文。
- 前端**不得**把口令写入 localStorage / sessionStorage / cookie / URL。

### 3.2 `POST /api/auth/logout`

`200`，清 cookie（`Max-Age=0`）。无状态令牌，服务端无需作废操作。

### 3.3 `GET /api/auth/session`（SPEC §5.2 未列，前端首屏需要）

```json
{"code":0,"data":{"authenticated":true,"expiresAt":"2026-10-03T18:00:00.000Z"}}
```

未登录返回 `authenticated:false`，**不返回 401**（避免控制台首屏控制台报一片红）。

### 3.4 `GET /api/overview`

`?window=today`（默认）| `1h` | `24h` | `7d` | `30d`

> [2026-10-08] 新增 `today`：**本地零点到现在**（日历日语义，不是滚动的 24h）。
> 用户要"今天到目前为止花了多少"，跨夜清零才符合直觉。趋势桶用**小时**（同 24h）。
> [2026-10-09] 默认窗口由 `24h` 改为 **`today`**（控制台三页的默认口径；服务端
> `resolveWindow(undefined)` 同步改，`DEFAULT_WINDOW_KEY`）。
> [v0.5.11] `trend[]` 新增 `tokens`（本桶总 tokens）与 `models`（本桶按模型 token 消耗
> 的前 5 名，服务端排好序）。趋势图的**主量纲**从积分换成 token —— 积分对 MiniMax
> 是未知/免费（`credits = null` 不进合计），看积分会把 MiniMax 的量整个隐掉；token 是
> 跨提供商的普适量纲。`credits` 字段保留（口径不删）。每桶切片是 top-5**截断**：
> Σmodels ≤ 该桶 tokens（截断只许少，超出即编数）。

```json
{
  "code": 0,
  "data": {
    "window": "24h",
    "generatedAt": "2026-10-03T06:12:44.000Z",
    "alerts": {
      "channelReject": {"count": 0, "threshold": 3}
    },
    "quota": {
      "available": false,
      "reason": "upstream_not_provided",
      "remain": null, "total": null, "resetAt": null,
      "stale": false, "low": false,
      "message": "上游订阅未提供额度查询接口（GET /v2/billing/meter/get-user-resource 实测 404，同级候选路径亦无路由）。本服务无法取得剩余积分；「已消耗积分」仍按本地日志计算，不受影响。"
    },
    "metrics": {
      "requests": 1284,
      "creditsUsed": 1158.00,
      "successRate": 0.982,
      "avgLatencyMs": 1840,
      "activeClients": 4,
      "promptTokens": 1052880,
      "completionTokens": 269640,
      "totalTokens": 1322520,
      "cachedTokens": 389566,
      "cacheHitRate": 0.37,
      "creditsUnknownCount": 37
    },
    "concurrency": {"active": 2, "limit": 8},
    "trend": [
      {"bucket": "2026-10-03T00", "requests": 96, "credits": 88.5, "tokens": 98_880, "errors": 2,
       "models": [{"model": "kimi-k3", "tokens": 61_200}, {"model": "deepseek-v4.1-flash", "tokens": 37_680}]}
    ],
    "byModel": [
      {"model": "kimi-k3", "displayName": "Kimi-K3", "multiplier": 1.62, "tag": "订阅优先", "requests": 402, "tokens": 700_000, "credits": 651.24, "share": 0.529},
      {"model": "some-upstream-model", "displayName": "Some Model", "multiplier": null, "tag": null, "requests": 12, "tokens": 10_580, "credits": 9.8, "share": 0.008}
    ],
    "byClient": [
      {"clientId": "MiniMax Code", "client": "MiniMax Code", "requests": 760, "tokens": 688_000, "credits": 602.00, "share": 0.520}
    ],
    "byTool": [
      {"tool": "Claude Code", "requests": 760, "tokens": 688_000, "credits": 602.00, "share": 0.520},
      {"tool": null, "requests": 4, "tokens": 1_300, "credits": 1.20, "share": 0.001}
    ],
    "unknownUas": [
      {"ua": "WeirdClient/9.9 (unknown-build)", "requests": 4}
    ],
    "recent": [
      {"id": 10241, "ts": "2026-10-03T06:12:44.000Z", "clientId": "k_8f21", "client": "Claude Code",
       "model": "kimi-k3", "status": 200, "ms": 1840, "credits": 1.62, "note": ""}
    ],
    "provenance": {
      "creditsUsed": "local",
      "quotaRemain": "none",
      "note": "已消耗积分仅统计经本服务转发的请求（取上游实扣 usage.credit；上游未回报的行积分未知，不计入合计，见 metrics.creditsUnknownCount）；官方客户端直连不计入，账户总消耗以官方客户端为准）；剩余积分上游不提供（额度接口实测 404），不做估算。"
    }
  }
}
```

**`provenance` 是强制字段**（`build-plan.md` 纪律 4）：每个数字都必须标明来源，前端不得省略。

**`metrics.creditsUnknownCount`（v0.5.8）**：本窗口内 `requests.credits IS NULL` 的行数 —— 即「上游没回报积分、
本服务不估算」的请求条数。前端必须在 KPI 卡片上明示「N 条上游未回报，未计入」，否则合计看起来
像是「全部消耗」，而它其实只是**已知部分**。

**一致性保证**：`byModel` 的 `credits` 之和、`byClient` 的 `credits` 之和、`metrics.creditsUsed` 三者**由服务端同一次聚合查询产出并断言相等**（差值为 0 才返回；否则记 warn 并返回修正后的值）。前端**禁止自行求和渲染**，只能渲染服务端给的字段。**未知行（`credits IS NULL`）对合计的贡献为 0**（聚合表 `SUM` 口径），行本身的 `null` 语义只保留在 `requests` 表（请求日志显示 `—`）。

**`share` 口径（v0.5.18 起为 Token 占比）**：`byModel[]` / `byClient[]` / `byTool[]` 三路的 `share` = 该行 `tokens` ÷ 本窗口 `metrics.totalTokens`（取值 `0..1`），由**服务端**算，前端不得自行求和再相除。
- **此前按积分占比**（`credits ÷ metrics.creditsUsed`）。改动原因：用量页与概览页的模型/客户端表**都按 tokens 排序**（token 自 v0.5.11 起是这两页的主量纲），占比若按积分算就会与排序键错位 —— 百分比自上而下不再单调、条形长度与排序顺序互相矛盾（用户实测报障），故统一为 token 口径，使**排序键、占比、条形长度三者同源**。
- **`credits` 字段语义不变**：仍是上游实扣的真实账单（见 §2.1.2），本次只改 `share` 的分母口径，不动 `credits` 本身，也不把「已消耗积分」等指标改成 token。

##### tokens 与缓存命中指标（task#62）

`metrics` 在 v0.1 之后追加 5 个**本地可算**的字段，用于替换上游取不到的「订阅剩余积分」：

| 字段 | 含义 |
|---|---|
| `metrics.promptTokens` | 本窗口输入（prompt）tokens 合计 |
| `metrics.completionTokens` | 本窗口输出（completion）tokens 合计 |
| `metrics.totalTokens` | 本窗口总 tokens 合计 |
| `metrics.cachedTokens` | 本窗口**缓存命中**的 prompt tokens 合计 |
| `metrics.cacheHitRate` | 命中率 = `cachedTokens / promptTokens`，取值 `0..1` |

**口径**：

- 全部由 `requests` 表同一区间 `SUM` 得出（与 `creditsUsed` 同源，天然可对账）。
- `cachedTokens` 的采集真值是 **`usage.prompt_tokens_details.cached_tokens`**（回落
  `usage.prompt_cache_hit_tokens`）。⚠️ **顶层 `usage.cached_tokens` 恒为 0 是假的，绝不能读** ——
  见 `server/src/proxy/usage-tokens.ts` 与 `requests.cached_tokens` 列注释。
- **anthropic 协议（MiniMax）的输入口径（v0.5.10 纠偏）**：Anthropic 的 `input_tokens`
  **不含**缓存部分 —— 真输入 = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  三者相加（生产实测形态：input=43 / cache_read=128）。响应方向转换器
  （`anthropic-upstream/stream-decode.ts`）按此合成 OpenAI 形状的 `prompt_tokens`；
  `cached_tokens` 只取 `cache_read_input_tokens`（**读**命中才算，cache_creation 是写不算）。
  旧实现直接用 `input_tokens` 当 prompt，导致 prompt 被低估、`cached_tokens > prompt_tokens`
  （命中率 297%）—— 这正是 `cacheHitRate` 超出 `0..1` 的唯一已知成因。
- **`cacheHitRate` 为 0 就是 0**（DeepSeek 系上游真实返回 `cached_tokens: 0`），
  是**真值**，不是「上游未提供」。前端必须渲染成 `0.0%`，**不得**回退到任何「未提供」文案。
  `promptTokens === 0`（如全失败窗口）时命中率定义为 `0`（不是 NaN）。

**`requests.reasoning_tokens`（v0.2.0 / schema v6）**：请求日志行新增
`reasoningTokens` 字段 —— 输出里的**思考 tokens**（上游计费口径：`completion_tokens`
**包含** reasoning）。真值 `usage.completion_tokens_details.reasoning_tokens`（回落顶层
`completion_thinking_tokens`）；取不到为 0，不估算。**积分公式不变**（思考已含在
completion 里，上游实扣 credit 也已含）。历史行（v6 之前）为 0。

**`byModel[].multiplier`**：该模型**当前**倍率，取自 `model_catalog`（`LEFT JOIN`，故目录里没有该模型时也是 `null`）。
- `null` = **倍率未知**（目录里没有该模型 / 上游 `/v3/config` 未覆盖）。**仅描述倍率本身**——
  v0.5.8 起积分**不再依赖倍率**（一律取上游实扣 `usage.credit`，未回报即 `NULL`），
  故倍率未知**不影响** `credits` 的可信度：`credits` 是否可信只看它是不是 `null`。
- **前端必须在 `multiplier === null` 的行标注「倍率未知」**，不得把 `null` 当成某个具体倍率渲染。
- 该字段**只加在 `byModel`**，不加在 `byClient`（倍率是模型属性，与客户端无关）。

**`byModel[].tag`（2026-10-08 新增）**：该模型的计价标签（`限时免费` / `限时折扣` / `夜间折扣` / `订阅优先`），
取自 `model_catalog.tag`，`null` = 无标签。**这是「这行为什么这么便宜」的直接答案**——
17 项种子模型里 12 项有标签，此前只在「模型清单」里出现，用量页没渲染。
与 `multiplier` 同一条纪律：只加在 `byModel`。同行的 `multiplier === null` 标注（琥珀，「这个数是估的」）
与本字段（青，「数可信且优惠」）**语义相反，配色必须能分开**。

**`byTool[]` 与 `unknownUas[]`（2026-10-08 新增）**：按「**请求来自哪个工具**」聚合。

- `byTool[].tool`：从 `requests.ua` **现解析**的软件名；`null` = 认不出来（没采到 UA 或不在关键词表里）。
  同一工具的多个 UA 版本（版本号不同）会**合并成一行**。
- `byTool[].tokens`（v0.5.18 新增）：该工具本窗口总 tokens。`byTool` 行字段现为
  `tool` / `requests` / `tokens` / `credits` / `share`，**按 `tokens` 降序**（此前无 `tokens`、按积分排序），
  `share` 亦为 token 占比（见上文「`share` 口径」）。
- `unknownUas[]`：认不出来的 **UA 原文** + 请求数（TOP 10）。**空 UA 不入列** ——
  空 UA 是「压根没采到」，不是「某个未知工具」，列出来只会让人以为漏配了关键词。
- 口径与 `byModel` / `byClient` 相同：`ΣbyTool.credits === metrics.creditsUsed`（同一份 `requests` 的第三种切法）。
- ⚠️ **`byTool` 与 `byClient` 回答两个不同的问题**：`byClient` = 哪个客户端**服务**的
  （[v0.5.15] 按 模型 id → 目录 `provider` 解析，与请求日志「提供商」列同源；模型不在任何
  生效目录里的行回落到密钥归属 `client_id`。此前按密钥归属，双绑定密钥的全部流量都记在
  第一个绑定下），`byTool` = 哪个工具**发**的（UA 判定）。同一把密钥被多个工具共用时，
  只有 `byTool` 能看出来。
  之所以不做进 `client_id`：那会破坏 `spec-v4-client-id.md` 的 AC-C01（改名后条数与积分数必须一字不变）。
- 关键词表 `server/src/identify/ua-table.ts` 是**读取时解释**，增补后立刻对历史行生效、无需回填。
  这也是 `unknownUas` 存在的理由：它让「该往表里加什么关键词」成为可行动的信息。

**`clientId`（稳定标识）**：`byClient[]` 与 `recent[]` 都带 `clientId`（= 该客户端对应的密钥 id；兜底客户端恒为 `'unidentified'`）。`client` 字段一律是后端经 `resolveClientName` 解析后的**当前显示名**；前端**筛选用 id、显示用名**，禁止把裸 id 当名字上屏（字段口径见 `spec-v4-client-id.md` §5）。

**`concurrency`**：`{ active, limit }` —— `active` = 当前**在途（已占用并发槽位）**的代理请求数；`limit` = 当前生效的并发上限（`limits.concurrency` 封顶在硬上限 `32`）。
- **为什么必须暴露**（task#37）：`ctx.release()` 一旦被某条失败路径跳过，`active` 会**单调上涨**直到并发闸打满 → **永久 429**，而这是从外部**看不见**的失败状态（只能靠偶发症状反推）。给出这两个数，泄漏立刻可见。
- 只挂本**会话保护**端点；**不进公开的 `/healthz`**（后者无鉴权，不应泄露运行态细节）。

### 3.5 `GET /api/clients`

`?window=24h`

```json
{"code":0,"data":{"items":[
  {"clientId":"k_8f21","client":"Claude Code","rule":2,"ruleLabel":"密钥归属","requests":760,
   "credits":602.00,"models":["kimi-k3","glm-5.3"],"lastSeenAt":"2026-10-03T06:12:44.000Z",
   "boundKeyIds":["k_8f21"],"named":true,"share":0.520}
]}}
```

`rule` ∈ `1|2|3|4`，见 §4。`rule=4` 的「未识别」是**正常分支不是错误**，前端用琥珀描边卡，不告警、不阻断。

### 3.6 `GET /api/requests`

`?page=1&limit=20&status=&client=&model=&q=&from=&to=&sort=ts&order=desc`

- `status`：`all`（默认）| `success`（< 400）| `error`（≥ 400）| 具体数字
- `q`：对 `model` / `client` / `note` 做 `LIKE` 模糊匹配（数据量 < 10 万条，SQLite `LIKE` + 索引够用，不上全文检索）

```json
{"code":0,"data":{"items":[
  {"id":10241,"ts":"2026-10-03T06:12:44.000Z","clientId":"k_8f21","client":"Claude Code",
   "model":"kimi-k3","modelDisplay":"Kimi-K3","status":200,"upstreamCode":null,
   "ms":1840,"queuedMs":0,"firstByteMs":420,
   "promptTokens":16,"completionTokens":384,"reasoningTokens":0,"cachedTokens":280,"credits":1.62,
   "stream":true,"retryCount":0,"note":"","keyHint":"sk-waygate-4f9c…7a2e",
   "tool":"Claude Code"}
],"total":1284,"page":1,"limit":20,"hasMore":true}}
```

- **`credits` 可为 `null`（v0.5.8）**：`null` = 上游未回报该次费用（未知），**不是 0**。
  前端必须渲染 `—`（并保留 `note` 里的 `credits_unknown` 供排查），**禁止**把它显示成 `0`——
  那会把「不知道」说成「没花钱」。

列表**不返回** `requestBody` / `responseBody`（体积大且默认关闭），仅详情端点按开关返回。

#### `tool` 与 `cachedTokens`（2026-10-08 新增）

| 字段 | 含义 |
|---|---|
| `tool` | 从 `requests.ua` **现解析**出的客户端软件名（`Claude Code` / `Cursor` / `Python requests`…）。`null` = 认不出来（没采到 UA，或 UA 不在关键词表里）。 |
| `cachedTokens` | 该行输入中命中缓存的 tokens。**为 0 就是 0**（不是「未提供」）。折扣按 `quota.cacheDiscount`（默认 0.1）计算。 |

> **`tool` 不是身份。** `clientId` 仍然是「哪把密钥」（=`key_id`，`spec-v4-client-id.md` §2 的不变量）。
> `tool` 回答的是**另一个问题**——「这条请求是哪个工具发的」。两者在自用场景下经常不同：
> 同一把 `sk-waygate-…` 既可能给 Claude Code 用、也可能被脚本调用。
> 之所以不做成 `client_id` 的一部分：那会让同一把密钥的请求分裂成多个 `client_id`，
> 直接破坏 AC-C01（改一次绑定名，条数与积分数必须一字不变）。
>
> 关键词表在 `server/src/identify/ua-table.ts`，是**读取时解释**而非写入时固化 ——
> 增补关键词后立刻对**历史行**生效，无需回填。
> 因此 `client_rule` 仍然只写 `2` / `4`（规则 1 / 3 的**身份**侧依旧未实现，见 §4）。

### 3.7 `GET /api/requests/:id`

在上一项基础上追加：

```json
"totalTokens": 400,
"clientRule": 2,
"keyId": "k_8f21",
"remoteIp": "203.0.113.7",
"ua": "claude-cli/1.0.60 (external, cli)",
"messages": [{"role":"system","content":"…"},{"role":"user","content":"…"}],
"assistantPreview": "……",
"requestBody": null,
"responseBody": null
```

`requestBody` / `responseBody` 仅在 `logs.recordRequestBody` / `logs.recordResponseBody` 为 `true` 时才有值，否则恒 `null`。详情卡耗时拆三段：**排队 `queuedMs` / 上游 `ms - queuedMs` / 首字 `firstByteMs`**。

> 口径（task#37，详见 §3.8.3 C）：`requestBody` 存的是**客户端原始请求体**（改写前的 `body`，非发往上游的体 —— 后者含本服务补的 `system` 等改写，差异体现在该行 `note`）；`responseBody` 是上游 SSE 帧原文（`data: …` 用空行连接）。两条单条均按 **128 KiB 截断**并追加 `…[truncated]`；被截断的 JSON 无法解析 → 上面的 `messages` / `assistantPreview` 退化为空（可接受降级）。**绝不入库任何密钥。**
> 单条 body 超长会截断到 128 KiB 并追加 `…[truncated]`；被截断的 JSON 无法解析，故 `messages` / `assistantPreview` 会为空。隐私与边界详见 §3.8.3。

### 3.8 `GET /api/settings` · `PUT /api/settings`

**7 组 / 25 项**（**接口数据**口径 = 22 个设置项 + 3 个危险操作）。`PUT` 为**全量替换**（前端总是先 GET 再 PUT），`danger` 组不参与 PUT。

> **credential 组的渲染归属（2026-10-09 定案）**：组里 5 项分两类 ——
> **身份三键**（`credential.source` / `credential.status` / `upstream.baseUrl`）是**活提供商**的属性，
> 由「客户端管理 → 提供商」表的「修改」抽屉呈现；
> **全局策略两项**（`upstream.spoofUA` / `upstream.promptRewrite`）不随提供商而变，
> **留在设置页**渲染。设置页逐项滤掉身份三键（不整组滤）——
> 此前整组滤掉，导致 `upstream.spoofUA` **没有任何界面可改**（它从未被渲染过）。
> 「提供商」表读 `/api/providers`；接口结构不变。

```json
{"code":0,"data":{
  "groups":[
    {"id":"service","label":"服务","items":[
      {"key":"service.listenHost","label":"监听地址","value":"127.0.0.1","type":"text",
       "why":"默认只对本机开放。改为 0.0.0.0 后局域网设备也能用（需环境变量 RELAY_ALLOW_PUBLIC_BIND=1；缺失时启动会降级回环并告警），但请自行确认网络可信。","readonly":false,"requiresRestart":true},
      {"key":"service.listenPort","label":"端口","value":8787,"type":"number",
       "why":"控制台与 API 共用，建议不要改成 8080 等常见端口。","readonly":false,"requiresRestart":true},
      {"key":"service.autostart","label":"开机自启","value":true,"type":"switch",
       "why":"由部署时的 systemd 单元管理（systemctl enable relay）。控制台不设开关，避免与实际服务管理状态不一致。","readonly":true,"requiresRestart":false},
      {"key":"service.forceStreamRewrite","label":"超长请求兜底","value":true,"type":"switch",
       "why":"上游只接受流式请求。本服务恒开此兜底：收到非流式调用时自动改写为流式再拼接返回，不可关闭。","readonly":true,"requiresRestart":false}
    ]},
    {"id":"credential","label":"提供商策略","items":[
      {"key":"credential.source","label":"活动提供商","value":"ck_x••••3f7a","type":"text",
       "why":"当前生效提供商的凭证掩码。各家凭证形态不同：WorkBuddy 是 ck_ 开头的 API 密钥、MiniMax Code 是 refresh token（mmort_）或 M Plan 平台 key、Qoder CN 是身份 JSON。逐家查看/修改请到「客户端管理 → 提供商」。","readonly":true,"requiresRestart":false},
      {"key":"credential.status","label":"凭证状态","value":"有效","type":"badge",
       "why":"活动提供商的凭证是否已配置（「有效」= 文件存在且非空）。只读运行态，只反映「填了没有」，不解析凭证到期时间 —— 各家续期方式不同：MiniMax 自动刷新 refresh token、Qoder 需重新导入、WorkBuddy 为静态密钥。","readonly":true,"requiresRestart":false},
      {"key":"upstream.baseUrl","label":"提供商地址","value":"（按家维护于「客户端管理 → 提供商」）","type":"text",
       "why":"【只读，v0.6.5 起】多提供商后，出站转发、目录拉取、额度探测都读各自提供商的 base_url；本项仅作说明位。改地址请到「客户端管理 → 提供商 → 修改」。","readonly":true,"requiresRestart":false},
      {"key":"upstream.userAgent","label":"WorkBuddy UA 基准值","value":"WorkBuddy/5.8.0","type":"text",
       "why":"【仅对 WorkBuddy（openai 协议）生效，v0.6.5 起可改】出站 User-Agent 的基准值，会展开成官方桌面端三段式（WorkBuddy/<ver> WorkBuddy/<ver> CLI/<cli>）。官方客户端升版后改这里即可跟上，无需改代码发版。MiniMax Code 固定发 MiniMaxCode、Qoder CN 固定发 qodercli/<ver>，不受本项影响。留空则沿用入站 UA。","readonly":false,"requiresRestart":false},
      {"key":"upstream.spoofUA","label":"请求头伪装（WorkBuddy）","value":true,"type":"switch",
       "why":"【仅对 WorkBuddy（openai 协议）生效】开启时把出站请求伪装成官方 WorkBuddy 桌面端：UA 展开为三段式，并注入用量归因头族（X-Product / X-IDE-* / X-Agent-Purpose / X-Agent-Intent 等），个人中心「使用端」才归因到 WorkBuddy。MiniMax Code 走标准 Anthropic SDK 头、Qoder CN 走 COSY 签名头，本开关对它们无效果。","readonly":false,"requiresRestart":false},
      {"key":"upstream.promptRewrite","label":"system 提示改写","value":"template","type":"select",
       "options":[{"value":"template","label":"模板行改写（默认·推荐）"},{"value":"neutral","label":"中性提示全量替换（激进）"},{"value":"off","label":"关闭"}],
       "why":"转发前对 system 正文做改写，三家提供商都会应用。改写要解决的主要是 WorkBuddy 的 11128 渠道校验（按 system 模板指纹拦截 Claude Code 系客户端）；MiniMax Code / Qoder CN 无此校验。「模板行改写」语义等价地改标签行（模型读法不变、指纹失效），被拒时自动降级重试一次；「中性替换」整段换掉（会改变模型行为，应急用）；「关闭」即不改写。改后立即生效。","readonly":false,"requiresRestart":false}
    ]},
    {"id":"quota","label":"积分同步","items":[
      {"key":"quota.pollSeconds","label":"同步间隔","value":30,"type":"number",
       "why":"【仅对 WorkBuddy（openai 协议）生效】额度接口的轮询间隔。[v1.3.0] 已打通：POST /v2/billing/meter/get-user-resource 返回资源包列表并聚合出剩余/总量（旧版 GET 实测 404 的根因是方法错）。MiniMax Code 的积分走独立账本；Qoder CN 无额度端点。","readonly":false,"requiresRestart":false},
      {"key":"quota.backoffMaxSeconds","label":"失败退避","value":300,"type":"number",
       "why":"【仅对 WorkBuddy 生效】网络 / 临时失败时按指数退避，最长该值（秒）一次。接口确定不存在（404）时退到每天一次。","readonly":false,"requiresRestart":false},
      {"key":"quota.onFailure","label":"同步失败时","value":"keep_and_mark","type":"select",
       "options":[{"value":"keep_and_mark","label":"保留旧值 + 标记"},{"value":"clear","label":"清空"}],
       "why":"额度同步失败时的策略（保留旧值更稳，清空更诚实，二选一）。MiniMax Code 的账本失败时固定「保留旧值 + 标记数据偏旧」，不由此项控制。","readonly":false,"requiresRestart":false},
      {"key":"quota.warnBelow","label":"额度告警","value":500,"type":"number",
       "why":"剩余积分低于该阈值时会在额度数据里标记 low。[v1.3.0] WorkBuddy 额度接口已打通，本项恢复真实行为；MiniMax Code 的余额展示由其账本卡片独立处理。","readonly":false,"requiresRestart":false},
    ]},
    {"id":"signin","label":"每日签到","items":[
      {"key":"signin.workBuddyEnabled","label":"WorkBuddy 自动签到","value":true,"type":"switch",
       "why":"每日 08:05 后自动为 WorkBuddy（openai 协议）提供商签到领积分（100/天 + 连签加成），凭证用转发已有的 ck_ 密钥，对客户端无影响。关闭只停自动，手动签到按钮不受影响。MiniMax Code 的签到恒开（凭证链要求 relay 代签）。","readonly":false,"requiresRestart":false}
    ]},
    {"id":"limits","label":"限流与重试","items":[
      {"key":"limits.concurrency","label":"并发上限","value":4,"type":"number",
       "why":"同时向上游发出的请求数。超过则本机直接回 429，不排队（客户端需自行退避重试）。","readonly":false,"requiresRestart":false},
      {"key":"limits.retryOn429","label":"429 自动重试","value":3,"type":"number",
       "why":"429 自动重试尚未实现。此值当前不产生任何行为，设为只读以免误以为改了就生效。","readonly":true,"requiresRestart":false},
      {"key":"limits.retryCreditToOwner","label":"重试积分归属","value":true,"type":"switch",
       "why":"依赖自动重试，而自动重试尚未实现。此值当前不产生任何行为，设为只读。","readonly":true,"requiresRestart":false},
      {"key":"limits.firstByteTimeoutMs","label":"首字超时（毫秒）","value":30000,"type":"number",
       "why":"从发出请求到上游送出首个数据帧的上限。已开始的流不受总时长限制，仅受「连续 5 分钟无数据」的挂死保护。","readonly":false,"requiresRestart":false}
    ]},
    {"id":"logs","label":"日志","items":[
      {"key":"logs.retainDays","label":"保留天数","value":30,"type":"number",
       "why":"超期日志每日自动清理一次。它决定「积分与用量」页明细表能回溯多久。","readonly":false,"requiresRestart":false},
      {"key":"logs.recordRequestBody","label":"记录请求体","value":false,"type":"switch",
       "why":"关闭后只记模型、tokens 与状态。开启会把对话内容写进本地库（默认关闭，超长请求体会被截断到 128 KiB）。绝不记录任何密钥 —— Authorization 只在请求头，不入库。","readonly":false,"requiresRestart":false},
      {"key":"logs.recordResponseBody","label":"记录响应体","value":false,"type":"switch",
       "why":"同上，记录上游返回内容。默认关闭，排查上游异常时才临时打开（超长响应体会被截断）。","readonly":false,"requiresRestart":false},
      {"key":"logs.dir","label":"日志文件","value":"~/.relay/logs/","type":"text",
       "why":"日志由 systemd / journald 收集（journalctl -u relay）。控制台不单独维护日志目录，故只读。","readonly":true,"requiresRestart":false}
    ]},
    {"id":"danger","label":"危险操作","items":[
      {"key":"danger.clearLogs","label":"清空全部日志","type":"action","tone":"warn",
       "why":"删除后「积分与用量」的按模型 / 客户端明细将一并归零，剩余积分不受影响。"},
      {"key":"danger.resetKeys","label":"重置全部密钥","type":"action","tone":"warn",
       "why":"所有 sk-waygate- 密钥立即失效，已填进客户端的密钥需要逐个替换。"},
      {"key":"danger.restoreDefaults","label":"恢复默认配置","type":"action","tone":"warn",
       "why":"设置回到初始值，上游地址与并发上限需要重新确认。"}
    ]},
    {"id":"mapping","label":"配置文件对应","items":[
      {"key":"config.mapping","label":"config.yml 键位映射","type":"mapping","value":{
        "service.listenHost":"listen.host","service.listenPort":"listen.port",
        "service.autostart":"autostart","credential.source":"credential.source",
        "upstream.baseUrl":"upstream.baseUrl","upstream.userAgent":"upstream.userAgent",
        "upstream.spoofUA":"upstream.spoofUA",
        "upstream.promptRewrite":"upstream.promptRewrite",
        "quota.pollSeconds":"quota.poll","quota.backoffMaxSeconds":"quota.backoff",
        "quota.warnBelow":"quota.warnBelow","limits.concurrency":"limits.concurrency",
        "limits.retryOn429":"limits.retryOn429","limits.firstByteTimeoutMs":"limits.firstByteTimeout",
        "logs.retainDays":"logs.retainDays","logs.recordRequestBody":"logs.body"
      },
       "why":"自用工具的设置页最终会被「直接改配置文件」取代。先把映射关系摆出来，能省掉一整轮「这个开关对应哪个 key」的沟通。","readonly":true}
    ]}
  ],
  "version": 3
}}
```

`PUT` 请求体只提交 `groups[].items[]` 中 `readonly:false` 且 `type != "action"` 的 `{key,value}` 数组：

```json
{"settings":[{"key":"limits.concurrency","value":8},{"key":"logs.retainDays","value":60}]}
```

> ⚠️ `credential.source` 虽然 `readonly:true`，但**它是可写的 —— 走 `PUT /api/settings/credential`（§3.8.1），不参与本 PUT**。
> 前端在这个只读项旁边渲染「更换」入口，弹层里填入 `ck_…` 明文再调那条端点。
> `readonly:true` 的含义是「**值本身不由通用 PUT 写**」，不是「用户无法改」。

`PUT` 响应：`{"code":0,"data":{"requiresRestart":true,"applied":2,"version":4}}`

**服务端校验（必须做，别只信前端）**：

| key | 约束 |
|---|---|
| `service.listenHost` | 必须为合法 IP。**设为非 `127.0.0.1` 时需要环境变量 `RELAY_ALLOW_PUBLIC_BIND=1` 与二次确认，否则 400**（见 `deploy-security.md` 闸 1） |
| `service.listenPort` | 1–65535，且不得为 0 |
| `limits.concurrency` | 1–32 |
| `limits.firstByteTimeoutMs` | 1000–600000（毫秒） |
| `quota.pollSeconds` | ≥ 5 |
| `quota.backoffMaxSeconds` | 5–3600（秒） |
| `quota.onFailure` | 只能是 `keep_and_mark` 或 `clear`（闭集） |
| `quota.warnBelow` | ≥ 0 的整数 |
| `logs.retainDays` | 1–3650 |
| `upstream.baseUrl` | 必须 `https://` 开头（禁止明文 http 承载 `ck_` 凭证） |
| （上表未列的 key） | 一律 400：`readonly:true` / `type:'action'` 的项不在可写集合内 |

> 另：`type:'switch'` 的可写项（`upstream.spoofUA` / `logs.recordRequestBody` / `logs.recordResponseBody`）服务端强制为 boolean。
> **隐藏键 `logs.recordBodyUntil`（v0.2.0）**：epoch 毫秒时间戳或 `null`，在 `EDITABLE_KEYS` 可写集合内但**不在设置页渲染**（catalog 无此项）—— 供请求日志页的「取证 30 分钟」使用：`recordRequestBody:true` 时若 `Date.now() >= recordBodyUntil`，取证视为已过期（隐私兜底，忘了关也不会继续写请求体入库）。
> 本表 = 服务端**实际执行**的全部约束，权威实现见 `server/src/config/settings.validate.ts`。前端必须据此做同样的提示与前置校验 —— 服务端比文档更严，用户就会撞上「界面能填、保存被拒」。
>
> **可写集合的单一事实来源**是 `server/src/config/settings.defaults.ts` 的 `EDITABLE_KEYS`（task#37 起与本表逐项同源）：不在集合内的 key，`PUT` 一律 400 拒收。

### 3.8.1 `PUT /api/settings/credential`

写入上游自签发密钥（`ck_…`）。**独立于 `PUT /api/settings`**。

**请求体**：

```json
{"key":"ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
```

> ⚠️ 上面 `ck_xxxx…` 只是**占位写法**。真实密钥的形态比它宽（形如 `ck_<16 位>.<40 位>`，
> 中间带 `.`）。**不要照这个占位符反向推导校验规则** —— 第一版就是这么做的，
> 结果把用户真实可用的密钥挡在了门外（详见 §3.8.1 的 `key` 字段说明）。

响应：

```json
{"code":0,"data":{
  "source":"ck_x••••3f7a",
  "configured":true,
  "persisted":true,
  "path":"/var/lib/relay/upstream.key"
}}
```

**为什么不是 `PUT /api/settings` 的一项**：`credential.source` 是 `readonly:true` 的
**只读展示项**，这是刻意的安全边界 —— 上游凭证是**出站凭证**，能读回它等于能把
服务端凭证偷走。所以这条端点语义是**只写**：请求收明文，响应与日志一律只出现掩码。

| 字段 | 说明 |
|---|---|
| `key` | 必填。须匹配 `/^ck_[\x21-\x7e]{16,}$/`；不匹配 → 400 / `40001` |
| `data.source` | 掩码形态，与 `settings` 里的 `credential.source` 同源 |
| `data.configured` | 写入后恒为 `true` |
| `data.persisted` | `true` = 已落盘，重启后仍有效；`false` = 数据目录不可写，仅内存生效 |
| `data.path` | 落盘位置，便于排查。**不含任何敏感内容** |

**关于 `key` 的校验规则（一次真实踩坑的产物）**：

规则**第一版**是 `/^ck_[A-Za-z0-9_-]{16,}$/`，且前后端各写了一份。它把用户真实可用的
密钥挡在了门外 —— 真实密钥第 15 位是**点号 `.`**，而那个字符集不含 `.`。

教训有两条，都已固化为纪律：

1. **凭证格式不该由本服务猜测。** 上游决定格式，本服务的本地校验只负责挡住
   「明显手滑」（空值、缺前缀、半截截断），**有效性交给上游**：填错时 `/v1`
   会回 `502 upstream_credential_invalid`，这才是权威判定。
2. **永远不要照着文档里的占位符反推校验规则。** 占位符是给人看的示意，
   不是格式规格；没有真实样本时应选择「宽进严出」而不是「照猫画虎收窄」。

**为什么用 `[\x21-\x7e]` 而不是 `.`**：`. ` 会匹配换行以外的**任意**字符，包括
制表符、NUL、DEL 等控制字符。凭证随后会被拼进 `Authorization: Bearer <key>`，
一旦允许 `\r` / `\n`，攻击者就能用它**注入请求头**。`[\x21-\x7e]` 是「可打印
ASCII 且非空白」的精确表达 —— 既覆盖了所有真实密钥字符（含 `. + / = :`），
又顺手堵住了 CRLF 注入。语义即「由上游决定格式，本服务只排除结构与安全上
不可能的字符」。**前后端与 mock 三处必须同步**，这条规则已用回归测试（②b）守住。

**落盘位置：数据目录，不是 `.env`** —— 这一条是**部署到真实服务器后才发现必须改的**。
最初的实现逐行重写 `<cwd>/.env`，开发机上单测全绿；但 systemd 单元里有
`ProtectSystem=strict` + `ReadWritePaths=/var/lib/relay /var/log/relay`，
进程对整个文件系统只读，**写自己的 `.env` 会被内核拒绝**。用 `systemd-run` 复现
同样的沙箱约束实测：

```
PROBE_RESULT: WRITE DENIED        ← touch server/.env
CONTROL var-lib-relay: WRITE OK   ← touch /var/lib/relay/...
```

若照原设计上线，每次「更换凭证」都会静默 `persisted:false`、重启即丢。因此改为写入
`${RELAY_DATA_DIR}/upstream.key`（部署时即 `/var/lib/relay/upstream.key`，权限 600，
与同目录的 `relay.secret`、`settings.json` 同类）。**不放松任何沙箱设置**。

凭证的加载优先级（`RelayConfigService.loadUpstreamKey()`）：
**`RELAY_UPSTREAM_KEY` 环境变量 → `${RELAY_DATA_DIR}/upstream.key`**。
环境变量优先是因为它是运维在部署配置里**显式**写下的意图，应当能覆盖界面上曾填过的值。

**服务端行为**：
- 校验格式 → **先原子落盘**（临时文件 + `rename`）→ 再更新内存。
- 落盘失败**降级为 `persisted:false` 而非 500**：内存已能生效，不应因为磁盘问题让整个请求失败。
- **无需重启**：`RelayConfigService.upstreamKey` 是 getter，proxy / models / catalog 全部按需读取，写入后对后续请求立即生效。
- 错误响应同样走统一信封：格式非法 → `400` / `{"code":40001,...}`。

### 3.8.2 `POST /api/settings/credential/test` — 试通一把尚未保存的凭证

**目的**：§3.8.1 的 `PUT /api/settings/credential` 是**只写**端点，写入后读不回明文，用户填错 key 无法自查。本端点补上这个缺口：拿**待测的**凭证明文先打一次最小上游请求，只回结论，**不落库、不改变当前生效的凭证**。

**请求**：

```json
{"key":"ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
```

`key` 校验与 §3.8.1 **同源**（`/^ck_[\x21-\x7e]{16,}$/`），非法 → `400` / `40001`。明文**只在该请求栈内存活，永不落盘、不进日志、不回显**。

**响应** `{"code":0,"data":{...}}`，`data` 形状（= `CredentialTestResult`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 上游是否接受（即 `httpStatus` 为 2xx） |
| `model` | string | 本次探测用的模型（优先取 enabled 的，供排障） |
| `elapsedMs` | number | 本次探测耗时 |
| `upstreamCode` | number \| null | 上游业务码（如 `11102` = 账号未开通该模型）。**仅在「拿到了响应但 body 无可提取业务码」时为 `null`** |
| `httpStatus` | number \| null | **本次拿到的 HTTP 状态码**，语义见下 |
| `reason` | string \| null | 人话原因：`HTTP <status>` / `上游业务码 <code>` / 网络异常的 `err.message` |

**`httpStatus` 语义（必须严格，前端据此区分「上游拒签」与「连不上」）**：

- **`httpStatus === null` ⇔ 根本没拿到 HTTP 响应** —— fetch 抛异常 / 超时 / 连接中断。**只有这一种情况为 `null`。**
- **`httpStatus` 为数字 ⇔ 上游确实回了响应**，值即状态码：
  - 2xx（`ok=true`）时**也要填**（通常 `200`），**不得填 `null`**；
  - 非 2xx 时填真实码（如 `401` / `403` / `500`）。
- `reason` 保持现状不动（`HTTP ${status}` / `上游业务码 ${code}` / `err.message`）。

> ⚠️ **为什么 `httpStatus` 是必需的**：`upstreamCode === null` 有**两个来源** —— 真网络失败，与「上游回了 401 但 body 里没有可提取的数字业务码」。仅凭 `upstreamCode` 前端无法区分，会把**「上游 401 拒签了这把 key」误诊成「网络连不上，去查出网」**（排障方向直接跑偏）。补上 `httpStatus` 后三分法才成立：
> 无响应（网络）/ 有响应·有业务码（账号或模型问题）/ **有响应·无业务码 → 取 HTTP 状态（如 401 = 凭证无效）**。

**示例**（上游明确拒绝，但 body 无数字业务码）：

```json
{"code":0,"data":{"ok":false,"model":"hunyuan-lite","elapsedMs":312,"upstreamCode":null,"httpStatus":401,"reason":"HTTP 401"}}
```

（`upstreamCode` 为 `null` 而 `httpStatus` 为 `401` = **上游拒签了这把凭证，不是网络问题**。）

### 3.8.3 设置项的「接线状态」与只读边界（task#37）

> **[v0.6.5] 多提供商对齐**：本部署已从「单上游」演进为**三家提供商并存**
> （WorkBuddy=openai / MiniMax Code=anthropic / Qoder CN=qoder，见 §3.12）。
> 据此做的设置页调整：① 组 `credential` 更名「**提供商策略**」（身份键已移至「客户端管理 → 提供商」）；
> ② `upstream.baseUrl` 由可写改为**只读说明位**（出站读 `provider.base_url`）；
> ③ 新增可写 `upstream.userAgent`（WorkBuddy UA 基准值，跟随官方客户端版本不用改代码）；
> ④ `upstream.spoofUA` / `upstream.promptRewrite` 的 `why` 如实标注**仅 openai 协议生效**（后者"三家都改写，但 11128 校验是 WorkBuddy 专有"）；
> ⑤ `quota.*` 如实标注**仅对 WorkBuddy 生效**（MiniMax 走独立账本、Qoder 无额度端点）；
> ⑥ 删除死配置 `limits.minMaxTokens`（无消费者，且与运行时常量 `MIN_MAX_TOKENS=16` 矛盾）与 `quota.endpoint`（无消费者）；
> ⑦ 新增前端只读区块「**提供商健康**」（复用 `GET /api/providers`，展示各家协议/凭证/账本/签到 + 三项常驻说明：凭证互斥、Qoder 零内容重试、`requests` 无 provider_id 的归属限制）。

设置项只有两种诚实状态：**改了会生效（接线）** 或 **明确只读（附「为什么不能改」）**。
不存在「界面能填、后端不做」的空壳项 —— 那种项比没有更糟，它让用户以为改了就生效。

**A. 已接线（改设置即产生行为，均有单测 / 行为证据）**

| key | 生效点（文件） | 语义 |
|---|---|---|
| `upstream.userAgent` | `proxy/headers.ts`（经 `proxy.service.ts`） | **[v0.6.5 起可写，仅 openai/WorkBuddy]** WorkBuddy 出站 UA 基准值，展开为官方三段式并用于 `spoofUA` 的归因头族。官方客户端升版后改这里即可跟上，无需改代码发版。 |
| `service.listenHost` | `main.ts`（经 `config/listen.ts`） | 实际 bind 的地址。非回环地址还需环境变量 `RELAY_ALLOW_PUBLIC_BIND=1`；**缺失时启动降级回 127.0.0.1 并告警**（防手工编辑 settings.json 绕过接口把持有上游凭证的进程推到公网）。 |
| `service.listenPort` | `main.ts`（经 `config/listen.ts`） | 实际 bind 的端口。环境变量 `RELAY_PORT` 优先（自动化/冒烟用随机端口起隔离实例，不能被磁盘端口覆盖）。 |
| `limits.concurrency` | `proxy/proxy.service.ts`（经 `proxy/concurrency.ts`） | 并发闸上限，封顶硬上限 `32`。当前占用/上限经 `GET /api/overview` 的 `concurrency` 暴露（§3.4）。 |
| `limits.firstByteTimeoutMs` | `proxy/proxy.service.ts` | 出站 `fetch` 的超时（首字超时）。 |
| `logs.recordRequestBody` / `recordResponseBody` | `proxy/proxy.service.ts` / `proxy/sse-stream.ts` → `proxy/proxy-log.ts` | **真的落库**（见下方隐私口径 C）。 |
| `logs.retainDays` | `store/retention.service.ts` | 每日清理一次：删过期 `requests` 行 + 对应整日 `aggregates` 桶（契约 §6.5）。启动时补跑一次，**每次实时读配置**（改设置无需重启）。 |

**B. 只读（`readonly:true`，`PUT` 一律 400；`why` 指向真正的管理途径）**

| key | 为什么只读 |
|---|---|
| `upstream.baseUrl` | **[v0.6.5 起只读]** 多提供商后，出站/目录/额度都读各自 `provider.base_url`（§3.12）；本项仅作"地址已按家维护"的说明位。改地址请到「客户端管理 → 提供商」。**字段本体保留**（首次种子与无 providers 的老部署回落仍读它）。 |
| `service.autostart` | 由部署时的 systemd 单元管理（`systemctl enable relay`）；控制台不设开关，避免与实际服务管理状态不一致。 |
| `service.forceStreamRewrite` | 上游只接受流式请求，本服务恒开此兜底，**不可关闭**。 |
| `limits.retryOn429` | **429 自动重试尚未实现**；此值当前不产生任何行为。 |
| `limits.retryCreditToOwner` | 依赖自动重试，而自动重试尚未实现；此值当前不产生任何行为。 |
| `logs.dir` | 日志由 systemd / journald 收集（`journalctl -u relay`）；控制台不维护日志目录。 |

**`readonly:true` 的服务端双闸**：① `EDITABLE_KEYS`（`config/settings.defaults.ts`）不含该 key → `PUT` 400；② `validateSetting`（`config/settings.validate.ts`）对只读键直接返回「已是只读项」→ 即便有人绕过第一道闸也拒。两处与本节逐项同源。

**C. `logs.recordRequestBody` / `recordResponseBody` 的隐私口径（默认关闭）**

- **记录的是客户端原始请求体**（改写前的 `body`，即用户真正发来的对话），不是发往上游的体 —— 后者含本服务补的 `system` 等改写。
- **绝不记录任何密钥**：`Authorization` 只在请求头，从不进 body；落库的 body 亦不含 `ck_…` / `sk-waygate-…`。
- **有界截断**：单条 body 截到 **128 KiB（按字符）**，尾部追加 `…[truncated]`（`proxy/body-capture.ts`）。被截断的 JSON 无法解析 → 详情页 `messages` / `assistantPreview` 退化为空，这是可接受的降级（宁可少一段，也不写半截被误读）。
- **默认关闭** = 不持有、不落库对话内容；响应体仅在开关打开时才累积（`sse-stream.ts`）。
- 读取侧同样受开关约束：开关关掉后，即便旧数据还在库里，详情端点也返回 `null`（§3.7）。

### 3.9 `POST /api/settings/danger`

```json
{"action":"clearLogs","confirm":"确认"}
```

- `confirm` 必须严格等于字符串 `确认`，否则 400。
- 响应先量化后果再执行（两步）：先 `GET`-like 预览可省略，`POST` 直接返回 `{"code":0,"data":{"affected":{"logs":1284}}}`，表示已删除 1284 条。
- 前端必须先弹层展示「将删除 N 条日志」并让用户输入「确认」，破坏性按钮用琥珀描边，**安全选项才是主按钮**。

### 3.10 `GET /api/keys` · `POST /api/keys` · `PATCH /api/keys/:id` · `DELETE /api/keys/:id`

`GET` 列表（**永不返回明文**）：

```json
{"code":0,"data":{"items":[
  {"id":"k_8f21","name":"Claude Code 主力","hint":"sk-waygate-4f9c…7a2e",
   "scope":{"type":"all"},"client":"Claude Code","enabled":true,
   "expiresAt":null,"createdAt":"2026-09-20T10:00:00.000Z",
   "lastSeenAt":"2026-10-03T06:12:44.000Z","requests24h":760}
]}}
```

> **`hint` 是签发时的快照。** 更名期的旧行曾是 `sk-relay-` 形态；
> **2026-10-11 晚存量密钥已全部重签为 `sk-waygate-`，库中不再有旧前缀行**，新建的与存量重签后的都是 `sk-waygate-…`（见 §1.1）。

`POST`（AC-08：明文只回显一次）：

请求：`{"name":"Cherry Studio","scope":{"type":"family","value":"kimi"},"client":"Cherry Studio","expiresAt":null}`

```json
{"code":0,"data":{
  "id":"k_9a3c",
  "key":"sk-waygate-4f9c2a7e1b83d04f391c7a2e",
  "hint":"sk-waygate-4f9c…7a2e",
  "name":"Cherry Studio","scope":{"type":"family","value":"kimi"},
  "client":"Cherry Studio","createdAt":"2026-10-03T06:12:44.000Z",
  "warning":"关掉这页又没保存，只能删除重建。此明文不会再出现。"
}}
```

`PATCH`：`{"name":…?, "enabled":…?}`，不返回明文。
`DELETE`：`{"code":0,"data":{"deleted":1}}`。密钥是客户端配置的一部分，删除前前端必须二次确认。

> **`client`（绑定提供商名）的界面形态**：服务端仍收自由字符串（字段与校验不变），
> 但创建弹窗里它是**下拉**（2026-10-09）。候选 = **已登记的提供商**（`GET /api/providers`
> 的 `name`，生效那家标注「（生效中）」），另留「自定义…」兜底 —— 提供商还没登记时
> 也得能先把密钥建出来。
>
> **为什么候选是提供商、不是工具名**：本项目的形态是**反代客户端订阅** ——
> **提供商 ≡ 客户端**（所以「客户端管理」即「提供商管理」）。这把密钥绑的是
> "哪个客户端订阅"，而 UA 解析出的工具名回答的是"哪个工具发的"，是**另一个维度**。
> 不硬编码候选清单：真源是 `providers` 表，抄一份就多一个会漂移的副本。
> 绑定名会**覆盖**密钥名进入显示名回落链（见 §4 的回落链），所以"同一家两种写法
> 裂成两条记录"是真实代价 —— 这正是从文本框改成下拉的理由。
>
> ⚠️ **它只是显示名，不控制路由**：当前是「多个已配置、单活」，所有请求都发给生效那家。
> 绑定名影响的是"这条用量算在谁名下"，不是"请求打向哪家"。

`client` 字段不能省——识别规则第 2 条「该 Key 创建时绑定的客户端名」在别处没有设置入口（`build-plan.md` Phase 3）。

### 3.11 `GET /api/models/catalog` · `POST /api/models/catalog`

路径与 `SPEC.md` §5.2 一致（`GET/POST /api/models/catalog`）：`GET` 查看，`POST` 手动刷新。

```json
{"code":0,"data":{
  "source":"upstream",
  "fetchedAt":"2026-10-05T06:12:44.000Z",
  "upstreamReachable":true,
  "models":[
    {"id":"kimi-k2.7","provider":"WorkBuddy","displayName":"Kimi-K2.7-Code","family":"kimi","tag":null,
     "multiplier":0.57,"source":"upstream","verified":1,"enabled":true,
     "lastVerifiedAt":"2026-10-05T04:00:00.000Z"},
    {"id":"brand-new","provider":"WorkBuddy","displayName":"Brand New","family":"brand","tag":null,
     "multiplier":null,"source":"observed","verified":0,"enabled":true,
     "lastVerifiedAt":null}
  ]
}}
```

- **`provider`（v0.5.13）**：该模型归属的**提供商显示名**（多生效并集视图里每行带自己的归属）。
  请求日志的「提供商」列按**模型 id → 此目录**解析 —— `requests` 表没有 provider_id、
  无法逐行记录真实服务方，而密钥的绑定名只是路由偏好（绑定 WorkBuddy 的密钥请求
  MiniMax 模型时实际走 MiniMax Code），不能冒充提供商。同 id 多家并存时前端取目录
  首家（确定性；v0.5.10 起目录侧已保证 declared 优先于 observed，天然指到声明方）。

**清单来源三路合一**（用户诉求「可用模型按实际请求来」）：

| source | 含义 | 数据来源 |
|---|---|---|
| `upstream` | 上游目录拉到的（真订阅清单） | `GET {upstream.baseUrl}/v2/enterprises/personal/models`（清单）+ `GET {upstream.baseUrl}/v3/config`（**真实倍率**，v0.2.1 起） |
| `seed` | 随版本发布的本地种子 | `schema.sql` 播种 |
| `observed` | **实际成功调用过**的模型 | `requests` 表 `status=200` 去重 |
| `manual` | 人工写入（历史保留） | 控制台 |

- 同 id 命中多源取「更硬」者：`upstream > manual > seed > observed`。**`observed` 不得伪装成订阅清单。**
- `multiplier` **可为 `null`**（/v3/config 与本地快照都缺该模型时=倍率未知，不编造）。
- 合并**只增不减**：上游没有的本地模型保留（订阅以后可能又开）。
- **倍率两路来源与优先级（v0.2.1）**：`/v3/config` 接口值（`credits:"x0.11 credits"` → 0.11）
  **权威**，合并/落库时覆盖 seed 行的过期快照（实测 space-bunny 0.03→0.08）；
  唯一例外是 `source='manual'` 的历史行。接口未覆盖的模型回落 seed 快照。
  `/v3/config` 需三个头：`Authorization` + CLI 形状 UA（`CLI/x.y CodeBuddy/x.y`，credits 只在
  CLI 视角返回）+ `X-User-Id`（任意非空，缺则 200 但 `models:null`）；自报 UA 被 400/12403 拒。
  详见 `catalog/v3-config.ts` 头注与 `probe/probe-v3-*.mjs` 实测记录。

`POST /api/models/catalog`（手动刷新）：同步执行一次
「**拉上游目录 + 拉 /v3/config 倍率（并行）→ 合并 seed/observed → 落库 → 逐项实测校验**」，
实测串行执行并带 200ms 间隔，同一分钟内只生效一次（否则 429）。返回
`{"code":0,"data":{"checked":31,"ok":29,"failed":["glm-5.1","hy3"],"source":"upstream","pulled":true,"configPulled":true,"multipliersUpdated":2,"added":16}}`。
`failed` 项标 `verified=0`，**不从表里删除**。
上游拉取失败时**静默回落**（`pulled:false` / `configPulled:false`，`source` 为 seed/observed 的主导来源），不向用户报错。

> **每日静默同步（v0.2.1）**：官方促销/调价会让快照倍率过期，故除手动刷新外，
> 服务每 24h（含启动时）自动做一次「拉取 + 合并 + 落库」—— **不逐项实测**
> （实测真打上游、真消耗积分，仅留给用户显式触发）。失败只记日志，不影响服务。
> 兜底积分公式因此总是能用上最新倍率（`usage.credit` 缺失的那小部分请求）。

### 3.12 提供商（2026-10-08 · v0.3.x）

**形态：多个已配置、单活。** `providers` 表登记 N 个上游，恰有一行 `active=1`。
激活一个提供商 = 服务端做三件事（全部落**既有机制，代理热路径不改**）：
① 改 active 行（事务内先清后置）；② 该提供商的凭证文件载入 `config.upstreamKey`；
③ 该行的 base_url 写进 `settings.upstream.baseUrl`（`resolveUpstreamBase()` 每请求都读它）。

**激活会清空并重建模型目录**（旧清单对新上游是错的），然后做一次「拉取+合并、不实测」。
[2026-10-08 迁移 008] 用户的启用/停用选择**按提供商快照**（`provider_model_prefs`）：
切走时存下当前清单的启停，切回同一家时回填；只有"从未见过的提供商"才是目录默认态。
（这修掉了"单活必然丢选择"的代价，也是多活的前置条件之一。）

#### `GET /api/providers`

```json
{"code":0,"data":{"items":[
  {"id":"p_default00","name":"WorkBuddy","baseUrl":"https://copilot.tencent.com",
   "credentialMask":"ck_1••••f7ab","configured":true,"active":true},
  {"id":"p_a1b2c3d4","name":"OpenAI 兼容示例","baseUrl":"https://api.openai-like.example.com",
   "credentialMask":"ck_9••••31de","configured":true,"active":false}
]}}
```

#### `POST /api/providers`

`{"name":"我的订阅","baseUrl":"https://api.example.com","credential":"ck_…","activate":false}`

- 默认**不激活**（先建好、试通、再切换）。`activate:true` 创建即切换。
- **凭证只写**：落 `<数据目录>/providers/<id>.key`（600，原子写），表里不存，响应只有掩码。
- **地址校验（SSRF 防线）**：只允许公网 http/https；拒绝 localhost / 环回 / 私有（10/8、
  172.16/12、192.168/16）/ 链路本地 / 保留地址。这是用户输入且服务端会真实请求的目标。
  既有 `upstream.baseUrl` 设置项不收紧（避免内网上游的既有部署升级即失效）。

#### `PATCH /api/providers/:id`

`{"name?":"…","baseUrl?":"…","credential?":"ck_…"}` —— 改的是**活提供商**的地址时，
settings 同步热更；改凭证时热载入内存。

#### `PUT /api/providers/:id/activate`

切换全局出站上游（含目录重建，异步）。返回切换后的 ProviderItem。

#### `POST /api/providers/:id/test`（2026-10-08 遗留②）

试通**指定提供商**（不切换就能测）。body `{"credential?":"ck_…","model?":"…"}`：

- 省 `credential` → 用该提供商**已保存**的那把（「已存的还活着吗」）；
  该提供商从没配过凭证则 400（**不悄悄拿全局那把凑** —— 测错了对象比不测更糟）。
- `model` 省略时用通用探测名（`hunyuan-lite`）。非活提供商的模型清单我们并没有
  （目录属于活提供商），但试通要区分的是「连得上吗 / key 对吗」：
  401 ⇒ key 坏；404/400 ⇒ 连通且 key 至少没被拒。
- 响应与 `POST /api/settings/credential/test` 同形（`ok/model/elapsedMs/upstreamCode/httpStatus/reason`）。

> 与既有 `POST /api/settings/credential/test` 的分工：那个打**当前生效**的上游
> （换全局 key 的先验后存）；这个打**指定提供商**的地址（切换前的先验）。

#### `GET /api/providers/:id/signin` 与 `POST /api/providers/:id/signin`（v0.5.6 引入，v1.3.0 按协议分流）

查签到面板（GET，不领取）与立即签到（POST，幂等）。**按提供商协议分流**：

- **oauth_minimax（MiniMax Code）**：打 mavis `signin/{status,claim}`，面板含 7 天周期
  `days[]`（day_no/points/status/is_today）；签到用 relay 已维护的 OAuth access token。
- **openai（WorkBuddy，v1.3.0）**：打 billing/meter 的 `checkin-activity-status` /
  `daily-checkin`（Bearer = 转发在用的 ck_，无凭证互踢），面板含
  `streak/todayCredit/totalCredits/activityName`；幂等闸 `wb_signin_checked_on`
  （与 MiniMax 的 `signin_checked_on` 分列：签到体系不同源）。daily-checkin 的 claim
  响应形状未探针实测（会真领积分），解析按认得出的数字字段保守取值，取不到为 null。
- **qoder**：无积分体系，返回 `{available:false, reason:'signin_not_supported'}`。

#### `DELETE /api/providers/:id`

两条护栏：**不能删当前生效的**（先切换再删，否则出站上游悬空）；**至少保留一个**。
凭证文件随之删除。

> **与既有设置的关系**：`credential.source` / `credential.status` / `upstream.baseUrl`
> 三个设置项**继续存在**，描述的是"全局出站"的当前落点（= 活提供商）。控制台的
> 「提供商」**表**读 `/api/providers`，位置在**「客户端管理」页**（2026-10-09 从设置页搬来，
> 与本页「客户端用量」表同构）；设置页只渲染它剩下的**全局策略两项**（见 §3.8 的归属说明），
> 不渲染这三个键。
>
> **形态**：一列可比对象 + 行操作（`修改` / `模型列表` 各开右侧抽屉；非活提供商的
> 「模型列表」**禁用** —— 目录属于活提供商，见上文「激活会清空并重建模型目录」）。
> 「新增提供商」在表卡片自己的右上角。
>
> **升级零行为变化**：迁移 007 建 `providers`、008 建 `provider_model_prefs`（都只建表）；
> 服务首次启动发现 `providers` 空表时，用现有 `settings.upstream.baseUrl` + 现有凭证
> 种子出名为 **WorkBuddy** 的默认提供商（`providers.service.ts` `DEFAULT_PROVIDER_NAME`）
> 并置为 active；若库里已有旧名「默认提供商」的种子行，启动时**按 id 改名**为 WorkBuddy
> （只改 `p_default00` 这一行，不碰用户自建的同名提供商）。
> 不跑迁移则服务拒绝启动（`user_version` 需为 8）。


---

## 4. 客户端识别（四级规则）

决定 `requests.client` 与 `requests.client_rule`，是「客户端管理」「按客户端消耗」两个视图的唯一数据源。

| 优先级 | 依据 | 示例 | 落到 `client_rule` |
|---|---|---|---|
| 1 · 显式声明 | 请求头 `X-Relay-Client` | `X-Relay-Client: Cherry Studio` | `1` |
| 2 · 密钥归属 | 该 Key 创建时绑定的客户端名 | `sk-waygate-4f9c… → Claude Code` | `2` |
| 3 · User-Agent | 内置 UA 关键词表匹配 | `cursor/` `claude-cli/` `cherry-studio/` | `3` |
| 4 · 兜底 | 归入「未识别」，可手动命名 | `python-requests/2.32` | `4` |

> **v0.1 实现现状（普查记录，2026-10-05）**：代码**仅实现规则 2**，`requests.client_rule` 只会写 `2`。
> 规则 **1（`X-Relay-Client`）与 3（UA 关键词表）尚未实现**。
>
> **2026-10-08 更正：原文这里写的是「仅实现规则 2 与 4、只会写 2 / 4」—— 那是错的。**
> 规则 4 的写入分支 `clientRule: ctx.keyContext ? 2 : 4` **恒取 2**：`/v1` 的每个端点都挂了守卫
> （`ProxyController` 类级 `@UseGuards(ClientKeyGuard)`；`/v1/messages` 由 `AnthropicKeyGuard`
> 完全委托同一守卫），守卫通过就必设 `keyContext`。所以 **`4` 不可达，rule-4 行只存在于测试夹具**。
> 「未识别」在生产里是个死分支 —— 详见 `spec-v4-client-id.md` §6 第 1 条。
>
> **2026-10-08 补记 —— 规则 3 拆成了两半，只做了「显示」那一半。**
> `server/src/identify/ua-table.ts` **已创建**，但它**不参与 `client_rule`**：
> 它把 `requests.ua` 解析成工具名，供 `byTool`（§3.4）与请求行的 `tool` 字段（§3.6）使用。
> `client_rule` 因此**仍然只写 2** —— 这是刻意的，不是漏做。
>
> 为什么不把 UA 结果写进 `client_id`（即为什么不算「实现了规则 3」）：
> `spec-v4-client-id.md` §2 把 `client_id = key_id` 锁成不变量，三处依赖它 ——
> ① 显示名回落链、② `clients.service.ts` 的 `boundKeyIds = [clientId]`、
> ③ **AC-C01「改一次绑定名，条数与积分数一字不变」**。
> 让 UA 参与身份会让同一把密钥的请求分裂成多个 `client_id`，②③ 当场不成立。
> 所以 `tool` 是**显示层的派生字段**：与 `client` 并列展示，不改身份、不改分组、不需要迁移。
>
> ⇒ 上表 **3 · User-Agent** 一行的「落到 `client_rule` = 3」**依然未实现**；
> UA 现在的作用是回答「哪个工具发的」，而不是「算哪个客户端」。

- 判定顺序严格 1→4，首次命中即停。
- `X-Relay-Client` 头**被本服务消费，不出站**（§1.3）。
- UA 关键词表放 `server/src/identify/ua-table.ts`，纯数据、可增补，不写死在服务逻辑里。
  ⚠️ 它与 `client_rule` **无关**（见上面的补记）—— 它是读取时的展示层解释。
- 第 4 条命中**不告警、不阻断、不记 error**（`design-spec.md` §7.4）。它是「我忘了给它起名」，不是安全事件。
- 识别结果在**请求入队时**算一次并缓存在请求上下文里，不在流式过程中反复算。

### 4.1 密钥被拒（401）的留痕口径（2026-10-08 定案）

被拒绝的请求（缺头 / 格式错 / 未知 / 已停用 / 已过期）**只写 stdout 日志，不落 `requests` 表**：

```
客户端密钥被拒绝：reason=<unknown|disabled|expired|malformed_or_missing> hint=<掩码|n/a> ip=<来源IP> ua="<脱敏UA>"
```

> **为什么不落库**（这是个刻意取舍，不是漏做）：
> `overview.service.ts` 的每一处统计都是 `FROM requests WHERE ts >= ? AND ts < ?`，
> 且 `successRate = (总数 − status≥400) / 总数`。掺进 401 行会让**请求成功率凭空下跌、
> 请求数虚高**，而这些行**没有任何字段能把它们认出来**（没解析出密钥 ⇒ `client_id`
> 只能是兜底值）。用一个更响的**假**信号换一个更弱的**真**信号，不划算。
>
> ⇒ 与「控制台登录失败」采取**同一种处置**（`auth.controller.ts` 的
> `登录失败（口令不正确）ip=… ua="…"`）：都进 journald。
> 排障：`journalctl -u relay | grep 客户端密钥被拒绝`。
>
> **前提**：`last_seen_at` / `last_seen_ip`（`keys.touch`）只在**成功**时更新 ——
> 「密钥多久没被用过」这个信息不能被失败尝试刷新掉。
>
> **来源 IP 取法**：与 `common/client-ip.ts` 一致取 **XFF 末段**（末段是紧邻的 Nginx 写入、
> 客户端伪造不了）。⚠️ 历史上有两处取法不一致：`key.guard.ts` 曾自己取**首段**
> （= 攻击者可填的值），2026-10-08 已改为复用 `clientIpOf`。
> 该 bug 一直是**潜伏**的 —— `last_seen_ip` 只落库、当时没有任何界面读它。

---

## 5. 错误码表

### 5.1 `/v1/*`（OpenAI 形状）

| HTTP | `error.code` | 场景 |
|---|---|---|
| 401 | `invalid_api_key` | 缺 / 格式错 / 未知 / **已停用 / 已过期** 的 `sk-waygate-` 密钥（旧前缀 `sk-relay-` 已退役；统一回本码，不区分原因，见 §1.2） |
| 400 | `model_not_found` | 模型既非 API ID 也匹配不到显示名 |
| 400 | `model_not_available` | 上游 `11102`，当前账号无此模型 |
| 400 | `invalid_max_tokens` | `11133` 且提升后仍失败 |
| 400 | `context_length_exceeded` | 上游 `11115`，prompt 超过模型上下文上限（推理前拒绝，未计费） |
| 400 | `invalid_request_body` | `messages` 缺失或不是数组 |
| 403 | `model_not_allowed` | **两个来源**：① 命中 scope 限制（密钥权限范围不含该模型，见 §2.1.2 第 3 步附）；② 模型已在控制台下架。两者共用本码，靠 `message` 区分（下架写「已在控制台下架」，越权写出本密钥的范围）。均**不转发** |
| 403（保留） | `key_disabled` | **当前实现不产出该码**：停用 / 过期已并入上面的 `401 invalid_api_key`（防枚举，见 §1.2）。本行仅为将来若要细分预留 |
| 429 | `rate_limited` | 上游 429 且重试次数已尽 |
| 500 | `internal_error` | 未分类异常（**必须**记 `trace_id`，响应里带上便于排障） |
| 502 | `upstream_error` / `upstream_11101` / `upstream_11128` / `upstream_credential_invalid` / `upstream_unreachable` / `upstream_<未知业务码>` | 见 §2.1.5 |
| 504 | `upstream_timeout` | 首字超时 / 连接超时 |

> **例外**：`POST /v1/messages`（Anthropic 适配层）虽然也在 `/v1/*` 下，但错误体是
> **Anthropic 形状** `{"type":"error","error":{"type":…,"message":…}}`，**不是**本节这张 OpenAI 表 ——
> 见 §2.4.4。

### 5.2 `/api/*`（统一信封）

| HTTP | `code` | 场景 |
|---|---|---|
| 200 | `0` | 成功 |
| 400 | `40001` | 参数校验失败（`message` 指明哪个字段） |
| 400 | `40002` | 危险操作 `confirm` 不匹配 |
| 401 | `40101` | 管理口令不正确 |
| 401 | `40102` | 会话缺失或过期（前端跳转登录） |
| 403 | `40301` | Origin 校验失败（CSRF） |
| 403 | `40302` | 越权访问 |
| 404 | `40401` | 资源不存在（密钥 / 请求 id） |
| 409 | `40901` | 幂等冲突（同名密钥已存在） |
| 429 | `40290` | 登录失败限流（带 `retryAfterSeconds`） |
| 500 | `50001` | 未分类服务端异常（带 `traceId`） |
| 503 | `50301` | 数据库不可用 |

`message` 一律写**人话 + 下一步动作**，禁止 `Internal server error` 这类无信息文案。

---

## 6. 落库与并发约束（给后端实现者的硬规则）

1. **流式过程中禁止写库。** `better-sqlite3` 是同步 API，在事件循环里写会阻塞所有并发流。日志行在**流结束（成功或失败）后一次性写**。
2. **写库与聚合在同一事务内**：`requests` 插一行 + `aggregates` 按 `(bucket, dim, dim_value)` 做 `INSERT … ON CONFLICT DO UPDATE` 递增。一次请求最多 3 个 dim（`model` / `client` / `status`）。
3. `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;`
4. 聚合表是**增量维护的物化结果**，不是权威源。权威源是 `requests`。不一致时以 `requests` 重算（控制台提供「重算聚合」入口，属危险操作）。
   > **v0.1 实现现状（普查记录，2026-10-05）**：该「重算聚合」入口**尚未实现**，§3.8 的 3 个危险操作（`clearLogs` / `resetKeys` / `restoreDefaults`）里也没有它。此条目前是待办口径，不是已交付能力。
5. 日志清理按 `logs.retainDays` 每日执行一次 `DELETE FROM requests WHERE ts < ?`，**同时**清理对应 `aggregates` 的过期 bucket。
   > **v0.1 实现现状（task#37）**：已由 `store/retention.service.ts` 落实 —— 启动补跑一次 + 每日一次（`setInterval(24h)`，定时器 `unref`，不阻止进程退出）；聚合按 `bucket < 截止日` 删**整日**桶（保守，绝不动与存活请求行对应的桶）；清理失败只记 warn（不与外部备份 cron 抢锁而崩服务）。`logs.retainDays` 每次实时读配置。
6. `/api/*` 的所有列表查询必须带 `LIMIT`，禁止全表扫描返回。
7. **审计不变式（task#36 / #37）**：**凡经代理层处理并归属到某个 client 的请求，必有且仅有一行 `requests` 记录。** 两条都是**结构性保证**，不靠各出口自觉调用：
   - **必有**（失败也落库）：落库在 `readUpstreamSse` 的 `finally` 内完成 —— 正常读完 / 抛错 / 被 `.return()`（客户端断开）提前终止，都恰好落一行（`proxy/sse-stream.ts`）。
   - **恰好一行**（幂等，不重复计分）：「已落库」标记挂在 `StreamContext.persistGuard` 上，跨 `{ ...ctx }` 浅拷贝**共享同一引用**，任何路径重复调用（如生成器已落库后 `reply.send` 抛错 → `logRejection` 再落）都被去重（`proxy/proxy-log.ts`）。

   **显式边界 —— 下列客户端可见的失败「不」产生 `requests` 行，且这是设计如此**（不是缺陷）：
   - **(a) 鉴权层拒绝**：`client_keys` 未通过（缺 / 畸形 / 未知 / 停用 / 过期 → 统一 `401 invalid_api_key`，见 §1.2 / §5.1；`auth/key.guard.ts`）。发生在 `beginContext` **之前**，无落库上下文；且 `requests.key_id` 外键指向 `client_keys`，未认证请求**无法归属**任何 `client_id`。
   - **(b) 框架层拒绝**：Fastify 在 handler / guard 之前直接回应 —— 请求体超限（`bodyLimit` → 413）、畸形 JSON（400）、未知路由（404）、方法不符（405）。同样无上下文、无法归属。**已知不覆盖**（要覆盖需在 Fastify 层加 error hook）。
   - **(c) 非代理流量**：`/api/*` 控制台端点不是被代理的推理请求，按设计不进 `requests` 审计表。

---

## 7. 端到端验证（curl）

```bash
# 0. 启动（只听 127.0.0.1；上游密钥走环境变量）
RELAY_UPSTREAM_KEY='ck_…' RELAY_SECRET='<随机32字节hex>' npm run start

# 1. 核心成功流 · 流式
curl -N -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-waygate-4f9c2a7e1b83d04f391c7a2e" \
  -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.3","stream":true,"max_tokens":200,
       "messages":[{"role":"system","content":"probe"},{"role":"user","content":"say ok"}]}'
# 断言：SSE 流；末帧带 usage；requests 表新增一行且 credits > 0；model 落为 glm-5.3

# 2. 非流式自动改写（AC-04）
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-waygate-…" -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.7","stream":false,"messages":[{"role":"user","content":"say ok"}]}'
# 断言：返回 chat.completion（非 chunk）；note 含 system_injected；choices[0].message.content 完整

# 3. 鉴权失败（AC-02）
curl -i -X POST http://127.0.0.1:8787/v1/chat/completions -d '{}'
# 断言：401 + OpenAI error 形状；上游无请求记录

# 4. 凭证隔离（AC-03，最重要）
#    出口抓包：tcpdump -A -s0 'host copilot.tencent.com' | grep -i authorization
#    断言：只出现 ck_…，绝不出现 sk-waygate-

# 5. 未知模型（不转发）
curl -i -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-waygate-…" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
# 断言：400 model_not_found，且上游无请求记录

# 6. 控制台登录 + 概览
curl -c /tmp/c -X POST http://127.0.0.1:8787/api/auth/login -d '{"password":"…"}'
curl -b /tmp/c 'http://127.0.0.1:8787/api/overview?window=24h'
# 断言：byModel credits 之和 === metrics.creditsUsed；每个 byModel 行都带 multiplier（倍率未知该值为 null）。
#       quota 块：当前上游不提供额度 → available=false、reason=upstream_not_provided，且 message 明确说明原因。
```

---

## 8. 与 SPEC 的差异与待确认（需 team-lead 裁决）

| # | 本文做法 | 与 SPEC 的关系 | 需要谁拍板 |
|---|---|---|---|
| 1 | `/api/*` 不带版本前缀 | 与 SPEC §5.2 一致，但与架构师通用规范（`/api/v1/`）不同 | 建议维持 SPEC；如将来对外开放再升 v2 |
| 2 | 新增 `GET /api/auth/session`（SPEC §5.2 未列） | 增量 | 前端首屏需要，建议补进 SPEC |
| 3 | 新增 `POST /api/settings/danger` | 增量 | SPEC §5.2 只列 `GET/PUT /api/settings`，危险操作无处安放 |
| 4 | `client_keys` 增列 `key_hint` / `source` / `expires_at`；`model_catalog` 增列 `family` / `verified` / `enabled` | SPEC §6 最小集的必要补充 | 无 `hint` 则无法渲染 `sk-waygate-4f9c…7a2e`；无 `family` 则 scope 无法判定 |
| 5 | 剩余额度用**内存快照**（进程内单点标量，task#53），不落盘、不开第 5 张表 | 增量 | 单点标量不值得开表；重启后首次拉取前 `reason=pending` |
| 6 | `upstream.spoofUA` 默认 `true` | 与 OPEN-DECISIONS 第 6 条一致 | 需 Phase 0 带官方 UA 复测后定案 |
| 7 | 新增 `PUT /api/settings/credential`（§3.8.1） | 增量 | 上游凭证是**只写**出入口：`credential.source` 只读是为了不泄露出站凭证，写入必须有独立端点。不能塞进 `PUT /api/settings`（那会把只读项变成可写） |
| 8 | **迁移 004**：`model_catalog.source` 由三态扩为四态（+`observed`）；`multiplier` 改为**可空**（NULL=倍率未知） | SPEC §6 最小集的必要补充（v4） | 上游模型目录端点已确证（`GET /v2/enterprises/personal/models`，见 `probe/04-catalog-recheck.md`）；清单来源三路合一要求能标 `observed`；上游目录不含倍率，缺失时必须能表达「未知」而非编造 1.0 |
