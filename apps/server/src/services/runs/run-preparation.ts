import { randomUUID } from "node:crypto";

import type { AgentTool } from "@eva/harness";
import {
  createUserUIMessage,
  stripReasoningParts,
  uiMessageText
} from "@eva/shared";
import { convertToModelMessages, type ModelMessage } from "ai";

import { defined, type WorkspaceContext } from "../agent-factory.js";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { DrizzleMessageRepository } from "../../db/repositories/message-repository.js";
import { DrizzleRunRepository } from "../../db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../../db/repositories/session-repository.js";
import type { Session } from "../../db/repositories/types.js";
import type { RunRequest } from "../../types/runs.js";
import { autoCompactIfNeeded, createAutoCompactConfig } from "../compact/auto-compact.js";
import { buildMemoryRuntimeSupport } from "../memory/memory-runtime.js";
import type { ModelBinding } from "../providers/model-resolver.js";
import type { MessagePosition, SessionService } from "../session.js";
import { loadAppSettings } from "../settings/app-settings.js";
import { createModelSummarizer } from "../compact/summarize-with-model.js";
import { estimateModelHistoryTokens } from "../token-estimator.js";
import { loadProjectDocsSection } from "../workspaces/project-docs.js";
import {
  resolveWorkspaceForSession,
  type WorkspaceStore
} from "../workspaces/workspace-store.js";

interface WarnLogger {
  warn(object: unknown, message?: string): void;
}

export interface RunPreparationDependencies {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly logger: WarnLogger;
  readonly session: SessionService;
  readonly workspaces: WorkspaceStore;
}

/**
 * 一次 run 的输入材料 —— 阶段①的产出,回答"这次 run 落在哪、用什么模型、
 * 从哪条消息回溯"。不是"一轮对话"(turn),是 run 的事实。
 */
export interface RunInput {
  readonly sessionId: string;
  /** runs 台账的 user_message_id，同时也是模型可见历史的末端。 */
  readonly userMessageId: string;
  /** 本轮人工输入文本：send = body.text；retry = 被重试回复的父 user 文本。 */
  readonly humanText: string;
  /** 本轮 assistant 消息在树里的落点。 */
  readonly assistantPosition: MessagePosition;
  /** send 从新 user 回溯；retry 从被重试 assistant 的父消息回溯。 */
  readonly historyLeafId: string;
  readonly workspace?: WorkspaceContext | undefined;
  /** 本次请求新建了会话时非空，供模型不可用时回滚。 */
  readonly createdSessionId?: string | undefined;
  /**
   * 本轮主对话模型("providerId:modelId")。**非空** —— 两条分支各有唯一来源,
   * 到这里已经定了,下游不需要再兜底:
   * - send:`body.modelId`(schema 强制必填,前端选了模型才让发送);
   * - retry:`body.modelId` 优先,缺省用 `sessions.model`(被重试那轮选的模型)。
   */
  readonly modelId: string;
}

export interface RunContext {
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly modelMessages: ModelMessage[];
  /** 喂给 agent.stream 的 additionalTools —— 记忆工具在这,路由再拼 subagentTools。 */
  readonly additionalTools: readonly AgentTool[];
  /** 喂给 agent.stream 的 context —— 目前是 { memory: <渲染好的记忆 prompt> }。 */
  readonly context?: Record<string, unknown>;
}

const loadWorkspaceContext = async (
  dependencies: RunPreparationDependencies,
  session: Session
): Promise<WorkspaceContext | undefined> => {
  const workspace = resolveWorkspaceForSession(
    dependencies.workspaces,
    session,
    dependencies.logger
  );

  if (!workspace) return undefined;

  const docsSection = await loadProjectDocsSection(workspace.path);

  return {
    id: workspace.id,
    root: workspace.path,
    ...(docsSection !== undefined ? { docsSection } : {})
  };
};

/**
 * 该会话已有 run 在飞 —— 路由映射成 409。
 *
 * 从 SSE 断连不再 abort 那一刻起,这个守卫就是「一个会话同时只跑一个 run」的
 * 唯一执行者:刷新页面再发一句,旧 run 还在跑,两个 run 会同时改 activeLeafId。
 * 宁可让用户看见「这轮还在跑」,也不静默杀掉正在跑的东西(见 plan 决定②)。
 */
export class SessionBusyError extends Error {
  constructor(readonly activeRunId: string) {
    super("这个会话还有一轮在运行,先等它跑完或点停止");
    this.name = "SessionBusyError";
  }
}

const assertSessionIdle = (db: AppDatabase, sessionId: string): void => {
  const running = new DrizzleRunRepository(db).findRunningBySessionId(sessionId);

  if (running) {
    throw new SessionBusyError(running.id);
  }
};

/**
 * 阶段①:备齐这次 run 的输入材料 —— 建/取会话、落用户消息、定模型、定工作区。
 * 不解析模型(那是 AgentFactory 的活),只把"用哪个模型"这个决定落实成 modelId。
 */
export const prepareRunInput = async (
  dependencies: RunPreparationDependencies,
  body: RunRequest,
  runId: string
): Promise<RunInput> => {
  // send 与 retry 都从这里过;新建会话(无 sessionId)天然不可能有在飞 run。
  if (body.sessionId !== undefined) {
    assertSessionIdle(dependencies.db, body.sessionId);
  }

  if (body.retryMessageId !== undefined) {
    const messageRepo = new DrizzleMessageRepository(dependencies.db);
    const target = messageRepo.findById(body.retryMessageId);

    if (!target) throw new Error("要重新生成的消息不存在");
    if (target.sessionId !== body.sessionId) throw new Error("不能跨会话重新生成");
    if (target.role !== "assistant") throw new Error("只能重新生成 assistant 回复");

    const current = new DrizzleSessionRepository(dependencies.db).findById(target.sessionId);
    if (!current || current.activeLeafId !== target.id) {
      throw new Error("只能重新生成最后一条回复");
    }

    // 模型:body 优先(用户在重试前换了模型),否则沿用被重试那轮的模型。
    // 两者都无 = 会话从未成功跑过 run,没有可沿用的模型,让调用方拿到明确错误。
    const retryModelId = body.modelId ?? current.model;
    if (!retryModelId) {
      throw new Error("该会话没有可用模型记录,重新生成时请指定 modelId");
    }

    const workspace = await loadWorkspaceContext(dependencies, current);
    const parentMessage =
      target.parentId !== null ? messageRepo.findById(target.parentId) : undefined;

    return {
      sessionId: target.sessionId,
      userMessageId: target.parentId!,
      humanText: parentMessage ? uiMessageText(parentMessage.message) : "",
      assistantPosition: dependencies.session.positionAlongside(target),
      historyLeafId: target.parentId!,
      ...(workspace !== undefined ? { workspace } : {}),
      modelId: retryModelId
    };
  }

  const userMessage = createUserUIMessage(randomUUID(), body.text!, { runId });
  const continuedSession = body.sessionId
    ? dependencies.session.continueSession(body.sessionId, userMessage, runId)
    : undefined;
  const { session, userMessage: storedUser } =
    continuedSession ?? dependencies.session.createSession(userMessage, runId);
  const workspace = await loadWorkspaceContext(dependencies, session);

  return {
    sessionId: session.id,
    userMessageId: storedUser.id,
    humanText: body.text!,
    assistantPosition: dependencies.session.positionAfterActiveLeaf(session.id),
    historyLeafId: storedUser.id,
    ...(continuedSession === undefined ? { createdSessionId: session.id } : {}),
    workspace,
    // schema 的 superRefine 已保证 text 模式必带 modelId。
    modelId: body.modelId!
  };
};

/** 阶段③:拿输入材料 + 已解析模型 → 模型这轮可见的历史、记忆上下文和附加工具。 */
export const prepareRunContext = async (
  dependencies: RunPreparationDependencies,
  input: RunInput,
  resolved: { readonly mainModel: ModelBinding; readonly toolModel: ModelBinding }
): Promise<RunContext> => {
  const { mainModel } = resolved;
  new DrizzleSessionRepository(dependencies.db)
    .updateModel(input.sessionId, mainModel.qualifiedModelId);

  const settings = loadAppSettings(dependencies.db, dependencies.config);
  await autoCompactIfNeeded(
    dependencies.db,
    input.sessionId,
    createAutoCompactConfig(settings.chat),
    { summarize: createModelSummarizer(resolved.toolModel, dependencies.logger) }
  );

  const history = dependencies.session.buildModelHistory(
    dependencies.db,
    input.sessionId,
    input.historyLeafId
  );

  // abort 可能留下不完整工具调用；reasoning 保留给 UI，但不回灌模型。
  const strippedHistory = history.messages.map((message) => stripReasoningParts(message));
  const converted = await convertToModelMessages([...strippedHistory], {
    ignoreIncompleteToolCalls: true
  });
  const modelMessages: ModelMessage[] = history.summary
    ? [{ role: "system", content: history.summary }, ...converted]
    : converted;

  const memoryRuntime = await buildMemoryRuntimeSupport({
    db: dependencies.db,
    config: dependencies.config,
    userMessage: input.humanText,
    historyTokens: estimateModelHistoryTokens(history),
    modelLimits: {
      ...defined("contextWindow", mainModel.contextWindow),
      ...defined("maxOutputTokens", mainModel.maxOutputTokens)
    }
  });

  // MemoryRuntimeSupport(服务层词)→ agent.stream 的入参(harness 词):
  // additionalTools 还要在路由拼 subagentTools;memoryContext 是个裸 string,
  // harness 要 Record —— 给它起 key = "memory"。
  return {
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    modelMessages,
    additionalTools: memoryRuntime.additionalTools,
    ...defined("context",
      memoryRuntime.memoryContext !== undefined
        ? { memory: memoryRuntime.memoryContext }
        : undefined)
  };
};
