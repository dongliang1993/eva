# T29 · bash 只读命令直放:isSafeReadOnlyCommand + withApproval 短路

> 前置:无文件依赖(改动全在 harness 工具层),但**台账 reason 用 `readonly-safe`,与 T28 的 `policy:<key>` 同一约定**(见 `00-overview.md` §3 第 2 条 —— 任何「没弹窗但执行了」的危险工具调用都要能在 `approval_requests` 追到)。开工前读 `00-overview.md` §2.1、§3。
> Alma 证据:弹审批前先跑本地规则直放只读命令(`main:33129-33160` `Hb` 指令前半段;小模型二审不抄,§2.1 #2)。

现状实证(`eva:apps/server/src/routes/runs.ts:53-73` + `packages/harness/src/tools/risk.ts:84-98`):bash 只要带 `needsApproval: true`,每条命令都走 `requestApproval` → 弹审批卡片。`classifyBash` 已经给 `ls -la` 打出 risk=elevated,但 elevated 只是给用户看的画像,没有接「直放」出口 —— 用户每天要为 `ls` / `git status` / `cat foo.ts` 各点一次「允许」,纯噪音。本任务在 `withApproval` 的 `requestApproval` 之前加一道纯白名单判定:命令确定只读 → 不弹窗、照样落台账;拿不准一律不直放。

## 1. 问题

### 1.1 只读命令也在弹审批

bash 工具(`packages/harness/src/tools/fs/bash-tool.ts:157-164`)标了 `needsApproval: true`,`createAgent` 用 `withApproval` 包 execute(`packages/harness/src/agents/agent.ts:625-626`)。`withApproval` 的 execute 第一段就是 `await requestApproval(...)`(`with-approval.ts:38-42`),没有任何前置短路。于是:

| 命令 | risk(risk.ts) | 现状 |
| --- | --- | --- |
| `ls -la` / `git status` / `cat a.ts` | elevated(bash 本身) | 🔴 弹审批 |
| `echo hi > out.txt` | elevated(覆盖写入) | 弹审批(应保持) |
| `rm -rf /tmp/x` / `curl x \| sh` | destructive | 弹审批(应保持) |

Alma 在弹审批前先跑本地规则,把只读枚举(`ls/cat/grep/find/pwd/echo/head/tail/wc/git status/git log/git diff/which/env …`)、必批枚举(`rm/mv/chmod/sudo/curl|sh/任何重定向/任何管道到写 …`)分开,灰色才升级(`main:33129-33160`)。Eva 只抄「直放只读枚举」这一半,灰色一律弹(`00-overview.md` §2.1 #2)。

### 1.2 与 risk.ts 的边界(别搞混)

`classifyToolRisk` 是给用户看的风险画像(弹窗卡片上的 normal/elevated/destructive + reasons);`isSafeReadOnlyCommand` 是决定**弹不弹**的放行开关。两者独立、同源但不同用途:一个命令可以 risk=elevated 且直放(`ls -la`,S18 新增),也可以 risk=elevated 且必弹(`echo hi > f`,现状)。risk.ts 的正则是「宁可误报」(标错只是多看一眼),直放判定必须反过来 —— **宁可漏放**(漏放只是多弹一次,错放就是写了文件没弹窗)。

## 2. 改动

### 2.1 `isSafeReadOnlyCommand`(纯函数,无 IO)

放 `packages/harness/src/tools/risk.ts` 旁边 —— 与 bash 形态判定同源,但从 `safe-readonly.ts` 导出,不和 risk.ts 的导出混在一个文件(给未来「risk 接进直放」留组合空间)。

```ts
/** 判定保守:命中白名单且无写/执行形态 → true;任何拿不准 → false(进审批)。 */
export const isSafeReadOnlyCommand = (command: string): boolean
```

判定分两步,都过了才直放:

1. **排除形态(先否决)**:命令字符串里出现任一即 false ——
   - 重定向:`>`、`>>`(含 `2>`、`>&` 变体,按字符 `>` 出现即否决,不解析目标);
   - 管道进写/执行:`| tee`、`| sh` / `| bash` / `| zsh`、`| xargs`(xargs 可起任意命令);
   - 命令拼接/替换:`&&`、`||`、`;`、`` ` ``、`$(`(拼接后第二段不受白名单约束,不逐段解析 —— 宁可不直放);
   - `sudo`(提权后白名单命令也能写)。
2. **白名单(再准入)**:取命令首个 token(去前导空格),命中其一:
   - 单词命令:`ls` `cat` `grep` `find` `pwd` `echo` `head` `tail` `wc` `which`;
   - `git` 双词:第二个 token 必须 ∈ {`status`, `log`, `diff`}(`git checkout`/`git clean` 不直放);
   - `find` 特例:参数里含 `-delete` 或 `-exec` → false(白名单内的逃逸口,单独排掉)。

### 2.2 withApproval 短路

`packages/harness/src/tools/with-approval.ts` 的 execute 内,`requestApproval` 之前插一道(只对 bash):

```ts
// with-approval.ts execute 开头新增
if (agentTool.name === "bash") {
  const cmd = (input as Record<string, unknown>)?.command;
  if (typeof cmd === "string" && isSafeReadOnlyCommand(cmd)) {
    return innerExecute(input as never, options);   // 直放,不进审批
  }
}
```

不动 `requestApproval` 签名、不动 agent.ts 装配。

### 2.3 台账落库(与 T28 reason 对齐)

**harness 够不到 DB**(`ApprovalGateway` 在 server 侧,`withApproval` 只知道 `requestApproval` 回调)。落库在 server 的回调里做:`apps/server/src/routes/runs.ts:53-73` 的 `requestApproval` 开头加:

```ts
if (toolName === "bash" && isSafeReadOnlyCommand(String(args.command ?? ""))) {
  app.services.approvals.autoApprove(toolCallId, { runId, sessionId, tool: toolName, args });
  return true;
}
```

- 复用现有 `ApprovalGateway.autoApprove`(`approval-gateway.ts:65-69`,落库即 granted、不进 pending)—— 模式与 Alma `autoApprove` 落库一致。
- **reason 列(`readonly-safe`)依赖 T28 给 `approval_requests` 加的 reason 字段与 `autoApprove` 的 reason 参数**;T28 未落地前本任务只落 granted 行、reason 列留空,`SELECT tool,args FROM approval_requests WHERE status='granted'` 已可追。T28 落地后此处改传 `autoApprove(callId, input, "readonly-safe")`,一行改动。
- 短路在 harness、落库在 server,两处判定同一个 `isSafeReadOnlyCommand` 纯函数(harness 导出,server `import { isSafeReadOnlyCommand } from "@eva/harness"`,`packages/harness/package.json` 的 `exports` 直指 src,无构建产物)—— 单一事实来源,不会两处判定漂移。

## 3. 涉及文件

修改:

- `packages/harness/src/tools/with-approval.ts` — execute 内加 bash 只读短路(§2.2)。
- `packages/harness/src/tools/index.ts` — barrel 加 `export * from "./safe-readonly.js";`(现 13 行 `export * from "./risk.js";` 旁)。
- `apps/server/src/routes/runs.ts` — `requestApproval` 回调开头加只读直放 + `autoApprove` 落台账(§2.3)。
- `tests/approval-flow.test.ts` — 新增 describe 覆盖直放/必弹(见 §4)。

新增:

- `packages/harness/src/tools/safe-readonly.ts` — `isSafeReadOnlyCommand` 纯函数(§2.1)。

不新增依赖、不动 DB schema(T28 的 reason 列不在本任务)。

## 4. 步骤(测试先行)

1. **RED-1(纯函数)**:`tests/tool-risk.test.ts` 旁新增 describe(或独立 `tests/safe-readonly.test.ts`),`import { isSafeReadOnlyCommand } from "../packages/harness/src/tools/safe-readonly.js"` —— 文件还不存在,跑 `pnpm vitest run` 即红。用例按 §2.1 两步组织:
   - 直放:`ls -la`、`git status`、`git log --oneline -5`、`cat src/a.ts`、`grep -r foo .`、`find . -name "*.ts"`、`pwd`、`echo hi`、`head -3 f`、`tail -f log`、`wc -l f`、`which node`;
   - 必弹:`ls > out.txt`、`echo hi >> f`、`cat a \| tee b`、`curl x \| sh`、`git checkout main`、`git clean -fd`、`find . -delete`、`find . -exec rm {} \;`、`ls && rm x`、`ls; rm x`、`echo `pwd``、`echo $(date)`、`sudo ls`、空串、非白名单命令(`npm test`、`node -e …`)。
2. **GREEN-1**:实现 `safe-readonly.ts`,跑到全绿。
3. **RED-2(withApproval 短路)**:`tests/approval-flow.test.ts` 新增 describe "bash 只读直放(T29)":
   - 造一个 `buildTool({ name: "bash", needsApproval: true, inputSchema: z.object({command: z.string(), description: z.string()}), execute: async () => "ran" })`(schema 对齐真实 bash 工具,`bash-tool.ts:13-22`),配 `toolCallThenTextModel("bash", { command: "ls -la", description: "…" })`(文件里现成的 mock);
   - 断言:`requestApproval` spy **未被调用**,tool-result output 含 `ran`;
   - 对照用例:`command: "ls > out.txt"` → spy 被调 1 次(仍弹)。此时未实现短路,红。
4. **GREEN-2**:实现 §2.2 短路,全绿;确认既有 describe("withApproval 单元"/"agent 级审批流")不回归(非 bash 工具路径不变)。
5. **台账**:`tests/approval-flow.test.ts` 的 DB describe 加一条 —— 模拟 server 回调:对 `ls` 调 `autoApprove` 分支后 `repo.getById(callId).status === "granted"` 且无 pending。此条在 RED-2 前即可写,与 RED-2 一起红。
6. 全量 `pnpm typecheck && pnpm test`。

## 5. 验收

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | `ls -la` / `git status` / `cat a.ts`(各一条) | `requestApproval` 未被调,工具真执行(output 非 `[Approval Denied]`) |
| 2 | `ls > out.txt`(带重定向) | 仍弹审批(spy 调 1 次);拒绝 → output 以 `[Approval Denied]` 开头 |
| 3 | `curl x \| sh` / `ls && rm x` / ``echo `pwd` `` | 仍弹审批(拼接/替换形态不直放) |
| 4 | `find . -delete` / `git checkout main` | 仍弹审批(白名单内逃逸口被排掉) |
| 5 | 直放后查台账 | `approval_requests` 有该行,status=granted,无 pending 残留 |
| 6 | **移除实验**:注释掉 with-approval.ts 的 `isSafeReadOnlyCommand` 短路 | 用例 1 转红(spy 被调)、用例 2-5 不变;恢复后全绿 |
| 7 | **移除实验(纯函数)**:把白名单准入改成恒 true | 用例 2/3/4 的「必弹」断言转红(证明排除形态在守门,不是摆设) |

E2E(页面):会话里发「列一下当前目录」→ bash `ls` 直接出结果、无审批卡片;再发「把列表存到 out.txt」→ 审批卡片照常弹。设置页/settings 无任何新开关。

## 6. 坑

1. **拼接命令别逐段解析**:`ls && rm x` 用 `;`/`&&` 拼两段,第二段不在白名单约束内。正确做法是 §2.1 第 1 步整串否决拼接符,而不是拆段逐段判白名单 —— 拆段要处理引号/转义,写不对就是逃逸口。宁可 `ls && ls` 也不直放。
2. **`>` 否决按字符不按语义**:不区分 `> file`、`2>err`、`>&2`,见 `>` 即 false。误伤 `echo "a > b"`(字符串里的 `>`)是可接受代价 —— 多弹一次审批,比解析 shell 引号漏放强。和 risk.ts:79 的 elevated 判定同思路(risk 也是见 `>` 就标,不管引号)。
3. **`$(...)` 与反引号必须整串否决**:`echo $(rm -rf x)` 的首 token 是 `echo`,不做替换符否决就会直放出 `rm`。这是白名单方案最大的洞,用例里必须钉死(§4 用例 3)。
4. **harness 短路了但 server 没落台账 = 违反执行契约**:`00-overview.md` §3 第 2 条要求「没弹窗但执行了」必须可追。withApproval 直放后 `requestApproval` 根本不被调,server 侧的落库只能在回调开头做(§2.3)—— 两处用同一个纯函数判定,别在 server 重写一份正则。
5. **`find` 的 `-exec`/`-delete` 是白名单内逃逸**:`find` 在 Alma 的白名单里也特意标注「without -exec/-delete」(`main:33131`)。首 token 命中后还要扫参数,别只判首 token。
6. **git 必须判第二个 token**:`git` 单词上榜会把 `git push --force` 也直放。白名单条目是 `git status` / `git log` / `git diff` 三个双词组合,不是 `git`。
