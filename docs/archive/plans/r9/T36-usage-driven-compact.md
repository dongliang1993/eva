# T36 · compact 判定换真实 usage（估算 chars/4 → 上一步 inputTokens）

> 前置：无文件依赖，但**这是 T38（上下文钳制）的前提**——钳制只在「真实超限」时触发，真实超限信号来自真实 usage。开工前读 `00-overview.md` §2、§3 第 1 条（估算→真值的兜底契约）。
> Alma 证据：溢出判定 `aA()`（main:43701-43715）=「有效输入 + output > contextWindow − min(maxOutput, 32000)」；步中在 prepareStep 用上一步 `usage` 判定（main:90740，日志 `[AutoCompact:prepareStep]`）。

## 1. 问题

Eva 的 proactive compact 判定 token 数靠**估算**：`runtime-compact.ts` 的 `estimateMessagesTokens` 用 `chars / 4`（`eva:packages/harness/src/context/runtime-compact.ts:106-123`）。问题：

- **不准**：chars/4 对中文/代码/JSON 偏差极大（中文 ~1.5 字/token、代码 token 密度高），估算 100k 可能实际 60k 或 140k。compact 要么误触发（浪费一次压缩 + 丢上下文），要么漏触发（真溢出了没压，等 reactive 兜 → 多一次失败往返）。
- **拿不到真实值不代表没有**：`readTokenUsage`（`agent.ts:98`）已经在 `onStepEnd` 拿到上一步真实 `usage.inputTokens`（`agent.ts:343`），只是没喂给 compact 判定。

Alma 的做法：prepareStep 里用**上一步的真实 usage** 判定本步是否溢出（不是估算整段 messages）。Eva 照抄这个信号来源，但保留估算作为**首步兜底**（第一步没有上一步 usage）。

## 2. 改动

### 2.1 溢出判定函数（真值优先，估算兜底）

`runtime-compact.ts` 新增（或改 `applyProactiveLoopCompactWithStats` 签名）：

```ts
/**
 * 判定是否溢出。lastStepInputTokens 有值用真值,没有退回 chars/4 估算(首步)。
 * 阈值对齐 Alma aA():lastInput + reservedOutput > contextWindow - min(maxOutput, 32000)。
 * Eva 简化:policy.contextWindow - policy.reservedOutputTokens - policy.loopCompactBufferTokens。
 */
export const isOverflowing = (
  messages: readonly ModelMessage[],
  policy: ContextWindowPolicy,
  lastStepInputTokens?: number
): boolean
```

- `lastStepInputTokens !== undefined` → 用 `lastStepInputTokens >= contextWindow - reservedOutputTokens - loopCompactBufferTokens` 判定。
- `undefined`（首步）→ 退回现有 `estimateMessagesTokens(messages)` 估算。

### 2.2 信号从 agent 传到 prepareStep

`agent.ts` 已把每步 usage 存进 `totalTokens`，但 prepareStep 闭包拿不到「上一步单步值」。改法：

- `agent.ts` 在 `onStepEnd`（`:340`）里把 `stepUsage.promptTokens` 存进一个 `let lastStepInputTokens: number | undefined`（run 作用域）。
- `createPrepareStep`（`context-strategy.ts:39`）options 加一个 `getLastStepInputTokens: () => number | undefined`（函数取值而非快照，因为 prepareStep 每步调一次，要拿最新上一步值）。
- prepareStep 内：把 `getLastStepInputTokens()` 传给 `applyProactiveLoopCompactWithStats` / `isOverflowing`。

**为什么用 getter 不用值**：prepareStep 的 options 在 `streamText` 调用前构造一次，但 prepareStep 每步都跑。传值会定格在构造时（undefined），传 getter 每次取到最新上一步 usage。

### 2.3 不动估算函数本身

`estimateMessagesTokens` 保留——首步兜底 + `RuntimeCompactResult.estimatedTokensBefore/After` 仍用它做观测。本任务只换「判定阈值用哪个数」，不删估算。

## 3. 涉及文件

修改：

- `packages/harness/src/context/runtime-compact.ts` — 新增 `isOverflowing`（或改 `applyProactiveLoopCompactWithStats` 接 `lastStepInputTokens?`）。
- `packages/harness/src/agents/context-strategy.ts` — `ContextStrategyOptions` 加 `getLastStepInputTokens`，prepareStep 传给判定。
- `packages/harness/src/agents/agent.ts` — `onStepEnd` 存 `lastStepInputTokens`；`createPrepareStep` 传 getter。

新增：

- `tests/usage-driven-compact.test.ts` — 见 §4。

不动 DB、不动 reactive compact（那是错误后路径，与 usage 判定无关）。

## 4. 步骤（测试先行）

1. **RED-1（isOverflowing 真值优先）**：`tests/usage-driven-compact.test.ts` 写 `isOverflowing` 用例——
   - 给 `lastStepInputTokens = 120_000`、policy contextWindow 128k / reserved 8k / buffer 12k（阈值 = 108k）→ 溢出 true；
   - `lastStepInputTokens = 50_000` → false；
   - 不传 `lastStepInputTokens`、messages 估算 120k → true（走估算兜底）；
   - 不传、估算 50k → false。
2. **GREEN-1**：实现 `isOverflowing`，全绿。
3. **RED-2（接线）**：mock 一个两步 agent run——第一步喂 usage `inputTokens: 120_000`，断言第二步 prepareStep 触发了 proactive compact（`onCompacted` 被调）。未接线时红（因为估算可能判不溢出）。
4. **GREEN-2**：接 `lastStepInputTokens` + getter，全绿。
5. **兜底回归**：第一步（无 lastStepInputTokens）构造估算溢出的 messages，断言仍触发 compact（证明首步估算兜底没丢）。
6. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | 上一步 usage 120k（>108k 阈值） | 本步 prepareStep 触发 proactive compact |
| 2 | 上一步 usage 50k | 不触发 |
| 3 | 首步（无 usage）+ 估算 120k | 触发（估算兜底在） |
| 4 | 首步 + 估算 50k | 不触发 |
| 5 | **移除实验**：isOverflowing 里去掉真值分支恒走估算 | 用例 1 转红（真值 120k 但估算不准时不再触发）；恢复全绿 |

E2E：起一个多步工具任务（如「读 10 个文件并逐个总结」），observer 日志里第二步起的 compact 触发应基于真实 inputTokens（对比 `llm_call_end` 的 tokenUsage 与 compact 触发时点一致）。

## 6. 坑

1. **getter 不是值**：prepareStep options 构造一次、每步跑，传快照值会定格 undefined。必须传 `() => lastStepInputTokens`。
2. **首步没有上一步 usage**：不能假设 lastStepInputTokens 总有值，估算兜底分支必须留（契约 §3.1）。
3. **阈值口径别照搬 Alma 的 32000**：Alma 用 `min(maxOutput, 32000)`，Eva 的 `policy.reservedOutputTokens`（默认 8k）+ `loopCompactBufferTokens`（12k）已是等价的「预留输出 + 缓冲」，直接用 policy 字段，别再加一个 32k 魔法数。
4. **别把 reactive compact 也改成等 usage**：reactive 是「错误已发生」的事后路径，错误本身就是溢出信号，不需要 usage 判定。本任务只动 proactive（prepareStep）。
