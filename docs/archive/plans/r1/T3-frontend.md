# T3 · 前端：流式性能、审批推送、目录重构

> 前置：**T1、T2 全部完成并 commit**（消息已经是 `EvaUIMessage`，SSE 事件已经稳定）。
> 读之前先读 `00-overview.md` §1 执行契约。

**分 3 个 commit**：

| commit | 覆盖步骤 | 内容 |
|---|---|---|
| 1 | Step 1–3 | 渲染性能：单条引用 + memo + 滚动锚定 + 虚拟化 |
| 2 | Step 4–5 | `use-chat` 拆分 + 审批改 SSE 推送 |
| 3 | Step 6–7 | 目录重构（纯移动）+ 死链清理 |

**Step 6 是纯文件移动，必须单独一个 commit**，混进逻辑改动会让 review 无法进行。

---

## 1. 问题实证

**1.1 每个 token 重建整个消息数组**

`apps/web/src/hooks/use-chat.ts:178`（T1 之后行号会变，逻辑不变）：

```ts
setMessages((prev) => prev.map((m) => (m.id === assistantId ? next : m)));
```

`.map()` 每次产出**新数组**，`MessageList` 必然重渲染。而 `MessageList`、`MessageBubble`、`ToolCallBlock` **一个都没有 `memo`**（全仓库只有 `shared/markdown/markdown.tsx:40` 的 `StreamMarkdown` 是 memo 的）——于是一次 token 到达 = 全部历史气泡重渲染一遍。100 条消息的会话里，每秒几十个 token，就是每秒几千次组件函数调用。

`docs/architecture/01-frontend.md` §3.2 明确要求「只换单条引用」。

**1.2 流式期间每帧触发一次平滑滚动**

`apps/web/src/components/message-list.tsx:13-15`：

```ts
useEffect(() => {
  bottomRef.current?.scrollIntoView({ behavior: "smooth" });
}, [messages]);
```

`messages` 每个 token 变一次 → `scrollIntoView({behavior:"smooth"})` 每个 token 被重新发起一次。浏览器的平滑滚动是有动画时长的，连续打断重启的结果就是滚动看起来在抖。而且**用户往上翻看历史时会被强行拽回底部**——没有任何"是否贴底"的判断。

**1.3 没有虚拟化**

`message-list.tsx:30` 直接 `messages.map()`。每条 assistant 消息里还挂着 Streamdown（Shiki 高亮 + KaTeX + mermaid）。100+ 消息的会话打开就是几千个 DOM 节点 + 上百次语法高亮。

**1.4 `use-chat.ts` 一个 hook 管四件事**

302 行：SSE 消费 / 消息树维护 / thinking 计时 / session-URL 同步。其中 thinking 计时（`:146-153` 的 `thinkingStartTime` + `resolveThinking`）在 T1 之后已经是**重复实现**——`UiMessageBuilder` 已经把 `thinkingDurationMs` 算进 `metadata` 了。

**1.5 审批靠 900ms 全局轮询**

`apps/web/src/hooks/use-approvals.ts:5,28`：`setInterval(refresh, 900)`。T0.4 已经把 `approval_request` / `approval_resolved` 做成了 SSE 事件，前端还在轮询——最坏情况下用户要等 900ms 才看到审批卡片，而且空闲时也在持续打接口。

**1.6 目录仍是层式，与 `docs/architecture/10-frontend-conventions.md` 不符**

现在是 `pages/ components/ hooks/ api/`，10 篇要求 `app/ features/ shared/`。同时 `apps/web/src/types/api.ts` 用 `../../../../packages/shared/src/index.js` 这种四层相对路径 re-export（T1 已经改掉，这里确认）。

**1.7 死链**

`pages/chat/index.tsx:74` 与 `components/sidebar.tsx` 的 `onOpenAgentLab` → `navigate("/agent-lab")`，但 `app.tsx` 只注册了 `/`、`/chat`、`/settings/*`。点了就是白屏。

---

## 2. 目标设计

### 2.1 渲染分层：把"在飞的那一条"和"已完成的那些"彻底分开

```
<MessageList>
  <CommittedMessages messages={committed} />     ← memo；只在轮次边界变
  <StreamingBubble message={streaming} />        ← 每帧只有它重渲染
  <ScrollAnchor />
</MessageList>
```

`useChat` 的状态从一个数组拆成两个：

```ts
const [committed, setCommitted] = useState<EvaUIMessage[]>([]);   // 已完成的消息
const [streaming, setStreaming] = useState<EvaUIMessage | null>(null);  // 在飞的 assistant
```

- 每个 chunk 只 `setStreaming(builder.snapshot())`，`committed` 的数组引用**完全不动**；
- `CommittedMessages` 用 `memo` 包住，props 引用没变就整棵子树跳过；
- run 结束时一次性 `setCommitted((prev) => [...prev, finalMessage])` + `setStreaming(null)`。

这样"每 token 重渲染的组件数"从 O(消息数) 降到 O(1)。

> 这是 Vercel `rerender-defer-reads` 与 `rerender-functional-setstate` 两条规则的直接应用：把高频变化的状态**隔离在最小的订阅范围内**。

### 2.2 滚动：stick-to-bottom，而不是无条件 scrollIntoView

```
用户在底部附近（距底 < 80px）→ 贴底：新内容到达时直接设 scrollTop = scrollHeight（无动画）
用户往上翻了            → 不贴底：不动，显示「回到底部」按钮
用户发出新消息          → 强制贴底一次（平滑）
```

流式期间用**瞬时**滚动而不是 smooth：smooth 的动画时长会被下一帧打断，视觉上就是抖。轮次开始时才用一次 smooth。

### 2.3 虚拟化：只虚拟化已完成的消息

用 `@tanstack/react-virtual` 的动态测量（`measureElement`），但**在飞的那条消息不进虚拟列表**——它高度每帧都在变，测量它等于每帧全量 reflow。它渲染在虚拟列表下方，作为普通 DOM。

再加一道闸：`committed.length <= VIRTUALIZE_THRESHOLD`（40）时不启用虚拟化，直接渲染。绝大多数会话根本用不上，简单路径要保持简单。

### 2.4 目录：10 篇的 `renderer/` 就是本仓库的 `apps/web/src/`

10 篇写的是 Alma 那种「Electron 单包，src 下分 main/preload/renderer」的形态；Eva 拆成了 `apps/web`（渲染）+ `apps/desktop`（壳）。映射关系：

| 10 篇 | 本仓库 |
|---|---|
| `src/main/` | `apps/desktop/electron/` + `apps/server/` |
| `src/preload/` | `apps/desktop/electron/preload.ts` |
| `src/renderer/` | **`apps/web/src/`** ← 本任务的范围 |
| `shared/types/` | `packages/shared/`（跨进程复用，比 10 篇的定位更高） |

**这条映射要写进 `docs/architecture/10-frontend-conventions.md`**（T4 做，本任务只在 FINDINGS 记一笔）。

### 2.5 本轮不做

- `slots/` 槽位目录（S6 才有扩展宿主，现在建空目录是预判性抽象）；
- ESLint 的 `no-restricted-imports` 强制（10 篇 §9）——先靠 review，T4 再决定要不要上；
- `settings/memory-settings/index.tsx`（699 行）与 `provider-settings.tsx`（529 行）的内部拆分——它们只是大，不是错，本轮只搬位置不动内部。

---

## 3. 涉及文件

### Step 1–5（逻辑改动）

| 文件 | 动作 |
|---|---|
| `apps/web/package.json` | 改：加 `@tanstack/react-virtual` |
| `apps/web/src/hooks/use-chat.ts` | 改：拆分 + 双状态 |
| `apps/web/src/hooks/use-run-stream.ts` | 新增：SSE 生命周期 |
| `apps/web/src/hooks/use-stick-to-bottom.ts` | 新增 |
| `apps/web/src/components/message-list.tsx` | 改：虚拟化 + 分层 |
| `apps/web/src/components/committed-messages.tsx` | 新增 |
| `apps/web/src/components/message-bubble.tsx` | 改：`memo` |
| `apps/web/src/components/tool-call-block.tsx` | 改：`memo` |
| `apps/web/src/api/client.ts` | 改：审批事件回调 |
| `apps/web/src/hooks/use-approvals.ts` | 改：删轮询 |
| `apps/web/src/pages/chat/index.tsx` | 改：接线 + 删死链 |
| `apps/web/src/components/sidebar.tsx` | 改：删 agent-lab 入口 |

### Step 6（纯移动，见 §4 Step 6 的完整对照表）

---

## 4. 步骤

### Step 1 · 消息状态拆成 committed / streaming

**1a. `use-chat.ts` 的返回值改形状**

```ts
interface UseChatReturn {
  /** 已完成的消息（引用只在轮次边界变化）。 */
  readonly messages: readonly EvaUIMessage[];
  /** 在飞的 assistant 消息；null 表示当前没有 run。 */
  readonly streamingMessage: EvaUIMessage | null;
  readonly isStreaming: boolean;
  readonly sessionId: string | null;
  readonly sendMessage: (text: string, modelId?: string) => void;
  readonly stopStreaming: () => void;
  readonly newConversation: () => void;
  readonly loadSession: (threadId: string) => void;
}
```

`sendMessage` 的关键改动：

```ts
const sendMessage = useCallback((text: string, modelId?: string) => {
  const trimmed = text.trim();

  if (isStreaming || trimmed.length === 0) {
    return;
  }

  const userMessage = createUserUIMessage(crypto.randomUUID(), trimmed);
  const assistantId = crypto.randomUUID();
  const builder = new UiMessageBuilder(assistantId);

  builderRef.current = builder;

  // 用户消息一次性进 committed；assistant 走 streaming 通道。
  setCommitted((prev) => [...prev, userMessage]);
  setStreaming({ id: assistantId, role: "assistant", parts: [] });
  setIsStreaming(true);

  streamChat({ text: trimmed, sessionId: sessionIdRef.current ?? undefined, ...(modelId ? { modelId } : {}) }, {
    onRunStart(runId, returnedSessionId) { /* 不变 */ },

    onEvent(event) {
      builder.push(event);
      // 只换这一个引用 —— committed 数组完全不动
      setStreaming(builder.snapshot());
    },

    onError(message) {
      setStreaming({
        id: assistantId,
        role: "assistant",
        parts: [{ type: "text", text: `Error: ${message}`, state: "done" }]
      });
    },

    onEnd() {
      // 结算：把最终消息并进 committed，清空 streaming
      const finalMessage = builder.build();

      setCommitted((prev) => [...prev, finalMessage]);
      setStreaming(null);
      setIsStreaming(false);
      builderRef.current = null;
    }
  });
}, [isStreaming]);
```

> **注意 `onEnd` 的顺序**：必须先 `setCommitted` 再 `setStreaming(null)`。React 18+ 会把同一事件里的多个 setState 批处理成一次渲染，所以不会出现"消息短暂消失"的中间态。若在非 React 事件（如 SSE 回调）里发现闪烁，用 `flushSync` 包住这两句并加注释说明原因。

**1b. `CommittedMessages` 组件**

新建 `apps/web/src/components/committed-messages.tsx`：

```tsx
import { memo } from "react";
import type { EvaUIMessage } from "@eva/shared";

import { MessageBubble } from "./message-bubble";

interface CommittedMessagesProps {
  readonly messages: readonly EvaUIMessage[];
}

/**
 * 已完成消息的列表。
 *
 * 单独成组件并 memo：流式期间每帧变化的只有 streaming 那一条，
 * 这棵子树的 props 引用不变，整棵跳过重渲染。
 */
function CommittedMessagesImpl({ messages }: CommittedMessagesProps) {
  return (
    <>
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </>
  );
}

export const CommittedMessages = memo(CommittedMessagesImpl);
```

**1c. `MessageBubble` / `ToolCallBlock` 加 `memo`**

两个文件都改成 `function XxxImpl(...)` + `export const Xxx = memo(XxxImpl)`。

`MessageBubble` 的 props 增加 `isStreaming?: boolean`（T1 已加），memo 的默认浅比较对这两个 props 就够了。

### Step 2 · 滚动锚定

新建 `apps/web/src/hooks/use-stick-to-bottom.ts`：

```ts
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 距底多少像素内算「贴底」。
 * 取 80px：约等于一行半正文的高度 —— 用户滚开一点点仍然算在看最新内容，
 * 明确往上翻（超过一行半）才停止自动跟随。
 */
const STICK_THRESHOLD_PX = 80;

export interface StickToBottom {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  /** 当前是否贴底（用于决定要不要显示「回到底部」按钮）。 */
  readonly isAtBottom: boolean;
  /** 强制滚到底（用户发消息时调用）。 */
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * 贴底跟随。
 *
 * 为什么不用 scrollIntoView({behavior:"smooth"})：流式期间内容每帧增长，
 * 每帧重新发起一次平滑滚动会互相打断，视觉上是抖动。贴底跟随用瞬时
 * scrollTop 赋值，平滑只留给「用户发出新消息」这一个时刻。
 *
 * @param dependency 内容变化的信号（传流式消息或其 parts 长度）
 */
export const useStickToBottom = (dependency: unknown): StickToBottom => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = containerRef.current;

    if (!el) {
      return;
    }

    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // 监听用户滚动，更新贴底状态（ref 与 state 双写：ref 给下面的
  // layout effect 同步读，state 只驱动「回到底部」按钮的显隐）
  useEffect(() => {
    const el = containerRef.current;

    if (!el) {
      return;
    }

    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance < STICK_THRESHOLD_PX;

      isAtBottomRef.current = atBottom;
      setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 内容变化后同步贴底 —— 用 layout effect 避免先绘制"没跟上"的一帧
  useLayoutEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [dependency, scrollToBottom]);

  return { containerRef, isAtBottom, scrollToBottom };
};
```

`message-list.tsx` 里删掉 `bottomRef` + `scrollIntoView` 的 effect，改用这个 hook；`ChatPage` 在 `sendMessage` 后调一次 `scrollToBottom("smooth")`。

「回到底部」按钮：`isAtBottom === false` 且有消息时显示，点击 `scrollToBottom("smooth")`。

### Step 3 · 虚拟化

```bash
pnpm --filter @eva/web add @tanstack/react-virtual
```

`message-list.tsx` 改成：

```tsx
/**
 * 超过这个条数才启用虚拟化。
 * 40 条约等于 3–4 屏，低于它虚拟化的测量开销比省下的渲染开销还大。
 */
const VIRTUALIZE_THRESHOLD = 40;

export function MessageList({ messages, streamingMessage }: MessageListProps) {
  const { containerRef, isAtBottom, scrollToBottom } = useStickToBottom(streamingMessage);

  if (messages.length === 0 && streamingMessage === null) {
    return <EmptyState />;
  }

  return (
    <div ref={containerRef} className="message-list-scroll flex-1 overflow-y-auto px-4 py-6 mx-4">
      {messages.length > VIRTUALIZE_THRESHOLD ? (
        <VirtualizedMessages messages={messages} scrollRef={containerRef} />
      ) : (
        <CommittedMessages messages={messages} />
      )}

      {/* 在飞的消息不进虚拟列表：它高度每帧都在变，测量它等于每帧全量 reflow */}
      {streamingMessage !== null ? (
        <MessageBubble message={streamingMessage} isStreaming />
      ) : null}

      {isAtBottom ? null : <ScrollToBottomButton onClick={() => scrollToBottom("smooth")} />}
    </div>
  );
}
```

`VirtualizedMessages`（同文件或拆成 `virtualized-messages.tsx`）：

```tsx
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollRef.current,
  // 一条消息的高度初值。实际高度由 measureElement 动态测。
  estimateSize: () => 120,
  overscan: 6
});
```

每个虚拟项用 `ref={virtualizer.measureElement}` + `data-index`，容器给 `height: virtualizer.getTotalSize()` 与 `transform: translateY(...)`。照 `@tanstack/react-virtual` 的 dynamic-size 官方范式写，不要自创。

> 注意：虚拟化容器和 `useStickToBottom` 用**同一个** `containerRef`（滚动元素只能有一个）。

### Step 4 · `use-chat` 拆分

拆成三份：

**`use-run-stream.ts`** —— 只管一次 run 的 SSE 生命周期，不认识"消息列表"：

```ts
export interface RunStreamHandlers {
  readonly onRunStart: (runId: string, sessionId: string) => void;
  readonly onEvent: (event: RunAgentStreamEvent) => void;
  readonly onApproval: (event: RunApprovalEvent) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: () => void;
}

export interface UseRunStream {
  readonly isStreaming: boolean;
  readonly start: (request: StreamRequest, handlers: RunStreamHandlers) => void;
  readonly stop: () => void;
}
```

内部持有 `runIdRef`，`stop()` 调 `abortRun(runId)`。

**`use-chat.ts`** —— 只管消息状态与 builder，调用 `useRunStream`。目标 **< 120 行**。

**`use-thread-url.ts`**（放 `pages/chat/` 旁边）—— 把 `pages/chat/index.tsx:30-53` 的两个 URL 同步 effect 搬进来：

```ts
export const useThreadUrl = (sessionId: string | null, loadSession: (id: string) => void): void
```

**删除**：`use-chat.ts` 里的 `thinkingStartTime` / `resolveThinking` / `thinkingResolved`（T1 之后 `UiMessageBuilder` 的 `metadata.thinkingDurationMs` 已经是唯一来源，这里是第二份实现）。

### Step 5 · 审批改 SSE 推送

**5a. `api/client.ts` 分发审批事件**

```ts
export interface StreamCallbacks {
  readonly onRunStart?: (runId: string, sessionId: string) => void;
  readonly onEvent: (event: RunAgentStreamEvent) => void;
  /** T0.4 引入的 Eva 自有域事件。 */
  readonly onApproval?: (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: (finishReason: StreamFinishReason) => void;
}
```

`dispatchEvent` 里加两个 case，转 `onApproval`。

**5b. `use-approvals.ts` 删轮询**

```ts
/**
 * 待审批的危险工具请求。
 *
 * 事实源是 SSE 的 approval_request / approval_resolved 事件（T0.4）。
 * 挂载时拉一次 listApprovals() 只为覆盖「页面刷新时正好有 run 在等审批」
 * 这一种情况 —— 不再轮询。
 */
export function useApprovals(alwaysAllowEnabled?: () => Promise<void> | void) {
  const [pending, setPending] = useState<readonly PendingApproval[]>([]);

  // 挂载时对齐一次（断线重连/刷新恢复）
  useEffect(() => {
    listApprovals().then(setPending).catch(() => {});
  }, []);

  /** 由 useChat 的 onApproval 回调驱动。 */
  const applyStreamEvent = useCallback((event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => {
    setPending((prev) =>
      event.type === "approval_request"
        ? [...prev, { callId: event.callId, tool: event.toolName, args: event.args }]
        : prev.filter((item) => item.callId !== event.callId)
    );
  }, []);

  // decide / allowAlways 保持不变（仍然是 POST）
}
```

删掉 `POLL_MS` 与 `setInterval`。

**5c. 接线**

`ChatPage` 把 `approvals.applyStreamEvent` 传给 `useChat`，`useChat` 在 `onApproval` 里调它。

### Step 6 · 目录重构（纯移动，单独 commit）

**移动对照表**（`apps/web/src/` 下）：

| 现在 | 之后 |
|---|---|
| `app.tsx` | `app/routes.tsx`（`App` 拆成 `providers.tsx` + `routes.tsx`） |
| `main.tsx` | 不动 |
| `pages/chat/index.tsx` | `features/threads/chat-page.tsx` |
| `pages/settings/index.tsx` | `features/settings/settings-page.tsx` |
| `hooks/use-chat.ts` | `features/threads/hooks/use-chat.ts` |
| `hooks/use-run-stream.ts` | `features/threads/hooks/use-run-stream.ts` |
| `hooks/use-approvals.ts` | `features/threads/hooks/use-approvals.ts` |
| `hooks/use-stick-to-bottom.ts` | `features/threads/hooks/use-stick-to-bottom.ts` |
| `hooks/use-settings.ts` | `features/settings/hooks/use-settings.ts` |
| `hooks/use-providers.ts` | `features/settings/hooks/use-providers.ts` |
| `hooks/use-memories.ts` | `features/settings/hooks/use-memories.ts` |
| `hooks/use-models.ts` | `shared/hooks/use-models.ts`（threads 的选模型与 settings 都用） |
| `components/{chat-view,message-list,message-bubble,committed-messages,tool-call-block,streaming-indicator,approval-card,sidebar}.tsx` | `features/threads/components/` |
| `components/chat-input/**` | `features/threads/components/chat-input/**` |
| `components/settings/**` | `features/settings/components/**` |
| `components/ui/**` | `shared/ui/**` |
| `api/client.ts` | `shared/api/run-stream-client.ts` |
| `api/fetch.ts` | `shared/api/fetch.ts` |
| `api/approvals.ts` | `features/threads/api.ts` |
| `shared/streaming/**`、`shared/markdown/**` | 不动（10 篇 §6 已经指定它们在 shared） |
| `types/api.ts` | **删除**，所有 import 直接走 `@eva/shared` |
| `styles/` | 不动 |

新增 barrel（10 篇 §4.3：只 re-export，不放逻辑）：

- `features/threads/index.ts` → 导出 `ChatPage` 与对外类型
- `features/settings/index.ts` → 导出 `SettingsPage`

**移动纪律**：

1. 用 `git mv` 逐个移动，让 git 能识别成 rename（否则 diff 变成"删一个文件加一个文件"，review 成本翻倍）。
2. 只改 import 路径，**不改任何一行逻辑**。
3. 移动完 `pnpm --filter @eva/web build` 必须过。
4. commit 正文写：本次是纯移动，无行为变化。

### Step 7 · 死链与杂项

- 删除 `/agent-lab` 入口：`pages/chat/index.tsx` 的 `handleOpenAgentLab`、`Sidebar` 的 `onOpenAgentLab` prop 与对应按钮。
  > 不是加一个 `/agent-lab` 路由 —— 那个页面根本不存在，加空路由只是把白屏换成空页。
- `ApprovalCard` 从未被传入的 `title?: string` prop：删。
- `api/fetch.ts` 的 `ApiError` 只在本文件内 throw、无人 import：改成非 export（或在 catch 里真正用起来，二选一，在 commit 里说明选了哪个）。
- 把这几条记进 `docs/plans/r1/FINDINGS.md`（T4 处理，本任务不改）：
  - 审批接口是 `/api/tool-approvals`，其余接口都是 `/api/v1/...` —— 前缀不一致；
  - `/settings/*` 的子页靠组件内 `activeNav` state 切换，不是 React Router 子路由，所以 `/settings/providers` 这种 URL 不会定位到对应 tab；
  - `docs/architecture/10-frontend-conventions.md` 的 `renderer/` 需要补一段与 `apps/web` 的映射说明（§2.4）。

---

## 5. 验收

### 自动化

- [ ] `pnpm typecheck && pnpm test` 全绿；`pnpm web:build` 成功
- [ ] `grep -rn "scrollIntoView\|setInterval" apps/web/src` 只剩合理用途（理想是无结果）
- [ ] `grep -rn "DisplayMessage\|parseStoredContent\|agent-lab\|types/api" apps/web/src` 无结果
- [ ] `grep -rn "from \"\.\./\.\./\.\./\.\./packages" apps/web/src` 无结果
- [ ] `wc -l apps/web/src/features/threads/hooks/use-chat.ts` < 120

### 性能（必须实测，不接受"看起来变快了"）

用 React DevTools Profiler，会话里先塞 100+ 条消息（可以直接往 `~/.eva/eva.db` 里批量 insert，或连续发 50 轮）：

- [ ] **流式期间单次 commit 的组件数**：录一段 3 秒的流式，Profiler 的 "Ranked" 视图里每次 commit 只应出现 `MessageBubble`（在飞那条）+ `StreamMarkdown` + `MessageList`。**不应出现** `CommittedMessages` 或任何历史气泡。改之前会看到全部气泡。
- [ ] **DOM 节点数**：100 条消息的会话，`document.querySelectorAll("*").length` 在启用虚拟化后应比改之前显著下降（记录改前/改后两个数字写进 commit 正文）
- [ ] **滚动**：流式期间画面平稳跟随，没有抖动；往上翻时**不会**被拽回底部，且出现「回到底部」按钮

### 手工

- [ ] 发消息 → 用户气泡立刻上屏、平滑滚到底
- [ ] token 爆发（让模型输出一大段代码）→ 正文平滑吐出，不卡顿、不跳字
- [ ] 触发一个危险工具 → 审批卡片**立刻**出现（不是等最多 900ms），决策后立刻消失
- [ ] 审批弹出时刷新页面 → 卡片仍在（挂载时的 `listApprovals()` 兜底生效）
- [ ] 切换会话、新建会话、从 URL `?threadId=` 直接打开：三条路径都正常
- [ ] 长会话（100+ 条）滚到最顶再滚到最底，内容完整、没有空白块（虚拟化测量正确）
