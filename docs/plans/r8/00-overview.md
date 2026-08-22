# R8 · 桌面化补完（S11，优先于 S19，用户指定：找工作演示向）

> 承接 `../r7/00-overview.md`（S18 审批中心已收口并 commit）。本轮把 S11 从「S0 地基 + T11 打包」推到「产品化周边」。
> **顺序调整**：原计划 `S18→S19→S7→…`，用户指定桌面化优先（找工作演示价值最高），故 S11 提前到 S19 之前。S19/S7 顺延。
> 前置阅读：`docs/architecture/02-electron-desktop.md`（§4/§6/§8/§9 施工图）+ `21-alma-v2-frontend-desktop.md`（§1 启动序列 / §5 更新打包 / §6 安全）+ `15-eva-execution-playbook.md` §S11（**最新任务定义，覆盖 11 §5**）。

## 0. 交叉验证结论（动手前先读）

### 0.1 文档清单（桌面化不止两篇）

- **核心**：02（Electron 桌面端，施工图 §9）+ 21（Alma v2 实证修订，启动/更新/打包/安全）。
- **Eva 自身权威**：`14-eva-architecture.md` §9（桌面壳现状+目标）、`15-eva-execution-playbook.md` §S11（**最新定义，以它为准**）。
- **任务定义**：`11-landing-plan.md` §5 S11（**已过时**，见 §0.2 #1）。
- **施工记录**：`docs/plans/r3/T11-packaging.md`（打包链唯一完整记录）、r2/T6（pickDirectory IPC）、r2/T10（品牌残留）、r5/T19（safeStorage 决策）。

### 0.2 真实矛盾（不是表述差异）

1. **协议名 + 范围**：11 §5 写「`myagent://` + WS 全双工改造」；15 §S11 改 `eva://`、**删 WS 改造**、加「安全收口」。→ 以 15 为准，**就地修订 11**。
2. **CSP 落地位置（真矛盾，改架构）**：02 §9.1/§9.3 假设 renderer 是 electron-vite 多 HTML（`loadFile`），CSP 进 `<head>` meta。**Eva renderer 不进 asar**——`apps/web/dist` 由 server 的 `@fastify/static`（`static.ts`）HTTP 托管，desktop 全程 `loadURL("http://127.0.0.1:<port>")`，**没有 HTML 文件可插 meta** → CSP 只能走 `static.ts` **HTTP 响应头**。
3. **loopback token 缺接收方基建（不能照抄 02 §9.5）**：02 是 Express 中间件；Eva 是 **Fastify**，用 `onRequest` hook。且 renderer 现在纯浏览器打开 `127.0.0.1`，所有 fetch/SSE 得带自定义 header——`shared/api/fetch.ts` + `run-stream-client.ts`（3 个 `fetch`，`:241/:290/:310`）都要改。
4. **asarUnpack 对 Eva 基本不适用**：02 §9.7 说 `.node/.dylib/.wasm` 进 asarUnpack。Eva 的 `better-sqlite3` 经 `pnpm deploy`+`flatten:deps`+`electron-rebuild` 落到 `Resources/server/node_modules`（extraResources，**不在 asar**）。真正要确认的是 rebuild 后 `.node` 在 extraResources 里能被 require（T11 已验证）。
5. **单实例锁已完成**（T11 Step 6，`main.ts:408`），11 §5 还列为待办——状态过时。

### 0.3 现状（探查证实）

- **已落地**：utilityProcess fork server、动态端口、健康探测、shell-env、系统代理、单实例锁、`pnpm deploy→flatten→rebuild→electron-builder` 打包链（dmg 可装）。
- **零代码**：托盘、菜单、自启动、`eva://` 深链、CSP、loopback token、窗口状态记忆、desktop 测试。打包仅 mac arm64 dmg，无签名/公证。
- **死代码**：`main.ts` 的 `isQuitting` 设了从未读（T32 顺手收）。
- **dev 断层**：`desktop:dev` 不自动拉起 web/server（`concurrently`/`wait-on` 装了没用）。

## 1. 本轮要解决的问题

主链路（fork server + 打包）已通，但**产品化周边全是零**。找工作演示需要的是「能看出来是个桌面 App」：托盘、全局唤起、深链、能自己更新。安全收口（CSP+token）是 02 §8.2 反复强调的「复刻必抄」。

## 2. R8 范围与顺序

| 任务 | 文档 | 内容 | 估时 | 依赖 |
|---|---|---|---|---|
| **T32** | `T32-system-integration.md` | 系统集成：托盘 + Alt+Space 全局唤起 + `eva://` 深链 + 窗口状态记忆 + 自启动开关 + 清 `isQuitting` 死码 | 1 天 | — |
| **T33** | `T33-security-hardening.md` | 安全收口：CSP 响应头（static.ts）+ loopback token（main 生成→env 传 server→preload 注入 renderer→fetch/SSE 带 header） | 1–1.5 天 | — |
| **T34** | `T34-auto-updater.md` | electron-updater 完整链路：generic/GitHub feed + 事件广播 + 确认安装 UI + Developer ID 签名 + notarize | 1–2 天 | —（签名/公证要 Apple 账号） |
| **T35** | `T35-dev-bootstrap.md` | dev 一键拉起：`concurrently`+`wait-on` 串起 server+web+desktop | 0.5 天 | — |

**顺序**：T32（可演示，最快出成果）→ T33（安全闭环）→ T34（要 Apple 账号，最重）→ T35（随时穿插）。T33/T35 无依赖可与 T32 并行，但串行最稳。

**展示优先级**：T32 > T34 > T33 > T35。T32 是「一眼看到桌面化」的，T33 是「面试能讲安全模型」的。

## 3. 执行契约

1. **Eva 的 renderer 是 HTTP 托管，不是 electron-vite 多 HTML**。任何要「改 renderer HTML / 插 meta」的 02 骨架都要翻译成「改 server 响应头 / desktop main」。
2. **桌面壳能力走 IPC（contextBridge），业务走 HTTP**（02 §3.2 最值得抄的一条，已是 Eva 现状）。新增的「窗口状态/自启动/updater 状态」这类壳状态走 IPC，别往 server 塞。
3. **安全面三红线不破**：`contextIsolation:true` / `nodeIntegration:false` 保持；CSP 至少 `default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*`（21 §7.2 #2）；token 走自定义 header 不走 query。
4. **mac arm64 only**（11 §0 决策）：不做 win/linux target，不签名的坑（updater 静默失败）要写进文档提醒。

## 4. 决策记录

### 4.1 为什么 CSP 走响应头不走 meta

Eva renderer 由 server HTTP 托管，没有静态 HTML 文件落盘可插 meta。`@fastify/static` 支持 `setHeaders`，SPA fallback 的 `sendFile` 也能加头。CSP 是响应级策略，HTTP 头与 meta 等价，头更集中（一处设，全部入口生效）。

### 4.2 为什么 token 要 server 参与生成而不只 main 持有

main fork server 时经 env 把 token 传给 server；server 的 `onRequest` hook 校验。renderer 启动经 `api-server-info` IPC 向 main 拿 token 注入 fetch/SSE。三方（main 生成 / server 校验 / renderer 持有）缺一不可——只 main 生成不传给 server，server 没法校验；只 server 生成 main 不知道，没法经 preload 给 renderer。dev 态（外部 server）token 可空（hook 跳过），不挡浏览器调试。

### 4.3 为什么 updater 单独成 T34 而非并进 T32

完整更新链路 = 签名 + 公证 + feed 托管 + 事件 UI，要 Apple Developer 账号和证书，是「外部分发」复杂度，与「本地桌面集成」（T32）不同质。分开让 T32 能独立演示。

## 5. 验收总表

| 任务 | 一句话验收 |
|---|---|
| T32 | 托盘图标常驻、Alt+Space 唤起/隐藏主窗、`eva://thread/xxx` 跳转对应会话、重启后窗口位置尺寸还原、设置页有自启动开关、第二次启动聚焦已有窗口 |
| T33 | `curl -I http://127.0.0.1:<port>/` 见 CSP 头；无 token 的 `curl -X POST /api/v1/runs/stream` 返 401；桌面内 fetch/SSE 正常（带 token） |
| T34 | 签名+公证的 dmg 装后能 `checkForUpdates` 拉到新版本、`update-downloaded` 后确认 `quitAndInstall` 生效 |
| T35 | `pnpm desktop:dev` 一条命令拉起 server+web+desktop，无需另开终端 |

S11 全绿 = T32–T35 全绿 + 15 §S11 验收过。
