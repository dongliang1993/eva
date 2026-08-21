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
  /** 主图标(如 ⚡/🧠/📄);不传则行首没有图标位。 */
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  /**
   * 行首状态点(如失败的红点,参考 dsh 的 ● Code · Error 行)。
   * 占用 icon 槽位(与 icon 二选一):同 16px、同 margin-right,
   * 同样参与 hover 就地换向下箭头的交互。
   */
  readonly leadingDot?: ReactNode;
  /** 行右侧的状态/元信息(成功/失败/时长…),可空。 */
  readonly trailing?: ReactNode;
  /** 展开区内容;undefined 表示不可展开。 */
  readonly children?: ReactNode;
  /**
   * 自动展开提示:true 时强制展开(用于"流式期间铺开给用户看实时推理")。
   * 只是 overlay 提示,不接管展开/收起 —— 用户点击永远以自己的 state 为准,
   * open 转 false 时回落自管理。
   */
  readonly open?: boolean;
  /** 每次切换展开态时通知外层(用于"首次展开触发数据拉取"这类副作用)。 */
  readonly onToggle?: () => void;
}

export function DisclosureRow({ icon, title, leadingDot, trailing, children, onToggle, open }: DisclosureRowProps) {
  const [selfOpen, setSelfOpen] = useState(false);
  const expandable = children !== undefined;
  // open 是流式期间的自动展开提示,和用户点击攒出的 selfOpen 取或 ——
  // 流式中必展开,收口后照自管理,用户永远能自己开合。
  const expanded = open === true || selfOpen;
  // 状态点与图标共用一个 16px 槽位:布局不因有无状态点而抖动。
  const leading = leadingDot ?? icon;

  return (
    <div className="flex min-w-0 w-full flex-col">
      <button
        type="button"
        className="group flex h-6 min-w-0 cursor-pointer items-center overflow-hidden text-left transition-colors hover:text-foreground"
        onClick={() => {
          if (expandable) {
            setSelfOpen((v) => !v);
            onToggle?.();
          }
        }}
        aria-expanded={expandable ? expanded : undefined}
      >
        {leading !== undefined ? (
          <span className="relative mr-1.5 inline-flex h-4 w-4 flex-none items-center justify-center text-secondary-text">
            <span className={`inline-flex items-center justify-center transition-opacity duration-100 ${expandable ? "group-hover:opacity-0" : ""}`}>
              {leading}
            </span>
            {/* 展开提示不单独占位:可展开的行 hover 时前面的 icon/dot 就地变成向下箭头。 */}
            {expandable ? (
              <span className="absolute inset-0 inline-flex items-center justify-center text-secondary-text opacity-0 transition-opacity duration-100 group-hover:opacity-100">
                <ChevronDown size={16} />
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="flex-none truncate text-sm leading-6 text-secondary-text">
          {title}
        </span>
        {trailing !== undefined ? (
          <span className="ml-2 flex flex-none items-center gap-1.5">{trailing}</span>
        ) : null}
      </button>

      {expandable && expanded ? (
        <div className="py-1 pl-6 text-sm leading-relaxed text-secondary-text">
          {children}
        </div>
      ) : null}
    </div>
  );
}