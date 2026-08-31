# T22 · maxSteps 25 → 100

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.7。
> 施工图：`docs/architecture/04-model-adapter-agent-harness.md` §8.4.2（"100 步 / steering 挂起 / AttemptCompletion 被调 三种停法"）。

**建议 1 个 commit**：`feat(server)`。常量与文案，半天。

---

## 1. 问题实证

`apps/server/src/services/agent-factory.ts:243`：

```ts
maxSteps: 25,
```

撞顶不是报错，是 `lead-agent.ts:110` 的终态文案：

```
The agent reached the maximum tool-calling steps without producing a final answer.
```

用户体验 = "活干一半，agent 自己宣布不干了"，而且**没有提示可以怎么继续**（追问一句"继续"其实是能续上的 —— 主链消息都在，新一轮 run 会接着干，但用户不知道）。

Alma 给 100 步（`docs 04 §8.4.2`），且有 134 步真实会话可行的实证（`docs 04 §2`：compact + tool-overflow 两道防线叠加，长会话才成立）。Eva 这两道防线**都已经有了**（R1 的 compact 三件套 + tool-overflow，本轮 T20 还把后者补强了）—— 步数闸不该比上下文闸先响。25 对"读一个模块再改三个文件"这种日常任务就已经不够：一次 grep + 四五次 read + 每文件一次 edit + 验证 bash，二十步转眼就没。

---

## 2. 目标设计

### 2.1 常量调整

| 位置 | 现状 | 改为 | 理由 |
|---|---|---|---|
| `agent-factory.ts:243` 主 agent | 25 | **100** | 对齐 Alma；上下文防线在，步数不该先响 |
| `crew.ts:26` `SUBAGENT_MAX_STEPS` | 20 | **50** | 子代理是"只给结论"的窄任务，100 会让跑偏的子代理烧太久（T15 阀 2 管住了上下文，但没管步数上的失控）；50 是"够干完一个窄任务"与"成本熔断"之间的中点 |

> **为什么子代理不同步到 100**：T15 的四道成本阀管的是上下文与工具集，步数是第五道闸。子代理跑偏时没人看着（后台静默），100 步 × tool 槽位模型也是真金白银。50 步跑不完的子任务，正确动作是主 agent 拆开再派，不是让子代理硬撑。

### 2.2 收尾文案：告诉用户怎么续

`lead-agent.ts:110` 的 `finalText`（max-steps 分支）：

```
The agent reached the maximum tool-calling steps (100) without producing a final answer.
The work so far is preserved in this conversation — ask me to continue and I'll pick up where I left off.
```

要点：**带上实际步数**（100 撞顶与 5 步撞顶的诊断含义完全不同）+ **给出继续路径**（"ask me to continue"）。`maxSteps` 从 `this.maxSteps` 插值，别硬编码。

### 2.3 观测：max-steps 终态进 observer

`LeadAgent` 的 finish 路径（`lead-agent.ts:222`）对 max-steps 终态 emit 一个 `loop_transition`（reason 已有 `LoopTransitionReason` 联合，加 `"max_steps"` 或复用现有终态事件 —— 实现时看 observer.ts 的联合，选最小改动）。撞顶从"用户看文案才知道"变成"日志/事件里可查"。

### 2.4 文档

`AGENTS.md`（或对应架构文档）若有步数提及，同步改 100/50。grep 实证：`grep -rn "25\b.*maxSteps\|maxSteps.*25" docs apps/server/src packages/harness/src --include="*.md" --include="*.ts"`，只改真实提及的，不顺手改别的数字。

---

## 3. 涉及文件

### 修改
| 文件 | 动作 |
|---|---|
| `apps/server/src/services/agent-factory.ts` | `maxSteps: 25 → 100`（常量提取为 `MAIN_AGENT_MAX_STEPS` 并注释取值理由） |
| `packages/harness/src/subagents/crew.ts` | `SUBAGENT_MAX_STEPS = 20 → 50`（注释更新理由） |
| `packages/harness/src/agents/lead-agent.ts` | `finalText` max-steps 分支带步数 + 继续路径；max-steps 终态 emit observer 事件 |
| `tests/lead-agent-loop.test.ts`（或就近测试文件） | max-steps 文案断言更新 + observer 事件断言 |

### 新增
无。

---

## 4. 步骤

### Step 1 · 【测试先行】文案与事件

就近测试文件（`tests/lead-agent-loop.test.ts` 或新建小文件）：

- 用 `MockLanguageModelV4` 让 agent 每轮都调工具（永不 stop）→ 跑到 `maxSteps`（测试里传小值如 3）→ 终态文本含步数数字与 "continue"；
- observer 收到 max-steps 对应事件。

RED → 实现 → GREEN。

### Step 2 · 常量调整

`agent-factory.ts` 提取 `MAIN_AGENT_MAX_STEPS = 100`（注释：对齐 `docs 04 §8.4.2`；上下文防线 R1/T20 已在，步数闸不该先响）。`crew.ts` 改 50（注释更新）。

### Step 3 · 全绿 + 手工

`pnpm typecheck && pnpm test`。手工验证见 §5。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；文案/事件断言 RED→GREEN
- [ ] 手工：派一个真实的长任务（如"把这个目录下所有文件的 import 路径从相对改别名"）→ agent 跑过 25 步不被砍，最终产出答案
- [ ] 手工：临时把 `MAIN_AGENT_MAX_STEPS` 调 3 复现撞顶 → 回复文案含 "3" 与继续提示；追问"继续"→ 新一轮 run 接着干活（主链未断的既有行为）
- [ ] `grep -rn "maxSteps: 25\|SUBAGENT_MAX_STEPS = 20" apps packages` → 零命中

## 6. 坑

1. **步数文案硬编码 100**。`finalText` 拿 `this.maxSteps` 插值 —— 测试传 3 时文案就该说 3，硬编码会让测试断言变成谎言。
2. **把子代理也提到 100**（§2.1 的理由）：子代理是无人值守的成本中心，步数闸是它的熔断器，不是束缚。
3. **顺手加"自动续跑"**（撞顶后自动开新一轮）。那会让失控 loop 变成失控计费 —— 撞顶必须停在用户面前，续不续是人的决定。Alma 的 134 步会话也是人在场 steer 的，不是自动续出来的。
4. **忘了 observer**。25 撞顶是偶发，100 撞顶是异常 —— 异常就该在事件流里留痕，否则将来排查"agent 为什么停了"只能问用户要截图。
