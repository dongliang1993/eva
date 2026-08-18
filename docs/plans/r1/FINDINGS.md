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