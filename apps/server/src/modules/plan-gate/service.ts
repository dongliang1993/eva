import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlanGateHandle, PlanGateStore } from "@eva/harness";

import type { AppDatabase } from "../../db/index.js";
import { DrizzlePlanRepository } from "./plan-repository.js";
import {
  ensureEvaGitignore,
  planGateCurrentPath,
  planGateDir,
  planGateRelPath,
  planGateRevisionPath,
} from "./paths.js";

interface PlanGateWorkspace {
  readonly id: string;
  readonly root: string;
}

/**
 * T45a:PlanGateStore 的 server 实现。一个 run 一个实例,
 * session/workspace 在闭包里钉死 —— 工具入参永远不带路径。
 */
export const createPlanGateStore = (options: {
  readonly db: AppDatabase;
  readonly sessionId: string;
  readonly workspace: PlanGateWorkspace;
}): PlanGateStore => {
  const repo = new DrizzlePlanRepository(options.db);
  const { sessionId, workspace } = options;

  return {
    enter: async (): Promise<PlanGateHandle> => {
      if (repo.findActive(sessionId)) {
        throw new Error("Plan mode is already active for this session.");
      }

      const planId = randomUUID();
      const currentPath = planGateCurrentPath(workspace.root, planId);

      await ensureEvaGitignore(workspace.root);
      await mkdir(planGateDir(workspace.root, planId), { recursive: true });
      await writeFile(currentPath, "", "utf-8");

      repo.create({
        id: planId,
        sessionId,
        workspaceId: workspace.id,
        path: currentPath,
      });

      return {
        planId,
        planPath: currentPath,
        planRelPath: planGateRelPath(planId),
      };
    },

    readPlan: async (handle) => {
      try {
        return await readFile(handle.planPath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    },

    recordRevision: async (handle) => {
      const row = repo.findById(handle.planId);
      if (!row) throw new Error("Active plan no longer exists.");

      const next = row.revisionCount + 1;
      const revisionPath = planGateRevisionPath(workspace.root, handle.planId, next);
      await mkdir(path.dirname(revisionPath), { recursive: true });
      await copyFile(handle.planPath, revisionPath);
      repo.bumpRevision(handle.planId);

      return next;
    },

    approve: async (handle) => {
      repo.setStatus(handle.planId, "approved");
    },

    reject: async (handle) => {
      repo.setStatus(handle.planId, "rejected");
    },
  };
};
