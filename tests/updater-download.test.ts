import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ChecksumMismatchError,
  downloadWithResume,
  githubReleaseAssetUrl,
  isDifferentialDownload,
  sha512FileBase64,
  stagePendingUpdate
} from "../apps/desktop/electron/updater-download.js";

// ---------------------------------------------------------------------------
// 23 篇 D3/D4 的下载核心:Range 续传 / 416 / 忽略 Range 的服务器 / sha512 校验 /
// pending staging 格式。用本地 http server 覆盖,不碰 electron。
// ---------------------------------------------------------------------------

const PAYLOAD = randomBytes(256 * 1024);
const PAYLOAD_SHA512 = createHash("sha512").update(PAYLOAD).digest("base64");

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let currentHandler: Handler;
let seenRanges: (string | undefined)[];

/** 支持 Range 的标准静态文件行为;opts.ignoreRange 模拟不理会 Range 的服务器。 */
function rangeHandler(opts: { ignoreRange?: boolean } = {}): Handler {
  return (req, res) => {
    const range = req.headers.range;
    seenRanges.push(range);
    const m = range && !opts.ignoreRange ? /^bytes=(\d+)-$/.exec(range) : null;
    if (m) {
      const start = Number(m[1]);
      if (start >= PAYLOAD.length) {
        res.writeHead(416, { "Content-Range": `bytes */${PAYLOAD.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Length": PAYLOAD.length - start,
        "Content-Range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`
      });
      res.end(PAYLOAD.subarray(start));
      return;
    }
    res.writeHead(200, { "Content-Length": PAYLOAD.length });
    res.end(PAYLOAD);
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-updater-test-"));
  currentHandler = rangeHandler();
  server = http.createServer((req, res) => currentHandler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshDest(name: string): string {
  seenRanges = [];
  return path.join(tmpDir, name);
}

describe("downloadWithResume", () => {
  it("全量下载:校验 size + sha512 后落盘", async () => {
    currentHandler = rangeHandler();
    const dest = freshDest("full.zip");
    const result = await downloadWithResume({
      url: `${baseUrl}/full.zip`,
      destPath: dest,
      expectedSize: PAYLOAD.length,
      expectedSha512Base64: PAYLOAD_SHA512,
      retryBaseDelayMs: 1
    });
    expect(fs.readFileSync(dest)).toEqual(PAYLOAD);
    expect(result.sha512).toBe(PAYLOAD_SHA512);
    expect(fs.existsSync(`${dest}.part`)).toBe(false); // 已 rename
  });

  it("断点续传:已有 .part 时发 Range 并追加补齐", async () => {
    currentHandler = rangeHandler();
    const dest = freshDest("resume.zip");
    const cutAt = 100_000;
    fs.writeFileSync(`${dest}.part`, PAYLOAD.subarray(0, cutAt));

    await downloadWithResume({
      url: `${baseUrl}/resume.zip`,
      destPath: dest,
      expectedSize: PAYLOAD.length,
      expectedSha512Base64: PAYLOAD_SHA512,
      retryBaseDelayMs: 1
    });

    expect(seenRanges).toContain(`bytes=${cutAt}-`);
    expect(fs.readFileSync(dest)).toEqual(PAYLOAD);
  });

  it("服务器忽略 Range(回 200):截断 .part 重下全量", async () => {
    currentHandler = rangeHandler({ ignoreRange: true });
    const dest = freshDest("no-range.zip");
    fs.writeFileSync(`${dest}.part`, PAYLOAD.subarray(0, 50_000));

    await downloadWithResume({
      url: `${baseUrl}/no-range.zip`,
      destPath: dest,
      expectedSize: PAYLOAD.length,
      expectedSha512Base64: PAYLOAD_SHA512,
      retryBaseDelayMs: 1
    });

    expect(fs.readFileSync(dest)).toEqual(PAYLOAD);
  });

  it("416 且本地大小 == expectedSize:视为已完成", async () => {
    currentHandler = rangeHandler();
    const dest = freshDest("done.zip");
    fs.writeFileSync(`${dest}.part`, PAYLOAD); // 上次其实已经下完

    await downloadWithResume({
      url: `${baseUrl}/done.zip`,
      destPath: dest,
      expectedSize: PAYLOAD.length,
      expectedSha512Base64: PAYLOAD_SHA512,
      retryBaseDelayMs: 1
    });

    expect(fs.readFileSync(dest)).toEqual(PAYLOAD);
  });

  it("sha512 不符:抛 ChecksumMismatchError 且不 rename", async () => {
    currentHandler = rangeHandler();
    const dest = freshDest("bad-sha.zip");
    await expect(
      downloadWithResume({
        url: `${baseUrl}/bad-sha.zip`,
        destPath: dest,
        expectedSha512Base64: createHash("sha512").update("not-it").digest("base64"),
        retryBaseDelayMs: 1
      })
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("5xx 可重试:前两次 500,第三次成功", async () => {
    let hits = 0;
    currentHandler = (req, res) => {
      hits++;
      if (hits <= 2) {
        res.writeHead(500).end();
        return;
      }
      rangeHandler()(req, res);
    };
    const dest = freshDest("flaky.zip");
    await downloadWithResume({
      url: `${baseUrl}/flaky.zip`,
      destPath: dest,
      expectedSha512Base64: PAYLOAD_SHA512,
      retryBaseDelayMs: 1
    });
    expect(hits).toBe(3);
    expect(fs.readFileSync(dest)).toEqual(PAYLOAD);
  });

  it("跟随 302 重定向", async () => {
    currentHandler = (req, res) => {
      if (req.url === "/redirect.zip") {
        res.writeHead(302, { Location: "/real.zip" }).end();
        return;
      }
      rangeHandler()(req, res);
    };
    const dest = freshDest("redirect.zip");
    await downloadWithResume({
      url: `${baseUrl}/redirect.zip`,
      destPath: dest,
      expectedSha512Base64: PAYLOAD_SHA512,
      retryBaseDelayMs: 1
    });
    expect(fs.readFileSync(dest)).toEqual(PAYLOAD);
  });

  it("空闲超时:服务器挂起不发货 → 重试耗尽后失败", async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { "Content-Length": PAYLOAD.length });
      // 不发数据也不结束 → 触发 idle timeout
    };
    const dest = freshDest("stalled.zip");
    await expect(
      downloadWithResume({
        url: `${baseUrl}/stalled.zip`,
        destPath: dest,
        idleTimeoutMs: 30,
        retryBaseDelayMs: 1
      })
    ).rejects.toThrow();
  }, 15_000);

  it("进度回调带 transferred/total", async () => {
    currentHandler = rangeHandler();
    const dest = freshDest("progress.zip");
    const ticks: { transferred: number; total: number | null }[] = [];
    await downloadWithResume({
      url: `${baseUrl}/progress.zip`,
      destPath: dest,
      onProgress: (p) => ticks.push(p),
      retryBaseDelayMs: 1
    });
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.at(-1)).toEqual({ transferred: PAYLOAD.length, total: PAYLOAD.length });
  });
});

describe("stagePendingUpdate", () => {
  it("写出 electron-updater pending 格式:文件 + update-info.json", () => {
    const pendingDir = path.join(tmpDir, "pending");
    const source = path.join(tmpDir, "source.zip");
    fs.writeFileSync(source, PAYLOAD);

    stagePendingUpdate({
      pendingDir,
      fileName: "Eva-0.2.6-arm64.zip",
      sha512: PAYLOAD_SHA512,
      sourceFile: source
    });

    expect(fs.readFileSync(path.join(pendingDir, "Eva-0.2.6-arm64.zip"))).toEqual(PAYLOAD);
    // 与 DownloadedUpdateHelper.setDownloadedFile 写出的格式逐字段一致(6.8.9 源码实测)。
    expect(JSON.parse(fs.readFileSync(path.join(pendingDir, "update-info.json"), "utf-8"))).toEqual({
      fileName: "Eva-0.2.6-arm64.zip",
      sha512: PAYLOAD_SHA512,
      isAdminRightsRequired: false
    });
  });
});

describe("工具函数", () => {
  it("sha512FileBase64 与一次性 digest 一致(base64 格式对齐 latest.yml)", async () => {
    const f = path.join(tmpDir, "sha.bin");
    fs.writeFileSync(f, PAYLOAD);
    expect(await sha512FileBase64(f)).toBe(PAYLOAD_SHA512);
  });

  it("githubReleaseAssetUrl 拼 releases/download 资产地址", () => {
    expect(
      githubReleaseAssetUrl({ owner: "o", repo: "r", tag: "v0.2.6", fileName: "Eva-0.2.6-arm64.zip" })
    ).toBe("https://github.com/o/r/releases/download/v0.2.6/Eva-0.2.6-arm64.zip");
  });

  it("isDifferentialDownload:total < 全量 90% 才算差量", () => {
    expect(isDifferentialDownload(100, 1000)).toBe(true);
    expect(isDifferentialDownload(899, 1000)).toBe(true);
    expect(isDifferentialDownload(900, 1000)).toBe(false);
    expect(isDifferentialDownload(0, 1000)).toBe(false);
    expect(isDifferentialDownload(100, 0)).toBe(false);
  });
});
