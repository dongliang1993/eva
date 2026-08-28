# T54 · Overview 三泳道、检查器与导出

> 前置：T53（台账与投影）。读 `00-overview.md` §3 契约 1、10。
> 方案出处：设计文档 §9.2、§9.3、§9.4。

## 1. 问题

台账能回答「发生了什么」，回答不了「时间花在哪」和「当时模型看到的是什么」。这两个问题是整个切片的价值落点 —— 前面七卡都是为了它们。

## 2. 改动

### 2.1 三泳道 Overview

`trajectory/overview.tsx`：Input / Model / Tools 三条泳道，横轴时间。

- Model 泳道按 `model_ttft_ms` 与 `model_decoding_ms` 分段着色 —— 「等首 token」和「在吐字」是两回事。
- Tools 泳道把 `waiting_for_approval_ms`、`waiting_in_queue_ms`、`tool_exec_ms` 画成同一条上的三段，**不相加**。审批等 40 万 ms、执行 51 ms 的那次调用必须一眼看出来「慢在等人」。
- 相邻 Step 之间的 `orchestration_gap_ms` 显式留白，不要把间隙吞掉画成连续。
- 点泳道上任一段 → 台账滚到对应行并选中。

### 2.2 类型化右侧检查器

`trajectory/inspector/`，按行类型分面板：

| 行类型 | 面板内容 |
|---|---|
| System / Request | 调用当时的 system prompt、tool schemas、skill manifest、provider/model/settings，各部分带 hash |
| Assistant | 文本、reasoning、token 用量、三段模型时间 |
| Tool | 入参、输出、三段时间、审批决策（含 plan review 五分支）、`attempt` |
| Subtool | 子代理类型、description、结局，跳转到它自己的 Run |
| Compacted | 压缩前后 token、触发原因（`emitCompaction` 的三个 reason） |
| Error | `failure_layer` + 原始错误 |

**Tool 详情读的是调用当时的 snapshot，不是当前定义**（设计文档 §4.3）。工具定义会变、skill 会重选，用当前定义渲染历史调用等于伪造证据。`request_snapshot_ref` 指向同 Run 更早的 seq，检查器要顺着 ref 取回正文（ref 只在同 Run 内有效，跨 Run 不存在链）。

父子跳转：Subtool → 子 Run 视图 → 返回父 Run 并回到原来那行。

### 2.3 搜索

台账内文本搜索（工具名、参数片段、错误文本），命中行高亮 + 上下跳转。**只搜已加载页**，不做服务端全 Run 搜索 —— 那是设计文档 §10 第二阶段的事。搜索框要说清这一点，别让用户以为没命中就是没有。

### 2.4 Session log 下载

调 `GET /threads/:sessionId/session-log`（T52 §2.3）下载 JSONL。文件名带 session id 与导出时间。第一版不做 ZIP、不含媒体。

## 3. 验收

- 一次含长审批的 Run：Overview 上能直接看出慢在等人而不是工具本身；点那一段能跳到台账对应行。
- Step 间隙在 Overview 上有可见留白，不被画成连续。
- Tool 检查器显示的 tool schema 与「当前进程里的定义」不同时（手工改一个工具的描述再看历史 Run），显示的仍是历史那份。
- `request_snapshot_ref` 指向前面第 N 条的事件：检查器能取回完整正文，不显示空面板。
- Subtool → 子 Run → 返回：回到父 Run 时仍选中原来那行。
- 搜索命中高亮正确；未加载页不参与搜索且 UI 明示这个边界。
- 下载的 JSONL 能被 `jq` 逐行解析，排序与接口返回一致。
- 全程无凭据泄漏：默认设置下检查器面板里搜不到 `SECRET-TOKEN-123` / Bearer token / API key。

## 4. 实施备注

- 结构：`trajectory-view.tsx` = SessionTrajectory / RunTrajectory 双视图（子 Run 跳转时父视图 `hidden` 不卸载，选中行与滚动位置原样）;`Ledger` 组件双方复用（虚拟化 + prepend 稳定 + focusKey 跳转）。Overview 段点击、搜索命中、子 Run 返回都走同一个 `jumpToKey`。
- Overview 只有「真实 duration 比例」一种模式（卡面 §2.1 的三条：Model 分段、Tools 三段不相加、gap 留白 —— 真实比例天然满足留白）;§9.2 的等宽/压缩 idle/wall-clock 四模式留了数据口，没做切换器。
- Tool 检查器的「调用当时 snapshot」:`snapshot.ts` 在同 Run 内按 seq 找最近 snapshot、顺 `refSeq` 取正文；快照在未加载页时明示「继续上滚加载后可见」，不伪造。Tool schema 本卡展示的是 snapshot 里的 name+description 列表（zod schema 的 JSON 化没进 v1,§4.3 的 artifact_versions 才是终态）。
- 搜索只搜已加载页（`placeholder="搜索已加载页"` + title 明说）;JSONL 下载走 `withLoopbackToken` 直连 fetch(blob),不进 apiFetch 的 JSON 通道。
- 凭据泄漏那条验收由 T47 的写入期脱敏测试兜底（检查器渲染的就是落库 payload,SECRET/Bearer/sk- 在写入时已死）。

## 5. S27 收口备注（T47–T54 全绿时写）

- S27 切片全绿 = T47–T54 全绿 + `pnpm typecheck && pnpm test` 全绿（91 文件 / 731 测试）。
- 设计文档 §10(feedback/eval/版本比较/Replay/artifact_versions）不在本切片，未动。
