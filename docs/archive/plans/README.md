# `docs/archive/plans/` —— 已完成的施工记录（已归档）

> **这里没有当前事实。** 今天的代码长什么样在 [`docs/current/`](../../current/)，
> 稳定决策在 [`docs/adr/`](../../adr/)。这个目录只回答一个问题：
> **「代码里那个 `T48` / `S27` 指的是什么」** —— 编号在这里，不该出现在别处
> （[ADR 0012](../../adr/0012-comments-explain-invariants.md)）。
>
> 各轮的方案写的是**当时的目标**，落地时常有偏差（偏差记在各轮自己的文档与总纲的 Wave 尾注里）。
> 与代码冲突时一律以代码和 `docs/current/` 为准。

## 架构改造总纲

- [`25-eva-simple-architecture-charter.md`](./25-eva-simple-architecture-charter.md) ——
  C1–C12 架构宪法、Run 五阶段、状态所有权、7.1–7.23 每模块改造、Wave 0–6 迁移计划。
  **Wave 0–6 已全部执行完（2026-08-30 ~ 08-31）**，每个 Wave 末尾有实测尾注与偏差记录。
  宪法十二条已各自落成 [`docs/adr/0001`–`0012`](../../adr/README.md)。

## 施工轮次（按时间倒序）

| 轮次 | 切片 | 内容 |
|---|---|---|
| `r13/` | S27 | Agent 轨迹 ledger 与会话内轨迹页（T47–T54）。方案：[`2026-08-26-agent-observability-design.md`](./2026-08-26-agent-observability-design.md) |
| `r12/` | S26 | Plan Gate 闸门 × 审批决策协议 × Plan Weave 任务图（T45a/T45b/T46） |
| `r11/` | S25 | 工具发现与 Skill 渐进披露加固（T42–T44） |
| `r10/` | S20 | `usage_records` 补全（T40–T41） |
| `r9/` | S19 | AutoCompact 步中压缩 + 工具数安全网（T36–T39） |
| `r8/` | — | 系统集成、安全加固、自更新、dev 引导（T32–T35） |
| `r7/` | S18 | 审批中心：policy key 单一事实源、bash 只读直放、决策回写（T27–T31） |
| `r6/` | — | 写守卫、并发帽、abort 语义（T23–T26） |
| `r5/` | — | 子代理审批、apiKey 加密、工具溢出治理、用量记录（T17–T22） |
| `r4/` | — | 第四轮 spec（T15–T16） |
| `r3/` | — | 第三轮（T11–T14） |
| `r2/` | — | 第二轮（T5–T10） |
| `r1/` | — | 第一轮重构（T0–T4）。`r1/FINDINGS.md` 是那段时间的流水账 |

## 早期设计文档

- [`2026-04-05-claude-code-style-compaction-design.md`](./2026-04-05-claude-code-style-compaction-design.md)
  —— 压缩策略设计，已实现于 `apps/server/src/modules/compact/`。**不要照此实现**，以代码为准。

Eva 更早的架构设计与 Alma 竞品研究在 [`../research/`](../research/)。
