// 系统代理探测(borrowed from CodePilot)。
// 只有一个消费者:server-supervisor —— 且仅在用户 shell 自己没设代理时才注入。
import { session } from "electron";

export async function resolveSystemProxy(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const proxyList = await session.defaultSession.resolveProxy(
      "https://registry.npmjs.org"
    );

    if (!proxyList || proxyList === "DIRECT") {
      return env;
    }

    for (const entry of proxyList.split(";")) {
      const trimmed = entry.trim();

      if (!trimmed || trimmed === "DIRECT") {
        continue;
      }

      const httpMatch = trimmed.match(
        /^(?:PROXY|HTTPS)\s+([\w.-]+:\d+)$/i
      );

      if (httpMatch) {
        env.HTTP_PROXY = `http://${httpMatch[1]}`;
        env.HTTPS_PROXY = `http://${httpMatch[1]}`;
        console.log("[proxy] System proxy detected:", env.HTTPS_PROXY);

        return env;
      }

      const socksMatch = trimmed.match(/^SOCKS5?\s+([\w.-]+:\d+)$/i);

      if (socksMatch) {
        env.HTTP_PROXY = `socks5://${socksMatch[1]}`;
        env.HTTPS_PROXY = `socks5://${socksMatch[1]}`;
        console.log("[proxy] System SOCKS proxy detected:", env.HTTPS_PROXY);

        return env;
      }
    }
  } catch (err) {
    console.warn("[proxy] Failed to resolve system proxy:", err);
  }

  return env;
}
