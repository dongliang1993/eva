import { describe, expect, it } from "vitest";

import type { StoredMessage } from "../apps/server/src/db/repositories/types.js";
import {
  buildActiveChain,
  resolveLeafFrom
} from "../apps/server/src/services/message-tree.js";

// 构造 StoredMessage 的辅助。message 字段用最小可用的 EvaUIMessage。
const msg = (id: string, parentId: string | null = null, slotId = "s"): StoredMessage => ({
  id,
  sessionId: "session-1",
  runId: null,
  role: id.startsWith("u") ? ("user" as const) : ("assistant" as const),
  message: {
    id,
    role: id.startsWith("u") ? ("user" as const) : ("assistant" as const),
    parts: [{ type: "text", text: id, state: "done" as const }]
  },
  parentId,
  slotId,
  depth: 0,
  parentToolCallId: null,
  createdAt: ""
});

describe("buildActiveChain", () => {
  it("线性链 → 全量正序", () => {
    const rows = [msg("m1"), msg("m2", "m1"), msg("m3", "m2")];
    const chain = buildActiveChain(rows, "m3");
    expect(chain.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("有分支时只返回叶子所在那条", () => {
    // m1 → m2 (slot s2) 和 m3 (slot s2, v2) —— m4 挂在 m3 下
    const rows = [msg("m1"), msg("m2", "m1", "slotX"), msg("m3", "m1", "slotX"), msg("m4", "m3")];
    const chain = buildActiveChain(rows, "m4");
    // m2 是同 slot 的旧版本,不在激活链上;m3 才是激活分支
    expect(chain.map((m) => m.id)).toEqual(["m1", "m3", "m4"]);

    const v1 = buildActiveChain(rows, "m2");
    expect(v1.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("activeLeafId 为 null → 退化成时间上最后一条", () => {
    const rows = [msg("m1"), msg("m2", "m1"), msg("m3", "m1")];
    const chain = buildActiveChain(rows, null);
    expect(chain.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("activeLeafId 指向不存在的 id → 返回空(不抛)", () => {
    const rows = [msg("m1"), msg("m2", "m1")];
    expect(buildActiveChain(rows, "missing")).toEqual([]);
  });

  it("自引用脏数据 → 不死循环", () => {
    const rows = [msg("m1", "m1")]; // 自我指认
    const chain = buildActiveChain(rows, "m1");
    expect(chain.map((m) => m.id)).toEqual(["m1"]);
  });

  it("空数组 → 空", () => {
    expect(buildActiveChain([], null)).toEqual([]);
  });
});

describe("resolveLeafFrom", () => {
  it("无子节点 → 返回自己", () => {
    const rows = [msg("m1")];
    expect(resolveLeafFrom(rows, "m1")).toBe("m1");
  });

  it("单链 → 返回末端", () => {
    const rows = [msg("m1"), msg("m2", "m1"), msg("m3", "m2")];
    expect(resolveLeafFrom(rows, "m1")).toBe("m3");
  });

  it("某层有两个子节点 → 取最新那个", () => {
    const rows = [msg("m1"), msg("m2", "m1", "slotX"), msg("m3", "m1", "slotX")];
    expect(resolveLeafFrom(rows, "m1")).toBe("m3");
  });

  it("成环 → 不死循环", () => {
    const rows = [msg("m1", "m1")];
    expect(resolveLeafFrom(rows, "m1")).toBe("m1");
  });

  it("消息不存在 → 返回该 id(不抛)", () => {
    expect(resolveLeafFrom([msg("m1")], "missing")).toBe("missing");
  });
});
describe("buildActiveChain 子代理隔离 (S7)", () => {
  // 挂 parent_tool_call_id 的子代理进程消息,带第三个参数塞 mark。
  const subMsg = (id: string, parentId: string | null, mark: unknown): StoredMessage => ({
    id,
    sessionId: "session-1",
    runId: null,
    role: id.startsWith("u") ? ("user" as const) : ("assistant" as const),
    message: {
      id,
      role: id.startsWith("u") ? ("user" as const) : ("assistant" as const),
      parts: [{ type: "text", text: id, state: "done" as const }]
    },
    parentId,
    slotId: "s",
    depth: 1,
    parentToolCallId: `task-${id}` as string,
    createdAt: ""
  });

  it("子代理消息存在时,主链长度与内容都不变", () => {
    const main = [msg("m1"), msg("m2", "m1"), msg("m3", "m2")];
    // 子代理进程消息插在中间,甚至引用主链消息做 parent —— 都不该进主链。
    const withSub = [
      main[0]!,
      subMsg("u-sub-1", "m1", "user sub msg"),
      subMsg("a-sub-1", "u-sub-1", "assistant sub output"),
      main[1]!,
      main[2]!
    ];
    const chain = buildActiveChain(withSub, "m3");
    expect(chain.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("主链过滤后为空(全会话只有子代理消息) → 返回空,不抛", () => {
    const subOnly = [subMsg("a-sub-only", null, "x")];
    expect(buildActiveChain(subOnly, null)).toEqual([]);
  });

  it("退化路径(无 activeLeaf)同样忽略子代理消息", () => {
    const rows = [msg("m1"), subMsg("a-sub", null, "x"), msg("m2", "m1")];
    const chain = buildActiveChain(rows, null);
    expect(chain.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});
