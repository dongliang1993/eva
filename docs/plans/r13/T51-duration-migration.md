# T51 · `durationMs` 产品链路迁移

> 前置：T50（三段时间已可取）。读 `00-overview.md` §3 契约 6、7。
> 方案出处：设计文档 §6.1 —— **这是整个第一阶段唯一改动用户可见行为的卡**，所以独立成卡，能单独回滚。

## 1. 问题

`durationMs` 不是内部指标，它是渲染出来的东西，而且**已经落在历史消息的 JSON 里**。完整链路：

```text
stream-part-mapper.ts:91/:116  ──> SSE tool-result.durationMs (stream-events.ts:70)
  ──> ui-message-builder.ts:175-176  包成 toolMetadata.durationMs (ui-message.ts:17)
  ──> 写进 messages.message 的 UIMessage JSON（已落盘,不可改写）
  ──> 实时路径 run-stream-client.ts:91-92
  ──> 重放路径 replay-events.ts:54
  ──> 工具卡徽章 tool-call-block.tsx:101-104 与 :302-305
```

直接删字段有两个静默退化：

1. **徽章消失**。链路里六个文件没有一个会报错，`toolCall.durationMs !== undefined` 判成 false，耗时就不显示了 —— typecheck 和测试都不会拦。
2. **abort 补发失效**。`agent.ts:519-553` 的 T26 补发依赖 `clock` 枚举在飞集合；把 `clock` 当成「算 duration 用的」一起删掉，工具卡会永远停在 running、落库 part 悬挂 `input-available`（原注释写的就是这个）。

## 2. 改动

### 2.1 SSE 帧

`packages/shared/src/stream-events.ts:70` 的 `tool-result`：新增 `toolExecMs?`、`approvalWaitMs?`、`queueWaitMs?`。**旧 `durationMs?` 的类型保留但新事件不再赋值** —— 保留是为了让历史 UIMessage 仍能解析，不是为了双写。

mapper（`stream-part-mapper.ts:91`、`:116`）改成从 T50 的 timing state 取快照写进帧，不再调 `takeDuration`。

### 2.2 `clock` 只删字段不删 map

`stream-part-mapper.ts:40-44` 的 `takeDuration` 删掉；`:74` 的 `clock.set(...)` **保留**，`startedAt` **保留**。

`agent.ts:519-553` 的补发改成：

- 仍然遍历 `clock`、仍然 yield `tool-result` 帧（这帧是把卡片拉出 running 态的唯一手段，**形状不许改**）。
- ledger 事件从 `tool_call_completed(status=error)` 改成 `tool_call_abandoned`，`duration_ms = now - startedAt`，payload 带 `decomposed: false`。
- **不伪造** `tool_exec_ms` / `approvalWaitMs` / `queueWaitMs`。最小实现不让 `clock` 追踪 wrapper phase，所以这里只有一段未分解的墙钟时间；能测到多少就报多少。

### 2.3 UIMessage 与两条读路径

- `ui-message-builder.ts:175-176`、`:186-187`：把三个新字段写进 `toolMetadata`（`ui-message.ts:17` 同步加类型）。
- `run-stream-client.ts:91-92`（实时）与 `replay-events.ts:54`（重放）都读新字段。**旧 `durationMs` 不回灌成新字段** —— 它含等待，灌进 `toolExecMs` 就是把错数字洗成看起来对的。
- `ui-message-builder.ts:112` 的 `durationMs` 是**消息级**总时长（`derivedMetadata`），和工具无关，不动。

### 2.4 徽章

`tool-call-block.tsx:101-104` 与 `:302-305`：

- 只在 `toolMetadata.toolExecMs` 存在时显示新徽章。
- 等待非零时**分开呈现**，不相加成一个数（轨迹页 §9.2 就是这么拆的，聊天流里没有理由合并）。
- 只有旧 `durationMs` 的历史消息**隐藏徽章**，判据是「有没有新字段」，**不按消息时间戳猜版本** —— 时间戳猜版本在导入/迁移过的库上必然出错。
- `message-bubble.tsx:118` 的 `ThinkingBadge` 也叫 `durationMs`，但它来自 `message.metadata.thinkingDurationMs`（`:201`），表示 reasoning 时长，**不在本卡范围**。

## 3. 验收

- 一次「审批等 2 s、执行 50 ms」的调用：工具卡显示两个数（等待 2s / 执行 50ms），不显示 2.05s。
- 无审批的调用：工具卡只显示执行时长，视觉上和迁移前一致。
- 迁移前落库的老消息重新打开：徽章不显示，控制台无报错，其余内容照常渲染。
- 迁移后新消息刷新页面重载（走 `replay-events`）与实时流（走 `run-stream-client`）显示同一个数字。
- 工具执行中点 Stop：卡片立刻离开 running 态，落库 part 不是 `input-available`；ledger 里是 `tool_call_abandoned` + `duration_ms`，且没有 `tool_exec_ms`。
- `grep -rn "toolMetadata.durationMs" apps packages --include="*.ts" --include="*.tsx"` 只剩「隐藏旧徽章」那一处判断。
- `ThinkingBadge` 行为一字不变。
