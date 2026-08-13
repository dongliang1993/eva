# 07 · 你提的 5 个方面之外，还值得研究的方向

> 注：本篇切片号沿用 06 的 M 体系（M1–M6），落地时统一为 S 体系，对照见 11 §0（M1=S1 / M3=S4 / M5→S5+ S12 等）。

你列的 5 项（前后端/桌面端、DB+API、Electron、模型适配+agent harness、memory）已经覆盖主干。下面是 Alma 实际做了、且对"个人 agent 产品"成败影响很大、但容易被忽略的 **12 个补充方向**。按我认为的学习价值排序：

## 🔥 强烈建议补进学习计划

### 1. Skill / MCP / 插件 三层扩展机制（04 篇已含，但值得单独练）
Alma 的能力扩展不靠改代码，靠三种机制叠加：
- **Skill**：一个 `SKILL.md`（Markdown 手册），prompt 里只放名字+简介（渐进披露，省 token），agent 需要时读全文
- **MCP**：标准协议接外部工具服务器（`@modelcontextprotocol/sdk`，`mcp.json` 配置）
- **插件**：带 UI 的扩展（plugins/ 目录，能注册工具和前端组件）

> 为什么重要：这是 "agent 应用" 和 "聊天套壳" 的分水岭。复刻时把 Skill 机制做掉（S5 切片），你的 app 就有了无限生长能力。

### 2. 上下文工程（Context Engineering）
- system prompt 的动态组装顺序（人格→日期→用户画像→检索记忆→技能清单→工具说明）
- 上下文压缩：对话太长时的 compact/summarize 策略（bundle 里有 compact 逻辑痕迹）
- 工具结果溢出处理：`tool-overflow/` 目录——大输出落盘、prompt 里只放摘要+读取指引
> 为什么重要：长对话不炸、agent 不"失忆"，全靠这层。

### 3. 流式协议与 UI 增量渲染
WS delta 事件类型设计（文本/思考块/工具调用/权限请求/完成），前端如何做到打字机效果还不卡（react-virtual 虚拟滚动 + 增量 markdown）。
> 为什么重要：这是用户感知"这个 agent 好快好流畅"的直接来源。（03 + 01 篇）

### 4. 权限与安全模型
危险工具（Bash/写文件）的人类审批流；Electron 侧 contextIsolation/sandbox/CSP；API 是否只绑 localhost。
> 为什么重要：agent 能操作你整台电脑，没有审批层就是灾难。复刻 S4 切片就要带上。

## ⭐ 进阶（做完 MVP 后回头看）

### 5. 定时任务与主动行为（05 篇）
Cron 调度 + HEARTBEAT 心跳：agent 不被动等消息，而是定时醒来检查清单、主动找你。这是"助手感"→"伙伴感"的跳跃。

### 6. 情感/疲劳状态系统（05 篇）
`fatigue.json` + 情绪状态机，状态会写进 prompt 影响语气。纯花活？不——它是人格一致性的关键技术。

### 7. Activity Recorder 情境感知（05 篇）
截屏 + OCR + 会话切分 + 语义搜索，让 agent 知道"你刚才在干嘛"。隐私敏感但能力极强，研究它的本地化处理和隐私边界设计。

### 8. 多通道接入（05 篇）
Telegram/Discord/飞书 bot 全部汇入同一条消息管线。一个 agent，到处都在。

### 9. CLI 设计
`alma` CLI 是 agent 自己调用系统能力的桥梁，也是用户的脚本入口。你的 app 有了完整 API 后，包一层 commander 就有了。

### 10. 语音链路（05 篇）
本地 Whisper STT + 本地 TTS sidecar，全离线语音对话。

## 🧪 开阔眼界（知道存在即可）

### 11. 浏览器控制双路径
Chrome 扩展 + WS Relay（控制用户真实浏览器，带登录态）vs 内嵌无头浏览器。Alma 选了前者——研究这个取舍。

### 12. Computer Use
macOS 辅助功能 API 的独立守护进程（`Alma Computer Use.app` / `CalTool.app` 这种 Swift 小工具随包分发），实现"操作任意 macOS 应用"。

---

### 建议的学习顺序
```
主干（你的 5 项）→ 1 扩展机制 → 2 上下文工程 → 3 流式协议 → 4 权限
→ 之后按兴趣：5/6（人格主动性）、7（情境感知）、8（多通道）
```
一句话总结：**你列的 5 项决定了 agent "能不能用"，上面前 4 项决定它 "好不好用"，后 8 项决定它 "像不像一个活的东西"。**
