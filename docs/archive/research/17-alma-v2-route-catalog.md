# 17 · Alma v0.0.990 完整路由与 WebSocket 目录

> 调研对象：Alma v0.0.990（2026-08-21 构建），主进程+后端 bundle `/tmp/alma-extract/main.readable.js`（107,803 行）
> 调研方法：静态提取全部路由注册点（正则匹配 `.get/.post/.put/.delete` + 向下 3 行找 `"/api/..."` 字符串），逐组抽查注册点附近处理器推断功能；WS 分发器整段精读
> 性质：**纯静态考古**。行号均指 `main.readable.js`；完整原始路由清单落盘 `/tmp/alma-extract/routes-all.txt`（497 条）
> 每条结论后标注【实证】（bundle 原文可复核）或【推测】（由方法名/处理器名推断）。

---

## 0. 本篇定位

这是 **v0.0.990 的完整 API 面快照**：**497 条 REST 路由（分 70 组）+ 12 个 WebSocket 端点**。它取代旧版 03 篇 §2 的路由表（v0.0.960 口径，约 404 条）和 §3 的 WS 协议描述。

与官方文档的关系：`~/.config/alma/api-spec.md` 是 Alma **启动时由后端自动重新生成**的（`main.readable.js:93841-93856`，Base URL 里带动态端口），但它只覆盖 settings/providers/models/health 等核心子集，且生成逻辑滞后于代码——**一切以 bundle 为准**。

路由总入口是服务单例 `class RM`（`main.readable.js:73347`），`new RM()` 于 107087 行实例化；`constructor(e = 23001)`（73549）默认端口 23001、被占用则递增；只绑回环 `this.server.listen(this.port, "127.0.0.1", ...)`（93833）；兜底 404 是 `this.app.use("/api/{*path}", ...)`（78816）——注意这是 **Express 5 的通配语法**，Express 4 写法在 v5 会直接抛错。本机 REST **无全局鉴权**，仅 chrome-relay / mobile-relay / `/ws/browser-relay` 三个对外面校验 token（`/ws/browser-relay` 处 `US.validateToken`，85541-85543）。

---

## 1. REST 路由总表（70 组 / 497 条）

按功能域分小节。每组给出：路由数、职责（1-3 句）、全部路由清单。重点组逐条注释。

### 1.1 `/api/threads`（28 条）— 会话线程【核心】

会话的 CRUD 与全部编排动作。注册点 74139 起、跨 75759-76579 补注册若干动作路由。`goal`（目标评估）与 `loop`（定时循环跑）是 v0.0.990 新增的线程级属性。

| 方法 路径 | 功能 |
|---|---|
| `GET /api/threads` | 线程列表 |
| `POST /api/threads` | 创建线程 |
| `GET /api/threads/:id` | 单线程详情（含 metadata.activePath） |
| `PUT /api/threads/:id` | 更新（标题/模型/工具/收藏等） |
| `DELETE /api/threads/:id` | 删除（消息级联删） |
| `POST /api/threads/batch-delete` | 批量删除 |
| `POST /api/threads/archive` | 归档/取消归档 |
| `POST /api/threads/:id/branch` | 从某条消息分叉出新线程 |
| `POST /api/threads/:id/activate` | 置为活跃线程 |
| `POST /api/threads/:id/switch` | 切换版本树 activePath（配合 switch-version） |
| `POST /api/threads/:id/compact` | 手动触发上下文压缩 |
| `GET/PUT/DELETE /api/threads/:id/goal` | 线程目标（goal 模式：带评估循环的目标驱动对话） |
| `GET/PUT/DELETE /api/threads/:id/loop` | 定时循环配置（线程按 cron 式规则自动跑） |
| `GET /api/threads/:threadId/messages` | activePath 上的消息列表 |
| `GET /api/threads/:threadId/subagent-messages` | 子 agent 消息树（按 parent_tool_call_id 组织） |
| `GET /api/threads/:threadId/agent-crew` | 本线程的多 agent 编队信息 |
| `GET /api/threads/:threadId/missions/:missionId/harness` | 某个 mission 的 harness 运行详情 |
| `GET /api/threads/:threadId/context-usage` | 上下文 token 用量（供 UI 显示压缩水位） |
| `GET /api/threads/:threadId/file-writes` | 本线程写过的文件清单 |
| `GET /api/threads/:threadId/diff-stats` | 工作区 diff 统计（缓存表 thread_diff_stats_cache） |
| `GET /api/threads/:threadId/traces` | 消息执行追踪 |
| `POST /api/threads/:threadId/inject-test-message` | 注入测试消息（开发调试） |
| `POST /api/threads/:threadId/send-photo` | 向线程发图片（渠道复用） |
| `GET /api/threads/:threadId/providers/:providerId/acp-commands` | ACP provider 的可用命令 |

### 1.2 `/api/messages`（4 条）— 单条消息版本树

注册点 74211-74223。rollback 带 `mode: "files-only" | "files-and-messages"`，基于 workspace 快照回滚文件（84532-84603）。

```
GET    /api/messages/:messageId/trace           # 消息追踪（模型/工具耗时链）
POST   /api/messages/:messageId/switch-version  # 在同 slot 的版本间切换
DELETE /api/messages/:messageId                 # 删消息（连带其后的版本分支）
POST   /api/messages/:messageId/rollback        # 回滚到该消息：可只回滚文件或文件+消息
```

### 1.3 `/api/workspaces`（64 条）— 工作区 + 内嵌 Git【全新大块】

v0.0.990 最大的新增域。工作区 = 一个绑到线程的本地目录；这组路由把它升级成**完整的文件管理器 + Git 客户端 + GitHub PR 面板 + 预览服务器管理**。注册集中在 77886-78128（git/status 字符串在 77956）。

**工作区 CRUD 与文件（17 条）**：

```
GET    /api/workspaces                                   # 列表
POST   /api/workspaces                                   # 创建（绑定本地目录）
GET    /api/workspaces/:id                               # 详情
PUT    /api/workspaces/:id                               # 更新（改名/autoWorktree 等）
DELETE /api/workspaces/:id                               # 删除
GET    /api/workspaces/:id/files                         # 文件树
GET    /api/workspaces/:id/files/{*filePath}             # 读文件文本（Express 5 通配）
GET    /api/workspaces/:id/files-binary/{*filePath}      # 读文件二进制
POST   /api/workspaces/:id/files/touch                   # 新建空文件
POST   /api/workspaces/:id/files/mkdir                   # 建目录
POST   /api/workspaces/:id/files/rename                  # 重命名
POST   /api/workspaces/:id/files/copy                    # 复制
POST   /api/workspaces/:id/files/move                    # 移动
DELETE /api/workspaces/:id/files/{*filePath}             # 删除
POST   /api/workspaces/:id/worktree/cleanup              # 清理失效 git worktree
```

**预览服务器（5 条）**——在工作区里起 dev server 并代理：

```
POST   /api/workspaces/:id/preview/start        # 启动预览（command/port 记入 preview_servers 表）
POST   /api/workspaces/:id/preview/stop
GET    /api/workspaces/:id/preview/status
GET    /api/workspaces/:id/preview/detect       # 探测项目类型/可用启动命令
GET    /api/workspaces/:id/preview/html-files   # 列出可直接预览的 html
```

**内嵌 Git（30 条）**——status 到 rebase/AI 解冲突全套，前端是完整的 Git GUI：

```
GET    /api/workspaces/:id/git/status                  # 工作区状态
GET    /api/workspaces/:id/git/is-repo
POST   /api/workspaces/:id/git/init
POST   /api/workspaces/:id/git/stage | unstage | stage-all | unstage-all
POST   /api/workspaces/:id/git/discard                 # 丢弃更改
GET    /api/workspaces/:id/git/diff                    # diff 内容
GET    /api/workspaces/:id/git/diff-stats
POST   /api/workspaces/:id/git/commit
GET    /api/workspaces/:id/git/log
GET    /api/workspaces/:id/git/commit/:hash            # 单次提交详情
GET    /api/workspaces/:id/git/branches
POST   /api/workspaces/:id/git/checkout
POST   /api/workspaces/:id/git/create-branch
DELETE /api/workspaces/:id/git/branch
GET    /api/workspaces/:id/git/remotes
POST   /api/workspaces/:id/git/push | pull | fetch
GET    /api/workspaces/:id/git/stash                   # stash 列表
POST   /api/workspaces/:id/git/stash/push | pop | apply | drop
POST   /api/workspaces/:id/git/generate-commit-message # ★ 用 LLM 生成 commit message
GET    /api/workspaces/:id/git/worktrees               # worktree 列表
POST   /api/workspaces/:id/git/worktrees               # 创建 worktree
DELETE /api/workspaces/:id/git/worktrees
GET    /api/workspaces/:id/git/rebase/status
POST   /api/workspaces/:id/git/rebase                  # 开始 rebase
POST   /api/workspaces/:id/git/rebase/continue
POST   /api/workspaces/:id/git/rebase/abort
GET    /api/workspaces/:id/git/conflicts               # 冲突文件列表
POST   /api/workspaces/:id/git/conflicts/resolve       # 手动解冲突（提交解决内容）
POST   /api/workspaces/:id/git/conflicts/resolve-ai    # ★ AI 解单个冲突（78110）
POST   /api/workspaces/:id/git/conflicts/resolve-all-ai# ★ AI 解全部冲突（78114）
```

**GitHub PR（6 条）**：

```
GET    /api/workspaces/:id/github/pr          # 当前分支关联的 PR
POST   /api/workspaces/:id/github/pr          # 创建 PR
POST   /api/workspaces/:id/github/pr/merge
POST   /api/workspaces/:id/github/pr/close
GET    /api/workspaces/:id/github/pr/refresh
GET    /api/workspaces/:id/github/ci-logs     # 拉 CI 日志
```

【复刻提示】这一组是 Alma 从「聊天工具」变成「agent IDE」的分水岭。文件 CRUD 是纯 Node fs；Git 用 isomorphic-git 或 shell 包 `git` 命令都能复刻（Alma 走后者风格——`generate-commit-message` 和 `resolve-ai` 是把 diff/conflict 内容喂给 LLM 的薄封装）；PR 组依赖 `gh` CLI 或 GitHub REST。

### 1.4 `/api/iab`（32 条）— 内置浏览器自动化（In-App Browser）

注册点 74715-75221（status 在 74715）。操控 Alma 内嵌的 Chromium 视图，是 `browser_*` 工具背后的 HTTP 面。

| 路由 | 功能 |
|---|---|
| `GET /api/iab/status` / `POST /api/iab/info` | 浏览器状态 / 当前页信息 |
| `POST /api/iab/navigate` `reload` `back` `forward` | 导航 |
| `POST /api/iab/screenshot` | 截图 |
| `POST /api/iab/click` `type` `scroll` | 坐标级交互 |
| `POST /api/iab/dom-click` `dom-type` `get-visible-dom` | DOM 级交互（选择器驱动，比坐标稳） |
| `POST /api/iab/read` `read-dom` | 读页面内容（read ≈ 可读性提取，read-dom ≈ 原始 DOM） |
| `POST /api/iab/eval` | 页面内执行 JS |
| `POST /api/iab/viewport` / `locator` | 视口信息 / 元素定位 |
| `POST /api/iab/cdp` | 裸 CDP 命令透传 |
| `POST /api/iab/upload` `download` `download-media` | 文件上传/下载/媒体抓取 |
| `POST /api/iab/dialog` | 应答 alert/confirm 对话框 |
| `POST /api/iab/clipboard` | 剪贴板读写 |
| `POST /api/iab/export` `export-gsuite` | 导出页面 / Google Workspace 文档导出 |
| `POST /api/iab/fetch` | 以浏览器会话发 fetch（带 cookie） |
| `POST /api/iab/cua` | computer-use 模式（截图+坐标，给视觉模型用） |
| `GET /api/iab/profiles` / `POST /api/iab/history` | 浏览器 profile / 历史 |
| `GET /api/iab/pip/frame` / `POST /api/iab/pip/:action` | 浏览器画中画悬浮窗的帧抓取与控制 |

### 1.5 `/api/computer-use`（30 条）— macOS 桌面自动化

注册点 75444-75699（status 在 75444）。基于 macOS Accessibility API 的桌面操控，带**按 bundle id 的审批白名单**和动作日志。

```
GET    /api/computer-use/status | ping             # 服务状态/测活
GET    /api/computer-use/permissions               # AX/录屏权限状态
POST   /api/computer-use/grant                     # 触发系统授权弹窗
GET    /api/computer-use/apps                      # 已安装应用
POST   /api/computer-use/list_apps | launch_app    # 运行中应用 / 启动应用
GET    /api/computer-use/approvals                 # 审批白名单（按 app bundle id）
POST   /api/computer-use/approvals                 # 加白
DELETE /api/computer-use/approvals/:bundle         # 移除
GET    /api/computer-use/check_approval            # 查询某 app 是否已批准
GET    /api/computer-use/action_log                # 动作日志
POST   /api/computer-use/action_log                # 写动作日志
POST   /api/computer-use/windows                   # 窗口列表
POST   /api/computer-use/snap                      # 抓取某应用 UI 树（AX snapshot）
POST   /api/computer-use/get_app_state             # 应用状态聚合
POST   /api/computer-use/click                     # 点击
POST   /api/computer-use/perform_secondary_action  # 右键/次要动作
POST   /api/computer-use/drag                      # 拖拽
POST   /api/computer-use/type | type_text          # 键盘输入
POST   /api/computer-use/press | press_key         # 按键
POST   /api/computer-use/set_value                 # 直接设控件值（AXValue）
POST   /api/computer-use/select_text               # 选中文本
POST   /api/computer-use/scroll                    # 滚动
POST   /api/computer-use/lens                      # 局部放大截图
POST   /api/computer-use/raise                     # 置前窗口
POST   /api/computer-use/shot                      # 全屏/窗口截图
POST   /api/computer-use/shutdown                  # 关停 computer-use 服务
```

### 1.6 `/api/refs`（21 条）— `alma://` 引用图谱【全新子系统】

注册点 47315-48016（kinds 在 47315）。Alma 内部的**统一资源寻址 + 双链系统**：任何可引用对象都有一个 `alma://` URI，消息/prompt/memory/snippet 正文里的 `](alma://...)` 链接被索引成图谱。

URI 前缀常量 `Zn = "alma://"`（506）；kind 枚举 19 种（`Kn` 数组，350-370，原文）：

```js
const Kn = [
    "thread", "message", "snippet", "file", "project", "host",
    "skill", "agent", "mission", "plan", "prompt", "mcp",
    "model", "memory", "artifact", "tool", "task", "provider", "cron",
];
```

每种 kind 带 `label/order/prefixes/modelHint/scope`（`Vn`，371-505），`modelHint` 直接进系统 prompt 教模型怎么用（如 file: "Resolve gives the absolute path (and host) — read/edit it with your file tools."）。索引靠 SQL `LIKE '%](alma://%'` 扫描 messages/prompts/memories/snippets 四张表（5610、5723、5733、5744）。

```
GET    /api/refs/kinds                 # 19 种 kind 及其元信息
GET    /api/refs/search                # 搜索可引用对象（补全用）
GET    /api/refs/resolve               # URI → 对象摘要
POST   /api/refs/resolve               # 批量/带参 resolve
GET    /api/refs/backlinks             # 反链（谁引用了我）
GET    /api/refs/outlinks              # 正链（我引用了谁）
GET    /api/refs/graph                 # 引用子图
POST   /api/refs/backlink-counts       # 批量反链计数
GET    /api/refs/recent                # 最近引用
GET    /api/refs/snippets              # 引用片段列表（reference_snippets 表）
POST   /api/refs/snippets              # 从选中文本建片段
POST   /api/refs/snippets/from-turns   # 从对话轮次批量建片段
DELETE /api/refs/snippets/:id
GET    /api/refs/recipes               # recipe（可复用的引用组合）
POST   /api/refs/recipes/state
POST   /api/refs/open                  # 在系统里打开引用目标
GET    /api/refs/related               # 相关引用
POST   /api/refs/link / unlink         # 手动建立/解除链接
GET    /api/refs/context               # 组装某 URI 的上下文（喂模型用）
POST   /api/refs/reindex               # 重建索引
```

### 1.7 `/api/plugins`（14 条）+ `/api/plugin-themes`（4 条）— 插件系统

注册点 77824-77860。插件是从目录加载的扩展包（`~/.config/alma/plugins/`），带**权限声明**与**设置 schema**；plugin-themes 是插件贡献的主题。

```
GET    /api/plugins                          # 已安装插件列表
POST   /api/plugins                          # 安装（从路径/包）
POST   /api/plugins/refresh                  # 重扫插件目录
GET    /api/plugins/updates                  # 有更新的插件
GET    /api/plugins/updates/known            # 已知版本信息
GET    /api/plugins/:id                      # 详情
DELETE /api/plugins/:id                      # 卸载
POST   /api/plugins/:id/enable | disable     # 启停
GET    /api/plugins/:id/settings             # 读插件设置
PUT    /api/plugins/:id/settings             # 写插件设置
GET    /api/plugins/:id/permissions          # 权限声明
PUT    /api/plugins/:id/permissions          # 授权/收回
POST   /api/plugins/:id/update               # 升级单个插件
GET    /api/plugin-themes                    # 插件主题列表
GET    /api/plugin-themes/:id
POST   /api/plugin-themes/:id/apply          # 应用主题
POST   /api/plugin-themes/clear              # 清除
GET    /api/plugins-path                     # 插件目录绝对路径
```

### 1.8 `/api/prompt-apps`（8 条）+ `/api/prompt-app-executions`（2 条）+ `/api/prompts`（6 条）

prompt-apps 注册点 77712-77739。**提示词应用** = 带占位符的 prompt 模板 + 可指定模型/工具，一键执行成独立 run；`prompt_app_executions` 表存执行记录。`prompts` 是更轻的快捷提示词片段库。

```
GET    /api/prompt-apps                      # 列表
POST   /api/prompt-apps                      # 创建（模板+占位符定义）
PUT    /api/prompt-apps/reorder              # 排序
GET    /api/prompt-apps/:id
PUT    /api/prompt-apps/:id
DELETE /api/prompt-apps/:id
GET    /api/prompt-apps/:id/executions       # 执行历史
POST   /api/prompt-apps/:id/execute          # 执行（填占位符 → 起 run）
GET    /api/prompt-app-executions/:id        # 单次执行详情
DELETE /api/prompt-app-executions/:id

GET    /api/prompts                          # 快捷提示词列表
POST   /api/prompts
PUT    /api/prompts/reorder
GET    /api/prompts/:id
PUT    /api/prompts/:id
DELETE /api/prompts/:id
```

### 1.9 `/api/plan`（11 条）+ `/api/plan-mode`（3 条）— Plan Weave 任务图

注册点 78186-78202（plan-mode 78186、plan 78189）。**Plan Weave** 是 Alma 的任务分解/执行图：一个 plan 由若干 block 组成，agent `claim` 一个 block 干活、`submit` 交差、`review` 验收。`plan-mode` 是全局「先规划后执行」开关。

```
GET    /api/plan-mode                # 计划模式状态
POST   /api/plan-mode/enter          # 进入（后续对话先出计划）
POST   /api/plan-mode/exit

GET    /api/plan                     # 当前 plan
POST   /api/plan                     # 创建/覆盖 plan
DELETE /api/plan
GET    /api/plan/block               # 取下一个可做 block
POST   /api/plan/claim               # agent 认领 block
POST   /api/plan/submit              # 提交 block 产出
POST   /api/plan/review              # 提交验收意见
POST   /api/plan/resolve             # 解决反馈
POST   /api/plan/blocked             # 标记 block 受阻
POST   /api/plan/reset               # 重置
POST   /api/plan/archive             # 归档
```

### 1.10 `/api/terminal`（6 条）— 内嵌终端

注册点 78129-78143。node-pty 会话管理；I/O 走 `/ws/terminal/<id>`（见 §2）。

```
POST   /api/terminal/create          # 创建 pty 会话（返回 id）
DELETE /api/terminal/:id             # 关闭
GET    /api/terminal/sessions        # 活会话列表
POST   /api/terminal/exec            # 一次性执行命令（非交互）
GET    /api/terminal/:id/output      # 拉输出缓冲
POST   /api/terminal/:id/input       # 写输入（WS 之外的备用通道）
```

### 1.11 `/api/remote-hosts`（6 条）— SSH 远程主机

注册点 77868-77882。登记 SSH 主机，工作区可以建在远程主机上（远程 workspace 不走本地文件 watch，见 §2 `/ws/workspace/`）。

```
GET    /api/remote-hosts/ssh-config      # 解析 ~/.ssh/config 里的主机（导入用）
GET    /api/remote-hosts                 # 已登记主机列表
POST   /api/remote-hosts                 # 登记（host/user/port/key）
DELETE /api/remote-hosts/:id
POST   /api/remote-hosts/:id/test        # 连通性测试
GET    /api/remote-hosts/:id/browse      # 远程目录浏览（选工作区路径用）
```

### 1.12 `/api/mobile-relay`（8 条）— 手机端中继

注册点 74333-74469。通过 relay 服务器（默认 `relay.alma.now`）把手机 App 接到本机 Alma；OAuth 授权 + E2E 加密。enable 处理器校验 `serverUrl` 必须是 `^https?://`（74336-74345）。

```
GET    /api/mobile-relay/status           # 连接状态（脱敏版）
POST   /api/mobile-relay/enable           # 启用（可指定自建 relay serverUrl）
POST   /api/mobile-relay/token            # 取配对 token
POST   /api/mobile-relay/connect-account  # 账号绑定
GET    /api/mobile-relay/oauth-callback   # OAuth 回跳
POST   /api/mobile-relay/e2e              # E2E 密钥交换
POST   /api/mobile-relay/disable
POST   /api/mobile-relay/regenerate       # 重新生成配对信息
```

### 1.13 `/api/cloud-sync`（4 条）— 云同步快照

注册点 78163-78172。把本地数据快照推到云端（多设备同步的最小面）。

```
GET    /api/cloud-sync/state          # 同步状态
POST   /api/cloud-sync/enable
POST   /api/cloud-sync/disable
POST   /api/cloud-sync/push-snapshot  # 手动推一份快照
```

### 1.14 `/api/channels`（2 条）+ IM 渠道组（groups/chat/discord/feishu/weixin/voice/reaction）

`channels` 注册点 75987 附近。`GET /api/channels/:platform` 返回某平台已对接的会话列表——平台白名单原文（75990）：

```js
if (!["telegram", "discord", "feishu", "lark"].includes(n))
    return t.status(400).json({ error: "Invalid platform" });
```

`POST /api/channels/telegram/clear-inactive`（74159）清理 telegram 不活跃映射。各渠道组：

```
# groups（7 条）— Telegram 群操作
POST   /api/groups/:chatId/pin | unpin | leave
POST   /api/groups/:chatId/send | send-photo | send-document | send-video

# chat（6 条）— 通用聊天发送 + OpenAI 兼容端点
POST   /api/chat/:chatId/send-photo | send-document | send-video | send-audio | send-voice
POST   /api/chat/completions          # ★ OpenAI 兼容补全（77591），供外部工具复用 Alma 的模型；
                                      #   崩溃恢复也用它给自己发续跑消息

# discord（10 条）
GET    /api/discord/servers
POST   /api/discord/channels/:channelId/send | send-photo | send-file | sticker
POST   /api/discord/dm
DELETE /api/discord/channels/:channelId/messages/:messageId
GET    /api/discord/channels/:channelId/messages
GET    /api/discord/stickers
POST   /api/discord/reaction

# feishu（9 条）
GET    /api/feishu/connect/state
POST   /api/feishu/connect/start | connect/cancel | disconnect
GET    /api/feishu/status
POST   /api/feishu/chats/:chatId/send | send-photo | send-file
POST   /api/feishu/messages/:messageId/reaction

# weixin（3 条）
GET    /api/weixin/status | qrcode          # 扫码登录
POST   /api/weixin/logout

# voice / reaction（各 1 条）
POST   /api/voice/send              # 发语音消息
POST   /api/reaction/set            # 给消息打表情
```

### 1.15 `/api/providers`（13 条）+ `/api/models`（1 条）— Provider 与模型

注册点 74114 起。与官方 api-spec 完全吻合的核心组。

```
GET    /api/providers                              # 列表（api_key 不回传明文）
POST   /api/providers                              # 新建（type: openai/anthropic/google/azure/acp/...）
PUT    /api/providers/:id
DELETE /api/providers/:id
POST   /api/providers/:id/test                     # 连通性测试
POST   /api/providers/:id/authenticate             # OAuth 登录（如 Copilot/订阅制 provider）
POST   /api/providers/:id/logout
GET    /api/providers/:id/accounts                 # 该 provider 下的账号
DELETE /api/providers/:id/accounts/:accountId
POST   /api/providers/:id/refresh-quotas           # 刷新配额
GET    /api/providers/:id/models                   # 已启用模型
POST   /api/providers/:id/models/fetch             # 从 provider 拉全部可用模型
PUT    /api/providers/:id/models                   # 更新启用集
GET    /api/models                                 # 跨 provider 聚合，ID 形如 "providerId:modelId"
```

### 1.16 `/api/memories`（20 条）— 长期记忆

注册点 77604-77656。语义检索 + 向量重建 + **sleep 后台整理**（睡眠时把碎片记忆合并成条目）。

```
GET    /api/memories                    # 列表
POST   /api/memories                    # 新增
GET    /api/memories/:id
PUT    /api/memories/:id
DELETE /api/memories/:id
DELETE /api/memories                    # 全清
GET    /api/memories/status | stats     # 状态/统计
GET    /api/memories/embedding-model    # 当前 embedding 模型
POST   /api/memories/search             # 语义检索
POST   /api/memories/rebuild            # 重建向量索引（换模型后触发）
GET    /api/memories/rebuild-progress
POST   /api/memories/cancel-rebuild
GET    /api/memories/sleep/status | sleep/runs    # sleep 整理状态/历史
POST   /api/memories/sleep/run          # 手动跑一轮 sleep 整理
POST   /api/memories/sleep/preview      # 预演（只返回将做什么，不落库）
POST   /api/memories/sleep/cancel
GET    /api/memories/archive            # 归档记忆
POST   /api/memories/archive/:id/restore
```

### 1.17 `/api/activity-recorder`（21 条）— 屏幕活动记录

注册点 78250-78717。周期性截屏 + OCR，生成「今天做了什么」的日报/周报；记忆系统的数据源之一。

```
GET    /api/activity-recorder/status | config          # 状态/配置
PUT    /api/activity-recorder/config
POST   /api/activity-recorder/start | stop
GET    /api/activity-recorder/digest                   # 近期摘要
GET    /api/activity-recorder/report/:dateKey          # 某日报告
GET    /api/activity-recorder/permissions              # 录屏权限
POST   /api/activity-recorder/permissions/open         # 打开系统权限设置
GET    /api/activity-recorder/sessions                 # 记录会话列表
GET    /api/activity-recorder/sessions/:id
DELETE /api/activity-recorder/sessions/:id
POST   /api/activity-recorder/sessions/:id/analyze     # 对一段记录做 LLM 分析
GET    /api/activity-recorder/snapshot-file            # 取某帧截图
GET    /api/activity-recorder/search/keyword           # 关键词检索（OCR 文本）
GET    /api/activity-recorder/search/semantic          # 语义检索
GET    /api/activity-recorder/summary/daily/:dateKey   # 日报
POST   /api/activity-recorder/summary/daily/:dateKey   # 生成日报
GET    /api/activity-recorder/summary/weekly/:weekKey  # 周报
POST   /api/activity-recorder/summary/weekly/:endDateKey
GET    /api/activity-recorder/suggestions              # 基于记录的建议
```

### 1.18 `/api/chrome-relay`（20 条）— 接管真实 Chrome

注册点 74248-74687。Chrome 扩展连 `/ws/browser-relay`（带 token），本组 REST 向扩展下发指令。与 iab 的区别：iab 是 Alma 内嵌浏览器，chrome-relay 是**用户自己的 Chrome**（带真实登录态）。

```
GET    /api/chrome-relay/status
GET    /api/chrome-relay/token                  # 扩展配对 token
POST   /api/chrome-relay/token/regenerate
POST   /api/chrome-relay/launch-chrome          # 以调试模式拉起 Chrome
GET    /api/chrome-relay/extension-path         # 扩展安装路径
POST   /api/chrome-relay/tabs                   # 标签列表
POST   /api/chrome-relay/tabs/create
POST   /api/chrome-relay/navigate | click | type | scroll
POST   /api/chrome-relay/screenshot | read | read-dom | eval
POST   /api/chrome-relay/upload
POST   /api/chrome-relay/back | forward
POST   /api/chrome-relay/detach | detach-all    # 脱离标签控制
```

### 1.19 `/api/tts`（11 条）+ `/api/whisper`（3 条）+ `/api/local-embeddings`（4 条）— 本地模型三件套

```
# tts（注册点 76824-77398）— sherpa-onnx 本地 TTS + 在线 TTS
GET    /api/tts/local-status
POST   /api/tts/setup | generate | test
POST   /api/tts/speech/split                    # 文本切块
POST   /api/tts/speech/synthesize
POST   /api/tts/speech/prewarm                  # 预热模型
POST   /api/tts/speech/ensure-model             # 确保模型已下载
POST   /api/tts/speech/delete-model
GET    /api/tts/speech/model-status
GET    /api/tts/speech/events                   # 进度事件（SSE）

# whisper — 本地 STT
GET    /api/whisper/models
POST   /api/whisper/models/:modelId/download
DELETE /api/whisper/models/:modelId

# local-embeddings — transformers.js 本地向量模型
GET    /api/local-embeddings/models
POST   /api/local-embeddings/download
DELETE /api/local-embeddings/models/:modelId
GET    /api/local-embeddings/progress
```

### 1.20 `/api/mcp-client`（10 条）+ `/api/mcp-servers`（7 条）+ `/api/mcp-marketplace`（1 条）

注册点 77763-77814。MCP 服务器配置的 CRUD 在 `mcp-servers`（DB 表 `mcp_servers`），运行态（连接/工具/资源）在 `mcp-client`。

```
GET    /api/mcp-client/status                   # 各 server 连接状态
GET    /api/mcp-client/tools                    # 聚合工具清单
GET    /api/mcp-client/resources                # 聚合资源清单
GET    /api/mcp-client/resources/:serverName
GET    /api/mcp-client/resource-templates
POST   /api/mcp-client/resources/read
POST   /api/mcp-client/resources/subscribe      # 订阅资源变更（推 /ws/mcp-resources）
DELETE /api/mcp-client/resources/subscribe
POST   /api/mcp-client/refresh
POST   /api/mcp-client/reconnect/:name

GET    /api/mcp-servers                         # CRUD
POST   /api/mcp-servers
GET    /api/mcp-servers/:id
PUT    /api/mcp-servers/:id
DELETE /api/mcp-servers/:id
GET    /api/mcp-servers/:id/oauth/status        # OAuth 授权状态
DELETE /api/mcp-servers/:id/oauth               # 清 token
GET    /api/mcp-marketplace                     # 服务器市场目录
```

### 1.21 设置/系统/杂项核心组

```
# settings（6 条，注册点 74228-74233）
GET    /api/settings                    # 整棵 AppSettings JSON（app_settings 表单行）
PUT    /api/settings                    # 整对象回写
POST   /api/settings/reset
POST   /api/settings/test-proxy
POST   /api/settings/test-telegram
POST   /api/settings/detect-telegram-users

# skills（5 条）+ skills-path — 技能（SKILL.md 文件）管理
GET    /api/skills                      # 聚合扫描（~/.config/alma/skills 等 7 个路径）
GET    /api/skills/:id
PUT    /api/skills/:id
DELETE /api/skills/:id
POST   /api/skills/refresh
GET    /api/skills-path

# cron（8 条，注册点 78732-78808）— 定时任务
GET    /api/cron/jobs                   # 任务定义存 ~/.config/alma/cron/jobs.json
POST   /api/cron/jobs
GET    /api/cron/jobs/:id
PUT    /api/cron/jobs/:id
DELETE /api/cron/jobs/:id
POST   /api/cron/jobs/:id/toggle        # 启停
POST   /api/cron/jobs/:id/run           # 立即跑一次
GET    /api/cron/jobs/:id/runs          # 运行历史

# agents（3 条）— 子 agent 任务
GET    /api/agents                      # 可委派的 agent profile
GET    /api/agents/tasks/:taskId        # 某个子任务状态（TaskManager 持久化在 ~/.config/alma/tasks/）
POST   /api/agents/tasks/:taskId/resume # 中断后续跑

# tools（2 条）+ tool-model（3 条）+ tool-group-summary（1 条）— PTC 直调面
GET    /api/tools/list                  # 全部内置工具
POST   /api/tools/invoke                # 不走 LLM 直接调工具（PTC，注册点 74246）
GET    /api/tool-model                  # 工具摘要用小模型配置
GET    /api/tool-model/memory
POST   /api/tool-model/test
POST   /api/tool-group-summary

# usage（3 条）— token 用量
GET    /api/usage/stats                 # usage_records 聚合
GET    /api/usage/migration-status
POST   /api/usage/start-migration       # 旧数据迁移

# data / update / heartbeat / health
GET    /api/data/export                 # 全量导出
POST   /api/data/import
GET    /api/update/status               # electron-updater
POST   /api/update/check | download | install
GET    /api/heartbeat/config            # 心跳自检（HEARTBEAT.md 驱动）
PUT    /api/heartbeat/config
GET    /api/heartbeat/status
GET    /api/health                      # {"status":"ok", ...}

# hooks（4 条，注册点 77864-77865）— 文件型钩子
GET    /api/hooks                       # ~/.config/alma/hooks.json
PUT    /api/hooks
GET    /api/hooks/path
POST   /api/hooks/reload
```

### 1.22 尾部小组（合并叙述）

| 组 | 路由 | 一句话 |
|---|---|---|
| `/api/thread-labels`（6） | CRUD + reorder | 线程标签 |
| `/api/custom-themes`（5） | CRUD | 用户自定义主题 |
| `/api/bun`（5，78153 起） | status/install/execute、executions/:id GET+DELETE | Bun 脚本沙箱执行，输出走 `/ws/bun/<id>` |
| `/api/pip`（7） | frame/state/present/invalidate/hide/computer-use-activity/move | 画中画悬浮窗（浏览器/computer-use 直播画面） |
| `/api/people`（7） | CRUD + avatar GET/POST/DELETE | 联系人档案（`~/.config/alma/people/`） |
| `/api/search`（1，74227） | `GET /api/search/threads` | 线程全文搜索（FTS5） |
| `/api/image`（2） | models、generate | 图像生成 |
| `/api/gallery`（2，77686） | images、images/:id | 生成图片画廊（gallery_cache/） |
| `/api/attachments`（2） | resolve-path、image | 附件上传/路径解析 |
| `/api/todos`（2） | GET/POST | 待办（todo_write 工具的面） |
| `/api/worktrunk`（2，78121） | status、install | worktrunk CLI（worktree 管理工具）检测/安装 |
| `/api/rtk`（1，75704） | `GET /api/rtk/stats` | RTK（Rust Tool Kit）权限统计 |
| `/api/ptc`（1，75730） | `GET /api/ptc/stats` | PTC（Programmatic Tool Calling）调用统计 |
| `/api/files-abs` `/api/files-abs-binary`（2） | GET | 按绝对路径读文件（文本/二进制） |
| `/api/window-capture`（1） | POST | 窗口截图 |
| `/api/system`（1） | `GET /api/system/fonts` | 系统字体列表 |
| `/api/github`（1） | `GET /api/github/status` | gh 登录态 |
| `/api/test-workspace-route`（1） | GET | 开发自检 |

---

## 2. WebSocket 协议（12 端点）

### 2.1 端点全景与分发器

所有端点共用一个 `new WebSocketServer({server})`（85360，即与 REST 同端口复用 HTTP upgrade），按 `new URL(t.url).pathname` 做 if-else 链分发（85366-85694）。**所有帧均为 JSON 文本帧**，信封 `{type, data?, timestamp?}`。

| 端点 | 方向 | 用途（行号） |
|---|---|---|
| `/ws/threads` | 双向 | **核心**：聊天流（85366）。连接即发 `generating_snapshot {ids:[...]}`（85370-85377） |
| `/ws/settings` | 双向 | 设置变更广播；上行仅 `theme_preview`，转发给其他 settings 客户端（85482-85504） |
| `/ws/providers` | 下行 | provider 状态广播（85505） |
| `/ws/memory` | 下行 | 记忆变更广播（85512） |
| `/ws/skills` | 下行 | 技能变更广播（85519） |
| `/ws/mcp-resources` | 下行 | MCP 资源订阅推送（85526） |
| `/ws/debug-sse` | 下行 | 调试事件流（85533-85539） |
| `/ws/browser-relay` | 双向 | Chrome 扩展 ↔ CDP 中继；**需 `?token=`**，`US.validateToken` 失败 `close(4001,"Invalid token")`（85540-85556） |
| `/ws/terminal/<id>` | 双向 | pty I/O（85557）。连接先发 `terminal_output {data: scrollbackBuffer}`（85572-85577）；上行 `input {data}` / `resize {cols,rows}`（85582-85584）；未知会话回 `{type:"error", error:"Terminal session not found"}` 后关闭 |
| `/ws/workspace/<id>` | 双向 | 工作区文件推送（85593）。连接先发全量 `{type:"file_tree_sync", files}`（85614-85617）；之后 `file_change {eventType,path,timestamp}`（85642-85648）+ 1s 防抖重发全量树；上行仅 `set_show_hidden_files {showHiddenFiles}`（85630-85635）；**远程 workspace 不 watch**（85652） |
| `/ws/bun/<executionId>` | 下行 | Bun 执行输出，`{type, data}` 原样转发订阅事件（85658-85670） |
| `/ws/preview/<workspaceId>` | 下行 | 预览服务器状态，`preview_status {...serverInfo}`（85671-85693） |

### 2.2 `/ws/threads` 上行帧（3 种）

分发代码 85381-85463，原文结构：

```js
const o = JSON.parse(t.toString());
if ("generate_response" === o.type || "steer_generation" === o.type) {
    const {
        threadId, userMessage, retryOfMessageId, replaceMessageId,
        tools, reasoningEffort, enabledMCPServerIds, source, noTools,
        ephemeralModel, userMessageMetadata, ephemeralContext,
        fromQuickChat, hummingbirdContext,
    } = o.data;
    ...
} else if ("stop_generation" === o.type) { ... }
```

| type | payload（`data` 字段） | 语义 |
|---|---|---|
| `generate_response` | `{threadId, userMessage?, retryOfMessageId?, replaceMessageId?, tools?, reasoningEffort?, enabledMCPServerIds?, source?, noTools?, ephemeralModel?, userMessageMetadata?, ephemeralContext?, fromQuickChat?, hummingbirdContext?, model?}` | 发起一轮生成。无 userMessage 时必须带 `retryOfMessageId` 或 `replaceMessageId`（重试/替换语义，85404-85412）；`model` 缺省时依次回落线程模型 → settings.chat.defaultModel（85425-85434），无冒号的模型名经 `resolveUnprefixedModel` 补 provider 前缀（85435-85441） |
| `steer_generation` | 同上 | **生成中插话**：线程正在生成时把消息折进当前轮继续跑；线程没在生成则回落为普通一轮（85416-85423） |
| `stop_generation` | `{threadId}` | 中断生成（85458-85462 → `stopGeneration`） |

解析失败/处理抛错时回发 `{type:"error", data:{error}, timestamp}`（85466-85473）。

### 2.3 `/ws/threads` 下行帧全集（44 种）

全部由 `broadcastThreadSync(type, data)` 发出（对订阅该广播的所有客户端群发）。以下枚举已逐一对 bundle 复核：36 种直接以 `broadcastThreadSync("<type>"` 形式出现；`generating_snapshot` 由连接时直发（85372），`recipe_ready`（85173）与 `subagent_message_*` 三种（30456-31353 区间）经局部广播函数转发，殊途同归：

```
thread_created / thread_updated / thread_deleted / thread_generating / thread_workspace_set
message_added / message_updated / message_deleted / message_rollback / message_delta
generating_snapshot / generation_completed / generation_error
context_compaction_started / context_compacted / context_usage_update / context_overflow_detected
title_generating / title_generated
goal_updated / loop_updated / plan_update / todo_update
workspace_created / workspace_updated / workspace_deleted
remote_host_created / remote_host_deleted / remote_host_status
recipe_ready / image_generating / ptc_inner_call / tool_group_summary
skill_analysis_progress / skill_extraction_progress / tool_analysis_progress
memory_retrieval_progress / usage_migration_progress
subagent_message_added / subagent_message_delta / subagent_message_completed
```

关键帧的 payload：

- `generation_completed`（91664-91681，原文）：
  ```js
  this.broadcastThreadSync("generation_completed", {
      threadId, model, providerId,
      usage: {
          inputTokens, outputTokens, totalTokens,
          reasoningTokens,          // outputTokenDetails.reasoningTokens
          cachedInputTokens,        // inputTokenDetails.cacheReadTokens
          cacheWriteInputTokens,
      },
      toolCallsCount, durationMs, turnEndReason,
  });
  ```
- `generation_error`（91934）：`{threadId, model, error}`。
- `thread_generating`：`{id, isGenerating, model}`，生成开始/结束各发一次。
- `generating_snapshot`：`{ids: [threadId...]}`——连接/重连时服务端主动告知「哪些线程正在生成」，断线重连对齐用（85370-85377）。

### 2.4 流式核心：`message_delta` 自研 part-diff 协议【与旧版最大差异】

v0.0.990 **不再**把 AI SDK 的 UIMessageChunk 原样转发。服务端对每个 in-flight assistant 消息维护 parts 快照，逐 chunk 计算 diff（`CM.computeDeltas`，73155-73284），统一封装为：

```json
{
  "type": "message_delta",
  "data": {
    "messageId": "<uiMessageId>",
    "threadId": "...",
    "deltas": [ /* 1..N 个 delta */ ]
  }
}
```

每个 delta 带**每消息递增的 `seq`**（`s.lastSeq++`，73167-73173），客户端可按 seq 检测丢帧。

delta 类型共 **7 种**，其应用逻辑 `applyDeltaToPartsArray`（84142-84189）就是前端 reducer 的规格原文：

```js
applyDeltaToPartsArray(e, t) {          // e = parts 数组, t = delta
    switch (t.type) {
        case "text_append":             // {partIndex, partType, text}
            // 仅作用于 text/reasoning part：n.text = (n.text||"") + t.text
        case "text_done":               // {partIndex}
            // part.state = "done"
        case "part_add":                // {part}
            // e.push(structuredClone(t.part))
        case "part_update":             // {partIndex(-1 时按 toolCallId 查), updates}
            // Object.assign(part, t.updates)
        case "tool_input_append":       // {partIndex, inputKey, text}
            // part.input[inputKey] += t.text  （仅限 tool-* part）
        case "tool_output_set":         // {partIndex, output, state, errorText?}
            // part.output/state/errorText 落定
        case "tool_output_streaming":   // {partIndex, toolCallId, stream}（Bash 输出流式镜像）
    }
}
```

| delta.type | 字段 | 语义 |
|---|---|---|
| `part_add` | `{part}` | 追加新 part |
| `text_append` | `{partIndex, partType, text}` | text/reasoning 追加文本（等价旧版 text-delta/reasoning-delta） |
| `text_done` | `{partIndex}` | part state → `done` |
| `part_update` | `{partIndex, updates}`（partIndex=-1 时按 toolCallId 查） | 任意字段合并 |
| `tool_input_append` | `{partIndex, inputKey, text}` | 工具入参字符串流式追加 |
| `tool_output_set` | `{partIndex, output, state, errorText?, parentToolCallId?, asyncAgentLaunched?}` | 工具结果落定 |
| `tool_output_streaming` | `{partIndex, toolCallId, stream}` | Bash 等长输出的流式镜像 |

子 agent 的流走独立三帧：`subagent_message_added / subagent_message_delta / subagent_message_completed`，与主消息同构。

### 2.5 背压控制（可直接照抄）

`canSendTo(e, t, n)`（85191-85210，原文逻辑）：

- `bufferedAmount <= 1 MB`：放行；
- `> 16 MB`：直接 `terminate()` 该客户端（宁可断连不让写 buffer 继续膨胀）；
- 1–16 MB：对「可丢弃帧」黑名单丢帧——黑名单原文（72205-72212）：

```js
nM = new Set([
    "generating_snapshot", "thread_generating", "message_streaming",
    "thread_messages_sync", "file_tree_sync", "terminal_output",
]);
```

这些帧都是「下一份快照会覆盖前一份」的类型，丢了无害；`message_delta` 等增量帧**不在**黑名单（丢一帧 parts 就永久错乱）。

### 2.6 与旧版 03 篇 §3 协议的对照差异

| 维度 | 旧版 03 §3（v0.0.960 口径） | v0.0.990 实证 |
|---|---|---|
| 上行发消息 | `{type:"message", parts:[{type:"input_text",...}]}` | `{type:"generate_response", data:{threadId, userMessage, ...}}`（85384-85403） |
| 上行编辑/重试 | `{type:"edit"}` | 同一 `generate_response`，靠 `retryOfMessageId` / `replaceMessageId` 区分 |
| 生成中插话 | 无 | `steer_generation`（85416-85423） |
| 下行流式 | AI SDK chunk 原样转发：`text-delta` / `reasoning-delta` / `tool-input-start/delta/end` / `tool-call` / `tool-result` / `finish` / `error` | 单一 `message_delta` 帧 + 7 种 part diff（§2.4），带 per-message `seq` |
| 完成信号 | `finish` / `done` | `generation_completed`（含 usage/toolCallsCount/durationMs/turnEndReason） |
| 中断信号 | — | `generation_error`；abort 时工具 part 被置 `output-error "Generation stopped"` |
| 重连对齐 | （旧版仅推测 `message_added`） | 连接即发 `generating_snapshot {ids}`（85370） |
| AI SDK chunk 类型还在不在 | 主链路 | 仍在 bundle（13963-14243、15681-16155），但属于 **ACP provider** 与 OpenAI 兼容端点 `/api/chat/completions` 的协议，不是 WS 主链路 |

---

## 3. 复刻提示：优先级排序

497 条路由不需要全做。按「复刻一个可用的 Alma」排序：

**P0 — 核心面（没有就不是 Alma，约 60 条）**：

1. `/ws/threads` 双向协议（§2.2-2.4）：上行 3 种帧、下行 `message_delta` + 7 种 diff、`generation_completed/error`、`generating_snapshot`。这是整个产品的心脏，照抄 `applyDeltaToPartsArray` 当前端 reducer 即可。
2. `/api/threads` CRUD + messages + `/api/messages/:id/switch-version`（版本树三件套 `parent_id/slot_id/depth`）。
3. `/api/providers` 13 条 + `GET /api/models` + `/api/settings` GET/PUT。
4. `/api/health`。
5. 背压控制（§2.5）和启动清扫（`resetStuckGenerations`，93943）——便宜且正确性攸关。

**P1 — agent 工作台面（让 agent 能干活，约 120 条）**：

6. `/api/workspaces`：文件 CRUD + preview 先做，git 30 条里先做 status/diff/commit/log/branches（generate-commit-message 和 resolve-ai 是薄 LLM 封装，最后补）。
7. `/api/terminal` 6 条 + `/ws/terminal/<id>`。
8. `/api/skills`、`/api/mcp-servers` + `/api/mcp-client`、`/api/tools` + `/api/agents`。
9. `/api/attachments`、`/api/files-abs*`、`/api/search/threads`。
10. `/ws/workspace/<id>`、`/ws/preview/<id>`（文件树推送体验提升明显）。

**P2 — 记忆与自动化（差异化能力，约 80 条）**：

11. `/api/memories` 全套（含 sleep）+ `/api/local-embeddings`。
12. `/api/cron`、`/api/plan` + `/api/plan-mode`（Plan Weave）、`/api/prompt-apps` + `/api/prompts`。
13. `/api/refs` 21 条——双链图谱是 v0.0.990 的标志性新能力，但可以先只做 `kinds/search/resolve` 三个就够用。
14. `/api/usage`、`/api/threads/:id/goal|loop`、`/api/hooks`。

**P3 — 平台集成与系统自动化（按目标用户取舍，约 150 条）**：

15. `/api/computer-use`（macOS AX，工作量大）、`/api/iab`、`/api/chrome-relay`（三选一做即可，iab 最自洽）。
16. IM 渠道：`/api/chat/completions`（OpenAI 兼容端点值得早做，外部工具都能接）→ telegram（groups/chat 两组）→ discord/feishu/weixin 按需。
17. `/api/activity-recorder`、`/api/mobile-relay`、`/api/cloud-sync`、`/api/tts`、`/api/whisper`、`/api/image` + `/api/gallery`。

**P4 — 尾巴（可以永远不做，约 40 条）**：

18. `/api/gallery`（如果 P3 没做 image）、`/api/rtk/stats`、`/api/ptc/stats`、`/api/window-capture`、`/api/system/fonts`、`/api/pip`、`/api/worktrunk`、`/api/custom-themes` + `/api/plugin-themes`、`/api/test-workspace-route`、`/api/bun`、`/api/plugins`（插件系统在你有自己的插件生态前都是空转）、`/api/update`（electron-updater 直接用库就行，不必抄路由形状）。

---

## 附录：证据文件

| 文件 | 内容 |
|---|---|
| `/tmp/alma-extract/routes-all.txt` | 497 条路由原文（方法+路径，按 70 组排好） |
| `/tmp/alma-extract/main.readable.js` | bundle 全文，行号引用源（107,803 行） |
| `~/.config/alma/api-spec.md` | 官方 API 文档（启动时重新生成，93841-93856；只覆盖核心子集，以 bundle 为准） |
| WS 分发器 | 85358-85698（整段可读，未经压缩混淆的 if-else 链） |
| part-diff 协议 | `computeDeltas` 73155-73284；`applyDeltaToPartsArray` 84142-84189 |
