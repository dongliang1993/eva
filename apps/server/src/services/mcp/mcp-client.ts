import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpServerRow } from "../../db/repositories/mcp-server-repository.js";
import type { McpLogger } from "./mcp-config-file.js";

/**
 * 单次工具调用的超时。MCP server 是外部进程/服务，卡住不能拖死 agent loop。
 * 30s：够慢工具（拉网页、跑查询）完成，又不至于让用户以为界面死了。
 * 用 SDK 自带的 RequestOptions.timeout 而不是 Promise.race —— 它会真正取消在飞的请求。
 */
const CALL_TIMEOUT_MS = 30_000;

/**
 * 单条工具输出注入上限。超出截断并提示 —— 与 fs 工具的 tool-overflow 同一个思路，
 * 区别是 MCP 输出不落盘（没有工作区可落），所以只截断。
 */
const MAX_OUTPUT_CHARS = 24_000;

/** 连接握手超时。stdio 要 spawn 进程，给足 15s；http 一般秒级。 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * 保留的子进程 stderr 尾部长度。
 * 用途：连接失败时 SDK 只会给 "Connection closed"（进程起来了又立刻死掉的情况），
 * 真实原因在子进程的 stderr 里。带上尾部，用户才能看到 "Cannot find package ..."
 * 这种能直接照着修的信息。
 */
const STDERR_TAIL_CHARS = 2_000;

export interface McpToolDescriptor {
  /** MCP 侧原名（不含 mcp__ 前缀）。 */
  readonly name: string;
  readonly description: string;
  /** JSON Schema 原样。 */
  readonly inputSchema: unknown;
  /** 取自 annotations.readOnlyHint —— 协议自己声明无副作用。 */
  readonly readOnly: boolean;
}

interface PreparedTransport {
  readonly transport: Transport;
  /** stdio 子进程 stderr 的尾部；http 恒为空串。 */
  readStderrTail(): string;
}

const prepareTransport = (row: McpServerRow): PreparedTransport => {
  if (row.transport === "stdio") {
    if (!row.command) {
      throw new Error("stdio server 缺少 command");
    }

    const transport = new StdioClientTransport({
      command: row.command,
      args: [...row.args],
      // 必须并上 getDefaultEnvironment()：它带 PATH/HOME 等。只给 row.env 的话
      // `npx` 这类命令在打包后的窄 env 里根本找不到（T9 §6 坑 1）。
      env: { ...getDefaultEnvironment(), ...row.env },
      // pipe 而不是 inherit：把 stderr 抓在手里，失败时能把真实原因回给用户。
      stderr: "pipe",
    });

    let tail = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      tail = `${tail}${String(chunk)}`.slice(-STDERR_TAIL_CHARS);
    });

    return { transport, readStderrTail: () => tail.trim() };
  }

  if (!row.url) {
    throw new Error("http server 缺少 url");
  }

  const httpTransport = new StreamableHTTPClientTransport(new URL(row.url), {
    ...(Object.keys(row.headers).length > 0
      ? { requestInit: { headers: { ...row.headers } } }
      : {}),
  });

  // SDK 把 sessionId 声明成 `get sessionId(): string | undefined`，而 Transport 接口写的是
  // `sessionId?: string` —— 在 exactOptionalPropertyTypes 下两者不兼容。这是 SDK 自身类型的
  // 不一致，不是我们的建模问题：在唯一构造点收一次窄转换，不为它放宽整仓 tsconfig。
  return {
    transport: httpTransport as unknown as Transport,
    readStderrTail: () => "",
  };
};

/**
 * inputSchema 的最低要求：顶层是对象类型的 JSON Schema。
 * 有些 server 会发不规范的 schema（缺 type、只有 $ref），交给 AI SDK 的
 * jsonSchema() 会在调用时才炸 —— 宁可在连接时跳过这个工具，别让一个坏 schema
 * 废掉整个 server（T9 §6 坑 2）。
 */
const isUsableInputSchema = (schema: unknown): boolean => {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return false;
  }

  const record = schema as Record<string, unknown>;

  return (
    record["type"] === "object" || typeof record["properties"] === "object"
  );
};

const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4);

/** content[] → 纯文本。非文本内容写成占位说明，让模型知道"有东西但没内联"。 */
const flattenContent = (content: readonly unknown[]): string => {
  const chunks: string[] = [];

  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) {
      chunks.push(String(raw));
      continue;
    }

    const block = raw as Record<string, unknown>;

    switch (block["type"]) {
      case "text":
        chunks.push(String(block["text"] ?? ""));
        break;
      case "image":
      case "audio":
        chunks.push(
          `[${String(block["type"])} ${String(block["mimeType"] ?? "unknown")}, ` +
            `${base64Bytes(String(block["data"] ?? ""))} bytes — not inlined]`,
        );
        break;
      case "resource_link":
        chunks.push(`[resource ${String(block["uri"] ?? "")}]`);
        break;
      case "resource": {
        const resource = block["resource"];
        const uri =
          typeof resource === "object" && resource !== null
            ? String((resource as Record<string, unknown>)["uri"] ?? "")
            : "";
        const text =
          typeof resource === "object" && resource !== null
            ? (resource as Record<string, unknown>)["text"]
            : undefined;

        chunks.push(typeof text === "string" ? text : `[resource ${uri}]`);
        break;
      }
      default:
        chunks.push(JSON.stringify(block));
    }
  }

  const joined = chunks.join("\n");

  return joined.length <= MAX_OUTPUT_CHARS
    ? joined
    : `${joined.slice(0, MAX_OUTPUT_CHARS)}\n[... truncated ${joined.length - MAX_OUTPUT_CHARS} chars]`;
};

/** 把子进程 stderr 的尾部并进错误信息 —— 否则用户只看到 "Connection closed"。 */
const withStderrDetail = (error: unknown, stderrTail: string): Error => {
  const base = error instanceof Error ? error : new Error(String(error));

  if (stderrTail.length === 0) {
    return base;
  }

  return new Error(`${base.message}\n${stderrTail}`);
};

/**
 * 一个已连接的 MCP server。
 *
 * 只做三件事：连接时把工具清单拉下来、按名字调用工具、关闭。
 * 不认识 AgentTool，也不认识审批 —— 那是 `mcp-tools.ts` 的事。
 */
export class McpServerClient {
  private constructor(
    private readonly client: Client,
    readonly tools: readonly McpToolDescriptor[],
  ) {}

  /**
   * 连接并拉取工具清单。
   * @param transport 仅测试注入（InMemoryTransport）；生产按 row.transport 构造。
   * @throws 连接失败或握手失败时抛出，错误原文交给调用方展示（如 "spawn npx ENOENT"）
   */
  static async connect(
    row: McpServerRow,
    logger: McpLogger,
    transport?: Transport,
  ): Promise<McpServerClient> {
    const client = new Client({ name: "eva", version: "0.1.0" });
    const prepared = transport
      ? { transport, readStderrTail: () => "" }
      : prepareTransport(row);

    try {
      await client.connect(prepared.transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      // SDK 对"进程起来了又立刻退出"只给 "Connection closed"。真实原因在 stderr 里。
      throw withStderrDetail(error, prepared.readStderrTail());
    }

    try {
      const listed = await client.listTools(undefined, {
        timeout: CONNECT_TIMEOUT_MS,
      });
      const usable: McpToolDescriptor[] = [];
      const skipped: string[] = [];

      for (const tool of listed.tools) {
        if (!isUsableInputSchema(tool.inputSchema)) {
          skipped.push(tool.name);
          continue;
        }

        usable.push({
          name: tool.name,
          description: tool.description ?? `MCP tool ${tool.name}`,
          inputSchema: tool.inputSchema,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }

      if (skipped.length > 0) {
        logger.warn(
          { server: row.name, skipped },
          "MCP server 的部分工具 inputSchema 不是对象 schema，已跳过这些工具",
        );
      }

      return new McpServerClient(client, usable);
    } catch (error) {
      // 拉清单失败就没有可用工具，别留一个连上但空转的 client
      await client.close().catch(() => {});
      throw withStderrDetail(error, prepared.readStderrTail());
    }
  }

  /**
   * 调用一个工具，返回拍平后的文本。
   * @param signal T25:run 取消 ∪ toolMs 超时信号 —— 触发时中断传输层请求
   *   (协议 RequestOptions.signal)。可选,不传行为不变。
   * @throws server 报 isError 或调用超时/失败时抛出（由 buildJsonSchemaTool 包成 [Tool Error]）
   */
  async callTool(
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.client.callTool(
      {
        name: toolName,
        arguments: (input ?? {}) as Record<string, unknown>,
      },
      undefined,
      {
        timeout: CALL_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      },
    );

    const content = Array.isArray(result.content) ? result.content : [];
    const text = flattenContent(content);

    if (result.isError === true) {
      throw new Error(text || `MCP tool ${toolName} reported an error`);
    }

    return text;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
