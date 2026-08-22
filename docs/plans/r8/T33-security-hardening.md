# T33 · 安全收口：CSP 响应头 + loopback token

> 前置阅读：`../r8/00-overview.md` §0.2 #2/#3（CSP 与 token 为什么不能照抄 02）、§3 契约 3（三红线）；`02 §7/§8.2-3/§9.5`（安全模型 + token 骨架）；`21 §6/§7.2`（Alma 无 CSP 无 token 是反面教材 + 复刻最小 CSP）。
> 本卡改 server（static.ts CSP + onRequest token hook）+ desktop（main 生成/传 token + preload 注入）+ web（fetch/SSE 带 header）三方。

## 1. 问题

两条公知风险（02 §8.2-3、21 §6.4 都点名）：
1. **无 CSP**：renderer 加载任意外部资源无约束。Alma 也没 CSP（21 §6.2），但那是「现状不是榜样」。
2. **loopback 裸奔**：server 绑 `127.0.0.1` 但**无鉴权**——本机任意进程/恶意网页都能 `fetch http://127.0.0.1:<port>/api/...` 操作用户的 Agent（浏览器不拦 loopback fetch，DNS rebinding 可绕）。Alma 没 token 是它的真实攻击面（21 §6.4「复刻必须补」）。

## 2. 改动

### 2.1 CSP 响应头（server，static.ts）

Eva renderer 是 HTTP 托管（无 HTML 文件插 meta），CSP 走 `@fastify/static` 的 `setHeaders` + SPA fallback 的 `sendFile` 加头：

```
default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*;
img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'
```

- `connect-src` 放行 loopback HTTP + WS（SSE 走 HTTP，预留 WS）。
- `style-src 'unsafe-inline'`：Tailwind/inline style 需要（收紧前实测）。
- dev 态（vite 5173）CSP 由 vite 管，server 这套只在打包态生效——dev 别加，免得挡 HMR。

### 2.2 loopback token（三方链路）

**生成（desktop main）**：`randomBytes(24).hex`，每次启动重生成、不落盘。fork server 时经 env `EVA_LOOPBACK_TOKEN` 传入。

**校验（server）**：`app.ts` 加 `onRequest` hook——读 `process.env.EVA_LOOPBACK_TOKEN`，空（dev 外部 server）则跳过校验；非空则除白名单外全量校验 `x-eva-token` header：
- 白名单：`GET /api/v1/threads`（web 列表）、`/v1/health`（健康探测）、`GET /`（static HTML）、静态资源。
- **别放行 `/api/v1/runs/*`**——那是操作面。
- 用 `onRequest` 不用中间件（Fastify 不是 Express，00 §0.2 #3）。

**注入（renderer）**：
- preload 暴露 `electronAPI.getServerInfo() → { port, token }`（扩展现有 `getServerPort`，main 侧 handler 返回 token）。
- web `shared/api/fetch.ts` 的 `apiFetch`：从 `window.electronAPI?.getServerInfo()` 拿 token，有则加 `x-eva-token` header。浏览器（非 Electron）下 `window.electronAPI` 为 undefined → 不带 token（dev 兼容）。
- `run-stream-client.ts` 的 3 个 `fetch`（`:241/:290/:310`）同样带 token header。SSE 用 fetch 不是 EventSource，**能带自定义 header**（EventSource 不能，幸好没用）。

### 2.3 token 不进日志/历史

走自定义 header（`x-eva-token`），不走 query string（query 会进 access log / 浏览器历史）。

## 3. 涉及文件

修改：`apps/server/src/routes/static.ts`（CSP setHeaders）、`apps/server/src/app.ts`（onRequest token hook）、`apps/desktop/electron/main.ts`（生成 token + env 传 server + getServerInfo handler）、`apps/desktop/electron/preload.ts`（getServerInfo 暴露 token）、`apps/web/src/shared/api/fetch.ts`（apiFetch 带 header）、`apps/web/src/shared/api/run-stream-client.ts`（3 个 fetch 带 header）。

新增：token 注入的共享 helper（web 侧 `shared/api/auth.ts`：`getLoopbackToken()` 缓存 + 读取 electronAPI）。

不动 DB、不动 harness。

## 4. 步骤

1. CSP 头（static.ts setHeaders + sendFile）——最小独立件，先做。
2. token 生成 + env 传 server（main）。
3. server onRequest hook 校验 + 白名单。
4. preload 暴露 token + web helper + fetch/SSE 带 header。
5. `pnpm typecheck && pnpm test`；`pnpm desktop:build` 后手动验：`curl -I` 见 CSP、无 token `curl -X POST` 返 401、桌面内对话正常。

## 5. 验收

| # | 验收 | 判定 |
|---|---|---|
| 1 | `curl -I http://127.0.0.1:<port>/` 响应带 CSP 头 | shell |
| 2 | 无 token `curl -X POST /api/v1/runs/stream` 返 401 | shell |
| 3 | 桌面 App 内发消息/SSE 流式正常（带 token） | 手动 E2E |
| 4 | dev 态（外部 server 无 token）浏览器打开 5173 正常对话 | 手动 |
| 5 | CSP 不挡 Tailwind 样式/SSE 连接 | 手动看 console 无 CSP 报错 |

## 6. 坑（按概率）

1. **SSE 用 fetch 才能带 header**：EventSource 不支持自定义 header——Eva 用的是 fetch（对），别「优化」成 EventSource。
2. **白名单别放 `/api/v1/runs/*`**：那是操作面，放了等于没 token。只放只读的 threads 列表 / health / 静态。
3. **dev 态 token 必须可空**：否则浏览器开 5173 全 401，没法调试。hook 检测到 env 空就跳过。
4. **CSP 太紧挡 SSE**：`connect-src` 必须含 `http://127.0.0.1:*`，否则 fetch/SSE 被 CSP 拦。先宽后紧，实测再收。
5. **token 每次启动重生成**：不落盘。落盘就成固定密钥，失去意义。
6. **CSP 别加在 dev**：vite dev server 自己的 HMR/WS 会被 CSP 挡，dev 态 static.ts 不生效（vite 5173 托管），别画蛇添足。
