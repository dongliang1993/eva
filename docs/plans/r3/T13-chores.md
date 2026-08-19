# T13 · 工程小修

> 前置：无。三件互不相关的小事，**各自一个 commit**。
> 开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。

---

## 1. C1 · `apps/web` 加 `typecheck` 脚本

### 问题实证

根命令是 `pnpm -r --if-present typecheck`，而 `apps/web/package.json` 只有 `dev` / `build` / `preview`
—— **整个前端从来没被 `pnpm typecheck` 检查过**。前端类型错误只会在 `pnpm web:build` 时暴露。

（`apps/desktop` / `packages/*` / `apps/server` 都有这个脚本，只有 web 漏了。）

### 动作

`apps/web/package.json` 的 scripts 加：

```json
"typecheck": "tsc -p tsconfig.json --noEmit"
```

### 验收

- [ ] `pnpm typecheck` 的输出里出现 `@eva/web typecheck: Done`（现在没有这一行）
- [ ] 当前代码下它是绿的（撰写本 spec 时手工验证过；若你跑出错误，那些错误是真的，修掉它们）

> **这是本轮第一个该做的事**：T11/T12 都要改前端，没有这道闸口就等于闭着眼睛改。

---

## 2. C2 · 全局 `ZodError → 400`

### 问题实证

`apps/server/src/app.ts` 没有 `setErrorHandler`，而路由里有 **14 处** `xxxSchema.parse(...)`
（`runs / providers / search / settings / threads / workspaces` 六个文件）。ZodError 冒泡到
Fastify 默认处理器 → **任何请求体不合法都返回 500**，而不是 400。

唯一的例外是 `routes/mcp-servers.ts`：R2 T9 在本路由内用 `safeParse` 手工绕开了这个缺口
（当时判断"改全局响应码超出 T9 范围"）。

### 目标设计

`app.ts` 加一个全局错误处理器，然后把 `mcp-servers.ts` 里那套手工 `safeParse` 收回成 `parse`
—— **一个概念只留一个实现**。

```ts
// apps/server/src/app.ts
import { ZodError } from "zod";

/**
 * 请求体/查询参数校验失败是客户端错误,不是服务端故障。
 * 没有这个 handler 的话 ZodError 会冒泡成 500,调用方看不出自己传错了什么。
 */
const firstZodIssue = (error: ZodError): string => {
  const issue = error.issues[0];

  if (!issue) {
    return "请求参数不合法";
  }

  return issue.path.length > 0
    ? `${issue.path.join(".")}: ${issue.message}`
    : issue.message;
};

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    reply.code(400).send({ error: firstZodIssue(error) });
    return;
  }

  request.log.error({ err: error }, "unhandled route error");
  reply.send(error);   // 交回 Fastify 默认处理(保留它对 HTTP 错误的语义)
});
```

### 动作

1. `app.ts` 加上面的 handler。
2. `routes/mcp-servers.ts`：`serverInputSchema.safeParse` / `enabledOnlySchema.safeParse` 改回
   `parse`，删掉本地的 `firstIssue` helper（它变成 `app.ts` 里的 `firstZodIssue`）。
   **保留** file-origin 那条"只能启停"的 400 —— 那是业务规则不是校验失败。
3. 复核其余 13 处 `parse` 无需改动（它们本来就期望抛）。

### 验收

- [ ] `curl -s -o /dev/null -w "%{http_code}" -X POST :8082/api/v1/mcp-servers -H 'Content-Type: application/json' -d '{}'` → **400**（不是 500）
- [ ] 响应体是 `{"error":"name: ..."}` 之类可读文案
- [ ] 同样验一条别的路由：`POST /api/v1/workspaces -d '{}'` → 400
- [ ] `grep -n "safeParse" apps/server/src/routes/` 无结果
- [ ] `pnpm test` 全绿（若有测试断言过 500，那个断言本来就是错的，改成 400 并在 commit 正文说明）

> **单独一个 commit**：它改的是既有路由的响应码。混进别的改动里，将来排查"什么时候开始返回 400 的"会很痛苦。

---

## 3. C3 · 修正 `docs/architecture/15` §1 的 4 行过期状态

### 问题实证

R2 T10 重算过这张进度表，但漏了 R1 时代那几行 —— 它们现在**声称已经修好的东西是坏的**。
这张表是"下一步做什么"的输入，错的比没有更糟。

逐条对照（每条都给了实证命令）：

| 表里现在写的 | 应该是 | 实证 |
|---|---|---|
| `S1 harness 迁 SDK · ⚙️ 主体完成` | ✅ 完成（R1 T2） | `lead-agent.ts` 用 `streamText({ stopWhen, prepareStep })`，无手写 step 循环；`grep -rn "@langchain" packages apps` 无结果 |
| `S1 SSE 协议 · ❌ 未对齐 · "仍是自定义 text_chunk / tool_call_start / …"` | ✅ 已对齐（R1） | `grep -oE '"(text-delta\|reasoning-delta\|tool-input-start\|tool-call\|tool-result\|step-start\|finish)"' packages/shared/src/stream-events.ts` |
| `S1.1 前端三红线 · ❌ 未达标` | ✅ 达标（R1 T3） | `shared/streaming/{delta-accumulator,use-smooth-stream}.ts`；`markdown.tsx` 的 `parseMarkdownIntoBlocks` + `memo`；`message-list.tsx` 的 `useVirtualizer` |
| `S2 存储+版本树 · ⚠️ 半 · "平铺表(role/content/searchText)，无 UIMessage parts、无 parent/slot/depth"` | ⚙️ 数据地基完成（R1 T1），**版本切换 UI 见 R3 T12** | `schema.ts` 的 `messages` 有 `message`(UIMessage JSON) / `parent_id` / `slot_id` / `depth`；`grep -rn "switch-version\|regenerate"` 零命中 |

### 动作

改 `docs/architecture/15-eva-execution-playbook.md` §1 这四行，并在表下的「改因」注里追加一句
说明本次校正的来源（R3 T13）。

顺带复核同一张表里其余行与 `00-overview.md` §1 的 backlog 一致（S3/S4/S5/S6/S7/S8/记忆/compact）。
**只改与代码不符的行，不要重写整篇。**

### 验收

- [ ] §1 表里每一行都能用一条 grep/ls 命令验证（把命令写进 commit 正文）
- [ ] §1 末尾的「结论」一句与表一致（现在写的是"完成 Phase A"，核对是否仍成立）
- [ ] `docs/architecture/15` §8 依赖图与 `r3/00-overview.md` §2 的顺序不矛盾（矛盾就改 15，r3 是更新的判断）

---

## 4. 三件事的顺序

`C1 → C3 → C2`：

- **C1 先做**，它是后面所有前端改动的闸口（一行改动，立刻收益）。
- **C3 其次**，它是纯文档、零风险，但它是"下一步做什么"的输入，早改早避免误导。
- **C2 最后**，它改既有响应码，需要单独 commit 且要跑一遍手工验证。
