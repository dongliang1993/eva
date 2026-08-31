# docs/

```text
current/    今天的代码长什么样 —— 唯一的"事实"入口
adr/        稳定决策:为什么这样定、放弃了什么、什么情况下该被推翻
plans/      在建的施工计划(任务编号只在这里出现)
archive/
  research/ Alma 竞品逆向研究 + Eva 早期设计快照(保留,不是阅读入口)
  plans/    已完成的施工轮次与架构改造总纲
```

## 从哪读起

| 你想干什么 | 读这个 |
|---|---|
| 第一次接触这个仓库 | [`current/architecture.md`](./current/architecture.md) |
| 改一次对话的服务端流程 | [`current/run-lifecycle.md`](./current/run-lifecycle.md) |
| 找某份状态的所有者 | [`current/data-ownership.md`](./current/data-ownership.md) |
| 想知道某条约束为什么存在 | [`adr/`](./adr/README.md) |
| 想知道 `T48` / `S27` 是什么 | [`archive/plans/`](./archive/plans/README.md) |

仓库根的 [`AGENTS.md`](../AGENTS.md) 是同一批事实的**操作向摘要**（给 AI 与新人的速查）。
两者冲突时以 `current/` 为准，并把 AGENTS.md 一起改掉 —— 不允许两份各自演化。
