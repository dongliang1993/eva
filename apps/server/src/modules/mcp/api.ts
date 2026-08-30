import { randomUUID } from "node:crypto";

import type { McpServerConfig, McpServerStatus, McpServersPayload } from "@eva/shared";

import {
  toMcpServerConfig,
  type McpServerFields,
  type McpServerRepository,
  type McpServerRow
} from "./mcp-server-repository.js";
import type { McpRegistry } from "./mcp-registry.js";

// 入参/出参形状是这一层的契约,route 与 api 共用 —— 从这里再导一次,
// 免得 route 为了一个类型去 import db/repositories。
export type { McpServerFields, McpServerRow };

/** 写操作的三种结局。名字不存在时返回 undefined,状态码由 route 决定。 */
export type McpWriteResult =
  | { readonly ok: true; readonly server: McpServerConfig }
  | { readonly ok: false; readonly reason: "name-taken" };

export interface McpApi {
  /** server 配置 + 当前连接状态。会先确保连过一轮。 */
  describeAll(): Promise<McpServersPayload>;
  /**
   * 只读一行的出处与启停 —— route 需要它来区分「file 来源只能启停」这条业务规则。
   * 返回 row 而不是 McpServerConfig:origin 不在对外契约里。
   */
  find(id: string): McpServerRow | undefined;
  create(fields: McpServerFields): Promise<McpWriteResult>;
  update(id: string, fields: McpServerFields): Promise<McpWriteResult>;
  /** file 来源的 server 只能走这条:内容以 ~/.eva/mcp.json 为准。 */
  setEnabled(id: string, enabled: boolean): Promise<McpServerConfig | undefined>;
  delete(id: string): Promise<void>;
  reconnect(id: string): Promise<McpServerStatus>;
}

export const createMcpApi = (deps: {
  readonly servers: McpServerRepository;
  readonly registry: McpRegistry;
}): McpApi => ({
  describeAll: async () => {
    // 先确保连过一轮,否则 enabled 但未连接的 server 只能报"未连接",对用户没信息量。
    await deps.registry.ensureConnected();

    return {
      servers: deps.servers.listAll().map(toMcpServerConfig),
      statuses: deps.registry.describe()
    };
  },

  find: (id) => deps.servers.findById(id),

  create: async (fields) => {
    if (deps.servers.findByName(fields.name)) {
      return { ok: false, reason: "name-taken" };
    }

    const created = deps.servers.create(randomUUID(), "manual", fields);
    // 建完立刻连一次:用户加了 server 就是想马上用,不该等下一个 run 才发现连不上。
    await deps.registry.reconnect(created.id);

    return { ok: true, server: toMcpServerConfig(created) };
  },

  update: async (id, fields) => {
    const conflict = deps.servers.findByName(fields.name);

    if (conflict && conflict.id !== id) {
      return { ok: false, reason: "name-taken" };
    }

    const updated = deps.servers.update(id, fields)!;
    await deps.registry.reconnect(id);

    return { ok: true, server: toMcpServerConfig(updated) };
  },

  setEnabled: async (id, enabled) => {
    const updated = deps.servers.setEnabled(id, enabled);
    if (!updated) return undefined;

    await deps.registry.reconnect(id);

    return toMcpServerConfig(updated);
  },

  delete: async (id) => {
    // 先断连再删行:反过来的话连接会挂在一个已经不存在的配置上。
    await deps.registry.disconnect(id);
    deps.servers.deleteById(id);
  },

  reconnect: (id) => deps.registry.reconnect(id)
});
