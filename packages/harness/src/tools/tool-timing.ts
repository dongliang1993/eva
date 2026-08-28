/**
 * 工具三段计时的 run-scoped 汇聚点(T50)。
 *
 * 三个 wrapper 分处不同文件、彼此不认识,但都拿得到 toolCallId ——
 * 审批(withApproval)、并发帽(withConcurrencyCap)、真实执行(withExecTiming)
 * 各自往里 record;mapper 收到 tool-result 时 take 取走完整快照(交给 SSE/observer)。
 *
 * 与 agent.ts 的 clock 是两张表,职责不同,不要合并:
 * clock 管在飞集合(abort 补发要枚举),这张只管分段耗时。
 *
 * 缺省语义:无审批、无排队时对应字段是 0,不是 undefined ——
 * undefined 会让「没等」和「没测」分不清(契约:被 plan gate 挡掉的调用三段全 0 是正常结果)。
 */
export type ToolTimingPhase = "approval" | "queue" | "exec";

export interface ToolTimingSnapshot {
  readonly approvalWaitMs: number;
  readonly queueWaitMs: number;
  readonly execMs: number;
  readonly execAborted: boolean;
}

export interface ToolTimingState {
  record(
    toolCallId: string,
    phase: ToolTimingPhase,
    ms: number,
    meta?: { aborted?: boolean }
  ): void;
  /** 一次性取走(取走即删)。没 record 过的 toolCallId 也返回全 0 快照。 */
  take(toolCallId: string): ToolTimingSnapshot;
}

interface MutableTiming {
  approvalWaitMs: number;
  queueWaitMs: number;
  execMs: number;
  execAborted: boolean;
}

const zeroTiming = (): MutableTiming => ({
  approvalWaitMs: 0,
  queueWaitMs: 0,
  execMs: 0,
  execAborted: false
});

/** 实例由 createAgent 按 run 创建 —— 与 Agent 实例同寿,两个 run 不共享。 */
export const createToolTimingState = (): ToolTimingState => {
  const timings = new Map<string, MutableTiming>();

  return {
    record(toolCallId, phase, ms, meta) {
      const entry = timings.get(toolCallId) ?? zeroTiming();
      switch (phase) {
        case "approval":
          entry.approvalWaitMs += ms;
          break;
        case "queue":
          entry.queueWaitMs += ms;
          break;
        case "exec":
          entry.execMs += ms;
          if (meta?.aborted === true) {
            entry.execAborted = true;
          }
          break;
      }
      timings.set(toolCallId, entry);
    },
    take(toolCallId) {
      const entry = timings.get(toolCallId) ?? zeroTiming();
      timings.delete(toolCallId);
      return { ...entry };
    }
  };
};
