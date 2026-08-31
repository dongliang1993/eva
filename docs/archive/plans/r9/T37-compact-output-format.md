# T37 · 压缩产出格式对齐 Alma（`<context_summary>` user 消息 + reminder + 六段摘要）

> 前置：无文件依赖，但**改动 `context-strategy.ts` 的 system 上提逻辑**——读 `00-overview.md` §3 第 3 条（user 角色别误上提）。
> Alma 证据：压缩产出 `<context_summary>` user 消息 + 「不要从头再来」system-reminder 双消息（16 §3.1-4）；摘要指令六段结构 Primary Request / Key Technical Concepts / Files and Code Sections / Errors and Fixes / Problem Solving / All User Messages（main:71821 `DO` 常量）。

## 1. 问题

Eva 的 compact 产出是一条 `Runtime summary:` 前缀的 **system 消息**（`runtime-compact.ts:13`），插在历史中间。问题：

- **角色不对**：Alma 用 **user 消息**装 `<context_summary>`——system 消息塞在历史中段，很多 OpenAI-compatible provider 不接受中途 system（Eva 现在的解法是把所有 system 上提到 instructions，`context-strategy.ts:56-62`），但上提后 summary 脱离了它压缩的那段历史的语境位置，模型对「这段摘要替代了哪段」的感知变弱。
- **缺「不要从头再来」reminder**：compact 后模型容易「重新开始任务」而不是「接着干」。Alma 补一条 system-reminder 明确「上下文被压缩过，接着 summary 继续，别从头再来」。
- **摘要结构松散**：Eva 现在的 `buildRuntimeSummary` 是逐条消息的扁平列表（`Runtime summary:\n- Tool X returned...`），信息密度低。Alma 的六段结构（Primary Request / Key Technical Concepts / Files and Code / Errors and Fixes / Problem Solving / All User Messages）是按「复现任务所需信息」组织的，召回质量更高。

## 2. 改动

### 2.1 产出 `<context_summary>` user 消息

`runtime-compact.ts` 的 `compactRuntimeMessages`（`:309`）产出的 summary 消息：

```ts
// 现在:SystemModelMessage,content 以 "Runtime summary:" 开头
// 改成:user 消息,content 包 <context_summary> XML
const summaryMessage: ModelMessage = {
  role: "user",
  content: `<context_summary>\n${buildSixPartSummary(compactedMessages, existingSummary)}\n</context_summary>`
};
```

**配套改动**：`isRuntimeSummaryMessage`（`:125`）的判定从「role=system 且 `Runtime summary:` 前缀」改成「role=user 且 content 以 `<context_summary>` 开头」——否则二次 compact 认不出上一次的 summary（会把旧 summary 当普通 user 消息再压缩一遍）。

### 2.2 六段摘要结构

`buildRuntimeSummary`（`:201`）重写为六段。从 compactedMessages 抽取：

```
<context_summary>
## Primary Request      — 首条 user 消息(任务本源)
## Key Technical Concepts — assistant 文本里出现的技术名词/框架(去重)
## Files and Code       — tool-call/result 里涉及的文件路径 + 关键操作
## Errors and Fixes     — status=error 的 tool result + 后续 assistant 的修正
## Problem Solving      — assistant 的推理/决策要点
## All User Messages    — 所有 user 消息原文(用户意图不能丢)
</context_summary>
```

各段从现有 `summarizeMessage` 的原料重组——不新增 LLM 调用（Eva 的 compact 是**本地规则摘要**，不是 Alma 的次级 LLM 摘要；本任务只对齐**结构**，不引入 LLM 摘要成本）。

### 2.3 「不要从头再来」system-reminder

`<context_summary>` user 消息之后追加一条 system 消息：

```ts
const reminderMessage: SystemModelMessage = {
  role: "system",
  content: "Context was compacted. The <context_summary> above replaces earlier messages. Continue from where the task left off — do NOT start over."
};
```

这条 system 会被 `context-strategy.ts` 上提到 instructions（现逻辑），位置合理。

### 2.4 context-strategy 上提逻辑适配

`context-strategy.ts:56-62` 现在把所有 `role === "system"` 上提、其余留 messages。`<context_summary>` 改成 user 后**会留在 messages**（不被上提）——这正是目标（summary 留在历史原位）。reminder 是 system 会被上提，正确。**逻辑不用改**，但要加测试钉死「`<context_summary>` user 消息不被上提、留在 messages」。

## 3. 涉及文件

修改：

- `packages/harness/src/context/runtime-compact.ts` — summary 消息改 user + `<context_summary>` 包裹 + 六段结构 + reminder 消息；`isRuntimeSummaryMessage` 判定改 user + `<context_summary>` 前缀。
- `packages/harness/src/context/runtime-compact.test.ts`（或对应测试文件）— 既有断言全要跟着改（角色 + 前缀 + 结构）。

新增：

- 无新文件。测试用例加在现有 compact 测试里。

不动 `context-strategy.ts` 主逻辑（只加一条「user summary 不上提」的钉线测试）、不动 agent.ts。

## 4. 步骤（测试先行）

1. **RED-1（角色 + 前缀）**：改既有 compact 测试的断言——compact 后 messages 里应出现 `role=user` 且 content 以 `<context_summary>` 开头的消息。现状是 system + `Runtime summary:`，红。
2. **GREEN-1**：实现 §2.1，全绿。
3. **RED-2（二次 compact 识别）**：写一个用例——先 compact 一次产出 `<context_summary>`，再 compact 第二次，断言旧 summary 被识别并融入新 summary（`isRuntimeSummaryMessage` 命中），不被当普通 user 消息重复压缩。红（旧判定认不出新格式）。
4. **GREEN-2**：改 `isRuntimeSummaryMessage`，全绿。
5. **RED-3（六段结构 + reminder）**：断言 `<context_summary>` 内含六个 `##` 段标题；summary 后跟一条含「do NOT start over」的 system 消息。红。
6. **GREEN-3**：实现 §2.2/§2.3，全绿。
7. **上提钉线**：context-strategy 测试加一条——compact 后 `<context_summary>`（user）留在 messages，reminder（system）上提到 instructions。
8. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
|---|---|---|
| 1 | 触发 compact | messages 出现 `role=user` + `<context_summary>` 前缀 |
| 2 | compact 后 | `<context_summary>` 内含六段 `##` 标题 |
| 3 | compact 后 | summary 后有「do NOT start over」system reminder |
| 4 | 二次 compact | 旧 `<context_summary>` 被识别融入，不重复压缩 |
| 5 | prepareStep 上提 | `<context_summary>`（user）留 messages，reminder（system）上提 instructions |
| 6 | **移除实验**：isRuntimeSummaryMessage 改回认 system | 用例 4 转红（二次 compact 重复压缩）；恢复全绿 |

E2E：构造超 context 的多步任务触发 compact，observer 的 compact 事件后，发给模型的 messages 里能看到 `<context_summary>` user 消息，且模型接着任务继续（不重新自我介绍/不重读已读文件）。

## 6. 坑

1. **二次 compact 识别是最大的坑**：改了产出格式（system→user），`isRuntimeSummaryMessage` 必须同步改，否则第二次 compact 把旧 summary 当普通 user 消息再压一遍，summary 无限套娃。用例 4 必须钉死。
2. **别引入 LLM 摘要**：Eva 的 compact 是本地规则（无 LLM 调用、零延迟零成本）。本任务只对齐**产出结构**，不要把六段做成「起次级 LLM 生成」——那是另一个量级的改动，且 Alma 的六段是 LLM prompt 而 Eva 用规则拼装，结构对齐即可。
3. **user 角色别被上提**：`context-strategy.ts` 上提所有 system。`<context_summary>` 是 user，天然留 messages——但要加测试防止有人以后把它「优化」成 system 又被上提。
4. **`All User Messages` 段别丢**：用户原始意图是 compact 后最不能丢的信息（丢了模型就跑偏任务）。这段保留所有 user 消息原文，不做摘要截断（或只做极宽松截断）。
