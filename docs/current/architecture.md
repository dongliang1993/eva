# Eva 今天的架构

> **这是当前事实，不是目标。** 写不确定的东西请写进 `docs/plans/`，不要写进这里。
> 最后一次逐项对照代码：2026-10-12。
> 已知未闭环的能力缺口见 [`../reviews/2026-10-10-maturity-review.md`](../reviews/2026-10-10-maturity-review.md)。

Eva 是一个本地优先的 AI agent 桌面助手：一个 Electron 壳把 Fastify server 作为
utility process 拉起来，前端是同一个 server 托管的 React SPA，agent 执行内核是
一个独立的 package。**没有云端组件，没有第二个进程模型。**

## 1. 进程与产物

```text
Eva.app
 └── Electron 主进程            apps/desktop/electron/main.ts        只做启动序列
      ├── utilityProcess: server  apps/server/src/index.ts            Fastify,只听 127.0.0.1
      │     └── 内嵌 agent 内核   packages/harness                    工具循环、skill、记忆
      └── BrowserWindow           apps/web(打包后由 server 托管)      React 19 SPA
```

- 端口在启动时动态分配；dev 态 server 由 `pnpm serve:dev` 单独跑，UI 走 Vite 5173。
- 主进程与 server 之间有一个 **loopback token**（`x-eva-token`）：每次启动重新生成、不落盘。
  白名单只放只读/静态，操作面必须带 token，白名单判定是**精确相等**
  （`apps/server/src/loopback.ts` —— 想改成前缀匹配前先想清楚在放行什么）。
- 用户数据全在 `~/.eva/`：`eva.db`(SQLite) / `MEMORY.md` / `memory/` / `skills/` /
  `mcp.json` / `.secret-key`。

四个包的依赖方向是单向的，由 `pnpm lint:arch` 强制（见 [ADR C1](../adr/0001-dependency-direction.md)）：

| 包 | 可以依赖 | 明确不能依赖 |
|---|---|---|
| `apps/web` | `@eva/shared` | server 内部、harness、DB |
| `apps/desktop` | 桌面内部、`@eva/shared` 契约 | server service、harness 内部 |
| `apps/server` | `@eva/harness`、`@eva/shared` | web、desktop |
| `packages/harness` | `@eva/shared`、AI SDK | Fastify、Drizzle、Eva DB、React、Electron |
| `packages/shared` | 几乎为零 | 上面全部 |

## 2. Server：一个能力一个垂直模块

```text
apps/server/src/
  index.ts / server.ts / app.ts     进程入口、Fastify 生命周期
  deps.ts                           基础设施装配(config / db / skills / observer)
  services/index.ts                 业务服务装配(AppServices)
  api/index.ts                      组合根:route 能看到的全部东西 → AppApi
  routes/index.ts                   把各模块的 route 挂上去
  modules/<能力>/                    17 个垂直模块,见下表
  db/{schema.ts,migrations/}        表定义与迁移(不按模块拆)
  transports/sse/                   SSE 帧编码与心跳
  infrastructure/ lib/ types/       加密、monorepo 根、token 估算等非业务件
```

每个模块内部形状一致 —— **`index.ts` 是唯一入口**（[ADR C9](../adr/0009-single-module-entry.md)）：

```text
modules/runs/
  index.ts            公开入口:导出用例、查询、Repository 类(仅给组合根)
  api.ts              AppApi 的那一片:route 只能看到它
  route.ts            HTTP/SSE 适配器
  run-coordinator.ts  用例编排
  run-*.ts            该能力的实现文件(默认私有)
  run-repository.ts   这张表的读写
```

16 个模块：

| 模块 | 它拥有什么 |
|---|---|
| `runs` | 一次 Run 的编排、台账、注册表、扇出、assistant 消息投影、agent 工厂 |
| `sessions` | 会话、消息树、会话状态与用量聚合 |
| `approvals` | 审批请求与 always-allow policy |
| `providers` | provider 配置、模型解析、context clamp |
| `settings` | 应用设置读写与历史迁移 |
| `skills` | skill 目录与每轮 skill 选择 |
| `memory` | DB 记忆 + 人类可读记忆文件 + 召回 |
| `compact` | 会话级显式压缩（`session_compactions` 快照；步中自动 compact 在 harness，不在这里） |
| `workspaces` | 工作区绑定、目录守卫、项目文档注入 |
| `plan-gate` | 会话级 plan 审批闸门 |
| `subagents` | 前台子代理任务与回报 |
| `mcp` | MCP server 配置、连接、工具暴露 |
| `observability` | run_events 台账、脱敏、保留策略、轨迹读取面 |
| `search` | 跨会话消息检索 |
| `usage` | token 用量记录 |
| `system` | health、静态资源 |

`plan-weave` 已随执行内核重建退役（代码零命中）；`plan-gate` 是留下来的那个，
会话级审批闸门。

Route 拿到的只有 `AppApi`（`app.api`），拿不到 `db`、`encryptor` 或任何 Repository ——
`lint:arch` 的三条规则（`routes-only-app-api` / `routes-no-db` /
`repository-only-in-composition-root`）扫 `routes/` 与每个 `modules/*/…route.ts`，
锁住这一条（见 [ADR 0002](../adr/0002-protocol-layer-only-translates.md)）。

**这条只对 route 成立。** 模块内部今天仍有 17 个文件在自己 `new` Repository（其中一部分
new 的是**别的模块**的 Repository，例如 `modules/compact/` 建 sessions 的两个、
`modules/sessions/session-status.ts` 建 runs 的）—— 那是 Wave 4 留下的债，
`lint:arch` 目前不拦，详见 [ADR 0008](../adr/0008-composition-root-only.md)。

## 3. Harness：agent 执行内核

`packages/harness` 不知道 HTTP、不知道 SQLite。它的公开面是
`query({ prompt, options })` → `AsyncGenerator<HarnessMessage>`（接口形状照
Claude Agent SDK，见 [ADR 0013](../adr/0013-harness-api-mirrors-agent-sdk.md)）。

```text
packages/harness/src/
  query/        query() 入口 + turn/tool-call/permission/hooks + 内置 subagent 工具
  agents/       run-loop(turn 循环本体,query() 的引擎)
  models/       LanguageModel 适配(AI SDK)
  tools/<名>/   一个工具一个文件夹:tool.ts 工厂 + 可选 client/types
  context/      prepareStep:工具结果预算、主动压缩、system 提升
  skills/       SKILL.md 加载与校验
  prompts/      prompt sections
```

一次工具调用的生命周期在 `query/tool-call.ts` 一个函数里（hooks → canUseTool 权限 →
只读并发位 → execute → hooks），三段计时（审批等待 / 排队 / 执行）挂在 `user` 消息的
`tool_timing` 上。server 用纯函数 `toRunStreamFrames` 把 `HarnessMessage` 翻成现有 SSE 帧
（协议不变、前端零改动），`run-trajectory.ts` 把它翻成 run_events 的 26 种 kind。

跨包的 `options.canUseTool`（server 侧 `createRunPermissions` 实现）是真正的 Port ——
harness 绝不能知道 DB 与 SSE。除此之外 harness 里只有一个 Port：`LanguageModel`
（AI SDK 提供，测试用 `MockLanguageModelV4`）。见 [ADR C6](../adr/0006-ports-only-at-change-boundaries.md)。

## 4. Web：一个 feature 一个目录

```text
apps/web/src/
  features/
    threads/        聊天页
      hooks/        use-chat(组合) / use-run-controller(在飞) / use-thread-messages(历史)
                    use-thread-list(侧栏数据) / use-approvals / use-stick-to-bottom
      stream-reducer.ts   纯投影:(state, action) => state,无 React 依赖
      components/   消息气泡、工具卡片、侧栏、输入框、审批卡片
      trajectory/   会话内「轨迹」tab(纯投影 → 折叠 → 虚拟化台账)
    settings/       设置页(真实路由 /settings/*),每个 tab 拆成表单/列表/危险操作
    workspaces/     工作区选择
  shared/api/       fetch 包装 + SSE run-stream client(只解析协议,不动 React 状态)
  shared/{ui,hooks,markdown,streaming}/
  types/api.ts      从 @eva/shared 再导出
```

一次对话的读写只有一个入口 `use-chat.ts`：它持有唯一的 `ChatProjection`，把 `dispatch`
分给两个子 hook。**投影是纯函数**（`stream-reducer.ts`），有独立的事件序列测试
（`tests/web/streaming/stream-reducer.test.ts`）。

### 三条不许动的渲染性能结论

它们不是随手写成这样的，改动前先读注释：

1. **`committed` 与 `streaming` 是两个字段。** 一个 token 只换 `streaming` 的引用，
   `committed` 数组引用整轮流式不变，所以 memo 住的历史列表一次都不重渲染。
   测试里逐帧 `toBe` 钉住了这一条。
2. **`useStickToBottom` 用 `scrollTop` 直写**，不是 `scrollIntoView({behavior:"smooth"})` ——
   后者在逐 token 增长下会抖。平滑滚动只留给「用户发出新消息」这一刻。
3. **虚拟化在 40 条已完成消息以上才启用**，在飞的那条永远在虚拟化器之外。

## 5. Desktop：只是宿主

`electron/main.ts` 只剩启动序列（96 行），每个区块自己一个文件，进程级单例状态各归一个 owner：

| 文件 | 它独占什么 |
|---|---|
| `server-supervisor.ts` | 端口、loopback token、server 子进程句柄 |
| `window-manager.ts` | `mainWindow`(死窗重建逻辑只有这一份) |
| `window-state.ts` | `window-state.json` |
| `app-lifecycle.ts` | `isQuitting`(托盘退出也走 `requestQuit()`) |
| `protocol-handler.ts` | `eva://` 深链与冷启动缓存 |
| `tray.ts` | 托盘与全局快捷键 |
| `shell-env.ts` / `system-proxy.ts` / `ipc-handlers.ts` | 无状态 |
| `updater.ts` / `updater-download.ts` | 自更新(整包换包,不做组件级热更) |

启动顺序里有两处不能调换：IPC 通道 / 单实例锁 / `open-url` 监听必须挂在 `app.whenReady()`
**之前**（mac 的 `open-url` 可能早于 ready），`initUpdater()` 必须在 ready **之后**
（autoUpdater 要读 `app.getPath`）。

## 6. 边界怎么被强制

- `pnpm lint:arch`（`scripts/check-architecture.mjs`）—— 8 条规则，当前 0 error / 0 warning。
  它检查的是**依赖方向与模块入口**这类可判定规则，不做风格检查。仓库没有 ESLint。
- `pnpm typecheck` / `pnpm test`（当前 88 文件 / 696 用例）/ `pnpm build` / `pnpm web:build`。
- Run 的终态只写一次：所有收尾路径都走 `Coordinator.settle()`，`runs.settle` 的条件更新
  （只改 `status = 'running'` 的行）在数据库层兜底。

## 7. 想改点什么，从哪里开始读

| 要做的事 | 先读 |
|---|---|
| 改一次对话的服务端流程 | [`run-lifecycle.md`](./run-lifecycle.md) |
| 找某份状态的所有者 | [`data-ownership.md`](./data-ownership.md) |
| 加一个工具 | `packages/harness/src/tools/<名>/tool.ts` 任选一个照抄 |
| 加一条 HTTP 端点 | 对应 `modules/<能力>/route.ts` + `api.ts` |
| 加一个设置项 | `packages/shared/src/index.ts` 的 `AppSettings` → `modules/settings/` |
| 改前端渲染 | `apps/web/src/features/threads/`，先读上面第 4 节的三条性能结论 |
| 改桌面启动 | `apps/desktop/electron/main.ts` |
| 找测试放哪 | [`tests/README.md`](../../tests/README.md) |

## 8. 明确不做的

- 不做多用户、不做云同步、不做服务端渲染。
- 不为「以后可能要换」造抽象：SQLite 不会被换掉，Repository 直接实例化。
- 不做组件级热更新：server / web / sidecar 一律随整包更新。
