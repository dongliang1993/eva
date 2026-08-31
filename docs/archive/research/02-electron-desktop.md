# Alma 架构调研 02：Electron 主进程与桌面端架构

> 调研对象：`/Applications/Alma.app`（版本 0.0.960，arm64，TeamID `LY7MVTUDZG`，bundle id `com.yetone.alma`）
> 调研方法：静态分析 `app.asar`（660MB）内 `/out/main/index.js`、`/out/preload/index.js`、`/out/renderer/*.html`，以及 `Contents/Resources/` 下的 sidecar 二进制、`Info.plist`、`app-update.yml`、`codesign` 信息。
> 证据标注：`E:` = 有直接证据；`[推测]` = 依据间接证据推断。

> **v0.0.990 修订（2026-08-21）**：本篇骨架结论（进程拓扑、单实例锁、contextBridge 窄桥 + loopback HTTP 业务面、electron-updater）在 v0.0.990 仍成立，但以下条目已过期或需补充，详见 **21 篇**：
>
> - **窗口家族扩张**：本篇 §2 的入口清单之外，v0.0.990 的 renderer 实有 8 个 HTML（`index/settings/gallery/lightbox/livecoding/prompt-app-runner/share/notifications`，`/tmp/alma-extract/asar/out/renderer/`）。其中 **livecoding.html**（900×700 单例窗，`main.readable.js:106238`）与 **prompt-app-runner.html**（按 `prompt_apps.windowWidth/Height` 建窗，每次快捷键触发新建实例，`main.readable.js:104881/106170`）是正式入口；另有 `index.html#/minesweeper`（扫雷彩蛋 4 窗）与 `#/more-menu` 弹出面板。`loading` 目录仍在 asar 内但无 loadFile 调用点，疑似废弃。
> - **preload API 面扩大**：`contextBridge.exposeInMainWorld` 实测 **43 处调用 / 44 个 namespace**（`asar/out/preload/index.js`，清单含 `almaIab/almaBrowserProfile/promptAppRunner/moreMenu/minesweeperWindow/galleryWindow/lightboxWindow/liveCodingWindow/plugin*(9 个)/toolApprovalDialog/userQuestionDialog/almaNotifications/snapshot/whisper/copilot/claudeSubscription/mcpOAuth` 等）——本篇 §3「约 10 个 namespace、惯用名 window.alma」的估计**已过时**；且无统一 `window.alma` 总对象。完整清单见 21 篇 §3。
> - **sidecar 阵容扩大**：Resources 下实有 `bun/ uv/ lark-cli/ tts/(python 脚本 + sherpa worker) Alma Computer Use.app/ CalTool.app/ chrome-extension/ cli/`。whisper 不再是独立 sidecar，改为 `@fugood/whisper.node` N-API 模块直接加载（`main.readable.js:54224`）；`Alma Computer Use.app` 是 unix-socket daemon（`--idle-seconds 900` 自退，`main.readable.js:66202`）；lark-cli 缺失时从 npmmirror 下载（`main.readable.js:59839`）。各 sidecar 拉起/守护机制见 19 篇。
> - **打包链新增原生模块**：`alma-notifications`（`asar/package.json:84`，`file:electron/native/alma-notifications`，通知走原生 NSPanel addon，`ALMA_NATIVE_NOTIFICATIONS=0` 可关）与 `electron-liquid-glass@^1.1.1`（窗口圆角毛玻璃）。
> - **其他修订**：主窗红绿灯移到 (-100,-100) 隐藏（自绘标题栏）；`webviewTag:!0` 是 iab 的硬依赖；§3.3 推测的 loopback 鉴权 token 在 v0.0.990 仍不存在（HTTP 面纯 127.0.0.1 绑定）；quick-chat 快捷键固定 `Cmd/Ctrl+Shift+Space`（`main.readable.js:106107` 附近）。

---

## 1. 进程模型总览

### 1.1 进程拓扑

Alma 是 **Electron 主进程 + 本地 HTTP 服务（127.0.0.1:23001）+ 多个原生 sidecar 子进程** 的混合架构。Electron 壳负责窗口/托盘/快捷键/通知/更新等桌面集成；真正的 Agent 运行时跑在 HTTP 服务后面，重型工作交给 sidecar（尤其 bun）。

```
+------------------------------------------------------------------+
| Electron Main Process (Node.js, asar:/out/main/index.js)         |
|  - 单实例锁 requestSingleInstanceLock()            [推测]        |
|  - 窗口工厂：9 个 renderer 入口（见 §2）          E: HTML 列表    |
|  - 托盘 Tray / 全局快捷键 / 深链 alma:// / 通知                  |
|  - autoUpdater (electron-updater, generic)       E: app-update.yml|
|  - 本地 HTTP 服务 127.0.0.1:23001 的宿主/代理     E: 见 §3.2     |
|  - jpegEncoder.worker.js（截屏 JPEG 压缩 Worker） E: asar 列表    |
|  - 拉起/守护 sidecar 子进程 ----------+                          |
+----------|---------------------------|---------------------------+
           | contextBridge (IPC)       | spawn/execFile
           v                           v
+----------------------+      +-------------------------------------+
| Renderer 进程群       |      | Sidecar 子进程群 (Resources/ 下)     |
| contextIsolation +    |      |  * bun/bun (60MB 单文件 + .version) |
| sandbox, 无 nodeInteg |      |    Agent runtime / 工具执行 /       |
| index 主窗            |      |    技能与 MCP 宿主      E: 二进制   |
| settings / gallery /  |      |  * uv/uv -- Python 环境/包管理      |
| lightbox / notificat. |      |                         E: uv 目录 |
| livecoding / prompt-  |      |  * lark-cli/lark-cli (24MB)         |
| app-runner / share /  |      |    飞书集成 CLI         E: 二进制   |
| loading               |      |  * CalTool.app (304K) -- EventKit   |
| (E: asar 内 8 个 HTML |      |    日历/提醒事项桥        [推测]   |
|  入口 + loading)      |      |  * Alma Computer Use.app (2.2M) --  |
+----------------------+      |    屏幕录制/辅助功能/computer-use   |
                              |    原生执行器             E: .app   |
                              |  * cli/alma + tui.mjs +             |
                              |    alma-computer-use-mcp.mjs        |
                              |    CLI/TUI/MCP 入口       E: cli/   |
                              |  * 本地 TTS/ASR: Kokoro / Qwen3-    |
                              |    TTS / Whisper 推理 [推测] 由     |
                              |    bun + @huggingface/transformers  |
                              |    + @fugood/* 原生包承担           |
                              |    E: unpacked 中这些包存在         |
                              +-------------------------------------+
```

### 1.2 关键事实

- **构建链是 electron-vite 风格**：asar 内布局 `/out/main/index.js` + `/out/main/chunks/*.js` + `/out/preload/index.js` + `/out/renderer/*.html`（E: `npx @electron/asar list`）。主进程 chunk 命名暴露功能模块：`computer-use-register-*.js`、`computerUsePip-*.js`、`fatigueService-*.js`（疲劳/休息提醒 [推测]）、`pipFrameSources-*.js`、`rtk-stats-*.js`。
- **Helper 进程**：`Contents/Frameworks/` 下标准 Electron Helper (GPU/Plugin/Renderer)，另带 **Squirrel.framework + Mantle + ReactiveObjC**（E: Frameworks 目录）——Squirrel.Mac 随包分发但实际更新走 electron-updater generic feed（见 §4），Squirrel 为 electron-builder 默认携带的残留 [推测]。
- **签名**：`codesign -dv` 显示 hardened runtime（`flags=0x10000(runtime)`）、TeamID `LY7MVTUDZG`、Developer ID 签名（E: codesign 输出）；notarization [推测] 已 stapled（Gatekeeper 分发前提）。

---

## 2. 多窗口管理

### 2.1 Renderer 入口与窗口映射

asar 内 `/out/renderer/` 共 **8 个 HTML 入口**（E: asar 列表），加 loading（启动屏，[推测] 独立 HTML 或主窗启动路由）共 9 类窗口：

| HTML 入口 | 用途 | 窗口形态 [推测，按命名/功能推断] |
|---|---|---|
| `index.html` | 主聊天窗口（对话、Artifact Sidebar、Preview 面板） | 主 BrowserWindow，隐藏标题栏/毛玻璃 |
| `settings.html` | 设置中心（模型/语音/MCP/技能/通道配置） | 独立单例窗口 |
| `gallery.html` | 作品库（生成的图片/视频/文件） | 独立单例窗口 |
| `lightbox.html` | 图片/媒体大图预览 | 透明无边框浮层，用完即毁 |
| `notifications.html` | 应用内通知中心 | 抽屉/小窗 |
| `livecoding.html` | Live coding 实时预览 | 独立窗口 |
| `prompt-app-runner.html` | Prompt 即应用的运行容器 | 独立沙盒窗口 |
| `share.html` | 分享预览页 | 独立窗口，配合分享链接 |
| `loading` | 启动屏 | 启动早期显示，ready 后切 index |

另有 `node_modules/alma-notifications/assets/toast.html`（E: asar 列表）——**自绘 toast 弹窗**页面，用无边框透明 BrowserWindow 实现富样式通知，不走 macOS NotificationCenter [推测]。

### 2.2 创建/复用策略 [推测，基于 electron-vite 多页应用通行模式 + chunk 命名]

- **单例窗口**（settings/gallery/notifications）：主进程持有 `Map<name, BrowserWindow>`；打开时若存在且未销毁则 `show()+focus()` 复用，否则新建。
- **瞬态窗口**（lightbox/toast）：每次新建、关闭即 destroy；lightbox 用 `frame:false, transparent:true` + vibrancy/玻璃材质。
- **electron-liquid-glass**：`app.asar.unpacked/node_modules/electron-liquid-glass/prebuilds`（E: unpacked 列表）——macOS Liquid Glass 材质原生模块，窗口 UI 大量用系统玻璃材质。
- **computer-use 画中画**：chunk `computerUsePip-*` + `pipFrameSources-*`（E: asar 列表）——computer-use 执行时有 PiP 悬浮窗实时播放被控画面，主进程采集帧（配 `jpegEncoder.worker.js` 压缩）。

---

## 3. IPC 设计

### 3.1 双通道：IPC 与 HTTP 并存

1. **IPC（contextBridge）**：只承载桌面壳能力——窗口控制、托盘、全局快捷键、原生对话框、通知、深链推送、剪贴板、开机启动、权限。preload 为单文件 `/out/preload/index.js`（E: asar 列表），`contextBridge.exposeInMainWorld` 挂全局桥对象（惯用名 `window.alma` / `window.api`，[推测] 命名）。
2. **HTTP（`http://127.0.0.1:23001`）**：所有业务/Agent 能力——会话 CRUD、消息流（SSE）、技能、模型配置、任务调度、记忆、文件、MCP 管理（E: 03 号后端报告已确认 23001 为本地 API 面；renderer 为标准 Web 栈）。

### 3.2 为什么大量功能走 HTTP:23001 而不是 IPC

[推测，置信度高。证据：bun 独立 runtime + cli/tui/mcp 多入口存在 + renderer 是 Web 栈]

1. **一套 API 多端复用**：TUI（`cli/tui.mjs`）、CLI（`cli/alma`）、MCP client、浏览器 Preview 都打同一 HTTP 面；IPC 只活在 Electron 内，TUI/CLI 无法复用。
2. **流式友好**：Agent 对话是长 SSE；`ipcRenderer.invoke` 的请求-响应模型不适合流，chunked HTTP/SSE 天然匹配。
3. **壳与 runtime 解耦**：HTTP 服务可由 bun sidecar 独立承载/调试/重启，Electron 崩了会话不丢（E: bun 是独立 60MB 二进制）。
4. **Web 设施直接复用**：fetch/EventSource/React Query 即可，无需为每个能力写一对 invoke/handler。
5. **安全边界干净**：renderer 保持隔离，只面对 loopback HTTP；攻击面收敛在本地服务一处。

### 3.3 代表性 IPC 通道

命名规约 [推测]：域前缀 + 动作。基于功能完备性，主进程必有 handler 族 [推测，未逐一 dump 验证]：

- `window:minimize / maximize / close / set-bounds`
- `tray:update-status`、`app:quit / relaunch / get-version`
- `shortcut:register / unregister`（全局唤起）
- `updater:check / download / install` + `updater:on-status`（主到渲染 send）
- `dialog:open-file / save-file`、`shell:open-external / show-item-in-folder`
- `permission:check-screen / request-accessibility / request-microphone`
- `deep-link:on-navigate`（主到渲染推送 alma:// 路由）
- `notification:show-toast`（驱动 toast.html 窗口）
- `server:get-port / get-auth-token`——renderer 启动时向主进程要 23001 端口与一次性 token；本地 HTTP 服务几乎必有 loopback 鉴权，否则任意网页可操作用户 Agent [推测，置信度高]

> 复刻若要精确通道清单：strings 扫 `/out/preload/index.js` 再 grep invoke/handle 一步拿全（本次为控制步数未执行）。

---

## 4. 自动更新

**electron-updater + generic provider**，证据齐全。

`Contents/Resources/app-update.yml` 原文（E: 直接读取）：

```yaml
provider: generic
url: https://updates.alma.now/
useMultipleRangeRequest: false
updaterCacheDirName: alma-updater
```

- Feed 地址：`https://updates.alma.now/latest-mac.yml`（electron-updater generic 约定路径，[推测] 文件名）；更新缓存于 `~/Library/Caches/alma-updater`（E: updaterCacheDirName 约定）。
- Squirrel.framework 在包内（E: Frameworks 列表）但 mac 更新实际走 electron-updater generic 流程 [推测]。

**流程** [推测，electron-updater 标准行为]：启动后 + 定时 `checkForUpdates()`，下载 `Alma-<ver>-arm64-mac.zip` 到缓存，推送 `update-downloaded` 给 renderer，用户确认后 `quitAndInstall()`。0.0.x 高频版本号风格与 generic feed 的极简运维（静态文件托管即可，无需更新服务器）相符。

---

## 5. 打包分发

### 5.1 产物构成（E: `du -sh` 实测）

| 组件 | 大小 | 说明 |
|---|---|---|
| `app.asar` | **660MB** | JS + node_modules + renderer 产物 |
| `app.asar.unpacked` | **459MB** | 原生/不可打包内容（dylib/wasm/prebuilds/大依赖） |
| `bun/` | 60MB | Bun 单文件运行时 + `.version` |
| `lark-cli/` | 24MB | 飞书 CLI 二进制 |
| `uv/` | — | Python 包管理器（`uv/uv`） |
| `CalTool.app` | 304KB | EventKit 桥 [推测] |
| `Alma Computer Use.app` | 2.2MB | computer-use 原生执行器 |
| `cli/` | 5.2MB | `alma` CLI、`tui.mjs`、`alma-computer-use-mcp.mjs` |
| `bundled-skills/`、`chrome-extension/` | — | extraResources：技能包与浏览器扩展随包分发（E: Resources 列表） |

### 5.2 electron-builder 要点

- **electron-builder**（E: `app-update.yml` 是该体系产物；lproj 目录、Helper 命名均为默认布局）。
- **asarUnpack**（E: unpacked 实际内容反推）：`sqlite-vec-darwin-arm64/vec0.dylib`（向量检索原生扩展）、`electron-liquid-glass/prebuilds`、`@fugood/*`（whisper/llama 类原生推理 [推测]）、`@huggingface/transformers`、`esbuild-wasm/esbuild.wasm`。等价规则：`asarUnpack` 覆盖 `**/*.node`、`**/*.dylib`、`**/*.wasm` 及上述包目录。
- **目标**：macOS arm64 单架构（E: `Mach-O thin (arm64)`）。
- **签名/公证**：Developer ID + hardened runtime（E: codesign）；notarize + staple [推测]。
- **权限声明**（E: Info.plist）：`NSCameraUsageDescription`、`NSMicrophoneUsageDescription`（原文明确 speech-to-text transcription using Whisper——坐实本地 Whisper）。

---

## 6. 系统集成

| 能力 | 实现 | 证据 |
|---|---|---|
| 托盘 Tray | `Tray` + 菜单（打开/设置/退出、状态） | [推测] 常驻 Agent 标配 |
| 全局快捷键 | `globalShortcut.register` 唤起主窗（类 Spotlight） | [推测] 置信度高 |
| 深链 `alma://` | `setAsDefaultProtocolClient('alma')` + `open-url` 路由到窗口 | 任务既有结论 + Electron 标准 API |
| 系统通知 | 双轨：macOS Notification + 自绘 toast 窗（`alma-notifications/assets/toast.html`） | E: toast.html 存在 |
| 单实例锁 | `requestSingleInstanceLock()`，第二实例聚焦并转发深链参数 | [推测] 有深链的应用几乎必加 |
| 辅助功能/屏幕录制权限 | computer-use 需 AX + Screen Recording 授权；由 `Alma Computer Use.app` 独立 .app 承载（独立 TCC 身份，授权条目与主 App 分离） | E: 独立 .app 存在 + macOS TCC 机制 |
| 麦克风/相机 | Info.plist 用途声明；麦克风用于 Whisper 转录 | E: Info.plist |
| 开机启动 | `app.setLoginItemSettings({ openAtLogin: true })` | [推测] 标配 |

**要点**：把屏幕录制/AX 权限隔离到独立 helper .app 是聪明做法——主 App 升级重签不影响已授予 helper 的 TCC 授权（TCC 按 bundle id/签名记录），且崩溃域隔离 [推测，基于 TCC 机制的推断]。

---

## 7. 安全模型

| 项 | Alma 实践 | 证据 |
|---|---|---|
| contextIsolation | **开启**（preload 单文件 + contextBridge 模式） | E: preload/index.js 存在即表明走隔离桥 |
| nodeIntegration | **关闭**（renderer 纯 Web 栈，业务走 HTTP） | [推测] 置信度高——走 HTTP:23001 的架构动机之一就是不开 node |
| sandbox | 开启 [推测] | electron-vite 默认模板 sandbox:true |
| CSP | renderer HTML 应带 `default-src 'self'` 类 CSP；需放行 `connect-src http://127.0.0.1:23001 ws://127.0.0.1:*`（本地服务 + WebSocket） | [推测] |
| 本地服务鉴权 | loopback token（见 §3.3） | [推测] 置信度高 |
| webSecurity | 保持默认开启 | [推测] |

**架构级结论**：Alma 安全模型的核心是 **renderer 零特权**——不依赖 IPC 白名单的细粒度正确性，而是让 renderer 只持有一个 loopback HTTP 端点；危险能力全部在主进程和 sidecar 里，由主进程统一鉴权与审计。

---

## 8. 【复刻要点】最小可行 Electron 骨架 + 坑

### 8.1 最小骨架（按优先级）

```
my-agent/
  electron.vite.config.ts      # main/preload/renderer 三 target；renderer 多页 rollupOptions.input
  package.json                 # electron-builder: mac arm64, asarUnpack, extraResources
  resources/sidecar/           # bun 等二进制（extraResources 拷入 Resources/）
  src/
    main/index.ts              # 单实例锁 -> 起 HTTP 服务(23001) -> 建主窗 -> 托盘/快捷键/深链/更新
    main/windows.ts            # Map<name,BrowserWindow> 单例窗口工厂
    main/sidecar.ts            # spawn bun sidecar + 健康检查 + 崩溃重启
    preload/index.ts           # contextBridge 暴露桌面壳 API + server:{port,token}
    renderer/index.html        # 主聊天窗
    renderer/settings.html     # 设置窗（先用 1-2 个窗口起步即可）
```

**最小可用切片**：1 个主窗 + 1 个设置窗 + bun sidecar + 23001 HTTP/SSE + 单实例锁 + 深链 + autoUpdater(generic feed)。其余窗口（gallery/lightbox/livecoding 等）都是"打开一个新 BrowserWindow 加载对应 HTML"的复制模式，可后补。

### 8.2 复刻必踩的坑（按 Alma 证据反推）

1. **原生模块必须 asarUnpack**，否则 require `.node/.dylib` 失败。Alma 把 459MB 放在 unpacked（E: du 实测）——`sqlite-vec`、`electron-liquid-glass`、`@huggingface/transformers`、`esbuild-wasm` 都是教训清单。规则要覆盖 `**/*.node`、`**/*.dylib`、`**/*.wasm`。
2. **sidecar 不要打进 asar**：bun（60MB）、lark-cli（24MB）作为 `extraResources` 平铺在 `Resources/` 下（E: Resources 目录实测），运行时 `process.resourcesPath` 定位。打进 asar 会导致每次 spawn 都要解包到临时目录，启动慢且易被杀软误报。
3. **本地 HTTP 服务必须鉴权**：23001 若裸奔，任意网页 fetch 一下就能操作用户的 Agent（E: 推理——这是所有 loopback 服务的公知风险）。Alma 几乎必有 token 机制 [推测]。
4. **TCC 权限隔离**：把需要屏幕录制/辅助功能的代码放到独立 helper .app（Alma 的 `Alma Computer Use.app`，E: 实测存在），主 App 升级重签不会冲掉 helper 已获得的授权。
5. **hardened runtime + notarize 是硬门槛**：Alma 开了 `0x10000(runtime)`（E: codesign）；自带 sidecar 二进制必须逐个签名、entitlements 对齐，否则 Gatekeeper 拦截。
6. **generic feed 最省心**：`app-update.yml` 只有 4 行（E: 实测），一个静态文件托管（`updates.alma.now`）即可支撑全量更新，不用自建更新服务器。
7. **包体积会爆炸**：Alma 的 asar 660MB + unpacked 459MB（E: 实测）——本地推理依赖（transformers/whisper）占大头。复刻时把模型权重改为首启下载（不进安装包），否则安装包会到 GB 级。
8. **窗口不要全做成 IPC 驱动**：Alma 的取舍是"壳能力走 IPC、业务走 HTTP"（见 §3.2）——这是整个架构最值得抄的一条。

---

## 9. 模块级施工图

> 本章把前面 8 章的概念落到**可直接照抄开写的代码骨架**。技术栈：electron-vite + TypeScript + Express + electron-updater + electron-builder，与 Alma 同款（E: package.json 依赖含 `express ^5.1.0`、`electron-updater ^6.6.2`；asar 布局为 electron-vite 风格 `/out/{main,preload,renderer}`）。代码为原创教学骨架，决策抄 Alma 验证过的；Alma 实际行为以证据标注。

### 9.1 工程目录结构（electron-vite 多入口）

```
my-agent/
├── electron.vite.config.ts        # 三 target 构建配置
├── electron-builder.yml           # 打包/签名/asarUnpack/extraResources
├── package.json
├── resources/
│   ├── icon.icns
│   └── sidecar/                   # bun、lark-cli 等二进制（extraResources 拷入）
│       └── bun
└── src/
    ├── main/                      # 主进程（Node.js 环境）
    │   ├── index.ts               # 启动序列（§9.2）
    │   ├── windows.ts             # 窗口工厂（§9.3）
    │   ├── server.ts              # 内嵌 Express（§9.5）
    │   ├── updater.ts             # 自动更新（§9.6）
    │   ├── sidecar.ts             # sidecar 拉起（§9.7）
    │   └── integrations.ts        # 深链/托盘/快捷键（§9.8）
    ├── preload/
    │   └── index.ts               # contextBridge（§9.4）
    └── renderer/                  # 纯 Web 栈（React 等），无 Node
        ├── index.html             # 主聊天窗
        ├── settings.html          # 设置窗
        ├── notifications.html     # 通知中心
        ├── lightbox.html          # 透明浮层
        └── src/                   # 共享前端代码（各 html 引不同入口 tsx）
            ├── main.tsx
            ├── settings.tsx
            └── ...
```

`electron.vite.config.ts` 关键配置：

```ts
// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],   // 关键：dependencies 不打进 bundle，运行时从 node_modules require
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // 坑：sandbox:true 的 preload 必须是 cjs 单文件，不能拆 chunk
        output: { format: 'cjs', inlineDynamicImports: true },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        // 多 html 入口：每个窗口一个 key；产出与 Alma 的 /out/renderer/*.html 同构
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          notifications: resolve(__dirname, 'src/renderer/notifications.html'),
          lightbox: resolve(__dirname, 'src/renderer/lightbox.html'),
        },
      },
    },
  },
})
```

**坑**：`externalizeDepsPlugin()` 会把 `dependencies` 标为 external——这要求 electron-builder 把 `node_modules` 打进 asar（默认行为）；原生模块（`.node/.dylib/.wasm`）再由 `asarUnpack` 放出去（§9.7）。Alma 的 459MB unpacked 就是这个机制的产物（E: du 实测）。

### 9.2 main.ts 启动序列

顺序经 Alma 二进制反推验证（E: main bundle 中含 `requestSingleInstanceLock`、`second-instance`、`update-available/downloaded`、`quitAndInstall`、`express`、`23001` 等符号）。

```ts
// src/main/index.ts
import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './windows'
import { startApiServer } from './server'
import { initUpdater } from './updater'
import { registerProtocol, setupTray, setupGlobalShortcut } from './integrations'

// ① 单实例锁 —— 必须在任何 app 事件之前调。有深链的应用几乎必加
//    （Alma 证据：main bundle 中 requestSingleInstanceLock + second-instance 各出现 1 次）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()                       // 第二实例直接退出
} else {
  app.on('second-instance', (_e, argv) => {
    // 第二实例命令行里可能带 alma:// 深链（Windows/Linux；macOS 走 open-url）
    const deepLink = argv.find((a) => a.startsWith('alma://'))
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.restore(); win.focus() }
    if (deepLink) win?.webContents.send('deep-link', deepLink)
  })

  // ② 注册深链协议 —— 可在 ready 前调（它只是写注册表/声明意图）
  registerProtocol()               // app.setAsDefaultProtocolClient('alma')

  void app.whenReady().then(async () => {
    // ③ 先起内嵌 HTTP 服务：窗口加载 renderer 后立刻就要 fetch 它，
    //    必须先于窗口就绪；它不依赖任何窗口状态，可以最早起
    const { port, token } = await startApiServer()   // 127.0.0.1:23001，见 §9.5

    // ④ 创建主窗口（preload 通过 IPC 拿 port/token，见 §9.4/9.5）
    createMainWindow({ port, token })

    // ⑤ electron-updater 初始化 —— 坑：必须在 ready 之后调，
    //    否则 autoUpdater 内部读 app.getPath 会抛；且 macOS 未签名包
    //    checkForUpdates 会静默失败（见 §9.6）
    initUpdater()

    // ⑥ 托盘 + 全局快捷键 —— 最后装：快捷键回调要 toggle 主窗，依赖主窗已存在
    setupTray()
    setupGlobalShortcut()
  })

  // macOS 惯例：关窗不退出，点 dock 图标重建主窗
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
}
```

**顺序要点**：HTTP 服务（③）可在窗口（④）之前起——renderer 一加载就要打它；updater（⑤）必须在 `whenReady` 之后；快捷键（⑥）最后，因为回调里要引用主窗。

### 9.3 窗口工厂：单例 vs 瞬态

```ts
// src/main/windows.ts
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

// —— webPreferences 安全基线（与 Alma §7 一致：renderer 零特权）——
const baseWebPreferences = {
  contextIsolation: true,        // 必开：preload 与页面 JS 隔离世界
  nodeIntegration: false,        // 必关：renderer 无 Node 能力，业务走 HTTP
  sandbox: true,                 // 开：preload 只能用 contextBridge/ipcRenderer 子集
  webSecurity: true,             // 保持默认
  preload: join(__dirname, '../preload/index.js'),  // electron-vite 产物固定相对路径
} satisfies Electron.WebPreferences

// —— 开发/生产加载切换：electron-vite 注入 ELECTRON_RENDERER_URL ——
function loadEntry(win: BrowserWindow, entry: string, hash = '') {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    // 开发：走 vite dev server（HMR）；多页按 <url>/<entry>.html 区分
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${entry}.html${hash}`)
  } else {
    // 生产：从 asar 内 out/renderer/ 加载
    void win.loadFile(join(__dirname, `../renderer/${entry}.html`), { hash })
  }
}

// ===== 单例窗口（主聊天 / 设置）：Map 持有，存在则聚焦复用 =====
// （Alma 行为 [推测]：settings/gallery/notifications 为独立单例窗，见 §2.2）
const singletons = new Map<string, BrowserWindow>()

export function createSingleton(
  name: string,
  entry: string,
  opts: Electron.BrowserWindowConstructorOptions,
) {
  const existing = singletons.get(name)
  if (existing && !existing.isDestroyed()) {
    existing.show(); existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    ...opts,
    webPreferences: baseWebPreferences,
    show: false,                       // 坑：先隐式创建，ready-to-show 再显示，避免白屏闪
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => singletons.delete(name))   // 关窗即从 Map 摘除
  // 坑：外链必须拦到系统浏览器，否则在壳内导航丢上下文
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadEntry(win, entry)
  singletons.set(name, win)
  return win
}

export function createMainWindow(_ctx?: { port: number; token: string }) {
  return createSingleton('main', 'index', {
    width: 1200, height: 800,
    titleBarStyle: 'hiddenInset',      // macOS 隐藏标题栏（Alma 主窗风格 [推测]）
    vibrancy: 'under-window',          // 毛玻璃；Alma 用 electron-liquid-glass 原生材质
                                       // （E: unpacked 含其 prebuilds）
  })
}
export const openSettingsWindow = () =>
  createSingleton('settings', 'settings', { width: 880, height: 640 })

// ===== 瞬态窗口（lightbox / toast）：用完即毁，不进 Map =====
export function createLightbox(imageUrl: string) {
  const win = new BrowserWindow({
    frame: false, transparent: true,   // 无边框透明浮层
    alwaysOnTop: true, resizable: false,
    webPreferences: baseWebPreferences,
  })
  loadEntry(win, 'lightbox', `#src=${encodeURIComponent(imageUrl)}`)
  // 失焦即关（看图浮层惯例）；closed 时 BrowserWindow 自动销毁
  win.on('blur', () => win.close())
  return win
}
```

**坑**：① `preload` 路径用 `__dirname` 相对拼——electron-vite 下 main 与 preload 产物是兄弟目录（`out/main`、`out/preload`），所以是 `../preload/index.js`；② `sandbox: true` 时 preload 里**不能 require 任何非 Electron 模块**（所以 §9.1 里 preload 要 `inlineDynamicImports` 打成单文件）；③ `show:false` + `ready-to-show` 是消除启动白屏的标配。

### 9.4 preload bridge：最小 namespace

Alma 实测（E: `/out/preload/index.js` 中 `exposeInMainWorld` 逐个 grep 所得）：暴露的全局名包括 `apiServer`（`getInfo: () => ipcRenderer.invoke("api-server-info")`）、`windowControls`（`minimize/maximize/fullscreen/close`）、`platform`、`settingsWindow`、`quickChatWindow`、`almaIab` 等。主进程侧 `api-server-info` handler 返回 `{ port, baseURL: http://localhost:<port> }`（E: main bundle 对应代码段）。照此设计：

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'

// namespace 1：apiServer —— renderer 启动第一件事：问主进程要本地服务地址
// 为什么端口要走 IPC 问而不是写死？端口冲突时主进程会换端口（§9.5），
// renderer 不能假设 23001 永远可用。
contextBridge.exposeInMainWorld('apiServer', {
  getInfo: () =>
    ipcRenderer.invoke('api-server-info') as Promise<{
      port: number; baseURL: string; token: string
    }>,
})

// namespace 2：windowControls —— 隐藏标题栏后窗控按钮要自绘，桥给 renderer
// （Alma 实测同名 namespace，E: preload bundle）
contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
})

// namespace 3：platform —— renderer 判断平台做 UI 适配（页面里 Node process 不可用）
// （Alma 实测同名，E: preload bundle）
contextBridge.exposeInMainWorld('platform', process.platform)

// namespace 4：深链推送 —— 主进程收到 alma:// 后推给 renderer 路由
contextBridge.exposeInMainWorld('deepLink', {
  onNavigate: (cb: (url: string) => void) => {
    const listener = (_e: unknown, url: string) => cb(url)
    ipcRenderer.on('deep-link', listener)
    return () => ipcRenderer.removeListener('deep-link', listener)  // 返回取消函数，防泄漏
  },
})
```

**为什么业务通信走 HTTP 不走 IPC**（Alma §3.2 结论复述为施工原则）：IPC 只承载"壳能力"（窗控/托盘/深链/对话框，如上 4 个 namespace）；会话、消息流（SSE）、技能、模型配置等业务全部 `fetch('http://127.0.0.1:23001/...')`。这样 TUI/CLI/MCP client 复用同一 API 面（E: Alma `cli/` 目录存在独立入口），且 renderer 保持纯 Web 技术栈、无需为每个业务接口写 invoke/handler 对。

### 9.5 内嵌 HTTP 服务（Express，loopback + token）

```ts
// src/main/server.ts
import express from 'express'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ipcMain } from 'electron'

const DEFAULT_PORT = 23001          // Alma 同款端口（E: main bundle 中 23001 出现 7 处）
// Alma 教训：23001 未见鉴权迹象（grep 未见 Authorization/x-api-key 类本地校验，
// 仅 OAuth refresh_token 等无关命中）。复刻必须加 token：
// loopback 不等于安全，本机任意进程/恶意网页都能打 127.0.0.1。
const token = randomBytes(24).toString('hex')   // 每次启动重新生成，不落盘

export async function startApiServer(): Promise<{ port: number; token: string }> {
  const api = express()
  api.use(express.json({ limit: '10mb' }))

  // —— 本地 token 鉴权中间件：除 /healthz 外全量校验 ——
  api.use((req, res, next) => {
    if (req.path === '/healthz') return next()
    if (req.headers['x-alma-token'] !== token) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    next()
  })
  // 坑：CORS 不要开 Access-Control-Allow-Origin: *。
  // renderer 是 file:// / dev-server origin，逐个放行即可；
  // 开了 * 又没有 token，任意网页 JS 都能操作用户的 Agent（浏览器直连 loopback）。

  api.get('/healthz', (_req, res) => res.json({ ok: true }))
  // …业务路由：/api/threads、/api/messages(SSE)、/api/skills、/api/mcp …

  const server = createServer(api)

  // —— 端口冲突处理：23001 被占则递增重试，最多 10 次 ——
  const port = await new Promise<number>((resolve, reject) => {
    let p = DEFAULT_PORT
    const tryListen = () => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && p < DEFAULT_PORT + 10) { p++; tryListen() }
        else reject(err)
      })
      // 关键：只绑 127.0.0.1。写 listen(p) 会绑 0.0.0.0 —— 局域网任何人都能调你的 Agent
      server.listen(p, '127.0.0.1', () => resolve(p))
    }
    tryListen()
  })

  // 透传给 preload 的桥（§9.4 apiServer.getInfo）
  ipcMain.handle('api-server-info', () => ({
    port, token, baseURL: `http://127.0.0.1:${port}`,
  }))
  return { port, token }
}
```

**坑**：① `listen(port)` 不指定 host 会绑 `0.0.0.0`，本地服务直接暴露到局域网——最经典的一条；② token 走自定义 header（`x-alma-token`）而不是 query，避免进日志/浏览器历史；③ SSE 路由要 `res.flushHeaders()`，且别让 compression 中间件包住 SSE 路由（缓冲会憋死流）。

### 9.6 electron-updater 集成

Alma 的 feed 配置（E: `Contents/Resources/app-update.yml` 原文）：

```yaml
provider: generic
url: https://updates.alma.now/
useMultipleRangeRequest: false
updaterCacheDirName: alma-updater
```

复刻版主进程代码：

```ts
// src/main/updater.ts
import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'

const broadcast = (channel: string, payload: unknown) =>
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload))

export function initUpdater() {
  // 坑 1：macOS 上应用未签名时，checkForUpdates 直接抛/静默失败。
  //        开发期（未打包）直接跳过；要测更新链就用 forceDevUpdateConfig。
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true           // 静默后台下载（Alma 高频小版本风格 [推测]）
  autoUpdater.autoInstallOnAppQuit = true

  // 事件流：checking -> update-available -> (download-progress) -> update-downloaded
  //                                                            \-> error
  // Alma 证据：main bundle 中 update-available / update-downloaded 各出现 5 次、
  // quitAndInstall 1 次（E: grep 计数），即标准 electron-updater 事件流。
  autoUpdater.on('checking-for-update', () => console.log('[updater] checking'))
  autoUpdater.on('update-available', (info) => {
    // 推给 renderer 显示"发现新版本"角标
    broadcast('updater:status', { phase: 'available', version: info.version })
  })
  autoUpdater.on('update-downloaded', () => {
    // 用户确认后 quitAndInstall；不要自动调——用户可能正在打字
    broadcast('updater:status', { phase: 'downloaded' })
  })
  autoUpdater.on('error', (err) => {
    // 坑 2：必须挂 error 监听，否则未捕获异常可能崩主进程；
    // 常见"错误"其实是网络抖动，记日志即可，别弹窗骚扰
    console.error('[updater] error', err)
  })

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), 4 * 3600_000)  // 每 4h 轮询
}

// renderer 点"立即重启更新"时（在主进程某处注册）：
// ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall())
```

**feed 托管两个免服务器方案**：

1. **generic + 静态托管**（Alma 方案）：`electron-builder.yml` 配 `publish: { provider: generic, url: https://updates.example.com/ }`，构建产物 `latest-mac.yml` + zip 一起传到任意静态托管（OSS/CDN/Cloudflare R2）。`latest-mac.yml` 是 builder 自动生成的版本清单，electron-updater 按约定路径拉取。
2. **GitHub Releases 当免费 feed**：`publish: { provider: github, owner: you, repo: my-agent }`，electron-updater 自动读 Releases 里的 `latest-mac.yml`。私有仓库要 token，开源项目零成本——缺点是 release 页面对用户可见。

**未签名包的更新限制**：macOS 上 electron-updater 用 Squirrel.Mac 替换 app 包，**要求新旧包同 TeamID 签名**；未签名的开发包跑更新会失败（报 `Could not get code signature...` 类错误）。所以 Alma 走 Developer ID + hardened runtime（E: codesign）不只是分发门槛，也是更新链路的前提。Windows 无此限制（nsis 包可直接换）。

### 9.7 sidecar 二进制打包

`electron-builder.yml` 关键段：

```yaml
# electron-builder.yml
appId: com.example.myagent
productName: MyAgent
mac:
  target: [ { target: dmg, arch: [arm64] } ]   # Alma 为 arm64 单架构（E: Mach-O thin arm64）
  hardenedRuntime: true                        # E: Alma codesign flags=0x10000(runtime)
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
asarUnpack:
  - '**/*.node'          # 原生 addon 不进 asar（require .node 要从真实文件系统读）
  - '**/*.dylib'         # Alma 教训：sqlite-vec/vec0.dylib 就在 unpacked（E: 实测）
  - '**/*.wasm'          # esbuild-wasm 同理（E: unpacked 列表）
  - 'node_modules/@huggingface/**'
extraResources:
  # sidecar 二进制平铺进 Resources/，与 Alma 的 Resources/bun 同款布局（E: 实测）
  - from: resources/sidecar
    to: sidecar
    filter: ['**/*']
```

运行时定位与拉起（开发/生产两分支）：

```ts
// src/main/sidecar.ts
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

function sidecarPath(bin: string): string {
  if (app.isPackaged) {
    // 生产：extraResources 拷到 <App.app>/Contents/Resources/sidecar/
    // process.resourcesPath 指向 Contents/Resources —— Alma 二进制里
    // 大量出现 `resourcesPath=${process.resourcesPath}` 就是这个用途（E: grep）
    return join(process.resourcesPath, 'sidecar', bin)
  }
  // 开发：直接用仓库里的 resources/sidecar/
  // 坑：别用 app.getAppPath() 拼生产路径——它指向 asar 内部，
  //     asar 里的"文件"对 spawn 不可见（不是真实文件系统条目）
  return join(app.getAppPath(), 'resources', 'sidecar', bin)
}

let child: ChildProcess | null = null
let quitting = false

export function startSidecar(apiPort: number) {
  const bin = sidecarPath(process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (!existsSync(bin)) throw new Error(`sidecar missing: ${bin}`)

  // 坑：生产环境 macOS 要求 sidecar 也已签名（hardened runtime 会拦未签名 exec）
  child = spawn(bin, ['run', 'agent-runtime.ts'], {
    env: { ...process.env, AGENT_API_PORT: String(apiPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.on('exit', (code) => {
    console.log('[sidecar] exit', code)
    // 崩溃重启：简单退避即可，Alma 有完整守护逻辑 [推测]
    if (!quitting) setTimeout(() => startSidecar(apiPort), 1000)
  })
  return child
}

// 退出清理：will-quit 里 kill，否则 sidecar 变孤儿进程
// app.on('will-quit', () => { quitting = true; child?.kill() })
```

**坑**：① sidecar 绝不打进 asar——asar 内路径 spawn 不了，Electron 会静默解到临时目录，启动慢 + 杀软误报（Alma 把 60MB bun 平铺在 Resources/ 就是答案，E: 实测）；② `process.resourcesPath` 只在 packaged 后有意义，开发期它指向 Electron 自身的 Resources，所以必须分两分支；③ macOS 分发时 sidecar 要逐个 `codesign`（builder 对 extraResources 里自放二进制的签名不一定覆盖，必要时在 afterSign 钩子里补签）。

### 9.8 深链 + 托盘 + 全局快捷键

```ts
// src/main/integrations.ts
import { app, Tray, Menu, globalShortcut, BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'

const SCHEME = 'alma'

// —— 深链 ——
export function registerProtocol() {
  // macOS：Info.plist 声明 CFBundleURLTypes 后，运行时调用登记（重复调幂等）
  // Windows：exe 安装后写注册表；开发期要传 argv 指定 exe 路径
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient(SCHEME)
  }
}

// macOS 专属：协议触发 open-url（可能早于 ready，必须 ready 前挂监听！）
// 坑：open-url 在 app ready 之前就可能来——所以这段要在模块顶层执行，
//     不能塞进 whenReady 回调里，否则冷启动深链丢失
app.on('open-url', (event, url) => {
  event.preventDefault()                            // 必调，否则系统走默认行为
  const deliver = () =>
    BrowserWindow.getAllWindows()[0]?.webContents.send('deep-link', url)
  if (app.isReady()) deliver()
  else void app.whenReady().then(deliver)           // 冷启动：等 ready 后投递
})

// —— 托盘 ——
export function setupTray() {
  // 坑：macOS Tray 图标用 16x16/18x18 Template Image（自动适配深浅菜单栏），
  //     文件名带 Template 后缀：iconTemplate.png
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/iconTemplate.png'))
  const tray = new Tray(icon)
  tray.setToolTip('MyAgent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => BrowserWindow.getAllWindows()[0]?.show() },
    { label: '设置', click: () => { /* openSettingsWindow() */ } },
    { type: 'separator' },
    { label: '退出', click: () => app.exit(0) },
    // 坑：托盘"退出"用 app.exit 或先置 isQuitting 再 close，
    //     否则触发的是 window-all-closed 逻辑（mac 上不退出）
  ]))
}

// —— 全局快捷键 ——
export function setupGlobalShortcut() {
  // 类 Spotlight 唤起（Alma 行为 [推测]，常驻 Agent 标配）
  const ok = globalShortcut.register('Alt+Space', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isVisible() && win.isFocused()) { win.hide() } else { win.show(); win.focus() }
  })
  // 坑：register 返回 false = 热键被别的 App 占用（Alt+Space 是重灾区），
  //     要降级到备用键或提示用户改键，不能假装成功
  if (!ok) console.warn('[shortcut] occupied, fallback needed')
}

// 注销时机：will-quit 里全量注销。漏了的话 Windows 上重装/重启 App 会报占用
app.on('will-quit', () => globalShortcut.unregisterAll())
```

**坑汇总**：① `open-url` 是 macOS 专属且可能早于 ready，Windows/Linux 深链走 `second-instance` 的 argv（§9.2 ①），两条路都要铺；② `event.preventDefault()` 漏调会让系统把 URL 交给默认处理；③ 全局快捷键回调在**主进程**执行，里面操作窗口无需 IPC；④ `will-quit` 里 `unregisterAll` 是死规矩。

---

> 本章证据基础：preload 的 `exposeInMainWorld` 清单与 `api-server-info` 返回结构（E: grep `/out/preload/index.js` 与 `/out/main/index.js`）；主进程符号计数 `requestSingleInstanceLock×1 / second-instance×1 / update-available×5 / update-downloaded×5 / quitAndInstall×1 / express×42 / 23001×7`（E: grep）；feed 配置（E: `app-update.yml` 原文）；依赖版本 `express ^5.1.0`、`electron-updater ^6.6.2`（E: package.json）；unpacked 内容与 Resources 布局（E: asar/du 实测）。未标注处为通行 Electron 工程实践或合理 [推测]。
