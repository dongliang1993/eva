# T42 · Skill 元数据注入 / 正文按需加载加固

> 前置：无文件依赖。读 `00-overview.md` §3 第 1 条（Skill 注入只能是 metadata）。
> Alma 证据：`docs/architecture/19-alma-v2-tools-skills-sidecars.md` Part 1.3「Skill」+ Part 2.1「注入机制」——`<available_skills>` 只含 name/description，正文由 Skill 工具按需加载，且是 BLOCKING REQUIREMENT。

## 1. 问题

Eva 的 skill 链路已经接近 Alma：loader 解析 `SKILL.md` 成 `{ name, description, content, filePath }`，`skillsToPromptSection` 只把 `name + description` 写进 system prompt，`read_skill` 再按名取 `content`。缺口在契约不够硬：

- **prompt 文案太软**：现在是 “when needed / before proceeding”，不是 Alma 那种「命中就必须先读，否则不许回答」的阻塞式指令。模型可能凭 description 直接做，等于渐进披露失效。
- **`read_skill` 返回缺寻址契约**：只返回正文。Alma 的返回会带 `Skill Directory` 并要求「skill 里提到的文件一律用 skill 目录绝对路径读」（19 Part 1.3）。Eva 的 skill 正文一旦引用同目录脚本/模板，模型没有稳定规则去解析相对路径。
- **没有测试钉死「正文不进 prompt」**：`tests/skills.test.ts` 只断言 prompt 含 name/description，没断言不含 `content`。将来有人顺手把正文塞进 section，测试不会红。

## 2. 改动

### 2.1 prompt 文案改阻塞式

`packages/harness/src/skills/prompt.ts` 仍只输出 metadata，不输出 `content/filePath`。文案改成阻塞式：

- 命中某个 skill 时，**第一动作必须是 `read_skill`**；
- 在拿到正文前，不要回答该领域问题、不要执行该领域操作；
- 不要凭 skill 的 description 猜正文。

### 2.2 `read_skill` 返回带 file 寻址契约

`packages/harness/src/skills/read-skill-tool.ts` 命中时返回：

```text
# Skill: <name>

**Skill File:** <filePath>

IMPORTANT: Any relative file path mentioned by this skill is relative to `<dirname(filePath)>`. Read those files with absolute paths.

<skill.content>
```

未命中仍返回可用 skill 名列表。不新增截断：超长正文交给现有 tool-result budget / overflow 机制处理。

### 2.3 本卡不加 frontmatter 新语义

T42 不引入 `allowed-tools` / `always-inject`；只钉死「metadata 注入 + 正文按需加载」。`allowed-tools` 与 auto-selection 由 **T44** 单独立卡接入 activeTools 管线，避免把披露契约和工具暴露揉进同一次改动。

## 3. 涉及文件

修改：

- `packages/harness/src/skills/prompt.ts` — 阻塞式文案（仍只输出 metadata）。
- `packages/harness/src/skills/read-skill-tool.ts` — 返回契约加 `Skill File` + 相对路径解析说明。
- `tests/skills.test.ts` — 见 §4。

不动 loader/parser/types：`Skill.content` 仍是正文，`filePath` 已有，不需要加字段。

## 4. 步骤（测试先行）

1. **RED-1**：`tests/skills.test.ts` 给 `skillsToPromptSection` 加一个带「独特正文片段」的 skill，断言 section body 含 name/description、**不含该正文片段**、不含 filePath。红（若当前恰好不含有则可能直接绿，这时把断言保留作回归闸）。
2. **RED-2**：`createReadSkillTool` 的测试——调用后断言返回含 `# Skill: <name>`、`**Skill File:** <filePath>`、相对路径解析说明、完整正文。红（当前只返回正文）。
3. **GREEN**：实现 §2.1/§2.2，全绿。
4. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | system prompt 注入 skill | 只含 `name + description`；不含 `content` 片段；不含 `filePath` |
| 2 | 命中 skill 调 `read_skill` | 返回完整正文 + `Skill File` 路径 + 「相对路径按 skill 目录解析」说明 |
| 3 | 读不存在的 skill | 返回 `Skill "<name>" not found` + 可用列表 |
| 4 | prompt 文案 | 明确「命中必须先 `read_skill`，不要凭 description 猜正文」 |

## 6. 坑

1. **别把 filePath 注进 prompt**：filePath 只随 `read_skill` 返回。prompt 里放路径等于又多了一层 metadata，几百 skill 时照样膨胀。
2. **不要在 `read_skill` 里截断**：skill 正文是作者写给模型的操作手册，截断可能剪掉红线。大文件由通用 tool-result budget 兜底。
3. **文案要阻塞但不扩大**：只说「命中必须先读」，别说「每个任务都要先扫一遍所有 skill」——那会把渐进披露变成强制全读。
4. **相对路径规则只给规则，不自动拼**：`read_skill` 不去重写正文里的路径（改写作者文本风险大），只告诉模型解析基准是 `dirname(filePath)`。
