import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "dotenv";
import { z } from "zod";

import { findWorkspaceRoot } from "./services/workspace/index.js";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8082),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // 显式工作区:未设置则不注入 fs 工具(见 deps.ts resolveWorkRoot)。不给
  // process.cwd() 默认值 —— 桌面端 cwd 是 app 资源目录,agent 写文件会落在 App 包里。
  TARGET_REPO_ROOT: z.string().default(""),
  INTERNAL_IM_SIGNING_SECRET: z.string().default(""),
  DB_PATH: z.string().default("")
});

export type AppConfig = z.infer<typeof envSchema>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const ENV_FILE_NAMES = [".env", ".env.local"] as const;

const loadEnvFile = (filePath: string): Record<string, string> => {
  if (!existsSync(filePath)) {
    return {};
  }

  return parse(readFileSync(filePath));
};

const listEnvFilePaths = (cwd: string): string[] => {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const dirs = workspaceRoot === cwd ? [workspaceRoot] : [workspaceRoot, cwd];
  const seen = new Set<string>();

  return dirs.flatMap((dir) =>
    ENV_FILE_NAMES.flatMap((fileName) => {
      const filePath = path.join(dir, fileName);

      if (seen.has(filePath)) {
        return [];
      }

      seen.add(filePath);
      return [filePath];
    })
  );
};

export const loadConfig = ({
  env = process.env,
  cwd = process.cwd()
}: LoadConfigOptions = {}): AppConfig => {
  const fileEnv = listEnvFilePaths(cwd).reduce<Record<string, string>>(
    (mergedEnv, filePath) => ({
      ...mergedEnv,
      ...loadEnvFile(filePath)
    }),
    {}
  );

  return envSchema.parse({
    ...fileEnv,
    ...env
  });
};
