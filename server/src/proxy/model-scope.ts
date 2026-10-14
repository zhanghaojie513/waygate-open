/**
 * `client_keys.scope` 的**判定**与**人话描述**（api-contract §2.1.2 第 3 步附）。
 *
 * ── 这个文件补的是一个「存了但没生效」的承诺 ────────────────────────────
 *
 * 密钥的四态权限范围（`all` / `family` / `tag` / `models`）自 v0.1 起就写在表里、
 * 也有创建时校验（`keys.parsing.ts`）、界面上还专门有一列「权限范围」。
 * 但**请求路径上从来没有人读过它** —— `keyContext.scope` 在守卫里被解析、挂到上下文，
 * 然后就没有下文了；`resolveModel` 只检查「模型存在」与「已下架」。
 *
 * 后果很具体：界面上写着「仅 kimi 系」的密钥，实际能调 `glm-5.3`。
 * 那比没有这个功能更糟 —— 它是一句**看起来已经生效的承诺**。
 *
 * ⇒ 本文件是那个缺失的判定，`resolveModel` 在解析出模型后调用它。
 *
 * ── 为什么是纯函数 ──────────────────────────────────────────────────
 * 与 `keys.parsing.ts` / `client-name.ts` 同一理由：判定规则要能**独立单测**，
 * 不必构造整个 ProxyService / 起 HTTP。AC 断言的是「结果」，不是「某段代码被调了」。
 */

import type { KeyScope } from '../store/repositories/client-keys.repo';
import type { ModelCatalogRow } from '../store/repositories/model-catalog.repo';

/** 判定所需的模型属性最小集 —— 只取判定真正用到的三列。 */
export type ScopeTarget = Pick<ModelCatalogRow, 'id' | 'family' | 'tag'>;

/**
 * 归一化用于比较的字符串。
 *
 * 为什么**小写 + 去空白**而不是按契约字面做 `===`：
 *   · `family` 与 `models` 里的 id 都是机器标识（`kimi`、`kimi-k2.7`），
 *     而 `catalog.resolve()` 本来就对小写 id 做查找（`byIdStmt.get(trimmed.toLowerCase())`）——
 *     权限判定若在这里严格区分大小写，就会出现「请求能解析出模型、却被判定越权」的分裂；
 *   · `tag` 是中文标签，本身无大小写，受这条影响为零。
 * 代价是判定**更宽松**（`Kimi` 与 `kimi` 等价）。这个方向是刻意的：
 * 一个「静默拒绝一切」的权限配置比一个「容忍大小写」的配置危险得多，
 * 而前者正是拼错一个字母就会发生的事。
 */
function norm(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * 这把密钥能否使用该模型。
 *
 * | scope | 放行条件 | 依据 |
 * |---|---|---|
 * | `all` | 一律放行 | 契约 §2.1.2 |
 * | `family` | `model.family === value`（family = API ID 第一个 `-` 分段） | 同上 |
 * | `tag` | `model.tag === value` | 同上 |
 * | `models` | `model.id` ∈ value | 同上 |
 *
 * ⚠️ **判定发生在模型解析之后**（拿到的是 `row`，不是用户原始输入）。所以
 * `models` 里写 `kimi-k3` 时，请求发 `Kimi-K3`（显示名）也能通过 —— 两者都解析到同一个 id。
 * 这正是契约把 scope 判定放在第 3 步「模型映射」之后的原因。
 *
 * `scope` 为 `undefined`（守卫未设 keyContext 的路径，如测试桩）时**放行** ——
 * 生产路径上守卫必定设置它，这里不为不可达的分支改变既有行为。
 */
export function scopeAllowsModel(
  scope: KeyScope | undefined | null,
  model: ScopeTarget,
): boolean {
  if (!scope) return true;
  switch (scope.type) {
    case 'all':
      return true;
    case 'family':
      return norm(model.family) === norm(scope.value);
    case 'tag':
      // 模型没有标签时（目录里 tag 为 NULL）永远不放行 —— 「仅限时免费」
      // 不能因为"这个模型没标签"就把它放进来。
      return model.tag !== null && norm(model.tag) === norm(scope.value);
    case 'models':
      return scope.value.some((id) => norm(id) === norm(model.id));
    default:
      /* 穷尽性守卫：将来 KeyScope 加第四种 type 时，这里编译不过（never），
         而不是静默落到某个 default 分支上 —— 静默放行是权限判定最坏的失效模式。 */
      return assertNever(scope);
  }
}

function assertNever(x: never): never {
  throw new Error(`scopeAllowsModel：未处理的 scope 形态 ${JSON.stringify(x)}`);
}

/**
 * scope 的人话描述 —— 用于 403 文案，让用户**知道自己被什么挡住了**。
 *
 * ⚠️ 措辞必须与前端 `web/src/lib/format.ts` 的 `formatScope` **逐字一致**：
 * 同一条 scope 在「密钥列表」里显示一种说法、在报错里显示另一种，
 * 用户会以为是两个不同的东西。这里刻意重写一份而不是共享 ——
 * 前后端是两个独立包，没有共享源码的通道；一致性靠这条注释与单测钉住。
 */
export function describeScope(scope: KeyScope | undefined | null): string {
  if (!scope) return '全部模型';
  switch (scope.type) {
    case 'all':
      return '全部模型';
    case 'family':
      return `仅 ${scope.value} 系`;
    case 'tag':
      return `仅 ${scope.value}`;
    case 'models':
      return `指定 ${scope.value.length} 个模型`;
    default:
      return assertNever(scope);
  }
}
