# FINDINGS

执行 T0–T4 期间**发现了但按纪律没有顺手改**的问题（`00-overview.md` §1.2）。

**写入规则**：只追加，不删改别人的条目。一条一段，写清「在哪、是什么、为什么现在不改」。
**处理时机**：T4 Step 5 统一分流，每条打上 `[done in T4]` / `[next]` / `[wontfix]` 之一。

---

## 待分流

### 审批接口前缀不一致

`apps/server/src/routes/approvals.ts` 挂在 `/api/tool-approvals`，其余所有接口都是 `/api/v1/...`。前端 `apps/web/src/api/approvals.ts` 跟着写了不带 `v1` 的路径。
不在 T0/T3 顺手改：改路径要前后端同步，混进功能 commit 会让 review 分心。
预期归类：`[done in T4]`（只有两个文件）。

### `/settings/*` 子页不是真路由

`apps/web/src/pages/settings/index.tsx` 用组件内 `activeNav` state 切换子页，不是 React Router 子路由。后果：直链 `/settings/providers` 打不开对应 tab，浏览器前进/后退在设置页内无效。
不在 T3 顺手改：牵动 settings 下三个大组件（`memory-settings` 699 行、`provider-settings` 529 行），值得单独一轮。
预期归类：`[next]`。

### `docs/architecture/10-frontend-conventions.md` 的目录树是 Alma 的物理布局

10 篇写的是 `src/{main,preload,renderer}` 的 Electron 单包形态，Eva 拆成了 `apps/web` + `apps/desktop` + `apps/server`。约定本身没问题，缺的是一张映射表。
预期归类：`[done in T4]`（T4 Step 4.3）。

---

## 已处理

（T4 Step 5 执行时把上面的条目带着结论移到这里）

### `chat-view.tsx` / `message-list.tsx` / `message-bubble.tsx` 仍 `import { MessageBubble }` 等未 memo

T1 只把 props 类型从 `DisplayMessage` 换成 `EvaUIMessage`、按 parts 渲染,没加 `memo`、没拆 streaming 状态。
T3 §1.1 才做渲染分层(committed / streaming + memo + 虚拟化)。
不在 T1 顺手改:会和 T3 的目录重构撞车。
预期归类:`[done in T3]`。

### `apps/web/src/api/client.ts` 的 `toolPartToInfo` 是临时适配器

T1 为了让 `tool-call-block.tsx` 不动,加了 `toolPartToInfo(part) → ToolCallInfo` 把 dynamic-tool part 派生回旧形状。
T3 §1.1 会把 `tool-call-block` 改成直接消费 `EvaDynamicToolPart`,届时 `toolPartToInfo` 删除。
预期归类:`[done in T3]`。
