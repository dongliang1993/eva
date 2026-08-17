import { memo } from "react";
import { parseMarkdownIntoBlocks, Streamdown } from "streamdown";

interface StreamMarkdownProps {
  readonly content: string;
  /** 流式中: 允许半成品 markdown 解析 + 只重渲尾部块; 静态: 全量解析 */
  readonly isStreaming?: boolean;
  readonly className?: string;
}

/**
 * 流式安全的 Markdown 渲染封装（三红线 ③, 01 §3.2 ③ / 10 §6）。
 *
 * Streamdown 内建「分块 + memo」: 传入 parseMarkdownIntoBlocksFn 切分全文为块,
 * 每块由 memo 的 Block 渲染 —— 增量流下只有最后一个未完成块重解析重渲染,
 * 已完成块 memo 命中零开销。避免流式长文整篇重渲卡顿。
 *
 * shared/ 归属: threads 主消息 + skills 预览 + 扩展产物都要流式渲染 markdown,
 * 提升到 shared/markdown 避免每处复制整套流式配置。
 * @returns Serialized markdown rendered into JSX.
 */
function StreamMarkdownImpl({
  content,
  isStreaming,
  className
}: StreamMarkdownProps) {
  return (
    <Streamdown
      className={className}
      mode={isStreaming ? "streaming" : "static"}
      parseIncompleteMarkdown={isStreaming}
      parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocks}
      isAnimating={isStreaming}
    >
      {content}
    </Streamdown>
  );
}

export const StreamMarkdown = memo(StreamMarkdownImpl);