import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type {
  SubagentMessage,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
  ThreadUsage
} from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { BackgroundTaskRepository } from "../subagents/index.js";
import type { DrizzleRunRepository } from "../runs/index.js";
import type { Session, StoredMessage } from "../../db/repositories/types.js";
import { messages } from "../../db/schema.js";
import type { ApprovalGateway } from "../approvals/index.js";
import { compactSession, createModelSummarizer } from "../compact/index.js";
import { resolveModelSlot } from "../providers/index.js";
import { buildActiveChain, resolveLeafFrom } from "./message-tree.js";
import { deriveSessionStatus, readSessionRuntimeStatus } from "./session-status.js";
import { readSessionUsage } from "./session-usage.js";
import type { SessionService } from "./session.js";
import type { DrizzleMessageRepository } from "./message-repository.js";
import type { DrizzleSessionRepository } from "./session-repository.js";

export interface ThreadCompactResult {
  readonly success: boolean;
  readonly compacted: boolean;
  readonly trigger: "manual";
  readonly coveredMessageCount: number;
  readonly preservedTailMessageCount: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly compactionId?: string;
  readonly thread: ThreadSummary;
}

/**
 * 每个 slot 的版本 id 列表(创建序)→ `ThreadMessage.siblingIds`。
 * 前端据此画「第 2/3 版」的切换器,所以顺序是契约的一部分。
 */
const siblingIndex = (all: readonly StoredMessage[]): Map<string, string[]> => {
  const bySlot = new Map<string, string[]>();

  for (const message of all) {
    if (message.slotId !== null) {
      const list = bySlot.get(message.slotId) ?? [];
      list.push(message.id);
      bySlot.set(message.slotId, list);
    }
  }

  return bySlot;
};

const toThreadMessages = (
  chain: readonly StoredMessage[],
  all: readonly StoredMessage[]
): readonly ThreadMessage[] => {
  const bySlot = siblingIndex(all);

  return chain.map((message) => ({
    id: message.id,
    role: message.role,
    message: message.message,
    runId: message.runId,
    createdAt: message.createdAt,
    siblingIds: message.slotId !== null
      ? (bySlot.get(message.slotId) ?? [message.id])
      : [message.id]
  }));
};

/**
 * 会话(前端叫 thread)的用例与只读投影。
 *
 * 「找不到」一律返回 `undefined` —— 404 是协议层的决定,不是这一层的。
 */
export interface SessionsApi {
  /** 只读一行原始会话 —— 别的模块要判存在性时用它(例:轨迹路由的 404)。 */
  find(id: string): Session | undefined;
  listSummaries(limit: number): readonly ThreadSummary[];
  create(title?: string): ThreadSummary;
  rename(id: string, title: string): ThreadSummary | undefined;
  setWorkspace(id: string, workspaceId: string | null): ThreadSummary | undefined;
  delete(id: string): boolean;
  readStatus(id: string): ThreadStatus | undefined;
  readUsage(id: string): ThreadUsage | undefined;
  listMessages(id: string, limit: number): readonly ThreadMessage[] | undefined;
  /** S7:某次 Task 调用的子代理消息流 —— 刷新后任务卡片展开区的数据源。 */
  findSubagentMessages(id: string, toolCallId: string): SubagentMessage | undefined;
  /** 切版本:激活链改到目标那条分支的末端,该分支后续对话一并恢复。 */
  switchMessageVersion(messageId: string): readonly ThreadMessage[] | undefined;
  /** 手动压缩。Wave 4 会把 compact 拆成独立模块,但这个用例的出参是 ThreadSummary,入口留在会话侧。 */
  compact(id: string): Promise<ThreadCompactResult | undefined>;
}

export const createSessionsApi = (deps: {
  readonly db: AppDatabase;
  readonly config: AppConfig;
  readonly logger: { warn(object: unknown, message?: string): void };
  readonly sessions: DrizzleSessionRepository;
  readonly messages: DrizzleMessageRepository;
  readonly runs: DrizzleRunRepository;
  readonly backgroundTasks: BackgroundTaskRepository;
  readonly approvals: ApprovalGateway;
  readonly session: SessionService;
}): SessionsApi => {
  const messageCount = (sessionId: string): number =>
    Number(
      deps.db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .get()?.count ?? 0
    );

  /**
   * 列表一次查完(不要 N+1):running 会话 id 一次查,running 之外再逐条查审批。
   * pending 数量正常是 0–2,会话数上百时 O(threads×pending) 可接受;若成为热点,
   * 再给 ApprovalGateway 加 sessionId → count 索引。
   */
  const listSummaries = (limit: number): readonly ThreadSummary[] => {
    const runningSessionIds = new Set(deps.runs.listRunningSessionIds());

    return deps.sessions.listAll(limit).map((thread) => ({
      id: thread.id,
      title: thread.title,
      model: thread.model,
      origin: thread.origin,
      updatedAt: thread.updatedAt,
      messageCount: messageCount(thread.id),
      workspaceId: thread.workspaceId,
      status: deriveSessionStatus({
        hasPendingApproval: deps.approvals.listPending(thread.id).length > 0,
        hasRunningRun: runningSessionIds.has(thread.id)
      })
    }));
  };

  /**
   * 改完一行之后重新取它的 summary。
   *
   * 之所以要重取而不是就地拼:summary 里的 status 与 messageCount 不在 sessions 行上
   * (一个来自 runs + 审批,一个来自 messages 的 count)。上限 1000 是原路由的行为,
   * 保持不动 —— 会话数超过 1000 时它会返回 undefined,那是既有语义,不在本轮改。
   */
  const summaryOf = (id: string): ThreadSummary | undefined =>
    listSummaries(1000).find((item) => item.id === id);

  return {
    find: (id) => deps.sessions.findById(id),

    listSummaries,

    create: (title) => {
      const thread = deps.sessions.create({
        id: randomUUID(),
        ...(title ? { title } : {})
      });

      // 新会话必然没有消息、没有在飞 run —— 不必再走一次 listSummaries。
      return {
        id: thread.id,
        title: thread.title,
        model: thread.model,
        origin: thread.origin,
        updatedAt: thread.updatedAt,
        messageCount: 0,
        workspaceId: thread.workspaceId,
        status: "idle"
      };
    },

    rename: (id, title) =>
      deps.sessions.updateTitle(id, title) ? summaryOf(id) : undefined,

    setWorkspace: (id, workspaceId) =>
      deps.sessions.updateWorkspace(id, workspaceId) ? summaryOf(id) : undefined,

    delete: (id) => deps.sessions.deleteById(id),

    readStatus: (id) =>
      deps.sessions.findById(id)
        ? readSessionRuntimeStatus(deps.db, deps.approvals, id)
        : undefined,

    readUsage: (id) =>
      deps.sessions.findById(id)
        ? readSessionUsage(deps.db, deps.config, deps.session, id)
        : undefined,

    listMessages: (id, limit) => {
      const thread = deps.sessions.findById(id);
      if (!thread) return undefined;

      const all = deps.messages.findBySessionId(id, { limit });

      return toThreadMessages(buildActiveChain(all, thread.activeLeafId), all);
    },

    findSubagentMessages: (id, toolCallId) => {
      if (!deps.sessions.findById(id)) return undefined;

      // 子代理进程与主链共表,靠 parent_tool_call_id 隔离;按 toolCallId 取那棵子树。
      const task = deps.backgroundTasks.findByParentToolCallId(toolCallId);
      if (!task || task.sessionId !== id) return undefined;

      const rows = deps.messages.findBySubagentToolCallId(toolCallId);

      return {
        taskId: task.id,
        parentToolCallId: task.parentToolCallId,
        subagentType: task.subagentType,
        description: task.description,
        status: task.status,
        result: task.result,
        error: task.error,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        // 子代理消息没有版本分支,siblingIds 恒为自己。
        messages: rows.map((message) => ({
          id: message.id,
          role: message.role,
          message: message.message,
          runId: message.runId,
          createdAt: message.createdAt,
          siblingIds: [message.id]
        }))
      };
    },

    switchMessageVersion: (messageId) => {
      const message = deps.messages.findById(messageId);
      if (!message) return undefined;

      const all = deps.messages.findBySessionId(message.sessionId, { limit: 2000 });
      const session = deps.sessions.findById(message.sessionId)!;
      // 从 target 向下探到分支末端 —— 该分支的后续对话一并恢复。
      const leafId = resolveLeafFrom(all, messageId);
      deps.sessions.updateActiveLeaf(session.id, leafId);

      return toThreadMessages(buildActiveChain(all, leafId), all);
    },

    compact: async (id) => {
      const thread = deps.sessions.findById(id);
      if (!thread) return undefined;

      // 手动压缩用 tool 槽位模型写摘要;tool 没配则回落**这个会话绑定的模型**
      // (thread.model = 最近一轮 run 选定的)—— 主对话模型是 per-thread 的,
      // 没有全局 chat 槽位可问。两者都没有时不注入 summarizer,compactSession
      // 回落确定性拼接:摘要质量可以降级,这个用例不能挂。
      let summarize: ReturnType<typeof createModelSummarizer> | undefined;
      try {
        const toolSlot = resolveModelSlot(deps.db, deps.config, "tool");
        const sessionSlot = thread.model
          ? resolveModelSlot(deps.db, deps.config, "chat", thread.model)
          : undefined;
        const binding = toolSlot.ok
          ? toolSlot.binding
          : sessionSlot?.ok
            ? sessionSlot.binding
            : undefined;
        summarize = binding !== undefined ? createModelSummarizer(binding, deps.logger) : undefined;
      } catch {
        summarize = undefined;
      }

      const result = await compactSession(deps.db, {
        sessionId: id,
        trigger: "manual",
        ...(summarize ? { summarize } : {})
      });

      return {
        success: true,
        compacted: result.compacted,
        trigger: "manual",
        coveredMessageCount: result.coveredMessageCount,
        preservedTailMessageCount: result.preservedTailMessageCount,
        estimatedTokensBefore: result.estimatedTokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
        ...(result.compactionId ? { compactionId: result.compactionId } : {}),
        // 压缩改了消息数,summary 必须重取。取不到(会话数 > 1000)时就地拼一份 ——
        // 这是原路由的兜底,保持不动。
        thread: summaryOf(id) ?? {
          id: thread.id,
          title: thread.title,
          model: thread.model,
          origin: thread.origin,
          updatedAt: thread.updatedAt,
          messageCount: messageCount(thread.id),
          workspaceId: thread.workspaceId,
          status: "idle"
        }
      };
    }
  };
};
