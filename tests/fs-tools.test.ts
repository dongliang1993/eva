import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEditTool,
  createReadFileTool,
  createWriteTool,
  PathEscapeError,
  resolveWorkspacePath
} from "../packages/harness/src/index.js";

const tempDirs: string[] = [];

const makeWorkspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eva-fs-"));
  tempDirs.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("resolveWorkspacePath", () => {
  it("resolves within-root paths", () => {
    expect(resolveWorkspacePath("a/b.txt", "/ws")).toBe(path.join("/ws", "a/b.txt"));
    expect(resolveWorkspacePath(".", "/ws")).toBe("/ws");
  });

  it("rejects parent traversal", () => {
    expect(() => resolveWorkspacePath("../etc/passwd", "/ws")).toThrow(PathEscapeError);
    expect(() => resolveWorkspacePath("/etc/passwd", "/ws")).toThrow(PathEscapeError);
    expect(() => resolveWorkspacePath("../../x", "/ws")).toThrow(PathEscapeError);
  });
});

describe("fs tools", () => {
  it("writes and reads back a file within the workspace", async () => {
    const root = await makeWorkspace();
    const writeTool = createWriteTool({ workRoot: root });
    const readTool = createReadFileTool({ workRoot: root });

    await writeTool.tool.execute!(
      { path: "hello.txt", content: "line one\nline two\n" },
      { messages: [], toolCallId: "c1", context: {} }
    );

    const res = await readTool.tool.execute!(
      { path: "hello.txt" },
      { messages: [], toolCallId: "c2", context: {} }
    );
    expect(String(res)).toContain("line one");
    expect(String(res)).toContain("line two");
  });

  it("write blocks escaping the workspace", async () => {
    const root = await makeWorkspace();
    const writeTool = createWriteTool({ workRoot: root });

    const res = await writeTool.tool.execute!(
      { path: "../outside.txt", content: "x" },
      { messages: [], toolCallId: "c3", context: {} }
    );
    // buildTool 把沙盒错误包成 [Tool Error] 文本返回, 而非 reject。
    expect(String(res)).toContain("workspace");
  });

  it("edit replaces a unique occurrence", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "f.txt"), "hello world", "utf-8");
    const editTool = createEditTool({ workRoot: root });

    const res = await editTool.tool.execute!(
      { path: "f.txt", before: "world", after: "eva" },
      { messages: [], toolCallId: "c4", context: {} }
    );
    expect(String(res)).toContain("Edited");
  });

  it("edit rejects a non-unique before", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "f.txt"), "world world", "utf8");
    const editTool = createEditTool({ workRoot: root });

    const res = await editTool.tool.execute!(
      { path: "f.txt", before: "world", after: "eva" },
      { messages: [], toolCallId: "c5", context: {} }
    );
    expect(String(res)).toContain("appears 2 times");
  });
});