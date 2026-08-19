import { memo } from "react";

import type { EvaUIMessage } from "@eva/shared";

import { MessageBubble } from "./message-bubble";

interface CommittedMessagesProps {
  readonly messages: readonly EvaUIMessage[];
}

/**
 * 已完成消息的列表。
 *
 * 单独成组件并 memo:流式期间每帧变化的只有 streaming 那一条,
 * 这棵子树的 props 引用不变,整棵跳过重渲染。
 */
function CommittedMessagesImpl({ messages }: CommittedMessagesProps) {
  // 激活链里最后一条 assistant = 当前的"叶子"。重生成/版本切换只为它显示。
  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  return (
    <>
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          isLastAssistant={message.id === lastAssistantId}
        />
      ))}
    </>
  );
}

export const CommittedMessages = memo(CommittedMessagesImpl);