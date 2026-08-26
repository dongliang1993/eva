# Alma 架构拆解 · Agent 开发学习手册

> 目标读者：想自己复刻一个 "Alma 类" AI 桌面助手的开发者（就是你）。
> 素材来源：解包 `/Applications/Alma.app` 的 `app.asar`（**双快照**：v0.0.175，2026-08-13 构建 + v0.0.990，2026-08-21 构建）+ 运行时配置目录 `~/.config/alma/` + 官方 `api-spec.md` + 运行中 API 实测。
> 所有结论均标注证据；推测内容明确标注"推测"。

> **v0.0.990 修订（2026-08-21）**：2026-08-21 基于 Alma v0.0.990 重新解包 `app.asar` 并完成六个区块的深挖调研，产出 **16–21 六篇 v2 增量修订文档**（见下表）。**00–15 仍是 v0.0.175 时代的历史快照**——其中被 v0.0.990 推翻或大幅演进的结论，各篇开头已加「v2 修订框」标注去向；未加修订框的篇目（06-15 多为 Eva 自身的设计文档）不受影响。复刻时请以 16-21 为当前事实、以 00-05 理解设计脉络。

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
| 11 | [落地计划](./11-landing-plan.md) | one-by-one 任务拆分（S0–S17 Phase A–E + v2 增量 S18–S24）、决策固化、验收标准、依赖图（v2 重排关键路径 S18→S19→S7→S6→S9→S11） | ✅ |
| 12 | [SDK 选型调研] | Claude Agent SDK vs Vercel AI SDK 调研（结论并入 11 §1.1，未单列文档） | ✅ |
| 13 | [work-mi 复用评估](./13-work-mi-reuse-assessment.md) | work-mi monorepo 可复用性评估：技术栈对位、切片覆盖度、harness 改造、复用决策 | ✅ |
| 14 | [Eva 技术架构](./14-eva-architecture.md) | 基于 Alma × WeaveLynx 取舍的目标架构：12 条设计原则、Session/Run 领域模型、流式协议、数据架构、不做清单 | ✅ |
| 15 | [Eva 执行手册](./15-eva-execution-playbook.md) | 按当前进度校准的施工手册：每阶段做什么/怎么做/验收/坑、文档→任务地图、依赖图 | ✅ |
| 16 | [v2 增量总览](./16-alma-v2-delta.md) | v0.0.175 → v0.0.990 变化总表：过期结论清单、新增子系统地图、各区块差异索引 | ✅ |
| 17 | [v2 路由与 WS 目录](./17-alma-v2-route-catalog.md) | 497 条路由分组全表、12 个 WS 端点、`message_delta` part-diff 流式协议帧规格 | ✅ |
| 18 | [v2 Schema 目录](./18-alma-v2-schema-catalog.md) | v0.0.990 全量表结构（50 张）：新增/变更表对照、drizzle 与 SQL 原文互证 | ✅ |
| 19 | [v2 工具/技能/sidecar](./19-alma-v2-tools-skills-sidecars.md) | 42 个内置工具清单、37 个 bundled skills、bun/uv/lark-cli/Computer Use/TTS sidecar 机制 | ✅ |
| 20 | [v2 子系统深挖](./20-alma-v2-subsystems.md) | prepareStep 三路干预、Sy() 审批中心、PTC 沙箱、memory sleep、cron/heartbeat/疲劳、refs/plan/workspaces | ✅ |
| 21 | [v2 前端与桌面壳](./21-alma-v2-frontend-desktop.md) | 窗口家族扩张（livecoding/prompt-app-runner/扫雷）、preload 44 个 namespace、启动序列修订 | ✅ |
| 22 | [S18 审批中心升级方案](./22-s18-approval-center.md) | S18 切片技术方案：thread 作用域 policy key、bash 安全直放、决策回写消息；含现状盘点与 r7 施工拆分（T27–T30） | ✅ |
| 23 | [Eva 自动更新方案](./23-eva-auto-update.md) | Alma v0.0.986 更新链实证（差量预热/断点续传救援/手动触发 UX）× Cindy 自研链对照 → Eva 选型与 D1–D8 落地设计、发布 checklist、施工拆分 | ✅ |
| 24 | [Eva Plan Gate × Plan Weave 方案](./24-eva-plan-gate-plan-weave.md) | Kimi Code plan mode（审批闸门/plan 文件/reminder）× Alma Plan Weave（workspace 文件任务图）→ Eva 两层拆分、数据模型、API、落地切片 | ✅ |

## 你问的 5 个方面 → 对应文档

1. 前端/后端/桌面端架构 → 01 + 02 + 03
2. 数据库与 API 设计 → 03
3. Electron（更新、启动器）→ 02
4. 模型适配、agent harness → 04
5. memory → 05

第 6、7、8 篇是我给你补的：复刻路线（先做什么后做什么）和额外的研究主题清单。
