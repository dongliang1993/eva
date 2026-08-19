import { describe, expect, it, vi } from "vitest";

import { ReportGateway } from "../apps/server/src/services/subagents/report-gateway.js";
import type { SubagentNotice } from "../packages/harness/src/subagents/types.js";

const notice = (over: Partial<SubagentNotice> = {}): SubagentNotice => ({
  kind: "reported",
  taskId: "t_abc",
  parentToolCallId: "call_00",
  subagentType: "explorer",
  description: "深挖 apps/server",
  output: "结论如下",
  ...over
});

describe("ReportGateway (S7 push 的回报队列)", () => {
  it("队列有货 → 立刻返回,不等 graceMs", async () => {
    const gw = new ReportGateway(() => true);
    gw.push(notice());

    const started = Date.now();
    const got = await gw.drain({ graceMs: 10_000 });

    expect(got).toHaveLength(1);
    expect(got[0]?.text).toContain("结论如下");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("取完即清 —— 同一条通知不会注入两次", async () => {
    const gw = new ReportGateway(() => false);
    gw.push(notice());

    expect(await gw.drain({ graceMs: 0 })).toHaveLength(1);
    expect(await gw.drain({ graceMs: 0 })).toHaveLength(0);
  });

  it("没有存活任务 → 立刻空手返回(正常对话每轮都走这条路,绝不能白等)", async () => {
    const gw = new ReportGateway(() => false);

    const started = Date.now();
    const got = await gw.drain({ graceMs: 10_000 });

    expect(got).toEqual([]);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("有存活任务但还没报 → 等着,被 push 唤醒后立刻拿到", async () => {
    const gw = new ReportGateway(() => true);

    const pending = gw.drain({ graceMs: 5_000 });
    setTimeout(() => gw.push(notice({ output: "迟到的结论" })), 20);

    const got = await pending;
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toContain("迟到的结论");
  });

  it("有存活任务但一直不报 → graceMs 超时返回空(不吊死 run)", async () => {
    vi.useFakeTimers();
    try {
      const gw = new ReportGateway(() => true);
      const pending = gw.drain({ graceMs: 20_000 });

      await vi.advanceTimersByTimeAsync(20_001);

      expect(await pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("一次 drain 拿走期间攒下的全部通知(多个子代理同时报)", async () => {
    const gw = new ReportGateway(() => true);
    gw.push(notice({ taskId: "t_1", description: "任务一" }));
    gw.push(notice({ taskId: "t_2", description: "任务二" }));

    const got = await gw.drain({ graceMs: 0 });

    expect(got).toHaveLength(2);
    expect(got.map((n) => n.taskId)).toEqual(["t_1", "t_2"]);
  });

  it("settled 通知也进队列,文本说明它不会再干活", async () => {
    const gw = new ReportGateway(() => true);
    gw.push(notice({ kind: "settled", output: undefined }));

    const got = await gw.drain({ graceMs: 0 });

    expect(got[0]?.kind).toBe("settled");
    expect(got[0]?.text).toContain("no further work");
  });

  it("dispose 唤醒等待者,不留悬挂 Promise", async () => {
    const gw = new ReportGateway(() => true);
    const pending = gw.drain({ graceMs: 60_000 });

    gw.dispose();

    expect(await pending).toEqual([]);
  });
});
