# T53 · 会话内轨迹页：切换、投影与台账

> 前置：T52（接口定稿）。读 `00-overview.md` §3 契约 1、9。
> 方案出处：设计文档 §9.1、§9.2。DSH 证据：`.refrences/deepseek-harness/packages/client/ui-trajectory/**`。

## 1. 问题

轨迹是会话的第二个视图，不是另一个页面。DSH 的做法是每个 session 内「对话 / 轨迹」两个 tab —— 同一份事实，两种读法。做成独立页面会丢掉「我正在看的这次对话到底发生了什么」这个上下文。

## 2. 改动

### 2.1 视图切换

`apps/web/src/features/threads/chat-page.tsx` 加「对话 / 轨迹」切换；新增 `apps/web/src/features/threads/trajectory/` 子模块。切换不卸载聊天流（回来时不该重新拉消息）。

### 2.2 `deriveTrajectory` —— 纯投影

新增 `trajectory/derive-trajectory.ts`：吃 `run_events` 数组，输出展示行：

```text
system | user | context | assistant | tool | subtool | compacted | approval | error
```

规则：

- `request_snapshot` → System 与 Request 边界行。
- `model_call_started` + `assistant_message` + `model_call_completed` → 一行 Assistant。
- `tool_call_started` + `tool_call_completed`/`tool_call_abandoned` → 一行 Tool。
- `approval_asked` + `approval_decided` → Tool 行内的等待阶段，不单独占行。
- `parent_run_id` 非空的后台子 Run → 通过 `background_task_id → parent_tool_call_id` 嵌到发起它的 Tool 行下（`subtool`），不与父 Run 事件同层混排。锚点还没翻到的子 Run **先不显示**，不报错、不占位。
- 前台子代理已经在父 ledger 内，用 `agent = taskId` 区分。

**纯函数、无副作用、展示行不落库**。这条是硬要求：投影可丢弃、可重算，是 ledger 唯一事实源的前提（契约 1）。以后支持多层后台子代理时沿 `parent_run_id` 递归构树，本卡只做一层。

### 2.3 虚拟化台账

用已在仓里的 `@tanstack/react-virtual`（`components/message-list.tsx:2,31` 是现成范例，照它的 measure 方式做，不引新库）。

- 行高不定（Tool 行展开后差异很大）→ 用动态 measure，不写死 estimateSize。
- **prepend 旧页不能跳**：取旧页后要保持当前可见行与选中态。这是虚拟化 + 反向分页最容易翻车的点，`message-list.tsx` 已经处理过一次同类问题，抄它的做法。
- Turn / Tool Call 可折叠，折叠态不销毁已加载数据。

### 2.4 分页接线

会话接口的三元组游标（T52 §2.2）在前端存成一个不透明 cursor 对象，**不要在组件里手搓 `occurredAtMs - 1` 之类的算术** —— 三元组的语义是「严格小于这一整个元组」，拆开减一必错。

## 3. 验收

- 切到轨迹页再切回对话：聊天流不重新拉取，滚动位置保持。
- 500 条展示记录时 DOM 行数有界（用 devtools 数一次），滚动不掉帧。
- prepend 一页旧数据后，当前可见的那一行仍在同一视觉位置，选中态不变。
- 一次含并行工具调用 + 一个前台子代理 + 一个后台子代理的 Run：Tool 行并列、前台子代理事件带 taskId 标识、后台子 Run 嵌在发起它的 Tool 行下。
- 只翻了第一页（锚点未加载）时，后台子 Run 不显示、无控制台报错；继续上滚到锚点出现后它挂上去。
- `deriveTrajectory` 有单测：同一份事件数组两次调用输出深相等；乱序输入按 seq 排序后结果一致。
- 事件里出现未知 kind（未来版本）时投影不崩，降级成一行 raw。

## 4. 实施备注

- 三件套都刻意做成纯函数：`derive-trajectory.ts`（投影）、`display-list.ts`(Turn/Assistant 折叠计算）、`use-trajectory.ts`（游标累积）。展示行不落库，删掉随时从 ledger 重算（契约 1)。
- prepend 稳定用「totalSize 差值补 scrollTop」:loadOlder 前记一次 totalSize，新页渲染后 `scrollTop += delta`;row key 稳定（`getItemKey` 给虚拟化）保证选中态不跳。首屏从尾部打开。
- 切换实现：`chat-view.tsx` 内部 tab —— 聊天内容只 `hidden` 不卸载（MessageList/builder/滚动位置原样），轨迹页首开后保持挂载。
- **顺手补了 T49 的一个缺口**:`tool_call_started/completed` 的 observer 事件此前只有 `toolName`,ledger 里没有工具入参/输出，T54 检查器的 Payload/Result 面板会无米下锅。已补：`tool_call_started` 带 `input`、`tool_call_completed` 带 `output`（脱敏限长走 recorder 既有管道）。
- 与卡面的两处小偏差：① `run_started` 投影成 `user` 行（Run 边界；用户原文在 messages 表，不在 ledger,inspector 显示 Run 元信息）;② `request_snapshot_ref` 不占行，ref 解析留给 T54 检查器。
- **Turn 呈现纠偏（用户评审）**:turn 与 run 1:1 是常态后，分隔线按 **Run 分组**渲染（不再画「全是 Turn 0」的 turn 分隔）—— 每个 Run 分组第一行左边距带「Turn N」角标（DSH 风格,N = 会话内 Run 序号）,Run 之间插分割线，双击分割线折叠整 Run(`buildDisplayList` 仍是纯函数，折叠不销毁数据）。将来 Run 内真出现多 turn（常驻 inbox / steering）时再把 turn 级分隔加回来。
