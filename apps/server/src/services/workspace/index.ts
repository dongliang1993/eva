import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Walk up from startDir to find the pnpm workspace root (signalled by
 * pnpm-workspace.yaml). Falls back to startDir if no workspace root is found.
 */
export const findWorkspaceRoot = (startDir: string): string => {
  let current = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
};