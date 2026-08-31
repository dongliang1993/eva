# T23 · edit/write 的 mtime 快照校验(乐观写守卫)

> 前置:无(建议本轮第一个做)。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.2、§3、§4.1。
> 施工图:Claude Code 的写守卫模型 —— "mtime 快照比对 + old_string 仍唯一命中则放行"
> (v2.1.208 放宽),调研结论见 `00-overview.md` §1.1/§4.1。

**建议 1 个 commit**:`feat(harness)`。改动集中在 fs 工具层,无 server 参与。

---

## 1. 问题实证

### 1.1 丢更新的完整链路

SDK 侧(`node_modules/ai/dist/index.js`):`executeToolsFromStream` 在
`model-call-end` 时对 `toolCallsToExecute` 整体 `Promise.all`(:8165):

```js
case "model-call-end": {
  await Promise.all(
    toolCallsToExecute.map(async (toolCall) => {   ← 同一步的所有 tool call 并发进入
```

Eva 侧(`packages/harness/src/tools/fs/edit-tool.ts:31-42`):

```
31  const content = await fs.readFile(absolute, "utf-8");   ← 甲乙都读到 v0
32  const occurrences = content.split(before).length - 1;   ← 各自的 before 对 v0 都唯一命中,校验全过
41  const updated = content.replace(before, after);
42  await fs.writeFile(absolute, updated, "utf-8");         ← 甲写 v0+a,乙写 v0+b —— 甲的改动被抹
```

时间线:甲读 v0 → 乙读 v0 → 甲写 v0+a → 乙写 v0+b。乙的 writeFile 基于它
读到的 v0,甲的 edit **静默消失**,两个工具都返回成功文案
(`Edited <rel>: replaced 1 occurrence...`)。模型无从得知丢了一处。

`write-tool.ts:19` 的 overwrite 模式同构(`append` 模式靠 `O_APPEND` 原子性,
单次 append 不丢行 —— 但"read-modify-write 全文件重写"的 update_long_term
记忆工具在 `store.writeLongTermMemory` 内部同样裸写,见 §6 坑 5)。

### 1.2 为什么现有防线拦不住

| 防线                                                      | 为什么失效                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `before must match exactly once` 校验(edit-tool.ts:32-39) | 两个 edit 的 before 各自对 v0 唯一命中 —— 校验的是**各自读到的快照**,不是磁盘终态      |
| needsApproval 审批                                        | 闸门在 execute 外层,两个调用都过审后才并发进 execute                                   |
| bash 的 120s timeout                                      | 与正确性无关;bash 走 shell 子进程,不与 fs 工具共享进程内状态                           |
| 模型自觉                                                  | 模型对"同文件多处修改"的标准动作恰恰就是一步发多个 edit(这是并行 tool call 的设计意图) |

### 1.3 成熟实现的做法(Claude Code,调研还原)

1. 写前记录目标文件的 mtime 快照(read 阶段顺手取);
2. writeFile 前重新 stat,比对 mtime + size;
3. 不一致 → 拒绝:`*"File has been modified since read, either by the user or
by a linter"*`,模型重读重试;
4. **v2.1.208 放宽**:比对失败但替换文本仍唯一命中当前内容 → 放行
   (吸收"格式化工具改了行尾/无关行"的误伤)。

它不锁、不串行、不排队 —— 并发照旧,只拒"基于过期状态的写入"。
DeepAgents 反面印证:write_file 直接 O_TRUNC + StateBackend last-write-wins
reducer,无任何保护 —— 也就是 Eva 的现状。

---

## 2. 目标设计

### 2.1 快照来源:写前隐式 stat,不引入 read-state

Eva 没有 read-state(会话级"读过哪些文件"追踪,`00-overview.md` §2.1 #2
明确不做)。快照取自 **edit 工具自己 readFile 的那一刻**:

```
execute(path, before, after):
  stat ①: mtimeMs_1, size_1          ← 与 readFile 紧邻(先 stat 后读,见坑 3)
  content = readFile()
  ...校验 before 唯一命中...
  stat ②: mtimeMs_2, size_2          ← writeFile 前一刻
  if (mtimeMs_2 !== mtimeMs_1 || size_2 !== size_1):
      if (replace 在 content_当前 仍唯一命中)  → 放宽放行(重读后校验,见 2.2)
      else → return "[Tool Error] <rel> was modified since read ..."
  writeFile(replace(content, before, after))
```

**write 工具**(全文件覆盖,无"唯一命中"可言,也没有自己的 readFile):
基线取 execute 入口的 stat① —— 窗口语义变为"从本次 write 开始到落盘之间
无外部写"。覆盖写(`append: false`)时 mtime/size 变了就拒,**无放宽分支**
(覆盖写没有可重验的锚文本,唯一安全的动作就是让模型重读后重发);append
模式**不校验**(append 的语义是"追加到终态",不依赖读时状态,`O_APPEND`
原子性已保证)。

### 2.2 放宽逻辑的落点

Claude Code 的放宽是"old_string 仍唯一命中"。Eva 的 edit 结构里等价物就是
`before`:mtime 变了 → **重新 readFile 一次**,对新内容跑 occurrences 校验:

- 唯一命中 → 用**新内容**做 replace,正常写入(窗口极小,但语义正确);
- 不命中/多处命中 → 走既有的 "not found" / "appears N times" 报错文案
  (对模型来说和普通失败一样处理,天然引导重读)。

这样放宽不新增文案分支 —— 复用两条既有错误路径。

### 2.3 校验器:一个纯函数模块,edit/write 共用

`packages/harness/src/tools/fs/write-guard.ts`(新增,~40 行):

```ts
export interface FileSnapshot {
  readonly mtimeMs: number;
  readonly size: number;
}

/** stat 与 readFile 紧邻调用,窗口只覆盖"读文件"本身。 */
export const snapshotOf = (st: {
  mtimeMs: number;
  size: number;
}): FileSnapshot => ({
  mtimeMs: st.mtimeMs,
  size: st.size,
});

export const isStale = (a: FileSnapshot, b: FileSnapshot): boolean =>
  a.mtimeMs !== b.mtimeMs || a.size !== b.size;
```

mtimeMs + size 双因子:单 mtime 在某些 fs(粗粒度时间戳的 FUSE)上同窗口
漏检,size 补位;单 size 则"等长改写"漏检。两者皆非加密强度 —— 对手是
**并发工具调用与外部进程**,不是攻击者,足够。

### 2.4 错误文案

照 Eva 现有 `[Tool Error]` 前缀约定(edit-tool.ts 现有两处同款):

```
[Tool Error] <rel> was modified since it was read (by a concurrent tool call or
an external process). Re-read the file and retry your edit.
```

与 Claude Code 文案同义,补了 retry 指引(模型侧自愈路径)。

### 2.5 TOCTOU 残余(写明,不解决)

stat② 与 writeFile 之间仍有微窗口 —— 完全消除需要 `flock`/`O_EXCL` 级
原子协议,违背"无锁"的方案选型(§4.1)。残余风险:两个写在同一 stat② 后
同时落盘,仍可能后者覆盖前者。接受理由:窗口从"整个 execute 时长"
(read→校验→write,毫秒级)缩到"stat→write"(微秒级),且 v2.1.208 式放宽
已吸收大部分误拒。这是 Claude Code 同款取舍。

---

## 3. 涉及文件

### 修改

| 文件                                          | 动作                                                                |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `packages/harness/src/tools/fs/edit-tool.ts`  | execute 内嵌 stat①→读→校验→stat②→比对→(放宽重读)→写(44 行 → ~75 行) |
| `packages/harness/src/tools/fs/write-tool.ts` | overwrite 模式加同款校验(无放宽分支);append 不校验(28 行 → ~45 行)  |
| `tests/fs-tools.test.ts`                      | §4 新增用例(并发窗、外部改写、放宽放行、append 豁免)                |

### 新增

| 文件                                           | 动作                                            |
| ---------------------------------------------- | ----------------------------------------------- |
| `packages/harness/src/tools/fs/write-guard.ts` | `FileSnapshot` / `snapshotOf` / `isStale`(§2.3) |

---

## 4. 步骤

### Step 1 · 【测试先行】并发丢更新(RED)

`tests/fs-tools.test.ts` 新增 describe("write guard")。**并发必须真实重叠,
不许顺序 await** —— 用受控手法制造时间窗:

```ts
// 思路:直接对工具 execute 走两条 Promise.all 的调用,并在两次调用之间
// 用"外部 writeFile"模拟"另一个工具先写完了"(确定性,不依赖调度):
// 1. edit 甲读到 v0 后、写之前,外部把文件改成 v1(用注入的慢 fs 或直接
//    在甲的 before 里选一个只对 v0 唯一的文本);
// 2. 断言:甲返回 [Tool Error] ... modified since read;
// 3. 断言:磁盘上是 v1(外部写没有被甲抹掉)。
```

确定性制造窗口的办法(择一,测试内注释写明):

- **A(推荐)**:mock `node:fs/promises` 的 readFile/writeFile(vi.mock 或
  注入),让 edit 的 readFile resolve 后挂起一拍(`new Promise(r =>
setTimeout(r, 10))`)再 writeFile —— 期间主测试线程做外部写;
- B:不 mock,直接断言"外部写发生在甲 read 之前"的等价形态(外部写后
  甲的 stat① 拿到的就是新 mtime,校验点前移)—— 实现侧先做,作为不依赖
  时序的兜底用例。

### Step 2 · 【测试先行】其余四条(RED)

- 外部改文件(含等长改写:只动内容不动长度)→ edit 被拒 —— 钉住 size 因子;
- mtime 变了但 before 对新内容仍唯一命中 → 放宽放行,replace 基于新内容
  (断言写入结果包含外部改动 + 甲的替换);
- write(overwrite)在外部改后 → 拒;write(append)在外部改后 → **成功追加**
  (豁免钉住);
- 正常单线程 edit/write(无外部干扰)→ 全部照旧成功(既有用例回归)。

### Step 3 · 实现(GREEN)

按 §2.1–2.4:先 `write-guard.ts` 纯函数,再 edit、write 各自内嵌。既有
"edit replaces a unique occurrence"/"edit rejects a non-unique before"
用例必须保持绿(它们是无干扰路径)。

### Step 4 · 并发窗真并发用例(GREEN,加固)

Step 1 若用了方案 A(mock 慢 fs),补一条**无 mock 的真并发**:
两个 edit 的 execute 直接 `Promise.all`,选两个 before 使其对 v0 各自唯一
且互不重叠 —— 断言**至少一个**返回 modified-since-read 错误或 not-found
(不保证哪个赢,但**不允许两个都静默成功且文件只剩一个改动**)。这条是
"摘掉校验必红"的守门用例:实现里删掉 stat② 比对,它必须变红。

`pnpm typecheck && pnpm test` 全绿。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿;新增用例 RED→GREEN,既有 fs 用例不破
- [ ] 摘除实验:注释掉 stat② 比对(或 `isStale` 恒 false)→ Step 4 真并发用例变红
- [ ] 手工:让 agent 一步发两个同文件 edit(提示词"把 src/a.ts 里的 foo 全部
      改成 bar,同时把 baz 改成 qux")→ 其中一个报 modified-since-read,
      agent 重读后补上,终态两处都改
- [ ] 手工:外部在 agent 思考间隙用编辑器改文件 → agent 的下一次 edit 被拒并重读
- [ ] append 模式不受影响(`append_memory` 类路径回归)

## 6. 坑

1. **mtimeMs 在 macOS APFS 上是纳秒级,但某些 Linux fs 只有毫秒/秒级。**
   `isStale` 用 `!==` 严格比对 —— 同 mtime 同 size 的"同窗改写"在粗粒度 fs
   上漏检。这是接受的残余(§2.5),但**别**把比对放宽成 `Math.abs(...) <
N`(那会把真并发也放过)。size 因子就是为这条兜底的。
2. **bash 与 fs 工具的交叉写。** bash 里的 `sed -i` 改了文件,后续 edit 的
   stat① 会拿到新 mtime —— 校验天然放行(edit 读的就是改后内容)。**别**
   给 bash 也加守卫:shell 命令的读写全在一个子进程内,没有可插快照的点。
   校验只属于"跨 await 的 read-modify-write"结构。
3. **stat① 与 readFile 的顺序。** 必须**先 stat 再读**:反了的话,文件在
   stat 前被改、readFile 读到新内容,而 stat① 拿的是旧值 —— 放宽分支会误判
   "没变"。先 stat 后读,读到哪怕旧一点的内容,校验语义仍自洽(窗口含义
   = "从 stat 到 stat② 之间没有外部写")。
4. **放宽分支的重读要用同一份 handle 语义。** 重读后 replace 的输入是新
   content,但 `before` 参数不变 —— 若外部改动恰好撞掉了 before 的唯一性,
   走 "appears N times" 报错即可,**别**在放宽分支里递归再校验一次(会活锁)。
5. **update_long_term_memory 不在本轮。** 它的 read-modify-write 发生在
   **模型层**(read_memory_file 读全文 → 模型拼新全文 → writeLongTermMemory
   整体覆盖),跨两次工具调用,中间隔着一整圈模型推理 —— 两个 run 真要撞
   这个窗口,拒后写的也救不了先写的(内容都过时了)。且 MEMORY.md 每会话
   只有一个写入者(当前 run)。等有多 run 并发写记忆的实例再治理
   (00-overview §2.1 #3 同款边界)。
6. **测试里的 vi.mock fs 与 maybeOverflow 冲突。** edit/write 走
   `resolveWorkspacePath` + 真实 stat —— mock `node:fs/promises` 会连
   readFile 一起 mock 掉,注意只挂起目标方法、保留 stat 的真实行为,
   否则 overflow/_readableRoots 相关既有用例会被殃及(见 tests 里
   "read_file 能读回 readableRoots 里的溢出文件"那条)。
