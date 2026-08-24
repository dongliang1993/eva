#!/usr/bin/env node
/**
 * 发布产物四类校验(23 篇 D6):pack 之后、upload 之前跑。
 *
 * electron-updater 的 mac 更新链需要四类文件全部随 release 上传:
 *   - Eva-<ver>-arm64.zip            ← 自更新包(quitAndInstall 用)
 *   - Eva-<ver>-arm64.zip.blockmap   ← 差量下载的前提;漏传 = 差量静默失效,无任何报错
 *   - Eva-<ver>-arm64.dmg (+.blockmap) ← 新用户安装器
 *   - latest-mac.yml                 ← feed 清单(version/sha512/size)
 *
 * 用法: node scripts/check-release-artifacts.mjs [releaseDir]
 * 退出码: 0 齐全;1 缺文件。
 */
import fs from "node:fs";
import path from "node:path";

const releaseDir = path.resolve(process.argv[2] ?? new URL("../release", import.meta.url).pathname);

if (!fs.existsSync(releaseDir)) {
  console.error(`✗ release 目录不存在: ${releaseDir}（先跑 pnpm desktop:pack）`);
  process.exit(1);
}

const files = fs.readdirSync(releaseDir);

// 取目录里最新语义的版本号(按版本排序,不按 mtime —— 同目录可能残留旧版本)。
const versions = [
  ...new Set(
    files
      .map((f) => f.match(/^Eva-(\d+\.\d+\.\d+)-arm64\.zip$/)?.[1])
      .filter(Boolean)
  )
].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (versions.length === 0) {
  console.error(`✗ ${releaseDir} 里没有 Eva-<ver>-arm64.zip（先跑 pnpm desktop:pack）`);
  process.exit(1);
}

const version = versions.at(-1);
if (versions.length > 1) {
  console.log(`ℹ 发现多个版本 (${versions.join(", ")}),校验最新: ${version}`);
}

const required = [
  `Eva-${version}-arm64.zip`,
  `Eva-${version}-arm64.zip.blockmap`,
  `Eva-${version}-arm64.dmg`,
  `Eva-${version}-arm64.dmg.blockmap`,
  "latest-mac.yml"
];

let missing = 0;
for (const name of required) {
  const p = path.join(releaseDir, name);
  if (fs.existsSync(p)) {
    console.log(`✓ ${name} (${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.error(`✗ 缺失: ${name}`);
    missing++;
  }
}

// latest-mac.yml 内容 sanity:version 字段要与 zip 版本一致,且 files 里得有 zip。
if (missing === 0) {
  const yml = fs.readFileSync(path.join(releaseDir, "latest-mac.yml"), "utf-8");
  if (!yml.includes(`version: ${version}`)) {
    console.error(`✗ latest-mac.yml 的 version 与 zip 版本 (${version}) 不一致`);
    missing++;
  }
  if (!yml.includes(`Eva-${version}-arm64.zip`)) {
    console.error(`✗ latest-mac.yml 的 files 里没有 Eva-${version}-arm64.zip`);
    missing++;
  }
}

if (missing > 0) {
  console.error(`\n缺 ${missing} 项。blockmap 缺失不会报错,只会让差量静默失效 —— 上传 release 时四类必须齐。`);
  process.exit(1);
}
console.log(`\n发布产物齐全,可以上传 release ${version}（四类文件 + 对应的 dmg）。`);
