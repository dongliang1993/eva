# R1 · 重构总览与执行契约

> 本目录是一轮**可直接交给实现模型（Sonnet）逐条执行**的施工 spec。
> 上游依据：`docs/architecture/14-eva-architecture.md`（目标架构）、`15-eva-execution-playbook.md`（阶段划分）。
> 本轮解决的是「文档已定的架构」与「work-mi 继承来的代码」之间的错位，其中 T0 是**当前已经坏掉的功能**，不是待做项。

---

## 0. 任务清单与依赖

| 任务 | 文档 | 内容 | 估时 | 依赖 |
|---|---|---|---|---|
| **T0** | [`T0-p0-fixes.md`](./T0-p0-fixes.md) | P0 修复：模型选择生效 / 向量不丢 / fs 根目录 / **工具执行链路修复**（审批闸门重做） | 1–1.5 天 | — |
| **T1** | [`T1-uimessage-store.md`](./T1-uimessage-store.md) | UIMessage 整存 + runs 表 + 契约收敛（对应 15 §S2） | 4–5 天 | T0 |
| **T2** | [`T2-harness-loop.md`](./T2-harness-loop.md) | harness 收敛：手写 loop → `stopWhen + prepareStep` | 2–3 天 | T1 |
| **T3** | [`T3-frontend.md`](./T3-frontend.md) | 前端流式与目录重构（对应 15 §S1.1） | 4–5 天 | T1、T2 |
| **T4** | [`T4-cleanup-and-docs.md`](./T4-cleanup-and-docs.md) | 摘掉子代理半成品 + 遗留清理 + 文档修订 | 1 天 | T0–T3 |

> **T0.4 的严重程度已实测上调**：当前 main 上**任何工具调用都跑不通**（不注入审批 → `Tool result is missing`；注入审批 → `unknown approvalId`），因为 `toolApproval` 被无条件套在了所有工具上、且审批响应消息序列不合法。详见 `T0-p0-fixes.md` §T0.4 §1。整个 test suite 是绿的，因为没有任何一条测试让 agent 真的调用过工具。

```
T0 ──> T1 ──> T2 ──> T3 ──> T4
       （T1 定契约，T2 改产出方，T3 改消费方；顺序不可换）
```

**为什么 T1 在 T3 之前**：`session.ts` 把历史里的 `tool_use / tool_result` 全丢了（见 T1 §1），第二轮起模型看不见自己上一轮的工具轨迹——这是功能缺陷；前端流式顿挫是体验问题。功能优先。

**为什么 T2 在 T3 之前**：T2 会改变落库时机与事件产出，先做前端等于重写两次。

---

## 1. 给实现模型的执行契约（每个任务开工前必读）

### 1.1 硬性流程

1. **一次只做一个 T，一个 T 一个 commit**。commit message 用 `refactor(scope): ...` / `fix(scope): ...`，正文写清改了什么、为什么。
2. 每个 T 内部按 spec 给出的**步骤序号**执行，不跳步。
3. 每完成一个步骤，跑：
   ```bash
   pnpm typecheck && pnpm test
   ```
   **不绿不进入下一步**。绿了再往下。
4. spec 里标 `【测试先行】` 的步骤：先写测试并确认它**失败**（RED），再写实现（GREEN）。
5. 每个 T 结束时对照该文档末尾的 **验收 Checklist** 逐条自查，把结果写进 commit 正文。

### 1.2 硬性边界

- **只改 spec 的「涉及文件」清单里列出的文件**。需要动清单外的文件时：停下来，说明原因，等确认。
- **不做 spec 之外的"顺手优化"**。看到别的问题记录到 `docs/plans/r1/FINDINGS.md`（没有就新建，只追加），不要顺手改。
- **spec 与代码不符时停下来报告**，不要自行发挥。spec 里的代码是设计意图的表达，行号/细节可能有偏差；结构和决策不许改。
- **不许删测试来让 CI 变绿**。测试挂了要么是实现错，要么是测试该改——后者必须在 commit 正文说明理由。

### 1.3 本仓库的 TypeScript 约束（最容易踩）

`tsconfig.base.json` 开了以下选项，写代码时必须遵守：

| 选项 | 后果 | 正确写法 |
|---|---|---|
| `exactOptionalPropertyTypes` | 不能给可选属性显式传 `undefined` | `...(x !== undefined ? { x } : {})` |
| `noUncheckedIndexedAccess` | `arr[0]` 类型是 `T \| undefined` | 先判空，或用 `arr[0]!`（有把握时） |
| `verbatimModuleSyntax` | 类型导入必须写 `import type` | `import type { Foo } from "..."` |
| `module: NodeNext` | 相对导入必须带 `.js` 后缀 | `from "./foo.js"` |
| `strict` | 无隐式 any | 显式标注 |

### 1.4 本仓库的代码风格（跟随，不发明）

- 文件名 kebab-case（`agent-factory.ts`），不用 PascalCase 文件名。
- 接口字段优先 `readonly`；数据结构不可变更新（spread），不原地 mutate。
- 单文件 200–400 行为宜，800 行是上限。超了先拆。
- 注释写「为什么」不写「做什么」；实测常量必须注释取值理由。
- 服务端不用 `console.log`，用 `request.log` / pino logger。
- 新增测试放 `tests/` 根目录，文件名 kebab-case，风格照 `tests/agent-runtime.test.ts`（DB 用 `initDb({dbPath:":memory:"})` + `migrateDb`）和 `tests/lead-agent-abort.test.ts`（模型用 `MockLanguageModelV4` + `simulateReadableStream`）。

### 1.5 已知的坑

- `tests/api-phase1.test.ts` 从 `../apps/server/node_modules/fastify/fastify.js` 导入 Fastify（workspace hoisting 导致），新增 API 测试照抄这个 import 路径。
- 数据库迁移是**手写 SQL + 手写 journal 条目**（`meta/` 只有 0000–0005 的 snapshot，之后都没有）。新增迁移见 T1 §3 的步骤。
- 本地开发库在 `~/.eva/eva.db`（`.gitignore` 已忽略）。破坏性迁移期间直接删库重来，无线上数据负担。
- SSE 路由不能被任何 compression/buffer 中间件包住。

---

## 2. 本轮不做（Out of Scope，防止范围蔓延）

1. 扩展宿主 / 槽位（S6）、MCP（S8）、Git 面板（S9）。
2. 子代理 fork-join 完整语义（S7）。**T4 会把现有半成品 `task` 工具摘掉**，S7 再一次做对。
3. 记忆系统的文件三层（`MEMORY.md` / `SOUL.md` / 日记）与 sleep 整理（Phase E）。
4. 桌面化补完（electron-updater / 托盘 / 深链，S11）。
5. 版本树的**前端交互**（重新生成 / 版本切换 UI）。T1 只把 `parent_id / slot_id / depth` 三件套的**数据地基**打好，UI 留到后续切片。
6. docs 14 §5.3 的三级投递台账与 §5.5 late-arrival 窗口——**本轮明确降级**，理由见 T4 §3。

---

## 3. 验收总表

| 任务 | 一句话验收 |
|---|---|
| T0 | **只读工具能跑通**（当前跑不通）；UI 里换模型立刻生效；重启后语义检索仍可用；未配 `TARGET_REPO_ROOT` 时无 fs 工具；危险工具弹一次审批卡片、允许后真的执行且正文不重复、abort 时 pending 审批立刻被拒 |
| T1 | DB `messages.message` 列 `JSON.parse` 后是 `{id, role, parts[]}`；第二轮对话模型能引用上一轮的工具结果；`runs` 表每次执行一行且有终态 |
| T2 | `lead-agent.ts` < 400 行，无手写 step 循环 / 无 `appendStepMessages` / 无 `splitInstructionsAndMessages`；现有 97 项测试全绿 |
| T3 | token 突发不顿挫、只尾块重渲；100+ 消息滚动流畅；审批卡片由 SSE 推送（无轮询）；目录符合 `docs/architecture/10-frontend-conventions.md` |
| T4 | `AGENTS.md` 里列的每个环境变量、每个 SSE 事件名、前端目录树都能在代码里逐条对上（当前四处对不上）；`task`/subagent 半成品已摘除；`docs/plans/README.md` 区分了历史文档与在用 spec |
