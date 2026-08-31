import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";

import type { ProviderConnectionTestResult } from "../../../types/api";

// ---------------------------------------------------------------------------
// 连接测试 —— 一次「拿当前表单里的 key/baseURL 去打一下」。
//
// 结果只活在这一块里(不进缓存、不参与脏态):表单头部的按钮和 API Key 下面的
// 那行提示是同一次测试的两个出口,所以状态由 hook 持有,两个组件都吃它。
// ---------------------------------------------------------------------------

export interface ProviderConnectionTest {
  readonly testing: boolean;
  readonly result: ProviderConnectionTestResult | null;
  readonly run: () => void;
}

export function useProviderConnectionTest({
  canRun,
  onTest
}: {
  readonly canRun: boolean;
  /** 带上表单里的临时覆盖去测;失败抛错,这里收成 result。 */
  readonly onTest: () => Promise<ProviderConnectionTestResult>;
}): ProviderConnectionTest {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderConnectionTestResult | null>(null);

  const run = useCallback(async () => {
    if (!canRun) {
      return;
    }

    setTesting(true);
    setResult(null);

    try {
      setResult(await onTest());
    } catch (error) {
      setResult({
        success: false,
        error: error instanceof Error ? error.message : "Failed to test provider"
      });
    } finally {
      setTesting(false);
    }
  }, [canRun, onTest]);

  return { testing, result, run: () => void run() };
}

export function ProviderTestButton({
  test,
  disabled
}: {
  readonly test: ProviderConnectionTest;
  readonly disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="rounded-lg border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      onClick={test.run}
      disabled={test.testing || disabled}
    >
      <span className="inline-flex items-center gap-1.5">
        {test.testing ? <Loader2 size={14} className="animate-spin" /> : null}
        {test.testing ? "Testing..." : "Test"}
      </span>
    </button>
  );
}

/** 测试结果那一行 —— 位置在 API Key 输入框下方,所以跟按钮分开渲染。 */
export function ProviderTestResult({
  result
}: {
  readonly result: ProviderConnectionTestResult | null;
}) {
  if (!result) {
    return null;
  }

  return (
    <p className={`mt-1.5 text-xs ${result.success ? "text-success" : "text-destructive"}`}>
      {result.success
        ? `Connection OK${result.latencyMs !== undefined ? ` · ${result.latencyMs}ms` : ""}`
        : result.error ?? "Connection test failed"}
    </p>
  );
}
