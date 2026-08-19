import { describe, expect, it } from "vitest";

import { createSaveMemoryTool } from "../packages/harness/src/tools/memory/save-memory-tool.js";
import { createUpdateLongTermMemoryTool } from "../packages/harness/src/tools/memory/update-long-term-memory-tool.js";
import type { MemoryFileStore } from "../packages/harness/src/tools/memory/memory-files.js";
import type { MemoryStore } from "../packages/harness/src/tools/memory/types.js";

/** 三个"存储位置"工具的描述必须达成分工约定 —— 否则模型会把稳定偏好同时存两处(T16 §2.4 / 坑④)。 */
describe("memory tool routing (T16 §2.4)", () => {
  const store: MemoryStore = {
    save: async () => {
      throw new Error("unused");
    },
    search: async () => [],
    listAll: async () => [],
    update: async () => undefined,
    deleteById: async () => true
  } as unknown as MemoryStore;

  const fileStore: MemoryFileStore = {
    readFile: async () => undefined,
    list: async () => [],
    appendDailyNote: async () => "",
    writeLongTermMemory: async () => ""
  };

  const saveDesc = createSaveMemoryTool(store).tool.description ?? "";
  const updateDesc = createUpdateLongTermMemoryTool(fileStore).tool.description ?? "";

  it("save_memory 描述区分位置:稳定偏好归 MEMORY.md, 不是它的领地", () => {
    expect(saveDesc).toMatch(/MEMORY\.md|update_long_term_memory|long.?term/i);
  });

  it("update_long_term_memory 描述大写强调 REPLACES 整文件", () => {
    expect(updateDesc).toMatch(/REPLACES/);
  });
});
