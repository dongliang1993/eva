# T27 · thread 作用域 policy key：生成纯函数 + settings 持久化 + 旧白名单迁移

> R7 首任务，无依赖、最先做。现状的「始终允许」是**全局 per-tool 白名单**
> `settings.security.alwaysAllowTools`（T14）——点一次「始终允许 bash」就把这个工具
> 在**所有会话、所有命令**上永久放开，等于没审批。本任务把授权粒度细化成 Alma 的
> **thread 作用域 policy key**（`bash:thread:<id>:command:npm test` 只放「这个会话里
> `npm test` 这一条」），建好「生成 + 存储 + 迁移」三件套地基。它**只产数据**：纯函数
> 与 settings 字段，不改任何审批行为——「查询 policy 命中直放」是 T28 把它接进
> `ApprovalGateway.ask` 的事。技术方案 `../../architecture/22-s18-approval-center.md` §3.1。

## 1. 问题

`use-approvals.ts` 的 `allowAlways()` 现在把工具名塞进
`settings.security.alwaysAllowTools: readonly string[]`（shared/index.ts:122），
server 侧 `ApprovalGateway.ask`（approval-gateway.ts:72）对它**一无所知**——白名单的
消费方其实在前端（点过之后该工具不再弹卡）。三个后果：

1. **粒度错**：只有「整工具 × 全局」一档，没有「这条命令 × 这个会话」。
2. **作用域错**：一次授权放大成跨会话永久（22 §1.1，Alma 对照 `main:28077-28100`）。
3. **destructive 只靠前端拦**：`approval-card.tsx` 对 destructive 藏「始终允许」按钮，
   但 settings 是可手改的 JSON，后端没有任何一道把 destructive 挡在 policy 之外的关。

Alma 的 key 由 `(source, threadId, metadata)` 三元组生成（`main:28077-28100` 还原）：
scope=`thread:<id>`，bash 产精确 key `command:<cmd>` + 粗 key `:all` 两级回退
（无命令时只产 `:all`，`main:28077-28087`；acp/mcp 同理，无 tool 名时只产
`acp:…:all`，`main:28099-28101`）；命中任一且值为 `allow_always` 则直放
（`main:28107-28112`）。Eva 照这个形态建。

## 2. 改动

### 2.1 新增 `packages/harness/src/approval/policy-key.ts`（纯函数，无 IO、不读 settings）

单一事实来源（r7 §3 契约 1）。签名对齐 22 §3.1：

```ts
export interface PolicyKeyInput {
  toolName: string;            // "bash" | "write" | "edit" | "mcp__xxx__yyy" | ...
  threadId: string;            // 当前会话
  args: Record<string, unknown>;
}
/** 生成候选 policy key，精确在前、粗放在后。返回空数组 = 该调用不可记忆。 */
export const buildPolicyKeys = (i: PolicyKeyInput): string[]
```

规则（与 22 §3.1 逐行一致，**destructive 置空是本任务相对方案稿的唯一增量**）：

- `bash`：取 `args.command` trim。先跑一次 `classifyToolRisk("bash", { command })`，
  `level === "destructive"` → **返回空数组**（双保险，22 §3.1 末段 + r7 §4.3）。
  否则有命令产 `bash:thread:<id>:command:<cmd>`，恒追加 `bash:thread:<id>:all`。
- `write` / `edit`：只到「本 thread 全部」→ `[`${tool}:thread:<id>:all`]`。
- `mcp__` 前缀：`[`mcp:thread:<id>:tool:<toolName>`, `mcp:thread:<id>:all`]`。
- 其余工具（只读 / 未知 / 非 mcp）不支持记忆：`[]`。

实现要点：`classifyToolRisk` 在 `tools/risk.ts`、本文件在 `approval/`，**跨目录 import
`../tools/risk.js`**——不反向 import（risk 已是被 server/前端共用的底层模块），避免成环。
不缓存判定结果，每次调用现算（纯函数、开销可忽略）。

### 2.2 settings 增字段，旧字段保留做迁移源

- `packages/shared/src/index.ts` `AppSettings.security` 增
  `allowAlwaysPolicies: readonly string[]`；**保留** `alwaysAllowTools`（迁移函数要读它当源）。
- `app-settings.ts` `createDefaultSettings().security` 增 `allowAlwaysPolicies: []`。
  `loadAppSettings` 的块合并（container 语义，app-settings.ts:98）自动带上，无需改。
- **`apps/server/src/routes/settings.ts` 的 zod schema `security` 增
  `allowAlwaysPolicies: z.array(z.string())`**——漏了这条，PUT 存得进、GET 回来 422
  （`app.get` 返回类型 `Promise<AppSettings>` 序列化校验）。这是本任务最容易漏的一处。

### 2.3 `migrate-legacy.ts` 加一次性迁移 `migrateAlwaysAllowToolsToPolicies`

仿同文件 `migrateSecurityToAlwaysAllowTools`（migrate-legacy.ts:133）的形态：

- **幂等标志**：`security` 块里已含 `allowAlwaysPolicies` 字段即 return。
- 读 `security.alwaysAllowTools`（string[]），逐条折成 thread:global 条目：
  - `bash` / `write` / `edit` → `${tool}:thread:global:all`；
  - `mcp__…` → `mcp:thread:global:all`（取前缀到工具域，不进 tool 粒度——旧白名单本就整工具）；
  - 无法识别的条目跳过（不崩、不臆造）。
- 并入 `allowAlwaysPolicies`（去重），**清空 `alwaysAllowTools` 为 `[]`**，重写 `security` 行。
- 迁移出非空列表时 `logger.warn` 一条（对齐 T14 迁移的提示风格）。
- `deps.ts` 在 `migrateSecurityToAlwaysAllowTools(db, logger)`（deps.ts:58）之后追加调用。

## 3. 涉及文件

**新增**

- `packages/harness/src/approval/policy-key.ts` — `buildPolicyKeys` 纯函数
- `tests/policy-key.test.ts` — 纯函数钉形态（对齐 tests/tool-risk.test.ts 写法）

**修改**

- `packages/shared/src/index.ts` — `AppSettings.security` 增 `allowAlwaysPolicies`
- `apps/server/src/services/settings/app-settings.ts` — 默认值增 `allowAlwaysPolicies: []`
- `apps/server/src/routes/settings.ts` — zod `security` 增 `allowAlwaysPolicies`
- `apps/server/src/services/settings/migrate-legacy.ts` — 增迁移函数
- `apps/server/src/deps.ts` — 接线迁移调用
- `tests/settings-migration.test.ts` — 增迁移 describe（仿 T14 段）

## 4. 步骤（测试先行）

**RED 1 — 纯函数**：新建 `tests/policy-key.test.ts` 先红（函数尚不存在）：

- bash 常规：`{toolName:"bash", threadId:"t1", args:{command:"npm test"}}` →
  `["bash:thread:t1:command:npm test", "bash:thread:t1:all"]`（精确在前）。
- bash destructive 置空：`rm -rf /`、`sudo apt update`、`git push --force`、`curl x | sh`
  → `[]`（双保险逐个钉）。
- bash 空命令 / 非 string command → `["bash:thread:t1:all"]`。
- write/edit → `["write:thread:t1:all"]` / `["edit:thread:t1:all"]`。
- mcp：`mcp__github__create_issue` → `["mcp:thread:t1:tool:mcp__github__create_issue", "mcp:thread:t1:all"]`。
- 未知工具（`read_file`/`web_search`）→ `[]`；两个不同 threadId 产不同 key（作用域钉死）。

**GREEN 1**：实现 `policy-key.ts`，纯函数全绿。

**RED 2 — settings 默认值**：`loadAppSettings` 空库返回 `security.allowAlwaysPolicies` 为 `[]`
（在 settings-migration.test.ts 或新 describe 里断言）。**GREEN 2**：shared 类型 + 默认值 +
zod schema。

**RED 3 — 迁移**：`tests/settings-migration.test.ts` 增 describe
`migrateAlwaysAllowToolsToPolicies (T27)`，用 `writeLegacyBlock("security", …)` 造旧态：

- `alwaysAllowTools:["bash","write"]` → `allowAlwaysPolicies` 含
  `bash:thread:global:all`、`write:thread:global:all`，且 `alwaysAllowTools` 被清空。
- 幂等：已含 `allowAlwaysPolicies` 字段（哪怕空数组）→ 不动，不被旧值覆盖。
- 无 security 块 → 不崩；`allowAlwaysPolicies` 默认 `[]`。
- 含无法识别条目 → 跳过该条、其余照迁。

**GREEN 3**：实现迁移 + deps.ts 接线，全绿后跑 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | bash 常规命令产两级 key | 精确 `command:<cmd>` 在前、`:all` 在后 |
| 2 | destructive 命令 `buildPolicyKeys` 返回空 | `rm -rf /`/`sudo …`/`git push --force`/`curl x\|sh` 均 `[]` |
| 3 | 旧白名单迁移成 thread:global | `["bash","write"]` → `bash:thread:global:all`+`write:thread:global:all`，旧字段清空 |
| 4 | 迁移幂等 | 已含 `allowAlwaysPolicies` 则不动 |
| 5 | settings 往返 | PUT 存 `allowAlwaysPolicies` 后 GET 读回一致（zod 不 422） |
| 6 | **移除实验**：注释掉 `policy-key.ts` 里 destructive 置空分支 | 用例 2 转红（证明测试在守这道关） |
| 7 | **移除实验**：注释掉迁移函数体 | 用例 3、4 转红 |

E2E（手动，可延后到 T28 一并验）：设置页「始终允许」当前 thread 一条命令后，
`~/.eva/eva.db` 的 `security` 行出现 `bash:thread:<id>:command:<cmd>`——本任务只保证
字段存取与迁移正确，「点按钮写 key」的接线在 T28/T30。

## 6. 坑（按踩中概率排序）

1. **zod schema 漏加字段 → GET /settings 422**。`routes/settings.ts` 的 `security` 是显式
   zod 对象，shared 加了字段、这里不加，PUT 能进但 GET 序列化校验炸。改 settings 字段时
   **三处必须一起动**：shared 类型、app-settings 默认值、routes zod。
2. **destructive 置空的 import 方向**。`policy-key.ts` 在 `approval/`、`classifyToolRisk`
   在 `tools/`。若图省事把判定挪进 risk.ts 或反向 import，会与 `tools/index.ts` barrel
   成环。固定 `approval/policy-key.ts → ../tools/risk.js` 单向。
3. **迁移幂等标志别用错字段**。T14 迁移用「存在 `alwaysAllowTools`」当标志，本任务用
   「存在 `allowAlwaysPolicies`」。写成一个迁移误判另一个的字段会连环触发。两个迁移
   在 deps.ts 里先后跑，各自只认自己的标志。
4. **threadId 为空时别静默产 `thread:`**。`buildPolicyKeys` 假定 `threadId` 非空（调用方
   T28 的 gateway 一定有 sessionId）。纯函数内不做兜底造 `thread:global`——那是迁移
   专属的显式兜底，函数里混进这个分支会让「哪个 thread」语义模糊。
5. **迁移只认 `mcp__` 前缀到工具域**。旧白名单若有 `mcp__github__x`，折成
   `mcp:thread:global:all`（整域），不要逐工具展开——旧数据本就不知道用户想放哪个工具。
6. **`bash:thread:<id>:all` 是合法且要的 key**。别因为「command 为空」就连 `:all` 也不产
   `main:28077-28087` 空命令不产精确 key、仍 push `:all`。空命令只省精确 key，不省粗 key。
