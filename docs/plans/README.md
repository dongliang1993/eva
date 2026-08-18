# docs/plans

## 在用
- `r2/` —— 当前一轮 spec（T5–T10）。入口：[`r2/00-overview.md`](./r2/00-overview.md)

## 已完成（保留作施工记录）
- `r1/` —— 第一轮重构（T0–T4），已全部合并（`0350f30`..`689ac33`）。
  `r1/FINDINGS.md` 是**持续累积**的流水账，R2 期间继续往里写。

## 历史（决策记录，不再更新，勿照此实现）
- `s1/s1-wrapup-technical-design.md` —— LangChain → AI SDK 迁移设计，已完成
- `2026-04-05-claude-code-style-compaction-design.md` —— 压缩策略设计，已实现于 `services/compact.ts`
- `s4-tools-approval.md` —— 审批闸门初版设计，**已被 `r1/T0-p0-fixes.md` §T0.4 取代**
