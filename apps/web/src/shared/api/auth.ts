/**
 * loopback token(T33):桌面端 main 每次启动重生成、经 preload 注入 renderer;
 * 浏览器(dev,外部 server)下 electronAPI 为 undefined → 不带 token,server hook 也跳过。
 * 走自定义 header x-eva-token,不走 query(会进 access log / 浏览器历史)。
 *
 * 结果缓存——token 在一次会话内不变(main 每次启动重生成),不用每次请求都 await IPC。
 */

let cachedToken: string | null | undefined;

export async function getLoopbackToken(): Promise<string | null> {
  if (cachedToken !== undefined) {
    return cachedToken;
  }

  if (typeof window === "undefined" || !window.electronAPI?.getServerInfo) {
    cachedToken = null;
    return cachedToken;
  }

  try {
    const info = await window.electronAPI.getServerInfo();
    cachedToken = info?.token ?? null;
  } catch {
    cachedToken = null;
  }

  return cachedToken;
}

/** 给 fetch options 的 headers 合并 token(有则加)。 */
export async function withLoopbackToken(
  headers: Record<string, string> = {}
): Promise<Record<string, string>> {
  const token = await getLoopbackToken();

  return token ? { ...headers, "x-eva-token": token } : headers;
}
