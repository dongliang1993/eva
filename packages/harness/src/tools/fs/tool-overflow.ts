import { createHash } from "node:crypto";
import path from "node:path";
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";

/**
 * tool-overflow (04 §2.3) —— 单条工具输出过大时落盘, 只给模型摘要+路径,
 * 避免超大输出爆 context。模型后续可用 read 工具续读该文件。
 *
 * T20 治理版(docs 04 §8.6.2 对齐 Alma):落盘前四道工序,顺序不可换 ——
 *   ① ANSI 清洗   颜色码是给人看的,落盘文件是给模型读的
 *   ② 脱敏        落盘文件生命周期可能长于会话,密钥不许躺着
 *   ③ 内容寻址    清洗后的内容定 sha1,同内容不重写(Date.now 命名的时代,
 *                 grep 一个大日志十次就是十个相同文件)
 *   ④ 写盘 + LRU  超 200 文件 / 100MB 按 mtime 清最旧(否则目录永久单调增长)
 *
 * 为什么先清洗再 hash:清洗是确定性的,同一原始输出清洗后必得同一文本,
 * hash 稳定,内容寻址才成立。反了(先 hash 原文)等于没寻址。
 */

/**
 * 单条输出落盘阈值。Alma 用 2000 字节,Eva 历来 4000 字符也没爆过 context ——
 * 维持 4000,本轮治理的是"落盘之后"的事,不改触发面。
 * (阈值下调是另一个独立决策:收益是 context 更省,代价是模型要多花轮次续读。)
 */
const OVERFLOW_LIMIT = 4000;

/** 落盘目录文件数上限。Alma 同款:一个活跃工作区一周产出 ~50 个,200 给足余量。 */
const MAX_FILES = 200;

/** 落盘目录总字节上限。Alma 同款 100MB:单个 overflow 典型 4KB-1MB。 */
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** ECMA-48 终端转义序列全覆盖(Alma 同款正则)。 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * 授权头:authorization: bearer xxx / token xxx(大小写不敏感)。
 * Alma 同款 —— 8 字符下限避免误伤 "bearer is" 这类散文。
 */
const AUTH_HEADER = /\b(authorization\s*[:=]\s*["']?(?:bearer|token)\s+)([^\s"',}]{8,})/gi;

/**
 * KEY=VALUE 形态的常见密钥名。Alma 没有这条,但 env 输出场景在 Eva 同样
 * 存在(bash 工具跑 env/printenv)。值保留前 4 字符:够辨认是哪个 key,不够用。
 * 短值也整体打码 —— 6 位 OTP 之类的短密钥不能豁免。
 */
const KEY_VALUE = /\b([A-Za-z_]*(?:api[_-]?key|token|secret|password))\s*[:=]\s*["']?([^\s"',}]{4})[^\s"',}]*/gi;

const redactMatch = (value: string): string =>
  `${value.slice(0, 4)}…[redacted ${value.length - 4} chars]`;

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

export const redactSecrets = (text: string): string =>
  text
    .replace(AUTH_HEADER, (_m, prefix: string, value: string) => `${prefix}${redactMatch(value)}`)
    .replace(KEY_VALUE, (_m, key: string, head: string) => `${key}=${redactMatch(head)}`);

/** 文件名清洗:非法字符全去掉,最多 40 字符(Alma 的 Gm 同款)。 */
const sanitizeName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "tool";

const contentFileName = (toolName: string, text: string): string => {
  const hash = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
  return `${sanitizeName(toolName)}-${hash}.log`;
};

const countLines = (text: string): number => {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
};

export interface OverflowGovernance {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_GOVERNANCE: OverflowGovernance = {
  maxFiles: MAX_FILES,
  maxTotalBytes: MAX_TOTAL_BYTES
};

/** 同一目录的清理节流标记 —— 写盘后才排一次,清理期间再写不重排(Alma 的 Hm 同款)。 */
const reapScheduled = new Set<string>();

const reapOldest = (dir: string, governance: OverflowGovernance): void => {
  try {
    const files = readdirSync(dir)
      .map((name) => {
        try {
          const full = path.join(dir, name);
          const st = statSync(full);
          return st.isFile() ? { full, mtime: st.mtimeMs, size: st.size } : undefined;
        } catch {
          // 清理是家政:单个文件出问题(被外部删了等)跳过,不影响主路径。
          return undefined;
        }
      })
      .filter((f): f is { full: string; mtime: number; size: number } => f !== undefined);

    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (files.length <= governance.maxFiles && total <= governance.maxTotalBytes) return;

    files.sort((a, b) => a.mtime - b.mtime);
    let count = files.length;
    for (const file of files) {
      if (count <= governance.maxFiles && total <= governance.maxTotalBytes) break;
      try {
        unlinkSync(file.full);
        count -= 1;
        total -= file.size;
      } catch {
        // 同上:删不动就跳下一个。
      }
    }
  } catch {
    // 目录本身出问题(权限等)—— 清理失败绝不影响工具调用。
  }
};

const scheduleReap = (dir: string, governance: OverflowGovernance): void => {
  if (reapScheduled.has(dir)) return;
  reapScheduled.add(dir);
  setTimeout(() => {
    reapScheduled.delete(dir);
    reapOldest(dir, governance);
  }, 0);
};

/**
 * 若 text 超限:清洗/脱敏后落盘到 outputRoot 并返回摘要+路径;未超限直接返回原文。
 *
 * @param callId 已废弃(内容寻址取代了按调用命名),保留仅为签名兼容 —— 5 处调用点都在传。
 * @param governance 测试注入用(小阈值复现 LRU);生产走默认值。
 *
 * EVA_TOOL_OVERFLOW=0 → 原样返回(不落盘不截断)。每次调用都读 env:
 * 排查时改完立即生效,一次 process.env 查找相对 4KB 字符串处理可忽略。
 */
export const maybeOverflow = (
  text: string,
  outputRoot: string,
  toolName: string,
  callId?: string,
  governance: OverflowGovernance = DEFAULT_GOVERNANCE
): string => {
  if (process.env.EVA_TOOL_OVERFLOW === "0") {
    return text;
  }
  if (text.length <= OVERFLOW_LIMIT) {
    return text;
  }
  void callId;

  const sanitized = redactSecrets(stripAnsi(text));

  mkdirSync(outputRoot, { recursive: true });
  const fileName = contentFileName(toolName, sanitized);
  const filePath = path.join(outputRoot, fileName);

  // 内容寻址:同 hash 已存在 → 不重写(写盘前的最后一道确认,stat 失败才写)。
  try {
    statSync(filePath);
  } catch {
    writeFileSync(filePath, sanitized, "utf-8");
  }

  scheduleReap(outputRoot, governance);

  return (
    `Output too long (${sanitized.length} chars after sanitization). Full output saved to:\n` +
    `${filePath} (${sanitized.length} chars, ${countLines(sanitized)} lines)\n` +
    `Use read_file on that path (with offset/limit) to read it.`
  );
};
