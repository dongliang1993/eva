import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

/**
 * 把 pnpm deploy 产出的 node_modules 从符号链接解引用成实体文件。
 *
 * pnpm 的 node_modules 里 @eva/* 与部分顶层包(pino/fastify/...)是符号链接
 * (指向 .pnpm 虚拟 store)。electron-builder 拷贝 extraResources 时跟随链接,
 * 落到 .pnpm/node_modules/@eva/server 这类不存在的路径 → ENOENT。
 * tsup 已把 @eva/* bundle 进 dist/index.js,运行时不需要链接。
 *
 * 用 cp -RL(Hm macOS 支持)而非 Node cpSync:Node 的 dereference 对
 * "符号链接 → 目录" 在本版本不真正解引用,cp -L 是递归解引用的可靠手段。
 */
const target = process.argv[2];

if (!target) {
  throw new Error("usage: node flatten-node-modules.mjs <node_modules dir>");
}

const flat = `${target}.flat`;
rmSync(flat, { recursive: true, force: true });

execFileSync("cp", ["-RL", target, flat], { stdio: "inherit" });

rmSync(target, { recursive: true, force: true });
execFileSync("mv", [flat, target], { stdio: "inherit" });

const links = parseInt(
  execFileSync("find", [target, "-type", "l"], { encoding: "utf-8" }) || "0",
  10
);
console.log(
  `[flatten] node_modules dereferenced -> ${path.basename(target)} (nested symlinks: ${links || 0})`
);