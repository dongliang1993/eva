# T34 · 自动更新：electron-updater 完整链路（签名 + 公证 + feed）

> 前置阅读：`../r8/00-overview.md` §3 契约 4（mac only）+ §4.3（为何独立成卡）；`02 §4/§8.2-5/§9.6`（feed + 签名/公证硬门槛 + updater 骨架）；`21 §5`（electron-updater 实证 + asarIntegrity 坑）。
> **本卡要 Apple Developer 账号 + 证书**——没有就只能做到「骨架 + 本地跳过」，完整链路跑不通（mac 未签名 `checkForUpdates` 静默失败，02 §9.6 坑 1）。

## 1. 问题

S11 核心演示项「能自己更新」目前零代码。`electron-builder.yml` 只有 mac arm64 dmg，无签名/公证/publish 配置；main.ts 无 updater。

## 2. 改动

### 2.1 electron-updater 集成（main）

新增 `apps/desktop/electron/updater.ts`（对齐 02 §9.6 骨架 + 21 §5.1 实证）：
- `!app.isPackaged` 直接 return（dev 跳过）。
- `autoDownload: true`、`autoInstallOnAppQuit: false`（**别在打字时自动装**，15 §S11-1）；`update-downloaded` 经 IPC 推 renderer，用户确认才 `quitAndInstall`。
- 事件链 `checking-for-update / update-available / update-not-available / download-progress / update-downloaded / error` 全广播给 renderer（preload `electronAPI.onUpdaterStatus(cb)`）。
- **必须挂 `error` 监听**（02 §9.6 坑 2：未捕获异常可能崩主进程；网络抖动记日志别弹窗）。
- 启动后 + 每 4h `checkForUpdates()` 轮询（02 §9.6；Alma 是 30min，Eva 4h 够）。
- whenReady 内在主窗创建后 `initUpdater()`（**必须在 ready 后**，02 §9.2 ⑤）。

### 2.2 更新提示 UI（web）

- 设置页（或侧栏角标）显示「发现新版本 → 下载中 → 重启更新」。
- preload 暴露 `electronAPI.updaterCheck() / updaterInstall() / onUpdaterStatus(cb)`；web 监听 `onUpdaterStatus` 渲染状态条，点「重启更新」调 `updaterInstall()`（→ `quitAndInstall`）。

### 2.3 feed 托管（GitHub Releases）

`electron-builder.yml` 加：
```yaml
publish:
  provider: github
  owner: <you>
  repo: eva
```
- electron-updater 自动读 Releases 里的 `latest-mac.yml`（builder 构建时生成）。
- 开源仓库零成本；私有仓库要 token（02 §9.6 方案 2）。

### 2.4 签名 + 公证（完整链路的硬门槛）

`electron-builder.yml` mac 段补：
```yaml
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true   # 或 afterSign 钩子调 @electron/notarize
```
- 新增 `build/entitlements.mac.plist`（hardened runtime 授权）。
- 证书经 env：`CSC_LINK`（.p12 base64）/ `CSC_KEY_PASSWORD`（签名）。
- **公证用 App Store Connect API Key（用户已备）**，env：
  ```
  APPLE_API_KEY=MS54PPR383
  APPLE_API_ISSUER=f0633a9d-2da9-45e6-a4c0-49afc20f6bce
  APPLE_API_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_MS54PPR383.p8   # 已落位,0600
  APPLE_TEAM_ID=98T664BZ7J   # developer.apple.com 账号页
  ```
  electron-builder ≥24 认 `APPLE_API_KEY/ISSUER/KEY_PATH` 三件套（`.p8` 已在约定路径，私钥内容不进仓/不进聊天）。
  > **打包前置（2026-08 实测）**：`@electron/rebuild` 须 ≥4.x（3.7.2 在 Node 26 下 ESM 报错 `require is not defined`，已升 4.2.0 解掉，`desktop:build` 全绿）；keychain 须有 **Developer ID Application** 证书（`security find-identity -v -p codesigning` 应非空，实测一度为 0 需先从 developer.apple.com 下载导入）。
- **Eva 特有**：`better-sqlite3` 的 `.node` 在 `Resources/server/node_modules`（extraResources）——签名要覆盖 extraResources 里的原生二进制（electron-builder 对 extraResources 签名不一定全覆盖，必要时 `afterSign` 钩子补签，02 §9.7 坑 3）。
- **asarIntegrity 坑（21 §5.2）**：`ElectronAsarIntegrity` 默认开，别 post-build 手改 asar，否则重算 hash 否则拒启动。

## 3. 涉及文件

修改：`apps/desktop/electron/main.ts`（initUpdater 调用）、`apps/desktop/electron/preload.ts`（updater IPC）、`apps/desktop/electron-builder.yml`（publish + mac 签名/公证）、设置页/侧栏（更新 UI）。

新增：`apps/desktop/electron/updater.ts`、`apps/desktop/build/entitlements.mac.plist`。

依赖：devDeps 加 `electron-updater`（注意它不是 electron 自带）；签名阶段要 `@electron/notarize`。

## 4. 步骤

1. devDeps 加 `electron-updater`；写 `updater.ts`（dev 跳过）。
2. preload + web 更新状态 UI。
3. `electron-builder.yml` 加 publish（GitHub feed）。
4. 签名/公证配置 + entitlements（**要 Apple 账号**，没有就到此为止 = 骨架完成）。
5. 打包签名 dmg → 装 → 发一个测试 release → 验 `checkForUpdates` 拉到新版本、`quitAndInstall` 生效。

## 5. 验收

| # | 验收 | 判定 |
|---|---|---|
| 1 | 签名+公证 dmg 装后无 Gatekeeper 拦截 | 手动（新机/干净环境） |
| 2 | 发新版 release 后 `checkForUpdates` 拉到 | 手动 E2E |
| 3 | `update-downloaded` 后用户确认 `quitAndInstall` 生效 | 手动 E2E |
| 4 | dev 态（未打包）updater 静默跳过不报错 | 手动 |
| 5 | 未签名包 `checkForUpdates` 失败时记日志不崩 | 手动 |

## 6. 坑（按概率）

1. **未签名包 checkForUpdates 静默失败**（02 §9.6 坑 1）——完整链路以签名+公证为前提；没 Apple 账号就只能做骨架。
2. **必须挂 error 监听**，否则网络抖动崩主进程。
3. **extraResources 里的 better-sqlite3 .node 要单独签**——builder 对 extraResources 签名不一定覆盖。
4. **autoInstallOnAppQuit 别 true**——用户打字时被强退是事故（15 §S11-1）。
5. **initUpdater 必须在 whenReady 后**——否则 autoUpdater 读 app.getPath 抛错。
6. **别手改 asar**——asarIntegrity 校验，改了拒启动（21 §5.2）。
7. **electron-updater 要 bundle 进 main.js，不能 external**（2026-08 实测）：它是 main 运行时依赖，builder.yml `files` 排了 `node_modules`，external 后 app.asar 里 `Cannot find module 'electron-updater'` 崩主进程。解法：`electron.vite.config.ts` `externalizeDeps: { exclude: ["electron-updater"] }`。
8. **better-sqlite3 的 `test_extension.node` 破坏密封资源**（2026-08 实测）：electron-rebuild 编译带的测试扩展（运行时用不到），签名后成未签 sealed resource → codesign `a sealed resource is missing or invalid`、公证 check-signature 拒。解法：builder.yml extraResources filter 排 `!**/better-sqlite3/**/test_extension.node`。
9. **别并发跑两个 electron-builder**（2026-08 实测）：都往 `release/mac-arm64` 写+签名互踩，报框架符号链接 `No such file or directory` 竞态错；单跑即正常。
