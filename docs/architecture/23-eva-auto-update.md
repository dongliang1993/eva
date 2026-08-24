# Eva 技术方案 23：桌面端自动更新（Alma 方案落地版）

> 调研基础：
> - **Alma 实证（2026-08-24）**：解包 `/Applications/Alma.app` v0.0.986 主进程 bundle + 实读 feed `https://updates.alma.now/latest-mac.yml` + 本机更新缓存（`~/Library/Caches/alma-updater/`、ShipIt 日志）。本篇中 Alma 相关结论均为此轮实证，替代 02 §4 / 21 §5.1 的推测性描述。
> - **Cindy 对照（同日）**：`.refrences/cindy/` 全自研更新链调查（manifest 驱动 + hotfix zip + 外部替换进程），作为选型反方。
> - **Eva 现状**：`apps/desktop/electron/updater.ts`（T34）、`electron-builder.yml`、`main.ts`、`security-settings.tsx`。
>
> 证据标注：`E:` = 有直接证据（代码/文件/缓存实测）；`[推测]` = 间接推断。

---

## 1. 结论先行

Eva 走 **Alma 路线：electron-updater 标准链 + 三层自研加固**，不碰 Cindy 式全自研 manifest 链。

| 维度 | Cindy（自研） | Alma（electron-updater） | Eva 选择 |
|---|---|---|---|
| feed | 自研 manifest-*.json，运行时端点清单决定 CDN 基址 | electron-builder 生成的 `latest-mac.yml`，静态托管（generic） | latest-mac.yml（现状 GitHub Releases，可迁 generic） |
| 更新粒度 | 应用 + agent 二进制共用 manifest，可组件级 | 整包替换（ShipIt swap） | 整包替换 |
| mac 差量 | 无（全量 hotfix zip） | 有，靠"预热当前版 zip"激活 | **抄** |
| 下载加固 | 完整 downloader（续传/校验/重试） | electron-updater 下载 + 失败时自研 Range 救援层 | **抄** |
| 安装 | 外部进程替换 + Windows 备份回滚 | Squirrel ShipIt 原子换包 | ShipIt（electron-updater 自带） |
| 渠道 | canary（用户级）/beta/release | 无（仅稳定版，禁降级） | 仅稳定版；内测期 allowPrerelease |
| 工程量 | updateService 2000 行 + Rust 子项目 | 主进程一个模块 + 救援层 | 已有 T34 基础，增量改造 |

**为什么不自研**（Cindy 调查结论）：Cindy 自研的动机是动态端点、用户级渠道、manifest 兼管 agent 二进制、per-machine 安装提权——Eva 一个都不需要。Alma 证明 electron-updater 的 mac 短板（全量下载）可以用"差量预热"对冲，不需要为此造 manifest。

**Alma 三层加固**，也是本篇的施工主体：

1. **差量预热**：启动 60s 后把**当前版本**的 zip 闲时下载进 updater 缓存，使下一次更新命中 electron-updater 的 blockmap 差量下载（E: Alma 主 bundle 日志 "next update will be differential"；feed 上 `*.zip.blockmap` 存在且支持 Range）。
2. **断点续传救援层**：`downloadUpdate()` 失败时自研 Range 下载器接管（`.part` 续传、416 视为完成、sha512 校验后 stage 进 `pending/`）（E: 主 bundle 代码段）。
3. **手动触发 UX**：`autoDownload=false`，轮询只检查；侧栏 badge → 对话框 → 用户点"立即下载"→"立即重启"（E: `autoDownload=false` 配置 + UpdaterDialog 组件）。

---

## 2. Alma 更新机制实证（v0.0.986，2026-08-24）

### 2.1 feed 与配置

`Contents/Resources/app-update.yml` 原文（E: 直接读取）：

```yaml
provider: generic
url: https://updates.alma.now/
useMultipleRangeRequest: false
updaterCacheDirName: alma-updater
```

feed 是 Cloudflare 前的纯静态托管，`latest-mac.yml` 是 electron-builder 标准产物（E: curl 实读）：`version` + `files[]`（zip/dmg 各带 sha512/size）+ `releaseDate` + Markdown `releaseNotes`。arm64 zip 464MB。同目录有 `*.zip.blockmap`（448KB，支持 Range 请求）——**差量的全部前提就是 zip + blockmap 都在 feed 上**。

`useMultipleRangeRequest: false`：差量下载器不用多并发 Range，退化为单路顺序请求——对静态 CDN 兼容性更稳的保守设置（electron-builder publish 配置项，会写进 app-update.yml）。

### 2.2 主进程行为

E: 主 bundle 代码切片——

- 懒加载 `electron-updater`；仅打包态且 `app-update.yml` 存在才启用。
- `autoDownload = false`（下载必须用户触发）、`autoInstallOnAppQuit = true`；**不设** channel/allowPrerelease/allowDowngrade → 仅稳定版、禁降级。
- 节奏：初始化后 **3s** 首次 `checkForUpdates()`，之后 **30min** 轮询。
- 状态机 `checking / update-available / update-not-available / downloading / update-downloaded / error / idle / unsupported`，`webContents.send("auto-update-status")` 广播所有窗口；payload 带 `version/percent/transferred/total/bytesPerSecond/incremental/triggeredByUser`。
- 安装：`quitAndInstall(false, true)`（不静默、装完强制重启）。
- 代理：把 app 代理设置应用到 updater 的 netSession，`login` 事件回填代理账号密码。

### 2.3 差量预热（核心机制）

electron-updater 在 mac 上做差量有个隐藏前提：**缓存里要有当前版本的旧 zip**，才能拿新版 blockmap 做 Range 差分。正常流程缓存里没有，所以裸用 electron-updater 的 mac 每次全量。

Alma 的解法（E: 主 bundle）：启动 60s 后（仅 darwin 打包态），若 `~/Library/Caches/alma-updater/update.zip` 不存在，主动把**当前已安装版本**的 zip 从 feed 下载进缓存，日志原话 "next update will be differential"。下载进度回调里有启发式：`total < 0.9 × 全量大小` 时判定差量（`incremental=true`），UI 显示 "incremental" 徽章。

本机缓存实证（E: `~/Library/Caches/alma-updater/`）：

```
update.zip                              462,613,046 B   ← 下载缓存
pending/alma-0.0.986-mac-arm64.zip      462,613,046 B   ← staging 副本
pending/update-info.json                172 B           ← {fileName, sha512, isAdminRightsRequired}
```

0.0.986 那次是 462MB 全量下载；这两份缓存现在正好充当 0.2.0 更新的差量基础——预热机制要的就是这个状态。

### 2.4 断点续传救援层

electron-updater 自带下载器续传能力弱。Alma 在 `downloadUpdate()` 失败时（仅 darwin 打包态）自研接管（E: 主 bundle 代码段）：

- 自己解析 `app-update.yml` 的 `url`，按 arch 选 zip；
- Range 下载到 `Caches/alma-updater/resume-staging/`：`.part` 文件续传、重定向跟随 ≤5、416 视为已完成、90s 空闲超时、指数退避 `min(2^n s, 30s)`、停滞重试 6 次、500ms 节流进度；
- sha512 校验后 stage 进 `pending/` + 写 `update-info.json`（与 electron-updater staging 格式一致），再回调 `downloadUpdate()`——命中缓存直接跳过下载；
- sha512 mismatch：删 `pending/`，重新 `checkForUpdates()` + `downloadUpdate()` 重试一次。

### 2.5 sidecar 与数据分离

E: 代码与目录实测——`bun`（60MB）/`uv`/`lark-cli`/`cli`/`bundled-skills`/两个嵌套 .app **全部随整包更新**，代码里无任何按组件下载逻辑（`installBun` 直接返回 "Bun is bundled with the application"）。独立运行时下载的只有**用户态数据**：Playwright Chromium（`~/Library/Caches/ms-playwright/`）、whisper/embedding/TTS 模型（`~/Library/Application Support/alma/`）、marketplace 插件（独立 registry.json，逐插件比版本，20s 首查 + 30min 轮询）。

### 2.6 安装（ShipIt）

Frameworks 含 Squirrel/Mantle/ReactiveObjC（E: 目录实测）。`~/Library/Caches/com.yetone.alma.ShipIt/ShipIt_stderr.log` 记录了完整安装过程：旧 bundle 移到临时目录 → 新 bundle 移入 `/Applications/Alma.app/` → `Installation completed successfully` → relaunch。原子换包由 ShipIt 保证，无需 Cindy 式 `.updating` 锁与备份回滚。

---

## 3. Eva 现状盘点（T34 遗产）

E: 代码实读——

| 项 | 现状 | 位置 |
|---|---|---|
| 库 | `electron-updater ^6.8.9` 已装 | `apps/desktop/package.json` |
| provider | **GitHub**（owner/repo 写死），`allowPrerelease: true`（内测期） | `electron-builder.yml:9-12`、`updater.ts:40` |
| 下载策略 | `autoDownload = true`（静默下载） | `updater.ts:35` |
| 安装策略 | `autoInstallOnAppQuit = false`，用户点"重启更新"→ `quitAndInstall()` | `updater.ts:37,124` |
| 节奏 | 启动即查 + **4h** 轮询 | `updater.ts:73-80` |
| 状态推送 | `updater-status` 广播 + main 侧缓存最近态（补时序） | `updater.ts:12-26` |
| pending 恢复 | 启动时检查 `~/Library/Caches/@evadesktop-updater/pending/`，恢复 `downloaded` 状态 | `updater.ts:88-121` |
| IPC / preload | `updater:check / updater:install / updater:status` + `onUpdaterStatus` | `main.ts:516-518`、`preload.ts:28-41` |
| 设置页 UI | 状态条 +「重启更新」/「检查更新」按钮 | `security-settings.tsx:32-126` |
| 打包 | dmg + **zip** target、签名 + hardened runtime + notarize、blockmap 已产出 | `electron-builder.yml:44-61`、`release/Eva-0.1.0-arm64.dmg.blockmap`（E: 存在） |
| 安装前清场 | `before-quit` → `killServer()`（SIGTERM + 3s 后 SIGKILL） | `main.ts:282-308,735-738` |

**与 Alma 的差距**：① 自动下载（Alma 手动）；② 4h 轮询（Alma 30min）；③ 无差量预热；④ 无断点续传救援；⑤ 无 incremental 标识；⑥ 发布流程未固化（blockmap 是否随 release 上传未验证——差量的前提）。

---

## 4. 目标设计

### D1 下载改手动触发

- `autoDownload = false`；`update-available` 后只在 UI 露出入口（设置页状态条 + 可选侧栏 badge），用户点「立即下载」才 `downloadUpdate()`。
- IPC 增量：`updater:download`（preload 加 `updaterDownload()`）。
- 理由：Eva 是 agent 应用，后台静默下载数百 MB 不该发生在用户无感知时；且手动触发让 `triggeredByUser` 语义清晰，失败重试路径简单。
- 落点：`updater.ts:35`、`preload.ts`、`main.ts` IPC 段、`security-settings.tsx`。

### D2 检查节奏对齐

- 启动后 **3s** 首查（避开启动关键路径即可，不必同步阻塞），之后 **30min** 轮询。
- 落点：`updater.ts:72-80`（`setTimeout` 3s 首查 + `setInterval` 30min，保持 `.unref()`）。

### D3 差量预热（darwin 打包态）

- 时机：启动 **60s** 后，闲时执行一次。
- 条件：`~/Library/Caches/@evadesktop-updater/update.zip` 不存在（缓存目录名由 package.json name 派生，T34 注释已写死对齐规则——**改 name 时三处同步**：此目录、`restorePendingDownload`、救援层 staging）。
- 动作：下载**当前 `app.getVersion()`** 对应的 zip 进该缓存。
- URL 推导：GitHub provider 下 asset URL 约定为 `https://github.com/<owner>/<repo>/releases/download/v<version>/Eva-<version>-arm64.zip`（electron-builder 默认 tag 格式 `v${version}`、`artifactName` 见 yml:47）。**这是约定耦合，实现时必须先对真实 release 验证**；若后续迁 generic 静态托管（R2/OSS），URL = `{feed}/Eva-<version>-arm64.zip`，此事变 trivial。
- 失败处理：任意失败静默放弃（预热是优化不是功能），下个版本发布后再试。
- 流量自觉：每个版本安装后预热一次 = 每版本一次安装包大小的闲时下载。Eva 当前包体远小于 Alma（464MB），成本可接受；实现时加 `net.online` 与 metered 连接的保守判断 [推测：macOS 无可靠 metered API，可先只做 online 判断]。

### D4 断点续传救援层（darwin 打包态）

- 触发：`downloadUpdate()` reject 时接管一次。
- 行为对齐 Alma §2.4：Range + `.part` 续传 + 416 视为完成 + 90s 空闲超时 + 指数退避（1s→30s，最多 6 次）+ sha512 校验 → stage 进 `pending/` + 写 `update-info.json`（格式与 electron-updater 一致：`{fileName, sha512, isAdminRightsRequired: false}`）→ 再调一次 `downloadUpdate()` 让它命中缓存。
- sha512 mismatch：删 `pending/`，完整重试一次，再失败则报 `error` 状态交给 UI 重试按钮。
- **格式耦合风险**：`pending/` + `update-info.json` 是 electron-updater 内部格式，升级 electron-updater 大版本时必须回归验证此路径（写入版本注释 + 升级 checklist）。
- 新文件：`apps/desktop/electron/updater-rescue.ts`（独立模块，`updater.ts` 只在失败回调里调它）。

### D5 增量标识

- `download-progress` 里加启发式：`total < 0.9 × latest.yml 记录的 zip size` 时 payload 带 `incremental: true`，设置页显示「增量更新」徽标。
- 是启发式不是契约，UI 文案别过度承诺（Alma 同款处理）。

### D6 发布流程固化

- `pnpm desktop:pack` 已产出 dmg + zip + 两者 blockmap + `latest-mac.yml`（E: release/ 目录实测有 dmg.blockmap；zip.blockmap 同理生成）。
- 发版 checklist（写进 `docs/plans/` 对应 r 阶段或 release runbook）：
  1. 版本号：`apps/desktop/package.json` `version` 是 `app.getVersion()` 来源，发版前 bump（Eva 现状 0.2.5 直接写在 package.json，内测期够用；CI 化后再考虑 Cindy 式占位 + 注入）。
  2. `GH_TOKEN` 就位后 `electron-builder --publish always`，或手动 `gh release upload`——**必须包含 zip、zip.blockmap、dmg、latest-mac.yml 四类文件**（漏 blockmap = 差量静默失效，无报错，这是最容易踩的坑）。
  3. 内测期：`gh release create --prerelease`（与 `allowPrerelease: true` 配套）；转正式：发正式 release 并把 `updater.ts:40` 改回 `false`。
- provider 演进：开源/对外分发后若 GitHub Releases 不合适（私有 repo 要 token、release 页面对用户可见），迁 generic + 静态托管（Alma 方案），改动只有 `electron-builder.yml` 的 publish 段 + D3 的 URL 推导简化。

### D7 安装前清场（验证项，非新代码）

- `quitAndInstall()` 会走正常退出链 → `before-quit` → `killServer()`（`main.ts:735`）已在。ShipIt 等旧进程退出后才换包。
- 对照 Cindy 教训（驻留进程锁安装目录导致替换失败）：Eva 的驻留进程 = server UtilityProcess + server 拉起的 MCP 子进程。**验收时必须实测**：更新安装期间 MCP 子进程（server 的子进程的子进程）是否随之退出；若不退出，`killServer` 需要补进程组 kill（`detached: false` 下 utilityProcess 默认同进程组，理论上会收到信号——实测为准）。
- macOS App Translocation 防护（Cindy 有）：Eva 走 dmg 分发，用户不拖进 /Applications 直接跑会被 translocation 困住。electron-updater 对此场景会更新失败。**第一版不处理**，在 FAQ/文档写明"请拖入 Applications"；后续有需要再抄 Cindy 的 `isInApplications` 检查。

### D8 sidecar / 数据分离原则（写入架构约定）

- **代码类随包**：`server/dist`、`server/node_modules`、`web/dist` 维持现状（extraResources 整包替换），不做组件级更新—— Alma 120MB sidecar 都这么干，Eva 的体量没理由更复杂。
- **数据类运行时下载**：未来引入的重物（模型权重、浏览器二进制等）一律不进安装包，落到 `~/.eva/` 下按需下载 + 自检。这条写进 AGENTS.md 的打包链路段，防止包体积走 Alma 的老路（asar 669MB）。

---

## 5. 状态机与 IPC 面（目标态）

```
idle → checking → not-available ──────────────┐
                → available ──(用户点下载)──→ downloading ─→ downloaded ─(用户点重启)─→ quitAndInstall
                     ↑                            │                  ↑
                     └────────── error ←──────────┴──(rescue 失败)───┘
```

- `downloaded` 持久化：沿用 T34 的 `pending/` 恢复（`updater.ts:88`），rescue 层 stage 的包同样被它恢复——两个机制天然衔接。
- preload 增量：`updaterDownload()`；status payload 增量：`incremental?: boolean`、`transferred/total/bytesPerSecond`（设置页进度条用）。
- 广播照旧 `updater-status`；dev/未打包态返回 `unsupported` 状态给设置页展示（Alma 同款提示）。

---

## 6. 不做清单

| 不做 | 理由 |
|---|---|
| 组件级 manifest（server 独立热更） | 整包替换已覆盖；有真实需求再议（Cindy 的教训是这一步一旦迈出去就是全自研） |
| 用户级 canary 渠道 | 内测期 GitHub prerelease 足够 |
| 动态端点清单（endpoint.json） | 单区域静态 feed，无多区域需求 |
| Windows/Linux 更新 | 当前只发 mac arm64；Windows 启用时 NSIS 差量 electron-updater 自带，本篇机制大多可直接平移（救援层、`isInApplications` 检查是 darwin 专属） |
| 自动重启安装 | agent 可能在飞（Cindy busy-probe 的动机）；手动重启一条路 |
| 备份回滚 / applyAttempts 计数 | ShipIt 原子换包已覆盖替换失败场景；新包启动崩溃无自动回滚是已知可接受缺口（Alma 同） |
| `.updating` 锁 + 启动忙等 | Cindy 外部脚本替换的防护，ShipIt 体系不需要 |

---

## 7. 风险与坑

1. **未签名包 checkForUpdates 静默失败**（02 §9.6 坑 1，T34 已踩）：签名 + 公证是更新链前提，`electron-builder.yml` 已配好；改签名配置后必须回归更新链。
2. **漏传 blockmap = 差量静默失效**：无任何报错，只是每次全量。发布 checklist 头号检查项（D6.2）。
3. **GitHub tag/asset 命名约定耦合**：D3 预热的 URL 推导依赖 `v${version}` tag 与 `artifactName`，改任一配置预热即 404（静默放弃，不致命但要知晓）。
4. **rescue 层与 electron-updater staging 格式耦合**（D4）：electron-updater 升级要回归验证。
5. **预热流量**：每版本一次安装包大小的后台下载（D3），实现时做 online 判断 + 失败静默。
6. **缓存目录名三处同步**：`@evadesktop-updater` 由 package.json name 派生，T34 注释已警告；D3/D4 落地时把目录解析收敛成一个共享函数，消灭字面量散布。
7. **新旧包 TeamID 必须一致**：ShipIt 换包前提，换证书/团队账号时更新链必断（Alma 同，electron-updater 通则）。

---

## 8. 施工拆分与验收

> **落地状态（2026-08-24）**：#1/#2/#5/#7 代码已完成（`updater.ts` D1/D2/D5、`updater-download.ts` 救援层+预热、`security-settings.tsx` 设置页、`tests/updater-download.test.ts` 13 例全绿、typecheck 全绿）；D7 已强化为 `updater:install` 前显式 `killServer()`。#3/#4/#6 需要真实 release 环境验收（见下），#5 的端到端验证（真失败注入）随 #4 一起做。
>
> 实现中两处与设计的偏差记录：① 救援/预热共用 electron-free 模块 `updater-download.ts`（而非独立 `updater-rescue.ts`），便于单测；② 空闲超时覆盖**含等响应头**的整个尝试——首版只覆盖传输阶段，被 stalled-server 测试抓出挂起 bug 后修正（destroy 要打 req 上，挂起时手里没有 res）。

顺序按依赖与价值排（编号排期时再定）：

| # | 内容 | 依赖 | 验收 |
|---|---|---|---|
| 1 | D1 手动下载 + D5 incremental 标识 + preload/IPC 增量 | 无 | 设置页手动触发下载全流程；进度条显示增量徽标 |
| 2 | D2 节奏（3s/30min） | 无 | 日志观测首查/轮询时间点 |
| 3 | D6 发布 checklist + blockmap 验证 | 无 | 发一个 prerelease，确认四类文件齐、旧版能检查到 |
| 4 | D3 差量预热 | 3（feed 上有完整产物） | 连续发两个 prerelease：第二版下载体积显著小于全量（日志 `Differential download detected`） |
| 5 | D4 救援层 | 1 | 断网/弱网注入下 `downloadUpdate` 失败后 rescue 接管并续传成功；sha512 mismatch 路径删 pending 重试 |
| 6 | D7 清场实测 | 3 | 更新安装期间 server + MCP 子进程全退出（`ps` 验证），装完正常 relaunch |
| 7 | D8 写入 AGENTS.md 打包链路段 | 无 | 文档落字 |

每一步都在 mac arm64 签名 + 公证包上验收——未签名包测更新链是假阳性（§7.1）。
