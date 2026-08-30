#!/usr/bin/env node
/**
 * Eva 架构边界检查 —— 唯一的自动化边界执行器。
 *
 * 为什么是一个手写脚本，而不是 ESLint / dependency-cruiser:
 * 见 docs/architecture/25-eva-simple-architecture-charter.md §10.0。
 * 简版理由:这个仓库此前没有任何 lint 配置,直接引入 ESLint 全家桶会立刻产出
 * 成百条与架构无关的风格告警,把真正要看的边界违规淹掉。等规则涨到 20 条以上、
 * 或者需要跨文件类型推导时,再讨论升级(§15 问题 13)。
 *
 * 它只做一件事:扫 import 说明符,按规则表判定。不做类型分析,不做符号级判定 ——
 * 需要符号级保证的不变量应该用「能力收窄接口」交给编译器(见宪法 C6),不要塞进这里。
 *
 * 用法:
 *   node scripts/check-architecture.mjs            # error 违规 → 退出 1;warning 只打印
 *   node scripts/check-architecture.mjs --strict    # warning 也算失败(某个 Wave 收敛后打开)
 *   node scripts/check-architecture.mjs --verbose   # warning 也逐行(默认按文件汇总)
 *   node scripts/check-architecture.mjs --list      # 只列规则与当前状态,不判定
 *
 * 已知局限(实测确认过的,别再重新发现一遍):
 *
 * 1. 注释里的 import 已正确剥离 —— `// from "fastify"` 不会被判违规(有探针验证过)。
 * 2. **字符串字面量**里恰好含 `from "fastify"` 这种形态会误报。现实代码里几乎不存在,
 *    且它是**误报而非漏报**(失败方向安全:宁可拦错也不放过)。真遇到就用规则的 `exempt`
 *    豁免那个文件并写清理由 —— 不要为这一种情况引入 AST parser,那会把这个 130 行的
 *    脚本变成一个需要维护的编译器前端。
 * 3. 只看 import 与少量稳定文本表达式,不做类型推导。需要「谁能调这个方法」级别的保证时,
 *    用宪法 C6 的「能力收窄接口」交给 TypeScript(例:RunOpeningLedger / RunSettlingLedger),
 *    那是编译期、更早也更准。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const LIST_ONLY = args.has("--list");

/** 永不扫描的目录 —— 产物、依赖、陈旧副本。 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-electron", "release",
  ".server-deploy", ".build", "coverage", ".refrences", ".claude", ".codex"
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * 规则表。
 *
 * level "error"   = 现状已满足,加锁防回退(§10.1)。第一天就是 error,零噪声。
 * level "warning" = 现状违反,随对应 Wave 收敛后改成 error(§10.2)。
 *
 * from       : 规则适用的路径前缀(仓库相对,POSIX 分隔符)
 * forbid     : 命中即违规的 import 说明符判定函数
 * forbidText : 可选,源文本级规则 —— 只用于**稳定的、不会漂移的表达式**
 *              (例如 Fastify decorator 名 `app.infra.db`,或 import 语句里的具体类名)。
 *              绝不要用它做符号级判定(`.settle(` 那种),变量改名就漏 ——
 *              那类不变量交给编译器(C6 能力收窄)。
 *              条目可带 `multiline: true`:整份源文本上匹配(用于跨行 import 块),
 *              行号由匹配位置反算。缺省是逐行匹配。
 * exempt     : 可选,豁免文件(仓库相对路径),必须写清理由
 */
const RULES = [
  {
    id: "harness-no-host",
    level: "error",
    since: "§10.1",
    from: ["packages/harness/src"],
    why: "Harness 是可独立测试的 Agent 执行内核,不能认识宿主(Fastify/Drizzle/Eva Server)",
    forbid: (spec) =>
      spec.includes("apps/") ||
      spec === "fastify" || spec.startsWith("fastify/") ||
      spec.startsWith("drizzle-orm") || spec.startsWith("drizzle-kit") ||
      spec === "better-sqlite3"
  },
  {
    id: "shared-wire-only",
    level: "error",
    since: "§10.1",
    from: ["packages/shared/src"],
    why: "Shared 只放跨进程线协议契约,必须能被浏览器直接消费 —— 不许碰 Node/宿主实现",
    forbid: (spec) =>
      spec.startsWith("node:") ||
      spec === "@eva/harness" || spec.startsWith("@eva/harness/") ||
      spec === "fastify" || spec.startsWith("fastify/") ||
      spec.startsWith("drizzle-orm") ||
      spec === "better-sqlite3" ||
      spec.includes("apps/")
  },
  {
    id: "web-no-backend",
    level: "error",
    since: "§10.1",
    from: ["apps/web/src"],
    why: "前端只能通过 HTTP/SSE 与 @eva/shared 契约与后端协作,不能直连后端实现",
    forbid: (spec) =>
      spec === "@eva/harness" || spec.startsWith("@eva/harness/") ||
      spec.includes("apps/server") ||
      spec.startsWith("drizzle-orm") ||
      spec === "better-sqlite3" ||
      spec === "fastify" || spec.startsWith("fastify/")
  },
  {
    id: "routes-only-app-api",
    level: "error",
    since: "§10.2 第 1 条,Wave 2 收敛(2026-08-30)",
    from: ["apps/server/src/routes"],
    why:
      "Route 只能经 app.api 拿东西(宪法 C2)。禁的不只是 app.infra.db —— " +
      "整个 app.infra 与 app.services 都不该出现在 route 里:前者是原始句柄(db/encryptor)," +
      "后者是有状态的长寿服务,route 拿到它就会开始编排。import 规则看不见这种形态," +
      "因为它们不 import db,而是把 app.infra.db 递给 service 函数",
    forbidText: [
      { pattern: /\bapp\.infra\b/g, label: "app.infra" },
      { pattern: /\bapp\.services\b/g, label: "app.services" }
    ]
  },
  {
    id: "repository-only-in-composition-root",
    level: "error",
    since: "§10.2 第 3 条,Wave 2 收敛(2026-08-30)",
    from: ["apps/server/src/routes", "apps/server/src/services/runs"],
    why:
      "Repository 只能在组合根(src/api/、src/services/index.ts、src/deps.ts)或所属模块的 " +
      "Adapter 内创建。route 与 run-preparation.ts 曾经各自 new,于是「谁拥有这张表」" +
      "这个问题没有答案。本条目前只覆盖已收敛的两处;services/ 下按模块自建的那些," +
      "要等 Wave 4 划出模块边界后才能判定是否越界(§10.2 第 3 条写的是 Wave 2–4)",
    forbidText: [
      { pattern: /\bnew\s+[A-Za-z]*Repository\s*\(/g, label: "new XxxRepository(" }
    ]
  },
  {
    id: "run-ledger-terminal-state",
    level: "error",
    since: "§7.2,Wave 1 落地",
    from: ["apps/server/src"],
    why:
      "Run 的终态只有一个出口。RunLedger 具体类同时带着 start/patchRouting 与 settle/fail —— " +
      "拿到它就等于拿到开第二个终态出口的能力。别处只能用两个窄视图 " +
      "RunOpeningLedger / RunSettlingLedger(宪法 C6 能力收窄,不是 Port)",
    // 只认「从 run-ledger 模块 import 了 RunLedger 这个名字」。\b 保证 RunOpeningLedger /
    // RunSettlingLedger 不被误伤(两者都不含 "RunLedger" 这个完整词)。
    // 这是 import 名级判定,不是符号级:改类名是刻意行为,应该同步改这条规则。
    forbidText: [
      {
        pattern: /import\s+(?:type\s+)?\{[^}]*\bRunLedger\b[^}]*\}\s*from\s*["'][^"']*run-ledger(?:\.js)?["']/g,
        label: "import { RunLedger }",
        multiline: true
      }
    ],
    exempt: [
      // 组合根:它就是那个 new 出唯一实例、再把两个视图分发下去的地方(C8)。
      "apps/server/src/services/index.ts",
      // AppServices 的类型声明。app.services.runLedger 的具体类型在这里定,
      // 组合根照它注入;它不调用任何方法。
      "apps/server/src/types/common.ts"
    ]
  },
  {
    id: "routes-no-db",
    level: "error",
    since: "§10.2 第 1 条,Wave 2 收敛(2026-08-30)",
    from: ["apps/server/src/routes"],
    why: "Route 只翻译协议(宪法 C2)。直接访问 DB 就是它同时在当业务总控",
    forbid: (spec) =>
      /(^|\/)db\//.test(spec) ||
      spec.includes("repositories/") ||
      /(^|\/)schema(\.js)?$/.test(spec) ||
      spec.startsWith("drizzle-orm")
  }
];

/** 递归收集源文件。 */
const collect = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在(例如某个 Wave 还没建)—— 不是错误
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
};

/**
 * 抽取 import 说明符及其行号。
 *
 * 先剥注释再匹配 —— 否则注释里提到 "fastify" 会被当成违规
 * (event-stream.ts 的注释就提到 Fastify,这不是 import)。
 * 剥注释时用等长空白替换,行号才不会漂移。
 */
const blankComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,      // import x from "y" / export x from "y"
  /\bimport\s*["']([^"']+)["']/g,    // import "y"
  /\bimport\s*\(\s*["']([^"']+)["']/g, // import("y")
  /\brequire\s*\(\s*["']([^"']+)["']/g // require("y")
];

const importsOf = (file) => {
  const src = blankComments(readFileSync(file, "utf-8"));
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const found = [];
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      found.push({ spec: m[1], line: lineOf(m.index) });
    }
  }
  return found;
};

const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

if (LIST_ONLY) {
  console.log("Eva 架构边界规则:\n");
  for (const rule of RULES) {
    console.log(`  [${rule.level.toUpperCase()}] ${rule.id}  (${rule.since})`);
    console.log(`      范围: ${rule.from.join(", ")}`);
    console.log(`      理由: ${rule.why}\n`);
  }
  process.exit(0);
}

const violations = [];

for (const rule of RULES) {
  for (const fromDir of rule.from) {
    for (const file of collect(path.join(ROOT, fromDir))) {
      const relFile = rel(file);
      if (rule.exempt?.includes(relFile)) continue;
      if (rule.forbid) {
        for (const { spec, line } of importsOf(file)) {
          if (rule.forbid(spec)) {
            violations.push({ rule, file: relFile, line, spec });
          }
        }
      }

      if (rule.forbidText) {
        // 文本规则同样先剥注释 —— 注释里提到 app.infra.db 不算违规。
        const src = blankComments(readFileSync(file, "utf-8"));
        const lines = src.split("\n");
        for (const { pattern, label, multiline } of rule.forbidText) {
          pattern.lastIndex = 0;
          if (multiline) {
            // 整份源文本上匹配:跨行的 import 块逐行看不出来。
            let m;
            while ((m = pattern.exec(src)) !== null) {
              const line = src.slice(0, m.index).split("\n").length;
              violations.push({ rule, file: relFile, line, spec: label });
              if (m[0].length === 0) pattern.lastIndex += 1; // 防零宽匹配死循环
            }
            continue;
          }
          lines.forEach((text, i) => {
            pattern.lastIndex = 0;
            if (pattern.test(text)) {
              violations.push({ rule, file: relFile, line: i + 1, spec: label });
            }
          });
        }
      }
    }
  }
}

const errors = violations.filter((v) => v.rule.level === "error");
const warnings = violations.filter((v) => v.rule.level === "warning");

/**
 * error 逐行列出(每一条都要单独修);warning 按文件汇总(存量违规,看的是「还剩几个文件」
 * 这个收敛进度,不是每一行)。--verbose 让 warning 也逐行 —— 真要动手修某个文件时才需要。
 */
const report = (list, label, detailed) => {
  if (list.length === 0) return;
  const byRule = new Map();
  for (const v of list) {
    if (!byRule.has(v.rule.id)) byRule.set(v.rule.id, []);
    byRule.get(v.rule.id).push(v);
  }

  console.log(`\n${label} —— ${list.length} 处,涉及 ${new Set(list.map((v) => v.file)).size} 个文件`);
  for (const [id, items] of byRule) {
    const rule = items[0].rule;
    const files = new Map();
    for (const v of items) files.set(v.file, (files.get(v.file) ?? 0) + 1);

    console.log(`\n  ${id} —— ${rule.why}`);
    console.log(`  (${rule.since})`);
    if (detailed) {
      for (const v of items) console.log(`    ${v.file}:${v.line}  →  ${v.spec}`);
    } else {
      for (const [file, count] of [...files].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(count).padStart(3)} 处  ${file}`);
      }
      console.log(`    (加 --verbose 看逐行)`);
    }
  }
};

report(errors, "❌ ERROR", true);
report(warnings, "⚠️  WARNING", args.has("--verbose"));

const failed = errors.length > 0 || (STRICT && warnings.length > 0);

console.log(
  `\nlint:arch —— ${RULES.length} 条规则,` +
    `${errors.length} error,${warnings.length} warning` +
    (STRICT ? "(strict:warning 也算失败)" : "") +
    (failed ? "" : " —— 通过")
);

process.exit(failed ? 1 : 0);
