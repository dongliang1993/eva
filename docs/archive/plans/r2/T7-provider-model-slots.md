# T7 · Provider 层重构与模型槽位统一

> 前置：**T5**（P0 修复先落地）。与 T6 工作区无相互依赖，可并行；同一人做建议 T6 先。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/14-eva-architecture.md` §4.1（多模型槽位、不自造 provider 抽象层）。

---

## 1. 问题实证

### D1 · 「支持哪些 provider」有两套不一致的答案

```ts
// apps/server/src/agent.ts:45-55 —— agent runtime 认这两个
const OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES = new Set<ProviderType>(["openai"]);
const ANTHROPIC_AGENT_PROVIDER_TYPES = new Set<ProviderType>(["anthropic"]);

// apps/server/src/services/provider-runtime.ts:42-54 —— 探活/拉模型认这 11 个
const OPENAI_COMPATIBLE_TYPES = new Set<ProviderType>([
  "openai", "aihubmix", "openrouter", "deepseek", "copilot", "moonshot",
  "custom", "acp", "claude-subscription", "zai-coding-plan", "kimi-coding-plan"
]);
// 外加 google / azure 两个独立 transport
```

`ProviderType` 有 14 个成员。**其中 8 个（google / azure / aihubmix / copilot / acp / claude-subscription / zai-coding-plan / kimi-coding-plan）从未被 agent runtime 支持过** —— 用户能在 Settings 里建、能点"测试连接"通过、能拉到模型列表，然后发消息时拿到 503 "Provider type X is not supported for chat runtime yet"。这是一个**看起来能用的假功能**。

### D2 · 第二套 provider 配置

```ts
// apps/server/src/services/memory-embedding.ts:27-37
const { baseUrl, apiKey, model } = settings.memory.embedding;
```

embedding 的 provider 配置是 `settings` 表 JSON blob 里的三个裸字段，**明文 apiKey**，完全绕开 `providers` 表。用户要配两次 provider、在两个 UI 位置、密钥存两个地方。

### D3 · 槽位概念散落四处

`settings.chat.defaultModel`（主对话）、`settings.toolModel.model`（杂务）、`settings.memory.toolModel`（记忆查询重写，与上一个重复）、`settings.memory.embedding.model`（向量）——四个字段表达同一件事：**哪个模型干哪件事**。

### D4b · 模型 id 用字符串前缀猜 provider

```ts
// apps/server/src/services/settings-store.ts:158-175
export const qualifyModelId = (value: string, fallbackProviderId?: string): string => {
  if (!value || value.includes(":")) return value;
  if (value.startsWith("claude")) return `anthropic:${value}`;
  if (value.startsWith("gpt") || value.startsWith("o")) return `openai:${value}`;
  return fallbackProviderId ? `${fallbackProviderId}:${value}` : value;
};
```

两个问题：

1. **`startsWith("o")` 会误伤**任何以 o 开头的模型名（`ollama-*`、`openchat-*`…），把它们全塞给 `openai`。
2. 猜出来的 `anthropic` / `openai` 是**硬编码的 provider id**，不是 type。用户如果把 Anthropic provider 的 id 建成 `anthropic-proxy`，这个猜测就指向一条不存在的记录。

模型引用只有一种合法形状：`providerId:modelId`。产生引用的地方（UI 模型选择器、`listModelSummaries`）**本来就产出 qualified id**，这个猜测只服务于"用户手输了半个 id"这种不该被容忍的输入。

### D4 · `settings-store.ts` 689 行做四件事

settings 读写 + provider CRUD + 内置模型目录 + model-id 解析。项目自己的约定是 200–400 行。
另外 `providers` 表有 5 个纯 UI 文案列（`description` / `icon` / `base_url_placeholder` / `base_url_hint` / `api_key_hint`）—— 这些是**按 provider 类型固定的知识**，却被 seed 逐行拷进了每一条数据；`enabled` 列还是 `text` 存 `"true"/"false"`。

### D5 · `AppSettings` 有 14 个零行为字段

实测（grep 排除 schema 定义 / 默认值 / 类型声明三处后的引用数）：

| 字段 | 引用 |
|---|---|
| `general.language` / `general.theme` | 0 / 0 |
| `chat.streamResponse` / `autoSaveHistory` / `historyRetentionDays` / `showTokenUsage` / `enableMarkdown` / `modelUsageHistory` / `defaultToolSelection` / `defaultSkillSelection` | 全 0 |
| `security.encryptApiKeys` / `requirePassword` / `sessionTimeout` / `enableLogging` | 全 0 |
| `webSearch.engine` | 0（搜索工具写死 DuckDuckGo） |

这些字段既不被读，也不被 UI 渲染，但每次改设置都要过一遍 zod 校验、每个前端 `saveSettings({...data, ...})` 都要原样搬运。**它们比死代码更糟：`AppSettings` 是前后端共享契约，14 个假字段让人以为这些开关有用。**

---

## 2. 目标设计

### 2.1 provider 能力目录：单一事实源

```
services/providers/provider-catalog.ts
```

```ts
/** 决定用哪个 AI SDK 工厂 + 哪套 HTTP 探活协议。加 provider 时先想清楚它属于哪种。 */
export type ProviderKind = "openai-compatible" | "anthropic";

export interface ProviderSpec {
  /** 稳定标识，存进 providers.type。 */
  readonly type: ProviderType;
  readonly label: string;
  readonly kind: ProviderKind;
  /** 缺省 baseURL；undefined = 必须由用户显式填。 */
  readonly defaultBaseURL?: string;
  readonly baseURLPlaceholder?: string;
  readonly apiKeyHint?: string;
  /** 内置模型目录 —— 用户没拉过模型列表时的兜底。 */
  readonly builtinModels: readonly ProviderModel[];
}
```

**`ProviderType` 收敛为 7 个**（只留能真正跑通的）：

| type | kind | defaultBaseURL |
|---|---|---|
| `openai` | openai-compatible | `https://api.openai.com/v1` |
| `anthropic` | anthropic | （SDK 默认） |
| `deepseek` | openai-compatible | `https://api.deepseek.com/v1` |
| `openrouter` | openai-compatible | `https://openrouter.ai/api/v1` |
| `moonshot` | openai-compatible | `https://api.moonshot.cn/v1` |
| `aihubmix` | openai-compatible | `https://aihubmix.com/v1` |
| `custom` | openai-compatible | 无（必填） |

删掉的 8 个里：`google` / `azure` 需要各自的 `@ai-sdk/*` 包与鉴权，**要支持就正经加**（catalog 加一条 + 一个 `ProviderKind` + 一个工厂，三处，有清单可循）；`copilot` / `acp` / `claude-subscription` / `zai-coding-plan` / `kimi-coding-plan` 是特殊鉴权流，从未实现——用户想接就用 `custom` + 自己的 baseURL。

**catalog 是唯一事实源**：`agent.ts`、provider 探活、provider seed、UI 文案全部查它，各自的 Set / Map / 常量表全删。

### 2.2 模型槽位

```ts
export type ModelSlot = "chat" | "tool" | "embedding";

// AppSettings
readonly models: {
  /** 主对话。必填。 */
  readonly chat: string;              // "providerId:modelId"
  /** 杂务档（compact 摘要 / web-fetch 摘要 / 未来子代理）；缺省回落 chat。 */
  readonly tool?: string;
  /** 记忆向量；缺省 = 语义检索禁用，记忆降级为纯 FTS（disabled, not crash）。 */
  readonly embedding?: string;
};
```

四个旧字段全部收进这里。embedding 从此**和其他模型一样住在 `providers` 表**。

### 2.3 统一解析入口

```
services/providers/model-resolver.ts
```

```ts
export interface ModelBinding {
  readonly slot: ModelSlot;
  readonly providerId: string;
  readonly providerType: ProviderType;
  readonly kind: ProviderKind;
  readonly qualifiedModelId: string;   // "providerId:modelId"
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export type ModelResolution =
  | { readonly ok: true; readonly binding: ModelBinding }
  | { readonly ok: false; readonly reason: string };

/** override 优先于 settings（用户在 UI 里临时换模型走这条）。 */
export const resolveModelSlot = (
  db: AppDatabase,
  slot: ModelSlot,
  override?: string
): ModelResolution => { /* ... */ };
```

**`temperature` 不进 `ModelBinding`** —— 它是 call setting，不是模型绑定的属性。`AgentFactory.createAgent` 从 settings 读一次塞进 `callSettings`。（现在 `ResolvedRuntimeModelBinding.temperature` 混在里面，导致"tool 模型的 temperature 写死 0.1"这种没人读的死值。）

### 2.4 文件切分

```
services/settings/
  app-settings.ts     loadAppSettings / replaceAppSettings / 默认值 / 块合并   (~200)
  model-id.ts         qualifyModelId / splitQualifiedModelId                  (~40)
  migrate-legacy.ts   一次性把旧 settings 结构迁到新结构                       (~110)
  index.ts            re-export
services/providers/
  provider-catalog.ts  ProviderSpec + PROVIDER_CATALOG + findProviderSpec      (~190)
  provider-repository.ts  CRUD + seed + 行解析                                 (~280)
  provider-http.ts     探活 / 拉模型（原 provider-runtime.ts），改查 catalog    (~280)
  model-resolver.ts    resolveModelSlot                                        (~120)
  index.ts             re-export
```

删除 `services/settings-store.ts`、`services/provider-runtime.ts`、`services/provider-models.ts`（后者的内容并进 `provider-http.ts`）。

---

## 3. 涉及文件

### 新增
`services/settings/{app-settings,model-id,migrate-legacy,index}.ts`
`services/providers/{provider-catalog,provider-repository,provider-http,model-resolver,index}.ts`
`apps/server/src/db/migrations/0017_provider_slots.sql`
`tests/provider-catalog.test.ts`、`tests/model-resolver.test.ts`、`tests/settings-migration.test.ts`

### 删除
`services/settings-store.ts`、`services/provider-runtime.ts`、`services/provider-models.ts`

### 修改
`packages/shared/src/index.ts`（`ProviderType` 收敛、`AppSettings` 瘦身 + `models` 块、`Provider` 去掉 UI 文案字段）
`apps/server/src/agent.ts`（删两个 Set、删 `resolveAgentRuntimeConfig`、`toAgentModel` 按 `kind` 分派）
`apps/server/src/services/agent-factory.ts`（`resolveModel` 走 `resolveModelSlot`）
`apps/server/src/db/schema.ts`（providers 瘦身 + `enabled` 改 integer）
`apps/server/src/routes/{settings,providers,models}.ts`
`apps/server/src/services/{memory-embedding,memory-recall,memory-runtime,compact,auto-compact}.ts`（import 路径 + embedding 走槽位）
`apps/server/src/deps.ts`（启动时调一次 `migrateLegacySettings`）
`apps/web/src/features/settings/components/general-settings.tsx` → **改名 `model-settings.tsx`**（三槽位选择器 + logLevel）
`apps/web/src/features/settings/components/{provider-settings,memory-settings/index}.tsx`（跟随契约）
`apps/web/src/features/settings/settings-page.tsx`（"General" → "Models"）
`tests/{agent-factory,agent-runtime,provider-routes,run-lifecycle}.test.ts`（import 路径 + settings 形状）

---

## 4. 步骤

> 这个任务改的是**契约**，一动就是一大片。所以先立 catalog（纯新增，不破坏任何东西），再改契约，最后收尾删旧文件。中间每步都要 typecheck 绿。

### Step 1 · 立 catalog（纯新增）

`services/providers/provider-catalog.ts`。把 `settings-store.ts:53-93` 的 `OPENAI_AVAILABLE_MODELS` / `ANTHROPIC_AVAILABLE_MODELS` 与 `SEED_PROVIDERS` 里的文案、`provider-runtime.ts:33-40` 的 `DEFAULT_BASE_URLS` 合并进来：

```ts
export const PROVIDER_CATALOG: readonly ProviderSpec[] = [
  {
    type: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    defaultBaseURL: "https://api.openai.com/v1",
    apiKeyHint: "sk-...",
    builtinModels: [ /* 搬 OPENAI_AVAILABLE_MODELS */ ]
  },
  {
    type: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    apiKeyHint: "sk-ant-...",
    builtinModels: [ /* 搬 ANTHROPIC_AVAILABLE_MODELS */ ]
  },
  { type: "deepseek", label: "DeepSeek", kind: "openai-compatible", defaultBaseURL: "https://api.deepseek.com/v1", builtinModels: [] },
  { type: "openrouter", label: "OpenRouter", kind: "openai-compatible", defaultBaseURL: "https://openrouter.ai/api/v1", builtinModels: [] },
  { type: "moonshot", label: "Moonshot", kind: "openai-compatible", defaultBaseURL: "https://api.moonshot.cn/v1", builtinModels: [] },
  { type: "aihubmix", label: "AiHubMix", kind: "openai-compatible", defaultBaseURL: "https://aihubmix.com/v1", builtinModels: [] },
  {
    type: "custom",
    label: "自定义（OpenAI 兼容）",
    kind: "openai-compatible",
    baseURLPlaceholder: "https://your-endpoint/v1",
    builtinModels: []
  }
] as const;

/** 未知 type（历史数据）返回 undefined —— 调用方按"不可用"处理，不要猜。 */
export const findProviderSpec = (type: string): ProviderSpec | undefined =>
  PROVIDER_CATALOG.find((spec) => spec.type === type);

/** provider 是否具备发起调用的最低条件（有 key，且 baseURL 可解析）。 */
export const resolveProviderBaseURL = (
  spec: ProviderSpec,
  configured: string | undefined
): string | undefined => configured?.trim() || spec.defaultBaseURL;
```

**【测试先行】`tests/provider-catalog.test.ts`**：每个 spec 的 `type` 唯一；`kind` 只能是两个值之一；`custom` 之外的每个 openai-compatible spec 都有 `defaultBaseURL`；`ProviderType` 联合类型的每个成员都能 `findProviderSpec` 命中（这条把类型与数据钉在一起，防止以后加了类型忘了加 spec）。

> 第 4 条断言的写法：
> ```ts
> const ALL_TYPES: readonly ProviderType[] = ["openai","anthropic","deepseek","openrouter","moonshot","aihubmix","custom"];
> // 若 ProviderType 加了成员而这个数组没加，下面这行会类型报错
> const _exhaustive: Record<ProviderType, true> = Object.fromEntries(ALL_TYPES.map((t) => [t, true])) as Record<ProviderType, true>;
> for (const type of ALL_TYPES) expect(findProviderSpec(type)).toBeDefined();
> ```

### Step 2 · 契约收敛（`packages/shared/src/index.ts`）

```ts
export type ProviderType =
  | "openai" | "anthropic" | "deepseek"
  | "openrouter" | "moonshot" | "aihubmix" | "custom";

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  models: readonly ProviderModel[];
  availableModels: readonly ProviderModel[];
  hasApiKey: boolean;
  baseURL?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
// 删除 apiVersion / description / icon / baseUrlPlaceholder / baseUrlHint / apiKeyHint
// —— 这些按 type 固定，前端查 catalog（见 Step 7 把 catalog 也暴露给前端）

export type ModelSlot = "chat" | "tool" | "embedding";

export interface ModelSlotSettings {
  readonly chat: string;
  readonly tool?: string;
  readonly embedding?: string;
}

export interface AppSettings {
  readonly models: ModelSlotSettings;
  readonly chat: {
    readonly temperature: number;
    readonly autoCompact: boolean;
    readonly autoCompactTokenThreshold: number;
    readonly autoCompactMessageThreshold: number;
  };
  readonly memory: {
    readonly enabled: boolean;
    readonly autoSummarize: boolean;
    readonly autoRetrieve: boolean;
    readonly queryRewriting: boolean;
    readonly maxRetrievedMemories: number;
    readonly similarityThreshold: number;
  };
  readonly security: {
    readonly logLevel: "error" | "warn" | "info" | "debug";
    readonly autoApproveToolRequests: boolean;
  };
}
```

删掉 `general` / `webSearch` 两个块与 14 个零行为字段（§1 D5）。`routes/settings.ts` 的 zod schema 同步缩小。

> `security.logLevel` 保留：`general-settings.tsx` 真的在编辑它。若最终确认它没有任何运行时效果（`pino` 用的是 `config.LOG_LEVEL`），把它一起删掉，并在 FINDINGS 里记一条。**先查清再决定，不要两边都留。**

### Step 3 · 数据迁移 `0017_provider_slots.sql`

```sql
-- 未知 provider type 归一成 custom（它们从未被 agent runtime 支持过）
UPDATE `providers`
SET `type` = 'custom'
WHERE `type` NOT IN ('openai','anthropic','deepseek','openrouter','moonshot','aihubmix','custom');
--> statement-breakpoint
-- enabled: text("true"/"false") → integer(0/1)
ALTER TABLE `providers` ADD COLUMN `enabled_flag` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `providers` SET `enabled_flag` = CASE WHEN `enabled` IN ('true','1') THEN 1 ELSE 0 END;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `enabled`;
--> statement-breakpoint
ALTER TABLE `providers` RENAME COLUMN `enabled_flag` TO `enabled`;
--> statement-breakpoint
-- UI 文案回归 provider-catalog.ts，不再逐行拷贝
ALTER TABLE `providers` DROP COLUMN `description`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `icon`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `base_url_placeholder`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `base_url_hint`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `api_key_hint`;
```

journal 追加 `{ "idx": 17, "version": "6", "when": <now-ms>, "tag": "0017_provider_slots", "breakpoints": true }`。

`db/schema.ts` 的 `providers` 表同步瘦身，`enabled: integer("enabled", { mode: "boolean" }).notNull().default(false)`。

> **注意**：`ALTER TABLE ... DROP COLUMN` 需要 SQLite ≥ 3.35。better-sqlite3 12 自带的版本满足。跑 `pnpm test` 时若报 "near DROP"，先 `node -e "console.log(require('better-sqlite3')(':memory:').prepare('select sqlite_version() v').get())"` 确认版本再报告。

### Step 4 · settings 一次性迁移

`services/settings/migrate-legacy.ts`：

```ts
/**
 * R2 T7 一次性迁移：把旧 settings 结构搬到 models 槽位。
 *
 * 旧结构里"哪个模型干哪件事"散在四处（chat.defaultModel / toolModel.model /
 * memory.toolModel / memory.embedding.model），且 embedding 的 provider 配置
 * 是绕开 providers 表的裸字段。这里搬一次，之后代码只认 settings.models。
 *
 * 迁移完成的标志：settings 表里存在 `models` 行。R3 可删本文件。
 */
export const migrateLegacySettings = (db: AppDatabase, logger: Logger): void => {
  // 1. 已有 models 行 → 已迁移过，直接返回
  // 2. 读旧 chat / toolModel / memory 三行的 JSON
  // 3. models.chat  = 旧 chat.defaultModel
  //    models.tool  = 旧 toolModel.model ?? 旧 memory.toolModel
  // 4. 旧 memory.embedding 三个字段齐全 → 在 providers 表建一条：
  //      { id: "embedding-migrated", name: "Embedding (migrated)", type: "custom",
  //        baseUrl, apiKey, enabled: true, models: [{ id: <model>, name: <model> }] }
  //    然后 models.embedding = "embedding-migrated:<model>"
  // 5. 写入 models 行；重写 chat / memory 行（去掉已搬走与零行为的字段）；删除
  //    toolModel / general / webSearch 行
  // 6. logger.info 报告搬了什么（迁移必须留痕，否则用户配置"莫名变了"）
};
```

在 `deps.ts` 的 db 初始化之后调用一次（和 T5 的 `migrateLegacyWorkRoot` 并列）。

**【测试先行】`tests/settings-migration.test.ts`**：
- 造一个含旧四字段的 settings 表 → 迁移后 `loadAppSettings().models` 三个槽位对得上；
- `memory.embedding` 齐全 → providers 表多出一条且 `models.embedding` 指向它；
- `memory.embedding` 不全 → 不建 provider，`models.embedding` 为 undefined；
- 迁移**幂等**：连跑两次结果一致、不重复建 provider。

### Step 5 · `provider-repository.ts` + `provider-http.ts`

- `provider-repository.ts`：搬 `settings-store.ts` 的 `ensureProvidersSeeded` / `listProviders` / `findProviderById` / `findStoredProviderById` / `createProvider` / `updateProvider` / `deleteProvider` / `parseProviderRow` / `normalizeProviderModel` / `parseModelList` / `normalizeProviderId` / `ensureUniqueProviderId` / `serializeModels`。
  - seed 改为**遍历 catalog** 生成（不再手写 `SEED_PROVIDERS`）：每个 spec 一条 disabled provider，`models = []`、`availableModels = spec.builtinModels`。
  - `parseProviderRow` 不再读已删除的 5 个列；UI 文案由前端查 catalog。
- `provider-http.ts`：搬 `provider-runtime.ts` + `provider-models.ts` 的内容。
  - 删掉 `DEFAULT_BASE_URLS` / `OPENAI_COMPATIBLE_TYPES` / `resolveProviderTransport` / google 与 azure 分支，全部改成 `findProviderSpec(provider.type)` 后按 `spec.kind` 二分。
  - `ProviderRuntimeError` 改名 `ProviderHttpError`（名字要说清它是 HTTP 层错误，不是"运行时"这种什么都能装的词）。

### Step 6 · `model-resolver.ts` + `agent.ts` 瘦身

`model-resolver.ts` 承接原 `agent.ts:resolveModelBinding` + `resolveAgentRuntimeConfig` 的解析逻辑，但按槽位组织：

```ts
export const resolveModelSlot = (db, slot, override?) => {
  const settings = loadAppSettings(db);
  const configured = override?.trim() || settings.models[slot];

  if (!configured) {
    return { ok: false, reason: `未配置 ${slot} 模型。` };
  }

  const ref = splitQualifiedModelId(qualifyModelId(configured, "openai"));
  if (!ref) return { ok: false, reason: `模型标识无法解析：${configured}` };

  const provider = findStoredProviderById(db, ref.providerId);
  if (!provider) return { ok: false, reason: `Provider "${ref.providerId}" 不存在。` };

  const spec = findProviderSpec(provider.type);
  if (!spec) return { ok: false, reason: `不支持的 provider 类型：${provider.type}` };
  if (!provider.enabled) return { ok: false, reason: `Provider "${provider.name}" 未启用。` };

  const apiKey = provider.apiKey.trim();
  if (!apiKey) return { ok: false, reason: `Provider "${provider.name}" 缺少 API key。` };

  const baseURL = resolveProviderBaseURL(spec, provider.baseURL);
  if (!baseURL && spec.kind !== "anthropic") {
    return { ok: false, reason: `Provider "${provider.name}" 需要 base URL。` };
  }

  // capabilities：先查用户勾选的 models，再查 availableModels，最后查 catalog 内置
  // ... 组装 ModelBinding
};
```

`agent.ts` 随之：
- 删 `OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES` / `ANTHROPIC_AGENT_PROVIDER_TYPES` / `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` / `isSupportedAgentProviderType` / `resolveModelBinding` / `ensureQualifiedModelId` / `resolveAgentRuntimeConfig` / `ResolvedRuntimeModelBinding` / `AgentRuntimeResolution`；
- `toAgentModel(binding: ModelBinding)` 按 `binding.kind` 分派；
- 只剩 `AgentUnavailableError` + `ConfiguredAgentOptions` + `createConfiguredAgent` + `toAgentModel` + `MEMORY_PROMPT_SECTION` —— 文件从 350 行降到 ~180 行。

`agent-factory.ts` 的 `resolveModel`：

```ts
resolveModel(options: { readonly requestedModelId?: string | undefined } = {}): ResolvedModels {
  const chat = resolveModelSlot(this.infra.db, "chat", options.requestedModelId);
  if (!chat.ok) throw new AgentUnavailableError(chat.reason);

  const tool = resolveModelSlot(this.infra.db, "tool");

  return {
    chat: chat.binding,
    // tool 槽位没配或不可用 → 回落 chat（不是错误：杂务用主模型只是贵一点）
    tool: tool.ok ? tool.binding : chat.binding
  };
}
```

`ResolvedModels.tool` 从 optional 变成必填（永远有回落）——`createConfiguredAgent` 里那一堆 `if (toolModel)` 判断随之删掉，web-fetch 工具从"有 toolModel 才注入"变成"总是注入"。**这修掉一个隐性行为**：现在没配 toolModel 时 web-fetch 工具静默消失。

**同步清除前缀猜测（D4b）**：`model-id.ts` 里的 `qualifyModelId` 删掉三条 `startsWith` 分支，
只保留"已含 `:` 则原样返回，否则拼 fallbackProviderId"。`resolveModelSlot` 里不再传 fallback ——
拿到不含 `:` 的引用直接 `ok: false, reason: "模型标识必须是 providerId:modelId 形式：<value>"`。

> 为什么不留 fallback：留了就等于"猜错了也能跑"，而猜错的表现是**静默用了另一个 provider 的 key 去打另一个端点**，
> 报错信息会指向完全无关的地方。宁可在入口拒绝。

**【测试先行】`tests/model-resolver.test.ts`**：三个槽位各自解析成功；chat 未配 → `ok:false` 且 reason 可读；provider 未启用 / 无 key / 未知 type 各一条；override 优先于 settings；capabilities 依次从 models → availableModels → catalog builtin 回落。

### Step 7 · embedding 走槽位

`memory-embedding.ts` 的 `resolveEmbeddingProvider` 删除，改为：

```ts
const embedding = resolveModelSlot(db, "embedding");

if (!embedding.ok) {
  // 记忆语义检索降级为纯 FTS —— disabled, not crash（docs 14 §11）
  logger.debug({ reason: embedding.reason }, "embedding 槽位不可用，语义检索已降级");
  return undefined;
}
```

`generateEmbedding` 的入参从自定义的 `ResolvedEmbeddingProvider` 换成 `ModelBinding`（它有 `baseURL` / `apiKey` / `modelId`，够用）。

> **embedding 维度**：`db/index.ts:EMBEDDING_DIMENSIONS = 1024`（BGE-M3）。换 embedding 模型如果维度不同，T0.2 的重建逻辑会 DROP 向量表并把 `ready` 打回 `pending`。这个行为是对的，但要在**换槽位时给用户提示**——`PUT /api/v1/settings` 检测到 `models.embedding` 变化时，日志 warn 一句"embedding 模型已更换，向量索引可能重建"。不做自动探测维度（超范围，记进 FINDINGS `[r3]`）。

### Step 8 · 前端跟随

1. **`general-settings.tsx` → `model-settings.tsx`**：三个槽位各一个模型下拉（复用 `shared/hooks/use-models.ts` 的 `ModelSummary` 列表）+ logLevel。三个槽位的说明文案要写清各自用途（chat = 主对话；tool = 摘要与杂务，选便宜的；embedding = 记忆检索，不配则只用关键词检索）。
2. **`settings-page.tsx`**：`{ id: "general", label: "General" }` → `{ id: "models", label: "Models" }`。
3. **`provider-settings.tsx`**：UI 文案（label / baseURL placeholder / apiKey hint）改为查 catalog。catalog 需要给前端 —— 加一个只读路由 `GET /api/v1/provider-catalog` 返回 `readonly ProviderSpec[]`（不含任何密钥，纯静态知识），前端 `useQuery(["provider-catalog"], { staleTime: Infinity })`。
4. **`memory-settings/index.tsx`**：删掉 embedding 的 baseUrl / apiKey / model 三个输入框（它们的位置已经在 Models tab）。
5. 所有 `saveSettings({...data, ...})` 跟随新 `AppSettings` 形状。

### Step 9 · 收尾

删除 `services/settings-store.ts`、`services/provider-runtime.ts`、`services/provider-models.ts`。更新 14 个 importer（§3 列表 + `grep -rln "settings-store\|provider-runtime\|provider-models"` 复核）。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；3 个新测试文件从 RED 到 GREEN
- [ ] `grep -rn "settings-store\|provider-runtime\|provider-models" apps tests` 无结果
- [ ] `grep -rn "defaultModel\|toolModel\|memory.embedding" apps packages` 只在 `migrate-legacy.ts` 里出现
- [ ] `grep -n "startsWith(\"claude\")\|startsWith(\"gpt\")" apps` 无结果（前缀猜测已删）
- [ ] `ProviderType` 的每个成员都能 `findProviderSpec` 命中（测试钉住）
- [ ] `agent.ts` < 200 行；新增的 9 个文件每个 < 300 行
- [ ] 手工：Settings → Models 里把 tool 槽位设成一个便宜模型 → 触发一次 compact → 日志显示摘要用的是 tool 槽位模型
- [ ] 手工：把 embedding 槽位指向一个 embedding provider → 存一条记忆 → `memory_embeddings` 表有行
- [ ] 手工：清空 embedding 槽位 → 记忆检索仍可用（纯 FTS），日志有 debug 说明降级，**不报错**
- [ ] 手工：升级前的库（含旧 settings + 一个 google 类型 provider）→ 启动后 provider 变 custom、settings 迁到 models、日志留痕

## 6. 坑

1. **`AppSettings` 是前后端共享契约**，字段一删前端就编译不过。改的顺序：先改 `packages/shared`，跑 `pnpm typecheck` 让编译器列出所有断点，再逐个修——不要靠 grep 找。
2. **迁移必须幂等**：`migrateLegacySettings` 与 `0017` SQL 都可能在开发机上跑多次（删库重来、多分支切换）。用"存在 `models` 行"作为已迁移标志，别用版本号。
3. **`enabled` 列类型变了**，drizzle 的 `mode: "boolean"` 会把 0/1 映射成 boolean，但**旧代码里所有 `provider.enabled === "true"` 的字符串比较都要改**。`grep -rn "enabled ===" apps` 全查一遍。
4. **别把 catalog 放进 `packages/shared`**：它含内置模型清单，会随 provider 变动；shared 只放类型（`ProviderType` / `ProviderSpec` 接口），数据留在 server，经 `GET /api/v1/provider-catalog` 给前端。
5. **`resolveModelSlot` 会被高频调用**（每 run 至少 2 次，每次都 `loadAppSettings` + 查 provider 行）。SQLite 本地读很快，先不缓存；如果 observer 显示它进了热点，再在 `AgentFactory` 层缓存（有 `invalidate()` 钩子可用）。**不要预先优化。**
