import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import type { StreamToolCallSummary, StreamTokenUsage } from "@eva/shared";

import type { AgentTool } from "../tools/index.js";
import { toToolSet, TOOL_CALL_ABORTED_OUTPUT } from "../tools/index.js";
import {
  DEFAULT_READ_ONLY_CONCURRENCY,
  Semaphore,
  withConcurrencyCap,
} from "../tools/concurrency-cap.js";
import { withApproval } from "../tools/with-approval.js";
import { buildAgentSystemPrompt } from "../prompts/prompt-builder.js";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  type AgentObserver,
  type AgentTelemetryEvent,
  type ContextCompactionReason,
  type LoopTransitionReason,
  type TokenUsage,
} from "./observer.js";
import {
  resolveContextWindowPolicy,
  type ContextWindowPolicy,
  type ContextWindowPolicyOptions,
} from "../context/policy.js";
import { isReactiveCompactCandidateError } from "../models/errors.js";
import {
  applyReactiveLoopCompactWithStats,
  estimateMessagesTokens,
  type RuntimeCompactResult,
} from "../context/runtime-compact.js";
import { coalesceTextDeltas } from "./coalesce-stream.js";
import { createRepairToolCall } from "./repair-tool-call.js";
import {
  applyToolCountSafetyNet,
  TOOL_COUNT_SAFETY_LIMIT,
} from "./tool-safety-net.js";
import {
  createPrepareStep,
  MAX_OUTPUT_CONTINUATION_MESSAGE,
  shouldContinueForMaxOutput,
} from "./context-strategy.js";
import { mapStreamPart, type ToolCallClock } from "./stream-part-mapper.js";
import type {
  AgentCallSettings,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolCallResult,
  Agent as AgentInterface,
  CreateAgentOptions,
} from "./types.js";

type FinishReason = "stop" | "aborted" | "error" | "max-steps";

/**
 * 收尾前等后台子代理交付结论的宽限期(S7 push)。
 *
 * 一次 HTTP = 一个 run,SSE 在 run 结束时关闭 —— 超过这个窗口才报的子代理,
 * 结果只落库(卡片可展开看),模型不再主动回应。给得太长会让每轮对话都卡着等,
 * 太短则常见的几秒级子任务白白错过注入。
 */
const NOTICE_GRACE_MS = 20_000;

/** 一个 run 内最多因通知续跑几圈 —— 防子代理互相唤起的病态循环。 */
const MAX_NOTICE_ROUNDS = 4;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const toStreamTokenUsage = (u: TokenUsage): StreamTokenUsage => ({
  inputTokens: u.promptTokens,
  outputTokens: u.completionTokens,
  totalTokens: u.totalTokens,
});

const toStreamToolCallSummary = (
  tc: AgentToolCallResult,
): StreamToolCallSummary => ({
  toolName: tc.toolName,
  toolCallId: tc.toolCallId ?? "",
  args: tc.args,
  output: tc.output,
  status: tc.status,
  ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
});

const formatContext = (
  context: Record<string, unknown> | undefined,
): string | undefined =>
  !context || Object.keys(context).length === 0
    ? undefined
    : `Additional context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;

const readTokenUsage = (
  u:
    | {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        totalTokens: number | undefined;
      }
    | undefined,
): TokenUsage | undefined => {
  if (!u) return undefined;
  const promptTokens = u.inputTokens ?? 0;
  const completionTokens = u.outputTokens ?? 0;
  const totalTokens = u.totalTokens ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0)
    return undefined;
  return { promptTokens, completionTokens, totalTokens };
};

const resolveSystemMessage = (
  prompt: string | SystemModelMessage | undefined,
): SystemModelMessage =>
  typeof prompt === "object" && prompt !== null && prompt.role === "system"
    ? prompt
    : {
        role: "system",
        content:
          (typeof prompt === "string" ? prompt : undefined)?.trim() ||
          buildAgentSystemPrompt(),
      };

/**
 * 终态文本兜底。max-steps 分支必须带**实际步数**(100 撞顶与 3 撞顶的诊断含义
 * 完全不同,且测试传小值时文案说小值,硬编码会让断言变成谎言)与**继续路径**
 * (主链消息都在,新一轮 run 能接着干 —— 但用户不知道,得告诉它)。
 * 空响应分支按"整个 run 累计文本为空"判。
 */
const finalText = (
  accumulated: string,
  isMaxSteps: boolean,
  maxSteps: number,
): string =>
  isMaxSteps
    ? `The agent reached the maximum tool-calling steps (${maxSteps}) without producing a final answer. ` +
      "The work so far is preserved in this conversation — ask me to continue and I'll pick up where I left off."
    : accumulated.trim() || "The model returned an empty response.";

interface AgentOptions {
  model: LanguageModel;
  tools?: AgentTool[];
  systemPrompt?: string | SystemModelMessage;
  maxSteps?: number;
  observer?: AgentObserver;
  /** T18:repairToolCall 修复模型。可选,不传 = SDK 默认(校验失败直接报错)。 */
  repairModel?: LanguageModel;
  contextPolicy?: ContextWindowPolicyOptions;
  callSettings?: AgentCallSettings;
  /** T25:工具超时配置,条件装配进 streamText 的 timeout。不传 = 现状(无超时)。 */
  toolTimeout?: { toolMs: number; tools?: Record<string, number> };
  /** T24:只读工具并发帽。不传 = DEFAULT_READ_ONLY_CONCURRENCY(10)。 */
  readOnlyConcurrency?: number;
  /** T38:钳制目标(providerId+modelId)。传了才在真实超限时 emit context_overflow_clamp。 */
  clampTarget?: { providerId: string; modelId: string };
}

/**
 * 模块内部实现,不导出 —— createAgent 是造 agent 的唯一入口。
 * 审批(withApproval)、修复(repairToolCall)等横切全部收敛在那里装配,
 * 任何人 new 不了这个类 = 闸门没有可绕过的第二条路。
 * (类名与 types.ts 的 Agent 接口同名,import 时别名 AgentInterface 避让。)
 */
class Agent implements AgentInterface {
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly systemMessage: SystemModelMessage;
  private readonly maxSteps: number;
  private readonly observer: AgentObserver | undefined;
  private readonly contextPolicy: ContextWindowPolicy;

  constructor(private readonly options: AgentOptions) {
    this.toolsByName = new Map(
      (options.tools ?? []).map((tool) => [tool.name, tool]),
    );
    this.systemMessage = resolveSystemMessage(options.systemPrompt);
    this.maxSteps = options.maxSteps ?? 5;
    this.observer = options.observer;
    this.contextPolicy = resolveContextWindowPolicy(options.contextPolicy);
  }

  private emit(event: AgentTelemetryEvent): void {
    try {
      this.observer?.(event);
    } catch {
      // Observer errors must never break the agent loop
    }
  }

  private emitCompaction(
    step: number,
    reason: ContextCompactionReason,
    result: RuntimeCompactResult,
  ): void {
    this.emit({
      type: "context_compacted",
      step,
      reason,
      messageCountBefore: result.messageCountBefore,
      messageCountAfter: result.messageCountAfter,
      estimatedTokensBefore: result.estimatedTokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter,
    });
  }

  private emitTransition(
    step: number,
    reason: LoopTransitionReason,
    attempt?: number,
  ): void {
    this.emit({
      type: "loop_transition",
      step,
      reason,
      ...(attempt !== undefined ? { attempt } : {}),
    });
  }

  // messages 不含 system prompt —— 它由 createPrepareStep 作为 instructions 第一条注入
  // (streamText 顶层 messages 不允许 system 角色)。prefixMessageCount 只算 context 消息条数。
  private buildMessages(input: AgentRunInput): ModelMessage[] {
    const context = formatContext(input.context);
    return [
      ...(context ? [{ role: "user", content: context } as ModelMessage] : []),
      ...input.messages,
    ];
  }

  private resolveTools(input: AgentRunInput): Map<string, AgentTool> {
    if (!input.additionalTools || input.additionalTools.length === 0)
      return this.toolsByName;
    const merged = new Map(this.toolsByName);
    for (const tool of input.additionalTools) merged.set(tool.name, tool);
    return merged;
  }

  async invoke(input: AgentRunInput): Promise<AgentRunResult> {
    let result: AgentRunResult | undefined;
    for await (const event of this.run(input)) {
      if (event.type === "finish") {
        result = {
          text: event.text,
          toolCalls: event.toolCalls as AgentToolCallResult[],
        };
      }
    }
    if (!result) throw new Error("Agent finished without a result.");
    return result;
  }

  async *stream(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    try {
      yield* coalesceTextDeltas(this.run(input));
    } catch (error) {
      // abort: run() 已 yield finish(aborted);SDK 在 yield 前抛 AbortError 时这里静默收尾。
      if (!isAbortError(error)) {
        yield {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  }

  private async *run(input: AgentRunInput): AsyncGenerator<AgentStreamEvent> {
    const runStart = Date.now();
    // T39 安全网:显式 activeToolNames 优先;没设且超 40 → 退化最小集 + 事件。
    const resolvedTools = this.resolveTools(input);
    const { tools: netTools, degraded } = applyToolCountSafetyNet(
      resolvedTools,
      input.activeToolNames,
    );
    if (degraded) {
      this.emit({
        type: "tool_count_degraded",
        totalCount: resolvedTools.size,
        keptCount: netTools.size,
        limit: TOOL_COUNT_SAFETY_LIMIT,
      });
    }
    const toolSet: ToolSet = toToolSet([...netTools.values()]);
    const maxSteps = input.maxSteps ?? this.maxSteps;
    const clock: ToolCallClock = new Map();
    const toolCalls: AgentToolCallResult[] = [];

    let messages = this.buildMessages(input);
    const prefixMessageCount = messages.length;
    let stepsUsed = 0;
    let recoveries = 0;
    let noticeRounds = 0;
    let hasCompactedReactively = false;
    let continuedText = "";
    let totalTokens: TokenUsage = ZERO_TOKEN_USAGE;
    let stepStartTime = runStart;
    // T36: 上一步真实 inputTokens,prepareStep 的 compact 判定用它(真值优先,首步 undefined 退估算)。
    let lastStepInputTokens: number | undefined;

    this.emit({ type: "agent_run_start" });

    // 外层 restart:只有 max-output 续写与 reactive compact 会走到第二圈。
    for (;;) {
      // step 预算耗尽 → 直接 max-steps 终态,不再发起调用。
      if (maxSteps - stepsUsed <= 0) {
        yield this.finish(
          continuedText,
          toolCalls,
          "max-steps",
          totalTokens,
          runStart,
          stepsUsed,
        );
        return;
      }

      const prepareStep = createPrepareStep({
        policy: this.contextPolicy,
        systemPrompt: this.systemMessage,
        prefixMessageCount,
        onCompacted: (result) => {
          this.emitCompaction(stepsUsed, "proactive_loop_compact", result);
          this.emitTransition(stepsUsed, "proactive_loop_compact");
        },
        getLastStepInputTokens: () => lastStepInputTokens,
      });

      const result = streamText({
        model: this.options.model,
        messages,
        tools: toolSet,
        stopWhen: stepCountIs(maxSteps - stepsUsed),
        prepareStep,
        ...(this.options.repairModel !== undefined
          ? {
              repairToolCall: createRepairToolCall({
                repairModel: this.options.repairModel,
                emit: (event) => this.emit(event),
              }),
            }
          : {}),
        ...(input.abortSignal !== undefined
          ? { abortSignal: input.abortSignal }
          : {}),
        ...(this.options.toolTimeout !== undefined
          ? { timeout: this.options.toolTimeout }
          : {}),
        ...(this.options.callSettings?.temperature !== undefined
          ? { temperature: this.options.callSettings.temperature }
          : {}),
        ...(this.options.callSettings?.maxOutputTokens !== undefined
          ? { maxOutputTokens: this.options.callSettings.maxOutputTokens }
          : {}),
        onStepStart: () => {
          stepStartTime = Date.now();
          this.emit({ type: "llm_call_start", step: stepsUsed });
        },
        onStepEnd: ({ usage, toolCalls: stepToolCalls }) => {
          const stepIndex = stepsUsed;
          stepsUsed += 1;
          const stepUsage = readTokenUsage(usage);
          if (stepUsage) totalTokens = addTokenUsage(totalTokens, stepUsage);
          // T36: 存上一步真实 inputTokens,供下一步 prepareStep 的 compact 判定。
          // 0 视为「模型没报 inputTokens」→ undefined 退估算,别拿 0 当真值(会误判不溢出)。
          lastStepInputTokens =
            stepUsage && stepUsage.promptTokens > 0
              ? stepUsage.promptTokens
              : undefined;
          this.emit({
            type: "llm_call_end",
            step: stepIndex,
            durationMs: Date.now() - stepStartTime,
            ...(stepUsage !== undefined ? { tokenUsage: stepUsage } : {}),
            hasToolCalls: stepToolCalls.length > 0,
          });
        },
        onError: () => {
          // 错误以 'error' part 出现在 stream 里,这里只防 unhandled rejection。
        },
      });

      let text = "";
      let aborted = false;
      let streamError: unknown;

      try {
        for await (const part of result.stream) {
          // SDK 不保证对忽略 abortSignal 的 provider 流强制中断(尤其本地/mock 流),
          // 每个 part 消费前显式检查一次,确保 abort 确定性生效。
          if (input.abortSignal?.aborted) {
            aborted = true;
            break;
          }

          if (part.type === "start-step") {
            yield { type: "step-start", step: stepsUsed };
            continue;
          }

          if (part.type === "text-delta") {
            text += part.text;
          }

          const mapped = mapStreamPart(part, clock);

          if (mapped.error !== undefined) {
            streamError = mapped.error;
            break;
          }
          if (mapped.aborted === true) {
            aborted = true;
            break;
          }

          if (mapped.toolCall !== undefined) {
            toolCalls.push(mapped.toolCall);
            this.emit({
              type: "tool_call_completed",
              step: stepsUsed,
              toolName: mapped.toolCall.toolName,
              toolCallId: mapped.toolCall.toolCallId ?? "",
              status: mapped.toolCall.status,
              durationMs: mapped.toolCall.durationMs ?? 0,
            });
          }

          if (mapped.event !== undefined) {
            // tool-call 事件补一个 tool_call_initiated 观测点(mapStreamPart 不打观测)。
            if (mapped.event.type === "tool-call") {
              this.emit({
                type: "tool_call_initiated",
                step: stepsUsed,
                toolName: mapped.event.toolName,
                toolCallId: mapped.event.toolCallId,
              });
            }
            yield mapped.event;
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          aborted = true;
        } else {
          streamError = error;
        }
      }

      // ---- reactive compact:上下文溢出类错误,全程只重试一次 ----
      if (streamError !== undefined) {
        if (isReactiveCompactCandidateError(streamError)) {
          // T38: 真实超限是「该模型 contextWindow 虚高」的实锤 —— emit 钳制事件让 server
          // 永久钳小它的 contextWindow(下次 resolve 生效)。用真值(上一步 usage)优先,
          // 没有就估算。与是否还能 reactive 重试无关,钳制是为下次 run。
          if (this.options.clampTarget) {
            this.emit({
              type: "context_overflow_clamp",
              providerId: this.options.clampTarget.providerId,
              modelId: this.options.clampTarget.modelId,
              contextWindow: this.contextPolicy.contextWindow,
              observedTokens:
                lastStepInputTokens ?? estimateMessagesTokens(messages),
            });
          }
        }
        if (
          !hasCompactedReactively &&
          isReactiveCompactCandidateError(streamError)
        ) {
          const compaction = applyReactiveLoopCompactWithStats(
            messages,
            prefixMessageCount,
          );
          if (compaction.changed) {
            messages = compaction.messages;
            hasCompactedReactively = true;
            this.emitCompaction(
              stepsUsed,
              "reactive_compact_retry",
              compaction,
            );
            this.emitTransition(stepsUsed, "reactive_compact_retry");
            continue;
          }
        }
        // 错误终态:不 yield finish —— run() 抛出,由 stream() 转 error 事件(与重构前一致)。
        throw streamError;
      }

      if (aborted) {
        // T26:SDK 在 abort 时丢弃刚读出的在飞 tool-result(外层拉流循环直接 close),
        // 不给补发的话 UI 卡片永远停在 running、落库 part 悬挂 input-available。
        // clock 里剩下的 entry 就是"已发 tool-call、未收 tool-result"的在飞集合 ——
        // 逐个补一条取消 result,再 yield finish(顺序不能反:SSE 在 finish 后收尾)。
        for (const [toolCallId, inFlight] of clock) {
          clock.delete(toolCallId);
          const output = TOOL_CALL_ABORTED_OUTPUT;
          const durationMs = Date.now() - inFlight.startedAt;
          const canceled: AgentToolCallResult = {
            toolName: inFlight.toolName,
            toolCallId,
            args: {},
            output,
            status: "error",
            durationMs,
          };
          toolCalls.push(canceled);
          this.emit({
            type: "tool_call_completed",
            step: stepsUsed,
            toolName: inFlight.toolName,
            toolCallId,
            status: "error",
            durationMs,
          });
          yield {
            type: "tool-result",
            toolCallId,
            toolName: inFlight.toolName,
            output,
            status: "error",
            durationMs,
          };
        }

        yield this.finish(
          continuedText + text,
          toolCalls,
          "aborted",
          totalTokens,
          runStart,
          stepsUsed,
        );
        return;
      }

      const finishReason = await result.finishReason;

      // ---- max-output 续写 ----
      if (
        shouldContinueForMaxOutput(finishReason, recoveries, this.contextPolicy)
      ) {
        continuedText += text;
        messages = [
          ...(await result.responseMessages),
          {
            role: "user",
            content: MAX_OUTPUT_CONTINUATION_MESSAGE,
          } as ModelMessage,
        ];
        recoveries += 1;
        this.emitTransition(
          stepsUsed,
          "max_output_tokens_recovery",
          recoveries,
        );
        continue;
      }

      // ---- 子代理通知注入(S7 push):模型说完了,但后台子代理可能刚交付结论 ----
      // 条件是"模型正常说完了":aborted 与 error 走不到这里(上面已 return/throw),
      // max-steps 也不注入(步数已耗尽,再续跑只会立刻又撞顶)。
      // 注意 finishReason 是 SDK 的原始值(stop/length/other/tool-calls…),不是本文件
      // 那个窄化的 FinishReason —— 所以按"不是 max-steps"判,别写成 === "stop"
      // (真实供应商常给 "other",那样会静默永不注入)。
      if (
        stepsUsed < maxSteps &&
        input.drainNotices !== undefined &&
        noticeRounds < MAX_NOTICE_ROUNDS
      ) {
        const notices = await input.drainNotices({ graceMs: NOTICE_GRACE_MS });

        if (notices.length > 0) {
          // 先 yield 边界帧:route 靠它把当前 assistant 收口落库,再落通知消息,
          // 然后为续跑新建 builder(见 routes/runs.ts)。必须在改 messages 之前发。
          yield { type: "notice-injected", notices };

          messages = [
            ...(await result.responseMessages),
            {
              role: "user",
              content: notices.map((n) => n.text).join("\n\n"),
            } as ModelMessage,
          ];
          // 与 max-output 续写的关键差异:那里是"同一条消息继续写"所以累加 continuedText,
          // 这里是两条独立 assistant 消息 —— 本轮正文已随上一条 assistant 收口落库,
          // 所以 continuedText 必须保持空,否则续跑那条会把前一条的正文重复一遍。
          // (text 是每圈局部变量,下一圈自然从 "" 开始,无需在此清。)
          continuedText = "";
          noticeRounds += 1;
          this.emitTransition(stepsUsed, "subagent_notice", noticeRounds);
          continue;
        }
      }

      // ---- 终态:stop / max-steps / 空响应 ----
      const isMaxSteps = stepsUsed >= maxSteps;
      if (isMaxSteps) {
        // 撞顶是异常(尤其 100 步撞顶),必须在事件流留痕 —— 否则将来排查
        // "agent 为什么停了"只能问用户要截图。
        this.emitTransition(stepsUsed, "max_steps");
      }
      yield this.finish(
        continuedText + text,
        toolCalls,
        isMaxSteps ? "max-steps" : "stop",
        totalTokens,
        runStart,
        stepsUsed,
      );
      return;
    }
  }

  private finish(
    text: string,
    toolCalls: readonly AgentToolCallResult[],
    finishReason: FinishReason,
    usage: TokenUsage,
    runStart: number,
    stepsUsed: number,
  ): Extract<AgentStreamEvent, { type: "finish" }> {
    this.emit({
      type: "agent_run_end",
      totalDurationMs: Date.now() - runStart,
      stepCount: stepsUsed,
      totalTokenUsage: usage,
      toolCallCount: toolCalls.length,
    });

    return {
      type: "finish",
      text: finalText(text, finishReason === "max-steps", this.maxSteps),
      toolCalls: toolCalls.map(toStreamToolCallSummary),
      finishReason,
      ...(usage.totalTokens > 0 ? { usage: toStreamTokenUsage(usage) } : {}),
      durationMs: Date.now() - runStart,
    };
  }
}

/**
 * 造 agent 的唯一入口,也是本模块唯一的导出 —— Agent 实现类故意不导出,
 * 任何人 new 不了它 = 闸门没有可绕过的第二条路。
 * 横切装配全部收敛在这里:危险工具审批(withApproval)、T18 修复模型……
 */
export const createAgent = (options: CreateAgentOptions): AgentInterface => {
  const { requestApproval, ...rest } = options;

  // T24:只读工具的并发帽。SDK 对一步内的 tool calls 是 Promise.all 全量
  // 并发 —— 20 个 read_file 是内存脉冲,20 个 web_search 是限流/封禁。
  // 只帽 readOnly:写类直通(正确性由 T23 守卫兜底,不该排队)。
  // per-run 生命周期:与 Agent 实例对齐,两个 run 不互相抢帽子。
  const limiter = new Semaphore(
    rest.readOnlyConcurrency ?? DEFAULT_READ_ONLY_CONCURRENCY,
  );

  // 危险工具统一在这一层包装 execute —— 审批逻辑完全收敛到 withApproval。
  // (子代理 fork-join 半成品已在 T4 移除,S7 会从零实现带独立流式通道与消息落库的版本。)
  // 包装顺序:限流在审批内层 —— 审批弹窗可能挂很久,若限流在外层,
  // "排队等帽的只读调用"会占着帽等一个人工确认,帽被审批拖死。
  const capTools = (rest.tools ?? []).map((t) =>
    withConcurrencyCap(t, limiter),
  );
  const tools = requestApproval
    ? capTools.map((t) => withApproval(t, requestApproval))
    : capTools;

  return new Agent({
    model: rest.model,
    ...(tools !== undefined ? { tools } : {}),
    ...(rest.systemPrompt !== undefined
      ? { systemPrompt: rest.systemPrompt }
      : {}),
    ...(rest.maxSteps !== undefined ? { maxSteps: rest.maxSteps } : {}),
    ...(rest.observer !== undefined ? { observer: rest.observer } : {}),
    ...(rest.contextPolicy !== undefined
      ? { contextPolicy: rest.contextPolicy }
      : {}),
    ...(rest.callSettings !== undefined
      ? { callSettings: rest.callSettings }
      : {}),
    ...(rest.repairModel !== undefined
      ? { repairModel: rest.repairModel }
      : {}),
    ...(rest.toolTimeout !== undefined
      ? { toolTimeout: rest.toolTimeout }
      : {}),
    ...(rest.readOnlyConcurrency !== undefined
      ? { readOnlyConcurrency: rest.readOnlyConcurrency }
      : {}),
    ...(rest.clampTarget !== undefined
      ? { clampTarget: rest.clampTarget }
      : {}),
  });
};
