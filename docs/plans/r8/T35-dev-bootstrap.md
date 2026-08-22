# T35 · dev 一键拉起：concurrently 串起 server + web + desktop

> 前置阅读：`../r8/00-overview.md` §0.3（dev 断层）。
> 本卡只动根 `package.json` 脚本 + devDeps，零风险、纯效率。

## 1. 问题

`pnpm desktop:dev` 只跑 `electron-vite dev`，**假定 server 和 web dev server 已在外部启动**——实际要开三个终端（`serve:dev` + `web:dev` + `desktop:dev`）。`concurrently`/`wait-on` 在 devDeps 里但**无任何脚本引用**（装了没用，探查实证）。

## 2. 改动

根 `package.json` 加一条一键命令，用 `concurrently` 并行拉三个、`wait-on` 让 desktop 等 web/server 就绪：

```jsonc
"desktop:dev:all": "concurrently -n server,web,desktop -c blue,green,yellow \"pnpm serve:dev\" \"pnpm web:dev\" \"wait-on tcp:8082 tcp:5173 && pnpm desktop:dev\""
```

- `serve:dev`（tsx watch，8082）+ `web:dev`（vite，5173）先后台跑；`wait-on tcp:8082 tcp:5173` 确认两端口就绪再 `desktop:dev`（desktop dev 态 `loadURL http://localhost:5173`，vite 把 `/api` 代理到 8082）。
- 保留原 `desktop:dev`（只起 desktop）不动，给「server/web 已在跑」的场景留门。

## 3. 涉及文件

修改：根 `package.json`（加 `desktop:dev:all` 脚本；确认 `concurrently`/`wait-on` 在 devDeps，没有就补）。

## 4. 步骤

1. 确认/补 devDeps（`concurrently`、`wait-on`）。
2. 加 `desktop:dev:all` 脚本。
3. `pnpm desktop:dev:all` 实测：一条命令拉起，desktop 窗口能对话。

## 5. 验收

| # | 验收 | 判定 |
|---|---|---|
| 1 | `pnpm desktop:dev:all` 一条命令拉起三进程，desktop 窗口能对话 | 手动 |
| 2 | server/web 任一未就绪时 desktop 不白屏（wait-on 挡住） | 手动 |

## 6. 坑

1. **端口写死 8082/5173**：若 `PORT`/`SERVER_PORT` 被环境改，`wait-on` 的端口要跟着变——脚本里用默认值即可，自定义端口的场景仍走原 `desktop:dev`。
2. **concurrently 杀进程**：Ctrl+C 要能三个一起杀（concurrently 默认转发 SIGINT，别加 `-k` 之外的幺蛾子）。
