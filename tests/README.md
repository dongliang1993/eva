# tests/

目录结构**镜像被测代码**：`tests/<area>/<module>/` 对应 `packages/<area>/src/<module>/`
或 `apps/<area>/src/.../<module>/`。目的只有一个 —— 给定一个模块，不用 grep 就能列出它的测试；
给定一个测试，一眼看出它测谁。

## 新测试放哪

按被测代码的位置放，不按测试类型放：

| 被测代码 | 测试放这 |
|---|---|
| `packages/harness/src/agents/` | `tests/harness/agent/` |
| `packages/harness/src/tools/` | `tests/harness/tools/` |
| `packages/harness/src/context/` \| `skills/` \| `subagents/` \| `models/` \| `approval/` | 同名子目录 |
| `apps/server/src/services/<module>/` | `tests/server/<module>/` |
| `apps/web/src/features/<feature>/` | `tests/web/<feature>/` |
| `packages/shared/src/` | `tests/shared/` |
| `apps/desktop/electron/` | `tests/desktop/` |
| 跨多个路由的冒烟测试 | `tests/server/routes-smoke/` |
| 多个测试共用的桩与夹具 | `tests/helpers/` |

一个测试同时碰多个模块时，放在**它断言的那个模块**下，而不是它引用最多的那个。
例：`tests/server/runs/run-lifecycle.test.ts` 会用到 session、approval、ledger，
但它断言的是 Run 台账，所以在 `runs/`。

`plan-gate/` 与 `plan-weave/` **刻意是两个目录**：Plan Gate 是会话级审批闸门，
Plan Weave 是 workspace 级文件任务图，事实源不共享。合成一个 `plans/` 会让读者
把它们看成一个系统 —— 见 `docs/architecture/25-eva-simple-architecture-charter.md` §7.10。

## 为什么不按「单元 / 集成 / 契约」分桶

试过，不合身：

- **按速度分桶没有价值。** 实测整套 735 个用例跑完 **约 5 秒**，耗时大头是 vite collect
  (约 23 秒)而不是用例执行。「改一行纯函数不必等 SQLite 用例」这个问题在 Eva 上不存在 ——
  in-memory SQLite 本来就快。
- **`contract/` 与 `usecase/` 当前成员为零。** 仓库里还没有双实现 Port 契约测试，
  也没有 fake-port 用例测试。为将来的测试类型预建空目录，是宪法 §4.2 明令避免的
  「为了架构图好看，实际阅读要穿过大量目录」。真出现这类测试时再建。

## 数据库

一律用**真 SQLite**（`initDb({ dbPath: ":memory:" })` + `migrateDb`），不造 in-memory 假实现。
幂等、并发、级联删除、迁移这些语义只有真库能验证；假实现会让测试通过而线上出错。
只有模型走假实现（`MockLanguageModelV4`）—— 那是唯一真正需要 Port 的地方。

## 读源码的守卫测试

有几个测试用 `readFileSync` 断言「某个旧字段在源码里零命中」
（`always-allow-retire`、`duration-migration`、`run-observability`）。它们定位源码有两种写法：

- `path.join(process.cwd(), ...)` —— 搬目录安全（vitest 的 cwd 是仓库根）；
- `new URL("../../../<rel>", import.meta.url)` —— **搬目录必须同步改层数**。

这类断言路径写错时 `readFileSync` 抛 ENOENT，测试变红而不会静默通过，所以不会悄悄失效。
新写这类守卫测试时优先用 `process.cwd()`。

> 更好的做法是把纯粹的「源码里不许出现 X」搬进 `pnpm lint:arch`
> (`scripts/check-architecture.mjs`)，那里才是架构规则的家。现有这几个暂留 ——
> 它们同时还断言了真实行为，不是纯源码规则。
