import { useEffect, useRef } from "react";

import { useModels } from "../../../../../shared/hooks/use-models";
import { ModelSelect } from "../../../../../shared/ui/model-select";

interface SelectModelProps {
  readonly selectedModel: string | null;
  readonly onSelect: (modelId: string) => void;
}

export function SelectModel({ selectedModel, onSelect }: SelectModelProps) {
  const { data: models = [] } = useModels();

  // 模型是 per-thread 选择,不落全局 settings —— 新会话没选过时默认第一个可用模型,
  // 保证"能发送"(发送按钮要求有 modelId)。用户切换只影响当前会话。
  const defaultedRef = useRef(false);

  useEffect(() => {
    if (defaultedRef.current || selectedModel || models.length === 0) {
      return;
    }

    defaultedRef.current = true;
    onSelect(models[0]!.id);
  }, [models, onSelect, selectedModel]);

  return (
    <ModelSelect
      models={models}
      value={selectedModel}
      onChange={onSelect}
      side="top"
      triggerClassName="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
    />
  );
}
