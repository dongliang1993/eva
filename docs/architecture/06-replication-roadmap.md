# 06 · 复刻路线图：从零到 "你自己的 Alma"

> 建议配合 00 总览看。原则：**先跑通"会说话的壳"，再加记忆，再加工具，再加花活**。每一片都是可演示的成品。
> 注：本篇用 M1–M6 切片体系，落地时统一为 S 体系（弃用 M），对照见 11 §0。本篇技术选型表里的「Hono」推荐已被覆盖，落地选 Express 5（见 11 §1）。

## 技术选型速查（我的推荐，基于 Alma 的验证 + 更轻量的替代）

| 模块 | Alma 的做法 | 你的 MVP 建议 | 理由 |
|------|------------|--------------|------|
| 桌面壳 | Electron + electron-vite | 同左 | electron-vite 多入口配置是最省心的 |
| 前端 | React + TS + radix + tailwind | 同左（或换 shadcn/ui 一把梭） | |
| 后端 | 主进程内嵌 HTTP :23001 | Hono + node 的 fetch 生态 | 轻、路由即函数、WS 有 `@hono/node-ws` |
| AI | Vercel AI SDK | `ai` + `@ai-sdk/openai` 起步 | provider 切换成本几乎为零 |
| DB | SQLite + WAL | `better-sqlite3`（先用裸 SQL，后加 drizzle） | 同步 API 在 agent loop 里反而好写 |
| 记忆 | Markdown 文件 + 向量检索 | 先纯文件 + grep，第二阶段加 sqlite-vec | 见 05 篇 |
| 工具 | ai-sdk tool + zod | 同左 | zod schema 直接生成 JSON Schema |
| 更新 | electron-updater | 同左 + GitHub Releases | 免费 feed，先跳过签名也能跑 |

## 切片计划

### 🥚 M1 · 会说话的壳（1 周）
**目标：窗口里能流式聊天。**
- electron-vite 脚手架：main + preload + renderer 三件套
- 主进程起 Express，只做一个路由 `POST /api/chat`（body: messages 数组，内部 `streamText`，SSE 回传）
- 前端：一个输入框 + 消息列表，`fetch` + ReadableStream 读 SSE 增量渲染
- 历史先放内存，重启清空也没事
- ✅ 验收：打字 → 流式出字；重启还能聊（内存历史就行）

### 🐣 M2 · 落地存储（2-3 天）
- better-sqlite3 建两张表：`threads(id, title, created_at)` / `messages(id, thread_id, role, content, created_at)`
- API 加 `GET/POST /api/threads`、`GET /api/threads/:id/messages`
- 前端加线程列表侧栏
- ✅ 验收：重启后历史还在；能开多个对话

### 🐥 M3 · 工具调用（Agent 的成年礼，3-4 天）
- ai-sdk 的 `tool()` 定义 4 个最小工具：`readFile / writeFile / listDir / runCommand`（zod 校验）
- `stopWhen: stepCountIs(10)` 跑 agent loop；每个工具结果回灌继续生成
- 前端渲染工具调用块（折叠卡片：工具名 + 参数 + 结果）
- 权限：dangerous 工具（runCommand/writeFile）执行前 WS 推一个确认请求给前端，用户点了才执行
- ✅ 验收：说"在我工作区建一个 hello.txt 写首诗"，它真的建了，且每一步可见可审批

### 🐦 M4 · 记忆与人格（3-4 天）
- `SOUL.md`（人格）+ `MEMORY.md`（长时记忆）两个 Markdown，system prompt 里拼进去
- 每轮对话结束追加写 `memory/YYYY-MM-DD.md` 日记
- 加两个工具：`searchMemory`（先 grep 实现）、`updateMemory`（追加写 MEMORY.md）
- ✅ 验收：告诉它"我喜欢吃汉堡"，明天新对话问"我喜欢吃什么"它知道

### 🦅 M5 · 语义记忆 + Skill 机制（1 周）
- sqlite-vec（或 transformers.js 本地 embedding + 余弦）给 memory 文件分块建索引，searchMemory 换成向量+关键词混合
- Skill 机制：扫 `skills/*/SKILL.md`，把 name+description 列表注入 prompt；`Skill` 工具按需读全文（渐进披露）
- ✅ 验收：写一个"天气 skill"（内含 curl 命令模板），问天气它照着 skill 做出来了

### 🚀 M6 · 桌面化补完（持续）
- electron-updater + GitHub Releases
- 托盘 + 全局快捷键唤起 + 深链 `myapp://`
- 单实例锁、开机自启
- WS 全双工改造（SSE → WS，为后续主动推送做准备）

### 之后（按兴趣挑）
- Cron 调度 + 心跳（定时主动发消息）→ 见 05 篇
- MCP 客户端接入 → 见 04 篇
- 子代理/并行任务 → 见 04 篇
- Activity Recorder（截屏 OCR）→ 见 05 篇，注意这是个隐私敏感大件，最后做
- CLI（给你的 API 包一个 commander 命令行，agent 自己也在用）

## 贯穿全程的工程习惯（从 Alma 身上看到的）
1. **一切状态可读**：DB 用 sqlite 能用 GUI 打开看；记忆是 Markdown 能直接读。出问题时你 80% 的调试就是"看一眼"。
2. **API 先行**：所有能力先暴露成 HTTP 路由，UI 只是消费者。这样 CLI/手机端/扩展以后免费接入。
3. **Prompt 是代码的一部分**：system prompt 模板版本化，改动要 diff。
4. **每个功能一个文档**：像这套文档一样，写完一个切片就更新对应章节。
