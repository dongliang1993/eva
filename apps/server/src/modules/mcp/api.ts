import type { McpServerConfig, McpServerStatus, McpServersPayload } from "@eva/shared";

import type { McpConfigStore, McpServerFields } from "./mcp-config-store.js";
import type { McpRegistry } from "./mcp-registry.js";

// 入参形状是这一层的契约,route 与 api 共用 —— 从这里再导一次,
// 免得 route 为了一个类型去 import 文件存储。
export type { McpServerFields };

/** 写操作的两种结局。名字不存在时返回 undefined,状态码由 route 决定。 */
export type McpWriteResult =
  | { readonly ok: true; readonly server: McpServerConfig }
  | { readonly ok: false; readonly reason: "name-taken" };

export interface McpApi {
  /** server 配置 + 当前连接状态。只读 registry 现状，不触发连接。 */
  describeAll(): Promise<McpServersPayload>;
  /** route 拿它区分 404 与正常路径。 */
  find(id: string): McpServerConfig | undefined;
  create(fields: McpServerFields): Promise<McpWriteResult>;
  update(id: string, fields: McpServerFields): Promise<McpWriteResult>;
  setEnabled(id: string, enabled: boolean): Promise<McpServerConfig | undefined>;
  delete(id: string): Promise<void>;
  reconnect(id: string): Promise<McpServerStatus>;
}

export const createMcpApi = (deps: {
  readonly store: McpConfigStore;
  readonly registry: McpRegistry;
}): McpApi => ({
  describeAll: async () => ({
    servers: deps.store.listAll(),
    statuses: deps.registry.describe()
  }),

  find: (id) => deps.store.findById(id),

  create: async (fields) => {
    if (deps.store.findByName(fields.name)) {
      return { ok: false, reason: "name-taken" };
    }

    // 名字即身份,条目名就是 id
    const created = deps.store.create(fields);
    // 建完立刻连一次:用户加了 server 就是想马上用,不该等下一个 run 才发现连不上。
    await deps.registry.reconnect(created.id);

    return { ok: true, server: created };
  },

  update: async (id, fields) => {
    const conflict = deps.store.findByName(fields.name);

    if (conflict && conflict.id !== id) {
      return { ok: false, reason: "name-taken" };
    }

    const updated = deps.store.update(id, fields);
    if (!updated) {
      return { ok: false, reason: "name-taken" };
    }

    await deps.registry.reconnect(id);

    return { ok: true, server: updated };
  },

  setEnabled: async (id, enabled) => {
    const updated = deps.store.setEnabled(id, enabled);
    if (!updated) return undefined;

    await deps.registry.reconnect(id);

    return updated;
  },

  delete: async (id) => {
    // 先断连再删条目:反过来的话连接会挂在一个已经不存在的配置上。
    await deps.registry.disconnect(id);
    deps.store.deleteById(id);
  },

  reconnect: (id) => deps.registry.reconnect(id)
});
