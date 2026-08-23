# r9 · S19 AutoCompact 步中压缩 + 工具数安全网

> 切片编号 **S19**，来源 `docs/architecture/11-landing-plan.md` §3.5。
> 前置阅读：16 §3.1-4,5（取舍边界）/ 04 修订框（`prepareStep` 三路干预 + AutoCompact 实证）/ 15 §2 compact 现状。
> Alma 证据行号：`main:NNNNN` = Alma v0.0.990 bundle `/tmp/alma-extract/main.readable.js`；`eva:` = 本仓库文件。

## 1. 目标

给 Eva 已有的 proactive/reactive compact 补四层 Alma 有而 Eva 没有的（16 §3.1-4,5）：

1. **真实 usage 驱动**：现有 proactive compact 用 token 估算（chars/4，`runtime-compact.ts` `estimateMessagesTokens`）， Alma 用上一步真实 `usage.inputTokens` 判定溢出（`aA()`，main:43701-43715）。换真值是后面钳制的前提。
2. **压缩产出格式对齐**：Eva 现在产出 `Runtime summary:` system 消息；Alma 产出 `<context_summary>` user 消息 + 「不要从头再来」system-reminder，摘要指令六段结构（main:71821 `DO` 常量）。
3. **上下文钳制学习**：模型报 token 超限就把它的 contextWindow 永久钳小（写 provider capabilities / settings），日志原文 `[AutoCompact] ${S} rejected ${e} tokens — clamping...`（main:90647）。
4. **工具数 >40 安全网**：activeTools 未显式设置时退化为最小集 + 记 warning（PM-011，main:90600-90606），防 MCP 接入后工具爆炸。

## 2. 现状盘点（代码实证）

| 能力 | 现状 | 位置 |
|---|---|---|
| proactive compact | ✅ prepareStep 里跑，但**用估算 token**（chars/4），非真实 usage | `eva:packages/harness/src/agents/context-strategy.ts:39` |
| reactive compact | ✅ 溢出错误后压缩重试一次 | `eva:packages/harness/src/agents/agent.ts:424` |
| 真实 usage 读取 | ✅ `readTokenUsage` 在 `onStepEnd` 拿 `inputTokens` | `eva:packages/harness/src/agents/agent.ts:98,343` |
| 压缩产出格式 | ⚠️ `Runtime summary:` system 消息，非 `<context_summary>` user 消息 | `eva:packages/harness/src/context/runtime-compact.ts:13` |
| contextWindow 来源 | ✅ provider capabilities（DB）→ `model-resolver.ts` → `agent-factory.ts:295` | `eva:apps/server/src/services/providers/model-resolver.ts:110` |
| 上下文钳制学习 | ❌ 无（报超限不钳小 contextWindow） | 本轮 T38 |
| 工具数安全网 | ❌ 无 | 本轮 T39 |
| 步中压缩 | ✅ 已有（prepareStep 每步都跑）——S19 要做的不是「补步中」，是「步中用真值」 | 见 T36 |

**结论：S19 不是从零建步中压缩（已有 prepareStep 钩子），而是 ① 判定从估算换真值 ② 产出格式对齐 ③ 加钳制 ④ 加工具安全网。四处都是增量，不动 loop 主干。**

## 3. 执行契约

1. **估算 → 真值不能丢兜底**。真实 usage 在 `onStepEnd` 才拿到（下一步 prepareStep 用上一步的值），**第一步没有上一步 usage**——首步仍走估算。判定函数要接受「上一步 usage 可选」：有就用真值，没有就退回 chars/4 估算。
2. **钳制要持久化且幂等**。钳小 contextWindow 写 DB（provider capabilities），同一模型重复超限不能越钳越小到 0——钳制要有下限（如不小于 8k），且只在「真实超限错误」时触发，不在估算超限时钳。
3. **产出格式改动不动 loop 语义**。`<context_summary>` 从 system 改成 user 角色，会影响 `context-strategy.ts` 的「system 上提 instructions」逻辑（它现在把所有 system 都上提）——user 角色留在 messages 里，别误上提。
4. **工具安全网只在「未显式设 activeTools」时退化**。用户/上游显式传了 activeTools 就尊重，不钳。

## 4. 任务卡

| 卡 | 文件 | 一句话 | 估时 | 依赖 |
|---|---|---|---|---|
| **T36** | `T36-usage-driven-compact.md` | compact 判定从 chars/4 估算换上一步真实 `usage.inputTokens`（首步无 usage 退回估算兜底） | 0.5–1 天 | — |
| **T37** | `T37-compact-output-format.md` | 压缩产出对齐 Alma：`<context_summary>` user 消息 + 「不要从头再来」reminder + 六段摘要指令 | 0.5 天 | — |
| **T38** | `T38-context-clamp.md` | 上下文钳制学习：真实超限错误 → 永久钳小该模型 contextWindow（写 DB capabilities，带下限） | 0.5–1 天 | T36（要真值信号） |
| **T39** | `T39-tool-count-safety-net.md` | 工具数 >40 且未设 activeTools → 退化最小集 + warning | 0.5 天 | — |

**顺序**：T36 先（真值是 T38 前提）→ T37 / T39 可并行（无文件交集，T37 在 runtime-compact/context-strategy，T39 在 agent 装配）→ T38 殿后（依赖 T36）。串行最稳：T36 → T37 → T39 → T38。

## 5. 验收总表

| 卡 | 一句话验收 |
|---|---|
| T36 | 多步工具任务跑到中途，第二步起用真实 usage 判定溢出（日志见真值非估算）；首步仍走估算不崩 |
| T37 | compact 触发后 messages 里出现 `<context_summary>` user 消息 + reminder；摘要含六段结构 |
| T38 | 某模型报 token 超限后，其 contextWindow 被钳小并持久化（重启后仍钳小）；不低于下限 |
| T39 | 注册 >40 工具且未设 activeTools → 日志 warning + 实际生效最小集；显式设了 activeTools 则尊重 |

S19 切片全绿 = T36–T39 全绿 + 11 §3.5 S19 四条验收过。
