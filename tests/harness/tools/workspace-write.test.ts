import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditTool } from "../../../packages/harness/src/tools/fs/edit-tool.js";
import { runToolText } from "../../helpers/run-tool.js";

it("separate tool instances serialize edits to the same workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eva-edit-"));
  try {
    await fs.writeFile(path.join(root, "file.txt"), "A B");
    const a = createEditTool({ workRoot: root }), b = createEditTool({ workRoot: root });
    const results = await Promise.all([
      runToolText(a, { path: "file.txt", before: "A", after: "X" }, { toolUseID: "a" }),
      runToolText(b, { path: "file.txt", before: "B", after: "Y" }, { toolUseID: "b" }),
    ]);
    expect(results.every(r => r.startsWith("Edited"))).toBe(true);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("X Y");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
