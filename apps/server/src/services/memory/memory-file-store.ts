import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 记忆文件的读写。
 *
 * 路径守卫:工具入参不可信,resolve 后必须确认仍在记忆根之内 —— 与 fs 工具的
 * resolveWorkspacePath 同一个红线,只是根不同。
 * 写锁:agent 可能在一轮里并发调多次写工具(并行 tool call),不串行化会互相截断。
 */
export class MemoryFileStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  /** resolve 后确认 target 仍在 root 之内,否则拒绝(绝对路径也在此被拦下)。 */
  private resolveInsideRoot(rel: string): string {
    const root = path.resolve(this.root) + path.sep;
    const target = path.resolve(this.root, rel);

    if (target !== path.resolve(this.root) && !target.startsWith(root)) {
      throw new Error(`path escapes the memory file root: ${rel}`);
    }

    return target;
  }

  /**
   * 整文件读;不存在返回 undefined(不抛)。
   * 注意:路径穿越是先抛错(守卫在 try 外),只有"文件不存在"才回落 undefined ——
   * 守卫是这个类的第一道红线(与 fs 工具同源),不能被"不存在"吞掉。
   */
  async readFile(rel: string): Promise<string | undefined> {
    const target = this.resolveInsideRoot(rel);
    try {
      return await readFile(target, "utf-8");
    } catch {
      return undefined;
    }
  }

  /** 列出 MEMORY.md 与 memory/*.md,日记按日期倒序(今天在前)。 */
  async list(): Promise<readonly string[]> {
    const rels: string[] = [];

    if ((await this.readFile("MEMORY.md")) !== undefined) {
      rels.push("MEMORY.md");
    }

    const memoRel = "memory";
    const memoDir = path.resolve(this.root, memoRel);
    const entries = (
      await import("node:fs/promises").then((fs) =>
        fs.readdir(memoDir, { withFileTypes: true }).catch(() => [])
      )
    ).filter((e) => e.isFile() && e.name.endsWith(".md"));

    const noteRels = entries
      .map((e) => `${memoRel}/${e.name}`)
      .sort((a, b) => b.localeCompare(a)); // YYYY-MM-DD 字典序即日期倒序

    return [...rels, ...noteRels];
  }

  /** 串行化写操作:append 是 read-modify-write,并发会互相截断。 */
  private enqueueWrite< T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  /** 往某天日记追加一条;文件不存在则带头标题创建。 */
  appendDailyNote(date: string, note: string): Promise<string> {
    return this.enqueueWrite(async () => {
      const rel = `memory/${date}.md`;
      const target = this.resolveInsideRoot(rel);
      const existing = await readFile(target, "utf-8").catch(() => undefined);

      const content =
        existing === undefined
          ? `# ${date}\n\n${note}\n`
          : `${existing.replace(/\s*$/, "")}\n\n${note}\n`;

      await import("node:fs/promises").then((fs) =>
        fs.mkdir(path.dirname(target), { recursive: true })
      );
      await writeFile(target, content, { encoding: "utf-8" });
      return target;
    });
  }

  /** 整文件替换 MEMORY.md。 */
  writeLongTermMemory(content: string): Promise<string> {
    return this.enqueueWrite(async () => {
      const target = this.resolveInsideRoot("MEMORY.md");
      await writeFile(target, content, { encoding: "utf-8" });
      return target;
    });
  }
}
