# T1 · UIMessage 整存 + runs 台账 + 契约收敛

> 前置：**T0 四个子任务全部完成并 commit**（本文假设 `AgentFactory` / `AppServices.agents` / `withApproval` / `emit()` 已就位）。
> 读之前先读 `00-overview.md` §1 执行契约。

这是本轮最大的一块，**分 3 个 commit**：

| commit | 覆盖步骤 | 内容 |
|---|---|---|
| 1 | Step 1–4 | 契约（`@eva/shared`）+ 迁移 + 仓储层 |
| 2 | Step 5–7 | 服务层（session / compact / token）+ 路由层 |
| 3 | Step 8–9 | 前端对齐 + 死代码清理 |

每个 **Step** 结束都要 `pnpm typecheck && pnpm test` 绿再往下。

---

## 1. 问题实证

**1.1 同一套解析写了三遍，且序列化编码本身有歧义**

`content` 列存的是自造的 `MessageContentBlock[]`，解析散在三处：

- `apps/server/src/db/repositories/types.ts:49` `parseMessageContent`
- `apps/server/src/services/session.ts:85` `blocksToHistoryContent`
- `apps/web/src/hooks/use-chat.ts:27` `parseStoredContent`（前端抄了 60 行）

而 `serializeMessageContent`（`types.ts:91`）的编码是**有歧义的**：

```ts
if (blocks.length === 1 && blocks[0]!.type === "text") {
  return blocks[0]!.text;      // 单 text block → 裸文本
}
return JSON.stringify(blocks);  // 否则 → JSON 数组
```

用户发一条内容恰好是 `[{"type":"text","text":"x"}]` 的消息，存进去是裸文本，读回来被 `parseMessageContent` 当成 content blocks。这是编码层的信息丢失，不是实现 bug——**用同一个字段区分"是不是 JSON"，就一定会有歧义**。

**1.2 跨轮丢工具上下文（功能缺陷，不是体验问题）**

`apps/server/src/services/session.ts:93-98`：

```ts
case "tool_use":
case "tool_result":
  break;   // Omit tool_use/tool_result from history
```

第二轮开始，模型看不到自己上一轮读过哪个文件、跑过什么命令、结果是什么。对 coding agent 是致命的。

注释给的理由是"暴露原始输出会让 LLM 模仿格式进入无限工具循环"——那是把工具结果**塞进 assistant 文本**导致的病（`stripToolMarkers` 正则擦 `[Called tool: ...]` 就是这个病的疤）。现在有原生 `tool` role 消息，根本不该这么治。根因是「消息存成 string」这个模型本身。

**1.3 `/runs` 的 `messages[]` 契约是假象**

`apps/server/src/types/runs.ts:46` 收一个完整 messages 数组，还兼容 `human/ai/function/generic/remove` 五个 LangChain 遗留 role；然后 `routes/runs.ts:110` 用服务端历史**整个覆盖掉**，只从客户端消息里取最后一条的 content（`extractUserContent`）。

实际契约是「只收一句话」。宽松 schema 在这里纯粹是 bug 温床。附带的不一致：`maxSteps` 客户端上限 12、agent 实配 25；`context` 字段客户端从来不传。

**1.4 Run 不是一等概念，执行元信息全部丢失**

- `sessions.model` 只记最后一次用的模型，无法回答"上周那条回复是哪个模型生成的"；
- `messages.token_usage` 列**从来没被写过**——`routes/runs.ts:134` 和 `:220` 两处 `recordAssistantResult(...)` 传的 tokenUsage 都是 `undefined`，全仓库唯一写它的地方是 `tests/session.test.ts:275`；
- finishReason 只有 `aborted` 时以 `{aborted:true}` 落进 metadata，`error` / `max-steps` 全丢；
- 进程崩在流中间时，没有任何痕迹说明"有一次执行没跑完"。

docs 14 §5.1 明确要求「Run 提为一等概念」，§7.2 的目标 schema 里却漏了 `runs` 表（这是 T4 要修的文档缺口之一，T1 先把表建出来）。

---

## 2. 目标设计

### 2.1 一句话

`messages.message` 列存**整个 AI SDK `UIMessage` JSON**，server / web / harness 共用 `@eva/shared` 里的同一个类型和同一个 builder，读写零转换。

### 2.2 数据流

```
写入：
  流事件 (RunAgentStreamEvent)
    → UiMessageBuilder.push()            ← @eva/shared，server 与 web 共用
    → build() → EvaUIMessage
    → messages.message = JSON.stringify(msg)

读取（喂模型）：
  messages.message → JSON.parse → EvaUIMessage[]
    → convertToModelMessages(msgs, { ignoreIncompleteToolCalls: true })
    → ModelMessage[]（含原生 tool role 消息）→ agent
  compaction 摘要作为一条 system ModelMessage 前置（不进 UIMessage）

读取（渲染）：
  GET /threads/:id/messages → EvaUIMessage[] → 按 parts 顺序渲染
```

### 2.3 三个关键决策

**决策 1 · `UiMessageBuilder` 放在 `@eva/shared`，server 与 web 共用一份实现。**
server 用它把流事件累积成待落库的消息；web 用它把同一份流事件累积成待渲染的消息。两边的结果必须逐字节一致——所以只能有一份实现。这是本任务叫"契约收敛"的核心。

**决策 2 · 保留 `POST /api/v1/runs/stream` 路径，只收紧 body。**
`00-overview` 引用的 review 里提过改成 `POST /threads/:id/messages`；**这里推翻它**：新会话时客户端没有 threadId，改成消息资源要么多一次 `POST /threads` 往返、要么允许空 id 段；而 run 本来就是"执行"资源，abort 端点已经是 `/runs/:runId/abort`。保持路径、把 body 收成 `{ text, sessionId?, modelId? }` 是更小且语义自洽的改动。

**决策 3 · `runs` 行在 POST 时立即创建，不做 docs 14 §5.4 的"懒开启"。**
懒开启是 WeaveLynx 为「输入先 buffer、可能永远进不了模型」设计的；Eva 的 POST 必然触发一次模型调用，立即创建不会产生空 run，还能让"服务崩在流中间"留下 `status='running'` 的痕迹（进程重启时收成 `error`）。

### 2.4 明确不做

- **reasoning 不落库**。没有 `providerMetadata` / signature 的 reasoning 回灌会被部分 provider 拒绝，而我们现在拿不到 signature。reasoning-delta 照常推给前端实时展示，只是不进 `parts`。思考时长走 `metadata.thinkingDurationMs`。
- **版本树只打地基**。`parent_id / slot_id / depth` 三列建出来并按线性链写入，重新生成 / 版本切换的 UI 留到后续切片（`00-overview` §2 已声明）。
- **`usage_records` 表不建**。usage 先进 `runs.usage`，等真有"按模型统计花费"需求再拆表。

---

## 3. 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/shared/package.json` | 改：新增 `dependencies: { "ai": "^7.0.64" }` |
| `packages/shared/src/ui-message.ts` | 新增：`EvaUIMessage` 类型 + 纯函数 |
| `packages/shared/src/ui-message-builder.ts` | 新增：`UiMessageBuilder` |
| `packages/shared/src/index.ts` | 改：re-export 上面两个；`ThreadMessage` 改形状 |
| `apps/server/src/db/migrations/0014_ui_message_store.sql` | 新增 |
| `apps/server/src/db/migrations/meta/_journal.json` | 改：追加 idx 14 |
| `apps/server/src/db/schema.ts` | 改：`messages` 列重排；新增 `runs` 表 |
| `apps/server/src/db/repositories/types.ts` | 改：删 `MessageContentBlock` 全家；`Message` → `StoredMessage` |
| `apps/server/src/db/repositories/message-repository.ts` | 改：读写 UIMessage |
| `apps/server/src/db/repositories/run-repository.ts` | 新增 |
| `apps/server/src/services/session.ts` | 改：重写（删 3 个私有转换函数） |
| `apps/server/src/services/compact.ts` | 改：摘要从 parts 生成 |
| `apps/server/src/services/auto-compact.ts` | 改：签名去掉 history 参数 |
| `apps/server/src/services/token-estimator.ts` | 改：新增 UIMessage 估算 |
| `apps/server/src/services/memory-runtime.ts` | 改：`modelHistory` 类型 |
| `apps/server/src/types/runs.ts` | 改：schema 收紧（文件大幅缩短） |
| `apps/server/src/routes/runs.ts` | 改：重写 |
| `apps/server/src/routes/threads.ts` | 改：返回 UIMessage |
| `apps/server/src/deps.ts` | 改：启动时 `failStale()` |
| `apps/web/src/types/api.ts` | 改：走 `@eva/shared` |
| `apps/web/src/api/client.ts` | 改：回调收敛成 `onEvent` |
| `apps/web/src/hooks/use-chat.ts` | 改：状态换成 `EvaUIMessage[]`，删 `parseStoredContent` |
| `apps/web/src/components/message-bubble.tsx` | 改：按 parts 渲染 |
| `apps/web/src/components/{message-list,chat-view}.tsx` | 改：props 类型 |
| `tests/session.test.ts` | 改：重写断言 |
| `tests/ui-message.test.ts` | 新增 |
| `tests/run-lifecycle.test.ts` | 新增 |

---

## 4. 步骤

### Step 1 · `@eva/shared` 定义消息契约

**1a. `packages/shared/package.json` 加依赖**

`@eva/shared` 现在没有 `dependencies` 字段。加上：

```json
"dependencies": {
  "ai": "^7.0.64"
}
```

然后 `pnpm install`。

> 为什么必须显式声明：`apps/web/node_modules/` 下没有 `ai`，web 侧的类型是靠"从 `@eva/shared` 的源文件出发解析 `ai`"拿到的。声明后 pnpm 会建 `packages/shared/node_modules/ai`，解析确定性。web 侧不需要加 `ai`（`import type` 会被完全擦除，Vite 看不到它）。

**1b. 新建 `packages/shared/src/ui-message.ts`**

```ts
import type { UIMessage } from "ai";

import type { StreamTokenUsage } from "./stream-events.js";

/**
 * 消息级 metadata —— 与 UIMessage 一起整存在 `messages.message` 列里。
 * 不再有独立的 metadata / token_usage 列：一条消息只有一个事实源。
 */
export interface EvaMessageMetadata {
  /** 产生这条消息的 run（user 消息也带，便于按 run 回溯整轮）。 */
  readonly runId?: string;
  /** "providerId:modelId"。仅 assistant 消息有。 */
  readonly model?: string;
  /** 首个 text-delta 之前的等待时长（UI 的 "Thought for Xs"）。 */
  readonly thinkingDurationMs?: number;
  /** 从 run 开始到消息完成的墙钟耗时。 */
  readonly durationMs?: number;
  readonly usage?: StreamTokenUsage;
  /** 该消息因 abort 提前结束 —— parts 可能不完整。 */
  readonly aborted?: boolean;
}

/**
 * Eva 的消息表示 = AI SDK UIMessage。
 *
 * 为什么不自造中间表示：自造的 MessageContentBlock 需要在"落库/还原历史/渲染"
 * 三处各写一份解析，且工具轨迹无法无损还原成模型可见的 tool role 消息。
 * UIMessage 能被 convertToModelMessages 直接消费，读写零转换。
 */
export type EvaUIMessage = UIMessage<EvaMessageMetadata>;

export type EvaUIMessagePart = EvaUIMessage["parts"][number];

export type EvaTextPart = Extract<EvaUIMessagePart, { type: "text" }>;
export type EvaDynamicToolPart = Extract<EvaUIMessagePart, { type: "dynamic-tool" }>;

export const isTextPart = (part: EvaUIMessagePart): part is EvaTextPart =>
  part.type === "text";

/**
 * harness 的工具全部是运行时注册的，AI SDK 侧对应 `dynamic-tool` part
 * （而不是静态工具的 `tool-<NAME>`）。
 */
export const isDynamicToolPart = (
  part: EvaUIMessagePart
): part is EvaDynamicToolPart => part.type === "dynamic-tool";

export const createUserUIMessage = (
  id: string,
  text: string,
  metadata?: EvaMessageMetadata
): EvaUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text, state: "done" }],
  ...(metadata !== undefined ? { metadata } : {})
});

/** parts 里的正文拼接（会话标题、token 估算、记忆检索用）。 */
export const uiMessageText = (message: EvaUIMessage): string =>
  message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();

/** dynamic-tool part 的输出（无输出时返回空串）。 */
export const toolPartOutput = (part: EvaDynamicToolPart): string => {
  if (part.state === "output-available") {
    return typeof part.output === "string"
      ? part.output
      : JSON.stringify(part.output);
  }

  if (part.state === "output-error") {
    return part.errorText;
  }

  return "";
};

/**
 * 工具输出进 FTS 索引的长度上限。
 * 沿用旧 extractSearchText 的 1000 字符 —— 超过这个长度的多半是文件全文/网页
 * 正文，进索引只会稀释 rank。
 */
const TOOL_OUTPUT_SEARCH_LIMIT = 1000;

/** `messages.search_text` 列的值（FTS5 索引源）。 */
export const uiMessageSearchText = (message: EvaUIMessage): string => {
  const chunks: string[] = [];

  for (const part of message.parts) {
    if (isTextPart(part)) {
      chunks.push(part.text);
      continue;
    }

    if (isDynamicToolPart(part) && part.state === "output-available") {
      const output = toolPartOutput(part);

      if (output.length <= TOOL_OUTPUT_SEARCH_LIMIT) {
        chunks.push(output);
      }
    }
  }

  return chunks.join(" ").trim();
};

/**
 * 解析 `messages.message` 列。
 * 解析失败/形状不对时降级成单 text part —— 历史脏数据不该让整条会话打不开。
 */
export const parseUIMessage = (
  raw: string,
  fallback: { id: string; role: "user" | "assistant" }
): EvaUIMessage => {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === "object"
      && parsed !== null
      && Array.isArray((parsed as { parts?: unknown }).parts)
    ) {
      return parsed as EvaUIMessage;
    }
  } catch {
    // 落到下面的降级分支
  }

  return {
    id: fallback.id,
    role: fallback.role,
    parts: [{ type: "text", text: raw, state: "done" }]
  };
};
```

**1c. `packages/shared/src/index.ts` 尾部加 re-export**

```ts
export * from "./ui-message.js";
export * from "./ui-message-builder.js";
```

同时把 `ThreadMessage` 改成（`content: string` → `message: EvaUIMessage`）：

```ts
export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  message: EvaUIMessage;
  runId: string | null;
  createdAt: string;
}
```

> 注意 `index.ts` 顶部要 `import type { EvaUIMessage } from "./ui-message.js";`。

**1d. 新建 `packages/shared/src/ui-message-builder.ts`**

```ts
import type { RunAgentStreamEvent, StreamTokenUsage } from "./stream-events.js";
import type {
  EvaDynamicToolPart,
  EvaMessageMetadata,
  EvaUIMessage,
  EvaUIMessagePart
} from "./ui-message.js";

/**
 * 把 harness 的流事件累积成一条 assistant UIMessage。
 *
 * server 用它产出待落库的消息，web 用它产出待渲染的消息 —— 两边必须逐字节
 * 一致，所以只能有一份实现，放在 shared。
 *
 * 【T2 注意】等 LeadAgent 收敛成 streamText + stopWhen 之后，server 侧可以
 * 直接用 SDK 的 onFinish/toUIMessageStream 拿到原生 UIMessage，届时 server
 * 侧改为直接消费，本 builder 只保留给 web。
 */
export class UiMessageBuilder {
  private readonly parts: EvaUIMessagePart[] = [];
  private readonly toolIndexByCallId = new Map<string, number>();
  private textIndex: number | undefined;
  private readonly startedAt: number;
  private firstTextAt: number | undefined;
  private usage: StreamTokenUsage | undefined;

  constructor(
    private readonly id: string,
    startedAt: number = Date.now()
  ) {
    this.startedAt = startedAt;
  }

  push(event: RunAgentStreamEvent): void {
    switch (event.type) {
      case "step-start":
        this.parts.push({ type: "step-start" });
        // 新 step 起新的 text part：工具调用前后的正文不该被粘成一段。
        this.textIndex = undefined;
        break;

      case "text-delta":
        this.firstTextAt ??= Date.now();
        this.appendText(event.textDelta);
        break;

      case "tool-call":
        this.toolIndexByCallId.set(event.toolCallId, this.parts.length);
        this.parts.push({
          type: "dynamic-tool",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          state: "input-available",
          input: event.input
        });
        // 工具之后的正文另起一段。
        this.textIndex = undefined;
        break;

      case "tool-result":
        this.settleTool(event);
        break;

      case "finish":
        this.usage = event.usage;
        break;

      // reasoning-delta 只推前端不落库（无 signature 的 reasoning 回灌会被
      // 部分 provider 拒绝）；tool-input-start/-delta 是 input 的流式过程，
      // tool-call 会带上完整 input；error 由调用方处理成 metadata。
      default:
        break;
    }
  }

  /** 流式期间取当前快照（每次返回新对象，可直接进 React state）。 */
  snapshot(metadata?: EvaMessageMetadata): EvaUIMessage {
    return {
      id: this.id,
      role: "assistant",
      parts: [...this.parts],
      metadata: { ...this.derivedMetadata(), ...metadata }
    };
  }

  /** 终态：把仍在 streaming 的 text part 收成 done。 */
  build(metadata?: EvaMessageMetadata): EvaUIMessage {
    const parts = this.parts.map((part) =>
      part.type === "text" && part.state === "streaming"
        ? { ...part, state: "done" as const }
        : part
    );

    return {
      id: this.id,
      role: "assistant",
      parts,
      metadata: { ...this.derivedMetadata(), ...metadata }
    };
  }

  private derivedMetadata(): EvaMessageMetadata {
    return {
      durationMs: Date.now() - this.startedAt,
      ...(this.firstTextAt !== undefined
        ? { thinkingDurationMs: this.firstTextAt - this.startedAt }
        : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {})
    };
  }

  private appendText(delta: string): void {
    if (this.textIndex === undefined) {
      this.textIndex = this.parts.length;
      this.parts.push({ type: "text", text: delta, state: "streaming" });

      return;
    }

    const current = this.parts[this.textIndex];

    if (current?.type !== "text") {
      return;
    }

    this.parts[this.textIndex] = { ...current, text: current.text + delta };
  }

  private settleTool(event: Extract<RunAgentStreamEvent, { type: "tool-result" }>): void {
    const index = this.toolIndexByCallId.get(event.toolCallId);

    if (index === undefined) {
      return;
    }

    const current = this.parts[index];

    if (current?.type !== "dynamic-tool") {
      return;
    }

    const settled: EvaDynamicToolPart = event.status === "error"
      ? {
        type: "dynamic-tool",
        toolName: current.toolName,
        toolCallId: current.toolCallId,
        state: "output-error",
        input: current.input,
        errorText: event.output,
        ...(event.durationMs !== undefined
          ? { toolMetadata: { durationMs: event.durationMs } }
          : {})
      }
      : {
        type: "dynamic-tool",
        toolName: current.toolName,
        toolCallId: current.toolCallId,
        state: "output-available",
        input: current.input,
        output: event.output,
        ...(event.durationMs !== undefined
          ? { toolMetadata: { durationMs: event.durationMs } }
          : {})
      };

    this.parts[index] = settled;
  }
}
```

> `DynamicToolUIPart` 没有 duration 字段，SDK 给的扩展位是 `toolMetadata?: JSONObject`——耗时放这里，别另开一个非标字段。
> `current.input` 在 `input-available` 之后的状态里类型是 `unknown`，赋值给终态的 `input: unknown` 是合法的；如果 TS 报窄化问题，用 `input: current.input as unknown`。

**1e.【测试先行】`tests/ui-message.test.ts` 的 builder 部分**

```ts
describe("UiMessageBuilder", () => {
  it("按流事件顺序生成 parts：text → tool → text", () => {
    // push: step-start, text-delta("好的"), tool-call, tool-result, text-delta("完成")
    // 断言 parts 的 type 序列是 ["step-start","text","dynamic-tool","text"]
    // 断言两段 text 没有被粘成一段
  });

  it("tool-result 回填到同一个 part 而不是新增", () => {
    // 断言 parts.length 不变，state === "output-available"，output 正确
  });

  it("tool 执行失败落成 output-error + errorText", () => {});

  it("build() 把 streaming 的 text part 收成 done", () => {});

  it("thinkingDurationMs = 首个 text-delta 与 startedAt 的差", () => {
    // 用固定的 startedAt 构造，配合 vi.useFakeTimers()
  });
});
```

同文件里再放纯函数的用例：

```ts
describe("uiMessageSearchText", () => {
  it("包含正文与 ≤1000 字符的成功工具输出", () => {});
  it("排除超长工具输出与失败工具输出", () => {});
});

describe("parseUIMessage", () => {
  it("非 JSON 降级成单 text part", () => {});
  it("内容恰好是 JSON 数组的用户消息不会被误解析", () => {
    // 这是旧 serializeMessageContent 的歧义回归用例
    const raw = JSON.stringify(createUserUIMessage("m1", '[{"type":"text","text":"x"}]'));
    expect(uiMessageText(parseUIMessage(raw, { id: "m1", role: "user" })))
      .toBe('[{"type":"text","text":"x"}]');
  });
});
```

---

### Step 2 · 数据库迁移

**2a. 新建 `apps/server/src/db/migrations/0014_ui_message_store.sql`**

```sql
-- messages: 自造的 content blocks → UIMessage 整存
ALTER TABLE `messages` ADD COLUMN `message` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `run_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `parent_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `slot_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `depth` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 回填：旧行统一降级成单个 text part。
-- assistant 的旧 content 可能是 content-blocks JSON，它的纯文本投影已经在
-- search_text 里（0005 之后写入的都有），用它；user 行直接用 content。
-- 工具轨迹不做还原：旧数据里 tool_use 的入参已经被历史构建丢弃过一轮，
-- 还原出来也不是模型当时看到的东西。
UPDATE `messages`
SET `message` = json_object(
  'id', `id`,
  'role', `role`,
  'parts', json_array(json_object(
    'type', 'text',
    'state', 'done',
    'text', CASE
      WHEN `role` = 'assistant'
        AND json_valid(`content`)
        AND json_type(`content`) = 'array'
      THEN `search_text`
      ELSE `content`
    END
  ))
)
WHERE `message` = '';
--> statement-breakpoint
-- 旧列退场：三列的信息已经并入 message JSON。
-- token_usage 从未被写过（唯一写入点在测试里），metadata 只被 threads 路由
-- 原样回吐给前端、前端从不读。
ALTER TABLE `messages` DROP COLUMN `content`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `metadata`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `token_usage`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_run_id` ON `messages` (`run_id`);
--> statement-breakpoint
-- runs: 一次执行一行（docs 14 §5.1「Run 提为一等概念」）
CREATE TABLE IF NOT EXISTS `runs` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `status` text DEFAULT 'running' NOT NULL,
  `model` text,
  `user_message_id` text,
  `assistant_message_id` text,
  `finish_reason` text,
  `usage` text,
  `error` text,
  `started_at` text DEFAULT (datetime('now')) NOT NULL,
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_session_id` ON `runs` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_status` ON `runs` (`status`);
```

两个要确认的点（都在 Step 2c 的测试里验）：

1. `json_object` 嵌套 `json_array(json_object(...))` 时，SQLite 会保留 JSON subtype、**不**把内层当字符串转义。这是 SQLite ≥3.9 的行为，但必须验。
2. `DROP COLUMN` 要求列没有被触发器/视图/索引引用。`messages_fts_*` 三个触发器只碰 `id / session_id / search_text`，不碰这三列——但同样要验。

**2b. `meta/_journal.json` 追加条目**

`entries` 数组末尾加（`when` 用当前毫秒时间戳）：

```json
{
  "idx": 14,
  "version": "6",
  "when": 1786800000000,
  "tag": "0014_ui_message_store",
  "breakpoints": true
}
```

> 本仓库的迁移是手写 SQL + 手写 journal（`meta/` 只有 0000–0005 的 snapshot，之后都没有）。不要跑 `drizzle-kit generate`，它会按 schema 重新生成一堆不需要的迁移。

**2c.【测试先行】`tests/ui-message.test.ts` 追加迁移守卫**

```ts
describe("0014 迁移", () => {
  it("json_object 嵌套不会被字符串转义", () => {
    const db = initDb({ dbPath: ":memory:" });
    const row = db.get<{ v: string }>(
      sql`SELECT json_object('parts', json_array(json_object('type','text'))) AS v`
    );
    expect(JSON.parse(row!.v).parts[0].type).toBe("text");   // 不是 '{"type":"text"}' 字符串
  });

  it("迁移后 messages 表有 message 列、没有 content 列", () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    const cols = db.all<{ name: string }>(sql`PRAGMA table_info('messages')`)
      .map((c) => c.name);
    expect(cols).toContain("message");
    expect(cols).not.toContain("content");
    expect(cols).not.toContain("token_usage");
  });

  it("FTS 触发器在 message 写入后仍然工作", () => {
    // 建 session + 插一条 message（search_text 非空）→ messages_fts 里查得到
  });
});
```

---

### Step 3 · schema 与仓储层

**3a. `apps/server/src/db/schema.ts`**

`messages` 表改成：

```ts
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    /** 完整 UIMessage JSON —— 这条消息的唯一事实源。 */
    message: text("message").notNull(),
    /** FTS5 索引源，由 uiMessageSearchText(message) 派生。 */
    searchText: text("search_text").notNull().default(""),
    // 版本树三件套（docs 14 §7.2）。T1 只按线性链写入，分支 UI 留到后续切片。
    parentId: text("parent_id"),
    slotId: text("slot_id"),
    depth: integer("depth").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index("idx_messages_session_id").on(table.sessionId),
    index("idx_messages_created_at").on(table.createdAt),
    index("idx_messages_run_id").on(table.runId)
  ]
);

export const runStatuses = ["running", "completed", "aborted", "error"] as const;

export type RunStatus = (typeof runStatuses)[number];

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    status: text("status", { enum: runStatuses }).notNull().default("running"),
    /** "providerId:modelId"。 */
    model: text("model"),
    userMessageId: text("user_message_id"),
    assistantMessageId: text("assistant_message_id"),
    finishReason: text("finish_reason"),
    /** StreamTokenUsage JSON。 */
    usage: text("usage"),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    endedAt: text("ended_at")
  },
  (table) => [
    index("idx_runs_session_id").on(table.sessionId),
    index("idx_runs_status").on(table.status)
  ]
);
```

**3b. `apps/server/src/db/repositories/types.ts`**

**删除**：`MessageContentBlock`、`parseMessageContent`、`extractSearchText`、`serializeMessageContent`、旧 `Message`、旧 `CreateMessageInput`。

**新增**：

```ts
import type { EvaUIMessage } from "@eva/shared";

export interface StoredMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly role: "user" | "assistant";
  readonly message: EvaUIMessage;
  readonly parentId: string | null;
  readonly slotId: string | null;
  readonly depth: number;
  readonly createdAt: string;
}

export interface CreateMessageInput {
  readonly sessionId: string;
  /** 行 id 与 role 都取自 `message` —— 不允许存在两份 id。 */
  readonly message: EvaUIMessage;
  readonly runId?: string;
  readonly parentId?: string;
  readonly slotId?: string;
  readonly depth?: number;
}

export interface IMessageRepository {
  create(input: CreateMessageInput): StoredMessage;
  findBySessionId(
    sessionId: string,
    options?: GetMessagesOptions
  ): readonly StoredMessage[];
  findLastBySessionId(sessionId: string): StoredMessage | undefined;
  deleteBySessionId(sessionId: string): number;
}
```

`Session` / `CreateSessionInput` / `ISessionRepository` 不动。

**3c. `apps/server/src/db/repositories/message-repository.ts`**

```ts
import { asc, desc, eq, sql } from "drizzle-orm";
import { parseUIMessage, uiMessageSearchText } from "@eva/shared";

// ...

const toStored = (row: typeof messages.$inferSelect): StoredMessage => ({
  id: row.id,
  sessionId: row.sessionId,
  runId: row.runId,
  role: row.role,
  message: parseUIMessage(row.message, { id: row.id, role: row.role }),
  parentId: row.parentId,
  slotId: row.slotId,
  depth: row.depth,
  createdAt: row.createdAt
});

export class DrizzleMessageRepository implements IMessageRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateMessageInput): StoredMessage {
    const { message } = input;

    if (message.role !== "user" && message.role !== "assistant") {
      // system 消息不落库：compaction 摘要是运行时拼进 ModelMessage 的。
      throw new Error(`Cannot persist message with role "${message.role}"`);
    }

    this.db
      .insert(messages)
      .values({
        id: message.id,
        sessionId: input.sessionId,
        role: message.role,
        message: JSON.stringify(message),
        searchText: uiMessageSearchText(message),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.slotId !== undefined ? { slotId: input.slotId } : {}),
        ...(input.depth !== undefined ? { depth: input.depth } : {})
      })
      .run();

    return toStored(
      this.db.select().from(messages).where(eq(messages.id, message.id)).get()!
    );
  }

  findBySessionId(sessionId, options = {}): readonly StoredMessage[] {
    // 查询本身不变，末尾 .all().map(toStored)
  }

  findLastBySessionId(sessionId: string): StoredMessage | undefined {
    const row = this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), sql`rowid DESC`)
      .limit(1)
      .get();

    return row ? toStored(row) : undefined;
  }

  // deleteBySessionId 不变
}
```

**3d. 新建 `apps/server/src/db/repositories/run-repository.ts`**

```ts
import { and, desc, eq } from "drizzle-orm";
import type { StreamFinishReason, StreamTokenUsage } from "@eva/shared";

import type { AppDatabase } from "../index.js";
import { runs, type RunStatus } from "../schema.js";

export interface RunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly status: RunStatus;
  readonly model: string | null;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly finishReason: string | null;
  readonly usage: StreamTokenUsage | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface StartRunInput {
  readonly id: string;
  readonly sessionId: string;
  readonly model: string;
  readonly userMessageId: string;
}

export interface SettleRunInput {
  readonly status: Exclude<RunStatus, "running">;
  readonly finishReason?: StreamFinishReason;
  readonly assistantMessageId?: string;
  readonly usage?: StreamTokenUsage;
  readonly error?: string;
}

/** finishReason → run 终态。 */
export const runStatusFor = (reason: StreamFinishReason): Exclude<RunStatus, "running"> => {
  switch (reason) {
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return "completed";
  }
};

export class DrizzleRunRepository {
  constructor(private readonly db: AppDatabase) {}

  start(input: StartRunInput): void { /* insert，status 默认 running */ }

  settle(runId: string, input: SettleRunInput): void {
    this.db
      .update(runs)
      .set({
        status: input.status,
        endedAt: new Date().toISOString(),
        ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
        ...(input.assistantMessageId !== undefined
          ? { assistantMessageId: input.assistantMessageId }
          : {}),
        ...(input.usage !== undefined ? { usage: JSON.stringify(input.usage) } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      })
      .where(eq(runs.id, runId))
      .run();
  }

  findBySessionId(sessionId: string, limit = 50): readonly RunRecord[] { /* ... */ }

  /**
   * 进程启动时把上次没跑完的 run 收成 error。
   * 没有这一步，崩溃留下的 running 行会永远挂着，runs 表就不可信了。
   * @returns 被收尾的数量
   */
  failStale(): number {
    const result = this.db
      .update(runs)
      .set({
        status: "error",
        error: "server restarted while run was in flight",
        endedAt: new Date().toISOString()
      })
      .where(eq(runs.status, "running"))
      .run();

    return result.changes;
  }
}
```

**3e. `deps.ts` 启动时收尾**

`buildInfrastructure()` 里 `migrateDb(db)` 之后加：

```ts
const staleRuns = new DrizzleRunRepository(db).failStale();

if (staleRuns > 0) {
  logger.warn({ staleRuns }, "marked in-flight runs as error after restart");
}
```

> 用 `deps.ts` 已有的 logger；没有就用传进来的 pino 实例。**不要** `console.log`。

---

### Step 4 · commit 1

```
refactor(data): store messages as AI SDK UIMessage and add runs ledger
```

正文写：为什么删掉自造的 content blocks（三处解析 + 编码歧义）、runs 表解决什么、迁移对旧数据的降级策略。

跑 `pnpm typecheck` 会有一批红（服务层还没改）——**这时候不 commit**。正确顺序是：Step 3 改完后立刻做 Step 5 的机械适配让它编译通过，再一起 commit 1。也就是说 commit 1 = Step 1–3 + Step 5 里纯类型适配的部分。**如果拆不干净就把 commit 1 和 2 合并成一个**，别为了凑 commit 数留一个编译不过的提交。

---

### Step 5 · 服务层

**5a. `apps/server/src/services/session.ts` 重写**

删掉 `resultToContentBlocks`、`stripToolMarkers`、`blocksToHistoryContent`、`HistoryMessage`、`buildFullHistory`、`buildHistory`。新的文件骨架：

```ts
import { randomUUID } from "node:crypto";
import type { EvaUIMessage } from "@eva/shared";
import { uiMessageText } from "@eva/shared";

import type { AppDatabase } from "../db/index.js";
import { SessionCompactionRepository } from "../db/repositories/session-compaction-repository.js";
import type {
  IMessageRepository,
  ISessionRepository,
  Session,
  StoredMessage
} from "../db/repositories/types.js";

/** 会话历史的最大条数 —— 超过这个量必然已经 compact 过。 */
const HISTORY_LIMIT = 2000;

/** 会话标题取用户首句的前 N 字。 */
const TITLE_LENGTH = 50;

export interface ModelHistory {
  /** compaction 摘要；存在时由调用方作为一条 system ModelMessage 前置。 */
  readonly summary?: string;
  readonly messages: readonly EvaUIMessage[];
}

export interface ResolvedSession {
  readonly session: Session;
  readonly userMessage: StoredMessage;
  readonly isNew: boolean;
}

export class SessionService {
  constructor(
    private readonly sessions: ISessionRepository,
    private readonly messages: IMessageRepository
  ) {}

  createSession(userMessage: EvaUIMessage, runId?: string): ResolvedSession {
    const session = this.sessions.create({
      id: randomUUID(),
      sessionKey: randomUUID(),
      title: uiMessageText(userMessage).slice(0, TITLE_LENGTH)
    });

    return {
      session,
      userMessage: this.appendUserMessage(session.id, userMessage, runId),
      isNew: true
    };
  }

  continueSession(
    sessionId: string,
    userMessage: EvaUIMessage,
    runId?: string
  ): ResolvedSession | undefined {
    const session = this.sessions.findById(sessionId);

    if (!session) {
      return undefined;
    }

    return {
      session,
      userMessage: this.appendUserMessage(session.id, userMessage, runId),
      isNew: false
    };
  }

  resolveByKey(
    sessionKey: string,
    userMessage: EvaUIMessage,
    origin?: string,
    runId?: string
  ): ResolvedSession { /* 结构同旧版，appendUserMessage 换成新签名 */ }

  /**
   * 模型可见的历史。有 compaction 时返回 [摘要, ...保留的尾部]，
   * 否则返回全量。永远不删库里的消息。
   */
  buildModelHistory(db: AppDatabase, sessionId: string): ModelHistory {
    const all = this.messages.findBySessionId(sessionId, { limit: HISTORY_LIMIT });
    const compaction = new SessionCompactionRepository(db).findBySessionId(sessionId);

    if (!compaction) {
      return { messages: all.map((m) => m.message) };
    }

    const coveredIdx = all.findIndex((m) => m.id === compaction.coveredUntilMessageId);
    const tail = coveredIdx >= 0
      ? all.slice(coveredIdx + 1)
      : all.slice(-compaction.preservedTailMessageCount);

    return {
      summary: compaction.summary,
      messages: tail.map((m) => m.message)
    };
  }

  recordAssistantMessage(
    sessionId: string,
    message: EvaUIMessage,
    runId?: string
  ): StoredMessage {
    const stored = this.append(sessionId, message, runId);
    this.sessions.updateTimestamp(sessionId);

    return stored;
  }

  private appendUserMessage(
    sessionId: string,
    message: EvaUIMessage,
    runId?: string
  ): StoredMessage {
    const stored = this.append(sessionId, message, runId);
    this.sessions.updateTimestamp(sessionId);

    return stored;
  }

  /** 线性链写入版本树三件套：parent = 上一条，depth = 上一条 + 1。 */
  private append(
    sessionId: string,
    message: EvaUIMessage,
    runId?: string
  ): StoredMessage {
    const previous = this.messages.findLastBySessionId(sessionId);

    return this.messages.create({
      sessionId,
      message,
      slotId: randomUUID(),
      depth: previous ? previous.depth + 1 : 0,
      ...(runId !== undefined ? { runId } : {}),
      ...(previous ? { parentId: previous.id } : {})
    });
  }
}
```

> `slotId` 每条消息一个新值：同一对话位置的重生成版本将来共享同一个 slot，现在每条都是自己的 slot（等价于"每个位置只有一个版本"）。

**5b. `apps/server/src/services/token-estimator.ts` 增加 UIMessage 估算**

保留现有 `estimateTokens` / `estimateHistoryTokens`（memory-recall 用的是结构化的 `{content:string}[]`，不动它）。追加：

```ts
import type { EvaUIMessage } from "@eva/shared";
import { isDynamicToolPart, isTextPart, toolPartOutput } from "@eva/shared";

import type { ModelHistory } from "./session.js";

/**
 * 单条 UIMessage 的 token 估算。
 * 工具入参与输出必须计入 —— T1 之前它们被历史构建整个丢掉了，
 * 所以旧的估算值系统性偏低，auto-compact 的阈值实际上从来没准过。
 */
export const estimateUiMessageTokens = (message: EvaUIMessage): number => {
  let total = MESSAGE_OVERHEAD_TOKENS;

  for (const part of message.parts) {
    if (isTextPart(part)) {
      total += estimateTokens(part.text);
      continue;
    }

    if (isDynamicToolPart(part)) {
      total += estimateTokens(JSON.stringify(part.input ?? {}));
      total += estimateTokens(toolPartOutput(part));
    }
  }

  return total;
};

export const estimateModelHistoryTokens = (history: ModelHistory): number => {
  const summaryTokens = history.summary
    ? estimateTokens(history.summary) + MESSAGE_OVERHEAD_TOKENS
    : 0;

  return history.messages.reduce(
    (sum, message) => sum + estimateUiMessageTokens(message),
    summaryTokens
  );
};
```

`MESSAGE_OVERHEAD_TOKENS` 改成 `export const`。

**5c. `apps/server/src/services/compact.ts` 改摘要生成**

`messageToSummaryText(message: Message)` → `(message: StoredMessage)`，内部改成遍历 parts：

```ts
const messageToSummaryText = (message: StoredMessage): string => {
  const chunks: string[] = [];

  for (const part of message.message.parts) {
    if (isTextPart(part)) {
      if (part.text.trim().length > 0) {
        chunks.push(normalizeSummaryText(part.text));
      }
      continue;
    }

    if (isDynamicToolPart(part)) {
      chunks.push(
        normalizeSummaryText(`[${part.toolName}] ${toolPartOutput(part)}`)
      );
    }
  }

  return chunks.join(" ").trim();
};
```

> 旧实现输出的是 `[Called tool: x]` / `[Tool x success: ...]` —— 正是 `stripToolMarkers` 要擦的那个格式。换成 `[toolName] output`，不再制造需要事后擦除的标记。

`estimateHistoryTokens(allMessages)` 两处改成 `allMessages.reduce((s, m) => s + estimateUiMessageTokens(m.message), 0)`；`estimateTokens(summary) + ...tail` 同理。

**5d. `apps/server/src/services/auto-compact.ts` 收签名**

```ts
export const autoCompactIfNeeded = (
  db: AppDatabase,
  sessionId: string,
  config: AutoCompactConfig
): AutoCompactResult => {
  if (!config.enabled) {
    return { compacted: false };
  }

  const sessionService = new SessionService(
    new DrizzleSessionRepository(db),
    new DrizzleMessageRepository(db)
  );
  const history = sessionService.buildModelHistory(db, sessionId);
  const estimatedTokens = estimateModelHistoryTokens(history);
  const messageCount = history.messages.length;

  // ... 阈值判断与 compactSession 调用不变
};
```

> 旧版有个 `existingCompaction ? buildModelHistory() : history` 的双路径，调用方还得先自己拼一份 history 传进来。统一成内部构建，调用方少一个参数、少一次全量读。

**5e. `apps/server/src/services/memory-runtime.ts`**

`BuildMemoryRuntimeSupportOptions.modelHistory` 的类型 `readonly HistoryMessage[]` → `readonly { readonly content: string }[]`（`memory-recall.ts:64` 本来就是这个结构化类型，`HistoryMessage` 只是碰巧满足）。删掉 `import type { HistoryMessage } from "./session.js"`。

调用方（`routes/runs.ts`）传 `history.messages.map((m) => ({ content: uiMessageText(m) }))`。

---

### Step 6 · 路由层

**6a. `apps/server/src/types/runs.ts` 收紧**

整个文件替换成：

```ts
import { z } from "zod";

/** 单条用户输入的长度上限 —— 超过这个量应该走文件附件，不是聊天框。 */
const MAX_TEXT_LENGTH = 100_000;

/**
 * 一次执行的请求体。
 *
 * 旧契约收一个完整 messages 数组（还兼容 5 个 LangChain 遗留 role），
 * 但服务端会用自己的历史整个覆盖掉，只取最后一条的 content —— 实际语义
 * 就是"一句话 + 会话 id"。这里让 schema 说实话。
 */
export const runRequestSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  /** 缺省 = 新建会话，响应的 run_start 帧会带回新 sessionId。 */
  sessionId: z.string().optional(),
  /** "providerId:modelId"；缺省用 settings 里的默认模型。 */
  modelId: z.string().optional()
});

export type RunRequest = z.infer<typeof runRequestSchema>;
```

删除：`runMessageRoleSchema` / `runMessageContentSchema` / `runMessageSchema` / `RunInputMessage` / `RunMessageContent` / `RunMessageRole` / `runSchema` / `RunInput`。

`maxSteps` 从客户端契约里去掉——上限由服务端定（agent 配的是 25，客户端 schema 写的 12，两个数从来没对齐过）。

**6b. `apps/server/src/routes/runs.ts` 重写**

删除 `POST /api/v1/runs/wait`：全仓库没有任何调用方（`grep -rn "runs/wait" apps tests packages` 只匹配到它自己的定义），留着等于要在两条路径上同步维护落库、run 台账和审批闭环。

新的结构：

```ts
import { randomUUID } from "node:crypto";

import { convertToModelMessages, type ModelMessage } from "ai";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestApproval } from "@eva/harness";
import type {
  EvaUIMessage,
  RunStreamEvent,
  RunStreamFrame,
  StreamFinishReason
} from "@eva/shared";
import { UiMessageBuilder, createUserUIMessage, toErrorMessage, uiMessageText } from "@eva/shared";

import { AgentUnavailableError } from "../agent.js";
import type { ResolvedRuntimeModelBinding } from "../agent.js";
import { DrizzleRunRepository, runStatusFor } from "../db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { autoCompactIfNeeded, createAutoCompactConfig } from "../services/auto-compact.js";
import { buildMemoryRuntimeSupport } from "../services/memory-runtime.js";
import { loadAppSettings } from "../services/settings-store.js";
import { runRequestSchema, type RunRequest } from "../types/runs.js";

interface PreparedRun {
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly modelMessages: ModelMessage[];
  readonly additionalTools: AgentTool[];
  readonly context?: Record<string, unknown>;
}

/**
 * 落库用户消息 → 必要时 compact → 组装模型可见的消息序列。
 */
const prepareRun = async (
  app: FastifyInstance,
  body: RunRequest,
  runId: string,
  mainModel: ResolvedRuntimeModelBinding
): Promise<PreparedRun> => {
  const userMessage = createUserUIMessage(randomUUID(), body.text, {
    runId,
    model: mainModel.qualifiedModelId
  });

  const resolved = body.sessionId
    ? app.services.session.continueSession(body.sessionId, userMessage, runId)
    : undefined;

  // sessionId 传了但查不到 → 当成新会话（旧行为，保持）
  const { session, userMessage: storedUser } =
    resolved ?? app.services.session.createSession(userMessage, runId);

  new DrizzleSessionRepository(app.infra.db)
    .updateModel(session.id, mainModel.qualifiedModelId);

  const settings = loadAppSettings(app.infra.db, app.infra.config);
  autoCompactIfNeeded(app.infra.db, session.id, createAutoCompactConfig(settings.chat));

  const history = app.services.session.buildModelHistory(app.infra.db, session.id);

  // ignoreIncompleteToolCalls：上一轮被 abort 时可能留下没有结果的 tool part，
  // 带着它去请求模型会被 provider 拒绝（tool_use 必须有配对的 tool_result）。
  const converted = await convertToModelMessages(history.messages, {
    ignoreIncompleteToolCalls: true
  });

  const modelMessages: ModelMessage[] = history.summary
    ? [{ role: "system", content: history.summary }, ...converted]
    : converted;

  const memoryRuntime = await buildMemoryRuntimeSupport({
    db: app.infra.db,
    config: app.infra.config,
    userMessage: body.text,
    modelHistory: history.messages.map((m) => ({ content: uiMessageText(m) })),
    ...(mainModel.contextWindow !== undefined || mainModel.maxOutputTokens !== undefined
      ? { modelLimits: { /* 同现有写法 */ } }
      : {})
  });

  return {
    sessionId: session.id,
    userMessageId: storedUser.id,
    modelMessages,
    additionalTools: [...memoryRuntime.additionalTools],
    ...(memoryRuntime.memoryContext
      ? { context: { memory: memoryRuntime.memoryContext } }
      : {})
  };
};
```

主路由：

```ts
app.post("/api/v1/runs/stream", async (request, reply) => {
  const runId = randomUUID();
  const runs = new DrizzleRunRepository(app.infra.db);
  const controller = app.services.runRegistry.register(runId);

  let finished = false;
  let sessionId = "";
  let seq = 0;

  const emit = (event: RunStreamEvent): void => {
    seq += 1;
    reply.raw.write(
      `event: ${event.type}\ndata: ${JSON.stringify({ ...event, seq } as RunStreamFrame)}\n\n`
    );
  };

  const requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
    /* T0.4 已写好的实现，原样保留 */
  };

  try {
    const body = runRequestSchema.parse(request.body ?? {});
    const resolvedAgent = app.services.agents.resolve({
      ...(body.modelId !== undefined ? { requestedModelId: body.modelId } : {}),
      requestApproval
    });

    const prepared = await prepareRun(app, body, runId, resolvedAgent.mainModel);
    sessionId = prepared.sessionId;

    runs.start({
      id: runId,
      sessionId,
      model: resolvedAgent.mainModel.qualifiedModelId,
      userMessageId: prepared.userMessageId
    });

    reply.raw.writeHead(200, { /* 同现有 SSE 头 */ });
    emit({ type: "run_start", runId, sessionId });
    reply.raw.on("close", () => { /* T0.4 的 abort + cancelBySession */ });

    const builder = new UiMessageBuilder(randomUUID());
    let finishReason: StreamFinishReason = "stop";
    let usage: StreamTokenUsage | undefined;

    for await (const event of resolvedAgent.agent.stream({
      messages: prepared.modelMessages,
      abortSignal: controller.signal,
      ...(prepared.additionalTools.length > 0
        ? { additionalTools: prepared.additionalTools }
        : {}),
      ...(prepared.context !== undefined ? { context: prepared.context } : {})
    })) {
      builder.push(event);
      emit(event);

      if (event.type === "finish") {
        finishReason = event.finishReason;
        usage = event.usage;
      }

      if (event.type === "error") {
        finishReason = "error";
      }
    }

    const assistantMessage = builder.build({
      runId,
      model: resolvedAgent.mainModel.qualifiedModelId,
      ...(finishReason === "aborted" ? { aborted: true } : {})
    });

    const stored = app.services.session.recordAssistantMessage(
      sessionId,
      assistantMessage,
      runId
    );

    runs.settle(runId, {
      status: runStatusFor(finishReason),
      finishReason,
      assistantMessageId: stored.id,
      ...(usage !== undefined ? { usage } : {})
    });

    emit({ type: "end", finishReason });
    finished = true;
    reply.raw.end();
  } catch (error) {
    request.log.error({ err: error, runId }, "failed to stream agent run");

    if (sessionId) {
      runs.settle(runId, { status: "error", error: toErrorMessage(error) });
    }

    if (!reply.raw.headersSent) {
      reply.code(error instanceof AgentUnavailableError ? 503 : 400);

      return { error: toErrorMessage(error) };
    }

    finished = true;
    emit({ type: "error", message: toErrorMessage(error) });
    emit({ type: "end", finishReason: "error" });
    reply.raw.end();
  } finally {
    app.services.runRegistry.unregister(runId);
    if (sessionId) {
      app.services.approvals.cancelBySession(sessionId);
    }
  }
});
```

三个顺序上的要点：

1. **先 `agents.resolve()` 再 `prepareRun()`**：resolve 可能抛 `AgentUnavailableError`（503），此时不该已经把用户消息落库了。
2. **`runs.start()` 在 `writeHead` 之前**：写头之后就没法再返回 503/400 了。
3. **`assistantMessage` 无论什么终态都落库**（含 aborted / error）。丢一半的回复也比 DB 里没痕迹强 —— `metadata.aborted` 标出来即可。

**6c. `apps/server/src/routes/threads.ts`**

`GET /threads/:id/messages` 的映射改成：

```ts
return messageRepo.findBySessionId(id, { limit: query.limit ?? 200 }).map((m) => ({
  id: m.id,
  role: m.role,
  message: m.message,
  runId: m.runId,
  createdAt: m.createdAt
}));
```

其余不动。

**6d. commit 2**

```
refactor(server): converge run contract on UIMessage history and run ledger
```

正文写：跨轮工具上下文是怎么恢复的（`convertToModelMessages` + 原生 tool role）、契约为什么从 `messages[]` 收成 `text`、`/runs/wait` 为什么删。

---

### Step 7 · 服务端测试

**7a. `tests/session.test.ts` 重写**

三个旧用例必须改（它们断言的正是被推翻的行为）：

| 旧用例 | 处理 |
|---|---|
| `records assistant result with tool calls as structured content` | 改成断言 `message.parts` 的 type 序列与 `dynamic-tool` 的 `state`/`output` |
| `strips tool markers from flattened history for agent` | **删掉**，换成新用例 `模型历史保留上一轮的工具轨迹` |
| `records assistant message with token usage` | 改成断言 `message.metadata.usage` |

新增关键用例（这是 T1 的核心回归）：

```ts
it("模型历史保留上一轮的工具轨迹", async () => {
  const { session } = service.createSession(createUserUIMessage(randomUUID(), "读一下 a.ts"));

  service.recordAssistantMessage(session.id, {
    id: randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "read_file",
        toolCallId: "tc-1",
        state: "output-available",
        input: { path: "a.ts" },
        output: "export const x = 1;"
      },
      { type: "text", text: "读到了", state: "done" }
    ]
  });

  const history = service.buildModelHistory(db, session.id);
  const modelMessages = await convertToModelMessages(history.messages, {
    ignoreIncompleteToolCalls: true
  });

  // 关键：必须出现一条 role === "tool" 的消息，且里面有工具输出
  expect(modelMessages.some((m) => m.role === "tool")).toBe(true);
  expect(JSON.stringify(modelMessages)).toContain("export const x = 1;");
});

it("被 abort 的消息（工具没有结果）不会让历史转换失败", async () => {
  // parts 里放一个 state: "input-available" 的 dynamic-tool
  // convertToModelMessages(..., { ignoreIncompleteToolCalls: true }) 不抛，
  // 且结果里没有孤儿 tool-call
});
```

**7b. 新增 `tests/run-lifecycle.test.ts`**

用 `tests/api-phase1.test.ts` 的 Fastify 搭建方式（注意：Fastify 要从 `../apps/server/node_modules/fastify/fastify.js` 导入，workspace hoisting 决定的）+ `tests/lead-agent-abort.test.ts` 的 `MockLanguageModelV4` 造流。

```ts
describe("run 台账", () => {
  it("正常完成 → runs 一行 completed，带 assistant_message_id", () => {});
  it("abort → status aborted，assistant 消息仍落库且 metadata.aborted 为 true", () => {});
  it("模型报错 → status error，error 字段非空", () => {});
  it("failStale 把重启前的 running 收成 error", () => {});
});

describe("契约", () => {
  it("body 缺 text → 400", () => {});
  it("body 带遗留的 messages[] 而没有 text → 400（不再静默接受）", () => {});
  it("未知 sessionId → 当成新会话，run_start 帧带回新 id", () => {});
});
```

---

### Step 8 · 前端对齐

**8a. `apps/web/src/types/api.ts`**

现在用 `../../../../packages/shared/src/index.js` 相对路径 re-export（`apps/web/tsconfig.json` 里没配 `@eva/shared` 的 paths，但 `package.json` 里有 `"@eva/shared": "workspace:*"`）。改成：

```ts
export type {
  EvaUIMessage,
  EvaUIMessagePart,
  ThreadMessage,
  ThreadSummary,
  // ... 其余保持
} from "@eva/shared";
```

若 Vite 解析不到，在 `vite.config.ts` 的 `resolve.alias` 里加 `"@eva/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts")`。

**8b. `apps/web/src/api/client.ts` 回调收敛**

`StreamCallbacks` 的四个粒度回调（`onTextChunk` / `onToolCallStart` / `onToolCallEnd` / `onResult`）合并成一个：

```ts
export interface StreamCallbacks {
  readonly onRunStart?: (runId: string, sessionId: string) => void;
  /** 已按 seq 归位的 agent 域事件，交给 UiMessageBuilder 累积。 */
  readonly onEvent: (event: RunAgentStreamEvent) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: (finishReason: StreamFinishReason) => void;
}

export interface StreamRequest {
  readonly text: string;
  readonly sessionId?: string;
  readonly modelId?: string;
}
```

`dispatchEvent` 相应简化：`run_start` → `onRunStart`；`approval_request` / `approval_resolved` 暂时忽略（T3 接 SSE 审批时再处理，**不要**顺手做）；其余全部转 `onEvent`。

`ToolCallInfo` 保留在 `client.ts`，但改成从 part 派生的适配器（这样 `tool-call-block.tsx` 不用动）：

```ts
export const toolPartToInfo = (part: EvaDynamicToolPart): ToolCallInfo => ({
  toolName: part.toolName,
  toolCallId: part.toolCallId,
  args: (part.input as Record<string, unknown>) ?? {},
  ...(part.state === "output-available" || part.state === "output-error"
    ? {
      output: toolPartOutput(part),
      status: part.state === "output-error" ? ("error" as const) : ("success" as const)
    }
    : {}),
  ...(typeof part.toolMetadata?.durationMs === "number"
    ? { durationMs: part.toolMetadata.durationMs }
    : {})
});
```

**8c. `apps/web/src/hooks/use-chat.ts`**

- **删掉 `parseStoredContent`（74 行）和 `DisplayMessage`**；
- state 换成 `EvaUIMessage[]`；
- 流式用 `UiMessageBuilder`：

```ts
const builderRef = useRef<UiMessageBuilder | null>(null);

// sendMessage 里：
const assistantId = crypto.randomUUID();
builderRef.current = new UiMessageBuilder(assistantId);

setMessages((prev) => [
  ...prev,
  createUserUIMessage(crypto.randomUUID(), trimmed),
  { id: assistantId, role: "assistant", parts: [] }
]);

// 回调里：
onEvent(event) {
  const builder = builderRef.current;
  if (!builder) return;

  builder.push(event);
  const snapshot = builder.snapshot();

  setMessages((prev) => prev.map((m) => (m.id === assistantId ? snapshot : m)));
}
```

- `loadSession` 直接用返回的 `message` 字段：`setMessages(data.map((m) => m.message))`；
- `isStreaming` 保留在 hook 级（T3 会把它下沉到消息级）。

> `setMessages(prev => prev.map(...))` 仍然全量重建数组——**这是已知问题，T3 §3.2 修**。T1 不要顺手优化，那会和 T3 的目录重构撞车。

**8d. `apps/web/src/components/message-bubble.tsx` 按 parts 渲染**

```tsx
interface MessageBubbleProps {
  readonly message: EvaUIMessage;
  readonly isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  if (message.role === "user") {
    return (/* 气泡里渲染 uiMessageText(message) */);
  }

  const thinkingMs = message.metadata?.thinkingDurationMs;

  return (
    <div className="max-w-none">
      {thinkingMs !== undefined && thinkingMs > 0 ? (
        <ThinkingBadge durationMs={thinkingMs} />
      ) : null}

      {message.parts.map((part, index) => {
        if (isTextPart(part)) {
          return (
            <AssistantContent
              key={`text-${index}`}
              content={part.text}
              isStreaming={isStreaming === true && part.state === "streaming"}
            />
          );
        }

        if (isDynamicToolPart(part)) {
          return <ToolCallBlock key={part.toolCallId} toolCall={toolPartToInfo(part)} />;
        }

        return null;   // step-start 等不渲染
      })}

      {message.parts.length === 0 ? <StreamingIndicator /> : null}
    </div>
  );
}
```

这顺带修了一个现存的显示错误：旧版把所有 toolCalls 渲染在正文**之前**，多 step 场景下的真实顺序（说一句 → 调工具 → 再说一句）被打乱了。按 parts 顺序渲染就自然对了。

`message-list.tsx` / `chat-view.tsx` 的 props 类型 `DisplayMessage` → `EvaUIMessage`，其余不动。

**8e. 手工验收（前端没有自动化测试，必须手跑）**

见 §5 的手工清单。

---

### Step 9 · 清理与 commit 3

**9a. 确认这些符号已彻底消失**

```bash
grep -rn "MessageContentBlock\|parseMessageContent\|serializeMessageContent\|blocksToHistoryContent\|stripToolMarkers\|parseStoredContent\|DisplayMessage\|HistoryMessage\|RunInputMessage\|runSchema\|runs/wait" \
  apps packages tests --include="*.ts" --include="*.tsx" | grep -v node_modules
```

应无输出。

**9b. 把过程中发现但不属于 T1 的问题写进 `docs/plans/r1/FINDINGS.md`**（追加，不要顺手改）。

**9c. commit 3**

```
refactor(web): render messages from UIMessage parts
```

---

## 5. 验收

### 自动化

- [ ] `pnpm typecheck && pnpm test` 全绿；测试总数 ≥ 97 + 新增（没有为了变绿删用例）
- [ ] `tests/ui-message.test.ts` 覆盖 builder 顺序、tool 回填、search_text 边界、JSON 数组歧义回归
- [ ] `tests/session.test.ts` 的「模型历史保留上一轮的工具轨迹」通过——这是 T1 存在的理由
- [ ] `tests/run-lifecycle.test.ts` 四个终态 + 三个契约用例通过
- [ ] §9a 的 grep 无输出

### 数据

- [ ] 删掉 `~/.eva/eva.db*` 重启，发一轮带工具的对话后：
  ```bash
  sqlite3 ~/.eva/eva.db "select json_extract(message,'$.role'), json_array_length(message,'$.parts') from messages;"
  ```
  assistant 行的 parts 数 > 1，且
  ```bash
  sqlite3 ~/.eva/eva.db "select message from messages where role='assistant';" | jq '.parts[].type'
  ```
  能看到 `dynamic-tool`
- [ ] `sqlite3 ~/.eva/eva.db "select status, finish_reason, model, usage from runs;"` 每次执行一行且有终态
- [ ] `sqlite3 ~/.eva/eva.db "pragma table_info(messages);"` 没有 `content` / `metadata` / `token_usage`
- [ ] 保留一份旧库副本跑一次迁移：不报错，旧消息在 UI 里仍然显示得出来（工具轨迹丢失是预期的）

### 手工

- [ ] 第一轮让 agent 读一个文件，第二轮问「你刚才读到的第一行是什么」——**能答上来**（T1 之前必然答不上来）
- [ ] 刷新页面重新加载会话：工具块、耗时、正文顺序与刷新前一致
- [ ] 多 step 对话（说一句 → 调工具 → 再说一句）：正文和工具块的**上下顺序**正确
- [ ] 流式中途点 Stop：已生成的半条回复留在界面上，刷新后仍在，`runs.status = 'aborted'`
- [ ] 直接 POST 旧契约 `{"messages":[{"role":"user","content":"hi"}]}` → 400（不再静默吞掉）
- [ ] 长会话触发 auto-compact 后仍能正常追问（摘要作为 system 消息生效）
