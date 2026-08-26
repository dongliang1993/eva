import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** T45a:plan gate 文件唯一拼接口径（与 toolOverflowDir 同一条纪律）。 */
export const planGateDir = (workspaceRoot: string, planId: string): string =>
  path.join(workspaceRoot, ".eva", "plan-gate", planId);

export const planGateCurrentPath = (
  workspaceRoot: string,
  planId: string,
): string => path.join(planGateDir(workspaceRoot, planId), "current.md");

export const planGateRevisionPath = (
  workspaceRoot: string,
  planId: string,
  revision: number,
): string =>
  path.join(planGateDir(workspaceRoot, planId), "revisions", `v${revision}.md`);

export const planGateRelPath = (planId: string): string =>
  path.posix.join(".eva", "plan-gate", planId, "current.md");

/**
 * 只在 `<workspace>/.eva/.gitignore` 不存在时写入 `plan-gate/`。
 * 已存在 = 用户的文件，一字不动（不追加/不去重/不重排）。
 */
export const ensureEvaGitignore = async (
  workspaceRoot: string,
): Promise<void> => {
  const gitignorePath = path.join(workspaceRoot, ".eva", ".gitignore");
  try {
    await mkdir(path.dirname(gitignorePath), { recursive: true });
    await writeFile(gitignorePath, "plan-gate/\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
};
