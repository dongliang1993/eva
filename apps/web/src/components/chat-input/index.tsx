import { useState, useCallback, type KeyboardEvent } from "react";
import { Send } from "lucide-react";

import { Tooltip, TooltipProvider } from "../ui/tooltip";
import { SelectModel } from "./select-model";

interface ChatInputProps {
  readonly onSend: (text: string) => void;
  readonly disabled: boolean;
  readonly selectedModel: string | null;
  readonly onSelectModel: (modelId: string) => void;
}

export function ChatInput({
  onSend,
  disabled,
  selectedModel,
  onSelectModel
}: ChatInputProps) {
  const [text, setText] = useState("");

  const modelConfigured = selectedModel !== null;

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();

    if (!trimmed || disabled || !modelConfigured) return;

    onSend(trimmed);
    setText("");
  }, [text, disabled, modelConfigured, onSend]);

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
        <div className="mx-auto rounded-md border border-input bg-card">
          <textarea
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder-muted-foreground outline-none"
            placeholder={modelConfigured ? "Type a message..." : "Select a model first..."}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || !modelConfigured}
          />
          <div className="flex items-center justify-between px-3 pb-2">
            <SelectModel
              selectedModel={selectedModel}
              onSelect={onSelectModel}
            />

            {modelConfigured ? (
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
