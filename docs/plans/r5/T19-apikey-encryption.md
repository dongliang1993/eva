# T19 · apiKey 加密落库（方案 A：server 自管 AES-GCM）

> 前置：无。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §1.4（三方案对比）、§4（选 A 的依据）。
> 施工图：`docs/architecture/04-model-adapter-agent-harness.md` §8.3.2（Alma 的 safeStorage 形态与降级明文策略）。

**建议 1 个 commit**：`feat(server)`。不改表结构（无迁移），加密的全部变化发生在"写之前/读之后"两个边界。

---

## 1. 问题实证

`apps/server/src/db/schema.ts:50`：

```ts
apiKey: text("api_key").notNull().default(""),
```

明文。写入路径 `provider-repository.ts:230`（create）/`:257`（update）原样落库；读出路径 `:166`（`parseStoredProviderRow`）原样返回。`~/.eva/eva.db` 被拷走（备份同步、误传、恶意进程读盘）= 全部 provider key 泄露。

Alma 用 Electron `safeStorage`（`docs 04 §8.3.2`），且明确了**降级形态**：`isEncryptionAvailable() === false` → 明文写盘。Eva 的 server 不直接持有 `safeStorage`（UtilityProcess 里拿不到，纯 server 开发路径更没有父进程可桥），所以选 server 自管 AES-GCM —— 对比与决策留在 `00-overview.md` §4，这里不重议。

---

## 2. 目标设计

### 2.1 密文格式：前缀即版本

```
enc:v1:<base64(iv || ciphertext || tag)>   ← AES-256-GCM，iv 12B 随机，tag 16B
plain:<原文>                                ← 加密不可用时的显式降级
<无前缀>                                    ← 历史明文（迁移前写入的行）
```

**读路径三种都要能解**（后向兼容）：`enc:v1:` → 解密；`plain:` → 剥前缀；无前缀 → 当明文原样用。
**写路径只写两种**：能加密写 `enc:v1:`，不能写 `plain:`（**绝不新写无前缀明文** —— 新写入的每一行都要宣告自己的形态）。

### 2.2 密钥：`~/.eva/.secret-key`

```
32 字节随机，首次启动生成；文件权限 0600；base64 存储（一行）。
```

`paths.ts` 加 `secretKeyPath()`（与 `evaDataDir()` 同根）。生成与读取收敛到一个 `KeyProvider`：

```ts
// apps/server/src/services/crypto/secret-key.ts

/**
 * apiKey 加密密钥的提供者。
 *
 * 为什么不用 Electron safeStorage:server 有两条运行路径(桌面 UtilityProcess
 * 子进程 / 纯 server `tsx` 开发路径),后者没有父进程可桥。自管密钥在两条
 * 路径上行为一致;代价是 key 与 DB 同在 ~/.eva/ —— 防"只拷走 eva.db",
 * 不防"整目录被端"(威胁模型见 r5 00-overview §4,可接受)。
 *
 * 读取失败(文件损坏/权限不对)→ 返回 undefined = 加密不可用,调用方降级
 * plain: 并打 warning。绝不为"读不出 key"抛错 —— 那会让整个 provider
 * 体系在 key 文件损坏时全灭,而降级明文至少能用(与 Alma 同款降级哲学)。
 */
export const loadSecretKey = (keyPath: string): Buffer | undefined => { /* ... */ };
```

`Encryptor` 接口 + 唯一实现 `AesGcmEncryptor`：

```ts
// apps/server/src/services/crypto/encryptor.ts
export interface Encryptor {
  /** 加密失败(不该发生,GCM 无失败分支)时不降级 —— 抛错,别静默写明文。 */
  encrypt(plain: string): string;   // → "enc:v1:..."
  /** 三种形态全解;密文损坏 → 抛错(调用方按"key 不可用"处理,不用残值)。 */
  decrypt(stored: string): string;
}
```

### 2.3 改动边界：只有 repository 的进出两个口

**读**（一个口）：`parseStoredProviderRow`（`provider-repository.ts:166`）—— `apiKey: row.apiKey` → `apiKey: encryptor.decrypt(row.apiKey)`。
**写**（两个口）：`createProvider`（`:230`）与 `updateProvider`（`:257-258`）—— `input.apiKey` 进库前 `encryptor.encrypt(...)`。`clearApiKey` 写 `""` 不加密（空串不加密，读路径对 `""` 直通）。

`Encryptor` 从哪来：`provider-repository.ts` 是纯函数模块（全部函数吃 `db` 第一个参数），不引全局单例 —— 加第二个可选参数 `encryptor?: Encryptor`，**缺省 = 明文直通**（`IdentityEncryptor`）。调用方（`routes/providers.ts`、`model-resolver.ts`、`provider-http.ts` 上游）从 `app.infra` 拿装配好的实例传进去。

装配点：`deps.ts` 启动时 `loadSecretKey(secretKeyPath())` → 成功 `AesGcmEncryptor`，失败 `IdentityEncryptor` + `logger.warn("apiKey 加密不可用,明文降级")`。挂到 `AppInfrastructure`。

> **`parseProviderRow`（不含 apiKey 的 UI 版）不动**：`hasApiKey: row.apiKey.length > 0` 对密文同样成立（`enc:v1:` 非空即 true），UI 语义不变。

### 2.4 历史明文怎么办：懒迁移

**不做启动时全量重写**（一次 UPDATE 全部行）。理由：写路径已经只写新形态，读路径三种都认识 —— 历史明文行在**下一次被 update 时自然加密**，不被碰的行维持明文但读出来照样能用。全量迁移的收益是"DB 里立刻没有明文"，代价是给一个本地单机库写一段只跑一次的重写逻辑 + 它的测试。不值。

显式暴露给用户的只有一件事：**改一次 key（哪怕改成同一个值）就会加密**。`AGENTS.md` 写明这一点（§3）。

### 2.5 `model-resolver.ts` / `provider-http.ts` 零改动

它们吃 `StoredProviderConfig.apiKey`，拿的是 `parseStoredProviderRow` 解密后的明文 —— 加密层对下游完全透明。这是"边界收敛在 repository"的全部意义。

---

## 3. 涉及文件

### 新增
| 文件 | 内容 |
|---|---|
| `apps/server/src/services/crypto/encryptor.ts` | `Encryptor` 接口 + `AesGcmEncryptor` + `IdentityEncryptor` |
| `apps/server/src/services/crypto/secret-key.ts` | `loadSecretKey`（生成/读取/0600） |
| `tests/apikey-encryption.test.ts` | §4 全部用例 |

### 修改
| 文件 | 动作 |
|---|---|
| `apps/server/src/paths.ts` | `secretKeyPath()` |
| `apps/server/src/services/providers/provider-repository.ts` | 写两口加密、读一口解密；函数签名加可选 `encryptor` |
| `apps/server/src/routes/providers.ts` | 把 `app.infra.encryptor` 传进 repository 调用 |
| `apps/server/src/services/providers/model-resolver.ts` | 同上（`findStoredProviderById` 调用点） |
| `apps/server/src/types/common.ts` | `AppInfrastructure` 加 `encryptor: Encryptor` |
| `apps/server/src/deps.ts` | 装配 encryptor（含降级 warning） |
| `AGENTS.md` | Configuration 节补 `~/.eva/.secret-key` 与"改一次 key 即加密"的懒迁移说明 |

---

## 4. 步骤

### Step 1 · 【测试先行】Encryptor 三形态

`tests/apikey-encryption.test.ts`：

- round-trip：`encrypt("sk-ant-xxx")` → `enc:v1:` 前缀 → `decrypt` 回原值；
- `decrypt("plain:sk-xxx")` → `sk-xxx`；
- `decrypt("sk-legacy-plain")` → 原样返回（历史明文兼容）；
- `decrypt("")` → `""`（空直通）；
- 两次 `encrypt` 同一原文 → **密文不同**（iv 随机）；
- 篡改密文一个字符 → `decrypt` 抛错（GCM tag 校验）；
- `IdentityEncryptor` round-trip = 原文。

用固定 32 字节 key 构造 `AesGcmEncryptor`（key 注入，不碰文件系统）。RED→GREEN。

### Step 2 · 【测试先行】`loadSecretKey`

用 `mkdtempSync` 临时目录：

- 路径不存在 → 生成新 key 并写文件，`stat.mode & 0o777 === 0o600`；
- 已存在 → 读出同一个 key；
- 文件内容损坏（非 base64 / 长度不对）→ 返回 `undefined`（不抛）。

### Step 3 · 【测试先行】repository 边界

内存 DB + seed 一个 provider：

- `updateProvider(db, id, { apiKey: "sk-x" }, aes)` → DB 里 `api_key` 以 `enc:v1:` 开头；
- `findStoredProviderById(db, id, aes).apiKey === "sk-x"`（透明解密）；
- 不 third 参（无 encryptor）→ 明文直通（既有行为回归）；
- `clearApiKey: true` → DB 里 `""`，读出 `""`。

### Step 4 · 接线

`deps.ts` 装配 + `AppInfrastructure` + 三个调用点穿透。`pnpm typecheck && pnpm test` 全绿。

### Step 5 · 手工验证 + AGENTS.md

`AGENTS.md` Configuration 节加两行：`~/.eva/.secret-key`（用途、0600、删了等于所有已存 apiKey 作废）+ 懒迁移说明（"任何一次 key 更新都会把该行转为密文"）。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；`tests/apikey-encryption.test.ts` RED→GREEN
- [ ] 手工：设置页给一个 provider 存 key → `sqlite3 ~/.eva/eva.db "select api_key from providers where id='openai'"` 显示 `enc:v1:` 前缀
- [ ] 手工：重启 server → 该 provider 模型照常可聊（读路径透明）
- [ ] 手工：`stat -f "%Lp" ~/.eva/.secret-key` → `600`
- [ ] 手工：删掉 `.secret-key` 重启 → 日志有降级 warning；新存的 key 落 `plain:` 前缀；**已加密的行读不出**（启动时新 key 解不了旧密文 → provider 显示 hasApiKey 但实际不可用 —— 可接受，见 §6 坑 3）
- [ ] 手工：改一次历史明文 provider 的任意字段（不动 key）→ 该行 apiKey 仍是明文（懒迁移只在 key 被 update 时触发）；把 key 重存一遍 → 转密文

## 6. 坑

1. **给空串加密**。`""` 表示"没配 key"，`encrypt("")` 会把它变成非空密文 → `hasApiKey` 变 true → UI 显示"已配置"但模型 401。写路径对 `""` 直通，读路径对 `""` 直通。
2. **在 `parseProviderRow` 里解密**。那是 UI 版（刻意不含 apiKey），给它接解密等于把明文 key 送到了原本拿不到它的路径。解密只在 `parseStoredProviderRow`。
3. **key 文件丢失/轮换后已加密行变砖**。这是自管密钥的固有属性，不是 bug：`.secret-key` 没了，`enc:v1:` 行就永远解不开。`AGENTS.md` 必须写明"删 key 文件 = 已存 apiKey 全作废，需重新配置"。不做 key 轮换工具（本地单机，重配一次 key 的成本低于维护轮换逻辑）。
4. **decrypt 失败静默返回密文本身**。那会把 `enc:v1:...` 当 apiKey 发去 provider —— 401 报错的文案完全看不出真因。解密失败必须抛，由 `findStoredProviderById` 的调用方按"provider 不可用"处理（`model-resolver` 已有 `AgentUnavailableError` 通路）。
5. **顺手做全量迁移**。§2.4 说了不做；执行时若想"就一段 UPDATE 而已"，回去读那段理由。懒迁移不是偷懒，是不为单机库写一次性代码。
