import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 距底多少像素内算「贴底」。
 * 取 80px:约等于一行半正文的高度 —— 用户滚开一点点仍然算在看最新内容,
 * 明确往上翻(超过一行半)才停止自动跟随。
 */
const STICK_THRESHOLD_PX = 80;

export interface StickToBottom {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  /** 当前是否贴底(用于决定要不要显示「回到底部」按钮)。 */
  readonly isAtBottom: boolean;
  /** 强制滚到底(用户发消息时调用)。 */
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * 贴底跟随。
 *
 * 为什么不用 scrollIntoView({behavior:"smooth"}):流式期间内容每帧增长,
 * 每帧重新发起一次平滑滚动会互相打断,视觉上是抖动。贴底跟随用瞬时
 * scrollTop 赋值,平滑只留给「用户发出新消息」这一个时刻。
 *
 * @param dependency 内容变化的信号(传流式消息或其 parts 长度)
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

  // 监听用户滚动,更新贴底状态(ref 与 state 双写:ref 给下面的
  // layout effect 同步读,state 只驱动「回到底部」按钮的显隐)
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