# T20 · tool-overflow 治理（LRU + 脱敏 + ANSI 清洗）

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.5、§3。
> 施工图：`docs/architecture/04-model-adapter-agent-harness.md` §8.6.2（完整实现还原 + 关键数字表）。

**建议 1 个 commit**：`feat(harness)`。`tool-overflow.ts` 是纯函数模块（harness，无 server 依赖），治理逻辑全部收在这一个文件里。

---

## 1. 问题实证

`packages/harness/src/tools/fs/tool-overflow.ts`（30 行）vs Alma（`docs 04 §8.6.2`，~90 行）：

| 治理能力 | Alma | Eva 现状 | 现状后果 |
|---|---|---|---|
| 文件名 | `<Tool>-<field>-<sha1:12>.<ext>` 内容寻址 | `${toolName}-${callId}-${Date.now()}.txt` | 同一内容每次调用都写新文件；`grep` 一个大日志十次 = 十个相同文件 |
| 容量 | 200 文件 / 100MB，mtime 升序 LRU 清最旧 | **无** | `~/.eva/tool-overflow/<ws>/` 永久单调增长 |
| 脱敏 | `authorization: bearer/token` 值打码 | **无** | `bash env`、`cat .env`、带 token 的 curl 输出原文落盘 |
| ANSI 清洗 | `\x1B[...m` 等剥掉再写 | **无** | 落盘文件带颜色码，`read_file` 续读时模型看到一堆 `\x1b[31m` 噪音 |
| 开关 | `ALMA_TOOL_OVERFLOW=0` 关 | 无 | 排查时没法关 |

调用点（5 处）：`read-file-tool.ts:43`、`grep-tool.ts:70`、`bash-tool.ts:38,42`、`list-dir-tool.ts`、`write/edit` 的回显 —— 全都走 `maybeOverflow(text, dir, toolName, callId?)` 这一个入口，所以**治理只需要改 `tool-overflow.ts` 一个文件，调用点零改动**。

---

## 2. 目标设计

### 2.1 处理流水线（写盘前的四道工序，顺序不可换）

```
text 超阈(OVERFLOW_LIMIT)
  → ① ANSI 清洗     stripAnsi(text)         —— 颜色码是给人看的,落盘文件是给模型读的
  → ② 脱敏          redactSecrets(text)      —— 落盘文件生命周期可能长于会话,密钥不许躺着
  → ③ 内容寻址      sha1(text).slice(0,12)   —— 清洗后的内容定 hash,同内容不重写
  → ④ 写盘 + LRU    writeOnce + scheduleReap —— 超 200 文件/100MB 按 mtime 清最旧
```

**为什么先清洗再 hash**：清洗是确定性的，同一原始输出清洗后必得同一文本 → hash 稳定，内容寻址才成立。顺序反了（先 hash 原文再清洗）等于没寻址。

**为什么返回摘要用清洗后长度**：模型拿 `read_file` 续读的是落盘文件，摘要里报的字节数必须和文件一致，否则 offset 全错。

### 2.2 常量（全部注释取值理由）

```ts
/**
 * 单条输出落盘阈值。Alma 用 2000 字节(docs 04 §8.6.2),Eva 历来 4000 字符
 * 也没爆过 context —— 维持 4000,本轮治理的是"落盘之后"的事,不改触发面。
 * (阈值下调是另一个独立决策:收益是 context 更省,代价是模型要多花轮次续读。)
 */
const OVERFLOW_LIMIT = 4000;

/** 落盘目录文件数上限。Alma 同款(docs 04 §8.6.2):一个活跃工作区一周产出 ~50 个,200 给足余量。 */
const MAX_FILES = 200;

/** 落盘目录总字节上限。Alma 同款 100MB:单个 overflow 典型 4KB-1MB,100MB ≈ 几百个大文件。 */
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
```

### 2.3 各工序实现要点

**① ANSI 清洗**（照抄 `docs 04 §8.6.2` 的正则，它是 ECMA-48 的完整覆盖）：

```ts
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
```

**② 脱敏**（Alma 同款正则 +  Eva 补一条通用 KEY=VALUE）：

```ts
/**
 * 授权头:authorization: bearer xxx / token xxx(大小写不敏感)。
 * Alma 同款(docs 04 §8.6.2) —— 8 字符下限避免误伤 "bearer is" 这类散文。
 */
const AUTH_HEADER = /\b(authorization\s*[:=]\s*["']?(?:bearer|token)\s+)([^\s"',}]{8,})/gi;

/**
 * KEY=VALUE 形态的常见密钥名(api_key/token/secret/password)。
 * Alma 没有这条,但它的 env 输出场景在 Eva 同样存在(bash 工具跑 env/printenv)。
 * 值保留前 4 字符(够辨认是哪个 key,不够用)。
 */
const KEY_VALUE = /\b([A-Za-z_]*(?:api[_-]?key|token|secret|password))\s*[:=]\s*["']?([^\s"',}]{4})[^\s"',}]*/gi;
```

打码形态照 Alma：`${前4字符}…[redacted N chars]`。

**③ 内容寻址文件名**：

```ts
const fileName = (toolName: string, text: string): string => {
  const hash = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
  return `${sanitizeName(toolName)}-${hash}.log`;   // sanitizeName: Alma 的 Gm,去非法字符截 40
};
```

已存在（同 hash）→ `statSync` 拿大小直接返回，**不重写**（Alma 同款：内容寻址的全部意义）。

**④ LRU 清理**（Alma 的 setTimeout 防抖同款，防每次写都全量扫目录）：

```ts
/** 同一进程内清理的节流标记 —— 写盘后才排一次,清理期间再写不重排。 */
let reapScheduled = false;

const scheduleReap = (dir: string): void => {
  if (reapScheduled) return;
  reapScheduled = true;
  setTimeout(() => {
    reapScheduled = false;
    reapOldest(dir);   // readdirSync + statSync → 超 MAX_FILES/MAX_TOTAL_BYTES → mtime 升序删
  }, 0);
};
```

清理失败（文件被外部删了等）→ **静默跳过下一个**（Alma 的 `try {} catch {}` 同款：清理是家政，不许影响工具调用主路径）。

### 2.4 返回摘要的微调

现状摘要三行（超长告知 + 路径 + 续读提示）。补字节/行数（Alma 同款，帮模型决定 offset/limit）：

```
Output too long (15234 chars after sanitization). Full output saved to:
~/.eva/tool-overflow/<ws>/bash-a1b2c3d4e5f6.log (15234 chars, 487 lines)
Use read_file on that path (with offset/limit) to read it.
```

### 2.5 环境变量开关

`EVA_TOOL_OVERFLOW=0` → `maybeOverflow` 直接返回原文（不落盘、不截断）。照 Alma 的 `ALMA_TOOL_OVERFLOW`（`docs 04 §8.6.2`），名字换 Eva 前缀。读取点：`maybeOverflow` 入口判一次（**每次调用都读**，不设模块级缓存 —— 排查时改完立即生效，性能成本是一次 `process.env` 查找，相对 4KB 字符串处理可忽略）。

---

## 3. 涉及文件

### 修改
| 文件 | 动作 |
|---|---|
| `packages/harness/src/tools/fs/tool-overflow.ts` | 全部四道工序 + LRU + 开关（30 行 → ~130 行） |
| `tests/tool-overflow.test.ts` | 扩充（现有断言保留 + §4 新增） |

### 新增
无。

> 调用点（5 处 tool 文件）**零改动** —— 签名不变（`maybeOverflow(text, dir, toolName, callId?)`）。`callId` 参数变为不再进文件名（内容寻址取代），保留参数位以免动 5 个调用点；函数注释里写明 `callId` 已废弃、保留仅为签名兼容。

---

## 4. 步骤

### Step 1 · 【测试先行】ANSI 清洗 + 脱敏

`tests/tool-overflow.test.ts`（现有文件扩充）：

- 带 `\x1b[31merror\x1b[0m` 的超长输出 → 落盘文件无 `\x1b`，返回摘要里无 `\x1b`；
- `authorization: Bearer sk-abc123def456` → 文件里 `Bearer sk-a…[redacted 11 chars]`（前 4 保留，15 字符留 4 打 11）；
- `OPENAI_API_KEY=sk-proj-xyz789...` → `OPENAI_API_KEY=sk-p…[redacted N chars]`；
- `password=short`（< 8 字符对 AUTH_HEADER 不命中；KEY_VALUE 命中但保留前 4 → "shor" 全露 + 0 剩余 —— 断言**短值也打码**，不留完整值）。

### Step 2 · 【测试先行】内容寻址 + 不重写

- 同一超长文本 `maybeOverflow` 两次 → 目录里只有 1 个文件；第二次返回的路径与第一次相同；
- 不同文本 → 2 个文件、hash 不同；
- 文件名形如 `bash-<hex12>.log`，toolName 带非法字符（`my tool/v2`）→ 被清洗。

### Step 3 · 【测试先行】LRU

- `mkdtempSync` 造目录，手工塞 201 个带递升 mtime 的文件（`utimesSync` 控制）→ 触发一次 overflow → 目录回到 200 个、**最旧的那个没了**；
- 总字节超 100MB（用稀疏内容或调小注入的常量 —— 实现上把 `MAX_FILES/MAX_TOTAL_BYTES` 做成可注入参数，测试传小值）→ 按 mtime 删到低于上限；
- 清理期间目标文件已被外部删除 → 不抛（catch 跳过）。

### Step 4 · 实现 + 摘要微调 + 开关

按 §2 实现。现有断言（未超限直通、超限落盘返回路径）保持绿。`EVA_TOOL_OVERFLOW=0` 用例：`process.env` 设置后超长输出原样返回。

`pnpm typecheck && pnpm test` 全绿。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；`tests/tool-overflow.test.ts` 新用例 RED→GREEN，旧用例不破
- [ ] 手工：agent 跑 `bash env`（输出超 4KB 时）→ 落盘文件里 `authorization`/`API_KEY` 值已打码
- [ ] 手工：agent 跑一条带颜色的命令（如 `ls --color=always /` 大目录）→ 落盘文件无 ANSI 码，`read_file` 续读干净
- [ ] 手工：同一命令跑两次 → overflow 目录只多一个文件（第二次命中同 hash）
- [ ] 手工：往 `~/.eva/tool-overflow/<ws>/` 塞 201 个文件后再触发一次 overflow → 目录回到 200，最旧的消失
- [ ] `EVA_TOOL_OVERFLOW=0 pnpm dev:server` → 超长输出原样进 context（不落盘）

## 6. 坑

1. **清洗顺序**（§2.1）：先 ANSI 再脱敏。反了的话，ANSI 码嵌在密钥中间（`sk-\x1b[31mabc`）会让脱敏正则不命中 —— 密钥带颜色码落盘。
2. **hash 用原文**。必须 hash 清洗后的文本（§2.1），否则同一输出因颜色码随机（某些工具每次输出颜色不同）永远寻址失败。
3. **KEY_VALUE 误伤**。`token` 子串会命中 `csrf_token_name=x` 这类非密值 —— 可接受（过度打码的代价是模型少看一个非密值，泄漏的代价是密钥躺盘）。但**值 < 8 字符也要打**（测试 Step 1 已钉）：短密钥（如 6 位 OTP）不能豁免。
4. **LRU 在写盘线程里同步扫目录**。一次 overflow 写 1MB 不该付一次全目录 stat —— Alma 的 setTimeout 防抖就是为了这个；清理是后台家政，不在工具调用的关键路径上。
5. **清理把别的 ws 目录删了**。`reapOldest` 只吃当前 `outputRoot` 一个目录，不递归、不碰兄弟目录（每个 workspace 自己的 200/100MB 配额）。
6. **`callId` 参数别删**。5 个调用点都在传；删了要动 5 个文件、违反"治理收敛在一个文件"。注释标记废弃即可。
