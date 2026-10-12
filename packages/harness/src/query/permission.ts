import type {
  CanUseTool,
  PermissionResult,
  ToolAnnotations,
} from "./types.js";

/**
 * 权限评估(FR-004):纯逻辑 + 一次 canUseTool 调用。
 * 不计时、不写日志、不知道 run —— 那些在 tool-call.ts。
 *
 * 评估顺序固定,这个顺序属于运行语义:
 *   PreToolUse hooks → readOnlyHint 直放 → canUseTool → 未提供 canUseTool 时 deny。
 * hook deny 排在 readOnlyHint 之前:hook 是进程所有者最后的否决权,
 * 只读直放不是许可,只是省一次询问。
 */

export interface EvaluatePermissionInput {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly annotations: ToolAnnotations | undefined;
  /** undefined = 未提供 canUseTool(走 deny)。 */
  readonly canUseTool: CanUseTool | undefined;
  /** hook 的 PreToolUse deny 结果;无 deny 传 undefined。 */
  readonly hookDeny: { readonly message: string } | undefined;
  readonly options: {
    readonly signal: AbortSignal;
    readonly toolUseID: string;
    readonly agentID?: string;
  };
}

export const evaluatePermission = async (
  input: EvaluatePermissionInput,
): Promise<PermissionResult> => {
  if (input.hookDeny !== undefined) {
    return {
      behavior: "deny",
      message: input.hookDeny.message,
    };
  }

  if (input.annotations?.readOnlyHint === true) {
    return { behavior: "allow" };
  }

  if (input.canUseTool === undefined) {
    // 未提供 canUseTool:非只读工具一律 deny。harness 的最小使用者不该被
    // 隐式放行 —— 缺省拒绝与「危险工具默认拒绝」是同一条纪律。
    return {
      behavior: "deny",
      message: "Tool use was denied: no permission handler is configured.",
    };
  }

  return input.canUseTool(
    input.toolName,
    input.toolInput,
    input.options,
  );
};
