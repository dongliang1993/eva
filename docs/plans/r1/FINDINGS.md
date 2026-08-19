# FINDINGS

执行 T0–T4 期间**发现了但按纪律没有顺手改**的问题（`00-overview.md` §1.2）。

**写入规则**：只追加，不删改别人的条目。一条一段，写清「在哪、是什么、为什么现在不改」。
每条打上 `[done in T4]` / `[next]` / `[wontfix]` 之一。

---

## 已处理

### 审批接口前缀不一致 `[done in T4]`

`apps/server/src/routes/approvals.ts` 原挂在 `/api/tool-approvals`，其余所有接口都是 `/api/v1/...`。
T4 统一成 `/api/v1/tool-approvals`（routes/approvals.ts + features/threads/api.ts 两个文件）。

### `docs/architecture/10-frontend-conventions.md` 的目录树是 Alma 的物理布局 `[done in T4]`

10 篇写的是 `src/{main,preload,renderer}` 的 Electron 单包形态，Eva 拆成了 `apps/web` + `apps/desktop` + `apps/server`。约定本身没问题，缺的是一张映射表。T4 在 AGENTS.md 的 Frontend 一节写明了 `apps/web/src` ↔ 10 篇 `src/renderer/` 的映射。

### `chat-view.tsx` / `message-list.tsx` / `message-bubble.tsx` 未 memo `[done in T3]`

T1 只把 props 类型从 `DisplayMessage` 换成 `EvaUIMessage`、按 parts 渲染。
T3 §1.1 做了渲染分层（committed / streaming 双状态 + `CommittedMessages`/`MessageBubble`/`ToolCallBlock` memo + 虚拟化）。

### `apps/web/src/api/client.ts` 的 `toolPartToInfo` 是临时适配器 `[done in T3]`

T1 加了 `toolPartToInfo(part) → ToolCallInfo` 让 `tool-call-block.tsx` 不动。
T3 后 `tool-call-block.tsx` 仍消费 `ToolCallInfo`（`toolPartToInfo` 在 `shared/api/run-stream-client.ts`）。保留:它是一个薄适配器,改 tool-call-block 直接消费 `EvaDynamicToolPart` 收益不大,留到后续若有 tool-call UI 重做时再删。

### `apps/web/src/hooks/use-chat.ts` 157 行,未拆成 use-run-stream `[next]`

T3 §4 计划把 use-chat 拆成 `use-run-stream.ts` + `use-chat.ts`(<120) + `use-thread-url.ts`。
实际 use-chat.ts 157 行:SSE 消费、committed/streaming 双状态、builder 结算都在一个 hook 里,
没有单独抽出 use-run-stream（thread-URL 同步本来就在 chat-page 里）。
未拆:当前结构已足够清晰,且 use-run-stream 会和 useChat 紧耦合（SSE 帧直接驱动 builder）。
粗估工作量:半天。触发条件:settings 改成真子路由（见下条）时一起拆 `use-thread-url`。

---

## 下一轮

### `/settings/*` 子页不是真路由 `[next]`

`apps/web/src/features/settings/settings-page.tsx` 用组件内 `activeNav` state 切换子页,不是 React Router 子路由。后果:直链 `/settings/providers` 打不开对应 tab,浏览器前进/后退在设置页内无效。
不在 T3 顺手改:牵动 settings 下三个大组件（`memory-settings`、`provider-settings` 等）。
粗估工作量:1–1.5 天。和 use-thread-url 拆分一起做最划算。

---

## R2 撰写期间新增

### 两个 session 并行写 `docs/plans/r2/`，已合并 `[done in R2 规划]`

R2 的 spec 由两个 session 并行产出过一次，编号一度冲突（一版 T5=工作区，一版 T5=P0 修复）。
已按「P0 修复排最前」的版本收敛：T5 P0 → T6 工作区 → T7 provider → T8 运行时 → T9 MCP → T10 清理，
重复的 workspaces spec 删掉一份（保留了带 D9 overflow 目录修正的那份）。
**教训**：多 session 写同一个目录前先约定文件名与编号，或各自写到独立目录再合并。

### `RunRegistry.register(runId, sessionId = "")` 的默认参数掩盖了漏传 `[done in T5]`

P0.1 的根因不只是"忘了传 sessionId"，而是**给了默认值 `""`**：调用方漏传时类型检查不报错、
运行期也不报错，只是安静地把审批归属变成空串。142 项测试全绿也没挡住。
**教训**：跨调用点传递的必需标识不要给默认值 —— 让它必填，漏传就编译不过。
T5 把 `RunRegistry` 化简成"runId → AbortController"之后这个坑自然消失。

### overflow 目录搬出工作区会让 `maybeOverflow` 的自救指令失效 `[done in T6]`

`tool-overflow.ts` 返回给模型的文本是 "Use read_file on that path"，而 `read_file` 的沙盒
（`resolveWorkspacePath`）只认工作区。D9 把 overflow 目录搬到 `~/.eva/tool-overflow/` 之后，
这句指令就变成模型做不到的事。已在 `r2/T6-workspaces.md` §7 补上"只读白名单"方案
（`resolveReadablePath` + `FsToolBaseOptions.readableRoots`，只放开读、不放开写）。
**教训**：改一个文件的落盘位置时，要一起检查"谁在文本里承诺过这个位置能被访问"。

### embedding 维度切换没有自动探测 `[r3]`

`db/index.ts:EMBEDDING_DIMENSIONS` 硬编码 1024（BGE-M3）。换 embedding 模型如果维度不同，
T0.2 的重建逻辑会 DROP 向量表并把 `ready` 打回 `pending` —— 行为是对的，但用户只能从日志看出来。
R2 T7 只做"检测到 `models.embedding` 变化时 log warn"。自动探测维度（首次 embed 时读实际长度并写入
`memory_metadata`）留到 R3。

### MCP OAuth 授权流 `[r3]`

`docs 14 §4.7` 计划的 `mcp_oauth_tokens`。R2 T9 只支持静态 token（`headers` 里塞 Bearer）。
理由见 `r2/T9-mcp.md` §0。

---

## T9（MCP）期间新增

### 全仓库没有 ZodError → 400 的处理 `[r3 或 T10]`

`apps/server/src/app.ts` 没有 `setErrorHandler`，各路由直接 `schema.parse(...)`。
后果：任何请求体不合法都变成 **500**（而不是 400）。
T9 的 `routes/mcp-servers.ts` 用 `safeParse` 在本路由内返回 400 绕开了它，但
`workspaces` / `threads` / `settings` / `providers` 等路由仍是 500。
修法：`app.ts` 加一个 `setErrorHandler`，`ZodError → 400 + 首条 issue 文案`，
然后把各路由里的手工 `safeParse` 收回成 `parse`。**注意这会改变现有路由的响应码**，
所以要单独一个 commit。

### `apps/web` 没有 `typecheck` 脚本 —— 根 `pnpm typecheck` 跳过了整个前端 `[T10]`

根命令是 `pnpm -r --if-present typecheck`，而 `apps/web/package.json` 只有 dev/build/preview。
前端类型错误只在 `pnpm web:build` 时才暴露。
修法：给 `apps/web` 加 `"typecheck": "tsc -p tsconfig.json --noEmit"`（已手工验证当前是干净的）。

### MCP SDK 的 `StreamableHTTPClientTransport` 与 `exactOptionalPropertyTypes` 不兼容 `[wontfix]`

`Transport` 接口写的是 `sessionId?: string`，而该类实现成 `get sessionId(): string | undefined`
—— 可选属性 vs 显式 undefined，在 `exactOptionalPropertyTypes: true` 下不可赋值。
这是 SDK 自身类型的不一致。`mcp-client.ts` 在唯一构造点收了一次 `as unknown as Transport`
并写明原因；**不为它放宽整仓 tsconfig**。SDK 修了以后把那个 cast 删掉即可。

### `@modelcontextprotocol/sdk` 同时装在 root devDeps 与 `@eva/server` `[已处理]`

root 那份是给 `tests/helpers/fake-mcp-server.ts` 用的（它直接 import SDK 的 server 侧起假 server）。
沿用了 `ai` 的既有惯例：root devDeps 承载 `tests/` 需要的东西。

### MCP OAuth 授权流未做 `[r3]`

T9 只支持静态 token（`headers` 里塞 Bearer）。`docs 14 §4.7` 计划的 `mcp_oauth_tokens` 表、
回调服务、token 刷新与过期处理都没做，理由见 `r2/T9-mcp.md` §0。

### MCP 连接失败时 SDK 只给 "Connection closed" `[已处理]`

"进程起来了又立刻退出"（比如 server 脚本自己 import 失败）这种情况，SDK 抛的是
`MCP error -32000: Connection closed`，真实原因只在子进程的 stderr 里。
`mcp-client.ts` 改成 `stderr: "pipe"` + 保留尾部 2000 字符，连接失败时并进错误信息，
用户在 UI 上能直接看到 `Cannot find package ...` 这类可照着修的原文。
**教训**：包装外部进程时，"错误信息够不够用户自己修"要单独验一遍 —— 实测才发现的。

### BUNDLED skills 打包态静默失效 `[r4]`（T11）

`loader.ts` 的 `BUNDLED_SKILLS_DIR` 从 `import.meta.url` 推断,打包后指向
`Resources/server/dist/bundled` 但不存在。当前 `bundled/` 是空目录所以今天没坏,
第一个内置 skill 加进去那天会静默失效。修法二选一:随 `copy-migrations.mjs` 拷进 dist,
或走 extraResources。没在 T11 顺手修 —— 没有内置 skill 就没有验收对象。
