# 00 · 总览：Alma 是什么形态的应用

> 证据来源：`/Applications/Alma.app/Contents/Resources/` 包内容、`app.asar` 解包产物、`package.json` 依赖、`~/.config/alma/api-spec.md`、运行中的 API。

> **v0.0.990 修订（2026-08-21）**：本篇是 v0.0.175 快照。一句话定义与三大设计哲学在 v0.0.990 全部仍成立，但规模数字与技术细节已过期，对照如下：
>
> - **规模**：REST 路由 300+ → **497 条注册点**（`/tmp/alma-extract/routes-all.txt` 去重计数），WS 端点 12 个不变，bundled skills **37 个**（`/Applications/Alma.app/Contents/Resources/bundled-skills/`），DB 表 ~50 张（`/tmp/alma-extract/tables-all.sql`）。
> - **新增子系统**：workspaces（64 条路由，含 git/worktree/PR/AI 解冲突）、iab（内置浏览器自动化，32 条）、refs（`alma://` 双链引用图谱，21 条）、computer-use 审批化、多通道（telegram/discord/feishu/weixin 经 `channel_mappings` 表映射 thread）、cloud-sync（iCloud 快照）、mobile-relay（手机端隧道）、prompt-apps、plan/plan-mode、plugins（manifest + Bun 编译宿主）。
> - **技术细节翻转**：embedding 从「本地 transformers.js 384 维」翻转为「默认云端 `text-embedding-3-small` 1536 维、本地 384 维降级为 `/api/local-embeddings` 可选项，换模型触发全量 rebuild」（`main.readable.js:1793` vec0 表 `FLOAT[1536]`、`:2017` 默认模型、`:1884` rebuildEmbeddings）；WS 流式从「AI SDK chunk 原样转发」改为自研 part-diff 增量协议（`message_delta` + 7 种 delta 类型）。
> - 完整差异清单见 **16 篇**；路由目录见 **17 篇**；schema 见 **18 篇**；工具/技能/sidecar 见 **19 篇**；子系统机制见 **20 篇**；前端与桌面壳见 **21 篇**。

## 一句话

Alma 是一个 **"本地优先" 的 AI 人格桌面助手**：Electron 壳 + 内嵌 HTTP 后端（localhost:23001）+ SQLite 存储 + 文件系统记忆，外挂 CLI、浏览器扩展、macOS 辅助工具三个 sidecar。

## 全景架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                     Alma.app (Electron, macOS)                    │
│                                                                   │
│  ┌──────────────────────── Main Process ───────────────────────┐  │
│  │                                                              │  │
│  │  ┌────────────────┐   ┌───────────────────────────────────┐  │  │
│  │  │ HTTP API :23001│   │        Core Services               │  │  │
│  │  │ (REST + WS)    │   │ ┌─────────────┐ ┌───────────────┐ │  │  │
│  │  │ ~300+ 路由     │   │ │ Agent Loop  │ │ Memory Manager│ │  │  │
│  │  └───────┬────────┘   │ │ (ai-sdk)    │ │ (文件+向量)    │ │  │  │
│  │          │            │ └──────┬──────┘ └───────────────┘ │  │  │
│  │  ┌───────┴────────┐   │ ┌──────┴──────┐ ┌───────────────┐ │  │  │
│  │  │ WS /ws/threads │   │ │ Provider    │ │ Cron/Heartbeat│ │  │  │
│  │  │ (流式推送)      │   │ │ Adapters    │ │ Emotion/Fatigue│ │  │  │
│  │  └────────────────┘   │ └─────────────┘ └───────────────┘ │  │  │
│  │                       │ ┌─────────────┐ ┌───────────────┐ │  │  │
│  │  窗口管理 (10+ html)   │ │ Skill/MCP/  │ │ Activity      │ │  │  │
│  │  IPC (preload bridge) │ │ Plugin 加载 │ │ Recorder(OCR) │ │  │  │
│  │                       │ └─────────────┘ └───────────────┘ │  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────── Renderer (Chromium, React+Vite 多入口) ─────────┐  │
│  │  index.html(主聊天) settings.html gallery.html 通知/分享/...  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
        │                │                  │                 │
   ┌────┴────┐     ┌─────┴─────┐     ┌──────┴──────┐   ┌──────┴───────┐
   │ alma CLI │     │ Chrome    │     │ Computer Use│   │ CalTool /    │
   │ (Node    │     │ Extension │     │ (macOS AX   │   │ 打包的 bun/  │
   │  脚本,   │     │ + WS      │     │  辅助功能    │   │ uv/lark-cli/ │
   │  打 HTTP)│     │ Relay     │     │  守护进程)   │   │ tts 运行时   │
   └──────────┘     └───────────┘     └─────────────┘   └──────────────┘

   存储层：
   ├── SQLite (chat_threads.db 等, WAL 模式)  ← 线程/消息/结构化数据
   ├── 文件系统 ~/.config/alma/               ← 记忆/人格/技能/配置 (Markdown 为主)
   └── 工作区 workspaces/<threadId>/          ← 每个对话的项目目录
```

**v2 增量（v0.0.990，图上未画出）**：sidecar 家族扩为 **bun + uv/python(Qwen3-TTS) + sherpa-onnx worker + lark-cli + Alma Computer Use.app（unix-socket daemon）+ whisper.node（已改为 N-API 模块，不再是独立进程）**，另含 CalTool.app（bundle 无引用，用途未明）。能力面新增：git/worktree 编排与 AI 解冲突、内嵌浏览器 iab（Electron WebContents + CDP 1.3）、`alma://` refs 引用图谱、plan/plan-mode 文件型任务图、plugins 宿主（Bun 编译 + 权限门控）、mobile-relay（手机端经 relay.alma.now 隧道回环本地 API）、cloud-sync（iCloud 目录快照）。会话工作区从 `userData/workspaces/` 迁到 **`~/Documents/Alma/<date>/<slug>/`（预建 outputs/work/tmp）**。详见 16/19/20 篇。

## 三个关键设计哲学（复刻时最值得偷的）

1. **本地优先 + 文件即数据库的可读记忆**
   结构化数据进 SQLite；但"记忆、人格、技能"全部是 **人类可读的 Markdown 文件**（`MEMORY.md`、`SOUL.md`、`memory/YYYY-MM-DD.md`）。这让 agent 和用户都能直接读写记忆，调试成本极低。

2. **主进程即后端**
   不分"前端项目 + 后端项目"两个仓库。Electron 主进程内嵌一个完整 HTTP 服务（REST + WebSocket），前端、CLI、浏览器扩展、手机端（Capacitor 依赖暗示）全都打这同一个 API。**一套 API 服务所有客户端**。

3. **能力靠 Skill 文件扩展，而不是硬编码**
   复杂能力（图像生成、发送文件、浏览器控制）写成 `SKILL.md`（Markdown 格式的操作手册）注入 prompt，agent 读了手册自己调用 CLI/工具完成。新增能力 ≈ 写一个 Markdown 文件。

## 技术选型总表（证据：package.json + bundle 字符串）

| 层 | 选型 | 备注 |
|----|------|------|
| 桌面壳 | Electron + electron-vite | 多 html 入口 |
| 前端 | React + TypeScript | radix-ui、tanstack/react-virtual、CodeMirror、mermaid、KaTeX、cytoscape、strudel |
| 后端 | Express 5 + ws，内嵌主进程（:23001） | 404 条 REST + 12 个 WS 端点，详见 03 篇 |
| AI SDK | Vercel AI SDK v5（直接转发 SDK chunk 协议） | 模型按用途分槽 chat/toolModel/vision/embedding，详见 04 篇 |
| MCP | `@modelcontextprotocol/sdk` | mcp.json 配置 |
| 数据库 | SQLite（better-sqlite3 + drizzle，WAL） | chat_threads.db + sqlite-vec + FTS5，详见 03 篇 |
| Embedding | transformers.js 本地（all-MiniLM-L6-v2 / e5-small） | 384 维向量 + FTS5 混合检索，详见 05 篇 |
| 语音 | whisper.node（本地 STT）+ 本地 TTS sidecar | |
| 打包 | electron-builder + asar | 691MB asar，sidecar 二进制随包分发 |
| 更新 | electron-updater（app-update.yml） | 详见 02 篇 |
| 移动端痕迹 | Capacitor iOS 依赖 | 推测：共用 API 的实验性手机端 |

> **注（v0.0.990 变化点）**：上表是 v0.0.175 快照，v0.0.990 的差异为——
>
> - **Embedding 行已翻转**：默认改为云端 OpenAI 兼容 `text-embedding-3-small`（vec0 表 `embedding FLOAT[1536]`，`main.readable.js:1793`）；本地 transformers.js（4 个 384 维 Xenova 模型）降级为 `providerId=__local__` 的可选项，由 `/api/local-embeddings/*` 管理下载；切换模型触发 `rebuildEmbeddings` 全量重建（`main.readable.js:1884`）。「混合检索」一说在 v0.0.990 不成立：记忆检索是纯 vec0 余弦 KNN（`main.readable.js:2186`），FTS5 只服务历史消息搜索。
> - **后端行**：路由 404 → **497 条注册点**（`routes-all.txt`），新增 workspaces(64)/iab(32)/computer-use(30)/refs(21)/activity-recorder(18) 等组；WS 仍 12 端点，但 `/ws/threads` 流式协议从 AI SDK chunk 原样转发改为**自研 part-diff**（`message_delta` 携带 `part_add/text_append/text_done/part_update/tool_input_append/tool_output_set/tool_output_streaming` 七种 delta，`main.readable.js:84142` 附近 reducer 可证），详见 17 篇。
> - **语音行**：whisper 改为 `@fugood/whisper.node` N-API 直接 `import()`（`main.readable.js:54224`），不再是 sidecar 进程；TTS 扩为 sherpa-onnx（bun 跑 worker，stdio 行 JSON）+ Qwen3-TTS python sidecar（uv 装环境，仅 darwin+arm64）双引擎。
> - **打包行**：打包链含 `alma-notifications` 原生模块（`asar/package.json:84`，`file:electron/native/alma-notifications`）与 `electron-liquid-glass`（`^1.1.1`）。
> - **移动端**：mobile-relay 坐实为「手机端经 `relay.alma.now` WS 隧道回环代理本地 23001 API」+ 可选 P-256 ECDH/AES-GCM E2E（`main.readable.js:72204`、`:19479`）。
>
> 全景详见 16 篇（增量总览）。

## 数据流：一条消息的生命周期（速览版）

```
用户输入 → Renderer → POST /api/threads/:id/messages
  → 主进程: 组装 prompt (SOUL.md + 检索记忆 + 技能清单 + 历史)
  → Provider adapter → 流式调用模型
  → delta 经 WS /ws/threads 推回前端增量渲染
  → 工具调用? → 权限审批 → 执行(Bash/Read/Task/...) → 结果回灌 → 继续生成
  → 完成 → 写 SQLite + 触发记忆归档/总结
```

细节见 03、04 篇。
