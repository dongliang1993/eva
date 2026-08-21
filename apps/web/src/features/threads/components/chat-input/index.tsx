import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";

import { Tooltip, TooltipProvider } from "../../../../shared/ui/tooltip";
import { WorkspacePicker } from "../../../workspaces/components/workspace-picker";
import { SelectModel } from "./select-model";

/** 服务端拒收了上一句(会话里还有一轮在飞)—— 话要还给用户,原因要说出来。 */
export interface ChatInputRejection {
  /** 被拒的那句话;retry 被拒时没有"刚打的字"。 */
  readonly text?: string;
  readonly message: string;
}

interface ChatInputProps {
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly disabled: boolean;
  readonly isStreaming: boolean;
  readonly selectedModel: string | null;
  readonly onSelectModel: (modelId: string) => void;
  readonly workspaceId: string | null;
  readonly onSelectWorkspace: (workspaceId: string | null) => void;
  /**
   * 上一句被拒:把话放回输入框 + 在框上方说一句原因。
   *
   * 草稿刻意留在这个组件里(不提到页面级 state):否则每敲一个键都要重渲染
   * 整条消息列表。拒收是低频事件,用一个对象引用把它传进来就够了。
   */
  readonly rejection?: ChatInputRejection | null;
  /** 用户已经看到提示(打字或再次发送)—— 由页面清掉 rejection。 */
  readonly onRejectionSeen?: () => void;
}

export function ChatInput({
  onSend,
  onStop,
  disabled,
  isStreaming,
  selectedModel,
  onSelectModel,
  workspaceId,
  onSelectWorkspace,
  rejection,
  onRejectionSeen
}: ChatInputProps) {
  const [text, setText] = useState("");

  // 同一次拒收只回填一次(提示会在框上一直留着,直到用户打字/再发)。
  const restoredRef = useRef<ChatInputRejection | null>(null);

  useEffect(() => {
    if (!rejection || restoredRef.current === rejection) return;
    restoredRef.current = rejection;

    const rejected = rejection.text;
    if (rejected === undefined) return;
    // 用户在这期间已经开始打新的了 → 不覆盖他的字。
    setText((prev) => (prev.length > 0 ? prev : rejected));
  }, [rejection]);

  const modelConfigured = selectedModel !== null;

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();

    if (!trimmed || disabled || !modelConfigured) return;

    onRejectionSeen?.();
    onSend(trimmed);
    setText("");
  }, [text, disabled, modelConfigured, onSend, onRejectionSeen]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const canSend = !disabled && modelConfigured && text.trim().length > 0;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="px-4 pb-4">
        {rejection ? (
          <div className="mx-auto pb-2 text-xs text-muted-foreground">
            {rejection.message}
          </div>
        ) : null}
        <div className="mx-auto rounded-md border border-input bg-card">
          <textarea
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder-muted-foreground outline-none"
            placeholder={modelConfigured ? "Type a message..." : "Select a model first..."}
            rows={1}
            value={text}
            onChange={(e) => {
              if (rejection) onRejectionSeen?.();
              setText(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled || !modelConfigured}
          />
          <div className="flex items-center justify-between px-3 pb-2">
            <div className="flex items-center gap-1">
              <SelectModel
                selectedModel={selectedModel}
                onSelect={onSelectModel}
              />
              <WorkspacePicker
                workspaceId={workspaceId}
                onSelect={onSelectWorkspace}
              />
            </div>

            {isStreaming ? (
              <button
                type="button"
                className="rounded-full p-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                onClick={onStop}
              >
                <Square size={16} />
              </button>
            ) : modelConfigured ? (
              <button
                type="button"
                className={`rounded-full p-2 transition-colors ${canSend
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "text-muted-foreground cursor-not-allowed"
                  }`}
                onClick={handleSubmit}
                disabled={!canSend}
              >
                <Send size={16} />
              </button>
            ) : (
              <Tooltip content="Please select a model to start chatting">
                <span className="rounded-full p-2 text-muted-foreground cursor-not-allowed opacity-40">
                  <Send size={16} />
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
