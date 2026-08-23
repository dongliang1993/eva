import { describe, expect, it } from "vitest";

import { pickDirectory } from "../apps/server/src/services/workspaces/directory-picker.js";
import type { ExecFn } from "../apps/server/src/services/workspaces/directory-picker.js";

const ok = (stdout: string): ExecFn => async () => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ExecFn => async () => ({ code, stdout: "", stderr });

describe("pickDirectory (native folder dialog)", () => {
  it("macOS 选中 → 去掉尾斜杠的绝对路径", async () => {
    const res = await pickDirectory(ok("/Users/x/project/\n"), "darwin");
    expect(res).toEqual({ path: "/Users/x/project" });
  });

  it("macOS 用户取消 → path 为 null", async () => {
    const res = await pickDirectory(fail("execution error: 用户已取消。 (-128)"), "darwin");
    expect(res).toEqual({ path: null });
  });

  it("macOS 真出错(非取消)→ 抛错", async () => {
    await expect(pickDirectory(fail("osascript: some internal error"), "darwin")).rejects.toThrow(
      /osascript failed/
    );
  });

  it("Windows 选中 → 返回所选路径", async () => {
    const res = await pickDirectory(ok("C:\\Users\\x\\proj\r\n"), "win32");
    expect(res).toEqual({ path: "C:\\Users\\x\\proj" });
  });

  it("Windows 取消(零退出空输出)→ null", async () => {
    const res = await pickDirectory(ok(""), "win32");
    expect(res).toEqual({ path: null });
  });

  it("Linux 取消(非零退出)→ null", async () => {
    const res = await pickDirectory(fail(""), "linux");
    expect(res).toEqual({ path: null });
  });

  it("不支持的平台 → unsupported", async () => {
    const res = await pickDirectory(ok(""), "freebsd" as NodeJS.Platform);
    expect(res).toEqual({ path: null, unsupported: true });
  });
});
