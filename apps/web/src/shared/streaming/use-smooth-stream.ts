import { useEffect, useRef, useState } from "react";

/**
 * rAF 字符泵（三红线 ②，01 §3.2 ② / 10 §6）。
 *
 * LLM token 突发到达,若每个 chunk 都触发 React setState,渲染会顿挫。
 * 本 hook 把「实时全文 target」与「屏幕上显示的 displayed」解耦:
 * - 原始流式内容实时写入 targetRef
 * - 每帧(rAF)按当前 CPS 从 buffer 放字符到 displayed
 * - CPS 用 EMA(alpha=0.15) 跟踪真实到达速率,突发时自动加速,空闲时回落
 * - 积压超出阈值进入 flush 加速,避免无限追不上
 *
 * 返回 { content, isAnimating } —— 组件只渲染 content。
 */

const MIN_CPS = 15;
const MAX_CPS = 300;
const DEFAULT_CPS = 50;
const EMA_ALPHA = 0.15;
const LARGE_APPEND = 500;
const FLUSH_MAX_SECONDS = 4;
const MAX_FLUSH_CPS = 90;

export interface SmoothStreamResult {
  readonly content: string;
  readonly isAnimating: boolean;
}

/**
 * alignSliceEnd —— 不切断 UTF-16 surrogate pair, 保证 emoji 等按字符边界切。
 * cps 可能一次放多个字符, bp 落在 surrogate 中间时往后挪一个 code unit。
 */
const alignSliceEnd = (text: string, end: number): number => {
  const code = text.charCodeAt(end);
  if (code >= 0xd800 && code <= 0xdbff) {
    return end + 1;
  }
  return end;
};

export function useSmoothStream(target: string): SmoothStreamResult {
  const [displayed, setDisplayed] = useState("");
  const targetRef = useRef("");
  const displayedRef = useRef(0); // 已渲染 char 数
  const cpsRef = useRef(DEFAULT_CPS);
  const lastTimeRef = useRef<number | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);

  // 实时全文更新到 targetRef; 若增量很大视为突发, 记录以便加速
  useEffect(() => {
    const prev = targetRef.current;
    targetRef.current = target;
    const appended = target.length - prev.length;

    const dt = lastTimeRef.current
      ? (performance.now() - lastTimeRef.current) / 1000
      : 0;
    lastTimeRef.current = performance.now();

    if (dt > 0) {
      const instantCps = appended / dt;
      cpsRef.current = Math.max(
        MIN_CPS,
        Math.min(MAX_CPS, cpsRef.current * (1 - EMA_ALPHA) + instantCps * EMA_ALPHA)
      );
    }

    if (appended >= LARGE_APPEND) {
      cpsRef.current = Math.max(cpsRef.current, MAX_FLUSH_CPS);
    }
  }, [target]);

  useEffect(() => {
    const tick = (now: number): void => {
      const elapsed = lastTimeRef.current !== undefined
        ? (now - lastTimeRef.current) / 1000
        : 0;
      if (elapsed > 0) {
        lastTimeRef.current = now;
      }

      const full = targetRef.current;
      const remaining = full.length - displayedRef.current;

      // 积压判定: 剩余超过「当前速率跑 FLUSH_MAX_SECONDS 的量」进 flush
      const backlog = remaining - cpsRef.current * FLUSH_MAX_SECONDS;
      const cps = backlog > 0
        ? Math.min(MAX_CPS, Math.max(cpsRef.current, MAX_FLUSH_CPS))
        : cpsRef.current;

      const chars = Math.max(1, Math.round(cps * elapsed));
      const nextEnd = Math.min(full.length, displayedRef.current + chars);
      const aligned = alignSliceEnd(full, nextEnd);

      if (aligned !== displayedRef.current) {
        displayedRef.current = aligned;
        setDisplayed(full.slice(0, aligned));
      }

      // 继续泵直到追上全文
      if (displayedRef.current < full.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = undefined;
        // 追平后仍允许一次最终 setState
        if (targetRef.current !== full) {
          rafRef.current = requestAnimationFrame(tick);
        }
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
    };
  }, []);

  const isAnimating = displayed.length < targetRef.current.length;

  return { content: displayed, isAnimating };
}