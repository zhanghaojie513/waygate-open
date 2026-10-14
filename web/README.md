# 驿站 · Relay — Web 控制台

反向代理服务的控制台前端。单页应用，负责总览、请求日志、客户端与密钥、
模型目录、设置（含上游凭证与管理口令）。

> 服务端在 `server/`（同仓库）。接口契约见 `docs/openapi.yaml`。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 19 |
| 构建 | Vite 8 |
| 语言 | TypeScript（strict） |
| 图标 | lucide-react |

无 UI 组件库 —— 样式全部走项目自己的设计令牌（`src/styles/`）。

## 快速开始

```bash
npm install

npm run dev        # 直连 127.0.0.1:8787（需先起后端）
npm run dev:mock   # 内置 Mock 数据，无需后端
```

`npm run dev` 时 Vite 代理保留 `Host` 头（`changeOrigin: false`），
这样后端的 CSRF 同源校验才能通过。

## 常用命令

```bash
npm run build      # tsc --noEmit && vite build → dist/
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run preview    # 预览构建产物
```

## 与后端的约定

- 所有请求经 `src/services/api.ts` —— 页面**不直接 fetch**，
  换后端地址或切换 Mock 只改这一层。
- 接口返回统一信封 `{ code, data, message }`，`code === 0` 为成功。
- 类型契约在 `src/types/api.d.ts`，**必须与服务端同步修改**
  （不一致应在编译期就红）。
- Mock（`src/mocks/`）刻意复刻真实语义（如「凭证只回掩码」「口令只回一次」），
  避免「Mock 顺手、真机打脸」。
- **后端一旦动了 Nest 的 module / provider 装配**（新增 provider、改构造函数依赖、
  注入原始类型参数、忘写 `@Injectable()`），**必须真启动一次 dist**
  再交付：`cd ../server && npm run build && npm run smoke:boot`。
  这类缺陷单测抓不到（单测直接 `new`，绕过 IoC 容器；测试全绿但应用起不来），
  只有真启动能拦住 —— 已发生两次（`ProxyLogger`、`CatalogSyncService`）。
  完整的门禁纪律见 `server/README.md` 的「常用命令」。

## 设计系统

控制台支持**深色 / 浅色**，由侧栏页脚的「外观」分段控件切换，**默认跟随系统**。
偏好（三态）存在 `localStorage['relay.theme']`：

| 偏好值 | 行为 |
|---|---|
| `system`（**默认**） | 跟随操作系统（`prefers-color-scheme`），系统切换时实时跟 |
| `light` | 锁定浅色 |
| `dark` | 锁定深色 |

官网（`/`）**恒为深色** —— 它的身份就是那套深色折面棱镜场景，
浅色不是换一组令牌而是重新设计，故不提供（跟随系统也不改变这一点）。

浅色令牌在 `src/styles/theme.css` 的 `:root[data-theme='light']` 块里重定义，
组件样式一律不改（色值走 `var(--token)`，切主题即切令牌）。三层结构：

| 文件 | 职责 |
|---|---|
| `styles/vendor/tokens.css` | 深色色板（唯一权威源）+ 主题中性层 `--wash-*` / `--shade-*` |
| `styles/theme.css` | 浅色色板 + 少量浅色专属材质微调（场景光、横幅、聚光） |
| `index.html` 的内联脚本 | 首帧防闪：样式表解析前把 `data-theme` 写到 `<html>` |
| `lib/theme.ts` | 三态判定与持久化（纯逻辑：React 与首帧脚本共用同一套判据） |

两条硬性约束：

1. **禁止硬编码颜色** —— 一律用 `var(--token)`；
   中性叠加也必须走令牌（`--wash-*`），因为白色 alpha 在浅色下会"白压白"消失。
   由 `tools/check-color-literals.mjs` 把关（色板文件例外，见脚本内说明）。
2. **禁止用 emoji 当功能图标** —— 一律用 lucide 图标组件。

品牌色不做「紫 → 粉」渐变。语义色：
涨/危险用红、成功/在线用绿、警示/待机用琥珀。
浅色下的语义色是**同色相的深档**（不是另一种颜色），逐色复算到 WCAG AA
（正文 4.5:1），复核基准取文字实际会坐的**最暗**的面，不是最亮的白卡。

## 目录结构

```
src/
  components/
    ui/         通用件（Modal / Drawer / Pager / Panel / Pill / Switch …）
    overview/   总览页组件
    requests/   请求日志
    clients/    客户端与密钥
    settings/   设置页组件（CredentialModal / AdminPasswordModal / DangerConfirmModal）
  pages/        页面级组件
  hooks/        useResource / useSession / useHashRoute / useTheme …
  services/     api.ts（端点清单）/ http.ts（请求封装）
  mocks/        Mock 实现与夹具
  styles/       app.css + theme.css + vendor/tokens.css
  lib/          theme.ts（明暗判定与持久化：纯逻辑，React 与首帧脚本共用）
  types/        api.d.ts（与后端共享的契约）
```

## 部署

构建产物 `dist/` 交给 Nginx 托管，`/api/*` 反代到后端 `127.0.0.1:8787`。
完整步骤见仓库根 README「部署」一节。

生产建议套一层 HTTPS，并保持 `Origin` 与 `Host` 同源（CSRF 校验要求）。
