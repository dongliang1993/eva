import type { PromptSection } from "@eva/harness";

import { MemoryFileStore } from "./memory-file-store.js";

/**
 * 注入上限。MEMORY.md 每轮全量进 system prompt,而它是人+agent 共同写的、
 * 没有任何机制阻止它长到几百 KB —— 失控的是持续成本,不是一次性成本。
 * 8 KB ≈ 2k token:够放几十条稳定事实,超了就该让 agent 精简而不是继续堆。
 */
export const MAX_LONG_TERM_BYTES = 8 * 1024;

/** 注入最近几天的日记。1 天太短(昨天的决定就忘了),3 天以上开始挤占预算。 */
export const DAILY_NOTE_DAYS = 2;

const TRUNCATION_MARKER =
  "\n\n[truncated at 8KB — read `MEMORY.md` with `read_memory_file(\"MEMORY.md\")` for the rest]";

/**
 * 把 L1 长时记忆 + 最近几天的日记读成一个 prompt section。
 *
 * 为什么这个函数收根目录而非依赖全局路径:注入与写工具用的是同一个 MemoryFileStore,
 * 测试可以注入临时根(路径守卫可测)。调用方(路由)用 evaDataDir() 算好根再传。
 *
 * @param todayString YYYY-MM-DD —— 由调用方算(todayString()),这里不再取 now,便于测试。
 * 两个文件都没有 → 返回 undefined(不要注入空标题,那是给模型的噪音)。
 */
export const loadMemoryFilesSection = async (
  memoryRoot: string,
  todayString: string
): Promise<PromptSection | undefined> => {
  const store = new MemoryFileStore(memoryRoot);
  const loaded: Array<{ name: string; content: string }> = [];

  const longTerm = await store.readFile("MEMORY.md");
  if (longTerm !== undefined) {
    loaded.push({ name: "MEMORY.md", content: longTerm });
  }

  // 今天 + 往前 DAILY_NOTE_DAYS-1 天,共 DAILY_NOTE_DAYS 个日期(含今天)。
  const dateOrder: string[] = [];
  {
    const [y, m, d] = todayString.split("-").map(Number);
    const base = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
    for (let i = 0; i < DAILY_NOTE_DAYS; i++) {
      const dt = new Date(base);
      dt.setDate(base.getDate() - i);
      const pad = (n: number) => String(n).padStart(2, "0");
      dateOrder.push(`${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`);
    }
  }

  for (const date of dateOrder) {
    const note = await store.readFile(`memory/${date}.md`);
    if (note !== undefined) {
      loaded.push({ name: `memory/${date}.md`, content: note });
    }
  }

  if (loaded.length === 0) {
    return undefined;
  }

  // 整体按"加载顺序"倒序会让标题越读越旧;这里重建,让最近的在最前。加载顺序里
  // MEMORY.md 固定第一,日记按日期倒序(今天在前),所以顺序本来就是"最新在前"。
  const bodies = loaded.map(({ name, content }) => `### ${name}\n${content}`);
  let body = bodies.join("\n\n");

  if (Buffer.byteLength(body, "utf-8") > MAX_LONG_TERM_BYTES) {
    body = truncateToBytes(body, MAX_LONG_TERM_BYTES) + TRUNCATION_MARKER;
  }

  return { heading: "Memory Files", body };
};

const truncateToBytes = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text, "utf-8");

  if (buf.length <= maxBytes) {
    return text;
  }

  return buf.subarray(0, maxBytes).toString("utf-8");
};
