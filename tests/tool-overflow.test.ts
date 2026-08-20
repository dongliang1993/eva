import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { maybeOverflow } from "../packages/harness/src/tools/fs/tool-overflow.js";

const LONG = "x".repeat(5000);

describe("tool-overflow 治理 (T20)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "eva-overflow-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.EVA_TOOL_OVERFLOW;
  });

  describe("既有行为(回归)", () => {
    it("未超限 → 原文返回,不落盘", () => {
      const out = maybeOverflow("short", dir, "bash");
      expect(out).toBe("short");
      expect(readdirSync(dir)).toHaveLength(0);
    });

    it("超限 → 落盘并返回摘要+路径", () => {
      const out = maybeOverflow(LONG, dir, "bash");
      expect(out).toContain("Output too long");
      expect(out).toContain("read_file");
      expect(readdirSync(dir)).toHaveLength(1);
    });
  });

  describe("① ANSI 清洗", () => {
    it("落盘文件与返回摘要都不带颜色码", () => {
      const colored = `\x1b[31m${"e".repeat(3000)}\x1b[0m\x1b[32m${"o".repeat(3000)}\x1b[0m`;
      const out = maybeOverflow(colored, dir, "bash");

      expect(out).not.toContain("\x1b");
      const file = path.join(dir, readdirSync(dir)[0]!);
      expect(readFileSync(file, "utf-8")).not.toContain("\x1b");
      // 清洗后内容 = 原文去码
      expect(readFileSync(file, "utf-8")).toBe("e".repeat(3000) + "o".repeat(3000));
    });
  });

  describe("② 脱敏", () => {
    it("authorization: Bearer <token> → 前 4 保留,其余打码", () => {
      const text = `${"h".repeat(4500)}\nauthorization: Bearer sk-abc123def456\n`;
      maybeOverflow(text, dir, "bash");

      const content = readFileSync(path.join(dir, readdirSync(dir)[0]!), "utf-8");
      // sk-abc123def456 共 15 字符,留前 4 → 打码 11
      expect(content).toContain("Bearer sk-a…[redacted 11 chars]");
      expect(content).not.toContain("sk-abc123def456");
    });

    it("authorization: token <value>(大小写不敏感) → 打码", () => {
      const text = `${"h".repeat(4500)}\nAuthorization: token ghp_0123456789abcdef\n`;
      maybeOverflow(text, dir, "bash");

      const content = readFileSync(path.join(dir, readdirSync(dir)[0]!), "utf-8");
      expect(content).not.toContain("ghp_0123456789abcdef");
    });

    it("KEY=VALUE 形态(api_key/token/secret/password) → 打码,短值也不豁免", () => {
      const text = [
        "h".repeat(4500),
        "OPENAI_API_KEY=sk-proj-xyz789abcde",
        "db_password=short",
        "some_token: tok_abcdef123456"
      ].join("\n");
      maybeOverflow(text, dir, "bash");

      const content = readFileSync(path.join(dir, readdirSync(dir)[0]!), "utf-8");
      expect(content).not.toContain("sk-proj-xyz789abcde");
      expect(content).not.toContain("tok_abcdef123456");
      // 短密钥(6 位 OTP 之类)不许因为"太短"而豁免 —— 值整体不出现于文件
      expect(content).not.toContain("=short");
      expect(content).toContain("OPENAI_API_KEY=sk-p…[redacted");
    });

    it("散文里的 bearer 一词不误伤(值 < 8 字符不打)", () => {
      const text = `${"h".repeat(4500)}\nthe bearer is here\n`;
      maybeOverflow(text, dir, "bash");

      const content = readFileSync(path.join(dir, readdirSync(dir)[0]!), "utf-8");
      expect(content).toContain("the bearer is here");
    });
  });

  describe("③ 内容寻址", () => {
    it("同一内容两次 overflow → 只有一个文件,路径相同", () => {
      const first = maybeOverflow(LONG, dir, "bash", "call-1");
      const second = maybeOverflow(LONG, dir, "bash", "call-2");

      expect(readdirSync(dir)).toHaveLength(1);
      // 返回的路径部分一致(从摘要里抽出落盘路径行)
      const pathOf = (s: string): string => s.split("\n")[1]!;
      expect(pathOf(first)).toBe(pathOf(second));
    });

    it("不同内容 → 两个文件、hash 不同", () => {
      maybeOverflow(LONG, dir, "bash");
      maybeOverflow("y".repeat(5000), dir, "bash");

      const files = readdirSync(dir);
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/^bash-[0-9a-f]{12}\.log$/);
    });

    it("文件名形如 <tool>-<sha1:12>.log,toolName 非法字符被清洗", () => {
      maybeOverflow(LONG, dir, "my tool/v2");

      const files = readdirSync(dir);
      expect(files[0]).toMatch(/^mytoolv2-[0-9a-f]{12}\.log$/);
    });
  });

  describe("④ LRU 清理", () => {
    const seedFiles = (count: number, sizeEach: number): void => {
      for (let i = 0; i < count; i += 1) {
        const file = path.join(dir, `seed-${String(i).padStart(3, "0")}.log`);
        writeFileSync(file, "s".repeat(sizeEach));
        // mtime 递升:seed-000 最旧
        const mtime = new Date(Date.now() - (count - i) * 60_000);
        utimesSync(file, mtime, mtime);
      }
    };

    it("201 个文件时再触发一次 → 清到上限,最旧的消失", async () => {
      seedFiles(201, 100);
      maybeOverflow(LONG, dir, "bash", undefined, { maxFiles: 200, maxTotalBytes: 100 * 1024 * 1024 });

      // setTimeout 防抖 —— 让清理跑一次
      await new Promise((resolve) => setTimeout(resolve, 50));

      const files = readdirSync(dir);
      expect(files.length).toBeLessThanOrEqual(200);
      expect(files).not.toContain("seed-000.log");
      expect(files).toContain("seed-200.log");
    });

    it("总字节超上限 → 按 mtime 删到低于上限", async () => {
      seedFiles(10, 1000);
      maybeOverflow(LONG, dir, "bash", undefined, { maxFiles: 1000, maxTotalBytes: 12_000 });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const files = readdirSync(dir);
      const total = files.reduce((sum, f) => sum + statSync(path.join(dir, f)).size, 0);
      expect(total).toBeLessThanOrEqual(12_000);
      // 最旧的先被清
      expect(files).not.toContain("seed-000.log");
    });

    it("清理期间文件已被外部删除 → 不抛", async () => {
      seedFiles(201, 100);
      rmSync(path.join(dir, "seed-000.log"));
      maybeOverflow(LONG, dir, "bash", undefined, { maxFiles: 200, maxTotalBytes: 100 * 1024 * 1024 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readdirSync(dir).length).toBeLessThanOrEqual(200);
    });
  });

  describe("⑤ 开关", () => {
    it("EVA_TOOL_OVERFLOW=0 → 超长输出原样返回,不落盘", () => {
      process.env.EVA_TOOL_OVERFLOW = "0";

      const out = maybeOverflow(LONG, dir, "bash");
      expect(out).toBe(LONG);
      expect(readdirSync(dir)).toHaveLength(0);
    });
  });

  describe("摘要形态", () => {
    it("带清洗后字节数与行数(帮模型定 offset/limit)", () => {
      const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
      const out = maybeOverflow(text, dir, "bash");

      expect(out).toMatch(/Output too long \(\d+ chars/);
      expect(out).toMatch(/\(\d+ chars, 100 lines\)/);
    });
  });
});
