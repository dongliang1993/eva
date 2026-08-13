# 08 · 并行与多 Agent 编排

> 范围：Alma 的两层并行机制——「一轮内并行执行多个 tool」与「fork-join 并行子代理」——以及沉淀为 skill 的高层编排模式（council / harness / rfc-pipeline）。
> 证据基础：对 Alma 主进程 bundle（asar 解包后 grep `parallelToolCalls` / `run_in_background` / `TaskOutput` / `harnessMode` / `subagent-messages` 等符号）的实证，外加 AI SDK v5 通行行为推断。
> 标注规则：【实证】= bundle 符号/路由/schema 直接命中；【推测】= 基于实证 + AI SDK 通行做法的合理还原。
> 与 04 篇的关系：04 篇讲清了 agent loop、工具系统、子代理入口的**静态结构**；本篇只讲**并行与编排**这个切面，不重复基础设施。

---

## 1. 开篇破题：Alma 的并行在两层

很多人一谈「多 agent 系统」就想到复杂的调度框架。Alma 的做法相反：**并行不是一个框架，而是同一条执行管线上的两个开关**。

```
                     ┌───────────────────────────────────────┐
                     │       一条 streamText agent loop       │
                     │ (主 agent 和子代理跑的是同一份循环代码)  │
                     └───────────────────────────────────────┘
                                      │
          ┌───────────────────────────┴───────────────────────────┐
          ▼ 第 1 层：并行 tool                                      ▼ 第 2 层：并行子 agent
  ┌───────────────────────────┐                       ┌───────────────────────────┐
  │ 一轮 assistant 消息里带     │                       │ Task 工具 = fork           │
  │ N 个 tool-call part        │                       │  └ run_in_background=true  │
  │ → 并发 execute             │                       │     立即返回 taskId        │
  │ → 按 toolCallId 配对回灌    │                       │ TaskOutput 工具 = join     │
  │                           │                       │  └ block=true 等结果       │
  │ 粒度：单个工具调用          │                       │ 粒度：一整个 agent loop    │
  └───────────────────────────┘                       └───────────────────────────┘
```

关键认知：

- **两层共用同一条管线**。子代理不是另一种运行时，而是「再开一次 streamText loop」，loop 里照样能并行 tool、照样能再 spawn 子代理（受深度限制）。复刻时**不要**为子代理写第二套执行引擎。
- **并发的脏活全部外包给 AI SDK**。bundle 里 grep 不到 p-limit / semaphore / Bottleneck 任何自造并发原语【实证】。Alma 没在并发控制上写一行自己的锁——SDK 负责 fan-out，Promise 负责 join。
- **编排模式不是代码，是 skill**。council、对抗式 harness、RFC pipeline 这些「多 agent 套路」没有硬编码进主循环，而是写成按需加载的 SKILL.md（详见第 5 节）。

---

## 2. 并行 tool 机制

### 2.1 parallelToolCalls：一个透传给 SDK 的布尔值

【实证】bundle 中命中：

```
parallelToolCalls:Xt.boolean().nullish()   // 设置项的 zod schema，可显式配置
parallelToolCalls:o?.parallelToolCalls     // provider 创建时透传（OpenAI/OpenRouter/DeepSeek）
parallelToolCalls:!Lt && void 0            // 一个闸门：某条件成立时强制 undefined
```

语义解读：

- `parallelToolCalls` 是 OpenAI 系 API 的原生参数：`true` 时模型被允许在**一条 assistant 消息里输出多个 tool_call**；`false`/`undefined` 时一轮最多一个。
- Alma 把它做成**用户级设置**（schema 里 `nullish` = 可留空跟随默认），创建 provider 时原样透传，自己不加额外逻辑。
- 第三行的 `!Lt && void 0` 是个**闸门**：`Lt` 为真时强制传 `undefined`（即关掉并行）。`Lt` 的精确语义不可考，但结合 bundle 里 `isSubagent` / `isSubagentContext` / `harnessMode` 等符号高频共现【实证】，**【推测-高置信】`Lt` = 「当前处于子代理/受控 harness 上下文」**——即：**子代理里默认关掉并行 tool，主 agent 才开**。

为什么子代理要关？【推测】两个理由：

1. **确定性优先**。子代理是给别人打工的，产出要可预期；并行 tool 让一轮内的执行顺序不可控，调试子代理行为时痛苦翻倍。
2. **写冲突收敛**。并行 tool 最大的事故源是两个写操作同时落（见 2.3）。子代理常被 fork 出去干同构的活（同时改文件、同时写库），关掉并行 tool 等于在最容易撞车的层面物理隔离了撞车可能。

### 2.2 多 tool-call 的并发执行与结果配对

【推测-高置信】（AI SDK v5 标准行为，bundle 消息 parts 结构佐证）：

```
assistant message
  parts: [
    { type:"tool-call", toolCallId:"call_a", toolName:"Read", args:{...} },
    { type:"tool-call", toolCallId:"call_b", toolName:"Grep", args:{...} },
    { type:"tool-call", toolCallId:"call_c", toolName:"Bash", args:{...} },
  ]
        │
        ▼  SDK 对本轮所有 tool-call 并发调用各自的 execute()
        │  （Promise.all 语义，无 Alma 自造的并发上限）
        ▼
tool message
  parts: [
    { type:"tool-result", toolCallId:"call_a", result:{...} },  ← 按 toolCallId 配对
    { type:"tool-result", toolCallId:"call_b", result:{...} },
    { type:"tool-result", toolCallId:"call_c", result:{...} },
  ]
```

配对键是 **`toolCallId`**——模型在下一轮看到结果时，靠这个 id 知道哪份输出对应哪次调用。复刻时这个 id 必须从模型的 tool_call 原样透传到 result，一字节都不能改，否则上下文就错位了。

### 2.3 为什么不自造并发锁

bundle 实证无 p-limit/semaphore/Bottleneck。这个「缺席」本身就是设计决策，理由可以还原为：

1. **工具本质上是异构 I/O**。Read/Grep/WebFetch 并发十个也不会互相伤害；真正危险的是写，但写操作在 Alma 里走的是另一条路——`Write`/`Edit` 这类工具在权限层就要审批（见 04 篇），审批流天然串行化了高风险写。
2. **锁放错层比没有锁更糟**。如果在执行器层加一个全局 N=4 的信号量，那么「4 个慢 WebFetch 堵死 1 个快 Read」会成为常态。SDK 不限制、让事件循环自然调度，反而是平均延迟最低的方案。
3. **真正的并发控制发生在更上层：模型本身**。`parallelToolCalls` 开着，但模型通常一轮只发 2-4 个调用——LLM 就是最好（也最便宜）的并发度调节器。

**什么时候应该主动关掉并行 tool**（复刻清单）：

| 场景 | 关法 |
|---|---|
| 工具集里有互相可能写同一文件的写工具 | 关并行，或把写工具标成「独占」 |
| 子代理/harness 受控上下文 | Alma 的做法：`Lt` 闸门直接关 |
| 工具副作用有顺序依赖（A 的产物是 B 的输入） | 这本来就不该并行——是 prompt/工具设计问题，提示模型分轮调 |
| 计费敏感的批量任务 | 并行会让 token 消耗的速率尖峰，限流场景关掉更稳 |

---

## 3. fork-join 子代理模型（本篇核心）

### 3.1 两个工具，四象限

Alma 的多代理编排收敛到**两个工具**的语义上，【实证】全部命中：

```
Task 工具
  ├─ subagent_type / agent_id   → 选角色（查 crew 注册表）
  ├─ prompt                     → 任务书
  ├─ run_in_background: z.boolean()
  │     describe: "Set to true to run this agent in the background.
  │                Use TaskOutput to read the output later."    ← bundle 原文
  ├─ resume / resumeFrom        → 续聊（见 3.4）
  └─ handoff                    → 交接说明（goal 等结构化字段）

TaskOutput 工具
  ├─ taskId
  └─ block: true/false          → 同步等 or 轮询看一眼
```

| | 前台 Task（默认） | 后台 Task（`run_in_background:true`） |
|---|---|---|
| 调用返回时机 | 子代理**跑完**才返回，结果直接是 tool-result | **立即**返回 `{taskId, message:"Agent started in background..."}`（bundle 原文实证） |
| 主 agent | 阻塞等待（这次 tool call 占住这一轮） | 继续干别的 |
| 拿结果 | 不需要 | `TaskOutput(block:true)` 来 join |
| 适用 | 主 agent 没它就推进不下去的关键路径任务 | 可并行的探索/调研/独立子任务 |

bundle 里还有一段给模型看的引导文案【实证】，值得照抄：

> *"Prefer foreground execution so the user can watch the agent's progress stream inline. Use run_in_background only when concurrency matters more than live visibility… Launch multiple agents concurrently…"*

——**默认前台，只有并发收益大于可见性损失时才后台**。这个默认很反直觉但非常对：前台 Task 的中间过程会实时流式显示给用户（经 `/api/threads/:threadId/subagent-messages`，【实证】路由存在），后台的则静默。可见性是多 agent 系统最稀缺的资产。

### 3.2 fork-join 时序图

主 agent 一口气撒 3 个后台子代理、继续干活、逐个 join：

```
主 agent                子代理 A           子代理 B           子代理 C
   │  Task(bg, "调研X")    │                 │                 │
   ├─────────────────────►│ streamText loop │                 │
   │◄── taskId=a (立即)    │  (便宜模型)      │                 │
   │  Task(bg, "调研Y")    │      │          │                 │
   ├──────────────────────┼──────┼─────────►│ streamText loop │
   │◄── taskId=b           │      │          │      │          │
   │  Task(bg, "调研Z")    │      │          │      │          │
   ├──────────────────────┼──────┼──────────┼──────┼─────────►│ loop
   │◄── taskId=c           │      ▼ done     │      ▼ done     │  ▼ done
   │  继续做自己的事         │  (结果存任务表,  │  (同上)         │ (同上)
   │  (读文件/写代码/...)   │   不销毁)       │                 │
   │      ▼                │                │                 │
   │  TaskOutput(a, block:T)                │                 │
   │◄────── 立即返回(已完成) ┘               │                 │
   │  TaskOutput(b, block:T) ────────────────────────────────►│
   │     ……阻塞等待…… ◄───────── 返回 B 的 final answer        │
   │  TaskOutput(c, block:T) ────────────────────────────────────►
   │     ……阻塞等待…… ◄───────────────── 返回 C 的 final answer │
   │      ▼
   │  综合 A+B+C，继续主任务
```

要点：

- **join 是惰性的**。后台子代理跑完就把结果挂在那，主 agent 什么时候需要什么时候来取。不需要事件、不需要回调、不需要消息队列。
- **join 的顺序由主 agent 的上下文决定**，不是固定 A→B→C。模型看到「我现在急需 B 的结果」就会先 join B。把调度决策交给 LLM，又省了一个调度器。
- **主 agent 拿到的只是 final answer**（见第 6 节），中间几十步的工具调用不进主上下文——这是上下文预算能守住的关键。

### 3.3 子代理的本质：递归的同一条 loop

【实证 + 推测-高置信】Task 工具的 execute 大致是：

```
execute({ subagent_type, prompt, run_in_background, ... }):
    agentDef = crewRegistry[subagent_type]      // 查静态注册表，注入角色 systemPrompt
    model    = depth > 0 ? toolModel : chatModel // 子代理用便宜模型（04 篇的模型槽位）
    runner   = () => streamText({                // ← 同一条 loop，递归
        model, messages: [...], tools: filteredTools,
        system: agentDef.systemPrompt, ... })
    if (run_in_background) {
        taskId = taskStore.create(runner)        // 扔进任务表，立即返回
        return { taskId, message: "Agent started in background..." }
    }
    return await runner()                        // 前台：阻塞到跑完
```

managed crew 是**静态注册表**：`agent_id → { systemPrompt, allowedDelegates, mode }`【实证：bundle 中 `agent_id` 命中 25 次、`subagent_type` 命中 10 次】。Task execute 时查表，把角色 prompt 注入子代理的 system message。`allowedDelegates` 是委派白名单——researcher 能 delegate 给 product-manager，但不能随便 spawn 另一个 researcher 套娃。

子代理产出的消息经 `GET /api/threads/:threadId/subagent-messages` 暴露给前端【实证】，用户在主对话里点开就能看到子代理的**完整过程**（每一步 tool call/result）。可观测性不是靠日志，是靠把子代理消息也建模成一等公民的 UIMessage。

### 3.4 resume：跑完不销毁，续上下文接着问

【实证】Task 参数含 `resume:` / `resumeFrom` / `resumed`（bundle 命中 `resumeFrom` 4 次），describe 里有 *"If provided, the agent will continue from the previous execution transcript."*

设计意图值得单独说：

- **无 resume 的系统**：子代理是一次性函数调用，`f(prompt) → answer`。想追问就得把背景重新塞进新 prompt，上下文丢了，钱也白花了。
- **有 resume 的系统**：子代理是**有状态会话**。跑完第一次后 transcript 保留，主 agent 可以 `Task(resume: taskId, prompt: "你刚才说的第 2 点，展开验证一下")`——子代理带着全部记忆继续。

这让「主 agent ↔ 专家子代理」从**一次性外包**变成**可反复咨询的同事关系**。council 模式（第 5 节）的多轮辩论能成立，靠的就是 resume：每个「声音」是一个可续聊的子代理，不是每轮重新 spawn。

代价也明确：transcript 要持久化、要占内存/磁盘，所以 resume 必须有生命周期管理（Alma 的 thread 版本树 `parent_id/slot_id/depth` 在这里复用，见 04 篇）。

---

## 4. 并行 tool vs 并行子 agent：怎么选

这是复刻者最容易踩空的决策点。两者都是「同时干几件事」，但代价结构完全不同：

| 维度 | 并行 tool（一条消息多个 tool-call） | 并行子 agent（fork-join） |
|---|---|---|
| **粒度** | 单次工具调用，秒级 | 一整个 agent loop（多轮推理+多工具），秒到分钟级 |
| **上下文** | 所有结果**全量**进主上下文 | 只有 final answer 进主上下文，中间过程隔离 |
| **隔离性** | 无——共享同一个 loop、同一个工作区、同一份消息历史 | 有——独立消息历史、独立 systemPrompt、可用不同模型 |
| **推理成本** | 零额外推理（还是主 agent 在思考） | 每个子代理都是独立的 token 消耗流 |
| **角色化** | 不可能（工具没有人格） | 可以（crew 注册表注入角色 prompt） |
| **可观测性** | 天然内联在主对话里 | 需要专门的 subagent-messages 通道 |
| **失败爆炸半径** | 一个 tool 挂了只影响这一轮 | 一个子代理跑偏可能烧掉几万 token 才被发现 |
| **并发度上限** | 模型一轮愿意发几个就是几个（通常 2-4） | 理论上不限，实际受钱包和深度限制约束 |

**决策口诀**：

```
任务是「查/读/取」且结果都要给我？         → 并行 tool
  例：同时 Read 3 个文件、Grep 2 个符号

任务需要「先想清楚再动手」、中间过程我不关心？ → 并行子 agent
  例：3 个方案各自做可行性调研，我只要结论

任务之间可能写同一份状态？               → 都不要并行，串行
  例：两个「重构」子代理改同一批文件 = 灾难

要给任务一个「人格/立场」（对抗、辩论、评审）？ → 只能子 agent
  例：council 里 4 个不同立场的声音
```

一句话：**并行 tool 是「我的手变多了」，并行子 agent 是「我请了临时工」**。手多了活儿还是你一个人的脑子在干；临时工有自己的脑子，所以贵、所以隔离、所以能吵架。

---

## 5. 编排模式沉淀为 skill 的设计哲学

### 5.1 三个模式的机制拆解

Alma 把高层多 agent 编排**写成了 skill**（可加载的 markdown 指令包，加载机制见 04 篇），而不是主循环代码。三个代表性模式的机制可以还原为：

**① council（委员会）**

```
机制：同一个问题 fork 给 N 个不同立场的子代理（多头/空头/怀疑论者/务实派），
      各自独立作答（可 resume 做多轮），主 agent 扮演主持人收敛共识。
骨架：fork×N（并行后台）→ join×N → 交叉质询（resume 第 2 轮）→ 主持人裁决
关键依赖：run_in_background + resume——没有 resume，多轮辩论的上下文成本爆炸
```

**② gan-style-harness（Generator-Evaluator 对抗）**

```
机制：Generator 子代理产出一版 → Evaluator 子代理按清单打分 →
      不过线则把批评喂回 Generator 重来，直到收敛或达到 maxIterations。
骨架：loop { gen = Task(generator, 上一轮的批评); score = Task(evaluator, gen);
             if (score.pass) break }
关键依赖：两个角色 systemPrompt 必须对抗性设计（生成者不知道评分细则细节，
      评分者不参与生成），否则退化成互相吹捧。
```

**③ ralphinho-rfc-pipeline（RFC 驱动 DAG）**

```
机制：大需求先写成 RFC（spec artifact 落盘），拆成有依赖关系的工作单元 DAG，
      无依赖的节点并行 spawn 执行，每个节点过完质量门才解锁下游。
骨架：RFC → DAG 分解 → 按拓扑层并行 fork → 每层 join + 质量门 → 进入下一层
关键依赖：结构化 handoff（Task 的 handoff.goal 字段实证存在）+
      spec 落盘（子代理上下文隔离意味着只能靠文件传复杂状态，不能靠上下文）
```

注意【实证】bundle 的 agent_mission 表里有 `harnessMode`、`maxIterations`、`currentPhase` 字段，且查询条件里出现 `harnessMode != "sprint-harness"`——说明至少 sprint-harness 这一类编排是**有持久化状态机**的（跑几轮、当前在哪个 phase 都落库），不是纯内存流程。编排一旦可能跨小时/跨天，状态就必须能恢复。

### 5.2 为什么不硬编码进主循环

这是 Alma 架构里一个很成熟的判断。对比两种做法：

| | 硬编码进主循环 | 沉淀为 skill |
|---|---|---|
| 加载时机 | 永远占系统 prompt 空间 | 用到才读进上下文 |
| 组合性 | 模式之间互相打架（council 的指令污染 harness 的场景） | 一次只激活一个，互不污染 |
| 迭代成本 | 改编排 = 改代码 = 发版 | 改 markdown 即生效 |
| 可发现性 | 模型不知道有这个能力，除非 prompt 里写死 | skill 列表自带 describe，模型按需调用 |
| 主循环复杂度 | O(模式数) 增长 | 恒定——主循环只认识 Task/TaskOutput 两个原语 |

核心论点：**主循环只提供原语（fork/join/resume），模式交给 prompt 层的 skill**。主循环代码因此稳定得可怕——新增一种编排模式不需要动一行运行时代码。这和 Unix「机制与策略分离」是同一个思想：机制在内核（Task/TaskOutput），策略在用户态（SKILL.md）。

### 5.3 编排 skill 的写法骨架

一个编排类 SKILL.md 大概长这样（模式示意，非 Alma 原文）：

````markdown
---
name: council
description: 用多声音委员会做高风险决策。当用户面临有多种合理路径的
  模糊抉择、tradeoff 取舍或 go/no-go 判断时使用。先并行收集 N 个立场，
  再交叉质询，最后给出带分歧记录的裁决。
---

# Council 模式

## 何时触发
- 存在 2 个以上都有道理的方案，且选错的代价高
- 用户说「帮我权衡」「有没有人反对这个方案」

## 执行步骤
1. 识别问题里的关键立场维度，选定 3-4 个声音（如：增长优先/风险优先/
   成本优先/长期主义），每个声音用 Task(run_in_background: true) 并行发起，
   prompt 里写死该立场的 system 角色
2. TaskOutput(block: true) 逐个 join 第一轮观点
3. 把 A 的观点摘要通过 Task(resume: taskId_B) 发给 B 做交叉质询，
   每个声音收到其他声音的摘要后做第二轮回应
4. 汇总：列出共识点、不可调和的分歧、以及主持人的裁决建议
5. 裁决必须包含「如果 X 前提不成立，则应改选 Y」的条件分支

## 红线
- 声音之间不得互相看到完整 transcript（只传摘要），防止立场趋同
- 超过 2 轮质询仍无收敛迹象时，直接呈现分歧，不要为了共识而共识
````

三个要点：**frontmatter 的 description 就是触发器**（模型靠它决定何时加载）、**步骤里直接引用 Task/TaskOutput 原语**（skill 是原语的编排脚本）、**红线区防模式退化**（council 最怕声音趋同，harness 最怕互相吹捧——都写死在 skill 里）。

---

## 6. 成本与上下文控制

多 agent 系统翻车极少因为「逻辑错了」，几乎全部因为「钱烧穿了」或「上下文炸了」。Alma 的四道阀门：

### 6.1 子代理用便宜模型

【实证 + 推测-高置信】04 篇已证实模型分槽（`chat` / `toolModel` / `visionModel` ...）。子代理深度 `depth > 0` 时 resolveModel 走 `toolModel` 而非 `chat`。效果：主对话用旗舰模型保体验，子代理跑腿用次级模型，**成本差 5-10 倍**。council 一次撒 4 个子代理 × 3 轮质询 = 12 次完整 loop，如果全走旗舰模型，一次决策就够吃一顿饭了。

### 6.2 上下文隔离：final answer 是唯一的出口

子代理跑 30 步、读了 20 个文件，主 agent 只拿到最后一段结论。中间过程：

- 存进子代理自己的消息历史（供 subagent-messages 路由查询 + resume 续聊）；
- **不进主 agent 上下文**。

这意味着主 agent 的上下文预算只随「子代理结论」线性增长，而不是随「子代理工作量」爆炸增长。这也是第 4 节决策表里「中间过程我不关心」成为 fork 判据的原因——**你关心的每一份中间过程，都要花主上下文的钱**。

### 6.3 深度限制防无限递归委派

子代理的 tools 里也有 Task——它能再 spawn 孙代理。没有限制就是递归炸弹：A 委派 B、B 委派 C、C 觉得活太大又委派 D……每一层都是独立 token 流。

【推测-高置信】Alma 的限制是组合拳：

- `depth` 随 thread 版本树传递（04 篇实证 schema），深度超阈值直接拒绝或降级；
- `allowedDelegates` 白名单（实证概念存在）让每个角色只能委派给指定的下一层，图结构上有向无环；
- 子代理关掉 `parallelToolCalls`（2.1 节的 `Lt` 闸门），从微观层面再压一层扇出。

### 6.4 前台默认（可见性 = 成本兜底）

3.1 节的引导文案「prefer foreground」还有一层经济含义：后台子代理跑偏时没人看见，直到 join 才发现烧了几万 token 产出一堆垃圾；前台子代理的流式过程用户实时可见，跑偏了会被手动 stop_generation 掐掉。**可见性不只是 UX，是成本熔断器。**

---

## 7. 【复刻要点】最小可运行 fork-join 内核

以下是一个自洽的 TS 骨架（~120 行），依赖只有 `ai` + `zod`。覆盖：并行 tool 执行、Task(background)/TaskOutput(join)/resume、crew 注册表、深度限制。关键注释里标了坑。

```typescript
import { generateText, tool } from "ai";
import { z } from "zod";

// ---------- crew 注册表：agent_id → 角色定义 ----------
const CREW: Record<string, { system: string; delegates: string[] }> = {
  researcher: { system: "你是调研员：只找证据，给结论。", delegates: [] },
  reviewer:   { system: "你是评审：只挑毛病，不给实现。", delegates: ["researcher"] },
};
const MAX_DEPTH = 2;          // 坑0：不设深度上限 = 递归委派炸弹
const JOIN_TIMEOUT_MS = 120_000;

// ---------- 任务表：后台子代理的状态机 ----------
type TaskRec = {
  status: "running" | "done" | "failed";
  result?: string; error?: string;
  transcript: any[];          // resume 的本体：完整消息历史
};
const tasks = new Map<string, TaskRec>();

// 子代理跑一次 loop（可续 transcript）。独立函数 → 前后台共用。
async function runAgent(type: string, prompt: string, prev: any[], depth: number) {
  const def = CREW[type];
  if (!def) throw new Error(`unknown subagent_type: ${type}`);
  const r = await generateText({
    model: pickModel(depth),           // depth>0 → 便宜 toolModel
    system: def.system,
    messages: [...prev, { role: "user", content: prompt }],
    tools: makeTools(depth),           // 递归：子代理也能拿到 Task
    maxSteps: 8,
    // 坑1：子代理上下文里 parallelToolCalls 应关掉（Alma 的 Lt 闸门），
    // 避免受控环境里出现不可控的并发写。
  });
  return { text: r.text, transcript: [...prev,
    { role: "user", content: prompt }, ...r.response.messages] };
}

function makeTools(depth: number) {
  return {
    Task: tool({
      description: "Spawn a sub-agent. Background returns taskId immediately.",
      parameters: z.object({
        subagent_type: z.string(),
        prompt: z.string(),
        run_in_background: z.boolean().optional(),
        resume: z.string().optional(),   // taskId → 续 transcript
      }),
      execute: async ({ subagent_type, prompt, run_in_background, resume }) => {
        if (depth + 1 > MAX_DEPTH) return { error: "max delegation depth exceeded" };
        if (resume && !tasks.has(resume)) return { error: "no such task to resume" };

        const prev = resume ? tasks.get(resume)!.transcript : [];
        const job = runAgent(subagent_type, prompt, prev, depth + 1);

        if (!run_in_background) {               // 前台：阻塞，结果即 tool-result
          const r = await job;
          return { result: r.text };
        }
        const taskId = crypto.randomUUID();
        const rec: TaskRec = { status: "running", transcript: [] };
        tasks.set(taskId, rec);
        job.then(r => { rec.status = "done"; rec.result = r.text;
                        rec.transcript = r.transcript; })
           .catch(e => { rec.status = "failed";   // 坑2：后台异常绝不能吞！
                         rec.error = String(e);   // 吞了 → join 方永远 block
                         console.error(`[task ${taskId}]`, e); });
        return { taskId, message: "Agent started in background. Use TaskOutput." };
      },
    }),

    TaskOutput: tool({
      description: "Read a background task's result. block=true waits.",
      parameters: z.object({ taskId: z.string(), block: z.boolean() }),
      execute: async ({ taskId, block }) => {
        const rec = tasks.get(taskId);
        if (!rec) return { error: "unknown taskId" };
        if (!block) return { status: rec.status, result: rec.result, error: rec.error };
        // 坑3：join 必须有超时。没有超时，子代理死循环 = 主 agent 植物人。
        const deadline = Date.now() + JOIN_TIMEOUT_MS;
        while (rec.status === "running") {
          if (Date.now() > deadline)
            return { status: "timeout", partial: rec.result };
          await new Promise(r => setTimeout(r, 200));
        }
        return { status: rec.status, result: rec.result, error: rec.error };
      },
    }),
  };
}

function pickModel(depth: number) {
  // 伪代码：depth===0 用旗舰 chat 模型，depth>0 用便宜 toolModel
  return depth === 0 ? flagshipModel : cheapModel;
}

// ---------- 并行 tool：不需要自己写 fan-out ----------
// AI SDK 的 generateText/streamText 在并行 tool call 时自动并发执行
// 同轮所有 tool-call，按 toolCallId 配对结果。你要做的只有两件事：
// (a) 创建 provider 时透传 parallelToolCalls: true；
// (b) 受控上下文（子代理/harness）里把它关掉——就是 Alma 的 !Lt && void 0。
//
// 坑4：并行写文件。SDK 不加锁，两个 tool-call 同时 Write 同一路径会互相
// 截断。对策二选一：写工具的 execute 里加一个 per-path 互斥锁
// （const locks = new Map<string, Promise<void>>()），或者直接在
// parallelToolCalls 层全局关掉并行。Alma 选择了后者。

// ---------- 主入口：主 agent 也是同一条 loop ----------
export async function mainLoop(userPrompt: string) {
  return generateText({
    model: pickModel(0),
    system: "你是主 agent。可并行调工具，也可用 Task 委派。默认前台 Task。",
    messages: [{ role: "user", content: userPrompt }],
    tools: makeTools(0),
    maxSteps: 20,
  });
}
```

骨架里埋的 5 个坑，按踩中概率排序：

| # | 坑 | 症状 | 对策 |
|---|---|---|---|
| 2 | 后台子代理异常被吞 | 主 agent `TaskOutput(block:true)` 永远等下去，线程假死 | `.catch` 必须写 `rec.status="failed"` + error 透出；join 方见到 failed 立即返回错误 |
| 3 | join 无超时 | 子代理死循环/模型限流时主 agent 植物人 | `JOIN_TIMEOUT_MS` 硬上限 + 超时返回 partial，让模型自己决定继续等还是放弃 |
| 4 | 并行写同一文件 | 两个并发 Write 互相截断，文件内容撕裂 | per-path 锁，或受控上下文关 `parallelToolCalls`（Alma 方案） |
| 0 | 无深度限制 | A→B→C→D 递归委派，token 账单指数爆炸 | `MAX_DEPTH` 硬闸 + `allowedDelegates` 白名单让委派图有向无环 |
| 1 | 子代理里开并行 tool | 受控环境出现不可控并发，调试地狱 | depth>0 时 `parallelToolCalls: undefined`（复刻 `Lt` 闸门） |

---

## 8. 结语：Alma 多 agent 设计的三个「不做」

把全篇收拢成三条减法原则——复刻时抵住「加东西」的冲动，比抄对实现更重要：

1. **不自造并发原语**（无 p-limit/semaphore）——fan-out 给 SDK，调度决策给 LLM，并发度给模型自己。
2. **不为子代理写第二套引擎**——子代理 = 递归的同一条 streamText loop + 换 system prompt + 换便宜模型，就这么多。
3. **不把编排模式写进主循环**——主循环只有 Task/TaskOutput 两个原语；council、harness、DAG 全是 skill 层的 markdown，按需加载、随时改写。

多 agent 系统的复杂度不在「并行」本身，在于**控制并行的爆炸半径**。Alma 的答案：隔离上下文（final answer 唯一出口）、隔离模型（子代理用便宜的）、隔离模式（编排是 skill 不是代码）、隔离权限（委派白名单 + 深度闸）。四层隔离都做到了，剩下的交给 LLM。
