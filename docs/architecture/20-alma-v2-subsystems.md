# 20 · v2 新增子系统规格（Alma v0.0.990）

> 调研对象：Alma v0.0.990（2026-08-21 构建）
> 证据文件：`/tmp/alma-extract/main.readable.js`（主进程+后端 bundle，约 107,800 行，文中行号均指此文件）、`/tmp/alma-extract/routes-all.txt`（497 条路由）、`/tmp/alma-extract/tables-all.sql`（全部建表原文）、`/Applications/Alma.app/Contents/Resources/bundled-skills/*/SKILL.md`。
> 本文是**施工规格书**：逐个子系统给出「是什么 / 数据模型 / 核心流程 / 对外接口 / 关键实现细节 / 复刻要点」六段式。所有关键论断标注 bundle 行号或文件路径。
> 前置阅读：03（后端与数据库总览，v0.0.175 基线）、08（fork-join 多代理）、09-persistence-recovery（事件溯源）。本文只写 **v0.0.990 新增或重构**的子系统；agent 内核、记忆、流式协议的增量见姊妹篇。

## 0. 子系统全景与公约数

v0.0.990 相对 v0.0.175 净增约 20 个子系统组、40+ 张新表。一张表看清谁是谁：

| 子系统 | 路由数 | 存储 | 形态 |
|---|---|---|---|
| workspaces + git + preview | 64 | `workspaces` / `preview_servers` / `thread_diff_stats_cache` 表 + 文件系统 | 主进程服务 + WS 推送 |
| iab 内置浏览器 | 32 | 无表 | Electron WebContents + CDP |
| 子代理 TaskManager | 3（/api/agents） | `tasks.json` 文件 + `agent_missions` 表族 | 文件持久化 + DB  crew 编排 |
| plan-mode / Plan Weave | 3 + 11 | `<workspace>/.alma/plan/` 文件 | 文件型状态机 + skill 驱动 |
| prompt-apps | 8 + 2 | `prompt_apps` / `prompt_app_executions` 表 | DB + 独立窗口 runner |
| plugins | 14 + 4 | `plugins` / `plugin_permissions` / `plugin_state` 表 + `~/.config/alma/plugins/` | Bun 编译的扩展宿主 |
| refs | 21 | `reference_links` / `reference_snippets` 表 | `alma://` URI 双链图谱 |
| terminal | 6 + WS | 内存 scrollback | node-pty |
| remote-hosts | 6 | `remote_hosts` 表 | SSH ControlMaster |
| cloud-sync | 4 | `cloud-sync.json` + iCloud 目录 | 单向快照导出 |
| mobile-relay | 8 | settings | WS 隧道 + E2E |
| channels | 10+9+3+7+2 | `channel_mappings` 表 | 每平台 bridge 类 |
| cron | 8 | `~/.config/alma/cron/jobs.json` | croner + WS 回环 |
| TTS / whisper | 11 + 3 | 模型文件 | bun worker / python sidecar / whisper.node |
| usage | 3 | `usage_records` / `usage_migration_status` 表 | 逐轮落表 + 聚合 |

**复刻的最大公约数**（区块 D 报告的总结论，全部行号可复核）：主进程内 Service 类或外部 sidecar 通过 `~/.config/alma/` 下的 JSON/Markdown 文件持久化状态，再经 loopback `ws://127.0.0.1:<port>/ws/threads` 的 `generate_response` 帧（`main.readable.js:55449`）驱动 agent 回合。「WS 回环驱动 + 映射表 + 文件状态」三件套是 cron、heartbeat、channels、mobile-relay 的共同骨架。

---

## 1. Workspaces + Git 集成 + Preview Server（64 路由，最大新增）

### 1.1 是什么

Workspace 是 v0.0.990 的**锚点对象**：一个本地或 SSH 远程目录，绑定 thread、挂 git、起预览服务器、喂给 agent 当 CWD。聊天不再是纯对话——每个 thread 都有一个「工作现场」。

### 1.2 数据模型

`workspaces` 建表原文（`tables-all.sql:669`，drizzle 终态 `main.readable.js:783-814`，增量列由 ALTER 迁移补齐）：

```sql
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    is_temporary INTEGER NOT NULL DEFAULT 0,
    show_in_list INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
-- ALTER 增量列：remote_host_id / is_session / is_worktree / parent_workspace_id /
--   worktree_branch / auto_worktree / auto_worktree_base_branch /
--   pr_number / pr_url / pr_state / pr_base_branch
```

关系（`main.readable.js:1115-1135`）：`workspaces 1:N chat_threads`（thread 侧 `workspace_id` 外键 `onDelete: "set null"`，`:828-833`；thread 还有第二个外键 `artifact_workspace_id` 给 artifacts 独立工作区）、`workspaces 1:N preview_servers (CASCADE)`、`parentWorkspace 1:N childWorktrees`（自引用 worktree 父子关系）。

`preview_servers`（`tables-all.sql:452`，原文缩进保留）：

```sql
CREATE TABLE IF NOT EXISTS preview_servers (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    port INTEGER NOT NULL,
    project_type TEXT NOT NULL,
    command TEXT NOT NULL,
    pid INTEGER,
    status TEXT NOT NULL DEFAULT 'stopped',
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

`thread_diff_stats_cache`（`tables-all.sql:604`）：`{id(TEXT PK=threadId), thread_updated_at, additions, deletions, files_changed, created_at, updated_at}`——thread 级 git diff 统计的缓存，键是 thread id、用 `thread_updated_at` 做失效判断，喂给 `GET /api/threads/:threadId/diff-stats`。

### 1.3 四种 workspace 创建路径

1. **Default**：`getOrCreateDefaultWorkspace()`（`:7012`）→ `<userData>/workspaces/default`，`showInList: true`。删除保护：默认工作区不可删，有 thread 关联的不可删（400 + threadCount）。
2. **Session workspace**（每会话自动建目录）：`createSessionWorkspace(title, userMessage)`。根目录读 `settings.general.sessionWorkspaceRoot`（`:6919`），默认 `~/Documents/Alma`（用 Electron `app.getPath("documents")`）；子路径 `<root>/<YYYY-MM-DD>/<slug>`，slug 由 `slugifySessionName`（`:6929`）从首条用户消息生成（40 字符上限、重名追加 `-2`/`-3`），另有 LLM 辅助 slug 生成路径（日志 `[SlugGen] Generated session-workspace slug`）。目录下**预建 `outputs/`、`work/`、`tmp/` 三个子目录**——这个约定同时出现在 system prompt 的 OUTPUTS CONVENTION 段（`89142` 的 WORKING DIRECTORY 注入原文）。DB 行 `isSession: true, showInList: false`。
3. **Temp workspace**：`isTemporary: true`，删除时连目录 `rmSync`。
4. **Artifact workspace**：`<userData>/artifacts/<id>`。
5. **Worktree workspace**：见 §1.5。

### 1.4 文件 API 与 WS 文件树

路由注册区间 `main.readable.js:77886-77933`。要点：

- `GET /:id/files?showHiddenFiles` 递归文件树；`GET /:id/files/{*filePath}?maxBytes` 读文本，路径穿越返回 403（`"Path traversal detected"`，`:44693,44733`）。
- `GET /:id/files-binary/{*filePath}`：二进制；**remote workspace 走 SSH RPC**：`call("readFile", {path})` 返回 base64 → 落临时文件 → `serveFileBytes` → 响应结束后删除。
- `POST files/touch|mkdir|rename|copy|move`、`DELETE files/{*filePath}`。
- `GET /api/files-abs`、`/api/files-abs-binary`：绝对路径读取（`77900-77905`）。
- **WS 实时文件树** `/ws/workspace/<id>`（`85593-85657`）：连接即推 `{type:"file_tree_sync", files}`（`85615`），随后 fs.watch 变化推 `{type:"file_change", eventType, path, timestamp}` 并 1s 防抖重推全树；客户端可发 `{type:"set_show_hidden_files"}`。**remote workspace 不挂 watcher**。

### 1.5 Git / worktree / GitHub 集成（约 50 条路由的重头戏）

实现是 **shell 调系统 git**：`uO(dir, args, timeout)` → `execFile("git", args)`。例如 `getGitStatus` 解析 `git status --porcelain=v2 --branch -u`（`:96784`），返回 `{isGitRepo, branch, upstream, ahead, behind, staged[], unstaged[], conflicted[]}`。worktree 列表解析 `git worktree list --porcelain`（`:97709`）。

**Auto-worktree 决策链**（v0.0.990 最有差异化的功能，`:88290-88420`）：thread 首条消息时检查 `thread.metadata.useWorktree ?? workspace.autoWorktree`（读取与判定在 `:88301-88303`），若为 true 且 workspace 是 git repo、非 worktree、非 remote：

1. `generateWorktreeName()`（`:86448`）用 unique-names-generator（import 于 `:341`）生成 `adjective-animal` 风格名字；
2. 基于 `autoWorktreeBaseBranch` 或 **remote 默认分支**（`git fetch` + `git remote set-head <remote> --auto` 探测，`:88336-88367`）建 worktree 到 `getWorktreeBaseDir()/<workspace-name-slug>/<worktree-name>`；
3. 后台跑依赖安装；
4. 插入新 workspace 行（`isWorktree: true, parentWorkspaceId, worktreeBranch`），把 thread 的 `workspaceId` 切过去，广播 `workspace_created` + `thread_updated`；
5. 之后用 LLM 从用户消息生成更有语义的分支名并重命名。

`git init` 会写一份内置 `.gitignore` 模板（含 `.alma-attachments/`、`.alma-snapshots/`、`node_modules/` 等）。

**AI 解冲突**：`POST /:id/git/conflicts/resolve-ai` 与 `resolve-all-ai`（注册于 `78110-78114`）。冲突内容提取用 `git show :1:path / :2:path / :3:path`（base/ours/theirs 三阶段），返回 `{path, oursContent, theirsContent, baseContent, conflictMarkers}` 交给模型。

**GitHub PR**：`/:id/github/pr`（GET/POST）、`pr/merge`、`pr/close`、`pr/refresh`、`ci-logs`（`78062-78083`）；PR 状态回写 workspace 行的 `prNumber/prUrl/prState/prBaseBranch`。

**Rebase 状态机**：`rebase/status`、`rebase`、`rebase/continue`、`rebase/abort`（`78086-78098`）。

**worktrunk**（2 条路由，`78121-78124`）：第三方 worktree 管理 CLI `wt`（github.com/max-sixty/worktrunk）的托管安装器——托管路径 `~/.alma/bin/wt`，install 从 GitHub releases 下 tar.gz 解压。属于锦上添花，不是核心路径。

### 1.6 Preview server 规格

路由：`preview/start|stop|status|detect|html-files`（`77936-77956`）；WS `/ws/preview/<workspaceId>` 推 `{type:"preview_status", ...serverInfo}`（`85671,85678`）。

**项目探测** `detectProjectType`（`:70293`）三档（本地与远程共用同一套判定，远程先把探针命令经 SSH 执行拿标记输出）：

| 探测结果 | 判定条件 | 启动命令 | readyPattern | 默认端口 |
|---|---|---|---|---|
| `bun-vite` | package.json 依赖含 `vite` | 按包管理器分派 `pnpm exec vite` / `yarn vite` / `bun x vite` / `npx --no-install vite` | `/Local:\s+http:\/\/localhost:(\d+)\|…127\.0\.0\.1…/` | 5173 |
| `bun-dev` | `scripts.dev` 存在 | `<pm> run dev -- --port __PORT__` | `/localhost:(\d+)\|http:\/\/[\w.]+:(\d+)/` | 3000 |
| `static` | 有 `index.html` 且有 `python3` | `python3 -m http.server` | `/Serving HTTP/` | 3000 |
| `unknown` | 以上皆非 | — | — | — |

包管理器判定靠远程探针输出里的 `__ALMA_PM_pnpm__/__ALMA_PM_yarn__/__ALMA_PM_bun__` 标记（`:70590-70600`），package.json 用 `__ALMA_PKG__ ... __ALMA_PKG_END__` 夹取。**远程 preview** 是在远端的 20000-40000 随机端口起服务、再 SSH 端口转发回本地 `findAvailablePort(defaultPort)` 的端口（`startRemoteServer`，`:70652-70690`：`command` 字段里直接写明 `forwarded ${localPort} ← ${remotePort}`）。远程探测失败时 `lastError` 原文（`:70676`）：

```
Could not detect a previewable project on the remote host. Needs a package.json with vite / a dev script (dependencies installed), or an index.html plus python3.
```

### 1.7 Agent 侧暴露

**没有独立的 "workspace tools"**——agent loop 的 CWD 就是 workspace path（`[Agent] CWD: ...`、`cwd: fw(e.workspacePath)`，`:30423-30427`），agent 直接用 Bash/Read/Write/Edit 作用于 workspace 目录。system prompt 的 WORKING DIRECTORY 段（`:89142`）明确告诉模型「这个目录就是你的项目根，文件会出现在文件树和版本快照里，别去 `~/` 或 `/tmp` 另起炉灶」。remote workspace 的 bash 命令经 SSH 执行（见 §9）。

### 1.8 复刻要点

- **最小切片**：`workspaces` 表（先不加 worktree/PR 列）+ thread 外键 + `GET /:id/files` + `/ws/workspace/<id>` 文件树推送 + session workspace 的 `<root>/<date>/<slug>/{outputs,work,tmp}` 目录约定。这个约定是「agent 产出物可见性」的关键，成本几乎为零。
- git 集成先做 `status/diff/commit/log` 四件就够日常；auto-worktree 是高价值差异化功能，但它的决策链（remote 默认分支探测 → LLM 改分支名）依赖整套 git shell 封装，放在第二阶段。
- **坑 1**：path traversal 检查不能省——`{*filePath}` 通配符直接进文件系统，Alma 自己也在两处做了检查（`:44693,44733`）。
- **坑 2**：preview 的 ready 判定是**正则匹配子进程 stdout**，不是端口探活——Vite/dev server 的输出格式变了就会挂；readyPattern 要随前端工具链升级维护。
- **坑 3**：remote 文件读取走 base64 中转 + 临时文件，大文件要注意内存；且 remote 不挂 fs.watch，前端文件树只能手动刷新。

---

## 2. iab 内置浏览器（32 路由）

### 2.1 是什么

iab = **In-App Browser**（应用内浏览器）。这不是推测——bundle 里的错误消息直接说人话（`main.readable.js:38243`）：

```
No in-app browser bound for workspace ${id}. Open the Preview panel first.
Multiple in-app browsers open; pass --workspace <id>
```

它是绑定到 workspace 的 Electron WebContents（artifact 侧栏 Preview 面板的 guest page），通过 **Electron debugger API（CDP 1.3）** 做全量浏览器自动化，主要消费者是 agent（经 CLI/HTTP 调用）和 CUA（computer-use agent）模式。

### 2.2 数据模型

无 DB 表。运行态是 `IabManager`（`class ak`，`:38160-38260`；单例 `pk = new ak()` 于 `:39658`）内存里的 target Map：

```js
{ workspaceId, webContentsId, wc /* WebContents */, dbg /* debugger */, engineInstalled }
```

### 2.3 核心流程

1. 前端打开 Preview 面板 → 渲染进程里的 `<webview>`/WebContentsView 创建 guest WebContents → IPC 调 `bindGuest(workspaceId, webContentsId)`：`webContents.fromId(id)` 拿到对象，`wc.debugger.attach("1.3")` 附加 CDP（`:38179`）。
2. 页面注入 engine 脚本（click/type/scroll/locator 等高级操作的载体）；`did-finish-load` 后 `engineInstalled=false` 需重装（`:38182-38184`）。
3. agent 侧操作经 HTTP 路由进来 → `resolve(workspaceId?)` 定位 target（无绑定/多绑定都报错，错误文案见上）→ 组合 CDP 命令执行 → 返回结果。
4. 底裤：`POST /api/iab/cdp` 是**裸 CDP 透传** `dbg.sendCommand(method, params)`（`:38257-38259`）——所有高级操作理论上都能用它兜底。

### 2.4 对外接口（按功能分组，路由注册区间 `74715-75230`）

- **导航**：`navigate / reload / back / forward / info`。
- **输入**：`click / type / scroll / locator / dom-click / dom-type`。
- **读取**：`screenshot / read-dom / read / get-visible-dom / eval / cdp`。
- **文件**：`upload`（给 file input 塞文件）、`download / download-media`。
- **系统集成**：`dialog`（JS 弹窗自动处理，CDP `Page.javascriptDialogOpening`）、`clipboard`、`export / export-gsuite`（导出网页到 Google 套件）、`fetch`（浏览器内发 fetch，**带页面 cookie**——这是它比普通 HTTP 抓取值钱的地方）。
- **CUA**：`POST /api/iab/cua`（`75037`）——Computer-Use Agent 模式入口。
- **本机浏览器数据**：`GET /api/iab/profiles` 枚举本机浏览器 profile；`POST /api/iab/history`（**仅 macOS**，`75116-75208`）把 `<profilePath>/History`（Chrome SQLite）复制到 temp（含 `-wal/-shm`）后只读查询：
  ```sql
  SELECT url, title, visit_count, last_visit_time FROM urls ... ORDER BY last_visit_time DESC LIMIT ?
  ```
- **PiP 投屏**：`GET /api/iab/pip/frame`（拉帧）、`POST /api/iab/pip/:action`（`75210-75230`）——把 iab 内容投到画中画小窗，`fitPipToContent` 按内容宽高比调窗口。

### 2.5 复刻要点

- 最小实现：一个 `BrowserView`/WebContents + `debugger.attach("1.3")` + `navigate/screenshot/read-dom/eval/cdp` 五条路由就能让 agent 用起来。`cdp` 透传路由是性价比之王——有了它，click/type 等高级操作可以逐步补，不挡路。
- **坑 1**：CDP attach 与页面生命周期——每次导航后注入的 engine 脚本都会失效，必须有 `did-finish-load` 重注逻辑，否则连续操作第二页就报「函数未定义」。
- **坑 2**：history 读取的「先拷 SQLite 再只读查」技巧是必须的——直接开正在运行的 Chrome 的 History 文件会锁库。
- **坑 3**：按 workspace 绑定意味着「一个 workspace 一个浏览器实例」的映射管理；不绑定 workspace 的设计（全局单浏览器）会简化 resolve 逻辑，但失去了和 preview server 的联动（preview 端口天然知道往哪导航）。

---

## 3. 子代理 TaskManager：持久化 + Resume（对照旧版 08 篇）

### 3.1 是什么

旧版 08 篇判断「子代理 = 递归的同一条 agent loop + 任务表」，v0.0.990 完全坐实并加固为：**任务持久化到磁盘（跨进程重启可 resume）+ 结构化 handoff/harness 编排（五张 DB 表）+ 可外置执行后端（claude-code/codex/ACP）**。

### 3.2 数据模型

**a. 文件层**：`~/.config/alma/tasks/tasks.json` + `logs/<taskId>.jsonl`（常量 `eg/tg/ug`，`:25867-25868`）。任务对象字段（构造函数 `sg`，`:25908-25933`）：

```js
{ id, description, prompt, subagentType,
  agentProfileId, agentProfileName, agentExecutionMode,   // managed crew 三件套
  missionId, runId, handoffId,                            // crew/harness 关联
  model, resumeFrom, runInBackground,
  parentThreadId, parentMessageId, parentToolCallId,
  workspacePath, status: "created"|"resumed"|"running"|"completed"|"failed",
  createdAt, updatedAt }
```

**b. DB 层（crew/harness 五表族）**，建表原文 `tables-all.sql:92-204,400-420,577-602`：

```sql
CREATE TABLE IF NOT EXISTS agent_missions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    root_message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    shared_summary TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
-- ALTER 增量列：harness_mode, spec_artifact_path, max_iterations,
--               current_phase, current_sprint_id

CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES agent_missions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL UNIQUE,          -- 与 tasks.json 的 id 对接
    agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
    parent_run_id TEXT, spawned_by_handoff_id TEXT,
    execution_mode TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    input_summary TEXT NOT NULL, output_summary TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
-- ALTER 增量列：harness_role, sprint_id, attempt_number

CREATE TABLE IF NOT EXISTS agent_handoffs (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES agent_missions(id) ON DELETE CASCADE,
    from_run_id TEXT,
    to_agent_id TEXT NOT NULL, to_agent_name TEXT NOT NULL,
    to_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    packet TEXT NOT NULL,                  -- JSON handoff packet
    result_summary TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)

CREATE TABLE IF NOT EXISTS mission_sprints (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES agent_missions(id) ON DELETE CASCADE,
    sprint_number INTEGER NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)

CREATE TABLE IF NOT EXISTS sprint_contracts (
    id TEXT PRIMARY KEY,
    sprint_id TEXT NOT NULL REFERENCES mission_sprints(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    criteria TEXT NOT NULL,                -- JSON 验收标准
    negotiation_log TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)

CREATE TABLE IF NOT EXISTS sprint_evaluations (
    id TEXT PRIMARY KEY,
    sprint_id TEXT NOT NULL REFERENCES mission_sprints(id) ON DELETE CASCADE,
    contract_id TEXT NOT NULL REFERENCES sprint_contracts(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    generator_run_id TEXT, evaluator_run_id TEXT,
    grades TEXT NOT NULL,                  -- JSON 逐条评分
    overall_passed INTEGER NOT NULL DEFAULT 0,
    feedback_summary TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
```

### 3.3 Task 工具与 harness 模式

Task 工具的 `subagent_type` 枚举（`:24617-24625`）：`["general-purpose","statusline-setup","Explore","Plan","alma-guide","alma-operator","coder"]`。`handoff` 扩展为结构化 packet（`:24690-24712` 原文节选）：

```js
harness: {
  enabled: boolean
    .describe("Set to true to activate autonomous multi-sprint orchestration. Auto-activate this when the user asks to build a complete application or multi-component system. Do NOT mention harness/sprints/contracts to the user — these are internal implementation details."),
  maxIterationsPerSprint: number().int().min(1).max(20)
    .describe("Max retries per sprint. Default 5. Increase for harder sprints."),
  resume: boolean
    .describe("Set true ONLY when the user asks to CONTINUE this thread's existing unfinished harness mission ..."),
}
```

`superRefine` 强制 `subagent_type | agent_id | handoff.harness.enabled` **三选一**（`:24723-24733`）。harness 模式即 Planner→Builder→Evaluator 流水线：每个 sprint 先谈 contract（criteria JSON + negotiation_log），builder 产出后 evaluator 按 contract 打分（grades JSON），`overall_passed=0` 且 `attempt_number < maxIterationsPerSprint`（默认 5，`:32125`）则返工。`getResumableHarnessMissionForThread` 支持失败 mission 重开。

**与旧版 08 篇的对照结论**：

| 维度 | 旧版 08 篇（v0.0.175） | v0.0.990 |
|---|---|---|
| 上下文 | 独立上下文，final answer 回传 | 不变：子代理跑自己的 `streamText`，消息存独立存储，主 agent 只收 outputSchema `qm`（`:24740-24749`）：`{taskId, status, result?, error?, createdAt, updatedAt, message}` |
| 任务状态 | 内存 Map | **tasks.json 落盘 + 重启自愈 + 自动 resume** |
| 编排 | fork-join 一次性派发 | 新增 harness/sprint 结构化交接（opt-in） |
| 执行后端 | 仅内置 | 内置 / claude-code / codex / ACP 可选（coder 子代理后端选择 `:30760-30810`） |

### 3.4 Resume 的两条路径

**a. 模型侧 resume**（Task 参数 `resume: taskId`）：`ig()`（`:25935-25951`）把旧任务置 `status="resumed"`、换 prompt 复用同一任务记录续跑。

**b. REST 侧 resume**：`POST /api/agents/tasks/:taskId/resume` → `resumeSubagentTaskById`（`:94522-94765`）。流程：校验任务存在且非 running/created/resumed（否则 409）→ 找回 `parentThreadId/parentMessageId/parentToolCallId`（缺一 409）→ 父 thread 正在生成则 409 → 取历史消息（末尾 ≤40 条、累计 ≤20000 字符）→ `buildResumedTaskPrompt`（`:84347-84379`）→ 以 `resumeFrom=旧id` 创建新任务 → 更新父消息里对应 `tool-Task` part 状态 → 跑 → 结果写回 part。

resume prompt 模板原文（`:84364-84376`，可直接照抄）：

```
You are resuming a previously interrupted task.
Continue from the exact interruption point instead of restarting the whole task from scratch.
Treat completed steps, tool calls, file edits, discoveries, and partial outputs in the transcript below as already done unless you must verify them.
Inspect the current workspace state before repeating anything with side effects.
Original task description: ...
Original task prompt: ...
Previous execution transcript: ...
Resume instructions:
- Continue from the last incomplete step.
- Preserve prior work and avoid repeating completed work.
- If the prior run left partial state behind, continue from that current state instead of overwriting it.
- Only redo the minimum work required after the interruption.
```

### 3.5 重启自愈

进程启动时把 `running/created` 僵尸任务标 `completed` 并写 `error: "Process terminated on app restart"`（`:25985-26000`，字符串原文见 `:25902`）；随后 `autoResumeInterruptedSubagents`（`:94776-94811`）按 `parentThreadId + parentToolCallId` 找回并自动 resume。这与 09 篇的 healInterrupted 是同一哲学：DB/文件是事实，内存状态重启后全部重建。

### 3.6 对外接口

- `GET /api/agents`（`:94399-94520`）：`{discovered:[{name,bin:"acpx|claude|codex|opencode|pi",installed,path,version}], running:[...], recent(≤20), stats}`——外部 CLI 代理发现 + 任务表状态的合并视图。
- `GET /api/agents/tasks/:taskId`（`:94812-94875`）：`{task, messages}`，消息三级回退（subagent 消息表 → getTaskMessages → task.messages），每条 content 截 2000 字符。
- `POST /api/agents/tasks/:taskId/resume`：见上。
- WS 事件：`subagent_message_added / subagent_message_delta / subagent_message_completed` 推流式中间过程给前端（`:90860-90872`）。
- thread 侧：`GET /api/threads/:threadId/subagent-messages`、`/agent-crew`、`/missions/:missionId/harness`（routes-all.txt `## /api/threads`）。

### 3.7 复刻要点

- 最小切片：tasks.json 文件持久化（含重启僵尸清扫）+ Task/TaskOutput 两个工具 + resume prompt 模板。这一层就能覆盖 90% 的「派个活给子代理」场景。
- harness 五表族是**给「构建完整应用」级任务**准备的重型编排，复刻时建议先不做——它的 contract 谈判/evaluator 打分循环对模型能力要求很高，小模型上 ROI 低。
- **坑 1**：resume 的三 409 校验（任务状态、parent 三字段齐、父 thread 空闲）一个都不能少，否则会出现「同一 toolCallId 两个任务在写」的竞态。
- **坑 2**：历史截断参数（≤40 条 / ≤20000 字符）是防上下文爆炸的硬闸，照抄即可。
- **坑 3**：`agent_runs.task_id UNIQUE` 是文件层与 DB 层的对接键——两边状态不一致时以文件层为准（文件层是执行侧写的），DB 层只是 timeline 展示。

---

## 4. plan-mode + Plan Weave（3 + 11 路由 + 两个 skill）

### 4.1 是什么

两个东西别混：**plan-mode** 是一个纯内存全局开关（「现在在规划阶段」的 UI/agent 信号）；**Plan Weave** 是一套 `<workspace>/.alma/plan/` 下的**文件型任务图状态机**（plan.json + state.json，claim→submit→review→feedback 循环），两者各自独立、由同名 skill 驱动。

### 4.2 plan-mode：全局内存开关

实现就是模块级两个变量（`main.readable.js:100874-100922` 原文可核）：

```js
mx: boolean            // active
fx: ISO 时间 | null     // since
```

`POST /api/plan-mode/enter` → `{active:true, since, message:"Plan mode activated."}`；`/exit` → active:false 且 since 清空；`GET /api/plan-mode` → `{active, since}`。**无持久化、无 per-thread 状态**——进程重启即丢，这是有意的（plan mode 是「本次交互的礼仪」，不是数据）。

agent 入口是 bundled skill `plan-mode/SKILL.md`（`allowed-tools: [Bash]`，原文全文很短可直接读），核心就是：

```bash
curl -s -X POST http://localhost:23001/api/plan-mode/enter
curl -s -X POST http://localhost:23001/api/plan-mode/exit
```

使用时机（skill 原文）：「Before outlining a complex multi-step solution / When the user asks you to "plan" or "think through" an approach / Exit after the plan is finalized」。

### 4.3 Plan Weave 数据模型：文件即状态

存储位置 `<workspace>/.alma/plan/`（`mA = X.join(".alma", "plan")`，`:43790`），全部普通文件：

```
.alma/plan/
  plan.json      # 清单
  state.json     # 运行态
  results/<taskId>/<blockId>.run-N.md      # 实现报告
  results/<taskId>/<blockId>.review-N.md   # 评审记录
  results/<taskId>/FB-N.md                 # 反馈项
  results/<taskId>/FB-N.resolution.md      # 返工报告
.alma/plan-archive/<timestamp>-<slug>/     # archive 去向（:44045-44072）
```

**plan.json**（版本 `"alma-plan/v1"`，校验器 `100999-101110`）：

```jsonc
{
  "version": "alma-plan/v1",
  "title": "...", "goal": "...",
  "createdAt": "...", "updatedAt": "...",
  "tasks": [{
    "id": "T1",                    // /^[A-Za-z0-9][A-Za-z0-9_-]*$/
    "title": "...", "description": "...", "agent": "developer",
    "deps": ["T0"],                // task 级依赖，有循环检测
    "acceptance": ["..."],
    "blocks": [{
      "id": "B1", "type": "implementation" | "review",
      "title": "...", "instructions": "...",   // instructions 必填
      "deps": ["B0"],              // block 级依赖仅限同 task 内
      "agent": "...",              // 可覆盖 task agent
      "maxReviewCycles": 3         // 仅 review block；默认 PA=3（:44047）
    }]
  }]
}
```

**state.json**：`{blocks: {"T1:B1": {status, runs, cycles, outcome?, blockedReason?, updatedAt}}, current: {kind:"block"|"feedback", id, claimedAt} | null, feedback: [{id:"FB-N", sourceRef, content, status:"open"|"resolved", createdAt, resolvedAt?}], updatedAt}`。block 状态机：`pending → ready → in_progress → done`，旁路 `blocked`；每次读写按 deps 重算 ready/pending（task deps 全 done 且 block deps 全 done → ready，`RA()`，`:43940-43967`）。**写文件全部 tmp+rename 原子写**（`:43819-43825`）。

### 4.4 核心流程：claim → execute → submit → review → resolve

| 路由 | 语义（行号证据） |
|---|---|
| `GET /api/plan` | 全量 snapshot：tasks[].blocks[] 带 status/runs/cycles/outcome + `progress {done,total}` + `current` + `openFeedback`（`:43969-44046`） |
| `POST /api/plan {plan, force?}` | 校验 → 已有进行中 plan 且无 force 报 409（原文「Finish it, or pass --force to replace it (previous plan is archived automatically)」）→ 自动 archive 旧 plan → 写 plan.json + 初始化 state.json（`101033-101070`） |
| `DELETE /api/plan` | `rm -rf .alma/plan` |
| `GET /api/plan/block?ref=T1:B1` | block 详情 + `artifacts[]`（results 目录下该 block 的文件列表） |
| `POST /api/plan/claim` | **幂等领取**：有 open feedback 优先返回 `{kind:"feedback", packet}`；已 claim 则重发当前 packet `{alreadyClaimed:true}`；否则扫 tasks×blocks 找第一个 `ready` 置 in_progress 并生成 **work packet**（Markdown：plan goal、task 上下文、acceptance、instructions、上游报告、submit 命令）；无可领返回 `{kind:"none", reason}`（区分「全部完成 🎉」/「有 blocked」/「等依赖」）（`101127-101211`） |
| `POST /api/plan/submit {ref, report}` | 仅 implementation block；`runs+1`、写 `results/<task>/<block>.run-N.md`、status=done、清空 current（`101212-101247`） |
| `POST /api/plan/review {ref, verdict, notes}` | 仅 review block；`passed` → done；`needs_changes`（必须带 notes）→ cycles+1，**达到 maxReviewCycles 则 gate 关闭 outcome=max_cycles 且 plan 继续**；否则开 `FB-N` feedback、review block 退回 ready（`101248-101369`） |
| `POST /api/plan/resolve {report}` | 关闭最早 open feedback：写 `FB-N.resolution.md`、status=resolved → review block 自动重新 ready（`101371-101404`） |
| `POST /api/plan/blocked {ref, blocked, reason?}` | 阻塞/解阻塞（done 不可 block；block 必须给 reason）（`101406-101423`） |
| `POST /api/plan/reset` | 保留 plan.json，重置 state.json（`101425-101441`） |
| `POST /api/plan/archive` | 整体 rename 到 `.alma/plan-archive/<ISO时间戳>-<title-slug>/` |

API 寻址二选一：`dir` 直给，或 `threadId` → `threadWorkspaceDir`（artifacts 开启时优先 artifactWorkspaceId，`:100924-100930`）；找不到时还会**向上最多 32 级目录找 plan.json**（`:43808-43817`）。每次变更广播 `plan_update` WS 事件带全量 snapshot。

agent 入口：bundled skill `plan-weave/SKILL.md`（allowed-tools: Bash/Read/Write/Task）——「The core loop: **claim → execute → submit → repeat**, with review gates」；work packet 可原样塞给 Task 子代理执行；反馈优先级最高（「outranks all other work」）。CLI `alma plan template|set|claim|submit|review|resolve|status` 是 HTTP API 的薄封装。

### 4.5 复刻要点

- plan-mode 开关照抄成本约 30 行，做。
- Plan Weave 的**最小切片**：plan.json + state.json 双文件 + `claim/submit/review/resolve` 四个端点 + work packet 生成。feedback 循环和 maxReviewCycles 关门规则是灵魂（防止 review ping-pong 死循环），不能省；archive/reset/blocked 是运维便利，可后补。
- **坑 1**：claim 的幂等性是硬要求——agent 崩了重来必须能重发同一 packet（`alreadyClaimed:true`），不能重复置 in_progress。
- **坑 2**：文件型设计的好处是 `git` 可追踪、人可直接改；代价是所有写都要 tmp+rename 原子化，省了这个就会在崩溃后读到半个 JSON。
- **坑 3**：plan 和 thread 的解耦（`dir` 或 `threadId` 二选一）是有意的——plan 属于 workspace 不属于对话，同一 workspace 的多个 thread 共享一份 plan。

---

## 5. prompt-apps（8 + 2 路由 + runner 窗口）

### 5.1 是什么

「带表单的 prompt 模板」——轻量版 GPTs：定义好模板、占位符、模型/工具/reasoningEffort，用户填表即开一个新会话执行。

### 5.2 数据模型

`prompt_apps`（drizzle `:729-764`）核心列：`{id, name, description?, icon?, promptTemplate TEXT NOT NULL, placeholders JSON NOT NULL DEFAULT [], model?, tools? JSON, reasoningEffort?, expectsImageResult BOOL, isIncognito BOOL, enabled BOOL, shortcut?, windowWidth?, windowHeight?, fontSize?, sortOrder, createdAt, updatedAt}`。

`prompt_app_executions`（`tables-all.sql:466` 原文）：

```sql
CREATE TABLE IF NOT EXISTS prompt_app_executions (
    id TEXT PRIMARY KEY,
    prompt_app_id TEXT NOT NULL,
    thread_id TEXT,
    input_values TEXT NOT NULL,
    generated_prompt TEXT NOT NULL,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (prompt_app_id) REFERENCES prompt_apps(id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE SET NULL
)
```

`chat_threads.prompt_app_id` 外键（SET NULL，`:825-827`）反查「这个 thread 是哪个 app 跑出来的」。

### 5.3 核心流程（`executePromptApp`，`:95417-95465`）

1. 取 app，逐 placeholder 做模板替换：正则 `/(?:\{\{|｛｛)\s*<name>\s*(?:\}\}|｝｝)/g`——**同时支持半角 `{{name}}` 和全角 `｛｛name｝｝`**；boolean 值渲染成 `"Yes"/"No"`，其他 `String(v)`。
2. `createThreadWithPromptApp(app.name, id, {model, tools, reasoningEffort, isIncognito})`（`:6516`）——**每次执行建一个新 thread**。
3. 写 execution 行（inputValues + generatedPrompt + attachmentCount），广播 `thread_created`，返回 `{execution, thread, generatedPrompt}`（201）。

### 5.4 对外接口

- CRUD + `PUT /api/prompt-apps/reorder` 排序（`77712-77739`）。
- `POST /api/prompt-apps/:id/execute`、`GET /:id/executions`。
- `GET/DELETE /api/prompt-app-executions/:id`。
- **独立小窗 runner**：IPC `prompt-app-runner-open` 加载 `prompt-app-runner.html`（`:104841-104902`；renderer 产物 `/tmp/alma-extract/asar/out/renderer/prompt-app-runner.html` → `assets/prompt-app-runner-*.js`），支持自定义窗口尺寸/字号/全局 shortcut——即「双击快捷键弹出小窗、填表、跑」的桌面体验。

### 5.5 复刻要点

- 整个子系统 ≈ 200 行：一张模板表 + 一张执行记录表 + 一个 replace 循环 + execute 建 thread。**先做无独立窗口的 Web 表单版**，runner 窗口是体验加分项。
- **坑 1**：全角花括号兼容看起来是小细节，但中文用户用全角输入法写模板是常态——不兼容的话模板静默不替换，用户看到模型收到 `{{名字}}` 原文。
- **坑 2**：executions 表的价值是「同样的输入能重放/审计」，`generated_prompt` 必须存替换后的全文而不是模板引用。
- **坑 3**：`expectsImageResult` 是给图像类模板（如海报生成）的提示位，结果渲染走 gallery 管线，不做图像就别建这列。

---

## 6. plugins + plugin-themes + plugin_permissions（14 + 4 路由）

### 6.1 是什么

VS Code 风格的扩展宿主：**manifest.json + JS/TS 入口（内置 Bun 编译）+ 声明式权限 + 运行时 API 表面**（注册工具/命令/UI 组件/主题/provider）。和 skills 是两条完全不同的扩展线（对照表见 §6.6）。

### 6.2 数据模型

三张表（建表原文 `tables-all.sql:422-451`；drizzle `main.readable.js:1407-1460`）：

```sql
CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL, version TEXT NOT NULL,
    description TEXT NOT NULL, author TEXT NOT NULL,
    icon TEXT,
    source TEXT NOT NULL,          -- "local"|"global"|"npm"|"url"|"marketplace"
    source_path TEXT NOT NULL,
    install_url TEXT,
    manifest TEXT NOT NULL,        -- 原始 manifest.json 文本
    enabled INTEGER NOT NULL DEFAULT 1,
    settings TEXT NOT NULL DEFAULT '{}',
    installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
CREATE TABLE IF NOT EXISTS plugin_permissions (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- granted|denied|pending
    granted_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(plugin_id, permission)
)
-- plugin_state: {id, plugin_id→CASCADE, key, value}  -- KV 持久化
```

### 6.3 Manifest schema（Zod，`:49521-49690`，可直接复刻）

```js
{
  id: string.regex(/^[@a-z0-9-_./]+$/i).min(1),
  name: string.min(1),
  version: string.regex(/^\d+\.\d+\.\d+/),          // semver
  description, author: string | {name, email?, url?},
  main: string,                                      // 入口文件
  icon?, homepage?, repository?, license?, keywords?,
  engines: { alma: string, node?: string },
  type: enum["tool","ui","theme","provider","transform","integration","composite"] 或其数组,
  permissions?: string[],                            // 如 "tools:register"、"notifications"
  contributes?: {
    tools?: [{id,name,description}],
    components?: {
      sidebar?, settingsPanels?, toolbar?, contextMenus?,
      artifactRenderers?: [{id,mimeTypes[],fileExtensions?,component,displayName}],
      statusBar?: [{id,alignment:"left"|"right",priority?,command?}],
    },
    themes?:    [{id,label,type:"dark"|"light",colors:Record<string,string>}],
    providers?: [{id,name,icon?,authType?:"api-key"|"oauth"|"none"}],
    keybindings?, commands?, configuration?, locales?,
  },
  dependencies?: Record<string,string>,
  activationEvents?: string[],
}
```

即 VS Code extension manifest 的缩水版。

### 6.4 加载与激活机制

- **扫描目录**（`:49696-49706`）：global = `~/.config/alma/plugins/<dir>/manifest.json`，local = `<workspace>/.alma/plugins`，npm 缓存 `~/.cache/alma/plugins`。
- **TS 编译** `compileTypeScript(entry)`（`:49824-49877`）：用随包 Bun 执行 `"${bun}" build "${entry}" --outfile "${cache}.mjs" --target node --format esm --external electron --external zod`（原文 `:49847`）；缓存键 = sha256(entry 路径 + 源码目录最新 mtime) 前 16 hex，缓存目录 `<userData>/plugin-cache/`（`:49825`）；源码含 `__filename/__dirname` 时生成 ESM wrapper 垫片。
- **激活** `activatePlugin(id)`（`:50034+`）构造插件上下文：logger、`storage`（`<userData>/plugin-storage/<id>/storage.json` + `plugin-global-storage/<id>/`，get/set/delete/keys/clear）、`secrets`（**Electron safeStorage 加密**，格式标记 `"alma-safestorage-v1"`（`:50091`），文件 0600，明文自动迁移）。
- **API 表面**（`:50171-50340+`）：
  - `tools.register(name, {description, parameters, outputSafetyMode, execute})`——**需 `tools:register` 权限**（`:50175` 检查原文 `if (!o("tools:register"))`），工具以 `plugin--<pluginId>--<toolName>` 命名进全局注册表，对 agent 可见。
  - `commands.register/execute`、`events.on/once`（进全局事件总线）、`ui.showNotification/showQuickPick/showInputBox`（IPC 到 renderer）、providers（接入 usage 计费）。
- 权限 API：`GET/PUT /api/plugins/:id/permissions`。
- 更新：`/api/plugins/updates` + `updates/known` + `POST /:id/update`（下载 → 重编译 → **保留 permissions/settings** → 重新激活）。

### 6.5 plugin-themes（4 路由）

`GET /api/plugin-themes` 返回 `{themes, darkThemes, lightThemes, currentThemeId}`（`99740-99756`）；`POST /:id/apply` 广播 `plugin_theme_applied`；`POST /clear`。主题展开函数 `MI()`（`:49692-49735`）把插件声明的 `colors` 映射成完整 shadcn 风格 token 集（background/foreground/card/popover/primary/…/sidebar*/chart1-5/14 个语法色），缺省值抄 Catppuccin（dark `#1e1e2e` / light `#ffffff`）。

### 6.6 plugins 与 skills 的边界

| | skills | plugins |
|---|---|---|
| 形态 | 目录 + `SKILL.md`（Markdown 指令） | 目录 + `manifest.json` + JS/TS 入口（Bun 编译） |
| 作用层 | prompt 层：给 agent 注入指令/流程 | 代码层：注册**可执行** tools/commands/UI/theme/provider |
| 存储 | `skills` 表仅 `{id, path, enabled, sort_order}`（`tables-all.sql` skills 节） | `plugins` + `plugin_permissions` + `plugin_state` 三表 |
| 权限 | 无 | manifest `permissions[]` + 运行时门控三态 granted/denied/pending |

一句话：**skill 教 agent 怎么做事，plugin 给系统加新能力**。复刻时先把 skills 做扎实（成本极低），plugins 是第二阶段。

### 6.7 复刻要点

- 最小切片：manifest Zod 校验 + global 目录扫描 + `tools.register` 一条 API + `tools:register` 权限门控。UI 组件/theme/provider 贡献点全部可后补。
- **坑 1**：Bun 编译缓存键必须含源码 mtime——否则用户改了插件不生效，排查极痛苦。
- **坑 2**：secrets 用 OS 级加密（safeStorage / keychain）而不是自存明文；`alma-safestorage-v1` 前缀 + 0600 + 明文自动迁移的三件套照抄。
- **坑 3**：插件更新「保留 permissions/settings」是信任链要求——更新后重新要权限等于训练用户无脑点允许。

---

## 7. refs 引用系统（21 路由）

### 7.1 是什么

全局对象寻址层：Alma 里的一切（thread/message/file/host/skill/agent/mission/plan/prompt/model/memory/cron…）都有一个 `alma://kind/id` URI，可以在消息里 `@[label](alma://kind/id)` 引用，系统自动建**双链图谱**（backlinks/outlinks/graph）。这是连接各子系统的粘合剂。

### 7.2 URI 协议（`:350-658`）

- **19 种 kind**（`Kn` 数组，`:350-369`）：`thread, message, snippet, file, project, host, skill, agent, mission, plan, prompt, mcp, model, memory, artifact, tool, task, provider, cron`。每种带 `{label, order, prefixes[], modelHint, scope}`（`Vn`，`:371-505`），scope ∈ `global | project | thread`。
- URI 形式：`alma://<kind>/<segments...>`（`Zn = "alma://"`，`:506`；段做 RFC3986 严格 encode）。特殊形态：
  - message：`alma://thread/<threadId>/message/<slotId>`——**按 slot 寻址，跟随编辑/regenerate**（`:544-554`）；
  - file：`alma://file/<workspaceId>/<path...>`；
  - model：`alma://model/<providerId>/<modelId>`；
  - artifact：`alma://artifact/<threadId>/<messageSlot>/<artifactId>`；
  - tool：`alma://tool/<threadId>/<toolCallId>`。
- 解析器（`:528-638`）：长度上限 4096，kind 校验，返回 `{kind, id, segments, uri}`。
- **消息内嵌语法**：`@[label](alma://kind/id)`，正则 `/^@\[([^\]\n]{1,200})\]\((alma:\/\/[^\s()]+)\)/`（`:660`）。

### 7.3 存储（建表原文 `tables-all.sql:529-554`）

```sql
CREATE TABLE IF NOT EXISTS reference_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_uri TEXT NOT NULL,
    to_uri TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    label TEXT,
    thread_id TEXT,
    message_id TEXT,
    slot_id TEXT,
    role TEXT,
    source TEXT NOT NULL DEFAULT 'message',   -- 'message' vs 手工断言
    created_at TEXT NOT NULL
)
-- 索引：(to_uri, created_at) / (from_uri) / (message_id) / (thread_id)
-- 唯一索引：(from_uri, to_uri, source)

CREATE TABLE IF NOT EXISTS reference_snippets (
    id TEXT PRIMARY KEY,              -- "snip-" + 6字节hex
    thread_id TEXT NOT NULL,
    message_id TEXT, slot_id TEXT,
    text TEXT NOT NULL,               -- 上限 20000 字符
    text_hash TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL
)
```

### 7.4 对外接口（21 条，`:47315-48030`）

| 路由 | 语义 |
|---|---|
| `GET /kinds` | kinds 元数据 + `available`（resolver 是否注册） |
| `GET /search?q&kinds&limit&limitPerKind` | 按 kind 并行搜，**每种 2.5s 超时兜底**（`:47353-47369`），默认 limitPerKind=8 |
| `GET/POST /resolve?uri&full` | resolver 分发；`uris[]` 批量（≤64）；**3 秒 LRU 缓存**（容量 500，`:44282-44311`）；未注册/失败降级 `{exists:false, summary}` |
| `GET /backlinks?uri` / `GET /outlinks?uri` | 反链/出链 |
| `GET /graph?uri&depth` | BFS 扩展（depth 1-3，节点上限 300），返回 `{nodes, edges}`（`:47501-47570`） |
| `POST /backlink-counts {uris[]≤200}` | 批量反链计数 |
| `GET /recent` | 热门引用 |
| `GET/POST/DELETE /snippets`、`POST /snippets/from-turns` | 文本摘抄；从锚点消息提取会话轮次生成 snippet |
| `GET /recipes` / `POST /recipes/state` | snippet 配方（引用组合模板） |
| `POST /open {uri}` | 系统级打开（文件跳 Finder 等） |
| `GET /related?uri` | 人工 link + 正文共现的相关对象 |
| `POST /link` / `POST /unlink` | 人工断言双链 |
| `GET /context` / `POST /reindex` | thread 引用上下文 / 重建索引 |

### 7.5 Agent 侧暴露

bundled skill `references/SKILL.md`（`always-inject: true`）：用户在 composer 输 `@` 创建引用；agent 收到 `<referenced_objects>` 卡片（kind/title/短摘要/next steps，**故意做得很短**）；要全文走 CLI：`alma ref resolve <uri> [--full]`、`alma ref search/backlinks/outlinks/related/link/unlink/graph`（skill 原文给出每种 kind 的「在任务里意味着什么/该做什么」对照表，如 `host` → `payload.sshCommand`，`plan` → `cd <payload.root> && alma plan status`）。resolver 注册表是 `Map<kind, {search, resolve}>`（`:44262-44264`）。

### 7.6 复刻要点

- 最小切片：URI parser + `reference_links` 一张表 + 消息发送时扫 `@[label](alma://...)` 正则落链 + `resolve/backlinks` 两个端点。graph/recipes/related 都是后话。
- **坑 1**：message 引用按 **slotId** 而不是 message id 寻址是关键设计——regenerate 换新版本后引用不失效（slot 不变）。照抄 09 篇的 slot 机制时把这个一起带上。
- **坑 2**：resolve 必须**永远返回 200 + `{exists:false}` 降级**而不是 404——agent 拿着失效 URI 不该崩流程。
- **坑 3**：每种 kind 的 resolver 要注册进 Map 才可 search/resolve；新增子系统时顺手注册它的 resolver，否则 refs 图谱就有盲区。

---

## 8. terminal 内置终端（6 路由 + WS）

### 8.1 是什么

主进程里跑 node-pty 的内嵌终端，绑定 workspace（也可挂 thread），前端 xterm 渲染，agent 还能通过 `exec` 协议**复用交互终端跑命令并拿结构化结果**。

### 8.2 核心实现

- 会话管理器单例（`:70052-70230`）：`createSession(workspaceId, cwd, threadId, name, remote?)`。
- **本地**：`pty.spawn(shell, [], {name:"xterm-256color", cols:80, rows:24, cwd: workspace.path, env:{...process.env, TERM:"xterm-256color"}})`（`:70063`；node-pty import 于 `:335`）。shell 选择：Windows `powershell.exe`，其他 `process.env.SHELL || "/bin/bash"`。
- **远程**：`ssh -t <target> sh -c 'cd <path> 2>/dev/null; exec "$SHELL" -l'`（`:29576`）——PTY 分配 `-t` + 登录 shell。
- **scrollback 缓冲**：每 session 内存保留最后 **100,000 字符**（超出截尾，`:70098-70100`），新 WS 客户端连接即全量重放。

### 8.3 exec 标记协议（agent 复用终端的关键，`execAndWait`，`:70160-70210`，注入行原文在 `:70210`）

注入一对标记，从 scrollback 截取两标记间内容：

```js
const s = `__ALMA_S_${token}__`, i = `__ALMA_E_${token}__`;
o.pty.write(`printf '%s\\n' ${s}; ${cmd}; printf '%s:%s\\n' ${i} "$?"\n`);
// 从输出中提取 S..E 之间的行，过滤含 __ALMA_ / printf '%s 的行，
// 剥离 prompt 装饰行（正则 /^[\s%│-┿⠀-⣿--]*$/），剥 ANSI，
// E 标记后带 exitCode；默认超时 120s，超时返回 {timedOut:true, exitCode:null}
```

`GET /:id/output` 非 raw 模式也会过滤 `__ALMA_S_/__ALMA_E_` 标记行（`:98838`）并清理 ANSI——**标记对用户不可见**。

### 8.4 对外接口

- 路由（`78129-78144`）：`POST /api/terminal/create {workspaceId, threadId?, name?}`、`DELETE /:id`、`GET /api/terminal/sessions?workspaceId|threadId`、`GET /:id/output?raw=1`、`POST /:id/input {data}`、`POST /api/terminal/exec {command, sessionId?|workspaceId?, threadId?, timeout?}`。
- WS `/ws/terminal/<sessionId>`（`85557-85592`）：下行 `{type:"terminal_output", data}`（连接即回放 scrollback）、`{type:"terminal_exit", exitCode}`；上行 `{type:"input", data}`、`{type:"resize", cols, rows}`。未知 sessionId 返回 `{type:"error", error:"Terminal session not found"}` 并关闭。

### 8.5 复刻要点

- 最小切片：node-pty + create/input/output/WS 四件。scrollback 100K 上限照抄（不限制就会内存泄漏）。
- **坑 1**：exec 协议的「双标记 + `$?` 捕获」比「开新 pty 跑一次性命令」值钱——它让 agent 看到用户终端里已 cd/已激活环境的现场。但标记行必须在 output 路由里过滤，否则用户会看到乱码。
- **坑 2**：prompt 装饰行清洗正则（powerline 字符段）是经验产物——starship/oh-my-zsh 的 prompt 会混进输出，不清洗的话 agent 拿到的「命令输出」里全是框线字符。
- **坑 3**：远程终端就是 `ssh -t` 包一层，没有走 ControlMaster 长连接的复用证据——高频使用时每个 session 一次 SSH 握手，延迟可感知。

---

## 9. remote-hosts（6 路由，SSH）

### 9.1 是什么

是的，就是 SSH：把远程主机登记成一等公民，workspace 可以挂到远程目录（`workspaces.remote_host_id`），文件读写/git/bash/终端全部经 SSH 执行。

### 9.2 数据模型

`remote_hosts`（`tables-all.sql:556`）：

```sql
CREATE TABLE IF NOT EXISTS remote_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ssh_target TEXT NOT NULL,        -- ~/.ssh/config 别名 或 user@host
    port INTEGER,
    identity_file TEXT,
    source TEXT NOT NULL DEFAULT 'manual',   -- "manual" | "ssh_config"
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
```

### 9.3 对外接口（`:95720-95843`）

- `GET /api/remote-hosts/ssh-config`——解析 `~/.ssh/config` 的 Host 别名，**过滤掉已登记的**（按 sshTarget 判重），一键导入用。
- `GET /api/remote-hosts`——列表带实时 `status`（连通状态）+ `workspaceCount`。
- `POST /api/remote-hosts`——`{name?, sshTarget, port?, identityFile?, source?}`；sshTarget 必填且唯一（409 返回已有 host）。
- `DELETE /:id`——有 workspace 引用时 400（「Cannot delete a remote host that still has projects」）。
- `POST /:id/test`——SSH 连通性测试。
- `GET /:id/browse?path=`——远程目录浏览（用于 workspace 创建时的目录选择器）。

### 9.4 SSH 基础设施

模块导出面（`:29584-29604`，复刻时可照抄接口划分）：`browseDirectory, buildRemoteGitArgs, buildRemoteShellArgs, buildRemoteTerminalArgs, buildSshArgs, classifySshError, execOnHost, getHostStatus, onHostStatusChange, reportHostStatus, resetControlMaster, resolveHostIdForPath, testConnection`。**ControlMaster 复用连接**（`resetControlMaster` 导出可证）；remote workspace 的 git 走 `buildRemoteGitArgs`（`ssh <target> git -C <path> ...` 包装）。

### 9.5 复刻要点

- 最小切片：一张表 + `test` + `browse` + workspace 挂 `remote_host_id` + 文件 API 的 SSH 分支。git/bash/终端的远程化逐个子系统加。
- **坑 1**：ControlMaster 必须做——每次操作一次 SSH 握手在高延迟链路下不可用。`ssh -o ControlMaster=auto -o ControlPath=... -o ControlPersist=600`。
- **坑 2**：`classifySshError` 的存在说明错误分类是刚需（认证失败/主机不可达/超时/拒绝各有不同的用户指引），别把 SSH stderr 原文抛给用户。
- **坑 3**：`resolveHostIdForPath`（`:45644` 的调用点）暗示「按路径反查 host」的场景存在（比如 absolute-path 文件读取路由），路径 ↔ host 的映射要双向可查。

---

## 10. cloud-sync（4 路由）

### 10.1 是什么

极简的**单向设置快照导出**：把 app settings 写一份 JSON 到 iCloud Drive 目录。没有拉取、没有合并、没有冲突处理——几乎是占位实现。

### 10.2 数据模型与流程

- 配置文件 `~/.config/alma/cloud-sync.json`：`{enabled, syncDir, lastSnapshotAt}`（`:69923-70013`）。
- 同步目标（`YR = "AlmaSync"`，`:69923`）：
  - darwin：`~/Library/Mobile Documents/com~apple~CloudDocs/Documents/AlmaSync`
  - 其他平台：`~/Documents/AlmaSync`
- `pushSnapshot()` 只写一件事：`snapshot.json = {version:1, createdAt, settings: <settingsData 解析后的全量设置>}`。

### 10.3 对外接口

`GET /api/cloud-sync/state`、`POST /api/cloud-sync/enable`、`POST /api/cloud-sync/disable`、`POST /api/cloud-sync/push-snapshot`。

### 10.4 复刻要点

- 30 行代码的事，但要**认清它的定位**：这是「换机器后我能找回设置」的最低保障，不是同步系统。
- **坑**：settings 里可能含 API key 等敏感字段——Alma 直接全量导出（其 key 另有加密层）。如果你的 settings 存明文密钥，导出前必须过滤或加密。没有拉取逻辑意味着**恢复是纯手工活**（用户自己打开 snapshot.json 抄回来），别在 UI 上把它宣传成「同步」。

---

## 11. mobile-relay（8 路由）

### 11.1 是什么

手机端（Capacitor iOS 伴侣 App）经公网中继访问桌面 Alma 的隧道：把本地 `127.0.0.1:<port>` 的整个 HTTP/WS API 代理出去，可选端到端加密。

### 11.2 核心流程

1. **账号连接**：`POST /api/mobile-relay/connect-account` → 返回 `https://community.alma.now` 的 OAuth 授权 URL（`mobileRelayOAuth` 实例，`:73548`）→ 回调 `GET /api/mobile-relay/oauth-callback?state&token`（token 做 JWT 形态校验：3 段、>20 字符，`:74414-74420`）→ 存为 `registrationKey`。
2. **接入**：设置 `mobileRelay{enabled, serverUrl, connectCode, e2eEncryption, registrationKey}`（读取处 `readMobileRelaySettings`，`:99975-99997`）；中继服务器默认 `https://relay.alma.now`（`tM`，`:72204`；旧域名 `alma-relay.yetoneful.workers.dev` 会被改写为默认，`:99982-99984`）；`connectCode` 由 `Mu()` 生成，`/regenerate` 可轮换。
3. **帧协议**（WS JSON，字段是短名，`handleFrame` `:20115-20176`）：
   - 下行：`registered / error / hreq(HTTP 请求) / hcancel / wopen(WS 开) / wmsg / wclose`；
   - 上行：`hres / hchunk(base64 分块) / hend / herr`、`wopened / wmsg(s 或 b base64) / werr`；
   - 桌面端收到 `hreq` 后**回环 fetch `http://127.0.0.1:<localPort><path>`** 再流式回传——整个本地 API 被隧道到手机；背压阈值 `bufferedAmount > 16MB`（`:20108-20113`）。
4. **E2E 加密**：WebCrypto **P-256 ECDH + SHA-256 + AES-GCM**，info 字符串 `"alma-relay-e2e/v1"`（`mu`，`:19481`）；密钥材料由 `connectCode` 派生（sha256，`:20033-20036`）；`/api/mobile-relay/e2e {enabled}` 开关。

### 11.3 与 Capacitor 的关系

`asar/package.json` 依赖里躺着 Capacitor 全家桶（`@capacitor/{app,browser,camera,core,device,filesystem,haptics,ios,keyboard,local-notifications,network,preferences,push-notifications,share,splash-screen,status-bar}`）——证明存在独立 iOS 伴侣 App 工程（不在本 bundle 内）。手机端经 relay 访问桌面 Alma，推送通知走 APNs。

### 11.4 复刻要点

- 本质是「**loopback API 的 WebSocket 隧道**」：中继服务器只做路由（connectCode → 桌面连接），数据面逐帧转发。复刻时中继端 100 行内可搞定（两个 WS 对转发）。
- **坑 1**：HTTP 分块回传（hchunk base64）和 WS 帧（wmsg 区分文本/二进制）要分开建模——SSE 流式接口不走分块会在中继侧憋到超时。
- **坑 2**：E2E 用 connectCode 派生密钥意味着**知道 connectCode 即能解密**——connectCode 的展示/轮换 UI 要当密码对待。
- **坑 3**：无鉴权 loopback 的信任边界被这个子系统彻底打穿——隧道建立后手机端拥有桌面全部 API 能力。registrationKey（OAuth）管「能不能连中继」，connectCode 管「连到哪台桌面」，两层都要。

---

## 12. 多通道 channels（discord 10 / feishu 9 / weixin 3 / groups 7 / channels 2 + telegram）

### 12.1 是什么

把外部 IM 平台（Telegram/Discord/飞书/Lark/微信）的会话桥接成 Alma thread：**入站消息 → `channel_mappings` 表映射 → WS `generate_response` 驱动 agent → 出站经各平台 bridge 投递**。

### 12.2 统一抽象：`channel_mappings` 表

建表原文（`tables-all.sql:204`；drizzle `:1173`）：

```sql
CREATE TABLE IF NOT EXISTS channel_mappings (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,              -- telegram/discord/feishu/lark/weixin
    external_chat_id TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
```

`getOrCreateMapping(platform, chatId, userId, model, workspaceId)`（`:27800`）：有活跃映射 → 复用 thread；没有 → `createThread` + 插映射，返回 `{threadId, isNew}`。`is_active` 切换支持「同一外部聊天改绑不同 thread」。`GET /api/channels/:platform` 的查询原文（`:6108`）按 platform 聚合最近会话。

### 12.3 消息转换管线

- **入站**：各平台 bridge 收消息 → `getOrCreateMapping` → 向 `/ws/threads` 发 `generate_response`（thread 忙时 Telegram 发 `steer_generation` 插话帧，`:55057-55069`；Discord 策略不同——**另开新 thread**，日志「Thread busy, creating new thread」）。
- **出站**：bridge 监听 WS 事件（`message_delta` / `generation_completed` / `generation_error`，`:55716-55733` 的 `handleGenerationCompleted`）→ 取最终文本 → 平台 API 投递（截断 4000 字符是 Telegram 侧惯例）。
- **群聊**：入站消息加 `[From: name (@username)]` 前缀（群聊 prompt 段原文 `:55241`），群内用「小模型判断 isDirectedAtBot YES/NO + `randomBoostRate`（默认 0.2）随机插话」决定是否回复；群聊日志落盘 `~/.config/alma/groups/<chatId>_<date>.log`，配套 `alma group history/context/search` CLI（四层记忆：近期 30 条 → 日志文件 → 群上下文 → 关键词搜索，prompt 原文 `:55241`）。

### 12.4 各平台实现差异

| 平台 | 实现 | 关键证据 |
|---|---|---|
| Telegram | 直连 Bot API（`MessageBridge` 类，`:54674` 起） | 配置 `telegram.{enabled,botToken,allowedUserIds,ownerId,defaultModel}`（`:99946-99965`）；支持文字/语音（TTS 回调）/图片/reaction（`⚡` 表示开始用工具）；cron 与 heartbeat 的 `sendToTelegram` 都由它注入 |
| Discord | `discord.js@^14`（动态 require，`:57063,57878`） | 10 条路由：servers、send、send-photo、send-file、sticker(s)、dm、消息增删、reaction（`76004-76264`） |
| Feishu/Lark | **spawn 外部 `lark-cli` 二进制**（不是 node-sdk 直连） | 查找顺序 `Resources/lark-cli/lark-cli` → `~/.config/alma/lark-cli/bin/`（`bC`，`:59740`）→ 缺失时从 npmmirror 下载；`lark-cli config init --new --brand <feishu\|lark>` → 扫码（`qrDataUrl/verificationUrl` 经 `/api/feishu/connect/state` 暴露）；双实例 `feishuBridge`/`larkBridge` |
| Weixin | **腾讯 ilink bot HTTP API 长轮询** | base `https://ilinkai.weixin.qq.com`（`UC`，`:62244`）；端点 `/ilink/bot/get_bot_qrcode?bot_type=3`、`get_qrcode_status`、`getupdates`（长轮询）、`sendmessage`、`getuploadurl`、`getconfig`；WS ping 保活 30s + 指数退避重连（1s 起、上限 30s） |

`/api/groups` 7 条路由（pin/unpin/send/send-photo/send-document/send-video/leave，`75822-75958`）是 **Telegram 群操作**的 HTTP 封装；`/api/chat/:chatId/send-*` 5 条是 Telegram 私聊/频道多媒体发送。

### 12.5 复刻要点

- 最小切片：`channel_mappings` 表 + 一个平台 bridge（建议 Telegram，Bot API 最简单）+ WS 回环两帧（`generate_response` / `generation_completed` 监听）。整个通道层的价值 80% 在这张映射表。
- **坑 1**：「thread 忙时怎么办」各平台策略不同（Telegram steer / Discord 开新 thread）——选一种并写进文档，否则用户在群里连发三条会触发三次并发生成。
- **坑 2**：群聊的 isDirectedAtBot 判定用小模型 YES/NO 而不是关键词——关键词在中文群聊里误判率极高。
- **坑 3**：feishu 走 sidecar 二进制、weixin 走长轮询——都不是「官方 SDK 直连」的常规路。复刻时不必照抄具体实现，照抄**架构位**（bridge 类 + mapping 表 + 投递回调）即可。

---

## 13. cron / scheduler 升级（8 路由 + jobs.json + scheduler skill，对照旧版 05 篇）

### 13.1 是什么

定时任务系统：三种调度（一次性/间隔/cron 表达式）× 两种执行模式（注入主会话/独立临时会话），**v0.0.990 把存储从 SQLite 迁到了 JSON 文件**，执行走 WS 回环驱动 agent。

### 13.2 数据模型：SQLite → JSON（重要差异）

目录常量（`:64212-64214` 原文）：

```js
const sN = X.join(O.homedir(), ".config", "alma", "cron"),
      iN = X.join(sN, "jobs.json"),
      aN = X.join(sN, "runs.json");
```

启动时若 `jobs.json` 不存在则从 SQLite `cron_jobs`/`cron_job_runs` 表一次性迁移（`migrateFromSqlite`，`:64336`）。job 结构（迁移字段映射即规格）：

```js
{ id, name, scheduleType,           // "at" | "every" | "cron"
  schedule, executionMode,          // "main" | "isolated"（默认 isolated）
  payload: { threadId?, agentTurn?, systemEvent?, deliverTo?, model?, timezone? },
  enabled, createdAt, updatedAt, lastRunAt, lastRunResult, runCount }
```

runs 只保留每个 job 最近 **100 条**。interval 语法 `"20s|30m|2h|1d"`（解析器 `cN`，`:64216-64235`，非法输入抛 `Invalid interval`）；cron 类型自动注入本机 IANA timezone（`Intl.DateTimeFormat().resolvedOptions().timeZone`，`lN`，`:64238-64249`）。`at` 一次性 job 执行后自动 `removeJob`。

### 13.3 调度引擎

三种混合（`CronService` 类 `dN`，`:64251`）：`at` → `setTimeout`、`every` → `setInterval`、`cron` → **croner** 包的 `Cron`（import 于 `:327`）。

### 13.4 执行链路（复刻核心）

两种模式都**不直接跑 agent，而是 WS 回环**：

1. **executeMainSession**（`:64865`）：向已有 thread（缺省读 settings 的 `heartbeat.threadId`）发帧：
   ```js
   { type: "generate_response",
     data: { threadId, model,
       userMessage: { role:"user", parts:[{type:"text",
         text: `[System Event - CronJob "${name}"]: ...` }] },
       source: "cron" } }
   ```
2. **executeIsolated**（`:64919`）：先 `createThread("⏰ Cron: ${name}", model, defaultWorkspaceId)`，打 `metadata:{isCron:true}`，再发同款帧。
3. **完成检测**：CronService 自己持有一条到 `/ws/threads` 的 WS 客户端连接，监听 `generation_completed` / `generation_error`；错误时最多重试 3 次、退避 `5s*(n+1)`。
4. **卡住回收**：`stuckGenerationCleanupTimer` 每 60s 扫（`:64416`），超过 600s 的 generation 强制 `isGenerating=false`（`"Generation timed out after 600s — force-cleaned"`）；另扫标题以 `⏰ Cron:` 开头的孤儿 thread。
5. **结果提取**：直接从 SQLite 读 `SELECT message FROM chat_messages WHERE thread_id = ? ORDER BY created_at DESC` 取最近一条 assistant 消息的 text parts。**cron thread 不删除，留作 diary review**。

### 13.5 deliverTo 投递与「无内容」抑制

若 `payload.deliverTo` 存在且有 `sendToTelegram`：截断 4000 字后发出。注入的系统提示原文（`:64945` 附近）：

```
[System: This is a cron job. Your ENTIRE response will be sent directly to Telegram chat ${deliverTo}. Output ONLY the final content — no meta-commentary. If there is NOTHING to report, output EXACTLY "(no output)" and nothing else.]
```

抑制清单（含中英文正则，命中则不投递，`:64645-64663`）：`/no.?output/i, /\(no output\)/i, /不提醒/, /不发/, /没有(新|更新)/, /没(看到|发现).{0,20}(更新|新.*版)/, /未(发现|检测)/, /本次不/, /无需/, /skip/i, /nothing.to.(send|report|deliver)/i, /no.?(new|newer).?version/i, /no.?update/i, /目前.*没有/, /当前.*没有/, /暂(时|无)/`。

### 13.6 对外接口与 agent 入口

- 8 条路由（`78732-78815`）：`GET/POST /api/cron/jobs`、`GET/DELETE/PUT .../:id`、`POST .../:id/toggle`、`POST .../:id/run`、`GET .../:id/runs`。
- agent **不走 HTTP 工具，走 CLI**：bundled skill `scheduler/SKILL.md` 指示用 `alma cron add "<name>" <at|every|cron> <schedule> [--mode main|isolated] [--prompt ...] [--deliver-to CHAT_ID] [--thread-id ID] [--model M] [--timezone Area/City]`。同一 skill 还管 heartbeat（`alma heartbeat status/config/enable/disable/interval/patrol`）。
- cron 同时是 refs 系统的一个 kind（`kind:"cron"`，`:46874`），actions `["alma cron list", "alma cron run <id>"]`。

### 13.7 与旧版 05 篇差异 + 复刻要点

- 旧版存 SQLite（`cron_jobs` 表），v0.0.990 **改 JSON 文件 + 启动时一次性迁移**。文件化的理由与 plan/tasks 一致：用户可手改、git 可追踪、refs 可直接读（`jobs.json` 被 refs 子系统直接读，`:46865`）。
- 最小切片：jobs.json + 三种调度器 + WS `generate_response` 回环 + runs.json（每 job 留 100 条）。**重试、stuck 回收、(no output) 抑制**三件套是生产可用的分水岭，照抄参数（重试 3 次/退避 5s×n、600s 强制清理）。
- **坑 1**：WS 回环意味着「调度器是自家 API 的客户端」——服务未就绪时 job 触发会抛 `WebSocket not connected`（`:64894` 原文），要有重连与丢弃策略。
- **坑 2**：`(no output)` 抑制清单是喂出来的经验——不做的后果是用户每天收到「今天没有更新」的机器人废话，三天后关掉整个功能。
- **坑 3**：cron thread 用 `⏰ Cron:` 标题前缀做孤儿识别——这是「命名即元数据」的妥协设计（metadata.isCron 才是正牌标记，但标题前缀能扛 metadata 丢失）。

---

## 14. TTS python sidecar + sherpa worker + whisper STT（11 + 3 路由）

### 14.1 是什么

语音双件：**TTS 三引擎分流**（本地 sherpa-onnx 常驻 worker / Qwen3-TTS python sidecar / 在线 ElevenLabs/OpenAI），**STT 用 @fugood/whisper.node 本地推理**。全部本地优先，在线引擎是可选增强。

### 14.2 TTS 引擎 A：sherpa-onnx（常驻 worker，首选）

- worker 脚本 `Resources/tts/sherpa/tts-worker.cjs`，由**随包 bun 二进制**拉起：`spawn(bun, [workerScript], {stdio:["pipe","pipe","pipe"], env:{...process.env, SHERPA_ENTRY: <sherpa-onnx.js 路径>}})`（`:21051-21056`，缺依赖时抛 `sherpa TTS worker unavailable`）；sherpa-onnx-node 从 `app.asar.unpacked/node_modules/sherpa-onnx-node/` 解析（`:21015-21033`）。
- **通信：stdin/stdout 逐行 JSON**：请求 `{id, lang, config, text}`；响应 `{id, ok, pcm(base64), sampleRate}`；60s 超时（`:21080-21129`）。
- 模型按语言二选一，首次用到时下载（镜像前缀 `:20788-20795`：`https://release.yansu.app/...`、`https://model-assets.yansu.app/...`、GitHub k2-fsa releases）：
  - 中文：`vits-melo-tts-zh_en.tar.bz2`（`vh`，`:20785`；VITS + lexicon + ruleFsts，noiseScale 0.667）
  - 英文：`kokoro-en-v0_19.tar.bz2`（`Th`，`:20786`）
  - 模型落盘 `~/.config/alma/tts/sherpa/`。
- 后处理：peak normalize（0.95、增益上限 8）→ 12ms fade in/out → 手写 44 字节 WAV 头（`:21259-21306`）。
- 路由 `/api/tts/speech/{split,synthesize,prewarm,ensure-model,delete-model,model-status,events}`（`77317-77398`），events 是 SSE（`model-error` 等事件推送）。

### 14.3 TTS 引擎 B：Qwen3-TTS python sidecar（按需 CLI）

- `Resources/tts/`：`tts_cli.py`（CLI 入口）、`main.py`、`download_model.py`、`requirements.txt`（mlx-audio、transformers 5.0.0rc3——**仅 Apple Silicon**）。
- **setup 流水线**（`POST /api/tts/setup`，SSE 进度流，`76919-77201`）：复制 4 个 py 文件到 `~/.config/alma/tts/` → 用随包 `uv` 装 Python 3.12 + 建 `.venv` + `pip install -r requirements.txt`（哨兵文件 `.venv/.deps-installed`）→ 跑 `download_model.py` 从 HF 拉 `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` 到 `~/.config/alma/tts/models/CustomVoice-1.7B`。
- 调用：`python3 tts_cli.py --text ... --output x.wav [--voice Vivian] [--emotion "cheerful"] [--speed 1.0]`（tts_cli.py 头部原文）。**一次性进程**，非常驻。
- voice skill 9 个音色白名单（`bundled-skills/voice/SKILL.md`）：serena（默认）/vivian/ono_anna/sohee/uncle_fu/ryan/aiden/eric/dylan。

### 14.4 引擎选择与出口

`POST /api/tts/generate`（`:77202`）：文本截 4000 → 设置解析顺序（`getTtsSettings`，`:20512-20567`）：`local/qwen` → `elevenlabs` → `openai` → 本地 sherpa → 返回 `audio/wav`。opus 转码用系统 `ffmpeg -y -i <in> -c:a libopus -b:a 64k -ar 48000 -ac 1 <out>`（`convertToOpus`，`:20469-20491`，命令原文在 `:20477`）。agent 侧经 voice skill 的 `alma tts "..." --voice serena --emotion cheerful --output /tmp/x.wav` 触达；`POST /api/voice/send` 把音频发到 Telegram。

### 14.5 STT：whisper.node

- `WhisperService`（`:54211`）：模型目录 `userData/whisper_models/ggml-<id>.bin`（`:54219`）；`initWhisper({filePath, useGpu:true})`（`:54225` 附近）；转录 `whisperContext.transcribeData(Int16Array.buffer, {language, maxThreads:4})`；内部统一重采样到 16kHz。
- 路由：`GET /api/whisper/models`、`POST .../:modelId/download`、`DELETE .../:modelId`（`78144-78150`）。
- 主要消费方：Telegram 语音消息——转写后包装成 `[Voice message transcription | spoken_language: xx] ...` 注入对话（`:54986-54998`）。

### 14.6 复刻要点

- 最小切片：sherpa worker（bun 拉起 + stdio 行 JSON）+ `/api/tts/generate` 一个出口。python Qwen3-TTS 的 uv 环境流水线工程量不小，后置。
- **坑 1**：stdio JSON 协议要给每请求配 `id` 并做超时——worker 是单进程串行的，不发超时清理的话一个挂起的合成会堵死整个 TTS。
- **坑 2**：模型下载要多镜像 fallback（Alma 用三个前缀），HF 在国内不可达是常态。
- **坑 3**：whisper 的输入必须重采样到 16kHz Int16——采样率不对不会报错，只会转出一堆乱码，排查时先看这个。

---

## 15. usage 计量（2 表 + 3 路由）

### 15.1 是什么

token 用量与成本的计量系统：每轮生成完成即落一行 `usage_records`，stats 端点按模型定价表聚合出成本；另有一个把旧存储（消息 metadata 里的零散用量）迁到独立表的后台迁移任务。

### 15.2 数据模型

`usage_records`（`tables-all.sql:649`，drizzle `:1373`）：

```sql
CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    model TEXT,
    provider_id TEXT,
    date TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    cache_write_input_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
)
```

`usage_migration_status`（`tables-all.sql:637`）——单行表（`id INTEGER PRIMARY KEY CHECK (id = 1)`）：`{status default 'pending', total_count, migrated_count, last_migrated_id, started_at, completed_at, error_message}`。

### 15.3 写入与聚合

- 写入点：生成收尾时 `saveUsageRecord`（一轮一行）；Anthropic 的 `cacheCreationInputTokens` 记 `cache_write_input_tokens`。
- `GET /api/usage/stats`（`101973-102100+`）：`period=day|week|month|year` 或 `startDate/endDate`，可过滤 providerId/modelId；带 TTL 缓存；聚合后按**模型定价表**算 `totalCost`——插件注册的 provider 走 `sd.getSDKType` 也进计费（即「插件 provider 的用量也能计价」，这是 plugins 与 usage 的整合点）。
- `GET /api/usage/migration-status` + `POST /api/usage/start-migration`：迁移任务状态/触发，进度经 WS `usage_migration_progress` 广播。

### 15.4 复刻要点

- 最小切片：就一张 `usage_records`（先只记 input/output/model 三列也行，但外键必须挂 message_id 和 thread_id——按会话/按消息对账是刚需）。
- **坑 1**：cached/cache_write/reasoning 三种 token 分列而不是塞 JSON——stats 聚合时按列 SUM 比解析 JSON 快几个量级，而且 Anthropic/OpenAI 的缓存计费单价不同，分不了列就算不了成本。
- **坑 2**：定价表是易腐数据（模型调价频繁），做成可更新的配置而不是写死在代码里。
- **坑 3**：迁移任务是「单行状态表 + 后台批跑 + WS 进度」的标准三件套，这套模式 Alma 在 embedding rebuild 里也用——值得做成通用骨架。

---

## 16. 小路由组合写（12 组，每组一节）

### 16.1 people（7 路由）：文件型人物画像

**无 DB 表**——目录 `~/.config/alma/people/` 下的 `<name>.md` + `<name>.avatar.jpg`（系统 prompt 自述原文 `:89276`：「people/ — per-person profiles (people/<name>.md, <name>.avatar.jpg)」）。`GET /api/people` 扫目录 `*.md`（`93509-93529`）；`GET/PUT/DELETE /:name`；avatar 三路由，除主 avatar 外还有 `<name>.avatar.discord.jpg / .telegram.jpg / .feishu.jpg` 平台分身（`:52860,52955`）。PUT body `{content, frontmatter}`，frontmatter 序列化为 YAML 头。**格式约定**（系统 prompt 原文 `:89276`）：`telegram_id: "123456789"` 等平台 ID 必须是**带引号字符串**，用于跨平台身份匹配（`resolveLinkedUserIds` 就靠它合并记忆命名空间）。群聊场景注入 `alma people list/show` CLI 提示（`:55265`）。记忆系统自动提取出的 `PERSON:<name>: <fact>` 格式条目也会路由到这里（`alma people append`）而不是进 memories 表。

**复刻要点**：20 行扫目录 + 两个读写端点即可。关键设计是「画像进文件不进 DB」——用户可手改、LLM 可用 Read/Write 工具直接维护；YAML frontmatter 的 ID 引号约定不写死的话，跨平台合并会对不上号。

### 16.2 groups（7 路由）：Telegram 群操作封装

`POST /api/groups/:chatId/pin|unpin|send|send-photo|send-document|send-video|leave`（`75822-75958`）——**不是 Alma 内部群组**，是给 agent/CLI 用的 Telegram 群管理出口。配合 `~/.config/alma/groups/<chatId>_<date>.log` 群聊日志与 `alma group history/context/search` CLI（群聊四层记忆见 §12.3）。复刻时并入 telegram bridge 即可，不必单独立项。

### 16.3 thread-labels（6 路由）：会话标签

`thread_labels` 表（`tables-all.sql:615` 附近，drizzle `:1478`）：`{id, name, color, sort_order, created_at, updated_at}`。CRUD + `PUT /api/thread-labels/reorder`。**注意：未发现 thread↔label 关联表/字段**——bundle 中无 `label_ids` 或 assignment 表，挂载很可能在 `chat_threads.metadata` JSON 内【推测】。复刻时建议直接建关联表 `thread_label_assignments(thread_id, label_id)`，比塞 metadata 干净。

### 16.4 custom-themes（5 路由）：用户主题库

`custom_themes` 表（`tables-all.sql:266` 附近）：`{id, name UNIQUE, display_name, type CHECK(type IN ('dark','light')), base_30 JSON, base_16 JSON, based_on, created_at, updated_at}`——tinted-theming 体系的 base16/base30 调色板，`based_on` 记录派生自哪个内置主题。与 plugin-themes 的关系：custom-themes 是**用户数据库存储**，plugin-themes 是**插件运行时贡献**并经 `MI()` 展开成完整 token（§6.5）。两条线独立，UI 合并展示。

### 16.5 prompts（6 路由）：提示词/规则文本库

`prompts` 表（drizzle `:765-772`）：`{id, name, content, sort_order, created_at, updated_at}`——用户保存的规则文本，是 refs 系统里 `alma://prompt/<id>` 的载体（modelHint 原文：「Resolve returns the full text — treat it as instructions to follow」）。CRUD + reorder。价值场景：消息里 `@核查规则` 就把这段文本注入 agent 上下文。复刻成本约等于零，做。

### 16.6 hooks（4 路由）：Claude Code 风格生命周期钩子

配置文件 `~/.config/alma/hooks.json`（`DI = "hooks.json"`，`:51462`），结构 `{hooks: {<event>: [{matcher: "正则", hooks: [{command, timeout?, enabled?}]}]}}`。`GET/PUT /api/hooks`、`GET /path`、`POST /reload`。机制（`:51575-51660`）：事件匹配——`tool.*` 事件匹配 tool 名、`chat.message.willSend` 匹配消息内容；执行 `sh -c <command>`，env 注入 `ALMA_HOOK=true`（`:51625`），stdin 收 JSON `{hook, input, matcher}`，默认超时 10s；**exit code 2 或 stdout `decision=block` 可阻断事件**（`:51599-51603`：命中即 break）；非法 matcher 正则降级为 `/^$/` 并记日志。fs.watch 300ms 防抖热载，注册进全局事件总线、priority -10（先于插件 hooks）。**复刻要点**：这是给用户留的「自动化后门」，matcher + command + block 三要素即可，阻断语义（exit 2）照抄 Claude Code 成例。

### 16.7 reaction（1 路由）：消息表情

`POST /api/reaction/set {emoji, messageId}`（`78183`，handler `:100797`）：body 校验 emoji 必填字符串，调 `invokePendingReaction(emoji, messageId)` 动态模块执行——实际语义是给渠道消息（Telegram 等）回 reaction 表情（agent 侧的 `YI` emoji 回应工具走同一管线）。复刻时并入渠道层。

### 16.8 rtk（1 路由）：CLI 输出压缩器

RTK 是 **Rust 编写的命令输出压缩器**——Bash 工具执行命令前经改写：若命令主词在 22 个白名单（`git, npm, pnpm, yarn, bun, cargo, grep, rg, find, fd, ls, tree, cat, tsc, eslint, vitest, jest, pytest, curl, wget, docker, pip`，`Km`，`:24858-24876`）且无管道/重定向元字符（`/[|&;`$(){}]/`），则替换为 `<rtk路径> <原命令>`，由 rtk 把冗长输出（如 `npm install` 的刷屏）压成摘要再进 agent 上下文。二进制查找顺序：`resources/rtk` → `vendor/rtk/<platform>-<arch>` → cargo bin → homebrew（`Jm()`，`:24834-24856`）。追踪库 `rtk-tracking.db`（`:24820-24829`）。`GET /api/rtk/stats`（`:75704-75728`）返回 `{available, summary{totalCommands, totalSavedTokens, avgSavingsPct, ...}, daily[], byCommand[], recent[]}`——面向 agent 上下文的 token 节省统计。**复刻要点**：思路可抄（命令白名单 + 输出压缩），实现不必是 Rust——一个 stream filter 包常见命令的 noisy 输出即可；白名单 + 元字符拒改两条安全闸不能省（带管道的命令改写会改变语义）。

### 16.9 ptc（1 路由 + run_script 工具）：Programmatic Tool Calling

`GET /api/ptc/stats`（`:75730-75755`）是统计出口，本体是 `run_script` 工具（开关 `settings.advanced.programmaticToolCalling`，`:82015`）：agent 写一段 Node 脚本在沙箱（临时目录 + 超时 + 审批弹窗「Allow run_script (programmatic tool calling)?」`:82063`）里跑，preamble 注入 `almaTool(name,args)`（POST `/api/tools/invoke`，带每会话 `ALMA_PTC_SESSION`/`ALMA_PTC_TOKEN`）、`listTools()`、`sh(cmd)`。**价值闭环**（返回给模型的 note 原文）：`"Only stdout is shown to you; N tool result(s) (~X tokens) stayed in the sandbox, saving ~Y context tokens."`（`:82156`）——工具结果留在沙箱不进上下文。stats `{totalRuns, totalToolCalls, totalSavedTokens, daily[]}` 落盘 `~/Library/Application Support/alma/ptc-stats.json`。**复刻要点**：这是「省上下文」的高级优化，主链路稳了再做；`/api/tools/invoke` 的会话 token 网关是安全核心，不能做成裸奔的工具直调。

### 16.10 tool-model（3 路由）：辅助小模型配置

`GET /api/tool-model`、`GET /api/tool-model/memory`、`POST /api/tool-model/test`（`74240-74244`）——「tool model」是 Alma 里干杂活的小模型（bash 风险分析、群聊 isDirectedAtBot 判定、记忆提取/查重、slug/标题生成、查询改写都用它）。这三条路由就是读配置 + 测连通。tool model 失败自动回退主模型（heartbeat 处有实证）。**复刻要点**：把「主模型 / tool model / summary model / embedding model」做成四个独立配置槽——v0.0.990 全系统都是这个格局，写死单一模型会在成本和延迟上双输。

### 16.11 local-embeddings（4 路由）：本地向量模型管理

`GET /api/local-embeddings/models`、`POST /download`、`DELETE /models/:modelId`、`GET /progress`（`77658-77670`）——管理 transformers.js 本地 embedding 模型的下载/删除/进度推送。候选 4 个全是 384 维 Xenova 版（`all-MiniLM-L6-v2`、`bge-small-en-v1.5`、`multilingual-e5-small`、`paraphrase-multilingual-MiniLM-L12-v2`），缓存目录 `userData/embedding-models`。注意 v0.0.990 的 embedding **默认已是云端** `text-embedding-3-small`（`memory_metadata.embedding_model` 记账，`:1898`），本地模型是 `__local__` 可选项；维度随模型动态重建（vec0 表空时 DROP 重建，非空走批量 rebuild）。细节归记忆篇，这里只记路由面。

### 16.12 plan / tool-group-summary（路由各归其主）

- **plan** 11 条已并入 §4（Plan Weave）。
- `POST /api/tool-group-summary`（`74149`）：配套 `tool_group_summaries` 表（`tables-all.sql:625`：`{segment_key PK, thread_id, message_id, tool_signature, summaries JSON, model, ...}`）——把一段连续工具调用（同一 signature 的调用组）用小模型压成摘要，供长会话上下文展示/压缩用。segment_key 是「thread + 消息段 + 工具签名」的复合键，缓存命中即不重算。复刻归上下文压缩管线，不单独立项。

---

## 17. 总结：v2 子系统的四条架构经验

1. **文件即状态**。cron jobs、tasks、plan、people、hooks、cloud-sync 全部从 DB 迁到（或原生就是）`~/.config/alma/` 下的 JSON/Markdown——用户可手改、git 可追踪、refs 可直接索引、LLM 可用 Read/Write 工具维护。DB 只留给需要事务/关联/检索的（消息、记忆、用量、引用图谱）。这是 v0.0.990 相对旧版最一致的演进方向。
2. **WS 回环驱动 agent**。cron、heartbeat、channels、mobile-relay 都不直接调 agent 内核，而是作为客户端向 `/ws/threads` 发 `generate_response`——agent 入口永远只有一个，所有子系统复用同一条生成管线（含审批、压缩、落库、广播）。
3. **sidecar 各司其职**。tts（python/uv）、bun（插件编译 + sherpa worker + 沙箱执行）、lark-cli、rtk（Rust）、computer-use（Swift AX daemon）、chrome-extension（MV3）——主进程只做编排，能力全部外挂，二进制查找全部走「Resources → vendor → 系统路径」三级 fallback。
4. **小模型分层**。主模型 / tool model / summary model / embedding model 四槽独立配置，脏活累活（风险分析、判重、提取、压缩、改写）全部下沉 tool model——这是成本控制与延迟控制的核心手段。

> 考古注脚：本篇所有行号均指 `/tmp/alma-extract/main.readable.js`（prettier + js-beautify 两轮美化后的 v0.0.990 bundle），grep 引号内的字符串字面量即可复核。路由全量在 `/tmp/alma-extract/routes-all.txt`，建表原文在 `/tmp/alma-extract/tables-all.sql`。区块调研中间产物（六份 subagent 报告）含更多 prompt 原文与协议帧细节，未全部誊入本篇。
