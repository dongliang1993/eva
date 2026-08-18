import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 工作区路径不合法 —— 由路由转成 400 给用户看。 */
export class UnusableWorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableWorkspacePathError";
  }
}

/**
 * 校验并规范化一个工作区路径。
 *
 * 为什么家目录/根目录一律拒:agent 在这里跑 bash/write 是不可见的危险
 * —— 能力缺失是可见的(用户会来问"为什么不能读文件"),
 * 指向错误目录的能力是不可见的(等发现时文件已经改了)。
 * 这条规则从 R1 的 deps.ts:resolveWorkRoot 继承而来,现在只剩这一个落点。
 *
 * @returns 规范化后的绝对路径
 * @throws UnusableWorkspacePathError
 */
export const assertUsableWorkspacePath = (raw: string): string => {
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new UnusableWorkspacePathError("工作区路径不能为空。");
  }

  const absolute = path.resolve(trimmed);

  if (!existsSync(absolute)) {
    throw new UnusableWorkspacePathError(`目录不存在:${absolute}`);
  }

  if (!statSync(absolute).isDirectory()) {
    throw new UnusableWorkspacePathError(`不是目录:${absolute}`);
  }

  if (absolute === os.homedir() || absolute === path.parse(absolute).root) {
    throw new UnusableWorkspacePathError(
      "工作区不能是家目录或文件系统根 —— 请选一个具体的项目目录。"
    );
  }

  return absolute;
};