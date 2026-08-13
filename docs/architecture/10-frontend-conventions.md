# 10 · 前端工程约束：目录 / 命名 / 复用边界

> 01 篇是对构建产物的静态考古，源码目录在 vite minify 后丢失了（01 §2.3 自述「chunk 命名不是源码目录结构」），所以源码级约束是空白。本篇补这块空白，为 Phase A 的 S1/S2 建目录时提供硬约束。
> 基线：你全局 rules 的 `common/coding-style.md`（immutability / many small files / feature-domain 组织）。本篇把它细化到「聊天 agent 前端」这个具体场景，并接上 09 槽位系统与 01 流式三红线。
> 前提：单窗简化版（01 §7 最小骨架路线，1 个 index.html，设置/画廊做路由页），非 Alma 的 8 窗 MPA。

---

## 0. 为什么需要这份约束

落地 S1（会说话的壳）就要建目录。没有约束会发生：流式组件和聊天 UI 混在一起、槽位容器塞进 features、shared 里堆业务、两处都定义同一个 message 类型……等到 S6 槽位系统接入、S7 子代理流式复用，结构已经救不回来。

本篇三条硬线：
1. **目录**：feature/domain 切分 + shared 复用层 + slots 槽位层 + 三进程边界（main/preload/renderer）
2. **命名**：组件/hook/store/api client/槽位组件各自的约定，消除「同一个东西三种叫法」
3. **复用边界**：shared vs feature 私有 vs slots vs 扩展自有前端，四层不串

---

## 1. 设计原则（接全局 rules）

| 原则 | 来源 | 在本项目的体现 |
|---|---|---|
| 不可变更新 | `common/coding-style.md` | 状态更新返回新对象；流式增量 `setCurrentThread(prev => 替换 messages[idx])` 只替换单条引用（01 §3.2 ①） |
| MANY SMALL FILES | `common/coding-style.md` | 200–400 行典型，800 上限；函数 <50 行；嵌套 ≤4 层 |
| feature/domain 组织 | `common/coding-style.md` | `features/` 按功能域切，不按类型（不出现 `components/` `hooks/` 顶层分类目录） |
| 显式错误处理 | `common/coding-style.md` | WS 连接、fetch、accumulator 全包 try/catch；hook 失败降级不静默吞（见 05 §9.5 降级哲学） |

---

## 2. 目录结构总览

```
src/
├── main/                         # ① 主进程（Node）—— 见 02/03
│   ├── index.ts                  #    启动序列（02 §9.2）
│   ├── server.ts                 #    内嵌 Express（03 §9.5）
│   ├── windows.ts                #    窗口工厂（02 §9.3）
│   ├── eh/                       #    Extension Host 后端（09 §9.1）
│   └── agent/                    #    agent loop（04 §7）+ 能力槽注入（09 §6）
│
├── preload/                      # ② preload bridge（02 §9.4）
│   └── index.ts                  #    contextBridge 暴露 apiServer/windowControls/...
│                                 #    注意：sandbox:true 下只能单文件，不拆 chunk
│
└── renderer/                     # ③ 渲染进程（React，纯 Web，无 Node）—— 本篇主场
    ├── main.tsx                  #    createRoot + HashRouter + Provider 组合
    ├── index.html                #    唯一入口（01 §7）
    │
    ├── app/                      # 应用骨架：路由 + 布局 + Provider
    │   ├── routes.tsx            #    路由表（/ /chat/:id /settings /gallery）
    │   ├── layouts/              #    布局壳（主布局 = appSidebar + 聊天区 + chatSidebar）
    │   │   └── main-layout.tsx
    │   └── providers/            #    顶层 Provider（Theme/SWR/Toast）
    │
    ├── features/                 # ★ 按功能域切分（§3）
    │   ├── threads/              #    聊天会话（S1/S2 主场）
    │   ├── workspace/            #    项目工作区（S3）
    │   ├── skills/               #    skill 管理 UI（S5）
    │   ├── extension-host/       #    扩展管理 UI（S6）：启用/禁用/权限审批面板
    │   └── settings/             #    设置中心
    │
    ├── slots/                    # ★ 槽位系统容器（§5，接 09）：host 扩展 webview 的挂载点
    │   ├── slot-host.tsx         #    通用槽位容器
    │   ├── app-sidebar-slots.tsx
    │   ├── chat-composer-slots.tsx
    │   ├── chat-header-slots.tsx
    │   └── chat-sidebar-slots.tsx
    │
    ├── shared/                   # ★ 跨 feature 复用层（§4）
    │   ├── streaming/            #    流式三红线（§6，接 01）
    │   ├── markdown/             #    Streamdown + Shiki + KaTeX + mermaid
    │   ├── api/                  #    HTTP client + WS client
    │   ├── ui/                   #    通用 UI 原语（Button/Dialog/Input，非业务）
    │   ├── state/                #    跨域 Context/atom（如有，克制使用）
    │   └── types/                #    跨域类型契约（UIMessage、Thread、SlotEntry...）
    │
    └── lib/                      # 无 React 依赖的纯工具（格式化/路径/校验）
```

**三个边界**（硬线，不允许跨）：
1. **main / preload / renderer 三进程不混**：renderer 不 import 任何 `node:` 模块或 main 代码；preload 只暴露窄接口（02 §6「42 namespace 压缩为窄接口」）。
2. **renderer 不直连 DB/文件系统**：一切数据走 `shared/api/`（HTTP+WS），与 Alma「renderer 零特权」一致（02 §7）。
3. **扩展前端不进 renderer/**：扩展自己的 UI 代码在 `extensions/<id>/frontend/`（09 §9.2），renderer 只通过 `slots/` 挂载它们的 webview 产物。

---

## 3. features/ 切分规则

### 3.1 切分判据

一个功能域独立成 `features/<name>/`，当且仅当它有**自己的路由 + 自己的数据模型 + 自己的主交互**。三者缺一则降级为 `shared/ui` 组件或子目录。

| feature | 路由 | 数据模型 | 主交互 | 切片 |
|---|---|---|---|---|
| `threads` | `/chat/:id` | Thread/Message/UIMessage | 流式对话 | S1/S2 |
| `workspace` | `/workspace/:id` | Workspace | 项目导入/文件树 | S3 |
| `skills` | `/settings/skills` | Skill | 启用/查看 SKILL.md | S5 |
| `extension-host` | `/settings/extensions` | Plugin/Permission | 启用/审批/槽位检查 | S6 |
| `settings` | `/settings` | AppSettings | 配置编辑 | S1 |

### 3.2 单个 feature 内部结构（统一模板）

```
features/threads/
├── index.ts                 # barrel：只导出该 feature 对外的组件/类型（§4.3）
├── components/              # 该 feature 私有组件（不导出给其他 feature）
│   ├── thread-list.tsx
│   ├── message-list.tsx
│   └── composer.tsx
├── hooks/                   # 该 feature 私有 hook
│   └── use-thread.ts
├── api.ts                   # 该 feature 的 HTTP 调用（走 shared/api client）
├── types.ts                 # 该 feature 私有类型
└── store.ts                 # 该 feature 局部状态（useState/Context，克制用 atom）
```

**规则**：
- `components/` 内的组件**默认不导出 feature 外**；对外只通过 `index.ts` 显式 barrel。
- 一个 feature **不允许 import 另一个 feature 的内部文件**（只能 import 对方 `index.ts`）。这条由 ESLint `no-restricted-imports` 强制（§9）。
- feature 内部允许 import `shared/` 和 `slots/`（槽位容器是 host 代码，可被 feature 消费——见 §5.2）。

### 3.3 什么时候拆新 feature

```
新需求有自己的路由吗？
├─ 否 → 它是某 feature 的组件，进 features/<f>/components/
└─ 是 → 它有自己的数据模型吗？
        ├─ 否 → 进 shared/ui（通用能力，如「图片预览」）
        └─ 是 → 新建 features/<name>/，遵循 §3.2 模板
```

---

## 4. shared/ 复用层规则

### 4.1 什么进 shared/

**硬判据**：被 **2 个及以上 feature** 复用，**或**被 `slots/` / 扩展前端复用。只被一个 feature 用的，留该 feature 内部。

| 子目录 | 内容 | 复用方 |
|---|---|---|
| `shared/streaming/` | 流式三红线（§6） | threads + 子代理消息视图 |
| `shared/markdown/` | Markdown 渲染管线 | threads + skills 预览 + 扩展产物展示 |
| `shared/api/` | fetch 封装 + WS client + DeltaAccumulator | 所有 feature |
| `shared/ui/` | Button/Dialog/Input/VirtualList 等无业务 UI | 所有 feature + slots |
| `shared/types/` | UIMessage/Thread/SlotEntry 等跨域契约 | 所有 feature + main/agent（类型共享，实现不共享） |
| `shared/state/` | 跨域 Context（如当前 workspace/theme） | 多 feature |

### 4.2 什么不进 shared/（反模式）

- 业务组件（带「聊天」「线程」语义的）→ 留 feature
- 只被一个 feature 用的 hook → 留 feature
- 还没有被第二个地方复用的「预判性」抽象 → **先放 feature，出现第二处再提升**（YAGNI；过早抽象比重复更糟）

### 4.3 barrel 导出与类型边界

```ts
// shared/types/index.ts —— 跨域类型契约的唯一来源
export type { UIMessage, MessagePart } from './message';     // 对接 03 §4.3 UIMessage
export type { Thread, ChatThread } from './thread';
export type { SlotEntry, SlotName } from './slot';           // 对接 09 §4.3
```

**规则**：
- 跨 feature 传递的数据，类型只从 `shared/types/` import，不在 feature 间互相 import 类型。
- `shared/types/` 是**类型契约**，不放运行时逻辑；`main/agent/` 可 import 它（TS 类型擦除后无运行时耦合）。
- feature 的 `index.ts` barrel 只导出「组件 + 对外类型」，不导出内部 hook/store/api。

---

## 5. slots/ 槽位系统目录（接 09）

### 5.1 slots/ 是什么

`slots/` 是**宿主侧**的槽位容器——host 扩展 webview 产物的挂载点（09 §9.3）。它**不是**扩展代码，扩展前端在 `extensions/<id>/frontend/`。这层分离是关键：宿主改槽位布局不影响扩展，扩展换 UI 不影响宿主。

```
slots/
├── slot-host.tsx              # 通用容器：按 registry 顺序挂载扩展 webview
├── app-sidebar-slots.tsx      # 4 个具名槽位各自的聚合容器（09 §2.1）
├── chat-composer-slots.tsx
├── chat-header-slots.tsx
└── chat-sidebar-slots.tsx
```

### 5.2 谁消费谁

- `slots/` **import** `shared/api`（拉 `/api/slots` 注册表）、`shared/ui`（容器外壳）、`shared/types`（SlotEntry）。
- `slots/` **不 import** 任何 `features/`——槽位是宿主基础设施，不该耦合具体业务域。
- `features/` **import** `slots/`：布局里把 `AppSidebarSlots` 摆到侧栏位置（§2 的 `app/layouts/`）。

```tsx
// app/layouts/main-layout.tsx
  └─ <AppSidebarSlots />        ← feature threads 不直接管槽位，布局层组合
     <ChatArea>                 ← 来自 features/threads
       <ChatHeaderSlots />      ← slots
       <MessageList />          ← threads
       <ChatComposerSlots />    ← slots
     </ChatArea>
     <ChatSidebarSlots />       ← slots
```

### 5.3 槽位组件命名约定

槽位容器文件：`<slot>-slots.tsx`（复数，表示「该槽位下所有扩展的聚合」），导出组件同名（PascalCase）`AppSidebarSlots`。例：`app-sidebar-slots.tsx` → `AppSidebarSlots`。

---

## 6. 流式三红线组件归属（接 01 §7）

01 的三条复刻红线是前端最核心的资产，它们的归属直接决定目录：

| 红线 | 文件 | 归属 | 复用方 |
|---|---|---|---|
| ① seq 重组 accumulator | `shared/streaming/delta-accumulator.ts` | shared | threads + 子代理消息（08 §3.3） |
| ② rAF 字符泵 | `shared/streaming/use-smooth-stream.ts` | shared | threads + 子代理消息 |
| ③ Streamdown 分块 memo | `shared/markdown/markdown.tsx` | shared | threads + skills 预览 + 扩展产物 |

**为什么都进 shared 而非 threads**：08 §3.3 子代理消息也走流式渲染（`/api/threads/:id/subagent-messages`），如果红线埋在 `features/threads/`，子代理视图要么复制要么反向依赖 threads——两者都坏。提升到 `shared/streaming/` 是对的。

**accumulator 是纯逻辑（无 React）**，放 `shared/streaming/` 而非 `lib/`，因为它和 `useSmoothStream` 是同一流式管线的两层，强内聚，放一起。

```
shared/streaming/
├── delta-accumulator.ts     # ① 纯逻辑：seq 重组 + applyDelta（01 §3.2 ①）
├── use-smooth-stream.ts     # ② React hook：rAF 字符泵 + EMA（01 §3.2 ②）
├── ws-client.ts             # WS 连接 + 把 message_delta 喂给 accumulator
└── types.ts                 # Delta / StreamChunk 类型
```

---

## 7. 命名约定总表

**文件名一律 kebab-case（中划线）；导出标识符按语言硬性要求**：

| 类别 | 文件名 | 导出名 | 示例 | 备注 |
|---|---|---|---|---|
| React 组件 | `kebab-case.tsx` | PascalCase | `message-list.tsx` → `MessageList` | 导出必须 PascalCase（JSX 硬性，见下） |
| Hook | `use-xxx.ts` | `useXxx` | `use-smooth-stream.ts` → `useSmoothStream` | 导出必须 `use` 前缀（rules-of-hooks） |
| Store/atom | `xxx-store.ts` | `useXxxStore` | `thread-store.ts` → `useThreadStore` | **克制**：优先 useState/SWR（01 §7） |
| API client | `xxx-client.ts` | `xxxClient` | `chat-api-client.ts` → `chatApiClient` | class 单例或函数集 |
| API 调用（feature 内） | `api.ts` | — | `features/threads/api.ts` | 走 shared/api client |
| 类型 | `types.ts` | PascalCase 类型名 | `type Thread = {...}` | feature 私有；跨域进 shared/types |
| 槽位容器 | `<slot>-slots.tsx` | `<Slot>Slots` | `app-sidebar-slots.tsx` → `AppSidebarSlots` | 复数，聚合（§5.3） |
| 常量 | `constants.ts` | `UPPER_SNAKE` | `MAX_CPS = 300` | 魔数进常量（coding-style） |
| 布局 | `layouts/*.tsx` | PascalCase | `main-layout.tsx` → `MainLayout` | app 骨架 |
| 路由 | `routes.tsx` | `routes` | — | app 层 |
| 测试 | `*.test.ts(x)` | — | `delta-accumulator.test.ts` | 同目录 co-locate |

**统一约束**：
- 文件名（kebab-case）与导出名按标准映射**对齐**：`MessageList` → `message-list.tsx`，不导出别名。
- 一个文件**一个主职责**：`message-list.tsx` 不混入 `Composer`。
- barrel `index.ts` 只 re-export，**不放逻辑**。

> **为什么导出名不全用中划线**：这是语言硬约束，不是风格偏好。JSX 规定——小写标签（`<message-list>`）会被当作 DOM 元素渲染而报错，组件标识符必须 PascalCase；hook 标识符必须 `use` 前缀（rules-of-hooks linter 识别）。所以约定是**文件名中划线、标识符按语言要求**：`message-list.tsx` 导出 `MessageList`、`use-smooth-stream.ts` 导出 `useSmoothStream`。这是 Vue/Nuxt 和不少 React monorepo 的通行做法。

---

## 8. 复用边界判定流程

新写一个组件/工具时，按此决策树放位置：

```
1. 它有 React 吗？
   ├─ 否（纯逻辑/格式化/校验）→ lib/  （若领域专属且纯，可 shared/<domain>/）
   └─ 是 → 2

2. 它是「host 扩展 webview 的容器」吗？（09 §9.3）
   ├─ 是 → slots/                          ← 槽位容器，宿主基础设施
   └─ 否 → 3

3. 它被 2+ feature 复用吗？或被 slots/ 用？
   ├─ 是 → shared/ui（UI 原语）或 shared/<domain>（领域共享，如 streaming）
   └─ 否 → 4

4. 它属于某个功能域吗？（有路由/数据模型/主交互）
   ├─ 是 → features/<name>/components/     ← feature 私有，不导出 feature 外
   └─ 否 → shared/ui（通用 UI，如 EmptyState）

5. 它是扩展自己的前端代码吗？（不是宿主的）
   ├─ 是 → extensions/<id>/frontend/       ← 不进 renderer/，独立打包（09 §9.2）
```

**三条易错判定**：
- 槽位容器 ≠ 扩展前端：容器在 `slots/`（宿主），扩展 UI 在 `extensions/<id>/frontend/`。别把扩展 UI 写进 renderer。
- 流式管线 ≠ threads 私有：红线进 `shared/streaming/`，因为子代理也用。
- 跨域类型 ≠ feature 类型：`UIMessage` 这种进 `shared/types/`，`ThreadListProps` 留 `features/threads/types.ts`。

---

## 9. 强制手段（ESLint）

约束不靠自觉，靠 lint。最小规则集：

```jsonc
// .eslintrc —— renderer 专属
{
  "rules": {
    // feature 间禁止互相 import 内部文件，只能 import 对方 index.ts
    "no-restricted-imports": ["error", {
      "patterns": [{
        "group": ["../threads/*", "!../threads", "!../threads/index"],
        "message": "跨 feature 只能 import 对方的 index.ts（barrel）"
      }]
    }],
    // renderer 禁止 import node 内置模块（renderer 零特权，02 §7）
    "no-restricted-imports": ["error", { "patterns": [{ "group": ["node:*"], "message": "renderer 无 Node 能力，走 shared/api" }] }]
  },
  "overrides": [{
    "files": ["src/main/**", "src/preload/**"],
    "rules": { /* main/preload 放开 node:* */ }
  }]
}
```

> `no-restricted-imports` 的 feature 隔离规则需按实际 feature 名生成；可用脚本从 `features/` 目录扫出列表注入。MVP 阶段可先只开「renderer 禁 node:*」一条，feature 隔离等 S3+ 结构稳定再开。

---

## 10. 禁止清单 / 反模式

| # | 反模式 | 为什么坏 | 正解 |
|---|---|---|---|
| 1 | `renderer/components/` 顶层分类目录 | 违反 feature-domain 组织，组件归属混乱 | 进对应 feature 或 shared/ui |
| 2 | feature 直接 import 另一 feature 内部文件 | 耦合，重构地狱 | 只 import 对方 `index.ts` barrel |
| 3 | 扩展前端代码写进 `renderer/` | 槽位系统失效，扩展无法独立打包 | 进 `extensions/<id>/frontend/`（09 §9.2） |
| 4 | 流式红线埋在 `features/threads/` | 子代理视图无法复用（08 §3.3） | 提升到 `shared/streaming/` |
| 5 | `shared/` 放「预判性」抽象（只一处用） | 过早抽象，维护负担 | 先 feature，出现第二处再提升 |
| 6 | renderer 直连 SQLite/文件系统 | 破坏零特权模型（02 §7） | 走 `shared/api`（HTTP+WS） |
| 7 | 一个文件多个主组件 | 违反一文件一职责 | 拆分 |
| 8 | 跨域类型在 feature 间互相 import | 类型来源分散，契约漂移 | 统一 `shared/types/` |
| 9 | 魔数散落（如 `48` 贴底阈值、`300` CPS） | 违反 coding-style | 进 `constants.ts` |
| 10 | atom/context 滥用做跨域状态 | 01 §7 已证 jotai 在小树是过度设计 | 优先 useState/SWR，跨域用 Context |

---

## 11. 在落地序列里的位置

本篇是 **Phase A 所有前端切片（S1–S4）的目录基线**，S6 槽位接入时 `slots/` 才真正有负载。

- **S1**：建 `app/` + `features/threads/` + `shared/streaming/`（红线就位）+ `shared/api/`
- **S2**：`features/threads/` 补版本树切换组件，`shared/types/` 定 UIMessage/Thread
- **S3**：新建 `features/workspace/`
- **S5**：新建 `features/skills/`，复用 `shared/markdown/` 预览 SKILL.md
- **S6**：新建 `slots/` + `features/extension-host/`，`app/layouts/` 组合槽位容器

**验收**：每个切片 PR 必须通过「无反模式」检查（§10）+ feature 隔离 lint（§9）。结构债不留到下一切片。
