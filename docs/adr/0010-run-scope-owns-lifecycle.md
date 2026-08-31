# 0010 生命周期资源必须由 Scope 管理

- **Status**: Accepted（形态与宪法原文有一处偏差，见下）
- **对应宪法条款**: C10

## 决策

具有一次 Run 生命周期的资源集中进入 `RunScope`：runId / sessionId、AbortController、
Run Hub、Run Recorder、failure layer、Plan Gate State、Report Gateway、清理函数集合。

释放要统一完成：取消 pending approval、释放 report gateway、注销 registry、关闭订阅者。

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
