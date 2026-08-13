# 09 · 扩展槽位宿主：从「Alma 的 plugin 雏形」到「WeaveLynx 式槽位系统」

> 本篇是交叉评审补的 ➕ 盲区之一，也是「有点像 WeaveLynx」的判据。
> 证据来源：WeaveLynx 的 `ext-workbench:weavelynx-extension-dev` skill 描述（实证特征词：`manifest` / `exposes.json` / `chatComposer` / `chatSidebar` / `chatHeader` / `appSidebar` / `agentPlugin` / `EH 后端 API` / `webview SDK` / `前后端通信` / `构建与调试`）；Alma 侧的 `plugins` / `plugin_permissions` 表 + preload 的 `pluginCommands/pluginConfirmDialog/pluginInputBox/pluginNotification/pluginQuickPick/pluginStatusBar/pluginTheme` namespace（实证）。
> 标注规则：【实证-WeaveLynx】= skill 描述写明的特征；【实证-Alma】= bundle/schema/preload 命中；【设计】= 基于 VS Code 扩展模型 + Claude Code plugin 体系 + 上述证据的合理推断。

---

## 0. 开篇：为什么 Alma 的 plugin 不够

Alma 有插件系统（`plugins` 表 + `plugin_permissions` 表 + `/api/plugins/:id/enable|disable|permissions|settings` 路由 + preload 的 `plugin*` UI 原语）【实证-Alma】，但它停留在「能开关、能存配置、能给 agent 一组工具」的雏形。它**没有**回答两个平台级问题：

1. **第三方往哪里挂 UI？** Alma 的 plugin UI 是笼统的「插件 UI 原语」，没有定义「输入框右侧」「侧栏」「顶栏」这种**具名槽位**。结果：每个插件要改 UI 就得改宿主代码，扩展性归零。
2. **第三方怎么往 agent 里加能力，而不改宿主？** Alma 的 plugin 能加工具，但 skill/mcp/subagent 的注入接缝没有统一契约——能力扩展散落在各处硬编码。

WeaveLynx 的答案是**槽位系统**：宿主只定义一组**命名槽位**（UI 槽 + 能力槽），扩展通过 `manifest` + `exposes.json` 声明「我往哪个槽位挂什么」，宿主扫描注册、按槽位渲染/注入。**新增一个扩展 = 写一个包，不改宿主一行代码**——这就是平台和套壳的分水岭【实证-WeaveLynx：槽位 + manifest + exposes.json 是其扩展体系的核心特征】。

> 一句话判据：**你的 agent 有没有「槽位」决定它是「一个 agent」还是「一个 agent 平台」**。Alma 是前者，WeaveLynx 是后者，你要后者。

---

## 1. 核心概念

```
Extension（扩展包）= 一个独立目录/npm 包
├── manifest.json      身份 + 顶层 contributes（声明有哪些能力）      【实证-WeaveLynx: manifest 字段】
├── exposes.json       详细暴露契约（槽位映射 + API 契约 + 权限申请）   【实证-WeaveLynx: exposes.json】
├── backend/           扩展后端逻辑（Node，跑在 Extension Host 进程）
│   └── index.ts       activate(ctx) —— 生命周期入口，注册命令/工具/skill
├── frontend/          扩展前端（webview UI，挂到 UI 槽位）
│   └── slots/         每个槽位一个组件入口
├── skills/            SKILL.md 包（能力槽 skill）
├── mcp.json           MCP server 声明（能力槽 mcp）
└── agents/            subagent 角色定义（能力槽 subagent）
```

| 概念 | 职责 | 证据 |
|---|---|---|
| **manifest.json** | 扩展身份（id/version/name）+ 顶层能力声明（contributes: 用了哪些槽位） | 【实证-WeaveLynx】 |
| **exposes.json** | 详细契约：每个槽位挂什么组件/声明、对外暴露的 API、申请的权限 | 【实证-WeaveLynx】 |
| **槽位 (slot)** | 宿主预留的命名注入点（UI 槽 + 能力槽），扩展往里挂东西 | 【实证-WeaveLynx】 |
| **Extension Host (EH)** | 扫描/加载/隔离扩展、维护注册表、暴露宿主 API、桥接前后端通信 | 【实证-WeaveLynx: EH 后端 API】 |
| **webview SDK** | 扩展前端（webview）与宿主通信的封装，含 UI 原语 | 【实证-WeaveLynx: webview SDK + 前后端通信】 |
| **agentPlugin** | 能力槽的统称：把扩展的 skill/mcp/subagent/tool/command/template 注入 agent | 【实证-WeaveLynx: agentPlugin 注册 skill/mcp/subagent】 |

---

## 2. 槽位清单

### 2.1 UI 槽（前端注入点）【实证-WeaveLynx：四个槽位名均出自 skill 描述】

| 槽位 | 位置 | 典型用途 | 渲染形态 |
|---|---|---|---|
| `chatComposer` | 聊天输入框区域 | 发送按钮旁的动作按钮、附件上传、prefill 注入、快捷提示词 | 内联组件，多个扩展按 order 叠加 |
| `chatSidebar` | 聊天右侧/侧栏面板 | 上下文预览、文件引用、工具结果专项视图、引用管理 | 面板，同一时刻可多 tab |
| `chatHeader` | 聊天顶栏 | 模型选择、线程操作、扩展自定义状态/操作按钮 | 内联组件 |
| `appSidebar` | 应用级左侧栏 | 导航、项目列表、扩展入口、自定义树视图 | 树/列表，多扩展分区 |

**注入契约**：扩展在 `exposes.json` 声明 `{ slot: "appSidebar", entry: "./frontend/slots/app-sidebar.tsx", order: 10 }`，宿主 EH 加载后把 entry 的 webview 挂到该槽位的容器里，多个扩展按 `order` 排序【设计：order 字段是 VS Code viewContainers 的通行做法】。

### 2.2 能力槽（agentPlugin，后端注入点）【实证-WeaveLynx】

| 能力槽 | 注入到 agent 的哪里 | 对接 Alma 文档的接缝 |
|---|---|---|
| `skill` | system prompt 的 `<available_skills>` 列表 + Skill 工具按需读全文 | 04 §6.1 prompt 组装 + 04 §4.1 三级渐进披露 |
| `mcp` | `mcp__<server>__<tool>` 动态工具 | 04 §7 `loadMcpTools(db)`（清单见 §2.2） |
| `subagent` | crew 注册表 `AGENT_REGISTRY` | 04 §3.2 概念 + §7 `AGENT_REGISTRY`；08 §3.3 `crewRegistry`（同义异名） |
| `tool` | `tools` 对象 | 04 §7 `loadPluginTools(db)`（清单见 §2.2） |
| `command` | 命令面板 / 快捷键 / chatComposer 按钮 | （Alma 未展开，新增） |
| `template` | prompt-app / 快捷提示词 | 03 `/api/prompt-apps`、`/api/prompts` |

> **关键接缝**：能力槽不是新造一套，而是给 04 §7 的 `runAgent` 里既有的注入点（`loadMcpTools` / `loadPluginTools` / `listSkillMetadata` / `AGENT_REGISTRY`）统一一个「来自扩展」的来源。S6 落地时，把这些函数的实现从「直接读 DB/文件」改成「查 EH 注册表」即可。

---

## 3. manifest.json + exposes.json 契约

### 3.1 分工【设计，基于 VS Code package.json/contributes 模型】

- **manifest.json** = 身份 + 顶层 contributes 清单。静态、可被宿主在不执行扩展代码的情况下扫描（决定是否启用、依赖是否满足）。类似 VS Code `package.json` 的 `contributes`。
- **exposes.json** = 详细暴露契约。每个槽位具体挂什么、扩展后端 `activate` 对外暴露哪些可调用 API、申请哪些权限。是扩展与宿主/其他扩展的「接口契约」。

分两个文件的原因【设计】：manifest 要轻、要能快速扫描过滤；exposes 是重契约，只在扩展激活或被其他扩展依赖时解析。两者也可合并，但分开更贴合 WeaveLynx 的实证特征词。

### 3.2 manifest.json schema + 示例

```jsonc
// my-extension/manifest.json
{
  "id": "com.example.git-panel",          // 全局唯一，反域命名
  "name": "Git 审阅面板",
  "version": "0.1.0",
  "main": "./backend/index.js",           // activate 入口（cjs/esm 由构建决定）
  "engines": { "myagent": "^0.1.0" },     // 宿主版本约束，不满足则拒绝加载
  "contributes": {                         // 顶层能力声明（只列用了哪些槽位）
    "slots": ["appSidebar", "chatComposer"],
    "agentPlugin": {
      "skills":    ["skills/*.md"],
      "tools":     true,                   // activate 里动态注册
      "commands":  ["git.diff", "git.commit", "git.push"]
    }
  }
}
```

### 3.3 exposes.json schema + 示例

```jsonc
// my-extension/exposes.json
{
  "ui": [
    {
      "slot": "appSidebar",
      "entry": "./frontend/slots/app-sidebar.js",  // 构建产物入口
      "label": "Git",
      "order": 20,
      "icon": "./assets/git.svg"
    },
    {
      "slot": "chatComposer",
      "entry": "./frontend/slots/commit-button.js",
      "order": 5
    }
  ],
  "api": {                                  // 扩展后端 activate 暴露给前端/其他扩展的可调用方法
    "getDiff":   { "params": ["workspaceId"], "returns": "Diff" },
    "commit":    { "params": ["workspaceId", "message"], "returns": "CommitResult" }
  },
  "permissions": [                          // 安装时审批，运行时校验【对照 Alma plugin_permissions】
    { "type": "fs",     "scope": "workspace" },
    { "type": "exec",   "scope": "git" },   // 只允许 git 子进程
    { "type": "network", "scope": "gitlab.internal" }
  ],
  "commands": [                             // 命令面板注册
    { "id": "git.diff",   "title": "Git: 查看 Diff" },
    { "id": "git.commit", "title": "Git: 提交" },
    { "id": "git.push",   "title": "Git: 推送" }
  ]
}
```

### 3.4 校验：zod schema（宿主侧加载时强校验）【设计】

```ts
// eh/schema.ts
import { z } from 'zod';

const SlotName = z.enum(['chatComposer', 'chatSidebar', 'chatHeader', 'appSidebar']);

export const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9.-]+$/),
  name: z.string(),
  version: z.string(),
  main: z.string(),
  engines: z.object({ myagent: z.string() }),
  contributes: z.object({
    slots: z.array(SlotName).default([]),
    agentPlugin: z.object({
      skills:   z.array(z.string()).default([]),
      mcp:      z.array(z.string()).default([]),
      subagents: z.array(z.string()).default([]),
      tools:    z.boolean().default(false),
      commands: z.array(z.string()).default([]),
      templates: z.array(z.string()).default([]),
    }).default({}),
  }),
});

export const ExposesSchema = z.object({
  ui: z.array(z.object({
    slot: SlotName,
    entry: z.string(),
    label: z.string().optional(),
    order: z.number().default(100),
    icon: z.string().optional(),
  })).default([]),
  api: z.record(z.string(), z.object({
    params: z.array(z.string()).default([]),
    returns: z.string().optional(),
  })).default({}),
  permissions: z.array(z.object({
    type: z.enum(['fs', 'exec', 'network', 'clipboard', 'mcp']),
    scope: z.string(),
  })).default([]),
  commands: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
});
```

> **坑**：manifest/exposes 必须在**不执行扩展代码**的前提下校验通过才允许激活——这是安全边界（恶意扩展不能在校验阶段就跑代码）。zod 校验是纯数据解析，满足此要求。

---

## 4. Extension Host 架构

### 4.1 进程模型【设计，基于 VS Code extension host】

```
宿主主进程
  ├── Extension Host（独立 Node 子进程 或 主进程内隔离模块）
  │     ├── Loader         扫描 extensions/ → 校验 manifest → 注册表
  │     ├── Activator      按需 activate(ctx) → 缓存激活实例
  │     ├── Registry       槽位→扩展组件 / 能力→扩展 的不可变映射
  │     ├── PermissionGuard 运行时权限校验（fs/exec/network）
  │     └── RpcBridge      扩展后端 ↔ 宿主 ↔ 扩展前端(webview)
  │
  ├── 槽位渲染器（renderer 侧）
  │     └── 每个 UI 槽位 = 一个容器，按 Registry 的 order 挂载扩展 webview
  │
  └── agent loop（04 runAgent）
        └── 注入点读 Registry 而非直接读 DB/文件
```

**MVP 取舍**：EH 不必一开始就独立进程。S6 先做「主进程内隔离模块」（一个 `ExtensionHost` 类 + 注册表），跑通后再视稳定性拆进程（独立进程的好处是扩展崩溃不拖垮宿主，代价是 IPC 复杂度）【设计】。

### 4.2 生命周期

```
install(扩展包) → 落 extensions/<id>/ → 写 plugins 表（enabled=0）
enable(id)      → 校验 manifest → 写 plugin_permissions（用户审批）→ enabled=1
宿主启动        → Loader 扫描 enabled=1 的扩展 → 校验 → 注册表预填（不激活）
首次用到某槽位/能力 → Activator 调 activate(ctx) → 懒激活，缓存
disable/uninstall → deactivate() → 从注册表摘除 → 卸载 webview
```

**懒激活**是关键【设计，VS Code activation events】：扩展声明了能力不代表启动就跑 `activate`，只有「用户点了它的槽位」或「agent 要用它的 skill/tool」时才激活。否则 20 个扩展全启动 = 启动慢 5 秒。

### 4.3 注册表（不可变）【设计，遵循 immutability 规则】

```ts
// eh/registry.ts
export interface SlotEntry {
  extensionId: string;
  slot: SlotName;
  entry: string;      // webview 入口 URL
  label?: string;
  order: number;
  icon?: string;
}
export interface CapabilityEntry {
  extensionId: string;
  kind: 'skill' | 'mcp' | 'subagent' | 'tool' | 'command' | 'template';
  id: string;         // skill 名 / mcp server / subagent type / command id …
  payload: unknown;   // 各 kind 的具体载荷
}

// 注册表是不可变的：每次变更返回新实例，槽位渲染器靠引用相等决定是否重渲
export class Registry {
  private constructor(
    private readonly slots: ReadonlyMap<SlotName, readonly SlotEntry[]>,
    private readonly caps: ReadonlyMap<string, readonly CapabilityEntry[]>,
  ) {}
  static empty(): Registry { return new Registry(new Map(), new Map()); }
  withSlot(e: SlotEntry): Registry { /* 返回新 Registry，slots 追加 e */ }
  withCapability(c: CapabilityEntry): Registry { /* 同上 */ }
  slot(name: SlotName): readonly SlotEntry[] { return this.slots.get(name) ?? []; }
  capabilities(kind: CapabilityEntry['kind']): readonly CapabilityEntry[] { /* ... */ }
}
```

### 4.4 ExtensionContext（宿主暴露给扩展的 API）【设计】

```ts
// eh/context.ts —— activate(ctx) 的 ctx
export interface ExtensionContext {
  id: string;
  // 扩展自己的数据目录（隔离，不串）
  storagePath: string;
  // 注册能力（activate 里调）
  registerTool(name: string, tool: Tool): void;
  registerCommand(id: string, handler: (args: unknown) => Promise<unknown>): void;
  registerSubagent(type: string, def: { system: string; delegates: string[] }): void;
  // 读宿主上下文
  workspace: { id: string; path: string } | null;
  thread: { id: string } | null;
  // 宿主 UI 原语（桥到 renderer，见 §5）
  ui: HostUi;  // toast / dialog / quickPick / statusBar
  // 事件总线
  on(event: string, cb: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
  // 日志（进 EH 日志面板，不污染宿主控制台）
  log: (msg: string, ...args: unknown[]) => void;
}
```

---

## 5. webview SDK：扩展前端怎么和宿主说话

### 5.1 证据闭环：Alma 的 plugin* namespace 就是 UI 原语

Alma preload 已暴露 `pluginCommands / pluginConfirmDialog / pluginInputBox / pluginNotification / pluginQuickPick / pluginStatusBar / pluginTheme`【实证-Alma】——**这正好是 webview SDK 的 UI 原语集**。WeaveLynx 的「webview SDK + 前后端通信」对应的就是把这套原语规范化、绑到槽位上下文里【实证-WeaveLynx】。差距只在：Alma 把它们当零散 IPC，没绑成「扩展前端 SDK」。

### 5.2 通信拓扑【设计】

```
扩展前端 (webview, BrowserView/iframe, 无 Node)
    │  window.host.*  (SDK 封装)
    │  ↕ postMessage（同源隔离通道）
扩展 preload bridge（EH 注入的受限 preload）
    │  ↕ ipcRenderer.invoke / EH RpcBridge
扩展后端 (activate 实例，跑在 EH)
    │  ↕ ctx.ui / ctx.emit / ctx.registerTool
宿主主进程 / agent loop / renderer 槽位容器
```

### 5.3 webview SDK 最小 API【设计，命名对齐 Alma plugin* 实证】

```ts
// 扩展前端通过 <script> 注入的 host 对象（EH preload bridge 暴露）
window.host = {
  // 读宿主上下文（槽位渲染时注入）
  context: { extensionId, workspaceId, threadId, slot } as const,

  // 调本扩展后端 activate 暴露的 api（exposes.api）—— 走 RpcBridge 到后端
  invoke: <T>(method: string, ...args: unknown[]): Promise<T>,

  // 宿主 UI 原语【对照 Alma pluginConfirmDialog/pluginInputBox/pluginQuickPick/pluginNotification/pluginStatusBar】
  ui: {
    toast(msg: string, level?: 'info'|'warn'|'error'): Promise<void>,
    confirm(opts: { title: string; message: string }): Promise<boolean>,
    input(opts: { title: string; placeholder?: string }): Promise<string | null>,
    quickPick(items: { label: string; value: string }[]): Promise<string | null>,
    statusBar(text: string): void,
  },

  // 事件总线（与后端 ctx.on/emit 对偶）
  on: (event: string, cb: (payload: unknown) => void): (() => void),
  emit: (event: string, payload: unknown): void,
};
```

### 5.4 preload bridge 骨架【设计】

```ts
// eh/preload.ts —— 注入到每个扩展 webview 的受限 preload
import { contextBridge, ipcRenderer } from 'electron';

// 渲染扩展 webview 时，通过 URL query 注入槽位上下文（不可信 → 必须校验）
const ctx = parseSlotContext(new URL(location.href).searchParams);

contextBridge.exposeInMainWorld('host', {
  context: ctx,
  invoke: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke('ext:invoke', ctx.extensionId, method, args) as Promise<unknown>,
  ui: {
    toast: (msg: string, level = 'info') =>
      ipcRenderer.invoke('ext:ui:toast', ctx.extensionId, { msg, level }),
    confirm: (opts) => ipcRenderer.invoke('ext:ui:confirm', ctx.extensionId, opts),
    // ...input / quickPick / statusBar 同理
  },
  on: (event: string, cb: (payload: unknown) => void) => {
    const channel = `ext:event:${ctx.extensionId}:${event}`;
    const listener = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);  // 防泄漏
  },
  emit: (event: string, payload: unknown) =>
    ipcRenderer.send('ext:event:emit', ctx.extensionId, event, payload),
});
```

> **坑**：① webview 必须开 `contextIsolation`、关 `nodeIntegration`，与 Alma renderer 零特权模型一致（02 §7）；② 槽位上下文从 URL query 来 = 不可信，必须校验 `extensionId` 在注册表且该扩展启用了该槽位，否则任意 webview 能伪装成别的扩展；③ `on` 必须返回取消函数，否则扩展面板反复挂载会累积监听器。

---

## 6. agentPlugin：能力槽怎么注入 agent loop

这是 S6 和 04 `runAgent` 的接缝。把 04 里直接读 DB/文件的那几个注入点，改成查 EH Registry：

```ts
// agent/plugin-loader.ts —— 替换 04 的 loadMcpTools / loadPluginTools / listSkillMetadata
function loadPluginCapabilities(registry: Registry, db: Database) {
  // 1. skill：聚合内置 + 所有扩展的 skill 元数据，供 <available_skills> 注入
  const skills = [
    ...listBuiltinSkillMetadata(db),
    ...registry.capabilities('skill').map(c => ({ name: c.id, description: (c.payload as any).description })),
  ];

  // 2. tool：扩展在 activate 里 registerTool 的，注册表持有
  const tools = Object.fromEntries(
    registry.capabilities('tool').map(c => [c.id, (c.payload as Tool)]),
  );

  // 3. subagent：扩展注册的角色并入 crew 注册表
  for (const c of registry.capabilities('subagent')) {
    AGENT_REGISTRY[c.id] = c.payload as { system: string; delegates: string[] };
  }

  // 4. mcp：扩展声明的 mcp server 并入 loadMcpTools 的来源
  const mcpServers = [
    ...loadMcpFromDb(db),
    ...registry.capabilities('mcp').map(c => c.payload as McpServerConfig),
  ];

  return { skills, tools, mcpServers };
}
```

```ts
// 在 04 的 runAgent 里：
const { skills, tools: pluginTools, mcpServers } = loadPluginCapabilities(registry, db);
const tools = {
  ...builtinTools,
  Task: taskTool({ ... }),
  ...pluginTools,                 // ← 扩展工具
  ...await loadMcpTools(mcpServers),  // ← 内置 + 扩展 MCP
};
const systemPrompt = assembleSystemPrompt({
  ..., skills,                   // ← 内置 + 扩展 skill 元数据
});
```

> **设计要点**：agent loop 本身一行不用改，只改「注入点的数据来源」。这和 08 §5.2「主循环只提供原语、策略交给 skill 层」是同一个精神——**主循环不认识「扩展」这个概念，它只认识 registry 这个数据源**。

---

## 7. 构建 / 调试 / dev 流程【设计，对照 ext-workbench: 构建/调试特征】

| 环节 | 做法 |
|---|---|
| 扩展构建 | 扩展是独立 npm 包，`frontend/` 用 vite 打成单 bundle（挂 webview），`backend/` 打成 cjs/esm（EH require） |
| 宿主 dev 模式 | 监听 `extensions/` 目录变更 → 重新校验 + 热重载注册表；webview 走 vite dev server HMR |
| 调试入口 | 宿主提供「扩展开发模式」：指定一个扩展目录以 dev 方式加载（不打包），日志面板 + 槽位检查器 |
| 权限审批 | dev 模式下权限默认全开 + 标红警告；生产模式安装时弹审批对话框（复用 `confirm` 原语） |

**最小 dev 环路**（S6 验收要跑通的）：改扩展前端代码 → webview HMR → 看到槽位组件变化；改扩展后端 → EH 重激活 → agent 能调到新注册的工具。

---

## 8. 数据库支撑（对照 Alma 实证）

Alma 已有 `plugins` + `plugin_permissions` 表【实证-Alma】，直接复用并补字段：

```sql
-- plugins：扩展启用状态与配置【实证-Alma 已有】
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,           -- = manifest.id
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL,            -- extensions/<id>/ 绝对路径
  enabled INTEGER DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',  -- 扩展自定义配置
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- plugin_permissions：用户审批过的权限【实证-Alma 已有】
CREATE TABLE plugin_permissions (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  type TEXT NOT NULL,            -- fs/exec/network/clipboard/mcp
  scope TEXT NOT NULL,
  granted INTEGER DEFAULT 0,     -- 0=待审批 1=已授予 -1=已拒绝
  granted_at TEXT,
  PRIMARY KEY (plugin_id, type, scope)
);
```

REST 路由（对照 Alma `/api/plugins` 实证 + 补槽位查询）：

```
GET    /api/plugins                      列出所有扩展（含 enabled 状态）
POST   /api/plugins/install              安装（传路径/包）
POST   /api/plugins/:id/enable|disable   启用/禁用（enable 触发权限审批）
GET    /api/plugins/:id/permissions      查权限审批状态
POST   /api/plugins/:id/permissions/grant  审批
GET    /api/plugins/:id/slots            查该扩展占用的槽位（供槽位检查器）
GET    /api/slots                        全局槽位→扩展映射（renderer 渲染侧栏用）
```

---

## 9. 最小可落地骨架（S6 切片）

目录布局：

```
src/
├── main/
│   ├── eh/                  # Extension Host 后端（与 10 §2 的 src/main/eh/ 一致）
│   │   ├── schema.ts          # manifest/exposes zod 校验（§3.4）
│   │   ├── loader.ts          # 扫描 + 校验 + 激活（§9.1）
│   │   ├── registry.ts        # 不可变注册表（§4.3）
│   │   ├── context.ts         # ExtensionContext（§4.4）
│   │   ├── preload.ts         # webview SDK bridge（§5.4）
│   │   └── permission.ts      # 运行时权限校验
│   └── agent/
│       └── plugin-loader.ts   # 能力槽注入 runAgent（§6）
└── renderer/
    └── slots/
        └── slot-host.tsx   # 槽位容器：按 registry 顺序挂载扩展 webview
                            # MVP 先只做通用容器，4 个具名槽位容器见 10 §5
extensions/
└── hello-ext/             # 示例扩展（§9.2）
```

### 9.1 Loader + Activator 骨架

```ts
// eh/loader.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestSchema, ExposesSchema } from './schema.js';
import { Registry } from './registry.js';
import type { ExtensionContext } from './context.js';

export interface LoadedExt {
  manifest: z.infer<typeof ManifestSchema>;
  exposes:  z.infer<typeof ExposesSchema>;
  dir: string;
  active: boolean;
  ctx?: ExtensionContext;
}

export class ExtensionHost {
  private loaded = new Map<string, LoadedExt>();
  private registry = Registry.empty();

  constructor(private extDir: string, private db: Database) {}

  /** 宿主启动时扫一遍，只校验+预填注册表，不激活。 */
  scan(): Registry {
    if (!existsSync(this.extDir)) return this.registry;
    for (const id of readdirSync(this.extDir)) {
      const dir = join(this.extDir, id);
      const mf = join(dir, 'manifest.json');
      const ex = join(dir, 'exposes.json');
      if (!existsSync(mf) || !existsSync(ex)) continue;
      try {
        const manifest = ManifestSchema.parse(JSON.parse(readFileSync(mf, 'utf8')));
        const exposes  = ExposesSchema.parse(JSON.parse(readFileSync(ex, 'utf8')));
        if (!this.isEnabled(id)) continue;            // DB 里 enabled=0 跳过
        this.loaded.set(id, { manifest, exposes, dir, active: false });
        // 预填 UI 槽位注册表（webview 入口此时不加载，渲染时才挂）
        for (const ui of exposes.ui) this.registry = this.registry.withSlot({
          extensionId: id, slot: ui.slot, entry: join(dir, ui.entry),
          label: ui.label, order: ui.order, icon: ui.icon,
        });
        // 预填静态能力（skill/mcp/subagent 声明，activate 后才补 tool/command）
        for (const s of manifest.contributes.agentPlugin.skills)
          this.registry = this.registry.withCapability(
            { extensionId: id, kind: 'skill', id: s, payload: readSkillMeta(join(dir, s)) });
      } catch (e) {
        console.warn(`[eh] skip ${id}: manifest/exposes invalid`, e);  // 坑：校验失败只跳过，不崩宿主
      }
    }
    return this.registry;
  }

  /** 懒激活：首次用到某扩展的能力/槽位时调。 */
  async activate(id: string): Promise<void> {
    const ext = this.loaded.get(id);
    if (!ext || ext.active) return;
    const mod = await import(join(ext.dir, ext.manifest.main));
    const ctx = createExtensionContext(id, this.db, this.registry);
    await mod.activate(ctx);                             // 坑：activate 抛错 → 标记 disabled，不崩
    ext.ctx = ctx; ext.active = true;
  }

  isEnabled(id: string): boolean {
    return (this.db.prepare('SELECT enabled FROM plugins WHERE id=?').get(id) as any)?.enabled === 1;
  }
}
```

### 9.2 示例扩展（hello-ext）：一个 appSidebar 槽 + 一个 skill + 一个工具

```
extensions/hello-ext/
├── manifest.json
├── exposes.json
├── backend/index.ts       # activate
├── frontend/slots/app-sidebar.tsx
└── skills/greet.md
```

```jsonc
// manifest.json
{
  "id": "hello-ext",
  "name": "Hello",
  "version": "0.1.0",
  "main": "./backend/index.js",
  "engines": { "myagent": "^0.1.0" },
  "contributes": {
    "slots": ["appSidebar"],
    "agentPlugin": { "skills": ["skills/greet.md"], "tools": true, "commands": ["hello.greet"] }
  }
}
```
```jsonc
// exposes.json
{
  "ui": [{ "slot": "appSidebar", "entry": "./frontend/slots/app-sidebar.js", "label": "Hello", "order": 100 }],
  "api": { "greet": { "params": ["name"], "returns": "string" } },
  "permissions": [],
  "commands": [{ "id": "hello.greet", "title": "Hello: 打招呼" }]
}
```
```ts
// backend/index.ts —— activate 里注册工具 + 命令
import { tool } from 'ai';
import { z } from 'zod';

export function activate(ctx) {
  ctx.registerTool('hello_greet', tool({
    description: 'Greet someone. Use when the user says hello or asks to greet.',
    parameters: z.object({ name: z.string() }),
    execute: async ({ name }) => ({ message: `Hello, ${name}!` }),
  }));
  ctx.registerCommand('hello.greet', async (args) => ({ message: `Hello, ${args?.name ?? 'world'}!` }));
  ctx.log('hello-ext activated');
}
```
```markdown
---
name: greet
description: 打招呼的规范。当用户说 hello / 打招呼 / greet 时使用。
---
# Greet Skill
打招呼时用 hello_greet 工具，语气友好。
```

### 9.3 槽位容器（renderer 侧）【设计】

```tsx
// renderer/slots/slot-host.tsx —— 以 appSidebar 为例
import { useEffect, useState } from 'react';
import { BrowserView } from 'electron';  // 或 iframe，MVP 用 iframe 更简单

export function AppSidebarSlots() {
  const [entries, setEntries] = useState<SlotEntry[]>([]);
  useEffect(() => {
    // 从 /api/slots 拉注册表快照；WS /ws/slots 推变更时 setEntries（不可变替换）
    fetch('/api/slots').then(r => r.json()).then(d => setEntries(d.appSidebar ?? []));
  }, []);
  return (
    <aside>
      {entries.map(e => (
        <SlotView key={e.extensionId} entry={e} />
      ))}
    </aside>
  );
}

function SlotView({ entry }) {
  // MVP：iframe 挂扩展 webview 产物，URL 带槽位上下文 query
  const src = `file://${entry.entry}?ext=${entry.extensionId}&slot=appSidebar&ws=${currentWorkspaceId}`;
  return <iframe src={src} title={entry.label} />;
}
```

> **坑**：iframe 跨origin 限制会挡 `postMessage`——MVP 把扩展前端产物走 `file://` 同源加载，或用 `BrowserView`（Electron 专属，更接近 VS Code webview，但 API 更重）。S6 先 iframe 跑通，S6.5 再升 BrowserView。

---

## 10. 坑汇总（按踩中概率排序）

| # | 坑 | 症状 | 对策 |
|---|---|---|---|
| 1 | manifest/exposes 在执行扩展代码前不校验 | 恶意扩展 activate 阶段就跑 | zod 纯数据校验先行，不通过不激活（§3.4） |
| 2 | 扩展前端 webview 拿到别的扩展上下文 | 越权调他扩展 API / 读他扩展数据 | 槽位上下文从 URL query 来=不可信，必须校验 extensionId+slot 在注册表（§5.4） |
| 3 | 扩展 activate 抛错拖垮宿主 | 一个坏扩展全站白屏 | activate 包 try/catch，失败标记 disabled，不影响其他扩展（§9.1） |
| 4 | 全部扩展启动即激活 | 启动慢 5 秒 | 懒激活：用到槽位/能力才 activate（§4.2） |
| 5 | webview 监听器不清理 | 面板反复挂载累积监听器，内存泄漏 | `host.on` 必须返回取消函数，卸载时调（§5.4） |
| 6 | 能力槽注入和 agent loop 耦合 | S6 改动侵入 04 runAgent | 注入点只改数据来源（registry），runAgent 一行不动（§6） |
| 7 | 扩展工具/skill 命名冲突 | 两个扩展都注册 `greet` | 命名空间：工具 `ext.<id>.<name>`，skill `<id>/<name>`，校验阶段拒重 |
| 8 | 权限校验放前端 | 前端可绕过，exec/fs 裸奔 | 权限在 EH 后端 PermissionGuard 强校验，前端只做 UI 灰显（§4.1） |

---

## 11. 验收标准（S6 切片）

S6 拆三个子切片，各自可演示：

**S6.1 静态槽位渲染**（3–4 天）
- [ ] `manifest.json`/`exposes.json` zod 校验通过/拒绝都能复现
- [ ] `hello-ext` 的 appSidebar 槽位在侧栏渲染出组件
- [ ] 扩展 enable/disable 后侧栏组件出现/消失
- [ ] 验收：装 hello-ext → 启用 → 侧栏出现 Hello 面板

**S6.2 能力注入 agent**（3–4 天）
- [ ] hello-ext 的 `greet` skill 出现在 agent system prompt 的 `<available_skills>`
- [ ] agent 被问「跟我打招呼」时调用 `hello_greet` 工具
- [ ] 验收：对话里说 hello，agent 用扩展的工具回了 Hello

**S6.3 前后端通信 + 命令**（3–4 天）
- [ ] 扩展前端 `host.invoke('greet', 'foo')` 调到后端 activate 注册的命令
- [ ] 命令面板出现 `Hello: 打招呼`
- [ ] `host.ui.toast` 能弹 toast
- [ ] 验收：点侧栏面板里的按钮 → toast 弹出 + agent 侧能看到结果

---

## 12. 与 Alma / WeaveLynx 对照

| 维度 | Alma（雏形） | WeaveLynx（平台） | 本篇 S6 目标 |
|---|---|---|---|
| UI 注入 | 笼统 plugin UI 原语 | 4 个具名 UI 槽 + 槽位系统 | 4 槽定义全做，MVP 先通 appSidebar |
| 能力注入 | plugin 能加工具（散落） | agentPlugin 统一 skill/mcp/subagent/tool/command/template | 6 类能力槽，注入点查 registry |
| 扩展契约 | 无明确 manifest | manifest + exposes.json | zod 校验的两文件契约 |
| 宿主隔离 | 插件跑主进程 | EH（推断独立/隔离） | 主进程内隔离模块，跑通后拆进程 |
| 前端通信 | preload plugin* 零散 IPC | webview SDK | SDK 封装 + 槽位上下文绑定的 preload bridge |
| 权限 | plugin_permissions 表 | 同 + 运行时强校验（推断） | 复用表 + EH PermissionGuard |

---

## 13. 在落地序列里的位置

本篇 = 落地序列 **Phase B · S6 扩展宿主 + 槽位**。依赖：
- S4（agent loop + 工具）—— 能力槽要注入 runAgent
- S5（skill 机制）—— skill 槽复用 SKILL.md 渐进披露
- S8（MCP）—— mcp 槽复用 MCP 注入（S6 可先 mock，S8 接真）

被依赖：
- S9（Git review 面板）—— 第一个「真扩展」就是它：把 Git 面板做成一个扩展，挂在 appSidebar + chatComposer，注册 git diff/commit 命令。**S6 的验收扩展可以直接就是 S9 的雏形**——这是把 S6 和 S9 合并省工的关键。

> 也就是说：**S6 别拿 hello-ext 当终点，直接把 S9 Git 面板当 S6 的验收扩展来做**——槽位系统立刻有真实负载验证，而不是玩具。
