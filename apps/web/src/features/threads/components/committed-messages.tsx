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
  return (
    <>
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </>
  );
}

export const CommittedMessages = memo(CommittedMessagesImpl);