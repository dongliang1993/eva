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
 * 把工作区根下的项目约定文件读成一个 prompt section。
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

  const header =
    `The user's workspace is \`${workspaceRoot}\`. The project ships the following conventions —\n` +
    `follow them; they override your defaults.\n`;

  const bodies = loaded.map(({ name, content }) => `### ${name}\n${content}`);
  let body = header + bodies.join("\n\n");

  if (Buffer.byteLength(body, "utf-8") > MAX_PROJECT_DOCS_BYTES) {
    body = truncateToBytes(body, MAX_PROJECT_DOCS_BYTES) + TRUNCATION_MARKER;
  }

  return { heading: "Project Context", body };
};

const truncateToBytes = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text, "utf-8");

  if (buf.length <= maxBytes) {
    return text;
  }

  return buf.subarray(0, maxBytes).toString("utf-8");
};