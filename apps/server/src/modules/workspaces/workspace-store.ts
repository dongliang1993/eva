import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type { Workspace } from "@eva/shared";

import type { Session } from "../../db/repositories/types.js";
import { DrizzleWorkspaceRepository } from "./workspace-repository.js";
import { assertUsableWorkspacePath } from "./workspace-guard.js";

/** 只需要 warn 的结构化日志接口 —— 兼容 Fastify 的 logger 与 pino logger。 */
interface WarnLogger {
  warn(object: unknown, message?: string): void;
}

export class WorkspaceStore {
  constructor(private readonly repo: DrizzleWorkspaceRepository) { }

  list(): readonly Workspace[] {
    return this.repo.listAll();
  }

  findById(id: string): Workspace | undefined {
    return this.repo.findById(id);
  }

  /**
   * 添加一个工作区。path 先过 guard,再按规范化后的绝对路径查重
   * —— 同一目录用不同写法(`~/p` vs `/Users/x/p` vs `/Users/x/p/`)提交
   * 必须命中同一条记录,否则唯一索引形同虚设。
   */
  add(input: { path: string; name?: string }): Workspace {
    const absolute = assertUsableWorkspacePath(input.path);
    const existing = this.repo.findByPath(absolute);

    if (existing) {
      return existing;
    }

    return this.repo.create({
      id: randomUUID(),
      path: absolute,
      name: input.name?.trim() || path.basename(absolute)
    });
  }

  rename(id: string, name: string): Workspace | undefined {
    return this.repo.rename(id, name);
  }

  remove(id: string): boolean {
    return this.repo.deleteById(id);
  }
}

/**
 * 解析一次 run 该在哪个目录里干活。
 *
 * 返回 undefined 有两种情形,都不是错误:
 * ① 会话没绑工作区(纯聊天);② 绑的工作区目录已经不在了(用户删了/改名了)。
 * 后者记一条 warn —— 静默降级成"没有文件工具"会让用户以为 agent 坏了。
 */
export const resolveWorkspaceForSession = (
  store: WorkspaceStore,
  session: Session,
  logger: WarnLogger
): Workspace | undefined => {
  if (!session.workspaceId) {
    return undefined;
  }

  const workspace = store.findById(session.workspaceId);

  if (!workspace) {
    logger.warn(
      { workspaceId: session.workspaceId },
      "会话绑定的工作区已不存在,降级为无文件工具"
    );
    return undefined;
  }

  if (!existsSync(workspace.path)) {
    logger.warn(
      { workspaceId: workspace.id, path: workspace.path },
      "会话绑定的工作区目录已被删除/改名,降级为无文件工具"
    );
    return undefined;
  }

  return workspace;
};
