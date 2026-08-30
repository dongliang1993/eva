import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PromptSection } from "@eva/harness";

/** 项目约定文件的读取顺序;都存在就都注入(CLAUDE.md 常常只是指向 AGENTS.md)。 */
const PROJECT_DOC_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/**
 * 注入上限 16 KB。system prompt 每轮全量进模型,而这两个文件是人写的、
 * 没有任何机制阻止它长到几百 KB —— 失控的是持续成本,不是一次性成本。
 */
const MAX_PROJECT_DOCS_BYTES = 16 * 1024;

const TRUNCATION_MARKER =
  "\n\n[truncated at 16KB — read the file with the read_file tool for the rest]";

/**
 * 与 DSH 注入 workspace 指令时逐字一致的引导语:项目约定只是 guidance,
 * 不覆盖 system/developer 指令(语义上比旧的 "override your defaults" 更弱,
 * 也更符合文件的实际地位)。
 */
const SYSTEM_REMINDER_PREAMBLE = [
  "The following workspace instructions may be relevant to your work.",
  "Use them as guidance when applicable.",
  "More specific instructions take precedence over broader ones.",
  "They do not override system, developer, or direct user instructions."
].join(" ");

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

/** 标签自身的字节开销:开闭标签 + 两个换行。 */
const REMINDER_TAG_BYTES =
  SYSTEM_REMINDER_OPEN.length + SYSTEM_REMINDER_CLOSE.length + 2;

/**
 * 把工作区根下的项目约定文件读成一个 prompt section,按 DSH 的
 * `<system-reminder>` 格式注入:引导语 + 逐文件 "Instructions from: X"。
 * 一个文件都没有 → 返回 undefined(不要注入空标题,那是给模型的噪音)。
 */
export const loadProjectDocsSection = async (
  workspaceRoot: string
): Promise<PromptSection | undefined> => {
  const loaded: Array<{ name: string; content: string }> = [];

  for (const fileName of PROJECT_DOC_FILES) {
    try {
      const content = await readFile(path.join(workspaceRoot, fileName), "utf-8");
      loaded.push({ name: fileName, content });
    } catch {
      // 文件不存在/不可读 —— 合法,跳过。
    }
  }

  if (loaded.length === 0) {
    return undefined;
  }

  // 截断只作用于标签内部,保证 `</system-reminder>` 永远闭合 ——
  // 否则未闭合的 reminder 块会把后面的 prompt 内容也吞进指令区。
  const innerBudget = MAX_PROJECT_DOCS_BYTES - REMINDER_TAG_BYTES;

  const blocks = loaded.map(
    ({ name, content }) => `Instructions from: ${name}\n\n${content}`
  );

  let inner = `${SYSTEM_REMINDER_PREAMBLE}\n\n${blocks.join("\n\n")}`;

  if (Buffer.byteLength(inner, "utf-8") > innerBudget) {
    inner = truncateToBytes(inner, innerBudget) + TRUNCATION_MARKER;
  }

  const body =
    `${SYSTEM_REMINDER_OPEN}\n` +
    `${inner}\n` +
    `${SYSTEM_REMINDER_CLOSE}`;

  return { heading: "Project Context", body };
};

const truncateToBytes = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text, "utf-8");

  if (buf.length <= maxBytes) {
    return text;
  }

  return buf.subarray(0, maxBytes).toString("utf-8");
};
