import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * 可折叠披露行 —— DeepSeek Harness 风格。
 *
 * 不是卡片:一条 24px 高的扁平行(_row_9cl6j_10 height:24),
 * 无边框、无底色,只有 [chevron][icon][title] 一条铺满宽的细行 + 右侧
 * 状态;body 折叠在行下方缩进对齐。对齐 dsh disclosure(__leading 16px,
 * _title 14px / line-height 24)。
 */
interface DisclosureRowProps {
  /** 主图标(如 ⚡/🧠/📄)。 */
  readonly icon: ReactNode;
  readonly title: ReactNode;
  /** 行右侧的状态/元信息(成功/失败/时长…),可空。 */
  readonly trailing?: ReactNode;
  /** 展开区内容;undefined 表示不可展开。 */
  readonly children?: ReactNode;
  /** 每次切换展开态时通知外层(用于"首次展开触发数据拉取"这类副作用)。 */
  readonly onToggle?: () => void;
}

export function DisclosureRow({ icon, title, trailing, children, onToggle }: DisclosureRowProps) {
  const [expanded, setExpanded] = useState(false);
  const expandable = children !== undefined;

  return (
    <div className="flex min-w-0 w-full flex-col">
      <button
        type="button"
        className="group flex h-6 min-w-0 cursor-pointer items-center overflow-hidden text-left transition-colors hover:text-foreground"
        onClick={() => {
          if (expandable) {
            setExpanded((v) => !v);
            onToggle?.();
          }
        }}
        aria-expanded={expandable ? expanded : undefined}
      >
        <span className="relative mr-1.5 inline-flex h-4 w-4 flex-none items-center justify-center text-secondary-foreground">
          <span className={`transition-opacity duration-100 ${expandable ? "group-hover:opacity-0" : ""}`}>
            {icon}
          </span>
          {/* 展开提示不单独占位:可展开的行 hover 时前面的 icon 就地变成向下箭头。 */}
          {expandable ? (
            <span className="absolute inset-0 inline-flex items-center justify-center text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100">
              <ChevronDown size={14} />
            </span>
          ) : null}
        </span>
        <span className="ml-1.5 flex-none truncate text-sm leading-6 text-secondary-foreground">
          {title}
        </span>
        {trailing !== undefined ? (
          <span className="ml-2 flex flex-none items-center gap-1.5">{trailing}</span>
        ) : null}
      </button>

      {expandable && expanded ? (
        <div className="mt-0.5 pl-2 text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}