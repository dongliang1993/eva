# Alma v0.0.990 调研 21：主进程 / 前端 / preload 规格（Electron 壳修订版）

> 调研对象：Alma v0.0.990（2026-08-21 构建），解包产物在 `/tmp/alma-extract/`。
> 证据：`main.readable.js:NNNNN` = `/tmp/alma-extract/main.readable.js`（prettier + js-beautify 两轮美化后的主进程 bundle，107,803 行）；`preload/index.js` = `/tmp/alma-extract/asar/out/preload/index.js`（单行压缩，22KB 已全读）；renderer 证据 = `/tmp/alma-extract/asar/out/renderer/`；安装包证据 = `/Applications/Alma.app/Contents/…`（PlistBuddy / cat 实测）。
> 与旧版 02 篇的关系：02 篇基于 v0.0.960 的 asar 列表 + 推测写成，本篇是 v0.0.990 的**实证修订**。02 篇的骨架判断（单主窗 + 多 HTML 入口 + contextBridge 窄桥 + loopback HTTP 业务面）全部仍成立；窗口映射表、IPC 清单、§3.3 的 loopback token 推测已过时，以本篇为准。

---

## 1. 启动序列

### 1.1 步骤清单（全部行号为 `main.readable.js`）

启动代码集中在文件尾部 103,760–107,803。精确顺序：

| # | 步骤 | 行号 | 说明 |
|---|---|---|---|
| 0 | Heap watcher | 103879–103894 | `setInterval` 轮询 `v8.getHeapStatistics()` + 各 renderer `getOSProcessId()` 内存，超阈值（诊断模式 512MB）写 `.heapsnapshot` 到磁盘。常态配置 `{pollMs: 3e4, autoSnapshot: !1}`（103888–103892），诊断模式 `{pollMs: 250, …}` |
| 1 | Sentry 初始化 | 103895–103908 | `@sentry/electron/main`。原文见 §1.2 |
| 2 | 单实例锁 | 103911–103917 | `requestSingleInstanceLock()` 成功则挂 `second-instance`（restore→show→focus 主窗），失败 `app.quit()`。**没有** `setAsDefaultProtocolClient`/`open-url`——`alma://` 在 v0.0.990 只是应用内引用 URI 体系（refs，见 17 篇），未注册成 OS 协议 |
| 3 | `app.whenReady().then(...)` | 106951 | 主启动体，内部顺序见下 |
| 3a | `setPermissionRequestHandler` | 106955–106957 | 只放行 `media/microphone/audio`，其余一律 `n(!1)` |
| 3b | `fix-path` 修 PATH | 106960–106979 | 幂等标志 `IP`；修完打日志，PATH 没变化时 warn「This may cause 'command not found' errors.」 |
| 3c | 构造通知管理器 | 106986–106991 | `new Bi({rendererDist, viteDevServerUrl, preloadPath})`（`class Bi` 在 10404；native NSPanel 优先，fallback BrowserWindow，见 §2.5） |
| 3d | 安装 CLI wrapper | 106992–107085 | 把 `resources/cli/alma` 包成 shell 脚本写到 `~/.local/bin/alma`，内容原文 `#!/bin/bash\nexec "<resourcesPath/bun/bun>" "<resourcesPath/cli/alma>" "$@"\n`（107060，mode 0755）；Windows 写 `%LOCALAPPDATA%\Alma\bin\alma.cmd` 并 `reg add HKCU\Environment` 改 PATH（107011–107046）。已存在且内容相同则跳过（107074） |
| 3e | 创建并启动 APIServer | 107086–107113 | `aD = new RM()`（`class RM` 73347），`aD.start()` **重试 3 次**（退避 500ms×n）；3 次全失败 `dialog.showErrorBox("Alma failed to start", …)` 并 `app.quit()`。成功后把端口写回 `process.env.API_SERVER_PORT`（107095） |
| 3f | 恢复外观偏好 | 107114–107137 | 读 `app_settings.settingsData`：`general.appIcon === "alt1"` 换 dock 图标；`general.hideDockIcon` → `app.dock.hide()`（菜单栏模式） |
| 3g | 创建主窗口 | 107138 | `bD()`（窗口参数见 §2.1） |
| 3h | 创建 Tray | 107140–107244 | 详见 §1.3 |
| 3i | 注册 quick-chat 全局快捷键 | 107246 | `oL(rL())`；`rL()` 返回 `Command+Shift+Space`（darwin）/ `Ctrl+Shift+Space`（106106–106111） |
| 3j | 注册 appshot/window-capture IPC 族 | 107247–107489 | 截屏系列：`appshot:get-state/set-hotkey/capture-now/prewarm`、`window-capture:begin/page/copy/save/pick-wallpaper/…`。native 截图走 `/usr/sbin/screencapture -x -t png -l <windowId>`（107305–107317），失败回落 `webContents.capturePage()` |
| 3k | `yP()` + `wP.prewarm()` | 107490–107493 | appshot 服务预热；再从 settings 恢复 `appshots.hotkey`（107494–107505） |
| 3l | prompt app 快捷键 | 107507–107518 | 遍历 `getAllPromptApps()`，enabled 且有 `shortcut` 的逐个 `sL(id, {name, shortcut})` |
| 3m | 自动更新 | 107519–107660 | electron-updater，详见 §5.1 |
| 3n | 后台装 Playwright | 107661–107669 | `lP()`，状态经 `playwright-install-status` 推给主窗 |

`APIServer.start()`（93701 起）内部顺序：

```
93713  vr.initialize()                 # DB（drizzle + better-sqlite3）
93715  li()                           # 全局 undici 代理 dispatcher
93717  initializeDefaultWorkspace()   # <userData>/workspaces/default
93721  pd()                           # Capabilities 后台初始化
93728  computer-use MCP 自动注册      # 动态 import chunk，失败仅记日志
93734  $T.initialize()                # MCP（后台，不 await）
93737  Ug.setDBCallbacks + Ug.loadSkills()      # 技能（后台）
93746  LI.initialize()                # hooks.json（后台）
93749  PI.setDBCallbacks + loadPlugins + activateEnabledPlugins  # 插件（后台）
93829  findAvailablePort(this.port)   # 23001 起向后递增
93833  server.listen(port, "127.0.0.1")   # 只绑 IPv4 loopback；EADDRINUSE 时 port++ 整体重试（93935-93939）
93835  restoreLoops() + setupWebSocket()
93838  setImmediate(…)                # listen 之后的收尾批：
        ├ 生成 ~/.config/alma/api-spec.md（93840–93857，本仓库证据 9 就是它启动时自动写的）
        ├ references 回填 + 正文 reindex（93861–93882）
        ├ cleanupStaleToolStates() / resetStuckGenerations()（93883–93884，
        │   后者 10s 后 resumeInterruptedTasks 自动续跑，93943–93991）
        ├ startBackgroundUsageMigrationIfNeeded() / startHeartbeat() /
        │   startPluginUpdateChecker()（93896–93898）
        ├ initializeTelegramBot / DiscordBot / FeishuBot(feishu+lark) /
        │   WeixinBot / syncMobileRelayFromSettings（93899–93912）
        ├ initializeHeartbeatService / CronService / ThreadArchiver /
        │   ActivityRecorder（93913–93932，各自 try/catch，挂了不影响启动）
```

端口可用性判定（`isPortAvailable`，93676–93694）：对 `127.0.0.1` 和 `::1` 各做一次 200ms TCP connect 探测，**两栈都连不上才算可用**；`findAvailablePort` 从初始值逐个 +1 扫（93695–93699，无上限；初始值 23001，构造函数 `constructor(e = 23001)` 73549）。

### 1.2 时序图

```
main process                          renderer / sidecar
────────────                          ──────────────────
heap watcher armed (103879)
Sentry.init (103895)
requestSingleInstanceLock ──失败──> quit
        │ 成功
whenReady (106951)
  ├ permission handler (仅 media/mic/audio)
  ├ fix-path
  ├ new Bi() 通知管理器 (native NSPanel 优先)
  ├ CLI wrapper → ~/.local/bin/alma
  ├ new RM() APIServer
  │    └ start() ×重试3次:
  │         DB init → proxy → default workspace
  │         → [后台] MCP/skills/hooks/plugins/computer-use
  │         → findAvailablePort(23001+) → listen 127.0.0.1
  │         → restoreLoops + setupWebSocket
  │         → [setImmediate] api-spec.md 生成 / refs 回填 /
  │           卡死生成恢复 / heartbeat / cron / 四通道 bot
  │    失败 ──> showErrorBox + quit
  ├ dock 图标 / hideDockIcon
  ├ bD() 主窗 ──loadFile index.html──> renderer 起 React，
  │                                     先调 api-server-info 拿端口，
  │                                     之后全部业务走 HTTP/WS
  ├ UP() Tray（10s 周期刷新菜单）
  ├ quick-chat 快捷键 Cmd+Shift+Space
  ├ prompt-app 快捷键 ×N
  ├ autoUpdater（3s 首查，30min 轮询，60s 预热差分缓存）
  └ lP() 后台装 Playwright ──"playwright-install-status"──> 主窗

退出路径：before-quit (107776) → globalShortcut.unregisterAll
  → ActivityRecorder.stop → tray.destroy → ACP cleanupAllSessions
```

### 1.3 Tray / 快捷键 / powerMonitor / 崩溃守护

- **Tray**（107140–107244）：`almaTrayTemplate.png`（macOS template image），菜单 = Show Alma / Quick Chat / Activity Recorder（Start|Stop、digest 弹窗、设置）/ Settings / Quit Alma（置 `uL=!0` 后 `DP.destroy()` + `app.quit()`，107226）。每 10s `setInterval` 重建菜单反映录制状态（107232–107240）。
- **全局快捷键**：quick-chat 固定 `Command+Shift+Space`/`Ctrl+Shift+Space`（106106–106111），renderer 可经 `update-quick-chat-shortcut` IPC 改（106260）；每个 prompt app 可自带快捷键（`sL`，106130 起）。dev 态有 `CommandOrControl+Shift+T` 测试 toast（10455，可用 `ALMA_DEV_NOTIFY_SHORTCUT=off` 关）。
- **powerMonitor**：只属于 ActivityRecorderService（67189–67232）。监听 `lock-screen/unlock-screen/suspend/resume`：锁屏/挂起 → 向当前记录 session 插 `{kind:"lock", data:{via:"powerMonitor"}}` 事件并 `closeCurrentSession("idle")`；解锁/恢复 → 重置截屏去重状态（prevThumbnail/prevHistogram/prevHashHex）。**不做**休眠后网络重连。
- **崩溃守护**（107671–107788）：
  - `unhandledRejection/uncaughtException` → `dL()`：写 `userData/main-crash.log` + `Sentry.captureException`（107671–107694）；
  - `render-process-gone` → 2s 后 `bD()` 重建主窗，重建失败 `app.relaunch()` + `exit(0)`（107709–107740）；正常退出（`clean-exit`、SIGTERM kill）不算事故（107699–107708）；
  - `child-process-gone`：Network Service（Utility 进程，名字匹配 `/network/i`）300s 内崩满 3 次才 `relaunch()`，其余 Utility 崩溃交给 Chromium 自愈（107741–107775）；
  - `before-quit` → 注销快捷键、停 ActivityRecorder、destroy tray、`Ry.cleanupAllSessions()`（ACP 会话清理，107776–107788）。

### 1.4 Sentry 原文（103895–103907）

```js
Wn.init({
    dsn: "https://d6d12e1b5a6744f646725d7539440852@o441417.ingest.us.sentry.io/4510488586485760",
    release: `alma@${n.getVersion()}`,           // alma@0.0.990
    environment: n.isPackaged ? "production" : "development",
    tracesSampleRate: 0.1,
    enabled: n.isPackaged || "true" === process.env.SENTRY_DEBUG,
    beforeSend: (e) => (
        e.request?.headers &&
        (delete e.request.headers.Authorization,
            delete e.request.headers["X-Api-Key"]),
        e
    ),
})
```

DSN 硬编码明文；`beforeSend` 只剥 `Authorization`/`X-Api-Key` 两个请求头。复刻时别照抄 DSN。

---

## 2. 窗口清单

### 2.1 八个 HTML 入口 ↔ 窗口映射（loadFile 调用点全部核实）

`out/renderer/` 实有 8 个 html 入口（`ls` 实测）；`loading/` 目录仍在但 bundle 中已无 loadFile 调用点，启动屏疑已废弃。

| HTML | 窗口 | 关键参数（原文值） | 打开者 / 调用点 |
|---|---|---|---|
| `index.html` | 主窗 `DP` | 1200×800，minWidth 800 / minHeight 600，`frame:!1`，mac `transparent:!0, titleBarStyle:"hiddenInset"`，**红绿灯藏到 (-100,-100)**（自绘窗控），`webviewTag:!0`（iab 内嵌浏览器硬依赖）；恢复 `userData/window-state.json`（宽高/xy/isMaximized，`hD/pD` 104038–104059）；dev 下 loadURL 失败重试 3 次（退避 1s×n，104357–104376） | 启动 `bD()`（107138）；窗口创建代码 104281–104308；`activate` 重建（104401） |
| `index.html#/quick-chat` | quick-chat 窗 `jP` | 600×400（持久化 `quick-chat-window-state.json`），`alwaysOnTop:!0, skipTaskbar:!0, frame:!1, type:"panel"`(mac)，位置 = 主屏底部居中偏上 50px（104449–104452）；支持 click-through 穿透（`setIgnoreMouseEvents(…, {forward:!0})`，105640–105652） | 全局快捷键 / Tray「Quick Chat」；104454–104481 |
| `index.html#/more-menu` | more-menu 弹出面板 `KP` | 280×440，`frame:!1, transparent:!0, type:"panel"`，`setAlwaysOnTop(!0,"pop-up-menu")`（105281），初始藏在 (-10000,-10000) 预热，blur 即隐藏；`more-menu:report-size` 按内容重设 bounds + `showInactive()`（105390–105398） | 主窗标题栏「…」按钮经 `more-menu:open` IPC（105336）；创建 105255–105298 |
| `index.html#/minesweeper` 等 hash 路由 | **扫雷彩蛋 4 窗** `zP/qP/GP/HP` | 200×296，`backgroundColor:"#c0c0c0"` 仿 Win95；hash 分别为 `#/minesweeper`、`#/minesweeper-help`、`#/minesweeper-scores`（105698/105732/105766），另有 `#/minesweeper-record?level=…&seconds=…` 破纪录窗（105773–105796，存在即 destroy 重建）；主窗在 win98 主题下还挂鼠标拖尾特效（`dP`，104324–104347） | `minesweeper-window-open` IPC（105667） |
| `settings.html` | 设置窗 `BP` | 980×740，minWidth 600 / minHeight 640，**单例**（存在则 show+focus 并 `send("settings-change-tab", tab)`，104073–104081），红绿灯 (20,20)，mac `transparent:!0, titleBarStyle:"hiddenInset"` | Tray / 主窗菜单 `mD()`；104061–104150 |
| `prompt-app-runner.html` | Prompt App 运行窗 | 尺寸取 `prompt_apps.windowWidth/Height`（缺省 520×680），minWidth 400 / minHeight 500；**每次触发新建实例**（`sD: Map<runId,BrowserWindow>`，`iD: webContents.id→promptApp` 映射，104876–104879） | `prompt-app-runner-open` IPC（104841）或 prompt app 快捷键（`sL` 回调内联建窗，106130 起） |
| `livecoding.html` | Live Coding 窗 `YP` | 900×700，minWidth 600 / minHeight 500，单例，`titleBarStyle:"hidden"`；打开前把待执行代码存主进程变量 `nL`，renderer 经 `liveCodingWindow.getPendingCode()` 取走；`did-finish-load` 后再 `send("livecoding-code", code)`（106240–106244） | `livecoding-window-open` IPC（106199–106251） |
| `gallery.html` | 作品库 `WP` | 1200×800，minWidth 800 / minHeight 600，单例；`?imageId=` query 直达某图；已开则 `send("gallery-navigate-to-image", id)`（105839–105844） | `gallery-window-open` IPC；105847–105896 |
| `share.html` | 分享预览窗 `JP` | 900×700，minWidth 600 / minHeight 500，相对主窗居中；**「主进程暂存 + ready 回拉」模式**：payload 先存 `oD`，renderer 发 `share-window-ready` 后主进程 `send("share-data", oD)`（105975–105977） | `share-window-open` IPC（105913–105980） |
| `lightbox.html` | 图片查看器 `XP` | 1000×700，minWidth 600 / minHeight 400，单例；参数存主进程 `tL`，renderer 调 `lightbox-window-get-initial-params` 领取（校验 `sender.id === XP.webContents.id`，106046–106048）；更新走 `lightbox-update`；可 `lightbox-edit-image-in-thread` 跳回主窗 | `lightbox-window-open` IPC（105982–106045） |

### 2.2 对照旧版 02 篇 §2 的差异

- 02 篇 §2.1 的 8 入口表方向全对；v0.0.990 **新增 minesweeper 4 窗与 more-menu 面板**（02 篇无）。
- 主窗红绿灯从可见改为 **(-100,-100) 隐藏 + 自绘窗控**（preload `windowControls` 族配套）；settings/share 用 (20,20)/(20,18) 可见红绿灯。
- `webviewTag:!0` 只在主窗开（104306）——iab（应用内浏览器）的 guest page 就挂在主窗。
- 所有窗口创建后 `did-finish-load` 统一调 `RP(win)` 挂 **electron-liquid-glass**（`addView` 玻璃材质；win98/winxp/longhorn 主题下 `wD()` 返回 true 时跳过，`roundedCorners:!isLiquidGlass` 降级，103922–1039xx）。
- `notifications.html` 仍是 toast fallback 路径，但首选已换成原生 NSPanel addon（见 §2.5）。

### 2.3 窗口间 IPC 模式（复刻规格）

- 全部经主进程转发，不存在窗口直连。统一约定：`ipcMain.handle("域:动作", …)` 返回 `"opened"|"focused"|"failed"|"sent"|"navigated"` 字符串；主→渲染用 `webContents.send("领域-事件", payload)`。
- 「跳回主窗打开某 thread」是统一模式：gallery/lightbox/livecoding/settings 的 `*-navigate-to-thread` handler 都是 `关己窗 → DP.show()+focus() → DP.send("navigate-to-thread", threadId)`（如 105900–105912）。
- 请求-响应跨窗异步：`window-capture:result` 用 `requestId → {resolve,reject,timer}` pending map（107481–107489）。
- 每窗挂 `fD(win)` 右键菜单（Open Link / Copy Link / Cut/Copy/Paste/Select All，104152–104201）。

### 2.4 notifications.html 与 alma-notifications 原生模块

`class Bi`（10404）双轨：

1. **首选：原生 NSPanel addon** `alma-notifications`——`package.json:84` 声明为本地 file 依赖 `"alma-notifications": "file:electron/native/alma-notifications"`，主进程 `createRequire` 加载（`Li()`，10057–10063，macOS only），暴露 `toastTemplatePath/defaultIconDataUrl/setEventCallback/prewarm`（10072–10086 使用点）。可用 `ALMA_NATIVE_NOTIFICATIONS=0` 强制关闭（10423）。
2. **fallback：BrowserWindow 加载 notifications.html**（10610–10611），窗 400×320 无边框不可动（10571–10580），带队列（`queue`/`active`/`pump`，10534–10547）、stacking、CTA 按钮、空闲销毁定时器。

## 3. preload bridge 完整 API 表

### 3.1 总览

`/tmp/alma-extract/asar/out/preload/index.js`（单行压缩，22,720 字符）已全读。`contextBridge.exposeInMainWorld` 共 **44 个全局名**（41 个 namespace 对象 + 3 个直接函数）。文件开头还有一段独立逻辑：监听主进程 `telegram-decode-audio`，用 `AudioContext({sampleRate:16e3}).decodeAudioData` 在 renderer 侧解码语音，PCM 经 `telegram-decode-audio-result` 回传。

桥的设计哲学不变：**renderer 的业务全部走 HTTP `http://127.0.0.1:<port>`（端口由 `apiServer.getInfo()` 拿，返回 `{port, baseURL}`，`main.readable.js:104583–104587`），桥只管桌面壳能力**。注意 `api-server-info` 返回值**没有 token**——loopback HTTP 面无鉴权（旧版 02 篇 §3.3 的推测被证伪，见 §6.4）。

### 3.2 全量清单（按域分组；方法名照抄 bundle）

**壳与窗口**

| namespace | 方法 |
|---|---|
| `ipcRenderer` | `on, off, send, invoke`（裸通道转发，最后兜底手段） |
| `windowControls` | `minimize, maximize, fullscreen, close, isMaximized, isFullScreen, isFocused, setTrafficLightsVisible, syncSquareCorners, onFocusChange` |
| `platform` | `get` |
| `apiServer` | `getInfo` → `{port, baseURL}` |
| `settingsWindow` | `open, close, getInitialTab, onTabChange, navigateToThread` |
| `quickChatWindow` | `toggle, close, hide, expand, updateShortcut, initializeShortcut, onFocusInput, setClickThrough, getClickThrough, onClickThroughChanged, onNeedsAccessibilityPermission, onFrontAppContext, onTraversedContent, onAppIcon, getCachedContext, recaptureContext, getFrontAppContext, traverseApp` |
| `moreMenu` | `open, close, cancelClose, scheduleClose, reportSize, emit, prewarm, onSetAnchor, onHide, onShowInApp, onHideInApp, onAction, onState` |
| `minesweeperWindow` | `open, minimize, openHelp, closeHelp, openScores, closeScores, resizeHelp, resizeScores, openRecord, closeRecord, resizeRecord, close, resize` |
| `galleryWindow` | `open, close, navigateToThread, onNavigateToImage` |
| `lightboxWindow` | `open, getInitialParams, close, navigateToThread, editImageInThread, onUpdate` |
| `liveCodingWindow` | `open, close, getPendingCode, sendToChat, onCodeReceived, onShareCodeReceived` |
| `promptAppRunner` | `open, close, getPromptApp, navigateToThread, saveWindowSize, registerShortcut, unregisterShortcut` |
| `almaApp` | `getInfo, checkForUpdates, getUpdateInfo, downloadUpdate, quitAndInstall, onAutoUpdateStatus, setAutoStart, getAutoStart, setDockVisibility, setAppIcon` |

**iab / 浏览器**

| namespace | 方法 |
|---|---|
| `almaIab` | `register, unregister, startInspect, stopInspect, onElementPicked, highlightElement, highlightRegion, clearHighlight, pipShow, pipHide, pipStatus, onOpenTab, reportBrowserVisible` |
| `almaBrowserProfile` | `list, import` |
| `webSearch` | `openDebugWindow, openXiaohongshuDebugWindow, exportXiaohongshuCookies, importXiaohongshuCookies, clearXiaohongshuCookies` |
| `webFetch` | `openBrowser` |
| `playwright` | `getStatus, install, onStatusChange` |

**系统能力**

| namespace | 方法 |
|---|---|
| `permissions` | `getAll, request, openSettings, onStatusChanged` |
| `accessibility` | `getStatus, triggerSystemPrompt, openSettings, startFlow, closeOverlay, onStatusChanged, startDrag, revealInFinder` |
| `systemFile` | `openInPreview, openExternal, showItemInFolder, readAsDataUrl` |
| `electronClipboard` | `writeText, readText, writeImage, write` |
| `selectDirectory` | （直接函数）`() => invoke("select-directory")` |
| `getPathForFile` | （直接函数）`f => webUtils.getPathForFile(f)` |
| `selectAndReadFile` | （直接函数）`f => invoke("select-and-read-file", f)` |
| `appshots` | `getState, setHotkey, captureNow, prewarm, onStarting, onFired, onFailed, onContextUpdate` |
| `windowCapture` | `begin, capturePage, copyImage, saveImage, pickWallpaper, getWallpaper, clearWallpaper, onCaptureRequest, sendResult` |
| `snapshot` | `create, snapshotFile, list, get, diff, rollback, rollbackFile, cleanup`（工作区快照） |
| `whisper` | `getStatus, initialize, transcribe, dispose, getMicrophoneStatus, requestMicrophonePermission, openMicrophoneSettings` |

**账户 / OAuth**

| namespace | 方法 |
|---|---|
| `copilot` | `getAuthMessage, getCopilotToken, saveCopilotToken, getToken, getTokenForAccount, logout, getUser, isAuthenticated, listAccounts, removeAccount` |
| `claudeSubscription` | `getAuthUrl, startAuthorization, completeAuthorization, cancelAuthorization, authorize, getAccessToken, refreshTokens, isAuthenticated, isTokenValid, logout, getModels, getUserProfile, getQuota, getCliStatus` |
| `mcpOAuth` | `getStatus, startAuth, revoke, onAuthCallback, onNeedsReauth` |

**插件宿主 UI（9 个，全部是「主进程事件 → renderer 弹 UI → respond 回传」成对协议）**

| namespace | 方法 |
|---|---|
| `pluginCommands` | `getAll, execute` |
| `pluginTheme` | `onApply, onClear` |
| `pluginStatusBar` | `onUpdate, getState, executeCommand` |
| `pluginInputBox` | `onShow, onDismiss, respond` |
| `pluginQuickPick` | `onShow, onDismiss, respond` |
| `pluginConfirmDialog` | `onShow, onDismiss, respond` |
| `pluginNotification` | `onShow` |
| `toolApprovalDialog` | `onShow, onResolved, respond, getPending`（危险工具审批对话框；`getPending` 用于刷新后恢复） |
| `userQuestionDialog` | `onShow, onResolved, respond` |

**通知**

| namespace | 方法 |
|---|---|
| `almaNotifications` | `notify, clearAll, test, setTheme` |
| `notificationWindow` | `onShow, onQueueChanged, sendDismiss, sendClearAll, sendClick, sendAction, sendPresented, setClickThrough, onTheme, getTheme` |

### 3.3 对照旧版 02 篇 §3

- 02 篇估计「约 10 个 namespace、惯用名 `window.alma`」——实际 **44 个细粒度 namespace、无统一总对象**。
- 02 篇 §3.3 推测的 `server:get-port / get-auth-token`、`deep-link:on-navigate` 通道**不存在**：端口走 `api-server-info`，无 token；`alma://` 未注册 OS 协议（§1.1 #2）。
- 新增面：plugin\* 9 族、copilot/claudeSubscription/mcpOAuth OAuth 三族、whisper、snapshot、appshots/windowCapture 双截屏族、minesweeper、quickChatWindow 的「前屏应用上下文」（`getFrontAppContext/traverseApp/onTraversedContent`——quick chat 会抓前台 app 内容做上下文）。

## 4. 前端架构增量

### 4.1 chunk 结构（`out/renderer/assets/` 共 464 个文件，`ls` 实测）

1. **入口 chunk**（每 HTML 一个）：`index-DuFkWvFz.js`（主窗，约 3.35MB，assets 内最大 JS）、`settings-CfrIFK_9.js`、`notifications-4kmxT74W.js`、`lightbox-C5JBneTe.js`、`livecoding-CkwV5FAd.js`、`gallery-BWOiS50r.js`、`share-CACbXHb9.js`、`prompt-app-runner-CkN4DYJu.js`。共享 runtime chunk `x-BaEJy01I.js`（React/路由等），共享样式 `x-CP0UZUh4.css`。
2. **功能 chunk**：`ThemeContext-1SIJvfGj.js`、`ConditionalPostHogProvider-Bc5tswNf.js`（遥测）、`PlatformContext-icRIjrfj.js`、`useLiveCoding-BhFtXJ9U.js`、`ExecutionHistory-Dv1SiRFf.js`、`ttsPlayer-BQw0J4-C.js`、`TwemojiIcon-DA2ZPZ_r.js`、`provider-icon-data-CvD138G_.js`、`PdfPreview/ExcelPreview/AudioPreview/…`（文件预览族）、`MermaidRenderer` 等 artifact 渲染器族。
3. **Shiki 按需加载**：约 200 个 per-language chunk（`abap-*.js`…`wolfram-*.js`）+ 约 40 个主题 chunk（`catppuccin-mocha-*.js`、`github-dark-*.js`…），代码高亮按需动态 import。
4. **Mermaid 图类型**：`classDiagram/sequenceDiagram/flowDiagram/erDiagram/ganttDiagram/c4Diagram/…` + `cytoscape.esm-*.js`、`dagre-*.js`、`cose-bilkent-*.js` 布局引擎。
5. 另：`mermaid-NA5CF7SZ-*.js` 是 beautiful-mermaid；`index-Co6p3oMd.js`、`index-DTSZ8san.js` 等是被多入口共享的子图 chunk。

### 4.2 关键新页面功能（chunk 字符串佐证）

- **livecoding**（`livecoding-CkwV5FAd.js`，226KB）：启动即 `window.liveCodingWindow.getPendingCode()` 拿主进程暂存的代码；编辑器是 CodeMirror（依赖 `@uiw/react-codemirror` + `@codemirror/lang-javascript`）；有「Playing...」播放态、BPM 滑杆（`handleBpmChange`）——结合 `@strudel/web`、`tone` 依赖与 useLiveCoding 共享 hook，livecoding 页同时承担**代码实时执行预览与 Strudel 音乐 livecoding**；`sendToChat` 把编辑器当前内容发回主窗（`livecoding-share-code`）。
- **prompt-app-runner**（`prompt-app-runner-CkN4DYJu.js`，55KB）：`placeholder`/`Placeholders` 高频——渲染 prompt app 的**占位符表单**，填完经 HTTP `POST /api/prompt-apps/:id/execute` 建 thread；引 `ExecutionHistory` chunk 显示历史执行记录（对应 `prompt_app_executions` 表）。
- **gallery**（`gallery-BWOiS50r.js`，48KB）：**瀑布流用 masonic**（`useMasonry/MasonryScroller` 就在 chunk 内）；分页 `PAGE_SIZE = 30`，数据走 HTTP：`GET /api/gallery/images?limit=30&offset=N`、单图 `GET /api/gallery/images/<imageId>` 取 `{url}`（chunk 原文）。

### 4.3 流式渲染与虚拟列表（对照旧版 01 篇 §7 三红线）

- **红线①（delta + seq 重组 accumulator）**：仍成立。主 chunk 内有 accumulator 类，状态形状 `{parentMessageId, parentToolCallId, subagentMessageId, lastSeq: 0, pendingDeltas: [], isStreaming: true}`，delta case 清单 `text_append / text_done / part_add / part_update / tool_input_delta（part.input[key] += text）/ tool_output_set`——与 17 篇 WS 章的 `message_delta` 7 种 part-diff 对得上。
- **红线②（虚拟化）**：**结论修正——聊天消息列表仍是 react-virtuoso**。主 chunk 有 `virtuosoRef` + `scrollToIndex({index:"LAST", align:"end"})` 的聊天滚底逻辑、virtuoso 的 `virtuoso-scroller/virtuoso-item-list` DOM class 与日志器。**`@tanstack/react-virtual` 的 6 处 `useVirtualizer` 全部用在别处**：代码块行虚拟化（`estimateSize: () => LINE_HEIGHT, overscan: 5/10`）、**会话侧栏列表**（`estimateSize: () => 64, overscan: 8`，以 thread id 作 stable key）、分组列表（`group-header` 动态 estimateSize）等。gallery 瀑布流用 **masonic**。`virtua` 包在依赖里但只在 mermaid chunk 中有一处命中（疑为传递依赖），未作列表主路径。
- **红线③（Streamdown 分块 memo）**：仍在。`data-streamdown` 标志命中主 chunk 与 `code-block-*.js`、`mermaid-*.js`、`x-*.js`；`react-markdown` 也在依赖中（两套并用）。

### 4.4 主题系统

三层主题源，**汇聚点是 renderer 的 `ThemeContext` chunk**（`ThemeContext-1SIJvfGj.js`，未压缩、注释完整）：

1. **内置 base46 主题**（tinted-theming 体系）：应用时 `document.documentElement.setAttribute("data-base46-theme", themeName)`（chunk 内 `setActiveThemeAttribute` 原文），CSS 按该属性选择器生效；语法高亮色经 `applySyntaxCSSVariables(vars)` 逐个 `root.style.setProperty` 注入。
2. **custom-themes（用户主题）**：`custom_themes` 表存 base30/base16 调色板（`main.readable.js:1356`，SQL 2820）；`ThemeContext` 里 `useCustomThemes()` 拉 `/api/custom-themes`、按 id 取 `/api/custom-themes/${id}`（chunk 内 fetch 字符串实证）。
3. **plugin-themes（插件主题）**：插件 manifest `contributes.themes[].colors` 经主进程 `MI()` 展开成完整 shadcn token 集（缺省抄 Catppuccin）；`ThemeContext` 调 `POST /api/plugin-themes/<id>/apply` / `GET /api/plugin-themes/clear`（chunk 实证），主进程广播 `plugin_theme_applied`（99789），preload `pluginTheme.onApply/onClear` 推给各窗。

**FOUC 防护**（8 个 html 入口的 `<head>` 内联脚本原文）：React 挂载前同步回放 `localStorage["alma:appearance-cache"]`——依次 `root.classList.add(mode)`、`data-ui-density`、`data-base46-theme`、逐条 `root.style.setProperty(key, value)`。缓存由 `ThemeContext` 在主题稳定后写入（`APPEARANCE_CACHE_KEY = "alma:appearance-cache"` 常量就在 chunk 里，注释写明「key must stay in sync」）。缓存的 token 集：`--background/--foreground/--card/--popover/--primary/--secondary/--muted/--accent/--destructive/--border/--ring` + 对应 `-foreground` + `--ui-root-font-size`。

**win98 彩蛋主题**：`themeConfig.lightTheme/darkTheme ∈ {win98, winxp, longhorn, longhorn-dark}` 时 `wD()` 为真（104222–104229），主进程跳过 liquid-glass、关圆角；win98 还默认开鼠标拖尾（`themeConfig.win98Trail !== false`，104341–104346）。

## 5. 自动更新与打包

### 5.1 electron-updater 集成（实证）

- feed 不变，`/Applications/Alma.app/Contents/Resources/app-update.yml` 原文：
  ```yaml
  provider: generic
  url: https://updates.alma.now/
  useMultipleRangeRequest: false
  updaterCacheDirName: alma-updater
  ```
- 集成代码在 `main.readable.js:107519–107660`：`wa()` 判断可用性（不满足则记 `Skipping auto-update initialization` 并跳过）；`autoDownload:!1, autoInstallOnAppQuit:!0`（107524–107525）；事件链 `checking-for-update / update-available / update-not-available / download-progress / update-downloaded / error` 全部经 `ga()` 广播给 renderer（对应 preload `almaApp.onAutoUpdateStatus`）；代理登录事件回填 proxy 凭据（107530–107535）。
- **节奏**：启动 3s 后首查（107609–107613），之后每 30min（`18e5`，107614–107618）轮询。
- **差分更新预热**：60s 后在 mac 上预下载 `<name>-<ver>-mac-<arch>.zip` 到 updater 缓存目录（107619–107658），让下次真更新走差分（`download-progress` 里检测 `total < 0.9 * 全量` 时记「Differential download detected」，107569–107576）。

### 5.2 asar 完整性校验

`Info.plist` 的 `ElectronAsarIntegrity`（PlistBuddy 实测）：

```
Dict {
    Resources/app.asar = Dict {
        hash = 9e74969b965c29f09b066b521bc513ba0541305ed6c74b0303de2e068db2aec6
        algorithm = SHA256
    }
}
```

Electron 运行时按它校验 asar 未被篡改（electron-builder 的 `electronAsarIntegrity` 默认开启）。复刻启示：**不要依赖改 asar 打补丁**，任何 post-build 修改都得同步重算这个 hash，否则直接拒启动。

### 5.3 `onlyBuiltDependencies` 与原生模块

`asar/package.json:17–26` 原文：

```json
"pnpm": {
  "onlyBuiltDependencies": [
    "@tailwindcss/oxide", "bufferutil", "electron", "esbuild",
    "utf-8-validate", "better-sqlite3", "alma-notifications"
  ],
  "overrides": { "node-abi": "^4.24.0", "@strudel/core": "1.2.6" }
}
```

- **`alma-notifications`**（`package.json:84`：`file:electron/native/alma-notifications`）：**仓库内自研的 macOS 原生通知 addon**——NSPanel 承载 toast，暴露 `toastTemplatePath`（html 模板）/`defaultIconDataUrl`/`setEventCallback`/`prewarm`（bundle 使用点 10057–10086）。它就是 02 篇 §5.2 看到的 `node_modules/alma-notifications/assets/toast.html` 的本体：模板 html 随包分发，addon 负责窗口与事件。进 onlyBuiltDependencies 说明它有 node-gyp 构建步骤（Node-API 原生模块）。
- 名单里其余 6 个是常规原生/构建型依赖：`better-sqlite3`（DB）、`bufferutil`/`utf-8-validate`（ws 的性能扩展）、`@tailwindcss/oxide`（Tailwind v4 原生扫描器）、`esbuild`、`electron`（postinstall 下载二进制）。
- **不在名单里的原生物**：`sherpa-onnx-node`、`@fugood/whisper.node`、`node-pty`、`sqlite-vec`、`electron-liquid-glass`、`font-list`——它们以 prebuild/dylib 形式分发，走 asarUnpack 而不是 install 脚本。复刻时两类都要照顾：构建型进 `onlyBuiltDependencies`，prebuild 型进 `asarUnpack`。

## 6. 安全模型

### 6.1 safeStorage 用途（全部调用点已核实）

`safeStorage`（import 于 `main.readable.js:43`）**不用于 LLM provider API key**（grep `apiKey` 周边无任何 encrypt/decrypt 调用；providers 表的 key 在 bundle 中无加密证据）。四处真实用途：

| 用途 | 位置 | 机制 |
|---|---|---|
| Copilot 账号 token | 21560–21603 | `<accountsDir>/<login>.token` 文件，`isEncryptionAvailable() ? encryptString : 明文 utf8` 降级；含 legacy 单 token 文件自动迁移 |
| Claude 订阅 OAuth token | 22443–22479 | `tokenFilePath` 存 JSON 序列化的 tokens，同样 safeStorage/明文降级 |
| MCP OAuth codeVerifier 等 | 35606–35620 | `encryptString(e).toString("base64")` / 解密回落 base64 明文 |
| 插件 secrets | 50100–50155 | 插件上下文 `secrets` API，格式标记 `"alma-safestorage-v1"`，文件 0600，启动时明文自动迁移为密文 |

统一模式：`isEncryptionAvailable()` 判断 → 不可用则明文/弱编码降级 + warn 日志。macOS 上 safeStorage 走 Keychain，「可用」基本恒真；降级路径是给 Linux（无 keyring）准备的。

### 6.2 CSP / webSecurity / webview

- 8 个 html 入口**均无 CSP meta**（grep `Content-Security-Policy` 零命中）；bundle 中无 `session.defaultSession.webRequest` 改 CSP 的代码。**v0.0.990 没有 CSP**。
- 所有 BrowserWindow 的 webPreferences 统一：`nodeIntegration:!1, contextIsolation:!0, devTools:!n.isPackaged`（如 104301–104307、104112–104117）——renderer 零特权 + 生产关 DevTools。未显式设置 `sandbox`（Electron 默认对无 nodeIntegration 的 renderer 已隔离，但复刻建议显式 `sandbox:true`）；未动 `webSecurity`（保持默认开）。
- 主窗 `webviewTag:!0`（104306）——`<webview>` 是 webSecurity 的例外面，iab 靠它挂任意外部页面；其安全边界靠主进程 CDP 管控（iab 的 debugger attach、dialog 自动关闭都在主进程侧，见 17 篇）。

### 6.3 Info.plist 网络例外（实测原文）

```
NSAppTransportSecurity = Dict {
    NSAllowsArbitraryLoads = true        # 全局放开 ATS
    NSAllowsLocalNetworking = true
    NSExceptionDomains = Dict {
        127.0.0.1 / localhost = Dict {
            NSTemporaryExceptionAllowsInsecureHTTPLoads = true
            NSTemporaryExceptionRequiresForwardSecrecy = false
            NSTemporaryExceptionMinimumTLSVersion = 1.0
            …
        }
    }
}
```

含义：ATS 全局关闭（`NSAllowsArbitraryLoads`），另对 loopback 两域名显式允许明文 HTTP。这是「内嵌 HTTP 服务 + webview/iab 要加载任意外部 http 站点 + mobile-relay 回环 fetch」的必然结果——**网络层零约束，安全责任全部上移到应用层**（绑定 127.0.0.1、chrome-relay token、PTC 会话 token）。

### 6.4 对照旧版 02 篇 §7 的修正

- 02 篇「本地服务几乎必有 loopback token【推测，置信度高】」**被证伪**：`api-server-info` 只返回 `{port, baseURL}`（104583–104587）；bundle 中对本地 API 无 Authorization/x-api-key 校验。防线只有两条：**绑 127.0.0.1**（`server.listen(port, "127.0.0.1")`，93833）+ 端口冲突时随机避让。chrome-relay WS 有 token（`close(4001,"Invalid token")`）是例外而非通则。
- 复刻结论不变且更硬：**任意网页 JS 都能 POST `http://127.0.0.1:23001/api/...`**（浏览器不拦 loopback fetch，DNS rebinding 也可绕），复刻必须补 token（preload 注入 + 自定义 header），02 篇 §9.5 的写法直接可用。

## 7. 复刻要点（对照旧版 02 篇 §8 的更新版）

### 7.1 Electron 壳最小清单（v0.0.990 实证版）

按「照抄即可跑」的优先级：

1. **启动序列**（照抄 §1.1）：单实例锁 → Sentry（可选）→ whenReady → permission handler（只放行 media/mic/audio）→ fix-path → 通知管理器 → CLI wrapper 落盘 → **APIServer 重试 3 次、失败弹错退出** → dock/外观 → 主窗 → Tray → 快捷键 → updater → 后台重活（Playwright/插件/技能全 setImmediate 后台化）。
2. **端口**：默认固定端口 + TCP 双栈（127.0.0.1 + ::1）探测递增避让（93676–93699）→ 实际端口写 `process.env` + 经 `api-server-info` IPC 给 renderer。**加 token**（Alma 没有，这是它的真实攻击面）。
3. **窗口**：主窗 + settings 两个起步；新增窗口 = 「loadFile 对应 html + Map 单例/新建 + ready-to-show show + did-finish-load 挂玻璃」的复制模式。瞬态小窗（share/lightbox）用「主进程暂存 payload + renderer ready 回拉」模式，不要在 URL 里塞大对象。
4. **preload**：按域拆细粒度 namespace（Alma 44 个），每个方法就是一行 `ipcRenderer.invoke("域:动作")`；主→渲染事件统一 `on<Event>` 订阅返回取消函数。业务一律 HTTP。
5. **崩溃守护**：render-process-gone 2s 重建主窗、Network Service 300s×3 才 relaunch、main-crash.log 落盘（§1.3）。
6. **更新**：generic feed 4 行 yml + `autoDownload:false`（让用户看见进度）+ 30min 轮询 + 60s 预下载预热差分缓存（§5.1）。
7. **打包**：`ElectronAsarIntegrity` 默认开着，别指望改 asar 打补丁；构建型原生依赖进 `onlyBuiltDependencies`，prebuild/dylib/wasm 进 `asarUnpack`；sidecar 平铺 `Resources/`（这条 02 篇已说，仍然成立）。

### 7.2 相对 02 篇 §8.2 的增量坑

1. **`webviewTag:!0` 只开主窗**：iab 依赖它，但它是最大攻击面，别的窗口别开。
2. **无 CSP 是 Alma 的现状不是榜样**：复刻至少给 `default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*`。
3. **fix-path 必装且要验证**：PATH 没变化时 Alma 自己都会 warn「command not found」风险（106969–106972）——macOS GUI 应用 PATH 不含 homebrew，CLI 集成全靠它。
4. **红绿灯 (-100,-100) 隐藏 + 自绘窗控** 是当前风格；配套 `windowControls` 桥 + `onFocusChange` 事件，别再依赖系统红绿灯布局。
5. **通知双轨**：原生 addon（NSPanel）优先、html 窗 fallback，env 开关降级——比纯 html toast 稳，但要多维护一个 node-gyp 模块。
6. **safeStorage 四用途清单**（§6.1）可直接照抄成复刻的 secrets 层：统一 `isEncryptionAvailable()` 降级 + 明文自动迁移。API key  Alma 没加密——复刻时建议连 provider key 也走 safeStorage 或 AES（Eva 已做 AES-256-GCM，比 Alma 严格）。

---

> 本篇证据边界：preload 44 个 namespace 为全读结果；窗口参数、启动序列、updater、safeStorage、plist 均逐处 grep/Read 核实；前端 chunk 结论基于文件名 + chunk 内字符串 grep（renderer 未做全量反混淆精读）；livecoding 的 Strudel 音乐面为依赖 + chunk 字符串的推断（`@strudel/web`/`tone`/BPM 滑杆），置信度中高。
