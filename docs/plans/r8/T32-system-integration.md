# T32 · 系统集成：托盘 + 全局唤起 + 深链 + 窗口状态记忆 + 自启动

> 前置阅读：`../r8/00-overview.md` §0.2/§3（契约）；`docs/architecture/02 §9.8`（深链/托盘/快捷键施工骨架）+ `21 §1.1/§1.3`（启动序列、Tray 实证）+ `15 §S11-2`。
> 本卡全是 `apps/desktop/electron/main.ts`（480 行）+ `preload.ts`（13 行）的增量，不动 server/web。单实例锁已完成（`main.ts:408`），不重做。

## 1. 问题

主链路能跑，但「一眼看出是桌面 App」的周边全是零：托盘、全局唤起、深链、窗口状态记忆、自启动都没有。另有死代码 `isQuitting`（`main.ts:25,478` 设了从未读）。

## 2. 改动

### 2.1 托盘 Tray

`main.ts` whenReady 内（主窗创建后）建 `Tray`：
- 图标 `nativeImage.createFromPath` 读 `build/iconTemplate.png`（mac 16×16 Template Image，自动适配深浅菜单栏；需新增该资源）。
- 菜单：显示主窗 / 设置（先跳到 `/settings`，复用 web 路由，不建独立设置窗）/ 退出（置 `isQuitting=true` 后 `app.quit()`）。
- **退出坑**（02 §9.8）：托盘「退出」必须先把全局 `isQuitting` 置 true，否则触发 `window-all-closed` 的 mac「关窗不退出」逻辑。这条顺带把 `isQuitting` 死码激活——`window-all-closed` 里读它。

### 2.2 全局快捷键（Alt+Space 唤起）

`globalShortcut.register("Alt+Space", …)`：主窗可见且聚焦 → `hide()`，否则 `show()+focus()`。
- **坑**：`register` 返回 false = 热键被占（Alt+Space 是重灾区），要 `console.warn` 降级提示，别假装成功。
- `will-quit` 里 `globalShortcut.unregisterAll()`（死规矩，漏了重装报占用）。
- preload 暴露 `electronAPI.setShortcut(shortcut)` + `getShortcut`？**本卡先做固定 Alt+Space**，可改成设置项留到后续（别过度设计）。

### 2.3 深链 `eva://`

- `registerProtocol`：`app.setAsDefaultProtocolClient("eva")`（mac 靠 Info.plist `CFBundleURLTypes` 声明 + 运行时登记）。**协议名用 `eva`**（对齐 15，废 11 的 `myagent`）。
- `electron-builder.yml` 加 `protocols: [{ name: "Eva", schemes: ["eva"] }]`。
- **mac open-url 坑（02 §9.8）**：`app.on("open-url")` 必须挂在**模块顶层**（open-url 可能早于 ready），`event.preventDefault()` 必调，冷启动等 `whenReady` 后投递。
- 投递：`eva://thread/<id>` → 主窗 `webContents.send("deep-link", url)`；preload 暴露 `onDeepLink(cb)`；web 侧 `chat-page` 监听后 `navigate` 到对应会话（`loadSession(id)`）。
- Windows/桌面 dev 走 `second-instance` 的 argv 兜底（02 §9.2 ①）。

### 2.4 窗口状态记忆

- 主窗 `BrowserWindow` 创建前读 `userData/window-state.json`（`{width,height,x,y,isMaximized}`），`close` 时写回。
- 对齐 21 §2.1 主窗（`window-state.json`，`hD/pD` 实证）。用 `app.getPath("userData")` 定位，别写死路径。

### 2.5 自启动开关

- `app.setLoginItemSettings({ openAtLogin })`（mac）。
- preload 暴露 `electronAPI.getAutoLaunch() / setAutoLaunch(v)`；设置页（web Security 或新 Desktop 卡）加一个开关。**先放 Security 设置页**，不新建面板（对齐 r7 契约「不新建面板」）。

## 3. 涉及文件

修改：`apps/desktop/electron/main.ts`（托盘/快捷键/深链/窗口状态/isQuitting）、`apps/desktop/electron/preload.ts`（暴露 `onDeepLink`/autoLaunch）、`apps/desktop/electron-builder.yml`（protocols）、`apps/web/src/features/threads/chat-page.tsx`（深链监听跳会话）、`apps/web/src/features/settings/components/security-settings.tsx`（自启动开关）。

新增：`apps/desktop/build/iconTemplate.png`（托盘图标）。

不动 server。无 DB 改动。

## 4. 步骤

1. 托盘 + isQuitting 死码激活（最小可见成果）。
2. 全局快捷键（Alt+Space toggle）。
3. 窗口状态记忆。
4. 深链（main 注册 + open-url + preload + web 跳会话）。
5. 自启动开关（main IPC + 设置页）。
6. `pnpm typecheck` + `pnpm desktop:build` 过；手动 `pnpm desktop:dev` 验托盘/快捷键/深链。

## 5. 验收

| # | 验收 | 判定 |
|---|---|---|
| 1 | 托盘图标常驻菜单栏，点「显示主窗」唤出 | 手动 |
| 2 | Alt+Space toggle 主窗显隐；被占时 warn 不崩 | 手动 + 日志 |
| 3 | `open "eva://thread/<id>"`（或点链接）跳到对应会话 | 手动 E2E |
| 4 | 关窗再开，位置/尺寸还原（window-state.json） | 手动 |
| 5 | 托盘「退出」真退出（不卡在 window-all-closed） | 手动 |
| 6 | 设置页自启动开关 toggle 后 `loginItemSettings` 生效 | 手动（重启验证） |

## 6. 坑（按概率）

1. **open-url 早于 ready**：监听挂模块顶层，别塞 whenReady（02 §9.8 强调两次）。
2. **托盘退出触发 mac 关窗不退出**：先置 `isQuitting`。
3. **Alt+Space 被占**：register 返 false 要降级，别静默。
4. **深链别塞大对象进 URL**：只传 threadId，数据 renderer 拉到（21 §2.3「主进程暂存+ready 回拉」同理）。
5. **window-state 的 x/y 在副屏拔了后可能出屏**：恢复前校验坐标在当前显示器内，否则回中（Electron 公知坑）。
