import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8082),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  TARGET_REPO_ROOT: z.string().default(process.cwd()),
  LLM_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().url().or(z.literal("")).default(""),
  LLM_MODEL: z.string().default("gpt-4.1-mini"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),
  INTERNAL_IM_SIGNING_SECRET: z.string().default(""),
  WEB_FETCH_MODEL: z.string().default(""),
  DB_PATH: z.string().default("")
});

export type AppConfig = z.infer<typeof envSchema>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const ENV_FILE_NAMES = [".env", ".env.local"] as const;

const findWorkspaceRoot = (startDir: string): string => {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return path.resolve(startDir);
    }

    currentDir = parentDir;
  }
};

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

export const isLlmConfigured = (config: AppConfig): boolean =>
  Boolean(config.LLM_API_KEY) && Boolean(config.LLM_BASE_URL);

export const isWebFetchConfigured = (config: AppConfig): boolean =>
  isLlmConfigured(config) && Boolean(config.WEB_FETCH_MODEL);

export const resolveRepositoryRoot = (
  config: AppConfig,
  overrideRoot?: string
): string => overrideRoot?.trim() || config.TARGET_REPO_ROOT;
