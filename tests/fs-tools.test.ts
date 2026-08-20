import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBashTool,
  createEditTool,
  createReadFileTool,
  createWriteTool,
  PathEscapeError,
  resolveReadablePath,
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

describe("readableRoots(overflow 白名单)", () => {
  it("resolveReadablePath 读工作区内 → 正常", () => {
    const root = "/ws";
    expect(resolveReadablePath("a/b.txt", root)).toBe(path.join("/ws", "a/b.txt"));
  });

  it("resolveReadablePath 读 extraReadableRoots 里的文件 → 正常", () => {
    // maybeOverflow 返回绝对路径,所以这里也传绝对路径。相对路径会先命中 workRoot。
    expect(resolveReadablePath("/extra/overflow.txt", "/ws", ["/extra"])).toBe("/extra/overflow.txt");
  });

  it("resolveReadablePath 读两者之外 → PathEscapeError", () => {
    expect(() => resolveReadablePath("/etc/hosts", "/ws", ["/extra"])).toThrow(PathEscapeError);
  });

  it("read_file 能读回 readableRoots 里的溢出文件;write 对同一路径仍拒绝", async () => {
    const root = await makeWorkspace();
    const overflowDir = await mkdtemp(path.join(os.tmpdir(), "eva-overflow-"));
    tempDirs.push(overflowDir);

    const overflowFile = path.join(overflowDir, "big.log");
    await writeFile(overflowFile, "overflowed content", "utf-8");

    const readTool = createReadFileTool({ workRoot: root, overflowDir, readableRoots: [overflowDir] });
    const readRes = await readTool.tool.execute!(
      { path: overflowFile },
      { messages: [], toolCallId: "c-read", context: {} }
    );
    expect(String(readRes)).toContain("overflowed content");

    // write 工具不用 readableRoots,给绝对路径溢出文件 → 仍按工作区解析并拒绝(白名单不放开写)。
    const writeTool = createWriteTool({ workRoot: root, overflowDir });
    const writeRes = await writeTool.tool.execute!(
      { path: overflowFile, content: "x" },
      { messages: [], toolCallId: "c-write", context: {} }
    );
    expect(String(writeRes)).toContain("workspace");
  });
});

describe("bash tool", () => {
  it("需要 description 参数 —— 缺它时 schema 解析失败,execute 不应被调用", async () => {
    const root = await makeWorkspace();
    const bashTool = createBashTool({ workRoot: root });

    // buildTool 在 execute 内 parse schema;只给 command 不给 description → parse 抛错 →
    // 被包装成 [Tool Error] 输出,命令不会真的执行。
    const res = await bashTool.tool.execute!(
      { command: "echo hi" } as unknown as { command: string; description: string },
      { messages: [], toolCallId: "c-bash-1", context: {} }
    );
    expect(String(res)).toContain("[Tool Error]");
  });

  it("command + description 齐全 → 在工作区内执行,输出含命令结果", async () => {
    const root = await makeWorkspace();
    const bashTool = createBashTool({ workRoot: root });

    const res = await bashTool.tool.execute!(
      { command: "printf 'hello-bash'", description: "Print a marker string" },
      { messages: [], toolCallId: "c-bash-2", context: {} }
    );
    expect(String(res)).toContain("hello-bash");
  });
});