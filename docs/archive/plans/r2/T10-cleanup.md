# T10 · 遗留清理 + settings 真路由 + 文档同步

> 前置：T5–T9 都合并之后再做（它会校对前面五个任务留下的文档与死代码）。
> 开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。

这个任务没有新功能，只有三件事：**删掉不再有意义的东西、把假路由做成真路由、让文档与代码逐条对上**。

---

## 1. 死代码清单（实证）

以下 11 条每一条都是 `grep` 出来的零引用，不是猜的。开工时**逐条复核一遍**（前面四个任务可能已经顺手动过），复核不成立的就跳过并在本文件里划掉。

### 1.1 `sessions` 表的 4 个死列

```
apps/server/src/db/schema.ts:11,13,14,15
  reasoning_effort / tool_policy / skill_policy / memory_policy
apps/server/src/db/repositories/types.ts:8,10,11,12
  Session.reasoningEffort / toolPolicy / skillPolicy / memoryPolicy
```

除了 schema 定义与 `Session` 接口，**零读取方**。它们是 work-mi 时代"会话级策略"的残留。

**动作**：迁移 `DROP COLUMN` ×4 + 从 `Session` 接口删除。

### 1.2 `sessionKey` 与 `resolveByKey`

```
apps/server/src/services/session.ts:70   resolveByKey  ← 只有 tests/session.test.ts:216,225 调用
apps/server/src/db/schema.ts:9           session_key   ← 现在存的是 randomUUID()，没有任何语义
```

`resolveByKey` 是 IM 多通道（`docs 15` S16，Phase E）的接口：用 `chat_id:sender_id` 这类外部键找会话。现在没有任何通道接进来，`createSession` 塞的是随机 UUID —— 一个**永远不会被查中的索引列**。

**动作**：删 `resolveByKey`、删 `session_key` 列与其索引、删对应测试、`CreateSessionInput.sessionKey` 去掉。S16 真的要做时，那时的外部键形状（是 `channel:chat:sender` 还是别的）由那时的需求决定，现在留一个空壳只是让每次建会话多写一个无用的 UUID。

> 这条要在 commit 正文里写清"S16 需要时重新加"，并在 FINDINGS 记一条 `[r3]`，避免以后有人以为是误删。

### 1.3 `provider-models.ts` 与两张缓存表

```
apps/server/src/services/provider-models.ts        124 行，零调用方
apps/server/src/db/schema.ts  provider_models_cache / model_capabilities_cache   零读写
```

T7 会把 `provider-models.ts` 的内容并进 `provider-http.ts`；两张缓存表则是**从未被读过**的表
（`grep -rn "providerModelsCache\|modelCapabilitiesCache" apps` 只命中 schema 定义）。

**动作**：确认 T7 已删文件后，迁移里 `DROP TABLE provider_models_cache` / `DROP TABLE model_capabilities_cache`，
并从 `schema.ts` 删掉两个表定义。若 T7 给它们接上了真实读写（拉模型列表做缓存），跳过本条并在这里划掉。

### 1.4 `Provider.apiVersion` —— 一个永远是 undefined 的字段

```
packages/shared/src/index.ts   Provider.apiVersion?: string
apps/server/src/db/schema.ts   providers 表没有对应列
```

契约上声明了、DB 里没有、读的地方拿到永远是 `undefined`。**动作**：从 `Provider` 删掉
（T7 已经在瘦身这个接口，复核一下是否已随手删掉）。

### 1.5 `routes/runs.ts` 末尾的占位导出

```ts
// apps/server/src/routes/runs.ts:281-282
// 保留 EvaUIMessage 类型引用供未来 run 台账查询接口复用。
export type { EvaUIMessage };
```

"供未来接口复用"的类型 re-export。T8 已经把 run 台账查询接口做出来了（`/threads/:id/status`
与 `/usage`），它们各自从 `@eva/shared` 直接 import。**动作**：删这两行。

### 1.6 `types/runs.ts` 的 `RunInput`

```
apps/server/src/types/runs.ts:25   export interface RunInput   ← 零引用
```

R1 T1 把请求契约收成 `runRequestSchema` / `RunRequest` 之后它就没人用了。**动作**：删。

### 1.7 model 工厂的死 `temperature` 与死接口

```
packages/harness/src/models/openai-compatible.ts:7-16
  OpenAiCompatibleConfiguration      ← 零引用（定义了 configuration.baseURL，但实现读的是 options.baseURL）
  OpenAiCompatibleModelOptions.temperature
packages/harness/src/models/anthropic.ts:11        AnthropicModelOptions.temperature
packages/harness/src/models/agent-model.ts:12      AgentModelOptions.temperature
```

R1 T0.1 之后 temperature 走 `callSettings`，这三个字段收了但从不使用。

**动作**：删 `temperature` 三处、删 `OpenAiCompatibleConfiguration` 与 `OpenAiCompatibleModelOptions`（后者已被 `AgentModelOptions` 取代）。

### 1.8 T6–T9 之后应当已消失的东西（复核用）

- `services/settings-store.ts` / `provider-runtime.ts` / `provider-models.ts` —— T7 删
- `AppSettings` 的 `general` / `webSearch` 块与零行为字段 —— T7 删
- `estimateHistoryTokens` —— T8 删
- `TARGET_REPO_ROOT`（除 T6 的过渡函数） / `AppInfrastructure.workRoot` —— T6 删

`grep` 一遍，还在的说明前面漏了，补掉。

### 1.9 `Agent.invoke` 的去留

```
packages/harness/src/agents/types.ts:40   invoke(input): Promise<AgentRunResult>
```

`/runs/wait` 在 R1 T1 删掉后，`invoke` 的生产调用方为零（只有 `tests/lead-agent-*.test.ts` 用它做断言便利）。

**动作：保留**，但在接口上加一行注释说明它的定位：

```ts
/**
 * 跑完整一轮并返回终态结果（内部就是把 stream 消费干）。
 * 目前只有测试在用；S7 的子代理会用它（子代理不需要流式，只要 final answer）。
 * 若 S7 落地后仍无生产调用方，那时再删。
 */
invoke(input: AgentRunInput): Promise<AgentRunResult>;
```

> 判断标准：**死代码要删，有明确近期用途的接口留着但要写清用途**。没注释的"以后可能有用"就是死代码。

### 1.10 桌面壳的旧品牌残留（D10）

```
apps/desktop/electron/main.ts   LOADING_HTML 里的 <h1>Work MI</h1>
                                console.log("[app] Starting Work MI Desktop...")
```

项目已改名 Eva，加载页与启动日志还写着 work-mi 时代的名字 —— 用户第一眼看到的就是它。

**动作**：改成 `Eva`。顺带复核 `apps/desktop/electron-builder.yml` 的 `productName` / `appId`
与 `apps/desktop/build/` 下的图标资源名是否也还挂着旧名。

### 1.11 D9 复核：overflow 目录是否真的搬出了用户仓库

T6 把 tool-overflow 从 `{workRoot}/.eva/tool-output` 搬到 `~/.eva/tool-overflow/<workspaceId>/`。
**这里只做复核，不重做**：

```bash
grep -rn "tool-output" apps packages --include='*.ts'          # 应无结果
grep -rn "toolOverflowDir\|tool-overflow" apps/server/src      # 应指向 ~/.eva 下
```

同时确认 T6 的补充节（`T6-workspaces.md` §7）说的"overflow 目录进只读白名单"确实落地了 ——
否则 `maybeOverflow` 返回给模型的那句 "Use read_file on that path" 是一句它做不到的指令。

---

## 2. `/settings/*` 做成真路由

FINDINGS 里的 `[next]` 条目。

### 2.1 问题

```tsx
// apps/web/src/features/settings/settings-page.tsx:23
const [activeNav, setActiveNav] = useState<NavId>("general");
// :72-74
{activeNav === "general" ? <GeneralSettings /> : null}
```

组件内 state 切 tab。后果：直链 `/settings/providers` 打不开对应 tab（永远落在第一个）、设置页内前进/后退无效、无法把某个设置页的链接发给别人。

### 2.2 目标

```
/settings                → redirect /settings/models
/settings/models         ModelSettings     （T7 把 general 改名成了 models）
/settings/providers      ProviderSettings
/settings/memory         MemorySettings
/settings/mcp            McpSettings       （T9 新增）
```

`app.tsx` 里：

```tsx
<Route path="/settings" element={<SettingsLayout />}>
  <Route index element={<Navigate to="models" replace />} />
  <Route path="models" element={<ModelSettings />} />
  <Route path="providers" element={<ProviderSettings />} />
  <Route path="memory" element={<MemorySettings />} />
  <Route path="mcp" element={<McpSettings />} />
</Route>
```

`settings-page.tsx` 变成 `settings-layout.tsx`：左侧导航用 `NavLink`（自带 active 态，不用自己比字符串），右侧 `<Outlet />`。`NAV_ITEMS` 从 `{id, label, icon}` 变成 `{to, label, icon}`。

顺带把 `settings-header.tsx` 的 title/icon 从"父组件查表传进来"改成各子页自己声明（现在是 `NAV_ITEMS.find(...)!` 加非空断言 —— 那个 `!` 就是"这个查表本来不该存在"的信号）。

### 2.3 验收

- [ ] 浏览器直接打开 `/settings/memory` → 落在 Memory 页
- [ ] 在设置页内点几个 tab 后按浏览器后退 → 逐个退回
- [ ] `grep -n "activeNav" apps/web/src` 无结果
- [ ] `grep -n "NAV_ITEMS.find" apps/web/src` 无结果

---

## 3. 文档同步

### 3.1 `AGENTS.md`

R1 T4 把它校准过一次，T5–T9 又动了不少。**逐条对齐**（这是给每个 session 的输入，错的比没有更糟）：

| 小节 | 要改什么 |
|---|---|
| Architecture / Server Layer | `AppInfrastructure` 去掉 `workRoot`；`AppServices` 加 `workspaces` / `mcp` |
| `AgentFactory` 那段 | `resolve()` 已拆成 `resolveModel()` + `createAgent()`；模型槽位改为 chat/tool/embedding |
| Tool Convention | 加 `buildJsonSchemaTool`（JSON Schema 版）与 `TOOL_ERROR_PREFIX` 约定 |
| SSE Streaming | 事件表复核（T5–T9 没加新事件，确认一下） |
| Frontend 目录树 | 加 `features/workspaces/`；`settings/` 改成真路由结构 |
| Configuration | **删 `TARGET_REPO_ROOT` 整行**，加一句"工作区在应用内管理，不走环境变量"；MCP 配置文件位置 `~/.eva/mcp.json` |
| 新增小节 | **Workspaces**（会话级绑定、路径校验红线、项目文档注入）、**MCP**（DB 唯一事实源 + mcp.json 导入、审批默认开） |

### 3.2 `README.md`

Roadmap 表按实际进度重排：S1/S1.1/S2 已完成（R1）、S3 完成（T6）、S8 完成（T9）、S4 部分完成；把"critical path"一行改成剩下的 `S6 → S9 → S7 → S11`。

`## API Endpoints` 那节补上 T6/T8/T9 的新路由，删掉 `/api/v1/runs/wait`（R1 已删但 README 可能还留着，复核）。

### 3.3 `docs/architecture/` 的两处校正

这两篇是**设计基线**，不是流水账，所以只改"与最终决策不一致"的地方，并标注改因：

1. **`14-eva-architecture.md` §4.7**：把「`mcp.json` + DB `mcp_servers` 表双来源」改成「DB 唯一运行时来源 + `mcp.json` 作为导入通道」，附一句理由（双运行时来源需要合并与冲突规则，收益不抵复杂度）。同时把 OAuth 标为 R3。

2. **`14-eva-architecture.md` §5.2**：状态表里的 `waiting`（有存活后台任务）标注「S7 引入 `background_tasks` 后再加；T8 只落地三态」。

3. **`15-eva-execution-playbook.md` §1 进度总览表 + §8 依赖图**：按 R1/R2 的实际完成情况重算，并说明 S8 提前到 S6/S7 之前的理由（指向 `r2/00-overview.md` §2.1）。

### 3.4 `docs/plans/README.md`

```markdown
# docs/plans

## 在用
- `r2/` —— 当前一轮 spec（T5–T10）。入口：`r2/00-overview.md`

## 已完成（保留作施工记录）
- `r1/` —— 第一轮重构（T0–T4），已全部合并。`r1/FINDINGS.md` 是**持续累积**的流水账，仍在写。

## 历史（决策记录，不再更新，勿照此实现）
- `s1/s1-wrapup-technical-design.md` —— LangChain → AI SDK 迁移设计
- `2026-04-05-claude-code-style-compaction-design.md` —— 压缩策略设计
- `s4-tools-approval.md` —— 审批闸门初版，已被 `r1/T0-p0-fixes.md` §T0.4 取代
```

### 3.5 `.env.example`

只剩 `PORT` / `HOST` / `LOG_LEVEL` / `DB_PATH` 四项 + 两行注释说明「模型配置在 Settings 里、工作区在应用内添加」。

---

### 3.6 删代码的证据要求

对齐 `00-overview.md` §3 第 3 条：**本任务每删一个符号，都要把复核用的 grep 命令与"零结果"贴进 commit 正文。**
§1 里列的引用数是撰写 spec 时的实测值，T5–T9 可能已经改变了它 —— 发现有调用方就停下来报告，不要硬删。

---

## 4. 步骤

按这个顺序做，每步 `pnpm typecheck && pnpm test`：

1. **复核 §1 的每条死代码**（前面任务可能已处理），列出实际还在的清单。
2. **迁移 `0019_drop_legacy_session_columns.sql`**：
   ```sql
   DROP INDEX IF EXISTS `idx_sessions_session_key`;
   --> statement-breakpoint
   ALTER TABLE `sessions` DROP COLUMN `session_key`;
   --> statement-breakpoint
   ALTER TABLE `sessions` DROP COLUMN `reasoning_effort`;
   --> statement-breakpoint
   ALTER TABLE `sessions` DROP COLUMN `tool_policy`;
   --> statement-breakpoint
   ALTER TABLE `sessions` DROP COLUMN `skill_policy`;
   --> statement-breakpoint
   ALTER TABLE `sessions` DROP COLUMN `memory_policy`;
   ```
   同一个迁移里顺手删掉两张零读写的缓存表（§1.3）：
   ```sql
   DROP TABLE IF EXISTS `provider_models_cache`;
   --> statement-breakpoint
   DROP TABLE IF EXISTS `model_capabilities_cache`;
   ```
   journal 追加 `idx: 19`。同步改 `schema.ts` / `repositories/types.ts` / `session-repository.ts`（`create` 不再写 `sessionKey`）/ `SessionService`（删 `resolveByKey`）/ `tests/session.test.ts`（删对应两个用例）。
3. 删 §1.3 / §1.4 的死接口与死字段。
4. §1.6 给 `invoke` 加注释。
5. `/settings/*` 真路由（§2）。
6. 文档同步（§3）—— 放最后，因为它要反映前面所有改动。
7. 最后跑一遍全量核对：见 §5。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿
- [ ] 死代码全清：
  ```bash
  grep -rn "sessionKey\|session_key\|reasoningEffort\|toolPolicy\|skillPolicy\|memoryPolicy\|resolveByKey" apps packages tests --include='*.ts' --include='*.tsx' | grep -v node_modules
  grep -rn "RunInput\b" apps --include='*.ts' | grep -v "StartRunInput\|SettleRunInput\|AgentRunInput"
  grep -rn "OpenAiCompatibleConfiguration\|OpenAiCompatibleModelOptions" packages
  grep -rn "settings-store\|provider-runtime\|provider-models\|estimateHistoryTokens\|activeNav\|NAV_ITEMS.find" apps packages tests --include='*.ts' --include='*.tsx' | grep -v node_modules
  ```
  以上全部**无输出**（`TARGET_REPO_ROOT` 只允许出现在 T5 的过渡函数里）。
- [ ] `AGENTS.md` 逐条对得上：
  - Configuration 表里的每个环境变量都能在 `config.ts` 的 `envSchema` 找到，反之亦然；
  - SSE 事件表的每个名字都能在 `packages/shared/src/stream-events.ts` 找到；
  - Frontend 目录树与 `find apps/web/src -type d` 的实际结构一致；
  - `AppServices` 列出的成员与 `types/common.ts` 一致。
- [ ] `README.md` 的 API Endpoints 节与 `grep -rn "app\.\(get\|post\|put\|patch\|delete\)" apps/server/src/routes` 的结果一致
- [ ] 直链 `/settings/memory`、`/settings/mcp` 都能打开对应页
- [ ] `grep -rn "Work MI\|work-mi" apps --include='*.ts' --include='*.yml'` 无结果（品牌残留已清）
- [ ] `sqlite3 ~/.eva/eva.db ".tables"` 里没有 `provider_models_cache` / `model_capabilities_cache`
- [ ] `docs/plans/README.md` 区分了在用 / 已完成 / 历史三类

## 6. 坑

1. **`DROP COLUMN` 前必须先删依赖它的索引**（`idx_sessions_session_key`），否则 SQLite 报错。迁移里的顺序不能颠倒。
2. **删列会让老快照失效**：`meta/` 里只有 0000–0005 的 snapshot，drizzle 迁移器只读 journal + sql，所以不受影响。但如果以后有人跑 `drizzle-kit generate`，它会基于 schema 重新算 diff —— 本仓库的约定是**手写迁移**，别在这个任务里引入 `drizzle-kit generate`。
3. **文档校对要用命令而不是眼睛**。§5 的每条验收都给了 grep/find 命令，照着跑，别通读。
4. **`resolveByKey` 删除要在 commit 正文留痕**（S16 需要时重建），并在 `r1/FINDINGS.md` 加一条 `[r3]`。
