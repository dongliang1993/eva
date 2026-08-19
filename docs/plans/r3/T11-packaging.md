# T11 · 打包链路修通

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/02-electron-desktop.md` §8（打包分发）、`14-eva-architecture.md` §7.3（文件布局）。

**这个任务修的是一条从未被执行过的代码路径。** `main.ts` 在 `isDev` 分支不 fork server（server 由 `tsx` 在系统 Node 上单独跑，UI 走 Vite 5173），所以 `utilityProcess.fork` + 原生模块 + 打包资源定位这一整条链，在这个仓库里**一次都没跑过**。

因此本任务的纪律是：**每一步都在打包产物里验，不在 dev 里验。** 任何"看起来应该对"的推断都不算完成。

---

## 1. 六个缺口（实证见 `00-overview.md` §1.1）

| # | 缺口 | 后果 |
|---|---|---|
| P1 | `.server-deploy/node_modules/` 被 `extraResources` 引用，但无人产出 | electron-builder 在缺失的 `from` 路径上报错 |
| P2 | `dist/index.js` 的依赖全是 external，需要 P1 提供 | 即使打包成功，server 首个 import 就崩 |
| P3 | `apps/web/dist` 从未进包 | 窗口加载 `http://127.0.0.1:port` → 空白（server 没有 SPA 可服务） |
| P4 | `desktop:build` 不构建 web | 连产物都没有 |
| P5 | `better_sqlite3.node` 按系统 Node ABI 编译，server 跑在 Electron 的 Node 里 | `Module did not self-register` / ABI 版本不匹配，server 起不来 |
| P6 | skills 目录指向 monorepo 根或 App 包内部 | 装完的用户没有任何途径加 skill |

---

## 2. 目标设计

### 2.1 打包后的资源布局

```
Eva.app/Contents/Resources/
├── app.asar                    主进程 + preload（dist-electron/**）
├── server/
│   ├── dist/index.js           tsup 产物（bundle 了 @eva/*）
│   ├── dist/migrations/        drizzle 迁移（copy-migrations.mjs 已经在做）
│   ├── node_modules/           ★ pnpm deploy --prod 产出，且已按 Electron ABI rebuild
│   ├── package.json            提供 "type": "module"
│   └── SOUL.md
└── web/dist/                   ★ 新增：SPA，由 server 的 static 路由服务
```

`server/dist/index.js` 的 `import.meta.dirname` = `Resources/server/dist`，于是：
- `resolveMigrationsFolder()` → `Resources/server/dist/migrations` ✓（已有）
- `resolveWebDist()` 的第二个候选 `../../web/dist` → `Resources/web/dist` ✓（本任务补上产物）
- `loadSoulSection(path.resolve(dirname, ".."))` → `Resources/server/SOUL.md` ✓（已有）

### 2.2 用户数据一律在 `~/.eva/`（不在 App 包里）

`docs 14 §7.3` 定的就是这个。现状里 DB 与 tool-overflow 已经在 `evaDataDir()`（R2 T6 做的），**只有 skills 还指着 monorepo 根**。本任务把它也搬过去：

```
~/.eva/
├── eva.db (+ -wal/-shm)
├── mcp.json
├── skills/<name>/SKILL.md      ★ 本任务：用户技能的唯一位置
└── tool-overflow/<workspaceId>/
```

dev 态额外保留 monorepo 根的 `skills/` 作为第二来源（方便在仓库里试写 skill 并提交），但**打包态只认 `~/.eva/skills/`**。

### 2.3 原生模块

| 模块 | 形态 | 要不要 rebuild |
|---|---|---|
| `better-sqlite3` | Node addon（`better_sqlite3.node`） | **要** —— Electron 有自己的 ABI |
| `sqlite-vec` | SQLite loadable extension（`vec0.dylib`，运行时 `loadExtension` dlopen） | 不要（与 Node ABI 无关），但**平台包 `sqlite-vec-darwin-arm64` 必须在 node_modules 里** |

`extraResources` 把 `node_modules` 放在 asar **外面**，所以不需要 `asarUnpack`（`docs 02 §8.2 坑1` 说的是 asar 内部的情况，本设计已绕过）。

---

## 3. 涉及文件

| 文件 | 动作 |
|---|---|
| `apps/desktop/package.json` | 改：`build` 串上 web + server-deps + rebuild；加 `@electron/rebuild` devDep |
| `apps/desktop/electron-builder.yml` | 改：加 web dist 到 extraResources；砍 win target |
| `apps/desktop/electron/main.ts` | 改：单实例锁；打包态 server 启动失败页补上日志尾部 |
| `apps/server/src/paths.ts` | 改：加 `userSkillsDir()` |
| `apps/server/src/deps.ts` | 改：skills 来源改成 `~/.eva/skills` (+ dev 的 monorepo `skills/`) |
| `packages/harness/src/skills/loader.ts` | 改：`loadSkills` 接受多个目录 |
| `.gitignore` | 改：确认 `.server-deploy/` 已忽略（现状已有） |
| `AGENTS.md` / `README.md` | 改：打包步骤 + `~/.eva/skills` 位置 |
| `tests/skills.test.ts` | 改：跟随 `loadSkills` 签名 |

**不新增迁移**（本任务不碰 DB）。

---

## 4. 步骤

> 每步做完都要 `pnpm typecheck && pnpm test`；标 🔬 的步骤额外要求**在打包产物里验**。

### Step 1 · `.server-deploy` 的产出（P1/P2）

`pnpm deploy` 就是这个配置当初想用的机制（`pnpm --filter=<pkg> deploy <dir>`，pnpm 10.30 可用）。

`apps/desktop/package.json` 加：

```json
"build:server-deps": "rm -rf .server-deploy && pnpm --filter @eva/server deploy --prod .server-deploy"
```

`pnpm deploy` 产出的是一个完整可部署包（`package.json` + `node_modules` + 文件），配置只取它的 `node_modules`，多出来的部分无害。

**验证**（先单独跑，别急着串进 build）：

```bash
pnpm --filter @eva/desktop run build:server-deps
ls apps/desktop/.server-deploy/node_modules | head          # 应有 fastify / better-sqlite3 / ai / drizzle-orm ...
ls apps/desktop/.server-deploy/node_modules/@modelcontextprotocol   # T9 加的依赖也要在
ls apps/desktop/.server-deploy/node_modules/sqlite-vec-darwin-arm64/vec0.dylib
```

清单要覆盖 `dist/index.js` 的全部 external：
`@ai-sdk/anthropic @ai-sdk/openai-compatible @fastify/static @modelcontextprotocol/sdk ai better-sqlite3 dotenv drizzle-orm fastify fast-glob lru-cache pino sqlite-vec turndown zod`

> 少任何一个，装出来的 app 都是"启动失败"页。**用上面这条清单逐个 `ls` 核对**，不要目测。

### Step 2 🔬 · 原生模块按 Electron ABI 重建（P5）

```bash
pnpm --filter @eva/desktop add -D @electron/rebuild
```

`apps/desktop/package.json` 加：

```json
"rebuild:native": "electron-rebuild --module-dir .server-deploy --only better-sqlite3"
```

`@electron/rebuild` 会从 `apps/desktop/node_modules/electron` 读出目标版本（35.7.5），不需要手写版本号 —— **不要写死版本**，升 Electron 时会忘。

**验证 ABI 真的换了**：

```bash
# 系统 Node 的 ABI（当前是 127 / node 22.22）
node -p "process.versions.modules"
# rebuild 前后对比 .node 的 mtime 与体积
ls -l apps/desktop/.server-deploy/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

真正的验证在 Step 6：装出来的 app 能打开会话列表（意味着 SQLite 连上了）。

> **如果 `electron-rebuild` 失败**（缺 Xcode CLT / python），先报告再决定，不要绕过它去改 tsup 把 better-sqlite3 打进 bundle —— 原生模块不能被 bundle。

### Step 3 · 前端产物进包（P3/P4）

`electron-builder.yml` 的 `extraResources` 加一项（放在 server 那几项后面）：

```yaml
  - from: ../../apps/web/dist/
    to: web/dist/
    filter:
      - "**/*"
```

`apps/desktop/package.json` 的 build 串起来：

```json
"build:web": "pnpm --filter @eva/web build",
"build": "pnpm run build:web && pnpm run build:server && pnpm run build:server-deps && pnpm run rebuild:native && pnpm run build:electron"
```

顺序有讲究：`build:server-deps` 必须在 `build:server` 之后（deploy 读的是 server 的 package.json，与 dist 无关，但保持"先产物后依赖"的直觉顺序），`rebuild:native` 必须在 `build:server-deps` 之后（它 rebuild 的是那个目录里的东西）。

### Step 4 · 砍掉 win target

`docs/architecture/13` 坑5 已经定了 mac arm64 单架构。`electron-builder.yml` 删掉 `win:` 与 `nsis:` 两段 —— 留着一个从未构建过、也不打算支持的目标，只会让人以为它能用。

### Step 5 · skills 搬到 `~/.eva/skills`（P6）

`apps/server/src/paths.ts` 加：

```ts
/**
 * 用户技能目录。技能是用户内容，必须在用户数据目录里 ——
 * 放 App 包内部的话，装完的用户根本没有途径加 skill（docs 14 §7.3）。
 */
export const userSkillsDir = (): string => path.join(evaDataDir(), "skills");
```

`packages/harness/src/skills/loader.ts` 的 `loadSkills` 改成接受多个目录：

```ts
export interface SkillSourceDir {
  readonly dir: string;
  readonly source: Skill["source"];
}

/**
 * 按给定顺序扫描多个目录。同名 skill 后来者不覆盖先到者 —— 用户目录排在前面，
 * 于是用户可以用同名 skill 覆盖内置的。
 */
export const loadSkills = async (
  dirs: readonly SkillSourceDir[]
): Promise<Skill[]> => { /* ... */ };
```

`deps.ts` 的调用：

```ts
// 用户技能在 ~/.eva/skills（打包后唯一可写位置）；dev 时额外扫 monorepo 根的
// skills/，方便在仓库里试写并提交。打包态 findMonorepoRoot 会退化成 cwd，
// 那个目录不存在,scanDirectory 返回空,无副作用。
const skills = await loadSkills([
  { dir: userSkillsDir(), source: "project" },
  { dir: resolveSkillsDir(findMonorepoRoot(process.cwd())), source: "project" }
]);
```

> `BUNDLED_SKILLS_DIR`（`loader.ts:10`，从 `import.meta.url` 推算）在打包后会指向
> `Resources/server/dist/bundled`，不存在。**当前 `bundled/` 是空目录**（`find … | wc -l` → 0），
> 所以今天没坏；但第一个内置 skill 加进去的那天它会静默失效。本任务在 `loader.ts` 该常量上
> 加一行注释说明这件事，并在 FINDINGS 记一条 `[r4]`（要么随 `copy-migrations.mjs` 一起拷进
> dist，要么走 extraResources）。**不要在本任务里顺手实现**——没有内置 skill 就没有验收对象。

### Step 6 · 单实例锁

`main.ts` 顶层（`app.whenReady()` 之前）：

```ts
// 第二个实例会抢同一个 ~/.eva/eva.db —— SQLite WAL 能扛并发读写，但两个实例
// 各自 fork 一份 server、各自连一套 MCP server，行为不可预测。直接拒绝第二实例。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
```

> 托盘 / `eva://` 深链 / 全局唤起**不在本任务**（S11 其余，R5）。单实例锁进来是因为它与"多实例抢同一个 DB"直接相关，属于正确性而非打磨。

### Step 7 🔬 · 启动失败页要能自己诊断

`main.ts` 的 `waitForServer` 失败分支现在只显示 `err.message`。打包态最常见的失败是"server 进程起来又立刻死"（原生模块 ABI、缺依赖），真实原因在 `serverErrors` 里。

把失败页改成同时显示 `serverErrors.slice(-20).join("\n")`（`startServer` 已经在收集 stdout/stderr 了），并把它也写进主进程日志。

> 这条和 `r2/T9-mcp.md` 里给 MCP 加 stderr 尾部是同一个道理：**包装外部进程时，"错误信息够不够用户/开发者自己定位"要单独验一遍。** T11 的调试全靠这个页面。

### Step 8 🔬 · 打包并逐条验收

```bash
pnpm --filter @eva/desktop pack
open apps/desktop/release/          # 装 dmg 到 /Applications
```

装完后按 `§5 验收` 逐条走。**发现问题回到对应 Step 修，不要在 dev 里复现**（dev 走的是另一条路）。

---

## 5. 验收

必须在**安装后的 app** 里验（不是 `pnpm desktop:dev`）：

- [ ] `pnpm --filter @eva/desktop pack` 成功产出 `release/Eva-0.1.0-arm64.dmg`
- [ ] 装到 `/Applications` 打开 → 不是空白窗口，不是"启动失败"页
- [ ] 在 Settings 里配一个 provider + 模型 → 发一条消息能收到流式回复（证明 server 起来了 + SPA 在服务 + 模型可用）
- [ ] 侧栏能看到会话列表 → **证明 better-sqlite3 在 Electron ABI 下正常工作**（P5）
- [ ] Settings → Memory 存一条记忆并搜到 → 证明 `sqlite-vec` 的 `vec0.dylib` 能 dlopen
- [ ] 添加一个工作区 → 问"列出当前目录的文件" → agent 真的列出来（证明 fs 工具与 workspace 链路在打包态可用）
- [ ] `mkdir -p ~/.eva/skills/hello && echo` 一个 SKILL.md 进去 → 重启 app → Settings 或 system prompt 里能看到该 skill（P6）
- [ ] 配一个 stdio MCP server（`~/.eva/mcp.json`）→ Settings/MCP 显示 connected（证明打包态能 spawn 子进程且 PATH 可用，`r2/T9-mcp.md` §6 坑1）
- [ ] 退出 app → `ps aux | grep -i eva` 无残留 server / MCP 子进程
- [ ] 双击第二次打开 → 聚焦已有窗口，不是起第二个实例
- [ ] `grep -n "win:\|nsis:" apps/desktop/electron-builder.yml` 无结果

## 6. 坑

1. **`pnpm deploy` 是 experimental**（`--help` 自己写着）。如果它在 pnpm 10.30 上产出的结构不对（比如 node_modules 是符号链接而不是实体），退路是 `npm install --omit=dev --prefix .server-deploy`（先把 `apps/server/package.json` 拷进去，把 `workspace:*` 依赖删掉——`@eva/*` 已被 tsup bundle，不需要）。**先试 `pnpm deploy`，不行再换，并把结论写进 commit 正文。**
2. **符号链接是打包杀手**：electron-builder 复制 `extraResources` 时若遇到 pnpm 的符号链接，可能拷成断链。`ls -l .server-deploy/node_modules/fastify` 看是实体目录还是 link；是 link 就要 `--legacy` 或换 npm 方案。
3. **不要试图把 better-sqlite3 打进 tsup bundle**。原生模块不能 bundle，`external` 是对的。
4. **`electron-rebuild` 需要 Xcode Command Line Tools**。缺了就报错而不是静默产出错东西 —— 但错误信息可能很长，别当成配置问题。
5. **验收顺序有依赖**：先验"能打开"再验"能聊天"再验"文件工具"。跳着验会把 A 的失败当成 B 的问题。
6. **dev 路径不受本任务影响**，但改完 `loadSkills` 签名后 `pnpm desktop:dev` 也要跑一次，确认没把 dev 弄坏。
