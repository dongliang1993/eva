/**
 * T29:bash 只读命令直放判定(docs/plans/r7/T29 §2.1)。
 *
 * 与 classifyToolRisk(risk.ts)的边界:risk 是给用户看的风险画像(宁可误报),
 * 这里是决定「弹不弹审批」的放行开关(宁可漏放)。漏放只是多弹一次审批,
 * 错放就是写了文件没弹窗 —— 所以排除形态在前、白名单准入在后,两步都过才直放。
 *
 * 与 Alma 的对齐:只抄「直放只读枚举」这一半(`main:33129-33160` 的 `Hb` 前半段),
 * 灰色一律弹(不抄小模型二审,r7 §2.1 #2)。
 *
 * 纯函数、无 IO —— harness 短路(with-approval)与 server 台账(runs.ts)共用
 * 这一个判定源,两处不会漂移(r7 §3 契约)。
 */

/** 排除形态:命令字符串里出现任一即否决(先否决,§2.1 第 1 步)。 */
const DENY_PATTERNS: readonly RegExp[] = [
  />/, // 任何重定向(> >> 2> >& —— 见字符即否决,不解析目标,误伤字符串里的 > 是可接受代价)
  /\|\s*tee\b/, // 管道进写
  /\|\s*(?:sh|bash|zsh)\b/, // 管道进 shell 执行
  /\|\s*xargs\b/, // xargs 可起任意命令
  /&&/, // 命令拼接:第二段不受白名单约束,整串否决(不逐段解析)
  /\|\|/,
  /;/,
  /`/, // 反引号替换:echo `rm -rf x` 的首 token 是 echo,不否决就是逃逸口
  /\$\(/, // $(...) 替换同上
  /\bsudo\b/ // 提权后白名单命令也能写
];

/** 白名单单词命令(§2.1 第 2 步)。 */
const ALLOW_WORDS: readonly string[] = [
  "ls",
  "cat",
  "grep",
  "find",
  "pwd",
  "echo",
  "head",
  "tail",
  "wc",
  "which"
];

/** git 只读子命令(双词组合 —— `git` 单词上榜会把 `git push --force` 也直放)。 */
const ALLOW_GIT_SUBCOMMANDS: readonly string[] = ["status", "log", "diff"];

/** 判定保守:命中白名单且无写/执行形态 → true;任何拿不准 → false(进审批)。 */
export const isSafeReadOnlyCommand = (command: string): boolean => {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // 第 1 步:排除形态(先否决)。
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  // 第 2 步:白名单准入。
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0]!;

  if (first === "git") {
    return tokens.length > 1 && ALLOW_GIT_SUBCOMMANDS.includes(tokens[1]!);
  }

  if (!ALLOW_WORDS.includes(first)) return false;

  // find 特例:白名单内的逃逸口,参数里含 -delete / -exec 即否决(Alma 同款标注)。
  if (first === "find" && tokens.some((t) => t === "-delete" || t === "-exec")) {
    return false;
  }

  return true;
};
