# T18 · repairToolCall：schema 不匹配自动修复

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.3、§3。
> 施工图：`docs/architecture/04-model-adapter-agent-harness.md` §8.4.2（`repairToolCall: yg` 参数行）。

**建议 1 个 commit**：`feat(harness)`。

---

## 1. 问题实证

### 1.1 一次入参校验失败 = 一整圈白烧

`streamText` 收到模型的 tool call 后按工具的 input schema 校验入参。校验失败时 SDK 的行为取决于有没有 `repairToolCall`：

- **有**：调修复函数 → 修好就当正常 tool call 继续执行；返回 `null` 才报错。
- **没有（Eva 现状，`lead-agent.ts:236` 的参数表查无此项）**：直接产出 `error` part，这个 tool call 报废。模型下一轮看到的是"工具调用失败"的错误消息，要**再烧一整圈**重新组织调用 —— 弱模型经常修不好第二次，连炸三轮然后放弃。

Alma 在每个 `streamText` 上都挂了 `repairToolCall: yg`（`docs 04 §8.4` 实锤参数表），理由同一节：schema 不匹配是"工具使用最常见的失败"，不修就是把最常见的失败变成最贵的失败。

### 1.2 SDK 侧已就绪

`ai` 包正式导出（非 experimental）：

```
grep -c repairToolCall node_modules/ai/dist/index.d.ts → 16
ToolCallRepairFunction<TOOLS>(options: {
  instructions, messages, toolCall, tools,
  inputSchema: ({toolName}) => PromiseLike<JSONSchema7>,
  error: NoSuchToolError | InvalidToolInputError
}) => Promise<LanguageModelV4ToolCall | null>
```

两类错误语义不同（`node_modules/ai/dist/index.d.ts:3036/3050`）：

- `InvalidToolInputError`：工具存在，入参不符 schema —— **可修**。
- `NoSuchToolError`：工具名本身就是编的 —— 修入参无意义，但可以修**工具名**（模型把 `read_file` 写成 `readFile` 是真实高频错误）。

### 1.3 修复用什么模型

修复是一次结构化小生成（"给你 schema 和错误，重出合法入参"），正是 **tool 槽位**的用途（R2 T7 建的槽位，定义就是"对话标题生成、记忆相关操作等自动化任务"）。用 chat 模型修是拿大炮打蚊子，还慢。

---

## 2. 目标设计

### 2.1 修复策略：一次重生成，两个错误类分开处理

```ts
// packages/harness/src/agents/repair-tool-call.ts

/**
 * tool call 修复器(docs 04 §8.4 的 yg 同款)。
 *
 * 为什么用 generateText 而不是把错误塞回主 loop:主 loop 的重试是一整圈
 * (全部上下文 + 全部工具定义重发),修复只需要"schema + 错误 + 原入参"
 * 三样东西,一次小生成解决。tool 槽位模型就是为这种结构化杂务准备的。
 *
 * 只修一次:SDK 对同一个 tool call 只调一次本函数,返回 null 才把错误
 * 还给模型 —— 不在这里自建重试循环,修不好就让它报错,主 loop 下一轮
 * 看到的是一条明确的工具错误,比反复修复便宜且可观测。
 */
export const createRepairToolCall = (options: {
  readonly repairModel: LanguageModel;
}): ToolCallRepairFunction<ToolSet> => async ({ toolCall, tools, inputSchema, error }) => {
  // NoSuchToolError:工具名是编的。尝试把它修成真实存在的工具名;
  // 修不了名字就返回 null(入参修得再好也没用)。
  if (NoSuchToolError.isInstance(error)) {
    return repairToolName(toolCall, tools);
  }

  // InvalidToolInputError:名字对、入参错。让 tool 模型按 schema 重出入参。
  const schema = await inputSchema({ toolName: toolCall.toolName });
  const repaired = await generateText({
    model: options.repairModel,
    prompt: buildRepairPrompt(toolCall, schema, error)
  });

  const parsed = parseJsonObject(repaired.text);
  if (parsed === undefined) return null;   // 修复模型也没给出合法 JSON → 报错
  return { ...toolCall, input: JSON.stringify(parsed) };
};
```

`repairToolName` 是**纯字符串修复**（不调模型）：在 `Object.keys(tools)` 里找编辑距离 ≤ 2 或忽略大小写/下划线后相等的名字，唯一命中才修，多歧义就 `null`。这类错误（`readFile` vs `read_file`）用模型修是杀鸡用牛刀，还容易修歪。

`buildRepairPrompt` 的要素（照 Alma 修复器的通行形态）：

```
You are fixing a tool call whose arguments failed schema validation.
Tool: <toolCall.toolName>
Schema: <JSON.stringify(schema)>
Invalid arguments: <toolCall.input>
Validation error: <error.message>
Respond with ONLY the corrected arguments as a JSON object. No markdown fence, no explanation.
```

### 2.2 接线：`LeadAgent` 拿得到 `repairModel`

`LeadAgentOptions` 加可选 `repairModel?: LanguageModel`；`streamText` 调用加条件展开：

```ts
...(this.options.repairModel !== undefined
  ? { repairToolCall: createRepairToolCall({ repairModel: this.options.repairModel }) }
  : {}),
```

**可选而不是必填**：harness 的测试与最小场景（无 tool 槽位概念）不该被强制塞一个模型。不传 = 维持现状（SDK 默认无修复），传了才修。

穿透链：

```
agent-factory.build()       → createAgent({ ..., repairModel: this.getModel(models.tool) })
agent-factory.buildSubagent → createAgent({ ..., repairModel: this.getModel(models.tool) })
create-agent.ts             → new LeadAgent({ ..., ...(repairModel ? { repairModel } : {}) })
```

子代理同步修复 —— 子代理用的本来就是 tool 槽位模型（往往更弱），弱模型更需要修复器。

### 2.3 可观测：修复进 observer

修复不是免费操作（一次额外模型调用），得能看见。`AgentObserver` 事件联合加：

```ts
{ type: "tool_call_repaired", step: number, toolName: string, kind: "name" | "input" }
```

在 `createRepairToolCall` 成功返回非 null 前 emit（repair 函数里通过闭包拿 observer）。失败（返回 null）不 emit —— 那会有 `error` 事件收尾，不重复。

### 2.4 不做

- **多轮修复**（修不好再修一次）。SDK 语义就是一次，自建循环会无限烧。
- **修复失败的模型降级链**（tool 修不好换 chat 修）。修复失败率若高到要降级，该换的是生成 tool call 的模型，不是加修复层数。
- **`experimental_repairToolCall`（deprecated 别名）**。直接用正式名。

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `packages/harness/src/agents/repair-tool-call.ts` | `createRepairToolCall` + `repairToolName`（纯函数，可单测）+ `buildRepairPrompt` |
| `tests/repair-tool-call.test.ts` | 名称修复（大小写/下划线/编辑距离/歧义不修）；输入修复（修好/修坏返回 null）；observer 事件 |

### 修改
| 文件 | 动作 |
|---|---|
| `packages/harness/src/agents/observer.ts` | 事件联合加 `tool_call_repaired` |
| `packages/harness/src/agents/types.ts` | `CreateAgentOptions` / `LeadAgentOptions` 加 `repairModel?: LanguageModel` |
| `packages/harness/src/agents/lead-agent.ts` | `streamText` 加 `repairToolCall`（条件展开）；repair 成功时 emit observer 事件 |
| `packages/harness/src/agents/create-agent.ts` | 透传 `repairModel` |
| `packages/harness/src/index.ts` | 导出 `createRepairToolCall`（测试直接用） |
| `apps/server/src/services/agent-factory.ts` | `build()` / `buildSubagent()` 传 `repairModel: this.getModel(models.tool)` |

---

## 4. 步骤

### Step 1 · 【测试先行】`repairToolName` 纯函数

`tests/repair-tool-call.test.ts`：

- `readFile` → 命中 `read_file`（下划线差异）；
- `READ_FILE` → 命中（大小写）；
- `read_fil` → 命中（编辑距离 1）；
- `read` → 同时接近 `read_file` 与 `read_skill` 时**不修**（歧义返回 null）；
- `nonexistent_tool_xyz` → null。

实现后 GREEN。

### Step 2 · 【测试先行】输入修复 + observer

用 `MockLanguageModelV4` 当 repairModel（`generateText` 也能被 mock —— 它是同一个 `LanguageModel` 接口的 `doGenerate`）：

- 修复模型返回合法 JSON → 修复函数返回的 toolCall `input` 被替换，`toolCallId`/`toolName` 原样保留；
- 修复模型返回散文（非 JSON / 带 markdown fence 但可剥离）→ `parseJsonObject` 容忍 fence；纯散文 → 返回 null；
- 修复成功 → observer 收到 `tool_call_repaired`（kind: "input"）；返回 null → 无此事件。

### Step 3 · 端到端：streamText 接线

`lead-agent.ts` 的 `streamText` 加条件 `repairToolCall`。测试复用 Step 2 的搭法，让主模型第一轮返回一个**入参缺字段的 tool call**（MockLanguageModelV4 可以直接 yield 非法 tool-call part），断言：

- 主模型没再被调（没烧第二圈），工具却执行成功；
- 或修复模型也修不好 → 流里出现 `error` 事件（不是静默吞掉）。

### Step 4 · 穿透 agent-factory

`build()` / `buildSubagent()` 传 `repairModel`。`pnpm typecheck && pnpm test` 全绿。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；`tests/repair-tool-call.test.ts` RED→GREEN
- [ ] 手工：用一个弱模型（如 DeepSeek）连续要求"写文件到 /tmp/x.txt"直到它产出不合法入参 → 服务端日志/observer 看到 `tool_call_repaired`，工具执行成功，**没有**第二圈主模型调用
- [ ] 手工：模型编造工具名（提示词里诱导"用 readFile 工具"）→ 被修成 `read_file` 或报错（不是工具失踪静默失败）
- [ ] `grep -n "repairToolCall" packages/harness/src/agents/lead-agent.ts` 命中

## 6. 坑

1. **修复 prompt 里忘了给 validation error 本体**。只给 schema 不给错误，模型不知道错在哪，修出来的还是错的 —— 实测修复成功率腰斩。`error.message` 必须进 prompt。
2. **`parseJsonObject` 太严格**。修复模型爱包 ```json fence；严格 `JSON.parse` 会把能用的修复结果扔掉。先剥 fence 再 parse，剥完还不行才 null。
3. **`NoSuchToolError` 也丢给模型修**。名字修复用字符串算法够准；调模型修名字既慢又会引入新幻觉（模型可能"修"成一个它以为存在其实不存在的名字）。
4. **observer 在 repair 闭包里不可用时硬穿透**。`createRepairToolCall` 在 `streamText` 参数位构造，observer 从 `this.observer` 闭包拿；若 emit 抛错，照 `LeadAgent.emit` 的既有惯例吞掉（observer 错误永不许打断 loop）。
5. **给 `invoke()` 也接一遍**。`invoke` 内部就是 `run()` → 同一个 `streamText`，接一次就够，别画蛇添足。
