import os from "node:os";
import path from "node:path";

/** Eva 的用户数据目录 —— DB、tool-overflow、mcp.json 的唯一根(docs 14 §7.3)。 */
export const evaDataDir = (): string => path.join(os.homedir(), ".eva");

/**
 * 工具超长输出的落盘目录。
 * 按 workspaceId 分目录:溢出日志属于"哪个项目的哪次调用"要一眼能看出来。
 * 不再落在用户仓库内 —— agent 不应该往用户的项目里写自己的运行时垃圾。
 */
export const toolOverflowDir = (workspaceId: string): string =>
  path.join(evaDataDir(), "tool-overflow", workspaceId);

/**
 * 用户技能目录。技能是用户内容,必须在用户数据目录里 ——
 * 放 App 包内部的话,装完的用户根本没有途径加 skill(docs 14 §7.3)。
 */
export const userSkillsDir = (): string => path.join(evaDataDir(), "skills");