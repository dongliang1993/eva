# T38 · 上下文钳制学习（模型超限 → 永久钳小 contextWindow 写 DB）

> 前置：**依赖 T36**（真实 usage 信号）。读 `00-overview.md` §3 第 2 条（钳制持久化 + 幂等 + 下限契约）。
> Alma 证据：模型报 token 超限就把它的 contextWindow 永久钳小，日志原文 `[AutoCompact] ${model} rejected ${e} tokens — clamping...`（main:90647）。

## 1. 问题

某些 provider 在 capabilities 里登记的 contextWindow 是**虚高的**（宣称 128k，实际 100k 就报 `context_window_exceeded`）。Eva 现在的应对只有 reactive compact 重试一次——**下次 run 还用同一个虚高的 contextWindow**，于是同一个模型反复超限、反复靠 reactive 兜底，每次都白付一次失败往返。

Alma 的学习机制：模型一旦报超限，就把它的 contextWindow **永久钳小**（写 DB），下次 resolve 时直接用小值，从源头避免再次超限。日志 `[AutoCompact] ${model} rejected ${e} tokens — clamping...`。

## 2. 改动

### 2.1 钳制判定（harness 侧，只发信号不动 DB）

harness 够不到 DB（`ApprovalGateway` 在 server，同理钳制写库也在 server）。agent 在 reactive compact 触发时（`agent.ts:424-435`，`isReactiveCompactCandidateError` 命中）**额外发一个观测事件**，带上「哪个模型 + 当前 contextWindow + 估算实际用量」：

```ts
// agent.ts reactive compact 分支内新增
this.emit({
  type: "context_overflow_clamp",
  model: this.options.model,        // 或 modelId,看 observer 能拿到什么
  contextWindow: this.contextPolicy.contextWindow,
  // 用 T36 的真实 usage(若有)或当前估算,作为「实际能跑到多少」的参考
  observedTokens: lastStepInputTokens ?? estimateMessagesTokens(messages),
});
```

`NormalizedModelError`（`errors.ts`）已有 `context_window_exceeded` 识别，直接复用，不新增错误类型。

### 2.2 钳制写库（server 侧，挂 observer）

server 的 observer（`apps/server/src/observability.ts` 的 `createPinoObserver`）现在是纯打日志。加一个**钳制监听器**订阅 `context_overflow_clamp` 事件：

```ts
// 新文件 apps/server/src/services/providers/context-clamp.ts
export const clampContextWindow = (
  db: AppDatabase,
  args: { providerId: string; modelId: string; observedTokens: number }
): void => {
  // 1. 读 provider,找 models/availableModels 里 modelId 的 capabilities
  // 2. newContextWindow = max(MIN_CONTEXT_WINDOW, floor(observedTokens * 0.9))  // 留 10% 余量
  // 3. 只在 newContextWindow < 现值时钳(幂等:不越钳越大,也不越钳越小过下限)
  // 4. updateProvider 写回 models/availableModels JSON
  // 5. logger.warn("[AutoCompact] ${modelId} rejected — clamping contextWindow ${old} → ${new}")
};
```

**下限契约**（`00-overview.md` §3.2）：`MIN_CONTEXT_WINDOW = 8_000`。钳制只在「真实超限错误」时触发（reactive 路径），不在估算超限时钳——估算可能误报，真报错才是实锤。

### 2.3 resolve 读取（已有，不用改）

`model-resolver.ts:110` 已经从 capabilities 读 contextWindow → `agent-factory.ts:295` 传进 agent。钳制写回 capabilities 后，**下次 resolve 自动拿到钳小值**——链路已通，无需改。这正好满足「持久化」（写 DB，重启后仍钳小）。

### 2.4 agent 拿不到 modelId 的问题

`agent.ts` 的 `this.options.model` 是 `LanguageModel` 对象，不一定有 `modelId`/`providerId`。observer 事件里要带可定位 DB 行的标识。改法：`createConfiguredAgent`（`agent-factory.ts`）装配时把 `models.chat.providerId + modelId` 作为 `clampTarget` 传进 agent options，agent 在 `context_overflow_clamp` 事件里原样带上。

## 3. 涉及文件

修改：

- `packages/harness/src/agents/agent.ts` — reactive compact 分支 emit `context_overflow_clamp`；options 加 `clampTarget: { providerId, modelId }`。
- `packages/harness/src/agents/types.ts`（或 agent options 定义处）— 加 `clampTarget` 字段。
- `apps/server/src/services/agent-factory.ts` — 装配传 `clampTarget`。
- `apps/server/src/observability.ts`（或新增订阅点）— 订阅 `context_overflow_clamp` → 调 `clampContextWindow`。

新增：

- `apps/server/src/services/providers/context-clamp.ts` — `clampContextWindow`。
- `tests/context-clamp.test.ts` — 见 §4。

不动 `model-resolver.ts`（读取链路已通）、不动 reactive compact 主逻辑（只加 emit）。

## 4. 步骤（测试先行）

1. **RED-1（clampContextWindow 纯逻辑）**：`tests/context-clamp.test.ts`——
   - 现值 128k、observed 100k → 钳到 90k（100k × 0.9），DB 里 capabilities.contextWindow 更新；
   - 现值 90k、再次 observed 95k → **不钳**（95k×0.9=85.5k > 90k？不，85.5k<90k 会再钳——调边界：只在「钳后值 < 现值」才写，且不低于 8k）；
   - observed 5k → 钳到 8k（下限兜底），不低到 4.5k；
   - modelId 不在 provider.models → 不写、不崩。
2. **GREEN-1**：实现 `clampContextWindow`，全绿。
3. **RED-2（接线）**：mock agent 触发 `context_window_exceeded` 错误 → 断言 observer 收到 `context_overflow_clamp` 事件且带 `clampTarget`。红。
4. **GREEN-2**：接 emit + clampTarget 装配，全绿。
5. **持久化**：钳制后重新 `resolveModelSlot`（或重启进程后再 resolve），断言拿到的 contextWindow 是钳小值。
6. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | 模型报 `context_window_exceeded` | capabilities.contextWindow 被钳小（写 DB），日志 `[AutoCompact] ... clamping ...` |
| 2 | 钳制后重启/重 resolve | 拿到的 contextWindow 是钳小值（持久化生效） |
| 3 | observed 极小（如 5k） | 钳到 8k 下限，不再低 |
| 4 | 同一模型重复超限 | 单调递减但不破下限；已钳到比 observed×0.9 小后不再无意义钳 |
| 5 | **移除实验**：去掉 clampContextWindow 的「只在更小时才写」判断 | 用例 4 转红（会越钳越大或震荡）；恢复全绿 |

E2E：配一个 contextWindow 虚高的 provider（手动把 capabilities.contextWindow 改大成 128k），触发真实超限 → 再开新会话，observer 日志显示用了钳小后的 contextWindow，不再超限。

## 6. 坑

1. **只在真实超限时钳，不在估算超限时钳**：估算（chars/4）可能误报，把 contextWindow 误钳小就再也回不去了（除非手工改 DB）。钳制信号必须来自 `context_window_exceeded`/`prompt_too_long` 实锤错误（reactive 路径），不来自 proactive 的估算判定。
2. **钳制单调且有下限**：同一模型反复超限，contextWindow 不能钳到 0 或负。下限 8k；且只在「新值 < 现值」时写，避免边界震荡（observed 略大于现值×0.9 时不该钳）。
3. **harness 够不到 DB**：钳制写库必须在 server（observer/订阅）侧，agent 只发事件。别把 drizzle 依赖引进 harness。
4. **写回 models 和 availableModels 两处**：`model-resolver.ts:94-97` 查找顺序是 `models → availableModels → builtinModels`。钳制要覆盖用户实际配的那个列表（通常 `models`），保险起见两处同 modelId 都更新；builtinModels 是代码内置不存 DB，钳不到（也不该钳）。
5. **多 provider 同 modelId**：钳制要按 `providerId + modelId` 定位，别只按 modelId——不同 provider 的同名模型（如两个 OpenAI-compatible 都跑 `qwen3`）实际窗口可能不同。
