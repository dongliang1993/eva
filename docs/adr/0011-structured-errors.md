# 0011 错误必须结构化

- **Status**: Accepted（`layer` 已落地为 `runs.failure_layer`；完整 `EvaFailure` 尚未铺满全仓）
- **对应宪法条款**: C11

## 决策

跨层错误至少携带：

```ts
interface EvaFailure {
  code: string;
  layer: "routing" | "context" | "model" | "tool" | "persistence" | "orchestration" | "transport";
  operation: string;
  retryable: boolean;
  userMessage: string;
  cause?: unknown;
}
```

用户看 `userMessage`，HTTP adapter 按 `code` 映射状态码，调试台账记 `layer/operation/cause`。
**禁止通过匹配错误字符串决定业务行为。**

## 今天到哪一步

- Run 失败已经有归因：流式开始前的失败落 `runs.failure_layer`（`routing` / `context`），
  流式之后的归因走 `run_events`，不在 catch 里猜。
- HTTP 映射走的是**类型判断**而不是字符串：`SessionBusyError` → 409、
  `AgentUnavailableError` → 503、其他 → 400。
- 全仓统一的 `EvaFailure` 形状还没铺完 —— 这一条是 Accepted 的方向，不是"已完成"的现状。

## 为什么

字符串匹配是最脆的耦合：改一句文案就改了行为，而且没有任何测试会红。

## 代价

抛错的地方要多写几个字段。对新增的跨层错误按上面的形状写；已有的 `Error` 子类
在真正需要跨层判断时再收敛，不做一次性大扫除。

## 怎么验证

`tests/server/runs/run-lifecycle.test.ts` 里的 503 / 回滚用例；
`grep` 不到 `error.message.includes(...)` 这类分支。
