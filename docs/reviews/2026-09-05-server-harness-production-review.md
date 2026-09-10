# Server / Harness 生产架构评审

日期：2026-09-05。代码基线：`9dc66ef`。评审范围：server、harness，以及两者依赖的消息/事件契约和测试。

## 判断与范围

**建议重做执行内核及其持久化边界，保留桌面宿主、Fastify、SQLite、模型适配器和可复用工具实现。** 当前最主要的问题是：围绕文件组织、接口收窄和历史功能累加了复杂度，但上下文连续性、执行权限、原子启动、幂等终态等生产不变量没有获得同等强度的保证。

本评审按“本地优先、单用户桌面生产产品”设计；多会话和多个 agent 并发仍然是实际场景。没有假定需要多租户云服务、分布式调度、Redis、Kafka 或微服务。不考虑历史数据兼容，意味着可以直接设计新 schema 和协议；不意味着降低取消、审计或文件写入的正确性标准。

本轮是审查与方案交付，没有修改业务代码，没有删除用户数据。方案中的删减是新实现的建议。AGENTS.md、旧架构宪章作为历史决策背景阅读，不能代替代码事实：例如 AGENTS.md 仍说子代理已移除，实际已有完整的 subagent 模块。约定的 `.refrences/cindy/` 在当前 checkout 不存在，因此未进行该参考实现的比较。

## 已确认的问题

P1：应在把当前执行内核视为生产可靠之前解决。P2：重构时应一并处理的设计或运维问题。“动态复现”指本轮用真实模块和可控模型/调度探针验证，不代表运行了真实付费模型或真实外部写操作。

### 1. P1：续跑丢失原始任务；工作上下文缺少唯一所有者

- `packages/harness/src/agents/recovery-policy.ts:68` 和 `:91` 只用 `responseMessages + 续写/通知` 建下一次输入。
- `packages/harness/src/agents/run-loop.ts:663`、`:702` 用它替换 `messages`，原始用户任务、之前的对话和运行附加上下文没有拼回。
- 本地安装的 AI SDK `stream-text.ts` 的 `responseMessages` getter 返回本次生成的 response messages，并不包含 original input。也与 [AI SDK 官方工具调用文档](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) 所述“把 response messages 添加到历史”的用途一致；版本细节以本地 v7 源码为准。
- **动态复现：**第一次输入有 `ORIGINAL_TASK_8491`，模型因 length 结束；第二次模型请求不再包含该任务。通知续跑使用同样的构造方式，静态确认同类丢失。
- reactive compact 也需要同一轮审查：错误恢复读的是外层 `messages`，不是 SDK 已完成步骤的最新工作集。一次调用先执行工具、后续步骤溢出时，有退回旧上下文的风险；本轮未对这一扩展场景做动态复现。

**重做方式：**一个运行工作集拥有输入和已完成步骤；每步产物只追加一次；压缩产物是该工作集的显式版本。普通下一步、length 续写、通知和失败恢复都使用同一个游标，不各自重建历史。长度耗尽优先返回明确的 incomplete；确需自动续写时，受同一个运行预算约束。

### 2. P1：工具执行管线有第二入口

- `packages/harness/src/agents/agent.ts:18` 只在构造时包装 `options.tools`。
- `packages/harness/src/agents/run-loop.ts:200` 将 `input.additionalTools` 直接 merge 到已包装工具中，甚至可以同名覆盖。
- server 正在使用这个入口注入记忆和子代理工具，见 `run-coordinator.ts:359` 附近。
- **动态复现：**后注入一个 `needsApproval: true` 工具，审批函数始终返回 false；工具执行一次，审批函数零次调用。
- 这是权限、并发、plan gate、计时共同的入口缺陷。当前后注入工具不等于全部都应要求审批；问题是标记无法被统一执行。

**重做方式：**先收齐本轮所有 tool definitions，再统一编译成可执行 tools。运行时发现只改变模型可见目录，不替换 executor。新工具必须经过同一个注册/编译入口；重名报错。需要审批的工具缺少 policy host 时应拒绝创建或拒绝执行，不能静默裸跑。

### 3. P1：同会话并发启动不是原子操作

- `apps/server/src/modules/runs/run-preparation.ts:144` 查会话是否空闲；`:187` 已写用户消息后 await 工作区准备；`run-coordinator.ts:257` 才创建 running 行。
- 两个请求可在第一个 running 行出现前都通过检查。runs 表没有对应的主运行唯一约束。
- **动态复现：**同会话同时执行两次真实 preparation → start，成功得到两条 running 行。
- 现有 `tests/server/runs/run-concurrency.test.ts` 测的是“预先存在 running 行再发送”，不是两个请求同时抢占。

**重做方式：**一个同步 SQLite 事务完成输入校验后的会话定位、主运行占位、用户消息追加与 active leaf 更新；之后才进行网络/文件 await。用主运行 partial unique index 作兜底，不能把允许并发的 child run 一起禁掉。client request id 加唯一约束，HTTP 重试返回已有 run，不重复写消息。

### 4. P1：终态接口的收窄没有保证幂等提交与持久性

- `run-finalizer.ts:90` 先落 assistant，再调用 ledger.settle，两个动作没有统一事务。
- `run-repository.ts:115` 按 run id 直接 UPDATE，没有 `status = running` 的条件和受影响行数校验。
- **动态复现：**completed/stop 再 settle(error) 后变成 error/stop，自相矛盾；接口/工厂限制并未阻止终态被覆盖。
- `assistant-message-recorder.ts:46` 默认 finishReason 是 stop，未要求必须看到明确 finish/error 才允许完成。
- coordinator 先向客户端 emit，再记录消息；普通 assistant 内容直到结束才落库。进程崩溃会失去当前段的工具结果和回复。现有 startup sweep 能标记中断，却不能恢复未落盘的对话执行记录。

**重做方式：**以完成步骤和工具操作为持久化边界；终态用事务提交 message/active leaf/run outcome/usage，条件更新保证终态只接受一次。缺少 terminal outcome 当作 interrupted/error，不能默认成功。UI 的 provisional delta 可以先发，committed 事件须在事务后发。

工具副作用和本地数据库之间无法普遍实现原子事务：执行前记录 operation，执行后记录 receipt；崩溃留下的执行中操作标记 unknown。非幂等操作不能自动重放。不要承诺 exactly-once 外部效果。

### 5. P1：压缩绕过消息树，破坏分支与子代理隔离

- `apps/server/src/modules/compact/compact.ts:155` 直接取会话全部消息，`:168` 对时间序列表切片。
- `SessionService.buildModelHistory` 则使用 active chain；两条路径没有共享选择规则。
- `session.ts:108–111` 在摘要锚点不属于当前链时仍套用旧摘要，并只取尾部固定数量消息。
- **动态复现：**compact summarizer 输入包含非当前分支消息和带 parentToolCallId 的子代理消息。
- 这会把用户已弃用的回复、隔离的子代理过程带回主模型。token 变少并不代表 compact 正确。
- 另有静态确认的规模缺陷：`session.ts:23/:92` 最多读取 2000 条；repository 按时间升序取前 2000 条。较长会话的 active leaf 在窗口外时，主链构造会失效。需要按祖先链/游标查询，不应只是调大常量。

**重做方式：**先选定 branch 和 ancestor chain，再压缩；checkpoint 绑定 branch/covered-through/version，锚点不匹配则不用该摘要。子代理拥有自己的 transcript，仅通过明确的结果消息进入主链。

### 6. P1：文件写守卫不能防止并发覆盖

- `packages/harness/src/tools/concurrency-cap.ts:49` 只限制 readOnly，写工具直接并发。
- `fs/edit-tool.ts:36–59` 在两次 stat 后仍有异步 write 窗口；`fs/write-tool.ts:41–56` 两次 stat 也没有形成原子 compare-and-swap。
- **动态复现：**两个 edit 分别替换同一个文件中的 A 和 B，让它们均完成 stat 后再写；两次都返回 Edited，最终文件只保留一个修改。

**重做方式：**第一版对 agent 的 workspace 写操作使用共享串行门，主/子/跨会话共用；同路径 read-modify-write 在锁内完成。落盘用临时文件 + rename 防半文件。工具读写版本/内容哈希用于发现外部编辑冲突。锁只能协调 Eva 内部写入，不能把任意外部编辑器变成协作事务；bash 写入同样需要纳入执行策略。不要宣称 mtime 或原子 rename 单独解决 lost update。

### 7. P2：后台子代理拥有第二套生命周期，而且缺少完整控制面

- `subagents/subagent-runner.ts` 自己创建 task、child run、消息、observer、settle，与主 RunCoordinator/Finalizer 并行维护一套逻辑。
- 后台 child run 有 DB 行，却没有独立注册进 RunRegistry；停止 API 依赖 registry，因此不能直接按 child run id 停止它。
- 父 run 完成后 unregister；child 仍共享原父 abort signal，但原 run id 已失去控制入口。
- `report-gateway.ts` 只把通知留在本轮内存队列，父模型收尾最多等 20 秒；较晚结果留库可查，却没有可靠的后续消费/唤醒协议。
- `RunApprovalChannel.subagentRequestApproval` 无条件 autoApprove。**当前内置角色有只读工具白名单，因此不能据此断言默认子代理已能任意写文件。** 但“因为后台无人审批所以直接放行”是不可继续扩展的权限规则。
- 还有 depth、allowedDelegates 等配置与实际派发路径不一致的脚手架，例如 runFork 的深度检查固定传 0。

**建议：**先只保留结构化 fork/join：主子共享一份运行预算，独立 transcript，明确 join/cancel，权限取父授权与角色约束的交集。只有产品明确需要跨父 run 存活时，再引入独立可查询、可取消的 durable job；它的通知用持久 inbox。删除 20 秒“碰巧赶上本轮”的交付语义。

### 8. P2：生产正确性与可选观测混在一起

- `run-recorder.ts` 明确允许关闭、脱敏截断和写入失败吞掉。这适合作为诊断数据，不足以承担可恢复的执行事实。
- `observer-bridge.ts:91` 附近通过 observer 回调写 failureLayer；finalizer 又依赖这个可变引用确定产品终态归因。
- `pino-observer.ts` 的 context overflow 分支会调用 onClamp，`deps.ts:43` 接上配置写入。一个日志/观测订阅者在改变后续业务配置。
- `run-loop.ts:355` 的 request snapshot 只记录基础 systemPrompt、工具名字/描述、部分 settings，并不是 prepareStep 后真正发送的完整 messages、动态 instructions、active tool schemas；用于复现模型行为的信息不足。

**重做方式：**RunOutcome 直接携带结构化错误与归因；模型容量学习如保留，应走显式命令且限幅，不能永久修改用户配置作为任意超限错误的副作用。必需执行记录与可选 trace 分开，trace 能关，operation receipt/terminal commit 不能关。实际模型请求快照放到 model adapter 边界，按隐私策略保留内容或仅保留哈希/版本，不声称关闭内容捕获仍可完整复现。

### 9. P2：运行启动把非必要智能功能都放到了首 token 前

- buildAgent 先 await 全部 MCP 连接，然后加载记忆、LLM skill 选择；prepareRunContext 再做会话压缩、记忆检索。MCP 并行连接后仍 await all，最慢项仍会挡住首 run。
- `select-run-skills.ts` 每轮选择新技能并跨会话累积；`auto-select.ts` 接口没有 run abort/deadline。技能选择需要额外模型调用，也可能越来越接近全量注入。
- 同一 run 的 settings/model 通过多个路径重复读取；不是固定的 RunSpec。配置在准备期间变化时，有组合不一致的风险。
- 当前没有看到统一覆盖准备、主/子模型、辅助模型、工具执行的预算及取消入口。单个 maxSteps 或 tool timeout 不等于完整运行预算。

**重做方式：**运行开始固定配置快照，先返回 run id。小技能目录直接给 metadata，大目录按确定性检索 + read_skill；按需工具发现不需要一轮额外预选模型。MCP 有独立连接管理、有限等待和明确缺席状态。辅助任务同样继承取消/预算，并给出确定的降级策略。

## 哪些设计值得推翻

| 当前机制 | 建议 | 原因 |
| --- | --- | --- |
| infra → services → api 三套容器及重复装配 | 一个 composition root；路由调用具体 use case | 有状态连接仍集中管理，无状态函数不需要再包装一层同形接口 |
| RunOpeningLedger / RunSettlingLedger / FinalizerFactory | 合并为运行服务与事务函数 | 编译期收窄不能代替状态机、CAS 与事务；目前大量代码只为禁止某处调用某方法 |
| agent create + stream additionalTools 双入口 | 一次注册和一次执行管线 | 消除实际的能力绕过与不同计时语义 |
| SDK 多步循环外又包恢复/通知循环 | 只有一个持有工作集的循环 | SDK 继续处理 provider/流协议；应用显式拥有步骤提交和下一步决定 |
| 独立 session compact + runtime compact + reactive rewind | 一个 ContextManager | 统一祖先链、预算、摘要、工具调用配对与 checkpoint |
| 每轮 LLM 选 skill + 会话累积表 | metadata + read_skill；需要时确定性检索 | 先删启动延迟、隐式累积状态和额外失败路径 |
| 5 个记忆工具、自动召回/改写/embedding 组合 | 先保留用户可编辑长期文件 + 显式 search/save | DB/文件两种介质本身并非错误；自动化收益应由评测证明后再加 |
| Plan Gate 和 Plan Weave 双计划体系 | 默认 plan.md + 一个 mode；工作流能力按产品需求单独评估 | 两套持久状态机不应成为每次 agent run 的基础依赖 |
| Plan Weave 到 review 上限强制通过 | 改为 needs_attention / exhausted | `service.ts:464` 将耗尽预算转成 done，混淆“未通过”和“已完成” |
| 主/前台子/后台子三种收尾方式 | 同一个执行内核；先只做 fork/join | 统一权限、取消、预算与结果落盘 |
| 必须字符串返回 + Error: 前缀识别 | ToolResult 判别联合，模型输出时再转文本 | 明确成功、拒绝、失败、取消、外部效果未知，不靠自然语言前缀反推状态 |
| 一次超限经 observer 永久钳模型配置 | 默认删除；必要时运行级保守预算 | 原因可能是工具 schema/附件/估算偏差，不能用一次误差改用户配置 |
| 旧 schema / settings migration / fallback | 新基线直接移除 | 不需要兼容旧数据，不应继续为历史状态增加分支 |

保留：本地 SQLite、localhost HTTP、SSE、断线不自动取消、runId/operationId、MCP 适配、文件溢出引用、审批、适量工具发现和调用时模型绑定。它们解决真实问题。不要为了“纯粹”重写所有工具、自己实现 provider 协议，或增加通用插件总线、工作流 DSL、全量事件溯源框架。

Plan mode 若只是行为提示，应准确表达，不宣称是只读沙箱；若要提供可靠的“不修改”模式，则在统一权限执行器里处理所有可能写入的工具。当前按工具名只挡 write/edit，不能兑现“Only read-only tools”这个描述。

## 建议的新结构

```text
apps/server/src/
  app.ts                 # 唯一装配点和启动/关闭
  http/                  # 参数、鉴权、错误映射、SSE
  runs/                  # accept / execute / cancel / subscribe
  storage/               # SQLite schema、事务、查询
  capabilities/          # workspace、MCP、skills、memory、model bindings

packages/harness/src/
  run.ts                 # 唯一 step loop 和 RunOutcome
  context.ts             # 唯一工作集、预算与压缩策略
  tools/                 # 注册、权限执行器、实际工具
  model.ts               # SDK/provider adapter
  types.ts               # 小而明确的运行契约
```

这是职责示意，不是文件数指标；需要拆分时按独立变化/测试边界拆。harness 不知道 HTTP、Drizzle、session、plan 数据库；server 不需要知道 SDK chunk 的供应商差异。没有第二个 host 前不追求通用 agent framework。

建议只有少数必须跨边界的契约：不可变 RunSpec、RunOutcome、ToolDefinition/ToolResult、RuntimeHost（提交步骤、申请决策等确实涉及持久化/交互的行为）。不要给每张表、每个无状态 helper 自动生成一对 interface + implementation。

执行流程：

1. **accept**：验证参数；事务内 requestId 去重、占会话主运行、追加输入，返回 runId。此时还没有任何网络 await。
2. **prepare**：固定模型/权限/工作区配置；按指定分支加载 transcript；组装工具。所有等待服从取消与有限预算。
3. **step**：从唯一工作集生成模型输入；调用 SDK 的单步能力；所有工具执行经同一个 executor；提交完成步骤后追加到工作集，再决定下一步。
4. **finish**：显式 RunOutcome；事务提交终态及最终消息关联；发 committed/end；释放订阅和资源。
5. **restart**：执行中 operation → unknown/interrupted；run → interrupted；允许用户基于最后已提交步骤继续。没有外部幂等能力的工具不自动重放。

“单步”并不是重新实现模型协议：继续使用 AI SDK 的 schema 校验、stream 和 tool dispatch，只让一次调用服务一个应用步骤，不再让 SDK 多步和应用 restart 各持一份上下文。具体 v7 行为要用 provider-contract 测试固定。

持久化建议从 thread、message/step、run、tool_operation、decision、context_checkpoint 开始；providers/settings/workspaces 等静态配置仍留 SQLite。需要消息版本功能则明确 branch_id；如果不需要，直接线性日志。不要一边使用树、一边让 compact 按会话时间序取数据。

SSE 仅负责呈现，可选方案是“带版本的 snapshot + snapshot 后增量”。无需为了重连保存每个 token：保存执行步骤、工具结果、终态和有界的文本快照即可。连接 seq 与持久记录 seq 要用不同名称、说明不同生命周期。当前 RunHub 的连接内 seq 自身不是错误；问题是它不能冒充可跨连接恢复的执行游标。慢客户端必须有缓冲上限，超限断开重取快照；disconnect 清理 heartbeat。运行关闭应先停止接单、取消/有界等待活跃任务，再关 MCP 和 DB。

## 重构顺序与退出条件

不做长时间双写兼容，也不先搬目录。每阶段先替换纵向行为、通过验收，再删除对应旧路径。

| 阶段 | 交付 | 必须通过的验收 |
| --- | --- | --- |
| 1. 最小可靠主运行 | accept 事务、单循环、统一工具 executor、terminal commit | 并发 start 只成功一个；相同 requestId 不重复；缺失 outcome 不成功；所有工具走策略 |
| 2. 上下文与文件正确性 | branch transcript、统一 checkpoint、共享写串行门 | length/通知不丢任务；retry 不混旧版本；compact 不混子代理；并发 edit 不静默覆盖 |
| 3. 取消/崩溃/重连 | operation receipts、bounded snapshot、graceful shutdown | 工具前/中/后注入崩溃；未知副作用不重放；断连继续；重连无重复；停止不继续派发 |
| 4. 收回产品能力 | 最小 skills/memory/MCP/plan，必要时 fork/join | 模型/工具/辅助调用共享预算；子权限不提升；子任务可取消且结果可消费 |
| 5. 删除与评测 | 删旧入口、旧表迁移和历史约束注释，写当前文档 | 核心契约测试 + 固定 agent 任务集；架构脚本只守少量真正边界 |

agent 评测至少包含：跨步骤保留约束、读取后修改、被拒操作不换工具重试、长上下文保留原目标、工具超时后的收尾、跨分支重试隔离。追踪成功率、错误副作用、首 token 时间、总耗时、所有模型调用成本。只看 typecheck 和 mock 单测数量不能判断 agent 质量。

## 本轮验证与限制

- 原有 server/harness 测试：**90 个文件、708 项通过**。执行 `node node_modules/vitest/vitest.mjs run tests/harness tests/server --reporter=dot`。
- 架构检查：**9 条规则、0 error、0 warning**（临时探针移出 tests 后）。
- server 与 harness 的 `tsc -p ... --noEmit`：**均通过**；未运行 web/desktop 的类型检查或构建。
- 单独构造的六项缺陷探针：**6/6 复现**；它们断言的是当前缺陷，所以没有作为正常回归测试提交到测试套件。
- 原有 continuation 测试自述 mock 无法触发 length。实际 v4 mock 应传 `finishReason: { unified: 'length', raw: 'length' }`，旧测试的字符串格式掩盖了这一分支。新的 provider-contract 测试应以当前类型约束构造 fixture。
- 未做真实 provider 质量/延迟评测、真实外部 MCP 副作用、OS 强杀恢复实验、长期 soak 或打包验证；上述相关结论已标明为静态设计审查，不冒充实测。
- 本机 pnpm 启动等待未返回，已终止本轮创建的两个 pnpm 进程，改用已安装的 Vitest/TypeScript Node 入口，没有安装或升级依赖。

复现源码保留在同目录 `2026-09-05-production-review-probes.test.ts.txt`。在仓库根复制到 `tests/production-review.repro.test.ts` 后运行：

```bash
node node_modules/vitest/vitest.mjs run tests/production-review.repro.test.ts --reporter=verbose
```

探针只用内存 DB、mock provider 和临时文件；运行后删除复制的临时测试。它有意访问模块内部以隔离边界，会触发现有跨模块 import 检查，因此不能将它直接混入生产回归套件。落实修复时应把期望翻为正确行为，分别归入 runs/context/tools 的正式测试。

最终取舍：把复杂度花在可证明的执行语义上。可以大胆删除旧的能力收窄框架和缺少产品收益的自动化机制，但不能把串行化、事务、取消、检查点和权限执行器一起当作“过度设计”删掉。
