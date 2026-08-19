/**
 * 记忆文件(人类可读 Markdown)的存储契约。
 * harness 定契约,server 给实现 —— 与 `MemoryStore`(DB 版)完全同一套路:
 * 工具只知道"读/写/列文件",不知道文件在哪个根、怎么防穿越 —— 那是实现的事。
 *
 * 注意:这里的 rel 是"记忆根内相对路径"(如 "MEMORY.md" / "memory/2026-08-19.md")。
 * 实现必须做路径守卫,resolve 后确认仍在根内,否则抛错。
 */
export interface MemoryFileStore {
  /** 整文件读;不存在返回 undefined。路径穿越 → 抛错。 */
  readFile(rel: string): Promise<string | undefined>;
  /** 列出 MEMORY.md 与 memory/*.md,日记按日期倒序(今天在前)。 */
  list(): Promise<readonly string[]>;
  /** 往某天日记追加;文件不存在则带头标题创建。 */
  appendDailyNote(date: string, note: string): Promise<string>;
  /** 整文件替换 MEMORY.md。 */
  writeLongTermMemory(content: string): Promise<string>;
}
