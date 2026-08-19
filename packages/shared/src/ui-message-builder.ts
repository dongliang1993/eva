import type { RunAgentStreamEvent, StreamTokenUsage } from "./stream-events.js";
import type {
  EvaDynamicToolPart,
  EvaMessageMetadata,
  EvaUIMessage,
  EvaUIMessagePart
} from "./ui-message.js";

/**
 * 把 harness 的流事件累积成一条 assistant UIMessage。
 *
 * server 用它产出待落库的消息,web 用它产出待渲染的消息 —— 两边必须逐字节
 * 一致,所以只能有一份实现,放在 shared。
 *
 * 【T2 注意】等 LeadAgent 收敛成 streamText + stopWhen 之后,server 侧可以
 * 直接用 SDK 的 onFinish/toUIMessageStream 拿到原生 UIMessage,届时 server
 * 侧改为直接消费,本 builder 只保留给 web。
 */
export class UiMessageBuilder {
  private readonly parts: EvaUIMessagePart[] = [];
  private readonly toolIndexByCallId = new Map<string, number>();
  private textIndex: number | undefined;
  private readonly startedAt: number;
  private firstTextAt: number | undefined;
  private usage: StreamTokenUsage | undefined;

  constructor(
    private readonly id: string,
    startedAt: number = Date.now()
  ) {
    this.startedAt = startedAt;
  }

  push(event: RunAgentStreamEvent): void {
    switch (event.type) {
      case "step-start":
        this.parts.push({ type: "step-start" });
        // 新 step 起新的 text part:工具调用前后的正文不该被粘成一段。
        this.textIndex = undefined;
        break;

      case "text-delta":
        this.firstTextAt ??= Date.now();
        this.appendText(event.textDelta);
        break;

      case "tool-call":
        this.toolIndexByCallId.set(event.toolCallId, this.parts.length);
        this.parts.push({
          type: "dynamic-tool",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          state: "input-available",
          input: event.input
        });
        // 工具之后的正文另起一段。
        this.textIndex = undefined;
        break;

      case "tool-result":
        this.settleTool(event);
        break;

      case "finish":
        this.usage = event.usage;
        break;

      // reasoning-delta 只推前端不落库(无 signature 的 reasoning 回灌会被
      // 部分 provider 拒绝);tool-input-start/-delta 是 input 的流式过程,
      // tool-call 会带上完整 input;error 由调用方处理成 metadata。
      // notice-injected 是消息边界信号(S7),它自己会成为一条独立的主链消息 ——
      // 绝不能进 assistant 的 parts,否则通知文本会重复出现在回应里。
      default:
        break;
    }
  }

  /** 流式期间取当前快照(每次返回新对象,可直接进 React state)。 */
  snapshot(metadata?: EvaMessageMetadata): EvaUIMessage {
    return {
      id: this.id,
      role: "assistant",
      parts: [...this.parts],
      metadata: { ...this.derivedMetadata(), ...metadata }
    };
  }

  /** 终态:把仍在 streaming 的 text part 收成 done。 */
  build(metadata?: EvaMessageMetadata): EvaUIMessage {
    const parts = this.parts.map((part) =>
      part.type === "text" && part.state === "streaming"
        ? { ...part, state: "done" as const }
        : part
    );

    return {
      id: this.id,
      role: "assistant",
      parts,
      metadata: { ...this.derivedMetadata(), ...metadata }
    };
  }

  private derivedMetadata(): EvaMessageMetadata {
    return {
      durationMs: Date.now() - this.startedAt,
      ...(this.firstTextAt !== undefined
        ? { thinkingDurationMs: this.firstTextAt - this.startedAt }
        : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {})
    };
  }

  private appendText(delta: string): void {
    if (this.textIndex === undefined) {
      this.textIndex = this.parts.length;
      this.parts.push({ type: "text", text: delta, state: "streaming" });

      return;
    }

    const current = this.parts[this.textIndex];

    if (current?.type !== "text") {
      return;
    }

    this.parts[this.textIndex] = { ...current, text: current.text + delta };
  }

  private settleTool(event: Extract<RunAgentStreamEvent, { type: "tool-result" }>): void {
    const index = this.toolIndexByCallId.get(event.toolCallId);

    if (index === undefined) {
      return;
    }

    const current = this.parts[index];

    if (current?.type !== "dynamic-tool") {
      return;
    }

    const settled: EvaDynamicToolPart = event.status === "error"
      ? {
        type: "dynamic-tool",
        toolName: current.toolName,
        toolCallId: current.toolCallId,
        state: "output-error",
        input: current.input,
        errorText: event.output,
        ...(event.durationMs !== undefined
          ? { toolMetadata: { durationMs: event.durationMs } }
          : {})
      }
      : {
        type: "dynamic-tool",
        toolName: current.toolName,
        toolCallId: current.toolCallId,
        state: "output-available",
        input: current.input,
        output: event.output,
        ...(event.durationMs !== undefined
          ? { toolMetadata: { durationMs: event.durationMs } }
          : {})
      };

    this.parts[index] = settled;
  }
}