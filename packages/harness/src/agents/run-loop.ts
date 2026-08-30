import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import type { AgentTool } from "../tools/index.js";
import {
  planGateInstructions,
  toToolSet,
  type PlanGateState,
} from "../tools/index.js";
import { createToolTimingState, type ToolTimingState } from "../tools/tool-timing.js";
import { buildAgentSystemPrompt } from "../prompts/prompt-builder.js";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  readTokenUsage,
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
import {
  estimateMessagesTokens,
  type RuntimeCompactResult,
} from "../context/runtime-compact.js";
import { coalesceTextDeltas } from "./coalesce-stream.js";
import { createRepairToolCall } from "./repair-tool-call.js";
import { ToolDiscoveryController } from "./tool-discovery.js";
import {
  resolveToolExposure,
  TOOL_COUNT_SAFETY_LIMIT,
} from "./tool-safety-net.js";
import {
  createPrepareStep,
} from "./context-strategy.js";
import { mapStreamPart, type ToolCallClock } from "./stream-part-mapper.js";
import {
  abortInFlightToolCalls,
  finishRun,
  isAbortError,
  type FinishReason,
} from "./finish-run.js";
import {
  NOTICE_GRACE_MS,
  buildMaxOutputRecovery,
  buildNoticeRecovery,
  canDrainNotices,
  planReactiveRecovery,
  shouldRecoverMaxOutput,
} from "./recovery-policy.js";
import type {
  AgentCallSettings,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolCallResult,
  Agent as AgentInterface,
} from "./types.js";

/**
 * 收尾前等后台子代理交付结论的宽限期(S7 push)。
 *
 * 一次 HTTP = 一个 run,SSE 在 run 结束时关闭 —— 超过这个窗口才报的子代理,
 * 结果只落库(卡片可展开看),模型不再主动回应。给得太长会让每轮对话都卡着等,
 * 太短则常见的几秒级子任务白白错过注入。
 */
/** T43:discovery mode 首步之后的指路 system notice(只陈述机制,不列工具目录)。 */
const TOOL_DISCOVERY_NOTICE: SystemModelMessage = {
  role: "system",
  content:
    "Tool discovery mode is active: only core tools are enabled initially. " +
    "Use `tool_search` to find and activate additional tools; activated tools become callable from the next model step.",
};

const formatContext = (
  context: Record<string, unknown> | undefined,
): string | undefined =>
  !context || Object.keys(context).length === 0
    ? undefined
    : `Additional context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;

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

export interface RunLoopOptions {
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
  /** T38:钳制目标(providerId+modelId)。传了才在真实超限时 emit context_overflow_clamp。 */
  clampTarget?: { providerId: string; modelId: string };
  /** T43:工具发现状态。createAgent 注入;直造 Agent(只发生在测试)时给默认。 */
  toolDiscovery?: ToolDiscoveryController;
  /** T45a:run-scoped plan gate 状态。传了就在最外层包 withPlanGate + 每步注 reminder。 */
  planGateState?: PlanGateState;
  /** T50:三段计时汇聚。createAgent 装配时与三个 wrapper 共享同一实例。 */
  toolTiming?: ToolTimingState;
}

/**
 * 模块内部实现,不导出 —— createAgent 是造 agent 的唯一入口。
 * 审批(withApproval)、修复(repairToolCall)等横切全部收敛在那里装配,
 * 任何人 new 不了这个类 = 闸门没有可绕过的第二条路。
 * (类名与 types.ts 的 Agent 接口同名,import 时别名 AgentInterface 避让。)
 */
class RunLoopAgent implements AgentInterface {
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly systemMessage: SystemModelMessage;
  private readonly maxSteps: number;
  private readonly observer: AgentObserver | undefined;
  private readonly contextPolicy: ContextWindowPolicy;
  private readonly toolDiscovery: ToolDiscoveryController;
  private readonly toolTiming: ToolTimingState;

  constructor(private readonly options: RunLoopOptions) {
    this.toolsByName = new Map(
      (options.tools ?? []).map((tool) => [tool.name, tool]),
    );
    this.systemMessage = resolveSystemMessage(options.systemPrompt);
    this.maxSteps = options.maxSteps ?? 5;
    this.observer = options.observer;
    this.contextPolicy = resolveContextWindowPolicy(options.contextPolicy);
    this.toolDiscovery = options.toolDiscovery ?? new ToolDiscoveryController();
    this.toolTiming = options.toolTiming ?? createToolTimingState();
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
    // T43/T44 安全网:显式 activeToolNames 优先;没设且超 40 → 不裁 toolSet,
    // 首步 active core + tool_search + skill preferred,后续由 tool_search 激活并入。
    const resolvedTools = this.resolveTools(input);
    const exposure = resolveToolExposure(
      resolvedTools,
      input.activeToolNames,
      this.toolDiscovery,
      input.preferredToolNames,
    );
    if (exposure.degraded) {
      this.emit({
        type: "tool_count_degraded",
        totalCount: exposure.totalCount,
        keptCount: exposure.keptCount,
        limit: TOOL_COUNT_SAFETY_LIMIT,
      });
    }
    const toolSet: ToolSet = toToolSet([...resolvedTools.values()]);
    const maxSteps = input.maxSteps ?? this.maxSteps;
    const clock: ToolCallClock = new Map();
    const toolCalls: AgentToolCallResult[] = [];

    let messages = this.buildMessages(input);
    // 注意:续写/notice 续跑会把 messages 换成 responseMessages + 续写消息
    // (不含最初的输入),那一刻起 prefix 语义失效,必须归 0 —— 否则 reactive
    // compact 会把 tool-call 留在"prefix"、把它的 tool result 压进 summary,
    // 造出孤儿 tool-call(SDK convertToLanguageModelPrompt 直接拒绝)。
    let prefixMessageCount = messages.length;
    let stepsUsed = 0;
    let recoveries = 0;
    let noticeRounds = 0;
    let hasCompactedReactively = false;
    let continuedText = "";
    let totalTokens: TokenUsage = ZERO_TOKEN_USAGE;
    let stepStartTime = runStart;
    // T36: 上一步真实 inputTokens,prepareStep 的 compact 判定用它(真值优先,首步 undefined 退估算)。
    let lastStepInputTokens: number | undefined;

    // S27/T49:Turn 与 attempt 追踪。Turn = 一次用户输入到终态 —— 一个 Run 里
    // 恒为 turn 0(notice 续跑发生在终态之前,属于同一个 Turn,只是多一些 Step;
    // 边界由 loop_transition(subagent_notice) 表达)。
    // attempt = 同一 Step 因 reactive compact 重跑的次数(step 级 Map,跨 restart 圈存活)。
    const turnStartTime = runStart;
    const attemptByStep = new Map<number, number>();
    let currentStepAttempt = 1;
    let firstTokenEmitted = false;
    // 正在流式传输的 step 下标:finish-step part 可能在 onStepEnd 之后才到,
    // 那时 stepsUsed 已经 +1,attribution 不能用 stepsUsed,要用这个。
    let streamingStepIndex = 0;
    // 失败 step 的下标(有 streamError 时 = 当前 step)。SDK 对失败 step 也会迟发
    // onStepEnd —— 那次回调必须跳过(不占步数、不发 step_completed),否则 reactive
    // 重跑会拿到新下标而不是「同 step,attempt+1」(T49 的 attempt 语义)。
    let failedStepIndex: number | undefined;

    this.emit({ type: "agent_run_start" });
    this.emit({ type: "turn_started", turnIndex: 0 });

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
          { index: 0, startTime: turnStartTime },
        );
        return;
      }

      // ai@7 校验在 prepareStep 之前,messages 里任何 system 角色都会直接抛
      // (context-strategy.ts:53 的注释)。两个来源会带 system 进来:
      // run-preparation 的会话摘要(leading system)与 reactive compact 的
      // reminder(中段 system)—— 统一上提到 instructions,messages 保持干净。
      const hoistedSystemMessages = messages.filter(
        (message): message is SystemModelMessage => message.role === "system",
      );
      const streamMessages =
        hoistedSystemMessages.length > 0
          ? messages.filter((message) => message.role !== "system")
          : messages;

      const prepareStep = createPrepareStep({
        policy: this.contextPolicy,
        systemPrompt: this.systemMessage,
        prefixMessageCount,
        onCompacted: (result) => {
          this.emitCompaction(stepsUsed, "proactive_loop_compact", result);
          this.emitTransition(stepsUsed, "proactive_loop_compact");
        },
        getLastStepInputTokens: () => lastStepInputTokens,
        getActiveTools: () =>
          this.toolDiscovery.activeTools() as
            | readonly (keyof ToolSet & string)[]
            | undefined,
        getExtraInstructions: () =>
          planGateInstructions(
            this.options.planGateState?.current() ?? { active: false },
          ),
        extraInstructions: [
          ...hoistedSystemMessages,
          ...(exposure.degraded ? [TOOL_DISCOVERY_NOTICE] : []),
        ],
      });

      // S27:请求快照 —— 模型这轮实际看到的面(system prompt + 工具 + 调用设置)。
      // 每圈都发,同 Run 去重是 server 侧的事(request_snapshot_ref,§4.3)。
      // LanguageModel 联合里含字符串形式(GlobalProviderModelId),provider/modelId
      // 只在实例成员上 —— 运行时收窄,字符串形式落成 unknown。
      const modelSpec = this.options.model as {
        readonly provider?: string;
        readonly modelId?: string;
      };
      this.emit({
        type: "request_snapshot",
        provider: modelSpec.provider ?? "unknown",
        modelId: modelSpec.modelId ?? "unknown",
        callSettings: {
          ...(this.options.callSettings?.temperature !== undefined
            ? { temperature: this.options.callSettings.temperature }
            : {}),
          ...(this.options.callSettings?.maxOutputTokens !== undefined
            ? { maxOutputTokens: this.options.callSettings.maxOutputTokens }
            : {}),
        },
        systemPrompt: this.systemMessage.content,
        tools: [...resolvedTools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
        })),
      });

      const result = streamText({
        model: this.options.model,
        messages: streamMessages,
        tools: toolSet,
        ...(exposure.activeTools !== undefined
          ? {
              activeTools: exposure.activeTools as readonly (keyof ToolSet &
                string)[],
            }
          : {}),
        stopWhen: [
          stepCountIs(maxSteps - stepsUsed),
          // T45b:reject / reject_and_exit 的一次性终止信号(run-scoped,不落库)。
          () => this.options.planGateState?.shouldStopTurn() === true,
        ],
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
          // S27:同一 Step 因 reactive compact 重跑时 attempt 递增(新 streamText 会
          // 对同一个 stepsUsed 再触发一次 onStepStart)。
          const attempt = (attemptByStep.get(stepsUsed) ?? 0) + 1;
          attemptByStep.set(stepsUsed, attempt);
          currentStepAttempt = attempt;
          streamingStepIndex = stepsUsed;
          firstTokenEmitted = false;
          this.emit({ type: "step_started", step: stepsUsed, attempt });
          this.emit({ type: "llm_call_start", step: stepsUsed, attempt });
        },
        onStepEnd: ({ usage, toolCalls: stepToolCalls }) => {
          // 失败 step 的迟到 onStepEnd:不占步数、不累计用量、不发 llm_call_end ——
          // 失败事实由 model_call_failed 表达,reactive 重跑将复用这个下标。
          if (failedStepIndex === stepsUsed) {
            failedStepIndex = undefined;
            return;
          }
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

          // S27:TTFT —— 该 Step 第一条正文类 delta(text/reasoning/tool 输入/call)。
          if (
            !firstTokenEmitted &&
            (part.type === "text-delta" ||
              part.type === "reasoning-delta" ||
              part.type === "tool-input-start" ||
              part.type === "tool-call")
          ) {
            firstTokenEmitted = true;
            this.emit({
              type: "model_first_token",
              step: streamingStepIndex,
              attempt: currentStepAttempt,
              durationMs: Date.now() - stepStartTime,
            });
          }

          // S27:模型流读完(finish-step part),不含后续工具执行;mapStreamPart 对它返回 {}。
          if (part.type === "finish-step") {
            this.emit({
              type: "model_call_completed",
              step: streamingStepIndex,
              attempt: currentStepAttempt,
            });
          }

          if (part.type === "text-delta") {
            text += part.text;
          }

          const mapped = mapStreamPart(part, clock, this.toolTiming);

          if (mapped.error !== undefined) {
            streamError = mapped.error;
            failedStepIndex = stepsUsed;
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
              output: mapped.toolCall.output,
              ...(mapped.toolCall.toolExecMs !== undefined
                ? { toolExecMs: mapped.toolCall.toolExecMs }
                : {}),
              ...(mapped.toolCall.approvalWaitMs !== undefined
                ? { approvalWaitMs: mapped.toolCall.approvalWaitMs }
                : {}),
              ...(mapped.toolCall.queueWaitMs !== undefined
                ? { queueWaitMs: mapped.toolCall.queueWaitMs }
                : {}),
              ...(mapped.toolCall.execAborted !== undefined
                ? { execAborted: mapped.toolCall.execAborted }
                : {}),
            });
          }

          if (mapped.event !== undefined) {
            // tool-call 事件补一个 tool_call_started 观测点(mapStreamPart 不打观测)。
            if (mapped.event.type === "tool-call") {
              this.emit({
                type: "tool_call_started",
                step: stepsUsed,
                toolName: mapped.event.toolName,
                toolCallId: mapped.event.toolCallId,
                input: mapped.event.input,
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
          failedStepIndex = stepsUsed;
        }
      }

      // ---- reactive compact:上下文溢出类错误,全程只重试一次 ----
      if (streamError !== undefined) {
        const recovery = planReactiveRecovery({
          error: streamError,
          messages,
          prefixMessageCount,
          hasCompactedReactively,
        });
        const { errorMessage, compactCandidate } = recovery;
        if (compactCandidate) {
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
        // 先定结局再发事件:willRetry 必须反映真实的下一步,不是意图。
        const appliedCompaction = recovery.compaction;
        const retried = appliedCompaction !== undefined;
        if (appliedCompaction) {
          messages = appliedCompaction.messages;
          hasCompactedReactively = true;
        }
        this.emit({
          type: "model_call_failed",
          step: stepsUsed,
          attempt: currentStepAttempt,
          error: errorMessage,
          willRetry: retried,
        });
        if (retried && appliedCompaction) {
          this.emitCompaction(
            stepsUsed,
            "reactive_compact_retry",
            appliedCompaction,
          );
          this.emitTransition(stepsUsed, "reactive_compact_retry");
          continue;
        }
        // 错误终态:不 yield finish —— run() 抛出,由 stream() 转 error 事件(与重构前一致)。
        // S27:终态也要在台账留痕 —— 这条路径 finish() 走不到,run_failed 在这里发。
        this.emit({
          type: "agent_run_failed",
          error: errorMessage,
          failureLayer: compactCandidate ? "context" : "model",
        });
        this.emit({
          type: "turn_completed",
          turnIndex: 0,
          durationMs: Date.now() - turnStartTime,
          status: "error",
        });
        throw streamError;
      }

      if (aborted) {
        // T26:SDK 在 abort 时丢弃刚读出的在飞 tool-result(外层拉流循环直接 close),
        // 不给补发的话 UI 卡片永远停在 running、落库 part 悬挂 input-available。
        // clock 里剩下的 entry 就是"已发 tool-call、未收 tool-result"的在飞集合 ——
        // 逐个补一条取消 result,再 yield finish(顺序不能反:SSE 在 finish 后收尾)。
        yield* abortInFlightToolCalls({
          clock,
          toolCalls,
          step: stepsUsed,
          emit: (event) => this.emit(event),
        });

        yield this.finish(
          continuedText + text,
          toolCalls,
          "aborted",
          totalTokens,
          runStart,
          stepsUsed,
          { index: 0, startTime: turnStartTime },
        );
        return;
      }

      const finishReason = await result.finishReason;

      // ---- max-output 续写 ----
      if (
        shouldRecoverMaxOutput({
          finishReason,
          recoveries,
          policy: this.contextPolicy,
        })
      ) {
        const recovery = buildMaxOutputRecovery({
          responseMessages: await result.responseMessages,
          continuedText,
          text,
          recoveries,
        });
        continuedText = recovery.continuedText;
        messages = recovery.messages;
        // 工作集已不含最初的输入,静态 prefix 失效(见上方 prefixMessageCount 注释)。
        prefixMessageCount = 0;
        recoveries = recovery.recoveries;
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
        canDrainNotices({
          stepsUsed,
          maxSteps,
          noticeRounds,
          hasDrainNotices: input.drainNotices !== undefined,
        }) &&
        input.drainNotices !== undefined
      ) {
        const notices = await input.drainNotices({ graceMs: NOTICE_GRACE_MS });

        if (notices.length > 0) {
          // 先 yield 边界帧:route 靠它把当前 assistant 收口落库,再落通知消息,
          // 然后为续跑新建 builder(见 routes/runs.ts)。必须在改 messages 之前发。
          yield { type: "notice-injected", notices };

          const recovery = buildNoticeRecovery({
            responseMessages: await result.responseMessages,
            notices,
            noticeRounds,
          });
          messages = recovery.messages;
          // 与 max-output 续写同理:工作集已不含最初的输入,静态 prefix 失效。
          prefixMessageCount = 0;
          // 与 max-output 续写的关键差异:那里是"同一条消息继续写"所以累加 continuedText,
          // 这里是两条独立 assistant 消息 —— 本轮正文已随上一条 assistant 收口落库,
          // 所以 continuedText 必须保持空,否则续跑那条会把前一条的正文重复一遍。
          // (text 是每圈局部变量,下一圈自然从 "" 开始,无需在此清。)
          continuedText = "";
          // notice 续跑不开新 Turn(Turn = 一次用户输入到终态,续跑发生在终态之前,
          // 属于同一个 Turn)—— 它只是多一些 Step。续跑的边界事实由
          // loop_transition(subagent_notice) 表达。
          noticeRounds = recovery.noticeRounds;
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
        { index: 0, startTime: turnStartTime },
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
    turn: { readonly index: number; readonly startTime: number },
  ): Extract<AgentStreamEvent, { type: "finish" }> {
    return finishRun({
      text,
      toolCalls,
      finishReason,
      usage,
      runStart,
      stepsUsed,
      maxSteps: this.maxSteps,
      turn,
      emit: (event) => this.emit(event),
    });
  }
}

export const createRunLoopAgent = (options: RunLoopOptions): AgentInterface => {
  return new RunLoopAgent(options);
};
