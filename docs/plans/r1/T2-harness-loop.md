# T2 · harness 收敛：手写 loop → `stopWhen` + `prepareStep`

> 前置：**T1 全部完成并 commit**。
> 读之前先读 `00-overview.md` §1 执行契约。

一个 commit：`refactor(harness): drive the tool loop with streamText instead of a hand-rolled loop`。
中间步骤可以本地多次提交，最后 squash 成一个。

---

## 1. 问题实证

`packages/harness/src/agents/lead-agent.ts` 893 行，控制流是**五层嵌套**：

```
runLoop:        for (step = 0; step < maxSteps; step++)
                  while (true)                       ← reactive compact 重试
runSingleStep:      while (rerun)                    ← 审批重跑（T0.4 已删）
                      for await (part of result.stream)
                        switch (part.type)           ← 15 个 case
```

**1.1 `stopWhen: stepCountIs(1)` 把 SDK 降级成了单步调用器**

`lead-agent.ts:401`。SDK 本来就会驱动 tool loop（有 tool call 就继续、没有就停），设成 1 之后每次调用只跑一步，外面的 `for step` 循环重新实现了一遍 SDK 已经有的东西。代价是：

- 手写消息回灌 `appendStepMessages`（`:657-686`）—— T0.4 实测过，这类手工缝消息序列缝错的后果是**整条链路报错**；
- 手写 `splitInstructionsAndMessages`（`:341-359`）—— `ai@7` 有 `allowSystemInMessages`，且 `prepareStep` 能返回 `instructions`；
- 手写 step 计数、手写 usage 累加、手写 finish 事件（同一段 `yield { type: "finish", ... }` 复制了 4 遍，`:764 / :780 / :821 / :845`，只有 text 和 finishReason 不同）。

**1.2 `runSingleStep` 用 out-param 从 generator 回传状态**

`:366` 的 `out: { collect: StepCollect | undefined; aborted?: boolean }`。这是"generator 不能同时 yield 和 return 值"的绕法，代价是调用方要写 `collect = collectHolder.collect!`（非空断言）。

**1.3 `RunMode` 把两个入口的差异摊进了 switch 的每个 case**

`mode === "stream"` 这个判断在 `runSingleStep` 里出现 **7 次**。而 `invoke()`（`:858`）其实就是"消费自己的 stream、挑出 finish 事件"——不需要一个贯穿全流程的模式开关。

**1.4 harness 真正的资产被埋在控制流里**

compact / tool-result budget / max-output 续写 / observer 这四样是**策略**，是 Eva 相对裸 SDK 的增量价值。现在它们和循环控制混在一起，读代码的人分不清哪些是"SDK 本来就会做的"、哪些是"我们额外加的"。docs 14 §4.2 的原话是「保留控制逻辑，只让 SDK 干 SDK 的活」——目前的代码是反过来的。

---

## 2. 目标设计

### 2.1 控制流

```
LeadAgent.stream(input):
  messages = [system, context?, ...input.messages]

  外层 restart 循环（最多 1 + maxOutputRecoveryLimit 次）:
    result = streamText({
      model, tools,
      messages,
      stopWhen: stepCountIs(remainingSteps),
      prepareStep: 每步套一遍 tool-result budget + proactive compact + system 上提,
      abortSignal,
      onStepEnd: 打 llm_call_end 观测点
    })

    for await (part of result.stream):
      映射成 AgentStreamEvent 并 yield        ← 纯函数 mapStreamPart

    读 await result.finishReason / usage / responseMessages

    ├─ finishReason === "length" 且还有续写额度
    │    → messages = [...responseMessages, {role:"user", content: 继续指令}]
    │      restart
    ├─ 抛错且是 context-overflow 类
    │    → messages = 反应式 compact(messages)，restart（全程最多一次）
    └─ 否则 → yield finish，结束
```

**层数从 5 降到 2**（外层 restart + 一层 `for await`）。`for step` / `while(true)` / `while(rerun)` / out-param 全部消失。

### 2.2 三条策略的新挂点

| 策略 | 现在 | 之后 |
|---|---|---|
| tool-result budget | `prepareMessagesForModel()` 手动在每步前调 | `prepareStep` 返回 `{ messages }` |
| proactive compact | 同上 | 同上 |
| system 消息上提 | `splitInstructionsAndMessages()` 每步手动拆 | `prepareStep` 返回 `{ instructions, messages }` |
| reactive compact 重试 | `while(true)` + `continue` | 外层 restart（catch → compact → restart） |
| max-output 续写 | `break` 跳出内层 + `continuedDueToMaxOutput` 标志 | 外层 restart |
| observer 打点 | 散在 6 处 | `onStepEnd` + 3 个明确位置 |

### 2.3 为什么 system 消息仍然上提，而不是开 `allowSystemInMessages`

`ai@7` 确实有 `allowSystemInMessages`，`@ai-sdk/anthropic` 也支持中途 system 消息（走 `mid-conversation-system-2026-04-07` beta header）。**但我们不依赖它**：compact 产生的 Runtime summary 作为 system 消息插在历史中间，一旦某个 OpenAI-compatible 供应商不接受中途 system，就是一个只在特定 provider 上出现的线上故障。上提到 `instructions` 是所有 provider 都成立的写法，成本只有 5 行。

这条决策写进代码注释，别让后来人以为是没发现 `allowSystemInMessages`。

### 2.4 行为必须保持不变的清单

T2 是**纯重构**。下面这些对外行为一个都不能变：

- `AgentStreamEvent` 的事件种类、字段、顺序语义（`shared/stream-events.ts` 不改一个字）；
- `finish` 事件的四种 `finishReason`：`stop` / `aborted` / `error` / `max-steps`；
- 空响应时的兜底文本 `"The model returned an empty response."`；
- 触顶时的兜底文本 `"The agent reached the maximum tool-calling steps without producing a final answer."`；
- abort 时 `stream()` 不 yield `error` 事件、只 yield `finish(aborted)`；
- `coalesceTextDeltas` 仍然包在最外层；
- 所有 `AgentTelemetryEvent` 的种类不变（字段值允许因为 step 语义变化而变，见 Step 4）。

---

## 3. 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/harness/src/agents/stream-part-mapper.ts` | 新增：SDK part → `AgentStreamEvent` 的纯映射 |
| `packages/harness/src/agents/context-strategy.ts` | 新增：`prepareStep` 工厂 + restart 判定 |
| `packages/harness/src/agents/lead-agent.ts` | 改：重写（目标 < 400 行） |
| `packages/harness/src/agents/types.ts` | 改：删 `RunMode` 相关残留（如有） |
| `packages/harness/src/subagents/executor.ts` | 检查：确认没有依赖被删的内部方法 |
| `packages/harness/src/index.ts` | 改：如需导出新模块 |
| `tests/lead-agent-loop.test.ts` | 新增 |
| `tests/lead-agent-abort.test.ts` | 保持通过（不许改断言） |

---

## 4. 步骤

### Step 1 · 抽出 `stream-part-mapper.ts`

把 `runSingleStep` 里那个 15 分支的 switch 变成一个**纯函数**：输入一个 SDK stream part，输出 0 或 1 个 `AgentStreamEvent` + 可选的副作用记录。

```ts
import type { TextStreamPart, ToolSet } from "ai";
import type { AgentStreamEvent } from "./types.js";

/** 工具调用的计时表：tool-call 时打点，tool-result 时取差。 */
export type ToolCallClock = Map<string, number>;

export interface MappedPart {
  /** 要转发给上层的事件；undefined 表示这个 part 不对外产出事件。 */
  readonly event?: AgentStreamEvent;
  /** 工具执行完成的记录（用于 finish 事件里的 toolCalls 汇总与观测）。 */
  readonly toolCall?: AgentToolCallResult;
  /** part 表示流被中断。 */
  readonly aborted?: boolean;
  /** part 表示流级错误，需要抛给外层处理 reactive compact。 */
  readonly error?: unknown;
}

/**
 * SDK stream part → Eva 事件。
 *
 * 为什么单独成文件：这是纯翻译，没有任何控制逻辑。和循环放在一起时，
 * 15 个 case 会让人误以为循环很复杂，其实复杂的只有翻译表。
 */
export const mapStreamPart = <TOOLS extends ToolSet>(
  part: TextStreamPart<TOOLS>,
  clock: ToolCallClock
): MappedPart => {
  switch (part.type) {
    case "text-delta":
      return { event: { type: "text-delta", textDelta: part.text } };

    case "reasoning-delta":
      return { event: { type: "reasoning-delta", textDelta: part.text } };

    case "tool-input-start":
      return {
        event: { type: "tool-input-start", toolCallId: part.id, toolName: part.toolName }
      };

    case "tool-input-delta":
      return {
        event: { type: "tool-input-delta", toolCallId: part.id, delta: part.delta }
      };

    case "tool-call":
      clock.set(part.toolCallId, Date.now());

      return {
        event: {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: (part.input as Record<string, unknown>) ?? {}
        }
      };

    case "tool-result": {
      const output = toOutputText(part.output);
      const durationMs = takeDuration(clock, part.toolCallId);
      const status = output.startsWith(TOOL_ERROR_PREFIX) ? "error" : "success";

      return {
        event: { type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output, status, durationMs },
        toolCall: { toolName: part.toolName, toolCallId: part.toolCallId, args: (part.input as Record<string, unknown>) ?? {}, output, status, durationMs }
      };
    }

    case "tool-error": { /* 同上，status 固定 error，output = toErrorMessage(part.error) */ }

    case "abort":
      return { aborted: true };

    case "error":
      return { error: part.error };

    default:
      // start / start-step / finish-step / finish / raw / source / file /
      // text-start / text-end / reasoning-start / reasoning-end /
      // tool-input-end / tool-output-denied / tool-approval-* 都不对外产出事件
      return {};
  }
};
```

**关键修正 —— `tool-result` 的 output 不是包装对象**：

现在的 `stringifyToolOutput`（`lead-agent.ts:106`）按 `output.type` 分支处理 `{type:'text',value}` 这种 `ToolResultPart["output"]` 形状。但流里的 `TextStreamToolResultPart` 是 `{type:'tool-result'} & TypedToolResult`，它的 `output` **就是工具 `execute` 的返回值本身**（Eva 的工具全部返回 `string`）。老代码 `part.output as ToolResultPart["output"]` 这个 cast 会让 `output.type` 是 `undefined`，落进 `default: JSON.stringify(output)` 分支——**字符串被二次 JSON 转义**，而且 `readToolStatus` 的 `startsWith("[Tool Error]")` 因为前面多了个引号而永远判不出错误。

新的实现：

```ts
/** buildTool 把执行异常包成这个前缀开头的文本返回，没有独立的 isError 标记。 */
const TOOL_ERROR_PREFIX = "[Tool Error]";

/** 工具返回值 → 纯文本。Eva 的工具都返回 string，非 string 是异常情况才 stringify。 */
const toOutputText = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output);
```

删掉 `stringifyToolOutput` 与 `readToolStatus`。

> 这条修正必须有测试兜住（Step 6 的第一条）——T0.4 已经证明这条链路一条测试都没有。

### Step 2 · 抽出 `context-strategy.ts`

```ts
import { stepCountIs, type ModelMessage, type PrepareStepFunction, type SystemModelMessage, type ToolSet } from "ai";

import { applyToolResultBudget } from "../context/tool-result-budget.js";
import {
  applyProactiveLoopCompactWithStats,
  applyReactiveLoopCompactWithStats,
  type RuntimeCompactResult
} from "../context/runtime-compact.js";
import type { ContextWindowPolicy } from "../context/policy.js";

export interface ContextStrategyOptions {
  readonly policy: ContextWindowPolicy;
  /** 运行时固定前缀（system prompt + context 消息）的条数，compact 不会动它们。 */
  readonly prefixMessageCount: number;
  /** compact 真的发生时回调，用来打 observer 事件。 */
  readonly onCompacted: (result: RuntimeCompactResult) => void;
}

/**
 * 每一步进模型前套的两道上下文防线（docs 14 §4.3）：
 *   1. tool-result budget —— 单条工具输出超预算就截断并落盘到 tool-overflow
 *   2. proactive compact —— 整体接近上下文窗口就把中段折叠成 Runtime summary
 *
 * 再把 system 消息上提到 instructions：compact 产出的 Runtime summary 是
 * system 角色，插在历史中间。有的 OpenAI-compatible 供应商不接受中途
 * system 消息，上提是所有 provider 都成立的写法。
 * （ai@7 的 allowSystemInMessages 能让它留在原位，我们刻意不依赖它。）
 */
export const createPrepareStep = <TOOLS extends ToolSet>(
  options: ContextStrategyOptions
): PrepareStepFunction<TOOLS> => ({ messages }) => {
  const budgeted = applyToolResultBudget(messages, options.policy);
  const compaction = applyProactiveLoopCompactWithStats(
    budgeted,
    options.prefixMessageCount,
    options.policy
  );

  if (compaction.changed) {
    options.onCompacted(compaction);
  }

  const instructions: SystemModelMessage[] = [];
  const rest: ModelMessage[] = [];

  for (const message of compaction.messages) {
    (message.role === "system" ? instructions : rest).push(message as SystemModelMessage);
  }

  return { instructions, messages: rest };
};
```

同文件里放 restart 的两个判定：

```ts
/** 触发 max-output 续写时追加的用户消息。 */
export const MAX_OUTPUT_CONTINUATION_MESSAGE =
  "Continue directly. Do not apologize. Do not repeat previous content.";

export const shouldContinueForMaxOutput = (
  finishReason: string,
  usedRecoveries: number,
  policy: ContextWindowPolicy
): boolean =>
  finishReason === "length" && usedRecoveries < policy.maxOutputRecoveryLimit;
```

`applyReactiveLoopCompactWithStats` 直接在 lead-agent 的 catch 里用，不再包一层。

### Step 3 · 重写 `lead-agent.ts`

目标结构（**不超过 400 行**）：

```ts
export class LeadAgent implements Agent {
  // 构造与字段：toolsByName / systemMessage / maxSteps / observer / contextPolicy
  // （requestApproval 已在 T0.4 删除）

  async *stream(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    yield* coalesceTextDeltas(this.run(input));
  }

  async invoke(input: AgentRunInput): Promise<AgentRunResult> {
    let result: AgentRunResult | undefined;

    for await (const event of this.run(input)) {
      if (event.type === "finish") {
        result = { text: event.text, toolCalls: event.toolCalls as AgentToolCallResult[] };
      }
    }

    if (!result) {
      throw new Error("Agent finished without a result.");
    }

    return result;
  }

  private async *run(input: AgentRunInput): AsyncGenerator<AgentStreamEvent> { /* 见下 */ }
}
```

`run()` 的骨架：

```ts
private async *run(input: AgentRunInput): AsyncGenerator<AgentStreamEvent> {
  const runStart = Date.now();
  const toolSet = toToolSet([...this.resolveTools(input).values()]);
  const maxSteps = input.maxSteps ?? this.maxSteps;
  const clock: ToolCallClock = new Map();
  const toolCalls: AgentToolCallResult[] = [];

  let messages = this.buildMessages(input);
  const prefixMessageCount = messages.length;
  let stepsUsed = 0;
  let recoveries = 0;
  let hasCompactedReactively = false;
  let continuedText = "";

  this.emit({ type: "agent_run_start" });

  // 外层 restart：只有 max-output 续写与 reactive compact 会走到第二圈。
  for (;;) {
    const prepareStep = createPrepareStep({
      policy: this.contextPolicy,
      prefixMessageCount,
      onCompacted: (result) => {
        this.emitContextCompaction(stepsUsed, "proactive_loop_compact", result);
        this.emitLoopTransition(stepsUsed, "proactive_loop_compact");
      }
    });

    const result = streamText({
      model: this.options.model,
      messages,
      tools: toolSet,
      stopWhen: stepCountIs(maxSteps - stepsUsed),
      prepareStep,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(this.options.callSettings?.temperature !== undefined
        ? { temperature: this.options.callSettings.temperature }
        : {}),
      ...(this.options.callSettings?.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.options.callSettings.maxOutputTokens }
        : {}),
      onStepStart: () => {
        this.emit({ type: "llm_call_start", step: stepsUsed });
      },
      onStepEnd: ({ usage, toolCalls: stepToolCalls, ...rest }) => {
        stepsUsed += 1;
        this.emit({
          type: "llm_call_end",
          step: stepsUsed - 1,
          durationMs: /* 见下 */,
          ...(readTokenUsage(usage) !== undefined ? { tokenUsage: readTokenUsage(usage)! } : {}),
          hasToolCalls: stepToolCalls.length > 0
        });
      },
      onError: () => {
        // 错误会以 'error' part 出现在 stream 里，这里只是不让它变成 unhandled rejection
      }
    });

    let text = "";
    let aborted = false;
    let streamError: unknown;

    try {
      for await (const part of result.stream) {
        // SDK 不保证对忽略 abortSignal 的 provider 流强制中断（尤其本地/mock 流），
        // 每个 part 消费前显式检查一次，确保 abort 确定性生效。
        if (input.abortSignal?.aborted) {
          aborted = true;
          break;
        }

        if (part.type === "start-step") {
          yield { type: "step-start", step: stepsUsed };
          continue;
        }

        if (part.type === "text-delta") {
          text += part.text;
        }

        const mapped = mapStreamPart(part, clock);

        if (mapped.error !== undefined) {
          streamError = mapped.error;
          break;
        }

        if (mapped.aborted === true) {
          aborted = true;
          break;
        }

        if (mapped.toolCall !== undefined) {
          toolCalls.push(mapped.toolCall);
          this.emit({ type: "tool_call_completed", /* ... */ });
        }

        if (mapped.event !== undefined) {
          yield mapped.event;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        aborted = true;
      } else {
        streamError = error;
      }
    }

    // ---- reactive compact：上下文溢出类错误，全程只重试一次 ----
    if (streamError !== undefined) {
      if (!hasCompactedReactively && isReactiveCompactCandidateError(streamError)) {
        const compaction = applyReactiveLoopCompactWithStats(messages, prefixMessageCount);

        if (compaction.changed) {
          messages = compaction.messages;
          hasCompactedReactively = true;
          this.emitContextCompaction(stepsUsed, "reactive_compact_retry", compaction);
          this.emitLoopTransition(stepsUsed, "reactive_compact_retry");
          continue;
        }
      }

      throw streamError;
    }

    if (aborted) {
      yield this.finishEvent({ /* finishReason: "aborted", text: continuedText + text, ... */ });
      return;
    }

    const finishReason = await result.finishReason;

    // ---- max-output 续写 ----
    if (shouldContinueForMaxOutput(finishReason, recoveries, this.contextPolicy)) {
      continuedText += text;
      messages = [...(await result.responseMessages), {
        role: "user",
        content: MAX_OUTPUT_CONTINUATION_MESSAGE
      }];
      recoveries += 1;
      this.emitLoopTransition(stepsUsed, "max_output_tokens_recovery", recoveries);
      continue;
    }

    // ---- 终态 ----
    yield this.finishEvent({ /* stop / max-steps / 空响应兜底 */ });
    return;
  }
}
```

`finishEvent()` 是一个私有方法，把现在复制了 4 遍的 finish 构造收成一处：

```ts
private finishEvent(args: {
  readonly text: string;
  readonly toolCalls: readonly AgentToolCallResult[];
  readonly finishReason: StreamFinishReason;
  readonly usage: TokenUsage;
  readonly runStart: number;
  readonly stepsUsed: number;
}): Extract<AgentStreamEvent, { type: "finish" }> {
  this.emit({
    type: "agent_run_end",
    totalDurationMs: Date.now() - args.runStart,
    stepCount: args.stepsUsed,
    totalTokenUsage: args.usage,
    toolCallCount: args.toolCalls.length
  });

  return {
    type: "finish",
    text: args.text,
    toolCalls: args.toolCalls.map(toStreamToolCallSummary),
    finishReason: args.finishReason,
    ...(args.usage.totalTokens > 0 ? { usage: toStreamTokenUsage(args.usage) } : {}),
    durationMs: Date.now() - args.runStart
  };
}
```

**终态文本的三种兜底**（保持与现在逐字一致）：

```ts
const finalText = (accumulated: string, finishReason: StreamFinishReason): string => {
  if (finishReason === "max-steps") {
    return "The agent reached the maximum tool-calling steps without producing a final answer.";
  }

  const trimmed = accumulated.trim();

  return trimmed.length > 0 ? trimmed : "The model returned an empty response.";
};
```

> 注意"空响应"的判定条件变了：老代码是「本步既无文本也无 tool call」，新代码是「整个 run 结束时累计文本为空」。有 tool call 但最后没说话的情况，老代码会走到 `max-steps` 或正常 finish，新代码给"空响应"文本。**这是可接受的行为变化**，且更准确（用户看到的确实是空回复）。在 commit 正文里写明。

**`stopWhen` 的 step 预算**：`stepCountIs(maxSteps - stepsUsed)`。`stopWhen` 的 `steps` 数组是**本次 `streamText` 调用内**的步数，所以 restart 后要减掉已用的。当 `maxSteps - stepsUsed <= 0` 时直接走 max-steps 终态，不再发起调用。

**删除清单**（删完 grep 应无结果）：

- `RunMode` / `StepCollect` / `RunLoopState`
- `runSingleStep` / `runLoop` / `appendStepMessages` / `prepareMessagesForModel` / `splitInstructionsAndMessages`
- `stringifyToolOutput` / `readToolStatus`
- `appendContinuationText` / `finalizeAssistantText`（被 `finalText` 取代）
- `emitRunEnd`（并进 `finishEvent`）

### Step 4 · telemetry 对齐

| 事件 | 新的产生点 | 语义变化 |
|---|---|---|
| `agent_run_start` | `run()` 开头 | 无 |
| `llm_call_start` | `onStepStart` | 无 |
| `llm_call_end` | `onStepEnd` | `durationMs` 改为从 `StepResult` 的 `performance` 取；取不到就用自己记的时间戳差 |
| `tool_call_initiated` | `mapStreamPart` 返回 `tool-call` 事件时由 `run()` 打 | 无 |
| `tool_call_completed` | 同上，`toolCall` 非空时 | 无 |
| `loop_transition` | reactive compact / max-output 续写两处 | **`next_turn` 不再产生**——step 推进现在是 SDK 内部行为 |
| `context_compacted` | `prepareStep` 的 `onCompacted` + reactive catch | 无 |
| `agent_run_end` | `finishEvent()` | `stepCount` 语义从"循环计数"变成"SDK 实际执行的步数" |

`next_turn` 这个 `LoopTransitionReason` 成员**保留在类型里但不再产生**（T4 决定要不要删）。在 `observer.ts` 的类型定义上加一行注释说明。

`apps/server/src/observability.ts:37` 消费 `tokenUsage`，字段没变，不用改。

### Step 5 · 检查 subagent 与 create-agent

```bash
grep -rn "runLoop\|runSingleStep\|appendStepMessages\|RunMode\|StepCollect" packages apps tests --include="*.ts" | grep -v node_modules
```

`packages/harness/src/subagents/executor.ts` 走的是 `Agent.invoke()` 公共接口，理论上不受影响——**跑一遍确认**，不受影响就什么都不改。

`create-agent.ts` 只是构造 `LeadAgent`，`LeadAgentOptions` 的字段没有增删（T0.1 加的 `callSettings`、T0.4 删的 `requestApproval` 都已经落定），也不用改。

### Step 6 ·【测试先行】`tests/lead-agent-loop.test.ts`

`tests/lead-agent-abort.test.ts` 的两条现有用例**必须原封不动继续通过**——它们是这次重构的安全网。新增：

```ts
describe("工具循环", () => {
  it("【回归】工具输出原样透出，没有 JSON 二次转义", async () => {
    // 工具 execute 返回 "line1\nline2"
    // 断言 tool-result 事件的 output === "line1\nline2"
    // （重构前会是 "\"line1\\nline2\""）
  });

  it("工具抛异常 → status 'error'，output 以 [Tool Error] 开头", async () => {
    // 重构前因为二次转义，startsWith 判定失败、status 错报 success
  });

  it("两个 step：调工具 → 拿结果 → 输出文本，只发起一次 streamText", async () => {
    // 用 doStream 的调用计数断言：SDK 驱动 loop，不是我们一步步喂
    // 断言 step-start 事件出现 2 次，step 分别是 0 和 1
  });

  it("达到 maxSteps → finish(max-steps) + 固定兜底文本", async () => {
    // maxSteps: 2，mock 每步都产 tool-call
  });

  it("模型只产 tool-call 从不说话 → finish 文本是空响应兜底", async () => {});
});

describe("max-output 续写", () => {
  it("finishReason 'length' → 追加继续指令并重新发起，文本被拼接", async () => {
    // 断言 doStream 被调用 2 次
    // 断言第二次的 messages 末尾是 MAX_OUTPUT_CONTINUATION_MESSAGE
    // 断言 finish.text 是两段拼起来的
  });

  it("超过 maxOutputRecoveryLimit 后不再续写", async () => {});
});

describe("reactive compact", () => {
  it("上下文溢出错误 → compact 后重试一次", async () => {
    // 第一次 doStream 抛 context-overflow 类错误，第二次正常
    // 断言最终 finish(stop)，且 context_compacted 观测事件里 reason 是 reactive_compact_retry
  });

  it("重试后仍失败 → 抛出（stream 里变成 error 事件）", async () => {});
});

describe("上下文策略挂在 prepareStep 上", () => {
  it("system 消息被上提到 instructions，不出现在 messages 里", async () => {
    // 用 MockLanguageModelV4 的 doStream 参数捕获 prompt，
    // 断言 prompt 里 role === "system" 的消息只在最前面（provider 层已合并）
    // 或者直接对 createPrepareStep 做单元测试（更稳，推荐）
  });
});
```

> `createPrepareStep` 是纯函数，优先对它做单元测试；通过 mock 模型间接断言的部分越少越好。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿，且 `tests/lead-agent-abort.test.ts` 的两条断言**一个字没改**
- [ ] `wc -l packages/harness/src/agents/lead-agent.ts` < 400
- [ ] 下面这些符号全部消失：
  ```bash
  grep -n "RunMode\|StepCollect\|RunLoopState\|runSingleStep\|appendStepMessages\|splitInstructionsAndMessages\|prepareMessagesForModel\|stringifyToolOutput\|readToolStatus" \
    packages/harness/src/agents/lead-agent.ts
  ```
- [ ] `grep -n "stepCountIs(1)" packages/harness/src` 无结果
- [ ] 手工：一轮包含 2 次以上工具调用的真实对话，前端看到的事件顺序、工具块、耗时与 T1 结束时一致
- [ ] 手工：工具输出里带换行和引号的内容（比如读一个 JSON 文件）在 UI 里显示正常，**没有多余的转义符**
- [ ] 手工：流式中途点 Stop → 仍然只有 `finish(aborted)`，没有 `error` 事件
