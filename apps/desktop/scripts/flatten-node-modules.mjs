import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import path from "node:path";

/**
 * 把 pnpm deploy 产出的 node_modules 拍平成「普通 node_modules」——所有包都提升到
 * 顶层,删掉 .pnpm 隔离层。
 *
 * 为什么必须提升整个 .pnpm/node_modules,而不是只补个别包(实测踩坑,别再打地鼠):
 *
 * pnpm deploy --legacy 的产物是「pnpm 隔离布局」:
 *   node_modules/                 ← 只放 server 直接声明的 ~15 个包
 *   node_modules/.pnpm/<pkg>/node_modules/<dep>   ← 每个包的传递依赖,符号链接
 *   node_modules/.pnpm/node_modules/<dep>         ← 全部 198 个传递依赖的 hoisted 层
 *
 * 运行时 Node 解析 `import 'cross-spawn'`(MCP sdk 内部)时,按「逐层向上找 node_modules」
 * 的规则,从 server/node_modules 顶层找——顶层只有 15 个直接依赖,找不到 cross-spawn /
 * @ai-sdk/gateway / hono ... → ERR_MODULE_NOT_FOUND。
 *
 * 之前逐个 hoist(gateway、cross-spawn...)是打地鼠:MCP sdk 一个包就有 16 个传递依赖,
 * 永远补不完。正确做法是把 .pnpm/node_modules 这层(完整的 198 包)整个合并到顶层,
 * 让 Node 的常规解析能找到所有包,然后删掉 .pnpm。
 *
 * cp -RL 先解引用符号链接(electron-builder 跟链接会落到不存在的路径 → ENOENT);
 * @eva/* 已被 tsup bundle 进 dist/index.js,顶层那份@eva 链接可弃。
 */
const target = process.argv[2];

if (!target) {
  throw new Error("usage: node flatten-node-modules.mjs <node_modules dir>");
}

// 1. 解引用符号链接(目录→实体)
const flat = `${target}.flat`;
rmSync(flat, { recursive: true, force: true });
execFileSync("cp", ["-RL", target, flat], { stdio: "inherit" });
rmSync(target, { recursive: true, force: true });
execFileSync("mv", [flat, target], { stdio: "inherit" });

// 2. 把 .pnpm/node_modules 这层(全部传递依赖)合并到顶层
const pnpmStore = path.join(target, ".pnpm", "node_modules");
let hoisted = 0;

if (existsSync(pnpmStore)) {
  for (const entry of readdirSync(pnpmStore)) {
    if (entry.startsWith(".")) continue;

    const src = path.join(pnpmStore, entry);
    const dest = path.join(target, entry);

    if (entry.startsWith("@")) {
      // scoped:@scope/pkg —— 逐个子包合并(scope 目录可能已存在)
      for (const sub of readdirSync(src)) {
        const sdest = path.join(dest, sub);
        if (!existsSync(sdest)) {
          cpSync(path.join(src, sub), sdest, {
            recursive: true,
            dereference: true
          });
          hoisted++;
        }
      }
    } else if (!existsSync(dest)) {
      cpSync(src, dest, { recursive: true, dereference: true });
      hoisted++;
    }
  }
}

// 3. 提升完毕,.pnpm 隔离层整个删掉(不再是可解析路径,留着只占体积)
rmSync(path.join(target, ".pnpm"), { recursive: true, force: true });

// 4. 顶层 @eva/* 是指向 monorepo 源码的链接,已被 tsup bundle,删掉避免混淆
const evaScope = path.join(target, "@eva");
if (existsSync(evaScope)) {
  rmSync(evaScope, { recursive: true, force: true });
}

const remaining = parseInt(
  execFileSync("find", [target, "-type", "l"], { encoding: "utf-8" }) || "0",
  10
);
console.log(
  `[flatten] hoisted ${hoisted} packages from .pnpm, removed .pnpm + @eva links, ` +
    `node_modules flattened (remaining symlinks: ${remaining || 0})`
);
