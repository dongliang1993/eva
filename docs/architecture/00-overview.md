# 00 · 总览：Alma 是什么形态的应用

> 证据来源：`/Applications/Alma.app/Contents/Resources/` 包内容、`app.asar` 解包产物、`package.json` 依赖、`~/.config/alma/api-spec.md`、运行中的 API。

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
