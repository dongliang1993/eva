# T5 · P0 修复：审批归属从 session 收敛到 run

> 前置：无。**先做这个**。
> 读之前先读 `00-overview.md` §3 与 `../r1/00-overview.md` §1 执行契约。
> 一次 commit，message：`fix(server): own tool approvals by run instead of session`

---

## 1. 问题实证

### 1.1 abort 不取消 pending 审批，run 吊死 5 分钟（P0.1）

`apps/server/src/services/run-registry.ts` 的签名把 sessionId 做成了**可选带默认值**：

```ts
register(runId: string, sessionId = ""): AbortController {
  const controller = new AbortController();
  this.runs.set(runId, { controller, sessionId });
  return controller;
}
```

而 `apps/server/src/routes/runs.ts` 唯一的调用点**没传第二个参数**：

```ts
const controller = app.services.runRegistry.register(runId);   // ← sessionId = ""
```

它不可能传：`sessionId` 是 `prepareRun()` 之后才知道的（新会话由服务端创建），而 `controller.signal` 在那之前就要拿到。于是 `abort()` 永远返回空串，两条清理路径都失效：

```ts
// 路径 A：SSE 断连
reply.raw.on("close", () => {
  if (!finished) {
    const abortedSessionId = app.services.runRegistry.abort(runId);   // → ""
    if (abortedSessionId) {                                          // ← 空串为假，不进
      app.services.approvals.cancelBySession(abortedSessionId);
    }
  }
});

// 路径 B：POST /runs/:runId/abort
const abortedSessionId = app.services.runRegistry.abort(runId);       // → ""
if (abortedSessionId === undefined) { ... }                           // ← "" !== undefined，往下走
app.services.approvals.cancelBySession(abortedSessionId);             // ← cancelBySession("")，匹配不到任何 pending
```

`finally` 里那句用闭包变量的 `cancelBySession(sessionId)` **写法是对的，但轮不到它执行**：agent loop 此刻正阻塞在 `withApproval` 的审批 promise 上（`streamText` 的 abortSignal 中止的是 HTTP 请求，不会 reject 已经在跑的 tool `execute`），`for await` 不退出，`finally` 不进。

**用户可见后果**：审批卡片弹出后点"停止"，界面卡住不动，直到 `ApprovalGateway` 的 `PENDING_TIMEOUT_MS`（5 分钟）超时兜底才收场。

### 1.2 审批列表跨会话串台（P0.2）

`apps/server/src/routes/approvals.ts`：

```ts
app.get("/api/v1/tool-approvals", async () => {
  const pending = app.services.approvals.listPending();   // ← 不传 sessionId = 全进程所有会话
  ...
});
```

`ApprovalGateway.listPending(sessionId?)` 支持过滤，路由没用。前端 `use-approvals.ts` 挂载时拉这个接口做"刷新恢复"，于是 A 会话刷新页面会弹出 B 会话的审批卡片，点允许还会真的放行 B 的工具。

### 1.3 为什么现有测试没挡住

`tests/approval-flow.test.ts` 6 项测的是两层：`withApproval` 的单元语义、`ApprovalGateway.cancelBySession` 的单元语义。**没有一条测试跑过"路由装配 + abort"这条线**——也就是 `register` 少传一个参数这类装配错误，在当前测试布局里是完全隐形的。T5 必须补上这一层。

---

## 2. 目标设计

**根因不是"少传了一个参数"，是归属搞错了。** 一次审批属于**一次 run**，不属于一个会话：

- run 有明确的开始与结束，审批的生命周期恰好嵌在里面；`runId` 在 handler 第一行就存在且永不改变。
- sessionId 是 run **执行过程中**才确定的（新会话由服务端创建）——把它当归属键，就必然存在一段"还不知道归属"的窗口，`sessionId = ""` 这个默认值就是为了糊住这个窗口才存在的。**默认值本身就是 bug 的载体。**
- docs 14 §5.1 也是这么定的：「子代理、审批、compact 都挂在 **run 边界**上」。

所以：

1. **`ApprovalGateway` 的取消键换成 `runId`**：`cancelByRun(runId)`。查询/展示仍按 sessionId（前端是按会话渲染的），所以 pending 条目同时记 `runId` 与 `sessionId`。
2. **`RunRegistry` 彻底不认识 session**：化简成 `runId → AbortController`。`register(runId)` 返回 controller，`abort(runId)` 返回 `boolean`。没有默认参数，就没有"空串归属"这一类 bug 的落脚点。
3. **`approval_requests` 表加 `run_id` 列**，落库时写上——台账要能回答"这次审批属于哪次执行"。
4. **`GET /api/v1/tool-approvals` 收 `?sessionId=`**，前端带上当前会话 id。

> 不做的事：不引入"审批超时可配置"、不动 `withApproval` 的包装法、不动 SSE 事件形状。本任务只改归属键与查询过滤。

---

## 3. 涉及文件

| 文件 | 动作 |
|---|---|
| `apps/server/src/db/migrations/0015_approval_run_owner.sql` | 新增 |
| `apps/server/src/db/migrations/meta/_journal.json` | 改：追加 idx 15 条目 |
| `apps/server/src/db/schema.ts` | 改：`approvalRequests` 加 `runId` 列 + 索引 |
| `apps/server/src/db/repositories/approval-repository.ts` | 改：`CreateApprovalInput` / `ApprovalRequestRow` 加 `runId` |
| `apps/server/src/services/approval-gateway.ts` | 改：`ask` 收 `runId`；`cancelBySession` → `cancelByRun`；`listPending` 返回带 `runId` |
| `apps/server/src/services/run-registry.ts` | 改：去掉 sessionId，`abort` 返回 boolean |
| `apps/server/src/routes/runs.ts` | 改：三处清理路径改调 `cancelByRun(runId)`；`requestApproval` 传 runId |
| `apps/server/src/routes/approvals.ts` | 改：GET 收 `?sessionId=` |
| `apps/web/src/features/threads/api.ts` | 改：`listApprovals(sessionId)` |
| `apps/web/src/features/threads/hooks/use-approvals.ts` | 改：收 sessionId，会话切换时重新对齐 |
| `apps/web/src/features/threads/chat-page.tsx` | 改：把 sessionId 传给 `useApprovals` |
| `tests/run-registry.test.ts` | 改：删掉 sessionId 相关断言 |
| `tests/approval-flow.test.ts` | 改：`cancelBySession` → `cancelByRun` |
| `tests/approval-abort.test.ts` | 新增：路由级回归（本任务的核心产出） |

---

## 4. 步骤

### Step 1 · 【测试先行】写一条会失败的路由级回归

新建 `tests/approval-abort.test.ts`。它要证明的事：**审批挂起时 abort，`ask()` 的 promise 立刻按拒绝 resolve**。

照 `tests/api-phase1.test.ts` 的 Fastify import 路径（workspace hoisting，见 `../r1/00-overview.md` §1.5）建一个最小 app，或者更轻——直接装配 `RunRegistry` + `ApprovalGateway` 并**照 `routes/runs.ts` 的写法**接线，跑一遍 abort：

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { RunRegistry } from "../apps/server/src/services/run-registry.js";

describe("abort 与 pending 审批", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("审批挂起时 abort → 审批立刻按拒绝返回,不等超时", async () => {
    const registry = new RunRegistry();
    const approvals = new ApprovalGateway(new ApprovalRepository(db));
    const runId = "run-1";

    registry.register(runId);
    // 会话是 run 跑起来之后才知道的 —— 这正是旧设计糊不住的地方
    const asked = approvals.ask("call-1", { runId, sessionId: "session-1", tool: "bash", args: {} });

    expect(registry.abort(runId)).toBe(true);
    approvals.cancelByRun(runId);

    await expect(asked).resolves.toBe(false);
    expect(new ApprovalRepository(db).getById("call-1")?.status).toBe("denied");
  });

  it("listPending 只返回指定会话的待审批", () => {
    const approvals = new ApprovalGateway(new ApprovalRepository(db));

    approvals.ask("call-a", { runId: "run-a", sessionId: "session-a", tool: "bash", args: {} });
    approvals.ask("call-b", { runId: "run-b", sessionId: "session-b", tool: "bash", args: {} });

    expect(approvals.listPending("session-a").map((p) => p.callId)).toEqual(["call-a"]);
    expect(approvals.listPending("session-b").map((p) => p.callId)).toEqual(["call-b"]);
  });
});
```

跑 `pnpm test tests/approval-abort.test.ts` —— 应该**编译就失败**（`cancelByRun` / `ask` 新签名都还不存在）。这就是 RED。

> 注意：`ask()` 返回的 promise 若一直不 resolve，vitest 进程会被 `PENDING_TIMEOUT_MS` 的 timer 挂住。第二条用例故意不 resolve 两个 ask，`afterEach` 的 `closeDb` 不管 timer——所以给 `ApprovalGateway` 的 timer 加 `unref()`（Node 环境下 `setTimeout` 返回的 `Timeout` 有此方法），或在用例末尾 `approvals.cancelByRun(...)` 收尾。选后者，改动更小。

### Step 2 · 迁移：`approval_requests` 加 `run_id`

新建 `apps/server/src/db/migrations/0015_approval_run_owner.sql`：

```sql
-- 审批归属从 session 收敛到 run(docs 14 §5.1「审批挂在 run 边界上」)。
-- session_id 保留:前端按会话渲染待审批列表,查询仍走它。
ALTER TABLE `approval_requests` ADD COLUMN `run_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_approval_requests_run` ON `approval_requests` (`run_id`);
```

在 `meta/_journal.json` 的 `entries` 末尾追加（`when` 用一个比 0014 的 `1786800000000` 大的整数；这个仓库的迁移是手写 SQL + 手写 journal，见 `../r1/00-overview.md` §1.5）：

```json
{
  "idx": 15,
  "version": "6",
  "when": 1786900000000,
  "tag": "0015_approval_run_owner",
  "breakpoints": true
}
```

`schema.ts` 的 `approvalRequests` 加列与索引：

```ts
runId: text("run_id"),
```
```ts
index("idx_approval_requests_run").on(table.runId),
```

> 旧行的 `run_id` 是 NULL —— 无所谓：pending 表是内存 Map 的投影，进程重启后没有任何 pending 需要恢复。

### Step 3 · repository 与 gateway 换归属键

`approval-repository.ts`：`ApprovalRequestRow` 与 `CreateApprovalInput` 各加 `readonly runId: string;`，`create()` 的 values 里写上，`getById()` 的映射里带出来。

`approval-gateway.ts` 三处改动：

```ts
interface PendingRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

/** 一次审批请求的归属与内容。 */
export interface ApprovalAskInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
}

export interface PendingApprovalView {
  readonly callId: string;
  readonly runId: string;
  readonly tool: string;
  readonly args: unknown;
}
```

```ts
/** 发起一次审批请求,返回解析为「是否允许」的 Promise。 */
ask(callId: string, input: ApprovalAskInput): Promise<boolean> {
  this.repo.create({ id: callId, ...input });

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      this.pending.delete(callId);
      this.repo.decide(callId, "denied");
      resolve(false);
    }, PENDING_TIMEOUT_MS);

    this.pending.set(callId, { ...input, resolve, timer });
  });
}

/**
 * 取消某次 run 下所有未决审批(abort / run 结束 / 进程收尾时调用)。
 * docs 14 §4.4:「abort / run 结束 / destroy 时 cancelAll 统一 reject(不会永远吊着)」。
 * 归属键是 runId 而不是 sessionId —— runId 在 run 的第一行就存在,
 * 不像 sessionId 有一段「还不知道」的窗口(那个窗口是 P0.1 的根因)。
 * @returns 被取消的数量
 */
cancelByRun(runId: string): number {
  let cancelled = 0;

  for (const [callId, entry] of [...this.pending]) {
    if (entry.runId !== runId) {
      continue;
    }
    clearTimeout(entry.timer);
    this.pending.delete(callId);
    this.repo.decide(callId, "denied");
    entry.resolve(false);
    cancelled += 1;
  }

  return cancelled;
}
```

`listPending(sessionId?)` 的返回项加上 `runId`（类型换成 `readonly PendingApprovalView[]`），过滤逻辑不变。

**`cancelBySession` 整个删掉**——不要留成 `cancelByRun` 的别名。留着就是留了第二条旁路（`00-overview.md` §3 第 1 条）。

### Step 4 · `RunRegistry` 化简

`run-registry.ts` 整个文件替换成：

```ts
/**
 * run 级 AbortController 注册表。
 *
 * 只做一件事:runId → controller。**不持有 sessionId** ——
 * 审批的归属键是 runId(见 ApprovalGateway.cancelByRun),
 * 让这个注册表知道会话只会诱惑调用方把它当归属源用。
 */
export class RunRegistry {
  private readonly runs = new Map<string, AbortController>();

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, controller);
    return controller;
  }

  /** @returns 是否真的中止了一次在飞的 run(未注册/已结束返回 false)。 */
  abort(runId: string): boolean {
    const controller = this.runs.get(runId);

    if (!controller) {
      return false;
    }

    controller.abort();
    return true;
  }

  /** 该 run 是否仍在飞(T8 的 deriveSessionStatus 会用)。 */
  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }
}
```

同步改 `tests/run-registry.test.ts`：
- `"abort trips the registered controller and returns the bound sessionId"` → 改成断言 `abort("run-1")` 返回 `true` 且 controller 被中止。
- `"abort returns undefined for unknown or finished runs"` → 改成 `toBe(false)`。
- 另两条不变。

### Step 5 · 路由接线

`routes/runs.ts`：

1. `requestApproval` 里的 `ask` 换新签名（`sessionId` 仍是闭包变量，此刻已赋值——审批只会在 stream 开始后才发生）：

```ts
const approved = await app.services.approvals.ask(toolCallId, {
  runId,
  sessionId,
  toolName,          // ← 注意 repo 字段名是 tool
  args
});
```
> 字段名对齐 `ApprovalAskInput`（`tool` 而不是 `toolName`），别让两边名字打架。

2. SSE 断连分支：

```ts
reply.raw.on("close", () => {
  if (!finished) {
    app.services.runRegistry.abort(runId);
    // 别让 pending 审批吊住 agent loop —— 归属键是 runId,不需要先知道会话
    app.services.approvals.cancelByRun(runId);
  }
});
```

3. `/abort` 路由：

```ts
app.post("/api/v1/runs/:runId/abort", async (request, reply) => {
  const { runId } = request.params as { runId: string };

  if (!app.services.runRegistry.abort(runId)) {
    reply.code(404);
    return { error: "run not found or already finished" };
  }

  // 中止时立刻拒绝该 run 下 pending 的审批,否则 agent loop 会被吊住
  app.services.approvals.cancelByRun(runId);

  return { ok: true };
});
```

4. `finally` 块：`if (sessionId)` 守卫连同 `cancelBySession` 一起换掉：

```ts
} finally {
  app.services.runRegistry.unregister(runId);
  // pending 审批要么已被决策、要么被上面 cancelByRun 清掉;这里兜底。
  app.services.approvals.cancelByRun(runId);
}
```

`routes/approvals.ts` 的 GET 加会话过滤：

```ts
app.get("/api/v1/tool-approvals", async (request) => {
  const { sessionId } = request.query as { sessionId?: string };
  const pending = app.services.approvals.listPending(sessionId);

  return {
    approvals: pending.map((p) => ({
      callId: p.callId,
      runId: p.runId,
      tool: p.tool,
      args: p.args
    }))
  };
});
```

> 不传 `sessionId` 仍返回全部——这是给运维/调试留的口子，不是前端会走的路径。文档注释里写清楚。

### Step 6 · 前端带上 sessionId

`features/threads/api.ts`：

```ts
export interface PendingApproval {
  readonly callId: string;
  readonly runId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** 拉取指定会话当前待审批的危险工具请求。 */
export const listApprovals = async (
  sessionId: string
): Promise<readonly PendingApproval[]> => {
  const data = await apiFetch<ListApprovalsResponse>(
    `/api/v1/tool-approvals?sessionId=${encodeURIComponent(sessionId)}`
  );
  return data.approvals;
};
```

`use-approvals.ts`：收 `sessionId: string | null`，effect 依赖它，null 时清空且不发请求。

```ts
export function useApprovals(
  sessionId: string | null,
  alwaysAllowEnabled?: () => Promise<void> | void
) {
  const [pending, setPending] = useState<readonly PendingApproval[]>([]);

  // 会话切换/刷新恢复时对齐一次(不轮询) —— 事实源仍是 SSE 事件。
  useEffect(() => {
    if (!sessionId) {
      setPending([]);
      return;
    }

    let stale = false;

    listApprovals(sessionId)
      .then((next) => {
        if (!stale) setPending(next);
      })
      .catch(() => {
        // 拉取失败静默:此前通过 SSE 建立的 pending 仍可用
      });

    return () => {
      stale = true;
    };
  }, [sessionId]);
  // ... 其余不变
}
```

`applyStreamEvent` 里 `approval_request` 分支补 `runId`。SSE 的 `RunApprovalRequestEvent` 目前不带 runId——**不要为此改 SSE 契约**：这一个 run 的事件流本来就属于当前 run，前端用 `useChat` 已经持有的 `runIdRef` 填即可。若嫌绕，`runId` 在前端类型里改成可选（`runId?: string`），只有从 REST 恢复的那批带值。选后者，改动最小且不撒谎。

`chat-page.tsx`：`useApprovals(sessionId, enableAutoApprove)`。注意 `sessionId` 来自 `useChat`，而 `useChat` 的 `onApproval` 又指向 `approvals.applyStreamEvent` —— 存在声明顺序的循环。解法：`useApprovals` 已经用 `useCallback` 稳定了 `applyStreamEvent`，把 `useChat` 的调用放在 `useApprovals` **之后**，`sessionId` 用 `useChat` 的返回值传不进去。所以改成：`useApprovals` 内部不取 sessionId，由 `chat-page` 用一个 `useEffect` 在 sessionId 变化时调 `approvals.refresh(sessionId)`。

> 二选一，实现时挑一个并在 commit 正文说明：
> **(a)** `useApprovals` 暴露 `refresh(sessionId)`，`chat-page` 用 effect 驱动（无循环依赖，多一个显式调用）。
> **(b)** `chat-page` 自己持有 sessionId state（`useChat` 的 `onRunStart` 已经回传），传给两个 hook。
> 推荐 **(a)**：`useChat` 是 sessionId 的唯一事实源，(b) 会复制一份。

### Step 7 · 跑绿

```bash
pnpm typecheck && pnpm test
```

Step 1 的两条新用例应该从 RED 变 GREEN；`run-registry.test.ts` / `approval-flow.test.ts` 的改动应全绿；其余 142 项不许因此变红。

---

## 5. 手工验收

需要一个可用的 provider（Settings 里配好）+ 一个工作区（T6 之前用 `.env.local` 的 `TARGET_REPO_ROOT`）。

1. 让 agent 写文件（"在工作区建 hello.txt"）→ 审批卡片弹出。
2. **卡片挂起时点"停止"** → 卡片立刻消失/变为已拒绝，流立刻结束，assistant 消息以 aborted 落库。**计时：应当是瞬间，不是 5 分钟。**
3. 再触发一次审批，卡片挂起时**直接关掉浏览器标签页**（触发 SSE 断连），服务端日志不应出现悬挂；重开页面无幽灵卡片。
4. 开两个标签页各自开一个会话，A 触发审批挂起，B 刷新 → **B 看不到 A 的卡片**。
5. 正常允许一次 → 工具真的执行，正文不重复。

---

## 6. 验收 Checklist（写进 commit 正文）

- [ ] `tests/approval-abort.test.ts` 两条用例先 RED 后 GREEN
- [ ] `pnpm typecheck && pnpm test` 全绿（原 142 项 + 新增）
- [ ] `grep -rn "cancelBySession" apps packages tests` 零命中（旧方法已删，不是留了别名）
- [ ] `grep -rn "sessionId" apps/server/src/services/run-registry.ts` 零命中
- [ ] `approval_requests` 表有 `run_id` 列，新审批落库时非空
- [ ] 手工验收 §5 五条逐条过，第 2 条计时是"瞬间"
- [ ] 未改动本文档 §3 涉及文件清单之外的文件
