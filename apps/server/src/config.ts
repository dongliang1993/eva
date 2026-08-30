import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "dotenv";
import { z } from "zod";

import { findMonorepoRoot } from "./infrastructure/monorepo-root.js";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8082),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
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
  const workspaceRoot = findMonorepoRoot(cwd);
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
