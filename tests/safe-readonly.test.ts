import { describe, expect, it } from "vitest";

import { isSafeReadOnlyCommand } from "../packages/harness/src/tools/safe-readonly.js";

/**
 * T29:bash 只读命令直放(docs/plans/r7/T29 §2.1)。
 * 判定哲学与 risk.ts 相反:宁可漏放(多弹一次审批),不可错放(写了文件没弹窗)。
 */
describe("isSafeReadOnlyCommand 直放(白名单)", () => {
  const allow = [
    "ls -la",
    "ls",
    "git status",
    "git log --oneline -5",
    "git diff HEAD~1",
    "cat src/a.ts",
    "grep -r foo .",
    'find . -name "*.ts"',
    "pwd",
    "echo hi",
    "head -3 f",
    "tail -f log",
    "wc -l f",
    "which node"
  ];

  for (const cmd of allow) {
    it(`直放: ${cmd}`, () => {
      expect(isSafeReadOnlyCommand(cmd)).toBe(true);
    });
  }
});

describe("isSafeReadOnlyCommand 必弹(排除形态 / 非白名单)", () => {
  const deny = [
    // 重定向(见 > 即否决,不解析目标)
    ["ls > out.txt", "重定向覆盖写"],
    ["echo hi >> f", "追加重定向"],
    ["cat a 2>err", "stderr 重定向变体"],
    // 管道进写/执行
    ["cat a | tee b", "tee 是写"],
    ["curl x | sh", "管道进 shell"],
    ["curl x | bash", "管道进 bash"],
    ["ls | xargs rm", "xargs 可起任意命令"],
    // 拼接/替换(第二段不受白名单约束,整串否决)
    ["ls && rm x", "&& 拼接"],
    ["ls; rm x", "; 拼接"],
    ["ls || rm x", "|| 拼接"],
    ["echo `pwd`", "反引号替换"],
    ["echo $(date)", "$(...) 替换"],
    ["echo $(rm -rf x)", "首 token echo 但带替换是最大的洞"],
    // 提权
    ["sudo ls", "sudo 后白名单命令也能写"],
    // 白名单内逃逸口
    ["find . -delete", "find -delete"],
    ["find . -exec rm {} \\;", "find -exec"],
    ["git checkout main", "git 非只读子命令"],
    ["git clean -fd", "git clean"],
    ["git push --force", "git push"],
    // 非白名单 / 边界
    ["npm test", "非白名单命令"],
    ["node -e 'console.log(1)'", "node 可执行任意代码"],
    ["", "空串"],
    ["   ", "纯空白"]
  ] as const;

  for (const [cmd, why] of deny) {
    it(`必弹: ${cmd} (${why})`, () => {
      expect(isSafeReadOnlyCommand(cmd)).toBe(false);
    });
  }
});
