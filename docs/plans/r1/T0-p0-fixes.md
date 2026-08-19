# T0 · P0 修复（四件已经坏掉的事）

> 前置：无。先做这个。
> 读之前先读 `00-overview.md` §1 执行契约。

四个子任务互相独立，**按 T0.1 → T0.2 → T0.3 → T0.4 顺序做，每个一次 commit**。

---

## T0.1 · 模型选择 / temperature 完全无效

### 1. 问题实证

`apps/server/src/services/index.ts:35` 在**装配期**建一次 agent 单例：

```ts
const agent = buildChatAgent({ config, db, skills, workRoot, ... });
return { runs: new RunApiService(agent), ... };
```

`apps/server/src/routes/runs.ts:71-82` 每次请求确实解析了 `body.modelId`，但只用来**记录**：

```ts
const runtime = resolveAgentRuntimeConfig({ ..., requestedModelId: body.modelId });
sessionRepo.updateModel(session.id, runtime.value.mainModel.qualifiedModelId);  // 只写库
```

真正调用的永远是启动时那个模型。三个后果：

1. 前端 `select-model` 完全是装饰品；
2. 在 Settings 改 provider / API key / 默认模型必须重启进程才生效；
3. `packages/harness/src/models/openai-compatible.ts:18` 和 `anthropic.ts:14` 都接收 `temperature` 但**从不使用**（AI SDK 的 temperature 是 call setting，不是 model 构造参数）→ `settings.chat.temperature` 静默失效；
4. 附带：`buildChatAgent` 解析失败会 `throw`，而它在 `buildAppServices` 里同步执行 → **全新安装（没配 API key）时服务器直接起不来**。

### 2. 目标设计

- agent 从「装配期单例」改为「**per-run 解析 + LanguageModel 实例缓存**」。
- 解析失败不再在启动期抛，而是在请求期抛 `AgentUnavailableError`（路由已经会转 503）。
- temperature / maxOutputTokens 作为 **call settings** 透传到 `streamText`。
- provider / settings 变更后主动 `invalidate()` 模型缓存。
- **删掉 `RunApiService`**：它是一个 54 行的透传层，唯一实质逻辑是把 LangChain 遗留 role 归一化（T1 会连同宽松 schema 一起删）。路由直接用 `AgentFactory` 解析出的 agent。三层结构不变：`deps.ts`（基础设施）→ `services/`（业务装配，`AgentFactory` 就是这里的服务）→ `routes/`。

### 3. 涉及文件

| 文件 | 动作 |
|---|---|
| `apps/server/src/services/agent-factory.ts` | 新增 |
| `apps/server/src/agent.ts` | 改：导出 `toAgentModel` / `createConfiguredAgent`；删 `buildChatAgent`；注入 callSettings |
| `apps/server/src/services/index.ts` | 改：装配 `AgentFactory`，移除 agent 单例与 `RunApiService` |
| `apps/server/src/services/runs.ts` | 删除 |
| `apps/server/src/types/common.ts` | 改：`AppServices.runs` → `AppServices.agents` |
| `apps/server/src/types/runs.ts` | 改：`RunInput` 增 `sessionId`，删 `additionalTools` 之外的遗留 |
| `apps/server/src/routes/runs.ts` | 改：用 factory 解析 agent |
| `apps/server/src/routes/providers.ts`、`settings.ts` | 改：变更后调 `invalidate()` |
| `packages/harness/src/agents/types.ts` | 改：`CreateAgentOptions` 增 `callSettings` |
| `packages/harness/src/agents/create-agent.ts` | 改：透传 `callSettings` |
| `packages/harness/src/agents/lead-agent.ts` | 改：`streamText` 带上 callSettings |
| `tests/agent-factory.test.ts` | 新增 |

### 4. 步骤

**Step 1 · harness 支持 call settings**

`packages/harness/src/agents/types.ts` 增加：

```ts
/** 每次模型调用的 call settings（AI SDK 语义：不属于 model 实例，属于调用）。 */
export interface AgentCallSettings {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}
```

加到 `CreateAgentOptions` 与（`lead-agent.ts` 的）`LeadAgentOptions`：`callSettings?: AgentCallSettings;`

`lead-agent.ts` 的 `streamText({...})` 调用里加上（注意 `exactOptionalPropertyTypes`）：

```ts
const result = streamText({
  model: this.options.model,
  instructions,
  messages: promptMessages,
  tools: toolSet,
  ...(this.options.callSettings?.temperature !== undefined
    ? { temperature: this.options.callSettings.temperature }
    : {}),
  ...(this.options.callSettings?.maxOutputTokens !== undefined
    ? { maxOutputTokens: this.options.callSettings.maxOutputTokens }
    : {}),
  // ... 其余不变
});
```

`create-agent.ts` 两个 `new LeadAgent({...})` 分支都加：
```ts
...(rest.callSettings !== undefined ? { callSettings: rest.callSettings } : {}),
```

> `packages/harness/src/models/{openai-compatible,anthropic}.ts` 的 `temperature` 字段保留（签名兼容），但在文件里加一行注释说明它已不生效、temperature 走 callSettings。T4 清理该字段。

**Step 2 · `agent.ts` 拆出可复用的构造函数**

改动要点：

1. `BuildAgentOptions` 拆成两个：

```ts
/** 解析运行时模型绑定需要的输入（纯读 DB/config）。 */
export interface ResolveRuntimeOptions {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly requestedModelId?: string | undefined;
}

/** 构造 agent 需要的输入（不含 db —— 模型已解析完）。 */
export interface ConfiguredAgentOptions {
  readonly skills: Skill[];
  readonly soulSection?: PromptSection | undefined;
  readonly observer?: AgentObserver | undefined;
  readonly requestApproval?: RequestApproval | undefined;
  /** fs 工具的工作区根；缺省则不注入 fs 工具（见 T0.3）。 */
  readonly workRoot?: string | undefined;
}
```

2. `toAgentModel` 改为 `export const`（供 factory 缓存使用）。

3. `createConfiguredAgent` 改签名，第三个参数注入模型解析器；并把 callSettings 传下去：

```ts
export const createConfiguredAgent = (
  options: ConfiguredAgentOptions,
  runtime: AgentRuntimeResolution & { ok: true },
  getModel: (binding: ResolvedRuntimeModelBinding) => LanguageModel
): Agent => {
  const { mainModel, toolModel } = runtime.value;
  // ...（tools / sections 的组装逻辑保持不变，只把 toAgentModel(x) 换成 getModel(x)）

  return createAgent({
    model: getModel(mainModel),
    tools,
    systemPrompt: buildAgentSystemPrompt({ sections }),
    maxSteps: 25,
    callSettings: {
      temperature: mainModel.temperature,
      ...(mainModel.maxOutputTokens !== undefined
        ? { maxOutputTokens: mainModel.maxOutputTokens }
        : {})
    },
    ...(options.requestApproval !== undefined
      ? { requestApproval: options.requestApproval }
      : {}),
    contextPolicy: { /* 不变 */ },
    subagents: [generalPurposeSubagent],
    ...(options.observer !== undefined ? { observer: options.observer } : {})
  });
};
```

4. **删除 `buildChatAgent`**（唯一调用方是 `services/index.ts`，本任务一起改）。`AgentUnavailableError` 保留。

**Step 3 · 新增 `apps/server/src/services/agent-factory.ts`**

```ts
import type { LanguageModel } from "ai";
import type { Agent, RequestApproval } from "@eva/harness";

import {
  AgentUnavailableError,
  createConfiguredAgent,
  resolveAgentRuntimeConfig,
  toAgentModel,
  type ResolvedRuntimeModelBinding
} from "../agent.js";
import type { AppInfrastructure } from "../types/common.js";

export interface AgentResolveOptions {
  readonly requestedModelId?: string | undefined;
  readonly requestApproval?: RequestApproval | undefined;
}

export interface ResolvedAgent {
  readonly agent: Agent;
  readonly mainModel: ResolvedRuntimeModelBinding;
  readonly toolModel?: ResolvedRuntimeModelBinding;
}

/**
 * LanguageModel 实例缓存键 —— 只包含决定"实例本身"的字段。
 * temperature / maxOutputTokens 是 call settings，不进键（否则每换一次温度就新建实例）。
 */
const modelCacheKey = (b: ResolvedRuntimeModelBinding): string =>
  [b.providerType, b.providerId, b.baseURL ?? "", b.modelId, b.apiKey].join("|");

/**
 * per-run 解析 agent。
 *
 * 为什么不在装配期建单例：模型/温度/工作区都是 per-run 决策（用户在 UI 换模型、
 * 子代理走 toolModel、未来 per-workspace 工具集），单例把这些全钉死了。
 * 昂贵的只有 provider 实例构造，所以只缓存 LanguageModel。
 */
export class AgentFactory {
  private readonly models = new Map<string, LanguageModel>();

  constructor(private readonly infra: AppInfrastructure) {}

  /** provider / settings 变更后失效缓存（apiKey、baseURL 可能已改）。 */
  invalidate(): void {
    this.models.clear();
  }

  /** @throws AgentUnavailableError 当没有可用的 provider/模型配置时。 */
  resolve(options: AgentResolveOptions = {}): ResolvedAgent {
    const runtime = resolveAgentRuntimeConfig({
      config: this.infra.config,
      db: this.infra.db,
      ...(options.requestedModelId !== undefined
        ? { requestedModelId: options.requestedModelId }
        : {})
    });

    if (!runtime.ok) {
      throw new AgentUnavailableError(runtime.reason);
    }

    const agent = createConfiguredAgent(
      {
        skills: [...this.infra.skills],
        ...(this.infra.soulSection !== undefined
          ? { soulSection: this.infra.soulSection }
          : {}),
        ...(this.infra.observer !== undefined ? { observer: this.infra.observer } : {}),
        ...(options.requestApproval !== undefined
          ? { requestApproval: options.requestApproval }
          : {}),
        ...(this.infra.workRoot !== undefined ? { workRoot: this.infra.workRoot } : {})
      },
      runtime,
      (binding) => this.getModel(binding)
    );

    return {
      agent,
      mainModel: runtime.value.mainModel,
      ...(runtime.value.toolModel ? { toolModel: runtime.value.toolModel } : {})
    };
  }

  private getModel(binding: ResolvedRuntimeModelBinding): LanguageModel {
    const key = modelCacheKey(binding);
    const cached = this.models.get(key);

    if (cached) {
      return cached;
    }

    const model = toAgentModel(binding);
    this.models.set(key, model);

    return model;
  }
}
```

**Step 4 · `AppInfrastructure` 增加 `workRoot`**

`types/common.ts`：

```ts
export interface AppInfrastructure {
  config: AppConfig;
  db: AppDatabase;
  skills: readonly Skill[];
  observer?: AgentObserver | undefined;
  soulSection?: PromptSection | undefined;
  /** fs 工具的工作区根；undefined = 不注入 fs 工具（见 T0.3）。 */
  workRoot?: string | undefined;
}

export interface AppServices {
  agents: AgentFactory;
  session: SessionService;
  approvals: ApprovalGateway;
  runRegistry: RunRegistry;
}
```

`deps.ts` 的 `buildInfrastructure()` 里计算 `workRoot`（T0.3 会定它的取值），加进返回对象。

**Step 5 · `services/index.ts` 重写装配**

```ts
export const buildAppServices = (infra: AppInfrastructure): AppServices => ({
  agents: new AgentFactory(infra),
  session: new SessionService(
    new DrizzleSessionRepository(infra.db),
    new DrizzleMessageRepository(infra.db)
  ),
  approvals: new ApprovalGateway(new ApprovalRepository(infra.db)),
  runRegistry: new RunRegistry()
});
```

注意：`requestApproval` 不再在这里构造（它需要 sessionId 和 SSE emitter，见 T0.4），装配期不再有任何模型解析 → 无 API key 也能正常启动。

删除 `apps/server/src/services/runs.ts`。

**Step 6 · `routes/runs.ts` 改用 factory**

`/runs/wait`：

```ts
const body = runSchema.parse(request.body ?? {});
const resolved = app.services.agents.resolve({
  ...(body.modelId !== undefined ? { requestedModelId: body.modelId } : {})
});
const { input, sessionId } = await resolveSessionInput(app, body, resolved.mainModel);
const result = await resolved.agent.invoke(toAgentRunInput(input));
```

`/runs/stream` 同理，用 `resolved.agent.stream(toAgentRunInput(input))`。

把原 `services/runs.ts` 的 `toAgentMessage / toAgentRunInput`（含 `normalizeRole`）搬进 `routes/runs.ts` 顶部作为模块私有函数。

`resolveSessionInput` 改造：删掉里面重复的 `resolveAgentRuntimeConfig` 调用，改为接收 `mainModel: ResolvedRuntimeModelBinding` 参数，用它做 `sessionRepo.updateModel(...)` 和 memory 的 `modelLimits`。

**Step 7 · 变更后失效缓存**

`routes/providers.ts`：所有 POST / PATCH / PUT / DELETE 成功路径末尾加 `app.services.agents.invalidate();`
`routes/settings.ts`：PUT 成功路径末尾同样加。

> 这是 docs 14 §5.6「pessimistic-then-commit」的最小可行版：先写库成功，再失效缓存，下一次 run 自然拿到新配置。完整的探活-回滚留到后续切片。

**Step 8 · 【测试先行】`tests/agent-factory.test.ts`**

照 `tests/agent-runtime.test.ts` 的 DB 搭建方式，断言：

```ts
describe("AgentFactory", () => {
  it("per-request modelId 覆盖默认模型", () => {
    // 建两个 provider（都 enabled + 有 apiKey），设 defaultModel = A
    // factory.resolve() → mainModel.qualifiedModelId === A
    // factory.resolve({ requestedModelId: B }) → mainModel.qualifiedModelId === B
  });

  it("相同 binding 复用同一个 LanguageModel 实例", () => {
    // 连续 resolve 两次，取 (factory as any).models.size === 1
    // 或者更好：暴露一个只读 getter modelCacheSize 供测试断言
  });

  it("invalidate 后重建实例", () => { /* modelCacheSize === 0 */ });

  it("无可用 provider 时抛 AgentUnavailableError（而不是在装配期崩）", () => {
    expect(() => new AgentFactory(infraWithNoProvider).resolve()).toThrow(AgentUnavailableError);
  });
});
```

> `modelCacheSize` 作为 `get modelCacheSize(): number` 加在 `AgentFactory` 上（只读，供测试与将来可观测使用），比 `as any` 干净。

### 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿
- [ ] 手工：起 `pnpm web:dev`，配两个不同模型，在 UI 切换后发消息 → 服务端日志里 `llm_call_*` 的模型确实变了
- [ ] 手工：`.env.local` 清掉 API key、DB 里 provider 全 disabled → 服务器**能正常启动**，发消息返回 503 + 可读原因
- [ ] 手工：改 Settings 的 temperature → 无需重启即生效（可用一个高温度看输出发散验证）
- [ ] `grep -rn "RunApiService\|buildChatAgent" apps packages` 无结果

---

## T0.2 · 每次重启丢光所有向量且永不恢复

### 1. 问题实证

`apps/server/src/db/index.ts:59-79` 的 `createVecTables` 在**每次** `migrateDb()` 里无条件执行：

```ts
sqlite.exec("DROP TABLE IF EXISTS memory_embeddings");
sqlite.exec(`CREATE VIRTUAL TABLE memory_embeddings USING vec0(...)`);
```

而 `services/memory-embedding.ts` 的 `backfillPendingEmbeddings` 只捞 `embedding_status IN ('pending','error')`。已 embed 的记忆状态是 `'ready'` → **向量表被清空、状态仍是 ready → 永远不会重新嵌入**。结果：重启后语义检索静默退化为纯 FTS，且不可自愈。

### 2. 目标设计

只在「表不存在」或「维度不匹配」时重建；维度不匹配时同步把 `ready` 打回 `pending`，让 backfill 能重建。

### 3. 涉及文件

`apps/server/src/db/index.ts`、`tests/db-vec-persistence.test.ts`（新增）。

### 4. 步骤

**Step 1 · 【测试先行】`tests/db-vec-persistence.test.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, initDb, isVecAvailable, migrateDb } from "../apps/server/src/db/index.js";
import { MemoryEmbeddingRepository } from "../apps/server/src/db/repositories/memory-embedding-repository.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "eva-vec-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("vec table persistence", () => {
  it("向量在重启（重新 migrate）后仍然存在", () => {
    const dbPath = path.join(dir, "eva.db");

    const first = initDb({ dbPath });
    migrateDb(first);
    if (!isVecAvailable()) return;              // 环境未装 sqlite-vec → 跳过
    new MemoryEmbeddingRepository(first).upsert("m1", new Array(1024).fill(0.01));
    closeDb(first);

    const second = initDb({ dbPath });
    migrateDb(second);                          // 关键：第二次 migrate 不许清表
    const hit = /* 用 repo 的查询接口确认 m1 仍在，例如 KNN 查询能命中 m1 */;
    expect(hit).toBe(true);
    closeDb(second);
  });
});
```

> 实现者需先读 `apps/server/src/db/repositories/memory-embedding-repository.ts`，用它已有的方法做断言（有 `upsert`，找一个能读回的方法；若没有就加一个 `has(memoryId): boolean`，直接 `SELECT 1 FROM memory_embeddings WHERE memory_id = ?`）。

**Step 2 · 改 `createVecTables`**

```ts
const VEC_TABLE = "memory_embeddings";

/** 读现有 vec0 表声明的维度；表不存在返回 undefined。 */
const readVecTableDimensions = (sqlite: Database.Database): number | undefined => {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(VEC_TABLE) as { sql?: string } | undefined;
  const matched = row?.sql?.match(/FLOAT\[(\d+)\]/i)?.[1];

  return matched ? Number(matched) : undefined;
};

/**
 * vec0 虚表是派生索引，但**重建代价是重新调用 embedding API**，不能每次启动都清。
 * 只在「不存在」或「维度变了」时重建；后者同时把 ready 打回 pending，
 * 否则 backfillPendingEmbeddings 永远捞不到它们（它只看 pending/error）。
 */
const createVecTables = (sqlite: Database.Database): void => {
  if (!vecLoaded) {
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const existingDimensions = readVecTableDimensions(sqlite);

  if (existingDimensions === EMBEDDING_DIMENSIONS) {
    return;
  }

  sqlite.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
  sqlite.exec(`
    CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIMENSIONS}]
    );
  `);

  if (existingDimensions !== undefined) {
    // 维度变更 → 旧向量全部作废，标回 pending 让 backfill 重建
    sqlite.exec("UPDATE memories SET embedding_status = 'pending' WHERE embedding_status = 'ready'");
  }
};
```

### 5. 验收

- [ ] 新测试从 RED 到 GREEN
- [ ] `pnpm typecheck && pnpm test` 全绿
- [ ] 手工：跑一次让记忆嵌入成功（Settings 里配好 embedding），重启 server，`sqlite3 ~/.eva/eva.db "select count(*) from memory_embeddings"` 非 0

---

## T0.3 · fs 工具的工作区根目录来自字符串切片

### 1. 问题实证

`apps/server/src/services/index.ts:32-33`：

```ts
const workRoot = infra.config.TARGET_REPO_ROOT.trim()
  || infra.config.DB_PATH.split("/").slice(0, -2).join("/");
```

- `TARGET_REPO_ROOT` 在 `config.ts:15` 默认 `process.cwd()` → **打包后的桌面端 cwd 是 app 资源目录**，agent 的 write/bash 直接落在 App 包里。
- 一旦显式设了 `DB_PATH=/Users/x/.eva/eva.db`，兜底算出 `/Users/x` → **bash / write / edit 三个工具的根目录变成整个家目录**。

### 2. 目标设计

工作区必须**显式**。没有显式工作区 → 不注入 fs 工具（能力缺失是可见的；一个指向 `$HOME` 的 agent 是不可见的危险）。这也正是 S3 `workspaces` 表要接管的位置，本任务只做"关闸"。

### 3. 涉及文件

`apps/server/src/config.ts`、`apps/server/src/deps.ts`、`apps/server/src/services/index.ts`、`.env.example`。

### 4. 步骤

**Step 1** `config.ts`：`TARGET_REPO_ROOT: z.string().default("")`（去掉 `process.cwd()` 默认值）。

**Step 2** `deps.ts` 的 `buildInfrastructure()` 里解析并校验：

```ts
import { existsSync } from "node:fs";

const resolveWorkRoot = (raw: string, logger: Logger): string | undefined => {
  const trimmed = raw.trim();

  if (!trimmed) {
    logger.warn(
      "TARGET_REPO_ROOT 未设置 —— 文件系统工具（read/write/edit/bash/grep/list）不会注入。"
      + "设置为一个明确的项目目录后重启。"
    );
    return undefined;
  }

  const absolute = path.resolve(trimmed);

  if (!existsSync(absolute)) {
    logger.error({ workRoot: absolute }, "TARGET_REPO_ROOT 指向的目录不存在；fs 工具不注入。");
    return undefined;
  }

  // 家目录 / 根目录作为工作区几乎总是配置错误，宁可拒绝
  if (absolute === os.homedir() || absolute === path.parse(absolute).root) {
    logger.error({ workRoot: absolute }, "TARGET_REPO_ROOT 不能是家目录或文件系统根；fs 工具不注入。");
    return undefined;
  }

  logger.info({ workRoot: absolute }, "fs 工具工作区根");
  return absolute;
};
```

返回对象里带上 `...(workRoot !== undefined ? { workRoot } : {})`。

**Step 3** `services/index.ts` 删掉整个 workRoot 计算（已移到 deps）。`AgentFactory` 从 `infra.workRoot` 读（T0.1 Step 3 已经这么写了）。

**Step 4** `.env.example` 加注释：

```bash
# fs 工具（read/write/edit/bash/grep/list）的工作区根目录。
# 必须显式指定一个项目目录；留空则不注入 fs 工具。
# 不允许设为 $HOME 或 /（会被拒绝）。
TARGET_REPO_ROOT=
```

同时在本地 `.env.local` 里设成本仓库路径，保证开发体验不变。

**Step 5** 检查 `config.ts:74` 的 `resolveRepositoryRoot` 是否还有调用方（`grep -rn "resolveRepositoryRoot" apps packages tests`）。无调用方 → 删除。

### 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿
- [ ] 手工：`TARGET_REPO_ROOT` 留空启动 → 日志有 warn，问 agent "读一下 README" 时它报告没有文件工具（而不是去读别处）
- [ ] 手工：`TARGET_REPO_ROOT=$HOME` 启动 → 日志 error 且不注入
- [ ] `grep -n "DB_PATH.split" apps` 无结果

---

## T0.4 · 审批闸门：重复文本 + 可能死循环 + abort 吊死

### 1. 问题实证

> **先读这一句：这不是"审批体验有瑕疵"，是「当前 main 上任何工具调用都跑不通」。**
> 下面的两条报错是用 `MockLanguageModelV4` 实测出来的，不是推断。

**实测复现**（造一个「第一步调用工具、第二步输出文本」的 mock 流，走 `createAgent().stream()`）：

| 场景 | 实际结果 |
|---|---|
| 不注入 `requestApproval` | 工具**不执行**，第二步报 `Tool result is missing for tool call tc-1.` |
| 注入 `requestApproval`（返回 true） | 工具**不执行**，报 `Tool approval response references unknown approvalId: "...". No matching tool-approval-request found in message history.` |

两条路径都拿不到工具结果。整个 test suite 是绿的，因为**没有任何一条测试让 agent 真的调用过工具**（`grep -rn "tool-result" tests/` 无结果）。

根因四条：

1. **审批被套在了所有工具上，不只是危险工具**：`lead-agent.ts:400` 的 `toolApproval: () => ({ type: "user-approval" })` 是 SDK 的**通用**审批函数，对每一个 tool call 都返回"需要用户审批"，`requiresApproval` / `needsApproval` 标记根本没参与判断。`web_search`、`read_file` 这些只读工具也会走审批。
2. **消息序列不合法（上表第二行的直接原因）**：`lead-agent.ts:635` 只 push 了 `tool-approval-response` 的 tool 消息，**没有先 push 携带该 tool-approval-request 的 assistant 消息**。SDK 校验 `approvalId` 时在历史里找不到对应请求，直接报错终止。
3. **未注入 `requestApproval` 时静默吞掉（上表第一行）**：`:614` 的条件是 `approvalRequests.length > 0 && this.requestApproval`，`requestApproval` 缺省时整块被跳过 —— 审批请求既不批准也不拒绝，`out.collect` 带着一个没有结果的 tool call 交给 `appendStepMessages`，下一步必然报 "Tool result is missing"。
4. **正文重复**：`lead-agent.ts:371` 的 `let text = ""` 声明在 `while (rerun)` **外面**。一旦 rerun 真的发生，模型重新生成的前导文本会被累加两遍，前端也收到两遍 `text-delta`。

另有两条不影响"能不能跑"但必须一起修的：

5. **abort 时 pending 审批不被拒**：`ApprovalGateway.ask()` 返回的 Promise 只能由用户决策或 **10 分钟**超时 resolve。`lead-agent.ts:618` 的 `await this.requestApproval(...)` 在 abort 后仍然挂着 → 生成器阻塞最长 10 分钟、assistant 消息永不落库、`runRegistry` 条目泄漏。
6. **审批不按会话隔离**：`services/index.ts:28` 传的 sessionId 是空串 `""`；前端 `use-approvals.ts` 靠 900ms 全局轮询发现。

**这条路径 0 测试覆盖**（`grep -rl approval tests/` 无结果）。

> **实现者注意**：Step 8 的测试里必须包含一条「工具真的被执行了、且 `tool-result` 事件带回正确 output」的用例。这是本仓库第一条覆盖工具执行的测试 —— 缺了它，同样的问题还会再回来一次。

### 2. 目标设计（**推翻 `docs/plans/s4-tools-approval.md` §2 的决策**）

改用 **`withApproval` 高阶包装**——即 `docs/architecture/14-eva-architecture.md` §4.4 的原文方案：「危险工具 execute 外层包 `withApproval` 高阶函数」。

```
tool.execute 被包一层
  → 进入 execute 时先 await requestApproval(toolCallId, args)
  → 允许：调用原 execute
  → 拒绝：返回一段说明文本给模型（"[Approval Denied] ..."）
  → abort / run 结束：cancelBySession 统一 reject → execute 立刻返回拒绝文本
```

相比 SDK 两轮审批的收益，逐条对应上面的缺陷：

| 缺陷 | 为什么消失 |
|---|---|
| 正文重复 | 只有一次模型调用，不存在重跑 |
| 消息序列不合法 | 不需要手工缝 approval-response 消息，SDK 正常的 tool-call/tool-result 配对 |
| 死循环 | 没有 rerun 分支 |
| abort 吊死 | `cancelBySession` 能 reject 所有 pending |
| 额外收益 | 省一次完整模型调用的 token |

代价：审批发生在 tool execute 内部，模型侧看不到"审批"这个概念（它只看到工具返回了拒绝说明）。这对单用户桌面场景完全够用，且符合 §4.4 原文。

审批事件改由 **SSE 推送**（docs 14 §6.1 的 Eva 自有域事件），前端不再轮询。

### 3. 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/harness/src/tools/with-approval.ts` | 新增 |
| `packages/harness/src/tools.ts` | 改：`buildTool` 不再映射 `needsApproval` |
| `packages/harness/src/agents/create-agent.ts` | 改：在此包装危险工具 |
| `packages/harness/src/agents/lead-agent.ts` | 改：删 `toolApproval` / rerun 块 / `tool-approval-request` case / `requestApproval` 字段 |
| `packages/harness/src/index.ts` | 改：导出 `with-approval` |
| `apps/server/src/services/approval-gateway.ts` | 改：加 `cancelBySession`，常量提取 |
| `packages/shared/src/stream-events.ts` | 改：加审批事件 |
| `apps/server/src/routes/runs.ts` | 改：per-run 构造 `requestApproval` + SSE 推审批帧 + finally cancel |
| `tests/approval-flow.test.ts` | 新增 |

### 4. 步骤

**Step 1 · 新增 `packages/harness/src/tools/with-approval.ts`**

```ts
import type { AgentTool } from "../tools.js";
import type { RequestApproval } from "../agents/types.js";

export const APPROVAL_DENIED_PREFIX = "[Approval Denied]";

const deniedMessage = (toolName: string): string =>
  `${APPROVAL_DENIED_PREFIX} The user rejected the \`${toolName}\` call. `
  + "Do not retry the same call. Explain what you wanted to do and ask the user how to proceed.";

/**
 * 危险工具的审批闸门（docs/architecture/14 §4.4）。
 *
 * 为什么包在 execute 外层而不用 SDK 的 toolApproval 两轮调用：两轮调用需要手工
 * 缝 assistant(tool-call) + tool(approval-response) 消息序列，缝错会重复正文甚至
 * 死循环；而且每次审批要多付一次完整模型调用。包装法只有一次模型调用，
 * abort 时能被 cancelBySession 统一 reject。
 */
export const withApproval = (
  agentTool: AgentTool,
  requestApproval: RequestApproval
): AgentTool => {
  if (agentTool.requiresApproval !== true) {
    return agentTool;
  }

  const inner = agentTool.tool;
  const innerExecute = inner.execute;

  if (typeof innerExecute !== "function") {
    return agentTool;
  }

  return {
    ...agentTool,
    tool: {
      ...inner,
      execute: async (input: unknown, options) => {
        const approved = await requestApproval({
          toolName: agentTool.name,
          toolCallId: options.toolCallId,
          args: (input as Record<string, unknown>) ?? {}
        });

        if (!approved) {
          return deniedMessage(agentTool.name);
        }

        return innerExecute(input as never, options);
      }
    } as typeof inner
  };
};
```

> 实现者先确认 `ai@7` 的 `ToolCallOptions` 确实带 `toolCallId`（`node_modules/ai/dist/index.d.ts` 里搜 `type ToolCallOptions`）。若字段名不同，按实际的改，并在注释里记下。

**Step 2 · `tools.ts`：`buildTool` 不再设 `needsApproval`**

删掉这一行：
```ts
...(definition.requiresApproval === true ? { needsApproval: true } : {}),
```
`requiresApproval` 保留为 `AgentTool` 上的元数据（`withApproval` 靠它判定）。在 `AgentTool.requiresApproval` 的注释里改成：「危险工具标记；由 `createAgent` 用 `withApproval` 包装 execute 实现闸门」。

**Step 3 · `create-agent.ts` 统一包装**

在 `createAgent` 开头做一次映射，两个分支共用（这样子代理也自动继承审批）：

```ts
export const createAgent = (options: CreateAgentOptions): Agent => {
  const { subagents, requestApproval, ...rest } = options;

  const tools = requestApproval
    ? (rest.tools ?? []).map((t) => withApproval(t, requestApproval))
    : rest.tools;

  // 后续逻辑用 tools 替代 rest.tools；不再把 requestApproval 传给 LeadAgent
  // ...
};
```

**Step 4 · `lead-agent.ts` 删审批相关代码**

删除：
- `LeadAgentOptions.requestApproval` 字段与 `this.requestApproval`；
- `streamText({ ..., toolApproval: () => ({ type: "user-approval" }) })` 这一项；
- `let rerun = true; while (rerun) { ... }` 整个外层（保留内部的一次 `streamText` + `for await`）；
- `case "tool-approval-request"` 分支；
- `approvalRequests` 数组与 Step 结束后处理审批、push tool 消息、`rerun = true` 的整块（`:612-642`）。

删完后 `runSingleStep` 的结构应是：一次 `streamText` → `for await (part of result.stream)` → switch → 结束时 `out.collect = {...}`。`let text = ""` 等局部变量语义随之正确（只有一轮）。

> T2 会把这个函数整体重写掉；T0.4 只做**删除**，不要顺手重构。

**Step 5 · `approval-gateway.ts` 加 `cancelBySession`**

```ts
/** 审批挂起的上限。超时按拒绝处理，避免 run 永久吊死。 */
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

// PendingRequest 不变（已有 sessionId 字段）

/**
 * 取消某会话下所有未决审批（abort / run 结束 / 进程收尾时调用）。
 * docs 14 §4.4：「abort / run 结束 / destroy 时 cancelAll 统一 reject（不会永远吊着）」。
 * @returns 被取消的数量
 */
cancelBySession(sessionId: string): number {
  let cancelled = 0;

  for (const [callId, entry] of [...this.pending]) {
    if (entry.sessionId !== sessionId) {
      continue;
    }
    clearTimeout(entry.timer);
    this.pending.delete(callId);
    this.repo.decide(callId, "denied");
    entry.resolve(false);
    cancelled += 1;
  }

  return cancelled;
}
```

同时把 `listPending(sessionId?)` 的 sessionId 过滤保留（重连恢复用）。

**Step 6 · `packages/shared/src/stream-events.ts` 加审批事件**

```ts
// ---------- Eva 自有域：审批桥（docs 14 §6.1） ----------

/** 危险工具挂起等待用户决策。 */
export interface RunApprovalRequestEvent {
  type: "approval_request";
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** 审批已决（用户决策 / 自动放行 / abort 取消）。 */
export interface RunApprovalResolvedEvent {
  type: "approval_resolved";
  callId: string;
  approved: boolean;
}
```

加进 `RunStreamEvent` 联合类型。

**Step 7 · `routes/runs.ts` per-run 审批闭环**

`/runs/stream` 里，**在 sessionId 已知之后、resolve agent 之前**构造：

```ts
// 统一的帧出口：seq 只在这里递增（generator 帧与审批帧共用同一序列）
const emit = (event: RunStreamEvent): void => {
  seq += 1;
  writeFrame(reply, { ...event, seq } as RunStreamFrame);
};

const requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
  const settings = loadAppSettings(app.infra.db, app.infra.config);

  if (settings.security.autoApproveToolRequests) {
    return true;
  }

  emit({ type: "approval_request", callId: toolCallId, toolName, args });
  const approved = await app.services.approvals.ask(toolCallId, sessionId, toolName, args);
  emit({ type: "approval_resolved", callId: toolCallId, approved });

  return approved;
};

const resolved = app.services.agents.resolve({
  ...(body.modelId !== undefined ? { requestedModelId: body.modelId } : {}),
  requestApproval
});
```

原来的 `writeFrame(reply, {...event, seq})` 全部改走 `emit(event)`。

abort 与收尾都要 cancel：

```ts
reply.raw.on("close", () => {
  if (!finished) {
    app.services.runRegistry.abort(runId);
    app.services.approvals.cancelBySession(sessionId);   // 别让 pending 审批吊住 loop
  }
});

// ... finally 块：
} finally {
  app.services.runRegistry.unregister(runId);
  if (sessionId) {
    app.services.approvals.cancelBySession(sessionId);
  }
}
```

`POST /api/v1/runs/:runId/abort` 也要能取消审批：`RunRegistry.register` 改为 `register(runId, sessionId)` 并在 `abort()` 里回调，或更简单——让 abort 路由拿到 sessionId。**选后者**：`RunRegistry` 存 `{controller, sessionId}`，`abort(runId)` 返回 `sessionId | undefined`，路由据此调 `cancelBySession`。

**Step 8 · 【测试先行】`tests/approval-flow.test.ts`**

用 `MockLanguageModelV4` 造一个「先调一次危险工具、再输出文本」的流（参考 `tests/lead-agent-abort.test.ts` 的 chunk 构造方式，加 `tool-input-start` / `tool-call` chunk），断言四件事：

```ts
it("允许 → 工具真的执行，且正文只出现一次", async () => {
  // requestApproval 返回 true
  // 断言 innerExecute 被调用 1 次
  // 断言拼接后的 text-delta 里目标句子只出现一次（回归"重复正文"）
});

it("拒绝 → 工具不执行，模型收到 [Approval Denied] 文本", async () => {
  // requestApproval 返回 false
  // 断言 innerExecute 调用 0 次
  // 断言 tool-result 事件的 output 以 APPROVAL_DENIED_PREFIX 开头
});

it("cancelBySession 让 pending 审批立刻按拒绝返回", async () => {
  // 用真的 ApprovalGateway（:memory: db），ask 后不决策，直接 cancelBySession
  // 断言 ask 的 promise resolve 成 false，且 repo 里状态是 denied
});

it("只读工具不经过审批", async () => {
  // withApproval(readOnlyTool, spy) 应返回原对象，spy 未被调用
});

it("【回归】agent 级：只读工具能跑完整条链路", async () => {
  // 这条是本仓库第一个覆盖"工具真的执行"的用例，对应 §1 实测的两条报错。
  // mock 流：step1 产 tool-call（只读工具），step2 产文本。
  // 断言：
  //   - 收到 type === "tool-result" 事件，output 就是工具 execute 的返回值
  //     （不是 JSON 二次转义的字符串）
  //   - requestApproval 一次都没被调用（只读工具不该问）
  //   - 没有 type === "error" 事件
  //   - finish.finishReason === "stop"
});
```

### 5. 验收

- [ ] 新测试从 RED 到 GREEN；`pnpm typecheck && pnpm test` 全绿
- [ ] `grep -n "toolApproval\|tool-approval-request\|rerun" packages/harness/src/agents/lead-agent.ts` 无结果
- [ ] 手工（**最关键的一条**）：让 agent 做一次 `web_search` 或 `read_skill` 这类只读工具调用 → 不弹审批、工具真的执行、结果出现在回复里。修之前这一步必然报 `Tool approval response references unknown approvalId`
- [ ] 手工：让 agent 写一个文件 → 审批卡片弹**一次**；点允许 → 文件真的创建，且回复正文没有重复段落
- [ ] 手工：审批弹出时点前端 Stop（或直接关页面）→ 服务端日志显示审批被 cancel，run 立刻结束（不是等 5–10 分钟）
- [ ] `curl -N POST /api/v1/runs/stream` 能看到 `event: approval_request` 与 `event: approval_resolved`，且所有帧的 `seq` 严格单调递增
