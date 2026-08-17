import path from "node:path";

/**
 * 工作区路径沙盒 (安全红线, 对应 docs S4 / Claude Code 的 deny·safety 层)。
 *
 * agent 的 write/edit/bash 都落在工作区内。本函数拒绝 `..` 逃逸,并把解析后的
 * 路径确认以 workRoot 为前缀, 否则抛错 —— 即使"始终允许", 也逃不出工作区。
 */
export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path escapes the workspace: ${requested}`);
    this.name = "PathEscapeError";
  }
}

export const resolveWorkspacePath = (
  input: string,
  workRoot: string
): string => {
  const root = path.resolve(workRoot);
  const absolute = path.resolve(root, input);
  const rel = path.relative(root, absolute);

  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathEscapeError(input);
  }

  return absolute;
};

/** 判断一个 absolute 路径是否落在 workRoot 内(供只读工具确认可读范围)。 */
export const isPathInsideWorkspace = (
  target: string,
  workRoot: string
): boolean => {
  const rel = path.relative(path.resolve(workRoot), path.resolve(target));
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};