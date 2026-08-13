# Alma 架构拆解 · Agent 开发学习手册

> 目标读者：想自己复刻一个 "Alma 类" AI 桌面助手的开发者（就是你）。
> 素材来源：解包 `/Applications/Alma.app`（v0.0.175，2026-08-13 构建）的 `app.asar` + 运行时配置目录 `~/.config/alma/` + 官方 `api-spec.md` + 运行中 API 实测。
> 所有结论均标注证据；推测内容明确标注"推测"。

## 阅读顺序

| # | 文档 | 覆盖内容 | 状态 |
|---|------|---------|------|
| 00 | [总览](./00-overview.md) | 一张图看懂 Alma：进程模型、数据流、技术选型总表 | ✅ |
| 01 | [前端架构](./01-frontend.md) | React 多入口、聊天 UI、流式渲染、markdown 管线、状态管理 | ✅ |
| 02 | [Electron 桌面端](./02-electron-desktop.md) | 主进程、多窗口、IPC、自动更新、打包分发、系统集成 | ✅ |
| 03 | [后端 API 与数据库](./03-backend-api-database.md) | 内嵌 HTTP 服务、路由全景、WebSocket 协议、SQLite schema | ✅ |
| 04 | [模型适配与 Agent 内核](./04-model-adapter-agent-harness.md) | Provider 抽象、agent loop、工具系统、子代理、Skill/MCP/插件、权限、prompt 组装 | ✅ |
| 05 | [记忆系统与周边子系统](./05-memory-subsystems.md) | 分层记忆、语义检索、自动归档、Activity Recorder、Cron/心跳/情感、TTS/STT、多通道 | ✅ |
| 06 | [复刻路线图](./06-replication-roadmap.md) | 技术选型建议、MVP 切片计划、每步验收标准 | ✅ |
| 07 | [扩展研究主题](./07-beyond.md) | 你提的 5 个方面之外，还值得研究的 N 个方向 | ✅ |
| 08 | [并行与多 Agent 编排](./08-parallel-multi-agent.md) | 并行 tool、fork-join 子代理、编排模式沉淀为 skill、最小 fork-join 内核 | ✅ |
| 09 | [扩展槽位宿主](./09-extension-host.md) | manifest/exposes.json、UI 槽 + agentPlugin 能力槽、EH 架构、webview SDK、S6 落地 | ✅ |
| 10 | [前端工程约束](./10-frontend-conventions.md) | 目录切分（features/shared/slots）、kebab 文件名 + 标识符约定、复用边界决策树、ESLint | ✅ |
| 11 | [落地计划](./11-landing-plan.md) | one-by-one 任务拆分（S0–S17 / Phase A–E）、决策固化（本地优先/Claude/mac-only）、验收标准、依赖图 | ✅ |
| 12 | [SDK 选型调研] | Claude Agent SDK vs Vercel AI SDK 调研（结论并入 11 §1.1，未单列文档） | ✅ |
| 13 | [work-mi 复用评估](./13-work-mi-reuse-assessment.md) | work-mi monorepo 可复用性评估：技术栈对位、切片覆盖度、harness 改造、复用决策 | ✅ |

## 你问的 5 个方面 → 对应文档

1. 前端/后端/桌面端架构 → 01 + 02 + 03
2. 数据库与 API 设计 → 03
3. Electron（更新、启动器）→ 02
4. 模型适配、agent harness → 04
5. memory → 05

第 6、7、8 篇是我给你补的：复刻路线（先做什么后做什么）和额外的研究主题清单。
