# 01 · Alma 前端架构调研报告

> 调研对象：Alma v0.0.960 构建产物（`/tmp/alma-src/extracted/out/renderer/` + `out/preload/` + `package.json`）。
> 方法：对构建产物做静态考古。每条结论后用【证据：…】标注出处；【推测】表示无法直接证实但置信度较高的推断。
> 与旧报告（`ALMA_REPLICATION_GUIDE.md`）的分工：旧报告已覆盖主进程 / REST API / 数据模型，本报告只讲渲染进程内部。

---

## 1. 技术栈总览表

| 层 | 选型 | 版本 | 证据 |
|---|---|---|---|
| 框架 | **React 18** | 18.3.1 | vendor chunk `assets/x-CDDR_Rlm.js` 内嵌 `react_production_min.version = "18.3.1"` |
| 构建工具 | **electron-vite**（Vite/Rollup，多页 MPA） | — | 标准 electron-vite `out/renderer` 产物结构；HTML 用 `type="module"` + `modulepreload`；`__vitePreload` 运行时；renderer 根目录残留 `electron-vite.svg` |
| 语言 | TypeScript | — | 【推测】无运行时直接证据，按项目规模与 Vite 模板约定判断 |
| 状态管理 | **Jotai**（原子化）+ React Context + SWR 三分天下 | — | `ThemeContext-CD1XhfVh.js` 含 jotai 内核（`skipAtom`/`mountAtom`/`unmountAtom`/`recomputeInvalidatedAtom`）及注释里的 jotai issue 链接 `jotai/discussions/2044`；主 chunk 有 `browserTabsAtom`、`composerPrefillAtom`、`pendingAppshotAtom`、`previewHighlightAtom`、`fileQuoteAtom`、`selectedProviderAtom` 等具名 atom 与 `useAtom/useSetAtom/useAtomValue` 导出。**zustand/redux/valtio 均 0 命中** |
| 数据获取 | **SWR** + 手写 API client 单例 | — | 主 chunk `useSWR` 30 处调用、`mutate`、`swrConfig`；ThemeContext chunk 有 `chatApiClient`、`settingsSyncClient` class 单例 |
| 路由 | **react-router（HashRouter）** | — | 主 chunk 含 `HashRouter`、`useNavigate/useLocation/useParams`，路由表：`/`、`/chat`、`/chat/:threadId`、`/quick-chat`、`/settings`、`/more-menu`、`/minesweeper*`。file:// 协议下只能 Hash 路由 |
| UI 组件 | **Radix UI 全家桶**（shadcn 式自封装） | — | node_modules 含 `@radix-ui/react-menu/popper/portal/presence/collection/dismissable-layer/focus-scope/focus-guards/direction/arrow/context-menu` 等约 15 包；主 chunk `ContextMenu` 247 处、`createMenuContext`、`MenuScope` 等 Radix 内部命名 |
| 样式 | **Tailwind CSS v4** | 4.1.12 | 主 CSS `x-De5_7faw.css`（540KB）头注释 `/*! tailwindcss v4.1.12 */`；`@layer properties`、`@property` 89 处、`--tw-*` 变量 1816 处、`color-mix` 1052 处；JSX 中 `text-muted-foreground`、`bg-muted/30`、`size-4` 等语义 token 工具类遍布 |
| className 合并 | clsx + tailwind-merge（封装为 `cn`） | — | 主 chunk 导入 `c as cn`（shadcn 约定） |
| 图标 | lucide-react（按图标分包）+ @lobehub/icons + Twemoji | — | chunk 名 `file-question-mark-*`、`wand-sparkles-*`、`arrow-up-right-*`；`provider-icon-data-BmRaTnr8.js`（481KB 提供商图标数据）；`TwemojiIcon-*.js` |
| 动画 | **framer-motion** | ^12.23.26 | package.json；主 chunk `motion.div` 30 处、`AnimatePresence` 9 处 |
| Markdown 渲染 | **Streamdown**（Vercel 流式 markdown 渲染器，react-markdown/unified 之上）二次封装 | react-markdown ^10.1.0 | `data-streamdown="mermaid-block"`、`streamdown:incomplete-link` 等标志字符串 49 处；详见 §3.2 |
| 代码高亮 | **Shiki**（Oniguruma WASM + JS regex 双引擎，按需 loadLanguage） | — | ThemeContext chunk `async function highlightCode(code,lang,isDark)` → `getHighlighter()` → `codeToHtml`；`createOnigurumaEngine`、`createJavaScriptRegexEngine`；assets 中 300+ 个按语言/主题拆分的 grammar/theme chunk |
| 数学公式 | KaTeX（rehype-katex）+ remark-math | — | node_modules 有 `katex/rehype-katex/remark-math`；assets 内嵌全套 KaTeX 字体（3 格式 × 20 字重）；markdown chunk 导入 `aU as rehypeKatex`、`aD as remarkMath` |
| 图表 | mermaid + **cytoscape**（mermaid architecture 图布局）+ **@antv/infographic** | @antv/infographic ^0.2.6 | `mermaid-NA5CF7SZ-*.js` 5.99MB、`mermaid.core-*` 681KB、`cytoscape.esm-*.js`；`MermaidRenderer-B9X_SJ3Z.js`；package.json 三项均显式声明（另有 `beautiful-mermaid`） |
| 音乐 livecoding | **@strudel/web** + Tone.js | strudel/core 锁 1.2.6，tone ^15 | `useLiveCoding-DYhAGtP4.js` 内 `initStrudel`、`strudelRepl`、`ANALYSER_ID`；package.json |
| 虚拟滚动 | **@tanstack/react-virtual**（主列表）；react-virtuoso / virtua / masonic（次要场景） | ^3.13.12 | 主 chunk `useVirtualizer` 6 处、`measureElement` 24 处；package.json 四库并存 |
| 终端 | **@xterm/xterm** + Fit/WebLinks/Unicode11 addons | — | 主 chunk `xterm` 64 处、`FitAddon`/`WebLinksAddon`/`Unicode11Addon` 各 3 处；package.json `@xterm/addon-unicode11` |
| 代码编辑器 | **CodeMirror 6**（@uiw/react-codemirror） | ^4.25.4 | ThemeContext chunk `EditorView` 109 处、`EditorState` 51 处、`oneDark`、`keymap`、`lineNumbers` |
| 文件预览 | react-pdf / mammoth(docx) / xlsx / jszip / 自绘音视频图片预览 | — | chunks：`PdfPreview/DocxPreview/ExcelPreview/PptxPreview/ZipPreview/ImagePreview/AudioPreview/VideoPreview/UnsupportedPreview`；`pdf.worker.min-*.mjs` |
| toast | **sonner** | ^2.0.7 | package.json；主 chunk `Toaster` |
| i18n | react-i18next（内嵌中/英/日等多语言表 + `en-US-*.js` 独立 chunk） | — | ThemeContext chunk `initReactI18next`、`fallbackLng` 21 处、内嵌翻译表 |
| 埋点 | posthog-js（`ConditionalPostHogProvider` 可按设置关闭） | ^1.302 | chunk 文件名 + package.json |
| 流式 JSON 容错 | partial-json + best-effort-json-parser + jsonrepair | — | package.json 三件套（工具入参流式解析用） |
| 其他 | emoji-picker-react、react-colorful、react-tooltip、react-zoom-pan-pinch、react-activity-calendar、@dnd-kit、react-rnd、modern-screenshot、thinking-orbs | — | package.json + node_modules |

**一句话**：React 18 + electron-vite MPA + Jotai/SWR + Radix + Tailwind v4 + Streamdown/Shiki 的"重渲染器"架构。43MB assets 的体积大头是按需加载的 Shiki 语法包（300+ 文件）、mermaid（6.7MB）、KaTeX 字体与 PDF worker。

---

## 2. 多入口应用结构

`out/renderer/` 共 **8 个 HTML 入口**，每个入口 = 一个独立 React 小应用（自己的 `#root` + 独立入口 chunk），对应主进程一个独立 `BrowserWindow`：

| 入口 | 标题 | 入口 chunk | 用途 | 证据 |
|---|---|---|---|---|
| `index.html` | （主窗体） | `index-CJ4WIEBB.js`（3.19MB） | **主聊天窗**：thread 侧栏、聊天流、Artifact/Preview 侧边栏、内嵌浏览器(iab)、终端、扫雷彩蛋等全部核心 UI | 主 chunk 路由表含 `/`、`/chat/:threadId`、`/quick-chat`、`/more-menu`、`/minesweeper*` |
| `settings.html` | Alma 设置 | `settings-C43oHhs1.js` | 设置中心独立窗（主窗经 `settingsWindow.open(tab)` 跳入） | preload `settingsWindow: open, close, getInitialTab, onTabChange, navigateToThread` |
| `gallery.html` | Alma Gallery | `gallery-BvOTJr0j.js` | 生成图片画廊窗 | preload `galleryWindow: open, close, navigateToThread, onNavigateToImage`；masonic 瀑布流在依赖中 |
| `notifications.html` | Alma Notifications | `notifications-DqQJjFhE.js` | **自绘系统通知弹窗**（无边框置顶小窗，framer-motion 动效） | preload `notificationWindow: onShow, sendDismiss, sendClick, sendAction, onQueueChanged`；另有 native 包 `alma-notifications` |
| `lightbox.html` | Alma Image Viewer | `lightbox-BrRoJpK8.js` | 图片查看器（缩放平移） | preload `lightboxWindow: open, getInitialParams, editImageInThread, onUpdate`；react-zoom-pan-pinch |
| `livecoding.html` | Alma Live Coding | `livecoding-CqRpJ4Gn.js`（226KB） | Strudel 音乐 live-coding 窗（CodeMirror + strudel REPL） | preload `liveCodingWindow: open, getPendingCode, sendToChat, onCodeReceived` |
| `share.html` | Share Conversation | `share-C6Q_tNzw.js` | 分享对话的排版预览窗 | HTML title + 入口 chunk 名 |
| `prompt-app-runner.html` | Prompt App | `prompt-app-runner-CTqeuJuJ.js` | Prompt App（prompt 模板跑成迷你应用）独立运行窗 | preload `promptAppRunner: open, close, getPromptApp, saveWindowSize` |

**结构特点：**

1. **每窗体 = 独立 React root，跨窗通信走 preload IPC 而非共享状态**。如 `galleryWindow.navigateToThread`、`lightboxWindow.editImageInThread` 让主窗接管跳转/编辑。【证据：各 HTML 只引自己的入口 chunk；preload 中每个窗口一组 `xxxWindow` namespace】
2. **MPA 主题防闪烁方案**：主窗把当前主题（mode/density/base46Theme/全部 CSS 变量/fontFamily）序列化进 `localStorage`（appearance cache），每个 HTML 的 `<head>` 内联一段同步 IIFE，首帧前读缓存并 `root.style.setProperty` 全量回放 + 设置 `data-base46-theme` 属性。原注释自述原因：win98 这类结构型主题的 scoped CSS 挂在该属性上，不回放会先画出调色板再"跳变"出结构。【证据：`settings.html`/`index.html` head 内联脚本原文】
3. **手动分包共享公共依赖**：`x-CDDR_Rlm.js`（React 运行时 249KB）、`ThemeContext-CD1XhfVh.js`（2.48MB 核心公共 chunk：主题 + jotai + SWR + i18n + CodeMirror + Shiki 宿主 + API client）、`mermaid-NA5CF7SZ-*.js`（5.99MB：Streamdown markdown 管线 + mermaid）。chunk 命名与分组是 vite manualChunks 的产物，不是源码目录结构。【推测：分组策略】

---

## 3. 主聊天界面架构

### 3.1 消息列表

- 虚拟滚动：`@tanstack/react-virtual` 的 `useVirtualizer`。`estimateSize` 按条目类型返回预估常量高（`THREAD_HEIGHT`/`SECTION_HEADER_HEIGHT`/`COLLAPSIBLE_HEADER_HEIGHT`），`getItemKey` 用稳定 id 防重排，`overscan: 8`，`measureElement` 实测动态高度。【证据：主 chunk 两处 `useVirtualizer({...})` 调用现场】
- 滚动跟随：手写 **stick-to-bottom**——`stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48`，距底 48px 内视为贴底；流式期间贴底则自动滚底，用户上翻即释放。【证据：主 chunk `handleScrollAreaScroll`】
- react-virtuoso（`followOutput`）用于次要列表（如 `ExecutionHistory-*.js`）。【证据：主 chunk `followOutput` 7 处】

### 3.2 流式渲染（本报告最有复刻价值的部分）

链路四层，全部可从 bundle 还原：

**① WS 事件 → DeltaAccumulator（带乱序重组的可靠增量合并）**

渲染进程经 `chatApiClient` 的 WS（`/ws/threads`）收 `message_delta`，事件携带 `deltas[]`，每个 delta 带 `seq`：

- 按 seq 排序；`seq <= lastSeq` 丢弃（去重）；`seq > lastSeq + 1` 进 `pendingDeltas` 等缺口补齐，`processPendingDeltas` 循环找 `lastSeq + 1` 续上。
- `applyDelta(message, delta)` 按类型落进 `message.parts[]`：`text_append`（text/reasoning 追加）、`text_done`、`part_add`（新 part，如 tool-invocation）、`tool_input_delta`（`part.input[key] += text`，流式工具入参）、`tool_output_set`（工具完成，写 output/state/errorText）。
- 另有 `SubagentAccumulatorClass` 为每个子代理 taskId 维护独立 accumulator，完成后 `isStreaming=false`。
- 合并出**完整新 message 对象**后 `setCurrentThread(prev => ...替换 messages[idx]...)`：不可变更新但只替换单条消息引用。

【证据：主 chunk 中 accumulator 完整方法体；与旧报告 §3 的 `message_delta` JSON 样例一一对应】

**② useSmoothStreamContent（打字机缓冲器，最关键的非直觉设计）**

LLM token 突发到达，直接渲染会顿挫。Alma 在 WS 数据与 React 渲染之间加了一个 **rAF 驱动的字符泵**：

```
常量: MIN_CPS=15, MAX_CPS=300, DEFAULT_CPS=50, EMA_ALPHA=0.15
      LARGE_APPEND=500, FLUSH_MAX_SECONDS=4, FLUSH_SPEEDUP=1.25
      MIN_FLUSH_CPS=18, MAX_FLUSH_CPS=90
```

- 真实全文存 `targetRef`，屏幕只显示 `displayed`（React state）；每帧按当前 CPS（EMA 跟踪实际到达速率，alpha=0.15）从 buffer 放字符；`alignSliceEnd` 保证不切断 UTF-16 surrogate pair（emoji 安全）。
- backlog 积压则进入 flush 加速（上限 4 秒清完）；流刚开始有 `minInitialBuffer` 等待期，避免逐字蹦。
- 每放 2 个字符触发一次 `chatSynthManager.playNote()` 打字音效（设置可关）。
- 返回 `{ content, debug, isAnimating }`；debug 喂 `useStreamDebugInfo` 调试面板；`useDelayedAnimated` 在流结束后多保留 1s 动画态做收尾。

【证据：`mermaid-*.js` 内 `useSmoothStreamContent` 完整实现】

**③ Streamdown（流式安全的 Markdown 渲染）**

渲染层是 Vercel 的 **Streamdown** 二次封装（`data-streamdown=*` 标志遍布），基于 unified/remark/rehype：

- `parseMarkdownIntoBlocksFn` 把全文切成块数组，**每块一个 memo 组件**（`Ct = memo(...)`，自定义比较器比较 content/index/components/shouldParseIncompleteMarkdown）——增量流下**只有最后一个未完成块重解析重渲染**，已完成块 memo 命中零开销。这是"流式 markdown 不卡"的核心机制。
- streaming 模式下用 `useTransition` 包裹块列表 setState，降低渲染优先级。
- `parseIncompleteMarkdown` 容错未闭合语法：未闭合链接补成 `streamdown:incomplete-link` 占位、未闭合代码块/加粗等做截断处理，避免半包语法炸出原始符号。
- `streamdownMode = streaming | static` 两态；CSS 类 `.streaming-response` 配合 `fadeComponents` 做词级淡入（注释原文："CSS only animates inside .streaming-response"）。
- `StreamingErrorBoundary` 包裹整棵 markdown 树：流式中渲染抛错不炸聊天界面。
- 插件管线：`remarkParse → remarkGfm → remarkMath → remarkBreaks → remarkRehype → rehypeKatex`，外加 `findAndReplace`（引用角标 citation 等自定义替换）。【证据：主 chunk 导入列表 `aL as unified, aM as remarkParse, aN as remarkRehype, aO as VFile, aQ as visit, aR as toJsxRuntime, aS as findAndReplace, aT as remarkGfm, aU as rehypeKatex`】

【证据：`mermaid-*.js` 中 Streamdown 组件（`Go = memo(...)`，props 含 `mode/parseIncompleteMarkdown/shikiTheme/mermaid/controls/BlockComponent/parseMarkdownIntoBlocksFn`）】

**④ 特殊代码块渲染器（按 ` ```lang ` 分流）**

Streamdown 的 fenced code block 被分流为多个专用渲染器，bundle 中均能找到独立标志字符串（`data-streamdown="code-block" / "mermaid-block" / "infographic-block" / "strudel-block"`）：

| 代码块语言 | 渲染器 | 机制 | 证据 |
|---|---|---|---|
| 普通语言 | ShikiCodeBlock | `highlightCode(code,lang,isDark)` → Shiki `codeToHtml`，语言 grammar 按需 `loadLanguage`（300+ 按需 chunk）；暗色用另一主题；未完成代码块尾部闪烁光标 | ThemeContext chunk 的 `highlightCode`/`getHighlighter`；assets 内 per-language chunk |
| `mermaid` | MermaidRenderer | 独立 chunk `MermaidRenderer-B9X_SJ3Z.js`；mermaid core 6MB 按需加载；architecture 图布局走 cytoscape（`cytoscape.esm-*.js`）；流式期间防抖渲染，语法不完整时显示占位 | `data-streamdown="mermaid-block"`；package.json 有 `beautiful-mermaid` 备选 |
| `infographic` | @antv/infographic | AI 输出的结构化 JSON → 信息图组件；主 chunk 有 `infographicEnabled` 开关 | `data-streamdown="infographic-block"` ×3；package.json `@antv/infographic ^0.2.6` |
| `strudel` | StrudelBlock | 内嵌 livecoding 播放器（@strudel/web + Tone.js），可播放/停止；完整 REPL 体验在独立 `livecoding.html` 窗（`useLiveCoding-*.js` 内 `initStrudel/strudelRepl/ANALYSER_ID`） | `data-streamdown="strudel-block"`；package.json `@strudel/web`、tone |

**小结**：流式渲染 = `WS delta → seq 重组 accumulator → setCurrentThread → useSmoothStreamContent 字符泵 → Streamdown 分块 memo → 块内按语言分流（Shiki/KaTeX/mermaid/infographic/strudel）`。复刻时 ④ 可全部砍掉只留 Shiki + mermaid。

### 3.3 其他主界面要点（简记）

- **Artifact / Preview 侧边栏**：右侧栏与主聊天同进程（同属 `index.html`），状态经 jotai atom（`pendingAppshotAtom`、`previewHighlightAtom` 等）同步；内嵌浏览器(iab) 的桥接走 preload `almaIab` namespace。【证据：preload `exposeInMainWorld("almaIab")`；主 chunk atom 名】
- **终端面板**：xterm + Fit/WebLinks/Unicode11 addon，PTY 在 MCP/主进程侧（详见 04 报告）。【证据：主 chunk xterm 引用 64 处】
- **扫雷彩蛋**：`/minesweeper*` 路由 + 独立 `minesweeperWindow` preload 入口。【证据：路由表 + preload】

---

## 4. 状态管理与数据流

**结论：不是 zustand/redux，是 Jotai + React Context + SWR 三分。**

| 关注点 | 方案 | 证据 |
|---|---|---|
| 跨组件 UI 状态 | **Jotai atom**：`browserTabsAtom`、`composerPrefillAtom`、`pendingAppshotAtom`、`previewHighlightAtom`、`fileQuoteAtom`、`selectedProviderAtom` 等 | ThemeContext chunk 含 jotai 内核函数名与 jotai issue 注释；主 chunk `useAtom/useSetAtom/useAtomValue` |
| 服务端状态（thread 列表、消息、设置） | **SWR**：`useSWR` 30+ 处，配 `mutate`/`swrConfig`；WS 推送到达后手动 `mutate` 失效刷新 | 主 chunk |
| 主题 | 独立 `ThemeContext`（见 §5） | chunk 名即证 |
| 当前 streaming thread | `currentThread` 类原子状态 + DeltaAccumulator 不可变替换单条 message（见 §3.2 ①） | 主 chunk accumulator 方法体 |

**数据流闭环**：

1. **读路径（快照）**：渲染进程 → HTTP `fetch` → 主进程内嵌 API server（`apiServer` preload 暴露端口/token）→ SQLite。SWR 缓存。
2. **写路径**：同样走 HTTP REST（旧报告已列全量 API）。
3. **实时路径（增量）**：`chatApiClient`（ThemeContext chunk 内 class 单例）维护 WS 连接（`/ws/threads`），收到 `message_delta` → DeltaAccumulator 重组 → `setCurrentThread` 不可变替换 → React 重渲；收到其他事件（thread 元信息变更、子代理状态）→ 对相应 SWR key `mutate()` 触发重取。

**为什么 WS 只扛 delta、HTTP 扛 CRUD**：delta 高频小包、顺序敏感（seq 重组逻辑证明设计上假设了乱序/重复到达）；CRUD 低频、需要请求-响应语义与错误码。【推测：设计动机，但代码结构支持该结论】

---

## 5. 主题系统

- **载体**：独立 chunk `ThemeContext-CD1XhfVh.js`（2.48MB）——它同时是"公共运行时大包"（主题 + jotai + SWR + i18n + CodeMirror + Shiki 宿主 + API client），说明主题 context 是几乎所有页面的根 Provider 之一。【推测：打包分组动机】
- **主题维度**（appearance cache 序列化字段可证）：`mode`（light/dark）、`density`（密度）、`base46Theme`（**结构化主题**，如 win98 这种带布局结构的主题包）、全套 CSS 变量、`fontFamily`。
- **实现**：CSS 变量全量挂在 `:root`（`root.style.setProperty`），结构化主题额外在 `<html data-base46-theme="...">` 挂属性，scoped CSS 选择器挂在该属性下。Tailwind v4 的 `@layer properties` + `@property`（89 处）+ `color-mix`（1052 处）承载调色板派生。
- **多窗防闪烁（MPA 独有难点）**：主窗变更主题 → 序列化进 localStorage；每个 HTML 的 `<head>` 内联同步 IIFE，首帧绘制前读缓存并回放全部变量。bundle 内联脚本自述：不回放的话 win98 这类结构型主题会先画出调色板再"跳变"出结构。【证据：`index.html`/`settings.html` head 内联脚本原文】
- **代码高亮跟随主题**：`highlightCode(code, lang, isDark)` 显式传 isDark 选 Shiki 主题。【证据：ThemeContext chunk】

---

## 6. 与主进程的桥接：三条通道分工

preload（`out/preload/index.js`，22KB）通过 `contextBridge.exposeInMainWorld` 暴露 **42 个 namespace**，按用途分四类：

| 通道 | 承担场景 | namespace 举例 | 证据 |
|---|---|---|---|
| **HTTP fetch → 内嵌 API server** | 一切 CRUD/查询/设置/发送消息（REST，见旧报告全量 API 表）；`apiServer` 只负责告诉渲染进程端口与 token | `apiServer` | preload `exposeInMainWorld("apiServer")`；旧报告 §2 |
| **WS（chatApiClient 自建）** | 流式 message_delta、thread 实时事件（§3.2、§4） | （无 namespace，渲染进程直连） | ThemeContext chunk `chatApiClient` |
| **preload IPC（invoke/on）** | **只有"Web 平台做不了或需要跨窗协调"的事**： | | preload 原文 42 个 `exposeInMainWorld` |
| ├ 窗口管理 | 开/关各 MPA 子窗、跨窗跳转 | `settingsWindow / galleryWindow / lightboxWindow / liveCodingWindow / notificationWindow / quickChatWindow / minesweeperWindow / moreMenu / promptAppRunner / windowControls` | preload |
| ├ 系统能力 | 剪贴板、文件对话框、系统文件、路径、平台信息、辅助功能 | `electronClipboard / selectAndReadFile / selectDirectory / systemFile / getPathForFile / platform / accessibility` | preload |
| ├ 特权操作 | 内嵌浏览器(iab)、Playwright、快照、whisper 语音、webSearch/webFetch 代理、MCP OAuth、权限、Claude/Copilot 订阅 | `almaIab / playwright / snapshot / whisper / webSearch / webFetch / mcpOAuth / permissions / claudeSubscription / copilot / appshots / almaBrowserProfile` | preload |
| └ 插件与对话框 | 插件 UI 原语 + 工具审批/提问对话框 | `pluginCommands / pluginConfirmDialog / pluginInputBox / pluginNotification / pluginQuickPick / pluginStatusBar / pluginTheme / toolApprovalDialog / userQuestionDialog` | preload |

**分工一句话**：数据走 HTTP，流式走 WS，"只有桌面端能做"的事走 IPC。渲染进程对主进程的了解被压缩为 42 个窄接口，HTTP/WS 层则与纯 Web 应用无异——这是该架构可复刻性的关键。【推测：窄接口设计意图】

---

## 7. 【复刻要点】最小前端骨架

目标：复刻"能用"的主聊天体验（线程列表 + 流式消息渲染 + markdown + 代码高亮 + mermaid），砍掉 Alma 的重型部分（多窗 MPA、结构化主题、infographic/strudel、PDF 预览、插件系统、埋点）。

**技术选型（对位简表）**：

| Alma 用了 | 最小复刻 | 砍/留理由 |
|---|---|---|
| electron-vite MPA × 8 HTML | **electron-vite 单入口**（1 个 index.html） | 子窗全部砍掉，设置/画廊做成路由页 |
| React 18 + HashRouter | 保留 | file:// 下必须 Hash 路由 |
| Jotai + SWR + Context 三分 | **只留 SWR + 少量 useState/Context** | jotai 在小组件树里是过度设计；streaming 状态一个 `useState<Message[]>` 足够 |
| Tailwind v4 + Radix + shadcn | 保留（可选砍 Radix） | 开发效率主力；Radix 可换成原生 dialog/menu |
| DeltaAccumulator（seq 重组 + 6 种 delta） | **必须复刻，可简化**：保留 `text_append/part_add/tool_input_delta/tool_output_set` 四类 + `seq > lastSeq+1 → pending` 乱序缓冲 | 这是流式正确性的根 |
| useSmoothStreamContent 字符泵 | **必须复刻**：rAF + EMA(α=0.15) 跟踪到达速率 + 50CPS 基线 + surrogate pair 对齐 + 积压 4s 清完 | 流式观感的根；~100 行可实现 |
| Streamdown 分块 memo | **核心复刻**：按块切分 + `memo(块)` 自定义比较器 → 只有尾块重渲；`parseIncompleteMarkdown` 容错 | 直接装 `streamdown` 包即可（Vercel 开源），不必自写 |
| Shiki 按需 loadLanguage | 保留（或换 highlight.js 省事） | Shiki 双引擎按需加载照搬即可 |
| KaTeX / mermaid / cytoscape | KaTeX + mermaid 保留；cytoscape 砍 | architecture 图是长尾 |
| infographic / strudel / livecoding | 砍 | 长尾 |
| xterm / CodeMirror / react-pdf 等预览 | 砍 | 长尾 |
| ThemeContext + base46 + 多窗防闪烁 | **单窗下极简化**：`:root` CSS 变量 + light/dark 切换即可，不用 localStorage 回放 | MPA 防闪烁是多窗独有难点 |
| 42 个 preload namespace | **< 6 个**：`apiServer`(端口/token)、`windowControls`、`selectAndReadFile`、`platform` | 其余全是长尾桌面能力 |
| posthog / i18n / sonner 等 | 砍（i18n 可选） | |

**最小骨架代码结构**（约 8 个文件即跑通；此为早期演示骨架，**文件命名/目录的正式约定以 10 §2/§6/§7 为准**——三红线正式归属 `shared/streaming/` 与 `shared/markdown/`，非本骨架的 `components/`/`hooks/`）：

```
renderer/
├── index.html                  # 唯一入口
├── src/
│   ├── main.tsx                # createRoot + HashRouter + SWRConfig
│   ├── api/chat-api-client.ts  # fetch 封装（读 window.apiServer 的端口/token）
│   ├── api/ws-client.ts        # WS 连接 + DeltaAccumulator（seq 重组）
│   ├── hooks/use-smooth-stream.ts   # rAF 字符泵（EMA CPS）
│   ├── components/
│   │   ├── thread-list.tsx     # SWR 拉线程列表
│   │   ├── message-list.tsx    # @tanstack/react-virtual + stick-to-bottom(48px)
│   │   └── markdown.tsx        # streamdown + shiki + katex + mermaid
│   └── stores/current-thread-store.ts  # useState + 不可变替换单条 message
preload/index.ts                # contextBridge 暴露 apiServer/windowControls 等
```

**三条复刻红线**（缺了就不是 Alma 的体验）：

1. **seq 乱序重组**——假设 WS delta 会乱序/重复到达，`pendingDeltas` 缓冲缺口，不能只 append。
2. **rAF 字符泵**——渲染速率与网络速率解耦，EMA 跟踪真实 CPS，否则 token 突发到达时 UI 顿挫。
3. **markdown 分块 memo**——只有最后一个未完成块重解析；整篇重渲染在 100+ 条消息的流式场景必卡。

其余（多窗、结构化主题、插件、各预览器、strudel/infographic）均为长尾增量，可在骨架跑通后逐项回填。

---

> 完。未尽事项：preload 42 个 namespace 的方法级签名、Streamdown `findAndReplace` 的 citation 角标细节、win98 结构化主题的具体机制，均可按需在 bundle 中继续深挖。
