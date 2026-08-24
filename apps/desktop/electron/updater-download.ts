import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";

// ---------------------------------------------------------------------------
// D3 差量预热 / D4 断点续传救援 共用的下载与 staging 工具(23 篇 §4)。
// electron-free:不 import electron,路径/版本/URL 全部由调用方传入,
// 以便 tests/updater-download.test.ts 用本地 http server 直接覆盖续传核心。
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 6;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/** 可重试错误(网络/5xx/超时);4xx(除 416 处理外)与 ChecksumMismatch 不重试。 */
class RetryableError extends Error {}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`sha512 mismatch: expected ${expected}, got ${actual}`);
    this.name = "ChecksumMismatchError";
  }
}

/** 流式算文件的 sha512,输出 base64 —— 与 latest.yml / update-info.json 的格式一致。 */
export async function sha512FileBase64(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield;
    }
  });
  return hash.digest("base64");
}

/** GitHub Releases 资产 URL(23 篇 §7.3:与 electron-builder 默认 tag `v${version}` 约定耦合)。 */
export function githubReleaseAssetUrl(opts: {
  owner: string;
  repo: string;
  tag: string;
  fileName: string;
}): string {
  return `https://github.com/${opts.owner}/${opts.repo}/releases/download/${opts.tag}/${opts.fileName}`;
}

/**
 * 差量下载启发式(D5):本次下载总量 < 全量 90% 即认为是差量。
 * Alma 同款启发式,是 UI 展示用语不是契约,别拿它做逻辑判断。
 */
export function isDifferentialDownload(totalBytes: number, fullSizeBytes: number): boolean {
  return totalBytes > 0 && fullSizeBytes > 0 && totalBytes < 0.9 * fullSizeBytes;
}

export interface ResumeDownloadOptions {
  url: string;
  /** 最终文件路径;下载中写 `<destPath>.part`,校验通过后 rename。 */
  destPath: string;
  /** latest.yml 里该文件的 size(字节)。给了才启用 416=完成 判断与最终尺寸校验。 */
  expectedSize?: number;
  /** latest.yml 里该文件的 sha512(base64)。给了就在 rename 前校验,不符抛 ChecksumMismatchError。 */
  expectedSha512Base64?: string;
  onProgress?: (progress: { transferred: number; total: number | null }) => void;
  signal?: AbortSignal;
  /** 默认 90s 无数据即中断本次 attempt(测试可调小)。 */
  idleTimeoutMs?: number;
  /** 退避基数,实际 delay = min(base * 2^attempt, 30s)(测试可调小)。 */
  retryBaseDelayMs?: number;
  log?: (message: string) => void;
}

interface IncomingWithUrl {
  res: http.IncomingMessage;
  req: http.ClientRequest;
}

function requestFollowingRedirects(
  url: string,
  headers: Record<string, string>,
  redirectsLeft: number,
  signal: AbortSignal | undefined,
  /** 输出参数:请求对象同步回填,供外层在「等响应头」阶段也能 destroy(空闲超时)。 */
  reqRef: { current: http.ClientRequest | null }
): Promise<IncomingWithUrl> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        resolve(requestFollowingRedirects(new URL(location, url).toString(), headers, redirectsLeft - 1, signal, reqRef));
        return;
      }
      resolve({ res, req });
    });
    reqRef.current = req;
    req.on("error", (err) => reject(err instanceof RetryableError ? err : new RetryableError(err.message)));
    signal?.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
  });
}

/** 把 res 写入 part 文件;onData 供调用方重置空闲计时。 */
async function streamToPart(
  res: http.IncomingMessage,
  partPath: string,
  flags: "w" | "a",
  alreadyHave: number,
  opts: ResumeDownloadOptions,
  onData: () => void
): Promise<void> {
  const contentLength = Number(res.headers["content-length"] ?? 0) || null;
  const total = contentLength !== null ? alreadyHave + contentLength : null;
  let received = 0;

  res.on("data", (chunk: Buffer) => {
    received += chunk.length;
    onData();
    opts.onProgress?.({ transferred: alreadyHave + received, total });
  });

  await pipeline(res, fs.createWriteStream(partPath, { flags }));
}

/** 一次下载尝试;成功 resolve,可重试失败抛 RetryableError,致命失败抛原错。 */
async function attemptOnce(url: string, partPath: string, opts: ResumeDownloadOptions): Promise<void> {
  const idleTimeout = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let currentRes: http.IncomingMessage | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  // 空闲计时覆盖整个尝试:从请求发出(含等响应头阶段)到最后一个字节。
  // reqRef 同步回填 —— 挂起场景下响应头可能从未到达,await 之前就要能 destroy。
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const err = new RetryableError(`idle timeout after ${idleTimeout}ms`);
      reqRef.current?.destroy(err);
      currentRes?.destroy(err);
    }, idleTimeout);
  };
  const clearIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const existing = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {};
  const reqRef: { current: http.ClientRequest | null } = { current: null };

  armIdle();
  try {
    const { res } = await requestFollowingRedirects(url, headers, MAX_REDIRECTS, opts.signal, reqRef);
    currentRes = res;
    const status = res.statusCode ?? 0;

    // 416:Range 越界。已有字节 == 期望大小 → 上次其实下完了;否则 part 损坏,删掉下次从头来。
    if (status === 416) {
      res.resume();
      if (opts.expectedSize !== undefined && existing >= opts.expectedSize) {
        return;
      }
      fs.rmSync(partPath, { force: true });
      throw new RetryableError(`416 with local size ${existing}, expected ${opts.expectedSize ?? "unknown"}; restart from scratch`);
    }

    if (status === 200 && existing > 0) {
      // 服务器忽略 Range → 截断重下全量。
      await streamToPart(res, partPath, "w", 0, opts, armIdle);
      return;
    }

    if (status === 206 || status === 200) {
      await streamToPart(res, partPath, existing > 0 ? "a" : "w", existing, opts, armIdle);
      return;
    }

    res.resume();
    if (status >= 500) {
      throw new RetryableError(`HTTP ${status}`);
    }
    throw new Error(`HTTP ${status} (not retryable)`);
  } finally {
    clearIdle();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/**
 * 断点续传下载:`<destPath>.part` 续传 + 指数退避(1s→30s,最多 6 次) +
 * 尺寸/sha512 校验通过后 rename 为 destPath(原子落盘)。
 */
export async function downloadWithResume(opts: ResumeDownloadOptions): Promise<{ filePath: string; sha512: string }> {
  const partPath = `${opts.destPath}.part`;
  fs.mkdirSync(path.dirname(opts.destPath), { recursive: true });

  let completed = false;
  let lastError: unknown = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      await attemptOnce(opts.url, partPath, opts);
      completed = true;
      break;
    } catch (err) {
      lastError = err;
      if (!(err instanceof RetryableError)) throw err;
      const delay = Math.min((opts.retryBaseDelayMs ?? 1000) * 2 ** i, 30_000);
      opts.log?.(`[download] attempt ${i + 1}/${MAX_ATTEMPTS} failed: ${err.message}; retry in ${delay}ms`);
      await sleep(delay, opts.signal);
    }
  }
  if (!completed) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  if (opts.expectedSize !== undefined && fs.statSync(partPath).size !== opts.expectedSize) {
    throw new Error(`size mismatch: expected ${opts.expectedSize}, got ${fs.statSync(partPath).size}`);
  }
  const sha512 = await sha512FileBase64(partPath);
  if (opts.expectedSha512Base64 && sha512 !== opts.expectedSha512Base64) {
    throw new ChecksumMismatchError(opts.expectedSha512Base64, sha512);
  }
  fs.renameSync(partPath, opts.destPath);
  return { filePath: opts.destPath, sha512 };
}

/**
 * 把校验过的更新包 stage 成 electron-updater 的 pending 格式(D4):
 * pending/<fileName> + pending/update-info.json。
 * 下次 downloadUpdate() 时 DownloadedUpdateHelper.getValidCachedUpdateFile 会
 * 比对 update-info.json 的 sha512 与最新 latest.yml,命中即跳过下载直接 update-downloaded。
 * 注意:这是 electron-updater 内部格式(6.8.9 实测),升级大版本必须回归此路径(23 篇 §7.4)。
 */
export function stagePendingUpdate(opts: {
  pendingDir: string;
  fileName: string;
  sha512: string;
  sourceFile: string;
}): void {
  fs.mkdirSync(opts.pendingDir, { recursive: true });
  fs.copyFileSync(opts.sourceFile, path.join(opts.pendingDir, opts.fileName));
  fs.writeFileSync(
    path.join(opts.pendingDir, "update-info.json"),
    JSON.stringify({
      fileName: opts.fileName,
      sha512: opts.sha512,
      isAdminRightsRequired: false
    })
  );
}
