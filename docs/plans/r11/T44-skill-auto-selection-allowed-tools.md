# T44 · Skill auto-selection + allowed-tools（对齐 Alma）

> 前置：**T42**（skill 渐进披露契约）+ **T43**（`activeTools` / discovery mode）。读 `00-overview.md` §3。
> Alma 证据：`docs/architecture/19-alma-v2-tools-skills-sidecars.md` Part 2.1/2.3——frontmatter 统一为 `name / description / allowed-tools / [always-inject]`；`always-inject` 直注；**LLM AutoSkillSelection + thread 累积**；`buildSkillsContext(ids)` 只输出选中 skill 的 name+description；`allowed-tools` 并集（永远含 `Bash, Skill`）合并进 `activeTools`。

## 0. 对齐结论（先钉死）

Alma **不是**「确定性 selector + active-path 派生 + 小目录兜底」。对齐版必须改成：

1. **frontmatter 形状对齐且硬校验**：`name/description/allowed-tools` 三件套缺一即非法，`always-inject` 可选。**不做旧用户 skill 兼容**：缺 `allowed-tools`、list 形态非法、frontmatter 缺任一必填字段的 `SKILL.md` 一律不加载（loader skip + warn filePath），不留 `allowedTools = []` 默认归一这种技术债。
2. **选择器对齐**：用 **tool 槽位模型做 AutoSkillSelection**；确定性 text-rank 只作 tool 模型失败/输出非法时的 fallback，不是主路径。
3. **累积语义对齐**：选中的 skill 并入 **thread 累积集**。Eva 落 `session_skill_selections` 表——这是对「getter 而非字段」原则的有意例外：LLM 选择不可确定重放，靠历史重算既贵也不保证一致。
4. **注入格式对齐**：主 agent 的 `<available_skills>` 只列「always-inject ∪ thread 累积 ∪ 本轮新选」的 name+description；不做小目录全量兜底。
5. **allowed-tools 对齐**：选中 skill 的 `allowed-tools` 并集永远补 `bash` + `read_skill`（Alma 的 `Bash, Skill` 映射；Eva 另加 `tool_search` 保住 T43 发现入口），作为 `preferredToolNames` **合并进 active set**，不是替换全集：`<=40` 时全集本来就可用，不改变行为；`>40` 进 discovery mode 时并入首步 active（core ∪ preferred，仍受 40 上限）。调用方显式 `activeToolNames` 仍优先于 skill preferred。

## 1. 问题

T42/T43 落地后仍缺 Alma 的另一半，而且上一版 T44 草稿有几处不对齐：

- **选择器不对齐**：Alma 是 LLM AutoSkillSelection；确定性 ranker 只能做兜底，不能当主机制。
- **累积语义不对齐**：Alma 是 thread 累积集；active-path 重算在面对 LLM 选择时既重复付费又可能选出不同结果。
- **注入范围不对齐**：Alma `buildSkillsContext(ids)` 只列选中集；「skill 少就全列」会在 skill 增长到几十上百时留一条回潮口。
- **工具暴露不对齐**：`allowed-tools` 是 skill 作者声明的执行需求，合并进 activeTools 后属于显式选择；再用 >40 把它退回 discovery，等于让安全网否决 skill 契约。
- **兼容债不留**：`allowed-tools` 缺省归一成 `[]` 会让 skill 作者永远可以不写，frontmatter 契约名存实亡。Eva 直接硬校验，非法 skill 不进场。

## 2. 改动

### 2.1 frontmatter：`allowed-tools` 必填 + `always-inject` 可选

`packages/harness/src/skills/types.ts`：

```ts
export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  source: "bundled" | "project";
  allowedTools: string[];      // 必填(非法/缺失的 SKILL.md 根本进不到这里)
  alwaysInject: boolean;       // 缺省 false
}
export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools: string[];
  alwaysInject?: boolean;
}
```

`parser.ts` 不加 YAML 依赖，支持：

```yaml
allowed-tools: [Bash, Read]
# 或
allowed-tools:
  - Bash
  - Read
always-inject: true
```

规则：`name/description/allowed-tools` 任一缺失即 `parseSkillFile` 返回 `undefined`；`allowed-tools` 必须是 inline/block list 且每项非空，否则同样 `undefined`。loader 对 `undefined` 的 `SKILL.md` **skip + warn(filePath)**，不把 skill 加进 catalog，也不兜底成 `allowedTools: []`。

### 2.2 thread 累积集：落 `session_skill_selections`

新增 migration `apps/server/src/db/migrations/0026_session_skill_selections.sql`：

```sql
CREATE TABLE session_skill_selections (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'auto', -- auto | forced(预留; Eva 首版无渠道强制规则)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, skill_name)
);
CREATE INDEX idx_session_skill_selections_session ON session_skill_selections(session_id);
```

新增 `apps/server/src/db/repositories/session-skill-selection-repository.ts`：`listBySession(sessionId)` / `upsertMany(sessionId, names, origin)` / `deleteBySession(sessionId)`（删会话级联已兜底，接口留测试用）。

**为什么不按 getter 派生**：LLM AutoSkillSelection 不可确定重放；每轮重跑既多花一次 tool 模型调用，也可能因模型/上下文细微差别选出不同集合。Alma 的语义是「选中即并入 thread」，所以这里显式存累积集。

### 2.3 LLM AutoSkillSelection（tool 槽位），确定性只作 fallback

新增 `packages/harness/src/skills/auto-select.ts`：

```ts
export interface AutoSelectSkillsInput {
  readonly skills: readonly Skill[];              // 全量 metadata(name+description)
  readonly humanText: string;
  readonly alreadySelected?: readonly string[];   // thread 累积 + always-inject,提示模型别重复
  readonly maxNew?: number;                       // 默认 5,防一次塞爆
}
export interface AutoSelectSkillsResult {
  readonly selectedNames: string[];               // 已校验存在于 catalog
  readonly usedFallback: boolean;
}
```

- 主路径：`generateText`（tool 槽位模型）+ 固定指令：只返回 JSON array of skill names；无匹配返回 `[]`；不得返回不存在的名字。解析失败/非法名字 → 过滤；非法后为空则走 fallback。
- fallback：`search/text-rank.ts`（从 T43 `tool-search/search.ts` 抽出的共用切词/打分）对 `humanText` 做确定性选择，`usedFallback: true`。
- **选择失败绝不让聊天失败**：fallback 也为空 = 本轮无新选，继续用 always-inject ∪ 累积集。

`AgentFactory` 增加 public 方法（保持 `build` 同步签名不动）：

```ts
selectSkillsForRun(options: {
  modelId: string;
  humanText: string;
  alreadySelected?: readonly string[];
}): Promise<AutoSelectSkillsResult>
```

内部 `resolveModels({ modelId })` → `getModel(models.tool)` → 调 harness auto-select。复用现有 LanguageModel 缓存，不开第二条模型解析路径。

### 2.4 run 接线：always ∪ 累积 ∪ 新选

`apps/server/src/routes/runs.ts` 阶段①后、`agents.build` 前，新增 `apps/server/src/services/skills/select-run-skills.ts`：

1. `alwaysInject = infra.skills.filter(s => s.alwaysInject)`。
2. `stored = repo.listBySession(sessionId)`（origin auto/forced）。
3. `selected = await agents.selectSkillsForRun({ modelId, humanText, alreadySelected: names(always ∪ stored) })`。
4. `repo.upsertMany(sessionId, selected.selectedNames, "auto")`。
5. `selectedSkills = byName(always ∪ stored ∪ selected.selectedNames)`。
6. 传给 `agents.build({ ..., selectedSkills })`；`preferredToolNames = union(selectedSkills.allowedTools, ["bash", "read_skill", "tool_search"])` 传给 `agent.stream({ preferredToolNames })`（若调用方已显式传 `activeToolNames`，则调用方优先，不用 skill 覆盖）。

retry 模式同样走这条：`humanText` 是被重试 assistant 的父 user 文本；累积集已存在时选择器被告知 `alreadySelected`，通常返回空，成本可控。

### 2.5 prompt：只列选中集，不做小目录兜底

`AgentFactory.build({ selectedSkills })` 时，`skillsToPromptSection(selectedSkills)` 只输出这些 skill 的 name+description；`selectedSkills.length === 0` 时输出「本轮未选中 skill」，不列全量。未传 `selectedSkills` 的路径（测试/子代理）维持现状。

`allowed-tools` 不进 prompt（契约 §3.1）；它只进 activeTools。

### 2.6 与 T43 的边界

- T43 的 discovery mode 触发条件不变：**没有显式 `activeToolNames`** 且 catalog >40。
- skill 产出的是 `preferredToolNames`：`<=40` 不改变全集；`>40` 并入首步 active（core ∪ preferred，仍受 40 上限）。它不是调用方显式白名单，不会把无选中 skill 的 run 掐到只剩保底工具。
- `tool_search` 仍在保底集合里（见 §0.5），skill 没声明的工具仍可被搜索激活。

## 3. 涉及文件

新增：

- `apps/server/src/db/migrations/0026_session_skill_selections.sql`
- `apps/server/src/db/repositories/session-skill-selection-repository.ts`
- `packages/harness/src/skills/auto-select.ts`
- `packages/harness/src/search/text-rank.ts`（从 tool-search 抽出；fallback 用）
- `apps/server/src/services/skills/select-run-skills.ts`
- `tests/skill-auto-select.test.ts` / `tests/session-skill-selections.test.ts` / `tests/skill-parser-frontmatter.test.ts`

修改：

- `packages/harness/src/skills/{types,parser,loader}.ts` — `allowedTools/alwaysInject` 贯通；非法 `SKILL.md` skip + warn。
- `packages/harness/src/tools/tool-search/search.ts` — 改复用 `search/text-rank.ts`。
- `apps/server/src/services/agent-factory.ts` — `build({ selectedSkills })` + `selectSkillsForRun`。
- `apps/server/src/routes/runs.ts` — 接 `select-run-skills`，传 `selectedSkills` / `activeToolNames`。
- `packages/harness/src/skills/prompt.ts` — selected 为空时的「未选中」文案。
- `docs/plans/r11/00-overview.md` — 契约/任务卡/验收对齐。

## 4. 步骤（测试先行）

1. **RED-1（frontmatter）**：inline/block `allowed-tools` + `always-inject` 解析；缺 `allowed-tools` / list 形态非法 / 缺 `name|description` → `parseSkillFile` 为 `undefined`，loader 不加载且 warn 带 filePath。
2. **RED-2（累积集 repo）**：upsert 幂等（PK 去重）、listBySession、session 删除级联。
3. **RED-3（LLM selector）**：MockLanguageModel 返回 JSON array → 校验选中；返回不存在名 → 过滤；返回非 JSON → deterministic fallback 且 `usedFallback=true`；fallback 仍为空 → 不抛错。
4. **GREEN-1/2/3**：实现 §2.1-§2.3（含 text-rank 抽取，tool_search 原测试不回归）。
5. **RED-4（run 接线）**：构造两个 skill（一个 `always-inject`，一个会被 humanText 选中，声明 `allowed-tools: [mcp__x__y]`）——断言 `agents.build` 收到 selectedSkills 只含这两个；`agent.stream` 的 `activeToolNames` 含 `bash/read_skill/tool_search/mcp__x__y`；第二次同 session run 不再重复 upsert（PK），但仍在 selectedSkills 里。
6. **GREEN-4**：接 §2.4/§2.5，全绿。
7. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | frontmatter | `allowed-tools` inline/block + `always-inject` 正确解析；缺/非法 `allowed-tools` 的 `SKILL.md` 不加载（warn 带 filePath），无 `allowedTools: []` 兜底 |
| 2 | LLM 选中 skill | 选中名写入 `session_skill_selections`；下一轮同 session 仍在 selectedSkills（不再依赖当轮关键词） |
| 3 | `<available_skills>` | 只列 always ∪ 累积 ∪ 新选；无全量 metadata 兜底 |
| 4 | allowed-tools | selected skill 声明 `[mcp__x__y]` 时，`preferredToolNames` 含 `bash/read_skill/tool_search/mcp__x__y`；>40 时首步 active 并入 `mcp__x__y`，<=40 全集不受影响 |
| 5 | tool 模型失败 | deterministic fallback 接管；fallback 也失败时聊天照常，仅用 always ∪ 累积 |
| 6 | **移除实验**：把 `session_skill_selections` 读路径断开 | 用例 2 转红（第二轮丢失累积）；恢复全绿 |

## 6. 坑

1. **`allowed-tools` 硬必填，不留兼容口**：缺字段/形态非法的 `SKILL.md` skip + warn；不要加 `allowedTools = []` 归一，否则契约立刻腐化。
2. **累积表是正当例外，不是状态泛滥**：只存「LLM 选中结果」这一不可重放事实；always-inject 仍从 frontmatter 现算，不落表。
3. **选择失败不能炸聊天**：tool 模型解析失败 → fallback；fallback 空 → 本轮无新选。任何一步都不向路由抛错。
4. **skill allowed-tools 是 preferred，不是替换全集**：无选中 skill 时 fs/web/memory 等基础工具不能因为 `bash/read_skill/tool_search` 保底而缺席；>40 时 core ∪ preferred 仍受 40 上限。优先级只有一层：调用方显式 `activeToolNames` > T43 exposure（内含 preferred 合并）。
5. **Eva 首版不抄渠道规则**：Telegram 群聊强制注入、image-gen 清空技能是 Alma 渠道语义；Eva 无对应渠道，`origin='forced'` 只作预留。
6. **`allowed-tools` 不进 prompt**：它是工具暴露契约，不是给模型读的 metadata；prompt 仍只有 name+description。
