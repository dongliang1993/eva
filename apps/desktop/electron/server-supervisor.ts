// Server Process Supervisor:端口分配、loopback token、fork、健康等待、收尾。
//
// 「server 在哪个端口、带什么 token、还活着吗」只有本文件知道 —— main.ts 的启动序列、
// ipc-handlers 的 get-server-info、window-manager 的重建 URL 都只能问它。
// 子进程句柄不出本文件,外部只能经 killServer 影响它。
import { app, utilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const isDev = !app.isPackaged;

let serverProcess: Electron.UtilityProcess | null = null;
let serverPort: number | null = null;
let serverErrors: string[] = [];
let serverExited = false;

// loopback token(T33):每次启动重生成、不落盘。fork server 时经 env 传入,
// renderer 经 getServerInfo IPC 拿。dev(外部 server)为空 → server hook 跳过校验。
let loopbackToken: string | null = null;

export const getServerPort = (): number | null => serverPort;

export const getServerInfo = (): { port: number | null; token: string | null } => ({
  port: serverPort,
  token: loopbackToken
});

// ---------------------------------------------------------------------------
// Port Discovery
// ---------------------------------------------------------------------------

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();

      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
  });
}

// dev:server 由外部 tsx watch 起,这里只记端口 —— 不 fork,也不发 token。
export const adoptExternalServer = (port: number): void => {
  serverPort = port;
};

// prod:先占一个空闲端口并生成本次进程的 loopback token,之后才能 startServer。
export const prepareServer = async (): Promise<number> => {
  serverPort = await getAvailablePort();
  loopbackToken = randomBytes(24).toString("hex");

  return serverPort;
};

// ---------------------------------------------------------------------------
// Server Lifecycle
// ---------------------------------------------------------------------------

function getServerPath(): string {
  if (isDev) {
    // In dev, we don't fork — server runs via tsx watch externally
    throw new Error("getServerPath should not be called in dev mode");
  }

  return path.join(process.resourcesPath, "server", "dist", "index.js");
}

function getServerCwd(): string {
  return path.join(process.resourcesPath, "server");
}

function forkServer(
  port: number,
  shellEnv: Record<string, string>,
  proxyEnv: Record<string, string>
): Electron.UtilityProcess {
  const serverPath = getServerPath();
  const serverCwd = getServerCwd();

  console.log(`[server] Path: ${serverPath}`);
  console.log(`[server] CWD: ${serverCwd}`);

  serverErrors = [];
  serverExited = false;

  const env: Record<string, string> = {
    ...shellEnv,
    // Inject system proxy only if user shell doesn't already set it
    ...(!shellEnv.HTTP_PROXY && !shellEnv.HTTPS_PROXY
      ? proxyEnv
      : {}),
    PORT: String(port),
    HOST: "127.0.0.1",
    HOME: os.homedir(),
    PATH: shellEnv.PATH || process.env.PATH || "",
    // loopback token(T33):server 的 onRequest hook 拿它校验 x-eva-token。
    ...(loopbackToken ? { EVA_LOOPBACK_TOKEN: loopbackToken } : {})
  };

  const child = utilityProcess.fork(serverPath, [], {
    env,
    cwd: serverCwd,
    stdio: "pipe",
    serviceName: "eva-server"
  });

  child.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    console.log(`[server] ${msg}`);
    serverErrors.push(msg);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    console.error(`[server:err] ${msg}`);
    serverErrors.push(msg);
  });

  child.on("exit", (code) => {
    console.log(`[server] Exited with code ${code}`);
    serverExited = true;
    serverProcess = null;
  });

  return child;
}

export const startServer = (
  port: number,
  shellEnv: Record<string, string>,
  proxyEnv: Record<string, string>
): void => {
  serverProcess = forkServer(port, shellEnv, proxyEnv);
};

export async function waitForServer(port: number, timeout = 30_000): Promise<void> {
  const start = Date.now();
  let lastError = "";

  while (Date.now() - start < timeout) {
    if (serverExited) {
      throw new Error(
        `Server process exited early.\n\n${serverErrors.join("\n")}`
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require("http");
        const req = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/health",
            family: 4,
            timeout: 2000
          },
          (res: { statusCode?: number }) => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Status ${res.statusCode}`));
            }
          }
        );
        req.on("error", (err: Error) => reject(err));
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("request timeout"));
        });
      });

      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  throw new Error(
    `Server startup timeout after ${timeout / 1000}s.\nLast error: ${lastError}\n\n${serverErrors.length > 0
      ? "Server output:\n" + serverErrors.slice(-20).join("\n")
      : "No server output captured."
    }`
  );
}

export function killServer(): void {
  if (!serverProcess) {
    return;
  }

  console.log("[server] Sending SIGTERM...");
  serverProcess.kill();

  // Force kill after 3s grace period
  const forceKillTimer = setTimeout(() => {
    if (serverProcess) {
      console.log("[server] Force killing...");

      try {
        if (serverProcess.pid !== undefined) {
          process.kill(serverProcess.pid, "SIGKILL");
        }
      } catch {
        // Process may have already exited
      }
    }
  }, 3000);

  serverProcess.on("exit", () => {
    clearTimeout(forceKillTimer);
  });
}
