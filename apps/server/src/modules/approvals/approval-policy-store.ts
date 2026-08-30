import { buildPolicyKeys } from "@eva/harness";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { loadAppSettings, replaceAppSettings } from "../settings/index.js";

/**
 * T28:settings.security.allowAlwaysPolicies 的进程内缓存 + 写回器
 * (docs/plans/r7/T28 §2.2)。
 *
 * - 单一事实来源是 settings 表;启动时读一次进内存 Set,此后 match 零 IO。
 * - 「存在即 allow_always」(与 Alma `main:27876` 的 Set 同构):match 命中返回
 *   key 本身(给台账 reason 用),不返回值映射。
 * - key 生成走 T27 的 buildPolicyKeys 纯函数 —— 纯函数是 key 语义的唯一事实来源,
 *   这里不做任何拼装(r7 §3 契约 1)。
 */
export class ApprovalPolicyStore {
  private readonly keys: Set<string>;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig
  ) {
    this.keys = new Set(loadAppSettings(db, config).security.allowAlwaysPolicies);
  }

  /** 命中返回那条 key(精确 key 在前的顺序由 buildPolicyKeys 保证),未命中返回 null。 */
  match(tool: string, sessionId: string, args: unknown): string | null {
    const candidates = buildPolicyKeys({
      toolName: tool,
      threadId: sessionId,
      args: (args ?? {}) as Record<string, unknown>
    });

    for (const key of candidates) {
      if (this.keys.has(key)) return key;
    }

    return null;
  }

  /**
   * 「始终允许」写回:把 key 追加进 settings.security.allowAlwaysPolicies 并刷新内存。
   *
   * 注意 replaceAppSettings 是「先 delete 全表再整块重写」—— 必须先读全量、
   * spread 改这一块、再整块写回;只 update security 会把 models/chat/memory 删空。
   */
  grant(key: string): void {
    if (this.keys.has(key)) return;

    const current = loadAppSettings(this.db, this.config);
    replaceAppSettings(this.db, this.config, {
      ...current,
      security: {
        ...current.security,
        allowAlwaysPolicies: [...current.security.allowAlwaysPolicies, key]
      }
    });
    this.keys.add(key);
  }
}
