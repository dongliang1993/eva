import type { DisplayMessage } from "../hooks/use-chat";
import { MessageList } from "./message-list";
import { ChatInput } from "./chat-input";

interface ChatViewProps {
  readonly messages: readonly DisplayMessage[];
  readonly isStreaming: boolean;
  readonly selectedModel: string | null;
  readonly onSend: (text: string) => void;
  readonly onSelectModel: (modelId: string) => void;
}

export function ChatView({
  messages,
  isStreaming,
  selectedModel,
  onSend,
  onSelectModel
}: ChatViewProps) {
  return (
    <div className="flex h-full flex-col bg-background">
      <MessageList messages={messages} />
      <ChatInput
        onSend={onSend}
        disabled={isStreaming}
        selectedModel={selectedModel}
        onSelectModel={onSelectModel}
      />
    </div>
  );
}
