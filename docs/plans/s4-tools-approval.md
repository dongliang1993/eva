# S4 · 工具系统 + 审批闸门技术方案

> 目标：给 eva 的 agent 装上「文件系统工具」（Bash/Write/Edit/Read）+ 危险工具审批闸门，并落地 tool-overflow，复用现有 harness/Vercel AI SDK 管线。
> 对应 landing-plan §S4（docs/architecture/11-landing-plan.md:103）+ 04-model-adapter-agent-harness §5/§7。

---

## 1. 现状

| 面 | 现状 |
|---|---|
| 工具系统 | harness `packages/harness/src/tools.ts`：`AgentTool = { name, tool, readOnly? }`,经 `buildTool` 包成 ai `tool()`；`toToolSet` 生成 `Record<name, Tool>` 喂 `streamText` |
| 现有工具 | 全**只读**：`web-search` / `web-fetch` / `memory`(search/save) / `task`(子代理)。**没有文件系统写工具** |
| agent loop | `LeadAgent`(lead-agent.ts) 手动外循环，每步 `streamText` + 消费 `result.stream`。已处理 `tool-result` 的 `execution-denied` 输出类型(第 89 行) |
| 信任模型 | 04 §5.2：**本机进程=自己人**，审批只防「AI 乱来」，不防「本机其他进程」 |

---

## 2. 决策：用 Vercel AI SDK 原生审批，不自造 WS 闸门

docs 伪代码(04 §7 代码 5)手写了一层 `withApproval` 高阶函数 + WS `askUserApproval`。**eva 不这么做**，因为 Vercel AI SDK v5 已是原生支持：

- `tool({ ..., needsApproval })` —— 工具级审批标记（provider-utils `Tool.needsApproval`）
- `streamText({ toolApproval })` —— `ToolApprovalConfiguration`，工具执行前的审批 hook（ai@7.0.64 导出）
- 审批结果经 `ToolResultPart.output: { type: "execution-denied" }` 返回给模型 —— **lead-agent 已处理该状态**(第 89 行) → 模型能感知「工具被拒」并继续

**收益**：不重建 WS 审批通道、不维护自造的 approvals 时序；审批交互复用 eva 已有的 HTTP/SSE 管线。
**取舍**：SDK 的 `toolApproval` 是「执行前 hook」而非「可中断的跨进程审批」。eva 的本机信任模型下，审批只须「弹窗 → 等用户点」—— 用 async 的 `toolApproval` 停住等决策即可，够用。

> ⚠️ 一个待落地时小验证：`toolApproval` 函数是否在 agent loop 每步被调用、async 等待是否阻塞 streamText。若 SDK 审批的等待模型不满足 eva 局,退回「`withApproval` 包一层」兜底(见 §6.2)。

---

## 3. 目标(承接 landing 4 项验收)

- [ ] 说「在我工作区建 hello.txt 写首诗」→ 真建了
- [ ] Bash/Write/Edit 执行前弹审批，允许才执行
- [ ] 超长 Bash 输出落盘 tool-overflow，消息里只有摘要 + 路径
- [ ] agent loop 多步工具调用可见（step 内 tool-call/result part）

---

## 4. 工具落建（`packages/harness/src/tools/fs/`）

新增文件系统工具（**dangerous 一组** + **readonly 一组**），Vecercel `tool` 定义,读文件读目录无需审批，写/执行须审批。

| 工具 | 类型 | 作用 | needsApproval |
|---|---|---|---|
| `read_file` | readonly | 读取指定路径文件(带 offset/limit) | 否 |
| `list_dir` | readonly | 列目录 | 否 |
| `grep`(可选) | readonly | 文本搜索 | 否 |
| `write` | dangerous | 写文件(可创建/覆盖,带 append) | ✅ |
| `edit` | dangerous | mini 精确替换(基于 sed) | ✅ |
| `bash` | dangerous | 执行 shell 命令(注入 shell) | ✅ |

- 每个工具用 `buildTool` 包装(统一 `[Tool Error]` 前缀、inputSchema zod)。
- **执行环境约束**：`bash`/`write`/`edit` 的落点限在「工作区目录」(cwd + 用户 granted 的 root), via `resolveWorkspacePath` 阻止 `../` 逃逸(security 强制)。
- `readOnly` / `dangerous` 都记在 `AgentTool` / `ToolDefinition` 上(harness tools.ts 已有 `readOnly`,补 `requiresApproval`)。

**工作区约束**(`resolveWorkspacePath(path, root)`):拒绝 `..`,解析后校验前缀,否则抛错——防 agent 写越界。

---

## 5. 审批闸门：SDK `toolApproval` + eva 决策层

```ts
// 组装时给 streamText 注入审批策略(lead-agent.ts 的 runSingleStep→toToolSet 处)
toolApproval: async ({ toolName, toolCallId, input, ... }, info) => {
  if (settings.security.autoApproveToolRequests) return true;           // 用户设了"自动允许工具"
  const decided = await askUserForToolApproval({ tool: toolName, args: input, toolCallId });
  return decided;                                                       // true=允许 Or false/拒绝
}
```

- **决策来源** `askUserForToolApproval`：把审批请求持久化到 db `approvals` 表(状态 pending/批/拒)并支撑「用户点按钮」→ 前端经 `/api/v1/tool-approvals/:callId` 提交。实现成一个可注入的 `Approver`(测试可 mock, 生产走 SSE/poll)。
- **审批记录**(`approvals` 表)`tool, args(JSON), call_id, thread_id, decided_by, decided_at, decision(pending|granted|denied)` —— 审计,对应 docs plugin_permissions 精神。
- **决策后**把 ok 返回给 `toolApproval` → SDK 执行「继续」或「execution-denied」。

### 6. tool-overflow（30 行，04 §2.3 必做）

当一个工具输出超过阈值(如 4k 字符):

```
写文件到 <workspace>/.eva/tool-output/<tool>-<callid>.txt
返回给模型: [太长,全文已存 <path>;用 read <path> offset/limit 读取,不要重复抓取]
```

实现成一个 **`maybeOverflow(name, text)` helper**,包在 `bash`/`read`/`write` 的 execute 外层。消息的红色(thread 可视化)+ 后续 agent 用 `read` 续读 —— 一举解决「单条工具输出爆 context」。

---

## 7. 落地步骤(按序)

1. **harness 基建**: `tools.ts` 加 `dangerous`/`requiresApproval` 字段;`buildTool` 透传 `requiresApproval → tool({ needsApproval })`。
2. **fs 工具**: 新建 `tools/fs/`(read/list/grep/write/edit/bash) + 工作区路径沙盒 `resolveWorkspacePath`。
3. **tool-overflow**: `maybeOverflow` helper + 各危险/大输出工具接入。
4. **approvals 存储**: 建 `approvals` 表(migration) + `ApprovalStore`(create/get/update)。
5. **审批网关**: `ApproachGateway.ask(tool,args,threadId)→Promise<boolean>`;默认实现落 db + 暴露 HTTP 决策接口;`autoApprove` 短路。
6. **lead-agent 接线**: 在 `runSingleStep` 传 `toolApproval: gateway.checkApproval`;`tools` 从 `AgentTool[]` 收集时按 `requiresApproval` 打标。
7. **agent.ts 组装**: `createConfiguredAgent` 注入 fs tools + 从 settings 读 `security`(autoApprove 等)。
8. **前端 UI**: 工具执行前弹审批卡(允许/拒绝/始终允许)→ 打 `streamChat` 的时刻。新增 `tool-approval` SSE 事件 + 前端审批按钮(可选,受 `info 权限`).
9. **验证** + 测试。

---

## 8. 风险 / 待验证

- **async toolApproval 等待模型**: SDK v5 的 `toolApproval` 是否同步等用户(异步函数)且不超时。若不行,退「withApproval 包工具、execute 里 await askUserApproval」(docs 伪码) —— 两个方案都要。
- **approvals 表迁移**: 建表 + 现有 db 升级路径(与 S2 存储重配合并节奏)。
- **工作区沙盒**: mac 权限(如访问外部盘的 TCC 弹窗)不计入审批。
- **多轮审批的并发**: 两个 tool call 同时触发审批,ApprovalGateway 需按 `callId` 去重/排队。

---

## 9. 不做(scope 外)

- 不做扩展插件(plugin_permissions 全套归 S6 EH)。
- 不做 CLI/桌面自动授权偏好(仅 `security.autoApproveToolRequests` 布尔)。