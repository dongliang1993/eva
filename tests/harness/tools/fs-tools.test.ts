import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T23 受控窗口:vi.spyOn 对 ESM 模块命名空间不可写,这里用 vi.mock 把
 * "node:fs/promises" 的 default 导出替换成浅拷贝(方法同真实模块但可挂),
 * 守卫用例再挂起 readFile/mkdir 制造"工具读到旧内容后、落盘前被外部改写"
 * 的时间窗。命名导出原样透传 —— 既有用例全走真路径。
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const copy = { ...actual };
  return { ...copy, default: copy };
});

import {
  createBashTool,
  createEditTool,
  createReadFileTool,
  createWriteTool,
  PathEscapeError,
  resolveReadablePath,
  resolveWorkspacePath,
} from "../../../packages/harness/src/index.js";

const tempDirs: string[] = [];

const makeWorkspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eva-fs-"));
  tempDirs.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("resolveWorkspacePath", () => {
  it("resolves within-root paths", () => {
    expect(resolveWorkspacePath("a/b.txt", "/ws")).toBe(
      path.join("/ws", "a/b.txt"),
    );
    expect(resolveWorkspacePath(".", "/ws")).toBe("/ws");
  });

  it("rejects parent traversal", () => {
    expect(() => resolveWorkspacePath("../etc/passwd", "/ws")).toThrow(
      PathEscapeError,
    );
    expect(() => resolveWorkspacePath("/etc/passwd", "/ws")).toThrow(
      PathEscapeError,
    );
    expect(() => resolveWorkspacePath("../../x", "/ws")).toThrow(
      PathEscapeError,
    );
  });
});

describe("fs tools", () => {
  it("writes and reads back a file within the workspace", async () => {
    const root = await makeWorkspace();
    const writeTool = createWriteTool({ workRoot: root });
    const readTool = createReadFileTool({ workRoot: root });

    await writeTool.tool.execute!(
      { path: "hello.txt", content: "line one\nline two\n" },
      { messages: [], toolCallId: "c1", context: {} },
    );

    const res = await readTool.tool.execute!(
      { path: "hello.txt" },
      { messages: [], toolCallId: "c2", context: {} },
    );
    expect(String(res)).toContain("line one");
    expect(String(res)).toContain("line two");
  });

  it("write blocks escaping the workspace", async () => {
    const root = await makeWorkspace();
    const writeTool = createWriteTool({ workRoot: root });

    const res = await writeTool.tool.execute!(
      { path: "../outside.txt", content: "x" },
      { messages: [], toolCallId: "c3", context: {} },
    );
    // buildTool 把沙盒错误包成 Error: 文本返回, 而非 reject。
    expect(String(res)).toContain("workspace");
  });

  it("edit replaces a unique occurrence", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "f.txt"), "hello world", "utf-8");
    const editTool = createEditTool({ workRoot: root });

    const res = await editTool.tool.execute!(
      { path: "f.txt", before: "world", after: "eva" },
      { messages: [], toolCallId: "c4", context: {} },
    );
    expect(String(res)).toContain("Edited");
  });

  it("edit rejects a non-unique before", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "f.txt"), "world world", "utf8");
    const editTool = createEditTool({ workRoot: root });

    const res = await editTool.tool.execute!(
      { path: "f.txt", before: "world", after: "eva" },
      { messages: [], toolCallId: "c5", context: {} },
    );
    expect(String(res)).toContain("appears 2 times");
  });
});

describe("readableRoots(overflow 白名单)", () => {
  it("resolveReadablePath 读工作区内 → 正常", () => {
    const root = "/ws";
    expect(resolveReadablePath("a/b.txt", root)).toBe(
      path.join("/ws", "a/b.txt"),
    );
  });

  it("resolveReadablePath 读 extraReadableRoots 里的文件 → 正常", () => {
    // maybeOverflow 返回绝对路径,所以这里也传绝对路径。相对路径会先命中 workRoot。
    expect(resolveReadablePath("/extra/overflow.txt", "/ws", ["/extra"])).toBe(
      "/extra/overflow.txt",
    );
  });

  it("resolveReadablePath 读两者之外 → PathEscapeError", () => {
    expect(() => resolveReadablePath("/etc/hosts", "/ws", ["/extra"])).toThrow(
      PathEscapeError,
    );
  });

  it("read_file 能读回 readableRoots 里的溢出文件;write 对同一路径仍拒绝", async () => {
    const root = await makeWorkspace();
    const overflowDir = await mkdtemp(path.join(os.tmpdir(), "eva-overflow-"));
    tempDirs.push(overflowDir);

    const overflowFile = path.join(overflowDir, "big.log");
    await writeFile(overflowFile, "overflowed content", "utf-8");

    const readTool = createReadFileTool({
      workRoot: root,
      overflowDir,
      readableRoots: [overflowDir],
    });
    const readRes = await readTool.tool.execute!(
      { path: overflowFile },
      { messages: [], toolCallId: "c-read", context: {} },
    );
    expect(String(readRes)).toContain("overflowed content");

    // write 工具不用 readableRoots,给绝对路径溢出文件 → 仍按工作区解析并拒绝(白名单不放开写)。
    const writeTool = createWriteTool({ workRoot: root, overflowDir });
    const writeRes = await writeTool.tool.execute!(
      { path: overflowFile, content: "x" },
      { messages: [], toolCallId: "c-write", context: {} },
    );
    expect(String(writeRes)).toContain("workspace");
  });
});

describe("bash tool", () => {
  it("需要 description 参数 —— 缺它时 schema 解析失败,execute 不应被调用", async () => {
    const root = await makeWorkspace();
    const bashTool = createBashTool({ workRoot: root });

    // buildTool 在 execute 内 parse schema;只给 command 不给 description → parse 抛错 →
    // 被包装成 Error: 输出,命令不会真的执行。
    const res = await bashTool.tool.execute!(
      { command: "echo hi" } as unknown as {
        command: string;
        description: string;
      },
      { messages: [], toolCallId: "c-bash-1", context: {} },
    );
    expect(String(res)).toContain("Error:");
  });

  it("command + description 齐全 → 在工作区内执行,输出含命令结果", async () => {
    const root = await makeWorkspace();
    const bashTool = createBashTool({ workRoot: root });

    const res = await bashTool.tool.execute!(
      { command: "printf 'hello-bash'", description: "Print a marker string" },
      { messages: [], toolCallId: "c-bash-2", context: {} },
    );
    expect(String(res)).toContain("hello-bash");
  });
});
describe("write guard(T23 mtime 快照校验)", () => {
  const editExec = (root: string, input: Record<string, unknown>, id: string) =>
    createEditTool({ workRoot: root }).tool.execute!(
      input as never,
      { messages: [], toolCallId: id, context: {} } as never,
    );
  const writeExec = (
    root: string,
    input: Record<string, unknown>,
    id: string,
  ) =>
    createWriteTool({ workRoot: root }).tool.execute!(
      input as never,
      { messages: [], toolCallId: id, context: {} } as never,
    );
  const readFileAbs = (file: string) =>
    import("node:fs/promises").then((m) => m.readFile(file, "utf-8"));

  it("读后外部改写(mtime 变)→ edit 被拒,磁盘保持外部内容", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "g.txt"), "alpha beta", "utf-8");

    // 方案 A(受控窗口):让 edit 的 readFile 挂起一拍,期间改盘。
    // 只挂 readFile、stat 保持真实 —— spy 用后即恢(T23 坑 6)。
    const fsp = (await import("node:fs/promises")).default;
    const realReadFile = fsp.readFile.bind(fsp);
    const spy = vi
      .spyOn(fsp, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        const out = await realReadFile(...args);
        if (String(args[0]).endsWith("g.txt")) {
          await new Promise((r) => setTimeout(r, 20));
          await writeFile(path.join(root, "g.txt"), "alpha gamma", "utf-8");
        }
        return out;
      });

    try {
      const res = await editExec(
        root,
        { path: "g.txt", before: "beta", after: "BETA" },
        "wg-1",
      );
      expect(String(res)).toContain("modified since");
    } finally {
      spy.mockRestore();
    }

    // 外部写没有被 edit 抹掉(gamma 在,beta 没被换)。
    expect(await readFileAbs(path.join(root, "g.txt"))).toBe("alpha gamma");
  });

  it("等长改写(size 不变、mtime 被抹平)→ edit 仍被拒(ctime 因子兜底)", async () => {
    const root = await makeWorkspace();
    const file = path.join(root, "eq.txt");
    await writeFile(file, "aaaa", "utf-8");

    // 改写必须发生在工具窗口内(挂 readFile 期间),外部再 utimes 把 mtime
    // 拨回原值 —— 单 mtime 比对会漏;ctime 是内核维护的,utimes 恢复不了。
    const fsp = (await import("node:fs/promises")).default;
    const realReadFile3 = fsp.readFile.bind(fsp);
    const spy = vi
      .spyOn(fsp, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        const out = await realReadFile3(...args);
        if (String(args[0]).endsWith("eq.txt")) {
          await new Promise((r) => setTimeout(r, 20));
          const before0 = await stat(file);
          await writeFile(file, "bbbb", "utf-8");
          await utimes(file, before0.mtime, before0.mtime);
        }
        return out;
      });

    try {
      const res = await editExec(
        root,
        { path: "eq.txt", before: "aaaa", after: "AAAA" },
        "wg-2",
      );
      expect(String(res)).toContain("modified since");
    } finally {
      spy.mockRestore();
    }
  });

  it("mtime/size 变了但 before 对新内容仍唯一命中 → 放宽放行,替换基于新内容", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "r.txt"), "keep1 old keep2", "utf-8");

    const fsp = (await import("node:fs/promises")).default;
    const realReadFile2 = fsp.readFile.bind(fsp);
    const spy = vi
      .spyOn(fsp, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        const out = await realReadFile2(...args);
        if (String(args[0]).endsWith("r.txt")) {
          await new Promise((r) => setTimeout(r, 20));
          // 外部在无关区域改写(不动 before 锚文本,等长)。
          await writeFile(path.join(root, "r.txt"), "keep1 old KEEP2", "utf-8");
        }
        return out;
      });

    try {
      const res = await editExec(
        root,
        { path: "r.txt", before: "old", after: "NEW" },
        "wg-3",
      );
      expect(String(res)).toContain("Edited");
    } finally {
      spy.mockRestore();
    }

    // 外部改动(KEEP2)与本次替换(NEW)同时在场 —— replace 基于重读后的新内容。
    expect(await readFileAbs(path.join(root, "r.txt"))).toBe("keep1 NEW KEEP2");
  });

  it("write(overwrite)开始后文件被外部改 → 拒;append 豁免照常追加", async () => {
    const root = await makeWorkspace();
    const file = path.join(root, "w.txt");
    await writeFile(file, "v0", "utf-8");

    // 挂 stat(write 守卫的第一次 stat)制造"快照基线建立后、比对前"的外部改写窗口。
    // mkdir 在基线之前挂没用 —— 外部写会进基线本身。stat 是 guard 的敏感点。
    const fsp = (await import("node:fs/promises")).default;
    const realStat = fsp.stat.bind(fsp);
    let statCalls = 0;
    const spy = vi
      .spyOn(fsp, "stat")
      .mockImplementation(async (...args: Parameters<typeof fsp.stat>) => {
        statCalls += 1;
        const out = await realStat(...args);
        if (String(args[0]).endsWith("w.txt") && statCalls === 1) {
          await new Promise((r) => setTimeout(r, 10));
          // 外部写发生在 stat① 之后、stat② 之前 —— 正是守卫要比对的窗口。
          await writeFile(file, "EXTERNAL", "utf-8");
        }
        return out;
      });

    try {
      const over = await writeExec(
        root,
        { path: "w.txt", content: "mine" },
        "wg-4",
      );
      expect(String(over)).toContain("modified since");
    } finally {
      spy.mockRestore();
    }
    expect(await readFileAbs(file)).toBe("EXTERNAL");

    // append:语义是"追加到终态",不依赖读时状态 → 外部改过也照常追加。
    const app = await writeExec(
      root,
      { path: "w.txt", content: "+tail", append: true },
      "wg-5",
    );
    expect(String(app)).toContain("append");
    expect(await readFileAbs(file)).toBe("EXTERNAL+tail");
  });

  it("真并发两个 edit 打同一文件 → 后到者基于新内容改,两个改动都在(守门用例)", async () => {
    const root = await makeWorkspace();
    const file = path.join(root, "c.txt");
    await writeFile(file, "aaa bbb ccc", "utf-8");

    // 微任务对称交错下,同类 await 点会对齐推进(实测:所有 read 先齐、所有
    // write 后齐),守卫结构性失明 —— 必须用差异化延迟打破对称才对应真实
    // 工具调用形态(两个 edit 的 IO 耗时天然不同)。甲不挂、乙挂 20ms:
    // 甲先落盘 → 乙 stat② 发现 stale → 重读拿到甲的成果 → recheck 唯一 →
    // 基于新内容 replace。
    const fsp = (await import("node:fs/promises")).default;
    const realReadFile4 = fsp.readFile.bind(fsp);
    const spy = vi
      .spyOn(fsp, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        const out = await realReadFile4(...args);
        // 只挂乙的第一次读(第二个调用到 c.txt 的)。
        if (String(args[0]).endsWith("c.txt")) {
          slowReads += 1;
          if (slowReads === 2) {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        return out;
      });
    let slowReads = 0;

    try {
      const tool = createEditTool({ workRoot: root });
      const opt = { messages: [], context: {} } as never;
      const [r1, r2] = await Promise.all([
        tool.tool.execute!({ path: "c.txt", before: "aaa", after: "AAA" }, opt),
        tool.tool.execute!({ path: "c.txt", before: "ccc", after: "CCC" }, opt),
      ]);
      expect(String(r1)).toContain("Edited");
      expect(String(r2)).toContain("Edited");
    } finally {
      spy.mockRestore();
    }

    // 摘除实验的锚点:实现里删掉 stat② 比对,乙会基于旧快照覆盖写,
    // AAA 消失 → 这条断言变红。
    const finalContent = await readFileAbs(file);
    expect(finalContent).toBe("AAA bbb CCC");
  });
});

describe("bash 取消(T25 abortSignal 接线)", () => {
  it("sleep 中 abort → 秒级返回取消标记,不等到 timeout", async () => {
    const root = await makeWorkspace();
    const bashTool = createBashTool({ workRoot: root });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const startedAt = Date.now();
    const res = await bashTool.tool.execute!(
      {
        command: "sleep 10 && echo done",
        description: "Sleep long enough to be canceled",
      },
      {
        messages: [],
        toolCallId: "c-bash-abort",
        context: {},
        abortSignal: controller.signal,
      } as never,
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(3000);
    expect(String(res)).toMatch(/cancel|abort|SIGTERM/i);
  });

  it("不 abort → 照常跑完并返回输出", async () => {
    const root = await makeWorkspace();
    const bashTool = createBashTool({ workRoot: root });
    const res = await bashTool.tool.execute!(
      {
        command: "printf 'ran-to-completion'",
        description: "Print completion marker",
      },
      { messages: [], toolCallId: "c-bash-ok", context: {} } as never,
    );
    expect(String(res)).toContain("ran-to-completion");
  });

  it("取消复合命令 → 子孙进程也被组杀,不留孤儿", async () => {
    const root = await makeWorkspace();
    const bashTool = createBashTool({ workRoot: root });
    // 复合命令下 bash 无法对末尾命令做 exec 优化,必须等前台子进程 ——
    // 这正是孤儿场景:只杀 bash 的话 sleep 会存活。用标记文件名保证
    // ps 只可能匹配到本次测试起的进程。
    const marker = `eva-orphan-${Date.now()}-${process.pid}`;
    const controller = new AbortController();
    const pending = bashTool.tool.execute!(
      {
        command: `sleep 30 && echo ${marker}`,
        description: "Compound command that spawns children",
      },
      {
        messages: [],
        toolCallId: "c-bash-tree",
        context: {},
        abortSignal: controller.signal,
      } as never,
    );
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    const res = await pending;
    expect(String(res)).toBe("Error: tool call aborted");

    // 给进程表一点收敛时间,然后确认进程树无残留。
    await new Promise((r) => setTimeout(r, 300));
    const ps = await execPs();
    expect(ps).not.toContain(marker);
    expect(ps).not.toContain("sleep 30");
  });
});

/** 进程表快照,供孤儿断言用。 */
const execPs = async (): Promise<string> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)("ps", ["-eo", "pid,command"]).then(
    ({ stdout }) => stdout,
  );
};
