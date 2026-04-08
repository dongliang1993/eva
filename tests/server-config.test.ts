import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../apps/server/src/config.js";

const tempDirs: string[] = [];

const createWorkspace = async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "eva-config-"));
  const serverDir = path.join(rootDir, "apps/server");

  tempDirs.push(rootDir);

  await mkdir(serverDir, {
    recursive: true
  });
  await writeFile(
    path.join(rootDir, "pnpm-workspace.yaml"),
    ["packages:", "  - apps/*", "  - packages/*"].join("\n")
  );

  return {
    rootDir,
    serverDir
  };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("loadConfig", () => {
  it("loads .env.local from the workspace root and the server directory", async () => {
    const { rootDir, serverDir } = await createWorkspace();

    await writeFile(
      path.join(rootDir, ".env.local"),
      [
        "LLM_API_KEY=root-key",
        "LLM_BASE_URL=https://root.example.com/v1",
        "LLM_MODEL=root-model"
      ].join("\n")
    );
    await writeFile(
      path.join(serverDir, ".env.local"),
      [
        "LLM_API_KEY=server-key",
        "LLM_BASE_URL=https://server.example.com/v1"
      ].join("\n")
    );

    const config = loadConfig({
      env: {},
      cwd: serverDir
    });

    expect(config.LLM_API_KEY).toBe("server-key");
    expect(config.LLM_BASE_URL).toBe("https://server.example.com/v1");
    expect(config.LLM_MODEL).toBe("root-model");
  });

  it("keeps process env as the highest-priority source", async () => {
    const { serverDir } = await createWorkspace();

    await writeFile(
      path.join(serverDir, ".env.local"),
      ["LLM_API_KEY=file-key", "LLM_BASE_URL=https://file.example.com/v1"].join(
        "\n"
      )
    );

    const config = loadConfig({
      env: {
        LLM_API_KEY: "process-key",
        LLM_BASE_URL: "https://process.example.com/v1"
      },
      cwd: serverDir
    });

    expect(config.LLM_API_KEY).toBe("process-key");
    expect(config.LLM_BASE_URL).toBe("https://process.example.com/v1");
  });

  it("uses LLM config for web search availability", async () => {
    const { serverDir } = await createWorkspace();

    const config = loadConfig({
      env: {
        LLM_API_KEY: "llm-key",
        LLM_BASE_URL: "https://api.example.com/v1"
      },
      cwd: serverDir
    });

    expect(config.LLM_API_KEY).toBe("llm-key");
    expect(config.LLM_BASE_URL).toBe("https://api.example.com/v1");
  });
});
