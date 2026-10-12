# 0010 生命周期资源必须由 Scope 管理

- **Status**: Accepted（原则仍成立；`RunScope` 与 `RunFinalizer` 两个承载对象都已移除，见下）
- **对应宪法条款**: C10

## 决策

具有一次 Run 生命周期的资源集中进入 `RunScope`：runId / sessionId、AbortController、
Run Hub、Run Recorder、failure layer、Plan Gate State、Report Gateway、清理函数集合。

释放要统一完成：取消 pending approval、释放 report gateway、注销 registry、关闭订阅者。

## 今天的形态（2026-10-12）

原则不变：一次 Run 的资源集中持有、只有一条释放路径。承载它的对象换了：

- **持有**：`Coordinator.run` 里的 `ActiveRun`（runId / AbortController / hub / emit）与
  `RunProgress`（推进到哪一步、已有的 recorder）。两者的生命期都是 `run()` 这一次调用。
- **释放**：`run()` 的 `finally` —— `cancelByRun` + `runRegistry.unregister`（后者兜底关闭订阅者）。
  三条退出路径（成功、流式中失败、准备期失败）都经过它。

下面两节记的是落地之初的形态，留作历史。

## 与宪法原文的偏差（有意的）

C10 原文要求 `RunScope.dispose()` 幂等。落地时**资源释放归了 `RunFinalizer.release()`**，
`RunScope` 没有 `dispose`。理由：让 `RunScope` 也有一个 dispose 会立刻制造第二条清理路径 ——
而这一条存在的全部理由就是「终态与清理只有一个出口」。要补的幂等测试应针对 `release()`。

## 为什么

一次 Run 会持有 5–6 种需要收尾的东西。散着放的结果是「某条错误路径少收了一个」，
表现为孤儿进程、永远 pending 的审批、或者不再关闭的 SSE 连接。

## 代价

`RunScope` 是个"什么都有"的对象，读起来像 God Object。缓解：它只**持有**，不**决定** ——
所有顺序在 coordinator，所有释放在 finalizer。

## 怎么验证

`tests/server/runs/run-detach.test.ts`（断连 / abort / 重连）、
`tests/server/approvals/approval-abort.test.ts`（abort 收 pending）。
