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
| **T32** | `T32-system-integration.md` | 系统集成：托盘 + Alt+Space 全局唤起 + `eva://` 深链 + 窗口状态记忆 + 自启动开关 + 清 `isQuitting` 死码 | 1 天 | ✅ 已落地 |

> **落地记录**：T32 → 未 commit（`main.ts` 一次性补齐四块：窗口状态记忆 `readWindowState`/`writeWindowState`（`userData/window-state.json`，恢复前校验坐标仍在某块屏内防副屏拔掉出屏，最大化存 normal bounds）；托盘 `createTray`（Template 图标 `build/iconTemplate.png`，菜单=显示/设置→`eva://settings` 深链/退出，退出项先置 `isQuitting=true` 再 `app.quit()`，`window-all-closed` 激活 `|| isQuitting` 分支清掉死码）；`globalShortcut.register("Alt+Space", toggle)` 可见且聚焦→hide 否则 show+focus，注册失败 `console.warn` 降级不致命，`will-quit` `unregisterAll`；`eva://` 深链 = builder.yml `protocols` + dev 下 `setAsDefaultProtocolClient("eva", execPath, [argv[1]])` + mac `open-url`（preventDefault 必调，早于 ready 缓存 `pendingDeepLink` 到 did-finish-load 投递）+ win/linux 走 `second-instance` argv 转投；自启动 `auto-launch:get/set` IPC 走 `app.get/setLoginItemSettings`。`preload.ts` 加 `onDeepLink`（返回解绑）/`getAutoLaunch`/`setAutoLaunch`，`vite-env.d.ts` 补类型。web 侧：`chat-page` 加 `onDeepLink` effect（`eva://thread/<id>`→loadSession+setSearchParams，`eva://settings`→navigate）；`security-settings` 加「登录后自动启动」开关（仅 `isElectron()` 显示，OS 级设置不进 app settings DB）。托盘图标用脚本画的 16×16 E 字 Template PNG，正式 logo 后换。）
>
> **验收状态**：`pnpm typecheck` 全绿（desktop/web/server/harness/shared）；`pnpm run build:electron`（electron-vite）过，main.js 14.65 kB 含新代码；`pnpm test` 553 全绿，唯一 error 是基线 `run-detach.test.ts` `ERR_HTTP_HEADERS_SENT` flake（r7 同样注明）。~~**`pnpm desktop:build` 在 `rebuild:native` 步失败**~~ → **已解**（T34 收尾时把 `@electron/rebuild` 3.7.2 升到 4.2.0，Node 26 ESM 坑消失，`desktop:build` 全绿）。**运行时手动验收（托盘点击/Alt+Space 唤起/eva:// 跳转/窗口记忆/自启动）尚未做**，需 `pnpm desktop:dev`（或 `desktop:dev:all`）起 dev 逐项过。
| **T33** | `T33-security-hardening.md` | 安全收口：CSP 响应头（static.ts）+ loopback token（main 生成→env 传 server→preload 注入 renderer→fetch/SSE 带 header） | 1–1.5 天 | ✅ 代码已落地，运行时验收未做 |

> **落地记录**：T33 → 未 commit（CSP：`static.ts` 给 `@fastify/static` 加 `setHeaders` 设 `Content-Security-Policy: default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`，SPA fallback 的 `sendFile` 前 `reply.header` 补同一 CSP；dev 态 vite 5173 托管不经此，只在打包态生效。token：`main.ts` prod 分支 `randomBytes(24).hex` 每次启动重生成（不落盘）、fork server 时 env `EVA_LOOPBACK_TOKEN` 传入、`getServerInfo` IPC 返 `{port, token}`；`app.ts` 加 `onRequest` hook——env 空（dev 外部 server）跳过，非空则除白名单外全量校验 `x-eva-token`，白名单=`/v1/health` + `GET /api/v1/threads` + GET/HEAD 非 `/api/` 静态，`/api/v1/runs/*` 操作面不放行；`preload.ts` 暴露 `getServerInfo`，web 新增 `shared/api/auth.ts`（`getLoopbackToken` 缓存 + `withLoopbackToken` 合并 header），`fetch.ts` 的 `apiFetch` 与 `run-stream-client.ts` 的 3 个 fetch 全改走 `withLoopbackToken`。SSE 用 fetch 能带自定义 header，没动 EventSource。）
>
> **验收状态**：`pnpm typecheck` 全绿；`pnpm test` 553 全绿（同前 flake）——测试直接 `buildApp` 无 env，hook 跳过校验，故无回归。**运行时验收未做**：`curl -I` 见 CSP / 无 token `curl -X POST` 返 401 / 桌面内对话正常，需打包态（或给 dev server 手动设 `EVA_LOOPBACK_TOKEN`）逐项过。
| **T34** | `T34-auto-updater.md` | electron-updater 完整链路：generic/GitHub feed + 事件广播 + 确认安装 UI + Developer ID 签名 + notarize | 1–2 天 | ✅ **端到端闭环**（0.2.4→0.2.5 quitAndInstall 实测通过） |

> **落地记录**：T34 → commit `57f05a8`（新增 `apps/desktop/electron/updater.ts`：`!app.isPackaged` 直接 return（dev 跳过）；`autoDownload:true` + `autoInstallOnAppQuit:false`（别打字时强退）；6 事件 `checking/available/not-available/downloading/downloaded/error` 全 `broadcast` 到所有窗口的 `updater-status` IPC，`error` 必挂（记日志不弹窗防崩主进程）；启动后查一次 + 每 4h `setInterval.unref()` 轮询；导出 `initUpdater/installUpdate(quitAndInstall)/checkForUpdates`。`main.ts` import + whenReady 主窗创建后 `initUpdater()` + `updater:check`/`updater:install` 两个 IPC handler。`preload.ts` 加 `updaterCheck/updaterInstall/onUpdaterStatus`，`vite-env.d.ts` 补类型。web 侧 `security-settings` 的「桌面」section 加更新状态条（6 态文案，`downloaded` 露「重启更新」→`updaterInstall`，`not-available`/`error` 露「重新检查」→`updaterCheck`）。`electron-builder.yml` 加 `publish:{provider:github, owner:dongliang1993, repo:eva}` + mac 段 `hardenedRuntime/gatekeeperAssess:false/entitlements/entitlementsInherit/notarize:true`；新增 `build/entitlements.mac.plist`（allow-jit/allow-unsigned-executable-memory/disable-library-validation——better-sqlite3 .node 需要）。依赖：devDeps+`@electron/notarize`、deps+`electron-updater`。）
>
> **E2E 闭环补记（2026-08-23，commit `57f05a8`）**：端到端跑通 **0.2.4 → 0.2.5** quitAndInstall。期间踩的 3 个坑已详记 `T34-auto-updater.md` §6 坑 10–12：① prerelease 要 `allowPrerelease=true`（默认只认 latest → 406）；② mac target 必须 dmg + zip 都发（zip 才是 quitAndInstall 用的格式，只发 dmg 报 "ZIP file not provided"）；③ **打包前必须重跑 `pnpm web:build`**（否则 web/dist 停在旧 bundle，设置页「重启更新」按钮不显示，但 main/IPC 全对，极易误判）。本轮新增：`updater.ts` 加 `lastStatus` 缓存 + `getUpdaterStatus()` + `restorePendingDownload()`（重启后从 pending 恢复 downloaded 态）；`main.ts` 接 `updater:status` IPC；`security-settings.tsx` 进页先拉缓存态 + 触发检查（修启动时序导致的按钮不显示）。验证：装 0.2.4 → 检测 v0.2.5 → 自动下载 → 设置页点「重启更新」→ `/Applications/Eva.app` 升至 0.2.5。
>
> **验收状态（2026-08-22 打包实测全过）**：`pnpm typecheck` 全绿；`pnpm desktop:build` 全绿（`@electron/rebuild` 升 4.2.0 后 rebuild:native + build:electron 全过）。**签名+公证 dmg 已产出** `release/Eva-0.1.0-arm64.dmg`（205 MB）：`codesign` 证书链 `Developer ID Application → Developer ID Certification Authority → Apple Root CA` 完整、`xcrun stapler validate` = `The validate action worked!`（公证票据已 staple 进 .app）、`spctl -a -vv -t execute` = `accepted / source=Notarized Developer ID`。装到 `/Applications` 双击启动正常（Gatekeeper 不拦，进程起、server fork 成功）。
>
> **证书/公证 env 实录（关键，别忘）**：① 签名身份 = `Developer ID Application: liang dong (98T664BZ7J)`，electron-builder 直接读 keychain，**无需** `CSC_LINK`/`CSC_KEY_PASSWORD`。② 公证三件套（electron-builder ≥24 的正确 env 名是 **`APPLE_API_KEY`（=.p8 路径）+ `APPLE_API_KEY_ID`（=MS54PPR383）+ `APPLE_API_ISSUER`**（UUID），不是网上常见的 `APPLE_API_KEY` 当 Key ID 用——会报 `Env vars APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set`）：`export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_MS54PPR383.p8" APPLE_API_KEY_ID=MS54PPR383 APPLE_API_ISSUER=f0633a9d-... APPLE_TEAM_ID=98T664BZ7J`。③ 中间证书 `DeveloperIDG2CA.cer` 要先装（否则证书显「不受信任」、identity 配不出）。
>
> **踩坑实录（macOS 26）**：钥匙串 CLI `security import`（.p12/PEM 均试过）会**静默丢私钥**——`1 identity imported` 但 `dump-keychain` 无 keys 类、`find-identity` 恒 0；**GUI 双击 .p12 才行**（证书下展开出「专用密钥」小三角才算配对成功）。better-sqlite3 `.node`（extraResources 内）签名被 electron-builder 的 `install-app-deps` + 默认签名流程覆盖，无需额外 `afterSign` 钩子（实测 stapler/spctl 全过）。
>
> **剩余手动项（不影响打包，属发布）**：发 GitHub Release 后 electron-updater 的 `checkForUpdates → update-downloaded → quitAndInstall` 端到端验证未做（feed 已配 `publish:github/dongliang1993/eva`，dmg/blockmap/latest-mac.yml 已生成于 `release/`，需 `gh release create` 或网页发版后另装旧版实测自更新）。
>
> **二次打包实测补坑（2026-08-22 晚，两连踩后修好）**：① **electron-updater 必须 bundle 进 main.js**——它是 main 进程运行时依赖，但 builder.yml 的 `files` 排了 `node_modules`，external 后在 app.asar 里 `Cannot find module 'electron-updater'` 崩主进程；解法 `electron.vite.config.ts` 的 `externalizeDeps: { exclude: ["electron-updater"] }`（纯 JS 无原生模块可内联，main.js 17 KB→577 KB）。② **better-sqlite3 的 `test_extension.node` 破坏密封资源**——`electron-rebuild` 编译产物带这个测试扩展（运行时用不到），签名后它成未签/被改的 sealed resource → `codesign` 报 `a sealed resource is missing or invalid`、公证 `check-signature` 拒；解法 builder.yml extraResources filter 加 `"!**/better-sqlite3/**/test_extension.node"`（+ test/benchmark 目录）。修后重打：Gatekeeper `accepted / Notarized Developer ID`、stapler `worked`、`codesign --deep --strict` 完整、`test_extension.node` 已排除、装上启动**不再弹 updater 报错**。另注：**别并发跑两个 electron-builder**（都往 `release/mac-arm64` 写+签名会互踩，报 `Mantle.framework ... No such file or directory` 这种符号链接竞态错）——单跑即正常。
>
> **三次打包根治（2026-08-22 深夜）：pnpm deploy 传递依赖全丢**。装上一跑 server 崩 `ERR_MODULE_NOT_FOUND`，先 `@ai-sdk/gateway` 后 `cross-spawn`——**根因**：`pnpm deploy --legacy` 产出的是 pnpm 隔离布局，顶层 `node_modules/` 只放 server 直接声明的 15 个包，所有传递依赖（gateway/cross-spawn/hono/jose…共 198 个）被隔离在 `.pnpm/node_modules/`（hoisted 层）+ `.pnpm/<pkg>/node_modules/`（各包私有目录），全是符号链接；flatten 后这层不是 Node 可解析路径，运行时逐层向上找不到传递依赖。逐个 hoist 是打地鼠（MCP sdk 一个包就 16 个传递依赖）。**根治**：重写 `scripts/flatten-node-modules.mjs`——解引用后把 `.pnpm/node_modules/*`（198 包）整个合并提升到顶层、再删 `.pnpm` + 顶层 `@eva/*` 链接（已 tsup bundle）。修后 `hoisted 198 packages`、顶层 197 包、0 残留符号链接。**装机实测全通**：`/v1/health` 200、无 token `POST /api/v1/runs/stream` 401（T33 token 生效）、静态页带 CSP 头（T33 CSP 生效）、server 正常 fork 不崩。
| **T35** | `T35-dev-bootstrap.md` | dev 一键拉起：`concurrently`+`wait-on` 串起 server+web+desktop | 0.5 天 | ✅ 已落地 |

> **落地记录**：T35 → 未 commit（根 `package.json` 加 `desktop:dev:all` = `concurrently -n server,web,desktop -c blue,green,yellow "pnpm serve:dev" "pnpm web:dev" "wait-on tcp:8082 tcp:5173 && pnpm desktop:dev"`；根 devDeps 补 `concurrently@^9.0.0` + `wait-on@^9.0.0`（原来只在 apps/desktop devDeps，根无）。`pnpm install` 装上。原 `desktop:dev`（只起 desktop）保留不动。）
>
> **验收状态**：脚本与依赖就位。**运行时验收未做**——需手动 `pnpm desktop:dev:all` 确认一条命令拉起三进程、desktop 窗口能对话、server/web 未就绪时 desktop 不白屏（wait-on 挡住）。端口写死 8082/5173，自定义端口的场景仍走原 `desktop:dev`。

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
