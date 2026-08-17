import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * tool-overflow (04 §2.3, ~30 行) —— 单条工具输出过大时落盘, 只给模型摘要+路径,
 * 避免超大输出爆 context。模型后续可用 read 工具续读该文件。
 */
const OVERFLOW_LIMIT = 4000;

const writeOverflowFile = (dir: string, fileName: string, text: string): string => {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, text, "utf-8");
  return filePath;
};

/**
 * 若 text 超限:落盘到 outputRoot 并返回摘要+路径;未超限直接返回原文。
 * callId 建议传工具调用 id,保证每次落盘唯一。
 */
export const maybeOverflow = (
  text: string,
  outputRoot: string,
  toolName: string,
  callId?: string
): string => {
  if (text.length <= OVERFLOW_LIMIT) {
    return text;
  }

  const fileName = `${toolName}${callId ? `-${callId}` : ""}-${Date.now()}.txt`;
  const filePath = writeOverflowFile(outputRoot, fileName, text);

  return (
    `Output too long (${text.length} chars). Full output saved to:\n` +
    `${filePath}\n` +
    `Use read_file on that path (with offset/limit) to read it.`
  );
};