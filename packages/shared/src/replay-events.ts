import type { RunAgentStreamEvent } from "./stream-events.js";
import type { EvaUIMessage } from "./ui-message.js";
import { toolPartOutput } from "./ui-message.js";

/**
 * 把一条在飞的 assistant 消息反推成等价的流事件序列 —— SSE 重连时补历史用。
 *
 * 为什么不直接发快照:`UiMessageBuilder` 的内部索引(textIndex / reasoningIndex /
 * toolIndexByCallId)只由 push() 建立,没有任何种子化入口。发合成帧则让重连的客户端
 * 走与全新 run **完全相同**的代码路径 —— builder 与 run-stream-client 的 dispatch
 * 都不需要为重连开分支。
 *
 * 这是 `UiMessageBuilder.push` 的逆运算,两者必须同步演进 ——
 * tests/replay-events.test.ts 用 round-trip 性质把这条契约钉住。
 */
export const replayEventsFor = (
  message: EvaUIMessage
): readonly RunAgentStreamEvent[] => {
  const events: RunAgentStreamEvent[] = [];
  let step = 0;

  for (const part of message.parts) {
    switch (part.type) {
      case "step-start":
        events.push({ type: "step-start", step: step++ });
        break;

      // 整段文本一次发完:builder 对 delta 只做字符串拼接,分几次发结果一样。
      case "text":
        events.push({ type: "text-delta", textDelta: part.text });
        break;

      case "reasoning":
        events.push({ type: "reasoning-delta", textDelta: part.text });
        break;

      case "dynamic-tool": {
        events.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: (part.input ?? {}) as Record<string, unknown>
        });

        // input-available = 还没结算(工具正在跑),只回放调用本身。
        if (part.state === "output-available" || part.state === "output-error") {
          events.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toolPartOutput(part),
            status: part.state === "output-error" ? "error" : "success",
            // toolMetadata 是宽松的 JSONValue 记录,窄回 number 再传。
            ...(typeof part.toolMetadata?.durationMs === "number"
              ? { durationMs: part.toolMetadata.durationMs }
              : {})
          });
        }
        break;
      }

      // finish 不回放:usage 只在真正终态才有,重放的是"中途"。
      // 其余 part 类型(file / source / tool-<NAME> 静态工具)当前 harness 不产出。
      default:
        break;
    }
  }

  return events;
};
