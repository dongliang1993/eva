# T6 · 工作区（S3）

> 前置：T5。
> 上游依据：`docs/architecture/15-eva-execution-playbook.md` §S3、`14-eva-architecture.md` §7.2/§7.3。
> 读之前先读 `00-overview.md` §3 与 `../r1/00-overview.md` §1 执行契约。
> 建议拆 **3 个 commit**：`feat(data)` 表与解析 → `feat(server)` per-run 注入与路由 → `feat(web)` 选择器与目录选择。

---

## 1. 问题实证

R1 T0.3 为了安全把 fs 工具的工作区根做成**必须显式配置**，配置入口是环境变量：

```ts
// deps.ts:51 —— 装配期解析一次,存进 infra
const workRoot = resolveWorkRoot(config.TARGET_REPO_ROOT, logger);
```
```ts
// agent-factory.ts:77 —— 每个 run 都用同一个进程级 workRoot
...(this.infra.workRoot !== undefined ? { workRoot: this.infra.workRoot } : {})
```

四个后果：

1. **桌面端用户没有任何途径开启文件能力。** 打包后的 app 里没有 `.env.local` 可改；`TARGET_REPO_ROOT` 空 → `resolveWorkRoot` 返回 null → `createConfiguredAgent` 不注入 read/write/edit/bash/grep/list。装完就是一个不能碰文件的聊天框。这是 R1 留下的唯一**产品级回退**。
2. **一个进程只能有一个工作区。** 想让 A 会话在仓库 X 干活、B 会话在仓库 Y，做不到——得改 env 重启。
3. **`CLAUDE.md` / `AGENTS.md` 没有注入。** agent 对项目约定一无所知，每轮都要用户口述。
4. **工具溢出文件写进用户仓库**（D9）：`agent.ts:229` 把 overflow 目录设成 `{workRoot}/.eva/tool-output`，往用户的项目里拉屎；docs 14 §7.3 定的位置是 `~/.eva/` 下。

附带一个命名地雷（D7）：`services/workspace/index.ts` 里的 `findWorkspaceRoot` 找的是 **pnpm monorepo 根**（认 `pnpm-workspace.yaml`），跟本任务引入的"工作区"领域概念同名不同义。被 `deps.ts`（找 skills 目录）和 `config.ts`（找 `.env` 目录）用着。

---

## 2. 目标设计

### 2.1 领域模型

```
Workspace  一个本地目录：id / name / path / createdAt / updatedAt
     ▲
     │ workspace_id（可空）
  Session
```

- **工作区是显式实体，不是环境变量。** 用户在 UI 里添加一个本地目录 → 落 `workspaces` 表。
- **会话绑定工作区**（`sessions.workspace_id`，可空）。空 = 这个会话没有文件能力（纯聊天），这是合法状态，不是错误。
- **fs 工具按 run 注入**：`AgentFactory.resolve({ workspace })`。同一进程里 A 会话在 X、B 会话在 Y，各跑各的。
- **路径校验只有一处**：`assertUsableWorkspacePath()`。添加工作区时校验一次（快速失败给用户看得懂的错），每次 run 解析时再校验一次（目录可能被删/改名）。工具内部的越界防护继续用已有的 `resolve-workspace-path.ts`——那是第二道防线，两道各管一层，不是重复。

### 2.2 表设计：只建现在有读取方的列

docs 14 §7.2 给的 `workspaces` 列表里有 `is_temporary / is_worktree / parent_workspace_id / worktree_branch / pr_number / pr_url`——这些是 **S9（Git 面板 / worktree 隔离）** 的字段。**本轮一列都不建。**

理由：T10 正在删 `sessions` 表 4 个从来没被读过的列（D6）。为一个还没排期的功能预建 6 个空列，等于一边清债一边造新债。等 S9 落地时 `ALTER TABLE ADD COLUMN` 是 SQLite 上最安全的增量操作，成本几乎为零。

### 2.3 overflow 目录归位

```
~/.eva/
├── eva.db (+ -wal/-shm)
└── tool-overflow/<workspaceId>/*.log     ← 从 {workRoot}/.eva/tool-output 搬来
```

按 workspaceId 分子目录，这样"哪个项目的哪次溢出"一眼能看出来，也不会互相覆盖。同时把 `~/.eva` 这个路径抽成 `apps/server/src/paths.ts` 的单一事实源——现在它硬编码在 `db/index.ts` 的 `DEFAULT_DATA_DIR` 里，T9（MCP 要读 `~/.eva/mcp.json`）还会再用一次。

### 2.4 项目文档注入

工作区根下的 `CLAUDE.md` 与 `AGENTS.md`（存在几个读几个）拼成一个 prompt section 注入 system prompt。

- **有大小上限**（合计 16 KB，超出截断并在正文尾部标注）。理由：这两个文件是人写的，没有任何机制阻止它长到 200 KB；system prompt 每轮都全量进模型，失控的成本是持续的。
- **每个 run 读一次，不做缓存。** 两个小文件的 `readFile` 是微秒级；引入 mtime 缓存反而多一个失效 bug 的来源。若将来实测成为热点再优化，届时注释写清实测数据。

---

## 3. 涉及文件

### 3.1 数据层

| 文件 | 动作 |
|---|---|
| `apps/server/src/db/migrations/0016_workspaces.sql` | 新增 |
| `apps/server/src/db/migrations/meta/_journal.json` | 改：追加 idx 16 |
| `apps/server/src/db/schema.ts` | 改：新增 `workspaces` 表；`sessions` 加 `workspaceId` |
| `apps/server/src/db/repositories/workspace-repository.ts` | 新增 |
| `apps/server/src/db/repositories/types.ts` | 改：`Session` 加 `workspaceId`；`CreateSessionInput` 加可选 `workspaceId` |
| `apps/server/src/db/repositories/session-repository.ts` | 改：`create` 支持 workspaceId；新增 `updateWorkspace` |

### 3.2 服务层

| 文件 | 动作 |
|---|---|
| `apps/server/src/paths.ts` | 新增：`evaDataDir()` / `toolOverflowDir(workspaceId)` |
| `apps/server/src/services/workspaces/workspace-store.ts` | 新增：CRUD + `resolveWorkspaceForSession` |
| `apps/server/src/services/workspaces/workspace-guard.ts` | 新增：`assertUsableWorkspacePath` |
| `apps/server/src/services/workspaces/project-docs.ts` | 新增：`loadProjectDocsSection` |
| `apps/server/src/services/workspaces/index.ts` | 新增：re-export |
| `apps/server/src/services/workspace/index.ts` | **删除**（内容搬到下一行） |
| `apps/server/src/services/monorepo-root.ts` | 新增：`findMonorepoRoot`（原 `findWorkspaceRoot`，D7） |
| `apps/server/src/config.ts` | 改：删 `TARGET_REPO_ROOT`；import 换 `findMonorepoRoot` |
| `apps/server/src/deps.ts` | 改：删 `resolveWorkRoot` 与 `infra.workRoot`；import 换 `findMonorepoRoot` |
| `apps/server/src/types/common.ts` | 改：`AppInfrastructure` 删 `workRoot`；`AppServices` 加 `workspaces` |
| `apps/server/src/services/index.ts` | 改：装配 `WorkspaceStore` |
| `apps/server/src/agent.ts` | 改：`ConfiguredAgentOptions.workRoot` → `workspace`；overflow 目录改 `toolOverflowDir()`；注入 project-docs section |
| `apps/server/src/services/agent-factory.ts` | 改：`resolve({ workspace })` |

### 3.3 路由与前端

| 文件 | 动作 |
|---|---|
| `apps/server/src/routes/workspaces.ts` | 新增 |
| `apps/server/src/routes/index.ts` | 改：注册 |
| `apps/server/src/routes/threads.ts` | 改：`PUT /threads/:id/workspace`；`ThreadSummary` 带 `workspaceId` |
| `apps/server/src/routes/runs.ts` | 改：session/workspace 先解析，再解析 agent（见 §4 Step 6） |
| `packages/shared/src/index.ts` | 改：`Workspace` / `WorkspaceInput` 类型；`ThreadSummary.workspaceId` |
| `apps/web/src/features/workspaces/api.ts` | 新增 |
| `apps/web/src/features/workspaces/hooks/use-workspaces.ts` | 新增 |
| `apps/web/src/features/workspaces/components/workspace-picker.tsx` | 新增 |
| `apps/web/src/features/threads/components/chat-input/index.tsx` | 改：挂 picker |
| `apps/web/src/features/threads/chat-page.tsx` | 改：串工作区状态 |
| `apps/desktop/electron/main.ts` | 改：`dialog:pick-directory` IPC |
| `apps/desktop/electron/preload.ts` | 改：暴露 `pickDirectory` |
| `.env.example` / `.env.local` | 改：删 `TARGET_REPO_ROOT` |
| `tests/workspaces.test.ts` | 新增 |
| `tests/agent-factory.test.ts` | 改：workRoot → workspace |

---

## 4. 步骤

### Step 1 · 【测试先行】`assertUsableWorkspacePath` 的边界

新建 `tests/workspaces.test.ts`，先只写 guard 的用例（用 `node:fs.mkdtempSync` 造真目录）：

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertUsableWorkspacePath } from "../apps/server/src/services/workspaces/workspace-guard.js";

describe("assertUsableWorkspacePath", () => {
  it("接受一个存在的普通目录,返回绝对路径", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eva-ws-"));
    expect(assertUsableWorkspacePath(dir)).toBe(path.resolve(dir));
  });

  it("相对路径被解析成绝对路径", () => { /* ... */ });
  it("空串被拒", () => expect(() => assertUsableWorkspacePath("  ")).toThrow());
  it("不存在的目录被拒", () => { /* ... */ });
  it("文件(非目录)被拒", () => { /* mkdtemp + writeFileSync 一个文件,传文件路径 */ });
  it("家目录被拒", () => expect(() => assertUsableWorkspacePath(os.homedir())).toThrow());
  it("文件系统根被拒", () => expect(() => assertUsableWorkspacePath("/")).toThrow());
});
```

跑一遍确认 RED（模块还不存在）。

### Step 2 · guard + paths

`apps/server/src/paths.ts`：

```ts
import os from "node:os";
import path from "node:path";

/** Eva 的用户数据目录 —— DB、tool-overflow、mcp.json 的唯一根(docs 14 §7.3)。 */
export const evaDataDir = (): string => path.join(os.homedir(), ".eva");

/**
 * 工具超长输出的落盘目录。
 * 按 workspaceId 分目录:溢出日志属于"哪个项目的哪次调用"要一眼能看出来。
 * 不再落在用户仓库内 —— agent 不应该往用户的项目里写自己的运行时垃圾。
 */
export const toolOverflowDir = (workspaceId: string): string =>
  path.join(evaDataDir(), "tool-overflow", workspaceId);
```

`db/index.ts` 的 `DEFAULT_DATA_DIR` 改成调 `evaDataDir()`（删掉本地的 `os.homedir()` 拼接）。

`services/workspaces/workspace-guard.ts`：

```ts
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 工作区路径不合法 —— 由路由转成 400 给用户看。 */
export class UnusableWorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableWorkspacePathError";
  }
}

/**
 * 校验并规范化一个工作区路径。
 *
 * 为什么家目录/根目录一律拒:agent 在这里跑 bash/write 是不可见的危险
 * —— 能力缺失是可见的(用户会来问"为什么不能读文件"),
 * 指向错误目录的能力是不可见的(等发现时文件已经改了)。
 * 这条规则从 R1 的 deps.ts:resolveWorkRoot 继承而来,现在只剩这一个落点。
 *
 * @returns 规范化后的绝对路径
 * @throws UnusableWorkspacePathError
 */
export const assertUsableWorkspacePath = (raw: string): string => {
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new UnusableWorkspacePathError("工作区路径不能为空。");
  }

  const absolute = path.resolve(trimmed);

  if (!existsSync(absolute)) {
    throw new UnusableWorkspacePathError(`目录不存在:${absolute}`);
  }

  if (!statSync(absolute).isDirectory()) {
    throw new UnusableWorkspacePathError(`不是目录:${absolute}`);
  }

  if (absolute === os.homedir() || absolute === path.parse(absolute).root) {
    throw new UnusableWorkspacePathError(
      "工作区不能是家目录或文件系统根 —— 请选一个具体的项目目录。"
    );
  }

  return absolute;
};
```

跑 `pnpm test tests/workspaces.test.ts` → GREEN。

### Step 3 · 迁移与 schema

`0016_workspaces.sql`：

```sql
-- 工作区(docs 15 §S3)。列只建现在有读取方的 —— worktree / PR 相关列留给 S9,
-- 现在建等于给 T10 正在删的死列再添几个。
CREATE TABLE IF NOT EXISTS `workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `path` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
-- 同一个目录不允许重复添加:否则"当前工作区"下拉框里出现两个同名项,
-- 用户无法分辨,而它们的 tool-overflow 目录却是分开的。
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workspaces_path` ON `workspaces` (`path`);
--> statement-breakpoint
-- 会话绑定工作区;NULL = 该会话没有文件能力(合法状态)。
ALTER TABLE `sessions` ADD COLUMN `workspace_id` text REFERENCES `workspaces`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_workspace_id` ON `sessions` (`workspace_id`);
```

> `ON DELETE SET NULL`：删工作区不该连带删聊天记录。`foreign_keys = ON` 已在 pragma 里开着（`db/index.ts:configurePragmas`），这条会真的生效。

journal 追加 idx 16（`when` 取大于 0015 的整数）。

`schema.ts`：

```ts
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`)
  },
  (table) => [uniqueIndex("idx_workspaces_path").on(table.path)]
);
```

`sessions` 表加 `workspaceId: text("workspace_id")` 与 `index("idx_sessions_workspace_id")`。

### Step 4 · repository 与 store

`db/repositories/workspace-repository.ts`：`create / findById / findByPath / listAll / rename / deleteById`。照 `session-repository.ts` 的写法（drizzle `.get()/.all()/.run()`），不要引入新风格。

`services/workspaces/workspace-store.ts`：

```ts
export class WorkspaceStore {
  constructor(private readonly repo: DrizzleWorkspaceRepository) {}

  list(): readonly Workspace[] { ... }

  /**
   * 添加一个工作区。path 先过 guard,再按规范化后的绝对路径查重
   * —— 同一目录用不同写法(`~/p` vs `/Users/x/p` vs `/Users/x/p/`)提交
   * 必须命中同一条记录,否则唯一索引形同虚设。
   */
  add(input: { path: string; name?: string }): Workspace {
    const absolute = assertUsableWorkspacePath(input.path);
    const existing = this.repo.findByPath(absolute);

    if (existing) {
      return existing;
    }

    return this.repo.create({
      id: randomUUID(),
      path: absolute,
      name: input.name?.trim() || path.basename(absolute)
    });
  }

  rename(id: string, name: string): Workspace | undefined { ... }
  remove(id: string): boolean { ... }
}

/**
 * 解析一次 run 该在哪个目录里干活。
 *
 * 返回 undefined 有两种情形,都不是错误:
 * ① 会话没绑工作区(纯聊天);② 绑的工作区目录已经不在了(用户删了/改名了)。
 * 后者记一条 warn —— 静默降级成"没有文件工具"会让用户以为 agent 坏了。
 */
export const resolveWorkspaceForSession = (
  store: WorkspaceStore,
  session: Session,
  logger: Logger
): Workspace | undefined => { ... };
```

### Step 5 · project docs section

`services/workspaces/project-docs.ts`：

```ts
/** 项目约定文件的读取顺序;都存在就都注入(CLAUDE.md 常常只是指向 AGENTS.md)。 */
const PROJECT_DOC_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/**
 * 注入上限 16 KB。system prompt 每轮全量进模型,而这两个文件是人写的、
 * 没有任何机制阻止它长到几百 KB —— 失控的是持续成本,不是一次性成本。
 */
const MAX_PROJECT_DOCS_BYTES = 16 * 1024;

/**
 * 把工作区根下的项目约定文件读成一个 prompt section。
 * 一个文件都没有 → 返回 undefined(不要注入空标题,那是给模型的噪音)。
 */
export const loadProjectDocsSection = async (
  workspaceRoot: string
): Promise<PromptSection | undefined> => { ... };
```

section 形状（`heading` + `body`，`prompt-builder.ts` 会渲染成 `## <heading>`）：

```
## Project Context

The user's workspace is `/abs/path`. The project ships the following conventions —
follow them; they override your defaults.

### CLAUDE.md
<内容>

### AGENTS.md
<内容>
```

截断时在末尾追加 `\n\n[truncated at 16KB — read the file with the read_file tool for the rest]`——给模型一条自救路径，而不是让它以为文件就这么长。

### Step 6 · agent 装配改成 per-workspace

`agent.ts` 的 `ConfiguredAgentOptions`：

```ts
export interface ConfiguredAgentOptions {
  readonly skills: Skill[];
  readonly soulSection?: PromptSection | undefined;
  readonly observer?: AgentObserver | undefined;
  readonly requestApproval?: RequestApproval | undefined;
  /** 本次 run 的工作区;缺省则不注入 fs 工具(纯聊天会话)。 */
  readonly workspace?: ResolvedWorkspaceContext | undefined;
}

/** 一次 run 的工作区上下文 —— 路径 + 已读好的项目文档 section。 */
export interface ResolvedWorkspaceContext {
  readonly id: string;
  readonly root: string;
  readonly docsSection?: PromptSection | undefined;
}
```

`createConfiguredAgent` 内部：

```ts
if (workspace) {
  const overflowDir = toolOverflowDir(workspace.id);
  tools.push(
    createReadFileTool({ workRoot: workspace.root, overflowDir }),
    // ... 其余五个同样传 workspace.root
  );
}
```
```ts
const sections: PromptSection[] = [
  ...(soulSection ? [soulSection] : []),
  ...(workspace?.docsSection ? [workspace.docsSection] : []),
  MEMORY_PROMPT_SECTION,
  // ...
];
```

> harness 侧 fs 工具的参数名 `workRoot` **不改**——那是工具自己的局部概念（"我能碰的根"），跟领域实体 Workspace 不是一回事。改了反而让 `resolve-workspace-path.ts` 的语义变模糊。

`agent-factory.ts`：`AgentResolveOptions` 加 `readonly workspace?: ResolvedWorkspaceContext | undefined;`，透传进 `createConfiguredAgent`；`this.infra.workRoot` 那一行删掉。

`deps.ts`：删 `resolveWorkRoot` 整个函数与 `workRoot` 字段；`findWorkspaceRoot` → `findMonorepoRoot`。`config.ts`：删 `TARGET_REPO_ROOT`，import 同改。`types/common.ts`：`AppInfrastructure` 删 `workRoot`，`AppServices` 加 `workspaces: WorkspaceStore`。

### Step 7 · `routes/runs.ts` 的解析顺序重排

**这一步是本任务最容易出错的地方，先看清楚为什么必须重排。**

当前顺序是「解析 agent → prepareRun（建会话）」。但工具注入需要工作区，工作区来自会话，会话在 `prepareRun` 里才建 —— 和 T5 修掉的 `sessionId = ""` 是同一类循环。

新顺序（三段，各自只回答一个问题）：

```
① openSessionTurn(app, body, runId)
   → 建/取会话 + 落用户消息 + 解析工作区（含 project docs）
   → { session, workspace }                        「这次对话发生在哪」

② app.services.agents.resolve({ requestedModelId, requestApproval, workspace })
   → { agent, mainModel }                          「用哪个模型、带哪些工具」

③ buildRunContext(app, session, mainModel, body.text)
   → { modelMessages, additionalTools, context }   「模型这轮看见什么」
      （compact 判定 + buildModelHistory + memory runtime，都需要 mainModel 的窗口信息）
```

配套改动：

- **用户消息的 metadata 去掉 `model`。** 它现在是 `createUserUIMessage(id, text, { runId, model })`——但模型是 ② 才知道的，而且"用户消息的模型"本身没有意义（模型属于 assistant 消息与 `runs.model`，两处都已记录）。改成只带 `{ runId }`。这不是妥协，是删掉一个本来就不该有的字段。
- **`AgentUnavailableError` 的回滚。** 新顺序下 ② 抛 503 时，会话与用户消息已经落库了。全新安装（没配 API key）每点一次发送就多一条垃圾会话。所以在 catch 里显式回滚：

```ts
} catch (error) {
  // 模型不可用(503)且这条会话是本次请求刚建的 → 撤掉,别让没配好 API key 的
  // 新装用户每点一次发送就攒一条空会话。已有会话不动:用户说的话得留下。
  if (error instanceof AgentUnavailableError && createdSessionId) {
    new DrizzleSessionRepository(app.infra.db).deleteById(createdSessionId);
  }
  // ... 原有错误处理
}
```
（`messages` 表对 `sessions.id` 是 `ON DELETE cascade`，用户消息随之清掉。）

- `runs.start(...)` 仍在 ② 之后 ③ 之前——run 台账只记真的跑起来的执行。

### Step 8 · REST

`routes/workspaces.ts`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/workspaces` | 列表 |
| POST | `/api/v1/workspaces` | `{ path, name? }` → 201；`UnusableWorkspacePathError` → 400 带原文 |
| PUT | `/api/v1/workspaces/:id` | `{ name }` 改名 |
| DELETE | `/api/v1/workspaces/:id` | 204；绑定它的会话 `workspace_id` 自动置 NULL |

`routes/threads.ts` 加：

| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | `/api/v1/threads/:id/workspace` | `{ workspaceId: string \| null }` → 更新绑定，返回 `ThreadSummary` |

`ThreadSummary` 加 `workspaceId: string | null`（`packages/shared`）。前端侧栏据此显示会话属于哪个项目。

错误消息一律**中文、面向用户**（guard 抛的原文直接透出）：路由层不要把 `目录不存在:/x/y` 改写成 `Invalid path`——用户需要知道是哪个路径不对。

### Step 9 · 桌面目录选择

`apps/desktop/electron/main.ts`（在已有的 `ipcMain.handle("get-server-port", ...)` 旁边）：

```ts
ipcMain.handle("dialog:pick-directory", async (): Promise<string | null> => {
  if (!mainWindow) {
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "选择工作区目录"
  });

  return result.canceled ? null : (result.filePaths[0] ?? null);
});
```
（`dialog` 加进顶部 `from "electron"` 的 import 列表。）

`preload.ts` 的 `electronAPI` 加：

```ts
pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pick-directory"),
```

前端 `workspace-picker.tsx` 的"添加工作区"：

- `window.electronAPI?.pickDirectory` 存在（桌面壳）→ 调原生对话框，拿到路径直接 POST。
- 不存在（浏览器里跑 `pnpm web:dev`）→ 显示一个路径输入框 + 提交按钮，后端校验，错误消息原样显示在框下。

**不要**用浏览器的 `showDirectoryPicker()`/`webkitdirectory`：前者给的是受限 handle 拿不到真实路径，后者会把整个目录的文件读进内存。服务端校验才是这里唯一的事实源。

### Step 10 · 前端选择器

`features/workspaces/`（新 feature 目录，符合 `docs/architecture/10-frontend-conventions.md`）：

- `api.ts` — 四个 REST 调用 + `setThreadWorkspace(threadId, workspaceId)`
- `hooks/use-workspaces.ts` — react-query：`useQuery(["workspaces"])` + add/rename/remove mutation（成功后 `invalidateQueries`）
- `components/workspace-picker.tsx` — 复用 `shared/ui/popover.tsx`，照 `chat-input/select-model/index.tsx` 的交互写法（列表 + 当前项打勾 + 底部"添加工作区…"）

挂载点：`chat-input` 里模型选择器旁边。当前会话没绑工作区时按钮显示"未选择工作区"（灰）；绑了显示 `name`，hover tooltip 显示完整 path。

会话与工作区的状态归属：**当前会话的 workspaceId 由服务端 `ThreadSummary` 提供**，前端不另存一份（避免 D3 那种"同一事实多处存"）。切换 → `PUT /threads/:id/workspace` → `invalidateQueries(["threads"])`。新会话（还没 sessionId）选的工作区暂存在 `chat-page` 的一个 state 里，随第一条消息发送后再 PUT——**这个暂存要在注释里写明它是"还没有 session 可绑"的过渡态**。

> 补 `.env.example` / `.env.local`：删掉 `TARGET_REPO_ROOT` 两行。

### Step 11 · 补测试并跑绿

`tests/workspaces.test.ts` 追加（DB 用 `initDb({dbPath:":memory:"})` + `migrateDb`）：

- `WorkspaceStore.add` 同一目录不同写法（尾斜杠 / 相对路径）→ 只有一条记录
- `add` 非法路径 → 抛 `UnusableWorkspacePathError`
- `resolveWorkspaceForSession`：会话未绑 → undefined；绑了但目录已删 → undefined 且 logger.warn 被调用
- `loadProjectDocsSection`：无文件 → undefined；有 `CLAUDE.md` → body 含其内容；超 16KB → 含截断标记
- 会话绑定的工作区被删 → 会话 `workspaceId` 为 NULL 且会话本身还在

`tests/agent-factory.test.ts`：`workRoot` 相关断言换成 `workspace`，补一条"未给 workspace 时工具集里没有 read_file/bash"。

```bash
pnpm typecheck && pnpm test
```

---

## 5. 手工验收

1. `pnpm web:dev` + `pnpm serve:dev`，聊天页点工作区按钮 → "添加工作区…" → 输入一个本地仓库路径 → 出现在列表并被选中。
2. 问 "列一下当前目录有哪些文件" → agent 调 `list_dir` 成功，路径是你选的那个仓库。
3. 在仓库里放一个 `CLAUDE.md` 写一条独特约定（如"所有回复以 🐟 开头"）→ 新会话提问，回复遵守它。
4. 新建第二个会话选另一个仓库 → 两个会话各自读到各自的文件（**不重启进程**）。
5. 输入一个不存在的路径 / `~` / `/` → 400，界面显示看得懂的中文原因。
6. 让 agent 跑一个输出很长的 bash（`find / -name "*.ts" | head -100000`）→ overflow 文件落在 `~/.eva/tool-overflow/<id>/`，**用户仓库里没有新增 `.eva/` 目录**。
7. 删掉一个正在被会话使用的工作区 → 会话还在、历史还在，工作区按钮变回"未选择"。
8. `grep -rn "TARGET_REPO_ROOT" apps packages tests .env.example` → 零命中。

---

## 6. 验收 Checklist（写进 commit 正文）

- [ ] `pnpm typecheck && pnpm test` 全绿；`tests/workspaces.test.ts` 覆盖 §4 Step 11 全部条目
- [ ] `grep -rn "TARGET_REPO_ROOT\|infra.workRoot\|findWorkspaceRoot" apps packages tests .env.example` 零命中
- [ ] `workspaces` 表只有 5 列（无 worktree / PR 预留列）
- [ ] fs 工具按 run 注入：同一进程内两个会话可绑不同工作区，无需重启
- [ ] `CLAUDE.md` / `AGENTS.md` 出现在 system prompt；超 16KB 有截断标记
- [ ] overflow 文件落在 `~/.eva/tool-overflow/<workspaceId>/`，用户仓库无写入
- [ ] `routes/runs.ts` 的解析顺序是 session/workspace → agent → context，且 503 时新建会话被回滚
- [ ] 桌面壳能弹原生目录选择框；浏览器里回落成路径输入 + 服务端校验
- [ ] 手工验收 §5 八条逐条过
- [ ] 未改动本文档 §3 涉及文件清单之外的文件

---

## 7. 补充：overflow 目录搬走之后，`read_file` 必须能读到它

> 本节是合并两版 spec 时补的。§2 把 overflow 目录从 `{workRoot}/.eva/tool-output` 搬到
> `~/.eva/tool-overflow/<workspaceId>/`（D9，方向正确），但这会让**工具溢出的自救路径失效**。

### 7.1 问题

`packages/harness/src/tools/fs/tool-overflow.ts:34-38` 返回给模型的是：

```
Output too long (12345 chars). Full output saved to:
/Users/me/.eva/tool-overflow/<id>/bash-...-1723...txt
Use read_file on that path (with offset/limit) to read it.
```

而 `read_file` 走 `resolveWorkspacePath(rel, workRoot)` —— 这个路径在工作区之外，会抛
`PathEscapeError`。搬走 overflow 目录之后，**这句指令变成一句模型做不到的话**：它会照着试，
拿到 "Path escapes the workspace"，然后要么放弃要么反复重试。

搬之前之所以没问题，恰恰是因为 overflow 落在工作区里（也就是 D9 那个毛病）。**两件事是一件事**，
只搬目录不动沙盒等于把一个能用的脏方案换成一个干净但坏掉的方案。

### 7.2 目标设计：只读白名单，只给 `read_file`

沙盒仍然只有一个概念（"路径必须落在某个允许的根之内"），只是允许的根从一个变成"工作区 + 显式白名单"，
且**白名单只对只读工具生效**。

`packages/harness/src/tools/fs/resolve-workspace-path.ts` 新增：

```ts
/**
 * 只读路径解析：允许落在 workRoot 内，或落在显式给出的额外只读根内。
 *
 * 为什么需要第二个根：工具溢出文件按设计落在用户数据目录（~/.eva/tool-overflow/），
 * 不在工作区里；而 maybeOverflow 明确告诉模型"用 read_file 去续读它"。
 * 不给这条缝，那句指令就是谎话。
 *
 * 写工具（write / edit / bash）**不使用**本函数 —— 白名单只放开读，不放开写。
 */
export const resolveReadablePath = (
  input: string,
  workRoot: string,
  extraReadableRoots: readonly string[] = []
): string => {
  for (const root of [workRoot, ...extraReadableRoots]) {
    const resolved = path.resolve(root, input);

    if (isPathInsideWorkspace(resolved, root)) {
      return resolved;
    }
  }

  throw new PathEscapeError(input);
};
```

`FsToolBaseOptions` 加一个字段：

```ts
export interface FsToolBaseOptions {
  readonly workRoot: string;
  readonly overflowDir?: string;
  /** 只读工具额外可读的根（当前只有 overflowDir）。写工具不受它影响。 */
  readonly readableRoots?: readonly string[];
}
```

改动面**只有 `read-file-tool.ts` 一个文件**：`resolveWorkspacePath(rel, options.workRoot)`
换成 `resolveReadablePath(rel, options.workRoot, options.readableRoots ?? [])`。
`list-dir` / `grep` / `write` / `edit` / `bash` 一律不动 —— 让模型能读回自己的溢出文件就够了，
不需要在那个目录里列目录或搜索。

`createConfiguredAgent` 注入时：

```ts
const overflowDir = toolOverflowDir(workspace.id);
tools.push(
  createReadFileTool({ workRoot: workspace.root, overflowDir, readableRoots: [overflowDir] }),
  createListDirTool({ workRoot: workspace.root, overflowDir }),
  // 其余四个同样只传 workRoot + overflowDir
);
```

### 7.3 测试（加进 `tests/fs-tools.test.ts`）

- `read_file` 读工作区内文件 → 正常；
- `read_file` 读 `readableRoots` 里的文件 → 正常；
- `read_file` 读两者之外的绝对路径（如 `/etc/hosts`）→ `PathEscapeError`；
- `write` / `edit` / `bash` 拿 `readableRoots` 里的路径 → **仍然拒绝**（白名单不放开写）；
- 端到端：让 bash 产出超 `OVERFLOW_LIMIT` 的输出 → 用返回文本里的路径调 `read_file` → 读到内容。

最后一条是这一节存在的理由，必须有。

### 7.4 §6 Checklist 追加

- [ ] `read_file` 能读回 `~/.eva/tool-overflow/<id>/` 下的溢出文件；`write`/`edit`/`bash` 对同一路径仍拒绝
- [ ] `tests/fs-tools.test.ts` 有一条"溢出 → 按返回路径续读成功"的端到端用例
