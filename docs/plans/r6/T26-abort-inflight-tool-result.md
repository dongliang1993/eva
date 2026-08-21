# T26 · abort 时在飞工具补发取消 tool-result

> R6 追加任务,承接 T25。T25 把 abortSignal 透传进了工具、给挂死工具配了超时;
> 但**用户主动点停止**这条路径上,SDK 会把刚读完的在飞 tool-result 直接丢弃
> (`ai/dist/index.js` 外层拉流循环,abort 分支 close 前不 flush),UI 的工具卡片
> 永远停在 running,DB 里落一条悬挂的 input-available part。本任务在 harness 循环
> 的 abort 收口处,为每个"已发 tool-call、未收 tool-result"的在飞调用补发一条
> 取消结果,把 UI、事件流、finish 汇总三面一起收口。

## 1. 问题

E2E 实测(2026-08-21):`bash: sleep 300 && echo done`,跑到一半点停止 ——

| 面 | 现状 | 期望(参照 deepseek-harness) |
| --- | --- | --- |
| 进程 | ✅ sleep 300 被组杀,ps 无残留(T25) | 不变 |
| run 终态 | ✅ finish(aborted) | 不变 |
| 工具卡片 | 🔴 永远 running | 翻成 error,输出"已取消" |
| 事件流 | 🔴 该 toolCallId 无 tool-result | 补一条 error tool-result |
| finish.toolCalls | 🔴 不含这次调用 | 含,status=error |

DSH 的对照证据:它的 `run_code` 是 codeMode 单工具,abort 被捕获为该工具的
失败结果回吐(`Error: code run failed (abort)`),SUBTOOL 卡片随即翻 error。
Eva 走的是 streamText 工具循环,abort chunk 直接终止 step,在飞结果被 SDK 丢弃
—— 差距不在工具层,在循环收口。

### 1.1 根因(SDK 行为,确认过源码)

`streamText` 外层拉流循环(node_modules/ai/dist/index.js:9347-9384):
`abortSignal.aborted` 时调用内部 `abort()`,enqueue 一个 `{type:"abort"}`
part 后 close;**刚读出但还没转发完的 tool-result 值直接丢弃**。
agent.ts 的 `mapStreamPart` 收到 abort part → `{aborted:true}` → break →
finish(aborted)。整条路径没有任何位置再碰那个 toolCallId。

`ToolCallClock`(stream-part-mapper.ts:11)在 tool-call 时打点、tool-result
时销点 —— **break 时 clock 里剩下的 entry 就是在飞调用集合**,这是现成的、
唯一权威的在飞清单,不需要新状态。

## 2. 改动

唯一改动点:`packages/harness/src/agents/agent.ts` 的 abort 收口段
(现 `if (aborted) { yield this.finish(...) }` 之前),加一个
`yieldCanceledToolResults(clock, toolCalls)` 生成器:

1. **遍历 clock 剩余 entry**(FIFO 序 = 发起序),每个 toolCallId:
   - 构造 `output = "[Tool Error] Command canceled (run aborted)."`
     (沿用 TOOL_ERROR_PREFIX,卡片现有 `[Tool Error]` 样式直接命中;
     不带命令摘要 —— 此处在循环层,拿不到也不该懂 bash 的入参)
   - yield `tool-result` 事件(status=error,durationMs=此刻-打点)
   - push `AgentToolCallResult` 进 `toolCalls`(进 finish 汇总)
   - emit `tool_call_completed` 观测事件(与正常 result 路径对齐,
     status=error)
   - `clock.delete(toolCallId)`(幂等:即便 SDK 未来版本不再丢弃,
     晚到的真 result 也不会二次入 toolCalls —— 见坑 2)
2. 然后才 yield finish(aborted)。

tool-result 事件的 `toolName` 字段:clock 只有 id→时间,**在 mapStreamPart
的 tool-call case 旁边补一个 `toolNames: Map<string,string>`** 一并记名,
收口时查表。两个 Map 同生同灭,合并成一个 `Map<id,{startedAt,toolName}>`
亦可,实现时取更顺手的。

## 3. 验收(✅ 已落地)

自动化(tests/lead-agent-loop.test.ts,describe "abort 在飞工具收口(T26)",
3 个用例全绿;移除实验:摘掉补发段 → 用例 1、3 转红,恢复后 442 全绿):

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | 工具在飞时 abort → 消费到 finish | 在 finish(aborted) **之前**出现 tool-result:toolCallId=tc-1、status=error、output 以 `[Tool Error]` 开头;finish.toolCalls 含 tc-1 且 status=error |
| 2 | 无在飞工具时 abort(纯文本流中途) | 不多发任何 tool-result;finish(aborted) 与现状一致(现有 abort 用例不回归) |
| 3 | 移除实验:注释掉补发段 → 用例 1 红 | 证明断言真的在守这段逻辑 |
| 4 | 两个并发在飞工具(模型一步发两个 tool-call)→ abort | 两条 tool-result 都补,顺序 = tool-call 发起序 |

E2E(页面):`bash: sleep 300 && echo done` 跑到一半点停止 ——
工具卡片翻 error、输出"[Tool Error] Command canceled (run aborted).";
刷新会话后卡片仍是 error(不是 running),因为补发事件进了
UiMessageBuilder,落库 part 为 output-error。

## 4. 边界与坑

1. **模型不会看到这条取消结果**(本轮):abort 后循环 return,没有再发起
   model 调用;补发纯粹为 UI/事件流/落库。下一轮(regenerate/继续发消息)
   走 `convertToModelMessages({ignoreIncompleteToolCalls:true})`
   (run-preparation.ts:191),output-error part 是"完整"的,会带着
   errorText 进模型历史 —— 这**符合预期**:模型应知道自己上一轮被打断,
   而不是以为工具成功了。若后续不想要这行为,在 stripReasoningParts 同款
   位置按 errorText 前缀过滤即可,不在本任务范围。
2. **幂等**:SDK 若未来修复"丢弃在飞 result",真 result 会在补发之后到达。
   补发时 delete 掉 clock entry,晚到的真 result 走 tool-result case 时
   `takeDuration` 拿不到打点返回 0 —— 仍会 push 一次 toolCalls,出现
   同 id 双条。验收以当前 SDK 版本为准;升级 ai 包时若出现双 result,
   在 tool-result case 加"clock 无 entry 且 aborted 已发生则跳过"的守卫。
   现在不写这段守卫(YAGNI,且会给移除实验制造假阴性)。
3. **不在 finish 之后才补**:finish 是 run 的终态帧,server 的 SSE 在
   finish 后收尾,之后的事件客户端收不到。顺序必须是 补发 → finish。
4. **子代理同在飞**:subagent 的 stream 也走同一个 agent.ts 循环,补发
   逻辑天然覆盖;子代理事件经 subagent_update 桥接,不在本任务额外验证。
5. **文案不带命令**:bash 工具自己产生的取消文案带命令摘要
   (`Command canceled (sleep 300…)`),那是工具层能看到的入参;循环层
   补发是协议层兜底,统一固定文案,不逐工具定制。
6. **durationMs 会偏长**:补发时刻 - tool-call 打点,包含了用户犹豫要不要
   点停止的时间。这是真实墙钟,不算 bug;观测上反而能看出"这个工具等了
   多久才被取消"。

## 5. 不做

- 不改 SDK、不 patch node_modules。
- 不动 abort 后"agent 不再说话"的语义(那是正确的:用户说了停)。
- 不做前端单独的 running 卡片兜底翻转 —— 有了补发,前端零改动。
- 不处理"工具忽略了 abortSignal 还在后台跑"的孤儿(T25 已分别收口:
  bash 组杀、web 信号合并、其余靠 toolMs race)。
